import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { Store } from '../server/store.js';
import { ModelOutputError, parseStructuredText } from '../server/providers.js';
import { splitExtractionBlocks } from '../server/extraction.js';
import type { ExtractionResult, Job, ModelRequest, ModelRequestSnapshot, Settings } from '../shared/types.js';

const cleanup: { engine: StoryEngine; store: Store }[] = [];
afterEach(async () => { for (const context of cleanup.splice(0)) { await context.engine.close(); context.store.close(); } });
const extraction = (): ExtractionResult => ({ summary: '记录员完成检查。', entities: [], relations: [], foreshadows: [] });
const valid = () => JSON.stringify(extraction());
const snapshot = (): ModelRequestSnapshot => ({ protocol: 'openai-chat', model: 'fixture', url: 'http://unused.invalid/chat/completions', method: 'POST', headers: {}, body: '{}', startedAt: new Date().toISOString(), timeoutMs: 1000, stream: false });
const config = (options: Partial<NonNullable<Settings['taskSettings']>['extraction']> = {}): Settings => ({
  providers: [{ id: 'fixture', name: '模拟服务', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'fixture', maxOutputTokens: 1024, contextTokens: 64000 }],
  writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture',
  taskSettings: { extraction: { autoRetry: true, maxRetries: 2, retryDelayMs: 5, ...options }, planning: { enabled: true, mode: 'separate' } },
});
function models(response: (request: ModelRequest) => string | Promise<string>): TextModels {
  return {
    generateText: vi.fn(async () => ({ text: '记录员检查设备。', inputTokens: 7, outputTokens: 8 })),
    generateStructured: vi.fn(async (_provider, request, validate) => {
      const text = await response(request);
      request.onResponse?.({ rawResponse: JSON.stringify({ choices: [{ message: { content: text } }] }), text, inputTokens: 10, outputTokens: 4, httpStatus: 200 });
      try { return { value: parseStructuredText(text, validate), inputTokens: 10, outputTokens: 4 }; }
      catch (error) { throw new ModelOutputError('模拟格式错误', { inputTokens: 10, outputTokens: 4 }, error instanceof ModelOutputError ? error.issues : undefined); }
    }),
  };
}
function harness(model: TextModels, settings = config(), text: string | null = '记录员检查设备。') {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-extraction-retry-'))); const project = store.createProject({ title: '重试测试' });
  if (text) store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: '检查', text });
  const engine = new StoryEngine(store, () => settings, model); cleanup.push({ engine, store }); engine.start();
  return { store, project, engine, settings };
}
const getJob = (engine: StoryEngine, id: string) => engine.listJobs().find(job => job.id === id)!;
async function until<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) { const value = read(); if (done(value)) return value; if (Date.now() > deadline) throw new Error('重试测试超时'); await new Promise(resolve => setTimeout(resolve, 2)); }
}
const terminal = (engine: StoryEngine, id: string) => until(() => getJob(engine, id), job => ['completed', 'failed', 'stale', 'cancelled'].includes(job.status));
const waiting = (engine: StoryEngine, id: string) => until(() => getJob(engine, id), job => job.status === 'running' && job.message.includes('等待第'));
function start(context: ReturnType<typeof harness>) { return context.engine.enqueue(context.project.mainBranchId, 'extract', { baseRevisionId: context.store.getBranch(context.project.mainBranchId).revisionId }); }
function persisted(context: ReturnType<typeof harness>, id: string): Job { return JSON.parse(String(context.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(id)!.data)) as Job; }

describe('bounded, cancellable extraction retries', () => {
  it('keeps every malformed response and charges every attempt exactly once before success', async () => {
    let calls = 0; const model = models(() => ++calls < 3 ? '{"summary":' : valid()); const context = harness(model); const job = start(context);
    const completed = await terminal(context.engine, job.id);
    expect(completed).toMatchObject({ status: 'completed', inputTokens: 30, outputTokens: 12 });
    expect(context.engine.listOutputs(job.id).map(output => output.status).sort()).toEqual(['applied', 'invalid', 'invalid']);
    expect(context.engine.listOutputs(job.id)).toHaveLength(3); expect(persisted(context, job.id).payload.extractionRetry).toBeUndefined();
    expect(context.store.state(context.project.mainBranchId).chapters[0].status).toBe('ready');
  });

  it('retries citation validation without double charging the already received response', async () => {
    let calls = 0;
    const bad = extraction(); bad.entities.push({ kind: 'character', name: '记录员', aliases: [], description: '', visibility: 'public', facts: [{ text: '检查设备', temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 1, quote: '原文不存在的引用。' }] });
    const model = models(() => ++calls === 1 ? JSON.stringify(bad) : valid()); const context = harness(model); const job = start(context);
    expect(await terminal(context.engine, job.id)).toMatchObject({ status: 'completed', inputTokens: 20, outputTokens: 8 });
    const rejected = context.engine.listOutputs(job.id).find(output => output.status === 'invalid')!;
    expect(context.engine.outputDetail(job.id, rejected.id).output.issues[0].path).toBe('entities[0].facts[0].quote');
  });

  it('uses the original request plus the configured retry limit and resets the budget only on an author retry', async () => {
    let recover = false; const model = models(() => recover ? valid() : '{"summary":'); const context = harness(model); const job = start(context);
    expect(await terminal(context.engine, job.id)).toMatchObject({ status: 'failed', inputTokens: 30, outputTokens: 12 });
    expect(model.generateStructured).toHaveBeenCalledTimes(3); expect(persisted(context, job.id).payload.extractionRetry).toMatchObject({ blockIndex: 0, failedAttempts: 3 });
    recover = true; context.engine.action(job.id, 'retry');
    expect(await terminal(context.engine, job.id)).toMatchObject({ status: 'completed', inputTokens: 40, outputTokens: 16 });
    expect(model.generateStructured).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])('does not resend when autoRetry=%s and the retry limit is zero', async autoRetry => {
    const model = models(() => '{"summary":'); const context = harness(model, config({ autoRetry, maxRetries: 0 })); const job = start(context);
    expect((await terminal(context.engine, job.id)).status).toBe('failed'); expect(model.generateStructured).toHaveBeenCalledTimes(1);
  });

  it('uses one request when automatic retries are disabled even with a nonzero retry limit', async () => {
    const model = models(() => '{"summary":'); const context = harness(model, config({ autoRetry: false })); const job = start(context);
    expect((await terminal(context.engine, job.id)).status).toBe('failed'); expect(model.generateStructured).toHaveBeenCalledTimes(1);
  });

  it.each(['provider', 'url', 'parameters', 'budget'])('does not retry a pre-request %s problem', async problem => {
    const settings = config();
    if (problem === 'provider') settings.extractionProviderId = 'missing';
    if (problem === 'url') settings.providers[0].baseUrl = 'invalid-url';
    if (problem === 'parameters') settings.providers[0].temperature = 9;
    if (problem === 'budget') settings.providers[0].contextTokens = 100;
    const model = models(valid); const context = harness(model, settings); const job = start(context);
    expect((await terminal(context.engine, job.id)).status).toBe('failed'); expect(model.generateStructured).not.toHaveBeenCalled();
  });

  it.each(['pause', 'cancel'] as const)('stops the retry wait immediately on %s without another request', async action => {
    let recover = false; const model = models(() => recover ? valid() : '{"summary":'); const context = harness(model, config({ retryDelayMs: 200 })); const job = start(context);
    expect(await waiting(context.engine, job.id)).toMatchObject({ status: 'running', inputTokens: 10 });
    context.engine.action(job.id, action); await new Promise(resolve => setTimeout(resolve, 220));
    expect(getJob(context.engine, job.id).status).toBe(action === 'pause' ? 'paused' : 'cancelled'); expect(model.generateStructured).toHaveBeenCalledTimes(1);
    if (action === 'pause') { recover = true; context.engine.action(job.id, 'resume'); expect((await terminal(context.engine, job.id)).status).toBe('completed'); expect(model.generateStructured).toHaveBeenCalledTimes(2); }
  });

  it('aborts a long retry wait on shutdown and requires manual resumption after restart', async () => {
    let recover = false; const model = models(() => recover ? valid() : '{"summary":'); const context = harness(model, config({ retryDelayMs: 300000 })); const job = start(context);
    await waiting(context.engine, job.id); const closedAt = Date.now(); await context.engine.close(); expect(Date.now() - closedAt).toBeLessThan(1000);
    expect(persisted(context, job.id).payload.extractionRetry).toMatchObject({ failedAttempts: 1 });
    const restarted = new StoryEngine(context.store, () => context.settings, model); cleanup.push({ engine: restarted, store: context.store });
    // The original engine is closed; the shared Store is closed only once by this cleanup entry.
    cleanup.splice(cleanup.findIndex(entry => entry.engine === context.engine), 1); restarted.start();
    expect(getJob(restarted, job.id).status).toBe('paused'); expect(model.generateStructured).toHaveBeenCalledTimes(1);
    recover = true; restarted.action(job.id, 'resume'); expect((await terminal(restarted, job.id)).status).toBe('completed'); expect(model.generateStructured).toHaveBeenCalledTimes(2);
  });

  it('refuses another request after the story version changes during the wait', async () => {
    const model = models(() => '{"summary":'); const context = harness(model, config({ retryDelayMs: 30 })); const job = start(context);
    await waiting(context.engine, job.id); const branch = context.store.getBranch(context.project.mainBranchId);
    context.store.updateOutline(branch.id, branch.revisionId, { ...context.store.state(branch.id).outline, worldview: '作者修改了世界观' });
    expect((await terminal(context.engine, job.id)).status).toBe('stale'); expect(model.generateStructured).toHaveBeenCalledTimes(1);
    expect(context.store.state(branch.id).chapters[0].status).toBe('pending');
  });

  it.each(['disable', 'lower-limit'])('honors a live %s setting change before sending the retry', async change => {
    const settings = config({ retryDelayMs: 30 }); const model = models(() => '{"summary":'); const context = harness(model, settings); const job = start(context);
    await waiting(context.engine, job.id);
    if (change === 'disable') settings.taskSettings!.extraction.autoRetry = false;
    else settings.taskSettings!.extraction.maxRetries = 0;
    expect((await terminal(context.engine, job.id)).status).toBe('failed'); expect(model.generateStructured).toHaveBeenCalledTimes(1);
    const output = context.engine.listOutputs(job.id)[0]; expect(context.engine.outputDetail(job.id, output.id).output.issues[0].message).toContain('JSON');
  });

  it.each(['pause', 'cancel'] as const)('keeps a partial response and its usage after %s during the active request', async action => {
    let began = false; const model = models(valid);
    model.generateStructured = vi.fn(async (_provider, request) => {
      began = true;
      await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      request.onResponse?.({ rawResponse: '{"partial":', text: '', inputTokens: 10, outputTokens: 4, incomplete: true });
      throw new ModelOutputError('模拟被中止的响应', { inputTokens: 10, outputTokens: 4 });
    });
    const context = harness(model); const job = start(context); await until(() => began, Boolean); context.engine.action(job.id, action);
    await until(() => getJob(context.engine, job.id).inputTokens, value => value === 10);
    expect(getJob(context.engine, job.id)).toMatchObject({ status: action === 'pause' ? 'paused' : 'cancelled', inputTokens: 10, outputTokens: 4 });
    expect(model.generateStructured).toHaveBeenCalledTimes(1); expect(context.engine.listOutputs(job.id)[0]).toMatchObject({ status: 'invalid', incomplete: true });
    expect(context.store.state(context.project.mainBranchId).chapters[0].status).toBe('pending');
  });

  it.each([401, 500])('retries HTTP %s only when the failure can be transient', async status => {
    let calls = 0; const model = models(valid);
    model.generateStructured = vi.fn(async (_provider, request, validate) => {
      calls++;
      if (calls === 1) { request.onResponse?.({ rawResponse: '{"error":"fixture"}', text: '', inputTokens: 10, outputTokens: 4, httpStatus: status }); throw new ModelOutputError('模拟 HTTP 失败', { inputTokens: 10, outputTokens: 4 }); }
      return { value: validate(extraction()), inputTokens: 10, outputTokens: 4 };
    });
    const context = harness(model); const job = start(context);
    expect((await terminal(context.engine, job.id)).status).toBe(status === 401 ? 'failed' : 'completed'); expect(model.generateStructured).toHaveBeenCalledTimes(status === 401 ? 1 : 2);
  });

  it('retries only the failed import block while preserving successful blocks and original prose', async () => {
    const text = `第一片段。${'甲'.repeat(4000)}\n第二片段。${'乙'.repeat(4000)}`; expect(splitExtractionBlocks(text)).toHaveLength(2);
    const prompts: string[] = []; let calls = 0; const model = models(request => { prompts.push(request.prompt); return ++calls === 2 ? '{"summary":' : valid(); });
    const context = harness(model, config(), null);
    const job = context.engine.enqueue(context.project.mainBranchId, 'import', { baseRevisionId: context.store.getBranch(context.project.mainBranchId).revisionId, chapters: [{ title: '原文', text }] });
    expect((await terminal(context.engine, job.id)).status).toBe('completed');
    expect(prompts).toHaveLength(3); expect(prompts[0]).toContain('[1] 第一片段'); expect(prompts[1]).toContain('[2] 第二片段'); expect(prompts[2]).toContain('[2] 第二片段');
    expect(model.generateText).not.toHaveBeenCalled(); const chapter = context.store.state(context.project.mainBranchId).chapters[0];
    expect(context.store.state(context.project.mainBranchId).chapters).toHaveLength(1); expect(context.store.chapter(context.project.mainBranchId, chapter.id).text).toBe(text);
    expect(context.engine.listOutputs(job.id).filter(output => output.status === 'applied')).toHaveLength(2);
  });

  it('retries detached extraction without ever regenerating saved prose', async () => {
    let calls = 0; const model = models(() => ++calls === 1 ? '{"summary":' : valid()); const context = harness(model, config(), null);
    const writing = context.engine.enqueue(context.project.mainBranchId, 'generate', { baseRevisionId: context.store.getBranch(context.project.mainBranchId).revisionId, mode: 'original', instruction: '描述设备检查' });
    expect((await terminal(context.engine, writing.id)).status).toBe('completed');
    const background = await until(() => context.engine.listJobs().find(job => job.kind === 'extract'), Boolean);
    expect((await terminal(context.engine, background!.id)).status).toBe('completed'); expect(model.generateText).toHaveBeenCalledTimes(1); expect(model.generateStructured).toHaveBeenCalledTimes(2);
    expect(context.store.state(context.project.mainBranchId).chapters).toHaveLength(1);
  });

  it('allows network failures to retry but does not repeat storage failures after a valid response', async () => {
    let calls = 0; const model = models(() => { if (++calls === 1) throw new Error('模拟网络中断'); return valid(); }); const context = harness(model); const job = start(context);
    expect((await terminal(context.engine, job.id)).status).toBe('completed'); expect(model.generateStructured).toHaveBeenCalledTimes(2);
    const broken = harness(models(valid)); broken.store.db.exec("CREATE TRIGGER reject_extraction BEFORE UPDATE ON branches BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END");
    const failed = start(broken); expect((await terminal(broken.engine, failed.id)).status).toBe('failed');
    expect(broken.engine.listOutputs(failed.id)).toHaveLength(1);
  });

  it('does not retry or charge when storing the request fails before sending it', async () => {
    let sent = 0; const model = models(valid);
    model.generateStructured = vi.fn(async (_provider, request, validate) => {
      try { request.onRequest?.(snapshot()); } catch { throw new Error('模拟供应商包装：保存模型请求记录失败'); }
      sent++; return { value: validate(extraction()), inputTokens: 10, outputTokens: 4 };
    });
    const context = harness(model); context.store.db.exec("CREATE TRIGGER reject_request_capture BEFORE INSERT ON model_outputs WHEN NEW.stage='extraction' BEGIN SELECT RAISE(ABORT,'simulated request capture failure'); END");
    const job = start(context);
    expect(await terminal(context.engine, job.id)).toMatchObject({ status: 'failed', inputTokens: 0, outputTokens: 0 });
    expect(model.generateStructured).toHaveBeenCalledTimes(1); expect(sent).toBe(0); expect(context.engine.listOutputs(job.id)).toHaveLength(0);
  });

  it('does not resend after storing a received response fails and still counts its returned usage once', async () => {
    const model = models(valid);
    model.generateStructured = vi.fn(async (_provider, request, validate) => {
      request.onRequest?.(snapshot());
      try { request.onResponse?.({ rawResponse: valid(), text: valid(), inputTokens: 10, outputTokens: 4, httpStatus: 200 }); }
      catch { throw new Error('模拟供应商包装：模型响应已收到，但保存原始输出失败'); }
      return { value: validate(extraction()), inputTokens: 10, outputTokens: 4 };
    });
    const context = harness(model); context.store.db.exec("CREATE TRIGGER reject_response_capture BEFORE UPDATE OF data ON model_outputs WHEN NEW.stage='extraction' AND json_extract(NEW.data,'$.rawResponse')<>'' BEGIN SELECT RAISE(ABORT,'simulated response capture failure'); END");
    const job = start(context);
    expect(await terminal(context.engine, job.id)).toMatchObject({ status: 'failed', inputTokens: 10, outputTokens: 4 });
    expect(model.generateStructured).toHaveBeenCalledTimes(1); expect(context.engine.listOutputs(job.id)).toHaveLength(1);
    expect(context.engine.listOutputs(job.id)[0].status).toBe('invalid'); expect(context.store.state(context.project.mainBranchId).chapters[0].status).toBe('pending');
  });
});
