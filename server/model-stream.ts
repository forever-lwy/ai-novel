import type { ModelActivityEvent, ProviderProtocol } from '../shared/types.js';

type Json = Record<string, any>;
type Event = { name: string; data: string; complete: boolean };
const object = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const objects = (value: unknown): Json[] => Array.isArray(value) ? value.filter(object) : [];
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : 0;

function event(block: string, complete: boolean): Event {
  let name = ''; const data: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') name = value;
    if (field === 'data') data.push(value);
  }
  return { name, data: data.join('\n'), complete };
}

function terminal(protocol: ProviderProtocol, item: Event): boolean {
  if (!item.complete || !item.data) return false;
  if (protocol === 'openai-chat' && item.data.trim() === '[DONE]') return true;
  try {
    const data: unknown = JSON.parse(item.data);
    if (!object(data)) return false;
    const name = item.name || data.type;
    if (name === 'error' || data.error) return true;
    if (protocol === 'openai-responses') return ['response.completed', 'response.incomplete', 'response.failed'].includes(name);
    if (protocol === 'claude') return name === 'message_stop';
    if (protocol === 'gemini') return Boolean(data.promptFeedback?.blockReason || objects(data.candidates).some(candidate => (candidate.index === undefined || candidate.index === 0) && candidate.finishReason));
  } catch { /* A malformed event is reported by the final parser. */ }
  return false;
}

/** Detect actual protocol end events without waiting for a gateway to close its socket. */
export function createStreamEndDetector(protocol: ProviderProtocol): (chunk: string) => boolean {
  let pending = '';
  return chunk => {
    pending += chunk;
    let separator: RegExpExecArray | null;
    while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
      const block = pending.slice(0, separator.index).replace(/^\uFEFF/, '');
      pending = pending.slice(separator.index + separator[0].length);
      if (terminal(protocol, event(block, true))) return true;
    }
    return false;
  };
}

/** Emit prose only; public thoughts and tool execution are recorded through separate activity events. */
export function createStreamTextEmitter(protocol: ProviderProtocol, emit: (text: string) => void): (chunk: string) => void {
  let pending = '';
  return chunk => {
    pending += chunk;
    let separator: RegExpExecArray | null;
    while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
      const item = event(pending.slice(0, separator.index).replace(/^\uFEFF/, ''), true);
      pending = pending.slice(separator.index + separator[0].length);
      let data: Json;
      try { const parsed: unknown = JSON.parse(item.data); if (!object(parsed)) continue; data = parsed; } catch { continue; }
      const name = item.name || data.type;
      let text = '';
      if (protocol === 'openai-chat') {
        const choice = objects(data.choices).find(value => value.index === undefined || value.index === 0);
        if (typeof choice?.delta?.content === 'string') text = choice.delta.content;
      } else if (protocol === 'openai-responses') {
        if (name === 'response.output_text.delta' && typeof data.delta === 'string') text = data.delta;
      } else if (protocol === 'gemini') {
        const candidate = objects(data.candidates).find(value => value.index === undefined || value.index === 0);
        text = objects(candidate?.content?.parts).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
      } else {
        if (name === 'message_start') text = objects(data.message?.content).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
        if (name === 'content_block_start' && data.content_block?.type === 'text' && typeof data.content_block.text === 'string') text = data.content_block.text;
        if (name === 'content_block_delta' && data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') text = data.delta.text;
      }
      if (text) emit(text);
    }
  };
}

/** Read only publicly returned reasoning text, never opaque provider signatures. */
export function createStreamActivityEmitter(protocol: ProviderProtocol, emit: (event: ModelActivityEvent) => void): { feed: (chunk: string) => void; finish: () => void } {
  let pending = ''; let geminiBlock = 0; let geminiThinking = false;
  const claudeThinking = new Set<number>();
  const responseIds = new Map<number, string | number>();
  const blocks = new Map<string, { text: string; done: boolean }>();
  const append = (id: string, text: unknown) => {
    if (typeof text !== 'string' || !text) return;
    const previous = blocks.get(id) ?? { text: '', done: false };
    if (previous.done) return;
    previous.text += text; blocks.set(id, previous); emit({ type: 'thinking', id, text });
  };
  const snapshot = (id: string, text: unknown) => {
    if (typeof text !== 'string' || !text) return;
    const previous = blocks.get(id);
    if (!previous) append(id, text);
    else if (text.startsWith(previous.text)) append(id, text.slice(previous.text.length));
  };
  const done = (id: string) => { const block = blocks.get(id); if (block && !block.done) { block.done = true; emit({ type: 'thinking_done', id }); } };
  const finish = () => { for (const id of blocks.keys()) done(id); };
  const responseId = (outputIndex: number, itemId?: string) => { const id = responseIds.get(outputIndex) ?? itemId ?? outputIndex; responseIds.set(outputIndex, id); return id; };
  const responseSummary = (item: Json, outputIndex: number) => {
    if (item.type !== 'reasoning') return;
    const id = responseId(outputIndex, item.id);
    objects(item.summary).forEach((part, index) => { if (part.type === 'summary_text') snapshot(`responses:${id}:${index}`, part.text); });
  };
  return { finish, feed: chunk => {
    pending += chunk;
    let separator: RegExpExecArray | null;
    while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
      const item = event(pending.slice(0, separator.index).replace(/^\uFEFF/, ''), true);
      pending = pending.slice(separator.index + separator[0].length);
      if (item.data.trim() === '[DONE]') { if (protocol === 'openai-chat') finish(); continue; }
      let data: Json;
      try { const parsed: unknown = JSON.parse(item.data); if (!object(parsed)) continue; data = parsed; } catch { continue; }
      const name = item.name || data.type;
      if (protocol === 'openai-chat') {
        const choice = objects(data.choices).find(value => value.index === undefined || value.index === 0);
        const delta = choice?.delta;
        append('chat:reasoning', typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : delta?.reasoning);
        if (choice?.finish_reason) finish();
      } else if (protocol === 'openai-responses') {
        const id = `responses:${responseId(data.output_index ?? 0, data.item_id ?? data.item?.id)}:${data.summary_index ?? 0}`;
        if (name === 'response.reasoning_summary_text.delta') append(id, data.delta);
        if (name === 'response.reasoning_summary_text.done') { snapshot(id, data.text); done(id); }
        if (name === 'response.reasoning_summary_part.added' && data.part?.type === 'summary_text') snapshot(id, data.part.text);
        if (name === 'response.reasoning_summary_part.done' && data.part?.type === 'summary_text') { snapshot(id, data.part.text); done(id); }
        if (['response.output_item.added', 'response.output_item.done'].includes(name) && object(data.item)) responseSummary(data.item, data.output_index ?? 0);
        if (name === 'response.completed' || name === 'response.incomplete' || name === 'response.failed') objects(data.response?.output).forEach(responseSummary);
      } else if (protocol === 'gemini') {
        const candidate = objects(data.candidates).find(value => value.index === undefined || value.index === 0);
        for (const part of objects(candidate?.content?.parts)) {
          if (part.thought === true && typeof part.text === 'string') { geminiThinking = true; append(`gemini:${geminiBlock}`, part.text); }
          else if (geminiThinking && (typeof part.text === 'string' || part.functionCall)) { done(`gemini:${geminiBlock}`); geminiBlock++; geminiThinking = false; }
        }
      } else {
        if (name === 'message_start') objects(data.message?.content).forEach((part, index) => { if (part.type === 'thinking') { claudeThinking.add(index); snapshot(`claude:${index}`, part.thinking); } });
        if (name === 'content_block_start') {
          const index = data.index ?? 0;
          if (data.content_block?.type === 'thinking') { claudeThinking.add(index); snapshot(`claude:${index}`, data.content_block.thinking); }
          else claudeThinking.delete(index);
        }
        if (name === 'content_block_delta' && claudeThinking.has(data.index ?? 0) && data.delta?.type === 'thinking_delta') append(`claude:${data.index ?? 0}`, data.delta.thinking);
        if (name === 'content_block_stop') { done(`claude:${data.index ?? 0}`); claudeThinking.delete(data.index ?? 0); }
      }
      if (terminal(protocol, item)) finish();
    }
  } };
}

/** Non-streaming adapters expose the same public text blocks as their SSE counterparts. */
export function emitResponseActivities(protocol: ProviderProtocol, data: Json, emit: (event: ModelActivityEvent) => void): void {
  const thinking = (id: string, text: unknown) => { if (typeof text === 'string' && text) { emit({ type: 'thinking', id, text }); emit({ type: 'thinking_done', id }); } };
  if (protocol === 'openai-chat') {
    const message = data.choices?.[0]?.message;
    thinking('chat:reasoning', typeof message?.reasoning_content === 'string' ? message.reasoning_content : message?.reasoning);
  } else if (protocol === 'openai-responses') {
    objects(data.output).forEach((item, outputIndex) => { if (item.type === 'reasoning') objects(item.summary).forEach((part, index) => { if (part.type === 'summary_text') thinking(`responses:${item.id ?? outputIndex}:${index}`, part.text); }); });
  } else if (protocol === 'gemini') {
    let index = 0;
    for (const part of objects(data.candidates?.[0]?.content?.parts)) if (part.thought === true) thinking(`gemini:${index++}`, part.text);
  } else objects(data.content).forEach((part, index) => { if (part.type === 'thinking') thinking(`claude:${index}`, part.thinking); });
}

/** Assemble visible text and tool events into the envelopes used by non-streaming validation. */
export function parseModelStream(protocol: ProviderProtocol, raw: string): { data: Json; incomplete: boolean; error?: string } {
  const blocks = raw.replace(/^\uFEFF/, '').split(/\r\n\r\n|\n\n|\r\r/);
  const events = blocks.map((block, index) => event(block, index < blocks.length - 1));
  let ended = false; let error: string | undefined; let finish: string | undefined;
  let text = ''; let input = 0; let output = 0; let thoughts = 0;
  let chatReasoning = '';
  let cacheRead = 0; let cacheCreate = 0;
  let finalResponse: Json | undefined; let blocked = false; let promptBlockReason: string | undefined;
  const contentBlocks = new Map<number, Json>();
  const chatCalls = new Map<number, Json>();
  const responseItems = new Map<number, Json>();
  const geminiParts: Json[] = [];
  for (const item of events) {
    if (!item.data) continue;
    if (item.data.trim() === '[DONE]') { if (protocol === 'openai-chat' && item.complete) ended = true; continue; }
    let data: Json;
    try { const parsed: unknown = JSON.parse(item.data); if (!object(parsed)) throw new Error(); data = parsed; }
    catch { error ??= '模型流式响应包含无效 JSON 事件，已保留收到的内容。'; continue; }
    const name = item.name || data.type;
    if (name === 'error' || data.error) { error ??= '模型服务在流式生成过程中返回错误，已保留收到的内容。'; ended = item.complete; continue; }
    if (protocol === 'openai-chat') {
      const choice = objects(data.choices).find(value => value.index === undefined || value.index === 0);
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
      if (typeof choice?.delta?.reasoning_content === 'string') chatReasoning += choice.delta.reasoning_content;
      for (const call of objects(choice?.delta?.tool_calls)) {
        const index = call.index ?? 0;
        const previous = chatCalls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (typeof call.id === 'string') previous.id = call.id;
        if (typeof call.function?.name === 'string') previous.function.name += call.function.name;
        if (typeof call.function?.arguments === 'string') previous.function.arguments += call.function.arguments;
        chatCalls.set(index, previous);
      }
      if (choice?.delta?.refusal) blocked = true;
      if (choice?.finish_reason) finish = choice.finish_reason;
      input = Math.max(input, count(data.usage?.prompt_tokens)); output = Math.max(output, count(data.usage?.completion_tokens));
    } else if (protocol === 'openai-responses') {
      if (name === 'response.output_text.delta' && typeof data.delta === 'string') text += data.delta;
      if (name === 'response.output_item.added' && object(data.item)) responseItems.set(data.output_index ?? 0, { ...data.item });
      if (name === 'response.function_call_arguments.delta' && typeof data.delta === 'string') {
        const previous = responseItems.get(data.output_index ?? 0);
        if (previous?.type === 'function_call') previous.arguments = (previous.arguments ?? '') + data.delta;
      }
      if (name === 'response.function_call_arguments.done') {
        const previous = responseItems.get(data.output_index ?? 0);
        if (previous?.type === 'function_call' && typeof data.arguments === 'string') previous.arguments = data.arguments;
      }
      if (name === 'response.output_item.done' && object(data.item)) responseItems.set(data.output_index ?? 0, data.item);
      if (name === 'response.refusal.delta' || name === 'response.refusal.done') blocked = true;
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(name)) {
        ended = item.complete;
        finalResponse = object(data.response) ? data.response : undefined;
        if (name === 'response.failed') error ??= '模型服务未能完成流式生成，已保留收到的内容。';
        if (name === 'response.incomplete') finish = 'length';
      }
      const usage = data.response?.usage ?? data.usage;
      input = Math.max(input, count(usage?.input_tokens)); output = Math.max(output, count(usage?.output_tokens));
    } else if (protocol === 'gemini') {
      const candidate = objects(data.candidates).find(value => value.index === undefined || value.index === 0);
      for (const part of objects(candidate?.content?.parts)) {
        geminiParts.push(part);
        if (!part.thought && typeof part.text === 'string') text += part.text;
      }
      if (candidate?.finishReason) { finish = candidate.finishReason; ended = item.complete; }
      if (data.promptFeedback?.blockReason) { blocked = true; promptBlockReason = String(data.promptFeedback.blockReason); ended = item.complete; }
      input = Math.max(input, count(data.usageMetadata?.promptTokenCount));
      output = Math.max(output, count(data.usageMetadata?.candidatesTokenCount));
      thoughts = Math.max(thoughts, count(data.usageMetadata?.thoughtsTokenCount));
    } else {
      if (name === 'message_start') {
        const message = data.message;
        input = Math.max(input, count(message?.usage?.input_tokens)); output = Math.max(output, count(message?.usage?.output_tokens));
        cacheRead = Math.max(cacheRead, count(message?.usage?.cache_read_input_tokens)); cacheCreate = Math.max(cacheCreate, count(message?.usage?.cache_creation_input_tokens));
        for (const part of objects(message?.content)) if (part.type === 'text' && typeof part.text === 'string') text += part.text;
      }
      if (name === 'content_block_start' && object(data.content_block)) contentBlocks.set(data.index ?? 0, { ...data.content_block });
      if (name === 'content_block_delta') {
        const index = data.index ?? 0;
        const part = contentBlocks.get(index) ?? { type: 'text', text: '' };
        if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') part.text = (part.text ?? '') + data.delta.text;
        if (data.delta?.type === 'input_json_delta' && typeof data.delta.partial_json === 'string') part.partialJson = (part.partialJson ?? '') + data.delta.partial_json;
        if (data.delta?.type === 'thinking_delta' && typeof data.delta.thinking === 'string') part.thinking = (part.thinking ?? '') + data.delta.thinking;
        if (data.delta?.type === 'signature_delta' && typeof data.delta.signature === 'string') part.signature = (part.signature ?? '') + data.delta.signature;
        contentBlocks.set(index, part);
      }
      if (name === 'message_delta') {
        if (data.delta?.stop_reason) finish = data.delta.stop_reason;
        output = Math.max(output, count(data.usage?.output_tokens)); input = Math.max(input, count(data.usage?.input_tokens));
        cacheRead = Math.max(cacheRead, count(data.usage?.cache_read_input_tokens)); cacheCreate = Math.max(cacheCreate, count(data.usage?.cache_creation_input_tokens));
      }
      if (name === 'message_stop') ended = item.complete;
    }
  }
  let data: Json;
  if (protocol === 'openai-chat') data = { choices: [{ message: { content: text, ...(chatReasoning ? { reasoning_content: chatReasoning } : {}), ...(chatCalls.size ? { tool_calls: [...chatCalls.entries()].sort((a, b) => a[0] - b[0]).map(value => value[1]) } : {}), ...(blocked ? { refusal: true } : {}) }, finish_reason: finish }], usage: { prompt_tokens: input, completion_tokens: output } };
  else if (protocol === 'openai-responses') {
    const finalText = objects(finalResponse?.output).flatMap(value => objects(value.content)).filter(value => value.type === 'output_text' && typeof value.text === 'string').map(value => value.text).join('\n');
    const items = objects(finalResponse?.output).length ? objects(finalResponse?.output) : [...responseItems.entries()].sort((a, b) => a[0] - b[0]).map(value => value[1]);
    const otherItems = items.filter(value => value.type !== 'message');
    const responseOutput = finalText ? items : [...otherItems, ...(text || blocked ? [{ type: 'message', content: [{ type: 'output_text', text }, ...(blocked ? [{ type: 'refusal' }] : [])] }] : [])];
    data = { ...finalResponse, status: finish === 'length' ? 'incomplete' : finalResponse?.status ?? 'completed', output: responseOutput, usage: { input_tokens: input, output_tokens: output } };
  } else if (protocol === 'gemini') data = { candidates: [{ finishReason: finish, content: { role: 'model', parts: [{ text }, ...geminiParts.filter(part => typeof part.text !== 'string')] }, historyParts: geminiParts }], ...(blocked ? { promptFeedback: { blockReason: promptBlockReason ?? 'OTHER' } } : {}), usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, thoughtsTokenCount: thoughts } };
  else {
    const parts = [...contentBlocks.entries()].sort((a, b) => a[0] - b[0]).map(value => value[1]);
    for (const part of parts) {
      if (part.type === 'tool_use' && typeof part.partialJson === 'string') {
        try { part.input = JSON.parse(part.partialJson); } catch { error ??= '模型返回的工具参数不是有效 JSON。'; }
        delete part.partialJson;
      }
    }
    data = { type: 'message', stop_reason: finish, content: [...(text ? [{ type: 'text', text }] : []), ...parts], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead } };
  }
  if (!ended) error ??= '模型流式响应在结束标记之前中断，已保留收到的部分内容。';
  return { data, incomplete: !ended || Boolean(error) || finish === 'length' || finish === 'MAX_TOKENS' || finish === 'max_tokens', error };
}
