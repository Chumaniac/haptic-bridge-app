import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { Dispatcher } from '../src/core/dispatcher.ts';
import { DemoAdapter } from '../src/adapters/demo.ts';
import { Hub } from '../src/core/hub.ts';
import { localEndpoint } from '../src/adapters/intiface.ts';
import { inspectInvitation, futurePairing } from '../src/extensions.ts';
import type { AdapterEvent } from '../src/contracts.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
test('a burst keeps only one pending value and stop discards it', async () => {
  const dispatcher = new Dispatcher(0); const gate = deferred(); const calls: number[] = [];
  const first = dispatcher.submit('a', 0, async () => { calls.push(0); await gate.promise; });
  const burst = Array.from({ length: 2000 }, (_, index) => dispatcher.submit('a', 0, async () => { calls.push(index + 1); }));
  assert.ok(dispatcher.size <= 2);
  const stop = dispatcher.barrier('a'); gate.resolve();
  await Promise.all([first, ...burst, stop]); assert.deepEqual(calls, [0]); assert.equal(dispatcher.size, 0);
  await assert.rejects(dispatcher.submit('a', 0, async () => undefined), { code: 'DISARMED' });
});
test('output requires owner, arming and current epoch; stale commands never execute', async t => {
  const adapter = new DemoAdapter(); const hub = new Hub(() => adapter, { interval: 0 }); t.after(() => hub.close());
  await hub.connect('alice', 'demo');
  await assert.rejects(hub.arm('bob', 'demo-a'), { code: 'NOT_OWNER' });
  await assert.rejects(hub.output('alice', { id: 'demo-a', feature: 0, value: .2, epoch: 1, seq: 1 }), { code: 'DISARMED' });
  await hub.arm('alice', 'demo-a'); const epoch = hub.snapshot().devices[0]!.epoch;
  await hub.output('alice', { id: 'demo-a', feature: 0, value: .2, epoch, seq: 2 });
  await assert.rejects(hub.output('alice', { id: 'demo-a', feature: 0, value: .3, epoch, seq: 1 }), { code: 'STALE' });
  await assert.rejects(hub.output('alice', { id: 'demo-a', feature: 9, value: .3, epoch, seq: 3 }), { code: 'CAPABILITY' });
  await assert.rejects(hub.output('alice', { id: 'demo-a', feature: 0, value: NaN, epoch, seq: 4 }), { code: 'RANGE' });
  await hub.stopDevice('demo-a');
  await hub.arm('alice', 'demo-a');
  await assert.rejects(hub.output('alice', { id: 'demo-a', feature: 0, value: .8, epoch, seq: 5 }), { code: 'DISARMED' });
  assert.equal(adapter.calls.filter(call => call.action === 'vibrate').length, 1);
});
test('control cannot be rearmed while a stop is pending', async t => {
  const gate = deferred();
  class SlowStop extends DemoAdapter { override async stop(id?: string) { if (id) await gate.promise; await super.stop(id); } }
  const hub = new Hub(() => new SlowStop()); t.after(() => hub.close());
  await hub.connect('alice', 'demo'); await hub.arm('alice', 'demo-a');
  const stopping = hub.stopDevice('demo-a'); await wait(1);
  try { await assert.rejects(hub.arm('alice', 'demo-a'), { code: 'STOPPING' }); }
  finally { gate.resolve(); await stopping; }
  assert.equal(hub.snapshot().devices[0]!.armed, false);
});
test('unexpected disconnection can be cleaned up and never restores arming', async t => {
  let adapter = new DemoAdapter(); const hub = new Hub(() => adapter); t.after(() => hub.close());
  await hub.connect('alice', 'demo'); await hub.arm('alice', 'demo-a');
  await adapter.disconnect(); assert.equal(hub.snapshot().phase, 'fault');
  assert.ok(hub.snapshot().devices.every(device => !device.armed));
  await hub.disconnect('alice'); adapter = new DemoAdapter();
  await hub.connect('alice', 'demo'); assert.ok(hub.snapshot().devices.every(device => !device.armed));
});
test('browser heartbeat loss stops the owned session and releases its resources', async t => {
  const adapter = new DemoAdapter(); const hub = new Hub(() => adapter, { heartbeatTimeout: 40 }); t.after(() => hub.close());
  await hub.connect('alice', 'demo'); await hub.arm('alice', 'demo-a');
  await wait(130); assert.equal(hub.snapshot().phase, 'idle'); assert.equal(hub.queueSize, 0);
  assert.ok(adapter.calls.some(call => call.action === 'stop' && call.id === 'demo-a'));
});
test('a changed device capability revokes its existing control grant', async t => {
  let notify!: (event: AdapterEvent) => void;
  class MutableAdapter extends DemoAdapter {
    override subscribe(listener: (event: AdapterEvent) => void) { notify = listener; return super.subscribe(listener); }
  }
  const hub = new Hub(() => new MutableAdapter()); t.after(() => hub.close());
  await hub.connect('alice', 'demo'); await hub.arm('alice', 'demo-a');
  const device = hub.snapshot().devices[0]!;
  notify({ type: 'devices', devices: [{ id: device.id, name: device.name, features: [{ index: 4, label: 'Replacement motor' }], otherCapabilities: [] }] });
  assert.equal(hub.snapshot().devices[0]!.armed, false);
  await assert.rejects(hub.output('alice', { id: device.id, feature: 4, value: .2, epoch: device.epoch, seq: 1 }), { code: 'DISARMED' });
});
test('an unconfirmed stop prevents rearming and connection diagnostics until a stop is acknowledged', async t => {
  let failStop = true;
  class StopFailure extends DemoAdapter { override async stop(id?: string) { if (id && failStop) throw new Error('fixture stop failure'); await super.stop(id); } }
  const hub = new Hub(() => new StopFailure()); t.after(() => hub.close());
  await hub.connect('owner', 'demo'); await hub.arm('owner', 'demo-a'); await hub.stopDevice('demo-a');
  assert.equal(hub.snapshot().devices[0]!.receipt, 'unconfirmed');
  await assert.rejects(hub.arm('owner', 'demo-a'), { code: 'STOP_UNCONFIRMED' });
  assert.throws(() => hub.beginDiagnostics('owner'), { code: 'STOP_UNCONFIRMED' });
  failStop = false; await hub.stopDevice('demo-a'); await hub.arm('owner', 'demo-a');
  assert.equal(hub.snapshot().devices[0]!.armed, true);
});
test('Intiface targets are numeric loopback addresses without credentials or arbitrary paths', () => {
  assert.equal(localEndpoint('ws://127.0.0.1:12345'), 'ws://127.0.0.1:12345/');
  for (const input of ['ws://example.com', 'ws://localhost:12345', 'ws://127.0.0.1.evil.com', 'ws://user:pass@127.0.0.1', 'ws://127.0.0.1/path', 'file:///tmp/a']) assert.throws(() => localEndpoint(input));
});
test('invitation inspection is offline and never assumes numeric codes identify a provider', async () => {
  assert.deepEqual(inspectInvitation('000123'), { kind: 'needs-provider' });
  assert.deepEqual(inspectInvitation('000123', 'lovense'), { kind: 'provider-code', provider: 'lovense' });
  assert.deepEqual(inspectInvitation('https://c.lovense.com/example'), { kind: 'provider-link', provider: 'lovense' });
  for (const url of ['https://c.lovense.com.evil.com/x', 'javascript:alert(1)', 'https://secret@c.lovense.com/x', 'https://127.0.0.1/x']) assert.throws(() => inspectInvitation(url));
  await assert.rejects(futurePairing.redeem('000123', 'test'), { code: 'NOT_IMPLEMENTED' });
});
