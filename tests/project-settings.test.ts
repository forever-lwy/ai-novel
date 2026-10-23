import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import { buildApp } from '../server/app.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { ImageService } from '../server/images.js';
import { Store } from '../server/store.js';
import { SettingsStore, defaultSettings } from '../server/security.js';
import { checkBackupSize } from '../server/backup-limits.js';
import { readProjectSettings, saveProjectSettings } from '../server/project-settings.js';
import { collectProjectOverrides, projectModelSettings, resolveProjectSettings } from '../shared/project-settings.js';
import { defaultModelParameters, getModelParameters, modelRoles } from '../shared/model-settings.js';
import type { ModelRequest, ProjectSettingsOverrides, ProjectSettingsView, ProviderConfig, Settings } from '../shared/types.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

function fixture(): Settings {
  const settings = defaultSettings();
  settings.providers = [{ id: 'mock', name: '模拟连接', protocol: 'openai-chat', baseUrl: 'http://unused.invalid/v1', apiKey: 'project-fixture-secret' }];
  for (const role of modelRoles) {
    settings[`${role}ProviderId`] = 'mock'; settings[`${role}Model`] = `global-${role}`;
    settings.modelParameters!.push({ ...defaultModelParameters(), role, providerId: 'mock', model: `global-${role}` });
  }
  settings.imageSettings = { ...settings.imageSettings!, providerId: 'mock', model: 'global-image', autoCG: true, stylePrompt: '全局画风' };
  return settings;
}
function localOverrides(settings: Settings): ProjectSettingsOverrides {
  const tasks: NonNullable<ProjectSettingsOverrides['tasks']> = {};
  for (const role of modelRoles) {
    tasks[role] = { ...projectModelSettings(settings, role), model: `project-${role}`, modelParameters: [{ ...defaultModelParameters(), role, providerId: 'mock', model: `project-${role}`, temperature: 0.4 }] };
  }
  tasks.extraction!.extraction = { outputMode: 'structured', autoRetry: false, maxRetries: 1, retryDelayMs: 0 };
  const promptTemplates = structuredClone(settings.promptTemplates!);
  for (const task of ['writing', 'extraction', 'compression', 'image'] as const) {
    const preset = promptTemplates.presets[task].find(preset => preset.id === promptTemplates.selected[task])!;
    preset.blocks.push({ id: `project-${task}`, name: '作品规则', role: 'system', enabled: true, content: `PROJECT_${task} {{projectTitle}}` });
  }
  return { tasks, promptTemplates, imageSettings: { ...settings.imageSettings!, model: 'project-image', autoCG: false, autoPortrait: false, stylePrompt: '本作品水彩画风' } };
}
async function context() {
  const ctx = await buildApp({ initialPassword: 'project-settings-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-project-settings-')), startEngine: false });
  cleanup.push(() => ctx.app.close()); ctx.settings.save(fixture());
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'project-settings-password' } });
  const cookies = { session: login.cookies[0].value };
  const project = ctx.store.createProject({ title: '作品甲' });
  const url = `/api/projects/${project.id}/settings`;
  const read = async () => (await ctx.app.inject({ url, cookies })).json<ProjectSettingsView>();
  const save = async (overrides: unknown, revision = '0') => ctx.app.inject({ method: 'PUT', url, cookies, payload: { revision, overrides } });
  return { ...ctx, project, url, cookies, read, save };
}
async function terminal(engine: StoryEngine, id: string) {
  await vi.waitFor(() => expect(engine.listJobs().find(job => job.id === id)?.status).toMatch(/^(completed|failed|paused|stale|cancelled)$/));
  return engine.listJobs().find(job => job.id === id)!;
}

it('inherits live global settings without copying them into old or new projects and redacts provider credentials', async () => {
  const ctx = await context();
  const view = await ctx.read();
  expect(view.overrides).toEqual({}); expect(view.revision).toBe('0'); expect(view.effective).toEqual(view.global);
  expect(JSON.stringify(view)).not.toContain('project-fixture-secret');
  expect(ctx.store.db.prepare('SELECT * FROM project_settings').all()).toHaveLength(0);
  const changed = ctx.settings.get(); changed.writingModel = 'changed-global'; changed.imageSettings!.stylePrompt = '新画风'; ctx.settings.save(changed);
  expect((await ctx.read()).effective).toMatchObject({ writingModel: 'changed-global', imageSettings: { stylePrompt: '新画风' } });
  expect((await ctx.app.inject({ url: ctx.url })).statusCode).toBe(401);
  expect((await ctx.app.inject({ url: '/api/projects/missing/settings', cookies: ctx.cookies })).statusCode).toBe(404);
});

it('isolates each opted-in group, keeps connections global and restores inheritance against the latest global value', async () => {
  const ctx = await context(); const other = ctx.store.createProject({ title: '作品乙' });
  const initial = ctx.settings.meta('settings');
  const overrides = localOverrides(ctx.settings.get()); delete overrides.tasks!.planning;
  const saved = await ctx.save(overrides); expect(saved.statusCode, saved.body).toBe(200);
  expect(ctx.settings.meta('settings')).toBe(initial);
  const changed = ctx.settings.get(); changed.writingModel = 'global-next'; changed.planningModel = 'planning-next'; changed.providers[0].baseUrl = 'http://new-fixture.invalid/v1'; changed.providers[0].apiKey = 'new-fixture-secret'; ctx.settings.save(changed);
  const effective = ctx.settings.get(ctx.project.id);
  expect(effective.writingModel).toBe('project-writing'); expect(effective.planningModel).toBe('planning-next');
  expect(effective.taskSettings!.extraction.outputMode).toBe('structured');
  expect(effective.providers[0]).toMatchObject({ baseUrl: changed.providers[0].baseUrl, apiKey: 'new-fixture-secret' });
  expect(effective.imageSettings!.stylePrompt).toBe('本作品水彩画风');
  expect(ctx.settings.get(other.id).writingModel).toBe('global-next');
  const reset = await ctx.save({}, saved.json().revision); expect(reset.statusCode).toBe(200);
  expect(reset.json().effective.writingModel).toBe('global-next'); expect(reset.json().overrides).toEqual({});
});

it('preserves omitted optional parameters and explicit empty selections instead of filling from global', async () => {
  const ctx = await context(); const settings = ctx.settings.get(); const task = projectModelSettings(settings, 'writing');
  delete task.modelParameters[0].temperature; delete task.modelParameters[0].topP;
  expect((await ctx.save({ tasks: { writing: task } })).statusCode).toBe(200);
  const resolved = ctx.settings.get(ctx.project.id);
  expect(getModelParameters(resolved, 'writing', 'mock', 'global-writing')).not.toHaveProperty('temperature');
  expect(getModelParameters(resolved, 'writing', 'mock', 'global-writing')).not.toHaveProperty('topP');
  const record = await ctx.read();
  const disabled = await ctx.save({ tasks: { writing: { providerId: '', model: '', modelParameters: [] } } }, record.revision);
  expect(disabled.statusCode).toBe(200); expect(disabled.json().effective.writingProviderId).toBe('');
  expect(disabled.json().effective.writingModel).toBe('');
});

it('rejects stale saves and malformed or provider-bearing overrides without changing persisted state', async () => {
  const ctx = await context(); const overrides = localOverrides(ctx.settings.get());
  const saved = await ctx.save(overrides); const revision = saved.json().revision;
  expect((await ctx.save({}, '0')).statusCode).toBe(409);
  const invalid = [
    { providers: fixture().providers }, { tasks: { writing: { ...overrides.tasks!.writing, apiKey: 'forbidden' } } },
    { tasks: { writing: { ...overrides.tasks!.writing, providerId: 'missing' } } },
    { tasks: { writing: { ...overrides.tasks!.writing, model: '' } } },
    { tasks: { extraction: { ...overrides.tasks!.extraction, extraction: { outputMode: 'bad' } } } },
    { imageSettings: { ...overrides.imageSettings, providerId: 'missing' } },
    { imageSettings: { ...overrides.imageSettings, promptProviderId: 'mock', promptModel: '' } },
    { promptTemplates: { ...overrides.promptTemplates, selected: {} } },
    { tasks: { writing: { ...overrides.tasks!.writing, modelParameters: overrides.tasks!.extraction!.modelParameters } } },
  ];
  for (const value of invalid) expect((await ctx.save(value, revision)).statusCode).toBe(400);
  expect((await ctx.read()).revision).toBe(revision);
  expect((await ctx.read()).overrides).toEqual(overrides);
});

it('persists across database reopen, roundtrips only local overrides through backup and cleans up on deletion', async () => {
  const ctx = await context(); const overrides = localOverrides(ctx.settings.get());
  expect(() => checkBackupSize(ctx.store.db, join(ctx.dataDir, 'sources'), ctx.project.id, 8192)).not.toThrow();
  expect((await ctx.save(overrides)).statusCode).toBe(200);
  expect(() => checkBackupSize(ctx.store.db, join(ctx.dataDir, 'sources'), ctx.project.id, 8192)).toThrow('安全容量');
  const backup = ctx.store.exportProject(ctx.project.id);
  expect(backup.projectSettings).toEqual(overrides);
  expect(JSON.stringify(backup)).not.toContain('project-fixture-secret'); expect(JSON.stringify(backup)).not.toContain('http://unused.invalid');
  const restored = ctx.store.restoreProject(backup);
  expect(readProjectSettings(ctx.store.db, restored.id).overrides).toEqual(overrides);
  const { projectSettings: _omitted, ...legacy } = backup;
  const restoredLegacy = ctx.store.restoreProject(legacy);
  expect(readProjectSettings(ctx.store.db, restoredLegacy.id).overrides).toEqual({});
  const reopened = new Store(ctx.dataDir); cleanup.push(() => reopened.close());
  expect(new SettingsStore(reopened.db, ctx.dataDir).get(restored.id).writingModel).toBe('project-writing');
  const before = ctx.store.listProjects().length;
  expect(() => ctx.store.restoreProject({ ...backup, projectSettings: { providers: fixture().providers } })).toThrow('作品设置');
  expect(() => ctx.store.restoreProject({ ...backup, projectSettings: null })).toThrow('作品设置');
  expect(ctx.store.listProjects()).toHaveLength(before);
  ctx.store.deleteProject(ctx.project.id);
  expect(ctx.store.db.prepare('SELECT * FROM project_settings WHERE project_id=?').get(ctx.project.id)).toBeUndefined();
  expect(ctx.settings.get(restored.id).writingModel).toBe('project-writing');
});

it('keeps unresolved provider references after restore or deletion and does not silently use a different model', async () => {
  const ctx = await context(); const overrides = localOverrides(ctx.settings.get());
  await ctx.save(overrides);
  const settings = fixture(); settings.providers = [{ id: 'replacement', name: '替代连接', protocol: 'openai-chat', baseUrl: 'http://replacement.invalid' }];
  settings.writingProviderId = settings.planningProviderId = settings.extractionProviderId = 'replacement'; settings.modelParameters = [];
  ctx.settings.save(settings);
  expect(ctx.settings.get(ctx.project.id).extractionProviderId).toBe('mock');
  const restored = ctx.store.restoreProject(ctx.store.exportProject(ctx.project.id));
  expect(ctx.settings.get(restored.id).writingProviderId).toBe('mock');
  const view = ctx.store.saveChapter(ctx.project.mainBranchId, { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, title: '已有正文', text: '原文保留。' });
  expect(() => ctx.engine.reextractChapter(ctx.project.mainBranchId, view.branch.revisionId, view.state.chapters[0].id)).toThrow('供应商');
  expect(ctx.store.getBranch(ctx.project.mainBranchId).revisionId).toBe(view.branch.revisionId);
  const collected = collectProjectOverrides(resolveProjectSettings(ctx.settings.get(), overrides), overrides);
  expect(collected.tasks!.writing!.modelParameters).toEqual(overrides.tasks!.writing!.modelParameters);
  for (const role of modelRoles) collected.tasks![role]!.providerId = 'replacement';
  collected.imageSettings!.providerId = 'replacement';
  expect((await ctx.save(collected, (await ctx.read()).revision)).statusCode).toBe(200);
  expect((await ctx.read()).overrides.tasks!.writing!.modelParameters).toContainEqual(overrides.tasks!.writing!.modelParameters[0]);
});

it('routes writing, automatic naming, extraction and compression through the owning project with matching prompts and parameters', async () => {
  const ctx = await context(); const overrides = localOverrides(ctx.settings.get()); await ctx.save(overrides);
  const other = ctx.store.createProject({ title: '作品乙' });
  const calls: { provider: ProviderConfig; request: ModelRequest }[] = [];
  const models: TextModels = {
    generateText: vi.fn(async (provider, request) => { calls.push({ provider, request }); return { text: '旅人走进长街。', inputTokens: 3, outputTokens: 4 }; }),
    generateStructured: vi.fn(async (provider, request, validate) => {
      calls.push({ provider, request });
      const value = request.system.includes('# 章节自动命名') ? { title: '长街' } : provider.model.endsWith('planning') ? { text: '旅人入城。' } : { summary: '旅人走进长街，寻找远处的城门。', entities: [], relations: [], foreshadows: [] };
      return { value: validate(value), inputTokens: 3, outputTokens: 4 };
    }),
  };
  const engine = new StoryEngine(ctx.store, id => ctx.settings.get(id), models, { generateAutomatic: () => undefined }); cleanup.push(() => engine.close()); engine.start();
  const writing = engine.enqueue(ctx.project.mainBranchId, 'generate', { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, mode: 'original', instruction: '继续' });
  expect((await terminal(engine, writing.id)).status).toBe('completed');
  const extract = engine.listJobs(ctx.project.id).find(job => job.kind === 'extract')!;
  expect((await terminal(engine, extract.id)).status).toBe('completed');
  const compression = engine.enqueue(ctx.project.mainBranchId, 'plan', { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, purpose: 'compress-summary' });
  expect((await terminal(engine, compression.id)).status).toBe('completed');
  expect(calls.map(call => call.provider.model)).toEqual(['project-writing', 'project-writing', 'project-extraction', 'project-planning']);
  expect(calls.every(call => call.provider.temperature === 0.4)).toBe(true);
  for (const [index, task] of [[0, 'writing'], [2, 'extraction'], [3, 'compression']] as const) expect(JSON.stringify(calls[index].request)).toContain(`PROJECT_${task} 作品甲`);
  expect(calls[0].request.tools!.some(tool => tool.name === 'generate_scene_cg')).toBe(false);
  expect(calls[2].request.structuredOutput?.mode).toBe('json_schema');
  const inherited = engine.enqueue(other.mainBranchId, 'generate', { baseRevisionId: ctx.store.getBranch(other.mainBranchId).revisionId, mode: 'original', title: '已有题名' });
  expect((await terminal(engine, inherited.id)).status).toBe('completed');
  const otherExtraction = engine.listJobs(other.id).find(job => job.kind === 'extract')!; await terminal(engine, otherExtraction.id);
  expect(calls[4].provider.model).toBe('global-writing'); expect(JSON.stringify(calls[4].request)).not.toContain('PROJECT_writing');
  expect(calls[4].request.tools!.some(tool => tool.name === 'generate_scene_cg')).toBe(true);
});

it('uses project image configuration and passes effective prompt and text-model settings to the optimizer', async () => {
  const ctx = await context(); await ctx.save(localOverrides(ctx.settings.get()));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=', 'base64');
  const optimizer = vi.fn(async (_settings: Settings, input: { stylePrompt: string }) => ({ prompt: input.stylePrompt, referenceEntityIds: [], parameters: {} }));
  const generator = vi.fn(async () => ({ bytes: png, mimeType: 'image/png' as const }));
  const images = new ImageService(ctx.store, id => ctx.settings.get(id), generator, optimizer); cleanup.push(() => images.close());
  const state = ctx.store.state(ctx.project.mainBranchId);
  state.entities.push({ id: 'location', kind: 'location', name: '古城', aliases: [], description: '城墙环绕的城市。', visibility: 'public', locked: true, facts: [] });
  ctx.store.commit(ctx.project.mainBranchId, ctx.store.getBranch(ctx.project.mainBranchId).revisionId, state, '地点资料');
  const generated = images.generate(ctx.project.mainBranchId, { baseRevisionId: ctx.store.getBranch(ctx.project.mainBranchId).revisionId, kind: 'map' });
  await vi.waitFor(() => expect(ctx.store.images.get(generated.image.id)?.status).toBe('completed'));
  expect(optimizer.mock.calls[0][0].planningModel).toBe('project-planning');
  expect(JSON.stringify(optimizer.mock.calls[0][0].promptTemplates)).toContain('PROJECT_image');
  expect(ctx.store.images.get(generated.image.id)).toMatchObject({ prompt: '本作品水彩画风', generationParameters: { model: 'project-image' } });
});

it('tests the selected project model using its actual parameters over local HTTP', async () => {
  const calls: any[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await listenLocalServer(server); cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const ctx = await context(); const settings = fixture(); settings.providers[0].baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`; ctx.settings.save(settings);
  await ctx.save(localOverrides(ctx.settings.get()));
  const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/test', cookies: ctx.cookies, payload: { projectId: ctx.project.id, role: 'writing', providerId: 'mock', model: 'project-writing' } });
  expect(response.statusCode, response.body).toBe(200); expect(response.json().ok).toBe(true);
  expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ model: 'project-writing', temperature: 0.4 });
});
