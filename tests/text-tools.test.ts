import { describe, expect, it } from 'vitest';
import { buildWritingContext } from '../server/writing-context.js';
import { emptyState, type Chapter, type ChapterRef, type Entity, type OriginalReferenceData, type StoryState } from '../shared/types.js';

type Collection = 'story' | 'original';
type TextFile = { path: string; collection: Collection; reference: boolean; source: boolean; title: string; chapterId?: string; sourceId?: string; sourceFilename?: string; totalLines: number };
type TextLine = { line: number; text: string; startOffset?: number; endOffset?: number; truncated?: boolean };
type FileList = { files: TextFile[]; total: number; offset: number; nextOffset?: number; truncated: boolean; error?: string };
type TextRead = TextFile & { lines: TextLine[]; startLine: number; endLine: number; truncated: boolean; nextLine?: number; nextOffset?: number; error?: string };
type TextSearch = { matches: (TextFile & { line: number; text: string; hitColumn: number; startOffset: number; endOffset: number; context: TextLine[]; truncated?: boolean })[]; total: number; offset: number; nextOffset?: number; truncated: boolean; error?: string };
type StorySearch = { entities: (Pick<Entity, 'id' | 'name' | 'description'> & { collection: Collection; reference: boolean })[]; chapters: { chapterId: string; path?: string; source?: boolean; title: string; summary: string; collection: Collection; reference: boolean }[]; error?: string };

const entity = (id: string, name: string, description: string, extra: Partial<Entity> = {}): Entity => ({ id, name, description, kind: 'character', aliases: [], visibility: 'public', locked: false, facts: [], ...extra });
const chapter = (id: string, title: string, text: string, summary = title): Chapter => ({ id, title, text, summary, status: 'ready', createdAt: '' });
const chapterRef = ({ text: _text, ...value }: Chapter): ChapterRef => value;

function fixture() {
  const state = emptyState();
  state.outline.worldview = '当前体验线的港口仍然开放。';
  state.entities = [
    entity('shared-person', '林舟', '当前线林舟留守城门。', { isMain: true, facts: [{ id: 'current-future', text: '当前线尚未发生的登基', temporal: 'future', certainty: 'fact', visibility: 'secret' }] }),
    entity('story-person', '青霜', '使用火焰。', { aliases: ['Current Guide'] }),
    entity('scattered-words', 'West 使者', '准备离开 Gate。'),
  ];
  const storyChapters = [
    chapter('shared-chapter', 'West Gate', '  当前林舟守在 West Gate。\r\n\r\n青霜举起 Compass。\r\n最后一行。\r\n', '当前线林舟守住城门。'),
    chapter('story-second', '港口新路', '当前线独有的火焰。\n这条路通向海边。', '当前线的新路线。'),
  ];
  state.chapters = storyChapters.map(chapterRef);
  const texts = new Map(storyChapters.map(value => [value.id, value.text]));
  const originalState: StoryState = emptyState();
  originalState.outline.worldview = '原作世界每十年发生一次长夜。';
  originalState.entities = [
    entity('shared-person', '林舟', '原作林舟后来远赴北方。', { aliases: ['Old North Port'], facts: [{ id: 'original-future', text: '原作终章继承王位', temporal: 'future', certainty: 'fact', visibility: 'secret' }] }),
    entity('original-person', '夜祭司', '完整原作档案按需读取的独有细节。', { visibility: 'secret' }),
  ];
  const originalChapters = [
    chapter('shared-chapter', '原作岔路', '原作林舟离开旧港。\n\n原作独有的归乡线索。', '原作林舟离港。'),
    chapter('original-second', '后来的长夜', '夜祭司在后来登场。\n原作独有的火焰。', '原作后半部夜祭司揭晓秘密。'),
    chapter('original-third', '原作终章', '原作林舟继承王位。', '原作结局由林舟继承王位。'),
  ];
  originalState.chapters = originalChapters.map(chapterRef);
  const original: OriginalReferenceData = {
    reference: { branchId: 'original-branch', revisionId: 'original-revision', sourceIds: ['source-one', 'source-two'] },
    state: originalState,
    chapters: originalChapters,
    sources: [
      { sourceId: 'source-one', filename: '原始稿.txt', chapters: [{ title: '底稿开场', text: '原始稿的第一行。\r\n\r\nＣＯＭＰＡＳＳ 仍在旧港。\r\n末行。\r\n' }, { title: '底稿火焰', text: '底稿独有的火焰。' }] },
      { sourceId: 'source-two', filename: '附录.txt', chapters: [{ title: '附录终章', text: '原始附录的未来秘密。' }] },
    ],
  };
  const context = buildWritingContext({ state, chapterText: id => texts.get(id)!, original });
  return { state, texts, original, context };
}

async function call<T>(context: ReturnType<typeof buildWritingContext>, name: string, args: Record<string, unknown>): Promise<T> {
  const tool = context.tools.find(value => value.name === name);
  expect(tool, `${name} should be available`).toBeDefined();
  const result = await tool!.execute(args) as T & { error?: string };
  expect(result.error).toBeUndefined();
  return result;
}

const pageText = (value: TextRead) => value.lines.map(line => line.text).join('\n');

function longContext(text: string) {
  const state = emptyState();
  state.chapters = [chapterRef(chapter('long-chapter', '长章节', text))];
  return buildWritingContext({ state, chapterText: () => text });
}

it('bounds the default original dossier directory while keeping later entries and omitted aliases searchable', async () => {
  const { state, texts, original } = fixture();
  original.state.entities = Array.from({ length: 200 }, (_, index) => entity(`future-${index}`, `星钥${index}`, '完整物品资料', {
    kind: 'item', aliases: ['旧名一', '旧名二', '旧名三', `目录外别名${index}`],
  }));
  const context = buildWritingContext({ state, chapterText: id => texts.get(id)!, original });
  const reference = JSON.parse(context.variables.originalReference);
  expect(reference.entityDirectory).toHaveLength(100);
  expect(reference).toMatchObject({ entityDirectoryTotal: 200, entityDirectoryTruncated: true });
  expect(reference.entityDirectory[0]).toMatchObject({ aliasesTruncated: true });
  expect(context.variables.originalReference).not.toContain('"name":"星钥199"');
  expect(await call<StorySearch>(context, 'search_story', { collection: 'original', scope: 'entities', keywords: ['星钥199'] })).toMatchObject({ entities: [{ id: 'future-199' }] });
  expect(await call<StorySearch>(context, 'search_story', { collection: 'original', scope: 'entities', keywords: ['目录外别名199'] })).toMatchObject({ entities: [{ id: 'future-199' }] });
  expect(await call(context, 'read_entity', { collection: 'original', id: 'future-199' })).toMatchObject({ entity: { description: '完整物品资料', aliases: ['旧名一', '旧名二', '旧名三', '目录外别名199'] } });
});

it('accepts captured snapshot paths in the legacy chapter reader while retaining collection isolation', async () => {
  const { context } = fixture();
  expect(await call(context, 'read_chapter', { chapterId: 'original/000002.txt', collection: 'original', startLine: 1, endLine: 1 })).toMatchObject({ text: '夜祭司在后来登场。', path: 'original/000002.txt', reference: true });
  expect(await call(context, 'read_chapter', { chapterId: 'story/000001.txt', startParagraph: 2, endParagraph: 2 })).toMatchObject({ text: '青霜举起 Compass。', reference: false });
  expect(await context.tools.find(tool => tool.name === 'read_chapter')!.execute({ chapterId: 'original/000002.txt', collection: 'story' })).toMatchObject({ error: expect.any(String) });
});

describe('original reference separated from the active story', () => {
  it('includes complete original summaries and a lightweight entity directory as author reference', () => {
    const { context, original } = fixture();
    const material = JSON.parse(context.text.split('\n')[1]);
    expect(material.originalReference).toMatchObject({ reference: original.reference, worldview: original.state.outline.worldview });
    expect(material.originalReference.notice).toContain('作者参考');
    expect(material.originalReference.notice).toContain('不能视为当前故事线已发生的事实');
    expect(JSON.parse(context.variables.originalReference)).toEqual(material.originalReference);
    expect(context.text).toContain('originalReference');
    expect(context.text).toContain(original.state.outline.worldview);
    for (const value of original.chapters) expect(context.text).toContain(value.summary);
    expect(context.text).toContain('夜祭司');
    expect(context.text).not.toContain('完整原作档案按需读取的独有细节。');
    expect(context.text).not.toContain('原作独有的归乡线索。');
    expect(context.text).not.toContain('原始附录的未来秘密。');
    expect(context.text).not.toContain('当前线尚未发生的登基');
    expect(context.variables.worldview).toBe('当前体验线的港口仍然开放。');
    expect(context.variables.mainCharacters).toContain('当前线林舟留守城门。');
    expect(context.variables.mainCharacters).not.toContain('原作林舟后来远赴北方。');
  });

  it('uses valid author-confirmed original compression while preserving uncovered summaries and full summary lookup', async () => {
    const { state, texts, original } = fixture();
    const coveredIds = original.state.chapters.slice(0, 2).map(chapter => chapter.id);
    original.state.outline.summaryCompression = { text: '作者确认：林舟离港，夜祭司在长夜揭开秘密。', chapterIds: coveredIds };
    const context = buildWritingContext({ state, chapterText: id => texts.get(id)!, original });
    const reference = JSON.parse(context.variables.originalReference);
    expect(reference.authorConfirmedSummary).toEqual(original.state.outline.summaryCompression);
    expect(reference.completePlotSummaries).toEqual([{ chapterId: original.state.chapters[2].id, title: original.state.chapters[2].title, summary: original.state.chapters[2].summary }]);
    expect(context.text).toContain(original.state.outline.summaryCompression.text);
    for (const chapter of original.state.chapters.slice(0, 2)) expect(context.text).not.toContain(chapter.summary);
    const search = await call<StorySearch>(context, 'search_story', { collection: 'original', keywords: [original.state.chapters[0].summary] });
    expect(search.chapters).toContainEqual(expect.objectContaining({ chapterId: coveredIds[0], summary: original.state.chapters[0].summary }));
    expect(JSON.parse(context.variables.plotSummaries).completePlotSummaries).toHaveLength(state.chapters.length);
  });

  it('falls back to complete original summaries when compression covers a chapter removed from the captured snapshot', () => {
    const { state, texts, original } = fixture();
    const removedId = original.state.chapters[1].id;
    original.state.outline.summaryCompression = { text: '已过期的原作确认摘要', chapterIds: [original.state.chapters[0].id, removedId] };
    original.state.chapters = original.state.chapters.filter(chapter => chapter.id !== removedId);
    // The supplied chapter table may still contain this older row; it cannot extend the reference boundary.
    expect(original.chapters.some(chapter => chapter.id === removedId)).toBe(true);
    const context = buildWritingContext({ state, chapterText: id => texts.get(id)!, original });
    const reference = JSON.parse(context.variables.originalReference);
    expect(reference).not.toHaveProperty('authorConfirmedSummary');
    expect(reference.completePlotSummaries.map((chapter: { summary: string }) => chapter.summary)).toEqual(original.state.chapters.map(chapter => chapter.summary));
    expect(context.text).not.toContain('已过期的原作确认摘要');
    for (const chapter of original.state.chapters) expect(context.text).toContain(chapter.summary);
    original.state.outline.summaryCompression = { text: ' \n\t ', chapterIds: original.state.chapters.map(chapter => chapter.id) };
    const blank = JSON.parse(buildWritingContext({ state, chapterText: id => texts.get(id)!, original }).variables.originalReference);
    expect(blank).not.toHaveProperty('authorConfirmedSummary');
    expect(blank.completePlotSummaries).toHaveLength(original.state.chapters.length);
  });

  it('searches both collections by default with original reference markers and honors an explicit collection', async () => {
    const { context } = fixture();
    const both = await call<StorySearch>(context, 'search_story', { keywords: ['林舟', '夜祭司'] });
    expect(both.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'shared-person', collection: 'story', reference: false }),
      expect.objectContaining({ id: 'shared-person', collection: 'original', reference: true }),
      expect.objectContaining({ id: 'original-person', collection: 'original', reference: true }),
    ]));
    const story = await call<StorySearch>(context, 'search_story', { keywords: ['林舟', '夜祭司'], collection: 'story' });
    expect(story.entities).toHaveLength(1);
    expect(story.entities[0]).toMatchObject({ id: 'shared-person', collection: 'story', reference: false });
    expect(story.chapters.every(value => value.collection === 'story' && !value.reference)).toBe(true);
    const original = await call<StorySearch>(context, 'search_story', { keywords: ['夜祭司'], collection: 'original' });
    expect(original.entities).toMatchObject([{ id: 'original-person', collection: 'original', reference: true }]);
    expect(original.chapters).toEqual(expect.arrayContaining([expect.objectContaining({ chapterId: 'original-second', collection: 'original', reference: true })]));
  });

  it('defaults duplicate entity and chapter IDs to story while original remains explicitly readable', async () => {
    const { context, texts, original } = fixture();
    expect(await call(context, 'read_entity', { id: 'shared-person' })).toMatchObject({ entity: { description: '当前线林舟留守城门。' } });
    expect(await call(context, 'read_entity', { id: 'shared-person', collection: 'original' })).toMatchObject({ entity: { description: '原作林舟后来远赴北方。' }, reference: true });
    expect(await call(context, 'read_chapter', { chapterId: 'shared-chapter' })).toMatchObject({ text: texts.get('shared-chapter') });
    expect(await call(context, 'read_chapter', { chapterId: 'shared-chapter', collection: 'original' })).toMatchObject({ text: original.chapters[0].text, reference: true });
  });

  it('preserves old full chapter reads when no range is provided, including a chapter beyond the text-page budget', async () => {
    const text = '一整章原文。'.repeat(5000);
    const context = longContext(text);
    expect(await call(context, 'read_chapter', { chapterId: 'long-chapter' })).toMatchObject({ chapterId: 'long-chapter', text });
    const search = await call<StorySearch>(context, 'search_story', { query: '原文' });
    expect(search.chapters).toEqual([{ chapterId: 'long-chapter', title: '长章节', summary: '长章节' }]);
  });

  it('captures story, original state, snapshot prose and raw sources before later changes', async () => {
    const { context, state, texts, original } = fixture();
    state.entities[0].description = '稍后修改当前资料';
    state.chapters[0].title = '稍后修改当前标题';
    texts.set('shared-chapter', '稍后修改当前正文');
    original.state.entities[0].description = '稍后修改原作资料';
    original.state.chapters[0].summary = '稍后修改原作摘要';
    original.chapters[0].text = '稍后修改原作正文';
    original.sources[0].filename = '稍后修改文件名';
    original.sources[0].chapters[0].text = '稍后修改底稿';
    original.sources.push({ sourceId: 'later-source', filename: '后来.txt', chapters: [{ title: '稍后新文件', text: '稍后新文件' }] });
    expect(await call(context, 'read_entity', { id: 'shared-person' })).toMatchObject({ entity: { description: '当前线林舟留守城门。' } });
    expect(await call(context, 'read_entity', { id: 'shared-person', collection: 'original' })).toMatchObject({ entity: { description: '原作林舟后来远赴北方。' } });
    expect(await call(context, 'read_chapter', { chapterId: 'shared-chapter' })).toMatchObject({ text: expect.stringContaining('当前林舟守在 West Gate') });
    expect(pageText(await call<TextRead>(context, 'read_text_file', { path: 'original/000001.txt' }))).toContain('原作独有的归乡线索');
    expect(pageText(await call<TextRead>(context, 'read_text_file', { path: 'original/sources/0001/000001.txt' }))).toContain('ＣＯＭＰＡＳＳ 仍在旧港');
    const files = await call<FileList>(context, 'list_text_files', { collection: 'all', offset: 0, limit: 20 });
    expect(files.total).toBe(8);
    expect(JSON.stringify(files)).not.toContain('稍后');
    const search = await call<TextSearch>(context, 'search_text', { query: '稍后', collection: 'all' });
    expect(search.matches).toEqual([]);
    const storySearch = await call<StorySearch>(context, 'search_story', { query: '稍后', collection: 'all' });
    expect(storySearch.entities).toEqual([]);
    expect(storySearch.chapters).toEqual([]);
  });

  it('makes unprocessed future source text discoverable and readable through the legacy story tools', async () => {
    const { context, original } = fixture();
    const result = await call<StorySearch>(context, 'search_story', { keywords: ['原始附录的未来秘密'] });
    expect(result.entities).toEqual([]);
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters).toMatchObject([{
      chapterId: 'original/sources/0002/000001.txt', path: 'original/sources/0002/000001.txt',
      source: true, collection: 'original', reference: true, title: '附录终章', summary: '',
    }]);
    expect(await call(context, 'read_chapter', { chapterId: result.chapters[0].chapterId })).toMatchObject({ text: original.sources[1].chapters[0].text, source: true, collection: 'original', reference: true });
    expect(await call<StorySearch>(context, 'search_story', { query: '原始附录的未来秘密', collection: 'story' })).toMatchObject({ chapters: [] });
    const rawLines = await call<{ text: string; source: boolean; startLine: number; endLine: number }>(context, 'read_chapter', { chapterId: 'original/sources/0001/000001.txt', collection: 'original', startLine: 2, endLine: 4 });
    expect(rawLines).toMatchObject({ text: '\nＣＯＭＰＡＳＳ 仍在旧港。\n末行。', source: true, startLine: 2, endLine: 4 });
    expect(await call(context, 'read_chapter', { chapterId: 'original/sources/0001/000001.txt', startParagraph: 2, endParagraph: 2 })).toMatchObject({ text: 'ＣＯＭＰＡＳＳ 仍在旧港。', source: true, startParagraph: 2, endParagraph: 2 });
  });

  it('keeps duplicate snapshot and source hits separate and marks source provenance', async () => {
    const { state, texts, original } = fixture();
    const text = '原作和底稿共有的检索细节。';
    original.chapters[0].text = text;
    original.sources[0].chapters[0] = { title: original.chapters[0].title, text };
    const context = buildWritingContext({ state, chapterText: id => texts.get(id)!, original });
    const result = await call<StorySearch>(context, 'search_story', { query: '共有的检索细节', collection: 'original', scope: 'chapters' });
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters[0]).toMatchObject({ chapterId: 'shared-chapter', path: 'original/000001.txt', collection: 'original', reference: true });
    expect(result.chapters[0].source).not.toBe(true);
    expect(result.chapters[1]).toMatchObject({ chapterId: 'original/sources/0001/000001.txt', path: 'original/sources/0001/000001.txt', collection: 'original', reference: true, source: true, summary: '' });
    expect(await call(context, 'read_chapter', { chapterId: result.chapters[0].chapterId, collection: 'original' })).toMatchObject({ text });
    expect(await call(context, 'read_chapter', { chapterId: result.chapters[1].chapterId })).toMatchObject({ text, source: true });
  });
});

describe('virtual text files and bounded reads', () => {
  it('uses stable numbered paths and distinguishes active prose, original snapshots and source text', async () => {
    const { context } = fixture();
    const result = await call<FileList>(context, 'list_text_files', { collection: 'all', offset: 0, limit: 20 });
    expect(result).toMatchObject({ total: 8, offset: 0, truncated: false });
    expect(result.files.map(value => value.path)).toEqual([
      'story/000001.txt', 'story/000002.txt',
      'original/000001.txt', 'original/000002.txt', 'original/000003.txt',
      'original/sources/0001/000001.txt', 'original/sources/0001/000002.txt', 'original/sources/0002/000001.txt',
    ]);
    expect(result.files[0]).toMatchObject({ collection: 'story', reference: false, source: false, chapterId: 'shared-chapter', title: 'West Gate', totalLines: 5 });
    expect(result.files[2]).toMatchObject({ collection: 'original', reference: true, source: false, chapterId: 'shared-chapter', title: '原作岔路' });
    expect(result.files[5]).toMatchObject({ collection: 'original', reference: true, source: true, sourceId: 'source-one', sourceFilename: '原始稿.txt', title: '底稿开场', totalLines: 5 });
  });

  it('paginates a filtered file list without losing its total and searches titles or filenames', async () => {
    const { context } = fixture();
    const first = await call<FileList>(context, 'list_text_files', { collection: 'original', offset: 0, limit: 2 });
    expect(first).toMatchObject({ total: 6, offset: 0, nextOffset: 2, truncated: true });
    const second = await call<FileList>(context, 'list_text_files', { collection: 'original', offset: first.nextOffset, limit: 2 });
    const last = await call<FileList>(context, 'list_text_files', { collection: 'original', offset: second.nextOffset, limit: 2 });
    expect(last).toMatchObject({ total: 6, offset: 4, truncated: false });
    expect(last.nextOffset).toBeUndefined();
    expect([...first.files, ...second.files, ...last.files].map(value => value.path)).toHaveLength(6);
    expect(new Set([...first.files, ...second.files, ...last.files].map(value => value.path)).size).toBe(6);
    const byFilename = await call<FileList>(context, 'list_text_files', { collection: 'all', query: '原始稿', offset: 0, limit: 10 });
    expect(byFilename.files.map(value => value.path)).toEqual(['original/sources/0001/000001.txt', 'original/sources/0001/000002.txt']);
    const byTitle = await call<FileList>(context, 'list_text_files', { collection: 'all', query: 'ｗｅｓｔ　ｇａｔｅ', offset: 0, limit: 10 });
    expect(byTitle.files.map(value => value.path)).toEqual(['story/000001.txt']);
    const pastEnd = await call<FileList>(context, 'list_text_files', { collection: 'original', offset: 50, limit: 2 });
    expect(pastEnd).toMatchObject({ files: [], total: 6, offset: 50, truncated: false });
  });

  it('preserves whitespace and blank lines while numbering CRLF text from one', async () => {
    const { context } = fixture();
    const result = await call<TextRead>(context, 'read_text_file', { path: 'story/000001.txt' });
    expect(result).toMatchObject({ path: 'story/000001.txt', collection: 'story', reference: false, source: false, totalLines: 5, startLine: 1, endLine: 5, truncated: false });
    expect(result.lines.map(value => ({ line: value.line, text: value.text }))).toEqual([
      { line: 1, text: '  当前林舟守在 West Gate。' }, { line: 2, text: '' },
      { line: 3, text: '青霜举起 Compass。' }, { line: 4, text: '最后一行。' }, { line: 5, text: '' },
    ]);
    expect(pageText(result)).toBe('  当前林舟守在 West Gate。\n\n青霜举起 Compass。\n最后一行。\n');
    expect(result).not.toHaveProperty('text');
    expect(result.nextLine).toBeUndefined();
    const source = await call<TextRead>(context, 'read_text_file', { path: 'original/sources/0001/000001.txt', startLine: 2, endLine: 4 });
    expect(source).toMatchObject({ collection: 'original', reference: true, source: true, totalLines: 5, startLine: 2, endLine: 4 });
    expect(source.lines.map(value => value.text)).toEqual(['', 'ＣＯＭＰＡＳＳ 仍在旧港。', '末行。']);
  });

  it('limits default reads to two hundred lines and allows resuming at the next line', async () => {
    const text = Array.from({ length: 235 }, (_, index) => `第${index + 1}行`).join('\n');
    const context = longContext(text);
    const first = await call<TextRead>(context, 'read_text_file', { path: 'story/000001.txt' });
    expect(first).toMatchObject({ totalLines: 235, startLine: 1, endLine: 200, truncated: true, nextLine: 201 });
    expect(first.lines).toHaveLength(200);
    const second = await call<TextRead>(context, 'read_text_file', { path: 'story/000001.txt', startLine: first.nextLine });
    expect(second).toMatchObject({ totalLines: 235, startLine: 201, endLine: 235, truncated: false });
    expect(second.lines).toHaveLength(35);
    expect([...first.lines, ...second.lines].map(value => value.text).join('\n')).toBe(text);
  });

  it('returns explicit continuation offsets for a long line so no characters disappear between pages', async () => {
    const text = `${'甲'.repeat(25000)}长行终点`;
    const context = longContext(text);
    const first = await call<TextRead>(context, 'read_text_file', { path: 'story/000001.txt' });
    expect(first).toMatchObject({ totalLines: 1, startLine: 1, endLine: 1, truncated: true, nextLine: 1 });
    expect(pageText(first).length).toBeLessThanOrEqual(20000);
    expect(first.lines[0]).toMatchObject({ line: 1, startOffset: 0, truncated: true });
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(first.lines[0].endOffset).toBe(first.nextOffset);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(20000);
    const second = await call<TextRead>(context, 'read_text_file', { path: 'story/000001.txt', startLine: first.nextLine, startOffset: first.nextOffset });
    expect(second).toMatchObject({ totalLines: 1, startLine: 1, endLine: 1, truncated: false });
    expect(second.lines[0].startOffset).toBe(first.nextOffset);
    expect(pageText(first) + pageText(second)).toBe(text);
    expect(second.nextLine).toBeUndefined();
    expect(second.nextOffset).toBeUndefined();
    expect(JSON.stringify(second).length).toBeLessThanOrEqual(20000);
  });

  it('keeps the character budget across several lines and reports the remaining position', async () => {
    const text = `${'甲'.repeat(12000)}\n${'乙'.repeat(12000)}\n末行`;
    const context = longContext(text);
    const first = await call<TextRead>(context, 'read_text_file', { path: 'story/000001.txt' });
    expect(pageText(first).length).toBeLessThanOrEqual(20000);
    expect(first.truncated).toBe(true);
    expect(first.nextLine).toBeDefined();
    const second = await call<TextRead>(context, 'read_text_file', { path: 'story/000001.txt', startLine: first.nextLine, ...(first.nextOffset === undefined ? {} : { startOffset: first.nextOffset }) });
    expect(pageText(second).length).toBeLessThanOrEqual(20000);
    const joined = pageText(first) + (first.nextOffset ? '' : '\n') + pageText(second);
    expect(joined).toBe(text);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(20000);
    expect(JSON.stringify(second).length).toBeLessThanOrEqual(20000);
  });

  it('reads line ranges and paragraph ranges without treating empty lines as paragraphs', async () => {
    const { context } = fixture();
    const lines = await call<{ text: string }>(context, 'read_chapter', { chapterId: 'shared-chapter', startLine: 2, endLine: 4 });
    expect(lines.text).toBe('\n青霜举起 Compass。\n最后一行。');
    const paragraphs = await call<{ text: string }>(context, 'read_chapter', { chapterId: 'shared-chapter', startParagraph: 2, endParagraph: 3 });
    expect(paragraphs.text).toBe('青霜举起 Compass。\n最后一行。');
    const original = await call<{ text: string; reference: boolean }>(context, 'read_chapter', { chapterId: 'shared-chapter', collection: 'original', startParagraph: 2, endParagraph: 2 });
    expect(original).toMatchObject({ text: '原作独有的归乡线索。', reference: true });
  });

  it('caps requested chapter ranges at two hundred lines or paragraphs with an explicit continuation', async () => {
    const text = Array.from({ length: 240 }, (_, index) => `段落${index + 1}`).join('\n\n');
    const context = longContext(text);
    const lines = await call<{ text: string; startLine: number; endLine: number; truncated: boolean; nextLine: number }>(context, 'read_chapter', { chapterId: 'long-chapter', startLine: 1, endLine: 479 });
    expect(lines).toMatchObject({ startLine: 1, endLine: 200, truncated: true, nextLine: 201 });
    expect(lines.text.split('\n')).toHaveLength(200);
    const paragraphs = await call<{ text: string; startParagraph: number; endParagraph: number; truncated: boolean; nextParagraph: number }>(context, 'read_chapter', { chapterId: 'long-chapter', startParagraph: 1, endParagraph: 240 });
    expect(paragraphs).toMatchObject({ startParagraph: 1, endParagraph: 200, truncated: true, nextParagraph: 201 });
    expect(paragraphs.text.split('\n')).toHaveLength(200);
    const file = await call<TextRead>(context, 'read_text_file', { path: 'story/000001.txt', startLine: 1, endLine: 479 });
    expect(file).toMatchObject({ startLine: 1, endLine: 200, truncated: true, nextLine: 201 });
    expect(file.lines).toHaveLength(200);
  });

  it('includes only source IDs captured by the original reference and numbers the selected sources', async () => {
    const { state, texts, original } = fixture();
    original.reference.sourceIds = ['source-two'];
    const context = buildWritingContext({ state, chapterText: id => texts.get(id)!, original });
    original.reference.sourceIds.push('source-one');
    const files = await call<FileList>(context, 'list_text_files', { collection: 'original', offset: 0, limit: 20 });
    expect(files.total).toBe(4);
    expect(files.files.filter(value => value.source)).toMatchObject([{ path: 'original/sources/0001/000001.txt', sourceId: 'source-two', sourceFilename: '附录.txt' }]);
    expect(await call<TextSearch>(context, 'search_text', { query: 'ＣＯＭＰＡＳＳ', collection: 'original' })).toMatchObject({ matches: [], total: 0 });
    expect(pageText(await call<TextRead>(context, 'read_text_file', { path: 'original/sources/0001/000001.txt' }))).toBe('原始附录的未来秘密。');
    expect(await context.tools.find(value => value.name === 'read_text_file')!.execute({ path: 'original/sources/0002/000001.txt' })).toMatchObject({ error: expect.any(String) });
  });

  it('maps a truncated paragraph back to its raw line and leading-space offset for continuation', async () => {
    const longParagraph = String.fromCharCode(34, 92).repeat(16000) + '长段落尾部';
    const context = longContext(`首段\r\n\r\n  ${longParagraph}\r\n\r\n末段`);
    const first = await call<{ text: string; path: string; startParagraph: number; endParagraph: number; truncated: boolean; nextParagraph: number; nextLine: number; nextOffset: number; nextLineOffset: number }>(context, 'read_chapter', { chapterId: 'long-chapter', startParagraph: 2, endParagraph: 2 });
    expect(first).toMatchObject({ path: 'story/000001.txt', startParagraph: 2, endParagraph: 2, truncated: true, nextParagraph: 2, nextLine: 3 });
    expect(first.text.startsWith('  ')).toBe(false);
    expect(first.nextOffset).toBe(first.text.length);
    expect(first.nextLineOffset).toBe(first.text.length + 2);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(20000);
    const texts = [first.text];
    let offset = first.nextLineOffset;
    for (let page = 0; page < 8; page++) {
      const rest = await call<TextRead>(context, 'read_text_file', { path: first.path, startLine: first.nextLine, endLine: first.nextLine, startOffset: offset });
      expect(JSON.stringify(rest).length).toBeLessThanOrEqual(20000);
      texts.push(pageText(rest));
      if (!rest.truncated) break;
      expect(rest.nextLine).toBe(3);
      expect(rest.nextOffset).toBeGreaterThan(offset);
      offset = rest.nextOffset!;
    }
    expect(texts.join('')).toBe(longParagraph);
  });

  it('continues the second trimmed paragraph through chapter reads without changing paragraph or losing its ending', async () => {
    const longParagraph = '第2段开头' + String.fromCharCode(34, 92).repeat(22000) + '第2段终点😀';
    const leading = '\t  ';
    const context = longContext(`第1段不能进入续读\r\n\r\n${leading}${longParagraph}   \r\n\r\n第3段不能进入续读`);
    type ParagraphPage = { text: string; path: string; startParagraph: number; endParagraph: number; totalParagraphs: number; truncated: boolean; nextParagraph?: number; nextOffset?: number; nextLine?: number; nextLineOffset?: number };
    const texts: string[] = [];
    let paragraph = 2;
    let offset = 0;
    for (let page = 0; page < 16; page++) {
      const result = await call<ParagraphPage>(context, 'read_chapter', { chapterId: 'long-chapter', startParagraph: paragraph, endParagraph: 2, startOffset: offset });
      expect(result).toMatchObject({ path: 'story/000001.txt', startParagraph: 2, endParagraph: 2, totalParagraphs: 3 });
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text).toBe(longParagraph.slice(offset, offset + result.text.length));
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(20000);
      texts.push(result.text);
      if (!result.truncated) {
        expect(result.nextParagraph).toBeUndefined();
        expect(result.nextOffset).toBeUndefined();
        expect(result.nextLine).toBeUndefined();
        expect(result.nextLineOffset).toBeUndefined();
        break;
      }
      expect(result).toMatchObject({ nextParagraph: 2, nextLine: 3 });
      expect(result.nextOffset).toBe(offset + result.text.length);
      expect(result.nextLineOffset).toBe(result.nextOffset! + leading.length);
      paragraph = result.nextParagraph!;
      offset = result.nextOffset!;
    }
    expect(texts.length).toBeGreaterThan(2);
    expect(texts.join('')).toBe(longParagraph);
  });
});

describe('searching text with explicit files and pagination', () => {
  it('uses OR and NFKC matching across story, original snapshot and raw source text', async () => {
    const { context } = fixture();
    const result = await call<TextSearch>(context, 'search_text', { keywords: ['Ｃｏｍｐａｓｓ', '火焰', 'COMPASS'], collection: 'all', offset: 0, limit: 20, contextLines: 0 });
    expect(result.total).toBe(5);
    expect(result.matches.map(value => [value.path, value.line])).toEqual([
      ['story/000001.txt', 3], ['story/000002.txt', 1], ['original/000002.txt', 2],
      ['original/sources/0001/000001.txt', 3], ['original/sources/0001/000002.txt', 1],
    ]);
    expect(result.matches.find(value => value.path === 'original/000002.txt')).toMatchObject({ reference: true, source: false, collection: 'original' });
    expect(result.matches.find(value => value.path.includes('/sources/'))).toMatchObject({ reference: true, source: true, sourceFilename: '原始稿.txt' });
    expect(result.matches.filter(value => value.collection === 'story').every(value => !value.reference && !value.source)).toBe(true);
  });

  it('returns stable line matches with bounded neighboring context and resumable result offsets', async () => {
    const { context } = fixture();
    const first = await call<TextSearch>(context, 'search_text', { query: 'Compass 火焰', collection: 'all', offset: 0, limit: 2, contextLines: 1 });
    expect(first).toMatchObject({ total: 5, offset: 0, nextOffset: 2, truncated: true });
    expect(first.matches[0].context.map(value => ({ line: value.line, text: value.text }))).toEqual([
      { line: 2, text: '' }, { line: 3, text: '青霜举起 Compass。' }, { line: 4, text: '最后一行。' },
    ]);
    const rest = await call<TextSearch>(context, 'search_text', { keywords: ['Compass', '火焰'], collection: 'all', offset: first.nextOffset, limit: 10, contextLines: 1 });
    expect(rest).toMatchObject({ total: 5, offset: 2, truncated: false });
    expect(rest.matches).toHaveLength(3);
    expect(rest.nextOffset).toBeUndefined();
    expect(new Set([...first.matches, ...rest.matches].map(value => `${value.path}:${value.line}`)).size).toBe(5);
  });

  it('honors collection and exact path filters and never joins adjacent lines into invented matches', async () => {
    const { context } = fixture();
    const story = await call<TextSearch>(context, 'search_text', { query: '火焰', collection: 'story' });
    expect(story.matches.map(value => value.path)).toEqual(['story/000002.txt']);
    const original = await call<TextSearch>(context, 'search_text', { query: '火焰', collection: 'original' });
    expect(original.matches.map(value => value.path)).toEqual(['original/000002.txt', 'original/sources/0001/000002.txt']);
    const source = await call<TextSearch>(context, 'search_text', { query: 'Compass', collection: 'original', path: 'original/sources/0001/000001.txt' });
    expect(source.matches).toMatchObject([{ path: 'original/sources/0001/000001.txt', line: 3 }]);
    const lines = longContext('字段尾甲\n乙从下一行开头');
    expect(await call<TextSearch>(lines, 'search_text', { keywords: ['甲乙'], collection: 'story' })).toMatchObject({ matches: [], total: 0, truncated: false });
  });

  it('keeps a known multiword title whole for legacy query rather than matching each word separately', async () => {
    const { context } = fixture();
    const result = await call<TextSearch>(context, 'search_text', { query: ' Ｗｅｓｔ　Ｇａｔｅ ', collection: 'all' });
    expect(result.matches.map(value => [value.path, value.line])).toEqual([['story/000001.txt', 1]]);
    const entitySearch = await call<StorySearch>(context, 'search_story', { query: ' Ｏｌｄ　Ｎｏｒｔｈ　Ｐｏｒｔ ', collection: 'all', scope: 'entities' });
    expect(entitySearch.entities).toMatchObject([{ id: 'shared-person', collection: 'original', reference: true }]);
  });

  it('preserves a raw source chapter title as a full query phrase', async () => {
    const { state, texts, original } = fixture();
    texts.set('story-second', 'Ancient 出现在第一行。\nBeacon 出现在下一行。');
    original.sources[0].chapters[1] = { title: 'Ancient Beacon', text: 'Ancient Beacon 映照海面。' };
    const context = buildWritingContext({ state, chapterText: id => texts.get(id)!, original });
    const result = await call<TextSearch>(context, 'search_text', { query: ' Ａｎｃｉｅｎｔ　Ｂｅａｃｏｎ ', collection: 'all' });
    expect(result.matches.map(value => [value.path, value.line])).toEqual([['original/sources/0001/000002.txt', 1]]);
  });

  it('marks long matching lines as truncated while keeping them available for offset reads', async () => {
    const context = longContext(`Compass ${'甲'.repeat(25000)} 尾声`);
    const result = await call<TextSearch>(context, 'search_text', { query: 'Compass', collection: 'story', contextLines: 0 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ path: 'story/000001.txt', line: 1, truncated: true });
    expect(result.matches[0].text.length).toBeLessThanOrEqual(20000);
    expect(result.matches[0].context.every(value => value.text.length <= 20000)).toBe(true);
    expect(pageText(await call<TextRead>(context, 'read_text_file', { path: result.matches[0].path, startLine: result.matches[0].line, startOffset: 24000 }))).toContain('尾声');
  });

  it('finds a hit beyond the first page and reports its UTF-16 column plus snippet offsets', async () => {
    const text = `😀${'甲'.repeat(25000)}ＣＯＭＰＡＳＳ终点`;
    const context = longContext(text);
    const result = await call<TextSearch>(context, 'search_text', { keywords: ['Compass'], collection: 'story', contextLines: 0 });
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match).toMatchObject({ path: 'story/000001.txt', line: 1, hitColumn: text.indexOf('ＣＯＭＰＡＳＳ') + 1, truncated: true });
    expect(match.startOffset).toBeGreaterThan(0);
    expect(match.endOffset).toBeGreaterThan(match.startOffset);
    expect(match.text).toBe(text.slice(match.startOffset, match.endOffset));
    expect(match.text).toContain('ＣＯＭＰＡＳＳ');
    expect(match.text.length + match.context.reduce((total, line) => total + line.text.length, 0)).toBeLessThanOrEqual(20000);
    const page = await call<TextRead>(context, 'read_text_file', { path: match.path, startLine: match.line, startOffset: match.startOffset });
    expect(pageText(page)).toContain('ＣＯＭＰＡＳＳ终点');
  });

  it('paginates at the whole-result character budget without returning empty pages or skipping hits', async () => {
    const text = Array.from({ length: 40 }, (_, index) => `Compass ${index + 1} ${'甲'.repeat(500)}`).join('\n');
    const context = longContext(text);
    const seen: number[] = [];
    let offset = 0;
    for (let page = 0; page < 40; page++) {
      const result = await call<TextSearch>(context, 'search_text', { query: 'Compass', collection: 'story', offset, limit: 100, contextLines: 2 });
      expect(result.total).toBe(40);
      expect(result.matches.length).toBeGreaterThan(0);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(20000);
      seen.push(...result.matches.map(match => match.line));
      if (!result.truncated) { expect(result.nextOffset).toBeUndefined(); break; }
      expect(result.nextOffset).toBe(offset + result.matches.length);
      offset = result.nextOffset!;
    }
    expect(seen).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
  });
});

describe('strict text-tool input boundaries', () => {
  it('rejects malformed arguments rather than silently coercing or ignoring them', async () => {
    const { context } = fixture();
    const invalid: [string, Record<string, unknown>][] = [
      ['list_text_files', { collection: 'unknown' }], ['list_text_files', { offset: -1 }], ['list_text_files', { offset: 0.5 }],
      ['list_text_files', { limit: 0 }], ['list_text_files', { limit: 101 }], ['list_text_files', { limit: '2' }], ['list_text_files', { query: 3 }], ['list_text_files', { extra: true }],
      ['search_text', {}], ['search_text', { query: ' , 、 ; | ' }], ['search_text', { keywords: ['Compass', ' '] }],
      ['search_text', { keywords: 'Compass' }], ['search_text', { keywords: [1] }], ['search_text', { query: 1 }],
      ['search_text', { query: 'Compass', collection: 'unknown' }], ['search_text', { query: 'Compass', offset: -1 }],
      ['search_text', { query: 'Compass', limit: 0 }], ['search_text', { query: 'Compass', limit: 101 }], ['search_text', { query: 'Compass', contextLines: -1 }],
      ['search_text', { query: 'Compass', contextLines: 11 }],
      ['search_text', { query: 'Compass', contextLines: 0.5 }], ['search_text', { query: 'Compass', unexpected: true }],
      ['read_text_file', {}], ['read_text_file', { path: 3 }], ['read_text_file', { path: 'story/000001.txt', startLine: 0 }],
      ['read_text_file', { path: 'story/000001.txt', startLine: '1' }], ['read_text_file', { path: 'story/000001.txt', endLine: 0.5 }],
      ['read_text_file', { path: 'story/000001.txt', startLine: 3, endLine: 2 }], ['read_text_file', { path: 'story/000001.txt', startOffset: -1 }],
      ['read_text_file', { path: 'story/000001.txt', startOffset: 1.5 }], ['read_text_file', { path: 'story/000001.txt', unexpected: true }],
      ['read_chapter', { chapterId: 'shared-chapter', startLine: 1, startParagraph: 1 }],
      ['read_chapter', { chapterId: 'shared-chapter', startParagraph: 3, endParagraph: 2 }],
      ['read_chapter', { chapterId: 'shared-chapter', startParagraph: 0 }],
      ['read_chapter', { chapterId: 'shared-chapter', collection: 'unknown' }],
      ['read_entity', { id: 'shared-person', collection: 'unknown' }],
      ['search_story', { query: '林舟', collection: 'unknown' }], ['search_story', { query: '林舟', scope: ['all'] }],
    ];
    for (const [name, args] of invalid) {
      const tool = context.tools.find(value => value.name === name)!;
      expect(tool, name).toBeDefined();
      expect(await tool.execute(args), `${name}: ${JSON.stringify(args)}`).toMatchObject({ error: expect.any(String) });
    }
  });

  it('rejects traversal, local paths, URLs, unlisted virtual paths and collection/path mismatches', async () => {
    const { context } = fixture();
    const paths = ['../README.md', 'story/../original/000001.txt', '/story/000001.txt', 'D:\\project\\private\\ai-novel\\README.md', 'file:///D:/private.txt', 'https://example.com/private.txt', 'story\\000001.txt', 'story/%2e%2e/README.md', 'story/000001.txt\0', 'story/000000.txt', 'story/000099.txt', 'original/sources/0009/000001.txt'];
    for (const path of paths) {
      expect(await context.tools.find(value => value.name === 'read_text_file')!.execute({ path }), path).toMatchObject({ error: expect.any(String) });
      expect(await context.tools.find(value => value.name === 'search_text')!.execute({ query: 'Compass', collection: 'all', path }), path).toMatchObject({ error: expect.any(String) });
      expect(await context.tools.find(value => value.name === 'read_chapter')!.execute({ chapterId: path }), path).toMatchObject({ error: expect.any(String) });
    }
    expect(await context.tools.find(value => value.name === 'search_text')!.execute({ query: 'Compass', collection: 'story', path: 'original/000001.txt' })).toMatchObject({ error: expect.any(String) });
    expect(await context.tools.find(value => value.name === 'read_chapter')!.execute({ chapterId: 'original/sources/0001/000001.txt', collection: 'story' })).toMatchObject({ error: expect.any(String) });
  });
});
