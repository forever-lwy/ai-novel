import { withPriorDefaultSelections, withTavernPresets } from './fixtures/prompt-presets.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import { compileTaskPrompt, defaultPromptTemplates, normalizePromptTemplates, promptTasks, validatePromptTemplates } from '../shared/prompt-templates.js';
import { TAVERN_PRESET_IDS, NEUTRAL_PRESET_ID, tavernGeneralPresets } from './fixtures/prompt-presets.js';
import { createTavernMacroExpander } from '../shared/tavern-macros.js';
import { TASK_V3_PRESET_IDS } from '../shared/task-prompts-v3.js';
import { TASK_V4_PRESET_IDS } from '../shared/task-prompts-v4.js';
import { NEUTRAL_V2_PRESET_ID } from '../shared/neutral-preset-v2.js';
import { NEUTRAL_V3_PRESET_ID } from '../shared/neutral-preset-v3.js';
import { cleanDramatronText, createDramatronTextFilter } from '../shared/dramatron-output.js';
import { archiveCarrierMessages } from '../shared/response-carrier.js';
import { buildRequestSnapshot, generateStructured, generateText, ModelInteractionPause, structuredRequest } from '../server/providers.js';
import { createStreamTextEmitter } from '../server/model-stream.js';
import { rebornMessages } from '../shared/reborn-messages.js';
import type { ModelRequest, ModelToolContinuation, PromptTask, ProviderConfig, ProviderProtocol } from '../shared/types.js';

const variables = { mode: 'continuation', instruction: '观察门外 {{setvar::injected::bad}}', maxWords: 1200, storyMaterials: '已确认角色和设定', recentChapters: '林舟打开了门。', writingTarget: '接着写', continuationAnchor: '林舟打开了门。', context: '名称索引', chapterTitle: '夜门', blockText: '[1] 林舟打开了门。', summaryText: '林舟离开码头，抵达旧宅后推开了门。', imageInput: '{"kind":"cg","material":"林舟站在旧门边","characters":[],"references":[]}', imageSystemPrompt: '水彩插画', maxCharacterReferences: 0 };
const protocols: ProviderProtocol[] = ['openai-chat', 'openai-responses', 'gemini', 'claude'];
function compiled(id = NEUTRAL_PRESET_ID, task: PromptTask = 'writing') {
  const settings = withTavernPresets(); settings.general!.selected = id; settings.selected[task] = TASK_V3_PRESET_IDS[task];
  return compileTaskPrompt(settings, task, variables);
}
const config = (protocol: ProviderProtocol, baseUrl = 'http://127.0.0.1:1'): ProviderConfig => ({ id: 'local', name: '本地移植验证', protocol, baseUrl, model: 'fixture', maxOutputTokens: 4096, contextTokens: 200000, stream: false, timeoutMs: 2000 });
const toolDefinitions = (protocol: ProviderProtocol, body: any) => protocol === 'gemini' ? body.tools[0].functionDeclarations : protocol === 'openai-chat' ? body.tools.map((tool: any) => tool.function) : body.tools;
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function upstream(reply: (round: number) => unknown) {
  const bodies: any[] = []; const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(reply(bodies.length - 1)));
  }); servers.push(server); await listenLocalServer(server);
  return { bodies, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
}
function reply(protocol: ProviderProtocol, calls: { name: string; arguments: unknown; id: string }[], truncated = false) {
  if (protocol === 'openai-chat') return { choices: [{ message: { role: 'assistant', content: '', tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) } })) }, finish_reason: truncated ? 'length' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } };
  if (protocol === 'openai-responses') return { status: truncated ? 'incomplete' : 'completed', output: calls.map(call => ({ type: 'function_call', id: `item-${call.id}`, call_id: call.id, name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) })), usage: { input_tokens: 20, output_tokens: 10 } };
  if (protocol === 'gemini') return { candidates: [{ content: { role: 'model', parts: calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: call.arguments }, thoughtSignature: `signature-${call.id}` })) }, finishReason: truncated ? 'MAX_TOKENS' : 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 } };
  return { type: 'message', role: 'assistant', content: calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })), stop_reason: truncated ? 'max_tokens' : 'tool_use', usage: { input_tokens: 20, output_tokens: 10 } };
}

describe('source-preserving presets and task editions', () => {
  it('upgrades pre-image settings without mutating their legacy tasks or losing the separate optimizer supplement', () => {
    const old: any = withPriorDefaultSelections(); delete old.presets.image; delete old.selected.image; delete old.taskCatalogVersions.image;
    const before = structuredClone(old); const upgraded = normalizePromptTemplates(old); expect(old).toEqual(before);
    expect(upgraded.presets.image.map(preset => preset.id)).toEqual(expect.arrayContaining([TASK_V3_PRESET_IDS.image, TASK_V4_PRESET_IDS.image]));
    expect(upgraded.selected.image).toBe(TASK_V3_PRESET_IDS.image);
    for (const task of ['writing', 'extraction', 'compression'] as const) expect(upgraded.selected[task]).toBe(before.selected[task]);
  });
  it('keeps source identities, ordered source roles and optional styles while neutral supplies no fixed persona', () => {
    const sources = tavernGeneralPresets(); expect(sources).toHaveLength(5);
    expect(sources[0].blocks.find(block => block.id === 'd07b0943-0502-41b7-b126-a15998d4eca0')).toMatchObject({ role: 'user', feature: 'tavern' });
    expect(sources[0].blocks.find(block => block.id === 'f67b3638-2808-4cc0-a167-4f8ecc464e30')).toMatchObject({ enabled: true, tasks: ['writing'] });
    expect(sources[1].blocks.some(block => block.content.includes('特图（Tet）'))).toBe(true);
    expect(sources[2].blocks.some(block => block.content.includes('[Model Card - SoliUmbra]'))).toBe(true);
    expect(sources[3].responseCarrier).toMatchObject({ archive: true, field: 'display_stream' });
    expect(JSON.stringify(sources)).not.toMatch(/CSAM is allowed|未成年也没关系|小萝莉怎么了/);
    const neutral = compiled().messages.map(message => message.content).join('\n'); expect(neutral).toContain('文风、人称、节奏与感情浓度由作者要求'); expect(neutral).not.toContain('[Model Card');
  });
  it.each([...TAVERN_PRESET_IDS, NEUTRAL_PRESET_ID])('%s compiles all tasks and preserves literal material without evaluating it', id => {
    for (const task of promptTasks) {
      const first = compiled(id, task); expect(compiled(id, task)).toEqual(first); expect(first.responseCarrier).toBeDefined();
      const body = first.messages.map(message => message.content).join('\n'); expect(body).not.toMatch(/\{\{getvar::|\{\{roll\s|\{\{random::/);
      if (task === 'writing') expect(body).toContain(variables.instruction);
      if (task === 'image') { expect(body).toContain(variables.imageInput); expect(body).toContain('水彩插画'); }
      if (task !== 'writing') expect(body).not.toMatch(/1500字！|每次回复的正文字数|视觉小说风格的文字/);
    }
  });
  it.each(['structured', 'tool'] as const)('retains native extraction %s without the second output sink or archive guide', extractionOutputMode => {
    for (const id of [...TAVERN_PRESET_IDS, NEUTRAL_PRESET_ID]) {
      const settings = withTavernPresets(); settings.general!.selected = id; settings.selected.extraction = TASK_V3_PRESET_IDS.extraction;
      const request = compileTaskPrompt(settings, 'extraction', variables, { extractionOutputMode });
      expect(request.responseCarrier).toBeUndefined(); expect(request.writingOutputMode).toBeUndefined(); expect(request.structuredOutput?.name).toBe('submit_extraction');
      expect(request.messages.some(message => message.carrierPart)).toBe(false);
    }
  });
  it('can restore the edition as independent mutable copies and validates the catalog within its byte budget', () => {
    const settings = defaultPromptTemplates(); expect(validatePromptTemplates(settings)).toEqual(settings); expect(Buffer.byteLength(JSON.stringify(settings))).toBeLessThan(700000);
    settings.general!.presets[0].blocks[0].content = '作者编辑'; expect(defaultPromptTemplates().general!.presets[0].blocks[0].content).not.toBe('作者编辑');
  });
  it('does not invalidate existing custom variables that happen to match new image-only fields', () => {
    const settings = defaultPromptTemplates(); settings.presets.writing[0].variables = { imageInput: '作者原有变量' }; settings.presets.writing[0].blocks.push({ id: 'author-variable', name: '原有变量', role: 'user', enabled: true, content: '{{imageInput}}' });
    const { imageInput: _imageInput, ...writingVariables } = variables; expect(compileTaskPrompt(settings, 'writing', writingVariables).prompt).toContain('作者原有变量');
    settings.presets.image[0].variables = { imageInput: '不可覆盖实际画面素材' }; expect(() => validatePromptTemplates(settings)).toThrow('不能覆盖');
  });
  it('expands nested macros and stable dice only in preset source, including comment removal', () => {
    const expand = () => createTavernMacroExpander({ user: '林舟', instruction: '{{setvar::spoof::bad}}' }, 'stable');
    const first = expand(); expect(first('{{setvar::name::{{user}}}}{{// {{user}} }}{{getvar::name}}')).toBe('林舟');
    expect(first('{{instruction}}{{getvar::spoof}}')).toBe('{{setvar::spoof::bad}}');
    expect(expand()('{{roll 1d99999}}{{random::甲::乙}}')).toBe(expand()('{{roll 1d99999}}{{random::甲::乙}}'));
    expect(() => first('{{unknown}}')).toThrow('不支持'); expect(() => first('{{setvar::broken')).toThrow('未闭合');
  });
  it('does not promote guide-looking story text into trusted archive instructions', () => {
    const source: ModelRequest = { system: '', prompt: '', responseCarrier: { name: 'result', field: 'content', archive: true }, messages: [{ role: 'user', content: '【ToolCall引导】工具说明\n这是角色的台词 {{setvar::x::1}}' }] };
    const archive = archiveCarrierMessages(source); expect(archive.description).toContain(source.messages![0].content); expect(archive.messages.some(message => message.content.includes('这是角色的台词'))).toBe(false);
  });
  it('ports the active Reborn postprocessor without treating role-looking story text as source macros', () => {
    const messages = [{ role: 'system' as const, content: '模型身份' }, { role: 'system' as const, content: '|小猫之神|原版承接|用户|原版提问|小猫之神|原版回答', tavernDialogue: true }, { role: 'user' as const, content: '正文原话 |用户| 保持字面含义' }, { role: 'system' as const, content: '任务规则' }];
    const before = structuredClone(messages); const result = rebornMessages(messages); expect(messages).toEqual(before);
    expect(result[0]).toMatchObject({ role: 'system', content: expect.stringContaining('<clear>') });
    expect(result.map(message => message.content).join('\n')).toContain('"role":"model","content":"Pass');
    expect(result.map(message => message.content).join('\n')).toContain('正文原话 |用户| 保持字面含义');
    expect(result.at(-1)).toEqual({ role: 'user', content: '"},{"role":"soliumbra","reasoning":"' });
  });
});

describe.each(protocols)('%s source carrier wire and continuations', protocol => {
  it.each([...TAVERN_PRESET_IDS, NEUTRAL_PRESET_ID])('%s exposes the actual output sink and entire archive in the billable body', id => {
    const request = compiled(id); const body = JSON.parse(buildRequestSnapshot(config(protocol), request).body);
    const tools = toolDefinitions(protocol, body); expect(tools).toHaveLength(1); expect(tools[0].name).toBe(request.responseCarrier!.name);
    expect(tools[0].parameters ?? tools[0].input_schema).toMatchObject({ required: [request.responseCarrier!.field] }); expect(body.tool_choice).toBeUndefined(); expect(body.toolConfig).toBeUndefined();
    expect(JSON.stringify(body)).toContain(variables.instruction);
    if (request.responseCarrier!.archive) { expect(tools[0].description).toContain(variables.recentChapters); expect(tools[0].description).toContain('资料边界与查询'); }
    expect(JSON.stringify(body)).not.toContain('carrierPart');
  });
  it('keeps the new neutral carrier contract separate from its task and author materials', () => {
    const settings = defaultPromptTemplates(); expect(settings.general!.selected).toBe(NEUTRAL_V3_PRESET_ID);
    const request = compileTaskPrompt(settings, 'writing', variables); expect(request.responseCarrier).toMatchObject({ archive: false });
    const body = JSON.parse(buildRequestSnapshot(config(protocol), request).body); const tools = toolDefinitions(protocol, body);
    expect(tools[0].name).toBe(request.responseCarrier!.name);
    for (const material of [variables.instruction, variables.storyMaterials, variables.recentChapters]) {
      expect(request.messages.some(message => message.content.includes(material))).toBe(true);
      expect(tools.every((tool: any) => !tool.description.includes(material))).toBe(true);
      expect(JSON.stringify(body[protocol === 'gemini' ? 'contents' : protocol === 'openai-responses' ? 'input' : 'messages'])).toContain(material);
    }
    expect(JSON.stringify(body)).not.toContain('/workspace/archive/');
  });
  it('executes real native tools alongside the output sink and returns results under each original call ID', async () => {
    const request = compiled(); const sink = request.responseCarrier!; const execute = vi.fn(() => ({ name: '林舟', role: '信使' }));
    const service = await upstream(round => reply(protocol, round ? [{ id: 'final', name: sink.name, arguments: { [sink.field]: '<game>他带着回信离开。</game><summary>辅助摘要</summary>' } }] : [{ id: 'first', name: sink.name, arguments: { [sink.field]: '<game>他停在旧门前。</game>' } }, { id: 'lookup', name: 'read_entity', arguments: { id: 'person' } }]));
    const deltas: string[] = []; const captures: unknown[] = [];
    const result = await generateText(config(protocol, service.baseUrl), { ...request, tools: [{ name: 'read_entity', description: '查人物', parameters: { type: 'object' }, execute }], onTextDelta: text => deltas.push(text), onResponse: result => captures.push(result) });
    expect(result.text).toBe('他停在旧门前。他带着回信离开。'); expect(deltas.join('')).toBe(result.text); expect(execute).toHaveBeenCalledExactlyOnceWith({ id: 'person' }); expect(service.bodies).toHaveLength(2); expect(captures).toHaveLength(2);
    const second = JSON.stringify(service.bodies[1]); expect(second).toContain('lookup'); expect(second).toContain('信使'); expect(second).toContain('received'); expect(second).toContain('工具结果复核');
  });
  it.each(['extraction', 'compression', 'image'] as const)('submits %s JSON through the native sink without an extra confirmation round', async task => {
    const request = compiled('tavern-linux-v13', task); const sink = request.responseCarrier!; const value = { text: '<draft>原文证据</draft>' };
    const service = await upstream(() => reply(protocol, [{ id: 'json-result', name: sink.name, arguments: { [sink.field]: JSON.stringify(value) } }]));
    const result = await generateStructured(config(protocol, service.baseUrl), request, value => value); expect(result.value).toEqual(value); expect(service.bodies).toHaveLength(1);
    expect(JSON.stringify(service.bodies[0])).not.toContain('将本次任务要求的完整 JSON 文本作为字符串放入 emit_writing_response');
    expect(structuredRequest(structuredRequest(request))).toEqual(structuredRequest(request));
  });
  it('keeps the original sink on a paused continuation even when the current preset changes', async () => {
    const request = compiled(); const sink = request.responseCarrier!; let saved: ModelToolContinuation | undefined;
    const service = await upstream(round => reply(protocol, round ? [{ id: 'done', name: sink.name, arguments: { [sink.field]: '玩家决定后继续。' } }] : [{ id: 'choose', name: 'ask_user', arguments: {} }]));
    const tools = [{ name: 'ask_user', description: '询问玩家', parameters: { type: 'object' }, execute: vi.fn(() => { throw new ModelInteractionPause({ question: '走哪边？' }); }) }];
    await expect(generateText(config(protocol, service.baseUrl), { ...request, tools, onContinuation: state => { saved = state; } })).rejects.toBeInstanceOf(ModelInteractionPause);
    expect(saved?.responseCarrier).toEqual(sink); tools[0].execute = vi.fn(() => ({ choice: '左边' })) as typeof tools[0]['execute'];
    const result = await generateText(config(protocol, service.baseUrl), { ...compiled('tavern-reborn-v23'), tools, continuation: saved });
    expect(result.text).toBe('玩家决定后继续。'); expect(service.bodies).toHaveLength(2);
    expect(toolDefinitions(protocol, service.bodies[1]).some((tool: any) => tool.name === sink.name)).toBe(true);
  });
  it('preserves truncated output, records its failure and never automatically resends it', async () => {
    const request = compiled('tavern-v08'); const sink = request.responseCarrier!; const captures: any[] = []; const deltas: string[] = [];
    const service = await upstream(() => reply(protocol, [{ id: 'partial', name: sink.name, arguments: { [sink.field]: '<now_plot>已经返回的正文。</now_plot>' } }], true));
    await expect(generateText(config(protocol, service.baseUrl), { ...request, onResponse: response => captures.push(response), onTextDelta: text => deltas.push(text) })).rejects.toThrow(/截断|未完成/);
    expect(service.bodies).toHaveLength(1); expect(captures[0].text).toBe('已经返回的正文。'); expect(deltas.join('')).toBe('已经返回的正文。');
  });
});

describe('source auxiliary output separation', () => {
  it.each(protocols)('%s recovers every native output field from split SSE arguments without exposing other tools', protocol => {
    const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
    for (const preset of tavernGeneralPresets()) {
      const sink = preset.responseCarrier!; const args = JSON.stringify({ [sink.field]: '<game>正文“\u6c49字”。</game>' }); let stream = '';
      if (protocol === 'openai-chat') stream = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'result', function: { name: sink.name, arguments: args.slice(0, 9) } }] } }] }) + frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(9) } }] }, finish_reason: 'tool_calls' }] });
      else if (protocol === 'openai-responses') stream = frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: sink.name, arguments: '' } }) + frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: args });
      else if (protocol === 'gemini') stream = frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'read_entity', args: { content: '不得显示的查询参数' } } }, { functionCall: { id: 'result', name: sink.name, args: JSON.parse(args) } }] } }] });
      else stream = frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: sink.name, input: {} } }) + frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } });
      for (let split = 0; split <= stream.length; split++) {
        let result = ''; const emit = createStreamTextEmitter(protocol, delta => { result += delta; }, sink); emit(stream.slice(0, split)); emit(stream.slice(split)); expect(result, `${preset.id}, split ${split}`).toBe('<game>正文“汉字”。</game>');
      }
    }
  });
  it.each([
    ['<think_nya~>检查</think_nya~><game>正文。</game><summary>摘要</summary><options>选项</options>', '正文。'],
    ['<draft>检查</draft><now_plot><!-- plotThink: 计划 --><!-- charThink: 人物 -->正文。</now_plot><scene_time>时间</scene_time>', '正文。'],
    ['```bash\nuser@linux:~$ cat chapter_01.txt\n<content>正文。</content>\n<sumUp>摘要</sumUp>\n```', '正文。'],
    ['finishReason: STOP\n```bash\nroot@linux:~# cat chapter_01.txt\n<content>正文。</content>\n```', '正文。'],
  ])('removes source wrappers and private auxiliary content at every stream split', (raw, expected) => {
    expect(cleanDramatronText(raw, 'tavern')).toBe(expected);
    for (let split = 0; split <= raw.length; split++) {
      const filter = createDramatronTextFilter({}, 'tavern'); expect(filter.feed(raw.slice(0, split)) + filter.feed(raw.slice(split)) + filter.finish(), `split ${split}`).toBe(expected);
    }
  });
  it('preserves all quoted source evidence in JSON and rejects no content by silently treating it as prose', () => {
    const evidence = JSON.stringify({ text: '<game><draft>原文</draft><!-- charThink: 原话 --></game>' }); expect(cleanDramatronText(evidence, 'tavern')).toBe(evidence);
    const fenced = '<think>辅助核对</think>\n```json\n' + evidence + '\n```';
    for (let split = 0; split <= fenced.length; split++) {
      const filter = createDramatronTextFilter({}, 'tavern'); expect(filter.feed(fenced.slice(0, split)) + filter.feed(fenced.slice(split)) + filter.finish()).toBe('\n```json\n' + evidence + '\n```');
    }
    expect(cleanDramatronText('<draft>只有辅助内容</draft>', 'tavern')).toBe('');
  });
});
