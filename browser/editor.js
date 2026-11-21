import { preset, maxDuration } from './preset.js';
import { androidWaveform } from './android-waveform.js';

// Same bounds as the Studio library schema, so every export can be imported there.
const LIMITS = { steps: 64, cycles: 10, minMs: 100, maxMs: 30000, fileBytes: 131072, name: 48, patterns: 20 };
const NEW_STEP = { value: 20, durationMs: 1000 };
const DRAFT_KEY = 'haptic-bridge.editor.draft.v1';
const THEME_KEY = 'haptic-bridge.editor.theme';
const CONTROL = /[\u0000-\u001f\u007f]/u;
const EXAMPLES = {
  wave: { name: '低强起伏', values: [0, 10, 20, 0], durations: [1000, 1000, 1000, 1000] },
  double: { name: '双击提醒', values: [25, 0, 16, 0], durations: [200, 200, 200, 600] },
  pulse: { name: '规律间歇', values: [18, 0, 18, 0], durations: [600, 600, 600, 600] },
};
const SCOPE = { width: 600, top: 20, bottom: 140 };

const $ = (selector, root = document) => root.querySelector(selector);
const form = $('#editor');
const list = $('#steps');
const nameInput = $('#pattern-name');
const cyclesInput = $('#cycles');
const statusLine = $('#status');
const exportButtons = [$('#export-android'), $('#copy-kotlin'), $('#export-library')];
const templateChoice = $('#template-choice');
const importDialog = $('#import-dialog');
const shortcutsDialog = $('#shortcuts');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const sum = values => values.reduce((total, value) => total + value, 0);
const trim = value => String(Math.round(value * 1000) / 1000);

function formatDuration(ms) {
  if (ms < 1000) return ms + ' ms';
  if (ms < 60000) return trim(ms / 1000) + ' 秒';
  const seconds = (ms % 60000) / 1000;
  return Math.floor(ms / 60000) + ' 分' + (seconds ? ' ' + trim(seconds) + ' 秒' : '');
}

// Storage is optional: private windows and file:// pages may refuse it.
function readStore(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeStore(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
function removeStore(key) { try { localStorage.removeItem(key); } catch { /* nothing was stored */ } }

/** Returns a clean pattern, or null when it breaks any Studio library bound. */
function normalizePattern(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > LIMITS.name || CONTROL.test(name)) return null;
  if (!isInt(raw.cycles, 1, LIMITS.cycles)) return null;
  if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > LIMITS.steps) return null;
  const steps = [];
  for (const step of raw.steps) {
    if (!step || !isInt(step.value, 0, 100) || !isInt(step.durationMs, LIMITS.minMs, LIMITS.maxMs)) return null;
    steps.push({ value: step.value, durationMs: step.durationMs });
  }
  if (sum(steps.map(step => step.durationMs)) * raw.cycles > maxDuration) return null;
  return { name, cycles: raw.cycles, steps };
}

const defaultPattern = () => normalizePattern(preset);

function storedPattern() {
  const stored = readStore(DRAFT_KEY);
  if (!stored) return null;
  try { return normalizePattern(JSON.parse(stored)); } catch { return null; }
}

const restored = storedPattern();
// While typing, a field may hold NaN; validate() reports it and exports stay disabled.
let draft = restored ?? defaultPattern();
let view = 'cycle';
let dirty = Boolean(restored) && JSON.stringify(restored) !== JSON.stringify(defaultPattern());
let storageOk = true;
let activeStep = -1;
let notice = dirty ? { text: '已恢复上次在此浏览器编辑的草稿。', tone: 'info' } : null;
let importChoices = [];

function validate() {
  const errors = new Map();
  const name = draft.name.trim();
  if (!name) errors.set('name', '请填写模式名称。');
  else if (name.length > LIMITS.name || CONTROL.test(name)) errors.set('name', '模式名称最多 48 个字符，且不能包含控制字符。');
  if (!isInt(draft.cycles, 1, LIMITS.cycles)) errors.set('cycles', '周期数需为 1–10 的整数。');
  let stepsValid = true;
  draft.steps.forEach((step, index) => {
    if (!isInt(step.value, 0, 100)) { stepsValid = false; errors.set('value:' + index, '强度需为 0–100 的整数。'); }
    if (!isInt(step.durationMs, LIMITS.minMs, LIMITS.maxMs)) { stepsValid = false; errors.set('duration:' + index, '时长需为 100–30000 ms 的整数。'); }
  });
  const period = stepsValid ? sum(draft.steps.map(step => step.durationMs)) : NaN;
  const total = errors.has('cycles') ? NaN : period * draft.cycles;
  if (total > maxDuration) errors.set('total', '总时长超过 10 分钟，请减少周期或缩短阶段。');
  return { errors, period, total };
}

const currentPattern = () => ({
  name: draft.name.trim(),
  cycles: draft.cycles,
  steps: draft.steps.map(step => ({ value: step.value, durationMs: step.durationMs })),
});

function renderSteps() {
  const template = $('#step-template').content;
  const rows = draft.steps.map((step, index) => {
    const row = template.firstElementChild.cloneNode(true);
    const number = index + 1;
    row.dataset.index = String(index);
    $('.step-index', row).textContent = String(number);
    const range = $('.level-range', row), level = $('.level', row), time = $('.time', row);
    range.setAttribute('aria-label', `阶段 ${number} 强度滑块`);
    level.setAttribute('aria-label', `阶段 ${number} 强度（%）`);
    time.setAttribute('aria-label', `阶段 ${number} 时长（毫秒）`);
    if (Number.isFinite(step.value)) { level.value = String(step.value); range.value = String(step.value); }
    if (Number.isFinite(step.durationMs)) time.value = String(step.durationMs);
    const labels = { up: '上移', down: '下移', duplicate: '复制', remove: '删除' };
    for (const button of row.querySelectorAll('[data-action]')) {
      const label = `${labels[button.dataset.action]}阶段 ${number}`;
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    $('[data-action="up"]', row).disabled = index === 0;
    $('[data-action="down"]', row).disabled = index === draft.steps.length - 1;
    $('[data-action="remove"]', row).disabled = draft.steps.length === 1;
    $('[data-action="duplicate"]', row).disabled = draft.steps.length >= LIMITS.steps;
    return row;
  });
  list.replaceChildren(...rows);
  $('#add-step').disabled = draft.steps.length >= LIMITS.steps;
  $('#step-count').textContent = `${draft.steps.length} / ${LIMITS.steps}`;
}

function renderFields() {
  nameInput.value = draft.name;
  cyclesInput.value = Number.isFinite(draft.cycles) ? String(draft.cycles) : '';
  renderSteps();
}

function markInvalid(input, invalid) {
  if (invalid) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'status'); }
  else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
}

function paintErrors(errors) {
  markInvalid(nameInput, errors.has('name'));
  markInvalid(cyclesInput, errors.has('cycles') || errors.has('total'));
  for (const row of list.children) {
    const index = row.dataset.index;
    const messages = [errors.get('value:' + index), errors.get('duration:' + index)].filter(Boolean);
    markInvalid($('.level', row), errors.has('value:' + index));
    markInvalid($('.time', row), errors.has('duration:' + index));
    const line = $('.step-error', row);
    line.textContent = messages.join(' ');
    line.hidden = !messages.length;
    row.classList.toggle('invalid', messages.length > 0);
  }
}

function draw({ period, total }) {
  const drawable = Number.isFinite(period) && (view === 'cycle' || Number.isFinite(total));
  const cycles = drawable && view === 'full' ? draft.cycles : 1;
  const span = drawable ? period * cycles : 0;
  const x = ms => (SCOPE.width * ms / span).toFixed(2);
  const y = level => (SCOPE.bottom - level * (SCOPE.bottom - SCOPE.top) / 100).toFixed(2);
  const path = [], marks = [];
  if (drawable) {
    let elapsed = 0;
    path.push(`M0 ${SCOPE.bottom}`);
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (const step of draft.steps) {
        elapsed += step.durationMs;
        path.push('V' + y(step.value), 'H' + x(elapsed));
      }
      if (cycle < cycles - 1) marks.push(`M${x(elapsed)} ${SCOPE.top}V${SCOPE.bottom}`);
    }
  }
  $('#trace').setAttribute('d', path.join(' '));
  $('#area').setAttribute('d', drawable ? `${path.join(' ')} V${SCOPE.bottom} Z` : '');
  $('#cycle-marks').setAttribute('d', marks.join(' '));
  $('#scope-end').textContent = drawable ? formatDuration(span) : '';

  const segment = $('#segment');
  const step = drawable ? draft.steps[activeStep] : undefined;
  if (step) {
    const start = sum(draft.steps.slice(0, activeStep).map(item => item.durationMs));
    segment.setAttribute('x', x(start));
    segment.setAttribute('width', x(step.durationMs));
  } else {
    segment.setAttribute('width', '0');
  }
  $('#scope').setAttribute('aria-label', drawable
    ? `${view === 'full' ? '完整模式' : '单周期'}强度波形，${draft.steps.length} 个阶段，时间跨度 ${formatDuration(span)}`
    : '参数无效，暂无波形');
}

function paintStats({ period, total }) {
  const levels = draft.steps.map(step => step.value).filter(Number.isFinite);
  $('#stat-period').textContent = Number.isFinite(period) ? formatDuration(period) : '—';
  $('#stat-total').textContent = Number.isFinite(total) ? formatDuration(total) : '—';
  $('#stat-peak').textContent = levels.length ? Math.max(...levels) + '%' : '—';
  $('#stat-steps').textContent = String(draft.steps.length);
}

function paintStatus(result) {
  const error = result.errors.values().next().value;
  if (error) {
    const key = result.errors.keys().next().value;
    const index = key.includes(':') ? `阶段 ${Number(key.split(':')[1]) + 1}：` : '';
    statusLine.textContent = index + error;
    statusLine.dataset.tone = 'error';
  } else if (notice) {
    statusLine.textContent = notice.text;
    statusLine.dataset.tone = notice.tone;
  } else {
    statusLine.textContent = `${draft.cycles} 个周期 · 波形随输入实时更新，导出保留全部周期。`;
    statusLine.dataset.tone = 'info';
  }
}

function update() {
  const result = validate();
  paintErrors(result.errors);
  draw(result);
  paintStats(result);
  paintStatus(result);
  const valid = result.errors.size === 0;
  for (const button of exportButtons) button.disabled = !valid;
  if (valid) storageOk = writeStore(DRAFT_KEY, JSON.stringify(currentPattern()));
  return result;
}

function edited() {
  dirty = true;
  notice = null;
  update();
}

function setNotice(text, tone = 'info') {
  notice = { text, tone };
  paintStatus(validate());
}

function focusStep(index, selector = '.level') {
  const row = list.children[Math.max(0, Math.min(index, list.children.length - 1))];
  const target = row && $(selector, row);
  if (target) { target.focus(); row.scrollIntoView({ block: 'nearest' }); }
}

const rowIndex = target => {
  const row = target instanceof Element ? target.closest('.step') : null;
  return row ? Number(row.dataset.index) : -1;
};

function addStep(after = draft.steps.length - 1) {
  if (draft.steps.length >= LIMITS.steps) { setNotice(`最多 ${LIMITS.steps} 个阶段。`, 'error'); return; }
  const position = after < 0 ? draft.steps.length : after + 1;
  draft.steps.splice(position, 0, { ...NEW_STEP });
  renderSteps(); edited(); focusStep(position);
}

function duplicateStep(index) {
  if (draft.steps.length >= LIMITS.steps) return;
  draft.steps.splice(index + 1, 0, { ...draft.steps[index] });
  renderSteps(); edited(); focusStep(index + 1);
}

function removeStep(index) {
  if (draft.steps.length === 1) return;
  draft.steps.splice(index, 1);
  activeStep = -1;
  renderSteps(); edited(); focusStep(Math.min(index, draft.steps.length - 1));
}

function moveStep(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= draft.steps.length) return;
  [draft.steps[index], draft.steps[target]] = [draft.steps[target], draft.steps[index]];
  renderSteps(); edited();
  // Keep focus on the control that moved, unless it became disabled at an edge.
  const action = $(`[data-action="${offset < 0 ? 'up' : 'down'}"]`, list.children[target]);
  if (action.disabled) focusStep(target); else action.focus();
}

/** Replaces the draft after protecting edits that were never exported. */
function loadPattern(pattern, message) {
  if (dirty && !window.confirm('替换当前尚未导出的编辑？需要保留时，请先导出。')) return false;
  draft = pattern;
  dirty = false;
  activeStep = -1;
  notice = { text: message, tone: 'success' };
  renderFields(); update();
  return true;
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// randomUUID needs a secure context; a LAN static server still offers getRandomValues.
function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Runs an export only for a valid draft; otherwise moves focus to the first problem. */
function withValidPattern(run) {
  const { errors } = update();
  if (errors.size) {
    const invalid = $('[aria-invalid="true"]', form);
    if (invalid) invalid.focus();
    return;
  }
  try { run(currentPattern()); } catch (error) { setNotice(error instanceof Error ? error.message : '导出失败。', 'error'); }
}

const exportAndroid = () => withValidPattern(pattern => {
  download('android-waveform.json', JSON.stringify(androidWaveform(pattern.steps, pattern.cycles), null, 2));
  dirty = false;
  setNotice('已导出 Android 波形参数。', 'success');
});

const exportLibrary = () => withValidPattern(pattern => {
  androidWaveform(pattern.steps, pattern.cycles);
  const library = { version: 1, preferences: { defaultIntensity: 20, defaultDurationMs: 1000 }, patterns: [{ id: uuid(), ...pattern }] };
  download('haptic-studio-library.json', JSON.stringify(library, null, 2));
  dirty = false;
  setNotice('模式已导出。在 Studio 导入前请备份当前模式库。', 'success');
});

async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; }
  const area = document.createElement('textarea');
  area.value = text; area.className = 'clipboard-buffer'; area.setAttribute('readonly', '');
  document.body.append(area); area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw Error('当前环境不能写入剪贴板，请改用导出文件。');
}

const copyKotlin = () => withValidPattern(pattern => {
  const { timings, amplitudes, repeat } = androidWaveform(pattern.steps, pattern.cycles);
  const total = formatDuration(sum(timings));
  const code = [
    `// ${pattern.name} · ${pattern.cycles} 个周期 · ${total}`,
    `val timings = longArrayOf(${timings.join(', ')})`,
    `val amplitudes = intArrayOf(${amplitudes.join(', ')})`,
    `val effect = VibrationEffect.createWaveform(timings, amplitudes, ${repeat})`,
  ].join('\n');
  writeClipboard(code).then(
    () => setNotice('已复制 Kotlin 代码（API 26+）。', 'success'),
    error => setNotice(error instanceof Error && error.message ? error.message : '当前环境不能写入剪贴板，请改用导出文件。', 'error'),
  );
});

function fromAndroid({ timings, amplitudes }) {
  if (timings.length !== amplitudes.length || amplitudes.some(value => !isInt(value, 0, 255))) return null;
  return normalizePattern({
    name: 'Android 波形', cycles: 1,
    steps: timings.map((durationMs, index) => ({ durationMs, value: Math.round(amplitudes[index] * 100 / 255) })),
  });
}

/** Accepts a Studio library, its persisted wrapper, one pattern, or Android waveform parameters. */
function extractPatterns(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const source = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
  if (Array.isArray(source.patterns)) return source.patterns.slice(0, LIMITS.patterns).map(normalizePattern).filter(Boolean);
  if (Array.isArray(source.timings) && Array.isArray(source.amplitudes)) return [fromAndroid(source)].filter(Boolean);
  return [normalizePattern(source)].filter(Boolean);
}

function chooseImport(patterns) {
  importChoices = patterns;
  const options = patterns.map((pattern, index) => {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    Object.assign(radio, { type: 'radio', name: 'import-choice', value: String(index), checked: index === 0 });
    const title = document.createElement('strong');
    title.textContent = pattern.name;
    const detail = document.createElement('span');
    const total = sum(pattern.steps.map(step => step.durationMs)) * pattern.cycles;
    detail.textContent = `${pattern.steps.length} 个阶段 · ${pattern.cycles} 个周期 · ${formatDuration(total)}`;
    label.append(radio, title, detail);
    return label;
  });
  $('#import-choices').replaceChildren(...options);
  importDialog.showModal();
}

async function importFile(file) {
  if (file.size > LIMITS.fileBytes) { setNotice('文件超过 128 KiB，无法载入。', 'error'); return; }
  let data;
  try { data = JSON.parse(await file.text()); } catch { setNotice('不是有效的 JSON 文件。', 'error'); return; }
  const patterns = extractPatterns(data);
  if (!patterns.length) { setNotice('文件中没有可载入的模式。支持 Studio 模式库、单个模式和 Android 波形参数。', 'error'); return; }
  if (patterns.length === 1) loadPattern(patterns[0], `已从文件载入「${patterns[0].name}」。`);
  else chooseImport(patterns);
}

function resetDraft() {
  if (loadPattern(defaultPattern(), '已重置为默认模式。')) removeStore(DRAFT_KEY);
}

function describeTemplate() {
  const example = EXAMPLES[templateChoice.value];
  if (!example) return;
  $('#template-detail').textContent = `${example.name} · 峰值 ${Math.max(...example.values)}% · 单周期 ${formatDuration(sum(example.durations))} · 固定参数，不调用模型。`;
}

function loadTemplate() {
  const example = EXAMPLES[templateChoice.value];
  if (!example) return;
  const pattern = { name: example.name, cycles: 1, steps: example.values.map((value, index) => ({ value, durationMs: example.durations[index] })) };
  if (loadPattern(pattern, `已载入样例「${example.name}」，可继续调整。`)) focusStep(0);
}

function setView(next) {
  view = next;
  const radio = $(`input[name="view"][value="${next}"]`);
  if (radio) radio.checked = true;
  draw(validate());
}

function effectiveTheme() {
  const stored = readStore(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function paintTheme(theme, explicit) {
  if (explicit) document.documentElement.dataset.theme = theme;
  $('#theme-toggle').setAttribute('aria-label', theme === 'dark' ? '切换到浅色外观' : '切换到深色外观');
}

function openDialog(dialog) { if (!dialog.open) dialog.showModal(); }

// ---- wiring ---------------------------------------------------------------

nameInput.addEventListener('input', () => { draft.name = nameInput.value; edited(); });
cyclesInput.addEventListener('input', () => { draft.cycles = cyclesInput.value === '' ? NaN : Number(cyclesInput.value); edited(); });

list.addEventListener('input', event => {
  const index = rowIndex(event.target);
  const step = draft.steps[index];
  if (!step) return;
  const row = list.children[index], input = event.target;
  if (input.classList.contains('level-range')) {
    step.value = Number(input.value);
    $('.level', row).value = input.value;
  } else if (input.classList.contains('level')) {
    step.value = input.value === '' ? NaN : Number(input.value);
    if (isInt(step.value, 0, 100)) $('.level-range', row).value = input.value;
  } else if (input.classList.contains('time')) {
    step.durationMs = input.value === '' ? NaN : Number(input.value);
  }
  edited();
});

list.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (!button || button.disabled) return;
  const index = rowIndex(button);
  if (button.dataset.action === 'up') moveStep(index, -1);
  else if (button.dataset.action === 'down') moveStep(index, 1);
  else if (button.dataset.action === 'duplicate') duplicateStep(index);
  else if (button.dataset.action === 'remove') removeStep(index);
});

// The waveform highlights whichever stage is being edited or pointed at.
function activate(index) {
  if (index === activeStep) return;
  activeStep = index;
  draw(validate());
}
list.addEventListener('focusin', event => activate(rowIndex(event.target)));
list.addEventListener('focusout', event => { if (!list.contains(event.relatedTarget)) activate(-1); });
list.addEventListener('pointerover', event => activate(rowIndex(event.target)));
list.addEventListener('pointerleave', () => activate(rowIndex(document.activeElement)));

form.addEventListener('submit', event => event.preventDefault());
$('#add-step').addEventListener('click', () => addStep());
$('#export-android').addEventListener('click', exportAndroid);
$('#export-library').addEventListener('click', exportLibrary);
$('#copy-kotlin').addEventListener('click', copyKotlin);
$('#reset-draft').addEventListener('click', resetDraft);
$('#template-load').addEventListener('click', loadTemplate);
templateChoice.addEventListener('change', describeTemplate);

$('#import-library').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (file) importFile(file);
});
$('#import-form').addEventListener('submit', event => {
  event.preventDefault();
  const chosen = $('input[name="import-choice"]:checked', importDialog);
  const pattern = chosen && importChoices[Number(chosen.value)];
  importDialog.close();
  if (pattern) loadPattern(pattern, `已从文件载入「${pattern.name}」。`);
});

for (const radio of document.querySelectorAll('input[name="view"]')) {
  radio.addEventListener('change', () => { if (radio.checked) setView(radio.value); });
}

for (const dialog of [shortcutsDialog, importDialog]) {
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialog.close());
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
}
$('#open-shortcuts').addEventListener('click', () => openDialog(shortcutsDialog));
for (const key of document.querySelectorAll('kbd[data-mod]')) key.textContent = isMac ? '⌘' : 'Ctrl';

$('#theme-toggle').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  writeStore(THEME_KEY, next);
  paintTheme(next, true);
});

$('#guide-edit').addEventListener('click', () => focusStep(0));
$('#guide-preview').addEventListener('click', () => {
  const panel = $('#scope-panel');
  panel.scrollIntoView({ block: 'center' });
  panel.focus({ preventScroll: true });
});
$('#guide-export').addEventListener('click', () => {
  const target = exportButtons[0].disabled ? $('[aria-invalid="true"]', form) ?? statusLine : exportButtons[0];
  target.scrollIntoView({ block: 'center' });
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
});

document.addEventListener('keydown', event => {
  if ($('dialog[open]')) return;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const target = event.target;
  if (mod && !event.altKey && !event.shiftKey) {
    const key = event.key.toLowerCase();
    if (key === 's') { event.preventDefault(); exportLibrary(); }
    else if (key === 'e') { event.preventDefault(); exportAndroid(); }
    else if (key === 'enter') { event.preventDefault(); addStep(rowIndex(target)); }
    return;
  }
  if (event.altKey && !mod) {
    const index = rowIndex(target);
    if (index < 0) return;
    if (event.key === 'ArrowUp') { event.preventDefault(); moveStep(index, -1); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); moveStep(index, 1); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeStep(index); }
    return;
  }
  const typing = target instanceof HTMLElement && target.matches('input:not([type="range"]):not([type="radio"]), select, textarea');
  if (typing || mod || event.altKey) return;
  if (event.key === '?') { event.preventDefault(); openDialog(shortcutsDialog); }
  else if (event.key.toLowerCase() === 'v') setView(view === 'cycle' ? 'full' : 'cycle');
});

// With a saved draft nothing is lost on reload; warn only when storage is unavailable.
window.addEventListener('beforeunload', event => {
  if (dirty && !storageOk) { event.preventDefault(); event.returnValue = ''; }
});

const storedTheme = readStore(THEME_KEY);
paintTheme(effectiveTheme(), storedTheme === 'light' || storedTheme === 'dark');
describeTemplate();
renderFields();
update();
