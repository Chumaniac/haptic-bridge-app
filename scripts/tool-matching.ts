import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { z } from 'zod';
import { readCatalog } from '../src/catalog.ts';
import { buildToolMatchingReport } from './lib/tool-matching.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportDirectory = await realpath(resolve(root, 'artifacts'));
if (relative(root, reportDirectory) !== 'artifacts') throw new Error('Report directory leaves project');
const sourcePath = await realpath(resolve(reportDirectory, 'real-fusion-status.json'));
if (relative(root, sourcePath) !== 'artifacts/real-fusion-status.json') throw new Error('Evidence source leaves allowed report location');
const evidenceSchema = z.object({ nativeSoftwareInteroperability: z.string(), intifaceCentralGuiTested: z.boolean(),
  lovenseOfficialApiImplemented: z.boolean(), physicalDevicesTested: z.number().int().min(0) });
const evidence = evidenceSchema.parse(JSON.parse(await readFile(sourcePath, 'utf8')));
const report = buildToolMatchingReport(readCatalog(), evidence, process.argv.slice(2).join(' '));
await mkdir(reportDirectory, { recursive: true });
const temporary = resolve(reportDirectory, `.tool-matching-${process.pid}.json`);
await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
await rename(temporary, resolve(reportDirectory, 'tool-matching-report.json'));
console.log(JSON.stringify(report, null, 2));
