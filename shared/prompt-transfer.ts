import { z } from 'zod';
import type { PromptPreset, PromptScope, PromptTemplateSettings } from './types.js';
import { activePromptPreset, defaultPromptTemplates, normalizePromptTemplates, promptPresetList, promptPresetSchema, promptScopes, validatePromptTemplates } from './prompt-templates.js';

// Escaping and JSON structure can be larger than the validated text budget.
export const PROMPT_TRANSFER_BYTE_LIMIT = 8000000;
const presetFileSchema = z.object({
  format: z.literal('ai-novel-prompt-preset'), version: z.union([z.literal(1), z.literal(2)]),
  task: z.enum(promptScopes), preset: promptPresetSchema, generalPreset: promptPresetSchema.optional(),
}).strict();
const collectionFileSchema = z.object({ format: z.literal('ai-novel-prompt-templates'), version: z.literal(1), templates: z.unknown() }).strict();

export function clonePromptPreset(preset: PromptPreset, name = preset.name): PromptPreset {
  const copy = structuredClone(preset);
  return { ...copy, id: crypto.randomUUID(), name, blocks: copy.blocks.map(block => ({ ...block, id: crypto.randomUUID() })) };
}

export function exportPromptPreset(templates: PromptTemplateSettings, task: PromptScope, id?: string) {
  const settings = validatePromptTemplates(templates);
  const preset = id ? promptPresetList(settings, task).find(value => value.id === id) : activePromptPreset(settings, task);
  if (!preset) throw new Error('要导出的预设不存在。');
  return structuredClone({
    format: 'ai-novel-prompt-preset' as const, version: 2 as const, task, preset,
    ...(task !== 'general' && preset.useGeneral !== false ? { generalPreset: settings.general?.presets.find(value => value.id === preset.generalPresetId) ?? activePromptPreset(settings, 'general') } : {}),
  });
}

export function exportPromptTemplates(templates: PromptTemplateSettings) {
  return { format: 'ai-novel-prompt-templates' as const, version: 1 as const, templates: validatePromptTemplates(templates) };
}

export type PromptImport = { kind: 'collection'; templates: PromptTemplateSettings }
  | { kind: 'preset'; task: PromptScope; templates: PromptTemplateSettings; presetId: string; generalPresetId?: string; generalName?: string };

/** Pure preparation: nothing is persisted or merged until the editor applies it. */
export function preparePromptImport(text: string, current: PromptTemplateSettings): PromptImport {
  if (new TextEncoder().encode(text).byteLength > PROMPT_TRANSFER_BYTE_LIMIT) throw new Error(`文件过大，最多 ${PROMPT_TRANSFER_BYTE_LIMIT} 字节。`);
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON 格式不正确，请检查文件或粘贴的内容。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请使用本项目导出的预设、任务提示词或整套提示词 JSON。');
  if ((parsed as { format?: unknown }).format === 'ai-novel-prompt-templates') {
    const result = collectionFileSchema.safeParse(parsed);
    if (!result.success || !result.data.templates) throw new Error('整套提示词的格式、版本或内容不正确。');
    // A backup is author-owned: do not remove previously exported editions.
    const templates = validatePromptTemplates(result.data.templates);
    templates.catalogCleanupVersion = 2;
    return { kind: 'collection', templates: normalizePromptTemplates(templates) };
  }
  const result = presetFileSchema.safeParse(parsed);
  if (!result.success) throw new Error('预设格式、版本、任务类型或字段不正确，请使用本项目导出的文件。');
  const payload = result.data;
  if (payload.task === 'general' && (payload.version === 1 || payload.generalPreset)) throw new Error('通用预设格式不正确，不能嵌套另一份通用预设。');
  for (const preset of [payload.preset, payload.generalPreset].filter(Boolean) as PromptPreset[]) {
    if (new Set(preset.blocks.map(block => block.id)).size !== preset.blocks.length) throw new Error('同一预设内的提示词块标识不能重复。');
  }
  const imported = clonePromptPreset(payload.preset);
  if (payload.version === 1) { imported.useGeneral = false; delete imported.generalPresetId; }
  const next = structuredClone(current); next.general ??= defaultPromptTemplates().general;
  let general: PromptPreset | undefined;
  if (payload.task === 'general') { next.general!.presets.push(imported); next.general!.selected = imported.id; }
  else {
    if (payload.generalPreset) {
      general = clonePromptPreset(payload.generalPreset); next.general!.presets.push(general); imported.generalPresetId = general.id;
    } else if (imported.useGeneral !== false && imported.generalPresetId) {
      throw new Error('任务提示词缺少它绑定的通用预设，请重新导出后导入。');
    }
    next.presets[payload.task].push(imported); next.selected[payload.task] = imported.id;
  }
  const templates = validatePromptTemplates(next);
  return { kind: 'preset', task: payload.task, templates, presetId: imported.id,
    ...(general ? { generalPresetId: general.id, generalName: general.name } : {}) };
}
