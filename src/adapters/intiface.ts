import { ButtplugClient } from '@zendrex/buttplug.js';
import type { AdapterEvent, DeviceAdapter, DeviceInfo } from '../contracts.ts';
import { AppError, requireCondition } from '../core/errors.ts';

export function localEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('ENDPOINT', '连接地址格式不正确。'); }
  requireCondition(url.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
  'ENDPOINT', '第一阶段只连接本机的 Intiface 地址。');
  return url.href;
}
export class IntifaceAdapter implements DeviceAdapter {
  readonly mode = 'intiface' as const;
  private client: ButtplugClient;
  private listeners = new Set<(event: AdapterEvent) => void>();
  private removers: (() => void)[] = [];
  constructor(endpoint = 'ws://127.0.0.1:12345') {
    this.client = new ButtplugClient(localEndpoint(endpoint), {
      clientName: 'Haptic Bridge', autoReconnect: false, requestTimeout: 1500,
    });
    for (const event of ['device.added', 'device.removed', 'device.updated', 'device.list'] as const) {
      this.removers.push(this.client.on(event, () => this.emit({ type: 'devices', devices: this.devices() })));
    }
    this.removers.push(this.client.on('connection.disconnected', () => this.emit({ type: 'disconnected' })));
    this.removers.push(this.client.on('connection.error', () => undefined));
    this.removers.push(this.client.on('scan.started', () => this.emit({ type: 'scan', active: true })));
    this.removers.push(this.client.on('scan.finished', () => this.emit({ type: 'scan', active: false })));
  }
  async connect(): Promise<DeviceInfo[]> {
    const timer = setTimeout(() => this.client.dispose(), 5000);
    try { await this.client.connect(); await this.client.requestDeviceList(); return this.devices(); }
    finally { clearTimeout(timer); }
  }
  async scan(): Promise<void> { await this.client.startScanning(); }
  async stopScan(): Promise<void> { await this.client.stopScanning(); }
  async vibrate(id: string, feature: number, value: number): Promise<void> {
    const device = this.client.getDevice(Number(id));
    requireCondition(device, 'DEVICE_MISSING', '设备已断开。', 409);
    await device.vibrate([{ index: feature, value }]);
  }
  async stop(id?: string): Promise<void> {
    if (id === undefined) await this.client.stopAll();
    else {
      const device = this.client.getDevice(Number(id));
      requireCondition(device, 'DEVICE_MISSING', '设备已断开，停止结果无法确认。', 409);
      await device.stop();
    }
  }
  async disconnect(): Promise<void> {
    for (const remove of this.removers.splice(0)) remove();
    try { if (this.client.connected) await this.client.disconnect(); }
    finally { this.client.dispose(); this.listeners.clear(); }
  }
  subscribe(listener: (event: AdapterEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: AdapterEvent): void { for (const listener of this.listeners) listener(event); }
  private devices(): DeviceInfo[] {
    return this.client.devices.slice(0, 16).map(device => ({
      id: String(device.index), name: (device.displayName ?? device.name).slice(0, 100),
      model: device.name.slice(0, 100),
      features: device.features.outputs.filter(feature => feature.type === 'Vibrate').slice(0, 8)
        .map(feature => ({ index: feature.index, label: feature.description.slice(0, 80) || `电机 ${feature.index + 1}`, range: feature.range })),
      otherCapabilities: [...new Set([...device.features.outputs.filter(f => f.type !== 'Vibrate').map(f => f.type),
        ...device.features.inputs.map(f => f.type)])].slice(0, 16),
    }));
  }
}
