import type { DeviceState, Snapshot } from '../contracts.ts';
import { createChecks } from './checks.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id); if (!element) throw new Error(`Missing element: ${id}`); return element as T;
};
let csrf = '';
let state: Snapshot | null = null;
let connectedStream = false;
let sequence = 0;
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; command: { id: string; feature: number; value: number; epoch: number; seq: number } }>();
const cards = new Map<string, HTMLElement>();
const checks = createChecks({ state: () => state, post, fail: alert });
function alert(message: string, kind: 'error' | 'success' = 'error'): void { $('alert').textContent = message; $('alert').dataset.kind = kind; $('alert').hidden = false; }
function clearPending(id?: string): void {
  for (const [key, job] of pending) if (!id || job.command.id === id) { clearTimeout(job.timer); pending.delete(key); }
}
async function post(path: string, input: unknown = {}, quiet = false): Promise<unknown> {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(input), keepalive: path === 'disconnect' });
  const data = await response.json() as { error?: { message: string }; state?: Snapshot };
  if (!response.ok) {
    const message = data.error?.message ?? '操作未完成。'; if (!quiet) alert(message); throw new Error(message);
  }
  if (data.state) render(data.state);
  return data;
}
function action(work: () => Promise<unknown>): void { $('alert').hidden = true; void work().catch(error => alert(error instanceof Error ? error.message : '操作未完成。')); }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag); item.className = className; item.textContent = text; return item;
}
function makeCard(device: DeviceState): HTMLElement {
  const card = element('article', 'device-card'); card.dataset.id = device.id;
  const header = element('div', 'device-header');
  const title = element('div', ''); title.append(element('h3', '', device.name), element('p', 'device-subtitle', `${device.features.length} 个可用振动电机`));
  const arm = element('button', 'button arm-button', '启用控制'); arm.type = 'button'; arm.dataset.action = 'arm';
  arm.addEventListener('click', () => action(() => post('arm', { id: device.id })));
  header.append(title, arm); card.append(header);
  for (const feature of device.features) {
    const row = element('div', 'feature');
    const line = element('div', 'feature-line');
    const label = element('label', '', feature.label); const input = element('input', '');
    input.type = 'range'; input.min = '0'; input.max = '100'; input.step = '1'; input.value = '0';
    input.id = `control-${device.id}-${feature.index}`; input.dataset.feature = String(feature.index); label.htmlFor = input.id;
    const output = element('output', '', '0%'); output.htmlFor = input.id;
    line.append(label, output); row.append(line, input); card.append(row);
    input.addEventListener('pointerdown', () => { input.dataset.dragging = 'true'; });
    input.addEventListener('pointerup', () => { delete input.dataset.dragging; });
    input.addEventListener('blur', () => { delete input.dataset.dragging; });
    input.addEventListener('input', () => {
      output.value = `${input.value}%`;
      const current = state?.devices.find(item => item.id === device.id);
      if (!current?.armed || !state?.canControl || !connectedStream) return;
      const key = `${device.id}/${feature.index}`;
      const command = { id: device.id, feature: feature.index, value: Number(input.value) / 100, epoch: current.epoch, seq: ++sequence };
      const old = pending.get(key);
      if (old) old.command = command;
      else pending.set(key, { command, timer: setTimeout(() => {
        const job = pending.get(key); pending.delete(key);
        if (job && state?.devices.some(item => item.id === device.id && item.armed && item.epoch === job.command.epoch)) action(() => post('output', job.command));
      }, 100) });
    });
  }
  if (device.otherCapabilities.length) card.append(element('p', 'unsupported', '设备还有其他能力，当前阶段仅开放振动控制。'));
  if (!device.features.length) card.append(element('p', 'unsupported', '当前设备暂无可用的振动电机。'));
  const footer = element('div', 'device-footer');
  const receipt = element('span', 'receipt', '尚未启用控制'); receipt.dataset.receipt = 'true';
  const stop = element('button', 'button danger stop-device', '停止'); stop.type = 'button';
  stop.addEventListener('click', () => { clearPending(device.id); action(() => post('stop-device', { id: device.id })); });
  const exercise = element('button', 'button secondary-button exercise-button', '首个电机短测（10% · 0.5秒）'); exercise.type = 'button'; exercise.dataset.exercise = 'true';
  exercise.addEventListener('click', () => {
    clearPending(device.id);
    action(async () => {
      const current = state?.devices.find(item => item.id === device.id); if (!current?.armed || !current.features[0]) return;
      const data = await post('exercise', { id: current.id, feature: current.features[0].index, value: .1, epoch: current.epoch, seq: ++sequence }) as { test: { result: string } };
      alert(data.test.result === 'acknowledged' ? `${state?.mode === 'demo' ? '模拟测试完成。' : '测试指令和停止回执已确认，请观察实物是否正常停止。'}需要再次操作时，请重新启用控制。`
        : data.test.result === 'cancelled' ? '短时测试已停止。' : '短时测试结果未确认，请检查设备并使用机身按键停止。', data.test.result === 'unconfirmed' ? 'error' : 'success');
    });
  });
  const buttons = element('div', 'device-actions'); buttons.append(exercise, stop);
  footer.append(receipt, buttons); card.append(footer); return card;
}
function render(next: Snapshot): void {
  if (state && next.revision < state.revision) return;
  state = next;
  checks.onState(state);
  const ready = state.phase === 'ready'; const busy = state.phase === 'connecting' || state.phase === 'disconnecting';
  $('connection-status').textContent = ({ idle: '未连接', connecting: '正在连接', ready: '已连接', disconnecting: '正在断开', fault: '连接异常' })[state.phase];
  $('device-count').textContent = `${state.devices.length} 台`;
  $('environment').textContent = state.mode === 'demo' ? '模拟设备' : state.mode === 'intiface' ? '真实连接' : '等待选择';
  $('connection-message').textContent = state.message;
  $('mode-badge').textContent = state.mode === 'demo' ? '演示模式' : ready ? '本地连接' : '尚未连接';
  $('demo-notice').hidden = state.mode !== 'demo';
  const mayConnect = (state.phase === 'idle' || state.phase === 'fault') && state.devices.length === 0;
  $<HTMLButtonElement>('connect-real').disabled = !mayConnect || state.diagnosing;
  $<HTMLButtonElement>('connect-demo').disabled = !mayConnect || state.diagnosing;
  $<HTMLButtonElement>('scan').disabled = !state.canControl || state.scanning || state.mode === 'demo' || state.diagnosing;
  $('scan').textContent = state.scanning ? '搜索中…' : '搜索设备';
  $<HTMLButtonElement>('disconnect').disabled = state.phase === 'idle' || state.phase === 'disconnecting';
  $<HTMLButtonElement>('stop-all').disabled = !state.devices.length || busy;
  $('empty').hidden = state.devices.length > 0;
  for (const [id, card] of cards) if (!state.devices.some(device => device.id === id)) { clearPending(id); card.remove(); cards.delete(id); }
  for (const device of state.devices) {
    let card = cards.get(device.id);
    const signature = JSON.stringify([device.name, device.features, device.otherCapabilities]);
    if (!card || card.dataset.signature !== signature) {
      clearPending(device.id); const fresh = makeCard(device); fresh.dataset.signature = signature;
      if (card) card.replaceWith(fresh); else $('devices').append(fresh);
      card = fresh; cards.set(device.id, card);
    }
    const canOutput = state.canControl && connectedStream && device.armed && !device.testing && !state.diagnosing;
    const arm = card.querySelector<HTMLButtonElement>('[data-action="arm"]')!;
    arm.disabled = !state.canControl || !connectedStream || device.armed || !device.features.length || device.receipt === 'sending' || device.receipt === 'unconfirmed' || device.testing || state.diagnosing;
    card.querySelector<HTMLButtonElement>('[data-exercise]')!.disabled = !canOutput || device.receipt === 'sending';
    arm.textContent = device.armed ? '控制已启用' : '启用控制';
    arm.setAttribute('aria-pressed', String(device.armed));
    for (const input of card.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
      input.disabled = !canOutput;
      if (!canOutput || (!input.dataset.dragging && document.activeElement !== input && !pending.has(`${device.id}/${input.dataset.feature}`))) {
        input.value = String(Math.round((device.values[input.dataset.feature!] ?? 0) * 100));
        const output = input.parentElement!.querySelector('output')!; output.value = `${input.value}%`;
      }
    }
    if (!device.armed) clearPending(device.id);
    const receipt = card.querySelector<HTMLElement>('[data-receipt]')!;
    receipt.textContent = ({ idle: device.armed ? '可以调整强度' : '尚未启用控制', sending: '正在发送…', sent: '指令已发送', stopped: '停止指令已确认', unconfirmed: '停止结果未确认，请检查设备' })[device.receipt];
  }
}
$('connect-real').addEventListener('click', () => action(() => checks.connect('intiface')));
$('connect-demo').addEventListener('click', () => action(() => checks.connect('demo')));
$('scan').addEventListener('click', () => action(() => post('scan')));
$('disconnect').addEventListener('click', () => { clearPending(); action(() => post('disconnect')); });
$('stop-all').addEventListener('click', () => { clearPending(); action(() => post('stop')); });
document.addEventListener('visibilitychange', () => { if (document.hidden && state?.canControl) { clearPending(); void post('stop', {}, true).catch(() => undefined); } });
window.addEventListener('pagehide', () => { clearPending(); if (state?.canControl) void post('disconnect', {}, true).catch(() => undefined); });
try {
  const response = await fetch('/api/session');
  if (!response.ok) throw new Error('本地会话建立失败，请刷新页面。');
  const session = await response.json() as { csrf: string; state: Snapshot }; csrf = session.csrf; render(session.state);
  await checks.load();
  if (session.state.canControl) await post('stop');
  const events = new EventSource('/api/events');
  events.onmessage = event => { connectedStream = true; render(JSON.parse(event.data) as Snapshot); };
  events.onerror = () => {
    connectedStream = false; clearPending();
    if (state) render(state);
    if (state?.canControl) void post('stop', {}, true).catch(() => undefined);
    alert('实时连接已中断，正在重新连接。');
  };
  setInterval(() => { if (connectedStream && state?.canControl) void post('heartbeat', {}, true).catch(() => { connectedStream = false; clearPending(); if (state) render(state); }); }, 2000);
} catch (error) { alert(error instanceof Error ? error.message : '无法加载本地控制台。'); }
