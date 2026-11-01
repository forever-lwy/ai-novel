import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import { generateText } from '../server/providers.js';
import type { CapturedModelResponse, ModelRequest, ProviderConfig, ProviderProtocol } from '../shared/types.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const protocols: ProviderProtocol[] = ['openai-chat', 'openai-responses', 'gemini', 'claude'];
const config = (baseUrl: string, protocol: ProviderProtocol = 'gemini'): ProviderConfig => ({ id: 'local', name: '工具参数兼容测试', protocol, baseUrl, model: 'fixture', maxOutputTokens: 1000, contextTokens: 64000, timeoutMs: 5000 });
const request = (execute: NonNullable<ModelRequest['tools']>[number]['execute']): ModelRequest => ({
  system: '需要资料时调用工具，之后继续正文。', prompt: '继续写作。',
  tools: [{ name: 'list_text_files', description: '列出文本文件', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false }, execute }],
});

async function upstream(reply: (response: ServerResponse, index: number) => void) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    reply(res, bodies.length - 1);
  });
  servers.push(server); await listenLocalServer(server);
  return { bodies, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
}

function toolResponse(args: unknown, protocol: ProviderProtocol = 'gemini', name = 'list_text_files'): any {
  const argumentsField = args === undefined ? {} : { arguments: args };
  if (protocol === 'openai-chat') return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'lookup-1', type: 'function', function: { name, ...argumentsField } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'function_call', call_id: 'lookup-1', name, ...argumentsField }], usage: { input_tokens: 10, output_tokens: 2 } };
  if (protocol === 'claude') return { type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'lookup-1', name, ...(args === undefined ? {} : { input: args }) }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } };
  return { candidates: [{ index: 0, content: { role: 'model', parts: [
    { text: '先检查已有文件。', thought: true },
    { functionCall: { id: 'lookup-1', name, ...(args === undefined ? {} : { args }) }, thoughtSignature: 'opaque-fixture-signature' },
  ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
}
const finalResponse = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '旅人沿着河岸继续前行。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 } };
function prose(protocol: ProviderProtocol) {
  const text = '旅人沿着河岸继续前行。';
  if (protocol === 'openai-chat') return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 11, output_tokens: 4 } };
  if (protocol === 'claude') return { type: 'message', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 4 } };
  return finalResponse;
}

describe('provider tool argument compatibility', () => {
  const emptyArgs: [string, unknown][] = [['omitted', undefined], ['null', null], ['empty string', ''], ['whitespace', ' \n\t '], ['JSON null', 'null']];
  it.each(protocols.flatMap(protocol => emptyArgs.map(([label, args]) => ({ protocol, label, args }))))('treats $label arguments as an empty object for $protocol', async ({ protocol, args }) => {
    const execute = vi.fn(() => ({ files: [], total: 0 }));
    const service = await upstream((res, index) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(index === 0 ? toolResponse(args, protocol) : prose(protocol)));
    });

    expect((await generateText(config(service.baseUrl, protocol), request(execute))).text).toBe('旅人沿着河岸继续前行。');
    expect(execute).toHaveBeenCalledExactlyOnceWith({});
    expect(service.bodies).toHaveLength(2);
  });

  it.each(protocols.flatMap(protocol => [false, true].map(encoded => ({ protocol, encoded }))))('accepts object arguments for $protocol (JSON string=$encoded)', async ({ protocol, encoded }) => {
    const execute = vi.fn(() => ({ files: [], total: 0 }));
    const args = { limit: 3 };
    const service = await upstream((res, index) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(index === 0 ? toolResponse(encoded ? JSON.stringify(args) : args, protocol) : prose(protocol)));
    });
    await generateText(config(service.baseUrl, protocol), request(execute));
    expect(execute).toHaveBeenCalledExactlyOnceWith(args);
    expect(service.bodies).toHaveLength(2);
  });

  it.each(['sse', 'json'] as const)('accepts omitted Gemini args in %s and continues with signed tool history', async transport => {
    const execute = vi.fn(() => ({ files: [], total: 0 }));
    const captured: CapturedModelResponse[] = [];
    const first = toolResponse(undefined);
    // This is a real upstream ID even though its prefix matches local fallback IDs.
    first.candidates[0].content.parts[1].functionCall.id = 'call_1047136';
    // Match a tool-only turn ending in a separate STOP event, as gateways may send it.
    const raw = transport === 'sse'
      ? sse({ candidates: [{ content: first.candidates[0].content, index: 0 }] }) + sse({ candidates: [{ content: { role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: first.usageMetadata })
      : JSON.stringify(first);
    const service = await upstream((res, index) => {
      res.writeHead(200, { 'Content-Type': transport === 'sse' ? 'text/event-stream' : 'application/json' });
      res.end(index === 0 ? raw : transport === 'sse' ? sse(finalResponse) : JSON.stringify(finalResponse));
    });

    const result = await generateText(config(service.baseUrl), { ...request(execute), onResponse: value => captured.push(value) });

    expect(result).toEqual({ text: '旅人沿着河岸继续前行。', inputTokens: 21, outputTokens: 6 });
    expect(execute).toHaveBeenCalledExactlyOnceWith({});
    expect(service.bodies).toHaveLength(2);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({ rawResponse: raw, incomplete: false });
    const history = service.bodies[1].contents.find((message: any) => message.role === 'model');
    expect(history.parts).toContainEqual(expect.objectContaining({ thoughtSignature: 'opaque-fixture-signature', functionCall: expect.objectContaining({ id: 'call_1047136', name: 'list_text_files' }) }));
    expect(service.bodies[1].contents.at(-1).parts[0].functionResponse).toMatchObject({ name: 'list_text_files', id: 'call_1047136', response: { result: { files: [], total: 0 } } });
  });

  it.each(protocols.flatMap(protocol => ([
    ['array', []], ['number', 7], ['boolean', false], ['malformed JSON', '{'],
  ] as [string, unknown][]).map(([label, args]) => ({ protocol, label, args }))))('rejects $label arguments for $protocol before executing or retrying the tool', async ({ protocol, args }) => {
    const execute = vi.fn();
    const captured: CapturedModelResponse[] = [];
    const service = await upstream(res => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(toolResponse(args, protocol)));
    });

    await expect(generateText(config(service.baseUrl, protocol), { ...request(execute), onResponse: value => captured.push(value) })).rejects.toMatchObject({ name: 'ModelOutputError', message: expect.stringMatching(/工具参数|JSON/) });
    expect(execute).not.toHaveBeenCalled();
    expect(service.bodies).toHaveLength(1);
    expect(captured).toHaveLength(1);
  });

  it.each((['sse', 'json'] as const).flatMap(transport => [undefined, null, '', ' \n\t '].map(id => ({ transport, id }))))('accepts an absent or empty Gemini call ID ($id) over $transport', async ({ transport, id }) => {
    const execute = vi.fn(() => ({ files: [], total: 0 }));
    const first = toolResponse(undefined);
    first.candidates[0].content.parts[1].functionCall.id = id;
    const service = await upstream((res, index) => {
      res.writeHead(200, { 'Content-Type': transport === 'sse' ? 'text/event-stream' : 'application/json' });
      res.end(transport === 'sse' ? sse(index === 0 ? first : finalResponse) : JSON.stringify(index === 0 ? first : finalResponse));
    });
    await generateText(config(service.baseUrl), request(execute));
    expect(execute).toHaveBeenCalledExactlyOnceWith({});
    expect(service.bodies).toHaveLength(2);
    const response = service.bodies[1].contents.at(-1).parts[0].functionResponse;
    expect(response.name).toBe('list_text_files');
    expect(response).not.toHaveProperty('id');
  });

  it.each(['sse', 'json'] as const)('keeps generated Gemini IDs separate from a real call_0 ID over %s', async transport => {
    const execute = vi.fn(() => ({ files: [], total: 0 }));
    const first = toolResponse(undefined);
    first.candidates[0].content.parts = [
      { functionCall: { name: 'list_text_files', args: { limit: 1 } }, thoughtSignature: 'unsigned-id-signature' },
      { functionCall: { id: 'call_0', name: 'list_text_files', args: { limit: 2 } }, thoughtSignature: 'real-id-signature' },
    ];
    const service = await upstream((res, index) => {
      res.writeHead(200, { 'Content-Type': transport === 'sse' ? 'text/event-stream' : 'application/json' });
      res.end(transport === 'sse' ? sse(index === 0 ? first : finalResponse) : JSON.stringify(index === 0 ? first : finalResponse));
    });

    const result = await generateText(config(service.baseUrl), request(execute));

    expect(result.text).toBe('旅人沿着河岸继续前行。');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, { limit: 1 });
    expect(execute).toHaveBeenNthCalledWith(2, { limit: 2 });
    expect(service.bodies).toHaveLength(2);
    const responses = service.bodies[1].contents.at(-1).parts.filter((part: any) => part.functionResponse).map((part: any) => part.functionResponse);
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ name: 'list_text_files', response: { result: { files: [], total: 0 } } });
    expect(responses[0]).not.toHaveProperty('id');
    expect(responses[1]).toMatchObject({ id: 'call_0', name: 'list_text_files', response: { result: { files: [], total: 0 } } });
  });

  it.each(protocols)('keeps required-argument validation in the actual %s tool without resending', async protocol => {
    const execute = vi.fn((args: Record<string, unknown>) => {
      if (typeof args.path !== 'string' || !args.path) throw new Error('缺少必填参数 path。');
      return { text: '文件正文' };
    });
    const service = await upstream(res => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(toolResponse(undefined, protocol, 'read_text_file')));
    });
    const incoming = request(execute);
    incoming.tools![0].name = 'read_text_file';
    incoming.tools![0].parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    await expect(generateText(config(service.baseUrl, protocol), incoming)).rejects.toThrow('缺少必填参数 path。');
    expect(execute).toHaveBeenCalledExactlyOnceWith({});
    expect(service.bodies).toHaveLength(1);
  });
});
