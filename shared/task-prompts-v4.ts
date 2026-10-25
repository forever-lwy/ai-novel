import type { PromptBlock, PromptPreset, PromptTask } from './types.js';
import { NEUTRAL_V2_PRESET_ID } from './neutral-preset-v2.js';

export const TASK_V4_PRESET_IDS: Record<PromptTask, string> = {
  writing: 'default-writing-v4', extraction: 'default-extraction-v4', compression: 'default-compression-v4', image: 'default-image-v4',
};
const block = (id: string, name: string, role: PromptBlock['role'], content: string): PromptBlock => ({ id, name, role, content, enabled: true });

/** New editions leave every saved earlier edition available and editable. */
export function taskPresetsV4(extractionRules: string, compressionRules: string): Record<PromptTask, PromptPreset> {
  return {
    writing: {
      id: TASK_V4_PRESET_IDS.writing, name: '正文写作 v4 · 清晰分区', generalPresetId: NEUTRAL_V2_PRESET_ID,
      blocks: [
        block('writing-v4-task', '写作职责', 'system', `# 当前任务：故事正文
在当前故事线上完成作者指定的写作范围。只交付本轮新增正文，不附章节编号、回顾摘要、资料整理、状态栏或任务说明。
以最新已保存正文的实际结尾为续写起点，不重复已经发生的情节；改写仅替换指定范围。缺少已有事实时先查询资料，不能凭印象改设定。
使用全部作者资料安排剧情，但角色只能依据其已知信息行动。RPG 中用户角色的自主行动、台词和选择由用户决定。`),
        block('writing-v4-materials', '故事资料与历史正文', 'user', `# 故事资料
{{storyMaterialsText}}

# 最近章节原文
以下按故事顺序排列，用于承接情节和文风。
{{recentChaptersText}}`),
        block('writing-v4-request', '本轮要求与续写起点', 'user', `# 本次写作
创作模式：{{mode}}
目标长度：约 {{maxWords}} 字

## 作者要求
{{instruction}}

## 写作范围
{{writingTarget}}

## 续写起点
{{continuationAnchorText}}`),
      ],
    },
    extraction: {
      id: TASK_V4_PRESET_IDS.extraction, name: '资料提取 v4 · 清晰分区', generalPresetId: NEUTRAL_V2_PRESET_ID,
      blocks: [
        block('extraction-v4-rules', '证据约束与结果格式', 'system', extractionRules),
        block('extraction-v4-input', '对照资料与本次片段', 'user', `# 名称与伏笔对照
以下只辅助身份归并，不能作为新增事实的证据。
{{extractionIndexText}}

# 本次提取任务
章节标题：{{chapterTitle}}

## 编号原文
{{blockText}}

## 提交要求
仅依据以上编号原文提取 summary、entities、relations、foreshadows，保留段号。返回完整合法的结果对象，不续写故事。`),
      ],
    },
    compression: {
      id: TASK_V4_PRESET_IDS.compression, name: '摘要压缩 v4 · 清晰分区', generalPresetId: NEUTRAL_V2_PRESET_ID,
      blocks: [
        block('compression-v4-rules', '压缩职责与结果格式', 'system', compressionRules),
        block('compression-v4-input', '待压缩剧情', 'user', `# 待压缩的已发生剧情
{{summaryText}}

# 本次要求
按原有时序保留关键事件、因果和状态变化，合并重复信息。只返回更短、非空的 text 摘要结果，不引入新剧情。`),
      ],
    },
    image: {
      id: TASK_V4_PRESET_IDS.image, name: '生图提示词 v4 · 清晰分区', generalPresetId: NEUTRAL_V2_PRESET_ID,
      blocks: [
        block('image-v4-task', '画面职责与结果格式', 'system', `# 当前任务：生图提示词
IMAGE_PROMPT_OPTIMIZATION 生图提示词优化。
根据本次画面素材、实际剧情和作者要求，编写可独立交给图片模型的完整提示词。明确主体、已知外观衣着、动作、人物相对位置、环境、镜头、光线、色彩和画风，不复述整份人物档案。
CG 只描绘目标瞬间，不合并多个时间点，不提前绘入后文情节。立绘突出已知人物特征；地图使用已确认的地理关系。修改图片时分别说明需要保留和改变的部分。
参考人物只选择本次候选中确有可用图片、且画面实际出场的人物，最多 {{maxCharacterReferences}} 名；返回其 entityId，不能编造ID。作者明确选择的参考图优先。
只有标为自动的参数可从允许值中选择，固定参数保持不变，不在结果中填写 auto。
返回结果对象，包含 prompt（完整画面提示词）、referenceEntityIds（参考人物ID数组）和 parameters（本次接口需要的具体参数对象）；parameters 可包含 size、aspectRatio、imageSize、width、height。`),
        block('image-v4-input', '画面素材和作者要求', 'user', `# 本次画面资料
{{imageInputText}}

# 作者对提示词的补充要求
{{imageSystemPrompt}}`),
      ],
    },
  };
}
