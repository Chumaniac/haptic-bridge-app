import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { readCatalog } from '../src/catalog.ts';
const catalog = readCatalog();
const response = await fetch(catalog.source, { signal: AbortSignal.timeout(20000), redirect: 'error' });
if (!response.ok || !response.body) throw new Error('Public catalog is unavailable');
const chunks: Uint8Array[] = []; let bytes = 0;
for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2000000) throw new Error('Public catalog exceeds the review bound'); chunks.push(chunk); }
const payload = Buffer.concat(chunks); const sha256 = createHash('sha256').update(payload).digest('hex');
if (sha256 !== catalog.sha256) throw new Error('Public catalog has changed; review and sync its inventory before updating display metadata');
const source = JSON.parse(payload.toString('utf8')) as { protocols: Record<string, { communication?: Record<string, unknown>[] }> };
const labels: Record<string, string> = { btle: '蓝牙 BLE', serial: '串口 / USB 串口', hid: 'USB HID', xinput: 'XInput',
  'lovense-connect-service': 'Lovense Connect 服务', 'lovense-dongle': '专用接收器', websocket: '设备 WebSocket 服务', 'websocket-server': '设备 WebSocket 服务' };
const profiles = catalog.profiles.map(profile => {
  const methods = new Set<string>();
  for (const id of profile.protocolIds) for (const communication of source.protocols[id]?.communication ?? []) {
    for (const key of Object.keys(communication)) methods.add(labels[key] ?? '其他连接记录（待核对）');
  }
  return { id: profile.id, transports: [...methods].sort() };
});
await mkdir('data', { recursive: true }); const temporary = `data/.studio-transports-${randomUUID()}.json`;
try {
  await writeFile(temporary, JSON.stringify({ version: 1, source: catalog.source, sha256, fetchedAt: new Date().toISOString(), profiles }, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, 'data/studio-transports.json');
} catch (error) { await unlink(temporary).catch(() => {}); throw error; }
console.log(`Saved public connection labels for ${profiles.length} catalog groups; no protocol payloads or device access.`);
