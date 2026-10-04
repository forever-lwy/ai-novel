import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { ModelOutputError } from '../server/providers.js';
import type { Job, ModelRequest, Settings } from '../shared/types.js';

const stores: Store[] = []; const engines: StoryEngine[] = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.close(); for (const store of stores.splice(0)) store.close(); });
const settings = (): Settings => ({ providers: [{ id: 'local', name: '中性模拟服务', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'fixture', maxOutputTokens: 1000, contextTokens: 2200 }], writingProviderId: 'local', planningProviderId: 'local', extractionProviderId: 'local' });
type Work = { pass: number; index: number; completed: number; chunks: string[]; results: string[] };
type Call = { prompt: string; work: Work; maxOutputTokens: number | undefined };
async function terminal(engine: StoryEngine, jobId: string) { const deadline = Date.now() + 5000; for (;;) { const job = engine.listJobs().find(value => value.id === jobId)!; if (['completed', 'failed', 'cancelled', 'paused', 'stale'].includes(job.status)) return job; if (Date.now() > deadline) throw new Error('中性模拟压缩任务超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const shorten = (source: string) => [...new Set(source.match(/\[C\d+\]/g) ?? [])].join(' ') || [...source.trim()].slice(0, 8).join('');
function harness(reply: (call: Call, request: ModelRequest) => Promise<string> | string = call => shorten(call.prompt), config = settings()) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-summary-compression-'))); stores.push(store);
  const project = store.createProject({ title: '中性分段压缩测试' }); const calls: Call[] = [];
  const models: TextModels = {
    generateText: vi.fn(async () => { throw new Error('摘要任务不应请求小说正文'); }),
    generateStructured: vi.fn(async (_provider, request, validate) => {
      const active = store.db.prepare("SELECT data FROM jobs WHERE status='running' ORDER BY rowid DESC").all().map(row => JSON.parse(String(row.data)) as Job).find(job => job.payload.purpose === 'compress-summary');
      if (!active) return { value: validate({ summary: '后台仅完成剩余片段', entities: [], relations: [], foreshadows: [] }), inputTokens: 3, outputTokens: 4 };
      const call: Call = { prompt: request.prompt, work: structuredClone(active.payload.compressionWork as Work), maxOutputTokens: request.maxOutputTokens }; calls.push(call);
      const text = await reply(call, request); const raw = JSON.stringify({ text });
      request.onResponse?.({ rawResponse: raw, text: raw, inputTokens: 20, outputTokens: 8 });
      return { value: validate({ text }), inputTokens: 20, outputTokens: 8 };
    }),
  };
  const engine = new StoryEngine(store, () => config, models); engines.push(engine); engine.start();
  return { store, project, engine, models, calls };
}
function seed(ctx: ReturnType<typeof harness>, count = 6, size = 1200) {
  const branchId = ctx.project.mainBranchId;
  for (let index = 1; index <= count; index++) {
    let view = ctx.store.saveChapter(branchId, { baseRevisionId: ctx.store.getBranch(branchId).revisionId, title: `中性章节${index}`, text: `章节${index}正文。` });
    view = ctx.store.applyExtraction(branchId, view.branch.revisionId, view.state.chapters.at(-1)!.id, { summary: `[C${index}]${'中性已发生剧情'.repeat(size)}`, entities: [], relations: [], foreshadows: [] }, true);
  }
  return ctx.store.view(branchId, true);
}
function start(ctx: ReturnType<typeof harness>) { return ctx.engine.enqueue(ctx.project.mainBranchId, 'plan', { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, purpose: 'compress-summary' }); }

describe('durable segmented plot-summary compression', () => {
  it('covers every oversized summary source, merges its candidates, and changes writing context only after author confirmation', async () => {
    const ctx = harness(); const before = seed(ctx, 4, 300); const writingRevision = before.branch.revisionId; const compression = start(ctx);
    expect((await terminal(ctx.engine, compression.id)).status).toBe('completed');
    const firstPass = ctx.calls.filter(call => call.work.pass === 0);
    expect(firstPass.length).toBeGreaterThan(1);
    expect(firstPass.map(call => call.prompt).join('')).toBe(before.state.chapters.map(chapter => `${chapter.title}\n${chapter.summary}`).join('\n\n'));
    expect(ctx.calls.some(call => call.work.pass === 1 && call.work.chunks.length === 1)).toBe(true);
    expect(ctx.calls.every(call => call.maxOutputTokens === 1000)).toBe(true);
    const proposal = ctx.engine.summaryCompression(compression.id);
    expect(proposal.chapterIds).toEqual(before.state.chapters.map(chapter => chapter.id));
    for (let index = 1; index <= 4; index++) expect(proposal.text).toContain(`[C${index}]`);
    expect(ctx.store.getBranch(ctx.project.mainBranchId).revisionId).toBe(writingRevision);
    expect(ctx.store.state(ctx.project.mainBranchId).outline.summaryCompression).toBeUndefined();
    expect(ctx.engine.listOutputs(compression.id)).toHaveLength(ctx.calls.length);
    expect(ctx.engine.listOutputs(compression.id).every(output => output.status === 'applied')).toBe(true);
    const confirmed = ctx.engine.confirmSummaryCompression(ctx.project.mainBranchId, { baseRevisionId: writingRevision, jobId: compression.id, text: proposal.text });
    expect(confirmed.state.outline.summaryCompression).toEqual({ text: proposal.text, chapterIds: proposal.chapterIds });
    expect(confirmed.state.chapters.map(chapter => chapter.summary)).toEqual(before.state.chapters.map(chapter => chapter.summary));
  });

  it('retries only the unfinished segment and preserves completed paid requests across backup restoration', async () => {
    let failed = false;
    const ctx = harness((call, request) => {
      if (call.work.pass === 0 && call.work.index === 1 && !failed) {
        failed = true; request.onResponse?.({ rawResponse: '中性模拟响应中断', text: '', inputTokens: 7, outputTokens: 3, incomplete: true });
        throw new ModelOutputError('中性模拟压缩片段中断', { inputTokens: 7, outputTokens: 3 });
      }
      return shorten(call.prompt);
    });
    seed(ctx, 2, 300); const compression = start(ctx); expect((await terminal(ctx.engine, compression.id)).status).toBe('failed');
    const firstSource = ctx.calls[0].prompt;
    expect(ctx.engine.listOutputs(compression.id).filter(output => output.status === 'applied')).toHaveLength(1);
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
    const recovered = ctx.engine.listJobs(restored.id).find(job => job.purpose === 'compress-summary')!;
    ctx.engine.action(recovered.id, 'retry'); expect((await terminal(ctx.engine, recovered.id)).status).toBe('completed');
    expect(ctx.calls.filter(call => call.work.pass === 0 && call.work.index === 0 && call.prompt === firstSource)).toHaveLength(1);
    expect(ctx.calls.filter(call => call.work.pass === 0 && call.work.index === 1)).toHaveLength(2);
    const proposal = ctx.engine.summaryCompression(recovered.id);
    const restoredView = ctx.store.view(restored.mainBranchId, true);
    expect(proposal.chapterIds).toEqual(restoredView.state.chapters.map(chapter => chapter.id));
    expect(ctx.engine.confirmSummaryCompression(restored.mainBranchId, { baseRevisionId: restoredView.branch.revisionId, jobId: recovered.id, text: proposal.text }).state.outline.summaryCompression?.text).toBe(proposal.text);
  });

  it('rejects a segment that did not shrink and accepts a manual repair before continuing the remaining segments', async () => {
    let invalid = false;
    const ctx = harness(call => {
      if (call.work.pass === 0 && call.work.index === 1 && !invalid) { invalid = true; return call.prompt; }
      return shorten(call.prompt);
    });
    seed(ctx, 2, 300); const compression = start(ctx); expect((await terminal(ctx.engine, compression.id)).status).toBe('failed');
    const output = ctx.store.outputs.get(ctx.engine.listOutputs(compression.id)[0].id)!;
    expect(output.status).toBe('invalid'); expect(output.issues[0].message).toContain('更短');
    const repaired = ctx.engine.applyOutput(compression.id, output.id, { baseRevisionId: compression.baseRevisionId, text: JSON.stringify({ text: '作者整理的关键剧情。' }) });
    expect(repaired.status).toBe('paused');
    expect(ctx.store.state(ctx.project.mainBranchId).outline.summaryCompression).toBeUndefined();
    ctx.engine.action(compression.id, 'resume'); expect((await terminal(ctx.engine, compression.id)).status).toBe('completed');
    expect(ctx.calls.filter(call => call.work.pass === 0 && call.work.index === 1)).toHaveLength(1);
    expect(ctx.calls.filter(call => call.work.pass === 0 && call.work.index === 0)).toHaveLength(1);
    expect(ctx.engine.summaryCompression(compression.id).text).not.toBe('');
  });

  it('stops after three passes when candidates remain too long instead of looping or lowering output limits', async () => {
    const ctx = harness(call => { const text = [...call.prompt.trim()]; return text.slice(0, Math.max(1, text.length - 4)).join(''); });
    seed(ctx, 1, 600); const compression = start(ctx); const result = await terminal(ctx.engine, compression.id);
    expect(result.status).toBe('failed'); expect(result.error).toContain('3 轮');
    expect(Math.max(...ctx.calls.map(call => call.work.pass))).toBe(2);
    expect(ctx.calls.every(call => call.maxOutputTokens === 1000)).toBe(true);
    expect(ctx.store.state(ctx.project.mainBranchId).outline.summaryCompression).toBeUndefined();
    expect(() => ctx.engine.summaryCompression(compression.id)).toThrow('尚未生成完成');
  });

  it('moves a legacy failed generation into a separate extraction job without repeating writing or completed extraction blocks', async () => {
    const config = settings(); config.providers[0].contextTokens = 64000;
    const ctx = harness(undefined, config); const branchId = ctx.project.mainBranchId;
    let view = ctx.store.saveChapter(branchId, { baseRevisionId: ctx.store.getBranch(branchId).revisionId, title: '旧任务章节', text: `${'第一片段'.repeat(1200)}\n${'第二片段'.repeat(1200)}` });
    const chapterId = view.state.chapters[0].id;
    view = ctx.store.applyExtraction(branchId, view.branch.revisionId, chapterId, { summary: '已完成的第一片段摘要', entities: [], relations: [], foreshadows: [] }, false);
    const legacy: Job = { id: 'legacy-writing', projectId: ctx.project.id, branchId, kind: 'generate', status: 'failed', baseRevisionId: view.branch.revisionId, progress: 0, total: 1, message: '旧任务整理失败', error: '中性旧任务提取错误', inputTokens: 0, outputTokens: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), payload: { generatedChapterId: chapterId, extractChapterId: chapterId, blockIndex: 1, mode: 'original' } };
    ctx.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(legacy.id, branchId, ctx.project.id, legacy.status, JSON.stringify(legacy));
    ctx.engine.action(legacy.id, 'retry'); const recoveredWriting = await terminal(ctx.engine, legacy.id); expect(recoveredWriting.status).toBe('completed'); expect(recoveredWriting.error).toBeUndefined();
    const background = ctx.engine.listJobs().find(job => job.kind === 'extract')!;
    expect((await terminal(ctx.engine, background.id)).status).toBe('completed');
    expect(ctx.models.generateText).not.toHaveBeenCalled(); expect(ctx.models.generateStructured).toHaveBeenCalledTimes(1);
    expect(ctx.store.state(branchId).chapters[0].summary).toBe('已完成的第一片段摘要\n后台仅完成剩余片段');
    expect(ctx.engine.writingSnapshot(legacy.id).text).toBe(ctx.store.chapter(branchId, chapterId).text);
  });
});
