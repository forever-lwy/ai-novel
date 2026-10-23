import { expect, test, type Page } from '@playwright/test';
import type { Settings } from '../shared/types';
import { defaultImageSettings } from '../shared/image-settings';
import { defaultPromptTemplates } from '../shared/prompt-templates';
import { defaultModelParameters, modelRoles } from '../shared/model-settings';

const password = 'browser-test-password-123';
const mockUrl = `http://127.0.0.1:${process.env.E2E_MODEL_PORT || '4329'}/v1`;
let original: Settings;
test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  original = await (await page.request.get('/api/settings')).json();
  const settings: Settings = { ...original, providers: [...original.providers, { id: 'project-e2e', name: '作品设置验收连接', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: 'local-only-fixture' }], promptTemplates: defaultPromptTemplates(), imageSettings: { ...defaultImageSettings(), providerId: 'project-e2e', model: 'image-fixture', stylePrompt: '全局默认画风' }, modelParameters: [...(original.modelParameters ?? [])] };
  for (const role of modelRoles) {
    settings[`${role}ProviderId`] = 'project-e2e'; settings[`${role}Model`] = `global-${role}`;
    settings.modelParameters!.push({ ...defaultModelParameters(), providerId: 'project-e2e', model: `global-${role}`, role });
  }
  expect((await page.request.put('/api/settings', { data: settings })).ok()).toBeTruthy();
});
test.afterEach(async ({ page }) => { if (original) expect((await page.request.put('/api/settings', { data: original })).ok()).toBeTruthy(); });

async function openProjectSettings(page: Page, title: string) {
  const project = await (await page.request.post('/api/projects', { data: { title, mode: 'original' } })).json();
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${title}`, exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByTestId('settings-page');
  await settings.getByRole('button', { name: '作品设置', exact: true }).click();
  await expect(settings.getByRole('heading', { name: `《${title}》作品设置` })).toBeVisible();
  await expect(settings.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('global-writing');
  return { project, settings };
}

for (const width of [1440, 390]) test(`作品设置在 ${width}px 按项覆盖、保存、重开和恢复继承`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const { project, settings } = await openProjectSettings(page, `作品设置 ${width}`);
  await expect(settings.getByRole('button', { name: '供应商连接', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: '工具与技能', exact: true })).toHaveCount(0);
  await expect(settings.getByLabel('正文写作模型名称', { exact: true })).toBeDisabled();
  await settings.getByRole('button', { name: '正文写作单独设置', exact: true }).click();
  await settings.getByLabel('正文写作模型名称', { exact: true }).fill(`local-writing-${width}`);
  await settings.getByRole('tab', { name: '摘要压缩', exact: true }).click();
  await expect(settings.getByLabel('摘要压缩模型名称', { exact: true })).toBeDisabled();
  await settings.getByRole('tab', { name: '资料提取', exact: true }).click();
  await settings.getByRole('button', { name: '资料提取单独设置', exact: true }).click();
  await settings.getByLabel('资料提取输出模式', { exact: true }).selectOption('tool');
  await settings.getByRole('button', { name: '生图与自动插画', exact: true }).click();
  await expect(settings.getByLabel('统一画风', { exact: true })).toBeDisabled();
  await settings.getByRole('button', { name: '生图与自动插画单独设置', exact: true }).click();
  await settings.getByLabel('统一画风', { exact: true }).fill('此作品专用水彩画风');
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('作品设置已保存');
  const stored = await (await page.request.get(`/api/projects/${project.id}/settings`)).json();
  expect(stored.overrides.tasks.writing.model).toBe(`local-writing-${width}`);
  expect(stored.overrides.tasks.planning).toBeUndefined(); expect(stored.overrides.tasks.extraction.extraction.outputMode).toBe('tool');
  expect(stored.overrides.imageSettings.stylePrompt).toBe('此作品专用水彩画风');
  const global = await (await page.request.get('/api/settings')).json();
  expect(global.writingModel).toBe('global-writing'); expect(global.imageSettings.stylePrompt).toBe('全局默认画风');
  global.writingModel = 'global-new'; global.planningModel = 'planning-new';
  expect((await page.request.put('/api/settings', { data: global })).ok()).toBeTruthy();
  await settings.getByRole('button', { name: '返回作品', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await settings.getByRole('button', { name: '作品设置', exact: true }).click();
  await expect(settings.getByLabel('正文写作模型名称', { exact: true })).toHaveValue(`local-writing-${width}`);
  await settings.getByRole('tab', { name: '摘要压缩', exact: true }).click();
  await expect(settings.getByLabel('摘要压缩模型名称', { exact: true })).toHaveValue('planning-new');
  await settings.getByRole('tab', { name: '正文写作', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath(`project-settings-${width}.png`), animations: 'disabled' });
  await settings.getByRole('button', { name: '正文写作恢复继承全局', exact: true }).click();
  await expect(settings.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('global-new');
  await expect(settings.getByLabel('正文写作模型名称', { exact: true })).toBeDisabled();
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('作品设置已保存');
  expect((await (await page.request.get(`/api/projects/${project.id}/settings`)).json()).overrides.tasks.writing).toBeUndefined();
});

test('作品提示词覆盖参与完整预览，切换范围保护草稿且不修改全局预设', async ({ page }) => {
  const { project, settings } = await openProjectSettings(page, '作品提示词验收');
  await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
  await settings.getByRole('button', { name: '提示词编排单独设置', exact: true }).click();
  const content = settings.getByLabel('提示词块 1 内容', { exact: true });
  const fold = content.locator('xpath=ancestor::details[1]');
  if (!(await content.isVisible())) await fold.locator('summary').first().click();
  await content.fill(`${await content.inputValue()}\nPROJECT_PROMPT_BROWSER_SENTINEL`);
  await settings.getByText('完整请求结构 · 示例模型与参数', { exact: true }).click();
  await expect(settings.getByLabel('完整提示词请求', { exact: true })).toContainText('PROJECT_PROMPT_BROWSER_SENTINEL');
  page.once('dialog', dialog => dialog.dismiss());
  await settings.getByRole('button', { name: '全局设置', exact: true }).click();
  await expect(content).toHaveValue(/PROJECT_PROMPT_BROWSER_SENTINEL/);
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('作品设置已保存');
  expect(JSON.stringify((await (await page.request.get(`/api/projects/${project.id}/settings`)).json()).overrides.promptTemplates)).toContain('PROJECT_PROMPT_BROWSER_SENTINEL');
  await settings.getByRole('button', { name: '全局设置', exact: true }).click();
  await expect(settings.getByRole('button', { name: '供应商连接', exact: true })).toBeVisible();
  expect(JSON.stringify(await (await page.request.get('/api/settings')).json())).not.toContain('PROJECT_PROMPT_BROWSER_SENTINEL');
});

test('作品设置并发保存冲突会保留编辑内容，并能放弃未保存修改后返回作品', async ({ page }) => {
  const { project, settings } = await openProjectSettings(page, '作品设置冲突验收');
  await settings.getByRole('button', { name: '正文写作单独设置', exact: true }).click();
  await settings.getByLabel('正文写作模型名称', { exact: true }).fill('unsaved-project-draft');
  const url = `/api/projects/${project.id}/settings`; const initial = await (await page.request.get(url)).json();
  expect((await page.request.put(url, { data: { revision: initial.revision, overrides: { imageSettings: { ...initial.effective.imageSettings, stylePrompt: '另一个页面的画风' } } } })).ok()).toBeTruthy();
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(settings.locator('.settings-feedback')).toContainText('作品设置已在其他页面修改');
  await expect(settings.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('unsaved-project-draft');
  page.once('dialog', dialog => dialog.dismiss()); await settings.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(settings).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await settings.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(page.locator('.workspace-project-title')).toContainText('作品设置冲突验收');
  const saved = await (await page.request.get(url)).json();
  expect(saved.overrides.tasks).toBeUndefined(); expect(saved.overrides.imageSettings.stylePrompt).toBe('另一个页面的画风');
});
