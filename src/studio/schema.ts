import { z } from 'zod';

export const limits = { patterns: 20, steps: 64, fileBytes: 131072, playbackMs: 600000, history: 120 } as const;
export const preferencesSchema = z.strictObject({
  defaultIntensity: z.number().int().min(0).max(100),
  defaultDurationMs: z.number().int().min(100).max(30000),
});
const fields = {
  name: z.string().trim().min(1).max(48).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  cycles: z.number().int().min(1).max(10),
  steps: z.array(z.strictObject({ value: z.number().int().min(0).max(100), durationMs: z.number().int().min(100).max(30000) })).min(1).max(limits.steps),
};
export const patternDraftSchema = z.strictObject({ ...fields, id: z.uuid().optional() }).refine(
  item => item.steps.reduce((sum, step) => sum + step.durationMs, 0) * item.cycles <= limits.playbackMs,
  { message: '模式总时长不能超过十分钟。' },
);
export const patternSchema = z.strictObject({ ...fields, id: z.uuid() }).refine(
  item => item.steps.reduce((sum, step) => sum + step.durationMs, 0) * item.cycles <= limits.playbackMs,
);
export const librarySchema = z.strictObject({
  version: z.literal(1), preferences: preferencesSchema, patterns: z.array(patternSchema).max(limits.patterns),
}).refine(item => new Set(item.patterns.map(pattern => pattern.id)).size === item.patterns.length);
export const persistedSchema = z.strictObject({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), data: librarySchema });
export const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
export const defaults = { defaultIntensity: 20, defaultDurationMs: 1000 };
export type Preferences = z.infer<typeof preferencesSchema>;
export type Pattern = z.infer<typeof patternSchema>;
export type PatternDraft = z.infer<typeof patternDraftSchema>;
export type Library = z.infer<typeof librarySchema>;
export type Persisted = z.infer<typeof persistedSchema>;
export const duration = (pattern: Pick<Pattern, 'steps' | 'cycles'>) => pattern.steps.reduce((sum, step) => sum + step.durationMs, 0) * pattern.cycles;
export function initialLibrary(): Persisted {
  return { revision: 0, data: { version: 1, preferences: { ...defaults }, patterns: [
    { id: '00000000-0000-4000-8000-000000000001', name: '轻缓起伏', cycles: 1, steps: [{ value: 10, durationMs: 1000 }, { value: 30, durationMs: 1000 }, { value: 10, durationMs: 1000 }, { value: 0, durationMs: 1000 }] },
    { id: '00000000-0000-4000-8000-000000000002', name: '间歇节奏', cycles: 2, steps: [{ value: 25, durationMs: 500 }, { value: 0, durationMs: 500 }] },
  ] } };
}
