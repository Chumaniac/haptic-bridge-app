import { readFile, realpath, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readCatalog } from '../src/catalog.ts';
import { buildToolMatchingReport } from './lib/tool-matching.ts';
import { renderReadOnlyView } from './lib/readonly-view.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await realpath(resolve(root, 'artifacts'));
if (relative(root, directory) !== 'artifacts') throw new Error('Report directory leaves project');
async function load(name: string): Promise<unknown> {
  const path = await realpath(resolve(directory, name));
  if (relative(directory, path) !== name || (await stat(path)).size > 2000000) throw new Error('Invalid local evidence source');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Local evidence JSON could not be parsed'); }
}
const fusion = z.object({ nativeSoftwareInteroperability: z.string(), intifaceCentralGuiTested: z.boolean(),
  lovenseOfficialApiImplemented: z.boolean(), physicalDevicesTested: z.number().int().min(0) }).parse(await load('real-fusion-status.json'));
const acceptance = z.object({ accepted: z.boolean(), verdict: z.enum(['通过', '未通过']), passedGates: z.number().int().min(0).max(12), requiredGates: z.literal(12),
  gateResults: z.array(z.object({ id: z.string(), title: z.string(), verified: z.boolean(), reason: z.string() })).length(12) }).parse(await load('product-acceptance.json'));
const catalog = readCatalog();
const html = renderReadOnlyView({ report: buildToolMatchingReport(catalog, fusion), profiles: catalog.profiles.map(({ id, name, models }) => ({ id, name, models })), acceptance });
const temporary = resolve(directory, `.readonly-${process.pid}.html`);
await writeFile(temporary, html, { flag: 'wx' });
await rename(temporary, resolve(directory, 'read-only-guide.html'));
console.log(JSON.stringify({ output: resolve(directory, 'read-only-guide.html'), bytes: Buffer.byteLength(html), connectsDevices: false, externalRequests: 0, acceptance: acceptance.verdict }));
