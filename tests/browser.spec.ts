import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

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

test.afterAll(async () => {
  // Gracefully end only our isolated fixture; avoid Windows process-tree teardown hangs.
  await fetch(`${mockUrl.slice(0, -3)}/__e2e/shutdown`, { method: 'POST' });
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
  await page.getByRole('button', { name: '供应商设置', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: '添加供应商连接', exact: true }).click();
  await modal.getByLabel('供应商名称', { exact: true }).fill('本地浏览器验收模型');
  await modal.getByLabel('服务地址', { exact: true }).fill(mockUrl);
  await modal.getByLabel(/API 密钥/).fill('e2e-not-a-real-api-key');
  let listRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/settings/models') listRequests++; });
  await modal.getByRole('combobox', { name: '正文写作供应商', exact: true }).selectOption({ index: 1 });
  await expect(modal.getByRole('combobox', { name: '正文写作上游模型', exact: true })).toBeEnabled();
  await expect(modal.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('');
  await modal.getByRole('combobox', { name: '大纲规划供应商', exact: true }).selectOption({ index: 1 });
  await modal.getByRole('combobox', { name: '资料提取供应商', exact: true }).selectOption({ index: 1 });
  await modal.getByRole('combobox', { name: '正文写作上游模型', exact: true }).selectOption('e2e-fixture');
  await modal.getByRole('combobox', { name: '大纲规划上游模型', exact: true }).selectOption('e2e-planning');
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
  await expect(modal.getByLabel(/API 密钥/)).toHaveValue('');
  const response = await page.request.get('/api/settings');
  const saved = await response.json();
  expect(JSON.stringify(saved)).not.toContain('e2e-not-a-real-api-key');
  expect(saved.providers).toHaveLength(1);
  expect(saved.providers[0].model).toBeUndefined();
  expect(saved).toMatchObject({ writingModel: 'e2e-fixture', planningModel: 'e2e-planning', extractionModel: 'e2e-custom-extraction' });
  await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
});

test('原创生成保存正文、四章细纲及隐藏伏笔，阅读接口不返回作者秘密', async ({ page }, testInfo) => {
  const modelBefore = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
  await createProject(page, 'E2E 原创世界');
  await page.getByRole('button', { name: '开始创作', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('章节标题（可选）', { exact: true }).fill('第一章 城门的钥匙');
  await modal.getByLabel('这一次，你想写什么？', { exact: true }).fill('让林舟发现白石城城门下的旧钥匙。');
  await modal.getByRole('button', { name: '开始生成', exact: true }).click();
  await completedJobs(page, 1);
  const modelAfter = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
  for (const model of ['e2e-fixture', 'e2e-planning', 'e2e-custom-extraction']) expect((modelAfter.modelRequestsByModel[model] || 0) - (modelBefore.modelRequestsByModel[model] || 0)).toBeGreaterThan(0);
  await tab(page, '正文');
  await page.locator('.chapter-list').getByRole('button', { name: /第一章 城门的钥匙/ }).click();
  await expect(page.locator('.prose')).toContainText('林舟来到白石城');
  await page.screenshot({ path: testInfo.outputPath('desktop-writing.png'), fullPage: true, animations: 'disabled' });
  await tab(page, '大纲与伏笔');
  await expect(page.getByRole('textbox', { name: /粗大纲/ })).toHaveValue(/林舟从白石城出发/);
  await expect(page.getByLabel('规划章节标题', { exact: true })).toHaveCount(4);
  await page.getByRole('button', { name: /^伏笔手记/ }).click();
  await expect(page.getByRole('textbox', { name: '隐藏的真相', exact: true })).toHaveValue(/SECRET_E2E_FORESHADOW/);
  const branchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
  await page.getByRole('button', { name: '返回阅读视图', exact: true }).click();
  await expect(page.locator('.workspace-tabs').getByRole('button', { name: '大纲与伏笔' })).toHaveCount(0);
  const reader = await page.request.get(`/api/branches/${branchId}`);
  expect(await reader.text()).not.toContain('SECRET_E2E_FORESHADOW');
  const search = await page.request.get(`/api/branches/${branchId}/search?q=SECRET_E2E_FORESHADOW`);
  expect((await search.json()).entities).toEqual([]);
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
  await modal.getByRole('textbox', { name: '资料描述', exact: true }).fill('用户确认：林舟是一位善于观察的旅人。');
  await modal.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(page.locator('.entity-description')).toContainText(['用户确认：林舟是一位善于观察的旅人。', '故事中出现的城池。']);
  await page.screenshot({ path: testInfo.outputPath('desktop-world.png'), fullPage: true, animations: 'disabled' });
});

test('导入时确认目录，后台整理完成后从资料跳回原文段落', async ({ page }) => {
  await createProject(page, 'E2E 导入小说');
  await importNovel(page);
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
  await expect(page.getByRole('img', { name: '地点与人物关系图', exact: true })).toBeVisible();
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
  const changed = await page.request.put(`/api/branches/${branchId}/outline`, { data: { baseRevisionId: view.branch.revisionId, outline: { ...view.state.outline, coarse: '另一台设备刚刚保存的大纲。' } } });
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
  await page.goto('/'); await page.getByRole('button', { name: '供应商设置', exact: true }).click();
  const modal = page.getByRole('dialog');
  const writing = modal.getByRole('region', { name: '正文写作模型设置', exact: true });
  await writing.locator('summary').filter({ hasText: '生成参数与思考设置' }).click();
  await writing.getByLabel(/^温度（temperature）/).fill('0'); await writing.getByLabel(/^Top P/).fill('0.8');
  await writing.getByLabel(/^随机种子（seed）/).fill('0'); await writing.getByLabel(/^请求超时（秒）/).fill('240');
  await writing.getByLabel(/^返回方式/).selectOption('true');
  await modal.getByLabel('接口协议', { exact: true }).selectOption('gemini');
  await expect(modal.getByLabel('服务地址', { exact: true })).toHaveValue(mockUrl);
  await writing.getByLabel(/^Gemini 思考方式/).selectOption('level'); await writing.getByLabel(/^Gemini 思考等级/).selectOption('low');
  await writing.getByLabel('Gemini 返回思考摘要', { exact: true }).selectOption('true');
  await modal.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(modal.getByRole('status')).toContainText('设置已保存');
  const geminiSaved = await (await page.request.get('/api/settings')).json();
  expect(geminiSaved.modelParameters.find((value: any) => value.role === 'writing' && value.providerId === providerId && value.model === 'e2e-fixture')).toMatchObject({ temperature: 0, seed: 0, stream: true, timeoutMs: 240000, geminiThinking: { mode: 'level', level: 'low' }, geminiIncludeThoughts: true });
  expect(geminiSaved.providers[0]).not.toHaveProperty('temperature');
  await modal.getByLabel('接口协议', { exact: true }).selectOption('openai-chat');
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
  await modal.getByLabel('接口协议', { exact: true }).selectOption('gemini');
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
  await page.goto('/'); await page.getByRole('button', { name: '供应商设置', exact: true }).click();
  const modal = page.getByRole('dialog');
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
    await page.goto('/'); await page.getByRole('button', { name: '供应商设置', exact: true }).click();
    const modal = page.getByRole('dialog');
    await entered;
    await modal.getByRole('combobox', { name: '正文写作供应商', exact: true }).selectOption(newId);
    await expect(modal.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('');
    const models = modal.getByRole('combobox', { name: '正文写作上游模型', exact: true });
    await expect(models).toBeEnabled();
    await models.selectOption('new-provider-model');
    release(); await delivered;
    await expect(models.locator('option')).toHaveText(['选择上游模型', 'new-provider-model']);
    await expect(modal.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('new-provider-model');
    await modal.getByLabel('服务地址', { exact: true }).nth(1).fill(mockUrl + '/changed');
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
  await page.goto('/'); await page.getByRole('button', { name: '供应商设置', exact: true }).click();
  let modal = page.getByRole('dialog');
  const writing = modal.getByRole('region', { name: '正文写作模型设置', exact: true });
  const planning = modal.getByRole('region', { name: '大纲规划模型设置', exact: true });
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
  await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '供应商设置', exact: true }).click();
  modal = page.getByRole('dialog');
  await writing.locator('summary').filter({ hasText: '生成参数与思考设置' }).click();
  await expect(writing.getByLabel(/^Top P/)).toHaveValue('');
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('0.6');
  await expect(planning.getByLabel(/^温度（temperature）/)).toHaveValue('0.3');
  await expect(extraction.getByLabel(/^温度（temperature）/)).toHaveValue('0.2');
  for (const [task, role, temperature, maxTokens, effort] of [[planning, 'planning', 0.3, 2048, 'low'], [extraction, 'extraction', 0.2, 16384, 'high']] as const) {
    const testing = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/settings/test');
    await task.getByRole('button', { name: role === 'planning' ? '大纲规划保存并测试连接' : '资料提取保存并测试连接', exact: true }).click();
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
  await page.getByRole('button', { name: '供应商设置', exact: true }).click();
  const modal = page.getByRole('dialog');
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
  await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();

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
