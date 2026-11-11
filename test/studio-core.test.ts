import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioCore } from '../src/studio/core.ts';
import { StudioStore } from '../src/studio/store.ts';
import { initialLibrary, librarySchema, patternDraftSchema } from '../src/studio/schema.ts';

function setup() {
  let time = 0;
  const core = new StudioCore({ now: () => time, autoTick: false, leaseMs: 8000 });
  core.claim('owner'); core.deviceAction('owner', 'virtual-one', 'connect'); core.deviceAction('owner', 'virtual-one', 'arm');
  const epoch = core.snapshot('owner').devices[0]!.epoch;
  return { core, epoch, advance: (ms: number) => { time += ms; core.tick(); } };
}

test('virtual control enforces ownership, arm epochs and sequence; stop invalidates stale commands', () => {
  const { core, epoch } = setup();
  assert.throws(() => core.claim('guest'), /其他窗口/);
  assert.throws(() => core.output('guest', 'virtual-one', 0, epoch, 1, 25), /获取/);
  core.output('owner', 'virtual-one', 0, epoch, 1, 25);
  assert.equal(core.snapshot('owner').devices[0]!.values[0], 25);
  assert.throws(() => core.output('owner', 'virtual-one', 0, epoch, 1, 99), /顺序/);
  core.stop();
  assert.throws(() => core.output('owner', 'virtual-one', 0, epoch, 2, 40), /锁定/);
  core.deviceAction('owner', 'virtual-one', 'disconnect'); core.deviceAction('owner', 'virtual-one', 'connect');
  assert.equal(core.snapshot('owner').devices[0]!.armed, false);
  core.close();
});

test('mode playback follows elapsed time, pauses at zero and completes locked at zero', () => {
  const { core, epoch, advance } = setup();
  const pattern = initialLibrary().data.patterns[0]!;
  core.play('owner', 'virtual-one', 0, epoch, pattern);
  pattern.steps[0]!.value = 99;
  assert.equal(core.snapshot('owner').devices[0]!.values[0], 10, 'running snapshot cannot be mutated by editor');
  advance(1200); assert.equal(core.snapshot('owner').devices[0]!.values[0], 30);
  core.playbackAction('owner', 'pause');
  assert.equal(core.snapshot('owner').devices[0]!.values[0], 0);
  advance(1000); assert.equal(core.snapshot('owner').playback!.elapsedMs, 1200);
  core.playbackAction('owner', 'resume'); advance(1800);
  assert.equal(core.snapshot('owner').playback!.elapsedMs, 3000);
  advance(1000);
  const state = core.snapshot('owner');
  assert.equal(state.lastPlayback, 'completed'); assert.equal(state.playback, null);
  assert.equal(state.devices[0]!.armed, false); assert.deepEqual(state.devices[0]!.values, [0]); core.close();
});

test('cancel, release and owner heartbeat expiry stop every virtual output and never resume', () => {
  for (const action of ['cancel', 'release', 'expiry'] as const) {
    const { core, epoch, advance } = setup();
    core.play('owner', 'virtual-one', 0, epoch, initialLibrary().data.patterns[0]!);
    if (action === 'cancel') core.playbackAction('owner', 'cancel');
    else if (action === 'release') core.release('owner');
    else advance(8001);
    const state = core.snapshot('owner');
    assert.equal(state.playback, null); assert.equal(state.devices[0]!.armed, false); assert.equal(state.devices[0]!.values[0], 0);
    if (action !== 'cancel') { assert.equal(state.control.busy, false); core.claim('guest'); }
    assert.throws(() => core.playbackAction(action === 'cancel' ? 'owner' : 'guest', 'resume'), /没有模式/);
    core.close();
  }
});

test('virtual channels remain independent; history and runtime resources have bounds', () => {
  const { core, epoch } = setup();
  core.deviceAction('owner', 'virtual-duo', 'connect'); core.deviceAction('owner', 'virtual-duo', 'arm');
  const duoEpoch = core.snapshot('owner').devices[1]!.epoch;
  core.output('owner', 'virtual-duo', 1, duoEpoch, 1, 65);
  for (let seq = 1; seq <= 2000; seq++) core.output('owner', 'virtual-one', 0, epoch, seq, seq % 101);
  const snapshot = core.snapshot('owner');
  assert.deepEqual(snapshot.devices[1]!.values, [0, 65]); assert.equal(snapshot.history.length, 120);
  assert.equal(JSON.stringify(snapshot).includes('owner'), false, 'session identity must not enter state or logs');
  core.close(); const closed = core.snapshot('owner');
  assert.equal(closed.resources.timers, 0); assert.equal(closed.resources.activePlaybacks, 0);
  assert.ok(closed.devices.every(device => device.values.every(value => value === 0)));
});

test('strict import validation rejects secrets, duplicate IDs, unbounded data and invalid step values', () => {
  assert.equal(librarySchema.safeParse({ ...initialLibrary().data, endpoint: 'https://example.invalid' }).success, false);
  const base = initialLibrary().data;
  assert.equal(librarySchema.safeParse({ ...base, patterns: [base.patterns[0], base.patterns[0]] }).success, false);
  for (const value of [-1, 101, NaN, Infinity, '10']) {
    assert.equal(patternDraftSchema.safeParse({ name: '输入', cycles: 1, steps: [{ value, durationMs: 1000 }] }).success, false);
  }
  assert.equal(patternDraftSchema.safeParse({ name: '长模式', cycles: 10, steps: Array.from({ length: 64 }, () => ({ value: 20, durationMs: 30000 })) }).success, false);
  assert.equal(patternDraftSchema.safeParse({ name: '换\n行', cycles: 1, steps: [{ value: 10, durationMs: 100 }] }).success, false);
});

test('persistent edits are serialized, conflict-safe and survive process reconstruction without output state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-studio-store-'));
  try {
    const file = join(directory, 'settings.json'); const store = await StudioStore.load(file);
    const results = await Promise.allSettled([
      store.update(0, data => { data.preferences.defaultIntensity = 37; }),
      store.update(0, data => { data.preferences.defaultIntensity = 98; }),
    ]);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
    const restored = await StudioStore.load(file);
    assert.equal(restored.snapshot().data.preferences.defaultIntensity, 37); assert.equal(restored.snapshot().revision, 1);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file, 'utf8')).includes('armed'), false);
    await store.update(1, data => { data.preferences.defaultIntensity = 42; });
    assert.equal(store.snapshot().revision, 2, 'a rejected queued edit must not poison later writes');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid or symlinked local configuration is preserved and never silently reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-studio-invalid-'));
  try {
    const file = join(directory, 'invalid.json'); await writeFile(file, '{incomplete');
    await assert.rejects(StudioStore.load(file), /原文件已保留/); assert.equal(await readFile(file, 'utf8'), '{incomplete');
    const link = join(directory, 'link.json'); await symlink(file, link);
    await assert.rejects(StudioStore.load(link), /原文件已保留/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed disk commit does not change in-memory settings or poison the next save', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-studio-write-'));
  try {
    const file = join(directory, 'settings.json'); const store = await StudioStore.load(file);
    await mkdir(file);
    await assert.rejects(store.update(0, data => { data.preferences.defaultIntensity = 95; }), /原有资料没有改变/);
    assert.equal(store.snapshot().revision, 0); assert.equal(store.snapshot().data.preferences.defaultIntensity, 20);
    await rm(file, { recursive: true });
    await store.update(0, data => { data.preferences.defaultIntensity = 31; });
    assert.equal((await StudioStore.load(file)).snapshot().data.preferences.defaultIntensity, 31);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
