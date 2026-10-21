import { describe, expect, it } from 'vitest';
import { buildImageStoryContext } from '../server/image-context';
import { emptyState, type Entity, type StoryImage } from '../shared/types';

const entity = (id: string, name: string, kind: Entity['kind'] = 'character'): Entity => ({ id, name, kind, aliases: [], description: `${name}的已确认外观`, visibility: 'public', locked: true, facts: [] });
const fixture = () => {
  const state = emptyState();
  state.chapters = ['遥远前文', '相邻前文一', '相邻前文二', '目标章', '未来章'].map((title, i) => ({ id: `chapter-${i}`, title, summary: `摘要-${title}`, status: 'ready', createdAt: '' }));
  const target = `林月身穿白衣，在青石桥等候。${'不含人物名的前文。'.repeat(260)}她举起旧伞。\n程川随后回到桥边。`;
  const texts = ['OLD_FULL_TEXT', '风停之后，程川向桥边走去。', '青石桥上燃着灯火。', target, 'FUTURE_CHAPTER_TEXT'];
  state.entities = [entity('moon', '林月'), entity('river', '程川'), entity('bridge', '青石桥', 'location'), entity('rule', '世界规则', 'rule'), entity('unrelated', '远方陌生人')];
  state.relations = [{ id: 'relation', fromId: 'moon', toId: 'bridge', label: '等待于', visibility: 'public' }];
  state.outline.worldview = '作者世界观'; state.outline.locked = '作者固定设定';
  const start = target.indexOf('她举起'); const image = { kind: 'cg', chapterId: state.chapters[3].id, selection: { start, end: start + '她举起旧伞。'.length }, sourceText: '她举起旧伞。', publicMaterial: false } as StoryImage;
  return { state, image, read: (id: string) => texts[state.chapters.findIndex(chapter => chapter.id === id)] };
};

describe('CG story context', () => {
  it('includes full before/after text, two preceding chapters and earlier summaries without reading later chapters', () => {
    const { state, image, read } = fixture(); const readIds: string[] = [];
    const result = buildImageStoryContext(image, state, id => { readIds.push(id); return read(id); })!;
    for (const value of ['林月身穿白衣', '她举起旧伞。', '程川随后回到桥边', '风停之后', '青石桥上燃着灯火', '摘要-遥远前文', '作者世界观', '作者固定设定']) expect(result.text).toContain(value);
    expect(result.text).not.toContain('FUTURE_CHAPTER_TEXT'); expect(result.text).not.toContain('摘要-未来章'); expect(result.text).not.toContain('OLD_FULL_TEXT');
    expect(readIds).toEqual(['chapter-3', 'chapter-1', 'chapter-2']); expect(image.sourceText).toBe('她举起旧伞。');
    expect(result.entities.map(entity => entity.id)).toEqual(['moon', 'river', 'bridge', 'rule']); expect(result.relations.map(relation => relation.id)).toEqual(['relation']);
    expect(result.text).not.toContain('chapter-3'); expect(result.text).not.toContain('远方陌生人');
  });

  it('uses only a compression wholly preceding the target and keeps full-chapter generation intact', () => {
    const { state, image, read } = fixture(); image.selection = undefined; image.sourceText = read(image.chapterId!);
    state.outline.summaryCompression = { text: '前文压缩摘要', chapterIds: ['chapter-0', 'chapter-1'] };
    let result = buildImageStoryContext(image, state, read)!;
    expect(result.text).toContain('前文压缩摘要'); expect(result.text).not.toContain('摘要-遥远前文'); expect(result.text).toContain('本章全文'); expect(result.text).toContain(image.sourceText);
    state.outline.summaryCompression.chapterIds.push('chapter-4'); result = buildImageStoryContext(image, state, read)!;
    expect(result.text).not.toContain('前文压缩摘要'); expect(result.text).toContain('摘要-遥远前文');
  });

  it('keeps author-only settings and secret relations out of public-material contexts', () => {
    const { state, image, read } = fixture(); image.publicMaterial = true; state.relations[0].visibility = 'secret';
    const result = buildImageStoryContext(image, state, read)!;
    expect(result.text).not.toContain('作者世界观'); expect(result.text).not.toContain('作者固定设定'); expect(result.relations).toEqual([]);
    expect(result.text).toContain('世界规则');
    expect(buildImageStoryContext({ ...image, kind: 'portrait' }, state, read)).toBeUndefined();
  });
});
