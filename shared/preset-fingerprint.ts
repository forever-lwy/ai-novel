import type { PromptPreset } from './types.js';

// Compare complete historical defaults without shipping their text in the app.
// Object key order is irrelevant; array order and every author-editable field count.
export function presetFingerprint(preset: PromptPreset): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, canonical(item)])) : value;
  const text = JSON.stringify(canonical(preset));
  let first = 2166136261; let second = 5381;
  for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); first = Math.imul(first ^ code, 16777619); second = Math.imul(second, 33) ^ code; }
  return `${text.length}:${first >>> 0}:${second >>> 0}`;
}
