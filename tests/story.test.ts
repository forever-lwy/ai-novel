import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { OutputValidationError, Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import type { Entity, ExtractionResult, Job, ModelRequest, PlanningResult, Settings } from '../shared/types.js';

const stores: Store[] = [];
const engines: StoryEngine[] = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.close(); await new Promise(r => setTimeout(r, 5)); for (const store of stores.splice(0)) store.close(); });
function makeStore() { const store = new Store(mkdtempSync(join(tmpdir(), 'ai-novel-story-'))); stores.push(store); return store; }
const emptyExtraction = (): ExtractionResult => ({ summary: '本章提要', entities: [], relations: [], foreshadows: [] });
function person(name: string, text: string, quote: string, options: { aliases?: string[]; temporal?: 'current' | 'past' | 'future' | 'unknown'; attribute?: string } = {}): ExtractionResult['entities'][number] {
  return { name, kind: 'character', aliases: options.aliases ?? [], description: text, visibility: 'public', facts: [{ text, quote, paragraph: 1, temporal: options.temporal ?? 'current', certainty: 'fact', visibility: 'public', attribute: options.attribute }] };
}
function append(store: Store, branchId: string, text: string, result = emptyExtraction(), title = '正文') {
  const saved = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title, text });
  return store.applyExtraction(branchId, saved.branch.revisionId, saved.state.chapters.at(-1)!.id, result, true);
}
const settings = (): Settings => ({ providers: [{ id: 'fixture', name: '协议模拟模型', protocol: 'openai-chat', baseUrl: 'http://unused.invalid/v1', model: 'fixture', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture', taskTokenLimit: 500000 });
const plan = (): PlanningResult => ({ coarse: '旅人寻找回家的路', fine: [1, 2, 3, 4].map(chapter => ({ chapter, title: `第 ${chapter} 章`, goal: '继续寻找线索' })), foreshadows: [] });
function models(extract?: (request: ModelRequest) => Promise<ExtractionResult>, write?: (request: ModelRequest) => Promise<string>): TextModels {
  return {
    generateText: vi.fn(async (_config, request) => ({ text: await (write?.(request) ?? Promise.resolve('阿青走进临江城。')), inputTokens: 10, outputTokens: 20 })),
    generateStructured: vi.fn(async (_config, request, validate) => ({ value: validate(request.system.includes('整部作品粗大纲') ? plan() : await (extract?.(request) ?? Promise.resolve(emptyExtraction()))), inputTokens: 10, outputTokens: 20 })) as TextModels['generateStructured'],
  };
}
function engineFor(store: Store, model: TextModels, config = settings()) { const engine = new StoryEngine(store, () => config, model); engines.push(engine); engine.start(); return engine; }
async function until<T>(read: () => T, predicate: (value: T) => boolean, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) { const value = read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error(`等待状态超时：${JSON.stringify(value)}`); await new Promise(r => setTimeout(r, 5)); }
}
const jobState = (engine: StoryEngine, id: string) => engine.listJobs().find(j => j.id === id)!;
const rawJob = (store: Store, id: string): Job => JSON.parse(String(store.db.prepare('SELECT data FROM jobs WHERE id=?').get(id)!.data));
const terminal = (engine: StoryEngine, id: string) => until(() => jobState(engine, id), j => ['completed', 'failed', 'cancelled', 'stale'].includes(j.status));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe('versioned story and world state', () => {
  it('preserves an existing description when a compact extraction only adds new facts', () => {
    const store = makeStore(); const project = store.createProject({ title: '资料描述保留' });
    const first = emptyExtraction(); first.entities = [person('阿青', '旅人，熟悉古城', '阿青')];
    append(store, project.mainBranchId, '阿青站在桥边。', first);
    const next = emptyExtraction(); next.entities = [person('阿青', '阿青抵达码头', '阿青')]; next.entities[0].description = '';
    const view = append(store, project.mainBranchId, '阿青抵达码头。', next);
    expect(view.state.entities[0].description).toBe('旅人，熟悉古城');
    expect(view.state.entities[0].facts).toHaveLength(2);
  });

  it('reports all unresolved relationship and foreshadow names together without committing partial knowledge', () => {
    const store = makeStore(); const project = store.createProject({ title: '关联修正' });
    const text = '阿青走进临江城。';
    const saved = store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: '抵达', text });
    const result = emptyExtraction(); result.entities = [person('阿青', '走进城中', text)];
    result.relations = ['甲', '乙'].map(name => ({ from: name, to: '尚未识别的地点', label: '前往', visibility: 'public', paragraph: 1, quote: text }));
    result.foreshadows = [{ title: '约定', detail: '', status: 'planned', revealCondition: '', relatedNames: ['丙', '丁'] }];
    let failure: unknown;
    try { store.applyExtraction(project.mainBranchId, saved.branch.revisionId, saved.state.chapters[0].id, result, true); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(OutputValidationError);
    expect((failure as OutputValidationError).issues.map(issue => issue.path)).toEqual(['relations[0].from', 'relations[0].to', 'relations[1].from', 'relations[1].to', 'foreshadows[0].relatedNames[0]', 'foreshadows[0].relatedNames[1]']);
    expect(store.getBranch(project.mainBranchId).revisionId).toBe(saved.branch.revisionId);
    expect(store.state(project.mainBranchId).entities).toHaveLength(0);
    expect(store.state(project.mainBranchId).chapters[0].status).toBe('pending');
  });

  it('forks at chapter 20 without inheriting the death recorded at chapter 80', () => {
    const store = makeStore(); const p = store.createProject({ title: '长篇时间线' }); const branchId = p.mainBranchId; let chapter20 = '';
    for (let index = 1; index <= 80; index++) {
      const text = index === 20 ? '阿青活着走过桥。' : index === 80 ? '阿青死于城外。' : `旅人经过第${index}处街巷。`;
      const extraction = emptyExtraction(); if (index === 20 || index === 80) extraction.entities.push(person('阿青', index === 20 ? '阿青仍然活着' : '阿青已经死亡', text, { attribute: 'status' }));
      const view = append(store, branchId, text, extraction, `第${index}章`); if (index === 20) chapter20 = view.state.chapters.at(-1)!.id;
    }
    const fork = store.fork(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, chapterId: chapter20, name: '二十章之后' });
    expect(fork.state.chapters).toHaveLength(20);
    expect(JSON.stringify(fork.state)).not.toContain('已经死亡');
    expect(fork.state.entities[0].facts[0].text).toContain('仍然活着');
    expect(store.state(branchId).chapters).toHaveLength(80);
    expect(() => store.chapter(fork.branch.id, store.state(branchId).chapters[79].id)).toThrow('不包含');
  });

  it('creates a separate revision branch for historical edits and preserves immutable original text', () => {
    const store = makeStore(); const p = store.createProject({ title: '修订' });
    const first = append(store, p.mainBranchId, '第一章旧文'); append(store, p.mainBranchId, '第二章原文');
    const original = store.view(p.mainBranchId, true);
    const revised = store.saveChapter(p.mainBranchId, { baseRevisionId: original.branch.revisionId, chapterId: first.state.chapters[0].id, title: '第一章新文', text: '第一章新文' });
    expect(revised.branch.id).not.toBe(p.mainBranchId); expect(revised.state.chapters).toHaveLength(1); expect(revised.state.chapters[0].status).toBe('pending');
    expect(store.exportText(p.mainBranchId)).toContain('第一章旧文'); expect(store.exportText(p.mainBranchId)).toContain('第二章原文');
    expect(store.getBranch(p.mainBranchId).revisionId).toBe(original.branch.revisionId);
  });

  it('replaces the latest chapter and removes AI discoveries while retaining deliberate human constraints', () => {
    const store = makeStore(); const p = store.createProject({ title: '人类约束', premise: '禁用穿越' });
    const result = emptyExtraction(); result.entities.push(person('临时人物', '本章才出现', '临时人物')); let view = append(store, p.mainBranchId, '临时人物出现。', result);
    const chapterId = view.state.chapters[0].id;
    view = store.updateOutline(p.mainBranchId, view.branch.revisionId, { coarse: '', fine: [], locked: '必须保持单一视角' });
    const manual: Entity = { id: 'manual', name: '主角', aliases: ['阿青'], kind: 'character', description: '用户确认的主角', visibility: 'public', locked: true, facts: [{ id: 'manual-fact', text: '主角不会魔法', certainty: 'fact', temporal: 'current', visibility: 'public', locked: true }] };
    view = store.updateEntity(p.mainBranchId, view.branch.revisionId, manual);
    const revised = store.saveChapter(p.mainBranchId, { baseRevisionId: view.branch.revisionId, chapterId, title: '重写第一章', text: '主角走过田野。' });
    expect(revised.branch.id).toBe(p.mainBranchId); expect(revised.state.outline.locked).toBe('必须保持单一视角');
    expect(revised.state.entities.map(e => e.name)).toEqual(['主角']); expect(revised.state.entities[0].facts[0].text).toBe('主角不会魔法');
  });

  it('restores chapters, world, outline and hidden foreshadowing in one revision and rejects stale writes', () => {
    const store = makeStore(); const p = store.createProject({ title: '联合回退' }); const first = append(store, p.mainBranchId, '阿青抵达。');
    const result = emptyExtraction(); result.entities.push(person('新角色', '新角色在场', '新角色')); result.foreshadows.push({ title: '钥匙', detail: '隐藏真相', status: 'planted', revealCondition: '第五章', relatedNames: ['新角色'] });
    const second = append(store, p.mainBranchId, '新角色带着钥匙。', result);
    const rollback = store.rollback(p.mainBranchId, { baseRevisionId: second.branch.revisionId, revisionId: first.branch.revisionId });
    expect(rollback.state.chapters).toHaveLength(1); expect(rollback.state.entities).toHaveLength(0); expect(rollback.state.foreshadows).toHaveLength(0);
    expect(() => store.updateOutline(p.mainBranchId, second.branch.revisionId, { coarse: '过期编辑', fine: [], locked: '' })).toThrow('新版本');
    expect(store.view(p.mainBranchId, true).state).toEqual(first.state);
  });

  it('tracks attribute changes without allowing memories or future plans to replace current location', () => {
    const store = makeStore(); const p = store.createProject({ title: '状态与回忆' });
    for (const [text, temporal] of [['阿青现在在江城', 'current'], ['阿青现在在山城', 'current'], ['阿青记得从前住在海城', 'past'], ['阿青计划明年住在王城', 'future']] as const) {
      const result = emptyExtraction(); result.entities.push(person('阿青', text, text, { attribute: 'location', temporal })); append(store, p.mainBranchId, text, result);
    }
    const facts = store.state(p.mainBranchId).entities[0].facts;
    expect(facts.filter(f => f.temporal === 'current').map(f => f.text)).toEqual(['阿青现在在山城']);
    expect(facts.find(f => f.text === '阿青现在在江城')?.temporal).toBe('past');
    expect(store.state(p.mainBranchId).entities[0].description).toBe('阿青现在在山城');
  });

  it('retains a return to the same place within one chapter and deduplicates only the same citation', () => {
    const store = makeStore(); const p = store.createProject({ title: '章内往返' });
    const lines = ['阿青抵达江城。', '阿青前往山城。', '阿青回到江城。'];
    let view = store.saveChapter(p.mainBranchId, { baseRevisionId: store.getBranch(p.mainBranchId).revisionId, title: '往返', text: lines.join('\n') });
    const chapterId = view.state.chapters[0].id;
    for (let index = 0; index < lines.length; index++) {
      const result = emptyExtraction(); const entity = person('阿青', `当前所在地为${index === 1 ? '山城' : '江城'}`, lines[index], { attribute: 'location' }); entity.facts[0].paragraph = index + 1; result.entities.push(entity);
      view = store.applyExtraction(p.mainBranchId, view.branch.revisionId, chapterId, result, index === 2);
      if (index === 2) view = store.applyExtraction(p.mainBranchId, view.branch.revisionId, chapterId, result, true);
    }
    expect(view.state.entities[0].facts).toHaveLength(3);
    expect(view.state.entities[0].facts.map(f => f.temporal)).toEqual(['past', 'past', 'current']);
    expect(view.state.entities[0].facts.filter(f => f.temporal === 'current')).toMatchObject([{ text: '当前所在地为江城', citation: { paragraph: 3, quote: '阿青回到江城。' } }]);
  });

  it('deduplicates aliases, preserves locked facts and makes merges reversible', () => {
    const store = makeStore(); const p = store.createProject({ title: '别名与锁定' });
    const firstResult = emptyExtraction(); firstResult.entities.push(person('阿青', '阿青在江城', '阿青在江城', { aliases: ['青姑娘'], attribute: 'location' })); let view = append(store, p.mainBranchId, '阿青在江城', firstResult);
    view = store.updateEntity(p.mainBranchId, view.branch.revisionId, { ...view.state.entities[0], locked: true, facts: view.state.entities[0].facts.map(f => ({ ...f, locked: true })) });
    const secondResult = emptyExtraction(); secondResult.entities.push(person('青姑娘', '青姑娘在山城', '青姑娘在山城', { attribute: 'location' })); view = append(store, p.mainBranchId, '青姑娘在山城', secondResult);
    expect(view.state.entities).toHaveLength(1); expect(view.state.entities[0].description).toBe('阿青在江城');
    expect(view.state.entities[0].facts[0].temporal).toBe('current'); expect(view.state.entities[0].facts[1].certainty).toBe('conflict');
    view = store.updateEntity(p.mainBranchId, view.branch.revisionId, { id: 'second', kind: 'character', name: '青儿', aliases: [], description: '', facts: [], visibility: 'public', locked: true });
    const beforeMerge = view; const merged = store.mergeEntities(p.mainBranchId, view.branch.revisionId, view.state.entities[1].id, view.state.entities[0].id);
    expect(store.view(p.mainBranchId).state.entities).toHaveLength(1);
    store.rollback(p.mainBranchId, { baseRevisionId: merged.branch.revisionId, revisionId: beforeMerge.branch.revisionId }); expect(store.view(p.mainBranchId).state.entities).toHaveLength(2);
  });

  it('allows the user to unlock entities and facts so later AI extraction can update their state', () => {
    const store = makeStore(); const p = store.createProject({ title: '解除锁定' }); const first = emptyExtraction(); first.entities.push(person('阿青', '当前位于江城', '阿青在江城', { attribute: 'location' }));
    let view = append(store, p.mainBranchId, '阿青在江城', first);
    view = store.updateEntity(p.mainBranchId, view.branch.revisionId, { ...view.state.entities[0], locked: true, facts: view.state.entities[0].facts.map(f => ({ ...f, locked: true })) });
    expect(view.state.entities[0].locked).toBe(true); expect(view.state.entities[0].facts[0].locked).toBe(true);
    view = store.updateEntity(p.mainBranchId, view.branch.revisionId, { ...view.state.entities[0], locked: false, facts: view.state.entities[0].facts.map(f => ({ ...f, locked: false })) });
    expect(view.state.entities[0].locked).toBe(false); expect(view.state.entities[0].facts[0].locked).toBe(false);
    const second = emptyExtraction(); second.entities.push(person('阿青', '当前位于山城', '阿青在山城', { attribute: 'location' })); view = append(store, p.mainBranchId, '阿青在山城', second);
    expect(view.state.entities[0].description).toBe('当前位于山城');
    expect(view.state.entities[0].facts.map(f => [f.temporal, f.certainty])).toEqual([['past', 'fact'], ['current', 'fact']]);
  });

  it('rejects invalid manual citations, merge targets and foreshadow chapter references before creating a revision', () => {
    const store = makeStore(); const p = store.createProject({ title: '人工资料验证' }); const result = emptyExtraction(); result.entities.push(person('阿青', '在江城', '阿青在江城'));
    let view = append(store, p.mainBranchId, '阿青在江城', result); const chapterId = view.state.chapters[0].id; const entityId = view.state.entities[0].id;
    const foreign = store.createProject({ title: '其他作品' }); const foreignView = append(store, foreign.mainBranchId, '阿青在江城'); const foreignChapterId = foreignView.state.chapters[0].id;
    const citationCases = [{ chapterId: foreignChapterId, paragraph: 1, quote: '阿青' }, { chapterId, paragraph: 2, quote: '阿青' }, { chapterId, paragraph: 1, quote: '没有出现的文字' }];
    for (const citation of citationCases) expect(() => store.updateEntity(p.mainBranchId, view.branch.revisionId, { ...view.state.entities[0], facts: [{ ...view.state.entities[0].facts[0], citation }] })).toThrow('资料引用');
    view = store.updateEntity(p.mainBranchId, view.branch.revisionId, { id: 'city', kind: 'location', name: '江城', aliases: [], description: '', facts: [], locked: true, visibility: 'public' });
    const character = view.state.entities.find(e => e.id === entityId)!; const city = view.state.entities.find(e => e.kind === 'location')!;
    for (const mergedInto of [entityId, city.id, 'missing']) expect(() => store.updateEntity(p.mainBranchId, view.branch.revisionId, { ...character, mergedInto })).toThrow('合并目标');
    for (const field of ['plantedChapterId', 'resolvedChapterId']) expect(() => store.updateForeshadows(p.mainBranchId, view.branch.revisionId, [{ id: 'clue', title: '线索', detail: '', status: 'planted', revealCondition: '', relatedEntityIds: [entityId], [field]: foreignChapterId }])).toThrow('必须属于本故事线');
    expect(store.getBranch(p.mainBranchId).revisionId).toBe(view.branch.revisionId);
    view = store.updateForeshadows(p.mainBranchId, view.branch.revisionId, [{ id: 'clue', title: '线索', detail: '', status: 'planted', revealCondition: '', relatedEntityIds: [entityId], plantedChapterId: chapterId }]);
    expect(() => store.restoreProject(store.exportProject(p.id))).not.toThrow();
  });

  it('rejects wrong paragraph quotes and missing relationship targets without applying partial extraction', () => {
    const store = makeStore(); const p = store.createProject({ title: '引用验证' }); const saved = store.saveChapter(p.mainBranchId, { baseRevisionId: store.getBranch(p.mainBranchId).revisionId, title: '第一章', text: '阿青站在桥边。\n江水流过。' }); const chapterId = saved.state.chapters[0].id;
    const bad = emptyExtraction(); bad.entities.push(person('阿青', '住在火星', '不存在的引文'));
    expect(() => store.applyExtraction(p.mainBranchId, saved.branch.revisionId, chapterId, bad, true)).toThrow('引用校验');
    bad.entities = [person('阿青', '站在桥边', '阿青')]; bad.relations.push({ from: '阿青', to: '不存在的人', label: '朋友', visibility: 'public', paragraph: 1, quote: '阿青' });
    expect(() => store.applyExtraction(p.mainBranchId, saved.branch.revisionId, chapterId, bad, true)).toThrow('资料关联');
    expect(store.state(p.mainBranchId).entities).toHaveLength(0); expect(store.getBranch(p.mainBranchId).revisionId).toBe(saved.branch.revisionId);
  });

  it('removes secrets from reader descriptions, summaries, related edges and searches', () => {
    const store = makeStore(); const p = store.createProject({ title: '读者投影', premise: '隐藏粗纲' }); const result = emptyExtraction(); result.summary = '未来秘密结局';
    result.entities.push(person('阿青', '秘密身份未来会死', '阿青'), { ...person('幕后者', '真正凶手', '幕后者'), visibility: 'secret' }, person('未登场的人', '将在末章出现', '阿青', { temporal: 'future' }));
    result.entities[0].facts.push({ text: '明天死亡', temporal: 'future', certainty: 'fact', visibility: 'public', quote: '阿青', paragraph: 1 }, { text: '秘密身份', temporal: 'current', certainty: 'fact', visibility: 'secret', quote: '阿青', paragraph: 1 });
    result.entities[0].facts[0].text = '阿青是旅人'; result.relations.push({ from: '阿青', to: '幕后者', label: '关联幕后者', visibility: 'public', paragraph: 1, quote: '阿青' });
    const view = append(store, p.mainBranchId, '阿青碰见幕后者。', result);
    const reader = store.view(p.mainBranchId); const text = JSON.stringify(reader);
    for (const hidden of ['秘密身份', '明天死亡', '未来秘密结局', '隐藏粗纲', '真正凶手', '未登场的人']) expect(text).not.toContain(hidden);
    expect(reader.state.relations).toHaveLength(0); expect(reader.state.entities[0].description).toBe('阿青是旅人'); expect(store.chapter(p.mainBranchId, view.state.chapters[0].id).summary).toBe('');
    expect(store.search(p.mainBranchId, '秘密身份').entities).toHaveLength(0); expect(store.search(p.mainBranchId, '秘密身份', true).entities).toHaveLength(1);
  });

  it('keeps a million-character chapter outside snapshots and round-trips validated backups with new ids', () => {
    const store = makeStore(); const p = store.createProject({ title: '长篇原文' }); const text = '白云缓缓过山谷。'.repeat(125000); const view = append(store, p.mainBranchId, text);
    expect(text.length).toBe(1000000); expect(JSON.stringify(view.state).length).toBeLessThan(2000);
    const backup = store.exportProject(p.id); const restored = store.restoreProject(backup); expect(restored.id).not.toBe(p.id); expect(restored.mainBranchId).not.toBe(p.mainBranchId); expect(store.exportText(restored.mainBranchId)).toContain(text);
    const damaged = structuredClone(backup) as any; damaged.chapters[0].text = null; const count = store.listProjects().length; expect(() => store.restoreProject(damaged)).toThrow('备份格式'); expect(store.listProjects()).toHaveLength(count);
    const broken = structuredClone(backup) as any; const brokenState = JSON.parse(gunzipSync(Buffer.from(broken.revisions[0].snapshot, 'base64')).toString()); brokenState.relations.push({ id: 'bad', fromId: 'missing', toId: 'missing', label: '关系', visibility: 'public' }); broken.revisions[0].snapshot = gzipSync(JSON.stringify(brokenState)).toString('base64'); expect(() => store.restoreProject(broken)).toThrow('无效资料关联'); expect(store.listProjects()).toHaveLength(count);
    expect(() => store.restoreProject(backup, {}, () => { throw new Error('原文恢复失败'); })).toThrow('原文恢复失败'); expect(store.listProjects()).toHaveLength(count);
  });
});

describe('durable writing and extraction jobs (simulated models)', () => {
  it('saves generated prose before extraction fails and retries only extraction', async () => {
    const store = makeStore(); const p = store.createProject({ title: '失败恢复' }); let calls = 0;
    const mock = models(async () => { if (++calls === 1) throw new Error('模拟提取断网'); const result = emptyExtraction(); result.entities.push(person('阿青', '抵达临江城', '阿青')); return result; }); const engine = engineFor(store, mock);
    const job = engine.enqueue(p.mainBranchId, 'generate', { baseRevisionId: store.getBranch(p.mainBranchId).revisionId, mode: 'original', instruction: '写开场' });
    expect((await terminal(engine, job.id)).status).toBe('failed'); const pending = store.state(p.mainBranchId); expect(pending.chapters).toHaveLength(1); expect(pending.chapters[0].status).toBe('pending'); expect(store.exportText(p.mainBranchId)).toContain('阿青走进临江城');
    expect(() => engine.enqueue(p.mainBranchId, 'generate', { baseRevisionId: store.getBranch(p.mainBranchId).revisionId, mode: 'original' })).toThrow('上一章');
    engine.action(job.id, 'retry'); expect((await terminal(engine, job.id)).status).toBe('completed');
    expect(mock.generateText).toHaveBeenCalledTimes(1); expect(calls).toBe(2); expect(store.state(p.mainBranchId).chapters).toHaveLength(1); expect(store.state(p.mainBranchId).entities).toHaveLength(1); expect(store.state(p.mainBranchId).chapters[0].id).toBe(pending.chapters[0].id);
  });

  it('discards a late result after cancellation and keeps a single active job per story', async () => {
    const store = makeStore(); const p = store.createProject({ title: '取消' }); const delayed = deferred<string>(); let started = false;
    const mock = models(undefined, async () => { started = true; return delayed.promise; }); const engine = engineFor(store, mock);
    const job = engine.enqueue(p.mainBranchId, 'generate', { baseRevisionId: store.getBranch(p.mainBranchId).revisionId, mode: 'original', instruction: '开始' });
    await until(() => started, Boolean);
    expect(() => engine.enqueue(p.mainBranchId, 'plan', { baseRevisionId: store.getBranch(p.mainBranchId).revisionId })).toThrow('已有');
    const revision = store.getBranch(p.mainBranchId).revisionId; engine.action(job.id, 'cancel'); delayed.resolve('迟到正文'); await new Promise(r => setTimeout(r, 30));
    expect(jobState(engine, job.id).status).toBe('cancelled'); expect(store.state(p.mainBranchId).chapters).toHaveLength(0); expect(store.getBranch(p.mainBranchId).revisionId).toBe(revision);
  });

  it('does not overwrite a newer manual change when a background result arrives', async () => {
    const store = makeStore(); const p = store.createProject({ title: '并发编辑' }); const delayed = deferred<string>(); let started = false;
    const engine = engineFor(store, models(undefined, async () => { started = true; return delayed.promise; }));
    const job = engine.enqueue(p.mainBranchId, 'generate', { baseRevisionId: store.getBranch(p.mainBranchId).revisionId, mode: 'original', instruction: '开场' }); await until(() => started, Boolean);
    const current = store.view(p.mainBranchId, true); const manual = store.updateOutline(p.mainBranchId, current.branch.revisionId, { ...current.state.outline, locked: '新设备已经编辑的设定' }); delayed.resolve('基于旧版本生成的正文');
    expect((await terminal(engine, job.id)).status).toBe('stale'); expect(store.state(p.mainBranchId).chapters).toHaveLength(0); expect(store.getBranch(p.mainBranchId).revisionId).toBe(manual.branch.revisionId);
  });

  it('resumes paused extraction from its last committed block, without repeating earlier blocks', async () => {
    const store = makeStore(); const p = store.createProject({ title: '片段进度' }); const text = '甲'.repeat(5000) + '\n' + '乙'.repeat(5000); const saved = store.saveChapter(p.mainBranchId, { baseRevisionId: store.getBranch(p.mainBranchId).revisionId, title: '长章节', text });
    const seen: number[] = []; let waiting = false;
    const mock = models(async request => { const block = Number(request.prompt.split('待整理章节').at(-1)!.match(/\[(\d+)\]/)![1]); seen.push(block); if (seen.length === 2) { waiting = true; await new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); } return emptyExtraction(); });
    const engine = engineFor(store, mock); const job = engine.enqueue(p.mainBranchId, 'extract', { baseRevisionId: saved.branch.revisionId }); await until(() => waiting, Boolean);
    expect(rawJob(store, job.id).payload.blockIndex).toBe(1); engine.action(job.id, 'pause'); await new Promise(r => setTimeout(r, 20)); expect(jobState(engine, job.id).status).toBe('paused');
    engine.action(job.id, 'resume'); expect((await terminal(engine, job.id)).status).toBe('completed'); expect(seen).toEqual([1, 2, 2]); expect(store.state(p.mainBranchId).chapters[0].status).toBe('ready');
  });

  it('recovers interrupted imports as paused jobs and restores their pending source chapters from backup', async () => {
    const store = makeStore(); const p = store.createProject({ title: '导入恢复' }); let waiting = false; let calls = 0;
    const mock = models(async request => { if (++calls === 2) { waiting = true; await new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); } return emptyExtraction(); });
    const engine = engineFor(store, mock); const job = engine.enqueue(p.mainBranchId, 'import', { baseRevisionId: store.getBranch(p.mainBranchId).revisionId, sourceId: 'original-source', chapters: [{ title: '一', text: '第一章原文' }, { title: '二', text: '第二章原文' }, { title: '三', text: '第三章原文' }] }); await until(() => waiting, Boolean);
    await engine.close(); await new Promise(r => setTimeout(r, 20));
    const replacement = engineFor(store, models()); expect(jobState(replacement, job.id).status).toBe('paused');
    const restored = store.restoreProject(store.exportProject(p.id), { 'original-source': 'restored-source' });
    const restoredJob = replacement.listJobs(restored.id)[0]; expect(restoredJob.status).toBe('paused'); expect(restoredJob.id).not.toBe(job.id); expect(rawJob(store, restoredJob.id).payload.sourceId).toBe('restored-source');
    replacement.action(restoredJob.id, 'resume'); expect((await terminal(replacement, restoredJob.id)).status).toBe('completed');
    expect(store.state(restored.mainBranchId).chapters).toHaveLength(3); expect(store.state(restored.mainBranchId).chapters.every(c => c.status === 'ready')).toBe(true); expect(store.exportText(restored.mainBranchId)).toContain('第三章原文');
    expect(store.state(p.mainBranchId).chapters).toHaveLength(2); expect(jobState(replacement, job.id).status).toBe('paused');
  });

  it('accounts for missing provider usage conservatively and preserves paid-for prose at the token limit', async () => {
    const store = makeStore(); const p = store.createProject({ title: '限额' }); const mock = models();
    mock.generateText = vi.fn(async () => ({ text: '阿青的新正文', inputTokens: 600000, outputTokens: 0 })); const engine = engineFor(store, mock);
    const job = engine.enqueue(p.mainBranchId, 'generate', { baseRevisionId: store.getBranch(p.mainBranchId).revisionId, mode: 'original', instruction: '写作' }); const done = await terminal(engine, job.id);
    expect(done.status).toBe('failed'); expect(done.error).toContain('用量上限'); expect(done.inputTokens).toBeGreaterThanOrEqual(600000); expect(done.outputTokens).toBeGreaterThan(0); expect(rawJob(store, job.id).payload.usageEstimated).toBe(true);
    expect(store.exportText(p.mainBranchId)).toContain('阿青的新正文'); expect(store.state(p.mainBranchId).chapters[0].status).toBe('pending');
  });
});
