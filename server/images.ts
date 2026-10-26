import { randomUUID } from 'node:crypto';
import type { BranchView, ChapterMaterials, Entity, ImageGenerateInput, Job, Settings, StoryImage, StoryState, WritingImageRequest } from '../shared/types.js';
import { normalizeImageSettings } from '../shared/image-settings.js';
import { findEntitiesByName } from './entity-resolution.js';
import { rebuildCharacterProfileDescription } from './extraction.js';
import { generateImage, validateImageParameters, type ImageGenerator } from './image-provider.js';
import { imageEntity, imageReferences, type ImageContent, validateImageContent } from './image-store.js';
import { Store, HttpError } from './store.js';
import { imageModelCapabilities } from '../shared/image-capabilities.js';
import { optimizeImagePrompt, resolveImageParameters, type ImagePromptOptimizer, type ImagePromptInput } from './image-prompts.js';
import { readerEntityMaterial } from './reader-materials.js';
import { buildImageStoryContext } from './image-context.js';
import { matchWritingScene } from './image-source.js';

const stamp = () => new Date().toISOString();
const entityText = (entity: Entity) => `${entity.kind}：${entity.name}\n${entity.description}\n${entity.facts.map(fact => `${fact.temporal === 'future' ? '未来设定：' : ''}${fact.text}`).join('\n')}`;
const publicEntity = (entity: Entity) => entity.visibility === 'public' && !entity.facts.some(fact => fact.visibility === 'secret' || fact.temporal === 'future') && (entity.locked || !entity.description.trim() || entity.description === entity.facts.map(fact => fact.text).join('；') || entity.description === rebuildCharacterProfileDescription({ ...entity, description: '' }));
const associationError = '正文或资料中未能核对这张图片的场景、人物或参考图，请核对后手动重新生成';


/** Requests are explicitly queued once; restarts and failures never repeat a paid call. */
export class ImageService {
  private queue: string[] = [];
  private controllers = new Map<string, AbortController>();
  private runs = new Map<string, Promise<void>>();
  private deletingProjects = new Set<string>();
  private closed = false;
  private writingPumpScheduled = false;
  private writingBranches = new Set<string>();
  constructor(private store: Store, private getSettings: (projectId?: string) => Settings, private generator: ImageGenerator = generateImage, private optimizer: ImagePromptOptimizer = optimizeImagePrompt) {
    for (const image of store.images.all()) if (['queued', 'running'].includes(image.status)) {
      image.status = 'paused'; image.error = '服务已重启；请手动重试生图，可能会产生新的费用'; this.save(image);
    }
  }
  private save(image: StoryImage, content?: ImageContent) { image.updatedAt = stamp(); this.store.images.update(image, content); }
  private writingOwner(image: StoryImage): Job | undefined {
    if (!image.writingJobId) return;
    const row = this.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(image.writingJobId);
    if (!row) return;
    const job = JSON.parse(String(row.data)) as Job;
    return job.kind === 'generate' && job.branchId === image.branchId && job.projectId === image.projectId && (job.payload.imageRequests as WritingImageRequest[] | undefined)?.some(request => request.imageId === image.id) ? job : undefined;
  }
  private pendingCurrent(image: StoryImage): boolean {
    const job = this.writingOwner(image); if (!job || image.bindingStatus !== 'pending') return false;
    const branch = this.store.getBranch(image.branchId);
    if (job.status === 'running' || job.status === 'queued' || job.status === 'paused' && job.payload.rpgChoice && !job.payload.rpgChoiceAnswer) return job.baseRevisionId === branch.revisionId;
    if (job.status !== 'completed' || !job.payload.generatedChapterId) return false;
    return this.store.db.prepare('SELECT data FROM jobs WHERE branch_id=?').all(job.branchId).some(row => {
      const extraction = JSON.parse(String(row.data)) as Job;
      return extraction.kind === 'extract' && extraction.payload.writingJobId === job.id && !['cancelled', 'stale'].includes(extraction.status) && extraction.baseRevisionId === branch.revisionId;
    });
  }
  /** Queue after the current tool batch and any enclosing chapter transaction. */
  writingProgress(branchId: string) {
    if (this.closed) return;
    this.writingBranches.add(branchId);
    if (this.writingPumpScheduled) return;
    this.writingPumpScheduled = true;
    setImmediate(() => {
      this.writingPumpScheduled = false; if (this.closed) return;
      const branches = [...this.writingBranches]; this.writingBranches.clear();
      for (const branch of branches) for (const row of this.store.db.prepare("SELECT data FROM image_assets WHERE branch_id=? AND json_extract(data,'$.bindingStatus')='pending' AND json_extract(data,'$.status') IN ('queued','running')").all(branch)) {
        const image = JSON.parse(String(row.data)) as StoryImage;
        let valid = false; try { valid = this.pendingCurrent(image); } catch { /* Deleted branches cannot accept results. */ }
        if (!valid) { image.status = 'stale'; image.error = '对应写作已停止或版本已变化，图片未应用'; this.save(image); this.controllers.get(image.id)?.abort(); }
      }
      this.pump();
    });
  }
  /** Persist a draft asset without changing the story revision or waiting for pixels. */
  generateDuringWriting(job: Job, request: WritingImageRequest): StoryImage | undefined {
    const configured = this.configuration(job.projectId, true); if (!configured || request.kind === 'portrait' && !configured.config.autoPortrait || request.kind === 'cg' && !configured.config.autoCG) return;
    this.available(job.branchId, job.baseRevisionId, false);
    const state = this.store.state(job.branchId);
    if (request.kind === 'portrait') {
      if (!request.name?.trim()) return;
      const matches = findEntitiesByName(state, request.name, 'character');
      if (matches.length > 1) throw new HttpError('立绘姓名对应多份资料，请核对人物身份');
      if (matches[0] && (state.imageIds ?? []).some(id => { const old = this.store.images.get(id); return old?.kind === 'portrait' && old.entityId && imageEntity(state, old.entityId)?.id === matches[0].id && ['queued', 'running', 'completed'].includes(old.status); })) return;
    }
    const image: StoryImage = {
      id: randomUUID(), projectId: job.projectId, branchId: job.branchId, baseRevisionId: job.baseRevisionId,
      kind: request.kind, status: 'queued', title: request.kind === 'portrait' ? `${request.name} · 立绘` : `${String(job.payload.title || '正在创作的章节')} · CG`,
      prompt: '', promptStatus: 'pending', material: request.kind === 'portrait' ? `人物：${request.name}\n写作 AI 已确认的外观与绘制要求：\n${request.description}` : `场景描述：\n${request.sceneDescription || request.description || request.sourceText || ''}\n写作 AI 的画面要求：\n${request.description}`,
      instruction: '', automatic: true, visibility: 'secret', publicMaterial: false,
      ...(request.kind === 'cg' ? { sceneDescription: request.sceneDescription || request.description || request.sourceText, placementStatus: 'pending' as const } : {}),
      writingJobId: job.id, bindingStatus: 'pending', pendingEntityName: request.name,
      ...(request.prompt ? { writingPrompt: request.prompt, writingReferenceNames: request.referenceNames, writingParameters: request.parameters } : {}),
      createdAt: stamp(), updatedAt: stamp(),
    };
    this.store.images.insert(image); this.queue.push(image.id); this.writingProgress(job.branchId); return image;
  }
  /** Associate paid assets with saved prose before the independent material extraction. */
  bindWritingChapter(writingJobId: string, branchId: string, baseRevisionId: string, chapterId: string, checkpoint?: (revisionId: string) => void): { view: BranchView; images: StoryImage[] } | undefined {
    this.available(branchId, baseRevisionId, false);
    const chapter = this.store.chapter(branchId, chapterId);
    const prepared = this.store.images.all(this.store.getBranch(branchId).projectId).filter(image => image.branchId === branchId && image.writingJobId === writingJobId && image.kind === 'cg' && image.bindingStatus === 'pending' && this.writingOwner(image));
    for (const image of prepared) {
      image.chapterId = chapterId; image.title = `${chapter.title} · CG`; image.bindingStatus = 'bound';
      image.sceneDescription ??= image.sourceText || image.material || image.writingPrompt || '';
      image.sourceText = undefined; image.selection = undefined; image.placementStatus = 'pending'; image.placementError = undefined;
      if (this.legacyAssociationPixels({ ...image, bindingStatus: 'pending' })) { image.status = 'completed'; image.error = undefined; }
    }
    return prepared.length ? this.register(branchId, baseRevisionId, prepared, checkpoint) : undefined;
  }
  /** Position metadata never advances a story revision or blocks material extraction. */
  applyScenePlacement(imageId: string, chapterId: string, selection?: { start: number; end: number }, error?: string): StoryImage {
    const image = this.store.images.get(imageId);
    if (!image || image.kind !== 'cg' || image.bindingStatus !== 'bound' || image.chapterId !== chapterId) throw new HttpError('插画关联已经变化，定位结果未应用', 409);
    const state = this.store.state(image.branchId);
    if (state.imagePlacements?.[image.id]) return this.store.images.project(image, state);
    if (!state.chapters.some(chapter => chapter.id === chapterId) || !state.imageIds?.includes(image.id)) throw new HttpError('章节已修改或插画已移除，定位结果未应用', 409);
    const chapter = this.store.chapter(image.branchId, chapterId);
    if (selection && (!Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end <= selection.start || selection.end > chapter.text.length || !chapter.text.slice(selection.start, selection.end).trim())) throw new HttpError('插画定位的正文范围无效');
    image.selection = selection; image.sourceText = selection ? chapter.text.slice(selection.start, selection.end) : undefined;
    image.placementStatus = selection ? 'matched' : error ? 'failed' : 'unmatched'; image.placementError = error?.slice(0, 20000);
    this.save(image); return image;
  }
  private configuration(projectId: string, optional = false) {
    const settings = this.getSettings(projectId); const config = normalizeImageSettings(settings.imageSettings);
    const provider = settings.providers.find(item => item.id === config.providerId);
    if (!provider || !config.model.trim()) { if (optional) return undefined; throw new HttpError('请先在设置中选择生图服务并填写生图模型'); }
    validateImageParameters(config);
    return { config, provider };
  }
  private available(branchId: string, base: string, checkJobs = true) {
    if (this.closed) throw new HttpError('生图服务已停止', 409);
    const branch = this.store.assertVersion(branchId, base);
    if (this.deletingProjects.has(branch.projectId)) throw new HttpError('作品正在删除，请稍候', 409);
    if (checkJobs && this.store.db.prepare("SELECT 1 FROM jobs WHERE branch_id=? AND status IN ('queued','running','paused') AND COALESCE(json_extract(data,'$.kind'),'')<>'image-placement' LIMIT 1").get(branchId)) throw new HttpError('请先完成或取消本故事线的文字任务，再操作图片', 409);
    return branch;
  }
  private find(branchId: string, imageId: string, author: boolean, chapterId?: string): StoryImage {
    const branch = this.store.getBranch(branchId); const image = this.store.images.get(imageId);
    const state = author ? this.store.state(branchId) : this.store.readingState(branchId, chapterId);
    const draft = author && image?.branchId === branchId && image.bindingStatus === 'pending' && this.writingOwner(image);
    if (!image || image.projectId !== branch.projectId || !draft && !this.store.images.visible(image, state, author)) throw new HttpError('此故事线不包含可查看的图片', 404);
    return image;
  }
  private legacyAssociationPixels(image: StoryImage): boolean {
    return image.bindingStatus === 'pending' && image.status === 'stale' && image.error === associationError && Boolean(image.mimeType)
      && Boolean(this.store.db.prepare('SELECT 1 FROM image_assets WHERE id=? AND content IS NOT NULL').get(image.id));
  }
  private publicImage(image: StoryImage, branchId: string, author: boolean, state = this.store.state(branchId), chapterId?: string): StoryImage {
    image = this.store.images.project(image, state);
    // Old records keep their original diagnostic status in storage. Showing
    // retained pixels does not bind or activate an unverifiable scene.
    if (author && this.legacyAssociationPixels(image)) image = { ...image, status: 'completed', error: `图片未关联：${associationError}。已生成的原图保留，可在图册查看` };
    const progress = !author && chapterId ? `&chapterId=${encodeURIComponent(chapterId)}` : '';
    const url = image.status === 'completed' ? `/api/branches/${encodeURIComponent(branchId)}/images/${encodeURIComponent(image.id)}/content?view=${author ? 'author' : 'reader'}${progress}&v=${encodeURIComponent(image.updatedAt)}` : undefined;
    const entityId = image.entityId ? imageEntity(state, image.entityId)?.id : undefined;
    const referenceCharacters = image.referenceCharacters?.map(character => { const current = imageEntity(state, character.entityId); return { ...character, entityId: current?.id ?? character.entityId, name: current?.name ?? character.name }; });
    const active = this.store.images.active(image, state);
    const previewUrl = url ? `${url}&size=preview` : undefined;
    return author ? { ...image, entityId, referenceCharacters, active, url, previewUrl } : { ...image, entityId, active, prompt: '', sceneDescription: undefined, placementStatus: undefined, placementError: undefined, placementSource: undefined, placementGroupKey: undefined, sourceText: undefined, sourceSelection: undefined, selection: undefined, referenceImageId: undefined, selectedReferenceImageIds: undefined, error: undefined, material: undefined, storyContext: undefined, writingJobId: undefined, bindingStatus: undefined, pendingEntityName: undefined, dependencyImageIds: undefined, writingPrompt: undefined, writingReferenceNames: undefined, writingParameters: undefined, promptSource: undefined, instruction: undefined, materialEntityIds: undefined, materialFactIds: undefined, materialRelationIds: undefined, publicMaterial: undefined, referenceImageIds: undefined, referenceEntityIds: undefined, referenceCharacters: undefined, generationParameters: undefined, promptStatus: undefined, optimizedAt: undefined, url, previewUrl };
  }
  list(branchId: string, author = false, chapterId?: string): StoryImage[] {
    const branch = this.store.getBranch(branchId); const state = author ? this.store.state(branchId) : this.store.readingState(branchId, chapterId);
    const listed = (state.imageIds ?? []).flatMap(imageId => { const image = this.store.images.get(imageId); return image && image.projectId === branch.projectId && this.store.images.visible(image, state, author) ? [this.publicImage(image, branchId, author, state, chapterId)] : []; });
    return author ? [...listed, ...this.store.images.all(branch.projectId).filter(image => image.branchId === branchId && image.bindingStatus === 'pending' && this.writingOwner(image)).map(image => this.publicImage(image, branchId, true, state))] : listed;
  }
  /** Inline entity cards use the selected chapter's canon, independently of the complete workspace. */
  chapterMaterials(branchId: string, chapterId: string): ChapterMaterials {
    const branch = this.store.getBranch(branchId); const state = this.store.readingState(branchId, chapterId, false);
    const images = this.store.images.activeIds(state).flatMap(imageId => {
      const image = this.store.images.get(imageId);
      if (!image || image.projectId !== branch.projectId || !image.entityId || !['portrait', 'entity'].includes(image.kind) || image.status !== 'completed' || !this.store.images.visible(image, state, true)) return [];
      const displayed = this.publicImage(image, branchId, true, state);
      const url = `/api/branches/${encodeURIComponent(branchId)}/chapters/${encodeURIComponent(chapterId)}/images/${encodeURIComponent(imageId)}/content?v=${encodeURIComponent(image.updatedAt)}`;
      return [{ ...displayed, url, previewUrl: `${url}&size=preview` }];
    });
    return { branchId, chapterId, revisionId: branch.revisionId, entities: state.entities.filter(entity => !entity.mergedInto), relations: state.relations, images };
  }
  private chapterImage(branchId: string, chapterId: string, imageId: string): StoryImage {
    const branch = this.store.getBranch(branchId); const state = this.store.readingState(branchId, chapterId, false); const image = this.store.images.get(imageId);
    if (!image || image.projectId !== branch.projectId || !image.entityId || !['portrait', 'entity'].includes(image.kind) || !this.store.images.visible(image, state, true) || !this.store.images.active(image, state, false)) throw new HttpError('此章节进度不包含可查看的实体图片', 404);
    if (image.status !== 'completed') throw new HttpError('图片尚未生成完成', 409);
    return image;
  }
  chapterContent(branchId: string, chapterId: string, imageId: string): ImageContent {
    this.chapterImage(branchId, chapterId, imageId);
    const content = this.store.images.content(imageId); if (!content) throw new HttpError('图片内容不存在', 404); return content;
  }
  chapterContentTag(branchId: string, chapterId: string, imageId: string): string {
    this.chapterImage(branchId, chapterId, imageId);
    const tag = this.store.images.contentTag(imageId); if (!tag) throw new HttpError('图片内容不存在', 404); return tag;
  }
  content(branchId: string, imageId: string, author = false, chapterId?: string): ImageContent {
    const image = this.find(branchId, imageId, author, chapterId); if (image.status !== 'completed' && !(author && this.legacyAssociationPixels(image))) throw new HttpError('图片尚未生成完成', 409);
    const content = this.store.images.content(imageId); if (!content) throw new HttpError('图片内容不存在', 404); return content;
  }
  contentTag(branchId: string, imageId: string): string {
    const image = this.find(branchId, imageId, true);
    if (image.status !== 'completed' && !this.legacyAssociationPixels(image)) throw new HttpError('图片尚未生成完成', 409);
    const tag = this.store.images.contentTag(imageId);
    if (!tag) throw new HttpError('图片内容不存在', 404);
    return tag;
  }
  setActive(branchId: string, imageId: string, baseRevisionId: string, active: boolean): { view: BranchView; images: StoryImage[] } {
    this.available(branchId, baseRevisionId); const image = this.find(branchId, imageId, true);
    if (image.bindingStatus === 'pending') throw new HttpError('图片尚未关联已保存正文与资料，暂时不能启用', 409);
    if (active && image.status !== 'completed') throw new HttpError('图片完成后才能启用', 409);
    const view = this.store.updateImageReferences(branchId, baseRevisionId, this.store.images.project(image, this.store.state(branchId)).chapterId, state => {
      if (!state.imageIds?.includes(imageId)) return;
      this.store.images.hydrate(state); const group = this.store.images.groupKey(image, state);
      state.activeImageIds = state.activeImageIds!.filter(id => { const selected = this.store.images.get(id); return id !== imageId && (!active || !selected || this.store.images.groupKey(selected, state) !== group); });
      if (active) state.activeImageIds.push(imageId);
    }, `${active ? '启用' : '停用'}图片：${image.title}`); this.stopInvalidRuns(branchId); this.pump();
    return { view, images: this.list(branchId, true) };
  }
  /** Author-confirmed positions belong to this story revision, not the shared pixels. */
  setPlacement(branchId: string, imageId: string, input: { baseRevisionId: string; chapterId: string; selection?: { start: number; end: number } }): { view: BranchView; images: StoryImage[] } {
    this.available(branchId, input.baseRevisionId);
    const image = this.find(branchId, imageId, true); const current = this.store.state(branchId);
    if (image.kind !== 'cg') throw new HttpError('只有 CG 可以修改正文绑定位置');
    if (image.bindingStatus === 'pending') throw new HttpError('请先保存正文并关联章节，再修改绑定位置', 409);
    const projected = this.store.images.project(image, current);
    if (projected.chapterId !== input.chapterId || !current.chapters.some(chapter => chapter.id === input.chapterId)) throw new HttpError('图片关联章节已变化，请重新打开绑定位置', 409);
    const chapter = this.store.chapter(branchId, input.chapterId); const selection = input.selection;
    if (selection && (!Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end <= selection.start || selection.end > chapter.text.length || !chapter.text.slice(selection.start, selection.end).trim())) throw new HttpError('请选择有效的正文位置');
    const placement = { chapterId: input.chapterId, ...(selection ? { selection: { ...selection }, sourceText: chapter.text.slice(selection.start, selection.end) } : {}) };
    const view = this.store.updateImageReferences(branchId, input.baseRevisionId, input.chapterId, state => {
      if (!state.imageIds?.includes(image.id)) throw new HttpError('图片已从当前故事线移除，请刷新后重试', 409);
      (state.imagePlacements ??= {})[image.id] = structuredClone(placement);
    }, `手动修改 CG 绑定位置：${image.title}`);
    return { view, images: this.list(branchId, true) };
  }
  delete(branchId: string, imageId: string, baseRevisionId: string): { view: BranchView; images: StoryImage[] } {
    const draft = this.find(branchId, imageId, true);
    if (draft.bindingStatus === 'pending') {
      this.available(branchId, baseRevisionId, false); draft.bindingStatus = 'discarded';
      if (['queued', 'running', 'paused'].includes(draft.status)) draft.status = 'cancelled';
      this.save(draft); this.controllers.get(draft.id)?.abort(); this.writingProgress(branchId);
      return { view: this.store.view(branchId, true), images: this.list(branchId, true) };
    }
    this.available(branchId, baseRevisionId); const image = this.find(branchId, imageId, true);
    const view = this.store.updateImageReferences(branchId, baseRevisionId, this.store.images.project(image, this.store.state(branchId)).chapterId, state => {
      this.store.images.hydrate(state); state.imageIds = (state.imageIds ?? []).filter(id => id !== imageId); state.activeImageIds = state.activeImageIds!.filter(id => id !== imageId);
      if (state.imagePlacements) delete state.imagePlacements[imageId];
    }, `删除当前故事线图片：${image.title}`); this.stopInvalidRuns(branchId); this.pump();
    return { view, images: this.list(branchId, true) };
  }
  private stopInvalidRuns(branchId: string) {
    for (const image of this.store.images.all()) if (image.branchId === branchId && ['queued', 'running'].includes(image.status)) {
      if (this.current(image)) continue;
      image.status = 'stale'; image.error = '图片或参考图的启用状态已变化，请按当前选择重新生成'; this.save(image); this.controllers.get(image.id)?.abort();
    }
  }
  private prepare(branchId: string, input: ImageGenerateInput, automatic: boolean, state: StoryState, extraDescription = ''): StoryImage {
    const { config } = this.configuration(this.store.getBranch(branchId).projectId)!; const branch = this.store.getBranch(branchId);
    if (input.chapterId && !state.chapters.some(chapter => chapter.id === input.chapterId)) throw new HttpError('用于生图的章节不属于当前故事线');
    if (input.selection && input.kind !== 'cg') throw new HttpError('正文选区只能用于生成 CG');
    if (input.sceneDescription && input.kind !== 'cg') throw new HttpError('场景描述只能用于生成 CG');
    if (input.entityId && (input.kind === 'cg' || input.kind === 'map')) throw new HttpError('CG 和地图不能绑定单个资料实体');
    let title = '', material = '', visibility: StoryImage['visibility'] = input.instruction?.trim() || extraDescription.trim() ? 'secret' : 'public';
    const publicState = visibility === 'public' ? this.store.readingState(branchId, input.chapterId) : undefined;
    const publicEntities = publicState?.entities.flatMap(entity => readerEntityMaterial(entity, publicState.chapters) ?? []) ?? [];
    let materialEntityIds: string[] | undefined; const materialFactIds: string[] = []; const materialRelationIds: string[] = [];
    let sourceText: string | undefined;
    if (input.kind === 'portrait' || input.kind === 'entity') {
      const entity = state.entities.find(item => item.id === input.entityId && !item.mergedInto);
      if (!entity || input.kind === 'portrait' && entity.kind !== 'character') throw new HttpError('请选择当前故事线中对应的人物或资料');
      const disclosed = publicEntities.find(item => item.id === entity.id);
      title = `${disclosed?.name ?? entity.name} · ${input.kind === 'portrait' ? '立绘' : '资料图'}`; material = entityText(disclosed ?? entity);
      materialFactIds.push(...(disclosed?.facts.map(fact => fact.id) ?? []));
      if (!disclosed) visibility = 'secret';
    } else if (input.kind === 'map') {
      const locations = (publicEntities.some(entity => entity.kind === 'location') ? publicEntities : state.entities).filter(entity => entity.kind === 'location' && !entity.mergedInto);
      if (!locations.length) throw new HttpError('请先添加地点资料再生成地图');
      title = '世界地图'; material = locations.map(entityText).join('\n\n');
      const locationIds = new Set(locations.map(entity => entity.id));
      const relations = (publicState ?? state).relations.filter(relation => locationIds.has(relation.fromId) && locationIds.has(relation.toId) && (!publicState || relation.visibility === 'public' && (!relation.citation || publicState.chapters.some(chapter => chapter.id === relation.citation!.chapterId))));
      material += '\n地点关系：\n' + relations.map(relation => `${locations.find(entity => entity.id === relation.fromId)!.name} — ${relation.label} — ${locations.find(entity => entity.id === relation.toId)!.name}`).join('\n');
      materialEntityIds = locations.map(entity => entity.id);
      materialFactIds.push(...locations.flatMap(entity => entity.facts.map(fact => fact.id))); materialRelationIds.push(...relations.map(relation => relation.id));
      if (!publicState || locations.some(entity => !publicEntities.some(disclosed => disclosed.id === entity.id))) visibility = 'secret';
    } else {
      if (!input.chapterId) throw new HttpError('请选择用于生成 CG 的章节');
      const chapter = this.store.chapter(branchId, input.chapterId); sourceText = chapter.text;
      if (input.selection) {
        const { start, end } = input.selection;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > chapter.text.length) throw new HttpError('选中的正文范围无效');
        sourceText = chapter.text.slice(start, end);
      }
      if (!sourceText.trim()) throw new HttpError('用于生成 CG 的剧情不能为空');
      title = `${chapter.title} · CG`; material = `章节：${chapter.title}\n${input.sceneDescription?.trim() ? `本次绘制的场景：\n${input.sceneDescription.trim()}\n章节正文仅用于理解背景与保持一致。\n` : ''}剧情：\n${sourceText}`;
    }
    if (input.referenceImageId) {
      if (!input.instruction?.trim()) throw new HttpError('请填写对参考图片的修改要求');
      if (imageModelCapabilities(config).referenceMode === 'none') throw new HttpError('当前图片模型不支持参考图修改，请更换支持图片输入的模型');
      const reference = this.store.images.project(this.find(branchId, input.referenceImageId, true), state);
      if (reference.status !== 'completed' || !this.store.images.content(reference.id)) throw new HttpError('参考图片尚未完成，请先完成原图生成');
      if (!this.store.images.active(reference, state)) throw new HttpError('请先启用这张图片，再用 AI 修改');
      const referenceEntityId = reference.entityId ? imageEntity(state, reference.entityId)?.id : undefined;
      if (reference.kind !== input.kind || referenceEntityId !== input.entityId) throw new HttpError('参考图片必须属于同一种图片及对应资料');
      if (input.kind === 'cg' && (reference.chapterId !== input.chapterId || reference.sourceSelection && !reference.selection || (reference.selection || input.selection) && reference.sourceText !== sourceText)) throw new HttpError('参考 CG 必须绑定相同章节和剧情范围；原选段已修改时请重新选择正文');
      if (reference.visibility === 'secret' || publicState && !this.store.images.visible(reference, publicState, false, new Set(), true)) visibility = 'secret';
    }
    if (input.selectedReferenceImageIds !== undefined) {
      const ids = input.selectedReferenceImageIds; const caps = imageModelCapabilities(config);
      if (new Set(ids).size !== ids.length || ids.includes(input.referenceImageId ?? '')) throw new HttpError('参考图片不能重复选择');
      if (ids.length + (input.referenceImageId ? 1 : 0) > caps.maxReferences) throw new HttpError(`当前图片模型最多支持 ${caps.maxReferences} 张参考图，请减少选择或更换模型`);
      for (const id of ids) {
        const reference = this.find(branchId, id, true);
        if (reference.status !== 'completed' || !this.store.images.content(id)) throw new HttpError('所选参考图片尚未完成或内容不存在');
        if (!this.store.images.active(reference, state)) throw new HttpError('所选参考图片未启用，请先在故事图册启用');
        if (reference.visibility === 'secret' || publicState && !this.store.images.visible(reference, publicState, false, new Set(), true)) visibility = 'secret';
      }
    }
    const task = input.kind === 'portrait' ? '生成人物全身立绘，突出人物外貌、服装与气质。' : input.kind === 'map' ? '依据地点与地理关系生成地图，不要擅自增加未确认的城市或地点。' : input.kind === 'cg' ? '将已发生的剧情绘制为场景 CG，保持人物与环境一致。' : '依据资料生成对应实体的插画。';
    const description = [task, material, extraDescription && `写作模型对画面的要求：${extraDescription}`].filter(Boolean).join('\n\n');
    if (description.length > 100000) throw new HttpError('生图素材过长，请选择较短的剧情或精简资料');
    const previousScene = input.sceneDescription ? (state.imageIds ?? []).flatMap(id => this.store.images.get(id) ?? []).find(image => image.kind === 'cg' && image.chapterId === input.chapterId && image.sceneDescription === input.sceneDescription) : undefined;
    const placementStatus = input.selection ? 'matched' as const : previousScene?.placementStatus === 'failed' ? 'failed' as const : 'unmatched' as const;
    return { id: randomUUID(), projectId: branch.projectId, branchId, baseRevisionId: input.baseRevisionId, kind: input.kind, status: 'queued', title, prompt: '', material: description, instruction: input.instruction?.trim() || '', promptStatus: 'pending', entityId: input.entityId, chapterId: input.chapterId, selection: input.selection, sourceText: input.sceneDescription && !input.selection ? undefined : sourceText, ...(input.sceneDescription ? { sceneDescription: input.sceneDescription, placementStatus, placementError: placementStatus === 'failed' ? previousScene?.placementError : undefined } : {}), referenceImageId: input.referenceImageId, selectedReferenceImageIds: input.selectedReferenceImageIds?.slice(), automatic, visibility, publicMaterial: visibility === 'public', materialEntityIds, materialFactIds, materialRelationIds, createdAt: stamp(), updatedAt: stamp() };
  }
  private register(branchId: string, baseRevisionId: string, prepared: StoryImage[], checkpoint?: (revisionId: string) => void, retryOf?: string): { view: BranchView; images: StoryImage[] } {
    const registerInto = (state: StoryState) => {
      this.store.images.hydrate(state); const previousImages = (state.imageIds ?? []).flatMap(id => this.store.images.get(id) ?? []);
      const groups = new Set(previousImages.map(image => this.store.images.groupKey(image, state)));
      for (const image of prepared) {
        const group = this.store.images.groupKey(image, state);
        const transferIntent = retryOf && state.activeImageIds!.includes(retryOf) && !previousImages.some(old => this.store.images.groupKey(old, state) === group && old.status === 'completed');
        if (!groups.has(group) || transferIntent) { state.activeImageIds = state.activeImageIds!.filter(id => { const old = this.store.images.get(id); return !old || this.store.images.groupKey(old, state) !== group; }); state.activeImageIds.push(image.id); }
        groups.add(group);
      }
      state.imageIds = [...(state.imageIds ?? []), ...prepared.map(image => image.id)];
    };
    const view = this.store.updateImageReferences(branchId, baseRevisionId, prepared[0]?.chapterId, registerInto, prepared.length === 1 ? `生成图片：${prepared[0].title}` : '生成本章插画', revisionId => {
      for (const image of prepared) {
        image.baseRevisionId = revisionId;
        if (image.bindingStatus === 'pending') image.bindingStatus = 'bound';
        if (this.store.images.get(image.id)) this.save(image); else this.store.images.insert(image);
      }
      for (const image of prepared) if (image.writingJobId && image.referenceImageIds?.length) {
        image.referenceCharacters = image.referenceImageIds.flatMap(id => { const reference = this.store.images.get(id); const entity = reference?.entityId ? imageEntity(this.store.revisionState(revisionId), reference.entityId) : undefined; return reference?.kind === 'portrait' && entity ? [{ entityId: entity.id, imageId: id, name: entity.name }] : []; });
        image.referenceEntityIds = image.referenceCharacters.map(character => character.entityId); this.save(image);
      }
      // CGs may already belong to the chapter while their draft portraits are
      // only now receiving canonical entity identities after extraction.
      const writers = new Set(prepared.map(image => image.writingJobId).filter(Boolean));
      for (const image of this.store.images.all(this.store.getBranch(branchId).projectId)) if (image.branchId === branchId && image.kind === 'cg' && image.bindingStatus === 'bound' && writers.has(image.writingJobId) && image.referenceImageIds?.length) {
        image.referenceCharacters = image.referenceImageIds.flatMap(id => { const reference = this.store.images.get(id); const entity = reference?.entityId ? imageEntity(this.store.revisionState(revisionId), reference.entityId) : undefined; return reference?.kind === 'portrait' && entity ? [{ entityId: entity.id, imageId: id, name: entity.name }] : []; });
        image.referenceEntityIds = image.referenceCharacters.map(character => character.entityId); this.save(image);
      }
      checkpoint?.(revisionId);
    });
    this.queue.push(...prepared.filter(image => image.status === 'queued' && !this.queue.includes(image.id) && !this.runs.has(image.id)).map(image => image.id)); queueMicrotask(() => this.pump());
    return { view, images: prepared.map(image => this.publicImage(image, branchId, true)) };
  }
  generate(branchId: string, input: ImageGenerateInput): { view: BranchView; image: StoryImage } {
    this.available(branchId, input.baseRevisionId); this.configuration(this.store.getBranch(branchId).projectId); const state = this.store.state(branchId);
    const result = this.register(branchId, input.baseRevisionId, [this.prepare(branchId, input, false, state)]); return { view: result.view, image: result.images[0] };
  }
  retry(branchId: string, imageId: string, baseRevisionId: string): { view: BranchView; image: StoryImage } {
    this.available(branchId, baseRevisionId); this.configuration(this.store.getBranch(branchId).projectId); const previous = this.find(branchId, imageId, true);
    const target = this.store.images.project(previous, this.store.state(branchId));
    if (target.sourceSelection && !target.selection) throw new HttpError('原插画选段已修改，请重新选择正文生成图片');
    if (previous.bindingStatus === 'pending') throw new HttpError('请先保存正文并确认资料，再重试这张图片', 409);
    if (['queued', 'running'].includes(previous.status)) throw new HttpError('图片仍在生成中，请先取消或等待完成', 409);
    const { config } = this.configuration(this.store.getBranch(branchId).projectId)!;
    const sameModel = !previous.generationParameters || previous.generationParameters.model === config.model && previous.generationParameters.protocol === config.protocol;
    const sameReferences = previous.selectedReferenceImageIds !== undefined || !(config.useCharacterReferences === false && previous.referenceCharacters?.length);
    let sameDimensions = true;
    if (previous.generationParameters) { try { const selected = resolveImageParameters(config, previous.generationParameters); sameDimensions = Object.entries(selected).every(([key, value]) => previous.generationParameters?.[key as keyof typeof selected] === value); } catch { sameDimensions = false; } }
    const image: StoryImage = this.current(previous, branchId) && sameModel && sameReferences && sameDimensions ? { ...previous, id: randomUUID(), branchId, baseRevisionId, status: 'queued', automatic: false, createdAt: stamp(), updatedAt: stamp(), error: undefined, mimeType: undefined, url: undefined } : this.prepare(branchId, { baseRevisionId, kind: previous.kind, entityId: previous.entityId ? imageEntity(this.store.state(branchId), previous.entityId)?.id : undefined, chapterId: target.chapterId, selection: target.selection, sceneDescription: previous.sceneDescription, instruction: previous.instruction, referenceImageId: previous.referenceImageId, selectedReferenceImageIds: previous.selectedReferenceImageIds }, false, this.store.state(branchId));
    if (image.placementStatus === 'pending') image.placementStatus = 'unmatched';
    if (image.promptStatus !== 'completed') {
      image.dependencyImageIds = undefined;
      if (this.sameStoryMaterial(previous, branchId) && previous.material !== undefined) { image.material = previous.material; image.instruction = previous.instruction ?? image.instruction; }
      if (this.sameStoryMaterial(previous, branchId) && previous.writingPrompt) { image.writingPrompt = previous.writingPrompt; image.writingReferenceNames = previous.writingReferenceNames; image.writingParameters = previous.writingParameters; }
      image.material ??= previous.prompt; image.prompt = ''; image.promptStatus = 'pending';
    }
    const result = this.register(branchId, baseRevisionId, [image], undefined, previous.id); return { view: result.view, image: result.images[0] };
  }
  cancel(branchId: string, imageId: string): StoryImage {
    const image = this.find(branchId, imageId, true);
    if (['queued', 'running', 'paused'].includes(image.status)) { image.status = 'cancelled'; image.error = '作者已取消生图'; this.save(image); this.controllers.get(image.id)?.abort(); }
    this.writingProgress(branchId);
    return this.publicImage(image, branchId, true);
  }
  generateAutomatic(branchId: string, baseRevisionId: string, chapterId: string, requests: WritingImageRequest[], newCharacterIds: string[], checkpoint?: (revisionId: string) => void): { view: BranchView; images: StoryImage[] } | undefined {
    const configured = this.configuration(this.store.getBranch(branchId).projectId, true);
    this.available(branchId, baseRevisionId, false); const state = this.store.state(branchId); const prepared: StoryImage[] = [];
    const chapter = this.store.chapter(branchId, chapterId);
    const portraitIds = new Set<string>(); const sourceTexts = new Set<string>();
    // Adopt the original assets, including failed/cancelled ones. Saving the chapter
    // must not silently repeat a paid request or replace an author's cancellation.
    const drafts = requests.filter(request => request.imageId).flatMap(request => {
      const image = this.store.images.get(request.imageId!);
      if (request.kind === 'portrait' && request.name) for (const entity of findEntitiesByName(state, request.name, 'character')) portraitIds.add(entity.id);
      return image && image.branchId === branchId && image.projectId === this.store.getBranch(branchId).projectId && this.writingOwner(image) && image.bindingStatus === 'pending' ? [{ request, image }] : [];
    }).sort((a, b) => Number(a.image.kind === 'cg') - Number(b.image.kind === 'cg'));
    for (const { request, image } of drafts) {
      let valid = true;
      if (image.kind === 'portrait') {
        const found = findEntitiesByName(state, request.name ?? '', 'character');
        valid = found.length === 1 && (found[0].facts.some(fact => fact.citation?.chapterId === chapterId) || [found[0].name, ...found[0].aliases].some(name => name.trim() && chapter.text.includes(name)));
        if (valid) { image.entityId = found[0].id; image.title = `${found[0].name} · 立绘`; }
      } else {
        const scene = matchWritingScene(chapter.text, image.sourceText);
        valid = Boolean(scene);
        if (scene) { image.sourceText = scene.sourceText; image.selection = scene.selection; image.title = `${chapter.title} · CG`; }
      }
      const dependencies = [...(image.dependencyImageIds ?? []), ...imageReferences(image)];
      valid &&= dependencies.every(id => prepared.some(asset => asset.id === id) || (state.imageIds ?? []).includes(id));
      if (!valid) {
        // Failed association does not erase already-paid pixels or pretend that
        // the story version changed. Drafts remain unbound and cannot activate.
        if (image.status !== 'completed') image.status = 'failed';
        image.error = `图片未关联：${associationError}${image.status === 'completed' ? '。已生成的原图保留，可在图册查看' : ''}`;
        this.save(image); this.controllers.get(image.id)?.abort(); continue;
      }
      // Earlier releases marked a completed image stale when its escaped quote
      // did not match. An explicit association retry can adopt those same pixels.
      if (image.status === 'stale' && image.error === associationError && this.store.images.content(image.id)) image.status = 'completed';
      if (image.error?.includes(associationError)) image.error = undefined;
      image.chapterId = chapterId; image.bindingStatus = 'bound'; prepared.push(image);
    }
    const addPortrait = (entityId: string, description = '') => {
      const entity = imageEntity(state, entityId);
      if (!entity || entity.kind !== 'character' || !entity.facts.some(fact => fact.citation?.chapterId === chapterId) && ![entity.name, ...entity.aliases].some(name => name.trim() && chapter.text.includes(name))) return;
      if (prepared.length >= 12 || portraitIds.has(entityId) || (state.imageIds ?? []).some(id => { const existing = this.store.images.get(id); return existing?.kind === 'portrait' && existing.entityId && imageEntity(state, existing.entityId)?.id === entityId && ['queued', 'running', 'completed'].includes(existing.status); })) return;
      try { prepared.push(this.prepare(branchId, { baseRevisionId, kind: 'portrait', entityId, chapterId }, true, state, description)); portraitIds.add(entityId); }
      catch (error) { if (!(error instanceof HttpError)) throw error; }
    };
    for (const request of requests.slice(0, 30)) {
      if (request.imageId) continue;
      if (request.kind === 'portrait' && configured?.config.autoPortrait && request.name) {
        const found = findEntitiesByName(state, request.name, 'character');
        if (found.length === 1 && newCharacterIds.includes(found[0].id)) addPortrait(found[0].id, request.description);
      } else if (request.kind === 'cg' && configured?.config.autoCG && request.sourceText?.trim() && prepared.length < 12) {
        const scene = matchWritingScene(chapter.text, request.sourceText);
        if (!scene || sourceTexts.has(scene.sourceText)) continue;
        try {
          const image = this.prepare(branchId, { baseRevisionId, kind: 'cg', chapterId, selection: scene.selection }, true, state, request.description);
          if (request.prompt?.trim()) {
            image.writingPrompt = request.prompt.trim(); image.writingReferenceNames = request.referenceNames; image.writingParameters = request.parameters;
          }
          prepared.push(image); sourceTexts.add(scene.sourceText);
        } catch (error) { if (!(error instanceof HttpError)) throw error; }
      }
    }
    if (configured?.config.autoPortrait) for (const entityId of newCharacterIds) addPortrait(entityId);
    if (!prepared.length) return undefined;
    return this.register(branchId, baseRevisionId, prepared, checkpoint);
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
    return this.storyContext(image, state)?.entities.filter(entity => entity.kind === 'character') ?? [];
  }
  private storyContext(image: StoryImage, state: StoryState) {
    return buildImageStoryContext(image, state, id => this.store.chapter(image.branchId, id).text);
  }
  private waitingForPortrait(image: StoryImage) {
    if (image.writingJobId && image.selectedReferenceImageIds === undefined) return this.writingDependencies(image).some(reference => ['queued', 'running'].includes(reference.status));
    if (image.selectedReferenceImageIds !== undefined) return false;
    const configured = this.configuration(image.projectId, true); if (!configured || image.kind !== 'cg' || configured.config.useCharacterReferences === false || imageModelCapabilities(configured.config).referenceMode === 'none') return false;
    const state = this.promptState(image); const candidates = new Set(image.writingPrompt ? this.writingReferenceIds(image, state) : this.sceneCharacters(image, state).map(entity => entity.id));
    return this.store.images.activeIds(state).some(id => { const portrait = this.store.images.get(id); return portrait?.kind === 'portrait' && portrait.entityId && candidates.has(imageEntity(state, portrait.entityId)?.id ?? '') && ['queued', 'running'].includes(portrait.status); });
  }
  private promptInput(image: StoryImage, config: NonNullable<Settings['imageSettings']>): ImagePromptInput {
    if (image.writingJobId && image.selectedReferenceImageIds === undefined) {
      const references = this.writingDependencies(image).map(reference => {
        if (reference.status !== 'completed' || !this.store.images.content(reference.id)) throw new HttpError(`参考图「${reference.title}」尚未成功完成，请先处理该参考图，再手动重试 CG`);
        return { imageId: reference.id, entityId: reference.entityId, label: `人物 ${reference.pendingEntityName || reference.title.replace(/ · 立绘$/, '')} 的已有立绘，保持该人物外貌与服装特征` };
      });
      return { kind: image.kind, material: image.material ?? image.prompt, instruction: image.instruction ?? '', stylePrompt: config.stylePrompt, config, characters: [], references, referenceSelection: 'manual' };
    }
    const state = this.promptState(image); const caps = imageModelCapabilities(config);
    const context = image.writingPrompt ? undefined : this.storyContext(image, state);
    const writingIds = image.writingPrompt && image.selectedReferenceImageIds === undefined && config.useCharacterReferences !== false && caps.referenceMode !== 'none' ? new Set(this.writingReferenceIds(image, state)) : undefined;
    if (context) {
      if (context.text.length > 2000000) throw new HttpError('CG 上下文超过保存上限，请精简相关资料后重试；没有截断上下文或发送生图请求');
      image.storyContext = context.text;
      image.materialEntityIds = [...new Set([...(image.materialEntityIds ?? []), ...context.entities.map(entity => entity.id)])];
      if (image.publicMaterial) {
        image.materialFactIds = [...new Set([...(image.materialFactIds ?? []), ...context.entities.flatMap(entity => entity.facts.map(fact => fact.id))])];
        image.materialRelationIds = [...new Set([...(image.materialRelationIds ?? []), ...context.relations.map(relation => relation.id)])];
      }
    }
    const current = this.store.state(image.branchId);
    const references: ImagePromptInput['references'] = image.referenceImageId ? [{ label: '待修改的原图', imageId: image.referenceImageId }] : [];
    for (const id of image.selectedReferenceImageIds ?? []) {
      const reference = this.store.images.get(id)!; const entity = reference.entityId ? imageEntity(state, reference.entityId) : undefined;
      const label = reference.kind === 'portrait' && entity ? `人物 ${entity.name} 的已有立绘，保持该人物外貌与服装特征` : `作者指定的参考图片：${reference.title}`;
      references.push({ imageId: id, entityId: entity?.id, label });
    }
    const characters = (context?.entities ?? state.entities.filter(entity => writingIds?.has(entity.id))).filter(entity => entity.kind === 'character').map(entity => {
      const portraits = (state.imageIds ?? []).map(id => this.store.images.get(id)).filter((asset): asset is StoryImage => Boolean(asset && asset.kind === 'portrait' && this.store.images.active(asset, state) && this.store.images.active(asset, current) && (!image.publicMaterial || this.store.images.visible(asset, this.store.readingState(image.branchId, image.chapterId), false)) && asset.entityId && imageEntity(state, asset.entityId)?.id === entity.id));
      const asset = portraits.find(portrait => this.store.images.content(portrait.id));
      return { entityId: entity.id, name: entity.name, description: entityText(entity), imageId: image.selectedReferenceImageIds === undefined && config.useCharacterReferences !== false && caps.referenceMode !== 'none' ? asset?.id : undefined };
    });
    return { kind: image.kind, material: image.material ?? image.prompt, storyContext: image.storyContext, instruction: image.instruction ?? '', stylePrompt: config.stylePrompt, config, characters, references, ...(image.selectedReferenceImageIds !== undefined ? { referenceSelection: 'manual' as const } : {}) };
  }
  private promptState(image: StoryImage): StoryState {
    if (!image.publicMaterial) return this.store.revisionState(image.baseRevisionId);
    const state = this.store.readingState(image.branchId, image.chapterId);
    state.entities = state.entities.flatMap(entity => readerEntityMaterial(entity, state.chapters) ?? []);
    return state;
  }
  private current(image: StoryImage, branchId = image.branchId) {
    this.refreshBinding(image);
    if (image.bindingStatus === 'discarded') return false;
    if (image.bindingStatus === 'pending') return branchId === image.branchId && this.pendingCurrent(image) && imageReferences(image).every(id => {
      const reference = this.store.images.get(id);
      return reference && reference.status === 'completed' && (reference.bindingStatus === 'pending' && reference.writingJobId === image.writingJobId && this.pendingCurrent(reference) || this.store.images.active(reference, this.store.state(branchId)));
    });
    const state = this.store.state(branchId);
    if (!this.store.images.visible(image, state, true)) return false;
    if (imageReferences(image).some(id => { const reference = this.store.images.get(id); return !reference || !(this.store.images.active(reference, state) || image.writingJobId && reference.writingJobId === image.writingJobId && reference.bindingStatus === 'pending' && this.pendingCurrent(reference)); })) return false;
    return this.sameStoryMaterial(image, branchId);
  }
  private sameStoryMaterial(image: StoryImage, branchId = image.branchId) {
    const branch = this.store.getBranch(branchId); let state = this.store.state(branchId);
    if (branch.revisionId === image.baseRevisionId) return true;
    // A later chapter can be written while this earlier scene is still drawing.
    // Compare its saved chapter boundary, so edits/rollback still invalidate it.
    if (image.writingJobId && image.bindingStatus === 'bound' && image.chapterId) {
      if (!state.chapters.some(chapter => chapter.id === image.chapterId)) return false;
      // A writing-provided scene is grounded in immutable saved prose. Naming
      // and canon extraction can advance independently while its pixels draw.
      if (image.kind === 'cg' && image.sceneDescription) return Boolean(state.imageIds?.includes(image.id));
      state = this.store.readingState(branchId, image.chapterId, false);
    }
    // Registering another image may advance the revision without changing prose or canon.
    const starting = this.store.revisionState(image.baseRevisionId);
    const { imageIds: ignoredStart, activeImageIds: ignoredStartActive, imagePlacements: ignoredStartPlacements, ...startMaterial } = starting; const { imageIds: ignoredCurrent, activeImageIds: ignoredCurrentActive, imagePlacements: ignoredCurrentPlacements, ...currentMaterial } = state;
    return JSON.stringify(startMaterial) === JSON.stringify(currentMaterial);
  }
  private refreshBinding(image: StoryImage) {
    const stored = this.store.images.get(image.id);
    if (stored && (image.bindingStatus === 'pending' && stored.bindingStatus !== 'pending' || stored.kind === 'cg' && stored.sceneDescription && stored.bindingStatus === 'bound')) {
      for (const key of ['baseRevisionId', 'bindingStatus', 'chapterId', 'entityId', 'sourceText', 'selection', 'sceneDescription', 'placementStatus', 'placementError', 'title', 'referenceCharacters', 'referenceEntityIds'] as const) Object.assign(image, { [key]: stored[key] });
    }
  }
  /** Resolve only references actually used by this scene, before reserving a worker. */
  private writingDependencies(image: StoryImage): StoryImage[] {
    const { config } = this.configuration(image.projectId)!; const caps = imageModelCapabilities(config);
    if (image.dependencyImageIds === undefined) {
      if (image.kind !== 'cg' || config.useCharacterReferences === false || caps.referenceMode === 'none') { image.dependencyImageIds = []; this.save(image); return []; }
      const state = this.promptState(image);
      const activeIds = new Set(this.store.images.activeIds(state));
      const candidates = this.store.images.all(image.projectId).filter(reference => reference.kind === 'portrait' && reference.id !== image.id && (reference.bindingStatus !== 'discarded') && (reference.bindingStatus === 'pending' ? reference.writingJobId === image.writingJobId && Boolean(this.writingOwner(reference)) : activeIds.has(reference.id)));
      const text = [image.writingPrompt, image.sourceText, image.material].filter(Boolean).join('\n');
      const names = image.writingReferenceNames ?? candidates.flatMap(reference => { const entity = reference.entityId ? imageEntity(state, reference.entityId) : undefined; return entity ? [entity.name, ...entity.aliases] : [reference.pendingEntityName ?? '']; }).filter(name => name && text.includes(name));
      const ids: string[] = [];
      for (const name of names) {
        const entities = findEntitiesByName(state, name, 'character');
        if (entities.length > 1) throw new HttpError(`参考人物「${name}」对应多份资料，请核对人物身份后重新生成`);
        const matching = candidates.filter(reference => reference.pendingEntityName === name || entities.length === 1 && reference.entityId && imageEntity(state, reference.entityId)?.id === entities[0].id);
        // Prefer the author's current active portrait; otherwise use this writing task's request.
        const selected = matching.find(reference => this.store.images.active(reference, state)) ?? matching[0];
        if (selected && !ids.includes(selected.id)) ids.push(selected.id);
      }
      image.dependencyImageIds = ids.slice(0, Math.min(caps.maxCharacterReferences, caps.maxReferences)); this.save(image);
    }
    return image.dependencyImageIds.map(id => { const reference = this.store.images.get(id); if (!reference || reference.bindingStatus === 'discarded') throw new HttpError('所需参考图已删除，请核对参考图后手动重新生成'); return reference; });
  }
  private async run(image: StoryImage, signal: AbortSignal) {
    try {
      if (!this.current(image)) { image.status = 'stale'; image.error = '故事线已有新版本，请按当前资料重新生成'; this.save(image); return; }
      const { provider, config } = this.configuration(image.projectId)!;
      image.status = 'running'; this.save(image);
      if (image.promptStatus !== 'completed') {
        const input = this.promptInput(image, config); image.materialEntityIds = [...new Set([...(image.materialEntityIds ?? []), ...input.characters.map(character => character.entityId)])];
        if (image.publicMaterial) image.materialFactIds = [...new Set([...(image.materialFactIds ?? []), ...this.promptState(image).entities.filter(entity => image.materialEntityIds!.includes(entity.id)).flatMap(entity => entity.facts.map(fact => fact.id))])];
        this.save(image);
        const result = image.writingPrompt ? this.writingImagePrompt(image, input) : await this.optimizer(this.getSettings(image.projectId), input, signal);
        const stored = this.store.images.get(image.id);
        if (!stored || stored.status !== 'running' || signal.aborted || this.closed || this.deletingProjects.has(image.projectId)) return;
        if (!this.current(image)) { image.status = 'stale'; image.error = '故事线已有新版本，提示词未应用'; this.save(image); return; }
        const caps = imageModelCapabilities(config); const manual = input.referenceSelection === 'manual';
        if (!manual && result.referenceEntityIds.some(id => !input.characters.some(character => character.entityId === id && character.imageId))) throw new HttpError('提示词 AI 选择了当前场景不可用的人物立绘');
        const referenceCharacters = manual ? (image.selectedReferenceImageIds ?? input.references.map(reference => reference.imageId)).flatMap(id => {
          const reference = this.store.images.get(id)!; const entity = reference.entityId ? imageEntity(this.store.revisionState(image.baseRevisionId), reference.entityId) : undefined;
          return reference.kind === 'portrait' && entity ? [{ entityId: entity.id, imageId: id, name: entity.name }] : [];
        }) : result.referenceEntityIds.flatMap(id => { const character = input.characters.find(character => character.entityId === id && character.imageId); return character ? [{ entityId: character.entityId, imageId: character.imageId!, name: character.name }] : []; }).slice(0, Math.max(0, Math.min(caps.maxCharacterReferences, caps.maxReferences - input.references.length)));
        image.referenceCharacters = referenceCharacters; image.referenceEntityIds = referenceCharacters.map(character => character.entityId);
        image.referenceImageIds = [...input.references.map(reference => reference.imageId), ...(!manual ? referenceCharacters.map(character => character.imageId) : [])];
        if (image.referenceImageIds.some(id => this.store.images.get(id)?.visibility === 'secret') || !image.publicMaterial && input.characters.some(character => !publicEntity(imageEntity(this.store.revisionState(image.baseRevisionId), character.entityId)!))) image.visibility = 'secret';
        const labels = [...input.references.map(reference => reference.label), ...(!manual ? referenceCharacters.map(character => `人物 ${character.name} 的已有立绘，保持该人物外貌与服装特征`) : [])];
        image.prompt = result.prompt + (labels.length ? '\n\n参考图片按发送顺序对应：\n' + labels.map((label, index) => `参考图 ${index + 1}：${label}`).join('\n') : '');
        image.generationParameters = resolveImageParameters(config, result.parameters); image.promptStatus = 'completed'; image.promptSource = image.writingPrompt ? 'writing' : 'optimizer'; image.optimizedAt = stamp(); this.save(image);
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
      this.refreshBinding(image);
      image.status = signal.aborted ? 'paused' : 'failed';
      const keys = this.getSettings().providers.map(provider => provider.apiKey).filter((key): key is string => Boolean(key));
      let message = error instanceof Error ? error.message : '生图失败'; for (const key of keys) message = message.split(key).join('[已隐藏]');
      image.error = message.slice(0, 2000); this.save(image);
    }
  }
  private writingImagePrompt(image: StoryImage, input: ImagePromptInput) {
    const state = this.store.revisionState(image.baseRevisionId);
    const referenceEntityIds = input.referenceSelection === 'manual' || input.config.useCharacterReferences === false || imageModelCapabilities(input.config).referenceMode === 'none' ? [] : this.writingReferenceIds(image, state).flatMap(id => {
      const character = input.characters.find(character => character.entityId === id);
      return character?.imageId ? [character.entityId] : [];
    });
    return { prompt: [image.writingPrompt, input.stylePrompt && `画风要求：${input.stylePrompt}`].filter(Boolean).join('\n\n'), referenceEntityIds: [...new Set(referenceEntityIds)], parameters: resolveImageParameters(input.config, image.writingParameters ?? {}) };
  }
  private writingReferenceIds(image: StoryImage, state: StoryState): string[] {
    const names = image.writingReferenceNames ?? state.entities.filter(entity => entity.kind === 'character' && !entity.mergedInto && [entity.name, ...entity.aliases].some(name => name.trim() && image.writingPrompt!.includes(name))).map(entity => entity.name);
    return [...new Set(names.map(name => {
      const found = findEntitiesByName(state, name, 'character');
      if (found.length !== 1) throw new HttpError(`写作 AI 指定的参考人物「${name}」无法唯一对应当前资料，请按当前资料重新绘制`);
      return found[0].id;
    }))];
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
