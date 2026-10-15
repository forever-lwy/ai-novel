import { describe, expect, it } from 'vitest';
import { compilePrompt, compileTaskPrompt, defaultPromptTemplates, normalizePromptTemplates, promptTasks, validatePromptTemplates } from '../shared/prompt-templates.js';
import { rebornGeneralPreset, REBORN_PRESET_ID } from '../shared/reborn-prompts.js';
import { TASK_V2_PRESET_IDS } from '../shared/task-prompts-v2.js';
import { cleanDramatronText, createDramatronTextFilter } from '../shared/dramatron-output.js';
import type { PromptTask } from '../shared/types.js';

const variables = { mode: 'continuation', instruction: '继续调查 {{原样素材}}', context: '名称索引', storyMaterials: '本线设定和摘要', recentChapters: '最近全文', continuationAnchor: '门正缓缓打开。', maxWords: 1000, writingTarget: '续写', chapterTitle: '旧门', blockText: '[1] 林舟推开旧门。', summaryText: '林舟到达桥边，然后推开旧门。' };
function settings() {
  const value = defaultPromptTemplates(); value.general!.selected = REBORN_PRESET_ID;
  for (const task of promptTasks) value.selected[task] = TASK_V2_PRESET_IDS[task];
  return value;
}
function oldSettings() {
  const value = defaultPromptTemplates(); value.general!.presets = value.general!.presets.filter(preset => preset.id !== REBORN_PRESET_ID); value.general!.catalogVersion = 1;
  delete value.taskCatalogVersions;
  for (const task of promptTasks) value.presets[task] = value.presets[task].filter(preset => preset.id !== TASK_V2_PRESET_IDS[task]);
  return value;
}

describe('Reborn framework and cooperative task editions', () => {
  it('adds all editions without changing choices, references, original presets or input objects', () => {
    const old = oldSettings(); old.presets.writing[0].blocks[0].content += '\n作者规则'; old.presets.writing[0].generalPresetId = old.general!.selected;
    const before = structuredClone(old); const upgraded = normalizePromptTemplates(old);
    expect(old).toEqual(before); expect(upgraded.selected).toEqual(old.selected); expect(upgraded.general!.selected).toBe(old.general!.selected);
    for (const task of promptTasks) { expect(upgraded.presets[task][0]).toEqual(old.presets[task][0]); expect(upgraded.presets[task].at(-1)?.id).toBe(TASK_V2_PRESET_IDS[task]); }
    expect(upgraded.general!.presets.slice(0, 2)).toEqual(old.general!.presets); expect(upgraded.general!.presets.at(-1)).toEqual(rebornGeneralPreset());
    expect(normalizePromptTemplates(upgraded)).toEqual(upgraded);
    upgraded.general!.presets.pop(); upgraded.presets.writing.pop();
    expect(normalizePromptTemplates(upgraded)).toEqual(upgraded);
  });
  it('keeps colliding author editions intact and tracks task capacity independently', () => {
    const old = oldSettings();
    const edited = settings().presets.extraction[1]; edited.name = '作者自己的 v2'; edited.blocks[0].content = '作者证据规则'; old.presets.extraction.push(edited);
    old.presets.writing = Array.from({ length: 20 }, (_, index) => ({ ...old.presets.writing[0], id: index ? `author-${index}` : 'default-writing' }));
    const upgraded = normalizePromptTemplates(old);
    expect(upgraded.presets.extraction[1]).toEqual(edited); expect(upgraded.presets.writing).toEqual(old.presets.writing);
    expect(upgraded.taskCatalogVersions).toEqual({ extraction: 1, compression: 1 });
    upgraded.presets.extraction.pop(); upgraded.presets.writing.pop();
    const retry = normalizePromptTemplates(upgraded);
    expect(retry.presets.extraction).toEqual(upgraded.presets.extraction);
    expect(retry.presets.writing.at(-1)?.id).toBe(TASK_V2_PRESET_IDS.writing);
  });
  it('defers a full general catalog without evicting existing entries', () => {
    const old = oldSettings(); const original = old.general!.presets[0];
    old.general!.presets.push(...Array.from({ length: 18 }, (_, i) => ({ ...original, id: `author-general-${i}`, blocks: [{ id: 'slot', name: '插槽', role: 'system' as const, enabled: true, content: '', slot: 'task' as const }] })));
    expect(normalizePromptTemplates(old).general).toEqual(old.general);
    old.general!.presets.pop();
    expect(normalizePromptTemplates(old).general!.presets.at(-1)?.id).toBe(REBORN_PRESET_ID);
  });
  it('does not replace an author framework with the built-in ID', () => {
    const old = oldSettings(); const author = rebornGeneralPreset(); author.name = '作者框架'; author.blocks[0].content = '作者自己的保护规则';
    old.general!.presets.push(author);
    expect(normalizePromptTemplates(old).general!.presets.at(-1)).toEqual(author);
  });
  it('defers editions at the UTF-8 capacity limit and retries after space is freed', () => {
    const old = oldSettings(); old.general!.presets = [{ id: 'author-general', name: '作者框架', blocks: [{ id: 'slot', name: '插槽', role: 'system', enabled: true, slot: 'task', content: '' }] }]; old.general!.selected = 'author-general';
    for (const task of promptTasks) old.presets[task] = [{ id: `default-${task}`, name: '作者任务', blocks: [{ id: 'input', name: '输入', role: 'user', enabled: true, content: '材料' }] }];
    old.presets.writing[0].blocks.push(...Array.from({ length: 7 }, (_, i) => ({ id: `filler-${i}`, name: '已有文本', role: 'system' as const, enabled: true, content: 'x'.repeat(i === 6 ? 99000 : 100000) })));
    expect(() => validatePromptTemplates(old)).not.toThrow(); expect(normalizePromptTemplates(old)).toEqual(old);
    old.presets.writing[0].blocks.pop(); const upgraded = normalizePromptTemplates(old);
    expect(upgraded.general!.presets.at(-1)?.id).toBe(REBORN_PRESET_ID);
    for (const task of promptTasks) expect(upgraded.presets[task].at(-1)?.id).toBe(TASK_V2_PRESET_IDS[task]);
    expect(() => validatePromptTemplates(upgraded)).not.toThrow();
  });
  it.each<PromptTask>(['writing', 'extraction', 'compression'])('preserves native roles and avoids conflicting delivery instructions for %s', task => {
    const value = settings(); const slot = value.general!.presets.at(-1)!.blocks.find(block => block.slot)!;
    slot.role = 'assistant'; // Slot metadata must never relabel its task messages.
    const compiled = compilePrompt(value, task, variables);
    expect(compiled.messages.map(message => message.role)).toEqual(['system', 'system', 'user', 'system']);
    const final = compileTaskPrompt(value, task, variables);
    expect(final.writingOutputMode).toBe('tool'); expect(final.textFilter).toBe('reborn');
    expect(final.messages.filter(message => message.role !== 'system').map(message => message.role)).toEqual(['user']);
    expect(final.runtimeBlocks.some(block => block.name === 'JSON 输出要求')).toBe(false);
    expect(final.system).toContain('实际提交方式遵循'); expect(final.system).toContain('emit_writing_response');
    expect(final.system).not.toMatch(/只输出一个 JSON 对象|仅输出合法 JSON|SoliUmbra|"role":"soliumbra"|<prefill_thinking|<Interleaving>/);
    if (task === 'writing') for (const text of [variables.instruction, variables.storyMaterials, variables.recentChapters, variables.continuationAnchor]) expect(final.prompt).toContain(text);
    if (task === 'extraction') for (const text of [variables.context, variables.blockText]) expect(final.prompt).toContain(text);
    if (task === 'compression') expect(final.prompt).toContain(variables.summaryText);
    value.presets[task][1].useGeneral = false;
    const standalone = compileTaskPrompt(value, task, variables);
    expect(standalone.writingOutputMode).not.toBe('tool'); expect(standalone.textFilter).toBeUndefined();
    expect(standalone.system).not.toContain('通用文本任务框架');
    if (task !== 'writing') expect(standalone.runtimeBlocks.some(block => block.name === 'JSON 输出要求')).toBe(true);
  });
  it.each(['structured', 'tool'] as const)('keeps native extraction %s authoritative', extractionOutputMode => {
    const compiled = compileTaskPrompt(settings(), 'extraction', variables, { extractionOutputMode });
    expect(compiled.writingOutputMode).toBeUndefined(); expect(compiled.structuredOutput?.name).toBe('submit_extraction');
    expect(compiled.system).not.toContain('emit_writing_response');
  });
  it.each(['original', 'continuation', 'fanfiction', 'rewrite', 'rpg'])('keeps writing boundaries under %s and supports explicit text output', mode => {
    const value = settings(); value.presets.writing[1].writingOutputMode = 'text';
    const compiled = compileTaskPrompt(value, 'writing', { ...variables, mode }, { rpg: { character: { kind: 'existing', name: '林舟', description: '信使' }, entryInstruction: '旧门前' } });
    expect(compiled.writingOutputMode).toBe('text'); expect(compiled.system).not.toContain('emit_writing_response');
    expect(compiled.system).toContain('用户角色的自主行动、台词和决定留给用户');
    expect(compiled.system).toContain('不复述上一章或按章节编号猜进度');
    if (mode === 'rpg') expect(compiled.system).toContain('必须调用 ask_user');
  });
  it('returns independent, schema-valid framework and task objects without importing helper code', () => {
    const value = settings(); expect(validatePromptTemplates(value)).toEqual(value);
    value.presets.writing[1].blocks[0].content = '作者内容';
    expect(settings().presets.writing[1].blocks[0].content).not.toBe('作者内容');
    const framework = JSON.stringify(rebornGeneralPreset());
    expect(framework).not.toMatch(/eval\(|fetch\(|window\.|setvar::|getvar::|script.src|\\\\u[0-9a-f]{4}/);
  });
  it('cleans streamed helper status lines and old wrappers at every split while preserving evidence', () => {
    const raw = 'finishReason: STOP\r\nfinishMessage: complete\n<think_nya~>辅助说明</think_nya~><game>正文。</game>';
    for (let split = 0; split <= raw.length; split++) {
      let auxiliary = ''; const filter = createDramatronTextFilter({ onThinking: event => { if ('text' in event) auxiliary += event.text; } }, 'reborn');
      expect(filter.feed(raw.slice(0, split)) + filter.feed(raw.slice(split)) + filter.finish()).toBe('正文。'); expect(auxiliary).toBe('辅助说明');
    }
    const json = JSON.stringify({ text: '<think_nya~>原文</think_nya~><game>证据</game>\nfinishReason: 原话' });
    expect(cleanDramatronText(json, 'reborn')).toBe(json);
    expect(cleanDramatronText('正文。\nfinishReason: 原话', 'reborn')).toBe('正文。\nfinishReason: 原话');
    expect(cleanDramatronText('<think_nya~>未结束', 'reborn')).toBe('');
    expect(cleanDramatronText('finishMessage: complete', 'reborn')).toBe('');
    expect(cleanDramatronText('finishReason: STOP\n正文。')).toBe('finishReason: STOP\n正文。');
  });
});
