import type { WritingActivity } from '../shared/types';

export function proseParagraphs(text: string) {
  let offset = 0;
  return text.split(/\r\n|\r|\n/).flatMap((line, index) => {
    const start = offset + line.length - line.trimStart().length;
    offset += line.length + (text.slice(offset + line.length, offset + line.length + 2) === '\r\n' ? 2 : 1);
    return line.trim() ? [{ text: line.trim(), start, end: start + line.trim().length, index }] : [];
  }).map((paragraph, index) => ({ ...paragraph, index }));
}

export type WritingTimelinePart = { kind: 'text'; start: number; end: number } | { kind: 'activities'; start: number; legacy?: boolean; activities: WritingActivity[] };

export function proseFragments(text: string, start: number, end: number, paragraphs = proseParagraphs(text)) {
  return paragraphs.flatMap(paragraph => {
    const from = Math.max(paragraph.start, start); const to = Math.min(paragraph.end, end);
    return to > from ? [{ text: text.slice(from, to), start: from, end: to, index: paragraph.index, continued: from > paragraph.start, interrupted: to < paragraph.end }] : [];
  });
}

/** Every range refers to the unchanged source string, including CRLF and UTF-16 offsets. */
export function writingTimeline(text: string, activities: WritingActivity[]): WritingTimelinePart[] {
  const groups = new Map<number, WritingActivity[]>(); const legacy: WritingActivity[] = [];
  for (const activity of activities) {
    if (!Number.isSafeInteger(activity.proseOffset) || activity.proseOffset! < 0) { legacy.push(activity); continue; }
    let at = Math.min(activity.proseOffset!, text.length);
    // A malformed/old cursor must never turn an emoji into two lone surrogate characters.
    if (at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at])) at--;
    groups.set(at, [...(groups.get(at) || []), activity]);
  }
  const parts: WritingTimelinePart[] = legacy.length ? [{ kind: 'activities', start: 0, legacy: true, activities: legacy }] : [];
  let start = 0;
  for (const [at, group] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    if (at > start) parts.push({ kind: 'text', start, end: at });
    parts.push({ kind: 'activities', start: at, activities: group }); start = at;
  }
  if (start < text.length || !text) parts.push({ kind: 'text', start, end: text.length });
  return parts;
}
