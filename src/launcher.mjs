/** Desktop-friendly entrypoints; launch URLs stay out of stdout and logs. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig, checkEnvironment } from './config.mjs';
import { ensureDaemon, bridgeCall } from './client.mjs';
import { safeError } from './util.mjs';

const action=process.argv[2]??'open';
const config=await loadConfig();
try {
  if(action==='check') {
    const result=await checkEnvironment(config);
    console.log(JSON.stringify(result,null,2)); process.exitCode=result.ok?0:1;
  } else if(action==='stop') {
    console.log(JSON.stringify(await bridgeCall('shutdown'),null,2));
  } else if(action==='open') {
    const state=await ensureDaemon(config);
    const url='http://127.0.0.1:'+state.port+'/#token='+state.token;
    if(process.platform==='win32') {
      const ps=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const child=spawn(ps,['-NoProfile','-NonInteractive','-Command',"Start-Process -FilePath '"+url+"'"],{windowsHide:true,stdio:'ignore'});
      await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('无法打开默认浏览器。')));});
    } else {
      const child=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'}); child.unref();
    }
  } else throw new Error('不支持的启动操作。');
} catch(error) { console.error(JSON.stringify(safeError(error))); process.exitCode=1; }
