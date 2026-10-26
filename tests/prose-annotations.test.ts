import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { decodeHTML } from 'entities';
import type { Entity, StoryImage, WritingActivity } from '../shared/types.js';
import { WritingTimeline } from '../client/WritingTimeline.js';
import { proseCGParagraphs, proseEntityFragments, proseEntityMentions } from '../client/prose-annotations.js';
import { proseFragments, writingTimeline } from '../client/writing-timeline.js';

const entity = (id: string, name: string, aliases: string[] = [], extra: Partial<Entity> = {}): Entity => ({ id, kind: 'character', name, aliases, description: '', visibility: 'public', locked: false, facts: [], ...extra });
const image = (id: string, extra: Partial<StoryImage> = {}): StoryImage => ({ id, projectId: 'project', branchId: 'branch', baseRevisionId: 'revision', kind: 'cg', status: 'completed', title: id, prompt: '', automatic: false, visibility: 'public', active: true, url: `/images/${id}`, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z', ...extra });
const paragraphText = (html: string) => [...html.matchAll(/<p\b[^>]*data-prose-start="[^"]+"[^>]*>([\s\S]*?)<\/p>/g)].map(match => decodeHTML(match[1].replace(/<[^>]*>/g, '')));

describe('source-preserving prose entity links', () => {
  it('prefers complete longer names and aliases without changing the matched source text', () => {
    const text = '林舟和林见到小舟；白石城城门在前方。';
    const entities = [entity('short', '林'), entity('traveler', '林舟', ['小舟']), entity('city', '白石城'), entity('gate', '白石城城门')];
    const matches = proseEntityMentions(text, entities);
    expect(matches.map(match => [text.slice(match.start, match.end), match.entityId])).toEqual([['林舟', 'traveler'], ['林', 'short'], ['小舟', 'traveler'], ['白石城城门', 'gate']]);
    expect(proseEntityFragments(text, 0, text.length, matches).map(part => part.text).join('')).toBe(text);
  });

  it('does not guess an owner for shared names, including a shorter name inside an ambiguous longer name', () => {
    const text = '林舟和小舟、旅人出现。';
    const entities = [entity('short', '林'), entity('one', '林舟', ['小舟', '旅人']), entity('two', '小舟', ['林舟']), entity('merged', '旅人', [], { mergedInto: 'one' })];
    expect(proseEntityMentions(text, entities).map(match => [text.slice(match.start, match.end), match.entityId])).toEqual([['旅人', 'one']]);
    expect(proseEntityMentions('小舟', [entity('one', '小舟', ['小舟'])])).toEqual([{ start: 0, end: 2, entityId: 'one' }]);
  });

  it('matches English names at word boundaries and preserves literal punctuation and markup characters', () => {
    const text = 'Alice sees Malice and Alice2, then <Alice> greets ALICE. A+B waits.';
    const entities = [entity('alice', 'Alice'), entity('formula', 'A+B')];
    const matches = proseEntityMentions(text, entities);
    expect(matches.map(match => text.slice(match.start, match.end))).toEqual(['Alice', 'Alice', 'A+B']);
    expect(proseEntityFragments(text, 0, text.length, matches).map(part => part.text).join('')).toBe(text);
  });

  it('preserves UTF-16 offsets and text across process anchors, CRLF, emoji and partial-name fragments', () => {
    const text = '  😀林舟看见铜钥。  \r\n\r\n小舟捡起铜钥。\r\n';
    const mentions = proseEntityMentions(text, [entity('traveler', '林舟', ['小舟']), entity('key', '铜钥', [], { kind: 'item' })]);
    const activities: WritingActivity[] = [{ id: 'middle', kind: 'thinking', text: '过程', status: 'completed', proseOffset: text.indexOf('舟') }];
    const fragments = writingTimeline(text, activities).flatMap(part => part.kind === 'text' ? proseFragments(text, part.start, part.end) : []);
    const displayed = fragments.flatMap(fragment => proseEntityFragments(text, fragment.start, fragment.end, mentions));
    expect(displayed.filter(part => part.entityId === 'traveler').map(part => part.text)).toEqual(['林', '舟', '小舟']);
    for (const part of displayed) expect(text.slice(part.start, part.end)).toBe(part.text);
    expect(displayed.map(part => part.text).join('')).toBe('😀林舟看见铜钥。小舟捡起铜钥。');
    expect(mentions[0].start).toBe(4);
  });
});

describe('scene buttons at original paragraph endings', () => {
  it('anchors each selected scene to its final paragraph, and chapter-only CGs to the last paragraph', () => {
    const text = '😀第一段。\r\n\r\n第二段。\r\n\r\n第三段。\r\n';
    const selected = image('selected', { selection: { start: 0, end: text.indexOf('第三') } });
    const first = image('first', { selection: { start: 2, end: 5 } });
    const chapter = image('chapter');
    const result = proseCGParagraphs(text, [selected, first, chapter, first]);
    expect([...result.entries()].map(([index, images]) => [index, images.map(image => image.id)])).toEqual([[1, ['selected']], [0, ['first']], [2, ['chapter']]]);
    expect(proseCGParagraphs(' \r\n\r\n', [chapter]).size).toBe(0);
  });

  it('does not use disabled, missing, incomplete or invalid scene images as a replacement', () => {
    const text = '第一段。\n\n第二段。';
    const invalid = [image('disabled', { active: false }), image('failed', { status: 'failed' }), image('pending', { bindingStatus: 'pending' }), image('discarded', { bindingStatus: 'discarded' }), image('missing', { url: undefined }), image('portrait', { kind: 'portrait' }), image('out-of-range', { selection: { start: 0, end: 100 } }), image('backward', { selection: { start: 3, end: 1 } }), image('blank', { selection: { start: 4, end: 6 } })];
    expect(proseCGParagraphs(text, invalid).size).toBe(0);
  });

  it('renders scene controls once after the actual paragraph ending even when a process splits the name', () => {
    const text = '😀林舟走过城门。\r\n\r\n铜钥还在。';
    const scene = image('城门场景', { selection: { start: 0, end: text.indexOf('铜钥') } });
    const activities: WritingActivity[] = [{ id: 'middle', kind: 'thinking', text: 'PRIVATE_PROCESS', status: 'completed', proseOffset: text.indexOf('舟') }];
    const html = renderToStaticMarkup(createElement(WritingTimeline, { text, activities, status: 'completed', entities: [entity('traveler', '林舟'), entity('key', '铜钥', [], { kind: 'item' })], images: [scene], highlight: 1, onClearHighlight: () => {}, onOpenEntity: () => {}, onOpenCG: () => {} }));
    expect(paragraphText(html)).toEqual(['😀林', '舟走过城门。', '铜钥还在。']);
    expect(html.match(/class="prose-cg-button"/g)).toHaveLength(1);
    expect(html).toContain('data-cg-image-id="城门场景"');
    expect(html).toMatch(/舟<\/button>走过城门。<button[^>]*class="prose-cg-button"/);
    expect(html).toContain('aria-label="查看 林舟 的资料"');
    expect(html.match(/highlighted-paragraph/g)).toHaveLength(2);
    expect(html).toContain('data-prose-start="0" data-prose-end="3"');
    expect(html).toContain('data-prose-start="3" data-prose-end="9"');
  });

  it('escapes author text and leaves ordinary timeline calls unchanged when callbacks are absent', () => {
    const text = '林舟说：<script>&你好。</script>';
    const html = renderToStaticMarkup(createElement(WritingTimeline, { text, status: 'completed', entities: [entity('traveler', '林舟')], images: [image('chapter')] }));
    expect(paragraphText(html)).toEqual([text]);
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).not.toContain('data-prose-control');
  });
});
