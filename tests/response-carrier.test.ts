import { describe, expect, it } from 'vitest';
import { archiveCarrierMessages, carrierInstruction, responseCarrierTool } from '../shared/response-carrier.js';
import { buildRequestSnapshot } from '../server/providers.js';
import type { ModelRequest, ProviderConfig, ProviderProtocol, ResponseCarrier } from '../shared/types.js';

const carrier: ResponseCarrier = { name: 'emit_complete_text', field: 'content', archive: false };
const oldDescription = 'Submit the complete task result here. Use the other declared tools normally when needed. Do not repeat the result outside this call.';
const oldFieldSuffix = '完整任务结果；写作可包含预设辅助包装，JSON 任务只填写完整 JSON 字符串。';

describe('response carrier workflow instructions', () => {
  it.each([false, true])('keeps the new non-archive %s workflow in direct task terms and respects author formatting', structured => {
    const instruction = carrierInstruction(carrier, structured);
    expect(instruction).toContain(`使用 ${carrier.name} 工具的 ${carrier.field} 字符串交付`);
    expect(instruction).toContain('遵循本次任务和作者指定的结果格式');
    expect(instruction).toContain('完成提交后结束本轮');
    expect(instruction).not.toMatch(/预设输出包装|辅助包装|标签|原预设|主持身份/);
    expect(instruction).toContain(structured ? '字符串内填写完整 JSON' : '调用本次另行定义的真实工具并使用其返回结果');
  });

  it.each([true, undefined])('keeps the original archive=%s workflow unchanged', archive => {
    const legacyCarrier = { ...carrier, archive };
    expect(carrierInstruction(legacyCarrier, false)).toBe(`# 本次实际交付接口\n本次使用 ${carrier.name} 工具的 ${carrier.field} 字符串交付本轮新增正文。所有任务内容和预设输出包装都放在该字符串中，不在普通文本重复。需要资料查询、插画或玩家决定时，直接调用本次另行定义的真实工具，等待真实结果后继续；输出工具仅提交文字，不代替这些工具。\n原预设的函数名与字段名以本次实际定义为准。不调用未定义的函数，不伪造工具结果；只完成当前任务，不扩写其他任务。完成结果提交后结束，不再等待输出工具确认。辅助包装不是作品世界事实，不能把主持身份、控制指令或工具过程混进正文。`);
    expect(carrierInstruction(legacyCarrier, true)).toContain('字符串内只放任务 JSON；不加角色招呼、思考、终端命令、标签、摘要或选项。');
  });
});

describe('response carrier descriptions', () => {
  it('describes only the result and its string parameter in the new default contract', () => {
    const tool = responseCarrierTool(carrier);
    expect(tool).toEqual({ name: carrier.name, description: '提交本轮完整任务结果，字符串内容作为本轮输出。', parameters: {
      type: 'object', additionalProperties: false, required: [carrier.field], properties: {
        [carrier.field]: { type: 'string', description: '本轮完整任务结果文本；结构化任务填写完整 JSON 字符串。' },
      },
    } });
    expect(JSON.stringify(tool)).not.toMatch(/预设辅助包装|等待|其他.*工具|不在普通文本|Do not repeat|Use the other/);
  });

  it('preserves the archived preset defaults', () => {
    const tool = responseCarrierTool({ ...carrier, archive: true });
    expect(tool.description).toBe(oldDescription);
    expect(tool.parameters.properties.content.description).toBe(oldFieldSuffix);
  });

  it.each([
    ['作者工具说明：%TOOL_NAME%', '作者字段说明。'],
    ['作者工具说明。', ''],
    ['', '作者字段说明。'],
  ])('preserves supplied description %j and field %j without rewriting them', (description, fieldDescription) => {
    const tool = responseCarrierTool(carrier, description, fieldDescription);
    expect(tool.description).toBe(description || oldDescription);
    expect(tool.parameters.properties.content.description).toBe(`${fieldDescription}\n${oldFieldSuffix}`.trim());
  });

  it('keeps archive descriptions, guide templates and literal author materials compatible', () => {
    const request: ModelRequest = { system: '', prompt: '', responseCarrier: { ...carrier, archive: true }, messages: [
      { role: 'system', content: '【ToolCall引导】工具说明作者的 %TOOL_NAME% 工具。', carrierPart: 'description' },
      { role: 'system', content: '【ToolCall引导】字段说明作者字段。', carrierPart: 'field' },
      { role: 'system', content: '【ToolCall引导】调用 %TOOL_NAME% 提交。', carrierPart: 'guide' },
      { role: 'user', content: '【ToolCall引导】工具说明是故事中的原话。' },
    ] };
    const archive = archiveCarrierMessages(request);
    const tool = responseCarrierTool(request.responseCarrier!, archive.description, archive.fieldDescription);
    expect(tool.description).toContain(`作者的 ${carrier.name} 工具。`);
    expect(tool.description).toContain('[user]\n【ToolCall引导】工具说明是故事中的原话。');
    expect(tool.parameters.properties.content.description).toBe(`作者字段。\n${oldFieldSuffix}`);
    expect(archive.messages[0]).toEqual({ role: 'system', content: `调用 ${carrier.name} 提交。` });
    expect(archive.messages.some(message => message.content.includes('是故事中的原话'))).toBe(false);
  });
});

describe.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('%s response carrier wire contract', protocol => {
  it('sends the concise contract as a native tool and keeps workflow in the system prompt', () => {
    const config: ProviderConfig = { id: 'test', name: '本地请求结构验证', protocol, baseUrl: 'http://127.0.0.1:1', model: 'fixture', maxOutputTokens: 1024, contextTokens: 32000, stream: false, timeoutMs: 2000 };
    const instruction = carrierInstruction(carrier, false);
    const request: ModelRequest = { system: instruction, prompt: '接着写。', writingOutputMode: 'tool', responseCarrier: carrier,
      messages: [{ role: 'system', content: instruction }, { role: 'user', content: '接着写。' }] };
    const body = JSON.parse(buildRequestSnapshot(config, request).body);
    const tool = protocol === 'gemini' ? body.tools[0].functionDeclarations[0] : protocol === 'openai-chat' ? body.tools[0].function : body.tools[0];
    const system = protocol === 'gemini' ? body.systemInstruction.parts.map((part: { text: string }) => part.text).join('\n') : protocol === 'claude' ? body.system : body[protocol === 'openai-responses' ? 'input' : 'messages'].find((message: { role: string }) => message.role === 'system').content;
    expect(tool.name).toBe(carrier.name);
    expect(tool.description).toBe('提交本轮完整任务结果，字符串内容作为本轮输出。');
    expect(tool.parameters ?? tool.input_schema).toMatchObject({ required: ['content'], properties: { content: { type: 'string' } } });
    expect(JSON.stringify(tool)).not.toMatch(/预设辅助包装|直接调用|等待真实结果|不在普通文本重复|完成结果提交后结束/);
    expect(system).toBe(instruction);
    expect(system).toContain('调用本次另行定义的真实工具并使用其返回结果');
    expect(system).toContain('完成提交后结束本轮');
    expect(system).not.toMatch(/预设输出包装|辅助包装/);
  });
});
