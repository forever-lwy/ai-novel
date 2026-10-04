import { describe, expect, it } from 'vitest';
import { buildWritingContext } from '../server/writing-context.js';
import { emptyState, type ChapterRef, type Entity, type ModelTool, type StoryState } from '../shared/types.js';

type SearchResult = { entities: { id: string }[]; chapters: { chapterId: string }[]; error?: string };
const entity = (id: string, name: string, description: string, extra: Partial<Entity> = {}): Entity => ({ id, name, description, kind: 'character', aliases: [], visibility: 'public', locked: false, facts: [], ...extra });
const chapter = (id: string, title: string, summary: string): ChapterRef => ({ id, title, summary, status: 'ready', createdAt: '' });
function fixture() {
  const state = emptyState();
  state.entities = [
    entity('person-blue', '青霜', '擅长雷火与刀法。', { aliases: ['无名剑客'], facts: [{ id: 'fact-metadata-id', text: '曾到过白石城', attribute: 'metadata-trait-key', temporal: 'past', certainty: 'fact', visibility: 'public', citation: { chapterId: 'metadata-citation-id', paragraph: 1, quote: 'metadata-evidence-only' } }] }),
    entity('person-record', '记录员', '携带 Compass，擅长记忆。', { aliases: ['夜行人'], facts: [{ id: 'fact-tide', text: '能准确判断潮汐', temporal: 'current', certainty: 'fact', visibility: 'public' }] }),
    entity('place-harbor', 'Silver Harbor', '一座安静的码头。', { kind: 'location', aliases: ['Old North Port'] }),
    entity('person-words', '远方祭司', '居住在 Silver 山脉；盯着 Lights 解读 Northern 星象；收藏 old 地图，并面向 north 祈祷。'),
    entity('person-gate', '守门人', '经常守在 West Gate。'),
    entity('person-scattered', 'West 使者', '准备离开 Gate。'),
    entity('entity-metadata-only', '无关条目', '没有检索主题。'),
    entity('person-boundary', '字段尾甲', '乙从描述起头。'),
  ];
  state.chapters = [chapter('chapter-fire', '山路', '旅人离开村落。'), chapter('chapter-compass', '归程', '记录员判断天气。'), chapter('chapter-north', 'Northern Lights', '天空出现了淡蓝色光芒。'), chapter('chapter-boundary', '标题尾甲', '乙从摘要开头，摘要尾丙')];
  const texts = new Map([
    ['chapter-fire', '青霜使用了雷火。白石城的城门随后关闭。'],
    ['chapter-compass', 'Compass 指向海面，远处可听到潮汐。'],
    ['chapter-north', '几名村民站在屋檐下。'],
    ['chapter-boundary', '丁从正文开头。'],
  ]);
  const tool = buildWritingContext({ state, chapterText: id => texts.get(id)! }).tools.find(tool => tool.name === 'search_story')!;
  return { state, texts, tool };
}
const ids = (result: SearchResult) => ({ entities: result.entities.map(entity => entity.id), chapters: result.chapters.map(chapter => chapter.chapterId) });
async function search(tool: ModelTool, args: Record<string, unknown>): Promise<SearchResult> { const result = await tool.execute(args) as SearchResult; expect(result.error).toBeUndefined(); return result; }

describe('story lookup with explicit multiple keywords', () => {
  it('matches Chinese keyword alternatives across different dossiers and chapters instead of requiring the complete input string', async () => {
    const { tool } = fixture();
    expect(ids(await search(tool, { query: '雷火 潮汐' }))).toEqual({ entities: ['person-blue', 'person-record'], chapters: ['chapter-fire', 'chapter-compass'] });
  });

  it('matches ASCII alternatives case-insensitively across different entities', async () => {
    const { tool } = fixture();
    expect(ids(await search(tool, { query: 'compass silver', scope: 'entities' }))).toEqual({ entities: ['person-record', 'place-harbor', 'person-words'], chapters: [] });
  });

  it.each([' ', '\t', '\n', '\r\n', ',', '，', '、', ';', '；', '|', '｜'])('treats %j as a separator between ordinary query terms', async separator => {
    const { tool } = fixture();
    expect(ids(await search(tool, { query: `雷火${separator}潮汐` }))).toEqual({ entities: ['person-blue', 'person-record'], chapters: ['chapter-fire', 'chapter-compass'] });
  });

  it.each([{ keywords: ['雷火', '潮汐'] }, { query: '', keywords: ['雷火', '潮汐'] }, { query: ' \n\t ', keywords: ['雷火', '潮汐'] }])('accepts explicit keyword arrays when query is missing or blank: %j', async args => {
    const { tool } = fixture();
    expect(ids(await search(tool, args))).toEqual({ entities: ['person-blue', 'person-record'], chapters: ['chapter-fire', 'chapter-compass'] });
  });

  it('merges both inputs with OR and returns each matching record once after normalization and deduplication', async () => {
    const { tool } = fixture();
    expect(ids(await search(tool, { query: '青霜, compass, ＣＯＭＰＡＳＳ', keywords: ['COMPASS', ' Compass ', 'Ｃｏｍｐａｓｓ', '青霜'] }))).toEqual({ entities: ['person-blue', 'person-record'], chapters: ['chapter-fire', 'chapter-compass'] });
  });

  it.each([
    [' Silver Harbor ', 'place-harbor'],
    ['Ｓｉｌｖｅｒ　Ｈａｒｂｏｒ', 'place-harbor'],
    [' old north port ', 'place-harbor'],
  ])('preserves an explicit multiword name or alias as one term: %s', async (query, id) => {
    const { tool } = fixture();
    expect(ids(await search(tool, { query, scope: 'entities' }))).toEqual({ entities: [id], chapters: [] });
  });

  it('preserves an exact chapter title as one term rather than matching its separate words in world dossiers', async () => {
    const { tool } = fixture();
    expect(ids(await search(tool, { query: '  northern lights  ' }))).toEqual({ entities: [], chapters: ['chapter-north'] });
  });

  it('keeps an array item containing whitespace as a single explicit phrase', async () => {
    const { tool } = fixture();
    expect(ids(await search(tool, { keywords: [' West Gate '], scope: 'entities' }))).toEqual({ entities: ['person-gate'], chapters: [] });
  });

  it.each(['all', 'entities', 'chapters'] as const)('honors the existing %s search scope', async scope => {
    const { tool } = fixture(); const result = ids(await search(tool, { keywords: ['雷火', '潮汐'], scope }));
    expect(result).toEqual({ entities: scope === 'chapters' ? [] : ['person-blue', 'person-record'], chapters: scope === 'entities' ? [] : ['chapter-fire', 'chapter-compass'] });
  });

  it.each(['无名剑客', '擅长记忆', '曾到过白石城'])('matches explicit aliases, descriptions and fact text: %s', async query => {
    const { tool } = fixture(); const result = await search(tool, { query, scope: 'entities' });
    expect(result.entities).toHaveLength(1);
  });

  it.each(['entity-metadata-only', 'character', 'location', 'public', 'visibility', 'fact-metadata-id', 'metadata-trait-key', 'metadata-citation-id', 'metadata-evidence-only'])('ignores JSON metadata rather than treating %s as story text', async query => {
    const { tool } = fixture();
    expect(ids(await search(tool, { keywords: [query] }))).toEqual({ entities: [], chapters: [] });
  });

  it.each(['甲乙', '丙丁'])('does not invent a %s match by concatenating adjacent dossier or chapter fields', async query => {
    const { tool } = fixture();
    expect(ids(await search(tool, { keywords: [query] }))).toEqual({ entities: [], chapters: [] });
  });

  it('returns no records for unmentioned keywords instead of inferring semantic relationships', async () => {
    const { tool } = fixture();
    expect(ids(await search(tool, { keywords: ['火系法师', '海洋导航术'] }))).toEqual({ entities: [], chapters: [] });
  });

  it.each([
    {}, { query: '' }, { query: ' , 、 ; | ' }, { keywords: [] },
    { keywords: '雷火 潮汐' }, { keywords: null }, { keywords: [1] }, { keywords: ['雷火', 1] },
    { keywords: [''] }, { keywords: ['雷火', ' \n '] }, { query: '雷火', keywords: [null] },
    { query: 3, keywords: ['雷火'] }, { keywords: ['雷火'], scope: 'unknown' },
  ])('rejects malformed or empty input without throwing: %j', async args => {
    const { tool } = fixture(); expect(await tool.execute(args)).toMatchObject({ error: expect.any(String) });
  });

  it('keeps both categories capped at twenty records in their snapshot order', async () => {
    const state: StoryState = emptyState(); const texts = new Map<string, string>();
    for (let index = 0; index < 24; index++) {
      state.entities.push(entity(`limited-entity-${index}`, `资料${index}`, '共同检索主题'));
      state.chapters.push(chapter(`limited-chapter-${index}`, `章节${index}`, '共同检索主题'));
      texts.set(`limited-chapter-${index}`, '普通原文。');
    }
    const tool = buildWritingContext({ state, chapterText: id => texts.get(id)! }).tools.find(tool => tool.name === 'search_story')!;
    const result = ids(await search(tool, { keywords: ['共同检索'] }));
    expect(result.entities).toEqual(state.entities.slice(0, 20).map(entity => entity.id));
    expect(result.chapters).toEqual(state.chapters.slice(0, 20).map(chapter => chapter.id));
  });

  it('does not see keywords added to later state or chapter revisions', async () => {
    const { state, texts, tool } = fixture();
    state.entities[0].description = '稍后出现的新线索'; state.entities.push(entity('future-entity', '未来人物', '稍后出现的新线索'));
    texts.set('chapter-fire', '稍后出现的新线索'); state.chapters[0].summary = '稍后出现的新线索';
    state.chapters.push(chapter('future-chapter', '未来章', '稍后出现的新线索')); texts.set('future-chapter', '稍后出现的新线索');
    expect(ids(await search(tool, { query: '新线索 未出现' }))).toEqual({ entities: [], chapters: [] });
    expect(ids(await search(tool, { keywords: ['雷火', '潮汐'] }))).toEqual({ entities: ['person-blue', 'person-record'], chapters: ['chapter-fire', 'chapter-compass'] });
  });
});
