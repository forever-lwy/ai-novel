import type { PromptPreset } from './types.js';
import { presetFingerprint } from './preset-fingerprint.js';

// Complete historical defaults only; edited copies are never removed.
export const retiredPresetFingerprints: Readonly<Record<string, string>> = {
  "default-general-v08": "24012:1781202332:901699742",
  "default-general-reborn": "1067:654809577:914477097",
  "tavern-dramatron-v31": "37172:3698228896:2706946948",
  "tavern-v08": "68711:2642627959:19133797",
  "tavern-reborn-v23": "18217:561662678:101481572",
  "tavern-linux-v13": "38289:164654171:2921483115",
  "default-writing-v2": "1647:3061079049:2364134093",
  "default-extraction-v2": "3295:4252245137:349749883",
  "default-compression-v2": "1023:3676054494:3814442442"
};

const retiredDramatronFingerprints = [
  '23416:3742714433:1208278109', // Last protection-only edition.
  '1149:229997992:1981564222', // First general framework.
  '25560:476592029:3766127561', // Original Dramatron framework.
];
export function isRetiredDefault(preset: PromptPreset): boolean {
  if (preset.id === 'default-general') return retiredDramatronFingerprints.includes(presetFingerprint(preset));
  return Boolean(retiredPresetFingerprints[preset.id]) && retiredPresetFingerprints[preset.id] === presetFingerprint(preset);
}
