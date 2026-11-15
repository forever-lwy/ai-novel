import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { buildWritingContext } from '../server/writing-context.js';
import { defaultTaskSettings } from '../shared/task-settings.js';
import { defaultPromptTemplates } from '../shared/prompt-templates.js';
import { emptyState, type ExtractionResult, type Job, type ModelRequest, type Settings } from '../shared/types.js';

const stores: Store[] = [], engines: StoryEngine[] = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.close(); for (const store of stores.splice(0)) store.close(); });
const extraction = (): ExtractionResult => ({ summary: '新故事的实际剧情。', entities: [], relations: [], foreshadows: [] });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
async function until<T>(read: () => T, valid: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) { const value = read(); if (valid(value)) return value; if (Date.now() > deadline) throw new Error('等待本地召回任务超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const terminal = (engine: StoryEngine, id: string) => until(() => engine.listJobs().find(job => job.id === id)!, job => ['completed', 'failed', 'cancelled', 'stale', 'paused'].includes(job.status));
const catalog = (request: ModelRequest): { key: string; title: string; summary: string; collection: string; beginning?: string }[] => JSON.parse(request.prompt.split('# 可额外召回的原文章节目录\n')[1]);

function fixture() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-writing-recall-'))); stores.push(store);
  const project = store.createProject({ title: '原文召回测试', premise: '作者确认的世界设定。' });
  const config: Settings = {
    providers: [{ id: 'local', name: '本地测试', protocol: 'openai-chat', baseUrl: 'http://unused.invalid' }],
    writingProviderId: 'local', writingModel: 'writer', extractionProviderId: 'local', extractionModel: 'extractor', planningProviderId: '', recallProviderId: 'local', recallModel: 'recaller',
    modelParameters: ['writing', 'extraction', 'recall'].map(role => ({ role: role as 'writing' | 'extraction' | 'recall', providerId: 'local', model: role === 'writing' ? 'writer' : role === 'recall' ? 'recaller' : 'extractor', contextTokens: 64000, maxOutputTokens: 1024, temperature: role === 'recall' ? 0.2 : 0.8 })),
    taskSettings: defaultTaskSettings(),
  };
  const written: ModelRequest[] = [], recalled: ModelRequest[] = [];
  const select = vi.fn(async (request: ModelRequest): Promise<unknown> => ({ chapterKeys: catalog(request).filter(chapter => chapter.title === '遥远的约定').map(chapter => chapter.key) }));
  const write = vi.fn(async () => '作者要求的新正文。');
  const models: TextModels = {
    generateStructured: vi.fn(async (provider, request, validate) => {
      if (request.system.includes('# 写作原文召回')) {
        recalled.push(request); expect(provider.model).toBe(config.recallProviderId ? 'recaller' : 'writer');
        const value = await select(request);
        request.onResponse?.({ rawResponse: JSON.stringify(value), text: JSON.stringify(value), inputTokens: 11, outputTokens: 7 });
        return { value: validate(value), inputTokens: 11, outputTokens: 7 };
      }
      return { value: validate(extraction()), inputTokens: 3, outputTokens: 2 };
    }),
    generateText: vi.fn(async (_provider, request) => { written.push(request); return { text: await write(), inputTokens: 13, outputTokens: 9 }; }),
  };
  function engine() { const value = new StoryEngine(store, () => config, models); engines.push(value); return value; }
  function append(title: string, text: string) {
    const saved = store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title, text });
    const chapter = saved.state.chapters.at(-1)!;
    store.applyExtraction(project.mainBranchId, saved.branch.revisionId, chapter.id, { ...extraction(), summary: `摘要：${title}，关键人物约定在月食夜见面。` }, true);
    return { ...chapter, text };
  }
  function start(value: StoryEngine, extra: Record<string, unknown> = {}) {
    return value.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: '新篇', mode: 'continuation', instruction: '保留遥远章节中月食夜的约定，改变相遇方式。', ...extra });
  }
  function minimalPrompt() {
    config.promptTemplates = defaultPromptTemplates();
    config.promptTemplates.presets.writing = [{ id: 'minimal', name: '作者自定义', useGeneral: false, writingOutputMode: 'text', blocks: [{ id: 'only', name: '要求', enabled: true, role: 'user', content: '{{instruction}}' }] }];
    config.promptTemplates.selected.writing = 'minimal';
  }
  return { store, project, config, written, recalled, models, select, write, engine, append, start, minimalPrompt };
}

describe('writing recall before prose generation', () => {
  it('provides the entire first rewritten chapter and distant selected prose even when a custom preset omits all materials', async () => {
    const f = fixture(); f.minimalPrompt();
    const first = f.append('开篇', '开篇完整原文第一段。\n\n从头改写也必须看到的末段。');
    for (let index = 0; index < 6; index++) f.append(`中间场景${index}`, `中间场景${index}的完整原文。`);
    const far = f.append('遥远的约定', '遥远原文：甲把半枚铜钱交给乙。\n\n只有原文记载的暗号是“月落城西”。');
    const gate = deferred<unknown>(); f.select.mockImplementation(async request => { expect(request.prompt).toContain(first.text); expect(request.prompt).toContain('作者确认的世界设定'); return gate.promise; });
    const engine = f.engine(); const job = f.start(engine, { mode: 'rewrite', chapterId: first.id });
    // Later source edits must not change either the selector's or writer's captured version.
    f.store.saveChapter(f.project.mainBranchId, { baseRevisionId: f.store.getBranch(f.project.mainBranchId).revisionId, chapterId: far.id, title: far.title, text: '后来被编辑的原线内容。' });
    engine.start(); await until(() => f.recalled.length, count => count === 1);
    expect(f.written).toHaveLength(0);
    expect(catalog(f.recalled[0]).some(chapter => chapter.title === first.title)).toBe(false);
    gate.resolve({ chapterKeys: [catalog(f.recalled[0]).find(chapter => chapter.title === far.title)!.key] });
    expect((await terminal(engine, job.id)).status).toBe('completed');
    expect(f.written[0].prompt).toContain(first.text); expect(f.written[0].prompt).toContain(far.text);
    expect(f.written[0].prompt).not.toContain('后来被编辑的原线内容'); expect(f.written[0].prompt).not.toContain('中间场景0的完整原文');
    expect(engine.listOutputs(job.id).find(output => output.stage === 'recall')).toMatchObject({ status: 'applied', inputTokens: 11, outputTokens: 7 });
    expect(f.store.state(job.branchId).chapters).toHaveLength(1);
    expect(f.store.chapter(f.project.mainBranchId, first.id).text).toBe(first.text);
  });

  it('includes full rewrite context with recall disabled while replacing only the requested selection', async () => {
    const f = fixture(); f.minimalPrompt(); f.config.taskSettings!.recall = { maxChapters: 0 };
    const chapter = f.append('选段目标', '前文必须保留。旧片段。后文必须保留。');
    const start = chapter.text.indexOf('旧片段'); const end = start + '旧片段。'.length;
    const engine = f.engine(); const job = f.start(engine, { mode: 'rewrite', chapterId: chapter.id, selection: { start, end } }); engine.start();
    expect((await terminal(engine, job.id)).status).toBe('completed'); expect(f.recalled).toHaveLength(0);
    expect(f.written[0].prompt).toContain(chapter.text); expect(f.written[0].prompt).toContain('不扩大改写范围');
    expect(f.store.chapter(job.branchId, f.store.state(job.branchId).chapters[0].id).text).toBe('前文必须保留。作者要求的新正文。后文必须保留。');
  });

  it('recalls distant earlier chapters for continuation, excludes existing recent prose and uses writing-model fallback', async () => {
    const f = fixture(); f.config.recallProviderId = ''; f.config.taskSettings!.writing = { recentChapterCount: 1 };
    const far = f.append('遥远的约定', '第一章只在完整原文出现的细节。'); f.append('中间篇', '没有被选中的中间篇。'); const recent = f.append('最新篇', '最新保存结尾。');
    const engine = f.engine(); const job = f.start(engine); engine.start();
    expect((await terminal(engine, job.id)).status).toBe('completed');
    expect(catalog(f.recalled[0]).map(chapter => chapter.title)).not.toContain(recent.title);
    expect(f.written[0].prompt).toContain(far.text); expect(f.written[0].prompt).toContain(recent.text);
    expect(f.written[0].prompt).not.toContain('没有被选中的中间篇。');
    expect(f.written[0].prompt.match(/最新保存结尾。/g)).toHaveLength(2); // Recent prose plus continuation anchor, no recalled duplicate.
  });

  it.each(['unknown', 'duplicate', 'too-many'])('rejects %s selections before writing and never silently retries the recall', async kind => {
    const f = fixture(); f.config.taskSettings!.recall = { maxChapters: 1 };
    const first = f.append('开篇', '目标章原文。'); f.append('遥远的约定', '远章原文。'); f.append('另一个候选', '另章原文。');
    f.select.mockImplementation(async request => { const keys = catalog(request).map(chapter => chapter.key); return { chapterKeys: kind === 'unknown' ? ['outside-project'] : kind === 'duplicate' ? [keys[0], keys[0]] : keys.slice(0, 2) }; });
    const engine = f.engine(); const job = f.start(engine, { mode: 'rewrite', chapterId: first.id }); engine.start();
    expect((await terminal(engine, job.id)).status).toBe('failed'); expect(f.recalled).toHaveLength(1); expect(f.written).toHaveLength(0);
    const output = engine.listOutputs(job.id)[0]; expect(output).toMatchObject({ stage: 'recall', status: 'invalid' }); expect(engine.outputDetail(job.id, output.id).canApply).toBe(false);
    expect(() => engine.importOutput(job.id, '{}')).toThrow('原文召回');
  });

  it('retries a failed recall explicitly, then reuses successful selection after writing fails and the backup is restored', async () => {
    const f = fixture(); const first = f.append('开篇', '固定改写原文。'); const far = f.append('遥远的约定', '备份后仍须读取的远章原文。');
    f.select.mockRejectedValueOnce(new Error('模拟召回网络失败'));
    const engine = f.engine(); const job = f.start(engine, { mode: 'rewrite', chapterId: first.id }); engine.start();
    expect((await terminal(engine, job.id)).status).toBe('failed'); expect(f.written).toHaveLength(0);
    f.write.mockRejectedValueOnce(new Error('模拟写作网络失败')); engine.action(job.id, 'retry');
    expect((await terminal(engine, job.id)).status).toBe('failed'); expect(f.recalled).toHaveLength(2); expect(f.written).toHaveLength(1);
    const restored = f.store.restoreProject(f.store.exportProject(f.project.id));
    const restoredJob = engine.listJobs().find(value => value.projectId === restored.id && value.kind === 'generate')!;
    await engine.close(); const restarted = f.engine(); restarted.start(); restarted.action(restoredJob.id, 'retry');
    expect((await terminal(restarted, restoredJob.id)).status).toBe('completed'); expect(f.recalled).toHaveLength(2);
    expect(f.written[1].prompt).toContain(first.text); expect(f.written[1].prompt).toContain(far.text);
    expect(restarted.listOutputs(restoredJob.id).filter(output => output.stage === 'recall')).toHaveLength(1);
  });

  it('stops before prose when recalled full text exceeds the writing context, preserving the complete text', async () => {
    const f = fixture(); const first = f.append('开篇', '目标原文。'); f.append('遥远的约定', '不会被截短的原文。'.repeat(2000));
    f.config.modelParameters!.find(profile => profile.role === 'writing')!.contextTokens = 4096;
    const engine = f.engine(); const job = f.start(engine, { mode: 'rewrite', chapterId: first.id }); engine.start();
    const done = await terminal(engine, job.id); expect(done.status).toBe('failed'); expect(done.error).toContain('超过上下文上限');
    expect(f.recalled).toHaveLength(1); expect(f.written).toHaveLength(0); expect(engine.listOutputs(job.id)[0].status).toBe('applied');
  });

  it.each(['cancel', 'stale'])('does not start writing after recall when the task becomes %s', async action => {
    const f = fixture(); const first = f.append('开篇', '目标原文。'); f.append('遥远的约定', '远章原文。');
    const gate = deferred<unknown>(); f.select.mockImplementation(async () => gate.promise);
    const engine = f.engine(); const job = f.start(engine, { mode: 'rewrite', chapterId: first.id }); engine.start();
    await until(() => f.recalled.length, count => count > 0);
    if (action === 'cancel') engine.action(job.id, 'cancel');
    else f.store.commit(job.branchId, job.baseRevisionId, f.store.state(job.branchId), '外部更新版本');
    gate.resolve({ chapterKeys: [catalog(f.recalled[0])[0].key] });
    await until(() => JSON.parse(String(f.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data)) as Job, value => ['cancelled', 'stale'].includes(value.status));
    expect(f.written).toHaveLength(0);
  });

  it('skips recall for empty works and works whose complete prose is already included', async () => {
    const f = fixture(); const engine = f.engine(); const job = f.start(engine); engine.start();
    expect((await terminal(engine, job.id)).status).toBe('completed'); expect(f.recalled).toHaveLength(0);
    await until(() => f.store.state(job.branchId).chapters, chapters => chapters.every(chapter => chapter.status === 'ready'));
    const next = f.start(engine); expect((await terminal(engine, next.id)).status).toBe('completed'); expect(f.recalled).toHaveLength(0);
  });

  it('includes only confirmed fixed source chapters, deduplicates equal prose, and freezes the candidate texts', () => {
    const state = emptyState(); state.chapters = [{ id: 'c1', title: '当前章', summary: '已知剧情', status: 'ready', createdAt: '' }];
    const original = { reference: { branchId: 'b', revisionId: 'r', sourceIds: ['confirmed'] }, state: structuredClone(state), chapters: [{ ...state.chapters[0], text: '已有的完整原文。' }], sources: [{ sourceId: 'confirmed', filename: '原作.txt', chapters: [{ title: '重复章', text: '已有的完整原文。' }, { title: '尚未整理的远章', text: '全文尚未整理但可以召回。' }] }, { sourceId: 'excluded', filename: '其他.txt', chapters: [{ title: '不能看到', text: '排除的来源。' }] }] };
    const context = buildWritingContext({ state, chapterText: () => '已有的完整原文。', original });
    expect(context.recallChapters).toHaveLength(2); expect(context.recallChapters[0].included).toBe(true);
    original.sources[0].chapters[1].text = '后来发生的更改。';
    expect(context.recallChapters[1]).toMatchObject({ title: '尚未整理的远章', summary: '', text: '全文尚未整理但可以召回。', included: false });
  });
});
