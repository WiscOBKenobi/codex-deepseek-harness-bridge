/** Authenticated loopback API; one service owns all task processes in this project. */
import http from 'node:http';
import { createServer as createPipe } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TaskManager } from './task-manager.mjs';
import { loadConfig, checkEnvironment } from './config.mjs';
import { atomicJson, safeError, exactKeys, requireValue, BridgeError } from './util.mjs';

export function lockAddress(config) {
  const id = createHash('sha256').update(config.root.toLowerCase() + userInfo().username).digest('hex').slice(0, 28);
  return process.platform === 'win32' ? '\\\\.\\pipe\\codex-ds-' + id : join(config.dataDir, 'daemon.sock');
}
export async function dispatch(manager, config, method, params) {
  switch (method) {
    case 'health': exactKeys(params, []); return { ...await checkEnvironment(config), version: '0.2.0', stallWarningSeconds: config.stallWarningSeconds ?? 300, heartbeatSeconds: 15, limits: {maxRuntimeSeconds:config.maxRuntimeSeconds,maxToolCalls:config.maxToolCalls} };
    case 'list': exactKeys(params, []); return manager.list();
    case 'submit': return manager.submit(params);
    case 'get': { exactKeys(params,['taskId','afterEvent','waitSeconds']); const {taskId,...rest}=params; return manager.get(taskId,rest); }
    case 'result': { exactKeys(params,['taskId','path','offset','maxBytes']); const {taskId,...rest}=params; return manager.result(taskId,rest); }
    case 'continue': { exactKeys(params,['taskId','instruction','requestId']); const {taskId,...rest}=params; return manager.continue(taskId,rest); }
    case 'cancel': exactKeys(params,['taskId']); return manager.cancel(params.taskId);
    case 'review': { exactKeys(params,['taskId','status','note']); const {taskId,...rest}=params; return manager.review(taskId,rest); }
    default: throw new BridgeError('METHOD_NOT_FOUND','不支持的服务操作。',404);
  }
}
export async function createApiServer({ config, manager, token = randomBytes(32).toString('hex'), onShutdown = async () => {} }) {
  const staticFiles = new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
  const server = http.createServer(async (req,res) => {
    const send = (status,value) => { if (!res.destroyed) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); } };
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const origin = 'http://127.0.0.1:' + server.address().port;
      requireValue(req.headers.host === '127.0.0.1:' + server.address().port,'INVALID_HOST','请求主机无效。',403);
      requireValue(!req.headers.origin || req.headers.origin === origin,'INVALID_ORIGIN','请求来源无效。',403);
      const url = new URL(req.url,origin);
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file,type] = staticFiles.get(url.pathname);
        const body = await readFile(join(config.root,'public',file));
        res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'}); res.end(body); return;
      }
      requireValue(req.method === 'POST' && url.pathname.startsWith('/api/'),'NOT_FOUND','找不到这个接口。',404);
      const supplied = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /,''));
      requireValue(supplied.length === Buffer.byteLength(token) && timingSafeEqual(supplied,Buffer.from(token)),'UNAUTHORIZED','请通过“打开任务面板”重新打开已授权页面。',401);
      requireValue((req.headers['content-type'] ?? '').split(';')[0] === 'application/json','INVALID_CONTENT_TYPE','需要 JSON 请求。',415);
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        requireValue(bytes <= 256000,'REQUEST_TOO_LARGE','请求内容过大。',413);
        chunks.push(chunk);
      }
      let params;
      try { params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (error) { throw new BridgeError('INVALID_JSON','JSON 请求无法解析。'); }
      const method = url.pathname.slice('/api/'.length);
      if (method === 'shutdown') {
        exactKeys(params,[]); await manager.shutdown(); send(200,{ok:true,status:'stopped'});
        setTimeout(() => { void onShutdown(); },50); return;
      }
      send(200,await dispatch(manager,config,method,params));
    } catch (error) { send(error.status ?? 500,{error:safeError(error)}); }
  });
  server.requestTimeout = 40000;
  server.headersTimeout = 10000;
  await new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  return {server,token,port:server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
export async function startDaemon(config) {
  await mkdir(config.dataDir,{recursive:true});
  const lock = createPipe(socket=>socket.end('active'));
  const bound = await new Promise((resolve,reject)=>{
    lock.once('error',error=>error.code==='EADDRINUSE'?resolve(false):reject(error));
    lock.listen(lockAddress(config),()=>resolve(true));
  });
  if(!bound) return;
  let manager;
  try { manager = await new TaskManager(config).init(); }
  catch(error) { await new Promise(resolve=>lock.close(resolve)); throw error; }
  let stopped = false, api;
  const instanceId = randomUUID();
  const shutdown = async () => {
    if(stopped) return; stopped=true;
    await manager.shutdown();
    if(api) await api.close();
    try { await unlink(join(config.dataDir,'server.json')).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
    finally { await new Promise(resolve=>lock.close(resolve)); }
  };
  try {
    api = await createApiServer({config,manager,onShutdown:shutdown});
    await atomicJson(join(config.dataDir,'server.json'),{instanceId,port:api.port,token:api.token,startedAt:new Date().toISOString()});
  } catch(error) { await shutdown(); throw error; }
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{void shutdown();});
  return {manager,api,shutdown};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const config=await loadConfig();
  try { await startDaemon(config); }
  catch(error) { await atomicJson(join(config.dataDir,'startup-error.json'),safeError(error)); process.exitCode=1; }
}
