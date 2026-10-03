import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractionContext, splitExtractionBlocks } from '../server/extraction.js';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { emptyState, type ExtractionResult, type Settings } from '../shared/types.js';

const stores: Store[] = [];
const engines: StoryEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const store of stores.splice(0)) store.close();
});
const extraction = (summary: string): ExtractionResult => ({ summary, entities: [], relations: [], foreshadows: [] });
function createStory() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ai-novel-extraction-timeline-'))); stores.push(store);
  const project = store.createProject({ title: '章节资料时间线', mode: 'continuation' });
  return { store, branchId: project.mainBranchId };
}
function append(store: Store, branchId: string, text: string, result: ExtractionResult, title = '章节') {
  const saved = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title, text });
  return store.applyExtraction(branchId, saved.branch.revisionId, saved.state.chapters.at(-1)!.id, result, true);
}
function traveler(text: string, quote: string, paragraph = 1, temporal: 'current' | 'past' | 'future' = 'current'): ExtractionResult['entities'][number] {
  return { kind: 'character', name: '林舟', aliases: [], description: '', visibility: 'public', facts: [{ text, attribute: 'location', quote, paragraph, temporal, certainty: 'fact', visibility: 'public' }] };
}
function clue(status: 'planted' | 'resolved'): ExtractionResult['foreshadows'][number] {
  return { title: '铜钥匙的来历', detail: status === 'resolved' ? '钥匙是旧塔守人留下的。' : '钥匙尚无人认领。', status, revealCondition: '', relatedNames: [] };
}

describe('extracted chapter summaries, clues and character location snapshots', () => {
  it('restores plot summaries, unresolved clues and the earlier location together when forking or rolling back', () => {
    const { store, branchId } = createStory();
    const first = extraction('林舟来到石桥镇，找到尚未认领的铜钥匙。');
    first.entities = [traveler('目前位于石桥镇', '林舟来到石桥镇。')]; first.foreshadows = [clue('planted')];
    const earlier = append(store, branchId, '林舟来到石桥镇。', first, '发现钥匙');
    const second = extraction('林舟来到灯塔，确认铜钥匙是旧塔守人留下的。');
    second.entities = [traveler('目前位于灯塔', '林舟来到灯塔。')]; second.foreshadows = [clue('resolved')];
    const latest = append(store, branchId, '林舟来到灯塔。', second, '答案揭晓');
    expect(latest.state.foreshadows[0]).toMatchObject({ status: 'resolved', resolvedChapterId: latest.state.chapters[1].id });
    expect(latest.state.entities[0].facts.filter(fact => fact.temporal === 'current')).toMatchObject([{ text: '目前位于灯塔' }]);

    const fork = store.fork(branchId, { baseRevisionId: latest.branch.revisionId, chapterId: earlier.state.chapters[0].id, name: '钥匙仍是谜团' });
    expect(fork.state.chapters.map(chapter => chapter.summary)).toEqual([first.summary]);
    expect(fork.state.foreshadows[0]).toMatchObject({ status: 'planted', plantedChapterId: earlier.state.chapters[0].id });
    expect(fork.state.foreshadows[0].resolvedChapterId).toBeUndefined();
    expect(fork.state.entities[0].facts.filter(fact => fact.temporal === 'current')).toMatchObject([{ text: '目前位于石桥镇' }]);
    expect(JSON.stringify(fork.state)).not.toContain('旧塔守人');
    expect(store.state(branchId)).toEqual(latest.state);

    const rollback = store.rollback(branchId, { baseRevisionId: latest.branch.revisionId, revisionId: earlier.branch.revisionId });
    expect(rollback.state).toEqual(earlier.state);
    expect(extractionContext(rollback.state, splitExtractionBlocks('旅人打开钥匙盒。')[0])).toContain('铜钥匙的来历');
  });

  it('keeps completed clues out of the latest extraction context, without exposing plans or hidden answers', () => {
    const state = emptyState();
    state.foreshadows = [
      { id: 'open', title: '未解开的纸条', detail: '隐藏谜底甲', status: 'planted', revealCondition: '终章', relatedEntityIds: [] },
      { id: 'resolved', title: '已查清的铜钥匙', detail: '隐藏谜底乙', status: 'resolved', relatedEntityIds: [], revealCondition: '' },
      { id: 'abandoned', title: '已放弃的暗门', detail: '', status: 'abandoned', relatedEntityIds: [], revealCondition: '' },
      { id: 'planned', title: '未来才埋下的线索', detail: '', status: 'planned', relatedEntityIds: [], revealCondition: '' },
    ];
    const context = extractionContext(state, splitExtractionBlocks('旅人查看纸条。')[0]);
    expect(context).toContain('未解开的纸条');
    for (const text of ['已查清的铜钥匙', '已放弃的暗门', '未来才埋下的线索', '隐藏谜底甲', '隐藏谜底乙']) expect(context).not.toContain(text);
  });

  it.each(['resolved', 'abandoned'] as const)('does not reopen a %s clue when a later fragment merely mentions its original mystery again', terminalStatus => {
    const { store, branchId } = createStory();
    const planted = extraction('林舟发现铜钥匙。'); planted.foreshadows = [clue('planted')];
    append(store, branchId, '林舟发现铜钥匙。', planted);
    const resolved = extraction('塔守人确认钥匙的来历。'); resolved.foreshadows = [{ ...clue('resolved'), status: terminalStatus }];
    const revealed = append(store, branchId, '塔守人确认钥匙的来历。', resolved);
    const mentioned = extraction('林舟想起最初发现钥匙时的疑问。'); mentioned.foreshadows = [clue('planted')];
    const latest = append(store, branchId, '林舟想起最初发现钥匙时的疑问。', mentioned);
    expect(latest.state.foreshadows).toHaveLength(1);
    expect(latest.state.foreshadows[0].status).toBe(terminalStatus);
    expect(latest.state.foreshadows[0].resolvedChapterId).toBe(terminalStatus === 'resolved' ? revealed.state.chapters.at(-1)!.id : undefined);
    expect(extractionContext(latest.state, splitExtractionBlocks('旅人继续前行。')[0])).not.toContain('铜钥匙的来历');
  });

  it('uses original paragraph order for the latest location even when the model returns facts in reverse order', () => {
    const { store, branchId } = createStory();
    const result = extraction('林舟先到石桥镇，再抵达灯塔。');
    const entity = traveler('目前位于灯塔', '林舟抵达灯塔。', 2);
    entity.facts.push(...traveler('目前位于石桥镇', '林舟先到石桥镇。', 1).facts); result.entities = [entity];
    const view = append(store, branchId, '林舟先到石桥镇。\n林舟抵达灯塔。', result);
    expect(view.state.entities[0].facts.filter(fact => fact.temporal === 'current')).toMatchObject([{ text: '目前位于灯塔', citation: { paragraph: 2 } }]);
    expect(view.state.entities[0].facts.find(fact => fact.citation?.paragraph === 1)?.temporal).toBe('past');
  });

  it('keeps one current location across a return, memories, plans and unrelated new facts', () => {
    const { store, branchId } = createStory();
    for (const place of ['石桥镇', '灯塔', '石桥镇']) {
      const text = `林舟抵达${place}。`; const result = extraction(text); result.entities = [traveler(`目前位于${place}`, text)];
      append(store, branchId, text, result);
    }
    const recollection = extraction('林舟回想旧居并打算去王城，拿出自己的地图。');
    const remembered = traveler('从前住在海城', '林舟想起从前住在海城。', 1, 'past');
    remembered.facts.push(...traveler('明年计划前往王城', '林舟计划明年去王城。', 2, 'future').facts);
    remembered.facts.push({ text: '随身携带地图', quote: '林舟拿出地图。', paragraph: 3, temporal: 'current', certainty: 'fact', visibility: 'public' });
    recollection.entities = [remembered];
    const view = append(store, branchId, '林舟想起从前住在海城。\n林舟计划明年去王城。\n林舟拿出地图。', recollection);
    const facts = view.state.entities[0].facts;
    expect(facts.filter(fact => fact.attribute === 'location' && fact.temporal === 'current')).toMatchObject([{ text: '目前位于石桥镇' }]);
    expect(facts.filter(fact => fact.attribute === 'location' && fact.temporal === 'past').map(fact => fact.text)).toEqual(expect.arrayContaining(['目前位于灯塔', '目前位于石桥镇', '从前住在海城']));
    expect(facts.find(fact => fact.text === '明年计划前往王城')?.temporal).toBe('future');
    expect(facts.find(fact => fact.text === '随身携带地图')?.temporal).toBe('current');
  });

  it('uses extracted plot summaries for continuation while retaining separately authored future plans', async () => {
    const { store, branchId } = createStory();
    const first = extraction('林舟在石桥镇发现铜钥匙，因此前往灯塔寻找塔守人。');
    const second = extraction('塔守人说明钥匙属于旧塔，林舟因此决定寻找失踪的守塔者。');
    let writingPrompt = ''; let extractionIndex = 0;
    const models: TextModels = {
      generateText: async (_provider, request) => { writingPrompt = request.prompt; return { text: '林舟离开灯塔。', inputTokens: 10, outputTokens: 20 }; },
      generateStructured: async (_provider, _request, validate) => ({ value: validate([first, second, extraction('林舟离开灯塔继续追查。')][extractionIndex++]), inputTokens: 10, outputTokens: 20 }),
    };
    const settings: Settings = { providers: [{ id: 'fixture', name: '模拟模型', protocol: 'gemini', baseUrl: 'http://unused.invalid', model: 'fixture', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture' };
    const engine = new StoryEngine(store, () => settings, models); engines.push(engine); engine.start();
    const waitForJob = async (id: string) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !['completed', 'failed'].includes(engine.listJobs().find(item => item.id === id)!.status)) await new Promise(resolve => setTimeout(resolve, 5));
      expect(engine.listJobs().find(item => item.id === id)!.status).toBe('completed');
    };
    const importJob = engine.enqueue(branchId, 'import', { baseRevisionId: store.getBranch(branchId).revisionId, sourceId: 'fixture-source', chapters: [{ title: '起因', text: '林舟发现铜钥匙。' }, { title: '转折', text: '塔守人说明钥匙的来历。' }] });
    await waitForJob(importJob.id);
    const imported = store.view(branchId, true);
    expect(imported.state.chapters.map(chapter => chapter.summary)).toEqual([first.summary, second.summary]);
    expect(imported.state.chapters.every(chapter => chapter.sourceId === 'fixture-source')).toBe(true);
    const plan = { coarse: '作者计划让林舟继续追查旧塔。', locked: '不能复活。', fine: [3, 4, 5, 6].map(chapter => ({ chapter, title: `规划第${chapter}章`, goal: '追查旧塔' })) };
    const planned = store.updateOutline(branchId, imported.branch.revisionId, plan);
    expect(planned.state.chapters.map(chapter => chapter.summary)).toEqual([first.summary, second.summary]);
    expect(planned.state.outline).toEqual(plan);
    const job = engine.enqueue(branchId, 'generate', { baseRevisionId: planned.branch.revisionId, mode: 'continuation', instruction: '接着写' });
    await waitForJob(job.id);
    expect(writingPrompt).toContain(first.summary); expect(writingPrompt).toContain(second.summary); expect(writingPrompt).toContain(plan.coarse);
    expect(store.view(branchId).state.chapters.every(chapter => !chapter.summary)).toBe(true);
  });
});
