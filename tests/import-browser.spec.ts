import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
const password = 'browser-test-password-123';
const source = '场景01｜入城\n\n原文正文 SENTINEL_IMPORT_BODY。\n\n场景02｜夜谈\n\n第二段正文。\n\n场景03｜远行\n尾段正文。';
const mockUrl = `http://127.0.0.1:${process.env.E2E_MODEL_PORT || '4329'}/v1`;
test.beforeEach(async ({ page }) => { expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy(); });
async function openImport(page: Page, title: string, text = source) {
  const project = await (await page.request.post('/api/projects', { data: { title } })).json();
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${title}`, exact: true }).click();
  await page.getByRole('button', { name: '查看作者资料', exact: true }).click();
  if ((page.viewportSize()?.width ?? 1440) < 760) await page.getByRole('button', { name: '打开章节目录', exact: true }).click();
  await page.getByRole('button', { name: '导入小说', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('input[type=file]').setInputFiles({ name: 'rules-source.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  await expect(modal.getByTestId('import-rules')).toBeVisible();
  return { project, modal, rules: modal.getByTestId('import-rules') };
}

test('分章规则：选择内置规则，保存和修改自定义规则，重开复用且可撤销手动调整', async ({ page }, testInfo) => {
  const { modal, rules } = await openImport(page, '浏览器自定义分章规则');
  await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('正文');
  await modal.getByLabel('章节名称', { exact: true }).fill('手动保留的名字');
  await rules.getByRole('button', { name: '添加规则', exact: true }).click();
  await rules.getByLabel('规则名称', { exact: true }).fill('浏览器场景规则');
  await rules.getByLabel('标题匹配表达式', { exact: true }).fill('场景[0-9]+｜.+');
  await rules.getByRole('button', { name: '预览这条规则', exact: true }).click();
  await expect(modal.getByRole('navigation', { name: '导入章节目录' }).getByRole('button')).toHaveCount(3);
  await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('场景01｜入城');
  await modal.getByRole('button', { name: '撤销上次重新分章', exact: true }).click();
  await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('手动保留的名字');
  await rules.getByRole('button', { name: '保存新规则', exact: true }).click();
  await expect(rules.getByRole('status')).toContainText('规则已保存');
  await rules.getByRole('button', { name: '按所选规则重新分章', exact: true }).click();
  await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('场景01｜入城');
  await rules.getByLabel('规则名称', { exact: true }).fill('浏览器场景改名规则');
  await rules.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(rules.getByRole('combobox', { name: '分章规则', exact: true }).getByRole('option', { name: '浏览器场景改名规则', exact: true })).toHaveCount(1);
  await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '导入小说', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '继续分章', exact: true }).click();
  await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('正文');
  await rules.getByRole('combobox', { name: '分章规则', exact: true }).selectOption({ label: '浏览器场景改名规则' });
  await rules.getByRole('button', { name: '按所选规则重新分章', exact: true }).click();
  await expect(modal.getByRole('navigation', { name: '导入章节目录' }).getByRole('button')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('import-rules-desktop.png'), animations: 'disabled' });
  await rules.getByRole('combobox', { name: '分章规则', exact: true }).selectOption('english');
  await rules.getByRole('button', { name: '按所选规则重新分章', exact: true }).click();
  await expect(rules.getByRole('status')).toContainText('没有匹配到标题');
  await expect(modal.getByLabel('章节正文', { exact: true })).toHaveValue(/场景03｜远行/);
  await rules.getByRole('combobox', { name: '分章规则', exact: true }).selectOption({ label: '浏览器场景改名规则' });
  await rules.getByRole('button', { name: '删除规则', exact: true }).click();
  await expect(rules.getByRole('status')).toContainText('已删除');
});

test('分章规则：手机选择原文章节名生成 AI 候选，诊断可见，预览保存后确认导入', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    expect((await page.request.put('/api/settings', { data: { ...previous, providers: [...previous.providers, { id: 'e2e-import-rule', name: '分章本地模型', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: 'fake-import-rule-key' }], extractionProviderId: 'e2e-import-rule', extractionModel: 'e2e-import-rule-model' } })).ok()).toBeTruthy();
    await page.setViewportSize({ width: 390, height: 844 });
    const { modal, rules, project } = await openImport(page, '手机 AI 分章规则');
    await rules.locator('summary').getByText('选中章节名，让 AI 生成规则', { exact: true }).click();
    await rules.getByLabel('查找原文标题', { exact: true }).fill('场景');
    await rules.getByRole('button', { name: '查找标题', exact: true }).click();
    await rules.getByRole('checkbox', { name: '勾选章节名：场景01｜入城（第 1 行）', exact: true }).check();
    await expect(rules.getByRole('button', { name: '生成新规则', exact: true })).toBeDisabled();
    await rules.getByRole('checkbox', { name: '勾选章节名：场景02｜夜谈（第 5 行）', exact: true }).check();
    await rules.getByLabel('给 AI 的补充要求（可选）', { exact: true }).fill('只匹配场景标题');
    await rules.getByRole('button', { name: '生成新规则', exact: true }).click();
    await expect(rules.getByLabel('规则名称', { exact: true })).toHaveValue('AI 场景编号');
    await expect(rules.getByRole('status')).toContainText('预计分成 3 章');
    await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('正文');
    await rules.getByLabel('规则名称', { exact: true }).fill('手机 AI 场景规则');
    await rules.getByRole('button', { name: '预览这条规则', exact: true }).click();
    await expect(modal.getByRole('navigation', { name: '导入章节目录' }).getByRole('button')).toHaveCount(3);
    await rules.locator('.request-diagnostics > summary').click();
    await rules.getByText('实际请求体（含提示词）', { exact: true }).click();
    const body = rules.getByLabel('实际请求体', { exact: true }); await expect(body).toContainText('场景01'); await expect(body).not.toContainText('SENTINEL_IMPORT_BODY'); await expect(body).not.toContainText('场景03');
    expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('import-rules-mobile.png'), animations: 'disabled' });
    await rules.getByRole('button', { name: '保存新规则', exact: true }).click();
    await expect(rules.getByRole('status')).toContainText('规则已保存');
    const applied = await (await page.request.get(`/api/projects/${project.id}`)).json(); expect(applied.sources[0].confirmed).toBe(false);
    await modal.getByRole('button', { name: '确认目录并整理', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.job-card .status-pill.completed')).toHaveCount(1);
    const detail = await (await page.request.get(`/api/projects/${project.id}`)).json(); expect(detail.sources[0]).toMatchObject({ confirmed: true, chapterCount: 3 });
    expect(await (await page.request.get(`/api/sources/${detail.sources[0].id}/file`)).text()).toBe(source);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('分章规则：无效表达式和 AI 失败保留原预览，补充要求和模型错误可见', async ({ page }) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    expect((await page.request.put('/api/settings', { data: { ...previous, providers: [...previous.providers, { id: 'e2e-import-rule-fail', name: '失败模拟模型', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: 'fake-key' }], extractionProviderId: 'e2e-import-rule-fail', extractionModel: 'e2e-http500' } })).ok()).toBeTruthy();
    const { modal, rules } = await openImport(page, '分章错误处理');
    await rules.getByRole('button', { name: '添加规则', exact: true }).click();
    await rules.getByLabel('标题匹配表达式', { exact: true }).fill('(');
    await rules.getByRole('button', { name: '预览这条规则', exact: true }).click();
    await expect(rules.getByRole('alert')).toContainText('表达式格式无效');
    await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('正文');
    await rules.locator('summary').getByText('选中章节名，让 AI 生成规则', { exact: true }).click();
    await rules.getByRole('checkbox', { name: '勾选章节名：场景01｜入城（第 1 行）', exact: true }).check();
    await rules.getByRole('checkbox', { name: '勾选章节名：场景02｜夜谈（第 5 行）', exact: true }).check();
    await rules.getByRole('button', { name: '生成新规则', exact: true }).click();
    await expect(rules.getByRole('alert')).toContainText('500');
    await expect(rules.locator('.request-diagnostics > summary')).toContainText('HTTP 500');
    await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('正文');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});
