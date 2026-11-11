import { AppError } from './errors.ts';

interface Job {
  run: () => Promise<void>;
  resolve: (result: 'sent' | 'superseded') => void;
  reject: (error: unknown) => void;
}
// One running command and one pending value PER FEATURE. A device has at most 8
// exposed vibration features in phase 1; bulk motion playback needs another scheduler.
export class Dispatcher {
  private pending = new Map<string, Job>();
  private active = new Map<string, Promise<void>>();
  private blocked = new Set<string>();
  private lastSent = new Map<string, number>();
  private interval: number;
  constructor(interval = 100) { this.interval = interval; }
  get size(): number { return this.pending.size + this.active.size; }
  allow(device: string): void { this.blocked.delete(device); }
  submit(device: string, feature: number, run: () => Promise<void>): Promise<'sent' | 'superseded'> {
    if (this.blocked.has(device)) return Promise.reject(new AppError('DISARMED', '请先启用设备控制。', 409));
    const key = `${device}/${feature}`;
    return new Promise((resolve, reject) => {
      this.pending.get(key)?.resolve('superseded');
      this.pending.set(key, { run, resolve, reject });
      this.start(device, key);
    });
  }
  private start(device: string, key: string): void {
    if (this.active.has(key) || this.blocked.has(device)) return;
    const draining = this.drain(device, key);
    this.active.set(key, draining);
    void draining.finally(() => {
      this.active.delete(key);
      if (this.pending.has(key)) this.start(device, key);
    });
  }
  private async drain(device: string, key: string): Promise<void> {
    while (this.pending.has(key) && !this.blocked.has(device)) {
      const delay = Math.max(0, (this.lastSent.get(key) ?? 0) + this.interval - performance.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (this.blocked.has(device)) break;
      const job = this.pending.get(key);
      this.pending.delete(key);
      if (!job) continue;
      this.lastSent.set(key, performance.now());
      try { await job.run(); job.resolve('sent'); }
      catch (error) { job.reject(error); }
    }
  }
  async barrier(device: string): Promise<void> {
    this.blocked.add(device);
    for (const [key, job] of this.pending) {
      if (key.startsWith(`${device}/`)) { job.resolve('superseded'); this.pending.delete(key); }
    }
    await Promise.all([...this.active].filter(([key]) => key.startsWith(`${device}/`)).map(([, job]) => job));
    for (const key of this.lastSent.keys()) if (key.startsWith(`${device}/`)) this.lastSent.delete(key);
  }
  forget(device: string): void { this.blocked.delete(device); }
}
