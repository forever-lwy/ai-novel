import { describe, expect, it } from 'vitest';
import { extractionFixtureParagraphs, imageFixtureInput } from './prompt-fixture-input.mjs';
import { compileTaskPrompt, defaultPromptTemplates } from '../shared/prompt-templates.js';
import { TASK_V3_PRESET_IDS } from '../shared/task-prompts-v3.js';

const material = {
  kind: 'cg', material: '庭院门上有 {弯曲符号}。', storyContext: '目标前文：旅人推开门。\n目标后文：他抬头看见天空。',
  instruction: '保留外貌', stylePrompt: '古典插画',
  characters: [{ entityId: 'traveler', name: '旅人', description: '蓝色斗篷', imageId: 'portrait' }],
  references: [{ entityId: 'traveler', imageId: 'chosen', label: '作者选择' }], referenceSelection: 'manual',
  referenceInstruction: '作者已指定参考，不增删或替换。',
  config: { protocol: 'gemini', model: 'gemini-3.1-flash-image', size: 'auto', aspectRatio: 'auto', imageSize: 'auto' },
  allowed: { maxCharacterReferences: 0 },
};
const userText = (request: ReturnType<typeof compileTaskPrompt>) => request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');

describe('local model fixture input editions', () => {
  it.each(['v3', 'v4'])('reads %s image data without changing the production request format', edition => {
    const templates = defaultPromptTemplates();
    if (edition === 'v3') templates.selected.image = TASK_V3_PRESET_IDS.image;
    const request = compileTaskPrompt(templates, 'image', { imageInput: JSON.stringify(material), maxCharacterReferences: 0, imageSystemPrompt: '保留蓝色。' });
    const prompt = userText(request);
    if (edition === 'v4') {
      expect(prompt).toContain('# 本次画面资料'); expect(prompt).not.toContain('"material":');
      expect(prompt).toContain('绘图配置：'); expect(prompt).toContain('参考图说明：');
    }
    else expect(prompt.trim()).toMatch(/^\{/);
    expect(imageFixtureInput(prompt)).toMatchObject({ material: material.material, storyContext: material.storyContext, instruction: material.instruction, config: material.config, characters: material.characters, references: material.references, referenceSelection: 'manual', referenceInstruction: material.referenceInstruction, allowed: { maxCharacterReferences: 0 } });
  });

  describe.each(['v3', 'v4'])('%s fixed image settings', edition => {
    it.each([
      { protocol: 'openai-images', model: 'gpt-image-1', size: '1536x1024' },
      { protocol: 'gemini', model: 'gemini-3.1-flash-image', size: 'auto', aspectRatio: '16:9', imageSize: '2K' },
      { protocol: 'together-images', model: 'black-forest-labs/FLUX.2-dev', size: 'auto', width: 1536, height: 1024 },
    ])('reads $protocol fixed parameters without dropping values', config => {
      const templates = defaultPromptTemplates(); if (edition === 'v3') templates.selected.image = TASK_V3_PRESET_IDS.image;
      const request = compileTaskPrompt(templates, 'image', { imageInput: JSON.stringify({ ...material, config }), maxCharacterReferences: 0 });
      expect(imageFixtureInput(userText(request)).config).toMatchObject(config);
    });
  });

  it.each(['v3', 'v4'])('reads numbered source paragraphs from %s extraction data', edition => {
    const templates = defaultPromptTemplates(); if (edition === 'v3') templates.selected.extraction = TASK_V3_PRESET_IDS.extraction;
    const request = compileTaskPrompt(templates, 'extraction', { context: '{}', chapterTitle: '庭院', blockText: '[1] 旅人推开门。\n[2] 他抬头看见天空。' });
    expect(extractionFixtureParagraphs(userText(request))).toEqual([{ paragraph: 1, quote: '旅人推开门。' }, { paragraph: 2, quote: '他抬头看见天空。' }]);
  });
});
