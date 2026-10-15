import { describe, expect, it } from 'vitest';
import { dramatronSource } from '../shared/dramatron-source.js';
import { previousGeneralPromptTemplates } from '../shared/previous-general-prompt-templates.js';
import { compileTaskPrompt, defaultPromptTemplates, normalizePromptTemplates, validatePromptTemplates } from '../shared/prompt-templates.js';
import { cleanDramatronText, createDramatronTextFilter } from '../shared/dramatron-output.js';
import { buildRequestSnapshot, estimateModelRequestInputTokens } from '../server/providers.js';
import type { PromptFeature, PromptTask, ProviderConfig } from '../shared/types.js';

const variables = { mode: 'original', instruction: '继续故事', context: '当前故事资料', chapterNumber: 2, endChapter: 5, maxWords: 1500, chapterTitle: '雨夜', blockText: '[1] 信使抵达码头。', summaryText: '信使抵达码头。' };
const config: ProviderConfig = { id: 'local', name: 'local', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1', model: 'local', maxOutputTokens: 4096, contextTokens: 64000 };

describe('Dramatron anti-truncation and empty-response structure', () => {
  it('retains the original long filler, CLEAR and identity modules before actual task material', () => {
    const settings = defaultPromptTemplates(); const blocks = settings.general!.presets[0].blocks;
    expect(blocks.find(block => block.feature === 'snow')!.content).toBe(dramatronSource['a443f257-0f5d-4286-a1ff-f60653ed6400'].content);
    expect(blocks.find(block => block.id === 'clear')!.content).toBe(dramatronSource.main.content);
    const request = compileTaskPrompt(settings, 'writing', variables);
    expect(request.messages[0].content.length).toBeGreaterThan(13000);
    expect(request.messages[1].content).toContain('[START A NEW CHAT]');
    expect(request.messages.some(message => message.content.includes('<instructions>'))).toBe(false);
    expect(request.system).toContain('<Interleaved_thinking>'); expect(request.system).toContain('<thinking_format>');
    expect(request.system).not.toContain('<disclaimer_format>'); expect(request.system).not.toContain('<Reference_Example_format>');
    expect(JSON.stringify(request.messages)).not.toMatch(/\{\{(?:getvar|setvar)::/);
    const dialogue = request.messages.filter(message => message.role !== 'system');
    expect(dialogue.every((message, index) => !index || message.role !== dialogue[index - 1].role)).toBe(true);
    const noSnow = structuredClone(settings); noSnow.general!.presets[0].blocks.find(block=>block.feature==='snow')!.enabled = false;
    expect(estimateModelRequestInputTokens(config, request) - estimateModelRequestInputTokens(config, compileTaskPrompt(noSnow, 'writing', variables))).toBeGreaterThan(7000);
    expect(buildRequestSnapshot(config, request).body).toContain('冬马和纱');
  });
  it('keeps filler literal and preserves changed first-generation presets during exact default migration', () => {
    const original = structuredClone(previousGeneralPromptTemplates); const before = structuredClone(original);
    expect(normalizePromptTemplates(original).general).toEqual(defaultPromptTemplates().general); expect(normalizePromptTemplates(original).presets.writing).toEqual(defaultPromptTemplates().presets.writing); expect(original).toEqual(before);
    original.general!.presets[0].blocks[0].content += '\n自定义通用规则';
    original.presets.writing[0].blocks[0].content += '\n自定义写作规则';
    expect(normalizePromptTemplates(original).general!.presets[0]).toEqual(original.general!.presets[0]); expect(normalizePromptTemplates(original).presets.writing.slice(0, original.presets.writing.length)).toEqual(original.presets.writing);
    const settings = defaultPromptTemplates(); settings.general!.presets[0].blocks[0].content = '自定义填充 {{not_a_variable}}';
    expect(compileTaskPrompt(settings, 'writing', variables).messages[0].content).toBe('自定义填充 {{not_a_variable}}');
    expect(normalizePromptTemplates(normalizePromptTemplates(settings))).toEqual(settings);
  });
  it('makes both sets of alternatives exclusive and skips prose tails for native submission contracts', () => {
    const settings = defaultPromptTemplates(); const blocks = settings.general!.presets[0].blocks;
    const feature = (name: PromptFeature) => blocks.find(block=>block.feature===name)!;
    feature('cot-single').enabled = true; expect(()=>validatePromptTemplates(settings)).toThrow('三段与单段'); feature('cot-three').enabled = false;
    expect(compileTaskPrompt(settings, 'writing', variables).system).not.toContain('<Interleaved_thinking>');
    feature('defense-normal').enabled = true; feature('defense-laoda').enabled = true;
    expect(()=>validatePromptTemplates(settings)).toThrow('普通与牢大'); feature('defense-laoda').enabled = false;
    for (const task of ['writing', 'extraction', 'compression'] as PromptTask[]) expect(compileTaskPrompt(settings, task, variables).system).toContain('<disclaimer_format>');
    settings.presets.writing[0].writingOutputMode = 'tool';
    for (const [task, runtime] of [['writing', {}], ['extraction', { extractionOutputMode: 'tool' }], ['extraction', { extractionOutputMode: 'structured' }]] as const) expect(compileTaskPrompt(settings, task, variables, runtime).system).not.toContain('<disclaimer_format>');
    expect(compileTaskPrompt(settings, 'writing', variables).system).toContain('<thinking_format>');
    for (const task of ['extraction', 'compression'] as PromptTask[]) expect(compileTaskPrompt(settings, task, variables).system).not.toContain('<thinking_format>');
  });
  it('cleans streamed envelopes at every character boundary without losing prose or JSON evidence', () => {
    const raw = '<Interleaving><thinking>场景核对</thinking>正文一。<think>后续核对</think>正文二。</Interleaving><disclaimer>辅助尾段</disclaimer><Reference_Example>参考例</Reference_Example>';
    for (let split = 0; split <= raw.length; split++) { const filter=createDramatronTextFilter(); expect(filter.feed(raw.slice(0,split))+filter.feed(raw.slice(split))+filter.finish()).toBe('正文一。正文二。'); }
    expect(cleanDramatronText('正文。<thinking>未完成的辅助内容')).toBe('正文。');
    expect(cleanDramatronText('<thinking>只有辅助内容</thinking>')).toBe('');
    const json = JSON.stringify({ text: '原文包含 <thinking> 标记、\\ 和 " 引号' });
    const filter=createDramatronTextFilter(); let output=''; for(const char of '<Interleaving>'+json+'</Interleaving><disclaimer>辅助</disclaimer>') output+=filter.feed(char);
    expect(output+filter.finish()).toBe(json);
    expect(cleanDramatronText('两个数满足 1 < 2。')).toBe('两个数满足 1 < 2。');
    const comparison='数字 1 < 2。<thinking>辅助推演</thinking>继续正文。';
    for(let split=0; split<=comparison.length; split++) { const filter=createDramatronTextFilter(); expect(filter.feed(comparison.slice(0,split))+filter.feed(comparison.slice(split))+filter.finish()).toBe('数字 1 < 2。继续正文。'); }
  });
  it('separates preset thoughts in prose order at every split without displaying auxiliary tails or JSON field values', () => {
    const raw = '前文。<Interleaving><thinking>先核对<think>资料</think>。</thinking>中段。<think>再核对。</think>结尾。</Interleaving><Reference_Example><thinking>尾段示例</thinking></Reference_Example>';
    for (let split = 0; split <= raw.length; split++) {
      let prose = '';
      const thoughts = new Map<string, { text: string; offset: number; done: boolean }>();
      const filter = createDramatronTextFilter({ onText: value => { prose += value; }, onThinking: event => {
        const thought = thoughts.get(event.id) ?? { text: '', offset: prose.length, done: false };
        if ('text' in event) thought.text += event.text; else thought.done = true;
        thoughts.set(event.id, thought);
      } });
      expect(filter.feed(raw.slice(0, split)) + filter.feed(raw.slice(split)) + filter.finish()).toBe('前文。中段。结尾。');
      expect(prose).toBe('前文。中段。结尾。');
      expect([...thoughts.values()]).toEqual([{ text: '先核对资料。', offset: 3, done: true }, { text: '再核对。', offset: 6, done: true }]);
    }
    const events: unknown[] = [];
    const quoted = createDramatronTextFilter({ onThinking: event => events.push(event) });
    const evidence = JSON.stringify({ text: '<thinking>原文证据</thinking>' });
    expect(quoted.feed(evidence) + quoted.finish()).toBe(evidence); expect(events).toEqual([]);
    const unfinished = createDramatronTextFilter({ onThinking: event => events.push(event) });
    expect(unfinished.feed('正文。<thinking>已收到的辅助思考') + unfinished.finish()).toBe('正文。');
    expect(events).toEqual([{ id: 'preset:0', text: '已收到的辅助思考' }]);
  });
});
