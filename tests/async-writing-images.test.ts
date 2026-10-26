import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { ImageService } from '../server/images.js';
import { Store } from '../server/store.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import type { ImageGenerator } from '../server/image-provider.js';
import type { ExtractionResult, Job, ModelRequest, Settings, WritingImageRequest } from '../shared/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF4QAAAAASUVORK5CYII=', 'base64');
const content = { bytes: png, mimeType: 'image/png' as const };
const prose = '林舟身穿青色长袍走进城门。\n城外千军万马正在迎战。';
const scene = '城外千军万马正在迎战。';
const portrait: WritingImageRequest = { kind: 'portrait', name: '林舟', description: '青色长袍' };
const cg = (names: string[] = []): WritingImageRequest => ({ kind: 'cg', sceneDescription: '林舟与城外战场', description: '林舟与城外战场', prompt: '林舟身穿青袍立于城门，眺望城外战场，日光，广角构图。', referenceNames: names });
const extraction: ExtractionResult = { summary: '林舟进城。', entities: [{ kind: 'character', name: '林舟', aliases: [], description: '青色长袍', visibility: 'public', nameStatus: 'confirmed', facts: [{ text: '身穿青色长袍', attribute: 'appearance', temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 1, quote: '林舟身穿青色长袍走进城门。' }] }], relations: [], foreshadows: [] };
const cleanups: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); releases.push(resolve); return { promise, resolve }; }
async function until(done: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!done()) { if (Date.now() > deadline) throw new Error('异步生图状态等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function interruptible(promise: Promise<void>, signal?: AbortSignal) {
  if (!signal) return promise;
  let onAbort!: () => void;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { onAbort = () => reject(new Error('aborted')); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); })]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
afterEach(async () => { releases.splice(0).forEach(release => release()); for (const cleanup of cleanups.splice(0)) await cleanup(); });

function harness(requests: WritingImageRequest[] = [cg()], text = prose, options: { paragraph?: number | null; placementGate?: Promise<void>; extractionGate?: Promise<void>; extractionFailure?: boolean; placementFailure?: boolean } = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-writing-parallel-')));
  const project = store.createProject({ title: '并行绘图测试' }); const branchId = project.mainBranchId;
  const settings: Settings = { providers: [{ id: 'mock', name: '本地模拟', protocol: 'openai-chat', baseUrl: 'http://fixture.invalid/v1', model: 'text', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'mock', extractionProviderId: 'mock', imageSettings: { ...defaultImageSettings(), providerId: 'mock', model: 'picture', autoCG: true, autoPortrait: requests.some(request => request.kind === 'portrait') } };
  const generator = vi.fn<ImageGenerator>(async () => content);
  const optimizer = vi.fn(async (_settings, input) => ({ prompt: `PORTRAIT ${input.material}`, referenceEntityIds: [], parameters: {} }));
  const images = new ImageService(store, () => settings, generator, optimizer);
  const writing = gate(); let textRequest: ModelRequest | undefined; let turns = 0;
  const models: TextModels = {
    generateText: vi.fn(async (_provider, request) => {
      textRequest = request; const first = turns++ === 0;
      if (first) for (const image of requests) {
        const tool = request.tools!.find(tool => tool.name === (image.kind === 'portrait' ? 'generate_character_portrait' : 'generate_scene_cg'))!;
        await tool.execute(image.kind === 'portrait' ? { name: image.name, description: image.description } : { prompt: image.prompt, sceneDescription: image.sceneDescription, sourceText: image.sourceText, referenceNames: image.referenceNames });
      }
      request.onTextDelta?.(text);
      if (first) await interruptible(writing.promise, request.signal);
      return { text, inputTokens: 2, outputTokens: 3 };
    }),
    generateStructured: vi.fn(async (_provider, request, validate) => {
      if (request.system.includes('独立的插画定位任务')) {
        if (options.placementGate) await interruptible(options.placementGate, request.signal);
        if (options.placementFailure) throw new Error('模拟定位模型失败');
        const scenes = JSON.parse(request.prompt.split('\n')[1]) as { id: string }[];
        return { value: validate({ placements: scenes.map(image => ({ imageId: image.id, paragraph: options.paragraph === undefined ? 2 : options.paragraph })) }), inputTokens: 2, outputTokens: 3 };
      }
      if (options.extractionGate) await interruptible(options.extractionGate, request.signal);
      if (options.extractionFailure) throw new Error('模拟资料提取失败');
      return { value: validate(extraction), inputTokens: 2, outputTokens: 3 };
    }),
  };
  const engine = new StoryEngine(store, () => settings, models, images); engine.start();
  cleanups.push(async () => { await engine.close(); await images.close(); store.close(); });
  const start = () => engine.enqueue(branchId, 'generate', { title: '城门', mode: 'original', instruction: '继续写作', baseRevisionId: store.getBranch(branchId).revisionId });
  const saved = () => engine.listJobs(project.id).filter(job => job.kind === 'extract').some(job => job.status === 'completed') && engine.listJobs(project.id).every(job => job.status === 'completed');
  return { store, project, branchId, settings, generator, optimizer, images, engine, models, writing, start, saved, request: () => textRequest! };
}

describe('images run alongside the writer', () => {
  it('accepts a scene description before any prose exists and binds the same pixels after writing', async () => {
    const ctx = harness(); const job = ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed');
    const pending = ctx.images.list(ctx.branchId, true)[0];
    expect(pending).toMatchObject({ bindingStatus: 'pending', sceneDescription: '林舟与城外战场', placementStatus: 'pending' });
    expect(pending.sourceText).toBeUndefined(); expect(pending.selection).toBeUndefined();
    const savedJob = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data)) as Job;
    expect((savedJob.payload.imageRequests as WritingImageRequest[])[0].sourceText).toBeUndefined();
    ctx.writing.resolve(); await until(ctx.saved);
    expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ id: pending.id, status: 'completed', bindingStatus: 'bound', placementStatus: 'matched', sourceText: scene, selection: { start: prose.indexOf(scene), end: prose.length } });
    expect(ctx.generator).toHaveBeenCalledTimes(1); expect(ctx.optimizer).not.toHaveBeenCalled();
  });

  it('binds CGs to the chapter while material extraction and placement run independently', async () => {
    const extract = gate(); const placement = gate();
    const ctx = harness([cg()], prose, { extractionGate: extract.promise, placementGate: placement.promise }); ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed');
    ctx.writing.resolve();
    await until(() => ctx.engine.listJobs().some(job => job.kind === 'image-placement' && job.status === 'running') && ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'running'));
    const image = ctx.images.list(ctx.branchId, true)[0];
    expect(image).toMatchObject({ bindingStatus: 'bound', placementStatus: 'pending', active: true });
    expect(image.chapterId).toBe(ctx.store.state(ctx.branchId).chapters[0].id); expect(image.selection).toBeUndefined();
    const base = ctx.store.getBranch(ctx.branchId).revisionId;
    placement.resolve(); await until(() => ctx.engine.listJobs().some(job => job.kind === 'image-placement' && job.status === 'completed'));
    expect(ctx.store.getBranch(ctx.branchId).revisionId).toBe(base);
    expect(ctx.store.images.get(image.id)?.placementStatus).toBe('matched');
    expect(ctx.engine.listJobs().find(job => job.kind === 'extract')?.status).toBe('running');
    extract.resolve(); await until(ctx.saved);
    expect(ctx.generator).toHaveBeenCalledTimes(1);
  });

  it('keeps paid CGs bound and usable when no reliable paragraph matches', async () => {
    const ctx = harness([cg()], prose, { paragraph: null }); ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed');
    ctx.writing.resolve(); await until(ctx.saved);
    const image = ctx.images.list(ctx.branchId, true)[0];
    expect(image).toMatchObject({ status: 'completed', bindingStatus: 'bound', placementStatus: 'unmatched', active: true });
    expect(image.selection).toBeUndefined(); expect(image.sourceText).toBeUndefined();
    expect(ctx.images.content(ctx.branchId, image.id, true).bytes).toEqual(png);
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
    expect(ctx.store.images.all(restored.id)[0]).toMatchObject({ sceneDescription: image.sceneDescription, placementStatus: 'unmatched', bindingStatus: 'bound' });
    expect(ctx.generator).toHaveBeenCalledTimes(1);
  });

  it('matches positions even if the independent material extraction fails', async () => {
    const ctx = harness([cg()], prose, { extractionFailure: true }); ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed'); ctx.writing.resolve();
    await until(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'failed') && ctx.engine.listJobs().some(job => job.kind === 'image-placement' && job.status === 'completed'));
    expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ status: 'completed', bindingStatus: 'bound', placementStatus: 'matched', sourceText: scene, active: true });
    expect(ctx.generator).toHaveBeenCalledTimes(1);
  });

  it('preserves chapter binding and pixels when placement fails without retrying the drawing', async () => {
    const ctx = harness([cg()], prose, { placementFailure: true }); ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed'); ctx.writing.resolve();
    await until(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed') && ctx.engine.listJobs().some(job => job.kind === 'image-placement' && job.status === 'failed'));
    const image = ctx.images.list(ctx.branchId, true)[0];
    expect(image).toMatchObject({ status: 'completed', bindingStatus: 'bound', placementStatus: 'failed', active: true });
    expect(image.placementError).toContain('模拟定位模型失败'); expect(ctx.images.content(ctx.branchId, image.id, true).bytes).toEqual(png);
    expect(ctx.generator).toHaveBeenCalledTimes(1);
  });

  it('allows disabling a chapter-bound image during placement and preserves that choice', async () => {
    const placement = gate(); const ctx = harness([cg()], prose, { placementGate: placement.promise }); ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed'); ctx.writing.resolve();
    await until(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed') && ctx.engine.listJobs().some(job => job.kind === 'image-placement' && job.status === 'running'));
    const image = ctx.images.list(ctx.branchId, true)[0];
    ctx.images.setActive(ctx.branchId, image.id, ctx.store.getBranch(ctx.branchId).revisionId, false);
    const revision = ctx.store.getBranch(ctx.branchId).revisionId;
    placement.resolve(); await until(ctx.saved);
    expect(ctx.store.getBranch(ctx.branchId).revisionId).toBe(revision);
    expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ placementStatus: 'matched', active: false });
    expect(ctx.store.state(ctx.branchId).activeImageIds).not.toContain(image.id);
  });

  it('rejects placement metadata for a chapter that has been edited', async () => {
    const ctx = harness(); ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed'); ctx.writing.resolve(); await until(ctx.saved);
    const image = ctx.images.list(ctx.branchId, true)[0];
    ctx.store.saveChapter(ctx.branchId, { baseRevisionId: ctx.store.getBranch(ctx.branchId).revisionId, chapterId: image.chapterId, title: '修改后的城门', text: `${prose}\n作者补充。` });
    const revision = ctx.store.getBranch(ctx.branchId).revisionId;
    expect(() => ctx.images.applyScenePlacement(image.id, image.chapterId!, { start: 0, end: prose.indexOf('\n') })).toThrow('章节已修改');
    expect(ctx.store.getBranch(ctx.branchId).revisionId).toBe(revision);
    expect(ctx.store.images.get(image.id)?.sourceText).toBe(scene);
  });

  it.each(['redraw', 'retry'] as const)('keeps a manual %s chapter-bound when its original is still waiting for placement', async action => {
    const placement = gate(); const ctx = harness([cg()], prose, { placementGate: placement.promise }); ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed'); ctx.writing.resolve();
    await until(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed') && ctx.engine.listJobs().some(job => job.kind === 'image-placement' && job.status === 'running'));
    const original = ctx.images.list(ctx.branchId, true)[0]; const baseRevisionId = ctx.store.getBranch(ctx.branchId).revisionId;
    const next = action === 'redraw'
      ? ctx.images.generate(ctx.branchId, { baseRevisionId, kind: 'cg', chapterId: original.chapterId, sceneDescription: original.sceneDescription }).image
      : ctx.images.retry(ctx.branchId, original.id, baseRevisionId).image;
    await until(() => ctx.store.images.get(next.id)?.status === 'completed');
    expect(ctx.store.images.get(next.id)).toMatchObject({ chapterId: original.chapterId, sceneDescription: original.sceneDescription, placementStatus: 'unmatched' });
    expect(ctx.store.images.get(next.id)?.selection).toBeUndefined();
    placement.resolve(); await until(ctx.saved);
    expect(ctx.store.images.get(original.id)?.placementStatus).toBe('matched');
    expect(ctx.store.images.get(next.id)?.placementStatus).toBe('unmatched');
    expect(ctx.generator).toHaveBeenCalledTimes(2);
  });

  it('finishes a CG before the writer returns, without a chapter or story revision, then adopts that same asset', async () => {
    const ctx = harness(); const revision = ctx.store.getBranch(ctx.branchId).revisionId; const job = ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed');
    const image = ctx.images.list(ctx.branchId, true)[0];
    expect(ctx.engine.listJobs()[0].status).toBe('running'); expect(ctx.store.state(ctx.branchId).chapters).toEqual([]);
    expect(ctx.store.getBranch(ctx.branchId).revisionId).toBe(revision);
    expect(image).toMatchObject({ bindingStatus: 'pending', writingJobId: job.id, promptSource: 'writing', active: false });
    expect(image.chapterId).toBeUndefined(); expect(ctx.images.content(ctx.branchId, image.id, true).bytes).toEqual(png);
    expect(ctx.images.list(ctx.branchId, false)).toEqual([]); expect(ctx.optimizer).not.toHaveBeenCalled();
    const other = ctx.store.createProject({ title: '其他作品' }); expect(() => ctx.images.content(other.mainBranchId, image.id, true)).toThrow();
    ctx.writing.resolve(); await until(ctx.saved);
    expect(ctx.images.list(ctx.branchId, true)).toHaveLength(1);
    expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ id: image.id, bindingStatus: 'bound', status: 'completed', chapterId: ctx.store.state(ctx.branchId).chapters[0].id, active: true });
    expect(ctx.generator).toHaveBeenCalledTimes(1);
  });

  it('waits only for the requested portrait, leaving the writer and an unrelated CG free to finish', async () => {
    const independent = { ...cg([]), sceneDescription: '空城门与晨光', prompt: 'INDEPENDENT 空城门与晨光' };
    const ctx = harness([portrait, cg(['林舟']), independent]); const pixels = gate();
    ctx.generator.mockImplementation(async (_provider, _config, prompt, signal) => { if (prompt.startsWith('PORTRAIT')) await interruptible(pixels.promise, signal); return content; });
    ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true).some(image => image.writingPrompt === independent.prompt && image.status === 'completed'));
    const pending = ctx.images.list(ctx.branchId, true).find(image => image.writingReferenceNames?.includes('林舟'))!;
    const reference = ctx.images.list(ctx.branchId, true).find(image => image.kind === 'portrait')!;
    expect(pending).toMatchObject({ status: 'queued', dependencyImageIds: [reference.id] });
    expect(ctx.generator).toHaveBeenCalledTimes(2); expect(ctx.engine.listJobs()[0].status).toBe('running');
    // Backup in the middle of writing: dependencies and owner/request IDs must remap.
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
    const restoredImages = ctx.store.images.all(restored.id); const restoredPortrait = restoredImages.find(image => image.kind === 'portrait')!;
    expect(restoredPortrait.status).toBe('paused'); expect(restoredPortrait.id).not.toBe(reference.id);
    const restoredCG = restoredImages.find(image => image.writingReferenceNames?.includes('林舟'))!;
    expect(restoredCG).toMatchObject({ status: 'paused', dependencyImageIds: [restoredPortrait.id], bindingStatus: 'pending' });
    const restoredJob = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(restoredCG.writingJobId!)!.data)) as Job;
    expect(restoredJob.status).toBe('paused'); expect((restoredJob.payload.imageRequests as WritingImageRequest[]).some(request => request.imageId === restoredCG.id)).toBe(true);
    pixels.resolve(); await until(() => ctx.store.images.get(pending.id)?.status === 'completed');
    expect(ctx.generator.mock.calls.find(call => call[2].includes(cg().prompt!))?.[4]).toHaveLength(1);
    expect(ctx.engine.listJobs(ctx.project.id)[0].status).toBe('running');
    // Completed draft CG pixels and draft portrait references also survive restore.
    expect(() => ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id))).not.toThrow();
    ctx.writing.resolve(); await until(ctx.saved);
    const bound = ctx.store.images.get(pending.id)!; expect(bound.referenceCharacters?.[0]).toMatchObject({ imageId: reference.id, name: '林舟' });
    expect(bound.bindingStatus).toBe('bound'); expect(ctx.generator).toHaveBeenCalledTimes(3);
  });

  it('keeps the canonical binding when the image finishes after extraction and another chapter', async () => {
    const ctx = harness([portrait, cg(['林舟'])]); const pixels = gate();
    ctx.generator.mockImplementation(async (_provider, _config, prompt, signal) => { if (prompt.startsWith('PORTRAIT')) await interruptible(pixels.promise, signal); return content; });
    ctx.start(); await until(() => ctx.generator.mock.calls.length === 1);
    const ids = ctx.images.list(ctx.branchId, true).map(image => image.id);
    ctx.writing.resolve(); await until(ctx.saved);
    const chapterId = ctx.store.state(ctx.branchId).chapters[0].id;
    expect(ids.every(id => ctx.store.images.get(id)?.bindingStatus === 'bound')).toBe(true);
    ctx.start(); await until(() => ctx.store.state(ctx.branchId).chapters.length === 2 && ctx.saved());
    pixels.resolve(); await until(() => ids.every(id => ctx.store.images.get(id)?.status === 'completed'));
    expect(ids.every(id => ctx.store.images.get(id)?.chapterId === chapterId)).toBe(true);
    expect(ctx.store.images.get(ids.find(id => ctx.store.images.get(id)?.kind === 'cg')!)!).toMatchObject({ placementStatus: 'matched', sourceText: scene, selection: { start: prose.indexOf(scene), end: prose.length } });
    expect(ctx.generator).toHaveBeenCalledTimes(2); expect(() => ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id))).not.toThrow();
  });

  it.each(['cancel', 'pause'] as const)('stops draft images when writing is explicitly %s and ignores late pixels', async action => {
    const ctx = harness(); const pixels = gate();
    // Deliberately ignore abort to mimic a provider returning after cancellation.
    ctx.generator.mockImplementation(async () => { await pixels.promise; return content; });
    const job = ctx.start(); await until(() => ctx.generator.mock.calls.length === 1);
    const id = ctx.images.list(ctx.branchId, true)[0].id;
    ctx.engine.action(job.id, action); await until(() => ctx.store.images.get(id)?.status === 'stale');
    pixels.resolve(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(ctx.store.images.get(id)?.status).toBe('stale'); expect(ctx.store.images.content(id)).toBeUndefined();
    expect(ctx.store.state(ctx.branchId).chapters).toEqual([]); expect(ctx.generator).toHaveBeenCalledTimes(1);
  });

  it('fails a dependent CG after portrait cancellation without retrying or sending a reference-free substitute', async () => {
    const ctx = harness([portrait, cg(['林舟'])]); const pixels = gate();
    ctx.generator.mockImplementation(async (_provider, _config, _prompt, signal) => { await interruptible(pixels.promise, signal); return content; });
    ctx.start(); await until(() => ctx.generator.mock.calls.length === 1);
    const images = ctx.images.list(ctx.branchId, true); const reference = images.find(image => image.kind === 'portrait')!; const scene = images.find(image => image.kind === 'cg')!;
    ctx.images.cancel(ctx.branchId, reference.id);
    await until(() => ctx.store.images.get(scene.id)?.status === 'failed');
    expect(ctx.store.images.get(scene.id)?.error).toContain('参考图'); expect(ctx.generator).toHaveBeenCalledTimes(1);
    ctx.writing.resolve(); await until(ctx.saved);
    expect(ctx.store.images.get(reference.id)).toMatchObject({ bindingStatus: 'bound', status: 'cancelled' });
    expect(ctx.store.images.get(scene.id)).toMatchObject({ bindingStatus: 'bound', status: 'failed' });
    expect(ctx.generator).toHaveBeenCalledTimes(1);
    ctx.generator.mockResolvedValue(content);
    const portraitRetry = ctx.images.retry(ctx.branchId, reference.id, ctx.store.getBranch(ctx.branchId).revisionId).image;
    await until(() => ctx.store.images.get(portraitRetry.id)?.status === 'completed');
    const cgRetry = ctx.images.retry(ctx.branchId, scene.id, ctx.store.getBranch(ctx.branchId).revisionId).image;
    await until(() => ctx.store.images.get(cgRetry.id)?.status === 'completed');
    expect(ctx.store.images.get(cgRetry.id)?.referenceImageIds).toEqual([portraitRetry.id]);
    expect(ctx.generator).toHaveBeenCalledTimes(3);
  });

  it('preserves deletion of a draft image when prose is saved and during backup restore', async () => {
    const ctx = harness(); ctx.start(); await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed');
    const image = ctx.images.list(ctx.branchId, true)[0];
    ctx.images.delete(ctx.branchId, image.id, ctx.store.getBranch(ctx.branchId).revisionId);
    expect(ctx.images.list(ctx.branchId, true)).toEqual([]); ctx.writing.resolve(); await until(ctx.saved);
    expect(ctx.images.list(ctx.branchId, true)).toEqual([]); expect(ctx.generator).toHaveBeenCalledTimes(1);
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
    expect(ctx.store.images.all(restored.id)[0].bindingStatus).toBe('discarded'); expect(ctx.images.list(restored.mainBranchId, true)).toEqual([]);
  });

  it('rejects late results after rollback without losing saved prose on the retained branch', async () => {
    const ctx = harness(); const initial = ctx.store.getBranch(ctx.branchId).revisionId; const pixels = gate();
    ctx.generator.mockImplementation(async () => { await pixels.promise; return content; }); ctx.start();
    await until(() => ctx.generator.mock.calls.length === 1); ctx.writing.resolve(); await until(ctx.saved);
    const image = ctx.images.list(ctx.branchId, true)[0];
    ctx.store.rollback(ctx.branchId, { baseRevisionId: ctx.store.getBranch(ctx.branchId).revisionId, revisionId: initial });
    pixels.resolve(); await until(() => ctx.store.images.get(image.id)?.status === 'stale');
    expect(ctx.images.list(ctx.branchId, true)).toEqual([]); expect(ctx.store.images.content(image.id)).toBeUndefined(); expect(ctx.generator).toHaveBeenCalledTimes(1);
  });

  it('keeps drawing while an RPG job waits for the player to choose', async () => {
    const ctx = harness(); const pixels = gate();
    ctx.generator.mockImplementation(async (_provider, _config, _prompt, signal) => { await interruptible(pixels.promise, signal); return content; });
    const job = ctx.start(); await until(() => ctx.generator.mock.calls.length === 1);
    // Persist the same choice boundary used by ask_user, without making a second provider call.
    const saved = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data)) as Job;
    saved.status = 'paused'; saved.payload.rpgChoice = { id: 'choice', question: '前往哪里？', options: [{ id: 'a', text: '城门' }, { id: 'b', text: '街道' }] };
    ctx.store.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(saved.status, JSON.stringify(saved), saved.id);
    ctx.images.writingProgress(ctx.branchId); pixels.resolve();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed');
    expect(ctx.engine.listJobs()[0].status).toBe('paused'); expect(ctx.generator.mock.calls[0][3]?.aborted).toBe(false);
  });
});
