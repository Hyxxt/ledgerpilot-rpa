import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {demoSource, schemas, csv, amount, importTable, reasons} from './lib/ledger.mjs';
import {execute} from './lib/robot.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = process.env.LEDGER_DATA || path.join(root, 'local-data');
// 云端由平台注入 PORT（Render / Railway / Fly 都是这个约定），本地退回固定端口
const port = Number(process.env.PORT || process.env.LEDGER_PORT || 47138);
// 本地只绑回环更安全；容器里必须绑 0.0.0.0 才能被平台反向代理连上
const bindHost = process.env.LEDGER_HOST || '127.0.0.1';
// base 是给机器人采集用的内部地址：走回环，不绕公网、不吃 TLS
const base = 'http://127.0.0.1:' + port;
// 对外地址，用于跨站请求校验。Render 会自动注入 RENDER_EXTERNAL_URL
const publicBase = (process.env.PUBLIC_BASE || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const allowedHosts = new Set(['127.0.0.1:' + port, 'localhost:' + port]);
const allowedOrigins = new Set([base]);
if (publicBase) {
  try {
    allowedHosts.add(new URL(publicBase).host);
    allowedOrigins.add(new URL(publicBase).origin);
  } catch (e) { console.error('PUBLIC_BASE 格式不正确，已忽略：' + publicBase); }
}
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
function save(file, value) {
  fs.writeFileSync(file + '.tmp',JSON.stringify(value));
  fs.renameSync(file + '.tmp',file);
}
const directory = id => path.join(data,id);
const metadata = id => path.join(directory(id),'run.json');
const inputPath = id => path.join(directory(id),'input.json');
const sourceFile = path.join(data,'source.json');
const getInput = () => fs.existsSync(sourceFile) ? read(sourceFile) : demoSource();
const summary = s => ({name:s.name, orders:s.orders.length, payments:s.payments.length});
const runs = new Map();
let active = null;
function log(r,text) { r.logs.push({at:new Date().toISOString(), text}); }
function info(r) {
  return {id:r.id, source:r.source, started:r.started, status:r.status, cursor:r.cursor,
    pageSize:r.pageSize, pages:r.pages, processed:r.captured.orders.length+r.captured.payments.length,
    matched:r.results.filter(x => x.reason === 'match').length,
    exceptions:r.results.filter(x => x.reason !== 'match').length,
    reviewed:r.results.filter(x => x.review).length};
}
function start(r,input) {
  if (active) throw Error('已有一个任务正在运行');
  active = r.id; r.status = 'running'; log(r,'启动独立浏览器，从已保存的页码继续');
  const persist = () => save(metadata(r.id), r);
  persist();
  execute({run:r, input,base,dir:directory(r.id),persist,log:t=>log(r,t)})
    .catch(e => { r.status='failed'; log(r,String(e)); console.error(e); })
    .finally(() => { active=null; });
}
const escape = s => String(s).replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function portal(input,kind,p,size) {
  const count = Math.max(1,Math.ceil(input[kind].length/size));
  const title = kind==='orders'?'订单管理':'收款流水';
  const rows = input[kind].slice((p-1)*size,p*size);
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><link rel="stylesheet" href="/style.css"><main class="portal"><span class="eyebrow">源业务页面</span><h1>'+title+'</h1><p>'+escape(input.name)+' · 共 '+input[kind].length+' 条</p><table data-page="'+p+'"><thead><tr>'+schemas[kind].map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+rows.map(x=>'<tr data-record><td>'+escape(x.id)+'</td><td>'+escape(x.customer??x.order)+'</td><td>'+amount(x.cents)+'</td></tr>').join('')+'</tbody></table><footer><span>第 '+p+' / '+count+' 页</span><form><button name="page" value="'+(p-1)+'" '+(p<=1?'disabled':'')+'>上一页</button><button name="page" value="'+(p+1)+'" '+(p>=count?'disabled':'')+'>下一页</button></form></footer></main></html>';
}
async function body(req) {
  let bytes=0; const parts=[];
  for await (const p of req) { bytes+=p.length; if(bytes>3_000_000) throw Error('文件合计超过 3 MB'); parts.push(p); }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}
function report(r) {
  return csv([['订单号','客户','应收金额','实收金额','差额','核对结果','流水号','订单来源页/行','流水来源页/行','复核状态','复核说明','复核时间'],
    ...r.results.map(x=>[x.id,x.customer,x.due===null?'':amount(x.due),amount(x.paid),amount(x.delta),reasons[x.reason],
      x.receipts.map(p=>p.id).join(' / '),x.orderRef ? x.orderRef.page+'/'+x.orderRef.row : '',
      x.receipts.map(p=>p.ref.page+'/'+p.ref.row).join(' / '),x.reason==='match'?'无需复核':x.review?'已复核':'待复核',x.review?.note,x.review?.at])]);
}

const server = http.createServer(async(req,res)=>{
  const send=(code,content,type='application/json; charset=utf-8')=>{
    res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(type.startsWith('application/json') ? JSON.stringify(content) : content);
  };
  const download=(filename,content)=>{res.setHeader('Content-Disposition','attachment; filename="'+filename+'"');send(200,content,'text/csv; charset=utf-8');};
  try {
    if (!allowedHosts.has(req.headers.host)) return send(403,{error:'请通过本站地址访问'});
    // 带 Origin 的写请求必须同源；没带 Origin 的（如直接 curl）放行，靠 Host 校验兜底
    if (req.method === 'POST' && req.headers.origin && !allowedOrigins.has(req.headers.origin)) return send(403,{error:'请求来源不匹配'});
    const u = new URL(req.url,base), url = u.pathname, method = req.method;
    const views={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
    if (method === 'GET' && Object.hasOwn(views,url)) {
      const [file,type]=views[url]; return send(200,fs.readFileSync(path.join(root,'web',file)),type+'; charset=utf-8');
    }
    if (method === 'GET' && url === '/api/state') return send(200,{source:summary(getInput()),active,runs:[...runs.values()].reverse().map(info)});
    if (method === 'GET' && url.startsWith('/template/')) {
      const kind=url.slice(10); if (!Object.hasOwn(schemas,kind)) return send(404,{});
      const sample=demoSource()[kind];
      return download(kind+'.csv',csv([schemas[kind],...sample.map(r=>[r.id,r.customer??r.order,amount(r.cents)])]));
    }
    if (method === 'POST' && url === '/api/source') {
      const b=await body(req);
      const s=b.demo?demoSource():{name:String(b.name||'自定义账期').trim().slice(0,60),
        orders:importTable('orders',b.orders),payments:importTable('payments',b.payments)};
      if (!s.orders.length && !s.payments.length) throw Error('两张表至少有一条数据');
      save(sourceFile,s); return send(200,summary(s));
    }
    if (method === 'POST' && url === '/api/runs') {
      if (active) return send(409,{error:'已有任务运行中'});
      const input=getInput(), id=randomUUID(), pageSize=input.orders.length+input.payments.length>100 ? 25 : 8;
      const r={id,started:new Date().toISOString(),source:summary(input),pageSize,
        pages:Object.fromEntries(['orders','payments'].map(k=>[k,Math.max(1,Math.ceil(input[k].length/pageSize))])),
        cursor:{orders:0,payments:0},captured:{orders:[],payments:[]},results:[],logs:[]};
      fs.mkdirSync(directory(id)); save(inputPath(id),input); runs.set(id,r); start(r,input); return send(201,info(r));
    }
    const src=url.match(/^\/source\/([a-f0-9-]+|current)\/(orders|payments)$/);
    if (method==='GET' && src) {
      const [,id,kind]=src;
      if(id!=='current' && !runs.has(id)) return send(404,{});
      const input=id==='current'?getInput():read(inputPath(id)), size=runs.get(id)?.pageSize||8;
      const p=Number(u.searchParams.get('page')||1);
      if(!Number.isInteger(p)||p<1||p>Math.max(1,Math.ceil(input[kind].length/size))) return send(404,{});
      return send(200,portal(input,kind,p,size),'text/html; charset=utf-8');
    }
    const route=url.match(/^\/api\/runs\/([a-f0-9-]+)(?:\/(pause|resume|review|export|evidence))?(?:\/((?:orders|payments)-[1-9]\d*\.png))?$/);
    if (route && runs.has(route[1])) {
      const r=runs.get(route[1]), action=route[2];
      if(method==='GET' && !action) return send(200,{...info(r),results:r.results,logs:r.logs});
      if(method==='GET' && action==='export' && r.status==='done') return download('ledger-'+r.id.slice(0,8)+'.csv',report(r));
      if(method==='GET' && action==='evidence' && route[3]) {
        const f=path.join(directory(r.id),route[3]); return fs.existsSync(f)?send(200,fs.readFileSync(f),'image/png'):send(404,{});
      }
      if(method==='POST' && action==='pause' && r.status==='running') {
        r.status='pausing';log(r,'收到暂停请求');save(metadata(r.id),r);return send(200,info(r));
      }
      if(method==='POST' && action==='resume' && ['paused','failed'].includes(r.status)) {start(r,read(inputPath(r.id)));return send(200,info(r));}
      if(method==='POST' && action==='review' && r.status==='done') {
        const {id,note}=await body(req), row=r.results.find(x=>x.id===id);
        if (!row || row.reason==='match' || row.review) throw Error('此记录无需重复复核');
        if(typeof note!=='string'||!note.trim()||note.length>400) throw Error('请输入 1 至 400 字复核说明');
        row.review={note:note.trim(),at:new Date().toISOString()};
        log(r,'人工复核 '+id+'：'+row.review.note);save(metadata(r.id),r);return send(200,info(r));
      }
      return send(409,{error:'当前状态不支持此操作，请刷新'});
    }
    send(404,{error:'页面不存在'});
  } catch(e) {send(400,{error:e.message});}
});

// 云端冷启动时数据目录是空的，首屏会一片空白，演示体验很差。
// AUTO_SEED=1 时启动后自动跑一次示例账期，等用户打开页面时已经有结果可看。
function autoSeed() {
  try {
    if ([...runs.values()].some(r => r.status === 'done' && r.results.length)) {
      console.log('[seed] 已有完成的对账记录，跳过预热');
      return;
    }
    if (active) return;
    const input = getInput(), id = randomUUID();
    const pageSize = input.orders.length + input.payments.length > 100 ? 25 : 8;
    const r = {id, started: new Date().toISOString(), source: summary(input), pageSize,
      pages: Object.fromEntries(['orders','payments'].map(k=>[k,Math.max(1,Math.ceil(input[k].length/pageSize))])),
      cursor:{orders:0,payments:0}, captured:{orders:[],payments:[]}, results:[], logs:[]};
    fs.mkdirSync(directory(id), {recursive:true});
    save(inputPath(id), input);
    runs.set(id, r);
    start(r, input);
    console.log('[seed] 已启动一次预热对账，完成后首屏即有演示数据');
  } catch (e) {
    console.error('[seed] 预热失败（不影响正常使用）：' + e.message);
  }
}

server.on('error',e=>{console.error('启动失败：'+e.message);process.exitCode=1;});
server.listen(port,bindHost,()=>{
  fs.mkdirSync(data,{recursive:true});
  for(const id of fs.readdirSync(data).sort((a,b)=>{
    const ts=k=>fs.existsSync(metadata(k))?fs.statSync(directory(k)).birthtimeMs:0;
    return ts(a)-ts(b);
  })) {
    if (!fs.existsSync(metadata(id))) continue;
    const r=read(metadata(id));
    if(['running','pausing'].includes(r.status)){r.status='paused';log(r,'检测到服务重启，保留上次检查点');save(metadata(id),r);}
    runs.set(id,r);
  }
  console.log('LedgerPilot · '+(publicBase || base)+'   监听 '+bindHost+':'+port);
  if(process.argv.includes('--open') && process.platform==='win32')
    spawn('rundll32.exe',['url.dll,FileProtocolHandler',base],{detached:true,stdio:'ignore'}).unref();
  if(process.env.AUTO_SEED === '1') autoSeed();
});
