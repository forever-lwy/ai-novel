import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractionContext, normalizeExtraction, splitExtractionBlocks } from '../server/extraction.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { Store } from '../server/store.js';
import { emptyState, type Settings } from '../shared/types.js';

const minimal = (fact: Record<string, unknown> = { text: '抵达灯塔', paragraph: 1 }): any => ({ summary: '林舟抵达灯塔。', entities: [{ kind: 'character', name: '林舟', facts: [fact] }] });
const normalize = (source: string, value: unknown) => normalizeExtraction(value, splitExtractionBlocks(source)[0]);

describe('deterministic extraction normalization', () => {
  it('fills exact local evidence and conservative optional fields without changing input', () => {
    const source = '林舟抵达灯塔。'; const input = minimal(); const original = structuredClone(input); const result = normalize(source, input);
    expect(result.issues).toEqual([]); expect(input).toEqual(original);
    expect(result.value?.entities[0]).toMatchObject({ aliases: [], description: '', visibility: 'secret', facts: [{ temporal: 'unknown', certainty: 'inference', visibility: 'secret', quote: source, paragraph: 1 }] });
    expect(result.value?.relations).toEqual([]); expect(result.value?.foreshadows).toEqual([]); expect(result.adjustments.some(change => change.path === 'entities[0].facts[0].quote')).toBe(true);
  });

  it('preserves explicit public/current facts and permits optional empty collections and descriptions', () => {
    const input = minimal({ text: '当前位于灯塔', paragraph: 1, temporal: 'current', certainty: 'fact', visibility: 'public', attribute: 'location' }); input.entities[0].visibility = 'public';
    const result = normalize('林舟抵达灯塔。', input); expect(result.value?.entities[0].visibility).toBe('public'); expect(result.value?.entities[0].facts[0]).toMatchObject({ temporal: 'current', certainty: 'fact', visibility: 'public', attribute: 'location' });
  });

  it.each([{}, { error: 'remote failure' }, { summary: '没有实体字段' }, { entities: [] }, { summary: 123, entities: [] }, { summary: '', entities: 'none' }])('rejects missing or invalid substantive top-level structure: %j', input => {
    const result = normalize('林舟抵达灯塔。', input); expect(result.value).toBeUndefined(); expect(result.issues.length).toBeGreaterThan(0);
  });

  it('rejects wrong enum values and collection types rather than dropping records or guessing intent', () => {
    const input = minimal({ text: '抵达灯塔', paragraph: 1, temporal: 'yesterday' }); input.entities[0].aliases = null; input.relations = {};
    const result = normalize('林舟抵达灯塔。', input); expect(result.value).toBeUndefined(); expect(result.issues.map(issue => issue.path)).toEqual(expect.arrayContaining(['entities[0].aliases', 'entities[0].facts[0].temporal', 'relations'])); expect(result.normalizedText).toContain('yesterday');
  });

  it('aligns a missing quote mark only when the current fragment has one compatible match', () => {
    const source = '记录员说：“灯塔运转正常。”随后关闭笔记。'; const requested = '记录员说：“灯塔运转正常。随后关闭笔记。';
    const result = normalize(source, minimal({ text: '灯塔正常', paragraph: 1, quote: requested }));
    expect(result.issues).toEqual([]); expect(result.value?.entities[0].facts[0].quote).toBe(source); expect(result.adjustments).toContainEqual(expect.objectContaining({ path: 'entities[0].facts[0].quote', quote: requested, sourceText: source }));
  });

  it('can locate a quote without a paragraph or correct a mistaken paragraph only by a unique local match', () => {
    const source = '林舟抵达灯塔。\n记录员打开笔记。';
    const noParagraph = normalize(source, minimal({ text: '打开笔记', quote: '记录员打开笔记。' })); expect(noParagraph.value?.entities[0].facts[0].paragraph).toBe(2);
    const wrongParagraph = normalize(source, minimal({ text: '打开笔记', paragraph: 99, quote: '记录员打开笔记。' })); expect(wrongParagraph.value?.entities[0].facts[0].paragraph).toBe(2); expect(wrongParagraph.adjustments.some(change => change.path.endsWith('.paragraph'))).toBe(true);
  });

  it('refuses changed words, changed punctuation and ambiguous quotation repairs', () => {
    expect(normalize('灯塔运转正常。', minimal({ text: '状态', paragraph: 1, quote: '灯塔运转故障。' })).value).toBeUndefined();
    expect(normalize('灯塔运转正常。', minimal({ text: '状态', paragraph: 1, quote: '灯塔运转正常！' })).value).toBeUndefined();
    const ambiguous = normalize('“灯塔正常。”\n“灯塔正常。”', minimal({ text: '状态', quote: '灯 塔 正 常。' })); expect(ambiguous.value).toBeUndefined(); expect(ambiguous.issues.some(issue => issue.message.includes('多个匹配'))).toBe(true);
  });

  it('preserves word boundaries and apostrophes while normalizing harmless repeated whitespace', () => {
    expect(normalize('The traveler is nowhere.', minimal({ text: '位置', paragraph: 1, quote: 'now here' })).value).toBeUndefined();
    expect(normalize('The traveler is now “here”.', minimal({ text: '位置', paragraph: 1, quote: 'nowhere' })).value).toBeUndefined();
    expect(normalize("The traveler can't leave.", minimal({ text: '状态', paragraph: 1, quote: 'cant leave' })).value).toBeUndefined();
    expect(normalize('The traveler can’t leave.', minimal({ text: '状态', paragraph: 1, quote: 'cant leave' })).value).toBeUndefined();
    expect(normalize('The traveler can’t leave.', minimal({ text: '状态', paragraph: 1, quote: "can't leave" })).value?.entities[0].facts[0].quote).toBe('can’t leave');
    const safe = normalize('The traveler reached New   York.', minimal({ text: '地点', paragraph: 1, quote: 'New York' })); expect(safe.value?.entities[0].facts[0].quote).toBe('New   York');
  });

  it('retains established block boundaries and fills only the visible slice of an oversized paragraph', () => {
    const source = '甲'.repeat(5500) + '后半段内容。' + '乙'.repeat(100); const blocks = splitExtractionBlocks(source);
    expect(blocks).toHaveLength(2); expect(blocks[0].start).toBe(1); expect(blocks[1].start).toBe(1); expect(blocks[0].text).toBe(`[1] ${'甲'.repeat(5500)}`);
    const first = normalizeExtraction(minimal(), blocks[0]); expect(first.value?.entities[0].facts[0].quote).toBe('甲'.repeat(5500)); expect(first.normalizedText).not.toContain('后半段内容');
    const outside = normalizeExtraction(minimal({ text: '越界', paragraph: 1, quote: '后半段内容。' }), blocks[0]); expect(outside.value).toBeUndefined();
    const second = normalizeExtraction(minimal(), blocks[1]); expect(second.value?.entities[0].facts[0].quote).toBe('后半段内容。' + '乙'.repeat(100));
  });

  it('rejects paragraph-only references outside the current block and collects all bad records', () => {
    const blocks = splitExtractionBlocks(`${'甲'.repeat(5400)}\n${'乙'.repeat(300)}`); const input = minimal({ text: '越界事实', paragraph: 2 }); input.relations = [{ from: '甲', to: '乙', label: '关联', paragraph: 99 }];
    const result = normalizeExtraction(input, blocks[0]); expect(result.value).toBeUndefined(); expect(result.issues.map(issue => issue.path)).toEqual(expect.arrayContaining(['entities[0].facts[0].paragraph', 'relations[0].paragraph'])); expect(result.normalizedText).toContain('越界事实');
  });

  it('builds a short extraction context without future plans, secret answers or source prose', () => {
    const state = emptyState(); state.outline = { coarse: '未来粗纲答案', locked: '未来锁定剧情', fine: [{ chapter: 1, title: '未来章名', goal: '未来细纲答案' }] };
    state.entities.push({ id: 'person', name: '林舟', aliases: ['旅人'], kind: 'character', description: '秘密描述', visibility: 'secret', locked: true, facts: [{ id: 'future', text: '未来身份真相', temporal: 'future', certainty: 'fact', visibility: 'secret' }] });
    state.foreshadows.push({ id: 'planned', title: '尚未埋设的秘密计划', detail: '未来答案', status: 'planned', revealCondition: '终章', relatedEntityIds: [] }, { id: 'planted', title: '灯塔线索', detail: '私密谜底', status: 'planted', revealCondition: '未来揭晓条件', relatedEntityIds: [] });
    const context = extractionContext(state, splitExtractionBlocks('旅人查看灯塔。')[0]); expect(context).toContain('林舟'); expect(context).toContain('旅人'); expect(context).toContain('灯塔线索');
    for (const secret of ['未来粗纲答案', '未来锁定剧情', '未来章名', '未来细纲答案', '秘密描述', '未来身份真相', '尚未埋设的秘密计划', '私密谜底', '未来揭晓条件']) expect(context).not.toContain(secret);
  });
});

const contexts: { store: Store; engine: StoryEngine }[] = [];
afterEach(async () => { for (const context of contexts.splice(0)) { await context.engine.close(); context.store.close(); } });
const settings: Settings = { providers: [{ id: 'fixture', name: '模拟', protocol: 'gemini', baseUrl: 'http://unused.invalid', model: 'fixture', maxOutputTokens: 4096, contextTokens: 64000 }], writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture' };
describe('normalized extraction persistence', () => {
  it('succeeds with paragraph-only output in one request and preserves original/normalized results in backups', async () => {
    let calls = 0; const raw = JSON.stringify(minimal()); const store = new Store(mkdtempSync(join(tmpdir(), 'ai-novel-normalize-'))); const project = store.createProject({ title: '中性片段' }); const saved = store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: '一', text: '林舟抵达灯塔。' });
    const models: TextModels = { generateText: async () => { throw new Error('不应写作'); }, generateStructured: async (_config, request, validate) => { calls++; request.onResponse?.({ rawResponse: raw, text: raw, inputTokens: 20, outputTokens: 30 }); return { value: validate(JSON.parse(raw)), inputTokens: 20, outputTokens: 30 }; } };
    const engine = new StoryEngine(store, () => settings, models); contexts.push({ store, engine }); engine.start(); const job = engine.enqueue(project.mainBranchId, 'extract', { baseRevisionId: saved.branch.revisionId });
    const deadline = Date.now() + 3000; while (Date.now() < deadline && !['completed', 'failed'].includes(engine.listJobs()[0].status)) await new Promise(resolve => setTimeout(resolve, 5));
    expect(engine.listJobs()[0].status).toBe('completed'); expect(calls).toBe(1); const summary = engine.listOutputs(job.id)[0]; expect(summary).not.toHaveProperty('normalizedText'); expect(summary).not.toHaveProperty('adjustments');
    const output = engine.outputDetail(job.id, summary.id).output; expect(output.rawResponse).toBe(raw); expect(output.text).toBe(raw); expect(output.normalizedText).toContain('林舟抵达灯塔。'); expect(output.adjustments?.length).toBeGreaterThan(0);
    const restored = store.restoreProject(store.exportProject(project.id)); const restoredJob = engine.listJobs(restored.id)[0]; const restoredOutput = engine.outputDetail(restoredJob.id, engine.listOutputs(restoredJob.id)[0].id).output; expect(restoredOutput.rawResponse).toBe(raw); expect(restoredOutput.normalizedText).toBe(output.normalizedText); expect(restoredOutput.adjustments).toEqual(output.adjustments);
  });
});
