import { showGenerationProcess } from './branch-browser-helpers';
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
const password = 'browser-test-password-123';
const source = '场景01｜入城\n\n原文正文 SENTINEL_IMPORT_BODY。\n\n场景02｜夜谈\n\n第二段正文。\n\n场景03｜远行\n尾段正文。';
const mockUrl = `http://127.0.0.1:${process.env.E2E_MODEL_PORT || '4329'}/v1`;
let titleSettings: any;
test.beforeEach(async ({ page }, testInfo) => {
  expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  if (testInfo.title.startsWith('标题修复：')) {
    titleSettings = await (await page.request.get('/api/settings')).json();
    expect((await page.request.put('/api/settings', { data: { ...titleSettings, providers: [...titleSettings.providers, { id: 'e2e-title-repair', name: '标题修复本地模型', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: 'fake-title-repair' }], extractionProviderId: 'e2e-title-repair', extractionModel: 'e2e-title-repair' } })).ok()).toBeTruthy();
  }
});
test.afterEach(async ({ page }, testInfo) => { if (testInfo.title.startsWith('标题修复：') && titleSettings) { await page.request.put('/api/settings', { data: titleSettings }); titleSettings = undefined; } });
async function openImport(page: Page, title: string, text = source) {
  const project = await (await page.request.post('/api/projects', { data: { title } })).json();
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${title}`, exact: true }).click();
  await showGenerationProcess(page);
  if ((page.viewportSize()?.width ?? 1440) < 760) await page.getByRole('button', { name: '打开章节目录', exact: true }).click();
  await page.getByRole('button', { name: '导入小说', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('input[type=file]').setInputFiles({ name: 'rules-source.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  await expect(modal.getByTestId('import-rules')).toBeVisible();
  return { project, modal, rules: modal.getByTestId('import-rules') };
}

test('标题修复：手机导入预览核对原始标题，编辑建议后只应用标题', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const text = '第16章 雨夜\n\n林舟来到码头寻找刚刚失踪的守城人。';
  const { modal } = await openImport(page, '手机标题修复预览', text);
  const original = await modal.getByLabel('章节正文', { exact: true }).inputValue();
  await modal.getByLabel('章节名称', { exact: true }).fill('第12章 错题');
  await modal.locator('.import-title-repair > summary').click();
  const repair = modal.getByTestId('chapter-title-repair');
  await repair.getByRole('button', { name: '生成标题修复建议', exact: true }).click();
  const suggestion = repair.getByLabel('建议标题：第12章 错题', { exact: true });
  await expect(suggestion).toHaveValue('第16章 雨夜');
  await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('第12章 错题');
  await suggestion.fill('第16章 作者确认题名');
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('title-repair-import-mobile.png'), animations: 'disabled' });
  await repair.getByRole('button', { name: '应用到导入预览（1）', exact: true }).click();
  await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('第16章 作者确认题名');
  await expect(modal.getByLabel('章节正文', { exact: true })).toHaveValue(original);
  await expect(modal.getByRole('button', { name: '确认目录并整理', exact: true })).toBeEnabled();
});

test('标题修复：已保存章节可预览、选择应用和回退，版本冲突保留作者修改', async ({ page }, testInfo) => {
  const title = '已保存标题修复';
  const project = await (await page.request.post('/api/projects', { data: { title } })).json();
  let view = await (await page.request.get(`/api/branches/${project.mainBranchId}?view=author`)).json();
  const saved = await (await page.request.post(`/api/branches/${project.mainBranchId}/chapters?view=author`, { data: { baseRevisionId: view.branch.revisionId, title: '第12章 错题', text: '第16章 雨夜\n\n林舟来到码头寻找刚刚失踪的守城人。' } })).json();
  const chapterId = saved.state.chapters[0].id;
  await expect.poll(async () => (await (await page.request.get(`/api/branches/${project.mainBranchId}?view=author`)).json()).state.chapters[0].status).toBe('ready');
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${title}`, exact: true }).click(); await showGenerationProcess(page);
  await page.locator('.chapter-item').first().click(); await page.locator('.chapter-actions > summary').click(); await page.getByRole('button', { name: 'AI 修复章节标题', exact: true }).click();
  const repair = page.getByTestId('chapter-title-repair');
  await repair.getByRole('button', { name: '生成标题修复建议', exact: true }).click();
  await expect(repair.getByLabel('建议标题：第12章 错题', { exact: true })).toHaveValue('第16章 雨夜');
  await expect(page.locator('.chapter-item-content strong')).toHaveText('第12章 错题');
  view = await (await page.request.get(`/api/branches/${project.mainBranchId}?view=author`)).json();
  const original = await (await page.request.get(`/api/branches/${project.mainBranchId}/chapters/${chapterId}`)).json();
  await page.request.post(`/api/branches/${project.mainBranchId}/chapters?view=author`, { data: { baseRevisionId: view.branch.revisionId, chapterId, title: '作者刚改的标题', text: original.text } });
  await repair.getByRole('button', { name: '应用所选标题（1）', exact: true }).click();
  await expect(repair).toContainText('故事线已有新版本');
  expect((await (await page.request.get(`/api/branches/${project.mainBranchId}/chapters/${chapterId}`)).json()).title).toBe('作者刚改的标题');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: `打开作品 ${title}`, exact: true }).click(); await showGenerationProcess(page); await page.locator('.chapter-item').first().click();
  await page.locator('.chapter-actions > summary').click(); await page.getByRole('button', { name: 'AI 修复章节标题', exact: true }).click();
  await repair.getByRole('button', { name: '生成标题修复建议', exact: true }).click();
  await expect(repair.getByLabel('建议标题：作者刚改的标题', { exact: true })).toHaveValue('第16章 雨夜');
  await repair.getByRole('checkbox', { name: '应用标题：作者刚改的标题', exact: true }).uncheck();
  await expect(repair.getByRole('button', { name: '应用所选标题（0）', exact: true })).toBeDisabled();
  await repair.getByRole('checkbox', { name: '应用标题：作者刚改的标题', exact: true }).check();
  await page.screenshot({ path: testInfo.outputPath('title-repair-existing-desktop.png'), animations: 'disabled' });
  const before = (await (await page.request.get(`/api/branches/${project.mainBranchId}?view=author`)).json()).branch.revisionId;
  await repair.getByRole('button', { name: '应用所选标题（1）', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.chapter-item-content strong')).toHaveText('第16章 雨夜');
  const after = await (await page.request.get(`/api/branches/${project.mainBranchId}?view=author`)).json();
  expect((await (await page.request.get(`/api/branches/${project.mainBranchId}/chapters/${chapterId}`)).json()).text).toBe(original.text);
  expect((await page.request.post(`/api/branches/${project.mainBranchId}/rollback`, { data: { baseRevisionId: after.branch.revisionId, revisionId: before } })).ok()).toBe(true);
  expect((await (await page.request.get(`/api/branches/${project.mainBranchId}/chapters/${chapterId}`)).json()).title).toBe('作者刚改的标题');
});

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

test('按字数分章：桌面调整字数、预览撤销、保存修改规则并重开复用', async ({ page }, testInfo) => {
  const text = '甲'.repeat(85) + '\n\n' + '乙'.repeat(85) + '\n\n' + '丙'.repeat(40);
  const { modal, rules } = await openImport(page, '桌面按字数导入', text);
  const chapters = modal.getByRole('navigation', { name: '导入章节目录' }).getByRole('button');
  await modal.getByLabel('章节名称', { exact: true }).fill('保留的手动题名');
  await rules.getByRole('combobox', { name: '分章规则', exact: true }).selectOption('length');
  await expect(rules.getByLabel('每章字数', { exact: true })).toHaveValue('3000');
  await rules.getByLabel('每章字数', { exact: true }).fill('');
  await expect(rules.getByRole('button', { name: '按所选规则重新分章', exact: true })).toBeDisabled();
  await rules.getByLabel('每章字数', { exact: true }).fill('99');
  await expect(rules.getByRole('button', { name: '按所选规则重新分章', exact: true })).toBeDisabled();
  await rules.getByLabel('每章字数', { exact: true }).fill('100');
  await expect(chapters).toHaveCount(1);
  await rules.getByRole('button', { name: '按所选规则重新分章', exact: true }).click();
  await expect(chapters).toHaveCount(3);
  await expect(rules.getByRole('status')).toContainText('每章 100 字分成 3 章');
  await expect(modal.getByLabel('章节正文', { exact: true })).toHaveValue('甲'.repeat(85));
  await modal.getByRole('button', { name: '撤销上次重新分章', exact: true }).click();
  await expect(chapters).toHaveCount(1);
  await expect(modal.getByLabel('章节名称', { exact: true })).toHaveValue('保留的手动题名');
  await expect(modal.getByLabel('章节正文', { exact: true })).toHaveValue(text);
  await rules.getByRole('button', { name: '添加规则', exact: true }).click();
  await expect(rules.getByLabel('分章方式', { exact: true })).toHaveValue('length');
  await expect(rules.getByLabel('每章目标字数', { exact: true })).toHaveValue('100');
  await rules.getByLabel('规则名称', { exact: true }).fill('浏览器字数规则');
  await rules.getByRole('button', { name: '保存新规则', exact: true }).click();
  await expect(rules.getByRole('status')).toContainText('规则已保存');
  await expect(chapters).toHaveCount(1);
  await rules.getByLabel('每章目标字数', { exact: true }).fill('200');
  await rules.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(rules.getByLabel('每章字数', { exact: true })).toHaveValue('200');
  await rules.getByRole('button', { name: '按所选规则重新分章', exact: true }).click();
  await expect(chapters).toHaveCount(2);
  await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '导入小说', exact: true }).click();
  await modal.getByRole('button', { name: '继续分章', exact: true }).click();
  await expect(chapters).toHaveCount(1);
  await rules.getByRole('combobox', { name: '分章规则', exact: true }).selectOption({ label: '浏览器字数规则' });
  await expect(rules.getByLabel('每章字数', { exact: true })).toHaveValue('200');
  await rules.getByRole('button', { name: '按所选规则重新分章', exact: true }).click();
  await expect(chapters).toHaveCount(2);
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('length-rules-desktop.png'), animations: 'disabled' });
});

test('按字数分章：手机拆分无换行正文、重命名并确认导入，原文件保留', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    expect((await page.request.put('/api/settings', { data: { ...previous, providers: [...previous.providers, { id: 'e2e-length-rule', name: '字数导入本地模型', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: 'fake-length-rule-key' }], extractionProviderId: 'e2e-length-rule', extractionModel: 'e2e-length-rule-model' } })).ok()).toBeTruthy();
    await page.setViewportSize({ width: 390, height: 844 });
    const text = '🙂𠮷甲。'.repeat(65);
    const { modal, rules, project } = await openImport(page, '手机按字数导入', text);
    await rules.getByRole('combobox', { name: '分章规则', exact: true }).selectOption('length');
    await rules.getByLabel('每章字数', { exact: true }).fill('100');
    await rules.getByRole('button', { name: '按所选规则重新分章', exact: true }).click();
    await expect(modal.getByRole('navigation', { name: '导入章节目录' }).getByRole('button')).toHaveCount(3);
    await expect(modal.getByLabel('章节正文', { exact: true })).toHaveValue('🙂𠮷甲。'.repeat(25));
    await expect(modal.locator('.import-content .hint')).toHaveText('100 字');
    await modal.getByLabel('章节名称', { exact: true }).fill('作者命名首章');
    expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('length-rules-mobile.png'), animations: 'disabled' });
    await modal.getByRole('button', { name: '确认目录并整理', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.job-card .status-pill.completed')).toHaveCount(1);
    const detail = await (await page.request.get(`/api/projects/${project.id}`)).json();
    expect(detail.sources[0]).toMatchObject({ confirmed: true, chapterCount: 3 });
    const imported = await (await page.request.get(`/api/sources/${detail.sources[0].id}/preview`)).json();
    expect(imported.chapters[0].title).toBe('作者命名首章');
    expect(imported.chapters.map((chapter: any) => chapter.text).join('')).toBe(text);
    expect(await (await page.request.get(`/api/sources/${detail.sources[0].id}/file`)).text()).toBe(text);
  } finally { await page.request.put('/api/settings', { data: previous }); }
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
