import { z } from 'zod';
import type { TaskSettings } from './types.js';

export function defaultTaskSettings(): TaskSettings {
  return {
    extraction: { outputMode: 'prompt', autoRetry: false, maxRetries: 2, retryDelayMs: 5000 },
    planning: { enabled: true, mode: 'separate' },
  };
}

export function normalizeTaskSettings(value?: { extraction?: Partial<TaskSettings['extraction']>; planning?: Partial<TaskSettings['planning']> }): TaskSettings {
  const defaults = defaultTaskSettings();
  return {
    extraction: { ...defaults.extraction, ...value?.extraction },
    planning: { ...defaults.planning, ...value?.planning },
  };
}

const taskSettingsSchema = z.object({
  extraction: z.object({ outputMode: z.enum(['prompt', 'structured', 'tool']).optional(), autoRetry: z.boolean(), maxRetries: z.number().int().min(0).max(10), retryDelayMs: z.number().int().min(0).max(300000) }).strict(),
  planning: z.object({ enabled: z.boolean(), mode: z.enum(['separate', 'tool']) }).strict(),
}).strict();

export function parseTaskSettings(value: unknown, current?: TaskSettings): TaskSettings {
  const parsed = taskSettingsSchema.parse(value);
  return normalizeTaskSettings({ ...parsed, extraction: { ...parsed.extraction, outputMode: parsed.extraction.outputMode ?? current?.extraction.outputMode ?? 'prompt' } });
}
