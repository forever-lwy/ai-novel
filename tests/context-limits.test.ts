import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StoryEngine } from '../server/engine.js';
import type { Job, Settings } from '../shared/types.js';

const stores: Store[] = [];
const engines: StoryEngine[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const store of stores.splice(0)) store.close();
});

type GeminiBody = {
  systemInstruction: { parts: { text: string }[] };
  contents: { parts: { text: string }[] }[];
  generationConfig: { maxOutputTokens: number };
};
const extraction = JSON.stringify({ summary: '旅人来到灯塔', entities: [], relations: [], foreshadows: [] });
function settings(baseUrl: string, contextTokens = 512000): Settings {
  return {
    providers: [{ id: 'local', name: '本地协议模拟服务', protocol: 'gemini', baseUrl }],
    writingProviderId: 'local', planningProviderId: 'local', extractionProviderId: 'local',
    writingModel: 'writer', planningModel: 'planner', extractionModel: 'extractor',
    modelParameters: (['writing', 'planning', 'extraction'] as const).map(role => ({ role, providerId: 'local', model: role === 'writing' ? 'writer' : role === 'planning' ? 'planner' : 'extractor', maxOutputTokens: 64000, contextTokens })),
  };
}
async function upstream(reply: (path: string, body: GeminiBody, index: number) => unknown) {
  const calls: { path: string; body: GeminiBody }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as GeminiBody;
    const path = request.url!; calls.push({ path, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply(path, body, calls.length - 1)));
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1beta` };
}
function gemini(text = extraction, finishReason = 'STOP', usage = true) {
  return { candidates: [{ finishReason, content: { parts: [{ text }] } }], ...(usage ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } } : {}) };
}
function harness(config: Settings) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ai-novel-context-limits-'))); stores.push(store);
  const engine = new StoryEngine(store, () => config); engines.push(engine);
  return { store, engine };
}
function queuedExtraction(config: Settings, text = '旅人来到灯塔。') {
  const ctx = harness(config); const project = ctx.store.createProject({ title: '单次上下文测试' });
  const branch = ctx.store.getBranch(project.mainBranchId);
  const saved = ctx.store.saveChapter(branch.id, { baseRevisionId: branch.revisionId, title: '抵达', text });
  const job = ctx.engine.enqueue(branch.id, 'extract', { baseRevisionId: saved.branch.revisionId });
  return { ...ctx, branchId: branch.id, job };
}
function persistedJob(store: Store, id: string): Job {
  return JSON.parse(String(store.db.prepare('SELECT data FROM jobs WHERE id=?').get(id)!.data)) as Job;
}
function seedUsage(store: Store, id: string, inputTokens: number, outputTokens = 0) {
  const job = persistedJob(store, id); job.inputTokens = inputTokens; job.outputTokens = outputTokens;
  store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), id);
}
async function terminal(engine: StoryEngine, id: string) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const job = engine.listJobs().find(value => value.id === id)!;
    if (['completed', 'failed', 'cancelled', 'stale'].includes(job.status)) { await new Promise(resolve => setTimeout(resolve, 5)); return job; }
    if (Date.now() > deadline) throw new Error(`本地模拟任务未结束：${JSON.stringify(job)}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
describe('single-request context and output limits', () => {
  it('sends the configured 64000 Gemini output tokens even when a legacy cumulative budget would leave only 2480', async () => {
    const fixture = await upstream(() => gemini());
    const probe = queuedExtraction(settings(fixture.baseUrl)); probe.engine.start();
    expect((await terminal(probe.engine, probe.job.id)).status).toBe('completed');
    const input = Number(persistedJob(probe.store, probe.job.id).payload.lastRequestInputEstimate);
    const legacyConfig = { ...settings(fixture.baseUrl), taskTokenLimit: 100000 } as Settings;
    const ctx = queuedExtraction(legacyConfig);
    const used = 100000 - input - 2480; seedUsage(ctx.store, ctx.job.id, used);
    expect(100000 - used - input).toBe(2480);
    ctx.engine.start();
    expect((await terminal(ctx.engine, ctx.job.id)).status).toBe('completed');
    expect(persistedJob(ctx.store, ctx.job.id).payload.lastRequestInputEstimate).toBe(input);
    expect(fixture.calls[1].body.generationConfig.maxOutputTokens).toBe(64000);
    const output = ctx.store.outputs.get(ctx.engine.listOutputs(ctx.job.id)[0].id)!;
    expect(JSON.parse(output.request!.body).generationConfig.maxOutputTokens).toBe(64000);
  });

  it('continues every extraction block beyond historical 100000 and 512000 totals while estimating missing usage', async () => {
    const fixture = await upstream(() => gemini(extraction, 'STOP', false));
    const ctx = queuedExtraction(settings(fixture.baseUrl), ['甲'.repeat(5000), '乙'.repeat(5000), '丙'.repeat(5000)].join('\n'));
    seedUsage(ctx.store, ctx.job.id, 400000, 300000); ctx.engine.start();
    const done = await terminal(ctx.engine, ctx.job.id);
    expect(done.status).toBe('completed'); expect(done.usageEstimated).toBe(true);
    expect(done.inputTokens).toBeGreaterThan(400000); expect(done.outputTokens).toBeGreaterThan(300000);
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.calls.map(call => call.body.generationConfig.maxOutputTokens)).toEqual([64000, 64000, 64000]);
    expect(ctx.store.state(ctx.branchId).chapters[0].status).toBe('ready');
    expect(persistedJob(ctx.store, ctx.job.id).payload.blockIndex).toBe(3);
  });

  it('rejects actual single-request context overflow before any HTTP call or output record instead of reducing output', async () => {
    const fixture = await upstream(() => gemini());
    const ctx = queuedExtraction(settings(fixture.baseUrl, 64000)); seedUsage(ctx.store, ctx.job.id, 700000);
    const revision = ctx.store.getBranch(ctx.branchId).revisionId; ctx.engine.start();
    const done = await terminal(ctx.engine, ctx.job.id);
    expect(done.status).toBe('failed'); expect(done.error).toContain('上下文');
    expect(fixture.calls).toEqual([]); expect(ctx.engine.listOutputs(ctx.job.id)).toEqual([]);
    expect(done.inputTokens).toBe(700000); expect(done.outputTokens).toBe(0); expect(done.progress).toBe(0);
    expect(ctx.store.getBranch(ctx.branchId).revisionId).toBe(revision);
    expect(ctx.store.state(ctx.branchId).chapters[0].status).toBe('pending');
  });

  it('allows the exact input-estimate plus 64000 output boundary regardless of previous job usage', async () => {
    const fixture = await upstream(() => gemini());
    const probe = queuedExtraction(settings(fixture.baseUrl)); probe.engine.start();
    expect((await terminal(probe.engine, probe.job.id)).status).toBe('completed');
    const input = Number(persistedJob(probe.store, probe.job.id).payload.lastRequestInputEstimate);
    const config = settings(fixture.baseUrl, input + 64000);
    const ctx = queuedExtraction(config); seedUsage(ctx.store, ctx.job.id, 800000);
    ctx.engine.start();
    expect((await terminal(ctx.engine, ctx.job.id)).status).toBe('completed');
    expect(fixture.calls).toHaveLength(2); expect(persistedJob(ctx.store, ctx.job.id).payload.lastRequestInputEstimate).toBe(input);
    expect(fixture.calls[1].body.generationConfig.maxOutputTokens).toBe(64000);
    expect(input + fixture.calls[1].body.generationConfig.maxOutputTokens).toBe(config.modelParameters!.find(profile => profile.model === 'extractor')!.contextTokens);
  });

  it('preserves a previous truncated response during failed context preflight and retries only extraction after context increases', async () => {
    let extractionCalls = 0;
    const fixture = await upstream(path => path.includes('/writer:') ? gemini('旅人来到灯塔。') : ++extractionCalls === 1 ? gemini('{"summary":"未完成', 'MAX_TOKENS') : gemini());
    const config = settings(fixture.baseUrl); const ctx = harness(config);
    const project = ctx.store.createProject({ title: '重试不覆盖诊断' }); const branch = ctx.store.getBranch(project.mainBranchId);
    const outlined = ctx.store.updateOutline(branch.id, branch.revisionId, { coarse: '旅人寻找灯塔', locked: '', fine: [1, 2, 3, 4].map(chapter => ({ chapter, title: `第 ${chapter} 章`, goal: '寻找线索' })) });
    const job = ctx.engine.enqueue(branch.id, 'generate', { baseRevisionId: outlined.branch.revisionId, mode: 'original', instruction: '写开场' }); ctx.engine.start();
    expect((await terminal(ctx.engine, job.id)).status).toBe('failed');
    expect(fixture.calls).toHaveLength(2);
    const output = ctx.engine.listOutputs(job.id).find(value => value.stage === 'extraction')!;
    const oldOutput = structuredClone(ctx.store.outputs.get(output.id)!);
    expect(oldOutput.status).toBe('invalid'); expect(oldOutput.incomplete).toBe(true); expect(oldOutput.issues.length).toBeGreaterThan(0);
    const chapterId = ctx.store.state(branch.id).chapters[0].id;
    const extractionParameters = config.modelParameters!.find(profile => profile.model === 'extractor')!;
    extractionParameters.contextTokens = 64000; ctx.engine.action(job.id, 'retry');
    const preflightFailed = await terminal(ctx.engine, job.id);
    expect(preflightFailed.status).toBe('failed'); expect(preflightFailed.error).toContain('上下文');
    expect(fixture.calls).toHaveLength(2); expect(ctx.store.outputs.get(output.id)).toEqual(oldOutput);
    expect(ctx.engine.listOutputs(job.id)).toHaveLength(2);
    expect(ctx.store.state(branch.id).chapters[0]).toMatchObject({ id: chapterId, status: 'pending' });
    extractionParameters.contextTokens = 512000; ctx.engine.action(job.id, 'retry');
    expect((await terminal(ctx.engine, job.id)).status).toBe('completed');
    expect(fixture.calls).toHaveLength(3); expect(fixture.calls.filter(call => call.path.includes('/writer:'))).toHaveLength(1);
    expect(fixture.calls[2].path).toContain('/extractor:'); expect(fixture.calls[2].body.generationConfig.maxOutputTokens).toBe(64000);
    expect(ctx.store.outputs.get(output.id)).toEqual(oldOutput);
    expect(ctx.store.state(branch.id).chapters).toHaveLength(1); expect(ctx.store.state(branch.id).chapters[0]).toMatchObject({ id: chapterId, status: 'ready' });
    expect(ctx.store.exportText(branch.id)).toContain('旅人来到灯塔。');
  });

  it('uses each assigned model profile for output and context limits on the same connection', async () => {
    const fixture = await upstream(path => path.includes('/writer:') ? gemini('旅人来到灯塔。') : gemini());
    const config = settings(fixture.baseUrl);
    config.modelParameters!.find(profile => profile.model === 'writer')!.maxOutputTokens = 2048;
    const ctx = harness(config);
    const project = ctx.store.createProject({ title: '模型参数隔离' }); const branch = ctx.store.getBranch(project.mainBranchId);
    const outlined = ctx.store.updateOutline(branch.id, branch.revisionId, { coarse: '旅人寻找灯塔', locked: '', fine: [1, 2, 3, 4].map(chapter => ({ chapter, title: `第 ${chapter} 章`, goal: '寻找线索' })) });
    const job = ctx.engine.enqueue(branch.id, 'generate', { baseRevisionId: outlined.branch.revisionId, mode: 'original', instruction: '写开场' }); ctx.engine.start();
    expect((await terminal(ctx.engine, job.id)).status).toBe('completed');
    expect(fixture.calls.map(call => [call.path.split('/').at(-1), call.body.generationConfig.maxOutputTokens])).toEqual([
      ['writer:generateContent', 2048], ['extractor:generateContent', 64000],
    ]);
  });

  it('migrates legacy connection parameters when the engine receives settings directly', async () => {
    const fixture = await upstream(() => gemini());
    const config: Settings = {
      providers: [{ id: 'local', name: '旧版连接', protocol: 'gemini', baseUrl: fixture.baseUrl, model: 'extractor', maxOutputTokens: 64000, contextTokens: 512000 }],
      writingProviderId: 'local', planningProviderId: 'local', extractionProviderId: 'local',
    };
    const ctx = queuedExtraction(config); ctx.engine.start();
    expect((await terminal(ctx.engine, ctx.job.id)).status).toBe('completed');
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].path).toContain('/extractor:');
    expect(fixture.calls[0].body.generationConfig.maxOutputTokens).toBe(64000);
  });

  it('uses independent task limits when planning, writing and extraction share the same connection and model', async () => {
    const planning = JSON.stringify({ coarse: '旅人寻找灯塔', fine: [1, 2, 3, 4].map(chapter => ({ chapter, title: `第 ${chapter} 章`, goal: '寻找线索' })), foreshadows: [] });
    const fixture = await upstream((_path, _body, index) => gemini(index === 0 ? planning : index === 1 ? '旅人来到灯塔。' : extraction));
    const config = settings(fixture.baseUrl);
    config.writingModel = config.planningModel = config.extractionModel = 'shared-model';
    config.modelParameters = [
      { role: 'planning', providerId: 'local', model: 'shared-model', maxOutputTokens: 8192, contextTokens: 64000 },
      { role: 'writing', providerId: 'local', model: 'shared-model', maxOutputTokens: 2048, contextTokens: 32000 },
      { role: 'extraction', providerId: 'local', model: 'shared-model', maxOutputTokens: 64000, contextTokens: 512000 },
    ];
    const ctx = harness(config);
    const project = ctx.store.createProject({ title: '同模型任务参数隔离' }); const branch = ctx.store.getBranch(project.mainBranchId);
    const job = ctx.engine.enqueue(branch.id, 'generate', { baseRevisionId: branch.revisionId, mode: 'original', instruction: '写开场' }); ctx.engine.start();
    expect((await terminal(ctx.engine, job.id)).status).toBe('completed');
    expect(fixture.calls.map(call => call.path.split('/').at(-1))).toEqual(['shared-model:generateContent', 'shared-model:generateContent', 'shared-model:generateContent']);
    expect(fixture.calls.map(call => call.body.generationConfig.maxOutputTokens)).toEqual([8192, 2048, 64000]);
    const capturedLimits = Object.fromEntries(ctx.engine.listOutputs(job.id).map(output => [output.stage, JSON.parse(ctx.store.outputs.get(output.id)!.request!.body).generationConfig.maxOutputTokens]));
    expect(capturedLimits).toEqual({ planning: 8192, writing: 2048, extraction: 64000 });
  });
});
