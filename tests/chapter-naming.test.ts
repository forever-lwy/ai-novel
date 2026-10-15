import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { Store } from '../server/store.js';
import { generateStructured } from '../server/providers.js';
import { parseGeneratedChapterTitle } from '../server/chapter-naming.js';
import { parseVisualOutput } from '../client/output-form.js';
import { listenLocalServer } from './local-server.mjs';
import type { Job, ModelRequest, ProviderProtocol, Settings } from '../shared/types.js';

const prose = '林舟来到石桥，发现守桥人留下的一封信。\n\n信中约他明早在灯塔见面。';
const extraction = { summary: '林舟在石桥发现信件，收到灯塔之约。', entities: [], relations: [], foreshadows: [] };
const engines: StoryEngine[] = []; const stores: Store[] = []; const servers: Server[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const store of stores.splice(0)) store.close();
});
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function until<T>(read: () => T, valid: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) { const value = read(); if (valid(value)) return value; if (Date.now() > deadline) throw new Error('章节命名测试等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function models(title: (request: ModelRequest) => unknown | Promise<unknown> = () => ({ title: '石桥来信' }), extract: () => unknown | Promise<unknown> = () => extraction): TextModels {
  return {
    generateText: vi.fn(async (_provider, request) => { request.onTextDelta?.(prose); return { text: prose, inputTokens: 10, outputTokens: 12 }; }),
    generateStructured: vi.fn(async (_provider, request, validate) => {
      const value = await (request.system.includes('# 章节自动命名') ? title(request) : extract()); const text = JSON.stringify(value);
      request.onResponse?.({ rawResponse: text, text, inputTokens: 3, outputTokens: 4 });
      return { value: validate(value), inputTokens: 3, outputTokens: 4 };
    }),
  };
}
function harness(model = models(), config?: Settings, store = new Store(mkdtempSync(join(tmpdir(), 'novel-auto-title-')))) {
  if (!stores.includes(store)) stores.push(store);
  const settings: Settings = config ?? { providers: [{ id: 'mock', name: '本地模拟', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'writer', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'mock', extractionProviderId: 'mock', planningProviderId: 'mock', taskSettings: { extraction: { autoRetry: true, maxRetries: 2, retryDelayMs: 0 } } };
  const project = store.createProject({ title: '自动题名测试' }); const engine = new StoryEngine(store, () => settings, model); engines.push(engine); engine.start();
  return { store, project, engine, model, settings };
}
type Context = ReturnType<typeof harness>;
const start = (ctx: Context, input: Record<string, unknown> = {}) => ctx.engine.enqueue(ctx.project.mainBranchId, 'generate', { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, mode: 'original', instruction: '接着正文写', ...input });
const getJob = (ctx: Context, id: string) => ctx.engine.listJobs().find(job => job.id === id)!;
const terminal = (ctx: Context, id: string) => until(() => getJob(ctx, id), job => ['completed', 'failed', 'paused', 'cancelled', 'stale'].includes(job.status));
const background = (ctx: Context, branchId = ctx.project.mainBranchId) => until(() => ctx.engine.listJobs().find(job => job.kind === 'extract' && job.branchId === branchId), Boolean) as Promise<Job>;

describe('automatic chapter naming after saved prose', () => {
  it.each([undefined, '', ' \t\n '])('names a blank title (%j), saves it in the current line and keeps it out of prose', async title => {
    const requests: ModelRequest[] = []; const ctx = harness(models(request => { requests.push(request); return { title: '石桥来信' }; }));
    const writing = start(ctx, { title }); await terminal(ctx, writing.id); const work = await background(ctx); expect((await terminal(ctx, work.id)).status).toBe('completed');
    const ref = ctx.store.state(writing.branchId).chapters[0];
    expect(ref).toMatchObject({ title: '石桥来信', status: 'ready', summary: extraction.summary });
    expect(ctx.store.chapter(writing.branchId, ref.id).text).toBe(prose);
    expect(ctx.store.exportText(writing.branchId)).toBe(`石桥来信\n\n${prose}`);
    expect(ctx.store.readingState(writing.branchId, ref.id).chapters[0].title).toBe('石桥来信');
    expect(ctx.engine.writingSnapshot(writing.id).title).toBe('石桥来信');
    expect(getJob(ctx, writing.id).generationInput?.title).toBeUndefined();
    expect(requests).toHaveLength(1); expect(JSON.parse(requests[0].prompt)).toEqual({ text: prose });
    expect(JSON.stringify(requests[0])).not.toContain(ref.id); expect(JSON.stringify(requests[0])).not.toContain(writing.id);
    expect(ctx.engine.listOutputs(work.id).find(output => output.stage === 'chapter-title')).toMatchObject({ status: 'applied', chapterId: ref.id });
    expect(ctx.store.listBranches(ctx.project.id)).toHaveLength(1);
  });

  it.each(['作者指定的题名', '第17章 作者确定的编号', '新章节'])('preserves a manually supplied title %s and skips the naming request', async title => {
    const name = vi.fn(() => ({ title: '不应覆盖作者标题' })); const ctx = harness(models(name));
    const writing = start(ctx, { title: ` ${title} ` }); await terminal(ctx, writing.id); expect((await terminal(ctx, (await background(ctx)).id)).status).toBe('completed');
    expect(ctx.store.state(writing.branchId).chapters[0].title).toBe(title); expect(name).not.toHaveBeenCalled();
    expect(ctx.model.generateStructured).toHaveBeenCalledTimes(1);
  });

  it('saves prose before naming, then retries only extraction after the title has been saved', async () => {
    const gate = deferred<unknown>(); let extracts = 0;
    const ctx = harness(models(() => gate.promise, () => { if (++extracts === 1) throw new Error('整理暂时失败'); return extraction; }));
    ctx.settings.taskSettings!.extraction.autoRetry = false;
    const writing = start(ctx); expect((await terminal(ctx, writing.id)).status).toBe('completed');
    const work = await background(ctx); await until(() => ctx.model.generateStructured, method => vi.mocked(method).mock.calls.length > 0);
    expect(ctx.store.state(writing.branchId).chapters[0].title).toBe('新章节');
    expect(ctx.store.chapter(writing.branchId, ctx.store.state(writing.branchId).chapters[0].id).text).toBe(prose);
    gate.resolve({ title: '石桥来信' }); expect((await terminal(ctx, work.id)).status).toBe('failed');
    expect(ctx.store.state(writing.branchId).chapters[0].title).toBe('石桥来信');
    ctx.engine.action(work.id, 'retry'); expect((await terminal(ctx, work.id)).status).toBe('completed');
    expect(ctx.model.generateText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.model.generateStructured).mock.calls.filter(([, request]) => request.system.includes('# 章节自动命名'))).toHaveLength(1);
  });

  it('keeps prose and diagnostics after naming failure, supports a local title correction and continues extraction without calling writing again', async () => {
    const name = vi.fn(() => ({ title: '第13章 猜测编号' })); const ctx = harness(models(name)); const writing = start(ctx); await terminal(ctx, writing.id);
    const work = await background(ctx); expect((await terminal(ctx, work.id)).status).toBe('failed'); expect(name).toHaveBeenCalledTimes(1);
    const output = ctx.engine.listOutputs(work.id).find(item => item.stage === 'chapter-title')!;
    expect(ctx.engine.outputDetail(work.id, output.id).canApply).toBe(true);
    expect(ctx.store.chapter(writing.branchId, ctx.store.state(writing.branchId).chapters[0].id).text).toBe(prose);
    const imported = ctx.engine.importOutput(work.id, '{"title":"灯塔之约"}'); expect(imported.stage).toBe('chapter-title');
    const corrected = ctx.engine.applyOutput(work.id, imported.id, { text: imported.text, baseRevisionId: imported.baseRevisionId }); expect(corrected.status).toBe('paused');
    ctx.engine.action(work.id, 'resume'); expect((await terminal(ctx, work.id)).status).toBe('completed');
    expect(ctx.store.state(writing.branchId).chapters[0].title).toBe('灯塔之约'); expect(ctx.model.generateText).toHaveBeenCalledTimes(1); expect(name).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'revision'])('rejects a late naming result after %s', async change => {
    const gate = deferred<unknown>(); const name = vi.fn(() => gate.promise); const ctx = harness(models(name)); const writing = start(ctx); await terminal(ctx, writing.id);
    const work = await background(ctx); await until(() => name.mock.calls.length, Boolean);
    if (change === 'cancel') ctx.engine.action(work.id, 'cancel');
    else {
      const ref = ctx.store.state(writing.branchId).chapters[0];
      ctx.store.updateChapterTitles(writing.branchId, ctx.store.getBranch(writing.branchId).revisionId, [{ chapterId: ref.id, originalTitle: ref.title, title: '作者的新题名' }]);
    }
    gate.resolve({ title: '迟到的题名' });
    await until(() => ctx.engine.listOutputs(work.id)[0]?.status, status => status === 'invalid');
    expect((await terminal(ctx, work.id)).status).toBe(change === 'cancel' ? 'cancelled' : 'stale');
    expect(ctx.store.state(writing.branchId).chapters[0].title).toBe(change === 'cancel' ? '新章节' : '作者的新题名');
    expect(ctx.model.generateText).toHaveBeenCalledTimes(1);
  });

  it('names a cleared regeneration title using the completed chapter and leaves the original line intact, including an unchanged generated title', async () => {
    const name = vi.fn(() => ({ title: '石桥来信' })); const ctx = harness(models(name));
    const original = ctx.store.saveChapter(ctx.project.mainBranchId, { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, title: '石桥来信', text: '旧桥上的原始事件。' });
    ctx.store.applyExtraction(original.branch.id, original.branch.revisionId, original.state.chapters[0].id, extraction, true);
    const writing = start(ctx, { title: '', chapterId: original.state.chapters[0].id, regenerate: true }); await terminal(ctx, writing.id);
    expect((await terminal(ctx, (await background(ctx, writing.branchId)).id)).status).toBe('completed');
    expect(name).toHaveBeenCalledTimes(1); expect(ctx.store.state(writing.branchId).chapters[0].title).toBe('石桥来信');
    expect(ctx.store.exportText(original.branch.id)).toBe('石桥来信\n\n旧桥上的原始事件。');
  });

  it('restores a pending naming task with remapped chapter and writing-job references', async () => {
    const gate = deferred<unknown>(); const name = vi.fn(() => gate.promise); const ctx = harness(models(name)); const writing = start(ctx); await terminal(ctx, writing.id);
    const work = await background(ctx); await until(() => name.mock.calls.length, Boolean);
    const backup = ctx.store.exportProject(ctx.project.id); ctx.engine.action(work.id, 'cancel'); gate.resolve({ title: '取消的旧结果' });
    await until(() => ctx.engine.listOutputs(work.id)[0]?.status, value => value === 'invalid');
    const restored = ctx.store.restoreProject(backup); const recovered = await background(ctx, restored.mainBranchId);
    expect(recovered.status).toBe('paused'); expect(recovered.id).not.toBe(work.id);
    name.mockImplementation(() => Promise.resolve({ title: '恢复后的来信' })); ctx.engine.action(recovered.id, 'resume'); expect((await terminal(ctx, recovered.id)).status).toBe('completed');
    expect(ctx.store.state(restored.mainBranchId).chapters[0].title).toBe('恢复后的来信'); expect(ctx.model.generateText).toHaveBeenCalledTimes(1);
    expect(() => ctx.store.restoreProject(ctx.store.exportProject(restored.id))).not.toThrow();
  });

  it.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('runs the real %s HTTP title adapter once with only the full chapter text', async protocol => {
    const bodies: any[] = [];
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      const text = '{"title":"石桥来信"}';
      const result = protocol === 'openai-chat' ? { choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
        : protocol === 'openai-responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 } }
        : protocol === 'gemini' ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }
        : { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
      res.writeHead(200, { 'content-type': 'application/json', Connection: 'close' }); res.end(JSON.stringify(result));
    }); servers.push(server); await listenLocalServer(server); const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
    const model = models(); model.generateStructured = async (provider, request, validate) => request.system.includes('# 章节自动命名') ? generateStructured(provider, request, validate) : { value: validate(extraction), inputTokens: 1, outputTokens: 1 };
    const ctx = harness(model, { providers: [{ id: 'http', name: '本地 HTTP', protocol, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'writer', apiKey: 'fake-naming-key', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'http', extractionProviderId: 'http', planningProviderId: 'http' });
    const writing = start(ctx); await terminal(ctx, writing.id); const work = await background(ctx); expect((await terminal(ctx, work.id)).status).toBe('completed');
    expect(bodies).toHaveLength(1); const body = bodies[0];
    const prompts = protocol === 'openai-chat' || protocol === 'claude' ? body.messages.filter((message: any) => message.role === 'user').map((message: any) => message.content)
      : protocol === 'openai-responses' ? typeof body.input === 'string' ? [body.input] : body.input.filter((message: any) => message.role === 'user').map((message: any) => message.content)
      : body.contents.map((message: any) => message.parts.map((part: any) => part.text).join(''));
    expect(prompts).toEqual([JSON.stringify({ text: prose })]);
    const output = ctx.engine.outputDetail(work.id, ctx.engine.listOutputs(work.id).find(item => item.stage === 'chapter-title')!.id).output;
    expect(output).toMatchObject({ status: 'applied', request: { protocol, model: 'writer' } }); expect(JSON.stringify(output)).not.toContain('fake-naming-key');
  });
});

describe('generated title validation and correction form', () => {
  it.each(['', '新章节', '第十三章 雨夜', 'Chapter 13 Rain', '13. 雨夜', '# 雨夜', '雨夜\n来信', '长'.repeat(81)])('rejects invalid automatic title %j', title => {
    expect(() => parseGeneratedChapterTitle({ title })).toThrow();
  });
  it('accepts a concrete title containing a number as story content and exposes a title-only correction form', () => {
    expect(parseGeneratedChapterTitle({ title: ' 七日之约 ' })).toEqual({ title: '七日之约' });
    expect(parseVisualOutput('{"title":"七日之约"}', 'chapter-title')).toMatchObject({ ok: true, value: { title: '七日之约' } });
    expect(parseVisualOutput('{"summary":"不是标题"}', 'chapter-title')).toMatchObject({ ok: false });
  });
});
