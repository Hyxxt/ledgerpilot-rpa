import {spawn} from 'node:child_process';
const base='http://127.0.0.1:'+(process.env.LEDGER_PORT||47138);
let ready=false;
try{
  const response=await fetch(base+'/api/state',{signal:AbortSignal.timeout(1500)});
  const s=await response.json();ready=!!s.source && Array.isArray(s.runs);
}catch{}
if(ready)spawn('rundll32.exe',['url.dll,FileProtocolHandler',base],{detached:true,stdio:'ignore'}).unref();
else {process.argv.push('--open');await import('./server.mjs');}
