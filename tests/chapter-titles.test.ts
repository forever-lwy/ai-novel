import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app.js';
import { listenLocalServer } from './local-server.mjs';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { buildWritingContext } from '../server/writing-context.js';
import { buildRequestSnapshot } from '../server/providers.js';
import { compileTaskPrompt, defaultPromptTemplates } from '../shared/prompt-templates.js';
import { chapterTitleSample } from '../shared/chapter-titles.js';
import type { ModelRequest, ProviderProtocol, Settings } from '../shared/types.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = []; const servers: Server[] = []; const engines: StoryEngine[] = []; const stores: Store[] = [];
function saveReady(store: Store, branchId: string, title: string, text: string) {
  const saved = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title, text });
  store.applyExtraction(branchId, saved.branch.revisionId, saved.state.chapters.at(-1)!.id, { summary: '已整理的剧情。', entities: [], relations: [], foreshadows: [] }, true);
}
afterEach(async () => {
  for (const ctx of apps.splice(0)) await ctx.app.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const engine of engines.splice(0)) await engine.close();
  for (const store of stores.splice(0)) store.close();
});
async function setup() {
  const ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'novel-title-repair-')), initialPassword: 'title-repair-password-123', startEngine: false, rateLimits: { imports: 100, models: 100 } }); apps.push(ctx);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'title-repair-password-123' } });
  const cookies = { session: login.cookies[0].value }; const project = ctx.store.createProject({ title: '标题错位测试' }); const branchId = project.mainBranchId;
  const request = (method: string, url: string, payload?: unknown) => ctx.app.inject({ method: method as 'POST', url, cookies, payload });
  for (const [title, text] of [['第12章 错题', '第16章 雨夜\n林舟来到码头寻找刚刚失踪的守城人。'], ['第16章 雨夜', '第17章 新路\n林舟走向灯塔，发现另一条道路。']]) {
    saveReady(ctx.store, branchId, title, text);
  }
  const base = () => ctx.store.getBranch(branchId).revisionId;
  const ids = () => ctx.store.state(branchId).chapters.map(chapter => chapter.id);
  return { ctx, project, branchId, cookies, request, base, ids };
}
type ModelSample = { chapterId: string; title: string; beginning: string; ending: string; sourceContext?: string };
const proposed = (chapters: ModelSample[]) => ({ chapters: chapters.map(chapter => ({ chapterId: chapter.chapterId, title: chapter.beginning.split('\n')[0], reason: '正文开头明确给出标题。', evidence: chapter.beginning.split('\n')[0], confidence: 'high', multipleChapters: false })) });
async function provider(ctx: Awaited<ReturnType<typeof buildApp>>, protocol: ProviderProtocol = 'openai-chat', output: (chapters: ModelSample[]) => unknown | Promise<unknown> = proposed, status = 200) {
  const bodies: any[] = []; const samples: ModelSample[][] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const prompt = protocol === 'openai-chat' ? body.messages.filter((message: any) => message.role === 'user').map((message: any) => message.content).join('\n') : protocol === 'openai-responses' ? typeof body.input === 'string' ? body.input : body.input.filter((message: any) => message.role === 'user').map((message: any) => message.content).join('\n') : protocol === 'gemini' ? body.contents.flatMap((message: any) => message.parts.map((part: any) => part.text)).join('\n') : body.messages.filter((message: any) => message.role === 'user').map((message: any) => message.content).join('\n');
    const parsed = JSON.parse(prompt); samples.push(parsed.chapters);
    const value = await output(parsed.chapters); const text = typeof value === 'string' ? value : JSON.stringify(value);
    const result = status !== 200 ? { error: 'fixture error' } : protocol === 'openai-chat' ? { choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 20 } } : protocol === 'openai-responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 20 } } : protocol === 'gemini' ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } } : { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 } };
    response.setHeader('Connection', 'close'); response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  }); servers.push(server); await listenLocalServer(server);
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  ctx.settings.save({ providers: [{ id: 'fixture', name: '标题修复本地接口', protocol, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fake-title-secret' }], writingProviderId: '', extractionProviderId: 'fixture', planningProviderId: '', extractionModel: 'title-fixture' });
  return { bodies, samples };
}

describe('chapter title preview and versioned application', () => {
  it.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('previews through %s once, maps opaque handles and exposes redacted diagnostics without saving', async protocol => {
    const { ctx, request, branchId, base, ids } = await setup(); const original = ctx.store.state(branchId); const version = base(); const fixture = await provider(ctx, protocol);
    const response = await request('POST', `/api/branches/${branchId}/chapter-titles/preview?view=author`, { baseRevisionId: version, chapterIds: ids() });
    expect(response.statusCode).toBe(200); const result = response.json();
    expect(result).toMatchObject({ ok: true, inputTokens: 10, outputTokens: 20, suggestions: [{ chapterId: ids()[0], originalTitle: '第12章 错题', title: '第16章 雨夜' }, { chapterId: ids()[1], title: '第17章 新路' }] });
    expect(fixture.bodies).toHaveLength(1); expect(fixture.samples[0][0].chapterId).not.toBe(ids()[0]); expect(fixture.samples[0][0].chapterId).toMatch(/^[\da-f-]{36}$/);
    expect(fixture.samples[0][0]).not.toHaveProperty('index'); expect(fixture.samples[0][0]).not.toHaveProperty('position');
    expect(result.capture.request.body).toContain('章节标题修复'); expect(response.body).not.toContain('fake-title-secret');
    expect(base()).toBe(version); expect(ctx.store.state(branchId)).toEqual(original);
  });
  it('applies only selected editable titles across chapter snapshots, preserving prose, materials, other lines, history and backups', async () => {
    const { ctx, request, branchId, project, base, ids } = await setup();
    const authored = ctx.store.state(branchId);
    authored.outline = { worldview: '作者确认的港城设定', locked: '主角能力不可修改', fine: [], summaryCompression: { text: '作者确认的两章压缩摘要', chapterIds: ids() } };
    authored.entities.push({ id: 'author-character', name: '林舟', kind: 'character', description: '作者锁定的身份', visibility: 'secret', locked: true, aliases: [], facts: [{ id: 'author-fact', text: '作者锁定的身世', visibility: 'secret', locked: true, temporal: 'current', certainty: 'fact' }] });
    ctx.store.commit(branchId, base(), authored, '作者确认资料与摘要');
    const original = ctx.store.state(branchId); const version = base();
    const fork = ctx.store.fork(branchId, { baseRevisionId: version, name: '保持旧标题' }); const forkOriginal = ctx.store.state(fork.branch.id);
    const texts = ids().map(id => ctx.store.chapter(branchId, id).text);
    const response = await request('POST', `/api/branches/${branchId}/chapter-titles/apply?view=author`, { baseRevisionId: version, changes: [{ chapterId: ids()[0], originalTitle: original.chapters[0].title, title: '第16章 作者确认题名' }] });
    expect(response.statusCode).toBe(200); const changed = response.json();
    expect(changed.state.chapters.map((chapter: any) => chapter.title)).toEqual(['第16章 作者确认题名', '第16章 雨夜']);
    expect(changed.state.entities).toEqual(original.entities); expect(changed.state.outline).toEqual(original.outline);
    expect(ids().map(id => ctx.store.chapter(branchId, id).text)).toEqual(texts);
    expect(ctx.store.readingState(branchId, ids()[0]).chapters[0].title).toBe('第16章 作者确认题名');
    expect(ctx.store.fork(branchId, { baseRevisionId: base(), chapterId: ids()[0], name: '修复后从早章分支' }).state.chapters[0].title).toBe('第16章 作者确认题名');
    expect(ctx.store.state(fork.branch.id)).toEqual(forkOriginal); expect(ctx.store.revisionState(version)).toEqual(original);
    expect(ctx.store.search(branchId, '作者确认题名', true).chapters[0].title).toBe('第16章 作者确认题名');
    expect(ctx.store.exportText(branchId)).toContain('第16章 作者确认题名');
    expect(() => ctx.store.restoreProject(ctx.store.exportProject(project.id))).not.toThrow();
    ctx.store.rollback(branchId, { baseRevisionId: base(), revisionId: version }); expect(ctx.store.state(branchId)).toEqual(original);
  });
  it('requires login, current version, distinct chapter handles and an idle branch', async () => {
    const { ctx, request, branchId, base, ids } = await setup(); const path = `/api/branches/${branchId}/chapter-titles/preview`; const input = { baseRevisionId: base(), chapterIds: ids() }; const fixture = await provider(ctx);
    expect((await ctx.app.inject({ method: 'POST', url: path + '?view=author', payload: input })).statusCode).toBe(401);
    expect((await request('POST', path, { ...input, baseRevisionId: 'stale' })).statusCode).toBe(409);
    expect((await request('POST', path + '?view=author', { ...input, baseRevisionId: 'stale' })).statusCode).toBe(409);
    for (const chapterIds of [[], [ids()[0], ids()[0]], ['foreign'], Array.from({ length: 21 }, () => randomUUID())]) expect((await request('POST', path + '?view=author', { ...input, chapterIds })).statusCode).toBeGreaterThanOrEqual(400);
    const job = ctx.engine.enqueue(branchId, 'extract', { baseRevisionId: base() });
    expect((await request('POST', path + '?view=author', input)).statusCode).toBe(409); ctx.engine.action(job.id, 'cancel');
    expect(fixture.bodies).toHaveLength(0);
  });
  it('rejects stale, foreign, duplicated and empty application without writing any partial changes', async () => {
    const { ctx, request, branchId, base, ids } = await setup(); const original = ctx.store.state(branchId); const path = `/api/branches/${branchId}/chapter-titles/apply?view=author`;
    const change = { chapterId: ids()[0], originalTitle: original.chapters[0].title, title: '作者题名' };
    for (const payload of [{ baseRevisionId: 'stale', changes: [change] }, { baseRevisionId: base(), changes: [change, { ...change, chapterId: 'foreign' }] }, { baseRevisionId: base(), changes: [change, change] }, { baseRevisionId: base(), changes: [{ ...change, originalTitle: '旧题' }] }, { baseRevisionId: base(), changes: [{ ...change, title: '' }] }, { baseRevisionId: base(), changes: [{ ...change, title: '换\n行' }] }, { baseRevisionId: base(), changes: [{ ...change, title: change.originalTitle }] }]) {
      expect((await request('POST', path, payload)).statusCode).toBeGreaterThanOrEqual(400); expect(ctx.store.state(branchId)).toEqual(original);
    }
    expect((await request('POST', path.replace('?view=author', ''), { baseRevisionId: base(), changes: [change] })).statusCode).toBe(200);
  });
  it.each(['malformed', 'missing', 'duplicate', 'foreign', 'false-evidence', 'no-evidence', 'invented-number', 'upstream'])('retains diagnostics and does not retry or save on %s output', async problem => {
    const { ctx, request, branchId, base, ids } = await setup(); const version = base();
    const fixture = await provider(ctx, 'openai-chat', chapters => {
      if (problem === 'malformed') return 'not JSON';
      const result = proposed(chapters);
      if (problem === 'missing') result.chapters.pop();
      if (problem === 'duplicate') result.chapters[1].chapterId = result.chapters[0].chapterId;
      if (problem === 'foreign') result.chapters[0].chapterId = 'foreign';
      if (problem === 'false-evidence') result.chapters[0].evidence = '编造的原文';
      if (problem === 'no-evidence') result.chapters[0].evidence = '';
      if (problem === 'invented-number') result.chapters[0].title = '第13章 猜出来的编号';
      return result;
    }, problem === 'upstream' ? 500 : 200);
    const response = await request('POST', `/api/branches/${branchId}/chapter-titles/preview?view=author`, { baseRevisionId: version, chapterIds: ids() });
    expect(response.json()).toMatchObject({ ok: false, error: expect.any(String), capture: { request: expect.any(Object) } }); expect(fixture.bodies).toHaveLength(1); expect(base()).toBe(version);
  });
  it('rejects late preview results after a new revision and leaves the newer title intact', async () => {
    const { ctx, request, branchId, base, ids } = await setup(); let ready!: () => void; let resume!: () => void;
    const arrived = new Promise<void>(resolve => { ready = resolve; }); const gate = new Promise<void>(resolve => { resume = resolve; });
    await provider(ctx, 'openai-chat', async chapters => { ready(); await gate; return proposed(chapters); });
    const pending = request('POST', `/api/branches/${branchId}/chapter-titles/preview?view=author`, { baseRevisionId: base(), chapterIds: ids() });
    await arrived;
    const state = ctx.store.state(branchId); state.chapters[0].title = '作者新的标题'; ctx.store.commit(branchId, base(), state, '作者新版本'); resume();
    expect((await pending).json()).toMatchObject({ ok: false, error: expect.stringContaining('新版本') }); expect(ctx.store.state(branchId).chapters[0].title).toBe('作者新的标题');
  });
  it('uses original source headings and current import edits without persisting drafts or sending directory indexes', async () => {
    const { ctx, request, project } = await setup(); const boundary = 'title-repair-boundary'; const text = '第16章 雨夜\n\n林舟来到码头寻找刚刚失踪的守城人。\n\n第17章 新路\n\n林舟走向灯塔发现另一条道路。';
    const uploaded = await ctx.app.inject({ method: 'POST', url: `/api/projects/${project.id}/import`, cookies: { session: (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'title-repair-password-123' } })).cookies[0].value }, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.txt"\r\n\r\n${text}\r\n--${boundary}--\r\n` });
    const original = uploaded.json(); const sourceId = original.source.id;
    const fixture = await provider(ctx, 'openai-chat', chapters => ({ chapters: chapters.map(chapter => ({ chapterId: chapter.chapterId, title: '第16章 雨夜', reason: '原文件在本章开头前有标题。', evidence: '第16章 雨夜', confidence: 'high', multipleChapters: false })) }));
    const response = await request('POST', `/api/sources/${sourceId}/chapter-titles/preview?view=author`, { chapters: [chapterTitleSample({ chapterId: 'draft-12', title: '第12章 错题', text: original.chapters[0].text })] });
    expect(response.json()).toMatchObject({ ok: true, suggestions: [{ chapterId: 'draft-12', title: '第16章 雨夜' }] });
    expect(fixture.samples[0][0].sourceContext).toContain('第16章 雨夜'); expect(fixture.samples[0][0].chapterId).not.toContain('draft-12');
    expect((await request('GET', `/api/sources/${sourceId}/preview`)).json()).toEqual(original);
  });
});

describe('continuation ignores split positions', () => {
  it('anchors a real engine request to the end of the twelfth segment titled chapter 16, including custom legacy presets', async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'novel-ordinal-'))); stores.push(store); const project = store.createProject({ title: '内部序号回归' }); const branchId = project.mainBranchId;
    for (let index = 0; index < 12; index++) saveReady(store, branchId, index === 11 ? '第16章 夜谈' : `原作旧题 ${index}`, index === 11 ? '守城人刚把钥匙交给林舟。\nLAST_SAVED_END：林舟的手已经按在门上。' : '既往事件已经结束。');
    const state = store.state(branchId); for (const chapter of state.chapters) chapter.status = 'ready'; store.commit(branchId, store.getBranch(branchId).revisionId, state, '整理就绪');
    const templates = defaultPromptTemplates(); templates.presets.writing[0].blocks.push({ id: 'legacy-number', name: '旧编号变量', enabled: true, role: 'user', content: '旧预设：请写第 {{chapterNumber}} 章。' });
    const settings: Settings = { providers: [{ id: 'local', name: 'mock', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'mock', maxOutputTokens: 256, contextTokens: 64000 }], writingProviderId: 'local', planningProviderId: 'local', extractionProviderId: 'local', promptTemplates: templates };
    const requests: ModelRequest[] = [];
    const models: TextModels = { generateText: async (_provider, request) => { requests.push(request); return { text: '他推开门，跨进门后的灯火。', inputTokens: 1, outputTokens: 1 }; }, generateStructured: async (_provider, _request, validate) => ({ value: validate({ summary: '林舟推门进入。', entities: [], relations: [], foreshadows: [] }), inputTokens: 1, outputTokens: 1 }) };
    const engine = new StoryEngine(store, () => settings, models); engines.push(engine); engine.start();
    const job = engine.enqueue(branchId, 'generate', { title: '新章节', baseRevisionId: store.getBranch(branchId).revisionId, mode: 'continuation', instruction: '接着发生新事件' });
    for (let attempt = 0; attempt < 1000 && !['completed', 'failed'].includes(engine.listJobs().find(value => value.id === job.id)!.status); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(engine.listJobs().find(value => value.id === job.id)!.status).toBe('completed');
    const request = requests[0]; expect(request.prompt).toContain('LAST_SAVED_END'); expect(request.prompt).toContain('continuationAnchor'); expect(request.prompt).toContain('第16章 夜谈');
    expect(request.prompt).toContain('旧预设：请写待写章节。'); expect(request.prompt).not.toMatch(/请写第\s*(?:12|13)\s*章/); expect(request.system).toContain('不要按编号推算进度');
    for (const protocol of ['openai-chat', 'openai-responses', 'gemini', 'claude'] as const) expect(buildRequestSnapshot({ ...settings.providers[0], model: 'mock', protocol } as any, request).body).not.toMatch(/请写第\s*(?:12|13)\s*章/);
    const listing = await request.tools!.find(tool => tool.name === 'list_text_files')!.execute({ collection: 'story', limit: 100 }) as { files: { path: string; title: string }[] };
    expect(listing.files).toHaveLength(12); expect(listing.files.every(file => /^story\/[a-f\d]{24}\.txt$/.test(file.path))).toBe(true);
    expect(JSON.stringify(listing)).not.toContain('/000012.txt'); expect(store.state(branchId).chapters.at(-1)!.title).toBe('新章节');
  });
  it('keeps opaque lookup handles stable when earlier chapters are removed and resolves saved legacy handles without advertising them', async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'novel-paths-'))); stores.push(store); const project = store.createProject({ title: '路径稳定' }); const branchId = project.mainBranchId;
    for (const title of ['旧章', '第16章']) saveReady(store, branchId, title, title + '原文。');
    const state = store.state(branchId); const context = buildWritingContext({ state, chapterText: id => store.chapter(branchId, id).text });
    const listed = await context.tools.find(tool => tool.name === 'list_text_files')!.execute({}) as any;
    expect((await context.tools.find(tool => tool.name === 'read_text_file')!.execute({ path: 'story/000002.txt' }) as any).path).toBe(listed.files[1].path);
    state.chapters.shift(); const shorter = buildWritingContext({ state, chapterText: id => store.chapter(branchId, id).text });
    expect((await shorter.tools.find(tool => tool.name === 'list_text_files')!.execute({}) as any).files[0].path).toBe(listed.files[1].path);
    const compiled = compileTaskPrompt(undefined, 'writing', { ...context.variables, chapterNumber: 13 }); expect(compiled.system).toContain('虚拟文件路径和章节 id');
  });
  it('maps opaque handles through backup id replacement without advertising old handles', async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'novel-restored-paths-'))); stores.push(store); const project = store.createProject({ title: '恢复查询' }); const branchId = project.mainBranchId;
    saveReady(store, branchId, '第16章', '林舟恢复后继续前进。');
    const before = buildWritingContext({ state: store.state(branchId), chapterText: id => store.chapter(branchId, id).text });
    const oldId = store.state(branchId).chapters[0].id;
    const oldPath = (await before.tools.find(tool => tool.name === 'list_text_files')!.execute({}) as any).files[0].path;
    const copy = store.restoreProject(store.exportProject(project.id)); const state = store.state(copy.mainBranchId); const aliases = { [oldId]: state.chapters[0].id };
    const after = buildWritingContext({ state, chapterText: id => store.chapter(copy.mainBranchId, id).text, lookupAliases: aliases });
    const listing = await after.tools.find(tool => tool.name === 'list_text_files')!.execute({}) as any;
    expect(listing.files[0].path).not.toBe(oldPath);
    const restored = await after.tools.find(tool => tool.name === 'read_text_file')!.execute({ path: oldPath }) as any;
    expect(restored.path).toBe(listing.files[0].path); expect(restored.lines[0].text).toBe('林舟恢复后继续前进。');
  });
});
