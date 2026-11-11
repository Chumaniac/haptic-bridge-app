import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudioCore } from '../src/studio/core.ts';
import { createStudio } from '../src/studio/server.ts';
import { initialLibrary } from '../src/studio/schema.ts';

await mkdir('artifacts/studio', { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'hb-studio-resource-'));
let app: Awaited<ReturnType<typeof createStudio>> | undefined;
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024 * 100) / 100;
try {
  global.gc?.(); const memoryBefore = process.memoryUsage();
  const core = new StudioCore({ autoTick: false });
  const cpuBefore = process.cpuUsage(); const start = performance.now();
  core.claim('local-performance-fixture'); core.deviceAction('local-performance-fixture', 'virtual-one', 'connect'); core.deviceAction('local-performance-fixture', 'virtual-one', 'arm');
  const epoch = core.snapshot('local-performance-fixture').devices[0]!.epoch;
  for (let sequence = 1; sequence <= 20000; sequence++) core.output('local-performance-fixture', 'virtual-one', 0, epoch, sequence, sequence % 101);
  const elapsedMs = performance.now() - start; const cpu = process.cpuUsage(cpuBefore);
  const active = core.snapshot('local-performance-fixture'); core.close(); const closed = core.snapshot('local-performance-fixture');
  assert.equal(active.resources.historySize, 120); assert.equal(active.resources.outputCommands, 20000);
  assert.equal(closed.resources.activePlaybacks, 0); assert.equal(closed.resources.timers, 0); assert.equal(closed.devices[0]!.values[0], 0);
  global.gc?.(); const memoryAfter = process.memoryUsage();
  app = await createStudio({ file: join(directory, 'studio.json') }); const url = await app.listen(0);
  const sessionResponse = await fetch(`${url}/api/session`); const bootstrap = await sessionResponse.json() as { session: string; csrf: string };
  const headers = { cookie: sessionResponse.headers.get('set-cookie')!.split(';')[0]!, origin: url, 'content-type': 'application/json', 'x-studio-session': bootstrap.session, 'x-csrf-token': bootstrap.csrf };
  const post = (path: string, data: unknown) => fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(data) });
  assert.equal((await post('/api/control', { action: 'claim' })).status, 200);
  const library = initialLibrary().data;
  library.patterns = Array.from({ length: 20 }, (_, index) => ({ id: randomUUID(), name: `容量检查 ${index + 1}`, cycles: 1, steps: Array.from({ length: 64 }, () => ({ value: 50, durationMs: 100 })) }));
  const commitStarted = performance.now(); const response = await post('/api/import', { revision: 0, data: library }); assert.equal(response.status, 200); await response.arrayBuffer();
  const maxLibraryCommitMs = performance.now() - commitStarted;
  const persistedBytes = (await readFile(join(directory, 'studio.json'))).length;
  assert.ok(persistedBytes <= 131072); assert.equal(app.store.snapshot().data.patterns.length, 20);
  const latencies: number[] = [];
  for (let sample = 0; sample < 80; sample++) {
    const started = performance.now(); const response = await fetch(`${url}/api/state`, { headers }); assert.equal(response.status, 200); await response.arrayBuffer(); latencies.push(performance.now() - started);
  }
  latencies.sort((a, b) => a - b);
  const idleCpu = process.cpuUsage(); const idleStarted = performance.now(); await new Promise(resolve => setTimeout(resolve, 1500));
  const idleElapsed = performance.now() - idleStarted; const idleUsage = process.cpuUsage(idleCpu);
  await app.close(); const resourcesAfterClose = app.core.snapshot('observer').resources; app = undefined;
  assert.equal(resourcesAfterClose.timers, 0); assert.equal(resourcesAfterClose.activePlaybacks, 0);
  const result = { status: 'passed', scope: 'local virtual state machine and own HTTP server only', hardwareAccess: false, gcAvailable: typeof global.gc === 'function',
    virtualUpdates: { count: 20000, elapsedMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, historyBound: active.resources.historySize },
    memory: { before: { heapMiB: mb(memoryBefore.heapUsed), rssMiB: mb(memoryBefore.rss) }, after: { heapMiB: mb(memoryAfter.heapUsed), rssMiB: mb(memoryAfter.rss) }, note: 'Short-process measurement; not a long-term no-growth claim.' },
    maximumLibrary: { patterns: 20, stepsPerPattern: 64, persistedBytes, commitMs: maxLibraryCommitMs },
    http: { samples: latencies.length, p50Ms: latencies[40], p99Ms: latencies[79] },
    idle: { elapsedMs: idleElapsed, cpuUserMs: idleUsage.user / 1000, cpuSystemMs: idleUsage.system / 1000 }, resourcesAfterClose };
  await writeFile('artifacts/studio/performance-result.json', JSON.stringify(result, null, 2));
  console.log('Local Studio resource check passed; no hardware or external target.');
} finally { if (app) await app.close(); await rm(directory, { recursive: true, force: true }); }
