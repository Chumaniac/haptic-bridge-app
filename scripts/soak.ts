import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { createApp } from '../src/server/app.ts';
import { IntifaceAdapter } from '../src/adapters/intiface.ts';
import { fakeEngine } from '../test/fixtures/engine.ts';

// This developer check creates its own loopback protocol simulator. No target URL,
// Bluetooth device, control code, credential or manufacturer service is accepted.
const engine = await fakeEngine({ recordLimit: 64 });
const app = createApp({ factory: () => new IntifaceAdapter(engine.url) });
const url = await app.listen(0);
const bootstrap = await fetch(`${url}/api/session`); const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
const { csrf } = await bootstrap.json() as { csrf: string };
async function post(path: string, body: unknown = {}) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, 200, `local fixture route ${path}`); return result;
}
const abort = new AbortController(); let closing = false; let streamEndedEarly = false;
let keepalives = 0; let events = 0; let receivedBytes = 0;
let eventTask: Promise<void> | undefined;
const samples: { elapsedMs: number; heapUsed: number; rss: number }[] = [];
const latencies: number[] = [];
try {
  await post('connect', { mode: 'intiface' }); const armed = await post('arm', { id: '7' }); const epoch = armed.state.devices[0].epoch;
  const stream = await fetch(`${url}/api/events`, { headers: { Cookie: cookie }, signal: abort.signal }); assert.equal(stream.status, 200);
  eventTask = (async () => {
    const decoder = new TextDecoder(); let carry = '';
    try {
      for await (const chunk of stream.body!) {
        receivedBytes += chunk.length; carry += decoder.decode(chunk, { stream: true });
        const lines = carry.split('\n'); carry = lines.pop() ?? '';
        for (const line of lines) { if (line.startsWith('data:')) events++; if (line.startsWith(': keepalive')) keepalives++; }
        assert.ok(carry.length <= 65536);
      }
    } catch (error) { if (!closing) throw error; }
    finally { if (!closing) streamEndedEarly = true; }
  })();
  globalThis.gc?.(); const before = process.memoryUsage(); const cpu = process.cpuUsage(); const started = performance.now();
  let nextHeartbeat = started; let nextSample = started; let sequence = 0; let commands = 0;
  while (performance.now() - started < 30000) {
    assert.equal(streamEndedEarly, false);
    const tick = performance.now();
    await Promise.all([2, 5].map(feature => post('output', { id: '7', feature, value: .1, epoch, seq: ++sequence })));
    commands += 2; latencies.push(performance.now() - tick);
    if (performance.now() >= nextHeartbeat) { await post('heartbeat'); nextHeartbeat = performance.now() + 2000; }
    if (performance.now() >= nextSample) { globalThis.gc?.(); const usage = process.memoryUsage(); samples.push({ elapsedMs: performance.now() - started, heapUsed: usage.heapUsed, rss: usage.rss }); nextSample = performance.now() + 5000; }
    await wait(Math.max(0, 100 - (performance.now() - tick)));
  }
  const stopped = await post('stop'); assert.ok(stopped.state.devices.every((device: { armed: boolean; receipt: string }) => !device.armed && device.receipt === 'stopped'));
  assert.equal(app.hub.queueSize, 0); assert.ok(keepalives >= 1); assert.equal(streamEndedEarly, false);
  globalThis.gc?.(); const after = process.memoryUsage(); latencies.sort((a, b) => a - b);
  const result = { scope: 'owned-loopback-app-and-protocol-simulator-only', hardwareAccess: false, externalTargets: 0,
    elapsedMs: performance.now() - started, simulatedOutputCommands: commands, events, keepalives, receivedBytes,
    batchLatencyP50Ms: latencies[Math.floor(latencies.length * .5)], batchLatencyP99Ms: latencies[Math.floor(latencies.length * .99)],
    remainingQueue: app.hub.queueSize, retainedSimulatorMessages: engine.messages.length, cpuMicroseconds: process.cpuUsage(cpu),
    rssBefore: before.rss, rssAfter: after.rss, heapBefore: before.heapUsed, heapAfterGC: after.heapUsed, samples,
    limitation: '30-second local HTTP/WebSocket/SSE observation only; not physical BLE timing, manufacturer interoperability or long-term stability.' };
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/soak-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ elapsedMs: result.elapsedMs, simulatedOutputCommands: commands, keepalives, events, remainingQueue: result.remainingQueue }));
} finally {
  closing = true; abort.abort(); await eventTask?.catch(() => undefined); await app.close(); await engine.close();
}
