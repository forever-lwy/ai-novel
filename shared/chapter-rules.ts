import type { CapturedModelResponse, SourcePreview } from './types.js';

export interface ChapterRuleInput { name: string; pattern: string; flags: string; description: string }
export interface ChapterRule extends ChapterRuleInput { id: string; builtIn?: boolean }
export interface HeadingCandidate { line: number; title: string }
export interface HeadingCandidates { candidates: HeadingCandidate[]; nextOffset: number | null }
export interface ChapterRulePreview extends SourcePreview { headingCount?: number }
export interface GeneratedChapterRule {
  ok: boolean; rule?: ChapterRuleInput; error?: string; headingCount?: number; chapterCount?: number;
  examples?: string[]; inputTokens?: number; outputTokens?: number; capture?: CapturedModelResponse;
}

// Patterns describe one trimmed line. The importer supplies full-line anchors.
const number = '[零〇一二三四五六七八九十百千万亿两0-9０-９]{1,24}';
const chinese = `第[ \\t　]*${number}[ \\t　]*[章回节集篇][^\\n]{0,100}`;
const volume = `第[ \\t　]*${number}[ \\t　]*[卷部][^\\n]{0,100}`;
const english = '(?:chapter|book|part)\\s+(?:[0-9]+|[ivxlcdm]+)(?:[\\s.:：—-][^\\n]{0,100})?';
const special = '(?:序章|序言|楔子|引子|前言|尾声|后记|终章|番外)(?:[\\s：:、—-][^\\n]{0,100})?';
const numbered = `(?:[0-9０-９]{1,6}[.．、:：)）]|[（(]${number}[)）]|[一二三四五六七八九十百千]{1,12}[、．.])[ \\t　]*[^\\n]{1,100}`;
const bracketed = `[【\\[](?:${chinese}|${volume}|${english}|${special})[】\\]][^\\n]{0,60}`;
const markdown = '#{1,6}[ \\t]+[^\\n#][^\\n]{0,100}';

export const builtInChapterRules: readonly ChapterRule[] = [
  { id: 'auto', name: '综合识别（推荐）', pattern: `(?:${chinese}|${volume}|${english}|${special}|${numbered}|${bracketed}|${markdown})`, description: '兼容常见中文、英文、编号、括号和 Markdown 标题。' },
  { id: 'chinese', name: '中文章回', pattern: `(?:${chinese}|${special})`, description: '第一章、第 2 章、第三回，以及序章、番外等。' },
  { id: 'volume', name: '按卷／部分章', pattern: `(?:${volume}|${special})`, description: '第一卷、第二部；卷内章节保留在正文中。' },
  { id: 'english', name: '英文 Chapter／Book／Part', pattern: english, description: 'Chapter 1、Chapter IV、Book 2、Part III。' },
  { id: 'numbered', name: '数字／中文编号', pattern: numbered, description: '1. 标题、２、标题、（一）标题、一、标题。正文中的列表也可能匹配，需核对预览。' },
  { id: 'bracketed', name: '括号章节标题', pattern: bracketed, description: '【第一章 入城】、[Chapter 2]、【番外】。' },
  { id: 'markdown', name: 'Markdown 标题', pattern: markdown, description: '# 入城、## 第二章 夜谈；各级标题都会分章。' },
  { id: 'special', name: '序章／番外等独立标题', pattern: special, description: '只按序章、楔子、尾声、番外等分章。' },
  { id: 'none', name: '不自动分章', pattern: '\\b\\B', description: '全文作为一章，可再手动分章。' },
].map(rule => ({ ...rule, flags: 'i', builtIn: true }));

export const MAX_HEADING_LENGTH = 160;
export const MAX_CHAPTER_HEADINGS = 10_000;
