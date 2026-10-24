import type { ChapterRef } from './types.js';

/** Manual edits retain immutable prose IDs as provenance, without changing other branches. */
export function includesChapterVersion(chapter: ChapterRef, chapterId: string | undefined): boolean {
  return !!chapterId && (chapter.id === chapterId || !!chapter.previousChapterIds?.includes(chapterId));
}
