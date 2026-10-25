import { describe, expect, it } from 'vitest';
import { prepareReadablePromptVariables } from '../shared/prompt-readable-variables.js';
import { extractionContext, splitExtractionBlocks } from '../server/extraction.js';
import { emptyState } from '../shared/types.js';

describe('readable material aliases', () => {
  it('keeps legacy values while rendering material, history and anchor exactly once', () => {
    const prose = '上一段。\n\n下一段保留 {作者括号} 与 {{作者变量}}。';
    const context = { worldview: '世界设定', continuationAnchor: { chapterId: 'c1', title: '旧门', ending: prose }, recentCompleteChapters: [{ chapterId: 'c1', title: '旧门', text: prose }], mainCharacters: [{ id: 'e1', name: '旅人', facts: [{ citation: { chapterId: 'c1', paragraph: 1, quote: prose } }] }] };
    const variables = { context: JSON.stringify(context), instruction: '继续' }; const original = { ...variables };
    const rendered = prepareReadablePromptVariables('writing', variables);
    expect(rendered.context).toBe(variables.context); expect(variables).toEqual(original);
    expect(rendered.storyMaterialsText).toContain('名称：旅人'); expect(rendered.storyMaterialsText).toContain('原文段号：1');
    expect(rendered.storyMaterialsText).not.toContain('已保存正文结尾'); expect(rendered.storyMaterialsText).not.toContain('最近章节全文');
    expect(rendered.recentChaptersText).toContain(prose); expect(rendered.continuationAnchorText).toContain(prose);
    expect(rendered.contextText).not.toContain('\\n'); expect(rendered.contextText).not.toContain('\\"');
  });

  it('respects explicitly supplied readable values including empty values', () => {
    const variables = { context: '{"worldview":"旧内容"}', storyMaterialsText: '', recentChaptersText: '作者的预览原文', continuationAnchorText: '作者的起点', contextText: '作者完整资料' };
    expect(prepareReadablePromptVariables('writing', variables)).toEqual(variables);
    expect(prepareReadablePromptVariables('image', { imageInput: '{"material":"第一行。\\n第二行。"}' }).imageInputText).toBe('目标素材：\n第一行。\n第二行。');
  });

  it('renders the actual extraction index without exposing serialized arrays', () => {
    const state = emptyState();
    state.entities.push({ id: 'e1', kind: 'character', name: '旅人', aliases: ['旧称'], description: '', visibility: 'public', locked: false, facts: [] });
    state.foreshadows.push({ id: 'f1', title: '门后的声音', detail: '', status: 'planted', revealCondition: '', relatedEntityIds: [] });
    const block = splitExtractionBlocks('旅人敲门。')[0];
    const legacy = extractionContext(state, block); const readable = extractionContext(state, block, 'text');
    expect(legacy).toContain('"name":"旅人"'); expect(legacy).toContain('"title":"门后的声音"');
    expect(readable).toContain('名称：旅人'); expect(readable).toContain('- 旧称'); expect(readable).toContain('标题：门后的声音');
    expect(readable).not.toMatch(/[{}\[\]]/);
    const supplied = { context: legacy };
    expect(prepareReadablePromptVariables('extraction', supplied)).toEqual({ context: legacy, extractionIndexText: readable });
    expect(supplied).toEqual({ context: legacy });
    const empty = emptyState();
    expect(prepareReadablePromptVariables('extraction', { context: extractionContext(empty, block) }).extractionIndexText).toBe(extractionContext(empty, block, 'text'));
  });

  it('does not reinterpret author extraction prose or malformed index-looking values', () => {
    for (const context of [
      '作者自写的对照资料。\n保留 {括号}、{{变量}} 和原文格式。',
      '名称对照（仅用于统一称呼，不是新增事实的证据）：[]\n尚未揭晓的伏笔索引（不可据此推断答案）：{"title":"这不是数组"}',
      '名称对照（仅用于统一称呼，不是新增事实的证据）：[不完整JSON]\n尚未揭晓的伏笔索引（不可据此推断答案）：[]',
    ]) expect(prepareReadablePromptVariables('extraction', { context }).extractionIndexText).toBe(context);
  });
});
