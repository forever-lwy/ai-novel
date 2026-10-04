import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { ModelRequest, ModelTool, ProviderConfig, ProviderProtocol } from '../shared/types.js';
import { estimateModelRequestInputTokens, generateText, ModelOutputError } from '../server/providers.js';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const config = (protocol: ProviderProtocol, baseUrl: string): ProviderConfig => ({ id: 'local', name: '本地协议测试', protocol, baseUrl, model: 'writer', maxOutputTokens: 1000, contextTokens: 64000, stream: false, timeoutMs: 1000 });

async function upstream(reply: (body: any, response: ServerResponse, index: number) => Promise<void> | void) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    await reply(body, response, bodies.length - 1);
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { bodies, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
}

function toolRound(protocol: ProviderProtocol): string {
  if (protocol === 'openai-chat') return sse({ choices: [{ index: 0, delta: { reasoning_content: '内部思考', tool_calls: [{ index: 0, id: 'lookup-1', type: 'function', function: { name: 'read_entity', arguments: '{"id":' } }] } }] }) + sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"support"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + sse('[DONE]');
  if (protocol === 'openai-responses') return sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item-1', call_id: 'lookup-1', name: 'read_entity', arguments: '' } }) + sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item-1', delta: '{"id":"support"}' }) + sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'reasoning-1', encrypted_content: 'reasoning-signature' }, { type: 'function_call', id: 'item-1', call_id: 'lookup-1', name: 'read_entity', arguments: '{"id":"support"}' }], usage: { input_tokens: 10, output_tokens: 2 } } });
  if (protocol === 'gemini') return sse({ candidates: [{ index: 0, content: { parts: [{ text: '内部思考', thought: true }, { functionCall: { id: 'lookup-1', name: 'read_entity', args: { id: 'support' } }, thoughtSignature: 'reasoning-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } });
  return sse({ type: 'message_start', message: { content: [], usage: { input_tokens: 10 } } }) + sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '内部思考' } }) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'reasoning-signature' } }) + sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'lookup-1', name: 'read_entity', input: {} } }) + sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"id":"support"}' } }) + sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }) + sse({ type: 'message_stop' });
}
function prose(protocol: ProviderProtocol, text: string, finished = false): string {
  if (protocol === 'openai-chat') return sse({ choices: [{ index: 0, delta: { content: text }, ...(finished ? { finish_reason: 'stop' } : {}) }], ...(finished ? { usage: { prompt_tokens: 11, completion_tokens: 4 } } : {}) }) + (finished ? sse('[DONE]') : '');
  if (protocol === 'openai-responses') return sse({ type: 'response.output_text.delta', delta: text }) + (finished ? sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '阿青走向港口。' }] }], usage: { input_tokens: 11, output_tokens: 4 } } }) : '');
  if (protocol === 'gemini') return sse({ candidates: [{ index: 0, content: { parts: [{ text }] }, ...(finished ? { finishReason: 'STOP' } : {}) }], ...(finished ? { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 } } : {}) });
  return (finished ? '' : sse({ type: 'message_start', message: { content: [], usage: { input_tokens: 11 } } }) + sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) + (finished ? sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }) + sse({ type: 'message_stop' }) : '');
}
const request = (execute: ModelTool['execute']): ModelRequest => ({ system: '只输出小说正文，需要资料时使用工具。', prompt: '写下一章。', tools: [{ name: 'read_entity', description: '查询完整人物档案', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, execute }] });

describe('real provider tool continuations with visible streaming', () => {
  it.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('%s sends lookup results back, preserves signatures, and emits prose before generation ends', async protocol => {
    const firstVisible = deferred(); const finish = deferred(); const onRequest = vi.fn(); const onResponse = vi.fn(); const deltas: string[] = [];
    const execute = vi.fn(() => ({ name: '老吴', ability: '航海' }));
    const service = await upstream(async (_body, response, index) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (index === 0) { response.end(toolRound(protocol)); return; }
      response.write(prose(protocol, '阿青走向')); await finish.promise; response.end(prose(protocol, '港口。', true));
    });
    let completed = false;
    const result = generateText(config(protocol, service.baseUrl), { ...request(execute), onRequest, onResponse, onTextDelta: delta => { deltas.push(delta); firstVisible.resolve(); } }).then(value => { completed = true; return value; });
    await firstVisible.promise;
    expect(completed).toBe(false); expect(deltas).toEqual(['阿青走向']); expect(execute).toHaveBeenCalledWith({ id: 'support' });
    finish.resolve();
    expect(await result).toEqual({ text: '阿青走向港口。', inputTokens: 21, outputTokens: 6 });
    expect(deltas.join('')).toBe('阿青走向港口。'); expect(onRequest).toHaveBeenCalledTimes(2); expect(onResponse).toHaveBeenCalledTimes(2);
    expect(onResponse.mock.calls[0][0]).toMatchObject({ text: '', incomplete: false, diagnostics: { modelOutcome: 'completed' } });
    for (const call of onRequest.mock.calls) expect(call[0].stream).toBe(true);
    const first = service.bodies[0], second = service.bodies[1];
    expect(JSON.stringify(second)).toContain('航海'); expect(JSON.stringify(first)).not.toContain('航海');
    if (protocol === 'openai-chat') { expect(second.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'lookup-1' }); expect(second.messages.at(-2).reasoning_content).toBe('内部思考'); expect(second.max_tokens).toBe(1000); }
    else if (protocol === 'openai-responses') { expect(second.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'lookup-1' }); expect(JSON.stringify(second)).toContain('reasoning-signature'); expect(second.max_output_tokens).toBe(1000); }
    else if (protocol === 'gemini') { expect(second.contents.at(-1).parts[0].functionResponse).toMatchObject({ name: 'read_entity', id: 'lookup-1' }); expect(JSON.stringify(second)).toContain('reasoning-signature'); expect(second.generationConfig.maxOutputTokens).toBe(1000); }
    else { expect(second.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'lookup-1' }); expect(JSON.stringify(second)).toContain('reasoning-signature'); expect(second.max_tokens).toBe(1000); }
  });

  it('rejects growing retrieved context before a second billable request without reducing configured output tokens', async () => {
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(toolRound('openai-chat')); });
    const model = { ...config('openai-chat', service.baseUrl), contextTokens: 4000 };
    await expect(generateText(model, { ...request(() => ({ text: '海'.repeat(10000) })), onTextDelta: () => {} })).rejects.toMatchObject({ name: 'ModelOutputError', inputTokens: 10, outputTokens: 2, message: expect.stringContaining('超过') });
    expect(service.bodies).toHaveLength(1); expect(service.bodies[0].max_tokens).toBe(1000);
  });

  it('preserves visible prose from an ordinary JSON tool turn even when its continuation fails', async () => {
    const deltas: string[] = [];
    const execute = vi.fn(() => ({ name: '老吴' }));
    const service = await upstream((_body, response, index) => {
      if (index === 0) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '旅人停在桥边。', tool_calls: [{ id: 'lookup-1', type: 'function', function: { name: 'read_entity', arguments: '{"id":"support"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
      } else { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'fixture unavailable' } })); }
    });
    await expect(generateText(config('openai-chat', service.baseUrl), { ...request(execute), onTextDelta: text => deltas.push(text) })).rejects.toMatchObject({ inputTokens: 10, outputTokens: 2, message: expect.stringContaining('HTTP 503') });
    expect(deltas).toEqual(['旅人停在桥边。']); expect(execute).toHaveBeenCalledWith({ id: 'support' }); expect(service.bodies).toHaveLength(2);
  });

  it('includes tool schemas in first-round context estimates and makes no request when they do not fit', async () => {
    const service = await upstream((_body, response) => response.end());
    const incoming = request(() => ({})); incoming.tools![0].description = '工具说明'.repeat(1000);
    const model = { ...config('openai-chat', service.baseUrl), contextTokens: 4000 };
    expect(estimateModelRequestInputTokens(model, incoming)).toBeGreaterThan(4000);
    await expect(generateText(model, incoming)).rejects.toThrow('上下文'); expect(service.bodies).toEqual([]);
  });

  it('limits repeated lookups and preserves billed usage without retrying failures', async () => {
    const execute = vi.fn(() => ({}));
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(toolRound('openai-chat')); });
    const failure = await generateText(config('openai-chat', service.baseUrl), { ...request(execute), onTextDelta: () => {} }).catch(error => error);
    expect(failure).toBeInstanceOf(ModelOutputError); expect(failure).toMatchObject({ inputTokens: 60, outputTokens: 12, message: expect.stringContaining('检索次数') });
    expect(service.bodies).toHaveLength(6); expect(execute).toHaveBeenCalledTimes(5);
  });
});
