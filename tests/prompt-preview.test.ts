import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import { defaultPromptTemplates, EXTRACT_SYSTEM } from '../shared/prompt-templates.js';
import { normalizeExtraction, splitExtractionBlocks } from '../server/extraction.js';
import { structuredRequest } from '../server/providers.js';
import { STRUCTURED_OUTPUT_INSTRUCTION, type PromptPreviewInput, type PromptPreviewResult } from '../shared/prompt-runtime.js';
import type { PromptTask, ProviderProtocol } from '../shared/types.js';

let ctx: Awaited<ReturnType<typeof buildApp>>;
let cookies: { session: string };
beforeAll(async () => {
  ctx = await buildApp({ initialPassword: 'prompt-preview-test-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-prompt-preview-')), startEngine: false });
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'prompt-preview-test-password' } });
  cookies = { session: login.cookies[0].value };
});
afterAll(async () => { await ctx?.app.close(); });
const variables = { context: '示例故事资料', mode: 'original', instruction: '继续故事', chapterNumber: '2', endChapter: '5', maxWords: '1500', writingTarget: '请写第 2 章', chapterTitle: '雨夜', blockText: '[1] 林舟来到码头。', summaryText: '林舟来到码头并找到旧怀表。' };
const input = (task: PromptTask, protocol: ProviderProtocol): PromptPreviewInput => ({ task, protocol, templates: defaultPromptTemplates(), variables, runtime: {} });

describe.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('%s final prompt preview', protocol => {
  it.each<PromptTask>(['writing', 'planning', 'extraction', 'compression'])('shows all messages and native payload for %s, with no provider-added JSON instruction', async task => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: input(task, protocol) });
    expect(response.statusCode).toBe(200);
    const preview = response.json<PromptPreviewResult>();
    const dialogue = preview.messages.filter(message => message.role !== 'system');
    expect(dialogue.map(message => message.role)).toEqual(task === 'compression' || task === 'extraction' ? ['user'] : ['user', 'assistant', 'user']);
    if (task === 'extraction') {
      expect(dialogue[0].content).toContain(variables.context);
      expect(dialogue[0].content).toContain(variables.blockText);
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
    expect(preview.messages.filter(message => message.role !== 'system').map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    const native = JSON.parse(preview.body);
    const nativeText = JSON.stringify(native);
    expect(nativeText.split('[ai-novel:rpg-chapter-budget]')).toHaveLength(2);
    expect(nativeText).toContain('description');
  });

  it('shows tool planning instead of imposing a contradictory final-JSON requirement, and supports original reference tools', () => {
    const request = input('planning', protocol);
    request.runtime.planningMode = 'tool';
    const preview = ctx.engine.previewPrompt(request);
    expect(preview.messages.map(message => message.content).join('\n')).not.toContain(STRUCTURED_OUTPUT_INSTRUCTION);
    expect(preview.messages.map(message => message.content).join('\n')).toContain('最终文本或 JSON 都不能替代工具调用');
    expect(preview.tools.find(tool => tool.name === 'update_plot_plan')?.parameters).toMatchObject({ properties: { fine: { items: { properties: { chapter: { minimum: 2, maximum: 5 } } } } } });
    request.runtime.planningMode = 'separate'; request.variables = { ...variables, originalReference: '{"worldview":"原作"}' };
    expect(ctx.engine.previewPrompt(request).tools.map(tool => tool.name)).toContain('read_text_file');
    expect(ctx.engine.previewPrompt(request).tools.map(tool => tool.name)).not.toContain('update_plot_plan');
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

it('keeps the extraction example valid under the real evidence and output validator', () => {
  const source = splitExtractionBlocks('旅人林舟来到了灯塔。\n他想起三年前住在石桥镇的日子。')[0];
  source.sources.forEach((value, index) => { value.paragraph = index + 12; });
  const result = normalizeExtraction(JSON.parse(EXTRACT_SYSTEM.split('\n输出：\n')[1]), source);
  expect(result.issues).toEqual([]);
  expect(result.value?.entities[0].facts.map(fact => ({ temporal: fact.temporal, paragraph: fact.paragraph }))).toEqual([{ temporal: 'current', paragraph: 12 }, { temporal: 'past', paragraph: 13 }]);
});
