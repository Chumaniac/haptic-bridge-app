import { readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { z } from 'zod';
import { matrixSchema, evaluateAcceptance } from './lib/acceptance.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = /^(artifacts\/|docs\/|research\/|data\/|README\.md$|THIRD_PARTY_NOTICES\.md$)/;
async function evidencePath(path: string): Promise<string> {
  if (relative(root, resolve(root, path)) !== path || !allowed.test(path)) throw new Error('Evidence path outside allowed report/document areas');
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
const missing = new Set<string>();
const invalid = new Set<string>();
const suite = z.object({
  cases: z.number().int().nonnegative().optional(),
  passed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative(),
});
const upstreamSchema = z.object({
  python: suite, rust: suite,
  localAuthorization: z.object({adversarial: suite, httpBoundaries: suite}),
});
const fusionSchema = z.object({
  nativeSoftwareInteroperability: z.string(), physicalDevicesTested: z.number().int().nonnegative(),
  intifaceCentralGuiTested: z.boolean(), lovenseOfficialApiImplemented: z.boolean(),
});
async function readReceipt<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let actual: string;
  try { actual = await evidencePath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    missing.add(path);
    return;
  }
  if ((await stat(actual)).size <= 2_000_000) {
    const content = await readFile(actual, 'utf8');
    try {
      const value = schema.safeParse(JSON.parse(content));
      if (value.success) return value.data;
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  invalid.add(path);
}
const upstream = await readReceipt('artifacts/bounded-upstream-execution.json', upstreamSchema);
const fusion = await readReceipt('artifacts/real-fusion-status.json', fusionSchema);
for (const path of new Set(matrix.gates.flatMap(gate => gate.evidence))) {
  try {
    await evidencePath(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.add(path); else throw error; }
}
const passed = (value: z.infer<typeof suite>) => (value.passed ?? value.cases ?? 0) > 0 && value.failed === 0;
const facts = {
  foundationVerified: !!upstream && passed(upstream.python) && passed(upstream.rust) && passed(upstream.localAuthorization.adversarial) && passed(upstream.localAuthorization.httpBoundaries) && fusion?.nativeSoftwareInteroperability === 'passed',
  realDeviceCount: fusion?.physicalDevicesTested ?? 0, centralGuiVerified: fusion?.intifaceCentralGuiTested === true,
  officialApiImplemented: fusion?.lovenseOfficialApiImplemented === true,
  // No complete receipts for these release-level claims currently exist.
  officialAuthorizedFlowVerified: false, authorizedCodeFlowVerified: false, physicalAcceptanceVerified: false,
  completeSecurityReviewVerified: false, cleanInstallVerified: false, humanSignoffVerified: false,
};
const result = { ...evaluateAcceptance(matrix, facts, [...missing, ...invalid]), matrixVersion: matrix.schemaVersion, candidate: matrix.candidate,
  assessmentScope: 'existing evidence audit only; no services or hardware tests executed', facts, missingEvidence: [...missing], invalidEvidence: [...invalid] };
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const reportDirectory = await realpath(resolve(root, 'artifacts'));
if (relative(root, reportDirectory) !== 'artifacts') throw new Error('Acceptance output directory leaves project');
const temporaryReport = resolve(reportDirectory, `.acceptance-${process.pid}.json`);
await writeFile(temporaryReport, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
const { rename } = await import('node:fs/promises');
await rename(temporaryReport, resolve(reportDirectory, 'product-acceptance.json'));
console.log(JSON.stringify({ verdict: result.verdict, passedGates: result.passedGates, requiredGates: result.requiredGates, realDeviceCount: result.realDeviceCount, reasons: result.reasons, missingEvidence: result.missingEvidence, invalidEvidence: result.invalidEvidence }));
if (!result.accepted) process.exitCode = 1;
