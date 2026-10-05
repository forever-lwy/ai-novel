import type { ImageSettings } from './types.js';

export interface ImageModelCapabilities {
  knownModel: boolean;
  referenceMode: 'none' | 'single' | 'multiple';
  maxReferences: number;
  maxCharacterReferences: number;
  referenceField?: 'image_url' | 'reference_images';
  dimensionMode: 'size' | 'aspect-ratio' | 'width-height';
  customSize: boolean;
  dimensionMultiple: number;
  minDimension: number;
  maxDimension: number;
  minPixels?: number;
  maxPixels?: number;
  maxAspectRatio?: number;
  sizes: string[];
  aspectRatios: string[];
  imageSizes: string[];
  qualityOptions: string[];
  thinkingLevels: string[];
  outputFormats: string[];
  backgroundOptions: string[];
  inputFidelities: string[];
  supportedParams: (keyof ImageSettings)[];
}

const sizes = ['1024x1024', '1024x1536', '1536x1024'];
const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const flashRatios = [...ratios, '1:4', '4:1', '1:8', '8:1'];
const sampling: (keyof ImageSettings)[] = ['temperature', 'topP', 'topK', 'seed', 'maxOutputTokens', 'systemInstruction'];

/** Model differences come from the vendors' image guides, not text-model capabilities. */
export function imageModelCapabilities(config: Pick<ImageSettings, 'protocol' | 'model'>): ImageModelCapabilities {
  const model = config.model.trim().replace(/^models\//, '').toLowerCase();
  const base: ImageModelCapabilities = { knownModel: false, referenceMode: 'none', maxReferences: 0, maxCharacterReferences: 0, dimensionMode: 'size', customSize: false, dimensionMultiple: 1, minDimension: 1, maxDimension: 1536, sizes: [...sizes], aspectRatios: ['1:1', '2:3', '3:2'], imageSizes: [], qualityOptions: [], thinkingLevels: [], outputFormats: [], backgroundOptions: [], inputFidelities: [], supportedParams: [] };
  if (config.protocol === 'openai-images') {
    const legacy = /^dall-e-[23]$/.test(model);
    const gpt = /^gpt-image(?:-|$)/.test(model) || model === 'chatgpt-image-latest';
    const mini = /^gpt-image-1-mini(?:-|$)/.test(model);
    const secondGeneration = /^gpt-image-2(?:[.-]|$)/.test(model);
    return { ...base, knownModel: gpt || legacy, referenceMode: legacy ? model === 'dall-e-2' ? 'single' : 'none' : 'multiple', maxReferences: legacy ? model === 'dall-e-2' ? 1 : 0 : 16, maxCharacterReferences: legacy ? 0 : 16,
      ...(secondGeneration ? { customSize: true, dimensionMultiple: 16, minDimension: 16, maxDimension: 3840, minPixels: 655360, maxPixels: 8294400, maxAspectRatio: 3, aspectRatios: [...ratios] } : {}),
      ...(legacy ? { maxDimension: model === 'dall-e-2' ? 1024 : 1792, sizes: model === 'dall-e-2' ? ['256x256', '512x512', '1024x1024'] : ['1024x1024', '1024x1792', '1792x1024'] } : {}),
      qualityOptions: legacy ? model === 'dall-e-3' ? ['auto', 'standard', 'hd'] : ['auto', 'standard'] : ['auto', 'low', 'medium', 'high', ...(/^gpt-image-2\.5-(?:sunburst|flare)(?:-|$)/.test(model) ? ['xhigh', 'max'] : [])],
      outputFormats: legacy ? [] : ['png', 'jpeg', 'webp'], backgroundOptions: legacy ? [] : ['auto', 'opaque', 'transparent'], inputFidelities: legacy || secondGeneration ? [] : mini ? ['low'] : ['low', 'high'],
      supportedParams: legacy ? ['size', 'quality'] : ['size', 'quality', 'background', 'outputFormat', 'outputCompression', 'moderation', ...(!secondGeneration ? ['inputFidelity' as const] : [])] };
  }
  if (config.protocol === 'gemini') {
    const flash = /^gemini-3\.1-flash-image(?:-|$)/.test(model);
    const flashLite = /^gemini-3\.1-flash-lite-image(?:-|$)/.test(model);
    const pro = /^gemini-3-pro-image(?:-|$)/.test(model);
    const earlier = /^gemini-2\.5-flash-image(?:-|$)/.test(model);
    const knownModel = flash || flashLite || pro || earlier;
    return { ...base, knownModel, referenceMode: 'multiple', maxReferences: flash || flashLite || pro ? 14 : 3, maxCharacterReferences: flash ? 4 : pro ? 5 : flashLite ? 0 : 3,
      dimensionMode: 'aspect-ratio', aspectRatios: flash ? [...flashRatios] : [...ratios], imageSizes: flash ? ['512', '1K', '2K', '4K'] : pro ? ['1K', '2K', '4K'] : flashLite ? ['1K'] : [],
      thinkingLevels: flash || flashLite ? ['minimal', 'high'] : pro ? ['high'] : [], outputFormats: knownModel ? ['jpeg'] : [],
      supportedParams: ['size', 'aspectRatio', ...sampling, ...(knownModel ? ['outputFormat' as const] : []), ...(flash || flashLite || pro ? ['imageSize' as const, 'thinkingLevel' as const, 'includeThoughts' as const] : [])] };
  }
  if (config.protocol === 'together-images') {
    const kontext = /^black-forest-labs\/flux\.1-kontext-(?:pro|max|dev)$/.test(model);
    const flux2 = /^black-forest-labs\/flux\.2-(?:pro|dev|flex)$/.test(model);
    const devOrFlex = /^black-forest-labs\/flux\.2-(?:dev|flex)$/.test(model);
    const schnell = /^black-forest-labs\/flux\.1-schnell(?:-free)?$/.test(model);
    const firstPro = /^black-forest-labs\/flux\.1(?:\.1)?-pro$/.test(model);
    const google = /^google\/(?:gemini-3-pro-image|flash-image-2\.5|flash-image-3\.1)(?:-preview)?$/.test(model);
    const knownModel = kontext || flux2 || schnell || firstPro || google;
    // Four is this workbench's conservative reference budget for Together. Its
    // public schema confirms arrays but does not publish a model-specific limit.
    return { ...base, knownModel, referenceMode: kontext ? 'single' : flux2 || google ? 'multiple' : 'none', maxReferences: kontext ? 1 : flux2 || google ? 4 : 0, maxCharacterReferences: kontext ? 1 : flux2 || google ? 4 : 0,
      ...(kontext || flux2 || google ? { referenceField: kontext ? 'image_url' as const : 'reference_images' as const } : {}),
      dimensionMode: kontext ? 'aspect-ratio' : 'width-height', customSize: !kontext, dimensionMultiple: 8, minDimension: 64, maxDimension: 4096, maxPixels: 16777216, aspectRatios: [...ratios], outputFormats: ['png', 'jpeg'],
      supportedParams: ['size', ...(kontext ? ['aspectRatio' as const] : ['width' as const, 'height' as const]), 'seed', 'outputFormat', 'disableSafetyChecker', ...(kontext || schnell || devOrFlex ? ['steps' as const] : []), ...(devOrFlex ? ['guidanceScale' as const] : []), ...(schnell || firstPro ? ['negativePrompt' as const] : []), ...(model === 'black-forest-labs/flux.2-pro' ? ['promptUpsampling' as const] : [])] };
  }
  return base;
}
