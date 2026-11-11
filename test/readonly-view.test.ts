import test from 'node:test';
import assert from 'node:assert/strict';
import { readCatalog } from '../src/catalog.ts';
import { buildToolMatchingReport } from '../scripts/lib/tool-matching.ts';
import { renderReadOnlyView, type ReadOnlyViewData } from '../scripts/lib/readonly-view.ts';

function data(): ReadOnlyViewData {
  const catalog = readCatalog();
  return { report: buildToolMatchingReport(catalog, { nativeSoftwareInteroperability: 'passed', intifaceCentralGuiTested: false, lovenseOfficialApiImplemented: false, physicalDevicesTested: 0 }),
    profiles: catalog.profiles, acceptance: { accepted: false, verdict: '未通过', passedGates: 1, requiredGates: 12, gateResults: [] } };
}
test('standalone view denies networking and contains no connection or tool-launch actions', () => {
  const html = renderReadOnlyView(data()); assert.ok(html.includes("connect-src 'none'"));
  assert.ok(!html.includes('src="http')); assert.ok(!html.includes('href="http')); assert.ok(!html.includes('<form'));
});
test('untrusted catalog markup stays encoded as inert data', () => {
  const input = data(); const marker = '</script><img src="https://invalid.example" onerror="throw 1">';
  input.profiles[0]!.name = marker;
  const html = renderReadOnlyView(input); assert.ok(!html.includes(marker));
});
test('the view refuses a full acceptance claim with zero physical evidence', () => {
  const input = data(); input.acceptance.accepted = true;
  assert.throws(() => renderReadOnlyView(input));
});
