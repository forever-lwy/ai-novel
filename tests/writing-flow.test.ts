import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { buildApp } from '../server/app.js';
import { buildWritingContext } from '../server/writing-context.js';
import { ModelOutputError } from '../server/providers.js';
import type { ExtractionResult, Job, ModelRequestSnapshot, Settings, WritingEvent } from '../shared/types.js';

const stores: Store[] = []; const engines: StoryEngine[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const ctx of apps.splice(0)) await ctx.app.close(); for (const engine of engines.splice(0)) await engine.close(); for (const store of stores.splice(0)) store.close(); });
const settings = (): Settings => ({ providers: [{ id: 'mock', name: '模拟', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'writer', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'mock', planningProviderId: 'mock', extractionProviderId: 'mock' });
const extraction = (): ExtractionResult => ({ summary: '旅人来到桥边。', entities: [], relations: [], foreshadows: [] });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
async function until<T>(read: () => T, valid: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 3000; for (;;) { const value = read(); if (valid(value)) return value; if (Date.now() > deadline) throw new Error('模拟任务等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const job = (engine: StoryEngine, id: string) => engine.listJobs().find(value => value.id === id)!;
const terminal = (engine: StoryEngine, id: string) => until(() => job(engine, id), value => ['completed', 'failed', 'cancelled', 'stale', 'paused'].includes(value.status));
function harness(models: TextModels, config = settings()) { const store = new Store(mkdtempSync(join(tmpdir(), 'novel-writing-flow-'))); stores.push(store); const project = store.createProject({ title: '流式测试' }); const engine = new StoryEngine(store, () => config, models); engines.push(engine); engine.start(); return { store, project, engine }; }
function mockModels(structured: () => Promise<unknown> = async () => extraction()): TextModels { return { generateText: vi.fn(async (_provider, request) => { request.onTextDelta?.('旅人'); request.onTextDelta?.('来到桥边。'); return { text: '旅人来到桥边。', inputTokens: 10, outputTokens: 12 }; }), generateStructured: vi.fn(async (_provider, _request, validate) => ({ value: validate(await structured()), inputTokens: 3, outputTokens: 4 })) }; }
function start(ctx: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) { return ctx.engine.enqueue(ctx.project.mainBranchId, 'generate', { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, mode: 'original', instruction: '写下一章', ...extra }); }
function readyChapter(store: Store, branchId: string, text: string) { let view = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title: '旧章节', text }); const id = view.state.chapters.at(-1)!.id; view = store.applyExtraction(branchId, view.branch.revisionId, id, { ...extraction(), summary: `${text}的完整剧情摘要。` }, true); return view; }

describe('streaming prose, detached extraction and regeneration', () => {
  const roundSnapshot = (): ModelRequestSnapshot => ({ protocol: 'openai-chat', model: 'writer', url: 'http://unused.invalid/chat/completions', method: 'POST', headers: {}, body: '{}', startedAt: new Date().toISOString(), timeoutMs: 1000, stream: true });

  it('keeps the accumulated multi-round prose beside its immutable final provider response', async () => {
    const models = mockModels();
    models.generateText = vi.fn(async (_provider, request) => {
      request.onRequest?.(roundSnapshot()); request.onTextDelta?.('旅人停在桥边。');
      request.onResponse?.({ rawResponse: 'first tool round', text: '旅人停在桥边。', inputTokens: 10, outputTokens: 2 });
      request.onRequest?.(roundSnapshot()); request.onTextDelta?.('老吴递来一封信。');
      request.onResponse?.({ rawResponse: 'last prose round', text: '老吴递来一封信。', inputTokens: 12, outputTokens: 4 });
      return { text: '旅人停在桥边。老吴递来一封信。', inputTokens: 22, outputTokens: 6 };
    });
    const ctx = harness(models); const writing = start(ctx); expect((await terminal(ctx.engine, writing.id)).status).toBe('completed');
    const output = ctx.store.outputs.get(ctx.engine.listOutputs(writing.id)[0].id)!;
    expect(output).toMatchObject({ status: 'applied', text: '老吴递来一封信。', rawResponse: 'last prose round', normalizedText: '旅人停在桥边。老吴递来一封信。' });
    expect(ctx.store.chapter(ctx.project.mainBranchId, ctx.store.state(ctx.project.mainBranchId).chapters[0].id).text).toBe(output.normalizedText);
  });

  it('lets an author recover accumulated tool-round prose after a later failure without generating it again', async () => {
    const models = mockModels();
    models.generateText = vi.fn(async (_provider, request) => {
      request.onRequest?.(roundSnapshot()); request.onTextDelta?.('旅人停在桥边。');
      request.onResponse?.({ rawResponse: 'first tool round', text: '旅人停在桥边。', inputTokens: 10, outputTokens: 2 });
      request.onRequest?.(roundSnapshot()); request.onTextDelta?.('老吴递来');
      request.onResponse?.({ rawResponse: 'interrupted final round', text: '老吴递来', inputTokens: 12, outputTokens: 4, incomplete: true });
      throw new ModelOutputError('模拟后续工具轮中断', { inputTokens: 22, outputTokens: 6 });
    });
    const ctx = harness(models); const writing = start(ctx); expect((await terminal(ctx.engine, writing.id)).status).toBe('failed');
    const output = ctx.store.outputs.get(ctx.engine.listOutputs(writing.id)[0].id)!;
    expect(output).toMatchObject({ status: 'invalid', text: '老吴递来', rawResponse: 'interrupted final round', normalizedText: '旅人停在桥边。老吴递来' });
    ctx.engine.applyOutput(writing.id, output.id, { baseRevisionId: writing.baseRevisionId, text: `${output.normalizedText}一封信。` });
    expect(ctx.store.chapter(ctx.project.mainBranchId, ctx.store.state(ctx.project.mainBranchId).chapters[0].id).text).toBe('旅人停在桥边。老吴递来一封信。');
    const background = ctx.engine.listJobs().find(value => value.kind === 'extract')!;
    expect(background.status).toBe('paused'); ctx.engine.action(background.id, 'resume');
    expect((await terminal(ctx.engine, background.id)).status).toBe('completed'); expect(models.generateText).toHaveBeenCalledTimes(1);
  });

  it('publishes no successful completion when background-task insertion rolls the chapter transaction back', async () => {
    const ctx = harness(mockModels());
    ctx.store.db.exec("CREATE TRIGGER reject_background BEFORE INSERT ON jobs WHEN json_extract(NEW.data,'$.kind')='extract' BEGIN SELECT RAISE(ABORT,'simulated background insertion failure'); END");
    const writing = start(ctx); const events: WritingEvent[] = []; ctx.engine.subscribeWriting(writing.id, event => events.push(event));
    expect((await terminal(ctx.engine, writing.id)).status).toBe('failed');
    expect(ctx.store.state(ctx.project.mainBranchId).chapters).toHaveLength(0);
    expect(events.some(event => event.type === 'status' && event.job.status === 'completed')).toBe(false);
    expect(ctx.engine.listJobs().filter(value => value.kind === 'extract')).toHaveLength(0);
  });

  it('preserves the rejected chapter plan together with the current later plans on a regeneration branch', async () => {
    const models = mockModels(); const ctx = harness(models);
    const branch = ctx.store.getBranch(ctx.project.mainBranchId);
    ctx.store.updateOutline(branch.id, branch.revisionId, { worldview: '古城世界观', locked: '', fine: [{ chapter: 1, title: '桥边', goal: '发现必须保留的目标章暗号' }, { chapter: 2, title: '追踪', goal: '追踪暗号来源' }] });
    const original = readyChapter(ctx.store, branch.id, '旅人看到旧桥。');
    ctx.store.updateOutline(branch.id, original.branch.revisionId, { worldview: '古城世界观', locked: '', fine: [{ chapter: 2, title: '新追踪安排', goal: '作者修改后的后续规划' }] });
    const writing = start(ctx, { chapterId: original.state.chapters[0].id, regenerate: true });
    expect((await terminal(ctx.engine, writing.id)).status).toBe('completed');
    const request = vi.mocked(models.generateText).mock.calls[0][1];
    expect(request.prompt).toContain('发现必须保留的目标章暗号');
    expect(ctx.store.state(writing.branchId).outline.fine).toContainEqual({ chapter: 2, title: '新追踪安排', goal: '作者修改后的后续规划' });
    expect(ctx.store.state(branch.id).chapters[0].id).toBe(original.state.chapters[0].id);
  });

  it('streams deltas before completion and persists prose while extraction is still running', async () => {
    const delayed = deferred<unknown>(); const models = mockModels(() => delayed.promise); const ctx = harness(models); const writing = start(ctx);
    const events: WritingEvent[] = []; const unsubscribe = ctx.engine.subscribeWriting(writing.id, event => events.push(event));
    expect((await terminal(ctx.engine, writing.id)).status).toBe('completed');
    const background = await until(() => ctx.engine.listJobs().find(value => value.kind === 'extract'), value => value?.status === 'running');
    expect(events.filter(event => event.type === 'delta')).toEqual([{ type: 'delta', text: '旅人' }, { type: 'delta', text: '来到桥边。' }]);
    expect(ctx.store.state(ctx.project.mainBranchId).chapters[0]).toMatchObject({ status: 'pending', summary: '' });
    expect(ctx.engine.writingSnapshot(writing.id)).toMatchObject({ text: '旅人来到桥边。', chapterId: ctx.store.state(ctx.project.mainBranchId).chapters[0].id });
    expect(models.generateStructured).toHaveBeenCalledTimes(1); // No automatic planning request.
    delayed.resolve(extraction()); expect((await terminal(ctx.engine, background!.id)).status).toBe('completed'); unsubscribe();
  });

  it('offers an unfinished-background choice and rejects late extraction after branching', async () => {
    const delayed = deferred<unknown>(); let calls = 0; const models = mockModels(async () => ++calls === 1 ? delayed.promise : extraction()); const ctx = harness(models);
    const writing = start(ctx); await terminal(ctx.engine, writing.id);
    const background = await until(() => ctx.engine.listJobs().find(value => value.kind === 'extract'), value => value?.status === 'running');
    const original = ctx.store.view(ctx.project.mainBranchId, true); const chapterId = original.state.chapters[0].id;
    expect(() => start(ctx, { chapterId, regenerate: true })).toThrow('后台资料整理尚未完成');
    expect(ctx.store.listBranches(ctx.project.id)).toHaveLength(1);
    const alternate = start(ctx, { chapterId, regenerate: true, discardBackground: true });
    expect(alternate.branchId).not.toBe(ctx.project.mainBranchId); expect(job(ctx.engine, background!.id).status).toBe('cancelled');
    delayed.resolve({ ...extraction(), summary: '被放弃的旧资料结果。' }); await terminal(ctx.engine, alternate.id);
    const newBackground = await until(() => ctx.engine.listJobs().find(value => value.kind === 'extract' && value.branchId === alternate.branchId), Boolean);
    await terminal(ctx.engine, newBackground!.id);
    expect(ctx.store.getBranch(ctx.project.mainBranchId).revisionId).toBe(original.branch.revisionId);
    expect(ctx.store.state(ctx.project.mainBranchId).chapters[0]).toMatchObject({ id: chapterId, summary: '', status: 'pending' });
    expect(ctx.store.state(alternate.branchId).chapters[0].summary).not.toContain('被放弃');
    expect(ctx.store.exportText(ctx.project.mainBranchId)).toBe(ctx.store.exportText(alternate.branchId));
  });

  it('regenerates a completed historical chapter from its earlier canon and preserves both originals', async () => {
    const ctx = harness(mockModels()); const first = readyChapter(ctx.store, ctx.project.mainBranchId, '第一章内容。'); readyChapter(ctx.store, ctx.project.mainBranchId, '第二章内容。');
    const alternate = start(ctx, { chapterId: first.state.chapters[0].id, regenerate: true }); await terminal(ctx.engine, alternate.id);
    const branch = ctx.store.getBranch(alternate.branchId); expect(branch.parentBranchId).toBe(ctx.project.mainBranchId);
    expect(ctx.store.state(alternate.branchId).chapters).toHaveLength(1); expect(ctx.store.state(ctx.project.mainBranchId).chapters).toHaveLength(2);
    const request = vi.mocked((ctx.engine as unknown as { models: TextModels }).models.generateText).mock.calls[0][1];
    expect(request.prompt).not.toContain('第二章内容'); expect(request.prompt).not.toContain('第一章内容');
  });

  it('restores historical AI role classification while carrying explicit author choices into regeneration', async () => {
    const ctx = harness(mockModels()); const first = readyChapter(ctx.store, ctx.project.mainBranchId, '第一章。');
    first.state.entities.push({ id: 'role', kind: 'character', name: '林舟', aliases: [], description: '旅人', visibility: 'public', locked: false, facts: [], isMain: false, isMainSource: 'extraction' });
    ctx.store.commit(ctx.project.mainBranchId, first.branch.revisionId, first.state, '早期配角');
    const current = readyChapter(ctx.store, ctx.project.mainBranchId, '第二章。'); current.state.entities[0].isMain = true;
    ctx.store.commit(ctx.project.mainBranchId, current.branch.revisionId, current.state, '后来AI识别主角');
    const target = current.state.chapters[1].id; const historical = start(ctx, { chapterId: target, regenerate: true });
    expect(ctx.store.state(historical.branchId).entities[0]).toMatchObject({ isMain: false, isMainSource: 'extraction' });
    ctx.store.updateEntity(ctx.project.mainBranchId, ctx.store.getBranch(ctx.project.mainBranchId).revisionId, { ...current.state.entities[0], isMain: true });
    const authored = start(ctx, { chapterId: target, regenerate: true });
    expect(ctx.store.state(authored.branchId).entities[0]).toMatchObject({ isMain: true, isMainSource: 'author' });
    await terminal(ctx.engine, historical.id); await terminal(ctx.engine, authored.id);
  });

  it('keeps streaming drafts through restart and backup without issuing another writing request', async () => {
    const started = deferred<void>(); const models = mockModels();
    models.generateText = vi.fn(async (_provider, request) => { request.onTextDelta?.('尚未完成的正文'); started.resolve(); await new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(new Error('停止')), { once: true })); throw new Error('停止'); });
    const ctx = harness(models); const writing = start(ctx); await started.promise; await ctx.engine.close();
    const replacement = new StoryEngine(ctx.store, settings, models); engines.push(replacement); replacement.start();
    expect(replacement.writingSnapshot(writing.id)).toMatchObject({ text: '尚未完成的正文', job: { status: 'paused' } });
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
    const recovered = replacement.listJobs(restored.id).find(value => value.kind === 'generate')!;
    expect(replacement.writingSnapshot(recovered.id)).toMatchObject({ text: '尚未完成的正文', job: { status: 'paused' } });
    expect(models.generateText).toHaveBeenCalledTimes(1);
  });

  it('fails a full mandatory context before requesting a model instead of silently dropping recent prose', async () => {
    const config = settings(); config.providers[0].contextTokens = 4000; const models = mockModels(); const ctx = harness(models, config);
    readyChapter(ctx.store, ctx.project.mainBranchId, '长正文'.repeat(1800)); const writing = start(ctx);
    const result = await terminal(ctx.engine, writing.id); expect(result.status).toBe('failed'); expect(result.error).toContain('上下文');
    expect(models.generateText).not.toHaveBeenCalled(); expect(ctx.store.state(ctx.project.mainBranchId).chapters).toHaveLength(1);
  });
});

describe('author-confirmed plot summary compression', () => {
  it('only uses a compression after explicit confirmation and invalidates stale proposals', async () => {
    const models = mockModels(async () => ({ text: '旅人抵达。' })); const ctx = harness(models); const before = readyChapter(ctx.store, ctx.project.mainBranchId, '旅人来到旧桥并发现关键线索。'.repeat(8));
    const compression = ctx.engine.enqueue(ctx.project.mainBranchId, 'plan', { baseRevisionId: before.branch.revisionId, purpose: 'compress-summary' }); await terminal(ctx.engine, compression.id);
    expect(ctx.store.getBranch(ctx.project.mainBranchId).revisionId).toBe(before.branch.revisionId); expect(ctx.store.state(ctx.project.mainBranchId).outline.summaryCompression).toBeUndefined();
    const proposal = ctx.engine.summaryCompression(compression.id); const confirmed = ctx.engine.confirmSummaryCompression(ctx.project.mainBranchId, { baseRevisionId: proposal.baseRevisionId, jobId: compression.id, text: proposal.text });
    expect(confirmed.state.outline.summaryCompression).toEqual({ text: proposal.text, chapterIds: proposal.chapterIds });
    const context = buildWritingContext({ state: confirmed.state, chapterText: id => ctx.store.chapter(ctx.project.mainBranchId, id).text }).text;
    expect(context).toContain('authorConfirmedSummary');
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id)); const recovered = ctx.store.state(restored.mainBranchId);
    expect(recovered.outline.summaryCompression).toEqual({ text: proposal.text, chapterIds: recovered.chapters.map(chapter => chapter.id) });
    expect(recovered.chapters[0].id).not.toBe(proposal.chapterIds[0]);
    const corrupted = structuredClone(ctx.store.exportProject(ctx.project.id)) as { revisions: { state?: unknown; snapshot: string }[] };
    const { gunzipSync, gzipSync } = await import('node:zlib'); const entry = corrupted.revisions[0]; const state = JSON.parse(gunzipSync(Buffer.from(entry.snapshot, 'base64')).toString());
    state.outline.summaryCompression.chapterIds = ['missing-chapter']; entry.snapshot = gzipSync(JSON.stringify(state)).toString('base64');
    expect(() => ctx.store.restoreProject(corrupted)).toThrow('压缩摘要存在无效章节关联');
    expect(() => ctx.engine.confirmSummaryCompression(ctx.project.mainBranchId, { baseRevisionId: confirmed.branch.revisionId, jobId: compression.id, text: proposal.text })).toThrow('版本已变化');
  });

  it('protects author streams and compression proposals from reader views and unauthenticated access', async () => {
    const ctx = await buildApp({ initialPassword: 'flow-test-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-stream-api-')), startEngine: false }); apps.push(ctx);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'flow-test-password' } }); const cookies = { session: login.cookies.find(cookie => cookie.name === 'session')!.value };
    const project = ctx.store.createProject({ title: '流权限' }); const writing = ctx.engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: ctx.store.getBranch(project.mainBranchId).revisionId, mode: 'original', instruction: 'SECRET_AUTHOR_INSTRUCTION', title: 'SECRET_FUTURE_TITLE' }); ctx.engine.action(writing.id, 'pause');
    const readerJobs = await ctx.app.inject({ url: '/api/jobs', cookies }); const authorJobs = await ctx.app.inject({ url: '/api/jobs?view=author', cookies });
    expect(readerJobs.body).not.toContain('SECRET_AUTHOR_INSTRUCTION'); expect(authorJobs.body).toContain('SECRET_AUTHOR_INSTRUCTION');
    expect(readerJobs.body).not.toContain('SECRET_FUTURE_TITLE'); expect(authorJobs.body).toContain('SECRET_FUTURE_TITLE');
    expect((await ctx.app.inject(`/api/jobs/${writing.id}/events?view=author`)).statusCode).toBe(401);
    expect((await ctx.app.inject({ url: `/api/jobs/${writing.id}/events`, cookies })).statusCode).toBe(403);
    expect((await ctx.app.inject({ url: `/api/jobs/${writing.id}/summary-compression`, cookies })).statusCode).toBe(403);
    const stream = await ctx.app.inject({ url: `/api/jobs/${writing.id}/events?view=author`, cookies }); expect(stream.statusCode).toBe(200); expect(stream.body).toContain('"type":"snapshot"'); expect(stream.body).toContain('"status":"paused"');
  });
});
