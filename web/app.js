'use strict';
const $ = q => document.querySelector(q);
const e = s => String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const titles={desk:'对账工作台',history:'运行历史',sources:'数据来源'};
const states={idle:'准备就绪',running:'执行中',pausing:'正在暂停',paused:'已暂停',failed:'运行中断',done:'已完成'};
const reasons={match:'金额相符',missing:'缺少流水',under:'收款不足',over:'超额收款',orphan:'流水无订单'};
const shapes={grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',history:'M4 10a8 8 0 1 1 0 5M3 5v5h5M12 7v5l3 2',database:'M4 6c0-4 16-4 16 0s-16 4-16 0zm0 0v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0',orders:'M5 3h14v18l-3-2-4 2-4-2-3 2zM8 8h8M8 12h6',payments:'M3 6h18v13H3zM3 10h18M7 15h4',check:'M3 12l6 6L21 5',flag:'M5 21V4h13l-3 4 3 4H5',scan:'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M3 12h18',report:'M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h5',play:'M7 4l13 8-13 8z'};
const icon = k => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="${shapes[k]}"/></svg>`;
document.querySelectorAll('[data-icon]').forEach(x=>x.innerHTML=icon(x.dataset.icon));
const money = c => c===null?'—':(c/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const date = s => new Date(s).toLocaleString('zh-CN',{hour12:false});
let state, run, selected=null, view='desk', filter='all', page=1, busy=false, refreshing=0, timer, toastTimer;
async function api(url, data) {
  const res=await fetch(url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const value=await res.json();
  if(!res.ok) throw Error(value.error||'操作失败'); return value;
}
function notify(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6000);}
function showView(v){
  view=v;Object.keys(titles).forEach(k=>$('#'+k).hidden=k!==v);
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===v));
  $('#crumb').textContent=titles[v];
  if(state)scheduleFrame();
}
async function refresh(){
  const seq=++refreshing;
  const latest=await api('/api/state');
  const id=selected==='draft'?null:(selected||latest.runs[0]?.id);
  const details=id?await api('/api/runs/'+id):null;
  if(seq!==refreshing)return;
  state=latest;run=details;render();
  clearTimeout(timer);
  if(state.active || run?.status==='running' || run?.status==='pausing')timer=setTimeout(()=>refresh().catch(disconnect),260);
}
function disconnect(err){notify('连接中断，将重试。'+err.message);clearTimeout(timer);timer=setTimeout(()=>refresh().catch(disconnect),2500);}
function render(){
  const s=run?.source||state.source, status=run?.status||'idle';
  $('#source-caption').textContent=run ? s.name+'　·　'+date(run.started) : '当前账期：'+s.name;
  const button=(action,label,primary=false,disabled=false)=>`<button data-action="${action}" class="${primary?'primary':''}" ${disabled?'disabled':''}>${action==='start'?icon('play'):''}${label}</button>`;
  $('#run-actions').innerHTML=status==='running'?button('pause','暂停任务'):status==='pausing'?button('pause','正在保存进度',false,true):
    (['paused','failed'].includes(status)?button('resume','从检查点继续',true,busy||!!state.active):'')+button('start',run?'新建运行':'开始对账',!['paused','failed'].includes(status),busy||!!state.active);
  $('#metrics').innerHTML=[
    ['订单记录',s.orders,'当前批次','orders'],['付款流水',s.payments,'当前批次','payments'],
    ['自动匹配',status==='done'?run.matched:'—','金额一致的订单','check'],
    ['待人工复核',status==='done'?run.exceptions-run.reviewed:'—',status==='done'?'已复核 '+run.reviewed+' 条':'差额与缺失记录','flag'],
  ].map(([name,n,caption,k],i)=>`<div class="metric ${i===3?'attn':''}"><label>${name}${icon(k)}</label><b>${n}</b><small>${caption}</small></div>`).join('');
  $('#state-tag').textContent=states[status];$('#state-tag').className='hero-status '+status;
  syncPlayer();
  $('#result-sub').textContent=run?.status==='done'?`共 ${run.results.length} 条结果，含 ${run.exceptions} 条异常`:'完成采集后可按订单查看金额和来源页。';
  $('#export').hidden=status!=='done';if(run)$('#export').href='/api/runs/'+run.id+'/export';
  $('#logs').innerHTML=run?run.logs.slice().reverse().map(l=>`<li><time>${e(date(l.at))}</time>${e(l.text)}</li>`).join(''):'<li>等待运行</li>';
  $('#source-name').textContent=state.source.name+` · ${state.source.orders} 条订单 / ${state.source.payments} 条流水`;
  $('#history-list').innerHTML=state.runs.length?state.runs.map(r=>`<div class="history-row"><div><strong>${e(r.source.name)}</strong><small>${e(date(r.started))} · ${e(r.id.slice(0,8))}</small></div><span class="pill">${states[r.status]}</span><button data-select="${r.id}">查看</button></div>`).join(''):'<div class="empty">首次运行后将在这里保留记录</div>';
  renderTable();
}
function renderTable(){
  const query=$('#search').value.trim().toLowerCase();
  document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===filter));
  const list=(run?.results||[]).filter(x=>(filter==='all'||(filter==='open'?x.reason!=='match'&&!x.review:!!x.review))&&
    (x.id+' '+x.customer).toLowerCase().includes(query));
  const max=Math.max(1,Math.ceil(list.length/8));page=Math.min(page,max);
  $('#pager').innerHTML=list.length>8?`<button data-page="-1" ${page===1?'disabled':''}>上一页</button> ${page} / ${max} <button data-page="1" ${page===max?'disabled':''}>下一页</button>`:'';
  $('#result-table').innerHTML=list.length?`<div class="tablewrap"><table><thead><tr><th>订单号 / 客户</th><th class="num">应收 ¥</th><th class="num">实收 ¥</th><th class="num">差额 ¥</th><th>结果</th><th></th></tr></thead><tbody>${list.slice((page-1)*8,page*8).map(x=>`<tr><td><strong>${e(x.id)}</strong><br><small>${e(x.customer)}</small></td><td class="num">${money(x.due)}</td><td class="num">${money(x.paid)}</td><td class="num">${x.delta>0?'+':''}${money(x.delta)}</td><td><span class="tag ${x.reason==='match'?'good':'warn'}">${reasons[x.reason]}</span>${x.review?' · 已复核':''}</td><td><button class="link" data-row="${e(x.id)}">详情 ↗</button></td></tr>`).join('')}</tbody></table></div>`:
    `<div class="empty"><strong>${run?.status==='done'?'没有符合条件的记录':run?'等待核对结果':'尚未运行对账'}</strong><span>${run?.status==='done'?'可以切换筛选条件或修改关键词。':run?'可在执行日志中查看进度。':'点击右上角的运行按钮，开始采集示例账期。'}</span></div>`;
}
function detail(id){
  const x=run.results.find(r=>r.id===id);if(!x)return;
  const evidence=ref=>`<a target="_blank" rel="noopener" href="/api/runs/${run.id}/evidence/${ref.kind}-${ref.page}.png">第 ${ref.page} 页截图 ↗</a> · 第 ${ref.row} 行`;
  $('#detail-body').innerHTML=`<h3>${e(x.id)} · ${reasons[x.reason]}</h3><dl><dt>客户</dt><dd>${e(x.customer)}</dd><dt>应收 / 实收</dt><dd>¥ ${money(x.due)} / ¥ ${money(x.paid)}</dd><dt>差额</dt><dd>¥ ${money(x.delta)}</dd></dl>
    <h3>订单证据</h3><p>${x.orderRef?evidence(x.orderRef):'本批次未找到关联订单。'}</p><h3>付款证据</h3>${x.receipts.map(p=>`<p>${e(p.id)} · ¥ ${money(p.cents)}<br>${evidence(p.ref)}</p>`).join('')||'<p>本批次未找到关联流水。</p>'}
    ${x.review?`<h3>已复核</h3><p>${e(x.review.note)}<br><small>${e(date(x.review.at))}</small></p>`:
    x.reason!=='match'?`<form id="review-form"><label for="note"><strong>复核说明</strong></label><textarea id="note" maxlength="400" required placeholder="记录核查结论或后续处理安排"></textarea><button class="primary">保存复核记录</button></form>`:''}`;
  $('#review-form')?.addEventListener('submit',ev=>{ev.preventDefault();perform(async()=>{
    await api('/api/runs/'+run.id+'/review',{id,note:$('#note').value});$('#detail').close();notify('已保存复核记录');});});
  if(!$('#detail').open)$('#detail').showModal();
  scheduleFrame();
}
async function perform(fn){
  if(busy)return;busy=true;
  try{await fn();}catch(err){notify(err.message);}finally{busy=false;await refresh().catch(disconnect);}
}
document.addEventListener('click',ev=>{
  const b=ev.target.closest('button');if(!b)return;
  if(b.dataset.view)showView(b.dataset.view);
  if(b.dataset.action)perform(async()=>{
    if(b.dataset.action==='start'){const r=await api('/api/runs',{});selected=r.id;filter='all';page=1;$('#search').value='';}
    else await api('/api/runs/'+run.id+'/'+b.dataset.action,{});
  });
  if(b.dataset.select){selected=b.dataset.select;page=1;filter='all';$('#search').value='';showView('desk');refresh().catch(disconnect);}
  if(b.dataset.filter){filter=b.dataset.filter;page=1;renderTable();}
  if(b.dataset.page){page+=Number(b.dataset.page);renderTable();}
  if(b.dataset.row)detail(b.dataset.row);
});
$('#close').onclick=()=>$('#detail').close();
$('#search').oninput=()=>{page=1;renderTable();};
$('#import-form').onsubmit=ev=>{ev.preventDefault();const form=ev.currentTarget;perform(async()=>{
  const f=new FormData(form);
  if(f.get('orders').size+f.get('payments').size>2_800_000)throw Error('两份 CSV 合计请控制在 2.8 MB 以内');
  await api('/api/source',{name:f.get('name'),orders:await f.get('orders').text(),payments:await f.get('payments').text()});
  form.reset();selected='draft';filter='all';page=1;$('#search').value='';notify('数据已导入，可在工作台开始对账');});};
$('#reset-source').onclick=()=>perform(async()=>{await api('/api/source',{demo:true});selected='draft';notify('当前来源已切换为示例账期');});
const player={id:null,signature:'',frames:[],at:0,playing:false,speed:1,timer:null,sourceKey:'',request:0,cache:new Map(),phase:''};
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
function makeFrames(r){
  const frames=[];
  for(const kind of ['orders','payments']){
    for(let p=1;p<=r.cursor[kind];p++){
      const count=Math.min(r.pageSize,Math.max(0,r.source[kind]-(p-1)*r.pageSize));
      frames.push({kind,page:p,label:kind==='orders'?'采集订单':'采集收款流水',message:`第 ${p} 页 · ${count} 条记录`,icon:kind});
    }
  }
  if(r.status==='done'){
    for(const row of r.results){
      const ref=row.orderRef||row.receipts[0]?.ref;
      if(!ref)continue;
      frames.push({kind:ref.kind,page:ref.page,row,label:reasons[row.reason],message:row.id,icon:row.reason==='match'?'check':'flag'});
    }
  }
  return frames;
}
function syncPlayer(){
  const id=run?.id||'draft',signature=[id,run?.status,run?.cursor.orders,run?.cursor.payments,run?.results.length].join('|');
  if(signature===player.signature){paintPlayer();return;}
  const changed=player.id!==id, prior=player.phase;
  player.id=id;player.signature=signature;player.phase=run?.status||'idle';
  player.frames=run?makeFrames(run):[];
  if(changed){player.cache.clear();player.sourceKey='';}
  if(player.phase==='done'){
    player.at=changed?0:(prior!=='done'?Math.min(run.cursor.orders+run.cursor.payments,player.frames.length-1):player.at);
    player.playing=!reducedMotion.matches && player.frames.length>1;
  }else{player.at=Math.max(0,player.frames.length-1);player.playing=false;}
  paintPlayer();
}
function scheduleFrame(){
  clearTimeout(player.timer);
  if(!player.playing||view!=='desk'||document.hidden||$('#detail').open)return;
  const frame=player.frames[player.at];
  player.timer=setTimeout(()=>{
    if(player.at+1>=player.frames.length){player.playing=false;}
    else{player.at++;if(player.at===player.frames.length-1)player.playing=false;}
    paintPlayer();
  },(frame?.row?970:1550)/player.speed);
}
function showRows(rows,focus){
  const body=$('#frame-content');
  const header=rows[0]||[];
  const selected=focus?.kind==='payments'?focus.row?.receipts.find(x=>x.ref.page===focus.page)?.id:focus?.row?.id;
  body.innerHTML=`<div class="preview-scroll"><table><thead><tr>${header.map(s=>`<th>${e(s)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r=>`<tr class="${selected===r[0]?'focused':''}">${r.map((s,i)=>`<td class="${i===2?'num':''}">${e(s)}</td>`).join('')}</tr>`).join('')}</tbody></table>${rows.length===1?'<p class="preview-note">此页没有记录</p>':''}</div>`;
  const mark=body.querySelector('.focused');
  if(mark){const box=body.firstElementChild;box.scrollTop=Math.max(0,mark.offsetTop-box.clientHeight/2);}
}
async function displayPage(frame){
  const kind=frame?.kind||'orders',p=frame?.page||1;
  const id=run?.id||'current',url=`/source/${id}/${kind}?page=${p}`;
  const key=url+'|'+(frame?.row?.id||'')+'|'+(state?.source.name||'');
  if(key===player.sourceKey)return;
  player.sourceKey=key;const seq=++player.request;
  const cached=player.cache.get(url);
  if(cached){showRows(cached,frame);return;}
  $('#frame-content').innerHTML='<p class="preview-note">正在读取页面…</p>';
  try{
    const response=await fetch(url);
    if(!response.ok)throw Error();
    const doc=new DOMParser().parseFromString(await response.text(),'text/html');
    const table=doc.querySelector('table[data-page]');
    if(!table)throw Error();
    const rows=Array.from(table.rows,r=>Array.from(r.cells,c=>c.textContent.trim()));
    if(seq!==player.request)return;
    if(id!=='current'){player.cache.set(url,rows);if(player.cache.size>16)player.cache.delete(player.cache.keys().next().value);}
    showRows(rows,frame);
  }catch{
    if(seq!==player.request)return;
    player.sourceKey='';$('#frame-content').innerHTML='<p class="preview-note">页面读取失败 <button id="retry-frame">重新读取</button></p>';
  }
}
function paintPlayer(){
  const frames=player.frames, frame=frames[player.at], done=run?.status==='done', live=run?.status==='running'||run?.status==='pausing';
  const clock=done&&frames.length>1, kind=frame?.kind||'orders', num=frame?.page||1;
  $('#mode').textContent=done?(player.playing?'正在回放':'运行回放'):live?'实时采集':run?states[run.status]:'来源预览';
  $('#mode').classList.toggle('broadcast',Boolean(live||player.playing));
  $('#command-hero').classList.toggle('active-route',Boolean(live||player.playing));
  $('#frame-name').textContent=(kind==='orders'?'订单管理':'收款流水')+' / 第 '+num+' 页'+(!frame&&run?' · 来源预览':'');
  const evidence=$('#evidence');evidence.hidden=!frame;
  if(frame)evidence.href=`/api/runs/${run.id}/evidence/${kind}-${num}.png`;
  const b=$('#playback');b.disabled=!clock;b.textContent=player.playing?'Ⅱ':(player.at===frames.length-1&&clock?'↺':'▶');
  b.setAttribute('aria-label',player.playing?'暂停回放':'播放回放');b.title=b.getAttribute('aria-label');
  const scrub=$('#scrubber');scrub.max=Math.max(1,frames.length-1);scrub.value=player.at;scrub.disabled=!clock;
  $('#position').textContent=frames.length?`${player.at+1} / ${frames.length}`:'0 / 0';
  $('#speed').disabled=!clock;$('#speed').textContent=player.speed+'×';
  $('#event-count').textContent=done?'运行回放':live?'实时':'';
  const recent=frames.slice(Math.max(0,player.at-2),player.at+1).reverse();
  $('#events').innerHTML=recent.map((v,i)=>`<li class="${i===0?'current ':''}${v.row&&v.row.reason!=='match'?'warn':''}"><span class="event-symbol">${icon(v.icon)}</span><div><strong>${e(v.label)}</strong><small>${e(v.message)}</small></div>${v.row?`<button class="link" data-row="${e(v.row.id)}" aria-label="查看 ${e(v.row.id)}">↗</button>`:`<small class="frame-idx">P${String(v.page).padStart(2,'0')}</small>`}</li>`).join('')||`<li class="event-idle">${live?'机器人正在打开源网页…':'启动任务后，这里将显示采集记录。'}</li>`;
  const count=run?run.pages.orders+run.pages.payments:0, scanned=run?run.cursor.orders+run.cursor.payments:0;
  $('#progress').max=Math.max(1,done?frames.length:count);$('#progress').value=done?player.at+1:scanned;
  $('#progress-copy').textContent=done?`已回放 ${player.at+1} / ${frames.length} 个事件`:`已采集 ${scanned} / ${count} 页`;
  displayPage(frame);scheduleFrame();
}
$('#playback').onclick=()=>{
  if(!player.playing&&player.at===player.frames.length-1)player.at=0;
  player.playing=!player.playing;paintPlayer();
};
$('#scrubber').oninput=ev=>{player.at=Number(ev.target.value);player.playing=false;paintPlayer();};
$('#speed').onclick=()=>{player.speed=player.speed===1?2:player.speed===2?4:1;paintPlayer();};
$('#frame-content').onclick=ev=>{if(ev.target.id==='retry-frame')paintPlayer();};
document.addEventListener('visibilitychange',scheduleFrame);
$('#detail').addEventListener('close',scheduleFrame);
reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches){player.playing=false;paintPlayer();}});
showView('desk');refresh().catch(disconnect);
