import { dramatronSource } from './dramatron-source.js';
import type { PromptBlock, PromptFeature } from './types.js';

/** The helper script is not executed. Its prompt modules and switch semantics
 * are ported as request data; source macros are resolved before compilation.
 */
function sourceBlock(id: string, sourceId: string, feature?: PromptFeature, enabled = true): PromptBlock {
  const source = dramatronSource[sourceId];
  const content = resolveSource(source.content);
  return { id, name: source.name, role: source.role, content, enabled, ...(feature ? { feature } : {}) };
}
function resolveSource(content: string): string {
  return content.replace(/\{\{setvar::[^{}]*\}\}/g, '').replace(/\{\{getvar::[^{}]*\}\}/g, '').replace(/\{\{([^{}]+)\}\}/g, '（$1）');
}
export function dramatronGeneralBlocks(): PromptBlock[] {
  return [
    sourceBlock('snow', 'a443f257-0f5d-4286-a1ff-f60653ed6400', 'snow'),
    sourceBlock('clear', 'main'),
  ];
}
export function dramatronTailBlocks(): PromptBlock[] {
  return [
    { id: 'cot-three', name: '📽️三段输出结构', role: 'system', feature: 'cot-three', enabled: true, tasks: ['writing'], content: THREE_PART_OUTPUT },
    { id: 'cot-single', name: '📽️单段输出结构', role: 'system', feature: 'cot-single', enabled: false, tasks: ['writing'], content: SINGLE_PART_OUTPUT },
    sourceBlock('defense-laoda', '558c204b-25ad-4284-9d03-369b00ac9ad4', 'defense-laoda', false),
    sourceBlock('defense-normal', '095b5c1f-cf5f-48e8-a6aa-e25c882ea754', 'defense-normal', false),
    { ...sourceBlock('continue', 'jailbreak'), tasks: ['writing'] },
  ];
}
const THREE_PART_OUTPUT = `<Interleaved_thinking>
将输出分为三部分，每部分都推进当前任务，按相同结构交替输出辅助核对与任务内容。保持各部分衔接，不重复已交付内容。
<Interleaving>
<thinking>按当前任务提示词核对本部分输入与输出要求。</thinking>
（第一部分任务输出）
<thinking>按当前任务提示词核对下一部分输入与输出要求。</thinking>
（第二部分任务输出）
<thinking>按当前任务提示词核对剩余输入与交付完整性。</thinking>
（第三部分任务输出）
</Interleaving>
（启用的辅助尾段）
<thinking_format>按当前任务提示词核对输入、约束与交付完整性，不添加任务提示词未要求的内容。</thinking_format>
</Interleaved_thinking>`;
const SINGLE_PART_OUTPUT = `<thinking_format>
<Interleaving>
<thinking>按当前任务提示词核对输入、输出要求和交付完整性。</thinking>
（当前任务输出）
</Interleaving>
（启用的辅助尾段）
</thinking_format>
NOTE: 思考内容由 <thinking> </thinking> 包裹，任务内容不放在思考标签中。`;
