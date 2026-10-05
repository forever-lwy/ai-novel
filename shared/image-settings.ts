import type { ImageSettings } from './types.js';

export const defaultImageSettings = (): ImageSettings => ({
  providerId: '', model: '', protocol: 'openai-images', size: '1024x1024', quality: 'auto',
  stylePrompt: '小说插画，保持同一作品的画风与角色外观一致。', autoPortrait: true, autoCG: false, timeoutMs: 300000, useCharacterReferences: true,
});

export function normalizeImageSettings(value?: Partial<ImageSettings>): ImageSettings {
  return { ...defaultImageSettings(), ...value, model: value?.model?.trim() || '' };
}
