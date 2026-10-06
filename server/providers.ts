import { ZodError } from 'zod';
import { providerFetch } from './outbound.js';
import { createSecretStreamRedactor, redactSseFragments, secretVariants } from './stream-redaction.js';
import type { CapturedModelResponse, ModelActivityEvent, ModelRequest, ModelRequestSnapshot, ModelResult, ModelToolCall, ModelToolContinuation, ModelTransportDiagnostics, OutputIssue, ProviderConfig } from '../shared/types.js';
import { DEFAULT_MODEL_TIMEOUT_MS, providerWireOptions, validateProviderOptions } from './provider-options.js';
import { createStreamActivityEmitter, createStreamEndDetector, createStreamTextEmitter, emitResponseActivities, parseModelStream } from './model-stream.js';
export { validateProviderOptions } from './provider-options.js';

export const MODEL_TIMEOUT_MS = DEFAULT_MODEL_TIMEOUT_MS;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

type JsonObject = Record<string, any>;

/** Charges returned by a provider remain visible even when its output is rejected. */
export class ModelOutputError extends Error {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly issues?: OutputIssue[];
  constructor(message: string, tokens: { inputTokens: number; outputTokens: number }, issues?: OutputIssue[]) {
    super(message);
    this.name = 'ModelOutputError';
    this.inputTokens = tokens.inputTokens;
    this.outputTokens = tokens.outputTokens;
    this.issues = issues;
  }
}

/** A completed tool turn is waiting for a human answer, without an open request. */
export class ModelInteractionPause extends Error {
  inputTokens = 0;
  outputTokens = 0;
  usageEstimated?: boolean;
  constructor(message = '等待用户选择。') {
    super(message);
    this.name = 'ModelInteractionPause';
  }
}

function endpoint(baseUrl: string, suffix: string): URL {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('模型服务地址无效，请填写完整的 HTTP 或 HTTPS 地址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('模型服务地址仅支持 HTTP/HTTPS，且不能在地址中包含用户名或密码。');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix}`;
  url.hash = '';
  return url;
}

function usage(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : 0;
}

function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const objects = (value: unknown): JsonObject[] => Array.isArray(value) ? value.filter(object) : [];
const credentialName = (name: string) => /^(?:authorization|proxyauthorization|apikey|xapikey|xgoogapikey|accesstoken|refreshtoken|idtoken|authtoken|token|secret|clientsecret|password|cookie|setcookie|cfaccessjwtassertion|cfaccessclientsecret|cfaccessclientid|session|sessionid|sid)$/i.test(name.replace(/[-_\s]/g, ''));

function redactKnown(text: string, key?: string): string {
  for (const secret of new Set([key, key?.trim()].filter((value): value is string => Boolean(value)))) {
    for (const variant of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) text = text.split(variant).join('[REDACTED]');
  }
  return text;
}

/** Redact credential assignments even if the last JSON string/value was cut off. */
function redactAssignments(text: string): string {
  const ranges: { start: number; end: number }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '"') { cursor++; continue; }
    const nameStart = cursor++;
    let closed = false;
    while (cursor < text.length) { if (text[cursor] === '\\') { cursor += 2; continue; } if (text[cursor++] === '"') { closed = true; break; } }
    if (!closed) break;
    const nameEnd = cursor;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    if (text[cursor] !== ':') continue;
    cursor++;
    let name: string;
    try { name = JSON.parse(text.slice(nameStart, nameEnd)); } catch { continue; }
    if (!credentialName(name)) continue;
    let start = cursor;
    while (start < text.length && /\s/.test(text[start])) start++;
    let end = start;
    if (text[start] === '"') {
      end++;
      while (end < text.length) { if (text[end] === '\\') { end += 2; continue; } if (text[end++] === '"') break; }
    } else if (text[start] === '{' || text[start] === '[') {
      let depth = 0; let inString = false;
      for (; end < text.length; end++) {
        const char = text[end];
        if (inString) { if (char === '\\') end++; else if (char === '"') inString = false; continue; }
        if (char === '"') inString = true;
        else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') { if (--depth === 0) { end++; break; } }
      }
    } else { while (end < text.length && !/[,}\]\s]/.test(text[end])) end++; }
    ranges.push({ start, end: Math.min(end, text.length) });
    cursor = Math.max(end, cursor);
  }
  for (let index = ranges.length - 1; index >= 0; index--) {
    const { start, end } = ranges[index]; text = `${text.slice(0, start)}"[REDACTED]"${text.slice(end)}`;
  }
  return text;
}

/** Preserve original response formatting unless credentials must be removed. */
function redactPayload(text: string, key?: string, nesting = 0): string {
  if (/^\s*(?::|event:|data:)/.test(text)) text = redactSseFragments(text, key ? [key] : []);
  const safe = redactAssignments(redactKnown(text, key));
  if (nesting >= 8) return safe;
  try {
    const parsed: unknown = JSON.parse(safe);
    if (!object(parsed) && !Array.isArray(parsed)) return safe;
    const queue: JsonObject[] = [parsed]; let changed = false;
    while (queue.length) {
      const item = queue.pop()!;
      for (const field of Object.keys(item)) {
        const value: unknown = item[field];
        if (credentialName(field)) { if (value !== '[REDACTED]') { item[field] = '[REDACTED]'; changed = true; } }
        else if (typeof value === 'string') {
          const redacted = redactPayload(value, key, nesting + 1);
          if (redacted !== value) { item[field] = redacted; changed = true; }
        } else if (object(value) || Array.isArray(value)) queue.push(value);
      }
    }
    return changed ? JSON.stringify(parsed) : safe;
  } catch { return safe; }
}

/** Apply identical redaction to automatic responses and user-pasted artifacts. */
export function redactModelPayload(text: string, keys: string[] = []): string {
  let safe = redactPayload(text);
  for (const key of [...new Set(keys.filter(Boolean))].sort((a, b) => b.length - a.length)) safe = redactPayload(safe, key);
  return safe;
}

export function redactKnownSecrets(text: string, keys: string[]) {
  for (const key of secretVariants(keys)) text = text.split(key).join('[REDACTED]');
  return text;
}

function redactWirePayload(text: string, key?: string): string {
  if (!/^\s*(?::|event:|data:)/.test(text)) return redactPayload(text, key);
  text = redactSseFragments(text, key ? [key] : []);
  // SSE is a sequence of JSON documents, not one document. Inspect each data
  // field so credentials nested in a stringified model reply are also removed.
  return text.split(/(\r\n\r\n|\n\n|\r\r)/).map(block => {
    const lines = block.split(/\r\n|\r|\n/);
    const fields = lines.filter(line => line.startsWith('data:'));
    if (!fields.length) return redactPayload(block, key);
    const payload = fields.map(line => line.slice(5).replace(/^ /, '')).join('\n');
    const redacted = redactPayload(payload, key);
    if (redacted === payload) return redactPayload(block, key);
    let written = false;
    return lines.flatMap(line => {
      if (!line.startsWith('data:')) return [redactKnown(line, key)];
      if (written) return [];
      written = true; return redacted.split('\n').map(value => `data: ${value}`);
    }).join('\n');
  }).join('');
}

function responseText(protocol: ProviderConfig['protocol'], data: JsonObject): string {
  switch (protocol) {
    case 'openai-chat': return typeof data.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '';
    case 'openai-responses': return objects(data.output).flatMap(item => objects(item.content)).filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('\n');
    case 'gemini': return objects(data.candidates?.[0]?.content?.parts).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('\n');
    case 'claude': return objects(data.content).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  }
}

function outputIncomplete(protocol: ProviderConfig['protocol'], data: JsonObject): boolean {
  return protocol === 'openai-chat' ? data.choices?.[0]?.finish_reason === 'length'
    : protocol === 'openai-responses' ? data.status === 'incomplete'
    : protocol === 'gemini' ? data.candidates?.[0]?.finishReason === 'MAX_TOKENS'
    : data.stop_reason === 'max_tokens';
}

function requestBody(config: ProviderConfig, request: ModelRequest) {
  const tokens = request.maxOutputTokens ?? config.maxOutputTokens;
  validateProviderOptions(config, tokens);
  if (!config.model.trim()) throw new Error('请先填写模型名称。');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = config.apiKey?.trim();
  const options = providerWireOptions(config);
  const stream = Boolean(request.onTextDelta) || (config.stream ?? false);
  const tools = request.tools ?? [];
  const messages = request.messages?.length ? request.messages : undefined;
  const system = messages ? messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n') : request.system;
  if (stream) headers.Accept = 'text/event-stream';
  switch (config.protocol) {
    case 'openai-chat':
      if (key) headers.Authorization = `Bearer ${key}`;
      return { url: endpoint(config.baseUrl, 'chat/completions'), headers, body: {
        model: config.model, messages: messages ? messages.map(message => ({ ...message })) : [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }],
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
        [config.openaiMaxTokensField ?? 'max_tokens']: tokens, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), ...options,
      } };
    case 'openai-responses':
      if (key) headers.Authorization = `Bearer ${key}`;
      return { url: endpoint(config.baseUrl, 'responses'), headers, body: {
        model: config.model, ...(messages ? { input: messages.map(message => ({ ...message })) } : { instructions: request.system, input: request.prompt }), max_output_tokens: tokens, stream, store: false, ...options,
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })) } : {}),
      } };
    case 'gemini':
      if (key) headers['x-goog-api-key'] = key;
      const url = endpoint(config.baseUrl, `models/${encodeURIComponent(config.model.replace(/^models\//, ''))}:${stream ? 'streamGenerateContent' : 'generateContent'}`);
      if (stream) url.searchParams.set('alt', 'sse');
      return { url, headers, body: {
        ...(!messages || system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages ? messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })) : [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig: { maxOutputTokens: tokens, ...options },
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] } : {}),
      } };
    case 'claude':
      if (key) headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      return { url: endpoint(config.baseUrl, 'messages'), headers, body: {
        model: config.model, ...(!messages || system ? { system } : {}), messages: messages ? messages.filter(message => message.role !== 'system').map(message => ({ ...message })) : [{ role: 'user', content: request.prompt }], max_tokens: tokens, stream, ...options,
        ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
      } };
    default: throw new Error('不支持的模型接口协议。');
  }
}

function parseResult(protocol: ProviderConfig['protocol'], data: JsonObject): ModelResult {
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  switch (protocol) {
    case 'openai-chat': {
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('模型输出达到上限，内容已截断；请调高输出上限或缩小本次生成范围。');
      if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new Error('模型服务未能完成这次内容请求。');
      if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error('模型未返回完整正文，请检查模型是否支持普通文本输出。');
      text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
      inputTokens = usage(data.usage?.prompt_tokens); outputTokens = usage(data.usage?.completion_tokens);
      break;
    }
    case 'openai-responses': {
      if (data.status === 'incomplete') throw new Error('模型输出未完成或已截断；请调高输出上限或缩小本次生成范围。');
      if (data.error || (data.status && data.status !== 'completed')) throw new Error('模型服务未能完成这次内容请求。');
      const blocks = (Array.isArray(data.output) ? data.output : []).flatMap((item: JsonObject) => Array.isArray(item.content) ? item.content : []);
      if (blocks.some((block: JsonObject) => block.type === 'refusal')) throw new Error('模型服务未能完成这次内容请求。');
      text = blocks.filter((block: JsonObject) => block.type === 'output_text' && typeof block.text === 'string').map((block: JsonObject) => block.text).join('\n');
      inputTokens = usage(data.usage?.input_tokens); outputTokens = usage(data.usage?.output_tokens);
      break;
    }
    case 'gemini': {
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason === 'MAX_TOKENS') throw new Error('模型输出达到上限，内容已截断；请调高输出上限或缩小本次生成范围。');
      if (data.promptFeedback?.blockReason || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT'].includes(candidate?.finishReason)) throw new Error('模型服务拦截了本次输入或输出，未返回可用正文；请查看模型结束原因与拦截反馈。');
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new Error('模型服务未能完成这次内容请求；请查看记录中的模型结束原因。');
      text = (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []).filter((part: JsonObject) => !part.thought && typeof part.text === 'string').map((part: JsonObject) => part.text).join('\n');
      inputTokens = usage(data.usageMetadata?.promptTokenCount);
      outputTokens = usage(data.usageMetadata?.candidatesTokenCount) + usage(data.usageMetadata?.thoughtsTokenCount);
      break;
    }
    case 'claude': {
      if (data.stop_reason === 'max_tokens') throw new Error('模型输出达到上限，内容已截断；请调高输出上限或缩小本次生成范围。');
      if (data.type === 'error' || (data.stop_reason && !['end_turn', 'stop_sequence'].includes(data.stop_reason))) throw new Error('模型服务未能完成这次内容请求。');
      text = (Array.isArray(data.content) ? data.content : []).filter((part: JsonObject) => part.type === 'text' && typeof part.text === 'string').map((part: JsonObject) => part.text).join('\n');
      inputTokens = usage(data.usage?.input_tokens) + usage(data.usage?.cache_creation_input_tokens) + usage(data.usage?.cache_read_input_tokens);
      outputTokens = usage(data.usage?.output_tokens);
      break;
    }
  }
  if (!text.trim()) throw new Error('模型返回了空内容，请检查模型和接口协议是否匹配。');
  return { text: text.trim(), inputTokens, outputTokens };
}

function responseUsage(protocol: ProviderConfig['protocol'], data: JsonObject): { inputTokens: number; outputTokens: number } {
  if (protocol === 'openai-chat') return { inputTokens: usage(data.usage?.prompt_tokens), outputTokens: usage(data.usage?.completion_tokens) };
  if (protocol === 'gemini') return { inputTokens: usage(data.usageMetadata?.promptTokenCount), outputTokens: usage(data.usageMetadata?.candidatesTokenCount) + usage(data.usageMetadata?.thoughtsTokenCount) };
  return { inputTokens: usage(data.usage?.input_tokens) + usage(data.usage?.cache_creation_input_tokens) + usage(data.usage?.cache_read_input_tokens), outputTokens: usage(data.usage?.output_tokens) };
}

function requestSnapshot(config: ProviderConfig, wire: ReturnType<typeof requestBody>): ModelRequestSnapshot {
  const url = new URL(wire.url);
  for (const name of [...url.searchParams.keys()]) {
    if (credentialName(name) || /(?:key|token|secret|password|signature|credential|authorization|session|^sid$|^sig$|^jwt$)/i.test(name)) url.searchParams.set(name, '[REDACTED]');
  }
  return {
    protocol: config.protocol, model: redactKnown(config.model, config.apiKey), method: 'POST',
    url: redactKnown(url.toString(), config.apiKey),
    headers: Object.fromEntries(Object.entries(wire.headers).map(([name, value]) => [name, credentialName(name) ? '[REDACTED]' : redactKnown(value, config.apiKey)])),
    body: redactPayload(JSON.stringify(wire.body), config.apiKey), startedAt: new Date().toISOString(),
    timeoutMs: config.timeoutMs ?? MODEL_TIMEOUT_MS, stream: Boolean((wire.body as JsonObject).stream || wire.url.searchParams.get('alt') === 'sse'),
  };
}

/** Build a redacted, non-billable preview using exactly the same wire mapping. */
export function buildRequestSnapshot(config: ProviderConfig, request: ModelRequest): ModelRequestSnapshot {
  return requestSnapshot(config, continuationWire(config, request));
}

async function readBody(response: Response, config: ProviderConfig, onTextDelta?: (text: string) => void, onActivity?: (event: ModelActivityEvent) => void): Promise<{ raw: string; bytes: number; incomplete: boolean; error?: 'limit' | 'read' }> {
  if (!response.body) return { raw: '', bytes: 0, incomplete: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const streaming = config.stream || response.headers.get('content-type')?.includes('text/event-stream');
  const detector = createStreamEndDetector(config.protocol);
  const decoder = new TextDecoder();
  const redactor = createSecretStreamRedactor(config.apiKey ? [config.apiKey] : [], text => onTextDelta?.(text));
  const emit = createStreamTextEmitter(config.protocol, text => redactor.feed(text));
  const activities = createStreamActivityEmitter(config.protocol, event => onActivity?.(event));
  let length = 0;
  let error: 'limit' | 'read' | undefined;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAX_RESPONSE_BYTES - length;
      if (next.value.byteLength > remaining) {
        if (remaining) chunks.push(next.value.subarray(0, remaining));
        length = MAX_RESPONSE_BYTES;
        error = 'limit';
        try { await reader.cancel(); } catch { /* Keep bytes already received. */ }
        break;
      }
      chunks.push(next.value);
      length += next.value.byteLength;
      const decoded = decoder.decode(next.value, { stream: true });
      if (streaming) { activities.feed(decoded); emit(decoded); }
      if (streaming && detector(decoded)) {
        // End events are authoritative. Some gateways keep a finished SSE socket open.
        try { await reader.cancel(); } catch { /* All protocol events were received. */ }
        break;
      }
    }
  } catch { error ??= 'read'; }
  // Socket closure is not a thinking completion marker. Interrupted blocks
  // remain open for the job's failed/paused/cancelled state to settle them.
  finally { redactor.finish(); reader.releaseLock(); }
  return { raw: Buffer.concat(chunks, length).toString('utf8'), bytes: length, incomplete: Boolean(error), error };
}

function inspectBody(config: ProviderConfig, response: Response | undefined, body: Awaited<ReturnType<typeof readBody>>) {
  let data: JsonObject | undefined;
  let text = '';
  let tokens = { inputTokens: 0, outputTokens: 0 };
  let incomplete = body.incomplete;
  let streamError: string | undefined;
  // Non-throwing inspection only. Persist before strict parsing, finish-reason
  // checks, or schema validation can reject any portion of the response.
  try {
    const isStream = response?.headers.get('content-type')?.includes('text/event-stream') || /^\s*(?::|event:|data:)/.test(body.raw);
    if (isStream) {
      const parsed = parseModelStream(config.protocol, body.raw); data = parsed.data; incomplete ||= parsed.incomplete; streamError = parsed.error;
    } else { const parsed: unknown = JSON.parse(body.raw); if (object(parsed)) data = parsed; }
    if (data) { text = responseText(config.protocol, data); tokens = responseUsage(config.protocol, data); incomplete ||= outputIncomplete(config.protocol, data); }
  } catch { /* Invalid JSON is still captured verbatim, subject to redaction. */ }
  return { data, text, tokens, incomplete, streamError };
}

/** A single billable request. Failures never trigger automatic retries. */
async function sendModelRequest(config: ProviderConfig, request: ModelRequest, wire: ReturnType<typeof requestBody>): Promise<{ data: JsonObject; result: ModelResult }> {
  const snapshot = requestSnapshot(config, wire);
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let captured = false;
  let capturedTokens = { inputTokens: 0, outputTokens: 0 };
  let response: Response | undefined;
  let received: Awaited<ReturnType<typeof readBody>> = { raw: '', bytes: 0, incomplete: false };
  let transport: ModelTransportDiagnostics['transport'] = 'http';
  let errorCode: string | undefined;
  const capture = () => {
    const inspection = inspectBody(config, response, received);
    capturedTokens = inspection.tokens;
    if (captured) return inspection;
    captured = true;
    let incomplete = inspection.incomplete || transport !== 'http';
    const bounded = (value: string) => {
      const bytes = Buffer.from(redactWirePayload(value, config.apiKey));
      if (bytes.length > MAX_RESPONSE_BYTES) { incomplete = true; return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, MAX_RESPONSE_BYTES), { stream: true }); }
      return bytes.toString('utf8');
    };
    const rawResponse = bounded(received.raw); const text = bounded(inspection.text);
    const responseHeaders: Record<string, string> = {};
    for (const name of ['content-type', 'content-length', 'request-id', 'x-request-id', 'x-goog-request-id', 'x-amzn-requestid', 'retry-after']) {
      const value = response?.headers.get(name);
      if (value !== null && value !== undefined) responseHeaders[name] = redactKnown(value, config.apiKey).slice(0, 500);
    }
    const metadataCode = (code: unknown): string | undefined => typeof code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? redactKnown(code, config.apiKey) : undefined;
    const data = inspection.data;
    const finishReason = metadataCode(config.protocol === 'gemini' ? data?.candidates?.[0]?.finishReason : config.protocol === 'openai-chat' ? data?.choices?.[0]?.finish_reason : config.protocol === 'claude' ? data?.stop_reason : data?.status);
    const promptBlockReason = metadataCode(config.protocol === 'gemini' ? data?.promptFeedback?.blockReason : undefined);
    const refusal = config.protocol === 'openai-responses' && objects(data?.output).flatMap(item => objects(item.content)).some(part => part.type === 'refusal');
    const blocked = Boolean(promptBlockReason || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'content_filter', 'refusal'].includes(finishReason ?? '') || data?.choices?.[0]?.message?.refusal || refusal);
    const validEndings = config.protocol === 'gemini' ? ['STOP', 'MAX_TOKENS'] : config.protocol === 'openai-chat' ? ['stop', 'length', 'tool_calls'] : config.protocol === 'claude' ? ['end_turn', 'stop_sequence', 'max_tokens', 'tool_use'] : ['completed', 'incomplete'];
    const rejectedEnding = Boolean(finishReason && !validEndings.includes(finishReason));
    const modelOutcome: ModelTransportDiagnostics['modelOutcome'] = !response ? undefined
      : !response.ok || data?.error || inspection.streamError ? 'error'
      : blocked ? 'blocked' : incomplete ? 'truncated'
      : rejectedEnding || (!data && received.raw.trim()) ? 'error' : text.trim() || (data && responseToolCalls(config.protocol, data).length) ? 'completed' : 'empty';
    const value: CapturedModelResponse = {
      rawResponse, text, ...inspection.tokens, ...(response ? { httpStatus: response.status } : {}), incomplete, request: snapshot,
      diagnostics: { elapsedMs: Math.max(0, Date.now() - started), responseBytes: received.bytes, responseHeaders, transport, ...(errorCode ? { errorCode } : {}), ...(modelOutcome ? { modelOutcome } : {}), ...(finishReason ? { finishReason } : {}), ...(promptBlockReason ? { promptBlockReason } : {}) },
    };
    try { request.onResponse?.(value); }
    catch { throw new Error('模型响应已收到，但保存原始输出失败；本次结果没有继续处理，请检查存储后重试。'); }
    return inspection;
  };
  const abort = () => controller.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, snapshot.timeoutMs);
  timer.unref?.();
  try {
    try { request.onRequest?.(structuredClone(snapshot)); }
    catch { throw new Error('保存模型请求记录失败，本次请求未发送，请检查存储。'); }
    if (request.signal?.aborted) { transport = 'cancelled'; controller.abort(); throw new Error('模型请求已取消。'); }
    try {
      // Never forward credentials to a redirect target, including same-origin redirects.
      response = await providerFetch(wire.url, { method: 'POST', headers: wire.headers, body: JSON.stringify(wire.body), signal: controller.signal, redirect: 'error' });
    } catch (error) {
      transport = request.signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'network_error';
      const code = (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code ?? (error as { code?: unknown })?.code;
      if (typeof code === 'string' && /^(?:E[A-Z0-9_]{1,50}|UND_ERR_[A-Z0-9_]{1,40}|ABORT_ERR)$/.test(code)) errorCode = code;
      throw new Error('无法连接模型服务，请检查服务地址、网络和接口配置。');
    }
    received = await readBody(response, { ...config, stream: snapshot.stream }, response.ok ? request.onTextDelta : undefined, response.ok ? request.onActivity : undefined);
    transport = request.signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : received.error === 'read' ? 'interrupted' : 'http';
    const { data, tokens, streamError } = capture();
    if (data && response.ok && !response.headers.get('content-type')?.includes('text/event-stream') && !/^\s*(?::|event:|data:)/.test(received.raw)) emitResponseActivities(config.protocol, data, event => request.onActivity?.(event));
    if (received.error === 'limit') throw new ModelOutputError('模型响应超过 16 MiB，已保留收到的部分内容，请缩小本次生成范围。', tokens);
    if (received.error === 'read') throw new ModelOutputError('读取模型响应中断，已保留收到的部分内容，请检查网络连接。', tokens);
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? '请检查密钥及模型权限。'
        : response.status === 429 ? '请求过于频繁或额度不足，请稍后手动重试。'
        : response.status === 404 ? '请检查 API 前缀、接口协议与模型名称。'
        : '请检查模型服务后手动重试。';
      throw new Error(`模型服务请求失败（HTTP ${response.status}）。${hint}`);
    }
    if (streamError) throw new ModelOutputError(streamError, tokens);
    if (!data) throw new ModelOutputError('模型服务返回的不是有效 JSON 对象，请检查服务地址与接口协议。', { inputTokens: 0, outputTokens: 0 }, [{ path: '$', message: '服务响应必须是 JSON 对象；原始响应可供人工检查。' }]);
    try {
      if (responseToolCalls(config.protocol, data).length) {
        // Tool-only responses are complete turns, not empty novels. Validate the
        // provider's completion before executing any request from the model.
        const check = structuredClone(data);
        if (config.protocol === 'openai-chat') { check.choices[0].finish_reason = check.choices[0].finish_reason === 'tool_calls' ? 'stop' : check.choices[0].finish_reason; check.choices[0].message.content ||= '工具调用'; }
        else if (config.protocol === 'openai-responses') check.output.push({ type: 'message', content: [{ type: 'output_text', text: '工具调用' }] });
        else if (config.protocol === 'gemini') check.candidates[0].content.parts.push({ text: '工具调用' });
        else { check.stop_reason = check.stop_reason === 'tool_use' ? 'end_turn' : check.stop_reason; check.content.push({ type: 'text', text: '工具调用' }); }
        parseResult(config.protocol, check);
        const text = redactPayload(responseText(config.protocol, data), config.apiKey);
        // A compatible gateway may also answer a tool turn with ordinary JSON;
        // keep any visible prose available before the continuation can fail.
        if (text && request.onTextDelta && !response.headers.get('content-type')?.includes('text/event-stream') && !/^\s*(?::|event:|data:)/.test(received.raw)) request.onTextDelta(text);
        return { data, result: { text, ...responseUsage(config.protocol, data) } };
      }
      const result = parseResult(config.protocol, data);
      // Some compatible gateways answer a streaming request with ordinary JSON.
      if (request.onTextDelta && !response.headers.get('content-type')?.includes('text/event-stream') && !/^\s*(?::|event:|data:)/.test(received.raw)) request.onTextDelta(redactPayload(result.text, config.apiKey));
      return { data, result: { ...result, text: redactPayload(responseText(config.protocol, data), config.apiKey) } };
    }
    catch (error) {
      const message = error instanceof TypeError ? '模型响应结构不完整，请检查模型和接口协议是否匹配。' : (error as Error).message;
      throw new ModelOutputError(message, responseUsage(config.protocol, data));
    }
  } catch (error) {
    if (!captured) capture();
    const transportFailure = (message: string) => capturedTokens.inputTokens || capturedTokens.outputTokens ? new ModelOutputError(message, capturedTokens) : new Error(message);
    if (request.signal?.aborted) throw transportFailure('模型请求已取消。');
    if (timedOut) throw transportFailure(`模型请求超时（${snapshot.timeoutMs / 1000} 秒），请缩小生成范围或检查服务后重试。`);
    // Network/JSON diagnostics deliberately never include response bodies, URLs or keys.
    if (error instanceof TypeError) throw new Error('读取模型响应失败，请检查网络连接后手动重试。');
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
  }
}

function responseToolCalls(protocol: ProviderConfig['protocol'], data: JsonObject): ModelToolCall[] {
  if (protocol === 'openai-chat') return objects(data.choices?.[0]?.message?.tool_calls).map(call => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments }));
  if (protocol === 'openai-responses') return objects(data.output).filter(item => item.type === 'function_call').map(call => ({ id: call.call_id, name: call.name, arguments: call.arguments }));
  if (protocol === 'gemini') return objects(data.candidates?.[0]?.content?.parts).filter(part => object(part.functionCall)).map((part, index) => ({ id: part.functionCall.id ?? `call_${index}`, name: part.functionCall.name, arguments: part.functionCall.args }));
  return objects(data.content).filter(part => part.type === 'tool_use').map(call => ({ id: call.id, name: call.name, arguments: call.input }));
}

const estimateTokens = (text: string) => Math.ceil([...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 127 ? 1.3 : 0.3), 0));

/** Same first-round estimate as the tool loop, including tool declarations and protocol framing. */
export function estimateModelRequestInputTokens(config: ProviderConfig, request: ModelRequest): number {
  return estimateTokens(JSON.stringify(continuationWire(config, request).body));
}

function continuationWire(config: ProviderConfig, request: ModelRequest): ReturnType<typeof requestBody> {
  const state = request.continuation;
  if (state && (state.protocol !== config.protocol || state.model !== config.model)) throw new Error('等待选择的模型协议或型号已改变，请恢复原模型设置后继续。');
  const wire = requestBody(config, request);
  if (state) {
    if (!object(state.body) || typeof state.text !== 'string' || !Number.isSafeInteger(state.round) || state.round < 1 || state.round > 24 || !Number.isSafeInteger(state.callCount) || state.callCount < 0 || state.callCount > 96 || ![state.inputTokens, state.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('保存的模型续接记录不完整，无法继续本次选择。');
    if (state.pending && (!object(state.pending.data) || !Array.isArray(state.pending.calls) || !Array.isArray(state.pending.results) || !Number.isSafeInteger(state.pending.nextIndex) || state.pending.nextIndex < 0 || state.pending.nextIndex > state.pending.calls.length || state.pending.results.length !== state.pending.nextIndex)) throw new Error('保存的工具续接记录不完整，无法继续本次选择。');
    wire.body = structuredClone(state.body) as typeof wire.body;
  }
  return wire;
}

/** Redact whole normalized events, including credential fields inside tool objects and thought JSON. */
function activityEmitter(config: ProviderConfig, request: ModelRequest, round: number): (event: ModelActivityEvent) => void {
  const thoughts = new Map<string, { raw: string; published: string }>();
  const keys = config.apiKey ? [config.apiKey] : [];
  const variants = [...new Set(keys.flatMap(key => [key, key.trim(), JSON.stringify(key).slice(1, -1), encodeURIComponent(key)]).filter(Boolean))];
  const deliver = (event: ModelActivityEvent) => { if (request.onActivity) request.onActivity(JSON.parse(redactModelPayload(JSON.stringify({ ...event, id: `round-${round + 1}:${event.id}` }), keys)) as ModelActivityEvent); };
  const flush = (id: string, finished = false) => {
    const thought = thoughts.get(id); if (!thought) return;
    const safe = JSON.parse(redactModelPayload(JSON.stringify({ type: 'thinking', id, text: thought.raw }), keys)).text as string;
    let end = safe.length;
    // Do not publish a credential prefix which the next reasoning delta could complete.
    if (!finished) for (const variant of variants) for (let length = Math.min(variant.length - 1, safe.length); length > 0; length--) if (safe.endsWith(variant.slice(0, length))) { end = Math.min(end, safe.length - length); break; }
    // An unfinished JSON thought may contain another JSON document in a string;
    // wait until recursive field redaction can inspect the complete document.
    if (!finished) { const jsonStart = safe.search(/[\[{]\s*"/); if (jsonStart >= 0) { try { JSON.parse(thought.raw.slice(jsonStart)); } catch { end = Math.min(end, jsonStart); } } }
    if (safe.startsWith(thought.published) && end > thought.published.length) {
      deliver({ type: 'thinking', id, text: safe.slice(thought.published.length, end) }); thought.published = safe.slice(0, end);
    }
  };
  return event => {
    if (!request.onActivity) return;
    if (event.type === 'thinking') { const thought = thoughts.get(event.id) ?? { raw: '', published: '' }; thought.raw += event.text; thoughts.set(event.id, thought); flush(event.id); }
    else if (event.type === 'thinking_done') { flush(event.id, true); deliver(event); thoughts.delete(event.id); }
    else deliver(event);
  };
}

/** Explicit tool continuations are new turns; failed billable requests are never retried. */
export async function generateText(config: ProviderConfig, request: ModelRequest): Promise<ModelResult> {
  const wire = continuationWire(config, request);
  const body = wire.body as JsonObject;
  const tools = request.tools ?? [];
  const maxRounds = Number.isSafeInteger(request.maxToolRounds) && request.maxToolRounds! > 0 ? Math.min(24, request.maxToolRounds!) : 6;
  const saved = request.continuation;
  const tokens = { inputTokens: saved?.inputTokens ?? 0, outputTokens: saved?.outputTokens ?? 0 };
  let text = saved?.text ?? '';
  let callCount = saved?.callCount ?? 0;
  let round = saved?.round ?? 0;
  let usageEstimated = saved?.usageEstimated ?? false;
  let pending = saved?.pending ? structuredClone(saved.pending) : undefined;
  const checkpoint = async () => {
    if (request.onContinuation) await request.onContinuation(structuredClone({ protocol: config.protocol, model: config.model, body, text, ...tokens, round, callCount, ...(usageEstimated ? { usageEstimated: true } : {}), ...(pending ? { pending } : {}) } satisfies ModelToolContinuation));
  };
  try {
    while (round < maxRounds || pending) {
      if (request.signal?.aborted) throw new Error('模型请求已取消。');
      if (!pending) {
        if (tools.length) {
          // Each request reserves its complete output allowance; historical usage
          // never reduces that allowance, including after a human decision.
          const inputEstimate = estimateTokens(JSON.stringify(body));
          const reserved = config.protocol === 'gemini' ? body.generationConfig.maxOutputTokens : config.protocol === 'openai-responses' ? body.max_output_tokens : body.max_completion_tokens ?? body.max_tokens;
          if (inputEstimate + reserved > config.contextTokens) throw new Error(`写作上下文预计需要 ${inputEstimate} 个输入 token，加上 ${reserved} 个输出 token，超过 ${config.contextTokens} 的上下文上限；请减少检索内容、提高上下文上限或确认压缩剧情摘要。`);
        }
        const emitActivity = activityEmitter(config, request, round);
        const { data, result } = await sendModelRequest(config, { ...request, onActivity: request.onActivity ? emitActivity : undefined }, wire);
        const inputTokens = request.onContinuation && !result.inputTokens ? estimateTokens(JSON.stringify(body)) : result.inputTokens;
        const outputTokens = request.onContinuation && !result.outputTokens ? estimateTokens(JSON.stringify(data)) : result.outputTokens;
        if (request.onContinuation && (!result.inputTokens || !result.outputTokens)) usageEstimated = true;
        tokens.inputTokens += inputTokens; tokens.outputTokens += outputTokens;
        text += result.text;
        round++;
        const calls = responseToolCalls(config.protocol, data);
        if (!calls.length) return { text: text.trim(), ...tokens, ...(usageEstimated ? { usageEstimated: true } : {}) };
        callCount += calls.length;
        if (round === maxRounds || callCount > maxRounds * 4) throw new Error('模型检索次数超过上限，请缩小本次写作范围后手动重试。');
        pending = { data, calls, results: [], nextIndex: 0 };
        // Persist the full response, signatures and billed usage before any tool
        // can pause or change the story. Completed tools are saved separately.
        await checkpoint();
      }
      const emitActivity = activityEmitter(config, request, round - 1);
      const { calls, results } = pending;
      const data = pending.data as JsonObject;
      for (let index = pending.nextIndex; index < calls.length; index++) {
        if (request.signal?.aborted) throw new Error('模型请求已取消。');
        const call = calls[index];
        const tool = tools.find(value => value.name === call.name);
        if (!tool || typeof call.name !== 'string' || typeof call.id !== 'string' || !call.id) throw new Error('模型请求了未提供的资料检索工具。');
        let args: unknown;
        try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; }
        catch { throw new Error('模型返回的工具参数不是有效 JSON。'); }
        if (!object(args)) throw new Error('资料检索工具参数必须是 JSON 对象。');
        const activityId = `tool:${index}:${call.id}`;
        emitActivity({ type: 'tool_call', id: activityId, name: call.name, arguments: args });
        let output: string;
        try {
          output = JSON.stringify(await tool.execute(args)) ?? 'null';
          if (request.signal?.aborted) throw new Error('模型请求已取消。');
        } catch (error) {
          if (!(error instanceof ModelInteractionPause)) emitActivity({ type: 'tool_result', id: activityId, name: call.name, error: error instanceof Error ? error.message : '资料检索失败。' });
          throw error;
        }
        results.push({ call, output }); pending.nextIndex = index + 1;
        await checkpoint();
        const result: unknown = JSON.parse(output);
        const error = object(result) && typeof result.error === 'string' && result.error.trim() ? result.error : undefined;
        emitActivity({ type: 'tool_result', id: activityId, name: call.name, result, ...(error ? { error } : {}) });
      }
      if (config.protocol === 'openai-chat') {
        body.messages.push({ role: 'assistant', ...data.choices[0].message });
        body.messages.push(...results.map(({ call, output }) => ({ role: 'tool', tool_call_id: call.id, content: output })));
      } else if (config.protocol === 'openai-responses') {
        if (typeof body.input === 'string') body.input = [{ role: 'user', content: body.input }];
        body.input.push(...objects(data.output).filter(item => item.type !== 'message' || objects(item.content).some(part => typeof part.text === 'string' && part.text)));
        body.input.push(...results.map(({ call, output }) => ({ type: 'function_call_output', call_id: call.id, output })));
      } else if (config.protocol === 'gemini') {
        const candidate = data.candidates[0];
        body.contents.push({ role: 'model', parts: candidate.historyParts ?? candidate.content.parts });
        body.contents.push({ role: 'user', parts: results.map(({ call, output }) => ({ functionResponse: { name: call.name, ...(call.id.startsWith('call_') ? {} : { id: call.id }), response: { result: JSON.parse(output) } } })) });
      } else {
        body.messages.push({ role: 'assistant', content: data.content });
        body.messages.push({ role: 'user', content: results.map(({ call, output }) => ({ type: 'tool_result', tool_use_id: call.id, content: output })) });
      }
      pending = undefined;
      await checkpoint();
    }
    throw new Error('模型未在资料检索后完成正文。');
  } catch (error) {
    if (error instanceof ModelInteractionPause) {
      error.inputTokens = tokens.inputTokens; error.outputTokens = tokens.outputTokens;
      if (usageEstimated) error.usageEstimated = true;
      throw error;
    }
    const current = error instanceof ModelOutputError ? error : undefined;
    if (tokens.inputTokens || tokens.outputTokens) throw new ModelOutputError((error as Error).message, { inputTokens: tokens.inputTokens + (current?.inputTokens ?? 0), outputTokens: tokens.outputTokens + (current?.outputTokens ?? 0) }, current?.issues);
    throw error;
  }
}

const stripFence = (text: string) => text.replace(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i, '$1').trim();
const noUsage = { inputTokens: 0, outputTokens: 0 };

/** Remove only a trailing separator after an existing value, never inside strings. */
function withoutTrailingCommas(text: string): string {
  const removals: number[] = [];
  let inString = false; let previous = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (character === '\\') index++;
      else if (character === '"') { inString = false; previous = '"'; }
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (/\s/.test(character)) continue;
    if (character === ',' && /["}\]0-9el]/.test(previous)) {
      let next = index + 1; while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === '}' || text[next] === ']') removals.push(index);
    }
    previous = character;
  }
  if (!removals.length) return text;
  const parts: string[] = []; let start = 0;
  for (const index of removals) { parts.push(text.slice(start, index)); start = index + 1; }
  parts.push(text.slice(start)); return parts.join('');
}

function jsonCandidate(text: string): string {
  const raw = text.replace(/^\uFEFF/, '').trim();
  const repaired = withoutTrailingCommas(raw);
  try { JSON.parse(repaired); return repaired; } catch { /* A complete single document may be inside a code fence. */ }
  const simpleFence = stripFence(raw);
  if (simpleFence !== raw) {
    const simpleRepaired = withoutTrailingCommas(simpleFence);
    try { JSON.parse(simpleRepaired); return simpleRepaired; } catch { /* Continue to ambiguity checks below. */ }
  }
  // Only explicit, complete JSON code fences may have surrounding commentary.
  // Never grab text greedily between the first '{' and final '}'.
  const fences = [...raw.matchAll(/^[\t ]*```([^\r\n`]*)\r?\n([\s\S]*?)^[\t ]*```[\t ]*(?=\r?$)/gm)];
  const fenceMarkers = [...raw.matchAll(/^[\t ]*```[^\r\n]*$/gm)];
  const reject = (detail: string): never => { throw new ModelOutputError('资料整理结果包含不明确的 JSON 内容，请保留唯一一份完整结果后重新验证。', noUsage, [{ path: '$', message: detail }]); };
  if (fences.length > 1 || fenceMarkers.length > 2) reject('发现多个代码块，不能确定哪一份是最终结果。');
  if (!fences.length) return raw;
  const fence = fences[0];
  if (!['', 'json'].includes(fence[1].trim().toLowerCase())) reject('代码块必须标记为 json 或不标记语言。');
  const prefix = raw.slice(0, fence.index).trim();
  const suffix = raw.slice(fence.index! + fence[0].length).trim();
  if (prefix.length + suffix.length > 512) reject('代码块之外的说明超过 512 字符，请只保留 JSON 结果。');
  if (/[{}\[\]`]/.test(prefix + suffix)) reject('代码块之外还有对象、数组或代码标记，无法唯一确定最终结果。');
  return withoutTrailingCommas(fence[2].trim());
}

function envelopeProtocol(value: JsonObject): ProviderConfig['protocol'] | undefined {
  if (Array.isArray(value.candidates) && (value.candidates.length === 0 || value.candidates.some((candidate: unknown) => object(candidate) && ('content' in candidate || 'finishReason' in candidate)))) return 'gemini';
  if (Array.isArray(value.choices) && (value.choices.length === 0 || value.choices.some((choice: unknown) => object(choice) && ('message' in choice || 'finish_reason' in choice)))) return 'openai-chat';
  if (Array.isArray(value.output) && (value.object === 'response' || 'status' in value || value.output.some((item: unknown) => object(item) && ['message', 'reasoning'].includes(item.type)))) return 'openai-responses';
  if (Array.isArray(value.content) && (value.type === 'message' || 'stop_reason' in value)) return 'claude';
  if (object(value.promptFeedback) && value.promptFeedback.blockReason) return 'gemini';
  if (value.object === 'response') return 'openai-responses';
  if (value.type === 'error' && object(value.error)) return 'claude';
  if (object(value.error) && typeof value.error.message === 'string' && ('code' in value.error || 'type' in value.error || 'status' in value.error)) return 'openai-responses';
  return undefined;
}

/** Accept provider envelopes pasted by a user; ordinary prose is left unchanged. */
export function unwrapModelOutput(text: string): string {
  let current = text;
  for (let depth = 0; depth < 4; depth++) {
    let parsed: unknown;
    try { parsed = JSON.parse(jsonCandidate(current)); } catch { return current; }
    if (!object(parsed)) return current;
    const protocol = envelopeProtocol(parsed);
    if (!protocol) return current;
    const inner = responseText(protocol, parsed);
    if (!inner.trim()) throw new ModelOutputError('粘贴的模型响应没有可用正文，请粘贴包含文本输出的响应或直接填写正文。', noUsage, [{ path: '$', message: '识别到了模型服务响应，但其中没有文本输出。' }]);
    current = inner;
  }
  throw new ModelOutputError('粘贴内容嵌套了过多层模型响应，请直接填写模型输出的正文。', noUsage, [{ path: '$', message: '模型响应嵌套超过四层。' }]);
}

/** Shared by automatic extraction and human-edited/pasted provider responses. */
export function parseStructuredText<T>(text: string, validate: (value: unknown) => T): T {
  const raw = jsonCandidate(unwrapModelOutput(jsonCandidate(text)));
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) {
    const match = error instanceof Error ? error.message.match(/position (\d+)/i) : undefined;
    const position = match ? Number(match[1]) : undefined;
    const line = position === undefined ? undefined : raw.slice(0, position).split('\n').length;
    const detail = position === undefined ? 'JSON 语法不完整或含有无效字符，请检查引号、逗号及括号。' : `JSON 在第 ${line} 行附近存在语法错误（字符位置 ${position}），请检查引号、逗号及括号。`;
    throw new ModelOutputError('资料整理结果不是有效 JSON，请检查原始输出并修正。', noUsage, [{ path: '$', message: detail }]);
  }
  if (!object(value)) throw new ModelOutputError('资料整理结果的顶层必须是 JSON 对象。', noUsage, [{ path: '$', message: `顶层应为对象，实际为${value === null ? ' null' : Array.isArray(value) ? '数组' : typeof value === 'string' ? '字符串' : typeof value === 'number' ? '数字' : '布尔值'}。` }]);
  try { return validate(value); }
  catch (error) {
    if (error instanceof ModelOutputError) throw error;
    const issues = error instanceof ZodError ? error.issues.slice(0, 100).map(issue => ({ path: issue.path.length ? issue.path.map(String).join('.').slice(0, 300) : '$', message: redactPayload(issue.message).slice(0, 500) })) : [{ path: '$', message: '内容未通过格式、引用或关联检查，请检查标记字段及原文依据。' }];
    throw new ModelOutputError('资料整理结果未通过格式、引用或关联检查，请修正后重新验证。', noUsage, issues);
  }
}

const STRUCTURED_OUTPUT_INSTRUCTION = '本次返回必须是符合要求的单个 JSON 对象。不要输出解释文字或 Markdown。';

/** Normalize before budgeting; repeated normalization never duplicates the output constraint. */
export function structuredRequest(request: ModelRequest): ModelRequest {
  if (request.messages?.length) {
    if (request.messages.some(message => message.role === 'system' && message.content.includes(STRUCTURED_OUTPUT_INSTRUCTION))) return request;
    return { ...request, messages: [...request.messages, { role: 'system', content: STRUCTURED_OUTPUT_INSTRUCTION }] };
  }
  return request.system.includes(STRUCTURED_OUTPUT_INSTRUCTION) ? request : { ...request, system: `${request.system}\n\n${STRUCTURED_OUTPUT_INSTRUCTION}` };
}

export async function generateStructured<T>(config: ProviderConfig, request: ModelRequest, validate: (value: unknown) => T): Promise<{ value: T; inputTokens: number; outputTokens: number }> {
  const result = await generateText(config, structuredRequest(request));
  try { return { value: parseStructuredText(result.text, validate), inputTokens: result.inputTokens, outputTokens: result.outputTokens }; }
  catch (error) {
    if (error instanceof ModelOutputError) throw new ModelOutputError(redactPayload(error.message, config.apiKey), result, error.issues?.map(issue => ({ ...issue, path: redactPayload(issue.path, config.apiKey), message: redactPayload(issue.message, config.apiKey), ...(issue.quote !== undefined ? { quote: redactPayload(issue.quote, config.apiKey) } : {}), ...(issue.sourceText !== undefined ? { sourceText: redactPayload(issue.sourceText, config.apiKey) } : {}) })));
    throw new ModelOutputError('资料整理结果未通过格式、引用或关联检查，请修正后重新验证。', result);
  }
}
