import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Entity, StoryImage, StoryState } from '../shared/types.js';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const generationParametersSchema = z.object({
  model: z.string().max(300).optional(), protocol: z.enum(['openai-images', 'gemini', 'together-images']).optional(),
  size: z.string().max(50).regex(/^(?:auto|\d+x\d+)$/).optional(), aspectRatio: z.string().max(30).optional(), imageSize: z.enum(['512', '1K', '2K', '4K']).optional(), width: z.number().int().min(64).max(8192).optional(), height: z.number().int().min(64).max(8192).optional(),
  quality: z.enum(['auto', 'low', 'medium', 'high', 'standard', 'hd', 'xhigh', 'max']).optional(),
  systemInstruction: z.string().max(100000).optional(), temperature: z.number().min(0).max(2).optional(), topP: z.number().min(0).max(1).optional(), topK: z.number().int().min(0).max(1000000).optional(), seed: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(), maxOutputTokens: z.number().int().min(1).max(2000000).optional(),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(), includeThoughts: z.boolean().optional(), searchGrounding: z.boolean().optional(),
  outputFormat: z.enum(['png', 'jpeg', 'webp']).optional(), outputCompression: z.number().int().min(0).max(100).optional(), background: z.enum(['auto', 'opaque', 'transparent']).optional(), inputFidelity: z.enum(['low', 'high']).optional(), moderation: z.enum(['auto', 'low']).optional(),
  negativePrompt: z.string().max(32000).optional(), steps: z.number().int().min(1).max(10000).optional(), guidanceScale: z.number().min(0).max(100).optional(), promptUpsampling: z.boolean().optional(), disableSafetyChecker: z.boolean().optional(),
}).strict();
export const imageSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), branchId: z.string().min(1), baseRevisionId: z.string().min(1),
  kind: z.enum(['portrait', 'entity', 'map', 'cg']), status: z.enum(['queued', 'running', 'completed', 'failed', 'paused', 'stale', 'cancelled']),
  title: z.string().max(500), prompt: z.string().max(100000), entityId: z.string().optional(), chapterId: z.string().optional(), sourceText: z.string().max(2000000).optional(),
  selection: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).optional(), referenceImageId: z.string().optional(),
  material: z.string().max(100000).optional(), instruction: z.string().max(20000).optional(),
  referenceImageIds: z.array(z.string().min(1)).max(16).optional(), referenceEntityIds: z.array(z.string().min(1)).max(16).optional(),
  materialEntityIds: z.array(z.string().min(1)).max(10000).optional(),
  referenceCharacters: z.array(z.object({ entityId: z.string().min(1), imageId: z.string().min(1), name: z.string().max(300) })).max(16).optional(),
  generationParameters: generationParametersSchema.optional(),
  promptStatus: z.enum(['pending', 'completed']).optional(), optimizedAt: z.string().optional(),
  automatic: z.boolean(), visibility: z.enum(['public', 'secret']), createdAt: z.string(), updatedAt: z.string(), error: z.string().optional(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
});
export const imageBackupSchema = z.object({ image: imageSchema, contentBase64: z.string().max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4).optional() });
export type ImageContent = { bytes: Uint8Array; mimeType: NonNullable<StoryImage['mimeType']> };

export function validateImageContent(content: ImageContent): void {
  const bytes = Buffer.from(content.bytes); const bad = () => { throw Object.assign(new Error('图片为空、超过 20 MiB 或不是 PNG、JPEG、WebP 图片'), { statusCode: 400 }); };
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) bad();
  if (content.mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
  if (content.mimeType === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return;
  if (content.mimeType === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return;
  bad();
}

/** Only references in the selected story snapshot can expose an asset. */
export function imageEntity(state: StoryState, entityId: string): Entity | undefined {
  let entity = state.entities.find(item => item.id === entityId); const seen = new Set<string>();
  while (entity?.mergedInto && !seen.has(entity.id)) { seen.add(entity.id); entity = state.entities.find(item => item.id === entity!.mergedInto); }
  return entity && !entity.mergedInto ? entity : undefined;
}
export function imageReferences(image: StoryImage): string[] { return [...new Set([...(image.referenceImageId ? [image.referenceImageId] : []), ...(image.referenceImageIds ?? []), ...(image.referenceCharacters ?? []).map(character => character.imageId)])]; }
function readerEntity(entity: Entity | undefined): boolean {
  return Boolean(entity && entity.visibility === 'public' && (entity.locked || entity.facts.some(fact => fact.visibility === 'public' && fact.temporal !== 'future')) && !entity.facts.some(fact => fact.visibility === 'secret' || fact.temporal === 'future'));
}
export function imageVisible(image: StoryImage, state: StoryState, author: boolean, historicalSource = false): boolean {
  if (!historicalSource && !state.imageIds?.includes(image.id)) return false;
  if (!historicalSource && image.chapterId && !state.chapters.some(chapter => chapter.id === image.chapterId)) return false;
  if (image.entityId) {
    const entity = imageEntity(state, image.entityId);
    if (!entity || !author && !readerEntity(entity)) return false;
  }
  if ([...(image.materialEntityIds ?? []), ...(image.referenceEntityIds ?? []), ...(image.referenceCharacters ?? []).map(character => character.entityId)].some(entityId => { const entity = imageEntity(state, entityId); return !entity || !author && !readerEntity(entity); })) return false;
  if (!author && image.kind === 'map') {
    const locations = state.entities.filter(entity => entity.kind === 'location' && !entity.mergedInto); const ids = new Set(locations.map(entity => entity.id));
    if (locations.some(entity => entity.visibility === 'secret' || entity.facts.some(fact => fact.visibility === 'secret' || fact.temporal === 'future')) || state.relations.some(relation => ids.has(relation.fromId) && ids.has(relation.toId) && relation.visibility === 'secret')) return false;
  }
  return author || image.visibility === 'public' && image.status === 'completed';
}

export class ImageStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS image_assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_id TEXT NOT NULL, data TEXT NOT NULL, content BLOB);
      CREATE INDEX IF NOT EXISTS image_assets_project ON image_assets(project_id);`);
  }
  get(id: string): StoryImage | undefined { const row = this.db.prepare('SELECT data FROM image_assets WHERE id=?').get(id); return row ? JSON.parse(String(row.data)) : undefined; }
  groupKey(image: StoryImage, state: StoryState): string {
    if (image.kind === 'portrait' || image.kind === 'entity') return `entity:${image.entityId ? imageEntity(state, image.entityId)?.id ?? image.entityId : image.id}`;
    if (image.kind === 'map') return 'map';
    return `cg:${image.chapterId}:${image.selection ? `${image.selection.start}:${image.selection.end}` : 'full'}`;
  }
  activeIds(state: StoryState): string[] {
    const selected = new Map<string, string>(); const explicit = state.activeImageIds !== undefined;
    for (const imageId of explicit ? state.activeImageIds! : state.imageIds ?? []) {
      const image = this.get(imageId);
      if (!image || !imageVisible(image, state, true) || !explicit && image.status !== 'completed') continue;
      const group = this.groupKey(image, state); const previousId = selected.get(group); const previous = previousId ? this.get(previousId) : undefined;
      if (!explicit && previous && previous.createdAt.localeCompare(image.createdAt) > 0) continue;
      selected.set(group, imageId);
    }
    return [...selected.values()];
  }
  active(image: StoryImage, state: StoryState, completedOnly = true): boolean { return (!completedOnly || image.status === 'completed') && this.activeIds(state).includes(image.id); }
  hydrate(state: StoryState): void { state.activeImageIds = this.activeIds(state); }
  visible(image: StoryImage, state: StoryState, author: boolean, seen = new Set<string>(), historicalSource = false): boolean {
    if (seen.has(image.id) || !imageVisible(image, state, author, historicalSource) || !author && !historicalSource && !this.active(image, state)) return false;
    if (author) return true;
    const nextSeen = new Set(seen); nextSeen.add(image.id);
    return imageReferences(image).every(referenceId => { const reference = this.get(referenceId); return Boolean(reference && reference.projectId === image.projectId && this.visible(reference, state, false, nextSeen, true)); });
  }
  all(projectId?: string): StoryImage[] { return this.db.prepare(`SELECT data FROM image_assets${projectId ? ' WHERE project_id=?' : ''} ORDER BY rowid`).all(...(projectId ? [projectId] : [])).map(row => JSON.parse(String(row.data))); }
  insert(image: StoryImage, content?: ImageContent) {
    if (content) validateImageContent(content);
    this.db.prepare('INSERT INTO image_assets VALUES(?,?,?,?,?)').run(image.id, image.projectId, image.branchId, JSON.stringify(image), content ? Buffer.from(content.bytes) : null);
  }
  update(image: StoryImage, content?: ImageContent) {
    if (content) validateImageContent(content);
    if (content) this.db.prepare('UPDATE image_assets SET data=?,content=? WHERE id=?').run(JSON.stringify(image), Buffer.from(content.bytes), image.id);
    else this.db.prepare('UPDATE image_assets SET data=? WHERE id=?').run(JSON.stringify(image), image.id);
  }
  content(id: string): ImageContent | undefined { const row = this.db.prepare('SELECT data,content FROM image_assets WHERE id=?').get(id); if (!row?.content) return undefined; const image = JSON.parse(String(row.data)) as StoryImage; return image.mimeType ? { bytes: Buffer.from(row.content as Uint8Array), mimeType: image.mimeType } : undefined; }
  export(projectId: string) { return this.all(projectId).map(image => ({ image, ...(this.content(image.id) ? { contentBase64: Buffer.from(this.content(image.id)!.bytes).toString('base64') } : {}) })); }
}
