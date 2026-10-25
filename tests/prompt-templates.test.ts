import { describe, expect, it } from 'vitest';
import { withDramatronPresets, withPriorDefaultSelections } from './fixtures/prompt-presets.js';
import type { PromptBlock, PromptTask } from '../shared/types.js';
import { activePromptPreset, BASE_SYSTEM, COMPRESSION_SYSTEM, compilePrompt, compileTaskPrompt, defaultPromptTemplates, EXTRACT_SYSTEM, normalizePromptTemplates, WRITING_SYSTEM, promptPresetVariables, promptTasks, validatePromptTemplates } from '../shared/prompt-templates.js';
import { legacyPromptTemplates } from '../shared/legacy-prompt-templates.js';
import { previousPromptTemplates } from '../shared/previous-prompt-templates.js';

const variables = {
  context: '完整上下文', instruction: '继续灯塔剧情', mode: 'continuation', maxWords: 2000,
  chapterNumber: 3, endChapter: 6, writingTarget: '请写第 3 章。', chapterTitle: '灯塔', blockText: '[1] 林舟走进灯塔。', imageInput: '{}', imageSystemPrompt: '', maxCharacterReferences: 0, summaryText: '已发生的剧情摘要。',
};
const messageBlock = (id: string, role: PromptBlock['role'], content: string): PromptBlock => ({ id, name: id, role, content, enabled: true });

describe('editable task prompt templates', () => {
  it('renders untouched neutral delivery for the actual interface without rewriting author presets', () => {
    const settings = withPriorDefaultSelections();
    settings.general!.presets[0].toolTransport = false;
    const before = structuredClone(settings);
    const request = compileTaskPrompt(settings, 'writing', variables);
    expect(request.system).not.toContain('以本次定义的结果工具交付完整内容');
    expect(request.system).toContain('按本次实际交付接口交付完整内容');
    expect(settings).toEqual(before);
    const delivery = settings.general!.presets[0].blocks.find(block => block.id === 'neutral-delivery')!;
    delivery.content += '\n作者保留的说明';
    expect(compileTaskPrompt(settings, 'writing', variables).system).toContain(delivery.content);
    delivery.content = before.general!.presets[0].blocks.find(block => block.id === 'neutral-delivery')!.content;
    const copy = { ...structuredClone(settings.general!.presets[0]), id: 'author-neutral-copy' };
    settings.general!.presets.push(copy); settings.general!.selected = copy.id;
    expect(compileTaskPrompt(settings, 'writing', variables).system).toContain(delivery.content);
  });

  it('states the actual text delivery contract when writing overrides the general result tool', () => {
    const settings = defaultPromptTemplates();
    settings.presets.writing[0].writingOutputMode = 'text';
    const request = compileTaskPrompt(settings, 'writing', variables);
    expect(request).toMatchObject({ writingOutputMode: 'text' });
    expect(request.responseCarrier).toBeUndefined();
    expect(request.runtimeBlocks).toContainEqual(expect.objectContaining({ name: '正文普通文本通道规则', content: expect.stringContaining('本次使用普通文本交付') }));
    expect(request.system).toContain('以这里的实际通道为准');
    expect(request.system).toContain('正文只写故事，工具参数和结果不写入正文');
    const inherited = compileTaskPrompt(defaultPromptTemplates(), 'writing', variables);
    expect(inherited.responseCarrier).toBeDefined();
    expect(inherited.runtimeBlocks.some(block => block.name === '正文普通文本通道规则')).toBe(false);
  });

  it('inserts task messages at the general slot with separate variable scopes, and supports opting out', () => {
    const settings = defaultPromptTemplates();
    settings.general!.presets[0].variables = { style: '通用 {{instruction}}' };
    settings.general!.presets[0].blocks = [messageBlock('prefix', 'system', '前置 {{style}}'), { ...messageBlock('slot', 'system', ''), slot: 'task' }, messageBlock('suffix', 'system', '后置约束')];
    settings.presets.writing[0].variables = { style: '本任务风格' };
    settings.presets.writing[0].blocks = [messageBlock('input', 'user', '{{style}} {{context}}')];
    expect(compilePrompt(settings, 'writing', { context: '原文 {{style}}' }).messages).toEqual([
      { role: 'system', content: '前置 通用 {{instruction}}' }, { role: 'user', content: '本任务风格 原文 {{style}}' }, { role: 'system', content: '后置约束' },
    ]);
    settings.presets.writing[0].useGeneral = false;
    expect(compilePrompt(settings, 'writing', { context: '上下文' }).messages).toEqual([{ role: 'user', content: '本任务风格 上下文' }]);
  });

  it('preserves edited old compiled prompts and upgrades only untouched prior defaults', () => {
    const old = structuredClone(previousPromptTemplates);
    old.presets.writing[0].blocks[0].content += '\n作者自己的规则';
    const expected = old.presets.writing[0].blocks.map(block => ({ role: block.role, content: block.content.replace(/\{\{([^{}]*)\}\}/g, (_match, key: string) => String(variables[key as keyof typeof variables] ?? '')) })).filter(message => message.content.trim());
    expect(compilePrompt(old, 'writing', variables).messages).toEqual(expected);
    const normalized = normalizePromptTemplates(old);
    expect(normalized.presets.writing[0].useGeneral).toBe(false);
    expect(normalized.presets.compression[0]).toEqual(withPriorDefaultSelections().presets.compression[0]);
    expect(normalizePromptTemplates(normalized)).toEqual(normalized);
  });

  it('requires exactly one general slot, checks references and confines transport to writing', () => {
    const settings = withDramatronPresets();
    settings.general!.presets[0].blocks.push({ ...messageBlock('extra-slot', 'system', ''), slot: 'task' });
    expect(() => validatePromptTemplates(settings)).toThrow('任务插槽'); settings.general!.presets[0].blocks.pop();
    settings.presets.writing[0].generalPresetId = 'missing'; expect(() => validatePromptTemplates(settings)).toThrow('通用预设不存在'); delete settings.presets.writing[0].generalPresetId;
    settings.presets.extraction[0].writingOutputMode = 'tool'; expect(() => validatePromptTemplates(settings)).toThrow('正文输出通道'); delete settings.presets.extraction[0].writingOutputMode;
    settings.presets.writing[0].writingOutputMode = 'tool';
    const request = compileTaskPrompt(settings, 'writing', variables);
    expect(request.writingOutputMode).toBe('tool'); expect(request.runtimeBlocks).toContainEqual(expect.objectContaining({ name: '正文工具通道规则' }));
    const withAction = compileTaskPrompt(settings, 'writing', { ...variables, mode: 'rpg' }, { chapterAnswer: '前往码头' });
    expect(withAction.messages.filter(message => message.role !== 'system').map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect([...withAction.messages].reverse().find(message => message.role === 'user')?.content).toContain('前往码头');
    expect(compileTaskPrompt(settings, 'extraction', variables).system).not.toContain('正文工具通道');
  });
  it('provides independent Markdown defaults and keeps each extraction/compression input together', () => {
    const first = normalizePromptTemplates(); const second = normalizePromptTemplates();
    first.presets.writing[0].blocks[0].content = 'changed';
    expect(second.presets.writing[0].blocks[0].content).toContain('# 当前任务：故事正文');
    const requests = Object.fromEntries(promptTasks.map(task => [task, compilePrompt(undefined, task, variables)]));
    expect(requests.writing.system).toContain('# 作者工作区');
    expect(requests.writing.system).toContain('# 当前任务：故事正文');
    expect(requests.writing.prompt).toContain('## 作者要求\n继续灯塔剧情');
    expect(requests.extraction.system).toContain(EXTRACT_SYSTEM.replace(`${BASE_SYSTEM}\n\n`, ''));
    expect(requests.extraction.prompt).toContain('## 编号原文');
    expect(requests.extraction.prompt).toContain(variables.blockText);
    expect(requests.compression).toMatchObject({ system: expect.stringContaining(COMPRESSION_SYSTEM.replace(`${BASE_SYSTEM}\n\n`, '')), prompt: expect.stringContaining(variables.summaryText) });
    for (const task of promptTasks) for (const mode of ['original', 'continuation', 'fanfiction', 'rewrite', 'rpg']) {
      const dialogue = compileTaskPrompt(undefined, task, { ...variables, mode }).messages.filter(message => message.role !== 'system');
      expect(dialogue.map(message => message.role)).toEqual(task === 'writing' ? ['user', 'user'] : ['user']);
      expect(dialogue.some(message => message.content.includes('冬马和纱'))).toBe(false);
      if (task === 'extraction') {
        expect(dialogue[0].content).toContain(variables.context);
        expect(dialogue[0].content).toContain(variables.blockText);
        expect(dialogue[0].content).not.toContain('已收到索引');
      }
    }
    expect(validatePromptTemplates(second)).toEqual(second);
  });

  it.each([false, true])('upgrades untouched acknowledged extraction with editor IDs=%s while preserving edits and copies', editorIds => {
    const settings = structuredClone(previousPromptTemplates);
    const old = structuredClone(settings.presets.extraction[0]);
    old.blocks.splice(2, 0, { id: 'context-ack', name: '证据边界确认', role: 'assistant', enabled: true, content: '已收到索引。新资料只依据接下来提供的编号片段；无法确认的身份、属性和关系不补造，每条事实与关系都核对本片段证据。' });
    if (editorIds) old.blocks.forEach((value, index) => { value.id = `editor-${index}`; });
    const edited = structuredClone(old); edited.id = 'edited'; edited.blocks[0].content += '\n作者的提取要求';
    const copy = structuredClone(old); copy.id = 'copy'; copy.name = '我的提取预设';
    settings.presets.extraction = [old, edited, copy]; settings.selected.extraction = 'copy';
    const before = structuredClone(settings);
    const normalized = normalizePromptTemplates(settings);
    expect(settings).toEqual(before);
    expect(normalized.presets.extraction[0]).toEqual(withPriorDefaultSelections().presets.extraction[0]);
    expect(normalized.presets.extraction.slice(1, 3)).toEqual([edited, copy].map(value => ({ ...value, useGeneral: false })));
    expect(normalized.selected.extraction).toBe('copy');
    expect(normalizePromptTemplates(normalized)).toEqual(normalized);
    const customizedDefault = structuredClone(before);
    customizedDefault.presets.extraction[0].blocks[0].content += '\n作者的证据要求';
    expect(normalizePromptTemplates(customizedDefault).presets.extraction[0]).toEqual({ ...customizedDefault.presets.extraction[0], useGeneral: false });
  });

  it('upgrades only untouched legacy presets and leaves author changes and input data intact', () => {
    const legacy = structuredClone(legacyPromptTemplates);
    legacy.presets.writing[0].blocks[0].content += '\n保留我的文风';
    legacy.presets.compression.push({ ...structuredClone(legacy.presets.compression[0]), id: 'copy', name: '我的副本' });
    legacy.selected.compression = 'copy';
    const before = structuredClone(legacy);
    const upgraded = normalizePromptTemplates(legacy);
    expect(legacy).toEqual(before);
    expect(upgraded.presets.writing.slice(0, before.presets.writing.length)).toEqual(before.presets.writing.map(value => ({ ...value, useGeneral: false })));
    expect(upgraded.presets.compression[1]).toEqual({ ...before.presets.compression[1], useGeneral: false });
    expect(upgraded.selected.compression).toBe('copy');
    for (const task of ['extraction', 'compression'] as const) expect(upgraded.presets[task][0]).toEqual(withPriorDefaultSelections().presets[task][0]);
    expect(normalizePromptTemplates(upgraded)).toEqual(upgraded);
  });

  it('combines adjacent dialogue after mode filtering and includes conditional rules in the final assembly', () => {
    const settings = defaultPromptTemplates(); settings.presets.writing[0].useGeneral = false;
    settings.presets.writing[0].blocks = [messageBlock('a', 'user', '{{context}}'), { ...messageBlock('skip', 'assistant', '未启用'), enabled: false }, messageBlock('b', 'user', '{{instruction}}')];
    const request = compileTaskPrompt(settings, 'writing', { ...variables, mode: 'rpg' }, { rpg: { character: { kind: 'original', name: '林舟', description: '信使' }, entryInstruction: '来到码头' }, chapterAnswer: '选择登船', illustrations: { portrait: true, cg: false } });
    expect(request.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect([...request.messages].reverse().find(message => message.role === 'user')?.content).toContain('选择登船');
    expect(request.system).toContain('必须调用 ask_user');
    expect(request.system).toContain('请求人物立绘');
    expect(request.system).not.toContain('请求一次场景 CG');
    expect(request.messages).not.toContainEqual(expect.objectContaining({ content: '未启用' }));
    expect(settings.presets.writing[0].blocks[0].content).toBe('{{context}}');
    expect(compileTaskPrompt(undefined, 'extraction', variables).system).toContain('完整 JSON 结果对象');
  });

  it('uses the selected preset and retains order, message roles and enabled blocks without recursive substitution', () => {
    const settings = defaultPromptTemplates();
    settings.presets.writing.push({ id: 'custom', name: '自由编排', useGeneral: false, variables: { style: '简洁 {{instruction}}' }, blocks: [
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
    expect(promptPresetVariables('writing', activePromptPreset(settings, 'writing'))).toContainEqual({ key: 'style', label: '自定义变量 · style' });
    expect(normalizePromptTemplates(settings)).toEqual(settings);
  });

  it('filters writing mode conditions and requires user messages for every supported mode', () => {
    const settings = defaultPromptTemplates(); settings.presets.writing[0].useGeneral = false;
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
    settings.presets.extraction[0].blocks[0].modes = ['original'];
    expect(() => validatePromptTemplates(settings)).toThrow('只适用于正文写作');
  });

  it('preserves older mode-limited presets for RPG and accepts explicit RPG blocks', () => {
    const settings = defaultPromptTemplates(); settings.presets.writing[0].useGeneral = false;
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

  it.each<PromptTask>(['writing', 'extraction', 'compression'])('rejects duplicate blocks, presets, missing selections and unavailable variables for %s', task => {
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
    expect(() => validatePromptTemplates(settings)).toThrow('正文写作 · 正文写作 v5 · 清晰分区 · 写作职责');
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
    settings.presets.compression[0].blocks = Array.from({ length: 4 }, (_, index) => messageBlock(`b${index}`, 'user', '中'.repeat(90000)));
    expect(() => validatePromptTemplates(settings)).toThrow('1000000 字节');
  });
});
