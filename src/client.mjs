/** Client shared by MCP and the desktop launcher. Runtime tokens are never returned to tools. */
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.mjs';
import { BridgeError, requireValue } from './util.mjs';

async function connection(config) {
  try {
    const state=JSON.parse(await readFile(join(config.dataDir,'server.json'),'utf8'));
    requireValue(Number.isInteger(state.port)&&state.port>0&&state.port<=65535&&/^[a-f0-9]{64}$/.test(state.token),'INVALID_SERVER_STATE','服务连接信息无效。');
    const response=await fetch('http://127.0.0.1:'+state.port+'/api/health',{method:'POST',headers:{Authorization:'Bearer '+state.token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(2000)});
    if(response.ok) return state;
  } catch(error) { /* Missing/stale state is reconciled by the exclusive daemon lock. */ }
}
let starting;
export async function ensureDaemon(config) {
  const live=await connection(config); if(live) return live;
  if(starting) return starting;
  starting=(async()=>{
    await mkdir(config.dataDir,{recursive:true});
    const child=spawn(config.nodePath,[join(config.root,'src','daemon.mjs')],{cwd:config.root,windowsHide:true,detached:true,stdio:'ignore'});
    let failed;
    child.once('error',error=>{failed=error;}); child.unref();
    const deadline=Date.now()+15000;
    while(Date.now()<deadline) {
      if(failed) throw new BridgeError('DAEMON_START_FAILED','无法启动任务服务，请检查 Node 路径。',503);
      const ready=await connection(config); if(ready) return ready;
      await sleep(150);
    }
    throw new BridgeError('DAEMON_START_FAILED','任务服务未能启动；请查看检查环境与 .bridge/startup-error.json。',503);
  })().finally(()=>{starting=undefined;});
  return starting;
}
export async function bridgeCall(method,params={}) {
  const config=await loadConfig();
  const state=method==='shutdown'?await connection(config):await ensureDaemon(config);
  if(!state && method==='shutdown') return {ok:true,status:'already_stopped'};
  let response;
  try {
    response=await fetch('http://127.0.0.1:'+state.port+'/api/'+method,{
      method:'POST',headers:{Authorization:'Bearer '+state.token,'Content-Type':'application/json'},
      body:JSON.stringify(params),signal:AbortSignal.timeout(40000),
    });
  } catch(error) { throw new BridgeError('CONNECTION_LOST','本地服务连接中断。提交结果不明时先查询任务，不要更换 requestId 重复提交。',503); }
  const result=await response.json();
  if(!response.ok) throw new BridgeError(result.error?.code??'SERVICE_ERROR',result.error?.message??'任务服务返回错误。',response.status);
  return result;
}
