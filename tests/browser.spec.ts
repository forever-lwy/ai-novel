import { chooseBranch, currentBranchId, showGenerationProcess } from './branch-browser-helpers';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { defaultPromptTemplates } from '../shared/prompt-templates';
import { withDramatronPresets, TAVERN_PRESET_IDS, NEUTRAL_PRESET_ID, tavernGeneralPresets } from './fixtures/prompt-presets';
import { TASK_V3_PRESET_IDS } from '../shared/task-prompts-v3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store } from '../server/store';
import { readingProgressStory, legacyReadingProgressStory, mixedVisibilityStory, readingPng } from './fixtures/reading-progress';
import type { Entity, StoryImage } from '../shared/types';
import { imageGroupKey } from '../shared/image-groups';
import { chapterEditHistoryStory, legacyChapterEdit } from './fixtures/chapter-edit-history';

// These tests exercise the real UI/server against a local HTTP model fixture.
// Passing them is not evidence of real-provider acceptance.
test.describe.configure({ mode: 'serial' });
const password = 'browser-test-password-123';
const mockUrl = `http://127.0.0.1:${process.env.E2E_MODEL_PORT || '4329'}/v1`;
const novel = '第一章 起点\n林舟来到白石城，看到城门下的石碑。\n\n他决定先去城中打听消息。\n\n第二章 灯火\n林舟在白石城找到一盏旧灯。\n\n旧灯照亮了深夜的长街。';

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.startsWith('初始账号登录，')) return;
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
  await showGenerationProcess(page);
  await expect(page.getByRole('button', { name: '阅读视图', exact: true })).toBeVisible();
}

async function tab(page: Page, title: string) {
  await page.locator('.workspace-tabs').getByRole('button', { name: new RegExp(`^${title}`) }).click();
}
async function openImageGroup(page: Page, image: StoryImage) {
  const key = imageGroupKey(image);
  if (await page.locator(`.image-group-versions[data-image-group="${key}"]`).isVisible()) return;
  const back = page.getByRole('button', { name: '返回图册', exact: true });
  if (await back.isVisible()) await back.click();
  await page.locator(`[data-open-image-group="${key}"]`).click();
  await expect(page.locator(`.image-group-versions[data-image-group="${key}"]`)).toBeVisible();
}
async function openChapterImageGroup(page: Page, image: StoryImage) {
  const section = page.locator('.chapter-images'); const key = imageGroupKey(image);
  if (await section.locator(`.chapter-image-versions[data-image-group="${key}"]`).isVisible()) return;
  const back = section.getByRole('button', { name: '返回本章插画', exact: true });
  if (await back.isVisible()) await back.click();
  await section.locator(`[data-open-image-group="${key}"]`).click();
  await expect(section.locator(`.chapter-image-versions[data-image-group="${key}"]`)).toBeVisible();
}
async function visibleProse(page: Page) { return (await page.locator('.manuscript .prose').allTextContents()).join(''); }

test('阅读开关只隐藏生成过程，保留未保存正文、编辑入口且不重新请求资料', async ({ page }) => {
  const project = await restoreToolbarStory(page, 'E2E 阅读显示开关');
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('长街');
  await expect(page.getByRole('button', { name: '阅读视图', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('章节标题', { exact: true }).fill('未保存的作者标题');
  const text = page.getByLabel('章节正文', { exact: true }); await text.fill('未保存正文，切换显示状态时必须原样保留。');
  let confirmations = 0; page.on('dialog', async dialog => { confirmations++; await dialog.dismiss(); });
  const requests: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === `/api/branches/${project.mainBranchId}` || url.pathname.startsWith(`/api/branches/${project.mainBranchId}/chapters/`)) requests.push(request.url()); });
  await page.getByRole('button', { name: '阅读视图', exact: true }).click();
  await expect(text).toHaveValue('未保存正文，切换显示状态时必须原样保留。');
  await expect(page.getByLabel('章节标题', { exact: true })).toHaveValue('未保存的作者标题');
  await expect(page.getByRole('button', { name: '保存正文', exact: true })).toBeEnabled();
  await expect(page.locator('.workspace-tabs').getByRole('button', { name: '剧情与伏笔', exact: true })).toBeVisible();
  await showGenerationProcess(page);
  await expect(text).toHaveValue('未保存正文，切换显示状态时必须原样保留。');
  expect(confirmations).toBe(0); expect(requests).toEqual([]);
});

async function openModelParameters(role: Locator) {
  const details = role.locator('.provider-parameters');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
}

async function selectModelTask(settings: Locator, name: string) {
  await settings.getByRole('tablist', { name: '任务模型分页', exact: true }).getByRole('tab', { name, exact: true }).click();
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

async function restoreToolbarStory(page: Page, title: string) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-toolbar-browser-')));
  let backup: Buffer;
  try {
    const project = store.createProject({ title });
    for (const name of ['起点', '长街']) {
      const text = Array.from({ length: 90 }, (_, index) => `林舟沿着白石城的长街向前走，仔细观察沿途的门窗和路灯。他在路口停下，记住第${index + 1}处石墙上的纹路。`).join('\n\n');
      const saved = store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: name, text });
      store.applyExtraction(project.mainBranchId, saved.branch.revisionId, saved.state.chapters.at(-1)!.id, { summary: '林舟沿着长街调查。', entities: [], relations: [], foreshadows: [] }, true);
    }
    backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: store.exportProject(project.id), sources: [] }));
  } finally { store.close(); }
  const restored = await page.request.post('/api/restore', { multipart: { file: { name: 'toolbar.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
  expect(restored.ok(), await restored.text()).toBeTruthy();
  return await restored.json() as { title: string; mainBranchId: string };
}

async function readingGeometry(page: Page) {
  return page.locator('.manuscript-wrap').evaluate(async element => {
    let previous = element.scrollTop; let stable = 0;
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline && stable < 6) {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const top = element.scrollTop;
      stable = Math.abs(top - previous) < 0.01 ? stable + 1 : 0; previous = top;
    }
    if (stable < 6) throw new Error('Reading scroll did not settle');
    const bounds = element.getBoundingClientRect();
    const paragraph = element.querySelector('.prose p')!.getBoundingClientRect();
    return { top: bounds.top, height: bounds.height, width: bounds.width, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, proseTop: paragraph.top + element.scrollTop };
  });
}

test('顶部继续创作在手机和桌面始终可见，阅读视图直接续写且不预建空章', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  const providerId = 'toolbar-local-provider';
  expect((await page.request.put('/api/settings', { data: { providers: [{ id: providerId, name: '工具栏本地验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: 'toolbar-fixture-key' }], writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture', imageSettings: { ...previous.imageSettings, autoPortrait: false, autoCG: false } } })).ok()).toBeTruthy();
  try {
    const project = await restoreToolbarStory(page, 'E2E 顶部续写');
    const path = `/api/branches/${project.mainBranchId}?view=author`;
    const before = await (await page.request.get(path)).json();
    let generationRequests = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/generate')) generationRequests++; });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
      await expect(page.locator('.manuscript h1')).toHaveText('长街');
      await expect(page.getByRole('button', { name: '阅读视图', exact: true })).toBeVisible();
      const button = page.locator('.workspace-toolbar-row').getByRole('button', { name: '继续创作', exact: true });
      await expect(button).toBeInViewport();
      await page.locator('.workspace-tabs').evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await expect(button).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
      if (width === 390 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`toolbar-continue-${width}.png`), animations: 'disabled' });
      await button.click();
      await expect(page.getByRole('dialog', { name: '让故事继续生长', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '阅读视图', exact: true })).toBeVisible();
      expect((await (await page.request.get(path)).json()).state.chapters).toHaveLength(2);
      expect(generationRequests).toBe(0);
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '打开章节目录', exact: true }).click();
    await page.locator('.chapter-item').filter({ hasText: '起点' }).click();
    await page.getByRole('button', { name: '阅读视图', exact: true }).click();
    await page.getByRole('button', { name: '继续创作', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('章节标题（可选）', { exact: true }).fill('快捷续写');
    const request = page.waitForRequest(value => value.method() === 'POST' && new URL(value.url()).pathname.endsWith('/generate'));
    await modal.getByRole('button', { name: '开始生成', exact: true }).click();
    expect((await request).postDataJSON()).toMatchObject({ baseRevisionId: before.branch.revisionId, mode: 'original', title: '快捷续写' });
    expect((await request).postDataJSON()).not.toHaveProperty('chapterId');
    await completedJobs(page, 2); await tab(page, '正文');
    await expect(page.locator('.manuscript h1')).toHaveText('快捷续写');
    const after = await (await page.request.get(path)).json();
    expect(after.state.chapters.slice(0, 2).map((chapter: { id: string }) => chapter.id)).toEqual(before.state.chapters.map((chapter: { id: string }) => chapter.id));
    expect(after.state.chapters).toHaveLength(3); expect(generationRequests).toBe(1);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('手机阅读工具栏随滚动收起，停下轻点中部展开，滑动和选字不误触', async ({ page, browser }, testInfo) => {
  const project = await restoreToolbarStory(page, 'E2E 手机阅读工具栏');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await page.context().storageState() });
  try {
    const mobile = await context.newPage();
    await mobile.goto('/'); await mobile.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).tap();
    const workspace = mobile.locator('.workspace'); const reader = mobile.locator('.manuscript-wrap');
    await expect(mobile.locator('.manuscript h1')).toHaveText('长街');
    const initialGeometry = await readingGeometry(mobile);
    const touch = await context.newCDPSession(mobile);
    const swipe = async () => {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 650 }] });
      for (const y of [600, 530, 450, 380, 330]) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y }] });
        await mobile.waitForTimeout(40); // Give the swipe a realistic touch velocity.
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe();
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    await expect(mobile.locator('.workspace-header')).toBeHidden(); await expect(mobile.locator('.workspace-toolbars')).toBeHidden();
    expect(await reader.evaluate(element => element.clientHeight)).toBe(initialGeometry.height);
    expect(await reader.evaluate(element => element.getBoundingClientRect().top)).toBe(0);
    await mobile.waitForTimeout(500); // Stopping alone must not reopen the bars.
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    expect(await readingGeometry(mobile)).toMatchObject({ top: initialGeometry.top, height: initialGeometry.height, scrollHeight: initialGeometry.scrollHeight, proseTop: initialGeometry.proseTop });
    await mobile.screenshot({ path: testInfo.outputPath('reading-toolbar-mobile-hidden.png'), animations: 'disabled' });
    await mobile.touchscreen.tap(30, 420); await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    await reader.evaluate(element => { element.scrollTop -= 80; });
    await reader.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 12, button: 0, clientX: 195, clientY: 420 });
    await reader.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 12, button: 0, clientX: 195, clientY: 420 });
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    await mobile.waitForTimeout(300);
    await reader.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 13, button: 0, clientX: 195, clientY: 620 });
    await reader.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 13, button: 0, clientX: 195, clientY: 420 });
    await reader.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 13, button: 0, clientX: 195, clientY: 420 });
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    await mobile.locator('.prose p').first().evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
    await reader.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 14, button: 0, clientX: 195, clientY: 420 });
    await reader.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 14, button: 0, clientX: 195, clientY: 420 });
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    await mobile.evaluate(() => getSelection()!.removeAllRanges());
    const beforeReveal = await readingGeometry(mobile);
    await mobile.touchscreen.tap(195, 420);
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
    expect(await readingGeometry(mobile)).toEqual(beforeReveal);
    await expect(mobile.getByRole('button', { name: '继续创作', exact: true })).toBeInViewport();
    await mobile.screenshot({ path: testInfo.outputPath('reading-toolbar-mobile-visible.png'), animations: 'disabled' });
    await mobile.getByRole('button', { name: '打开章节目录', exact: true }).tap();
    await mobile.locator('.chapter-item').filter({ hasText: '起点' }).tap();
    await expect(mobile.locator('.manuscript h1')).toHaveText('起点');
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
    await expect(mobile.locator('.chapter-sidebar')).not.toBeInViewport();
    await swipe();
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    await mobile.setViewportSize({ width: 320, height: 720 });
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    await showGenerationProcess(mobile);
    await expect(mobile.getByRole('button', { name: '阅读视图', exact: true })).toBeVisible();
    await swipe(); await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    await expect(mobile.locator('.workspace-header')).toBeHidden();
    await expect(mobile.locator('.workspace-toolbars')).toBeHidden();
    const authorBefore = await readingGeometry(mobile);
    await mobile.touchscreen.tap(160, 360);
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
    expect(await readingGeometry(mobile)).toEqual(authorBefore);
    await mobile.screenshot({ path: testInfo.outputPath('reading-toolbar-mobile-author-overlay.png'), animations: 'disabled' });
  } finally { await context.close(); }
});

test('桌面阅读下滚只收起正文工具栏，Logo 栏常显，上滚或移近顶部展开', async ({ page }, testInfo) => {
  const project = await restoreToolbarStory(page, 'E2E 桌面阅读工具栏');
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  const workspace = page.locator('.workspace'); const reader = page.locator('.manuscript-wrap');
  for (const width of [1440, 1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
    await reader.evaluate(element => { element.scrollTop += 80; });
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
    const beforeHide = await readingGeometry(page);
    await page.mouse.click(width / 2, 550); await page.mouse.wheel(0, 400);
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    await expect(page.locator('.workspace-header')).toBeInViewport();
    await expect(page.locator('.workspace-header-shell')).toHaveJSProperty('inert', false);
    if (width === 1440) await expect(page.locator('.workspace-header .brand')).toBeVisible();
    await expect(page.locator('.workspace-tabs')).toBeHidden();
    await expect(page.locator('.editor-toolbar')).toBeHidden();
    expect(await reader.evaluate(element => element.getBoundingClientRect().top)).toBe(await page.locator('.workspace-header').evaluate(element => element.getBoundingClientRect().bottom));
    const beforeReveal = await readingGeometry(page);
    expect(beforeReveal).toMatchObject({ top: beforeHide.top, height: beforeHide.height, scrollHeight: beforeHide.scrollHeight, proseTop: beforeHide.proseTop });
    await page.screenshot({ path: testInfo.outputPath(`reading-toolbar-desktop-${width}-hidden.png`), animations: 'disabled' });
    await page.mouse.move(width / 2, 20);
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
    expect(await readingGeometry(page)).toEqual(beforeReveal);
    await expect(page.getByRole('button', { name: '继续创作', exact: true })).toBeInViewport();
    await page.mouse.move(width / 2, 550); await page.mouse.wheel(0, 160);
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    await page.mouse.wheel(0, -100);
    await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
    await page.screenshot({ path: testInfo.outputPath(`reading-toolbar-desktop-${width}-visible.png`), animations: 'disabled' });
    await page.mouse.wheel(0, 180); await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
    await page.getByRole('button', { name: '设置', exact: true }).focus();
    const beforeKeyboard = await readingGeometry(page);
    await page.keyboard.press('Tab'); await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
    expect(await readingGeometry(page)).toEqual(beforeKeyboard);
  }
  await showGenerationProcess(page);
  await page.mouse.click(700, 550); await page.mouse.wheel(0, 300);
  await expect(workspace).toHaveAttribute('data-toolbar-state', 'hidden');
  await expect(page.locator('.workspace-header')).toBeInViewport();
  const authorBefore = await readingGeometry(page);
  await page.mouse.move(700, 20); await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
  expect(await readingGeometry(page)).toEqual(authorBefore);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('章节正文', { exact: true }).fill('尚未保存的手机与桌面编辑草稿。\n\n' + '沿着长街继续前行。\n\n'.repeat(100));
  await reader.evaluate(element => { element.scrollTop = 600; });
  await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
  await expect(page.getByRole('button', { name: '保存正文', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '继续创作', exact: true })).toBeDisabled();
  await tab(page, '世界资料');
  await page.locator('.workspace-main').evaluate(element => { element.scrollTop = 500; });
  await expect(workspace).toHaveAttribute('data-toolbar-state', 'visible');
  await tab(page, '正文');
  await expect(page.getByLabel('章节正文', { exact: true })).toHaveValue(/尚未保存的手机与桌面编辑草稿。/);
});

test('初始账号登录，一个供应商自动获取模型，三个任务各自选择或自定义且密钥不回显', async ({ page }, testInfo) => {
  const status = await page.request.get('/api/auth/status');
  expect(await status.json()).toEqual({ initialized: true, authenticated: false });
  expect(await status.text()).not.toContain(password);
  await page.goto('/');
  await expect(page.getByLabel('登录密码', { exact: true })).toHaveValue('');
  await page.getByLabel('登录密码', { exact: true }).fill(password);
  await expect(page.getByLabel('确认密码', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '进入工作台', exact: true }).click();
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
  await modal.getByRole('combobox', { name: '正文写作上游模型', exact: true }).selectOption('e2e-fixture');
  await selectModelTask(modal, '摘要压缩');
  await modal.getByRole('combobox', { name: '摘要压缩供应商', exact: true }).selectOption({ index: 1 });
  await modal.getByRole('combobox', { name: '摘要压缩上游模型', exact: true }).selectOption('e2e-planning');
  await selectModelTask(modal, '资料提取');
  await modal.getByRole('combobox', { name: '资料提取供应商', exact: true }).selectOption({ index: 1 });
  await modal.getByLabel('资料提取模型名称', { exact: true }).fill('e2e-custom-extraction');
  expect(listRequests).toBe(1);
  await selectModelTask(modal, '正文写作');
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

test('上游模型搜索按名称或 ID 筛选，保留已选与自定义模型，三个任务独立且手机可用', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  const providerId = 'e2e-model-search'; const otherId = 'e2e-model-search-other';
  const catalog = [
    { id: 'gpt-pro', name: '中文显示名称' }, { id: 'gpt-mini', name: 'GPT Mini' },
    { id: 'claude-fast', name: 'Claude Fast' }, { id: 'gemini-pro', name: 'Gemini Pro' },
  ];
  let listRequests = 0; let saveRequests = 0;
  const route = '**/api/settings/models';
  await page.route(route, intercepted => {
    listRequests++;
    const models = intercepted.request().postDataJSON().provider.id === providerId ? catalog : [{ id: 'other-model' }];
    return intercepted.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models }) });
  });
  page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings') saveRequests++; });
  try {
    expect((await page.request.put('/api/settings', { data: {
      providers: [providerId, otherId].map((id, index) => ({ id, name: index ? '另一目录' : '搜索目录', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' })),
      writingProviderId: providerId, writingModel: 'gpt-pro', planningProviderId: providerId, planningModel: 'gpt-mini', extractionProviderId: providerId, extractionModel: 'private-custom',
    } })).ok()).toBeTruthy();
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page');
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    const search = settings.getByRole('searchbox', { name: '正文写作搜索模型', exact: true });
    const models = settings.getByRole('combobox', { name: '正文写作上游模型', exact: true });
    const writing = settings.getByRole('region', { name: '正文写作模型设置', exact: true });
    await expect(search).toBeEnabled();
    await search.fill('  GPT-  ');
    await expect(models.locator('option')).toHaveText(['选择上游模型', '中文显示名称 · gpt-pro', 'GPT Mini · gpt-mini']);
    await expect(writing).toContainText('匹配 2 / 4 个模型');
    await search.press('Enter');
    await expect(settings.locator('.settings-save-footer')).not.toContainText('有未保存的修改');
    expect(saveRequests).toBe(0); expect(listRequests).toBe(1);
    await search.fill('中文显示');
    await expect(models.locator('option')).toHaveText(['选择上游模型', '中文显示名称 · gpt-pro']);
    await selectModelTask(settings, '摘要压缩');
    await settings.getByRole('searchbox', { name: '摘要压缩搜索模型', exact: true }).fill('GPT-MINI');
    const planningModels = settings.getByRole('combobox', { name: '摘要压缩上游模型', exact: true });
    await expect(planningModels.locator('option')).toHaveText(['选择上游模型', 'GPT Mini · gpt-mini']);
    await selectModelTask(settings, '资料提取');
    await settings.getByRole('searchbox', { name: '资料提取搜索模型', exact: true }).fill('claude');
    await expect(settings.getByRole('combobox', { name: '资料提取上游模型', exact: true }).locator('option')).toHaveText(['选择上游模型', 'Claude Fast · claude-fast']);
    await expect(settings.getByLabel('资料提取模型名称', { exact: true })).toHaveValue('private-custom');
    await selectModelTask(settings, '正文写作');
    await expect(search).toHaveValue('中文显示');
    await search.fill('claude');
    await expect(models).toHaveValue('gpt-pro');
    await expect(models.locator('option')).toHaveText(['选择上游模型', '当前选择：中文显示名称 · gpt-pro（未匹配搜索）', 'Claude Fast · claude-fast']);
    await search.fill('没有这个模型');
    await expect(models).toBeDisabled(); await expect(models).toHaveValue('gpt-pro');
    await expect(writing).toContainText('没有匹配的模型，请更换关键词或清空搜索');
    await expect(settings.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('gpt-pro');
    await settings.getByRole('button', { name: '供应商连接', exact: true }).click();
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    await expect(search).toHaveValue('没有这个模型');
    await search.fill('gemini');
    await settings.getByRole('button', { name: '正文写作刷新模型列表', exact: true }).click();
    await expect(search).toBeEnabled(); await expect(search).toHaveValue('gemini');
    expect(listRequests).toBe(2); expect(saveRequests).toBe(0);
    await writing.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('model-search-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await selectModelTask(settings, '摘要压缩');
    await expect(settings.getByRole('searchbox', { name: '摘要压缩搜索模型', exact: true })).toHaveValue('GPT-MINI');
    await selectModelTask(settings, '资料提取');
    await expect(settings.getByRole('searchbox', { name: '资料提取搜索模型', exact: true })).toHaveValue('claude');
    await selectModelTask(settings, '正文写作');
    await search.scrollIntoViewIfNeeded();
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    await models.selectOption('gemini-pro');
    await expect(settings.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('gemini-pro');
    await search.fill(''); await expect(models.locator('option')).toHaveCount(5); await expect(models).toHaveValue('gemini-pro');
    await search.fill('claude'); await search.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('model-search-mobile.png'), animations: 'disabled' });
    await settings.getByRole('combobox', { name: '正文写作供应商', exact: true }).selectOption(otherId);
    await expect(search).toBeEnabled(); await expect(search).toHaveValue('');
    await expect(models.locator('option')).toHaveText(['选择上游模型', 'other-model']);
    await expect(settings.getByLabel('正文写作模型名称', { exact: true })).toHaveValue('');
    await search.fill('other');
    await settings.getByRole('button', { name: '供应商连接', exact: true }).click();
    await settings.getByLabel('服务地址', { exact: true }).nth(1).fill(mockUrl + '/changed');
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    await expect(search).toBeEnabled(); await expect(search).toHaveValue('');
    await models.selectOption('other-model');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    const saved = await (await page.request.get('/api/settings')).json();
    expect(saved).toMatchObject({ writingProviderId: otherId, writingModel: 'other-model', planningModel: 'gpt-mini', extractionModel: 'private-custom' });
    expect(saved).not.toHaveProperty('modelSearch');
  } finally { await page.unroute(route); expect((await page.request.put('/api/settings', { data: previous })).ok()).toBeTruthy(); }
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
    const taskTabs = settings.getByRole('tablist', { name: '任务模型分页', exact: true });
    await expect(taskTabs.getByRole('tab')).toHaveCount(3);
    await expect(models.getByRole('tabpanel')).toHaveCount(1);
    await expect(taskTabs.getByRole('tab', { selected: true })).toHaveText('正文写作');
    await taskTabs.getByRole('tab', { name: '正文写作', exact: true }).press('ArrowRight');
    await expect(taskTabs.getByRole('tab', { name: '摘要压缩', exact: true })).toBeFocused();
    await expect(models.getByRole('tabpanel', { name: '摘要压缩', exact: true })).toBeVisible();
    await taskTabs.getByRole('tab', { selected: true }).press('End');
    await expect(models.getByRole('tabpanel', { name: '资料提取', exact: true })).toBeVisible();
    await taskTabs.getByRole('tab', { selected: true }).press('Home');
    await expect(models.getByRole('tabpanel', { name: '正文写作', exact: true })).toBeVisible();
    await models.getByLabel('正文写作模型名称', { exact: true }).fill('e2e-draft-writing');
    const writing = models.getByRole('region', { name: '正文写作模型设置', exact: true });
    await writing.getByLabel('单次最大输出 tokens', { exact: true }).fill('');
    await selectModelTask(settings, '摘要压缩');
    await models.getByLabel('摘要压缩模型名称', { exact: true }).fill('e2e-draft-compression');
    const planning = models.getByRole('region', { name: '摘要压缩模型设置', exact: true });
    await planning.getByLabel('单次最大输出 tokens', { exact: true }).fill('64000');
    await selectModelTask(settings, '资料提取');
    await models.getByLabel('资料提取输出模式', { exact: true }).selectOption('tool');
    await expect(models.getByRole('tabpanel')).toHaveCount(1);
    await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    await expect(providers).toBeHidden();
    await expect(models).toBeHidden();
    await expect(prompts).toBeVisible();
    await panel.getByLabel('提示词预设名称', { exact: true }).fill('分类切换保留的提示词草稿');
    let saves = 0;
    page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings') saves++; });
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(models).toBeVisible();
    await expect(taskTabs.getByRole('tab', { selected: true })).toHaveText('正文写作');
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
    await expect(taskTabs.getByRole('tab', { selected: true })).toHaveText('摘要压缩');
    await expect(settings.getByRole('alert')).toContainText('单次最大输出 tokens 必须小于上下文上限');
    expect(saves).toBe(0);
    await expect(planning.getByLabel('摘要压缩模型名称', { exact: true })).toHaveValue('e2e-draft-compression');
    await planning.getByLabel('单次最大输出 tokens', { exact: true }).fill('2048');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    expect(saves).toBe(1);
    const saved = await (await page.request.get('/api/settings')).json();
    expect(saved.providers[0].name).toBe('分类切换保留的供应商草稿');
    expect(saved.writingModel).toBe('e2e-draft-writing');
    expect(saved.planningModel).toBe('e2e-draft-compression');
    expect(saved.taskSettings.extraction.outputMode).toBe('tool');
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
    await selectModelTask(settings, '资料提取');
    await expect(models.getByLabel('资料提取输出模式', { exact: true })).toHaveValue('tool');
    await settings.getByRole('button', { name: '供应商连接', exact: true }).click();
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    await expect(taskTabs.getByRole('tab', { selected: true })).toHaveText('资料提取');
    await expect(models.getByRole('tabpanel')).toHaveCount(1);
    await taskTabs.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('task-model-tabs-mobile.png'), animations: 'disabled' });
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
  const branchId = await currentBranchId(page);
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
  await expect(page.getByRole('button', { name: '阅读视图', exact: true })).toBeVisible();
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', branchId);
  await expect(page.locator('.chapter-list .chapter-item.selected')).toContainText('第一章 设置前的章节');
  await expect(page.getByLabel('章节标题', { exact: true })).toHaveValue('第一章 尚未保存的标题');
  await expect(page.getByLabel('章节正文', { exact: true })).toHaveValue(draft);
  await expect(page.locator('.draft-badge')).toHaveText('未保存');
  await expect(page.getByRole('button', { name: '保存正文', exact: true })).toBeEnabled();
});

test('章节留空时自动命名并保存，桌面和手机刷新后仍可见', async ({ page }, testInfo) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await createProject(page, `E2E 自动题名 ${width}`);
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByLabel('章节标题（可选）', { exact: true })).toHaveAttribute('placeholder', '留空时根据本章正文自动起名');
    await modal.getByLabel('章节标题（可选）', { exact: true }).fill('   ');
    await modal.getByLabel('这一次，你想写什么？', { exact: true }).fill('写林舟发现旧钥匙。');
    await modal.getByRole('button', { name: '开始生成', exact: true }).click();
    await completedJobs(page, 2); await tab(page, '正文');
    await expect(page.locator('.manuscript h1')).toHaveText('城门下的钥匙');
    await expect(page.locator('.prose')).toContainText('林舟来到白石城');
    await page.screenshot({ path: testInfo.outputPath(`auto-title-${width}.png`), fullPage: true, animations: 'disabled' });
    const branchId = await currentBranchId(page);
    const branch = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    expect(branch.state.chapters[0].title).toBe('城门下的钥匙');
    const jobs = await (await page.request.get(`/api/jobs?projectId=${branch.branch.projectId}&view=author`)).json();
    const work = jobs.find((job: any) => job.kind === 'extract');
    const outputs = await (await page.request.get(`/api/jobs/${work.id}/outputs?view=author`)).json();
    expect(outputs.find((output: any) => output.stage === 'chapter-title')).toMatchObject({ status: 'applied' });
    await page.reload(); await page.getByRole('button', { name: `打开作品 E2E 自动题名 ${width}`, exact: true }).click();
    await expect(page.locator('.manuscript h1')).toHaveText('城门下的钥匙');
    await expect(page.locator('.prose')).toContainText('林舟来到白石城');
  }
});

test('自动命名失败后在输出表单修正，只继续整理资料', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    expect((await page.request.put('/api/settings', { data: { ...previous, writingModel: 'e2e-title-invalid' } })).ok()).toBeTruthy();
    await createProject(page, 'E2E 命名失败修正');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true }).click();
    await tab(page, '任务');
    const failed = page.locator('.job-card').filter({ has: page.locator('.status-pill.failed') }); await expect(failed).toHaveCount(1);
    const before = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    await failed.getByRole('button', { name: '模型输出 / 手工修正', exact: true }).click();
    const modal = page.getByRole('dialog'); await expect(modal.getByRole('heading', { name: '章节自动命名', exact: true })).toBeVisible();
    await modal.getByLabel('章节名', { exact: true }).fill('作者修正的来信');
    await modal.getByRole('button', { name: '保存并校验应用', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('任务保持暂停');
    await page.screenshot({ path: testInfo.outputPath('title-correction.png'), fullPage: true, animations: 'disabled' });
    await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.locator('.job-card').getByRole('button', { name: '继续', exact: true }).click(); await completedJobs(page, 2);
    const after = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    expect(after.chapterTitleRequests).toBe(before.chapterTitleRequests);
    expect(after.modelRequestsByModel['e2e-title-invalid']).toBe(before.modelRequestsByModel['e2e-title-invalid']);
    await tab(page, '正文'); await expect(page.locator('.manuscript h1')).toHaveText('作者修正的来信');
    await expect(page.locator('.prose')).toContainText('林舟来到白石城');
  } finally { expect((await page.request.put('/api/settings', { data: previous })).ok()).toBeTruthy(); }
});

test('原创生成保存正文和资料，阅读开关保留伏笔编辑和完整作者资料', async ({ page }, testInfo) => {
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
  await expect(page.getByRole('button', { name: '让 AI 规划', exact: true })).toHaveCount(0);
  const modelAfter = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
  expect(modelAfter.chapterTitleRequests).toBe(modelBefore.chapterTitleRequests);
  for (const model of ['e2e-fixture', 'e2e-custom-extraction']) expect((modelAfter.modelRequestsByModel[model] || 0) - (modelBefore.modelRequestsByModel[model] || 0)).toBeGreaterThan(0);
  expect((modelAfter.modelRequestsByModel['e2e-planning'] || 0) - (modelBefore.modelRequestsByModel['e2e-planning'] || 0)).toBe(0);
  await page.getByRole('button', { name: /^伏笔手记/ }).click();
  await page.getByRole('button', { name: '记录伏笔', exact: true }).click();
  await page.getByLabel('伏笔标题', { exact: true }).fill('城门背后的秘密');
  await page.getByRole('textbox', { name: '隐藏的真相', exact: true }).fill('SECRET_E2E_FORESHADOW');
  await page.getByRole('button', { name: '保存伏笔手记', exact: true }).click();
  await page.getByRole('button', { name: /^伏笔手记/ }).click();
  await expect(page.getByRole('textbox', { name: '隐藏的真相', exact: true })).toHaveValue(/SECRET_E2E_FORESHADOW/);
  await page.getByLabel('伏笔状态', { exact: true }).selectOption('resolved');
  await page.getByRole('button', { name: '保存伏笔手记', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存伏笔手记', exact: true })).toBeDisabled();
  await expect(page.locator('.foreshadow-card')).toHaveCount(0);
  await page.getByRole('button', { name: '查看已揭晓与已放弃', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '隐藏的真相', exact: true })).toHaveValue(/SECRET_E2E_FORESHADOW/);
  await expect(page.getByLabel('伏笔状态', { exact: true })).toHaveValue('resolved');
  const branchId = await currentBranchId(page);
  await page.getByRole('button', { name: '阅读视图', exact: true }).click();
  await expect(page.locator('.workspace-tabs').getByRole('button', { name: '剧情与伏笔' })).toBeVisible();
  const reader = await page.request.get(`/api/branches/${branchId}`);
  expect(await reader.text()).toContain('SECRET_E2E_FORESHADOW');
  const search = await page.request.get(`/api/branches/${branchId}/search?q=SECRET_E2E_FORESHADOW`);
  expect((await search.json()).entities).toEqual([]);
});

test('新章实时显示正文，阅读视图保留流式正文，重新生成可放弃后台整理并自动分支', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  const originalSettings = await (await page.request.get('/api/settings')).json();
  const providerId = 'e2e-streaming-provider';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '流式与后台验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }],
    writingProviderId: providerId, writingModel: 'e2e-streaming-writing', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-slow-extraction',
  } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 流式重新生成');
    const branchId = await currentBranchId(page);
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
    await page.getByRole('button', { name: '阅读视图', exact: true }).click();
    await expect(page.locator('.streaming-manuscript')).toBeVisible();
    await expect(page.locator('.streaming-prose')).toContainText('林舟来到白石城');
    await expect(page.getByRole('region', { name: '生成过程', exact: true })).toHaveCount(0);
    await showGenerationProcess(page);
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
    expect(await currentBranchId(page)).toBe(branchId);
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    await modal.getByRole('button', { name: '放弃后台任务并重新生成', exact: true }).click();
    await expect(modal).toContainText('自动建立分支');
    await expect(modal.getByLabel('这一次，你想写什么？', { exact: true })).toHaveValue('林舟发现古城的钥匙。');
    await modal.getByLabel('这一次，你想写什么？', { exact: true }).fill('REGEN_BRANCH_ONLY：换一个线索展开这一章。');
    await modal.getByLabel('新故事线名称', { exact: true }).fill('作者命名的重新生成路线');
    const submitted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === `/api/branches/${branchId}/generate`);
    await modal.getByRole('button', { name: '开始生成', exact: true }).click();
    expect((await submitted).postDataJSON()).toMatchObject({ regenerate: true, discardBackground: true, chapterId: before.state.chapters[0].id, branchName: '作者命名的重新生成路线', instruction: 'REGEN_BRANCH_ONLY：换一个线索展开这一章。' });
    await expect(page.locator('.workspace')).not.toHaveAttribute('data-branch-id', branchId);
    await expect(page.locator('.streaming-prose')).toContainText('林舟来到白石城');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('streaming-regeneration-mobile.png'), fullPage: true, animations: 'disabled' });
    const newBranchId = await currentBranchId(page);
    expect((await (await page.request.get(`/api/branches/${newBranchId}?view=author`)).json()).branch.name).toBe('作者命名的重新生成路线');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await chooseBranch(page, branchId);
    await expect(page.locator('.streaming-manuscript')).toHaveCount(0);
    await expect(page.locator('.prose')).not.toContainText('REGEN_BRANCH_ONLY');
    await chooseBranch(page, newBranchId);
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

test('工具返回后显示实际思考用量且明确未返回摘要，刷新与手机保留，阅读正文隔离', async ({ page }, testInfo) => {
  const originalSettings = await (await page.request.get('/api/settings')).json();
  const providerId = 'e2e-gemini-review-provider', extractionId = 'e2e-review-extraction';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '工具后思考验证', protocol: 'gemini', baseUrl: mockUrl, apiKey: '' }, { id: extractionId, name: '本地整理', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }],
    writingProviderId: providerId, writingModel: 'e2e-gemini-review', planningProviderId: extractionId, planningModel: 'e2e-planning', extractionProviderId: extractionId, extractionModel: 'e2e-fixture', promptTemplates: defaultPromptTemplates(),
  } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 工具后思考'); const branchId = await currentBranchId(page);
    const statsUrl = mockUrl.slice(0, -3) + '/__e2e/stats';
    const before = await (await page.request.get(statsUrl)).json();
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    const submitted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/branches/${branchId}/generate`);
    await page.getByRole('dialog').getByLabel('章节标题（可选）', { exact: true }).fill('工具后复核');
    await page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true }).click();
    const job = await (await submitted).json();
    const missing = page.locator('.writing-activity[data-kind="thinking"]').filter({ hasText: '模型思考（未返回摘要）' });
    await expect(missing).toBeVisible(); await expect(missing).toHaveJSProperty('open', false);
    await expect(page.locator('.writing-activity[data-kind="thinking"]')).toHaveCount(2);
    await expect(missing).toHaveAttribute('data-prose-offset', String('林舟来到白石城。'.length));
    await missing.locator('summary').click(); await expect(missing).toContainText('116 个思考 token');
    expect(await missing.evaluate(element => element.previousElementSibling?.getAttribute('data-kind'))).toBe('tool');
    await expect(page.locator('.streaming-manuscript')).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).state.chapters[0]?.status).toBe('ready');
    const activities = await (await page.request.get(`/api/jobs/${job.id}/activities?view=author`)).json();
    expect(activities.at(-1)).toMatchObject({ thinkingTokens: 116, status: 'completed' }); expect(activities.at(-1)).not.toHaveProperty('text');
    for (const [width, name] of [[1440, 'desktop'], [390, 'mobile']] as const) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
      await page.screenshot({ path: testInfo.outputPath(`post-tool-thinking-${name}.png`), fullPage: true, animations: 'disabled' });
    }
    await page.reload(); await page.getByRole('button', { name: '打开作品 E2E 工具后思考', exact: true }).click();
    await expect.poll(() => visibleProse(page)).toContain('他握住钥匙'); await expect(missing).toBeVisible();
    await showGenerationProcess(page); await expect(missing).toBeVisible();
    await missing.locator('summary').click(); await expect(missing).toContainText('116 个思考 token');
    const exportResponse = await page.request.get(`/api/branches/${branchId}/export`); expect(exportResponse.ok()).toBeTruthy();
    const exported = await exportResponse.text(); expect(exported).toContain('他握住钥匙');
    expect(exported).not.toContain('116'); expect(exported).not.toContain('REVIEW_FIRST_THOUGHT');
    await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await expect(missing).toHaveCount(0);
    const after = await (await page.request.get(statsUrl)).json();
    expect((after.modelRequestsByModel['e2e-gemini-review'] || 0) - (before.modelRequestsByModel['e2e-gemini-review'] || 0)).toBe(2);
  } finally { await page.request.put('/api/settings', { data: originalSettings }); }
});

test('作者实时查看公开思考与工具过程，默认折叠且正文独立，完成刷新及阅读开关保留正文', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  const originalSettings = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-activity-provider';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '公开思考与工具验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }], writingProviderId: providerId, writingModel: 'e2e-public-activities', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
  } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 作者生成过程');
    const branchId = await currentBranchId(page);
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
    await expect.poll(() => visibleProse(page)).not.toContain('AUTHOR_PUBLIC_THINK');
    await thinking.first().locator('summary').click();
    await expect(thinking.first().locator('.writing-thinking')).toContainText('AUTHOR_PUBLIC_THINK_1');
    const searchTool = process.locator('[data-kind=tool]').filter({ hasText: 'search_story' });
    const failedTool = process.locator('[data-kind=tool]').filter({ hasText: 'read_entity' });
    await expect(searchTool).toHaveAttribute('data-status', 'completed');
    await expect(failedTool).toHaveAttribute('data-status', 'failed');
    const anchored = page.locator(`.writing-activities[data-prose-offset="${'林舟来到白石城，'.length}"]`);
    await expect(anchored).toHaveCount(1);
    expect(await anchored.evaluate(element => element.previousElementSibling?.matches('.prose') && element.previousElementSibling.textContent === '林舟来到白石城，')).toBeTruthy();
    await expect(searchTool).toHaveAttribute('data-prose-offset', String('林舟来到白石城，'.length));
    await expect(thinking.filter({ hasText: 'AUTHOR_PUBLIC_THINK_2' })).toHaveAttribute('data-prose-offset', String('林舟来到白石城，'.length));
    await expect(searchTool).toHaveJSProperty('open', false); await expect(failedTool).toHaveJSProperty('open', false);
    await searchTool.locator('summary').click();
    await expect(searchTool.getByLabel('工具调用参数', { exact: true })).toContainText('林舟');
    await expect(searchTool.getByLabel('工具结果', { exact: true })).toContainText('entities');
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
    expect((await page.request.get(`/api/jobs/${writingJob.id}/activities`)).status()).toBe(200);
    const requestsBeforeReload = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    await page.reload(); await page.getByRole('button', { name: '打开作品 E2E 作者生成过程', exact: true }).click(); await expect.poll(() => visibleProse(page)).toContain('林舟来到白石城'); await expect(process.locator('.writing-activity')).toHaveCount(persisted.length);
    await showGenerationProcess(page);
    await expect(process.locator('.writing-activity')).toHaveCount(persisted.length);
    expect(await process.locator('details').evaluateAll(elements => elements.every(element => !(element as HTMLDetailsElement).open))).toBeTruthy();
    await page.setViewportSize({ width: 390, height: 844 });
    await thinking.first().locator('summary').click(); await searchTool.locator('summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('author-activities-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await expect(process).toHaveCount(0); await expect(page.locator('main')).not.toContainText('AUTHOR_PUBLIC_THINK');
    let release!: () => void; let reached!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { reached = resolve; });
    const route = `**/api/jobs/${writingJob.id}/activities?view=author`;
    await page.route(route, async intercepted => { const response = await intercepted.fetch(); reached(); await gate; await intercepted.fulfill({ response }); });
    try {
      await showGenerationProcess(page);
      await page.getByRole('button', { name: '新建章节', exact: true }).click();
      await page.locator('.chapter-list').getByRole('button', { name: /第一章 过程独立/ }).click(); await entered;
      await chooseBranch(page, emptyBranch.branch.id); await expect(process).toHaveCount(0);
      release(); await expect(page.locator('main')).not.toContainText('AUTHOR_PUBLIC_THINK'); await expect(process).toHaveCount(0);
    } finally { release(); await page.unroute(route); }
    await chooseBranch(page, branchId); await expect(process.locator('.writing-activity')).toHaveCount(persisted.length);
    await page.getByRole('button', { name: '新建章节', exact: true }).click(); await expect(process).toHaveCount(0);
    await page.locator('.chapter-list').getByRole('button', { name: /第一章 过程独立/ }).click(); await expect(process.locator('.writing-activity')).toHaveCount(persisted.length);
    await tab(page, '任务'); await page.locator('.job-card').filter({ has: page.getByRole('button', { name: '打开生成章节', exact: true }) }).getByRole('button', { name: '打开生成章节', exact: true }).click();
    await expect(process.locator('.writing-activity')).toHaveCount(persisted.length); await expect.poll(() => visibleProse(page)).not.toContain('AUTHOR_PUBLIC_THINK');
    const requestsAfterReload = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json(); expect(requestsAfterReload.modelRequests).toBe(requestsBeforeReload.modelRequests);
    const legacyRoute = `**/api/jobs/${writingJob.id}/activities?view=author`;
    await page.route(legacyRoute, route => route.fulfill({ json: persisted.map(({ proseOffset: _offset, ...record }: any) => record) }));
    await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await expect(process).toHaveCount(0);
    await showGenerationProcess(page);
    await page.getByRole('button', { name: '新建章节', exact: true }).click();
    await page.locator('.chapter-list').getByRole('button', { name: /第一章 过程独立/ }).click();
    const legacy = page.locator('.writing-activities[data-location=legacy]');
    await expect(legacy).toHaveCount(1); await expect(legacy).toContainText('旧记录没有保存正文位置');
    await expect(legacy.locator('.writing-activity')).toHaveCount(persisted.length);
    await expect.poll(() => visibleProse(page)).not.toContain('AUTHOR_PUBLIC_THINK');
    await page.unroute(legacyRoute);
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
    await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await expect(process).toHaveCount(0); await expect(page.locator('main')).not.toContainText('AUTHOR_PUBLIC_THINK');
  } finally { await page.request.put('/api/settings', { data: originalSettings }); }
});

test('正文生成界面直接重试、只重连断流、暂停继续及停止，收到的草稿始终可下载', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-inline-controls-provider';
  try {
    expect((await page.request.put('/api/settings', { data: {
      providers: [{ id: providerId, name: '正文内控制验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }],
      writingProviderId: providerId, writingModel: 'e2e-inline-control', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
      taskSettings: { extraction: { autoRetry: false, maxRetries: 2, retryDelayMs: 5000 }, planning: { enabled: false, mode: 'separate' } },
    } })).ok()).toBeTruthy();
    await createProject(page, 'E2E 正文内生成控制');
    const branchId = await currentBranchId(page);
    const submitted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/branches/${branchId}/generate`);
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true }).click();
    const job = await (await submitted).json(); const controls = page.getByRole('region', { name: '生成控制', exact: true });
    await expect(controls.getByRole('button', { name: '重试生成', exact: true })).toBeVisible();
    await expect(controls.getByRole('alert')).toBeVisible(); await expect(controls).toContainText('可能再次计费');
    await expect(controls.getByRole('button', { name: '停止生成', exact: true })).toBeEnabled();
    await expect.poll(() => visibleProse(page)).toContain('INLINE_CONTROL_ATTEMPT_1');
    let breakOnce = true; let retryCalls = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/jobs/${job.id}/retry`) retryCalls++; });
    let releaseRetry!: () => void; let retryReached!: () => void;
    const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; }); const retryEntered = new Promise<void>(resolve => { retryReached = resolve; });
    const retryRoute = `**/api/jobs/${job.id}/retry?view=author`;
    await page.route(retryRoute, async route => { retryReached(); await retryGate; await route.fulfill({ status: 503, json: { error: '本地延迟重试验收' } }); });
    try {
      await controls.getByRole('button', { name: '重试生成', exact: true }).click(); await retryEntered;
      await page.getByRole('button', { name: '阅读视图', exact: true }).click();
      const rejected = page.waitForResponse(response => new URL(response.url()).pathname === `/api/jobs/${job.id}/retry`);
      releaseRetry(); await (await rejected).finished();
      await showGenerationProcess(page); await tab(page, '任务');
      await page.locator('.job-card').filter({ has: page.locator('.status-pill.failed') }).getByRole('button', { name: '查看生成过程与正文', exact: true }).click();
      await expect(controls.getByRole('button', { name: '重试生成', exact: true })).toBeEnabled();
    } finally { releaseRetry(); await page.unroute(retryRoute); }
    const eventsRoute = `**/api/jobs/${job.id}/events?view=author`;
    await page.route(eventsRoute, async route => {
      if (!breakOnce) { await route.continue(); return; } breakOnce = false;
      const current = (await (await page.request.get(`/api/jobs?projectId=${job.projectId}&view=author`)).json()).find((value: any) => value.id === job.id);
      await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'snapshot', text: '', title: current.title || '新章节', job: current, activities: [] })}\n\n` });
    });
    await controls.getByRole('button', { name: '重试生成', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: '重试生成', exact: true })).toHaveCount(0);
    const modelStats = async () => (await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json()).modelRequestsByModel['e2e-inline-control'] || 0;
    await expect.poll(modelStats).toBe(2); expect(retryCalls).toBe(2);
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect.poll(() => visibleProse(page)).toContain('INLINE_CONTROL_ATTEMPT_2');
    expect(await modelStats()).toBe(2); expect(retryCalls).toBe(2);
    await controls.getByRole('button', { name: '暂停生成', exact: true }).click();
    await expect(controls.getByRole('button', { name: '继续生成', exact: true })).toBeVisible();
    await expect.poll(() => visibleProse(page)).toContain('INLINE_CONTROL_ATTEMPT_2');
    await page.setViewportSize({ width: 390, height: 844 });
    await controls.scrollIntoViewIfNeeded(); expect(await controls.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('inline-generation-controls-mobile.png'), animations: 'disabled' });
    await controls.getByRole('button', { name: '继续生成', exact: true }).click();
    await expect.poll(() => visibleProse(page)).toContain('INLINE_CONTROL_ATTEMPT_3');
    await controls.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect(controls).toContainText('已停止生成'); await expect(controls.getByRole('button', { name: '继续生成', exact: true })).toHaveCount(0);
    await expect.poll(() => visibleProse(page)).toContain('INLINE_CONTROL_ATTEMPT_3');
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: '下载当前正文 TXT', exact: true }).click();
    expect(await readFile((await (await download).path())!, 'utf8')).toContain('INLINE_CONTROL_ATTEMPT_3');
    expect(retryCalls).toBe(2); expect(await modelStats()).toBe(3);
    await expect(page.locator('.workspace-tabs > button.active')).toContainText('正文');
    await page.unroute(eventsRoute);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('摘要压缩保留各章原摘要，候选取消不生效，作者确认后保存；主要角色可编辑', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  const originalSettings = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-summary-provider';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '摘要确认验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }], writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
  } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 摘要确认'); await importNovel(page);
    const branchId = await currentBranchId(page);
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

test('手动编辑正文在当前线保存，不自动提取资料，并保留用户对人物的修正', async ({ page }, testInfo) => {
  await createProject(page, 'E2E 手动创作');
  await page.getByRole('button', { name: '手动写第一章', exact: true }).click();
  await page.getByLabel('章节标题', { exact: true }).fill('第一章 手写');
  await page.getByLabel('章节正文', { exact: true }).fill('林舟来到白石城，看见城门上刻着一行字。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await completedJobs(page, 1);
  await tab(page, '正文');
  const branchId = await currentBranchId(page);
  const before = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('章节正文', { exact: true }).fill('林舟来到白石城，看见城门上刻着一行字。\n\n林舟决定留在白石城调查这行字的来历。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await expect(page.locator('.manuscript .prose')).toContainText('林舟决定留在白石城调查');
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', branchId);
  await expect(page.getByRole('status')).toContainText('需要更新时请手动重新提取');
  await completedJobs(page, 1);
  const after = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
  expect(after.state.chapters[0].summary).toBe(before.state.chapters[0].summary);
  expect(after.state.entities.map((entity: Entity) => entity.name)).toEqual(before.state.entities.map((entity: Entity) => entity.name));
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
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', /.+/);
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
  await chooseBranch(page, { label: '主线' });
  await expect(page.locator('.chapter-list .chapter-item')).toHaveCount(2);
  await tab(page, '剧情与伏笔');
  await expect(page.locator('.plot-summary-list .plot-summary-card')).toHaveCount(2);
});

test('早章编辑保留后续章节，章末创建分支，确认删除后返回主线并保留资料', async ({ page }, testInfo) => {
  await createProject(page, 'E2E 章节分支维护'); await importNovel(page); await tab(page, '正文');
  const branchId = await currentBranchId(page);
  const before = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
  await page.locator('.chapter-list .chapter-item').first().click();
  await expect(page.getByRole('button', { name: '从此章节分支', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '删除分支', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('章节标题', { exact: true }).fill('第一章 编辑后的起点');
  await page.getByLabel('章节正文', { exact: true }).fill('林舟来到白石城，看到城门下的石碑。\n\n他决定先去城中打听消息。\n\n手动补充的河岸见闻。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第一章 编辑后的起点', exact: true })).toBeVisible();
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', branchId);
  await expect(page.locator('.chapter-list .chapter-item')).toHaveCount(2);
  await expect(page.locator('.chapter-list .chapter-item.selected')).toContainText('第一章 编辑后的起点');
  const edited = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
  expect(edited.state.chapters[1]).toEqual(before.state.chapters[1]);
  expect(edited.state.chapters[0].summary).toBe(before.state.chapters[0].summary);
  const projects = await (await page.request.get('/api/projects')).json(); const project = projects.find((project: { title: string }) => project.title === 'E2E 章节分支维护');
  expect((await (await page.request.get(`/api/jobs?projectId=${project.id}&view=author`)).json()).length).toBe(1);
  await page.getByRole('button', { name: '从此章节分支', exact: true }).click();
  let modal = page.getByRole('dialog');
  await expect(modal.getByRole('combobox', { name: '从哪一章的结尾出发', exact: true })).toHaveValue(edited.state.chapters[0].id);
  await modal.getByLabel('新故事线名称', { exact: true }).fill('河岸旁支');
  await modal.getByRole('button', { name: '建立故事线', exact: true }).click();
  await expect(page.locator('.chapter-list .chapter-item')).toHaveCount(1);
  const forkId = await currentBranchId(page); expect(forkId).not.toBe(branchId);
  await page.getByRole('button', { name: '删除分支', exact: true }).click();
  modal = page.getByRole('dialog'); await expect(modal).toContainText('河岸旁支');
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', forkId);
  await page.screenshot({ path: testInfo.outputPath('desktop-chapter-fork.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '从此章节分支', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开章节目录', exact: true }).click();
  await page.getByRole('button', { name: '删除分支', exact: true }).click();
  modal = page.getByRole('dialog'); await expect(modal.getByRole('button', { name: '确认删除分支', exact: true })).toBeVisible();
  expect(await modal.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-delete-branch.png'), fullPage: true, animations: 'disabled' });
  await modal.getByRole('button', { name: '确认删除分支', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', branchId);
  await expect(page.locator('.chapter-list .chapter-item')).toHaveCount(2);
  await expect(page.getByLabel('当前故事线', { exact: true })).toContainText(edited.branch.name);
  const after = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json(); expect(after.state).toEqual(edited.state);
  expect((await page.request.get(`/api/branches/${forkId}?view=author`)).status()).toBe(404);
  await page.reload(); await page.getByRole('button', { name: '打开作品 E2E 章节分支维护', exact: true }).click();
  await expect(page.locator('.workspace-project-title')).toContainText('E2E 章节分支维护');
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', branchId);
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
  const branchId = await currentBranchId(page);
  const view = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
  const changed = await page.request.put(`/api/branches/${branchId}/outline`, { data: { baseRevisionId: view.branch.revisionId, outline: { ...view.state.outline, worldview: '另一台设备刚刚保存的世界观。' } } });
  expect(changed.ok()).toBeTruthy();
  // Observe one actual polling round instead of relying on an arbitrary sleep.
  await page.waitForResponse(response => response.url().includes('/api/jobs?projectId='));
  await expect(page.getByLabel('章节正文', { exact: true })).toHaveValue(draft);
  const conflict = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/branches/${branchId}/chapters`);
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
  const branchId = await currentBranchId(page);
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
    // Start with a cold workspace; revisiting an already cached chapter intentionally has no request.
    await page.reload(); await page.getByRole('button', { name: '打开作品 E2E 请求归属', exact: true }).click();
    await entered;
    await chooseBranch(page, { label: '尚无正文的分支' });
    await expect(page.locator('.chapter-list .chapter-item')).toHaveCount(0);
    release(); await delivered;
    await expect(page.locator('.prose')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '故事，在下一笔开始', exact: true })).toBeVisible();
  } finally { release(); await page.unroute(route); }
});

test('任务操作回归：上游 HTTP500 后可重试、取消并退出登录，正文保留', async ({ page }) => {
  // Self-contained login also allows running this case alone with --grep.
  const authentication = await (await page.request.get('/api/auth/status')).json();
  if (!authentication.authenticated) {
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
  await showGenerationProcess(page);
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
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
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
  expect((await page.request.get(`/api/jobs/${job.id}/outputs`)).status()).toBe(200);
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
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
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
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
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
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
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
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
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
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  const providerId = 'e2e-model-defaults'; const otherId = 'e2e-model-defaults-other';
  expect((await page.request.put('/api/settings', { data: {
    providers: [providerId, otherId].map((id, index) => ({ id, name: index ? '另一个供应商' : '模型参数模拟', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' })),
    writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-fixture', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
  } })).ok()).toBeTruthy();
  await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
  let modal = page.getByTestId('settings-page');
  await modal.getByRole('button', { name: '任务模型', exact: true }).click();
  const writing = modal.getByRole('region', { name: '正文写作模型设置', exact: true });
  const planning = modal.getByRole('region', { name: '摘要压缩模型设置', exact: true });
  const extraction = modal.getByRole('region', { name: '资料提取模型设置', exact: true });
  await expect(modal.locator('.provider-card .provider-parameters')).toHaveCount(0);
  await openModelParameters(writing);
  await expect(writing.getByLabel('单次最大输出 tokens', { exact: true })).toHaveValue('4096');
  await expect(writing.getByLabel('上下文上限 tokens', { exact: true })).toHaveValue('64000');
  await expect(writing.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await expect(writing.getByLabel(/^Top P/)).toHaveValue('1');
  await expect(writing.getByLabel(/^存在惩罚/)).toHaveValue('0');
  await expect(writing.getByLabel(/^请求超时（秒）/)).toHaveValue('180');
  await expect(writing.getByLabel(/^返回方式/)).toHaveValue('false');
  await writing.getByLabel(/^温度（temperature）/).fill('0.6');
  await writing.getByLabel('单次最大输出 tokens', { exact: true }).fill('8192');
  await selectModelTask(modal, '摘要压缩');
  await openModelParameters(planning);
  await expect(planning.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await expect(planning.getByLabel('单次最大输出 tokens', { exact: true })).toHaveValue('4096');
  await planning.getByLabel(/^温度（temperature）/).fill('0.3');
  await planning.getByLabel('单次最大输出 tokens', { exact: true }).fill('2048');
  await planning.getByLabel(/^思考等级（OpenAI）/).selectOption('low');
  await selectModelTask(modal, '资料提取');
  await openModelParameters(extraction);
  await expect(extraction.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await expect(extraction.getByLabel(/^思考等级（OpenAI）/)).toHaveValue('');
  await extraction.getByLabel(/^温度（temperature）/).fill('0.2');
  await extraction.getByLabel('单次最大输出 tokens', { exact: true }).fill('16384');
  await extraction.getByLabel(/^思考等级（OpenAI）/).selectOption('high');
  await selectModelTask(modal, '摘要压缩');
  await expect(planning.getByLabel(/^温度（temperature）/)).toHaveValue('0.3');
  await expect(planning.getByLabel(/^思考等级（OpenAI）/)).toHaveValue('low');
  await selectModelTask(modal, '正文写作');
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
  await selectModelTask(modal, '摘要压缩');
  await openModelParameters(planning);
  await expect(planning.getByLabel(/^温度（temperature）/)).toHaveValue('0.3');
  await selectModelTask(modal, '资料提取');
  await openModelParameters(extraction);
  await expect(extraction.getByLabel(/^温度（temperature）/)).toHaveValue('0.2');
  for (const [task, role, temperature, maxTokens, effort] of [[planning, 'planning', 0.3, 2048, 'low'], [extraction, 'extraction', 0.2, 16384, 'high']] as const) {
    await selectModelTask(modal, role === 'planning' ? '摘要压缩' : '资料提取');
    const testing = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/settings/test');
    await task.getByRole('button', { name: role === 'planning' ? '摘要压缩保存并测试连接' : '资料提取保存并测试连接', exact: true }).click();
    const response = await testing; const captured = await response.json();
    expect(response.request().postDataJSON().role).toBe(role);
    expect(captured.ok).toBe(true);
    expect(JSON.parse(captured.capture.request.body)).toMatchObject({ model: 'e2e-fixture', temperature, max_tokens: maxTokens, reasoning_effort: effort });
  }
  await selectModelTask(modal, '摘要压缩');
  await planning.getByRole('button', { name: '恢复通用默认值', exact: true }).click();
  await expect(planning.getByLabel(/^温度（temperature）/)).toHaveValue('1');
  await expect(planning.getByLabel(/^思考等级（OpenAI）/)).toHaveValue('');
  await selectModelTask(modal, '资料提取');
  await expect(extraction.getByLabel(/^温度（temperature）/)).toHaveValue('0.2');
  await expect(extraction.getByLabel(/^思考等级（OpenAI）/)).toHaveValue('high');
  await selectModelTask(modal, '正文写作');
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
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
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
  await selectModelTask(modal, '资料提取');
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
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
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


test('故事线创建命名、后续重命名和分支树在桌面与手机可用', async ({ page }, testInfo) => {
  await createProject(page, 'E2E 分支命名与树'); await importNovel(page); await tab(page, '正文');
  const rootId = await currentBranchId(page); const root = await (await page.request.get(`/api/branches/${rootId}?view=author`)).json();
  await page.getByRole('button', { name: '重命名故事线', exact: true }).click();
  let modal = page.getByRole('dialog', { name: '重命名故事线', exact: true });
  await modal.getByLabel('故事线名称', { exact: true }).fill('   ');
  await expect(modal.getByRole('button', { name: '保存名称', exact: true })).toBeDisabled();
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '重命名故事线', exact: true }).click();
  await modal.getByLabel('故事线名称', { exact: true }).fill('原作路线'); await modal.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(page.getByLabel('当前故事线', { exact: true })).toContainText('原作路线');
  expect((await (await page.request.get(`/api/branches/${rootId}?view=author`)).json()).branch.revisionId).toBe(root.branch.revisionId);
  await expect(page.getByRole('button', { name: '删除分支', exact: true })).toHaveCount(0);
  await page.locator('.chapter-list .chapter-item').first().click();
  await page.getByRole('button', { name: '从此章节分支', exact: true }).click();
  modal = page.getByRole('dialog'); await modal.getByLabel('新故事线名称', { exact: true }).fill('取消的分支'); await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
  expect((await (await page.request.get(`/api/projects/${root.branch.projectId}`)).json()).branches).toHaveLength(1);
  for (const name of ['河岸路线', '河岸下的绕行路线']) {
    await page.getByRole('button', { name: '从此章节分支', exact: true }).click();
    modal = page.getByRole('dialog'); await modal.getByLabel('新故事线名称', { exact: true }).fill(name);
    await modal.getByRole('button', { name: '建立故事线', exact: true }).click();
    await expect(modal).toHaveCount(0); await expect(page.getByLabel('当前故事线', { exact: true })).toContainText(name);
    await expect(page.getByRole('button', { name: '从此章节分支', exact: true })).toBeVisible();
  }
  const leafId = await currentBranchId(page);
  await page.getByRole('button', { name: '重命名故事线', exact: true }).click();
  modal = page.getByRole('dialog', { name: '重命名故事线', exact: true });
  await modal.getByLabel('故事线名称', { exact: true }).fill('绕行路线·后续改名'); await modal.getByRole('button', { name: '保存名称', exact: true }).click();
  await chooseBranch(page, rootId);
  await page.getByRole('button', { name: '选择故事线', exact: true }).click();
  modal = page.getByRole('dialog', { name: '选择故事线 · 分支树', exact: true });
  const parent = modal.getByRole('button', { name: '切换到故事线 河岸路线', exact: true });
  await expect(parent.locator('..').getByRole('button', { name: '切换到故事线 绕行路线·后续改名', exact: true })).toBeVisible();
  await expect(modal.locator('.branch-tree-chapter')).toHaveCount(2);
  await expect(modal.locator(`.branch-tree-chapter[data-chapter-id="${root.state.chapters[0].id}"]`)).toHaveCount(1);
  const chapterBox = await modal.locator(`.branch-tree-chapter[data-chapter-id="${root.state.chapters[0].id}"]`).boundingBox();
  const nameBox = await parent.boundingBox(); expect(nameBox!.y).toBeGreaterThan(chapterBox!.y + chapterBox!.height);
  await expect(modal.locator(`button[data-branch-id="${rootId}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('branch-tree-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('branch-tree-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  await modal.locator(`button[data-branch-id="${leafId}"]`).click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', leafId);
  const leaf = await (await page.request.get(`/api/branches/${leafId}?view=author`)).json();
  expect(leaf.state.chapters).toHaveLength(1);
  const parentId = leaf.branch.parentBranchId;
  const source = await (await page.request.get(`/api/branches/${parentId}?view=author`)).json();
  expect((await page.request.delete(`/api/branches/${parentId}?view=author`, { data: { baseRevisionId: source.branch.revisionId } })).ok()).toBeTruthy();
  await page.reload(); await page.getByRole('button', { name: '打开作品 E2E 分支命名与树', exact: true }).click();
  await page.getByRole('button', { name: '选择故事线', exact: true }).click();
  modal = page.getByRole('dialog', { name: '选择故事线 · 分支树', exact: true });
  await expect(modal.getByRole('button', { name: '切换到故事线 河岸路线', exact: true })).toBeDisabled();
  await expect(modal.getByRole('button', { name: '切换到故事线 绕行路线·后续改名', exact: true })).toBeEnabled();
  await modal.locator(`button[data-branch-id="${rootId}"]`).click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', rootId);
});

test('第十六章反复生成保持同级，章节节点和叶端名称在桌面与手机可选择', async ({ page }, testInfo) => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-chapter-tree-browser-'))); let backup: Buffer;
  try {
    const project = store.createProject({ title: 'E2E 章节节点分支树' });
    for (let index = 1; index <= 16; index++) {
      const saved = store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: `第${index}章`, text: `林舟在白石城记录第${index}段中性经历。` });
      store.applyExtraction(project.mainBranchId, saved.branch.revisionId, saved.state.chapters.at(-1)!.id, { summary: '记录已有经历。', entities: [], relations: [], foreshadows: [] }, true);
    }
    backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: store.exportProject(project.id), sources: [] }));
  } finally { store.close(); }
  const restored = await page.request.post('/api/restore', { multipart: { file: { name: 'chapter-tree.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
  expect(restored.ok(), await restored.text()).toBeTruthy(); const project = await restored.json(); const mainId = project.mainBranchId;
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await showGenerationProcess(page);
  const versions: { branchId: string; chapterId: string }[] = [];
  const original = await (await page.request.get(`/api/branches/${mainId}?view=author`)).json();
  versions.push({ branchId: mainId, chapterId: original.state.chapters[15].id });
  const names = ['第十六章第二版', `第十六章第三版${'长名称'.repeat(40)}`];
  for (const [index, name] of names.entries()) {
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    const modal = page.getByRole('dialog'); await modal.getByLabel('新故事线名称', { exact: true }).fill(name);
    await modal.getByLabel('这一次，你想写什么？', { exact: true }).fill('让林舟继续调查白石城。');
    await modal.getByRole('button', { name: '开始生成', exact: true }).click();
    await completedJobs(page, (index + 1) * 2); await tab(page, '正文');
    await page.locator('.chapter-list .chapter-item').last().click();
    const branchId = await currentBranchId(page); const current = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    expect(current.branch.parentBranchId).toBe(mainId); expect(current.state.chapters).toHaveLength(16);
    expect(current.state.chapters.slice(0, 15).map((chapter: { id: string }) => chapter.id)).toEqual(original.state.chapters.slice(0, 15).map((chapter: { id: string }) => chapter.id));
    versions.push({ branchId, chapterId: current.state.chapters[15].id });
  }
  await page.getByRole('button', { name: '选择故事线', exact: true }).click();
  let modal = page.getByRole('dialog', { name: '选择故事线 · 分支树', exact: true });
  await expect(modal.locator('.branch-tree-chapter')).toHaveCount(18);
  const currentName = modal.locator(`button[data-branch-id="${versions[2].branchId}"]`);
  await expect(currentName).toHaveAttribute('title', names[1]);
  await expect.poll(async () => {
    const treeBox = await modal.locator('.branch-tree').boundingBox(); const currentBox = await currentName.boundingBox();
    return !!treeBox && !!currentBox && currentBox.y >= treeBox.y && currentBox.y + currentBox.height <= treeBox.y + treeBox.height;
  }).toBe(true);
  const previous = modal.locator(`.branch-tree-chapter[data-chapter-id="${original.state.chapters[14].id}"]`);
  const parentNode = await previous.getAttribute('data-tree-node-id'); const chapterBoxes = [];
  for (const version of versions) {
    const node = modal.locator(`.branch-tree-chapter[data-chapter-id="${version.chapterId}"]`);
    await expect(node).toHaveAttribute('data-parent-node-id', parentNode!);
    const box = await node.boundingBox(); const labelBox = await modal.locator(`button[data-branch-id="${version.branchId}"]`).boundingBox();
    expect(labelBox!.y).toBeGreaterThan(box!.y + box!.height); expect(labelBox!.width).toBeLessThanOrEqual(box!.width); chapterBoxes.push(box!);
  }
  expect(new Set(chapterBoxes.map(box => box.y)).size).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('chapter-tree-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await modal.locator(`button[data-branch-id="${versions[2].branchId}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('chapter-tree-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  expect(await modal.locator('.branch-tree').evaluate(element => element.scrollWidth > element.clientWidth)).toBeTruthy();
  await modal.locator(`.branch-tree-chapter[data-chapter-id="${versions[0].chapterId}"]`).click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-branch-id', mainId);
  await expect(page.locator('.manuscript h1')).toHaveText('第16章');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const draft = '尚未保存的中性章节草稿。'; await page.getByLabel('章节正文', { exact: true }).fill(draft);
  await page.getByRole('button', { name: '选择故事线', exact: true }).click();
  modal = page.getByRole('dialog', { name: '选择故事线 · 分支树', exact: true });
  let confirmations = 0;
  const rejectLeave = async (dialog: import('@playwright/test').Dialog) => { confirmations++; await dialog.dismiss(); };
  page.on('dialog', rejectLeave);
  await modal.locator(`.branch-tree-chapter[data-chapter-id="${original.state.chapters[14].id}"]`).click();
  await expect(page.getByLabel('章节正文', { exact: true })).toHaveValue(draft); await expect(modal).toBeVisible();
  page.off('dialog', rejectLeave); expect(confirmations).toBe(1);
  const acceptLeave = async (dialog: import('@playwright/test').Dialog) => { confirmations++; await dialog.accept(); };
  page.on('dialog', acceptLeave);
  await modal.locator(`.branch-tree-chapter[data-chapter-id="${original.state.chapters[14].id}"]`).click();
  await expect(modal).toHaveCount(0); await expect(page.locator('.manuscript h1')).toHaveText('第15章');
  page.off('dialog', acceptLeave); expect(confirmations).toBe(2);
  await page.getByRole('button', { name: '阅读视图', exact: true }).click();
  await page.getByRole('button', { name: '选择故事线', exact: true }).click();
  modal = page.getByRole('dialog', { name: '选择故事线 · 分支树', exact: true });
  await modal.locator(`.branch-tree-chapter[data-chapter-id="${original.state.chapters[14].id}"]`).click();
  await expect(page.locator('.manuscript h1')).toHaveText('第15章');
  await expect(page.locator('.context-note')).toHaveText('当前故事线的完整资料');
  await chooseBranch(page, versions[2].branchId); await expect(page.locator('.manuscript h1')).toHaveText('第16章');
});

test('预设和提示词块创建复制前可命名、可取消、后续改名及保存恢复', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    await page.request.put('/api/settings', { data: { ...previous, promptTemplates: defaultPromptTemplates() } });
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page'); await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    const panel = settings.getByTestId('prompt-templates-panel');
    async function confirmName(title: string, label: string, name: string) {
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      await dialog.getByLabel(label, { exact: true }).fill(name); await dialog.getByRole('button', { name: '确认名称', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    await panel.getByRole('button', { name: '新建预设', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '新建预设', exact: true });
    await dialog.getByLabel('预设名称', { exact: true }).fill('   '); await expect(dialog.getByRole('button', { name: '确认名称', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(panel.getByLabel('当前提示词预设', { exact: true }).locator('option')).toHaveCount(defaultPromptTemplates().presets.writing.length);
    await panel.getByRole('button', { name: '新建预设', exact: true }).click(); await confirmName('新建预设', '预设名称', '自定写作预设');
    await panel.getByRole('button', { name: '重命名预设', exact: true }).click(); await confirmName('重命名预设', '预设名称', '已改名写作预设');
    const before = await panel.getByTestId('prompt-block').count();
    await panel.getByRole('button', { name: '添加提示词块', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '新建提示词块', exact: true }); await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(panel.getByTestId('prompt-block')).toHaveCount(before);
    await panel.getByRole('button', { name: '添加提示词块', exact: true }).click(); await confirmName('新建提示词块', '提示词名称', '环境描写要求');
    await panel.getByLabel(`提示词块 ${before + 1} 内容`, { exact: true }).fill('用环境细节表现人物情绪。');
    const blockId = await panel.getByTestId('prompt-block').last().getAttribute('data-block-id');
    await panel.getByRole('button', { name: `重命名提示词块 ${before + 1}`, exact: true }).click(); await confirmName('重命名提示词块', '提示词名称', '场景与情绪');
    expect(await panel.getByTestId('prompt-block').last().getAttribute('data-block-id')).toBe(blockId);
    await panel.getByRole('button', { name: `复制提示词块 ${before + 1}`, exact: true }).click(); await confirmName('复制提示词块', '提示词名称', '场景规则副本');
    await expect(panel.getByLabel(`提示词块 ${before + 2} 内容`, { exact: true })).toHaveValue('用环境细节表现人物情绪。');
    await panel.getByRole('button', { name: '复制预设', exact: true }).click(); await confirmName('复制预设', '预设名称', '自选副本名称');
    for (const task of ['通用框架', '资料提取', '摘要压缩']) {
      const tabName = task === '通用框架' ? '通用预设' : task;
      await panel.getByRole('tab', { name: tabName, exact: true }).click();
      await panel.getByRole('button', { name: '新建预设', exact: true }).click(); await confirmName('新建预设', '预设名称', `${task}自定名称`);
      await panel.getByRole('button', { name: '重命名预设', exact: true }).click(); await confirmName('重命名预设', '预设名称', `${task}后续改名`);
    }
    await panel.getByRole('tab', { name: '正文写作', exact: true }).click();
    expect((await (await page.request.get('/api/settings')).json()).promptTemplates).toEqual(defaultPromptTemplates());
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    const saved = (await (await page.request.get('/api/settings')).json()).promptTemplates;
    expect(saved.presets.writing.map((preset: { name: string }) => preset.name)).toEqual([...defaultPromptTemplates().presets.writing.map(value => value.name), '已改名写作预设', '自选副本名称']);
    expect(saved.presets.writing.at(-2).blocks.at(-2)).toMatchObject({ id: blockId, name: '场景与情绪', content: '用环境细节表现人物情绪。' });
    expect(saved.presets.writing.at(-2).blocks.at(-1).id).not.toBe(blockId);
    expect(saved.presets.writing.at(-1).blocks.at(-1).name).toBe('场景规则副本');
    expect(saved.general.presets.at(-1).name).toBe('通用框架后续改名');
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click();
    await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue('自选副本名称');
    await panel.getByRole('button', { name: '重命名预设', exact: true }).click(); await page.setViewportSize({ width: 390, height: 844 });
    dialog = page.getByRole('dialog', { name: '重命名预设', exact: true });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('prompt-name-mobile.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('任务提示词支持编辑编排、变量预览、独立导入导出和保存恢复', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    await page.request.put('/api/settings', { data: { ...previous, promptTemplates: defaultPromptTemplates() } });
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const modal = page.getByTestId('settings-page'); const panel = modal.getByTestId('prompt-templates-panel');
    await modal.getByRole('button', { name: '提示词编排', exact: true }).click();
    await panel.getByRole('tab', { name: '通用预设', exact: true }).click(); await panel.getByLabel('工具防截断', { exact: true }).uncheck(); await panel.getByRole('tab', { name: '正文写作', exact: true }).click();
    await panel.getByRole('button', { name: '复制预设', exact: true }).click();
    await page.getByRole('dialog', { name: '复制预设', exact: true }).getByRole('button', { name: '确认名称', exact: true }).click();
    await panel.getByLabel('提示词预设名称', { exact: true }).fill('我的写作风格');
    await panel.getByLabel('提示词块 1 内容', { exact: true }).fill('使用风格：{{style}}，作品：{{projectTitle}}。');
    await expect(panel).toContainText('此任务没有变量 {{style}}');
    await panel.locator('summary').filter({ hasText: '可用变量与自定义变量' }).click();
    await panel.getByRole('button', { name: '添加自定义变量', exact: true }).click();
    await panel.getByLabel('自定义变量 1 名称', { exact: true }).fill('style');
    await panel.getByLabel('自定义变量 1 值', { exact: true }).fill('克制叙述，重视动作细节');
    await expect(panel).not.toContainText('此任务没有变量');
    await expect(panel.locator('summary').filter({ hasText: '最终发送预览 · 使用示例素材' })).toBeVisible();
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
    expect(exported).toMatchObject({ format: 'ai-novel-prompt-preset', version: 2, task: 'writing', preset: { name: '我的写作风格', variables: { style: '克制叙述，重视动作细节' } }, generalPreset: { name: '通用综合 · 中性叙事' } });
    expect(exportedText).not.toContain('providers'); expect(exportedText).not.toContain('apiKey');
    await panel.getByLabel('导入提示词预设 JSON', { exact: true }).fill(exportedText);
    await panel.getByRole('button', { name: '从 JSON 新增预设', exact: true }).click();
    const importedName = page.getByRole('dialog', { name: '导入预设', exact: true });
    await importedName.getByRole('button', { name: '取消', exact: true }).click();
    await expect(panel.getByLabel('当前提示词预设', { exact: true }).locator('option')).toHaveCount(defaultPromptTemplates().presets.writing.length + 1);
    await panel.getByRole('button', { name: '从 JSON 新增预设', exact: true }).click();
    await importedName.getByLabel('预设名称', { exact: true }).fill('导入写作风格');
    await importedName.getByLabel('搭配的通用预设名称', { exact: true }).fill('导入的通用框架');
    await importedName.getByRole('button', { name: '确认名称', exact: true }).click();
    await expect(panel.getByLabel('当前提示词预设', { exact: true }).locator('option')).toHaveCount(defaultPromptTemplates().presets.writing.length + 2);
    for (const label of ['资料提取', '摘要压缩']) {
      await panel.getByRole('tab', { name: label, exact: true }).click();
      await panel.getByLabel('提示词预设名称', { exact: true }).fill(`${label}测试预设`);
    }
    await panel.getByRole('tab', { name: '正文写作', exact: true }).click();
    await modal.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(modal.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    const saved = await (await page.request.get('/api/settings')).json();
    expect(saved.promptTemplates.presets.writing).toHaveLength(defaultPromptTemplates().presets.writing.length + 2);
    expect(saved.promptTemplates.presets.writing.at(-1).blocks[1]).toMatchObject({ role: 'assistant', enabled: true, modes: ['original'] });
    expect(saved.promptTemplates.presets.compression[0].name).toBe('摘要压缩测试预设');
    await page.screenshot({ path: testInfo.outputPath('prompt-editor-desktop.png'), animations: 'disabled' });
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click();
    await modal.getByRole('button', { name: '提示词编排', exact: true }).click();
    await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue('导入写作风格');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('prompt-editor-mobile.png'), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('最终提示词预览显示全部程序规则、四种协议和 RPG，且不调用模型', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  const stats = async () => (await (await page.request.get(`${mockUrl.replace('/v1', '')}/__e2e/stats`)).json()).modelRequests;
  const before = await stats();
  try {
    await page.request.put('/api/settings', { data: { ...previous, promptTemplates: withDramatronPresets() } });
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const panel = page.getByTestId('prompt-templates-panel');
    await page.getByTestId('settings-page').getByRole('button', { name: '提示词编排', exact: true }).click();
    const preview = panel.getByLabel('提示词编译预览', { exact: true });
    await expect(preview).toContainText('当前阶段只生成本章正文');
    await expect(preview).toContainText('## 文风与上下文');
    await panel.locator('summary').filter({ hasText: '发送的工具定义' }).click();
    await expect(panel.getByLabel('提示词工具定义', { exact: true })).toContainText('read_text_file');
    for (const protocol of ['openai-chat', 'openai-responses', 'gemini', 'claude']) {
      await panel.getByLabel('预览接口协议', { exact: true }).selectOption(protocol);
      await expect(preview).toContainText('当前阶段只生成本章正文');
      await expect(preview.locator('[data-role="system"]')).toHaveCount(['claude', 'gemini'].includes(protocol) ? 1 : 9);
      await expect(preview).toContainText('普通文本只交付故事正文');
      await expect(preview).not.toContainText('调用工具前结束 think/thinking 辅助块');
      await expect(preview).toContainText('不要按编号推算进度');
      expect(await preview.locator('section:not([data-role="system"])').evaluateAll(elements => elements.map(element => element.getAttribute('data-role')))).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    }
    await panel.locator('summary').filter({ hasText: '编辑示例变量' }).click();
    await panel.getByLabel('示例变量 mode', { exact: true }).selectOption('rpg');
    await panel.getByLabel('示例 RPG 角色姓名', { exact: true }).fill('测试信使');
    await panel.getByLabel('示例 RPG 章末行动', { exact: true }).fill('{"text":"前往灯塔"}');
    await expect(preview).toContainText('测试信使');
    await expect(preview).toContainText('前往灯塔');
    await expect(preview).toContainText('已累计生成正文 0 字');
    await expect(preview).toContainText('必须调用 ask_user');
    await expect(panel.getByRole('tab', { name: '剧情规划', exact: true })).toHaveCount(0);
    for (const task of ['资料提取', '摘要压缩']) {
      await panel.getByRole('tab', { name: task, exact: true }).click();
      await expect(preview).toContainText('本次返回必须是符合要求的单个 JSON 对象');
    }
    await panel.getByRole('tab', { name: '资料提取', exact: true }).click();
    await expect(preview).toContainText('## 证据范围：硬性约束');
    await panel.locator('summary').filter({ hasText: '编辑示例变量' }).click();
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('complete-prompt-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('complete-prompt-mobile.png'), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    expect(await stats()).toBe(before);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('通用框架可跨任务编辑、独立选择和预览，工具通道真实写作保留查询过程', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  const providerId = 'e2e-layered-writer';
  try {
    expect((await page.request.put('/api/settings', { data: { ...previous,
      providers: [{ id: providerId, name: '工具通道本地验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }],
      writingProviderId: providerId, writingModel: 'e2e-writing-envelope', planningProviderId: providerId, planningModel: 'e2e-fixture', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
      modelParameters: [], promptTemplates: withDramatronPresets(),
      taskSettings: { extraction: { outputMode: 'prompt', autoRetry: false, maxRetries: 0, retryDelayMs: 0 }, planning: { enabled: false, mode: 'separate' } },
      imageSettings: { providerId: '', model: '', protocol: 'openai-images', size: '1024x1024', quality: 'auto', stylePrompt: '', autoPortrait: false, autoCG: false, timeoutMs: 120000 },
    } })).ok()).toBeTruthy();
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page'); await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    const panel = settings.getByTestId('prompt-templates-panel'); const preview = panel.getByLabel('提示词编译预览', { exact: true });
    await panel.getByRole('tab', { name: '通用预设', exact: true }).click();
    await panel.getByLabel('提示词块 1 内容', { exact: true }).fill('# 通用任务框架\nGENERAL_FRAMEWORK_E2E：按当前任务要求交付。');
    await panel.getByLabel('预览搭配的任务', { exact: true }).selectOption('extraction'); await expect(preview).toContainText('GENERAL_FRAMEWORK_E2E'); await expect(preview).toContainText('证据范围');
    await panel.getByRole('tab', { name: '正文写作', exact: true }).click(); await expect(preview).toContainText('GENERAL_FRAMEWORK_E2E');
    await panel.getByLabel('搭配通用预设', { exact: true }).selectOption('off'); await expect(preview).not.toContainText('GENERAL_FRAMEWORK_E2E');
    await panel.getByLabel('搭配通用预设', { exact: true }).selectOption('follow');
    await panel.getByLabel('正文输出通道', { exact: true }).selectOption('tool');
    await panel.locator('summary').filter({ hasText: '发送的工具定义' }).click();
    for (const protocol of ['openai-chat', 'openai-responses', 'gemini', 'claude']) {
      await panel.getByLabel('预览接口协议', { exact: true }).selectOption(protocol);
      await expect(preview).toContainText('正文工具通道'); await expect(panel.getByLabel('提示词工具定义', { exact: true })).toContainText('emit_writing_response');
      await expect(panel.getByLabel('提示词工具定义', { exact: true })).toContainText('search_story');
    }
    await page.screenshot({ path: testInfo.outputPath('general-tool-preset-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); await panel.getByLabel('正文输出通道', { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('general-tool-preset-mobile.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 }); await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    await settings.getByRole('button', { name: '返回作品', exact: true }).click();
    await createProject(page, 'E2E 分层工具正文');
    await page.getByRole('button', { name: '开始创作', exact: true }).click(); await page.getByRole('dialog').getByLabel('这一次，你想写什么？', { exact: true }).fill('在城门前继续。'); await page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true }).click();
    await expect.poll(() => visibleProse(page)).toContain('林舟走进白石城');
    const branchId = await currentBranchId(page);
    await expect.poll(async () => (await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).state.chapters[0]?.status).toBe('ready');
    const text = await visibleProse(page); expect(text).toContain('林舟来到城门前。'); expect(text).not.toContain('argumentsJson'); expect(text).not.toContain('toolResults'); expect(text).not.toContain('辅助场景核对'); expect(text).not.toContain('<thinking>');
    const jobs = await (await page.request.get('/api/jobs?view=author')).json(); const written = jobs.find((value: any) => value.kind === 'generate' && value.branchId === branchId);
    const activities = await (await page.request.get(`/api/jobs/${written.id}/activities?view=author`)).json(); expect(activities.some((value: any) => value.name === 'search_story' && value.status === 'completed')).toBe(true);
    expect(activities.filter((value: any) => value.thinkingSource === 'preset').map((value: any) => value.text)).toEqual(['辅助场景核对', '辅助场景核对']);
    const thoughts = page.locator('.writing-activity[data-thinking-source="preset"]');
    await expect(thoughts).toHaveCount(2); await expect(thoughts.first().locator('summary')).toContainText('预设思考（非原生）');
    await thoughts.first().locator('summary').click(); await expect(thoughts.first().locator('.writing-thinking')).toHaveText('辅助场景核对');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('非原生思考与资料查询、生图工具在作者视角显示，刷新和阅读视图隔离', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-preset-process';
  try {
    expect((await page.request.put('/api/settings', { data: { ...previous,
      providers: [{ id: providerId, name: '预设思考验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }],
      writingProviderId: providerId, writingModel: 'e2e-preset-activities', planningProviderId: providerId, planningModel: 'e2e-fixture', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
      modelParameters: [], promptTemplates: defaultPromptTemplates(),
      taskSettings: { extraction: { outputMode: 'prompt', autoRetry: false, maxRetries: 0, retryDelayMs: 0 } },
      imageSettings: { providerId, model: 'gpt-image-1', protocol: 'openai-images', size: '1024x1024', quality: 'auto', stylePrompt: '', autoPortrait: true, autoCG: false, timeoutMs: 120000 },
    } })).ok()).toBeTruthy();
    await createProject(page, 'E2E 预设思考与工具');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.getByRole('dialog').getByLabel('这一次，你想写什么？', { exact: true }).fill('先核对城门资料，再继续写作并为新人物登记立绘。');
    await page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true }).click();
    await expect.poll(() => visibleProse(page)).toContain('林舟走进白石城');
    const branchId = await currentBranchId(page);
    await expect.poll(async () => (await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).state.chapters[0]?.status).toBe('ready');
    const thoughts = page.locator('.writing-activity[data-thinking-source="preset"]');
    const search = page.locator('.writing-activity[data-kind="tool"]').filter({ hasText: 'search_story' });
    const portrait = page.locator('.writing-activity[data-kind="tool"]').filter({ hasText: 'generate_character_portrait' });
    await expect(thoughts).toHaveCount(2); await expect(search).toHaveAttribute('data-status', 'completed'); await expect(portrait).toHaveAttribute('data-status', 'completed');
    expect(await thoughts.evaluateAll(elements => elements.every(element => !(element as HTMLDetailsElement).open))).toBe(true);
    await thoughts.first().locator('summary').click(); await expect(thoughts.first()).toContainText('PRESET_BEFORE');
    await search.locator('summary').click(); await expect(search.getByLabel('工具结果', { exact: true })).toContainText('chapters');
    await portrait.locator('summary').click(); await expect(portrait.locator('summary')).toContainText('请求人物立绘');
    await expect(portrait.getByLabel('工具调用参数', { exact: true })).toContainText('林舟');
    await expect(portrait.getByLabel('工具结果', { exact: true })).toContainText('requested');
    const text = await visibleProse(page); expect(text).not.toContain('PRESET_'); expect(text).not.toContain('<thinking>');
    const jobs = await (await page.request.get('/api/jobs?view=author')).json(); const written = jobs.find((value: any) => value.kind === 'generate' && value.branchId === branchId);
    const activities = await (await page.request.get(`/api/jobs/${written.id}/activities?view=author`)).json();
    expect(activities.filter((value: any) => value.thinkingSource === 'preset').every((value: any) => value.proseOffset === '林舟来到城门前。'.length)).toBe(true);
    const exported = await page.request.get(`/api/branches/${branchId}/export`); expect(await exported.text()).not.toContain('PRESET_');
    await page.screenshot({ path: testInfo.outputPath('preset-thought-tools-desktop.png'), animations: 'disabled' });
    await page.reload(); await page.getByRole('button', { name: '打开作品 E2E 预设思考与工具', exact: true }).click();
    await expect(thoughts).toHaveCount(2);
    await showGenerationProcess(page); await expect(thoughts).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 844 }); await thoughts.first().locator('summary').click(); await portrait.locator('summary').click();
    await expect(portrait.getByLabel('工具结果', { exact: true })).toContainText('requested');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('preset-thought-tools-mobile.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await expect(page.getByRole('region', { name: '生成过程', exact: true })).toHaveCount(0);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('Dramatron 防截断结构按原预设开关互斥，工具模式跳过尾段，保存后保留', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    await page.request.put('/api/settings', { data: { ...previous, promptTemplates: withDramatronPresets(), taskSettings: { extraction: { outputMode: 'structured', autoRetry: false, maxRetries: 0, retryDelayMs: 0 }, planning: { enabled: true, mode: 'separate' } } } });
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page'); await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    const panel = settings.getByTestId('prompt-templates-panel'); const preview = panel.getByLabel('提示词编译预览', { exact: true });
    await panel.getByRole('tab', { name: '通用预设', exact: true }).click();
    await expect(panel).toContainText('至少 7000 token'); await expect(preview).toContainText('冬马和纱'); await expect(preview).toContainText('[START A NEW CHAT]');
    await expect(preview).toContainText('<Interleaved_thinking>');
    const open = async (id: string) => { const block=panel.locator(`[data-block-id="${id}"]`); if(await block.getAttribute('open')===null) await block.locator('summary').click(); return block; };
    const single=await open('cot-single'); await single.getByRole('checkbox',{name:/^启用提示词块 \d+$/}).check();
    await expect(panel.locator('[data-block-id="cot-three"] input[type="checkbox"]').first()).not.toBeChecked(); await expect(preview).not.toContainText('<Interleaved_thinking>');
    const normal=await open('defense-normal'); await normal.getByRole('checkbox',{name:/^启用提示词块 \d+$/}).check(); await expect(preview).toContainText('<disclaimer_format>');
    const laoda=await open('defense-laoda'); await laoda.getByRole('checkbox',{name:/^启用提示词块 \d+$/}).check();
    await expect(normal.getByRole('checkbox',{name:/^启用提示词块 \d+$/})).not.toBeChecked(); await expect(preview).toContainText('<Reference_Example_format>'); await expect(preview).not.toContainText('<disclaimer_format>');
    await panel.getByRole('tab', { name: '正文写作', exact: true }).click(); await panel.getByLabel('正文输出通道', { exact: true }).selectOption('tool');
    await expect(preview).toContainText('正文工具通道'); await expect(preview).not.toContainText('<Reference_Example_format>');
    await panel.getByRole('tab', { name: '通用预设', exact: true }).click(); await panel.getByLabel('预览搭配的任务', { exact: true }).selectOption('extraction');
    await expect(preview).toContainText('结构化输出'); await expect(preview).not.toContainText('<Reference_Example_format>'); await expect(preview).not.toContainText('NOTE: 思考内容由');
    await panel.getByLabel('辅助标签处理', { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('dramatron-structure-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath('dramatron-structure-mobile.png'), animations: 'disabled' }); expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 }); await settings.getByRole('button',{name:'保存设置',exact:true}).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    const saved=await (await page.request.get('/api/settings')).json();
    expect(saved.promptTemplates.general.presets[0].textFilter).toBe('dramatron'); expect(saved.promptTemplates.general.presets[0].blocks.find((block:any)=>block.feature==='defense-laoda').enabled).toBe(true);
    expect(saved.promptTemplates.general.presets[0].blocks.find((block:any)=>block.feature==='cot-single').enabled).toBe(true); expect(saved.promptTemplates.presets.writing[0].writingOutputMode).toBe('tool');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('四类任务和通用预设可用，规划入口移除，世界设定与伏笔仍可编辑', async ({ page }, testInfo) => {
  const previous=await (await page.request.get('/api/settings')).json();
  try {
    await page.request.put('/api/settings',{data:{...previous,promptTemplates:defaultPromptTemplates()}});
    await page.goto('/');await page.getByRole('button',{name:'设置',exact:true}).click();const settings=page.getByTestId('settings-page');
    await settings.getByRole('button',{name:'任务模型',exact:true}).click();await selectModelTask(settings, '摘要压缩');await expect(settings.getByLabel('启用剧情规划',{exact:true})).toHaveCount(0);await expect(settings.getByRole('region',{name:'剧情规划模型设置',exact:true})).toHaveCount(0);await expect(settings.getByRole('region',{name:'摘要压缩模型设置',exact:true})).toBeVisible();
    await settings.getByRole('button',{name:'提示词编排',exact:true}).click();const panel=settings.getByTestId('prompt-templates-panel');
    await expect(panel.getByRole('tab',{name:'剧情规划',exact:true})).toHaveCount(0);await expect(panel.getByRole('tab')).toHaveCount(5);
    await expect(panel.getByLabel('提示词块 1 内容',{exact:true})).toHaveValue(/# 小说正文写作/);await expect(panel.getByLabel('提示词块 1 内容',{exact:true})).not.toHaveValue(/日式视觉小说/);
    await panel.getByRole('tab',{name:'通用预设',exact:true}).click();await expect(panel.getByTestId('prompt-block')).toHaveCount(4);await expect(panel.locator('[data-block-id="dramatron-role"]')).toHaveCount(0);await expect(panel.locator('[data-block-id="material-boundary"]')).toHaveCount(0);
    await page.screenshot({path:testInfo.outputPath('protection-only-general-desktop.png'),animations:'disabled'});await settings.getByRole('button',{name:'返回作品',exact:true}).click();
    await createProject(page,'无规划入口验证');await tab(page,'剧情与伏笔');await expect(page.getByRole('button',{name:'让 AI 规划',exact:true})).toHaveCount(0);await expect(page.getByLabel('规划章节标题',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'添加章节规划',exact:true})).toHaveCount(0);
    await page.getByRole('textbox',{name:'世界观',exact:true}).fill('港城，没有魔法。');await page.getByRole('button',{name:'保存世界观与锁定设定',exact:true}).click();await expect(page.getByRole('button',{name:'保存世界观与锁定设定',exact:true})).toBeDisabled();
    const branchId=await currentBranchId(page);const view=await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();expect(view.state.outline.worldview).toBe('港城，没有魔法。');expect((await page.request.post(`/api/branches/${branchId}/plan`,{data:{baseRevisionId:view.branch.revisionId}})).status()).toBe(404);
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:testInfo.outputPath('story-notes-mobile.png'),animations:'disabled'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  } finally {await page.request.put('/api/settings',{data:previous});}
});

test('内置通用只有中性版，默认选择和恢复目录保存刷新后不补回最早移植版', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    expect((await page.request.put('/api/settings', { data: { ...previous, promptTemplates: defaultPromptTemplates() } })).ok()).toBe(true);
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page'); await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    const panel = settings.getByTestId('prompt-templates-panel'); await panel.getByRole('tab', { name: '通用预设', exact: true }).click();
    await expect(panel.getByLabel('当前提示词预设', { exact: true }).locator('option')).toHaveCount(1);
    await expect(panel.getByLabel('当前提示词预设', { exact: true })).toHaveValue(NEUTRAL_PRESET_ID);
    await expect(panel.getByLabel('恢复默认框架', { exact: true }).locator('option')).toHaveCount(1);
    await expect(panel.getByLabel('恢复默认框架', { exact: true })).toHaveValue(NEUTRAL_PRESET_ID);
    await expect(panel.getByLabel('删除当前提示词预设', { exact: true })).toBeDisabled();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click(); await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    await panel.getByRole('tab', { name: '通用预设', exact: true }).click();
    await expect(panel.getByLabel('当前提示词预设', { exact: true }).locator('option')).toHaveText(['通用综合 · 中性叙事']);
    await page.screenshot({ path: testInfo.outputPath('neutral-only-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); await panel.getByLabel('当前提示词预设', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('neutral-only-mobile.png'), animations: 'disabled' }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('四份原版结构从文件导入后能查看真实工具与消息重排，四类 v3 保存后保留', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    expect((await page.request.put('/api/settings', { data: { ...previous, promptTemplates: defaultPromptTemplates(), taskSettings: { extraction: { outputMode: 'prompt', autoRetry: false, maxRetries: 0, retryDelayMs: 0 } } } })).ok()).toBe(true);
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page'); await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    const panel = settings.getByTestId('prompt-templates-panel'); const preview = panel.getByLabel('提示词编译预览', { exact: true });
    for (const [task, label] of [['writing', '正文写作'], ['extraction', '资料提取'], ['compression', '摘要压缩'], ['image', '生图提示词']] as const) {
      await panel.getByRole('tab', { name: label, exact: true }).click(); await panel.getByLabel('当前提示词预设', { exact: true }).selectOption(TASK_V3_PRESET_IDS[task]);
    }
    await panel.getByRole('tab', { name: '通用预设', exact: true }).click();
    await panel.locator('summary').filter({ hasText: '发送的工具定义' }).click();
    await expect(panel.getByLabel('当前提示词预设', { exact: true }).locator('option')).toHaveCount(1);
    for (const id of [...TAVERN_PRESET_IDS, NEUTRAL_PRESET_ID]) {
      if (id === NEUTRAL_PRESET_ID) await panel.getByLabel('当前提示词预设', { exact: true }).selectOption(id);
      else {
        await panel.getByLabel('导入提示词预设文件', { exact: true }).setInputFiles(join(process.cwd(), 'presets', id + '.json'));
        const naming = page.getByRole('dialog', { name: '导入预设', exact: true });
        await naming.getByRole('button', { name: '确认名称', exact: true }).click();
        await expect(panel.getByLabel('当前提示词预设', { exact: true })).not.toHaveValue(id);
      }
      await expect(panel.getByLabel('辅助标签处理', { exact: true })).toHaveValue('tavern');
      const carrier = tavernGeneralPresets().find(preset => preset.id === id)!.responseCarrier!;
      await expect(panel.getByLabel('提示词工具定义', { exact: true })).toContainText(carrier.name);
      if (id === 'tavern-reborn-v23') { await expect(panel.getByLabel('消息编排方式', { exact: true })).toHaveValue('reborn'); await expect(preview).toContainText('"role":"soliumbra"'); }
      if (carrier.archive) { await expect(panel.getByLabel('提示词工具定义', { exact: true })).toContainText('最新正文结尾'); await expect(preview).not.toContainText('<interaction_history>'); }
    }
    for (const protocol of ['openai-chat', 'openai-responses', 'gemini', 'claude']) {
      await panel.getByLabel('预览接口协议', { exact: true }).selectOption(protocol); await expect(panel.getByLabel('提示词工具定义', { exact: true })).toContainText('search_story');
      await expect(preview).toContainText('emit_complete_text');
    }
    await panel.getByLabel('预览搭配的任务', { exact: true }).selectOption('image');
    await expect(panel.getByLabel('提示词工具定义', { exact: true })).toContainText('IMAGE_PROMPT_OPTIMIZATION');
    await expect(preview).toContainText('完整 JSON 结果对象');
    await panel.getByLabel('当前提示词预设', { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('tavern-v3-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath('tavern-v3-mobile.png'), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    const saved = await (await page.request.get('/api/settings')).json(); expect(saved.promptTemplates.selected).toEqual(TASK_V3_PRESET_IDS); expect(saved.promptTemplates.general.selected).toBe(NEUTRAL_PRESET_ID);
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click(); await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    await panel.getByRole('tab', { name: '生图提示词', exact: true }).click(); await expect(panel.getByLabel('当前提示词预设', { exact: true })).toHaveValue(TASK_V3_PRESET_IDS.image);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('中性原生结果工具流式写作保留真实查询和预设思考，正文与刷新不混入辅助摘要', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json(); const providerId = 'native-carrier-browser';
  try {
    const templates = defaultPromptTemplates(); templates.general!.selected = NEUTRAL_PRESET_ID; templates.selected.writing = TASK_V3_PRESET_IDS.writing; templates.presets.extraction[0].useGeneral = false;
    expect((await page.request.put('/api/settings', { data: { ...previous, providers: [{ id: providerId, name: '原生结果工具验收', protocol: 'openai-chat', baseUrl: mockUrl }], writingProviderId: providerId, writingModel: 'e2e-native-carrier', planningProviderId: providerId, planningModel: 'e2e-fixture', extractionProviderId: providerId, extractionModel: 'e2e-fixture', modelParameters: [], promptTemplates: templates, imageSettings: { providerId: '', model: '', protocol: 'openai-images', size: '1024x1024', quality: 'auto', stylePrompt: '', autoPortrait: false, autoCG: false, timeoutMs: 120000 }, taskSettings: { extraction: { outputMode: 'prompt', autoRetry: false, maxRetries: 0, retryDelayMs: 0 } } } })).ok()).toBe(true);
    await createProject(page, 'E2E 原生结果工具'); await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.getByRole('dialog').getByLabel('这一次，你想写什么？', { exact: true }).fill('从城门继续。'); await page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true }).click();
    await expect.poll(() => visibleProse(page)).toContain('林舟走进白石城'); const branchId = await currentBranchId(page);
    await expect.poll(async () => (await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).state.chapters[0]?.status).toBe('ready');
    const prose = await visibleProse(page); expect(prose).toContain('林舟来到城门前。'); expect(prose).not.toMatch(/NATIVE_CHECK|辅助摘要|game>|draft>/);
    await expect(page.locator('.writing-activity[data-thinking-source="preset"]')).toHaveCount(2); await expect(page.locator('.writing-activity[data-kind="tool"]').filter({ hasText: 'search_story' })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('native-carrier-writing.png'), animations: 'disabled' });
    await page.reload(); await page.getByRole('button', { name: '打开作品 E2E 原生结果工具', exact: true }).click();
    await expect.poll(() => visibleProse(page)).toContain('林舟走进白石城'); expect(await visibleProse(page)).not.toContain('辅助摘要');
    await showGenerationProcess(page);
    await expect(page.locator('.writing-activity[data-thinking-source="preset"]')).toHaveCount(2);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('Gemini 工具参数流式开关保存与清除，正文在完整响应前显示并保留查询与思考', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  const writerId = 'gemini-args-writer', extractorId = 'gemini-args-extractor';
  const fixture = mockUrl.slice(0, -3);
  try {
    const templates = defaultPromptTemplates(); templates.general!.selected = NEUTRAL_PRESET_ID; templates.selected.writing = TASK_V3_PRESET_IDS.writing; templates.presets.extraction[0].useGeneral = false;
    expect((await page.request.put('/api/settings', { data: { ...previous, providers: [{ id: writerId, name: '参数分片写作', protocol: 'gemini', baseUrl: mockUrl }, { id: extractorId, name: '本地整理', protocol: 'openai-chat', baseUrl: mockUrl }], writingProviderId: writerId, writingModel: 'e2e-gemini-args', planningProviderId: extractorId, planningModel: 'e2e-fixture', extractionProviderId: extractorId, extractionModel: 'e2e-fixture', modelParameters: [], promptTemplates: templates, imageSettings: { ...previous.imageSettings, autoPortrait: false, autoCG: false }, taskSettings: { extraction: { outputMode: 'prompt', autoRetry: false, maxRetries: 0, retryDelayMs: 0 } } } })).ok()).toBe(true);
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page'); await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    const writing = settings.getByRole('region', { name: '正文写作模型设置', exact: true }); await openModelParameters(writing);
    const option = writing.getByLabel('Gemini 工具参数流式', { exact: true }); await expect(option).toHaveValue('');
    for (const value of ['true', 'false', '', 'true']) {
      await option.selectOption(value); await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
      const saved = await (await page.request.get('/api/settings')).json();
      const profile = saved.modelParameters.find((item: any) => item.role === 'writing' && item.providerId === writerId);
      if (value) expect(profile.geminiStreamFunctionCallArguments).toBe(value === 'true'); else expect(profile).not.toHaveProperty('geminiStreamFunctionCallArguments');
      expect(saved.modelParameters.filter((item: any) => item.role !== 'writing').every((item: any) => item.geminiStreamFunctionCallArguments === undefined)).toBe(true);
    }
    for (const [width, name] of [[1440, 'desktop'], [390, 'mobile']] as const) {
      await page.setViewportSize({ width, height: 1000 }); await option.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`gemini-args-option-${name}.png`), animations: 'disabled' });
    }
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click(); await settings.getByRole('button', { name: '任务模型', exact: true }).click(); await openModelParameters(writing); await expect(option).toHaveValue('true');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await createProject(page, 'E2E Gemini 参数分片'); const branchId = await currentBranchId(page);
    const before = await (await page.request.get(`${fixture}/__e2e/stats`)).json();
    await page.getByRole('button', { name: '开始创作', exact: true }).click(); await page.getByRole('dialog').getByLabel('章节标题（可选）', { exact: true }).fill('城门参数分片');
    const submitted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/branches/${branchId}/generate`);
    await page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true }).click(); const job = await (await submitted).json();
    await expect(page.locator('.streaming-prose')).toContainText('林舟来到城门前。'); expect(await visibleProse(page)).not.toContain('他推开城门');
    const active = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json(); expect(active.state.chapters).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath('gemini-args-partial-prose.png'), animations: 'disabled' });
    expect((await page.request.post(`${fixture}/__e2e/gemini-args-release`)).ok()).toBe(true);
    await expect.poll(() => visibleProse(page)).toContain('他推开城门，走进白石城。');
    await expect.poll(async () => (await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).state.chapters[0]?.status).toBe('ready');
    const activities = await (await page.request.get(`/api/jobs/${job.id}/activities?view=author`)).json();
    expect(activities.filter((activity: any) => activity.kind === 'tool' && activity.name === 'search_story')).toHaveLength(1);
    expect(activities.some((activity: any) => activity.kind === 'thinking' && activity.text?.includes('STREAM_ARGS_NATIVE_THOUGHT'))).toBe(true);
    expect(activities.some((activity: any) => activity.kind === 'thinking' && activity.thinkingSource === 'preset' && activity.text?.includes('STREAM_ARGS_PRESET_NOTE'))).toBe(true);
    expect(await visibleProse(page)).not.toMatch(/STREAM_ARGS|辅助摘要|partialArgs/);
    const after = await (await page.request.get(`${fixture}/__e2e/stats`)).json(); expect((after.modelRequestsByModel['e2e-gemini-args'] || 0) - (before.modelRequestsByModel['e2e-gemini-args'] || 0)).toBe(2);
    const exported = await (await page.request.get(`/api/branches/${branchId}/export`)).text(); expect(exported).toContain('他推开城门'); expect(exported).not.toMatch(/STREAM_ARGS|辅助摘要|partialArgs/);
    await page.reload(); await page.getByRole('button', { name: '打开作品 E2E Gemini 参数分片', exact: true }).click(); await expect.poll(() => visibleProse(page)).toContain('他推开城门'); await expect(page.locator('.writing-activity')).toHaveCount(4);
    await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await expect(page.locator('.writing-activity')).toHaveCount(0); await expect.poll(() => visibleProse(page)).toContain('他推开城门');
  } finally { await page.request.post(`${fixture}/__e2e/gemini-args-release`); await page.request.put('/api/settings', { data: previous }); }
});

test('通用预设和四任务支持文件导入导出，整套恢复先确认且保存后生效', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    const templates = defaultPromptTemplates(); templates.general!.selected = NEUTRAL_PRESET_ID;
    expect((await page.request.put('/api/settings', { data: { ...previous, promptTemplates: templates } })).ok()).toBe(true);
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page'); await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    const panel = settings.getByTestId('prompt-templates-panel');
    for (const [task, label] of [['general', '通用预设'], ['writing', '正文写作'], ['extraction', '资料提取'], ['compression', '摘要压缩'], ['image', '生图提示词']] as const) {
      await panel.getByRole('tab', { name: label, exact: true }).click();
      if (task !== 'general') await panel.getByLabel('当前提示词预设', { exact: true }).selectOption(TASK_V3_PRESET_IDS[task]);
      const download = page.waitForEvent('download'); await panel.getByRole('button', { name: '导出当前提示词预设', exact: true }).click();
      const text = await readFile((await (await download).path())!, 'utf8'); const exported = JSON.parse(text);
      expect(exported).toMatchObject({ format: 'ai-novel-prompt-preset', version: 2, task });
      if (task !== 'general') expect(exported.generalPreset.responseCarrier).toEqual({ name: 'emit_complete_text', field: 'content', archive: true });
      await panel.getByLabel('导入提示词预设文件', { exact: true }).setInputFiles({ name: `${task}.json`, mimeType: 'application/json', buffer: Buffer.from(text) });
      let naming = page.getByRole('dialog', { name: '导入预设', exact: true });
      await naming.getByLabel('预设名称', { exact: true }).fill(`导入${label}`);
      if (task === 'general') {
        await naming.getByRole('button', { name: '取消', exact: true }).click();
        await expect(panel.getByLabel('当前提示词预设', { exact: true }).locator('option')).toHaveCount(1);
        await panel.getByLabel('导入提示词预设文件', { exact: true }).setInputFiles({ name: 'general.json', mimeType: 'application/json', buffer: Buffer.from(text) });
        naming = page.getByRole('dialog', { name: '导入预设', exact: true }); await naming.getByLabel('预设名称', { exact: true }).fill(`导入${label}`);
      }
      await naming.getByRole('button', { name: '确认名称', exact: true }).click();
      await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue(`导入${label}`);
      await expect(panel.getByLabel('当前提示词预设', { exact: true })).not.toHaveValue(exported.preset.id);
    }
    const downloadAll = page.waitForEvent('download'); await panel.getByRole('button', { name: '导出全部提示词', exact: true }).click();
    const backupText = await readFile((await (await downloadAll).path())!, 'utf8'); const backup = JSON.parse(backupText);
    expect(Object.keys(backup)).toEqual(['format', 'version', 'templates']); expect(backup.templates.presets.image).toHaveLength(2);
    await panel.getByLabel('提示词预设名称', { exact: true }).fill('待替换草稿');
    const upload = () => panel.getByLabel('导入提示词预设文件', { exact: true }).setInputFiles({ name: 'all.json', mimeType: 'application/json', buffer: Buffer.from(backupText) });
    await upload(); let confirm = page.getByRole('dialog', { name: '导入整套提示词', exact: true });
    await expect(confirm).toContainText('生图提示词：2 个'); await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue('待替换草稿');
    await upload(); confirm = page.getByRole('dialog', { name: '导入整套提示词', exact: true });
    await confirm.getByRole('button', { name: '替换当前提示词编辑', exact: true }).click();
    await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue('导入生图提示词');
    expect((await (await page.request.get('/api/settings')).json()).promptTemplates).toEqual(templates);
    await page.screenshot({ path: testInfo.outputPath('prompt-transfer-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); await panel.getByRole('button', { name: '导出全部提示词', exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('prompt-transfer-mobile.png'), animations: 'disabled' });
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    const saved = await (await page.request.get('/api/settings')).json(); expect(saved.promptTemplates).toEqual(backup.templates); expect(saved.providers).toEqual(previous.providers);
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click(); await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    await expect(panel.getByLabel('提示词预设名称', { exact: true })).toHaveValue('导入正文写作');
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
    await expect(panel.getByLabel('当前提示词预设', { exact: true }).locator('option')).toHaveCount(defaultPromptTemplates().presets.writing.length);
    await modal.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(modal.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();
    expect((await (await page.request.get('/api/settings')).json()).promptTemplates.presets.writing[0].blocks[0].content).toBe('修正后的规则');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('正文尚未写完时插画已生成，保存后继续使用原图片', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-parallel-images';
  const release = () => page.request.post(mockUrl.slice(0, -3) + '/__e2e/image-writer-release');
  expect((await page.request.put('/api/settings', { data: { providers: [{ id: providerId, name: '本地并行图片验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }], writingProviderId: providerId, writingModel: 'e2e-images-parallel', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture', imageSettings: { providerId, model: 'e2e-image', protocol: 'openai-images', size: '1024x1024', quality: 'auto', stylePrompt: '', autoPortrait: true, autoCG: true, timeoutMs: 120000 } } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 写作与插画并行'); const branchId = await currentBranchId(page);
    await page.getByRole('button', { name: '从设定开始创作', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '开始生成', exact: true }).click();
    const images = page.getByRole('region', { name: '本次写作插画', exact: true });
    await expect(images.locator('.status-pill.completed')).toHaveCount(2); await expect(images).toContainText('待关联正文');
    await expectImagePixels(images.locator('img'));
    const draft = await (await page.request.get(`/api/branches/${branchId}/images`)).json();
    expect(draft.every((image: StoryImage) => image.bindingStatus === 'pending' && !image.chapterId)).toBe(true);
    const before = await (await page.request.get(`/api/branches/${branchId}`)).json(); expect(before.state.chapters).toHaveLength(0);
    const stats = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    expect(stats.lastImageRequest.referenceCount).toBe(1); expect(stats.lastImageRequest.prompt).toContain('WRITER_DIRECT_CG');
    await page.screenshot({ path: testInfo.outputPath('images-before-writing-completes.png'), animations: 'disabled' });
    await release();
    await expect.poll(async () => (await (await page.request.get(`/api/branches/${branchId}/images`)).json()).every((image: StoryImage) => image.bindingStatus === 'bound')).toBe(true);
    await expect(page.getByRole('button', { name: '生成本章 CG', exact: true })).toBeVisible();
    const bound = await (await page.request.get(`/api/branches/${branchId}/images`)).json();
    expect(bound.map((image: StoryImage) => image.id)).toEqual(draft.map((image: StoryImage) => image.id));
    expect((await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json()).imageRequests).toBe(stats.imageRequests);
  } finally { await release(); await page.request.put('/api/settings', { data: previous }); }
});

test('生图设置、自动人物与场景工具、全文选段 CG、重绘参考图修改及资料地图图册', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
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
    await expectImagePixels(page.locator('.chapter-images img'));
    const branchId = await currentBranchId(page);
    const listImages = async () => (await page.request.get(`/api/branches/${branchId}/images?view=author`)).json();
    const automatic = await listImages(); expect(automatic.every((image: any) => image.automatic)).toBeTruthy();
    expect(automatic.find((image: any) => image.kind === 'portrait').entityId).toBeTruthy();
    expect(automatic.find((image: any) => image.kind === 'cg').sourceText).toBe('林舟来到白石城，发现城门下藏着一把旧钥匙。');
    const stats = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json(); expect(stats.imageRequests).toBeGreaterThanOrEqual(2);
    const automaticCG = automatic.find((image: StoryImage) => image.kind === 'cg');
    expect(automaticCG.promptSource).toBe('writing'); expect(automaticCG.prompt).toContain('WRITER_DIRECT_CG'); expect(automaticCG.storyContext).toBeUndefined();
    await openChapterImageGroup(page, automaticCG); await page.locator(`.chapter-images [data-image-id="${automaticCG.id}"]`).getByRole('button', { name: '生图详情', exact: true }).click();
    await expect(modal).toContainText('写作 AI 生成的生图提示词'); await expect(modal).toContainText('没有再次调用提示词优化模型'); await modal.getByRole('button', { name: '关闭图片查看器', exact: true }).click();
    await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click();
    await expect.poll(async () => (await listImages()).filter((image: StoryImage) => image.status === 'completed').length).toBe(3);
    await page.locator('.prose p').first().evaluate(element => { const range = document.createRange(); range.setStart(element.firstChild!, 3); range.setEnd(element.firstChild!, 17); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); element.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await page.getByRole('button', { name: '生成选段 CG', exact: true }).click();
    await expect(modal.locator('.image-source-text')).toHaveText('到白石城，发现城门下藏着一把');
    await modal.getByRole('button', { name: '开始绘制', exact: true }).click(); await expect.poll(async () => (await listImages()).filter((image: StoryImage) => image.status === 'completed').length).toBe(4);
    const selectionStats = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    const selectionInput = JSON.parse(selectionStats.lastPromptOptimizationRequest.prompt);
    expect(selectionInput.storyContext).toContain('他拾起钥匙，决定沿着石阶寻找守城人留下的线索。');
    expect(selectionInput.storyContext).toContain('目标片段前文'); expect(selectionInput.storyContext).toContain('目标片段后文');
    const selectedCG = (await listImages()).find((image: StoryImage) => image.kind === 'cg' && !image.automatic && image.selection);
    expect(selectedCG.storyContext).toBe(selectionInput.storyContext);
    await openChapterImageGroup(page, selectedCG); await page.locator(`.chapter-images [data-image-id="${selectedCG.id}"]`).getByRole('button', { name: '生图详情', exact: true }).click();
    await modal.getByText('本次参考上下文', { exact: true }).click(); await expect(modal.getByTestId('image-story-context')).toContainText('守城人留下的线索'); await modal.getByRole('button', { name: '关闭图片查看器', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByLabel('章节正文', { exact: true }).fill('尚未保存的临时正文');
    await expect(page.getByRole('button', { name: '生成本章 CG', exact: true })).toBeDisabled();
    page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: '取消编辑', exact: true }).click();
    await tab(page, '故事图册'); await page.getByRole('button', { name: /^人物立绘 \d+$/ }).click();
    const portrait = page.locator('.image-gallery .story-image-card'); await expect(portrait).toHaveCount(1);
    await portrait.getByRole('button', { name: '关联资料', exact: true }).click(); modal = page.getByRole('dialog');
    await expect(modal).toContainText('世界资料 · 林舟'); await expect(modal.locator('.story-image-card')).toHaveCount(1);
    await modal.getByRole('button', { name: '重新绘制', exact: true }).first().click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click();
    await tab(page, '故事图册'); await page.getByRole('button', { name: /^人物立绘 \d+$/ }).click();
    await expect(page.locator('.image-group-card')).toHaveCount(1);
    await openImageGroup(page, automatic.find((image: StoryImage) => image.kind === 'portrait'));
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
    await tab(page, '故事图册'); await expect(page.locator('.image-gallery .image-group-card')).toHaveCount(6);
    await page.screenshot({ path: testInfo.outputPath('story-images-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('story-images-mobile.png'), animations: 'disabled' }); await page.setViewportSize({ width: 1440, height: 1000 });
    const cg = (await listImages()).find((image: any) => image.kind === 'cg' && !image.automatic && image.selection);
    await openImageGroup(page, cg);
    await page.locator(`[data-image-id="${cg.id}"]`).getByRole('button', { name: '关联剧情', exact: true }).click(); await expect(page.locator('.highlighted-paragraph')).toContainText('林舟来到白石城');
    await tab(page, '故事图册'); await page.getByRole('button', { name: '阅读视图', exact: true }).click();
    const readerImages = await (await page.request.get(`/api/branches/${branchId}/images?view=reader`)).json();
    expect(readerImages.some((image: any) => image.id === editedImage.id)).toBe(true);
    await expect(page.locator('.image-gallery .image-group-card')).toHaveCount(new Set(readerImages.map((image: StoryImage) => imageGroupKey(image))).size); await expect(page.locator('.image-gallery .image-kind-cg')).toHaveCount(3);
    await openImageGroup(page, editedImage); await expect(page.locator('.image-group-versions .story-image-card')).toHaveCount(3); await expect(page.getByRole('button', { name: 'AI 修改', exact: true }).first()).toBeVisible();
    await expect(page.locator('.workspace')).not.toContainText('保留五官，把斗篷改成蓝色');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('生图取消的迟到响应在阅读开关后继续显示，跨故事线仍隔离', async ({ page }) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  await createProject(page, 'E2E 插画请求范围'); const branchId = await currentBranchId(page);
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
  await openImageGroup(page, secretImage as StoryImage);
  const response = page.waitForResponse(value => value.url().includes('/ui-secret-image/cancel'));
  await page.getByRole('button', { name: '取消绘制', exact: true }).click();
  await page.getByRole('button', { name: '阅读视图', exact: true }).click();
  await expect(page.locator('.story-image-card')).toHaveCount(1); release(); await response;
  await expect(page.locator('.story-image-card')).toContainText('SECRET_IMAGE_LATE_RESULT');
  await expect(page.locator('.story-image-card .status-pill')).toHaveText('已取消');
  await expect(page.getByRole('button', { name: '取消绘制', exact: true })).toBeVisible();
  await showGenerationProcess(page); await expect(page.locator('.story-image-card')).toHaveCount(1);
  gate = new Promise<void>(resolve => { release = resolve; }); const nextResponse = page.waitForResponse(value => value.url().includes('/ui-secret-image/cancel'));
  await page.getByRole('button', { name: '取消绘制', exact: true }).click();
  // Refocusing refreshes metadata so the externally created branch is available.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await chooseBranch(page, fork.branch.id);
  await expect(page.locator('.image-gallery')).toContainText('故事图册尚未展开'); release(); await nextResponse;
  await expect(page.locator('.story-image-card')).toHaveCount(0); await expect(page.locator('.workspace')).not.toContainText('SECRET_IMAGE');
});

for (const width of [1440, 390]) test(`手动生图与重新绘制选择参考图、明确不用参考图及模型限制 ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const previous = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-manual-reference-provider';
  const imageSettings = { providerId, model: 'gpt-image-1', protocol: 'openai-images', size: '1024x1024', quality: 'auto', stylePrompt: '', autoPortrait: false, autoCG: false, timeoutMs: 120000, useCharacterReferences: true };
  expect((await page.request.put('/api/settings', { data: { providers: [{ id: providerId, name: '手选参考图本地验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }], writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-image-prompt', extractionProviderId: providerId, extractionModel: 'e2e-fixture', imageSettings } })).ok()).toBeTruthy();
  try {
    await createProject(page, `E2E 手选参考图 ${width}`);
    await page.getByRole('button', { name: '手动写第一章', exact: true }).click(); await page.getByLabel('章节标题', { exact: true }).fill('庭院相逢');
    await page.getByLabel('章节正文', { exact: true }).fill('林舟与苏晴站在白石城的庭院里，一起望向天空。'); await page.getByRole('button', { name: '保存正文', exact: true }).click(); await completedJobs(page, 1);
    const branchId = await currentBranchId(page); const imageList = async () => (await page.request.get(`/api/branches/${branchId}/images?view=author`)).json();
    const stats = async () => (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json(); const modal = page.getByRole('dialog');
    const changeModel = async (imageSettings: Record<string, unknown>) => { const saved = await (await page.request.get('/api/settings')).json(); const response = await page.request.put('/api/settings', { data: { ...saved, imageSettings } }); expect(response.ok(), await response.text()).toBeTruthy(); };
    await tab(page, '世界资料'); await page.getByRole('button', { name: '新增资料', exact: true }).click();
    await modal.getByLabel('名称', { exact: true }).fill('苏晴'); await modal.getByLabel('资料描述', { exact: true }).fill('马尾、蓝色旅行外套。'); await modal.getByRole('button', { name: '保存资料', exact: true }).click();
    for (const [index, name] of ['林舟', '苏晴'].entries()) {
      await page.locator('.entity-card').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: '生成人物立绘', exact: true }).click();
      await modal.getByRole('button', { name: '开始绘制', exact: true }).click(); await expect.poll(async () => (await imageList()).filter((image: any) => image.status === 'completed').length).toBe(index + 1);
    }
    const portraits = await imageList(); const first = portraits.find((image: any) => image.title.startsWith('林舟')); const second = portraits.find((image: any) => image.title.startsWith('苏晴'));
    await page.setViewportSize({ width, height: width < 760 ? 844 : 1000 }); await tab(page, '正文');
    await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await expect(modal.getByLabel('参考图选择', { exact: true })).toHaveValue('auto');
    await modal.getByLabel('参考图选择', { exact: true }).selectOption('manual'); await expect(modal.getByRole('checkbox')).toHaveCount(2);
    await modal.getByLabel('查找参考图片', { exact: true }).fill('苏晴'); await expect(modal.getByRole('checkbox')).toHaveCount(1);
    await modal.getByRole('checkbox', { name: `参考图片 ${second.title}`, exact: true }).check(); await modal.getByLabel('查找参考图片', { exact: true }).fill('');
    await expect(modal).toContainText('已选 1 张 / 最多 16 张'); await expect(modal.locator(`[data-reference-image-id="${second.id}"] img`)).toBeVisible();
    expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`manual-reference-picker-${width}.png`), animations: 'disabled' });
    async function submit(expected?: string[]) {
      const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/branches/${branchId}/images` && value.request().method() === 'POST');
      await modal.getByRole('button', { name: '开始绘制', exact: true }).click(); const result = await response; expect(result.ok(), await result.text()).toBeTruthy();
      const payload = result.request().postDataJSON(); if (expected === undefined) expect(payload).not.toHaveProperty('selectedReferenceImageIds'); else expect(payload.selectedReferenceImageIds).toEqual(expected);
      const { image } = await result.json(); await expect(modal).toHaveCount(0); await expect.poll(async () => (await imageList()).find((item: any) => item.id === image.id)?.status).toBe('completed');
      return (await imageList()).find((item: any) => item.id === image.id);
    }
    const cg = await submit([second.id]); expect(cg.referenceImageIds).toEqual([second.id]); expect(cg.referenceCharacters.map((item: any) => item.name)).toEqual(['苏晴']); expect((await stats()).lastImageRequest.referenceCount).toBe(1);
    const redraw = async (id: string) => { await openChapterImageGroup(page, (await imageList()).find((image: StoryImage) => image.id === id)); await page.locator(`.chapter-images [data-image-id="${id}"]`).getByRole('button', { name: '重新绘制', exact: true }).click(); };
    await redraw(cg.id); await expect(modal.getByLabel('参考图选择', { exact: true })).toHaveValue('manual'); await expect(modal.getByRole('checkbox', { name: `参考图片 ${second.title}`, exact: true })).toBeChecked();
    await modal.getByRole('checkbox', { name: `参考图片 ${second.title}`, exact: true }).uncheck(); await modal.getByRole('checkbox', { name: `参考图片 ${first.title}`, exact: true }).check();
    const changed = await submit([first.id]); expect(changed.referenceImageIds).toEqual([first.id]); expect(changed.active).toBe(false);
    await redraw(changed.id); await modal.getByLabel('参考图选择', { exact: true }).selectOption('none'); const noReferences = await submit([]); expect(noReferences.referenceImageIds).toEqual([]); expect((await stats()).lastImageRequest.referenceCount).toBe(0);
    await redraw(noReferences.id); await expect(modal.getByLabel('参考图选择', { exact: true })).toHaveValue('none'); await modal.getByLabel('参考图选择', { exact: true }).selectOption('auto'); const automatic = await submit(); expect(automatic.referenceImageIds).toHaveLength(2);
    const beforeCancel = (await stats()).imageRequests;
    await changeModel({ ...imageSettings, protocol: 'together-images', model: 'black-forest-labs/FLUX.1-kontext-pro', aspectRatio: '1:1' });
    await redraw(cg.id); await expect(modal).toContainText('最多 1 张'); await expect(modal.getByRole('checkbox', { name: `参考图片 ${first.title}`, exact: true })).toBeDisabled();
    await modal.getByRole('checkbox', { name: `参考图片 ${second.title}`, exact: true }).uncheck(); await modal.getByRole('checkbox', { name: `参考图片 ${first.title}`, exact: true }).check(); await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await changeModel({ ...imageSettings, model: 'dall-e-3', quality: 'standard' });
    await redraw(noReferences.id); await modal.getByLabel('参考图选择', { exact: true }).selectOption('manual'); await expect(modal).toContainText('当前图片模型不支持参考图'); await expect(modal.getByRole('button', { name: '开始绘制', exact: true })).toBeDisabled();
    await modal.getByLabel('参考图选择', { exact: true }).selectOption('none'); await expect(modal.getByRole('button', { name: '开始绘制', exact: true })).toBeEnabled(); await modal.getByRole('button', { name: '关闭对话框', exact: true }).click(); expect((await stats()).imageRequests).toBe(beforeCancel);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('专用生图提示词、AI 尺寸、两人物 CG 参考、Nano Banana 2 与 Together 参数及失败隔离', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
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
    const branchId = await currentBranchId(page);
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
    await expect.poll(async () => (await imageList()).filter((image: StoryImage) => image.kind === 'cg' && image.status === 'completed').length).toBe(1);
    const openaiCG = (await imageList()).find((image: any) => image.kind === 'cg');
    expect(openaiCG.promptStatus).toBe('completed'); expect(openaiCG.prompt).toContain('E2E_OPTIMIZED_IMAGE_PROMPT'); expect(openaiCG.prompt).not.toContain('剧情：'); expect(openaiCG.generationParameters.size).toBe('1536x1024'); expect(openaiCG.referenceCharacters.map((character: any) => character.name).sort()).toEqual(['林舟', '苏晴']);
    const firstStats = await stats(); expect(firstStats.lastPromptOptimizationRequest.model).toBe('e2e-image-prompt'); expect(firstStats.lastImageRequest).toMatchObject({ edit: true, referenceCount: 2, referenceBytes: true }); expect(firstStats.lastImageRequest.prompt.replace(/\r\n/g, '\n')).toBe(openaiCG.prompt);
    await tab(page, '故事图册'); await openImageGroup(page, openaiCG); await page.locator(`[data-image-id="${openaiCG.id}"]`).getByRole('button', { name: '生图详情', exact: true }).click();
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
    await settings.getByRole('button', { name: '返回作品', exact: true }).click(); await tab(page, '正文'); await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click(); await expect.poll(async () => (await imageList()).filter((image: StoryImage) => image.kind === 'cg' && image.status === 'completed').length).toBe(2);
    const geminiStats = await stats(); expect(geminiStats.lastImageRequest).toMatchObject({ protocol: 'gemini', referenceCount: 2, referenceBytes: true, parameters: { temperature: 0.4, topP: 0.8, topK: 32, seed: 123, maxOutputTokens: 8192, imageConfig: { aspectRatio: '16:9', imageSize: '2K' }, thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } }, systemInstruction: { parts: [{ text: 'IMAGE_SYSTEM_E2E：保持角色五官和服装。' }] } });
    const geminiCG = (await imageList()).find((image: any) => image.generationParameters?.protocol === 'gemini'); expect(geminiCG.generationParameters).toMatchObject({ aspectRatio: '16:9', imageSize: '2K', thinkingLevel: 'high', temperature: 0.4 });
    await page.getByRole('button', { name: '设置', exact: true }).click(); await settings.getByRole('button', { name: '生图与自动插画', exact: true }).click();
    await settings.getByLabel('图片接口', { exact: true }).selectOption('together-images'); await settings.getByLabel('图片模型名称', { exact: true }).fill('black-forest-labs/FLUX.2-dev');
    await expect(settings.getByLabel('图片模型思考等级', { exact: true })).toHaveCount(0); await expect(settings.getByLabel('图片模型系统提示词', { exact: true })).toHaveCount(0); await expect(settings.getByLabel('图片分辨率', { exact: true })).toHaveCount(0);
    await settings.getByLabel('图片尺寸', { exact: true }).selectOption('auto'); await settings.getByLabel('采样步数', { exact: true }).fill('30'); await settings.getByLabel('提示词引导强度', { exact: true }).fill('3'); await settings.getByLabel('图片随机种子', { exact: true }).fill('99'); await settings.getByLabel('图片输出格式', { exact: true }).selectOption('png');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存');
    const cleaned = (await (await page.request.get('/api/settings')).json()).imageSettings; expect(cleaned.thinkingLevel).toBeUndefined(); expect(cleaned.systemInstruction).toBeUndefined(); expect(cleaned.imageSize).toBeUndefined(); expect(cleaned.temperature).toBeUndefined(); expect(cleaned.promptModel).toBe('e2e-image-prompt');
    await settings.getByRole('button', { name: '返回作品', exact: true }).click(); await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click(); await expect.poll(async () => (await imageList()).filter((image: StoryImage) => image.kind === 'cg' && image.status === 'completed').length).toBe(3);
    const togetherStats = await stats(); expect(togetherStats.lastImageRequest).toMatchObject({ protocol: 'together-images', referenceCount: 2, referenceBytes: true, parameters: { width: 1536, height: 1024, steps: 30, guidance_scale: 3, seed: 99, output_format: 'png' } });
    await tab(page, '故事图册'); await openImageGroup(page, openaiCG); await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await expect(page.getByRole('button', { name: '生图详情', exact: true }).first()).toBeVisible(); await expect(page.locator('.workspace')).not.toContainText('E2E_OPTIMIZED_IMAGE_PROMPT'); await expect(page.locator('.workspace')).not.toContainText('IMAGE_SYSTEM_E2E');
    await showGenerationProcess(page); await page.getByRole('button', { name: '设置', exact: true }).click(); await settings.getByRole('button', { name: '生图与自动插画', exact: true }).click(); await settings.getByLabel('生图提示词优化模型', { exact: true }).fill('e2e-image-prompt-failure'); await settings.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('设置已保存'); await settings.getByRole('button', { name: '返回作品', exact: true }).click();
    const beforeFailure = await stats(); await tab(page, '正文'); await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await modal.getByRole('button', { name: '开始绘制', exact: true }).click(); await expect.poll(async () => (await imageList()).filter((image: StoryImage) => image.kind === 'cg' && image.status === 'failed').length).toBe(1); expect((await stats()).imageRequests).toBe(beforeFailure.imageRequests);
    await tab(page, '故事图册'); await openImageGroup(page, openaiCG); await page.locator('.image-group-versions .story-image-card').filter({ has: page.locator('.status-pill.failed') }).getByRole('button', { name: '生图详情', exact: true }).click(); await expect(modal).toContainText('生图提示词尚未完成'); await expect(modal.getByTestId('optimized-image-prompt')).toHaveCount(0); await modal.getByRole('button', { name: '关闭图片查看器', exact: true }).click();
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

async function imageCacheStory(page: Page, galleryVariants = false) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-image-cache-browser-')));
  let backup: Buffer;
  try {
    const { project, branchId } = readingProgressStory(store);
    const portrait = store.images.all(project.id).find(image => image.kind === 'portrait')!;
    const cg = store.images.all(project.id).find(image => image.kind === 'cg')!;
    const parked: StoryImage = { ...portrait, id: 'cache-parked', title: '未启用立绘版本' };
    const secret: StoryImage = { ...cg, id: 'cache-secret', title: '仅作者参考场景', visibility: 'secret', selection: { start: 0, end: 5 }, sourceText: cg.sourceText!.slice(0, 5) };
    for (const image of [parked, secret]) store.images.insert(image, { bytes: readingPng, mimeType: 'image/png' });
    const variants: StoryImage[] = galleryVariants ? [{ ...cg, id: 'gallery-cg-variant', title: '另一个构图', createdAt: '2026-10-21T03:00:00Z' }, { ...portrait, id: 'gallery-failed', title: '未完成的立绘', status: 'failed', error: '本地验收失败记录', createdAt: '2026-10-21T04:00:00Z' }] : [];
    for (const image of variants) store.images.insert(image, image.status === 'completed' ? { bytes: readingPng, mimeType: 'image/png' } : undefined);
    store.updateImageReferences(branchId, store.getBranch(branchId).revisionId, cg.chapterId, state => {
      state.imageIds = [...(state.imageIds ?? []), parked.id, secret.id, ...variants.map(image => image.id)];
      state.activeImageIds = [...(state.activeImageIds ?? []), secret.id];
    }, '保存图片缓存验收样例', revisionId => { for (const image of [parked, secret, ...variants]) store.images.update({ ...image, baseRevisionId: revisionId }); });
    const data = store.exportProject(project.id); data.project.title = `图片缓存验收 ${project.id.slice(0, 8)}`;
    backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: data, sources: [] }));
  } finally { store.close(); }
  const restored = await page.request.post('/api/restore', { multipart: { file: { name: 'image-cache.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
  expect(restored.ok(), await restored.text()).toBeTruthy();
  const project = await restored.json();
  const images: StoryImage[] = await (await page.request.get(`/api/branches/${project.mainBranchId}/images?view=author`)).json();
  return { project, images, parked: images.find(image => image.title === '未启用立绘版本')!, portrait: images.find(image => image.title === '河岸立绘')! };
}

async function expectImagePixels(images: Locator) {
  await expect(images.first()).toBeAttached();
  for (let index = 0; index < await images.count(); index++) {
    const image = images.nth(index); await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  }
}

for (const width of [1440, 390]) test(`手动编辑正文保留生成过程和本章插画，兼容旧数据与刷新 ${width}px`, async ({ page }, testInfo) => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-edit-history-browser-'))); let backup: Buffer;
  try {
    const story = chapterEditHistoryStory(store); const original = store.chapter(story.branchId, story.chapter.id).text;
    if (width === 1440) legacyChapterEdit(store, story.branchId, `旧版已编辑的开头。${original}`);
    const data = store.exportProject(story.project.id); data.project.title = `正文编辑历史 ${width}`;
    backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: data, sources: [] }));
  } finally { store.close(); }
  const response = await page.request.post('/api/restore', { multipart: { file: { name: 'chapter-history.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
  expect(response.ok(), await response.text()).toBe(true); const project = await response.json();
  const branchId = project.mainBranchId;
  const images: StoryImage[] = await (await page.request.get(`/api/branches/${branchId}/images`)).json(); const cg = images.find(image => image.kind === 'cg')!;
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); await page.goto('/');
  await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click(); await showGenerationProcess(page);
  const process = page.getByRole('region', { name: '生成过程', exact: true });
  await expect(process.locator('.writing-activity')).toHaveCount(2); await expect(page.locator('.chapter-images [data-cover-image-id]')).toHaveAttribute('data-cover-image-id', cg.id);
  await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByLabel('章节标题', { exact: true }).fill('灯塔修订标题');
  await page.getByRole('button', { name: '保存正文', exact: true }).click(); await expect(page.getByLabel('章节正文', { exact: true })).toHaveCount(0);
  await expect(process.locator('.writing-activity')).toHaveCount(2);
  for (const text of ['第一次手动修改后的正文。', '第二次手动修改后的正文。']) {
    await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByLabel('章节正文', { exact: true }).fill(text);
    await page.getByRole('button', { name: '保存正文', exact: true }).click(); await expect(page.getByLabel('章节正文', { exact: true })).toHaveCount(0);
    await expect(process).toHaveAttribute('data-location', 'original'); await expect(process.locator('.writing-activity')).toHaveCount(2);
    await process.locator('details').first().locator('summary').click(); await expect(process).toContainText('原生成过程：先核对灯塔场景。');
    await expect(page.locator('.chapter-images [data-cover-image-id]')).toHaveAttribute('data-cover-image-id', cg.id);
    await expectImagePixels(page.locator('.chapter-images img')); await expect(page.locator('.manuscript .prose')).toHaveText(text);
  }
  await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await expect(process).toHaveCount(0);
  await expect(page.locator('.chapter-images [data-cover-image-id]')).toHaveAttribute('data-cover-image-id', cg.id); await showGenerationProcess(page);
  await expect(process.locator('.writing-activity')).toHaveCount(2);
  await process.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`edited-process-${width}.png`), animations: 'disabled' });
  await page.reload(); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click(); await showGenerationProcess(page);
  await expect(process.locator('.writing-activity')).toHaveCount(2); await expect(page.locator('.manuscript .prose')).toHaveText('第二次手动修改后的正文。');
  const currentImages: StoryImage[] = await (await page.request.get(`/api/branches/${branchId}/images`)).json(); const retained = currentImages.find(image => image.id === cg.id)!;
  expect(retained.chapterId).not.toBe(cg.chapterId); expect(retained.active).toBe(true);
  await openChapterImageGroup(page, retained); const card = page.locator(`.chapter-images [data-image-id="${cg.id}"]`);
  await card.getByRole('button', { name: '生图详情', exact: true }).click(); await expect(page.getByTestId('image-viewer')).toContainText('正文已手动编辑');
  await page.getByRole('button', { name: '关闭图片查看器', exact: true }).click();
  await card.getByRole('button', { name: '关联剧情', exact: true }).click(); await expect(process.locator('.writing-activity')).toHaveCount(2);
  await card.getByRole('button', { name: '停用图片', exact: true }).click(); await expect(card).toHaveAttribute('data-image-active', 'false');
  await page.getByRole('button', { name: '返回本章插画', exact: true }).click(); await expect(page.locator('.chapter-images')).toContainText('本章暂无启用的插画');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`图册按人物和场景归组，搜索保留全部版本，启用删除及分支隔离（${viewport.width}px）`, async ({ page }, testInfo) => {
    const { project, images, portrait, parked } = await imageCacheStory(page, true);
    const branchId = project.mainBranchId;
    const view = await (await page.request.get(`/api/branches/${branchId}`)).json();
    const forkResponse = await page.request.post(`/api/branches/${branchId}/fork`, { data: { baseRevisionId: view.branch.revisionId, name: '图册旧分支' } });
    expect(forkResponse.ok()).toBe(true); const fork = await forkResponse.json();
    const cg = images.find(image => image.title === '另一个构图')!;
    const secret = images.find(image => image.title === '仅作者参考场景')!;
    const requests: string[] = []; const errors: string[] = [];
    page.on('request', request => { if (request.url().includes('/content?')) requests.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport); await page.goto('/');
    await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
    const chapterImages = page.locator('.chapter-images');
    const selectedCG = images.find(image => image.kind === 'cg' && !image.selection && image.active)!;
    await expect(chapterImages.locator('.image-group-card')).toHaveCount(2);
    await expect(chapterImages.locator(`[data-cover-image-id="${selectedCG.id}"]`)).toBeVisible();
    await expect(chapterImages.locator(`[data-cover-image-id="${cg.id}"]`)).toHaveCount(0);
    await openChapterImageGroup(page, selectedCG);
    await expect(chapterImages.locator('[data-image-id]')).toHaveCount(2);
    const oldCG = chapterImages.locator(`[data-image-id="${selectedCG.id}"]`);
    const variantCG = chapterImages.locator(`[data-image-id="${cg.id}"]`);
    await variantCG.getByRole('button', { name: '启用图片', exact: true }).click();
    await expect(oldCG).toHaveAttribute('data-image-active', 'false');
    await chapterImages.getByRole('button', { name: '返回本章插画', exact: true }).click();
    await expect(chapterImages.locator(`[data-cover-image-id="${cg.id}"]`)).toBeVisible();
    await openChapterImageGroup(page, cg);
    await variantCG.getByRole('button', { name: '停用图片', exact: true }).click();
    await expect(variantCG).toHaveAttribute('data-image-active', 'false');
    await oldCG.getByRole('button', { name: '启用图片', exact: true }).click();
    await chapterImages.getByRole('button', { name: '返回本章插画', exact: true }).click();
    await expect(chapterImages.locator(`[data-cover-image-id="${selectedCG.id}"]`)).toBeVisible();
    await chapterImages.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`chapter-active-images-${viewport.width}.png`), animations: 'disabled' });
    await tab(page, '故事图册');
    const groups = page.locator('.image-group-card');
    await expect(groups).toHaveCount(3); await expect(page.locator('.image-gallery-count')).toHaveText('3 组 · 6 个版本');
    const portraitGroup = page.locator(`.image-group-card[data-image-group="${imageGroupKey(portrait)}"]`);
    await expect(portraitGroup).toHaveAttribute('data-cover-image-id', portrait.id);
    await expect(portraitGroup).toContainText('3 个版本'); await expect(portraitGroup).toContainText('1 项待处理');
    await expectImagePixels(page.locator('.image-gallery img'));
    expect(requests.some(url => url.includes(parked.id))).toBe(false);
    await page.locator('.workspace-main').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`image-groups-${viewport.width}.png`), animations: 'disabled' });
    await portraitGroup.locator('[data-open-image-group]').scrollIntoViewIfNeeded();
    const overviewScroll = await page.locator('.workspace-main').evaluate(element => element.scrollTop);
    await openImageGroup(page, portrait); await expect(page.locator('.image-gallery h2')).toBeVisible();
    await page.getByRole('button', { name: '返回图册', exact: true }).click();
    expect(Math.abs(await page.locator('.workspace-main').evaluate(element => element.scrollTop) - overviewScroll)).toBeLessThanOrEqual(1);
    const search = page.getByRole('textbox', { name: '查找故事图片', exact: true });
    await search.fill('  未启用立绘版本  '); await expect(groups).toHaveCount(1);
    await openImageGroup(page, parked); await expect(page.locator('.image-group-versions .story-image-card')).toHaveCount(3);
    await expect(page.getByRole('button', { name: '重试绘制', exact: true })).toBeVisible();
    await expectImagePixels(page.locator('.image-group-versions img'));
    await showGenerationProcess(page); await expect(page.locator('.image-group-versions .story-image-card')).toHaveCount(3);
    const parkedCard = page.locator(`[data-image-id="${parked.id}"]`);
    await parkedCard.getByRole('button', { name: '启用图片', exact: true }).click(); await expect(parkedCard).toHaveAttribute('data-image-active', 'true');
    await expect(page.locator(`[data-image-id="${portrait.id}"]`)).toHaveAttribute('data-image-active', 'false');
    await parkedCard.getByRole('button', { name: /^查看图片/ }).click(); await expectImagePixels(page.getByTestId('image-viewer').locator('img'));
    await page.getByRole('button', { name: '关闭图片查看器', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`image-versions-${viewport.width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: '返回图册', exact: true }).click(); await expect(search).toHaveValue('  未启用立绘版本  ');
    await expect(portraitGroup).toHaveAttribute('data-cover-image-id', parked.id);
    await search.fill('另一个构图'); await expect(groups).toHaveCount(1); await openImageGroup(page, cg);
    await expect(page.locator('.image-group-versions .story-image-card')).toHaveCount(2);
    const expectedOrder = images.filter(image => imageGroupKey(image) === imageGroupKey(cg)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(image => image.id);
    expect(await page.locator('.image-group-versions [data-image-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-image-id')))).toEqual(expectedOrder);
    await page.getByRole('button', { name: '返回图册', exact: true }).click(); await search.fill('');
    await openImageGroup(page, secret); await expect(page.locator('.image-group-versions .story-image-card')).toHaveCount(1);
    await page.getByRole('button', { name: '删除图片', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '确认删除图片', exact: true }).click();
    await expect(page.getByRole('button', { name: '返回图册', exact: true })).toHaveCount(0);
    await expect(groups).toHaveCount(2); await expect(page.locator('.image-gallery-count')).toHaveText('2 组 · 5 个版本');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await openImageGroup(page, parked); await chooseBranch(page, fork.branch.id); await tab(page, '故事图册');
    await expect(groups).toHaveCount(3); await expect(page.locator('.image-gallery-count')).toHaveText('3 组 · 6 个版本');
    await expect(portraitGroup).toHaveAttribute('data-cover-image-id', portrait.id); expect(errors).toEqual([]);
  });
}

async function browserCacheEntries(page: Page) {
  return page.evaluate(() => new Promise<number>(resolve => {
    const request = indexedDB.open('ai-novel-cache-v1');
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('entries')) { db.close(); resolve(0); return; }
      const count = db.transaction('entries').objectStore('entries').count();
      count.onsuccess = () => { db.close(); resolve(count.result); };
    };
    request.onerror = () => resolve(0);
  }));
}

async function clearBrowserCacheEntries(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('ai-novel-cache-v1');
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction(['values', 'entries'], 'readwrite');
      tx.objectStore('values').clear(); tx.objectStore('entries').clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    request.onerror = () => reject(request.error);
  }));
}

test('小说往返与刷新复用正文资料和图片，更新版本及退出登录使旧缓存失效', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  const { project, portrait, parked } = await imageCacheStory(page);
  const other = await (await page.request.post('/api/projects', { data: { title: '另一部缓存验收小说' } })).json();
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'GET') requests.push(request.url()); });
  const chapterRequests = () => requests.filter(url => url.includes(`/branches/${project.mainBranchId}/chapters/`)).length;
  const viewRequests = () => requests.filter(url => new URL(url).pathname === `/api/branches/${project.mainBranchId}`).length;
  const imageRequests = () => requests.filter(url => url.includes('/content?')).length;
  // Do not use request routing here: Playwright routing disables the real HTTP cache.
  const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
  const networkUrls = new Map<string, string>(); const statuses = new Map<string, number>();
  cdp.on('Network.requestWillBeSent', event => networkUrls.set(event.requestId, event.request.url));
  cdp.on('Network.responseReceivedExtraInfo', event => statuses.set(event.requestId, event.statusCode));
  const revalidated = () => [...statuses].filter(([id, status]) => status === 304 && networkUrls.get(id)?.includes('/content?')).length;

  await page.goto('/');
  await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
  await page.locator('.chapter-item').filter({ hasText: '第一章 河岸' }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('第一章 河岸');
  await tab(page, '故事图册'); await expectImagePixels(page.locator('.image-gallery img'));
  const before = { chapters: chapterRequests(), views: viewRequests(), images: imageRequests() };
  const blob = await page.locator(`[data-cover-image-id="${portrait.id}"] img`).getAttribute('src');
  await expect.poll(() => browserCacheEntries(page)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await page.getByRole('button', { name: `打开作品 ${other.title}`, exact: true }).click();
  await expect(page.locator('.workspace-project-title')).toContainText(other.title);
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('第一章 河岸');
  await tab(page, '故事图册'); await expectImagePixels(page.locator('.image-gallery img'));
  expect({ chapters: chapterRequests(), views: viewRequests(), images: imageRequests() }).toEqual(before);
  expect(await page.locator(`[data-cover-image-id="${portrait.id}"] img`).getAttribute('src')).toBe(blob);

  await page.reload();
  await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('第一章 河岸');
  await tab(page, '故事图册'); await expectImagePixels(page.locator('.image-gallery img'));
  expect(chapterRequests()).toBe(before.chapters); expect(viewRequests()).toBe(before.views);
  await expect.poll(revalidated).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: testInfo.outputPath('persistent-cache-gallery.png'), animations: 'disabled' });

  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  const latest = await (await page.request.get(`/api/branches/${project.mainBranchId}`)).json();
  const entity = latest.state.entities.find((value: Entity) => value.name === '林舟');
  const update = await page.request.put(`/api/branches/${project.mainBranchId}/entities/${entity.id}`, { data: { baseRevisionId: latest.branch.revisionId, entity: { ...entity, description: '缓存验收：已更新的人物资料。' } } });
  expect(update.ok()).toBeTruthy();
  const deletion = await page.request.delete(`/api/branches/${project.mainBranchId}/images/${parked.id}`, { data: { baseRevisionId: (await update.json()).branch.revisionId } });
  expect(deletion.ok()).toBeTruthy();
  const renamed = await page.request.post(`/api/branches/${project.mainBranchId}/chapter-titles/apply`, { data: { baseRevisionId: (await deletion.json()).view.branch.revisionId, changes: [{ chapterId: latest.state.chapters[0].id, originalTitle: latest.state.chapters[0].title, title: '缓存更新后的章节名' }] } });
  expect(renamed.ok(), await renamed.text()).toBeTruthy();
  await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('缓存更新后的章节名');
  await tab(page, '世界资料');
  await expect(page.locator('.workspace')).toContainText('缓存验收：已更新的人物资料。');
  await tab(page, '故事图册');
  await openImageGroup(page, portrait);
  await expect(page.locator(`[data-image-id="${parked.id}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: '返回图册', exact: true }).click();
  await expectImagePixels(page.locator('.image-gallery img'));
  const finalBlob = await page.locator(`[data-cover-image-id="${portrait.id}"] img`).getAttribute('src');
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect.poll(() => browserCacheEntries(page)).toBe(0);
  expect(await page.evaluate(async url => { const image = new Image(); image.src = url!; try { await image.decode(); return true; } catch { return false; } }, finalBlob)).toBe(false);
});

test('浏览器禁用持久存储仍能加载小说和缩略图', async ({ page }) => {
  const { project } = await imageCacheStory(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { indexedDB.open = () => { throw new DOMException('Storage denied', 'SecurityError'); }; });
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
  await tab(page, '故事图册'); await expectImagePixels(page.locator('.image-gallery img'));
  expect(errors).toEqual([]);
});

test('会话失效清理缓存但保留编辑草稿，重新登录后仍可保存', async ({ page }) => {
  const { project } = await imageCacheStory(page);
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('章节正文', { exact: true }).fill('SESSION_DRAFT：登录失效时也不能丢掉这段未保存正文。');
  expect((await page.request.post('/api/auth/logout')).ok()).toBeTruthy();
  await expect(page.getByText('登录已失效，未保存的内容仍保留在当前页面。请先复制未保存内容，再返回书架重新登录。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('章节正文', { exact: true })).toHaveValue('SESSION_DRAFT：登录失效时也不能丢掉这段未保存正文。');
  await expect.poll(() => browserCacheEntries(page)).toBe(0);
  expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('登录已失效，未保存的内容仍保留在当前页面。请先复制未保存内容，再返回书架重新登录。', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('章节正文', { exact: true })).toHaveValue('SESSION_DRAFT：登录失效时也不能丢掉这段未保存正文。');
  await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await expect(page.locator('.prose')).toContainText('SESSION_DRAFT');
});

test('首次打开小说时正文不等待完整资料，资料到达后正常切章', async ({ page }) => {
  const { project } = await imageCacheStory(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === `/api/branches/${project.mainBranchId}`, async route => {
    const response = await route.fetch(); await gate; await route.fulfill({ response });
  });
  try {
    await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
    await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
    release();
    await expect(page.locator('.chapter-item')).toHaveCount(3);
    await page.locator('.chapter-item').filter({ hasText: '第一章 河岸' }).click();
    await expect(page.locator('.manuscript h1')).toHaveText('第一章 河岸');
    await tab(page, '世界资料'); await expect(page.locator('.workspace')).toContainText('林舟');
    await tab(page, '正文'); await expect(page.locator('.manuscript h1')).toHaveText('第一章 河岸');
  } finally { release(); }
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`图片内容跨页面复用，参考图和未启用立绘不重复下载（${viewport.width}px）`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const { project, images, parked, portrait } = await imageCacheStory(page);
    await page.setViewportSize(viewport);
    const requests: string[] = [];
    page.on('request', request => { if (/\/images\/[^/]+\/content\?/.test(request.url())) requests.push(request.url()); });
    await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
    await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
    await showGenerationProcess(page);
    await tab(page, '故事图册'); await expect(page.locator('.image-gallery .image-group-card')).toHaveCount(3);
    await expectImagePixels(page.locator('.image-gallery img'));
    await openImageGroup(page, portrait); await expectImagePixels(page.locator('.image-group-versions img')); await page.getByRole('button', { name: '返回图册', exact: true }).click();
    const authorRequests = () => requests.filter(url => new URL(url).searchParams.get('view') === 'author' && new URL(url).searchParams.get('size') === 'preview');
    for (const image of images) expect(authorRequests().filter(url => url.includes(image.id))).toHaveLength(1);
    const originalRequests = authorRequests().length;
    const cachedUrl = await page.locator(`[data-cover-image-id="${portrait.id}"] img`).getAttribute('src');

    for (let round = 0; round < 2; round++) {
      await tab(page, '世界资料');
      await expectImagePixels(page.locator('.entity-image-preview img'));
      await page.getByRole('button', { name: '查看 林舟 的详细资料', exact: true }).click();
      const details = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '世界资料 · 林舟', exact: true }) });
      await expect(details.locator('.story-image-card')).toHaveCount(2); await expectImagePixels(details.locator('.story-image-card img'));
      await details.locator(`[data-image-id="${parked.id}"]`).getByRole('button', { name: /^查看图片/ }).click();
      await expectImagePixels(page.getByTestId('image-viewer').locator('img'));
      await page.getByRole('button', { name: '关闭图片查看器', exact: true }).click();
      await details.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await page.locator('.entity-card').filter({ has: page.getByRole('button', { name: '林舟', exact: true }) }).getByRole('button', { name: '重新绘制', exact: true }).click();
      const request = page.getByRole('dialog');
      await request.getByLabel('参考图选择', { exact: true }).selectOption('manual');
      await expect(request.locator('.image-reference-option')).toHaveCount(3);
      await expectImagePixels(request.locator('.image-reference-option img'));
      await request.getByLabel('查找参考图片', { exact: true }).fill('河岸');
      await expect(request.locator('.image-reference-option')).toHaveCount(1);
      await request.getByLabel('查找参考图片', { exact: true }).fill('');
      await expectImagePixels(request.locator('.image-reference-option img'));
      if (round === 1) await page.screenshot({ path: testInfo.outputPath(`image-cache-references-${viewport.width}.png`), animations: 'disabled' });
      await request.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await tab(page, '正文'); await expectImagePixels(page.locator('.chapter-images img'));
      await tab(page, '故事图册'); await expectImagePixels(page.locator('.image-gallery img'));
    }
    expect(authorRequests()).toHaveLength(originalRequests);
    expect(await page.locator(`[data-cover-image-id="${portrait.id}"] img`).getAttribute('src')).toBe(cachedUrl);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Reading only changes activity visibility; all image bytes remain shared.
    await page.getByRole('button', { name: '阅读视图', exact: true }).click();
    await expect(page.locator('.image-gallery .image-group-card')).toHaveCount(3);
    await expectImagePixels(page.locator('.image-gallery img'));
    for (const source of await page.locator('.image-gallery img').evaluateAll(elements => elements.map(element => element.getAttribute('data-image-source')))) expect(source).toContain('view=author');
    await expect(page.locator(`.image-group-card[data-cover-image-id="${images.find(image => image.title === '仅作者参考场景')!.id}"]`)).toBeVisible();
    if (viewport.width < 768) await page.getByRole('button', { name: '打开章节目录', exact: true }).click();
    await page.locator('.chapter-item').filter({ hasText: '第一章 河岸' }).click();
    await tab(page, '故事图册'); await expect(page.locator('.image-gallery .image-group-card')).toHaveCount(3);
    await expectImagePixels(page.locator('.image-gallery img'));
    const firstChapterUrl = await page.locator(`[data-cover-image-id="${portrait.id}"] img`).getAttribute('src');
    expect(firstChapterUrl).toBe(cachedUrl);
    await showGenerationProcess(page);
    await expect(page.locator('.image-gallery .image-group-card')).toHaveCount(3);
    await expectImagePixels(page.locator('.image-gallery img'));
    expect(authorRequests()).toHaveLength(originalRequests);

    // Unchanged pixels survive a story revision; only the current selection changes.
    await openImageGroup(page, portrait);
    await page.locator(`[data-image-id="${parked.id}"]`).getByRole('button', { name: '启用图片', exact: true }).click();
    await expect(page.locator(`[data-image-id="${parked.id}"]`)).toHaveAttribute('data-image-active', 'true');
    await expectImagePixels(page.locator('.image-gallery img'));
    expect(authorRequests()).toHaveLength(originalRequests);
    expect(requests.filter(url => url.includes(parked.id) && !new URL(url).searchParams.has('size'))).toHaveLength(1);
    const leavingUrl = await page.locator(`[data-image-id="${parked.id}"] img`).getAttribute('src');
    await page.getByRole('button', { name: '返回书架', exact: true }).click();
    expect(await page.evaluate(async url => { const image = new Image(); image.src = url!; try { await image.decode(); return true; } catch { return false; } }, leavingUrl)).toBe(true);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect.poll(() => page.evaluate(async url => { const image = new Image(); image.src = url!; try { await image.decode(); return true; } catch { return false; } }, leavingUrl)).toBe(false);
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) test(`图片加载中跨页共用请求，等待和失败分开显示，阅读开关保留迟到图片（${viewport.width}px）`, async ({ page }, testInfo) => {
  const { project, parked, portrait } = await imageCacheStory(page);
  await page.setViewportSize(viewport);
  let finish!: () => void; let finishPortrait!: () => void; let delayedRequests = 0; let failedRequests = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const portraitGate = new Promise<void>(resolve => { finishPortrait = resolve; });
  await page.route(`**/images/${parked.id}/content?view=author**`, async route => { delayedRequests++; await gate; await route.continue(); });
  await page.route(`**/images/${portrait.id}/content?view=author**`, async route => {
    failedRequests++;
    if (failedRequests === 1) await route.fulfill({ status: 503, contentType: 'text/plain', body: 'temporary fixture failure' });
    else { await portraitGate; await route.continue(); }
  });
  try {
    await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
    await showGenerationProcess(page);
    await tab(page, '故事图册');
    // Inspect the failed cover before opening the group; re-opening a failed
    // thumbnail is an explicit new display attempt, rather than an automatic retry.
    await expect(page.locator(`[data-cover-image-id="${portrait.id}"]`).getByRole('status')).toHaveText('图片加载失败');
    await openImageGroup(page, portrait);
    const parkedCard = page.locator(`[data-image-id="${parked.id}"]`);
    await parkedCard.scrollIntoViewIfNeeded(); await expect.poll(() => delayedRequests).toBe(1);
    await expect(parkedCard.getByRole('status')).toHaveText('图片加载中…');
    await expect(parkedCard.locator('img')).toHaveCSS('visibility', 'hidden');
    const failedCard = page.locator(`[data-image-id="${portrait.id}"]`);
    await expect(failedCard.getByRole('status')).toHaveText('图片加载中…');
    await expect(failedCard.locator('img')).toHaveCSS('visibility', 'hidden');
    await parkedCard.getByRole('button', { name: /^查看图片/ }).click();
    await expect(page.getByTestId('image-viewer').locator('img')).toHaveAttribute('data-image-load-state', 'pending');
    await expect(page.getByTestId('image-viewer').locator('.cached-image-status')).toHaveText('图片加载中…');
    await page.screenshot({ path: testInfo.outputPath(`image-loading-viewer-${viewport.width}.png`), animations: 'disabled' });
    expect(delayedRequests).toBe(2);
    await page.getByRole('button', { name: '关闭图片查看器', exact: true }).click();
    await tab(page, '世界资料');
    const person = page.locator('.entity-card').filter({ has: page.getByRole('button', { name: '林舟', exact: true }) });
    await person.locator('.entity-image-preview').scrollIntoViewIfNeeded();
    await expect(person.locator('.entity-image-preview').getByRole('status')).toHaveText('图片加载中…');
    await person.getByRole('button', { name: '重新绘制', exact: true }).click();
    const referenceDialog = page.getByRole('dialog');
    await referenceDialog.getByLabel('参考图选择', { exact: true }).selectOption('manual');
    const reference = referenceDialog.locator(`[data-reference-image-id="${portrait.id}"]`);
    await reference.scrollIntoViewIfNeeded(); await expect(reference.getByRole('status')).toHaveText('图片加载中…');
    await expect(reference.locator('img')).toHaveCSS('visibility', 'hidden');
    await page.screenshot({ path: testInfo.outputPath(`image-loading-reference-${viewport.width}.png`), animations: 'disabled' });
    await referenceDialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
    finishPortrait(); await expectImagePixels(person.locator('.entity-image-preview img'));
    await expect(person.locator('.entity-image-preview .cached-image-status')).toHaveCount(0);
    expect(failedRequests).toBe(2);
    await page.getByRole('button', { name: '查看 林舟 的详细资料', exact: true }).click();
    const details = page.getByRole('dialog');
    await details.locator(`[data-image-id="${parked.id}"] img`).scrollIntoViewIfNeeded();
    expect(delayedRequests).toBe(2);
    await details.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.getByRole('button', { name: '阅读视图', exact: true }).click();
    finish();
    await tab(page, '故事图册'); await expect(page.locator('.image-gallery .image-group-card')).toHaveCount(3);
    await expectImagePixels(page.locator('.image-gallery img'));
    await expect(page.locator('.image-gallery .image-kind-cg')).toHaveCount(2);
    for (const source of await page.locator('.image-gallery img').evaluateAll(elements => elements.map(element => element.getAttribute('data-image-source')))) expect(source).toContain('view=author');
    await showGenerationProcess(page);
    await openImageGroup(page, parked); await expect(page.locator('.image-gallery')).toContainText('未启用立绘版本');
    await expectImagePixels(parkedCard.locator('img')); await expect(parkedCard.locator('.cached-image-status')).toHaveCount(0);
    await expect(parkedCard.locator('img')).toHaveCSS('visibility', 'visible'); expect(delayedRequests).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { finish(); finishPortrait(); }
});

test('图片启用暂存、停用后 CG 无人物参考、删除确认与失败保留、放大滚动和全屏查看', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const viewerErrors: string[] = []; page.on('pageerror', error => viewerErrors.push(error.message));
  const auth = await (await page.request.get('/api/auth/status')).json();
  if (!auth.authenticated) expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  const previous = await (await page.request.get('/api/settings')).json(); const providerId = 'e2e-image-selection-provider';
  expect((await page.request.put('/api/settings', { data: { providers: [{ id: providerId, name: '图片选择本地验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }], writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-image-prompt', extractionProviderId: providerId, extractionModel: 'e2e-fixture', imageSettings: { providerId, model: 'gpt-image-1', protocol: 'openai-images', size: '1024x1024', quality: 'auto', stylePrompt: '', autoPortrait: false, autoCG: false, timeoutMs: 120000, useCharacterReferences: true } } })).ok()).toBeTruthy();
  try {
    await createProject(page, 'E2E 图片选择与查看'); await page.getByRole('button', { name: '手动写第一章', exact: true }).click();
    await page.getByLabel('章节标题', { exact: true }).fill('第一章 城门'); await page.getByLabel('章节正文', { exact: true }).fill('林舟站在白石城的城门下。'); await page.getByRole('button', { name: '保存正文', exact: true }).click(); await completedJobs(page, 1);
    const branchId = await currentBranchId(page);
    const imageList = async () => (await page.request.get(`/api/branches/${branchId}/images?view=author`)).json();
    const stats = async () => (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    await tab(page, '世界资料'); const person = page.locator('.entity-card').filter({ has: page.getByRole('heading', { name: '林舟', exact: true }) });
    for (let index = 0; index < 3; index++) {
      await person.getByRole('button', { name: index ? '重新绘制' : '生成人物立绘', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '开始绘制', exact: true }).click();
      await expect.poll(async () => (await imageList()).filter((image: any) => image.kind === 'portrait' && image.status === 'completed').length).toBe(index + 1);
    }
    const portraits = (await imageList()).filter((image: any) => image.kind === 'portrait'); const [first, second, third] = portraits;
    expect(first.active).toBe(true); expect(second.active).toBe(false); expect(third.active).toBe(false);
    await tab(page, '故事图册'); await openImageGroup(page, first); const card = (id: string) => page.locator(`.image-gallery [data-image-id="${id}"]`);
    await expect(card(second.id).getByRole('button', { name: '启用后可修改', exact: true })).toBeDisabled();
    await card(third.id).getByRole('button', { name: '启用图片', exact: true }).click(); await expect(card(third.id)).toHaveAttribute('data-image-active', 'true'); await expect(card(first.id)).toHaveAttribute('data-image-active', 'false');
    await card(first.id).getByRole('button', { name: '启用图片', exact: true }).click(); await expect(card(first.id)).toHaveAttribute('data-image-active', 'true'); await expect(card(third.id)).toHaveAttribute('data-image-active', 'false');
    await tab(page, '世界资料'); await expect(person.locator('.entity-image-preview img')).toHaveAttribute('data-image-source', new RegExp(first.id)); await expectImagePixels(person.locator('.entity-image-preview img'));
    await tab(page, '故事图册'); await openImageGroup(page, first); await card(first.id).getByRole('button', { name: '停用图片', exact: true }).click(); await expect(card(first.id)).toHaveAttribute('data-image-active', 'false');
    await tab(page, '正文'); await page.getByRole('button', { name: '生成本章 CG', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '开始绘制', exact: true }).click(); await expect.poll(async () => (await imageList()).filter((image: StoryImage) => image.kind === 'cg' && image.status === 'completed').length).toBe(1);
    const noReference = await stats(); expect(noReference.lastImageRequest.referenceCount).toBe(0); for (const image of portraits) expect(noReference.lastPromptOptimizationRequest.prompt).not.toContain(image.id);
    const cg = (await imageList()).find((image: any) => image.kind === 'cg'); expect(cg.referenceImageIds).toEqual([]);
    await tab(page, '故事图册'); await openImageGroup(page, second); await card(second.id).getByRole('button', { name: '删除图片', exact: true }).click();
    const confirmation = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '删除图片', exact: true }) });
    await expect(confirmation).toContainText('历史版本与其他故事线中的引用会保留'); await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await expect(card(second.id)).toBeVisible();
    const deletionMatch = (url: URL) => url.pathname === `/api/branches/${branchId}/images/${second.id}`;
    await page.route(deletionMatch, async route => { if (route.request().method() === 'DELETE') await route.fulfill({ status: 503, json: { error: '删除失败：本地故障验收' } }); else await route.continue(); });
    await card(second.id).getByRole('button', { name: '删除图片', exact: true }).click(); await confirmation.getByRole('button', { name: '确认删除图片', exact: true }).click(); await expect(confirmation.getByRole('alert')).toContainText('删除失败'); await expect(card(second.id)).toHaveCount(1); await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await page.unroute(deletionMatch);
    // A large, neutral browser-only SVG fixture exercises real scrolling geometry.
    const viewerFixture = '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1800"><rect width="2400" height="1800" fill="#dce8d3"/><path d="M0 900H2400M1200 0V1800" stroke="#6d9661" stroke-width="20"/><text x="200" y="250" font-size="90" fill="#345c3a">VIEWER FIXTURE</text></svg>';
    await page.route(`**/api/branches/${branchId}/images/${second.id}/content**`, route => route.fulfill({ contentType: 'image/svg+xml', body: viewerFixture }));
    // Start cold so the geometry fixture is fetched instead of reusing the already viewed PNG.
    await page.reload(); await page.getByRole('button', { name: '打开作品 E2E 图片选择与查看', exact: true }).click(); await showGenerationProcess(page); await tab(page, '故事图册');
    await openImageGroup(page, second);
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
      await touchPage.goto('/'); await touchPage.getByRole('button', { name: '打开作品 E2E 图片选择与查看', exact: true }).tap(); await showGenerationProcess(touchPage); await tab(touchPage, '故事图册');
      await openImageGroup(touchPage, second);
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
    await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await expect(page.locator('.image-group-versions .image-kind-portrait')).toHaveCount(2); await expect(page.getByRole('button', { name: '删除图片', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '返回图册', exact: true }).click(); await expect(page.locator('.image-group-card')).toHaveCount(2); expect(viewerErrors).toEqual([]);
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

async function taskSettingsAuthentication(page: Page) {
  if (!(await (await page.request.get('/api/auth/status')).json()).authenticated) {
    expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  }
}

const taskSettingsDefaults = {
  extraction: { outputMode: 'prompt', autoRetry: false, maxRetries: 2, retryDelayMs: 5000 },
  planning: { enabled: true, mode: 'separate' },
};

for (const mode of ['structured', 'tool'] as const) test(`资料提取 ${mode} 模式可预览、保存并完成一次真实本地请求`, async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  try {
    const providerId = `extraction-${mode}`;
    expect((await page.request.put('/api/settings', { data: { ...previous,
      providers: [{ id: providerId, name: '提取模式本地模拟', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }],
      writingProviderId: providerId, writingModel: 'e2e-fixture', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
      modelParameters: [], promptTemplates: defaultPromptTemplates(), taskSettings: taskSettingsDefaults,
      imageSettings: { ...previous.imageSettings, providerId: '', model: '', autoPortrait: false, autoCG: false },
    } })).ok()).toBeTruthy();
    await page.goto('/'); await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByTestId('settings-page');
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    await selectModelTask(settings, '资料提取');
    const selector = settings.getByRole('combobox', { name: '资料提取输出模式', exact: true });
    await expect(selector).toHaveValue('prompt'); await selector.selectOption(mode);
    await settings.getByRole('button', { name: '提示词编排', exact: true }).click();
    const panel = settings.getByTestId('prompt-templates-panel');
    await panel.getByRole('tab', { name: '资料提取', exact: true }).click();
    await panel.locator('summary').filter({ hasText: '完整请求结构 · 示例模型与参数' }).click();
    await expect(panel.getByLabel('完整提示词请求', { exact: true })).toContainText(mode === 'tool' ? 'tool_choice' : 'response_format');
    await expect(panel.getByLabel('完整提示词请求', { exact: true })).toContainText('submit_extraction');
    if (mode === 'tool') {
      await panel.locator('summary').filter({ hasText: '发送的工具定义（1）' }).click();
      await expect(panel.getByLabel('提示词工具定义', { exact: true })).toContainText('summary');
      await expect(panel.getByLabel('提示词编译预览', { exact: true })).toContainText('普通文本不能替代工具调用');
    }
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click(); await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    await selectModelTask(settings, '资料提取');
    await expect(selector).toHaveValue(mode);
    await selector.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('extraction-output-desktop.png'), animations: 'disabled', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await selector.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('extraction-output-mobile.png'), animations: 'disabled' });
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settings.getByRole('button', { name: '返回作品', exact: true }).click();
    await createProject(page, `提取输出 ${mode} 验收`);
    const before = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json();
    await page.getByRole('button', { name: '导入小说', exact: true }).click();
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'extraction-mode.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 入城\n林舟走进白石城。') });
    const confirming = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/confirm'));
    await page.getByRole('dialog').getByRole('button', { name: '确认目录并整理', exact: true }).click();
    const job = await (await confirming).json(); await completedJobs(page, 1);
    const after = await (await page.request.get(mockUrl.slice(0, -3) + '/__e2e/stats')).json(); expect(after.modelRequests - before.modelRequests).toBe(1);
    const outputs = await (await page.request.get(`/api/jobs/${job.id}/outputs?view=author`)).json(); expect(outputs).toHaveLength(1); expect(outputs[0].status).toBe('applied');
    const { output } = await (await page.request.get(`/api/jobs/${job.id}/outputs/${outputs[0].id}?view=author`)).json();
    expect(JSON.parse(output.request.body)[mode === 'tool' ? 'tool_choice' : 'response_format']).toBeTruthy();
    expect(JSON.parse(output.text).entities[0].name).toBe('林舟'); expect(output.normalizedText).toContain('林舟走进白石城');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

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
    await selectModelTask(settings, '资料提取');
    const extraction = settings.getByRole('region', { name: '资料提取模型设置', exact: true });
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
    await selectModelTask(settings, '正文写作');
    let saves = 0;
    page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings') saves++; });
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.locator('.settings-feedback')).toContainText('数值不能大于 10'); expect(saves).toBe(0);
    await expect(settings.getByRole('tab', { name: '资料提取', selected: true, exact: true })).toBeVisible();
    await expect(retries).toBeFocused();
    await retries.fill('3'); await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.locator('.settings-feedback')).toContainText('请填写此项'); expect(saves).toBe(0);
    await delay.fill('1.25');
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    const saved = await (await page.request.get('/api/settings')).json();
    expect(saved.taskSettings).toEqual({ extraction: { outputMode: 'prompt', autoRetry: true, maxRetries: 3, retryDelayMs: 1250 } });
    expect(saved.planningProviderId).toBe(providerId); expect(saved.planningModel).toBe('e2e-planning');
    await page.screenshot({ path: testInfo.outputPath('task-controls-desktop.png'), animations: 'disabled', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await extraction.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('task-controls-mobile.png'), animations: 'disabled' });
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    await settings.getByRole('button', { name: '返回作品', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await settings.getByRole('button', { name: '任务模型', exact: true }).click();
    await selectModelTask(settings, '资料提取');
    await expect(retries).toHaveValue('3'); await expect(delay).toHaveValue('1.25');
  } finally { await page.request.put('/api/settings', { data: previous }); }
});

test('默认完整作者资料，阅读开关保留私密人物、插画和编辑操作', async ({ page }, testInfo) => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-mixed-reader-browser-'))); let backup: Buffer;
  try {
    const { project, branchId, chapters, allyId } = mixedVisibilityStory(store, true); const stamp = new Date().toISOString();
    const state = store.readingState(branchId, chapters[1]);
    const common = { projectId: project.id, branchId, baseRevisionId: store.getBranch(branchId).revisionId, chapterId: chapters[1], status: 'completed' as const, prompt: '作者提示词不进入阅读视图', automatic: false, visibility: 'public' as const, publicMaterial: true, mimeType: 'image/png' as const, createdAt: stamp, updatedAt: stamp };
    const assets: StoryImage[] = [
      { ...common, id: 'mixed-portrait', kind: 'portrait', entityId: allyId, title: '阿岚公开立绘', materialFactIds: state.entities.find(entity => entity.id === allyId)!.facts.filter(fact => fact.visibility === 'public').map(fact => fact.id) },
      { ...common, id: 'mixed-cg', kind: 'cg', title: '同章公开场景', sourceText: store.chapter(branchId, chapters[1]).text },
      { ...common, id: 'mixed-private', kind: 'cg', title: '作者私密插画', visibility: 'secret', publicMaterial: undefined, selection: { start: 0, end: 5 }, sourceText: store.chapter(branchId, chapters[1]).text.slice(0, 5) },
    ];
    for (const image of assets) store.images.insert(image, { bytes: readingPng, mimeType: 'image/png' });
    store.updateImageReferences(branchId, store.getBranch(branchId).revisionId, chapters[1], state => {
      state.imageIds = [...(state.imageIds ?? []), ...assets.map(image => image.id)]; state.activeImageIds = [...(state.activeImageIds ?? []), ...assets.map(image => image.id)];
    }, '后补同章插画', revisionId => { for (const image of assets) store.images.update({ ...image, baseRevisionId: revisionId }); });
    backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: store.exportProject(project.id), sources: [] }));
  } finally { store.close(); }
  const restored = await page.request.post('/api/restore', { multipart: { file: { name: 'mixed-reader.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
  expect(restored.ok(), await restored.text()).toBeTruthy(); const project = await restored.json();
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await page.locator('.chapter-item').filter({ hasText: '同章会面' }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('同章会面');
  await expect(page.locator('.context-sidebar')).toContainText('林舟'); await expect(page.locator('.context-sidebar')).toContainText('阿岚');
  await tab(page, '世界资料');
  await expect(page.locator('.entity-card').filter({ has: page.getByRole('button', { name: '林舟', exact: true }) })).toHaveCount(1);
  await expect(page.locator('.entity-card').filter({ has: page.getByRole('button', { name: '阿岚', exact: true }) })).toHaveCount(1);
  await expect(page.locator('.workspace')).toContainText('未揭晓称号');
  await page.getByRole('button', { name: '阅读视图', exact: true }).click();
  await page.locator('.entity-card').getByRole('button', { name: '林舟', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('幕后身份答案'); await expect(page.getByRole('dialog')).toContainText('未来登塔安排');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await tab(page, '故事图册'); await expect(page.locator('.story-image-card')).toHaveCount(3);
  await expect(page.locator('.story-image-grid')).toContainText('阿岚 · 立绘'); await expect(page.locator('.story-image-grid')).toContainText('同章会面 · 整章 CG');
  await expect(page.locator('.story-image-grid')).toContainText('同章会面 · 选段 CG');
  for (const image of await (await page.request.get(`/api/branches/${project.mainBranchId}/images?chapterId=${(await (await page.request.get(`/api/branches/${project.mainBranchId}?view=author`)).json()).state.chapters[1].id}`)).json()) expect((await page.request.get(image.url)).status()).toBe(200);
  await page.screenshot({ path: testInfo.outputPath('same-chapter-reader-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.story-image-card')).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('same-chapter-reader-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await showGenerationProcess(page); await expect(page.locator('.story-image-card')).toHaveCount(3);
  const authorImages = await (await page.request.get(`/api/branches/${project.mainBranchId}/images?view=author`)).json();
  const privateImage = authorImages.find((image: StoryImage) => image.visibility === 'secret');
  expect((await page.request.get(`/api/branches/${project.mainBranchId}/images/${privateImage.id}/content`)).status()).toBe(200);
  await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await expect(page.locator('.story-image-card')).toHaveCount(3);
  await page.locator('.chapter-item').filter({ hasText: '河岸初遇' }).click(); await expect(page.locator('.story-image-card')).toHaveCount(0);
});

test('切章保持完整当前资料，阅读开关不改变搜索、地图和图册，迟到正文仍隔离', async ({ page }, testInfo) => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-reading-browser-')));
  let backup: Buffer;
  try {
    const { project } = readingProgressStory(store);
    backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: store.exportProject(project.id), sources: [] }));
  } finally { store.close(); }
  const restored = await page.request.post('/api/restore', { multipart: { file: { name: 'reading.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
  expect(restored.ok(), await restored.text()).toBeTruthy();
  const project = await restored.json(); const branchId = project.mainBranchId;
  const branch = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
  const [firstId, secondId, thirdId] = branch.state.chapters.map((chapter: { id: string }) => chapter.id);
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
  const card = (name: string) => page.locator('.entity-card').filter({ has: page.getByRole('button', { name, exact: true }) });
  for (const title of ['第一章 河岸', '第二章 山城', '第三章 灯塔']) {
    await page.locator('.chapter-item').filter({ hasText: title }).click(); await expect(page.locator('.manuscript h1')).toHaveText(title);
    await expect(page.locator('.context-sidebar')).toContainText('阿岚');
    await tab(page, '世界资料'); await expect(card('林舟').locator('.entity-description')).toContainText('目前位于灯塔');
    await expect(card('铜钥').locator('.entity-fact-preview')).toContainText('铜钥断裂');
    await expect(card('银灯').locator('.entity-fact-preview')).toContainText('银灯熄灭');
    await expect(page.locator('.entity-card')).toHaveCount(branch.state.entities.filter((entity: Entity) => !entity.mergedInto).length);
  }
  await page.getByRole('button', { name: '阅读视图', exact: true }).click();
  await expect(card('阿岚')).toHaveCount(1); await expect(card('林舟').getByRole('button', { name: '编辑 林舟', exact: true })).toBeVisible();
  await tab(page, '地点关系'); await expect(page.locator('.character-location').filter({ hasText: '林舟' })).toContainText('目前位于灯塔');
  await page.screenshot({ path: testInfo.outputPath('unified-materials-desktop.png'), fullPage: true, animations: 'disabled' });
  await tab(page, '故事图册'); await expect(page.locator('.story-image-card')).toHaveCount((await (await page.request.get('/api/branches/' + branchId + '/images')).json()).length);
  await page.getByRole('button', { name: '搜索', exact: true }).click(); await page.getByLabel('搜索正文和资料', { exact: true }).fill('秘密看守');
  await page.getByRole('dialog').getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.locator('.search-results')).toContainText('秘密看守');
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  // Force a real cold read; reloading alone now retains chapters in IndexedDB.
  await clearBrowserCacheEntries(page);
  // A slow chapter response must not replace the later selected prose.
  await page.reload(); await page.getByRole('button', { name: '打开作品 ' + project.title, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const held = new Promise<void>(resolve => { reached = resolve; });
  await page.route('**/api/branches/' + branchId + '/chapters/' + firstId, async route => { const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); });
  try {
    await page.locator('.chapter-item').filter({ hasText: '第一章 河岸' }).click(); await held;
    await page.locator('.chapter-item').filter({ hasText: '第二章 山城' }).click(); await expect(page.locator('.manuscript h1')).toHaveText('第二章 山城');
    release(); await page.unrouteAll({ behavior: 'wait' }); await expect(page.locator('.manuscript h1')).toHaveText('第二章 山城');
    await expect(page.locator('.context-sidebar')).toContainText('阿岚');
  } finally { release(); }
  await page.setViewportSize({ width: 390, height: 844 }); await tab(page, '地点关系');
  await expect(page.locator('.character-location').filter({ hasText: '林舟' })).toContainText('目前位于灯塔');
  await page.screenshot({ path: testInfo.outputPath('unified-materials-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const chapterId of [firstId, secondId, thirdId]) expect((await (await page.request.get('/api/branches/' + branchId + '?view=reader&chapterId=' + chapterId)).json()).state).toEqual(branch.state);
});

test('视图和章节往返复用正文与完整资料，保留滚动且空闲轮询不重绘', async ({ page }, testInfo) => {
  const project = await restoreToolbarStory(page, 'E2E 章节与视图缓存');
  const chapterRequests = new Map<string, number>(); const materialRequests = new Map<string, number>();
  page.on('request', request => {
    if (request.method() !== 'GET') return; const url = new URL(request.url());
    if (url.pathname.startsWith(`/api/branches/${project.mainBranchId}/chapters/`)) chapterRequests.set(url.pathname, (chapterRequests.get(url.pathname) ?? 0) + 1);
    if (url.pathname === `/api/branches/${project.mainBranchId}`) materialRequests.set(url.search, (materialRequests.get(url.search) ?? 0) + 1);
  });
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('长街');
  for (const title of ['起点', '长街', '起点', '长街']) {
    await page.locator('.chapter-item').filter({ hasText: title }).click(); await expect(page.locator('.manuscript h1')).toHaveText(title);
    await expect(page.locator('.context-note')).toHaveText('当前故事线的完整资料');
  }
  expect([...chapterRequests.values()]).toEqual([1, 1]);
  expect([...materialRequests.values()]).toEqual([1]);
  // Keep the exact DOM node, not merely an equivalent new copy of the prose.
  await page.locator('.manuscript-wrap').evaluate(element => { element.scrollTop = 500; (window as any).__cachedManuscript = element.querySelector('.manuscript'); });
  await expect.poll(() => page.locator('.manuscript-wrap').evaluate(element => element.scrollTop)).toBe(500);
  await tab(page, '世界资料'); await expect(page.getByRole('heading', { name: '世界资料', exact: true })).toBeVisible();
  await expect(page.locator('.writing-layout')).toBeHidden();
  await tab(page, '地点关系'); await tab(page, '正文');
  expect(await page.locator('.manuscript').evaluate(element => element === (window as any).__cachedManuscript)).toBe(true);
  await expect.poll(() => page.locator('.manuscript-wrap').evaluate(element => element.scrollTop)).toBe(500);
  await page.locator('.chapter-item').filter({ hasText: '起点' }).click(); await expect(page.locator('.manuscript h1')).toHaveText('起点');
  await expect.poll(() => page.locator('.manuscript-wrap').evaluate(element => element.scrollTop)).toBe(0);
  await page.locator('.chapter-item').filter({ hasText: '长街' }).click(); await expect(page.locator('.manuscript h1')).toHaveText('长街');
  await expect.poll(() => page.locator('.manuscript-wrap').evaluate(element => element.scrollTop)).toBe(500);
  await page.evaluate(() => {
    (window as any).__proseMutations = 0;
    const observer = new MutationObserver(records => { (window as any).__proseMutations += records.length; });
    observer.observe(document.querySelector('.writing-layout')!, { subtree: true, childList: true, characterData: true });
    (window as any).__proseObserver = observer;
  });
  await page.waitForTimeout(2300); // Observe a complete two-second polling interval.
  expect(await page.evaluate(() => { (window as any).__proseObserver.disconnect(); return (window as any).__proseMutations; })).toBe(0);
  expect([...chapterRequests.values()]).toEqual([1, 1]); expect([...materialRequests.values()].every(count => count === 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('navigation-cache-desktop.png'), animations: 'disabled' });
  await showGenerationProcess(page);
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
  const beforeToggle = [...materialRequests.values()];
  await page.getByRole('button', { name: '阅读视图', exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('长街');
  await expect.poll(() => page.locator('.manuscript-wrap').evaluate(element => element.scrollTop)).toBe(500);
  expect([...materialRequests.values()]).toEqual(beforeToggle);
  await expect(page.getByText('正在打开故事世界…', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await tab(page, '世界资料'); await tab(page, '正文'); await expect(page.locator('.manuscript h1')).toHaveText('长街');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('navigation-cache-mobile.png'), animations: 'disabled' });
});

test('正文延迟不清空当前完整资料，秘密标记和标题编辑在阅读视图保留', async ({ page }) => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-cache-browser-'))); let backup: Buffer;
  try {
    const { project } = readingProgressStory(store); const data = store.exportProject(project.id); data.project.title = 'E2E 缓存版本与边界';
    backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: data, sources: [] }));
  } finally { store.close(); }
  const restored = await page.request.post('/api/restore', { multipart: { file: { name: 'cached.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
  expect(restored.ok()).toBeTruthy(); const project = await restored.json();
  const branch = await (await page.request.get(`/api/branches/${project.mainBranchId}?view=author`)).json(); const first = branch.state.chapters[0];
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click(); await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const held = new Promise<void>(resolve => { started = resolve; });
  await page.route(url => url.pathname === `/api/branches/${project.mainBranchId}/chapters/${first.id}`, async route => {
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  try {
    await page.locator('.chapter-item').filter({ hasText: first.title }).click(); await held;
    await expect(page.getByText('正在翻开这一章…', { exact: true })).toBeVisible(); await expect(page.locator('.context-sidebar')).toContainText('阿岚');
    release(); await expect(page.locator('.manuscript h1')).toHaveText(first.title); await expect(page.locator('.context-sidebar')).toContainText('林舟');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  await page.locator('.chapter-item').filter({ hasText: '第三章 灯塔' }).click(); await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
  await showGenerationProcess(page); await tab(page, '世界资料');
  const person = page.locator('.entity-card').filter({ has: page.getByRole('button', { name: '林舟', exact: true }) });
  await person.getByRole('button', { name: '编辑 林舟', exact: true }).click();
  const modal = page.getByRole('dialog'); await modal.getByLabel('剧情中尚未公开', { exact: true }).check(); await modal.getByRole('button', { name: '保存资料', exact: true }).click(); await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: '阅读视图', exact: true }).click();
  await expect(page.locator('.entity-card').filter({ has: page.getByRole('button', { name: '林舟', exact: true }) })).toHaveCount(1);
  await tab(page, '正文'); await expect(page.locator('.context-sidebar')).toContainText('林舟');
  await showGenerationProcess(page);
  await page.locator('.chapter-item').filter({ hasText: first.title }).click(); await expect(page.locator('.manuscript h1')).toHaveText(first.title);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('章节标题', { exact: true }).fill('河岸修订'); await page.getByRole('button', { name: '保存正文', exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('河岸修订');
  await page.locator('.chapter-item').filter({ hasText: '第三章 灯塔' }).click(); await page.locator('.chapter-item').filter({ hasText: '河岸修订' }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('河岸修订');
});

test('旧作品直接使用完整作者资料，切章和阅读显示不改写原始状态', async ({ page }, testInfo) => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-legacy-browser-'))); let backup: Buffer;
  try {
    const { project } = legacyReadingProgressStory(store);
    backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: store.exportProject(project.id), sources: [] }));
  } finally { store.close(); }
  const restored = await page.request.post('/api/restore', { multipart: { file: { name: 'legacy.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
  expect(restored.ok(), await restored.text()).toBeTruthy(); const project = await restored.json(); const branchId = project.mainBranchId;
  const branch = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('第五章');
  const card = (name: string) => page.locator('.entity-card').filter({ has: page.getByRole('button', { name, exact: true }) });
  for (const index of [0, 1, 2, 3, 4]) {
    const title = `第${['一', '二', '三', '四', '五'][index]}章`;
    await page.locator('.chapter-item').filter({ hasText: title }).click(); await expect(page.locator('.manuscript h1')).toHaveText(title);
    await tab(page, '世界资料'); await expect(page.locator('.entity-card')).toHaveCount(branch.state.entities.filter((entity: Entity) => !entity.mergedInto).length);
    await expect(card('铜钥')).toHaveCount(1); await expect(card('幕后客')).toHaveCount(1);
    const response = await page.request.get(`/api/branches/${branchId}?chapterId=${branch.state.chapters[index].id}`);
    expect(response.ok()).toBeTruthy(); expect((await response.json()).state).toEqual(branch.state);
  }
  await tab(page, '地点关系');
  await expect(page.locator('.character-location').filter({ hasText: '林舟' })).toContainText('目前位于山城');
  await expect(page.locator('.character-location').filter({ hasText: '阿岚' })).toContainText('目前位于山城');
  await expect(page.locator('.character-location').filter({ hasText: '林夏' })).toContainText('目前位于树林');
  await page.screenshot({ path: testInfo.outputPath('legacy-reading-positions.png'), fullPage: true, animations: 'disabled' });
});

test('章节维护：单章重提取、清除资料、删除资料和章节，阅读快照与回退同步', async ({ page }, testInfo) => {
  const previous = await (await page.request.get('/api/settings')).json();
  const providerId = 'e2e-chapter-maintenance';
  try {
    const settings = await page.request.put('/api/settings', { data: {
      ...previous, providers: [...previous.providers, { id: providerId, name: '章节维护模拟接口', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: 'fake-maintenance-key' }],
      extractionProviderId: providerId, extractionModel: 'e2e-fixture',
      taskSettings: { ...previous.taskSettings, extraction: { outputMode: 'prompt', autoRetry: false, maxRetries: 0, retryDelayMs: 1000 } },
    } });
    expect(settings.ok(), await settings.text()).toBeTruthy();
    const store = new Store(mkdtempSync(join(tmpdir(), 'novel-maintenance-browser-'))); let backup: Buffer;
    try {
      const { project } = readingProgressStory(store); const data = store.exportProject(project.id); data.project.title = '章节维护浏览器验收';
      backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: data, sources: [] }));
    } finally { store.close(); }
    const restored = await page.request.post('/api/restore', { multipart: { file: { name: 'maintenance.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
    expect(restored.ok(), await restored.text()).toBeTruthy(); const project = await restored.json(); const branchId = project.mainBranchId;
    const initial = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    const [firstId, secondId, thirdId] = initial.state.chapters.map((chapter: { id: string }) => chapter.id);
    const stats = async () => (await (await page.request.get(`http://127.0.0.1:${process.env.E2E_MODEL_PORT || '4329'}/__e2e/stats`)).json()).modelRequests;
    await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
    await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
    await expect(page.locator('.chapter-actions')).toHaveCount(1);
    await showGenerationProcess(page);
    const select = async (title: string) => { await page.locator('.chapter-item').filter({ hasText: title }).click(); await expect(page.locator('.manuscript h1')).toHaveText(title); };
    const action = async (name: string) => { await page.locator('.chapter-actions summary').click(); await page.getByRole('button', { name, exact: true }).click(); };
    await select('第二章 山城'); const beforeExtract = await stats();
    await action('重新提取本章资料'); const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('只请求本章'); await dialog.getByRole('button', { name: '开始重新提取', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).state.chapters[1].status).toBe('ready');
    await expect(page.locator('.chapter-item').filter({ hasText: '第二章 山城' })).not.toContainText('待整理');
    expect(await stats()).toBe(beforeExtract + 1);
    const afterExtract = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json();
    expect(afterExtract.state.chapters[2]).toEqual(initial.state.chapters[2]); expect(afterExtract.state.chapters[1].summary).not.toContain(initial.state.chapters[1].summary);
    await expect(page.locator('.manuscript h1')).toHaveText('第二章 山城');
    await select('第三章 灯塔'); const beforeClear = await stats();
    await action('清除本章提取资料'); await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).toEqual(afterExtract);
    await action('清除本章提取资料'); await dialog.getByRole('button', { name: '确认清除资料', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(page.locator('.editor-toolbar')).toContainText('待整理');
    expect(await stats()).toBe(beforeClear); await expect(page.locator('.manuscript .prose')).toContainText('林舟受伤抵达灯塔');
    await action('重新提取本章资料'); await dialog.getByRole('button', { name: '开始重新提取', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/branches/${branchId}?view=author`)).json()).state.chapters[2].status).toBe('ready');
    await expect(page.locator('.chapter-item').filter({ hasText: '第三章 灯塔' })).not.toContainText('待整理');
    await tab(page, '世界资料'); const traveler = page.locator('.entity-card').filter({ has: page.getByRole('button', { name: '林舟', exact: true }) });
    await traveler.getByRole('button', { name: '删除 林舟', exact: true }).click(); await expect(dialog).toContainText('章节正文保留');
    await dialog.getByRole('button', { name: '确认删除资料', exact: true }).click(); await expect(traveler).toHaveCount(0);
    await page.getByRole('button', { name: '阅读视图', exact: true }).click(); await select('第一章 河岸'); await tab(page, '世界资料');
    await expect(page.getByRole('button', { name: '林舟', exact: true })).toHaveCount(0);
    await showGenerationProcess(page); await select('第二章 山城');
    await action('删除本章'); await expect(dialog).toContainText('只删除这一章');
    await dialog.getByRole('button', { name: '确认删除章节', exact: true }).click(); await expect(page.locator('.chapter-item')).toHaveCount(2);
    await expect(page.locator('.manuscript h1')).toHaveText('第三章 灯塔');
    const afterDelete = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json(); expect(afterDelete.state.chapters.map((chapter: { id: string }) => chapter.id)).toEqual([firstId, thirdId]);
    expect((await page.request.get(`/api/branches/${branchId}/chapters/${secondId}`)).status()).toBe(404);
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.chapter-actions summary').click();
    const menu = page.locator('.chapter-actions-menu'); await expect(menu).toBeVisible();
    expect(await menu.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= window.innerWidth; })).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('chapter-maintenance-mobile.png'), animations: 'disabled' });
    await page.locator('.chapter-actions summary').click(); await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '版本历史', exact: true }).click();
    const latestOriginal = dialog.locator('.revision-item').filter({ hasText: '保存验收插画' }).first();
    page.once('dialog', prompt => prompt.accept()); await latestOriginal.getByRole('button', { name: '回退', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(page.locator('.chapter-item')).toHaveCount(3);
    const reverted = await (await page.request.get(`/api/branches/${branchId}?view=author`)).json(); expect(reverted.state).toEqual(initial.state);
    await tab(page, '世界资料'); await expect(traveler).toHaveCount(1);
    await expect(traveler.locator('.entity-image-preview img')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('chapter-maintenance-restored-desktop.png'), animations: 'disabled' });
  } finally { await page.request.put('/api/settings', { data: previous }); }
});
