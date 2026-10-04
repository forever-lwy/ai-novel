import { describe, expect, it } from 'vitest';
import { buildWritingContext } from '../server/writing-context.js';
import { emptyState, type Entity, type StoryState } from '../shared/types.js';

function entity(id: string, name: string, description: string, extra: Partial<Entity> = {}): Entity {
  return { id, name, description, kind: 'character', aliases: [], visibility: 'public', locked: false, facts: [], ...extra };
}
function fixture(): { state: StoryState; texts: Map<string, string> } {
  const state = emptyState(); state.outline.worldview = '古城每年经历一次长夜。'; state.outline.locked = '保持克制的叙述。';
  state.chapters = Array.from({ length: 6 }, (_, index) => ({ id: `c${index + 1}`, title: `第${index + 1}章`, summary: `第${index + 1}章完整摘要。${'摘要'.repeat(600)}`, status: 'ready', createdAt: '' }));
  state.entities = [entity('main', '阿青', '故事主角，性格沉稳。', { isMain: true, facts: [{ id: 'known', text: '拥有夜视能力', temporal: 'current', certainty: 'fact', visibility: 'public', locked: true }, { id: 'future', text: '尚未发生的主角晋升', temporal: 'future', certainty: 'fact', visibility: 'secret' }] }), entity('support', '老吴', '与主角相识的配角，独有配角资料。', { locked: true }), entity('named', '小白', '主人公，擅长航海。'), entity('excluded', '小灰', '主人公，已改为配角。', { isMain: false })];
  state.foreshadows = (['planned', 'planted', 'resolved', 'abandoned'] as const).map(status => ({ id: status, title: `伏笔${status}`, detail: `线索${status}`, status, revealCondition: '', relatedEntityIds: [] }));
  state.outline.fine = [{ chapter: 7, title: '重返港口', goal: '调查失踪船只' }, { chapter: 8, title: '后续规划', goal: '未来规划不应默认注入' }];
  const texts = new Map(state.chapters.map(chapter => [chapter.id, `${chapter.id}完整原文。${'章内容'.repeat(10000)}`]));
  return { state, texts };
}

describe('writing context and version-bound lookup', () => {
  it('preserves all summaries and three complete recent chapters without injecting other dossiers or older prose', () => {
    const { state, texts } = fixture(); const context = buildWritingContext({ state, chapterText: id => texts.get(id)! });
    for (const chapter of state.chapters) expect(context.text).toContain(chapter.summary);
    for (const id of ['c4', 'c5', 'c6']) expect(context.text).toContain(texts.get(id));
    for (const id of ['c1', 'c2', 'c3']) expect(context.text).not.toContain(texts.get(id));
    expect(context.text).toContain('拥有夜视能力'); expect(context.text).toContain('小白');
    expect(context.text).not.toContain('独有配角资料'); expect(context.text).not.toContain('小灰'); expect(context.text).not.toContain('尚未发生的主角晋升');
    expect(context.text).toContain('伏笔planned'); expect(context.text).toContain('伏笔planted'); expect(context.text).not.toContain('伏笔resolved'); expect(context.text).not.toContain('伏笔abandoned');
    expect(context.text).toContain('调查失踪船只'); expect(context.text).not.toContain('未来规划不应默认注入');
  });

  it('reads older prose and full supporting-character dossiers only through tools pinned before later state changes', async () => {
    const { state, texts } = fixture(); const original = texts.get('c1');
    const context = buildWritingContext({ state, chapterText: id => texts.get(id)! });
    const search = context.tools.find(tool => tool.name === 'search_story')!;
    const readChapter = context.tools.find(tool => tool.name === 'read_chapter')!;
    const readEntity = context.tools.find(tool => tool.name === 'read_entity')!;
    texts.set('c1', '较新版本的未来信息'); state.entities[1].description = '较新版本的配角秘密';
    state.chapters.push({ id: 'future', title: '未来章', summary: '未来剧情', status: 'ready', createdAt: '' });
    expect(await search.execute({ query: '老吴' })).toMatchObject({ entities: [{ id: 'support', name: '老吴' }] });
    expect(await readEntity.execute({ id: 'support' })).toMatchObject({ entity: { description: '与主角相识的配角，独有配角资料。' } });
    expect(await readChapter.execute({ chapterId: 'c1' })).toMatchObject({ text: original });
    expect(await readChapter.execute({ chapterId: 'future' })).toMatchObject({ error: expect.any(String) });
    expect(JSON.stringify(await search.execute({ query: '较新版本' }))).not.toContain('较新版本');
  });

  it('keeps main-character current traits and major events in context while querying everyday history on demand', async () => {
    const { state, texts } = fixture();
    state.entities[0].facts.push(
      { id: 'past-location', attribute: 'location', text: '阿青曾住旧驿站', temporal: 'past', certainty: 'fact', visibility: 'public' },
      { id: 'daily', text: '阿青昨天吃过一碗面', temporal: 'past', certainty: 'fact', visibility: 'public' },
      { id: 'major', attribute: 'major_event', text: '阿青在长夜觉醒火魔法', temporal: 'past', certainty: 'fact', visibility: 'public' },
      { id: 'locked-past', text: '作者锁定的身世经历', temporal: 'past', certainty: 'fact', visibility: 'public', locked: true },
    );
    const context = buildWritingContext({ state, chapterText: id => texts.get(id)! });
    expect(context.text).toContain('拥有夜视能力'); expect(context.text).toContain('阿青在长夜觉醒火魔法'); expect(context.text).toContain('作者锁定的身世经历');
    expect(context.text).not.toContain('阿青曾住旧驿站'); expect(context.text).not.toContain('阿青昨天吃过一碗面');
    const full = JSON.stringify(await context.tools.find(tool => tool.name === 'read_entity')!.execute({ id: 'main' }));
    expect(full).toContain('阿青曾住旧驿站'); expect(full).toContain('阿青昨天吃过一碗面');
  });

  it('uses only author-confirmed compression and retains summaries after its covered chapters', () => {
    const { state, texts } = fixture(); state.outline.summaryCompression = { text: '作者确认的前三章压缩摘要', chapterIds: ['c1', 'c2', 'c3'] };
    let context = buildWritingContext({ state, chapterText: id => texts.get(id)! });
    expect(context.text).toContain('作者确认的前三章压缩摘要');
    for (const chapter of state.chapters.slice(0, 3)) expect(context.text).not.toContain(chapter.summary);
    for (const chapter of state.chapters.slice(3)) expect(context.text).toContain(chapter.summary);
    state.chapters = state.chapters.slice(0, 2);
    context = buildWritingContext({ state, chapterText: id => texts.get(id)! });
    expect(context.text).not.toContain('作者确认的前三章压缩摘要');
    for (const chapter of state.chapters) expect(context.text).toContain(chapter.summary);
  });
});
