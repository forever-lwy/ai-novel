import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import type { ModelActivityEvent, ModelRequest, ModelToolContinuation, ProviderConfig, ProviderProtocol } from '../shared/types.js';
import { buildRequestSnapshot, generateStructured, generateText, ModelInteractionPause } from '../server/providers.js';
import { partialWritingProse, unpackWritingResponse, WRITING_RESPONSE_NAME } from '../shared/writing-output.js';
import { compileTaskPrompt, defaultPromptTemplates } from '../shared/prompt-templates.js';
import { V08_PRESET_ID } from '../shared/v08-prompts.js';

const protocols: ProviderProtocol[] = ['openai-chat', 'openai-responses', 'gemini', 'claude'];
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const config = (protocol: ProviderProtocol, baseUrl: string): ProviderConfig => ({ id: 'local', name: '隔离测试', protocol, baseUrl, model: 'writer', maxOutputTokens: 2000, contextTokens: 64000, timeoutMs: 3000 });
const payload = (prose: string, tool = '') => ({ prose, toolCalls: tool ? [{ name: tool, argumentsJson: '{"id":"person"}' }] : [] });
const request = (execute = vi.fn(() => ({ name: '林舟', location: '码头' }))): ModelRequest => ({ system: '正文通过工具通道提交。', prompt: '写下一章。', writingOutputMode: 'tool', tools: [{ name: 'read_entity', description: '查询人物', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, execute }] });
async function upstream(reply: (index: number, body: any, response: ServerResponse) => void | Promise<void>) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); await reply(bodies.length - 1, body, res); });
  servers.push(server); await listenLocalServer(server);
  return { bodies, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
}
function response(protocol: ProviderProtocol, args: unknown, id = 'outer-1', toolName = WRITING_RESPONSE_NAME) {
  if (protocol === 'openai-chat') return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: toolName, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque-signature' }, { type: 'function_call', id: 'item-1', call_id: id, name: toolName, arguments: typeof args === 'string' ? args : JSON.stringify(args) }], usage: { input_tokens: 10, output_tokens: 5 } };
  if (protocol === 'gemini') return { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id, name: toolName, args }, thoughtSignature: 'opaque-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
  return { content: [{ type: 'thinking', thinking: '核对场景', signature: 'opaque-signature' }, { type: 'tool_use', id, name: toolName, input: args }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } };
}
function plainResponse(protocol: ProviderProtocol, text: string) {
  if (protocol === 'openai-chat') return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 } };
  if (protocol === 'gemini') return { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
}
function streamStart(protocol: ProviderProtocol, args: string) {
  if (protocol === 'openai-chat') return sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'outer-1', type: 'function', function: { name: WRITING_RESPONSE_NAME, arguments: args } }] } }] });
  if (protocol === 'openai-responses') return sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'item-1', call_id: 'outer-1', name: WRITING_RESPONSE_NAME, arguments: '' } }) + sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: args });
  if (protocol === 'gemini') return sse({ candidates: [{ content: { parts: [{ functionCall: { id: 'outer-1', name: WRITING_RESPONSE_NAME, args: JSON.parse(args) }, thoughtSignature: 'opaque-signature' }] } }] });
  return sse({ type: 'message_start', message: { content: [], usage: { input_tokens: 10 } } }) + sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'outer-1', name: WRITING_RESPONSE_NAME, input: {} } }) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } });
}
function streamEnd(protocol: ProviderProtocol, tail: string, full: unknown) {
  if (protocol === 'openai-chat') return (tail ? sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: tail } }] } }] }) : '') + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + sse('[DONE]');
  if (protocol === 'openai-responses') return (tail ? sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: tail }) : '') + sse({ type: 'response.completed', response: response(protocol, full) });
  if (protocol === 'gemini') return sse({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
  return (tail ? sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: tail } }) : '') + sse({ type: 'content_block_stop', index: 0 }) + sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }) + sse({ type: 'message_stop' });
}

describe('layered writing tool transport', () => {
  describe.each(protocols)('%s v0.8 general output transport', protocol => {
    it.each(['extraction', 'compression'] as const)('unwraps %s JSON through the real HTTP adapter with no confirmation request', async task => {
      const expected = task === 'extraction' ? { summary: '到达石桥。', entities: [], relations: [], foreshadows: [] } : { text: '到达石桥。' };
      const service = await upstream((_index, _body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response(protocol, payload(JSON.stringify(expected))))); });
      const templates = defaultPromptTemplates(); templates.general!.selected = V08_PRESET_ID;
      const compiled = compileTaskPrompt(templates, task, { blockText: '[1] 到达石桥。', summaryText: '到达石桥。', context: '', chapterTitle: '石桥' });
      const result = await generateStructured(config(protocol, service.baseUrl), compiled, value => value);
      expect(result.value).toEqual(expected); expect(service.bodies).toHaveLength(1);
      expect(service.bodies[0]).toEqual(JSON.parse(buildRequestSnapshot(config(protocol, service.baseUrl), compiled).body));
    });
    it('streams v0.8 auxiliary content into author activities while executing a real inner tool', async () => {
      const service = await upstream((index, _body, res) => {
        const value = payload(index ? '后文。' : '<draft>任务已就绪。</draft>前文。', index ? '' : 'read_entity');
        const raw = JSON.stringify(value); const split = protocol === 'gemini' ? raw.length : raw.indexOf('绪');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(streamStart(protocol, raw.slice(0, split)) + streamEnd(protocol, raw.slice(split), value));
      });
      const templates = defaultPromptTemplates(); templates.general!.selected = V08_PRESET_ID;
      const compiled = compileTaskPrompt(templates, 'writing', { mode: 'original', instruction: '继续', context: '资料', maxWords: 1000 });
      const execute = vi.fn(() => ({ name: '林舟' })); const events: ModelActivityEvent[] = []; let prose = '';
      const result = await generateText(config(protocol, service.baseUrl), { ...request(execute), ...compiled, onTextDelta: text => { prose += text; }, onActivity: event => events.push(event) });
      expect(result.text).toBe('前文。后文。'); expect(prose).toBe(result.text); expect(service.bodies).toHaveLength(2);
      expect(execute).toHaveBeenCalledExactlyOnceWith({ id: 'person' });
      expect(events.filter(event => event.type === 'thinking' && event.thinkingSource === 'preset').map(event => event.text).join('')).toBe('任务已就绪。');
    });
  });
  it.each(protocols)('%s exposes streamed preset thoughts and executed inner search/image tools in prose order', async protocol => {
    const first = { prose: '前文。<thinking>先核对人物资料。</thinking>中段。', toolCalls: [
      { name: 'read_entity', argumentsJson: '{"id":"person"}' },
      { name: 'generate_character_portrait', argumentsJson: '{"name":"林舟"}' },
    ] };
    const last = payload('<think>按真实工具结果继续。</think>结尾。');
    const service = await upstream((index, _body, res) => {
      const value = index ? last : first;
      const raw = JSON.stringify(value); const split = protocol === 'gemini' ? raw.length : raw.indexOf('toolCalls');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(streamStart(protocol, raw.slice(0, split)) + streamEnd(protocol, raw.slice(split), value));
    });
    const events: ModelActivityEvent[] = []; const thoughts = new Map<string, { text: string; offset: number }>(); let visible = '';
    const execute = vi.fn(() => ({ name: '林舟' })); const portrait = vi.fn(() => ({ status: 'requested' }));
    const base = request(execute); base.tools!.push({ name: 'generate_character_portrait', description: '登记立绘', parameters: { type: 'object', properties: { name: { type: 'string' } } }, execute: portrait });
    const result = await generateText(config(protocol, service.baseUrl), { ...base, textFilter: 'dramatron', onTextDelta: value => { visible += value; }, onActivity: event => {
      events.push(event);
      if (event.type === 'thinking' && event.thinkingSource === 'preset') { const thought = thoughts.get(event.id) ?? { text: '', offset: visible.length }; thought.text += event.text; thoughts.set(event.id, thought); }
    } });
    expect(visible).toBe('前文。中段。结尾。'); expect(result.text).toBe(visible);
    expect([...thoughts.values()]).toEqual([{ text: '先核对人物资料。', offset: 3 }, { text: '按真实工具结果继续。', offset: 6 }]);
    expect(events.filter(event => event.type === 'thinking_done')).toHaveLength(2);
    expect(events.filter(event => event.type === 'tool_call').map(event => event.name)).toEqual(['read_entity', 'generate_character_portrait']);
    expect(events.filter(event => event.type === 'tool_result').map(event => event.result)).toEqual([{ name: '林舟' }, { status: 'requested' }]);
    expect(execute).toHaveBeenCalledExactlyOnceWith({ id: 'person' }); expect(portrait).toHaveBeenCalledExactlyOnceWith({ name: '林舟' });
    expect(service.bodies).toHaveLength(2); expect(JSON.stringify(service.bodies[1])).toContain('toolResults');
  });

  it.each(protocols)('%s exposes ordinary JSON preset thoughts once, even without a prose callback', async protocol => {
    const service = await upstream((_index, _body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(plainResponse(protocol, '前文。<thinking>文本中的辅助核对。</thinking>结尾。'))); });
    const events: ModelActivityEvent[] = [];
    const result = await generateText(config(protocol, service.baseUrl), { system: '中性写作', prompt: '继续', textFilter: 'dramatron', onActivity: event => events.push(event) });
    expect(result.text).toBe('前文。结尾。');
    expect(events).toEqual([{ type: 'thinking', id: 'round-1:preset:0', text: '文本中的辅助核对。', thinkingSource: 'preset' }, { type: 'thinking_done', id: 'round-1:preset:0' }]);
  });
  it('preserves paragraph boundaries across tool rounds after auxiliary cleanup', async () => {
    const service=await upstream((index,_body,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response('openai-chat',index===0 ? payload('第一段。\n\n','read_entity') : payload('<thinking>核对</thinking>第二段。'))));});
    const deltas:string[]=[]; const result=await generateText(config('openai-chat',service.baseUrl),{...request(),textFilter:'dramatron',onTextDelta:delta=>deltas.push(delta)});
    expect(result.text).toBe('第一段。\n\n第二段。'); expect(deltas.join('')).toBe(result.text); expect(service.bodies).toHaveLength(2);
  });
  it.each(protocols)('%s retains original auxiliary output in diagnostics and native history while nested tools use only cleaned prose', async protocol => {
    const auxiliary = '<Interleaving><thinking>辅助核对</thinking>信使来到码头。</Interleaving><disclaimer>辅助尾段</disclaimer>';
    const service = await upstream((index, _body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response(protocol, index === 0 ? payload(auxiliary, 'read_entity') : payload('<think>再次核对</think>他登上船。')))); });
    const deltas: string[]=[]; const captures: any[]=[]; const activities: ModelActivityEvent[]=[]; const execute=vi.fn(()=>({ location: '码头' }));
    const result=await generateText(config(protocol, service.baseUrl), { ...request(execute), textFilter: 'dramatron', onTextDelta: value=>deltas.push(value), onResponse: value=>captures.push(value), onActivity: event=>activities.push(event) });
    expect(result.text).toBe('信使来到码头。他登上船。'); expect(deltas.join('')).toBe(result.text);
    expect(execute).toHaveBeenCalledExactlyOnceWith({id:'person'}); expect(service.bodies).toHaveLength(2);
    expect(captures[0].text).toBe('信使来到码头。'); expect(captures[0].rawResponse).toContain('辅助核对');
    expect(activities.filter(event=>event.type==='thinking'&&event.thinkingSource==='preset').map(event=>event.text)).toEqual(['辅助核对','再次核对']);
    expect(JSON.stringify(service.bodies[1])).toContain('辅助核对'); expect(JSON.stringify(service.bodies[1])).toContain('toolResults');
  });
  it.each(protocols)('%s salvages a complete plain reply from the same tool-mode response without retries', async protocol => {
    const service=await upstream((_index,_body,res)=>{ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(plainResponse(protocol,'<thinking>辅助</thinking>网关已返回的正文。'))); });
    const execute=vi.fn(); const deltas:string[]=[];
    expect((await generateText(config(protocol,service.baseUrl),{...request(execute),textFilter:'dramatron',onTextDelta:value=>deltas.push(value)})).text).toBe('网关已返回的正文。');
    expect(deltas.join('')).toBe('网关已返回的正文。'); expect(execute).not.toHaveBeenCalled(); expect(service.bodies).toHaveLength(1);
  });
  it.each(protocols)('%s keeps the nonempty channel when the native carrier is valid but empty', async protocol => {
    const data=response(protocol,payload('')); const plain=plainResponse(protocol,'已返回的完整正文。');
    if(protocol==='openai-chat') data.choices![0].message.content=plain.choices![0].message.content;
    else if(protocol==='openai-responses') data.output!.push(plain.output![0] as any);
    else if(protocol==='gemini') data.candidates![0].content.parts.push(plain.candidates![0].content.parts[0] as any);
    else data.content!.push(plain.content![0] as any);
    const service=await upstream((_index,_body,res)=>{ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); });
    const execute=vi.fn(); expect((await generateText(config(protocol,service.baseUrl),request(execute))).text).toBe('已返回的完整正文。');
    expect(execute).not.toHaveBeenCalled(); expect(service.bodies).toHaveLength(1);
  });
  it.each(protocols)('%s cleans JSON envelopes while preserving literal tags inside submitted evidence', async protocol => {
    const json=JSON.stringify({text:'原文标签 <thinking> 不能丢失'});
    const service=await upstream((_index,_body,res)=>{ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(plainResponse(protocol,'<Interleaving><thinking>核对</thinking>'+json+'</Interleaving><disclaimer>辅助</disclaimer>'))); });
    expect((await generateStructured(config(protocol,service.baseUrl),{system:'压缩摘要',prompt:'片段',textFilter:'dramatron'},value=>value)).value).toEqual(JSON.parse(json));
    expect(service.bodies).toHaveLength(1);
  });
  it('deduplicates mirrored streams and preserves the longer same-response candidate', async () => {
    const args=payload('已返回正文。后续内容。');
    const service=await upstream((_index,_body,res)=>{ res.writeHead(200,{'Content-Type':'text/event-stream'}); res.write(sse({choices:[{index:0,delta:{content:'已返回正文。'}}]})); res.write(streamStart('openai-chat',JSON.stringify(args))); res.end(streamEnd('openai-chat','',args)); });
    const deltas:string[]=[]; const captures:any[]=[];
    const result=await generateText(config('openai-chat',service.baseUrl),{...request(),onTextDelta:value=>deltas.push(value),onResponse:value=>captures.push(value)});
    expect(result.text).toBe(args.prose); expect(deltas.join('')).toBe(args.prose); expect(captures[0].text).toBe(args.prose); expect(service.bodies).toHaveLength(1);
  });
  it('retains cleaned partial carrier prose after truncation and executes no incomplete tool', async () => {
    const partial=JSON.stringify(payload('<thinking>辅助</thinking>已收到的半段正文。','read_entity')).slice(0,-8);
    const service=await upstream((_index,_body,res)=>{ res.writeHead(200,{'Content-Type':'text/event-stream'}); res.end(streamStart('openai-chat',partial)); });
    const deltas:string[]=[]; const captures:any[]=[]; const execute=vi.fn();
    await expect(generateText(config('openai-chat',service.baseUrl),{...request(execute),textFilter:'dramatron',onTextDelta:value=>deltas.push(value),onResponse:value=>captures.push(value)})).rejects.toThrow();
    expect(captures[0].text).toBe('已收到的半段正文。'); expect(deltas.join('')).toBe('已收到的半段正文。'); expect(captures[0].rawResponse).toContain('辅助'); expect(captures[0].incomplete).toBe(true);
    expect(execute).not.toHaveBeenCalled(); expect(service.bodies).toHaveLength(1);
  });
  it.each(protocols)('%s executes nested tools, returns results under the real outer call, and preserves history', async protocol => {
    const service = await upstream((index, _body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response(protocol, index === 0 ? payload('林舟推开门。', 'read_entity') : payload('他走向码头。')))); });
    const execute = vi.fn(() => ({ location: '码头' })); const deltas: string[] = []; const activities: any[] = [];
    expect(await generateText(config(protocol, service.baseUrl), { ...request(execute), onTextDelta: value => deltas.push(value), onActivity: value => activities.push(value) })).toEqual({ text: '林舟推开门。他走向码头。', inputTokens: 20, outputTokens: 10 });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ id: 'person' }); expect(deltas.join('')).toBe('林舟推开门。他走向码头。');
    expect(activities.find(value => value.type === 'tool_call')).toMatchObject({ name: 'read_entity', arguments: { id: 'person' } });
    expect(service.bodies).toHaveLength(2);
    const next = service.bodies[1]; expect(JSON.stringify(next)).toContain('toolResults');
    if (protocol === 'openai-chat') expect(next.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'outer-1' });
    else if (protocol === 'openai-responses') expect(next.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'outer-1' });
    else if (protocol === 'gemini') expect(next.contents.at(-1).parts[0].functionResponse).toMatchObject({ name: WRITING_RESPONSE_NAME, id: 'outer-1' });
    else expect(next.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'outer-1' });
    if (protocol !== 'openai-chat') expect(JSON.stringify(next)).toContain('opaque-signature');
    const definitions = protocol === 'gemini' ? next.tools[0].functionDeclarations : next.tools;
    expect(definitions).toHaveLength(1); expect(JSON.stringify(definitions)).toContain('read_entity');
  });

  it.each(protocols)('%s displays decoded prose before the tool stream ends without leaking arguments', async protocol => {
    let release!: () => void; let visible!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const firstVisible = new Promise<void>(resolve => { visible = resolve; });
    const args = payload('林舟说：「到了。🙂」\n他停下。'); const raw = JSON.stringify(args); const split = protocol === 'gemini' ? raw.length : raw.indexOf('他停下');
    const service = await upstream(async (_index, _body, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(streamStart(protocol, raw.slice(0, split))); await gate; res.end(streamEnd(protocol, raw.slice(split), args)); });
    const deltas: string[] = []; let completed = false;
    const work = generateText(config(protocol, service.baseUrl), { ...request(), onTextDelta: delta => { deltas.push(delta); visible(); } }).then(value => { completed = true; return value; });
    await firstVisible; expect(completed).toBe(false); expect(deltas.join('')).toContain('林舟说：'); expect(deltas.join('')).not.toContain('toolCalls'); release();
    expect((await work).text).toBe(args.prose); expect(deltas.join('')).toBe(args.prose);
  });

  it.each(protocols)('%s pauses for a real player answer and resumes the saved outer transport exactly once', async protocol => {
    const service = await upstream((index, _body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response(protocol, index === 0 ? payload('他站在岔路口。', 'ask_user') : payload('他走进左边的巷子。')))); });
    let saved!: ModelToolContinuation; const execute = vi.fn(() => { throw new ModelInteractionPause(); });
    const initial = { ...request(), textFilter: 'dramatron' as const, tools: [{ ...request().tools![0], name: 'ask_user', execute }], onContinuation: (value: ModelToolContinuation) => { saved = value; } };
    await expect(generateText(config(protocol, service.baseUrl), initial)).rejects.toBeInstanceOf(ModelInteractionPause);
    expect(saved.text).toBe('他站在岔路口。'); expect(saved.writingOutputMode).toBe('tool'); expect(saved.textFilter).toBe('dramatron'); expect(service.bodies).toHaveLength(1);
    const answered = vi.fn(() => ({ answer: '左边' })); const deltas: string[] = [];
    const result = await generateText(config(protocol, service.baseUrl), { ...initial, writingOutputMode: 'text', tools: [{ ...initial.tools[0], execute: answered }], continuation: saved, onTextDelta: value => deltas.push(value) });
    expect(result.text).toBe('他站在岔路口。他走进左边的巷子。'); expect(deltas.join('')).toBe('他走进左边的巷子。'); expect(answered).toHaveBeenCalledTimes(1); expect(service.bodies).toHaveLength(2); expect(JSON.stringify(service.bodies[1])).toContain('左边');
  });

  it.each([payload(''), { prose: '已收到正文', toolCalls: [{ name: 'missing', argumentsJson: '{}' }] }, { prose: '已收到正文', toolCalls: [{ name: 'read_entity', argumentsJson: 'broken' }] }, '{"prose":"部分正文'])('rejects malformed envelopes before executing tools, retaining response and usage without retries', async args => {
    const service = await upstream((_index, _body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response('openai-chat', args))); });
    const execute = vi.fn(); const onResponse = vi.fn();
    await expect(generateText(config('openai-chat', service.baseUrl), { ...request(execute), onResponse })).rejects.toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(execute).not.toHaveBeenCalled(); expect(service.bodies).toHaveLength(1); expect(onResponse).toHaveBeenCalledTimes(1); expect(onResponse.mock.calls[0][0].rawResponse).toContain('emit_writing_response');
  });

  it('decodes escaped partial prose without reading nested fields and reserves the wrapped tool schemas in the budget', () => {
    expect(partialWritingProse('{"toolCalls":[{"prose":"不能泄漏"}],"prose":"正文\\n\\u4e2d\\ud83d')).toBe('正文\n中');
    expect(partialWritingProse('{"prose":"正文\\ud83d\\ude42"}')).toBe('正文🙂');
    expect(() => unpackWritingResponse([{ id: 'outer', name: 'wrong', arguments: payload('正文') }], [])).toThrow('必须提交一次');
    const body = JSON.parse(buildRequestSnapshot(config('openai-chat', 'http://127.0.0.1:1'), request()).body);
    expect(body.tool_choice.function.name).toBe(WRITING_RESPONSE_NAME); expect(body.parallel_tool_calls).toBe(false); expect(JSON.stringify(body.tools)).toContain('argumentsJson');
  });
});
