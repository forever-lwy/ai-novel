import { readProjectSettings, saveProjectSettings } from './project-settings.js';
import { parseProjectSettingsOverrides } from './settings-schema.js';
import { DatabaseSync } from 'node:sqlite';
import { ensureDataDirectory, ensureDataFile } from './private-files.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { modelOutputSchema, OutputStore } from './output-store.js';
import { findEntitiesByName, reconcileExtractionEntities } from './entity-resolution.js';
import { rebuildCharacterProfileDescription, normalizeProfileAttribute } from './extraction.js';
import { repairLegacyExtractionVisibility } from './legacy-extraction-visibility.js';
import { readerEntityMaterial } from './reader-materials.js';
import { includesChapterVersion } from '../shared/chapter-versions.js';
import { clearChapterMaterials, removeEntities } from './chapter-maintenance.js';
import { ImageStore, imageBackupSchema, imageEntity, imageReferences, validateImageContent } from './image-store.js';
import { emptyState, type Branch, type BranchTreeEntry, type BranchView, type Chapter, type ChapterRef, type Entity, type ExtractionResult, type Foreshadow, type Job, type Mode, type Outline, type OutputIssue, type Project, type Revision, type StoryState, type WritingActivity, type ModelActivityEvent, type RpgSetup, type StoryReference, type OriginalReferenceData } from '../shared/types.js';

export class HttpError extends Error { constructor(message: string, public statusCode = 400) { super(message); } }
export class OutputValidationError extends HttpError { constructor(public issues: OutputIssue[], message = '模型输出未通过校验，请在作者输出记录中查看具体位置并修正') { super(message, 422); } }
export const RESTORE_MAX_REVISIONS = 5000;
export const RESTORE_MAX_STATE_BYTES = 64 * 1024 * 1024;
export const RESTORE_MAX_EXPANDED_STATE_BYTES = 256 * 1024 * 1024;
export const RESTORE_MAX_DEPTH = 64;
export const RESTORE_MAX_NODES = 1_000_000;
export const RESTORE_MAX_ARRAY_LENGTH = 100_000;
export const RESTORE_LIMITS = { maxRevisions: RESTORE_MAX_REVISIONS, maxStateBytes: RESTORE_MAX_STATE_BYTES, maxExpandedStateBytes: RESTORE_MAX_EXPANDED_STATE_BYTES, maxDepth: RESTORE_MAX_DEPTH, maxNodes: RESTORE_MAX_NODES, maxArrayLength: RESTORE_MAX_ARRAY_LENGTH };
type RestoreLimits = typeof RESTORE_LIMITS;
const restoreCapacityError = () => new HttpError('备份历史资料超过恢复容量上限，请停止服务并完整迁移数据目录', 413);

/** Bound untrusted JSON before schema validation or recursive ID remapping. */
export function validateBackupStructure(input: unknown, overrides: Partial<RestoreLimits> = {}): number {
  const limits = { ...RESTORE_LIMITS, ...overrides };
  const pending = [{ value: input, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw restoreCapacityError();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value) && value.length > limits.maxArrayLength) throw restoreCapacityError();
    const values = Object.values(value);
    if (nodes + pending.length + values.length > limits.maxNodes) throw restoreCapacityError();
    for (const child of values) pending.push({ value: child, depth: depth + 1 });
  }
  return nodes;
}
const now = () => new Date().toISOString();
const id = () => randomUUID();
const clone = <T>(value: T): T => structuredClone(value);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const pack = (state: StoryState) => gzipSync(JSON.stringify(state));
const unpack = (value: unknown): StoryState => JSON.parse(gunzipSync(value as Uint8Array).toString());
export const paragraphs = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
/** Extraction arrays need not follow prose order. A later citation defines the current exclusive state. */
function reconcileCurrentAttributes(entity: Entity, chapters: ChapterRef[]) {
  const order = new Map(chapters.map((chapter, index) => [chapter.id, index]));
  const attributes = new Set(entity.facts.filter(fact => fact.attribute && fact.temporal === 'current' && fact.certainty === 'fact').map(fact => fact.attribute!));
  for (const attribute of attributes) {
    const current = entity.facts.filter(fact => fact.attribute === attribute && fact.temporal === 'current' && fact.certainty === 'fact');
    if (current.length < 2) continue;
    const locked = current.filter(fact => fact.locked);
    if (locked.length) { for (const fact of current) if (!fact.locked) fact.certainty = 'conflict'; continue; }
    const rank = (fact: Entity['facts'][number]) => [order.get(fact.citation?.chapterId ?? '') ?? -1, fact.citation?.paragraph ?? -1];
    const latest = current.reduce((chosen, fact) => { const a = rank(chosen); const b = rank(fact); return b[0] > a[0] || (b[0] === a[0] && b[1] >= a[1]) ? fact : chosen; });
    for (const fact of current) if (fact !== latest) fact.temporal = 'past';
  }
}
const citationSchema = z.object({ chapterId: z.string(), paragraph: z.number().int().positive(), quote: z.string().min(1) });
const factSchema = z.object({ id: z.string().min(1), text: z.string(), attribute: z.string().optional(), temporal: z.enum(['current', 'past', 'future', 'unknown']), certainty: z.enum(['fact', 'inference', 'conflict']), visibility: z.enum(['public', 'secret']), citation: citationSchema.optional(), locked: z.boolean().optional() });
const entitySchema = z.object({ id: z.string().min(1), kind: z.enum(['character', 'faction', 'location', 'item', 'ability', 'rule', 'event']), name: z.string(), aliases: z.array(z.string()), description: z.string(), visibility: z.enum(['public', 'secret']), locked: z.boolean(), facts: z.array(factSchema), mergedInto: z.string().optional(), isMain: z.boolean().optional(), isMainSource: z.enum(['author', 'extraction']).optional(), nameStatus: z.enum(['placeholder', 'confirmed']).optional() });
const refSchema = z.object({ id: z.string().min(1), title: z.string(), sourceId: z.string().optional(), previousChapterIds: z.array(z.string().min(1)).max(RESTORE_MAX_REVISIONS).optional(), summary: z.string(), status: z.enum(['pending', 'ready', 'failed']), createdAt: z.string() });
export const rpgSetupSchema = z.object({ character: z.object({ kind: z.enum(['original', 'existing']), name: z.string().trim().max(300).default(''), description: z.string().max(30000).default(''), entityId: z.string().min(1).max(100).optional() }).strict(), entryChapterId: z.string().min(1).max(100).optional(), entryInstruction: z.string().max(10000).default('') }).strict();
export const rpgChoiceSchema = z.object({ question: z.string().trim().min(1).max(3000), options: z.array(z.object({ id: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(500), description: z.string().max(2000).optional() }).strict()).min(2).max(6).refine(options => new Set(options.map(option => option.id)).size === options.length, '选项标识不能重复') }).strict();
const savedRpgChoiceSchema = rpgChoiceSchema.extend({ id: z.string().min(1) });
const rpgSessionSchema = rpgSetupSchema.extend({ character: rpgSetupSchema.shape.character.extend({ name: z.string(), description: z.string() }), nextChoice: savedRpgChoiceSchema.extend({ jobId: z.string().min(1), chapterId: z.string().min(1), maxWords: z.number().int().min(100).max(20000), instruction: z.string().max(30000), followingChoices: z.array(savedRpgChoiceSchema).max(95).optional() }).optional() });
const sourceReferenceSchema = z.object({ branchId: z.string().min(1), revisionId: z.string().min(1), sourceIds: z.array(z.string().min(1)).refine(values => new Set(values).size === values.length).optional() }).strict();
const stateSchema = z.object({ sourceReference: sourceReferenceSchema.optional(), rpg: rpgSessionSchema.optional(), activeImageIds: z.array(z.string().min(1)).optional(), imagePlacements: z.record(z.string().min(1), z.object({ chapterId: z.string().min(1), selection: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict().optional(), sourceText: z.string().max(2000000).optional() }).strict()).optional(), imageIds: z.array(z.string().min(1)).optional(), chapters: z.array(refSchema), entities: z.array(entitySchema), relations: z.array(z.object({ id: z.string(), fromId: z.string(), toId: z.string(), label: z.string(), visibility: z.enum(['public', 'secret']), citation: citationSchema.optional() })), foreshadows: z.array(z.object({ id: z.string(), title: z.string(), detail: z.string(), status: z.enum(['planned', 'planted', 'resolved', 'abandoned']), plantedChapterId: z.string().optional(), resolvedChapterId: z.string().optional(), dueChapter: z.number().int().positive().optional(), revealCondition: z.string(), relatedEntityIds: z.array(z.string()) })), outline: z.object({ coarse: z.string().optional(), worldview: z.string().optional(), locked: z.string(), fine: z.array(z.object({ chapter: z.number().int().positive(), title: z.string(), goal: z.string() })), summaryCompression: z.object({ text: z.string(), chapterIds: z.array(z.string()) }).optional() }) });
const jobSchema = z.object({ id: z.string().min(1), projectId: z.string(), branchId: z.string(), kind: z.enum(['import', 'extract', 'generate', 'plan', 'image-placement']), status: z.enum(['queued', 'running', 'paused', 'failed', 'completed', 'cancelled', 'stale']), baseRevisionId: z.string(), progress: z.number().int().nonnegative(), total: z.number().int().nonnegative(), message: z.string(), error: z.string().optional(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), createdAt: z.string(), updatedAt: z.string(), payload: z.record(z.string(), z.unknown()) });
const writingActivitySchema = z.object({ id: z.string().min(1), kind: z.enum(['thinking', 'tool']), text: z.string().optional(), thinkingSource: z.enum(['native', 'preset']).optional(), thinkingTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), name: z.string().optional(), arguments: z.record(z.string(), z.unknown()).optional(), result: z.unknown().optional(), status: z.enum(['running', 'completed', 'failed']), error: z.string().optional(), proseOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() });
const backupSchema = z.object({ projectSettings: z.unknown().optional(), images: z.array(imageBackupSchema).default([]), version: z.literal(1), project: z.object({ id: z.string().min(1), title: z.string(), premise: z.string(), mode: z.enum(['original', 'continuation', 'fanfiction', 'rewrite', 'rpg']), createdAt: z.string(), updatedAt: z.string(), mainBranchId: z.string().min(1) }), branches: z.array(z.object({ id: z.string(), projectId: z.string(), name: z.string(), revisionId: z.string(), parentBranchId: z.string().optional(), forkChapterId: z.string().optional(), forkChapterTitle: z.string().max(500).optional(), createdAt: z.string(), deletedAt: z.string().datetime().optional() })).min(1), revisions: z.array(z.object({ revision: z.object({ id: z.string(), branchId: z.string(), parentId: z.string().optional(), restoredFromRevisionId: z.string().optional(), label: z.string(), createdAt: z.string(), chapterCount: z.number().int().nonnegative() }), state: z.unknown().optional(), snapshot: z.string().optional() }).refine(r => Boolean(r.state) !== Boolean(r.snapshot))).min(1).max(RESTORE_MAX_REVISIONS), chapters: z.array(refSchema.extend({ text: z.string() })), jobs: z.array(jobSchema).default([]), importChapters: z.array(z.object({ jobId: z.string(), position: z.number().int().nonnegative(), title: z.string(), text: z.string() })).default([]), outputs: z.array(modelOutputSchema).default([]), writingDrafts: z.array(z.object({ jobId: z.string(), text: z.string() })).default([]), writingActivities: z.array(z.object({ jobId: z.string(), activities: z.array(writingActivitySchema) })).default([]) });

/** Decode each historical state once, sharing one cumulative expansion budget. */
export function readBackupStates(entries: readonly { state?: unknown; snapshot?: string }[], overrides: Partial<RestoreLimits> = {}): StoryState[] {
  const limits = { ...RESTORE_LIMITS, ...overrides };
  if (entries.length > limits.maxRevisions) throw restoreCapacityError();
  let expandedBytes = 0, remainingNodes = limits.maxNodes;
  return entries.map(entry => {
    const available = Math.min(limits.maxStateBytes, limits.maxExpandedStateBytes - expandedBytes);
    if (available <= 0) throw restoreCapacityError();
    let value: unknown, bytes: number, nodes: number | undefined;
    try {
      if (entry.state !== undefined) {
        nodes = validateBackupStructure(entry.state, { ...limits, maxNodes: remainingNodes });
        const serialized = JSON.stringify(entry.state);
        if (serialized === undefined) throw new Error('invalid state');
        bytes = Buffer.byteLength(serialized, 'utf8'); value = entry.state;
      } else {
        const decoded = gunzipSync(Buffer.from(entry.snapshot ?? '', 'base64'), { maxOutputLength: available });
        bytes = decoded.length; value = JSON.parse(decoded.toString('utf8'));
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw restoreCapacityError();
      throw new HttpError('备份历史快照损坏或格式不正确');
    }
    if (bytes > available) throw restoreCapacityError();
    expandedBytes += bytes;
    remainingNodes -= nodes ?? validateBackupStructure(value, { ...limits, maxNodes: remainingNodes });
    const parsed = stateSchema.safeParse(value);
    if (!parsed.success) throw new HttpError('备份历史快照格式不正确');
    return parsed.data;
  });
}

export class Store {
  private cacheEpoch = randomUUID();
  /** Conservative validator: also covers in-place snapshot repairs and external writers. */
  cacheVersion(): string {
    return `${this.cacheEpoch}:${this.db.prepare('SELECT total_changes() AS n').get()!.n}:${this.db.prepare('PRAGMA data_version').get()!.data_version}`;
  }
  private legacyVisibilityCache = new Map<string, StoryState>();
  private legacyVisibilityVersion = '';
  readonly db: DatabaseSync;
  readonly outputs: OutputStore;
  readonly images: ImageStore;
  constructor(public readonly dataDir: string) {
    ensureDataDirectory(dataDir);
    const databasePath = join(dataDir, 'novel.sqlite');
    ensureDataFile(databasePath);
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, revision TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, parent_id TEXT, data TEXT NOT NULL, state BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS revision_branch ON revisions(branch_id);
      CREATE TABLE IF NOT EXISTS chapter_texts (id TEXT PRIMARY KEY, data TEXT NOT NULL, text TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chapter_search USING fts5(id UNINDEXED, title, text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_import_chapters (job_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(job_id,position));
      CREATE TABLE IF NOT EXISTS job_writing_drafts (job_id TEXT PRIMARY KEY, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_writing_activities (job_id TEXT NOT NULL, activity_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id,activity_id));
      CREATE INDEX IF NOT EXISTS jobs_branch ON jobs(branch_id,status);`);
    this.outputs = new OutputStore(this.db);
    this.images = new ImageStore(this.db);
  }
  close() { this.db.close(); }
  listWritingActivities(jobId: string): WritingActivity[] { return this.db.prepare('SELECT data FROM job_writing_activities WHERE job_id=? ORDER BY rowid').all(jobId).map(row => parse<WritingActivity>(row.data)); }
  clearWritingActivities(jobId: string) { this.db.prepare('DELETE FROM job_writing_activities WHERE job_id=?').run(jobId); }
  recordWritingActivity(jobId: string, event: ModelActivityEvent, redact?: (text: string) => string): WritingActivity | undefined {
    const row = this.db.prepare('SELECT data FROM job_writing_activities WHERE job_id=? AND activity_id=?').get(jobId, event.id);
    const previous = row ? parse<WritingActivity>(row.data) : undefined; let activity: WritingActivity;
    if (event.type === 'thinking') activity = { id: event.id, kind: 'thinking', text: (previous?.text ?? '') + event.text, ...(event.thinkingSource ? { thinkingSource: event.thinkingSource } : {}), status: 'running' };
    else if (event.type === 'thinking_usage') {
      if (!Number.isSafeInteger(event.thinkingTokens) || event.thinkingTokens <= 0) return undefined;
      activity = { id: event.id, kind: 'thinking', thinkingSource: 'native', thinkingTokens: event.thinkingTokens, status: 'completed' };
    }
    else if (event.type === 'thinking_done') { if (!previous || previous.kind !== 'thinking') return undefined; activity = { ...previous, status: 'completed' }; }
    else if (event.type === 'tool_call') activity = { id: event.id, kind: 'tool', name: event.name, arguments: clone(event.arguments), status: 'running' };
    else activity = { ...previous, id: event.id, kind: 'tool', name: event.name, result: clone(event.result), status: event.error ? 'failed' : 'completed', error: event.error };
    // Updates keep the original position, including legacy records without one.
    if (previous) { if (previous.proseOffset !== undefined) activity.proseOffset = previous.proseOffset; }
    else if (event.type === 'thinking_usage') {
      // Usage arrives at the end of the response; anchor it before this round's
      // prose, beside the tool results that started it. Unknown old cursors stay old.
      const lastTool = event.afterTools ? this.listWritingActivities(jobId).reverse().find(value => value.kind === 'tool') : undefined;
      if (!event.afterTools) activity.proseOffset = 0;
      else if (lastTool?.proseOffset !== undefined) activity.proseOffset = lastTool.proseOffset;
    }
    else {
      const draft = this.db.prepare('SELECT text FROM job_writing_drafts WHERE job_id=?').get(jobId);
      const text = String(draft?.text ?? '');
      activity.proseOffset = (redact ? parse<{ text: string }>(redact(JSON.stringify({ text }))).text : text).length;
    }
    const safe = redact ? parse<WritingActivity>(redact(JSON.stringify(activity))) : activity;
    this.db.prepare('INSERT INTO job_writing_activities VALUES(?,?,?) ON CONFLICT(job_id,activity_id) DO UPDATE SET data=excluded.data').run(jobId, safe.id, JSON.stringify(safe));
    return safe;
  }
  shiftWritingActivityOffsets(jobId: string, prefixLength: number) {
    if (!Number.isSafeInteger(prefixLength) || prefixLength < 0) throw new HttpError('正文过程前缀位置无效');
    if (!prefixLength) return;
    for (const activity of this.listWritingActivities(jobId)) if (activity.proseOffset !== undefined) {
      const offset = activity.proseOffset + prefixLength;
      if (!Number.isSafeInteger(offset)) throw new HttpError('正文过程位置无效');
      this.db.prepare('UPDATE job_writing_activities SET data=? WHERE job_id=? AND activity_id=?').run(JSON.stringify({ ...activity, proseOffset: offset }), jobId, activity.id);
    }
  }
  finishWritingActivities(jobId: string, error?: string): WritingActivity[] {
    const finished = this.listWritingActivities(jobId).filter(activity => activity.status === 'running').map(activity => ({ ...activity, status: error ? 'failed' as const : 'completed' as const, ...(error ? { error } : {}) }));
    for (const activity of finished) this.db.prepare('UPDATE job_writing_activities SET data=? WHERE job_id=? AND activity_id=?').run(JSON.stringify(activity), jobId, activity.id);
    return finished;
  }
  listProjects(): Project[] { return this.db.prepare('SELECT data FROM projects ORDER BY rowid DESC').all().map(r => parse<Project>(r.data)); }
  getProject(projectId: string): Project { const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(projectId); if (!row) throw new HttpError('作品不存在', 404); return parse(row.data); }
  deleteProject(projectId: string, onDelete?: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.getProject(projectId);
      // Chapter text is shared by story lines and historical snapshots, with no project column.
      // Include every stored revision, even one no longer reachable after a rollback.
      const chapters = new Set<string>(); const retained = new Set<string>();
      const collect = (owner: unknown, chapterId: string) => (owner === projectId ? chapters : retained).add(chapterId);
      for (const row of this.db.prepare('SELECT r.state,b.project_id FROM revisions r JOIN branches b ON b.id=r.branch_id').iterate()) {
        for (const chapter of unpack(row.state).chapters) collect(row.project_id, chapter.id);
      }
      for (const row of this.db.prepare('SELECT project_id,data FROM jobs').iterate()) {
        const job = parse<Job>(row.data);
        for (const field of ['chapterId', 'generatedChapterId', 'extractChapterId', 'importCurrentChapterId']) {
          const chapterId = job.payload[field]; if (typeof chapterId === 'string') collect(row.project_id, chapterId);
        }
      }
      for (const row of this.db.prepare('SELECT project_id,chapter_id FROM model_outputs WHERE chapter_id IS NOT NULL').iterate()) collect(row.project_id, String(row.chapter_id));
      this.db.prepare('DELETE FROM model_outputs WHERE project_id=?').run(projectId);
      this.db.prepare('DELETE FROM image_assets WHERE project_id=?').run(projectId);
      this.db.prepare('DELETE FROM job_import_chapters WHERE job_id IN (SELECT id FROM jobs WHERE project_id=?)').run(projectId);
      this.db.prepare('DELETE FROM job_writing_drafts WHERE job_id IN (SELECT id FROM jobs WHERE project_id=?)').run(projectId);
      this.db.prepare('DELETE FROM job_writing_activities WHERE job_id IN (SELECT id FROM jobs WHERE project_id=?)').run(projectId);
      this.db.prepare('DELETE FROM jobs WHERE project_id=?').run(projectId);
      this.db.prepare('DELETE FROM revisions WHERE branch_id IN (SELECT id FROM branches WHERE project_id=?)').run(projectId);
      this.db.prepare('DELETE FROM branches WHERE project_id=?').run(projectId);
      const deleteText = this.db.prepare('DELETE FROM chapter_texts WHERE id=?');
      const deleteSearch = this.db.prepare('DELETE FROM chapter_search WHERE id=?');
      for (const chapterId of chapters) if (!retained.has(chapterId)) { deleteSearch.run(chapterId); deleteText.run(chapterId); }
      this.db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
      onDelete?.(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  listBranches(projectId: string, includeDeleted = false): Branch[] { this.getProject(projectId); return this.db.prepare('SELECT data FROM branches WHERE project_id=? ORDER BY rowid').all(projectId).map(r => parse<Branch>(r.data)).filter(branch => includeDeleted || !branch.deletedAt); }
  listBranchTree(projectId: string): BranchTreeEntry[] {
    const branches = this.listBranches(projectId, true); const byId = new Map(branches.map(branch => [branch.id, branch]));
    const included = new Set<string>();
    for (const branch of branches.filter(branch => !branch.deletedAt)) {
      let next: Branch | undefined = branch;
      while (next && !included.has(next.id)) { included.add(next.id); next = next.parentBranchId ? byId.get(next.parentBranchId) : undefined; }
    }
    return branches.filter(branch => included.has(branch.id)).map(branch => {
      const chapters = this.revisionState(branch.revisionId).chapters.map(({ id, title }) => ({ id, title }));
      const chapter = !branch.forkChapterTitle && branch.forkChapterId ? this.db.prepare('SELECT data FROM chapter_texts WHERE id=?').get(branch.forkChapterId) : undefined;
      return { ...branch, forkChapterTitle: branch.forkChapterTitle || (chapter ? parse<ChapterRef>(chapter.data).title : undefined), chapters };
    });
  }
  renameBranch(branchId: string, base: string, name: string): Branch {
    const trimmed = name.trim(); if (!trimmed || trimmed.length > 200) throw new HttpError('故事线名称须为 1 至 200 个字符');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const branch = this.assertVersion(branchId, base); const project = this.getProject(branch.projectId);
      branch.name = trimmed; this.db.prepare('UPDATE branches SET data=? WHERE id=?').run(JSON.stringify(branch), branchId);
      project.updatedAt = now(); this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project), project.id);
      this.db.exec('COMMIT'); return branch;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getBranch(branchId: string, includeDeleted = false): Branch { const row = this.db.prepare('SELECT data FROM branches WHERE id=?').get(branchId); const branch = row ? parse<Branch>(row.data) : undefined; if (!branch || !includeDeleted && branch.deletedAt) throw new HttpError('故事线不存在或已删除', 404); return branch; }
  deleteBranch(branchId: string, base: string): { ok: true; mainBranchId: string } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const branch = this.assertVersion(branchId, base); const project = this.getProject(branch.projectId);
      if (project.mainBranchId === branchId) throw new HttpError('主线不能删除；如需删除整个作品，请返回书架操作', 409);
      if (this.db.prepare("SELECT 1 FROM jobs WHERE branch_id=? AND status IN ('queued','running','paused') AND COALESCE(json_extract(data,'$.kind'),'')!='image-placement' LIMIT 1").get(branchId) || this.images.all(branch.projectId).some(image => image.branchId === branchId && ['queued', 'running', 'paused'].includes(image.status))) throw new HttpError('请先完成或取消本分支的文字与生图任务，再删除分支', 409);
      // Keep immutable ancestors and references used by surviving story lines and backups.
      branch.deletedAt = now(); this.db.prepare('UPDATE branches SET data=? WHERE id=?').run(JSON.stringify(branch), branchId);
      project.updatedAt = now(); this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project), project.id);
      this.db.exec('COMMIT'); return { ok: true, mainBranchId: project.mainBranchId };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  revision(revisionId: string): Revision { const row = this.db.prepare('SELECT data FROM revisions WHERE id=?').get(revisionId); if (!row) throw new HttpError('版本不存在', 404); return parse(row.data); }
  private rawRevisionState(revisionId: string): StoryState { const row = this.db.prepare('SELECT state FROM revisions WHERE id=?').get(revisionId); if (!row) throw new HttpError('版本不存在', 404); return unpack(row.state); }
  revisionState(revisionId: string, reader = false): StoryState {
    const version = `${this.db.prepare('SELECT total_changes() AS changes').get()!.changes}:${this.db.prepare('PRAGMA data_version').get()!.data_version}`;
    if (version !== this.legacyVisibilityVersion) { this.legacyVisibilityVersion = version; this.legacyVisibilityCache.clear(); }
    const cacheKey = `${revisionId}:${reader}`;
    const cached = this.legacyVisibilityCache.get(cacheKey); if (cached) return clone(cached);
    const state = this.rawRevisionState(revisionId);
    this.repairEditedChapterLinks(revisionId, state);
    const projectId = this.getBranch(this.revision(revisionId).branchId, true).projectId;
    const outputs = this.db.prepare("SELECT data FROM model_outputs WHERE project_id=? AND stage='extraction' AND status='applied'").all(projectId).map(row => parse<import('../shared/types.js').ModelOutputRecord>(row.data));
    if (reader || outputs.some(output => output.adjustments?.some(change => /^entities\[\d+\]\.visibility$/.test(change.path) && change.message === '省略字段已补为 "secret"'))) {
      const lineage = this.materialHistory(revisionId); const positions = new Map(lineage.map((revision, index) => [revision.id, index]));
      const included = outputs.filter(output => positions.has(output.baseRevisionId)).sort((a, b) => positions.get(b.baseRevisionId)! - positions.get(a.baseRevisionId)! || (a.blockIndex ?? 0) - (b.blockIndex ?? 0));
      const { authorSecrets, authorEdits, authorSecretFacts } = this.authorEntityVisibility(lineage);
      repairLegacyExtractionVisibility(state, included, authorSecrets, { cumulativePublic: reader, authorEdits, authorSecretFacts });
    }
    // Ordinary snapshots need the same reuse as repaired legacy snapshots. Skip oversized entries.
    if (JSON.stringify(state).length > 4 * 1024 * 1024) return state;
    if (this.legacyVisibilityCache.size >= 8) this.legacyVisibilityCache.delete(this.legacyVisibilityCache.keys().next().value!);
    this.legacyVisibilityCache.set(cacheKey, clone(state));
    return state;
  }
  /** Recover only associations detached by old manual-edit snapshots; never rewrite saved evidence. */
  private repairEditedChapterLinks(revisionId: string, state: StoryState) {
    const unresolved = new Set(state.chapters.filter(chapter => !chapter.previousChapterIds).map(chapter => chapter.id));
    if (!unresolved.size) return;
    const aliases = new Map<string, string[]>(); const recovered = new Map<string, boolean>();
    for (const revision of this.materialHistory(revisionId).reverse()) {
      if (!revision.parentId || !revision.label.startsWith('编辑正文，保留已有资料')) continue;
      const before = this.rawRevisionState(revision.parentId); const after = this.rawRevisionState(revision.id);
      for (const [index, chapter] of after.chapters.entries()) {
        const previous = before.chapters[index];
        if (!previous || previous.id === chapter.id || chapter.previousChapterIds) continue;
        const previousChapterIds = [...new Set([...(previous.previousChapterIds ?? aliases.get(previous.id) ?? []), previous.id])];
        aliases.set(chapter.id, previousChapterIds);
        for (const imageId of before.imageIds ?? []) {
          const image = this.images.get(imageId);
          if (image?.chapterId && includesChapterVersion({ ...previous, previousChapterIds }, image.chapterId) && !after.imageIds?.includes(imageId)) recovered.set(imageId, before.activeImageIds ? before.activeImageIds.includes(imageId) : this.images.active(image, before));
        }
      }
    }
    for (const chapter of state.chapters) if (unresolved.has(chapter.id)) chapter.previousChapterIds = aliases.get(chapter.id) ?? [];
    const images = [...recovered].filter(([imageId]) => {
      const image = this.images.get(imageId)!;
      return state.chapters.some(chapter => unresolved.has(chapter.id) && includesChapterVersion(chapter, image.chapterId)) && (!image.entityId || !!imageEntity(state, image.entityId));
    });
    if (!images.length) return;
    this.images.hydrate(state);
    for (const [imageId, active] of images) if (!state.imageIds?.includes(imageId)) {
      const group = this.images.groupKey(this.images.get(imageId)!, state);
      const hasCurrentVersion = state.imageIds?.some(id => { const image = this.images.get(id); return image && this.images.groupKey(image, state) === group; });
      (state.imageIds ??= []).push(imageId);
      if (active && !hasCurrentVersion) state.activeImageIds!.push(imageId);
    }
  }
  private authorEntityVisibility(lineage: Revision[]) {
    const authorSecrets = new Set<string>(); const authorEdits = new Set<string>(); const authorSecretFacts = new Set<string>();
    for (const revision of [...lineage].reverse()) if (revision.label === '人工修改资料与锁定状态') {
      const after = this.rawRevisionState(revision.id); const before = revision.parentId ? this.rawRevisionState(revision.parentId) : emptyState();
      for (const entity of after.entities) if (JSON.stringify(entity) !== JSON.stringify(before.entities.find(previous => previous.id === entity.id))) {
        authorEdits.add(entity.id);
        if (entity.visibility === 'secret') authorSecrets.add(entity.id); else authorSecrets.delete(entity.id);
        const previous = before.entities.find(previous => previous.id === entity.id);
        for (const fact of entity.facts) if (JSON.stringify(fact) !== JSON.stringify(previous?.facts.find(old => old.id === fact.id))) {
          if (fact.visibility === 'secret') authorSecretFacts.add(fact.id); else authorSecretFacts.delete(fact.id);
        }
      }
    }
    return { authorSecrets, authorEdits, authorSecretFacts };
  }
  state(branchId: string): StoryState { return this.revisionState(this.getBranch(branchId).revisionId); }
  assertVersion(branchId: string, base: string): Branch { const branch = this.getBranch(branchId); if (!base || branch.revisionId !== base) throw new HttpError('故事线已有新版本，请刷新后重试；当前草稿不会被覆盖', 409); return branch; }
  private insertRevision(branch: Branch, state: StoryState, label: string, parentId?: string): Revision {
    const revision: Revision = { id: id(), branchId: branch.id, parentId, label, createdAt: now(), chapterCount: state.chapters.length };
    this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(revision.id, branch.id, parentId ?? null, JSON.stringify(revision), pack(state));
    return revision;
  }
  createProject(input: { title: string; premise?: string; mode?: Mode }): Project {
    if (!input.title?.trim()) throw new HttpError('请输入作品名称');
    const project: Project = { id: id(), title: input.title.trim(), premise: input.premise ?? '', mode: input.mode ?? 'original', createdAt: now(), updatedAt: now(), mainBranchId: id() };
    const branch: Branch = { id: project.mainBranchId, projectId: project.id, name: '主线', revisionId: '', createdAt: now() };
    const state = emptyState(); state.outline.locked = project.premise; state.outline.worldview = project.premise;
    this.db.exec('BEGIN IMMEDIATE');
    try { branch.revisionId = this.insertRevision(branch, state, '创建作品').id; this.db.prepare('INSERT INTO projects VALUES(?,?)').run(project.id, JSON.stringify(project)); this.db.prepare('INSERT INTO branches VALUES(?,?,?)').run(branch.id, project.id, JSON.stringify(branch)); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return project;
  }
  history(branchId: string, includeDeleted = false): Revision[] {
    const output: Revision[] = []; let current: string | undefined = this.getBranch(branchId, includeDeleted).revisionId; const visited = new Set<string>();
    while (current && !visited.has(current)) { visited.add(current); const revision = this.revision(current); output.push(revision); current = revision.parentId; }
    return output;
  }
  /** Keep audit history intact while reading canon from the version restored by a rollback. */
  private materialHistory(revisionId: string): Revision[] {
    const output: Revision[] = []; const visited = new Set<string>(); let current: string | undefined = revisionId;
    while (current && !visited.has(current)) { visited.add(current); const revision = this.revision(current); output.push(revision); current = revision.restoredFromRevisionId ?? revision.parentId; }
    return output;
  }
  /** Keep the historical state, including old names, merges and current attributes, intact. */
  readingState(branchId: string, chapterId?: string, reader = true): StoryState {
    const current = this.state(branchId);
    if (!chapterId) return this.revisionState(this.getBranch(branchId).revisionId, reader);
    const index = current.chapters.findIndex(chapter => chapter.id === chapterId);
    if (index < 0) throw new HttpError('阅读进度章节不属于当前故事线', 404);
    if (index === current.chapters.length - 1) return this.revisionState(this.getBranch(branchId).revisionId, reader);
    return this.atBoundary(branchId, index + 1, '显示阅读资料', reader);
  }
  view(branchId: string, author = false, chapterId?: string): BranchView {
    const branch = this.getBranch(branchId); const state = author ? this.state(branchId) : this.readingState(branchId, chapterId);
    const readingChapterId = author ? undefined : state.chapters.at(-1)?.id;
    if (!author) {
      delete state.rpg;
      delete state.sourceReference;
      const visibleImageIds = (state.imageIds ?? []).filter(imageId => { const image = this.images.get(imageId); return image && this.images.visible(image, state, false); });
      const included = new Set(state.chapters.map(chapter => chapter.id));
      state.outline = emptyState().outline; state.foreshadows = [];
      state.entities = state.entities.flatMap(entity => readerEntityMaterial(entity, state.chapters) ?? []);
      const visible = new Set(state.entities.map(e => e.id)); state.relations = state.relations.filter(r => r.visibility === 'public' && visible.has(r.fromId) && visible.has(r.toId) && (!r.citation || included.has(r.citation.chapterId)));
      // Navigation still includes later prose, but its materials never enter this reader snapshot.
      state.chapters = this.state(branchId).chapters.map(c => ({ ...c, summary: '' }));
      state.imageIds = visibleImageIds;
      delete state.imagePlacements;
      state.activeImageIds = visibleImageIds;
    }
    return { branch, state, revisions: author ? this.history(branchId) : [], ...(!author && readingChapterId ? { readingChapterId } : {}) };
  }
  commit(branchId: string, baseRevisionId: string, state: StoryState, label: string, checkpoint?: (revisionId: string, branchId: string) => void, boundaries: StoryState[] = []): BranchView {
    this.db.exec('BEGIN IMMEDIATE');
    try { const branch = this.assertVersion(branchId, baseRevisionId);
      // New boundary snapshots shadow old materials along this version path without rewriting history.
      for (const boundary of boundaries) branch.revisionId = this.insertRevision(branch, boundary, `${label} · 章末快照：${boundary.chapters.at(-1)?.title ?? '故事起点'}`, branch.revisionId).id;
      const revision = this.insertRevision(branch, state, label, branch.revisionId); branch.revisionId = revision.id;
      this.db.prepare('UPDATE branches SET data=? WHERE id=?').run(JSON.stringify(branch), branch.id);
      const project = this.getProject(branch.projectId); project.updatedAt = now(); this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project), project.id); checkpoint?.(revision.id, branch.id); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.view(branchId, true);
  }
  putChapter(title: string, text: string, sourceId?: string): ChapterRef {
    const chapter: Chapter = { id: id(), title: title.trim() || '未命名章节', text, sourceId, previousChapterIds: [], summary: '', status: 'pending', createdAt: now() };
    const { text: body, ...ref } = chapter;
    this.insertChapter(ref, body);
    return ref;
  }
  private insertChapter(ref: ChapterRef, text: string) {
    this.db.prepare('INSERT INTO chapter_texts VALUES(?,?,?)').run(ref.id, JSON.stringify(ref), text);
    this.db.prepare('INSERT INTO chapter_search(id,title,text) VALUES(?,?,?)').run(ref.id, ref.title, text);
  }
  chapter(branchId: string, chapterId: string): Chapter {
    const ref = this.state(branchId).chapters.find(c => c.id === chapterId); if (!ref) throw new HttpError('本故事线不包含这个章节', 404);
    const row = this.db.prepare('SELECT text FROM chapter_texts WHERE id=?').get(chapterId); if (!row) throw new HttpError('章节正文不存在', 404);
    return { ...ref, summary: '', text: String(row.text) };
  }
  /** Revisions are chapter-boundary snapshots; never reconstruct earlier canon from the latest world. */
  private atBoundary(branchId: string, count: number, purpose = '创建分支', reader = false): StoryState {
    const current = this.state(branchId);
    for (const revision of this.materialHistory(this.getBranch(branchId).revisionId)) {
      if (revision.chapterCount !== count) continue;
      const state = this.revisionState(revision.id, reader);
      if (state.chapters.length === count && state.chapters.every((chapter, index) => chapter.id === current.chapters[index]?.id)) return state;
    }
    throw new HttpError(`未找到该章节的历史状态，不能安全${purpose}`, 409);
  }
  /** Collect the newest snapshot of each unchanged prose prefix in one history scan. */
  private chapterTimeline(branchId: string, fromCount: number): StoryState[] {
    const current = this.state(branchId); const byCount = new Map<number, StoryState>([[current.chapters.length, current]]);
    for (const revision of this.materialHistory(this.getBranch(branchId).revisionId)) {
      if (revision.chapterCount < fromCount || byCount.has(revision.chapterCount)) continue;
      const state = this.revisionState(revision.id);
      if (state.chapters.every((chapter, index) => chapter.id === current.chapters[index]?.id)) byCount.set(state.chapters.length, state);
      if (byCount.size === current.chapters.length - fromCount + 1) break;
    }
    const states: StoryState[] = [];
    for (let count = fromCount; count <= current.chapters.length; count++) {
      const state = byCount.get(count); if (!state) throw new HttpError('缺少章节历史快照，不能安全更新资料', 409);
      states.push(state);
    }
    return states;
  }
  /** Illustrations added for an older chapter also belong to its later reading boundaries. */
  updateImageReferences(branchId: string, base: string, chapterId: string | undefined, update: (state: StoryState) => void, label: string, checkpoint?: (revisionId: string, branchId: string) => void): BranchView {
    this.assertVersion(branchId, base); const current = this.state(branchId);
    const index = chapterId ? current.chapters.findIndex(chapter => chapter.id === chapterId) : current.chapters.length - 1;
    if (chapterId && index < 0) throw new HttpError('图片关联章节不属于当前故事线', 404);
    const states = index >= 0 && index < current.chapters.length - 1 ? this.chapterTimeline(branchId, index + 1) : [current];
    for (const state of states) update(state);
    return this.commit(branchId, base, states.at(-1)!, label, checkpoint, states.slice(0, -1));
  }
  clearChapterExtraction(branchId: string, base: string, chapterId: string, checkpoint?: (revisionId: string, branchId: string) => void): BranchView {
    return this.changeChapterMaterials(branchId, base, chapterId, false, checkpoint);
  }
  updateChapterTitles(branchId: string, base: string, changes: { chapterId: string; originalTitle: string; title: string }[], checkpoint?: (revisionId: string, branchId: string) => void, label = '修复章节标题'): BranchView {
    this.assertVersion(branchId, base); const current = this.state(branchId);
    if (!changes.length || new Set(changes.map(change => change.chapterId)).size !== changes.length) throw new HttpError('章节标题修改为空或包含重复章节。');
    const replacements = new Map<string, string>(); let first = current.chapters.length;
    for (const change of changes) {
      const index = current.chapters.findIndex(chapter => chapter.id === change.chapterId);
      if (index < 0) throw new HttpError('本故事线不包含这个章节', 404);
      if (current.chapters[index].title !== change.originalTitle) throw new HttpError('章节标题已改变，请重新预览后再应用。', 409);
      const title = change.title.trim();
      if (!title || title.length > 500 || /[\r\n\u0000]/.test(title)) throw new HttpError('章节标题不能为空、超过500字符或含换行。');
      if (title !== change.originalTitle) { replacements.set(change.chapterId, title); first = Math.min(first, index); }
    }
    if (!replacements.size) throw new HttpError('所选标题没有变化。');
    const states = this.chapterTimeline(branchId, first + 1);
    for (const state of states) for (const chapter of state.chapters) if (replacements.has(chapter.id)) chapter.title = replacements.get(chapter.id)!;
    return this.commit(branchId, base, states.at(-1)!, label, checkpoint, states.slice(0, -1));
  }
  deleteChapter(branchId: string, base: string, chapterId: string): BranchView {
    return this.changeChapterMaterials(branchId, base, chapterId, true);
  }
  private changeChapterMaterials(branchId: string, base: string, chapterId: string, deleting: boolean, checkpoint?: (revisionId: string, branchId: string) => void): BranchView {
    this.assertVersion(branchId, base); const current = this.state(branchId); const index = current.chapters.findIndex(chapter => chapter.id === chapterId);
    if (index < 0) throw new HttpError('本故事线不包含这个章节', 404);
    const before = this.atBoundary(branchId, index, '更新章节资料'); const states = this.chapterTimeline(branchId, index + 1); const after = clone(states[0]);
    for (const state of states) {
      clearChapterMaterials(state, chapterId, before, after, deleting, id => this.images.get(id)?.entityId);
      for (const entity of state.entities) { reconcileCurrentAttributes(entity, state.chapters); entity.description = rebuildCharacterProfileDescription(entity); }
      if (deleting) {
        const removedChapter = state.chapters.find(chapter => chapter.id === chapterId)!;
        state.chapters = state.chapters.filter(chapter => chapter.id !== chapterId);
        state.imageIds = state.imageIds?.filter(id => !includesChapterVersion(removedChapter, this.images.get(id)?.chapterId));
        state.activeImageIds = state.activeImageIds?.filter(id => state.imageIds?.includes(id));
        if (state.imagePlacements) state.imagePlacements = Object.fromEntries(Object.entries(state.imagePlacements).filter(([id]) => state.imageIds?.includes(id)));
        state.outline.fine = state.outline.fine.map(plan => ({ ...plan, chapter: plan.chapter > index + 1 ? plan.chapter - 1 : plan.chapter })).filter(plan => plan.chapter > state.chapters.length);
        for (const clue of state.foreshadows) if (clue.dueChapter && clue.dueChapter > index + 1) clue.dueChapter--;
        if (state.rpg?.nextChoice?.chapterId === chapterId) delete state.rpg.nextChoice;
        if (state.rpg?.entryChapterId === chapterId) delete state.rpg.entryChapterId;
      }
    }
    return this.commit(branchId, base, states.at(-1)!, `${deleting ? '删除章节' : '清除本章提取资料'}：${current.chapters[index].title}`, checkpoint, states.slice(0, -1));
  }
  deleteEntity(branchId: string, base: string, entityId: string): BranchView {
    this.assertVersion(branchId, base); const current = this.state(branchId); const entity = current.entities.find(item => item.id === entityId);
    if (!entity) throw new HttpError('资料条目不属于当前故事线', 404);
    const removedIds = new Set([entityId]);
    // A merged alias must also stay deleted at chapters before the merge happened.
    for (;;) {
      const aliases = current.entities.filter(item => item.mergedInto && removedIds.has(item.mergedInto) && !removedIds.has(item.id));
      if (!aliases.length) break; for (const alias of aliases) removedIds.add(alias.id);
    }
    const states = this.chapterTimeline(branchId, 0);
    for (const state of states) removeEntities(state, new Set(removedIds), id => this.images.get(id)?.entityId);
    return this.commit(branchId, base, states.at(-1)!, `删除资料：${entity.name}`, undefined, states.slice(0, -1));
  }
  writingState(branchId: string, chapterId?: string): StoryState {
    if (!chapterId) return this.state(branchId);
    const index = this.state(branchId).chapters.findIndex(c => c.id === chapterId);
    if (index < 0) throw new HttpError('改写的章节不存在');
    return this.atBoundary(branchId, index);
  }
  private hasSources(): boolean { return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sources'").get()); }
  private captureSourceReference(branch: Branch, revisionId = branch.revisionId, cutoff?: string): StoryReference {
    const state = this.revisionState(revisionId); const candidates = new Set(state.chapters.flatMap(chapter => chapter.sourceId ? [chapter.sourceId] : []));
    for (const row of this.db.prepare("SELECT json_extract(data,'$.payload.sourceId') AS source_id,json_extract(data,'$.createdAt') AS created_at FROM jobs WHERE branch_id=? AND json_extract(data,'$.kind')='import' ORDER BY rowid").all(branch.id)) if (typeof row.source_id === 'string' && (!cutoff || String(row.created_at) <= cutoff)) candidates.add(row.source_id);
    const sourceIds = this.hasSources() ? (this.db.prepare('SELECT id FROM sources WHERE project_id=? AND confirmed=1').all(branch.projectId).map(row => String(row.id)).filter(sourceId => candidates.has(sourceId))) : [];
    return { branchId: branch.id, revisionId, sourceIds };
  }
  /** Resolve legacy lineage without changing the story or following another project's branch. */
  resolveSourceReference(branchId: string): StoryReference | undefined {
    const owner = this.getBranch(branchId); let branch = owner; let cutoff: string | undefined; let fence: number | undefined; let derived = false; const visited = new Set<string>();
    // Current exports preserve creation order. Older backups inserted history in
    // reverse order; ancestry detects that case so their rowids are never a clock.
    const ordered = !this.db.prepare('SELECT 1 FROM revisions c JOIN revisions p ON p.id=c.parent_id JOIN branches b ON b.id=c.branch_id WHERE b.project_id=? AND p.rowid>=c.rowid LIMIT 1').get(owner.projectId);
    while (!visited.has(branch.id)) {
      visited.add(branch.id); let revisionId = branch.revisionId;
      if (cutoff) {
        const rows = new Map(this.db.prepare('SELECT id,rowid AS sequence FROM revisions WHERE branch_id=?').all(branch.id).map(row => [String(row.id), Number(row.sequence)]));
        const historical = this.history(branch.id, true).find(revision => revision.branchId === branch.id && (ordered ? revision.createdAt <= cutoff! && (fence === undefined || rows.get(revision.id)! < fence) : revision.createdAt < cutoff!));
        if (!historical) return undefined; revisionId = historical.id;
      }
      const state = this.revisionState(revisionId);
      if (state.sourceReference) { this.assertSourceReference(owner.projectId, state.sourceReference); return clone(state.sourceReference); }
      let sourceBranchId: string | undefined;
      for (const row of this.db.prepare("SELECT json_extract(data,'$.payload.sourceBranchId') AS source_branch_id,json_extract(data,'$.createdAt') AS created_at FROM jobs WHERE branch_id=? AND json_extract(data,'$.kind')='generate' ORDER BY rowid").all(branch.id)) if ((!cutoff || String(row.created_at) <= cutoff) && typeof row.source_branch_id === 'string' && row.source_branch_id !== branch.id) { sourceBranchId = row.source_branch_id; break; }
      sourceBranchId ??= branch.parentBranchId;
      if (sourceBranchId) {
        const row = this.db.prepare('SELECT data FROM branches WHERE id=? AND project_id=?').get(sourceBranchId, owner.projectId);
        if (!row) return undefined;
        const firstRevision = Number(this.db.prepare('SELECT MIN(rowid) AS sequence FROM revisions WHERE branch_id=?').get(branch.id)!.sequence);
        fence = fence === undefined ? firstRevision : Math.min(fence, firstRevision);
        derived = true; cutoff = cutoff && cutoff < branch.createdAt ? cutoff : branch.createdAt; branch = parse<Branch>(row.data); continue;
      }
      const reference = this.captureSourceReference(branch, revisionId, cutoff);
      return derived || reference.sourceIds?.length ? reference : undefined;
    }
    return undefined;
  }
  private assertSourceReference(projectId: string, reference: StoryReference) {
    const parsed = sourceReferenceSchema.safeParse(reference);
    if (!parsed.success) throw new HttpError('原作参考记录格式不正确', 409);
    const branch = this.getBranch(reference.branchId, true); const revision = this.revision(reference.revisionId);
    if (branch.projectId !== projectId || revision.branchId !== branch.id) throw new HttpError('原作参考版本不属于本作品或故事线', 409);
    for (const sourceId of reference.sourceIds ?? []) if (!this.hasSources() || !this.db.prepare('SELECT 1 FROM sources WHERE id=? AND project_id=? AND confirmed=1').get(sourceId, projectId)) throw new HttpError('原作参考文件不属于本作品或尚未确认', 409);
  }
  originalReference(branchId: string, reference: StoryReference): OriginalReferenceData {
    const owner = this.getBranch(branchId); this.assertSourceReference(owner.projectId, reference);
    const state = this.revisionState(reference.revisionId);
    const chapters = state.chapters.map(chapter => {
      const row = this.db.prepare('SELECT text FROM chapter_texts WHERE id=?').get(chapter.id);
      if (!row) throw new HttpError('原作参考章节正文不存在', 409);
      return { ...chapter, text: String(row.text) };
    });
    const sources = (reference.sourceIds ?? []).map(sourceId => {
      const row = this.hasSources() ? this.db.prepare('SELECT filename,preview FROM sources WHERE id=? AND project_id=? AND confirmed=1').get(sourceId, owner.projectId) : undefined;
      if (!row) throw new HttpError('原作参考文件不存在或尚未确认，请从完整作品备份恢复', 409);
      return { sourceId, filename: String(row.filename), chapters: parse<{ title: string; text: string }[]>(row.preview) };
    });
    return { reference: clone(reference), state, chapters, sources };
  }
  /** Re-generation always forks before its target, including the latest unfinished chapter. */
  forkForGeneration(branchId: string, base: string, chapterId: string, name?: string): BranchView {
    const original = this.assertVersion(branchId, base); const current = this.state(branchId);
    const index = current.chapters.findIndex(chapter => chapter.id === chapterId);
    if (index < 0) throw new HttpError('重新生成的章节不存在', 404);
    const state = this.cleanBoundary(this.atBoundary(branchId, index));
    if (state.chapters.some(chapter => chapter.status !== 'ready')) throw new HttpError('前面的章节尚未整理完成，请先完成资料整理', 409);
    state.outline.locked = current.outline.locked;
    state.outline.worldview = current.outline.worldview;
    // Deliberate future plans may survive; the rejected chapter's discovered facts may not.
    const currentPlans = clone(current.outline.fine).filter(plan => plan.chapter > index);
    state.outline.fine = [...state.outline.fine.filter(plan => plan.chapter > index && !currentPlans.some(current => current.chapter === plan.chapter)), ...currentPlans].sort((a, b) => a.chapter - b.chapter);
    for (const entity of state.entities) {
      const authored = current.entities.find(item => item.id === entity.id);
      if (authored?.isMainSource === 'author') { entity.isMain = authored.isMain; entity.isMainSource = 'author'; }
    }
    return this.createFork(original, state, name ?? `重新生成 · ${current.chapters[index].title}`.slice(0, 200), current.chapters[index - 1]?.id, this.generationParent(original, state));
  }
  /** Regenerating inherited prose branches from its source, not from a rejected replacement. */
  private generationParent(original: Branch, state: StoryState): string {
    let parent = original; const visited = new Set<string>();
    while (parent.parentBranchId && !visited.has(parent.id)) {
      visited.add(parent.id);
      const creation = this.history(parent.id, true).filter(revision => revision.branchId === parent.id).at(-1);
      if (!creation) break;
      const inherited = this.revisionState(creation.id).chapters;
      if (state.chapters.length > inherited.length || !state.chapters.every((chapter, index) => chapter.id === inherited[index]?.id)) break;
      const source = this.getBranch(parent.parentBranchId, true);
      if (source.projectId !== original.projectId || visited.has(source.id)) break;
      parent = source;
    }
    return parent.id;
  }
  private cleanBoundary(state: StoryState): StoryState {
    const included = new Set(state.chapters.map(c => c.id));
    for (const entity of state.entities) entity.facts = entity.facts.filter(f => f.temporal !== 'future' && (!f.citation || included.has(f.citation.chapterId)));
    state.relations = state.relations.filter(r => !r.citation || included.has(r.citation.chapterId));
    return state;
  }
  fork(branchId: string, input: { baseRevisionId: string; chapterId?: string; name: string }): BranchView {
    const original = this.assertVersion(branchId, input.baseRevisionId); const current = this.state(branchId);
    const index = input.chapterId ? current.chapters.findIndex(c => c.id === input.chapterId) : current.chapters.length - 1;
    if (input.chapterId && index < 0) throw new HttpError('分支起点不存在');
    const state = this.cleanBoundary(input.chapterId ? this.atBoundary(branchId, index + 1) : current);
    if (state.chapters.some(c => c.status !== 'ready')) throw new HttpError('请先完成资料整理再创建分支', 409);
    return this.createFork(original, state, input.name, input.chapterId ?? state.chapters.at(-1)?.id);
  }
  /** A playthrough starts from an immutable canon boundary and owns its own character setup. */
  startRpgFork(branchId: string, baseRevisionId: string, input: RpgSetup, name?: string): BranchView {
    const setup = rpgSetupSchema.parse(input); const original = this.assertVersion(branchId, baseRevisionId);
    const current = this.state(branchId); const index = setup.entryChapterId ? current.chapters.findIndex(chapter => chapter.id === setup.entryChapterId) : current.chapters.length - 1;
    if (setup.entryChapterId && index < 0) throw new HttpError('穿越起点不属于当前故事线');
    const state = this.cleanBoundary(setup.entryChapterId ? this.atBoundary(branchId, index + 1) : current);
    if (state.chapters.some(chapter => chapter.status !== 'ready')) throw new HttpError('穿越起点之前的资料尚未整理完成，请先完成资料整理', 409);
    if (setup.character.kind === 'existing') {
      const entity = state.entities.find(entity => entity.id === setup.character.entityId && entity.kind === 'character' && !entity.mergedInto);
      if (!entity) throw new HttpError('所选已有角色在穿越起始版本中不存在，请选择该版本已有的人物');
      setup.character = { kind: 'existing', entityId: entity.id, name: entity.name, description: entity.description };
    } else {
      if (!setup.character.name.trim()) throw new HttpError('请填写原创角色名称');
      setup.character = { kind: 'original', name: setup.character.name.trim(), description: setup.character.description };
    }
    state.rpg = { ...setup, entryInstruction: setup.entryInstruction ?? '' };
    // Source future plans guide writing; the user's choices determine this playthrough.
    state.outline.fine = [];
    return this.createFork(original, state, name ?? `RPG · ${setup.character.name}`.slice(0, 200), setup.entryChapterId ?? state.chapters.at(-1)?.id);
  }
  private createFork(original: Branch, state: StoryState, name: string, forkChapterId?: string, parentBranchId = original.id): BranchView {
    state.sourceReference ??= clone(this.state(original.id).sourceReference ?? this.captureSourceReference(original));
    const trimmed = name.trim(); if (!trimmed || trimmed.length > 200) throw new HttpError('故事线名称须为 1 至 200 个字符');
    const forkChapterTitle = forkChapterId ? this.state(original.id).chapters.find(chapter => chapter.id === forkChapterId)?.title : '故事开头';
    const branch: Branch = { id: id(), projectId: original.projectId, name: trimmed, revisionId: '', parentBranchId, forkChapterId, forkChapterTitle, createdAt: now() };
    // Link to the actual boundary revision so historical edits on a fork can find older snapshots.
    const boundary = this.history(original.id).find(r => r.chapterCount === state.chapters.length && this.revisionState(r.id).chapters.every((chapter, index) => chapter.id === state.chapters[index]?.id));
    branch.revisionId = this.insertRevision(branch, state, `创建故事线：${branch.name}`, boundary?.id).id;
    this.db.prepare('INSERT INTO branches VALUES(?,?,?)').run(branch.id, branch.projectId, JSON.stringify(branch)); return this.view(branch.id, true);
  }
  saveChapter(branchId: string, input: { baseRevisionId: string; title: string; text: string; chapterId?: string }, checkpoint?: (revisionId: string, branchId: string) => void, prepareState?: (state: StoryState) => void): BranchView {
    const branch = this.assertVersion(branchId, input.baseRevisionId); const state = this.state(branchId);
    if (!input.text.trim()) throw new HttpError('正文不能为空');
    if (input.chapterId) return this.editChapter(branch, state, { ...input, chapterId: input.chapterId }, checkpoint, prepareState);
    if (state.chapters.some(c => c.status !== 'ready')) throw new HttpError('上一章资料尚未整理完成，请先重试整理', 409);
    const chapter = this.putChapter(input.title, input.text); state.chapters.push(chapter);
    // A chapter-end choice is tied to immutable prose; manual replacement cannot advance the old scene.
    if (state.rpg?.nextChoice && state.rpg.nextChoice.chapterId !== chapter.id) delete state.rpg.nextChoice;
    prepareState?.(state);
    state.outline.fine = state.outline.fine.filter(plan => plan.chapter > state.chapters.length);
    return this.commit(branch.id, branch.revisionId, state, '保存正文，等待资料整理', checkpoint);
  }
  private editChapter(branch: Branch, current: StoryState, input: { title: string; text: string; chapterId: string }, checkpoint?: (revisionId: string, branchId: string) => void, prepareState?: (state: StoryState) => void): BranchView {
    const index = current.chapters.findIndex(chapter => chapter.id === input.chapterId);
    if (index < 0) throw new HttpError('要修改的章节不存在', 404);
    const original = current.chapters[index]; const textChanged = this.chapter(branch.id, original.id).text !== input.text;
    const replacement: ChapterRef = { ...original, id: textChanged ? id() : original.id, title: input.title.trim() || '未命名章节', ...(textChanged ? { previousChapterIds: [...(original.previousChapterIds ?? []), original.id] } : {}) };
    const states = this.chapterTimeline(branch.id, index + 1); const lines = paragraphs(input.text);
    const reference = current.sourceReference ?? this.captureSourceReference(branch);
    const citation = (value: Entity['facts'][number]['citation']) => {
      if (!value || value.chapterId !== original.id || !textChanged) return value;
      if (lines[value.paragraph - 1]?.includes(value.quote)) return { ...value, chapterId: replacement.id };
      const matches = lines.flatMap((line, index) => line.includes(value.quote) ? [index + 1] : []);
      // Preserve the material itself; only detach evidence no longer present in the edited prose.
      return matches.length === 1 ? { ...value, chapterId: replacement.id, paragraph: matches[0] } : undefined;
    };
    for (const state of states) {
      state.chapters[index] = clone(replacement); state.sourceReference ??= clone(reference);
      for (const entity of state.entities) for (const fact of entity.facts) fact.citation = citation(fact.citation);
      for (const relation of state.relations) relation.citation = citation(relation.citation);
      for (const clue of state.foreshadows) {
        if (clue.plantedChapterId === original.id) clue.plantedChapterId = replacement.id;
        if (clue.resolvedChapterId === original.id) clue.resolvedChapterId = replacement.id;
      }
      if (state.outline.summaryCompression) state.outline.summaryCompression.chapterIds = state.outline.summaryCompression.chapterIds.map(chapterId => chapterId === original.id ? replacement.id : chapterId);
      if (state.rpg?.entryChapterId === original.id) state.rpg.entryChapterId = replacement.id;
      if (textChanged) {
        if (state.rpg?.nextChoice) delete state.rpg.nextChoice;
        // Keep original image evidence and selections; project their chapter through this revision's lineage.
      }
    }
    const state = states.at(-1)!; prepareState?.(state);
    return this.commit(branch.id, branch.revisionId, state, '编辑正文，保留已有资料', (revisionId, branchId) => {
      if (textChanged) this.insertChapter(replacement, input.text);
      checkpoint?.(revisionId, branchId);
    }, states.slice(0, -1));
  }
  rollback(branchId: string, input: { baseRevisionId: string; revisionId: string }): BranchView {
    this.assertVersion(branchId, input.baseRevisionId);
    if (!this.history(branchId).some(r => r.id === input.revisionId)) throw new HttpError('只能回退到本故事线的历史版本');
    return this.commit(branchId, input.baseRevisionId, this.revisionState(input.revisionId), '回退正文与世界资料', revisionId => {
      const revision = { ...this.revision(revisionId), restoredFromRevisionId: input.revisionId };
      this.db.prepare('UPDATE revisions SET data=? WHERE id=?').run(JSON.stringify(revision), revisionId);
    });
  }
  updateOutline(branchId: string, base: string, outline: Outline): BranchView {
    this.assertVersion(branchId, base); const state = this.state(branchId);
    // Summary replacement goes through the separate author-confirmation endpoint.
    state.outline = { worldview: outline.worldview ?? state.outline.worldview ?? '', locked: outline.locked, fine: clone(outline.fine).filter(plan => plan.chapter > state.chapters.length), summaryCompression: state.outline.summaryCompression };
    return this.commit(branchId, base, state, '修改世界观与预期规划');
  }
  updateEntity(branchId: string, base: string, entity: Entity): BranchView {
    this.assertVersion(branchId, base); const state = this.state(branchId); const index = state.entities.findIndex(e => e.id === entity.id);
    const replacement = clone(entity); replacement.id = index >= 0 ? entity.id : id(); replacement.facts = replacement.facts.map(f => ({ ...f, id: f.id || id(), attribute: f.attribute ? normalizeProfileAttribute(f.attribute) : undefined }));
    if (replacement.isMain !== undefined) replacement.isMainSource = 'author';
    const included = new Set(state.chapters.map(c => c.id));
    for (const fact of replacement.facts) {
      const citation = fact.citation; if (!citation) continue;
      if (!included.has(citation.chapterId) || !Number.isInteger(citation.paragraph) || citation.paragraph < 1 || !citation.quote.trim() || !paragraphs(this.chapter(branchId, citation.chapterId).text)[citation.paragraph - 1]?.includes(citation.quote)) throw new HttpError('资料引用必须对应本故事线的有效章节、段落和原文');
    }
    if (replacement.mergedInto) {
      const target = state.entities.find(e => e.id === replacement.mergedInto);
      if (!target || target.id === replacement.id || target.kind !== replacement.kind || target.mergedInto) throw new HttpError('合并目标必须是本故事线中另一个同类型且未被合并的资料');
    }
    if (index < 0) state.entities.push(replacement); else state.entities[index] = replacement;
    return this.commit(branchId, base, state, '人工修改资料与锁定状态');
  }
  mergeEntities(branchId: string, base: string, fromId: string, toId: string): BranchView {
    this.assertVersion(branchId, base); const state = this.state(branchId); const from = state.entities.find(e => e.id === fromId && !e.mergedInto); const to = state.entities.find(e => e.id === toId && !e.mergedInto);
    if (!from || !to || fromId === toId || from.kind !== to.kind) throw new HttpError('请选择两个不同且类型相同的资料条目');
    to.aliases = [...new Set([...to.aliases, from.name, ...from.aliases])]; to.facts.push(...from.facts); to.locked = true; from.mergedInto = to.id;
    if (to.isMainSource !== 'author' && from.isMainSource === 'author') { to.isMain = from.isMain; to.isMainSource = 'author'; }
    state.relations = state.relations.map(r => ({ ...r, fromId: r.fromId === fromId ? toId : r.fromId, toId: r.toId === fromId ? toId : r.toId }));
    for (const f of state.foreshadows) f.relatedEntityIds = [...new Set(f.relatedEntityIds.map(e => e === fromId ? toId : e))];
    return this.commit(branchId, base, state, `合并资料：${from.name} → ${to.name}`);
  }
  updateForeshadows(branchId: string, base: string, foreshadows: Foreshadow[]): BranchView {
    this.assertVersion(branchId, base); const state = this.state(branchId); const ids = new Set(state.entities.map(e => e.id));
    if (foreshadows.some(f => f.relatedEntityIds.some(e => !ids.has(e)))) throw new HttpError('伏笔引用了不存在的人物或资料');
    const included = new Set(state.chapters.map(c => c.id));
    if (foreshadows.some(f => (f.plantedChapterId && !included.has(f.plantedChapterId)) || (f.resolvedChapterId && !included.has(f.resolvedChapterId)))) throw new HttpError('伏笔埋设和揭晓位置必须属于本故事线');
    state.foreshadows = clone(foreshadows).map(f => ({ ...f, id: f.id || id() })); return this.commit(branchId, base, state, '修改伏笔');
  }
  search(branchId: string, query: string, author = false, chapterId?: string): { chapters: { id: string; title: string; snippet: string }[]; entities: Entity[] } {
    const q = query.trim().slice(0, 200); if (!q) return { chapters: [], entities: [] }; const state = this.view(branchId, author, chapterId).state;
    if (q.includes('\0')) throw new HttpError('搜索关键词不能包含空字符');
    const allowed = JSON.stringify(state.chapters.map(c => c.id));
    // Trigram accelerates Chinese search; short words use exact substring matching.
    const rows = !state.chapters.length ? [] : q.length >= 3
      ? this.db.prepare('SELECT id,substr(text,max(1,instr(text,?)-40),length(?)+100+min(40,max(0,instr(text,?)-1))) AS snippet FROM chapter_search WHERE id IN (SELECT value FROM json_each(?)) AND chapter_search MATCH ? LIMIT 60').all(q, q, q, allowed, `"${q.replace(/"/g, '""')}"`)
      : this.db.prepare('SELECT id,substr(text,max(1,instr(text,?)-40),length(?)+100+min(40,max(0,instr(text,?)-1))) AS snippet FROM chapter_search WHERE id IN (SELECT value FROM json_each(?)) AND (instr(text,?)>0 OR instr(title,?)>0) LIMIT 60').all(q, q, q, allowed, q, q);
    const refs = new Map(state.chapters.map(chapter => [chapter.id, chapter]));
    const normalizedQuery = normalize(q);
    const chapters = rows.flatMap(row => {
      const ref = refs.get(String(row.id))!; const snippet = String(row.snippet);
      if (!normalize(ref.title).includes(normalizedQuery) && !normalize(snippet).includes(normalizedQuery)) {
        const text = this.db.prepare('SELECT text FROM chapter_texts WHERE id=?').get(ref.id)!.text;
        if (!normalize(String(text)).includes(normalizedQuery)) return [];
      }
      return [{ id: ref.id, title: ref.title, snippet }];
    });
    // Titles can change without replacing immutable prose shared by other branches.
    for (const ref of state.chapters) if (chapters.length < 60 && normalize(ref.title).includes(normalizedQuery) && !chapters.some(chapter => chapter.id === ref.id)) chapters.push({ id: ref.id, title: ref.title, snippet: String(this.db.prepare('SELECT text FROM chapter_texts WHERE id=?').get(ref.id)!.text).slice(0, 140) });
    const entities = state.entities.filter(e => !e.mergedInto && normalize([e.name, ...e.aliases, e.description, ...e.facts.map(f => f.text)].join(' ')).includes(normalize(q))).slice(0, 60);
    return { chapters, entities };
  }
  exportText(branchId: string): string { return this.state(branchId).chapters.map(c => `${c.title}\n\n${this.chapter(branchId, c.id).text}`).join('\n\n'); }
  applyExtraction(branchId: string, base: string, chapterId: string, result: ExtractionResult, complete: boolean, checkpoint?: (revisionId: string, branchId: string) => void): BranchView {
    this.assertVersion(branchId, base); const current = this.state(branchId); const index = current.chapters.findIndex(chapter => chapter.id === chapterId);
    if (index < 0) throw new HttpError('整理章节不属于当前故事线');
    const states = index < current.chapters.length - 1 ? this.chapterTimeline(branchId, index + 1) : [current];
    const identities = new Map<string, string>();
    const allocate = (key: string) => { if (!identities.has(key)) identities.set(key, id()); return identities.get(key)!; };
    // The same discoveries retain their IDs across every chapter-end snapshot.
    for (const extracted of result.entities) {
      const matches = findEntitiesByName(current, extracted.name, extracted.kind);
      if (matches.length === 1) identities.set(`entity:${extracted.kind}:${normalize(extracted.name)}`, matches[0].id);
    }
    for (const clue of current.foreshadows) identities.set(`clue:${normalize(clue.title)}`, clue.id);
    const lines = paragraphs(this.chapter(branchId, chapterId).text);
    const lineage = this.materialHistory(this.getBranch(branchId).revisionId);
    for (const state of states) {
      const boundary = lineage.findIndex(revision => revision.chapterCount === state.chapters.length && this.rawRevisionState(revision.id).chapters.every((chapter, index) => chapter.id === state.chapters[index]?.id));
      const { authorSecrets } = this.authorEntityVisibility(lineage.slice(boundary));
      this.extractIntoState(state, chapterId, result, complete, lines, allocate, authorSecrets);
    }
    return this.commit(branchId, base, states.at(-1)!, `${complete ? '完成资料整理' : '整理章节片段'}：${current.chapters[index].title}`, checkpoint, states.slice(0, -1));
  }
  private extractIntoState(state: StoryState, chapterId: string, result: ExtractionResult, complete: boolean, lines: string[], allocate: (key: string) => string, authorSecrets: Set<string>) {
    const ref = state.chapters.find(chapter => chapter.id === chapterId)!;
    const citation = (paragraph: number, quote: string) => ({ chapterId, paragraph, quote });
    const issues: OutputIssue[] = [];
    const validateCitation = (paragraph: number, quote: string, path: string) => { if (!Number.isInteger(paragraph) || paragraph < 1 || !quote.trim() || !lines[paragraph - 1]?.includes(quote)) issues.push({ path, message: '引用必须是该编号原文段落中的逐字片段（含原始标点）', paragraph, quote, sourceText: lines[paragraph - 1] ?? '' }); };
    // Validate every reference before changing even the in-memory state.
    result.entities.forEach((e, i) => e.facts.forEach((fact, j) => validateCitation(fact.paragraph, fact.quote, `entities[${i}].facts[${j}].quote`)));
    result.relations.forEach((relation, i) => validateCitation(relation.paragraph, relation.quote, `relations[${i}].quote`));
    if (issues.length) throw new OutputValidationError(issues, '原文引用校验失败，请在作者输出记录中查看具体位置并修正');
    const reconciled = reconcileExtractionEntities(state, result.entities);
    if (reconciled.issues.length) throw new OutputValidationError(reconciled.issues, '实体身份存在歧义，请核对名称与别名');
    const resolve = (name: string, kind?: Entity['kind']) => {
      const matches = findEntitiesByName(state, name, kind);
      for (const binding of reconciled.nameBindings.filter(binding => (!kind || binding.kind === kind) && normalize(binding.name) === normalize(name))) {
        const entity = state.entities.find(entity => entity.id === binding.entityId && !entity.mergedInto);
        if (entity && !matches.some(match => match.id === entity.id)) matches.push(entity);
      }
      return matches;
    };
    for (const extracted of reconciled.entities) {
      const matches = resolve(extracted.name, extracted.kind);
      let entity = matches.length === 1 ? matches[0] : undefined;
      const ambiguous = matches.length > 1;
      if (!entity) { entity = { id: allocate(`entity:${extracted.kind}:${normalize(extracted.name)}`), kind: extracted.kind, name: extracted.name, aliases: extracted.aliases, description: '', visibility: extracted.visibility, locked: false, facts: [], nameStatus: extracted.nameStatus, isMain: extracted.isMain, isMainSource: extracted.isMain !== undefined ? 'extraction' : undefined }; state.entities.push(entity); }
      // Locked records retain human prose and aliases; evidence may be appended, never overwritten.
      const laterEvidence = entity.facts.some(fact => state.chapters.findIndex(chapter => chapter.id === fact.citation?.chapterId) > state.chapters.findIndex(chapter => chapter.id === chapterId));
      if (!entity.locked) {
        if (authorSecrets.has(entity.id)) entity.visibility = 'secret';
        if (extracted.visibility === 'public' || entity.visibility === 'secret') {
          entity.aliases = [...new Set([...entity.aliases, ...extracted.aliases])].filter(alias => alias !== entity.name);
          if (!laterEvidence && extracted.description.trim() && extracted.facts.some(f => f.temporal === 'current')) entity.description = extracted.description;
          if (!laterEvidence && (extracted.nameStatus === 'confirmed' || !entity.nameStatus)) entity.nameStatus = extracted.nameStatus;
          if (!laterEvidence && entity.isMainSource !== 'author' && extracted.isMain !== undefined) { entity.isMain = extracted.isMain; entity.isMainSource = 'extraction'; }
        }
        if (!authorSecrets.has(entity.id) && extracted.visibility === 'public' && extracted.facts.some(fact => fact.visibility === 'public' && fact.temporal !== 'future')) entity.visibility = 'public';
      }
      for (const fact of [...extracted.facts].sort((a, b) => a.paragraph - b.paragraph)) {
        if (entity.facts.some(f => f.text === fact.text && f.attribute === fact.attribute && f.citation?.chapterId === chapterId && f.citation.paragraph === fact.paragraph && f.citation.quote === fact.quote)) continue;
        let conflict = ambiguous || (entity.locked && fact.temporal === 'current');
        if (fact.attribute && fact.temporal === 'current' && fact.certainty === 'fact') {
          const oldCurrent = entity.facts.filter(f => f.attribute === fact.attribute && f.temporal === 'current' && f.certainty === 'fact');
          if (oldCurrent.some(f => f.locked)) conflict = true;
          // Keep candidates until their citations can be compared across the whole extraction.
        }
        entity.facts.push({ id: allocate(`fact:${entity.id}:${JSON.stringify(fact)}`), text: fact.text, attribute: fact.attribute, temporal: fact.temporal, certainty: conflict ? 'conflict' : fact.certainty, visibility: extracted.visibility === 'secret' ? 'secret' : fact.visibility, citation: citation(fact.paragraph, fact.quote) });
      }
    }
    for (const entity of state.entities.filter(entity => !entity.mergedInto)) { reconcileCurrentAttributes(entity, state.chapters); entity.description = rebuildCharacterProfileDescription(entity); }
    const secretIds = new Set(result.entities.filter(entity => entity.visibility === 'secret').flatMap(entity => resolve(entity.name, entity.kind).map(match => match.id)));
    for (const [index, extracted] of result.relations.entries()) {
      const from = resolve(extracted.from); const to = resolve(extracted.to);
      for (const [field, matches] of [['from', from], ['to', to]] as const) if (matches.length !== 1) issues.push({ path: `relations[${index}].${field}`, message: '关系端点必须匹配唯一的已有或本次提取实体，请核对名称与别名', paragraph: extracted.paragraph, quote: extracted.quote, sourceText: lines[extracted.paragraph - 1] });
      if (from.length !== 1 || to.length !== 1) continue;
      if (!state.relations.some(r => r.fromId === from[0].id && r.toId === to[0].id && r.label === extracted.label && r.citation?.chapterId === chapterId)) state.relations.push({ id: allocate(`relation:${from[0].id}:${to[0].id}:${JSON.stringify(extracted)}`), fromId: from[0].id, toId: to[0].id, label: extracted.label, visibility: secretIds.has(from[0].id) || secretIds.has(to[0].id) ? 'secret' : extracted.visibility, citation: citation(extracted.paragraph, extracted.quote) });
    }
    for (const [index, item] of result.foreshadows.entries()) {
      const old = state.foreshadows.find(f => normalize(f.title) === normalize(item.title));
      const relatedEntityIds = item.relatedNames.flatMap((n, nameIndex) => { const matches = resolve(n); if (matches.length !== 1) { issues.push({ path: `foreshadows[${index}].relatedNames[${nameIndex}]`, message: '伏笔关联名称必须匹配唯一实体，请核对名称与别名' }); return []; } return matches[0].id; });
      // Repeated mentions cannot reopen a completed clue. Earlier versions retain their own planted state.
      if (old && (old.status === 'resolved' || old.status === 'abandoned')) continue;
      const updated: Foreshadow = { id: old?.id ?? allocate(`clue:${normalize(item.title)}`), title: old?.title ?? item.title, detail: item.detail || old?.detail || '', status: item.status, dueChapter: item.dueChapter ?? old?.dueChapter, revealCondition: item.revealCondition || old?.revealCondition || '', relatedEntityIds: relatedEntityIds.length ? relatedEntityIds : old?.relatedEntityIds ?? [], plantedChapterId: old?.plantedChapterId ?? (item.status === 'planted' ? chapterId : undefined), resolvedChapterId: item.status === 'resolved' ? chapterId : old?.resolvedChapterId };
      if (old) Object.assign(old, updated); else state.foreshadows.push(updated);
    }
    if (issues.length) throw new OutputValidationError(issues, '资料关联校验失败，请在作者输出记录中查看全部问题并修正');
    ref.summary = [ref.summary, result.summary].filter(Boolean).join('\n'); ref.status = complete ? 'ready' : 'pending';
    if (complete) state.outline.fine = state.outline.fine.filter(plan => plan.chapter > state.chapters.length);
  }
  exportProject(projectId: string) {
    const project = this.getProject(projectId); const branches = this.listBranches(projectId, true);
    // Assets and interrupted jobs may refer to a revision detached by rollback.
    const chapterIds = new Set<string>();
    // Preserve global creation order across branches, including millisecond ties.
    const revisions: { revision: Revision; snapshot: string }[] = [];
    for (const row of this.db.prepare('SELECT r.data,r.state FROM revisions r JOIN branches b ON b.id=r.branch_id WHERE b.project_id=? ORDER BY r.rowid').iterate(projectId)) {
      for (const chapter of unpack(row.state).chapters) chapterIds.add(chapter.id);
      revisions.push({ revision: parse<Revision>(row.data), snapshot: Buffer.from(row.state as Uint8Array).toString('base64') });
    }
    const chapters = [...chapterIds].map(chapterId => { const row = this.db.prepare('SELECT data,text FROM chapter_texts WHERE id=?').get(chapterId)!; return { ...parse<ChapterRef>(row.data), text: String(row.text) }; });
    const jobs = this.db.prepare('SELECT data FROM jobs WHERE project_id=?').all(projectId).map(r => parse<Job>(r.data));
    const importChapters = this.db.prepare('SELECT c.job_id AS jobId,c.position,c.title,c.text FROM job_import_chapters c JOIN jobs j ON j.id=c.job_id WHERE j.project_id=? ORDER BY c.job_id,c.position').all(projectId);
    const writingDrafts = this.db.prepare('SELECT d.job_id AS jobId,d.text FROM job_writing_drafts d JOIN jobs j ON j.id=d.job_id WHERE j.project_id=?').all(projectId);
    const writingActivities = jobs.filter(job => job.kind === 'generate').map(job => ({ jobId: job.id, activities: this.listWritingActivities(job.id) })).filter(entry => entry.activities.length);
    return { version: 1, project, projectSettings: readProjectSettings(this.db, projectId).overrides, branches, revisions, chapters, jobs, importChapters, writingDrafts, writingActivities, outputs: this.outputs.all(projectId), images: this.images.export(projectId) };
  }
  restoreProject(input: unknown, sourceIdMap: Record<string, string> = {}, onRestore?: (project: Project) => void): Project {
    if (input && typeof input === 'object' && Array.isArray((input as { revisions?: unknown }).revisions) && (input as { revisions: unknown[] }).revisions.length > RESTORE_MAX_REVISIONS) throw restoreCapacityError();
    validateBackupStructure(input);
    const parsed = backupSchema.safeParse(input); if (!parsed.success) throw new HttpError('作品备份格式不正确或缺少正文与世界资料字段');
    const data = parsed.data;
    let projectSettings;
    try { projectSettings = parseProjectSettingsOverrides(data.projectSettings === undefined ? {} : data.projectSettings); }
    catch { throw new HttpError('备份中的作品设置无效'); }
    const states = readBackupStates(data.revisions);
    const map = new Map<string, string>(); const register = (value: string) => { if (value && !map.has(value)) map.set(value, id()); };
    register(data.project.id); for (const b of data.branches) register(b.id); for (const c of data.chapters) register(c.id); for (const job of data.jobs) register(job.id); for (const output of data.outputs) register(output.id); for (const asset of data.images) register(asset.image.id);
    for (let index = 0; index < data.revisions.length; index++) { register(data.revisions[index].revision.id); const state = states[index]; for (const e of state.entities) { register(e.id); for (const f of e.facts) register(f.id); } for (const relation of state.relations) register(relation.id); for (const f of state.foreshadows) register(f.id); }
    const remap = (value: unknown, key = ''): unknown => {
      // Process payloads are historical observations, like raw model responses. Only their owning job is remapped.
      if (key === 'rpgContinuation' || key === 'projectSettings') return clone(value);
      if (key === 'imagePlacements' && value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([imageId, placement]) => [map.get(imageId) ?? imageId, remap(placement)]));
      if (key === 'sourceIds' && Array.isArray(value)) return value.map(sourceId => {
        if (typeof sourceId !== 'string' || !Object.hasOwn(sourceIdMap, sourceId) || typeof sourceIdMap[sourceId] !== 'string' || !sourceIdMap[sourceId]) throw new HttpError('备份原作参考缺少原文件映射，请使用包含原文件的完整作品备份');
        return sourceIdMap[sourceId];
      });
      if (key === 'writingActivities' && Array.isArray(value)) return value.map(entry => ({ jobId: map.get(entry.jobId) ?? entry.jobId, activities: clone(entry.activities) }));
      if (typeof value === 'string') { if (key === 'sourceId') return Object.hasOwn(sourceIdMap, value) ? sourceIdMap[value] : undefined; if (key.endsWith('Id') || key === 'id' || key === 'mergedInto' || key === 'relatedEntityIds' || key === 'chapterIds' || key === 'previousChapterIds' || key === 'summaryChapterIds' || key === 'imageIds' || key === 'activeImageIds' || key === 'imageStartingEntityIds' || key === 'imagesRequestedFor' || key === 'dependencyImageIds' || key === 'selectedReferenceImageIds' || key === 'referenceImageIds' || key === 'referenceEntityIds' || key === 'materialEntityIds' || key === 'materialFactIds' || key === 'materialRelationIds') return map.get(value) ?? value; return value; }
      if (Array.isArray(value)) return value.map(v => remap(v, key)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, k)])); return value;
    };
    const restored = remap({ ...data, revisions: data.revisions.map(entry => ({ revision: entry.revision })) }) as typeof data;
    for (let index = 0; index < states.length; index++) states[index] = remap(states[index]) as StoryState;
    const restoredState = (index: number) => states[index];
    const branchIds = new Set(restored.branches.map(b => b.id)); const revisionIds = new Set(restored.revisions.map(r => r.revision.id)); const chapterIds = new Set(restored.chapters.map(c => c.id));
    if (branchIds.size !== restored.branches.length || revisionIds.size !== restored.revisions.length || chapterIds.size !== restored.chapters.length || !branchIds.has(restored.project.mainBranchId) || restored.branches.find(branch => branch.id === restored.project.mainBranchId)?.deletedAt || restored.branches.some(b => b.projectId !== restored.project.id || !revisionIds.has(b.revisionId) || (b.parentBranchId && !branchIds.has(b.parentBranchId))) || restored.revisions.some(r => !branchIds.has(r.revision.branchId) || (r.revision.parentId && !revisionIds.has(r.revision.parentId)))) throw new HttpError('备份存在无效关联');
    const referenceRevisionOwners = new Map(restored.revisions.map(entry => [entry.revision.id, entry.revision.branchId]));
    const checkReference = (reference: unknown) => {
      const parsed = sourceReferenceSchema.safeParse(reference);
      if (!parsed.success || !branchIds.has(parsed.data.branchId) || referenceRevisionOwners.get(parsed.data.revisionId) !== parsed.data.branchId) throw new HttpError('备份原作参考版本关联无效');
    };
    for (const state of states) if (state.sourceReference) checkReference(state.sourceReference);
    for (const job of restored.jobs) if (job.payload.sourceReference !== undefined) checkReference(job.payload.sourceReference);
    const chapterLookup = new Map(restored.chapters.map(c => [c.id, paragraphs(c.text)]));
    const imageIds = new Set(restored.images.map(asset => asset.image.id));
    const imagesById = new Map(restored.images.map(asset => [asset.image.id, asset.image]));
    if (imageIds.size !== restored.images.length) throw new HttpError('备份图片标识重复');
    for (const asset of restored.images) {
      const image = asset.image;
      const references = imageReferences(image);
      if (image.projectId !== restored.project.id || !branchIds.has(image.branchId) || !revisionIds.has(image.baseRevisionId) || (image.chapterId && !chapterIds.has(image.chapterId)) || references.some(referenceId => !imageIds.has(referenceId) || referenceId === image.id) || new Set(image.selectedReferenceImageIds ?? []).size !== (image.selectedReferenceImageIds ?? []).length || new Set(image.referenceImageIds ?? []).size !== (image.referenceImageIds ?? []).length || new Set(image.referenceEntityIds ?? []).size !== (image.referenceEntityIds ?? []).length || new Set(image.materialEntityIds ?? []).size !== (image.materialEntityIds ?? []).length) throw new HttpError('备份图片关联无效');
      const imageRevision = restored.revisions.find(entry => entry.revision.id === image.baseRevisionId)!;
      const baseState = restoredState(restored.revisions.indexOf(imageRevision));
      const draft = image.bindingStatus === 'pending' || image.bindingStatus === 'discarded';
      const owner = image.writingJobId ? restored.jobs.find(job => job.id === image.writingJobId) : undefined;
      if (draft && (!owner || owner.kind !== 'generate' || owner.branchId !== image.branchId || owner.projectId !== image.projectId || !image.automatic || image.visibility !== 'secret' || image.publicMaterial !== false || !['portrait', 'cg'].includes(image.kind) || image.chapterId || image.entityId)) throw new HttpError('备份写作中图片的任务关联无效');
      if (imageRevision.revision.branchId !== image.branchId || !draft && !baseState.imageIds?.includes(image.id) || image.entityId && !baseState.entities.some(entity => entity.id === image.entityId) || image.chapterId && !baseState.chapters.some(chapter => chapter.id === image.chapterId)) throw new HttpError('备份图片起始版本无效');
      const validReference = (id: string) => {
        const reference = imagesById.get(id);
        return reference && id !== image.id && (baseState.imageIds?.includes(id) || Boolean(image.writingJobId) && reference.kind === 'portrait' && reference.writingJobId === image.writingJobId && reference.branchId === image.branchId && reference.projectId === image.projectId && reference.bindingStatus !== 'discarded');
      };
      if (image.dependencyImageIds?.some(id => !validReference(id) || imagesById.get(id)?.kind !== 'portrait') || new Set(image.dependencyImageIds ?? []).size !== (image.dependencyImageIds ?? []).length) throw new HttpError('备份图片等待的参考图关联无效');
      if (references.some(referenceId => !validReference(referenceId) || imagesById.get(referenceId)?.status !== 'completed') || [...(image.materialEntityIds ?? []), ...(image.referenceEntityIds ?? []), ...(image.referenceCharacters ?? []).map(character => character.entityId)].some(entityId => !baseState.entities.some(entity => entity.id === entityId))) throw new HttpError('备份图片参考素材不属于起始版本');
      if (image.materialFactIds?.some(id => !baseState.entities.some(entity => entity.facts.some(fact => fact.id === id))) || image.materialRelationIds?.some(id => !baseState.relations.some(relation => relation.id === id))) throw new HttpError('备份图片公开依据不属于起始版本');
      if ((image.referenceCharacters ?? []).some(character => { const portrait = imagesById.get(character.imageId); return portrait?.kind !== 'portrait' || !portrait.entityId || imageEntity(baseState, portrait.entityId)?.id !== imageEntity(baseState, character.entityId)?.id; })) throw new HttpError('备份人物参考图与身份不匹配');
      if (image.kind === 'cg' && !draft) {
        const chapter = restored.chapters.find(chapter => chapter.id === image.chapterId);
        const source = image.selection && chapter ? chapter.text.slice(image.selection.start, image.selection.end) : chapter?.text;
        const chapterOnly = Boolean(image.sceneDescription?.trim()) && image.placementStatus !== 'matched' && !image.selection && !image.sourceText;
        if (!chapter || !source?.trim() || !chapterOnly && source !== image.sourceText || image.selection && (image.selection.start >= image.selection.end || image.selection.end > chapter.text.length)) throw new HttpError('备份 CG 剧情引用无效');
      }
      if (image.status === 'completed' && (!asset.contentBase64 || !image.mimeType)) throw new HttpError('备份缺少已完成的图片');
      if (asset.contentBase64) {
        const bytes = Buffer.from(asset.contentBase64, 'base64');
        if (!image.mimeType || bytes.toString('base64') !== asset.contentBase64) throw new HttpError('备份图片内容无效');
        validateImageContent({ bytes, mimeType: image.mimeType });
      }
      if (['queued', 'running'].includes(image.status)) { image.status = 'paused'; image.error = '作品已恢复，请手动重试生图'; }
    }
    const validatedImageReferences = new Set<string>();
    for (const imageId of imageIds) {
      const pending = [{ id: imageId, finished: false }]; const visiting = new Set<string>();
      while (pending.length) {
        const next = pending.pop()!;
        if (next.finished) { visiting.delete(next.id); validatedImageReferences.add(next.id); continue; }
        if (validatedImageReferences.has(next.id)) continue;
        if (visiting.has(next.id)) throw new HttpError('备份图片存在循环参考');
        visiting.add(next.id); pending.push({ id: next.id, finished: true });
        const image = imagesById.get(next.id)!;
        for (const referenceId of [...imageReferences(image), ...(image.dependencyImageIds ?? [])]) pending.push({ id: referenceId, finished: false });
      }
    }
    for (let index = 0; index < restored.revisions.length; index++) {
      const state = restoredState(index);
      if (state.chapters.some(c => !chapterIds.has(c.id)) || restored.revisions[index].revision.chapterCount !== state.chapters.length) throw new HttpError('备份章节版本关联无效');
      if (state.chapters.some(chapter => chapter.previousChapterIds?.some(id => !chapterIds.has(id) || id === chapter.id) || new Set(chapter.previousChapterIds).size !== (chapter.previousChapterIds?.length ?? 0))) throw new HttpError('备份章节修订关联无效');
      const included = new Set(state.chapters.map(c => c.id)); const entities = new Set(state.entities.map(e => e.id));
      if ((state.imageIds ?? []).some(imageId => !imageIds.has(imageId)) || new Set(state.imageIds ?? []).size !== (state.imageIds ?? []).length) throw new HttpError('备份版本图片引用无效');
      if ((state.activeImageIds ?? []).some(imageId => !state.imageIds?.includes(imageId)) || new Set(state.activeImageIds ?? []).size !== (state.activeImageIds ?? []).length) throw new HttpError('备份版本启用图片引用无效');
      for (const [imageId, placement] of Object.entries(state.imagePlacements ?? {})) {
        const image = imagesById.get(imageId); const chapter = restored.chapters.find(chapter => chapter.id === placement.chapterId);
        const target = state.chapters.find(chapter => includesChapterVersion(chapter, placement.chapterId));
        const selection = placement.selection;
        if (!state.imageIds?.includes(imageId) || image?.kind !== 'cg' || !chapter || !target || !includesChapterVersion(target, image.chapterId) || selection && (selection.start >= selection.end || selection.end > chapter.text.length || chapter.text.slice(selection.start, selection.end) !== placement.sourceText || !placement.sourceText?.trim()) || !selection && placement.sourceText !== undefined) throw new HttpError('备份手动插画位置关联无效');
      }
      for (const imageId of state.imageIds ?? []) { const image = restored.images.find(asset => asset.image.id === imageId)!.image; if (image.bindingStatus === 'pending' || image.bindingStatus === 'discarded' || (image.entityId && !entities.has(image.entityId)) || (image.chapterId && !state.chapters.some(chapter => includesChapterVersion(chapter, image.chapterId)))) throw new HttpError('备份图片不属于当前资料或章节'); }
      const compression = state.outline.summaryCompression;
      if (compression && (!compression.text.trim() || !compression.chapterIds.length || new Set(compression.chapterIds).size !== compression.chapterIds.length || compression.chapterIds.some(chapterId => !included.has(chapterId)))) throw new HttpError('备份压缩摘要存在无效章节关联');
      const validCitation = (c: { chapterId: string; paragraph: number; quote: string } | undefined) => !c || (included.has(c.chapterId) && chapterLookup.get(c.chapterId)?.[c.paragraph - 1]?.includes(c.quote));
      if (included.size !== state.chapters.length || entities.size !== state.entities.length || state.entities.some(e => (e.mergedInto && (!entities.has(e.mergedInto) || e.mergedInto === e.id)) || e.facts.some(f => !validCitation(f.citation))) || state.relations.some(r => !entities.has(r.fromId) || !entities.has(r.toId) || !validCitation(r.citation)) || state.foreshadows.some(f => f.relatedEntityIds.some(e => !entities.has(e)) || (f.plantedChapterId && !included.has(f.plantedChapterId)) || (f.resolvedChapterId && !included.has(f.resolvedChapterId)))) throw new HttpError('备份存在无效资料关联或原文引用');
    }
    const parents = new Map(restored.revisions.map(r => [r.revision.id, r.revision.parentId]));
    const validatedParents = new Set<string>();
    for (const revision of restored.revisions) { const visited = new Set<string>(); let current: string | undefined = revision.revision.id; while (current && !validatedParents.has(current)) { if (visited.has(current)) throw new HttpError('备份版本存在循环引用'); visited.add(current); current = parents.get(current); } for (const revisionId of visited) validatedParents.add(revisionId); }
    for (const { revision } of restored.revisions) if (revision.restoredFromRevisionId) {
      let ancestor = revision.parentId;
      while (ancestor && ancestor !== revision.restoredFromRevisionId) ancestor = parents.get(ancestor);
      if (!ancestor) throw new HttpError('备份回退来源必须是同一路径的历史版本');
    }
    const jobs = new Map(restored.jobs.map(j => [j.id, j])); const importPositions = new Set<string>();
    if (jobs.size !== restored.jobs.length || restored.jobs.some(j => j.projectId !== restored.project.id || !branchIds.has(j.branchId) || !revisionIds.has(j.baseRevisionId) || j.progress > j.total)) throw new HttpError('备份存在无效任务关联');
    for (const state of states) if (state.rpg?.nextChoice) {
      const choice = state.rpg.nextChoice; const owner = jobs.get(choice.jobId);
      if (!owner || owner.kind !== 'generate' || owner.payload.mode !== 'rpg' || owner.payload.generatedChapterId !== choice.chapterId || state.chapters.at(-1)?.id !== choice.chapterId) throw new HttpError('备份章末选择关联无效');
    }
    for (const part of restored.importChapters) { const key = `${part.jobId}:${part.position}`; if (jobs.get(part.jobId)?.kind !== 'import' || importPositions.has(key) || part.position >= jobs.get(part.jobId)!.total) throw new HttpError('备份导入章节关联无效'); importPositions.add(key); }
    for (const job of restored.jobs) {
      if (job.payload.rpgContinuation) {
        const previous = (job.payload.rpgLookupAliases ?? {}) as Record<string, string>;
        job.payload.rpgLookupAliases = { ...Object.fromEntries(Object.entries(previous).map(([oldId, target]) => [oldId, map.get(target) ?? (Object.hasOwn(sourceIdMap, target) ? sourceIdMap[target] : target)])), ...Object.fromEntries(map), ...sourceIdMap };
      }
      for (const field of ['blockIndex', 'importIndex']) if (job.payload[field] !== undefined && (!Number.isInteger(job.payload[field]) || Number(job.payload[field]) < 0)) throw new HttpError('备份任务进度无效');
      for (const field of ['generatedChapterId', 'extractChapterId', 'importCurrentChapterId', 'chapterId', 'targetChapterId', 'pendingTitleChapterId', 'placementChapterId', 'pendingCGChapterId']) if (job.payload[field] && !chapterIds.has(String(job.payload[field]))) throw new HttpError('备份任务章节不存在');
      if (job.payload.pendingCGChapterId !== undefined && (job.kind !== 'generate' || typeof job.payload.pendingCGChapterId !== 'string' || job.payload.generatedChapterId !== job.payload.pendingCGChapterId)) throw new HttpError('备份待关联 CG 章节无效');
      if (job.kind === 'image-placement') {
        const writing = jobs.get(String(job.payload.writingJobId));
        const snapshot = restoredState(restored.revisions.findIndex(entry => entry.revision.id === job.baseRevisionId));
        const ids = job.payload.imageIds;
        if (typeof job.payload.placementChapterId !== 'string' || !snapshot.chapters.some(chapter => chapter.id === job.payload.placementChapterId) || writing?.kind !== 'generate' || writing.branchId !== job.branchId || writing.projectId !== job.projectId || writing.payload.generatedChapterId !== job.payload.placementChapterId || !Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length || ids.some(id => {
          const image = typeof id === 'string' ? imagesById.get(id) : undefined;
          return !image || image.kind !== 'cg' || image.projectId !== job.projectId || image.branchId !== job.branchId || image.writingJobId !== writing.id || image.chapterId !== job.payload.placementChapterId;
        })) throw new HttpError('备份 CG 定位任务关联无效');
      }
      if (job.payload.pendingTitleChapterId !== undefined) {
        const writing = jobs.get(String(job.payload.writingJobId));
        const snapshot = restoredState(restored.revisions.findIndex(entry => entry.revision.id === job.baseRevisionId));
        if (job.kind !== 'extract' || writing?.kind !== 'generate' || writing.branchId !== job.branchId || !writing.payload.autoTitle || writing.payload.titleGenerated || writing.payload.generatedChapterId !== job.payload.pendingTitleChapterId || !snapshot.chapters.some(chapter => chapter.id === job.payload.pendingTitleChapterId)) throw new HttpError('备份章节命名关联无效');
      }
      if (job.payload.targetChapterId !== undefined) {
        const snapshot = restoredState(restored.revisions.findIndex(entry => entry.revision.id === job.baseRevisionId));
        if (job.kind !== 'extract' || job.total !== 1 || typeof job.payload.targetChapterId !== 'string' || job.payload.extractChapterId !== job.payload.targetChapterId || !snapshot.chapters.some(chapter => chapter.id === job.payload.targetChapterId)) throw new HttpError('备份单章提取目标无效');
      }
      if (job.kind === 'import' && restored.importChapters.filter(c => c.jobId === job.id).length !== job.total) throw new HttpError('备份缺少尚待整理的导入章节');
      if (job.kind === 'plan' && job.payload.purpose !== 'compress-summary' && ['queued','running','paused','failed'].includes(job.status)) { job.status = 'cancelled'; job.error = undefined; job.message = '剧情规划功能已移除，历史记录保留'; }
      if (job.status === 'running' || job.status === 'queued') { job.status = 'paused'; job.message = '作品已恢复，请手动继续任务'; }
    }
    const outputIds = new Set(restored.outputs.map(o => o.id));
    if (outputIds.size !== restored.outputs.length || restored.outputs.some(o => o.projectId !== restored.project.id || !jobs.has(o.jobId) || !branchIds.has(o.branchId) || !revisionIds.has(o.baseRevisionId) || (o.chapterId && !chapterIds.has(o.chapterId)))) throw new HttpError('备份模型输出关联无效');
    for (const job of restored.jobs) if (job.payload.lastOutputId && !outputIds.has(String(job.payload.lastOutputId))) throw new HttpError('备份缺少任务关联的模型输出');
    restored.project.title += '（恢复）'; restored.project.updatedAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO projects VALUES(?,?)').run(restored.project.id, JSON.stringify(restored.project));
      saveProjectSettings(this.db, restored.project.id, '0', projectSettings);
      for (const branch of restored.branches) this.db.prepare('INSERT INTO branches VALUES(?,?,?)').run(branch.id, restored.project.id, JSON.stringify(branch));
      for (let index = 0; index < restored.revisions.length; index++) { const revision = restored.revisions[index].revision; this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(revision.id, revision.branchId, revision.parentId ?? null, JSON.stringify(revision), pack(restoredState(index))); }
      for (const chapter of restored.chapters) { const { text, ...ref } = chapter; this.db.prepare('INSERT INTO chapter_texts VALUES(?,?,?)').run(ref.id, JSON.stringify(ref), text); this.db.prepare('INSERT INTO chapter_search(id,title,text) VALUES(?,?,?)').run(ref.id, ref.title, text); }
      for (const job of restored.jobs) this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, job.branchId, job.projectId, job.status, JSON.stringify(job));
      for (const chapter of restored.importChapters) this.db.prepare('INSERT INTO job_import_chapters VALUES(?,?,?,?)').run(chapter.jobId, chapter.position, chapter.title, chapter.text);
      for (const draft of restored.writingDrafts) { if (jobs.get(draft.jobId)?.kind !== 'generate') throw new HttpError('备份流式草稿关联无效'); this.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?)').run(draft.jobId, draft.text); }
      const activityJobs = new Set<string>();
      for (const entry of restored.writingActivities) {
        if (jobs.get(entry.jobId)?.kind !== 'generate' || activityJobs.has(entry.jobId) || new Set(entry.activities.map(activity => activity.id)).size !== entry.activities.length) throw new HttpError('备份作者工作过程关联无效');
        activityJobs.add(entry.jobId);
        const owner = jobs.get(entry.jobId)!;
        for (const activity of entry.activities) {
          const recovered: WritingActivity = activity.status === 'running' && ['completed', 'paused', 'failed', 'cancelled', 'stale'].includes(owner.status) && !(owner.status === 'paused' && owner.payload.rpgChoice && !owner.payload.rpgChoiceAnswer && !owner.payload.generatedChapterId && !owner.payload.rpgNextChoice && activity.name === 'ask_user')
            ? { ...activity, status: owner.status === 'completed' ? 'completed' : 'failed', ...(owner.status === 'completed' ? {} : { error: owner.message || '任务已暂停，过程已停止' }) } : activity;
          this.db.prepare('INSERT INTO job_writing_activities VALUES(?,?,?)').run(entry.jobId, activity.id, JSON.stringify(recovered));
        }
      }
      for (const output of restored.outputs) this.outputs.insert(output);
      for (const asset of restored.images) this.images.insert(asset.image, asset.contentBase64 ? { bytes: Buffer.from(asset.contentBase64, 'base64'), mimeType: asset.image.mimeType! } : undefined);
      onRestore?.(restored.project);
      const references = [...states.flatMap(state => state.sourceReference ? [state.sourceReference] : []), ...restored.jobs.flatMap(job => job.payload.sourceReference ? [job.payload.sourceReference as StoryReference] : [])];
      const confirmedSources = new Set<string>();
      for (const reference of references) for (const sourceId of reference.sourceIds ?? []) if (!confirmedSources.has(sourceId)) {
        if (!this.hasSources() || !this.db.prepare('SELECT 1 FROM sources WHERE id=? AND project_id=? AND confirmed=1').get(sourceId, restored.project.id)) throw new HttpError('备份原作参考文件不存在、不属于恢复作品或尚未确认');
        confirmedSources.add(sourceId);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return restored.project;
  }
}
