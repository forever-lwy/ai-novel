import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { buildApp } from '../server/app.js';
import type { ExtractionResult, ModelRequest, Settings, WritingActivity, WritingEvent } from '../shared/types.js';

const stores: Store[] = []; const engines: StoryEngine[] = []; const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const context of apps.splice(0)) await context.app.close(); for (const engine of engines.splice(0)) await engine.close(); for (const store of stores.splice(0)) store.close(); });
const configuredKey = 'activity-configured-key-DO-NOT-PERSIST';
const settings = (): Settings => ({ providers: [{ id: 'fixture', name: '活动测试模型', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'writer', apiKey: configuredKey, maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture' });
const extraction = (): ExtractionResult => ({ summary: '旅人来到桥边。', entities: [], relations: [], foreshadows: [] });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const pending = (promise: Promise<void>, signal?: AbortSignal) => Promise.race([promise, new Promise<never>((_, reject) => { if (signal?.aborted) reject(new DOMException('停止', 'AbortError')); else signal?.addEventListener('abort', () => reject(new DOMException('停止', 'AbortError')), { once: true }); })]);
async function until<T>(read: () => T, ready: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 4000; for (;;) { const value = read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error('活动测试等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const terminal = (engine: StoryEngine, id: string) => until(() => engine.listJobs().find(job => job.id === id)!, job => ['completed', 'failed', 'paused', 'cancelled', 'stale'].includes(job.status));
function models(write: (request: ModelRequest) => Promise<string>): TextModels {
  return { generateText: vi.fn(async (_provider, request) => ({ text: await write(request), inputTokens: 10, outputTokens: 20 })), generateStructured: vi.fn(async (_provider, _request, validate) => ({ value: validate(extraction()), inputTokens: 3, outputTokens: 4 })) };
}
function harness(model: TextModels) { const store = new Store(mkdtempSync(join(tmpdir(), 'novel-activity-'))); stores.push(store); const project = store.createProject({ title: '写作活动' }); const engine = new StoryEngine(store, settings, model); engines.push(engine); engine.start(); return { store, project, engine }; }
function start(context: ReturnType<typeof harness>) { return context.engine.enqueue(context.project.mainBranchId, 'generate', { baseRevisionId: context.store.getBranch(context.project.mainBranchId).revisionId, mode: 'original', instruction: '写下一章' }); }
const activityEvents = (events: WritingEvent[]): WritingActivity[] => events.flatMap(event => event.type === 'activity' ? [event.activity] : []);

describe('author writing activity persistence and streaming', () => {
  it('anchors activity to UTF-16 prose positions and keeps its first position through updates and backup', async () => {
    const prefix = '前言🙂\r\n途中'; const middle = '，旅人继续。'; const suffix = '\n后来见到石碑。';
    const context = harness(models(async request => {
      request.onActivity?.({ type: 'thinking', id: 'opening', text: '先确认起点。' });
      request.onActivity?.({ type: 'thinking_done', id: 'opening' });
      request.onTextDelta?.(prefix);
      request.onActivity?.({ type: 'tool_call', id: 'at-journey', name: 'search_story', arguments: { q: '途中' } });
      request.onTextDelta?.(middle);
      request.onActivity?.({ type: 'tool_result', id: 'at-journey', name: 'search_story', result: '找到资料。' });
      request.onActivity?.({ type: 'thinking', id: 'after-journey', text: '确认行动后果。' });
      request.onTextDelta?.(suffix);
      request.onActivity?.({ type: 'thinking', id: 'after-journey', text: '继续核对。' });
      request.onActivity?.({ type: 'thinking_done', id: 'after-journey' });
      return prefix + middle + suffix;
    }));
    const writing = start(context); const events: WritingEvent[] = []; context.engine.subscribeWriting(writing.id, event => events.push(event));
    expect((await terminal(context.engine, writing.id)).status).toBe('completed');
    const activities = context.engine.listWritingActivities(writing.id);
    expect(activities.map(activity => activity.proseOffset)).toEqual([0, prefix.length, prefix.length + middle.length]);
    expect(activityEvents(events).filter(activity => activity.id === 'at-journey').every(activity => activity.proseOffset === prefix.length)).toBe(true);
    expect(activities[2].text).toBe('确认行动后果。继续核对。');
    expect(context.engine.writingSnapshot(writing.id).text).toBe(prefix + middle + suffix);
    const restored = context.store.restoreProject(context.store.exportProject(context.project.id));
    const restoredWriting = context.engine.listJobs(restored.id).find(job => job.kind === 'generate')!;
    expect(context.engine.listWritingActivities(restoredWriting.id).map(activity => activity.proseOffset)).toEqual(activities.map(activity => activity.proseOffset));
  });

  it('uses author-visible redacted prose positions and preserves legacy unpositioned activity', async () => {
    const context = harness(models(async () => '最终正文。'));
    const writing = context.engine.enqueue(context.project.mainBranchId, 'generate', { baseRevisionId: context.store.getBranch(context.project.mainBranchId).revisionId, mode: 'original', instruction: '' });
    context.engine.action(writing.id, 'pause');
    context.store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?)').run(writing.id, '开头 fixture-secret 后文');
    const redact = (value: string) => value.replaceAll('fixture-secret', '[REDACTED]');
    const positioned = context.store.recordWritingActivity(writing.id, { type: 'tool_call', id: 'positioned', name: 'search_story', arguments: {} }, redact)!;
    expect(positioned.proseOffset).toBe('开头 [REDACTED] 后文'.length);
    context.store.db.prepare('INSERT INTO job_writing_activities VALUES(?,?,?)').run(writing.id, 'legacy', JSON.stringify({ id: 'legacy', kind: 'thinking', text: '旧记录', status: 'running' }));
    expect(context.store.recordWritingActivity(writing.id, { type: 'thinking', id: 'legacy', text: '继续' })).not.toHaveProperty('proseOffset');
    context.store.shiftWritingActivityOffsets(writing.id, 5);
    expect(context.store.listWritingActivities(writing.id).find(activity => activity.id === 'positioned')?.proseOffset).toBe(positioned.proseOffset! + 5);
    expect(context.store.listWritingActivities(writing.id).find(activity => activity.id === 'legacy')).not.toHaveProperty('proseOffset');
    const restored = context.store.restoreProject(context.store.exportProject(context.project.id));
    const restoredWriting = context.engine.listJobs(restored.id).find(job => job.kind === 'generate')!;
    expect(context.engine.listWritingActivities(restoredWriting.id).find(activity => activity.id === 'legacy')).not.toHaveProperty('proseOffset');
  });

  it('streams thinking and tool activity separately from prose, redacts cumulative fragments, and closes pending activity after commit', async () => {
    const began = deferred<void>(); const finish = deferred<void>();
    const context = harness(models(async request => {
      request.onActivity?.({ type: 'thinking', id: 'thought', text: `先检查角色资料。${configuredKey.slice(0, 12)}` });
      request.onActivity?.({ type: 'thinking', id: 'thought', text: configuredKey.slice(12) });
      request.onActivity?.({ type: 'thinking_done', id: 'thought' });
      request.onActivity?.({ type: 'tool_call', id: 'lookup', name: 'search_story', arguments: { q: '林舟', apiKey: configuredKey } });
      request.onActivity?.({ type: 'tool_result', id: 'lookup', name: 'search_story', result: { detail: '作者才能查看的工具结果', providerKey: configuredKey } });
      request.onActivity?.({ type: 'tool_call', id: 'unfinished', name: 'read_chapter', arguments: { chapterId: 'earlier' } });
      request.onTextDelta?.('旅人来到桥边。'); began.resolve(); await pending(finish.promise, request.signal);
      return '旅人来到桥边。';
    }));
    const writing = start(context); const events: WritingEvent[] = [];
    context.engine.subscribeWriting(writing.id, event => events.push(event));
    await began.promise;
    const snapshot = context.engine.writingSnapshot(writing.id);
    expect(snapshot.text).toBe('旅人来到桥边。'); expect(snapshot.activities).toHaveLength(3);
    expect(snapshot.activities![0]).toMatchObject({ kind: 'thinking', status: 'completed' });
    expect(snapshot.activities![1]).toMatchObject({ kind: 'tool', name: 'search_story', status: 'completed', arguments: { q: '林舟' }, result: { detail: '作者才能查看的工具结果' } });
    expect(snapshot.activities![2].status).toBe('running');
    expect(JSON.stringify(snapshot.activities)).not.toContain(configuredKey);
    expect(activityEvents(events).some(activity => activity.kind === 'thinking')).toBe(true);
    expect(events.filter(event => event.type === 'delta')).toEqual([{ type: 'delta', text: '旅人来到桥边。' }]);
    finish.resolve(); expect((await terminal(context.engine, writing.id)).status).toBe('completed');
    const activities = context.engine.listWritingActivities(writing.id);
    expect(activities.every(activity => activity.status === 'completed')).toBe(true);
    const activityFinished = events.findIndex(event => event.type === 'activity' && event.activity.id === 'unfinished' && event.activity.status === 'completed');
    const writingFinished = events.findIndex(event => event.type === 'status' && event.job.status === 'completed');
    expect(activityFinished).toBeGreaterThanOrEqual(0); expect(writingFinished).toBeGreaterThan(activityFinished);
    const chapter = context.store.state(context.project.mainBranchId).chapters[0];
    expect(context.store.chapter(context.project.mainBranchId, chapter.id).text).toBe('旅人来到桥边。');
    expect(context.store.exportText(context.project.mainBranchId)).not.toContain('作者才能查看');
    expect(context.store.exportText(context.project.mainBranchId)).not.toContain('先检查角色资料');
  });

  it.each(['pause', 'cancel'] as const)('finishes pending activity as interrupted on %s and rejects late activity without appending it', async action => {
    const began = deferred<ModelRequest>();
    const context = harness(models(async request => {
      request.onActivity?.({ type: 'thinking', id: 'thought', text: '正在检查剧情。' });
      request.onActivity?.({ type: 'tool_call', id: 'pending-tool', name: 'search_story', arguments: { q: '铜钥匙' } });
      began.resolve(request);
      await new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(new DOMException('请求中断', 'AbortError')), { once: true }));
      return '不会保存的正文';
    }));
    const writing = start(context); const events: WritingEvent[] = []; context.engine.subscribeWriting(writing.id, event => events.push(event));
    const request = await began.promise; context.engine.action(writing.id, action);
    expect((await terminal(context.engine, writing.id)).status).toBe(action === 'pause' ? 'paused' : 'cancelled');
    const activities = context.engine.listWritingActivities(writing.id); expect(activities).toHaveLength(2);
    expect(activities.every(activity => activity.status === 'failed' && activity.error)).toBe(true);
    expect(() => request.onActivity?.({ type: 'tool_result', id: 'pending-tool', name: 'search_story', result: '迟到的秘密结果' })).toThrow('任务已停止');
    expect(context.engine.listWritingActivities(writing.id)).toEqual(activities);
    expect(activityEvents(events).some(activity => activity.status === 'completed')).toBe(false);
    expect(context.store.state(context.project.mainBranchId).chapters).toHaveLength(0);
  });

  it('retains a failed tool result when the model continues writing successfully, with its error redacted', async () => {
    const context = harness(models(async request => {
      request.onActivity?.({ type: 'tool_call', id: 'lookup-error', name: 'read_chapter', arguments: { chapterId: 'missing' } });
      request.onActivity?.({ type: 'tool_result', id: 'lookup-error', name: 'read_chapter', error: `查询失败 ${configuredKey}` });
      return '旅人来到桥边。';
    }));
    const writing = start(context); expect((await terminal(context.engine, writing.id)).status).toBe('completed');
    const activities = context.engine.listWritingActivities(writing.id);
    expect(activities).toMatchObject([{ kind: 'tool', status: 'failed', arguments: { chapterId: 'missing' }, error: expect.stringContaining('查询失败') }]);
    expect(JSON.stringify(activities)).not.toContain(configuredKey);
    expect(context.store.exportText(context.project.mainBranchId)).not.toContain('查询失败');
  });

  it('retains a failed attempt until retry, then clears its process and resets the author snapshot', async () => {
    let attempt = 0; const beganAgain = deferred<void>(); const finish = deferred<void>();
    const context = harness(models(async request => {
      attempt++;
      request.onActivity?.({ type: 'thinking', id: `thought-${attempt}`, text: `第${attempt}次检查` });
      if (attempt === 1) throw new Error('模拟断网');
      beganAgain.resolve(); await pending(finish.promise, request.signal); return '旅人来到桥边。';
    }));
    const writing = start(context); const events: WritingEvent[] = []; context.engine.subscribeWriting(writing.id, event => events.push(event));
    expect((await terminal(context.engine, writing.id)).status).toBe('failed');
    expect(context.engine.listWritingActivities(writing.id)).toMatchObject([{ id: 'thought-1', status: 'failed' }]);
    const retryFrom = events.length; context.engine.action(writing.id, 'retry'); await beganAgain.promise;
    expect(events.slice(retryFrom).some(event => event.type === 'snapshot' && event.activities?.length === 0 && event.text === '')).toBe(true);
    expect(context.engine.listWritingActivities(writing.id).map(activity => activity.id)).toEqual(['thought-2']);
    finish.resolve(); expect((await terminal(context.engine, writing.id)).status).toBe('completed');
    expect(context.engine.listWritingActivities(writing.id)).toMatchObject([{ id: 'thought-2', status: 'completed' }]);
  });

  it('does not publish successful activity completion when the chapter transaction rolls back', async () => {
    const context = harness(models(async request => { request.onActivity?.({ type: 'thinking', id: 'unfinished', text: '还在整理资料。' }); return '旅人来到桥边。'; }));
    context.store.db.exec("CREATE TRIGGER reject_activity_background BEFORE INSERT ON jobs WHEN json_extract(NEW.data,'$.kind')='extract' BEGIN SELECT RAISE(ABORT,'模拟后台任务插入失败'); END");
    const writing = start(context); const events: WritingEvent[] = []; context.engine.subscribeWriting(writing.id, event => events.push(event));
    expect((await terminal(context.engine, writing.id)).status).toBe('failed');
    expect(context.store.state(context.project.mainBranchId).chapters).toHaveLength(0);
    expect(activityEvents(events).some(activity => activity.status === 'completed')).toBe(false);
    expect(events.some(event => event.type === 'status' && event.job.status === 'completed')).toBe(false);
    expect(context.engine.listWritingActivities(writing.id)).toMatchObject([{ status: 'failed' }]);
  });

  it('marks an interrupted server shutdown as paused while retaining activity for restart and backup', async () => {
    const began = deferred<void>(); const model = models(async request => {
      request.onActivity?.({ type: 'thinking', id: 'shutdown-thought', text: '服务停止前的思考。' }); began.resolve();
      await new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(new DOMException('停止', 'AbortError')), { once: true })); return '';
    });
    const context = harness(model); const writing = start(context); await began.promise; await context.engine.close();
    expect(context.engine.writingSnapshot(writing.id)).toMatchObject({ job: { status: 'paused' }, activities: [{ status: 'failed', error: expect.stringContaining('服务已停止') }] });
    const replacement = new StoryEngine(context.store, settings, model); engines.push(replacement); replacement.start();
    expect(replacement.listWritingActivities(writing.id)).toMatchObject([{ text: '服务停止前的思考。' }]);
    expect(model.generateText).toHaveBeenCalledTimes(1);
  });

  it('restores activity history under new job IDs and deletes it only with the owning project', async () => {
    let originalJobId = '';
    const context = harness(models(async request => {
      request.onActivity?.({ type: 'tool_call', id: 'lookup', name: 'search_story', arguments: { q: '桥边', jobId: originalJobId, branchId: context.project.mainBranchId } });
      request.onActivity?.({ type: 'tool_result', id: 'lookup', name: 'search_story', result: { found: '早期原文资料', projectId: context.project.id } }); return '旅人来到桥边。';
    }));
    const writing = start(context); originalJobId = writing.id; await terminal(context.engine, writing.id);
    const background = context.engine.listJobs().find(job => job.kind === 'extract')!; await terminal(context.engine, background.id);
    const original = context.engine.listWritingActivities(writing.id);
    const backup = context.store.exportProject(context.project.id) as { writingActivities: { jobId: string; activities: WritingActivity[] }[] };
    const restored = context.store.restoreProject(backup);
    const restoredWriting = context.engine.listJobs(restored.id).find(job => job.kind === 'generate')!;
    expect(restoredWriting.id).not.toBe(writing.id); expect(context.engine.listWritingActivities(restoredWriting.id)).toEqual(original);
    expect(context.engine.listWritingActivities(restoredWriting.id)[0]).toMatchObject({ arguments: { jobId: writing.id, branchId: context.project.mainBranchId }, result: { projectId: context.project.id } });
    const count = context.store.listProjects().length;
    const activityCount = context.store.db.prepare('SELECT count(*) AS count FROM job_writing_activities').get()!.count;
    for (const corruption of ['unrelated-job', 'duplicate-id', 'duplicate-job'] as const) {
      const invalid = structuredClone(backup);
      if (corruption === 'unrelated-job') invalid.writingActivities[0].jobId = 'missing-job';
      else if (corruption === 'duplicate-id') invalid.writingActivities[0].activities.push(structuredClone(invalid.writingActivities[0].activities[0]));
      else invalid.writingActivities.push(structuredClone(invalid.writingActivities[0]));
      expect(() => context.store.restoreProject(invalid)).toThrow('备份');
      expect(context.store.listProjects()).toHaveLength(count);
      expect(context.store.db.prepare('SELECT count(*) AS count FROM job_writing_activities').get()!.count).toBe(activityCount);
    }
    await context.engine.deleteProject(context.project.id);
    expect(context.store.db.prepare('SELECT count(*) AS count FROM job_writing_activities WHERE job_id=?').get(writing.id)?.count).toBe(0);
    expect(() => context.engine.listWritingActivities(writing.id)).toThrow('任务不存在');
    expect(context.engine.listWritingActivities(restoredWriting.id)).toEqual(original);
  });

  it('restores a running backup as paused and interrupts only activity that was still running', async () => {
    const began = deferred<void>(); const finish = deferred<void>();
    const context = harness(models(async request => {
      request.onActivity?.({ type: 'tool_call', id: 'finished-tool', name: 'search_story', arguments: { q: '旧桥' } });
      request.onActivity?.({ type: 'tool_result', id: 'finished-tool', name: 'search_story', result: '已找到桥边原文' });
      request.onActivity?.({ type: 'thinking', id: 'running-thought', text: '还在核对人物关系。' });
      began.resolve(); await pending(finish.promise, request.signal); return '旅人来到桥边。';
    }));
    const writing = start(context); await began.promise;
    const original = context.engine.listWritingActivities(writing.id);
    expect(original.map(activity => activity.status)).toEqual(['completed', 'running']);
    const restored = context.store.restoreProject(context.store.exportProject(context.project.id));
    const restoredWriting = context.engine.listJobs(restored.id).find(job => job.kind === 'generate')!;
    expect(restoredWriting.status).toBe('paused');
    const activities = context.engine.listWritingActivities(restoredWriting.id);
    expect(activities[0]).toEqual(original[0]); expect(activities[1]).toMatchObject({ text: '还在核对人物关系。', status: 'failed', error: restoredWriting.message });
    expect(context.engine.listWritingActivities(writing.id)[1].status).toBe('running');
    finish.resolve(); await terminal(context.engine, writing.id);
  });
});

describe('author-only activity API and SSE', () => {
  it('requires login and author view for saved thinking/tool history and includes it in the author stream', async () => {
    const context = await buildApp({ initialPassword: 'activity-api-test-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-activity-api-')), startEngine: false }); apps.push(context);
    const loginResponse = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'activity-api-test-password' } });
    const cookies = { session: loginResponse.cookies.find(cookie => cookie.name === 'session')!.value };
    const project = context.store.createProject({ title: '活动权限' });
    const writing = context.engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: context.store.getBranch(project.mainBranchId).revisionId, mode: 'original', instruction: '写下一章' });
    context.store.recordWritingActivity(writing.id, { type: 'thinking', id: 'private-thinking', text: '作者可见的思考过程' });
    context.store.recordWritingActivity(writing.id, { type: 'tool_call', id: 'private-tool', name: 'search_story', arguments: { q: '未揭晓的钥匙' } });
    context.engine.action(writing.id, 'pause');
    expect((await context.app.inject(`/api/jobs/${writing.id}/activities?view=author`)).statusCode).toBe(401);
    expect((await context.app.inject({ url: `/api/jobs/${writing.id}/activities`, cookies })).statusCode).toBe(403);
    expect((await context.app.inject({ url: `/api/jobs/${writing.id}/activities?view=reader`, cookies })).statusCode).toBe(403);
    const history = await context.app.inject({ url: `/api/jobs/${writing.id}/activities?view=author`, cookies });
    expect(history.statusCode).toBe(200); expect(history.json()).toMatchObject([{ kind: 'thinking', text: '作者可见的思考过程' }, { kind: 'tool', name: 'search_story' }]);
    const stream = await context.app.inject({ url: `/api/jobs/${writing.id}/events?view=author`, cookies });
    expect(stream.statusCode).toBe(200); const snapshot = JSON.parse(stream.body.trim().slice('data: '.length));
    expect(snapshot.activities).toEqual(history.json()); expect(snapshot.text).toBe(''); expect(snapshot.job.status).toBe('paused');
    const readerJobs = await context.app.inject({ url: '/api/jobs', cookies }); expect(readerJobs.body).not.toContain('作者可见的思考过程'); expect(readerJobs.body).not.toContain('未揭晓的钥匙');
    const other = context.store.createProject({ title: '不是正文任务' }); const extractionJob = context.engine.enqueue(other.mainBranchId, 'extract', { baseRevisionId: context.store.getBranch(other.mainBranchId).revisionId });
    expect((await context.app.inject({ url: `/api/jobs/${extractionJob.id}/activities?view=author`, cookies })).statusCode).toBe(400);
  });

  it('keeps the HTTP stream open for activity events and ends only after prose is committed', async () => {
    const context = await buildApp({ initialPassword: 'activity-http-test-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-activity-http-')), startEngine: false }); apps.push(context);
    context.settings.save(settings());
    const began = deferred<void>(); const finish = deferred<void>();
    const model = models(async request => { request.onActivity?.({ type: 'thinking', id: 'live-thought', text: '核对故事资料。' }); request.onActivity?.({ type: 'tool_call', id: 'live-tool', name: 'search_story', arguments: { q: '旧桥' } }); request.onTextDelta?.('旅人来到桥边。'); began.resolve(); await pending(finish.promise, request.signal); return '旅人来到桥边。'; });
    (context.engine as unknown as { models: TextModels }).models = model;
    const loginResponse = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'activity-http-test-password' } }); const cookies = { session: loginResponse.cookies.find(cookie => cookie.name === 'session')!.value };
    const project = context.store.createProject({ title: '活动实时流' }); const writing = context.engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: context.store.getBranch(project.mainBranchId).revisionId, mode: 'original', instruction: '写下一章' });
    const response = context.app.inject({ url: `/api/jobs/${writing.id}/events?view=author`, cookies });
    await context.app.ready(); context.engine.start(); await began.promise; finish.resolve();
    const stream = await response; expect(stream.statusCode).toBe(200);
    const events = stream.body.split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice('data: '.length)) as WritingEvent);
    expect(events.some(event => event.type === 'activity' && event.activity.kind === 'tool')).toBe(true);
    expect(events.some(event => event.type === 'delta')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'status', job: { status: 'completed' } });
    expect(context.store.exportText(project.mainBranchId)).toBe('第 1 章\n\n旅人来到桥边。');
  });
});
