import { z } from 'zod';
import type { TaskSettings, WritingTaskSettings } from './types.js';

type NormalizedTaskSettings = TaskSettings & { writing: WritingTaskSettings };

export function defaultTaskSettings(): NormalizedTaskSettings {
  return {
    writing: { recentChapterCount: 3 },
    extraction: { outputMode: 'prompt', autoRetry: false, maxRetries: 2, retryDelayMs: 5000 },
  };
}

export function normalizeTaskSettings(value?: { writing?: Partial<WritingTaskSettings>; extraction?: Partial<TaskSettings['extraction']>; planning?: Partial<TaskSettings['planning']> }): NormalizedTaskSettings {
  const defaults = defaultTaskSettings();
  return {
    writing: { ...defaults.writing, ...value?.writing },
    extraction: { ...defaults.extraction, ...value?.extraction },
  };
}

export const writingTaskSettingsSchema = z.object({
  maxToolRounds: z.number().int().min(1).max(100).optional(),
  recentChapterCount: z.number().int().min(0).max(100),
}).strict();

const taskSettingsSchema = z.object({
  writing: writingTaskSettingsSchema.optional(),
  extraction: z.object({ outputMode: z.enum(['prompt', 'structured', 'tool']).optional(), autoRetry: z.boolean(), maxRetries: z.number().int().min(0).max(10), retryDelayMs: z.number().int().min(0).max(300000) }).strict(),
  planning: z.object({ enabled: z.boolean(), mode: z.enum(['separate', 'tool']) }).strict().optional(),
}).strict();

export function parseTaskSettings(value: unknown, current?: TaskSettings): NormalizedTaskSettings {
  const parsed = taskSettingsSchema.parse(value);
  return normalizeTaskSettings({ ...parsed, writing: parsed.writing ?? current?.writing, extraction: { ...parsed.extraction, outputMode: parsed.extraction.outputMode ?? current?.extraction.outputMode ?? 'prompt' } });
}
