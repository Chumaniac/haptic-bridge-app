import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { initialLibrary, limits } from '../dist/src/studio/schema.js';
const out = new URL('../browser-dist/', import.meta.url);
await mkdir(out, {recursive:true});
for (const file of ['index.html','style.css','editor.js','haptic.svg']) {
  await copyFile(new URL('../browser/'+file, import.meta.url), new URL(file,out));
}
const preset = initialLibrary().data.patterns[0];
await writeFile(new URL('preset.js',out),'export const preset = '+JSON.stringify(preset)+';\nexport const maxDuration = '+limits.playbackMs+';\n');
