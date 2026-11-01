import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { defaultDataCleanupSettings, type DataCleanupReport, type DataCleanupState } from '../shared/data-cleanup';
import type { Job, Project, Settings } from '../shared/types';
import { Store } from '../server/store';

test.describe.configure({ mode: 'serial' });
let original: DataCleanupState;
let modelSettings: Settings;
let created: string[];

test.beforeEach(async ({ page }) => {
  created = [];
  expect((await page.request.post('/api/auth/login', { data: { password: 'browser-test-password-123' } })).ok()).toBeTruthy();
  original = await (await page.request.get('/api/data-cleanup')).json();
  modelSettings = await (await page.request.get('/api/settings')).json();
  expect((await page.request.put('/api/data-cleanup', { data: { settings: defaultDataCleanupSettings() } })).ok()).toBeTruthy();
});
test.afterEach(async ({ page }) => {
  expect((await page.request.put('/api/data-cleanup', { data: { settings: original.settings } })).ok()).toBeTruthy();
  for (const id of created) expect((await page.request.delete(`/api/projects/${id}`)).ok()).toBeTruthy();
});

async function open(page: Page, project?: Project) {
  await page.goto('/');
  if (project) await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '数据清理', exact: true }).click();
  const panel = page.getByRole('form', { name: '数据清理设置', exact: true });
  await expect(panel.getByLabel('历史版本保留天数', { exact: true })).toBeVisible();
  return panel;
}

async function restoreFixture(page: Page, title: string): Promise<Project> {
  const temporaryRoot = resolve(tmpdir()), directory = mkdtempSync(join(temporaryRoot, 'novel-cleanup-browser-'));
  const store = new Store(directory);
  let backup: Buffer;
  try {
    const project = store.createProject({ title });
    for (let index = 0; index < 5; index++) {
      const state = store.state(project.mainBranchId); state.outline.worldview = `隔离验收设定 ${index}`;
      store.commit(project.mainBranchId, store.getBranch(project.mainBranchId).revisionId, state, '更新隔离验收设定');
    }
    for (let index = 0; index < 4; index++) {
      const stamp = new Date(Date.now() - (5 - index) * 86400000).toISOString();
      const job: Job = { id: randomUUID(), projectId: project.id, branchId: project.mainBranchId, baseRevisionId: store.getBranch(project.mainBranchId).revisionId,
        kind: 'generate', status: 'completed', progress: 1, total: 1, message: '本地清理验收已结束任务', inputTokens: 1, outputTokens: 1, payload: {}, createdAt: stamp, updatedAt: stamp };
      store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, job.branchId, job.projectId, job.status, JSON.stringify(job));
      store.outputs.insert({ id: randomUUID(), jobId: job.id, projectId: project.id, branchId: job.branchId, baseRevisionId: job.baseRevisionId, stage: 'writing',
        status: 'applied', rawResponse: '隔离请求原始响应', text: '已保存的隔离输出', inputTokens: 1, outputTokens: 1, issues: [], createdAt: stamp, updatedAt: stamp });
      store.recordWritingActivity(job.id, { type: 'thinking', id: `cleanup-thought-${index}`, text: '隔离生成过程。' });
      store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?)').run(job.id, '隔离旧草稿');
    }
    backup = gzipSync(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: store.exportProject(project.id), sources: [] }));
  } finally {
    store.close();
    if (dirname(resolve(directory)) !== temporaryRoot || !basename(directory).startsWith('novel-cleanup-browser-')) throw new Error('隔离验收目录超出本次临时目录范围');
    rmSync(directory, { recursive: true, force: true });
  }
  const result = await page.request.post('/api/restore', { multipart: { file: { name: 'cleanup.ai-novel.json.gz', mimeType: 'application/gzip', buffer: backup } } });
  expect(result.ok(), await result.text()).toBeTruthy();
  const project = await result.json() as Project; created.push(project.id); return project;
}

for (const width of [1440, 390]) {
  test(`数据清理 ${width}px：独立保存、字段校验、自动开关持久化及草稿保护`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const response = await page.request.post('/api/projects', { data: { title: `清理设置 ${width}`, mode: 'original' } });
    expect(response.ok()).toBeTruthy(); const project = await response.json() as Project; created.push(project.id);
    const panel = await open(page, project);
    await expect(panel.getByLabel('开启自动清理', { exact: true })).not.toBeChecked();
    for (const category of ['历史版本', '模型请求记录', '已结束的任务']) for (const key of ['保留天数', '保留数量']) await expect(panel.getByLabel(`${category}${key}`, { exact: true })).toHaveValue('0');
    await panel.getByLabel('历史版本保留天数', { exact: true }).fill('31');
    await panel.getByLabel('历史版本保留数量', { exact: true }).fill('2');
    await panel.getByLabel('模型请求记录保留天数', { exact: true }).fill('45');
    await panel.getByLabel('模型请求记录保留数量', { exact: true }).fill('3');
    await panel.getByLabel('已结束的任务保留天数', { exact: true }).fill('60');
    await panel.getByLabel('已结束的任务保留数量', { exact: true }).fill('2');
    await panel.getByLabel('开启自动清理', { exact: true }).check();
    await page.getByRole('button', { name: '任务模型', exact: true }).click();
    await page.getByRole('button', { name: '数据清理', exact: true }).click();
    await expect(panel.getByLabel('历史版本保留天数', { exact: true })).toHaveValue('31');
    await expect(panel.getByLabel('开启自动清理', { exact: true })).toBeChecked();
    await panel.getByLabel('模型请求记录保留天数', { exact: true }).fill('-1');
    await panel.getByRole('button', { name: '保存清理设置', exact: true }).click();
    await expect(panel.locator('.settings-feedback')).toContainText('模型请求记录的保留天数需填写');
    expect((await (await page.request.get('/api/data-cleanup')).json()).settings).toEqual(defaultDataCleanupSettings());
    await panel.getByLabel('模型请求记录保留天数', { exact: true }).fill('45');
    await panel.getByLabel('历史版本保留数量', { exact: true }).fill('1.5');
    await panel.getByRole('button', { name: '保存清理设置', exact: true }).click();
    await expect(panel.locator('.settings-feedback')).toContainText('历史版本的保留数量需填写');
    await panel.getByLabel('历史版本保留数量', { exact: true }).fill('2');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '作品设置', exact: true }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: '保存清理设置', exact: true }).click();
    await expect(panel.locator('.settings-feedback')).toContainText('自动清理已开启');
    const saved = await (await page.request.get('/api/data-cleanup')).json() as DataCleanupState;
    expect(saved.settings).toEqual({ enabled: true, history: { maxAgeDays: 31, maxCount: 2 }, requests: { maxAgeDays: 45, maxCount: 3 }, jobs: { maxAgeDays: 60, maxCount: 2 } });
    expect(await (await page.request.get('/api/settings')).json()).toEqual(modelSettings);
    await page.getByRole('button', { name: '作品设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '数据清理', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '全局设置', exact: true }).click();
    await page.getByRole('button', { name: '数据清理', exact: true }).click();
    await expect(panel.getByLabel('开启自动清理', { exact: true })).toBeChecked();
    await expect(panel.getByLabel('模型请求记录保留数量', { exact: true })).toHaveValue('3');
    await panel.getByLabel('模型请求记录保留数量', { exact: true }).fill('7');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '返回作品', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel('模型请求记录保留数量', { exact: true })).toHaveValue('7');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    expect(await panel.evaluate(element => {
      const fields = element.querySelector('fieldset')!.getBoundingClientRect();
      const footer = element.querySelector('footer')!.getBoundingClientRect();
      return footer.top >= fields.bottom - 1;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`data-cleanup-settings-${width}.png`), fullPage: true, animations: 'disabled' });
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '返回作品', exact: true }).click();
    await expect(page.locator('.workspace-project-title')).toContainText(project.title);
  });

  test(`数据清理 ${width}px：预览、记录变化拒绝旧确认、重新预览并实际清理`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const project = await restoreFixture(page, `清理记录 ${width}`);
    const panel = await open(page, project);
    await panel.getByLabel('历史版本保留数量', { exact: true }).fill('1');
    await panel.getByLabel('模型请求记录保留数量', { exact: true }).fill('1');
    await panel.getByLabel('已结束的任务保留数量', { exact: true }).fill('1');
    const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/data-cleanup/preview') && response.request().method() === 'POST');
    await panel.getByRole('button', { name: '预览清理范围', exact: true }).click();
    const preview = await (await previewResponse).json() as DataCleanupReport;
    expect(preview.revisions).toBeGreaterThan(0); expect(preview.requests).toBeGreaterThanOrEqual(3); expect(preview.jobs).toBeGreaterThanOrEqual(3);
    await expect(panel).toContainText(`历史版本 ${preview.revisions.toLocaleString()} 个、请求记录 ${preview.requests.toLocaleString()} 条、任务 ${preview.jobs.toLocaleString()} 个`);
    await expect(panel.getByRole('button', { name: '确认清理以上记录', exact: true })).toBeVisible();
    expect((await (await page.request.get(`/api/jobs?projectId=${project.id}`)).json()).length).toBe(4);
    // Another page adds request records after the preview, invalidating its confirmation.
    await restoreFixture(page, `另页新增请求 ${width}`);
    await panel.getByRole('button', { name: '确认清理以上记录', exact: true }).click();
    await expect(panel.locator('.settings-feedback')).toContainText('记录已变化，请重新预览');
    await expect(panel.getByRole('button', { name: '确认清理以上记录', exact: true })).toHaveCount(0);
    expect((await (await page.request.get(`/api/jobs?projectId=${project.id}`)).json()).length).toBe(4);
    const nextPreview = page.waitForResponse(response => response.url().endsWith('/api/data-cleanup/preview') && response.request().method() === 'POST');
    await panel.getByRole('button', { name: '预览清理范围', exact: true }).click();
    const next = await (await nextPreview).json() as DataCleanupReport;
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.getByRole('button', { name: '确认清理以上记录', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`data-cleanup-preview-${width}.png`), animations: 'disabled' });
    await panel.getByRole('button', { name: '确认清理以上记录', exact: true }).click();
    await expect(panel.locator('.settings-feedback')).toContainText('清理完成');
    const remaining = await (await page.request.get(`/api/jobs?projectId=${project.id}`)).json() as Job[];
    expect(remaining).toHaveLength(1);
    const records = await (await page.request.get(`/api/jobs/${remaining[0].id}/outputs`)).json(); expect(records).toHaveLength(1);
    const after = await (await page.request.get('/api/data-cleanup')).json() as DataCleanupState;
    expect(after.settings).toEqual(defaultDataCleanupSettings());
    expect(after.lastRun).toMatchObject({ revisions: next.revisions, requests: next.requests, jobs: next.jobs });
    expect(after.lastRun?.completedAt).toBeTruthy();
    await expect(panel.getByRole('region', { name: '最近清理结果', exact: true })).toContainText(`任务 ${next.jobs.toLocaleString()} 个`);
  });
}
