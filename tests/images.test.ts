import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageService } from '../server/images.js';
import { Store } from '../server/store.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import type { Entity, Settings, StoryImage } from '../shared/types.js';
import type { ImageGenerator } from '../server/image-provider.js';
import type { ImagePromptOptimizer } from '../server/image-prompts.js';
import { buildApp } from '../server/app.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=', 'base64');
const fixtureSettings: Settings = { providers: [{ id: 'test', name: 'test', protocol: 'openai-chat', baseUrl: 'http://fixture.test/v1', apiKey: 'fixture-secret' }], writingProviderId: 'test', planningProviderId: 'test', extractionProviderId: 'test', imageSettings: { ...defaultImageSettings(), providerId: 'test', model: 'image-fixture', autoCG: true } };
const character = (id = 'character-1', name = '林月'): Entity => ({ id, name, kind: 'character', aliases: ['小月'], description: '银发少女，身穿蓝色长裙。', visibility: 'public', locked: true, nameStatus: 'confirmed', facts: [] });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
function setup(generator: ImageGenerator = async () => ({ bytes: png, mimeType: 'image/png' }), optimize?: ImagePromptOptimizer) {
  const directory = mkdtempSync(join(tmpdir(), 'novel-images-')); const store = new Store(directory); const settings = structuredClone(fixtureSettings);
  const optimizer = async (_settings: Settings, input: { material: string; instruction?: string; stylePrompt: string }) => ({ prompt: [input.stylePrompt, input.material, input.instruction].filter(Boolean).join('\n\n'), referenceEntityIds: [], parameters: {} });
  const service = new ImageService(store, () => settings, generator, optimize ?? optimizer);
  const project = store.createProject({ title: '图片测试' }); const branchId = project.mainBranchId;
  const chapter = store.putChapter('初遇', '林月走进庭院。天空忽然裂开，一艘巨舰遮蔽了城市。'); chapter.status = 'ready';
  const state = store.state(branchId); state.entities.push(character()); state.chapters.push(chapter);
  store.commit(branchId, store.getBranch(branchId).revisionId, state, 'fixture');
  cleanup.push(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, project, branchId, chapter, settings, base: () => store.getBranch(branchId).revisionId };
}
async function until(predicate: () => boolean) { for (let index = 0; index < 100 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true); }

describe('durable story illustrations', () => {
  it('binds a portrait to a version and exposes only completed public pixels to readers', async () => {
    const ctx = setup(); const result = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' });
    expect(result.image.status).toBe('queued'); expect(result.view.state.imageIds).toEqual([result.image.id]); expect(ctx.service.list(ctx.branchId)).toEqual([]);
    await until(() => ctx.store.images.get(result.image.id)?.status === 'completed');
    expect(ctx.base()).toBe(result.view.branch.revisionId); expect(ctx.service.content(ctx.branchId, result.image.id).bytes).toEqual(png);
    expect(ctx.service.list(ctx.branchId)[0]).toMatchObject({ prompt: '', sourceText: undefined, url: expect.stringContaining('view=reader') });
    expect(ctx.store.view(ctx.branchId).state.imageIds).toEqual([result.image.id]);
  });
  it('allows consecutive manual requests when revisions only add image references', async () => {
    const resolvers: (() => void)[] = []; const ctx = setup(async () => { await new Promise<void>(resolve => resolvers.push(resolve)); return { bytes: png, mimeType: 'image/png' }; });
    const first = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' });
    await until(() => resolvers.length === 1);
    const second = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'entity', entityId: 'character-1' });
    await until(() => resolvers.length === 2); resolvers.forEach(resolve => resolve());
    await until(() => [first.image.id, second.image.id].every(id => ctx.store.images.get(id)?.status === 'completed'));
    expect(ctx.service.list(ctx.branchId, true)).toHaveLength(2);
  });
  it('discards delayed results after prose changes and hides images removed by rollback', async () => {
    let release!: () => void; const ctx = setup(async () => { await new Promise<void>(resolve => { release = resolve; }); return { bytes: png, mimeType: 'image/png' }; });
    const original = ctx.base(); const result = ctx.service.generate(ctx.branchId, { baseRevisionId: original, kind: 'portrait', entityId: 'character-1' });
    await until(() => Boolean(release));
    const state = ctx.store.state(ctx.branchId); state.entities[0].description += '戴着眼镜。'; ctx.store.commit(ctx.branchId, ctx.base(), state, '外貌变化'); release();
    await until(() => ctx.store.images.get(result.image.id)?.status === 'stale'); expect(ctx.store.images.content(result.image.id)).toBeUndefined();
    ctx.store.rollback(ctx.branchId, { baseRevisionId: ctx.base(), revisionId: original });
    expect(ctx.service.list(ctx.branchId, true)).toEqual([]); expect(() => ctx.service.content(ctx.branchId, result.image.id, true)).toThrow('不包含');
  });
  it('preserves the old cancelled request when explicitly retrying and never retries failure automatically', async () => {
    let release!: () => void; let calls = 0; const ctx = setup(async () => { calls++; if (calls === 1) await new Promise<void>(resolve => { release = resolve; }); else throw new Error('fixture-secret provider denied'); return { bytes: png, mimeType: 'image/png' }; });
    const initial = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => Boolean(release));
    expect(ctx.service.cancel(ctx.branchId, initial.image.id).status).toBe('cancelled'); const retry = ctx.service.retry(ctx.branchId, initial.image.id, ctx.base()); release();
    expect(retry.image.id).not.toBe(initial.image.id); await until(() => ctx.store.images.get(retry.image.id)?.status === 'failed');
    expect(ctx.store.images.get(initial.image.id)?.status).toBe('cancelled'); expect(ctx.store.images.content(initial.image.id)).toBeUndefined();
    expect(ctx.store.images.get(retry.image.id)?.error).not.toContain('fixture-secret'); expect(calls).toBe(2);
  });
  it('requires actual chapter selections and binds edits to the same original story', async () => {
    const ctx = setup(); expect(() => ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id, selection: { start: 10, end: 900 } })).toThrow('范围无效');
    const image = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id, selection: { start: 0, end: 8 } });
    await until(() => ctx.store.images.get(image.image.id)?.status === 'completed');
    expect(() => ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id, referenceImageId: image.image.id })).toThrow('修改要求');
    expect(() => ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id, referenceImageId: image.image.id, instruction: '增加雨水' })).toThrow('相同章节');
    const edited = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id, selection: { start: 0, end: 8 }, referenceImageId: image.image.id, instruction: '增加雨水' });
    await until(() => ctx.store.images.get(edited.image.id)?.status === 'completed'); expect(ctx.service.list(ctx.branchId)).toHaveLength(1); expect(ctx.service.list(ctx.branchId, true)).toHaveLength(2);
  });
  it('filters secret and future material at generation and after current visibility changes', async () => {
    const ctx = setup(); const image = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => ctx.store.images.get(image.image.id)?.status === 'completed');
    const state = ctx.store.state(ctx.branchId); state.entities[0].visibility = 'secret'; ctx.store.commit(ctx.branchId, ctx.base(), state, '设为秘密');
    expect(ctx.store.view(ctx.branchId).state.imageIds).toEqual([]); expect(ctx.service.list(ctx.branchId)).toEqual([]); expect(() => ctx.service.content(ctx.branchId, image.image.id)).toThrow('不包含');
    const secret = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => ctx.store.images.get(secret.image.id)?.status === 'completed'); expect(secret.image.visibility).toBe('secret');
  });
  it('follows current merges without rewriting historical image ownership', async () => {
    const ctx = setup(); const state = ctx.store.state(ctx.branchId); state.entities.push({ ...character('other-character', '月儿'), aliases: [] }); ctx.store.commit(ctx.branchId, ctx.base(), state, '第二条身份资料');
    const image = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => ctx.store.images.get(image.image.id)?.status === 'completed');
    const beforeMerge = ctx.base(); ctx.store.mergeEntities(ctx.branchId, beforeMerge, 'character-1', 'other-character');
    expect(ctx.service.list(ctx.branchId, true)[0].entityId).toBe('other-character'); expect(ctx.store.images.get(image.image.id)?.entityId).toBe('character-1');
    ctx.store.rollback(ctx.branchId, { baseRevisionId: ctx.base(), revisionId: beforeMerge }); expect(ctx.service.list(ctx.branchId, true)[0].entityId).toBe('character-1');
  });
  it('hides existing public portraits and maps when current materials gain secrets', async () => {
    const ctx = setup(); const state = ctx.store.state(ctx.branchId); state.entities.push({ ...character('town', '山城'), kind: 'location' }); ctx.store.commit(ctx.branchId, ctx.base(), state, '地点');
    const portrait = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); const map = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'map' });
    await until(() => [portrait.image.id, map.image.id].every(id => ctx.store.images.get(id)?.status === 'completed')); expect(ctx.service.list(ctx.branchId)).toHaveLength(2);
    const changed = ctx.store.state(ctx.branchId); changed.entities[0].facts.push({ id: 'secret-fact', text: '她将背叛同伴', temporal: 'future', certainty: 'fact', visibility: 'secret' }); changed.relations.push({ id: 'secret-route', fromId: 'town', toId: 'town', label: '城下密道', visibility: 'secret' }); ctx.store.commit(ctx.branchId, ctx.base(), changed, '秘密资料');
    expect(ctx.service.list(ctx.branchId)).toEqual([]); expect(ctx.store.view(ctx.branchId).state.imageIds).toEqual([]); expect(() => ctx.service.content(ctx.branchId, map.image.id)).toThrow('不包含');
  });
  it('schedules a single automatic batch using explicit names, new characters and actual prose', async () => {
    const ctx = setup(); const before = ctx.base();
    const result = ctx.service.generateAutomatic(ctx.branchId, before, ctx.chapter.id, [{ kind: 'portrait', name: '小月', description: '' }, { kind: 'portrait', name: '林', description: 'wrong' }, { kind: 'cg', description: '巨舰遮天', sourceText: '一艘巨舰遮蔽了城市。' }, { kind: 'cg', description: '未来大战', sourceText: '月球爆炸。' }], ['character-1']);
    expect(result?.images).toHaveLength(2); expect(result?.images.every(image => image.chapterId === ctx.chapter.id)).toBe(true);
    expect(result?.images.every(image => image.baseRevisionId === result.view.branch.revisionId)).toBe(true);
    await until(() => result!.images.every(image => ctx.store.images.get(image.id)?.status === 'completed'));
    expect(ctx.service.generateAutomatic(ctx.branchId, ctx.base(), ctx.chapter.id, [], ['character-1'])).toBeUndefined();
    ctx.settings.imageSettings!.providerId = ''; expect(ctx.service.generateAutomatic(ctx.branchId, ctx.base(), ctx.chapter.id, [], ['character-1'])).toBeUndefined();
  });
  it('atomically checkpoints the writer job together with automatic image references', () => {
    const ctx = setup(); const before = ctx.base();
    ctx.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run('checkpoint', ctx.branchId, ctx.project.id, 'running', '{"before":true}');
    expect(() => ctx.service.generateAutomatic(ctx.branchId, before, ctx.chapter.id, [], ['character-1'], revisionId => {
      ctx.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({ baseRevisionId: revisionId }), 'checkpoint'); throw new Error('checkpoint fixture failed');
    })).toThrow('checkpoint fixture failed');
    expect(ctx.base()).toBe(before); expect(ctx.store.state(ctx.branchId).imageIds).toBeUndefined(); expect(ctx.store.images.all()).toEqual([]); expect(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get('checkpoint')?.data).toBe('{"before":true}');
  });
  it('blocks stale manual requests and active prose jobs before any paid request', () => {
    const ctx = setup(); expect(() => ctx.service.generate(ctx.branchId, { baseRevisionId: 'old', kind: 'portrait', entityId: 'character-1' })).toThrow('新版本');
    ctx.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run('job', ctx.branchId, ctx.project.id, 'running', '{}');
    expect(() => ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' })).toThrow('文字任务'); expect(ctx.store.images.all()).toEqual([]);
  });
  it('rejects entity IDs on CG and map requests before registering or paying for an image', async () => {
    let calls = 0; const ctx = setup(async () => { calls++; return { bytes: png, mimeType: 'image/png' }; }); const before = ctx.base();
    for (const kind of ['cg', 'map'] as const) expect(() => ctx.service.generate(ctx.branchId, { baseRevisionId: before, kind, entityId: 'character-1', chapterId: ctx.chapter.id })).toThrow('不能绑定');
    await Promise.resolve(); expect(ctx.base()).toBe(before); expect(ctx.store.images.all()).toEqual([]); expect(calls).toBe(0);
  });
  it('round-trips binary assets and remaps image, entity, chapter and reference IDs in backups', async () => {
    const ctx = setup(); const image = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1', chapterId: ctx.chapter.id }); await until(() => ctx.store.images.get(image.image.id)?.status === 'completed');
    const edited = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1', chapterId: ctx.chapter.id, referenceImageId: image.image.id, instruction: '把裙子改成红色' }); await until(() => ctx.store.images.get(edited.image.id)?.status === 'completed');
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id)); const list = ctx.service.list(restored.mainBranchId, true);
    expect(list).toHaveLength(2); expect(list[1].referenceImageId).toBe(list[0].id); expect(list[0].id).not.toBe(image.image.id); expect(list[0].entityId).not.toBe('character-1'); expect(list[0].chapterId).not.toBe(ctx.chapter.id);
    expect(ctx.service.content(restored.mainBranchId, list[0].id, true).bytes).toEqual(png);
    const oldBackup = ctx.store.exportProject(ctx.project.id) as any; delete oldBackup.images;
    for (const revision of oldBackup.revisions) { revision.state = ctx.store.revisionState(revision.revision.id); delete revision.state.imageIds; delete revision.state.activeImageIds; delete revision.snapshot; }
    expect(ctx.store.restoreProject(oldBackup).id).not.toBe(ctx.project.id);
    const broken = ctx.store.exportProject(ctx.project.id) as any; broken.images[0].contentBase64 = Buffer.from('<svg/>').toString('base64'); expect(() => ctx.store.restoreProject(broken)).toThrow('不是 PNG');
  });
  it('preserves optimized material, parameters and multiple character references in project backups', async () => {
    const ctx = setup(); const added = ctx.store.state(ctx.branchId); added.entities.push({ ...character('character-2', '程川'), aliases: [] }); ctx.store.commit(ctx.branchId, ctx.base(), added, '第二人物');
    const sceneText = ctx.store.chapter(ctx.branchId, ctx.chapter.id).text;
    const first = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); const second = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-2' }); await until(() => [first.image.id, second.image.id].every(id => ctx.store.images.get(id)?.status === 'completed'));
    const scene: StoryImage = { id: 'multi-reference-cg', projectId: ctx.project.id, branchId: ctx.branchId, baseRevisionId: ctx.base(), kind: 'cg', status: 'completed', title: '双人CG', prompt: 'optimized cinematic two character scene', material: '原始剧情与人物资料', instruction: '两人共同望向远方', promptStatus: 'completed', optimizedAt: '2026-10-04T10:00:00Z', sourceText: sceneText, chapterId: ctx.chapter.id, referenceImageIds: [first.image.id, second.image.id], referenceEntityIds: ['character-1', 'character-2'], referenceCharacters: [{ entityId: 'character-1', imageId: first.image.id, name: '林月' }, { entityId: 'character-2', imageId: second.image.id, name: '程川' }], generationParameters: { model: 'gemini-3.1-flash-image-preview', protocol: 'gemini', aspectRatio: '16:9', imageSize: '1K', systemInstruction: '保持作品美术风格', temperature: 0.4, topP: 0.8, topK: 50, seed: 11, maxOutputTokens: 2048, thinkingLevel: 'high', includeThoughts: true }, automatic: false, visibility: 'public', createdAt: '', updatedAt: '', mimeType: 'image/png' };
    const state = ctx.store.state(ctx.branchId); state.imageIds!.push(scene.id); state.activeImageIds!.push(scene.id); ctx.store.commit(ctx.branchId, ctx.base(), state, '优化CG登记', revisionId => { scene.baseRevisionId = revisionId; ctx.store.images.insert(scene, { bytes: png, mimeType: 'image/png' }); });
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id)); const assets = ctx.store.images.all(restored.id); const restoredScene = assets.find(image => image.kind === 'cg')!; const portraits = assets.filter(image => image.kind === 'portrait');
    expect(restoredScene).toMatchObject({ prompt: scene.prompt, material: scene.material, instruction: scene.instruction, promptStatus: 'completed', optimizedAt: scene.optimizedAt, generationParameters: scene.generationParameters });
    expect(restoredScene.referenceImageIds).toEqual(portraits.map(image => image.id)); expect(restoredScene.referenceEntityIds).toEqual(portraits.map(image => image.entityId)); expect(restoredScene.referenceCharacters?.map(character => character.imageId)).toEqual(restoredScene.referenceImageIds); expect(restoredScene.referenceCharacters?.map(character => character.entityId)).toEqual(restoredScene.referenceEntityIds); expect(restoredScene.chapterId).not.toBe(scene.chapterId); expect(restoredScene.sourceText).toBe(sceneText);
    expect(ctx.store.images.visible(restoredScene, ctx.store.state(restored.mainBranchId), false)).toBe(true);
    const mismatched = ctx.store.exportProject(ctx.project.id) as any; mismatched.images.find((asset: any) => asset.image.id === scene.id).image.referenceCharacters[0].entityId = 'character-2'; expect(() => ctx.store.restoreProject(mismatched)).toThrow('身份不匹配');
    const changed = ctx.store.state(restored.mainBranchId); changed.entities.find(entity => entity.id === restoredScene.referenceEntityIds![1])!.visibility = 'secret'; ctx.store.commit(restored.mainBranchId, ctx.store.getBranch(restored.mainBranchId).revisionId, changed, '参考人物秘密');
    expect(ctx.store.view(restored.mainBranchId).state.imageIds).not.toContain(restoredScene.id); expect(() => ctx.service.content(restored.mainBranchId, restoredScene.id)).toThrow('不包含');
  });
  it('accepts shared reference graphs and rejects missing, duplicate or circular references in backups', async () => {
    const ctx = setup(); const original = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => ctx.store.images.get(original.image.id)?.status === 'completed');
    const first: StoryImage = { ...ctx.store.images.get(original.image.id)!, id: 'reference-child-1', referenceImageIds: [original.image.id] }; const second: StoryImage = { ...first, id: 'reference-child-2' }; const top: StoryImage = { ...first, id: 'reference-top', referenceImageIds: [first.id, second.id] };
    const state = ctx.store.state(ctx.branchId); state.imageIds!.push(first.id, second.id, top.id); state.activeImageIds = [top.id]; ctx.store.commit(ctx.branchId, ctx.base(), state, '共享参考图', revisionId => { for (const image of [first, second, top]) { image.baseRevisionId = revisionId; ctx.store.images.insert(image, { bytes: png, mimeType: 'image/png' }); } });
    expect(ctx.store.images.visible(top, ctx.store.state(ctx.branchId), false)).toBe(true); expect(ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id)).id).not.toBe(ctx.project.id);
    const missing = ctx.store.exportProject(ctx.project.id) as any; missing.images.find((asset: any) => asset.image.id === top.id).image.referenceImageIds = ['does-not-exist']; expect(() => ctx.store.restoreProject(missing)).toThrow('图片关联');
    const duplicate = ctx.store.exportProject(ctx.project.id) as any; duplicate.images.find((asset: any) => asset.image.id === top.id).image.referenceImageIds = [first.id, first.id]; expect(() => ctx.store.restoreProject(duplicate)).toThrow('图片关联');
    const cycle = ctx.store.exportProject(ctx.project.id) as any; cycle.images.find((asset: any) => asset.image.id === first.id).image.referenceImageIds = [top.id]; expect(() => ctx.store.restoreProject(cycle)).toThrow('循环参考');
  });
  it('remaps automatic illustration context in recoverable writer jobs', () => {
    const ctx = setup(); const time = new Date().toISOString();
    const job = { id: 'writer-context', projectId: ctx.project.id, branchId: ctx.branchId, kind: 'generate', status: 'paused', baseRevisionId: ctx.base(), progress: 0, total: 1, message: 'paused', inputTokens: 0, outputTokens: 0, createdAt: time, updatedAt: time, payload: { imageStartingEntityIds: ['character-1'], imagesRequestedFor: ctx.chapter.id, writingImageRequests: [{ kind: 'portrait', name: '林月', description: '' }] } };
    ctx.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, ctx.branchId, ctx.project.id, job.status, JSON.stringify(job));
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id)); const row = ctx.store.db.prepare('SELECT data FROM jobs WHERE project_id=?').get(restored.id)!; const recovered = JSON.parse(String(row.data)); const state = ctx.store.state(restored.mainBranchId);
    expect(recovered.payload.imageStartingEntityIds).toEqual([state.entities[0].id]); expect(recovered.payload.imagesRequestedFor).toBe(state.chapters[0].id); expect(recovered.payload.writingImageRequests[0].name).toBe('林月');
  });
  it('keeps the current chosen variant until selection, preserves other branches and restores deletion by rollback', async () => {
    const ctx = setup(); const first = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => ctx.store.images.get(first.image.id)?.status === 'completed');
    const second = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => ctx.store.images.get(second.image.id)?.status === 'completed');
    expect(ctx.service.list(ctx.branchId).map(image => image.id)).toEqual([first.image.id]); expect(ctx.service.list(ctx.branchId, true).map(image => image.active)).toEqual([true, false]); expect(ctx.service.content(ctx.branchId, second.image.id, true).bytes).toEqual(png); expect(ctx.store.images.get(first.image.id)?.active).toBeUndefined();
    const selected = ctx.service.setActive(ctx.branchId, second.image.id, ctx.base(), true); expect(selected.view.state.activeImageIds).toEqual([second.image.id]); expect(selected.images.map(image => image.active)).toEqual([false, true]);
    const fork = ctx.store.fork(ctx.branchId, { baseRevisionId: ctx.base(), name: '保留图片的旁支' }); const beforeDelete = ctx.base(); const removed = ctx.service.delete(ctx.branchId, second.image.id, beforeDelete);
    expect(removed.view.state.activeImageIds).toEqual([]); expect(removed.images).toHaveLength(1); expect(ctx.service.list(ctx.branchId)).toEqual([]); expect(() => ctx.service.content(ctx.branchId, second.image.id, true)).toThrow('不包含'); expect(ctx.store.images.content(second.image.id)?.bytes).toEqual(png); expect(ctx.service.list(fork.branch.id).map(image => image.id)).toEqual([second.image.id]);
    ctx.store.rollback(ctx.branchId, { baseRevisionId: ctx.base(), revisionId: beforeDelete }); expect(ctx.service.list(ctx.branchId).map(image => image.id)).toEqual([second.image.id]);
  });
  it('preserves explicit all-off choices and validates remapped active image IDs in backups', async () => {
    const ctx = setup(); const image = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => ctx.store.images.get(image.image.id)?.status === 'completed'); ctx.service.setActive(ctx.branchId, image.image.id, ctx.base(), false);
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id)); expect(ctx.store.state(restored.mainBranchId).activeImageIds).toEqual([]); expect(ctx.service.list(restored.mainBranchId)).toEqual([]); expect(ctx.service.list(restored.mainBranchId, true)).toHaveLength(1);
    ctx.service.setActive(ctx.branchId, image.image.id, ctx.base(), true); const withActive = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id)); const activeIds = ctx.store.state(withActive.mainBranchId).activeImageIds!; expect(activeIds).toHaveLength(1); expect(activeIds[0]).not.toBe(image.image.id); expect(ctx.store.state(withActive.mainBranchId).imageIds).toContain(activeIds[0]);
    for (const selection of [['missing'], [image.image.id, image.image.id]]) {
      const invalid = ctx.store.exportProject(ctx.project.id) as any; const current = invalid.revisions[0]; current.state = ctx.store.revisionState(current.revision.id); delete current.snapshot; current.state.activeImageIds = selection; expect(() => ctx.store.restoreProject(invalid)).toThrow('启用图片引用');
    }
  });
  it('transfers the first pending selection when retrying but respects an explicitly disabled first image', async () => {
    let calls = 0; const ctx = setup(async () => { if (++calls === 1) throw new Error('first pixel failure'); return { bytes: png, mimeType: 'image/png' }; });
    const first = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => ctx.store.images.get(first.image.id)?.status === 'failed'); const retry = ctx.service.retry(ctx.branchId, first.image.id, ctx.base()); await until(() => ctx.store.images.get(retry.image.id)?.status === 'completed'); expect(ctx.service.list(ctx.branchId).map(image => image.id)).toEqual([retry.image.id]);
    ctx.service.setActive(ctx.branchId, retry.image.id, ctx.base(), false); const next = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => ctx.store.images.get(next.image.id)?.status === 'completed'); expect(ctx.service.list(ctx.branchId)).toEqual([]);
  });
  it('retains automatic CG art direction while reoptimizing after its chosen portrait is disabled', async () => {
    let calls = 0; const inputs: Parameters<ImagePromptOptimizer>[1][] = [];
    const optimizer: ImagePromptOptimizer = async (_settings, input) => { inputs.push(structuredClone(input)); return { prompt: 'OPTIMIZED_CG_ART_DIRECTION', referenceEntityIds: input.characters.filter(character => character.imageId).map(character => character.entityId), parameters: {} }; };
    const ctx = setup(async () => { if (++calls === 2) throw new Error('CG pixel failure'); return { bytes: png, mimeType: 'image/png' }; }, optimizer);
    const portrait = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => ctx.store.images.get(portrait.image.id)?.status === 'completed');
    const generated = ctx.service.generateAutomatic(ctx.branchId, ctx.base(), ctx.chapter.id, [{ kind: 'cg', description: '仰角构图，突出阳光映照在裙摆上。', sourceText: '林月走进庭院。' }], [])!; const imageId = generated.images[0].id; await until(() => ctx.store.images.get(imageId)?.status === 'failed'); const originalMaterial = ctx.store.images.get(imageId)!.material;
    expect(originalMaterial).toContain('仰角构图'); ctx.service.setActive(ctx.branchId, portrait.image.id, ctx.base(), false); const retry = ctx.service.retry(ctx.branchId, imageId, ctx.base()); await until(() => ctx.store.images.get(retry.image.id)?.status === 'completed');
    expect(inputs).toHaveLength(3); expect(inputs[2].material).toContain('仰角构图'); expect(inputs[2].characters.every(character => !character.imageId)).toBe(true); expect(ctx.store.images.get(retry.image.id)?.material).toBe(originalMaterial); expect(ctx.store.images.get(retry.image.id)?.referenceImageIds).toEqual([]);
  });
  it('pauses interrupted requests across restart without repeating generation', async () => {
    const ctx = setup(); ctx.store.images.insert({ id: 'interrupted', projectId: ctx.project.id, branchId: ctx.branchId, baseRevisionId: ctx.base(), kind: 'map', status: 'running', title: 'interrupted', prompt: '', automatic: false, visibility: 'secret', createdAt: '', updatedAt: '' });
    let calls = 0; const recovered = new ImageService(ctx.store, () => ctx.settings, async () => { calls++; return { bytes: png, mimeType: 'image/png' }; });
    expect(ctx.store.images.get('interrupted')?.status).toBe('paused'); expect(calls).toBe(0); await recovered.close();
  });
  it('stops requests before deleting every project asset and rejects new work during deletion', async () => {
    let released = false; let started = false;
    const ctx = setup(async (_provider, _config, _prompt, signal) => { started = true; await new Promise<void>(resolve => signal!.addEventListener('abort', () => { released = true; resolve(); }, { once: true })); return { bytes: png, mimeType: 'image/png' }; });
    ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => started);
    const deletion = ctx.service.deleteProject(ctx.project.id, async () => { expect(released).toBe(true); await new Promise(resolve => setTimeout(resolve, 5)); ctx.store.deleteProject(ctx.project.id); });
    expect(() => ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' })).toThrow('正在删除');
    await deletion; expect(ctx.store.images.all()).toEqual([]); expect(ctx.store.listProjects()).toEqual([]);
  });
  it('starts the deletion callback before an image provider acknowledges cancellation', async () => {
    let release!: () => void; const ctx = setup(async () => { await new Promise<void>(resolve => { release = resolve; }); return { bytes: png, mimeType: 'image/png' }; });
    ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'character-1' }); await until(() => Boolean(release));
    let lockStarted = false; const deletion = ctx.service.deleteProject(ctx.project.id, async () => { lockStarted = true; ctx.store.deleteProject(ctx.project.id); });
    expect(lockStarted).toBe(true); expect(ctx.store.images.all()).toEqual([]); release(); await deletion; expect(ctx.store.images.all()).toEqual([]);
  });
  it('applies session, author view and same-origin boundaries to illustration routes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-image-api-')); const ctx = await buildApp({ dataDir: directory, startEngine: false });
    cleanup.push(async () => { await ctx.app.close(); rmSync(directory, { recursive: true, force: true }); });
    const project = ctx.store.createProject({ title: 'API测试' }); const branchId = project.mainBranchId; const baseRevisionId = ctx.store.getBranch(branchId).revisionId;
    const unauthenticated = await ctx.app.inject({ url: `/api/branches/${branchId}/images` }); expect(unauthenticated.statusCode).toBe(401);
    const auth = await ctx.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'fixture-image-password' } }); const cookies = { session: auth.cookies.find(item => item.name === 'session')!.value };
    for (const path of [`/api/branches/${branchId}/images`, `/api/branches/${branchId}/images/missing/retry`, `/api/branches/${branchId}/images/missing/cancel`]) expect((await ctx.app.inject({ method: 'POST', url: path, cookies, payload: { baseRevisionId, kind: 'map' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/branches/${branchId}/images?view=author`, cookies, headers: { origin: 'https://untrusted.invalid' }, payload: { baseRevisionId, kind: 'map' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/branches/${branchId}/images?view=author`, cookies, payload: { baseRevisionId, kind: 'map' } })).statusCode).toBe(400);
    const image = { id: 'private-image', projectId: project.id, branchId, baseRevisionId, kind: 'map' as const, status: 'completed' as const, title: 'private', prompt: '秘密资料', automatic: false, visibility: 'secret' as const, createdAt: '', updatedAt: '', mimeType: 'image/png' as const };
    const state = ctx.store.state(branchId); state.imageIds = [image.id]; ctx.store.commit(branchId, baseRevisionId, state, 'fixture image', revisionId => { image.baseRevisionId = revisionId; ctx.store.images.insert(image, { bytes: png, mimeType: 'image/png' }); });
    expect((await ctx.app.inject({ url: `/api/branches/${branchId}/images`, cookies })).json()).toEqual([]);
    expect((await ctx.app.inject({ url: `/api/branches/${branchId}/images/private-image/content`, cookies })).statusCode).toBe(404);
    const response = await ctx.app.inject({ url: `/api/branches/${branchId}/images/private-image/content?view=author`, cookies }); expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toBe('image/png'); expect(response.rawPayload).toEqual(png); expect(response.headers['x-content-type-options']).toBe('nosniff');
    const baseSelection = ctx.store.getBranch(branchId).revisionId;
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/branches/${branchId}/images/private-image/active`, cookies, payload: { baseRevisionId: baseSelection, active: false } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/branches/${branchId}/images/private-image`, cookies, payload: { baseRevisionId: baseSelection } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/branches/${branchId}/images/private-image/active?view=author`, cookies, payload: { baseRevisionId: 'outdated', active: false } })).statusCode).toBe(409);
    const disabled = await ctx.app.inject({ method: 'PUT', url: `/api/branches/${branchId}/images/private-image/active?view=author`, cookies, payload: { baseRevisionId: baseSelection, active: false } }); expect(disabled.statusCode).toBe(200); expect(disabled.json().view.state.activeImageIds).toEqual([]); expect(disabled.json().images[0].active).toBe(false);
    const deleted = await ctx.app.inject({ method: 'DELETE', url: `/api/branches/${branchId}/images/private-image?view=author`, cookies, payload: { baseRevisionId: disabled.json().view.branch.revisionId } }); expect(deleted.statusCode).toBe(200); expect(deleted.json().images).toEqual([]); expect(ctx.store.images.content(image.id)?.bytes).toEqual(png); expect((await ctx.app.inject({ url: `/api/branches/${branchId}/images/private-image/content?view=author`, cookies })).statusCode).toBe(404);
  });
});
