import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { readCatalog, vendorPlan, recognizeVendor } from '../src/catalog.ts';
import { Diagnostics } from '../src/diagnostics.ts';
import { Hub } from '../src/core/hub.ts';
import { DemoAdapter } from '../src/adapters/demo.ts';

test('every public protocol record is inventoried without becoming a hardware acceptance claim', () => {
  const catalog = readCatalog(); assert.equal(catalog.protocolEntries, catalog.protocols.length);
  const known = new Set(catalog.protocols.map(item => item.id));
  for (const item of catalog.protocols) { assert.ok(item.id); assert.ok(Array.isArray(item.models)); }
  for (const brand of catalog.profiles) {
    const plan = vendorPlan(catalog, brand.id); assert.equal(plan.connector, 'intiface-v4'); assert.equal(plan.evidence, 'catalog-only');
    for (const id of brand.protocolIds) assert.ok(known.has(id), `${brand.id}/${id}`);
  }
  assert.equal(catalog.hardwareVerified, false);
  assert.ok(vendorPlan(catalog, 'monsterpub').guidance.some(line => line.includes('握手')));
  assert.ok(vendorPlan(catalog, 'satisfyer').guidance.some(line => line.includes('广播')));
  assert.equal(recognizeVendor(catalog, 'Lovense Lush'), 'lovense');
  assert.equal(recognizeVendor(catalog, 'WeVibe Chorus'), 'we-vibe');
  assert.equal(recognizeVendor(catalog, 'Galaku Panty Vib'), 'galaku');
  assert.equal(recognizeVendor(catalog, 'Unknown device'), null);
  assert.throws(() => vendorPlan(catalog, 'https://attacker.invalid'));
});
test('one click connects, reads capabilities and reports pending hardware evidence without output', async t => {
  const adapter = new DemoAdapter(); const hub = new Hub(() => adapter); t.after(() => hub.close());
  const diagnostics = new Diagnostics(hub, readCatalog());
  const report = await diagnostics.run('owner', { mode: 'demo', vendorId: 'auto', allowScan: false });
  assert.equal(report.outcome, 'passed'); assert.equal(report.evidence, 'synthetic');
  assert.equal(report.physicalVerified, false); assert.equal(report.outputAttempted, false);
  assert.equal(report.devices.length, 2); assert.ok(report.devices.every(device => device.vendorId === null));
  assert.ok(report.steps.some(step => step.id === 'physical' && step.result === 'pending'));
  assert.ok(!adapter.calls.some(call => call.action === 'vibrate'));
  assert.equal(hub.snapshot().diagnosing, false);
  assert.throws(() => diagnostics.latest('other'), { code: 'REPORT_MISSING' });
  await hub.arm('owner', 'demo-a');
  await assert.rejects(diagnostics.run('owner', { mode: 'demo', vendorId: 'auto', allowScan: false }), { code: 'OUTPUT_ACTIVE' });
});
test('diagnostics protect the connection owner and release their lease on failure', async t => {
  const hub = new Hub(() => { const adapter = new DemoAdapter(); adapter.connect = async () => { throw new Error('private fixture diagnostic'); }; return adapter; });
  t.after(() => hub.close()); const diagnostics = new Diagnostics(hub, readCatalog());
  const report = await diagnostics.run('owner', { mode: 'intiface', vendorId: 'lovense', allowScan: false });
  assert.equal(report.outcome, 'failed'); assert.equal(hub.snapshot().diagnosing, false);
  assert.ok(!JSON.stringify(report).includes('private fixture'));
});
test('explicit short motor test always disarms and stops, and does not claim physical verification', async t => {
  const adapter = new DemoAdapter(); const hub = new Hub(() => adapter, { interval: 0 }); t.after(() => hub.close());
  await hub.connect('owner', 'demo');
  await assert.rejects(hub.exercise('owner', { id: 'demo-a', feature: 0, value: .1, epoch: 1, seq: 1 }), { code: 'DISARMED' });
  await hub.arm('owner', 'demo-a'); const epoch = hub.snapshot().devices[0]!.epoch;
  const result = await hub.exercise('owner', { id: 'demo-a', feature: 0, value: .1, epoch, seq: 1 });
  assert.equal(result.result, 'acknowledged'); assert.equal(result.physicalVerified, false);
  assert.equal(hub.snapshot().devices[0]!.armed, false); assert.equal(hub.snapshot().devices[0]!.testing, false);
  assert.equal(adapter.calls.at(-1)?.action, 'stop');
});
test('manual stop cancels the short test and no pending pulse reappears', async t => {
  const adapter = new DemoAdapter(); const hub = new Hub(() => adapter, { interval: 0 }); t.after(() => hub.close());
  await hub.connect('owner', 'demo'); await hub.arm('owner', 'demo-a'); const epoch = hub.snapshot().devices[0]!.epoch;
  const running = hub.exercise('owner', { id: 'demo-a', feature: 0, value: .1, epoch, seq: 1 });
  await wait(10);
  await assert.rejects(hub.output('owner', { id: 'demo-a', feature: 0, value: .5, epoch, seq: 2 }), { code: 'TEST_RUNNING' });
  await hub.stopDevice('demo-a'); const result = await running;
  assert.equal(result.result, 'cancelled'); assert.equal(adapter.calls.filter(call => call.action === 'vibrate').length, 1);
  assert.equal(hub.queueSize, 0);
});
test('invalid test features are rejected before changing an existing control grant', async t => {
  const adapter = new DemoAdapter(); const hub = new Hub(() => adapter); t.after(() => hub.close());
  await hub.connect('owner', 'demo'); await hub.arm('owner', 'demo-a');
  const before = hub.snapshot().devices[0]!; const calls = adapter.calls.length;
  await assert.rejects(hub.exercise('owner', { id: before.id, feature: 999, value: .1, epoch: before.epoch, seq: 1 }), { code: 'CAPABILITY' });
  assert.equal(adapter.calls.length, calls); assert.equal(hub.snapshot().devices[0]!.armed, true);
});
test('a failed motion command never becomes a successful or user-cancelled test', async t => {
  const adapter = new DemoAdapter(); adapter.vibrate = async () => { throw new Error('fixture transport failure'); };
  const hub = new Hub(() => adapter); t.after(() => hub.close());
  await hub.connect('owner', 'demo'); await hub.arm('owner', 'demo-a');
  const epoch = hub.snapshot().devices[0]!.epoch;
  const result = await hub.exercise('owner', { id: 'demo-a', feature: 0, value: .1, epoch, seq: 1 });
  assert.equal(result.result, 'unconfirmed'); assert.equal(hub.snapshot().devices[0]!.armed, false);
});
