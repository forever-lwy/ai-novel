import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { StoryEngine } from '../server/engine.js';
import { buildApp } from '../server/app.js';
import { readingProgressStory } from './fixtures/reading-progress.js';
import type { Job, Settings } from '../shared/types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); });
function story() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-branch-edit-'))); cleanup.push(() => store.close());
  return { store, ...readingProgressStory(store) };
}
const base = (store: Store, branchId: string) => store.getBranch(branchId).revisionId;
const settings: Settings = { providers: [], writingProviderId: '', planningProviderId: '', extractionProviderId: '' };
function job(store: Store, branchId: string, status: Job['status'] = 'failed') {
  const stamp = new Date().toISOString(); const branch = store.getBranch(branchId);
  const value: Job = { id: randomUUID(), projectId: branch.projectId, branchId, baseRevisionId: branch.revisionId, kind: 'extract', status, progress: 0, total: 0, inputTokens: 0, outputTokens: 0, message: '测试任务', payload: {}, createdAt: stamp, updatedAt: stamp };
  store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(value.id, branchId, branch.projectId, status, JSON.stringify(value)); return value;
}
function chapterChoice(store: Store, branchId: string) {
  const saved = job(store, branchId, 'completed'); const state = store.state(branchId); const chapterId = state.chapters.at(-1)!.id;
  saved.kind = 'generate'; saved.progress = saved.total = 1; saved.payload = { mode: 'rpg', generatedChapterId: chapterId };
  store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(saved), saved.id);
  state.rpg = { character: { kind: 'original', name: '旅人', description: '中性测试角色' }, entryInstruction: '', nextChoice: { id: 'chapter-choice', jobId: saved.id, chapterId, question: '前往哪里？', options: [{ id: 'a', label: '河岸' }, { id: 'b', label: '山城' }], maxWords: 1000, instruction: '' } };
  const view = store.commit(branchId, base(store, branchId), state, '保存章末选择'); return { view, saved };
}

describe('manual prose edits on the current story line', () => {
  it('preserves later chapters, materials and other lines, and refreshes every affected reader boundary', () => {
    const { store, project, branchId, first, third } = story(); const old = store.state(branchId);
    const sibling = store.fork(branchId, { baseRevisionId: base(store, branchId), name: '保留正文' });
    const original = old.chapters[0]; const originalText = store.chapter(branchId, original.id).text;
    const changed = store.saveChapter(branchId, { baseRevisionId: base(store, branchId), chapterId: original.id, title: '河岸新标题', text: `新增开场。\n${originalText}` });
    expect(changed.branch.id).toBe(branchId); expect(store.listBranches(project.id)).toHaveLength(2);
    expect(changed.state.chapters.slice(1)).toEqual(old.chapters.slice(1));
    expect(changed.state.chapters[0]).toMatchObject({ status: 'ready', summary: original.summary });
    expect(changed.state.entities.map(entity => entity.name)).toEqual(old.entities.map(entity => entity.name));
    const target = changed.state.chapters[0].id; expect(target).not.toBe(original.id);
    const reader = store.view(branchId, false, target);
    expect(reader.state.entities.map(entity => entity.name)).toEqual(store.view(sibling.branch.id, false, original.id).state.entities.map(entity => entity.name));
    expect(reader.state.entities.flatMap(entity => entity.facts).every(fact => !fact.citation || fact.citation.chapterId === target)).toBe(true);
    expect(reader.state.entities[0].facts[0].citation?.paragraph).toBe(2);
    expect(reader.state.entities.map(entity => entity.name)).not.toContain('秘密看守'); expect(reader.state.entities.map(entity => entity.name)).not.toContain('未来战役');
    expect(reader.state.entities.every(entity => entity.visibility === 'public' && entity.facts.every(fact => fact.visibility === 'public' && fact.temporal !== 'future'))).toBe(true);
    expect(store.view(branchId, false, old.chapters[1].id).state.entities.map(entity => entity.name)).toContain('阿岚');
    expect(store.chapter(sibling.branch.id, original.id).text).toBe(originalText);
    expect(store.revisionState(third.branch.revisionId)).toEqual(old);
    const fork = store.fork(branchId, { baseRevisionId: changed.branch.revisionId, chapterId: target, name: '从新正文出发' });
    expect(fork.state.chapters).toHaveLength(1); expect(fork.state.chapters[0].id).toBe(target);
    expect(store.chapter(fork.branch.id, target).text).toContain('新增开场');
    const restored = store.restoreProject(store.exportProject(project.id));
    expect(store.state(restored.mainBranchId).chapters).toHaveLength(3);
    store.rollback(branchId, { baseRevisionId: changed.branch.revisionId, revisionId: third.branch.revisionId });
    expect(store.state(branchId)).toEqual(old); expect(store.chapter(branchId, original.id).text).toBe(originalText);
    expect(first.state.chapters[0].id).toBe(original.id);
  });

  it('preserves facts with removed quotes, chapter summaries, clues and compression without inventing citations', () => {
    const { store, branchId } = story(); const old = store.state(branchId); const target = old.chapters[1].id;
    old.outline.summaryCompression = { text: '旅人继续调查。', chapterIds: old.chapters.map(chapter => chapter.id) };
    old.foreshadows.push({ id: 'clue', title: '银灯', detail: '作者答案', status: 'planted', plantedChapterId: target, revealCondition: '以后揭晓', relatedEntityIds: [] });
    const current = store.commit(branchId, base(store, branchId), old, '添加作者记录');
    const result = store.saveChapter(branchId, { baseRevisionId: current.branch.revisionId, chapterId: target, title: '第二章 新正文', text: '没有原先的引用片段。' });
    const replacement = result.state.chapters[1];
    expect(result.state.chapters.map(chapter => chapter.summary)).toEqual(old.chapters.map(chapter => chapter.summary));
    expect(result.state.entities.flatMap(entity => entity.facts).map(fact => fact.text)).toEqual(old.entities.flatMap(entity => entity.facts).map(fact => fact.text));
    expect(result.state.entities.flatMap(entity => entity.facts).some(fact => fact.citation?.chapterId === target)).toBe(false);
    expect(result.state.relations.map(relation => relation.label)).toEqual(old.relations.map(relation => relation.label));
    expect(result.state.foreshadows[0].plantedChapterId).toBe(replacement.id);
    expect(result.state.outline.summaryCompression).toEqual({ text: '旅人继续调查。', chapterIds: result.state.chapters.map(chapter => chapter.id) });
    expect(() => store.restoreProject(store.exportProject(store.getBranch(branchId).projectId))).not.toThrow();
  });

  it('keeps CGs and their enabled selection after prose changes while preserving their original evidence', () => {
    const { store, project, branchId, third } = story(); const target = third.state.chapters[2].id; const imageId = third.state.imageIds!.at(-1)!;
    const sibling = store.fork(branchId, { baseRevisionId: base(store, branchId), name: '插画保留线' });
    const renamed = store.saveChapter(branchId, { baseRevisionId: base(store, branchId), chapterId: target, title: '灯塔改名', text: store.chapter(branchId, target).text });
    expect(renamed.state.chapters[2].id).toBe(target); expect(renamed.state.imageIds).toContain(imageId);
    expect(store.search(branchId, '灯塔改名', true).chapters.map(chapter => chapter.id)).toContain(target);
    expect(store.search(sibling.branch.id, '灯塔改名', true).chapters).toEqual([]);
    const edited = store.saveChapter(branchId, { baseRevisionId: renamed.branch.revisionId, chapterId: target, title: '灯塔改名', text: '重新编辑后的场景。' });
    expect(edited.state.imageIds).toContain(imageId); expect(edited.state.activeImageIds).toContain(imageId); expect(store.images.content(imageId)).toBeDefined();
    expect(store.images.get(imageId)?.chapterId).toBe(target); expect(edited.state.chapters[2].previousChapterIds).toContain(target);
    expect(store.state(sibling.branch.id).imageIds).toContain(imageId); expect(store.revisionState(third.branch.revisionId).imageIds).toContain(imageId);
    expect(() => store.restoreProject(store.exportProject(project.id))).not.toThrow();
  });

  it('retains pending/failed status and rolls back all prose rows when the edit transaction fails', () => {
    const { store, branchId } = story(); const pending = store.clearChapterExtraction(branchId, base(store, branchId), store.state(branchId).chapters[2].id);
    const target = pending.state.chapters[2]; const rows = store.db.prepare('SELECT COUNT(*) AS count FROM chapter_texts').get()!.count;
    expect(() => store.saveChapter(branchId, { baseRevisionId: pending.branch.revisionId, chapterId: target.id, title: target.title, text: '回滚的正文。' }, () => { throw new Error('模拟提交失败'); })).toThrow('模拟提交失败');
    expect(base(store, branchId)).toBe(pending.branch.revisionId); expect(store.db.prepare('SELECT COUNT(*) AS count FROM chapter_texts').get()!.count).toBe(rows);
    const saved = store.saveChapter(branchId, { baseRevisionId: pending.branch.revisionId, chapterId: target.id, title: target.title, text: '手动保存的正文。' });
    expect(saved.state.chapters[2].status).toBe('pending');
    expect(() => store.saveChapter(branchId, { baseRevisionId: pending.branch.revisionId, chapterId: saved.state.chapters[2].id, title: target.title, text: '过期修改。' })).toThrow('新版本');
  });

  it('keeps a chapter-end choice for a title edit and invalidates it after changing prose', () => {
    const { store, project, branchId } = story(); const { view } = chapterChoice(store, branchId); const target = view.state.chapters.at(-1)!;
    const renamed = store.saveChapter(branchId, { baseRevisionId: view.branch.revisionId, chapterId: target.id, title: '章末新标题', text: store.chapter(branchId, target.id).text });
    expect(renamed.state.rpg?.nextChoice).toEqual(view.state.rpg?.nextChoice);
    const edited = store.saveChapter(branchId, { baseRevisionId: renamed.branch.revisionId, chapterId: target.id, title: '章末新标题', text: '新的剧情节点。' });
    expect(edited.state.rpg?.nextChoice).toBeUndefined(); expect(store.revisionState(view.branch.revisionId).rpg?.nextChoice).toBeDefined();
    expect(() => store.restoreProject(store.exportProject(project.id))).not.toThrow();
  });

  it('searches current titles without leaking sibling titles or dropping case-insensitive prose matches', () => {
    const { store, branchId } = story();
    const saved = store.saveChapter(branchId, { baseRevisionId: base(store, branchId), title: '旧章节标题', text: `${'中性开场。'.repeat(60)}\nThe LIGHTHOUSE is open.` });
    const target = saved.state.chapters.at(-1)!;
    const ready = store.applyExtraction(branchId, saved.branch.revisionId, target.id, { summary: '灯塔开放。', entities: [], relations: [], foreshadows: [] }, true);
    const sibling = store.fork(branchId, { baseRevisionId: ready.branch.revisionId, name: '旧标题线' });
    store.saveChapter(branchId, { baseRevisionId: ready.branch.revisionId, chapterId: target.id, title: '新章节标题', text: store.chapter(branchId, target.id).text });
    expect(store.search(branchId, '新章节标题').chapters.map(chapter => chapter.id)).toContain(target.id);
    expect(store.search(branchId, '旧章节标题').chapters).toEqual([]);
    expect(store.search(sibling.branch.id, '旧章节标题').chapters.map(chapter => chapter.id)).toContain(target.id);
    expect(store.search(branchId, 'lighthouse').chapters.map(chapter => chapter.id)).toContain(target.id);
  });
});

describe('deleting story branches without breaking retained history', () => {
  it('deletes a parent while keeping its live child, historical reading, original references and backup usable', () => {
    const { store, project, branchId, first } = story();
    const parent = store.fork(branchId, { baseRevisionId: base(store, branchId), name: '待删除父线' });
    const state = store.state(parent.branch.id); delete state.sourceReference;
    const own = store.commit(parent.branch.id, parent.branch.revisionId, state, '固定父线原作');
    const child = store.fork(parent.branch.id, { baseRevisionId: own.branch.revisionId, name: '保留子线' });
    expect(child.state.sourceReference?.branchId).toBe(parent.branch.id);
    const deleted = store.deleteBranch(parent.branch.id, own.branch.revisionId);
    expect(deleted).toEqual({ ok: true, mainBranchId: branchId });
    expect(store.listBranches(project.id).map(branch => branch.name)).toEqual(['主线', '保留子线']);
    expect(() => store.view(parent.branch.id, true)).toThrow('已删除');
    expect(store.view(child.branch.id, false, first.state.chapters[0].id).state.entities.length).toBeGreaterThan(0);
    expect(store.originalReference(child.branch.id, child.state.sourceReference!).chapters).toHaveLength(3);
    expect(store.state(branchId).chapters).toHaveLength(3);
    const fork = store.fork(child.branch.id, { baseRevisionId: child.branch.revisionId, chapterId: first.state.chapters[0].id, name: '保留历史起点' }); expect(fork.state.chapters).toHaveLength(1);
    const restored = store.restoreProject(store.exportProject(project.id));
    expect(store.listBranches(restored.id).map(branch => branch.name)).not.toContain('待删除父线');
    const restoredChild = store.listBranches(restored.id).find(branch => branch.name === '保留子线')!;
    expect(store.originalReference(restoredChild.id, store.state(restoredChild.id).sourceReference!).chapters).toHaveLength(3);
    const backup = store.exportProject(restored.id); expect(backup.branches.find(branch => branch.name === '待删除父线')?.deletedAt).toBeDefined();
  });

  it('resolves a legacy child reference through a deleted parent without reviving that parent', () => {
    const { store, project, branchId } = story(); const parent = store.fork(branchId, { baseRevisionId: base(store, branchId), name: '旧父线' });
    const state = store.state(parent.branch.id); delete state.sourceReference;
    store.commit(parent.branch.id, parent.branch.revisionId, state, '旧父线快照');
    const child = store.fork(parent.branch.id, { baseRevisionId: base(store, parent.branch.id), name: '旧子线' });
    const legacy = store.state(child.branch.id); delete legacy.sourceReference; store.commit(child.branch.id, child.branch.revisionId, legacy, '旧子线快照');
    store.deleteBranch(parent.branch.id, base(store, parent.branch.id));
    const reference = store.resolveSourceReference(child.branch.id)!;
    expect(store.originalReference(child.branch.id, reference).chapters).toHaveLength(3);
    expect(store.listBranches(project.id)).toHaveLength(2);
  });

  it('protects the main line and rejects stale versions, unknown branches and unfinished work', () => {
    const { store, branchId } = story(); const parent = store.fork(branchId, { baseRevisionId: base(store, branchId), name: '待删除' });
    expect(() => store.deleteBranch(branchId, base(store, branchId))).toThrow('主线不能删除');
    expect(() => store.deleteBranch(parent.branch.id, 'old')).toThrow('新版本'); expect(() => store.deleteBranch('missing', 'missing')).toThrow('不存在');
    const pending = job(store, parent.branch.id, 'paused'); expect(() => store.deleteBranch(parent.branch.id, base(store, parent.branch.id))).toThrow('取消');
    const engine = new StoryEngine(store, () => settings); cleanup.push(() => engine.close()); engine.action(pending.id, 'cancel');
    const image = store.images.all()[0]; store.images.insert({ ...image, id: randomUUID(), branchId: parent.branch.id, status: 'paused' });
    expect(() => store.deleteBranch(parent.branch.id, base(store, parent.branch.id))).toThrow('生图任务');
  });

  it('hides deleted-branch jobs and refuses retry, while preserving them for full backup', () => {
    const { store, project, branchId } = story(); const parent = store.fork(branchId, { baseRevisionId: base(store, branchId), name: '任务分支' }); const failed = job(store, parent.branch.id);
    const engine = new StoryEngine(store, () => settings); cleanup.push(() => engine.close());
    expect(engine.listJobs(project.id).map(job => job.id)).toContain(failed.id);
    store.deleteBranch(parent.branch.id, parent.branch.revisionId);
    expect(engine.listJobs(project.id)).toEqual([]); expect(() => engine.action(failed.id, 'retry')).toThrow('已删除');
    expect(store.exportProject(project.id).jobs.map(job => job.id)).toContain(failed.id);
    const malformed = store.exportProject(project.id); malformed.branches.find(branch => branch.id === project.mainBranchId)!.deletedAt = new Date().toISOString();
    expect(() => store.restoreProject(malformed)).toThrow('无效关联');
  });

  it('lets a live child answer an inherited chapter-end choice whose completed owner job belongs to a deleted parent', () => {
    const { store, project, branchId } = story(); const parent = store.fork(branchId, { baseRevisionId: base(store, branchId), name: 'RPG 父线' });
    const { view, saved } = chapterChoice(store, parent.branch.id);
    const child = store.fork(parent.branch.id, { baseRevisionId: view.branch.revisionId, name: 'RPG 子线' });
    store.deleteBranch(parent.branch.id, view.branch.revisionId);
    expect(() => store.restoreProject(store.exportProject(project.id))).not.toThrow();
    const engine = new StoryEngine(store, () => settings); cleanup.push(() => engine.close());
    const next = engine.choose(saved.id, { branchId: child.branch.id, baseRevisionId: child.branch.revisionId, choiceId: 'chapter-choice', optionId: 'a' });
    expect(next.branchId).toBe(child.branch.id); expect(store.state(child.branch.id).rpg?.nextChoice).toBeUndefined();
    expect(engine.listJobs(project.id).map(job => job.id)).not.toContain(saved.id);
  });
});

describe('branch deletion and manual editing HTTP contracts', () => {
  async function context() {
    const ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'novel-branch-api-')), initialPassword: 'branch-password-123', startEngine: false }); cleanup.push(() => ctx.app.close());
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'branch-password-123' } }); const session = login.cookies.find(cookie => cookie.name === 'session')!.value;
    return { ...ctx, session, ...readingProgressStory(ctx.store) };
  }

  it('saves early and latest edits on the same line without scheduling extraction, then supports explicit reextraction', async () => {
    const { store, app, engine, session, branchId, third } = await context(); const enqueue = vi.spyOn(engine, 'enqueue');
    for (const index of [0, 2]) {
      const target = store.state(branchId).chapters[index];
      const result = await app.inject({ method: 'POST', url: `/api/branches/${branchId}/chapters?view=author`, cookies: { session }, payload: { baseRevisionId: base(store, branchId), chapterId: target.id, title: target.title, text: `${store.chapter(branchId, target.id).text}\n手动补充。` } });
      expect(result.statusCode).toBe(200); expect(result.json().branch.id).toBe(branchId); expect(result.json().state.chapters).toHaveLength(3); expect(result.json().state.chapters[index].status).toBe('ready');
    }
    expect(enqueue).not.toHaveBeenCalled(); expect(engine.listJobs()).toEqual([]);
    expect(store.state(branchId).chapters.map(chapter => chapter.summary)).toEqual(third.state.chapters.map(chapter => chapter.summary));
    const target = store.state(branchId).chapters[0].id;
    const explicit = await app.inject({ method: 'POST', url: `/api/branches/${branchId}/chapters/${target}/extract?view=author`, cookies: { session }, payload: { baseRevisionId: base(store, branchId) } });
    expect(explicit.statusCode).toBe(400); expect(explicit.json().error).toContain('供应商');
    expect(store.state(branchId).chapters[0].status).toBe('ready');
  });

  it('requires login, a current revision and finished tasks for deletion and editing', async () => {
    const { store, app, engine, session, branchId } = await context(); const fork = store.fork(branchId, { baseRevisionId: base(store, branchId), name: 'HTTP 分支' });
    const deleteUrl = `/api/branches/${fork.branch.id}`; const target = store.state(branchId).chapters[0];
    const routes = [{ method: 'DELETE' as const, url: deleteUrl, payload: { baseRevisionId: fork.branch.revisionId } }, { method: 'POST' as const, url: `/api/branches/${branchId}/chapters`, payload: { baseRevisionId: base(store, branchId), chapterId: target.id, title: target.title, text: '手动修改。' } }];
    for (const route of routes) {
      expect((await app.inject({ ...route, url: `${route.url}?view=author` })).statusCode).toBe(401);
      expect((await app.inject({ ...route, cookies: { session }, payload: { ...route.payload, baseRevisionId: 'old' } })).statusCode).toBe(409);
      expect((await app.inject({ ...route, url: `${route.url}?view=author`, cookies: { session }, payload: { ...route.payload, baseRevisionId: 'old' } })).statusCode).toBe(409);
    }
    const waiting = job(store, fork.branch.id, 'paused');
    expect((await app.inject({ ...routes[0], url: `${deleteUrl}?view=author`, cookies: { session } })).statusCode).toBe(409);
    engine.action(waiting.id, 'cancel');
    expect((await app.inject({ ...routes[0], cookies: { session } })).statusCode).toBe(200);
    expect((await app.inject({ url: `${deleteUrl}?view=author`, cookies: { session } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/branches/${branchId}?view=author`, cookies: { session }, payload: { baseRevisionId: base(store, branchId) } })).statusCode).toBe(409);
  });
});
