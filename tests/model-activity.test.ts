import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { generateText } from '../server/providers.js';
import type { ModelActivityEvent, ModelRequest, ProviderConfig, ProviderProtocol } from '../shared/types.js';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const apiKey = 'configured-secret-DO-NOT-PUBLISH';
const thought = '核对资料。'; const prose = '旅人来到桥边。'; const opaque = 'opaque-signature-DO-NOT-PUBLISH';
const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const config = (protocol: ProviderProtocol, baseUrl: string, stream: boolean): ProviderConfig => ({ id: 'local', name: '中性协议模拟', protocol, baseUrl, model: 'fixture', apiKey, maxOutputTokens: 1000, contextTokens: 64000, stream, timeoutMs: 1000 });
async function upstream(reply: (body: any, response: ServerResponse, index: number) => void | Promise<void>) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); await reply(body, response, bodies.length - 1); });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { bodies, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
}
function envelope(protocol: ProviderProtocol, text = thought) {
  if (protocol === 'openai-chat') return { choices: [{ message: { reasoning_content: text, reasoning: '镜像字段不能重复显示', content: prose }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'reasoning', id: 'reasoning-1', summary: [{ type: 'summary_text', text }], encrypted_content: opaque }, { type: 'message', content: [{ type: 'output_text', text: prose }] }], usage: { input_tokens: 10, output_tokens: 5 } };
  if (protocol === 'gemini') return { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text, thoughtSignature: opaque }, { thoughtSignature: opaque }, { text: prose }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
  return { type: 'message', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: text, signature: opaque }, { type: 'redacted_thinking', data: opaque, thinking: opaque }, { type: 'text', text: prose }], usage: { input_tokens: 10, output_tokens: 5 } };
}
function stream(protocol: ProviderProtocol) {
  if (protocol === 'openai-chat') return sse({ choices: [{ index: 0, delta: { reasoning_content: '核对' } }] }) + sse({ choices: [{ index: 0, delta: { reasoning: '资料。' } }] }) + sse({ choices: [{ delta: { content: prose }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + sse('[DONE]');
  if (protocol === 'openai-responses') return sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'reasoning-1', summary: [], encrypted_content: opaque } }) + sse({ type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-1', output_index: 0, summary_index: 0, delta: '核对' }) + sse({ type: 'response.reasoning_summary_text.delta', item_id: 'reasoning-1', output_index: 0, summary_index: 0, delta: '资料。' }) + sse({ type: 'response.reasoning_summary_text.done', item_id: 'reasoning-1', output_index: 0, summary_index: 0, text: thought }) + sse({ type: 'response.output_item.done', output_index: 0, item: envelope(protocol).output![0] }) + sse({ type: 'response.output_text.delta', delta: prose }) + sse({ type: 'response.completed', response: envelope(protocol) });
  if (protocol === 'gemini') return sse({ candidates: [{ index: 0, content: { parts: [{ thought: true, text: '核对', thoughtSignature: opaque }] } }] }) + sse({ candidates: [{ index: 0, content: { parts: [{ thought: true, text: '资料。' }, { thoughtSignature: opaque }] } }] }) + sse({ candidates: [{ index: 0, content: { parts: [{ text: prose }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
  return sse({ type: 'message_start', message: { content: [], usage: { input_tokens: 10 } } }) + sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '核对' } }) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: opaque } }) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '资料。' } }) + sse({ type: 'content_block_stop', index: 0 }) + sse({ type: 'content_block_start', index: 9, content_block: { type: 'redacted_thinking', data: opaque } }) + sse({ type: 'content_block_delta', index: 9, delta: { type: 'thinking_delta', thinking: opaque } }) + sse({ type: 'content_block_stop', index: 9 }) + sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) + sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: prose } }) + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) + sse({ type: 'message_stop' });
}
const protocols: ProviderProtocol[] = ['openai-chat', 'openai-responses', 'gemini', 'claude'];
const thinkingText = (events: ModelActivityEvent[]) => events.filter((event): event is Extract<ModelActivityEvent, { type: 'thinking' }> => event.type === 'thinking').map(event => event.text).join('');

describe('public author model activity separated from novel prose', () => {
  it.each(protocols.flatMap(protocol => [false, true].map(streaming => ({ protocol, streaming }))))('$protocol streaming=$streaming exposes public thought text once while keeping signatures and thoughts out of prose', async ({ protocol, streaming }) => {
    const events: ModelActivityEvent[] = []; const deltas: string[] = [];
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' }); response.end(streaming ? stream(protocol) : JSON.stringify(envelope(protocol))); });
    const result = await generateText(config(protocol, service.baseUrl, streaming), { system: '中性写作模拟', prompt: '继续正文', onTextDelta: text => deltas.push(text), onActivity: event => events.push(event) });
    expect(result.text).toBe(prose); expect(deltas.join('')).toBe(prose); expect(thinkingText(events)).toBe(thought);
    const blocks = events.filter(event => event.type === 'thinking'); expect(new Set(blocks.map(event => event.id)).size).toBe(1);
    expect(events.filter(event => event.type === 'thinking_done')).toEqual([{ type: 'thinking_done', id: blocks[0].id }]);
    expect(JSON.stringify(events)).not.toContain(opaque); expect(JSON.stringify(events)).not.toContain(apiKey); expect(JSON.stringify(events)).not.toContain('镜像字段');
    if (protocol === 'gemini') expect(service.bodies[0].generationConfig.thinkingConfig).toBeUndefined();
    if (protocol === 'claude') expect(service.bodies[0].thinking).toBeUndefined();
  });

  it('onActivity alone does not change stream or model thinking parameters', async () => {
    const events: ModelActivityEvent[] = [];
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(envelope('gemini'))); });
    await generateText({ ...config('gemini', service.baseUrl, false), geminiThinking: { mode: 'level', level: 'low' }, geminiIncludeThoughts: false }, { system: '中性测试', prompt: '正文', onActivity: event => events.push(event) });
    expect(service.bodies[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low', includeThoughts: false }); expect(thinkingText(events)).toBe(thought);
  });

  it('reports tool calls before execution and results after execution, redacts nested fields, and scopes reused ids by round', async () => {
    const events: ModelActivityEvent[] = []; const timeline: string[] = [];
    const execute = vi.fn((args: Record<string, unknown>) => { timeline.push('execute'); expect(args.api_key).toBe('unknown-argument-secret'); return { name: '老吴', Authorization: 'unknown-result-secret', nested: { password: 'nested-result-secret' } }; });
    const service = await upstream((_body, response, index) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(index < 2 ? { choices: [{ message: { reasoning_content: `公开思考${index}`, content: '', tool_calls: [{ id: 'reused-call', type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ query: '老吴', api_key: 'unknown-argument-secret', nested: { token: 'nested-argument-secret' } }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } } : envelope('openai-chat')));
    });
    await generateText(config('openai-chat', service.baseUrl, false), { system: '中性测试', prompt: '查询资料后续写', tools: [{ name: 'lookup', description: '查询资料', parameters: { type: 'object' }, execute }], onActivity: event => { events.push(event); if (event.type === 'tool_call' || event.type === 'tool_result') timeline.push(event.type); } });
    expect(timeline).toEqual(['tool_call', 'execute', 'tool_result', 'tool_call', 'execute', 'tool_result']);
    const calls = events.filter(event => event.type === 'tool_call'); const results = events.filter(event => event.type === 'tool_result');
    expect(calls).toHaveLength(2); expect(calls[0].id).not.toBe(calls[1].id); expect(results.map(event => event.id)).toEqual(calls.map(event => event.id));
    expect(calls[0]).toMatchObject({ arguments: { query: '老吴', api_key: '[REDACTED]', nested: { token: '[REDACTED]' } } });
    expect(results[0]).toMatchObject({ result: { name: '老吴', Authorization: '[REDACTED]', nested: { password: '[REDACTED]' } } });
    expect(new Set(events.filter(event => event.type === 'thinking_done').map(event => event.id)).size).toBe(3);
    expect(JSON.stringify(events)).not.toContain('unknown-argument-secret'); expect(JSON.stringify(events)).not.toContain('unknown-result-secret');
  });

  it('emits a redacted failed tool result without retrying the tool or continuing the model', async () => {
    const events: ModelActivityEvent[] = [];
    const execute = vi.fn(() => { throw new Error(`资料查询失败 {"api_key":"unknown-error-secret","detail":"${apiKey}"}`); });
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'failed-call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); });
    await expect(generateText(config('openai-chat', service.baseUrl, false), { system: '中性测试', prompt: '查询资料', tools: [{ name: 'lookup', description: '查询资料', parameters: { type: 'object' }, execute }], onActivity: event => events.push(event) })).rejects.toThrow('资料查询失败');
    expect(execute).toHaveBeenCalledTimes(1); expect(service.bodies).toHaveLength(1); expect(events.map(event => event.type)).toEqual(['tool_call', 'tool_result']);
    expect(events[1]).toMatchObject({ error: expect.stringContaining('[REDACTED]') }); expect(JSON.stringify(events)).not.toContain('unknown-error-secret'); expect(JSON.stringify(events)).not.toContain(apiKey);
  });

  it('reports an error-valued lookup as failed while returning its result to the model for a normal continuation', async () => {
    const events: ModelActivityEvent[] = [];
    const service = await upstream((_body, response, index) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(index === 0 ? { choices: [{ message: { tool_calls: [{ id: 'missing-call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] } : envelope('openai-chat'))); });
    const result = await generateText(config('openai-chat', service.baseUrl, false), { system: '中性测试', prompt: '正文', tools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' }, execute: () => ({ error: '未找到此资料' }) }], onActivity: event => events.push(event) });
    expect(result.text).toBe(prose); expect(service.bodies).toHaveLength(2);
    expect(events.find(event => event.type === 'tool_result')).toMatchObject({ result: { error: '未找到此资料' }, error: '未找到此资料' });
    expect(service.bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', content: JSON.stringify({ error: '未找到此资料' }) });
  });

  it('redacts a known key split over thinking deltas and credential fields inside thought JSON', async () => {
    const events: ModelActivityEvent[] = [];
    const service = await upstream((_body, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const values = ['检查 ', apiKey.slice(0, 12), apiKey.slice(12), '。', '{"api_key":"', 'unknown-thought-secret', '","nested":{"password":"nested-thought-secret"}}'];
      response.end(values.map(text => sse({ choices: [{ delta: { reasoning_content: text } }] })).join('') + sse({ choices: [{ delta: { content: prose }, finish_reason: 'stop' }] }) + sse('[DONE]'));
    });
    await generateText(config('openai-chat', service.baseUrl, true), { system: '中性测试', prompt: '正文', onActivity: event => events.push(event) });
    expect(thinkingText(events)).toContain('[REDACTED]');
    const serialized = JSON.stringify(events); expect(serialized).not.toContain(apiKey); expect(serialized).not.toContain('unknown-thought-secret'); expect(serialized).not.toContain('nested-thought-secret');
  });

  it('shows a thinking delta before completion and leaves the block unfinished when cancelled', async () => {
    const controller = new AbortController(); const events: ModelActivityEvent[] = []; const capture = vi.fn();
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(sse({ choices: [{ delta: { reasoning_content: '已经返回的公开思考' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); });
    await expect(generateText(config('openai-chat', service.baseUrl, true), { system: '中性测试', prompt: '正文', signal: controller.signal, onResponse: capture, onActivity: event => { events.push(event); if (event.type === 'thinking') controller.abort(); } })).rejects.toMatchObject({ message: expect.stringContaining('已取消'), inputTokens: 10, outputTokens: 5 });
    expect(thinkingText(events)).toBe('已经返回的公开思考'); expect(events.filter(event => event.type === 'thinking_done')).toHaveLength(0); expect(capture).toHaveBeenCalledTimes(1); expect(capture.mock.calls[0][0].rawResponse).toContain('公开思考');
  });

  it('does not invoke a late completion callback on a cancelled job and retains partial raw bytes', async () => {
    const controller = new AbortController(); const capture = vi.fn();
    const onActivity = vi.fn((event: ModelActivityEvent) => { if (event.type === 'thinking') controller.abort(); else if (controller.signal.aborted) throw new DOMException('任务已停止', 'AbortError'); });
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(sse({ choices: [{ delta: { reasoning_content: '已经返回的公开思考' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); });
    await expect(generateText(config('openai-chat', service.baseUrl, true), { system: '中性测试', prompt: '正文', signal: controller.signal, onResponse: capture, onActivity })).rejects.toMatchObject({ message: expect.stringContaining('已取消'), inputTokens: 10, outputTokens: 5 });
    expect(onActivity.mock.calls.map(call => call[0].type)).toEqual(['thinking']);
    expect(capture).toHaveBeenCalledTimes(1); expect(capture.mock.calls[0][0]).toMatchObject({ rawResponse: expect.stringContaining('已经返回的公开思考'), diagnostics: { transport: 'cancelled' } });
  });

  it('keeps a pure thinking block unfinished when the SSE socket closes without any provider end marker', async () => {
    const events: ModelActivityEvent[] = []; const capture = vi.fn();
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(sse({ choices: [{ delta: { reasoning_content: '仅收到的一段公开思考' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); });
    await expect(generateText(config('openai-chat', service.baseUrl, true), { system: '中性测试', prompt: '正文', onResponse: capture, onActivity: event => events.push(event) })).rejects.toMatchObject({ message: expect.stringContaining('结束标记'), inputTokens: 10, outputTokens: 5 });
    expect(thinkingText(events)).toBe('仅收到的一段公开思考'); expect(events.map(event => event.type)).toEqual(['thinking']);
    expect(capture.mock.calls[0][0]).toMatchObject({ rawResponse: expect.stringContaining('仅收到的一段公开思考'), incomplete: true });
  });

  it('fails when activity persistence throws without discarding already received provider bytes', async () => {
    const capture = vi.fn();
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(stream('openai-chat')); });
    await expect(generateText(config('openai-chat', service.baseUrl, true), { system: '中性测试', prompt: '正文', onResponse: capture, onActivity: () => { throw new Error('模拟过程记录存储失败'); } })).rejects.toThrow('响应中断');
    expect(capture).toHaveBeenCalledTimes(1); expect(capture.mock.calls[0][0].rawResponse).toContain('核对'); expect(service.bodies).toHaveLength(1);
  });

  it('cancellation during a tool ends its activity and prevents any continuation', async () => {
    const controller = new AbortController(); const events: ModelActivityEvent[] = [];
    const execute = vi.fn(() => { controller.abort(); return { name: '老吴' }; });
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'cancel-call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); });
    await expect(generateText(config('openai-chat', service.baseUrl, false), { system: '中性测试', prompt: '正文', signal: controller.signal, tools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' }, execute }], onActivity: event => events.push(event) })).rejects.toThrow('已取消');
    expect(events.map(event => event.type)).toEqual(['tool_call', 'tool_result']); expect(events[1]).toMatchObject({ error: expect.stringContaining('已取消') }); expect(service.bodies).toHaveLength(1);
  });
});
