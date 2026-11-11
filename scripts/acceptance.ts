import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { matrixSchema, evaluateAcceptance } from './lib/acceptance.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = /^(artifacts\/|docs\/|research\/|data\/|README\.md$|THIRD_PARTY_NOTICES\.md$)/;
async function evidencePath(path: string): Promise<string> {
  if (!allowed.test(path)) throw new Error('Evidence path outside allowed report/document areas');
  const actual = await realpath(resolve(root, path)); const inside = relative(root, actual);
  if (inside.startsWith('..') || !allowed.test(inside)) throw new Error('Evidence path leaves allowed project areas');
  if (!(await stat(actual)).isFile()) throw new Error('Evidence must be a file');
  return actual;
}
const load = async (path: string) => {
  const actual = await evidencePath(path); if ((await stat(actual)).size > 2000000) throw new Error('Evidence JSON exceeds size bound');
  try { return JSON.parse(await readFile(actual, 'utf8')); }
  catch { throw new Error(`Evidence JSON could not be parsed: ${path}`); }
};
const matrix = matrixSchema.parse(await load('docs/acceptance-matrix.json'));
const upstream = await load('artifacts/bounded-upstream-execution.json');
const fusion = await load('artifacts/real-fusion-status.json');
const missing: string[] = [];
for (const path of new Set(matrix.gates.flatMap(gate => gate.evidence))) {
  try {
    await evidencePath(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(path); else throw error; }
}
const passed = (value: { cases?: number; passed?: number; failed?: number }) => (value.cases ?? value.passed ?? 0) > 0 && value.failed === 0;
const facts = {
  foundationVerified: passed(upstream.python) && passed(upstream.rust) && passed(upstream.localAuthorization.adversarial) && passed(upstream.localAuthorization.httpBoundaries) && fusion.nativeSoftwareInteroperability === 'passed',
  realDeviceCount: Number(fusion.physicalDevicesTested ?? 0), centralGuiVerified: fusion.intifaceCentralGuiTested === true,
  officialApiImplemented: fusion.lovenseOfficialApiImplemented === true,
  // No complete receipts for these release-level claims currently exist.
  officialAuthorizedFlowVerified: false, authorizedCodeFlowVerified: false, physicalAcceptanceVerified: false,
  completeSecurityReviewVerified: false, cleanInstallVerified: false, humanSignoffVerified: false,
};
const result = { ...evaluateAcceptance(matrix, facts, missing), matrixVersion: matrix.schemaVersion, candidate: matrix.candidate,
  assessmentScope: 'existing evidence audit only; no services or hardware tests executed', facts, missingEvidence: missing };
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const reportDirectory = await realpath(resolve(root, 'artifacts'));
if (relative(root, reportDirectory) !== 'artifacts') throw new Error('Acceptance output directory leaves project');
const temporaryReport = resolve(reportDirectory, `.acceptance-${process.pid}.json`);
await writeFile(temporaryReport, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
const { rename } = await import('node:fs/promises');
await rename(temporaryReport, resolve(reportDirectory, 'product-acceptance.json'));
console.log(JSON.stringify({ verdict: result.verdict, passedGates: result.passedGates, requiredGates: result.requiredGates, realDeviceCount: result.realDeviceCount, reasons: result.reasons }));
if (!result.accepted) process.exitCode = 1;
