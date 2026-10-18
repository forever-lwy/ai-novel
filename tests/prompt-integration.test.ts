import { withDramatronPresets } from './fixtures/prompt-presets.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { SettingsStore } from '../server/security.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { buildRequestSnapshot, estimateModelRequestInputTokens } from '../server/providers.js';
import { defaultPromptTemplates } from '../shared/prompt-templates.js';
import { exportPromptTemplates, preparePromptImport } from '../shared/prompt-transfer.js';
import { buildWritingContext } from '../server/writing-context.js';
import type { ModelRequest, ProviderConfig, ProviderProtocol, Settings } from '../shared/types.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const engines: StoryEngine[] = []; const stores: Store[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.app.close(); for (const engine of engines.splice(0)) await engine.close(); for (const store of stores.splice(0)) store.close(); });
const config = (): Settings => ({ providers: [{ id: 'mock', name: '本地模拟', protocol: 'openai-chat', baseUrl: 'http://unused.invalid', model: 'fixture', maxOutputTokens: 256, contextTokens: 64000 }], writingProviderId: 'mock', planningProviderId: 'mock', extractionProviderId: 'mock', promptTemplates: withDramatronPresets() });
async function terminal(engine: StoryEngine, id: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const job = engine.listJobs().find(value => value.id === id)!;
    if (['completed', 'failed', 'cancelled', 'stale', 'paused'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('模拟提示词任务超时');
}

it('migrates old settings, persists editable presets and preserves them when an old client omits the field', async () => {
  const ctx = await buildApp({ initialPassword: 'prompt-test-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-prompt-api-')) }); apps.push(ctx);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'prompt-test-password' } });
  const cookies = { session: login.cookies[0].value };
  expect((await ctx.app.inject({ url: '/api/settings', cookies })).json().promptTemplates.presets.compression).toHaveLength(defaultPromptTemplates().presets.compression.length);
  const settings = config(); settings.providers[0].apiKey = 'fixture-secret-key';
  settings.promptTemplates!.presets.writing[0].blocks[0].content = '作者修改的系统提示';
  const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: settings });
  expect(saved.statusCode).toBe(200); expect(saved.body).not.toContain('fixture-secret-key');
  const legacy = { ...settings, providers: [{ ...settings.providers[0], apiKey: '' }] }; delete legacy.promptTemplates;
  expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: legacy })).statusCode).toBe(200);
  expect(ctx.settings.get().promptTemplates).toEqual(settings.promptTemplates);
  expect(ctx.settings.get().providers[0].apiKey).toBe('fixture-secret-key');
  const before = ctx.settings.meta('settings');
  for (const mutate of [
    (value: Settings) => { value.promptTemplates!.selected.writing = 'missing'; },
    (value: Settings) => { value.promptTemplates!.presets.extraction[0].blocks[0].content = '{{missing_variable}}'; },
    (value: Settings) => { value.promptTemplates!.presets.compression[0].blocks.forEach(block => { block.enabled = false; }); },
  ]) {
    const invalid = structuredClone(settings); mutate(invalid);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: invalid })).statusCode).toBe(400);
    expect(ctx.settings.meta('settings')).toBe(before);
  }
  const reopened = new SettingsStore(ctx.store.db, ctx.dataDir);
  expect(reopened.get().promptTemplates).toEqual(settings.promptTemplates);
});

it('persists a valid escaped prompt backup larger than four MiB and reloads it intact', async () => {
  const ctx = await buildApp({ initialPassword: 'prompt-test-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-prompt-large-')) }); apps.push(ctx);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'prompt-test-password' } }); const cookies = { session: login.cookies[0].value };
  const templates = defaultPromptTemplates();
  templates.presets.writing[0].blocks.push(...Array.from({ length: 8 }, (_, index) => ({ id: `escaped-${index}`, name: '已有文本', role: 'system' as const, enabled: false, content: '\u0001'.repeat(100000) })));
  const imported = preparePromptImport(JSON.stringify(exportPromptTemplates(templates)), defaultPromptTemplates()); const settings = { ...config(), promptTemplates: imported.templates };
  expect(Buffer.byteLength(JSON.stringify(settings))).toBeGreaterThan(4 * 1024 * 1024);
  const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: settings }); expect(saved.statusCode).toBe(200);
  expect(new SettingsStore(ctx.store.db, ctx.dataDir).get().promptTemplates).toEqual(templates); expect(ctx.engine.listJobs()).toEqual([]);
});

it('uses the selected message blocks and story variables for writing and background extraction', async () => {
  const settings = config(); const templates = settings.promptTemplates!;
  for (const task of ['writing', 'extraction'] as const) {
    templates.presets[task][0].blocks = [
      { id: 'rule', name: '作者规则', role: 'system', enabled: true, content: `${task} {{projectTitle}}` },
      { id: 'example', name: '示例', role: 'assistant', enabled: true, content: '预设示例' },
      { id: 'input', name: '输入', role: 'user', enabled: true, content: task === 'extraction' ? '{{chapterTitle}}\n{{blockText}}' : '{{worldview}}\n{{instruction}}\n{{chapterNumber}}' },
    ];
  }
  const calls: ModelRequest[] = [];
  const models: TextModels = {
    generateText: vi.fn(async (_provider, request) => { calls.push(request); return { text: '旅人来到桥边。', inputTokens: 2, outputTokens: 3 }; }),
    generateStructured: vi.fn(async (_provider, request, validate) => {
      calls.push(request);
      const value = request.system.includes('planning') ? { fine: [2, 3, 4, 5].map(chapter => ({ chapter, title: `规划${chapter}`, goal: '未发生剧情' })), foreshadows: [] } : { summary: '旅人来到桥边。', entities: [], relations: [], foreshadows: [] };
      return { value: validate(value), inputTokens: 2, outputTokens: 3 };
    }),
  };
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-prompt-engine-'))); stores.push(store);
  const project = store.createProject({ title: '模板作品', premise: '古城长夜' });
  const saved = store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: '已有开场', text: '旅人离开村庄。' });
  store.applyExtraction(project.mainBranchId, saved.branch.revisionId, saved.state.chapters[0].id, { summary: '旅人离开村庄。', entities: [], relations: [], foreshadows: [] }, true);
  const anchor = buildWritingContext({ state: store.state(project.mainBranchId), chapterText: id => store.chapter(project.mainBranchId, id).text }).variables.continuationAnchor;
  const engine = new StoryEngine(store, () => settings, models); engines.push(engine); engine.start();
  const writing = engine.enqueue(project.mainBranchId, 'generate', { title: '新章节', baseRevisionId: store.getBranch(project.mainBranchId).revisionId, instruction: '写旅人', mode: 'original' });
  expect((await terminal(engine, writing.id)).status).toBe('completed');
  const extraction = engine.listJobs().find(value => value.kind === 'extract')!;
  expect((await terminal(engine, extraction.id)).status).toBe('completed');
  for (const [index, task] of ['writing', 'extraction'].entries()) expect(calls[index].messages).toContainEqual({ role: 'system', content: `${task} 模板作品` });
  expect(calls[0].messages).toContainEqual({ role: 'system', content: expect.stringContaining('当前阶段只生成本章正文') });
  expect(calls[0].messages!.filter(message => ['writing 模板作品', '预设示例', '古城长夜\n写旅人\n待写章节'].includes(message.content))).toEqual([{ role: 'system', content: 'writing 模板作品' }, { role: 'user', content: '古城长夜\n写旅人\n待写章节' }]);
  expect(calls[0].messages).toContainEqual({ role: 'assistant', content: expect.stringContaining('预设示例') });
  expect(calls[1].prompt).toContain('[1] 旅人来到桥边。');
  expect(calls[0].messages![0].role).toBe('user');
  expect(calls[0].messages![1].content).toContain('[START A NEW CHAT]');
  const chapter = store.state(project.mainBranchId).chapters.at(-1)!;
  for (const protocol of ['openai-chat', 'openai-responses', 'gemini', 'claude'] as ProviderProtocol[]) {
    for (const [index, task] of (['writing', 'extraction'] as const).entries()) {
      const preview = engine.previewPrompt({ task, templates, protocol, runtime: {}, variables: { projectTitle: '模板作品', worldview: '古城长夜', instruction: '写旅人', chapterNumber: '2', chapterTitle: chapter.title, blockText: '[1] 旅人来到桥边。', continuationAnchor: anchor } });
      const actual = JSON.parse(buildRequestSnapshot({ id: 'preview', name: '预览', protocol, baseUrl: 'https://preview.invalid', model: 'preview-model', maxOutputTokens: 4096, contextTokens: 2000000 }, { ...calls[index], maxOutputTokens: 4096, onTextDelta: undefined, onActivity: undefined }).body);
      expect(JSON.parse(preview.body)).toEqual(actual);
    }
  }
});

it('sizes compression segments using edited overhead and every occurrence of the summary variable', async () => {
  const settings = config(); settings.providers[0].contextTokens = 2048;
  settings.promptTemplates!.presets.compression[0].useGeneral = false;
  settings.promptTemplates!.presets.compression[0].blocks = [
    { id: 'rule', name: '压缩规则', role: 'system', enabled: true, content: '保留已发生事件。'.repeat(35) },
    { id: 'input', name: '摘要', role: 'user', enabled: true, content: '{{summaryText}}\n对照副本：{{summaryText}}' },
  ];
  const calls: { provider: ProviderConfig; request: ModelRequest }[] = [];
  const models: TextModels = {
    generateText: vi.fn(async () => { throw new Error('压缩不应生成正文'); }),
    generateStructured: vi.fn(async (provider, request, validate) => { calls.push({ provider, request }); return { value: validate({ text: '\n旅人抵达。' }), inputTokens: 2, outputTokens: 3 }; }),
  };
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-prompt-compression-'))); stores.push(store);
  const project = store.createProject({ title: '编排分段' });
  let view = store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: '第一章', text: '旅人抵达。' });
  view = store.applyExtraction(project.mainBranchId, view.branch.revisionId, view.state.chapters[0].id, { summary: '旅人来到桥边。'.repeat(400), entities: [], relations: [], foreshadows: [] }, true);
  const engine = new StoryEngine(store, () => settings, models); engines.push(engine); engine.start();
  const job = engine.enqueue(project.mainBranchId, 'plan', { baseRevisionId: view.branch.revisionId, purpose: 'compress-summary' });
  expect((await terminal(engine, job.id)).status).toBe('completed');
  expect(calls.length).toBeGreaterThan(2);
  for (const { provider, request } of calls) expect(estimateModelRequestInputTokens(provider, request) + provider.maxOutputTokens).toBeLessThanOrEqual(provider.contextTokens);
  const firstPass = calls.slice(0, -1).map(call => call.request.prompt.split('\n对照副本：')[0]).join('');
  expect(firstPass).toBe(`第一章\n${view.state.chapters[0].summary}`);
});
