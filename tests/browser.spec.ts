import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { defaultPromptTemplates } from '../shared/prompt-templates';

// These tests exercise the real UI/server against a local HTTP model fixture.
// Passing them is not evidence of real-provider acceptance.
test.describe.configure({ mode: 'serial' });
const password = 'browser-test-password-123';
const mockUrl = `http://127.0.0.1:${process.env.E2E_MODEL_PORT || '4329'}/v1`;
const novel = '第一章 起点\n林舟来到白石城，看到城门下的石碑。\n\n他决定先去城中打听消息。\n\n第二章 灯火\n林舟在白石城找到一盏旧灯。\n\n旧灯照亮了深夜的长街。';

test.beforeEach(async ({ page }) => {
  const status = await page.request.get('/api/auth/status');
  if ((await status.json()).initialized) {
    const login = await page.request.post('/api/auth/login', { data: { password } });
    expect(login.ok()).toBeTruthy();
  }
});

async function createProject(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '新建作品', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('作品名称', { exact: true }).fill(title);
  await modal.getByLabel('最初的设定', { exact: true }).fill('林舟是一位来到白石城的旅人，故事以他的调查展开。');
  await modal.getByRole('button', { name: '创建作品', exact: true }).click();
  await expect(page.locator('.workspace-project-title')).toContainText(title);
  await page.getByRole('button', { name: '查看作者资料', exact: true }).click();
  await expect(page.getByRole('button', { name: '返回阅读视图', exact: true })).toBeVisible();
}

async function tab(page: Page, title: string) {
  await page.locator('.workspace-tabs').getByRole('button', { name: new RegExp(`^${title}`) }).click();
}

async function openModelParameters(role: Locator) {
  const details = role.locator('.provider-parameters');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
}

async function completedJobs(page: Page, count: number) {
  await tab(page, '任务');
  await expect(page.locator('.job-card .status-pill.failed')).toHaveCount(0);
  await expect(page.locator('.job-card .status-pill.completed')).toHaveCount(count);
}

async function importNovel(page: Page) {
  await page.getByRole('button', { name: '导入小说', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('input[type=file]').setInputFiles({ name: 'browser-novel.txt', mimeType: 'text/plain', buffer: Buffer.from(novel, 'utf8') });
  await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('第一章 起点');
  await modal.getByLabel('章节名称', { exact: true }).fill('第一章 起点（确认目录）');
  await modal.getByRole('button', { name: '确认目录并整理', exact: true }).click();
  await completedJobs(page, 1);
  await expect(page.locator('.chapter-list .chapter-item')).toHaveCount(2);
}

test('首次设置密码，一个供应商自动获取模型，三个任务各自选择或自定义且密钥不回显', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('登录密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建私人工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: /我的作品/ })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const modal = page.getByTestId('settings-page');
  await modal.getByRole('button', { name: '添加供应商连接', exact: true }).click();
  await modal.getByLabel('供应商名称', { exact: true }).fill('本地浏览器验收模型');
  await modal.getByLabel('服务地址', { exact: true }).fill(mockUrl);
  await modal.getByLabel(/API 密钥/).fill('e2e-not-a-real-api-key');
  let listRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/settings/models') listRequests++; });
  await modal.getByRole('button', { name: '任务模型', exact: true }).click();
  await modal.getByRole('combobox', { name: '正文写作供应商', exact: true }).selectOption({ index: 1 });
  await expect(modal.getByRole('combobox', { name: '正文写作上游模型', exact: true })).toBeEnabled();
  await expect(modal.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('');
  await modal.getByRole('combobox', { name: '剧情规划供应商', exact: true }).selectOption({ index: 1 });
  await modal.getByRole('combobox', { name: '资料提取供应商', exact: true }).selectOption({ index: 1 });
  await modal.getByRole('combobox', { name: '正文写作上游模型', exact: true }).selectOption('e2e-fixture');
  await modal.getByRole('combobox', { name: '剧情规划上游模型', exact: true }).selectOption('e2e-planning');
  await modal.getByLabel('资料提取模型名称', { exact: true }).fill('e2e-custom-extraction');
  expect(listRequests).toBe(1);
  await modal.locator('.settings-role-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('supplier-task-models-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await modal.locator('.settings-task-card').first().scrollIntoViewIfNeeded();
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('supplier-task-models-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await modal.getByRole('button', { name: '正文写作保存并测试连接', exact: true }).click();
  await expect(modal.getByRole('status')).toContainText('服务已返回有效文字');
  await modal.getByRole('button', { name: '供应商连接', exact: true }).click();
  await expect(modal.getByLabel(/API 密钥/)).toHaveValue('');
  const response = await page.request.get('/api/settings');
  const saved = await response.json();
  expect(JSON.stringify(saved)).not.toContain('e2e-not-a-real-api-key');
  expect(saved.providers).toHaveLength(1);
  expect(saved.providers[0].model).toBeUndefined();
  expect(saved).toMatchObject({ writingModel: 'e2e-fixture', planningModel: 'e2e-planning', extractionModel: 'e2e-custom-extraction' });
  await modal.getByRole('button', { name: '返回作品', exact: true }).click();
});

test('独立设置页面切换分类保留草稿，保存检查隐藏字段，返回可取消或放弃并保留已保存配置', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  const providerId = 'e2e-settings-navigation';
  try {
    expect((await page.request.put('/api/settings', { data: {
      ...previous,
      providers: [{ id: providerId, name: '设置页面供应商', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }],
      writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-custom-extraction',
      modelParameters: [], promptTemplates: defaultPromptTemplates(),
    } })).ok()).toBeTruthy();
    const before = await (await page.request.get('/api/settings')).json();
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page');
    const providers = settings.getByRole('region', { name: '供应商连接设置', exact: true });
    const models = settings.getByRole('region', { name: '任务模型设置', exact: true });
    const prompts = settings.getByRole('region', { name: '提示词编排设置', exact: true });
    const panel = settings.getByTestId('prompt-templates-panel');
    await expect(settings).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /我的作品/ })).toBeHidden();
    await expect(providers).toBeVisible();
    await expect(models).toBeHidden();
    await expect(prompts).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('settings-page-desktop.png'), animations: 'disabled' });
    await providers.getByLabel('供应商名称', { exact: true }).fill('分类切换保留的供应商草稿');
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    await expect(providers).toBeHidden();
    await expect(models).toBeVisible();
    await expect(prompts).toBeHidden();
    await models.getByLabel('正文写作模型名称', { exact: true }).fill('e2e-draft-writing');
    const writing = models.getByRole('region', { name: '正文写作模型设置', exact: true });
    await writing.getByLabel('单次最大输出 tokens', { exact: true }).fill('');
    await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    await expect(providers).toBeHidden();
    await expect(models).toBeHidden();
    await expect(prompts).toBeVisible();
    await panel.getByLabel('提示词预设名称', { exact: true }).fill('分类切换保留的提示词草稿');
    let saves = 0;
    page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings') saves++; });
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(models).toBeVisible();
    await expect(writing.getByLabel('单次最大输出 tokens', { exact: true })).toHaveValue('');
    await expect(writing.getByLabel('单次最大输出 tokens', { exact: true })).toBeFocused();
    expect(saves).toBe(0);
    expect(await (await page.request.get('/api/settings')).json()).toEqual(before);
    await writing.getByLabel('单次最大输出 tokens', { exact: true }).fill('4096');
    await expect(models.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('e2e-draft-writing');
    await settings.getByRole('button', { name: '供应商连接', exact: true }).click();
    await expect(providers.getByLabel('供应商名称', { exact: true })).toHaveValue('分类切换保留的供应商草稿');
    await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue('分类切换保留的提示词草稿');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    expect(saves).toBe(1);
    const saved = await (await page.request.get('/api/settings')).json();
    expect(saved.providers[0].name).toBe('分类切换保留的供应商草稿');
    expect(saved.writingModel).toBe('e2e-draft-writing');
    expect(saved.promptTemplates.presets.writing[0].name).toBe('分类切换保留的提示词草稿');
    await settings.getByRole('button', { name: '返回作品', exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /我的作品/ })).toBeVisible();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(providers.getByLabel('供应商名称', { exact: true })).toHaveValue('分类切换保留的供应商草稿');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('settings-page-mobile.png'), animations: 'disabled' });
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    await expect(models.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('e2e-draft-writing');
    await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue('分类切换保留的提示词草稿');
    await panel.getByLabel('提示词预设名称', { exact: true }).fill('未保存，取消返回时继续保留');
    const cancelled = page.waitForEvent('dialog');
    const cancelBack = settings.getByRole('button', { name: '返回作品', exact: true }).click();
    const cancelDialog = await cancelled;
    expect(cancelDialog.type()).toBe('confirm');
    expect(cancelDialog.message()).toContain('尚未保存');
    await cancelDialog.dismiss(); await cancelBack;
    await expect(settings).toBeVisible();
    await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue('未保存，取消返回时继续保留');
    const discarded = page.waitForEvent('dialog');
    const discardBack = settings.getByRole('button', { name: '返回作品', exact: true }).click();
    await (await discarded).accept(); await discardBack;
    await expect(settings).toHaveCount(0);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue('分类切换保留的提示词草稿');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('从工作台打开独立设置并返回，保留作者视图、当前章节和未保存正文', async ({ page }) => {
  await createProject(page, 'E2E 设置返回保留工作台');
  await page.getByRole('button', { name: '手动写第一章', exact: true }).click();
  await page.getByLabel('章节标题', { exact: true }).fill('第一章 设置前的章节');
  await page.getByLabel('章节正文', { exact: true }).fill('林舟来到白石城，准备寻找旧钥匙。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await completedJobs(page, 1);
  await tab(page, '正文');
  const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const draft = '林舟来到白石城。\n\nSETTINGS_RETURN_DRAFT：返回设置后仍保留的正文。';
  await page.getByLabel('章节标题', { exact: true }).fill('第一章 尚未保存的标题');
  await page.getByLabel('章节正文', { exact: true }).fill(draft);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByTestId('settings-page');
  await expect(settings).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.workspace-project-title')).toBeHidden();
  await settings.getByRole('button', { name: '任务模型', exact: true }).click();
  await settings.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.locator('.workspace-project-title')).toContainText('E2E 设置返回保留工作台');
  await expect(page.getByRole('button', { name: '返回阅读视图', exact: true })).toBeVisible();
  await expect(page.getByLabel('当前故事线', { exact: true })).toHaveValue(branchId);
  await expect(page.locator('.chapter-list .chapter-item.selected')).toContainText('第一章 设置前的章节');
  await expect(page.getByLabel('章节标题', { exact: true })).toHaveValue('第一章 尚未保存的标题');
  await expect(page.getByLabel('章节正文', { exact: true })).toHaveValue(draft);
  await expect(page.locator('.draft-badge')).toHaveText('未保存');
  await expect(page.getByRole('button', { name: '保存正文', exact: true })).toBeEnabled();
});

test('原创生成保存正文、四章预期规划及隐藏伏笔，阅读接口不返回作者秘密', async ({ page }, testInfo) => {
  const modelBefore = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
  await createProject(page, 'E2E 原创世界');
  await page.getByRole('button', { name: '开始创作', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('章节标题（可选）', { exact: true }).fill('第一章 城门的钥匙');
  await modal.getByLabel('这一次，你想写什么？', { exact: true }).fill('让林舟发现白石城城门下的旧钥匙。');
  await modal.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.locator('.workspace-tabs > button.active')).toContainText('正文');
  await expect(page.locator('.prose')).toContainText('林舟来到白石城');
  await completedJobs(page, 2);
  await tab(page, '正文');
  await page.locator('.chapter-list').getByRole('button', { name: /第一章 城门的钥匙/ }).click();
  await expect(page.locator('.prose')).toContainText('林舟来到白石城');
  await page.screenshot({ path: testInfo.outputPath('desktop-writing.png'), fullPage: true, animations: 'disabled' });
  await tab(page, '剧情与伏笔');
  await expect(page.getByRole('textbox', { name: /粗大纲/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '已发生剧情的摘要', exact: true })).toContainText('林舟');
  await page.getByRole('button', { name: '让 AI 规划', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '开始规划', exact: true }).click();
  await completedJobs(page, 3);
  const modelAfter = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
  for (const model of ['e2e-fixture', 'e2e-planning', 'e2e-custom-extraction']) expect((modelAfter.modelRequestsByModel[model] || 0) - (modelBefore.modelRequestsByModel[model] || 0)).toBeGreaterThan(0);
  await tab(page, '剧情与伏笔');
  await expect(page.getByLabel('规划章节标题', { exact: true })).toHaveCount(4);
  await page.getByRole('button', { name: /^伏笔手记/ }).click();
  await expect(page.getByRole('textbox', { name: '隐藏的真相', exact: true })).toHaveValue(/SECRET_E2E_FORESHADOW/);
  await page.getByLabel('伏笔状态', { exact: true }).selectOption('resolved');
  await page.getByRole('button', { name: '保存伏笔手记', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存伏笔手记', exact: true })).toBeDisabled();
  await expect(page.locator('.foreshadow-card')).toHaveCount(0);
  await page.getByRole('button', { name: '查看已揭晓与已放弃', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '隐藏的真相', exact: true })).toHaveValue(/SECRET_E2E_FORESHADOW/);
  await expect(page.getByLabel('伏笔状态', { exact: true })).toHaveValue('resolved');
  const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
  await page.getByRole('button', { name: '返回阅读视图', exact: true }).click();
  await expect(page.locator('.workspace-tabs').getByRole('button', { name: '剧情与伏笔' })).toHaveCount(0);
  const reader = await page.request.get(`/api/branches/${branchId}`);
  expect(await reader.text()).not.toContain('SECRET_E2E_FORESHADOW');
  const search = await page.request.get(`/api/branches/${branchId}/search?q=SECRET_E2E_FORESHADOW`);
  expect((await search.json()).entities).toEqual([]);
});

test('新章实时显示正文，阅读视图隐藏流，重新生成可放弃后台整理并自动分支', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const originalSettings = await (await page.request.get('/api/settings')).json();
  const providerId = 'e2e-streaming-provider';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '流式与后台验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }],
    writingProviderId: providerId, writingModel: 'e2e-streaming-writing', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-slow-extraction',
  } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 流式重新生成');
    const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('章节标题（可选）', { exact: true }).fill('第一章 流式正文');
    await modal.getByLabel('这一次，你想写什么？', { exact: true }).fill('林舟发现古城的钥匙。');
    await modal.getByRole('button', { name: '开始生成', exact: true }).click();
    await expect(page.locator('.workspace-tabs > button.active')).toContainText('正文');
    await expect(page.getByRole('article', { name: '正在生成的章节' })).toBeVisible();
    await expect(page.locator('.streaming-prose')).toContainText('林舟来到白石城');
    await expect(page.locator('.streaming-prose')).not.toContainText('寻找守城人留下的线索');
    await page.screenshot({ path: testInfo.outputPath('streaming-writing-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '返回阅读视图', exact: true }).click();
    await expect(page.locator('.streaming-manuscript')).toHaveCount(0);
    await expect(page.locator('.prose')).toHaveCount(0);
    await page.getByRole('button', { name: '查看作者资料', exact: true }).click();
    await expect(page.locator('.prose')).toContainText('林舟来到白石城');
    await expect(page.locator('.streaming-manuscript')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '重新生成', exact: true })).toBeEnabled();
    const before = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    expect(before.state.chapters[0].status).toBe('pending');
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect(modal).toContainText('资料还在后台整理');
    await modal.getByRole('button', { name: '等待后台整理', exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(await page.getByLabel('当前故事线', { exact: true }).inputValue()).toBe(branchId);
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    await modal.getByRole('button', { name: '放弃后台任务并重新生成', exact: true }).click();
    await expect(modal).toContainText('自动建立分支');
    await expect(modal.getByLabel('这一次，你想写什么？', { exact: true })).toHaveValue('林舟发现古城的钥匙。');
    await modal.getByLabel('这一次，你想写什么？', { exact: true }).fill('REGEN_BRANCH_ONLY：换一个线索展开这一章。');
    const submitted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === `/api/branches/${branchId}/generate`);
    await modal.getByRole('button', { name: '开始生成', exact: true }).click();
    expect((await submitted).postDataJSON()).toMatchObject({ regenerate: true, discardBackground: true, chapterId: before.state.chapters[0].id, instruction: 'REGEN_BRANCH_ONLY：换一个线索展开这一章。' });
    await expect(page.getByLabel('当前故事线', { exact: true })).not.toHaveValue(branchId);
    await expect(page.locator('.streaming-prose')).toContainText('林舟来到白石城');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('streaming-regeneration-mobile.png'), fullPage: true, animations: 'disabled' });
    const newBranchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('当前故事线', { exact: true }).selectOption(branchId);
    await expect(page.locator('.streaming-manuscript')).toHaveCount(0);
    await expect(page.locator('.prose')).not.toContainText('REGEN_BRANCH_ONLY');
    await page.getByLabel('当前故事线', { exact: true }).selectOption(newBranchId);
    await expect(page.locator('.prose')).toContainText('REGEN_BRANCH_ONLY');
    await expect(page.locator('.streaming-manuscript')).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get(`/api/branches/${newBranchId}?view=author`)).json()).state.chapters[0]?.status).toBe('ready');
    const original = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    expect(original.state.chapters[0].id).toBe(before.state.chapters[0].id);
    expect((await (await page.request.get(`/api/branches/${branchId}/chapters/${before.state.chapters[0].id}`)).json()).text).toContain('寻找守城人留下的线索');
    const projectId = original.branch.projectId;
    const jobs = await (await page.request.get(`/api/jobs?projectId=${projectId}&view=author`)).json();
    expect(jobs.find((job: any) => job.kind === 'extract' && job.branchId === branchId).status).toBe('cancelled');
    expect(jobs.filter((job: any) => job.kind === 'generate' && job.status === 'completed')).toHaveLength(2);
  } finally { await page.request.put('/api/settings', { data: originalSettings }); }
});

test('作者实时查看公开思考与工具过程，默认折叠且正文独立，完成刷新及切视图不泄漏', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const originalSettings = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-activity-provider';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '公开思考与工具验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }], writingProviderId: providerId, writingModel: 'e2e-public-activities', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
  } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 作者生成过程');
    const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
    const base = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    const forked = await page.request.post(`/api/branches/${branchId}/fork`, { data: { baseRevisionId: base.branch.revisionId, name: '没有生成过程的分支' } }); expect(forked.ok()).toBeTruthy(); const emptyBranch = await forked.json();
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    const submitted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/branches/${branchId}/generate`);
    await page.getByRole('dialog').getByLabel('章节标题（可选）', { exact: true }).fill('第一章 过程独立');
    await page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true }).click();
    const writingJob = await (await submitted).json(); const process = page.getByRole('region', { name: '生成过程', exact: true });
    const thinking = process.locator('[data-kind=thinking]');
    await expect(thinking.first()).toBeVisible();
    await expect(thinking.first()).toHaveJSProperty('open', false);
    await expect(thinking.first().locator('.writing-thinking')).not.toBeVisible();
    await expect(page.locator('.prose')).not.toContainText('AUTHOR_PUBLIC_THINK');
    await thinking.first().locator('summary').click();
    await expect(thinking.first().locator('.writing-thinking')).toContainText('AUTHOR_PUBLIC_THINK_1');
    const searchTool = process.locator('[data-kind=tool]').filter({ hasText: 'search_story' });
    const failedTool = process.locator('[data-kind=tool]').filter({ hasText: 'read_entity' });
    await expect(searchTool).toHaveAttribute('data-status', 'completed');
    await expect(failedTool).toHaveAttribute('data-status', 'failed');
    await expect(searchTool).toHaveJSProperty('open', false); await expect(failedTool).toHaveJSProperty('open', false);
    await searchTool.locator('summary').click();
    await expect(searchTool.getByLabel('工具调用参数', { exact: true })).toContainText('林舟');
    await expect(searchTool.getByLabel('工具查询结果', { exact: true })).toContainText('entities');
    await failedTool.locator('summary').click();
    await expect(failedTool.getByRole('alert')).toContainText('没有此资料');
    await page.screenshot({ path: testInfo.outputPath('author-activities-desktop.png'), fullPage: true, animations: 'disabled' });
    await expect(page.locator('.streaming-prose')).toContainText('林舟来到白石城');
    const partialDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '下载当前正文 TXT', exact: true }).click();
    const partial = await readFile((await (await partialDownload).path())!, 'utf8');
    expect(partial).toContain('林舟来到白石城'); expect(partial).not.toContain('AUTHOR_PUBLIC_THINK'); expect(partial).not.toContain('search_story'); expect(partial).not.toContain('ACTIVITY_MISSING_ENTITY');
    await expect(page.locator('.streaming-manuscript')).toHaveCount(0);
    await expect(process.locator('[data-kind=tool]')).toHaveCount(2);
    await expect.poll(async () => (await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).state.chapters[0]?.status).toBe('ready');
    const saved = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json(); const chapterId = saved.state.chapters[0].id;
    const chapter = await (await page.request.get(`/api/branches/${branchId}/chapters/${chapterId}`)).json();
    expect(chapter.text).toBe('林舟来到白石城，循着石碑上的纹路找到一处旧门。\n\n他握住钥匙，推开了门。');
    const persisted = await (await page.request.get(`/api/jobs/${writingJob.id}/activities?view=author`)).json(); expect(persisted.filter((activity: any) => activity.kind === 'tool')).toHaveLength(2);
    expect((await page.request.get(`/api/jobs/${writingJob.id}/activities`)).status()).toBe(403);
    const requestsBeforeReload = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    await page.reload(); await page.getByRole('button', { name: '打开作品 E2E 作者生成过程', exact: true }).click(); await expect(page.locator('.prose')).toContainText('林舟来到白石城'); await expect(process).toHaveCount(0);
    await page.getByRole('button', { name: '查看作者资料', exact: true }).click();
    await expect(process.locator('.writing-activity')).toHaveCount(persisted.length);
    expect(await process.locator('details').evaluateAll(elements => elements.every(element => !(element as HTMLDetailsElement).open))).toBeTruthy();
    await page.setViewportSize({ width: 390, height: 844 });
    await thinking.first().locator('summary').click(); await searchTool.locator('summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('author-activities-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '返回阅读视图', exact: true }).click(); await expect(process).toHaveCount(0); await expect(page.locator('main')).not.toContainText('AUTHOR_PUBLIC_THINK');
    let release!: () => void; let reached!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { reached = resolve; });
    const route = `**/api/jobs/${writingJob.id}/activities?view=author`;
    await page.route(route, async intercepted => { const response = await intercepted.fetch(); reached(); await gate; await intercepted.fulfill({ response }); });
    try {
      await page.getByRole('button', { name: '查看作者资料', exact: true }).click(); await entered;
      await page.getByLabel('当前故事线', { exact: true }).selectOption(emptyBranch.branch.id); await expect(process).toHaveCount(0);
      release(); await expect(page.locator('main')).not.toContainText('AUTHOR_PUBLIC_THINK'); await expect(process).toHaveCount(0);
    } finally { release(); await page.unroute(route); }
    await page.getByLabel('当前故事线', { exact: true }).selectOption(branchId); await expect(process.locator('.writing-activity')).toHaveCount(persisted.length);
    await page.getByRole('button', { name: '新建章节', exact: true }).click(); await expect(process).toHaveCount(0);
    await page.locator('.chapter-list').getByRole('button', { name: /第一章 过程独立/ }).click(); await expect(process.locator('.writing-activity')).toHaveCount(persisted.length);
    await tab(page, '任务'); await page.locator('.job-card').filter({ has: page.getByRole('button', { name: '打开生成章节', exact: true }) }).getByRole('button', { name: '打开生成章节', exact: true }).click();
    await expect(process.locator('.writing-activity')).toHaveCount(persisted.length); await expect(page.locator('.prose')).not.toContainText('AUTHOR_PUBLIC_THINK');
    const requestsAfterReload = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json(); expect(requestsAfterReload.modelRequests).toBe(requestsBeforeReload.modelRequests);
    await page.getByRole('button', { name: '继续创作', exact: true }).click();
    await page.getByRole('dialog').getByLabel('这一次，你想写什么？', { exact: true }).fill('ACTIVITY_HTTP_FAILURE：验收已失败任务的过程记录。');
    await page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true }).click();
    await tab(page, '任务');
    const failedJob = page.locator('.job-card').filter({ has: page.locator('.status-pill.failed') }); await expect(failedJob).toHaveCount(1);
    const requestsBeforeHistory = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    await failedJob.getByRole('button', { name: '查看生成过程与正文', exact: true }).click();
    await expect(process.locator('[data-kind=thinking]')).toHaveCount(1); await expect(process.locator('[data-kind=tool]')).toHaveCount(2);
    await expect(process.locator('[data-kind=tool][data-status=failed]')).toHaveCount(1);
    expect(await process.locator('details').evaluateAll(elements => elements.every(element => !(element as HTMLDetailsElement).open))).toBeTruthy();
    const requestsAfterHistory = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json(); expect(requestsAfterHistory.modelRequests).toBe(requestsBeforeHistory.modelRequests);
    await page.getByRole('button', { name: '返回阅读视图', exact: true }).click(); await expect(process).toHaveCount(0); await expect(page.locator('main')).not.toContainText('AUTHOR_PUBLIC_THINK');
  } finally { await page.request.put('/api/settings', { data: originalSettings }); }
});

test('摘要压缩保留各章原摘要，候选取消不生效，作者确认后保存；主要角色可编辑', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const originalSettings = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-summary-provider';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '摘要确认验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }], writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
  } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 摘要确认'); await importNovel(page);
    const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
    const initial = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    await tab(page, '剧情与伏笔');
    await page.getByRole('button', { name: '生成压缩摘要候选', exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByLabel('压缩摘要', { exact: true })).toHaveValue('林舟调查白石城。');
    await page.screenshot({ path: testInfo.outputPath('summary-confirmation-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('summary-confirmation-mobile.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect((await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).state.outline.summaryCompression).toBeUndefined();
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '查看最近压缩候选', exact: true }).click();
    await modal.getByLabel('压缩摘要', { exact: true }).fill('林舟留在白石城。');
    await modal.getByRole('button', { name: '确认使用压缩摘要', exact: true }).click();
    await expect(modal).toHaveCount(0);
    const confirmed = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    expect(confirmed.state.outline.summaryCompression).toMatchObject({ text: '林舟留在白石城。', chapterIds: initial.state.chapters.map((chapter: any) => chapter.id) });
    expect(confirmed.state.chapters.map((chapter: any) => chapter.summary)).toEqual(initial.state.chapters.map((chapter: any) => chapter.summary));
    await tab(page, '世界资料'); await page.getByRole('button', { name: '编辑 林舟', exact: true }).click();
    await expect(modal.getByLabel('主要角色，写作时始终放入上下文', { exact: true })).toBeChecked();
    await modal.getByLabel('主要角色，写作时始终放入上下文', { exact: true }).uncheck();
    await modal.getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(modal).toHaveCount(0);
    const saved = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    expect(saved.state.entities.find((entity: any) => entity.name === '林舟').isMain).toBe(false);
    const settings = await (await page.request.get('/api/settings')).json();
    expect((await page.request.put('/api/settings', { data: { ...settings, planningModel: 'e2e-noncompact-summary' } })).ok()).toBeTruthy();
    await tab(page, '剧情与伏笔');
    await page.getByRole('button', { name: '生成压缩摘要候选', exact: true }).click();
    await tab(page, '任务');
    const failed = page.locator('.job-card').filter({ has: page.locator('.status-pill.failed') });
    await expect(failed).toHaveCount(1);
    await failed.getByRole('button', { name: '模型输出 / 手工修正', exact: true }).click();
    await expect(modal.getByRole('textbox', { name: '压缩摘要候选', exact: true })).toContainText('林舟');
    await expect(modal.getByRole('textbox', { name: '规划章节标题', exact: true })).toHaveCount(0);
    await modal.getByRole('textbox', { name: '压缩摘要候选', exact: true }).fill('林舟追查城中线索。');
    const requestsBeforeRepair = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    await modal.getByRole('button', { name: '保存并校验应用', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('候选已修复');
    const requestsAfterRepair = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    expect(requestsAfterRepair.modelRequests).toBe(requestsBeforeRepair.modelRequests);
    expect((await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).state.outline.summaryCompression.text).toBe('林舟留在白石城。');
    await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await tab(page, '剧情与伏笔');
    await page.getByRole('button', { name: '查看最近压缩候选', exact: true }).click();
    await expect(modal.getByLabel('压缩摘要', { exact: true })).toHaveValue('林舟追查城中线索。');
    await modal.getByRole('button', { name: '取消', exact: true }).click();
  } finally { await page.request.put('/api/settings', { data: originalSettings }); }
});

test('手动编辑正文后自动整理资料，并保留用户对人物的修正', async ({ page }, testInfo) => {
  await createProject(page, 'E2E 手动创作');
  await page.getByRole('button', { name: '手动写第一章', exact: true }).click();
  await page.getByLabel('章节标题', { exact: true }).fill('第一章 手写');
  await page.getByLabel('章节正文', { exact: true }).fill('林舟来到白石城，看见城门上刻着一行字。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await completedJobs(page, 1);
  await tab(page, '正文');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('章节正文', { exact: true }).fill('林舟来到白石城，看见城门上刻着一行字。\n\n林舟决定留在白石城调查这行字的来历。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await completedJobs(page, 2);
  await tab(page, '世界资料');
  await expect(page.locator('.entity-card').filter({ has: page.getByRole('heading', { name: '林舟', exact: true }) })).toBeVisible();
  await page.getByRole('button', { name: '编辑 林舟', exact: true }).click();
  const modal = page.getByRole('dialog');
  const fullDescription = '用户确认：林舟是一位善于观察的旅人。' + '他会记录旅途中遇到的人、地方和每一条线索。'.repeat(15);
  await modal.getByRole('textbox', { name: '资料描述', exact: true }).fill(fullDescription);
  for (const text of ['他擅长辨认古文字。', '他始终保留旅行手记。', '完整资料末尾：他寻找失踪的老师。']) {
    await modal.getByRole('button', { name: '添加事实', exact: true }).click();
    await modal.getByRole('textbox', { name: /^事实 \d+$/ }).last().fill(text);
  }
  await modal.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.locator('.entity-description')).toContainText(['用户确认：林舟是一位善于观察的旅人。', '故事中出现的城池。']);
  const cards = page.locator('.entity-card');
  expect(await cards.evaluateAll(elements => elements.every(element => Math.abs(element.getBoundingClientRect().height - 350) < 1))).toBeTruthy();
  await page.getByRole('button', { name: '查看 林舟 的详细资料', exact: true }).click();
  await expect(modal).toBeVisible();
  await expect(modal.locator('.entity-description')).toHaveText(fullDescription);
  await expect(modal).toContainText('完整资料末尾：他寻找失踪的老师。');
  await page.screenshot({ path: testInfo.outputPath('desktop-world-detail.png'), fullPage: true, animations: 'disabled' });
  await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('desktop-world.png'), fullPage: true, animations: 'disabled' });
});

test('导入时确认目录，后台整理完成后从资料跳回原文段落', async ({ page }) => {
  await createProject(page, 'E2E 导入小说');
  await importNovel(page);
  await tab(page, '剧情与伏笔');
  await expect(page.locator('.plot-summary-list .plot-summary-card')).toHaveCount(2);
  await page.locator('.plot-summary-card').first().locator('summary').click();
  await expect(page.locator('.plot-summary-card').first().locator('p')).toContainText('林舟');
  await expect(page.locator('.plot-summary-card').last().locator('p')).toContainText('林舟');
  await tab(page, '世界资料');
  const character = page.locator('.entity-card').filter({ has: page.getByRole('heading', { name: '林舟', exact: true }) });
  await character.getByRole('button', { name: /^原文第/ }).first().click();
  await expect(page.locator('.prose .highlighted-paragraph')).toContainText('林舟来到白石城');
  await expect(page.getByRole('heading', { name: '第一章 起点（确认目录）', exact: true })).toBeVisible();
  const projects = await (await page.request.get('/api/projects')).json();
  const project = projects.find((p: { title: string }) => p.title === 'E2E 导入小说');
  const detail = await (await page.request.get(`/api/projects/${project.id}`)).json();
  const original = await page.request.get(`/api/sources/${detail.sources[0].id}/file`);
  expect(await original.text()).toBe(novel);
});

test('从指定章节建立分支，历史回退同时撤回新资料且主线不变', async ({ page }) => {
  await createProject(page, 'E2E 分支世界');
  await importNovel(page);
  await page.getByRole('button', { name: '建立分支', exact: true }).click();
  let modal = page.getByRole('dialog');
  await modal.getByLabel('新故事线名称', { exact: true }).fill('测试修订线');
  await modal.getByRole('combobox', { name: '从哪一章的结尾出发', exact: true }).selectOption({ label: '第一章 起点（确认目录）' });
  await modal.getByRole('button', { name: '建立故事线', exact: true }).click();
  await expect(page.getByLabel('当前故事线', { exact: true })).toHaveValue(/.+/);
  await expect(page.locator('.chapter-list .chapter-item')).toHaveCount(1);
  await tab(page, '剧情与伏笔');
  await expect(page.locator('.plot-summary-list .plot-summary-card')).toHaveCount(1);
  await tab(page, '世界资料');
  await page.getByRole('button', { name: '新增资料', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('名称', { exact: true }).fill('仅存在于修订线的角色');
  await modal.getByRole('textbox', { name: '资料描述', exact: true }).fill('这条资料将在回退时撤销。');
  await modal.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '仅存在于修订线的角色', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '版本历史', exact: true }).click();
  const revision = page.getByRole('dialog').locator('.revision-item').filter({ hasText: '创建故事线：测试修订线' });
  page.once('dialog', dialog => dialog.accept());
  await revision.getByRole('button', { name: '回退', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await tab(page, '世界资料');
  await expect(page.getByRole('heading', { name: '仅存在于修订线的角色', exact: true })).toHaveCount(0);
  await page.getByLabel('当前故事线', { exact: true }).selectOption({ label: '主线' });
  await expect(page.locator('.chapter-list .chapter-item')).toHaveCount(2);
  await tab(page, '剧情与伏笔');
  await expect(page.locator('.plot-summary-list .plot-summary-card')).toHaveCount(2);
});

test('手机尺寸可以创作、打开章节目录和地点关系，页面没有横向溢出', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createProject(page, 'E2E 手机世界');
  await page.getByRole('button', { name: '手动写第一章', exact: true }).click();
  await page.getByLabel('章节标题', { exact: true }).fill('第一章 手机写作');
  await page.getByLabel('章节正文', { exact: true }).fill('林舟来到白石城，抬头看见晴朗的天空。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await completedJobs(page, 1);
  await tab(page, '正文');
  await expect(page.getByRole('button', { name: '打开章节目录', exact: true }).locator('svg')).toBeVisible();
  await page.getByRole('button', { name: '打开章节目录', exact: true }).click();
  await expect(page.locator('.chapter-sidebar')).toHaveClass(/mobile-open/);
  await page.locator('.chapter-list').getByRole('button', { name: /第一章 手机写作/ }).click();
  await expect(page.locator('.chapter-sidebar')).not.toHaveClass(/mobile-open/);
  await expect(page.locator('.prose')).toContainText('林舟来到白石城');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('mobile-reading.png'), fullPage: true, animations: 'disabled' });
  await tab(page, '地点关系');
  const map = page.getByRole('img', { name: '世界地理地点关系图', exact: true });
  await expect(map).toBeVisible();
  await expect(map).toContainText('白石城');
  await expect(map).not.toContainText('林舟');
  await expect(map.locator('[data-location-id]')).toHaveCount(1);
  await expect(page.locator('.character-locations')).toContainText('林舟正在白石城调查。');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('mobile-map.png'), fullPage: true, animations: 'disabled' });
});

test('其他设备更新版本后保留编辑草稿，冲突保存不会覆盖并可下载草稿', async ({ page }) => {
  await createProject(page, 'E2E 草稿冲突');
  await page.getByRole('button', { name: '手动写第一章', exact: true }).click();
  await page.getByLabel('章节标题', { exact: true }).fill('第一章 多设备');
  await page.getByLabel('章节正文', { exact: true }).fill('林舟来到白石城，记录第一天的见闻。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await completedJobs(page, 1);
  await tab(page, '正文');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const draft = '林舟来到白石城。\n\nDRAFT_CONFLICT：这份尚未保存的草稿必须保留。';
  await page.getByLabel('章节正文', { exact: true }).fill(draft);
  const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
  const view = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
  const changed = await page.request.put(`/api/branches/${branchId}/outline`, { data: { baseRevisionId: view.branch.revisionId, outline: { ...view.state.outline, worldview: '另一台设备刚刚保存的世界观。' } } });
  expect(changed.ok()).toBeTruthy();
  // Observe one actual polling round instead of relying on an arbitrary sleep.
  await page.waitForResponse(response => response.url().includes('/api/jobs?projectId='));
  await expect(page.getByLabel('章节正文', { exact: true })).toHaveValue(draft);
  const conflict = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/branches/${branchId}/chapters`));
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(page.getByLabel('章节正文', { exact: true })).toHaveValue(draft);
  await expect(page.getByRole('alert')).toContainText('新版本');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载草稿 TXT', exact: true }).click();
  const download = await downloaded;
  expect(await readFile((await download.path())!, 'utf8')).toContain(draft);
});

test('章节请求延迟返回时，切换到空故事线不会混入原故事线正文', async ({ page }) => {
  await createProject(page, 'E2E 请求归属');
  const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
  const initial = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
  const fork = await page.request.post(`/api/branches/${branchId}/fork`, { data: { baseRevisionId: initial.branch.revisionId, name: '尚无正文的分支' } });
  expect(fork.ok()).toBeTruthy();
  await page.getByRole('button', { name: '手动写第一章', exact: true }).click();
  await page.getByLabel('章节标题', { exact: true }).fill('第一章 旧响应');
  await page.getByLabel('章节正文', { exact: true }).fill('林舟来到白石城。这是主线独有的正文。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await completedJobs(page, 1);
  await tab(page, '正文');
  const latest = await (await page.request.get(`/api/branches/${branchId}`)).json();
  const chapterId = latest.state.chapters[0].id;
  let release!: () => void; let reached!: () => void; let fulfilled!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const delivered = new Promise<void>(resolve => { fulfilled = resolve; });
  const route = `**/api/branches/${branchId}/chapters/${chapterId}`;
  await page.route(route, async intercepted => {
    const response = await intercepted.fetch(); reached(); await gate;
    await intercepted.fulfill({ response }); fulfilled();
  });
  try {
    await page.locator('.chapter-list').getByRole('button', { name: /第一章 旧响应/ }).click();
    await entered;
    await page.getByLabel('当前故事线', { exact: true }).selectOption({ label: '尚无正文的分支' });
    await expect(page.locator('.chapter-list .chapter-item')).toHaveCount(0);
    release(); await delivered;
    await expect(page.locator('.prose')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '故事，在下一笔开始', exact: true })).toBeVisible();
  } finally { release(); await page.unroute(route); }
});

test('任务操作回归：上游 HTTP500 后可重试、取消并退出登录，正文保留', async ({ page }) => {
  // Self-contained setup also allows running this case alone with --grep.
  const authentication = await (await page.request.get('/api/auth/status')).json();
  if (!authentication.initialized) {
    const setup = await page.request.post('/api/auth/setup', { data: { password } });
    expect(setup.ok()).toBeTruthy();
  } else if (!authentication.authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  }
  const providerId = 'e2e-http500-provider';
  const configured = await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '本地故障模拟', protocol: 'openai-chat', baseUrl: mockUrl, model: 'e2e-http500', apiKey: '', maxOutputTokens: 4096, contextTokens: 64000 }],
    writingProviderId: providerId, planningProviderId: providerId, extractionProviderId: providerId,
  } });
  expect(configured.ok()).toBeTruthy();
  const created = await page.request.post('/api/projects', { data: { title: 'E2E 失败任务操作', mode: 'original', premise: '' } });
  expect(created.ok()).toBeTruthy();
  const project = await created.json();
  await page.goto('/');
  await page.locator('.project-card').filter({ has: page.getByRole('heading', { name: project.title, exact: true }) }).click();
  await page.getByRole('button', { name: '查看作者资料', exact: true }).click();
  await page.getByRole('button', { name: '导入小说', exact: true }).click();
  const modal = page.getByRole('dialog');
  const original = '第一章 故障中的正文\n林舟来到白石城。这段原文在重试和取消后仍应保留。';
  await modal.locator('input[type=file]').setInputFiles({ name: 'failure-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from(original, 'utf8') });
  await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('第一章 故障中的正文');
  const confirmed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/confirm'));
  await modal.getByRole('button', { name: '确认目录并整理', exact: true }).click();
  const job = await (await confirmed).json();
  const card = page.locator('.job-card');
  await expect(card.locator('.status-pill.failed')).toBeVisible();
  await expect(card.locator('.notice.error')).toContainText('HTTP 500');

  const retryResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/jobs/${job.id}/retry`);
  await card.getByRole('button', { name: '重试', exact: true }).click();
  expect((await retryResponse).status()).toBe(200);
  await expect.poll(async () => {
    const jobs = await (await page.request.get(`/api/jobs?projectId=${project.id}&view=author`)).json();
    return jobs.find((current: { id: string }) => current.id === job.id)?.status;
  }).toBe('failed');
  await expect(card.locator('.status-pill.failed')).toBeVisible();

  const cancelResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/jobs/${job.id}/cancel`);
  await card.getByRole('button', { name: '取消任务', exact: true }).click();
  expect((await cancelResponse).status()).toBe(200);
  await expect(card.locator('.status-pill.cancelled')).toHaveText('已取消');
  await expect(card.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  await tab(page, '正文');
  await page.locator('.chapter-list').getByRole('button', { name: /第一章 故障中的正文/ }).click();
  await expect(page.locator('.prose')).toContainText('这段原文在重试和取消后仍应保留');
  const detail = await (await page.request.get(`/api/projects/${project.id}`)).json();
  expect(await (await page.request.get(`/api/sources/${detail.sources[0].id}/file`)).text()).toBe(original);

  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  const logoutResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/auth/logout');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  expect((await logoutResponse).status()).toBe(200);
  await expect(page.getByRole('heading', { name: '欢迎回到故事里。', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/auth/status')).json()).authenticated).toBe(false);
});

test('模型输出修复：保留错误引文及原响应，手工修改后完成整理而不再次调用模型', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const providerId = 'e2e-repair-provider';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '本地引用修复模拟', protocol: 'openai-chat', baseUrl: mockUrl, model: 'e2e-quote-mismatch', apiKey: '', maxOutputTokens: 4096, contextTokens: 64000 }],
    writingProviderId: providerId, planningProviderId: providerId, extractionProviderId: providerId,
  } })).ok()).toBeTruthy();
  await createProject(page, 'E2E 手工修正模型输出');
  await page.getByRole('button', { name: '导入小说', exact: true }).click();
  const original = '“回来了。”林舟走进白石城。';
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'citation-repair.txt', mimeType: 'text/plain', buffer: Buffer.from(`第一章 归来\n${original}`) });
  const confirmResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/confirm'));
  await page.getByRole('dialog').getByRole('button', { name: '确认目录并整理', exact: true }).click();
  const job = await (await confirmResponse).json();
  await expect(page.locator('.job-card .status-pill.failed')).toBeVisible();
  const outputs = await (await page.request.get(`/api/jobs/${job.id}/outputs?view=author`)).json();
  expect(outputs).toHaveLength(1);
  expect((await page.request.get(`/api/jobs/${job.id}/outputs`)).status()).toBe(403);
  const before = await (await page.request.get(mockUrl.replace('/v1', '') + '/__e2e/stats')).json();
  await page.getByRole('button', { name: /模型输出.*手工修正/ }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByLabel('事实内容', { exact: true })).toBeVisible();
  await expect(modal).toContainText('不需要编辑代码');
  await expect(modal.getByRole('region', { name: '具体校验问题' })).toContainText(original);
  await modal.getByRole('region', { name: '具体校验问题' }).getByRole('button', { name: '去修改', exact: true }).first().click();
  await expect(modal.getByLabel('引用原文（可留空）', { exact: true })).toBeFocused();
  await modal.getByRole('button', { name: '高级 JSON', exact: true }).click();
  const editor = modal.getByLabel('修正后的文本 / JSON', { exact: true });
  const unchanged = await editor.inputValue();
  // A failed correction is itself durable; it must not destroy the original capture.
  await editor.fill('{broken json');
  await modal.getByRole('button', { name: '保存并校验应用', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('未通过');
  const invalid = await (await page.request.get(`/api/jobs/${job.id}/outputs/${outputs[0].id}?view=author`)).json();
  expect(invalid.output.editedText).toBe('{broken json'); expect(invalid.output.rawResponse).toContain('choices');
  await modal.getByRole('button', { name: '可视化修正', exact: true }).click();
  await expect(modal).toContainText('无法显示');
  await modal.getByRole('button', { name: '高级 JSON', exact: true }).click();
  const restored = JSON.parse(unchanged); restored.authorNote = '表单修改不能丢掉其他字段';
  await editor.fill(JSON.stringify(restored, null, 2));
  await modal.getByRole('button', { name: '可视化修正', exact: true }).click();
  await modal.getByLabel('事实内容', { exact: true }).fill('林舟回到白石城');
  const citation = modal.locator('.visual-citation-picker').first();
  await citation.getByLabel('引用段落', { exact: true }).selectOption('1');
  await citation.getByRole('button', { name: '使用整段原文', exact: true }).click();
  await expect(citation.getByLabel('引用原文（可留空）', { exact: true })).toHaveValue(original);
  const chosenQuote = '林舟走进白石城。';
  const source = citation.getByRole('textbox', { name: '第 1 段原文（只读，可选中文字）', exact: true });
  await source.scrollIntoViewIfNeeded();
  const selectionPoints = await source.evaluate((element, text) => {
    const input = element as HTMLTextAreaElement; const rect = input.getBoundingClientRect(); const style = getComputedStyle(input);
    const context = document.createElement('canvas').getContext('2d')!; context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const left = rect.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
    const top = rect.top + parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth) + parseFloat(style.lineHeight) / 2;
    return { start: left + context.measureText(input.value.slice(0, input.value.indexOf(text))).width, end: left + context.measureText(input.value).width + 1, top };
  }, chosenQuote);
  await page.mouse.move(selectionPoints.start, selectionPoints.top); await page.mouse.down();
  await page.mouse.move(selectionPoints.end, selectionPoints.top, { steps: 10 }); await page.mouse.up();
  expect(await source.evaluate(element => { const input = element as HTMLTextAreaElement; return input.value.slice(input.selectionStart, input.selectionEnd); })).toBe(chosenQuote);
  await citation.getByRole('button', { name: '使用选中文字', exact: true }).click();
  await expect(citation.getByLabel('引用原文（可留空）', { exact: true })).toHaveValue(chosenQuote);
  await citation.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('visual-output-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await citation.scrollIntoViewIfNeeded();
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('visual-output-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await modal.getByRole('button', { name: '保存并校验应用', exact: true }).click();
  await expect(modal.getByRole('status').filter({ hasText: '任务已完成' })).toBeVisible();
  await expect(modal.getByRole('button', { name: '保存并校验应用', exact: true })).toBeDisabled();
  const after = await (await page.request.get(mockUrl.replace('/v1', '') + '/__e2e/stats')).json();
  expect(after.modelRequests).toBe(before.modelRequests);
  const stored = await (await page.request.get(`/api/jobs/${job.id}/outputs/${outputs[0].id}?view=author`)).json();
  expect(stored.output.rawResponse).toBe(invalid.output.rawResponse); expect(stored.output.status).toBe('applied');
  expect(JSON.parse(stored.output.editedText).authorNote).toBe('表单修改不能丢掉其他字段');
  expect(JSON.parse(stored.output.editedText).entities[0].facts[0].quote).toBe(chosenQuote);
  await page.screenshot({ path: testInfo.outputPath('model-output-repaired.png'), fullPage: true, animations: 'disabled' });
  await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(page.locator('.job-card .status-pill.completed')).toBeVisible();
  await tab(page, '世界资料');
  await expect(page.getByRole('heading', { name: '林舟', exact: true })).toBeVisible();
});

test('简化提取：只返回段落编号与必要字段，单次响应即可完成且保留本地整理说明', async ({ page }) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const providerId = 'e2e-compact-provider';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '简化提取模拟', protocol: 'openai-chat', baseUrl: mockUrl, model: 'e2e-compact-extraction', apiKey: '', maxOutputTokens: 4096, contextTokens: 64000 }],
    writingProviderId: providerId, planningProviderId: providerId, extractionProviderId: providerId,
  } })).ok()).toBeTruthy();
  await createProject(page, 'E2E 段落证据回填');
  const before = await (await page.request.get(mockUrl.replace('/v1', '') + '/__e2e/stats')).json();
  await page.getByRole('button', { name: '导入小说', exact: true }).click();
  const original = '“回来了。”林舟走进白石城。';
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'compact-extraction.txt', mimeType: 'text/plain', buffer: Buffer.from(`第一章 归来\n${original}`) });
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/confirm'));
  await page.getByRole('dialog').getByRole('button', { name: '确认目录并整理', exact: true }).click();
  const job = await (await response).json();
  await expect(page.locator('.job-card .status-pill.completed')).toBeVisible();
  const after = await (await page.request.get(mockUrl.replace('/v1', '') + '/__e2e/stats')).json();
  expect(after.modelRequests - before.modelRequests).toBe(1);
  const outputs = await (await page.request.get(`/api/jobs/${job.id}/outputs?view=author`)).json();
  expect(outputs).toHaveLength(1); expect(outputs[0].normalizedText).toBeUndefined();
  const { output } = await (await page.request.get(`/api/jobs/${job.id}/outputs/${outputs[0].id}?view=author`)).json();
  expect(JSON.parse(output.text).entities[0].facts[0].quote).toBeUndefined();
  expect(JSON.parse(output.normalizedText).entities[0].facts[0].quote).toBe(original);
  expect(output.adjustments.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: /模型输出.*手工修正/ }).click();
  const modal = page.getByRole('dialog');
  await expect(modal).toContainText('系统已整理');
  await expect(modal.getByRole('button', { name: '保存并校验应用', exact: true })).toBeDisabled();
});

test('模型参数与诊断：保留零值、协议专属思考设置，流式连接成功及 HTTP500 均可核对当次请求', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const providerId = 'e2e-parameters';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '参数诊断模拟', protocol: 'openai-chat', baseUrl: mockUrl, model: 'e2e-fixture', apiKey: 'e2e-private-parameter-key', maxOutputTokens: 8192, contextTokens: 64000 }],
    writingProviderId: providerId, planningProviderId: providerId, extractionProviderId: providerId,
  } })).ok()).toBeTruthy();
  await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
  const modal = page.getByTestId('settings-page');
  await modal.getByRole('button', { name: '任务模型', exact: true }).click();
  const writing = modal.getByRole('region', { name: '正文写作模型设置', exact: true });
  await writing.locator('summary').filter({ hasText: '生成参数与思考设置' }).click();
  await writing.getByLabel(/^温度（temperature）/).fill('0'); await writing.getByLabel(/^Top P/).fill('0.8');
  await writing.getByLabel(/^随机种子（seed）/).fill('0'); await writing.getByLabel(/^请求超时（秒）/).fill('240');
  await writing.getByLabel(/^返回方式/).selectOption('true');
  await modal.getByRole('button', { name: '供应商连接', exact: true }).click();
  await modal.getByLabel('接口协议', { exact: true }).selectOption('gemini');
  await expect(modal.getByLabel('服务地址', { exact: true })).toHaveValue(mockUrl);
  await modal.getByRole('button', { name: '任务模型', exact: true }).click();
  await writing.getByLabel(/^Gemini 思考方式/).selectOption('level'); await writing.getByLabel(/^Gemini 思考等级/).selectOption('low');
  await writing.getByLabel('Gemini 返回思考摘要', { exact: true }).selectOption('true');
  await modal.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(modal.getByRole('status')).toContainText('设置已保存');
  const geminiSaved = await (await page.request.get('/api/settings')).json();
  expect(geminiSaved.modelParameters.find((value: any) => value.role === 'writing' && value.providerId === providerId && value.model === 'e2e-fixture')).toMatchObject({ temperature: 0, seed: 0, stream: true, timeoutMs: 240000, geminiThinking: { mode: 'level', level: 'low' }, geminiIncludeThoughts: true });
  expect(geminiSaved.providers[0]).not.toHaveProperty('temperature');
  await modal.getByRole('button', { name: '供应商连接', exact: true }).click();
  await modal.getByLabel('接口协议', { exact: true }).selectOption('openai-chat');
  await modal.getByRole('button', { name: '任务模型', exact: true }).click();
  await writing.getByLabel(/^思考等级（OpenAI）/).selectOption('low');
  await writing.getByLabel(/^输出上限字段（Chat）/).selectOption('max_completion_tokens');
  const tested = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/settings/test');
  await modal.getByRole('button', { name: '正文写作保存并测试连接', exact: true }).click();
  const success = await (await tested).json(); expect(success.ok).toBe(true);
  await expect(modal.getByRole('status')).toContainText('有效文字');
  const wire = JSON.parse(success.capture.request.body);
  expect(wire).toMatchObject({ stream: true, temperature: 0, top_p: 0.8, seed: 0, reasoning_effort: 'low', max_completion_tokens: 8192 });
  expect(wire.max_tokens).toBeUndefined(); expect(wire.thinkingConfig).toBeUndefined(); expect(success.capture.request.headers.Authorization).toBe('[REDACTED]');
  await modal.locator('summary').filter({ hasText: '实际请求与连接诊断' }).click();
  await modal.locator('summary').filter({ hasText: '实际请求体（含提示词）' }).click();
  await expect(modal.getByLabel('实际请求体', { exact: true })).toContainText('max_completion_tokens');
  await expect(modal.locator('.request-diagnostics')).toContainText('8,192 tokens');
  await expect(modal.getByLabel('模型响应反馈', { exact: true })).toContainText('已返回正文');
  await expect(modal.getByLabel('模型响应反馈', { exact: true })).toContainText('stop');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  await writing.getByLabel(/^温度（temperature）/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('model-parameters-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await modal.getByLabel('正文写作模型名称', { exact: true }).fill('e2e-http500');
  await modal.getByRole('button', { name: '正文写作保存并测试连接', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('500');
  await modal.locator('summary').filter({ hasText: '实际请求与连接诊断' }).click();
  await expect(modal.locator('.request-diagnostics')).toContainText('HTTP 500');
  await expect(modal.locator('.request-diagnostics')).toContainText('e2e-http500');
  await expect(modal.locator('.request-diagnostics')).toContainText('需要核对网关保存的出站响应');
  await modal.locator('summary').filter({ hasText: '本次测试原始响应（只读）' }).click();
  await expect(modal.getByLabel('本次测试原始响应', { exact: true })).toContainText('Deliberate local HTTP 500 fixture');
  await expect(modal).not.toContainText('e2e-private-parameter-key');
  await modal.locator('.request-diagnostics .transport-metadata').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('model-request-error.png'), animations: 'disabled' });
  await modal.getByRole('button', { name: '供应商连接', exact: true }).click();
  await modal.getByLabel('接口协议', { exact: true }).selectOption('gemini');
  await modal.getByRole('button', { name: '任务模型', exact: true }).click();
  await modal.getByLabel('正文写作模型名称', { exact: true }).fill('e2e-fixture');
  await expect(writing.getByLabel('Gemini 返回思考摘要', { exact: true })).toHaveValue('true');
  await modal.getByLabel('正文写作模型名称', { exact: true }).fill('e2e-gemini-blocked');
  await openModelParameters(writing);
  await writing.getByLabel(/^返回方式/).selectOption('true');
  await writing.getByLabel(/^Gemini 思考方式/).selectOption('level');
  await writing.getByLabel(/^Gemini 思考等级/).selectOption('low');
  await writing.getByLabel('Gemini 返回思考摘要', { exact: true }).selectOption('true');
  const blockResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/settings/test');
  await modal.getByRole('button', { name: '正文写作保存并测试连接', exact: true }).click();
  const blocked = await (await blockResponse).json();
  expect(blocked.ok).toBe(false); expect(blocked.capture.httpStatus).toBe(200);
  expect(JSON.parse(blocked.capture.request.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low', includeThoughts: true });
  await expect(modal.getByRole('alert')).toContainText('拦截');
  await modal.locator('summary').filter({ hasText: '实际请求与连接诊断' }).click();
  await expect(modal.getByLabel('模型响应反馈', { exact: true })).toContainText('输入拦截原因');
  await expect(modal.getByLabel('模型响应反馈', { exact: true })).toContainText('SAFETY');
  await expect(modal).not.toContainText('e2e-private-parameter-key');
  await modal.getByLabel('模型响应反馈', { exact: true }).scrollIntoViewIfNeeded();
  await expect(modal.getByLabel('模型响应反馈', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('model-block-feedback.png'), animations: 'disabled' });
});

test('模型列表失败仍可自定义，刷新后保留自定义名并使用任务模型测试', async ({ page }) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const providerId = 'e2e-model-list-error';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '目录故障模拟', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '', maxOutputTokens: 4096, contextTokens: 64000 }],
    writingProviderId: providerId, writingModel: 'before-custom', planningProviderId: '', extractionProviderId: '',
  } })).ok()).toBeTruthy();
  const route = '**/api/settings/models';
  await page.route(route, intercepted => intercepted.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '供应商模型目录暂不可用' }) }));
  await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
  const modal = page.getByTestId('settings-page');
  await modal.getByRole('button', { name: '任务模型', exact: true }).click();
  await expect(modal.locator('.model-list-error')).toContainText('供应商模型目录暂不可用');
  await expect(modal.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('before-custom');
  await modal.getByLabel('正文写作模型名称', { exact: true }).fill('e2e-private-custom-model');
  // Looking up a draft connection must not silently persist a task or provider edit.
  expect((await (await page.request.get('/api/settings')).json()).writingModel).toBe('before-custom');
  await page.unroute(route);
  await modal.getByRole('button', { name: '正文写作刷新模型列表', exact: true }).click();
  await expect(modal.getByRole('combobox', { name: '正文写作上游模型', exact: true })).toBeEnabled();
  await expect(modal.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('e2e-private-custom-model');
  const tested = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/settings/test');
  await modal.getByRole('button', { name: '正文写作保存并测试连接', exact: true }).click();
  const result = await (await tested).json(); expect(result.ok).toBe(true);
  expect(JSON.parse(result.capture.request.body).model).toBe('e2e-private-custom-model');
  const saved = await (await page.request.get('/api/settings')).json();
  expect(saved).toMatchObject({ writingModel: 'e2e-private-custom-model', planningProviderId: '', planningModel: '', extractionProviderId: '', extractionModel: '' });
});

test('切换供应商清空任务模型，迟到的列表和改地址前的列表不会混入新连接', async ({ page }) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const oldId = 'e2e-list-old'; const newId = 'e2e-list-new';
  expect((await page.request.put('/api/settings', { data: {
    providers: [oldId, newId].map((id, index) => ({ id, name: index ? '新供应商' : '旧供应商', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '', maxOutputTokens: 4096, contextTokens: 64000 })),
    writingProviderId: oldId, writingModel: 'old-selected-model', planningProviderId: '', extractionProviderId: '',
  } })).ok()).toBeTruthy();
  let release!: () => void; let reached!: () => void; let fulfilled!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const delivered = new Promise<void>(resolve => { fulfilled = resolve; });
  const route = '**/api/settings/models';
  await page.route(route, async intercepted => {
    const provider = intercepted.request().postDataJSON().provider;
    if (provider.id === oldId) {
      reached(); await gate;
      try { await intercepted.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [{ id: 'stale-old-model' }] }) }); } finally { fulfilled(); }
    } else {
      const id = provider.baseUrl.endsWith('/changed') ? 'changed-address-model' : 'new-provider-model';
      await intercepted.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [{ id }] }) });
    }
  });
  try {
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const modal = page.getByTestId('settings-page');
    await modal.getByRole('button', { name: '任务模型', exact: true }).click();
    await entered;
    await modal.getByRole('combobox', { name: '正文写作供应商', exact: true }).selectOption(newId);
    await expect(modal.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('');
    const models = modal.getByRole('combobox', { name: '正文写作上游模型', exact: true });
    await expect(models).toBeEnabled();
    await models.selectOption('new-provider-model');
    release(); await delivered;
    await expect(models.locator('option')).toHaveText(['选择上游模型', 'new-provider-model']);
    await expect(modal.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('new-provider-model');
    await modal.getByRole('button', { name: '供应商连接', exact: true }).click();
    await modal.getByLabel('服务地址', { exact: true }).nth(1).fill(mockUrl + '/changed');
    await modal.getByRole('button', { name: '任务模型', exact: true }).click();
    await expect(models.locator('option')).toHaveText(['选择上游模型', 'changed-address-model']);
    await modal.getByLabel('正文写作模型名称', { exact: true }).fill('changed-custom-model');
    await modal.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('设置已保存');
    const saved = await (await page.request.get('/api/settings')).json();
    expect(saved).toMatchObject({ writingProviderId: newId, writingModel: 'changed-custom-model' });
  } finally { release(); await page.unroute(route); }
});

test('三任务使用同一模型时参数互不影响，切换恢复且清空与重置均独立持久化', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const providerId = 'e2e-model-defaults'; const otherId = 'e2e-model-defaults-other';
  expect((await page.request.put('/api/settings', { data: {
    providers: [providerId, otherId].map((id, index) => ({ id, name: index ? '另一个供应商' : '模型参数模拟', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' })),
    writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-fixture', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
  } })).ok()).toBeTruthy();
  await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
  let modal = page.getByTestId('settings-page');
  await modal.getByRole('button', { name: '任务模型', exact: true }).click();
  const writing = modal.getByRole('region', { name: '正文写作模型设置', exact: true });
  const planning = modal.getByRole('region', { name: '剧情规划模型设置', exact: true });
  const extraction = modal.getByRole('region', { name: '资料提取模型设置', exact: true });
  await expect(modal.locator('.provider-card .provider-parameters')).toHaveCount(0);
  for (const role of [writing, planning, extraction]) await role.locator('summary').filter({ hasText: '生成参数与思考设置' }).click();
  await expect(writing.getByLabel('单次最大输出 tokens', { exact: true })).toHaveValue('4096');
  await expect(writing.getByLabel('上下文上限 tokens', { exact: true })).toHaveValue('64000');
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await expect(writing.getByLabel(/^Top P/)).toHaveValue('1');
  await expect(writing.getByLabel(/^存在惩罚/)).toHaveValue('0');
  await expect(writing.getByLabel(/^请求超时（秒）/)).toHaveValue('180');
  await expect(writing.getByLabel(/^返回方式/)).toHaveValue('false');
  await writing.getByLabel(/^温度（temperature）/).fill('0.6');
  await writing.getByLabel('单次最大输出 tokens', { exact: true }).fill('8192');
  await expect(planning.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await expect(planning.getByLabel('单次最大输出 tokens', { exact: true })).toHaveValue('4096');
  await expect(extraction.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await planning.getByLabel(/^温度（temperature）/).fill('0.3');
  await planning.getByLabel('单次最大输出 tokens', { exact: true }).fill('2048');
  await planning.getByLabel(/^思考等级（OpenAI）/).selectOption('low');
  await expect(extraction.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await expect(extraction.getByLabel(/^思考等级（OpenAI）/)).toHaveValue('');
  await extraction.getByLabel(/^温度（temperature）/).fill('0.2');
  await extraction.getByLabel('单次最大输出 tokens', { exact: true }).fill('16384');
  await extraction.getByLabel(/^思考等级（OpenAI）/).selectOption('high');
  await expect(planning.getByLabel(/^温度（temperature）/)).toHaveValue('0.3');
  await expect(planning.getByLabel(/^思考等级（OpenAI）/)).toHaveValue('low');
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('0.6');
  await writing.getByLabel('正文写作模型名称', { exact: true }).fill('custom-new-model');
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await expect(writing.getByLabel('单次最大输出 tokens', { exact: true })).toHaveValue('4096');
  await openModelParameters(writing);
  await writing.getByLabel(/^温度（temperature）/).fill('0.2');
  await writing.getByLabel('正文写作模型名称', { exact: true }).fill('e2e-fixture');
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('0.6');
  await writing.getByLabel('正文写作供应商', { exact: true }).selectOption(otherId);
  await writing.getByLabel('正文写作模型名称', { exact: true }).fill('e2e-fixture');
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await writing.getByLabel('正文写作供应商', { exact: true }).selectOption(providerId);
  await writing.getByLabel('正文写作模型名称', { exact: true }).fill('e2e-fixture');
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('0.6');
  await openModelParameters(writing);
  await writing.getByLabel(/^Top P/).fill('');
  await modal.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(modal.getByRole('status')).toContainText('设置已保存');
  let saved = await (await page.request.get('/api/settings')).json();
  const profile = saved.modelParameters.find((value: any) => value.role === 'writing' && value.providerId === providerId && value.model === 'e2e-fixture');
  expect(profile).toMatchObject({ temperature: 0.6, maxOutputTokens: 8192 }); expect(profile).not.toHaveProperty('topP');
  expect(saved.modelParameters.find((value: any) => value.role === 'writing' && value.providerId === providerId && value.model === 'custom-new-model').temperature).toBe(0.2);
  expect(saved.modelParameters.find((value: any) => value.role === 'planning' && value.model === 'e2e-fixture')).toMatchObject({ temperature: 0.3, maxOutputTokens: 2048, reasoningEffort: 'low' });
  expect(saved.modelParameters.find((value: any) => value.role === 'extraction' && value.model === 'e2e-fixture')).toMatchObject({ temperature: 0.2, maxOutputTokens: 16384, reasoningEffort: 'high' });
  const tested = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/settings/test');
  await writing.getByRole('button', { name: '正文写作保存并测试连接', exact: true }).click();
  const result = await (await tested).json();
  expect((await tested).request().postDataJSON().role).toBe('writing');
  expect(JSON.parse(result.capture.request.body)).toMatchObject({ model: 'e2e-fixture', temperature: 0.6, max_tokens: 8192 });
  expect(JSON.parse(result.capture.request.body)).not.toHaveProperty('top_p');
  await modal.getByRole('button', { name: '返回作品', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  modal = page.getByTestId('settings-page');
  await modal.getByRole('button', { name: '任务模型', exact: true }).click();
  await writing.locator('summary').filter({ hasText: '生成参数与思考设置' }).click();
  await expect(writing.getByLabel(/^Top P/)).toHaveValue('');
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('0.6');
  await expect(planning.getByLabel(/^温度（temperature）/)).toHaveValue('0.3');
  await expect(extraction.getByLabel(/^温度（temperature）/)).toHaveValue('0.2');
  for (const [task, role, temperature, maxTokens, effort] of [[planning, 'planning', 0.3, 2048, 'low'], [extraction, 'extraction', 0.2, 16384, 'high']] as const) {
    const testing = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/settings/test');
    await task.getByRole('button', { name: role === 'planning' ? '剧情规划保存并测试连接' : '资料提取保存并测试连接', exact: true }).click();
    const response = await testing; const captured = await response.json();
    expect(response.request().postDataJSON().role).toBe(role);
    expect(captured.ok).toBe(true);
    expect(JSON.parse(captured.capture.request.body)).toMatchObject({ model: 'e2e-fixture', temperature, max_tokens: maxTokens, reasoning_effort: effort });
  }
  await planning.getByRole('button', { name: '恢复通用默认值', exact: true }).click();
  await expect(planning.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await expect(planning.getByLabel(/^思考等级（OpenAI）/)).toHaveValue('');
  await expect(extraction.getByLabel(/^温度（temperature）/)).toHaveValue('0.2');
  await expect(extraction.getByLabel(/^思考等级（OpenAI）/)).toHaveValue('high');
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('0.6');
  await page.setViewportSize({ width: 390, height: 844 });
  await writing.getByLabel(/^温度（temperature）/).scrollIntoViewIfNeeded();
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('per-model-defaults-mobile.png'), animations: 'disabled' });
  await writing.getByRole('button', { name: '恢复通用默认值', exact: true }).click();
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await expect(writing.getByLabel(/^Top P/)).toHaveValue('1');
  await expect(writing.getByLabel('单次最大输出 tokens', { exact: true })).toHaveValue('4096');
  await modal.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(modal.getByRole('status')).toContainText('设置已保存');
  saved = await (await page.request.get('/api/settings')).json();
  expect(saved.modelParameters.find((value: any) => value.role === 'writing' && value.providerId === providerId && value.model === 'e2e-fixture')).toMatchObject({ temperature: 1, topP: 1, maxOutputTokens: 4096, timeoutMs: 180000, stream: false });
  expect(saved.modelParameters.find((value: any) => value.role === 'planning' && value.providerId === providerId && value.model === 'e2e-fixture')).toMatchObject({ temperature: 1, maxOutputTokens: 4096 });
  expect(saved.modelParameters.find((value: any) => value.role === 'extraction' && value.providerId === providerId && value.model === 'e2e-fixture')).toMatchObject({ temperature: 0.2, maxOutputTokens: 16384, reasoningEffort: 'high' });
});

test('统一上下文限制保留 64000 输出，不再显示或发送任务累计用量上限', async ({ page }) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const providerId = 'e2e-full-output';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '完整输出模拟', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '', maxOutputTokens: 4096, contextTokens: 64000 }],
    writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
  } })).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const modal = page.getByTestId('settings-page');
  await modal.getByRole('button', { name: '任务模型', exact: true }).click();
  await expect(modal.getByLabel('每项任务用量上限（tokens）', { exact: true })).toHaveCount(0);
  const extraction = modal.getByRole('region', { name: '资料提取模型设置', exact: true });
  await extraction.locator('summary').filter({ hasText: '生成参数与思考设置' }).click();
  await extraction.getByLabel('单次最大输出 tokens', { exact: true }).fill('64000');
  await extraction.getByLabel('上下文上限 tokens', { exact: true }).fill('512000');
  const saving = page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings');
  await modal.getByRole('button', { name: '保存设置', exact: true }).click();
  expect((await saving).postDataJSON()).not.toHaveProperty('taskTokenLimit');
  await expect(modal.getByRole('status')).toContainText('设置已保存');
  const saved = await (await page.request.get('/api/settings')).json();
  expect(saved).not.toHaveProperty('taskTokenLimit');
  expect(saved.modelParameters.find((value: any) => value.role === 'extraction' && value.providerId === providerId && value.model === 'e2e-fixture')).toMatchObject({ maxOutputTokens: 64000, contextTokens: 512000 });
  expect(saved.modelParameters.find((value: any) => value.role === 'writing' && value.providerId === providerId && value.model === 'e2e-fixture')).toMatchObject({ maxOutputTokens: 4096, contextTokens: 64000 });
  expect(saved.providers[0]).not.toHaveProperty('maxOutputTokens');
  await modal.getByRole('button', { name: '返回作品', exact: true }).click();

  await createProject(page, 'E2E 完整单次输出');
  const before = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
  await page.getByRole('button', { name: '导入小说', exact: true }).click();
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'full-output.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 城门\n林舟走进白石城。') });
  const confirming = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/confirm'));
  await page.getByRole('dialog').getByRole('button', { name: '确认目录并整理', exact: true }).click();
  const job = await (await confirming).json();
  await completedJobs(page, 1);
  const after = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
  expect(after.modelRequests - before.modelRequests).toBe(1);
  expect(after.lastModelParameters.max_tokens).toBe(64000);
  const outputs = await (await page.request.get(`/api/jobs/${job.id}/outputs?view=author`)).json();
  expect(outputs).toHaveLength(1);
  const { output } = await (await page.request.get(`/api/jobs/${job.id}/outputs/${outputs[0].id}?view=author`)).json();
  expect(JSON.parse(output.request.body).max_tokens).toBe(64000);
});

test('书架删除需确认，取消和失败保留小说，处理中不能关闭，删除最后一本显示空书架', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  // This test runs last and clears only the isolated E2E server's temporary library.
  const previous = await (await page.request.get('/api/projects')).json();
  for (const project of previous) expect((await page.request.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
  const create = async (title: string) => {
    const response = await page.request.post('/api/projects', { data: { title, mode: 'original', premise: '删除验收：保留独立作品。' } });
    expect(response.ok()).toBeTruthy(); return response.json();
  };
  const target = await create('E2E 待删除的小说');
  const survivor = await create('E2E 保留的小说');
  const survivorBefore = await (await page.request.get(`/api/projects/${survivor.id}?view=author`)).json();
  let deleteRequests = 0;
  page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/projects/${target.id}`) deleteRequests++; });
  await page.goto('/');
  await expect(page.locator('.project-card')).toHaveCount(2);
  await page.getByRole('button', { name: `删除作品 ${target.title}`, exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal).toContainText(target.title);
  await expect(modal).toContainText('原文文件、正文、全部故事线及历史版本');
  await expect(modal).toContainText('请先进入工作台下载备份');
  await expect(page.locator('.workspace-project-title')).toHaveCount(0);
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(deleteRequests).toBe(0);
  expect((await page.request.get(`/api/projects/${target.id}`)).ok()).toBeTruthy();

  const route = `**/api/projects/${target.id}`;
  await page.route(route, async intercepted => {
    if (intercepted.request().method() === 'DELETE') await intercepted.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟删除失败，请重试。' }) });
    else await intercepted.continue();
  });
  await page.getByRole('button', { name: `删除作品 ${target.title}`, exact: true }).click();
  await modal.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(modal.getByRole('alert')).toHaveText('模拟删除失败，请重试。');
  await expect(modal.getByRole('button', { name: '永久删除', exact: true })).toBeEnabled();
  await expect(page.locator('.project-card')).toHaveCount(2);
  expect((await page.request.get(`/api/projects/${target.id}`)).ok()).toBeTruthy();
  expect(deleteRequests).toBe(1);
  await page.unroute(route);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('delete-novel-mobile.png'), animations: 'disabled' });
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  await page.route(route, async intercepted => {
    if (intercepted.request().method() === 'DELETE') { reached(); await gate; }
    await intercepted.continue();
  });
  try {
    await modal.getByRole('button', { name: '永久删除', exact: true }).click();
    await entered;
    await expect(modal.getByRole('button', { name: '正在删除…', exact: true })).toBeDisabled();
    await expect(modal.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await expect(modal.getByRole('button', { name: '关闭对话框', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(modal).toBeVisible();
    release();
    await expect(modal).toHaveCount(0);
  } finally { release(); await page.unroute(route); }
  expect(deleteRequests).toBe(2);
  expect((await page.request.get(`/api/projects/${target.id}`)).status()).toBe(404);
  await expect(page.locator('.project-card')).toHaveCount(1);
  expect(await (await page.request.get(`/api/projects/${survivor.id}?view=author`)).json()).toEqual(survivorBefore);
  await page.getByRole('button', { name: `打开作品 ${survivor.title}`, exact: true }).click();
  await expect(page.locator('.workspace-project-title')).toContainText(survivor.title);
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('delete-novel-shelf-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: `删除作品 ${survivor.title}`, exact: true }).click();
  await modal.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.project-card')).toHaveCount(0);
  await expect(page.locator('.count-badge')).toHaveText('0');
  await expect(page.getByRole('heading', { name: '你的下一部故事，从这里开始', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '你的下一部故事，从这里开始', exact: true })).toBeVisible();
  expect(await (await page.request.get('/api/projects')).json()).toEqual([]);
});


test('任务提示词支持编辑编排、变量预览、独立导入导出和保存恢复', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    await page.request.put('/api/settings', { data: { ...previous, promptTemplates: defaultPromptTemplates() } });
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const modal = page.getByTestId('settings-page'); const panel = modal.getByTestId('prompt-templates-panel');
    await modal.getByRole('button', { name: '提示词编排', exact: true }).click();
    await panel.getByRole('button', { name: '复制预设', exact: true }).click();
    await panel.getByLabel('提示词预设名称', { exact: true }).fill('我的写作风格');
    await panel.getByLabel('提示词块 1 内容', { exact: true }).fill('使用风格：{{style}}，作品：{{projectTitle}}。');
    await expect(panel).toContainText('此任务没有变量 {{style}}');
    await panel.locator('summary').filter({ hasText: '可用变量与自定义变量' }).click();
    await panel.getByRole('button', { name: '添加自定义变量', exact: true }).click();
    await panel.getByLabel('自定义变量 1 名称', { exact: true }).fill('style');
    await panel.getByLabel('自定义变量 1 值', { exact: true }).fill('克制叙述，重视动作细节');
    await expect(panel).not.toContainText('此任务没有变量');
    await panel.locator('summary').filter({ hasText: '编译预览 · 使用示例素材' }).click();
    await expect(panel.getByLabel('提示词编译预览', { exact: true })).toContainText('使用风格：克制叙述，重视动作细节，作品：雾港来信。');
    await panel.getByLabel('提示词块 1 角色', { exact: true }).selectOption('assistant');
    await panel.getByRole('button', { name: '下移提示词块 1', exact: true }).click();
    const movedBlock = panel.getByTestId('prompt-block').nth(1);
    if (await movedBlock.getAttribute('open') === null) await movedBlock.locator('summary').click();
    await expect(panel.getByLabel('提示词块 2 角色', { exact: true })).toHaveValue('assistant');
    await panel.getByLabel('启用提示词块 2', { exact: true }).uncheck();
    await expect(panel.getByLabel('提示词编译预览', { exact: true })).not.toContainText('使用风格：');
    await panel.getByLabel('启用提示词块 2', { exact: true }).check();
    await panel.getByLabel('提示词块 2 所有写作模式', { exact: true }).uncheck();
    await panel.locator('summary').filter({ hasText: '编辑示例变量' }).click();
    await panel.getByLabel('示例变量 mode', { exact: true }).selectOption('rewrite');
    await expect(panel.getByLabel('提示词编译预览', { exact: true })).not.toContainText('使用风格：');
    await panel.getByLabel('示例变量 mode', { exact: true }).selectOption('original');
    await expect(panel.getByLabel('提示词编译预览', { exact: true })).toContainText('克制叙述');
    await panel.locator('summary').filter({ hasText: '编辑示例变量' }).click();
    await panel.locator('summary').filter({ hasText: '导入与导出预设 JSON' }).click();
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: '导出当前提示词预设', exact: true }).click();
    const download = await downloadPromise; const exportPath = testInfo.outputPath('prompt-preset.json');
    await download.saveAs(exportPath); const exportedText = await readFile(exportPath, 'utf8'); const exported = JSON.parse(exportedText);
    expect(exported).toMatchObject({ format: 'ai-novel-prompt-preset', version: 1, task: 'writing', preset: { name: '我的写作风格', variables: { style: '克制叙述，重视动作细节' } } });
    expect(exportedText).not.toContain('providers'); expect(exportedText).not.toContain('apiKey');
    await panel.getByLabel('导入提示词预设 JSON', { exact: true }).fill(exportedText);
    await panel.getByRole('button', { name: '从 JSON 新增预设', exact: true }).click();
    await expect(panel.getByLabel('当前提示词预设', { exact: true }).locator('option')).toHaveCount(3);
    for (const label of ['剧情规划', '资料提取', '摘要压缩']) {
      await panel.getByRole('tab', { name: label, exact: true }).click();
      await panel.getByLabel('提示词预设名称', { exact: true }).fill(`${label}测试预设`);
    }
    await panel.getByRole('tab', { name: '正文写作', exact: true }).click();
    await modal.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(modal.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    const saved = await (await page.request.get('/api/settings')).json();
    expect(saved.promptTemplates.presets.writing).toHaveLength(3);
    expect(saved.promptTemplates.presets.writing.at(-1).blocks[1]).toMatchObject({ role: 'assistant', enabled: true, modes: ['original'] });
    expect(saved.promptTemplates.presets.compression[0].name).toBe('摘要压缩测试预设');
    await page.screenshot({ path: testInfo.outputPath('prompt-editor-desktop.png'), animations: 'disabled' });
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click();
    await modal.getByRole('button', { name: '提示词编排', exact: true }).click();
    await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue('我的写作风格');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('prompt-editor-mobile.png'), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('无效提示词草稿可继续修正，保存和导入失败不会覆盖现有配置', async ({ page }) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    await page.request.put('/api/settings', { data: { ...previous, promptTemplates: defaultPromptTemplates() } });
    const before = await (await page.request.get('/api/settings')).json();
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const modal = page.getByTestId('settings-page'); const panel = modal.getByTestId('prompt-templates-panel');
    await modal.getByRole('button', { name: '提示词编排', exact: true }).click();
    await panel.getByLabel('提示词块 1 内容', { exact: true }).fill('{{unknown}}');
    await modal.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(panel).toContainText('此任务没有变量 {{unknown}}');
    expect((await (await page.request.get('/api/settings')).json()).promptTemplates).toEqual(before.promptTemplates);
    await panel.getByLabel('提示词块 1 内容', { exact: true }).fill('修正后的规则');
    await panel.locator('summary').filter({ hasText: '导入与导出预设 JSON' }).click();
    await panel.getByLabel('导入提示词预设 JSON', { exact: true }).fill('{"format":"wrong"}');
    await panel.getByRole('button', { name: '从 JSON 新增预设', exact: true }).click();
    await expect(panel).toContainText('导入失败');
    await expect(panel.getByLabel('当前提示词预设', { exact: true }).locator('option')).toHaveCount(1);
    await modal.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(modal.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    expect((await (await page.request.get('/api/settings')).json()).promptTemplates.presets.writing[0].blocks[0].content).toBe('修正后的规则');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('生图设置、自动人物与场景工具、全文选段 CG、重绘参考图修改及资料地图图册', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const previous = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-image-provider';
  expect((await page.request.put('/api/settings', { data: { providers: [{ id: providerId, name: '本地图片验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }], writingProviderId: providerId, writingModel: 'e2e-images', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture', imageSettings: { providerId: '', model: '', protocol: 'openai-images', size: '1024x1024', quality: 'auto', stylePrompt: '', autoPortrait: true, autoCG: false, timeoutMs: 120000 } } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 故事插画');
    await page.getByRole('button', { name: '设置', exact: true }).click(); const settings = page.getByTestId('settings-page');
    await settings.getByRole('button', { name: '生图与自动插画', exact: true }).click();
    await expect(settings.getByLabel('新人物自动生成立绘', { exact: true })).toBeChecked();
    await expect(settings.getByLabel('场景变化或大场面时自动生成 CG', { exact: true })).not.toBeChecked();
    await settings.getByLabel('生图供应商', { exact: true }).selectOption(providerId); await settings.getByLabel('图片模型名称', { exact: true }).fill('e2e-image');
    await settings.getByLabel('场景变化或大场面时自动生成 CG', { exact: true }).check();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    await settings.getByRole('button', { name: '返回作品', exact: true }).click();
    await page.getByRole('button', { name: '从设定开始创作', exact: true }).click();
    let modal = page.getByRole('dialog'); await modal.getByLabel('章节标题（可选）', { exact: true }).fill('第一章 城门场景');
    await modal.getByRole('button', { name: '开始生成', exact: true }).click();
    await expect(page.locator('.chapter-images .story-image-card')).toHaveCount(2);
    await expect(page.locator('.chapter-images .status-pill.completed')).toHaveCount(2);
    const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
    const listImages = async () => (await page.request.get(`/api/branches/${branchId}/images?view=author`)).json();
    const automatic = await listImages(); expect(automatic.every((image: any) => image.automatic)).toBeTruthy();
    expect(automatic.find((image: any) => image.kind === 'portrait').entityId).toBeTruthy();
    expect(automatic.find((image: any) => image.kind === 'cg').sourceText).toBe('林舟来到白石城，发现城门下藏着一把旧钥匙。');
    const stats = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json(); expect(stats.imageRequests).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click();
    await expect(page.locator('.chapter-images .status-pill.completed')).toHaveCount(3);
    await page.locator('.prose p').first().evaluate(element => { const range = document.createRange(); range.setStart(element.firstChild!, 3); range.setEnd(element.firstChild!, 17); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); element.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await page.getByRole('button', { name: '生成选段 CG', exact: true }).click();
    await expect(modal.locator('.image-source-text')).toHaveText('到白石城，发现城门下藏着一把');
    await modal.getByRole('button', { name: '开始绘制', exact: true }).click(); await expect(page.locator('.chapter-images .status-pill.completed')).toHaveCount(4);
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByLabel('章节正文', { exact: true }).fill('尚未保存的临时正文');
    await expect(page.getByRole('button', { name: '生成本章 CG', exact: true })).toBeDisabled();
    page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: '取消编辑', exact: true }).click();
    await tab(page, '故事图册'); await page.getByRole('button', { name: /^人物立绘 \d+$/ }).click();
    const portrait = page.locator('.image-gallery .story-image-card'); await expect(portrait).toHaveCount(1);
    await portrait.getByRole('button', { name: '关联资料', exact: true }).click(); modal = page.getByRole('dialog');
    await expect(modal).toContainText('世界资料 · 林舟'); await expect(modal.locator('.story-image-card')).toHaveCount(1);
    await modal.getByRole('button', { name: '重新绘制', exact: true }).first().click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click();
    await tab(page, '故事图册'); await page.getByRole('button', { name: /^人物立绘 \d+$/ }).click();
    await expect(page.locator('.image-gallery .status-pill.completed')).toHaveCount(2);
    const manualPortrait = (await listImages()).find((image: any) => image.kind === 'portrait' && !image.automatic);
    await expect(page.locator(`[data-image-id="${manualPortrait.id}"]`).getByRole('button', { name: '启用后可修改', exact: true })).toBeDisabled();
    await page.locator(`[data-image-id="${manualPortrait.id}"]`).getByRole('button', { name: '启用图片', exact: true }).click();
    await page.locator(`[data-image-id="${manualPortrait.id}"]`).getByRole('button', { name: 'AI 修改', exact: true }).click();
    await expect(modal.locator('.image-reference')).toBeVisible(); await expect(modal.getByRole('button', { name: '开始修改', exact: true })).toBeDisabled();
    await modal.getByLabel('修改要求', { exact: true }).fill('保留五官，把斗篷改成蓝色。'); await modal.getByRole('button', { name: '开始修改', exact: true }).click();
    await expect(page.locator('.image-gallery .status-pill.completed')).toHaveCount(3);
    const editedStats = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json(); expect(editedStats.imageEditRequests).toBeGreaterThanOrEqual(1); expect(editedStats.lastImageRequest.referenceBytes).toBe(true);
    const editedImage = (await listImages()).find((image: any) => image.referenceImageId === manualPortrait.id); expect(editedImage).toBeTruthy();
    await tab(page, '世界资料'); const city = page.locator('.entity-card').filter({ has: page.getByRole('heading', { name: '白石城', exact: true }) });
    await city.getByRole('button', { name: '生成资料图片', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click();
    await expect.poll(async () => (await listImages()).filter((image: any) => image.kind === 'entity' && image.status === 'completed').length).toBe(1);
    await tab(page, '地点关系'); await page.getByRole('button', { name: '生成世界地图', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click();
    await expect(page.locator('.map-images .status-pill.completed')).toHaveCount(1);
    await tab(page, '故事图册'); await expect(page.locator('.image-gallery .story-image-card')).toHaveCount(8);
    await page.screenshot({ path: testInfo.outputPath('story-images-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('story-images-mobile.png'), animations: 'disabled' }); await page.setViewportSize({ width: 1440, height: 1000 });
    const cg = (await listImages()).find((image: any) => image.kind === 'cg' && !image.automatic && image.selection);
    await page.locator(`[data-image-id="${cg.id}"]`).getByRole('button', { name: '关联剧情', exact: true }).click(); await expect(page.locator('.highlighted-paragraph')).toContainText('林舟来到白石城');
    await tab(page, '故事图册'); await page.getByRole('button', { name: '返回阅读视图', exact: true }).click();
    const readerImages = await (await page.request.get(`/api/branches/${branchId}/images?view=reader`)).json();
    expect(readerImages.some((image: any) => image.id === editedImage.id)).toBe(false);
    await expect(page.locator('.image-gallery .story-image-card')).toHaveCount(readerImages.length); await expect(page.locator('.image-gallery .image-kind-cg')).toHaveCount(readerImages.filter((image: any) => image.kind === 'cg').length); await expect(page.getByRole('button', { name: 'AI 修改', exact: true })).toHaveCount(0);
    await expect(page.locator('.workspace')).not.toContainText('保留五官，把斗篷改成蓝色');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('生图取消的迟到响应不会跨阅读视图或故事线显示作者图片', async ({ page }) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  await createProject(page, 'E2E 插画请求范围'); const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
  const view = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
  const fork = await (await page.request.post(`/api/branches/${branchId}/fork`, { data: { baseRevisionId: view.branch.revisionId, name: '插画请求其他线' } })).json();
  const secretImage = { id: 'ui-secret-image', projectId: view.branch.projectId, branchId, baseRevisionId: view.branch.revisionId, kind: 'map', status: 'running', title: 'SECRET_IMAGE_LATE_RESULT', prompt: 'SECRET_PROMPT_MUST_NOT_RENDER', automatic: false, visibility: 'secret', createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z' };
  let release: () => void = () => {}; let gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/branches/*/images**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/cancel')) { await gate; await route.fulfill({ json: { ...secretImage, status: 'cancelled' } }); }
    else if (route.request().method() === 'GET' && url.pathname.endsWith('/images')) await route.fulfill({ json: url.pathname.includes(branchId) && url.searchParams.get('view') === 'author' ? [secretImage] : [] });
    else await route.continue();
  });
  await tab(page, '故事图册'); await expect(page.locator('.story-image-card')).toHaveCount(1);
  const response = page.waitForResponse(value => value.url().includes('/ui-secret-image/cancel'));
  await page.getByRole('button', { name: '取消绘制', exact: true }).click();
  await page.getByRole('button', { name: '返回阅读视图', exact: true }).click();
  await expect(page.locator('.image-gallery')).toContainText('故事图册尚未展开'); release(); await response;
  await expect(page.locator('.story-image-card')).toHaveCount(0); await expect(page.locator('.workspace')).not.toContainText('SECRET_IMAGE');
  await page.getByRole('button', { name: '查看作者资料', exact: true }).click(); await expect(page.locator('.story-image-card')).toHaveCount(1);
  gate = new Promise<void>(resolve => { release = resolve; }); const nextResponse = page.waitForResponse(value => value.url().includes('/ui-secret-image/cancel'));
  await page.getByRole('button', { name: '取消绘制', exact: true }).click();
  // The branch created through the API appears after metadata refresh when toggling author mode.
  await page.getByLabel('当前故事线', { exact: true }).selectOption(fork.branch.id);
  await expect(page.locator('.image-gallery')).toContainText('故事图册尚未展开'); release(); await nextResponse;
  await expect(page.locator('.story-image-card')).toHaveCount(0); await expect(page.locator('.workspace')).not.toContainText('SECRET_IMAGE');
});

test('专用生图提示词、AI 尺寸、两人物 CG 参考、Nano Banana 2 与 Together 参数及失败隔离', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const previous = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-advanced-image-provider';
  expect((await page.request.put('/api/settings', { data: { providers: [{ id: providerId, name: '高级生图本地验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }], writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-image-prompt', extractionProviderId: providerId, extractionModel: 'e2e-fixture', imageSettings: { providerId, model: 'gpt-image-1', protocol: 'openai-images', size: '1024x1024', quality: 'auto', stylePrompt: '', autoPortrait: false, autoCG: false, timeoutMs: 120000, useCharacterReferences: true } } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 专用插画提示词');
    await page.getByRole('button', { name: '设置', exact: true }).click(); const settings = page.getByTestId('settings-page');
    await settings.getByRole('button', { name: '生图与自动插画', exact: true }).click();
    await expect(settings.getByLabel('生图提示词优化供应商', { exact: true })).toHaveValue('');
    await expect(settings.getByLabel('生图提示词优化模型', { exact: true })).toHaveAttribute('placeholder', 'e2e-image-prompt');
    await settings.getByLabel('图片尺寸', { exact: true }).selectOption('auto');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存'); await settings.getByRole('button', { name: '返回作品', exact: true }).click();
    await page.getByRole('button', { name: '手动写第一章', exact: true }).click();
    await page.getByLabel('章节标题', { exact: true }).fill('第一章 两位旅人'); await page.getByLabel('章节正文', { exact: true }).fill('林舟与苏晴站在白石城的城门下，眺望远处亮起的灯火。'); await page.getByRole('button', { name: '保存正文', exact: true }).click(); await completedJobs(page, 1);
    const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
    const imageList = async () => (await page.request.get(`/api/branches/${branchId}/images?view=author`)).json();
    const stats = async () => (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    await tab(page, '世界资料'); await page.getByRole('button', { name: '新增资料', exact: true }).click(); let modal = page.getByRole('dialog');
    await modal.getByLabel('名称', { exact: true }).fill('苏晴'); await modal.getByLabel('资料描述', { exact: true }).fill('一位扎着马尾、身穿蓝色旅行外套的年轻旅人。'); await modal.getByRole('button', { name: '保存资料', exact: true }).click(); await expect(modal).toHaveCount(0);
    for (const name of ['林舟', '苏晴']) {
      await page.locator('.entity-card').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: '生成人物立绘', exact: true }).click();
      await modal.getByRole('button', { name: '开始绘制', exact: true }).click();
      await expect.poll(async () => (await imageList()).filter((image: any) => image.kind === 'portrait' && image.status === 'completed').length).toBe(name === '林舟' ? 1 : 2);
    }
    await tab(page, '正文'); await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click();
    await expect(page.locator('.chapter-images .image-kind-cg .status-pill.completed')).toHaveCount(1);
    const openaiCG = (await imageList()).find((image: any) => image.kind === 'cg');
    expect(openaiCG.promptStatus).toBe('completed'); expect(openaiCG.prompt).toContain('E2E_OPTIMIZED_IMAGE_PROMPT'); expect(openaiCG.prompt).not.toContain('剧情：'); expect(openaiCG.generationParameters.size).toBe('1536x1024'); expect(openaiCG.referenceCharacters.map((character: any) => character.name).sort()).toEqual(['林舟', '苏晴']);
    const firstStats = await stats(); expect(firstStats.lastPromptOptimizationRequest.model).toBe('e2e-image-prompt'); expect(firstStats.lastImageRequest).toMatchObject({ edit: true, referenceCount: 2, referenceBytes: true }); expect(firstStats.lastImageRequest.prompt.replace(/\r\n/g, '\n')).toBe(openaiCG.prompt);
    await tab(page, '故事图册'); await page.locator(`[data-image-id="${openaiCG.id}"]`).getByRole('button', { name: '生图详情', exact: true }).click();
    await expect(modal.getByTestId('optimized-image-prompt')).toContainText('E2E_OPTIMIZED_IMAGE_PROMPT'); await expect(modal.getByTestId('image-actual-parameters')).toContainText('1536 × 1024'); await expect(modal.locator('.image-character-references')).toContainText('苏晴'); await modal.getByRole('button', { name: '关闭图片查看器', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click(); await settings.getByRole('button', { name: '生图与自动插画', exact: true }).click();
    await settings.getByLabel('生图提示词优化供应商', { exact: true }).selectOption(providerId); await settings.getByLabel('生图提示词优化模型', { exact: true }).fill('e2e-image-prompt');
    await settings.getByLabel('图片接口', { exact: true }).selectOption('gemini'); await settings.getByLabel('图片模型名称', { exact: true }).fill('gemini-3.1-flash-image');
    await expect(settings.getByLabel('图片模型思考等级', { exact: true }).locator('option')).toHaveCount(3); await expect(settings.getByLabel('图片分辨率', { exact: true }).locator('option')).toHaveCount(6); await expect(settings.getByLabel('生成质量', { exact: true })).toHaveCount(0);
    await settings.getByLabel('画幅比例', { exact: true }).selectOption('auto'); await settings.getByLabel('图片分辨率', { exact: true }).selectOption('2K'); await settings.getByLabel('图片模型思考等级', { exact: true }).selectOption('high');
    await settings.getByLabel('图片模型 Temperature', { exact: true }).fill('0.4'); await settings.getByLabel('图片模型 Top P', { exact: true }).fill('0.8'); await settings.getByLabel('图片模型 Top K', { exact: true }).fill('32'); await settings.getByLabel('图片随机种子', { exact: true }).fill('123'); await settings.getByLabel('图片模型最大输出 Token', { exact: true }).fill('8192');
    await settings.getByLabel('图片模型系统提示词', { exact: true }).fill('IMAGE_SYSTEM_E2E：保持角色五官和服装。'); await settings.getByLabel('返回图片模型的思考内容', { exact: true }).check();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    await settings.locator('.image-dimension-fields').scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('image-model-settings-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); await settings.locator('.image-model-parameters').scrollIntoViewIfNeeded(); expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy(); await page.screenshot({ path: testInfo.outputPath('image-model-settings-mobile.png'), animations: 'disabled' }); await page.setViewportSize({ width: 1440, height: 1000 });
    await settings.getByRole('button', { name: '返回作品', exact: true }).click(); await tab(page, '正文'); await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click(); await expect(page.locator('.chapter-images .image-kind-cg .status-pill.completed')).toHaveCount(2);
    const geminiStats = await stats(); expect(geminiStats.lastImageRequest).toMatchObject({ protocol: 'gemini', referenceCount: 2, referenceBytes: true, parameters: { temperature: 0.4, topP: 0.8, topK: 32, seed: 123, maxOutputTokens: 8192, imageConfig: { aspectRatio: '16:9', imageSize: '2K' }, thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } }, systemInstruction: { parts: [{ text: 'IMAGE_SYSTEM_E2E：保持角色五官和服装。' }] } });
    const geminiCG = (await imageList()).find((image: any) => image.generationParameters?.protocol === 'gemini'); expect(geminiCG.generationParameters).toMatchObject({ aspectRatio: '16:9', imageSize: '2K', thinkingLevel: 'high', temperature: 0.4 });
    await page.getByRole('button', { name: '设置', exact: true }).click(); await settings.getByRole('button', { name: '生图与自动插画', exact: true }).click();
    await settings.getByLabel('图片接口', { exact: true }).selectOption('together-images'); await settings.getByLabel('图片模型名称', { exact: true }).fill('black-forest-labs/FLUX.2-dev');
    await expect(settings.getByLabel('图片模型思考等级', { exact: true })).toHaveCount(0); await expect(settings.getByLabel('图片模型系统提示词', { exact: true })).toHaveCount(0); await expect(settings.getByLabel('图片分辨率', { exact: true })).toHaveCount(0);
    await settings.getByLabel('图片尺寸', { exact: true }).selectOption('auto'); await settings.getByLabel('采样步数', { exact: true }).fill('30'); await settings.getByLabel('提示词引导强度', { exact: true }).fill('3'); await settings.getByLabel('图片随机种子', { exact: true }).fill('99'); await settings.getByLabel('图片输出格式', { exact: true }).selectOption('png');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    const cleaned = (await (await page.request.get('/api/settings')).json()).imageSettings; expect(cleaned.thinkingLevel).toBeUndefined(); expect(cleaned.systemInstruction).toBeUndefined(); expect(cleaned.imageSize).toBeUndefined(); expect(cleaned.temperature).toBeUndefined(); expect(cleaned.promptModel).toBe('e2e-image-prompt');
    await settings.getByRole('button', { name: '返回作品', exact: true }).click(); await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click(); await expect(page.locator('.chapter-images .image-kind-cg .status-pill.completed')).toHaveCount(3);
    const togetherStats = await stats(); expect(togetherStats.lastImageRequest).toMatchObject({ protocol: 'together-images', referenceCount: 2, referenceBytes: true, parameters: { width: 1536, height: 1024, steps: 30, guidance_scale: 3, seed: 99, output_format: 'png' } });
    await tab(page, '故事图册'); await page.getByRole('button', { name: '返回阅读视图', exact: true }).click(); await expect(page.getByRole('button', { name: '生图详情', exact: true })).toHaveCount(0); await expect(page.locator('.workspace')).not.toContainText('E2E_OPTIMIZED_IMAGE_PROMPT'); await expect(page.locator('.workspace')).not.toContainText('IMAGE_SYSTEM_E2E');
    await page.getByRole('button', { name: '查看作者资料', exact: true }).click(); await page.getByRole('button', { name: '设置', exact: true }).click(); await settings.getByRole('button', { name: '生图与自动插画', exact: true }).click(); await settings.getByLabel('生图提示词优化模型', { exact: true }).fill('e2e-image-prompt-failure'); await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存'); await settings.getByRole('button', { name: '返回作品', exact: true }).click();
    const beforeFailure = await stats(); await tab(page, '正文'); await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click(); await expect(page.locator('.chapter-images .image-kind-cg .status-pill.failed')).toHaveCount(1); expect((await stats()).imageRequests).toBe(beforeFailure.imageRequests);
    await page.locator('.chapter-images .story-image-card').filter({ has: page.locator('.status-pill.failed') }).getByRole('button', { name: '生图详情', exact: true }).click(); await expect(modal).toContainText('生图提示词尚未完成'); await expect(modal.getByTestId('optimized-image-prompt')).toHaveCount(0); await modal.getByRole('button', { name: '关闭图片查看器', exact: true }).click();
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('图片启用暂存、停用后 CG 无人物参考、删除确认与失败保留、放大滚动和全屏查看', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const viewerErrors: string[] = []; page.on('pageerror', error => viewerErrors.push(error.message));
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.initialized) expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  const previous = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-image-selection-provider';
  expect((await page.request.put('/api/settings', { data: { providers: [{ id: providerId, name: '图片选择本地验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }], writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-image-prompt', extractionProviderId: providerId, extractionModel: 'e2e-fixture', imageSettings: { providerId, model: 'gpt-image-1', protocol: 'openai-images', size: '1024x1024', quality: 'auto', stylePrompt: '', autoPortrait: false, autoCG: false, timeoutMs: 120000, useCharacterReferences: true } } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 图片选择与查看'); await page.getByRole('button', { name: '手动写第一章', exact: true }).click();
    await page.getByLabel('章节标题', { exact: true }).fill('第一章 城门'); await page.getByLabel('章节正文', { exact: true }).fill('林舟站在白石城的城门下。'); await page.getByRole('button', { name: '保存正文', exact: true }).click(); await completedJobs(page, 1);
    const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
    const imageList = async () => (await page.request.get(`/api/branches/${branchId}/images?view=author`)).json();
    const stats = async () => (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    await tab(page, '世界资料'); const person = page.locator('.entity-card').filter({ has: page.getByRole('heading', { name: '林舟', exact: true }) });
    for (let index = 0; index < 3; index++) {
      await person.getByRole('button', { name: index ? '重新绘制' : '生成人物立绘', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '开始绘制', exact: true }).click();
      await expect.poll(async () => (await imageList()).filter((image: any) => image.kind === 'portrait' && image.status === 'completed').length).toBe(index + 1);
    }
    const portraits = (await imageList()).filter((image: any) => image.kind === 'portrait'); const [first, second, third] = portraits;
    expect(first.active).toBe(true); expect(second.active).toBe(false); expect(third.active).toBe(false);
    await tab(page, '故事图册'); const card = (id: string) => page.locator(`.image-gallery [data-image-id="${id}"]`);
    await expect(card(second.id).getByRole('button', { name: '启用后可修改', exact: true })).toBeDisabled();
    await card(third.id).getByRole('button', { name: '启用图片', exact: true }).click(); await expect(card(third.id)).toHaveAttribute('data-image-active', 'true'); await expect(card(first.id)).toHaveAttribute('data-image-active', 'false');
    await card(first.id).getByRole('button', { name: '启用图片', exact: true }).click(); await expect(card(first.id)).toHaveAttribute('data-image-active', 'true'); await expect(card(third.id)).toHaveAttribute('data-image-active', 'false');
    await tab(page, '世界资料'); await expect(person.locator('.entity-image-preview img')).toHaveAttribute('src', new RegExp(first.id));
    await tab(page, '故事图册'); await card(first.id).getByRole('button', { name: '停用图片', exact: true }).click(); await expect(card(first.id)).toHaveAttribute('data-image-active', 'false');
    await tab(page, '正文'); await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '开始绘制', exact: true }).click(); await expect(page.locator('.chapter-images .image-kind-cg .status-pill.completed')).toHaveCount(1);
    const noReference = await stats(); expect(noReference.lastImageRequest.referenceCount).toBe(0); for (const image of portraits) expect(noReference.lastPromptOptimizationRequest.prompt).not.toContain(image.id);
    const cg = (await imageList()).find((image: any) => image.kind === 'cg'); expect(cg.referenceImageIds).toEqual([]);
    await tab(page, '故事图册'); await card(second.id).getByRole('button', { name: '删除图片', exact: true }).click();
    const confirmation = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '删除图片', exact: true }) });
    await expect(confirmation).toContainText('历史版本与其他故事线中的引用会保留'); await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await expect(card(second.id)).toBeVisible();
    const deletionMatch = (url: URL) => url.pathname === `/api/branches/${branchId}/images/${second.id}`;
    await page.route(deletionMatch, async route => { if (route.request().method() === 'DELETE') await route.fulfill({ status: 503, json: { error: '删除失败：本地故障验收' } }); else await route.continue(); });
    await card(second.id).getByRole('button', { name: '删除图片', exact: true }).click(); await confirmation.getByRole('button', { name: '确认删除图片', exact: true }).click(); await expect(confirmation.getByRole('alert')).toContainText('删除失败'); await expect(card(second.id)).toHaveCount(1); await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await page.unroute(deletionMatch);
    // A large, neutral browser-only SVG fixture exercises real scrolling geometry.
    const viewerFixture = '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1800"><rect width="2400" height="1800" fill="#dce8d3"/><path d="M0 900H2400M1200 0V1800" stroke="#6d9661" stroke-width="20"/><text x="200" y="250" font-size="90" fill="#345c3a">VIEWER FIXTURE</text></svg>';
    await page.route(`**/api/branches/${branchId}/images/${second.id}/content**`, route => route.fulfill({ contentType: 'image/svg+xml', body: viewerFixture }));
    await card(second.id).getByRole('button', { name: /^查看图片/ }).click(); const viewer = page.getByTestId('image-viewer');
    await expect.poll(async () => viewer.locator('.image-viewer-image').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2400);
    const detailToggle = viewer.getByRole('button', { name: '生图详情', exact: true }); const details = viewer.locator('.image-viewer-details');
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'false'); await expect(details).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('image-viewer-collapsed-desktop.png'), animations: 'disabled' });
    await detailToggle.click(); await expect(detailToggle).toHaveAttribute('aria-expanded', 'true'); await expect(details).toBeVisible(); await expect(viewer.getByTestId('optimized-image-prompt')).toContainText('E2E_OPTIMIZED_IMAGE_PROMPT');
    await detailToggle.click(); await expect(details).toBeHidden();
    const initialFit = Number((await viewer.getByLabel('图片缩放比例', { exact: true }).textContent())!.replace('%', ''));
    await viewer.getByRole('button', { name: '缩小图片', exact: true }).click(); const smaller = Number((await viewer.getByLabel('图片缩放比例', { exact: true }).textContent())!.replace('%', '')); expect(smaller).toBeLessThanOrEqual(initialFit);
    await viewer.getByRole('button', { name: '原始大小', exact: true }).click(); await expect(viewer.getByLabel('图片缩放比例', { exact: true })).toHaveText('100%'); await viewer.getByRole('button', { name: '放大图片', exact: true }).click(); await expect(viewer.getByLabel('图片缩放比例', { exact: true })).toHaveText('125%');
    await viewer.getByLabel('调整图片缩放', { exact: true }).focus(); await page.keyboard.press('End'); await expect(viewer.getByLabel('图片缩放比例', { exact: true })).toHaveText('400%');
    const viewport = viewer.getByLabel('可滚动的图片区域', { exact: true }); expect(await viewport.evaluate(element => element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight)).toBe(true);
    const fillsBrowserViewport = async () => {
      await expect.poll(() => viewport.evaluate(element => { const bounds = element.getBoundingClientRect(); return Math.max(Math.abs(bounds.x), Math.abs(bounds.y), Math.abs(bounds.width - innerWidth), Math.abs(bounds.height - innerHeight)); })).toBeLessThanOrEqual(1);
    };
    const panel = viewer.locator('.image-viewer-panel');
    const showEdge = async (edge: 'top' | 'bottom') => { const size = page.viewportSize()!; await page.mouse.move(size.width / 2, edge === 'top' ? 20 : size.height - 20); await expect(panel).toHaveAttribute(`data-chrome-${edge}`, 'visible'); };
    const hideChrome = async () => {
      const size = page.viewportSize()!; await page.mouse.move(size.width / 2, size.height / 2);
      await expect(panel).toHaveAttribute('data-chrome-top', 'hidden'); await expect(panel).toHaveAttribute('data-chrome-bottom', 'hidden');
      await expect.poll(() => viewer.locator('.image-viewer-heading').evaluate(element => getComputedStyle(element).opacity)).toBe('0');
      await expect.poll(() => viewer.locator('.image-viewer-controls').evaluate(element => getComputedStyle(element).opacity)).toBe('0');
    };
    const transparentChrome = async () => {
      expect(await viewer.locator('.image-viewer-heading, .image-viewer-controls').evaluateAll(elements => elements.every(element => { const style = getComputedStyle(element); return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderTopWidth === '0px' && style.boxShadow === 'none'; }))).toBe(true);
      await expect(viewer.locator('.image-viewer-heading h2')).toBeHidden(); await expect(viewer.locator('.image-viewer-control-text:visible')).toHaveCount(0);
    };
    const rectangle = (await viewport.boundingBox())!; await page.mouse.move(rectangle.x + 150, rectangle.y + 60); await page.mouse.down(); await page.mouse.move(rectangle.x + 40, rectangle.y + 25); await page.mouse.up(); expect(await viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await viewer.getByRole('button', { name: '适应窗口', exact: true }).click(); await detailToggle.click(); await expect(details).toBeVisible();
    await viewer.getByRole('button', { name: '全屏查看图片', exact: true }).click(); await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true); await expect(panel).toHaveAttribute('data-fullscreen-mode', 'native');
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'false'); await expect(details).toBeHidden(); await fillsBrowserViewport();
    // Moving alone must hide the button still focused by the fullscreen mouse click.
    await hideChrome(); await transparentChrome();
    await page.screenshot({ path: testInfo.outputPath('image-viewer-native-fullscreen.png'), animations: 'disabled' });
    await expect.poll(() => viewer.getByRole('button', { name: '关闭图片查看器', exact: true }).evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
    const closeBounds = (await viewer.getByRole('button', { name: '关闭图片查看器', exact: true }).boundingBox())!;
    expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.image-viewer-viewport')), { x: closeBounds.x + 18, y: closeBounds.y + 18 })).toBe(true);
    await showEdge('top'); await showEdge('bottom'); await transparentChrome();
    await expect(viewer.locator('.image-viewer-title-popover')).toHaveCount(0); await expect(viewer.getByLabel('调整图片缩放', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('image-viewer-fullscreen-floating-buttons.png'), animations: 'disabled' });
    await showEdge('top'); await viewer.getByRole('button', { name: '查看图片标题', exact: true }).click(); await expect(viewer.locator('.image-viewer-title-popover')).toContainText(second.title);
    await page.screenshot({ path: testInfo.outputPath('image-viewer-fullscreen-title.png'), animations: 'disabled' }); await viewer.getByRole('button', { name: '查看图片标题', exact: true }).click();
    await showEdge('bottom'); await viewer.getByRole('button', { name: '设置图片缩放', exact: true }).click(); const fullscreenRange = viewer.getByLabel('调整图片缩放', { exact: true }); await fullscreenRange.click();
    await expect(viewer.locator('.image-viewer-zoom-popover')).toBeVisible(); await page.screenshot({ path: testInfo.outputPath('image-viewer-fullscreen-zoom-popup.png'), animations: 'disabled' });
    // The disappearing range releases focus to body; the first Tab must reveal its focused edge.
    await hideChrome(); await expect(viewer.locator('.image-viewer-zoom-popover')).toHaveCount(0); expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
    await page.keyboard.press('Tab');
    await expect.poll(() => panel.evaluate(element => document.activeElement?.closest('[data-image-chrome-edge]')?.getAttribute('data-image-chrome-edge') ?? '')).toMatch(/^(top|bottom)$/);
    const focusedEdge = await panel.evaluate(element => document.activeElement!.closest('[data-image-chrome-edge]')!.getAttribute('data-image-chrome-edge'));
    await expect(panel).toHaveAttribute(`data-chrome-${focusedEdge}`, 'visible'); await page.waitForTimeout(1700); await expect(panel).toHaveAttribute(`data-chrome-${focusedEdge}`, 'visible');
    await hideChrome();
    await showEdge('bottom'); await viewer.getByRole('button', { name: '设置图片缩放', exact: true }).click(); await fullscreenRange.focus(); await page.keyboard.press('End'); await expect(viewer.getByLabel('图片缩放比例', { exact: true })).toHaveText('400%'); await hideChrome();
    const scrollBeforeHiddenDrag = await viewport.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
    await page.mouse.move(700, 450); await page.mouse.down(); await page.mouse.move(closeBounds.x + 18, closeBounds.y + 18, { steps: 6 });
    await expect(panel).toHaveAttribute('data-chrome-top', 'hidden'); await expect(panel).toHaveAttribute('data-chrome-bottom', 'hidden'); expect(await viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(scrollBeforeHiddenDrag.top); await page.mouse.up();
    await showEdge('bottom'); await viewer.getByRole('button', { name: '适应窗口', exact: true }).click(); await showEdge('top'); await detailToggle.click(); await expect(details).toBeVisible(); await fillsBrowserViewport();
    await page.screenshot({ path: testInfo.outputPath('image-viewer-native-fullscreen-details-overlay.png'), animations: 'disabled' });
    await showEdge('top'); await detailToggle.click(); await expect(details).toBeHidden(); await fillsBrowserViewport(); await detailToggle.click(); await expect(details).toBeVisible();
    await viewer.getByRole('button', { name: '删除图片', exact: true }).click(); await expect(confirmation).toBeVisible(); await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    if (!await page.evaluate(() => Boolean(document.fullscreenElement))) { await viewer.getByRole('button', { name: '全屏查看图片', exact: true }).click(); await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true); }
    else if (await detailToggle.getAttribute('aria-expanded') === 'true') { await showEdge('top'); await detailToggle.click(); }
    await expect(details).toBeHidden(); await fillsBrowserViewport();
    await page.keyboard.press('Escape'); await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false); await expect(viewer).toBeVisible();
    await expect(details).toBeHidden(); await expect(detailToggle).toHaveAttribute('aria-expanded', 'false');
    await viewer.getByRole('button', { name: '全屏查看图片', exact: true }).click(); await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true); await hideChrome(); await showEdge('top'); await viewer.getByRole('button', { name: '关闭图片查看器', exact: true }).click(); await expect(viewer).toHaveCount(0); await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await card(second.id).getByRole('button', { name: '生图详情', exact: true }).click(); await page.setViewportSize({ width: 390, height: 320 });
    await page.waitForTimeout(1700); await expect(panel).toHaveAttribute('data-fullscreen-mode', 'none'); expect(viewerErrors).toEqual([]);
    await expect(detailToggle).toHaveAttribute('aria-expanded', 'true'); await expect(details).toBeVisible();
    await detailToggle.click(); await expect(details).toBeHidden(); await page.screenshot({ path: testInfo.outputPath('image-viewer-collapsed-mobile.png'), animations: 'disabled' }); await detailToggle.click(); await expect(details).toBeVisible();
    await viewer.getByRole('button', { name: '适应窗口', exact: true }).click(); expect(await viewer.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('image-viewer-short-mobile.png'), animations: 'disabled' });
    await viewer.getByRole('button', { name: '删除图片', exact: true }).click(); await expect(confirmation).toBeVisible(); await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await expect(viewer).toBeVisible();
    await viewer.locator('.image-viewer-panel').evaluate(element => { element.requestFullscreen = () => Promise.reject(new Error('Browser fixture unavailable')); });
    await viewer.getByRole('button', { name: '全屏查看图片', exact: true }).click(); await expect(panel).toHaveAttribute('data-fullscreen-mode', 'page'); await expect(details).toBeHidden(); await fillsBrowserViewport(); await hideChrome(); await transparentChrome();
    await page.screenshot({ path: testInfo.outputPath('image-viewer-mobile-fallback-fullscreen.png'), animations: 'disabled' });
    await showEdge('top'); await detailToggle.click(); await expect(details).toBeVisible(); await fillsBrowserViewport(); await detailToggle.click(); await expect(details).toBeHidden(); await fillsBrowserViewport();
    await page.keyboard.press('Escape'); await expect(viewer.locator('.image-viewer-panel')).toHaveAttribute('data-fullscreen-mode', 'none'); await expect(details).toBeHidden();
    // A separate real touch context shares only this isolated fixture login and never mutates images.
    const touchContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 }, locale: 'zh-CN', hasTouch: true, storageState: await page.context().storageState() });
    try {
      const touchPage = await touchContext.newPage(); touchPage.on('pageerror', error => viewerErrors.push(error.message));
      await touchPage.route(`**/api/branches/${branchId}/images/${second.id}/content**`, route => route.fulfill({ contentType: 'image/svg+xml', body: viewerFixture }));
      await touchPage.goto('/'); await touchPage.getByRole('button', { name: '打开作品 E2E 图片选择与查看', exact: true }).tap(); await touchPage.getByRole('button', { name: '查看作者资料', exact: true }).tap(); await tab(touchPage, '故事图册');
      await touchPage.locator(`.image-gallery [data-image-id="${second.id}"]`).getByRole('button', { name: /^查看图片/ }).tap(); const touchViewer = touchPage.getByTestId('image-viewer'); const touchPanel = touchViewer.locator('.image-viewer-panel');
      await touchPanel.evaluate(element => { element.requestFullscreen = () => Promise.reject(new Error('Touch fixture unavailable')); }); await touchViewer.getByRole('button', { name: '全屏查看图片', exact: true }).tap(); await expect(touchPanel).toHaveAttribute('data-fullscreen-mode', 'page');
      await expect(touchPanel).toHaveAttribute('data-chrome-top', 'visible'); await expect(touchPanel).toHaveAttribute('data-chrome-bottom', 'visible');
      await expect(touchPanel).toHaveAttribute('data-chrome-top', 'hidden'); await expect(touchPanel).toHaveAttribute('data-chrome-bottom', 'hidden');
      await touchPage.screenshot({ path: testInfo.outputPath('image-viewer-touch-fullscreen-hidden.png'), animations: 'disabled' });
      await touchPage.touchscreen.tap(195, 422); await expect(touchPanel).toHaveAttribute('data-chrome-top', 'visible'); await expect(touchPanel).toHaveAttribute('data-chrome-bottom', 'visible');
      await touchViewer.getByRole('button', { name: '查看图片标题', exact: true }).tap(); await expect(touchViewer.locator('.image-viewer-title-popover')).toContainText(second.title); await touchViewer.getByRole('button', { name: '查看图片标题', exact: true }).tap();
      await touchViewer.getByRole('button', { name: '设置图片缩放', exact: true }).tap(); await expect(touchViewer.getByLabel('调整图片缩放', { exact: true })).toBeVisible(); await touchPage.screenshot({ path: testInfo.outputPath('image-viewer-touch-floating-buttons.png'), animations: 'disabled' });
      await expect(touchPanel).toHaveAttribute('data-chrome-bottom', 'hidden'); await expect(touchViewer.locator('.image-viewer-zoom-popover')).toHaveCount(0); await touchPage.touchscreen.tap(195, 422); await touchViewer.getByRole('button', { name: '退出页面全屏', exact: true }).tap(); await expect(touchPanel).toHaveAttribute('data-fullscreen-mode', 'none');
      await touchViewer.getByRole('button', { name: '关闭图片查看器', exact: true }).tap(); await expect(touchViewer).toHaveCount(0);
    } finally { await touchContext.close(); }
    await page.setViewportSize({ width: 1440, height: 1000 }); await detailToggle.click(); await expect(details).toBeVisible(); await viewer.getByRole('button', { name: '删除图片', exact: true }).click(); await expect(confirmation).toBeVisible(); await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await expect(viewer).toBeVisible();
    await viewer.getByRole('button', { name: '删除图片', exact: true }).click(); await confirmation.getByRole('button', { name: '确认删除图片', exact: true }).click(); await expect(confirmation).toHaveCount(0); await expect(viewer).toHaveCount(0); await expect(card(second.id)).toHaveCount(0); expect((await imageList()).some((image: any) => image.id === second.id)).toBe(false);
    await page.getByRole('button', { name: '返回阅读视图', exact: true }).click(); await expect(page.locator('.image-gallery .image-kind-portrait')).toHaveCount(0); await expect(page.locator('.image-gallery .story-image-card')).toHaveCount(1); await expect(page.getByRole('button', { name: '删除图片', exact: true })).toHaveCount(0); expect(viewerErrors).toEqual([]);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

async function taskSettingsAuthentication(page: Page) {
  if (!(await (await page.request.get('/api/auth/status')).json()).initialized) {
    expect((await page.request.post('/api/auth/setup', { data: { password } })).ok()).toBeTruthy();
  }
}

const taskSettingsDefaults = {
  extraction: { autoRetry: false, maxRetries: 2, retryDelayMs: 5000 },
  planning: { enabled: true, mode: 'separate' },
};

test('任务控制设置保留数字草稿，校验重试范围并保存秒到毫秒的转换', async ({ page }, testInfo) => {
  await taskSettingsAuthentication(page);
  const previous = await (await page.request.get('/api/settings')).json();
  const providerId = 'e2e-task-controls';
  const configured = {
    ...previous,
    providers: [...previous.providers, { id: providerId, name: '任务控制测试供应商', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: 'loopback-fixture-key' }],
    planningProviderId: providerId, planningModel: 'e2e-planning', taskSettings: taskSettingsDefaults,
  };
  try {
    expect((await page.request.put('/api/settings', { data: configured })).ok()).toBeTruthy();
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page');
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    const extraction = settings.getByRole('region', { name: '资料提取模型设置', exact: true });
    const planning = settings.getByRole('region', { name: '剧情规划模型设置', exact: true });
    await expect(extraction.getByRole('checkbox', { name: '资料提取自动重试', exact: true })).not.toBeChecked();
    await expect(extraction.getByRole('spinbutton', { name: '资料提取最多重试次数', exact: true })).toBeHidden();
    await extraction.getByRole('checkbox', { name: '资料提取自动重试', exact: true }).check();
    const retries = extraction.getByRole('spinbutton', { name: '资料提取最多重试次数', exact: true });
    const delay = extraction.getByRole('spinbutton', { name: '资料提取重试间隔（秒）', exact: true });
    await expect(retries).toHaveValue('2'); await expect(delay).toHaveValue('5');
    await retries.fill('11'); await delay.fill('');
    await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    await expect(retries).toHaveValue('11'); await expect(delay).toHaveValue('');
    let saves = 0;
    page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings') saves++; });
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.locator('.settings-feedback')).toContainText('数值不能大于 10'); expect(saves).toBe(0);
    await retries.fill('3'); await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.locator('.settings-feedback')).toContainText('请填写此项'); expect(saves).toBe(0);
    await delay.fill('1.25');
    await planning.getByRole('combobox', { name: '剧情规划方式', exact: true }).selectOption('tool');
    await expect(planning).toContainText('update_plot_plan');
    await expect(planning.getByRole('textbox', { name: '剧情规划模型名称', exact: true })).toHaveValue('e2e-planning');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    const saved = await (await page.request.get('/api/settings')).json();
    expect(saved.taskSettings).toEqual({ extraction: { autoRetry: true, maxRetries: 3, retryDelayMs: 1250 }, planning: { enabled: true, mode: 'tool' } });
    expect(saved.planningProviderId).toBe(providerId); expect(saved.planningModel).toBe('e2e-planning');
    await page.screenshot({ path: testInfo.outputPath('task-controls-desktop.png'), animations: 'disabled', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await extraction.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('task-controls-mobile.png'), animations: 'disabled' });
    await planning.getByRole('checkbox', { name: '启用剧情规划', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('task-controls-planning-mobile.png'), animations: 'disabled' });
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    await settings.getByRole('button', { name: '返回作品', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    await expect(retries).toHaveValue('3'); await expect(delay).toHaveValue('1.25');
    await expect(planning.getByRole('combobox', { name: '剧情规划方式', exact: true })).toHaveValue('tool');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('规划开关和工具模式即时约束独立规划入口，已有规划仍可编辑', async ({ page }) => {
  await taskSettingsAuthentication(page);
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    expect((await page.request.put('/api/settings', { data: { ...previous, taskSettings: taskSettingsDefaults } })).ok()).toBeTruthy();
    await createProject(page, '任务控制规划入口验收'); await tab(page, '剧情与伏笔');
    const plan = page.getByRole('button', { name: '让 AI 规划', exact: true });
    await expect(plan).toBeEnabled();
    await page.getByRole('button', { name: '添加章节规划', exact: true }).click();
    await page.getByRole('textbox', { name: '规划章节标题', exact: true }).fill('保存的作者规划');
    await page.getByRole('textbox', { name: '本章目标', exact: true }).fill('保留已有规划的内容。');
    await page.getByRole('button', { name: '保存世界观与预期规划', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存世界观与预期规划', exact: true })).toBeDisabled();

    const branchId = await page.getByRole('combobox', { name: '当前故事线', exact: true }).inputValue();
    const branch = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    // Stable task states cover the buttons without restarting any model request.
    const taskFixtures = [
      { id: 'separate-failed', status: 'failed', message: '独立规划失败任务' },
      { id: 'separate-paused', status: 'paused', message: '独立规划暂停任务' },
      { id: 'summary-failed', status: 'failed', message: '摘要压缩失败任务', purpose: 'compress-summary' },
      { id: 'summary-paused', status: 'paused', message: '摘要压缩暂停任务', purpose: 'compress-summary' },
    ].map(task => ({ ...task, kind: 'plan', projectId: branch.branch.projectId, branchId, baseRevisionId: branch.branch.revisionId, progress: 0, total: 1, inputTokens: 0, outputTokens: 0, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', payload: {} }));
    await page.route(url => url.pathname === '/api/jobs', route => route.fulfill({ json: taskFixtures }));
    const taskCard = (message: string) => page.locator('.job-card').filter({ hasText: message });
    async function checkBlockedTaskActions() {
      await tab(page, '任务');
      await expect(taskCard('独立规划失败任务').getByRole('button', { name: '重试', exact: true })).toBeDisabled();
      await expect(taskCard('独立规划暂停任务').getByRole('button', { name: '继续', exact: true })).toBeDisabled();
      await expect(taskCard('摘要压缩失败任务').getByRole('button', { name: '重试', exact: true })).toBeEnabled();
      await expect(taskCard('摘要压缩暂停任务').getByRole('button', { name: '继续', exact: true })).toBeEnabled();
      await tab(page, '剧情与伏笔');
    }
    async function changePlanning(enabled: boolean, mode: 'separate' | 'tool') {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.getByTestId('settings-page');
      await settings.getByRole('button', { name: '任务模型', exact: true }).click();
      const planning = settings.getByRole('region', { name: '剧情规划模型设置', exact: true });
      await planning.getByRole('checkbox', { name: '启用剧情规划', exact: true }).setChecked(enabled);
      if (enabled) await planning.getByRole('combobox', { name: '剧情规划方式', exact: true }).selectOption(mode);
      await settings.getByRole('button', { name: '保存设置', exact: true }).click();
      await expect(settings.getByRole('status')).toContainText('设置已保存');
      await settings.getByRole('button', { name: '返回作品', exact: true }).click();
    }
    await changePlanning(false, 'separate'); await expect(plan).toBeDisabled();
    await expect(page.getByText('剧情规划已关闭，写作不使用预期规划。已有规划仍可查看和手动编辑。', { exact: true })).toBeVisible();
    await checkBlockedTaskActions();
    await expect(page.getByRole('textbox', { name: '规划章节标题', exact: true })).toHaveValue('保存的作者规划');
    await page.getByRole('textbox', { name: '本章目标', exact: true }).fill('关闭 AI 规划后仍可修改。');
    await page.getByRole('button', { name: '保存世界观与预期规划', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存世界观与预期规划', exact: true })).toBeDisabled();
    await changePlanning(true, 'tool'); await expect(plan).toBeDisabled();
    await expect(page.getByText('剧情规划使用写作 AI 工具，由写作 AI 提交当前章及后 3 章的规划，随正文一起保存。', { exact: true })).toBeVisible();
    await checkBlockedTaskActions();
    await expect(page.getByRole('textbox', { name: '本章目标', exact: true })).toHaveValue('关闭 AI 规划后仍可修改。');
    await changePlanning(true, 'separate'); await expect(plan).toBeEnabled();
    await tab(page, '任务');
    await expect(taskCard('独立规划失败任务').getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    await expect(taskCard('独立规划暂停任务').getByRole('button', { name: '继续', exact: true })).toBeEnabled();
    await tab(page, '剧情与伏笔');
    await plan.click(); await expect(page.getByRole('dialog')).toContainText('规划下一段故事');
    await expect(page.getByRole('button', { name: '开始规划', exact: true })).toBeEnabled();
  } finally { await page.request.put('/api/settings', { data: previous }); }
});
