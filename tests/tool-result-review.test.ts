import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import { buildRequestSnapshot, generateText } from '../server/providers.js';
import { TOOL_RESULT_REVIEW_INSTRUCTION } from '../shared/prompt-runtime.js';
import type { ModelActivityEvent, ModelRequest, ModelToolContinuation, ProviderConfig, ProviderProtocol } from '../shared/types.js';
import { WRITING_RESPONSE_NAME } from '../shared/writing-output.js';

const protocols: ProviderProtocol[] = ['openai-chat', 'openai-responses', 'gemini', 'claude'];
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const prose = ['前文。', '中段。', '结尾。'];
const signature = 'opaque-review-signature';
const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

function response(protocol: ProviderProtocol, index: number, layered: boolean, publicThought = true) {
  const text = prose[Math.min(index, 2)], thought = `第${index + 1}轮公开复核。`;
  const name = layered ? WRITING_RESPONSE_NAME : 'lookup';
  const args = layered ? { prose: text, toolCalls: index < 2 ? [{ name: 'lookup', argumentsJson: '{"id":"sample"}' }] : [] } : { id: 'sample' };
  const calls = index < 2 || layered;
  if (protocol === 'openai-chat') return { choices: [{ message: { role: 'assistant', content: layered ? '' : text, ...(publicThought ? { reasoning_content: thought } : {}), ...(calls ? { tool_calls: [{ id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'reasoning', id: 'same-id-each-round', summary: publicThought ? [{ type: 'summary_text', text: thought }] : [], encrypted_content: signature }, ...(layered ? [] : [{ type: 'message', content: [{ type: 'output_text', text }] }]), ...(calls ? [{ type: 'function_call', call_id: `call-${index}`, name, arguments: JSON.stringify(args) }] : [])], usage: { input_tokens: 10, output_tokens: 5 } };
  if (protocol === 'gemini') return { candidates: [{ content: { role: 'model', parts: [...(publicThought ? [{ thought: true, text: thought }] : []), ...(layered ? [] : [{ text }]), ...(calls ? [{ functionCall: { id: `call-${index}`, name, args }, thoughtSignature: signature }] : [])] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
  return { content: [...(publicThought ? [{ type: 'thinking', thinking: thought, signature }] : []), ...(layered ? [] : [{ type: 'text', text }]), ...(calls ? [{ type: 'tool_use', id: `call-${index}`, name, input: args }] : [])], stop_reason: calls ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
}

function streamed(protocol: ProviderProtocol, data: any) {
  if (protocol === 'openai-chat') return sse({ choices: [{ delta: data.choices[0].message, finish_reason: data.choices[0].finish_reason }], usage: data.usage }) + sse('[DONE]');
  if (protocol === 'openai-responses') return data.output.map((item: any, output_index: number) => item.type === 'reasoning'
    ? sse({ type: 'response.output_item.added', output_index, item })
    : item.type === 'message' ? sse({ type: 'response.output_text.delta', delta: item.content[0].text })
      : sse({ type: 'response.output_item.added', output_index, item })).join('') + sse({ type: 'response.completed', response: data });
  if (protocol === 'gemini') return sse(data);
  return sse({ type: 'message_start', message: { content: [], usage: { input_tokens: 10 } } }) + data.content.map((content_block: any, index: number) => sse({ type: 'content_block_start', index, content_block }) + sse({ type: 'content_block_stop', index })).join('') + sse({ type: 'message_delta', delta: { stop_reason: data.stop_reason }, usage: { output_tokens: 5 } }) + sse({ type: 'message_stop' });
}

async function fixture(protocol: ProviderProtocol, streaming: boolean, layered = false, omitLaterThoughts = false, thinkingUsage = 0) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const index = bodies.length - 1, data = response(protocol, index, layered, !omitLaterThoughts || index === 0);
    if (protocol === 'gemini' && thinkingUsage) Object.assign(data.usageMetadata!, { thoughtsTokenCount: thinkingUsage });
    res.writeHead(200, { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' });
    res.end(streaming ? streamed(protocol, data) : JSON.stringify(data));
  });
  servers.push(server); await listenLocalServer(server);
  const config: ProviderConfig = { id: 'local', name: '工具复核模拟', protocol, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, model: 'fixture', maxOutputTokens: 2000, contextTokens: 64000, stream: streaming, timeoutMs: 3000, ...(protocol === 'gemini' ? { geminiThinking: { mode: 'level', level: 'high' }, geminiIncludeThoughts: true } : protocol === 'claude' ? { claudeThinking: { type: 'adaptive' } } : { reasoningEffort: 'high' }) };
  return { config, bodies };
}

function latestResult(protocol: ProviderProtocol, body: any) {
  if (protocol === 'openai-chat') return { result: body.messages.at(-2), instruction: body.messages.at(-1)?.content };
  if (protocol === 'openai-responses') return { result: body.input.at(-2), instruction: body.input.at(-1)?.content };
  const parts = protocol === 'gemini' ? body.contents.at(-1).parts : body.messages.at(-1).content;
  return { result: parts[0], instruction: parts.at(-1)?.text };
}

const incoming = (execute: () => unknown, layered = false): ModelRequest => ({ system: '只根据真实资料写作。', prompt: '继续。', ...(layered ? { writingOutputMode: 'tool' } : {}), tools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' }, execute }] });

describe('reassessment after actual tool results', () => {
  for (const protocol of protocols) for (const streaming of [false, true]) for (const layered of [false, true]) {
    it(`${protocol} ${streaming ? 'SSE' : 'JSON'} ${layered ? 'layered' : 'native'} keeps each later thought, tool result and thinking setting`, async () => {
      const service = await fixture(protocol, streaming, layered);
      const execute = vi.fn().mockReturnValueOnce({ error: '需要另一条线索' }).mockReturnValueOnce({ location: '码头' });
      const events: ModelActivityEvent[] = [], positions: number[] = []; let visible = '';
      const result = await generateText(service.config, { ...incoming(execute, layered), ...(streaming ? { onTextDelta: (text: string) => { visible += text; } } : {}), onActivity: event => { events.push(event); if (event.type === 'thinking') positions.push(visible.length); } });
      expect(result).toEqual({ text: prose.join(''), inputTokens: 30, outputTokens: 15 });
      expect(execute).toHaveBeenCalledTimes(2); expect(service.bodies).toHaveLength(3);
      const thoughts = events.filter(event => event.type === 'thinking');
      expect(thoughts.map(event => event.text)).toEqual(['第1轮公开复核。', '第2轮公开复核。', '第3轮公开复核。']);
      expect(thoughts.map(event => event.id.split(':')[0])).toEqual(['round-1', 'round-2', 'round-3']);
      expect(events.filter(event => event.type === 'thinking_done').map(event => event.id)).toEqual(thoughts.map(event => event.id));
      expect(JSON.stringify(events)).not.toContain(signature);
      if (streaming) { expect(visible).toBe(result.text); expect(positions).toEqual([0, prose[0].length, prose[0].length + prose[1].length]); }
      for (const [index, body] of service.bodies.entries()) if (index) {
        expect(latestResult(protocol, body).instruction).toBe(TOOL_RESULT_REVIEW_INSTRUCTION);
        expect(JSON.stringify(body)).toContain(index === 1 ? '需要另一条线索' : '码头');
        expect(protocol === 'gemini' ? body.generationConfig : protocol === 'claude' ? body.thinking : body.reasoning ?? body.reasoning_effort).toEqual(protocol === 'gemini' ? service.bodies[0].generationConfig : protocol === 'claude' ? service.bodies[0].thinking : service.bodies[0].reasoning ?? service.bodies[0].reasoning_effort);
        if (protocol !== 'openai-chat') expect(JSON.stringify(body)).toContain(signature);
      }
    });
  }

  it.each(protocols)('%s upgrades an old completed tool checkpoint once without repeating the tool or changing saved history', async protocol => {
    const service = await fixture(protocol, false); const execute = vi.fn(() => ({ location: '码头' }));
    let saved!: ModelToolContinuation;
    await generateText(service.config, { ...incoming(execute), onContinuation: state => { saved = state; } });
    const body = saved.body as any;
    if (protocol === 'openai-chat') body.messages = body.messages.filter((message: any) => message.content !== TOOL_RESULT_REVIEW_INSTRUCTION);
    else if (protocol === 'openai-responses') body.input = body.input.filter((message: any) => message.content !== TOOL_RESULT_REVIEW_INSTRUCTION);
    else if (protocol === 'gemini') body.contents.forEach((message: any) => { message.parts = message.parts.filter((part: any) => part.text !== TOOL_RESULT_REVIEW_INSTRUCTION); });
    else body.messages.forEach((message: any) => { if (Array.isArray(message.content)) message.content = message.content.filter((part: any) => part.text !== TOOL_RESULT_REVIEW_INSTRUCTION); });
    const original = JSON.stringify(saved), request = { ...incoming(execute), continuation: saved };
    const preview = buildRequestSnapshot(service.config, request);
    expect(preview.body).toBe(buildRequestSnapshot(service.config, request).body);
    expect(latestResult(protocol, JSON.parse(preview.body)).instruction).toBe(TOOL_RESULT_REVIEW_INSTRUCTION);
    await generateText(service.config, request);
    expect(service.bodies).toHaveLength(4); expect(execute).toHaveBeenCalledTimes(2);
    expect(service.bodies.at(-1)).toEqual(JSON.parse(preview.body)); expect(JSON.stringify(saved)).toBe(original);
  });

  it.each(protocols)('%s never fabricates a second thought when the upstream returns none', async protocol => {
    const service = await fixture(protocol, true, false, true); const events: ModelActivityEvent[] = [];
    await generateText(service.config, { ...incoming(() => ({})), onActivity: event => events.push(event) });
    expect(events.filter(event => event.type === 'thinking').map(event => event.text)).toEqual(['第1轮公开复核。']);
    expect(latestResult(protocol, service.bodies[1]).instruction).toBe(TOOL_RESULT_REVIEW_INSTRUCTION);
    expect(service.bodies).toHaveLength(3);
    expect(events.filter(event => event.type === 'thinking_usage')).toHaveLength(0);
  });

  it.each([false, true])('Gemini streaming=%s records real thinking usage without inventing a summary or duplicating an available one', async streaming => {
    const service = await fixture('gemini', streaming, false, true, 116); const events: ModelActivityEvent[] = [];
    const result = await generateText(service.config, { ...incoming(() => ({})), onActivity: event => events.push(event) });
    expect(result.outputTokens).toBe(3 * (5 + 116));
    expect(events.filter(event => event.type === 'thinking_usage')).toEqual([
      { type: 'thinking_usage', id: 'round-2:gemini:usage', thinkingTokens: 116, afterTools: true },
      { type: 'thinking_usage', id: 'round-3:gemini:usage', thinkingTokens: 116, afterTools: true },
    ]);
    expect(events.filter(event => event.type === 'thinking').map(event => event.text)).toEqual(['第1轮公开复核。']);
    expect(service.bodies).toHaveLength(3);
  });
});
