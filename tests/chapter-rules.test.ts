import { describe, expect, it } from 'vitest';
import { builtInChapterRules } from '../shared/chapter-rules.js';
import { splitText } from '../server/importer.js';
import { matchChapterHeadings } from '../server/chapter-rule-matcher.js';

describe('chapter heading presets and text preservation', () => {
  it.each([
    ['chinese', '第 一 章 入城', '第 ２ 章 夜谈'],
    ['volume', '第一卷 初见', '第 2 部 远行'],
    ['english', 'Chapter IV: Arrival', 'PART 5 - Dawn'],
    ['numbered', '1. 入城', '２、夜谈'],
    ['numbered', '（一）入城', '二、夜谈'],
    ['bracketed', '【第一章 入城】', '[Chapter 2] Dawn'],
    ['markdown', '# 入城', '## 夜谈'],
    ['special', '楔子', '番外：重逢'],
  ])('%s recognizes complete standalone headings', (id, first, second) => {
    expect(splitText(`${first}\r\n第一段。\r\n\r\n第二段。\r\n${second}\r\n故事继续。`, id)).toEqual([
      { title: first, text: '第一段。\n\n第二段。' }, { title: second, text: '故事继续。' },
    ]);
  });
  it('combined recognition handles mixed formats and fullwidth/space-separated Chinese numbers', () => {
    const headings = ['第 1 章 入城', '【第二章 夜谈】', '3. 远行', '# 归来', 'Chapter V: Epilogue'];
    const chapters = splitText(headings.map(title => `${title}\n独立正文。`).join('\n\n'));
    expect(chapters.map(ch => ch.title)).toEqual(headings);
  });
  it('only uses the selected preset, preserves preambles and never deletes unmatched lines', () => {
    const text = '前言内容。\n第一卷 初见\n第一章 入城\n故事。\n第二章 夜谈\n继续。';
    const volumes = splitText(text, 'volume');
    expect(volumes).toEqual([{ title: '序章', text: '前言内容。' }, { title: '第一卷 初见', text: '第一章 入城\n故事。\n第二章 夜谈\n继续。' }]);
    expect(splitText(text, 'none')).toEqual([{ title: '正文', text }]);
  });
  it('preserves consecutive volume/chapter headings and empty trailing headings without blank chapters', () => {
    expect(splitText('第一卷 初见\n第一章 入城\n正文。\n第二章 夜谈\n尾声')).toEqual([
      { title: '第一章 入城', text: '第一卷 初见\n\n正文。\n\n第二章 夜谈\n\n尾声' },
    ]);
    expect(() => splitText('第一章\n第二章')).toThrow('只有标题');
  });
  it('rejects excessive chapters, including introductory prose in the count', () => {
    expect(() => splitText('前言。\n' + Array.from({ length: 10000 }, (_, i) => `第${i + 1}章\n正文。`).join('\n'))).toThrow('10000');
  });
  it('uses whole-line boundaries for custom patterns and ignores overly long lines', async () => {
    const headings = await matchChapterHeadings('正文提到场景01｜入城但不是标题。\n场景01｜入城\n' + 'x'.repeat(161), { pattern: '场景[0-9]+｜.+', flags: '' });
    expect(headings.map(value => value.title)).toEqual(['场景01｜入城']);
  });
  it('terminates catastrophic regexes without blocking the main event loop', async () => {
    const matcher = matchChapterHeadings('a'.repeat(140) + '!', { pattern: '(a+)+', flags: '' }, { timeoutMs: 250 });
    let timerRan = false;
    await new Promise(resolve => setTimeout(() => { timerRan = true; resolve(undefined); }, 30));
    expect(timerRan).toBe(true);
    await expect(matcher).rejects.toThrow('超时');
    await expect(matchChapterHeadings('标题', { pattern: '.+', flags: '' })).resolves.toHaveLength(1);
  });
  it('rejects patterns that match empty lines and respects cancellation', async () => {
    await expect(matchChapterHeadings('标题', { pattern: '.*', flags: '' })).rejects.toThrow('空行');
    const controller = new AbortController(); controller.abort();
    await expect(matchChapterHeadings('标题', { pattern: '.+', flags: '' }, { signal: controller.signal })).rejects.toThrow('取消');
    expect(builtInChapterRules.every(rule => rule.builtIn && rule.id && rule.name)).toBe(true);
  });
});
