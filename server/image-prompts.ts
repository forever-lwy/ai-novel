import { z } from 'zod';
import type { ImageResolvedParameters, ImageSettings, Settings, StoryImageKind } from '../shared/types.js';
import { normalizeModelSettings, resolveModelConfig } from '../shared/model-settings.js';
import { imageModelCapabilities } from '../shared/image-capabilities.js';
import { generateStructured, estimateModelRequestInputTokens, structuredRequest } from './providers.js';
import { HttpError } from './store.js';
import { compileTaskPrompt } from '../shared/prompt-templates.js';
import { imageParametersSchema } from './image-store.js';

export interface ImagePromptInput {
  kind: StoryImageKind; material: string; storyContext?: string; instruction: string; stylePrompt: string; config: ImageSettings;
  characters: { entityId: string; name: string; description: string; imageId?: string }[];
  references: { label: string; entityId?: string; imageId: string }[];
  referenceSelection?: 'manual';
}
export interface OptimizedImagePrompt { prompt: string; referenceEntityIds: string[]; parameters: ImageResolvedParameters }
export type ImagePromptOptimizer = (settings: Settings, input: ImagePromptInput, signal?: AbortSignal) => Promise<OptimizedImagePrompt>;
const resultSchema = z.object({ prompt: z.string().trim().min(1).max(20000), referenceEntityIds: z.array(z.string().min(1)).max(16).default([]), parameters: imageParametersSchema.default({}) }).strict();

/** Author settings override model suggestions; only supported automatic dimensions may be chosen. */
export function resolveImageParameters(config: ImageSettings, suggestion: ImageResolvedParameters): ImageResolvedParameters {
  const caps = imageModelCapabilities(config); const result: ImageResolvedParameters = {};
  if (caps.dimensionMode === 'size') {
    result.size = config.size !== 'auto' ? config.size : suggestion.size;
    if (!result.size || result.size === 'auto' || !/^\d+x\d+$/.test(result.size)) throw new HttpError('提示词 AI 未返回有效的图片尺寸，请手动重试或设置固定尺寸');
    if (!caps.sizes.includes(result.size) && !caps.customSize) throw new HttpError('提示词 AI 选择的尺寸不受当前图片模型支持');
    const [width, height] = result.size.split('x').map(Number);
    if (width % caps.dimensionMultiple || height % caps.dimensionMultiple || width < caps.minDimension || height < caps.minDimension || width > caps.maxDimension || height > caps.maxDimension || caps.minPixels && width * height < caps.minPixels || caps.maxPixels && width * height > caps.maxPixels || caps.maxAspectRatio && Math.max(width / height, height / width) > caps.maxAspectRatio) throw new HttpError('提示词 AI 选择的尺寸超出当前图片模型的尺寸限制');
  } else if (caps.dimensionMode === 'aspect-ratio') {
    result.aspectRatio = config.aspectRatio && config.aspectRatio !== 'auto' ? config.aspectRatio : config.size !== 'auto' && !config.aspectRatio ? ({ '1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2' } as Record<string, string>)[config.size] : suggestion.aspectRatio;
    if (!result.aspectRatio || !caps.aspectRatios.includes(result.aspectRatio)) throw new HttpError('提示词 AI 未返回当前图片模型支持的画幅比例，请手动重试或设置固定比例');
  } else {
    const legacy = config.size !== 'auto' ? config.size.split('x').map(Number) : undefined;
    result.width = config.width ?? legacy?.[0] ?? suggestion.width; result.height = config.height ?? legacy?.[1] ?? suggestion.height;
    if (!result.width || !result.height || !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < caps.minDimension || result.height < caps.minDimension || result.width > caps.maxDimension || result.height > caps.maxDimension || result.width % caps.dimensionMultiple || result.height % caps.dimensionMultiple || caps.maxPixels && result.width * result.height > caps.maxPixels) throw new HttpError('提示词 AI 未返回当前图片模型支持的有效宽高，请手动重试或设置固定宽高');
  }
  if (caps.imageSizes.length) {
    result.imageSize = config.imageSize && config.imageSize !== 'auto' ? config.imageSize : config.imageSize === 'auto' ? suggestion.imageSize : caps.imageSizes.includes('1K') ? '1K' : caps.imageSizes[0] as ImageResolvedParameters['imageSize'];
    if (!result.imageSize || !caps.imageSizes.includes(result.imageSize)) throw new HttpError('提示词 AI 未返回当前模型支持的分辨率，请手动重试或设置固定分辨率');
  }
  return result;
}

export const optimizeImagePrompt: ImagePromptOptimizer = async (settings, input, signal) => {
  const normalized = normalizeModelSettings(settings); const explicit = input.config.promptProviderId;
  const planning = Boolean(normalized.planningProviderId && normalized.planningModel);
  const providerId = explicit || (planning ? normalized.planningProviderId : normalized.writingProviderId);
  const connection = normalized.providers.find(provider => provider.id === providerId);
  const model = input.config.promptModel?.trim() || (explicit ? undefined : planning ? normalized.planningModel : normalized.writingModel);
  if (!connection || !model) throw new HttpError('请配置生图提示词优化模型，或先设置摘要压缩／正文写作模型');
  const provider = { ...resolveModelConfig(normalized, connection, model, 'planning'), stream: false };
  const caps = imageModelCapabilities(input.config);
  const maxCharacterReferences = input.referenceSelection === 'manual' ? 0 : Math.max(0, Math.min(caps.maxCharacterReferences, caps.maxReferences - input.references.length));
  const prompt = JSON.stringify({ kind: input.kind, material: input.material, ...(input.storyContext ? { storyContext: input.storyContext } : {}), instruction: input.instruction, stylePrompt: input.stylePrompt, characters: input.characters, references: input.references, ...(input.referenceSelection === 'manual' ? { referenceSelection: 'manual', referenceInstruction: '作者已确定全部参考图片及顺序，只使用 references 中的图片，不增删或替换；没有图片时仅按文字绘制。referenceEntityIds 返回空数组。' } : {}), config: { protocol: input.config.protocol, model: input.config.model, size: input.config.size, aspectRatio: input.config.aspectRatio, imageSize: input.config.imageSize, width: input.config.width, height: input.config.height }, allowed: { dimensionMode: caps.dimensionMode, sizes: caps.sizes.filter(size => size !== 'auto'), aspectRatios: caps.aspectRatios, imageSizes: caps.imageSizes, customSize: caps.customSize, dimensionMultiple: caps.dimensionMultiple, minDimension: caps.minDimension, maxDimension: caps.maxDimension, minPixels: caps.minPixels, maxPixels: caps.maxPixels, maxAspectRatio: caps.maxAspectRatio, maxCharacterReferences } });
  const compiled = compileTaskPrompt(settings.promptTemplates, 'image', {
    imageInput: prompt, imageSystemPrompt: input.config.promptSystemPrompt?.trim() ?? '',
    maxCharacterReferences,
    instruction: input.instruction,
  });
  const request = structuredRequest({ ...compiled, signal, maxOutputTokens: provider.maxOutputTokens });
  const inputTokens = estimateModelRequestInputTokens(provider, request);
  if (inputTokens + provider.maxOutputTokens > provider.contextTokens) throw new HttpError(`生图提示词优化素材与完整输出上限超出模型上下文（输入约 ${inputTokens}，输出预留 ${provider.maxOutputTokens}，上下文 ${provider.contextTokens}），请精简素材或调整优化模型参数`);
  const response = await generateStructured(provider, request, value => resultSchema.parse(value));
  const available = new Set(input.characters.filter(character => character.imageId).map(character => character.entityId));
  if (input.referenceSelection !== 'manual' && response.value.referenceEntityIds.some(id => !available.has(id))) throw new HttpError('提示词 AI 选择了不存在或没有立绘的人物参考，请手动重试');
  return { prompt: response.value.prompt, referenceEntityIds: input.referenceSelection === 'manual' ? [] : [...new Set(response.value.referenceEntityIds)].slice(0, caps.maxCharacterReferences), parameters: resolveImageParameters(input.config, response.value.parameters) };
};
