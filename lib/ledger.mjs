export const schemas = {
  orders: ['订单号', '客户', '应收金额'],
  payments: ['流水号', '订单号', '实收金额'],
};
export const reasons = {
  match: '金额相符', missing: '缺少流水', under: '收款不足',
  over: '超额收款', orphan: '流水无订单',
};

export function demoSource() {
  const customers = ['溪禾书店', '舟木工作室', '橘光商行', '松间设计', '山野器物', '晚星印务'];
  const orders = Array.from({length: 24}, (_, i) => ({
    id: 'LP-' + (26001 + i), customer: customers[i % customers.length],
    cents: [12800, 36800, 24850, 69600, 35990, 153000, 8900][i % 7],
  }));
  const payments = orders.flatMap((order, i) => {
    if ([5, 17].includes(i)) return [];
    const amounts = i === 4 ? [12000, order.cents - 12000] :
      [order.cents + (i === 9 ? -2800 : i === 19 ? 5000 : 0)];
    return amounts.map((cents, j) => ({id: 'TX-' + (81000 + 2 * i + j), order: order.id, cents}));
  });
  payments.push({id: 'TX-81999', order: 'LP-26999', cents: 16800});
  return {name:'河岸商贸 · 示例账期', orders, payments};
}

export const amount = cents => (cents / 100).toFixed(2);

export function parseCsv(input) {
  const s = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const finish = () => { row.push(cell.trim()); cell = ''; closed = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (s[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (c === ',') finish();
    else if (c === '\n') { finish(); if (row.some(Boolean)) rows.push(row); row = []; }
    else if (c === '"' && !cell && !closed) quoted = true;
    else if (closed || c === '"') throw Error('CSV 引号格式错误，请检查第 ' + (rows.length + 1) + ' 行');
    else cell += c;
  }
  if (quoted) throw Error('CSV 引号没有闭合');
  finish(); if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function importTable(kind, input) {
  const [header = [], ...rows] = parseCsv(input);
  const fields = schemas[kind];
  const columns = fields.map(h => header.indexOf(h));
  if (columns.includes(-1) || new Set(header).size !== header.length)
    throw Error('列名需要包含且只出现一次：' + fields.join('、'));
  if (rows.length > 2500) throw Error('单张表最多支持 2500 行');
  const ids = new Set();
  return rows.map((r, i) => {
    const fail = message => { throw Error((kind === 'orders' ? '订单' : '流水') + '第 ' + (i + 2) + ' 行：' + message); };
    if (r.length !== header.length) fail('列数与表头不同');
    const [id, label, money] = columns.map(c => r[c]);
    if (!id || !label || id.length > 100 || label.length > 120) fail('编号或名称为空或过长');
    if (ids.has(id)) fail('主键重复 ' + id);
    ids.add(id);
    if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(money)) fail('金额须为非负十进制数，最多两位小数');
    const [whole, frac=''] = money.split('.');
    const cents = Number(whole) * 100 + Number(frac.padEnd(2,'0'));
    return kind === 'orders' ? {id, customer: label, cents} : {id, order: label, cents};
  });
}

export function csv(rows) {
  const cell = v => {
    let s = String(v ?? '');
    if (/^[\s]*[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n');
}

export function reconcile(orders, payments) {
  const groups = new Map();
  orders.forEach(o => groups.set(o.id, {id:o.id, customer:o.customer, due:o.cents, orderRef:o.ref, receipts:[]}));
  for (const p of payments) {
    if (!groups.has(p.order)) groups.set(p.order, {id:p.order, customer:'—', due:null, receipts:[]});
    groups.get(p.order).receipts.push(p);
  }
  return [...groups.values()].map(r => {
    const paid = r.receipts.reduce((sum,p) => sum + p.cents, 0);
    const delta = paid - (r.due ?? 0);
    const reason = r.due === null ? 'orphan' : !r.receipts.length ? 'missing' : delta < 0 ? 'under' : delta > 0 ? 'over' : 'match';
    return {...r, paid, delta, reason, review:null};
  }).sort((a,b) => Number(a.reason === 'match') - Number(b.reason === 'match') || a.id.localeCompare(b.id));
}
