import { performance } from 'node:perf_hooks';
import { requireCondition } from '../core/errors.ts';
import { duration, limits, type Pattern } from './schema.ts';

type DeviceId = 'virtual-one' | 'virtual-duo';
interface VirtualDevice { id: DeviceId; name: string; connected: boolean; armed: boolean; epoch: number; values: number[]; sequence: number[] }
type EventCode = 'claim' | 'release' | 'connect' | 'disconnect' | 'arm' | 'output' | 'stop' | 'play' | 'pause' | 'resume' | 'complete' | 'lease-expired' | 'shutdown' | 'library-save' | 'library-delete' | 'import' | 'preferences';
interface Entry { number: number; at: string; code: EventCode; device: DeviceId | null }
interface Playback { pattern: Pattern; id: DeviceId; channel: number; epoch: number; status: 'playing' | 'paused'; offsetMs: number; started: number }
export interface StudioState {
  simulation: true; control: { mine: boolean; busy: boolean; leaseRemainingMs: number };
  devices: VirtualDevice[];
  playback: null | { status: 'playing' | 'paused'; deviceId: DeviceId; channel: number; patternId: string; name: string; elapsedMs: number; totalMs: number; step: number; cycle: number };
  lastPlayback: 'completed' | 'canceled' | null;
  history: Entry[]; resources: { timers: number; historySize: number; historyLimit: number; outputCommands: number; activePlaybacks: number };
}

/** Simulation-only state machine. It deliberately has no transport, adapter, or endpoint injection. */
export class StudioCore {
  private devices: VirtualDevice[] = [
    { id: 'virtual-one', name: '虚拟设备 · 单通道', connected: false, armed: false, epoch: 0, values: [0], sequence: [0] },
    { id: 'virtual-duo', name: '虚拟设备 · 双通道', connected: false, armed: false, epoch: 0, values: [0, 0], sequence: [0, 0] },
  ];
  private owner: { id: string; expires: number } | null = null;
  private playback: Playback | null = null;
  private lastPlayback: StudioState['lastPlayback'] = null;
  private history: Entry[] = [];
  private events = 0;
  private outputs = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private now: () => number;
  private leaseMs: number;
  private closed = false;
  constructor(options: { now?: () => number; autoTick?: boolean; leaseMs?: number } = {}) {
    this.now = options.now ?? (() => performance.now()); this.leaseMs = options.leaseMs ?? 8000;
    if (options.autoTick !== false) { this.timer = setInterval(() => this.tick(), 50); this.timer.unref(); }
  }
  record(code: EventCode, device: DeviceId | null = null): void {
    this.history.push({ number: ++this.events, at: new Date().toISOString(), code, device });
    if (this.history.length > limits.history) this.history.shift();
  }
  private check(): void {
    requireCondition(!this.closed, 'CLOSED', '工作台已关闭。', 503);
    if (this.owner && this.owner.expires <= this.now()) { this.zero(); this.owner = null; this.record('lease-expired'); }
  }
  requireOwner(actor: string): void {
    this.check(); requireCondition(this.owner?.id === actor, 'OWNER', '请先在此窗口获取本地控制权。', 409);
  }
  claim(actor: string): void {
    this.check(); requireCondition(!this.owner || this.owner.id === actor, 'OWNER_BUSY', '其他窗口正在控制，请先由该窗口释放，或等待会话过期。', 409);
    if (!this.owner) this.record('claim');
    this.owner = { id: actor, expires: this.now() + this.leaseMs };
  }
  heartbeat(actor: string): void { this.requireOwner(actor); this.owner!.expires = this.now() + this.leaseMs; }
  release(actor: string): void { this.requireOwner(actor); this.zero(); this.owner = null; this.record('release'); }
  expire(actor: string): void { if (this.owner?.id === actor) { this.zero(); this.owner = null; this.record('lease-expired'); } }
  private device(id: string): VirtualDevice {
    const device = this.devices.find(item => item.id === id);
    requireCondition(device, 'DEVICE', '此虚拟设备不存在。', 404); return device;
  }
  private invalidate(device: VirtualDevice): void {
    device.values.fill(0); device.armed = false; device.epoch++; device.sequence.fill(0);
    if (this.playback?.id === device.id) { this.playback = null; this.lastPlayback = 'canceled'; }
  }
  private zero(): void { for (const device of this.devices) this.invalidate(device); }
  deviceAction(actor: string, id: string, action: 'connect' | 'disconnect' | 'arm' | 'stop'): void {
    this.requireOwner(actor); const device = this.device(id);
    if (action === 'connect') {
      if (!device.connected) { this.invalidate(device); device.connected = true; this.record('connect', device.id); }
    } else if (action === 'disconnect') {
      this.invalidate(device); device.connected = false; this.record('disconnect', device.id);
    } else if (action === 'arm') {
      requireCondition(device.connected, 'DISCONNECTED', '请先连接这台虚拟设备。', 409);
      if (!device.armed) { device.armed = true; device.epoch++; device.sequence.fill(0); this.record('arm', device.id); }
    } else { this.invalidate(device); this.record('stop', device.id); }
  }
  private channel(device: VirtualDevice, channel: number, epoch: number): void {
    requireCondition(device.connected && device.armed && device.epoch === epoch, 'LOCKED', '控制已锁定，请重新启用。', 409);
    requireCondition(Number.isInteger(channel) && channel >= 0 && channel < device.values.length, 'CHANNEL', '此控制通道不存在。');
  }
  output(actor: string, id: string, channel: number, epoch: number, sequence: number, value: number): void {
    this.requireOwner(actor); const device = this.device(id); this.channel(device, channel, epoch);
    requireCondition(!this.playback, 'PLAYBACK_ACTIVE', '请先取消模式播放，再手动调整。', 409);
    requireCondition(Number.isInteger(value) && value >= 0 && value <= 100 && Number.isSafeInteger(sequence) && sequence > device.sequence[channel]!, 'OUTPUT', '强度或指令顺序不正确。', 409);
    device.sequence[channel] = sequence; device.values[channel] = value; this.outputs++; this.record('output', device.id);
  }
  play(actor: string, id: string, channel: number, epoch: number, pattern: Pattern): void {
    this.requireOwner(actor); const device = this.device(id); this.channel(device, channel, epoch);
    requireCondition(!this.playback, 'PLAYBACK_ACTIVE', '已有模式正在播放，请先取消。', 409);
    // Each run owns an immutable validated snapshot; edits never rewrite a running pattern.
    this.playback = { pattern: structuredClone(pattern), id: device.id, channel, epoch, status: 'playing', offsetMs: 0, started: this.now() };
    this.lastPlayback = null; this.record('play', device.id); this.tick();
  }
  private position(playback: Playback) {
    const totalMs = duration(playback.pattern);
    const elapsedMs = Math.min(totalMs, playback.offsetMs + (playback.status === 'playing' ? this.now() - playback.started : 0));
    const cycleMs = totalMs / playback.pattern.cycles;
    const cycle = Math.min(playback.pattern.cycles - 1, Math.floor(elapsedMs / cycleMs));
    let remainder = elapsedMs % cycleMs; let step = 0;
    for (; step < playback.pattern.steps.length - 1; step++) {
      const current = playback.pattern.steps[step]!;
      if (remainder < current.durationMs) break;
      remainder -= current.durationMs;
    }
    return { elapsedMs, totalMs, step, cycle };
  }
  playbackAction(actor: string, action: 'pause' | 'resume' | 'cancel'): void {
    this.requireOwner(actor); const playback = this.playback;
    requireCondition(playback, 'NO_PLAYBACK', '当前没有模式在播放。', 409);
    const device = this.device(playback.id);
    if (action === 'cancel') { this.invalidate(device); this.record('stop', device.id); return; }
    if (action === 'pause') {
      if (playback.status === 'paused') return;
      playback.offsetMs = this.position(playback).elapsedMs; playback.status = 'paused'; device.values[playback.channel] = 0; this.record('pause', device.id);
    } else {
      this.channel(device, playback.channel, playback.epoch);
      if (playback.status === 'playing') return;
      playback.started = this.now(); playback.status = 'playing'; this.record('resume', device.id); this.tick();
    }
  }
  stop(): void { this.check(); this.zero(); this.record('stop'); }
  tick(): void {
    if (this.closed) return; this.check();
    const playback = this.playback;
    if (!playback || playback.status === 'paused') return;
    const device = this.device(playback.id); const position = this.position(playback);
    if (position.elapsedMs >= position.totalMs) {
      this.invalidate(device); this.lastPlayback = 'completed'; this.record('complete', device.id); return;
    }
    const value = playback.pattern.steps[position.step]!.value;
    if (device.values[playback.channel] !== value) { device.values[playback.channel] = value; this.outputs++; }
  }
  snapshot(actor: string): StudioState {
    this.tick();
    const playback = this.playback;
    return {
      simulation: true, control: { mine: this.owner?.id === actor, busy: this.owner !== null, leaseRemainingMs: Math.max(0, Math.round((this.owner?.expires ?? 0) - this.now())) },
      devices: structuredClone(this.devices),
      playback: playback ? { status: playback.status, deviceId: playback.id, channel: playback.channel, patternId: playback.pattern.id, name: playback.pattern.name, ...this.position(playback) } : null,
      lastPlayback: this.lastPlayback, history: structuredClone(this.history),
      resources: { timers: this.timer ? 1 : 0, historySize: this.history.length, historyLimit: limits.history, outputCommands: this.outputs, activePlaybacks: playback ? 1 : 0 },
    };
  }
  close(): void {
    if (this.closed) return;
    this.zero(); this.owner = null; this.closed = true;
    if (this.timer) clearInterval(this.timer); this.timer = undefined; this.record('shutdown');
  }
}
