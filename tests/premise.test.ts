import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import { Store, readBackupStates } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { buildWritingContext } from '../server/writing-context.js';
import { defaultPromptTemplates } from '../shared/prompt-templates.js';
import { emptyState, type ExtractionResult, type Job, type Settings } from '../shared/types.js';

const stores: Store[] = []; const engines: StoryEngine[] = []; const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const ctx of apps.splice(0)) await ctx.app.close(); for (const engine of engines.splice(0)) await engine.close(); for (const store of stores.splice(0)) store.close(); });
function fixture() { const directory = mkdtempSync(join(tmpdir(), 'novel-premise-')); const store = new Store(directory); stores.push(store); const project = store.createProject({ title: '可修改的小说设定', premise: '旧设定标记' }); return { directory, store, project, branchId: project.mainBranchId }; }
const extraction = (): ExtractionResult => ({ summary: '旅人来到桥边。', entities: [], relations: [], foreshadows: [] });
function readyChapter(store: Store, branchId: string, title = '已有章节') { const saved = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title, text: '旅人来到桥边。' }); return store.applyExtraction(branchId, saved.branch.revisionId, saved.state.chapters.at(-1)!.id, extraction(), true); }
async function terminal(engine: StoryEngine, id: string) { const deadline = Date.now() + 5000; for (;;) { const job = engine.listJobs().find(value => value.id === id)!; if (['completed', 'failed', 'stale', 'cancelled'].includes(job.status)) return job; if (Date.now() > deadline) throw new Error('模拟任务等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }

describe('editable versioned novel premise', () => {
  it('updates an existing story without replacing prose or historical state, and rejects a stale edit', () => {
    const { store, project, branchId } = fixture(); const before = readyChapter(store, branchId);
    const changed = store.updatePremise(branchId, before.branch.revisionId, '新设定标记');
    expect(changed.state).toEqual({ ...before.state, premise: '新设定标记', outline: { ...before.state.outline, worldview: '新设定标记', locked: '新设定标记' } });
    expect(changed.branch.id).toBe(branchId); expect(changed.branch.revisionId).not.toBe(before.branch.revisionId);
    expect(store.revisionState(before.branch.revisionId)).toEqual(before.state);
    expect(store.chapter(branchId, changed.state.chapters[0].id).text).toBe('旅人来到桥边。');
    expect(store.getProject(project.id).premise).toBe('旧设定标记');
    expect(() => store.updatePremise(branchId, before.branch.revisionId, '迟到的编辑')).toThrow('新版本');
    expect(store.listBranches(project.id)).toHaveLength(1);
  });

  it.each(['worldview', 'locked'] as const)('preserves separately authored %s while updating the untouched initial copy', field => {
    const { store, branchId } = fixture(); const initial = store.view(branchId, true);
    const authored = store.updateOutline(branchId, initial.branch.revisionId, { ...initial.state.outline, [field]: '作者独立修改' });
    const changed = store.updatePremise(branchId, authored.branch.revisionId, '新设定标记');
    expect(changed.state.outline[field]).toBe('作者独立修改');
    expect(changed.state.outline[field === 'locked' ? 'worldview' : 'locked']).toBe('新设定标记');
  });

  it('isolates branches, restores the premise with rollback and carries the current premise into regeneration', () => {
    const { store, branchId } = fixture(); const before = readyChapter(store, branchId);
    const fork = store.fork(branchId, { baseRevisionId: before.branch.revisionId, name: '保留旧设定' });
    const changed = store.updatePremise(branchId, before.branch.revisionId, '新设定标记');
    expect(store.state(fork.branch.id).premise).toBeUndefined();
    const regeneration = store.forkForGeneration(branchId, changed.branch.revisionId, changed.state.chapters[0].id);
    expect(regeneration.state.premise).toBe('新设定标记'); expect(regeneration.state.outline.worldview).toBe('新设定标记');
    const rollback = store.rollback(branchId, { baseRevisionId: changed.branch.revisionId, revisionId: before.branch.revisionId });
    expect(rollback.state).toEqual(before.state); expect(store.state(regeneration.branch.id).premise).toBe('新设定标记');
  });

  it('preserves explicit clearing and legacy fallback through restart and project backup restore', () => {
    const { store, directory, branchId, project } = fixture(); const legacy = store.restoreProject(store.exportProject(project.id));
    expect(store.state(legacy.mainBranchId).premise).toBeUndefined(); expect(legacy.premise).toBe('旧设定标记');
    const changed = store.updatePremise(branchId, store.getBranch(branchId).revisionId, '');
    expect(changed.state.outline).toMatchObject({ worldview: '', locked: '' });
    const restored = store.restoreProject(store.exportProject(project.id)); expect(store.state(restored.mainBranchId).premise).toBe('');
    const reopened = new Store(directory); stores.push(reopened); expect(reopened.state(branchId).premise).toBe('');
    expect(readBackupStates([{ state: { ...emptyState(), premise: '' } }, { state: emptyState() }]).map(state => state.premise)).toEqual(['', undefined]);
    expect(buildWritingContext({ state: changed.state, premise: project.premise, chapterText: () => '' }).variables.worldview).toBe('');
  });

  it.each(['新设定标记', ''])('uses the saved premise %j in actual writing and extraction requests', async premise => {
    const { store, project, branchId } = fixture(); readyChapter(store, branchId);
    const view = store.updatePremise(branchId, store.getBranch(branchId).revisionId, premise);
    const templates = defaultPromptTemplates();
    for (const task of ['writing', 'extraction'] as const) {
      const preset = templates.presets[task].find(value => value.id === templates.selected[task])!;
      preset.useGeneral = false;
      preset.blocks = [{ id: 'input', name: '本次材料', enabled: true, role: 'user', content: task === 'writing' ? '设定=[{{premise}}]\n世界观=[{{worldview}}]\n锁定=[{{locked}}]' : '设定=[{{premise}}]\n{{blockText}}' }];
    }
    const settings: Settings = { providers: [{ id: 'mock', name: '本地模拟', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'fixture', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'mock', planningProviderId: 'mock', extractionProviderId: 'mock', promptTemplates: templates };
    const models: TextModels = { generateText: vi.fn(async () => ({ text: '旅人来到桥边。', inputTokens: 2, outputTokens: 3 })), generateStructured: vi.fn(async (_provider, _request, validate) => ({ value: validate(extraction()), inputTokens: 2, outputTokens: 3 })) };
    const engine = new StoryEngine(store, () => settings, models); engines.push(engine); engine.start();
    const writing = engine.enqueue(branchId, 'generate', { baseRevisionId: view.branch.revisionId, title: '下一章', mode: 'original', instruction: '继续' });
    expect((await terminal(engine, writing.id)).status).toBe('completed');
    const extractionJob = engine.listJobs(project.id).find(job => job.kind === 'extract')!; expect((await terminal(engine, extractionJob.id)).status).toBe('completed');
    const request = vi.mocked(models.generateText).mock.calls[0][1];
    expect(request.prompt).toContain(`设定=[${premise}]`); expect(request.prompt).toContain(`世界观=[${premise}]`); expect(request.prompt).toContain(`锁定=[${premise}]`);
    expect(request.prompt).not.toContain('旧设定标记');
    const extractionRequest = vi.mocked(models.generateStructured).mock.calls[0][1]; expect(extractionRequest.prompt).toContain(`设定=[${premise}]`); expect(extractionRequest.prompt).not.toContain('旧设定标记');
  });

  it('validates authenticated saves after chapters exist and rejects stale revisions and invalid inputs', async () => {
    const ctx = await buildApp({ initialPassword: 'novel-premise-test-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-premise-api-')), startEngine: false }); apps.push(ctx);
    const project = ctx.store.createProject({ title: '接口设定', premise: '旧设定' }); const view = readyChapter(ctx.store, project.mainBranchId);
    const url = `/api/branches/${project.mainBranchId}/premise`; const payload = { baseRevisionId: view.branch.revisionId, premise: '修改后的设定' };
    expect((await ctx.app.inject({ method: 'PUT', url, payload })).statusCode).toBe(401);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'novel-premise-test-password' } }); const cookies = { session: login.cookies[0].value };
    for (const invalid of [{ ...payload, premise: 1 }, { ...payload, premise: '字'.repeat(100001) }, { premise: '缺少版本' }]) expect((await ctx.app.inject({ method: 'PUT', url, cookies, payload: invalid })).statusCode).toBe(400);
    const saved = await ctx.app.inject({ method: 'PUT', url, cookies, payload }); expect(saved.statusCode).toBe(200); expect(saved.json().state.premise).toBe('修改后的设定');
    expect((await ctx.app.inject({ method: 'PUT', url, cookies, payload })).statusCode).toBe(409);
    expect((await ctx.app.inject({ url: `/api/branches/${project.mainBranchId}?view=reader`, cookies })).json().state.premise).toBe('修改后的设定');
  });

  it('includes the saved premise in default prompt materials alongside independently authored world settings', async () => {
    const { store, branchId } = fixture(); const before = readyChapter(store, branchId);
    const authored = store.updateOutline(branchId, before.branch.revisionId, { ...before.state.outline, worldview: '作者独立世界观', locked: '作者独立规则' });
    const changed = store.updatePremise(branchId, authored.branch.revisionId, '新设定标记');
    const context = buildWritingContext({ state: changed.state, premise: '旧设定标记', chapterText: id => store.chapter(branchId, id).text });
    expect(context.variables.storyMaterialsText).toContain('## 小说设定\n\n新设定标记');
    expect(JSON.parse(context.variables.storyMaterials)).toMatchObject({ premise: '新设定标记', worldview: '作者独立世界观', locked: '作者独立规则' });
    const settings: Settings = { providers: [{ id: 'mock', name: '本地模拟', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'fixture', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'mock', planningProviderId: 'mock', extractionProviderId: 'mock', promptTemplates: defaultPromptTemplates() };
    const models: TextModels = { generateText: vi.fn(async () => ({ text: '旅人来到桥边。', inputTokens: 2, outputTokens: 3 })), generateStructured: vi.fn(async (_provider, _request, validate) => ({ value: validate(extraction()), inputTokens: 2, outputTokens: 3 })) };
    const engine = new StoryEngine(store, () => settings, models); engines.push(engine); engine.start();
    const writing = engine.enqueue(branchId, 'generate', { baseRevisionId: changed.branch.revisionId, title: '下一章', mode: 'original', instruction: '继续' });
    expect((await terminal(engine, writing.id)).status).toBe('completed');
    const request = vi.mocked(models.generateText).mock.calls[0][1];
    for (const material of ['新设定标记', '作者独立世界观', '作者独立规则']) expect(request.prompt).toContain(material);
    expect(request.prompt).not.toContain('旧设定标记');
  });

  it.each(['queued', 'running', 'paused'] as const)('keeps an in-flight %s task from losing its version when saving the premise', async status => {
    const ctx = await buildApp({ initialPassword: 'novel-premise-test-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-premise-lock-')), startEngine: false }); apps.push(ctx);
    const project = ctx.store.createProject({ title: '任务保护' }); const branch = ctx.store.getBranch(project.mainBranchId); const time = new Date().toISOString();
    const job: Job = { id: 'active-job', projectId: project.id, branchId: branch.id, baseRevisionId: branch.revisionId, kind: 'generate', status, progress: 0, total: 1, message: '处理中', inputTokens: 0, outputTokens: 0, createdAt: time, updatedAt: time, payload: {} };
    ctx.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, job.branchId, job.projectId, job.status, JSON.stringify(job));
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'novel-premise-test-password' } }); const cookies = { session: login.cookies[0].value };
    const response = await ctx.app.inject({ method: 'PUT', url: `/api/branches/${branch.id}/premise`, cookies, payload: { baseRevisionId: branch.revisionId, premise: '不得提前保存' } });
    expect(response.statusCode).toBe(409); expect(response.json().error).toContain('完成或取消'); expect(ctx.store.getBranch(branch.id).revisionId).toBe(branch.revisionId);
  });
});
