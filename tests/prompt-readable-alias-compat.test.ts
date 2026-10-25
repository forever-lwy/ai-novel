import { describe, expect, it } from 'vitest';
import { activePromptPreset, compilePrompt, defaultPromptTemplates, normalizePromptTemplates, promptPresetVariables } from '../shared/prompt-templates.js';
import { prepareReadablePromptVariables } from '../shared/prompt-readable-variables.js';
import { createTavernMacroExpander } from '../shared/tavern-macros.js';
import type { PromptBlock, PromptPreset } from '../shared/types.js';
import { withPriorDefaultSelections } from './fixtures/prompt-presets.js';

const aliases = ['storyMaterialsText', 'recentChaptersText', 'continuationAnchorText', 'contextText', 'extractionIndexText', 'imageInputText'];
const block = (id: string, role: PromptBlock['role'], content: string, feature?: PromptBlock['feature']): PromptBlock => ({ id, name: id, role, content, enabled: true, ...(feature ? { feature } : {}) });
const scopedBlocks = (preset: PromptPreset, scope: 'general' | 'task', feature?: PromptBlock['feature']) => {
  preset.blocks = scope === 'general'
    ? [block('general-aliases', 'system', `GENERAL=${aliases.map(key => `{{${key}}}`).join('|')}`, feature), { ...block('task-slot', 'system', ''), slot: 'task' }]
    : [block('task-aliases', 'user', `TASK=${aliases.map(key => `{{${key}}}`).join('|')}`, feature)];
};

describe('readable aliases preserve author custom variables', () => {
  it('accepts previously legal names and keeps general and task values in their own scope', () => {
    const settings = withPriorDefaultSelections();
    const task = activePromptPreset(settings, 'writing'); const general = activePromptPreset(settings, 'general');
    task.variables = Object.fromEntries(aliases.map(key => [key, `任务 ${key}：{原样} "{{instruction}}" <thought>资料</thought>`]));
    general.variables = Object.fromEntries(aliases.map(key => [key, `通用 ${key}：{{instruction}}`]));
    scopedBlocks(task, 'task'); scopedBlocks(general, 'general');
    const variables = { instruction: '不应二次展开', storyMaterials: '{"worldview":"实际设定"}', recentChapters: '历史正文', continuationAnchor: '正文末尾', imageInputText: '调用方生成的图像资料' };
    const originalSettings = structuredClone(settings); const originalVariables = structuredClone(variables);
    const result = compilePrompt(settings, 'writing', variables);
    expect(result.messages.find(value => value.content.startsWith('TASK='))?.content).toBe(`TASK=${Object.values(task.variables).join('|')}`);
    expect(result.messages.find(value => value.content.startsWith('GENERAL='))?.content).toBe(`GENERAL=${Object.values(general.variables).join('|')}`);
    expect(normalizePromptTemplates(settings).selected.writing).toBe('default-writing');
    expect(promptPresetVariables('writing', task).filter(value => value.key === 'storyMaterialsText')).toEqual([{ key: 'storyMaterialsText', label: '自定义变量 · storyMaterialsText' }]);
    expect(settings).toEqual(originalSettings); expect(variables).toEqual(originalVariables);
  });

  it('still prepares aliases when no author variable has that name', () => {
    const variables = { mode: 'continuation', instruction: '接着写', maxWords: 800, writingTarget: '下一段', storyMaterials: '{"worldview":"真实设定"}', recentChapters: '[{"chapterId":"c1","title":"旧门","text":"历史正文。"}]', continuationAnchor: '{"chapterId":"c1","title":"旧门","ending":"正文末尾。"}' };
    const writing = compilePrompt(defaultPromptTemplates(), 'writing', variables);
    expect(writing.prompt).toContain('## 世界设定\n\n真实设定'); expect(writing.prompt).toContain('## 旧门'); expect(writing.prompt).toContain('正文末尾。');
    expect(compilePrompt(defaultPromptTemplates(), 'extraction', { context: '[{"name":"旅人"}]', blockText: '[1] 旅人敲门。' }).prompt).toContain('名称：旅人');
    expect(compilePrompt(defaultPromptTemplates(), 'image', { imageInput: '{"material":"门前画面"}' }).prompt).toContain('目标素材：门前画面');
  });

  it('keeps an old imageInputText custom value ahead of generated and explicitly supplied aliases', () => {
    const settings = withPriorDefaultSelections(); const task = activePromptPreset(settings, 'image');
    task.useGeneral = false; task.variables = { imageInputText: '作者图像资料 {{instruction}}' };
    task.blocks = [block('image-custom', 'user', '{{imageInputText}}')];
    const original = structuredClone(settings);
    for (const variables of [{ imageInput: '{"material":"实际素材"}', instruction: '不替换' }, { imageInput: '{"material":"实际素材"}', imageInputText: '程序已生成的素材', instruction: '不替换' }]) {
      const input = structuredClone(variables);
      expect(compilePrompt(settings, 'image', variables).prompt).toBe('作者图像资料 {{instruction}}');
      expect(variables).toEqual(input);
    }
    expect(settings).toEqual(original);
  });

  it('scopes Tavern alias values while preserving shared local variables and random state', () => {
    const settings = withPriorDefaultSelections(); const task = activePromptPreset(settings, 'writing'); const general = activePromptPreset(settings, 'general');
    task.variables = { storyMaterialsText: '任务 {{setvar::injected::不执行}}' }; general.variables = { storyMaterialsText: '通用 {{instruction}}' };
    task.blocks = [block('task-tavern', 'user', '{{setvar::carry::保留}}{{roll 1d1000000}}|TASK={{storyMaterialsText}}|{{getvar::injected}}', 'tavern')];
    general.blocks = [block('general-tavern', 'system', '{{roll 1d1000000}}|GENERAL={{storyMaterialsText}}|{{getvar::carry}}', 'tavern'), { ...block('task-slot', 'system', ''), slot: 'task' }];
    const variables = { storyMaterials: '{"worldview":"实际设定"}', instruction: '不替换' };
    const prepared = prepareReadablePromptVariables('writing', variables);
    const random = createTavernMacroExpander({}, JSON.stringify(prepared));
    const firstRoll = random('{{roll 1d1000000}}'); const secondRoll = random('{{roll 1d1000000}}');
    const originalSettings = structuredClone(settings); const originalVariables = structuredClone(variables);
    const result = compilePrompt(settings, 'writing', variables);
    expect(result.messages.find(value => value.role === 'user')?.content).toBe(`${firstRoll}|TASK=任务 {{setvar::injected::不执行}}|`);
    expect(result.messages.find(value => value.role === 'system')?.content).toBe(`${secondRoll}|GENERAL=通用 {{instruction}}|保留`);
    expect(compilePrompt(settings, 'writing', variables)).toEqual(result);
    expect(settings).toEqual(originalSettings); expect(variables).toEqual(originalVariables);
  });

  it('does not leak a general custom alias into a task that uses the generated value', () => {
    const settings = withPriorDefaultSelections(); const task = activePromptPreset(settings, 'writing'); const general = activePromptPreset(settings, 'general');
    general.variables = { storyMaterialsText: '仅属于通用预设' };
    task.blocks = [block('task-tavern', 'user', 'TASK={{storyMaterialsText}}', 'tavern')];
    general.blocks = [block('general-tavern', 'system', 'GENERAL={{storyMaterialsText}}', 'tavern'), { ...block('task-slot', 'system', ''), slot: 'task' }];
    const result = compilePrompt(settings, 'writing', { storyMaterials: '{"worldview":"真实设定"}' });
    expect(result.messages.find(value => value.role === 'user')?.content).toBe('TASK=## 世界设定\n\n真实设定');
    expect(result.messages.find(value => value.role === 'system')?.content).toBe('GENERAL=仅属于通用预设');
  });

  it('also respects explicit empty aliases in new editions without relaxing older reserved names', () => {
    const settings = defaultPromptTemplates(); const task = activePromptPreset(settings, 'writing');
    task.variables = { storyMaterialsText: '' }; task.blocks = [block('new-alias', 'user', '作者值=[{{storyMaterialsText}}]')];
    expect(compilePrompt(settings, 'writing', { storyMaterials: '{"worldview":"真实设定"}' }).prompt).toBe('作者值=[]');
    for (const key of ['context', 'instruction']) {
      task.variables = { [key]: '过去就不允许覆盖' };
      expect(() => normalizePromptTemplates(settings)).toThrow('自定义变量不能覆盖内置变量');
    }
  });
});
