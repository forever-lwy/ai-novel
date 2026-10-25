/** Human-readable prompt values. Keep authored text intact; only render structure. */
const fieldNames: Record<string, string> = {
  continuationAnchor: '续写起点', worldview: '世界设定', locked: '作者锁定', worldRules: '世界规则',
  mainCharacters: '主要人物', mainCharacterRelations: '主要人物关系', unrevealedForeshadows: '尚未揭晓的伏笔',
  authorConfirmedSummary: '作者确认的压缩摘要', completePlotSummaries: '已保存章节摘要', recentCompleteChapters: '最近章节全文',
  originalReference: '固定原作参考', reference: '参考来源', entityDirectory: '原作资料目录',
  entityDirectoryTotal: '资料总数', entityDirectoryTruncated: '目录是否还有未列出资料', foreshadows: '伏笔',
  id: '标识', name: '名称', title: '标题', kind: '类型', aliases: '别名', aliasesTruncated: '是否还有未列出别名',
  description: '说明', visibility: '可见范围', isMain: '是否主要人物', nameStatus: '姓名确认状态', facts: '事实记录',
  text: '内容', attribute: '属性', temporal: '时间属性', certainty: '确定程度', citation: '原文依据',
  chapterId: '章节标识', chapterIds: '章节标识列表', paragraph: '原文段号', quote: '原文引文', summary: '摘要',
  fromId: '起点资料标识', toId: '终点资料标识', label: '关系', status: '状态', detail: '详情',
  revealCondition: '揭晓条件', plantedChapterId: '埋设章节标识', resolvedChapterId: '回收章节标识',
  relatedEntityIds: '相关资料标识', relatedNames: '相关名称', projectId: '作品标识', branchId: '故事线标识',
  revisionId: '版本标识', baseRevisionId: '起始版本标识', sourceId: '原文件标识', sourceIds: '原文件标识列表',
  chapterCount: '章节数量', sourceChapterId: '来源章节标识', capturedAt: '捕获时间', ending: '已保存正文结尾',
  entityId: '资料标识', entities: '资料条目', chapters: '章节', paragraphs: '原文段落', index: '索引',
  material: '目标素材', storyContext: '故事上下文', instruction: '本次要求', characters: '人物资料',
  references: '参考图', referenceEntityIds: '参考人物标识', referenceImageIds: '参考图片标识',
  referenceSelection: '参考图选择方式', imageId: '图片标识', imageInput: '绘图输入',
  stylePrompt: '画风', promptInstruction: '绘图要求', prompt: '绘图提示词', parameters: '绘图参数',
  fixedParameters: '固定绘图参数', allowed: '可用参数范围', size: '尺寸', sizes: '可用尺寸',
  aspectRatio: '画幅比例', aspectRatios: '可用画幅比例', imageSize: '分辨率', imageSizes: '可用分辨率',
  width: '宽度', height: '高度', maxCharacterReferences: '人物参考图上限', sourceText: '目标原文',
  config: '绘图配置', protocol: '协议', model: '模型', referenceInstruction: '参考图说明',
  dimensionMode: '画布参数形式', customSize: '是否支持自定义尺寸', dimensionMultiple: '宽高整倍数',
  minDimension: '最小宽高', maxDimension: '最大宽高', minPixels: '最少总像素', maxPixels: '最多总像素', maxAspectRatio: '最大长宽比',
};

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const label = (key: string) => fieldNames[key] ?? key;
const scalar = (value: unknown) => value === null ? 'null' : value === undefined ? '' : String(value);

/** Unlike JSON serialization, multiline strings remain ordinary unescaped text. */
export function formatPromptMaterial(value: unknown): string {
  const render = (item: unknown, depth: number): string => {
    const indent = '  '.repeat(depth);
    if (Array.isArray(item)) {
      if (!item.length) return `${indent}（无）`;
      return item.map((entry, index) => {
        if (object(entry) || Array.isArray(entry)) return `${indent}条目 ${index + 1}\n${render(entry, depth + 1)}`;
        const text = scalar(entry);
        return /[\r\n]/.test(text) ? `${indent}-\n${text}` : `${indent}- ${text}`;
      }).join('\n\n');
    }
    if (object(item)) {
      const entries = Object.entries(item).filter(([, field]) => field !== undefined);
      if (!entries.length) return `${indent}（无）`;
      return entries.map(([key, field]) => {
        if (object(field) || Array.isArray(field)) return `${indent}${label(key)}：\n${render(field, depth + 1)}`;
        const text = scalar(field);
        return /[\r\n]/.test(text) ? `${indent}${label(key)}：\n${text}` : `${indent}${label(key)}：${text}`;
      }).join('\n');
    }
    return scalar(item);
  };
  return render(value, 0);
}

export function formatWritingMaterials(materials: Record<string, unknown>): string {
  return Object.entries(materials).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `## ${key === 'locked' ? '作者约束' : label(key)}\n\n${formatPromptMaterial(value)}`).join('\n\n');
}

export const EXTRACTION_INDEX_PREFIXES = {
  entities: '名称对照（仅用于统一称呼，不是新增事实的证据）：',
  foreshadows: '尚未揭晓的伏笔索引（不可据此推断答案）：',
} as const;

export function formatExtractionIndex(entities: unknown, foreshadows: unknown): string {
  return `## 名称对照\n仅用于统一称呼，不是新增事实的证据。\n\n${formatPromptMaterial(entities)}\n\n## 尚未揭晓的伏笔索引\n不可据此推断答案。\n\n${formatPromptMaterial(foreshadows)}`;
}

const structuredValue = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === 'null') return null;
  if (typeof value !== 'string' || !/^[\s]*[\[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
};

export function formatRecentChapters(value: unknown): string {
  const chapters = structuredValue(value);
  if (!Array.isArray(chapters)) return formatPromptMaterial(chapters);
  if (!chapters.length) return '尚无已保存章节。';
  return chapters.map(chapter => {
    if (!object(chapter) || typeof chapter.text !== 'string') return formatPromptMaterial(chapter);
    const { chapterId, title, text, ...extra } = chapter;
    const metadata = formatPromptMaterial({ ...(chapterId !== undefined ? { chapterId } : {}), ...(title !== undefined && typeof title !== 'string' ? { title } : {}), ...extra });
    return `## ${typeof title === 'string' ? title : '未命名章节'}\n\n${metadata}\n\n${text}`;
  }).join('\n\n');
}

export function formatContinuationAnchor(value: unknown): string {
  const anchor = structuredValue(value);
  if (anchor === null || anchor === undefined) return '尚无已保存正文，从作者设定开始。';
  if (!object(anchor) || typeof anchor.ending !== 'string') return formatPromptMaterial(anchor);
  const { chapterId, title, ending, instruction, ...extra } = anchor;
  const metadata = formatPromptMaterial({ ...(chapterId !== undefined ? { chapterId } : {}), ...(title !== undefined && typeof title !== 'string' ? { title } : {}), ...extra,
    ...(instruction !== undefined && instruction !== '从这段已保存正文的结尾之后继续，不按章节编号寻找起点或重写旧情节。' ? { instruction } : {}),
  });
  return `最新章节：${typeof title === 'string' ? title : '未命名章节'}\n${metadata}\n\n已保存正文结尾：\n${ending}`;
}
