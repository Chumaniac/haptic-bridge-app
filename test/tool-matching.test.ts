import test from 'node:test';
import assert from 'node:assert/strict';
import { readCatalog } from '../src/catalog.ts';
import { buildToolMatchingReport } from '../scripts/lib/tool-matching.ts';

const evidence = { nativeSoftwareInteroperability: 'passed', intifaceCentralGuiTested: false,
  lovenseOfficialApiImplemented: false, physicalDevicesTested: 0 };
test('software evidence and catalog matches never claim physical compatibility', () => {
  const report = buildToolMatchingReport(readCatalog(), evidence, 'Lovense');
  assert.ok(report.matches.some(match => match.id === 'lovense'));
  assert.ok(report.matches.every(match => match.physicalCompatibility === 'unverified' && match.evidence === 'catalog-only'));
  assert.equal(report.connectsDevices, false); assert.equal(report.networkRequests, 0);
  assert.equal(report.tools.find(tool => tool.id === 'lovense-api')!.status, 'not-integrated');
});
test('numeric input is not resolved, echoed or converted into device access', () => {
  const report = buildToolMatchingReport(readCatalog(), evidence, '0001234567');
  assert.equal(report.queryKind, 'numeric-code-not-supported'); assert.equal(report.matches.length, 0);
  assert.equal(report.validatesControlCodes, false); assert.ok(!JSON.stringify(report).includes('0001234567'));
});
test('catalog keyword queries support brand labels and remain bounded', () => {
  const catalog = readCatalog();
  assert.ok(buildToolMatchingReport(catalog, evidence, 'we vibe').matches.some(match => match.id === 'we-vibe'));
  assert.ok(buildToolMatchingReport(catalog, evidence, '小怪兽').matches.some(match => match.id === 'monsterpub' && match.examples.length > 0));
  assert.equal(buildToolMatchingReport(catalog, evidence, 'unknown-query-marker').matches.length, 0);
  assert.throws(() => buildToolMatchingReport(catalog, evidence, 'x'.repeat(121)));
});
