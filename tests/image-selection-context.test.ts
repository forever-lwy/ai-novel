import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageService } from '../server/images.js';
import { generateImage, type GeneratedImage, type ImageGenerator } from '../server/image-provider.js';
import type { ImagePromptOptimizer } from '../server/image-prompts.js';
import { Store } from '../server/store.js';
import { buildWritingContext } from '../server/writing-context.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import type { Settings } from '../shared/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF4QAAAAASUVORK5CYII=', 'base64');
// Distinct byte fixtures make it possible to assert which input actually crosses
// the provider boundary; the image-store validator checks the PNG signature.
const oldPixels = Buffer.concat([png, Buffer.from('OLD_ACTIVE_PORTRAIT_PIXELS')]);
const newPixels = Buffer.concat([png, Buffer.from('NEW_INACTIVE_PORTRAIT_PIXELS')]);
const cleanups: (() => Promise<void>)[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('模拟优化已取消'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('等待图片上下文测试状态超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const defaultOptimizer: ImagePromptOptimizer = async (_settings, input) => ({ prompt: `OPTIMIZED_${input.kind}`, referenceEntityIds: input.characters.filter(character => character.imageId).map(character => character.entityId), parameters: {} });
function harness(generator?: ImageGenerator, optimize: ImagePromptOptimizer = defaultOptimizer) {
  const directory = mkdtempSync(join(tmpdir(), 'novel-image-selection-context-'));
  const store = new Store(directory);
  const settings: Settings = { providers: [{ id: 'fixture', name: '模拟', protocol: 'openai-chat', baseUrl: 'http://fixture.invalid/v1', model: 'text', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture', imageSettings: { ...defaultImageSettings(), providerId: 'fixture', model: 'gpt-image-1' } };
  let count = 0;
  const imageModel = vi.fn<ImageGenerator>(generator ?? (async () => ({ bytes: ++count === 1 ? oldPixels : count === 2 ? newPixels : png, mimeType: 'image/png' })));
  const optimizer = vi.fn<ImagePromptOptimizer>(optimize);
  const images = new ImageService(store, () => settings, imageModel, optimizer);
  const project = store.createProject({ title: '启用图片上下文测试' }); const branchId = project.mainBranchId;
  const chapter = store.putChapter('庭院', '林月走进庭院，站在石桌旁望向天空。'); chapter.status = 'ready';
  const state = store.state(branchId); state.chapters.push(chapter); state.entities.push({ id: 'moon', name: '林月', kind: 'character', aliases: ['小月'], description: '银发蓝裙的旅人', visibility: 'public', locked: true, isMain: true, facts: [] });
  store.commit(branchId, store.getBranch(branchId).revisionId, state, '公开资料');
  cleanups.push(async () => { await images.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = () => store.getBranch(branchId).revisionId;
  const portrait = () => images.generate(branchId, { baseRevisionId: base(), kind: 'portrait', entityId: 'moon' }).image;
  const cg = () => images.generate(branchId, { baseRevisionId: base(), kind: 'cg', chapterId: chapter.id }).image;
  return { store, images, imageModel, optimizer, project, branchId, chapter, settings, base, portrait, cg };
}
async function variants(ctx: ReturnType<typeof harness>) {
  const old = ctx.portrait(); await until(() => ctx.store.images.get(old.id)?.status === 'completed');
  const newer = ctx.portrait(); await until(() => ctx.store.images.get(newer.id)?.status === 'completed');
  // Ordering must be independent of a machine completing both fixtures in one ms.
  ctx.store.images.update({ ...ctx.store.images.get(old.id)!, createdAt: '2026-10-01T00:00:00.000Z' });
  ctx.store.images.update({ ...ctx.store.images.get(newer.id)!, createdAt: '2026-10-02T00:00:00.000Z' });
  return { old, newer };
}
const cgInput = (ctx: ReturnType<typeof harness>) => ctx.optimizer.mock.calls.filter(([, input]) => input.kind === 'cg').at(-1)![1];
const references = (ctx: ReturnType<typeof harness>) => ctx.imageModel.mock.calls.at(-1)![4] as GeneratedImage[] | undefined;

describe('enabled images at the model context boundary', () => {
  it('keeps a later variant inactive and uses the selected old portrait for CG candidates and bytes', async () => {
    const ctx = harness(); const { old, newer } = await variants(ctx);
    expect(ctx.images.list(ctx.branchId, true).find(image => image.id === old.id)?.active).toBe(true);
    expect(ctx.images.list(ctx.branchId, true).find(image => image.id === newer.id)?.active).toBe(false);
    const cg = ctx.cg(); await until(() => ctx.store.images.get(cg.id)?.status === 'completed');
    expect(cgInput(ctx).characters).toMatchObject([{ entityId: 'moon', imageId: old.id }]);
    expect(JSON.stringify(cgInput(ctx))).not.toContain(newer.id);
    expect(references(ctx)).toEqual([{ bytes: oldPixels, mimeType: 'image/png' }]);
    expect(ctx.store.images.get(cg.id)?.referenceImageIds).toEqual([old.id]);
  });

  it('treats explicit empty selection as disabled and does not fall back to any newer portrait', async () => {
    const ctx = harness(); const { old, newer } = await variants(ctx);
    ctx.images.setActive(ctx.branchId, old.id, ctx.base(), false);
    expect(ctx.store.state(ctx.branchId).activeImageIds).toEqual([]);
    expect(ctx.store.images.activeIds(ctx.store.state(ctx.branchId))).toEqual([]);
    const cg = ctx.cg(); await until(() => ctx.store.images.get(cg.id)?.status === 'completed');
    expect(cgInput(ctx).characters).toMatchObject([{ entityId: 'moon', imageId: undefined }]);
    expect(JSON.stringify(cgInput(ctx))).not.toContain(old.id); expect(JSON.stringify(cgInput(ctx))).not.toContain(newer.id);
    expect(references(ctx)).toBeUndefined();
    const third = ctx.portrait(); await until(() => ctx.store.images.get(third.id)?.status === 'completed');
    expect(ctx.images.list(ctx.branchId, true).find(image => image.id === third.id)?.active).toBe(false);
  });

  it('requires an inactive original to be enabled before manual AI edits can start', async () => {
    const ctx = harness(); const { old, newer } = await variants(ctx);
    const before = ctx.optimizer.mock.calls.length;
    expect(() => ctx.images.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon', referenceImageId: newer.id, instruction: '调整衣袖' })).toThrow(/启用|使用/);
    expect(ctx.optimizer).toHaveBeenCalledTimes(before);
    ctx.images.setActive(ctx.branchId, newer.id, ctx.base(), true);
    expect(() => ctx.images.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon', referenceImageId: old.id, instruction: '调整衣袖' })).toThrow(/启用|使用/);
    const edit = ctx.images.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon', referenceImageId: newer.id, instruction: '调整衣袖' }).image;
    await until(() => ctx.store.images.get(edit.id)?.status === 'completed');
    expect(references(ctx)).toEqual([{ bytes: newPixels, mimeType: 'image/png' }]);
    expect(ctx.store.images.get(edit.id)?.referenceImageIds).toEqual([newer.id]);
  });

  it('preserves the legacy latest-completed default while an explicit empty list disables that fallback', async () => {
    const ctx = harness(); const { old, newer } = await variants(ctx);
    const state = ctx.store.state(ctx.branchId); delete state.activeImageIds;
    // Old backups may contain a gallery array in presentation order. Selecting
    // the latest completed asset must use its creation time, not that ordering.
    state.imageIds = [newer.id, old.id];
    expect(ctx.store.images.activeIds(state)).toEqual([newer.id]);
    expect(ctx.store.images.active(ctx.store.images.get(old.id)!, state)).toBe(false);
    expect(ctx.store.images.active(ctx.store.images.get(newer.id)!, state)).toBe(true);
    state.activeImageIds = [];
    expect(ctx.store.images.activeIds(state)).toEqual([]);
    expect(ctx.store.images.active(ctx.store.images.get(newer.id)!, state)).toBe(false);
  });

  it('uses the completed active portrait immediately while an inactive new variant is still optimizing', async () => {
    const gate = deferred<Awaited<ReturnType<ImagePromptOptimizer>>>(); let portraits = 0;
    const ctx = harness(undefined, async (settings, input, signal) => input.kind === 'portrait' && ++portraits === 2 ? abortable(gate.promise, signal) : defaultOptimizer(settings, input, signal));
    const old = ctx.portrait(); await until(() => ctx.store.images.get(old.id)?.status === 'completed');
    const newer = ctx.portrait(); await until(() => ctx.store.images.get(newer.id)?.status === 'running');
    const cg = ctx.cg(); await until(() => ctx.store.images.get(cg.id)?.status === 'completed');
    expect(ctx.store.images.get(newer.id)?.status).toBe('running');
    expect(cgInput(ctx).characters[0].imageId).toBe(old.id);
    expect(references(ctx)).toEqual([{ bytes: oldPixels, mimeType: 'image/png' }]);
    gate.resolve({ prompt: '新立绘变体', referenceEntityIds: [], parameters: {} });
    await until(() => ctx.store.images.get(newer.id)?.status === 'completed');
    expect(ctx.images.list(ctx.branchId, true).find(image => image.id === newer.id)?.active).toBe(false);
  });

  it.each(['disable', 'delete', 'replace'] as const)('stops pixels after the selected reference changes during optimization: %s', async action => {
    const gate = deferred<Awaited<ReturnType<ImagePromptOptimizer>>>();
    const ctx = harness(undefined, async (settings, input, signal) => input.kind === 'cg' ? abortable(gate.promise, signal) : defaultOptimizer(settings, input, signal));
    const { old, newer } = await variants(ctx); const cg = ctx.cg();
    await until(() => ctx.optimizer.mock.calls.some(([, input]) => input.kind === 'cg'));
    expect(cgInput(ctx).characters[0].imageId).toBe(old.id);
    if (action === 'delete') ctx.images.delete(ctx.branchId, old.id, ctx.base());
    else ctx.images.setActive(ctx.branchId, action === 'replace' ? newer.id : old.id, ctx.base(), action === 'replace');
    gate.resolve({ prompt: '画面已优化', referenceEntityIds: ['moon'], parameters: {} });
    await until(() => ctx.store.images.get(cg.id)?.status !== 'running');
    expect(ctx.imageModel).toHaveBeenCalledTimes(2);
    expect(ctx.optimizer).toHaveBeenCalledTimes(3);
    expect(ctx.store.images.get(cg.id)?.status).not.toBe('completed');
  });

  it('does not send manual edit pixels after its original is disabled during prompt optimization', async () => {
    const gate = deferred<Awaited<ReturnType<ImagePromptOptimizer>>>();
    const ctx = harness(undefined, async (settings, input, signal) => input.instruction ? abortable(gate.promise, signal) : defaultOptimizer(settings, input, signal));
    const { old } = await variants(ctx);
    const edit = ctx.images.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon', referenceImageId: old.id, instruction: '衣袖改为长袖' }).image;
    await until(() => ctx.optimizer.mock.calls.some(([, input]) => Boolean(input.instruction)));
    expect(ctx.optimizer.mock.calls.at(-1)![1].references).toEqual([{ label: '待修改的原图', imageId: old.id }]);
    ctx.images.setActive(ctx.branchId, old.id, ctx.base(), false);
    gate.resolve({ prompt: '保留原图外貌并延长衣袖', referenceEntityIds: [], parameters: {} });
    await until(() => ctx.store.images.get(edit.id)?.status !== 'running');
    expect(ctx.imageModel).toHaveBeenCalledTimes(2);
    expect(ctx.store.images.get(edit.id)?.status).not.toBe('completed');
  });

  it('does not request pixels or retry optimization after an author cancels an in-flight CG', async () => {
    const gate = deferred<Awaited<ReturnType<ImagePromptOptimizer>>>();
    const ctx = harness(undefined, async (settings, input, signal) => input.kind === 'cg' ? abortable(gate.promise, signal) : defaultOptimizer(settings, input, signal));
    await variants(ctx); const cg = ctx.cg();
    await until(() => ctx.optimizer.mock.calls.some(([, input]) => input.kind === 'cg'));
    ctx.images.cancel(ctx.branchId, cg.id);
    gate.resolve({ prompt: '已取消任务的迟到提示词', referenceEntityIds: ['moon'], parameters: {} });
    await until(() => ctx.store.images.get(cg.id)?.status === 'cancelled');
    // Closing waits for the optimizer promise to unwind before inspecting calls.
    await ctx.images.close();
    expect(ctx.imageModel).toHaveBeenCalledTimes(2); expect(ctx.optimizer).toHaveBeenCalledTimes(3);
    expect(ctx.store.images.get(cg.id)?.status).toBe('cancelled');
  });

  it('reuses an optimized prompt on explicit retry while every selected reference remains active', async () => {
    let calls = 0;
    const ctx = harness(async () => { calls++; if (calls === 3) throw new Error('模拟 CG 图片请求失败'); return { bytes: calls === 1 ? oldPixels : calls === 2 ? newPixels : png, mimeType: 'image/png' }; });
    const { old } = await variants(ctx); const cg = ctx.cg();
    await until(() => ctx.store.images.get(cg.id)?.status === 'failed');
    const optimized = ctx.store.images.get(cg.id)!.prompt;
    const retried = ctx.images.retry(ctx.branchId, cg.id, ctx.base()).image;
    await until(() => ctx.store.images.get(retried.id)?.status === 'completed');
    expect(ctx.optimizer).toHaveBeenCalledTimes(3);
    expect(ctx.store.images.get(retried.id)?.prompt).toBe(optimized);
    expect(ctx.store.images.get(retried.id)?.referenceImageIds).toEqual([old.id]);
    expect(references(ctx)).toEqual([{ bytes: oldPixels, mimeType: 'image/png' }]);
  });

  it('refreshes an explicitly retried CG when its optimized reference was replaced', async () => {
    let calls = 0;
    const ctx = harness(async () => { calls++; if (calls === 3) throw new Error('模拟 CG 图片请求失败'); return { bytes: calls === 1 ? oldPixels : calls === 2 ? newPixels : png, mimeType: 'image/png' }; });
    const { old, newer } = await variants(ctx); const cg = ctx.cg();
    await until(() => ctx.store.images.get(cg.id)?.status === 'failed');
    expect(ctx.store.images.get(cg.id)?.promptStatus).toBe('completed');
    expect(ctx.store.images.get(cg.id)?.referenceImageIds).toEqual([old.id]);
    ctx.images.setActive(ctx.branchId, newer.id, ctx.base(), true);
    const retried = ctx.images.retry(ctx.branchId, cg.id, ctx.base()).image;
    await until(() => ctx.store.images.get(retried.id)?.status === 'completed');
    expect(cgInput(ctx).characters[0].imageId).toBe(newer.id);
    expect(ctx.optimizer).toHaveBeenCalledTimes(4);
    expect(references(ctx)).toEqual([{ bytes: newPixels, mimeType: 'image/png' }]);
    expect(ctx.store.images.get(retried.id)?.referenceImageIds).toEqual([newer.id]);
  });

  it('retains the automatic scene description when reference selection requires fresh prompt optimization', async () => {
    let calls = 0;
    const ctx = harness(async () => { calls++; if (calls === 3) throw new Error('模拟自动 CG 图片请求失败'); return { bytes: calls === 1 ? oldPixels : calls === 2 ? newPixels : png, mimeType: 'image/png' }; });
    const { newer } = await variants(ctx); ctx.settings.imageSettings!.autoCG = true;
    const description = '以庭院石桌为前景，林月位于画面左侧，描绘傍晚暖光';
    const automatic = ctx.images.generateAutomatic(ctx.branchId, ctx.base(), ctx.chapter.id, [{ kind: 'cg', sourceText: ctx.store.chapter(ctx.branchId, ctx.chapter.id).text, description }], [])!;
    expect(automatic.images).toHaveLength(1); const cg = automatic.images[0];
    await until(() => ctx.store.images.get(cg.id)?.status === 'failed');
    const previousMaterial = cgInput(ctx).material; expect(previousMaterial).toContain(description);
    ctx.images.setActive(ctx.branchId, newer.id, ctx.base(), true);
    const retried = ctx.images.retry(ctx.branchId, cg.id, ctx.base()).image;
    await until(() => ctx.store.images.get(retried.id)?.status === 'completed');
    expect(cgInput(ctx).material).toBe(previousMaterial);
    expect(cgInput(ctx).characters[0].imageId).toBe(newer.id);
    expect(ctx.optimizer).toHaveBeenCalledTimes(4);
    expect(references(ctx)).toEqual([{ bytes: newPixels, mimeType: 'image/png' }]);
  });

  it('reoptimizes a fork retry using that branch selection instead of the original asset branch', async () => {
    let calls = 0;
    const ctx = harness(async () => { calls++; if (calls === 3) throw new Error('模拟主线 CG 图片请求失败'); return { bytes: calls === 1 ? oldPixels : calls === 2 ? newPixels : png, mimeType: 'image/png' }; });
    const { old, newer } = await variants(ctx); const cg = ctx.cg();
    await until(() => ctx.store.images.get(cg.id)?.status === 'failed');
    const fork = ctx.store.fork(ctx.branchId, { baseRevisionId: ctx.base(), name: '改用另一张立绘的修订线' });
    ctx.images.setActive(fork.branch.id, newer.id, fork.branch.revisionId, true);
    expect(ctx.store.images.activeIds(ctx.store.state(ctx.branchId))).toContain(old.id);
    expect(ctx.store.images.activeIds(ctx.store.state(fork.branch.id))).toContain(newer.id);
    const retried = ctx.images.retry(fork.branch.id, cg.id, ctx.store.getBranch(fork.branch.id).revisionId).image;
    await until(() => !['queued', 'running'].includes(ctx.store.images.get(retried.id)!.status));
    expect(ctx.store.images.get(retried.id)?.status).toBe('completed');
    expect(ctx.optimizer).toHaveBeenCalledTimes(4);
    expect(cgInput(ctx).characters[0].imageId).toBe(newer.id);
    expect(references(ctx)).toEqual([{ bytes: newPixels, mimeType: 'image/png' }]);
    expect(ctx.store.images.get(cg.id)?.referenceImageIds).toEqual([old.id]);
  });

  it('excludes a disabled portrait from actual OpenAI multipart reference bytes over local HTTP', async () => {
    const bodies: Buffer[] = []; const paths: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(Buffer.concat(chunks)); paths.push(request.url!);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    let useWire = false; let count = 0;
    const ctx = harness(async (...args) => useWire ? generateImage(...args) : { bytes: ++count === 1 ? oldPixels : newPixels, mimeType: 'image/png' });
    const { old, newer } = await variants(ctx);
    ctx.settings.providers[0].baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    useWire = true; const cg = ctx.cg(); await until(() => ctx.store.images.get(cg.id)?.status === 'completed');
    expect(paths).toEqual(['/v1/images/edits']); expect(bodies).toHaveLength(1);
    expect(bodies[0].includes(oldPixels)).toBe(true); expect(bodies[0].includes(newPixels)).toBe(false);
    expect(JSON.stringify(cgInput(ctx))).toContain(old.id); expect(JSON.stringify(cgInput(ctx))).not.toContain(newer.id);
  });
});

describe('historical CG privacy and prose-context boundaries', () => {
  it.each(['disable', 'delete'] as const)('keeps a completed CG readable after its old public reference is %s while respecting later secrets', async action => {
    const ctx = harness(); const { old } = await variants(ctx); const cg = ctx.cg();
    await until(() => ctx.store.images.get(cg.id)?.status === 'completed');
    if (action === 'delete') ctx.images.delete(ctx.branchId, old.id, ctx.base());
    else ctx.images.setActive(ctx.branchId, old.id, ctx.base(), false);
    expect(ctx.images.list(ctx.branchId).some(image => image.id === cg.id)).toBe(true);
    expect(ctx.images.content(ctx.branchId, cg.id).bytes).toEqual(png);
    expect(() => ctx.images.content(ctx.branchId, old.id)).toThrow('不包含');
    expect(ctx.store.view(ctx.branchId).state.imageIds).toEqual([cg.id]);
    expect(ctx.store.view(ctx.branchId).state.activeImageIds).toEqual([cg.id]);
    expect(ctx.store.images.content(old.id)?.bytes).toEqual(oldPixels);
    const state = ctx.store.state(ctx.branchId); state.entities[0].visibility = 'secret';
    ctx.store.commit(ctx.branchId, ctx.base(), state, '原资料改为秘密');
    expect(ctx.images.list(ctx.branchId).some(image => image.id === cg.id)).toBe(false);
    expect(() => ctx.images.content(ctx.branchId, cg.id)).toThrow('不包含');
    const futureState = ctx.store.state(ctx.branchId); futureState.entities[0].visibility = 'public';
    ctx.store.commit(ctx.branchId, ctx.base(), futureState, '资料恢复公开');
    expect(ctx.images.list(ctx.branchId).some(image => image.id === cg.id)).toBe(true);
    const planned = ctx.store.state(ctx.branchId); planned.entities[0].facts.push({ id: 'future-identity', text: '林月将在下一章公布身份', visibility: 'public', temporal: 'future', certainty: 'fact' });
    ctx.store.commit(ctx.branchId, ctx.base(), planned, '新增未来身份资料');
    expect(ctx.images.list(ctx.branchId).some(image => image.id === cg.id)).toBe(false);
    expect(ctx.store.view(ctx.branchId).state.imageIds).toEqual([]);
    expect(() => ctx.images.content(ctx.branchId, cg.id)).toThrow('不包含');
  });

  it('never serializes inactive gallery metadata or pixels into prose context or story lookup results', async () => {
    const ctx = harness(); const { old, newer } = await variants(ctx);
    ctx.store.images.update({ ...ctx.store.images.get(newer.id)!, prompt: 'INACTIVE_ONLY_IMAGE_PROMPT' });
    const state = ctx.store.state(ctx.branchId);
    const context = buildWritingContext({ state, chapterText: chapterId => ctx.store.chapter(ctx.branchId, chapterId).text });
    const search = await context.tools.find(tool => tool.name === 'search_story')!.execute({ keywords: ['林月'] });
    const entity = await context.tools.find(tool => tool.name === 'read_entity')!.execute({ id: 'moon' });
    const chapter = await context.tools.find(tool => tool.name === 'read_chapter')!.execute({ chapterId: ctx.chapter.id });
    const serialized = JSON.stringify({ text: context.text, variables: context.variables, search, entity, chapter });
    for (const marker of [newer.id, 'INACTIVE_ONLY_IMAGE_PROMPT', newPixels.toString('base64')]) expect(serialized).not.toContain(marker);
    expect(serialized).toContain('银发蓝裙的旅人'); expect(serialized).toContain(ctx.chapter.id);
    // Text writing currently has no raster-image input channel at all.
    expect(serialized).not.toContain(oldPixels.toString('base64')); expect(serialized).not.toContain(old.id);
  });
});
