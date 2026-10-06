import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { Store } from '../server/store.js';
import type { ExtractionResult, Job, ModelRequest, PlanningResult, Settings } from '../shared/types.js';

const renameFailure = vi.hoisted(() => ({ blockedPath: undefined as string | undefined, stagedMoves: 0 }));
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    renameSync: (from: Parameters<typeof original.renameSync>[0], to: Parameters<typeof original.renameSync>[1]) => {
      if (String(from) === renameFailure.blockedPath) throw Object.assign(new Error('模拟原文文件被占用'), { code: 'EACCES' });
      original.renameSync(from, to);
      if (renameFailure.blockedPath && String(to).includes('deleted-sources')) renameFailure.stagedMoves++;
    },
  };
});

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const stores: Store[] = [];
const engines: StoryEngine[] = [];
afterEach(async () => {
  renameFailure.blockedPath = undefined;
  renameFailure.stagedMoves = 0;
  for (const engine of engines.splice(0)) await engine.close();
  for (const ctx of apps.splice(0)) await ctx.app.close();
  for (const store of stores.splice(0)) store.close();
});

function makeStore() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ai-novel-delete-store-')));
  stores.push(store);
  return store;
}
async function makeApp() {
  const ctx = await buildApp({ initialPassword: 'delete-novel-test-password', dataDir: mkdtempSync(join(tmpdir(), 'ai-novel-delete-api-')), startEngine: false });
  apps.push(ctx);
  const loginResponse = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'delete-novel-test-password' } });
  expect(loginResponse.statusCode).toBe(200);
  return { ...ctx, cookies: { session: loginResponse.cookies.find(cookie => cookie.name === 'session')!.value } };
}
function form(filename: string, text: string) {
  const boundary = 'project-deletion-test-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${text}\r\n--${boundary}--\r\n`),
  };
}
const emptyExtraction = (): ExtractionResult => ({ summary: '已经发生的剧情', entities: [], relations: [], foreshadows: [] });
function append(store: Store, branchId: string, text: string, sourceId?: string) {
  const branch = store.getBranch(branchId);
  const state = store.state(branchId);
  const chapter = store.putChapter('测试章节', text, sourceId);
  state.chapters.push(chapter);
  const saved = store.commit(branchId, branch.revisionId, state, '保存测试正文');
  return store.applyExtraction(branchId, saved.branch.revisionId, chapter.id, emptyExtraction(), true);
}
const settings = (): Settings => ({
  providers: [{ id: 'fixture', name: '本地模拟模型', protocol: 'openai-chat', baseUrl: 'http://unused.invalid/v1', model: 'fixture', maxOutputTokens: 1024, contextTokens: 64000 }],
  writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture',
});
const plan = (next = 1): PlanningResult => ({ coarse: '旅人寻找归途', fine: Array.from({ length: 4 }, (_, index) => ({ chapter: next + index, title: `第 ${next + index} 章`, goal: '继续寻找线索' })), foreshadows: [] });
function engineFor(store: Store, models: TextModels = {
  generateText: async () => ({ text: '模拟正文', inputTokens: 10, outputTokens: 10 }),
  generateStructured: async (_provider, _request, validate) => ({ value: validate(plan()), inputTokens: 10, outputTokens: 10 }),
}) {
  const engine = new StoryEngine(store, settings, models);
  engines.push(engine);
  return engine;
}
function setJobStatus(store: Store, job: Job, status: Job['status']) {
  const row = JSON.parse(String(store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data)) as Job;
  row.status = status;
  store.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(status, JSON.stringify(row), job.id);
}
function count(store: Store, table: string, column?: string, value?: string) {
  const sql = `SELECT count(*) AS total FROM ${table}${column ? ` WHERE ${column}=?` : ''}`;
  return Number(store.db.prepare(sql).get(...(column ? [value!] : []))!.total);
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待删除测试状态超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('novel deletion', () => {
  it('deletes original files, all branches and snapshots, prose, search rows, jobs and outputs while preserving another novel', async () => {
    const ctx = await makeApp();
    const project = ctx.store.createProject({ title: '要删除的小说', premise: '隐藏设定' });
    const keep = ctx.store.createProject({ title: '保留的小说' });
    const upload = await ctx.app.inject({ method: 'POST', url: `/api/projects/${project.id}/import`, cookies: ctx.cookies, ...form('original.txt', '第一章\n阿青来到江城。\n第二章\n阿青离开江城。') });
    expect(upload.statusCode).toBe(200);
    const imported = upload.json();
    const confirmed = await ctx.app.inject({ method: 'POST', url: `/api/sources/${imported.source.id}/confirm`, cookies: ctx.cookies, payload: { branchId: project.mainBranchId, baseRevisionId: ctx.store.getBranch(project.mainBranchId).revisionId, chapters: imported.chapters } });
    expect(confirmed.statusCode).toBe(200);
    const keepUpload = await ctx.app.inject({ method: 'POST', url: `/api/projects/${keep.id}/import`, cookies: ctx.cookies, ...form('keep.txt', '第一章\n另一位旅人的故事。') });
    expect(keepUpload.statusCode).toBe(200);
    const keepSource = keepUpload.json().source;
    const first = append(ctx.store, project.mainBranchId, '阿青来到江城。', imported.source.id);
    let view = ctx.store.updateEntity(project.mainBranchId, first.branch.revisionId, { id: 'human-character', name: '阿青', kind: 'character', aliases: [], description: '用户确认的旅人', visibility: 'public', locked: true, facts: [] });
    view = ctx.store.updateForeshadows(project.mainBranchId, view.branch.revisionId, [{ id: 'clue', title: '归途', detail: '隐藏计划', status: 'planted', plantedChapterId: first.state.chapters[0].id, revealCondition: '旅程结束', relatedEntityIds: [view.state.entities[0].id] }]);
    const fork = ctx.store.fork(project.mainBranchId, { baseRevisionId: view.branch.revisionId, chapterId: first.state.chapters[0].id, name: '另一个结局' });
    append(ctx.store, fork.branch.id, '分支独有正文。');
    const second = append(ctx.store, project.mainBranchId, '阿青离开江城。', imported.source.id);
    const revised = ctx.store.saveChapter(project.mainBranchId, { baseRevisionId: second.branch.revisionId, chapterId: first.state.chapters[0].id, title: '历史改写', text: '阿青去了山城。' });
    expect(revised.branch.id).not.toBe(project.mainBranchId);
    ctx.store.rollback(project.mainBranchId, { baseRevisionId: second.branch.revisionId, revisionId: first.branch.revisionId });

    // A legacy snapshot can exist outside the current parent chain. Deletion must inspect all rows owned by each branch.
    const oldBranch = ctx.store.getBranch(fork.branch.id);
    const detached = append(ctx.store, fork.branch.id, '脱离当前历史的正文。');
    ctx.store.db.prepare('UPDATE branches SET data=? WHERE id=?').run(JSON.stringify(oldBranch), oldBranch.id);
    expect(ctx.store.history(fork.branch.id).map(revision => revision.id)).not.toContain(detached.branch.revisionId);
    const targetBranches = ctx.store.listBranches(project.id).map(branch => branch.id);
    const targetRevisions = ctx.store.db.prepare('SELECT id FROM revisions WHERE branch_id IN (SELECT id FROM branches WHERE project_id=?)').all(project.id).map(row => String(row.id));
    const targetChapters = new Set(targetRevisions.flatMap(revisionId => ctx.store.revisionState(revisionId).chapters.map(chapter => chapter.id)));
    const extraJob = ctx.engine.enqueue(fork.branch.id, 'plan', { baseRevisionId: oldBranch.revisionId });
    ctx.store.outputs.create({ projectId: project.id, branchId: fork.branch.id, jobId: extraJob.id, baseRevisionId: oldBranch.revisionId, stage: 'planning' }, { rawResponse: '{"fixture":true}', text: '{"fixture":true}', inputTokens: 10, outputTokens: 10 });
    const keepView = append(ctx.store, keep.mainBranchId, '保留小说的独有正文。', keepSource.id);
    const keepJob = ctx.engine.enqueue(keep.mainBranchId, 'plan', { baseRevisionId: keepView.branch.revisionId });
    ctx.store.outputs.create({ projectId: keep.id, branchId: keep.mainBranchId, jobId: keepJob.id, baseRevisionId: keepView.branch.revisionId, stage: 'planning' }, { rawResponse: '保留的输出', text: '保留的输出', inputTokens: 10, outputTokens: 10 });
    const keepBackup = ctx.store.exportProject(keep.id);

    const deleted = await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, cookies: ctx.cookies });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect(() => ctx.store.getProject(project.id)).toThrow('作品不存在');
    for (const branchId of targetBranches) expect(count(ctx.store, 'branches', 'id', branchId)).toBe(0);
    for (const revisionId of targetRevisions) expect(count(ctx.store, 'revisions', 'id', revisionId)).toBe(0);
    for (const chapterId of targetChapters) {
      expect(count(ctx.store, 'chapter_texts', 'id', chapterId)).toBe(0);
      expect(count(ctx.store, 'chapter_search', 'id', chapterId)).toBe(0);
    }
    for (const table of ['jobs', 'model_outputs', 'sources']) expect(count(ctx.store, table, 'project_id', project.id)).toBe(0);
    expect(count(ctx.store, 'job_import_chapters', 'job_id', confirmed.json().id)).toBe(0);
    expect(existsSync(join(ctx.store.dataDir, 'sources', imported.source.id))).toBe(false);
    expect(readdirSync(join(ctx.store.dataDir, 'sources'))).toEqual([keepSource.id]);
    expect(ctx.store.exportProject(keep.id)).toEqual(keepBackup);
    expect((await ctx.app.inject({ url: `/api/sources/${keepSource.id}/file`, cookies: ctx.cookies })).statusCode).toBe(200);
    expect((await ctx.app.inject({ url: `/api/sources/${imported.source.id}/file`, cookies: ctx.cookies })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: `/api/branches/${project.mainBranchId}?view=author`, cookies: ctx.cookies })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: `/api/jobs/${extraJob.id}/outputs?view=author`, cookies: ctx.cookies })).statusCode).toBe(404);
  });

  it('preserves shared prose and search records referenced by another novel historical snapshot', () => {
    const store = makeStore();
    const project = store.createProject({ title: '删除共享原作品' });
    const keep = store.createProject({ title: '保留共享章节作品' });
    const view = append(store, project.mainBranchId, '共同引用的一段正文。');
    const sharedChapter = view.state.chapters[0];
    const initial = store.getBranch(keep.mainBranchId).revisionId;
    const state = store.state(keep.mainBranchId); state.chapters.push(sharedChapter);
    const shared = store.commit(keep.mainBranchId, initial, state, '历史引用共享正文');
    store.rollback(keep.mainBranchId, { baseRevisionId: shared.branch.revisionId, revisionId: initial });
    expect(store.state(keep.mainBranchId).chapters).toHaveLength(0);
    const keepBackup = store.exportProject(keep.id);

    store.deleteProject(project.id);

    expect(store.exportProject(keep.id)).toEqual(keepBackup);
    expect(store.revisionState(shared.branch.revisionId).chapters).toEqual([sharedChapter]);
    expect(count(store, 'chapter_texts', 'id', sharedChapter.id)).toBe(1);
    expect(count(store, 'chapter_search', 'id', sharedChapter.id)).toBe(1);
    store.deleteProject(keep.id);
    expect(count(store, 'chapter_texts')).toBe(0);
    expect(count(store, 'chapter_search')).toBe(0);
  });

  it('rolls the entire deletion and its SQL cleanup callback back when cleanup fails', () => {
    const store = makeStore();
    const project = store.createProject({ title: '删除事务' });
    const view = append(store, project.mainBranchId, '不能在删除失败时丢掉正文。');
    const fork = store.fork(project.mainBranchId, { baseRevisionId: view.branch.revisionId, name: '分支' });
    const engine = engineFor(store);
    const job = engine.enqueue(fork.branch.id, 'import', { baseRevisionId: fork.branch.revisionId, chapters: [{ title: '待导入', text: '队列原文不能丢失。' }] });
    store.outputs.create({ projectId: project.id, branchId: fork.branch.id, jobId: job.id, baseRevisionId: fork.branch.revisionId, stage: 'extraction' }, { rawResponse: '完整模型响应', text: '模型正文', inputTokens: 10, outputTokens: 20 });
    store.db.exec('CREATE TABLE test_sources(id TEXT PRIMARY KEY, project_id TEXT NOT NULL)');
    store.db.prepare('INSERT INTO test_sources VALUES(?,?)').run('original-source', project.id);
    const tables = ['projects', 'branches', 'revisions', 'chapter_texts', 'chapter_search', 'jobs', 'job_import_chapters', 'model_outputs', 'test_sources'];
    const snapshot = () => Object.fromEntries(tables.map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();

    expect(() => store.deleteProject(project.id, () => {
      store.db.prepare('DELETE FROM test_sources WHERE project_id=?').run(project.id);
      throw new Error('模拟原文清理失败');
    })).toThrow('模拟原文清理失败');
    expect(snapshot()).toEqual(before);
    expect(store.exportText(project.mainBranchId)).toContain('不能在删除失败时丢掉正文');
    store.deleteProject(project.id, () => { store.db.prepare('DELETE FROM test_sources WHERE project_id=?').run(project.id); });
    expect(count(store, 'test_sources')).toBe(0);
    expect(store.listProjects()).toEqual([]);
  });

  it('requires login and a matching origin, reports a missing novel, and can delete the last empty novel', async () => {
    const ctx = await makeApp();
    const project = ctx.store.createProject({ title: '最后一本空小说' });
    const url = `/api/projects/${project.id}`;
    expect((await ctx.app.inject({ method: 'DELETE', url })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'DELETE', url, cookies: ctx.cookies, headers: { origin: 'https://untrusted.invalid' } })).statusCode).toBe(403);
    expect(ctx.store.getProject(project.id)).toEqual(project);
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/projects/missing-novel', cookies: ctx.cookies })).statusCode).toBe(404);
    const response = await ctx.app.inject({ method: 'DELETE', url, cookies: ctx.cookies, headers: { origin: 'http://localhost:5173' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect((await ctx.app.inject({ url: '/api/projects', cookies: ctx.cookies })).json()).toEqual([]);
    expect((await ctx.app.inject({ method: 'DELETE', url, cookies: ctx.cookies })).statusCode).toBe(404);
    for (const table of ['projects', 'branches', 'revisions', 'chapter_texts', 'chapter_search', 'jobs', 'model_outputs', 'sources']) expect(count(ctx.store, table)).toBe(0);
  });

  it('restores already moved originals and SQL records when a later original cannot be staged', async () => {
    const ctx = await makeApp();
    const project = ctx.store.createProject({ title: '原文文件清理失败' });
    append(ctx.store, project.mainBranchId, '删除失败时正文仍然存在。');
    for (const [filename, text] of [['first.txt', '第一章\n先移动的原文。'], ['second.txt', '第一章\n被占用的原文。']]) {
      const upload = await ctx.app.inject({ method: 'POST', url: `/api/projects/${project.id}/import`, cookies: ctx.cookies, ...form(filename, text) });
      expect(upload.statusCode).toBe(200);
    }
    const sourceRows = ctx.store.db.prepare('SELECT * FROM sources WHERE project_id=? ORDER BY rowid').all(project.id);
    const sourcePaths = sourceRows.map(row => join(ctx.store.dataDir, 'sources', String(row.storage_name)));
    const bytes = sourcePaths.map(path => readFileSync(path));
    const before = ctx.store.exportProject(project.id);
    renameFailure.blockedPath = sourcePaths[1];

    const failure = await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, cookies: ctx.cookies });

    expect(failure.statusCode).toBe(500);
    expect(renameFailure.stagedMoves).toBe(1);
    expect(ctx.store.exportProject(project.id)).toEqual(before);
    expect(ctx.store.db.prepare('SELECT * FROM sources WHERE project_id=? ORDER BY rowid').all(project.id)).toEqual(sourceRows);
    for (const [index, path] of sourcePaths.entries()) expect(readFileSync(path)).toEqual(bytes[index]);
    expect(readdirSync(join(ctx.store.dataDir, 'deleted-sources'))).toEqual([]);
    renameFailure.blockedPath = undefined;
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, cookies: ctx.cookies })).statusCode).toBe(200);
    for (const path of sourcePaths) expect(existsSync(path)).toBe(false);
  });

  it('recovers referenced originals and finishes deleting unreferenced staged files after a restart', async () => {
    const ctx = await makeApp();
    const project = ctx.store.createProject({ title: '中断后恢复原文' });
    const contents = '第一章\n服务中断前已经上传的原文。';
    const upload = await ctx.app.inject({ method: 'POST', url: `/api/projects/${project.id}/import`, cookies: ctx.cookies, ...form('original.txt', contents) });
    expect(upload.statusCode).toBe(200);
    const source = upload.json().source;
    const deletionRoot = join(ctx.store.dataDir, 'deleted-sources');
    mkdirSync(deletionRoot);
    const staging = mkdtempSync(join(deletionRoot, 'delete-'));
    const original = join(ctx.store.dataDir, 'sources', source.id);
    renameSync(original, join(staging, source.id));
    writeFileSync(join(staging, 'deleted-original'), '已提交删除但还未清理的原文');
    const directory = ctx.store.dataDir;
    apps.splice(apps.findIndex(current => current.app === ctx.app), 1);
    await ctx.app.close();

    const reopened = await buildApp({ initialPassword: 'delete-novel-test-password', dataDir: directory, startEngine: false });
    apps.push(reopened);

    expect(readFileSync(original, 'utf8')).toBe(contents);
    expect(existsSync(staging)).toBe(false);
    expect(readdirSync(join(directory, 'sources'))).toEqual([source.id]);
    const download = await reopened.app.inject({ url: `/api/sources/${source.id}/file`, cookies: ctx.cookies });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe(contents);
    expect(reopened.store.getProject(project.id).title).toBe(project.title);
  });

  it('aborts and waits for running generation, blocks new or resumed work, and ignores late output after deletion', async () => {
    const store = makeStore();
    const project = store.createProject({ title: '删除时仍在生成' });
    const keep = store.createProject({ title: '独立小说继续工作' });
    const deletedReady = append(store, project.mainBranchId, '删除前已经完成的正文。');
    const keepReady = append(store, keep.mainBranchId, '保留作品已经完成的正文。');
    const prepared = store.updateOutline(project.mainBranchId, store.getBranch(project.mainBranchId).revisionId, { ...plan(), locked: '' });
    const pausedBranch = store.fork(project.mainBranchId, { baseRevisionId: prepared.branch.revisionId, name: '暂停分支' });
    const failedBranch = store.fork(project.mainBranchId, { baseRevisionId: prepared.branch.revisionId, name: '失败分支' });
    const queuedBranch = store.fork(project.mainBranchId, { baseRevisionId: prepared.branch.revisionId, name: '排队分支' });
    const gate = deferred<{ text: string; inputTokens: number; outputTokens: number }>();
    let request: ModelRequest | undefined;
    const engine = engineFor(store, {
      generateText: async (_provider, incoming) => { request = incoming; return gate.promise; },
      generateStructured: async (_provider, _request, validate) => ({ value: validate(plan(2)), inputTokens: 10, outputTokens: 10 }),
    });
    const paused = engine.enqueue(pausedBranch.branch.id, 'plan', { baseRevisionId: pausedBranch.branch.revisionId });
    engine.action(paused.id, 'pause');
    const failed = engine.enqueue(failedBranch.branch.id, 'plan', { baseRevisionId: failedBranch.branch.revisionId });
    setJobStatus(store, failed, 'failed');
    const writing = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: prepared.branch.revisionId, mode: 'original', instruction: '模拟写作' });
    engine.start();
    await until(() => Boolean(request));
    const queued = engine.enqueue(queuedBranch.branch.id, 'import', { baseRevisionId: queuedBranch.branch.revisionId, chapters: [{ title: '未开始的导入', text: '不应开始整理。' }] });
    let finished = false;
    const deleting = engine.deleteProject(project.id).then(() => { finished = true; });
    try {
      await Promise.resolve();
      expect(request!.signal!.aborted).toBe(true);
      expect(finished).toBe(false);
      expect(store.getProject(project.id)).toMatchObject({ id: project.id, title: project.title });
      const active = engine.listJobs(project.id);
      for (const job of [writing, paused, queued]) expect(active.find(current => current.id === job.id)?.status).toBe('cancelled');
      expect(() => engine.enqueue(queuedBranch.branch.id, 'plan', { baseRevisionId: queuedBranch.branch.revisionId })).toThrow(expect.objectContaining({ statusCode: 409 }));
      expect(() => engine.action(paused.id, 'resume')).toThrow(expect.objectContaining({ statusCode: 409 }));
      expect(() => engine.action(failed.id, 'retry')).toThrow(expect.objectContaining({ statusCode: 409 }));
      const independent = engine.enqueue(keep.mainBranchId, 'plan', { baseRevisionId: store.getBranch(keep.mainBranchId).revisionId });
      await until(() => engine.listJobs(keep.id).find(job => job.id === independent.id)?.status === 'completed');
      expect(finished).toBe(false);
      // Simulate a provider that receives a response even after its request was aborted.
      request!.onResponse!({ rawResponse: '迟到的正文', text: '迟到的正文', inputTokens: 10, outputTokens: 10 });
    } finally {
      gate.resolve({ text: '迟到的正文', inputTokens: 10, outputTokens: 10 });
      await deleting;
    }
    expect(finished).toBe(true);
    expect(() => store.getProject(project.id)).toThrow('作品不存在');
    expect(engine.listJobs(project.id)).toEqual([]);
    expect(store.outputs.all(project.id)).toEqual([]);
    expect(count(store, 'job_import_chapters', 'job_id', queued.id)).toBe(0);
    expect(count(store, 'chapter_texts')).toBe(1);
    expect(count(store, 'chapter_texts', 'id', deletedReady.state.chapters[0].id)).toBe(0);
    expect(store.chapter(keep.mainBranchId, keepReady.state.chapters[0].id).text).toBe('保留作品已经完成的正文。');
    expect(() => request!.onResponse!({ rawResponse: '更晚的回调', text: '更晚的回调', inputTokens: 10, outputTokens: 10 })).not.toThrow();
    expect(count(store, 'jobs', 'project_id', project.id)).toBe(0);
    expect(count(store, 'model_outputs', 'project_id', project.id)).toBe(0);
    expect(store.listProjects().map(item => item.id)).toEqual([keep.id]);
  });
});
