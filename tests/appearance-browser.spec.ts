import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store } from '../server/store';
import type { Project } from '../shared/types';

// Appearance is exercised against the real UI with disposable story data only.
// No model requests are needed for any test in this file.
const storageKey = 'ai-novel-appearance-v1';
let created: string[];
test.beforeEach(async ({ page }) => {
  created = [];
  expect((await page.request.post('/api/auth/login', { data: { password: 'browser-test-password-123' } })).ok()).toBeTruthy();
});
test.afterEach(async ({ page }) => {
  for (const id of created) expect((await page.request.delete(`/api/projects/${id}`)).ok()).toBeTruthy();
});

async function restoreStory(page: Page, title: string) {
  const temporaryRoot = resolve(tmpdir()), directory = mkdtempSync(join(temporaryRoot, 'novel-appearance-browser-'));
  const store = new Store(directory);
  let backup: Buffer;
  try {
    const project = store.createProject({ title });
    const text = Array.from({ length: 30 }, (_, index) => `林舟沿着白石城的长街向前走，仔细观察沿途的门窗和路灯。他在路口停下，记住第${index + 1}处石墙上的纹路。`).join('\n\n');
    const saved = store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: '长街', text });
    store.applyExtraction(project.mainBranchId, saved.branch.revisionId, saved.state.chapters[0].id, { summary: '林舟沿着长街调查。', entities: [], relations: [], foreshadows: [] }, true);
    backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: store.exportProject(project.id), sources: [] }));
  } finally {
    store.close();
    if (dirname(resolve(directory)) !== temporaryRoot || !basename(directory).startsWith('novel-appearance-browser-')) throw new Error('隔离验收目录超出本次临时目录范围');
    rmSync(directory, { recursive: true, force: true });
  }
  const response = await page.request.post('/api/restore', { multipart: { file: { name: 'appearance.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const project = await response.json() as Project; created.push(project.id);
  return project;
}

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await expect(page.getByLabel('主题模式', { exact: true })).toBeVisible();
  return page.getByTestId('settings-page');
}

async function setInput(input: Locator, value: string | number) {
  await input.evaluate((element, next) => {
    const field = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, String(next));
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await expect(input).toHaveValue(String(value));
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
}

for (const width of [1440, 390]) test(`外观 ${width}px：颜色、排版即时应用，刷新保留且返回保护正文草稿`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const project = await restoreStory(page, `外观排版 ${width}`);
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(page.locator('.manuscript h1')).toHaveText('长街');
  const before = await (await page.request.get(`/api/branches/${project.mainBranchId}`)).json();
  let settingsWrites = 0, modelCalls = 0;
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings') settingsWrites++;
    if (request.method() === 'POST' && /\/(generate|test)$/.test(new URL(request.url()).pathname)) modelCalls++;
  });
  const settings = await openAppearance(page);
  await settings.getByLabel('主题模式', { exact: true }).selectOption('light');
  for (const [label, color] of [['页面背景', '#e8e0d0'], ['正文与面板背景', '#fff6df'], ['文字颜色', '#443322'], ['主题色', '#784122']]) {
    await setInput(settings.getByLabel(label, { exact: true }), color);
  }
  await settings.getByLabel('正文字体', { exact: true }).selectOption('custom');
  await settings.getByLabel('自定义正文字体', { exact: true }).fill('Georgia');
  await settings.getByLabel('界面字体', { exact: true }).selectOption('custom');
  await settings.getByLabel('自定义界面字体', { exact: true }).fill('Arial');
  for (const [label, value] of [['正文字号', 24], ['界面缩放', 110], ['正文行距', 2], ['字间距', 2], ['段落间距', 20], ['正文宽度', 720], ['左右留白', 32]] as const) {
    await setInput(settings.getByLabel(label, { exact: true }), value);
  }
  await settings.getByLabel('正文粗细', { exact: true }).selectOption('500');
  await settings.getByLabel('首行缩进', { exact: true }).check();
  await settings.getByLabel('正文对齐', { exact: true }).selectOption('justify');
  await expect(settings.locator('.appearance-panel > [role="status"]')).toContainText('已自动保存到当前浏览器');
  const preview = settings.locator('.appearance-preview .prose');
  await expect(preview).toHaveCSS('font-size', '24px');
  await expect(preview).toHaveCSS('font-family', /Georgia/);
  await expect(preview).toHaveCSS('color', 'rgb(68, 51, 34)');
  await expect(preview.locator('p').first()).toHaveCSS('line-height', '48px');
  await expect(preview.locator('p').first()).toHaveCSS('letter-spacing', '2px');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath(`appearance-settings-${width}.png`), fullPage: true, animations: 'disabled' });
  const stored = await page.evaluate(key => localStorage.getItem(key), storageKey);
  expect(stored).toBeTruthy();
  await settings.getByRole('button', { name: '返回作品', exact: true }).click();
  const prose = page.locator('.manuscript .prose').first();
  await expect(prose).toHaveCSS('font-size', '24px');
  await expect(prose).toHaveCSS('font-family', /Georgia/);
  await expect(prose.locator('p').first()).toHaveCSS('color', 'rgb(68, 51, 34)');
  await expect(prose.locator('p').first()).toHaveCSS('font-weight', '500');
  await expect(prose.locator('p').first()).toHaveCSS('text-align', 'justify');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath(`appearance-reader-${width}.png`), animations: 'disabled' });
  await page.reload(); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await expect(prose).toHaveCSS('font-size', '24px');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(stored);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const draft = '尚未保存的外观验收草稿。\n\n返回作品后继续编辑。';
  const editor = page.getByLabel('章节正文', { exact: true });
  await editor.fill(draft); await expect(editor).toHaveCSS('font-size', '24px');
  await openAppearance(page);
  await setInput(settings.getByLabel('正文字号', { exact: true }), 28);
  await settings.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(editor).toHaveValue(draft); await expect(editor).toHaveCSS('font-size', '28px');
  expect((await (await page.request.get(`/api/branches/${project.mainBranchId}`)).json()).state).toEqual(before.state);
  expect(settingsWrites).toBe(0); expect(modelCalls).toBe(0);
});

test('外观跟随系统与配色，恢复默认只重置外观，模型设置草稿独立保留', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' }); await page.goto('/');
  const settings = await openAppearance(page);
  await settings.getByLabel('主题模式', { exact: true }).selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 28, 26)');
  await expect(settings.locator('.appearance-card').first()).toHaveCSS('background-color', 'rgb(34, 42, 38)');
  await page.screenshot({ path: testInfo.outputPath('appearance-dark-desktop.png'), fullPage: true, animations: 'disabled' });
  await settings.getByLabel('主题模式', { exact: true }).selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await settings.getByLabel('配色方案', { exact: true }).selectOption('paper');
  const paper = await settings.getByLabel('页面背景', { exact: true }).inputValue();
  await settings.getByLabel('配色方案', { exact: true }).selectOption('green');
  expect(await settings.getByLabel('页面背景', { exact: true }).inputValue()).not.toBe(paper);
  await settings.getByRole('button', { name: '供应商连接', exact: true }).click();
  await settings.getByRole('button', { name: '添加供应商连接', exact: true }).click();
  const draft = settings.getByLabel('供应商名称', { exact: true }).last(); await draft.fill('仅留在草稿中的供应商');
  await settings.getByRole('button', { name: '外观', exact: true }).click();
  await setInput(settings.getByLabel('正文字号', { exact: true }), 40);
  await settings.getByRole('button', { name: '恢复默认外观', exact: true }).click();
  await expect(settings.getByLabel('正文字号', { exact: true })).not.toHaveValue('40');
  await expect(settings.getByLabel('主题模式', { exact: true })).toHaveValue('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await settings.getByRole('button', { name: '供应商连接', exact: true }).click();
  await expect(draft).toHaveValue('仅留在草稿中的供应商');
  page.once('dialog', dialog => dialog.accept());
  await settings.getByRole('button', { name: '返回作品', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await openAppearance(page); await expect(settings.getByLabel('主题模式', { exact: true })).toHaveValue('system');
});

test('外观手机背景图片刷新保留与移除，大字号和界面缩放不溢出', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  const settings = await openAppearance(page);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWPw6Sv6DwAEwgJMYzx9CAAAAABJRU5ErkJggg==', 'base64');
  await settings.getByLabel('上传背景图片', { exact: true }).setInputFiles({ name: 'local-background.png', mimeType: 'image/png', buffer: png });
  await expect(settings.getByRole('button', { name: '移除背景图片', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key) || '', storageKey)).toContain('data:image/');
  await expect(page.locator('body')).toHaveCSS('background-image', /data:image\/png;base64,/);
  await setInput(settings.getByLabel('背景不透明度', { exact: true }), 70);
  await setInput(settings.getByLabel('界面缩放', { exact: true }), 125);
  await setInput(settings.getByLabel('正文字号', { exact: true }), 40);
  await setInput(settings.getByLabel('左右留白', { exact: true }), 80);
  await settings.getByLabel('正文字体', { exact: true }).selectOption('kai');
  await settings.getByLabel('主题模式', { exact: true }).selectOption('dark');
  await noOverflow(page);
  for (const button of await settings.locator('.settings-navigation > button').all()) {
    expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  }
  await page.screenshot({ path: testInfo.outputPath('appearance-mobile-background.png'), fullPage: true, animations: 'disabled' });
  await page.reload(); await openAppearance(page);
  await expect(settings.getByRole('button', { name: '移除背景图片', exact: true })).toBeVisible();
  await expect(settings.getByLabel('背景不透明度', { exact: true })).toHaveValue('70');
  await expect(settings.getByLabel('正文字号', { exact: true })).toHaveValue('40');
  await noOverflow(page);
  await settings.getByRole('button', { name: '移除背景图片', exact: true }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key) || '', storageKey)).not.toContain('data:image/');
  await expect(page.locator('body')).toHaveCSS('background-image', 'none');
  await settings.getByRole('button', { name: '恢复默认外观', exact: true }).click();
  await settings.getByRole('button', { name: '返回作品', exact: true }).click(); await noOverflow(page);
});

test('外观跨标签同步，存储失败保留临时外观并明确提示，损坏配置可恢复', async ({ page, context }) => {
  await page.goto('/'); const settings = await openAppearance(page);
  const second = await context.newPage(); await second.goto('/');
  try {
    await settings.getByLabel('主题模式', { exact: true }).selectOption('dark');
    await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
    await openAppearance(second);
    await setInput(second.getByLabel('正文字号', { exact: true }), 24);
    await expect(settings.getByLabel('正文字号', { exact: true })).toHaveValue('24');
    await page.evaluate(key => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Storage full', 'QuotaExceededError');
        return original.call(this, name, value);
      };
    }, storageKey);
    await setInput(settings.getByLabel('正文字号', { exact: true }), 30);
    await expect(settings.locator('.appearance-preview .prose')).toHaveCSS('font-size', '30px');
    await expect(settings.getByRole('alert')).toContainText('外观已临时应用，但浏览器未能保存');
    await expect(settings.locator('.appearance-panel > [role="status"]')).toHaveCount(0);
    await expect(second.getByLabel('正文字号', { exact: true })).toHaveValue('24');
    await page.reload(); await openAppearance(page);
    await expect(settings.getByLabel('正文字号', { exact: true })).toHaveValue('24');
    await second.evaluate(key => localStorage.setItem(key, '{damaged JSON'), storageKey);
    await expect(settings.getByLabel('正文字号', { exact: true })).toHaveValue('24');
    await page.reload(); await openAppearance(page);
    await expect(settings.getByRole('alert')).toContainText('外观设置无法读取');
    await settings.getByRole('button', { name: '恢复默认外观', exact: true }).click();
    await expect(settings.locator('.appearance-panel > [role="status"]')).toContainText('已自动保存到当前浏览器');
    await expect(settings.getByRole('alert')).toHaveCount(0);
  } finally { await second.close(); }
});
