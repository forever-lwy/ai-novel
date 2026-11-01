import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Store } from '../server/store.js';
import { applyHistoryCleanup, planHistoryCleanup } from '../server/history-cleanup.js';
import type { Job } from '../shared/types.js';
import { legacyReadingProgressStory, readingProgressStory } from './fixtures/reading-progress.js';

const dispose: (() => void)[] = [];
afterEach(() => { for (const cleanup of dispose.splice(0)) cleanup(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'novel-history-cleanup-')); const store = new Store(directory);
  dispose.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
function clutter(store: Store, branchId: string, count = 8) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const state = store.state(branchId); state.outline.locked = `设定修订 ${index}`;
    ids.push(store.commit(branchId, store.getBranch(branchId).revisionId, state, '调整写作设定').branch.revisionId);
  }
  return ids;
}
function clean(store: Store, count = 1) {
  const plan = planHistoryCleanup(store, { maxAgeDays: 0, maxCount: count });
  store.db.exec('BEGIN IMMEDIATE');
  try { applyHistoryCleanup(store, plan); store.db.exec('COMMIT'); } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return plan;
}
function stamp(store: Store, revisionId: string, createdAt: string) {
  const revision = store.revision(revisionId); revision.createdAt = createdAt;
  store.db.prepare('UPDATE revisions SET data=? WHERE id=?').run(JSON.stringify(revision), revisionId);
}
function job(store: Store, branchId: string, baseRevisionId: string): Job {
  const value: Job = { id: randomUUID(), projectId: store.getBranch(branchId).projectId, branchId, baseRevisionId, kind: 'generate', status: 'completed', progress: 1, total: 1, message: '', inputTokens: 0, outputTokens: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), payload: {} };
  store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(value.id, value.branchId, value.projectId, value.status, JSON.stringify(value)); return value;
}

describe('safe history retention', () => {
  it('removes excess intermediate snapshots, relinks history and preserves the original creation and current state', () => {
    const store = fixture(); const project = store.createProject({ title: '清理版本' }); const branchId = project.mainBranchId;
    const origin = store.getBranch(branchId).revisionId; const ids = clutter(store, branchId); const before = store.state(branchId);
    const plan = planHistoryCleanup(store, { maxAgeDays: 0, maxCount: 2 });
    expect(plan.deleteIds).toHaveLength(6); expect(plan.protectedCount).toBe(1);
    expect(store.history(branchId)).toHaveLength(9); // planning is read-only
    applyHistoryCleanup(store, plan);
    expect(store.state(branchId)).toEqual(before); expect(store.history(branchId).map(revision => revision.id)).toEqual([ids[7], ids[6], origin]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()!.n).toBe(3);
    const restored = store.restoreProject(store.exportProject(project.id));
    expect(store.state(restored.mainBranchId).outline.locked).toBe(before.outline.locked);
  });

  it('supports days, counts and their union without interpreting disabled limits as deletion', () => {
    const store = fixture(); const project = store.createProject({ title: '保留条件' }); const branchId = project.mainBranchId;
    const ids = clutter(store, branchId, 5); const now = Date.parse('2026-11-01T12:00:00Z');
    ids.forEach((id, index) => stamp(store, id, new Date(now - (5 - index) * 86_400_000).toISOString()));
    stamp(store, store.history(branchId).at(-1)!.id, '2026-10-01T00:00:00Z');
    expect(planHistoryCleanup(store, { maxAgeDays: 0, maxCount: 0 }, now).deleteIds).toEqual([]);
    expect(new Set(planHistoryCleanup(store, { maxAgeDays: 3, maxCount: 0 }, now).deleteIds)).toEqual(new Set(ids.slice(0, 2)));
    expect(new Set(planHistoryCleanup(store, { maxAgeDays: 3, maxCount: 2 }, now).deleteIds)).toEqual(new Set(ids.slice(0, 3)));
    stamp(store, ids[0], 'invalid legacy time');
    expect(planHistoryCleanup(store, { maxAgeDays: 1, maxCount: 1 }, now).deleteIds).not.toContain(ids[0]);
  });

  it('preserves each retained timeline chapter boundary, forks, source canon, rollback jumps and backup recovery', () => {
    const store = fixture(); const ctx = readingProgressStory(store); const main = ctx.branchId;
    clutter(store, main);
    const fork = store.fork(main, { baseRevisionId: store.getBranch(main).revisionId, chapterId: ctx.first.state.chapters[0].id, name: '河岸分支' });
    clutter(store, fork.branch.id, 5);
    const originalReference = store.resolveSourceReference(fork.branch.id)!;
    const referenceBefore = store.originalReference(fork.branch.id, originalReference).state;
    const rollback = store.rollback(main, { baseRevisionId: store.getBranch(main).revisionId, revisionId: ctx.second.branch.revisionId });
    clutter(store, main, 4);
    const before = store.state(main); const early = store.readingState(main, before.chapters[0].id, false);
    const plan = clean(store);
    expect(plan.deleteIds.length).toBeGreaterThan(5);
    expect(store.state(main)).toEqual(before); expect(store.readingState(main, before.chapters[0].id, false)).toEqual(early);
    expect(store.history(main).some(revision => revision.id === rollback.branch.revisionId)).toBe(true);
    expect(store.originalReference(fork.branch.id, originalReference).state).toEqual(referenceBefore);
    const newFork = store.fork(main, { baseRevisionId: store.getBranch(main).revisionId, chapterId: before.chapters[0].id, name: '清理后仍可分支' });
    expect(newFork.state.chapters).toHaveLength(1);
    const regenerated = store.forkForGeneration(main, store.getBranch(main).revisionId, before.chapters[0].id, '清理后重写首章');
    expect(regenerated.state.chapters).toHaveLength(0);
    const restored = store.restoreProject(store.exportProject(ctx.project.id));
    expect(store.state(restored.mainBranchId).chapters.map(chapter => chapter.title)).toEqual(before.chapters.map(chapter => chapter.title));
  });

  it('keeps task, response and internal extraction-evidence versions while allowing removed record dependencies to go', () => {
    const store = fixture(); const project = store.createProject({ title: '依赖版本' }); const branchId = project.mainBranchId;
    const ids = clutter(store, branchId, 8); const owner = job(store, branchId, ids[1]);
    owner.payload.baseRevisionId = ids[5]; owner.payload.sourceReference = { branchId, revisionId: ids[6], sourceIds: [] };
    store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(owner), owner.id);
    const writing = store.outputs.create({ jobId: owner.id, projectId: project.id, branchId, baseRevisionId: ids[2], stage: 'writing' }, { text: '正文', rawResponse: '正文', inputTokens: 0, outputTokens: 0 });
    const extraction = store.outputs.create({ jobId: owner.id, projectId: project.id, branchId, baseRevisionId: ids[3], stage: 'extraction' }, { text: '{}', rawResponse: '{}', inputTokens: 0, outputTokens: 0 });
    store.outputs.update(extraction.id, { status: 'applied' });
    store.db.exec('CREATE TABLE IF NOT EXISTS extraction_evidence(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,data TEXT NOT NULL)');
    store.db.prepare('INSERT INTO extraction_evidence VALUES(?,?,?)').run('evidence', project.id, JSON.stringify({ baseRevisionId: ids[4] }));
    const ordinary = planHistoryCleanup(store, { maxAgeDays: 0, maxCount: 1 });
    for (const id of ids.slice(1, 7)) expect(ordinary.deleteIds).not.toContain(id);
    const removed = planHistoryCleanup(store, { maxAgeDays: 0, maxCount: 1 }, Date.now(), { deleteJobIds: new Set([owner.id]), deleteOutputIds: new Set([writing.id, extraction.id]) });
    expect(removed.deleteIds).toContain(ids[1]); expect(removed.deleteIds).toContain(ids[2]);
    expect(removed.deleteIds).toContain(ids[5]); expect(removed.deleteIds).toContain(ids[6]);
    expect(removed.deleteIds).not.toContain(ids[3]); expect(removed.deleteIds).not.toContain(ids[4]);
  });

  it('does not change legacy repaired visibility or manually authored public/secret decisions', () => {
    const store = fixture(); const ctx = legacyReadingProgressStory(store);
    const entity = structuredClone(store.state(ctx.branchId).entities.find(value => value.name === '林舟')!); entity.visibility = 'secret';
    const authored = store.updateEntity(ctx.branchId, store.getBranch(ctx.branchId).revisionId, entity);
    const parentId = store.revision(authored.branch.revisionId).parentId!;
    clutter(store, ctx.branchId, 6);
    const before = store.state(ctx.branchId); const reader = store.readingState(ctx.branchId, before.chapters[0].id);
    const plan = clean(store);
    expect(plan.deleteIds.length).toBeGreaterThan(0); expect(plan.deleteIds).not.toContain(authored.branch.revisionId); expect(plan.deleteIds).not.toContain(parentId);
    expect(store.state(ctx.branchId)).toEqual(before); expect(store.readingState(ctx.branchId, before.chapters[0].id)).toEqual(reader);
  });

  it('preserves the exact legacy manual-edit parent needed to repair detached image and chapter links', () => {
    const store = fixture(); const ctx = readingProgressStory(store); const branchId = ctx.branchId;
    const parent = store.getBranch(branchId).revisionId; const first = store.state(branchId).chapters[0];
    // Emulate old snapshots: the chapter provenance and reused image association were absent.
    const legacy = store.state(branchId); const replacement = store.putChapter(first.title, '旅人林舟再次踏上河岸。');
    replacement.status = 'ready'; delete replacement.previousChapterIds; legacy.chapters[0] = replacement;
    const portrait = store.images.all(ctx.project.id).find(image => image.kind === 'portrait')!;
    legacy.imageIds = legacy.imageIds?.filter(id => id !== portrait.id); legacy.activeImageIds = legacy.activeImageIds?.filter(id => id !== portrait.id);
    const edited = store.commit(branchId, parent, legacy, '编辑正文，保留已有资料');
    const expected = store.state(branchId);
    clutter(store, branchId, 5);
    const plan = clean(store);
    expect(plan.deleteIds).not.toContain(edited.branch.revisionId); expect(plan.deleteIds).not.toContain(store.revision(edited.branch.revisionId).parentId!);
    expect(store.state(branchId).chapters[0].previousChapterIds).toEqual(expected.chapters[0].previousChapterIds);
    expect(store.state(branchId).imageIds).toContain(portrait.id);
  });

  it('reports surviving RPG task dependencies, including when history retention is disabled', () => {
    const store = fixture(); const project = store.createProject({ title: 'RPG选择任务' }); const branchId = project.mainBranchId;
    const ids = clutter(store, branchId, 4); const owner = job(store, branchId, ids[0]);
    const state = store.state(branchId);
    state.rpg = { character: { kind: 'original', name: '旅人', description: '' }, entryInstruction: '', nextChoice: { id: 'choice', question: '去哪里？', options: [{ id: 'a', label: '河岸' }, { id: 'b', label: '山城' }], jobId: owner.id, chapterId: 'chapter', maxWords: 1000, instruction: '' } };
    store.commit(branchId, store.getBranch(branchId).revisionId, state, '选择等待');
    expect(planHistoryCleanup(store, { maxAgeDays: 0, maxCount: 0 }).protectedJobIds).toContain(owner.id);
    expect(planHistoryCleanup(store, { maxAgeDays: 0, maxCount: 1 }, Date.now(), { deleteJobIds: new Set([owner.id]) }).protectedJobIds).toContain(owner.id);
  });

  it('protects old source-line tasks whose payload is the only surviving original-reference route', () => {
    const store = fixture(); const ctx = readingProgressStory(store);
    const fork = store.fork(ctx.branchId, { baseRevisionId: store.getBranch(ctx.branchId).revisionId, chapterId: ctx.first.state.chapters[0].id, name: '旧版来源' });
    // Older branch data had neither an explicit sourceReference nor parentBranchId.
    const branch = store.getBranch(fork.branch.id); delete branch.parentBranchId;
    store.db.prepare('UPDATE branches SET data=? WHERE id=?').run(JSON.stringify(branch), branch.id);
    const legacy = store.state(branch.id); delete legacy.sourceReference;
    store.db.prepare('UPDATE revisions SET state=? WHERE id=?').run(gzipSync(JSON.stringify(legacy)), branch.revisionId);
    const owner = job(store, branch.id, branch.revisionId); owner.payload.sourceBranchId = ctx.branchId;
    store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(owner), owner.id);
    expect(store.resolveSourceReference(branch.id)?.branchId).toBe(ctx.branchId);
    clutter(store, branch.id, 4);
    const plan = planHistoryCleanup(store, { maxAgeDays: 0, maxCount: 1 }, Date.now(), { deleteJobIds: new Set([owner.id]) });
    expect(plan.protectedJobIds).toContain(owner.id);
    expect(planHistoryCleanup(store, { maxAgeDays: 0, maxCount: 0 }).protectedJobIds).toContain(owner.id);
  });
});
