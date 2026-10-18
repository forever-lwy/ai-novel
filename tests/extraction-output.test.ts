import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRequestSnapshot, estimateModelRequestInputTokens, generateStructured, unwrapModelOutput } from '../server/providers.js';
import { normalizeExtraction, splitExtractionBlocks } from '../server/extraction.js';
import { StoryEngine } from '../server/engine.js';
import { Store } from '../server/store.js';
import { compileTaskPrompt, defaultPromptTemplates } from '../shared/prompt-templates.js';
import { extractionOutputSchema, EXTRACTION_SUBMISSION_NAME } from '../shared/extraction-output.js';
import { defaultTaskSettings } from '../shared/task-settings.js';
import type { ExtractionOutputMode, ProviderConfig, ProviderProtocol, Settings } from '../shared/types.js';

const protocols: ProviderProtocol[] = ['openai-chat', 'openai-responses', 'gemini', 'claude'];
const servers: Server[] = [];
const engines: StoryEngine[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const store of stores.splice(0)) store.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
const source = '林舟来到白石城。';
const extracted = () => ({ summary: source, entities: [{ kind: 'character', name: '林舟', aliases: [], nameStatus: null, isMain: null, description: '', visibility: 'public', facts: [{ text: source, attribute: null, temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 1 }] }], relations: [], foreshadows: [{ title: '城门旧锁', detail: '', status: 'planted', dueChapter: null, revealCondition: '', relatedNames: [] }] });
const prompt = (mode: ExtractionOutputMode) => compileTaskPrompt(undefined, 'extraction', { context: '名称对照：[]', chapterTitle: '入城', blockText: `[1] ${source}` }, { extractionOutputMode: mode });
const config = (protocol: ProviderProtocol, baseUrl: string, stream = false): ProviderConfig => ({ id: 'fixture', name: '提取模拟接口', protocol, baseUrl, model: 'fixture', apiKey: 'fake-extraction-secret', maxOutputTokens: 4096, contextTokens: 64000, stream, timeoutMs: 1500 });
async function upstream(reply: (body: any, response: ServerResponse, index: number) => void) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); reply(body, response, bodies.length - 1); });
  servers.push(server); await listenLocalServer(server);
  return { bodies, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
}
function envelope(protocol: ProviderProtocol, tool: boolean, value: unknown = extracted(), name = EXTRACTION_SUBMISSION_NAME, count = 1): any {
  const args = typeof value === 'string' ? value : JSON.stringify(value);
  const calls = Array.from({ length: count }, (_, i) => ({ id: `call-${i}`, name }));
  const text = tool ? '提交资料。' : args;
  if (protocol === 'openai-chat') return { choices: [{ message: { content: text, ...(tool ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name, arguments: args } })) } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }, ...(tool ? calls.map(call => ({ type: 'function_call', id: call.id, call_id: call.id, name, arguments: args })) : [])], usage: { input_tokens: 20, output_tokens: 8 } };
  if (protocol === 'gemini') return { candidates: [{ content: { parts: [{ text }, ...(tool ? calls.map(call => ({ functionCall: { ...call, args: value } })) : [])] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 } };
  return { type: 'message', content: [{ type: 'text', text }, ...(tool ? calls.map(call => ({ type: 'tool_use', ...call, input: value })) : [])], stop_reason: tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } };
}
const sse = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
function streamReply(protocol: ProviderProtocol, tool: boolean, value = extracted()): string {
  const text = JSON.stringify(value), half = Math.floor(text.length / 2);
  if (protocol === 'openai-chat') return sse({ choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: 'call-0', type: 'function', function: { name: EXTRACTION_SUBMISSION_NAME, arguments: text.slice(0, half) } }] } : { content: text.slice(0, half) } }] })
    + sse({ choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, function: { arguments: text.slice(half) } }] } : { content: text.slice(half) }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } }) + sse('[DONE]');
  if (protocol === 'openai-responses') return (tool ? sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'call-0', call_id: 'call-0', name: EXTRACTION_SUBMISSION_NAME, arguments: '' } }) + sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call-0', delta: text.slice(0, half) }) + sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call-0', delta: text.slice(half) }) : sse({ type: 'response.output_text.delta', delta: text })) + sse({ type: 'response.completed', response: envelope(protocol, tool, value) });
  if (protocol === 'gemini') return sse(envelope(protocol, tool, value));
  return sse({ type: 'message_start', message: { content: [], usage: { input_tokens: 20 } } }) + sse({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call-0', name: EXTRACTION_SUBMISSION_NAME, input: {} } : { type: 'text', text: '' } })
    + [text.slice(0, half), text.slice(half)].map(part => sse({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: part } : { type: 'text_delta', text: part } })).join('')
    + sse({ type: 'content_block_stop', index: 0 }) + sse({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 8 } }) + sse({ type: 'message_stop' });
}
function checkWire(protocol: ProviderProtocol, mode: ExtractionOutputMode, body: any) {
  if (mode === 'structured') {
    const format = protocol === 'openai-chat' ? body.response_format.json_schema : protocol === 'openai-responses' ? body.text.format : protocol === 'gemini' ? { schema: body.generationConfig.responseJsonSchema } : body.output_config.format;
    expect(format.schema).toEqual(extractionOutputSchema); expect(body.tools).toBeUndefined();
    if (protocol.startsWith('openai')) expect(format.strict).toBe(true);
    if (protocol === 'gemini') expect(body.generationConfig.responseMimeType).toBe('application/json');
  } else {
    expect(JSON.stringify(body.tools)).toContain(EXTRACTION_SUBMISSION_NAME);
    if (protocol === 'openai-chat') expect(body.tool_choice).toEqual({ type: 'function', function: { name: EXTRACTION_SUBMISSION_NAME } });
    if (protocol === 'openai-responses') expect(body.tool_choice).toEqual({ type: 'function', name: EXTRACTION_SUBMISSION_NAME });
    if (protocol.startsWith('openai')) expect(body.parallel_tool_calls).toBe(false);
    if (protocol === 'gemini') { expect(body.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(extractionOutputSchema); expect(body.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: [EXTRACTION_SUBMISSION_NAME] }); }
    if (protocol === 'claude') expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(body.response_format).toBeUndefined(); expect(body.output_config?.format).toBeUndefined(); expect(body.generationConfig?.responseJsonSchema).toBeUndefined(); expect(body.text?.format).toBeUndefined();
  }
}

describe.each(protocols)('%s extraction output protocols', protocol => {
  it.each(['structured', 'tool'] as const)('handles %s in streaming and nonstreaming with exactly one request and recoverable output', async mode => {
    const service = await upstream((_body, response, index) => { response.writeHead(200, { 'content-type': index === 1 ? 'text/event-stream' : 'application/json' }); response.end(index === 1 ? streamReply(protocol, mode === 'tool') : JSON.stringify(envelope(protocol, mode === 'tool'))); });
    for (const stream of [false, true]) {
      const onResponse = vi.fn(); const result = await generateStructured(config(protocol, service.baseUrl, stream), { ...prompt(mode), onResponse }, value => value);
      expect(result).toEqual({ value: extracted(), inputTokens: 20, outputTokens: 8 });
      expect(service.bodies).toHaveLength(stream ? 2 : 1); checkWire(protocol, mode, service.bodies.at(-1));
      expect(onResponse).toHaveBeenCalledTimes(1);
      const capture = onResponse.mock.calls[0][0];
      expect(JSON.parse(capture.text)).toEqual(extracted()); expect(capture.request.body).not.toContain('fake-extraction-secret');
      expect(capture).toMatchObject({ inputTokens: 20, outputTokens: 8, incomplete: false, diagnostics: { modelOutcome: 'completed' } });
      const normalized = normalizeExtraction(result.value, splitExtractionBlocks(source)[0]);
      expect(normalized.issues).toEqual([]); expect(normalized.value!.entities[0].facts[0].quote).toBe(source);
      expect(normalized.value!.entities[0].nameStatus).toBeUndefined(); expect(normalized.value!.entities[0].isMain).toBeUndefined(); expect(normalized.value!.foreshadows[0].dueChapter).toBeUndefined();
      expect(JSON.parse(unwrapModelOutput(JSON.stringify(envelope(protocol, mode === 'tool'))))).toEqual(extracted());
    }
  });

  it.each(['missing', 'wrong', 'multiple', 'invalid-json', 'array', 'truncated', 'refused'] as const)('rejects %s submission without issuing another request and retains billed usage', async problem => {
    const data = envelope(protocol, problem !== 'missing', problem === 'invalid-json' ? '{"summary":' : problem === 'array' ? [] : extracted(), problem === 'wrong' ? 'unknown_tool' : EXTRACTION_SUBMISSION_NAME, problem === 'multiple' ? 2 : 1);
    if (problem === 'truncated') { if (protocol === 'openai-chat') data.choices[0].finish_reason = 'length'; else if (protocol === 'openai-responses') data.status = 'incomplete'; else if (protocol === 'gemini') data.candidates[0].finishReason = 'MAX_TOKENS'; else data.stop_reason = 'max_tokens'; }
    if (problem === 'refused') { if (protocol === 'openai-chat') data.choices[0].message.refusal = 'refused'; else if (protocol === 'openai-responses') data.output.unshift({ type: 'message', content: [{ type: 'refusal', refusal: 'refused' }] }); else if (protocol === 'gemini') data.candidates[0].finishReason = 'SAFETY'; else data.stop_reason = 'refusal'; }
    const service = await upstream((_body, response) => response.end(JSON.stringify(data)));
    const onResponse = vi.fn();
    await expect(generateStructured(config(protocol, service.baseUrl), { ...prompt('tool'), onResponse }, value => value)).rejects.toMatchObject({ name: 'ModelOutputError', inputTokens: 20, outputTokens: 8 });
    expect(service.bodies).toHaveLength(1); expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0][0].rawResponse).toContain(protocol === 'openai-chat' ? 'choices' : protocol === 'openai-responses' ? 'output' : protocol === 'gemini' ? 'candidates' : 'content');
  });

  it('keeps standalone prompt mode free of schema and submission tools', () => {
    const templates = defaultPromptTemplates(); templates.presets.extraction[0].useGeneral = false;
    const standalone = (mode: ExtractionOutputMode) => compileTaskPrompt(templates, 'extraction', { context: '名称对照：[]', chapterTitle: '入城', blockText: `[1] ${source}` }, { extractionOutputMode: mode });
    const body = JSON.parse(buildRequestSnapshot(config(protocol, 'http://fixture.invalid'), standalone('prompt')).body);
    expect(body.tools).toBeUndefined(); expect(body.response_format).toBeUndefined(); expect(body.text?.format).toBeUndefined(); expect(body.output_config?.format).toBeUndefined(); expect(body.generationConfig?.responseJsonSchema).toBeUndefined();
    expect(estimateModelRequestInputTokens(config(protocol, 'http://fixture.invalid'), standalone('structured'))).toBeGreaterThan(estimateModelRequestInputTokens(config(protocol, 'http://fixture.invalid'), standalone('prompt')) + 500);
  });
  it('carries default prompt JSON through the neutral result tool without enabling extraction schema', () => {
    const body = JSON.parse(buildRequestSnapshot(config(protocol, 'http://fixture.invalid'), prompt('prompt')).body);
    const tools = protocol === 'gemini' ? body.tools[0].functionDeclarations : protocol === 'openai-chat' ? body.tools.map((tool: any) => tool.function) : body.tools;
    expect(tools.map((tool: any) => tool.name)).toEqual(['emit_complete_text']);
    expect(body.response_format ?? body.text?.format ?? body.output_config?.format ?? body.generationConfig?.responseJsonSchema).toBeUndefined();
    expect(JSON.stringify(body)).toContain(source); expect(JSON.stringify(body)).not.toContain(EXTRACTION_SUBMISSION_NAME);
  });
});

it('preserves Claude thinking and effort while adding schema or tool selection', () => {
  const provider = { ...config('claude', 'http://fixture.invalid'), claudeThinking: { type: 'adaptive' as const }, claudeEffort: 'high' as const };
  for (const mode of ['structured', 'tool'] as const) {
    const body = JSON.parse(buildRequestSnapshot(provider, prompt(mode)).body);
    expect(body.thinking).toEqual({ type: 'adaptive' }); expect(body.output_config.effort).toBe('high'); checkWire('claude', mode, body);
  }
});

it('does not turn null required facts into accepted defaults', () => {
  const value = extracted(); value.entities[0].facts[0].visibility = null as any;
  expect(normalizeExtraction(value, splitExtractionBlocks(source)[0]).issues.some(issue => issue.path.includes('visibility'))).toBe(true);
});

it('redacts submission arguments and saved responses using the same credential rules', async () => {
  const value = { ...extracted(), summary: 'fake-extraction-secret', apiKey: 'another-secret' };
  const service = await upstream((_body, response) => response.end(JSON.stringify(envelope('openai-chat', true, value))));
  const onResponse = vi.fn(); const result = await generateStructured(config('openai-chat', service.baseUrl), { ...prompt('tool'), onResponse }, value => value);
  expect(JSON.stringify(result)).not.toMatch(/fake-extraction-secret|another-secret/); expect(JSON.stringify(onResponse.mock.calls)).not.toMatch(/fake-extraction-secret|another-secret/);
});

async function terminal(engine: StoryEngine, id: string) {
  for (let count = 0; count < 1000; count++) { const job = engine.listJobs().find(job => job.id === id)!; if (['completed', 'failed', 'stale', 'cancelled'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('提取任务超时');
}
function engineFor(baseUrl: string, mode: ExtractionOutputMode, withChapter = true) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-output-mode-'))); stores.push(store);
  const project = store.createProject({ title: '输出模式模拟验收' }); const tasks = defaultTaskSettings(); tasks.extraction.outputMode = mode;
  const settings: Settings = { providers: [config('openai-chat', baseUrl)], writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture', taskSettings: tasks };
  if (withChapter) store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: '入城', text: source });
  const engine = new StoryEngine(store, () => settings); engines.push(engine); engine.start();
  return { engine, store, settings, project, start: () => engine.enqueue(project.mainBranchId, 'extract', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId }) };
}

it.each(['structured', 'tool'] as const)('%s integrates with versioned evidence, failed output repair and unchanged prose', async mode => {
  const bad = extracted(); bad.entities[0].facts[0].paragraph = 99;
  const service = await upstream((_body, response) => response.end(JSON.stringify(envelope('openai-chat', mode === 'tool', bad))));
  const ctx = engineFor(service.baseUrl, mode); const before = ctx.store.getBranch(ctx.project.mainBranchId).revisionId; const job = ctx.start();
  expect(await terminal(ctx.engine, job.id)).toMatchObject({ status: 'failed', inputTokens: 20, outputTokens: 8 });
  expect(ctx.store.getBranch(ctx.project.mainBranchId).revisionId).toBe(before); checkWire('openai-chat', mode, service.bodies[0]);
  const output = ctx.engine.listOutputs(job.id)[0]; const detail = ctx.engine.outputDetail(job.id, output.id);
  expect(detail.output.issues.some(issue => issue.path.includes('paragraph'))).toBe(true); expect(JSON.parse(detail.output.text)).toEqual(bad);
  ctx.engine.applyOutput(job.id, output.id, { text: JSON.stringify(envelope('openai-chat', mode === 'tool')), baseRevisionId: output.baseRevisionId });
  expect(ctx.store.state(ctx.project.mainBranchId).entities[0].facts[0].citation?.quote).toBe(source);
  const chapter = ctx.store.state(ctx.project.mainBranchId).chapters[0]; expect(ctx.store.chapter(ctx.project.mainBranchId, chapter.id).text).toBe(source);
  expect(service.bodies).toHaveLength(1);
});

it.each(['structured', 'tool'] as const)('%s counts schema in the context budget before sending and never downgrades an unsupported request', async mode => {
  const service = await upstream((_body, response) => { response.writeHead(400); response.end('{"error":"unsupported format"}'); });
  const ctx = engineFor(service.baseUrl, mode);
  ctx.settings.taskSettings!.extraction.autoRetry = true;
  const job = ctx.start(); expect((await terminal(ctx.engine, job.id)).status).toBe('failed'); expect(service.bodies).toHaveLength(1); checkWire('openai-chat', mode, service.bodies[0]);
  ctx.settings.providers[0].contextTokens = 4097;
  ctx.engine.action(job.id, 'retry'); expect((await terminal(ctx.engine, job.id)).error).toContain('上下文上限'); expect(service.bodies).toHaveLength(1);
});

it.each(['structured', 'tool'] as const)('%s completes imports with only the explicitly enabled failed-attempt retry', async mode => {
  const service = await upstream((_body, response, index) => response.end(JSON.stringify(envelope('openai-chat', mode === 'tool', index === 0 ? '{"summary":' : extracted()))));
  const ctx = engineFor(service.baseUrl, mode, false);
  Object.assign(ctx.settings.taskSettings!.extraction, { autoRetry: true, maxRetries: 1, retryDelayMs: 0 });
  const job = ctx.engine.enqueue(ctx.project.mainBranchId, 'import', { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, chapters: [{ title: '入城', text: source }] });
  expect(await terminal(ctx.engine, job.id)).toMatchObject({ status: 'completed', inputTokens: 40, outputTokens: 16 });
  expect(service.bodies).toHaveLength(2); for (const body of service.bodies) checkWire('openai-chat', mode, body);
  expect(ctx.engine.listOutputs(job.id).map(output => output.status).sort()).toEqual(['applied', 'invalid']);
  const state = ctx.store.state(ctx.project.mainBranchId); expect(state.chapters).toHaveLength(1); expect(state.entities[0].facts[0].citation?.quote).toBe(source);
});

it.each(['cancelled', 'timeout'] as const)('retains partial tool arguments on %s and never continues or resends', async reason => {
  const controller = new AbortController();
  const partial = '{"summary":"半段资料';
  const service = await upstream((_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-0', type: 'function', function: { name: EXTRACTION_SUBMISSION_NAME, arguments: partial } }] } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }));
    if (reason === 'cancelled') setTimeout(() => controller.abort(), 50);
  });
  const onResponse = vi.fn();
  await expect(generateStructured({ ...config('openai-chat', service.baseUrl, true), timeoutMs: 1000 }, { ...prompt('tool'), signal: controller.signal, onResponse }, value => value)).rejects.toMatchObject({ message: expect.stringContaining(reason === 'timeout' ? '超时' : '取消') });
  expect(service.bodies).toHaveLength(1); expect(onResponse).toHaveBeenCalledTimes(1);
  expect(onResponse.mock.calls[0][0]).toMatchObject({ text: partial, incomplete: true, inputTokens: 20, outputTokens: 8, diagnostics: { transport: reason === 'timeout' ? 'timeout' : 'cancelled' } });
});
