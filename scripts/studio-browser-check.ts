import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio } from '../src/studio/server.ts';

const output = 'artifacts/studio'; await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'haptic-studio-browser-')); const file = join(directory, 'studio.json');
let app = await createStudio({ file, webRoot: new URL('../dist/src/studio/web/', import.meta.url) });
let url = await app.listen(0);
const browser = await chromium.launch({ executablePath: process.env.HB_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light' });
const errors: string[] = []; const externalRequests: string[] = []; let sockets = 0; const scenarios: string[] = [];
const page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message)); page.on('websocket', () => sockets++);
await context.route('**/*', async route => { const request = new URL(route.request().url()); if (request.hostname !== '127.0.0.1') { externalRequests.push(request.origin); await route.abort(); } else await route.continue(); });
const state = () => app.core.snapshot('test-observer');
async function until(check: () => boolean, description: string, timeout = 7000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`); await new Promise(resolve => setTimeout(resolve, 40)); }
}
async function settle(): Promise<void> { await page.waitForFunction(() => !document.querySelector('#pattern-form')?.hasAttribute('inert')); }
async function confirm(label: string): Promise<void> { await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); await settle(); }
const single = page.locator('[data-device="virtual-one"]'); const duo = page.locator('[data-device="virtual-duo"]');
const patternName = '<b>本地验收</b>';
try {
  // Navigation help stays usable while the local service is still responding.
  let releaseSession: () => void = () => {};
  let sessionRequested = false;
  const delayedSession = new Promise<void>(resolve => { releaseSession = resolve; });
  await page.route('**/api/session', async route => { sessionRequested = true; await delayedSession; await route.continue(); });
  try {
    await page.goto(url, { waitUntil: 'commit' });
    await until(() => sessionRequested, 'first local session request');
    await page.getByRole('button', { name: '使用引导', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#studio-guide') as HTMLDetailsElement).open, undefined, { timeout: 800 });
    assert.equal(state().control.busy, false);
    assert.ok(state().devices.every(item => !item.connected && !item.armed));
    scenarios.push('guide-opens-before-session-without-control');
  } finally {
    const response = page.waitForResponse(response => response.url() === `${url}/api/session`);
    releaseSession(); await response; await page.waitForLoadState('networkidle');
    await page.unroute('**/api/session');
  }
  const sessionResponse = page.waitForResponse(response => response.url() === `${url}/api/session`);
  await page.goto(url); const ownerSession = await (await sessionResponse).json() as { session: string; csrf: string };
  await page.getByText('只读状态，获取控制权后开始', { exact: true }).waitFor();
  assert.ok(state().devices.every(item => !item.connected && !item.armed && item.values.every(value => value === 0)));
  scenarios.push('startup-no-connect-no-output');
  await page.getByRole('button', { name: '获取本地控制权', exact: true }).click();
  await single.getByRole('button', { name: '连接虚拟设备', exact: true }).click();
  assert.equal(await single.getByRole('slider').isDisabled(), true);
  await single.getByRole('button', { name: '启用控制', exact: true }).click();
  const slider = single.getByRole('slider');
  await page.waitForFunction(() => !(document.querySelector('[data-device="virtual-one"] input[type="range"]') as HTMLInputElement)?.disabled);
  await slider.focus(); await slider.press('ArrowRight'); await slider.press('ArrowRight');
  await until(() => state().devices[0]!.values[0] === 2, 'keyboard output actually reaches virtual state');
  scenarios.push('explicit-claim-connect-arm-keyboard-output');
  await duo.getByRole('button', { name: '连接虚拟设备', exact: true }).click(); await duo.getByRole('button', { name: '启用控制', exact: true }).click();
  const second = duo.getByRole('slider').nth(1);
  await page.waitForFunction(() => !(document.querySelectorAll('[data-device="virtual-duo"] input[type="range"]')[1] as HTMLInputElement)?.disabled);
  await second.focus(); for (let step = 0; step < 37; step++) await second.press('ArrowRight');
  await until(() => state().devices[1]!.values[1] === 37, 'second virtual channel');
  assert.equal(state().devices[1]!.values[0], 0); assert.equal(state().devices[0]!.values[0], 2);
  scenarios.push('multiple-devices-independent-channels');

  await page.locator('#pattern-name').fill(patternName);
  await page.getByRole('spinbutton', { name: '第 1 步强度', exact: true }).fill('15');
  await page.getByRole('spinbutton', { name: '第 1 步时长（秒）', exact: true }).fill('1.5');
  await page.getByRole('button', { name: '添加步骤', exact: true }).click();
  await page.getByRole('spinbutton', { name: '第 2 步强度', exact: true }).fill('45');
  await page.getByRole('spinbutton', { name: '第 2 步时长（秒）', exact: true }).fill('0.5');
  await page.getByRole('button', { name: '第 2 步上移', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: '第 1 步强度', exact: true }).inputValue(), '45');
  await page.getByRole('button', { name: '添加步骤', exact: true }).click(); await page.getByRole('button', { name: '第 3 步删除', exact: true }).click();
  await page.getByRole('button', { name: '保存模式', exact: true }).click(); await settle();
  await until(() => app.store.snapshot().data.patterns.some(item => item.name === patternName), 'pattern durable save');
  const savedId = app.store.snapshot().data.patterns.find(item => item.name === patternName)!.id;
  assert.equal(await page.locator('#patterns b, #history b').count(), 0, 'user content must remain text');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).data.patterns.at(-1).name, patternName);
  scenarios.push('editor-add-reorder-remove-steps-save-to-real-file', 'markup-name-rendered-as-text');
  await page.locator('#pattern-cycles').fill('2'); await page.getByRole('button', { name: '保存模式', exact: true }).click(); await settle();
  await until(() => app.store.snapshot().data.patterns.find(item => item.id === savedId)?.cycles === 2, 'edit existing pattern');
  assert.equal(app.store.snapshot().data.patterns.length, 3); scenarios.push('edit-existing-pattern-without-duplicating');

  await page.locator('#play-pattern').selectOption(savedId);
  await page.getByRole('button', { name: '开始播放', exact: true }).click();
  await until(() => state().playback?.status === 'playing', 'mode start');
  assert.equal(await slider.isDisabled(), true);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await until(() => state().playback?.status === 'paused', 'mode pause');
  const paused = state().playback!.elapsedMs; assert.equal(state().devices[0]!.values[0], 0);
  await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(state().playback!.elapsedMs, paused);
  await page.getByRole('button', { name: '继续播放', exact: true }).click();
  await until(() => state().lastPlayback === 'completed', 'mode completion', 7000);
  await page.waitForFunction(() => document.querySelector('#play-status')?.textContent?.includes('播放完成') && document.querySelector('#play-time')?.textContent === '本次播放已完成');
  assert.equal(state().devices[0]!.values[0], 0); assert.equal(state().devices[0]!.armed, false);
  scenarios.push('playback-pause-zero-resume-complete-and-lock');
  await single.getByRole('button', { name: '启用控制', exact: true }).click(); await page.getByRole('button', { name: '开始播放', exact: true }).click();
  await page.getByRole('button', { name: '取消播放', exact: true }).click(); await until(() => state().playback === null && !state().devices[0]!.armed, 'mode cancel');
  scenarios.push('cancel-invalidates-playback');
  await single.getByRole('button', { name: '启用控制', exact: true }).click(); await slider.focus(); await slider.press('ArrowRight');
  await page.getByRole('button', { name: '急停全部', exact: true }).click();
  await until(() => state().devices.every(item => !item.armed && item.values.every(value => value === 0)), 'global emergency stop');
  await new Promise(resolve => setTimeout(resolve, 250)); assert.ok(state().devices.every(item => item.values.every(value => value === 0)));
  scenarios.push('emergency-stop-clears-pending-manual-output');

  await single.getByRole('button', { name: '启用控制', exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector('[data-device="virtual-one"] input[type="range"]') as HTMLInputElement)?.disabled);
  let releaseDelayed: () => void = () => {}; let held = false;
  const delayed = new Promise<void>(resolve => { releaseDelayed = resolve; });
  await page.route('**/api/output', async route => { held = true; await delayed; await route.continue(); });
  await slider.focus(); await slider.press('ArrowRight'); await until(() => held, 'delayed pre-stop command');
  await page.getByRole('button', { name: '急停全部', exact: true }).click();
  await until(() => state().devices.every(item => !item.armed && item.values.every(value => value === 0)), 'stop before delayed command');
  const delayedResponse = page.waitForResponse(response => response.url().endsWith('/api/output'));
  releaseDelayed(); assert.equal((await delayedResponse).status(), 409);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await page.getByRole('alert').isVisible(), false, 'expected rejection of a stale pre-stop command must not replace a successful stop with an error');
  assert.ok(state().devices.every(item => item.values.every(value => value === 0)));
  await page.unroute('**/api/output'); scenarios.push('late-pre-stop-request-cannot-change-stop-result');

  await single.getByRole('button', { name: '断开', exact: true }).click(); await until(() => !state().devices[0]!.connected, 'virtual disconnection');
  let releaseReconnect: () => void = () => {};
  const reconnectDelay = new Promise<void>(resolve => { releaseReconnect = resolve; });
  await page.route('**/api/device', async route => { const response = await route.fetch(); await reconnectDelay; await route.fulfill({ response }); }, { times: 1 });
  await single.getByRole('button', { name: '连接虚拟设备', exact: true }).click(); await until(() => state().devices[0]!.connected, 'virtual reconnection');
  try {
    assert.equal(await page.locator('#preferences-form').evaluate(element => (element as HTMLFormElement).inert), true, 'pending reconnect keeps preference edits blocked');
    assert.equal(await page.getByRole('button', { name: '新建', exact: true }).isDisabled(), true);
  } finally { releaseReconnect(); }
  // Server acceptance precedes client readiness; fill only after the owned action settles.
  await settle();
  await page.waitForFunction(() => !(document.querySelector('#preferences-form') as HTMLFormElement).inert);
  await page.unroute('**/api/device');
  assert.equal(state().devices[0]!.armed, false); assert.equal(state().devices[0]!.values[0], 0);
  scenarios.push('disconnect-and-reconnect-stays-disarmed');

  const earlierLibrary = structuredClone(app.store.snapshot());
  await page.locator('#default-intensity').fill('33'); await page.locator('#default-duration').fill('0.7');
  assert.equal(await page.locator('#default-intensity').inputValue(), '33');
  assert.equal(await page.locator('#default-duration').inputValue(), '0.7');
  let releasePreferences: () => void = () => {}; let preferencesHeld = false; let submittedPreferences: unknown;
  const preferencesDelay = new Promise<void>(resolve => { releasePreferences = resolve; });
  await page.route('**/api/preferences', async route => { submittedPreferences = route.request().postDataJSON().preferences; const response = await route.fetch(); preferencesHeld = true; await preferencesDelay; await route.fulfill({ response }); });
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await until(() => preferencesHeld, 'preference write accepted before delayed response');
  try { assert.deepEqual(submittedPreferences, { defaultIntensity: 33, defaultDurationMs: 700 }); assert.equal(await page.getByRole('button', { name: '新建', exact: true }).isDisabled(), true, 'new pattern cannot use old defaults while preferences are being saved'); }
  finally { releasePreferences(); }
  await page.getByText('偏好已保存，新建步骤时生效。', { exact: true }).waitFor(); await settle();
  await page.unroute('**/api/preferences');
  await page.evaluate(() => {
    const trace = window as unknown as Window & { studioVersions: string[]; studioVersionObserver: MutationObserver };
    trace.studioVersions = [];
    trace.studioVersionObserver = new MutationObserver(records => {
      for (const record of records) for (const added of record.addedNodes) trace.studioVersions.push(added.textContent ?? '');
    });
    trace.studioVersionObserver.observe(document.querySelector('#library-summary')!, { childList: true, subtree: true });
  });
  let earlierReadDelivered = false;
  await page.route('**/api/library', async route => {
    await route.fulfill({ json: earlierLibrary }); earlierReadDelivered = true;
  }, { times: 1 });
  await page.route('**/api/state', async route => {
    const response = await route.fetch(); const data = await response.json();
    await route.fulfill({ response, json: { ...data, revision: earlierLibrary.revision } });
  }, { times: 1 });
  await until(() => earlierReadDelivered, 'earlier library snapshot delivered after preference save');
  await page.waitForRequest(request => request.url().endsWith('/api/state'));
  const versions = await page.evaluate(() => {
    const trace = window as unknown as Window & { studioVersions: string[]; studioVersionObserver: MutationObserver };
    trace.studioVersionObserver.disconnect(); return trace.studioVersions;
  });
  assert.ok(!versions.some(value => value.includes(`资料版本 ${earlierLibrary.revision} ·`)), 'late library response cannot roll back saved preferences');
  assert.deepEqual(app.store.snapshot().data.preferences, { defaultIntensity: 33, defaultDurationMs: 700 });
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('#steps input') as HTMLInputElement)?.value === '33');
  assert.equal(await page.getByRole('spinbutton', { name: '第 1 步强度', exact: true }).inputValue(), '33');
  assert.equal(await page.getByRole('spinbutton', { name: '第 1 步时长（秒）', exact: true }).inputValue(), '0.7');
  scenarios.push('preferences-persist-and-initialize-new-steps');
  const libraryDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出模式库与设置', exact: true }).click();
  await (await libraryDownload).saveAs(`${output}/exported-library.json`); await settle();
  const exported = JSON.parse(await readFile(`${output}/exported-library.json`, 'utf8')) as import('../src/studio/schema.ts').Library;
  assert.equal(exported.patterns.length, 3); assert.equal(exported.preferences.defaultIntensity, 33); scenarios.push('browser-library-file-download');
  const diagnosticDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出脱敏诊断', exact: true }).click();
  await (await diagnosticDownload).saveAs(`${output}/diagnostics.json`); await settle();
  const diagnostics = await readFile(`${output}/diagnostics.json`, 'utf8');
  assert.ok(![patternName, ownerSession.csrf, ownerSession.session].some(value => diagnostics.includes(value)));
  assert.equal(JSON.parse(diagnostics).hardwareAccess, false); scenarios.push('redacted-diagnostics-download');

  await page.locator('#patterns').selectOption(savedId); await page.getByRole('button', { name: '载入模式', exact: true }).click();
  await page.getByRole('button', { name: '删除已存模式', exact: true }).click(); await confirm('取消');
  assert.equal(app.store.snapshot().data.patterns.length, 3);
  await page.getByRole('button', { name: '删除已存模式', exact: true }).click(); await confirm('删除模式');
  await until(() => app.store.snapshot().data.patterns.length === 2, 'confirmed deletion'); scenarios.push('delete-confirm-and-cancel');
  const beforeInvalid = await readFile(file, 'utf8');
  await page.locator('#import-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...exported, token: 'synthetic-rejected-field' })) });
  await page.getByRole('alert').waitFor(); assert.equal(await readFile(file, 'utf8'), beforeInvalid);
  scenarios.push('invalid-import-preserves-saved-file');
  const importFile = { name: 'library.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) };
  await page.locator('#import-file').setInputFiles(importFile); await confirm('取消'); assert.equal(app.store.snapshot().data.patterns.length, 2);
  await page.locator('#import-file').setInputFiles(importFile); await confirm('确认导入并替换');
  await until(() => app.store.snapshot().data.patterns.length === 3, 'confirmed import'); scenarios.push('import-preview-cancel-and-confirm');
  await page.getByRole('button', { name: '恢复默认偏好', exact: true }).click(); await confirm('恢复默认');
  await until(() => app.store.snapshot().data.preferences.defaultIntensity === 20, 'reset preferences');
  assert.equal(app.store.snapshot().data.patterns.length, 3); scenarios.push('reset-preferences-retains-pattern-library');

  await page.locator('#patterns').selectOption(savedId); await page.getByRole('button', { name: '载入模式', exact: true }).click();
  await page.getByRole('button', { name: '另存为新模式', exact: true }).click(); await page.getByRole('button', { name: '保存模式', exact: true }).click(); await settle();
  await until(() => app.store.snapshot().data.patterns.length === 4, 'duplicate saved as a new pattern');
  scenarios.push('duplicate-pattern-creates-independent-saved-copy');
  await page.locator('#pattern-name').fill('应当保留的未保存草稿');
  await page.locator('#patterns').selectOption(savedId); await page.getByRole('button', { name: '载入模式', exact: true }).click(); await confirm('取消');
  assert.equal(await page.locator('#pattern-name').inputValue(), '应当保留的未保存草稿');
  await page.getByRole('button', { name: '载入模式', exact: true }).click(); await confirm('替换草稿');
  assert.equal(await page.locator('#pattern-name').inputValue(), patternName); scenarios.push('unsaved-draft-replacement-requires-confirmation');
  await page.locator('#pattern-name').fill('冲突草稿');
  const concurrent = app.store.snapshot(); const changedPattern = { ...concurrent.data.patterns.find(item => item.id === savedId)!, name: '并发请求保存的版本' };
  const concurrentResponse = await context.request.post(`${url}/api/library/save`, { headers: { origin: url, 'x-studio-session': ownerSession.session, 'x-csrf-token': ownerSession.csrf }, data: { revision: concurrent.revision, pattern: changedPattern } });
  assert.equal(concurrentResponse.status(), 200);
  await page.waitForFunction(revision => document.querySelector('#library-summary')?.textContent?.includes(`资料版本 ${revision}`), concurrent.revision + 1);
  assert.equal(await page.locator('#pattern-name').inputValue(), '冲突草稿');
  await page.getByRole('button', { name: '保存模式', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '内容已被其他窗口修改' }).waitFor();
  assert.equal(app.store.snapshot().data.patterns.find(item => item.id === savedId)!.name, changedPattern.name);
  assert.equal(await page.locator('#pattern-name').inputValue(), '冲突草稿');
  await page.getByRole('button', { name: '另存为新模式', exact: true }).click(); await page.getByRole('button', { name: '保存模式', exact: true }).click(); await settle();
  await until(() => app.store.snapshot().data.patterns.length === 5, 'conflicted draft rescued as a new pattern');
  scenarios.push('concurrent-edit-conflict-preserves-file-and-draft');

  await page.getByRole('link', { name: '品牌资料', exact: true }).click();
  await page.locator('#catalog-search').fill('小怪兽'); assert.ok((await page.locator('#catalog-results').innerText()).includes('MonsterPub'));
  await page.locator('#catalog-search').fill('Lovense'); assert.ok((await page.locator('#catalog-results').innerText()).includes('本工作台未接入'));
  assert.ok((await page.locator('#catalog-results').innerText()).includes('蓝牙 BLE'));
  await page.locator('#catalog-search').fill('123456'); assert.equal(await page.locator('#catalog-results article').count(), 0);
  await page.locator('#catalog-search').fill('__unknown_model__'); assert.ok((await page.locator('#catalog-results').innerText()).includes('没有匹配资料'));
  await page.locator('#catalog-search').fill(''); scenarios.push('brand-chinese-search-software-mapping-numeric-rejection-empty-state');
  assert.equal(await page.locator('#catalog-results article').count(), 6);
  await page.getByRole('button', { name: '显示更多资料', exact: true }).click(); assert.equal(await page.locator('#catalog-results article').count(), 12);
  scenarios.push('catalog-pagination');

  const guestResponse = await context.request.get(`${url}/api/session`); const guest = await guestResponse.json() as { session: string; csrf: string };
  const guestMutation = await context.request.post(`${url}/api/control`, { headers: { origin: url, 'x-studio-session': guest.session, 'x-csrf-token': guest.csrf }, data: { action: 'claim' } });
  assert.equal(guestMutation.status(), 409); scenarios.push('second-page-session-cannot-take-control');
  await page.locator('#catalog-search').fill('Lovense');
  await page.evaluate(async () => { scrollTo(0, 0); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#settings').scrollIntoViewIfNeeded();
  const stopBounds = await page.locator('#stop-all').boundingBox(); assert.ok(stopBounds && stopBounds.y >= 0 && stopBounds.y + stopBounds.height <= 844);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(async () => { scrollTo(0, 0); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 320, height: 720 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const stepTargets = await page.locator('#steps .step-actions button').evaluateAll(buttons => buttons.map(button => { const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height }; }));
  assert.ok(stepTargets.length > 0 && stepTargets.every(rect => rect.width >= 44 && rect.height >= 44), 'mobile step actions retain a 44px touch target');
  scenarios.push('390px-and-320px-no-overflow-sticky-emergency-stop');

  await single.getByRole('button', { name: '启用控制', exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector('[data-device="virtual-one"] input[type="range"]') as HTMLInputElement)?.disabled);
  await slider.focus(); await slider.press('ArrowRight'); await until(() => state().devices[0]!.values[0] === 1, 'output before page-hide check');
  // Playwright keeps its pages visible. Supply only the visibility input; actual HTTP cleanup is unmocked.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(() => !state().control.busy, 'visibility-triggered release');
  assert.ok(state().devices.every(device => !device.armed && device.values.every(value => value === 0)));
  await page.evaluate(() => { Reflect.deleteProperty(document, 'hidden'); document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByRole('button', { name: '获取本地控制权', exact: true }).waitFor();
  assert.equal(state().control.busy, false); scenarios.push('emulated-page-hidden-releases-control-without-resume');

  await page.getByRole('button', { name: '获取本地控制权', exact: true }).click();
  await single.getByRole('button', { name: '启用控制', exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector('[data-device="virtual-one"] input[type="range"]') as HTMLInputElement)?.disabled);
  await slider.focus(); await slider.press('ArrowRight'); await until(() => state().devices[0]!.values[0] === 1, 'output before network outage');
  await context.setOffline(true); await page.getByRole('button', { name: '重新连接本地服务', exact: true }).waitFor();
  assert.equal(await slider.isDisabled(), true);
  await until(() => !state().control.busy, 'real wall-clock heartbeat timeout', 10000);
  assert.ok(state().devices.every(device => !device.armed && device.values.every(value => value === 0)));
  await context.setOffline(false); await page.getByRole('button', { name: '重新连接本地服务', exact: true }).click();
  await page.getByText('只读状态，获取控制权后开始', { exact: true }).waitFor();
  assert.equal(state().control.busy, false); scenarios.push('network-outage-disables-ui-and-real-heartbeat-timeout-cleans-server');
  await page.getByRole('button', { name: '获取本地控制权', exact: true }).click();

  await page.getByRole('button', { name: '释放控制权', exact: true }).click(); await until(() => !state().control.busy, 'explicit release');
  assert.ok(state().devices.every(item => !item.armed && item.values.every(value => value === 0)));
  scenarios.push('release-clears-outputs-and-permissions');
  await app.close(); app = await createStudio({ file, webRoot: new URL('../dist/src/studio/web/', import.meta.url) }); url = await app.listen(0);
  await page.goto(url); await page.getByText('只读状态，获取控制权后开始', { exact: true }).waitFor();
  assert.equal(app.store.snapshot().data.patterns.length, 5); assert.equal(app.store.snapshot().data.preferences.defaultIntensity, 20);
  assert.ok(state().devices.every(item => !item.connected && !item.armed && item.values.every(value => value === 0)));
  scenarios.push('server-restart-retains-library-without-resuming-devices');
  assert.equal(errors.length, 0, errors.join('\n')); assert.equal(externalRequests.length, 0); assert.equal(sockets, 0);
  await writeFile(`${output}/browser-result.json`, JSON.stringify({ status: 'passed', scope: 'simulation-only local studio', scenarios, scenarioCount: scenarios.length, visibilityInput: 'emulated document.hidden; cleanup uses actual HTTP', externalRequests: 0, webSockets: sockets, hardwareAccess: false, pageErrors: errors }, null, 2));
  console.log(`Local Studio browser acceptance passed (${scenarios.length} scenarios; virtual devices only).`);
} catch (error) {
  await page.screenshot({ path: `${output}/failure-${Date.now()}.png`, fullPage: true }).catch(() => {});
  await writeFile(`${output}/failure-${Date.now()}.json`, JSON.stringify({ message: String(error), completedScenarios: scenarios, pageErrors: errors, body: await page.locator('body').innerText() }, null, 2));
  throw error;
} finally { await context.close(); await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
