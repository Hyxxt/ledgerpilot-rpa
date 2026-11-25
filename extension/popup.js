const $=id=>document.getElementById(id);
const headers={orders:['订单号','客户','应收金额'],payments:['流水号','订单号','实收金额']};
let tables=[];
function option(value,text){return new Option(text,String(value));}
function mapping(){
  const t=tables[Number($('table').value)];if(!t)return;
  $('fields').replaceChildren(...headers[$('kind').value].map((label,index)=>{
    const box=document.createElement('label'),select=document.createElement('select');
    select.append(option('','请选择源列'),...t.header.map((h,i)=>option(i,h||'第 '+(i+1)+' 列')));
    const auto=t.header.indexOf(label);
    if(auto>=0)select.value=String(auto);
    box.append(label,select);return box;
  }));
  $('msg').textContent='已读取 '+t.rows.length+' 行。导出范围为当前页。';
}
$('scan').onclick=async()=>{
  try{
    $('config').hidden=true;
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
      return [...document.querySelectorAll('table')].filter(t=>t.getClientRects().length).map(t=>{
        const rows=[...t.rows].filter(r=>r.getClientRects().length);
        if(rows.length>2501)throw Error('单页表格超过 2500 行');
        const cells=r=>Array.from(r.cells,c=>c.innerText.trim());
        return {header:rows.length?cells(rows[0]):[],rows:rows.slice(1).map(cells)};
      }).filter(t=>t.header.length&&t.rows.length);
    }});
    tables=result.result||[];if(!tables.length)throw Error('没有找到带表头和数据的可见 HTML 表格。');
    $('table').replaceChildren(...tables.map((t,i)=>option(i,(i+1)+'. '+t.header.join(' / ').slice(0,48))));
    $('config').hidden=false;mapping();
  }catch(err){$('msg').textContent='读取失败：'+err.message;}
};
$('kind').onchange=mapping;$('table').onchange=mapping;
$('download').onclick=()=>{
  const cols=[...$('fields').querySelectorAll('select')].map(s=>s.value);
  if(cols.includes('')||new Set(cols).size!==3){$('msg').textContent='请为三个字段分别选择不同的源列。';return;}
  const t=tables[Number($('table').value)],kind=$('kind').value;
  const safeCell=v=>{let s=String(v??'');if(/^[\s]*[=+@\t\r-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const rows=t.rows.map(r=>cols.map((c,i)=>i===2?(r[c]||'').replace(/^[¥￥]\s*/,'').replaceAll(',',''):r[c]));
  const csv='\uFEFF'+[headers[kind],...rows].map(r=>r.map(safeCell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=kind+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  $('msg').textContent='已生成 CSV，可在工作台的“数据来源”中导入。';
};
