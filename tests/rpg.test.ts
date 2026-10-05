import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { generateText } from '../server/providers.js';
import { buildApp } from '../server/app.js';
import { defaultPromptTemplates, validatePromptTemplates } from '../shared/prompt-templates.js';
import type { Entity, ExtractionResult, Job, Settings } from '../shared/types.js';

const stores: Store[] = [], engines: StoryEngine[] = [], servers: Server[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const app of apps.splice(0)) await app.app.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const store of stores.splice(0)) store.close();
});
const extraction = (): ExtractionResult => ({ summary: '已完成本段体验', entities: [], relations: [], foreshadows: [] });
function makeStore() { const store = new Store(mkdtempSync(join(tmpdir(), 'ai-novel-rpg-'))); stores.push(store); return store; }
const options = [{ id: 'bridge', label: '前往桥头' }, { id: 'inn', label: '留在客栈', description: '向店主询问附近的情况' }];
function response(response: ServerResponse, text: string, calls?: { id: string; name: string; args: unknown }[]) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content: text, ...(calls ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
}
async function upstream(reply?: (body: any, response_: ServerResponse, index: number) => void) {
  const bodies: any[] = [];
  const server = createServer(async (request, response_) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    if (reply) reply(body, response_, bodies.length - 1);
    else if (bodies.length === 1) response(response_, '你站在岔路口。', [{ id: 'decision-1', name: 'ask_user', args: { question: '接下来去哪里？', options } }]);
    else response(response_, '你依照自己的决定走向桥头。');
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { bodies, url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1` };
}
const settings = (url: string): Settings => ({ providers: [{ id: 'local', name: '本地协议模拟', protocol: 'openai-chat', baseUrl: url, model: 'writer', maxOutputTokens: 1000, contextTokens: 64000 }], writingProviderId: 'local', planningProviderId: 'local', extractionProviderId: 'local' });
function engineFor(store: Store, config: Settings) {
  const models: TextModels = { generateText, generateStructured: vi.fn(async (_config, _request, validate) => ({ value: validate(extraction()), inputTokens: 1, outputTokens: 1 })) as TextModels['generateStructured'] };
  const engine = new StoryEngine(store, () => config, models); engines.push(engine); engine.start(); return engine;
}
async function until<T>(read: () => T, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) { const value = read(); if (accepts(value)) return value; if (Date.now() > deadline) throw new Error(`等待 RPG 状态超时：${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const rawJob = (store: Store, jobId: string): Job => JSON.parse(String(store.db.prepare('SELECT data FROM jobs WHERE id=?').get(jobId)!.data));
const job = (engine: StoryEngine, id: string) => engine.listJobs().find(job_ => job_.id === id)!;
const paused = (engine: StoryEngine, id: string) => until(() => job(engine, id), job_ => job_.status === 'paused' && Boolean(job_.pendingChoice));
const completed = (engine: StoryEngine, id: string) => until(() => job(engine, id), job_ => ['completed', 'failed', 'stale'].includes(job_.status));
function append(store: Store, branchId: string, title: string) {
  const view = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title, text: title });
  return store.applyExtraction(branchId, view.branch.revisionId, view.state.chapters.at(-1)!.id, extraction(), true);
}
function originalSetup() { return { character: { kind: 'original' as const, name: '顾舟', description: '用户确认的旅人' }, entryInstruction: '从客栈进入故事' }; }

describe('durable RPG story choices', () => {
  it('forks at the selected boundary and resolves existing characters there without modifying canon', () => {
    const store = makeStore(), project = store.createProject({ title: '原作' });
    const character: Entity = { id: '', name: '林舟', kind: 'character', aliases: [], description: '仍然活着的旅人', locked: true, visibility: 'public', facts: [] };
    const authored = store.updateEntity(project.mainBranchId, store.getBranch(project.mainBranchId).revisionId, character);
    const entity = authored.state.entities[0]; const first = append(store, project.mainBranchId, '第一章');
    const second = append(store, project.mainBranchId, '第二章'); store.updateEntity(project.mainBranchId, second.branch.revisionId, { ...entity, description: '已经死亡' });
    const canon = store.view(project.mainBranchId, true);
    const fork = store.startRpgFork(project.mainBranchId, canon.branch.revisionId, { character: { kind: 'existing', entityId: entity.id, name: '冒用名称', description: '冒用设定' }, entryChapterId: first.state.chapters[0].id });
    expect(fork.branch.id).not.toBe(project.mainBranchId); expect(fork.state.chapters).toHaveLength(1);
    expect(fork.state.rpg?.character).toEqual({ kind: 'existing', entityId: entity.id, name: '林舟', description: '仍然活着的旅人' });
    expect(store.view(project.mainBranchId, true)).toEqual(canon);
    expect(store.view(fork.branch.id, false).state.rpg).toBeUndefined();
    expect(() => store.startRpgFork(project.mainBranchId, canon.branch.revisionId, { character: { kind: 'existing', entityId: 'missing', name: '', description: '' }, entryChapterId: first.state.chapters[0].id })).toThrow('起始版本');
  });

  it('preserves the complete existing role name and dossier through RPG backup restoration', () => {
    const store = makeStore(), project = store.createProject({ title: '长角色档案' });
    const description = '完整角色档案'.repeat(6000); const name = '名'.repeat(300);
    const view = store.updateEntity(project.mainBranchId, store.getBranch(project.mainBranchId).revisionId, { id: '', name, kind: 'character', aliases: [], description, locked: true, visibility: 'public', facts: [] });
    const fork = store.startRpgFork(project.mainBranchId, view.branch.revisionId, { character: { kind: 'existing', entityId: view.state.entities[0].id, name, description: '' } });
    expect(fork.state.rpg?.character).toMatchObject({ name, description });
    const restored = store.restoreProject(store.exportProject(project.id)); const rpgBranch = store.listBranches(restored.id).find(branch => branch.id !== restored.mainBranchId)!;
    expect(store.state(rpgBranch.id).rpg?.character).toMatchObject({ name, description });
    expect(store.state(rpgBranch.id).rpg?.character.entityId).toBe(store.state(rpgBranch.id).entities[0].id);
  });

  it('persists waiting choices across restart, resumes custom answers once, and accounts tokens once', async () => {
    const service = await upstream(), store = makeStore(), config = settings(service.url); const engine = engineFor(store, config);
    const project = store.createProject({ title: '小说穿越' }); const canonRevision = store.getBranch(project.mainBranchId).revisionId;
    const queued = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: canonRevision, mode: 'rpg', instruction: '体验小说', rpg: originalSetup() });
    const waiting = await paused(engine, queued.id);
    expect(service.bodies).toHaveLength(1); expect(waiting).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(engine.writingSnapshot(waiting.id).text).toBe('你站在岔路口。');
    expect(engine.listWritingActivities(waiting.id).find(activity => activity.name === 'ask_user')?.status).toBe('running');
    expect(() => engine.action(waiting.id, 'resume')).toThrow('请先选择');
    expect(engine.outputDetail(waiting.id, engine.listOutputs(waiting.id)[0].id).canApply).toBe(false);
    await engine.close(); const restarted = engineFor(store, config);
    expect(job(restarted, waiting.id).pendingChoice).toEqual(waiting.pendingChoice);
    expect(() => restarted.choose(waiting.id, { choiceId: waiting.pendingChoice!.id, optionId: 'bridge', customText: '自己走' })).toThrow('请选择一个');
    expect(() => restarted.choose(waiting.id, { choiceId: waiting.pendingChoice!.id, optionId: 'unknown' })).toThrow('不存在');
    restarted.choose(waiting.id, { choiceId: waiting.pendingChoice!.id, customText: '我先观察街上的行人' });
    expect(() => restarted.choose(waiting.id, { choiceId: waiting.pendingChoice!.id, optionId: 'bridge' })).toThrow('已失效');
    expect((await completed(restarted, waiting.id)).status).toBe('completed');
    expect(service.bodies).toHaveLength(2); expect(JSON.stringify(service.bodies[1])).toContain('我先观察街上的行人');
    expect(store.exportText(waiting.branchId)).toContain('你站在岔路口。你依照自己的决定走向桥头。');
    expect(job(restarted, waiting.id)).toMatchObject({ inputTokens: 20, outputTokens: 10, pendingChoice: undefined });
    expect(store.state(project.mainBranchId).chapters).toHaveLength(0); expect(store.getBranch(project.mainBranchId).revisionId).toBe(canonRevision);
  });

  it('uses saved prompts for a waiting dialogue and compiles changed presets only when a new chapter starts', async () => {
    const service = await upstream(), store = makeStore(), config = settings(service.url), engine = engineFor(store, config), project = store.createProject({ title: '提示词续接' });
    const queued = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'rpg', instruction: '保留初始对话', rpg: originalSetup() });
    const waiting = await paused(engine, queued.id);
    const templates = defaultPromptTemplates(); const preset = templates.presets.writing[0];
    preset.blocks = [...preset.blocks.filter(block => block.role === 'system'), { id: 'empty-after-expansion', name: '只写选段', role: 'user', enabled: true, content: '{{sourceText}}' }];
    config.promptTemplates = validatePromptTemplates(templates);
    engine.choose(queued.id, { choiceId: waiting.pendingChoice!.id, optionId: 'bridge' });
    expect((await completed(engine, queued.id)).status).toBe('completed'); expect(service.bodies).toHaveLength(2);
    expect(service.bodies[1].messages.slice(0, service.bodies[0].messages.length)).toEqual(service.bodies[0].messages);
    await until(() => store.state(queued.branchId).chapters, chapters => chapters.length === 1 && chapters[0].status === 'ready');
    const next = engine.enqueue(queued.branchId, 'generate', { baseRevisionId: store.getBranch(queued.branchId).revisionId, mode: 'rpg', instruction: '下一章使用新预设' });
    const failed = await completed(engine, next.id); expect(failed.status).toBe('failed'); expect(failed.error).toContain('变量展开后没有非空 user');
    expect(service.bodies).toHaveLength(2);
  });

  it('rejects answers after settings, version or cancellation changes while preserving the waiting node', async () => {
    const service = await upstream(), store = makeStore(), config = settings(service.url), engine = engineFor(store, config);
    const project = store.createProject({ title: '选择隔离' });
    const queued = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'rpg', instruction: '', rpg: originalSetup() });
    const waiting = await paused(engine, queued.id); const choiceId = waiting.pendingChoice!.id;
    config.writingModel = 'different';
    expect(() => engine.choose(waiting.id, { choiceId, optionId: 'bridge' })).toThrow('原供应商');
    expect(job(engine, waiting.id).pendingChoice?.id).toBe(choiceId); expect(rawJob(store, waiting.id).payload.rpgChoiceAnswer).toBeUndefined();
    config.writingModel = 'writer';
    store.updateOutline(waiting.branchId, waiting.baseRevisionId, { locked: '新设定', fine: [] });
    expect(() => engine.choose(waiting.id, { choiceId, optionId: 'bridge' })).toThrow('新版本');
    engine.action(waiting.id, 'cancel'); expect(() => engine.choose(waiting.id, { choiceId, optionId: 'bridge' })).toThrow('已失效');
    expect(service.bodies).toHaveLength(1);
  });

  it('restores independent waiting jobs with opaque protocol history and aliases old retrieval IDs', async () => {
    let oldEntityId = '';
    const service = await upstream((_body, reply, index) => {
      if (index === 0) response(reply, '你看见林舟。', [{ id: 'pick', name: 'ask_user', args: { question: '如何回应？', options } }]);
      else if (index === 1) response(reply, '', [{ id: 'lookup', name: 'read_entity', args: { id: oldEntityId } }]);
      else response(reply, '林舟继续讲述城中的情况。');
    });
    const store = makeStore(), config = settings(service.url), engine = engineFor(store, config), project = store.createProject({ title: '备份体验' });
    const view = store.updateEntity(project.mainBranchId, store.getBranch(project.mainBranchId).revisionId, { id: '', kind: 'character', name: '林舟', aliases: [], description: '旅人', visibility: 'public', locked: true, facts: [] });
    oldEntityId = view.state.entities[0].id;
    const queued = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: view.branch.revisionId, mode: 'rpg', instruction: '', rpg: { character: { kind: 'existing', entityId: oldEntityId, name: '', description: '' } } });
    const waiting = await paused(engine, queued.id); await engine.close();
    const restored = store.restoreProject(store.exportProject(project.id)); const replacement = engineFor(store, config);
    const copy = replacement.listJobs(restored.id).find(job_ => job_.kind === 'generate')!;
    expect(copy.id).not.toBe(waiting.id); expect(copy.branchId).not.toBe(waiting.branchId);
    expect(rawJob(store, copy.id).payload.rpgContinuation).toEqual(rawJob(store, waiting.id).payload.rpgContinuation);
    expect(store.state(copy.branchId).rpg?.character.entityId).not.toBe(oldEntityId);
    replacement.choose(copy.id, { choiceId: copy.pendingChoice!.id, optionId: 'bridge' });
    expect((await completed(replacement, copy.id)).status).toBe('completed'); expect(service.bodies).toHaveLength(3);
    expect(JSON.stringify(service.bodies[2].messages.at(-1))).toContain('林舟'); expect(JSON.stringify(service.bodies[2].messages.at(-1))).not.toContain('没有此资料');
    expect(job(replacement, waiting.id).status).toBe('paused'); expect(store.state(waiting.branchId).chapters).toHaveLength(0);
  });

  it('retains prose but fails a model that never asks the player for a choice', async () => {
    const service = await upstream((_body, reply) => response(reply, '模型替玩家决定了一切。'));
    const store = makeStore(), engine = engineFor(store, settings(service.url)), project = store.createProject({ title: '必须互动' });
    const queued = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'rpg', instruction: '', rpg: originalSetup() });
    expect((await completed(engine, queued.id)).status).toBe('failed'); expect(store.state(queued.branchId).chapters).toHaveLength(0);
    expect(engine.writingSnapshot(queued.id).text).toBe('模型替玩家决定了一切。');
    expect(engine.outputDetail(queued.id, engine.listOutputs(queued.id)[0].id).output.issues[0].message).toContain('没有询问玩家');
  });

  it('waits separately for two choices even when a gateway repeats tool call IDs', async () => {
    const service = await upstream((_body, reply, index) => {
      if (!index) response(reply, '店主和守卫都在等你回答。', [
        { id: 'repeated-id', name: 'ask_user', args: { question: '如何回答店主？', options } },
        { id: 'repeated-id', name: 'ask_user', args: { question: '如何回答守卫？', options } },
      ]);
      else response(reply, '两人分别回应了你的选择。');
    });
    const store = makeStore(), engine = engineFor(store, settings(service.url)), project = store.createProject({ title: '独立节点' });
    const queued = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'rpg', instruction: '', rpg: originalSetup() });
    const first = await paused(engine, queued.id); engine.choose(queued.id, { choiceId: first.pendingChoice!.id, optionId: 'bridge' });
    const second = await until(() => job(engine, queued.id), value => value.status === 'paused' && Boolean(value.pendingChoice) && value.pendingChoice!.id !== first.pendingChoice!.id);
    expect(second.pendingChoice?.question).toBe('如何回答守卫？'); expect(service.bodies).toHaveLength(1);
    engine.choose(queued.id, { choiceId: second.pendingChoice!.id, customText: '我向守卫解释来意' });
    expect((await completed(engine, queued.id)).status).toBe('completed'); expect(service.bodies).toHaveLength(2);
    expect(service.bodies[1].messages.at(-2).content).toContain('前往桥头'); expect(service.bodies[1].messages.at(-1).content).toContain('我向守卫解释来意');
    expect(job(engine, queued.id)).toMatchObject({ inputTokens: 20, outputTokens: 10 });
  });

  it('requires an explicit retry after a failed continuation and preserves each attempt charge without duplicating partial prose', async () => {
    const service = await upstream((_body, reply, index) => {
      if (!index) response(reply, '你站在岔路口。', [{ id: 'decide', name: 'ask_user', args: { question: '去哪里？', options } }]);
      else if (index === 1) {
        reply.writeHead(200, { 'Content-Type': 'text/event-stream' });
        reply.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '失败请求的半句话。' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 8, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`);
      } else response(reply, '你走到桥头。');
    });
    const store = makeStore(), engine = engineFor(store, settings(service.url)), project = store.createProject({ title: '显式重试' });
    const queued = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'rpg', instruction: '', rpg: originalSetup() });
    const waiting = await paused(engine, queued.id); engine.choose(queued.id, { choiceId: waiting.pendingChoice!.id, optionId: 'bridge' });
    expect((await completed(engine, queued.id)).status).toBe('failed'); expect(service.bodies).toHaveLength(2);
    expect(job(engine, queued.id)).toMatchObject({ inputTokens: 18, outputTokens: 9 });
    expect(engine.writingSnapshot(queued.id).text).toContain('失败请求的半句话');
    engine.action(queued.id, 'retry'); expect((await completed(engine, queued.id)).status).toBe('completed');
    expect(service.bodies).toHaveLength(3); expect(job(engine, queued.id)).toMatchObject({ inputTokens: 28, outputTokens: 14 });
    expect(store.exportText(queued.branchId)).toContain('你站在岔路口。你走到桥头。'); expect(store.exportText(queued.branchId)).not.toContain('失败请求的半句话');
    expect(engine.listOutputs(queued.id).some(output => engine.outputDetail(queued.id, output.id).output.normalizedText?.includes('失败请求的半句话'))).toBe(true);
  });

  it('estimates omitted usage on each round and exposes the estimate flag after waiting and completion', async () => {
    const service = await upstream((_body, reply, index) => {
      reply.writeHead(200, { 'Content-Type': 'application/json' });
      reply.end(JSON.stringify({ choices: [{ message: index ? { content: '你走向桥头。' } : { content: '你站在街边。', tool_calls: [{ id: 'decision', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '去哪里？', options }) } }] }, finish_reason: index ? 'stop' : 'tool_calls' }] }));
    });
    const store = makeStore(), engine = engineFor(store, settings(service.url)), project = store.createProject({ title: '用量估算' });
    const queued = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'rpg', instruction: '', rpg: originalSetup() });
    const waiting = await paused(engine, queued.id); expect(waiting.usageEstimated).toBe(true); expect(waiting.inputTokens).toBeGreaterThan(0); expect(waiting.outputTokens).toBeGreaterThan(0);
    engine.choose(queued.id, { choiceId: waiting.pendingChoice!.id, optionId: 'bridge' });
    const finished = await completed(engine, queued.id); expect(finished.status).toBe('completed'); expect(finished.usageEstimated).toBe(true);
    expect(finished.inputTokens).toBeGreaterThan(waiting.inputTokens); expect(finished.outputTokens).toBeGreaterThan(waiting.outputTokens);
  });

  it('requires author view for RPG generation and choices, and omits role setup and choices from reader JSON', async () => {
    const ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'ai-novel-rpg-api-')), startEngine: false }); apps.push(ctx);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'story-password-123' } }); const session = login.cookies.find(cookie => cookie.name === 'session')!.value;
    const project = ctx.store.createProject({ title: '权限体验' }); const payload = { baseRevisionId: ctx.store.getBranch(project.mainBranchId).revisionId, mode: 'rpg', instruction: '', rpg: originalSetup() };
    expect((await ctx.app.inject({ method: 'POST', url: `/api/branches/${project.mainBranchId}/generate`, cookies: { session }, payload })).statusCode).toBe(403);
    const generate = await ctx.app.inject({ method: 'POST', url: `/api/branches/${project.mainBranchId}/generate?view=author`, cookies: { session }, payload }); expect(generate.statusCode).toBe(200);
    const queued = generate.json<Job>(); const internal = rawJob(ctx.store, queued.id); internal.status = 'paused'; internal.payload.rpgChoice = { id: 'choice', question: '作者选择内容', options };
    ctx.store.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run('paused', JSON.stringify(internal), internal.id);
    const reader = await ctx.app.inject({ url: `/api/jobs?projectId=${project.id}`, cookies: { session } }); expect(reader.body).not.toContain('作者选择内容');
    const role = await ctx.app.inject({ url: `/api/branches/${queued.branchId}`, cookies: { session } }); expect(role.body).not.toContain('用户确认的旅人'); expect(role.body).not.toContain('从客栈进入故事');
    expect((await ctx.app.inject({ method: 'POST', url: `/api/jobs/${queued.id}/choice`, cookies: { session }, payload: { choiceId: 'choice', optionId: 'bridge' } })).statusCode).toBe(403);
  });
});
