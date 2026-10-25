import { describe, expect, it } from 'vitest';
import { activePromptPreset, compileTaskPrompt, defaultPromptTemplates } from '../shared/prompt-templates.js';
import type { PromptRuntime } from '../shared/prompt-runtime.js';
import { buildRequestSnapshot } from '../server/providers.js';
import type { ModelRequest, PromptTask, ProviderConfig, ProviderProtocol } from '../shared/types.js';

const protocols: ProviderProtocol[] = ['openai-chat', 'openai-responses', 'gemini', 'claude'];
const variables = { mode: 'original', instruction: '从门口继续写。', maxWords: '800', writingTarget: '当前场景',
  context: '{"worldview":"港城以船运为生。"}', chapterTitle: '旧港', blockText: '[1] 信使走进港城。',
  summaryText: '信使来到港城，找到了约定的船只。', imageInput: '{"material":"信使站在码头。"}', maxCharacterReferences: '0' };
const metaInstructions = /思考|内部(?:核对|复核|完成)|(?:think|thought)|独立字段|辅助标签|程序清理/iu;
const lookup = { name: 'read_entity', description: '读取人物档案。', parameters: { type: 'object', properties: { id: { type: 'string', description: '人物标识。' } }, required: ['id'] }, execute: () => ({}) };

// Only textual instructions are checked. Provider option keys remain native API data.
function descriptions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(descriptions);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, field]) => key === 'description' && typeof field === 'string' ? [field] : descriptions(field));
}
const config = (protocol: ProviderProtocol): ProviderConfig => ({ id: 'fixture', name: '请求结构验证', protocol,
  baseUrl: 'http://127.0.0.1:1', model: 'fixture-model', maxOutputTokens: 4096, contextTokens: 64000, stream: false, timeoutMs: 1000 });
const toolNames = (protocol: ProviderProtocol, body: any): string[] => protocol === 'gemini'
  ? (body.tools ?? []).flatMap((group: any) => (group.functionDeclarations ?? []).map((tool: any) => tool.name))
  : (body.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name);

const cases: { name: string; task: PromptTask; transport: 'text' | 'native' | 'layered'; extraction?: PromptRuntime['extractionOutputMode']; sink?: string }[] = [
  { name: 'ordinary prose', task: 'writing', transport: 'text' },
  { name: 'native result tool', task: 'writing', transport: 'native', sink: 'emit_complete_text' },
  { name: 'layered writing tool', task: 'writing', transport: 'layered', sink: 'emit_writing_response' },
  { name: 'plain JSON', task: 'extraction', transport: 'text', extraction: 'prompt' },
  { name: 'JSON through layered tool', task: 'compression', transport: 'layered', sink: 'emit_writing_response' },
  { name: 'native JSON schema', task: 'extraction', transport: 'native', extraction: 'structured' },
  { name: 'native extraction tool', task: 'extraction', transport: 'native', extraction: 'tool', sink: 'submit_extraction' },
];

describe.each(protocols)('%s delivery instructions', protocol => {
  it.each(cases)('describes task delivery without cognition instructions in $name', item => {
    const templates = defaultPromptTemplates(); const preset = activePromptPreset(templates, item.task);
    const general = activePromptPreset(templates, 'general');
    if (item.transport === 'text') {
      if (item.task === 'writing') preset.writingOutputMode = 'text';
      else preset.useGeneral = false;
    } else if (item.transport === 'layered') {
      general.responseCarrier = undefined; general.toolTransport = true;
      if (item.task === 'writing') preset.writingOutputMode = 'tool';
    }
    const before = structuredClone(templates);
    const compiled = compileTaskPrompt(templates, item.task, variables, { extractionOutputMode: item.extraction });
    const request: ModelRequest = { ...compiled, ...(item.task === 'writing' ? { tools: [lookup] } : {}) };
    const body = JSON.parse(buildRequestSnapshot(config(protocol), request).body);
    const instructions = [...compiled.messages.map(message => message.content), ...descriptions(body.tools)].join('\n');
    expect(instructions).not.toMatch(metaInstructions);
    expect(compiled.messages.some(message => message.role === 'user' && message.content.trim())).toBe(true);
    expect(templates).toEqual(before);
    if (item.sink) expect(toolNames(protocol, body)).toContain(item.sink);
    if (item.name === 'ordinary prose') expect(toolNames(protocol, body)).toEqual(['read_entity']);
    if (item.extraction === 'structured') expect(compiled.structuredOutput?.mode).toBe('json_schema');
    if (item.extraction === 'tool') expect(compiled.structuredOutput?.mode).toBe('tool');
  });

  it('still sends provider-controlled reasoning options as protocol fields', () => {
    const templates = defaultPromptTemplates(); activePromptPreset(templates, 'writing').writingOutputMode = 'text';
    const compiled = compileTaskPrompt(templates, 'writing', variables);
    const options: Partial<ProviderConfig> = protocol === 'gemini' ? { geminiThinking: { mode: 'level', level: 'high' }, geminiIncludeThoughts: true }
      : protocol === 'claude' ? { claudeThinking: { type: 'adaptive' }, claudeEffort: 'high' } : { reasoningEffort: 'high' };
    const body = JSON.parse(buildRequestSnapshot({ ...config(protocol), ...options }, compiled).body);
    expect(compiled.messages.map(message => message.content).join('\n')).not.toMatch(metaInstructions);
    if (protocol === 'gemini') expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high', includeThoughts: true });
    else if (protocol === 'claude') { expect(body.thinking).toEqual({ type: 'adaptive' }); expect(body.output_config).toEqual({ effort: 'high' }); }
    else if (protocol === 'openai-responses') expect(body.reasoning).toEqual({ effort: 'high' });
    else expect(body.reasoning_effort).toBe('high');
  });
});

it('keeps literal story text and explicitly authored template markup intact', () => {
  const templates = defaultPromptTemplates(); const preset = activePromptPreset(templates, 'writing');
  preset.writingOutputMode = 'text';
  const story = '牌匾写着 <think>Thought Bridge</think>，她思考着桥名的由来。';
  const compiled = compileTaskPrompt(templates, 'writing', { ...variables, context: JSON.stringify({ worldview: story }) });
  expect(compiled.prompt).toContain(story);
  expect(compiled.runtimeBlocks.map(block => block.content).join('\n')).not.toMatch(metaInstructions);
  preset.useGeneral = false; preset.textFilter = 'tavern';
  preset.blocks = [{ id: 'author-format', name: '作者格式', role: 'user', enabled: true, content: '<think>作者明确规定的栏目。</think>\n{{instruction}}' }];
  const before = structuredClone(templates);
  const custom = compileTaskPrompt(templates, 'writing', variables);
  expect(custom.messages.find(message => message.role === 'user')?.content).toBe(`<think>作者明确规定的栏目。</think>\n${variables.instruction}`);
  expect(custom.textFilter).toBe('tavern'); expect(templates).toEqual(before);
});
