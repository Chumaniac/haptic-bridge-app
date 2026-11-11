import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Catalog } from '../catalog.ts';
const detailsSchema = z.strictObject({ version: z.literal(1), source: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/), fetchedAt: z.string(),
  profiles: z.array(z.strictObject({ id: z.string().max(80), transports: z.array(z.string().max(80)).max(16) })).max(100) });
export function connectionLabels(catalog: Catalog): Map<string, string[]> {
  try {
    const raw = readFileSync(new URL('../../data/studio-transports.json', import.meta.url));
    if (raw.length > 32768) throw new Error('Display metadata is too large');
    const details = detailsSchema.parse(JSON.parse(raw.toString('utf8')));
    if (details.sha256 !== catalog.sha256 || details.source !== catalog.source) return new Map();
    return new Map(details.profiles.map(profile => [profile.id, profile.transports]));
  } catch { return new Map(); }
}
