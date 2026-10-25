// Test-provider input readers. Production prompts remain ordinary readable text;
// these helpers only let deterministic loopback fixtures inspect either edition.
const labels = {
  kind: ['类型', 'kind'], material: ['目标素材', 'material'], storyContext: ['故事上下文', 'storyContext'],
  instruction: ['本次要求', 'instruction'], stylePrompt: ['画风', 'stylePrompt'], characters: ['人物资料', 'characters'],
  references: ['参考图', 'references'], referenceSelection: ['参考图选择方式', 'referenceSelection'],
  referenceInstruction: ['参考图说明', '作者参考图约束', '参考图约束', 'referenceInstruction'],
  config: ['绘图配置', '图片模型配置', '模型配置', 'config'], allowed: ['可用参数范围', 'allowed'],
};
const topLabels = Object.values(labels).flat();
const field = (text, names) => {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    const name = names.find(value => trimmed.startsWith(value + '：'));
    if (name) return trimmed.slice(name.length + 1).trim();
  }
};
const entries = text => text.split(/^\s{2}条目 \d+\r?$/m).slice(1).map(part => ({
  entityId: field(part, ['资料标识', 'entityId']), name: field(part, ['名称', 'name']),
  imageId: field(part, ['图片标识', 'imageId']), description: field(part, ['说明', 'description']),
  label: field(part, ['关系', 'label']),
}));

export function imageFixtureInput(prompt) {
  for (const candidate of [prompt.trim(), prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1)]) {
    try { const value = JSON.parse(candidate); if (value && typeof value === 'object' && !Array.isArray(value) && ('material' in value || 'config' in value)) return value; } catch { /* Read the new text edition below. */ }
  }
  const content = prompt.split(/^# 本次画面资料\r?$/m).at(-1).split(/^# 作者对提示词的补充要求\r?$/m)[0];
  const lines = content.split(/\r?\n/);
  const section = key => {
    const names = labels[key]; const start = lines.findIndex(line => names.some(name => line.startsWith(name + '：')));
    if (start < 0) return '';
    const name = names.find(value => lines[start].startsWith(value + '：'));
    let end = start + 1;
    while (end < lines.length && !topLabels.some(value => lines[end].startsWith(value + '：'))) end++;
    return [lines[start].slice(name.length + 1), ...lines.slice(start + 1, end)].join('\n').replace(/^\n/, '').trimEnd();
  };
  const configText = section('config'); const allowedText = section('allowed');
  const number = (text, names) => { const value = field(text, names); return value === undefined || value === '' ? undefined : Number(value); };
  return {
    kind: section('kind'), material: section('material'), storyContext: section('storyContext'),
    instruction: section('instruction'), stylePrompt: section('stylePrompt'),
    characters: entries(section('characters')), references: entries(section('references')),
    referenceSelection: section('referenceSelection') || undefined,
    referenceInstruction: section('referenceInstruction') || undefined,
    config: {
      protocol: field(configText, ['接口协议', '协议', 'protocol']), model: field(configText, ['图片模型', '模型', 'model']),
      size: field(configText, ['尺寸', 'size']), aspectRatio: field(configText, ['画幅比例', 'aspectRatio']),
      imageSize: field(configText, ['分辨率', 'imageSize']), width: number(configText, ['宽度', 'width']), height: number(configText, ['高度', 'height']),
    },
    allowed: { maxCharacterReferences: number(allowedText, ['人物参考图上限', 'maxCharacterReferences']) },
  };
}

export function extractionFixtureParagraphs(prompt) {
  const heading = /^#{1,3} (?:编号原文|当前片段)\r?$/m.exec(prompt);
  const source = (heading ? prompt.slice(heading.index + heading[0].length) : prompt).split(/^#{1,3} 提交要求\r?$/m)[0];
  return [...source.matchAll(/^\[(\d+)\]\s*(.+)$/gm)].map(match => ({ paragraph: Number(match[1]), quote: match[2].trimEnd() }));
}
