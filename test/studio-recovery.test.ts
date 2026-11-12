import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile, open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore, recoverStudioFile } from '../src/studio/store.ts';

test('saving a new revision preserves the previous valid persisted snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-recovery-'));
  try {
    const file = join(root, 'studio.json'), store = await StudioStore.load(file);
    await store.update(0, data => { data.preferences.defaultIntensity = 31; });
    await store.update(1, data => { data.preferences.defaultIntensity = 42; });
    const previous = JSON.parse(await readFile(file + '.previous', 'utf8'));
    assert.equal(previous.schema, 'haptic.studio-recovery/v1');
    assert.equal(previous.snapshot.revision, 1);
    assert.equal(previous.snapshot.data.preferences.defaultIntensity, 31);
    assert.equal(JSON.stringify(previous).includes('armed'), false);
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('a second process snapshot cannot silently replace a newer on-disk revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-other-writer-'));
  try {
    const file = join(root, 'studio.json'), first = await StudioStore.load(file), second = await StudioStore.load(file);
    await first.update(0, data => { data.preferences.defaultIntensity = 38; });
    await assert.rejects(second.update(0, data => { data.preferences.defaultIntensity = 95; }), /其他|变化|进程/);
    assert.equal((await StudioStore.load(file)).snapshot().data.preferences.defaultIntensity, 38);
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('a missing main file with retained recovery material is not reset to a fresh library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-main-missing-'));
  try {
    const file = join(root, 'studio.json');
    await writeFile(file + '.previous', '{retained recovery material}');
    await assert.rejects(StudioStore.load(file), /恢复|保留/);
    assert.equal(await readFile(file + '.previous','utf8'), '{retained recovery material}');
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('an existing write marker is preserved and blocks another save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-write-owner-'));
  try {
    const file = join(root, 'studio.json'), store = await StudioStore.load(file);
    await writeFile(file + '.write-lock', 'preserve other writer marker');
    await assert.rejects(store.update(0, data => { data.preferences.defaultIntensity = 75; }), /保存|进程|核对/);
    assert.equal(await readFile(file + '.write-lock','utf8'), 'preserve other writer marker');
    assert.equal(store.snapshot().revision, 0);
    await unlink(file + '.write-lock');
  } finally { await rm(root, { recursive:true, force:true }); }
});


test('explicit recovery verifies the prior checksum, preserves a corrupt original and never replaces output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-explicit-recovery-'));
  try {
    const file = join(root, 'studio.json'), restored = join(root,'restored.json'), store = await StudioStore.load(file);
    await store.update(0, data => { data.preferences.defaultIntensity = 29; });
    await store.update(1, data => { data.preferences.defaultIntensity = 45; });
    await writeFile(file, '{retained corrupted original');
    await assert.rejects(StudioStore.load(file));
    const report = await recoverStudioFile(file+'.previous', restored);
    assert.equal(report.controlStateRestored, false); assert.equal(report.revision, 1);
    assert.equal((await StudioStore.load(restored)).snapshot().data.preferences.defaultIntensity, 29);
    assert.equal(await readFile(file,'utf8'), '{retained corrupted original');
    assert.equal((await stat(restored)).mode & 0o777, 0o600);
    const preserved = await readFile(restored,'utf8');
    await assert.rejects(recoverStudioFile(file+'.previous', restored));
    assert.equal(await readFile(restored,'utf8'), preserved);
    const broken = JSON.parse(await readFile(file+'.previous','utf8')); broken.snapshot.data.preferences.defaultIntensity = 99;
    await writeFile(file+'.previous', JSON.stringify(broken));
    await assert.rejects(recoverStudioFile(file+'.previous', join(root,'must-not-exist.json')));
    await assert.rejects(stat(join(root,'must-not-exist.json')), { code:'ENOENT' });
  } finally { await rm(root, {recursive:true,force:true}); }
});

test('a post-publication sync failure is unconfirmed rather than reporting unchanged data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-disk-ack-'));
  try {
    const file = join(root,'studio.json'), store = await StudioStore.load(file), probe = await open(join(root,'probe'),'wx');
    const prototype = Object.getPrototypeOf(probe), original = prototype.sync;
    await probe.close(); let directorySyncs = 0;
    t.mock.method(prototype, 'sync', async function(this: import('node:fs/promises').FileHandle) {
      if ((await this.stat()).isDirectory() && ++directorySyncs === 2) throw new Error('synthetic acknowledgement failure');
      return original.call(this);
    });
    await assert.rejects(store.update(0, data => { data.preferences.defaultIntensity = 43; }), error => error instanceof Error && 'code' in error && error.code === 'STORAGE_UNCONFIRMED');
    t.mock.restoreAll();
    assert.equal(store.snapshot().revision, 1);
    assert.equal(JSON.parse(await readFile(file,'utf8')).data.preferences.defaultIntensity, 43);
    assert.equal((await StudioStore.load(file)).snapshot().revision, 1);
  } finally { t.mock.restoreAll(); await rm(root,{recursive:true,force:true}); }
});

test('state and diagnostic polling do not clone the persisted pattern library', async () => {
  const { createStudio } = await import('../src/studio/server.ts');
  const root = await mkdtemp(join(tmpdir(),'studio-poll-metadata-'));
  const app = await createStudio({file:join(root,'studio.json')});
  try {
    const url = await app.listen(0), response=await fetch(url+'/api/session'), session=await response.json() as {session:string;csrf:string};
    const headers={cookie:response.headers.get('set-cookie')!.split(';')[0]!,'x-studio-session':session.session};
    const snapshot=app.store.snapshot;
    app.store.snapshot=()=>{throw new Error('Full library must only be cloned when requested');};
    try {
      const state=await fetch(url+'/api/state',{headers}); assert.equal(state.status,200); assert.equal((await state.json() as {revision:number}).revision,0);
      const diagnostics=await fetch(url+'/api/diagnostics',{headers}); assert.equal(diagnostics.status,200);
    } finally {app.store.snapshot=snapshot;}
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});
