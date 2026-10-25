import { describe, expect, it } from 'vitest';
import { COMPRESSION_SYSTEM, defaultPromptTemplates, EXTRACT_SYSTEM, normalizePromptTemplates, promptTasks } from '../shared/prompt-templates.js';
import { NEUTRAL_V2_PRESET_ID, neutralGeneralPresetV2 } from '../shared/neutral-preset-v2.js';
import { NEUTRAL_V3_PRESET_ID, neutralGeneralPresetV3 } from '../shared/neutral-preset-v3.js';
import { TASK_V4_PRESET_IDS, taskPresetsV4 } from '../shared/task-prompts-v4.js';
import { TASK_V5_PRESET_IDS, taskPresetsV5 } from '../shared/task-prompts-v5.js';

function previousCatalog() {
  const settings = defaultPromptTemplates();
  settings.general!.presets = settings.general!.presets.filter(preset => preset.id !== NEUTRAL_V3_PRESET_ID);
  settings.general!.selected = NEUTRAL_V2_PRESET_ID; settings.general!.catalogVersion = 8;
  for (const task of promptTasks) settings.presets[task] = settings.presets[task].filter(preset => preset.id !== TASK_V5_PRESET_IDS[task]);
  settings.selected = { ...TASK_V4_PRESET_IDS }; settings.taskCatalogVersions = { writing: 3, extraction: 3, compression: 3, image: 3 };
  return settings;
}

describe('direct task delivery default editions', () => {
  it('keeps prior editions intact and makes new task editions opt into the new framework', () => {
    const oldGeneral = neutralGeneralPresetV2(); const oldTasks = taskPresetsV4(EXTRACT_SYSTEM, COMPRESSION_SYSTEM);
    const newGeneral = neutralGeneralPresetV3(); const newTasks = taskPresetsV5(EXTRACT_SYSTEM, COMPRESSION_SYSTEM);
    expect(newGeneral.blocks.map(block => block.content).join('\n')).not.toMatch(/思考|思维|独立字段|内部|<think/);
    expect(newGeneral.blocks.filter(block => block.slot !== 'task' && !block.id.endsWith('-delivery')).map(block => block.content))
      .toEqual(oldGeneral.blocks.filter(block => block.slot !== 'task' && !block.id.endsWith('-delivery')).map(block => block.content));
    for (const task of promptTasks) {
      expect(newTasks[task]).toMatchObject({ id: TASK_V5_PRESET_IDS[task], generalPresetId: NEUTRAL_V3_PRESET_ID });
      expect(newTasks[task].blocks.map(({ id: _id, ...block }) => block)).toEqual(oldTasks[task].blocks.map(({ id: _id, ...block }) => block));
      expect(defaultPromptTemplates().presets[task].find(preset => preset.id === TASK_V4_PRESET_IDS[task])).toEqual(oldTasks[task]);
    }
    expect(defaultPromptTemplates().general!.presets.find(preset => preset.id === NEUTRAL_V2_PRESET_ID)).toEqual(oldGeneral);
    expect(defaultPromptTemplates()).toMatchObject({ general: { selected: NEUTRAL_V3_PRESET_ID, catalogVersion: 9 }, selected: TASK_V5_PRESET_IDS, taskCatalogVersions: { writing: 4, extraction: 4, compression: 4, image: 4 } });
  });

  it('adds only new versions to a saved v2/v4 catalog without selecting or rewriting them', () => {
    const old = previousCatalog(); old.general!.presets[0].blocks[0].content += '\n作者通用要求。';
    old.presets.writing[0].blocks[0].content += '\n作者正文要求。';
    const before = structuredClone(old); const upgraded = normalizePromptTemplates(old);
    expect(old).toEqual(before); expect(upgraded.selected).toEqual(before.selected); expect(upgraded.general!.selected).toBe(before.general!.selected);
    expect(upgraded.general!.presets.slice(0, before.general!.presets.length)).toEqual(before.general!.presets);
    expect(upgraded.general!.presets.at(-1)!.id).toBe(NEUTRAL_V3_PRESET_ID);
    for (const task of promptTasks) {
      expect(upgraded.presets[task].slice(0, before.presets[task].length)).toEqual(before.presets[task]);
      expect(upgraded.presets[task].at(-1)!.id).toBe(TASK_V5_PRESET_IDS[task]);
    }
    expect(normalizePromptTemplates(upgraded)).toEqual(upgraded);
  });

  it('preserves deliberate deletion after the new milestones', () => {
    const saved = normalizePromptTemplates(previousCatalog());
    for (const task of promptTasks) saved.presets[task] = saved.presets[task].filter(preset => preset.id !== TASK_V5_PRESET_IDS[task]);
    saved.general!.presets = saved.general!.presets.filter(preset => preset.id !== NEUTRAL_V3_PRESET_ID);
    expect(normalizePromptTemplates(saved)).toEqual(saved);
  });

  it('defers the new framework and its tasks until a full author catalog has room', () => {
    const old = previousCatalog();
    while (old.general!.presets.length < 20) old.general!.presets.push({ ...structuredClone(old.general!.presets[0]), id: `author-general-${old.general!.presets.length}` });
    const before = structuredClone(old); expect(normalizePromptTemplates(old)).toEqual(before);
    old.general!.presets.pop(); const upgraded = normalizePromptTemplates(old);
    expect(upgraded.general!.presets).toHaveLength(20); expect(upgraded.general!.presets.at(-1)!.id).toBe(NEUTRAL_V3_PRESET_ID);
    expect(upgraded.general!.presets.slice(0, 19)).toEqual(before.general!.presets.slice(0, 19));
    for (const task of promptTasks) expect(upgraded.presets[task].at(-1)!.id).toBe(TASK_V5_PRESET_IDS[task]);
  });
});
