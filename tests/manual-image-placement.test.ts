import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { ImageService } from '../server/images.js';
import { buildApp } from '../server/app.js';
import { imageGroupKey } from '../shared/image-groups.js';
import type { StoryImage } from '../shared/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF4QAAAAASUVORK5CYII=', 'base64');
const text = '林舟来到城门。\r\n\r\n他在雨中拾起钥匙。';
const end = { start: text.indexOf('他'), end: text.length };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); });

function install(store: Store) {
  const project = store.createProject({ title: '手动绑定测试' }); const branchId = project.mainBranchId;
  const chapter = store.putChapter('城门', text); chapter.status = 'ready';
  const state = store.state(branchId); state.chapters = [chapter]; state.imageIds = ['first', 'second']; state.activeImageIds = ['first'];
  const date = new Date().toISOString();
  const image: StoryImage = { id: 'first', projectId: project.id, branchId, baseRevisionId: store.getBranch(branchId).revisionId, kind: 'cg', status: 'completed', title: '城门CG', prompt: '原始提示词', chapterId: chapter.id, sourceText: text, automatic: false, visibility: 'public', createdAt: date, updatedAt: date, mimeType: 'image/png' };
  const view = store.commit(branchId, image.baseRevisionId, state, '保存原图', revisionId => {
    store.images.insert({ ...image, baseRevisionId: revisionId }, { bytes: png, mimeType: 'image/png' });
    store.images.insert({ ...image, id: 'second', baseRevisionId: revisionId }, { bytes: png, mimeType: 'image/png' });
  });
  return { store, project, branchId, chapter, originalRevision: view.branch.revisionId, base: () => store.getBranch(branchId).revisionId };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'novel-manual-placement-')); const store = new Store(directory);
  const generator = vi.fn(); const optimizer = vi.fn(); const images = new ImageService(store, () => ({ providers: [] }), generator, optimizer);
  cleanups.push(async () => { await images.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...install(store), images, generator, optimizer };
}

it('changes only this revision position for old CGs and keeps pixels, prompt, active choice and gallery group', () => {
  const ctx = fixture(); const before = ctx.store.images.get('first')!;
  const result = ctx.images.setPlacement(ctx.branchId, 'first', { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id, selection: end });
  const [first, second] = result.images;
  expect(first).toMatchObject({ placementSource: 'manual', placementStatus: 'matched', selection: end, sourceText: '他在雨中拾起钥匙。', active: true });
  expect(imageGroupKey(first)).toBe(imageGroupKey(second)); expect(imageGroupKey(first)).toBe(imageGroupKey(before));
  expect(result.view.state.activeImageIds).toEqual(['first']);
  expect(ctx.store.images.get('first')).toEqual(before); expect(ctx.store.images.content('first')?.bytes).toEqual(png);
  expect(ctx.generator).not.toHaveBeenCalled(); expect(ctx.optimizer).not.toHaveBeenCalled();
});

it('supports chapter-only manual placement and rejects late automatic success or failure', () => {
  const ctx = fixture(); const image = ctx.store.images.get('first')!;
  Object.assign(image, { automatic: true, bindingStatus: 'bound', sceneDescription: '旅人进城', placementStatus: 'pending' }); ctx.store.images.update(image);
  ctx.images.setPlacement(ctx.branchId, image.id, { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id });
  expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ placementSource: 'manual', placementStatus: 'unmatched', chapterId: ctx.chapter.id, active: true });
  expect(ctx.images.list(ctx.branchId, true)[0].selection).toBeUndefined(); expect(ctx.images.list(ctx.branchId, true)[0].sourceText).toBeUndefined();
  ctx.images.applyScenePlacement(image.id, ctx.chapter.id, end);
  ctx.images.applyScenePlacement(image.id, ctx.chapter.id, undefined, '上游失败');
  expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ placementSource: 'manual', placementStatus: 'unmatched' });
  expect(ctx.images.list(ctx.branchId, true)[0].placementError).toBeUndefined();
  expect(ctx.store.images.get(image.id)).toEqual(image);
});

it('isolates sibling branches and restores the previous position when rolled back', () => {
  const ctx = fixture(); const child = ctx.store.fork(ctx.branchId, { baseRevisionId: ctx.base(), name: '另一条线' }).branch.id;
  ctx.images.setPlacement(ctx.branchId, 'first', { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id, selection: end });
  expect(ctx.images.list(child, true)[0].selection).toBeUndefined(); expect(ctx.images.list(child, true)[0].placementSource).toBeUndefined();
  ctx.store.rollback(ctx.branchId, { baseRevisionId: ctx.base(), revisionId: ctx.originalRevision });
  expect(ctx.images.list(ctx.branchId, true)[0].selection).toBeUndefined(); expect(ctx.store.state(ctx.branchId).imagePlacements).toBeUndefined();
});

it('projects manually chosen evidence after chapter edits without binding an obsolete offset', () => {
  const ctx = fixture(); ctx.images.setPlacement(ctx.branchId, 'first', { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id, selection: end });
  const prefix = '一场大雨落下。\n';
  let view = ctx.store.saveChapter(ctx.branchId, { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id, title: '城门', text: prefix + text });
  expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ chapterId: view.state.chapters[0].id, sourceChapterId: ctx.chapter.id, sourceSelection: end, selection: { start: prefix.length + end.start, end: prefix.length + end.end }, placementSource: 'manual' });
  view = ctx.store.saveChapter(ctx.branchId, { baseRevisionId: ctx.base(), chapterId: view.state.chapters[0].id, title: '城门', text: '作者删除了拾起钥匙的情节。' });
  const lost = ctx.images.list(ctx.branchId, true)[0];
  expect(lost).toMatchObject({ chapterId: view.state.chapters[0].id, placementSource: 'manual', placementStatus: 'unmatched', sourceSelection: end }); expect(lost.selection).toBeUndefined();
  // The author can repair the projected old selection against the new chapter.
  expect(() => ctx.images.setPlacement(ctx.branchId, 'first', { baseRevisionId: ctx.base(), chapterId: view.state.chapters[0].id, selection: { start: 0, end: 5 } })).not.toThrow();
});

it('backs up/remaps manual evidence and validates malformed image, chapter and text associations', () => {
  const ctx = fixture(); ctx.images.setPlacement(ctx.branchId, 'first', { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id, selection: end });
  const backup = ctx.store.exportProject(ctx.project.id); const restored = ctx.store.restoreProject(backup);
  const restoredImage = ctx.images.list(restored.mainBranchId, true)[0];
  expect(restoredImage).toMatchObject({ placementSource: 'manual', selection: end, sourceText: '他在雨中拾起钥匙。' });
  expect(ctx.store.state(restored.mainBranchId).imagePlacements?.[restoredImage.id]?.chapterId).toBe(restoredImage.chapterId);
  expect(restoredImage.id).not.toBe('first'); expect(restoredImage.chapterId).not.toBe(ctx.chapter.id);
  for (const mutation of ['image', 'chapter', 'text']) {
    const malformed = structuredClone(backup); const revision = malformed.revisions.at(-1)!; const snapshot = ctx.store.revisionState(revision.revision.id); revision.state = snapshot; delete revision.snapshot;
    if (mutation === 'image') snapshot.imagePlacements = { absent: Object.values(snapshot.imagePlacements!)[0] };
    else if (mutation === 'chapter') snapshot.imagePlacements!.first.chapterId = 'absent';
    else snapshot.imagePlacements!.first.sourceText = '编造的原文';
    expect(() => ctx.store.restoreProject(malformed)).toThrow('手动插画位置');
  }
});

it('cleans manual evidence when the image or chapter is removed', () => {
  const ctx = fixture(); ctx.images.setPlacement(ctx.branchId, 'first', { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id, selection: end });
  ctx.images.delete(ctx.branchId, 'first', ctx.base()); expect(ctx.store.state(ctx.branchId).imagePlacements).toEqual({});
  ctx.images.setPlacement(ctx.branchId, 'second', { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id });
  ctx.store.deleteChapter(ctx.branchId, ctx.base(), ctx.chapter.id); expect(ctx.store.state(ctx.branchId).imagePlacements).toEqual({});
  expect(() => ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id))).not.toThrow();
});

it('rejects stale versions, wrong chapters, missing images and invalid ranges before changing any record', () => {
  const ctx = fixture(); const before = ctx.store.exportProject(ctx.project.id);
  const base = ctx.base();
  for (const input of [{ baseRevisionId: 'stale', chapterId: ctx.chapter.id }, { baseRevisionId: base, chapterId: 'wrong' }, { baseRevisionId: base, chapterId: ctx.chapter.id, selection: { start: 2, end: 1 } }, { baseRevisionId: base, chapterId: ctx.chapter.id, selection: { start: 0, end: text.length + 1 } }, { baseRevisionId: base, chapterId: ctx.chapter.id, selection: { start: text.indexOf('\r'), end: text.indexOf('他') } }]) expect(() => ctx.images.setPlacement(ctx.branchId, 'first', input)).toThrow();
  expect(() => ctx.images.setPlacement(ctx.branchId, 'missing', { baseRevisionId: base, chapterId: ctx.chapter.id })).toThrow();
  expect(ctx.store.exportProject(ctx.project.id)).toEqual(before);
});

it('exposes a strict authenticated HTTP endpoint without requiring an image model', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'novel-manual-placement-api-'));
  const app = await buildApp({ dataDir: directory, initialPassword: 'manual-placement-fixture-password', startEngine: false });
  cleanups.push(async () => { await app.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const ctx = install(app.store); const url = `/api/branches/${ctx.branchId}/images/first/placement`;
  expect((await app.app.inject({ method: 'PUT', url, payload: { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id, selection: end } })).statusCode).toBe(401);
  const login = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'manual-placement-fixture-password' } }); const cookies = { session: login.cookies.find(cookie => cookie.name === 'session')!.value };
  expect((await app.app.inject({ method: 'PUT', url, cookies, payload: { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id, selection: end, ignored: true } })).statusCode).toBe(400);
  const result = await app.app.inject({ method: 'PUT', url, cookies, payload: { baseRevisionId: ctx.base(), chapterId: ctx.chapter.id, selection: end } });
  expect(result.statusCode).toBe(200); expect(result.json().images[0]).toMatchObject({ placementSource: 'manual', selection: end });
});
