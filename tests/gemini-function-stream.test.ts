import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import { createStreamTextEmitter, parseModelStream } from '../server/model-stream.js';
import { generateStructured, generateText } from '../server/providers.js';
import { redactSseFragments } from '../server/stream-redaction.js';
import type { CapturedModelResponse, ModelRequest, ProviderConfig } from '../shared/types.js';

const sse = (parts: any[], finishReason?: string) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 } })}\n\n`;
const call = (input: any, extra = {}) => ({ functionCall: input, ...extra });
const arg = (jsonPath: string, stringValue: string, willContinue = false) => ({ jsonPath, stringValue, willContinue });
const stop = sse([], 'STOP');
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function upstream(reply: (index: number, body: any, res: ServerResponse) => Promise<void> | void) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); await reply(bodies.length - 1, body, res); });
  servers.push(server); await listenLocalServer(server);
  return { bodies, url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
}
const config = (baseUrl: string): ProviderConfig => ({ id: 'local', name: '本地参数分片', protocol: 'gemini', baseUrl, model: 'fixture', maxOutputTokens: 2000, contextTokens: 64000, timeoutMs: 5000, geminiStreamFunctionCallArguments: true });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(value => { resolve = value; }); return { promise, resolve }; };

describe('Gemini streamed function arguments', () => {
  it('assembles nested fields, arrays, typed values and string close markers into one signed call', () => {
    const raw = sse([call({ name: 'submit', id: 'one', willContinue: true }, { thoughtSignature: 'opaque-signature' })])
      + sse([call({ partialArgs: [arg('$.prose', '正文', true), arg('$.toolCalls[0].name', 'read_entity'), arg('$.toolCalls[0].argumentsJson', '{"id":', true)], willContinue: true })])
      + sse([call({ partialArgs: [arg('$.toolCalls[0].argumentsJson', '"person"}'), { jsonPath: '$.prose' }, { jsonPath: '$["extra.key"][\'状态\']', boolValue: false }, { jsonPath: '$.count', numberValue: 0 }, { jsonPath: '$.absent', nullValue: 'NULL_VALUE' }], willContinue: true })])
      + sse([call({})]) + stop;
    const result = parseModelStream('gemini', raw);
    expect(result.incomplete).toBe(false); expect(result.error).toBeUndefined();
    expect(result.data.candidates[0].content.parts.filter((part: any) => part.functionCall)).toEqual([{
      functionCall: { id: 'one', name: 'submit', args: { prose: '正文', toolCalls: [{ name: 'read_entity', argumentsJson: '{"id":"person"}' }], 'extra.key': { 状态: false }, count: 0, absent: null } }, thoughtSignature: 'opaque-signature',
    }]);
    expect(result.data.candidates[0].historyParts).toHaveLength(1);
    expect(result.data.usageMetadata).toMatchObject({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 });
  });

  it('keeps sequential calls without ids and interleaved calls with ids separate', () => {
    const raw = sse([call({ name: 'lookup', willContinue: true, partialArgs: [arg('$.id', 'a', true)] })])
      + sse([call({ partialArgs: [arg('$.id', 'b')] })])
      + sse([call({ name: 'lookup', args: { id: 'second' } })])
      + sse([call({ id: 'left', name: 'lookup', partialArgs: [arg('$.id', 'L', true)], willContinue: true }), call({ id: 'right', name: 'lookup', partialArgs: [arg('$.id', 'R', true)], willContinue: true })])
      + sse([call({ id: 'right', partialArgs: [arg('$.id', '2')] }), call({ id: 'left', partialArgs: [arg('$.id', '1')] })]) + stop;
    const result = parseModelStream('gemini', raw);
    expect(result.error).toBeUndefined();
    expect(result.data.candidates[0].historyParts.map((part: any) => part.functionCall.args.id)).toEqual(['ab', 'second', 'L1', 'R2']);
  });

  it('emits only top-level carrier prose before completion, preserving Unicode and ignoring inner tool prose', () => {
    const deltas: string[] = [];
    const feed = createStreamTextEmitter('gemini', text => deltas.push(text), { name: 'emit_complete_text', field: 'content' });
    const first = sse([call({ name: 'emit_complete_text', partialArgs: [arg('$.content', '他抬头。\ud83d', true)], willContinue: true })]);
    for (const char of first) feed(char);
    expect(deltas.join('')).toBe('他抬头。');
    feed(sse([call({ partialArgs: [arg('$.content', '\ude42\n雨停了。')] })]));
    feed(sse([{ text: '他抬头。🙂\n雨停了。' }, call({ name: 'lookup', args: { content: '不能显示' } })]));
    expect(deltas.join('')).toBe('他抬头。🙂\n雨停了。');
    const nested: string[] = [];
    const layered = createStreamTextEmitter('gemini', text => nested.push(text), true);
    layered(sse([call({ name: 'emit_writing_response', partialArgs: [arg('$.toolCalls[0].argumentsJson', '{"prose":"不可泄漏"}'), arg('$.prose', '可见正文')], willContinue: false })]));
    expect(nested.join('')).toBe('可见正文');
  });

  it('accepts a final full-args snapshot without appending it twice and retains a late signature', () => {
    const raw = sse([call({ name: 'submit', id: 'one', partialArgs: [arg('$.content', '前文', true)], willContinue: true })])
      + sse([call({ id: 'one', args: { content: '前文后文' } }, { thoughtSignature: 'late-signature' })]) + stop;
    const result = parseModelStream('gemini', raw);
    expect(result.incomplete).toBe(false);
    expect(result.data.candidates[0].historyParts).toEqual([call({ name: 'submit', id: 'one', args: { content: '前文后文' } }, { thoughtSignature: 'late-signature' })]);
  });

  it.each([
    { jsonPath: '$.__proto__.polluted', stringValue: 'x' },
    { jsonPath: '$["constructor"].prototype.polluted', stringValue: 'x' },
    { jsonPath: '$.items[10001]', stringValue: 'x' },
    { jsonPath: '$..content', stringValue: 'x' },
    { jsonPath: '$[*]', stringValue: 'x' },
    { jsonPath: '$.content', stringValue: 1 },
    { jsonPath: '$.content', boolValue: 'false' },
    { jsonPath: '$.content', numberValue: '1' },
    { jsonPath: '$.content', nullValue: 'null' },
    { jsonPath: '$.content', stringValue: 'x', boolValue: true },
    { jsonPath: '$.content' },
  ])('rejects malformed or unsafe argument fragments %j', fragment => {
    const result = parseModelStream('gemini', sse([call({ name: 'submit', partialArgs: [fragment] })]) + stop);
    expect(result.incomplete).toBe(true); expect(result.error).toContain('分片');
    expect(({} as any).polluted).toBeUndefined();
  });

  it.each([true, false])('rejects unfinished calls or strings even with STOP (call open=%s)', open => {
    const result = parseModelStream('gemini', sse([call({ name: 'submit', partialArgs: [arg('$.content', '已收到', !open)], willContinue: open })]) + stop);
    expect(result.incomplete).toBe(true); expect(result.error).toContain('尚未完整');
  });

  it('redacts secrets split across PartialArg and part positions in the raw SSE', () => {
    const raw = sse([call({ name: 'submit', partialArgs: [arg('$.other', ''), arg('$.content', '正文 configured-', true)], willContinue: true })])
      + sse([{ thought: true, text: '公开摘要' }, call({ partialArgs: [arg('$["content"]', 'secret 正文')] })]) + stop;
    const safe = redactSseFragments(raw, ['configured-secret']);
    expect(safe).not.toContain('configured-'); expect(safe).not.toContain('secret 正文'); expect(safe).toContain('[REDACTED]');
  });

  it.each(['native', 'layered'] as const)('streams %s prose through real HTTP before completion, executes one complete tool and keeps signed history', async mode => {
    const beforeEnd = deferred(); const allowLookup = deferred(); const firstProse = deferred(); const allowEnd = deferred();
    const execute = vi.fn(() => ({ name: '林舟' })); const captured: CapturedModelResponse[] = []; const deltas: string[] = [];
    const field = mode === 'native' ? 'content' : 'prose';
    const sink = mode === 'native' ? 'emit_complete_text' : 'emit_writing_response';
    const service = await upstream(async (index, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!index) {
        const fragments = mode === 'native' ? [arg('$.id', 'per', true)] : [arg('$.prose', ''), arg('$.toolCalls[0].name', 'read_entity'), arg('$.toolCalls[0].argumentsJson', '{"id":"per', true)];
        res.write(sse([call({ name: mode === 'native' ? 'read_entity' : sink, id: 'lookup', partialArgs: fragments, willContinue: true }, { thoughtSignature: 'lookup-signature' })]));
        res.write(sse([call({ partialArgs: [arg(mode === 'native' ? '$.id' : '$.toolCalls[0].argumentsJson', mode === 'native' ? 'son' : 'son"}')] }), { thought: true, text: '等待完整响应校验' }]));
        await allowLookup.promise; res.end(stop);
      } else {
        res.write(sse([call({ name: sink, id: 'final', partialArgs: [arg(`$.${field}`, '林舟来到', true)], willContinue: true }, { thoughtSignature: 'final-signature' })]));
        await allowEnd.promise;
        const tail = [arg(`$.${field}`, '城门。')];
        if (mode === 'layered') res.write(sse([call({ partialArgs: tail, willContinue: true })]) + sse([call({ args: { prose: '林舟来到城门。', toolCalls: [] } })]));
        else res.write(sse([call({ partialArgs: tail })]));
        res.end(stop);
      }
    });
    const request: ModelRequest = { system: '', prompt: '写作', writingOutputMode: 'tool', ...(mode === 'native' ? { responseCarrier: { name: sink, field } } : {}), tools: [{ name: 'read_entity', description: '查人物', parameters: { type: 'object' }, execute }],
      onTextDelta: text => { deltas.push(text); firstProse.resolve(); }, onActivity: event => { if (event.type === 'thinking' && event.text === '等待完整响应校验') beforeEnd.resolve(); }, onResponse: value => captured.push(value) };
    let settled = false;
    const result = generateText(config(service.url), request).finally(() => { settled = true; });
    try {
      await beforeEnd.promise; expect(execute).not.toHaveBeenCalled(); allowLookup.resolve();
      await firstProse.promise; expect(deltas.join('')).toBe('林舟来到'); expect(settled).toBe(false);
      expect(execute).toHaveBeenCalledExactlyOnceWith({ id: 'person' }); allowEnd.resolve();
      expect((await result).text).toBe('林舟来到城门。'); expect(deltas.join('')).toBe('林舟来到城门。');
      expect(service.bodies).toHaveLength(2);
      for (const body of service.bodies) expect(body.toolConfig.functionCallingConfig.streamFunctionCallArguments).toBe(true);
      const history = service.bodies[1].contents.find((message: any) => message.role === 'model');
      expect(history.parts.find((part: any) => part.functionCall)).toMatchObject({ functionCall: { name: mode === 'native' ? 'read_entity' : sink }, thoughtSignature: 'lookup-signature' });
      expect(JSON.stringify(history)).not.toContain('partialArgs'); expect(captured[1].rawResponse).toContain('partialArgs'); expect(captured[1].text).toBe('林舟来到城门。');
    } finally { allowLookup.resolve(); allowEnd.resolve(); await result.catch(() => undefined); }
  });

  it('keeps partial prose and prevents every tool execution or retry when arguments remain incomplete', async () => {
    const execute = vi.fn(); const captured: CapturedModelResponse[] = [];
    const service = await upstream((_index, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse([call({ name: 'emit_complete_text', partialArgs: [arg('$.content', '已收到的正文', true)], willContinue: true }), call({ name: 'read_entity', args: { id: 'person' } })]) + stop);
    });
    const result = generateText(config(service.url), { system: '', prompt: '写作', writingOutputMode: 'tool', responseCarrier: { name: 'emit_complete_text', field: 'content' }, tools: [{ name: 'read_entity', description: '', parameters: {}, execute }], onTextDelta: () => {}, onResponse: value => captured.push(value) });
    await expect(result).rejects.toThrow('尚未完整');
    expect(execute).not.toHaveBeenCalled(); expect(service.bodies).toHaveLength(1);
    expect(captured[0]).toMatchObject({ text: '已收到的正文', incomplete: true });
  });

  it('assembles one structured submission without another confirmation request', async () => {
    const service = await upstream((_index, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse([call({ name: 'submit_result', partialArgs: [arg('$.summary', '林舟抵达', true)], willContinue: true }, { thoughtSignature: 'submission-signature' })])
        + sse([call({ partialArgs: [arg('$.summary', '城门。'), { jsonPath: '$.count', numberValue: 0 }] })]) + stop);
    });
    const result = await generateStructured({ ...config(service.url), stream: true }, { system: '', prompt: '整理', structuredOutput: { mode: 'tool', name: 'submit_result', description: '提交整理结果', schema: { type: 'object' } } }, value => value);
    expect(result.value).toEqual({ summary: '林舟抵达城门。', count: 0 }); expect(service.bodies).toHaveLength(1);
    expect(service.bodies[0].toolConfig.functionCallingConfig).toMatchObject({ mode: 'ANY', streamFunctionCallArguments: true });
  });

  it('retains streamed prose and raw fragments when cancelled without executing or retrying tools', async () => {
    const controller = new AbortController(); const execute = vi.fn(); const captured: CapturedModelResponse[] = [];
    const service = await upstream((_index, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse([call({ name: 'emit_complete_text', partialArgs: [arg('$.content', '取消前的正文', true)], willContinue: true })]));
    });
    await expect(generateText(config(service.url), { system: '', prompt: '写作', writingOutputMode: 'tool', responseCarrier: { name: 'emit_complete_text', field: 'content' }, tools: [{ name: 'read_entity', description: '', parameters: {}, execute }], signal: controller.signal, onTextDelta: () => controller.abort(), onResponse: value => captured.push(value) })).rejects.toThrow('取消');
    expect(captured[0]).toMatchObject({ text: '取消前的正文', incomplete: true, diagnostics: { transport: 'cancelled' } });
    expect(captured[0].rawResponse).toContain('partialArgs'); expect(service.bodies).toHaveLength(1); expect(execute).not.toHaveBeenCalled();
  });
});
