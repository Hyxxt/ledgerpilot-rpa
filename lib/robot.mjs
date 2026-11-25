import { existsSync } from 'node:fs';
import path from 'node:path';
import { reconcile } from './ledger.mjs';

export function browserPath() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const choices = [process.env.LEDGER_BROWSER, ...roots.flatMap(r => [
    path.join(r,'Microsoft','Edge','Application','msedge.exe'),
    path.join(r,'Google','Chrome','Application','chrome.exe')]),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'];
  const executable = choices.find(p => p && existsSync(p));
  if (!executable) throw Error('找不到 Edge 或 Chrome。安装其一，或设置 LEDGER_BROWSER 为浏览器可执行文件路径后继续。');
  return executable;
}

// 运行环境决定用哪个浏览器：
//   本地  → playwright-core + 本机已装的 Edge/Chrome（不额外占硬盘）
//   云端  → playwright 自带的 Chromium（容器里没有 Edge 可借）
// 用环境变量显式切换，避免"本地能跑、云端起不来"这种最难查的问题。
export function bundledMode() {
  return process.env.PLAYWRIGHT_BUNDLED === '1'
    || process.env.USE_BUNDLED_CHROMIUM === '1'
    || Boolean(process.env.RENDER)
    || process.env.NODE_ENV === 'production';
}

export async function launchBrowser() {
  const common = { headless: true };
  if (bundledMode()) {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw Error('当前是云端模式，但没装 playwright 包（它带自带 Chromium）。'
        + '请执行 npm install playwright 后重试；本地调试请取消 PLAYWRIGHT_BUNDLED 环境变量。');
    }
    return chromium.launch({
      ...common,
      // 容器内没有用户命名空间，必须关沙箱；/dev/shm 默认只有 64MB，会随机崩
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  const { chromium } = await import('playwright-core');
  return chromium.launch({ ...common, executablePath: browserPath() });
}

// 每页是一个检查点：截图落盘后才保存该页的行和下一页游标。
export async function execute(ctx) {
  const {run, input, base, dir, persist, log} = ctx;
  let browser;
  let finalStatus;
  const stopped = () => run.status === 'pausing';
  try {
    browser = await launchBrowser();
    const page = await browser.newPage({viewport:{width:1160,height:850}, locale:'zh-CN'});
    page.setDefaultTimeout(8000);
    for (const kind of ['orders','payments']) {
      const label = kind === 'orders' ? '订单' : '流水';
      const pages = Math.max(1, Math.ceil(input[kind].length / run.pageSize));
      let next = run.cursor[kind] + 1;
      if (next > pages) continue;
      const url = base + '/source/' + run.id + '/' + kind + '?page=';
      let navigated = false;
      while (next <= pages && !stopped()) {
        let captured;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            if (!navigated) await page.goto(url + next, {waitUntil:'domcontentloaded'});
            await page.locator('table[data-page="' + next + '"]').waitFor();
            const cells = await page.locator('tbody tr[data-record]').evaluateAll(rows =>
              rows.map(row => Array.from(row.cells, cell => cell.textContent.trim())));
            const expected = Math.min(run.pageSize, Math.max(0, input[kind].length - (next-1)*run.pageSize));
            if (cells.length !== expected) throw Error('页面记录数量与批次清单不符');
            captured = cells.map(([id, labelText, money], index) => {
              if (!/^\d+\.\d{2}$/.test(money)) throw Error('源页面金额格式异常');
              const cents = Number(money.replace('.',''));
              const ref = {kind, page:next, row:index+1};
              return kind === 'orders' ? {id,customer:labelText,cents,ref} : {id,order:labelText,cents,ref};
            });
            await page.screenshot({path:path.join(dir, kind + '-' + next + '.png'), fullPage:true, timeout:10000});
            break;
          } catch (error) {
            if (attempt === 3 || stopped()) throw error;
            navigated = false;
            log(label + '第 ' + next + ' 页读取失败，重试 ' + attempt + '/2');
          }
        }
        run.captured[kind].push(...captured);
        run.cursor[kind] = next;
        log(label + '第 ' + next + '/' + pages + ' 页已采集，' + captured.length + ' 条记录');
        persist();
        next++;
        if (next <= pages && !stopped()) {
          try {
            await page.getByRole('button',{name:'下一页',exact:true}).click();
            navigated = true;
          } catch { navigated = false; log('翻页未完成，将重新打开目标页'); }
        }
      }
      if (stopped()) break;
    }
    if (stopped()) {finalStatus='paused'; log('已保存检查点，可以继续');}
    else {
      run.results = reconcile(run.captured.orders,run.captured.payments);
      finalStatus='done'; log('核对完成，生成 ' + run.results.length + ' 条对账结果');
    }
  } catch (error) {
    finalStatus = stopped() ? 'paused' : 'failed';
    log(finalStatus === 'failed' ? '任务中断：' + error.message.slice(0,360) : '已暂停');
  } finally {
    if (browser) await browser.close().catch(()=>{});
    run.status=finalStatus;
    persist();
  }
}
