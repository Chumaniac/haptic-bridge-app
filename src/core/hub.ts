import type { AdapterEvent, DeviceAdapter, DeviceInfo, DeviceState, Mode, Snapshot } from '../contracts.ts';
import { AppError, requireCondition } from './errors.ts';
import { Dispatcher } from './dispatcher.ts';
import { setTimeout as delay } from 'node:timers/promises';

export class Hub {
  private factory: (mode: Mode) => DeviceAdapter;
  private adapter: DeviceAdapter | null = null;
  private unsubscribe: (() => void) | null = null;
  private phase: Snapshot['phase'] = 'idle';
  private mode: Mode | null = null;
  private owner: string | null = null;
  private devices = new Map<string, DeviceState>();
  private sequences = new Map<string, number>();
  private dispatcher: Dispatcher;
  private revision = 0;
  private generation = 0;
  private nextEpoch = 0;
  private scanning = false;
  private message = '选择一种连接方式开始。';
  private lastHeartbeat = 0;
  private listeners = new Set<() => void>();
  private watchdog: ReturnType<typeof setInterval>;
  private watchdogBusy = false;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = new Map<string, Promise<void>>();
  private exercises = new Map<string, AbortController>();
  private diagnosticLease: symbol | null = null;
  private disconnectTask: Promise<void> | null = null;
  private heartbeatTimeout: number;
  constructor(factory: (mode: Mode) => DeviceAdapter, options: { heartbeatTimeout?: number; interval?: number } = {}) {
    this.factory = factory;
    this.dispatcher = new Dispatcher(options.interval ?? 100);
    this.heartbeatTimeout = options.heartbeatTimeout ?? 6500;
    this.watchdog = setInterval(() => {
      if (this.owner && this.phase === 'ready' && performance.now() - this.lastHeartbeat > this.heartbeatTimeout && !this.watchdogBusy) {
        this.watchdogBusy = true;
        void this.disconnect().finally(() => { this.watchdogBusy = false; });
      }
    }, Math.min(500, this.heartbeatTimeout));
    this.watchdog.unref();
  }
  snapshot(requester?: string): Snapshot {
    return { phase: this.phase, mode: this.mode, scanning: this.scanning,
      devices: structuredClone([...this.devices.values()]), message: this.message,
      revision: this.revision, canControl: !!requester && this.owner === requester && this.phase === 'ready', diagnosing: this.diagnosticLease !== null };
  }
  get queueSize(): number { return this.dispatcher.size; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  heartbeat(requester: string): void { if (requester === this.owner) this.lastHeartbeat = performance.now(); }
  beginDiagnostics(requester: string): () => void {
    requireCondition(!this.diagnosticLease, 'DIAGNOSTIC_BUSY', '连接检查正在进行。', 409);
    requireCondition(!this.owner || this.owner === requester, 'NOT_OWNER', '请回到建立连接的浏览器操作。', 403);
    requireCondition(this.stopping.size === 0, 'STOPPING', '正在停止设备，请稍后再检查。', 409);
    requireCondition([...this.devices.values()].every(device => device.receipt !== 'unconfirmed'), 'STOP_UNCONFIRMED', '停止结果尚未确认，请先检查设备并重试停止。', 409);
    requireCondition([...this.devices.values()].every(device => !device.armed && !device.testing) && this.queueSize === 0,
      'OUTPUT_ACTIVE', '请先停止当前设备，再检查连接。', 409);
    const lease = Symbol('diagnostics'); this.diagnosticLease = lease; this.publish();
    return () => { if (this.diagnosticLease === lease) { this.diagnosticLease = null; this.publish(); } };
  }
  private publish(): void { this.revision++; for (const listener of this.listeners) listener(); }
  private own(requester: string): void {
    requireCondition(this.owner === requester, 'NOT_OWNER', '当前连接由另一个窗口管理。', 403);
    requireCondition(this.phase === 'ready' && this.adapter, 'OFFLINE', '请先连接设备。', 409);
  }
  async connect(requester: string, mode: Mode): Promise<void> {
    requireCondition(this.phase === 'idle' || this.phase === 'fault', 'BUSY', '请先断开当前连接。', 409);
    requireCondition(!this.adapter, 'BUSY', '请先断开异常连接，再重新连接。', 409);
    const generation = ++this.generation;
    const adapter = this.factory(mode);
    this.adapter = adapter; this.owner = requester; this.mode = mode; this.phase = 'connecting';
    this.lastHeartbeat = performance.now(); this.message = '正在连接…'; this.publish();
    this.unsubscribe = adapter.subscribe(event => { if (generation === this.generation) this.onAdapterEvent(event); });
    try {
      const devices = await adapter.connect();
      if (generation !== this.generation) { await adapter.disconnect(); throw new AppError('CANCELLED', '连接已取消。', 409); }
      await adapter.stop();
      if (generation !== this.generation) { await adapter.disconnect(); throw new AppError('CANCELLED', '连接已取消。', 409); }
      this.updateDevices(devices); this.phase = 'ready'; this.lastHeartbeat = performance.now();
      this.message = mode === 'demo' ? '演示模式：所有设备与输出均为模拟。' : '本地程序已连接。请主动搜索设备，并选择要控制的设备。';
      this.publish();
    } catch (error) {
      if (generation !== this.generation) throw error;
      this.unsubscribe?.(); this.unsubscribe = null;
      await adapter.disconnect().catch(() => undefined);
      this.adapter = null; this.owner = null; this.phase = 'fault';
      this.devices.clear(); this.message = '连接失败，请确认 Intiface 已启动并开启本机服务。'; this.publish();
      throw new AppError('CONNECT_FAILED', this.message, 503);
    }
  }
  async scan(requester: string): Promise<void> {
    this.own(requester);
    requireCondition(!this.scanning, 'SCANNING', '已经在搜索设备。', 409);
    await this.adapter!.scan();
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.adapter?.stopScan().catch(() => { this.message = '停止搜索未确认，请检查连接程序。'; this.publish(); });
    }, 10000);
    this.scanTimer.unref();
  }
  async arm(requester: string, id: string): Promise<void> {
    this.own(requester);
    requireCondition(!this.diagnosticLease, 'DIAGNOSTIC_BUSY', '连接检查完成后才可启用控制。', 409);
    const device = this.getDevice(id);
    requireCondition(!device.testing, 'TEST_RUNNING', '短时测试正在进行。', 409);
    requireCondition(device.receipt !== 'unconfirmed', 'STOP_UNCONFIRMED', '停止结果尚未确认，请检查设备并重试停止后再启用。', 409);
    requireCondition(!this.stopping.has(id), 'STOPPING', '正在停止设备，请稍后重新启用。', 409);
    requireCondition(device.features.length > 0, 'CAPABILITY', '此设备没有第一阶段支持的振动功能。', 409);
    if (device.armed) return;
    await this.dispatcher.barrier(id);
    this.own(requester);
    requireCondition(!this.diagnosticLease, 'DIAGNOSTIC_BUSY', '连接检查完成后才可启用控制。', 409);
    requireCondition(!this.stopping.has(id), 'STOPPING', '正在停止设备，请稍后重新启用。', 409);
    requireCondition(this.phase === 'ready' && this.devices.get(id) === device, 'OFFLINE', '设备连接已变化。', 409);
    if (device.armed) return;
    for (const key of this.sequences.keys()) if (key.startsWith(`${id}/`)) this.sequences.delete(key);
    this.dispatcher.allow(id); device.armed = true; device.epoch = ++this.nextEpoch; device.receipt = 'idle';
    this.publish();
  }
  async output(requester: string, command: { id: string; feature: number; value: number; epoch: number; seq: number }): Promise<'sent' | 'superseded'> {
    requireCondition(!this.exercises.has(command.id), 'TEST_RUNNING', '短时测试正在进行，请先停止。', 409);
    return this.performOutput(requester, command);
  }
  private async performOutput(requester: string, command: { id: string; feature: number; value: number; epoch: number; seq: number }): Promise<'sent' | 'superseded'> {
    this.own(requester);
    requireCondition(!this.diagnosticLease, 'DIAGNOSTIC_BUSY', '连接检查完成后才可操作。', 409);
    const device = this.getDevice(command.id);
    requireCondition(device.armed && device.epoch === command.epoch, 'DISARMED', '请重新启用设备控制。', 409);
    requireCondition(device.features.some(feature => feature.index === command.feature), 'CAPABILITY', '设备不支持此电机。');
    requireCondition(Number.isFinite(command.value) && command.value >= 0 && command.value <= 1, 'RANGE', '强度必须在 0 到 100% 之间。');
    const key = `${command.id}/${command.feature}`;
    requireCondition(Number.isSafeInteger(command.seq) && command.seq > (this.sequences.get(key) ?? 0), 'STALE', '已忽略过期或重复操作。', 409);
    this.sequences.set(key, command.seq);
    const adapter = this.adapter!;
    const generation = this.generation;
    try {
      return await this.dispatcher.submit(command.id, command.feature, async () => {
        requireCondition(generation === this.generation && this.devices.get(command.id) === device && device.armed && device.epoch === command.epoch,
          'STALE', '连接或控制权限已变化。', 409);
        device.receipt = 'sending'; this.publish();
        await adapter.vibrate(command.id, command.feature, command.value);
        if (device.epoch === command.epoch) { device.values[String(command.feature)] = command.value; device.receipt = 'sent'; this.publish(); }
      });
    } catch {
      if (this.devices.get(command.id) === device) await this.stopDevice(command.id);
      throw new AppError('OUTPUT_UNCONFIRMED', '操作未确认，已请求停止；请检查设备。', 503);
    }
  }
  stopDevice(id: string): Promise<void> {
    this.exercises.get(id)?.abort();
    const existing = this.stopping.get(id);
    if (existing) return existing;
    const stopping = this.performStop(id);
    this.stopping.set(id, stopping);
    void stopping.finally(() => this.stopping.delete(id)).catch(() => undefined);
    return stopping;
  }
  private async performStop(id: string): Promise<void> {
    const device = this.getDevice(id);
    device.armed = false; device.epoch = ++this.nextEpoch;
    device.receipt = 'sending'; this.publish();
    await this.dispatcher.barrier(id);
    try {
      requireCondition(this.adapter, 'OFFLINE', '连接已断开。', 409);
      await this.adapter.stop(id);
      device.values = {}; device.receipt = 'stopped';
    } catch { device.receipt = 'unconfirmed'; }
    this.publish();
  }
  async stopAll(): Promise<void> { await Promise.all([...this.devices.keys()].map(id => this.stopDevice(id))); }
  async finishScan(requester: string): Promise<void> {
    this.own(requester);
    const generation = this.generation;
    await this.adapter!.stopScan();
    if (generation === this.generation) {
      this.scanning = false; if (this.scanTimer) clearTimeout(this.scanTimer); this.scanTimer = null; this.publish();
    }
  }
  async exercise(requester: string, command: { id: string; feature: number; value: number; epoch: number; seq: number }): Promise<{ result: 'acknowledged' | 'cancelled' | 'unconfirmed'; physicalVerified: false }> {
    this.own(requester);
    requireCondition(!this.diagnosticLease, 'DIAGNOSTIC_BUSY', '连接检查完成后才可操作。', 409);
    const device = this.getDevice(command.id);
    requireCondition(device.armed && device.epoch === command.epoch, 'DISARMED', '请先启用设备控制。', 409);
    requireCondition(!this.exercises.has(command.id), 'TEST_RUNNING', '短时测试正在进行。', 409);
    requireCondition(Number.isFinite(command.value) && command.value > 0 && command.value <= .3, 'RANGE', '短时测试强度须大于0且不超过30%。');
    requireCondition(device.features.some(feature => feature.index === command.feature), 'CAPABILITY', '设备不支持此电机。');
    requireCondition(Number.isSafeInteger(command.seq) && command.seq > (this.sequences.get(`${command.id}/${command.feature}`) ?? 0), 'STALE', '已忽略过期或重复操作。', 409);
    const controller = new AbortController(); this.exercises.set(command.id, controller); device.testing = true; this.publish();
    let finished = false; let failed = false;
    try {
      await this.dispatcher.barrier(command.id);
      requireCondition(!controller.signal.aborted && device.armed && device.epoch === command.epoch, 'CANCELLED', '测试已停止。', 409);
      this.dispatcher.allow(command.id);
      await this.performOutput(requester, command);
      await delay(500, undefined, { signal: controller.signal });
      finished = true;
    } catch (error) {
      failed = !(error instanceof Error && (error.name === 'AbortError' || (error instanceof AppError && error.code === 'CANCELLED')));
    }
    finally {
      this.exercises.delete(command.id); device.testing = false;
      if (this.devices.get(command.id) === device) await this.stopDevice(command.id);
    }
    const stopped = this.devices.get(command.id) === device && device.receipt === 'stopped';
    return { result: stopped && !failed ? finished ? 'acknowledged' : 'cancelled' : 'unconfirmed', physicalVerified: false };
  }
  async disconnect(requester?: string): Promise<void> {
    if (requester) requireCondition(!this.owner || this.owner === requester, 'NOT_OWNER', '当前连接由另一个窗口管理。', 403);
    if (this.disconnectTask) return this.disconnectTask;
    const task = this.performDisconnect(); this.disconnectTask = task;
    try { await task; }
    finally { if (this.disconnectTask === task) this.disconnectTask = null; }
  }
  private async performDisconnect(): Promise<void> {
    const adapter = this.adapter;
    ++this.generation; this.unsubscribe?.(); this.unsubscribe = null;
    this.phase = 'disconnecting'; this.owner = null;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null; this.publish();
    await this.stopAll();
    let disconnected = true;
    try { await adapter?.disconnect(); } catch { disconnected = false; }
    const unconfirmed = [...this.devices.values()].some(device => device.receipt === 'unconfirmed');
    for (const id of this.devices.keys()) this.dispatcher.forget(id);
    this.devices.clear(); this.sequences.clear(); this.adapter = null; this.scanning = false; this.mode = null;
    this.phase = disconnected ? 'idle' : 'fault';
    this.message = unconfirmed || !disconnected ? '已断开连接，部分停止结果未确认，请用设备按键检查。' : '连接已结束。再次连接需要重新启用控制。';
    this.publish();
  }
  async close(): Promise<void> { clearInterval(this.watchdog); await this.disconnect(); this.listeners.clear(); }
  private getDevice(id: string): DeviceState {
    const device = this.devices.get(id); requireCondition(device, 'DEVICE_MISSING', '设备已断开或不存在。', 404); return device;
  }
  private updateDevices(infos: DeviceInfo[]): void {
    const ids = new Set(infos.map(info => info.id));
    for (const id of this.devices.keys()) if (!ids.has(id)) {
      this.devices.get(id)!.armed = false; void this.dispatcher.barrier(id).then(() => this.dispatcher.forget(id)); this.devices.delete(id);
      for (const key of this.sequences.keys()) if (key.startsWith(`${id}/`)) this.sequences.delete(key);
    }
    for (const info of infos.slice(0, 16)) {
      const existing = this.devices.get(info.id);
      if (existing) {
        if (JSON.stringify(existing.features) !== JSON.stringify(info.features)) void this.stopDevice(info.id);
        Object.assign(existing, info);
      }
      else this.devices.set(info.id, { ...info, epoch: ++this.nextEpoch, armed: false, testing: false, values: {}, receipt: 'idle' });
    }
  }
  private onAdapterEvent(event: AdapterEvent): void {
    if (event.type === 'devices') this.updateDevices(event.devices);
    if (event.type === 'scan') this.scanning = event.active;
    if (event.type === 'disconnected') {
      if (this.scanTimer) clearTimeout(this.scanTimer);
      this.scanTimer = null;
      for (const device of this.devices.values()) { device.armed = false; device.epoch = ++this.nextEpoch; device.receipt = 'unconfirmed'; void this.dispatcher.barrier(device.id); }
      this.phase = 'fault'; this.owner = null; this.scanning = false;
      this.message = '设备连接已断开，停止结果未确认。请检查设备后重新连接。';
    }
    this.publish();
  }
}
