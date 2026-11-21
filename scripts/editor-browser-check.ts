import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { librarySchema } from '../src/studio/schema.ts';

// Serves the built browser edition exactly as a static host would, then drives the
// public editor end to end. No device, model or network endpoint is involved.
const root = new URL('../browser-dist/', import.meta.url);
const types: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' };
const server = createServer(async (request, response) => {
  const name = new URL(request.url ?? '/', 'http://localhost').pathname.replace(/^\/+/, '') || 'index.html';
  if (!/^[\w.-]+$/.test(name)) { response.writeHead(400).end(); return; }
  try {
    const body = await readFile(new URL(name, root));
    response.writeHead(200, { 'content-type': types[name.split('.').pop() ?? ''] ?? 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const url = `http://127.0.0.1:${address.port}/`;

const browser = await chromium.launch({ executablePath: process.env.HB_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
await mkdir('artifacts', { recursive: true });
const errors: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  // A blocked inline style or script would surface here as a CSP console error.
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url);

  // The default pattern draws immediately: no preview click is needed.
  const steps = page.locator('#steps .step');
  await assert.doesNotReject(steps.nth(3).waitFor());
  assert.equal(await steps.count(), 4);
  assert.match(await page.locator('#trace').getAttribute('d') ?? '', /^M0 140 V/);
  assert.equal(await page.locator('#stat-period').innerText(), '4 秒');
  if (process.env.HB_EDITOR_SCREENSHOT) await page.screenshot({ path: process.env.HB_EDITOR_SCREENSHOT });

  // Full-pattern view repeats every cycle and marks the boundaries between them.
  await page.locator('#cycles').fill('3');
  await page.getByRole('radio', { name: '完整模式' }).check();
  assert.equal((await page.locator('#cycle-marks').getAttribute('d') ?? '').match(/M/g)?.length, 2);
  assert.equal(await page.locator('#stat-total').innerText(), '12 秒');

  // Stages can be added, validated inline, reordered, duplicated and removed.
  await page.getByRole('button', { name: '添加阶段' }).click();
  assert.equal(await steps.count(), 5);
  const lastTime = page.getByLabel('阶段 5 时长（毫秒）');
  await lastTime.fill('50');
  assert.equal(await page.locator('#status').getAttribute('data-tone'), 'error');
  assert.ok((await page.locator('#status').innerText()).includes('阶段 5'));
  assert.equal(await page.locator('#export-android').isDisabled(), true);
  await lastTime.fill('500');
  assert.equal(await page.locator('#export-android').isDisabled(), false);
  await lastTime.press('Alt+ArrowUp');
  assert.equal(await page.getByLabel('阶段 4 时长（毫秒）').inputValue(), '500');
  await page.getByRole('button', { name: '复制阶段 1' }).click();
  assert.equal(await steps.count(), 6);
  await page.getByRole('button', { name: '删除阶段 1' }).click();
  assert.equal(await steps.count(), 5);
  await page.getByLabel('阶段 1 强度（%）').press('ControlOrMeta+Enter');
  assert.equal(await steps.count(), 6);
  await page.getByLabel('阶段 2 强度（%）').press('Alt+Delete');
  assert.equal(await steps.count(), 5);

  // The Studio export satisfies the real library schema, including the generated id.
  const libraryDownload = page.waitForEvent('download');
  await page.keyboard.press('ControlOrMeta+s');
  const libraryFile = await libraryDownload; await libraryFile.saveAs('artifacts/editor-library.json');
  const library = librarySchema.parse(JSON.parse(await readFile('artifacts/editor-library.json', 'utf8')));
  const [exported] = library.patterns; assert.ok(exported && library.patterns.length === 1);
  assert.equal(exported.steps.length, 5); assert.equal(exported.cycles, 3);

  const androidDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Android 波形参数' }).click();
  const androidFile = await androidDownload; await androidFile.saveAs('artifacts/editor-android.json');
  const android = JSON.parse(await readFile('artifacts/editor-android.json', 'utf8'));
  assert.equal(android.timings.length, 15); assert.equal(android.repeat, -1);

  // A fixed example replaces the draft; the exported library can be opened again.
  await page.locator('#template-choice').selectOption('double');
  await page.getByRole('button', { name: '载入样例' }).click();
  assert.equal(await page.locator('#pattern-name').inputValue(), '双击提醒');
  assert.equal(await steps.count(), 4);
  await page.locator('#import-file').setInputFiles('artifacts/editor-library.json');
  await page.waitForFunction(() => document.querySelectorAll('#steps .step').length === 5);
  assert.equal(await page.locator('#cycles').inputValue(), '3');

  // Invalid files are refused with a message and leave the draft untouched.
  await page.locator('#import-file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
  await page.waitForFunction(() => document.querySelector('#status')?.getAttribute('data-tone') === 'error');
  assert.equal(await steps.count(), 5);

  // A multi-pattern library asks which pattern to edit.
  const many = { version: 1, preferences: { defaultIntensity: 20, defaultDurationMs: 1000 }, patterns: [
    { id: '00000000-0000-4000-8000-000000000001', name: '甲', cycles: 1, steps: [{ value: 5, durationMs: 100 }] },
    { id: '00000000-0000-4000-8000-000000000002', name: '乙', cycles: 2, steps: [{ value: 50, durationMs: 300 }, { value: 0, durationMs: 300 }] },
  ] };
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#pattern-name').fill('未导出的修改');
  await page.locator('#import-file').setInputFiles({ name: 'many.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(many)) });
  await page.locator('#import-dialog').waitFor();
  await page.locator('#import-choices label').nth(1).click();
  await page.getByRole('button', { name: '载入此模式' }).click();
  assert.equal(await page.locator('#pattern-name').inputValue(), '乙');
  assert.equal(await steps.count(), 2);

  // The draft survives a reload, and reset returns to the default pattern.
  await page.getByLabel('阶段 1 强度（%）').fill('42');
  await page.reload();
  assert.equal(await page.getByLabel('阶段 1 强度（%）').inputValue(), '42');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '重置' }).click();
  assert.equal(await steps.count(), 4);
  assert.equal(await page.locator('#pattern-name').inputValue(), '轻缓起伏');

  // Shortcuts panel, explicit dark appearance and a 390px layout without sideways scroll.
  await page.locator('h1').click();
  await page.keyboard.press('?');
  await page.locator('#shortcuts').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#theme-toggle').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'artifacts/editor-mobile-dark.png', fullPage: true });

  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile('artifacts/editor-result.json', JSON.stringify({ status: 'passed', hardwareAccess: false, scenarios: ['live-waveform', 'full-pattern-view', 'stage-editing', 'inline-validation', 'keyboard-shortcuts', 'studio-library-export-schema', 'android-export', 'fixed-example', 'library-reopen', 'invalid-file', 'multi-pattern-choice', 'draft-persistence', 'reset', 'dark-appearance', '390px-layout'], pageErrors: errors }, null, 2));
  console.log('Browser editor flow passed (static files only; no device or network).');
  await context.close();
} finally { await browser.close(); server.close(); }
