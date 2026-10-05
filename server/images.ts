import { randomUUID } from 'node:crypto';
import type { BranchView, Entity, ImageGenerateInput, Settings, StoryImage, StoryState, WritingImageRequest } from '../shared/types.js';
import { normalizeImageSettings } from '../shared/image-settings.js';
import { findEntitiesByName } from './entity-resolution.js';
import { rebuildCharacterProfileDescription } from './extraction.js';
import { generateImage, validateImageParameters, type ImageGenerator } from './image-provider.js';
import { imageEntity, imageReferences, type ImageContent, validateImageContent } from './image-store.js';
import { Store, HttpError } from './store.js';
import { imageModelCapabilities } from '../shared/image-capabilities.js';
import { optimizeImagePrompt, resolveImageParameters, type ImagePromptOptimizer, type ImagePromptInput } from './image-prompts.js';

const stamp = () => new Date().toISOString();
const entityText = (entity: Entity) => `${entity.kind}：${entity.name}\n${entity.description}\n${entity.facts.map(fact => `${fact.temporal === 'future' ? '未来设定：' : ''}${fact.text}`).join('\n')}`;
const publicEntity = (entity: Entity) => entity.visibility === 'public' && !entity.facts.some(fact => fact.visibility === 'secret' || fact.temporal === 'future') && (entity.locked || !entity.description.trim() || entity.description === entity.facts.map(fact => fact.text).join('；') || entity.description === rebuildCharacterProfileDescription({ ...entity, description: '' }));

/** Requests are explicitly queued once; restarts and failures never repeat a paid call. */
export class ImageService {
  private queue: string[] = [];
  private controllers = new Map<string, AbortController>();
  private runs = new Map<string, Promise<void>>();
  private deletingProjects = new Set<string>();
  private closed = false;
  constructor(private store: Store, private getSettings: () => Settings, private generator: ImageGenerator = generateImage, private optimizer: ImagePromptOptimizer = optimizeImagePrompt) {
    for (const image of store.images.all()) if (['queued', 'running'].includes(image.status)) {
      image.status = 'paused'; image.error = '服务已重启；请手动重试生图，可能会产生新的费用'; this.save(image);
    }
  }
  private save(image: StoryImage, content?: ImageContent) { image.updatedAt = stamp(); this.store.images.update(image, content); }
  private configuration(optional = false) {
    const settings = this.getSettings(); const config = normalizeImageSettings(settings.imageSettings);
    const provider = settings.providers.find(item => item.id === config.providerId);
    if (!provider || !config.model.trim()) { if (optional) return undefined; throw new HttpError('请先在设置中选择生图服务并填写生图模型'); }
    validateImageParameters(config);
    return { config, provider };
  }
  private available(branchId: string, base: string, checkJobs = true) {
    if (this.closed) throw new HttpError('生图服务已停止', 409);
    const branch = this.store.assertVersion(branchId, base);
    if (this.deletingProjects.has(branch.projectId)) throw new HttpError('作品正在删除，请稍候', 409);
    if (checkJobs && this.store.db.prepare("SELECT 1 FROM jobs WHERE branch_id=? AND status IN ('queued','running','paused') LIMIT 1").get(branchId)) throw new HttpError('请先完成或取消本故事线的文字任务，再操作图片', 409);
    return branch;
  }
  private find(branchId: string, imageId: string, author: boolean): StoryImage {
    const branch = this.store.getBranch(branchId); const image = this.store.images.get(imageId);
    const state = this.store.state(branchId);
    if (!image || image.projectId !== branch.projectId || !this.store.images.visible(image, state, author)) throw new HttpError('此故事线不包含可查看的图片', 404);
    return image;
  }
  private publicImage(image: StoryImage, branchId: string, author: boolean): StoryImage {
    const url = image.status === 'completed' ? `/api/branches/${encodeURIComponent(branchId)}/images/${encodeURIComponent(image.id)}/content?view=${author ? 'author' : 'reader'}` : undefined;
    const entityId = image.entityId ? imageEntity(this.store.state(branchId), image.entityId)?.id : undefined;
    const referenceCharacters = image.referenceCharacters?.map(character => { const current = imageEntity(this.store.state(branchId), character.entityId); return { ...character, entityId: current?.id ?? character.entityId, name: current?.name ?? character.name }; });
    const active = this.store.images.active(image, this.store.state(branchId));
    return author ? { ...image, entityId, referenceCharacters, active, url } : { ...image, entityId, active, prompt: '', sourceText: undefined, selection: undefined, referenceImageId: undefined, error: undefined, material: undefined, instruction: undefined, materialEntityIds: undefined, referenceImageIds: undefined, referenceEntityIds: undefined, referenceCharacters: undefined, generationParameters: undefined, promptStatus: undefined, optimizedAt: undefined, url };
  }
  list(branchId: string, author = false): StoryImage[] {
    const branch = this.store.getBranch(branchId); const state = this.store.state(branchId);
    return (state.imageIds ?? []).flatMap(imageId => { const image = this.store.images.get(imageId); return image && image.projectId === branch.projectId && this.store.images.visible(image, state, author) ? [this.publicImage(image, branchId, author)] : []; });
  }
  content(branchId: string, imageId: string, author = false): ImageContent {
    const image = this.find(branchId, imageId, author); if (image.status !== 'completed') throw new HttpError('图片尚未生成完成', 409);
    const content = this.store.images.content(imageId); if (!content) throw new HttpError('图片内容不存在', 404); return content;
  }
  setActive(branchId: string, imageId: string, baseRevisionId: string, active: boolean): { view: BranchView; images: StoryImage[] } {
    this.available(branchId, baseRevisionId); const image = this.find(branchId, imageId, true);
    if (active && image.status !== 'completed') throw new HttpError('图片完成后才能启用', 409);
    const state = this.store.state(branchId); this.store.images.hydrate(state); const group = this.store.images.groupKey(image, state);
    state.activeImageIds = state.activeImageIds!.filter(id => { const selected = this.store.images.get(id); return id !== imageId && (!active || !selected || this.store.images.groupKey(selected, state) !== group); });
    if (active) state.activeImageIds.push(imageId);
    const view = this.store.commit(branchId, baseRevisionId, state, `${active ? '启用' : '停用'}图片：${image.title}`); this.stopInvalidRuns(branchId); this.pump();
    return { view, images: this.list(branchId, true) };
  }
  delete(branchId: string, imageId: string, baseRevisionId: string): { view: BranchView; images: StoryImage[] } {
    this.available(branchId, baseRevisionId); const image = this.find(branchId, imageId, true); const state = this.store.state(branchId); this.store.images.hydrate(state);
    state.imageIds = (state.imageIds ?? []).filter(id => id !== imageId); state.activeImageIds = state.activeImageIds!.filter(id => id !== imageId);
    const view = this.store.commit(branchId, baseRevisionId, state, `删除当前故事线图片：${image.title}`); this.stopInvalidRuns(branchId); this.pump();
    return { view, images: this.list(branchId, true) };
  }
  private stopInvalidRuns(branchId: string) {
    for (const image of this.store.images.all()) if (image.branchId === branchId && ['queued', 'running'].includes(image.status)) {
      if (this.current(image)) continue;
      image.status = 'stale'; image.error = '图片或参考图的启用状态已变化，请按当前选择重新生成'; this.save(image); this.controllers.get(image.id)?.abort();
    }
  }
  private prepare(branchId: string, input: ImageGenerateInput, automatic: boolean, state: StoryState, extraDescription = ''): StoryImage {
    const { config } = this.configuration()!; const branch = this.store.getBranch(branchId);
    if (input.chapterId && !state.chapters.some(chapter => chapter.id === input.chapterId)) throw new HttpError('用于生图的章节不属于当前故事线');
    if (input.selection && input.kind !== 'cg') throw new HttpError('正文选区只能用于生成 CG');
    if (input.entityId && (input.kind === 'cg' || input.kind === 'map')) throw new HttpError('CG 和地图不能绑定单个资料实体');
    let title = '', material = '', visibility: StoryImage['visibility'] = input.instruction?.trim() || extraDescription.trim() ? 'secret' : 'public';
    let sourceText: string | undefined;
    if (input.kind === 'portrait' || input.kind === 'entity') {
      const entity = state.entities.find(item => item.id === input.entityId && !item.mergedInto);
      if (!entity || input.kind === 'portrait' && entity.kind !== 'character') throw new HttpError('请选择当前故事线中对应的人物或资料');
      title = `${entity.name} · ${input.kind === 'portrait' ? '立绘' : '资料图'}`; material = entityText(entity);
      if (!publicEntity(entity)) visibility = 'secret';
    } else if (input.kind === 'map') {
      const locations = state.entities.filter(entity => entity.kind === 'location' && !entity.mergedInto);
      if (!locations.length) throw new HttpError('请先添加地点资料再生成地图');
      title = '世界地图'; material = locations.map(entityText).join('\n\n');
      const locationIds = new Set(locations.map(entity => entity.id));
      const relations = state.relations.filter(relation => locationIds.has(relation.fromId) && locationIds.has(relation.toId));
      material += '\n地点关系：\n' + relations.map(relation => `${locations.find(entity => entity.id === relation.fromId)!.name} — ${relation.label} — ${locations.find(entity => entity.id === relation.toId)!.name}`).join('\n');
      if (locations.some(entity => !publicEntity(entity)) || relations.some(relation => relation.visibility === 'secret')) visibility = 'secret';
    } else {
      if (!input.chapterId) throw new HttpError('请选择用于生成 CG 的章节');
      const chapter = this.store.chapter(branchId, input.chapterId); sourceText = chapter.text;
      if (input.selection) {
        const { start, end } = input.selection;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > chapter.text.length) throw new HttpError('选中的正文范围无效');
        sourceText = chapter.text.slice(start, end);
      }
      if (!sourceText.trim()) throw new HttpError('用于生成 CG 的剧情不能为空');
      title = `${chapter.title} · CG`; material = `章节：${chapter.title}\n剧情：\n${sourceText}`;
    }
    if (input.referenceImageId) {
      if (!input.instruction?.trim()) throw new HttpError('请填写对参考图片的修改要求');
      if (imageModelCapabilities(config).referenceMode === 'none') throw new HttpError('当前图片模型不支持参考图修改，请更换支持图片输入的模型');
      const reference = this.find(branchId, input.referenceImageId, true);
      if (reference.status !== 'completed' || !this.store.images.content(reference.id)) throw new HttpError('参考图片尚未完成，请先完成原图生成');
      if (!this.store.images.active(reference, state)) throw new HttpError('请先启用这张图片，再用 AI 修改');
      const referenceEntityId = reference.entityId ? imageEntity(state, reference.entityId)?.id : undefined;
      if (reference.kind !== input.kind || referenceEntityId !== input.entityId) throw new HttpError('参考图片必须属于同一种图片及对应资料');
      if (input.kind === 'cg' && (reference.chapterId !== input.chapterId || reference.sourceText !== sourceText)) throw new HttpError('参考 CG 必须绑定相同章节和剧情范围');
      if (reference.visibility === 'secret') visibility = 'secret';
    }
    const task = input.kind === 'portrait' ? '生成人物全身立绘，突出人物外貌、服装与气质。' : input.kind === 'map' ? '依据地点与地理关系生成地图，不要擅自增加未确认的城市或地点。' : input.kind === 'cg' ? '将已发生的剧情绘制为场景 CG，保持人物与环境一致。' : '依据资料生成对应实体的插画。';
    const description = [task, material, extraDescription && `写作模型对画面的要求：${extraDescription}`].filter(Boolean).join('\n\n');
    if (description.length > 100000) throw new HttpError('生图素材过长，请选择较短的剧情或精简资料');
    return { id: randomUUID(), projectId: branch.projectId, branchId, baseRevisionId: input.baseRevisionId, kind: input.kind, status: 'queued', title, prompt: '', material: description, instruction: input.instruction?.trim() || '', promptStatus: 'pending', entityId: input.entityId, chapterId: input.chapterId, selection: input.selection, sourceText, referenceImageId: input.referenceImageId, automatic, visibility, createdAt: stamp(), updatedAt: stamp() };
  }
  private register(branchId: string, baseRevisionId: string, state: StoryState, prepared: StoryImage[], checkpoint?: (revisionId: string) => void, retryOf?: string): { view: BranchView; images: StoryImage[] } {
    this.store.images.hydrate(state); const previousImages = (state.imageIds ?? []).flatMap(id => this.store.images.get(id) ?? []);
    const groups = new Set(previousImages.map(image => this.store.images.groupKey(image, state)));
    for (const image of prepared) {
      const group = this.store.images.groupKey(image, state);
      const transferIntent = retryOf && state.activeImageIds!.includes(retryOf) && !previousImages.some(old => this.store.images.groupKey(old, state) === group && old.status === 'completed');
      if (!groups.has(group) || transferIntent) { state.activeImageIds = state.activeImageIds!.filter(id => { const old = this.store.images.get(id); return !old || this.store.images.groupKey(old, state) !== group; }); state.activeImageIds.push(image.id); }
      groups.add(group);
    }
    state.imageIds = [...(state.imageIds ?? []), ...prepared.map(image => image.id)];
    const view = this.store.commit(branchId, baseRevisionId, state, prepared.length === 1 ? `生成图片：${prepared[0].title}` : '生成本章插画', revisionId => {
      for (const image of prepared) { image.baseRevisionId = revisionId; this.store.images.insert(image); }
      checkpoint?.(revisionId);
    });
    this.queue.push(...prepared.map(image => image.id)); queueMicrotask(() => this.pump());
    return { view, images: prepared.map(image => this.publicImage(image, branchId, true)) };
  }
  generate(branchId: string, input: ImageGenerateInput): { view: BranchView; image: StoryImage } {
    this.available(branchId, input.baseRevisionId); this.configuration(); const state = this.store.state(branchId);
    const result = this.register(branchId, input.baseRevisionId, state, [this.prepare(branchId, input, false, state)]); return { view: result.view, image: result.images[0] };
  }
  retry(branchId: string, imageId: string, baseRevisionId: string): { view: BranchView; image: StoryImage } {
    this.available(branchId, baseRevisionId); this.configuration(); const previous = this.find(branchId, imageId, true);
    if (['queued', 'running'].includes(previous.status)) throw new HttpError('图片仍在生成中，请先取消或等待完成', 409);
    const { config } = this.configuration()!;
    const sameModel = !previous.generationParameters || previous.generationParameters.model === config.model && previous.generationParameters.protocol === config.protocol;
    const sameReferences = !(config.useCharacterReferences === false && previous.referenceCharacters?.length);
    let sameDimensions = true;
    if (previous.generationParameters) { try { const selected = resolveImageParameters(config, previous.generationParameters); sameDimensions = Object.entries(selected).every(([key, value]) => previous.generationParameters?.[key as keyof typeof selected] === value); } catch { sameDimensions = false; } }
    const image: StoryImage = this.current(previous, branchId) && sameModel && sameReferences && sameDimensions ? { ...previous, id: randomUUID(), branchId, baseRevisionId, status: 'queued', automatic: false, createdAt: stamp(), updatedAt: stamp(), error: undefined, mimeType: undefined, url: undefined } : this.prepare(branchId, { baseRevisionId, kind: previous.kind, entityId: previous.entityId ? imageEntity(this.store.state(branchId), previous.entityId)?.id : undefined, chapterId: previous.chapterId, selection: previous.selection, instruction: previous.instruction, referenceImageId: previous.referenceImageId }, false, this.store.state(branchId));
    if (image.promptStatus !== 'completed') {
      if (this.sameStoryMaterial(previous, branchId) && previous.material !== undefined) { image.material = previous.material; image.instruction = previous.instruction ?? image.instruction; }
      image.material ??= previous.prompt; image.prompt = ''; image.promptStatus = 'pending';
    }
    const result = this.register(branchId, baseRevisionId, this.store.state(branchId), [image], undefined, previous.id); return { view: result.view, image: result.images[0] };
  }
  cancel(branchId: string, imageId: string): StoryImage {
    const image = this.find(branchId, imageId, true);
    if (['queued', 'running', 'paused'].includes(image.status)) { image.status = 'cancelled'; image.error = '作者已取消生图'; this.save(image); this.controllers.get(image.id)?.abort(); }
    return this.publicImage(image, branchId, true);
  }
  generateAutomatic(branchId: string, baseRevisionId: string, chapterId: string, requests: WritingImageRequest[], newCharacterIds: string[], checkpoint?: (revisionId: string) => void): { view: BranchView; images: StoryImage[] } | undefined {
    const configured = this.configuration(true); if (!configured || !configured.config.autoPortrait && !configured.config.autoCG) return undefined;
    this.available(branchId, baseRevisionId, false); const state = this.store.state(branchId); const prepared: StoryImage[] = [];
    const chapter = this.store.chapter(branchId, chapterId);
    const portraitIds = new Set<string>(); const sourceTexts = new Set<string>();
    const addPortrait = (entityId: string, description = '') => {
      const entity = imageEntity(state, entityId);
      if (!entity || entity.kind !== 'character' || !entity.facts.some(fact => fact.citation?.chapterId === chapterId) && ![entity.name, ...entity.aliases].some(name => name.trim() && chapter.text.includes(name))) return;
      if (prepared.length >= 12 || portraitIds.has(entityId) || (state.imageIds ?? []).some(id => { const existing = this.store.images.get(id); return existing?.kind === 'portrait' && existing.entityId && imageEntity(state, existing.entityId)?.id === entityId && ['queued', 'running', 'completed'].includes(existing.status); })) return;
      try { prepared.push(this.prepare(branchId, { baseRevisionId, kind: 'portrait', entityId, chapterId }, true, state, description)); portraitIds.add(entityId); }
      catch (error) { if (!(error instanceof HttpError)) throw error; }
    };
    for (const request of requests.slice(0, 30)) {
      if (request.kind === 'portrait' && configured.config.autoPortrait && request.name) {
        const found = findEntitiesByName(state, request.name, 'character');
        if (found.length === 1 && newCharacterIds.includes(found[0].id)) addPortrait(found[0].id, request.description);
      } else if (request.kind === 'cg' && configured.config.autoCG && request.sourceText?.trim() && prepared.length < 12) {
        const start = chapter.text.indexOf(request.sourceText);
        if (start < 0 || sourceTexts.has(request.sourceText)) continue;
        try {
          const image = this.prepare(branchId, { baseRevisionId, kind: 'cg', chapterId, selection: { start, end: start + request.sourceText.length } }, true, state, request.description);
          prepared.push(image); sourceTexts.add(request.sourceText);
        } catch (error) { if (!(error instanceof HttpError)) throw error; }
      }
    }
    if (configured.config.autoPortrait) for (const entityId of newCharacterIds) addPortrait(entityId);
    if (!prepared.length) return undefined;
    return this.register(branchId, baseRevisionId, state, prepared, checkpoint);
  }
  private pump() {
    while (!this.closed && this.runs.size < 2 && this.queue.length) {
      const index = this.queue.findIndex(id => { const image = this.store.images.get(id); if (!image || image.status !== 'queued') return true; try { return !this.current(image) || !this.waitingForPortrait(image); } catch { return true; } });
      if (index < 0) break;
      const id = this.queue.splice(index, 1)[0]; const image = this.store.images.get(id); if (!image || image.status !== 'queued' || this.deletingProjects.has(image.projectId)) continue;
      const controller = new AbortController(); this.controllers.set(id, controller);
      const run = this.run(image, controller.signal).finally(() => { this.controllers.delete(id); this.runs.delete(id); this.pump(); }); this.runs.set(id, run);
    }
  }
  private sceneCharacters(image: StoryImage, state: StoryState) {
    if (image.kind !== 'cg' || !image.chapterId) return [];
    const chapter = this.store.chapter(image.branchId, image.chapterId);
    const preceding = image.selection ? chapter.text.slice(Math.max(0, image.selection.start - 2000), image.selection.end) : chapter.text;
    return state.entities.filter(entity => entity.kind === 'character' && !entity.mergedInto && ([entity.name, ...entity.aliases].some(name => name.trim() && preceding.includes(name)) || entity.facts.some(fact => fact.citation && fact.citation.chapterId === image.chapterId && preceding.includes(fact.citation.quote))));
  }
  private waitingForPortrait(image: StoryImage) {
    const configured = this.configuration(true); if (!configured || image.kind !== 'cg' || configured.config.useCharacterReferences === false || imageModelCapabilities(configured.config).referenceMode === 'none') return false;
    const state = this.store.state(image.branchId); const candidates = new Set(this.sceneCharacters(image, state).map(entity => entity.id));
    return this.store.images.activeIds(state).some(id => { const portrait = this.store.images.get(id); return portrait?.kind === 'portrait' && portrait.entityId && candidates.has(imageEntity(state, portrait.entityId)?.id ?? '') && ['queued', 'running'].includes(portrait.status); });
  }
  private promptInput(image: StoryImage, config: NonNullable<Settings['imageSettings']>): ImagePromptInput {
    const state = this.store.revisionState(image.baseRevisionId); const caps = imageModelCapabilities(config);
    const current = this.store.state(image.branchId);
    const references: ImagePromptInput['references'] = image.referenceImageId ? [{ label: '待修改的原图', imageId: image.referenceImageId }] : [];
    const characters = this.sceneCharacters(image, state).map(entity => {
      const portraits = (state.imageIds ?? []).map(id => this.store.images.get(id)).filter((asset): asset is StoryImage => Boolean(asset && asset.kind === 'portrait' && this.store.images.active(asset, state) && this.store.images.active(asset, current) && asset.entityId && imageEntity(state, asset.entityId)?.id === entity.id));
      const asset = portraits.find(portrait => this.store.images.content(portrait.id));
      return { entityId: entity.id, name: entity.name, description: entityText(entity), imageId: config.useCharacterReferences !== false && caps.referenceMode !== 'none' ? asset?.id : undefined };
    });
    let material = image.material ?? image.prompt;
    if (image.kind === 'cg' && image.chapterId && image.selection) {
      const chapter = this.store.chapter(image.branchId, image.chapterId);
      material += `\n\n仅用于辨认代词所指人物的前文，不作为绘制场景：\n${chapter.text.slice(Math.max(0, image.selection.start - 2000), image.selection.start)}`;
    }
    return { kind: image.kind, material, instruction: image.instruction ?? '', stylePrompt: config.stylePrompt, config, characters, references };
  }
  private current(image: StoryImage, branchId = image.branchId) {
    const state = this.store.state(branchId);
    if (!this.store.images.visible(image, state, true)) return false;
    if (imageReferences(image).some(id => { const reference = this.store.images.get(id); return !reference || !this.store.images.active(reference, state); })) return false;
    return this.sameStoryMaterial(image, branchId);
  }
  private sameStoryMaterial(image: StoryImage, branchId = image.branchId) {
    const branch = this.store.getBranch(branchId); const state = this.store.state(branchId);
    if (branch.revisionId === image.baseRevisionId) return true;
    // Registering another image may advance the revision without changing prose or canon.
    const starting = this.store.revisionState(image.baseRevisionId);
    const { imageIds: ignoredStart, activeImageIds: ignoredStartActive, ...startMaterial } = starting; const { imageIds: ignoredCurrent, activeImageIds: ignoredCurrentActive, ...currentMaterial } = state;
    return JSON.stringify(startMaterial) === JSON.stringify(currentMaterial);
  }
  private async run(image: StoryImage, signal: AbortSignal) {
    try {
      if (!this.current(image)) { image.status = 'stale'; image.error = '故事线已有新版本，请按当前资料重新生成'; this.save(image); return; }
      const { provider, config } = this.configuration()!;
      image.status = 'running'; this.save(image);
      if (image.promptStatus !== 'completed') {
        const input = this.promptInput(image, config); image.materialEntityIds = input.characters.map(character => character.entityId); this.save(image);
        const result = await this.optimizer(this.getSettings(), input, signal);
        const stored = this.store.images.get(image.id);
        if (!stored || stored.status !== 'running' || signal.aborted || this.closed || this.deletingProjects.has(image.projectId)) return;
        if (!this.current(image)) { image.status = 'stale'; image.error = '故事线已有新版本，提示词未应用'; this.save(image); return; }
        const caps = imageModelCapabilities(config); const selected = new Set(result.referenceEntityIds);
        if ([...selected].some(id => !input.characters.some(character => character.entityId === id && character.imageId))) throw new HttpError('提示词 AI 选择了当前场景不可用的人物立绘');
        const referenceCharacters = result.referenceEntityIds.flatMap(id => { const character = input.characters.find(character => character.entityId === id && character.imageId); return character ? [{ entityId: character.entityId, imageId: character.imageId!, name: character.name }] : []; }).slice(0, Math.max(0, Math.min(caps.maxCharacterReferences, caps.maxReferences - input.references.length)));
        image.referenceCharacters = referenceCharacters; image.referenceEntityIds = referenceCharacters.map(character => character.entityId);
        image.referenceImageIds = [...input.references.map(reference => reference.imageId), ...referenceCharacters.map(character => character.imageId)];
        if (image.referenceImageIds.some(id => this.store.images.get(id)?.visibility === 'secret') || input.characters.some(character => !publicEntity(imageEntity(this.store.revisionState(image.baseRevisionId), character.entityId)!))) image.visibility = 'secret';
        const labels = [...input.references.map(reference => reference.label), ...referenceCharacters.map(character => `人物 ${character.name} 的已有立绘，保持该人物外貌与服装特征`)];
        image.prompt = result.prompt + (labels.length ? '\n\n参考图片按发送顺序对应：\n' + labels.map((label, index) => `参考图 ${index + 1}：${label}`).join('\n') : '');
        image.generationParameters = resolveImageParameters(config, result.parameters); image.promptStatus = 'completed'; image.optimizedAt = stamp(); this.save(image);
      }
      if (signal.aborted || this.store.images.get(image.id)?.status !== 'running') return;
      if (!this.current(image)) { image.status = 'stale'; image.error = '参考图片的启用状态已变化，图片请求未发出'; this.save(image); return; }
      const references = (image.referenceImageIds ?? (image.referenceImageId ? [image.referenceImageId] : [])).map(id => this.store.images.content(id));
      if (references.some(reference => !reference)) throw new HttpError('已选参考图片的内容不存在，请根据当前资料重新绘制');
      const resolved = resolveImageParameters(config, image.generationParameters ?? {});
      const caps = imageModelCapabilities(config); image.generationParameters = { model: config.model, protocol: config.protocol, ...Object.fromEntries(caps.supportedParams.filter(key => config[key] !== undefined).map(key => [key, config[key]])), ...resolved }; this.save(image);
      const content = await this.generator(provider, { ...config, ...resolved }, image.prompt, signal, references.length ? references as ImageContent[] : undefined); validateImageContent(content);
      const stored = this.store.images.get(image.id);
      if (!stored || stored.status !== 'running' || signal.aborted || this.closed || this.deletingProjects.has(image.projectId)) return;
      if (!this.current(image)) { image.status = 'stale'; image.error = '故事线已有新版本，迟到的图片未应用'; this.save(image); return; }
      image.status = 'completed'; image.mimeType = content.mimeType; image.error = undefined; this.save(image, content);
    } catch (error) {
      const stored = this.store.images.get(image.id); if (!stored || stored.status !== 'running' && stored.status !== 'queued') return;
      image.status = signal.aborted ? 'paused' : 'failed';
      const keys = this.getSettings().providers.map(provider => provider.apiKey).filter((key): key is string => Boolean(key));
      let message = error instanceof Error ? error.message : '生图失败'; for (const key of keys) message = message.split(key).join('[已隐藏]');
      image.error = message.slice(0, 2000); this.save(image);
    }
  }
  async deleteProject(projectId: string, remove: () => Promise<void>) {
    this.store.getProject(projectId); if (this.deletingProjects.has(projectId)) throw new HttpError('作品正在删除，请稍候', 409);
    this.deletingProjects.add(projectId);
    try {
      const images = this.store.images.all(projectId);
      for (const image of images) { if (['queued', 'running', 'paused'].includes(image.status)) { image.status = 'cancelled'; image.error = '作品正在删除，生图已停止'; this.save(image); } this.controllers.get(image.id)?.abort(); }
      const pending = images.flatMap(image => this.runs.get(image.id) ? [this.runs.get(image.id)!] : []);
      // Start the prose deletion lock immediately while cancelled image calls unwind.
      let removing: Promise<void>; try { removing = remove(); } catch (error) { removing = Promise.reject(error); }
      const [result] = await Promise.allSettled([removing, ...pending]);
      if (result.status === 'rejected') throw result.reason;
    } finally { this.deletingProjects.delete(projectId); }
  }
  async close() {
    this.closed = true;
    for (const image of this.store.images.all()) if (['queued', 'running'].includes(image.status)) { image.status = 'paused'; image.error = '服务已停止；请手动重试生图，可能会产生新的费用'; this.save(image); this.controllers.get(image.id)?.abort(); }
    await Promise.allSettled([...this.runs.values()]);
  }
}
