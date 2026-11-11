import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { ButtplugClient } from '@zendrex/buttplug.js';
import { chromium } from 'playwright';
import { createApp } from '../src/server/app.ts';

const exec = promisify(execFile);
const enginePath = new URL('../.tools/intiface-engine-5.0.4/intiface-engine', import.meta.url).pathname;
const pythonPath = new URL('../.tools/interop-venv/bin/python', import.meta.url).pathname;
const archivePath = new URL('../.tools/downloads/intiface-engine-v5.0.4-macos-arm64.zip', import.meta.url);
const expectedArchiveHash = '430fbea694cbbde60e567c2f8e01c297db040259f02e541a5bf3d2abdbdf3d0d';
const archive = await readFile(archivePath);
assert.equal(createHash('sha256').update(archive).digest('hex'), expectedArchiveHash);
await mkdir('artifacts', { recursive: true });
await mkdir('.tools/real-runtime', { recursive: true });
const results: { name: string; status: string; details?: unknown; error?: string }[] = [];

async function startEngine(label: string) {
  const serverName = `Haptic Bridge actual ${label}`;
  const args = ['--websocket-listen-address', '127.0.0.1:0', '--server-name', serverName, '--log', 'info'];
  // The reviewed release's hardware-manager switches default to false. No BLE,
  // serial, USB/dongle, gamepad, websocket device server, simulation or mDNS flag.
  const child = spawn(enginePath, args, { cwd: '.tools/real-runtime', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
  const pid = child.pid; assert.ok(pid);
  let logs = ''; let exited = false; let spawnError: Error | undefined;
  const exitedPromise = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve(); }));
  child.on('error', error => { spawnError = error; });
  const capture = (data: Buffer) => { logs = (logs + data.toString()).slice(-32768); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  async function stop() {
    if (!exited) {
      child.kill('SIGINT');
      const stopped = await Promise.race([exitedPromise.then(() => true), wait(4000, undefined, { ref: false }).then(() => false)]);
      if (!stopped) { child.kill('SIGTERM'); await exitedPromise; }
    }
    await writeFile(`artifacts/real-engine-${label}.log`, logs);
  }
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (spawnError) throw spawnError;
      if (exited) throw new Error(`Native engine exited before listening: ${logs.slice(-1000)}`);
      try {
        const { stdout } = await exec('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 1500 });
        const addresses = stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
        if (addresses.length) {
          assert.equal(addresses.length, 1);
          assert.match(addresses[0]!, /^127\.0\.0\.1:\d+$/);
          assert.ok(!logs.includes('Including Bluetooth') && !logs.includes('Including Serial') && !logs.includes('Including Simulated'));
          return { endpoint: `ws://${addresses[0]}`, serverName, pid, args, stop };
        }
      } catch (error) { if (error instanceof assert.AssertionError) throw error; }
      await wait(100);
    }
    throw new Error('Native engine did not expose its scoped loopback listener');
  } catch (error) { await stop(); throw error; }
}
async function runCase(name: string, work: () => Promise<unknown>) {
  try { results.push({ name, status: 'passed', details: await work() }); }
  catch (error) { results.push({ name, status: 'failed', error: error instanceof Error ? error.message : String(error) }); }
}

await runCase('actual-js-sdk-native-rust-engine', async () => {
  const engine = await startEngine('js');
  const client = new ButtplugClient(engine.endpoint, { clientName: 'Haptic Bridge actual JS interoperability', autoReconnect: false, requestTimeout: 2500 });
  try {
    await client.connect(); await client.requestDeviceList();
    assert.equal(client.serverInfo?.ServerName, engine.serverName);
    assert.equal(client.serverInfo?.ProtocolVersionMajor, 4);
    assert.equal(client.devices.length, 0); assert.equal(client.scanning, false);
    return { clientVersion: '0.5.0', serverInfo: client.serverInfo, deviceCount: client.devices.length, enginePid: engine.pid, engineArgs: engine.args };
  } finally { try { if (client.connected) await client.disconnect(); } finally { client.dispose(); await engine.stop(); } }
});
await runCase('official-python-sdk-native-rust-engine', async () => {
  const engine = await startEngine('python');
  try {
    const { stdout } = await exec(pythonPath, ['scripts/real_python_check.py', engine.endpoint, engine.serverName], { timeout: 15000, maxBuffer: 65536,
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONNOUSERSITE: '1' } });
    const result = JSON.parse(stdout); assert.equal(result.connected, true); assert.equal(result.disconnected, true); assert.equal(result.deviceCount, 0);
    return { ...result, enginePid: engine.pid, engineArgs: engine.args };
  } finally { await engine.stop(); }
});
await runCase('actual-product-browser-native-rust-engine', async () => {
  const engine = await startEngine('product');
  const app = createApp({ endpoint: engine.endpoint, webRoot: new URL('../dist/src/web/', import.meta.url) });
  const url = await app.listen(0);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.HB_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light' });
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message)); page.setDefaultTimeout(10000);
    await page.goto(url); assert.equal(await page.locator('#allow-scan').isChecked(), false);
    await page.getByRole('button', { name: '一键连接检查' }).click();
    await page.getByRole('heading', { name: '还需要完成设备配对' }).waitFor();
    const downloading = page.waitForEvent('download'); await page.getByRole('link', { name: '下载连接检查报告' }).click();
    await (await downloading).saveAs('artifacts/real-component-connection-report.json');
    const report = JSON.parse(await readFile('artifacts/real-component-connection-report.json', 'utf8'));
    assert.ok(report.steps.some((step: { id: string; result: string }) => step.id === 'transport' && step.result === 'passed'));
    assert.equal(report.devices.length, 0); assert.equal(report.outputAttempted, false); assert.equal(report.physicalVerified, false);
    assert.equal(await page.locator('#connection-status').innerText(), '已连接'); assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: 'artifacts/real-components-ui.png', fullPage: true });
    await page.getByRole('button', { name: '断开连接' }).click();
    await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent === '未连接');
    return { enginePid: engine.pid, engineArgs: engine.args, report, pageErrors, productFactory: 'production IntifaceAdapter (no injected fake)' };
  } finally { await browser?.close(); await app.close(); await engine.stop(); }
});

const report = { scope: 'actual-software-components-with-no-hardware-managers',
  nativeEngineVersion: '5.0.4', nativeArchiveSha256: expectedArchiveHash,
  sourceRelease: 'https://github.com/buttplugio/buttplug/releases/tag/intiface-engine-5.0.4',
  hardwareManagersEnabled: false, simulatedDevicesEnabled: false, hardwareScanningAttempted: false, physicalDevicesTested: 0,
  intifaceCentralGuiTested: false, lovenseApiImplemented: false, vendorCloudRequests: 0,
  status: results.every(result => result.status === 'passed') ? 'passed' : 'partial-or-failed', results };
await writeFile('artifacts/real-components-result.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, checks: results.map(({ name, status, error }) => ({ name, status, ...(error ? { error } : {}) })), physicalDevicesTested: 0 }));
if (report.status !== 'passed') process.exitCode = 1;
