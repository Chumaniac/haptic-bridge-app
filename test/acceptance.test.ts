import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateAcceptance, type AcceptanceFacts } from '../scripts/lib/acceptance.ts';

const matrix = JSON.parse(await readFile(new URL('../docs/acceptance-matrix.json', import.meta.url), 'utf8'));
const facts: AcceptanceFacts = { foundationVerified: true, realDeviceCount: 0, centralGuiVerified: false, officialApiImplemented: false,
  officialAuthorizedFlowVerified: false, authorizedCodeFlowVerified: false, physicalAcceptanceVerified: false,
  completeSecurityReviewVerified: false, cleanInstallVerified: false, humanSignoffVerified: false };
test('software-only passing evidence never becomes complete product acceptance', () => {
  const result = evaluateAcceptance(matrix, facts); assert.equal(result.accepted, false); assert.equal(result.passedGates, 1);
});
test('flipping matrix labels cannot bypass missing hardware, official authorization and signoff evidence', () => {
  const claimed = structuredClone(matrix); for (const gate of claimed.gates) gate.status = 'pass';
  claimed.scope.declaredSupportFrozen = true; claimed.candidate.sourceRevision = 'a'.repeat(40); claimed.candidate.artifactSha256 = 'b'.repeat(64);
  const result = evaluateAcceptance(claimed, facts); assert.equal(result.accepted, false);
  assert.ok(result.gateResults.filter(gate => gate.id !== 'G01').every(gate => !gate.verified));
});
test('missing evidence and omitted critical gates fail closed', () => {
  assert.equal(evaluateAcceptance(matrix, facts, ['artifacts/bounded-upstream-execution.json']).passedGates, 0);
  const omitted = structuredClone(matrix); omitted.gates.pop(); assert.throws(() => evaluateAcceptance(omitted, facts));
});
test('invalid device counts and invalid candidate identities cannot certify acceptance', () => {
  assert.throws(() => evaluateAcceptance(matrix, { ...facts, realDeviceCount: NaN }));
  const malformed = structuredClone(matrix); malformed.candidate.artifactSha256 = 'not-a-checksum';
  assert.throws(() => evaluateAcceptance(malformed, facts));
});
