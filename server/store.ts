import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { modelOutputSchema, OutputStore } from './output-store.js';
import { emptyState, type Branch, type BranchView, type Chapter, type ChapterRef, type Entity, type ExtractionResult, type Foreshadow, type Job, type Mode, type Outline, type OutputIssue, type Project, type Revision, type StoryState } from '../shared/types.js';

export class HttpError extends Error { constructor(message: string, public statusCode = 400) { super(message); } }
export class OutputValidationError extends HttpError { constructor(public issues: OutputIssue[], message = '模型输出未通过校验，请在作者输出记录中查看具体位置并修正') { super(message, 422); } }
const now = () => new Date().toISOString();
const id = () => randomUUID();
const clone = <T>(value: T): T => structuredClone(value);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const pack = (state: StoryState) => gzipSync(JSON.stringify(state));
const unpack = (value: unknown): StoryState => JSON.parse(gunzipSync(value as Uint8Array).toString());
export const paragraphs = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
const citationSchema = z.object({ chapterId: z.string(), paragraph: z.number().int().positive(), quote: z.string().min(1) });
const factSchema = z.object({ id: z.string().min(1), text: z.string(), attribute: z.string().optional(), temporal: z.enum(['current', 'past', 'future', 'unknown']), certainty: z.enum(['fact', 'inference', 'conflict']), visibility: z.enum(['public', 'secret']), citation: citationSchema.optional(), locked: z.boolean().optional() });
const entitySchema = z.object({ id: z.string().min(1), kind: z.enum(['character', 'faction', 'location', 'item', 'ability', 'rule', 'event']), name: z.string(), aliases: z.array(z.string()), description: z.string(), visibility: z.enum(['public', 'secret']), locked: z.boolean(), facts: z.array(factSchema), mergedInto: z.string().optional() });
const refSchema = z.object({ id: z.string().min(1), title: z.string(), sourceId: z.string().optional(), summary: z.string(), status: z.enum(['pending', 'ready', 'failed']), createdAt: z.string() });
const stateSchema = z.object({ chapters: z.array(refSchema), entities: z.array(entitySchema), relations: z.array(z.object({ id: z.string(), fromId: z.string(), toId: z.string(), label: z.string(), visibility: z.enum(['public', 'secret']), citation: citationSchema.optional() })), foreshadows: z.array(z.object({ id: z.string(), title: z.string(), detail: z.string(), status: z.enum(['planned', 'planted', 'resolved', 'abandoned']), plantedChapterId: z.string().optional(), resolvedChapterId: z.string().optional(), dueChapter: z.number().int().positive().optional(), revealCondition: z.string(), relatedEntityIds: z.array(z.string()) })), outline: z.object({ coarse: z.string(), locked: z.string(), fine: z.array(z.object({ chapter: z.number().int().positive(), title: z.string(), goal: z.string() })) }) });
const jobSchema = z.object({ id: z.string().min(1), projectId: z.string(), branchId: z.string(), kind: z.enum(['import', 'extract', 'generate', 'plan']), status: z.enum(['queued', 'running', 'paused', 'failed', 'completed', 'cancelled', 'stale']), baseRevisionId: z.string(), progress: z.number().int().nonnegative(), total: z.number().int().nonnegative(), message: z.string(), error: z.string().optional(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), createdAt: z.string(), updatedAt: z.string(), payload: z.record(z.string(), z.unknown()) });
const backupSchema = z.object({ version: z.literal(1), project: z.object({ id: z.string().min(1), title: z.string(), premise: z.string(), mode: z.enum(['original', 'continuation', 'fanfiction', 'rewrite']), createdAt: z.string(), updatedAt: z.string(), mainBranchId: z.string().min(1) }), branches: z.array(z.object({ id: z.string(), projectId: z.string(), name: z.string(), revisionId: z.string(), parentBranchId: z.string().optional(), forkChapterId: z.string().optional(), createdAt: z.string() })).min(1), revisions: z.array(z.object({ revision: z.object({ id: z.string(), branchId: z.string(), parentId: z.string().optional(), label: z.string(), createdAt: z.string(), chapterCount: z.number().int().nonnegative() }), state: stateSchema.optional(), snapshot: z.string().optional() }).refine(r => Boolean(r.state) !== Boolean(r.snapshot))).min(1), chapters: z.array(refSchema.extend({ text: z.string() })), jobs: z.array(jobSchema).default([]), importChapters: z.array(z.object({ jobId: z.string(), position: z.number().int().nonnegative(), title: z.string(), text: z.string() })).default([]), outputs: z.array(modelOutputSchema).default([]) });

export class Store {
  readonly db: DatabaseSync;
  readonly outputs: OutputStore;
  constructor(public readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'novel.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, parent_id TEXT, data TEXT NOT NULL, state BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS revision_branch ON revisions(branch_id);
      CREATE TABLE IF NOT EXISTS chapter_texts (id TEXT PRIMARY KEY, data TEXT NOT NULL, text TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chapter_search USING fts5(id UNINDEXED, title, text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_import_chapters (job_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(job_id,position));
      CREATE INDEX IF NOT EXISTS jobs_branch ON jobs(branch_id,status);`);
    this.outputs = new OutputStore(this.db);
  }
  close() { this.db.close(); }
  listProjects(): Project[] { return this.db.prepare('SELECT data FROM projects ORDER BY rowid DESC').all().map(r => parse<Project>(r.data)); }
  getProject(projectId: string): Project { const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(projectId); if (!row) throw new HttpError('作品不存在', 404); return parse(row.data); }
  listBranches(projectId: string): Branch[] { this.getProject(projectId); return this.db.prepare('SELECT data FROM branches WHERE project_id=? ORDER BY rowid').all(projectId).map(r => parse<Branch>(r.data)); }
  getBranch(branchId: string): Branch { const row = this.db.prepare('SELECT data FROM branches WHERE id=?').get(branchId); if (!row) throw new HttpError('故事线不存在', 404); return parse(row.data); }
  revision(revisionId: string): Revision { const row = this.db.prepare('SELECT data FROM revisions WHERE id=?').get(revisionId); if (!row) throw new HttpError('版本不存在', 404); return parse(row.data); }
  revisionState(revisionId: string): StoryState { const row = this.db.prepare('SELECT state FROM revisions WHERE id=?').get(revisionId); if (!row) throw new HttpError('版本不存在', 404); return unpack(row.state); }
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
    const state = emptyState(); state.outline.locked = project.premise;
    this.db.exec('BEGIN IMMEDIATE');
    try { branch.revisionId = this.insertRevision(branch, state, '创建作品').id; this.db.prepare('INSERT INTO projects VALUES(?,?)').run(project.id, JSON.stringify(project)); this.db.prepare('INSERT INTO branches VALUES(?,?,?)').run(branch.id, project.id, JSON.stringify(branch)); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return project;
  }
  history(branchId: string): Revision[] {
    const output: Revision[] = []; let current: string | undefined = this.getBranch(branchId).revisionId; const visited = new Set<string>();
    while (current && !visited.has(current)) { visited.add(current); const revision = this.revision(current); output.push(revision); current = revision.parentId; }
    return output;
  }
  view(branchId: string, author = false): BranchView {
    const branch = this.getBranch(branchId); const state = this.state(branchId);
    if (!author) {
      state.outline = emptyState().outline; state.foreshadows = []; state.chapters = state.chapters.map(c => ({ ...c, summary: '' }));
      state.entities = state.entities.filter(e => e.visibility === 'public' && !e.mergedInto && (e.locked || e.facts.some(f => f.visibility === 'public' && f.temporal !== 'future'))).map(e => { const facts = e.facts.filter(f => f.visibility === 'public' && f.temporal !== 'future'); return { ...e, description: e.facts.length ? facts.map(f => f.text).join('；') : e.locked ? e.description : '', facts }; });
      const visible = new Set(state.entities.map(e => e.id)); state.relations = state.relations.filter(r => r.visibility === 'public' && visible.has(r.fromId) && visible.has(r.toId));
    }
    return { branch, state, revisions: author ? this.history(branchId) : [] };
  }
  commit(branchId: string, baseRevisionId: string, state: StoryState, label: string, checkpoint?: (revisionId: string, branchId: string) => void): BranchView {
    this.db.exec('BEGIN IMMEDIATE');
    try { const branch = this.assertVersion(branchId, baseRevisionId); const revision = this.insertRevision(branch, state, label, branch.revisionId); branch.revisionId = revision.id;
      this.db.prepare('UPDATE branches SET data=? WHERE id=?').run(JSON.stringify(branch), branch.id);
      const project = this.getProject(branch.projectId); project.updatedAt = now(); this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project), project.id); checkpoint?.(revision.id, branch.id); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.view(branchId, true);
  }
  putChapter(title: string, text: string, sourceId?: string): ChapterRef {
    const chapter: Chapter = { id: id(), title: title.trim() || '未命名章节', text, sourceId, summary: '', status: 'pending', createdAt: now() };
    const { text: body, ...ref } = chapter;
    this.db.prepare('INSERT INTO chapter_texts VALUES(?,?,?)').run(chapter.id, JSON.stringify(ref), body);
    this.db.prepare('INSERT INTO chapter_search(id,title,text) VALUES(?,?,?)').run(chapter.id, chapter.title, body);
    return ref;
  }
  chapter(branchId: string, chapterId: string): Chapter {
    const ref = this.state(branchId).chapters.find(c => c.id === chapterId); if (!ref) throw new HttpError('本故事线不包含这个章节', 404);
    const row = this.db.prepare('SELECT text FROM chapter_texts WHERE id=?').get(chapterId); if (!row) throw new HttpError('章节正文不存在', 404);
    return { ...ref, summary: '', text: String(row.text) };
  }
  /** Revisions are chapter-boundary snapshots; never reconstruct earlier canon from the latest world. */
  private atBoundary(branchId: string, count: number): StoryState {
    const current = this.state(branchId); const target = current.chapters[count - 1]?.id;
    for (const revision of this.history(branchId)) {
      if (revision.chapterCount !== count) continue;
      const state = this.revisionState(revision.id);
      if (!count || state.chapters[count - 1]?.id === target) return state;
    }
    throw new HttpError('未找到该章节的历史状态，不能安全创建分支', 409);
  }
  writingState(branchId: string, chapterId?: string): StoryState {
    if (!chapterId) return this.state(branchId);
    const index = this.state(branchId).chapters.findIndex(c => c.id === chapterId);
    if (index < 0) throw new HttpError('改写的章节不存在');
    return this.atBoundary(branchId, index);
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
    return this.createFork(original, state, input.name, input.chapterId);
  }
  private createFork(original: Branch, state: StoryState, name: string, forkChapterId?: string): BranchView {
    const branch: Branch = { id: id(), projectId: original.projectId, name: name.trim() || '新故事线', revisionId: '', parentBranchId: original.id, forkChapterId, createdAt: now() };
    // Link to the actual boundary revision so historical edits on a fork can find older snapshots.
    const boundary = this.history(original.id).find(r => r.chapterCount === state.chapters.length && (!state.chapters.length || this.revisionState(r.id).chapters.at(-1)?.id === state.chapters.at(-1)?.id));
    branch.revisionId = this.insertRevision(branch, state, `创建故事线：${branch.name}`, boundary?.id).id;
    this.db.prepare('INSERT INTO branches VALUES(?,?,?)').run(branch.id, branch.projectId, JSON.stringify(branch)); return this.view(branch.id, true);
  }
  saveChapter(branchId: string, input: { baseRevisionId: string; title: string; text: string; chapterId?: string }, checkpoint?: (revisionId: string, branchId: string) => void): BranchView {
    let branch = this.assertVersion(branchId, input.baseRevisionId); let state = this.state(branchId);
    if (!input.text.trim()) throw new HttpError('正文不能为空');
    if (input.chapterId) {
      const index = state.chapters.findIndex(c => c.id === input.chapterId); if (index < 0) throw new HttpError('要修改的章节不存在');
      const previous = this.atBoundary(branchId, index);
      if (index < state.chapters.length - 1) { const fork = this.createFork(branch, this.cleanBoundary(previous), `修订 · ${state.chapters[index].title}`, state.chapters[index - 1]?.id); branch = fork.branch; }
      else {
        // Keep deliberate human constraints when replacing the latest draft. AI discoveries are reverted.
        previous.outline.locked = state.outline.locked;
        const included = new Set(previous.chapters.map(c => c.id));
        for (const current of state.entities.filter(e => e.locked || e.facts.some(f => f.locked))) {
          const existing = previous.entities.find(e => e.id === current.id);
          const lockedFacts = current.facts.filter(f => f.locked).map(f => ({ ...f, citation: f.citation && included.has(f.citation.chapterId) ? f.citation : undefined }));
          if (current.locked) {
            const preserved = { ...clone(current), facts: [...(existing?.facts.filter(f => !lockedFacts.some(l => l.id === f.id)) ?? []), ...lockedFacts] };
            if (existing) Object.assign(existing, preserved); else previous.entities.push(preserved);
          } else if (existing) existing.facts = [...existing.facts.filter(f => !lockedFacts.some(l => l.id === f.id)), ...lockedFacts];
        }
      }
      state = previous;
    } else if (state.chapters.some(c => c.status !== 'ready')) throw new HttpError('上一章资料尚未整理完成，请先重试整理', 409);
    const chapter = this.putChapter(input.title, input.text); state.chapters.push(chapter);
    return this.commit(branch.id, branch.revisionId, state, input.chapterId ? '修订正文，等待资料整理' : '保存正文，等待资料整理', checkpoint);
  }
  rollback(branchId: string, input: { baseRevisionId: string; revisionId: string }): BranchView {
    this.assertVersion(branchId, input.baseRevisionId);
    if (!this.history(branchId).some(r => r.id === input.revisionId)) throw new HttpError('只能回退到本故事线的历史版本');
    return this.commit(branchId, input.baseRevisionId, this.revisionState(input.revisionId), '回退正文与世界资料');
  }
  updateOutline(branchId: string, base: string, outline: Outline): BranchView { this.assertVersion(branchId, base); const state = this.state(branchId); state.outline = clone(outline); return this.commit(branchId, base, state, '修改大纲与锁定设定'); }
  updateEntity(branchId: string, base: string, entity: Entity): BranchView {
    this.assertVersion(branchId, base); const state = this.state(branchId); const index = state.entities.findIndex(e => e.id === entity.id);
    const replacement = clone(entity); replacement.id = index >= 0 ? entity.id : id(); replacement.facts = replacement.facts.map(f => ({ ...f, id: f.id || id() }));
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
  search(branchId: string, query: string, author = false): { chapters: { id: string; title: string; snippet: string }[]; entities: Entity[] } {
    const q = query.trim().slice(0, 200); if (!q) return { chapters: [], entities: [] }; const state = this.view(branchId, author).state;
    const allowed = new Set(state.chapters.map(c => c.id));
    // Trigram accelerates Chinese search; short words use exact substring matching.
    const rows = q.length >= 3 ? this.db.prepare('SELECT id,text FROM chapter_search WHERE chapter_search MATCH ?').all(`"${q.replace(/"/g, '""')}"`) : this.db.prepare('SELECT id,text FROM chapter_search WHERE instr(text,?)>0 OR instr(title,?)>0').all(q, q);
    const chapters = rows.filter(r => allowed.has(String(r.id))).slice(0, 60).map(r => { const ref = state.chapters.find(c => c.id === r.id)!; const text = String(r.text); const at = Math.max(0, text.indexOf(q)); return { id: ref.id, title: ref.title, snippet: text.slice(Math.max(0, at - 40), at + q.length + 100) }; });
    const entities = state.entities.filter(e => !e.mergedInto && normalize([e.name, ...e.aliases, e.description, ...e.facts.map(f => f.text)].join(' ')).includes(normalize(q))).slice(0, 60);
    return { chapters, entities };
  }
  exportText(branchId: string): string { return this.state(branchId).chapters.map(c => `${c.title}\n\n${this.chapter(branchId, c.id).text}`).join('\n\n'); }
  applyExtraction(branchId: string, base: string, chapterId: string, result: ExtractionResult, complete: boolean, checkpoint?: (revisionId: string, branchId: string) => void): BranchView {
    this.assertVersion(branchId, base); const state = this.state(branchId); const ref = state.chapters.find(c => c.id === chapterId); if (!ref) throw new HttpError('整理章节不属于当前故事线');
    const lines = paragraphs(this.chapter(branchId, chapterId).text);
    const citation = (paragraph: number, quote: string) => ({ chapterId, paragraph, quote });
    const issues: OutputIssue[] = [];
    const validateCitation = (paragraph: number, quote: string, path: string) => { if (!Number.isInteger(paragraph) || paragraph < 1 || !quote.trim() || !lines[paragraph - 1]?.includes(quote)) issues.push({ path, message: '引用必须是该编号原文段落中的逐字片段（含原始标点）', paragraph, quote, sourceText: lines[paragraph - 1] ?? '' }); };
    // Validate every reference before changing even the in-memory state.
    result.entities.forEach((e, i) => e.facts.forEach((fact, j) => validateCitation(fact.paragraph, fact.quote, `entities[${i}].facts[${j}].quote`)));
    result.relations.forEach((relation, i) => validateCitation(relation.paragraph, relation.quote, `relations[${i}].quote`));
    if (issues.length) throw new OutputValidationError(issues, '原文引用校验失败，请在作者输出记录中查看具体位置并修正');
    const resolve = (name: string, kind?: Entity['kind']) => state.entities.filter(e => !e.mergedInto && (!kind || e.kind === kind) && [e.name, ...e.aliases].some(n => normalize(n) === normalize(name)));
    for (const extracted of result.entities) {
      let matches = resolve(extracted.name, extracted.kind);
      if (!matches.length) matches = state.entities.filter(e => !e.mergedInto && e.kind === extracted.kind && [e.name, ...e.aliases].some(n => extracted.aliases.some(a => normalize(n) === normalize(a))));
      let entity = matches.length === 1 ? matches[0] : undefined;
      const ambiguous = matches.length > 1;
      if (!entity) { entity = { id: id(), kind: extracted.kind, name: extracted.name, aliases: extracted.aliases, description: '', visibility: extracted.visibility, locked: false, facts: [] }; state.entities.push(entity); }
      // Locked records retain human prose and aliases; evidence may be appended, never overwritten.
      if (!entity.locked) { entity.aliases = [...new Set([...entity.aliases, ...extracted.aliases])]; if (extracted.description.trim() && extracted.facts.some(f => f.temporal === 'current')) entity.description = extracted.description; if (extracted.visibility === 'secret') entity.visibility = 'secret'; }
      for (const fact of extracted.facts) {
        if (entity.facts.some(f => f.text === fact.text && f.attribute === fact.attribute && f.citation?.chapterId === chapterId && f.citation.paragraph === fact.paragraph && f.citation.quote === fact.quote)) continue;
        let conflict = ambiguous || (entity.locked && fact.temporal === 'current');
        if (fact.attribute && fact.temporal === 'current' && fact.certainty === 'fact') {
          const oldCurrent = entity.facts.filter(f => f.attribute === fact.attribute && f.temporal === 'current' && f.certainty === 'fact');
          if (oldCurrent.some(f => f.locked)) conflict = true;
          if (!conflict) for (const old of oldCurrent) old.temporal = 'past';
        }
        entity.facts.push({ id: id(), text: fact.text, attribute: fact.attribute, temporal: fact.temporal, certainty: conflict ? 'conflict' : fact.certainty, visibility: fact.visibility, citation: citation(fact.paragraph, fact.quote) });
      }
    }
    for (const [index, extracted] of result.relations.entries()) {
      const from = resolve(extracted.from); const to = resolve(extracted.to);
      for (const [field, matches] of [['from', from], ['to', to]] as const) if (matches.length !== 1) issues.push({ path: `relations[${index}].${field}`, message: '关系端点必须匹配唯一的已有或本次提取实体，请核对名称与别名', paragraph: extracted.paragraph, quote: extracted.quote, sourceText: lines[extracted.paragraph - 1] });
      if (from.length !== 1 || to.length !== 1) continue;
      if (!state.relations.some(r => r.fromId === from[0].id && r.toId === to[0].id && r.label === extracted.label && r.citation?.chapterId === chapterId)) state.relations.push({ id: id(), fromId: from[0].id, toId: to[0].id, label: extracted.label, visibility: extracted.visibility, citation: citation(extracted.paragraph, extracted.quote) });
    }
    for (const [index, item] of result.foreshadows.entries()) {
      const old = state.foreshadows.find(f => normalize(f.title) === normalize(item.title));
      const relatedEntityIds = item.relatedNames.flatMap((n, nameIndex) => { const matches = resolve(n); if (matches.length !== 1) { issues.push({ path: `foreshadows[${index}].relatedNames[${nameIndex}]`, message: '伏笔关联名称必须匹配唯一实体，请核对名称与别名' }); return []; } return matches[0].id; });
      const updated: Foreshadow = { id: old?.id ?? id(), title: item.title, detail: item.detail, status: item.status, dueChapter: item.dueChapter, revealCondition: item.revealCondition, relatedEntityIds, plantedChapterId: old?.plantedChapterId ?? (item.status === 'planted' ? chapterId : undefined), resolvedChapterId: item.status === 'resolved' ? chapterId : old?.resolvedChapterId };
      if (old) Object.assign(old, updated); else state.foreshadows.push(updated);
    }
    if (issues.length) throw new OutputValidationError(issues, '资料关联校验失败，请在作者输出记录中查看全部问题并修正');
    ref.summary = [ref.summary, result.summary].filter(Boolean).join('\n').slice(-16000); ref.status = complete ? 'ready' : 'pending';
    return this.commit(branchId, base, state, complete ? `完成资料整理：${ref.title}` : `整理章节片段：${ref.title}`, checkpoint);
  }
  exportProject(projectId: string): unknown {
    const project = this.getProject(projectId); const branches = this.listBranches(projectId); const revisionIds = new Set(branches.flatMap(b => this.history(b.id).map(r => r.id)));
    const chapterIds = new Set<string>();
    const revisions = [...revisionIds].map(revisionId => {
      const row = this.db.prepare('SELECT data,state FROM revisions WHERE id=?').get(revisionId)!;
      for (const chapter of unpack(row.state).chapters) chapterIds.add(chapter.id);
      return { revision: parse<Revision>(row.data), snapshot: Buffer.from(row.state as Uint8Array).toString('base64') };
    });
    const chapters = [...chapterIds].map(chapterId => { const row = this.db.prepare('SELECT data,text FROM chapter_texts WHERE id=?').get(chapterId)!; return { ...parse<ChapterRef>(row.data), text: String(row.text) }; });
    const jobs = this.db.prepare('SELECT data FROM jobs WHERE project_id=?').all(projectId).map(r => parse<Job>(r.data));
    const importChapters = this.db.prepare('SELECT c.job_id AS jobId,c.position,c.title,c.text FROM job_import_chapters c JOIN jobs j ON j.id=c.job_id WHERE j.project_id=? ORDER BY c.job_id,c.position').all(projectId);
    return { version: 1, project, branches, revisions, chapters, jobs, importChapters, outputs: this.outputs.all(projectId) };
  }
  restoreProject(input: unknown, sourceIdMap: Record<string, string> = {}, onRestore?: (project: Project) => void): Project {
    const parsed = backupSchema.safeParse(input); if (!parsed.success) throw new HttpError('作品备份格式不正确或缺少正文与世界资料字段');
    const data = parsed.data;
    const readState = (entry: typeof data.revisions[number]): StoryState => {
      if (entry.state) return entry.state;
      try { return stateSchema.parse(JSON.parse(gunzipSync(Buffer.from(entry.snapshot!, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString())); }
      catch { throw new HttpError('备份历史快照损坏、格式不正确或单版本解压后超过 64 MB'); }
    };
    const map = new Map<string, string>(); const register = (value: string) => { if (value && !map.has(value)) map.set(value, id()); };
    register(data.project.id); for (const b of data.branches) register(b.id); for (const c of data.chapters) register(c.id); for (const job of data.jobs) register(job.id); for (const output of data.outputs) register(output.id);
    for (const r of data.revisions) { register(r.revision.id); const state = readState(r); for (const e of state.entities) { register(e.id); for (const f of e.facts) register(f.id); } for (const relation of state.relations) register(relation.id); for (const f of state.foreshadows) register(f.id); }
    const remap = (value: unknown, key = ''): unknown => {
      if (typeof value === 'string') { if (key === 'sourceId') return sourceIdMap[value]; if (key.endsWith('Id') || key === 'id' || key === 'mergedInto' || key === 'relatedEntityIds') return map.get(value) ?? value; return value; }
      if (Array.isArray(value)) return value.map(v => remap(v, key)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, k)])); return value;
    };
    const restored = remap(data) as typeof data;
    const restoredState = (index: number) => remap(readState(data.revisions[index])) as StoryState;
    const branchIds = new Set(restored.branches.map(b => b.id)); const revisionIds = new Set(restored.revisions.map(r => r.revision.id)); const chapterIds = new Set(restored.chapters.map(c => c.id));
    if (branchIds.size !== restored.branches.length || revisionIds.size !== restored.revisions.length || chapterIds.size !== restored.chapters.length || !branchIds.has(restored.project.mainBranchId) || restored.branches.some(b => b.projectId !== restored.project.id || !revisionIds.has(b.revisionId) || (b.parentBranchId && !branchIds.has(b.parentBranchId))) || restored.revisions.some(r => !branchIds.has(r.revision.branchId) || (r.revision.parentId && !revisionIds.has(r.revision.parentId)))) throw new HttpError('备份存在无效关联');
    const chapterLookup = new Map(restored.chapters.map(c => [c.id, paragraphs(c.text)]));
    for (let index = 0; index < restored.revisions.length; index++) {
      const state = restoredState(index);
      if (state.chapters.some(c => !chapterIds.has(c.id)) || restored.revisions[index].revision.chapterCount !== state.chapters.length) throw new HttpError('备份章节版本关联无效');
      const included = new Set(state.chapters.map(c => c.id)); const entities = new Set(state.entities.map(e => e.id));
      const validCitation = (c: { chapterId: string; paragraph: number; quote: string } | undefined) => !c || (included.has(c.chapterId) && chapterLookup.get(c.chapterId)?.[c.paragraph - 1]?.includes(c.quote));
      if (included.size !== state.chapters.length || entities.size !== state.entities.length || state.entities.some(e => (e.mergedInto && (!entities.has(e.mergedInto) || e.mergedInto === e.id)) || e.facts.some(f => !validCitation(f.citation))) || state.relations.some(r => !entities.has(r.fromId) || !entities.has(r.toId) || !validCitation(r.citation)) || state.foreshadows.some(f => f.relatedEntityIds.some(e => !entities.has(e)) || (f.plantedChapterId && !included.has(f.plantedChapterId)) || (f.resolvedChapterId && !included.has(f.resolvedChapterId)))) throw new HttpError('备份存在无效资料关联或原文引用');
    }
    const parents = new Map(restored.revisions.map(r => [r.revision.id, r.revision.parentId]));
    for (const revision of restored.revisions) { const visited = new Set<string>(); let current: string | undefined = revision.revision.id; while (current) { if (visited.has(current)) throw new HttpError('备份版本存在循环引用'); visited.add(current); current = parents.get(current); } }
    const jobs = new Map(restored.jobs.map(j => [j.id, j])); const importPositions = new Set<string>();
    if (jobs.size !== restored.jobs.length || restored.jobs.some(j => j.projectId !== restored.project.id || !branchIds.has(j.branchId) || !revisionIds.has(j.baseRevisionId) || j.progress > j.total)) throw new HttpError('备份存在无效任务关联');
    for (const part of restored.importChapters) { const key = `${part.jobId}:${part.position}`; if (jobs.get(part.jobId)?.kind !== 'import' || importPositions.has(key) || part.position >= jobs.get(part.jobId)!.total) throw new HttpError('备份导入章节关联无效'); importPositions.add(key); }
    for (const job of restored.jobs) {
      for (const field of ['blockIndex', 'importIndex']) if (job.payload[field] !== undefined && (!Number.isInteger(job.payload[field]) || Number(job.payload[field]) < 0)) throw new HttpError('备份任务进度无效');
      for (const field of ['generatedChapterId', 'extractChapterId', 'importCurrentChapterId', 'chapterId']) if (job.payload[field] && !chapterIds.has(String(job.payload[field]))) throw new HttpError('备份任务章节不存在');
      if (job.kind === 'import' && restored.importChapters.filter(c => c.jobId === job.id).length !== job.total) throw new HttpError('备份缺少尚待整理的导入章节');
      if (job.status === 'running' || job.status === 'queued') { job.status = 'paused'; job.message = '作品已恢复，请手动继续任务'; }
    }
    const outputIds = new Set(restored.outputs.map(o => o.id));
    if (outputIds.size !== restored.outputs.length || restored.outputs.some(o => o.projectId !== restored.project.id || !jobs.has(o.jobId) || !branchIds.has(o.branchId) || !revisionIds.has(o.baseRevisionId) || (o.chapterId && !chapterIds.has(o.chapterId)))) throw new HttpError('备份模型输出关联无效');
    for (const job of restored.jobs) if (job.payload.lastOutputId && !outputIds.has(String(job.payload.lastOutputId))) throw new HttpError('备份缺少任务关联的模型输出');
    restored.project.title += '（恢复）'; restored.project.updatedAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO projects VALUES(?,?)').run(restored.project.id, JSON.stringify(restored.project));
      for (const branch of restored.branches) this.db.prepare('INSERT INTO branches VALUES(?,?,?)').run(branch.id, restored.project.id, JSON.stringify(branch));
      for (let index = 0; index < restored.revisions.length; index++) { const revision = restored.revisions[index].revision; this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(revision.id, revision.branchId, revision.parentId ?? null, JSON.stringify(revision), pack(restoredState(index))); }
      for (const chapter of restored.chapters) { const { text, ...ref } = chapter; this.db.prepare('INSERT INTO chapter_texts VALUES(?,?,?)').run(ref.id, JSON.stringify(ref), text); this.db.prepare('INSERT INTO chapter_search(id,title,text) VALUES(?,?,?)').run(ref.id, ref.title, text); }
      for (const job of restored.jobs) this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, job.branchId, job.projectId, job.status, JSON.stringify(job));
      for (const chapter of restored.importChapters) this.db.prepare('INSERT INTO job_import_chapters VALUES(?,?,?,?)').run(chapter.jobId, chapter.position, chapter.title, chapter.text);
      for (const output of restored.outputs) this.outputs.insert(output);
      onRestore?.(restored.project);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return restored.project;
  }
}
