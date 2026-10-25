import { describe, expect, it } from 'vitest';
import { formatContinuationAnchor, formatPromptMaterial, formatRecentChapters } from '../shared/prompt-materials.js';

describe('readable prompt material structure', () => {
  it('renders objects and arrays as fields without escaping authored multiline text', () => {
    const authored = '第一行。\n\n第二行保留 {作者原有括号}、"引号" 与 {{不展开变量}}。';
    const material = { name: '甲', aliases: ['旧名', '长别名'], facts: [{ id: 'fact-1', text: '已确认事实', citation: { chapterId: 'chapter-1', paragraph: 69, quote: authored }, locked: true }], optional: null };
    const before = structuredClone(material); const text = formatPromptMaterial(material);
    expect(text).toContain('名称：甲'); expect(text).toContain('- 旧名'); expect(text).toContain('- 长别名');
    expect(text).toContain('事实记录：'); expect(text).toContain('标识：fact-1'); expect(text).toContain('章节标识：chapter-1'); expect(text).toContain('原文段号：69');
    expect(text).toContain(authored); expect(text).not.toContain('\\n'); expect(text).not.toContain('\\"');
    expect(text).toContain('作者锁定：true'); expect(text).toContain('optional：null'); expect(material).toEqual(before);
  });

  it('keeps unknown fields, primitive values and empty collections instead of JSON fallback', () => {
    expect(formatPromptMaterial({ customMetadata: { customField: ['原值', 0, false] }, none: [], omitted: undefined }))
      .toBe('customMetadata：\n  customField：\n    - 原值\n\n    - 0\n\n    - false\nnone：\n  （无）');
    expect(formatPromptMaterial('原样\r\n正文')).toBe('原样\r\n正文'); expect(formatPromptMaterial(0)).toBe('0'); expect(formatPromptMaterial(null)).toBe('null');
  });

  it('accepts legacy serialized chapter values and leaves plain preview text intact', () => {
    const prose = '第一段。\n\n第二段含 {作者括号}。';
    const chapters = [{ chapterId: 'c1', title: '旧门', text: prose, customMetadata: '保留的额外字段' }];
    expect(formatRecentChapters(JSON.stringify(chapters))).toBe(formatRecentChapters(chapters));
    expect(formatRecentChapters(chapters)).toContain(prose); expect(formatRecentChapters(chapters)).toContain('customMetadata：保留的额外字段');
    expect(formatRecentChapters('直接写在预览中的前文')).toBe('直接写在预览中的前文');
    const anchor = { chapterId: 'c1', title: '旧门', ending: prose, instruction: '作者自己的承接要求' };
    expect(formatContinuationAnchor(JSON.stringify(anchor))).toBe(formatContinuationAnchor(anchor));
    expect(formatContinuationAnchor(anchor)).toContain('本次要求：作者自己的承接要求');
    expect(formatContinuationAnchor('预览中的上一段结尾')).toBe('预览中的上一段结尾');
    expect(formatContinuationAnchor(null)).toBe('尚无已保存正文，从作者设定开始。');
    expect(formatContinuationAnchor('null')).toBe(formatContinuationAnchor(null));
  });

  it('does not interpret literal markup, escapes or old output artifacts in source materials', () => {
    const source = '原文字符 \\n、<think>作者原文</think>、]]>🪒úm 和 {{素材变量}}。';
    expect(formatPromptMaterial({ quote: source })).toContain(source);
    expect(formatRecentChapters([{ chapterId: 'c1', title: '原文', text: source }])).toContain(source);
    expect(formatContinuationAnchor({ chapterId: 'c1', title: '原文', ending: source })).toContain(source);
  });
});
