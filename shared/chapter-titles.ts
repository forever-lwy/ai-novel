import type { CapturedModelResponse } from './types.js';

export const MAX_TITLE_REPAIR_CHAPTERS = 20;
export interface ChapterTitleSample {
  chapterId: string; title: string; beginning: string; ending: string;
  previous?: { title: string; ending: string }; next?: { title: string; beginning: string };
  sourceContext?: string;
}
export interface ChapterTitleSuggestion {
  chapterId: string; originalTitle: string; title: string; reason: string; evidence: string;
  confidence: 'high' | 'medium' | 'low'; multipleChapters: boolean;
}
export interface ChapterTitlePreview {
  ok: boolean; suggestions?: ChapterTitleSuggestion[]; error?: string;
  inputTokens?: number; outputTokens?: number; capture?: CapturedModelResponse;
}
/** Only short prose excerpts are sent, including the author's unsaved import edits. */
export function chapterTitleSample(chapter: { chapterId: string; title: string; text: string }, previous?: { title: string; text: string }, next?: { title: string; text: string }): ChapterTitleSample {
  return { chapterId: chapter.chapterId, title: chapter.title, beginning: chapter.text.slice(0, 4000), ending: chapter.text.length > 4000 ? chapter.text.slice(-1500) : '',
    ...(previous ? { previous: { title: previous.title, ending: previous.text.slice(-600) } } : {}),
    ...(next ? { next: { title: next.title, beginning: next.text.slice(0, 600) } } : {}) };
}
