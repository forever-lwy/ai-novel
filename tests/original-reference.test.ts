import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import type { Entity, ExtractionResult, Job, ModelRequest, Settings, StoryReference } from '../shared/types.js';

const stores: Store[] = [], engines: StoryEngine[] = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.close(); for (const store of stores.splice(0)) store.close(); });
const emptyExtraction = (): ExtractionResult => ({ summary: '已整理章节', entities: [], relations: [], foreshadows: [] });
function storeFor() { const store = new Store(mkdtempSync(join(tmpdir(), 'ai-novel-original-'))); stores.push(store); return store; }
function append(store: Store, branchId: string, text: string, sourceId?: string) {
  const state = store.state(branchId); const ref = store.putChapter(text, text, sourceId); state.chapters.push(ref);
  const saved = store.commit(branchId, store.getBranch(branchId).revisionId, state, text);
  return store.applyExtraction(branchId, saved.branch.revisionId, ref.id, { ...emptyExtraction(), summary: `摘要：${text}` }, true);
}
function entity(store: Store, branchId: string, name: string) {
  const value: Entity = { id: '', name, kind: 'character', aliases: [], description: `${name}的未来身份`, locked: true, visibility: 'secret', facts: [] };
  return store.updateEntity(branchId, store.getBranch(branchId).revisionId, value).state.entities.at(-1)!;
}
function fixture() {
  const store = storeFor(), project = store.createProject({ title: '原作参考' });
  const first = append(store, project.mainBranchId, '第一章现状'); append(store, project.mainBranchId, '第二章原作后续');
  const future = entity(store, project.mainBranchId, '后续人物');
  return { store, project, firstChapterId: first.state.chapters[0].id, future };
}
function sourceTable(store: Store) { store.db.exec('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, filename TEXT NOT NULL, format TEXT NOT NULL, chapter_count INTEGER NOT NULL, created_at TEXT NOT NULL, confirmed INTEGER NOT NULL, preview TEXT NOT NULL, storage_name TEXT NOT NULL)'); }
function source(store: Store, projectId: string, branchId: string, sourceId: string, confirmed = true) {
  sourceTable(store); const chapters = [{ title: '尚未整理的第三章', text: '原作尚未整理的后续人物使用神秘物品。' }];
  store.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)').run(sourceId, projectId, `${sourceId}.txt`, 'txt', 1, '2026-10-01T00:00:00.000Z', Number(confirmed), JSON.stringify(chapters), sourceId);
  const job: Job = { id: `import-${sourceId}`, projectId, branchId, kind: 'import', status: 'paused', baseRevisionId: store.getBranch(branchId).revisionId, progress: 0, total: 1, message: '', inputTokens: 0, outputTokens: 0, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', payload: { sourceId } };
  store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, branchId, projectId, job.status, JSON.stringify(job));
  store.db.prepare('INSERT INTO job_import_chapters VALUES(?,?,?,?)').run(job.id, 0, chapters[0].title, chapters[0].text);
}
const settings = (): Settings => ({ providers: [{ id: 'fixture', name: '本地模拟', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'writer', contextTokens: 64000, maxOutputTokens: 1000 }], writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture' });
function engineFor(store: Store, requests: ModelRequest[] = []) {
  const models: TextModels = { generateText: vi.fn(async (_config, request) => ({ text: '体验线新增正文。', inputTokens: 10, outputTokens: 5 })), generateStructured: vi.fn(async (_config, request, validate) => { requests.push(request); return { value: validate(emptyExtraction()), inputTokens: 1, outputTokens: 1 }; }) as TextModels['generateStructured'] };
  const engine = new StoryEngine(store, settings, models); engines.push(engine); return engine;
}
const rawJob = (store: Store, id: string): Job => JSON.parse(String(store.db.prepare('SELECT data FROM jobs WHERE id=?').get(id)!.data));
async function until<T>(read: () => T, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4000; for (;;) { const value = read(); if (accepts(value)) return value; if (Date.now() > deadline) throw new Error(`等待原作参考任务超时：${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}

describe('version-bound original novel references', () => {
  it('keeps complete original future chapters and characters apart from a chapter-boundary fork', () => {
    const { store, project, firstChapterId, future } = fixture(); const originalRevision = store.getBranch(project.mainBranchId).revisionId;
    const fork = store.fork(project.mainBranchId, { baseRevisionId: originalRevision, chapterId: firstChapterId, name: '体验线' });
    expect(fork.state.chapters).toHaveLength(1); expect(fork.state.entities.some(value => value.id === future.id)).toBe(false);
    expect(fork.state.sourceReference).toMatchObject({ branchId: project.mainBranchId, revisionId: originalRevision });
    const original = store.originalReference(fork.branch.id, fork.state.sourceReference!);
    expect(original.chapters[1]).toMatchObject({ text: '第二章原作后续', summary: '摘要：第二章原作后续' }); expect(original.state.entities).toContainEqual(future);
    entity(store, project.mainBranchId, '后来改动的原作人物');
    expect(store.originalReference(fork.branch.id, fork.state.sourceReference!).state.entities).toHaveLength(1);
    expect(store.view(fork.branch.id, false).state.sourceReference).toBeUndefined();
    expect(JSON.stringify(store.view(fork.branch.id, false))).not.toContain('后续人物');
  });

  it('inherits the same original snapshot through nested forks and generation rewrites', () => {
    const { store, project, firstChapterId } = fixture(); const originalRevision = store.getBranch(project.mainBranchId).revisionId;
    const fork = store.fork(project.mainBranchId, { baseRevisionId: originalRevision, chapterId: firstChapterId, name: '第一条派生线' });
    append(store, fork.branch.id, '派生线自己的后续');
    const nested = store.fork(fork.branch.id, { baseRevisionId: store.getBranch(fork.branch.id).revisionId, name: '第二条派生线' });
    expect(nested.state.sourceReference).toEqual(fork.state.sourceReference);
    const rewrite = store.forkForGeneration(project.mainBranchId, originalRevision, firstChapterId);
    expect(rewrite.state.chapters).toHaveLength(0); expect(rewrite.state.sourceReference?.revisionId).toBe(originalRevision);
    expect(store.originalReference(nested.branch.id, nested.state.sourceReference!).chapters.map(chapter => chapter.text)).not.toContain('派生线自己的后续');
  });

  it('retains an original reference when manually replacing the latest chapter', () => {
    const { store, project } = fixture(); const state = store.state(project.mainBranchId); const last = state.chapters.at(-1)!;
    const revised = store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, chapterId: last.id, title: '改写', text: '新的改写正文' });
    expect(revised.state.sourceReference).toBeDefined();
    expect(store.originalReference(revised.branch.id, revised.state.sourceReference!).chapters.at(-1)?.text).toBe('第二章原作后续');
  });

  it('reads confirmed raw future chapters before extraction and freezes the selected sources', () => {
    const { store, project, firstChapterId } = fixture(); source(store, project.id, project.mainBranchId, 'confirmed-original'); source(store, project.id, project.mainBranchId, 'draft-original', false);
    const other = store.fork(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, name: '另一素材线' }); source(store, project.id, other.branch.id, 'other-line-source');
    const fork = store.fork(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, chapterId: firstChapterId, name: '原作素材体验' });
    expect(fork.state.sourceReference?.sourceIds).toEqual(['confirmed-original']);
    const original = store.originalReference(fork.branch.id, fork.state.sourceReference!);
    expect(original.sources[0].chapters[0].text).toContain('尚未整理的后续人物'); expect(original.state.entities.map(value => value.name)).not.toContain('尚未整理的后续人物');
    source(store, project.id, project.mainBranchId, 'later-source');
    expect(store.originalReference(fork.branch.id, fork.state.sourceReference!).sources).toHaveLength(1);
  });

  it('recovers legacy lineage once without changing historical versions or following later source edits', () => {
    const { store, project, firstChapterId } = fixture(); const sourceRevision = store.getBranch(project.mainBranchId).revisionId;
    const fork = store.fork(project.mainBranchId, { baseRevisionId: sourceRevision, chapterId: firstChapterId, name: '旧版本体验线' });
    const legacy = store.state(fork.branch.id); delete legacy.sourceReference;
    store.db.prepare('UPDATE revisions SET state=? WHERE id=?').run(gzipSync(JSON.stringify(legacy)), fork.branch.revisionId);
    const updated = store.updateEntity(project.mainBranchId, sourceRevision, { id: '', name: '创建体验线之后才添加', kind: 'character', aliases: [], description: '', visibility: 'public', locked: true, facts: [] });
    const revision = store.revision(updated.branch.revisionId); revision.createdAt = new Date(Date.now() + 60000).toISOString(); store.db.prepare('UPDATE revisions SET data=? WHERE id=?').run(JSON.stringify(revision), revision.id);
    const recovered = store.resolveSourceReference(fork.branch.id)!;
    expect(recovered.revisionId).toBe(sourceRevision); expect(store.originalReference(fork.branch.id, recovered).state.entities).toHaveLength(1);
    expect(store.state(fork.branch.id).sourceReference).toBeUndefined(); expect(store.getBranch(fork.branch.id).revisionId).toBe(fork.branch.revisionId);
  });

  it('preserves legacy creation ordering through restore, including edits in the same millisecond', () => {
    const { store, project, firstChapterId } = fixture(); const sourceRevision = store.getBranch(project.mainBranchId).revisionId;
    const fork = store.fork(project.mainBranchId, { baseRevisionId: sourceRevision, chapterId: firstChapterId, name: '旧线同毫秒' });
    const legacy = store.state(fork.branch.id); delete legacy.sourceReference; store.db.prepare('UPDATE revisions SET state=? WHERE id=?').run(gzipSync(JSON.stringify(legacy)), fork.branch.revisionId);
    entity(store, project.mainBranchId, '创建分支之后的角色');
    const instant = '2026-10-01T00:00:00.000Z';
    for (const row of store.db.prepare('SELECT id,data FROM revisions').all()) { const revision = JSON.parse(String(row.data)); revision.createdAt = instant; store.db.prepare('UPDATE revisions SET data=? WHERE id=?').run(JSON.stringify(revision), row.id); }
    const child = store.getBranch(fork.branch.id); child.createdAt = instant; store.db.prepare('UPDATE branches SET data=? WHERE id=?').run(JSON.stringify(child), child.id);
    expect(store.resolveSourceReference(child.id)?.revisionId).toBe(sourceRevision);
    const restored = store.restoreProject(store.exportProject(project.id)); const restoredChild = store.listBranches(restored.id).find(branch => branch.name === child.name)!;
    const reference = store.resolveSourceReference(restoredChild.id)!; const original = store.originalReference(restoredChild.id, reference);
    expect(original.chapters).toHaveLength(2); expect(original.state.entities.map(value => value.name)).toEqual(['后续人物']);
  });

  it('uses the original history rather than reversed rowids when restoring older backup ordering', () => {
    const { store, project, firstChapterId } = fixture(); const sourceRevision = store.getBranch(project.mainBranchId).revisionId;
    const fork = store.fork(project.mainBranchId, { baseRevisionId: sourceRevision, chapterId: firstChapterId, name: '旧备份恢复' });
    const legacy = store.state(fork.branch.id); delete legacy.sourceReference; store.db.prepare('UPDATE revisions SET state=? WHERE id=?').run(gzipSync(JSON.stringify(legacy)), fork.branch.revisionId);
    const child = store.getBranch(fork.branch.id); child.createdAt = '2026-10-01T00:00:01.000Z'; store.db.prepare('UPDATE branches SET data=? WHERE id=?').run(JSON.stringify(child), child.id);
    for (const row of store.db.prepare('SELECT id,data FROM revisions').all()) { const revision = JSON.parse(String(row.data)); revision.createdAt = '2026-10-01T00:00:00.000Z'; store.db.prepare('UPDATE revisions SET data=? WHERE id=?').run(JSON.stringify(revision), row.id); }
    const backup = store.exportProject(project.id); backup.revisions.reverse(); const restored = store.restoreProject(backup);
    const restoredChild = store.listBranches(restored.id).find(branch => branch.name === child.name)!; const reference = store.resolveSourceReference(restoredChild.id)!;
    expect(store.originalReference(restoredChild.id, reference).chapters[1].text).toBe('第二章原作后续');
    expect(store.originalReference(restoredChild.id, reference).state.entities[0].name).toBe('后续人物');
  });

  it('restores reference links and confirmed source IDs into an independent project', () => {
    const { store, project, firstChapterId } = fixture(); source(store, project.id, project.mainBranchId, 'source-before-restore');
    const fork = store.fork(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, chapterId: firstChapterId, name: '可恢复体验' });
    const restored = store.restoreProject(store.exportProject(project.id), { 'source-before-restore': 'source-after-restore' }, restoredProject => {
      store.db.prepare('INSERT INTO sources SELECT ?,?,filename,format,chapter_count,created_at,confirmed,preview,? FROM sources WHERE id=?').run('source-after-restore', restoredProject.id, 'source-after-restore', 'source-before-restore');
    });
    const restoredFork = store.listBranches(restored.id).find(branch => branch.name === fork.branch.name)!; const ref = store.state(restoredFork.id).sourceReference!;
    expect(ref.branchId).toBe(restored.mainBranchId); expect(ref.revisionId).not.toBe(fork.state.sourceReference!.revisionId); expect(ref.sourceIds).toEqual(['source-after-restore']);
    expect(store.originalReference(restoredFork.id, ref).sources[0].chapters[0].text).toContain('神秘物品');
    expect(store.originalReference(restoredFork.id, ref).state.entities[0].id).not.toBe(store.originalReference(fork.branch.id, fork.state.sourceReference!).state.entities[0].id);
  });

  it('refuses missing source mappings and rolls back raw references that the restore callback assigns to another project', () => {
    const { store, project } = fixture(); source(store, project.id, project.mainBranchId, 'source-required');
    store.fork(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, name: '包含原作目录' });
    const backup = store.exportProject(project.id); expect(() => store.restoreProject(backup)).toThrow('完整作品备份');
    const count = store.listProjects().length;
    expect(() => store.restoreProject(backup, { 'source-required': 'wrong-project-source' }, () => {
      store.db.prepare('INSERT INTO sources SELECT ?,project_id,filename,format,chapter_count,created_at,confirmed,preview,? FROM sources WHERE id=?').run('wrong-project-source', 'wrong-project-source', 'source-required');
    })).toThrow('不属于恢复作品');
    expect(store.listProjects()).toHaveLength(count); expect(store.db.prepare('SELECT 1 FROM sources WHERE id=?').get('wrong-project-source')).toBeUndefined();
  });

  it('rejects cross-project references and damaged backup ownership links', () => {
    const { store, project, firstChapterId } = fixture(); const other = store.createProject({ title: '其他作品' });
    const wrong: StoryReference = { branchId: other.mainBranchId, revisionId: store.getBranch(other.mainBranchId).revisionId };
    expect(() => store.originalReference(project.mainBranchId, wrong)).toThrow('不属于');
    const fork = store.fork(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, chapterId: firstChapterId, name: '参考线' });
    const backup = store.exportProject(project.id); const target = backup.revisions.find(entry => entry.revision.id === fork.branch.revisionId)!;
    delete target.snapshot; Object.assign(target, { state: { ...store.state(fork.branch.id), sourceReference: wrong } });
    expect(() => store.restoreProject(backup)).toThrow('参考版本关联');
  });

  it('does not duplicate plain original writing as an original reference', () => {
    const { store, project } = fixture(); expect(store.resolveSourceReference(project.mainBranchId)).toBeUndefined();
    const setupOnly = store.createProject({ title: '原创世界', premise: '世界设定' });
    const rpg = store.startRpgFork(setupOnly.mainBranchId, store.getBranch(setupOnly.mainBranchId).revisionId, { character: { kind: 'original', name: '旅人', description: '' } });
    expect(store.originalReference(rpg.branch.id, rpg.state.sourceReference!).state.outline.worldview).toBe('世界设定');
  });

  it('pins the absence of a reference when an original job is queued', async () => {
    const store = storeFor(), project = store.createProject({ title: '队列固定空参考' }), engine = engineFor(store);
    const queued = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'original', instruction: '' });
    expect(rawJob(store, queued.id).payload).toMatchObject({ sourceReferenceCaptured: true }); expect(rawJob(store, queued.id).payload.sourceReference).toBeUndefined();
    source(store, project.id, project.mainBranchId, 'later-confirmed-source');
    const reading = vi.spyOn(store, 'originalReference'); engine.start();
    const done = await until(() => engine.listJobs().find(job => job.id === queued.id)!, job => ['completed', 'failed'].includes(job.status));
    expect(done.status).toBe('completed'); expect(reading).not.toHaveBeenCalled(); expect(store.state(project.mainBranchId).sourceReference).toBeUndefined();
  });

  it('keeps rejected pure-original future material out of regeneration while retaining it for explicit derivative modes', () => {
    const { store, project, firstChapterId } = fixture(); const engine = engineFor(store); const baseRevisionId = store.getBranch(project.mainBranchId).revisionId;
    const original = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId, mode: 'original', chapterId: firstChapterId, regenerate: true, instruction: '' });
    expect(rawJob(store, original.id).payload.sourceReference).toBeUndefined(); expect(rawJob(store, original.id).payload.sourceReferenceCaptured).toBe(true);
    expect(store.state(original.branchId).sourceReference).toBeDefined();
    const fanfiction = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId, mode: 'fanfiction', chapterId: firstChapterId, instruction: '' });
    expect(rawJob(store, fanfiction.id).payload.sourceReference).toBeDefined();
    source(store, project.id, project.mainBranchId, 'confirmed-canon');
    engine.action('import-confirmed-canon', 'cancel');
    const imported = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId, mode: 'original', chapterId: firstChapterId, regenerate: true, instruction: '' });
    expect((rawJob(store, imported.id).payload.sourceReference as StoryReference).sourceIds).toEqual(['confirmed-canon']);
  });

  it('pins queued generation and planning, persists the reference with prose, and excludes it from extraction context', async () => {
    const { store, project, firstChapterId } = fixture(); const fork = store.fork(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, chapterId: firstChapterId, name: '生成集成' });
    const extractionRequests: ModelRequest[] = []; const engine = engineFor(store, extractionRequests);
    const queued = engine.enqueue(fork.branch.id, 'generate', { baseRevisionId: fork.branch.revisionId, mode: 'fanfiction', instruction: '' }); const pinned = rawJob(store, queued.id).payload.sourceReference as StoryReference;
    entity(store, project.mainBranchId, '排队之后的新人物');
    const read = vi.spyOn(store, 'originalReference'); engine.start();
    const done = await until(() => engine.listJobs().find(job => job.id === queued.id)!, job => ['completed', 'failed'].includes(job.status)); expect(done.status).toBe('completed');
    expect(read).toHaveBeenCalledWith(fork.branch.id, pinned); expect(store.state(fork.branch.id).sourceReference).toEqual(pinned);
    await until(() => store.state(fork.branch.id).chapters, chapters => chapters.every(chapter => chapter.status === 'ready'));
    expect(extractionRequests.length).toBeGreaterThan(0); for (const request of extractionRequests) expect(JSON.stringify(request)).not.toContain('后续人物的未来身份');
    const plan = engine.enqueue(fork.branch.id, 'plan', { baseRevisionId: store.getBranch(fork.branch.id).revisionId }); expect(rawJob(store, plan.id).payload.sourceReference).toEqual(pinned); engine.action(plan.id, 'cancel');
  });
});
