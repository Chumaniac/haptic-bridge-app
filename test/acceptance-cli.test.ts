import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('missing or invalid historical receipts generate a bounded negative verdict', async () => {
  const source = fileURLToPath(new URL('../', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'haptic-receipts-'));
  try {
    for (const subdir of ['scripts/lib', 'docs']) await mkdir(join(dir, subdir), { recursive: true });
    for (const file of ['scripts/acceptance.ts', 'scripts/lib/acceptance.ts', 'docs/acceptance-matrix.json', 'package.json']) {
      await copyFile(join(source, file), join(dir, file));
    }
    await symlink(join(source, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const receipt = 'artifacts/real-fusion-status.json';
    const run = async () => {
      const result = spawnSync(process.execPath, ['scripts/acceptance.ts'], {cwd: dir, encoding: 'utf8', timeout: 15000});
      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(await readFile(join(dir, 'artifacts/product-acceptance.json'), 'utf8'));
      assert.equal(report.accepted, false);
      assert.equal(report.requiredGates, 12);
      assert.equal(report.facts.foundationVerified, false);
      return report;
    };
    assert.ok((await run()).missingEvidence.includes(receipt));
    await writeFile(join(dir, receipt), '{"physicalDevicesTested":"12"}');
    const invalid = await run();
    assert.ok(invalid.invalidEvidence.includes(receipt));
    assert.ok(!invalid.missingEvidence.includes(receipt));
    assert.equal(invalid.realDeviceCount, 0);
    assert.equal(await readFile(join(dir, receipt), 'utf8'), '{"physicalDevicesTested":"12"}');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
