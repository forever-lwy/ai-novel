import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { ImageService } from '../server/images.js';
import type { Job, Settings, StoryImage } from '../shared/types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function until(test: () => boolean) { await vi.waitFor(() => expect(test()).toBe(true), { interval: 5, timeout: 3000 }); }

function fixture(options: { orphanedMarker?: boolean; failBindingOnce?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'novel-placement-lifecycle-')); const store = new Store(directory);
  const project = store.createProject({ title: '插画定位生命周期' });
  const branchId = store.fork(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, name: '定位测试线' }).branch.id;
  const chapter = store.putChapter('城门', '旅人来到城门。'); chapter.status = 'ready';
  const base = store.getBranch(branchId).revisionId; const date = new Date().toISOString();
  const state = store.state(branchId); state.chapters.push(chapter); state.imageIds = ['scene']; state.activeImageIds = ['scene'];
  const image: StoryImage = { id: 'scene', projectId: project.id, branchId, baseRevisionId: base, kind: 'cg', status: 'cancelled', title: '城门', prompt: '', automatic: true, visibility: 'secret', writingJobId: 'writer', bindingStatus: 'bound', chapterId: chapter.id, sceneDescription: '旅人来到城门', placementStatus: 'pending', createdAt: date, updatedAt: date };
  const revision = store.commit(branchId, base, state, '保存正文和插画', revisionId => store.images.insert({ ...image, baseRevisionId: revisionId })).branch.revisionId;
  const writer: Job = { id: 'writer', projectId: project.id, branchId, baseRevisionId: revision, kind: 'generate', status: 'completed', progress: 1, total: 1, inputTokens: 0, outputTokens: 0, message: '完成', createdAt: date, updatedAt: date, payload: { generatedChapterId: chapter.id, ...(options.orphanedMarker ? { pendingCGChapterId: chapter.id } : {}) } };
  const placement: Job = { ...writer, id: 'placement', kind: 'image-placement', status: 'queued', progress: 0, payload: { placementChapterId: chapter.id, imageIds: ['scene'], writingJobId: 'writer' } };
  for (const job of options.orphanedMarker ? [writer] : [writer, placement]) store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, branchId, project.id, job.status, JSON.stringify(job));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const settings: Settings = { providers: [{ id: 'mock', name: '本地模拟', protocol: 'openai-chat', baseUrl: 'http://fixture.invalid', model: 'extractor', maxOutputTokens: 256, contextTokens: 10000 }], writingProviderId: 'mock', planningProviderId: 'mock', extractionProviderId: 'mock' };
  const generator = vi.fn(); const images = new ImageService(store, () => settings, generator);
  if (options.failBindingOnce) vi.spyOn(images, 'bindWritingChapter').mockImplementationOnce(() => { throw new Error('模拟本地插画关联保存失败'); });
  const models: TextModels = {
    generateText: vi.fn(),
    // Deliberately ignore AbortSignal, to verify that a late upstream reply is rejected.
    generateStructured: vi.fn(async (_provider, _request, validate) => { await gate; return { value: validate({ placements: [{ imageId: 'scene', paragraph: 1 }] }), inputTokens: 1, outputTokens: 1 }; }),
  };
  const engines: StoryEngine[] = [];
  const createEngine = () => { const engine = new StoryEngine(store, () => settings, models, images); engines.push(engine); engine.start(); return engine; };
  const engine = createEngine();
  cleanup.push(async () => { release(); await Promise.all(engines.map(value => value.close())); await images.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const job = () => JSON.parse(String(store.db.prepare("SELECT data FROM jobs WHERE branch_id=? AND json_extract(data,'$.kind')='image-placement' LIMIT 1").get(branchId)!.data)) as Job;
  return { store, project, branchId, chapter, engine, models, generator, createEngine, job, release };
}

it.each(['pause', 'cancel'] as const)('does not apply a delayed placement reply after %s', async action => {
  const ctx = fixture(); await until(() => ctx.models.generateStructured.mock.calls.length === 1);
  ctx.engine.action('placement', action); ctx.release();
  await until(() => ctx.store.outputs.list('placement')[0]?.status === 'invalid');
  expect(ctx.job().status).toBe(action === 'pause' ? 'paused' : 'cancelled');
  expect(ctx.store.images.get('scene')?.placementStatus).toBe('pending'); expect(ctx.store.images.get('scene')?.selection).toBeUndefined();
  expect(ctx.generator).not.toHaveBeenCalled(); expect(ctx.models.generateText).not.toHaveBeenCalled();
});

it('pauses an interrupted placement on restart and calls only the matcher after explicit resume', async () => {
  const ctx = fixture(); await until(() => ctx.models.generateStructured.mock.calls.length === 1);
  const closing = ctx.engine.close(); ctx.release(); await closing;
  const restarted = ctx.createEngine();
  expect(ctx.job().status).toBe('paused'); expect(ctx.models.generateStructured).toHaveBeenCalledTimes(1);
  restarted.action('placement', 'resume'); await until(() => ctx.job().status === 'completed');
  expect(ctx.store.images.get('scene')).toMatchObject({ placementStatus: 'matched', sourceText: '旅人来到城门。' });
  expect(ctx.models.generateStructured).toHaveBeenCalledTimes(2); expect(ctx.generator).not.toHaveBeenCalled();
});

it('lets a branch be deleted while only placement is running and rejects its late result', async () => {
  const ctx = fixture(); await until(() => ctx.models.generateStructured.mock.calls.length === 1);
  expect(() => ctx.engine.assertIdle(ctx.branchId)).not.toThrow();
  ctx.store.deleteBranch(ctx.branchId, ctx.store.getBranch(ctx.branchId).revisionId); ctx.release();
  await until(() => ['failed', 'stale'].includes(ctx.job().status));
  expect(ctx.store.images.get('scene')?.placementStatus).toBe('pending'); expect(ctx.store.images.get('scene')?.selection).toBeUndefined();
  expect(ctx.engine.listJobs(ctx.project.id)).toEqual([]);
  expect(() => ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id))).not.toThrow();
});

it('recovers a saved chapter marker into a paused matcher without any automatic model request', async () => {
  const ctx = fixture({ orphanedMarker: true });
  expect(ctx.job().status).toBe('paused'); expect(ctx.job().payload).toMatchObject({ placementChapterId: ctx.chapter.id, imageIds: ['scene'] });
  const writer = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get('writer')!.data)) as Job;
  expect(writer.payload.pendingCGChapterId).toBeUndefined(); expect(ctx.models.generateStructured).not.toHaveBeenCalled(); expect(ctx.generator).not.toHaveBeenCalled();
  expect(() => ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id))).not.toThrow();
});

it('keeps the chapter marker through a local binding failure and retries only local registration on restart', async () => {
  const ctx = fixture({ orphanedMarker: true, failBindingOnce: true });
  const first = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get('writer')!.data)) as Job;
  expect(first.payload.pendingCGChapterId).toBe(ctx.chapter.id); expect(first.payload.imageError).toContain('关联保存失败');
  expect(() => ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id))).not.toThrow();
  await ctx.engine.close(); ctx.createEngine();
  expect(ctx.job().status).toBe('paused');
  expect(ctx.models.generateStructured).not.toHaveBeenCalled(); expect(ctx.models.generateText).not.toHaveBeenCalled(); expect(ctx.generator).not.toHaveBeenCalled();
});
