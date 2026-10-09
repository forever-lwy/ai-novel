import type { ExtractionOutputMode, ModelStructuredOutput } from './types.js';

export const EXTRACTION_SUBMISSION_NAME = 'submit_extraction';
export const EXTRACTION_TOOL_INSTRUCTION = `# 资料提交方式
必须且只能调用一次 ${EXTRACTION_SUBMISSION_NAME}，将完整的 summary、entities、relations、foreshadows 填入工具参数。
预设中的 JSON 格式和示例均描述工具参数；不要把结果作为普通文本或 Markdown 返回，普通文本不能替代工具调用。
这个工具只接收提取结果，不查询资料、不执行外部操作，也不需要等待工具回复或继续生成。
引用只填当前片段的 paragraph，原文由程序补齐。无法确定的可空字段填 null，不要编造。`;

const string = { type: 'string' };
const array = (items: Record<string, unknown>) => ({ type: 'array', items });
const enumeration = (...values: string[]) => ({ type: 'string', enum: values });
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const visibility = enumeration('public', 'secret');
const paragraph = { type: 'integer', description: '当前输入片段中提供的原段落编号，必须为正整数。程序从该段取回精确引文，无需重抄。' };

/** Shared wire contract. All fields are required for OpenAI strict output; unknown optional values use null.
 * Keep semantic constraints in normalizeExtraction: provider schema subsets differ across protocols. */
export const extractionOutputSchema = object({
  summary: { ...string, description: '仅概括当前片段已发生的剧情，保留因果、转折与人物变化。' },
  entities: array(object({
    kind: enumeration('character', 'faction', 'location', 'item', 'ability', 'rule', 'event'),
    name: { ...string, description: '主名称；人物没有明确姓名时使用稳定的占位称呼。' },
    nameStatus: nullable(enumeration('placeholder', 'confirmed')),
    isMain: nullable({ type: 'boolean' }),
    aliases: array(string), description: string, visibility,
    facts: array(object({
      text: string,
      attribute: { ...nullable(string), description: '明确的资料属性，例如 location；无适用属性时填 null。' },
      temporal: enumeration('current', 'past', 'future', 'unknown'),
      certainty: enumeration('fact', 'inference', 'conflict'), visibility, paragraph,
    })),
  })),
  relations: array(object({ from: string, to: string, label: string, visibility, paragraph })),
  foreshadows: array(object({
    title: string, detail: string, status: enumeration('planned', 'planted', 'resolved', 'abandoned'),
    dueChapter: nullable({ type: 'integer', description: '有明确依据时填写正整数；未确定时填 null，不根据未来规划推断。' }),
    revealCondition: string, relatedNames: array(string),
  })),
});

export function extractionOutputFormat(mode: ExtractionOutputMode = 'prompt'): ModelStructuredOutput | undefined {
  if (mode === 'prompt') return undefined;
  return { mode: mode === 'tool' ? 'tool' : 'json_schema', name: EXTRACTION_SUBMISSION_NAME, description: '提交当前编号原文片段的剧情摘要、实体资料、关系和伏笔；所有事实必须有本片段证据。', schema: extractionOutputSchema };
}
