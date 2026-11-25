import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {browserPath} from './lib/robot.mjs';
import {parseCsv,importTable} from './lib/ledger.mjs';

const data=await fs.mkdtemp(path.join(os.tmpdir(),'ledgerpilot-qa-'));
const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));
const port=probe.address().port;await new Promise(ok=>probe.close(ok));
const base='http://127.0.0.1:'+port;
let server, browser;
async function wait(fn,message) {
  for(let i=0;i<200;i++){const v=await fn();if(v)return v;await delay(120);}
  throw Error(message);
}
async function boot(){
  server=spawn(process.execPath,['server.mjs'],{env:{...process.env,LEDGER_DATA:data,LEDGER_PORT:String(port)},stdio:'inherit',windowsHide:true});
  await wait(()=>fetch(base+'/api/state').then(r=>r.ok,()=>false),'服务启动失败');
}
async function stop(){if(server&&server.exitCode===null){const exited=new Promise(ok=>server.once('exit',ok));server.kill();await exited;}}
async function api(url,payload){
  const r=await fetch(base+url,payload===undefined?{}:{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;
}
try{
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"c,c","d""e"\r\n'),[['a','b'],['c,c','d"e']]);
  assert.throws(()=>importTable('orders','订单号,客户,应收金额\n1,A,1.234'));
  await boot();
  browser=await chromium.launch({executablePath:browserPath(),headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.getByRole('button',{name:'开始对账'}).click();
  await page.getByRole('button',{name:'暂停任务'}).click();
  const initial=await api('/api/state'),id=initial.runs[0].id;
  await wait(async()=> (await api('/api/runs/'+id)).status==='paused','任务未暂停');
  await stop();await boot();await page.reload();
  await page.getByRole('button',{name:'从检查点继续'}).click();
  await page.waitForSelector('#state-tag:text("已完成")',{timeout:45000});
  const r=await api('/api/runs/'+id);
  assert.equal(r.matched,20);assert.equal(r.exceptions,5);assert.equal(r.processed,48);
  assert.equal(r.results.find(x=>x.id==='LP-26005').receipts.length,2);
  await page.getByRole('button',{name:'暂停回放',exact:true}).click();
  await page.locator('#scrubber').fill('0');
  await page.locator('#frame-content td:text("LP-26001")').waitFor();
  await page.getByRole('button',{name:'切换回放速度'}).click();
  await page.getByRole('button',{name:'播放回放',exact:true}).click();
  await page.waitForFunction(()=>Number(document.getElementById('scrubber').value)>0);
  await page.locator('#scrubber').fill('6');
  await page.locator('#frame-content tr.focused').waitFor();
  assert.match(await page.locator('#evidence').getAttribute('href'),/orders-1\.png$/);
  await page.locator('#events li.current button').click();
  await page.locator('#detail[open]').waitFor();
  await page.getByRole('button',{name:'关闭详情'}).click();
  for(const kind of ['orders','payments'])for(let i=1;i<=r.pages[kind];i++)assert.ok((await fs.stat(path.join(data,id,kind+'-'+i+'.png'))).size>2000);
  await page.getByRole('button',{name:'待复核',exact:true}).click();
  await page.getByRole('button',{name:'详情 ↗'}).first().click();
  const screenshot=page.locator('dialog a').first();assert.equal((await fetch(base+await screenshot.getAttribute('href'))).status,200);
  await page.locator('#note').fill('核查银行流水，已转交财务跟进');await page.getByRole('button',{name:'保存复核记录'}).click();
  await page.waitForSelector('dialog',{state:'hidden'});
  const download=page.waitForEvent('download');await page.locator('#export').click();
  const exported=parseCsv(await fs.readFile(await (await download).path(),'utf8'));
  assert.equal(exported.length,26);assert.ok(exported.some(row=>row.includes('核查银行流水，已转交财务跟进')));
  await page.getByRole('button',{name:'全部',exact:true}).click();
  await page.screenshot({path:path.join(data,'dashboard.png'),fullPage:true});
  await page.getByRole('button',{name:'运行历史',exact:true}).click();await page.getByRole('button',{name:'查看',exact:true}).click();
  await page.getByRole('button',{name:'数据来源',exact:true}).click();
  await page.locator('input[name=name]').fill('验收批次');
  const files={orders:'订单号,客户,应收金额\nA01,客户甲,0.30\nA02,客户乙,1.20',payments:'流水号,订单号,实收金额\nP1,A01,0.10\nP2,A01,0.20\nP3,B99,0.80'};
  for(const k of Object.keys(files))await page.locator('input[name='+k+']').setInputFiles({name:k+'.csv',mimeType:'text/csv',buffer:Buffer.from(files[k])});
  await page.getByRole('button',{name:'校验并导入'}).click();
  await page.waitForSelector('#source-name:text("验收批次")');
  await page.getByRole('button',{name:'对账工作台',exact:true}).click();await page.getByRole('button',{name:'开始对账',exact:true}).click();
  await wait(async()=>{const s=await api('/api/state');return s.runs[0].id!==id&&s.runs[0].status==='done';},'导入批次未完成');
  const s=await api('/api/state');assert.equal(s.runs[0].exceptions,2);assert.equal(s.runs[0].matched,1);
  assert.equal((await api('/api/runs/'+id)).reviewed,1);
  const rejected=await fetch(base+'/api/source',{method:'POST',headers:{origin:base,'Content-Type':'application/json'},body:JSON.stringify({...files,orders:files.orders+'\nA01,重复,1.00'})});
  assert.equal(rejected.status,400);assert.equal((await api('/api/state')).source.name,'验收批次');
  const larger=Array.from({length:152},(_,i)=>'O'+i+',客户,1.10').join('\n');
  await api('/api/source',{name:'断点验收',orders:'订单号,客户,应收金额\n'+larger,payments:'流水号,订单号,实收金额'});
  const interrupted=await api('/api/runs',{});
  await wait(async()=>{const v=await api('/api/runs/'+interrupted.id);return v.cursor.orders>=1&&v.status==='running';},'未观察到持久化检查点');
  await stop();await boot();
  const checkpoint=await api('/api/runs/'+interrupted.id);
  assert.equal(checkpoint.status,'paused');assert.ok(checkpoint.cursor.orders>0);
  await api('/api/runs/'+interrupted.id+'/resume',{});
  const recovered=await wait(async()=>{const v=await api('/api/runs/'+interrupted.id);return v.status==='done'&&v;},'中断后未完成');
  assert.equal(recovered.results.length,152);assert.equal(recovered.processed,152);
  assert.equal(recovered.exceptions,152);assert.equal(new Set(recovered.results.map(x=>x.id)).size,152);
  await page.setViewportSize({width:390,height:844});await page.reload();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'移动端横向溢出');
  assert.deepEqual(errors,[]);console.log('PASS · 采集、重启续跑、两表导入、复核、证据、CSV 和移动布局。验收目录 '+data);
}finally{await browser?.close();await stop();}
