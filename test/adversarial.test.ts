import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { Hub } from '../src/core/hub.ts';
import { DemoAdapter } from '../src/adapters/demo.ts';
import { createApp } from '../src/server/app.ts';
import { mkdir, writeFile } from 'node:fs/promises';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function localClient(url: string) {
  const response = await fetch(`${url}/api/session`); const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const { csrf } = await response.json() as { csrf: string };
  return { cookie,
    get: (path: string) => fetch(`${url}/api/${path}`, { headers: { Cookie: cookie } }),
    post: (path: string, input: unknown) => fetch(`${url}/api/${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(input) }),
  };
}

test('parallel disconnects perform a single teardown and cannot invalidate the next connection', async t => {
  const closing = gate(); let closes = 0;
  class SlowDisconnect extends DemoAdapter { override async disconnect() { closes++; await closing.promise; await super.disconnect(); } }
  let adapter: DemoAdapter = new SlowDisconnect(); const hub = new Hub(() => adapter); t.after(() => hub.close());
  await hub.connect('owner', 'demo');
  const first = hub.disconnect('owner'); const second = hub.disconnect('owner');
  await wait(1);
  try { assert.equal(closes, 1); }
  finally { closing.release(); await Promise.all([first, second]); }
  adapter = new DemoAdapter(); await hub.connect('owner', 'demo');
  assert.equal(hub.snapshot('owner').phase, 'ready'); assert.equal(hub.snapshot('owner').canControl, true);
});
test('a diagnostic lease acquired during pending arm prevents the arm from completing', async t => {
  const hub = new Hub(() => new DemoAdapter()); t.after(() => hub.close());
  await hub.connect('owner', 'demo');
  const arming = hub.arm('owner', 'demo-a'); const release = hub.beginDiagnostics('owner');
  try { await assert.rejects(arming, { code: 'DIAGNOSTIC_BUSY' }); }
  finally { release(); }
  assert.equal(hub.snapshot().devices[0]!.armed, false);
});
test('duplicate concurrent arm requests produce only one control epoch', async t => {
  const hub = new Hub(() => new DemoAdapter()); t.after(() => hub.close());
  await hub.connect('owner', 'demo'); const epochs = new Set<number>();
  const remove = hub.subscribe(() => { const state = hub.snapshot().devices[0]; if (state?.armed) epochs.add(state.epoch); });
  await Promise.all(Array.from({ length: 64 }, () => hub.arm('owner', 'demo-a'))); remove();
  assert.equal(epochs.size, 1);
});
test('an exhausted session cannot refresh into a new identity to bypass the limit', async t => {
  const app = createApp({ factory: () => new DemoAdapter() }); const url = await app.listen(0); t.after(() => app.close());
  const client = await localClient(url);
  for (let index = 0; index < 305; index++) { const response = await client.get('extensions'); await response.arrayBuffer(); }
  const refresh = await client.get('session');
  assert.equal(refresh.status, 429); assert.equal(refresh.headers.get('set-cookie'), null);
});
test('malformed inputs, missing codes and unavailable redemption never create a device adapter', async t => {
  let created = 0;
  const app = createApp({ factory: () => { created++; throw new Error('No physical adapter allowed in this test'); } });
  const url = await app.listen(0); t.after(() => app.close());
  type Case = { route: string; body: unknown; status: number };
  const cases: Case[] = [];
  const invalidIds = ['', 'a/b', ' ', '设备', 'x'.repeat(65), "'; DROP TABLE x;--", '../device', '<script>local-marker</script>'];
  for (const id of invalidIds) for (const route of ['arm', 'stop-device', 'output', 'exercise']) {
    cases.push({ route, body: route === 'output' || route === 'exercise' ? { id, feature: 0, value: .1, epoch: 1, seq: 1 } : { id }, status: 400 });
  }
  for (const field of ['feature', 'value', 'epoch', 'seq']) {
    for (const value of [null, true, false, '', '000123', [], {}, -1, Number.MAX_SAFE_INTEGER + 1]) {
      cases.push({ route: 'output', body: { id: 'demo-a', feature: 0, value: .1, epoch: 1, seq: 1, [field]: value }, status: 400 });
    }
  }
  for (const value of [0, -1, .31, 1, null, '', {}, []]) cases.push({ route: 'exercise', body: { id: 'demo-a', feature: 0, value, epoch: 1, seq: 1 }, status: 400 });
  for (const mode of ['', 'unknown', 0, 1, null, true, {}, []]) cases.push({ route: 'connect', body: { mode }, status: 400 });
  for (const property of ['url', 'target', 'host', 'token', 'constructor']) cases.push({ route: 'connect', body: { mode: 'demo', [property]: 'local-marker' }, status: 400 });
  cases.push({ route: 'arm', body: JSON.parse('{"id":"demo-a","__proto__":{"localPolluted":true}}'), status: 400 });
  for (const value of ['', '000123', null, '9'.repeat(48)]) cases.push({ route: 'pairings/redeem', body: { code: value }, status: 501 });
  for (const value of ['http://c.lovense.com/example', 'https://c.lovense.com.invalid/example', 'file:///tmp/local-marker', 'javascript:local-marker', 'https://127.0.0.1/local-marker', 'x'.repeat(1025)]) cases.push({ route: 'invites/inspect', body: { value }, status: 400 });
  const client = await localClient(url);
  for (const item of cases) {
    const response = await client.post(item.route, item.body);
    assert.equal(response.status, item.status, `route=${item.route}`);
    assert.ok(!(await response.text()).includes('local-marker'));
  }
  const noIssuer = await client.post('invites/inspect', { value: '000123' });
  assert.deepEqual(await noIssuer.json(), { kind: 'needs-provider' });
  assert.equal(created, 0); assert.equal(app.hub.snapshot().phase, 'idle');
  assert.equal(({} as Record<string, unknown>).localPolluted, undefined);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/input-validation-result.json', JSON.stringify({ cases: cases.length + 1, unexpectedSuccess: 0, adaptersCreated: created, outboundVendorRequests: 0, hardwareAccess: false }, null, 2));
});
test('SSE connection capacity is bounded and reusable across repeated close/open cycles', { timeout: 15000 }, async t => {
  const app = createApp({ factory: () => new DemoAdapter() }); const url = await app.listen(0); t.after(() => app.close());
  const client = await localClient(url);
  for (let round = 0; round < 10; round++) {
    const streams = await Promise.all(Array.from({ length: 16 }, () => client.get('events')));
    assert.ok(streams.every(response => response.status === 200));
    const excess = await client.get('events'); assert.equal(excess.status, 429); await excess.arrayBuffer();
    await Promise.all(streams.map(response => response.body!.cancel()));
    await wait(20);
  }
  const state = await client.get('state'); assert.equal(state.status, 200); await state.arrayBuffer();
});
test('guest capacity cannot displace the active connection owner', async t => {
  const app = createApp({ factory: () => new DemoAdapter() }); const url = await app.listen(0); t.after(() => app.close());
  const owner = await localClient(url); assert.equal((await owner.post('connect', { mode: 'demo' })).status, 200);
  for (let index = 0; index < 15; index++) { const guest = await fetch(`${url}/api/session`); assert.equal(guest.status, 200); await guest.arrayBuffer(); }
  const excess = await fetch(`${url}/api/session`); assert.equal(excess.status, 429); await excess.arrayBuffer();
  const response = await owner.get('state'); const state = await response.json();
  assert.equal(response.status, 200); assert.equal(state.canControl, true); assert.equal(state.phase, 'ready');
});
