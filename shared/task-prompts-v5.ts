import type { PromptPreset, PromptTask } from './types.js';
import { NEUTRAL_V3_PRESET_ID } from './neutral-preset-v3.js';
import { taskPresetsV4 } from './task-prompts-v4.js';

export const TASK_V5_PRESET_IDS: Record<PromptTask, string> = {
  writing: 'default-writing-v5', extraction: 'default-extraction-v5', compression: 'default-compression-v5', image: 'default-image-v5',
};

/** Task materials keep their format; this edition opts into the v3 framework. */
export function taskPresetsV5(extractionRules: string, compressionRules: string): Record<PromptTask, PromptPreset> {
  const presets = taskPresetsV4(extractionRules, compressionRules);
  for (const task of Object.keys(TASK_V5_PRESET_IDS) as PromptTask[]) {
    const preset = presets[task];
    preset.id = TASK_V5_PRESET_IDS[task];
    preset.name = preset.name.replace(' v4 ', ' v5 ');
    preset.generalPresetId = NEUTRAL_V3_PRESET_ID;
    preset.blocks = preset.blocks.map(block => ({ ...block, id: block.id.replace('-v4-', '-v5-') }));
  }
  return presets;
}
