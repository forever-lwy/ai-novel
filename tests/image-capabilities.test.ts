import { describe, expect, it } from 'vitest';
import { imageModelCapabilities } from '../shared/image-capabilities.js';

describe('image model capabilities', () => {
  it('distinguishes native Nano Banana 2 controls and character-reference budget', () => {
    const stable = imageModelCapabilities({ protocol: 'gemini', model: 'gemini-3.1-flash-image' });
    expect(stable).toMatchObject({ knownModel: true, referenceMode: 'multiple', maxReferences: 14, maxCharacterReferences: 4, imageSizes: ['512', '1K', '2K', '4K'], thinkingLevels: ['minimal', 'high'], outputFormats: ['jpeg'], dimensionMode: 'aspect-ratio' });
    expect(stable.aspectRatios).toContain('1:8');
    expect(stable.supportedParams).toEqual(expect.arrayContaining(['temperature', 'topP', 'topK', 'seed', 'systemInstruction', 'maxOutputTokens', 'imageSize', 'thinkingLevel', 'includeThoughts']));
    expect(stable.supportedParams).not.toContain('searchGrounding');
    expect(imageModelCapabilities({ protocol: 'gemini', model: 'models/gemini-3.1-flash-image-preview' })).toEqual(stable);
  });

  it('does not borrow text-model thinking controls for Gemini image models', () => {
    expect(imageModelCapabilities({ protocol: 'gemini', model: 'gemini-3-pro-image' })).toMatchObject({ thinkingLevels: ['high'], imageSizes: ['1K', '2K', '4K'], maxCharacterReferences: 5 });
    expect(imageModelCapabilities({ protocol: 'gemini', model: 'gemini-2.5-flash-image' })).toMatchObject({ thinkingLevels: [], imageSizes: [], maxReferences: 3 });
    expect(imageModelCapabilities({ protocol: 'gemini', model: 'gemini-3.1-flash-lite-image' })).toMatchObject({ thinkingLevels: ['minimal', 'high'], imageSizes: ['1K'], maxCharacterReferences: 0 });
  });

  it('tracks OpenAI custom size, model quality and reference fidelity separately', () => {
    const first = imageModelCapabilities({ protocol: 'openai-images', model: 'gpt-image-1' });
    expect(first).toMatchObject({ customSize: false, maxReferences: 16, outputFormats: ['png', 'jpeg', 'webp'], inputFidelities: ['low', 'high'] });
    const second = imageModelCapabilities({ protocol: 'openai-images', model: 'gpt-image-2' });
    expect(second).toMatchObject({ customSize: true, dimensionMultiple: 16, maxDimension: 3840, minPixels: 655360, maxPixels: 8294400, maxAspectRatio: 3, inputFidelities: [] });
    expect(second.supportedParams).not.toContain('inputFidelity');
    expect(imageModelCapabilities({ protocol: 'openai-images', model: 'gpt-image-1-mini' }).inputFidelities).toEqual(['low']);
    expect(imageModelCapabilities({ protocol: 'openai-images', model: 'gpt-image-2.5-flare' }).qualityOptions).toContain('max');
    expect(first.qualityOptions).not.toContain('xhigh');
    expect(second.backgroundOptions).toEqual(['auto', 'opaque', 'transparent']);
  });

  it('keeps retired DALL-E gateway parameter suggestions separate from GPT Images', () => {
    const second = imageModelCapabilities({ protocol: 'openai-images', model: 'dall-e-2' });
    const third = imageModelCapabilities({ protocol: 'openai-images', model: 'dall-e-3' });
    expect(second).toMatchObject({ sizes: ['256x256', '512x512', '1024x1024'], referenceMode: 'single', maxReferences: 1, outputFormats: [], backgroundOptions: [] });
    expect(third).toMatchObject({ sizes: ['1024x1024', '1024x1792', '1792x1024'], referenceMode: 'none', maxReferences: 0, qualityOptions: ['auto', 'standard', 'hd'] });
  });

  it('maps Together reference inputs per model instead of treating the protocol as an OpenAI alias', () => {
    expect(imageModelCapabilities({ protocol: 'together-images', model: 'black-forest-labs/FLUX.1-kontext-pro' })).toMatchObject({ referenceMode: 'single', maxReferences: 1, referenceField: 'image_url', dimensionMode: 'aspect-ratio' });
    expect(imageModelCapabilities({ protocol: 'together-images', model: 'black-forest-labs/FLUX.2-pro' })).toMatchObject({ referenceMode: 'multiple', maxReferences: 4, referenceField: 'reference_images', dimensionMode: 'width-height' });
    expect(imageModelCapabilities({ protocol: 'together-images', model: 'google/gemini-3-pro-image' })).toMatchObject({ referenceMode: 'multiple', referenceField: 'reference_images' });
    expect(imageModelCapabilities({ protocol: 'together-images', model: 'google/flash-image-3.1' })).toMatchObject({ knownModel: true, referenceMode: 'multiple', referenceField: 'reference_images', dimensionMode: 'width-height' });
    expect(imageModelCapabilities({ protocol: 'together-images', model: 'google/gemini-3.1-flash-image' })).toMatchObject({ knownModel: false, referenceMode: 'none' });
    expect(imageModelCapabilities({ protocol: 'together-images', model: 'unknown-image-model' })).toMatchObject({ knownModel: false, referenceMode: 'none', maxReferences: 0 });
  });

  it('exposes only confirmed Together parameters for each FLUX family', () => {
    const pro = imageModelCapabilities({ protocol: 'together-images', model: 'black-forest-labs/FLUX.2-pro' }).supportedParams;
    const dev = imageModelCapabilities({ protocol: 'together-images', model: 'black-forest-labs/FLUX.2-dev' }).supportedParams;
    const schnell = imageModelCapabilities({ protocol: 'together-images', model: 'black-forest-labs/FLUX.1-schnell' }).supportedParams;
    expect(pro).toContain('promptUpsampling'); expect(pro).not.toContain('steps'); expect(pro).not.toContain('guidanceScale');
    expect(dev).toContain('steps'); expect(dev).toContain('guidanceScale'); expect(dev).not.toContain('negativePrompt');
    expect(schnell).toContain('steps'); expect(schnell).toContain('negativePrompt'); expect(schnell).not.toContain('guidanceScale');
    expect(dev).not.toContain('quality');
  });
});
