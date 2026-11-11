type Step = {value: number; durationMs: number};

// Android API 26+ accepts millisecond/amplitude pairs. Finite cycles must be
// expanded: the Android repeat index loops indefinitely when nonnegative.
export function androidWaveform(steps: readonly Step[], cycles: number) {
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 10 || !steps.length || steps.length > 64) {
    throw Error('模式需包含 1–64 个阶段和 1–10 个周期。');
  }
  let period = 0;
  for (const step of steps) {
    if (!Number.isInteger(step.value) || step.value < 0 || step.value > 100 ||
        !Number.isInteger(step.durationMs) || step.durationMs < 100 || step.durationMs > 30000) {
      throw Error('请检查阶段强度和毫秒时长。');
    }
    period += step.durationMs;
  }
  if (period * cycles > 600000) throw Error('总时长不能超过 10 分钟。');
  const timings: number[] = [];
  const amplitudes: number[] = [];
  for (let i = 0; i < cycles; i++) {
    for (const step of steps) {
      timings.push(step.durationMs);
      amplitudes.push(Math.round(step.value * 255 / 100));
    }
  }
  return {timings, amplitudes, repeat: -1};
}
