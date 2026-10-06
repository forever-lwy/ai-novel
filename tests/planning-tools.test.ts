import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { buildWritingContext } from '../server/writing-context.js';
import { defaultTaskSettings } from '../shared/task-settings.js';
import type { Job, ModelRequest, PlanningResult, Settings } from '../shared/types.js';

const fixtures: { store: Store; engine: StoryEngine }[] = [];
afterEach(async () => { for (const { store, engine } of fixtures.splice(0)) { await engine.close(); store.close(); } });
const text = '旅人抵达。';
const extracted = () => ({ summary: text, entities: [], relations: [], foreshadows: [] });
const plan = (next = 2): PlanningResult => ({ fine: Array.from({ length: 4 }, (_, index) => ({ chapter: next + index, title: `预期${next + index}`, goal: `尚未发生的事件${next + index}` })), foreshadows: [{ title: '秘密身世', detail: '未来揭晓的答案', status: 'planned', dueChapter: next + 3, revealCondition: '发现旧信', relatedNames: [] }] });
async function waitFor(done: () => boolean) { const deadline = Date.now() + 4000; while (!done()) { if (Date.now() > deadline) throw new Error('等待规划测试超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }
type Handler = (request: ModelRequest, store: Store, branchId: string) => Promise<string>;
async function submit(request: ModelRequest, value = plan()) {
  const tool = request.tools!.find(tool => tool.name === 'update_plot_plan')!;
  request.onActivity?.({ type: 'tool_call', id: 'plot', name: tool.name, arguments: value as any });
  const result = await tool.execute(value as any); request.onActivity?.({ type: 'tool_result', id: 'plot', name: tool.name, result }); return result;
}
function harness(write: Handler = async () => text, mode: 'tool' | 'separate' = 'tool', enabled = true, post: Handler = async request => { await submit(request); return '规划阶段的文本不会进入正文。'; }) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-planning-tool-'))); const project = store.createProject({ title: '规划工具验证' });
  const settings: Settings = { providers: [{ id: 'mock', name: '模拟', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'writer', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'mock', planningProviderId: mode === 'tool' ? '' : 'mock', extractionProviderId: 'mock', taskSettings: { ...defaultTaskSettings(), planning: { enabled, mode } } };
  const models: TextModels = {
    generateText: vi.fn(async (_provider, request) => { const result = await (request.tools?.some(tool => tool.name === 'update_plot_plan') ? post : write)(request, store, project.mainBranchId); request.onTextDelta?.(result); return { text: result, inputTokens: 4, outputTokens: 8 }; }),
    generateStructured: vi.fn(async (_provider, request, validate) => ({ value: validate(request.system.includes('只规划尚未发生') ? plan(store.state(project.mainBranchId).chapters.length + 1) : extracted()), inputTokens: 2, outputTokens: 3 })),
  };
  const engine = new StoryEngine(store, () => settings, models); fixtures.push({ store, engine }); engine.start();
  const start = () => engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'original', instruction: '写下一章' });
  const writing = () => engine.listJobs().find(job => job.kind === 'generate')!;
  return { store, project, settings, engine, models, start, writing };
}
function readyChapter(ctx: ReturnType<typeof harness>) {
  const view = ctx.store.saveChapter(ctx.project.mainBranchId, { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, title: '正文', text });
  return ctx.store.applyExtraction(ctx.project.mainBranchId, view.branch.revisionId, view.state.chapters[0].id, extracted(), true);
}

describe('planning only after completed prose', () => {
  it('saves complete prose before exposing the tool, commits planning separately, and ignores later text', async () => {
    let startingRevision = ''; let proseRevision = ''; let staged: any;
    const ctx = harness(async (request, store, branchId) => { startingRevision = store.getBranch(branchId).revisionId; expect(request.tools!.some(tool => tool.name === 'update_plot_plan')).toBe(false); expect(store.state(branchId).chapters).toEqual([]); return text; }, 'tool', true, async (request, store, branchId) => {
      proseRevision = store.getBranch(branchId).revisionId; expect(proseRevision).not.toBe(startingRevision); expect(store.chapter(branchId, store.state(branchId).chapters[0].id).text).toBe(text);
      expect(request.onTextDelta).toBeUndefined(); expect(request.system).toContain('本章正文已经完整保存'); staged = await submit(request); expect(store.getBranch(branchId).revisionId).toBe(proseRevision); expect(store.state(branchId).outline.fine).toEqual([]); return '绝不能追加的规划阶段文字';
    });
    const job = ctx.start(); await waitFor(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed'));
    expect(staged.status).toBe('staged'); const state = ctx.store.state(ctx.project.mainBranchId); expect(state.outline.fine).toEqual(plan().fine); expect(state.foreshadows[0]).toMatchObject({ status: 'planned', title: '秘密身世' });
    expect(ctx.store.revisionState(proseRevision).outline.fine).toEqual([]); expect(ctx.store.chapter(ctx.project.mainBranchId, state.chapters[0].id).text).toBe(text); expect(ctx.models.generateText).toHaveBeenCalledTimes(2); expect(ctx.models.generateStructured).toHaveBeenCalledTimes(1);
    expect(ctx.engine.listWritingActivities(job.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool', name: 'update_plot_plan', proseOffset: text.length })])); expect(ctx.engine.writingSnapshot(job.id).text).toBe(text);
    const planningOutput = ctx.engine.listOutputs(job.id).find(output => output.stage === 'planning')!; const detail = ctx.engine.outputDetail(job.id, planningOutput.id).output;
    expect(JSON.parse(detail.normalizedText!)).toEqual(plan()); expect(detail.text).toBe('绝不能追加的规划阶段文字'); expect(detail.rawResponse).toBe('绝不能追加的规划阶段文字');
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id)); expect(ctx.store.state(restored.mainBranchId).outline.fine).toEqual(state.outline.fine);
    const rolled = ctx.store.rollback(ctx.project.mainBranchId, { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, revisionId: startingRevision }); expect(rolled.state.outline.fine).toEqual([]); expect(rolled.state.chapters).toEqual([]);
  });
  it('returns correctable tool errors and keeps the last valid replacement', async () => {
    const ctx = harness(undefined, 'tool', true, async request => {
      const tool = request.tools!.find(tool => tool.name === 'update_plot_plan')!; const invalid = plan(); invalid.fine[1].chapter = 2;
      expect(await tool.execute(invalid as any)).toHaveProperty('error'); expect(await tool.execute({ ...plan(), foreshadows: [{ ...plan().foreshadows[0], relatedNames: ['不存在的人物'] }] } as any)).toHaveProperty('error'); expect(await tool.execute({ ...plan(), foreshadows: [{ ...plan().foreshadows[0], status: 'resolved' }] } as any)).toHaveProperty('error');
      expect(await tool.execute(plan() as any)).toHaveProperty('status', 'staged'); const replacement = plan(); replacement.fine[0].goal = '替换后的走向'; replacement.foreshadows = []; expect(await tool.execute(replacement as any)).toHaveProperty('status', 'staged'); return 'done';
    }); ctx.start(); await waitFor(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed')); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine[0].goal).toBe('替换后的走向'); expect(ctx.store.state(ctx.project.mainBranchId).foreshadows).toEqual([]);
  });
  it('keeps saved prose on planning failure and retries only planning', async () => {
    let bodyCalls = 0; let attempts = 0; const ctx = harness(async () => { bodyCalls++; return text; }, 'tool', true, async request => { attempts++; await submit(request); if (attempts === 1) throw new Error('规划响应中断'); return 'done'; });
    const job = ctx.start(); await waitFor(() => ctx.writing().status === 'failed'); expect(ctx.writing().generatedChapterId).toBeDefined(); expect(ctx.engine.writingSnapshot(job.id).text).toBe(text); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]); expect(ctx.engine.listJobs().some(job => job.kind === 'extract')).toBe(false);
    ctx.engine.action(job.id, 'retry'); await waitFor(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed')); expect(bodyCalls).toBe(1); expect(attempts).toBe(2); expect(ctx.models.generateText).toHaveBeenCalledTimes(3); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual(plan().fine);
  });
  it('requires a tool submission and allows local post-planning recovery without another prose request', async () => {
    const ctx = harness(undefined, 'tool', true, async () => JSON.stringify(plan())); const job = ctx.start(); await waitFor(() => ctx.writing().status === 'failed'); expect(ctx.store.state(ctx.project.mainBranchId).chapters).toHaveLength(1); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]);
    const imported = ctx.engine.importOutput(job.id, JSON.stringify(plan())); ctx.engine.applyOutput(job.id, imported.id, { baseRevisionId: ctx.writing().baseRevisionId, text: JSON.stringify(plan()) }); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual(plan().fine); expect(ctx.models.generateText).toHaveBeenCalledTimes(2); expect(ctx.engine.listJobs().find(job => job.kind === 'extract')?.status).toBe('paused'); expect(ctx.models.generateStructured).not.toHaveBeenCalled();
  });
  it('does not plan after interrupted prose or use pre-release staged plans during local prose repair', async () => {
    const ctx = harness(async request => { expect(request.tools!.some(tool => tool.name === 'update_plot_plan')).toBe(false); throw new Error('正文中断'); }); const job = ctx.start(); await waitFor(() => ctx.writing().status === 'failed');
    const row = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data)); row.payload.pendingPlotPlan = plan(1); ctx.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(row), job.id);
    const imported = ctx.engine.importOutput(job.id, text); ctx.engine.applyOutput(job.id, imported.id, { baseRevisionId: job.baseRevisionId, text }); expect(ctx.store.state(ctx.project.mainBranchId).chapters).toHaveLength(1); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]); expect(ctx.writing().status).toBe('paused'); expect(ctx.models.generateText).toHaveBeenCalledTimes(1);
  });
  it('rejects stale post-planning calls while keeping completed prose', async () => {
    const ctx = harness(undefined, 'tool', true, async (request, store, branchId) => { const tool = request.tools!.find(tool => tool.name === 'update_plot_plan')!; await tool.execute(plan() as any); const state = store.state(branchId); state.outline.locked = '作者的新设定'; store.commit(branchId, store.getBranch(branchId).revisionId, state, '作者更新'); expect(() => tool.execute(plan() as any)).toThrow('版本'); return 'done'; }); ctx.start(); await waitFor(() => ctx.writing().status === 'stale'); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]); expect(ctx.store.state(ctx.project.mainBranchId).chapters).toHaveLength(1); expect(ctx.store.state(ctx.project.mainBranchId).outline.locked).toBe('作者的新设定');
  });
  it.each([['tool', false], ['separate', false], ['separate', true]] as const)('adds no automatic planning request in %s enabled=%s', async (mode, enabled) => {
    const ctx = harness(async request => { expect(request.tools!.some(tool => tool.name === 'update_plot_plan')).toBe(false); return text; }, mode, enabled); ctx.start(); await waitFor(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed')); expect(ctx.models.generateText).toHaveBeenCalledTimes(1); expect(ctx.models.generateStructured).toHaveBeenCalledTimes(1);
  });
  it.each(['pause', 'cancel'] as const)('retains prose and starts no paid extraction after post-planning %s', async action => {
    let ctx!: ReturnType<typeof harness>; ctx = harness(undefined, 'tool', true, async request => { const tool = request.tools!.find(tool => tool.name === 'update_plot_plan')!; await tool.execute(plan() as any); ctx.engine.action(ctx.writing().id, action); expect(() => tool.execute(plan() as any)).toThrow('已停止'); return 'done'; }); ctx.start(); await waitFor(() => ctx.writing().status === (action === 'pause' ? 'paused' : 'cancelled'));
    expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]); expect(ctx.store.state(ctx.project.mainBranchId).chapters).toHaveLength(1); expect(ctx.models.generateStructured).not.toHaveBeenCalled(); expect(ctx.engine.listJobs().some(job => job.kind === 'extract')).toBe(false);
    if (action === 'cancel') { const extraction = ctx.engine.enqueue(ctx.project.mainBranchId, 'extract', { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId }); await waitFor(() => ctx.engine.listJobs().find(job => job.id === extraction.id)?.status === 'completed'); expect(ctx.models.generateStructured).toHaveBeenCalledTimes(1); }
  });
  it('skips a disabled post-planning phase on explicit resume without another writing request', async () => {
    const ctx = harness(undefined, 'tool', true, async () => { throw new Error('规划失败'); }); const job = ctx.start(); await waitFor(() => ctx.writing().status === 'failed'); ctx.settings.taskSettings!.planning.enabled = false; ctx.engine.action(job.id, 'resume'); await waitFor(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed')); expect(ctx.models.generateText).toHaveBeenCalledTimes(2); expect(ctx.writing().status).toBe('completed'); expect(ctx.store.chapter(ctx.project.mainBranchId, ctx.writing().generatedChapterId!).text).toBe(text);
  });
  it('recovers legacy saved-prose jobs without adding a planning request', async () => {
    const ctx = harness(); const saved = ctx.store.saveChapter(ctx.project.mainBranchId, { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, title: '旧正文', text }); const time = new Date().toISOString();
    const old: Job = { id: 'old-saved-prose', projectId: ctx.project.id, branchId: ctx.project.mainBranchId, baseRevisionId: saved.branch.revisionId, kind: 'generate', status: 'paused', progress: 1, total: 1, message: '', inputTokens: 1, outputTokens: 1, createdAt: time, updatedAt: time, payload: { mode: 'original', generatedChapterId: saved.state.chapters[0].id, pendingPlotPlan: plan(1) } };
    ctx.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(old.id, old.branchId, old.projectId, old.status, JSON.stringify(old)); ctx.engine.action(old.id, 'resume'); await waitFor(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed')); expect(ctx.models.generateText).not.toHaveBeenCalled(); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]);
  });
  it('keeps independent planning manual, requires completed prose and respects settings', async () => {
    const separate = harness(undefined, 'separate'); const branchId = separate.project.mainBranchId; expect(() => separate.engine.enqueue(branchId, 'plan', { baseRevisionId: separate.store.getBranch(branchId).revisionId })).toThrow('先完成一章正文'); readyChapter(separate);
    const job = separate.engine.enqueue(branchId, 'plan', { baseRevisionId: separate.store.getBranch(branchId).revisionId }); await waitFor(() => separate.engine.listJobs().find(value => value.id === job.id)?.status === 'completed'); expect(separate.store.state(branchId).outline.fine).toEqual(plan().fine); expect(separate.models.generateText).not.toHaveBeenCalled();
    const paused = separate.engine.enqueue(branchId, 'plan', { baseRevisionId: separate.store.getBranch(branchId).revisionId }); separate.engine.action(paused.id, 'pause'); separate.settings.taskSettings!.planning.enabled = false; expect(() => separate.engine.action(paused.id, 'resume')).toThrow('已关闭'); separate.settings.taskSettings!.planning = { enabled: true, mode: 'tool' }; expect(() => separate.engine.action(paused.id, 'retry')).toThrow('工具');
    const off = harness(undefined, 'separate', false); expect(() => off.engine.enqueue(off.project.mainBranchId, 'plan', { baseRevisionId: off.store.getBranch(off.project.mainBranchId).revisionId })).toThrow('已关闭'); const tool = harness(); expect(() => tool.engine.enqueue(tool.project.mainBranchId, 'plan', { baseRevisionId: tool.store.getBranch(tool.project.mainBranchId).revisionId })).toThrow('工具'); expect(off.engine.enqueue(off.project.mainBranchId, 'plan', { baseRevisionId: off.store.getBranch(off.project.mainBranchId).revisionId, purpose: 'compress-summary' }).purpose).toBe('compress-summary');
  });
  it('preserves existing plans while disabled writing context excludes them', () => {
    const ctx = harness(undefined, 'tool', false); const state = ctx.store.state(ctx.project.mainBranchId); state.outline.fine = plan(1).fine; const context = buildWritingContext({ state, chapterText: () => '', planningEnabled: false }); expect(context.text).not.toContain('尚未发生的事件'); expect(context.variables.currentChapterPlan).toBe('null'); expect(state.outline.fine).toEqual(plan(1).fine);
  });
  it('allows manual independent planning after completed prose when extraction is unfinished', async () => {
    const ctx = harness(undefined, 'separate'); const saved = ctx.store.saveChapter(ctx.project.mainBranchId, { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, title: '已保存正文', text });
    const job = ctx.engine.enqueue(ctx.project.mainBranchId, 'plan', { baseRevisionId: saved.branch.revisionId }); await waitFor(() => ctx.engine.listJobs().find(value => value.id === job.id)?.status === 'completed');
    expect(ctx.store.state(ctx.project.mainBranchId).chapters[0].status).toBe('pending'); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual(plan().fine); expect(ctx.models.generateText).not.toHaveBeenCalled();
  });
  it('blocks independent planning for an unfinished writer at the current version but not an older failed version', async () => {
    const ctx = harness(async () => { throw new Error('当前章正文失败'); }, 'separate'); readyChapter(ctx); ctx.start(); await waitFor(() => ctx.writing().status === 'failed');
    expect(() => ctx.engine.enqueue(ctx.project.mainBranchId, 'plan', { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId })).toThrow('当前章节正文尚未完成');
    const state = ctx.store.state(ctx.project.mainBranchId); state.outline.locked = '后续作者修订'; ctx.store.commit(ctx.project.mainBranchId, ctx.store.getBranch(ctx.project.mainBranchId).revisionId, state, '作者修订');
    const later = ctx.engine.enqueue(ctx.project.mainBranchId, 'plan', { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId }); await waitFor(() => ctx.engine.listJobs().find(value => value.id === later.id)?.status === 'completed'); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual(plan().fine);
  });
  it('enforces ordering for legacy queued planning, resume and manual output application', async () => {
    const ctx = harness(undefined, 'separate'); const ready = readyChapter(ctx); const queued = ctx.engine.enqueue(ctx.project.mainBranchId, 'plan', { baseRevisionId: ready.branch.revisionId }); ctx.engine.action(queued.id, 'pause');
    const time = new Date().toISOString(); const writer: Job = { id: 'unfinished-current-writer', projectId: ctx.project.id, branchId: ctx.project.mainBranchId, baseRevisionId: ready.branch.revisionId, kind: 'generate', status: 'failed', progress: 0, total: 1, message: '', inputTokens: 0, outputTokens: 0, createdAt: time, updatedAt: time, payload: { mode: 'original' } };
    ctx.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(writer.id, writer.branchId, writer.projectId, writer.status, JSON.stringify(writer));
    expect(() => ctx.engine.action(queued.id, 'resume')).toThrow('当前章节正文尚未完成'); const imported = ctx.engine.importOutput(queued.id, JSON.stringify(plan())); expect(ctx.engine.outputDetail(queued.id, imported.id).canApply).toBe(false); expect(() => ctx.engine.applyOutput(queued.id, imported.id, { baseRevisionId: ready.branch.revisionId, text: JSON.stringify(plan()) })).toThrow('当前章节正文尚未完成');
    const row = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(queued.id)!.data)); row.status = 'queued'; ctx.store.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run('queued', JSON.stringify(row), row.id);
    await waitFor(() => ctx.engine.listJobs().find(job => job.id === queued.id)?.status === 'failed'); expect(ctx.models.generateStructured).not.toHaveBeenCalled(); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]);
  });
  it('validates post-planning manual recovery against current mode and future chapter range', async () => {
    const ctx = harness(undefined, 'tool', true, async () => 'missing tool'); const job = ctx.start(); await waitFor(() => ctx.writing().status === 'failed');
    const imported = ctx.engine.importOutput(job.id, JSON.stringify(plan(1))); expect(() => ctx.engine.applyOutput(job.id, imported.id, { baseRevisionId: ctx.writing().baseRevisionId, text: JSON.stringify(plan(1)) })).toThrow('输出仍未通过校验');
    expect(ctx.engine.outputDetail(job.id, imported.id).output.issues[0].message).toContain('刚完成章节之后'); ctx.settings.taskSettings!.planning = { enabled: true, mode: 'separate' };
    expect(() => ctx.engine.applyOutput(job.id, imported.id, { baseRevisionId: ctx.writing().baseRevisionId, text: JSON.stringify(plan()) })).toThrow('输出仍未通过校验'); expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]); expect(ctx.engine.writingSnapshot(job.id).text).toBe(text);
  });
  it('resumes a restored pending post-planning job without calling prose generation again', async () => {
    let bodyCalls = 0; let attempts = 0; const ctx = harness(async () => { bodyCalls++; return text; }, 'tool', true, async request => { if (++attempts === 1) throw new Error('暂时无法规划'); await submit(request); return 'done'; }); ctx.start(); await waitFor(() => ctx.writing().status === 'failed');
    const originalChapterId = ctx.writing().generatedChapterId; const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id)); const copy = ctx.engine.listJobs(restored.id).find(job => job.kind === 'generate')!; expect(copy.generatedChapterId).not.toBe(originalChapterId); ctx.engine.action(copy.id, 'retry'); await waitFor(() => ctx.engine.listJobs(restored.id).some(job => job.kind === 'extract' && job.status === 'completed'));
    expect(bodyCalls).toBe(1); expect(attempts).toBe(2); expect(ctx.store.exportText(restored.mainBranchId)).toBe(`第 1 章\n\n${text}`); expect(ctx.store.state(restored.mainBranchId).outline.fine).toEqual(plan().fine);
  });
});
