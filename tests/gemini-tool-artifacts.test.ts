import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import { compileTaskPrompt, defaultPromptTemplates } from '../shared/prompt-templates.js';
import type { CapturedModelResponse, ModelActivityEvent, ModelToolContinuation, ProviderConfig } from '../shared/types.js';
import { generateText } from '../server/providers.js';
import { cleanToolOutputArtifacts } from '../shared/writing-output.js';
import { createStreamTextEmitter } from '../server/model-stream.js';

const artifact = ']]>🪒úm';
const doubled = `Sides${artifact}${artifact}`;
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
  const bodies: any[] = [];
  const raw: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const parts = reply(bodies.length - 1);
    // Split every UTF-16 unit into its own SSE event, including the emoji pair.
    const content = stream ? parts.flatMap((part: any) => typeof part.text === 'string' && !part.thought
      ? part.text.split('').map((text: string) => frame([{ text }]))
      : [frame([part])]).join('') + frame([], true, truncated) : JSON.stringify(envelope(parts, true, truncated));
    raw.push(content);
    response.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
    response.end(content);
  });
  servers.push(server);
  await listenLocalServer(server);
  const config: ProviderConfig = { id: 'local', name: '本地模拟', protocol: 'gemini', baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, model: 'test', maxOutputTokens: 2000, contextTokens: 64000, timeoutMs: 3000 };
  return { config, bodies, raw };
}

const compiled = (mode?: 'text') => {
  const templates = defaultPromptTemplates();
  if (mode) templates.presets.writing[0].writingOutputMode = mode;
  return compileTaskPrompt(templates, 'writing', { mode: 'original', instruction: '继续故事', context: '', maxWords: 1000 });
};

// Synthetic reproduction of the deployed wire shape. Never store private prose
// or the original request/response in a committed regression fixture.
const preamble = "Let's call `generate_scene_cg` here for the gate scene. Let's check the exact text to quote.）】}}}}";

describe.each([false, true])('Gemini illustration output artifacts, stream=%s', stream => {
  it.each(['text', 'carrier'] as const)('separates leaked tool commentary from %s prose before saving or continuing', async channel => {
    const request = compiled(channel === 'text' ? 'text' : undefined);
    const prose = ['信使到了城门。\n\n', '守卫为他开了门。'];
    const sink = request.responseCarrier;
    const service = await upstream(stream, round => {
      const content = prose[round] + (round ? '' : preamble);
      return [
        { thought: true, text: '核对画面。', thoughtSignature: `thought-${round}` },
        ...(sink ? [{ functionCall: { id: `output-${round}`, name: sink.name, args: { [sink.field]: content } } }] : [{ text: content }]),
        ...(!round ? [{ functionCall: { id: 'scene', name: 'generate_scene_cg', args: { sourceText: prose[0], prompt: '信使站在城门前。' } }, thoughtSignature: 'signed-scene' }] : []),
      ];
    });
    const execute = vi.fn(() => ({ status: 'requested' }));
    const captures: CapturedModelResponse[] = [];
    const checkpoints: ModelToolContinuation[] = [];
    const positions: number[] = [];
    let visible = '';
    const result = await generateText(service.config, {
      ...request, tools: [{ name: 'generate_scene_cg', description: '登记插画', parameters: { type: 'object' }, execute }],
      onTextDelta: text => { visible += text; expect(text).not.toMatch(/Let's|】|}/); },
      onActivity: event => { if (event.type === 'tool_call') positions.push(visible.length); },
      onResponse: response => captures.push(response), onContinuation: state => { checkpoints.push(state); },
    });
    expect(result.text).toBe(prose.join(''));
    expect(visible).toBe(result.text);
    expect(captures.map(response => response.text)).toEqual(prose);
    expect(captures.map(response => response.rawResponse)).toEqual(service.raw);
    expect(checkpoints.every(state => !state.text.includes('Let') && !state.text.includes('】'))).toBe(true);
    expect(positions).toEqual([prose[0].length]);
    expect(execute).toHaveBeenCalledExactlyOnceWith({ sourceText: prose[0], prompt: '信使站在城门前。' });
    expect(service.bodies).toHaveLength(2);
    const history = service.bodies[1].contents.find((message: any) => message.role === 'model' && message.parts.some((part: any) => part.functionCall?.name === 'generate_scene_cg')).parts;
    const rawText = sink ? history.find((part: any) => part.functionCall?.name === sink.name).functionCall.args[sink.field]
      : history.filter((part: any) => !part.thought && typeof part.text === 'string').map((part: any) => part.text).join('');
    expect(rawText).toBe(prose[0] + preamble);
    expect(history.find((part: any) => part.functionCall?.name === 'generate_scene_cg')).toMatchObject({ thoughtSignature: 'signed-scene', functionCall: { id: 'scene' } });
  });

  it('keeps clean prose after a truncated preamble turn without executing its tool', async () => {
    const service = await upstream(stream, () => [{ text: `已经返回的正文。${preamble}` }, { functionCall: { id: 'scene', name: 'generate_scene_cg', args: {} } }], true);
    const execute = vi.fn(); const captures: CapturedModelResponse[] = []; let visible = '';
    await expect(generateText(service.config, {
      ...compiled('text'), tools: [{ name: 'generate_scene_cg', description: '登记插画', parameters: { type: 'object' }, execute }],
      onTextDelta: text => { visible += text; }, onResponse: response => captures.push(response),
    })).rejects.toThrow(/截断|未完成/);
    expect(visible).toBe('已经返回的正文。');
    expect(captures[0]).toMatchObject({ text: visible, rawResponse: service.raw[0], incomplete: true });
    expect(execute).not.toHaveBeenCalled(); expect(service.bodies).toHaveLength(1);
  });

  it.each(['plain', 'carrier'] as const)('keeps %s prose clean across consecutive portrait and scene calls', async channel => {
    const request = compiled();
    const sink = request.responseCarrier!;
    const prose = ['信使到了。\n\n', '他推开门。\n\n', '灯亮了。'];
    const service = await upstream(stream, round => {
      const content = prose[round] + (round === 0 ? artifact : round === 1 ? doubled : '');
      return [
        { thought: true, text: '核对场景。', thoughtSignature: `thought-${round}` },
        ...(channel === 'plain' ? [{ text: content }] : [{ functionCall: { id: `output-${round}`, name: sink.name, args: { [sink.field]: content } }, thoughtSignature: `output-${round}` }]),
        ...(round < 2 ? [{ functionCall: { id: `image-${round}`, name: round ? 'generate_scene_cg' : 'generate_character_portrait', args: { description: '中性测试画面' } }, thoughtSignature: `image-${round}` }] : []),
      ];
    });
    const execute = vi.fn(() => ({ status: 'requested' }));
    const captures: CapturedModelResponse[] = [];
    const checkpoints: ModelToolContinuation[] = [];
    const positions: { name: string; offset: number }[] = [];
    let visible = '';
    const result = await generateText(service.config, {
      ...request,
      tools: ['generate_character_portrait', 'generate_scene_cg'].map(name => ({ name, description: '登记插画', parameters: { type: 'object' }, execute })),
      onTextDelta: text => { visible += text; },
      onActivity: event => { if (event.type === 'tool_call') positions.push({ name: event.name, offset: visible.length }); },
      onResponse: response => captures.push(response),
      onContinuation: state => { checkpoints.push(state); },
    });
    expect(result.text).toBe(prose.join(''));
    expect(visible).toBe(result.text);
    expect(captures.map(response => response.text)).toEqual(prose);
    expect(captures.map(response => response.rawResponse)).toEqual(service.raw);
    expect(checkpoints.every(state => !state.text.includes(artifact) && !state.text.includes('Sides'))).toBe(true);
    expect(positions).toEqual([{ name: 'generate_character_portrait', offset: prose[0].length }, { name: 'generate_scene_cg', offset: prose[0].length + prose[1].length }]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(service.bodies).toHaveLength(3);
    const history = service.bodies[1].contents.find((message: any) => message.role === 'model').parts;
    const historyText = channel === 'plain'
      ? history.filter((part: any) => !part.thought && typeof part.text === 'string').map((part: any) => part.text).join('')
      : history.find((part: any) => part.functionCall?.name === sink.name).functionCall.args[sink.field];
    expect(historyText).toBe(prose[0] + artifact);
    expect(history.find((part: any) => part.functionCall?.name === 'generate_character_portrait')).toMatchObject({ thoughtSignature: 'image-0', functionCall: { id: 'image-0' } });
    expect(result).toMatchObject({ inputTokens: 30, outputTokens: 15 });
  });

  it('does not let a longer artifact-only text channel hide a short valid carrier', async () => {
    const request = compiled();
    const sink = request.responseCarrier!;
    const service = await upstream(stream, () => [
      { text: doubled },
      { functionCall: { id: 'result', name: sink.name, args: { [sink.field]: '到了。' } }, thoughtSignature: 'signed-output' },
    ]);
    let visible = '';
    const captures: CapturedModelResponse[] = [];
    const result = await generateText(service.config, { ...request, onTextDelta: text => { visible += text; }, onResponse: response => captures.push(response) });
    expect(result.text).toBe('到了。');
    expect(visible).toBe(result.text);
    expect(captures[0].text).toBe(result.text);
    expect(captures[0].rawResponse).toBe(service.raw[0]);
    expect(service.bodies).toHaveLength(1);
  });

  it('accepts an artifact-only tool turn but rejects an artifact-only final reply without retrying', async () => {
    const request = compiled();
    const service = await upstream(stream, round => [
      { text: round ? doubled : artifact },
      ...(!round ? [{ functionCall: { id: 'portrait', name: 'generate_character_portrait', args: {} }, thoughtSignature: 'signed-portrait' }] : []),
    ]);
    const execute = vi.fn(() => ({ status: 'requested' }));
    let visible = '';
    const events: ModelActivityEvent[] = [];
    const captures: CapturedModelResponse[] = [];
    await expect(generateText(service.config, {
      ...request, tools: [{ name: 'generate_character_portrait', description: '登记立绘', parameters: { type: 'object' }, execute }],
      onTextDelta: text => { visible += text; }, onActivity: event => events.push(event), onResponse: response => captures.push(response),
    })).rejects.toThrow('没有正文');
    expect(visible).toBe('');
    expect(captures.map(response => response.text)).toEqual(['', '']);
    expect(events.filter(event => event.type === 'tool_result')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.bodies).toHaveLength(2);
  });

  it('retains cleaned partial prose after truncation without executing image tools', async () => {
    const request = compiled();
    const service = await upstream(stream, () => [
      { text: `已经返回的正文。${doubled}` },
      { functionCall: { id: 'portrait', name: 'generate_character_portrait', args: {} }, thoughtSignature: 'signed-portrait' },
    ], true);
    const execute = vi.fn();
    const captures: CapturedModelResponse[] = [];
    let visible = '';
    await expect(generateText(service.config, {
      ...request, tools: [{ name: 'generate_character_portrait', description: '登记立绘', parameters: { type: 'object' }, execute }],
      onTextDelta: text => { visible += text; }, onResponse: response => captures.push(response),
    })).rejects.toThrow(/截断|未完成/);
    expect(visible).toBe('已经返回的正文。');
    expect(captures[0]).toMatchObject({ text: visible, rawResponse: service.raw[0], incomplete: true });
    expect(execute).not.toHaveBeenCalled();
    expect(service.bodies).toHaveLength(1);
  });

  it('preserves quoted JSON evidence inside the result tool', async () => {
    const request = compiled();
    const sink = request.responseCarrier!;
    const content = JSON.stringify({ text: `原文“${doubled}”`, quote: `"${artifact}"` });
    const service = await upstream(stream, () => [{ functionCall: { id: 'result', name: sink.name, args: { [sink.field]: content } } }]);
    let visible = '';
    expect((await generateText(service.config, { ...request, onTextDelta: text => { visible += text; } })).text).toBe(content);
    expect(visible).toBe(content);
  });

  it('cleans custom text-mode tool replies without relying on a preset filter', async () => {
    const service = await upstream(stream, round => [
      { text: round ? '后文。' : `前文。${artifact}` },
      ...(!round ? [{ functionCall: { id: 'portrait', name: 'generate_character_portrait', args: {} } }] : []),
    ]);
    let visible = '';
    const execute = vi.fn(() => ({ status: 'requested' }));
    const result = await generateText(service.config, { system: '', prompt: '继续', tools: [{ name: 'generate_character_portrait', description: '登记立绘', parameters: { type: 'object' }, execute }], onTextDelta: text => { visible += text; } });
    expect(result.text).toBe('前文。后文。');
    expect(visible).toBe(result.text);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('leaves non-tool text replies unchanged', async () => {
    const service = await upstream(stream, () => [{ text: `原样文本${artifact}` }]);
    let visible = '';
    const result = await generateText(service.config, { system: '', prompt: '原样输出', onTextDelta: text => { visible += text; } });
    expect(result.text).toBe(`原样文本${artifact}`);
    expect(visible).toBe(result.text);
  });
});

describe('tool artifact recognition boundaries', () => {
  it.each([
    [`前文。${preamble}`, '前文。'],
    [`前文。${preamble.replace("Let's", 'Let’s')}`, '前文。'],
    [`“${preamble}”`, `“${preamble}”`],
    [`「${preamble}」`, `「${preamble}」`],
    [JSON.stringify({ text: preamble }), JSON.stringify({ text: preamble })],
    [preamble.replace('generate_scene_cg', 'unknown_tool'), preamble.replace('generate_scene_cg', 'unknown_tool')],
    ["Let's call `generate_scene_cg` in this example.", "Let's call `generate_scene_cg` in this example."],
    ['字符示例：）】}}}}', '字符示例：）】}}}}'],
    ["结尾 Let's", "结尾 Let's"],
  ])('uses tool identity and malformed envelope together through every split: %s', (raw, expected) => {
    expect(cleanToolOutputArtifacts(raw, true, ['generate_scene_cg'])).toBe(expected);
    for (let split = 0; split <= raw.length; split++) {
      let visible = '';
      const emit = createStreamTextEmitter('gemini', text => { visible += text; }, false, ['generate_scene_cg']);
      emit(frame([{ text: raw.slice(0, split) }]));
      expect(expected.startsWith(visible), `first delta at ${split}`).toBe(true);
      emit(frame([{ text: raw.slice(split) }]));
      expect(expected.startsWith(visible), `second delta at ${split}`).toBe(true);
      emit.finish(); expect(visible, `finished at ${split}`).toBe(expected);
    }
  });

  it.each([
    [`前文。${artifact}后文。`, '前文。后文。'],
    [`前文。${doubled}后文。`, '前文。后文。'],
    [`${artifact}${doubled}`, ''],
    ['Sides、side、]]>、🪒、úm 均是普通文本。', 'Sides、side、]]>、🪒、úm 均是普通文本。'],
    [`bothSides${artifact}`, 'bothSides'],
    [`"${doubled}"`, `"${doubled}"`],
    [JSON.stringify({ text: `引用 "${doubled}"` }), JSON.stringify({ text: `引用 "${doubled}"` })],
    ['结尾 Sides', '结尾 Sides'],
    ['结尾 ]]', '结尾 ]]'],
  ])('preserves normal text and literals through every split: %s', (raw, expected) => {
    expect(cleanToolOutputArtifacts(raw)).toBe(expected);
    for (let split = 0; split <= raw.length; split++) {
      let visible = '';
      const emit = createStreamTextEmitter('gemini', text => { visible += text; }, false, true);
      emit(frame([{ text: raw.slice(0, split) }]));
      expect(expected.startsWith(visible), `first delta at ${split}`).toBe(true);
      emit(frame([{ text: raw.slice(split) }]));
      expect(expected.startsWith(visible), `second delta at ${split}`).toBe(true);
      emit.finish();
      expect(visible, `finished at ${split}`).toBe(expected);
    }
  });
});
