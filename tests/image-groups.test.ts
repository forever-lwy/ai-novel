import { describe, expect, it } from 'vitest';
import { groupStoryImages } from '../client/image-groups';
import { imageGroupKey } from '../shared/image-groups';
import type { ChapterRef, Entity, StoryImage } from '../shared/types';

const person: Entity = { id: 'person', name: '林舟', aliases: ['小舟'], kind: 'character', description: '', visibility: 'public', locked: false, facts: [] };
const chapter = { id: 'chapter', title: '城门初遇' } as ChapterRef;
const image = (id: string, patch: Partial<StoryImage> = {}): StoryImage => ({ id, projectId: 'project', branchId: 'branch', baseRevisionId: 'revision', kind: 'portrait', entityId: person.id, title: '旧人物名', status: 'completed', url: `/images/${id}`, active: false, prompt: '', automatic: false, visibility: 'public', createdAt: '2026-10-21T01:00:00Z', updatedAt: '2026-10-21T01:00:00Z', ...patch });

describe('gallery groups', () => {
  it('keeps all variants of an entity together and uses the selected completed cover without changing input order', () => {
    const images = [image('selected', { active: true }), image('new', { title: '蓝衣版本', createdAt: '2026-10-21T02:00:00Z' }), image('running', { status: 'running', url: undefined, createdAt: '2026-10-21T03:00:00Z' })];
    const before = structuredClone(images);
    const [group] = groupStoryImages(images, [person], [chapter]);
    expect(group.cover.id).toBe('selected'); expect(group.images.map(value => value.id)).toEqual(['running', 'new', 'selected']);
    expect(group.title).toBe('林舟 · 立绘'); expect(group.searchText).toContain('蓝衣版本'); expect(group.searchText).toContain('小舟'); expect(images).toEqual(before);
  });

  it('keeps different characters, CG chapters and scene ranges separate, regardless of equal titles or references', () => {
    const cg = { kind: 'cg' as const, entityId: undefined, chapterId: chapter.id, title: '同名 CG' };
    const first = image('cg-1', { ...cg, selection: { start: 0, end: 20 }, sourceText: '城门下初次相遇。' });
    const images = [image('person-a'), image('person-b', { entityId: 'other' }), first, image('cg-1-edit', { ...first, id: 'cg-1-edit', referenceImageId: first.id }), image('cg-2', { ...cg, selection: { start: 30, end: 50 } }), image('whole', cg), image('another-chapter', { ...cg, chapterId: 'chapter-2', selection: first.selection, referenceImageIds: [first.id] })];
    const groups = groupStoryImages(images, [person], [chapter]);
    expect(groups).toHaveLength(6); expect(groups.find(group => group.id === imageGroupKey(first))?.images).toHaveLength(2);
    expect(groups.find(group => group.id === imageGroupKey(first))).toMatchObject({ title: '城门初遇 · 选段 CG', excerpt: '城门下初次相遇。' });
    expect(groups.find(group => group.id === imageGroupKey(images[5]))?.title).toBe('城门初遇 · 整章 CG');
  });

  it('uses the same group for an entity portrait and material image, and for maps across chapters', () => {
    const groups = groupStoryImages([image('portrait'), image('entity', { kind: 'entity', chapterId: 'later' }), image('map-1', { kind: 'map', entityId: undefined }), image('map-2', { kind: 'map', entityId: undefined, chapterId: 'later' })], [person], [chapter]);
    expect(groups.map(group => group.images.length)).toEqual([2, 2]); expect(groups[1].title).toBe('世界地图');
    expect(imageGroupKey(image('merged'), 'canonical')).toBe('entity:canonical');
  });

  it('falls back to the newest successful version without enabling it, and exposes unfinished-only groups', () => {
    const groups = groupStoryImages([image('old'), image('new', { createdAt: '2026-10-21T02:00:00Z' }), image('failed', { createdAt: '2026-10-21T03:00:00Z', status: 'failed', url: undefined }), image('waiting', { entityId: 'waiting-person', status: 'queued', url: undefined })], [], []);
    expect(groups[0].cover.id).toBe('new'); expect(groups[0].cover.active).toBe(false); expect(groups[0].images).toHaveLength(3);
    expect(groups[1].cover.status).toBe('queued');
  });

  it('does not merge orphan entity images by name and derives current titles from current metadata', () => {
    expect(groupStoryImages([image('a', { entityId: undefined }), image('b', { entityId: undefined })], [], [])).toHaveLength(2);
    const [group] = groupStoryImages([image('portrait', { chapterId: chapter.id })], [{ ...person, name: '新名字' }], [{ ...chapter, title: '新章名' }]);
    expect(group.title).toBe('新名字 · 立绘'); expect(group.searchText).toContain('新章名');
  });
});
