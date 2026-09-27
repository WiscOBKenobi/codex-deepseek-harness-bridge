import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/daemon.mjs';
import { projectRoot } from '../src/config.mjs';

test('loopback API authenticates and rejects wrong origins, hosts and JSON before invoking tasks',async t=>{
 let submitted=0;
 const manager={submit:async body=>{submitted++;return {id:'fixture',instruction:body.instruction};},shutdown:async()=>{}};
 const token='a'.repeat(64);
 const api=await createApiServer({config:{root:projectRoot},manager,token});t.after(()=>api.close());
 const base='http://127.0.0.1:'+api.port;
 const send=(body,headers={})=>fetch(base+'/api/submit',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...headers},body});
 assert.equal((await send('{}',{Authorization:'Bearer invalid'})).status,401);
 assert.equal((await send('{}',{Origin:'https://attacker.example'})).status,403);
 const hostileHost=await new Promise((resolve,reject)=>{const req=http.request(base+'/api/submit',{method:'POST',headers:{Host:'evil.example','Content-Type':'application/json',Authorization:'Bearer '+token}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});
 assert.equal(hostileHost,403);
 assert.equal((await send('{')).status,400);
 assert.equal(submitted,0);
 const response=await send(JSON.stringify({instruction:'中文任务：创建文件'}));
 assert.equal(response.status,200); assert.equal((await response.json()).instruction,'中文任务：创建文件');
 assert.equal(submitted,1);
});
test('static page has strict browser policy and no runtime token',async t=>{
 const token='b'.repeat(64);
 const api=await createApiServer({config:{root:projectRoot},manager:{},token});t.after(()=>api.close());
 const response=await fetch('http://127.0.0.1:'+api.port+'/');
 assert.equal(response.status,200);
 assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert(!(await response.text()).includes(token));
});
