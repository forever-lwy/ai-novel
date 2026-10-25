import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import { compileTaskPrompt, defaultPromptTemplates } from '../shared/prompt-templates.js';
import type { CapturedModelResponse, ModelToolContinuation, ProviderConfig } from '../shared/types.js';
import { generateText } from '../server/providers.js';
import { createStreamTextEmitter } from '../server/model-stream.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

function envelope(parts: unknown[], done = true, truncated = false) {
  return { candidates: [{ content: { role: 'model', parts }, ...(done ? { finishReason: truncated ? 'MAX_TOKENS' : 'STOP' } : {}) }], ...(done ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } : {}) };
}
const frame = (parts: unknown[], done = false, truncated = false) => `data: ${JSON.stringify(envelope(parts, done, truncated))}\n\n`;

async function upstream(stream: boolean, reply: (round: number) => unknown[], truncated = false) {
  const bodies: any[] = []; const raw: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const parts = reply(bodies.length - 1);
    const content = stream ? parts.map(part => frame([part])).join('') + frame([], true, truncated) : JSON.stringify(envelope(parts, true, truncated));
    raw.push(content);
    response.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' }); response.end(content);
  });
  servers.push(server); await listenLocalServer(server);
  const config: ProviderConfig = { id: 'local', name: '本地模拟', protocol: 'gemini', baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, model: 'test', maxOutputTokens: 2000, contextTokens: 64000, timeoutMs: 3000 };
  return { config, bodies, raw };
}
const compiled = (mode: 'text' | 'carrier') => {
  const templates = defaultPromptTemplates();
  if (mode === 'text') templates.presets.writing[0].writingOutputMode = 'text';
  return compileTaskPrompt(templates, 'writing', { mode: 'original', instruction: '继续故事', context: '', maxWords: 1000 });
};
// These are synthetic protocol fixtures. Never commit deployed private prose.
const unmarked = "Let's call `generate_scene_cg` now. Wait—did I close thought?）】}}}}";
const marker = 'Sides]]>🪒úm';

describe.each([false, true])('Gemini protocol boundaries without content guessing, stream=%s', stream => {
  it.each(['text', 'carrier'] as const)('preserves unmarked upstream %s text, raw diagnostics and signed history', async channel => {
    const request = compiled(channel); const sink = request.responseCarrier;
    const prose = [`信使来到城门。${unmarked}${marker}\n\n`, '守卫打开了门。'];
    const service = await upstream(stream, round => [
      { thought: true, text: '这里只是原生思考摘要。', thoughtSignature: `thought-${round}` },
      ...(sink ? [{ functionCall: { id: `output-${round}`, name: sink.name, args: { [sink.field]: prose[round] } } }] : [{ text: prose[round] }]),
      ...(!round ? [{ functionCall: { id: 'scene', name: 'generate_scene_cg', args: { sourceText: '信使来到城门。', prompt: '信使站在城门前。' } }, thoughtSignature: 'signed-scene' }] : []),
    ]);
    const execute = vi.fn(() => ({ status: 'requested' }));
    const captures: CapturedModelResponse[] = []; const checkpoints: ModelToolContinuation[] = []; const positions: number[] = []; let visible = '';
    const result = await generateText(service.config, { ...request,
      tools: [{ name: 'generate_scene_cg', description: '登记插画', parameters: { type: 'object' }, execute }],
      onTextDelta: text => { visible += text; }, onActivity: event => { if (event.type === 'tool_call') positions.push(visible.length); },
      onResponse: response => captures.push(response), onContinuation: state => { checkpoints.push(state); },
    });
    expect(result.text).toBe(prose.join('')); expect(visible).toBe(result.text);
    expect(captures.map(response => response.text)).toEqual(prose);
    expect(captures.map(response => response.rawResponse)).toEqual(service.raw);
    expect(checkpoints.some(state => state.text.includes(unmarked) && state.text.includes(marker))).toBe(true);
    expect(positions).toEqual([prose[0].length]);
    expect(execute).toHaveBeenCalledExactlyOnceWith({ sourceText: '信使来到城门。', prompt: '信使站在城门前。' });
    const history = service.bodies[1].contents.find((message: any) => message.role === 'model' && message.parts.some((part: any) => part.functionCall?.name === 'generate_scene_cg')).parts;
    expect(history.find((part: any) => part.functionCall?.name === 'generate_scene_cg')).toMatchObject({ thoughtSignature: 'signed-scene', functionCall: { id: 'scene' } });
    expect(history.filter((part: any) => part.thought).map((part: any) => part.text).join('')).toBe('这里只是原生思考摘要。');
    expect(result).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expect(service.bodies).toHaveLength(2);
  });

  it('separates real native thoughts and tool parameters from plain story text', async () => {
    const service = await upstream(stream, round => [
      { thought: true, text: '在原生思考中检查工具。', thoughtSignature: `thought-${round}` },
      { text: round ? '守卫点亮了灯。' : '信使来到城门。' },
      ...(!round ? [{ functionCall: { id: 'scene', name: 'generate_scene_cg', args: { sourceText: '信使来到城门。', prompt: '参数不能进入正文。' } }, thoughtSignature: 'signed-scene' }] : []),
    ]);
    const captures: CapturedModelResponse[] = []; let visible = '';
    const result = await generateText(service.config, { ...compiled('text'), tools: [{ name: 'generate_scene_cg', description: '登记插画', parameters: { type: 'object' }, execute: () => ({ status: 'requested', message: '真实工具结果。' }) }], onTextDelta: text => { visible += text; }, onResponse: response => captures.push(response) });
    expect(result.text).toBe('信使来到城门。守卫点亮了灯。'); expect(visible).toBe(result.text);
    expect(result.text).not.toMatch(/原生思考|参数|真实工具结果/);
    expect(captures.map(response => response.rawResponse)).toEqual(service.raw);
  });

  it('keeps incomplete unmarked text but never executes or retries a truncated image call', async () => {
    const service = await upstream(stream, () => [{ text: `已返回的正文。${unmarked}${marker}` }, { functionCall: { id: 'scene', name: 'generate_scene_cg', args: {} } }], true);
    const execute = vi.fn(); const captures: CapturedModelResponse[] = []; let visible = '';
    await expect(generateText(service.config, { ...compiled('text'), tools: [{ name: 'generate_scene_cg', description: '登记插画', parameters: { type: 'object' }, execute }], onTextDelta: text => { visible += text; }, onResponse: response => captures.push(response) })).rejects.toThrow(/截断|未完成/);
    expect(visible).toBe(`已返回的正文。${unmarked}${marker}`);
    expect(captures[0]).toMatchObject({ text: visible, rawResponse: service.raw[0], incomplete: true });
    expect(execute).not.toHaveBeenCalled(); expect(service.bodies).toHaveLength(1);
  });
});

it.each([unmarked, marker, JSON.stringify({ quote: `${unmarked}${marker}` })])('preserves words and quoted evidence across every SSE split: %s', raw => {
  for (let split = 0; split <= raw.length; split++) {
    let visible = ''; const emit = createStreamTextEmitter('gemini', text => { visible += text; });
    emit(frame([{ text: raw.slice(0, split) }])); emit(frame([{ text: raw.slice(split) }])); emit.finish();
    expect(visible).toBe(raw);
  }
});
