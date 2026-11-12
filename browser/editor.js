import { preset, maxDuration } from './preset.js';

import { androidWaveform } from './android-waveform.js';

const exportButton = document.querySelector('#export-android');
const list = document.querySelector('#steps');
const trace = document.querySelector('#trace');
const output = document.querySelector('output');
function field(parent, text, value, min, max) {
  const label = document.createElement('label');
  label.textContent = text;
  const input = document.createElement('input');
  Object.assign(input, { type:'number', required:true, value, min, max, step:1 });
  label.append(input); parent.append(label);
  return input;
}
const steps = preset.steps.map((step,index) => {
  const row = document.createElement('fieldset');
  const title = document.createElement('legend');
  title.textContent = '阶段 ' + (index+1); row.append(title); list.append(row);
  return { level: field(row,'强度（%）',step.value,0,100),
    time: field(row,'时长（ms）',step.durationMs,100,30000) };
});
const form = document.querySelector('form');
const libraryButton = document.querySelector('#export-library');
function clear() {
  trace.removeAttribute('d');
  exportButton.disabled = !form.checkValidity() || steps.reduce((sum,s)=>sum+s.time.valueAsNumber,0) * document.querySelector('#cycles').valueAsNumber > maxDuration;
  libraryButton.disabled = exportButton.disabled;
  output.textContent = '参数已修改，请重新预览。';
}
function preview() {
  if (!form.reportValidity()) return;
  const period = steps.reduce((sum,step)=>sum+step.time.valueAsNumber,0);
  const total = period * document.querySelector('#cycles').valueAsNumber;
  if (total > maxDuration) {
    clear(); output.textContent = '总时长超过 10 分钟，请减少周期或缩短阶段。'; return;
  }
  let elapsed=0;
  const points = ['M0 120'];
  for(const step of steps) {
    elapsed += step.time.valueAsNumber;
    points.push('V'+(120-step.level.valueAsNumber),'H'+(600*elapsed/period).toFixed(2));
  }
  trace.setAttribute('d',points.join(' '));
  output.textContent = '单周期 '+period+' ms · 总时长 '+total+' ms';
}
exportButton.addEventListener('click', () => {
  if (!form.reportValidity()) return;
  try {
    const params = androidWaveform(steps.map(s=>({value:s.level.valueAsNumber,durationMs:s.time.valueAsNumber})),document.querySelector('#cycles').valueAsNumber);
    const url = URL.createObjectURL(new Blob([JSON.stringify(params,null,2)], {type:'application/json'}));
    const link = document.createElement('a'); link.href=url; link.download='android-waveform.json'; link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch (error) { output.textContent=error.message; }
});
form.addEventListener('input',clear);
form.addEventListener('submit',event=>{event.preventDefault();preview()});
preview();

libraryButton.addEventListener('click', () => {
  if (!form.reportValidity()) return;
  try {
    const name=document.querySelector('#pattern-name').value.trim();
    if (!name || /[\u0000-\u001f\u007f]/u.test(name)) throw Error('请填写有效的模式名称。');
    const draft=steps.map(s=>({value:s.level.valueAsNumber,durationMs:s.time.valueAsNumber})),cycles=document.querySelector('#cycles').valueAsNumber;
    androidWaveform(draft,cycles);
    const library={version:1,preferences:{defaultIntensity:20,defaultDurationMs:1000},patterns:[{id:crypto.randomUUID(),name,cycles,steps:draft}]};
    const url=URL.createObjectURL(new Blob([JSON.stringify(library,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='haptic-studio-library.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    output.textContent='模式已导出。在 Studio 导入前请备份当前模式库。';
  } catch (error) { output.textContent=error.message; }
});
