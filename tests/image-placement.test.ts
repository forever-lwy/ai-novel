import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { Store } from '../server/store.js';
import { ImageService } from '../server/images.js';
import { sceneParagraphs, scenePlacementRequest, parseScenePlacements } from '../server/image-placement.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import type { ModelRequest, Settings } from '../shared/types.js';

const prose = '林舟来到城门。\r\n\r\n他在雨中捡起一把钥匙。';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF4QAAAAASUVORK5CYII=', 'base64');
const extraction = { summary: '雨中拾起钥匙。', entities: [], relations: [], foreshadows: [] };
const cleanups: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); releases.push(resolve); return { promise, resolve }; }
async function until(test: () => boolean) { await vi.waitFor(() => expect(test()).toBe(true), { timeout: 5000, interval: 5 }); }
async function wait(promise: Promise<void>, signal?: AbortSignal) {
  let abort!: () => void;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { abort = () => reject(new Error('任务已停止')); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); })]); }
  finally { signal?.removeEventListener('abort', abort); }
}
afterEach(async () => { releases.splice(0).forEach(release => release()); for (const cleanup of cleanups.splice(0)) await cleanup(); });

function harness(options: { failPlacement?: boolean; failExtraction?: boolean; unmatched?: boolean; autoTitle?: boolean } = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-placement-')));
  const project = store.createProject({ title: '独立插画定位' }); const branch = project.mainBranchId;
  const settings: Settings = { providers: [{ id: 'local', name: '模拟', protocol: 'openai-chat', baseUrl: 'http://mock.invalid', model: 'writer', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'local', extractionProviderId: 'local', extractionModel: 'extractor', imageSettings: { ...defaultImageSettings(), providerId: 'local', model: 'picture', autoCG: true, autoPortrait: false } };
  const extractionGate = gate(); const placementGate = gate(); const requests: { model?: string; request: ModelRequest }[] = [];
  const generator = vi.fn(async () => ({ bytes: png, mimeType: 'image/png' as const }));
  const images = new ImageService(store, () => settings, generator);
  const models: TextModels = {
    generateText: vi.fn(async (_provider, request) => {
      // CG may be requested before any prose delta exists.
      await request.tools!.find(tool => tool.name === 'generate_scene_cg')!.execute({ prompt: '城门下的林舟俯身拾起钥匙，雨夜，侧面中景。', sceneDescription: '林舟在城门下的雨中捡起钥匙', referenceNames: [] });
      request.onTextDelta?.(prose); return { text: prose, inputTokens: 2, outputTokens: 3 };
    }),
    generateStructured: vi.fn(async (provider, request, validate) => {
      requests.push({ model: provider.model, request });
      if (request.system.includes('独立的插画定位任务')) {
        await wait(placementGate.promise, request.signal); if (options.failPlacement) throw new Error('定位服务失败');
        const scenes = JSON.parse(request.prompt.split('\n')[1]) as { id: string }[];
        return { value: validate({ placements: scenes.map(scene => ({ imageId: scene.id, paragraph: options.unmatched ? null : 2 })) }), inputTokens: 5, outputTokens: 6 };
      }
      if (request.system.includes('# 章节自动命名')) return { value: validate({ title: '雨中钥匙' }), inputTokens: 1, outputTokens: 1 };
      await wait(extractionGate.promise, request.signal); if (options.failExtraction) throw new Error('资料服务失败');
      return { value: validate(extraction), inputTokens: 3, outputTokens: 4 };
    }),
  };
  const engine = new StoryEngine(store, () => settings, models, images); engine.start();
  cleanups.push(async () => { await engine.close(); await images.close(); store.close(); });
  const start = () => engine.enqueue(branch, 'generate', { baseRevisionId: store.getBranch(branch).revisionId, mode: 'original', instruction: '写一章', ...(options.autoTitle ? {} : { title: '城门' }) });
  const placement = () => engine.listJobs().find(job => job.kind === 'image-placement');
  const extract = () => engine.listJobs().find(job => job.kind === 'extract');
  return { store, branch, project, settings, images, engine, generator, models, requests, start, placement, extract, extractionGate, placementGate };
}

it('keeps exact paragraph coordinates for CRLF, blank lines and Unicode and rejects invented or duplicate IDs', () => {
  expect(sceneParagraphs('😀城门。\r\n\r\n雨中。')).toEqual([{ paragraph: 1, text: '😀城门。', start: 0, end: 5 }, { paragraph: 2, text: '雨中。', start: 9, end: 12 }]);
  expect(scenePlacementRequest(prose, [{ id: 'image', sceneDescription: '拾起钥匙' }]).prompt).toContain('[2] 他在雨中捡起一把钥匙。');
  expect(() => parseScenePlacements({ placements: [{ imageId: 'other', paragraph: 1 }] }, ['image'], 2)).toThrow('标识');
  expect(() => parseScenePlacements({ placements: [{ imageId: 'a', paragraph: 1 }, { imageId: 'a', paragraph: 2 }] }, ['a', 'b'], 2)).toThrow('标识');
  expect(() => parseScenePlacements({ placements: [{ imageId: 'image', paragraph: 3 }] }, ['image'], 2)).toThrow();
});

it('starts CG without prose quotes, binds the same pixels to the chapter and matches while extraction is still blocked', async () => {
  const ctx = harness({ failExtraction: true }); ctx.start();
  await until(() => ctx.placement()?.status === 'running' && ctx.extract()?.status === 'running');
  await until(() => ctx.store.images.all()[0]?.status === 'completed');
  const image = ctx.store.images.all()[0]; const revision = ctx.store.getBranch(ctx.branch).revisionId;
  expect(image).toMatchObject({ bindingStatus: 'bound', chapterId: ctx.store.state(ctx.branch).chapters[0].id, placementStatus: 'pending' });
  expect(image.sourceText).toBeUndefined(); expect(ctx.images.list(ctx.branch, true)[0].active).toBe(true);
  ctx.placementGate.resolve(); await until(() => ctx.placement()?.status === 'completed');
  expect(ctx.extract()?.status).toBe('running');
  expect(ctx.store.images.get(image.id)).toMatchObject({ placementStatus: 'matched', sourceText: '他在雨中捡起一把钥匙。', selection: { start: prose.indexOf('他'), end: prose.length } });
  expect(ctx.store.getBranch(ctx.branch).revisionId).toBe(revision);
  expect(ctx.requests.find(call => call.request.system.includes('独立的插画定位任务'))?.model).toBe('extractor');
  ctx.extractionGate.resolve(); await until(() => ctx.extract()?.status === 'failed');
  expect(ctx.store.images.get(image.id)).toMatchObject({ status: 'completed', bindingStatus: 'bound', placementStatus: 'matched' });
  expect(ctx.generator).toHaveBeenCalledTimes(1); expect(ctx.models.generateText).toHaveBeenCalledTimes(1);
});

it('placement failure cannot fail extraction or prevent the next chapter; retry only calls the placement model', async () => {
  const ctx = harness({ failPlacement: true, autoTitle: true }); ctx.start();
  await until(() => ctx.placement()?.status === 'running' && ctx.extract()?.status === 'running');
  ctx.extractionGate.resolve(); await until(() => ctx.extract()?.status === 'completed');
  expect(ctx.store.state(ctx.branch).chapters[0]).toMatchObject({ title: '雨中钥匙', status: 'ready' });
  // Independent matcher remains in flight across the naming/extraction revisions.
  ctx.placementGate.resolve(); await until(() => ctx.placement()?.status === 'failed');
  const placement = ctx.placement()!; expect(ctx.store.images.all()[0]).toMatchObject({ bindingStatus: 'bound', placementStatus: 'failed', placementError: '定位服务失败' });
  ctx.engine.action(placement.id, 'retry'); await until(() => ctx.placement()?.status === 'failed');
  expect(ctx.models.generateText).toHaveBeenCalledTimes(1); expect(ctx.generator).toHaveBeenCalledTimes(1);
  expect(ctx.requests.filter(call => !call.request.system.includes('独立的插画定位任务'))).toHaveLength(2);
  expect(() => ctx.start()).not.toThrow();
});

it('rejects a late placement after a manual chapter edit and leaves the edited prose intact', async () => {
  const ctx = harness(); ctx.start(); await until(() => ctx.placement()?.status === 'running');
  ctx.extractionGate.resolve(); await until(() => ctx.extract()?.status === 'completed');
  const chapter = ctx.store.state(ctx.branch).chapters[0];
  ctx.store.saveChapter(ctx.branch, { baseRevisionId: ctx.store.getBranch(ctx.branch).revisionId, chapterId: chapter.id, title: chapter.title, text: '作者改成了全新正文。' });
  ctx.placementGate.resolve(); await until(() => ctx.placement()?.status === 'stale');
  expect(ctx.store.images.all()[0].sourceText).toBeUndefined();
  expect(ctx.store.chapter(ctx.branch, ctx.store.state(ctx.branch).chapters[0].id).text).toBe('作者改成了全新正文。');
});

it('an unmatched scene remains chapter-bound and diagnostics are read-only without another image request', async () => {
  const ctx = harness({ unmatched: true }); ctx.start(); ctx.extractionGate.resolve(); ctx.placementGate.resolve();
  await until(() => ctx.placement()?.status === 'completed' && ctx.extract()?.status === 'completed');
  const image = ctx.store.images.all()[0]; expect(image).toMatchObject({ bindingStatus: 'bound', placementStatus: 'unmatched' }); expect(image.selection).toBeUndefined();
  const job = ctx.placement()!; const output = ctx.engine.listOutputs(job.id)[0];
  expect(output).toMatchObject({ stage: 'image-placement', status: 'applied' }); expect(ctx.engine.outputDetail(job.id, output.id).canApply).toBe(false);
  expect(() => ctx.engine.importOutput(job.id, '{}')).toThrow('仅供查看'); expect(ctx.generator).toHaveBeenCalledTimes(1);
});

it.each([false, true])('keeps a manual binding when an automatic placement finishes later (failed=%s)', async failPlacement => {
  const ctx = harness({ failPlacement }); ctx.start();
  await until(() => ctx.placement()?.status === 'running');
  ctx.extractionGate.resolve(); await until(() => ctx.extract()?.status === 'completed');
  const image = ctx.store.images.all()[0]; const chapter = ctx.store.state(ctx.branch).chapters[0];
  const selection = { start: 0, end: prose.indexOf('\r') };
  ctx.images.setPlacement(ctx.branch, image.id, { baseRevisionId: ctx.store.getBranch(ctx.branch).revisionId, chapterId: chapter.id, selection });
  ctx.placementGate.resolve(); await until(() => ctx.placement()?.status === (failPlacement ? 'failed' : 'completed'));
  expect(ctx.images.list(ctx.branch, true)[0]).toMatchObject({ placementSource: 'manual', placementStatus: 'matched', selection, sourceText: '林舟来到城门。' });
  if (failPlacement) {
    const calls = vi.mocked(ctx.models.generateStructured).mock.calls.length;
    ctx.engine.action(ctx.placement()!.id, 'retry'); await until(() => ctx.placement()?.status === 'completed');
    expect(ctx.models.generateStructured).toHaveBeenCalledTimes(calls);
  }
  expect(ctx.generator).toHaveBeenCalledTimes(1); expect(ctx.models.generateText).toHaveBeenCalledTimes(1);
});
