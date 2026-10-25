import { readFileSync } from 'node:fs';
import type { PromptPreset } from '../../shared/types.js';
import { defaultPromptTemplates, ENTITY_RESOLUTION_INSTRUCTION, CHARACTER_PROFILE_INSTRUCTION } from '../../shared/prompt-templates.js';
import { neutralGeneralPreset } from '../../shared/neutral-preset.js';
import { v08GeneralPreset } from './legacy-presets/v08-prompts.js';
import { rebornGeneralPreset } from './legacy-presets/reborn-prompts.js';
import { taskPresetsV2 } from './legacy-presets/task-prompts-v2.js';
import { dramatronGeneralBlocks, dramatronTailBlocks } from './legacy-presets/dramatron-prompts.js';
export { NEUTRAL_PRESET_ID } from '../../shared/neutral-preset.js';
export const TAVERN_PRESET_IDS = ['tavern-dramatron-v31', 'tavern-v08', 'tavern-reborn-v23', 'tavern-linux-v13'] as const;
export function tavernGeneralPresets(): PromptPreset[] {
  return [...TAVERN_PRESET_IDS.map(id => JSON.parse(readFileSync(new URL(`../../presets/${id}.json`, import.meta.url), 'utf8')).preset as PromptPreset), neutralGeneralPreset()];
}
export function withTavernPresets() {
  const settings = withPriorDefaultSelections(); settings.general!.presets.splice(1, 0, ...tavernGeneralPresets().slice(0, 4)); return settings;
}
export function withLegacyPresets() {
  const settings = withDramatronPresets(); settings.general!.presets.splice(1, 0, v08GeneralPreset(), rebornGeneralPreset());
  const v2 = taskPresetsV2(ENTITY_RESOLUTION_INSTRUCTION, CHARACTER_PROFILE_INSTRUCTION);
  for (const task of ['writing', 'extraction', 'compression'] as const) settings.presets[task].splice(1, 0, v2[task]);
  return settings;
}
export function legacyDramatronPreset(): PromptPreset {
  return { id: 'default-general', name: 'Dramatron 防截断与防空回', textFilter: 'dramatron', blocks: [
    ...dramatronGeneralBlocks().slice(0, 2),
    { id: 'snow-ack', name: '前置文本结束', role: 'assistant', enabled: true, content: '前置填充文本已结束，以下按新任务的资料与要求执行。' },
    { id: 'task-slot', name: '插入当前任务提示词', role: 'system', enabled: true, content: '', slot: 'task' },
    ...dramatronTailBlocks(),
  ] };
}
export function withDramatronPresets() {
  const settings = withPriorDefaultSelections(); settings.general!.presets.unshift(legacyDramatronPreset()); settings.general!.selected = 'default-general'; return settings;
}

/** Exercise saved earlier editions without accidentally selecting fresh v4. */
export function withPriorDefaultSelections() {
  const settings = defaultPromptTemplates();
  settings.general!.selected = 'general-neutral-v1';
  settings.general!.presets.sort((a, b) => a.id.localeCompare(b.id));
  for (const task of ['writing', 'extraction', 'compression', 'image'] as const) {
    const id = task === 'image' ? 'default-image-v3' : `default-${task}`;
    settings.selected[task] = id;
    const edition = (value: string) => Number(value.match(/-v(\d+)$/)?.[1] ?? 0);
    settings.presets[task].sort((a, b) => Number(a.id !== id) - Number(b.id !== id) || edition(a.id) - edition(b.id));
  }
  return settings;
}
