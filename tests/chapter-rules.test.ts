import { describe, expect, it } from 'vitest';
import { builtInChapterRules } from '../shared/chapter-rules.js';
import { splitText, splitTextByLength } from '../server/importer.js';
import { countProseWords } from '../shared/rpg-chapter.js';
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

describe('splitting novels without headings by character count', () => {
  it('provides a 3000-character preset and keeps every character of long unbroken text', () => {
    const text = '没有标题的长篇小说。'.repeat(100_000);
    const chapters = splitText(text, 'length');
    expect(chapters).toHaveLength(Math.ceil(text.length / 3000));
    expect(chapters[0].title).toBe('第1章');
    expect(chapters.at(-1)?.title).toBe(`第${chapters.length}章`);
    expect(chapters.map(chapter => chapter.text).join('')).toBe(text);
    expect(chapters.every(chapter => countProseWords(chapter.text) > 0 && countProseWords(chapter.text) <= 3000)).toBe(true);
  });
  it('prefers paragraph endings near the target and normalizes BOM/Windows newlines', () => {
    const parts = ['甲'.repeat(85), '乙'.repeat(85), '丙'.repeat(40)];
    expect(splitTextByLength('\uFEFF  ' + parts.join('\r\n\r\n') + '  ', 100)).toEqual(parts.map((text, i) => ({ title: `第${i + 1}章`, text })));
    expect(splitTextByLength('甲'.repeat(100) + '\n\n' + '乙'.repeat(20), 100).map(chapter => chapter.text)).toEqual(['甲'.repeat(100), '乙'.repeat(20)]);
  });
  it('counts punctuation, Latin letters and supplementary Unicode characters once, without whitespace', () => {
    const text = '🙂𠮷甲。 A\t\n'.repeat(70);
    const chapters = splitTextByLength(text, 100);
    expect(chapters.map(chapter => chapter.text).join('').replace(/\s/gu, '')).toBe(text.replace(/\s/gu, ''));
    expect(chapters.every(chapter => countProseWords(chapter.text) <= 100)).toBe(true);
    expect(chapters.every(chapter => !/\p{Surrogate}/u.test(chapter.text))).toBe(true);
    expect(chapters.map(chapter => countProseWords(chapter.text))).toEqual([100, 100, 100, 50]);
  });
  it('keeps a short final chapter intact, preserves title-like lines as body and creates no blank chapters', () => {
    const text = '第一章\n' + '甲'.repeat(85) + '\n\n' + '乙'.repeat(10);
    expect(splitTextByLength(text, 100)).toEqual([{ title: '第1章', text }]);
    expect(splitTextByLength('甲'.repeat(100) + '\n'.repeat(500) + '乙', 100)).toEqual([{ title: '第1章', text: '甲'.repeat(100) }, { title: '第2章', text: '乙' }]);
    expect(() => splitTextByLength(' \r\n\t ')).toThrow('没有可读取');
  });
  it.each([0, 99, 100001, 100.5, NaN, Infinity])('rejects an invalid per-chapter count %s', words => {
    expect(() => splitTextByLength('正文', words)).toThrow('整数');
  });
  it('allows 10000 chapters and rejects overflow instead of dropping the remainder', () => {
    expect(splitTextByLength('甲'.repeat(1_000_000), 100)).toHaveLength(10000);
    expect(() => splitTextByLength('甲'.repeat(1_000_001), 100)).toThrow('增大每章字数');
  });
});
