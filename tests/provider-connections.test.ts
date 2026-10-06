import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import type { ProviderConnection, Settings } from '../shared/types.js';
import { defaultModelParameters, modelRoles } from '../shared/model-settings.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const ctx of apps.splice(0)) await ctx.app.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function context() {
  const ctx = await buildApp({ initialPassword: 'provider-test-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-provider-connections-')), startEngine: false }); apps.push(ctx);
  const loginResponse = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'provider-test-password' } });
  return { ...ctx, cookies: { session: loginResponse.cookies.find(cookie => cookie.name === 'session')!.value } };
}
function provider(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return { id: 'upstream', name: '测试供应商', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', maxOutputTokens: 2048, contextTokens: 64000, ...overrides };
}
function settings(connection = provider()): Settings {
  return { providers: [connection], writingProviderId: connection.id, planningProviderId: connection.id, extractionProviderId: connection.id, writingModel: 'writer', planningModel: 'planner', extractionModel: 'extractor' };
}
async function endpoint(handler: (request: IncomingMessage, response: ServerResponse, body?: any) => void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString(); handler(request, response, raw ? JSON.parse(raw) : undefined);
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
}
function json(response: ServerResponse, value: unknown, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
function seedReadyChapter(ctx: Awaited<ReturnType<typeof context>>, branchId: string) {
  const saved = ctx.store.saveChapter(branchId, { baseRevisionId: ctx.store.getBranch(branchId).revisionId, title: '已有开场', text: '旅人离开村庄。' });
  ctx.store.applyExtraction(branchId, saved.branch.revisionId, saved.state.chapters[0].id, { summary: '旅人离开村庄。', entities: [], relations: [], foreshadows: [] }, true);
}

async function waitForTask(engine: Awaited<ReturnType<typeof buildApp>>['engine'], id: string) {
  const deadline = Date.now() + 4000;
  while (!['completed', 'failed'].includes(engine.listJobs().find(job => job.id === id)!.status)) {
    if (Date.now() > deadline) throw new Error('本地模拟任务未完成'); await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(engine.listJobs().find(job => job.id === id)?.status).toBe('completed');
}

describe('provider connections and task model assignments', () => {
  it('drops legacy task limits while migrating supplier limits into each assigned model and preserving keys', async () => {
    const ctx = await context();
    expect(ctx.settings.public()).not.toHaveProperty('taskTokenLimit');
    const configured = settings(provider({ apiKey: 'legacy-budget-key', maxOutputTokens: 64000, contextTokens: 512000 }));
    ctx.settings.save(configured);
    const legacy = { ...JSON.parse(ctx.settings.meta('settings')!), taskTokenLimit: 100000 };
    ctx.settings.setMeta('settings', JSON.stringify(legacy));
    const read = await ctx.app.inject({ url: '/api/settings', cookies: ctx.cookies });
    expect(read.statusCode).toBe(200);
    expect(read.json()).not.toHaveProperty('taskTokenLimit');
    expect(ctx.settings.get()).not.toHaveProperty('taskTokenLimit');
    expect(read.json()).toMatchObject({ writingProviderId: 'upstream', planningProviderId: 'upstream', extractionProviderId: 'upstream', writingModel: 'writer', planningModel: 'planner', extractionModel: 'extractor', providers: [{ hasKey: true }], modelParameters: modelRoles.map((role, index) => ({ role, providerId: 'upstream', model: ['writer', 'planner', 'extractor'][index], maxOutputTokens: 64000, contextTokens: 512000 })) });
    expect(read.json().providers[0]).not.toHaveProperty('maxOutputTokens');
    const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: { ...read.json(), taskTokenLimit: 2480 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual(read.json());
    expect(JSON.parse(ctx.settings.meta('settings')!)).not.toHaveProperty('taskTokenLimit');
    expect(ctx.settings.get().providers[0]).toMatchObject({ apiKey: 'legacy-budget-key' });
    expect(ctx.settings.get().modelParameters?.every(profile => profile.maxOutputTokens === 64000 && profile.contextTokens === 512000)).toBe(true);
    expect(ctx.settings.meta('settings')).not.toContain('legacy-budget-key');
    expect(saved.body).not.toContain('legacy-budget-key');
    ctx.settings.save({ ...configured, taskTokenLimit: 1 } as Settings);
    expect(JSON.parse(ctx.settings.meta('settings')!)).not.toHaveProperty('taskTokenLimit');
  });

  it('upgrades persisted legacy models by task without exposing or losing encrypted keys', async () => {
    const ctx = await context();
    ctx.settings.save(settings(provider({ apiKey: 'legacy-private-key' })));
    const legacy = JSON.parse(ctx.settings.meta('settings')!);
    legacy.providers[0].model = 'old-shared-model';
    legacy.providers[0].maxOutputTokens = 6144; legacy.providers[0].contextTokens = 128000; legacy.providers[0].temperature = 0;
    legacy.providers.push({ ...legacy.providers[0], id: 'other', model: 'old-planner-model' });
    legacy.planningProviderId = 'other';
    delete legacy.writingModel; delete legacy.planningModel; delete legacy.extractionModel;
    delete legacy.modelParameters;
    ctx.settings.setMeta('settings', JSON.stringify(legacy));
    const read = await ctx.app.inject({ url: '/api/settings', cookies: ctx.cookies });
    expect(read.json()).toMatchObject({ writingModel: 'old-shared-model', planningModel: 'old-planner-model', extractionModel: 'old-shared-model' });
    expect(read.json().modelParameters).toEqual([{ role: 'writing', providerId: 'upstream', model: 'old-shared-model', maxOutputTokens: 6144, contextTokens: 128000, temperature: 0 }, { role: 'planning', providerId: 'other', model: 'old-planner-model', maxOutputTokens: 6144, contextTokens: 128000, temperature: 0 }, { role: 'extraction', providerId: 'upstream', model: 'old-shared-model', maxOutputTokens: 6144, contextTokens: 128000, temperature: 0 }]);
    expect(read.json().providers.every((value: ProviderConnection) => !('model' in value))).toBe(true);
    expect(read.body).not.toContain('legacy-private-key');
    expect(ctx.settings.get().providers[0].apiKey).toBe('legacy-private-key');
    const migrated = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: read.json() });
    expect(migrated.statusCode).toBe(200);
    expect(ctx.settings.meta('settings')).not.toContain('legacy-private-key');
    expect(JSON.parse(ctx.settings.meta('settings')!).providers.every((value: ProviderConnection) => !('model' in value))).toBe(true);
    expect(ctx.settings.get().providers[0].apiKey).toBe('legacy-private-key');
    const extra = { ...read.json(), writingModel: 'new-model' };
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: extra })).statusCode).toBe(200);
    expect(ctx.settings.get().modelParameters?.find(profile => profile.model === 'new-model')).toMatchObject({ maxOutputTokens: 4096, contextTokens: 64000, temperature: 1, topP: 1 });
  });

  it('accepts legacy requests and gives explicit task models precedence while saving unassigned connections without a model', async () => {
    const ctx = await context();
    const legacy = settings(provider({ model: 'legacy-model' }));
    delete legacy.planningModel; delete legacy.extractionModel;
    legacy.writingModel = 'custom-writer';
    const result = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: legacy });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ writingModel: 'custom-writer', planningModel: 'legacy-model', extractionModel: 'legacy-model' });
    const unassigned = { ...settings(), writingProviderId: '', planningProviderId: '', extractionProviderId: '' };
    const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: unassigned });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ writingModel: '', planningModel: '', extractionModel: '' });
    expect(saved.json().providers[0]).not.toHaveProperty('model');
  });

  it('upgrades shared legacy profiles into independent task profiles while retaining historical models and encrypted keys', async () => {
    const ctx = await context();
    ctx.settings.save({ ...settings(provider({ apiKey: 'shared-profile-private-key' })), writingModel: 'shared', planningModel: 'shared', extractionModel: 'shared' });
    const legacy = JSON.parse(ctx.settings.meta('settings')!);
    const shared = { providerId: 'upstream', model: 'shared', maxOutputTokens: 6144, contextTokens: 128000, temperature: 0, stopSequences: ['END'] };
    legacy.modelParameters = [shared, { ...shared, model: 'historical-model', maxOutputTokens: 8192 }, { ...shared, role: 'extraction', maxOutputTokens: 2048, temperature: undefined, stopSequences: undefined }];
    ctx.settings.setMeta('settings', JSON.stringify(legacy));
    const read = await ctx.app.inject({ url: '/api/settings', cookies: ctx.cookies });
    expect(read.statusCode).toBe(200); expect(read.body).not.toContain('shared-profile-private-key');
    const value = read.json() as Settings;
    expect(value.modelParameters).toHaveLength(6);
    expect(value.modelParameters?.filter(profile => profile.model === 'historical-model').map(profile => profile.role)).toEqual([...modelRoles]);
    expect(value.modelParameters?.find(profile => profile.role === 'planning' && profile.model === 'shared')).toMatchObject({ maxOutputTokens: 6144, temperature: 0, stopSequences: ['END'] });
    const extraction = value.modelParameters!.find(profile => profile.role === 'extraction' && profile.model === 'shared')!;
    expect(extraction).toMatchObject({ maxOutputTokens: 2048 }); expect(extraction).not.toHaveProperty('temperature'); expect(extraction).not.toHaveProperty('stopSequences');
    value.modelParameters!.find(profile => profile.role === 'planning' && profile.model === 'shared')!.temperature = 0.8;
    const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: value });
    expect(saved.statusCode).toBe(200); expect(saved.body).not.toContain('shared-profile-private-key');
    expect(JSON.parse(ctx.settings.meta('settings')!).modelParameters.every((profile: { role?: string }) => profile.role)).toBe(true);
    expect(ctx.settings.get().providers[0].apiKey).toBe('shared-profile-private-key');
    expect(ctx.settings.get().modelParameters!.filter(profile => profile.model === 'shared').map(profile => [profile.role, profile.temperature, profile.maxOutputTokens])).toEqual([['writing', 0, 6144], ['planning', 0.8, 6144], ['extraction', undefined, 2048]]);
  });

  it('rejects missing providers, empty or malformed task models and duplicate connections without mutation', async () => {
    const ctx = await context(); ctx.settings.save(settings()); const before = ctx.settings.meta('settings');
    const cases = [
      { ...settings(), planningProviderId: 'unknown' },
      { ...settings(), writingModel: '   ' },
      { ...settings(), extractionModel: undefined },
      { ...settings(), planningModel: 'name\u0000suffix' },
      { ...settings(), writingModel: 'x'.repeat(301) },
      { ...settings(), providers: [provider(), provider()] },
    ];
    for (const input of cases) {
      const result = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: input });
      expect(result.statusCode).toBe(400); expect(ctx.settings.meta('settings')).toBe(before);
    }
  });

  it('looks up unsaved drafts using same-origin keys and honors replacement keys and explicit removal without saving drafts', async () => {
    const ctx = await context(); const credentials: (string | undefined)[] = [];
    const baseUrl = await endpoint((request, response) => { credentials.push(request.headers.authorization); json(response, { data: [{ id: 'available-model' }] }); });
    const movedCredentials: (string | undefined)[] = [];
    const movedUrl = await endpoint((request, response) => { movedCredentials.push(request.headers.authorization); json(response, { data: [{ id: 'moved-model' }] }); });
    ctx.settings.save(settings(provider({ baseUrl, apiKey: 'saved-key' })));
    const before = ctx.settings.meta('settings');
    const call = (connection: ProviderConnection) => ctx.app.inject({ method: 'POST', url: '/api/settings/models', cookies: ctx.cookies, payload: { provider: connection } });
    const same = await call(provider({ baseUrl, apiKey: '', hasKey: true }));
    expect(same.statusCode).toBe(200); expect(same.json().models).toEqual([{ id: 'available-model' }]);
    const removed = await call(provider({ baseUrl, clearApiKey: true }));
    expect(removed.statusCode).toBe(200);
    const replacement = await call(provider({ baseUrl, apiKey: 'replacement-key' }));
    expect(replacement.statusCode).toBe(200);
    const moved = await call(provider({ baseUrl: movedUrl, hasKey: true }));
    expect(moved.statusCode).toBe(200);
    expect(credentials).toEqual(['Bearer saved-key', undefined, 'Bearer replacement-key']);
    expect(movedCredentials).toEqual([undefined]);
    expect(ctx.settings.meta('settings')).toBe(before);
    expect(same.body).not.toContain('saved-key');
  });

  it('requires login, rejects ambiguous discovery bodies and hides upstream failure bodies', async () => {
    const ctx = await context(); let calls = 0;
    const baseUrl = await endpoint((_request, response) => { calls++; json(response, { error: { message: 'private-draft-key internal-upstream-detail' } }, 401); });
    const connection = provider({ baseUrl, apiKey: 'private-draft-key' });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/settings/models', payload: { provider: connection } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/settings/models', cookies: ctx.cookies, payload: { providerId: 'upstream', provider: connection } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/settings/models', cookies: ctx.cookies, payload: { providerId: 'missing' } })).statusCode).toBe(404);
    const failed = await ctx.app.inject({ method: 'POST', url: '/api/settings/models', cookies: ctx.cookies, payload: { provider: connection } });
    expect(failed.statusCode).toBe(502); expect(failed.body).not.toContain('private-draft-key'); expect(failed.body).not.toContain('internal-upstream-detail'); expect(calls).toBe(1);
  });

  it('routes planning, writing and extraction through distinct models on one supplier', async () => {
    const ctx = await context(); const requests: { model: string; max_tokens: number; temperature: number }[] = [];
    const baseUrl = await endpoint((_request, response, body) => {
      requests.push(body);
      const text = body.model === 'planner' ? JSON.stringify({ coarse: '旅人寻找灯塔', fine: [2, 3, 4, 5].map(chapter => ({ chapter, title: `${chapter}`, goal: '寻找线索' })), foreshadows: [] })
        : body.model === 'extractor' ? JSON.stringify({ summary: '旅人抵达灯塔', entities: [], relations: [], foreshadows: [] }) : '旅人来到灯塔。';
      json(response, { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    });
    ctx.settings.save({ ...settings(provider({ baseUrl })), modelParameters: ['writer', 'planner', 'extractor'].map((model, index) => ({ ...defaultModelParameters(), role: modelRoles[index], providerId: 'upstream', model, maxOutputTokens: 1024 * (index + 1), contextTokens: 128000, temperature: index / 2 })) });
    const project = ctx.store.createProject({ title: '分任务模型' }); seedReadyChapter(ctx, project.mainBranchId); const branch = ctx.store.getBranch(project.mainBranchId);
    ctx.engine.start(); const planJob = ctx.engine.enqueue(branch.id, 'plan', { baseRevisionId: branch.revisionId });
    await waitForTask(ctx.engine, planJob.id);
    const job = ctx.engine.enqueue(branch.id, 'generate', { baseRevisionId: ctx.store.getBranch(branch.id).revisionId, mode: 'original', instruction: '继续写作' });
    const deadline = Date.now() + 4000;
    while (!['completed', 'failed'].includes(ctx.engine.listJobs().find(value => value.id === job.id)!.status)) {
      if (Date.now() > deadline) throw new Error('本地模拟任务未完成'); await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(ctx.engine.listJobs().find(value => value.id === job.id)).toMatchObject({ status: 'completed' });
    await waitForTask(ctx.engine, ctx.engine.listJobs().find(value => value.kind === 'extract')!.id);
    expect(requests.map(body => [body.model, body.max_tokens, body.temperature])).toEqual([['planner', 2048, 0.5], ['writer', 1024, 0], ['extractor', 3072, 1]]);
    expect(ctx.store.state(branch.id).chapters).toHaveLength(2); expect(ctx.store.state(branch.id).chapters[1].status).toBe('ready');
  });

  it('tests a custom model explicitly and rejects tests without an assigned or supplied model before sending requests', async () => {
    const ctx = await context(); const requestedModels: string[] = [];
    const baseUrl = await endpoint((_request, response, body) => { requestedModels.push(body.model); json(response, { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }); });
    ctx.settings.save({ ...settings(provider({ baseUrl })), writingProviderId: '', planningProviderId: '', extractionProviderId: '' });
    const missing = await ctx.app.inject({ method: 'POST', url: '/api/settings/test', cookies: ctx.cookies, payload: { providerId: 'upstream' } });
    expect(missing.statusCode).toBe(400); expect(requestedModels).toEqual([]);
    const result = await ctx.app.inject({ method: 'POST', url: '/api/settings/test', cookies: ctx.cookies, payload: { providerId: 'upstream', model: 'custom-remote-model' } });
    expect(result.statusCode).toBe(200); expect(result.json().ok).toBe(true); expect(requestedModels).toEqual(['custom-remote-model']);
  });

  it('uses independent role limits and temperatures for planning, writing and extraction on the same supplier and model', async () => {
    const ctx = await context(); const requests: { model: string; max_tokens: number; temperature: number }[] = [];
    const baseUrl = await endpoint((_request, response, body) => {
      requests.push(body);
      const text = body.max_tokens === 2048 ? JSON.stringify({ coarse: '旅人寻找灯塔', fine: [2, 3, 4, 5].map(chapter => ({ chapter, title: `${chapter}`, goal: '寻找线索' })), foreshadows: [] })
        : body.max_tokens === 3072 ? JSON.stringify({ summary: '旅人抵达灯塔', entities: [], relations: [], foreshadows: [] }) : '旅人来到灯塔。';
      json(response, { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    });
    ctx.settings.save({ ...settings(provider({ baseUrl })), writingModel: 'shared-model', planningModel: 'shared-model', extractionModel: 'shared-model', modelParameters: modelRoles.map((role, index) => ({ ...defaultModelParameters(), role, providerId: 'upstream', model: 'shared-model', maxOutputTokens: 1024 * (index + 1), contextTokens: 128000, temperature: index / 2 })) });
    const project = ctx.store.createProject({ title: '相同模型按任务隔离参数' }); seedReadyChapter(ctx, project.mainBranchId); const branch = ctx.store.getBranch(project.mainBranchId);
    ctx.engine.start(); const planJob = ctx.engine.enqueue(branch.id, 'plan', { baseRevisionId: branch.revisionId });
    await waitForTask(ctx.engine, planJob.id);
    const job = ctx.engine.enqueue(branch.id, 'generate', { baseRevisionId: ctx.store.getBranch(branch.id).revisionId, mode: 'original', instruction: '继续写作' });
    const deadline = Date.now() + 4000;
    while (!['completed', 'failed'].includes(ctx.engine.listJobs().find(value => value.id === job.id)!.status)) {
      if (Date.now() > deadline) throw new Error('本地模拟任务未完成'); await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(ctx.engine.listJobs().find(value => value.id === job.id)).toMatchObject({ status: 'completed' });
    await waitForTask(ctx.engine, ctx.engine.listJobs().find(value => value.kind === 'extract')!.id);
    expect(requests.map(body => [body.model, body.max_tokens, body.temperature])).toEqual([['shared-model', 2048, 0.5], ['shared-model', 1024, 0], ['shared-model', 3072, 1]]);
    expect(ctx.store.state(branch.id).chapters).toHaveLength(2); expect(ctx.store.state(branch.id).chapters[1].status).toBe('ready');
  });
});
