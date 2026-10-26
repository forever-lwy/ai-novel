import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import type { Job, StoryImage } from '../shared/types.js';

const fixtures: { store: Store; directory: string }[] = [];
afterEach(() => { for (const { store, directory } of fixtures.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); } });

function fixture(withPortrait = false) {
  const directory = mkdtempSync(join(tmpdir(), 'novel-placement-backup-')); const store = new Store(directory);
  fixtures.push({ store, directory });
  const project = store.createProject({ title: 'CG 独立定位备份' }); const branchId = project.mainBranchId;
  const chapter = store.putChapter('城门', '旅人来到城门。\n夕阳照亮了城墙。'); chapter.status = 'ready';
  const state = store.state(branchId); state.chapters.push(chapter); state.imageIds = ['scene']; state.activeImageIds = ['scene'];
  const base = store.getBranch(branchId).revisionId; const date = new Date().toISOString();
  const scene: StoryImage = { id: 'scene', projectId: project.id, branchId, baseRevisionId: base, kind: 'cg', status: 'queued', title: '城门夕阳', prompt: '夕阳下的城门', automatic: true, visibility: 'secret', publicMaterial: false, createdAt: date, updatedAt: date, writingJobId: 'writer', bindingStatus: 'bound', chapterId: chapter.id, sceneDescription: '旅人在夕阳下抵达城门', placementStatus: 'pending', ...(withPortrait ? { dependencyImageIds: ['portrait'] } : {}) };
  const revision = store.commit(branchId, base, state, '保存正文与章节插画', revisionId => store.images.insert({ ...scene, baseRevisionId: revisionId })).branch.revisionId;
  const writing: Job = { id: 'writer', projectId: project.id, branchId, baseRevisionId: revision, kind: 'generate', status: 'completed', progress: 1, total: 1, message: '完成', inputTokens: 0, outputTokens: 0, createdAt: date, updatedAt: date, payload: { generatedChapterId: chapter.id } };
  const placement: Job = { ...writing, id: 'placement', kind: 'image-placement', status: 'running', progress: 0, payload: { placementChapterId: chapter.id, imageIds: ['scene'], writingJobId: writing.id } };
  for (const job of [writing, placement]) store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, branchId, project.id, job.status, JSON.stringify(job));
  if (withPortrait) store.images.insert({ ...scene, id: 'portrait', baseRevisionId: base, kind: 'portrait', title: '旅人', chapterId: undefined, sceneDescription: undefined, placementStatus: undefined, bindingStatus: 'pending', pendingEntityName: '旅人', dependencyImageIds: undefined });
  store.outputs.create({ jobId: placement.id, projectId: project.id, branchId, baseRevisionId: revision, stage: 'image-placement', chapterId: chapter.id }, { text: '{"matches":[]}', rawResponse: '{"matches":[]}', inputTokens: 2, outputTokens: 2 });
  return { store, project, branchId, chapter, backup: () => store.exportProject(project.id) };
}

describe('independent CG placement backup', () => {
  it('restores chapter-only images and remaps the placement owner, chapter, image and output without retrying', () => {
    const ctx = fixture(); const restored = ctx.store.restoreProject(ctx.backup());
    const jobs = ctx.store.db.prepare('SELECT data FROM jobs WHERE project_id=?').all(restored.id).map(row => JSON.parse(String(row.data)) as Job);
    const placement = jobs.find(job => job.kind === 'image-placement')!; const writing = jobs.find(job => job.kind === 'generate')!;
    const scene = ctx.store.images.all(restored.id)[0]; const chapter = ctx.store.state(restored.mainBranchId).chapters[0];
    expect(placement).toMatchObject({ status: 'paused', payload: { writingJobId: writing.id, placementChapterId: chapter.id, imageIds: [scene.id] } });
    expect(scene).toMatchObject({ status: 'paused', bindingStatus: 'bound', chapterId: chapter.id, sceneDescription: '旅人在夕阳下抵达城门', placementStatus: 'pending' });
    expect(scene.sourceText).toBeUndefined(); expect(scene.selection).toBeUndefined();
    expect(scene.id).not.toBe('scene'); expect(placement.id).not.toBe('placement');
    expect(ctx.store.outputs.all(restored.id)[0]).toMatchObject({ jobId: placement.id, chapterId: chapter.id, stage: 'image-placement' });
    expect(() => ctx.store.restoreProject(ctx.store.exportProject(restored.id))).not.toThrow();
  });

  it('preserves a chapter-bound CG waiting for the same writing job pending portrait', () => {
    const ctx = fixture(true); const restored = ctx.store.restoreProject(ctx.backup());
    const images = ctx.store.images.all(restored.id); const portrait = images.find(image => image.kind === 'portrait')!;
    expect(images.find(image => image.kind === 'cg')).toMatchObject({ bindingStatus: 'bound', dependencyImageIds: [portrait.id] });
    expect(portrait.bindingStatus).toBe('pending');
  });

  it.each(['missing-image', 'duplicate-image', 'wrong-owner', 'wrong-chapter'] as const)('rejects malformed placement links: %s', mutation => {
    const ctx = fixture(); const backup = ctx.backup(); const placement = backup.jobs.find(job => job.kind === 'image-placement')!;
    if (mutation === 'missing-image') placement.payload.imageIds = ['absent'];
    if (mutation === 'duplicate-image') placement.payload.imageIds = ['scene', 'scene'];
    if (mutation === 'wrong-owner') placement.payload.writingJobId = placement.id;
    if (mutation === 'wrong-chapter') placement.payload.placementChapterId = 'absent';
    expect(() => ctx.store.restoreProject(backup)).toThrow(/定位任务关联|任务章节不存在/);
  });

  it('keeps validating exact prose evidence after a scene has been matched', () => {
    const ctx = fixture(); const backup = ctx.backup();
    Object.assign(backup.images[0].image, { placementStatus: 'matched', selection: { start: 0, end: 8 }, sourceText: '编造的原文' });
    expect(() => ctx.store.restoreProject(backup)).toThrow('CG 剧情引用无效');
  });

  it.each(['missing-chapter', 'wrong-chapter', 'wrong-kind'] as const)('rejects malformed pending chapter markers: %s', mutation => {
    const ctx = fixture(); const backup = ctx.backup(); const writing = backup.jobs.find(job => job.kind === 'generate')!;
    writing.payload.pendingCGChapterId = mutation === 'missing-chapter' ? 'absent' : ctx.chapter.id;
    if (mutation === 'wrong-chapter') writing.payload.generatedChapterId = undefined;
    if (mutation === 'wrong-kind') backup.jobs.find(job => job.kind === 'image-placement')!.payload.pendingCGChapterId = ctx.chapter.id;
    expect(() => ctx.store.restoreProject(backup)).toThrow(/任务章节不存在|待关联 CG 章节无效/);
  });
});
