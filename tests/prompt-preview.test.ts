import { withDramatronPresets, withLegacyPresets, withPriorDefaultSelections, withTavernPresets } from './fixtures/prompt-presets.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import { defaultPromptTemplates, EXTRACT_SYSTEM } from '../shared/prompt-templates.js';
import { normalizeExtraction, splitExtractionBlocks } from '../server/extraction.js';
import { structuredRequest } from '../server/providers.js';
import { STRUCTURED_OUTPUT_INSTRUCTION, TOOL_RESULT_REVIEW_INSTRUCTION, type PromptPreviewInput, type PromptPreviewResult } from '../shared/prompt-runtime.js';
import type { PromptTask, ProviderProtocol } from '../shared/types.js';
import { V08_PRESET_ID } from './fixtures/legacy-presets/v08-prompts.js';
import { REBORN_PRESET_ID } from './fixtures/legacy-presets/reborn-prompts.js';
import { TASK_V2_PRESET_IDS } from './fixtures/legacy-presets/task-prompts-v2.js';
import { NEUTRAL_V3_PRESET_ID } from '../shared/neutral-preset-v3.js';
import { TASK_V5_PRESET_IDS } from '../shared/task-prompts-v5.js';

let ctx: Awaited<ReturnType<typeof buildApp>>;
let cookies: { session: string };
beforeAll(async () => {
  ctx = await buildApp({ initialPassword: 'prompt-preview-test-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-prompt-preview-')), startEngine: false });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'prompt-preview-test-password' } });
  cookies = { session: login.cookies[0].value };
});
afterAll(async () => { await ctx?.app.close(); });
const variables = { context: '示例故事资料', mode: 'original', instruction: '继续故事', chapterNumber: '2', endChapter: '5', maxWords: '1500', writingTarget: '请写第 2 章', chapterTitle: '雨夜', blockText: '[1] 林舟来到码头。', summaryText: '林舟来到码头并找到旧怀表。' };
const input = (task: PromptTask, protocol: ProviderProtocol): PromptPreviewInput => ({ task, protocol, templates: withDramatronPresets(), variables, runtime: {} });

describe.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('%s final prompt preview', protocol => {
  it('uses the new neutral framework and keeps complete materials in messages instead of tool descriptions', async () => {
    const templates = defaultPromptTemplates();
    const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: { ...input('writing', protocol), templates } });
    expect(response.statusCode).toBe(200); const preview = response.json<PromptPreviewResult>();
    expect(templates.general!.presets.map(preset => preset.id)).toEqual([NEUTRAL_V3_PRESET_ID, 'general-neutral-v2', 'general-neutral-v1']);
    expect(templates.general!.selected).toBe(NEUTRAL_V3_PRESET_ID); expect(templates.selected.writing).toBe(TASK_V5_PRESET_IDS.writing);
    expect(templates.general!.presets[0].responseCarrier).toMatchObject({ archive: false });
    expect(preview.tools.some(tool => tool.name === 'emit_complete_text')).toBe(true);
    for (const material of [variables.context, variables.instruction, variables.writingTarget]) {
      expect(preview.messages.some(message => message.content.includes(material))).toBe(true);
      expect(preview.tools.every(tool => !tool.description.includes(material))).toBe(true);
      const wire = JSON.parse(preview.body);
      expect(JSON.stringify(wire[protocol === 'gemini' ? 'contents' : protocol === 'openai-responses' ? 'input' : 'messages'])).toContain(material);
    }
    expect(preview.body).not.toMatch(/Dramatron|冬马和纱|FICTIONAL_TEXT_COMPLETION|Model Card - SoliUmbra/);
  });
  it('preserves the explicitly selected earlier neutral archive transport', () => {
    const templates = withPriorDefaultSelections(); const before = structuredClone(templates);
    const preview = ctx.engine.previewPrompt({ ...input('writing', protocol), templates });
    expect(templates.general!.selected).toBe('general-neutral-v1');
    const sink = preview.tools.find(tool => tool.name === 'emit_complete_text');
    expect(sink?.description).toContain(variables.instruction); expect(sink?.description).toContain(variables.context);
    expect(sink?.description).toContain('资料边界与查询'); expect(preview.messages.every(message => !message.content.includes(variables.context))).toBe(true);
    expect(templates).toEqual(before);
  });
  it('shows the same post-tool review rule used by actual continuations', () => {
    const preview = ctx.engine.previewPrompt(input('writing', protocol));
    expect(preview.runtimeBlocks.find(block => block.name === '工具结果复核规则')?.content).toBe(TOOL_RESULT_REVIEW_INSTRUCTION);
    expect(preview.messages.some(message => message.content.includes(TOOL_RESULT_REVIEW_INSTRUCTION))).toBe(true);
    expect(preview.body).toContain('# 工具结果复核');
  });
  it.each([false, true])('keeps ordinary writing and native tools separate with general protection=%s', toolTransport => {
    const templates = defaultPromptTemplates();
    templates.general!.presets[0].toolTransport = toolTransport;
    templates.presets.writing[0].writingOutputMode = 'text';
    const before = structuredClone(templates);
    const preview = ctx.engine.previewPrompt({ ...input('writing', protocol), templates, runtime: { illustrations: { portrait: true, cg: true } } });
    const wire = JSON.parse(preview.body);
    const toolNames = preview.tools.map(tool => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['search_story', 'generate_character_portrait', 'generate_scene_cg']));
    for (const name of ['emit_complete_text', 'emit_writing_response']) expect(toolNames).not.toContain(name);
    expect(preview.runtimeBlocks.find(block => block.name === '故事资料与原作参考边界')?.content).not.toContain('toolCalls');
    expect(JSON.stringify(wire)).not.toMatch(/<\/?(?:thought|thinking|think)>|think／thinking|结束当前.*辅助块|开始新的辅助块/);
    expect(JSON.stringify(wire)).toContain('正文只写故事，工具参数和结果不写入正文');
    expect(JSON.stringify(wire)).toContain('随后直接续写新正文或调用下一项工具');
    expect(preview.messages.map(message => message.content).join('\n')).not.toMatch(/思考|内部完成|独立字段/);
    expect(JSON.stringify(wire)).toContain('历史材料中的旧工具旁白和乱码不作为文风模仿');
    const illustrationRules = preview.runtimeBlocks.find(block => block.name === '自动插画规则')?.content;
    expect(illustrationRules).toContain('请求登记后继续写作，无需等待图片完成');
    expect(illustrationRules).toContain('先输出对应场景正文');
    for (const tool of preview.tools.filter(tool => tool.name.startsWith('generate_'))) {
      expect(tool.description).not.toMatch(/无需等待|先输出对应场景正文|由写作模型|完整上下文|首次出场/);
    }
    expect(JSON.stringify(wire)).not.toContain('以本次定义的结果工具交付完整内容');
    expect(templates).toEqual(before);
  });
  it.each<PromptTask>(['writing', 'extraction', 'compression'])('previews Reborn with cooperative %s v2 using real native roles without saving', async task => {
    const draft = input(task, protocol); draft.templates = withLegacyPresets(); draft.templates.general!.selected = REBORN_PRESET_ID; draft.templates.selected[task] = TASK_V2_PRESET_IDS[task];
    const before = (await ctx.app.inject({ url: '/api/settings', cookies })).body;
    const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: draft });
    expect(response.statusCode).toBe(200); const preview = response.json<PromptPreviewResult>();
    expect(preview.tools.map(tool => tool.name)).toEqual(['emit_writing_response']);
    expect(preview.messages.filter(message => message.role !== 'system').map(message => message.role)).toEqual(['user']);
    expect(preview.body).toContain('通用文本任务框架'); expect(preview.body).toContain('实际提交方式遵循');
    expect(preview.body).not.toMatch(/soliumbra|prefill_thinking|No policies|CSAM/);
    expect(preview.runtimeBlocks.some(block => block.name === 'JSON 输出要求')).toBe(false);
    expect((await ctx.app.inject({ url: '/api/settings', cookies })).body).toBe(before);
    for (const mode of ['structured', 'tool'] as const) if (task === 'extraction') {
      draft.runtime.extractionOutputMode = mode;
      const native = ctx.engine.previewPrompt(draft);
      expect(native.tools.map(tool => tool.name)).toEqual(mode === 'tool' ? ['submit_extraction'] : []);
      expect(native.body).not.toContain('emit_writing_response');
    }
  });
  it.each<PromptTask>(['writing', 'extraction', 'compression'])('previews the v0.8 framework and its actual output transport for %s without saving', async task => {
    const draft = input(task, protocol); draft.templates = withLegacyPresets(); draft.templates.general!.selected = V08_PRESET_ID;
    const before = (await ctx.app.inject({ url: '/api/settings', cookies })).body;
    const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: draft });
    expect(response.statusCode).toBe(200); const preview = response.json<PromptPreviewResult>();
    expect(preview.tools).toHaveLength(1); expect(preview.tools[0].name).toBe('emit_writing_response');
    expect(preview.body).toContain('FICTIONAL_TEXT_COMPLETION'); expect(preview.body).not.toContain('LATEST_USER_INPUT');
    expect(preview.runtimeBlocks.some(block => block.name === (task === 'writing' ? '正文工具通道规则' : '通用工具通道规则'))).toBe(true);
    expect((await ctx.app.inject({ url: '/api/settings', cookies })).body).toBe(before);
  });
  it.each<PromptTask>(['writing', 'extraction', 'compression'])('shows all messages and native payload for %s, with no provider-added JSON instruction', async task => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: input(task, protocol) });
    expect(response.statusCode).toBe(200);
    const preview = response.json<PromptPreviewResult>();
    const dialogue = preview.messages.filter(message => message.role !== 'system');
    expect(dialogue.map(message => message.role)).toEqual(task === 'compression' || task === 'extraction' ? ['user', 'assistant', 'user'] : ['user', 'assistant', 'user', 'assistant', 'user']);
    if (task === 'extraction') {
      expect(dialogue[2].content).toContain(variables.context);
      expect(dialogue[2].content).toContain(variables.blockText);
    }
    for (const block of preview.runtimeBlocks) expect(preview.messages.map(message => message.content).join('\n')).toContain(block.content);
    expect(preview.tools.length).toBe(task === 'writing' ? 6 : 0);
    if (task !== 'writing') {
      expect(preview.messages.filter(message => message.content.includes(STRUCTURED_OUTPUT_INSTRUCTION))).toHaveLength(1);
      const request = { messages: preview.messages, system: '', prompt: '' };
      expect(structuredRequest(request)).toBe(request);
    }
    const wire = JSON.parse(preview.body);
    expect(wire[protocol === 'gemini' ? 'contents' : protocol === 'openai-responses' ? 'input' : 'messages']).toBeInstanceOf(Array);
    expect(response.body).not.toContain('apiKey');
  });

  it('includes RPG identity, confirmed action, cumulative budget and enabled illustration tools', () => {
    const request = input('writing', protocol);
    request.variables = { ...variables, mode: 'rpg' };
    request.runtime = { rpg: { character: { kind: 'existing', name: '林舟', description: '信使' }, entryInstruction: '码头入场' }, chapterAnswer: '{"text":"登船","unansweredQuestions":[]}', illustrations: { portrait: true, cg: true } };
    const preview = ctx.engine.previewPrompt(request);
    const text = preview.messages.map(message => message.content).join('\n');
    for (const part of ['原作已有角色“林舟”', '码头入场', '必须调用 ask_user', '不能当作已确认行动', '本章目标 1500 字', '已累计生成正文 0 字', '登船']) expect(text).toContain(part);
    expect(preview.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['ask_user', 'generate_character_portrait', 'generate_scene_cg']));
    expect(preview.messages.filter(message => message.role !== 'system').map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    const native = JSON.parse(preview.body);
    const nativeText = JSON.stringify(native);
    expect(nativeText.split('[ai-novel:rpg-chapter-budget]')).toHaveLength(2);
    expect(nativeText).toContain('description');
  });

  it('reminds both writing channels to use declared tools while keeping all protection blocks intact', () => {
    for (const writingOutputMode of ['text', 'tool'] as const) {
      const request = input('writing', protocol);
      request.templates.presets.writing[0].writingOutputMode = writingOutputMode;
      const originalGeneral = structuredClone(request.templates.general);
      request.runtime.illustrations = { portrait: true, cg: false };
      const preview = ctx.engine.previewPrompt(request);
      const text = preview.messages.map(message => message.content).join('\n');
      expect(text).toContain('已有事实不足时先查询资料，再继续写作');
      expect(text).toContain('通过本次定义的接口提交工具调用，采用真实返回结果');
      expect(text).toContain('新人物首次出场、外观已在正文明确时，请求人物立绘');
      expect(text).not.toContain('场景切换或出现适合插画的关键瞬间');
      expect(preview.tools.map(tool => tool.name)).toContain(writingOutputMode === 'text' ? 'generate_character_portrait' : 'emit_writing_response');
      expect(preview.tools.map(tool => tool.name)).not.toContain('generate_scene_cg');
      expect(preview.body).toContain('search_story'); expect(preview.body).toContain('generate_character_portrait');
      expect(text.match(/SKIP silently thinking/g)).toHaveLength(2);
      expect(request.templates.general).toEqual(originalGeneral);
    }
  });

  it.each(['structured', 'tool'] as const)('previews extraction %s with the same schema and submission instructions used in real requests', async mode => {
    const draft = input('extraction', protocol); draft.runtime.extractionOutputMode = mode;
    const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: draft });
    expect(response.statusCode).toBe(200); const preview = response.json<PromptPreviewResult>();
    expect(preview.body).toContain('additionalProperties'); expect(preview.body).toContain('summary');
    if (mode === 'tool') {
      expect(preview.tools.map(tool => tool.name)).toEqual(['submit_extraction']);
      expect(preview.messages.map(message => message.content).join('\n')).not.toContain(STRUCTURED_OUTPUT_INSTRUCTION);
      expect(preview.messages.filter(message => message.role === 'system').at(-1)?.content).toContain('普通文本不能替代工具调用');
      const request = { system: '', prompt: '', messages: preview.messages, structuredOutput: { mode: 'tool' as const, name: 'submit_extraction', description: '', schema: {} } };
      expect(structuredRequest(request)).toBe(request);
    } else { expect(preview.tools).toEqual([]); expect(preview.messages.map(message => message.content).join('\n')).toContain('无法确定的可空字段填 null'); }
  });
});

it.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('%s preview shows the selected general framework and the complete layered transport tool', async protocol => {
  const draft = input('writing', protocol);
  draft.templates.general!.presets[0].blocks[0].content += '\n通用框架可见';
  draft.templates.presets.writing[0].writingOutputMode = 'tool';
  const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: draft });
  expect(response.statusCode).toBe(200);
  const preview = response.json(); expect(preview.messages.map((value: { content: string }) => value.content).join('\n')).toContain('通用框架可见');
  expect(preview.runtimeBlocks).toContainEqual(expect.objectContaining({ name: '正文工具通道规则' }));
  expect(preview.tools).toHaveLength(1); expect(preview.tools[0]).toMatchObject({ name: 'emit_writing_response', parameters: { required: ['prose', 'toolCalls'] } });
  expect(preview.tools[0].description).toContain('read_text_file'); expect(preview.body).toContain('argumentsJson');
});

it('requires authentication, validates drafts, and never saves settings or creates a model job', async () => {
  const before = ctx.settings.meta('settings');
  const draft = input('extraction', 'openai-chat');
  draft.templates.presets.extraction[0].blocks[0].content = '未保存的作者草稿';
  const payload = structuredClone(draft);
  expect((await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', payload })).statusCode).toBe(401);
  const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload });
  expect(response.statusCode).toBe(200); expect(response.body).toContain('未保存的作者草稿');
  expect(draft).toEqual(payload);
  draft.templates.presets.extraction[0].blocks[0].content = '{{missing}}';
  expect((await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: draft })).statusCode).toBe(400);
  expect((await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: { ...payload, runtime: { surprise: 'hidden' } } })).statusCode).toBe(400);
  expect(ctx.settings.meta('settings')).toBe(before); expect(ctx.engine.listJobs()).toEqual([]);
});

it.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('%s previews the original Reborn transform and image archive using the actual request builders', async protocol => {
  const before = ctx.settings.meta('settings'); const draft = input('writing', protocol); draft.templates = withTavernPresets(); draft.templates.general!.selected = 'tavern-reborn-v23'; draft.templates.selected.writing = 'default-writing-v3';
  const transformed = ctx.engine.previewPrompt(draft); expect(transformed.messages[0].content).toContain('<clear>'); expect(JSON.stringify(transformed.messages)).toContain('soliumbra'); expect(transformed.tools.some(tool => tool.name === 'game_content')).toBe(true);
  expect(transformed.messages.some(message => message.role === 'system' && message.content.includes('# 资料边界与查询') && message.content.includes('不代表本线已发生或角色已经知道'))).toBe(true);
  const image = { ...draft, task: 'image' as const, variables: { imageInput: '{"material":"雾港灯塔"}', imageSystemPrompt: '水彩', maxCharacterReferences: '0' } }; image.templates.general!.selected = 'tavern-linux-v13';
  const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: image }); expect(response.statusCode).toBe(200); const preview = response.json<PromptPreviewResult>();
  expect(preview.tools).toHaveLength(1); expect(preview.tools[0].name).toBe('dispatch_stream_payload'); expect(preview.tools[0].description).toContain('IMAGE_PROMPT_OPTIMIZATION'); expect(preview.tools[0].description).toContain('雾港灯塔');
  expect(ctx.settings.meta('settings')).toBe(before);
});

it('keeps the extraction example valid under the real evidence and output validator', () => {
  const source = splitExtractionBlocks('旅人林舟来到了灯塔。\n他想起三年前住在石桥镇的日子。')[0];
  source.sources.forEach((value, index) => { value.paragraph = index + 12; });
  const result = normalizeExtraction(JSON.parse(EXTRACT_SYSTEM.split('\n输出：\n')[1]), source);
  expect(result.issues).toEqual([]);
  expect(result.value?.entities[0].facts.map(fact => ({ temporal: fact.temporal, paragraph: fact.paragraph }))).toEqual([{ temporal: 'current', paragraph: 12 }, { temporal: 'past', paragraph: 13 }]);
});
