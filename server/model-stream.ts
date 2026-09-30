import type { ProviderProtocol } from '../shared/types.js';

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

/** Assemble text-only SSE into the same envelopes used by non-streaming validation. */
export function parseModelStream(protocol: ProviderProtocol, raw: string): { data: Json; incomplete: boolean; error?: string } {
  const blocks = raw.replace(/^\uFEFF/, '').split(/\r\n\r\n|\n\n|\r\r/);
  const events = blocks.map((block, index) => event(block, index < blocks.length - 1));
  let ended = false; let error: string | undefined; let finish: string | undefined;
  let text = ''; let input = 0; let output = 0; let thoughts = 0;
  let cacheRead = 0; let cacheCreate = 0;
  let finalResponse: Json | undefined; let blocked = false; let promptBlockReason: string | undefined;
  const textParts = new Map<number, string>();
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
      if (choice?.delta?.refusal) blocked = true;
      if (choice?.finish_reason) finish = choice.finish_reason;
      input = Math.max(input, count(data.usage?.prompt_tokens)); output = Math.max(output, count(data.usage?.completion_tokens));
    } else if (protocol === 'openai-responses') {
      if (name === 'response.output_text.delta' && typeof data.delta === 'string') text += data.delta;
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
      for (const part of objects(candidate?.content?.parts)) if (!part.thought && typeof part.text === 'string') text += part.text;
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
      if (name === 'content_block_start' && data.content_block?.type === 'text') textParts.set(data.index ?? 0, typeof data.content_block.text === 'string' ? data.content_block.text : '');
      if (name === 'content_block_delta' && data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') textParts.set(data.index ?? 0, (textParts.get(data.index ?? 0) ?? '') + data.delta.text);
      if (name === 'message_delta') {
        if (data.delta?.stop_reason) finish = data.delta.stop_reason;
        output = Math.max(output, count(data.usage?.output_tokens)); input = Math.max(input, count(data.usage?.input_tokens));
        cacheRead = Math.max(cacheRead, count(data.usage?.cache_read_input_tokens)); cacheCreate = Math.max(cacheCreate, count(data.usage?.cache_creation_input_tokens));
      }
      if (name === 'message_stop') ended = item.complete;
    }
  }
  let data: Json;
  if (protocol === 'openai-chat') data = { choices: [{ message: { content: text, ...(blocked ? { refusal: true } : {}) }, finish_reason: finish }], usage: { prompt_tokens: input, completion_tokens: output } };
  else if (protocol === 'openai-responses') {
    const finalText = objects(finalResponse?.output).flatMap(value => objects(value.content)).filter(value => value.type === 'output_text' && typeof value.text === 'string').map(value => value.text).join('\n');
    data = { ...finalResponse, status: finish === 'length' ? 'incomplete' : finalResponse?.status ?? 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: finalText || text }, ...(blocked ? [{ type: 'refusal' }] : [])] }], usage: { input_tokens: input, output_tokens: output } };
  } else if (protocol === 'gemini') data = { candidates: [{ finishReason: finish, content: { parts: [{ text }] } }], ...(blocked ? { promptFeedback: { blockReason: promptBlockReason ?? 'OTHER' } } : {}), usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, thoughtsTokenCount: thoughts } };
  else data = { type: 'message', stop_reason: finish, content: [{ type: 'text', text: text + [...textParts.entries()].sort((a, b) => a[0] - b[0]).map(value => value[1]).join('\n') }], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead } };
  if (!ended) error ??= '模型流式响应在结束标记之前中断，已保留收到的部分内容。';
  return { data, incomplete: !ended || Boolean(error) || finish === 'length' || finish === 'MAX_TOKENS' || finish === 'max_tokens', error };
}
