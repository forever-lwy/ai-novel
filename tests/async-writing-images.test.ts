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
const cg = (names: string[] = []): WritingImageRequest => ({ kind: 'cg', sourceText: scene, description: '林舟与城外战场', prompt: '林舟身穿青袍立于城门，眺望城外战场，日光，广角构图。', referenceNames: names });
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

function harness(requests: WritingImageRequest[] = [cg()], text = prose) {
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
      request.onTextDelta?.(text);
      if (first) for (const image of requests) {
        const tool = request.tools!.find(tool => tool.name === (image.kind === 'portrait' ? 'generate_character_portrait' : 'generate_scene_cg'))!;
        await tool.execute(image.kind === 'portrait' ? { name: image.name, description: image.description } : { prompt: image.prompt, sourceText: image.sourceText, referenceNames: image.referenceNames });
      }
      if (first) await interruptible(writing.promise, request.signal);
      return { text, inputTokens: 2, outputTokens: 3 };
    }),
    generateStructured: vi.fn(async (_provider, _request, validate) => ({ value: validate(extraction), inputTokens: 2, outputTokens: 3 })),
  };
  const engine = new StoryEngine(store, () => settings, models, images); engine.start();
  cleanups.push(async () => { await engine.close(); await images.close(); store.close(); });
  const start = () => engine.enqueue(branchId, 'generate', { title: '城门', mode: 'original', instruction: '继续写作', baseRevisionId: store.getBranch(branchId).revisionId });
  const saved = () => engine.listJobs(project.id).filter(job => job.kind === 'extract').some(job => job.status === 'completed') && engine.listJobs(project.id).every(job => job.status === 'completed');
  return { store, project, branchId, settings, generator, optimizer, images, engine, models, writing, start, saved, request: () => textRequest! };
}

describe('images run alongside the writer', () => {
  it('rejects an unmatched scene before charging for pixels and lets the model correct its quote', async () => {
    const ctx = harness([]); const job = ctx.start();
    await until(() => Boolean(ctx.request()?.tools));
    const tool = ctx.request().tools!.find(tool => tool.name === 'generate_scene_cg')!;
    const rejected = await tool.execute({ sourceText: '没有输出过的城外场景。', prompt: '城外场景' });
    expect(rejected).toMatchObject({ status: 'rejected', error: expect.stringContaining('本次没有启动生图') });
    expect(ctx.store.images.all()).toEqual([]); expect(ctx.generator).not.toHaveBeenCalled();
    const pending = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data)) as Job;
    expect(pending.payload.imageRequests).toEqual([]);
    expect(await tool.execute({ sourceText: scene, prompt: cg().prompt })).toMatchObject({ status: 'requested' });
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed');
    ctx.writing.resolve(); await until(ctx.saved);
    expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ status: 'completed', bindingStatus: 'bound' });
    expect(ctx.generator).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'stale'] as const)('adopts the same %s pixels when a source quote double-escapes paragraph breaks', async status => {
    const escaped = prose.replace(/\n/g, '\\n');
    const ctx = harness([{ ...cg(), sourceText: escaped }]); const job = ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed');
    const id = ctx.images.list(ctx.branchId, true)[0].id;
    // Repeating the same scene with real rather than escaped line breaks must
    // reuse the earlier intent instead of starting another billable image.
    expect(await ctx.request().tools!.find(tool => tool.name === 'generate_scene_cg')!.execute({ sourceText: prose, prompt: cg().prompt })).toMatchObject({ status: 'requested', message: expect.stringContaining('同一人物或场景') });
    expect(ctx.images.list(ctx.branchId, true)).toHaveLength(1);
    if (status === 'stale') {
      const old = ctx.store.images.get(id)!;
      old.status = 'stale'; old.error = '正文或资料中未能核对这张图片的场景、人物或参考图，请核对后手动重新生成';
      ctx.store.images.update(old);
      expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ status: 'completed', bindingStatus: 'pending', active: false, error: expect.stringContaining('图片未关联') });
      expect(ctx.images.list(ctx.branchId, true)[0].url).toBeDefined();
      expect(ctx.images.content(ctx.branchId, id, true).bytes).toEqual(png);
      expect(ctx.images.contentTag(ctx.branchId, id)).toBeDefined();
      expect(ctx.store.images.get(id)?.status).toBe('stale');
      expect(ctx.images.list(ctx.branchId, false)).toEqual([]);
    }
    ctx.writing.resolve(); await until(ctx.saved);
    const image = ctx.images.list(ctx.branchId, true)[0];
    expect(image).toMatchObject({ id, status: 'completed', bindingStatus: 'bound', sourceText: prose, selection: { start: 0, end: prose.length }, active: true });
    expect(ctx.images.content(ctx.branchId, id, true).bytes).toEqual(png);
    expect(ctx.generator).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data)) as Job;
    expect((saved.payload.imageRequests as WritingImageRequest[])[0].sourceText).toBe(escaped);
  });

  it('preserves a literal backslash-n that is genuinely in the quoted prose', async () => {
    const literal = '路牌上写着字符 \\n，旁边是城门。';
    const text = `${prose}\n${literal}`;
    const ctx = harness([{ ...cg(), sourceText: literal }], text); ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed');
    ctx.writing.resolve(); await until(ctx.saved);
    expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ status: 'completed', bindingStatus: 'bound', sourceText: literal, selection: { start: text.indexOf(literal), end: text.length } });
    expect(ctx.generator).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a changed quote', `${prose.replace(/\n/g, '\\n')}这里是捏造的场景。`, prose],
    ['an ambiguous decoded quote', prose.replace(/\n/g, '\\n'), `${prose}\n${prose}`],
  ])('keeps completed pixels viewable but unbound for %s', async (_name, sourceText, text) => {
    const ctx = harness([{ ...cg(), sourceText: text }], text); ctx.start();
    await until(() => ctx.images.list(ctx.branchId, true)[0]?.status === 'completed');
    const id = ctx.images.list(ctx.branchId, true)[0].id;
    // Final association independently checks persisted evidence, including
    // legacy requests that predate the early quote guard.
    const draft = ctx.store.images.get(id)!; draft.sourceText = sourceText; ctx.store.images.update(draft);
    ctx.writing.resolve(); await until(ctx.saved);
    expect(ctx.images.list(ctx.branchId, true)[0]).toMatchObject({ id, status: 'completed', bindingStatus: 'pending', active: false, error: expect.stringContaining('图片未关联') });
    expect(ctx.images.list(ctx.branchId, true)[0].error).not.toContain('版本');
    expect(ctx.images.list(ctx.branchId, true)[0].url).toBeDefined();
    expect(ctx.images.content(ctx.branchId, id, true).bytes).toEqual(png);
    expect(ctx.store.state(ctx.branchId).imageIds ?? []).toEqual([]);
    expect(() => ctx.images.setActive(ctx.branchId, id, ctx.store.getBranch(ctx.branchId).revisionId, true)).toThrow('图片尚未关联');
    expect(ctx.generator).toHaveBeenCalledTimes(1);
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
    const independent = { ...cg([]), sourceText: prose.split('\n')[0], prompt: 'INDEPENDENT 空城门与晨光' };
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
