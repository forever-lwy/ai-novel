import { expect, test, type Page } from '@playwright/test';
import type { BranchView, Job, Project, Settings } from '../shared/types';

// UI/server acceptance uses a local model fixture and isolated SQLite data.
test.describe.configure({ mode: 'serial' });
const password = 'browser-test-password-123';
const mockUrl = `http://127.0.0.1:${process.env.E2E_MODEL_PORT || '4329'}/v1`;
let previousSettings: Settings;

test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/api/auth/login', { data: { password } })).ok()).toBeTruthy();
  previousSettings = await (await page.request.get('/api/settings')).json();
  const providerId = 'e2e-rpg-provider';
  expect((await page.request.put('/api/settings', { data: {
    providers: [{ id: providerId, name: '本地 RPG 验收', protocol: 'openai-chat', baseUrl: mockUrl, apiKey: '' }],
    writingProviderId: providerId, writingModel: 'e2e-rpg', planningProviderId: providerId, planningModel: 'e2e-planning', extractionProviderId: providerId, extractionModel: 'e2e-fixture',
    taskSettings: { extraction: { autoRetry: false, maxRetries: 2, retryDelayMs: 5000 }, planning: { enabled: false, mode: 'separate' } },
    imageSettings: { providerId: '', model: '', protocol: 'openai-images', size: '1024x1024', quality: 'auto', stylePrompt: '', autoPortrait: false, autoCG: false, timeoutMs: 120000 },
  } })).ok()).toBeTruthy();
});

test.afterEach(async ({ page }) => { await page.request.put('/api/settings', { data: previousSettings }); });

async function branch(page: Page, id: string): Promise<BranchView> { return (await page.request.get(`/api/branches/${id}?view=author`)).json(); }
async function jobs(page: Page, projectId: string): Promise<Job[]> { return (await page.request.get(`/api/jobs?projectId=${projectId}&view=author`)).json(); }
async function waitReady(page: Page, id: string, count: number) { await expect.poll(async () => (await branch(page, id)).state.chapters.filter(chapter => chapter.status === 'ready').length).toBe(count); }
async function seedNovel(page: Page, title: string, laterText = '林舟在白石城找到一盏旧灯。') {
  const response = await page.request.post('/api/projects', { data: { title, mode: 'continuation', premise: '林舟来到白石城。' } });
  expect(response.ok()).toBeTruthy(); const project: Project = await response.json();
  for (const [index, text] of ['林舟来到白石城，城门下有一块石碑。', laterText].entries()) {
    const current = await branch(page, project.mainBranchId);
    expect((await page.request.post(`/api/branches/${project.mainBranchId}/chapters`, { data: { baseRevisionId: current.branch.revisionId, title: index ? '第二章 灯火' : '第一章 起点', text } })).ok()).toBeTruthy();
    await waitReady(page, project.mainBranchId, index + 1);
  }
  return project;
}
async function openProject(page: Page, project: Project) {
  await page.goto('/'); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click();
  await page.getByRole('button', { name: '查看作者资料', exact: true }).click();
  await expect(page.getByRole('button', { name: '返回阅读视图', exact: true })).toBeVisible();
}
async function waitChoice(page: Page) {
  const choice = page.getByRole('region', { name: '决定接下来的剧情', exact: true });
  await expect(choice).toBeVisible(); await expect(choice.locator('.rpg-choice-question')).toContainText('城门');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await choice.evaluate(element => element.parentElement?.matches('article.streaming-manuscript') && element.previousElementSibling?.matches('.streaming-prose'))).toBeTruthy();
  if ((page.viewportSize()?.width ?? 0) <= 760) await showChoiceWithProse(page, false);
  return choice;
}
async function showChoiceWithProse(page: Page, scrollToProse = true) {
  const choice = page.getByRole('region', { name: '决定接下来的剧情', exact: true });
  const paragraph = page.locator('article.streaming-manuscript > .streaming-prose p').last();
  if (scrollToProse) await paragraph.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect.poll(async () => {
    const bounds = await paragraph.boundingBox(); const tabs = await page.locator('.workspace-tabs').boundingBox(); const viewport = page.viewportSize();
    return !!bounds && !!tabs && !!viewport && bounds.y >= tabs.y + tabs.height && bounds.y + bounds.height <= viewport.height && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width;
  }).toBe(true);
  await expect(paragraph).toBeInViewport({ ratio: 1 });
  await expect(choice.getByRole('radio').first()).toBeInViewport({ ratio: 1 });
  expect(await choice.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  expect(await page.locator('article.streaming-manuscript').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
}

test('原创角色从章末穿越，入场草稿保留，选择决定后续正文且原线完整保留', async ({ page }, testInfo) => {
  const project = await seedNovel(page, 'E2E 原创角色穿越'); await openProject(page, project);
  const original = await branch(page, project.mainBranchId);
  await page.getByRole('button', { name: '穿越体验', exact: true }).click();
  let modal = page.getByRole('dialog', { name: '穿越小说 · RPG 体验', exact: true });
  await expect(modal.getByRole('button', { name: '开始体验', exact: true })).toBeDisabled();
  await modal.getByLabel('角色姓名', { exact: true }).fill('顾星');
  await modal.getByLabel('原创角色设定', { exact: true }).fill('从现实来到小说的医学生，没有超能力。');
  await modal.getByLabel('体验角色', { exact: true }).selectOption('existing');
  await modal.getByLabel('体验角色', { exact: true }).selectOption('original');
  await expect(modal.getByLabel('角色姓名', { exact: true })).toHaveValue('顾星');
  await modal.getByLabel('进入小说的起点', { exact: true }).selectOption(original.state.chapters[0].id);
  await modal.getByLabel('入场要求（可选）', { exact: true }).fill('记得读过的故事，但不替我决定行动。');
  await modal.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '穿越体验', exact: true }).click(); modal = page.getByRole('dialog', { name: '穿越小说 · RPG 体验', exact: true });
  await expect(modal.getByLabel('角色姓名', { exact: true })).toHaveValue('顾星');
  await expect(modal.getByLabel('入场要求（可选）', { exact: true })).toHaveValue('记得读过的故事，但不替我决定行动。');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('rpg-original-setup-mobile.png'), animations: 'disabled' });
  await modal.getByRole('button', { name: '开始体验', exact: true }).click();
  const choice = await waitChoice(page); const rpgBranchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
  expect(rpgBranchId).not.toBe(project.mainBranchId);
  const experience = await branch(page, rpgBranchId);
  expect(experience.state.rpg).toMatchObject({ character: { kind: 'original', name: '顾星' }, entryChapterId: original.state.chapters[0].id });
  expect(experience.state.chapters).toHaveLength(1);
  await expect(choice.getByRole('button', { name: '确认选择并继续', exact: true })).toBeDisabled();
  const paused = (await jobs(page, project.id)).find(job => job.pendingChoice)!;
  expect((await page.request.post(`/api/jobs/${paused.id}/resume?view=author`)).status()).toBe(409);
  await showChoiceWithProse(page);
  await page.screenshot({ path: testInfo.outputPath('rpg-inline-choice-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await showChoiceWithProse(page);
  await page.screenshot({ path: testInfo.outputPath('rpg-inline-choice-desktop.png'), animations: 'disabled' });
  const paragraph = page.locator('.streaming-prose p').first();
  await paragraph.click({ clickCount: 3 });
  const selectedText = await page.evaluate(() => window.getSelection()?.toString().trim() || '');
  expect(selectedText.length).toBeGreaterThan(0); expect(await paragraph.textContent()).toContain(selectedText);
  await choice.getByRole('radio', { name: /查看石碑/ }).check();
  await choice.getByRole('button', { name: '确认选择并继续', exact: true }).click();
  await expect(choice).toHaveCount(0); await waitReady(page, rpgBranchId, 2);
  await expect(page.locator('.manuscript .prose')).toContainText('查看石碑');
  await expect(page.getByRole('button', { name: '重新生成', exact: true })).toHaveCount(0);
  expect((await branch(page, project.mainBranchId)).state.chapters.map(chapter => chapter.id)).toEqual(original.state.chapters.map(chapter => chapter.id));
  await page.getByLabel('当前故事线', { exact: true }).selectOption(project.mainBranchId);
  await expect(page.getByRole('button', { name: '继续创作', exact: true })).toBeVisible();
});

test('已有角色待选节点刷新恢复，自定义行动提交失败保留草稿并可再次提交', async ({ page }, testInfo) => {
  const project = await seedNovel(page, 'E2E 已有角色体验'); await openProject(page, project);
  await page.getByRole('button', { name: '穿越体验', exact: true }).click(); const setup = page.getByRole('dialog');
  await setup.getByLabel('体验角色', { exact: true }).selectOption('existing');
  await setup.getByLabel('选择已有角色', { exact: true }).selectOption({ label: '林舟' });
  await setup.getByRole('button', { name: '开始体验', exact: true }).click(); await waitChoice(page);
  const rpgBranchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
  expect((await branch(page, rpgBranchId)).state.rpg?.character).toMatchObject({ kind: 'existing', name: '林舟' });
  await page.reload(); await page.getByRole('button', { name: `打开作品 ${project.title}`, exact: true }).click(); await page.getByRole('button', { name: '查看作者资料', exact: true }).click();
  const choice = await waitChoice(page); await expect(page.getByLabel('当前故事线', { exact: true })).toHaveValue(rpgBranchId);
  await choice.getByRole('radio', { name: /自定义行动/ }).check();
  await choice.getByLabel('你想怎么做？', { exact: true }).fill('我先询问守门人，再寻找安全的入口。');
  await page.locator('.workspace-tabs').getByRole('button', { name: /^任务/ }).click();
  await expect(choice).toHaveCount(0);
  await page.locator('.job-card').filter({ hasText: '等待你的选择' }).getByRole('button', { name: '回答剧情选择', exact: true }).click();
  await waitChoice(page);
  await expect(choice.getByLabel('你想怎么做？', { exact: true })).toHaveValue('我先询问守门人，再寻找安全的入口。');
  let choiceRequests = 0; let releaseFailure!: () => void;
  const delayedFailure = new Promise<void>(resolve => { releaseFailure = resolve; });
  await page.route('**/api/jobs/*/choice?view=author', async route => {
    choiceRequests++;
    if (choiceRequests === 1) { await delayedFailure; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '本地验收：选择暂时提交失败' }) }); }
    else await route.continue();
  });
  await choice.getByRole('button', { name: '确认选择并继续', exact: true }).click();
  try {
    await expect(choice.getByRole('button', { name: '正在提交…', exact: true })).toBeDisabled();
    await expect.poll(() => choiceRequests).toBe(1);
    await page.locator('.workspace-tabs').getByRole('button', { name: /^任务/ }).click(); await expect(choice).toHaveCount(0);
    await page.locator('.job-card').filter({ hasText: '等待你的选择' }).getByRole('button', { name: '回答剧情选择', exact: true }).click(); await waitChoice(page);
    await expect(choice.getByRole('button', { name: '正在提交…', exact: true })).toBeDisabled();
    await expect(choice.getByLabel('你想怎么做？', { exact: true })).toHaveValue('我先询问守门人，再寻找安全的入口。');
    expect(choiceRequests).toBe(1);
  } finally { releaseFailure(); }
  await expect(choice.getByRole('alert')).toContainText('选择暂时提交失败');
  await page.locator('.workspace-tabs').getByRole('button', { name: /^任务/ }).click(); await expect(choice).toHaveCount(0);
  await page.locator('.job-card').filter({ hasText: '等待你的选择' }).getByRole('button', { name: '回答剧情选择', exact: true }).click(); await waitChoice(page);
  await expect(choice.getByRole('alert')).toContainText('选择暂时提交失败');
  await expect(choice.getByLabel('你想怎么做？', { exact: true })).toHaveValue('我先询问守门人，再寻找安全的入口。');
  await expect(choice.getByRole('button', { name: '确认选择并继续', exact: true })).toBeEnabled();
  expect(choiceRequests).toBe(1);
  expect((await jobs(page, project.id)).find(job => job.branchId === rpgBranchId && job.pendingChoice)?.status).toBe('paused');
  await page.setViewportSize({ width: 390, height: 844 }); await showChoiceWithProse(page);
  await page.screenshot({ path: testInfo.outputPath('rpg-inline-custom-error-mobile.png'), animations: 'disabled' });
  await choice.getByRole('button', { name: '确认选择并继续', exact: true }).click(); await expect(choice).toHaveCount(0);
  expect(choiceRequests).toBe(2);
  await waitReady(page, rpgBranchId, 3); await expect(page.locator('.manuscript .prose')).toContainText('我先询问守门人');
});

test('新建作品支持 RPG，切线与阅读视图不答题，任务页可恢复正文节点并取消', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '新建作品', exact: true }).click();
  const create = page.getByRole('dialog'); await create.getByLabel('作品名称', { exact: true }).fill('E2E RPG 新作品'); await create.getByLabel('创作方式', { exact: true }).selectOption('rpg');
  await expect(create).toContainText('关键剧情'); await create.getByRole('button', { name: '创建作品', exact: true }).click();
  await page.getByRole('button', { name: '查看作者资料', exact: true }).click();
  const originalBranchId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
  await page.getByRole('button', { name: '开始创作', exact: true }).click(); const setup = page.getByRole('dialog');
  await expect(setup.getByLabel('创作方式', { exact: true })).toHaveValue('rpg'); await setup.getByLabel('角色姓名', { exact: true }).fill('许安'); await setup.getByRole('button', { name: '开始体验', exact: true }).click();
  let choiceRequests = 0; page.on('request', request => { if (request.method() === 'POST' && /\/jobs\/[^/]+\/choice/.test(new URL(request.url()).pathname)) choiceRequests++; });
  const choice = await waitChoice(page);
  await expect(choice.getByRole('button', { name: '稍后决定', exact: true })).toHaveCount(0);
  await choice.getByRole('radio', { name: /进入城中/ }).check();
  await page.getByRole('button', { name: '回答剧情选择', exact: true }).click(); await showChoiceWithProse(page, false);
  await page.getByLabel('当前故事线', { exact: true }).selectOption(originalBranchId); await expect(choice).toHaveCount(0);
  await page.locator('.workspace-tabs').getByRole('button', { name: /^任务/ }).click();
  const waitingCard = page.locator('.job-card').filter({ hasText: '等待你的选择' }); await expect(waitingCard).toHaveCount(1); await expect(waitingCard.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);
  await waitingCard.getByRole('button', { name: '回答剧情选择', exact: true }).click(); await waitChoice(page);
  await expect(choice.getByRole('radio', { name: /进入城中/ })).toBeChecked();
  await page.getByRole('button', { name: '返回阅读视图', exact: true }).click();
  await expect(choice).toHaveCount(0);
  await expect(page.getByRole('button', { name: '回答剧情选择', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看作者资料', exact: true }).click(); await waitChoice(page);
  await expect(choice.getByRole('radio', { name: /进入城中/ })).toBeChecked();
  await page.getByRole('button', { name: '停止生成', exact: true }).click(); await expect(page.getByRole('button', { name: '退出生成', exact: true })).toBeVisible(); await expect(choice).toHaveCount(0);
  expect(choiceRequests).toBe(0);
  await page.locator('.workspace-tabs').getByRole('button', { name: /^任务/ }).click(); await expect(page.locator('.job-card .status-pill.cancelled')).toHaveCount(1);
});

test('从早期章节穿越，AI 读取原作后续摘要、未来物品及指定行原文，当前剧情不提前继承', async ({ page }) => {
  const project = await seedNovel(page, 'E2E 原作未来参考', '林舟在白石城找到一盏旧灯。\n\nFUTURE_REFERENCE_SENTINEL：林舟发现星钥，其能力是照亮星门。');
  const original = await branch(page, project.mainBranchId);
  const config: Settings = await (await page.request.get('/api/settings')).json();
  expect((await page.request.put('/api/settings', { data: { ...config, writingModel: 'e2e-original-reference' } })).ok()).toBeTruthy();
  await openProject(page, project);
  await page.getByRole('button', { name: '穿越体验', exact: true }).click();
  const setup = page.getByRole('dialog');
  await setup.getByLabel('角色姓名', { exact: true }).fill('顾星');
  await setup.getByLabel('进入小说的起点', { exact: true }).selectOption(original.state.chapters[0].id);
  await setup.getByRole('button', { name: '开始体验', exact: true }).click();
  const choice = page.getByRole('region', { name: '决定接下来的剧情', exact: true });
  await expect(choice).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await choice.evaluate(element => element.parentElement?.matches('article.streaming-manuscript') && element.previousElementSibling?.matches('.streaming-prose'))).toBeTruthy();
  const experienceId = await page.getByLabel('当前故事线', { exact: true }).inputValue();
  const experience = await branch(page, experienceId);
  expect(experience.state.chapters).toHaveLength(1);
  expect(experience.state.entities.some(entity => entity.name === '星钥')).toBeFalsy();
  expect(experience.state.sourceReference).toMatchObject({ branchId: project.mainBranchId, revisionId: original.branch.revisionId });
  const writing = (await jobs(page, project.id)).find(job => job.branchId === experienceId && job.pendingChoice)!;
  const activities = await (await page.request.get(`/api/jobs/${writing.id}/activities?view=author`)).json();
  for (const name of ['list_text_files', 'search_text', 'read_text_file', 'search_story', 'read_entity']) {
    const activity = activities.find((value: { name: string }) => value.name === name);
    expect(activity, name).toMatchObject({ status: 'completed' });
    expect(activity.result).not.toHaveProperty('error');
  }
  const fileRead = activities.find((value: { name: string }) => value.name === 'read_text_file');
  expect(JSON.stringify(fileRead.result)).toContain('FUTURE_REFERENCE_SENTINEL');
  expect(JSON.stringify(fileRead.result)).not.toContain('旧灯');
  expect(JSON.stringify(activities.find((value: { name: string }) => value.name === 'read_entity').result)).toContain('照亮星门');
  const outputs = await (await page.request.get(`/api/jobs/${writing.id}/outputs?view=author`)).json();
  const request = await (await page.request.get(`/api/jobs/${writing.id}/outputs/${outputs[0].id}?view=author`)).json();
  expect(request.output.request.body).toContain('原作');
  expect(request.output.request.body).toContain('星钥');
  const reader = await (await page.request.get(`/api/branches/${experienceId}?view=reader`)).json();
  expect(JSON.stringify(reader)).not.toContain('FUTURE_REFERENCE_SENTINEL');
  expect(reader.state).not.toHaveProperty('sourceReference');
  await choice.getByRole('radio', { name: '友好问候', exact: true }).check();
  await choice.getByRole('button', { name: '确认选择并继续', exact: true }).click();
  await expect(choice).toHaveCount(0);
  await waitReady(page, experienceId, 2);
  await expect(page.locator('.manuscript .prose')).toContainText('你按自己的选择回应守门人');
  expect((await branch(page, project.mainBranchId)).state.chapters.map(chapter => chapter.id)).toEqual(original.state.chapters.map(chapter => chapter.id));
});
