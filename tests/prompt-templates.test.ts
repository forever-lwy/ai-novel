import { describe, expect, it } from 'vitest';
import type { PromptBlock, PromptTask } from '../shared/types.js';
import { activePromptPreset, BASE_SYSTEM, COMPRESSION_SYSTEM, compilePrompt, compileTaskPrompt, defaultPromptTemplates, EXTRACT_SYSTEM, normalizePromptTemplates, PLAN_SYSTEM, WRITING_SYSTEM, promptPresetVariables, promptTasks, validatePromptTemplates } from '../shared/prompt-templates.js';
import { legacyPromptTemplates } from '../shared/legacy-prompt-templates.js';
import { STRUCTURED_OUTPUT_INSTRUCTION } from '../shared/prompt-runtime.js';

const variables = {
  context: '完整上下文', instruction: '继续灯塔剧情', mode: 'continuation', maxWords: 2000,
  chapterNumber: 3, endChapter: 6, writingTarget: '请写第 3 章。', chapterTitle: '灯塔', blockText: '[1] 林舟走进灯塔。', summaryText: '已发生的剧情摘要。',
};
const messageBlock = (id: string, role: PromptBlock['role'], content: string): PromptBlock => ({ id, name: id, role, content, enabled: true });

describe('editable task prompt templates', () => {
  it('provides independent Markdown defaults and alternates the conversation for every task and writing mode', () => {
    const first = normalizePromptTemplates(); const second = normalizePromptTemplates();
    first.presets.writing[0].blocks[0].content = 'changed';
    expect(second.presets.writing[0].blocks[0].content).toBe(BASE_SYSTEM);
    const requests = Object.fromEntries(promptTasks.map(task => [task, compilePrompt(undefined, task, variables)]));
    expect(requests.writing.system).toBe(`${BASE_SYSTEM}\n${WRITING_SYSTEM}`);
    expect(requests.writing.prompt).toContain('## 作者要求\n继续灯塔剧情');
    expect(requests.planning.system).toBe(PLAN_SYSTEM);
    expect(requests.planning.prompt).toContain('第 3 章至第 6 章');
    expect(requests.extraction.system).toBe(EXTRACT_SYSTEM);
    expect(requests.extraction.prompt).toContain('## 编号原文\n[1] 林舟走进灯塔。');
    expect(requests.compression).toMatchObject({ system: COMPRESSION_SYSTEM, prompt: expect.stringContaining(variables.summaryText) });
    for (const task of promptTasks) for (const mode of ['original', 'continuation', 'fanfiction', 'rewrite', 'rpg']) {
      const dialogue = compileTaskPrompt(undefined, task, { ...variables, mode }).messages.filter(message => message.role !== 'system');
      expect(dialogue.map(message => message.role)).toEqual(task === 'compression' ? ['user'] : ['user', 'assistant', 'user']);
      expect(dialogue[0].content).toMatch(/^# /);
    }
    expect(validatePromptTemplates(second)).toEqual(second);
  });

  it('upgrades only untouched legacy presets and leaves author changes and input data intact', () => {
    const legacy = structuredClone(legacyPromptTemplates);
    legacy.presets.writing[0].blocks[0].content += '\n保留我的文风';
    legacy.presets.planning.push({ ...structuredClone(legacy.presets.planning[0]), id: 'copy', name: '我的副本' });
    legacy.selected.planning = 'copy';
    const before = structuredClone(legacy);
    const upgraded = normalizePromptTemplates(legacy);
    expect(legacy).toEqual(before);
    expect(upgraded.presets.writing).toEqual(before.presets.writing);
    expect(upgraded.presets.planning[1]).toEqual(before.presets.planning[1]);
    expect(upgraded.selected.planning).toBe('copy');
    for (const task of ['extraction', 'compression', 'planning'] as const) expect(upgraded.presets[task][0]).toEqual(defaultPromptTemplates().presets[task][0]);
    expect(normalizePromptTemplates(upgraded)).toEqual(upgraded);
  });

  it('combines adjacent dialogue after mode filtering and includes conditional rules in the final assembly', () => {
    const settings = defaultPromptTemplates();
    settings.presets.writing[0].blocks = [messageBlock('a', 'user', '{{context}}'), { ...messageBlock('skip', 'assistant', '未启用'), enabled: false }, messageBlock('b', 'user', '{{instruction}}')];
    const request = compileTaskPrompt(settings, 'writing', { ...variables, mode: 'rpg' }, { rpg: { character: { kind: 'original', name: '林舟', description: '信使' }, entryInstruction: '来到码头' }, chapterAnswer: '选择登船', illustrations: { portrait: true, cg: false } });
    expect(request.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(request.messages.at(-1)?.content).toContain('选择登船');
    expect(request.system).toContain('必须调用 ask_user');
    expect(request.system).toContain('generate_character_portrait');
    expect(request.system).not.toContain('generate_scene_cg');
    expect(request.messages).not.toContainEqual(expect.objectContaining({ content: '未启用' }));
    expect(settings.presets.writing[0].blocks[0].content).toBe('{{context}}');
    const toolPlan = compileTaskPrompt(undefined, 'planning', variables, { planningMode: 'tool' });
    expect(toolPlan.system).toContain('最终文本或 JSON 都不能替代工具调用');
    expect(toolPlan.system).not.toContain(STRUCTURED_OUTPUT_INSTRUCTION);
    expect(compileTaskPrompt(undefined, 'extraction', variables).system).toContain(STRUCTURED_OUTPUT_INSTRUCTION);
  });

  it('uses the selected preset and retains order, message roles and enabled blocks without recursive substitution', () => {
    const settings = defaultPromptTemplates();
    settings.presets.writing.push({ id: 'custom', name: '自由编排', variables: { style: '简洁 {{instruction}}' }, blocks: [
      messageBlock('request', 'user', '{{ style }}：{{instruction}}'),
      messageBlock('example', 'assistant', '示例正文'),
      messageBlock('late-system', 'system', '后置系统约定'),
      { ...messageBlock('off', 'user', '禁用文本'), enabled: false },
      messageBlock('empty', 'assistant', '{{sourceText}}'),
      messageBlock('tail', 'user', '最后要求'),
    ] });
    settings.selected.writing = 'custom';
    const request = compilePrompt(settings, 'writing', { instruction: '原文中的 {{mode}}', mode: 'original', sourceText: '' });
    expect(request.messages).toEqual([
      { role: 'user', content: '简洁 {{instruction}}：原文中的 {{mode}}' },
      { role: 'assistant', content: '示例正文' },
      { role: 'system', content: '后置系统约定' },
      { role: 'user', content: '最后要求' },
    ]);
    expect(request.system).toBe('后置系统约定');
    expect(request.prompt).toBe('简洁 {{instruction}}：原文中的 {{mode}}\n最后要求');
    expect(activePromptPreset(settings, 'writing').id).toBe('custom');
    expect(promptPresetVariables('writing', settings.presets.writing[1])).toContainEqual({ key: 'style', label: '自定义变量 · style' });
    expect(normalizePromptTemplates(settings)).toEqual(settings);
  });

  it('filters writing mode conditions and requires user messages for every supported mode', () => {
    const settings = defaultPromptTemplates();
    settings.presets.writing[0].blocks = [
      { ...messageBlock('ordinary', 'user', '创作 {{mode}}'), modes: ['original', 'continuation', 'fanfiction'] },
      { ...messageBlock('rewrite', 'user', '改写 {{sourceText}}'), modes: ['rewrite'] },
    ];
    expect(compilePrompt(settings, 'writing', { mode: 'original' }).prompt).toBe('创作 original');
    expect(compilePrompt(settings, 'writing', { mode: 'rewrite', sourceText: '原文' }).prompt).toBe('改写 原文');
    settings.presets.writing[0].blocks[1].enabled = false;
    expect(() => validatePromptTemplates(settings)).toThrow('rewrite');
    settings.presets.writing[0].blocks[0].modes = [];
    expect(() => validatePromptTemplates(settings)).not.toThrow();
    settings.presets.planning[0].blocks[0].modes = ['original'];
    expect(() => validatePromptTemplates(settings)).toThrow('只适用于正文写作');
  });

  it('preserves older mode-limited presets for RPG and accepts explicit RPG blocks', () => {
    const settings = defaultPromptTemplates();
    const blocks = settings.presets.writing[0].blocks = [
      { ...messageBlock('old', 'user', '保留原要求，模式 {{mode}}'), modes: ['original', 'continuation', 'fanfiction', 'rewrite'] },
    ];
    const before = structuredClone(settings);
    expect(compilePrompt(settings, 'writing', { mode: 'rpg' }).prompt).toBe('保留原要求，模式 rpg');
    expect(settings).toEqual(before);
    blocks.push({ ...messageBlock('rpg', 'user', '角色体验 {{mode}}'), modes: ['rpg'] });
    expect(compilePrompt(settings, 'writing', { mode: 'rpg' }).prompt).toBe('角色体验 rpg');
    expect(compilePrompt(settings, 'writing', { mode: 'continuation' }).prompt).toBe('保留原要求，模式 continuation');
    blocks[1].enabled = false;
    expect(() => validatePromptTemplates(settings)).toThrow('rpg');
  });

  it.each<PromptTask>(['writing', 'planning', 'extraction', 'compression'])('rejects duplicate blocks, presets, missing selections and unavailable variables for %s', task => {
    const settings = defaultPromptTemplates();
    settings.presets[task][0].blocks.push({ ...settings.presets[task][0].blocks[0] });
    expect(() => validatePromptTemplates(settings)).toThrow('提示词块标识不能重复');
    settings.presets[task][0].blocks.pop();
    settings.presets[task].push(structuredClone(settings.presets[task][0]));
    expect(() => validatePromptTemplates(settings)).toThrow('预设标识不能重复');
    settings.presets[task].pop(); settings.selected[task] = 'missing';
    expect(() => validatePromptTemplates(settings)).toThrow('预设不存在');
    settings.selected[task] = settings.presets[task][0].id;
    settings.presets[task][0].blocks[0].content = '{{typo}}';
    expect(() => validatePromptTemplates(settings)).toThrow('{{typo}}');
  });

  it('rejects unrecognized structure and malformed custom variables without overwriting a saved preset', () => {
    const settings = defaultPromptTemplates(); const saved = structuredClone(settings);
    expect(() => validatePromptTemplates({ ...settings, unknown: 'value' })).toThrow();
    settings.presets.writing[0].variables = { instruction: 'hidden override' };
    expect(() => validatePromptTemplates(settings)).toThrow('不能覆盖内置变量');
    settings.presets.writing[0].variables = { 'bad-name': 'text' };
    expect(() => validatePromptTemplates(settings)).toThrow('变量名');
    settings.presets.writing[0].variables = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`v${index}`, 'value']));
    expect(() => validatePromptTemplates(settings)).toThrow('100 个');
    expect(normalizePromptTemplates(saved)).toEqual(saved);
    const empty = defaultPromptTemplates(); empty.presets.compression[0].blocks = [messageBlock('empty', 'user', '{{summaryText}}')];
    expect(() => compilePrompt(empty, 'compression', { summaryText: '   ' })).toThrow('展开后没有非空 user');
  });

  it('keeps an invalid editing draft accessible while compile and save still reject it', () => {
    const settings = defaultPromptTemplates();
    settings.presets.writing[0].blocks[0].content = '{{unfinished_variable}}';
    expect(activePromptPreset(settings, 'writing').blocks[0].content).toBe('{{unfinished_variable}}');
    expect(() => compilePrompt(settings, 'writing', variables)).toThrow('unfinished_variable');
    expect(() => normalizePromptTemplates(settings)).toThrow('unfinished_variable');
  });

  it('formats validation issues around task, preset and block names and limits displayed errors', () => {
    const settings = defaultPromptTemplates();
    settings.presets.writing[0].blocks[0].content = '{{missing1}} {{missing2}} {{missing3}} {{missing4}}';
    expect(() => validatePromptTemplates(settings)).toThrow('正文写作 · 默认正文写作 · 基本创作约定');
    expect(() => validatePromptTemplates(settings)).toThrow('另有 1 处需要修改');
    expect(() => validatePromptTemplates({ ...defaultPromptTemplates(), unexpected: true })).toThrow('包含不支持的字段：unexpected');
  });

  it('bounds individual blocks, presets, block counts and the UTF-8 text total', () => {
    const settings = defaultPromptTemplates();
    settings.presets.compression[0].blocks[1].content = 'x'.repeat(100001);
    expect(() => validatePromptTemplates(settings)).toThrow('100000');
    settings.presets.compression[0].blocks[1].content = '摘要';
    settings.presets.compression = Array.from({ length: 21 }, (_, index) => ({ id: `p${index}`, name: '预设', blocks: [messageBlock('user', 'user', 'input')] }));
    expect(() => validatePromptTemplates(settings)).toThrow('20 个');
    settings.presets.compression = [{ id: 'default-compression', name: '预设', blocks: Array.from({ length: 81 }, (_, index) => messageBlock(`b${index}`, 'user', 'input')) }];
    expect(() => validatePromptTemplates(settings)).toThrow('80 个');
    settings.presets.compression[0].blocks = Array.from({ length: 3 }, (_, index) => messageBlock(`b${index}`, 'user', '中'.repeat(90000)));
    expect(() => validatePromptTemplates(settings)).toThrow('700000 字节');
  });
});
