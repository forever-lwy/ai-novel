import { describe, expect, it } from 'vitest';
import { compilePrompt, compileTaskPrompt, defaultPromptTemplates, normalizePromptTemplates, promptTasks, validatePromptTemplates } from '../shared/prompt-templates.js';
import { exportPromptPreset, exportPromptTemplates, preparePromptImport } from '../shared/prompt-transfer.js';
import { neutralGeneralPreset } from '../shared/neutral-preset.js';
import { NEUTRAL_V2_PRESET_ID } from '../shared/neutral-preset-v2.js';
import { TASK_V4_PRESET_IDS } from '../shared/task-prompts-v4.js';
import { NEUTRAL_V3_PRESET_ID, neutralGeneralPresetV3 } from '../shared/neutral-preset-v3.js';
import { TASK_V5_PRESET_IDS } from '../shared/task-prompts-v5.js';
import { withLegacyPresets, withPriorDefaultSelections } from './fixtures/prompt-presets.js';
import { legacyPromptTemplates } from '../shared/legacy-prompt-templates.js';

function priorCatalog() {
  const value = withPriorDefaultSelections();
  value.general!.presets = value.general!.presets.filter(preset => ![NEUTRAL_V2_PRESET_ID, NEUTRAL_V3_PRESET_ID].includes(preset.id));
  value.general!.catalogVersion = 7;
  for (const task of promptTasks) value.presets[task] = value.presets[task].filter(preset => ![TASK_V4_PRESET_IDS[task], TASK_V5_PRESET_IDS[task]].includes(preset.id));
  value.taskCatalogVersions = { writing: 2, extraction: 2, compression: 2, image: 2 };
  return value;
}

const readable = {
  mode: 'continuation', maxWords: '1200', instruction: '继续推进故事。', writingTarget: '续写最近章节之后的新事件。',
  storyMaterialsText: '## 主要人物\n姓名：林舟\n当前地点：灯塔', recentChaptersText: '## 上一章\n章节ID：chapter-1\n林舟在门前停下。',
  continuationAnchorText: '上一章：灯塔\n林舟在门前停下。', extractionIndexText: '人物：林舟；别名：小舟',
  chapterTitle: '灯塔', blockText: '[1] 林舟推开了门。', summaryText: '林舟抵达灯塔，推开门。',
  imageInputText: '图片类型：剧情CG\n目标场景：林舟推开灯塔的门。', imageSystemPrompt: '清晨柔和的光线。', maxCharacterReferences: '2',
};

describe('readable prompt editions and additive catalog migration', () => {
  it('selects v3/v5 for fresh settings while retaining all older built-ins byte-for-byte', () => {
    const fresh = defaultPromptTemplates();
    expect(fresh.general!.selected).toBe(NEUTRAL_V3_PRESET_ID);
    expect(fresh.selected).toEqual(TASK_V5_PRESET_IDS);
    expect(fresh.general!.presets.find(preset => preset.id === 'general-neutral-v1')).toEqual(neutralGeneralPreset());
    const framework = fresh.general!.presets.find(preset => preset.id === NEUTRAL_V3_PRESET_ID)!;
    expect(framework.textFilter).toBeUndefined();
    expect(framework.responseCarrier).toMatchObject({ archive: false });
    expect(framework.blocks.map(block => block.content).join('\n')).not.toMatch(/<archive|<think|\/workspace\/archive|思考|思维|独立字段|内部/);
    expect(framework).toEqual(neutralGeneralPresetV3());
    for (const task of promptTasks) {
      expect(fresh.presets[task].some(preset => preset.id === `default-${task}-v3`)).toBe(true);
      if (task !== 'image') expect(fresh.presets[task].some(preset => preset.id === `default-${task}`)).toBe(true);
      expect(fresh.presets[task].some(preset => preset.id === TASK_V4_PRESET_IDS[task] && preset.generalPresetId === NEUTRAL_V2_PRESET_ID)).toBe(true);
      expect(fresh.presets[task][0].generalPresetId).toBe(NEUTRAL_V3_PRESET_ID);
    }
    expect(validatePromptTemplates(fresh)).toEqual(fresh);
  });

  it('adds editions without changing prior selections, bindings, edited contents or copied presets', () => {
    const old = priorCatalog();
    old.general!.presets[0].blocks[0].content += '\n作者保留的通用规则。';
    old.presets.writing[0].blocks[0].content += '\n作者保留的写作规则。';
    const copy = { ...structuredClone(old.presets.writing[0]), id: 'author-copy', name: '作者副本', generalPresetId: 'general-neutral-v1' };
    old.presets.writing.push(copy); old.selected.writing = copy.id;
    const before = structuredClone(old);
    const upgraded = normalizePromptTemplates(old);
    expect(old).toEqual(before);
    expect(upgraded.selected).toEqual(before.selected); expect(upgraded.general!.selected).toBe(before.general!.selected);
    for (const preset of before.general!.presets) expect(upgraded.general!.presets.find(item => item.id === preset.id)).toEqual(preset);
    for (const task of promptTasks) for (const preset of before.presets[task]) expect(upgraded.presets[task].find(item => item.id === preset.id)).toEqual(preset);
    expect(upgraded.general!.presets.at(-1)!.id).toBe(NEUTRAL_V3_PRESET_ID);
    for (const task of promptTasks) expect(upgraded.presets[task].at(-1)!.id).toBe(TASK_V5_PRESET_IDS[task]);
    expect(normalizePromptTemplates(upgraded)).toEqual(upgraded);
  });

  it('does not resurrect editions that the author deleted after the catalog milestone', () => {
    const settings = normalizePromptTemplates(priorCatalog());
    for (const task of promptTasks) settings.presets[task] = settings.presets[task].filter(preset => preset.id !== TASK_V4_PRESET_IDS[task]);
    settings.general!.presets = settings.general!.presets.filter(preset => preset.id !== NEUTRAL_V2_PRESET_ID);
    expect(normalizePromptTemplates(settings)).toEqual(settings);
  });

  it('normalizes pre-image and pre-general backups before adding a bound new edition', () => {
    const old = structuredClone(legacyPromptTemplates);
    const before = structuredClone(old);
    const migrated = normalizePromptTemplates(old);
    expect(old).toEqual(before);
    expect(migrated.selected.writing).toBe(before.selected.writing);
    expect(migrated.selected.extraction).toBe(before.selected.extraction);
    expect(migrated.selected.compression).toBe(before.selected.compression);
    expect(migrated.general!.selected).toBe('general-neutral-v1');
    expect(migrated.general!.presets.find(preset => preset.id === 'general-neutral-v1')).toEqual(neutralGeneralPreset());
    expect(migrated.general!.presets.some(preset => preset.id === NEUTRAL_V2_PRESET_ID)).toBe(true);
    for (const task of promptTasks) expect(migrated.presets[task].some(preset => preset.id === TASK_V4_PRESET_IDS[task])).toBe(true);
    expect(migrated.presets.image.some(preset => preset.id === 'default-image-v3' && !preset.generalPresetId)).toBe(true);
    expect(migrated.presets.image.some(preset => preset.id === TASK_V4_PRESET_IDS.image)).toBe(true);
    expect(() => validatePromptTemplates(migrated)).not.toThrow();
    expect(normalizePromptTemplates(migrated)).toEqual(migrated);
  });

  it('keeps the historical v1 fallback after retiring the whole general catalog, then appends new editions', () => {
    const old = priorCatalog();
    const retired = withLegacyPresets().general!.presets.find(preset => preset.id === 'default-general')!;
    old.general = { selected: retired.id, catalogVersion: 0, presets: [retired] };
    old.catalogCleanupVersion = 1;
    const before = structuredClone(old);
    const migrated = normalizePromptTemplates(old);
    expect(old).toEqual(before);
    expect(migrated.selected).toEqual(before.selected);
    expect(migrated.general!.selected).toBe('general-neutral-v1');
    expect(migrated.general!.presets.map(preset => preset.id)).toEqual(['general-neutral-v1', NEUTRAL_V2_PRESET_ID, NEUTRAL_V3_PRESET_ID]);
    expect(migrated.general!.presets[0]).toEqual(neutralGeneralPreset());
    for (const task of promptTasks) {
      for (const preset of before.presets[task]) expect(migrated.presets[task].find(item => item.id === preset.id)).toEqual(preset);
      expect(migrated.presets[task].some(preset => preset.id === TASK_V4_PRESET_IDS[task])).toBe(true);
    }
    expect(normalizePromptTemplates(migrated)).toEqual(migrated);
    expect(defaultPromptTemplates().general!.selected).toBe(NEUTRAL_V3_PRESET_ID);
  });

  it('keeps an unbound fallback while retiring the only old task, then safely adds its v4 dependency', () => {
    const old = priorCatalog(); old.catalogCleanupVersion = 1; old.general!.catalogVersion = 0;
    old.presets.writing = [withLegacyPresets().presets.writing.find(preset => preset.id === 'default-writing-v2')!];
    old.selected.writing = 'default-writing-v2';
    const migrated = normalizePromptTemplates(old);
    expect(migrated.selected.writing).toBe('default-writing');
    expect(migrated.presets.writing[0].generalPresetId).toBeUndefined();
    expect(migrated.general!.presets.some(preset => preset.id === NEUTRAL_V2_PRESET_ID)).toBe(true);
    expect(migrated.presets.writing.some(preset => preset.id === TASK_V4_PRESET_IDS.writing)).toBe(true);
    expect(() => validatePromptTemplates(migrated)).not.toThrow();
  });

  it('defers when the text byte budget is full without replacing any saved text', () => {
    const old = priorCatalog(); const blocks = old.general!.presets[0].blocks;
    for (let index = 0; index < 9; index++) blocks.push({ id: `padding-${index}`, name: '作者长提示', role: 'system', enabled: false, content: 'x'.repeat(100000) });
    const tail = { id: 'padding-last', name: '作者剩余提示', role: 'system' as const, enabled: false, content: '' }; blocks.push(tail);
    let lower = 0; let upper = 100000;
    while (lower < upper) {
      const length = Math.ceil((lower + upper) / 2); tail.content = 'x'.repeat(length);
      try { validatePromptTemplates(old); lower = length; } catch { upper = length - 1; }
    }
    tail.content = 'x'.repeat(lower);
    expect(() => validatePromptTemplates(old)).not.toThrow();
    const before = structuredClone(old); expect(normalizePromptTemplates(old)).toEqual(before);
    blocks.splice(blocks.findIndex(block => block.id === 'padding-0'), 1);
    const migrated = normalizePromptTemplates(old);
    expect(migrated.general!.presets.some(preset => preset.id === NEUTRAL_V2_PRESET_ID)).toBe(true);
    for (const task of promptTasks) expect(migrated.presets[task].some(preset => preset.id === TASK_V4_PRESET_IDS[task])).toBe(true);
  });

  it('defers a full catalog and its dependent tasks, then adds without displacing an author entry', () => {
    const settings = priorCatalog();
    settings.general!.presets = Array.from({ length: 20 }, (_, index) => ({ ...neutralGeneralPreset(), id: `author-general-${index}` }));
    settings.general!.selected = settings.general!.presets[0].id;
    settings.presets.writing = Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(settings.presets.writing[0]), id: `author-writing-${index}` }));
    settings.selected.writing = settings.presets.writing[0].id;
    const before = structuredClone(settings);
    const full = normalizePromptTemplates(settings);
    expect(full).toEqual(before);
    full.general!.presets.pop(); full.presets.writing.pop();
    const upgraded = normalizePromptTemplates(full);
    expect(upgraded.general!.presets).toHaveLength(20); expect(upgraded.presets.writing).toHaveLength(20);
    expect(upgraded.general!.presets.at(-1)!.id).toBe(NEUTRAL_V2_PRESET_ID);
    expect(upgraded.presets.writing.at(-1)!.id).toBe(TASK_V4_PRESET_IDS.writing);
    expect(upgraded.general!.selected).toBe(before.general!.selected); expect(upgraded.selected.writing).toBe(before.selected.writing);
  });

  it('round-trips new task and framework imports without restoring tag filtering or archiving materials', () => {
    const settings = defaultPromptTemplates();
    const data = exportPromptPreset(settings, 'writing');
    const imported = preparePromptImport(JSON.stringify(data), settings);
    expect(imported.kind).toBe('preset'); if (imported.kind !== 'preset') return;
    const task = imported.templates.presets.writing.find(preset => preset.id === imported.presetId)!;
    const framework = imported.templates.general!.presets.find(preset => preset.id === task.generalPresetId)!;
    expect(framework.id).not.toBe(NEUTRAL_V3_PRESET_ID); expect(framework.textFilter).toBeUndefined();
    expect(framework.responseCarrier).toMatchObject({ archive: false });
    expect(compileTaskPrompt(imported.templates, 'writing', readable).textFilter).toBeUndefined();
    const collection = preparePromptImport(JSON.stringify(exportPromptTemplates(imported.templates)), defaultPromptTemplates());
    expect(collection.templates).toEqual(imported.templates);
  });

  it('compiles every new task from readable materials and retains the old JSON variables for old presets', () => {
    for (const task of promptTasks) {
      const request = compileTaskPrompt(defaultPromptTemplates(), task, readable);
      expect(request.textFilter).toBeUndefined(); expect(request.responseCarrier).toMatchObject({ archive: false });
      expect(request.prompt).not.toMatch(/<info>|<interaction_history>|<latest_input>|\{\{\w+\}\}/);
      expect(request.prompt).toContain(task === 'writing' ? readable.recentChaptersText : task === 'extraction' ? readable.blockText : task === 'image' ? readable.imageInputText : readable.summaryText);
    }
    const old = priorCatalog(); old.presets.writing[0].blocks = [{ id: 'author-input', name: '旧变量', role: 'user', enabled: true, content: '{{storyMaterials}}\n{{recentChapters}}' }];
    const variables = { ...readable, storyMaterials: '{"known":"unchanged"}', recentChapters: '[{"text":"a\\nb"}]' };
    expect(compilePrompt(old, 'writing', variables).prompt).toBe(`${variables.storyMaterials}\n${variables.recentChapters}`);
    expect(variables.recentChapters).toBe('[{"text":"a\\nb"}]');
  });
});
