import type { PromptPreset } from './types.js';
import { neutralGeneralPresetV2 } from './neutral-preset-v2.js';

export const NEUTRAL_V3_PRESET_ID = 'general-neutral-v3';

/** Preserve the earlier edition; this version describes the task and delivery. */
export function neutralGeneralPresetV3(): PromptPreset {
  const preset = neutralGeneralPresetV2();
  return {
    ...preset,
    id: NEUTRAL_V3_PRESET_ID,
    name: '通用综合 v3 · 清晰分区',
    blocks: preset.blocks.map(block => ({
      ...block, id: block.id.replace('neutral-v2-', 'neutral-v3-'),
      ...(block.id === 'neutral-v2-delivery' ? { content: `# 交付
结果内容由当前任务规定，交付位置由本次实际接口说明规定。只提交本轮新增结果，完成后结束。
查询资料、请求插画或询问用户时使用本次提供的真实工具。资料不足或工具报错时按真实信息处理，不编造已完成的操作。` } : {}),
    })),
  };
}
