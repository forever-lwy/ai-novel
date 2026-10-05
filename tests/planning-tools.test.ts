import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { buildWritingContext } from '../server/writing-context.js';
import { defaultTaskSettings } from '../shared/task-settings.js';
import type { ModelRequest, PlanningResult, Settings } from '../shared/types.js';

const fixtures: { store: Store; engine: StoryEngine }[] = [];
afterEach(async () => { for (const { store, engine } of fixtures.splice(0)) { await engine.close(); store.close(); } });
const plan = (next = 1): PlanningResult => ({ fine: Array.from({ length: 4 }, (_, index) => ({ chapter: next + index, title: `预期${next + index}`, goal: `尚未发生的事件${next + index}` })), foreshadows: [{ title: '秘密身世', detail: '未来揭晓的答案', status: 'planned', dueChapter: next + 3, revealCondition: '发现旧信', relatedNames: [] }] });
async function waitFor(done: () => boolean) { const deadline = Date.now() + 4000; while (!done()) { if (Date.now() > deadline) throw new Error('等待规划测试超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }
function harness(write: (request: ModelRequest, store: Store, branchId: string) => Promise<string>, mode: 'tool' | 'separate' = 'tool', enabled = true) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-planning-tool-'))); const project = store.createProject({ title: '规划工具验证' });
  const settings: Settings = { providers: [{ id: 'mock', name: '模拟', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'writer', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'mock', planningProviderId: mode === 'tool' ? '' : 'mock', extractionProviderId: 'mock', taskSettings: { ...defaultTaskSettings(), planning: { enabled, mode } } };
  const models: TextModels = {
    generateText: vi.fn(async (_provider, request) => { const text = await write(request, store, project.mainBranchId); request.onTextDelta?.(text); return { text, inputTokens: 4, outputTokens: 8 }; }),
    generateStructured: vi.fn(async (_provider, _request, validate) => ({ value: validate(mode === 'separate' ? plan() : { summary: '旅人抵达。', entities: [], relations: [], foreshadows: [] }), inputTokens: 2, outputTokens: 3 })),
  };
  const engine = new StoryEngine(store, () => settings, models); fixtures.push({ store, engine }); engine.start();
  const start = () => engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'original', instruction: '写下一章' });
  return { store, project, settings, engine, models, start };
}

describe('optional planning and writing-owned plan tools', () => {
  it('stages model-authored planning then saves it with prose, without requesting the planning model', async () => {
    let startingRevision = ''; let result: any;
    const ctx = harness(async (request, store, branchId) => {
      startingRevision = store.getBranch(branchId).revisionId;
      expect(request.system).toContain('update_plot_plan'); expect(request.messages?.[0].content).toContain('直接编写');
      const tool = request.tools!.find(tool => tool.name === 'update_plot_plan')!;
      request.onActivity?.({ type: 'tool_call', id: 'plot', name: tool.name, arguments: plan() as any });
      result = await tool.execute(plan() as any);
      request.onActivity?.({ type: 'tool_result', id: 'plot', name: tool.name, result });
      expect(store.getBranch(branchId).revisionId).toBe(startingRevision);
      expect(store.state(branchId).outline.fine).toEqual([]);
      return '旅人抵达。';
    });
    const job = ctx.start(); await waitFor(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed'));
    expect(result.status).toBe('staged');
    const state = ctx.store.state(ctx.project.mainBranchId);
    expect(state.outline.fine).toEqual(plan().fine.slice(1)); expect(state.foreshadows[0]).toMatchObject({ status: 'planned', title: '秘密身世' });
    const proseRevision = ctx.store.history(ctx.project.mainBranchId).find(revision => revision.label === '保存正文，等待资料整理')!;
    expect(ctx.store.revisionState(proseRevision.id).outline.fine).toEqual(plan().fine.slice(1));
    expect(ctx.store.chapter(ctx.project.mainBranchId, state.chapters[0].id).text).toBe('旅人抵达。');
    expect(ctx.models.generateStructured).toHaveBeenCalledTimes(1); // extraction only; no planning provider is configured
    expect(ctx.engine.listWritingActivities(job.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool', name: 'update_plot_plan' })]));
    const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
    expect(ctx.store.state(restored.mainBranchId).outline.fine).toEqual(state.outline.fine);
    const rolled = ctx.store.rollback(ctx.project.mainBranchId, { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, revisionId: startingRevision });
    expect(rolled.state.outline.fine).toEqual([]); expect(rolled.state.chapters).toEqual([]);
  });

  it('returns correctable tool errors and keeps the last valid replacement only', async () => {
    const ctx = harness(async request => {
      const tool = request.tools!.find(tool => tool.name === 'update_plot_plan')!;
      const invalid = plan(); invalid.fine[1].chapter = 1;
      expect(await tool.execute(invalid as any)).toHaveProperty('error');
      expect(await tool.execute({ ...plan(), foreshadows: [{ ...plan().foreshadows[0], relatedNames: ['不存在的人物'] }] } as any)).toHaveProperty('error');
      expect(await tool.execute({ ...plan(), foreshadows: [{ ...plan().foreshadows[0], status: 'resolved' }] } as any)).toHaveProperty('error');
      expect(await tool.execute(plan() as any)).toHaveProperty('status', 'staged');
      const replacement = plan(); replacement.fine[1].goal = '替换后的走向'; replacement.foreshadows = [];
      expect(await tool.execute(replacement as any)).toHaveProperty('status', 'staged'); return '旅人抵达。';
    }); ctx.start(); await waitFor(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed'));
    expect(ctx.store.state(ctx.project.mainBranchId).outline.fine[0].goal).toBe('替换后的走向');
    expect(ctx.store.state(ctx.project.mainBranchId).foreshadows).toEqual([]);
  });

  it('does not apply staged plans after a writing failure and supports local prose recovery', async () => {
    const ctx = harness(async request => { await request.tools!.find(tool => tool.name === 'update_plot_plan')!.execute(plan() as any); throw new Error('正文中断'); });
    const job = ctx.start(); await waitFor(() => ctx.engine.listJobs().find(value => value.id === job.id)?.status === 'failed');
    expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]); expect(ctx.store.state(ctx.project.mainBranchId).chapters).toEqual([]);
    const imported = ctx.engine.importOutput(job.id, '旅人抵达。');
    ctx.engine.applyOutput(job.id, imported.id, { baseRevisionId: job.baseRevisionId, text: '旅人抵达。' });
    expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual(plan().fine.slice(1));
    expect(ctx.models.generateText).toHaveBeenCalledTimes(1);
  });

  it('rejects stale tool calls and never writes a staged plan into a newer revision', async () => {
    const ctx = harness(async (request, store, branchId) => {
      const tool = request.tools!.find(tool => tool.name === 'update_plot_plan')!;
      await tool.execute(plan() as any);
      const state = store.state(branchId); state.outline.locked = '作者的新设定'; store.commit(branchId, store.getBranch(branchId).revisionId, state, '作者更新');
      expect(() => tool.execute(plan() as any)).toThrow('版本'); return '旅人抵达。';
    }); const job = ctx.start(); await waitFor(() => ctx.engine.listJobs().find(value => value.id === job.id)?.status === 'stale');
    expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]); expect(ctx.store.state(ctx.project.mainBranchId).outline.locked).toBe('作者的新设定');
  });

  it.each([['tool', false], ['separate', false], ['separate', true]] as const)('offers no planning tool in %s mode with enabled=%s', async (mode, enabled) => {
    const ctx = harness(async request => { expect(request.tools!.some(tool => tool.name === 'update_plot_plan')).toBe(false); return '旅人抵达。'; }, mode, enabled);
    const job = ctx.start(); await waitFor(() => ctx.engine.listJobs().find(value => value.id === job.id)?.status === 'completed');
  });

  it.each(['pause', 'cancel'] as const)('does not apply staged planning after %s and rejects late calls', async action => {
    let ctx!: ReturnType<typeof harness>;
    ctx = harness(async request => {
      const tool = request.tools!.find(tool => tool.name === 'update_plot_plan')!;
      await tool.execute(plan() as any);
      ctx.engine.action(ctx.engine.listJobs().find(job => job.kind === 'generate')!.id, action);
      expect(() => tool.execute(plan() as any)).toThrow('已停止');
      return '旅人抵达。';
    }); const job = ctx.start();
    await waitFor(() => ctx.engine.listJobs().find(value => value.id === job.id)?.status === (action === 'pause' ? 'paused' : 'cancelled'));
    expect(ctx.store.state(ctx.project.mainBranchId).outline.fine).toEqual([]);
    expect(ctx.store.state(ctx.project.mainBranchId).chapters).toEqual([]);
  });

  it('rejects continuation of an old independent planning job after disabling planning', () => {
    const ctx = harness(async () => '旅人抵达。', 'separate');
    const job = ctx.engine.enqueue(ctx.project.mainBranchId, 'plan', { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId });
    ctx.engine.action(job.id, 'pause'); ctx.settings.taskSettings!.planning.enabled = false;
    expect(() => ctx.engine.action(job.id, 'resume')).toThrow('已关闭');
    expect(ctx.engine.listJobs().find(value => value.id === job.id)!.status).toBe('paused');
    ctx.settings.taskSettings!.planning = { enabled: true, mode: 'tool' };
    expect(() => ctx.engine.action(job.id, 'retry')).toThrow('工具');
  });

  it('blocks standalone planning in off/tool modes while retaining independent planning and compression', async () => {
    const off = harness(async () => '旅人抵达。', 'separate', false);
    const payload = { baseRevisionId: off.store.getBranch(off.project.mainBranchId).revisionId };
    expect(() => off.engine.enqueue(off.project.mainBranchId, 'plan', payload)).toThrow('已关闭');
    const tool = harness(async () => '旅人抵达。');
    expect(() => tool.engine.enqueue(tool.project.mainBranchId, 'plan', { baseRevisionId: tool.store.getBranch(tool.project.mainBranchId).revisionId })).toThrow('工具');
    const separate = harness(async () => '旅人抵达。', 'separate');
    const job = separate.engine.enqueue(separate.project.mainBranchId, 'plan', { baseRevisionId: separate.store.getBranch(separate.project.mainBranchId).revisionId });
    await waitFor(() => separate.engine.listJobs().find(value => value.id === job.id)?.status === 'completed');
    expect(separate.store.state(separate.project.mainBranchId).outline.fine).toEqual(plan().fine);
    // Summary compression still queues while plot planning is disabled (it requires chapter summaries to run).
    expect(off.engine.enqueue(off.project.mainBranchId, 'plan', { ...payload, purpose: 'compress-summary' }).purpose).toBe('compress-summary');
  });

  it('leaves existing plans stored while disabled writing context excludes them', () => {
    const ctx = harness(async () => '旅人抵达。', 'tool', false); const state = ctx.store.state(ctx.project.mainBranchId); state.outline.fine = plan().fine;
    const context = buildWritingContext({ state, chapterText: () => '', planningEnabled: false });
    expect(context.text).not.toContain('尚未发生的事件'); expect(context.variables.currentChapterPlan).toBe('null'); expect(state.outline.fine).toEqual(plan().fine);
  });
});
