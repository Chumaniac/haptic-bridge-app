import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Hub } from '../src/core/hub.ts';
import { DemoAdapter } from '../src/adapters/demo.ts';
const adapter = new DemoAdapter(); const hub = new Hub(() => adapter, { interval: 0 });
await hub.connect('load-fixture', 'demo'); await hub.arm('load-fixture', 'demo-a');
const epoch = hub.snapshot().devices[0]!.epoch;
globalThis.gc?.();
const before = process.memoryUsage(); const cpu = process.cpuUsage(); const start = performance.now();
let peakQueue = 0; const heapSamples: number[] = [];
try {
  for (let batch = 0; batch < 20; batch++) {
    const jobs: Promise<unknown>[] = [];
    for (let i = 1; i <= 2000; i++) {
      jobs.push(hub.output('load-fixture', { id: 'demo-a', feature: 0, value: .2, epoch, seq: batch * 2000 + i }));
      peakQueue = Math.max(peakQueue, hub.queueSize);
    }
    await Promise.all(jobs); hub.heartbeat('load-fixture'); globalThis.gc?.(); heapSamples.push(process.memoryUsage().heapUsed);
  }
  await hub.stopAll(); assert.equal(hub.queueSize, 0); assert.ok(peakQueue <= 2);
  const elapsedMs = performance.now() - start; const cpuUsed = process.cpuUsage(cpu); const after = process.memoryUsage();
  const result = { hardwareAccess: false, inputUpdates: 40000, peakQueue, remainingQueue: hub.queueSize,
    elapsedMs, cpuMicroseconds: cpuUsed, rssBefore: before.rss, rssAfter: after.rss,
    heapSamplesAfterGC: heapSamples, retainedDemoCalls: adapter.calls.length,
    limitation: 'Synthetic burst/coalescing only; not BLE latency, sustained physical-device behavior or a before/after optimization comparison.' };
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/load-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ inputUpdates: result.inputUpdates, peakQueue, remainingQueue: result.remainingQueue, elapsedMs }));
} finally { await hub.close(); }
