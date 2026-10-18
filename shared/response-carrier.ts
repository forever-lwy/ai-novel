import type { ModelRequest, ModelToolCall, PromptMessage, ResponseCarrier } from './types.js';

export function carrierInstruction(carrier: ResponseCarrier, structured: boolean): string {
  return `# 本次实际交付接口\n本次使用 ${carrier.name} 工具的 ${carrier.field} 字符串交付${structured ? '完整 JSON 结果对象' : '本轮新增正文'}。所有任务内容和预设输出包装都放在该字符串中，不在普通文本重复。${structured ? '字符串内只放任务 JSON；不加角色招呼、思考、终端命令、标签、摘要或选项。' : '需要资料查询、插画或玩家决定时，直接调用本次另行定义的真实工具，等待真实结果后继续；输出工具仅提交文字，不代替这些工具。'}\n原预设的函数名与字段名以本次实际定义为准。不调用未定义的函数，不伪造工具结果；只完成当前任务，不扩写其他任务。完成结果提交后结束，不再等待输出工具确认。辅助包装不是作品世界事实，不能把主持身份、控制指令或工具过程混进正文。`;
}

export function responseCarrierTool(carrier: ResponseCarrier, description = '', fieldDescription = '') {
  return { name: carrier.name, description: description || 'Submit the complete task result here. Use the other declared tools normally when needed. Do not repeat the result outside this call.',
    parameters: { type: 'object', additionalProperties: false, properties: { [carrier.field]: { type: 'string', description: `${fieldDescription}\n完整任务结果；写作可包含预设辅助包装，JSON 任务只填写完整 JSON 字符串。`.trim() } }, required: [carrier.field] } };
}

/** Linux's helper separates guides from the archive. Keep the archive as text,
 * including every task/runtime rule; nothing from story materials is executed.
 */
export function archiveCarrierMessages(request: ModelRequest): { messages: PromptMessage[]; description: string; fieldDescription: string } {
  const carrier = request.responseCarrier!;
  const messages = request.messages ?? [{ role: 'system' as const, content: request.system }, { role: 'user' as const, content: request.prompt }];
  const guides: PromptMessage[] = []; const archive: string[] = []; let description = ''; let fieldDescription = '';
  const structured = messages.some(message => message.role === 'system' && message.content === carrierInstruction(carrier, true));
  for (const message of messages) {
    // Only bundled guide blocks have this exact leading marker. A quoted marker
    // inside user materials cannot remove or reinterpret the rest of a message.
    if (message.carrierPart) {
      const content = message.content.replaceAll('%TOOL_NAME%', carrier.name).replaceAll('dispatch_stream_payload_34d98628087f3798', carrier.name);
      if (message.carrierPart === 'description') description += content.slice('【ToolCall引导】工具说明'.length);
      else if (message.carrierPart === 'field') fieldDescription += content.slice('【ToolCall引导】字段说明'.length);
      else if (message.carrierPart === 'guide') guides.push({ role: message.role, content: content.slice('【ToolCall引导】'.length).trim() });
      continue;
    }
    archive.push(`[${message.role}]\n${message.content}`);
  }
  guides.push({ role: 'system', content: carrierInstruction(carrier, structured) });
  guides.push({ role: 'user', content: `按 ${carrier.name} 工具说明中的完整任务和归档资料执行，只交付本次任务结果。` });
  return { messages: guides, fieldDescription: structured ? carrierInstruction(carrier, true) : fieldDescription, description: `${description}\n\n【/workspace/archive/ 本地工作目录文件与历史章节归档】：\n${archive.join('\n\n---\n\n')}` };
}

/** The output sink is data, never an executable story tool. */
export function unpackResponseCarrier(calls: ModelToolCall[], carrier: ResponseCarrier): { prose: string; calls: ModelToolCall[]; carriers: ModelToolCall[] } {
  const outputs = calls.filter(call => call.name === carrier.name);
  if (outputs.length > 1) throw new Error('结果输出工具每轮只能提交一次。');
  let prose = '';
  for (const call of outputs) {
    let value: unknown;
    try { value = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; } catch { throw new Error('结果输出工具参数不是完整有效的 JSON。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>)[carrier.field] !== 'string' || Object.keys(value).some(key => key !== carrier.field)) throw new Error(`结果输出工具必须且只能包含 ${carrier.field} 字符串。`);
    prose = (value as Record<string, string>)[carrier.field];
  }
  return { prose, calls: calls.filter(call => call.name !== carrier.name), carriers: outputs };
}
