import type { PromptTask } from './types.js';
import { EXTRACTION_INDEX_PREFIXES, formatContinuationAnchor, formatExtractionIndex, formatPromptMaterial, formatRecentChapters, formatWritingMaterials } from './prompt-materials.js';

const parseMaterial = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Compatibility inputs stay untouched; only the new readable aliases are rendered. */
export function formatSerializedPromptMaterial(value: unknown): string {
  return formatPromptMaterial(parseMaterial(value));
}

/** Decode only the complete two-line index emitted by the legacy producer. */
function extractionIndexText(value: unknown): string {
  if (typeof value === 'string') {
    const lines = value.split(/\r?\n/);
    if (lines.length === 2 && lines[0].startsWith(EXTRACTION_INDEX_PREFIXES.entities) && lines[1].startsWith(EXTRACTION_INDEX_PREFIXES.foreshadows)) {
      try {
        const entities: unknown = JSON.parse(lines[0].slice(EXTRACTION_INDEX_PREFIXES.entities.length));
        const foreshadows: unknown = JSON.parse(lines[1].slice(EXTRACTION_INDEX_PREFIXES.foreshadows.length));
        if (Array.isArray(entities) && Array.isArray(foreshadows)) return formatExtractionIndex(entities, foreshadows);
      } catch { /* Author text or incomplete legacy data remains literal. */ }
    }
  }
  return formatSerializedPromptMaterial(value);
}

export function prepareReadablePromptVariables(task: PromptTask, variables: Record<string, string | number | undefined>): Record<string, string | number | undefined> {
  const result = { ...variables };
  const fill = (key: string, value: () => string) => { if (result[key] === undefined) result[key] = value(); };
  if (task === 'writing') {
    const context = parseMaterial(variables.context);
    const materials = parseMaterial(variables.storyMaterials ?? variables.context);
    const anchor = variables.continuationAnchor ?? (object(context) ? context.continuationAnchor : undefined) ?? (object(materials) ? materials.continuationAnchor : undefined);
    const recent = variables.recentChapters ?? (object(context) ? context.recentCompleteChapters : undefined);
    fill('storyMaterialsText', () => {
      if (!object(materials)) return formatPromptMaterial(materials);
      const { continuationAnchor: _anchor, recentCompleteChapters: _recent, ...story } = materials;
      return formatWritingMaterials(story);
    });
    fill('recentChaptersText', () => recent === undefined ? '尚未提供已保存章节。' : formatRecentChapters(recent));
    fill('continuationAnchorText', () => formatContinuationAnchor(anchor));
    fill('contextText', () => `# 故事资料\n${result.storyMaterialsText}\n\n# 最近章节原文\n${result.recentChaptersText}\n\n# 续写起点\n${result.continuationAnchorText}`);
  } else if (task === 'extraction') fill('extractionIndexText', () => extractionIndexText(variables.context));
  else if (task === 'image') fill('imageInputText', () => formatSerializedPromptMaterial(variables.imageInput));
  return result;
}
