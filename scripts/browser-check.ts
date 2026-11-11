import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.ts';
import { DemoAdapter } from '../src/adapters/demo.ts';
import { AppError } from '../src/core/errors.ts';

const app = createApp({ webRoot: new URL('../dist/src/web/', import.meta.url), factory: mode => { if (mode !== 'demo') throw new AppError('FIXTURE_OFFLINE', '隔离检查不连接真实设备。', 503); return new DemoAdapter(); } });
const url = await app.listen(0);
const browser = await chromium.launch({ executablePath: process.env.HB_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
await mkdir('artifacts', { recursive: true });
const errors: string[] = [];
let debugPage: import('playwright').Page | undefined;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1150 }, colorScheme: 'light' });
  const page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
  debugPage = page;
  await page.goto(url); await page.getByRole('button', { name: '开始演示' }).click();
  const card = page.locator('[data-id="demo-a"]'); await card.waitFor();
  await page.getByRole('heading', { name: '连接检查通过' }).waitFor();
  assert.ok((await page.locator('#report-evidence').innerText()).includes('实机待验'));
  const downloading = page.waitForEvent('download'); await page.getByRole('link', { name: '下载连接检查报告' }).click();
  const download = await downloading; await download.saveAs('artifacts/connection-report.json');
  const report = JSON.parse(await readFile('artifacts/connection-report.json', 'utf8'));
  assert.equal(report.physicalVerified, false); assert.equal(report.evidence, 'synthetic');
  assert.equal(await card.getByRole('slider').first().isDisabled(), true);
  await card.getByRole('button', { name: '启用控制' }).click();
  await page.waitForFunction(() => !(document.querySelector('[data-id="demo-a"] input[type="range"]') as HTMLInputElement)?.disabled);
  const slider = card.getByRole('slider').first();
  await slider.focus(); await slider.press('ArrowRight'); await slider.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('[data-id="demo-a"] [data-receipt]')?.textContent === '指令已发送');
  assert.equal(await slider.inputValue(), '2');
  await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
  await card.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-id="demo-a"] [data-receipt]')?.textContent === '停止指令已确认');
  assert.equal(await slider.isDisabled(), true); assert.equal(await slider.inputValue(), '0');
  await card.getByRole('button', { name: '启用控制' }).click();
  await page.waitForFunction(() => !(document.querySelector('[data-id="demo-a"] [data-exercise]') as HTMLButtonElement)?.disabled);
  await card.getByRole('button', { name: '首个电机短测（10% · 0.5秒）', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#alert')?.textContent?.includes('模拟测试完成'));
  assert.equal(await slider.isDisabled(), true); assert.equal(await slider.inputValue(), '0');
  await page.getByRole('button', { name: '断开连接' }).click();
  await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent === '未连接');
  await page.getByRole('button', { name: '开始演示' }).click();
  assert.equal(await card.getByRole('slider').first().isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#devices-title').scrollIntoViewIfNeeded();
  const stopBounds = await page.locator('#stop-all').boundingBox(); assert.ok(stopBounds && stopBounds.y >= 0 && stopBounds.y + stopBounds.height <= 844);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  await page.locator('.catalog-panel summary').click(); await page.locator('#catalog-search').fill('__no_device_matching_this_query__');
  await page.waitForFunction(() => document.querySelector('#catalog-count')?.textContent === '找到 0 条资料，显示 0 条');
  await page.locator('#catalog-search').fill('Satisfyer');
  await page.waitForFunction(() => document.querySelectorAll('#catalog-records li').length > 0 && [...document.querySelectorAll('#catalog-records li')].every(item => item.textContent?.includes('Satisfyer')));
  await page.locator('.catalog-panel summary').click();
  await page.getByRole('button', { name: '断开连接' }).click();
  await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent === '未连接');
  await page.getByRole('button', { name: '一键连接检查' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile('artifacts/browser-result.json', JSON.stringify({ status: 'passed', hardwareAccess: false, scenarios: ['one-click-demo-diagnostics', 'report-download-with-pending-hardware', 'arm-before-output', 'keyboard-control', 'stop-and-disarm', 'bounded-motor-test-and-stop', 'reconnect-no-rearm', '390px-layout', 'visible-global-stop', 'catalog-search', 'connection-failure'], pageErrors: errors }, null, 2));
  console.log('Browser flow passed (synthetic devices only).');
  await context.close();
} catch (error) {
  if (debugPage && !debugPage.isClosed()) {
    await debugPage.screenshot({ path: 'artifacts/browser-failure.png', fullPage: true });
    await writeFile('artifacts/browser-failure.json', JSON.stringify({ error: String(error), pageErrors: errors,
      text: await debugPage.locator('body').innerText() }, null, 2));
  }
  throw error;
} finally { await browser.close(); await app.close(); }
