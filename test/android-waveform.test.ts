import assert from 'node:assert/strict';
import test from 'node:test';
import { androidWaveform } from '../src/studio/web/android-waveform.ts';

test('Android export preserves pauses, finite cycles and amplitude endpoints', () => {
  assert.deepEqual(androidWaveform([{value:0,durationMs:100},{value:50,durationMs:200},{value:100,durationMs:300}],2), {
    timings:[100,200,300,100,200,300], amplitudes:[0,128,255,0,128,255], repeat:-1
  });
  assert.throws(()=>androidWaveform([{value:101,durationMs:100}],1));
  assert.throws(()=>androidWaveform(Array(3).fill({value:100,durationMs:30000}),10));
});
