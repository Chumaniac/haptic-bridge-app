import { androidWaveform } from './android-waveform.ts';
import type { StudioState } from '../core.ts';
import type { Persisted, PatternDraft, Library, Pattern } from '../schema.ts';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id); if (!element) throw new Error(`Missing local view: ${id}`); return element as T;
}
const input = (id: string) => el<HTMLInputElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
const button = (id: string) => el<HTMLButtonElement>(id);
function text(tag: string, content: string, className?: string): HTMLElement {
  const element = document.createElement(tag); element.textContent = content; if (className) element.className = className; return element;
}
type ResponseData = { state?: StudioState; library?: Persisted; revision?: number; session?: string; csrf?: string; error?: { code: string; message: string }; preview?: { patterns: number; steps: number } };
class RequestError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
let session = ''; let csrf = ''; let state: StudioState | null = null; let library: Persisted | null = null;
let draft: PatternDraft = { name: '新模式', cycles: 1, steps: [{ value: 20, durationMs: 1000 }] };
let draftRevision = 0; let preferencesRevision = 0; let dirty = false; let preferencesDirty = false;
let online = false; let busy = false; let generation = 0; let lastHeartbeat = 0; let lastEvent = -1;
let pollTimer: ReturnType<typeof setTimeout> | undefined; let outputTimer: ReturnType<typeof setTimeout> | undefined;
let outputRunning = false; let destroying = false; let hiddenReleased = false;
const pendingOutputs = new Map<string, { id: string; channel: number; epoch: number; sequence: number; value: number }>();
const sequences = new Map<string, number>();
const objectUrls = new Map<string, ReturnType<typeof setTimeout>>();
const deviceViews = new Map<string, HTMLElement>();
const translations: Record<string, string> = { claim: '获取本地控制权', release: '释放控制权', connect: '连接虚拟设备', disconnect: '断开虚拟设备', arm: '启用虚拟控制', output: '调整模拟强度', stop: '停止并锁定控制', play: '开始模式播放', pause: '暂停并归零', resume: '继续模式播放', complete: '播放完成并锁定', 'lease-expired': '会话失效并归零', shutdown: '关闭本地工作台', 'library-save': '模式已保存', 'library-delete': '模式已删除', import: '资料导入完成', preferences: '偏好已保存' };

function notify(message: string): void { el('notice').textContent = message; el('notice').hidden = false; }
function fail(error: unknown): void {
  el('error').textContent = error instanceof Error ? error.message : '操作失败，请重试。'; el('error').hidden = false;
}
function clearError(): void { el('error').hidden = true; }
function headers(json = false): Record<string, string> {
  return { 'x-studio-session': session, ...(json ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {}) };
}
async function request(path: string, data?: unknown, apply = true): Promise<ResponseData> {
  const expected = generation;
  const response = await fetch(path, { ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }), headers: headers(data !== undefined), cache: 'no-store', signal: AbortSignal.timeout(5000) });
  const result = await response.json() as ResponseData;
  if (!response.ok) {
    if (result.error?.code === 'SESSION') { online = false; state = null; clearOutputs(); renderState(); }
    throw new RequestError(result.error?.code ?? 'REQUEST', result.error?.message ?? '本地服务没有完成操作。');
  }
  if (expected === generation && apply) {
    if (result.state) state = result.state;
    if (result.library) acceptLibrary(result.library);
    renderState();
  }
  return result;
}
async function action(work: () => Promise<void>, message?: string): Promise<void> {
  if (busy) return; busy = true; clearError(); renderState();
  try { await work(); if (message) notify(message); } catch (error) { fail(error); }
  finally { busy = false; renderState(); }
}
function acceptLibrary(next: Persisted, initial = false): void {
  // A delayed poll must not replace a newer write; explicit reconnect accepts a new store.
  if (!initial && library && next.revision < library.revision) return;
  const previousRevision = library?.revision;
  library = next;
  if (previousRevision !== next.revision || initial) {
    const pickerValue = select('patterns').value; const playValue = select('play-pattern').value;
    for (const id of ['patterns', 'play-pattern']) {
      const picker = select(id); picker.replaceChildren();
      if (!next.data.patterns.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '模式库为空'; picker.append(option); }
      for (const pattern of next.data.patterns) { const option = document.createElement('option'); option.value = pattern.id; option.textContent = pattern.name; picker.append(option); }
    }
    if (next.data.patterns.some(item => item.id === pickerValue)) select('patterns').value = pickerValue;
    if (next.data.patterns.some(item => item.id === playValue)) select('play-pattern').value = playValue;
    el('library-summary').textContent = `已保存 ${next.data.patterns.length} / 20 个模式 · 资料版本 ${next.revision} · 保存在本机`;
    if (!preferencesDirty) renderPreferences();
    if (!dirty && !draft.id) draftRevision = next.revision;
    if (dirty && previousRevision !== undefined && previousRevision !== next.revision) notify('资料库已更新，编辑草稿已保留。若其他窗口修改了资料，请重新载入或另存为新模式。');
  }
}
function buildDeviceViews(): void {
  if (!state) return;
  for (const device of state.devices) {
    if (deviceViews.has(device.id)) continue;
    const fragment = (el<HTMLTemplateElement>('device-template').content.cloneNode(true)) as DocumentFragment;
    const card = fragment.querySelector<HTMLElement>('article')!; card.dataset.device = device.id;
    card.querySelector('[data-name]')!.textContent = device.name;
    const channels = card.querySelector('[data-channels]')!;
    for (let channel = 0; channel < device.values.length; channel++) {
      const row = text('div', '', 'device-channel'); const line = text('div', '', 'channel-line');
      const label = document.createElement('label'); label.htmlFor = `${device.id}-${channel}`; label.textContent = `虚拟通道 ${channel + 1}`;
      const output = document.createElement('output'); output.setAttribute('for', label.htmlFor); output.textContent = '0%';
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.value = '0'; slider.id = label.htmlFor; slider.dataset.channel = String(channel); slider.disabled = true;
      slider.addEventListener('input', () => {
        output.textContent = `${slider.value}%`;
        const current = state?.devices.find(item => item.id === device.id);
        if (!online || !state?.control.mine || !current?.armed || state.playback || busy) return;
        const key = `${device.id}:${channel}`; const seq = Math.max(sequences.get(key) ?? 0, current.sequence[channel] ?? 0) + 1; sequences.set(key, seq);
        pendingOutputs.set(key, { id: device.id, channel, value: Number(slider.value), epoch: current.epoch, sequence: seq }); scheduleOutput();
      });
      line.append(label, output); row.append(line, slider); channels.append(row);
    }
    card.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]'); if (!target || target.disabled) return;
      void action(async () => { if (target.dataset.action === 'stop' || target.dataset.action === 'disconnect') { generation++; clearOutputs(); } await request('/api/device', { id: device.id, action: target.dataset.action }); });
    });
    el('devices').append(fragment); deviceViews.set(device.id, card);
  }
}
function clearOutputs(): void {
  pendingOutputs.clear(); if (outputTimer) clearTimeout(outputTimer); outputTimer = undefined;
}
function scheduleOutput(): void {
  if (outputTimer || outputRunning || !pendingOutputs.size || destroying) return;
  outputTimer = setTimeout(() => { outputTimer = undefined; void flushOutput(); }, 100);
}
async function flushOutput(): Promise<void> {
  if (outputRunning || !online || !state?.control.mine || state.playback || busy || document.hidden) { clearOutputs(); return; }
  const item = pendingOutputs.entries().next().value;
  if (!item) return;
  pendingOutputs.delete(item[0]); outputRunning = true; const sentGeneration = generation;
  try { await request('/api/output', item[1]); }
  catch (error) { if (sentGeneration === generation) { clearOutputs(); fail(error); } }
  finally { outputRunning = false; scheduleOutput(); }
}
function renderState(): void {
  const mine = online && state?.control.mine === true;
  button('claim').disabled = !online || busy || !!state?.control.busy;
  button('release').disabled = !mine || busy;
  button('stop-all').disabled = !online;
  button('reconnect').hidden = online;
  el('control-status').textContent = !online ? '本地服务未连接' : mine ? '此窗口拥有本地控制权' : state?.control.busy ? '其他窗口正在控制，可查看或急停' : '只读状态，获取控制权后开始';
  el('lease').textContent = mine ? '页面可见时保持会话；离开页面停止并释放控制权。' : '每个页面独立会话，控制权不会自动转移。';
  buildDeviceViews();
  for (const [id, card] of deviceViews) {
    const device = state?.devices.find(item => item.id === id);
    card.querySelector('[data-connection]')!.textContent = !online ? '服务离线' : !device?.connected ? '未连接' : device.armed ? '已启用模拟控制' : '已连接 · 控制锁定';
    card.dataset.connection = !online ? 'offline' : !device?.connected ? 'disconnected' : device.armed ? 'armed' : 'locked';
    for (const actionName of ['connect', 'disconnect', 'arm', 'stop']) {
      const target = card.querySelector<HTMLButtonElement>(`[data-action="${actionName}"]`)!;
      target.disabled = !mine || busy || !device || (actionName === 'connect' ? device.connected : actionName === 'arm' ? !device.connected || device.armed : !device.connected);
    }
    for (const slider of card.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
      const channel = Number(slider.dataset.channel); slider.disabled = !mine || busy || !device?.armed || !!state?.playback;
      if (slider.disabled || (document.activeElement !== slider && !pendingOutputs.has(`${id}:${channel}`))) slider.value = String(online && device ? device.values[channel] : 0);
      slider.previousElementSibling!.querySelector('output')!.textContent = `${slider.value}%`;
    }
  }
  const playback = online ? state?.playback : null;
  const [targetId] = select('play-target').value.split(':'); const target = state?.devices.find(item => item.id === targetId);
  button('play').disabled = !mine || busy || !!playback || !target?.armed || !select('play-pattern').value;
  const requirement = !online ? '先重新连接本地服务。' : !mine ? '先获取本地控制权。' : busy ? '等待当前操作结束。' : playback ? '当前模式播放中，可暂停或取消。' : !select('play-pattern').value ? '先在编辑器保存一个模式。' : !target?.connected ? '先连接所选虚拟设备。' : !target.armed ? '先启用所选虚拟设备的控制。' : '条件已就绪，可播放所选的已保存模式。';
  if (el('play-requirement').textContent !== requirement) el('play-requirement').textContent = requirement;

  button('pause').disabled = !mine || busy || !playback; button('pause').textContent = playback?.status === 'paused' ? '继续播放' : '暂停';
  button('cancel-play').disabled = !mine || busy || !playback;
  el('play-status').textContent = playback ? `${playback.status === 'paused' ? '已暂停' : '正在播放'} · ${playback.name} · 第 ${playback.cycle + 1} 轮 / 第 ${playback.step + 1} 步` : state?.lastPlayback === 'completed' ? '播放完成，控制已锁定' : state?.lastPlayback === 'canceled' ? '播放已取消，控制已锁定' : '尚未播放';
  el('play-time').textContent = playback ? `${(playback.elapsedMs / 1000).toFixed(1)} / ${(playback.totalMs / 1000).toFixed(1)} 秒` : state?.lastPlayback === 'completed' ? '本次播放已完成' : state?.lastPlayback === 'canceled' ? '本次播放已取消' : '等待开始';
  el<HTMLProgressElement>('play-progress').value = playback ? playback.elapsedMs / playback.totalMs * 100 : state?.lastPlayback === 'completed' ? 100 : 0;
  for (const id of ['save-pattern', 'save-preferences', 'reset-preferences', 'import-library']) button(id).disabled = !mine || busy;
  button('delete-pattern').disabled = !mine || busy || !draft.id || !!playback;
  for (const id of ['export-library', 'export-diagnostics', 'refresh-library']) button(id).disabled = !online || busy;
  el('pattern-form').inert = busy; el('preferences-form').inert = busy;
  for (const id of ['new-pattern','load-pattern','duplicate-pattern']) button(id).disabled = busy;
  button('add-step').disabled = busy || draft.steps.length >= 64;
  el('draft-state').textContent = dirty ? '草稿 · 尚未保存' : draft.id ? '已载入保存模式' : '新模式';
  if (state && lastEvent !== (state.history.at(-1)?.number ?? 0)) {
    lastEvent = state.history.at(-1)?.number ?? 0;
    el('history').replaceChildren(...filteredHistory().slice().reverse().map(item => text('li', `${new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })} · ${translations[item.code] ?? '本地操作'}${item.device === 'virtual-one' ? ' · 单通道设备' : item.device === 'virtual-duo' ? ' · 双通道设备' : ''}`)));
    if (!filteredHistory().length) el('history').append(text('li', '当前筛选没有操作记录。'));
    el('history-count').textContent = `当前显示 ${filteredHistory().length} / ${state.history.length} 条；重启后清空。`;
  }
  el('resource-summary').textContent = state ? `历史 ${state.resources.historySize} / ${state.resources.historyLimit} 条 · 活动播放 ${state.resources.activePlaybacks} · 模拟输出 ${state.resources.outputCommands} 次` : '服务离线，所有控制已禁用。';
}
function filteredHistory(): StudioState['history'] {
  return (state?.history ?? []).filter(item => (!select('history-device').value || item.device === select('history-device').value) && (!select('history-action').value || item.code === select('history-action').value));
}
for (const id of ['history-device', 'history-action']) select(id).addEventListener('change', () => { lastEvent = -1; renderState(); });
button('export-history').addEventListener('click', () => {
  if (!online || !state) { fail(new Error('服务离线，无法导出当前记录。')); return; }
  const rows = filteredHistory();
  download(new Blob([JSON.stringify({schema:'haptic.studio-session/v1',simulation:true,exportedAt:new Date().toISOString(),history:rows},null,2)],{type:'application/json'}),'haptic-session-history.json');
  notify(`已导出 ${rows.length} 条虚拟设备记录，不含会话凭据。`);
});
function readDraft(): PatternDraft {
  return { ...(draft.id ? { id: draft.id } : {}), name: input('pattern-name').value.trim(), cycles: Number(input('pattern-cycles').value), steps: draft.steps.map(step => ({ ...step })) };
}
function updatePreview(): void {
  draft = readDraft();
  const total = draft.steps.reduce((sum, step) => sum + step.durationMs, 0) * draft.cycles;
  el('total-duration').textContent = Number.isFinite(total) ? `${draft.steps.length} 步 · 合计 ${(total / 1000).toFixed(1)} 秒` : `${draft.steps.length} 步 · 总时长待核对`;
  input('pattern-cycles').setCustomValidity(Number.isFinite(total) && total <= 600000 ? '' : '总时长不能超过十分钟。');
  const bars = draft.steps.map((step, index) => {
    const bar = text('span', ''); bar.style.setProperty('--strength', String(Math.min(100, Math.max(0, step.value || 0)))); bar.style.setProperty('--duration', String(step.durationMs || 100)); bar.title = `第 ${index + 1} 步：${step.value}% · ${step.durationMs / 1000} 秒`;
    if (draft.steps.length <= 8) {
      const value = text('b', Number.isFinite(step.value) ? `${step.value}%` : '—', 'timeline-value'); value.setAttribute('aria-hidden', 'true'); bar.append(value);
    }
    return bar;
  });
  el('timeline').replaceChildren(...bars); button('add-step').disabled = draft.steps.length >= 64;
}
function renderEditor(): void {
  input('pattern-name').value = draft.name; input('pattern-cycles').value = String(draft.cycles);
  const rows = draft.steps.map((step, index) => {
    const row = text('div', '', 'step-row'); row.append(text('span', String(index + 1)));
    for (const kind of ['value', 'durationMs'] as const) {
      const field = document.createElement('input'); field.type = 'number'; field.required = true;
      field.min = kind === 'value' ? '0' : '0.1'; field.max = kind === 'value' ? '100' : '30'; field.step = kind === 'value' ? '1' : '0.1'; field.value = String(kind === 'value' ? step.value : step.durationMs / 1000);
      field.setAttribute('aria-label', `第 ${index + 1} 步${kind === 'value' ? '强度' : '时长（秒）'}`);
      field.addEventListener('input', () => { draft.steps[index]![kind] = kind === 'value' ? field.valueAsNumber : Math.round(field.valueAsNumber * 1000); dirty = true; updatePreview(); renderState(); }); row.append(field);
    }
    const actions = text('div', '', 'step-actions');
    for (const operation of ['up', 'down', 'remove'] as const) {
      const target = document.createElement('button'); target.type = 'button'; target.textContent = operation === 'up' ? '↑' : operation === 'down' ? '↓' : '×';
      target.setAttribute('aria-label', `第 ${index + 1} 步${operation === 'up' ? '上移' : operation === 'down' ? '下移' : '删除'}`);
      target.disabled = operation === 'up' ? index === 0 : operation === 'down' ? index === draft.steps.length - 1 : draft.steps.length === 1;
      target.addEventListener('click', () => {
        draft = readDraft();
        if (operation === 'remove') draft.steps.splice(index, 1);
        else { const next = index + (operation === 'up' ? -1 : 1); [draft.steps[index], draft.steps[next]] = [draft.steps[next]!, draft.steps[index]!]; }
        dirty = true; renderEditor(); renderState();
      }); actions.append(target);
    }
    row.append(actions); return row;
  });
  el('steps').replaceChildren(...rows); updatePreview(); renderState();
}
function renderPreferences(): void {
  if (!library) return;
  input('default-intensity').value = String(library.data.preferences.defaultIntensity);
  input('default-duration').value = String(library.data.preferences.defaultDurationMs / 1000);
  preferencesRevision = library.revision;
}
async function confirmAction(title: string, detail: string, label: string): Promise<boolean> {
  const dialog = el<HTMLDialogElement>('confirm-dialog'); if (dialog.open) return false;
  el('confirm-title').textContent = title; el('confirm-detail').textContent = detail; button('confirm-yes').textContent = label;
  return new Promise(resolve => {
    const finish = (accepted: boolean) => { button('confirm-yes').removeEventListener('click', yes); button('confirm-no').removeEventListener('click', no); dialog.removeEventListener('cancel', cancel); dialog.close(); resolve(accepted); };
    const yes = () => finish(true); const no = () => finish(false); const cancel = (event: Event) => { event.preventDefault(); finish(false); };
    button('confirm-yes').addEventListener('click', yes); button('confirm-no').addEventListener('click', no); dialog.addEventListener('cancel', cancel); dialog.showModal(); button('confirm-no').focus();
  });
}
async function discardDraft(): Promise<boolean> { return !dirty || await confirmAction('替换未保存的草稿？', '当前编辑尚未保存。继续会用所选内容替换编辑器。已保存模式不受影响。', '替换草稿'); }
function loadPattern(pattern?: Pattern): void {
  const preferences = library?.data.preferences ?? { defaultIntensity: 20, defaultDurationMs: 1000 };
  draft = pattern ? structuredClone(pattern) : { name: '新模式', cycles: 1, steps: [{ value: preferences.defaultIntensity, durationMs: preferences.defaultDurationMs }] };
  dirty = false; draftRevision = library?.revision ?? 0; renderEditor();
}
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  const timer = setTimeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url); }, 1000); objectUrls.set(url, timer);
}
async function downloadFrom(path: string, filename: string): Promise<void> {
  const response = await fetch(path, { headers: headers(), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('导出失败，请重新连接本地服务。');
  download(await response.blob(), filename);
}

interface CatalogData { fetchedAt: string; profiles: { id: string; name: string; source: string; models: string[]; tools: string[]; connectionMethods: string[] }[] }
let catalog: CatalogData | null = null; let catalogLimit = 6;
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s_-]/g, '');
const aliases: Record<string, string[]> = { monsterpub: ['小怪兽', 'monsterpub', 'sistalk'], 'we-vibe': ['wevibe'], muse: ['lovespouse'], tryfun: ['春风'] };
function renderCatalog(): void {
  if (!catalog) return;
  const query = normalized(input('catalog-search').value.trim()); el('catalog-results').replaceChildren();
  if (/^\d+$/.test(query)) { el('catalog-summary').textContent = '这里只接受品牌或型号名称，不处理数字码。'; button('catalog-more').hidden = true; return; }
  const records = catalog.profiles.filter(profile => !query || [profile.name, profile.id, ...(aliases[profile.id] ?? []), ...profile.models].some(value => normalized(value).includes(query)));
  el('catalog-summary').textContent = `找到 ${records.length} 组品牌资料 · 显示 ${Math.min(records.length, catalogLimit)} 组 · 资料快照 ${catalog.fetchedAt.slice(0, 10)}`;
  for (const profile of records.slice(0, catalogLimit)) {
    const card = text('article', '', 'catalog-record'); card.append(text('h3', profile.name), text('p', '公开目录记录 · 实机未验证'));
    const matches = profile.models.filter(model => !query || normalized(model).includes(query));
    const names = (matches.length ? matches : profile.models).slice(0, 8); const list = document.createElement('ul');
    for (const name of names) list.append(text('li', name)); card.append(list);
    card.append(text('p', `相关软件：${profile.tools.join('；')}`));
    card.append(text('p', `公开记录的连接方式：${profile.connectionMethods.join('；')}。具体型号仍需核对。`));
    const source = new URL(profile.source);
    if (source.protocol === 'https:') { const link = document.createElement('a'); link.href = source.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看公开来源'; card.append(link); }
    el('catalog-results').append(card);
  }
  button('catalog-more').hidden = records.length <= catalogLimit;
  if (!records.length) el('catalog-results').append(text('p', '没有匹配资料。可以尝试品牌英文名或更短的型号名称。', 'hint'));
}

button('claim').addEventListener('click', () => void action(async () => { await request('/api/control', { action: 'claim' }); lastHeartbeat = 0; }, '已获取此窗口的本地控制权。'));
button('release').addEventListener('click', () => void action(async () => { generation++; clearOutputs(); await request('/api/control', { action: 'release' }); }, '控制权已释放，所有模拟输出归零。'));
button('stop-all').addEventListener('click', () => {
  generation++; clearOutputs();
  for (const card of deviceViews.values()) for (const slider of card.querySelectorAll<HTMLInputElement>('input[type="range"]')) { slider.disabled = true; slider.value = '0'; }
  void request('/api/stop', {}).then(() => notify('已急停，所有虚拟设备归零并锁定。')).catch(fail);
});
button('load-pattern').addEventListener('click', () => void (async () => { if (!busy && await discardDraft() && !busy) { const pattern = library?.data.patterns.find(item => item.id === select('patterns').value); if (pattern) loadPattern(pattern); } })());
button('new-pattern').addEventListener('click', () => void (async () => { if (!busy && await discardDraft() && !busy) loadPattern(); })());
button('refresh-library').addEventListener('click', () => void action(async () => { const result = await request('/api/library', undefined, false) as unknown as Persisted; acceptLibrary(result); }, '已刷新保存资料，未保存的草稿保留。'));
for (const id of ['pattern-name', 'pattern-cycles']) input(id).addEventListener('input', () => { dirty = true; updatePreview(); renderState(); });
button('add-step').addEventListener('click', () => {
  if (busy || draft.steps.length >= 64) return; draft = readDraft(); const preferences = library?.data.preferences ?? { defaultIntensity: 20, defaultDurationMs: 1000 };
  draft.steps.push({ value: preferences.defaultIntensity, durationMs: preferences.defaultDurationMs }); dirty = true; renderEditor();
});
button('duplicate-pattern').addEventListener('click', () => { if (busy) return; draft = readDraft(); delete draft.id; draft.name = `${draft.name} 副本`.slice(0, 48); draftRevision = library?.revision ?? 0; dirty = true; renderEditor(); notify('已创建副本草稿，点击保存模式后写入本地。'); });
el<HTMLFormElement>('pattern-form').addEventListener('submit', event => {
  event.preventDefault(); if (!el<HTMLFormElement>('pattern-form').reportValidity()) return;
  void action(async () => {
    const before = new Set(library?.data.patterns.map(item => item.id)); const savedDraft = readDraft();
    const result = await request('/api/library/save', { revision: draftRevision, pattern: savedDraft }, false);
    if (!result.library) throw new Error('没有收到保存结果。');
    dirty = false; acceptLibrary(result.library); if (result.state) state = result.state;
    const saved = result.library.data.patterns.find(item => savedDraft.id ? item.id === savedDraft.id : !before.has(item.id));
    if (saved) { loadPattern(saved); select('patterns').value = saved.id; select('play-pattern').value = saved.id; }
  }, '模式已保存到本机文件。');
});
button('delete-pattern').addEventListener('click', () => void (async () => {
  const id = draft.id; if (!id || !await confirmAction('删除这个已保存模式？', '此操作会移除本地模式库里的这一项。需要保留时，请先导出模式库。', '删除模式')) return;
  await action(async () => { await request('/api/library/delete', { revision: library?.revision, id }); loadPattern(); }, '模式已删除。');
})());
select('play-target').addEventListener('change', renderState); select('play-pattern').addEventListener('change', renderState);
button('play').addEventListener('click', () => void action(async () => {
  generation++; clearOutputs(); const [id, channel] = select('play-target').value.split(':'); const device = state?.devices.find(item => item.id === id);
  await request('/api/play', { id, channel: Number(channel), epoch: device?.epoch, patternId: select('play-pattern').value });
}));
button('pause').addEventListener('click', () => void action(async () => { await request('/api/playback', { action: state?.playback?.status === 'paused' ? 'resume' : 'pause' }); }));
button('cancel-play').addEventListener('click', () => void action(async () => { generation++; clearOutputs(); await request('/api/playback', { action: 'cancel' }); }));
button('export-android').addEventListener('click', () => {
  try {
    const current = readDraft();
    const params = androidWaveform(current.steps, current.cycles);
    download(new Blob([JSON.stringify(params,null,2)], {type:'application/json'}), 'android-waveform.json');
    notify('已导出当前草稿的 Android 波形参数。');
  } catch (error) { fail(error); }
});
button('export-library').addEventListener('click', () => void action(async () => { await downloadFrom('/api/export', 'haptic-studio-library.json'); }, '模式库已导出。导出文件包含自定义名称和设置，请自行保管。'));
button('export-diagnostics').addEventListener('click', () => void action(async () => { await downloadFrom('/api/diagnostics', 'haptic-studio-diagnostics.json'); }, '已导出脱敏诊断。'));
button('import-library').addEventListener('click', () => input('import-file').click());
input('import-file').addEventListener('change', () => void (async () => {
  clearError();
  const file = input('import-file').files?.[0]; input('import-file').value = ''; if (!file) return;
  if (file.size > 131072) { fail(new Error('文件不能超过 128 KiB。')); return; }
  let data: Library;
  try {
    data = JSON.parse(await file.text()) as Library;
    const result = await request('/api/import/preview', { data }, false);
    const revision = library?.revision;
    const accepted = await confirmAction('替换本地模式库与偏好？', `文件含 ${result.preview?.patterns ?? 0} 个模式、${result.preview?.steps ?? 0} 个步骤。确认后替换当前模式库和偏好；未保存草稿保留。建议先导出当前资料。`, '确认导入并替换');
    if (accepted) await action(async () => { await request('/api/import', { revision, data }); }, '导入完成。没有连接设备或恢复播放。');
  } catch (error) { fail(error instanceof SyntaxError ? new Error('文件不是有效 JSON，已有资料没有改变。') : error); }
})());
for (const id of ['default-intensity', 'default-duration']) input(id).addEventListener('input', () => { preferencesDirty = true; });
el<HTMLFormElement>('preferences-form').addEventListener('submit', event => {
  event.preventDefault(); if (!el<HTMLFormElement>('preferences-form').reportValidity()) return;
  void action(async () => {
    const result = await request('/api/preferences', { revision: preferencesRevision, preferences: { defaultIntensity: input('default-intensity').valueAsNumber, defaultDurationMs: Math.round(input('default-duration').valueAsNumber * 1000) } }, false);
    preferencesDirty = false; if (result.library) acceptLibrary(result.library); renderPreferences(); if (result.state) state = result.state;
  }, '偏好已保存，新建步骤时生效。');
});
button('reset-preferences').addEventListener('click', () => void (async () => {
  if (!await confirmAction('恢复默认偏好？', '新建步骤恢复为 20% 强度、1 秒时长。模式库和编辑草稿保持。', '恢复默认')) return;
  await action(async () => { const result = await request('/api/preferences/reset', { revision: library?.revision }, false); preferencesDirty = false; if (result.library) acceptLibrary(result.library); renderPreferences(); if (result.state) state = result.state; }, '默认偏好已恢复。');
})());
input('catalog-search').addEventListener('input', () => { catalogLimit = 6; renderCatalog(); });
button('catalog-more').addEventListener('click', () => { catalogLimit += 6; renderCatalog(); });

async function bootstrap(): Promise<void> {
  clearError();
  try {
    const response = await fetch('/api/session', { headers: headers(), signal: AbortSignal.timeout(5000), cache: 'no-store' }); const data = await response.json() as ResponseData;
    if (!response.ok || !data.session || !data.csrf || !data.state || !data.library) throw new Error(data.error?.message ?? '无法连接本地服务。');
    session = data.session; csrf = data.csrf; state = data.state; online = true; acceptLibrary(data.library, true);
    if (!dirty) loadPattern();
    const catalogResponse = await fetch('/api/catalog', { headers: headers(), signal: AbortSignal.timeout(5000) });
    if (!catalogResponse.ok) throw new Error('品牌资料未能载入。'); catalog = await catalogResponse.json() as CatalogData; renderCatalog(); renderState();
  } catch (error) { online = false; state = null; clearOutputs(); renderState(); fail(error); }
}
button('reconnect').addEventListener('click', () => void bootstrap());
async function poll(): Promise<void> {
  if (destroying) return;
  try {
    if (online && !document.hidden) {
      const result = await request('/api/state');
      if (result.revision !== library?.revision) { const next = await request('/api/library', undefined, false) as unknown as Persisted; acceptLibrary(next); }
      if (state?.control.mine && Date.now() - lastHeartbeat >= 2000) { await request('/api/heartbeat', {}); lastHeartbeat = Date.now(); }
    }
  } catch (error) {
    if (error instanceof RequestError && error.code === 'RATE_LIMIT') fail(error);
    else { online = false; state = null; clearOutputs(); renderState(); fail(error instanceof RequestError ? error : new Error('与本地服务的连接已中断，控制已禁用。请重新连接。')); }
  } finally { if (!destroying) pollTimer = setTimeout(() => void poll(), 500); }
}
function releaseWhenHidden(end = false): void {
  if (!session || !online || (hiddenReleased && !end)) return;
  hiddenReleased = true; generation++; clearOutputs();
  const wasOwner = state?.control.mine;
  state = null; renderState();
  const path = end ? '/api/end' : '/api/control';
  if (wasOwner || end) void fetch(path, { method: 'POST', headers: headers(true), body: JSON.stringify(end ? {} : { action: 'release' }), keepalive: true }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseWhenHidden(); else { hiddenReleased = false; notify('已返回页面。需要控制时，请重新获取控制权并启用虚拟设备。'); } });
window.addEventListener('beforeunload', event => { if (dirty || preferencesDirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => {
  destroying = true; releaseWhenHidden(true); if (pollTimer) clearTimeout(pollTimer); clearOutputs();
  for (const [url, timer] of objectUrls) { clearTimeout(timer); URL.revokeObjectURL(url); } objectUrls.clear();
});
window.addEventListener('pageshow', event => { if (event.persisted) { destroying = false; online = false; session = ''; csrf = ''; state = null; renderState(); void bootstrap().then(() => poll()); } });
renderEditor();
await bootstrap();
void poll();

const catalogDisclosure = el<HTMLDetailsElement>('catalog');
document.querySelector<HTMLAnchorElement>('a[href="#catalog"]')?.addEventListener('click', () => { catalogDisclosure.open = true; });
if (location.hash === '#catalog') catalogDisclosure.open = true;
