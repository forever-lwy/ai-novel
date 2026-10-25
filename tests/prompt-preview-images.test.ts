import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { activePromptPreset } from '../shared/prompt-templates.js';
import type { PromptPreviewInput, PromptPreviewResult } from '../shared/prompt-runtime.js';
import type { ImageSettings, ModelRequest, ProjectSettingsView } from '../shared/types.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function context() {
  const ctx = await buildApp({ initialPassword: 'preview-images-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-preview-images-')), startEngine: false });
  cleanup.push(() => ctx.app.close());
  const settings = ctx.settings.get();
  settings.providers = [{ id: 'fixture', name: '模拟供应商', protocol: 'openai-chat', baseUrl: 'https://fixture.invalid/v1', apiKey: 'preview-credential-must-stay-server-side' }];
  settings.writingProviderId = settings.planningProviderId = settings.extractionProviderId = 'fixture';
  settings.writingModel = settings.planningModel = settings.extractionModel = 'text-model';
  activePromptPreset(settings.promptTemplates, 'writing').writingOutputMode = 'text';
  settings.imageSettings = { ...settings.imageSettings!, providerId: 'fixture', model: 'gpt-image-2', size: '1024x1024', stylePrompt: '已保存全局画风', autoCG: true, autoPortrait: false };
  ctx.settings.save(settings);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'preview-images-password' } });
  const cookies = { session: login.cookies[0].value };
  const preview = async (imageSettings: ImageSettings) => {
    const draft: PromptPreviewInput = { task: 'writing', protocol: 'openai-chat', templates: settings.promptTemplates!, variables: { mode: 'original', context: '林舟在城门前。', instruction: '继续创作', maxWords: '1000' }, imageSettings,
      runtime: { illustrations: { portrait: imageSettings.autoPortrait, cg: imageSettings.autoCG } } };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies, payload: draft });
    expect(response.statusCode).toBe(200);
    return { draft, result: response.json<PromptPreviewResult>() };
  };
  return { ...ctx, savedSettings: settings, cookies, preview };
}

it('previews unsaved global drawing drafts without persisting settings or accepting credentials', async () => {
  const ctx = await context(); const before = ctx.settings.meta('settings');
  const draft = { ...ctx.savedSettings.imageSettings!, stylePrompt: '尚未保存的水彩草稿', promptSystemPrompt: '保持帽子的蓝色', size: '1536x1024', useCharacterReferences: false };
  const original = structuredClone(draft);
  const { result, draft: payload } = await ctx.preview(draft);
  const drawing = result.runtimeBlocks.find(block => block.name === '本次绘图设置')!.content;
  expect(drawing).toContain('画风：尚未保存的水彩草稿'); expect(drawing).toContain('保持帽子的蓝色');
  expect(drawing).toContain('尺寸 size：固定为 1536x1024'); expect(drawing).toContain('人物参考图：关闭');
  expect(drawing).not.toContain('已保存全局画风'); expect(result.body).toContain('尚未保存的水彩草稿');
  expect(JSON.stringify(result.tools)).not.toContain('尚未保存的水彩草稿');
  expect(JSON.stringify(payload)).not.toMatch(/apiKey|preview-credential/);
  expect(ctx.settings.meta('settings')).toBe(before); expect(ctx.engine.listJobs()).toEqual([]); expect(draft).toEqual(original);
  for (const invalid of [{ ...payload.imageSettings, apiKey: 'must-be-rejected' }, { ...payload.imageSettings, width: 1 }]) {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/settings/prompt-preview', cookies: ctx.cookies, payload: { ...payload, imageSettings: invalid } });
    expect(response.statusCode).toBe(400);
  }
  expect(ctx.settings.meta('settings')).toBe(before);
});

it('previews effective project drawing settings with the same fixed parameters as the actual writing request', async () => {
  const ctx = await context(); const project = ctx.store.createProject({ title: '项目画风验证' });
  const overrides: ImageSettings = { ...ctx.savedSettings.imageSettings!, protocol: 'gemini', model: 'gemini-3.1-flash-image', stylePrompt: '项目专用油画', size: '1024x1024', aspectRatio: '16:9', imageSize: '2K', useCharacterReferences: false };
  const url = `/api/projects/${project.id}/settings`;
  const saved = await ctx.app.inject({ method: 'PUT', url, cookies: ctx.cookies, payload: { revision: '0', overrides: { imageSettings: overrides } } });
  expect(saved.statusCode).toBe(200);
  const view = saved.json<ProjectSettingsView>();
  const beforeGlobal = ctx.settings.meta('settings'); const beforeProject = (await ctx.app.inject({ url, cookies: ctx.cookies })).body;
  const { result } = await ctx.preview(view.effective.imageSettings!);
  const drawing = result.runtimeBlocks.find(block => block.name === '本次绘图设置')!.content;
  expect(drawing).toContain('画风：项目专用油画'); expect(drawing).toContain('画幅比例 aspectRatio：固定为 16:9');
  expect(drawing).toContain('分辨率 imageSize：固定为 2K'); expect(drawing).toContain('人物参考图：关闭');
  expect(drawing).not.toContain('已保存全局画风'); expect(drawing).not.toContain('尺寸 size：');
  expect(ctx.settings.meta('settings')).toBe(beforeGlobal); expect((await ctx.app.inject({ url, cookies: ctx.cookies })).body).toBe(beforeProject);

  const requests: ModelRequest[] = [];
  const models: TextModels = {
    generateText: vi.fn(async (_provider, request) => { requests.push(request); return { text: '林舟穿过城门，沿着石板路前行。', inputTokens: 3, outputTokens: 5 }; }),
    generateStructured: vi.fn(async (_provider, _request, validate) => ({ value: validate({ summary: '林舟穿过城门。', entities: [], relations: [], foreshadows: [] }), inputTokens: 2, outputTokens: 3 })),
  };
  const engine = new StoryEngine(ctx.store, id => ctx.settings.get(id), models, { generateAutomatic: () => undefined });
  cleanup.push(() => engine.close()); engine.start();
  const job = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: ctx.store.getBranch(project.mainBranchId).revisionId, mode: 'original', title: '城门', instruction: '继续创作' });
  await vi.waitFor(() => expect(engine.listJobs(project.id).find(value => value.id === job.id)?.status).toBe('completed'));
  expect(requests).toHaveLength(1);
  expect(requests[0].messages?.some(message => message.content.includes(drawing))).toBe(true);
  expect(requests[0].tools?.some(tool => tool.name === 'generate_scene_cg')).toBe(true);
  expect(JSON.stringify(requests[0].tools)).not.toContain('项目专用油画');
});
