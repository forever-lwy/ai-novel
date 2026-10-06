import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import type { ProviderConfig, Settings } from '../shared/types.js';
import { defaultModelParameters, modelRoles } from '../shared/model-settings.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const servers: Server[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.app.close(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function context() {
  const app = await buildApp({ initialPassword: 'test-parameters-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-model-settings-')) }); apps.push(app);
  const loginResponse = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'test-parameters-password' } });
  return { ...app, session: loginResponse.cookies.find(cookie => cookie.name === 'session')!.value };
}
function settings(overrides: Partial<ProviderConfig> = {}): Settings {
  const { baseUrl = 'http://unused.invalid', apiKey = 'test-secret-key', protocol = 'gemini', ...parameters } = overrides;
  return { providers: [{ id: 'model', name: '测试连接', protocol, baseUrl, apiKey }], writingProviderId: 'model', planningProviderId: 'model', extractionProviderId: 'model', writingModel: 'test-model', planningModel: 'test-model', extractionModel: 'test-model', modelParameters: modelRoles.map(role => ({ ...defaultModelParameters(), maxOutputTokens: 8192, ...parameters, role, providerId: 'model', model: 'test-model' })) };
}
async function endpoint(reply: (body: any, response: import('node:http').ServerResponse) => void) {
  const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); reply(JSON.parse(Buffer.concat(chunks).toString()), response); });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}

it('round-trips optional parameters including zero and rejects conflicting thinking without changing saved settings', async () => {
  const ctx = await context(); const cookies = { session: ctx.session };
  const value = settings({ temperature: 0, topP: 0, topK: 1, seed: 0, presencePenalty: 0, frequencyPenalty: 0, stopSequences: ['END'], timeoutMs: 240000, stream: true, geminiThinking: { mode: 'budget', budget: 0 }, geminiIncludeThoughts: false, reasoningEffort: 'high' });
  const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: value });
  expect(saved.statusCode).toBe(200); expect(saved.body).not.toContain('test-secret-key');
  expect(saved.json().modelParameters[0]).toMatchObject({ temperature: 0, topP: 0, seed: 0, geminiThinking: { mode: 'budget', budget: 0 }, geminiIncludeThoughts: false, stream: true, timeoutMs: 240000 });
  expect(saved.json().providers[0]).not.toHaveProperty('temperature');
  const ambiguous = structuredClone(value) as any; ambiguous.modelParameters[0].geminiThinking.level = 'high';
  expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: ambiguous })).statusCode).toBe(400);
  const invalidClaude = settings({ protocol: 'claude', temperature: 0.2, claudeThinking: { type: 'enabled', budgetTokens: 2048 } });
  expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: invalidClaude })).statusCode).toBe(400);
  expect(ctx.settings.get().providers[0].protocol).toBe('gemini');
  const clear = structuredClone(value); delete clear.modelParameters![0].temperature; delete clear.modelParameters![0].geminiThinking; clear.providers[0].apiKey = '';
  expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: clear })).statusCode).toBe(200);
  expect(ctx.settings.get().modelParameters![0].temperature).toBeUndefined(); expect(ctx.settings.get().providers[0].apiKey).toBe('test-secret-key');
  expect(ctx.settings.get().modelParameters!.find(profile => profile.role === 'planning')).toMatchObject({ temperature: 0, geminiThinking: { mode: 'budget', budget: 0 } });
});

it('rejects malformed, duplicated and orphaned model parameter profiles without saving them', async () => {
  const ctx = await context(); ctx.settings.save(settings()); const before = ctx.settings.meta('settings');
  const valid = settings(); const profile = valid.modelParameters![0];
  const cases = [
    { ...valid, modelParameters: [{ ...profile, unknown: true }] },
    { ...valid, modelParameters: [{ ...profile, model: '' }] },
    { ...valid, modelParameters: [{ ...profile, model: 'x\u0000y' }] },
    { ...valid, modelParameters: [profile, { ...profile, model: ' test-model ' }] },
    { ...valid, modelParameters: [{ ...profile, providerId: 'missing' }] },
    { ...valid, modelParameters: [{ ...profile, contextTokens: profile.maxOutputTokens }] },
    { ...valid, modelParameters: [{ ...profile, maxOutputTokens: undefined }] },
    { ...valid, modelParameters: [{ ...profile, role: 'unknown' }] },
    { ...valid, modelParameters: [{ ...profile, role: undefined }, { ...profile, role: undefined, model: ' test-model ' }, profile] },
  ];
  for (const payload of cases) {
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: { session: ctx.session }, payload })).statusCode).toBe(400);
    expect(ctx.settings.meta('settings')).toBe(before);
  }
});

it('uses each selected model profile for connection tests and common defaults for an extra model', async () => {
  const ctx = await context(); const requests: any[] = [];
  const url = await endpoint((body, response) => { requests.push(body); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })); });
  const value = settings({ protocol: 'openai-chat', baseUrl: url, maxOutputTokens: 1024, temperature: 0.3 });
  value.modelParameters!.push({ ...defaultModelParameters(), role: 'writing', providerId: 'model', model: 'second-model', maxOutputTokens: 8192, contextTokens: 128000, temperature: 0 });
  ctx.settings.save(value);
  for (const model of ['test-model', 'second-model', 'new-model']) {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/test', cookies: { session: ctx.session }, payload: { providerId: 'model', model } });
    expect(response.json().ok).toBe(true);
  }
  expect(requests.map(body => [body.model, body.max_tokens, body.temperature])).toEqual([['test-model', 1024, 0.3], ['second-model', 8192, 0], ['new-model', 4096, 1]]);
  expect(ctx.settings.get().modelParameters).toHaveLength(4);
});

it('connection tests separate three roles using the same supplier and model and retain legacy role inference', async () => {
  const ctx = await context(); const requests: any[] = [];
  const url = await endpoint((body, response) => { requests.push(body); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })); });
  const value = settings({ protocol: 'openai-chat', baseUrl: url });
  value.modelParameters = modelRoles.map((role, index) => ({ ...defaultModelParameters(), role, providerId: 'model', model: 'test-model', maxOutputTokens: 1024 * (index + 1), temperature: index / 2 }));
  value.modelParameters.push({ ...defaultModelParameters(), role: 'extraction', providerId: 'model', model: 'extract-only', maxOutputTokens: 8192, temperature: 0.2 });
  ctx.settings.save(value);
  for (const payload of [...modelRoles.map(role => ({ providerId: 'model', model: 'test-model', role })), { providerId: 'model', model: 'test-model' }]) {
    expect((await ctx.app.inject({ method: 'POST', url: '/api/settings/test', cookies: { session: ctx.session }, payload })).json().ok).toBe(true);
  }
  value.extractionModel = 'extract-only'; ctx.settings.save(value);
  expect((await ctx.app.inject({ method: 'POST', url: '/api/settings/test', cookies: { session: ctx.session }, payload: { providerId: 'model', model: 'extract-only' } })).json().ok).toBe(true);
  expect(requests.map(body => [body.model, body.max_tokens, body.temperature])).toEqual([['test-model', 1024, 0], ['test-model', 2048, 0.5], ['test-model', 3072, 1], ['test-model', 1024, 0], ['extract-only', 8192, 0.2]]);
});

it('connection tests use the saved output cap and expose sanitized diagnostics even for an empty HTTP 500', async () => {
  const ctx = await context(); const cookies = { session: ctx.session }; const requests: any[] = [];
  const url = await endpoint((body, response) => { requests.push(body); response.writeHead(500, { 'content-type': 'application/json', 'x-request-id': 'safe-request-id', 'set-cookie': 'private-cookie' }); response.end(); });
  expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: settings({ baseUrl: url, temperature: 1, geminiThinking: { mode: 'level', level: 'low' } }) })).statusCode).toBe(200);
  const result = await ctx.app.inject({ method: 'POST', url: '/api/settings/test', cookies, payload: { providerId: 'model' } });
  expect(result.statusCode).toBe(200); expect(result.json().ok).toBe(false); expect(result.json().message).toContain('500');
  expect(requests).toHaveLength(1); expect(requests[0].generationConfig).toMatchObject({ maxOutputTokens: 8192, temperature: 1, thinkingConfig: { thinkingLevel: 'low' } });
  const capture = result.json().capture; expect(capture.httpStatus).toBe(500); expect(capture.rawResponse).toBe('');
  expect(JSON.parse(capture.request.body)).toEqual(requests[0]); expect(capture.request.timeoutMs).toBe(180000); expect(capture.diagnostics.responseBytes).toBe(0);
  expect(result.body).not.toContain('test-secret-key'); expect(result.body).not.toContain('private-cookie');
});

it('persists an in-flight request and its empty failure in one immutable author-only record and backup', async () => {
  const ctx = await context(); let entered = false; let finish!: () => void;
  const url = await endpoint((_body, response) => { entered = true; finish = () => { response.writeHead(500); response.end(); }; });
  ctx.settings.save(settings({ baseUrl: url, temperature: 0 }));
  const project = ctx.store.createProject({ title: '请求诊断测试' });
  const saved = ctx.store.saveChapter(project.mainBranchId, { baseRevisionId: ctx.store.getBranch(project.mainBranchId).revisionId, title: '一', text: '旅人看见灯塔。' });
  const job = ctx.engine.enqueue(project.mainBranchId, 'extract', { baseRevisionId: saved.branch.revisionId });
  const waitFor = async (check: () => boolean) => { const deadline = Date.now() + 4000; while (!check()) { if (Date.now() > deadline) throw new Error('本地模拟请求未完成'); await new Promise(resolve => setTimeout(resolve, 5)); } };
  await waitFor(() => entered); const before = ctx.engine.listOutputs(job.id); expect(before).toHaveLength(1);
  const id = before[0].id; expect(ctx.engine.outputDetail(job.id, id).output.request?.body).toContain('旅人看见灯塔');
  expect(before[0]).not.toHaveProperty('request'); expect((await ctx.app.inject({ url: `/api/jobs/${job.id}/outputs/${id}`, cookies: { session: ctx.session } })).statusCode).toBe(403);
  finish(); await waitFor(() => ctx.engine.listJobs().find(item => item.id === job.id)?.status === 'failed');
  expect(ctx.engine.listOutputs(job.id)).toHaveLength(1); const output = ctx.engine.outputDetail(job.id, id).output;
  expect(output.httpStatus).toBe(500); expect(output.diagnostics?.responseBytes).toBe(0); expect(output.request?.headers['x-goog-api-key']).toBe('[REDACTED]');
  expect(JSON.stringify(output)).not.toContain('test-secret-key'); expect(ctx.store.state(project.mainBranchId).entities).toHaveLength(0);
  expect(() => ctx.store.outputs.completeResponse(id, { rawResponse: 'replacement', text: 'replacement', inputTokens: 0, outputTokens: 0 })).toThrow('不能覆盖');
  const restored = ctx.store.restoreProject(ctx.store.exportProject(project.id)); const restoredJob = ctx.engine.listJobs(restored.id)[0];
  const restoredOutput = ctx.engine.outputDetail(restoredJob.id, ctx.engine.listOutputs(restoredJob.id)[0].id).output;
  expect(restoredOutput.request).toEqual(output.request); expect(restoredOutput.diagnostics).toEqual(output.diagnostics);
});

it('preserves Gemini block feedback in failed tasks and backups without treating it as a citation error', async () => {
  const ctx = await context(); let calls = 0;
  const url = await endpoint((_body, response) => {
    calls++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 12 } })}\n\n`);
  });
  ctx.settings.save(settings({ baseUrl: url, stream: true, geminiIncludeThoughts: true }));
  const project = ctx.store.createProject({ title: '模型反馈测试' });
  const saved = ctx.store.saveChapter(project.mainBranchId, { baseRevisionId: ctx.store.getBranch(project.mainBranchId).revisionId, title: '一', text: '旅人检查灯塔。' });
  const job = ctx.engine.enqueue(project.mainBranchId, 'extract', { baseRevisionId: saved.branch.revisionId });
  const deadline = Date.now() + 4000;
  while (ctx.engine.listJobs().find(item => item.id === job.id)?.status !== 'failed') { if (Date.now() > deadline) throw new Error('模拟任务未完成'); await new Promise(resolve => setTimeout(resolve, 5)); }
  const failed = ctx.engine.listJobs().find(item => item.id === job.id)!;
  expect(failed.error).toContain('拦截'); expect(failed.error).not.toContain('引用校验'); expect(calls).toBe(1);
  const output = ctx.engine.outputDetail(job.id, ctx.engine.listOutputs(job.id)[0].id).output;
  expect(output.diagnostics).toMatchObject({ modelOutcome: 'blocked', promptBlockReason: 'SAFETY' });
  expect(ctx.store.state(project.mainBranchId).entities).toHaveLength(0);
  const backup = ctx.store.exportProject(project.id); expect(JSON.stringify(backup)).not.toContain('test-secret-key');
  const restored = ctx.store.restoreProject(backup); const restoredJob = ctx.engine.listJobs(restored.id)[0];
  expect(ctx.engine.outputDetail(restoredJob.id, ctx.engine.listOutputs(restoredJob.id)[0].id).output.diagnostics).toEqual(output.diagnostics);
});
