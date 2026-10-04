import type { OutputStage } from '../shared/types';

export type OutputObject = Record<string, unknown>;
export type FormPath = (string | number)[];
export const isObject = (value: unknown): value is OutputObject => value !== null && typeof value === 'object' && !Array.isArray(value);
export const displayValue = (value: unknown): string => value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
export const pathKey = (path: FormPath) => path.join('.');
export const parseIssuePath = (path: string): FormPath => path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).map(part => /^\d+$/.test(part) ? Number(part) : part);
export const fieldId = (path: FormPath) => `output-field-${path.map(String).join('-') || 'root'}`;

function stripFence(text: string) { return text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/, '').trim(); }
function textParts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(isObject).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('\n');
}

/** Preview only: editing never changes the preserved raw response. The server still validates on apply. */
export function unwrapVisualText(text: string): { text: string; unwrapped: boolean } {
  let current = text; let unwrapped = false;
  for (let depth = 0; depth < 4; depth++) {
    let parsed: unknown;
    try { parsed = JSON.parse(stripFence(current)); } catch { return { text: current, unwrapped }; }
    if (!isObject(parsed)) return { text: current, unwrapped };
    let inner: string | undefined;
    if (Array.isArray(parsed.choices) && (parsed.choices.length === 0 || parsed.choices.some(item => isObject(item) && ('message' in item || 'finish_reason' in item)))) {
      const first = parsed.choices[0]; inner = isObject(first) && isObject(first.message) ? textParts(first.message.content) : '';
    } else if (Array.isArray(parsed.candidates) && (parsed.candidates.length === 0 || parsed.candidates.some(item => isObject(item) && ('content' in item || 'finishReason' in item)))) {
      const first = parsed.candidates[0]; inner = isObject(first) && isObject(first.content) ? textParts(first.content.parts) : '';
    } else if (parsed.object === 'response' || (Array.isArray(parsed.output) && ('status' in parsed || parsed.output.some(item => isObject(item) && item.type === 'message')))) {
      inner = typeof parsed.output_text === 'string' ? parsed.output_text : Array.isArray(parsed.output) ? parsed.output.filter(isObject).map(item => textParts(item.content)).filter(Boolean).join('\n') : '';
    } else if (Array.isArray(parsed.content) && (parsed.type === 'message' || 'stop_reason' in parsed)) inner = textParts(parsed.content);
    else if ((parsed.type === 'error' && isObject(parsed.error)) || (isObject(parsed.error) && typeof parsed.error.message === 'string' && ('code' in parsed.error || 'type' in parsed.error || 'status' in parsed.error)) || (isObject(parsed.promptFeedback) && parsed.promptFeedback.blockReason)) inner = '';
    if (inner === undefined) return { text: current, unwrapped };
    if (!inner.trim()) throw new Error('这份服务响应中没有可编辑的模型正文。请检查原始响应，或粘贴包含完整正文的另一份输出。');
    current = inner; unwrapped = true;
  }
  throw new Error('这份响应嵌套过多，暂时无法转成表单。请在高级 JSON 中保留最里面的模型正文，或重新粘贴输出。');
}

export function parseVisualOutput(text: string, stage: OutputStage, compression = false): { ok: true; value: OutputObject; unwrapped: boolean } | { ok: false; message: string } {
  try {
    const unwrapped = unwrapVisualText(text);
    const parsed: unknown = JSON.parse(stripFence(unwrapped.text));
    if (!isObject(parsed)) return { ok: false, message: '当前内容不是一份完整的资料对象，暂时不能显示为表单。请切到高级 JSON 检查内容，或粘贴另一份完整输出。' };
    const expected = compression ? ['text'] : stage === 'extraction' ? ['summary', 'entities', 'relations', 'foreshadows'] : ['fine', 'foreshadows'];
    if (Object.keys(parsed).length && !expected.some(key => key in parsed)) return { ok: false, message: `当前内容缺少${compression ? '压缩摘要 text' : stage === 'extraction' ? '摘要、资料、关系或伏笔' : '预期规划或伏笔'}这些字段，无法安全显示为表单。请在高级 JSON 中检查是否粘贴了正确的模型输出。` };
    return { ok: true, value: parsed, unwrapped: unwrapped.unwrapped };
  } catch (e) {
    if (e instanceof SyntaxError) return { ok: false, message: 'JSON 的引号、逗号或括号不完整，暂时无法显示成表单。请切到“高级 JSON”修复格式，或粘贴完整输出；你的内容仍然保留。' };
    return { ok: false, message: (e as Error).message };
  }
}

export function valueAt(root: OutputObject, path: FormPath): unknown {
  let value: unknown = root;
  for (const key of path) {
    if (!isObject(value) && !Array.isArray(value)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

/** Change only the requested path; keep unknown properties and unrelated records intact. */
export function replaceAt(root: OutputObject, path: FormPath, value: unknown): OutputObject {
  const copy = structuredClone(root);
  let target: Record<string | number, unknown> = copy;
  path.forEach((key, index) => {
    if (index === path.length - 1) { if (value === undefined) delete target[key]; else target[key] = value; return; }
    if (!isObject(target[key]) && !Array.isArray(target[key])) target[key] = typeof path[index + 1] === 'number' ? [] : {};
    target = target[key] as Record<string | number, unknown>;
  });
  return copy;
}

const fieldNames: Record<string, string> = {
  summary: '本段摘要', entities: '资料', name: '名称', kind: '资料类型', aliases: '别名', description: '资料描述', facts: '事实', text: '事实内容', attribute: '状态类别', temporal: '发生时间', certainty: '可信程度', visibility: '可见范围', paragraph: '原文段落', quote: '引用原文', relations: '关系', from: '关系起点', to: '关系终点', label: '关系说明', foreshadows: '伏笔', title: '标题', detail: '隐藏内容', status: '处理状态', dueChapter: '计划揭晓章节', revealCondition: '揭晓条件', relatedNames: '关联资料名称', fine: '章节预期规划', chapter: '章节序号', goal: '本章安排',
};
export function humanIssuePath(path: string): string {
  const parts = parseIssuePath(path); if (!parts.length) return '输出内容';
  return parts.map(part => typeof part === 'number' ? `第 ${part + 1} 项` : fieldNames[part] || part).join(' › ');
}
