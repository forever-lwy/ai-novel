import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { ModelActivityEvent, ModelRequest, ModelToolContinuation, ProviderConfig, ProviderProtocol } from '../shared/types.js';
import { buildRequestSnapshot, estimateModelRequestInputTokens, generateText, ModelInteractionPause, ModelOutputError } from '../server/providers.js';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const config = (protocol: ProviderProtocol, baseUrl: string): ProviderConfig => ({ id: 'local', name: '续接测试', protocol, baseUrl, model: 'writer', maxOutputTokens: 1000, contextTokens: 64000, stream: false, timeoutMs: 1000, apiKey: 'fixture-secret' });
async function upstream(reply: (body: any, response: ServerResponse, index: number) => void) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    reply(body, response, bodies.length - 1);
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { bodies, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
}

const calls = [{ id: 'read-before', name: 'read_entity', args: { id: 'before' } }, { id: 'decision', name: 'ask_user', args: { question: '渡河还是留在岸边？' } }, { id: 'read-after', name: 'read_entity', args: { id: 'after' } }];
function toolTurn(protocol: ProviderProtocol) {
  if (protocol === 'openai-chat') return { choices: [{ message: { content: '你来到河边。', reasoning_content: '内部思考', tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'reasoning', id: 'reasoning', encrypted_content: 'signed-reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '你来到河边。' }] }, ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }))], usage: { input_tokens: 10, output_tokens: 2 } };
  if (protocol === 'gemini') return { candidates: [{ content: { parts: [{ text: '你来到河边。' }, ...calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: call.args }, thoughtSignature: 'signed-reasoning' }))] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
  return { content: [{ type: 'thinking', thinking: '内部思考', signature: 'signed-reasoning' }, { type: 'text', text: '你来到河边。' }, ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args }))], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } };
}
function prose(protocol: ProviderProtocol) {
  if (protocol === 'openai-chat') return { choices: [{ message: { content: '你决定渡河。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '你决定渡河。' }] }], usage: { input_tokens: 11, output_tokens: 4 } };
  if (protocol === 'gemini') return { candidates: [{ content: { parts: [{ text: '你决定渡河。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 } };
  return { content: [{ type: 'text', text: '你决定渡河。' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 4 } };
}
const request = (read: (args: Record<string, unknown>) => unknown, ask: () => unknown): ModelRequest => ({ system: '重要决定等待玩家选择。', prompt: '开始体验。', tools: [{ name: 'read_entity', description: '读取人物', parameters: { type: 'object' }, execute: read }, { name: 'ask_user', description: '询问玩家', parameters: { type: 'object' }, execute: ask }] });

describe('persistent human decisions inside provider tool rounds', () => {
  it.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('%s resumes the exact unfinished tool turn without repeating prose, prior tools or requests', async protocol => {
    const service = await upstream((_body, response, index) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(index === 0 ? toolTurn(protocol) : prose(protocol))); });
    const model = config(protocol, service.baseUrl);
    let persisted!: ModelToolContinuation;
    const checkpoints: ModelToolContinuation[] = [];
    const deltas: string[] = [], activities: ModelActivityEvent[] = [];
    const read = vi.fn((args: Record<string, unknown>) => ({ name: args.id }));
    const ask = vi.fn(() => { throw new ModelInteractionPause(); });
    const store = vi.fn(async (state: ModelToolContinuation) => { checkpoints.push(state); persisted = JSON.parse(JSON.stringify(state)); });
    const first = await generateText(model, { ...request(read, ask), onContinuation: store, onTextDelta: text => deltas.push(text), onActivity: event => activities.push(event) }).catch(error => error);
    expect(first).toBeInstanceOf(ModelInteractionPause); expect(first).not.toBeInstanceOf(ModelOutputError);
    expect(first).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    expect(service.bodies).toHaveLength(1); expect(read).toHaveBeenCalledTimes(1); expect(ask).toHaveBeenCalledTimes(1);
    expect(persisted).toMatchObject({ protocol, model: 'writer', round: 1, callCount: 3, text: '你来到河边。', inputTokens: 10, outputTokens: 2, pending: { nextIndex: 1, results: [{ call: { id: 'read-before' } }] } });
    expect(checkpoints[0].pending?.nextIndex).toBe(0); expect(checkpoints[0].pending?.results).toHaveLength(0);
    expect(JSON.stringify(persisted)).not.toContain('fixture-secret'); expect(persisted).not.toHaveProperty('headers');
    expect(activities.filter(event => event.type === 'tool_result' && event.error)).toEqual([]);
    const initialContinuation = structuredClone(persisted);
    const answer = vi.fn(() => ({ answer: '渡河' }));
    const result = await generateText(model, { ...request(read, answer), continuation: persisted, onContinuation: store, onTextDelta: text => deltas.push(text) });
    expect(result).toEqual({ text: '你来到河边。你决定渡河。', inputTokens: 21, outputTokens: 6 });
    expect(deltas).toEqual(['你来到河边。', '你决定渡河。']); expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls).toEqual([[{ id: 'before' }], [{ id: 'after' }]]);
    expect(answer).toHaveBeenCalledTimes(1); expect(service.bodies).toHaveLength(2);
    expect(initialContinuation.pending?.nextIndex).toBe(1); expect(initialContinuation.pending?.results).toHaveLength(1);
    const resumedBody = service.bodies[1]; expect(JSON.stringify(resumedBody)).toContain('渡河'); expect(JSON.stringify(resumedBody)).toContain('read-before'); expect(JSON.stringify(resumedBody)).toContain('read-after');
    if (protocol === 'openai-chat') { expect(resumedBody.messages.at(-4).reasoning_content).toBe('内部思考'); expect(resumedBody.messages.slice(-3).map((message: any) => message.tool_call_id)).toEqual(['read-before', 'decision', 'read-after']); }
    else expect(JSON.stringify(resumedBody)).toContain('signed-reasoning');
    expect(persisted.pending).toBeUndefined(); expect(persisted.round).toBe(1); expect(persisted.callCount).toBe(3);
    expect(JSON.parse(buildRequestSnapshot(model, { ...request(read, answer), continuation: persisted }).body)).toEqual(resumedBody);
    expect(estimateModelRequestInputTokens(model, { ...request(read, answer), continuation: persisted })).toBeGreaterThan(estimateModelRequestInputTokens(model, request(read, answer)));
  });

  it('rejects changed protocols or model names before executing tools or sending a request', async () => {
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(toolTurn('openai-chat'))); });
    let continuation!: ModelToolContinuation;
    const read = vi.fn(() => ({}));
    await expect(generateText(config('openai-chat', service.baseUrl), { ...request(read, () => { throw new ModelInteractionPause(); }), onContinuation: state => { continuation = state; } })).rejects.toBeInstanceOf(ModelInteractionPause);
    const ask = vi.fn(() => ({})); read.mockClear();
    for (const model of [{ ...config('openai-chat', service.baseUrl), model: 'other-writer' }, config('claude', service.baseUrl)]) {
      await expect(generateText(model, { ...request(read, ask), continuation })).rejects.toThrow('已改变');
    }
    expect(service.bodies).toHaveLength(1); expect(read).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled();
  });

  it('persists before tool execution and stops if saving the checkpoint fails', async () => {
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(toolTurn('openai-chat'))); });
    const read = vi.fn(() => ({})), ask = vi.fn(() => ({}));
    await expect(generateText(config('openai-chat', service.baseUrl), { ...request(read, ask), onContinuation: async () => { throw new Error('模拟存储失败'); } })).rejects.toMatchObject({ name: 'ModelOutputError', message: '模拟存储失败', inputTokens: 10, outputTokens: 2 });
    expect(read).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled(); expect(service.bodies).toHaveLength(1);
  });

  it('keeps resumed prior usage and newly billed failed-request usage visible', async () => {
    const service = await upstream((_body, response, index) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(index === 0 ? toolTurn('openai-chat') : { choices: [{ message: { content: '截断' }, finish_reason: 'length' }], usage: { prompt_tokens: 11, completion_tokens: 4 } })); });
    let continuation!: ModelToolContinuation;
    await expect(generateText(config('openai-chat', service.baseUrl), { ...request(() => ({}), () => { throw new ModelInteractionPause(); }), onContinuation: state => { continuation = state; } })).rejects.toBeInstanceOf(ModelInteractionPause);
    await expect(generateText(config('openai-chat', service.baseUrl), { ...request(() => ({}), () => ({ answer: '渡河' })), continuation })).rejects.toMatchObject({ name: 'ModelOutputError', inputTokens: 21, outputTokens: 6 });
    expect(service.bodies).toHaveLength(2);
  });

  it('supports more than six persisted decisions when RPG explicitly allows more rounds', async () => {
    const service = await upstream((_body, response, index) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(index < 7 ? toolTurn('openai-chat') : prose('openai-chat'))); });
    let continuation: ModelToolContinuation | undefined, answered = false;
    const read = vi.fn(() => ({}));
    const ask = vi.fn(() => { if (!answered) throw new ModelInteractionPause(); answered = false; return { answer: '渡河' }; });
    const incoming = { ...request(read, ask), maxToolRounds: 24, onContinuation: (state: ModelToolContinuation) => { continuation = state; } };
    await expect(generateText(config('openai-chat', service.baseUrl), incoming)).rejects.toBeInstanceOf(ModelInteractionPause);
    for (let index = 1; index <= 7; index++) {
      answered = true;
      const outcome = await generateText(config('openai-chat', service.baseUrl), { ...incoming, continuation }).catch(error => error);
      if (index < 7) expect(outcome).toMatchObject({ name: 'ModelInteractionPause', inputTokens: (index + 1) * 10, outputTokens: (index + 1) * 2 });
      else expect(outcome).toMatchObject({ text: '你来到河边。'.repeat(7) + '你决定渡河。', inputTokens: 81, outputTokens: 18 });
    }
    expect(service.bodies).toHaveLength(8); expect(read).toHaveBeenCalledTimes(14); expect(ask).toHaveBeenCalledTimes(14);
    expect(continuation).toMatchObject({ round: 7, callCount: 21 });
  });

  it('caps an explicit round allowance at twenty-four billable requests', async () => {
    const service = await upstream((_body, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(toolTurn('openai-chat'))); });
    const read = vi.fn(() => ({})), ask = vi.fn(() => ({ answer: '渡河' }));
    await expect(generateText(config('openai-chat', service.baseUrl), { ...request(read, ask), maxToolRounds: 999 })).rejects.toMatchObject({ name: 'ModelOutputError', message: expect.stringContaining('次数超过上限'), inputTokens: 240, outputTokens: 48 });
    expect(service.bodies).toHaveLength(24); expect(read).toHaveBeenCalledTimes(46); expect(ask).toHaveBeenCalledTimes(23);
  });

  it.each(['missing', 'input-only', 'output-only'] as const)('estimates only missing RPG usage (%s) and preserves its cumulative flag after a decision', async usageMode => {
    const service = await upstream((_body, response, index) => {
      const data: any = index === 0 ? toolTurn('openai-chat') : prose('openai-chat');
      if (index === 0) data.usage = usageMode === 'input-only' ? { prompt_tokens: 10 } : usageMode === 'output-only' ? { completion_tokens: 2 } : undefined;
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
    });
    let continuation!: ModelToolContinuation;
    const incoming = { ...request(() => ({}), () => { throw new ModelInteractionPause(); }), onContinuation: (state: ModelToolContinuation) => { continuation = state; } };
    const pause = await generateText(config('openai-chat', service.baseUrl), incoming).catch(error => error);
    expect(pause).toBeInstanceOf(ModelInteractionPause); expect(pause.usageEstimated).toBe(true);
    expect(pause.inputTokens).toBeGreaterThan(0); expect(pause.outputTokens).toBeGreaterThan(0);
    if (usageMode === 'input-only') expect(pause.inputTokens).toBe(10);
    if (usageMode === 'output-only') expect(pause.outputTokens).toBe(2);
    expect(continuation).toMatchObject({ inputTokens: pause.inputTokens, outputTokens: pause.outputTokens, usageEstimated: true });
    const result = await generateText(config('openai-chat', service.baseUrl), { ...request(() => ({}), () => ({ answer: '渡河' })), continuation, onContinuation: state => { continuation = state; } });
    expect(result).toEqual({ text: '你来到河边。你决定渡河。', inputTokens: pause.inputTokens + 11, outputTokens: pause.outputTokens + 4, usageEstimated: true });
    expect(service.bodies).toHaveLength(2);
  });

  it('retains ordinary writing usage behavior when persistent continuations are disabled', async () => {
    const service = await upstream((_body, response, index) => {
      const data: any = index === 0 ? toolTurn('openai-chat') : prose('openai-chat'); delete data.usage;
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
    });
    expect(await generateText(config('openai-chat', service.baseUrl), request(() => ({}), () => ({ answer: '渡河' })))).toEqual({ text: '你来到河边。你决定渡河。', inputTokens: 0, outputTokens: 0 });
  });
});
