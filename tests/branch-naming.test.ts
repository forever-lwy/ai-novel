import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { buildApp } from '../server/app.js';
import { readingProgressStory } from './fixtures/reading-progress.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
function context() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-branch-names-'))); cleanup.push(() => store.close());
  return { store, ...readingProgressStory(store) };
}
async function httpContext() {
  const ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'novel-branch-names-api-')), initialPassword: 'branch-naming-password-123', startEngine: false });
  cleanup.push(() => ctx.app.close());
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'branch-naming-password-123' } });
  return { ...ctx, session: login.cookies.find(cookie => cookie.name === 'session')!.value, ...readingProgressStory(ctx.store) };
}

describe('story line names and lineage', () => {
  it('renames the main line and a child without changing revisions, prose, images or queued work; backup keeps the names', () => {
    const { store, project, branchId } = context(); const initial = store.getBranch(branchId);
    const child = store.fork(branchId, { baseRevisionId: initial.revisionId, name: '副线' });
    const state = store.state(branchId); const history = store.history(branchId); const images = store.images.all(project.id);
    const job = { id: 'waiting', projectId: project.id, branchId, baseRevisionId: initial.revisionId, kind: 'generate', status: 'paused', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: 0, total: 1, inputTokens: 0, outputTokens: 0, message: '等待', payload: {} };
    store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, branchId, project.id, job.status, JSON.stringify(job));
    const renamed = store.renameBranch(branchId, initial.revisionId, '  原作路线  ');
    expect(renamed).toEqual({ ...initial, name: '原作路线' });
    store.renameBranch(child.branch.id, child.branch.revisionId, '河岸路线');
    expect(store.state(branchId)).toEqual(state); expect(store.history(branchId)).toEqual(history); expect(store.images.all(project.id)).toEqual(images);
    expect(JSON.parse(String(store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data))).toEqual(job);
    expect(store.getBranch(child.branch.id)).toMatchObject({ name: '河岸路线', parentBranchId: branchId, revisionId: child.branch.revisionId });
    const restored = store.restoreProject(store.exportProject(project.id));
    expect(store.getBranch(restored.mainBranchId).name).toBe('原作路线');
    expect(store.listBranches(restored.id).find(branch => branch.name === '河岸路线')).toMatchObject({ parentBranchId: restored.mainBranchId, forkChapterTitle: child.branch.forkChapterTitle });
  });

  it('rejects blank, long, stale and deleted-line renames without modifying stored data', () => {
    const { store, project, branchId } = context(); const initial = store.getBranch(branchId);
    for (const name of ['', '  ', '名'.repeat(201)]) expect(() => store.renameBranch(branchId, initial.revisionId, name)).toThrow('名称');
    expect(() => store.renameBranch(branchId, 'stale', '新名字')).toThrow('新版本');
    expect(store.getBranch(branchId)).toEqual(initial);
    const child = store.fork(branchId, { baseRevisionId: initial.revisionId, name: '已删除路线' });
    store.deleteBranch(child.branch.id, child.branch.revisionId);
    expect(() => store.renameBranch(child.branch.id, child.branch.revisionId, '不可恢复')).toThrow('已删除');
    expect(store.listBranches(project.id, true).find(branch => branch.id === child.branch.id)?.name).toBe('已删除路线');
  });

  it('attaches repeated regeneration to the shared source while preserving genuine forks and source history', () => {
    const { store, project, branchId } = context(); const source = store.state(branchId); const original = store.getBranch(branchId);
    const a = store.forkForGeneration(branchId, original.revisionId, source.chapters[2].id, '第三章 A');
    const add = (id: string, title: string) => {
      const saved = store.saveChapter(id, { baseRevisionId: store.getBranch(id).revisionId, title, text: `${title}的正文。` });
      return store.applyExtraction(id, saved.branch.revisionId, saved.state.chapters.at(-1)!.id, { summary: title, entities: [], relations: [], foreshadows: [] }, true);
    };
    const aThird = add(a.branch.id, '第三章 A');
    const b = store.forkForGeneration(a.branch.id, aThird.branch.revisionId, aThird.state.chapters[2].id, '第三章 B');
    expect(b.branch.parentBranchId).toBe(branchId); expect(b.branch.forkChapterId).toBe(source.chapters[1].id);
    const bThird = add(b.branch.id, '第三章 B');
    const c = store.forkForGeneration(b.branch.id, bThird.branch.revisionId, bThird.state.chapters[2].id, '第三章 C');
    expect(c.branch.parentBranchId).toBe(branchId);
    const aFourth = add(a.branch.id, '第四章 A');
    const later = store.forkForGeneration(a.branch.id, aFourth.branch.revisionId, aFourth.state.chapters[3].id, '第四章另一版');
    expect(later.branch.parentBranchId).toBe(a.branch.id); expect(later.branch.forkChapterId).toBe(aThird.state.chapters[2].id);
    const earlier = store.forkForGeneration(a.branch.id, aFourth.branch.revisionId, source.chapters[0].id, '第一章另一版');
    expect(earlier.branch.parentBranchId).toBe(branchId); expect(earlier.state.chapters).toEqual([]);
    expect(store.state(branchId)).toEqual(source); expect(store.getBranch(branchId)).toEqual(original);
    const restored = store.restoreProject(store.exportProject(project.id));
    expect(store.listBranches(restored.id).filter(branch => ['第三章 A', '第三章 B', '第三章 C'].includes(branch.name)).every(branch => branch.parentBranchId === restored.mainBranchId)).toBe(true);
    expect(store.history(b.branch.id).some(revision => revision.branchId === a.branch.id)).toBe(true);
  });

  it('retains a branch as the generation source after an inherited chapter is edited on that branch', () => {
    const { store, branchId } = context(); const current = store.state(branchId);
    const fork = store.fork(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, chapterId: current.chapters[1].id, name: '手动编辑线' });
    const edited = store.saveChapter(fork.branch.id, { baseRevisionId: fork.branch.revisionId, chapterId: fork.state.chapters[0].id, title: '修改开篇', text: '本线独有的开篇。' });
    const alternate = store.forkForGeneration(fork.branch.id, edited.branch.revisionId, edited.state.chapters[1].id, '接续新开篇');
    expect(alternate.branch.parentBranchId).toBe(fork.branch.id);
    expect(alternate.state.chapters[0].id).toBe(edited.state.chapters[0].id);
  });

  it('keeps only deleted ancestors needed by living children, records the actual fork boundary, and reads old titles without writes', () => {
    const { store, project, branchId, first } = context(); const root = store.getBranch(branchId);
    const parent = store.fork(branchId, { baseRevisionId: root.revisionId, chapterId: first.state.chapters[0].id, name: '父线' });
    const child = store.fork(parent.branch.id, { baseRevisionId: parent.branch.revisionId, name: '子线' });
    const unrelated = store.fork(branchId, { baseRevisionId: root.revisionId, name: '无子线的旧分支' });
    store.deleteBranch(parent.branch.id, parent.branch.revisionId); store.deleteBranch(unrelated.branch.id, unrelated.branch.revisionId);
    expect(store.listBranches(project.id).map(branch => branch.id)).toEqual([branchId, child.branch.id]);
    const tree = store.listBranchTree(project.id);
    expect(tree.map(branch => branch.id)).toEqual([branchId, parent.branch.id, child.branch.id]);
    expect(tree[1]).toMatchObject({ deletedAt: expect.any(String), forkChapterTitle: first.state.chapters[0].title });
    expect(tree[2]).toMatchObject({ parentBranchId: parent.branch.id, forkChapterId: first.state.chapters[0].id });
    const oldChild = { ...child.branch }; delete oldChild.forkChapterTitle;
    store.db.prepare('UPDATE branches SET data=? WHERE id=?').run(JSON.stringify(oldChild), oldChild.id);
    const changes = store.db.prepare('SELECT total_changes() AS n').get()!.n;
    expect(store.listBranchTree(project.id).at(-1)?.forkChapterTitle).toBe(first.state.chapters[0].title);
    expect(store.getBranch(oldChild.id)).toEqual(oldChild); expect(store.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(changes);
    const other = store.createProject({ title: '另一个作品' }); expect(store.listBranchTree(other.id)).toHaveLength(1);
  });
});

describe('branch naming HTTP contracts', () => {
  it('requires login, validates names and revision, and returns only metadata', async () => {
    const { store, app, session, branchId } = await httpContext(); const initial = store.getBranch(branchId);
    const request = { method: 'PUT' as const, url: `/api/branches/${branchId}/name`, payload: { baseRevisionId: initial.revisionId, name: '新主线名称' } };
    expect((await app.inject({ ...request, url: `${request.url}?view=author` })).statusCode).toBe(401);
    expect((await app.inject({ ...request, cookies: { session } })).statusCode).toBe(200);
    for (const name of ['', ' ', '名'.repeat(201)]) expect((await app.inject({ ...request, url: `${request.url}?view=author`, cookies: { session }, payload: { ...request.payload, name } })).statusCode).toBe(400);
    expect((await app.inject({ ...request, url: `${request.url}?view=author`, cookies: { session }, payload: { ...request.payload, baseRevisionId: 'old' } })).statusCode).toBe(409);
    const response = await app.inject({ ...request, url: `${request.url}?view=author`, cookies: { session } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ...initial, name: '新主线名称' });
    expect(response.json()).not.toHaveProperty('state'); expect(store.getProject(initial.projectId).mainBranchId).toBe(branchId);
  });

  it.each(['rewrite', 'regenerate', 'rpg'] as const)('uses a chosen name for a %s branch and preserves the source line', async kind => {
    const { store, app, session, project, branchId } = await httpContext(); const before = store.state(branchId); const root = store.getBranch(branchId);
    const payload = { baseRevisionId: root.revisionId, mode: kind === 'rpg' ? 'rpg' : 'rewrite', instruction: '中性验证', branchName: `  自选 ${kind} 路线  `,
      ...(kind === 'rpg' ? { rpg: { character: { kind: 'original', name: '旅人', description: '' }, entryChapterId: before.chapters[1].id } } : { chapterId: before.chapters[1].id, ...(kind === 'regenerate' ? { regenerate: true } : { selection: { start: 0, end: 2 } }) }) };
    const response = await app.inject({ method: 'POST', url: `/api/branches/${branchId}/generate?view=author`, cookies: { session }, payload });
    expect(response.statusCode).toBe(200); const queued = response.json();
    expect(queued.branchId).not.toBe(branchId); expect(store.getBranch(queued.branchId)).toMatchObject({ name: `自选 ${kind} 路线`, parentBranchId: branchId, forkChapterId: before.chapters[kind === 'rpg' ? 1 : 0].id });
    expect(store.getBranch(branchId)).toEqual(root); expect(store.state(branchId)).toEqual(before); expect(store.listBranches(project.id)).toHaveLength(2);
    const renamed = await app.inject({ method: 'PUT', url: `/api/branches/${queued.branchId}/name?view=author`, cookies: { session }, payload: { baseRevisionId: queued.baseRevisionId, name: '生成中改名' } });
    expect(renamed.statusCode).toBe(200); expect(renamed.json().revisionId).toBe(queued.baseRevisionId);
  });

  it('rejects invalid generation names before creating a branch or job, while old clients retain default names', async () => {
    const { store, engine, app, session, project, branchId } = await httpContext(); const original = store.getBranch(branchId);
    const payload = { baseRevisionId: original.revisionId, mode: 'rewrite', instruction: '', chapterId: store.state(branchId).chapters[0].id };
    for (const branchName of ['', ' ', '名'.repeat(201)]) {
      expect((await app.inject({ method: 'POST', url: `/api/branches/${branchId}/generate?view=author`, cookies: { session }, payload: { ...payload, branchName } })).statusCode).toBe(400);
      expect(() => engine.enqueue(branchId, 'generate', { ...payload, branchName })).toThrow('名称');
    }
    expect(store.listBranches(project.id)).toHaveLength(1); expect(engine.listJobs(project.id)).toEqual([]);
    const queued = await app.inject({ method: 'POST', url: `/api/branches/${branchId}/generate?view=author`, cookies: { session }, payload });
    expect(queued.statusCode).toBe(200); expect(store.getBranch(queued.json().branchId).name).toMatch(/^重新生成 · /);
  });

  it('exposes a usable tree including deleted connectors without allowing them to be selected or renamed', async () => {
    const { store, app, session, project, branchId } = await httpContext();
    const parent = store.fork(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, name: '旧连接' });
    const child = store.fork(parent.branch.id, { baseRevisionId: parent.branch.revisionId, name: '仍可选择' });
    store.deleteBranch(parent.branch.id, parent.branch.revisionId);
    const detail = await app.inject({ url: `/api/projects/${project.id}`, cookies: { session } });
    expect(detail.statusCode).toBe(200); expect(detail.json().branches.map((branch: { id: string }) => branch.id)).toEqual([branchId, child.branch.id]);
    expect(detail.json().branchTree.map((branch: { id: string }) => branch.id)).toEqual([branchId, parent.branch.id, child.branch.id]);
    expect(detail.json().project.premise).toBe(''); expect(detail.json().branchTree[1]).not.toHaveProperty('state');
    for (const branch of detail.json().branchTree) for (const chapter of branch.chapters) expect(Object.keys(chapter).sort()).toEqual(['id', 'title']);
    expect(detail.json().branchTree[0].chapters.map((chapter: { id: string }) => chapter.id)).toEqual(store.state(branchId).chapters.map(chapter => chapter.id));
    expect((await app.inject({ url: `/api/branches/${parent.branch.id}`, cookies: { session } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/branches/${parent.branch.id}/name?view=author`, cookies: { session }, payload: { baseRevisionId: parent.branch.revisionId, name: '不会恢复' } })).statusCode).toBe(404);
  });
});
