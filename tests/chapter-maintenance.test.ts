import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { buildApp } from '../server/app.js';
import { readingProgressStory } from './fixtures/reading-progress.js';
import type { ExtractionResult, ModelRequest, Settings } from '../shared/types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
function story() { const store = new Store(mkdtempSync(join(tmpdir(), 'novel-chapter-maintenance-'))); cleanup.push(() => store.close()); return { store, ...readingProgressStory(store) }; }
const base = (store: Store, branchId: string) => store.getBranch(branchId).revisionId;
const settings: Settings = { providers: [{ id: 'fixture', name: '本地模拟', protocol: 'openai-chat', baseUrl: 'http://unused.invalid/v1', model: 'fixture', maxOutputTokens: 2048, contextTokens: 64000 }], writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture' };
const blank = (): ExtractionResult => ({ summary: '重新整理的摘要', entities: [], relations: [], foreshadows: [] });
async function terminal(engine: StoryEngine, jobId: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const job = engine.listJobs().find(job => job.id === jobId)!;
    if (['completed', 'failed', 'stale', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('测试任务未结束');
}

describe('versioned chapter and extracted material maintenance', () => {
  it('deletes just the middle chapter and its evidence while preserving later prose, facts, snapshots and other branches', () => {
    const { store, project, branchId, first, second, third } = story(); const original = store.exportProject(project.id);
    const other = store.fork(branchId, { baseRevisionId: base(store, branchId), name: '保留线' });
    const target = second.state.chapters[1].id;
    const changed = store.deleteChapter(branchId, base(store, branchId), target);
    expect(changed.state.chapters.map(chapter => chapter.id)).toEqual([first.state.chapters[0].id, third.state.chapters[2].id]);
    expect(changed.state.entities.find(entity => entity.name === '林舟')!.facts.filter(fact => fact.temporal === 'current').map(fact => fact.text)).toEqual(expect.arrayContaining(['身份是旅人', '目前位于灯塔', '当前受伤']));
    expect(changed.state.entities.some(entity => entity.name === '阿岚' || entity.name === '山城')).toBe(false);
    expect(changed.state.entities.find(entity => entity.name === '银灯')!.facts.map(fact => fact.text)).toEqual(['银灯熄灭']);
    expect(store.chapter(branchId, third.state.chapters[2].id).text).toBe(store.chapter(other.branch.id, third.state.chapters[2].id).text);
    expect(() => store.chapter(branchId, target)).toThrow('不包含');
    expect(store.view(branchId, false, first.state.chapters[0].id).state.entities.map(entity => entity.name)).toEqual(['林舟', '河岸', '铜钥']);
    expect(store.state(other.branch.id)).toEqual(other.state);
    for (const entry of original.revisions) expect(Buffer.from(store.db.prepare('SELECT state FROM revisions WHERE id=?').get(entry.revision.id)!.state as Uint8Array).toString('base64')).toBe(entry.snapshot);
    const restored = store.restoreProject(store.exportProject(project.id));
    const restoredMain = store.view(restored.mainBranchId, true);
    expect(restoredMain.state.chapters).toHaveLength(2);
    expect(store.view(restored.mainBranchId, false, restoredMain.state.chapters[0].id).state.entities).toHaveLength(3);
    const reverted = store.rollback(branchId, { baseRevisionId: changed.branch.revisionId, revisionId: third.branch.revisionId });
    expect(reverted.state).toEqual(third.state);
  });

  it('restores earlier current attributes and removes chapter pictures when deleting the last chapter', () => {
    const { store, branchId, second, third } = story();
    const view = store.deleteChapter(branchId, base(store, branchId), third.state.chapters[2].id);
    const traveler = view.state.entities.find(entity => entity.name === '林舟')!;
    expect(traveler.aliases).not.toContain('灯塔客');
    expect(traveler.facts.filter(fact => fact.temporal === 'current').map(fact => fact.text)).toEqual(['目前位于山城', '身份是信使']);
    expect(view.state.entities.some(entity => entity.name === '灯塔')).toBe(false);
    expect(view.state.imageIds).toEqual(second.state.imageIds);
    expect(store.search(branchId, '受伤', true).chapters).toHaveLength(0);
  });

  it('can delete the first and the remaining chapters down to an empty story', () => {
    const { store, branchId } = story();
    for (let remaining = 2; remaining >= 0; remaining--) {
      const target = store.state(branchId).chapters[0].id;
      const view = store.deleteChapter(branchId, base(store, branchId), target);
      expect(view.state.chapters).toHaveLength(remaining);
      for (const chapter of view.state.chapters) expect(() => store.view(branchId, false, chapter.id)).not.toThrow();
    }
    expect(store.state(branchId).entities).toHaveLength(0);
    expect(store.exportText(branchId)).toBe('');
  });

  it('clears only the selected chapter and preserves authored locks, later facts and full text', () => {
    const { store, branchId, third } = story(); const target = third.state.chapters[2].id;
    const traveler = structuredClone(third.state.entities.find(entity => entity.name === '林舟')!);
    traveler.locked = true; traveler.description = '作者修正的描述'; traveler.facts.find(fact => fact.citation?.chapterId === target)!.locked = true;
    store.updateEntity(branchId, base(store, branchId), traveler);
    const before = store.chapter(branchId, target).text;
    const view = store.clearChapterExtraction(branchId, base(store, branchId), target);
    expect(view.state.chapters[2]).toMatchObject({ status: 'pending', summary: '' });
    expect(store.chapter(branchId, target).text).toBe(before);
    expect(view.state.entities.find(entity => entity.id === traveler.id)).toMatchObject({ locked: true, description: '作者修正的描述' });
    expect(view.state.entities.find(entity => entity.id === traveler.id)!.facts.filter(fact => fact.citation?.chapterId === target)).toHaveLength(1);
    expect(view.state.entities.some(entity => entity.name === '灯塔')).toBe(false);
    expect(view.state.chapters[1].summary).toBe(third.state.chapters[1].summary);
  });

  it('detaches retained locked facts when their prose is deleted and preserves backup validity', () => {
    const { store, branchId, project, third } = story(); const target = third.state.chapters[2].id;
    const traveler = structuredClone(third.state.entities[0]); traveler.facts.find(fact => fact.citation?.chapterId === target)!.locked = true;
    store.updateEntity(branchId, base(store, branchId), traveler);
    const view = store.deleteChapter(branchId, base(store, branchId), target);
    const locked = view.state.entities[0].facts.find(fact => fact.locked)!;
    expect(locked.citation).toBeUndefined(); expect(locked.text).toBe('目前位于灯塔');
    expect(() => store.restoreProject(store.exportProject(project.id))).not.toThrow();
  });

  it('clears a newly extracted empty archive entry while retaining authored empty records', () => {
    const { store, branchId } = story();
    const saved = store.saveChapter(branchId, { baseRevisionId: base(store, branchId), title: '空档案', text: '一条尚未整理的线索。' }); const target = saved.state.chapters.at(-1)!.id;
    const extracted = blank(); extracted.entities = [{ kind: 'event', name: '无事实线索', description: '', aliases: [], visibility: 'public', facts: [] }];
    store.applyExtraction(branchId, base(store, branchId), target, extracted, true);
    const authored = { id: 'authored-empty', kind: 'event' as const, name: '作者线索', aliases: [], description: '作者设定', visibility: 'public' as const, locked: true, facts: [] };
    store.updateEntity(branchId, base(store, branchId), authored);
    const view = store.clearChapterExtraction(branchId, base(store, branchId), target);
    expect(view.state.entities.some(entity => entity.name === '无事实线索')).toBe(false);
    expect(view.state.entities.some(entity => entity.name === '作者线索')).toBe(true);
  });

  it('deletes an entity across all chapter views, cleans links and pictures, and keeps prose and historical recovery', () => {
    const { store, project, branchId, third } = story(); const traveler = third.state.entities[0];
    const state = store.state(branchId); state.foreshadows.push({ id: 'manual-clue', title: '作者伏笔', detail: '', status: 'planned', revealCondition: '', relatedEntityIds: [traveler.id] });
    store.commit(branchId, base(store, branchId), state, '作者伏笔');
    const view = store.deleteEntity(branchId, base(store, branchId), traveler.id);
    expect(view.state.chapters).toEqual(third.state.chapters);
    expect(view.state.entities.some(entity => entity.id === traveler.id)).toBe(false);
    expect(view.state.relations.some(relation => relation.fromId === traveler.id || relation.toId === traveler.id)).toBe(false);
    expect(view.state.foreshadows[0].relatedEntityIds).toEqual([]);
    expect(view.state.imageIds?.some(id => store.images.get(id)?.entityId === traveler.id)).toBe(false);
    for (const chapter of view.state.chapters) expect(store.view(branchId, false, chapter.id).state.entities.some(entity => entity.id === traveler.id)).toBe(false);
    expect(store.search(branchId, '林舟', true).entities).toHaveLength(0);
    expect(() => store.restoreProject(store.exportProject(project.id))).not.toThrow();
  });

  it('removes merged aliases with a deleted canonical entity', () => {
    const { store, branchId } = story(); const state = store.state(branchId); const traveler = state.entities[0];
    const added = store.updateEntity(branchId, base(store, branchId), { ...structuredClone(traveler), id: 'new-person', name: '另一个称呼', facts: [], locked: true });
    const alias = added.state.entities.at(-1)!;
    store.mergeEntities(branchId, base(store, branchId), alias.id, traveler.id);
    const changed = store.deleteEntity(branchId, base(store, branchId), traveler.id);
    expect(changed.state.entities.some(entity => entity.id === alias.id || entity.id === traveler.id)).toBe(false);
  });

  it('rolls back all new boundary snapshots if the task checkpoint cannot be saved', () => {
    const { store, project, branchId, third } = story(); const original = store.exportProject(project.id);
    expect(() => store.clearChapterExtraction(branchId, base(store, branchId), third.state.chapters[0].id, () => { throw new Error('写入失败'); })).toThrow('写入失败');
    expect(store.exportProject(project.id)).toEqual(original);
  });

  it('rejects stale versions and chapters/entities from another story without modifying either', () => {
    const { store, branchId, first } = story(); const other = store.createProject({ title: '另一作品' });
    expect(() => store.deleteChapter(branchId, first.branch.revisionId, first.state.chapters[0].id)).toThrow('新版本');
    expect(() => store.deleteChapter(other.mainBranchId, base(store, other.mainBranchId), first.state.chapters[0].id)).toThrow('不包含');
    expect(() => store.deleteEntity(other.mainBranchId, base(store, other.mainBranchId), first.state.entities[0].id)).toThrow('不属于');
  });

  it('invalidates compressed summaries, shifts future plan chapter numbers and retains authored settings when deleting prose', () => {
    const { store, branchId, third } = story(); const state = store.state(branchId);
    state.outline = { worldview: '作者世界设定', locked: '作者限制', fine: [{ chapter: 4, title: '后续', goal: '继续' }], summaryCompression: { text: '旧压缩摘要', chapterIds: state.chapters.map(chapter => chapter.id) } };
    state.foreshadows.push({ id: 'authored-clue', title: '作者线索', detail: '作者安排', status: 'planned', dueChapter: 5, revealCondition: '', relatedEntityIds: [] });
    store.commit(branchId, base(store, branchId), state, '作者设置');
    const view = store.deleteChapter(branchId, base(store, branchId), third.state.chapters[1].id);
    expect(view.state.outline).toEqual({ worldview: '作者世界设定', locked: '作者限制', fine: [{ chapter: 3, title: '后续', goal: '继续' }] });
    expect(view.state.foreshadows[0]).toMatchObject({ title: '作者线索', detail: '作者安排', dueChapter: 4 });
  });

  it('does not retain a deleted clue chapter reference when a later chapter resolves the clue', () => {
    const { store, branchId, first, third } = story(); const state = store.state(branchId);
    state.foreshadows.push({ id: 'resolved-clue', title: '旧线索', detail: '已经揭晓', status: 'resolved', plantedChapterId: first.state.chapters[0].id, resolvedChapterId: third.state.chapters[2].id, revealCondition: '', relatedEntityIds: [] });
    store.commit(branchId, base(store, branchId), state, '记录后续揭晓');
    const view = store.deleteChapter(branchId, base(store, branchId), first.state.chapters[0].id);
    expect(view.state.foreshadows[0]).toMatchObject({ status: 'resolved', resolvedChapterId: third.state.chapters[2].id }); expect(view.state.foreshadows[0].plantedChapterId).toBeUndefined();
  });

  it('reextracts exactly one old chapter, replaces rather than duplicates its results, and does not expose future names to the model', async () => {
    const { store, branchId, second, third } = story(); const target = second.state.chapters[1].id; const requests: ModelRequest[] = [];
    const result = blank(); result.entities = [{ kind: 'character', name: '林舟', aliases: [], description: '', visibility: 'public', facts: [{ text: '当前在山城送信', attribute: 'location', temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 1, quote: store.chapter(branchId, target).text }] }];
    const models: TextModels = { generateText: vi.fn(), generateStructured: vi.fn(async (_provider, request, validate) => { requests.push(request); return { value: validate(result), inputTokens: 10, outputTokens: 20 }; }) as TextModels['generateStructured'] };
    const engine = new StoryEngine(store, () => settings, models); cleanup.push(() => engine.close()); engine.start();
    const queued = engine.reextractChapter(branchId, base(store, branchId), target);
    expect((await terminal(engine, queued.job.id)).status).toBe('completed'); expect(requests).toHaveLength(1);
    expect(requests[0].prompt).not.toContain('灯塔客');
    const view = store.view(branchId, true);
    expect(view.state.chapters[1]).toMatchObject({ status: 'ready', summary: '重新整理的摘要' });
    expect(view.state.chapters[2]).toEqual(third.state.chapters[2]);
    const traveler = view.state.entities.find(entity => entity.name === '林舟')!;
    expect(traveler.facts.filter(fact => fact.citation?.chapterId === target)).toHaveLength(1);
    expect(traveler.facts.find(fact => fact.text === '目前位于灯塔')!.temporal).toBe('current');
    expect(traveler.facts.find(fact => fact.text === '当前在山城送信')!.temporal).toBe('past');
    const middle = store.view(branchId, false, target);
    expect(middle.state.entities[0].facts.find(fact => fact.text === '当前在山城送信')!.temporal).toBe('current');
    expect(middle.state.entities[0].facts.find(fact => fact.text === '当前在山城送信')!.id).toBe(traveler.facts.find(fact => fact.text === '当前在山城送信')!.id);
    expect(JSON.stringify(middle)).not.toContain('灯塔客');
    expect(store.view(branchId, false, view.state.chapters[0].id).state.entities[0].facts.some(fact => fact.text === '当前在山城送信')).toBe(false);
    const repeated = engine.reextractChapter(branchId, base(store, branchId), target); expect((await terminal(engine, repeated.job.id)).status).toBe('completed');
    expect(store.state(branchId).entities[0].facts.filter(fact => fact.citation?.chapterId === target)).toHaveLength(1);
  });

  it('does not extract other pending chapters, and manual recovery finishes only the chosen chapter', async () => {
    const { store, branchId, third } = story();
    store.clearChapterExtraction(branchId, base(store, branchId), third.state.chapters[2].id);
    const models: TextModels = { generateText: vi.fn(), generateStructured: vi.fn(async () => { throw new Error('模拟提取失败'); }) };
    const engine = new StoryEngine(store, () => settings, models); cleanup.push(() => engine.close()); engine.start();
    const queued = engine.reextractChapter(branchId, base(store, branchId), third.state.chapters[0].id);
    expect((await terminal(engine, queued.job.id)).status).toBe('failed');
    expect(models.generateStructured).toHaveBeenCalledTimes(1);
    const imported = engine.importOutput(queued.job.id, JSON.stringify(blank()));
    expect(engine.applyOutput(queued.job.id, imported.id, { baseRevisionId: imported.baseRevisionId, text: JSON.stringify(blank()) }).status).toBe('completed');
    expect(store.state(branchId).chapters.map(chapter => chapter.status)).toEqual(['ready', 'ready', 'pending']);
  });

  it('keeps old materials when extraction is unconfigured and rejects paused tasks', () => {
    const { store, branchId, third } = story();
    const engine = new StoryEngine(store, () => ({ ...settings, providers: [] })); cleanup.push(() => engine.close());
    expect(() => engine.reextractChapter(branchId, base(store, branchId), third.state.chapters[0].id)).toThrow('供应商');
    expect(store.state(branchId)).toEqual(third.state);
    const job = engine.enqueue(branchId, 'extract', { baseRevisionId: base(store, branchId) }); engine.action(job.id, 'pause');
    expect(() => engine.assertIdle(branchId)).toThrow('完成或取消');
    engine.action(job.id, 'cancel'); expect(() => engine.assertIdle(branchId)).not.toThrow();
  });

  it('restores a paused single-chapter job with remapped target IDs and rejects broken target associations', async () => {
    const { store, project, branchId, third } = story();
    store.clearChapterExtraction(branchId, base(store, branchId), third.state.chapters[2].id);
    const originalEngine = new StoryEngine(store, () => settings); cleanup.push(() => originalEngine.close());
    const queued = originalEngine.reextractChapter(branchId, base(store, branchId), third.state.chapters[0].id);
    const backup = store.exportProject(project.id); const bad = structuredClone(backup); bad.jobs[0].payload.targetChapterId = 'missing';
    expect(() => store.restoreProject(bad)).toThrow('章节不存在');
    const restored = store.restoreProject(backup); originalEngine.action(queued.job.id, 'cancel');
    const models: TextModels = { generateText: vi.fn(), generateStructured: vi.fn(async (_provider, _request, validate) => ({ value: validate(blank()), inputTokens: 10, outputTokens: 20 })) as TextModels['generateStructured'] };
    const engine = new StoryEngine(store, () => settings, models); cleanup.push(() => engine.close()); engine.start();
    const job = engine.listJobs(restored.id)[0]; expect(job.status).toBe('paused');
    const persisted = store.exportProject(restored.id).jobs[0]; expect(persisted.payload.targetChapterId).toBe(store.state(restored.mainBranchId).chapters[0].id); expect(persisted.payload.targetChapterId).not.toBe(third.state.chapters[0].id);
    engine.action(job.id, 'resume'); expect((await terminal(engine, job.id)).status).toBe('completed');
    expect(models.generateStructured).toHaveBeenCalledTimes(1); expect(store.state(restored.mainBranchId).chapters.map(chapter => chapter.status)).toEqual(['ready', 'ready', 'pending']);
  });

  it('resumes a failed single-chapter extraction at the failed block and keeps its successful first block', async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'novel-maintenance-resume-'))); cleanup.push(() => store.close()); const project = store.createProject({ title: '分段恢复' }); const branchId = project.mainBranchId;
    const saved = store.saveChapter(branchId, { baseRevisionId: base(store, branchId), title: '长章', text: `${'甲'.repeat(4000)}\n${'乙'.repeat(4000)}` }); const target = saved.state.chapters[0].id;
    store.applyExtraction(branchId, base(store, branchId), target, { ...blank(), summary: '旧摘要' }, true);
    const next = store.saveChapter(branchId, { baseRevisionId: base(store, branchId), title: '后章', text: '后章正文' }); store.applyExtraction(branchId, base(store, branchId), next.state.chapters[1].id, blank(), true);
    let attempt = 0; const requests: string[] = [];
    const models: TextModels = { generateText: vi.fn(), generateStructured: vi.fn(async (_provider, request, validate) => { requests.push(request.prompt); if (++attempt === 2) throw new Error('模拟第二段失败'); return { value: validate({ ...blank(), summary: attempt === 1 ? '新片段一' : '新片段二' }), inputTokens: 10, outputTokens: 20 }; }) as TextModels['generateStructured'] };
    const nextBefore = store.state(branchId).chapters[1];
    const engine = new StoryEngine(store, () => settings, models); cleanup.push(() => engine.close()); engine.start(); const queued = engine.reextractChapter(branchId, base(store, branchId), target);
    expect((await terminal(engine, queued.job.id)).status).toBe('failed'); expect(store.state(branchId).chapters[0]).toMatchObject({ summary: '新片段一', status: 'pending' });
    engine.action(queued.job.id, 'retry'); expect((await terminal(engine, queued.job.id)).status).toBe('completed');
    expect(attempt).toBe(3); expect(requests[2]).toContain('乙乙乙'); expect(requests[2]).not.toContain('甲甲甲');
    expect(store.state(branchId).chapters[0].summary).toBe('新片段一\n新片段二'); expect(store.state(branchId).chapters[1]).toEqual(nextBefore);
  });

  it('blocks maintenance until a cancelled request ends and never applies its late response', async () => {
    const { store, branchId, third } = story(); let resolve!: (value: ExtractionResult) => void;
    const pending = new Promise<ExtractionResult>(complete => { resolve = complete; });
    const models: TextModels = { generateText: vi.fn(), generateStructured: vi.fn(async (_provider, _request, validate) => ({ value: validate(await pending), inputTokens: 10, outputTokens: 20 })) as TextModels['generateStructured'] };
    const engine = new StoryEngine(store, () => settings, models); cleanup.push(() => engine.close()); engine.start(); const queued = engine.reextractChapter(branchId, base(store, branchId), third.state.chapters[1].id);
    for (let index = 0; index < 100 && !vi.mocked(models.generateStructured).mock.calls.length; index++) await new Promise(done => setTimeout(done, 5));
    engine.action(queued.job.id, 'cancel'); const state = store.state(branchId);
    expect(() => engine.assertIdle(branchId)).toThrow('完成或取消'); resolve(blank());
    for (let index = 0; index < 100; index++) { try { engine.assertIdle(branchId); break; } catch { await new Promise(done => setTimeout(done, 5)); } }
    expect(() => engine.assertIdle(branchId)).not.toThrow(); expect(store.state(branchId)).toEqual(state);
    const changed = store.deleteChapter(branchId, base(store, branchId), third.state.chapters[1].id); expect(changed.state.chapters).toHaveLength(2);
  });

  it('requires authenticated author requests, current versions and an idle branch through HTTP', async () => {
    const ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'novel-maintenance-api-')), initialPassword: 'maintenance-password-123', startEngine: false }); cleanup.push(() => ctx.app.close());
    const fixture = readingProgressStory(ctx.store); const target = fixture.third.state.chapters[1].id;
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'maintenance-password-123' } }); const session = login.cookies.find(cookie => cookie.name === 'session')!.value;
    const routes = [['DELETE', `/chapters/${target}`], ['DELETE', `/chapters/${target}/extraction`], ['POST', `/chapters/${target}/extract`], ['DELETE', `/entities/${fixture.third.state.entities[0].id}`]] as const;
    for (const [method, path] of routes) {
      const url = `/api/branches/${fixture.branchId}${path}`; const payload = { baseRevisionId: base(ctx.store, fixture.branchId) };
      expect((await ctx.app.inject({ method, url: `${url}?view=author`, payload })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method, url, cookies: { session }, payload })).statusCode).toBe(403);
      expect((await ctx.app.inject({ method, url: `${url}?view=author`, cookies: { session }, payload: { baseRevisionId: 'old' } })).statusCode).toBe(409);
    }
    const response = await ctx.app.inject({ method: 'DELETE', url: `/api/branches/${fixture.branchId}/chapters/${target}?view=author`, cookies: { session }, payload: { baseRevisionId: base(ctx.store, fixture.branchId) } });
    expect(response.statusCode).toBe(200); expect(response.json().state.chapters).toHaveLength(2);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/branches/${fixture.branchId}/chapters/${target}?view=author`, cookies: { session }, payload: { baseRevisionId: base(ctx.store, fixture.branchId) } })).statusCode).toBe(404);
  });
});
