import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateStructured, generateText, MODEL_TIMEOUT_MS, ModelOutputError, parseStructuredText, redactModelPayload, unwrapModelOutput } from '../server/providers.js';
import type { CapturedModelResponse, ProviderConfig, ProviderProtocol } from '../shared/types.js';

const servers: Server[] = [];
const requests: { url: string; headers: IncomingMessage['headers']; body: any }[] = [];
const secret = 'test-only-never-print-this-key';
const request = { system: '请写小说。', prompt: '让林舟进入古城。' };

async function service(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const server = createServer(async (req, res) => {
    // Each fixture owns an ephemeral port for one test. Do not leave pooled
    // keep-alive connections pointing at a server that afterEach will destroy.
    res.setHeader('Connection', 'close');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    requests.push({ url: req.url!, headers: req.headers, body });
    handler(req, res, body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${addr.port}`;
}
function config(protocol: ProviderProtocol, baseUrl: string): ProviderConfig {
  return { id: 'test', name: 'test', protocol, baseUrl, model: 'example-model', apiKey: secret, maxOutputTokens: 1234, contextTokens: 32_000 };
}
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  requests.length = 0;
});

describe('captured model output before validation', () => {
  const envelopes: [ProviderProtocol, Record<string, unknown>][] = [
    ['openai-chat', { choices: [{ finish_reason: 'length', message: { content: '{"summary":"未完' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }],
    ['openai-responses', { status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"summary":"未完' }] }], usage: { input_tokens: 11, output_tokens: 7 } }],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ thought: true, text: '不要作为正文' }, { text: '{"summary":"未完' }] } }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } }],
    ['claude', { type: 'message', stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '不要作为正文' }, { type: 'text', text: '{"summary":"未完' }], usage: { input_tokens: 11, output_tokens: 7 } }],
  ];

  it.each(envelopes)('captures %s text and usage exactly once before rejecting truncation', async (protocol, envelope) => {
    const captured = vi.fn();
    const url = await service((_req, res) => json(res, envelope));
    await expect(generateText(config(protocol, url), { ...request, onResponse: captured })).rejects.toBeInstanceOf(ModelOutputError);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0][0]).toMatchObject({ rawResponse: JSON.stringify(envelope), text: '{"summary":"未完', inputTokens: 11, outputTokens: 7, httpStatus: 200, incomplete: true });
    expect(captured.mock.calls[0][0].diagnostics.modelOutcome).toBe('truncated');
    expect(requests).toHaveLength(1);
  });

  it('captures valid output before schema validation and retains field-level issues', async () => {
    const order: string[] = [];
    const captured: CapturedModelResponse[] = [];
    const body = { summary: '草稿已收到', entities: [{ name: 123 }] };
    const schema = z.object({ summary: z.string(), entities: z.array(z.object({ name: z.string() })) });
    const url = await service((_req, res) => json(res, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(body) }] } }], usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 9 } }));
    const result = await generateStructured(config('gemini', url), { ...request, onResponse: value => { order.push('capture'); captured.push(value); } }, value => { order.push('validate'); return schema.parse(value); }).catch(error => error);
    expect(result).toBeInstanceOf(ModelOutputError);
    expect(result).toMatchObject({ inputTokens: 13, outputTokens: 9, issues: [{ path: 'entities.0.name', message: expect.stringContaining('string') }] });
    expect(result.message).not.toContain('草稿已收到');
    expect(order).toEqual(['capture', 'validate']);
    expect(captured).toHaveLength(1);
    expect(captured[0].text).toBe(JSON.stringify(body));
    expect(captured[0].diagnostics).toMatchObject({ modelOutcome: 'completed', finishReason: 'STOP' });
  });

  it('captures malformed service JSON and redacts known keys and credential assignments', async () => {
    const captured = vi.fn();
    const url = await service((_req, res) => { res.end(`{"Authorization":"Bearer other-token","message":"${secret}","broken":`); });
    await expect(generateText(config('openai-chat', url), { ...request, onResponse: captured })).rejects.toThrow('有效 JSON');
    expect(captured).toHaveBeenCalledTimes(1);
    const result = captured.mock.calls[0][0] as CapturedModelResponse;
    expect(result.rawResponse).toContain('"broken":');
    expect(result.rawResponse).not.toContain(secret);
    expect(result.rawResponse).not.toContain('other-token');
    expect(result.rawResponse).toContain('[REDACTED]');
    expect(result.text).toBe('');
  });

  it('captures HTTP errors and masks credential fields inside provider text and metadata', async () => {
    const captured = vi.fn();
    const url = await service((_req, res) => json(res, {
      error: { message: `failed ${secret}`, access_token: 'other-access', headers: { Authorization: 'Bearer other-auth' } },
      choices: [{ message: { content: JSON.stringify({ api_key: 'nested-key', summary: `saved ${secret}`, item: { client_secret: 'nested-secret' } }) } }],
    }, 500));
    const failure = await generateText(config('openai-chat', url), { ...request, onResponse: captured }).catch(error => error);
    expect(failure.message).toContain('HTTP 500');
    expect(captured).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(captured.mock.calls[0][0]);
    for (const credential of [secret, 'other-access', 'other-auth', 'nested-key', 'nested-secret']) expect(output).not.toContain(credential);
    expect(captured.mock.calls[0][0]).toMatchObject({ httpStatus: 500, incomplete: false });
    expect(failure.message).not.toContain('failed');
  });

  it('captures bytes received before a real HTTP response is interrupted', async () => {
    const captured = vi.fn();
    const url = await service((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 5000 });
      res.write(`{"message":"partial ${secret}","api_key":"unfinished-other-secret`);
      setTimeout(() => res.destroy(), 50);
    });
    await expect(generateText(config('openai-chat', url), { ...request, onResponse: captured })).rejects.toThrow('响应中断');
    expect(captured).toHaveBeenCalledTimes(1);
    const result = captured.mock.calls[0][0] as CapturedModelResponse;
    expect(result.incomplete).toBe(true);
    expect(result.rawResponse).toContain('partial');
    expect(result.rawResponse).not.toContain(secret);
    expect(result.rawResponse).not.toContain('unfinished-other-secret');
  });

  it('keeps up to 16 MiB when a response exceeds the limit instead of dropping it', async () => {
    const captured = vi.fn();
    const url = await service((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('x'.repeat(16 * 1024 * 1024 + 64)); });
    await expect(generateText(config('openai-chat', url), { ...request, onResponse: captured })).rejects.toThrow('16 MiB');
    expect(captured).toHaveBeenCalledTimes(1);
    const result = captured.mock.calls[0][0] as CapturedModelResponse;
    expect(result.incomplete).toBe(true);
    expect(Buffer.byteLength(result.rawResponse)).toBe(16 * 1024 * 1024);
  });

  it('captures received text before user cancellation interrupts the response body', async () => {
    const captured = vi.fn(); const controller = new AbortController();
    const url = await service((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"partial":"已收到的内容');
      setTimeout(() => controller.abort(), 50);
    });
    await expect(generateText(config('openai-chat', url), { ...request, signal: controller.signal, onResponse: captured })).rejects.toThrow('已取消');
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0][0]).toMatchObject({ rawResponse: '{"partial":"已收到的内容', incomplete: true });
  });

  it('redacts escaped configured keys and credential objects without exposing request fields', async () => {
    const escapedKey = 'secret-A'; const captured = vi.fn();
    const url = await service((_req, res) => res.end('{"api_key":{"value":"unknown-secret-object"},"echo":"secret-\\u0041","choices":[{"message":{"content":"正文"},"finish_reason":"stop"}]}'));
    expect(await generateText({ ...config('openai-chat', url), apiKey: escapedKey }, { ...request, onResponse: captured })).toMatchObject({ text: '正文' });
    const saved = captured.mock.calls[0][0] as CapturedModelResponse;
    expect(saved.rawResponse).not.toContain(escapedKey);
    expect(saved.rawResponse).not.toContain('unknown-secret-object');
    expect(JSON.parse(saved.rawResponse)).toMatchObject({ api_key: '[REDACTED]', echo: '[REDACTED]' });
    expect(saved).not.toHaveProperty('prompt');
    expect(saved).not.toHaveProperty('headers');
  });

  it('records empty-body diagnostics without inventing output and never exposes callback errors', async () => {
    const captured = vi.fn();
    const emptyUrl = await service((_req, res) => { res.writeHead(204); res.end(); });
    await expect(generateText(config('openai-chat', emptyUrl), { ...request, onResponse: captured })).rejects.toThrow('有效 JSON');
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0][0]).toMatchObject({ rawResponse: '', text: '', httpStatus: 204, diagnostics: { responseBytes: 0, transport: 'http' } });
    const goodUrl = await service((_req, res) => json(res, { choices: [{ message: { content: '正文' }, finish_reason: 'stop' }] }));
    const result = await generateText(config('openai-chat', goodUrl), { ...request, onResponse: () => { throw new Error(secret); } }).catch(error => error);
    expect(result.message).toContain('保存原始输出失败');
    expect(result.message).not.toContain(secret);
  });

  it('captures schema-invalid text without another network request', async () => {
    const captured = vi.fn();
    const url = await service((_req, res) => json(res, { choices: [{ message: { content: '{"summary":' }, finish_reason: 'stop' }] }));
    await expect(generateStructured(config('openai-chat', url), { ...request, onResponse: captured }, value => value)).rejects.toMatchObject({ issues: [{ path: '$', message: expect.any(String) }] });
    expect(captured.mock.calls[0][0].text).toBe('{"summary":');
    expect(requests).toHaveLength(1);
  });
});

const sse = (value: unknown, name?: string) => `${name ? `event: ${name}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;

describe('streaming adapters and transport diagnostics', () => {
  const fixtures: [ProviderProtocol, string, string, number, number][] = [
    ['openai-chat', sse({ choices: [{ index: 0, delta: { content: '风吹' } }] }) + sse({ choices: [{ index: 0, delta: { content: '古城。' }, finish_reason: 'stop' }] }) + sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }) + sse('[DONE]'), '/chat/completions', 11, 7],
    ['openai-responses', sse({ type: 'response.output_text.delta', delta: '风吹' }) + sse({ type: 'response.output_text.delta', delta: '古城。' }) + sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '风吹古城。' }] }], usage: { input_tokens: 11, output_tokens: 7 } } }), '/responses', 11, 7],
    ['gemini', sse({ candidates: [{ index: 0, content: { parts: [{ thought: true, text: '不写入正文' }, { text: '风吹' }] } }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 2, thoughtsTokenCount: 3 } }) + sse({ candidates: [{ index: 0, content: { parts: [{ text: '古城。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 3 } }), '/models/example-model:streamGenerateContent?alt=sse', 11, 10],
    ['claude', sse({ type: 'message_start', message: { content: [], usage: { input_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } } }, 'message_start') + sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '不写入正文' } }) + sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) + sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '风吹' } }) + sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '古城。' } }) + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) + sse({ type: 'message_stop' }), '/messages', 11, 7],
  ];
  it.each(fixtures)('assembles %s events and finishes without waiting for socket close', async (protocol, events, suffix, inputTokens, outputTokens) => {
    const onResponse = vi.fn(); const onRequest = vi.fn();
    const url = await service((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'fixture-request', 'set-cookie': 'fixture-cookie', 'cf-access-jwt-assertion': 'fixture-header-jwt' }); res.write(events); });
    const result = await generateText({ ...config(protocol, url), stream: true, timeoutMs: 1000 }, { ...request, onRequest, onResponse });
    expect(result).toEqual({ text: '风吹古城。', inputTokens, outputTokens });
    expect(requests).toHaveLength(1); expect(requests[0].url).toBe(suffix);
    if (protocol !== 'gemini') expect(requests[0].body.stream).toBe(true);
    if (protocol === 'openai-chat') expect(requests[0].body.stream_options).toEqual({ include_usage: true });
    expect(onRequest).toHaveBeenCalledTimes(1); expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0][0]).toMatchObject({ text: '风吹古城。', incomplete: false, request: { stream: true, timeoutMs: 1000 }, diagnostics: { transport: 'http', responseBytes: Buffer.byteLength(events), responseHeaders: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' } } });
    const saved = JSON.stringify(onResponse.mock.calls[0][0]);
    expect(saved).not.toContain(secret); expect(saved).not.toContain('fixture-cookie'); expect(saved).not.toContain('fixture-header-jwt');
  });
  it('handles UTF-8 split inside a character, CRLF frames, comments, and multiline data', async () => {
    const events = ': heartbeat\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"风吹古城。"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = Buffer.from(events); const first = bytes.indexOf(Buffer.from('风'));
    const url = await service((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(bytes.subarray(0, first + 1));
      setTimeout(() => { res.write(bytes.subarray(first + 1, first + 2)); setTimeout(() => res.end(bytes.subarray(first + 2)), 5); }, 5);
    });
    expect((await generateText({ ...config('openai-chat', url), stream: true }, request)).text).toBe('风吹古城。');
  });
  it.each([
    ['openai-chat', sse({ choices: [{ delta: { content: '半章' }, finish_reason: 'length' }], usage: { completion_tokens: 9 } }) + sse('[DONE]')],
    ['openai-responses', sse({ type: 'response.output_text.delta', delta: '半章' }) + sse({ type: 'response.incomplete', response: { status: 'incomplete', usage: { output_tokens: 9 } } })],
    ['gemini', sse({ candidates: [{ content: { parts: [{ text: '半章' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { candidatesTokenCount: 9 } })],
    ['claude', sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半章' } }) + sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } }) + sse({ type: 'message_stop' })],
  ] as [ProviderProtocol, string][])('retains partial %s text and usage before rejecting output truncation', async (protocol, events) => {
    const captured = vi.fn();
    const url = await service((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(events); });
    await expect(generateText({ ...config(protocol, url), stream: true }, { ...request, onResponse: captured })).rejects.toMatchObject({ message: expect.stringContaining('截断'), outputTokens: 9 });
    expect(captured).toHaveBeenCalledTimes(1); expect(captured.mock.calls[0][0]).toMatchObject({ text: '半章', incomplete: true, outputTokens: 9 }); expect(requests).toHaveLength(1);
  });
  it.each([
    ['openai-chat', sse({ choices: [{ delta: { content: '未完成' } }] })],
    ['openai-responses', sse({ type: 'response.output_text.delta', delta: '未完成' })],
    ['gemini', sse({ candidates: [{ content: { parts: [{ text: '未完成' }] } }] })],
    ['claude', sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '未完成' } })],
  ] as [ProviderProtocol, string][])('rejects %s EOF before a protocol end marker', async (protocol, events) => {
    const captured = vi.fn();
    const url = await service((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(events); });
    await expect(generateText({ ...config(protocol, url), stream: true }, { ...request, onResponse: captured })).rejects.toThrow('结束标记');
    expect(captured.mock.calls[0][0]).toMatchObject({ text: '未完成', incomplete: true });
  });
  it('rejects error events after partial text and redacts nested credential fields in SSE', async () => {
    const captured = vi.fn();
    const content = JSON.stringify({ summary: '草稿', 'Cf-Access-Jwt-Assertion': 'fictional-jwt-value', 'CF-Access-Client-Secret': 'fictional-cf-secret' });
    const events = sse({ choices: [{ delta: { content } }] }) + sse({ error: { message: secret, api_key: 'fixture-other-key' } }, 'error');
    const url = await service((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(events); });
    await expect(generateText({ ...config('openai-chat', url), stream: true, timeoutMs: 1000 }, { ...request, onResponse: captured })).rejects.toThrow('流式生成过程中返回错误');
    expect(captured.mock.calls[0][0]).toMatchObject({ incomplete: true, text: expect.stringContaining('草稿') });
    for (const value of [secret, 'fictional-jwt-value', 'fictional-cf-secret', 'fixture-other-key']) expect(JSON.stringify(captured.mock.calls[0][0])).not.toContain(value);
    expect(redactModelPayload(content)).not.toContain('fictional-jwt-value');
  });
  it('does not treat malformed events or empty successful streams as generated text', async () => {
    const malformed = await service((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {invalid}\n\n' + sse('[DONE]')); });
    await expect(generateText({ ...config('openai-chat', malformed), stream: true }, request)).rejects.toThrow('无效 JSON 事件');
    const empty = await service((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(sse('[DONE]')); });
    await expect(generateText({ ...config('openai-chat', empty), stream: true }, request)).rejects.toThrow('空内容');
  });
  it('keeps completed SSE events when the response socket is interrupted', async () => {
    const captured = vi.fn();
    const events = sse({ choices: [{ delta: { content: '已收到的正文' } }], usage: { completion_tokens: 5 } });
    const url = await service((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Length': Buffer.byteLength(events) + 100 }); res.write(events); setTimeout(() => res.destroy(), 30); });
    await expect(generateText({ ...config('openai-chat', url), stream: true }, { ...request, onResponse: captured })).rejects.toThrow('响应中断');
    expect(captured).toHaveBeenCalledTimes(1); expect(captured.mock.calls[0][0]).toMatchObject({ rawResponse: events, text: '已收到的正文', incomplete: true, diagnostics: { transport: 'interrupted' } });
  });
  it('records an empty HTTP 500 with exact redacted request before failing without retries', async () => {
    const captured = vi.fn(); const snapshot = vi.fn();
    const url = await service((_req, res) => { res.writeHead(500, { 'x-request-id': 'empty-fixture' }); res.end(); });
    const failure = await generateText({ ...config('gemini', `${url}/v1beta?route=test`), temperature: 0, topP: 0.9, geminiThinking: { mode: 'level', level: 'low' }, timeoutMs: 300000 }, { ...request, onRequest: snapshot, onResponse: captured }).catch(error => error);
    expect(failure.message).toContain('HTTP 500'); expect(failure).not.toBeInstanceOf(ModelOutputError);
    expect(captured).toHaveBeenCalledTimes(1); expect(snapshot).toHaveBeenCalledTimes(1); expect(requests).toHaveLength(1);
    expect(captured.mock.calls[0][0]).toMatchObject({ rawResponse: '', text: '', httpStatus: 500, request: { headers: { 'x-goog-api-key': '[REDACTED]' }, timeoutMs: 300000 }, diagnostics: { responseBytes: 0, transport: 'http', responseHeaders: { 'x-request-id': 'empty-fixture' } } });
    expect(captured.mock.calls[0][0].diagnostics).toMatchObject({ modelOutcome: 'error' });
    expect(captured.mock.calls[0][0].diagnostics).not.toHaveProperty('promptBlockReason');
    expect(JSON.parse(snapshot.mock.calls[0][0].body)).toEqual(requests[0].body);
    expect(snapshot.mock.calls[0][0].body).toContain(request.prompt); expect(JSON.stringify(snapshot.mock.calls[0][0])).not.toContain('fictional-session');
  });
  it('captures network failures even before response headers arrive', async () => {
    const captured = vi.fn(); const onRequest = vi.fn();
    const url = await service((_req, res) => res.destroy());
    await expect(generateText(config('openai-chat', url), { ...request, onRequest, onResponse: captured })).rejects.toThrow('无法连接');
    expect(onRequest).toHaveBeenCalledTimes(1); expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0][0]).toMatchObject({ rawResponse: '', text: '', incomplete: true, diagnostics: { responseBytes: 0, transport: 'network_error' } });
    expect(captured.mock.calls[0][0]).not.toHaveProperty('httpStatus');
  });
  it('records configured timeout and preserves stream text before aborting', async () => {
    const captured = vi.fn(); const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => realSetTimeout(callback, delay === 1000 ? 50 : delay, ...args)) as typeof setTimeout);
    const url = await service((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(sse({ candidates: [{ content: { parts: [{ text: '部分内容' }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 2 } })); });
    await expect(generateText({ ...config('gemini', url), stream: true, timeoutMs: 1000 }, { ...request, onResponse: captured })).rejects.toMatchObject({ name: 'ModelOutputError', message: expect.stringContaining('超时（1 秒）'), inputTokens: 8, outputTokens: 6 });
    expect(captured).toHaveBeenCalledTimes(1); expect(captured.mock.calls[0][0]).toMatchObject({ text: '部分内容', incomplete: true, request: { timeoutMs: 1000 }, diagnostics: { transport: 'timeout' } });
  });
  it('preserves actual usage in a user-cancelled streaming request', async () => {
    const captured = vi.fn(); const controller = new AbortController();
    const url = await service((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse({ choices: [{ delta: { content: '取消前的内容' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      setTimeout(() => controller.abort(), 30);
    });
    await expect(generateText({ ...config('openai-chat', url), stream: true }, { ...request, signal: controller.signal, onResponse: captured })).rejects.toMatchObject({ name: 'ModelOutputError', message: expect.stringContaining('已取消'), inputTokens: 10, outputTokens: 5 });
    expect(captured).toHaveBeenCalledTimes(1); expect(captured.mock.calls[0][0]).toMatchObject({ text: '取消前的内容', inputTokens: 10, outputTokens: 5, diagnostics: { transport: 'cancelled' } });
  });
});

describe('model finish feedback preserved before validation', () => {
  it.each([false, true])('excludes Gemini thought summaries from text but preserves them in the raw response (stream=%s)', async stream => {
    const envelope = { candidates: [{ content: { parts: [{ thought: true, text: '摘要专用文本' }, { text: '灯塔恢复了照明。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, thoughtsTokenCount: 3 } };
    const captured = vi.fn();
    const url = await service((_req, res) => stream ? (res.writeHead(200, { 'Content-Type': 'text/event-stream' }), res.end(sse(envelope))) : json(res, envelope));
    const result = await generateText({ ...config('gemini', url), stream, geminiIncludeThoughts: true, geminiThinking: { mode: 'level', level: 'high' } }, { ...request, onResponse: captured });
    expect(result).toEqual({ text: '灯塔恢复了照明。', inputTokens: 5, outputTokens: 7 });
    expect(requests[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high', includeThoughts: true });
    expect(captured.mock.calls[0][0]).toMatchObject({ text: result.text, diagnostics: { modelOutcome: 'completed', finishReason: 'STOP' } });
    expect(captured.mock.calls[0][0].rawResponse).toContain('摘要专用文本');
  });
  it.each([
    [false, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, { promptBlockReason: 'PROHIBITED_CONTENT' }],
    [true, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, { promptBlockReason: 'PROHIBITED_CONTENT' }],
    [false, { candidates: [{ finishReason: 'SAFETY', safetyRatings: [{ category: 'fixture', blocked: true }] }] }, { finishReason: 'SAFETY' }],
    [true, { candidates: [{ finishReason: 'SAFETY', safetyRatings: [{ category: 'fixture', blocked: true }] }] }, { finishReason: 'SAFETY' }],
  ])('keeps the actual Gemini block reason with an HTTP 200 instead of reporting a JSON error (stream=%s)', async (stream, envelope, feedback) => {
    const captured = vi.fn();
    const url = await service((_req, res) => stream ? (res.writeHead(200, { 'Content-Type': 'text/event-stream' }), res.write(sse(envelope))) : json(res, envelope));
    await expect(generateText({ ...config('gemini', url), stream: Boolean(stream), timeoutMs: 1000 }, { ...request, onResponse: captured })).rejects.toThrow('拦截');
    expect(captured).toHaveBeenCalledTimes(1); expect(requests).toHaveLength(1);
    expect(captured.mock.calls[0][0]).toMatchObject({ text: '', httpStatus: 200, incomplete: false, diagnostics: { modelOutcome: 'blocked', ...feedback as object } });
    expect(captured.mock.calls[0][0].rawResponse).toContain(JSON.stringify(envelope));
  });
  it.each([
    ['gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: '只有摘要' }] } }] }, 'empty'],
    ['gemini', { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [{ text: '保留诊断文本' }] } }] }, 'error'],
    ['openai-responses', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'fixture refusal' }] }] }, 'blocked'],
  ] as [ProviderProtocol, Record<string, unknown>, string][])('distinguishes %s empty or rejected results before parsing', async (protocol, envelope, outcome) => {
    const captured = vi.fn(); const url = await service((_req, res) => json(res, envelope));
    await expect(generateText(config(protocol, url), { ...request, onResponse: captured })).rejects.toBeInstanceOf(ModelOutputError);
    expect(captured.mock.calls[0][0]).toMatchObject({ httpStatus: 200, diagnostics: { modelOutcome: outcome } });
    expect(requests).toHaveLength(1);
  });
});

describe('human-pasted structured model output', () => {
  const payload = { summary: '一份可以修正的资料', entities: [] };
  const validate = (value: unknown) => z.object({ summary: z.string(), entities: z.array(z.unknown()) }).parse(value);
  it('uses the same credential redaction for user-pasted envelopes and multiple configured keys', () => {
    const raw = JSON.stringify({ Authorization: 'Bearer unknown-pasted-credential', candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'existing-key-one and existing-key-two', api_key: 'unknown-inner-key', nested: { access_token: 'unknown-inner-token' } }) }] } }] });
    const redacted = redactModelPayload(raw, ['existing-key-one', 'existing-key-two']);
    for (const value of ['unknown-pasted-credential', 'existing-key-one', 'existing-key-two', 'unknown-inner-key', 'unknown-inner-token']) expect(redacted).not.toContain(value);
    expect(JSON.parse(redacted).Authorization).toBe('[REDACTED]');
    expect(unwrapModelOutput(redacted)).toContain('"api_key":"[REDACTED]"');
    expect(redactModelPayload('{"access_token":"not-in-current-settings"}')).toBe('{"access_token":"[REDACTED]"}');
  });
  it.each([
    ['Gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ thought: true, text: '内部推理' }, { text: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` }] } }] }],
    ['Chat Completions', { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }],
    ['Responses', { object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }] }],
    ['Claude', { type: 'message', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '内部推理' }, { type: 'text', text: JSON.stringify(payload) }] }],
  ])('accepts a complete %s envelope and validates only its model text', (_name, envelope) => {
    expect(parseStructuredText(JSON.stringify(envelope), validate)).toEqual(payload);
  });

  it('accepts plain JSON/code fences, preserves ordinary prose, and unwraps writing envelopes', () => {
    expect(parseStructuredText(JSON.stringify(payload), validate)).toEqual(payload);
    expect(parseStructuredText(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``, validate)).toEqual(payload);
    expect(unwrapModelOutput('  普通小说正文。\n\n保留段落。  ')).toBe('  普通小说正文。\n\n保留段落。  ');
    expect(unwrapModelOutput('{"choices":[{"message":{"content":"小说正文。"}}]}')).toBe('小说正文。');
  });

  it('accepts one complete JSON fence with a small amount of surrounding explanation', () => {
    expect(parseStructuredText(`已根据原文整理如下：\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n以上是本次提取结果。`, validate)).toEqual(payload);
    const envelope = { candidates: [{ content: { parts: [{ text: `结果如下：\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n请核对。` }] } }] };
    expect(parseStructuredText(JSON.stringify(envelope), validate)).toEqual(payload);
  });

  it('repairs only trailing commas outside strings and leaves the source output intact', async () => {
    const text = '{"summary":"保留字面量 ,} 和 ,] 以及 \\\"引号\\\"", "entities":[{"name":"林舟",},],}';
    const expected = { summary: '保留字面量 ,} 和 ,] 以及 "引号"', entities: [{ name: '林舟' }] };
    expect(parseStructuredText(text, validate)).toEqual(expected);
    const captured = vi.fn();
    const url = await service((_req, res) => json(res, { choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
    expect((await generateStructured(config('openai-chat', url), { ...request, onResponse: captured }, validate)).value).toEqual(expected);
    expect(captured.mock.calls[0][0].text).toBe(text);
    expect(JSON.parse(captured.mock.calls[0][0].rawResponse).choices[0].message.content).toBe(text);
    expect(requests).toHaveLength(1);
  });

  it.each([
    '第一份\n```json\n{"summary":"a","entities":[]}\n```\n第二份\n```json\n{"summary":"b","entities":[]}\n```',
    '{"other":"object"}\n```json\n{"summary":"a","entities":[]}\n```',
    '```json\n{"summary":"a","entities":[]}\n```\n{"other":"object"}',
    '```json\n{"summary":"a","entities":[]} {"summary":"b","entities":[]}\n```',
    '{"summary":"a","entities":[]} {"summary":"b","entities":[]}',
    `${'说'.repeat(513)}\n\`\`\`json\n{"summary":"a","entities":[]}\n\`\`\``,
  ])('rejects ambiguous or excessive wrapper content instead of choosing an object', text => {
    expect(() => parseStructuredText(text, validate)).toThrow(ModelOutputError);
  });

  it.each([
    '{"summary":"incomplete',
    '{"summary":"a","entities":[],',
    '{"summary":"a","entities":[{"name":"林舟"},',
    '{"summary":"a","entities":[,]}',
    '{"summary":"a","entities":[1,,]}',
    '{"summary":,"entities":[]}',
    '{"summary":"a",/* comment */"entities":[]}',
    '```json\n{"summary":"a","entities":[]}',
    '{summary:"a",entities:[]}',
  ])('does not invent missing data, delimiters or values for malformed JSON', text => {
    expect(() => parseStructuredText(text, validate)).toThrow(ModelOutputError);
  });

  it.each([
    { candidates: [] },
    { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
    { object: 'response', status: 'completed', output: [] },
    { type: 'message', stop_reason: 'end_turn', content: [] },
    { promptFeedback: { blockReason: 'SAFETY' } },
    { error: { code: 500, message: '服务错误', status: 'INTERNAL' } },
  ])('does not mistake an envelope without text for finished prose', envelope => {
    expect(() => unwrapModelOutput(JSON.stringify(envelope))).toThrow('没有可用正文');
  });

  it.each(['[]', 'null', '"plain"', '2', 'true'])('rejects a non-object structured value %s with a precise safe issue', value => {
    expect(() => parseStructuredText(value, validate)).toThrow('顶层必须是 JSON 对象');
  });

  it('reports syntax locations without echoing the model payload in errors', () => {
    try { parseStructuredText(`{"summary":"private-story ${secret}", oops}`, validate); throw new Error('Expected parser failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(ModelOutputError);
      const failure = error as ModelOutputError;
      expect(failure.issues?.[0].path).toBe('$');
      expect(failure.issues?.[0].message).toContain('JSON');
      expect(JSON.stringify({ message: failure.message, issues: failure.issues })).not.toContain(secret);
      expect(failure.message).not.toContain('private-story');
    }
  });
});

describe('text provider adapters against real local HTTP fixtures', () => {
  it('sends Chat Completions fields, preserves a custom prefix/query, and reads usage', async () => {
    const url = await service((_req, res) => json(res, { choices: [{ message: { content: '古城醒了。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 41, completion_tokens: 12 } }));
    expect(await generateText(config('openai-chat', `${url}/custom/v7/?route=write`), request)).toEqual({ text: '古城醒了。', inputTokens: 41, outputTokens: 12 });
    expect(requests[0].url).toBe('/custom/v7/chat/completions?route=write');
    expect(requests[0].headers.authorization).toBe(`Bearer ${secret}`);
    expect(requests[0].body).toEqual({ model: 'example-model', messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }], max_tokens: 1234, stream: false });
  });

  it('sends Responses fields without adding an implicit API prefix', async () => {
    const url = await service((_req, res) => json(res, { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '林舟停下脚步。' }] }], usage: { input_tokens: 60, output_tokens: 17 } }));
    expect(await generateText(config('openai-responses', url), { ...request, maxOutputTokens: 100 })).toEqual({ text: '林舟停下脚步。', inputTokens: 60, outputTokens: 17 });
    expect(requests[0].url).toBe('/responses');
    expect(requests[0].body).toMatchObject({ instructions: request.system, input: request.prompt, max_output_tokens: 100, store: false });
  });

  it('uses native Gemini authentication and excludes reasoning text', async () => {
    const url = await service((_req, res) => json(res, { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'hidden reasoning' }, { text: '风掠过城墙。' }] } }], usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20, thoughtsTokenCount: 5 } }));
    expect(await generateText({ ...config('gemini', `${url}/v1beta?route=read`), model: 'models/example-model' }, request)).toEqual({ text: '风掠过城墙。', inputTokens: 90, outputTokens: 25 });
    expect(requests[0].url).toBe('/v1beta/models/example-model:generateContent?route=read');
    expect(requests[0].headers['x-goog-api-key']).toBe(secret);
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(requests[0].body).toEqual({ systemInstruction: { parts: [{ text: request.system }] }, contents: [{ role: 'user', parts: [{ text: request.prompt }] }], generationConfig: { maxOutputTokens: 1234 } });
  });

  it('uses native Claude messages and accounts for cache tokens', async () => {
    const url = await service((_req, res) => json(res, { type: 'message', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '城门缓缓开启。' }], usage: { input_tokens: 30, cache_creation_input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 9 } }));
    expect(await generateText(config('claude', `${url}/v1`), request)).toEqual({ text: '城门缓缓开启。', inputTokens: 45, outputTokens: 9 });
    expect(requests[0].url).toBe('/v1/messages');
    expect(requests[0].headers['x-api-key']).toBe(secret);
    expect(requests[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(requests[0].body).toMatchObject({ system: request.system, max_tokens: 1234, messages: [{ role: 'user', content: request.prompt }] });
  });

  it.each([
    ['openai-chat', { choices: [{ finish_reason: 'length', message: { content: '不完整' } }] }],
    ['openai-responses', { status: 'incomplete', output: [] }],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '不完整' }] } }] }],
    ['claude', { stop_reason: 'max_tokens', content: [{ type: 'text', text: '不完整' }] }],
  ] as const)('rejects truncated %s content', async (protocol, reply) => {
    const url = await service((_req, res) => json(res, reply));
    await expect(generateText(config(protocol, url), request)).rejects.toThrow('截断');
    expect(requests).toHaveLength(1);
  });

  it('does not reveal an upstream body that echoes credentials and does not retry', async () => {
    const url = await service((_req, res) => json(res, { error: { message: secret } }, 429));
    const result = await generateText(config('openai-chat', url), request).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('429');
    expect((result as Error).message).not.toContain(secret);
    expect(requests).toHaveLength(1);
  });

  it('refuses redirects before any key can reach the destination', async () => {
    let reached = false;
    const destination = await service((_req, res) => { reached = true; json(res, {}); });
    const url = await service((_req, res) => { res.writeHead(307, { Location: destination }); res.end(); });
    await expect(generateText(config('openai-chat', url), request)).rejects.toThrow('无法连接');
    expect(reached).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it('aborts a pending real HTTP call and gives a cancellation message', async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const url = await service(() => started());
    const controller = new AbortController();
    const pending = generateText(config('openai-chat', url), { ...request, signal: controller.signal });
    await startedPromise;
    controller.abort(new Error(secret));
    await expect(pending).rejects.toThrow('已取消');
  });

  it('times out a hanging service without waiting 180 seconds in the test', async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => realSetTimeout(callback, delay === MODEL_TIMEOUT_MS ? 50 : delay, ...args)) as typeof setTimeout);
    const url = await service(() => {});
    await expect(generateText(config('openai-chat', url), request)).rejects.toThrow('超时');
  });

  it('rejects empty output, non-JSON responses, and pre-cancelled calls', async () => {
    const url = await service((_req, res) => json(res, { choices: [{ message: { content: ' ' }, finish_reason: 'stop' }] }));
    await expect(generateText(config('openai-chat', url), request)).rejects.toThrow('空内容');
    const invalidUrl = await service((_req, res) => { res.end(`<html>${secret}</html>`); });
    await expect(generateText(config('openai-chat', invalidUrl), request)).rejects.toThrow('有效 JSON');
    await expect(generateText(config('openai-chat', url), { ...request, signal: AbortSignal.abort() })).rejects.toThrow('已取消');
    expect(requests).toHaveLength(2);
  });

  it('parses fenced structured data and validates once without a repair request', async () => {
    const url = await service((_req, res) => json(res, { choices: [{ message: { content: '```json\n{"name":"林舟"}\n```' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    const validate = vi.fn((value: unknown) => {
      if (!(value as any).name) throw new Error(secret);
      return value as { name: string };
    });
    expect(await generateStructured(config('openai-chat', url), request, validate)).toEqual({ value: { name: '林舟' }, inputTokens: 10, outputTokens: 5 });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    await expect(generateStructured(config('openai-chat', url), request, () => { throw new Error(secret); })).rejects.toMatchObject({ message: expect.stringContaining('未通过'), inputTokens: 10, outputTokens: 5 });
    expect(requests).toHaveLength(2);
  });

  it('does not leak validator input or perform hidden retries on malformed JSON', async () => {
    const url = await service((_req, res) => json(res, { choices: [{ message: { content: `not json ${secret}` }, finish_reason: 'stop' }] }));
    const error = await generateStructured(config('openai-chat', url), request, (v) => v).catch((e: Error) => e);
    expect((error as Error).message).toContain('不是有效 JSON');
    expect((error as Error).message).not.toContain(secret);
    expect(requests).toHaveLength(1);
  });
});
