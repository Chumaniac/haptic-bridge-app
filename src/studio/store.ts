import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, requireCondition } from '../core/errors.ts';
import { initialLibrary, limits, persistedSchema, type Persisted, type Library } from './schema.ts';

/** A single local server owns this file. Revisions serialize edits from its browser sessions. */
export class StudioStore {
  private value: Persisted;
  private file: string;
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(file: string, value: Persisted) { this.file = file; this.value = value; }
  static async load(file: string): Promise<StudioStore> {
    try {
      const metadata = await lstat(file);
      requireCondition(metadata.isFile() && metadata.size <= limits.fileBytes, 'STORAGE_INVALID', '本地配置文件不正确，原文件已保留。', 503);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(limits.fileBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        requireCondition(bytesRead <= limits.fileBytes, 'STORAGE_INVALID', '本地配置文件过大，原文件已保留。', 503);
        return new StudioStore(file, persistedSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))));
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new StudioStore(file, initialLibrary());
      throw new AppError('STORAGE_INVALID', '无法读取本地配置，原文件已保留；请检查后重新启动。', 503);
    }
  }
  snapshot(): Persisted { return structuredClone(this.value); }
  update(revision: number, change: (data: Library) => void): Promise<Persisted> {
    const work = this.pending.then(async () => {
      requireCondition(revision === this.value.revision, 'REVISION', '内容已被其他窗口修改，请刷新资料后再保存。', 409);
      const data = structuredClone(this.value.data);
      change(data);
      const next = persistedSchema.parse({ revision: this.value.revision + 1, data });
      const payload = JSON.stringify(next, null, 2);
      requireCondition(Buffer.byteLength(payload) <= limits.fileBytes, 'STORAGE_LIMIT', '本地配置已达到容量上限。', 413);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(payload, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.file);
      } catch {
        await unlink(temporary).catch(() => {});
        throw new AppError('STORAGE_WRITE', '保存失败，原有资料没有改变。请检查可用空间和文件权限。', 503);
      }
      this.value = next;
      return this.snapshot();
    });
    this.pending = work.catch(() => {});
    return work;
  }
  async flush(): Promise<void> { await this.pending; }
}
