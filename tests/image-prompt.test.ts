import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import { Store } from '../server/store.js';
import { ImageService } from '../server/images.js';
import { optimizeImagePrompt, resolveImageParameters, type ImagePromptInput, type ImagePromptOptimizer } from '../server/image-prompts.js';
import type { ImageGenerator } from '../server/image-provider.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import type { ImageSettings, Settings } from '../shared/types.js';
import { defaultPromptTemplates } from '../shared/prompt-templates.js';
import { withTavernPresets } from './fixtures/prompt-presets.js';
import { TASK_V3_PRESET_IDS } from '../shared/task-prompts-v3.js';

const textModel = vi.hoisted(() => ({ generateStructured: vi.fn() }));
vi.mock('../server/providers.js', async importOriginal => ({ ...await importOriginal<typeof import('../server/providers.js')>(), generateStructured: textModel.generateStructured }));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=', 'base64');
const config = (): ImageSettings => ({ ...defaultImageSettings(), providerId: 'image', model: 'gpt-image-1', promptProviderId: 'text', promptModel: 'image-prompt-model' });
const settings = (): Settings => ({ providers: [{ id: 'text', name: '文字模型', protocol: 'openai-chat', baseUrl: 'https://fixture.invalid/v1' }, { id: 'image', name: '图片模型', protocol: 'openai-chat', baseUrl: 'https://image-fixture.invalid/v1' }], writingProviderId: 'text', planningProviderId: 'text', extractionProviderId: 'text', writingModel: 'writer', planningModel: 'planner', extractionModel: 'extractor', imageSettings: config() });
const input = (overrides: Partial<ImagePromptInput> = {}): ImagePromptInput => ({ kind: 'cg', material: '林月和程川站在庭院里，共同望向天空。', instruction: '保留两人的外貌', stylePrompt: '古典插画', config: config(), characters: [{ entityId: 'moon', name: '林月', description: '银发蓝裙', imageId: 'moon-portrait' }, { entityId: 'river', name: '程川', description: '黑发白袍', imageId: 'river-portrait' }], references: [], ...overrides });
function structuredResult(value: unknown) { textModel.generateStructured.mockImplementation(async (_provider, _request, validate) => ({ value: validate(value), inputTokens: 20, outputTokens: 30 })); }
beforeEach(() => { textModel.generateStructured.mockReset(); structuredResult({ prompt: 'Two characters beneath a radiant sky, cinematic framing, coherent clothing and lighting', referenceEntityIds: ['moon', 'river'], parameters: {} }); });
const userMaterial = (request: { messages: { role: string; content: string }[] }) => request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

describe('image prompt model and parameter selection', () => {
  it('uses the selected image edition and original carrier while preserving independent optimizer requirements', async () => {
    const saved = settings(); saved.promptTemplates = withTavernPresets(); saved.promptTemplates.general!.selected = 'tavern-reborn-v23';
    saved.promptTemplates.selected.image = TASK_V3_PRESET_IDS.image;
    saved.promptTemplates.presets.image.find(preset => preset.id === TASK_V3_PRESET_IDS.image)!.blocks[0].content += '\nIMAGE_AUTHOR_RULE：保持水彩质感。'; const data = input(); data.config.promptSystemPrompt = '保留参考图中的衣服';
    await optimizeImagePrompt(saved, data); const request = textModel.generateStructured.mock.calls[0][1];
    expect(request.responseCarrier).toMatchObject({ name: 'game_content', field: 'content' }); expect(request.messageTransform).toBe('reborn');
    expect(request.system).toContain('IMAGE_AUTHOR_RULE'); expect(request.system).toContain(data.config.promptSystemPrompt); expect(request.system).not.toContain('要写够1500字');
    expect(request.messages.some((message: { content: string }) => message.content.includes(data.material))).toBe(true);
  });
  it('allows a standalone image task without inheriting its current general output carrier', async () => {
    const saved = settings(); saved.promptTemplates = withTavernPresets(); saved.promptTemplates.general!.selected = 'tavern-linux-v13'; saved.promptTemplates.selected.image = TASK_V3_PRESET_IDS.image; saved.promptTemplates.presets.image.find(preset => preset.id === TASK_V3_PRESET_IDS.image)!.useGeneral = false;
    await optimizeImagePrompt(saved, input()); const request = textModel.generateStructured.mock.calls[0][1]; expect(request.responseCarrier).toBeUndefined(); expect(request.messageTransform).toBeUndefined(); expect(request.system).not.toContain('Linux_terminal_emulator');
  });
  it('preserves the JSON image input when the author explicitly selects image v3', async () => {
    const saved = settings(); saved.promptTemplates = defaultPromptTemplates(); saved.promptTemplates.selected.image = TASK_V3_PRESET_IDS.image;
    const data = input(); await optimizeImagePrompt(saved, data);
    const request = textModel.generateStructured.mock.calls[0][1];
    expect(JSON.parse(userMaterial(request))).toMatchObject({ material: data.material, instruction: data.instruction, characters: data.characters, config: { protocol: 'openai-images' } });
  });
  it('uses the independent text model and supplies readable art material and confirmed reference candidates', async () => {
    const data = input(); data.config.promptSystemPrompt = '优先使用中文画面描述'; const result = await optimizeImagePrompt(settings(), data);
    expect(result.prompt).not.toBe(data.material); expect(result.referenceEntityIds).toEqual(['moon', 'river']); expect(result.parameters).toEqual({ size: '1024x1024' });
    const [provider, request] = textModel.generateStructured.mock.calls[0]; expect(provider.model).toBe('image-prompt-model'); expect(provider.id).toBe('text'); expect(provider.stream).toBe(false);
    expect(request.system).toContain('IMAGE_PROMPT_OPTIMIZATION');
    const material = userMaterial(request);
    for (const value of ['# 本次画面资料', '目标素材：', data.material, data.instruction, '人物资料：', '资料标识：moon', '资料标识：river', '图片标识：moon-portrait', '图片标识：river-portrait', 'openai-images', '优先使用中文画面描述']) expect(material).toContain(value);
    expect(material).not.toMatch(/^\s*\{/); expect(material).not.toContain('"material":');
  });
  it('sends the complete captured story context through the shared image prompt compilation', async () => {
    const data = input({ storyContext: '前章：林月穿着银色斗篷来到庭院。\n本章前文：程川递出信封。\n目标：她接住了它。\n本章后文：她读完后把信收好。' });
    await optimizeImagePrompt(settings(), data);
    const request = textModel.generateStructured.mock.calls[0][1];
    const material = userMaterial(request);
    expect(material).toContain('故事上下文：'); expect(material).toContain(data.storyContext); expect(material).toContain(data.material);
    expect(request.system).toContain('不得将后文事件'); expect(request.system).toContain('只选择目标瞬间真正需要的人物');
  });
  it('counts the full story context in the request budget and refuses before sending instead of silently truncating it', async () => {
    const saved = settings(); saved.modelParameters = [{ role: 'planning', providerId: 'text', model: 'image-prompt-model', contextTokens: 8192, maxOutputTokens: 1024 }];
    await expect(optimizeImagePrompt(saved, input({ storyContext: '上下文原文不能被静默截断。'.repeat(1000) }))).rejects.toThrow('超出模型上下文');
    expect(textModel.generateStructured).not.toHaveBeenCalled();
  });
  it('falls back to planning without an explicit optimizer connection and fails clearly when text models are missing', async () => {
    const data = input(); data.config.promptProviderId = ''; data.config.promptModel = ''; await optimizeImagePrompt(settings(), data); expect(textModel.generateStructured.mock.calls[0][0].model).toBe('planner');
    textModel.generateStructured.mockClear(); await expect(optimizeImagePrompt({ providers: [], writingProviderId: '', planningProviderId: '', extractionProviderId: '' }, data)).rejects.toThrow('配置生图提示词'); expect(textModel.generateStructured).not.toHaveBeenCalled();
  });
  it('tells the prompt model the author fixed all references and ignores its attempted reselection', async () => {
    const data = input(); data.referenceSelection = 'manual'; data.references = [{ imageId: 'chosen-portrait', entityId: 'moon', label: '作者指定林月立绘' }];
    structuredResult({ prompt: 'Use the author selected portrait.', referenceEntityIds: ['invented'], parameters: {} });
    const result = await optimizeImagePrompt(settings(), data); expect(result.referenceEntityIds).toEqual([]);
    const request = textModel.generateStructured.mock.calls[0][1]; const content = userMaterial(request);
    for (const value of ['参考图选择方式：manual', '图片标识：chosen-portrait', '资料标识：moon', '作者指定林月立绘', '人物参考图上限：0', '不增删或替换']) expect(content).toContain(value);
    expect(textModel.generateStructured).toHaveBeenCalledTimes(1);
  });
  it('sends the new default readable image input through real local HTTP without changing author choices', async () => {
    const bodies: any[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt: '庭院中的两位旅人仰望天空，古典插画。', referenceEntityIds: ['invented'], parameters: { size: '1536x1024' } }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 40 } }));
    });
    servers.push(server); await listenLocalServer(server);
    const saved = settings(); saved.providers[0].baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
    const actual = await vi.importActual<typeof import('../server/providers.js')>('../server/providers.js');
    textModel.generateStructured.mockImplementation(actual.generateStructured);
    const data = input({ storyContext: '前章全文：林月来到庭院。\n本章后文：程川收起信件。', referenceSelection: 'manual', references: [{ imageId: 'chosen-portrait', entityId: 'moon', label: '作者指定立绘' }] });
    data.config.promptSystemPrompt = '衣服保持银蓝配色。';
    const result = await optimizeImagePrompt(saved, data);
    expect(result).toMatchObject({ referenceEntityIds: [], parameters: { size: '1024x1024' } });
    expect(bodies).toHaveLength(1);
    const content = bodies[0].messages.filter((message: { role: string }) => message.role === 'user').map((message: { content: string }) => message.content).join('\n');
    for (const value of ['# 本次画面资料', data.material, data.storyContext, '参考图选择方式：manual', '图片标识：chosen-portrait', '人物参考图上限：0', '不增删或替换', '1024x1024', '衣服保持银蓝配色。']) expect(content).toContain(value);
    expect(content).not.toContain('"material":'); expect(content).not.toContain('\\n本章后文');
  });
  it('rejects invented reference IDs and invalid image parameters without a second model call', async () => {
    structuredResult({ prompt: 'Portrait illustration', referenceEntityIds: ['invented'], parameters: {} }); await expect(optimizeImagePrompt(settings(), input())).rejects.toThrow('不存在'); expect(textModel.generateStructured).toHaveBeenCalledTimes(1);
    structuredResult({ prompt: 'Portrait illustration', referenceEntityIds: [], parameters: { unknown: true } }); await expect(optimizeImagePrompt(settings(), input())).rejects.toThrow(); expect(textModel.generateStructured).toHaveBeenCalledTimes(2);
  });
  it('preserves fixed dimensions and lets the prompt model select only valid automatic options', () => {
    expect(resolveImageParameters(config(), { size: '1536x1024' })).toEqual({ size: '1024x1024' });
    expect(resolveImageParameters({ ...config(), size: 'auto' }, { size: '1536x1024' })).toEqual({ size: '1536x1024' });
    expect(() => resolveImageParameters({ ...config(), size: 'auto' }, { size: '9999x9999' })).toThrow('不受');
    const gemini: ImageSettings = { ...config(), protocol: 'gemini', model: 'gemini-3.1-flash-image-preview', size: 'auto', aspectRatio: 'auto', imageSize: 'auto' };
    expect(resolveImageParameters(gemini, { aspectRatio: '16:9', imageSize: '2K' })).toEqual({ aspectRatio: '16:9', imageSize: '2K' }); expect(() => resolveImageParameters(gemini, { aspectRatio: '99:1', imageSize: '2K' })).toThrow('比例');
    expect(resolveImageParameters({ ...config(), protocol: 'together-images', model: 'black-forest-labs/FLUX.2-dev', size: 'auto' }, { width: 1536, height: 1024 })).toEqual({ width: 1536, height: 1024 });
  });
  it('checks the complete prompt output reserve before sending any model request', async () => {
    const saved = settings(); saved.modelParameters = [{ role: 'planning', providerId: 'text', model: 'image-prompt-model', contextTokens: 2048, maxOutputTokens: 4096 }];
    await expect(optimizeImagePrompt(saved, input())).rejects.toThrow('完整输出上限'); expect(textModel.generateStructured).not.toHaveBeenCalled();
  });
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
const defaultOptimizer: ImagePromptOptimizer = async (_settings, data) => ({ prompt: 'OPTIMIZED_IMAGE_TAGS: cinematic framing, coherent character designs, natural lighting', referenceEntityIds: data.characters.filter(character => character.imageId).map(character => character.entityId), parameters: {} });
function harness(generator: ImageGenerator = async () => ({ bytes: png, mimeType: 'image/png' }), optimizer: ImagePromptOptimizer = defaultOptimizer) {
  const directory = mkdtempSync(join(tmpdir(), 'novel-image-prompts-')); const store = new Store(directory); const saved = settings(); const service = new ImageService(store, () => saved, generator, optimizer); const project = store.createProject({ title: '两阶段生图' }); const branchId = project.mainBranchId;
  const chapter = store.putChapter('庭院', '林月和程川站在庭院里，共同望向天空。'); chapter.status = 'ready'; const state = store.state(branchId); state.chapters.push(chapter); state.entities = [{ id: 'moon', kind: 'character', name: '林月', aliases: [], description: '银发蓝裙', visibility: 'public', locked: true, facts: [] }, { id: 'river', kind: 'character', name: '程川', aliases: [], description: '黑发白袍', visibility: 'public', locked: true, facts: [] }]; store.commit(branchId, store.getBranch(branchId).revisionId, state, 'fixture');
  cleanup.push(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }); return { store, service, saved, branchId, chapter, base: () => store.getBranch(branchId).revisionId };
}
async function until(check: () => boolean) { for (let count = 0; count < 200 && !check(); count++) await new Promise(resolve => setTimeout(resolve, 5)); expect(check()).toBe(true); }

describe('persisted prompt and image generation phases', () => {
  it('captures CG context for selection and redraw, persists it through backup, and reuses it for a pixel-only retry', async () => {
    let calls = 0; const generator = vi.fn<ImageGenerator>(async () => { if (++calls === 1) throw new Error('pixel failure'); return { bytes: png, mimeType: 'image/png' }; });
    const optimizer = vi.fn<ImagePromptOptimizer>(defaultOptimizer); const ctx = harness(generator, optimizer);
    const target = ctx.store.chapter(ctx.branchId, ctx.chapter.id).text; const start = target.indexOf('共同');
    const first = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id, selection: { start, end: target.length } });
    await until(() => ctx.store.images.get(first.image.id)?.status === 'failed');
    const saved = ctx.store.images.get(first.image.id)!;
    expect(saved.storyContext).toContain('林月和程川站在庭院里'); expect(saved.sourceText).toBe(target.slice(start)); expect(optimizer.mock.calls[0][1].storyContext).toBe(saved.storyContext);
    const retry = ctx.service.retry(ctx.branchId, first.image.id, ctx.base()); await until(() => ctx.store.images.get(retry.image.id)?.status === 'completed');
    expect(optimizer).toHaveBeenCalledTimes(1); expect(ctx.store.images.get(retry.image.id)?.storyContext).toBe(saved.storyContext);
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.store.getBranch(ctx.branchId).projectId));
    expect(ctx.store.images.all(restored.id).every(image => image.storyContext === saved.storyContext)).toBe(true);
    const redraw = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id, selection: { start, end: target.length } });
    await until(() => ctx.store.images.get(redraw.image.id)?.status === 'completed'); expect(optimizer).toHaveBeenCalledTimes(2);
    expect(optimizer.mock.calls[1][1].storyContext).toBe(saved.storyContext); expect(ctx.service.list(ctx.branchId, false).every(image => image.storyContext === undefined)).toBe(true);
  });
  it('persists the optimized prompt separately and sends that final prompt to the image service', async () => {
    const imageModel = vi.fn<ImageGenerator>(async () => ({ bytes: png, mimeType: 'image/png' })); const optimizer = vi.fn<ImagePromptOptimizer>(defaultOptimizer); const ctx = harness(imageModel, optimizer);
    const result = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon' }); await until(() => ctx.store.images.get(result.image.id)?.status === 'completed'); const asset = ctx.store.images.get(result.image.id)!;
    expect(asset.material).toContain('银发蓝裙'); expect(asset.prompt).toContain('OPTIMIZED_IMAGE_TAGS'); expect(asset.promptStatus).toBe('completed'); expect(asset.optimizedAt).toBeTruthy(); expect(imageModel.mock.calls[0][2]).toBe(asset.prompt); expect(optimizer).toHaveBeenCalledTimes(1);
    expect(ctx.service.list(ctx.branchId)[0]).toMatchObject({ material: undefined, instruction: undefined, prompt: '', referenceImageIds: undefined, generationParameters: undefined });
  });
  it('retries failed pixels from the saved optimized prompt without paying to optimize again', async () => {
    let calls = 0; const imageModel = vi.fn<ImageGenerator>(async () => { if (++calls === 1) throw new Error('pixel fixture failed'); return { bytes: png, mimeType: 'image/png' }; }); const optimizer = vi.fn<ImagePromptOptimizer>(defaultOptimizer); const ctx = harness(imageModel, optimizer);
    const original = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon' }); await until(() => ctx.store.images.get(original.image.id)?.status === 'failed'); const retry = ctx.service.retry(ctx.branchId, original.image.id, ctx.base()); await until(() => ctx.store.images.get(retry.image.id)?.status === 'completed');
    expect(optimizer).toHaveBeenCalledTimes(1); expect(imageModel).toHaveBeenCalledTimes(2); expect(imageModel.mock.calls[1][2]).toBe(imageModel.mock.calls[0][2]); expect(ctx.store.images.get(original.image.id)?.status).toBe('failed');
  });
  it('reoptimizes an explicit retry after the image model and protocol change', async () => {
    let calls = 0; const imageModel = vi.fn<ImageGenerator>(async () => { if (++calls === 1) throw new Error('pixel fixture failed'); return { bytes: png, mimeType: 'image/png' }; }); const optimizer = vi.fn<ImagePromptOptimizer>(defaultOptimizer); const ctx = harness(imageModel, optimizer);
    const original = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon' }); await until(() => ctx.store.images.get(original.image.id)?.status === 'failed');
    ctx.saved.imageSettings = { ...ctx.saved.imageSettings!, protocol: 'gemini', model: 'gemini-3.1-flash-image-preview', aspectRatio: '16:9', imageSize: '1K' };
    const retry = ctx.service.retry(ctx.branchId, original.image.id, ctx.base()); await until(() => ctx.store.images.get(retry.image.id)?.status === 'completed'); expect(optimizer).toHaveBeenCalledTimes(2); expect(imageModel.mock.calls[1][1]).toMatchObject({ protocol: 'gemini', model: 'gemini-3.1-flash-image-preview', aspectRatio: '16:9', imageSize: '1K' }); expect(ctx.store.images.get(original.image.id)?.generationParameters).toMatchObject({ protocol: 'openai-images', model: 'gpt-image-1' });
  });
  it('reoptimizes an explicit retry when fixed composition dimensions change', async () => {
    let calls = 0; const imageModel = vi.fn<ImageGenerator>(async () => { if (++calls === 1) throw new Error('pixel fixture failed'); return { bytes: png, mimeType: 'image/png' }; }); const optimizer = vi.fn<ImagePromptOptimizer>(defaultOptimizer); const ctx = harness(imageModel, optimizer);
    const original = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon' }); await until(() => ctx.store.images.get(original.image.id)?.status === 'failed'); ctx.saved.imageSettings!.size = '1536x1024';
    const retry = ctx.service.retry(ctx.branchId, original.image.id, ctx.base()); await until(() => ctx.store.images.get(retry.image.id)?.status === 'completed'); expect(optimizer).toHaveBeenCalledTimes(2); expect(imageModel.mock.calls[1][1].size).toBe('1536x1024'); expect(ctx.store.images.get(original.image.id)?.generationParameters?.size).toBe('1024x1024');
  });
  it('does not call the image model when prompt optimization fails, and explicit retry retries that phase only', async () => {
    const imageModel = vi.fn<ImageGenerator>(async () => ({ bytes: png, mimeType: 'image/png' })); let calls = 0; const optimizer = vi.fn<ImagePromptOptimizer>(async (...args) => { if (++calls === 1) throw new Error('optimizer fixture failed'); return defaultOptimizer(...args); }); const ctx = harness(imageModel, optimizer);
    const original = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon' }); await until(() => ctx.store.images.get(original.image.id)?.status === 'failed'); expect(imageModel).not.toHaveBeenCalled();
    const retry = ctx.service.retry(ctx.branchId, original.image.id, ctx.base()); await until(() => ctx.store.images.get(retry.image.id)?.status === 'completed'); expect(optimizer).toHaveBeenCalledTimes(2); expect(imageModel).toHaveBeenCalledTimes(1);
  });
  it('ignores a cancelled optimizer response before starting the paid image request', async () => {
    let release!: () => void; const optimizer: ImagePromptOptimizer = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return defaultOptimizer(...args); }; const imageModel = vi.fn<ImageGenerator>(async () => ({ bytes: png, mimeType: 'image/png' })); const ctx = harness(imageModel, optimizer);
    const original = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon' }); await until(() => Boolean(release)); ctx.service.cancel(ctx.branchId, original.image.id); release(); await new Promise(resolve => setTimeout(resolve, 20)); expect(imageModel).not.toHaveBeenCalled(); expect(ctx.store.images.get(original.image.id)).toMatchObject({ status: 'cancelled', promptStatus: 'pending', prompt: '' });
  });
  it('marks a late prompt stale after story material changes and never requests its pixels', async () => {
    let release!: () => void; const optimizer: ImagePromptOptimizer = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return defaultOptimizer(...args); }; const imageModel = vi.fn<ImageGenerator>(async () => ({ bytes: png, mimeType: 'image/png' })); const ctx = harness(imageModel, optimizer);
    const original = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon' }); await until(() => Boolean(release)); const state = ctx.store.state(ctx.branchId); state.entities[0].description = '外貌已改变'; ctx.store.commit(ctx.branchId, ctx.base(), state, '资料修订'); release(); await until(() => ctx.store.images.get(original.image.id)?.status === 'stale'); expect(imageModel).not.toHaveBeenCalled();
  });
  it('marks a CG waiting for a portrait stale when rollback removes its source chapter', async () => {
    let release!: () => void; const imageModel = vi.fn<ImageGenerator>(async () => { await new Promise<void>(resolve => { release = resolve; }); return { bytes: png, mimeType: 'image/png' }; }); const ctx = harness(imageModel);
    const portrait = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon' }); await until(() => Boolean(release));
    const cg = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id }); await new Promise(resolve => setTimeout(resolve, 5)); expect(ctx.store.images.get(cg.image.id)?.status).toBe('queued');
    const creation = ctx.store.history(ctx.branchId).find(revision => revision.chapterCount === 0)!; ctx.store.rollback(ctx.branchId, { baseRevisionId: ctx.base(), revisionId: creation.id }); release();
    await until(() => ctx.store.images.get(cg.image.id)?.status === 'stale'); expect(ctx.store.images.get(portrait.image.id)?.status).toBe('stale'); expect(imageModel).toHaveBeenCalledTimes(1);
  });
  it('passes both confirmed character portraits to CG with ordered labels and retained story binding', async () => {
    const imageModel = vi.fn<ImageGenerator>(async () => ({ bytes: png, mimeType: 'image/png' })); const optimizer = vi.fn<ImagePromptOptimizer>(defaultOptimizer); const ctx = harness(imageModel, optimizer);
    const first = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon' }); const second = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'river' }); await until(() => [first.image.id, second.image.id].every(id => ctx.store.images.get(id)?.status === 'completed'));
    const cg = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id }); await until(() => ctx.store.images.get(cg.image.id)?.status === 'completed'); const asset = ctx.store.images.get(cg.image.id)!;
    expect(asset.referenceEntityIds).toEqual(['moon', 'river']); expect(asset.referenceImageIds).toEqual([first.image.id, second.image.id]); expect(asset.referenceCharacters?.map(character => character.name)).toEqual(['林月', '程川']); expect(asset.sourceText).toBe('林月和程川站在庭院里，共同望向天空。'); expect(asset.prompt).toContain('参考图 1：人物 林月'); expect(asset.prompt).toContain('参考图 2：人物 程川'); const references = imageModel.mock.calls.at(-1)![4]; expect(Array.isArray(references)).toBe(true); expect(references).toHaveLength(2);
  });
  it('reoptimizes CG without reference pictures after the author turns character references off', async () => {
    let calls = 0; const imageModel = vi.fn<ImageGenerator>(async () => { if (++calls === 3) throw new Error('CG fixture failed'); return { bytes: png, mimeType: 'image/png' }; }); const optimizer = vi.fn<ImagePromptOptimizer>(defaultOptimizer); const ctx = harness(imageModel, optimizer);
    const first = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'moon' }); const second = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'portrait', entityId: 'river' }); await until(() => [first.image.id, second.image.id].every(id => ctx.store.images.get(id)?.status === 'completed'));
    const cg = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id }); await until(() => ctx.store.images.get(cg.image.id)?.status === 'failed'); expect(imageModel.mock.calls[2][4]).toHaveLength(2); ctx.saved.imageSettings!.useCharacterReferences = false;
    const retry = ctx.service.retry(ctx.branchId, cg.image.id, ctx.base()); await until(() => ctx.store.images.get(retry.image.id)?.status === 'completed'); expect(optimizer).toHaveBeenCalledTimes(4); expect(imageModel.mock.calls[3][4]).toBeUndefined(); expect(ctx.store.images.get(retry.image.id)?.referenceCharacters).toEqual([]);
  });
  it('keeps nonportrait character material private after a source character becomes secret, including after restore', async () => {
    const ctx = harness(); const cg = ctx.service.generate(ctx.branchId, { baseRevisionId: ctx.base(), kind: 'cg', chapterId: ctx.chapter.id }); await until(() => ctx.store.images.get(cg.image.id)?.status === 'completed'); const image = ctx.store.images.get(cg.image.id)!;
    expect(image.referenceImageIds).toEqual([]); expect(image.materialEntityIds).toEqual(['moon', 'river']); expect(ctx.service.list(ctx.branchId)).toHaveLength(1); expect(ctx.service.list(ctx.branchId)[0].materialEntityIds).toBeUndefined();
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.store.getBranch(ctx.branchId).projectId)); const restoredImage = ctx.store.images.all(restored.id)[0]; expect(restoredImage.materialEntityIds).toEqual(ctx.store.state(restored.mainBranchId).entities.map(entity => entity.id)); expect(restoredImage.materialEntityIds).not.toContain('moon');
    const state = ctx.store.state(restored.mainBranchId); state.entities[0].visibility = 'secret'; ctx.store.commit(restored.mainBranchId, ctx.store.getBranch(restored.mainBranchId).revisionId, state, '资料设为秘密'); expect(ctx.service.list(restored.mainBranchId)).toEqual([]); expect(ctx.store.view(restored.mainBranchId).state.imageIds).toEqual([]); expect(() => ctx.service.content(restored.mainBranchId, restoredImage.id)).toThrow('不包含'); expect(ctx.service.list(restored.mainBranchId, true)).toHaveLength(1);
  });
});
