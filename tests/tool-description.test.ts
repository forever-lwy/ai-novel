import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { StoryEngine } from '../server/engine.js';
import { activePromptPreset, defaultPromptTemplates } from '../shared/prompt-templates.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import type { ProviderProtocol, Settings } from '../shared/types.js';

const fixtures: { store: Store; engine: StoryEngine }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.engine.close(); fixture.store.close(); }
});
function harness() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-tool-contracts-')));
  const settings: Settings = {
    providers: [],
    imageSettings: { ...defaultImageSettings(), model: 'gpt-image-2', size: 'auto',
      stylePrompt: 'TOOL_GUIDE_STYLE：水彩画风。', promptSystemPrompt: 'TOOL_GUIDE_AUTHOR：人物外貌以已有立绘为准。' },
  };
  const engine = new StoryEngine(store, () => settings); fixtures.push({ store, engine });
  const templates = defaultPromptTemplates(); activePromptPreset(templates, 'writing').writingOutputMode = 'text';
  return { engine, templates, settings };
}

describe.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('%s built-in tool contracts', protocol => {
  it('keeps drawing settings outside tool descriptions in the actual request preview', () => {
    const { engine, templates } = harness();
    const preview = engine.previewPrompt({ task: 'writing', templates, protocol,
      variables: { mode: 'original', instruction: '续写城门前的故事。', maxWords: '1000', context: '林舟来到城门。' },
      runtime: { illustrations: { portrait: true, cg: true } } });
    const cg = preview.tools.find(tool => tool.name === 'generate_scene_cg')!;
    const portrait = preview.tools.find(tool => tool.name === 'generate_character_portrait')!;
    expect(cg.parameters.required).toEqual(['prompt', 'sourceText']);
    expect(portrait.parameters.required).toEqual(['name', 'description']);
    expect(cg.description).toContain('requested'); expect(cg.description).toContain('rejected/error');
    const descriptions = JSON.stringify([cg, portrait]);
    expect(descriptions).not.toMatch(/首次出场|主动调用|继续写作|不必等待|无需等待|另一个 AI|准备调用|纠错旁白|当前绘图要求|fixedParameters/);
    expect(descriptions).not.toContain('TOOL_GUIDE_STYLE'); expect(descriptions).not.toContain('TOOL_GUIDE_AUTHOR');
    const messages = preview.messages.map(message => message.content).join('\n');
    expect(messages).toContain('本次绘图设置');
    expect(messages).toContain('TOOL_GUIDE_STYLE：水彩画风。');
    expect(messages).toContain('TOOL_GUIDE_AUTHOR：人物外貌以已有立绘为准。');
    expect(messages).toContain('尺寸 size：自动选择');
    expect(messages).not.toContain('宽度 width：');
    expect(messages).toContain('须为 16 的整数倍');
    expect(messages).toContain('最多总像素：8294400');
  });

  it('describes player questions without putting story direction policy into the tool', () => {
    const { engine, templates } = harness();
    const preview = engine.previewPrompt({ task: 'writing', templates, protocol,
      variables: { mode: 'rpg', instruction: '观察城门。', maxWords: '1000', context: '城门前有两条路。' },
      runtime: { rpg: { character: { kind: 'original', name: '旅人', description: '一位刚进城的旅人。' }, entryInstruction: '从城门开始。' } } });
    const tool = preview.tools.find(value => value.name === 'ask_user')!;
    expect(tool.description).toContain('用户回答');
    expect(tool.description).not.toMatch(/关键剧情|不能替|未来剧情|隐藏设定|基于角色当前/);
    expect(tool.parameters.required).toEqual(['question', 'options']);
    expect(preview.tools.some(value => value.name.startsWith('generate_'))).toBe(false);
    expect(preview.messages.map(message => message.content).join('\n')).not.toContain('TOOL_GUIDE_STYLE');
  });
});

it('shows the effective inherited Gemini ratio and default resolution', () => {
  const { engine, templates, settings } = harness();
  settings.imageSettings = { ...settings.imageSettings!, protocol: 'gemini', model: 'gemini-3.1-flash-image', size: '1024x1536' };
  const preview = engine.previewPrompt({ task: 'writing', templates, protocol: 'gemini',
    variables: { mode: 'original', instruction: '续写。', context: '', maxWords: '1000' }, runtime: { illustrations: { portrait: false, cg: true } } });
  const messages = preview.messages.map(message => message.content).join('\n');
  expect(messages).toContain('画幅比例 aspectRatio：固定为 2:3（由已保存尺寸 1024x1536 换算）');
  expect(messages).toContain('分辨率 imageSize：固定为 1K（模型默认值）');
  expect(messages).not.toContain('宽度 width：');
});

it('shows effective fixed width and height for a width-height image model', () => {
  const { engine, templates, settings } = harness();
  settings.imageSettings = { ...settings.imageSettings!, protocol: 'together-images', model: 'black-forest-labs/flux.2-dev', size: '1536x1024', width: 1024 };
  const preview = engine.previewPrompt({ task: 'writing', templates, protocol: 'openai-chat',
    variables: { mode: 'original', instruction: '续写。', context: '', maxWords: '1000' }, runtime: { illustrations: { portrait: false, cg: true } } });
  const messages = preview.messages.map(message => message.content).join('\n');
  expect(messages).toContain('宽度 width：固定为 1024；高度 height：固定为 1024');
  expect(messages).toContain('须为 8 的整数倍');
});
