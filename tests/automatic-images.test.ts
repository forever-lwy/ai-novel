import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { ImageService } from '../server/images.js';
import type { ImageGenerator } from '../server/image-provider.js';
import { Store } from '../server/store.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import type { Entity, ExtractionResult, Job, ModelRequest, Settings, WritingImageRequest } from '../shared/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF4QAAAAASUVORK5CYII=', 'base64');
const prose = '林舟身穿青色长袍走进城门。\n城外千军万马正在迎战。';
const scene = '城外千军万马正在迎战。';
const fixtures: { store: Store; engines: StoryEngine[]; images: ImageService }[] = [];

afterEach(async () => {
  for (const ctx of fixtures.splice(0)) {
    await Promise.all(ctx.engines.map(engine => engine.close()));
    await ctx.images.close(); ctx.store.close();
  }
});

const extracted = (): ExtractionResult => ({
  summary: '林舟入城，城外大战。',
  entities: [{ kind: 'character', name: '林舟', aliases: [], description: '青色长袍', visibility: 'public', nameStatus: 'confirmed', facts: [{ text: '身穿青色长袍', attribute: 'appearance', temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 1, quote: '林舟身穿青色长袍走进城门。' }] }],
  relations: [], foreshadows: [],
});
const emptyExtraction = (): ExtractionResult => ({ summary: '人物继续前行。', entities: [], relations: [], foreshadows: [] });
type Turn = { text: string; extraction: ExtractionResult; images: WritingImageRequest[] };
async function until(done: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!done()) { if (Date.now() >= deadline) throw new Error('等待自动图片测试状态超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

function harness(turns: Turn[], options: { autoCG?: boolean; autoPortrait?: boolean; failImage?: boolean; failExtractionOnce?: boolean } = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-automatic-images-')));
  const project = store.createProject({ title: '自动插画集成测试' });
  const settings: Settings = {
    providers: [{ id: 'fixture', name: '模拟服务', protocol: 'openai-chat', baseUrl: 'http://fixture.invalid/v1', model: 'text', maxOutputTokens: 1024, contextTokens: 64000 }],
    writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture',
    imageSettings: { ...defaultImageSettings(), providerId: 'fixture', model: 'picture', autoCG: options.autoCG ?? true, autoPortrait: options.autoPortrait ?? true },
  };
  const generator = vi.fn<ImageGenerator>(async () => {
    if (options.failImage) throw new Error('模拟图片模型失败');
    return { bytes: png, mimeType: 'image/png' };
  });
  const optimizer = vi.fn(async (_settings, input) => ({ prompt: `优化后的小说插画：${input.material}`, referenceEntityIds: [], parameters: {} }));
  const images = new ImageService(store, () => settings, generator, optimizer);
  const requests: ModelRequest[] = [];
  let currentTurn = -1; let failedExtraction = false;
  const models: TextModels = {
    generateText: vi.fn(async (_provider, request) => {
      const turn = turns[++currentTurn]; requests.push(request);
      request.onTextDelta?.(turn.text);
      for (const image of turn.images) {
        const name = image.kind === 'portrait' ? 'generate_character_portrait' : 'generate_scene_cg';
        const tool = request.tools?.find(tool => tool.name === name);
        if (tool) await tool.execute(image.kind === 'portrait' ? { name: image.name, description: image.description } : image.prompt ? { sceneDescription: image.sceneDescription, prompt: image.prompt, referenceNames: image.referenceNames, parameters: image.parameters } : { sourceText: image.sourceText, description: image.description });
      }
      return { text: turn.text, inputTokens: 10, outputTokens: 20 };
    }),
    generateStructured: vi.fn(async (_provider, request, validate) => {
      if (request.system.includes('独立的插画定位任务')) {
        const scenes = JSON.parse(request.prompt.split('\n')[1]) as { id: string; sceneDescription: string }[];
        return { value: validate({ placements: scenes.map(image => ({ imageId: image.id, paragraph: image.sceneDescription.includes('不存在') ? null : 2 })) }), inputTokens: 2, outputTokens: 3 };
      }
      if (options.failExtractionOnce && !failedExtraction) { failedExtraction = true; throw new Error('模拟资料整理失败'); }
      return { value: validate(turns[Math.max(0, currentTurn)].extraction), inputTokens: 4, outputTokens: 8 };
    }),
  };
  const engine = new StoryEngine(store, () => settings, models, images);
  const fixture = { store, engines: [engine], images }; fixtures.push(fixture); engine.start();
  const start = (branchId = project.mainBranchId, selectedEngine = engine) => selectedEngine.enqueue(branchId, 'generate', { title: '新章节', baseRevisionId: store.getBranch(branchId).revisionId, mode: 'original', instruction: '继续创作' });
  return { ...fixture, project, engine, start, settings, models, generator, optimizer, requests };
}
async function finish(ctx: ReturnType<typeof harness>, imageCount: number, projectId = ctx.project.id) {
  await until(() => ctx.engine.listJobs(projectId).filter(job => job.kind === 'extract').some(job => job.status === 'completed') && ctx.engine.listJobs(projectId).every(job => job.status === 'completed') && ctx.store.images.all(projectId).length === imageCount && ctx.store.images.all(projectId).every(image => ['completed', 'failed'].includes(image.status)));
}
const requested = (cgText = '城外两支军队交战，千军万马的远景'): WritingImageRequest[] => [{ kind: 'portrait', name: '林舟', description: '青色长袍，站立在城门边' }, { kind: 'cg', sceneDescription: cgText, description: '千军万马交战的远景', prompt: '千军万马交战的远景' }];

describe('automatic images across writing, extraction and image persistence', () => {
  it('uses the writing model final prompt and parameter suggestions directly, with explicit character references', async () => {
    const prompt = '林舟身穿青色长袍站在城门边，远处千军万马交战，日光穿过烟尘，低机位广角构图。';
    const cg: WritingImageRequest = { kind: 'cg', description: prompt, prompt, sceneDescription: '城外两支军队正在激战', referenceNames: ['林舟'], parameters: { size: '1536x1024' } };
    const ctx = harness([{ text: prose, extraction: extracted(), images: [requested()[0], cg] }]); ctx.settings.imageSettings!.size = 'auto';
    // The portrait still uses its optimizer, so give it a valid auto size.
    ctx.optimizer.mockImplementation(async (_settings, input) => ({ prompt: `PORTRAIT_ONLY ${input.material}`, referenceEntityIds: [], parameters: { size: '1024x1536' } }));
    ctx.start(); await finish(ctx, 2);
    const asset = ctx.images.list(ctx.project.mainBranchId, true).find(image => image.kind === 'cg')!;
    expect(asset).toMatchObject({ writingPrompt: prompt, promptSource: 'writing', generationParameters: { size: '1536x1024' }, sourceText: scene });
    expect(asset.prompt).toContain(prompt); expect(asset.prompt).toContain('参考图 1：人物 林舟'); expect(asset.prompt).not.toContain('PORTRAIT_ONLY');
    expect(asset.storyContext).toBeUndefined(); expect(ctx.optimizer).toHaveBeenCalledTimes(1);
    expect(ctx.generator.mock.calls.find(call => call[2].includes(prompt))?.[4]).toHaveLength(1);
    const tool = ctx.requests[0].tools!.find(tool => tool.name === 'generate_scene_cg')!;
    expect(tool.parameters.required).toEqual(['prompt', 'sceneDescription']);
    expect(tool.description).toContain('requested'); expect(tool.description).toContain('rejected/error');
    expect(tool.description).not.toMatch(/主动|继续写作|不必等待|另一个 AI|当前绘图要求|fixedParameters|stylePrompt/);
    expect(ctx.requests[0].messages?.some(message => message.content.includes(ctx.settings.imageSettings!.stylePrompt))).toBe(true);
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
    expect(ctx.store.images.all(restored.id).find(image => image.kind === 'cg')).toMatchObject({ writingPrompt: prompt, promptSource: 'writing', writingReferenceNames: ['林舟'] });
  });

  it('keeps the writing prompt through pixel retry and honors no-reference intent and fixed dimensions', async () => {
    const prompt = '城外千军万马交战，远景构图。';
    const ctx = harness([{ text: prose, extraction: extracted(), images: [{ kind: 'cg', description: prompt, prompt, sceneDescription: '城外两支军队正在激战', referenceNames: [], parameters: { size: '1536x1024' } }] }], { autoPortrait: false, failImage: true });
    ctx.start(); await finish(ctx, 1); const previous = ctx.images.list(ctx.project.mainBranchId, true)[0];
    expect(previous.promptSource).toBe('writing'); expect(ctx.optimizer).not.toHaveBeenCalled(); expect(previous.generationParameters?.size).toBe('1024x1024');
    ctx.generator.mockResolvedValue({ bytes: png, mimeType: 'image/png' });
    const retry = ctx.images.retry(ctx.project.mainBranchId, previous.id, ctx.store.getBranch(ctx.project.mainBranchId).revisionId);
    await until(() => ctx.store.images.get(retry.image.id)?.status === 'completed');
    expect(ctx.optimizer).not.toHaveBeenCalled(); expect(ctx.generator.mock.calls.at(-1)![2]).toBe(previous.prompt); expect(ctx.generator.mock.calls.at(-1)![4]).toBeUndefined();
    ctx.settings.imageSettings!.size = '1024x1536';
    const changed = ctx.images.retry(ctx.project.mainBranchId, retry.image.id, ctx.store.getBranch(ctx.project.mainBranchId).revisionId);
    await until(() => ctx.store.images.get(changed.image.id)?.status === 'completed'); expect(ctx.optimizer).not.toHaveBeenCalled();
    expect(ctx.store.images.get(changed.image.id)).toMatchObject({ writingPrompt: prompt, promptSource: 'writing', generationParameters: { size: '1024x1536' } });
    const redraw = ctx.images.generate(ctx.project.mainBranchId, { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, kind: 'cg', chapterId: previous.chapterId, selection: previous.selection });
    await until(() => ctx.store.images.get(redraw.image.id)?.status === 'completed'); expect(ctx.optimizer).toHaveBeenCalledTimes(1);
    expect(ctx.optimizer.mock.calls[0][1].storyContext).toContain('林舟身穿青色长袍');
  });
  it('ignores automatic portrait requests when character references are disabled, while preserving the writing prompt', async () => {
    const prompt = '古城墙外的战场远景。';
    const ctx = harness([{ text: prose, extraction: extracted(), images: [{ kind: 'cg', description: prompt, prompt, sceneDescription: '城外两支军队正在激战', referenceNames: ['不存在的参考名'] }] }], { autoPortrait: false });
    ctx.settings.imageSettings!.useCharacterReferences = false;
    ctx.start(); await finish(ctx, 1);
    const image = ctx.images.list(ctx.project.mainBranchId, true)[0]; expect(image.status).toBe('completed');
    expect(image.prompt).toContain(prompt); expect(image.referenceImageIds).toEqual([]); expect(ctx.optimizer).not.toHaveBeenCalled();
  });

  it('runs actual ImageService after tool requests and binds portrait and CG to the saved chapter', async () => {
    const ctx = harness([{ text: prose, extraction: extracted(), images: requested() }]);
    const writing = ctx.start(); await finish(ctx, 2);
    const state = ctx.store.state(ctx.project.mainBranchId); const chapter = state.chapters[0];
    const assets = ctx.images.list(ctx.project.mainBranchId, true).sort((a, b) => a.kind === b.kind ? 0 : a.kind === 'portrait' ? -1 : 1);
    expect(ctx.store.chapter(ctx.project.mainBranchId, chapter.id).text).toBe(prose);
    expect(assets.map(image => image.kind)).toEqual(['portrait', 'cg']);
    expect(assets[0]).toMatchObject({ status: 'completed', entityId: state.entities[0].id, chapterId: chapter.id, automatic: true });
    expect(assets[0].prompt).toContain('青色长袍，站立在城门边');
    expect(assets[1]).toMatchObject({ status: 'completed', chapterId: chapter.id, sourceText: scene, selection: { start: prose.indexOf(scene), end: prose.length }, automatic: true });
    expect(ctx.images.content(ctx.project.mainBranchId, assets[0].id, true).bytes).toEqual(png);
    expect(state.imageIds).toEqual(expect.arrayContaining(assets.map(image => image.id)));
    expect(ctx.generator).toHaveBeenCalledTimes(2);
    expect(ctx.models.generateText).toHaveBeenCalledTimes(1);
    const background = ctx.engine.listJobs().find(job => job.kind === 'extract')!;
    expect(background.baseRevisionId).toBe(ctx.store.getBranch(ctx.project.mainBranchId).revisionId);
    const payload = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(writing.id)!.data)).payload;
    expect(payload.imageRequests).toHaveLength(2);
    expect(ctx.images.list(ctx.project.mainBranchId, false)).toEqual([]);
  });

  it('keeps automatic CG disabled while still generating a newly extracted character', async () => {
    const ctx = harness([{ text: prose, extraction: extracted(), images: requested() }], { autoCG: false });
    ctx.start(); await finish(ctx, 1);
    expect(ctx.requests[0].tools?.some(tool => tool.name === 'generate_scene_cg')).toBe(false);
    expect(ctx.images.list(ctx.project.mainBranchId, true).map(image => image.kind)).toEqual(['portrait']);
  });

  it('generates new portraits from extraction even if the writing model omits its optional tool call', async () => {
    const ctx = harness([{ text: prose, extraction: extracted(), images: [] }]);
    ctx.start(); await finish(ctx, 1);
    const state = ctx.store.state(ctx.project.mainBranchId);
    expect(ctx.images.list(ctx.project.mainBranchId, true)[0].entityId).toBe(state.entities[0].id);
    expect(ctx.images.list(ctx.project.mainBranchId, false)).toHaveLength(1);
  });

  it('does not redraw an existing character when a later chapter calls the portrait tool again', async () => {
    const later = '林舟身穿青色长袍沿城墙前行。';
    const laterExtraction = extracted(); laterExtraction.entities[0].facts[0].quote = later;
    const ctx = harness([{ text: prose, extraction: extracted(), images: requested() }, { text: later, extraction: laterExtraction, images: [{ kind: 'portrait', name: '林舟', description: '青色长袍' }] }]);
    ctx.start(); await finish(ctx, 2);
    ctx.start(); await finish(ctx, 2);
    expect(ctx.store.state(ctx.project.mainBranchId).chapters).toHaveLength(2);
    expect(ctx.images.list(ctx.project.mainBranchId, true).filter(image => image.kind === 'portrait')).toHaveLength(1);
    expect(ctx.generator).toHaveBeenCalledTimes(2);
    expect(ctx.models.generateText).toHaveBeenCalledTimes(2);
  });

  it('keeps an unmatched scene bound to its chapter without inventing a source position or character identity', async () => {
    const ctx = harness([{ text: prose, extraction: emptyExtraction(), images: [{ kind: 'portrait', name: '未出场的人物', description: '银甲' }, { kind: 'cg', description: '未来大场面', prompt: '未来大场面', sceneDescription: '正文中不存在的未来场景' }] }]);
    ctx.start(); await finish(ctx, 2);
    const portrait = ctx.store.images.all().find(image => image.kind === 'portrait')!;
    const cg = ctx.store.images.all().find(image => image.kind === 'cg')!;
    expect(portrait).toMatchObject({ bindingStatus: 'pending', error: expect.stringContaining('图片未关联：') });
    expect(portrait.entityId).toBeUndefined();
    expect(cg).toMatchObject({ status: 'completed', bindingStatus: 'bound', placementStatus: 'unmatched', chapterId: ctx.store.state(ctx.project.mainBranchId).chapters[0].id });
    expect(cg.sourceText).toBeUndefined(); expect(cg.selection).toBeUndefined();
    expect(ctx.store.state(ctx.project.mainBranchId).imageIds ?? []).toEqual([cg.id]);
    expect(ctx.store.state(ctx.project.mainBranchId).chapters[0].status).toBe('ready');
  });

  it('skips a portrait request for an extracted name without any current-chapter appearance evidence', async () => {
    const extraction = emptyExtraction();
    extraction.entities.push({ kind: 'character', name: '从未出场的人物', aliases: [], description: '', visibility: 'public', nameStatus: 'confirmed', facts: [] });
    const ctx = harness([{ text: prose, extraction, images: [{ kind: 'portrait', name: '从未出场的人物', description: '银色盔甲' }] }]);
    ctx.start();
    await until(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed'));
    expect(ctx.store.images.all()).toHaveLength(1);
    expect(ctx.store.images.all()[0]).toMatchObject({ status: 'failed', bindingStatus: 'pending', error: expect.stringContaining('图片未关联') });
    expect(ctx.store.state(ctx.project.mainBranchId).imageIds ?? []).toEqual([]);
  });

  it('does not confuse same-name characters or assign an ambiguous request to either entity', async () => {
    const ctx = harness([{ text: prose, extraction: emptyExtraction(), images: [{ kind: 'portrait', name: '林舟', description: '只属于某个同名人物的紫色盔甲' }] }]);
    for (const description of ['东城的旅人', '西城的文士']) {
      const entity: Entity = { id: description, name: '林舟', kind: 'character', aliases: [], description, visibility: 'public', locked: true, facts: [] };
      ctx.store.updateEntity(ctx.project.mainBranchId, ctx.store.getBranch(ctx.project.mainBranchId).revisionId, entity);
    }
    ctx.start(); await finish(ctx, 0);
    expect(ctx.store.state(ctx.project.mainBranchId).entities).toHaveLength(2);
    expect(ctx.generator).not.toHaveBeenCalled();
    const state = ctx.store.state(ctx.project.mainBranchId);
    const result = ctx.images.generateAutomatic(ctx.project.mainBranchId, ctx.store.getBranch(ctx.project.mainBranchId).revisionId, state.chapters[0].id, [{ kind: 'portrait', name: '林舟', description: '不允许错误绑定的紫色盔甲' }], state.entities.map(entity => entity.id));
    expect(result!.images).toHaveLength(2);
    expect(result!.images.map(image => image.entityId)).toEqual(state.entities.map(entity => entity.id));
    expect(result!.images.every(image => !image.prompt.includes('紫色盔甲'))).toBe(true);
    await until(() => ctx.store.images.all().every(image => image.status === 'completed'));
  });

  it('preserves successful prose and extraction when the actual image generator fails', async () => {
    const ctx = harness([{ text: prose, extraction: extracted(), images: requested() }], { failImage: true });
    ctx.start(); await finish(ctx, 2);
    expect(ctx.store.chapter(ctx.project.mainBranchId, ctx.store.state(ctx.project.mainBranchId).chapters[0].id).text).toBe(prose);
    expect(ctx.engine.listJobs().every(job => job.status === 'completed')).toBe(true);
    expect(ctx.images.list(ctx.project.mainBranchId, true).every(image => image.status === 'failed')).toBe(true);
    expect(ctx.models.generateText).toHaveBeenCalledTimes(1);
    expect(ctx.generator).toHaveBeenCalledTimes(2);
  });

  it('resumes saved illustration requests after extraction fails without regenerating prose', async () => {
    const ctx = harness([{ text: prose, extraction: extracted(), images: requested() }], { failExtractionOnce: true });
    ctx.start(); await until(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'failed'));
    const background = ctx.engine.listJobs().find(job => job.kind === 'extract')!;
    ctx.engine.action(background.id, 'retry'); await finish(ctx, 2);
    expect(ctx.models.generateText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.models.generateStructured).mock.calls.filter(([, request]) => !request.system.includes('独立的插画定位任务'))).toHaveLength(2);
    expect(ctx.generator).toHaveBeenCalledTimes(2);
  });

  it('remaps saved starting character IDs on backup restore before resuming automatic images', async () => {
    const text = `${prose}\n沈宁来到城门。`;
    const ctx = harness([{ text, extraction: extracted(), images: requested() }], { failExtractionOnce: true });
    ctx.store.updateEntity(ctx.project.mainBranchId, ctx.store.getBranch(ctx.project.mainBranchId).revisionId, { id: 'old-character', name: '沈宁', kind: 'character', aliases: [], description: '此前已有的人物', visibility: 'public', locked: true, facts: [] });
    const oldId = ctx.store.state(ctx.project.mainBranchId).entities[0].id;
    ctx.start(); await until(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'failed'));
    await ctx.engine.close();
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
    const restoredOldId = ctx.store.state(restored.mainBranchId).entities[0].id;
    expect(restoredOldId).not.toBe(oldId);
    const writingRow = ctx.store.db.prepare("SELECT data FROM jobs WHERE project_id=? AND json_extract(data,'$.kind')='generate'").get(restored.id)!;
    expect(JSON.parse(String(writingRow.data)).payload.imageStartingEntityIds).toEqual([restoredOldId]);
    const replacement = new StoryEngine(ctx.store, () => ctx.settings, ctx.models, ctx.images);
    ctx.engines.push(replacement); ctx.engine = replacement; replacement.start();
    const background = replacement.listJobs(restored.id).find(job => job.kind === 'extract')!;
    replacement.action(background.id, 'retry'); await finish(ctx, 2, restored.id);
    const assets = ctx.images.list(restored.mainBranchId, true);
    expect(assets.filter(image => image.kind === 'portrait')).toHaveLength(1);
    expect(assets.some(image => image.entityId === restoredOldId)).toBe(false);
    expect(ctx.models.generateText).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('recovers a ready chapter with a durable pending illustration marker after restart, images=%s', async withImages => {
    const extraction = withImages ? extracted() : emptyExtraction();
    const ctx = harness([{ text: prose, extraction, images: withImages ? requested() : [] }], { failExtractionOnce: true });
    ctx.start(); await until(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'failed'));
    await ctx.engine.close();
    const background = ctx.engine.listJobs().find(job => job.kind === 'extract')!;
    const job = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(background.id)!.data)) as Job;
    const chapterId = String(job.payload.extractChapterId);
    // Reproduce a process stopping after the final extraction transaction and
    // before the independent image-registration transaction begins.
    ctx.store.applyExtraction(job.branchId, job.baseRevisionId, chapterId, extraction, true, revisionId => {
      job.baseRevisionId = revisionId; job.status = 'running';
      job.payload.blockIndex = 1; job.payload.pendingIllustrationChapterId = chapterId;
      ctx.store.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(job.status, JSON.stringify(job), job.id);
    });
    const replacement = new StoryEngine(ctx.store, () => ctx.settings, ctx.models, ctx.images);
    ctx.engines.push(replacement); ctx.engine = replacement; replacement.start();
    expect(replacement.listJobs().find(current => current.id === job.id)!.status).toBe('paused');
    replacement.action(job.id, 'resume'); await finish(ctx, withImages ? 2 : 0);
    const saved = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data)) as Job;
    expect(saved.status).toBe('completed');
    expect(saved.baseRevisionId).toBe(ctx.store.getBranch(job.branchId).revisionId);
    expect(saved.payload.pendingIllustrationChapterId).toBeUndefined();
    expect(saved.payload.imagesRequestedFor).toBe(chapterId);
    expect(ctx.models.generateText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.models.generateStructured).mock.calls.filter(([, request]) => !request.system.includes('独立的插画定位任务'))).toHaveLength(1);
    expect(ctx.generator).toHaveBeenCalledTimes(withImages ? 2 : 0);
  });
});
