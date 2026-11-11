import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { DemoAdapter } from '../src/adapters/demo.ts';
import { Hub } from '../src/core/hub.ts';
import type { AdapterEvent } from '../src/contracts.ts';

let liveSubscriptions = 0; let outputCommands = 0; let stopCommands = 0; let adaptersCreated = 0; let lastAdapter: DemoAdapter | undefined;
class MeasuredDemo extends DemoAdapter {
  override async vibrate(id: string, feature: number, value: number) { outputCommands++; await super.vibrate(id, feature, value); }
  override async stop(id?: string) { stopCommands++; await super.stop(id); }
  override subscribe(listener: (event: AdapterEvent) => void) {
    liveSubscriptions++; const remove = super.subscribe(listener); let removed = false;
    return () => { if (!removed) { removed = true; liveSubscriptions--; remove(); } };
  }
}
const hub = new Hub(() => { adaptersCreated++; lastAdapter = new MeasuredDemo(); return lastAdapter; }, { interval: 0 });
const slots = [{ id: 'demo-a', feature: 0 }, { id: 'demo-a', feature: 1 }, { id: 'demo-b', feature: 0 }];
await hub.connect('isolated-stress-owner', 'demo');
for (const id of ['demo-a', 'demo-b']) await hub.arm('isolated-stress-owner', id);
globalThis.gc?.(); const before = process.memoryUsage(); const cpu = process.cpuUsage(); const started = performance.now();
let producerUpdates = 0; let peakQueue = 0; let stopBarriers = 0;
const heapSamples: number[] = [];
try {
  for (let batch = 0; batch < 200; batch++) {
    const epochs = new Map(hub.snapshot().devices.map(device => [device.id, device.epoch]));
    const jobs: Promise<unknown>[] = [];
    for (let index = 0; index < 5000; index++) {
      const slot = slots[index % slots.length]!;
      jobs.push(hub.output('isolated-stress-owner', { ...slot, value: .2, epoch: epochs.get(slot.id)!, seq: ++producerUpdates }));
      peakQueue = Math.max(peakQueue, hub.queueSize);
    }
    const stopped = batch % 20 === 19 ? hub.stopAll() : null;
    await Promise.all(jobs);
    if (stopped) {
      await stopped; stopBarriers++;
      assert.equal(hub.queueSize, 0); assert.ok(hub.snapshot().devices.every(device => !device.armed));
      for (const id of ['demo-a', 'demo-b']) await hub.arm('isolated-stress-owner', id);
    }
    hub.heartbeat('isolated-stress-owner');
    assert.ok(peakQueue <= slots.length * 2);
    if (batch % 10 === 9) { globalThis.gc?.(); heapSamples.push(process.memoryUsage().heapUsed); }
  }
  await hub.stopAll(); const finalCommands = outputCommands; await wait(10);
  assert.equal(outputCommands, finalCommands); assert.equal(hub.queueSize, 0);
  await hub.disconnect(); assert.equal(liveSubscriptions, 0);
  for (let cycle = 0; cycle < 300; cycle++) {
    await hub.connect('isolated-stress-owner', 'demo');
    await Promise.all([hub.arm('isolated-stress-owner', 'demo-a'), hub.arm('isolated-stress-owner', 'demo-a')]);
    const epoch = hub.snapshot().devices[0]!.epoch;
    await hub.output('isolated-stress-owner', { id: 'demo-a', feature: 0, value: .1, epoch, seq: 1 });
    await Promise.all([hub.stopAll(), hub.stopAll()]);
    await Promise.all([hub.disconnect(), hub.disconnect()]);
    assert.equal(liveSubscriptions, 0); assert.equal(hub.queueSize, 0);
  }
  globalThis.gc?.(); const after = process.memoryUsage();
  const result = { scope: 'synthetic-in-process-only', hardwareAccess: false, networkRequests: 0,
    producerUpdates, simulatedOutputCommands: outputCommands, simulatedStopCommands: stopCommands, stopBarriers,
    lifecycleCycles: 300, adaptersCreated, liveSubscriptions, peakQueue, remainingQueue: hub.queueSize,
    retainedLastAdapterCalls: lastAdapter?.calls.length, elapsedMs: performance.now() - started,
    cpuMicroseconds: process.cpuUsage(cpu), rssBefore: before.rss, rssAfter: after.rss,
    heapBefore: before.heapUsed, heapAfterGC: after.heapUsed, heapSamplesAfterGC: heapSamples,
    limitation: 'Producer bursts are coalesced; the million updates are not a million hardware commands. No code guessing, actual BLE, manufacturer app or cloud testing.' };
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/stress-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ producerUpdates, simulatedOutputCommands: outputCommands, lifecycleCycles: 300, peakQueue, remainingQueue: hub.queueSize, liveSubscriptions, elapsedMs: result.elapsedMs }));
} finally { await hub.close(); }
