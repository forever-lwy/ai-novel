import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { listenLocalServer } from './local-server.mjs';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { generateText } from '../server/providers.js';
import { buildApp } from '../server/app.js';
import { defaultPromptTemplates } from '../shared/prompt-templates.js';
import { withDramatronPresets } from './fixtures/prompt-presets.js';
import type { ExtractionResult, Job, ModelRequest, ProviderConfig, RpgChapterChoice, Settings } from '../shared/types.js';

const stores: Store[] = [], engines: StoryEngine[] = [], servers: Server[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const app of apps.splice(0)) await app.app.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const store of stores.splice(0)) store.close();
});
const options = [{ id: 'bridge', label: '前往桥头' }, { id: 'inn', label: '留在客栈', description: '向店主询问附近情况' }];
const extracted = (): ExtractionResult => ({ summary: '本章体验已整理', entities: [], relations: [], foreshadows: [] });
const setup = () => ({ character: { kind: 'original' as const, name: '顾舟', description: '用户确认的旅人' }, entryInstruction: '从客栈进入故事' });
function makeStore() { const store = new Store(mkdtempSync(join(tmpdir(), 'ai-novel-rpg-chapters-'))); stores.push(store); return store; }
function respond(reply: ServerResponse, text: string, calls?: { id: string; name: string; args: unknown }[]) {
  reply.writeHead(200, { 'Content-Type': 'application/json' });
  reply.end(JSON.stringify({ choices: [{ message: { content: text, ...(calls ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
}
const ask = (question = '章末仍待决定的行动') => [{ id: 'decision', name: 'ask_user', args: { question, options } }];
async function upstream(reply: (body: any, response: ServerResponse, index: number) => void) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); reply(body, response, bodies.length - 1);
  });
  servers.push(server); await listenLocalServer(server);
  return { bodies, url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1` };
}
const settings = (url: string, archive = false): Settings => ({ promptTemplates: archive ? defaultPromptTemplates() : withDramatronPresets(), providers: [{ id: 'local', name: '本地协议模拟', protocol: 'openai-chat', baseUrl: url, model: 'writer', maxOutputTokens: 1000, contextTokens: 64000 }], writingProviderId: 'local', planningProviderId: 'local', extractionProviderId: 'local', taskSettings: { extraction: { autoRetry: false, maxRetries: 0, retryDelayMs: 0 }, planning: { enabled: false, mode: 'separate' } } });
function engineFor(store: Store, config: Settings, start = true, extraction: () => ExtractionResult = extracted) {
  const requests: { budget?: ModelRequest['chapterBudget']; continuationRound?: number; continuationText?: string }[] = [];
  const models: TextModels = {
    generateText: vi.fn(async (provider: ProviderConfig, request: ModelRequest) => {
      requests.push({ budget: request.chapterBudget && { ...request.chapterBudget }, continuationRound: request.continuation?.round, continuationText: request.continuation?.text });
      return generateText(provider, request);
    }),
    generateStructured: vi.fn(async (_provider, request, validate) => ({ value: validate(request.system.includes('# 章节自动命名') ? { title: '桥头之行' } : extraction()), inputTokens: 1, outputTokens: 1 })) as TextModels['generateStructured'],
  };
  const engine = new StoryEngine(store, () => config, models); engines.push(engine); if (start) engine.start(); return { engine, models, requests };
}
async function until<T>(read: () => T, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 6000;
  for (;;) { const value = read(); if (accepts(value)) return value; if (Date.now() > deadline) throw new Error(`等待章节状态超时：${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const job = (engine: StoryEngine, id: string) => engine.listJobs().find(value => value.id === id)!;
const rawJob = (store: Store, id: string): Job => JSON.parse(String(store.db.prepare('SELECT data FROM jobs WHERE id=?').get(id)!.data));
const finished = (engine: StoryEngine, id: string) => until(() => job(engine, id), value => ['completed', 'failed', 'stale'].includes(value.status));
const waiting = (engine: StoryEngine, id: string) => until(() => job(engine, id), value => value.status === 'paused' && Boolean(value.pendingChoice));
const ready = (store: Store, engine: StoryEngine, branchId: string, count = 1) => until(() => store.state(branchId), state => state.chapters.length === count && state.chapters.every(chapter => chapter.status === 'ready') && !engine.listJobs().some(value => value.branchId === branchId && ['queued', 'running', 'paused'].includes(value.status)));
function start(store: Store, engine: StoryEngine, maxWords = 100) {
  const project = store.createProject({ title: '独立章节预算测试' });
  const queued = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'rpg', instruction: '按整章预算推进', maxWords, rpg: setup() });
  return { project, queued };
}
function answer(store: Store, engine: StoryEngine, choice: RpgChapterChoice, extra: { branchId?: string; optionId?: string; customText?: string } = { optionId: 'bridge' }) {
  const branchId = extra.branchId ?? job(engine, choice.jobId).branchId;
  return engine.choose(choice.jobId, { choiceId: choice.id, baseRevisionId: store.getBranch(branchId).revisionId, ...extra });
}

describe('RPG chapter budgets and durable chapter-boundary choices', () => {
  it('counts prose across choices, saves the whole final round, and retains its unanswered choice without another model request', async () => {
    const first = '客'.repeat(60), last = '桥'.repeat(70);
    const service = await upstream((_body, reply, index) => respond(reply, index ? last : first, ask(index ? '第二个未回答节点' : '第一个节点')));
    const store = makeStore(), ctx = engineFor(store, settings(service.url)); const { queued } = start(store, ctx.engine);
    const paused = await waiting(ctx.engine, queued.id); expect(store.state(queued.branchId).chapters).toHaveLength(0);
    expect(service.bodies).toHaveLength(1); expect(ctx.requests[0].budget).toEqual({ targetWords: 100 });
    expect(ctx.engine.choose(queued.id, { choiceId: paused.pendingChoice!.id, optionId: 'bridge' }).id).toBe(queued.id);
    expect((await finished(ctx.engine, queued.id)).status).toBe('completed'); const state = await ready(store, ctx.engine, queued.branchId);
    expect(service.bodies).toHaveLength(2); expect(store.chapter(queued.branchId, state.chapters[0].id).text).toBe(first + last);
    expect(state.rpg?.nextChoice).toMatchObject({ question: '第二个未回答节点', jobId: queued.id, chapterId: state.chapters[0].id, maxWords: 100, instruction: '按整章预算推进', options });
    expect(job(ctx.engine, queued.id)).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expect(ctx.engine.writingSnapshot(queued.id).text).toBe(first + last);
    expect(store.view(queued.branchId, true).state.rpg?.nextChoice).toEqual(state.rpg?.nextChoice);
    expect(() => ctx.engine.enqueue(queued.branchId, 'generate', { baseRevisionId: store.getBranch(queued.branchId).revisionId, mode: 'rpg', instruction: '直接生成不能跳过未决行动' })).toThrow('章末选择');
    expect(() => ctx.engine.action(queued.id, 'resume')).toThrow(); expect(service.bodies).toHaveLength(2);
  });

  it.each([false, true])('persists a sealed choice and accepted next-chapter action through engine restarts, archive=%s', async archive => {
    const oldText = '旧'.repeat(120), nextText = '你按自己的选择先观察周围。';
    const service = await upstream((_body, reply, index) => respond(reply, index ? nextText : oldText, index ? undefined : ask('你准备如何应对守卫？')));
    const store = makeStore(), config = settings(service.url, archive), first = engineFor(store, config); const { queued } = start(store, first.engine);
    expect((await finished(first.engine, queued.id)).status).toBe('completed'); const original = await ready(store, first.engine, queued.branchId);
    await first.engine.close(); const offline = engineFor(store, config, false);
    expect(store.state(queued.branchId).rpg?.nextChoice).toEqual(original.rpg?.nextChoice);
    const oldRevision = store.getBranch(queued.branchId).revisionId;
    const next = answer(store, offline.engine, original.rpg!.nextChoice!, { customText: '我先观察周围，再决定是否回答守卫' });
    expect(next.id).not.toBe(queued.id); expect(next.status).toBe('queued'); expect(next.baseRevisionId).not.toBe(oldRevision);
    expect(store.state(queued.branchId).rpg?.nextChoice).toBeUndefined();
    expect(rawJob(store, next.id).payload.rpgChapterAnswer).toMatchObject({ choiceId: original.rpg!.nextChoice!.id, question: '你准备如何应对守卫？', text: '我先观察周围，再决定是否回答守卫' });
    expect(rawJob(store, next.id).payload.rpgContinuation).toBeUndefined();
    expect(() => answer(store, offline.engine, original.rpg!.nextChoice!)).toThrow();
    expect(service.bodies).toHaveLength(1); await offline.engine.close();
    const restarted = engineFor(store, config); expect((await finished(restarted.engine, next.id)).status).toBe('completed'); const state = await ready(store, restarted.engine, queued.branchId, 2);
    expect(service.bodies).toHaveLength(2); expect(restarted.requests[0]).toEqual({ budget: { targetWords: 100 }, continuationRound: undefined, continuationText: undefined });
    expect(JSON.stringify(service.bodies[1])).toContain('你准备如何应对守卫？'); expect(JSON.stringify(service.bodies[1])).toContain('我先观察周围，再决定是否回答守卫');
    expect(service.bodies[1].messages.some((message: any) => message.tool_calls || message.tool_call_id)).toBe(false);
    expect(store.chapter(queued.branchId, state.chapters[0].id).text).toBe(oldText); expect(store.chapter(queued.branchId, state.chapters[1].id).text).toBe(nextText);
    expect(job(restarted.engine, next.id)).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('requires the current revision, isolates a forked pending choice, and blocks a competing task on that line', async () => {
    const service = await upstream((_body, reply) => respond(reply, '章'.repeat(120), ask()));
    const store = makeStore(), config = settings(service.url), ctx = engineFor(store, config); const { queued } = start(store, ctx.engine);
    await finished(ctx.engine, queued.id); const original = await ready(store, ctx.engine, queued.branchId); const choice = original.rpg!.nextChoice!;
    await ctx.engine.close(); const offline = engineFor(store, config, false); const oldRevision = store.getBranch(queued.branchId).revisionId;
    const changed = store.updateOutline(queued.branchId, oldRevision, { locked: '作者补充已确认世界设定', fine: [] });
    expect(() => offline.engine.choose(queued.id, { choiceId: choice.id, optionId: 'bridge', baseRevisionId: oldRevision })).toThrow();
    expect(store.state(queued.branchId).rpg?.nextChoice?.id).toBe(choice.id);
    const fork = store.fork(queued.branchId, { baseRevisionId: changed.branch.revisionId, name: '另一种章末行动' });
    expect(fork.state.rpg?.nextChoice?.id).toBe(choice.id);
    const next = answer(store, offline.engine, choice, { branchId: fork.branch.id, optionId: 'inn' });
    expect(next.branchId).toBe(fork.branch.id); expect(store.state(fork.branch.id).rpg?.nextChoice).toBeUndefined();
    expect(store.state(queued.branchId).rpg?.nextChoice?.id).toBe(choice.id);
    expect(() => answer(store, offline.engine, choice, { branchId: fork.branch.id, optionId: 'bridge' })).toThrow();
    expect(() => offline.engine.enqueue(fork.branch.id, 'generate', { baseRevisionId: store.getBranch(fork.branch.id).revisionId, mode: 'rpg', instruction: '' })).toThrow();
    const other = store.createProject({ title: '另一部作品' });
    expect(() => offline.engine.choose(queued.id, { choiceId: choice.id, optionId: 'bridge', branchId: other.mainBranchId, baseRevisionId: store.getBranch(other.mainBranchId).revisionId })).toThrow();
    expect(service.bodies).toHaveLength(1);
  });

  it('restores the unanswered chapter-boundary choice when prose and world state roll back together', async () => {
    const service = await upstream((_body, reply, index) => respond(reply, index ? '你依照决定到了桥头。' : '旧'.repeat(120), index ? undefined : ask()));
    const store = makeStore(), ctx = engineFor(store, settings(service.url)); const { queued } = start(store, ctx.engine);
    await finished(ctx.engine, queued.id); const original = await ready(store, ctx.engine, queued.branchId); const revision = store.getBranch(queued.branchId).revisionId;
    const next = answer(store, ctx.engine, original.rpg!.nextChoice!); expect((await finished(ctx.engine, next.id)).status).toBe('completed'); await ready(store, ctx.engine, queued.branchId, 2);
    const reverted = store.rollback(queued.branchId, { baseRevisionId: store.getBranch(queued.branchId).revisionId, revisionId: revision });
    expect(reverted.state.chapters).toHaveLength(1); expect(reverted.state.rpg?.nextChoice).toEqual(original.rpg?.nextChoice);
    await ctx.engine.close(); const offline = engineFor(store, settings(service.url), false);
    const revised = answer(store, offline.engine, reverted.state.rpg!.nextChoice!, { customText: '我改为留在客栈打听情况' });
    expect(revised.id).not.toBe(next.id); expect(rawJob(store, revised.id).payload.rpgChapterAnswer).toMatchObject({ text: '我改为留在客栈打听情况' });
    expect(service.bodies).toHaveLength(2);
  });

  it('remaps sealed choice ownership in backups and resumes only the restored story line', async () => {
    const service = await upstream((_body, reply, index) => respond(reply, index ? '你在桥头听见水声。' : '章'.repeat(120), index ? undefined : ask('备份里的未决节点')));
    const store = makeStore(), config = settings(service.url), ctx = engineFor(store, config); const { project, queued } = start(store, ctx.engine);
    await finished(ctx.engine, queued.id); const original = await ready(store, ctx.engine, queued.branchId); await ctx.engine.close();
    const restored = store.restoreProject(store.exportProject(project.id)); const offline = engineFor(store, config, false);
    const copy = offline.engine.listJobs(restored.id).find(value => value.kind === 'generate')!; const state = store.state(copy.branchId); const choice = state.rpg!.nextChoice!;
    expect(choice.jobId).toBe(copy.id); expect(choice.jobId).not.toBe(queued.id); expect(choice.chapterId).toBe(state.chapters[0].id); expect(choice.chapterId).not.toBe(original.chapters[0].id);
    const next = answer(store, offline.engine, choice); expect(next.projectId).toBe(restored.id);
    expect(store.state(queued.branchId).rpg?.nextChoice).toEqual(original.rpg?.nextChoice); expect(store.state(queued.branchId).chapters).toHaveLength(1);
    offline.engine.start(); expect((await finished(offline.engine, next.id)).status).toBe('completed'); await ready(store, offline.engine, copy.branchId, 2);
    expect(service.bodies).toHaveLength(2); expect(store.state(queued.branchId).chapters).toHaveLength(1);
  });

  it('preserves an already accepted cross-chapter action in a backup without restoring or resubmitting its old choice', async () => {
    const service = await upstream((_body, reply, index) => respond(reply, index ? '你先向店主问清道路。' : '章'.repeat(120), index ? undefined : ask()));
    const store = makeStore(), config = settings(service.url), ctx = engineFor(store, config); const { project, queued } = start(store, ctx.engine);
    await finished(ctx.engine, queued.id); const state = await ready(store, ctx.engine, queued.branchId); await ctx.engine.close();
    const offline = engineFor(store, config, false); const next = answer(store, offline.engine, state.rpg!.nextChoice!, { customText: '我先向店主问清道路' });
    const restored = store.restoreProject(store.exportProject(project.id)); const copy = offline.engine.listJobs(restored.id).find(value => value.kind === 'generate' && !value.generatedChapterId)!;
    expect(copy.id).not.toBe(next.id); expect(copy.status).toBe('paused'); expect(rawJob(store, copy.id).payload.rpgChapterAnswer).toMatchObject({ text: '我先向店主问清道路' });
    expect(store.state(copy.branchId).rpg?.nextChoice).toBeUndefined();
    expect(() => offline.engine.choose(copy.id, { choiceId: state.rpg!.nextChoice!.id, optionId: 'bridge', baseRevisionId: store.getBranch(copy.branchId).revisionId })).toThrow();
    offline.engine.action(next.id, 'pause');
    offline.engine.action(copy.id, 'resume'); offline.engine.start();
    expect((await finished(offline.engine, copy.id)).status).toBe('completed'); await ready(store, offline.engine, copy.branchId, 2);
    expect(service.bodies).toHaveLength(2); expect(JSON.stringify(service.bodies.at(-1).messages)).toContain('我先向店主问清道路');
    expect(store.state(queued.branchId).chapters).toHaveLength(1); expect(job(offline.engine, next.id).status).toBe('paused');
  });

  it('keeps the complete chapter and next choice when extraction fails, and retries only extraction before accepting the choice', async () => {
    const text = '已'.repeat(120); const service = await upstream((_body, reply) => respond(reply, text, ask('整理失败仍应保留的节点')));
    let failExtraction = true;
    const store = makeStore(), config = settings(service.url), ctx = engineFor(store, config, true, () => { if (failExtraction) throw new Error('独立模拟的资料失败'); return extracted(); });
    const { queued } = start(store, ctx.engine); expect((await finished(ctx.engine, queued.id)).status).toBe('completed');
    const background = await until(() => ctx.engine.listJobs().find(value => value.branchId === queued.branchId && value.kind === 'extract'), value => value?.status === 'failed');
    const choice = store.state(queued.branchId).rpg!.nextChoice!; expect(store.chapter(queued.branchId, choice.chapterId).text).toBe(text);
    expect(() => answer(store, ctx.engine, choice)).toThrow(); expect(store.state(queued.branchId).rpg?.nextChoice).toEqual(choice);
    failExtraction = false; ctx.engine.action(background!.id, 'retry'); await ready(store, ctx.engine, queued.branchId);
    expect(ctx.models.generateStructured).toHaveBeenCalledTimes(3); // 一次命名与两次资料提取。
    expect(service.bodies).toHaveLength(1);
    expect(store.state(queued.branchId).rpg?.nextChoice).toEqual(choice); expect(store.chapter(queued.branchId, choice.chapterId).text).toBe(text);
    await ctx.engine.close(); const offline = engineFor(store, config, false); expect(answer(store, offline.engine, choice).id).not.toBe(queued.id);
    expect(service.bodies).toHaveLength(1);
  });

  it('resets both prose and the 24-round tool allowance after a chapter closes at the last allowed round', async () => {
    const service = await upstream((_body, reply, index) => respond(reply, index < 23 ? '路'.repeat(5) : index === 23 ? '末'.repeat(10) : '你按所选方向迈出下一步。', index < 24 ? ask(`节点 ${index + 1}`) : undefined));
    const store = makeStore(), ctx = engineFor(store, settings(service.url)); const { queued } = start(store, ctx.engine, 120);
    for (let index = 0; index < 23; index++) {
      const paused = await waiting(ctx.engine, queued.id); expect(paused.pendingChoice?.question).toBe(`节点 ${index + 1}`);
      ctx.engine.choose(queued.id, { choiceId: paused.pendingChoice!.id, optionId: 'bridge' });
    }
    expect((await finished(ctx.engine, queued.id)).status).toBe('completed'); const state = await ready(store, ctx.engine, queued.branchId);
    expect(service.bodies).toHaveLength(24); expect(store.chapter(queued.branchId, state.chapters[0].id).text).toBe('路'.repeat(115) + '末'.repeat(10));
    expect(state.rpg?.nextChoice?.question).toBe('节点 24'); const next = answer(store, ctx.engine, state.rpg!.nextChoice!);
    expect((await finished(ctx.engine, next.id)).status).toBe('completed'); const latest = await ready(store, ctx.engine, queued.branchId, 2);
    expect(service.bodies).toHaveLength(25); expect(ctx.requests.at(-1)?.continuationRound).toBeUndefined(); expect(ctx.requests.at(-1)?.budget).toEqual({ targetWords: 120 });
    expect(store.chapter(queued.branchId, latest.chapters[1].id).text).toBe('你按所选方向迈出下一步。'); expect(job(ctx.engine, next.id)).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  }, 15000);

  it('retains ordinary same-chapter choices and their original protocol continuation below the chapter target', async () => {
    const service = await upstream((_body, reply, index) => respond(reply, index ? '你来到桥头。' : '你站在岔路口。', index ? undefined : ask()));
    const store = makeStore(), ctx = engineFor(store, settings(service.url)); const { queued } = start(store, ctx.engine, 1000);
    const paused = await waiting(ctx.engine, queued.id); expect(store.state(queued.branchId).rpg?.nextChoice).toBeUndefined();
    const resumed = ctx.engine.choose(queued.id, { choiceId: paused.pendingChoice!.id, optionId: 'bridge' }); expect(resumed.id).toBe(queued.id);
    expect((await finished(ctx.engine, queued.id)).status).toBe('completed'); const state = await ready(store, ctx.engine, queued.branchId);
    expect(service.bodies).toHaveLength(2);
    const withoutBudget = (messages: any[]) => messages.filter(message => !String(message.content).startsWith('[ai-novel:rpg-chapter-budget]'));
    const initialMessages = withoutBudget(service.bodies[0].messages);
    expect(withoutBudget(service.bodies[1].messages).slice(0, initialMessages.length)).toEqual(initialMessages);
    expect(service.bodies[1].messages.find((message: any) => String(message.content).startsWith('[ai-novel:rpg-chapter-budget]')).content).toContain('已累计生成正文 7 字');
    expect(store.chapter(queued.branchId, state.chapters[0].id).text).toBe('你站在岔路口。你来到桥头。'); expect(state.rpg?.nextChoice).toBeUndefined();
  });

  it('backs up multiple chapter-end questions and carries the remaining question into a fresh prompt as unanswered', async () => {
    const secondQuestion = { question: '店主另问是否查看地图？', options: [{ id: 'map', label: '查看店主的地图' }, { id: 'later', label: '稍后再看' }] };
    const service = await upstream((_body, reply, index) => {
      if (!index) respond(reply, '章'.repeat(120), [
        ...ask('你准备前往哪里？'), { id: 'second-question', name: 'ask_user', args: secondQuestion },
      ]);
      else if (index === 1) respond(reply, '你决定前往桥头，店主仍在等你回答地图的事。', [{ id: 'fresh-question', name: 'ask_user', args: secondQuestion }]);
      else respond(reply, '店主将地图展开，让你查看通往桥头的道路。');
    });
    const store = makeStore(), config = settings(service.url), first = engineFor(store, config); const { project, queued } = start(store, first.engine);
    expect((await finished(first.engine, queued.id)).status).toBe('completed'); const original = await ready(store, first.engine, queued.branchId);
    expect(original.rpg?.nextChoice).toMatchObject({ question: '你准备前往哪里？', followingChoices: [secondQuestion] }); expect(service.bodies).toHaveLength(1);
    expect(rawJob(store, queued.id).payload.rpgChoiceAnswer).toBeUndefined(); await first.engine.close();
    const restored = store.restoreProject(store.exportProject(project.id)); const offline = engineFor(store, config, false);
    const copy = offline.engine.listJobs(restored.id).find(value => value.kind === 'generate')!; const choice = store.state(copy.branchId).rpg!.nextChoice!;
    expect(choice.followingChoices).toEqual(original.rpg!.nextChoice!.followingChoices);
    const next = answer(store, offline.engine, choice); expect(next.chapterStartChoiceId).toBe(choice.id);
    expect(rawJob(store, next.id).payload.rpgChapterAnswer).toMatchObject({ question: '你准备前往哪里？', optionId: 'bridge', text: '前往桥头', unansweredQuestions: [secondQuestion] });
    offline.engine.start(); const paused = await waiting(offline.engine, next.id); expect(paused.pendingChoice).toMatchObject(secondQuestion);
    expect(service.bodies).toHaveLength(2); expect(offline.requests[0].continuationRound).toBeUndefined();
    const actionMessage = service.bodies[1].messages.find((message: any) => message.role === 'user' && String(message.content).includes('# 上一章的待选问题与玩家已确认的行动\n'));
    expect(actionMessage).toBeDefined(); expect(actionMessage.content).toContain('不能当作已确认行动');
    const action = JSON.parse(actionMessage.content.split('# 上一章的待选问题与玩家已确认的行动\n')[1].split('\n')[0]); expect(action.text).toBe('前往桥头'); expect(action.unansweredQuestions).toMatchObject([secondQuestion]);
    const dialogue = service.bodies[1].messages.filter((message: any) => message.role !== 'system');
    expect(dialogue.map((message: any) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(action.unansweredQuestions[0].optionId).toBeUndefined(); expect(action.unansweredQuestions[0].text).toBeUndefined();
    expect(service.bodies[1].messages.some((message: any) => message.tool_calls || message.tool_call_id)).toBe(false);
    offline.engine.choose(next.id, { choiceId: paused.pendingChoice!.id, optionId: 'map' }); expect((await finished(offline.engine, next.id)).status).toBe('completed');
    await ready(store, offline.engine, copy.branchId, 2); expect(service.bodies).toHaveLength(3);
    expect(service.bodies[2].messages.some((message: any) => message.role === 'tool' && message.content.includes('查看店主的地图'))).toBe(true);
    expect(store.state(queued.branchId).rpg?.nextChoice).toEqual(original.rpg?.nextChoice);
  });

  it('retains the confirmed chapter-start action after the first request fails and retries only when the user explicitly requests it', async () => {
    const nextText = '你按照已确认的行动先观察桥头，再等待新的决定。';
    const service = await upstream((_body, reply, index) => {
      if (!index) respond(reply, '旧'.repeat(120), ask('是否先观察桥头？'));
      else if (index === 1) { reply.writeHead(503, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify({ error: { message: '本地模拟的暂时失败' } })); }
      else respond(reply, nextText);
    });
    const store = makeStore(), config = settings(service.url), first = engineFor(store, config); const { queued } = start(store, first.engine);
    await finished(first.engine, queued.id); const original = await ready(store, first.engine, queued.branchId);
    const next = answer(store, first.engine, original.rpg!.nextChoice!, { customText: '我先观察桥头，不立即回答守卫' });
    expect((await finished(first.engine, next.id)).status).toBe('failed'); expect(service.bodies).toHaveLength(2);
    expect(rawJob(store, next.id).payload.rpgChapterAnswer).toMatchObject({ question: '是否先观察桥头？', text: '我先观察桥头，不立即回答守卫' });
    expect(store.state(queued.branchId).rpg?.nextChoice).toBeUndefined(); expect(store.state(queued.branchId).chapters).toHaveLength(1);
    await first.engine.close(); const restarted = engineFor(store, config); expect(job(restarted.engine, next.id).status).toBe('failed'); expect(service.bodies).toHaveLength(2);
    restarted.engine.action(next.id, 'retry'); expect((await finished(restarted.engine, next.id)).status).toBe('completed'); const state = await ready(store, restarted.engine, queued.branchId, 2);
    expect(service.bodies).toHaveLength(3); expect(JSON.stringify(service.bodies[2].messages)).toContain('我先观察桥头，不立即回答守卫'); expect(restarted.requests[0].continuationRound).toBeUndefined();
    expect(store.chapter(queued.branchId, state.chapters[0].id).text).toBe('旧'.repeat(120)); expect(store.chapter(queued.branchId, state.chapters[1].id).text).toBe(nextText);
  });

  it('applies already captured complete prose locally after a save failure without charging or generating again, and keeps its final choice', async () => {
    const text = '完'.repeat(120); const service = await upstream((_body, reply) => respond(reply, text, ask('正文保存失败也不能丢失的问题')));
    const store = makeStore(), ctx = engineFor(store, settings(service.url));
    const save = vi.spyOn(store, 'saveChapter').mockImplementationOnce(() => { throw new Error('仅此一次的本地保存失败'); });
    const { queued } = start(store, ctx.engine); const failed = await finished(ctx.engine, queued.id); expect(failed.status).toBe('failed'); save.mockRestore();
    expect(store.state(queued.branchId).chapters).toHaveLength(0); expect(ctx.engine.writingSnapshot(queued.id).text).toBe(text); expect(service.bodies).toHaveLength(1);
    expect(failed.pendingChoice).toBeUndefined(); const output = ctx.engine.listOutputs(queued.id).find(value => value.stage === 'writing')!;
    expect(ctx.engine.outputDetail(queued.id, output.id).canApply).toBe(true);
    ctx.engine.applyOutput(queued.id, output.id, { text, baseRevisionId: store.getBranch(queued.branchId).revisionId });
    expect(job(ctx.engine, queued.id)).toMatchObject({ status: 'completed', inputTokens: 10, outputTokens: 5 });
    const state = store.state(queued.branchId); expect(store.chapter(queued.branchId, state.chapters[0].id).text).toBe(text); expect(state.rpg?.nextChoice?.question).toBe('正文保存失败也不能丢失的问题');
    const extraction = await until(() => ctx.engine.listJobs().find(value => value.branchId === queued.branchId && value.kind === 'extract'), value => value?.status === 'paused');
    ctx.engine.action(extraction!.id, 'resume'); await ready(store, ctx.engine, queued.branchId);
    expect(service.bodies).toHaveLength(1); expect(ctx.models.generateText).toHaveBeenCalledTimes(1); expect(ctx.models.generateStructured).toHaveBeenCalledTimes(2); // 一次命名与一次资料提取。
    expect(store.state(queued.branchId).rpg?.nextChoice).toEqual(state.rpg?.nextChoice);
  });

  it('hides sealed choices from readers and requires author access and a current revision for the choice API', async () => {
    const service = await upstream((_body, reply) => respond(reply, '章'.repeat(120), ask('只给作者看的章末问题')));
    const app = await buildApp({ initialPassword: 'story-password-123', dataDir: mkdtempSync(join(tmpdir(), 'ai-novel-rpg-chapters-api-')), startEngine: false }); apps.push(app);
    const ctx = engineFor(app.store, settings(service.url)); const { project, queued } = start(app.store, ctx.engine);
    await finished(ctx.engine, queued.id); const state = await ready(app.store, ctx.engine, queued.branchId); await ctx.engine.close(); const choice = state.rpg!.nextChoice!;
    const login = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'story-password-123' } }); const session = login.cookies.find(cookie => cookie.name === 'session')!.value;
    const reader = await app.app.inject({ url: `/api/branches/${queued.branchId}`, cookies: { session } }); expect(reader.statusCode).toBe(200); expect(reader.body).not.toContain('只给作者看的章末问题'); expect(reader.json().state.rpg).toBeUndefined();
    const author = await app.app.inject({ url: `/api/branches/${queued.branchId}?view=author`, cookies: { session } }); expect(author.json().state.rpg.nextChoice).toEqual(choice);
    const jobs = await app.app.inject({ url: `/api/jobs?projectId=${project.id}`, cookies: { session } }); expect(jobs.body).not.toContain('只给作者看的章末问题');
    const payload = { choiceId: choice.id, optionId: 'bridge', baseRevisionId: app.store.getBranch(queued.branchId).revisionId };
    expect((await app.app.inject({ method: 'POST', url: `/api/jobs/${queued.id}/choice`, cookies: { session }, payload })).statusCode).toBe(403);
    expect((await app.app.inject({ method: 'POST', url: `/api/jobs/${queued.id}/choice?view=author`, cookies: { session }, payload: { choiceId: choice.id, optionId: 'bridge' } })).statusCode).toBe(409);
    expect((await app.app.inject({ method: 'POST', url: `/api/jobs/${queued.id}/choice?view=author`, cookies: { session }, payload: { ...payload, baseRevisionId: queued.baseRevisionId } })).statusCode).toBe(409);
    const accepted = await app.app.inject({ method: 'POST', url: `/api/jobs/${queued.id}/choice?view=author`, cookies: { session }, payload }); expect(accepted.statusCode).toBe(200); expect(accepted.json<Job>().id).not.toBe(queued.id); expect(accepted.json<Job>().chapterStartChoiceId).toBe(choice.id);
    const authorJobs = await app.app.inject({ url: `/api/jobs?projectId=${project.id}&view=author`, cookies: { session } }); expect(authorJobs.json<Job[]>().find(value => value.id === accepted.json<Job>().id)?.chapterStartChoiceId).toBe(choice.id);
    const readerJobs = await app.app.inject({ url: `/api/jobs?projectId=${project.id}`, cookies: { session } }); expect(readerJobs.json<Job[]>().find(value => value.id === accepted.json<Job>().id)?.chapterStartChoiceId).toBeUndefined(); expect(readerJobs.body).not.toContain('chapterStartChoiceId');
    expect((await app.app.inject({ method: 'POST', url: `/api/jobs/${queued.id}/choice?view=author`, cookies: { session }, payload })).statusCode).toBe(409); expect(service.bodies).toHaveLength(1);
  });
});
