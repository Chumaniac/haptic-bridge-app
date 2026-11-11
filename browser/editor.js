import { preset, maxDuration } from './preset.js';

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
function clear() {
  trace.removeAttribute('d');
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
form.addEventListener('input',clear);
form.addEventListener('submit',event=>{event.preventDefault();preview()});
preview();
