import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { readCatalog } from '../src/catalog.ts';
import { buildToolMatchingReport } from './lib/tool-matching.ts';
import { renderReadOnlyView } from './lib/readonly-view.ts';

const browser = await chromium.launch({ executablePath: process.env.HB_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const external: string[] = []; const errors: string[] = []; let sockets = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', serviceWorkers: 'block' });
  await context.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort());
  context.on('request', request => { if (/^(https?|wss?):/.test(request.url())) external.push('external-request'); });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message)); page.on('websocket', () => sockets++);
  await page.goto(pathToFileURL(resolve('artifacts/read-only-guide.html')).href);
  await page.waitForFunction(() => document.querySelector('#group-count')?.textContent === '12');
  assert.equal(await page.locator('#tools tr').count(), 7); assert.equal(await page.locator('#gates li').count(), 12);
  assert.equal(await page.locator('#acceptance-verdict').innerText(), '完整产品验收：未通过');
  const query = page.getByRole('searchbox', { name: '输入公开品牌或型号名称' });
  await query.fill('we vibe');
  await page.waitForFunction(() => document.querySelector('#matches h3')?.textContent === 'We-Vibe');
  await query.fill('小怪兽');
  await page.waitForFunction(() => document.querySelector('#matches h3')?.textContent === '小怪兽 / MonsterPub');
  await query.fill('000123');
  await page.waitForFunction(() => document.querySelector('#query-status')?.textContent?.includes('不处理数字码'));
  assert.equal(await page.locator('#matches .record').count(), 0);
  await query.fill('unknown-query-marker');
  await page.waitForFunction(() => document.querySelector('#matches')?.textContent?.includes('没有匹配记录'));
  await page.getByRole('button', { name: '清空查询' }).click();
  assert.equal(await page.locator('#matches .record').count(), 12);
  await page.screenshot({ path: 'artifacts/readonly-desktop.png', fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.locator('header').count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'artifacts/readonly-mobile.png', fullPage: false });
  const catalog = readCatalog(); const fusion = JSON.parse(await readFile('artifacts/real-fusion-status.json', 'utf8'));
  const acceptance = JSON.parse(await readFile('artifacts/product-acceptance.json', 'utf8'));
  const profiles = structuredClone(catalog.profiles);
  const marker = '<script>window.__unexpected = true</script><b>catalog-marker</b>';
  profiles[0]!.name = marker;
  const fixture = renderReadOnlyView({ report: buildToolMatchingReport(catalog, fusion), profiles, acceptance });
  await writeFile('artifacts/readonly-markup-fixture.html', fixture);
  await page.goto(pathToFileURL(resolve('artifacts/readonly-markup-fixture.html')).href);
  await page.waitForFunction(() => document.querySelector('#matches h3')?.textContent?.includes('catalog-marker'));
  assert.equal(await page.locator('#matches script, #matches b').count(), 0);
  assert.equal(await page.evaluate(() => (window as unknown as { __unexpected?: boolean }).__unexpected), undefined);
  assert.equal(external.length, 0); assert.equal(sockets, 0); assert.deepEqual(errors, []);
  await writeFile('artifacts/readonly-browser-result.json', JSON.stringify({ status: 'passed', scope: 'local-file read-only viewer',
    cases: ['brand-text-search', 'Chinese-label-search', 'numeric-input-not-resolved', 'empty-result', 'clear-query', 'tool-statuses', 'acceptance-gaps', '390px-layout', 'markup-rendered-as-text'],
    externalPageRequests: external.length, webSocketConnections: sockets, pageErrors: errors, deviceAccess: false }, null, 2));
  console.log('Read-only local viewer checks passed; external page requests0, device accessfalse.');
  await context.close();
} finally { await browser.close(); }
