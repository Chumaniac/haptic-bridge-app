import type { AdapterEvent, DeviceAdapter, DeviceInfo } from '../contracts.ts';
import { AppError } from '../core/errors.ts';
export const demoDevices: DeviceInfo[] = [
  { id: 'demo-a', name: '演示设备 A', features: [{ index: 0, label: '主电机' }, { index: 1, label: '副电机' }], otherCapabilities: [] },
  { id: 'demo-b', name: '演示设备 B', features: [{ index: 0, label: '振动电机' }], otherCapabilities: ['Battery'] },
];
export class DemoAdapter implements DeviceAdapter {
  readonly mode = 'demo' as const;
  readonly calls: { action: string; id?: string; feature?: number; value?: number }[] = [];
  private listeners = new Set<(event: AdapterEvent) => void>();
  private connected = false;
  async connect(): Promise<DeviceInfo[]> { this.connected = true; return structuredClone(demoDevices); }
  async scan(): Promise<void> { this.emit({ type: 'scan', active: false }); }
  async stopScan(): Promise<void> { this.emit({ type: 'scan', active: false }); }
  async vibrate(id: string, feature: number, value: number): Promise<void> {
    if (!this.connected) throw new AppError('OFFLINE', '连接已断开。', 409);
    this.record({ action: 'vibrate', id, feature, value });
  }
  async stop(id?: string): Promise<void> { this.record(id ? { action: 'stop', id } : { action: 'stop' }); }
  async disconnect(): Promise<void> { this.connected = false; this.emit({ type: 'disconnected' }); }
  subscribe(listener: (event: AdapterEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private record(call: (typeof this.calls)[number]): void { this.calls.push(call); if (this.calls.length > 64) this.calls.shift(); }
  private emit(event: AdapterEvent): void { for (const listener of this.listeners) listener(event); }
}
