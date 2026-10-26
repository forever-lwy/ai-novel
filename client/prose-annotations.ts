import type { Entity, StoryImage } from '../shared/types';
import { proseParagraphs } from './writing-timeline';

export interface ProseEntityMention { start: number; end: number; entityId: string }
export interface ProseEntityFragment { text: string; start: number; end: number; entityId?: string }
interface NameNode { children: Map<string, NameNode>; entityId?: string | null }
const wordCharacter = (value: string | undefined) => !!value && /[A-Za-z0-9_]/.test(value);

/** Match unchanged source text once, preferring complete longer names and rejecting ambiguous names. */
export function proseEntityMentions(text: string, entities: readonly Entity[]): ProseEntityMention[] {
  const owners = new Map<string, Set<string>>();
  for (const entity of entities) {
    if (entity.mergedInto) continue;
    for (const name of [entity.name, ...entity.aliases]) {
      const term = name.trim(); if (!term) continue;
      const ids = owners.get(term) ?? new Set<string>(); ids.add(entity.id); owners.set(term, ids);
    }
  }
  if (!owners.size) return [];
  const root: NameNode = { children: new Map() };
  for (const [term, ids] of owners) {
    let node = root;
    for (let index = 0; index < term.length; index++) {
      let child = node.children.get(term[index]);
      if (!child) { child = { children: new Map() }; node.children.set(term[index], child); }
      node = child;
    }
    node.entityId = ids.size === 1 ? ids.values().next().value : null;
  }
  const matches: ProseEntityMention[] = [];
  for (let start = 0; start < text.length;) {
    let node = root; let longest: { end: number; entityId: string | null } | undefined;
    for (let at = start; at < text.length; at++) {
      const child = node.children.get(text[at]); if (!child) break;
      node = child;
      if (node.entityId !== undefined && !(wordCharacter(text[start]) && wordCharacter(text[start - 1])) && !(wordCharacter(text[at]) && wordCharacter(text[at + 1]))) longest = { end: at + 1, entityId: node.entityId };
    }
    if (longest) {
      if (longest.entityId !== null) matches.push({ start, end: longest.end, entityId: longest.entityId });
      start = longest.end;
    } else start++;
  }
  return matches;
}

/** A process anchor may split a name; both visible pieces retain their original source coordinates. */
export function proseEntityFragments(text: string, start: number, end: number, mentions: readonly ProseEntityMention[]): ProseEntityFragment[] {
  let left = 0; let right = mentions.length;
  while (left < right) { const middle = (left + right) >>> 1; if (mentions[middle].end <= start) left = middle + 1; else right = middle; }
  const parts: ProseEntityFragment[] = []; let cursor = start;
  for (let index = left; index < mentions.length && mentions[index].start < end; index++) {
    const mention = mentions[index]; const from = Math.max(start, mention.start); const to = Math.min(end, mention.end);
    if (from > cursor) parts.push({ text: text.slice(cursor, from), start: cursor, end: from });
    if (to > from) parts.push({ text: text.slice(from, to), start: from, end: to, entityId: mention.entityId });
    cursor = to;
  }
  if (cursor < end) parts.push({ text: text.slice(cursor, end), start: cursor, end });
  return parts;
}

/** Images without a scene range belong at chapter end; ranged scenes belong at their last paragraph. */
export function proseCGParagraphs(text: string, images: readonly StoryImage[], paragraphs = proseParagraphs(text)): Map<number, StoryImage[]> {
  const result = new Map<number, StoryImage[]>(); const seen = new Set<string>();
  if (!paragraphs.length) return result;
  for (const image of images) {
    if (seen.has(image.id) || image.kind !== 'cg' || image.status !== 'completed' || image.active === false || !image.url || image.bindingStatus === 'pending' || image.bindingStatus === 'discarded') continue;
    const selection = image.selection; let index = paragraphs.length - 1;
    if (selection) {
      if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) || selection.start < 0 || selection.end <= selection.start || selection.end > text.length || !text.slice(selection.start, selection.end).trim()) continue;
      let left = 0; let right = paragraphs.length;
      while (left < right) { const middle = (left + right) >>> 1; if (paragraphs[middle].start < selection.end) left = middle + 1; else right = middle; }
      index = left - 1; if (index < 0) continue;
    }
    seen.add(image.id); result.set(index, [...(result.get(index) ?? []), image]);
  }
  return result;
}
