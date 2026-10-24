import type { ModelToolCall } from './types.js';

export const WRITING_RESPONSE_NAME = 'emit_writing_response';

// Reported in Gemini tool turns. Match only these complete sequences, never
// standalone CDATA closers, emoji or ordinary "Sides" text. Signed wire history
// stays untouched; this is used only for decoded output candidates.
const TOOL_OUTPUT_ARTIFACTS = ['Sides]]>🪒úm', ']]>🪒úm'];

/** A deployed Gemini response put a tool preamble and broken envelope in text.
 * Require both a declared tool reference and the malformed closing sequence;
 * never classify arbitrary English prose as thinking. Hold ambiguous streaming
 * suffixes until the complete shape can be checked, then release normal text.
 */
function cleanToolCallPreamble(text: string, final: boolean, toolNames: readonly string[]): string {
  if (!toolNames.length) return text;
  const prefixes = toolNames.flatMap(name => ["Let's call `", 'Let’s call `'].map(lead => `${lead}${name}\``));
  const quotes: Record<string, string> = { '"': '"', '“': '”', '「': '」', '『': '』' };
  let quote = ''; let escaped = false; let candidate = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (quote === '"' && char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (quotes[char]) { quote = quotes[char]; continue; }
    if (char !== 'L' || /[A-Za-z0-9_]/.test(text[index - 1] ?? '')) continue;
    const suffix = text.slice(index);
    if (prefixes.some(prefix => suffix.startsWith(prefix))) {
      if (!final) return text.slice(0, index);
      candidate = index;
    } else if (!final && prefixes.some(prefix => prefix.startsWith(suffix))) return text.slice(0, index);
  }
  return candidate >= 0 && /[）)]】(?:\s*}){2,}\s*$/.test(text) ? text.slice(0, candidate) : text;
}

export function cleanToolOutputArtifacts(text: string, final = true, toolNames: readonly string[] = []): string {
  text = cleanToolCallPreamble(text, final, toolNames);
  let output = ''; let start = 0; let quoted = false; let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    // JSON evidence and explicitly quoted literals must remain byte-for-byte
    // intact, including escaped quotes inside a result-tool string.
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char !== ']' && char !== 'S') continue;
    if (char === 'S' && index > start && /[A-Za-z]/.test(text[index - 1] ?? '')) continue;
    const artifact = TOOL_OUTPUT_ARTIFACTS.find(value => text.startsWith(value, index));
    if (artifact) {
      output += text.slice(start, index);
      index += artifact.length - 1; start = index + 1;
    } else if (!final && text.length - index < TOOL_OUTPUT_ARTIFACTS[0].length
      && TOOL_OUTPUT_ARTIFACTS.some(value => value.startsWith(text.slice(index)))) {
      // Hold only a possible marker suffix until another delta disambiguates it.
      return output + text.slice(start, index);
    }
  }
  return output + text.slice(start);
}

export const WRITING_TOOL_INSTRUCTION = `# 正文工具通道
每轮只调用一次 emit_writing_response，将本轮正文放入 prose，将需要实际执行的工具放入 toolCalls。
- prose 包含本轮新增输出，可以为空；启用三段或单段格式时，辅助标签也放入 prose，程序清理后保存正文。不要在普通文本通道写正文，工具参数、结果和玩家回答不写入 prose。
- toolCalls 按实际执行顺序填写 name 和 argumentsJson；argumentsJson 是该工具参数的完整 JSON 对象字符串，必须符合下方工具说明中的参数结构。
- 工具说明由程序提供。不得调用未提供的工具，不得自己填写工具返回或玩家回答。
- 查询、插画和 ask_user 均通过 toolCalls 提交。需要玩家决定时在此处停下，不提前写决定后的正文。
- 程序会在外层工具结果中返回各项真实结果。收到结果后继续下一轮；完成正文时 toolCalls 填 []，此轮直接结束，不再请求确认。
- 已收到的正文不会重复输出；工具返回、参数和调用记录不混入 prose。`;

export function writingResponseTool(tools: { name: string; description: string; parameters: Record<string, unknown> }[]) {
  return {
    name: WRITING_RESPONSE_NAME,
    description: '通过工具通道提交本轮新增正文和待执行工具。工具定义：\n' + JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        prose: { type: 'string', description: '本轮新增输出，允许通用预设规定的辅助标签，程序清理后保存正文。查询资料或等待玩家时可以为空。' },
        toolCalls: { type: 'array', maxItems: 4, items: {
          type: 'object', additionalProperties: false,
          properties: { name: { type: 'string', ...(tools.length ? { enum: tools.map(tool => tool.name) } : {}) }, argumentsJson: { type: 'string', description: '对应工具参数的 JSON 对象字符串。' } },
          required: ['name', 'argumentsJson'],
        } },
      }, required: ['prose', 'toolCalls'],
    },
  };
}

/** Recover only a top-level prose string, including a safely decoded partial one.
 * JSON in nested tool arguments must never become chapter text.
 */
export function partialWritingProse(raw: string, field = 'prose'): string {
  let depth = 0;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === '{' || char === '[') { depth++; continue; }
    if (char === '}' || char === ']') { depth--; continue; }
    if (char !== '"') continue;
    const start = index++;
    for (; index < raw.length; index++) { if (raw[index] === '\\') index++; else if (raw[index] === '"') break; }
    if (index >= raw.length) return '';
    if (depth !== 1) continue;
    let key: unknown;
    try { key = JSON.parse(raw.slice(start, index + 1)); } catch { return ''; }
    let cursor = index + 1;
    while (/\s/.test(raw[cursor] ?? '') && cursor < raw.length) cursor++;
    if (raw[cursor++] !== ':' || key !== field) continue;
    while (/\s/.test(raw[cursor] ?? '') && cursor < raw.length) cursor++;
    if (raw[cursor++] !== '"') return '';
    let text = '';
    for (; cursor < raw.length; cursor++) {
      const next = raw[cursor];
      if (next === '"') return text;
      if (next !== '\\') { if (next < ' ') return text; text += next; continue; }
      const escape = raw[++cursor];
      if (escape === 'u') {
        const hex = raw.slice(cursor + 1, cursor + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        text += String.fromCharCode(parseInt(hex, 16)); cursor += 4;
      } else if (escape && Object.hasOwn({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }, escape)) {
        text += ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escape];
      } else break;
    }
    // A high surrogate can be completed by the next stream fragment.
    return /[\ud800-\udbff]$/.test(text) ? text.slice(0, -1) : text;
  }
  return '';
}

export function unpackWritingResponse(nativeCalls: ModelToolCall[], allowedNames: string[], allowEmpty = false): { prose: string; calls: ModelToolCall[] } {
  if (nativeCalls.length !== 1 || nativeCalls[0].name !== WRITING_RESPONSE_NAME || typeof nativeCalls[0].id !== 'string' || !nativeCalls[0].id) throw new Error('正文工具通道必须提交一次 emit_writing_response；普通文本或其他外层工具不能替代。');
  const outer = nativeCalls[0];
  let value: unknown;
  try { value = typeof outer.arguments === 'string' ? JSON.parse(outer.arguments) : outer.arguments; }
  catch { throw new Error('正文工具通道的参数不是完整有效的 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('正文工具通道参数必须是对象。');
  const payload = value as Record<string, unknown>;
  if (typeof payload.prose !== 'string' || !Array.isArray(payload.toolCalls) || payload.toolCalls.length > 4 || Object.keys(payload).some(key => !['prose', 'toolCalls'].includes(key))) throw new Error('正文工具通道必须包含 prose 和 toolCalls，每轮最多四项工具调用。');
  const calls = payload.toolCalls.map((item: unknown, index: number): ModelToolCall => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('内层工具调用必须是对象。');
    const call = item as Record<string, unknown>;
    if (typeof call.name !== 'string' || !allowedNames.includes(call.name) || typeof call.argumentsJson !== 'string' || Object.keys(call).some(key => !['name', 'argumentsJson'].includes(key))) throw new Error('正文工具通道请求了未提供的工具或参数结构不正确。');
    let args: unknown;
    try { args = JSON.parse(call.argumentsJson); } catch { throw new Error('内层工具参数不是有效 JSON。'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('内层工具参数必须是 JSON 对象。');
    return { id: `${outer.id}:${index}`, name: call.name, arguments: args };
  });
  if (!allowEmpty && !payload.prose.trim() && !calls.length) throw new Error('正文工具通道没有返回正文或工具调用。');
  return { prose: payload.prose, calls };
}
