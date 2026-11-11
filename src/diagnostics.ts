import { randomUUID } from 'node:crypto';
import type { Mode, Snapshot } from './contracts.ts';
import type { Hub } from './core/hub.ts';
import { AppError, requireCondition } from './core/errors.ts';
import { recognizeVendor, vendorPlan, type Catalog, type VendorPlan } from './catalog.ts';

export interface CheckStep { id: string; label: string; result: 'passed' | 'pending' | 'failed'; detail: string }
export interface ConnectionReport {
  id: string; createdAt: string; outcome: 'passed' | 'needs-attention' | 'failed'; mode: Mode;
  evidence: 'synthetic' | 'protocol-only'; physicalVerified: false; outputAttempted: false;
  outputScope: 'vibration'; connectionMayRequestStop: true;
  catalogSha256: string; requestedVendor: VendorPlan; steps: CheckStep[];
  devices: { id: string; model: string; vendorId: string | null; vibrationFeatures: number }[];
}
export class Diagnostics {
  private hub: Hub;
  private catalog: Catalog;
  private reports = new Map<string, ConnectionReport>();
  constructor(hub: Hub, catalog: Catalog) { this.hub = hub; this.catalog = catalog; }
  latest(requester: string): ConnectionReport {
    const report = this.reports.get(requester);
    if (!report) throw new AppError('REPORT_MISSING', '请先运行一次连接检查。', 404);
    return structuredClone(report);
  }
  async run(requester: string, input: { mode: Mode; vendorId: string; allowScan: boolean }): Promise<ConnectionReport> {
    const plan = vendorPlan(this.catalog, input.vendorId);
    const release = this.hub.beginDiagnostics(requester);
    const report: ConnectionReport = { id: randomUUID(), createdAt: new Date().toISOString(), outcome: 'needs-attention', mode: input.mode,
      evidence: input.mode === 'demo' ? 'synthetic' : 'protocol-only', physicalVerified: false, outputAttempted: false,
      outputScope: 'vibration', connectionMayRequestStop: true,
      catalogSha256: this.catalog.sha256, requestedVendor: plan, steps: [], devices: [] };
    try {
      let state = this.hub.snapshot(requester);
      if (state.phase === 'ready') requireCondition(state.canControl && state.mode === input.mode, 'MODE_MISMATCH', '请先断开当前连接，再选择其他连接方式。', 409);
      else await this.hub.connect(requester, input.mode);
      this.hub.heartbeat(requester);
      report.steps.push({ id: 'transport', label: '连接程序', result: 'passed', detail: input.mode === 'demo' ? '已连接模拟设备环境。' : '本机 Intiface v4 握手及设备列表读取成功。' });
      state = this.hub.snapshot(requester);
      if (!state.devices.length && input.allowScan && input.mode === 'intiface') {
        await this.hub.scan(requester);
        await this.waitForScan(requester);
        state = this.hub.snapshot(requester);
        if (state.canControl && state.scanning) await this.hub.finishScan(requester);
      }
      state = this.hub.snapshot(requester);
      requireCondition(state.phase === 'ready' && state.canControl, 'OFFLINE', '检查期间连接已断开，请重新连接。', 409);
      report.devices = state.devices.map(device => ({ id: device.id, model: device.model ?? device.name,
        vendorId: input.mode === 'demo' ? null : recognizeVendor(this.catalog, device.model ?? device.name), vibrationFeatures: device.features.length }));
      const matching = input.vendorId === 'auto' ? report.devices : report.devices.filter(device => device.vendorId === input.vendorId);
      report.steps.push({ id: 'devices', label: '设备识别', result: matching.length ? 'passed' : 'pending',
        detail: matching.length ? `识别到 ${matching.length} 台${input.vendorId === 'auto' ? '' : plan.name}设备。` : '尚未识别到所选设备，请按品牌提示完成配对；未自动尝试其他设备。' });
      const supported = matching.filter(device => device.vibrationFeatures > 0);
      report.steps.push({ id: 'capabilities', label: '可用控制项', result: supported.length ? 'passed' : 'pending',
        detail: supported.length ? '已读取可用振动电机；检查不发送振动，新建连接时会请求停止。' : '尚未读取到可用振动功能。' });
      report.steps.push({ id: 'physical', label: '实机验收', result: 'pending', detail: input.mode === 'demo'
        ? '当前为模拟环境，不能据此确认任何品牌实机兼容。' : '连接诊断不等于动作与物理停止已验收；请在设备旁单独运行短时测试并观察。' });
      report.outcome = supported.length ? 'passed' : 'needs-attention';
    } catch (error) {
      report.outcome = 'failed';
      report.steps.push({ id: 'connection-error', label: '连接检查', result: 'failed',
        detail: error instanceof AppError ? error.message : '检查未完成，请查看本地连接程序。' });
    } finally { release(); }
    if (!this.reports.has(requester) && this.reports.size >= 16) this.reports.delete(this.reports.keys().next().value!);
    this.reports.set(requester, report);
    return structuredClone(report);
  }
  private waitForScan(requester: string): Promise<void> {
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); unsubscribe(); resolve(); };
      const timer = setTimeout(finish, 5000);
      const unsubscribe = this.hub.subscribe(() => {
        const state: Snapshot = this.hub.snapshot(requester);
        if (!state.canControl || !state.scanning || state.devices.length) finish();
      });
      const state = this.hub.snapshot(requester);
      if (!state.scanning || state.devices.length) finish();
    });
  }
}
