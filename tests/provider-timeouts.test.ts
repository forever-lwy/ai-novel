import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { generateText } from '../server/providers.js';
import type { ModelActivityEvent, ProviderConfig, ProviderProtocol } from '../shared/types.js';

const protocols: ProviderProtocol[] = ['openai-chat', 'openai-responses', 'gemini', 'claude'];
const servers: Server[] = [];
const deadlineMs = 250, gapMs = 80;
const request = { system: '只输出正文。', prompt: '本地超时边界验证。' };
const event = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const config = (protocol: ProviderProtocol, baseUrl: string): ProviderConfig => ({ id: 'fixture', name: '本地计时验证', protocol, baseUrl, model: 'fixture', timeoutMs: 1000, stream: true, maxOutputTokens: 1000, contextTokens: 64000 });

beforeEach(() => {
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => realSetTimeout(callback, delay === 1000 ? deadlineMs : delay, ...args)) as typeof setTimeout);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function upstream(reply: (response: ServerResponse, index: number) => void) {
  let count = 0;
  const server = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) { /* Drain the local request body. */ }
    response.setHeader('Connection', 'close'); reply(response, count++);
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, requests: () => count };
}
function flowing(response: ServerResponse, frames: string[], gap = gapMs) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let position = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => { if (response.destroyed) return; response.write(frames[position++]); if (position === frames.length) response.end(); else timer = setTimeout(send, gap); };
  response.on('close', () => clearTimeout(timer)); send();
}
function finish(protocol: ProviderProtocol): string {
  if (protocol === 'openai-chat') return event({ choices: [{ delta: { content: '完成正文。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 5 } }) + event('[DONE]');
  if (protocol === 'openai-responses') return event({ type: 'response.output_text.delta', delta: '完成正文。' }) + event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '完成正文。' }] }], usage: { input_tokens: 8, output_tokens: 5 } } });
  if (protocol === 'gemini') return event({ candidates: [{ content: { parts: [{ text: '完成正文。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5 } });
  return event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) + event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '完成正文。' } }) + event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 8, output_tokens: 5 } }) + event({ type: 'message_stop' });
}
function thoughtFrames(protocol: ProviderProtocol) {
  const frames = Array.from({ length: 6 }, () => protocol === 'openai-chat' ? event({ choices: [{ delta: { reasoning_content: '持续公开思考。' } }] })
    : protocol === 'openai-responses' ? event({ type: 'response.reasoning_summary_text.delta', item_id: 'reasoning', output_index: 0, summary_index: 0, delta: '持续公开思考。' })
    : protocol === 'gemini' ? event({ candidates: [{ content: { parts: [{ thought: true, text: '持续公开思考。' }] } }] })
    : event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '持续公开思考。' } }));
  if (protocol === 'claude') frames[0] = event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) + frames[0];
  return [...frames, finish(protocol)];
}
function toolFrames(protocol: ProviderProtocol) {
  const pieces = ['{"id":"', 's', 'u', 'p', 'port', '"}'];
  const call = { type: 'function_call', id: 'item', call_id: 'lookup', name: 'read_entity', arguments: '{"id":"support"}' };
  if (protocol === 'openai-chat') return [...pieces.map((arguments_, index) => event({ choices: [{ delta: { tool_calls: [{ index: 0, ...(index ? {} : { id: 'lookup', type: 'function' }), function: { ...(index ? {} : { name: 'read_entity' }), arguments: arguments_ } }] } }] })), event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 5 } }) + event('[DONE]')];
  if (protocol === 'openai-responses') return [...pieces.map((delta, index) => (index ? '' : event({ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } })) + event({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item', delta })), event({ type: 'response.completed', response: { status: 'completed', output: [call], usage: { input_tokens: 8, output_tokens: 5 } } })];
  if (protocol === 'gemini') return [...pieces.map((_, index) => event({ candidates: [{ content: { parts: [{ functionCall: { id: `lookup-${index}`, name: 'read_entity', args: { id: 'support' } } }] } }] })), event({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5 } })];
  return [...pieces.map((partial_json, index) => (index ? '' : event({ type: 'message_start', message: { content: [], usage: { input_tokens: 8 } } }) + event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'lookup', name: 'read_entity', input: {} } })) + event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })), event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }) + event({ type: 'message_stop' })];
}
function partialFrames(protocol: ProviderProtocol) {
  if (protocol === 'openai-chat') return event({ choices: [{ delta: { reasoning_content: '中断前思考。', content: '中断前正文。' } }], usage: { prompt_tokens: 8, completion_tokens: 5 } });
  if (protocol === 'openai-responses') return event({ type: 'response.reasoning_summary_text.delta', delta: '中断前思考。' }) + event({ type: 'response.output_text.delta', delta: '中断前正文。', usage: { input_tokens: 8, output_tokens: 5 } });
  if (protocol === 'gemini') return event({ candidates: [{ content: { parts: [{ thought: true, text: '中断前思考。' }, { text: '中断前正文。' }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5 } });
  return event({ type: 'message_start', message: { content: [], usage: { input_tokens: 8 } } }) + event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) + event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '中断前思考。' } }) + event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) + event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '中断前正文。' } }) + event({ type: 'message_delta', delta: {}, usage: { output_tokens: 5 } });
}

describe('text response first-content and idle deadlines', () => {
  it.each(protocols)('%s times out waiting for first content even after headers arrive', async protocol => {
    const captured = vi.fn();
    const service = await upstream(response => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); });
    await expect(generateText(config(protocol, service.url), { ...request, onResponse: captured })).rejects.toThrow('等待首段响应内容超时（1 秒）');
    expect(service.requests()).toBe(1); expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0][0]).toMatchObject({ rawResponse: '', text: '', incomplete: true, diagnostics: { transport: 'timeout', responseBytes: 0 }, request: { stream: true, timeoutMs: 1000 } });
  });

  it.each(protocols)('%s keeps receiving thinking for longer than one timeout before prose arrives', async protocol => {
    const captured = vi.fn(); const activities: ModelActivityEvent[] = []; const deltas: string[] = [];
    const service = await upstream(response => flowing(response, thoughtFrames(protocol)));
    const result = await generateText(config(protocol, service.url), { ...request, onResponse: captured, onActivity: value => activities.push(value), onTextDelta: value => deltas.push(value) });
    expect(result.text).toBe('完成正文。'); expect(deltas.join('')).toBe('完成正文。'); expect(service.requests()).toBe(1);
    expect(activities.some(value => value.type === 'thinking' && value.text.includes('持续公开思考'))).toBe(true);
    expect(captured.mock.calls[0][0].diagnostics).toMatchObject({ transport: 'http', elapsedMs: expect.any(Number) });
    expect(captured.mock.calls[0][0].diagnostics.elapsedMs).toBeGreaterThan(deadlineMs);
  });

  it.each(protocols)('%s keeps receiving only tool content beyond the deadline and continues once', async protocol => {
    const captured = vi.fn(); const execute = vi.fn(() => ({ description: '本地资料' }));
    const service = await upstream((response, index) => flowing(response, index ? [finish(protocol)] : toolFrames(protocol)));
    const result = await generateText(config(protocol, service.url), { ...request, onResponse: captured, tools: [{ name: 'read_entity', description: '读取人物', parameters: { type: 'object' }, execute }] });
    expect(result).toMatchObject({ text: '完成正文。', inputTokens: 16, outputTokens: 10 }); expect(service.requests()).toBe(2);
    expect(execute).toHaveBeenCalledWith({ id: 'support' }); expect(execute).toHaveBeenCalledTimes(protocol === 'gemini' ? 6 : 1);
    expect(captured.mock.calls[0][0]).toMatchObject({ text: '', incomplete: false, diagnostics: { transport: 'http' } });
    expect(captured.mock.calls[0][0].diagnostics.elapsedMs).toBeGreaterThan(deadlineMs);
  });

  it.each(protocols)('%s refreshes on other body content including heartbeat frames', async protocol => {
    const service = await upstream(response => flowing(response, [...Array.from({ length: 6 }, (_, index) => `: heartbeat ${index}\n\n${event({ type: 'fixture_metadata', sequence: index })}`), finish(protocol)]));
    expect((await generateText(config(protocol, service.url), request)).text).toBe('完成正文。'); expect(service.requests()).toBe(1);
  });

  it.each(protocols)('%s preserves prose, thought events and billed usage after a content gap', async protocol => {
    const captured = vi.fn(); const activities: ModelActivityEvent[] = []; const deltas: string[] = [];
    const service = await upstream(response => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(partialFrames(protocol)); });
    await expect(generateText(config(protocol, service.url), { ...request, onResponse: captured, onActivity: value => activities.push(value), onTextDelta: value => deltas.push(value) })).rejects.toMatchObject({ name: 'ModelOutputError', message: expect.stringContaining('流式响应空闲超时（1 秒）'), inputTokens: 8, outputTokens: 5 });
    expect(deltas.join('')).toBe('中断前正文。'); expect(activities.some(value => value.type === 'thinking' && value.text === '中断前思考。')).toBe(true);
    expect(captured).toHaveBeenCalledTimes(1); expect(service.requests()).toBe(1);
    expect(captured.mock.calls[0][0]).toMatchObject({ text: '中断前正文。', incomplete: true, inputTokens: 8, outputTokens: 5, diagnostics: { transport: 'timeout' } });
    expect(captured.mock.calls[0][0].rawResponse).toContain('中断前思考');
  });

  it.each(protocols)('%s respects explicit cancellation instead of reporting a stream timeout', async protocol => {
    const captured = vi.fn(); const controller = new AbortController();
    const service = await upstream(response => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(partialFrames(protocol)); });
    await expect(generateText(config(protocol, service.url), { ...request, signal: controller.signal, onTextDelta: () => controller.abort(), onResponse: captured })).rejects.toMatchObject({ name: 'ModelOutputError', message: expect.stringContaining('已取消'), inputTokens: 8, outputTokens: 5 });
    expect(captured).toHaveBeenCalledTimes(1); expect(service.requests()).toBe(1);
    expect(captured.mock.calls[0][0]).toMatchObject({ text: '中断前正文。', incomplete: true, diagnostics: { transport: 'cancelled' } });
  });

  it('retains the total request deadline for a non-streaming JSON response despite incoming chunks', async () => {
    const captured = vi.fn();
    const service = await upstream(response => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const frames = ['{"choices":[{"message":{"content":"', '第一段', '第二段', '第三段', '第四段', '第五段', '"},"finish_reason":"stop"}]}'];
      let index = 0; let timer: ReturnType<typeof setTimeout> | undefined;
      const send = () => { if (response.destroyed) return; response.write(frames[index++]); if (index === frames.length) response.end(); else timer = setTimeout(send, gapMs); };
      response.on('close', () => clearTimeout(timer)); send();
    });
    await expect(generateText({ ...config('openai-chat', service.url), stream: false }, { ...request, onResponse: captured })).rejects.toThrow('模型请求超时（1 秒）');
    expect(service.requests()).toBe(1); expect(captured.mock.calls[0][0]).toMatchObject({ incomplete: true, diagnostics: { transport: 'timeout' }, request: { stream: false } });
    expect(captured.mock.calls[0][0].rawResponse).toContain('第一段'); expect(captured.mock.calls[0][0].rawResponse).not.toContain('第五段');
  });
});
