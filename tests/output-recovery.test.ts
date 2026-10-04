import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { ModelOutputError, parseStructuredText } from '../server/providers.js';
import type { ExtractionResult, Job, ModelRequest, PlanningResult, Settings } from '../shared/types.js';

const cleanup: { store: Store; engine: StoryEngine }[] = [];
afterEach(async () => { for (const context of cleanup.splice(0)) { await context.engine.close(); context.store.close(); } });
const extraction = (): ExtractionResult => ({ summary: '记录员完成检查。', entities: [], relations: [], foreshadows: [] });
const planning = (): PlanningResult => ({ fine: [1, 2, 3, 4].map(chapter => ({ chapter, title: `第${chapter}章`, goal: '检查设备并记录线索。' })), foreshadows: [] });
const settings = (): Settings => ({ providers: [{ id: 'fixture', name: '中性模拟服务', protocol: 'gemini', baseUrl: 'http://unused.invalid', model: 'fixture', apiKey: 'test-configured-key-DO-NOT-PERSIST', maxOutputTokens: 4096, contextTokens: 64000 }], planningProviderId: 'fixture', writingProviderId: 'fixture', extractionProviderId: 'fixture' });
function provider(response: (request: ModelRequest, writing: boolean) => Promise<string> | string): TextModels {
  const text = async (request: ModelRequest, writing: boolean) => { const body = await response(request, writing); request.onResponse?.({ rawResponse: JSON.stringify({ candidates: [{ content: { parts: [{ text: body }] } }] }), text: body, inputTokens: 13, outputTokens: 21, httpStatus: 200 }); return body; };
  return {
    generateText: async (_config, request) => ({ text: await text(request, true), inputTokens: 13, outputTokens: 21 }),
    generateStructured: async (_config, request, validate) => { const body = await text(request, false); try { return { value: parseStructuredText(body, validate), inputTokens: 13, outputTokens: 21 }; } catch (error) { throw new ModelOutputError('模拟结构化输出验证失败', { inputTokens: 13, outputTokens: 21 }, error instanceof ModelOutputError ? error.issues : undefined); } },
  };
}
function make(model: TextModels, text?: string) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ai-novel-output-'))); const project = store.createProject({ title: '灯塔记录' });
  if (text) store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: '检查记录', text });
  const engine = new StoryEngine(store, settings, model); cleanup.push({ store, engine }); engine.start(); return { store, project, engine };
}
async function until<T>(get: () => T, done: (value: T) => boolean): Promise<T> { const deadline = Date.now() + 4000; for (;;) { const value = get(); if (done(value)) return value; if (Date.now() > deadline) throw new Error('模拟任务未及时达到预期状态'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const waitJob = (engine: StoryEngine, id: string) => until(() => engine.listJobs().find(job => job.id === id)!, job => ['failed', 'completed', 'cancelled', 'stale'].includes(job.status));
function enqueueExtract(context: ReturnType<typeof make>) { return context.engine.enqueue(context.project.mainBranchId, 'extract', { baseRevisionId: context.store.getBranch(context.project.mainBranchId).revisionId }); }
const apply = (engine: StoryEngine, job: Job, outputId: string, text: string) => engine.applyOutput(job.id, outputId, { baseRevisionId: engine.outputDetail(job.id, outputId).output.baseRevisionId, text });

describe('author-only persisted model output recovery (neutral, simulated responses)', () => {
  it('persists invalid JSON before parsing, keeps failed edits, and applies a corrected result without another request', async () => {
    let calls = 0; const original = '{"summary":'; const context = make(provider(() => { calls++; return original; }), '记录员检查灯塔。'); const job = enqueueExtract(context);
    expect((await waitJob(context.engine, job.id)).status).toBe('failed');
    const summary = context.engine.listOutputs(job.id)[0]; expect(summary.status).toBe('invalid'); expect(summary).not.toHaveProperty('rawResponse'); expect(summary).not.toHaveProperty('text');
    const before = context.engine.outputDetail(job.id, summary.id); expect(before.output.text).toBe(original); expect(before.output.rawResponse).toContain('candidates'); expect(before.canApply).toBe(true);
    const stillInvalid = JSON.stringify({ ...extraction(), summary: 123 });
    expect(() => apply(context.engine, job, summary.id, stillInvalid)).toThrow('仍未通过校验');
    let detail = context.engine.outputDetail(job.id, summary.id); expect(detail.output.editedText).toBe(stillInvalid); expect(detail.output.issues.some(issue => issue.path === 'summary')).toBe(true); expect(detail.output.rawResponse).toBe(before.output.rawResponse);
    const revised = `\`\`\`json\n${JSON.stringify(extraction())}\n\`\`\``;
    const completed = apply(context.engine, job, summary.id, revised); expect(completed.status).toBe('completed'); expect(calls).toBe(1);
    detail = context.engine.outputDetail(job.id, summary.id); expect(detail.output.status).toBe('applied'); expect(detail.output.text).toBe(original); expect(detail.output.editedText).toBe(revised); expect(detail.output.issues).toEqual([]);
    expect(() => apply(context.engine, job, summary.id, revised)).toThrow('已经应用'); expect(context.store.state(context.project.mainBranchId).chapters[0].status).toBe('ready');
  });

  it('reports exact quote paths and numbered source text, while keeping private evidence out of job errors', async () => {
    const source = '记录员说：“灯塔运转正常。”随后关闭笔记。'; const wrong = '记录员说：“灯塔运转故障。”随后关闭笔记。';
    const value = extraction(); value.entities.push({ kind: 'character', name: '记录员', aliases: [], description: '负责检查设备', visibility: 'public', facts: [{ text: '记录灯塔状态', temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 18, quote: wrong }] });
    let calls = 0; const context = make(provider(() => { calls++; return JSON.stringify(value); }), Array.from({ length: 20 }, (_, i) => i === 17 ? source : `第${i + 1}项设备记录。`).join('\n')); const job = enqueueExtract(context);
    const failed = await waitJob(context.engine, job.id); expect(failed.status).toBe('failed'); expect(failed.error).not.toContain(source); expect(failed.error).not.toContain(wrong);
    const outputId = context.engine.listOutputs(job.id)[0].id; const detail = context.engine.outputDetail(job.id, outputId);
    expect(detail.output.issues).toEqual([{ path: 'entities[0].facts[0].quote', message: expect.any(String), paragraph: 18, quote: wrong, sourceText: source }]); expect(detail.sourceParagraphs).toContainEqual({ paragraph: 18, text: source });
    value.entities[0].facts[0].quote = source; expect(apply(context.engine, job, outputId, JSON.stringify(value)).status).toBe('completed'); expect(calls).toBe(1);
    expect(context.store.state(context.project.mainBranchId).entities[0].facts[0].citation?.quote).toBe(source);
    expect(context.store.chapter(context.project.mainBranchId, context.store.state(context.project.mainBranchId).chapters[0].id).text).toContain(source);
  });

  it('persists business-invalid planning and applies a full four-chapter plan locally', async () => {
    let calls = 0; const badPlan = planning(); badPlan.fine = badPlan.fine.slice(0, 1); const context = make(provider(() => { calls++; return JSON.stringify(badPlan); }));
    const job = context.engine.enqueue(context.project.mainBranchId, 'plan', { baseRevisionId: context.store.getBranch(context.project.mainBranchId).revisionId }); await waitJob(context.engine, job.id);
    const outputId = context.engine.listOutputs(job.id)[0].id; expect(context.engine.outputDetail(job.id, outputId).output.issues[0].path).toBe('fine');
    expect(apply(context.engine, job, outputId, JSON.stringify(planning())).status).toBe('completed'); expect(calls).toBe(1); expect(context.store.state(context.project.mainBranchId).outline.fine).toHaveLength(4);
  });

  it('keeps truncated writing, applies corrected prose, and pauses before any extraction request', async () => {
    let calls = 0;
    const model = provider(() => { calls++; return JSON.stringify(extraction()); });
    model.generateText = async (_config, request) => { calls++; request.onResponse?.({ rawResponse: '{"partial":true}', text: '记录员走向灯塔，', incomplete: true, httpStatus: 200, inputTokens: 10, outputTokens: 20 }); throw new ModelOutputError('模拟正文截断', { inputTokens: 10, outputTokens: 20 }); };
    const context = make(model); context.store.updateOutline(context.project.mainBranchId, context.store.getBranch(context.project.mainBranchId).revisionId, { ...planning(), locked: '', fine: planning().fine });
    const job = context.engine.enqueue(context.project.mainBranchId, 'generate', { baseRevisionId: context.store.getBranch(context.project.mainBranchId).revisionId, mode: 'original', instruction: '描述一次设备检查' }); await waitJob(context.engine, job.id);
    const outputId = context.engine.listOutputs(job.id)[0].id; const envelope = JSON.stringify({ choices: [{ message: { content: '记录员走向灯塔，完成了检查。' } }] });
    expect(apply(context.engine, job, outputId, envelope).status).toBe('completed'); expect(calls).toBe(1); expect(context.store.exportText(context.project.mainBranchId)).toContain('记录员走向灯塔，完成了检查。'); expect(context.store.state(context.project.mainBranchId).chapters[0].status).toBe('pending');
    const background = context.engine.listJobs(context.project.id).find(item => item.kind === 'extract')!;
    expect(background.id).not.toBe(job.id); expect(background.status).toBe('paused'); expect(context.engine.listOutputs(background.id)).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 20)); expect(calls).toBe(1);
    context.engine.action(background.id, 'resume'); expect((await waitJob(context.engine, background.id)).status).toBe('completed'); expect(calls).toBe(2); expect(context.store.state(context.project.mainBranchId).chapters).toHaveLength(1); expect(context.store.state(context.project.mainBranchId).chapters[0].status).toBe('ready');
    expect(context.engine.listJobs(context.project.id).find(item => item.id === job.id)?.status).toBe('completed');
  });

  it('imports legacy pasted envelopes, redacts configured keys, and preserves outputs across backup restoration', async () => {
    const context = make(provider(() => { throw new Error('模拟旧任务断网'); }), '记录员检查设备。'); const job = enqueueExtract(context); await waitJob(context.engine, job.id); expect(context.engine.listOutputs(job.id)).toEqual([]);
    const value = extraction(); value.summary = `检查完毕 ${settings().providers[0].apiKey}`;
    const envelope = JSON.stringify({ Authorization: 'Bearer pasted-key-not-in-settings', candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
    const imported = context.engine.importOutput(job.id, envelope); expect(imported.text).toContain('"summary"'); expect(imported.text).not.toContain('candidates'); expect(imported.rawResponse).toContain('candidates'); expect(JSON.stringify(imported)).not.toContain(settings().providers[0].apiKey!); expect(JSON.stringify(imported)).not.toContain('pasted-key-not-in-settings');
    expect(() => apply(context.engine, job, imported.id, `{ "secret": "${settings().providers[0].apiKey}" }`)).toThrow('仍未通过校验');
    expect(context.engine.outputDetail(job.id, imported.id).output.editedText).not.toContain(settings().providers[0].apiKey!);
    const restored = context.store.restoreProject(context.store.exportProject(context.project.id)); const restoredJob = context.engine.listJobs(restored.id)[0]; const restoredOutput = context.engine.listOutputs(restoredJob.id)[0]; expect(restoredOutput.id).not.toBe(imported.id); expect(restoredOutput.branchId).toBe(restored.mainBranchId);
    expect(context.engine.outputDetail(restoredJob.id, restoredOutput.id).canApply).toBe(true); expect(apply(context.engine, restoredJob, restoredOutput.id, JSON.stringify(extraction())).status).toBe('completed');
    expect(context.engine.outputDetail(job.id, imported.id).output.status).toBe('invalid');
  });

  it('retains late cancelled and stale responses while refusing their application', async () => {
    for (const mode of ['cancel', 'stale'] as const) {
      let resolve!: (value: string) => void; let began = false; const delayed = new Promise<string>(r => { resolve = r; });
      const context = make(provider(() => { began = true; return delayed; }), '记录员检查设备。'); const job = enqueueExtract(context); await until(() => began, Boolean);
      if (mode === 'cancel') context.engine.action(job.id, 'cancel'); else context.store.updateOutline(context.project.mainBranchId, context.store.getBranch(context.project.mainBranchId).revisionId, { worldview: '已更新的世界观', locked: '', fine: [] });
      resolve(JSON.stringify(extraction())); await until(() => context.engine.listOutputs(job.id), outputs => outputs.length === 1); await new Promise(r => setTimeout(r, 10));
      const output = context.engine.listOutputs(job.id)[0]; const detail = context.engine.outputDetail(job.id, output.id); expect(detail.canApply).toBe(false); expect(detail.output.text).toContain('summary'); expect(() => apply(context.engine, job, output.id, JSON.stringify(extraction()))).toThrow();
      expect(context.store.state(context.project.mainBranchId).chapters[0].status).toBe('pending');
    }
  });

  it('limits extraction reference prose to earlier chapters and resumes after local fragment repair without repeating the block', async () => {
    let calls = 0; const prompts: string[] = [];
    const context = make(provider(request => { calls++; prompts.push(request.prompt); return calls === 1 ? '{"unfinished":' : JSON.stringify(extraction()); }), `记录员检查设备。\n${'中性测试'.repeat(1300)}\n只应出现在第二片段的尾段。${'海面平静'.repeat(200)}`);
    const job = enqueueExtract(context); await waitJob(context.engine, job.id); expect(prompts[0]).not.toContain('只应出现在第二片段的尾段'); expect(prompts[0]).not.toContain('承接处正文');
    const output = context.engine.listOutputs(job.id)[0]; expect(context.engine.outputDetail(job.id, output.id).sourceParagraphs.map(p => p.paragraph)).toEqual([1, 2]);
    expect(apply(context.engine, job, output.id, JSON.stringify(extraction())).status).toBe('paused'); expect(calls).toBe(1);
    context.engine.action(job.id, 'resume'); expect((await waitJob(context.engine, job.id)).status).toBe('completed'); expect(calls).toBe(2); expect(prompts[1]).toContain('[3] 只应出现在第二片段的尾段');
  });

  it('waits for abort-time partial response persistence before shutdown completes', async () => {
    let began = false; let captured = false;
    const model: TextModels = { generateText: async () => { throw new Error('未使用写作'); }, generateStructured: async (_config, request) => {
      began = true; await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => { setTimeout(() => { request.onResponse?.({ rawResponse: '{"incomplete":', text: '', incomplete: true, inputTokens: 0, outputTokens: 0 }); captured = true; resolve(); }, 20); }, { once: true })); throw new ModelOutputError('模拟响应读取中断', { inputTokens: 0, outputTokens: 0 });
    } };
    const context = make(model, '记录员检查设备。'); const job = enqueueExtract(context); await until(() => began, Boolean); await context.engine.close(); expect(captured).toBe(true);
    const output = context.engine.listOutputs(job.id)[0]; expect(output.incomplete).toBe(true); expect(context.engine.outputDetail(job.id, output.id).output.rawResponse).toBe('{"incomplete":'); expect(context.store.state(context.project.mainBranchId).chapters[0].status).toBe('pending');
  });
});
