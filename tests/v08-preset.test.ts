import { describe, expect, it } from 'vitest';
import { compileTaskPrompt, defaultPromptTemplates, normalizePromptTemplates, validatePromptTemplates } from '../shared/prompt-templates.js';
import { v08GeneralPreset, V08_PRESET_ID } from '../shared/v08-prompts.js';
import { cleanDramatronText, createDramatronTextFilter } from '../shared/dramatron-output.js';
import type { PromptTask } from '../shared/types.js';

const variables = { mode: 'original', instruction: '继续故事 {{原样素材}}', context: '故事资料', storyMaterials: '故事资料', recentChapters: '前文', maxWords: 1000, writingTarget: '接着前文写', chapterTitle: '桥边', blockText: '[1] 林舟到达石桥。', summaryText: '林舟到达石桥。' };
function settings() { const value = defaultPromptTemplates(); value.general!.selected = V08_PRESET_ID; return value; }

describe('v0.8 general protection preset', () => {
  it('adds the built-in once while preserving selection, custom changes, deletion and input objects', () => {
    const old = defaultPromptTemplates(); old.general!.presets.pop(); delete old.general!.catalogVersion;
    old.general!.presets[0].name = '作者的框架'; old.general!.presets[0].blocks[0].content = '作者文本';
    const original = structuredClone(old); const migrated = normalizePromptTemplates(old);
    expect(old).toEqual(original); expect(migrated.general!.selected).toBe(old.general!.selected);
    expect(migrated.general!.presets[0]).toEqual(old.general!.presets[0]);
    expect(migrated.general!.presets[1].id).toBe(V08_PRESET_ID);
    expect(normalizePromptTemplates(migrated)).toEqual(migrated);
    migrated.general!.presets.pop();
    expect(normalizePromptTemplates(migrated)).toEqual(migrated);
  });
  it('does not replace a colliding user preset or evict a full catalog', () => {
    const value = settings(); delete value.general!.catalogVersion;
    value.general!.presets[1].name = '作者已修改'; value.general!.presets[1].blocks[0].content = '作者填充';
    expect(normalizePromptTemplates(value).general!.presets).toEqual(value.general!.presets);
    const full = settings(); full.general!.presets = Array.from({ length: 20 }, (_, i) => ({ ...v08GeneralPreset(), id: `custom-${i}`, blocks: [{ id: 'slot', name: '插槽', role: 'system' as const, enabled: true, content: '', slot: 'task' as const }] }));
    full.general!.selected = 'custom-0'; delete full.general!.catalogVersion;
    expect(normalizePromptTemplates(full).general).toEqual(full.general);
    full.general!.presets.pop(); expect(normalizePromptTemplates(full).general!.presets.at(-1)?.id).toBe(V08_PRESET_ID);
  });
  it('retains literal padding and produces deterministic request data without roleplay modules', () => {
    const value = settings(); const builtin = value.general!.presets[1];
    expect(builtin.blocks[0]).toMatchObject({ enabled: false, feature: 'literal' });
    expect(builtin.blocks[0].content).toHaveLength(14460); expect(builtin.blocks[2].content).toHaveLength(7514);
    builtin.blocks[2].content = '填充 {{不展开}}';
    expect(() => validatePromptTemplates(value)).not.toThrow();
    const first = compileTaskPrompt(value, 'writing', variables);
    expect(compileTaskPrompt(value, 'writing', variables)).toEqual(first);
    expect(first.prompt).toContain('填充 {{不展开}}'); expect(first.prompt).toContain(variables.instruction);
    expect(JSON.stringify(first)).not.toMatch(/特图|呀~|dice_calculation|now_plot|setvar::|getvar::|LATEST_USER_INPUT|hybrid_image|Unicode 转码/);
    expect(first.textFilter).toBe('v08'); expect(first.writingOutputMode).toBe('tool');
    const dialogue = first.messages.filter(message => message.role !== 'system');
    expect(dialogue.every((message, i) => !i || message.role !== dialogue[i - 1].role)).toBe(true);
  });
  it.each<PromptTask>(['writing', 'extraction', 'compression'])('applies the general tool transport to %s and permits opting out', task => {
    const value = settings(); const compiled = compileTaskPrompt(value, task, variables);
    expect(compiled.writingOutputMode).toBe('tool');
    expect(compiled.system).toContain('emit_writing_response');
    value.general!.presets[1].toolTransport = false;
    expect(compileTaskPrompt(value, task, variables).writingOutputMode).not.toBe('tool');
    value.general!.presets[1].toolTransport = true; value.presets[task][0].useGeneral = false;
    expect(compileTaskPrompt(value, task, variables).writingOutputMode).not.toBe('tool');
    expect(compileTaskPrompt(value, task, variables).textFilter).toBeUndefined();
  });
  it('keeps explicit writing channels and task-specific general references authoritative', () => {
    const value = settings(); value.presets.writing[0].writingOutputMode = 'text';
    expect(compileTaskPrompt(value, 'writing', variables).writingOutputMode).toBe('text');
    delete value.presets.writing[0].writingOutputMode; value.presets.writing[0].generalPresetId = 'default-general';
    expect(compileTaskPrompt(value, 'writing', variables).writingOutputMode).toBe('text');
    value.general!.selected = 'default-general'; value.presets.writing[0].generalPresetId = V08_PRESET_ID;
    expect(compileTaskPrompt(value, 'writing', variables).writingOutputMode).toBe('tool');
  });
  it.each(['structured', 'tool'] as const)('does not double-wrap extraction %s submissions', extractionOutputMode => {
    const compiled = compileTaskPrompt(settings(), 'extraction', variables, { extractionOutputMode });
    expect(compiled.writingOutputMode).toBeUndefined();
    expect(compiled.structuredOutput?.mode).toBe(extractionOutputMode === 'structured' ? 'json_schema' : 'tool');
    expect(compiled.system).not.toContain('emit_writing_response');
  });
  it('skips optional draft starters under tool transport, without changing native thinking parameters', () => {
    const value = settings(); value.general!.presets[1].blocks.at(-1)!.enabled = true;
    expect(compileTaskPrompt(value, 'writing', variables).system).not.toContain('<draft>任务已就绪。</draft>');
    value.presets.writing[0].writingOutputMode = 'text';
    expect(compileTaskPrompt(value, 'writing', variables).system).toContain('<draft>任务已就绪。</draft>');
  });
  it('separates v0.8 draft at every stream split, retaining quoted evidence and the old filter behavior', () => {
    const raw = '<draft>任务已就绪。</draft><thinking>核对</thinking>正文。';
    for (let split = 0; split <= raw.length; split++) {
      let auxiliary = ''; const filter = createDramatronTextFilter({ onThinking: event => { if ('text' in event) auxiliary += event.text; } }, 'v08');
      expect(filter.feed(raw.slice(0, split)) + filter.feed(raw.slice(split)) + filter.finish()).toBe('正文。');
      expect(auxiliary).toBe('任务已就绪。核对');
    }
    const evidence = JSON.stringify({ text: '<draft>原文标签</draft><thinking>证据</thinking>' });
    expect(cleanDramatronText(evidence, 'v08')).toBe(evidence);
    expect(cleanDramatronText('<draft>不完整', 'v08')).toBe('');
    expect(cleanDramatronText('<draft>普通原文</draft>')).toBe('<draft>普通原文</draft>');
    expect(cleanDramatronText('<Interleaving>保留其他标签</Interleaving>', 'v08')).toBe('<Interleaving>保留其他标签</Interleaving>');
  });
});
