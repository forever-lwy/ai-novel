type Json = Record<string, any>;
type Call = { key: string; part: Json; streaming: boolean; open: boolean; strings: Set<string> };
const object = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('Gemini 工具参数分片结构无效，已保留收到的内容。');

/** Only property/index paths are writable; never evaluate JSONPath expressions. */
export function geminiArgumentPathKeys(path: unknown): (string | number)[] {
  if (typeof path !== 'string' || path[0] !== '$' || path.length > 2048) throw invalid();
  const keys: (string | number)[] = [];
  const step = /\.([^.[\]\s'"*?]+)|\[(0|[1-9]\d*|"(?:[^"\\]|\\.)*"|'[^'\\]*')\]/y;
  let offset = 1;
  while (offset < path.length) {
    step.lastIndex = offset;
    const match = step.exec(path);
    if (!match) throw invalid();
    const token = match[2];
    const key: string | number = match[1] ?? (token.startsWith('"') ? JSON.parse(token) : token.startsWith("'") ? token.slice(1, -1) : Number(token));
    if (typeof key === 'number' ? key > 10000 : ['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid();
    keys.push(key); offset = step.lastIndex;
    if (keys.length > 32) throw invalid();
  }
  if (!keys.length) throw invalid();
  return keys;
}

function property(root: Json, keys: (string | number)[]): { owner: Json; key: string | number } {
  let owner = root;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (Array.isArray(owner) !== (typeof key === 'number')) throw invalid();
    if (index === keys.length - 1) return { owner, key };
    if (!Object.hasOwn(owner, key)) owner[key] = typeof keys[index + 1] === 'number' ? [] : {};
    const next = owner[key];
    if (!object(next) && !Array.isArray(next)) throw invalid();
    owner = next;
  }
  throw invalid();
}

/** Assemble one function call before execution, while exposing current args for prose previews.
 * Signed part metadata is retained on the assembled part; the raw SSE capture stays unchanged.
 */
export class GeminiFunctionStream {
  private calls: Call[] = [];
  private ids = new Map<string, Call>();
  error?: string;
  get incomplete(): boolean { return this.calls.some(call => call.open || call.strings.size > 0); }

  add(part: Json): { key: string; part: Json; fresh: boolean } | undefined {
    if (!object(part.functionCall)) return;
    const input = part.functionCall;
    let call: Call | undefined;
    let fresh = false;
    try {
      const name = input.name;
      const id = input.id;
      if (name !== undefined && (typeof name !== 'string' || !name) || id !== undefined && (typeof id !== 'string' || !id)) throw invalid();
      call = id ? this.ids.get(id) : undefined;
      if (!call) {
        const pending = this.calls.filter(value => value.open && (!id || !value.part.functionCall.id) && (!name || value.part.functionCall.name === name));
        if (pending.length > 1) throw invalid();
        call = pending[0];
      }
      if (!call) {
        if (!name) throw invalid();
        call = { key: String(this.calls.length), part: { ...part, functionCall: { ...input } }, streaming: false, open: false, strings: new Set() };
        this.calls.push(call); fresh = true;
      } else {
        if (name && call.part.functionCall.name !== name) throw invalid();
        for (const [key, value] of Object.entries(part)) if (key !== 'functionCall') {
          if (key === 'thoughtSignature' && call.part[key] !== undefined && call.part[key] !== value) throw invalid();
          call.part[key] = value;
        }
      }
      if (id) { call.part.functionCall.id = id; this.ids.set(id, call); }
      const incremental = input.partialArgs !== undefined || input.willContinue !== undefined || call.streaming;
      if (!incremental) return { key: call.key, part: call.part, fresh };
      call.streaming = true;
      if (input.willContinue !== undefined && typeof input.willContinue !== 'boolean') throw invalid();
      if (input.args !== undefined) {
        if (!object(input.args)) throw invalid();
        call.part.functionCall.args = structuredClone(input.args);
        call.strings.clear();
      } else call.part.functionCall.args ??= {};
      // Metadata belongs to the stream, not to the completed call sent back in history.
      delete call.part.functionCall.partialArgs;
      delete call.part.functionCall.willContinue;
      if (input.partialArgs !== undefined) {
        if (!Array.isArray(input.partialArgs)) throw invalid();
        for (const arg of input.partialArgs) {
          if (!object(arg) || arg.willContinue !== undefined && typeof arg.willContinue !== 'boolean') throw invalid();
          const keys = geminiArgumentPathKeys(arg.jsonPath);
          const path = JSON.stringify(keys);
          const fields = ['stringValue', 'numberValue', 'boolValue', 'nullValue'].filter(key => Object.hasOwn(arg, key));
          if (fields.length > 1 || !fields.length && (!call.strings.has(path) || arg.willContinue === true)) throw invalid();
          const { owner, key } = property(call.part.functionCall.args, keys);
          const field = fields[0];
          if (field) {
            const value = arg[field];
            if (field === 'stringValue' ? typeof value !== 'string' : field === 'numberValue' ? typeof value !== 'number' || !Number.isFinite(value) : field === 'boolValue' ? typeof value !== 'boolean' : value !== 'NULL_VALUE') throw invalid();
            if (call.strings.has(path)) {
              if (field !== 'stringValue' || typeof owner[key] !== 'string') throw invalid();
              owner[key] += value;
            } else {
              const next = field === 'nullValue' ? null : value;
              if (Object.hasOwn(owner, key) && owner[key] !== next) throw invalid();
              owner[key] = next;
            }
          }
          if (arg.willContinue === true) {
            if (field !== 'stringValue') throw invalid();
            call.strings.add(path);
          } else call.strings.delete(path);
        }
      }
      call.open = input.willContinue === true;
    } catch { this.error ??= invalid().message; }
    return call ? { key: call.key, part: call.part, fresh } : undefined;
  }
}
