import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Store } from '../server/store.js';
import { ImageService } from '../server/images.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import { includesChapterVersion } from '../shared/chapter-versions.js';
import { imageGroupKey } from '../shared/image-groups.js';
import type { Settings, StoryImage, StoryState } from '../shared/types.js';
import { chapterEditHistoryStory, legacyChapterEdit } from './fixtures/chapter-edit-history.js';
import { readingPng } from './fixtures/reading-progress.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-edited-history-'))); cleanup.push(() => store.close());
  const settings: Settings = { providers: [{ id: 'fixture', name: '本地测试', protocol: 'openai-chat', baseUrl: 'http://unused.invalid' }], writingProviderId: '', planningProviderId: '', extractionProviderId: '', imageSettings: { ...defaultImageSettings(), providerId: 'fixture', model: 'gpt-image-1' } };
  const generator = vi.fn(async () => ({ bytes: readingPng, mimeType: 'image/png' as const }));
  const service = new ImageService(store, () => settings, generator); cleanup.push(() => service.close());
  const story = chapterEditHistoryStory(store);
  const base = () => store.getBranch(story.branchId).revisionId;
  const edit = (text: string) => { const chapter = store.state(story.branchId).chapters.at(-1)!; return store.saveChapter(story.branchId, { baseRevisionId: base(), chapterId: chapter.id, title: chapter.title, text }); };
  return { ...story, store, service, generator, base, edit };
}

describe('manual edits preserve generation history and illustrations', () => {
  it('preserves original process, image pixels, enabled choices and sibling history across repeated edits', () => {
    const ctx = setup(); const { store, branchId, chapter, job, service } = ctx;
    const original = store.chapter(branchId, chapter.id).text; const activities = store.listWritingActivities(job.id);
    const images = service.list(branchId, true); const cg = images.find(image => image.kind === 'cg')!;
    const sibling = store.fork(branchId, { baseRevisionId: ctx.base(), name: '旧正文线' }); const oldRevision = ctx.base();
    const first = ctx.edit(`新增开头。${original}`); const second = ctx.edit(`再次修订。${original}`); const target = second.state.chapters[2];
    expect(target.previousChapterIds).toEqual([chapter.id, first.state.chapters[2].id]); expect(includesChapterVersion(target, String(job.payload.generatedChapterId))).toBe(true);
    expect(store.listWritingActivities(job.id)).toEqual(activities); expect(store.images.all(ctx.project.id)).toHaveLength(images.length);
    expect(service.list(branchId, true).find(image => image.id === cg.id)).toMatchObject({ chapterId: target.id, sourceChapterId: chapter.id, active: true, sourceText: original });
    expect(service.content(branchId, cg.id, true).bytes).toEqual(readingPng); expect(store.images.get(cg.id)?.chapterId).toBe(chapter.id);
    expect(service.list(sibling.branch.id, true).find(image => image.id === cg.id)).toMatchObject({ chapterId: chapter.id, active: true });
    expect(store.revisionState(oldRevision).chapters[2].id).toBe(chapter.id); expect(ctx.generator).not.toHaveBeenCalled();
    service.setActive(branchId, cg.id, ctx.base(), false); expect(service.list(branchId, true).find(image => image.id === cg.id)?.active).toBe(false);
    store.rollback(branchId, { baseRevisionId: ctx.base(), revisionId: second.branch.revisionId });
    expect(service.list(branchId, true).find(image => image.id === cg.id)?.active).toBe(true);
    service.delete(branchId, cg.id, ctx.base()); expect(service.list(branchId, true).some(image => image.id === cg.id)).toBe(false);
    expect(service.content(sibling.branch.id, cg.id, true).bytes).toEqual(readingPng);
  });

  it('keeps early-chapter pictures at all later boundaries and removes them only when that chapter is deleted', () => {
    const ctx = setup(); const { store, branchId, service } = ctx; const first = store.state(branchId).chapters[0];
    const portrait = service.list(branchId, true).find(image => image.kind === 'portrait')!;
    const saved = store.saveChapter(branchId, { baseRevisionId: ctx.base(), chapterId: first.id, title: first.title, text: `新开场。${store.chapter(branchId, first.id).text}` });
    const replacement = saved.state.chapters[0].id;
    expect(store.readingState(branchId, replacement, false).imageIds).toContain(portrait.id);
    service.setActive(branchId, portrait.id, ctx.base(), false);
    expect(store.readingState(branchId, replacement, false).activeImageIds).not.toContain(portrait.id);
    const fork = store.fork(branchId, { baseRevisionId: ctx.base(), chapterId: replacement, name: '修订后的章末' });
    expect(service.list(fork.branch.id, true).find(image => image.id === portrait.id)).toMatchObject({ chapterId: replacement, active: false });
    const removed = store.deleteChapter(branchId, ctx.base(), replacement);
    expect(removed.state.imageIds).not.toContain(portrait.id); expect(() => service.content(branchId, portrait.id, true)).toThrow('不包含');
    expect(() => store.restoreProject(store.exportProject(ctx.project.id))).not.toThrow();
  });

  it('relocates an unchanged selected scene and preserves removed or ambiguous scenes without false highlighting or retries', () => {
    const ctx = setup(); const { store, branchId, service, chapter } = ctx; const original = store.chapter(branchId, chapter.id).text;
    const cg = store.images.all(ctx.project.id).find(image => image.kind === 'cg')!;
    const selection = { start: 0, end: 6 }; const selected: StoryImage = { ...cg, id: 'selected-scene', sourceText: original.slice(0, 6), selection };
    store.images.insert(selected, { bytes: readingPng, mimeType: 'image/png' });
    store.updateImageReferences(branchId, ctx.base(), chapter.id, state => { state.imageIds!.push(selected.id); state.activeImageIds!.push(selected.id); }, '添加选段样例', revisionId => store.images.update({ ...selected, baseRevisionId: revisionId }));
    ctx.edit(`新开头。${original}`);
    expect(service.list(branchId, true).find(image => image.id === selected.id)).toMatchObject({ selection: { start: 4, end: 10 }, sourceSelection: selection });
    ctx.edit('完全不同的场景。');
    const detached = service.list(branchId, true).find(image => image.id === selected.id)!; const full = service.list(branchId, true).find(image => image.id === cg.id)!;
    expect(detached.selection).toBeUndefined(); expect(detached.sourceSelection).toEqual(selection); expect(detached.active).toBe(true);
    expect(imageGroupKey(detached)).not.toBe(imageGroupKey(full)); expect(() => service.retry(branchId, selected.id, ctx.base())).toThrow('重新选择正文');
    ctx.edit(`甲${selected.sourceText}乙${selected.sourceText}丙`);
    expect(service.list(branchId, true).find(image => image.id === selected.id)?.selection).toBeUndefined(); expect(ctx.generator).not.toHaveBeenCalled();
  });

  it('remaps edit lineage, process ownership and original image evidence through backup restoration', () => {
    const ctx = setup(); ctx.edit('改动后的灯塔场景。'); const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
    const state = ctx.store.state(restored.mainBranchId); const chapter = state.chapters[2];
    const job = ctx.store.db.prepare("SELECT data FROM jobs WHERE project_id=? AND json_extract(data,'$.kind')='generate'").get(restored.id)!;
    const restoredJob = JSON.parse(String(job.data));
    expect(chapter.previousChapterIds).not.toContain(ctx.chapter.id); expect(chapter.previousChapterIds).toContain(restoredJob.payload.generatedChapterId);
    expect(ctx.store.listWritingActivities(restoredJob.id)).toEqual(ctx.store.listWritingActivities(ctx.job.id));
    const cg = ctx.service.list(restored.mainBranchId, true).find(image => image.kind === 'cg')!;
    expect(cg.chapterId).toBe(chapter.id); expect(cg.active).toBe(true); expect(cg.sourceChapterId).toBe(restoredJob.payload.generatedChapterId);
    const bad = ctx.store.exportProject(ctx.project.id); const entry = bad.revisions.find(entry => entry.revision.id === ctx.base())!;
    const stateCopy: StoryState = JSON.parse(gunzipSync(Buffer.from(entry.snapshot, 'base64')).toString()); stateCopy.chapters[2].previousChapterIds = ['missing-chapter'];
    const invalid = { ...bad, revisions: bad.revisions.map(item => item === entry ? { revision: item.revision, state: stateCopy } : item) };
    expect(() => ctx.store.restoreProject(invalid)).toThrow('章节修订关联');
  });

  it('recovers existing edited chapters from history without writes and respects subsequent explicit deletion', () => {
    const ctx = setup(); const original = ctx.store.chapter(ctx.branchId, ctx.chapter.id).text; const cg = ctx.service.list(ctx.branchId, true).find(image => image.kind === 'cg')!;
    legacyChapterEdit(ctx.store, ctx.branchId, `旧版本第一次编辑。${original}`); legacyChapterEdit(ctx.store, ctx.branchId, `旧版本第二次编辑。${original}`);
    const changes = ctx.store.db.prepare('SELECT total_changes() AS count').get()!.count;
    const recovered = ctx.store.state(ctx.branchId); const raw = ctx.store.db.prepare('SELECT state FROM revisions WHERE id=?').get(ctx.base())!;
    expect(JSON.parse(gunzipSync(raw.state as Uint8Array).toString()).imageIds).not.toContain(cg.id);
    expect(recovered.imageIds).toContain(cg.id); expect(recovered.activeImageIds).toContain(cg.id); expect(recovered.chapters[2].previousChapterIds).toContain(ctx.chapter.id);
    expect(ctx.store.db.prepare('SELECT total_changes() AS count').get()!.count).toBe(changes);
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
    expect(ctx.service.list(restored.mainBranchId, true).find(image => image.kind === 'cg')?.active).toBe(true);
    ctx.service.delete(ctx.branchId, cg.id, ctx.base()); ctx.edit('删除图片后的手动编辑。');
    expect(ctx.store.state(ctx.branchId).imageIds).not.toContain(cg.id); expect(ctx.service.list(ctx.branchId, true).some(image => image.id === cg.id)).toBe(false);
  });

  it('recovers a legacy image without replacing a version selected after the old edit', () => {
    const ctx = setup(); const cg = ctx.service.list(ctx.branchId, true).find(image => image.kind === 'cg')!;
    legacyChapterEdit(ctx.store, ctx.branchId, '旧版编辑后又绘制了新插画。');
    const row = ctx.store.db.prepare('SELECT state FROM revisions WHERE id=?').get(ctx.base())!;
    const state: StoryState = JSON.parse(gunzipSync(row.state as Uint8Array).toString());
    const latest: StoryImage = { ...ctx.store.images.get(cg.id)!, id: 'new-selected-cg', chapterId: state.chapters[2].id, sourceText: '旧版编辑后又绘制了新插画。' };
    ctx.store.images.insert(latest, { bytes: readingPng, mimeType: 'image/png' }); state.imageIds!.push(latest.id); state.activeImageIds!.push(latest.id);
    ctx.store.commit(ctx.branchId, ctx.base(), state, '保存编辑后新插画', revisionId => ctx.store.images.update({ ...latest, baseRevisionId: revisionId }));
    const images = ctx.service.list(ctx.branchId, true);
    expect(images.find(image => image.id === latest.id)?.active).toBe(true); expect(images.find(image => image.id === cg.id)?.active).toBe(false);
  });
});
