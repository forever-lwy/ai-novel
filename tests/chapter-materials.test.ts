import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { ImageService } from '../server/images.js';
import { buildApp } from '../server/app.js';
import type { ChapterMaterials, StoryImage } from '../shared/types.js';
import { readingPng, readingProgressStory } from './fixtures/reading-progress.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'novel-chapter-materials-')); const store = new Store(directory);
  const images = new ImageService(store, () => ({ providers: [] }));
  cleanups.push(async () => { await images.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, images, ...readingProgressStory(store) };
}

function addPortrait(store: Store, branchId: string, chapterId: string, entityId: string, imageId: string, backfill = false) {
  const branch = store.getBranch(branchId); const stamp = new Date().toISOString();
  const image: StoryImage = { id: imageId, projectId: branch.projectId, branchId, baseRevisionId: branch.revisionId, kind: 'portrait', title: imageId, chapterId, entityId, status: 'completed', prompt: '', automatic: false, visibility: 'public', mimeType: 'image/png', createdAt: stamp, updatedAt: stamp };
  store.images.insert(image, { bytes: readingPng, mimeType: 'image/png' });
  const update = (state: ReturnType<Store['state']>) => {
    state.imageIds = [...(state.imageIds ?? []), imageId];
    state.activeImageIds = [...(state.activeImageIds ?? []).filter(id => store.images.get(id)?.entityId !== entityId), imageId];
  };
  const checkpoint = (revisionId: string) => store.images.update({ ...image, baseRevisionId: revisionId });
  if (backfill) store.updateImageReferences(branchId, branch.revisionId, chapterId, update, '补充章末图片', checkpoint);
  else { const state = store.state(branchId); update(state); store.commit(branchId, branch.revisionId, state, '新增当前章图片', checkpoint); }
  return image;
}

it('reads historical author materials and the chapter-selected portrait without borrowing later state', () => {
  const ctx = fixture(); const chapters = ctx.store.state(ctx.branchId).chapters; const person = ctx.store.state(ctx.branchId).entities.find(entity => entity.name === '林舟')!;
  const old = ctx.store.images.all(ctx.project.id).find(image => image.kind === 'portrait')!;
  const next = addPortrait(ctx.store, ctx.branchId, chapters[2].id, person.id, 'later-portrait');
  const count = ctx.store.db.prepare('SELECT total_changes() AS count').get()!.count;
  const early = ctx.images.chapterMaterials(ctx.branchId, chapters[0].id); const later = ctx.images.chapterMaterials(ctx.branchId, chapters[2].id);
  expect(early).toMatchObject({ branchId: ctx.branchId, chapterId: chapters[0].id, revisionId: ctx.store.getBranch(ctx.branchId).revisionId });
  expect(early.entities.find(entity => entity.id === person.id)?.facts.map(fact => fact.text)).toContain('身份是旅人');
  expect(JSON.stringify(early.entities)).not.toContain('当前受伤'); expect(early.entities.some(entity => entity.name === '阿岚')).toBe(false);
  expect(early.entities.some(entity => entity.name === '秘密看守')).toBe(true); expect(early.entities.some(entity => entity.name === '未来战役')).toBe(true);
  expect(early.images.map(image => image.id)).toEqual([old.id]); expect(later.images.map(image => image.id)).toEqual([next.id]);
  expect(JSON.stringify(later.entities)).toContain('当前受伤'); expect(early.images[0]).toMatchObject({ entityId: person.id, active: true });
  expect(early.images[0].url).toContain(`/chapters/${chapters[0].id}/images/${old.id}/content`);
  expect(early.images[0].previewUrl).toContain('size=preview');
  expect(ctx.store.view(ctx.branchId, true).state.entities).toEqual(ctx.store.state(ctx.branchId).entities);
  expect(ctx.store.db.prepare('SELECT total_changes() AS count').get()!.count).toBe(count);
});

it('keeps earlier names and merges independent, projects merged portraits and respects fork and rollback selection', () => {
  const ctx = fixture(); const state = ctx.store.state(ctx.branchId); const firstId = state.chapters[0].id; const thirdId = state.chapters[2].id;
  const from = state.entities.find(entity => entity.name === '林舟')!; const to = state.entities.find(entity => entity.name === '秘密看守')!;
  const fork = ctx.store.fork(ctx.branchId, { baseRevisionId: ctx.store.getBranch(ctx.branchId).revisionId, chapterId: firstId, name: '早章独立故事线' });
  const before = ctx.store.getBranch(ctx.branchId).revisionId;
  ctx.store.mergeEntities(ctx.branchId, before, from.id, to.id);
  const early = ctx.images.chapterMaterials(ctx.branchId, firstId); const merged = ctx.images.chapterMaterials(ctx.branchId, thirdId);
  expect(early.entities.find(entity => entity.id === from.id)?.name).toBe('林舟'); expect(early.images[0].entityId).toBe(from.id);
  expect(merged.entities.some(entity => entity.id === from.id)).toBe(false); expect(merged.entities.find(entity => entity.id === to.id)?.aliases).toContain('林舟'); expect(merged.images[0].entityId).toBe(to.id);
  const extra = addPortrait(ctx.store, ctx.branchId, firstId, to.id, 'backfilled-portrait', true);
  expect(ctx.images.chapterMaterials(ctx.branchId, firstId).images.some(image => image.id === extra.id)).toBe(true);
  expect(ctx.images.chapterMaterials(fork.branch.id, firstId).images.some(image => image.id === extra.id)).toBe(false);
  expect(() => ctx.images.chapterMaterials(fork.branch.id, thirdId)).toThrow('不属于当前故事线');
  ctx.store.rollback(ctx.branchId, { baseRevisionId: ctx.store.getBranch(ctx.branchId).revisionId, revisionId: before });
  expect(ctx.images.chapterMaterials(ctx.branchId, thirdId).entities.some(entity => entity.id === from.id)).toBe(true);
  expect(ctx.images.chapterMaterials(ctx.branchId, firstId).images.some(image => image.id === extra.id)).toBe(false);
});

it('refuses absent chapter boundaries rather than substituting the current materials', () => {
  const ctx = fixture(); const state = ctx.store.state(ctx.branchId); const extra = ctx.store.putChapter('不存在历史快照的章节', '这里只是样例正文。'); extra.status = 'ready';
  state.chapters.unshift(extra); ctx.store.commit(ctx.branchId, ctx.store.getBranch(ctx.branchId).revisionId, state, '缺少早章快照的样例');
  expect(() => ctx.images.chapterMaterials(ctx.branchId, extra.id)).toThrow('未找到该章节的历史状态');
  expect(() => ctx.images.chapterMaterials(ctx.branchId, 'unknown')).toThrow('不属于当前故事线');
});

it('serves authenticated chapter images, including historical references removed from the complete current gallery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'novel-chapter-materials-api-'));
  const ctx = await buildApp({ dataDir: directory, initialPassword: 'chapter-materials-fixture-password', startEngine: false });
  cleanups.push(async () => { await ctx.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const story = readingProgressStory(ctx.store); const firstId = ctx.store.state(story.branchId).chapters[0].id;
  const image = ctx.store.images.all(story.project.id).find(image => image.kind === 'portrait')!;
  const current = ctx.store.state(story.branchId); current.imageIds = current.imageIds!.filter(id => id !== image.id); current.activeImageIds = current.activeImageIds!.filter(id => id !== image.id);
  ctx.store.commit(story.branchId, ctx.store.getBranch(story.branchId).revisionId, current, '仅当前章移除立绘');
  const url = `/api/branches/${story.branchId}/chapters/${firstId}/materials`;
  expect((await ctx.app.inject({ url })).statusCode).toBe(401);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'chapter-materials-fixture-password' } }); const cookies = { session: login.cookies.find(cookie => cookie.name === 'session')!.value };
  const materials = await ctx.app.inject({ url, cookies }); expect(materials.statusCode).toBe(200);
  const data = materials.json<ChapterMaterials>(); expect(data.images.map(image => image.id)).toEqual([image.id]);
  const contentUrl = data.images[0].url!; const content = await ctx.app.inject({ url: contentUrl, cookies }); expect(content.statusCode).toBe(200); expect(content.rawPayload).toEqual(readingPng);
  const tag = String(content.headers.etag); expect((await ctx.app.inject({ url: contentUrl, cookies, headers: { 'if-none-match': tag } })).statusCode).toBe(304);
  expect((await ctx.app.inject({ url: contentUrl, headers: { 'if-none-match': tag } })).statusCode).toBe(401);
  const preview = await ctx.app.inject({ url: data.images[0].previewUrl!, cookies }); expect(preview.statusCode).toBe(200); expect(preview.headers['content-type']).toBe('image/webp');
  expect((await ctx.app.inject({ url: `/api/branches/${story.branchId}/images/${image.id}/content`, cookies })).statusCode).toBe(404);
  const unrelated = ctx.store.createProject({ title: '另一个作品' });
  expect((await ctx.app.inject({ url: contentUrl.replace(story.branchId, unrelated.mainBranchId), cookies, headers: { 'if-none-match': tag } })).statusCode).toBe(404);
  ctx.store.updateImageReferences(story.branchId, ctx.store.getBranch(story.branchId).revisionId, firstId, state => { state.imageIds = state.imageIds!.filter(id => id !== image.id); state.activeImageIds = state.activeImageIds!.filter(id => id !== image.id); }, '从该章起移除图片');
  expect((await ctx.app.inject({ url: contentUrl, cookies, headers: { 'if-none-match': tag } })).statusCode).toBe(404);
  expect((await ctx.app.inject({ url, cookies })).json<ChapterMaterials>().images).toEqual([]);
});
