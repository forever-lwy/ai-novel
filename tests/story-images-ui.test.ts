import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImageGallery, ImageGenerationDetails, ImageRequestDialog, StoryImageCards, latestImage } from '../client/StoryImages';
import { ImageSettingsEditor } from '../client/SettingsPanel';
import { ImageViewer } from '../client/ImageViewer';
import { LocationPanel, WorldPanel } from '../client/WorldPanel';
import type { Entity, ImageSettings, Settings, StoryImage } from '../shared/types';
import { defaultImageSettings } from '../shared/image-settings';

const person: Entity = { id: 'person', kind: 'character', name: '林舟', aliases: [], description: '旅人', visibility: 'public', locked: true, facts: [] };
const image = (patch: Partial<StoryImage> = {}): StoryImage => ({ id: 'portrait', projectId: 'project', branchId: 'branch', baseRevisionId: 'revision', kind: 'portrait', status: 'completed', title: '林舟 · 立绘', prompt: 'SECRET_IMAGE_PROMPT', sourceText: 'SECRET_IMAGE_SOURCE', automatic: false, visibility: 'public', createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z', entityId: person.id, url: '/api/image.png', ...patch });
const render = (component: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(component);

describe('story illustration controls', () => {
  it('reader cards show only images and bindings, without author materials or generation actions', () => {
    const html = render(createElement(StoryImageCards, { images: [image({ chapterId: 'chapter', error: 'SECRET_IMAGE_ERROR' })], author: false, onGenerate: () => {}, onAction: () => {}, onChapter: () => {}, onEntity: () => {} }));
    expect(html).toContain('alt="林舟 · 立绘"'); expect(html).toContain('关联剧情'); expect(html).toContain('关联资料');
    expect(html).not.toContain('SECRET_IMAGE'); expect(html).not.toContain('重新绘制'); expect(html).not.toContain('AI 修改'); expect(html).not.toContain('生图详情'); expect(html).not.toContain('启用图片'); expect(html).not.toContain('删除图片');
  });

  it('authors can redraw or edit completed images, explicitly retry interrupted work, and cancel active requests', () => {
    const html = render(createElement(StoryImageCards, { images: [image(), image({ id: 'failed', status: 'failed', error: 'HTTP 500', url: undefined }), image({ id: 'paused', status: 'paused', url: undefined }), image({ id: 'active', status: 'running', url: undefined })], author: true, onGenerate: () => {}, onAction: () => {} }));
    expect(html).toContain('重新绘制'); expect(html).toContain('AI 修改'); expect(html).toContain('HTTP 500'); expect(html).toContain('重试绘制'); expect(html).toContain('恢复绘制'); expect(html).toContain('取消绘制');
  });

  it('keeps the latest successful portrait visible while a later request is pending or has failed', () => {
    const first = image({ id: 'first' }); const newest = image({ id: 'newest', createdAt: '2026-10-04T01:00:00Z', url: '/latest.png' });
    const pending = image({ id: 'pending', status: 'running', createdAt: '2026-10-04T02:00:00Z', url: undefined });
    const failed = image({ id: 'failed', status: 'failed', createdAt: '2026-10-04T03:00:00Z', url: undefined });
    expect(latestImage([first, newest, pending, failed], person.id)).toBe(newest);
    const html = render(createElement(WorldPanel, { entities: [person], relations: [], images: [first, newest, pending, failed], revisionId: 'revision', author: true, busy: false, error: '', onSave: async () => true, onMerge: async () => true, onCitation: () => {}, onGenerateImage: () => {} }));
    expect(html).toContain('src="/latest.png"'); expect(html).toContain('重新绘制');
  });

  it('requires edit instructions with a reference, and lists all four illustration types in the gallery', () => {
    const html = render(createElement(ImageRequestDialog, { target: { kind: 'portrait', entityId: person.id, referenceImageId: 'portrait' }, title: 'AI 修改人物立绘', reference: image(), busy: false, error: '', onClose: () => {}, onSubmit: async () => {} }));
    expect(html).toMatch(/<textarea[^>]*required/); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/); expect(html).toContain('src="/api/image.png"');
    const gallery = render(createElement(ImageGallery, { images: [image()], entities: [person], chapters: [], author: true, busy: false, onGenerate: () => {}, onAction: () => {}, onChapter: () => {}, onEntity: () => {} }));
    for (const kind of ['人物立绘', '剧情 CG', '资料图片', '世界地图']) expect(gallery).toContain(kind);
  });

  it('offers map generation only to authors with geographical material', () => {
    const location = { ...person, id: 'city', kind: 'location' as const, name: '白石城' };
    const author = render(createElement(LocationPanel, { entities: [location], relations: [], author: true, onCitation: () => {}, onGenerateImage: () => {} }));
    const reader = render(createElement(LocationPanel, { entities: [location], relations: [], onCitation: () => {}, onGenerateImage: () => {} }));
    expect(author).toContain('生成世界地图'); expect(reader).not.toContain('生成世界地图');
  });

  it('shows the optimized prompt, persisted parameters, and character reference snapshot in author details', () => {
    const html = render(createElement(ImageGenerationDetails, { image: image({ promptStatus: 'completed', prompt: 'Optimized scene lighting and character composition.', generationParameters: { protocol: 'gemini', model: 'gemini-3.1-flash-image-preview', aspectRatio: '16:9', imageSize: '2K', thinkingLevel: 'high', temperature: 0.7, systemInstruction: '保留人物外观。' }, referenceCharacters: [{ entityId: 'person', name: '林舟', imageId: 'portrait' }] }) }));
    expect(html).toContain('AI 优化后的生图提示词'); expect(html).toContain('Optimized scene lighting'); expect(html).toContain('16:9'); expect(html).toContain('2K'); expect(html).toContain('思考等级'); expect(html).toContain('0.7'); expect(html).toContain('保留人物外观'); expect(html).toContain('本次人物参考'); expect(html).toContain('林舟');
    const pending = render(createElement(ImageGenerationDetails, { image: image({ promptStatus: 'pending', prompt: 'RAW_MATERIAL_MUST_NOT_BE_CALLED_OPTIMIZED' }) }));
    expect(pending).toContain('生图提示词尚未完成'); expect(pending).not.toContain('RAW_MATERIAL');
  });

  it('uses the selected older image rather than a later parked variant, while retaining legacy compatibility', () => {
    const selected = image({ id: 'selected', active: true, url: '/selected.png' }); const parked = image({ id: 'parked', active: false, createdAt: '2026-10-04T02:00:00Z', url: '/parked.png' });
    expect(latestImage([selected, parked], person.id)).toBe(selected); expect(latestImage([image({ active: false })], person.id)).toBeUndefined(); expect(latestImage([image()], person.id)?.id).toBe('portrait');
    const html = render(createElement(WorldPanel, { entities: [person], relations: [], images: [selected, parked], revisionId: 'revision', author: true, busy: false, error: '', onSave: async () => true, onMerge: async () => true, onCitation: () => {} }));
    expect(html).toContain('src="/selected.png"'); expect(html).not.toContain('src="/parked.png"');
  });

  it('makes parked variants previewable and deletable, but requires activation before AI editing', () => {
    const html = render(createElement(StoryImageCards, { images: [image({ active: false })], author: true, onGenerate: () => {}, onAction: () => {} }));
    expect(html).toContain('未启用 · 暂存'); expect(html).toContain('启用图片'); expect(html).toContain('删除图片'); expect(html).toContain('查看图片 林舟 · 立绘');
    const editButton = html.match(/<button[^>]*disabled=""[^>]*>[^]*?启用后可修改<\/button>/)?.[0]; expect(editButton).toBeTruthy();
    const reader = render(createElement(StoryImageCards, { images: [image({ active: false })], author: false })); expect(reader).not.toContain('林舟 · 立绘');
  });

  it('provides a scrollable viewer with zoom, fitting, original size and user-triggered fullscreen controls', () => {
    const html = render(createElement(ImageViewer, { image: image(), onClose: () => {} }));
    for (const label of ['放大图片', '缩小图片', '调整图片缩放', '适应窗口', '原始大小', '全屏查看图片', '关闭图片查看器', '可滚动的图片区域']) expect(html).toContain(label);
    expect(html).toContain('max="400"'); expect(html).toContain('data-fullscreen-mode="none"');
  });
});

const settingsWith = (patch: Partial<ImageSettings>): Settings => ({ providers: [{ id: 'provider', name: '测试供应商', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1/v1' }], writingProviderId: 'provider', planningProviderId: 'provider', extractionProviderId: 'provider', writingModel: 'writing-model', planningModel: 'planning-model', imageSettings: { ...defaultImageSettings(), providerId: 'provider', ...patch } });
const settingsHtml = (patch: Partial<ImageSettings>) => render(createElement(ImageSettingsEditor, { settings: settingsWith(patch), onChange: () => {} }));
const selectHtml = (html: string, label: string) => html.match(new RegExp(`<select aria-label="${label}"[^>]*>[\\s\\S]*?<\\/select>`))?.[0] || '';

describe('image settings reflect image model capabilities', () => {
  it('exposes Nano Banana 2 image controls and preserves legacy default proportions until auto is explicitly selected', () => {
    const html = settingsHtml({ protocol: 'gemini', model: 'gemini-3.1-flash-image-preview', size: '1024x1536' });
    const levels = selectHtml(html, '图片模型思考等级'); expect(levels).toContain('value="minimal"'); expect(levels).toContain('value="high"'); expect(levels).not.toContain('value="low"'); expect(levels).not.toContain('value="medium"');
    const sizes = selectHtml(html, '图片分辨率'); for (const value of ['512', '1K', '2K', '4K']) expect(sizes).toContain(`value="${value}"`);
    expect(sizes).toContain('value="" selected=""'); expect(selectHtml(html, '画幅比例')).toContain('value="2:3" selected=""'); expect(selectHtml(html, '画幅比例')).toContain('value="8:1"');
    expect(html).toContain('图片模型系统提示词'); expect(html).toContain('图片模型 Temperature'); expect(html).toContain('人物参考最多 4 人'); expect(html).not.toContain('aria-label="生成质量"');
    expect(html).toContain('生图提示词优化供应商'); expect(html).toContain('生图提示词优化模型'); expect(html).toContain('planning-model');
  });

  it('does not offer text-model thinking choices or unsupported image resolutions to other Gemini image models', () => {
    const pro = selectHtml(settingsHtml({ protocol: 'gemini', model: 'gemini-3-pro-image-preview' }), '图片模型思考等级'); expect(pro).toContain('value="high"'); expect(pro).not.toContain('value="minimal"'); expect(pro).not.toContain('value="low"');
    const earlier = settingsHtml({ protocol: 'gemini', model: 'gemini-2.5-flash-image' }); expect(earlier).not.toContain('aria-label="图片模型思考等级"'); expect(earlier).not.toContain('aria-label="图片分辨率"');
  });

  it('offers GPT Image 2 custom sizes, while mini only exposes its supported reference fidelity', () => {
    const gpt2 = settingsHtml({ protocol: 'openai-images', model: 'gpt-image-2', size: '3072x2048' }); expect(gpt2).toContain('aria-label="自定义图片尺寸"'); expect(gpt2).toContain('value="3072x2048"'); expect(gpt2).toContain('AI 自行决定'); expect(gpt2).not.toContain('aria-label="参考图保真度"');
    const mini = selectHtml(settingsHtml({ protocol: 'openai-images', model: 'gpt-image-1-mini' }), '参考图保真度'); expect(mini).toContain('value="low"'); expect(mini).not.toContain('value="high"');
  });

  it('offers Together dimensions and model-specific controls rather than unsupported quality or thinking fields', () => {
    const flux = settingsHtml({ protocol: 'together-images', model: 'black-forest-labs/FLUX.2-dev' }); expect(flux).toContain('aria-label="自定义图片宽度"'); expect(flux).toContain('aria-label="采样步数"'); expect(flux).toContain('aria-label="提示词引导强度"'); expect(flux).not.toContain('aria-label="负面提示词"'); expect(flux).not.toContain('aria-label="生成质量"'); expect(flux).not.toContain('aria-label="图片模型思考等级"');
    const kontext = settingsHtml({ protocol: 'together-images', model: 'black-forest-labs/FLUX.1-kontext-pro' }); expect(kontext).toContain('aria-label="画幅比例"'); expect(kontext).toContain('支持一张参考图'); expect(kontext).not.toContain('aria-label="图片分辨率"'); expect(kontext).not.toContain('aria-label="自定义图片宽度"');
  });
});
