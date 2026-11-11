import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import type { BrandProfile } from '../src/contracts.ts';
const source = 'https://intiface-engine-device-config.intiface.com/buttplug-device-config-v4.json';
const response = await fetch(source, { signal: AbortSignal.timeout(20000), redirect: 'error' });
if (!response.ok || !response.body) throw new Error(`Public catalog returned ${response.status}`);
const chunks: Uint8Array[] = []; let bytes = 0;
for await (const chunk of response.body) {
  bytes += chunk.length; if (bytes > 2000000) throw new Error('Catalog exceeds the 2 MB review bound'); chunks.push(chunk);
}
const payload = Buffer.concat(chunks);
const data = JSON.parse(payload.toString('utf8')) as { version: unknown; protocols: Record<string, unknown> };
if (!data.protocols || typeof data.protocols !== 'object' || Object.keys(data.protocols).length > 2000) throw new Error('Unexpected catalog format');
const brands = [
  ['lovense', 'Lovense', ['lovense']], ['we-vibe', 'We-Vibe', ['wevibe']], ['satisfyer', 'Satisfyer', ['satisfyer']],
  ['monsterpub', '小怪兽 / MonsterPub', ['monsterpub', 'libo']], ['svakom', 'SVAKOM', ['svakom']], ['lelo', 'LELO', ['lelo']],
  ['magic-motion', 'Magic Motion', ['magic-motion']], ['mysteryvibe', 'MysteryVibe', ['mysteryvibe']],
  ['tryfun', '春风 / TryFun', ['tryfun']], ['muse', 'MuSe / Love Spouse', ['muse']],
  ['joyhub', 'Joyhub', ['joyhub']], ['galaku', 'Galaku', ['galaku']],
] as const;
function names(node: unknown, result: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) names(child, result); return; }
  const object = node as Record<string, unknown>;
  if (typeof object.name === 'string') result.add(object.name);
  if (object.name && typeof object.name === 'object') for (const text of Object.values(object.name)) if (typeof text === 'string') result.add(text);
  for (const child of Object.values(object)) if (child && typeof child === 'object') names(child, result);
}
const profiles: BrandProfile[] = brands.map(([id, name, prefixes]) => {
  const normalizedPrefixes = prefixes.map(prefix => prefix.replace(/[^a-z0-9]/g, ''));
  const selected = Object.entries(data.protocols).filter(([key, value]) => {
    if (prefixes.some(prefix => key.startsWith(prefix))) return true;
    const recordedNames = new Set<string>(); names(value, recordedNames);
    return [...recordedNames].some(model => normalizedPrefixes.some(prefix => model.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(prefix)));
  });
  const modelNames = new Set<string>(); for (const [, value] of selected) names(value, modelNames);
  return { id, name, source, evidence: 'catalog-only', protocolIds: selected.map(([key]) => key), models: [...modelNames].sort() };
});
const protocols = Object.entries(data.protocols).map(([id, value]) => {
  const modelNames = new Set<string>(); names(value, modelNames);
  return { id, models: [...modelNames].sort() };
});
await mkdir('data', { recursive: true });
const temporary = `data/.catalog-${process.pid}.json`;
await writeFile(temporary, JSON.stringify({ source, fetchedAt: new Date().toISOString(), sha256: createHash('sha256').update(payload).digest('hex'),
  sourceConfigVersion: data.version, protocolEntries: Object.keys(data.protocols).length, hardwareVerified: false, profiles, protocols }, null, 2) + '\n');
await rename(temporary, 'data/catalog.json');
console.log(`Saved public compatibility records for ${profiles.length} brand groups; hardware verification remains pending.`);
