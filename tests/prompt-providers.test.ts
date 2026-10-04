import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { ModelRequest, PromptMessage, ProviderConfig, ProviderProtocol } from '../shared/types.js';
import { buildRequestSnapshot, estimateModelRequestInputTokens, generateStructured, generateText, structuredRequest } from '../server/providers.js';

const protocols: ProviderProtocol[] = ['openai-chat', 'openai-responses', 'gemini', 'claude'];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const config = (protocol: ProviderProtocol, baseUrl = 'http://127.0.0.1:1'): ProviderConfig => ({ id: 'test', name: '提示词协议测试', protocol, baseUrl, model: 'example', stream: false, timeoutMs: 1000, contextTokens: 64000, maxOutputTokens: 1000 });
const messages: PromptMessage[] = [
  { role: 'system', content: '第一段创作规则。' },
  { role: 'user', content: '示例问题。' },
  { role: 'assistant', content: '示例回答。' },
  { role: 'system', content: '第二段文风规则。' },
  { role: 'user', content: '作品背景。' },
  { role: 'user', content: '本次写作要求。' },
];
const request: ModelRequest = { system: '旧的系统提示，不应重复发送。', prompt: '旧的用户提示，不应重复发送。', messages };
const system = '第一段创作规则。\n\n第二段文风规则。';
const instruction = '本次返回必须是符合要求的单个 JSON 对象。不要输出解释文字或 Markdown。';

const wireBody = (protocol: ProviderProtocol, incoming = request) => JSON.parse(buildRequestSnapshot(config(protocol), incoming).body);
const conversation = (protocol: ProviderProtocol, body: any): any[] => protocol === 'openai-responses' ? body.input : protocol === 'gemini' ? body.contents : body.messages;
const nativeMessages = (protocol: ProviderProtocol) => protocol === 'openai-chat' || protocol === 'openai-responses' ? messages : protocol === 'gemini'
  ? messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }))
  : messages.filter(message => message.role !== 'system');

function prose(protocol: ProviderProtocol, text = '阿青走向港口。') {
  if (protocol === 'openai-chat') return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 11, output_tokens: 4 } };
  if (protocol === 'gemini') return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 } };
  return { type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 4 } };
}

function toolReply(protocol: ProviderProtocol, index: number) {
  const id = `lookup-${index}`; const name = 'read_entity'; const args = { id: `person-${index}` }; const signature = `signature-${index}`;
  if (protocol === 'openai-chat') return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'reasoning', id: `reasoning-${index}`, encrypted_content: signature }, { type: 'function_call', id: `item-${index}`, call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 10, output_tokens: 2 } };
  if (protocol === 'gemini') return { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id, name, args }, thoughtSignature: signature }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
  return { type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: '思考资料', signature }, { type: 'tool_use', id, name, input: args }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } };
}

async function upstream(reply: (index: number) => unknown) {
  const bodies: any[] = [];
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply(bodies.length - 1)));
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { bodies, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
}

describe('compiled prompt messages in native provider requests', () => {
  it.each(protocols)('%s preserves custom roles, examples and message order without legacy duplicates', protocol => {
    const body = wireBody(protocol);
    expect(conversation(protocol, body)).toEqual(nativeMessages(protocol));
    expect(JSON.stringify(body)).not.toContain(request.system);
    expect(JSON.stringify(body)).not.toContain(request.prompt);
    if (protocol === 'openai-responses') expect(body).not.toHaveProperty('instructions');
    if (protocol === 'gemini') expect(body.systemInstruction).toEqual({ parts: [{ text: system }] });
    if (protocol === 'claude') expect(body.system).toBe(system);
  });

  it.each<ProviderProtocol>(['gemini', 'claude'])('%s omits native system instructions when no system block is enabled', protocol => {
    const body = wireBody(protocol, { ...request, messages: messages.filter(message => message.role !== 'system') });
    expect(body).not.toHaveProperty(protocol === 'gemini' ? 'systemInstruction' : 'system');
    expect(conversation(protocol, body)).toEqual(nativeMessages(protocol));
  });

  it.each(protocols)('%s retains the legacy wire layout for absent or empty messages', protocol => {
    const legacy = { system: request.system, prompt: request.prompt };
    expect(wireBody(protocol, { ...legacy, messages: [] })).toEqual(wireBody(protocol, legacy));
    const body = wireBody(protocol, legacy);
    if (protocol === 'openai-chat') expect(body.messages).toEqual([{ role: 'system', content: legacy.system }, { role: 'user', content: legacy.prompt }]);
    if (protocol === 'openai-responses') expect(body).toMatchObject({ instructions: legacy.system, input: legacy.prompt });
    if (protocol === 'gemini') expect(body).toMatchObject({ systemInstruction: { parts: [{ text: legacy.system }] }, contents: [{ role: 'user', parts: [{ text: legacy.prompt }] }] });
    if (protocol === 'claude') expect(body).toMatchObject({ system: legacy.system, messages: [{ role: 'user', content: legacy.prompt }] });
  });

  it.each(protocols)('%s estimates all compiled messages from the actual native body', protocol => {
    const incoming = { ...request, system: '旧'.repeat(5000), prompt: '旧'.repeat(5000), messages: [...messages, { role: 'assistant' as const, content: '示例'.repeat(3000) }] };
    const body = wireBody(protocol, incoming);
    const estimate = Math.ceil([...JSON.stringify(body)].reduce((sum, char) => sum + (char.charCodeAt(0) > 127 ? 1.3 : 0.3), 0));
    expect(estimateModelRequestInputTokens(config(protocol), incoming)).toBe(estimate);
    expect(estimate).toBeGreaterThan(7000);
    expect(estimateModelRequestInputTokens(config(protocol), { ...incoming, system: '', prompt: '' })).toBe(estimate);
  });

  it.each(protocols)('%s rejects a compiled message that exceeds the tool request context before sending', async protocol => {
    const service = await upstream(() => prose(protocol));
    const execute = vi.fn(() => ({}));
    const incoming = { ...request, messages: [...messages, { role: 'assistant' as const, content: '示例'.repeat(3000) }], tools: [{ name: 'read_entity', description: '资料检索', parameters: { type: 'object' }, execute }] };
    await expect(generateText({ ...config(protocol, service.baseUrl), contextTokens: 4000 }, incoming)).rejects.toThrow('上下文上限');
    expect(service.bodies).toEqual([]); expect(execute).not.toHaveBeenCalled();
  });
});

describe('compiled prompt messages across tool continuations', () => {
  it.each(protocols)('%s keeps initial examples and both previous tool rounds without mutating the preset', async protocol => {
    const service = await upstream(index => index < 2 ? toolReply(protocol, index) : prose(protocol));
    const execute = vi.fn(args => ({ name: `人物-${args.id}` }));
    const incoming: ModelRequest = { ...request, messages: structuredClone(messages), tools: [{ name: 'read_entity', description: '资料检索', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, execute }] };
    const original = structuredClone(incoming.messages);
    expect(await generateText(config(protocol, service.baseUrl), incoming)).toEqual({ text: '阿青走向港口。', inputTokens: 31, outputTokens: 8 });
    expect(execute.mock.calls).toEqual([[{ id: 'person-0' }], [{ id: 'person-1' }]]);
    expect(service.bodies).toHaveLength(3);
    const first = conversation(protocol, service.bodies[0]);
    expect(first).toEqual(nativeMessages(protocol));
    for (const [round, body] of service.bodies.entries()) {
      const sequence = conversation(protocol, body);
      expect(sequence.slice(0, first.length)).toEqual(first);
      expect(JSON.stringify(body)).not.toContain(request.system); expect(JSON.stringify(body)).not.toContain(request.prompt);
      if (round > 0) {
        const previous = conversation(protocol, service.bodies[round - 1]);
        expect(sequence.slice(0, previous.length)).toEqual(previous);
        expect(JSON.stringify(sequence)).toContain(`lookup-${round - 1}`);
        expect(JSON.stringify(sequence)).toContain(`人物-person-${round - 1}`);
        if (protocol !== 'openai-chat') expect(JSON.stringify(sequence)).toContain(`signature-${round - 1}`);
      }
      if (protocol === 'claude') expect(body.system).toBe(system);
      if (protocol === 'gemini') expect(body.systemInstruction).toEqual({ parts: [{ text: system }] });
    }
    expect(incoming.messages).toEqual(original);
  });
});

describe('structured prompt normalization before budgeting', () => {
  it('adds one required system block without changing user blocks or mutating the request', () => {
    const normalized = structuredRequest(request);
    expect(normalized.messages).toEqual([...messages, { role: 'system', content: instruction }]);
    expect(structuredRequest(normalized)).toBe(normalized);
    expect(request.messages).toBe(messages); expect(messages).toHaveLength(6);
    expect(structuredRequest({ ...request, system: instruction }).messages).toEqual(normalized.messages);
  });

  it('recognizes the constraint within an edited system block, while an assistant example does not replace it', () => {
    const normalized = { ...request, messages: [{ role: 'system' as const, content: `要求：\n${instruction}` }, ...messages] };
    expect(structuredRequest(normalized)).toBe(normalized);
    const example = { ...request, messages: [{ role: 'assistant' as const, content: instruction }, ...messages] };
    expect(structuredRequest(example).messages?.at(-1)).toEqual({ role: 'system', content: instruction });
  });

  it.each([undefined, []] as (PromptMessage[] | undefined)[])('retains legacy layout and applies its constraint once for messages=%j', empty => {
    const normalized = structuredRequest({ system: '资料规则', prompt: '章节内容', messages: empty });
    expect(normalized.system).toBe(`资料规则\n\n${instruction}`);
    expect(normalized.messages).toEqual(empty);
    expect(structuredRequest(normalized)).toBe(normalized);
  });

  it.each(protocols)('%s sends the JSON constraint once after repeated normalization', async protocol => {
    const service = await upstream(() => prose(protocol, '{"summary":"港口相遇"}'));
    const incoming = structuredRequest(structuredRequest(request));
    const model = config(protocol, service.baseUrl);
    const before = estimateModelRequestInputTokens(model, incoming);
    expect(await generateStructured(model, incoming, value => value)).toEqual({ value: { summary: '港口相遇' }, inputTokens: 11, outputTokens: 4 });
    expect(service.bodies).toHaveLength(1);
    expect(JSON.stringify(service.bodies[0]).split(instruction)).toHaveLength(2);
    expect(service.bodies[0]).toEqual(JSON.parse(buildRequestSnapshot(model, incoming).body));
    expect(estimateModelRequestInputTokens(model, structuredRequest(incoming))).toBe(before);
    expect(before).toBeGreaterThan(estimateModelRequestInputTokens(model, request));
  });
});
