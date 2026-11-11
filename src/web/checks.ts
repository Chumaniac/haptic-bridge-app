import type { Mode, Snapshot } from '../contracts.ts';
import type { Catalog, VendorPlan } from '../catalog.ts';
import type { ConnectionReport } from '../diagnostics.ts';

interface Actions { state: () => Snapshot | null; post: (path: string, input?: unknown) => Promise<unknown>; fail: (message: string) => void }
const node = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
function text<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value: string): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag); item.className = className; item.textContent = value; return item;
}
export function createChecks(actions: Actions) {
  let catalog: (Catalog & { plans: VendorPlan[] }) | null = null;
  let busy = false;
  let visible = 20;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const select = node<HTMLSelectElement>('vendor');
  const check = node<HTMLButtonElement>('check-connection');
  const reportLink = node<HTMLAnchorElement>('download-report');
  function onState(state: Snapshot): void {
    const disabled = busy || state.diagnosing || state.phase === 'connecting' || state.phase === 'disconnecting';
    select.disabled = disabled;
    node<HTMLInputElement>('allow-scan').disabled = disabled;
    check.disabled = disabled || state.devices.some(device => device.armed || device.testing || device.receipt === 'unconfirmed' || device.receipt === 'sending') || (state.phase === 'ready' && !state.canControl);
    check.textContent = disabled ? '正在检查…' : '检查当前连接';
  }
  function guidance(): void {
    const plan = catalog?.plans.find(item => item.id === select.value);
    const list = node('vendor-guidance'); list.replaceChildren();
    for (const line of plan?.guidance ?? ['自动识别设备，按设备实际能力选择连接方式。']) list.append(text('li', '', line));
  }
  function renderReport(report: ConnectionReport): void {
    node('diagnostic-report').hidden = false;
    node('report-title').textContent = report.outcome === 'passed' ? '连接检查通过' : report.outcome === 'failed' ? '连接检查未完成' : '还需要完成设备配对';
    node('report-evidence').textContent = report.evidence === 'synthetic' ? '模拟检查 · 实机待验' : '通信检查 · 实机待验';
    const list = node('check-results'); list.replaceChildren();
    for (const step of report.steps) {
      const item = text('li', `check-step ${step.result}`, '');
      const label = text('strong', '', step.label); const status = text('span', 'check-status', ({ passed: '通过', pending: '待确认', failed: '未通过' })[step.result]);
      const heading = text('div', 'check-heading', ''); heading.append(label, status);
      item.append(heading, text('p', '', step.detail)); list.append(item);
    }
    reportLink.hidden = false;
  }
  async function connect(mode: Mode): Promise<void> {
    busy = true; if (actions.state()) onState(actions.state()!);
    try {
      const data = await actions.post('diagnostics', { mode, vendorId: select.value, allowScan: node<HTMLInputElement>('allow-scan').checked }) as { report: ConnectionReport };
      renderReport(data.report);
      if (data.report.outcome === 'failed') actions.fail(data.report.steps.at(-1)?.detail ?? '连接检查未完成。');
    } finally { busy = false; if (actions.state()) onState(actions.state()!); }
  }
  function renderCatalog(): void {
    if (!catalog) return;
    const query = node<HTMLInputElement>('catalog-search').value.trim().toLocaleLowerCase();
    const records = catalog.protocols.filter(protocol => {
      const brand = catalog!.profiles.find(profile => profile.protocolIds.includes(protocol.id));
      return !query || protocol.id.includes(query) || brand?.name.toLocaleLowerCase().includes(query) || protocol.models.some(model => model.toLocaleLowerCase().includes(query));
    });
    node('catalog-summary').textContent = `${catalog.profiles.length} 个品牌组 · ${catalog.protocolEntries} 条协议资料 · 实机待验收`;
    node('catalog-count').textContent = `找到 ${records.length} 条资料，显示 ${Math.min(visible, records.length)} 条`;
    const list = node('catalog-records'); list.replaceChildren();
    for (const protocol of records.slice(0, visible)) {
      const row = text('li', 'catalog-record', '');
      const content = text('div', '', '');
      content.append(text('strong', '', protocol.models[0] ?? protocol.id), text('p', '', `${protocol.models.length} 条设备名称记录`));
      row.append(content, text('span', 'badge', '待实机验证')); list.append(row);
    }
    node<HTMLButtonElement>('catalog-more').hidden = records.length <= visible;
  }
  select.addEventListener('change', guidance);
  check.addEventListener('click', () => { void connect(actions.state()?.mode ?? 'intiface').catch(error => actions.fail(error instanceof Error ? error.message : '检查未完成。')); });
  node('catalog-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { visible = 20; renderCatalog(); }, 150); });
  node('catalog-more').addEventListener('click', () => { visible += 20; renderCatalog(); });
  window.addEventListener('pagehide', () => clearTimeout(searchTimer));
  return { onState, connect,
    async load(): Promise<void> {
      const response = await fetch('/api/vendors'); if (!response.ok) throw new Error('无法加载兼容资料，请刷新页面。');
      catalog = await response.json() as Catalog & { plans: VendorPlan[] };
      for (const profile of catalog.profiles) { const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.name; select.append(option); }
      guidance(); renderCatalog();
    },
  };
}
