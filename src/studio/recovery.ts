import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { recoverStudioFile } from './store.ts';

try {
  const { values } = parseArgs({ options: { source: { type:'string' }, output: { type:'string' } }, strict:true });
  if (!values.source || !values.output) throw new Error('Arguments required');
  const result = await recoverStudioFile(resolve(values.source), resolve(values.output));
  console.log(JSON.stringify(result));
} catch {
  console.error('STUDIO_RECOVERY_FAILED: preserve originals, verify the source and choose a new output file.');
  process.exitCode = 1;
}
