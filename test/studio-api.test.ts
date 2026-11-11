import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createStudio } from '../src/studio/server.ts';
import { initialLibrary } from '../src/studio/schema.ts';

async function fixture(options: { sessionMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-studio-api-'));
  const file = join(directory, 'settings.json'); const app = await createStudio({ file, ...options }); const url = await app.listen(0);
  async function client(previousCookie?: string) {
    const response = await fetch(`${url}/api/session`, { headers: previousCookie ? { cookie: previousCookie } : {} });
    assert.equal(response.status, 200);
    const initial = await response.json() as { csrf: string; session?: string; state: unknown; library: { revision: number } };
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie, origin: url, 'content-type': 'application/json', 'x-csrf-token': initial.csrf, ...(initial.session ? { 'x-studio-session': initial.session } : {}) };
    return { cookie, initial, headers,
      post: (path: string, data: unknown) => fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(data) }),
      get: (path: string) => fetch(`${url}${path}`, { headers }),
    };
  }
  return { app, url, file, client, close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('independent tabs sharing browser cookies receive different control sessions', async () => {
  const f = await fixture();
  try {
    const a = await f.client(); const b = await f.client(a.cookie);
    assert.ok(a.initial.csrf !== b.initial.csrf, 'a second tab must not silently inherit the owner identity');
    assert.equal((await a.post('/api/control', { action: 'claim' })).status, 200);
    assert.equal((await b.post('/api/control', { action: 'claim' })).status, 409);
    assert.equal((await b.post('/api/device', { id: 'virtual-one', action: 'connect' })).status, 409);
    assert.equal((await b.post('/api/stop', {})).status, 200, 'every authenticated viewer can stop the simulation');
    assert.equal((await a.post('/api/control', { action: 'release' })).status, 200);
    assert.equal((await b.post('/api/control', { action: 'claim' })).status, 200);
  } finally { await f.close(); }
});

test('HTTP host, Origin, CSRF and session boundaries reject unauthorized mutations', async () => {
  const f = await fixture();
  try {
    const a = await f.client();
    assert.equal((await fetch(`${f.url}/api/state`)).status, 401);
    const hostStatus = await new Promise<number>(resolve => {
      const req = request(`${f.url}/api/session`, { headers: { Host: 'other.invalid' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(`${f.url}/api/control`, { method: 'POST', headers: { ...a.headers, origin: 'https://other.invalid' }, body: '{"action":"claim"}' })).status, 403);
    assert.equal((await fetch(`${f.url}/api/control`, { method: 'POST', headers: { ...a.headers, 'x-csrf-token': '0'.repeat(64) }, body: '{"action":"claim"}' })).status, 403);
    assert.equal((await a.post('/api/control', { action: 'claim', endpoint: 'ws://example.invalid' })).status, 400);
    assert.equal((await a.post('/api/connect', { mode: 'intiface' })).status, 404, 'standalone studio has no real-adapter route');
    const catalog = await (await a.get('/api/catalog')).json();
    assert.equal(catalog.hardwareVerified, false); assert.equal(catalog.profiles.length, 12);
    assert.ok(catalog.profiles.find((profile: { id: string }) => profile.id === 'lovense').connectionMethods.includes('蓝牙 BLE'));
  } finally { await f.close(); }
});

test('full HTTP pattern save/edit/export/import/preferences workflow persists real files', async () => {
  const f = await fixture();
  try {
    const a = await f.client(); await a.post('/api/control', { action: 'claim' });
    let response = await a.post('/api/library/save', { revision: 0, pattern: { name: '本地工作流', cycles: 1, steps: [{ value: 24, durationMs: 200 }] } });
    assert.equal(response.status, 200); let saved = await response.json();
    assert.equal(saved.library.revision, 1); const id = saved.library.data.patterns.at(-1).id;
    response = await a.post('/api/library/save', { revision: 1, pattern: { id, name: '已修改', cycles: 2, steps: [{ value: 11, durationMs: 300 }] } });
    assert.equal(response.status, 200);
    assert.equal((await a.post('/api/preferences', { revision: 2, preferences: { defaultIntensity: 33, defaultDurationMs: 700 } })).status, 200);
    const exported = await (await a.get('/api/export')).json(); assert.equal(exported.preferences.defaultIntensity, 33);
    assert.equal((await a.post('/api/import', { revision: 3, data: { ...exported, endpoint: 'http://invalid.test' } })).status, 400);
    const oldBytes = await readFile(f.file, 'utf8');
    assert.equal((await a.post('/api/import', { revision: 2, data: exported })).status, 409);
    assert.equal(await readFile(f.file, 'utf8'), oldBytes);
    assert.equal((await a.post('/api/import', { revision: 3, data: initialLibrary().data })).status, 200);
    assert.equal((await a.post('/api/preferences/reset', { revision: 4 })).status, 200);
    const persisted = JSON.parse(await readFile(f.file, 'utf8')); assert.equal(persisted.revision, 5); assert.equal(persisted.data.patterns.length, 2);
  } finally { await f.close(); }
});

test('diagnostics omit browser secrets, custom pattern names, and imported payloads', async () => {
  const f = await fixture();
  try {
    const a = await f.client(); await a.post('/api/control', { action: 'claim' });
    const marker = 'secret_payload_NOT_FOR_DIAGNOSTICS';
    await a.post('/api/library/save', { revision: 0, pattern: { name: marker, cycles: 1, steps: [{ value: 5, durationMs: 100 }] } });
    const response = await a.get('/api/diagnostics'); const raw = await response.text();
    assert.equal(response.status, 200);
    for (const secret of [a.initial.csrf, a.cookie.split('=')[1]!, marker, a.initial.session].filter(Boolean) as string[]) assert.equal(raw.includes(secret), false);
    const diagnostics = JSON.parse(raw); assert.equal(diagnostics.hardwareAccess, false); assert.equal(diagnostics.credentialsIncluded, false);
    assert.ok(response.headers.get('permissions-policy')?.includes('bluetooth=()'));
  } finally { await f.close(); }
});

test('expired HTTP sessions lose ownership and cannot issue commands', async () => {
  const f = await fixture({ sessionMs: 100 });
  try {
    const a = await f.client(); assert.equal((await a.post('/api/control', { action: 'claim' })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await a.post('/api/device', { id: 'virtual-one', action: 'connect' })).status, 401);
    assert.equal(f.app.core.snapshot('observer').control.busy, false);
  } finally { await f.close(); }
});

test('request limits reject excess traffic while authenticated emergency stop remains available', async () => {
  const f = await fixture();
  try {
    const a = await f.client(); await a.post('/api/control', { action: 'claim' });
    let limited = false;
    for (let i = 0; i < 170; i++) { if ((await a.get('/api/state')).status === 429) { limited = true; break; } }
    assert.equal(limited, true);
    assert.equal((await a.post('/api/stop', {})).status, 200);
    assert.equal((await fetch(`${f.url}/api/stop`, { method: 'POST', headers: { ...a.headers, 'x-csrf-token': '0'.repeat(64) }, body: '{}' })).status, 403);
  } finally { await f.close(); }
});

test('oversized imports and unknown device capabilities fail without changing saved data', async () => {
  const f = await fixture();
  try {
    const a = await f.client(); await a.post('/api/control', { action: 'claim' });
    assert.equal((await a.post('/api/import', { payload: 'x'.repeat(131072) })).status, 413);
    assert.equal((await a.post('/api/device', { id: 'unknown-device', action: 'connect' })).status, 400);
    assert.equal((await a.post('/api/output', { id: 'virtual-one', channel: 9, epoch: 1, sequence: 1, value: 50 })).status, 400);
    assert.equal(f.app.store.snapshot().revision, 0); assert.ok(f.app.core.snapshot('observer').devices.every(device => !device.connected));
  } finally { await f.close(); }
});
