import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaultPromptTemplates, normalizePromptTemplates, promptPresetList, promptScopes, promptTasks, validatePromptTemplates } from '../shared/prompt-templates.js';
import { exportPromptPreset, exportPromptTemplates, preparePromptImport, PROMPT_TRANSFER_BYTE_LIMIT } from '../shared/prompt-transfer.js';
import { NEUTRAL_PRESET_ID } from '../shared/neutral-preset.js';
import { isRetiredDefault } from '../shared/retired-preset-fingerprints.js';
import { tavernGeneralPresets, TAVERN_PRESET_IDS, withLegacyPresets } from './fixtures/prompt-presets.js';
import { legacyDramatronPreset } from './fixtures/prompt-presets.js';
import { previousGeneralPromptTemplates } from '../shared/previous-general-prompt-templates.js';
import { previousDramatronPromptTemplates } from '../shared/previous-dramatron-prompt-templates.js';

function previousCatalog() {
  const settings = withLegacyPresets(); settings.general!.presets.splice(3, 0, ...tavernGeneralPresets().slice(0, 4)); delete settings.catalogCleanupVersion; return settings;
}

describe('small built-in catalog and safe retirement', () => {
  it.each([legacyDramatronPreset(), previousGeneralPromptTemplates.general!.presets[0], previousDramatronPromptTemplates.general!.presets[0]])('retires initial Dramatron $name after cleanup v1 without changing author task content', preset => {
    const settings = defaultPromptTemplates(); settings.catalogCleanupVersion = 1; settings.general!.presets.unshift(structuredClone(preset)); settings.general!.selected = preset.id;
    settings.presets.writing[0].blocks[0].content += '\n作者自己的规则'; const before = structuredClone(settings);
    const cleaned = normalizePromptTemplates(settings); expect(settings).toEqual(before);
    expect(cleaned.general!.presets.map(value => value.id)).toEqual([NEUTRAL_PRESET_ID]); expect(cleaned.general!.selected).toBe(NEUTRAL_PRESET_ID);
    expect(cleaned.presets).toEqual(before.presets); expect(cleaned.catalogCleanupVersion).toBe(2); expect(normalizePromptTemplates(cleaned)).toEqual(cleaned);
  });
  it('retains modified, copied or bound initial Dramatron for explicit author recovery', () => {
    const settings = defaultPromptTemplates(); settings.catalogCleanupVersion = 1;
    const changed = legacyDramatronPreset(); changed.blocks[0].content = '作者自己的填充';
    const copy = { ...legacyDramatronPreset(), id: 'author-copy' };
    settings.general!.presets.push(changed, copy); settings.general!.selected = changed.id;
    expect(normalizePromptTemplates(settings).general).toEqual(settings.general);
    settings.general!.presets[1] = legacyDramatronPreset(); settings.presets.writing[0].generalPresetId = 'default-general';
    expect(normalizePromptTemplates(settings).general).toEqual(settings.general);
  });
  it('ships only the original defaults, neutral framework and four v3 tasks', () => {
    const settings = defaultPromptTemplates();
    expect(settings.general!.presets.map(preset => preset.id)).toEqual([NEUTRAL_PRESET_ID]);
    for (const task of promptTasks) expect(settings.presets[task].map(preset => preset.id)).toEqual(task === 'image' ? ['default-image-v3'] : [`default-${task}`, `default-${task}-v3`]);
    expect(validatePromptTemplates(settings)).toEqual(settings);
  });
  it('recognizes every complete previous default and cleans it once without mutating input', () => {
    const settings = previousCatalog(); const before = structuredClone(settings);
    const removed = [...settings.general!.presets, ...Object.values(settings.presets).flat()].filter(isRetiredDefault);
    expect(removed).toHaveLength(10);
    for (const preset of removed) expect(isRetiredDefault(validatePromptTemplates(settings).general!.presets.find(value => value.id === preset.id) ?? preset)).toBe(true);
    const cleaned = normalizePromptTemplates(settings);
    expect(settings).toEqual(before); expect(cleaned).toEqual(defaultPromptTemplates()); expect(normalizePromptTemplates(cleaned)).toEqual(cleaned);
  });
  it('preserves edits, copies, explicit bindings and their current choices', () => {
    const settings = previousCatalog(); const general = settings.general!.presets.find(preset => preset.id === TAVERN_PRESET_IDS[0])!;
    settings.presets.writing[0].generalPresetId = general.id;
    const reborn = settings.general!.presets.find(preset => preset.id === 'default-general-reborn')!; reborn.blocks[0].enabled = !reborn.blocks[0].enabled;
    settings.general!.selected = reborn.id;
    const writing = settings.presets.writing.find(preset => preset.id === 'default-writing-v2')!; writing.name = '作者自己的版本'; settings.selected.writing = writing.id;
    const copy = { ...structuredClone(settings.general!.presets.find(preset => preset.id === TAVERN_PRESET_IDS[1])!), id: 'author-copy' }; settings.general!.presets.push(copy);
    const cleaned = normalizePromptTemplates(settings);
    for (const preset of [general, reborn, copy]) expect(cleaned.general!.presets.find(value => value.id === preset.id)).toEqual(preset);
    expect(cleaned.presets.writing.find(preset => preset.id === writing.id)).toEqual(writing); expect(cleaned.selected.writing).toBe(writing.id); expect(cleaned.general!.selected).toBe(reborn.id);
  });
  it('repairs removed selections and retains at least one preset per scope', () => {
    const settings = previousCatalog(); settings.general!.presets = [settings.general!.presets[1]]; settings.general!.selected = settings.general!.presets[0].id;
    settings.presets.writing = [settings.presets.writing[1]]; settings.selected.writing = settings.presets.writing[0].id;
    const cleaned = normalizePromptTemplates(settings);
    expect(cleaned.general!.selected).toBe(NEUTRAL_PRESET_ID); expect(cleaned.selected.writing).toBe('default-writing'); expect(() => validatePromptTemplates(cleaned)).not.toThrow();
  });
  it('does not repeat cleanup or resurrect deliberately deleted new editions', () => {
    const settings = previousCatalog(); settings.catalogCleanupVersion = 2;
    settings.general!.presets.pop(); settings.presets.writing.pop();
    expect(normalizePromptTemplates(settings)).toEqual(settings);
  });
  it('defers additions for full author catalogs then retries without displacing entries', () => {
    const settings = defaultPromptTemplates(); settings.general!.catalogVersion = 0; settings.general!.presets = Array.from({ length: 20 }, (_, i) => ({ ...settings.general!.presets[0], id: `author-${i}`, blocks: [{ id: 'slot', name: '任务', role: 'system', enabled: true, slot: 'task', content: '' }] })); settings.general!.selected = 'author-0';
    settings.taskCatalogVersions!.writing = 0; settings.presets.writing = Array.from({ length: 20 }, (_, i) => ({ ...settings.presets.writing[0], id: `author-${i}` })); settings.selected.writing = 'author-0';
    const full = normalizePromptTemplates(settings); expect(full).toEqual(settings);
    full.general!.presets.pop(); full.presets.writing.pop(); const retry = normalizePromptTemplates(full);
    expect(retry.general!.presets.at(-1)!.id).toBe(NEUTRAL_PRESET_ID); expect(retry.presets.writing.at(-1)!.id).toBe('default-writing-v3');
  });
});

describe('portable presets, tasks and full prompt backup', () => {
  it.each(TAVERN_PRESET_IDS)('%s is an optional, independently importable file', id => {
    const text = readFileSync(new URL(`../presets/${id}.json`, import.meta.url), 'utf8'); const before = defaultPromptTemplates();
    const result = preparePromptImport(text, before); expect(result.kind).toBe('preset'); if (result.kind !== 'preset') return;
    const imported = result.templates.general!.presets.find(preset => preset.id === result.presetId)!;
    const source = JSON.parse(text).preset;
    expect(imported).toMatchObject({ name: source.name, responseCarrier: source.responseCarrier }); expect(imported.id).not.toBe(source.id);
    expect(imported.blocks.map(({ id: _id, ...block }) => block)).toEqual(source.blocks.map(({ id: _id, ...block }: any) => block));
    expect(result.templates.selected).toEqual(before.selected); expect(before).toEqual(defaultPromptTemplates());
    expect(normalizePromptTemplates(result.templates)).toEqual(result.templates);
  });
  it.each(promptScopes)('%s round-trips content and creates new IDs on each import', scope => {
    const settings = defaultPromptTemplates(); settings.general!.selected = NEUTRAL_PRESET_ID;
    if (scope !== 'general') settings.selected[scope] = `default-${scope}-v3`;
    const data = exportPromptPreset(settings, scope); const text = JSON.stringify(data); const first = preparePromptImport(text, settings);
    expect(first.kind).toBe('preset'); if (first.kind !== 'preset') return;
    const imported = promptPresetList(first.templates, scope).find(preset => preset.id === first.presetId)!;
    expect(imported.name).toBe(data.preset.name); expect(imported.blocks.map(block => block.content)).toEqual(data.preset.blocks.map(block => block.content));
    const second = preparePromptImport(text, first.templates); if (second.kind !== 'preset') throw new Error('wrong type'); expect(second.presetId).not.toBe(first.presetId);
    if (scope !== 'general') {
      expect(first.templates.general!.selected).toBe(NEUTRAL_PRESET_ID); expect(imported.generalPresetId).toBe(first.generalPresetId);
      for (const task of promptTasks.filter(task => task !== scope)) expect(first.templates.selected[task]).toBe(settings.selected[task]);
      expect(first.templates.general!.presets.find(preset => preset.id === imported.generalPresetId)?.responseCarrier).toEqual(data.generalPreset!.responseCarrier);
    }
  });
  it('imports legacy v1 tasks independently and supports standalone v2 exports', () => {
    const settings = defaultPromptTemplates(); const preset = settings.presets.writing[0];
    const imported = preparePromptImport(JSON.stringify({ format: 'ai-novel-prompt-preset', version: 1, task: 'writing', preset }), settings);
    if (imported.kind !== 'preset') throw new Error('wrong type'); const copy = imported.templates.presets.writing.at(-1)!;
    expect(copy.useGeneral).toBe(false); expect(copy.generalPresetId).toBeUndefined();
    const data = exportPromptPreset(imported.templates, 'writing'); expect(data.generalPreset).toBeUndefined(); expect(() => preparePromptImport(JSON.stringify(data), settings)).not.toThrow();
  });
  it('backs up all choices, disabled blocks, bindings, carrier options and author edits exactly', () => {
    const settings = previousCatalog(); settings.catalogCleanupVersion = 2; settings.general!.selected = 'tavern-reborn-v23'; settings.presets.image[0].generalPresetId = 'tavern-linux-v13';
    settings.presets.writing[0].name = '作者手动名称'; settings.presets.writing[0].blocks[0].enabled = false;
    const data = exportPromptTemplates(settings); expect(Object.keys(data)).toEqual(['format', 'version', 'templates']);
    const restored = preparePromptImport(JSON.stringify(data), defaultPromptTemplates()); expect(restored).toEqual({ kind: 'collection', templates: settings });
  });
  it('keeps historical editions in an old author backup instead of cleaning them on import', () => {
    const old = previousCatalog(); const restored = preparePromptImport(JSON.stringify({ format: 'ai-novel-prompt-templates', version: 1, templates: old }), defaultPromptTemplates());
    expect(restored.templates.general!.presets).toEqual(old.general!.presets); expect(restored.templates.catalogCleanupVersion).toBe(2);
  });
  it.each([
    '[]', 'null', '{', '{"format":"wrong"}',
    JSON.stringify({ ...exportPromptPreset(defaultPromptTemplates(), 'general'), version: 99 }),
    JSON.stringify({ ...exportPromptPreset(defaultPromptTemplates(), 'general'), apiKey: 'must-not-import' }),
    JSON.stringify({ format: 'ai-novel-prompt-templates', version: 1, templates: {} }),
    JSON.stringify({ ...exportPromptPreset(defaultPromptTemplates(), 'general'), preset: { name: 'broken' } }),
  ])('rejects malformed or unsupported files without changing the current config: %s', text => {
    const settings = defaultPromptTemplates(); expect(() => preparePromptImport(text, settings)).toThrow(); expect(settings).toEqual(defaultPromptTemplates());
  });
  it('rejects capacity overflow, invalid variables and missing task dependencies atomically', () => {
    const settings = defaultPromptTemplates(); const data = exportPromptPreset(settings, 'writing');
    settings.presets.writing = Array.from({ length: 20 }, (_, index) => ({ ...settings.presets.writing[0], id: `author-${index}` })); settings.selected.writing = 'author-0';
    expect(() => preparePromptImport(JSON.stringify(data), settings)).toThrow('20');
    const broken = exportPromptPreset(defaultPromptTemplates(), 'writing'); broken.preset.blocks[0].content = '{{unknown}}';
    expect(() => preparePromptImport(JSON.stringify(broken), defaultPromptTemplates())).toThrow('没有变量');
    const missing = exportPromptPreset(defaultPromptTemplates(), 'writing'); missing.preset.generalPresetId = 'absent'; delete missing.generalPreset;
    expect(() => preparePromptImport(JSON.stringify(missing), defaultPromptTemplates())).toThrow('缺少');
    const duplicate = exportPromptPreset(defaultPromptTemplates(), 'writing'); duplicate.preset.blocks[1].id = duplicate.preset.blocks[0].id;
    expect(() => preparePromptImport(JSON.stringify(duplicate), defaultPromptTemplates())).toThrow('标识不能重复');
    expect(() => preparePromptImport(' '.repeat(PROMPT_TRANSFER_BYTE_LIMIT + 1), defaultPromptTemplates())).toThrow('过大');
  });
  it('accepts UTF-8 BOM files and escaped large exports beyond the text-only budget', () => {
    const settings = defaultPromptTemplates();
    settings.presets.writing[0].blocks.push(...Array.from({ length: 8 }, (_, index) => ({ id: `escaped-${index}`, name: '已有文本', role: 'system' as const, enabled: false, content: '\u0001'.repeat(100000) })));
    const data = JSON.stringify(exportPromptTemplates(settings)); expect(Buffer.byteLength(data)).toBeGreaterThan(1000000);
    const restored = preparePromptImport('\uFEFF' + data, defaultPromptTemplates()); expect(restored.templates).toEqual(settings);
  });
});
