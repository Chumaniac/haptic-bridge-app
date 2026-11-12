import { lstat, mkdir, open, rename, unlink, link } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, requireCondition } from '../core/errors.ts';
import { initialLibrary, limits, persistedSchema, librarySchema, type Persisted, type Library } from './schema.ts';

const RECOVERY_BYTES = limits.fileBytes + 1024;
const recoverySchema = z.strictObject({ schema: z.literal('haptic.studio-recovery/v1'), sha256: z.string().regex(/^[a-f0-9]{64}$/), snapshot: persistedSchema });
const digest = (value: Persisted) => createHash('sha256').update(JSON.stringify(persistedSchema.parse(value))).digest('hex');
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const invalid = () => new AppError('STORAGE_INVALID', '无法读取本地配置，原文件已保留；请检查或用恢复工具写入新文件。', 503);

async function bounded(file: string, maximum: number): Promise<{ text: string; metadata: Stats }> {
  const metadata = await lstat(file);
  requireCondition(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.size <= maximum, 'STORAGE_INVALID', '本地配置不正确，原文件已保留。', 503);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    requireCondition(same(metadata, await handle.stat()), 'STORAGE_INVALID', '本地配置读取中变化，原文件已保留。', 503);
    const buffer = Buffer.alloc(metadata.size + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    requireCondition(offset === metadata.size && same(metadata, await handle.stat()) && same(metadata, await lstat(file)), 'STORAGE_INVALID', '本地配置读取中变化，原文件已保留。', 503);
    return { text: buffer.subarray(0, offset).toString('utf8'), metadata };
  } finally { await handle.close(); }
}
async function existing(file: string, maximum: number) {
  try { return await bounded(file, maximum); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function syncDirectory(file: string) {
  if (process.platform === 'win32') return;
  const handle = await open(dirname(file), 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
function decode(text: string): Persisted {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && 'schema' in value) {
      const recovery = recoverySchema.parse(value);
      requireCondition(digest(recovery.snapshot) === recovery.sha256, 'STORAGE_RECOVERY_INVALID', '恢复快照校验失败，原件已保留。', 503);
      return recovery.snapshot;
    }
    const persisted = persistedSchema.safeParse(value);
    if (persisted.success) return persisted.data;
    return persistedSchema.parse({ revision: 0, data: librarySchema.parse(value) });
  } catch { throw invalid(); }
}
async function atomic(file: string, payload: string, before: () => Promise<void>, published: () => void = () => {}) {
  const temporary = `${file}.${randomUUID()}.tmp`; let created: Stats | undefined;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { created = await handle.stat(); await handle.writeFile(payload, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await before(); await rename(temporary, file); published(); await syncDirectory(file); return await lstat(file);
  } finally {
    if (created) {
      const current = await lstat(temporary).catch(() => null);
      if (current && current.dev === created.dev && current.ino === created.ino) await unlink(temporary);
    }
  }
}
async function withWriteLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const path = file + '.write-lock'; let handle: FileHandle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('STORAGE_BUSY', '另一个本地进程可能正在保存。请先核对并退出多余实例；保留原文件和锁，不要重复覆盖。', 409);
    throw error;
  }
  let identity: Stats | undefined;
  try {
    identity = await handle.stat();
    await handle.writeFile(JSON.stringify({ schema: 'haptic.studio-write/v1', pid: process.pid }), 'utf8'); await handle.sync();
    return await work();
  } finally {
    await handle.close();
    const current = await lstat(path).catch(() => null);
    if (identity && current?.dev === identity.dev && current.ino === identity.ino) { await unlink(path); await syncDirectory(file); }
  }
}

/** One active file writer. Other windows use revisions; other processes fail closed. */
export class StudioStore {
  private value: Persisted;
  private metadata: Stats | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private file: string;
  private constructor(file: string, value: Persisted, metadata?: Stats) { this.file = file; this.value = value; this.metadata = metadata; }
  static async load(file: string): Promise<StudioStore> {
    try {
      const record = await existing(file, limits.fileBytes);
      if (record) return new StudioStore(file, persistedSchema.parse(JSON.parse(record.text)), record.metadata);
      if (await lstat(file + '.previous').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; })) throw invalid();
      return new StudioStore(file, initialLibrary());
    } catch { throw invalid(); }
  }
  get revision(): number { return this.value.revision; }
  get patternCount(): number { return this.value.data.patterns.length; }
  snapshot(): Persisted { return structuredClone(this.value); }
  private async unchanged() {
    const current = await existing(this.file, limits.fileBytes);
    if ((!current) !== (!this.metadata) || current && (!this.metadata || !same(current.metadata, this.metadata) || digest(persistedSchema.parse(JSON.parse(current.text))) !== digest(this.value))) {
      throw new AppError('STORAGE_CHANGED', '其他进程已更改本地配置，本次没有写入。退出多余服务后重新打开并核对。', 409);
    }
  }
  update(revision: number, change: (data: Library) => void): Promise<Persisted> {
    const work = this.pending.then(async () => {
      requireCondition(revision === this.value.revision, 'REVISION', '内容已被其他窗口修改，请刷新资料后再保存。', 409);
      const data = structuredClone(this.value.data); change(data);
      const next = persistedSchema.parse({ revision: this.value.revision + 1, data });
      const payload = JSON.stringify(next, null, 2);
      requireCondition(Buffer.byteLength(payload) <= limits.fileBytes, 'STORAGE_LIMIT', '本地配置已达到容量上限。', 413);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      let published = false;
      try {
        return await withWriteLock(this.file, async () => {
          await this.unchanged();
          const previousFile = this.file + '.previous';
          const old = await existing(previousFile, RECOVERY_BYTES);
          if (old) {
            const decoded = recoverySchema.parse(JSON.parse(old.text));
            requireCondition(digest(decoded.snapshot) === decoded.sha256 && decoded.snapshot.revision <= this.value.revision, 'STORAGE_RECOVERY_INVALID', '上一修订无法核对，本次未写入；原件已保留。', 503);
          }
          const before = persistedSchema.parse(this.value);
          const recovery = JSON.stringify({ schema:'haptic.studio-recovery/v1', sha256:digest(before), snapshot:before });
          requireCondition(Buffer.byteLength(recovery) <= RECOVERY_BYTES, 'STORAGE_LIMIT', '恢复快照超过上限。', 413);
          await atomic(previousFile, recovery, async () => {
            const actual = await existing(previousFile, RECOVERY_BYTES);
            requireCondition((!actual) === (!old) && (!actual || old && same(actual.metadata, old.metadata)), 'STORAGE_RECOVERY_INVALID', '恢复文件已变化，原件已保留。', 503);
          });
          const metadata = await atomic(this.file, payload, () => this.unchanged(), () => { published = true; });
          this.value = next; this.metadata = metadata;
          return this.snapshot();
        });
      } catch (error) {
        if (published) {
          this.value = next; this.metadata = await lstat(this.file).catch(() => undefined);
          throw new AppError('STORAGE_UNCONFIRMED', '资料已写入，但磁盘确认未完成。先重新读取核对，不要重复保存或清空文件。', 503);
        }
        if (error instanceof AppError && ['STORAGE_BUSY','STORAGE_CHANGED','STORAGE_RECOVERY_INVALID'].includes(error.code)) throw error;
        throw new AppError('STORAGE_WRITE', '保存失败，原有资料没有改变。请检查可用空间、恢复文件和权限。', 503);
      }
    });
    this.pending = work.catch(() => {}); return work;
  }
  async flush(): Promise<void> { await this.pending; }
}

/** Explicit file-only recovery. Never overwrite originals or restore control/output state. */
export async function recoverStudioFile(source: string, output: string) {
  const record = await bounded(source, RECOVERY_BYTES); const snapshot = decode(record.text);
  const payload = JSON.stringify(snapshot, null, 2);
  requireCondition(Buffer.byteLength(payload) <= limits.fileBytes, 'STORAGE_LIMIT', '恢复结果超过上限。', 413);
  await mkdir(dirname(output), { recursive:true, mode:0o700 });
  const temporary = `${output}.${randomUUID()}.tmp`; let created: Stats | undefined;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { created = await handle.stat(); await handle.writeFile(payload, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, output);
  } finally {
    if (created) { const current = await lstat(temporary).catch(() => null); if (current && current.dev === created.dev && current.ino === created.ino) await unlink(temporary); }
  }
  await syncDirectory(output);
  return { schema:'haptic.studio-recovery-result/v1', status:'restored', revision:snapshot.revision, patterns:snapshot.data.patterns.length, sha256:digest(snapshot), controlStateRestored:false };
}
