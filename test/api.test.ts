import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.ts';
import { IntifaceAdapter } from '../src/adapters/intiface.ts';
import { fakeEngine } from './fixtures/engine.ts';
import { request } from 'node:http';

async function browser(url: string) {
  const response = await fetch(`${url}/api/session`);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const { csrf } = await response.json() as { csrf: string };
  return { cookie, csrf,
    post: (path: string, value: unknown = {}, extra: Record<string, string> = {}) => fetch(`${url}/api/${path}`, {
      method: 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...extra }, body: JSON.stringify(value),
    }),
    get: (path: string) => fetch(`${url}/api/${path}`, { headers: { Cookie: cookie } }),
  };
}
test('local API enforces host, origin, session, CSRF, body bounds, ownership and unavailable extensions', async t => {
  const app = createApp(); const url = await app.listen(0); t.after(() => app.close());
  assert.equal((await fetch(`${url}/api/state`)).status, 401);
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    request(`${url}/api/session`, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end();
  });
  assert.equal(badHost, 403);
  const alice = await browser(url); const bob = await browser(url);
  assert.equal((await alice.post('connect', { mode: 'demo' }, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await alice.post('connect', { mode: 'demo' }, { 'X-CSRF-Token': 'é'.repeat(64) })).status, 403);
  assert.equal((await alice.post('connect', { mode: 'demo', arbitrary: true })).status, 400);
  assert.equal((await alice.post('connect', { mode: 'demo' })).status, 200);
  assert.equal((await bob.post('arm', { id: 'demo-a' })).status, 403);
  assert.equal((await alice.post('arm', { id: "';DROP TABLE devices;--" })).status, 400);
  assert.equal((await alice.post('arm', { id: 'demo-a' })).status, 200);
  const state = await (await alice.get('state')).json(); const epoch = state.devices[0].epoch;
  assert.equal((await alice.post('output', { id: 'demo-a', feature: 0, value: 1.1, epoch, seq: 1 })).status, 400);
  assert.equal((await alice.post('output', { id: 'demo-a', feature: 0, value: .25, epoch, seq: 2 })).status, 200);
  assert.equal((await alice.post('output', { id: 'demo-a', feature: 0, value: .75, epoch, seq: 1 })).status, 409);
  assert.equal((await alice.post('invites/inspect', { value: 'https://127.0.0.1/internal' })).status, 400);
  const long = await alice.post('invites/inspect', { value: 'x'.repeat(5000) }); assert.equal(long.status, 413);
  const reserved = await alice.post('pairings/redeem', { code: '000123' }); assert.equal(reserved.status, 501);
  assert.ok(!(await reserved.text()).includes('000123'));
  assert.equal((await alice.post('stop')).status, 200);
  const stopped = await (await alice.get('state')).json(); assert.ok(stopped.devices.every((device: any) => !device.armed && device.receipt === 'stopped'));
  assert.equal((await alice.post('disconnect')).status, 200);
});
test('production adapter talks to a real WebSocket fixture using v4 handshake, feature indices, scaling and StopCmd', async t => {
  const engine = await fakeEngine();
  const app = createApp({ factory: () => new IntifaceAdapter(engine.url) });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); await engine.close(); });
  const client = await browser(url);
  assert.equal((await client.post('connect', { mode: 'intiface' })).status, 200);
  const state = await (await client.get('state')).json();
  assert.equal(state.devices[0].features.length, 2); assert.deepEqual(state.devices[0].otherCapabilities, ['Rotate']);
  await client.post('arm', { id: '7' });
  const armed = await (await client.get('state')).json();
  const response = await client.post('output', { id: '7', feature: 2, value: .5, epoch: armed.devices[0].epoch, seq: 1 });
  assert.equal(response.status, 200, await response.text());
  const output = engine.messages.find(message => message.OutputCmd)?.OutputCmd;
  assert.equal(output.DeviceIndex, 7); assert.equal(output.FeatureIndex, 2); assert.equal(output.Command.Vibrate.Value, 10);
  await client.post('stop-device', { id: '7' });
  assert.ok(engine.messages.some(message => message.StopCmd?.DeviceIndex === 7));
  assert.ok(!engine.messages.some(message => message.StartScanning));
  await client.post('scan');
  assert.ok(engine.messages.some(message => message.StartScanning));
  await client.post('disconnect');
});
test('shutdown with an open event stream completes without writing to an ended response', async () => {
  const app = createApp(); const url = await app.listen(0); const client = await browser(url);
  await client.post('connect', { mode: 'demo' });
  const response = await client.get('events'); const reader = response.body!.getReader();
  await reader.read();
  await app.close();
  await reader.cancel().catch(() => undefined);
});
const brandFixtures: Record<string, string> = {
  lovense: 'Lovense Lush', 'we-vibe': 'WeVibe Chorus', satisfyer: 'Satisfyer Hot Bunny', monsterpub: 'Sistalk MonsterPub 2 Doctor Whale',
  svakom: 'Svakom Ella Neo', lelo: 'Lelo Ida Wave', 'magic-motion': 'MagicMotion Solstice X', mysteryvibe: 'MysteryVibe Crescendo 2',
  tryfun: 'TryFun Yuan Series', muse: 'Dream Lover Archer 2', joyhub: 'JoyHub Aurora II', galaku: 'Galaku Panty Vib',
};
for (const [vendorId, model] of Object.entries(brandFixtures)) test(`synthetic descriptor routing for ${vendorId} never claims real hardware acceptance`, async t => {
  const engine = await fakeEngine({ name: model }); const app = createApp({ factory: () => new IntifaceAdapter(engine.url) });
  const url = await app.listen(0); t.after(async () => { await app.close(); await engine.close(); });
  const client = await browser(url);
  const response = await client.post('diagnostics', { mode: 'intiface', vendorId, allowScan: false });
  assert.equal(response.status, 200); const { report, state } = await response.json();
  assert.equal(report.outcome, 'passed'); assert.equal(report.devices[0].vendorId, vendorId);
  assert.equal(report.requestedVendor.connector, 'intiface-v4');
  assert.equal(report.physicalVerified, false); assert.equal(report.evidence, 'protocol-only');
  assert.ok(state.devices.every((device: any) => !device.armed));
  assert.ok(!engine.messages.some(message => message.OutputCmd));
  assert.ok(!engine.messages.some(message => message.StartScanning));
  const download = await client.get('diagnostics/report'); assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition')!, /attachment/);
  const other = await browser(url); assert.equal((await other.get('diagnostics/report')).status, 404);
});
test('diagnostics and motor-test endpoints validate scope and preserve ownership', async t => {
  const app = createApp(); const url = await app.listen(0); t.after(() => app.close());
  const client = await browser(url); const other = await browser(url);
  assert.equal((await client.post('diagnostics', { mode: 'demo', vendorId: 'auto', target: 'https://attacker.invalid' })).status, 400);
  const connected = await client.post('diagnostics', { mode: 'demo', vendorId: 'auto' }); assert.equal(connected.status, 200);
  await client.post('arm', { id: 'demo-a' }); const state = await (await client.get('state')).json();
  const command = { id: 'demo-a', feature: 0, value: .1, epoch: state.devices[0].epoch, seq: 1 };
  assert.equal((await other.post('exercise', command)).status, 403);
  assert.equal((await client.post('exercise', { ...command, value: .8 })).status, 400);
  const response = await client.post('exercise', command); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.test.result, 'acknowledged'); assert.equal(result.test.physicalVerified, false);
  assert.equal(result.state.devices[0].armed, false);
});
