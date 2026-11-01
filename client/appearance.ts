export const APPEARANCE_STORAGE_KEY = 'ai-novel-appearance-v1';
export const MAX_BACKGROUND_BYTES = 1024 * 1024;

export type AppearanceFont = 'system' | 'song' | 'hei' | 'kai' | 'custom';
export type AppearanceColors = Partial<Record<'background' | 'surface' | 'text' | 'accent', string>>;
export type AppearanceSettings = {
  mode: 'system' | 'light' | 'dark';
  palette: 'default' | 'paper' | 'green';
  colors: AppearanceColors;
  readerFont: AppearanceFont;
  readerCustomFont: string;
  interfaceFont: AppearanceFont;
  interfaceCustomFont: string;
  fontSize: number;
  uiScale: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
  contentWidth: number;
  horizontalPadding: number;
  fontWeight: '400' | '500' | '600';
  indent: boolean;
  textAlign: 'left' | 'justify';
  backgroundImage: string;
  paperOpacity: number;
};

export const defaultAppearance: AppearanceSettings = {
  mode: 'system', palette: 'default', colors: {},
  readerFont: 'song', readerCustomFont: '', interfaceFont: 'system', interfaceCustomFont: '',
  fontSize: 18, uiScale: 100, lineHeight: 2.1, letterSpacing: 0, paragraphSpacing: 20,
  contentWidth: 890, horizontalPadding: 46, fontWeight: '400', indent: true, textAlign: 'left',
  backgroundImage: '', paperOpacity: 100,
};

export const appearanceFonts: { id: AppearanceFont; label: string }[] = [
  { id: 'system', label: '系统字体' }, { id: 'song', label: '宋体' },
  { id: 'hei', label: '黑体' }, { id: 'kai', label: '楷体' }, { id: 'custom', label: '自定义字体' },
];
const fontStacks: Record<Exclude<AppearanceFont, 'custom'>, string> = {
  system: 'Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif',
  song: '"Songti SC", "Noto Serif CJK SC", SimSun, Georgia, serif',
  hei: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  kai: 'KaiTi, STKaiti, "Kaiti SC", "Songti SC", serif',
};
export function appearanceFontFamily(font: AppearanceFont, custom: string) {
  return font === 'custom' ? `${custom.trim() ? `${JSON.stringify(custom.trim())}, ` : ''}${fontStacks.system}` : fontStacks[font];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function choice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? value as T : fallback;
}
function number(value: unknown, fallback: number, min: number, max: number, step = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? Number((Math.round(Math.min(max, Math.max(min, value)) / step) * step).toFixed(2)) : fallback;
}
export function normalizeAppearance(value: unknown): AppearanceSettings {
  const source = record(value), colors: AppearanceColors = {};
  for (const key of ['background', 'surface', 'text', 'accent'] as const) {
    const color = record(source.colors)[key];
    if (typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)) colors[key] = color.toLowerCase();
  }
  const font = (key: string, fallback: AppearanceFont) => choice(source[key], appearanceFonts.map(item => item.id), fallback);
  const custom = (key: string) => typeof source[key] === 'string' ? (source[key] as string).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) : '';
  const image = source.backgroundImage;
  return {
    mode: choice(source.mode, ['system', 'light', 'dark'], defaultAppearance.mode),
    palette: choice(source.palette, ['default', 'paper', 'green'], defaultAppearance.palette), colors,
    readerFont: font('readerFont', 'song'), readerCustomFont: custom('readerCustomFont'),
    interfaceFont: font('interfaceFont', 'system'), interfaceCustomFont: custom('interfaceCustomFont'),
    fontSize: number(source.fontSize, 18, 12, 40), uiScale: number(source.uiScale, 100, 90, 125, 5),
    lineHeight: number(source.lineHeight, 2.1, 1.2, 3, 0.1), letterSpacing: number(source.letterSpacing, 0, 0, 5, 0.1),
    paragraphSpacing: number(source.paragraphSpacing, 20, 0, 40), contentWidth: number(source.contentWidth, 890, 560, 1200, 10),
    horizontalPadding: number(source.horizontalPadding, 46, 12, 80), fontWeight: choice(source.fontWeight, ['400', '500', '600'], '400'),
    indent: typeof source.indent === 'boolean' ? source.indent : true, textAlign: choice(source.textAlign, ['left', 'justify'], 'left'),
    backgroundImage: typeof image === 'string' && image.length <= Math.ceil(MAX_BACKGROUND_BYTES / 3) * 4 + 64 && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(image) ? image : '',
    paperOpacity: number(source.paperOpacity, 100, 60, 100),
  };
}

export function appearancePalette(settings: AppearanceSettings, systemDark: boolean) {
  const dark = settings.mode === 'dark' || settings.mode === 'system' && systemDark;
  const palettes = {
    default: { background: '#f7f7f1', surface: '#fffefa', text: '#273a34', accent: '#214f43' },
    paper: { background: '#e8dfcc', surface: '#f6eddc', text: '#493e30', accent: '#795739' },
    green: { background: '#dfe8db', surface: '#eff5e9', text: '#314831', accent: '#3f6945' },
  };
  const base = dark ? { background: '#171c1a', surface: '#222a26', text: '#d9e2da', accent: '#9bc9ad' } : palettes[settings.palette];
  return { ...base, ...settings.colors, dark };
}

function contrastText(color: string) {
  const channels = color.slice(1).match(/../g)!.map(part => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.179 ? '#14201a' : '#ffffff';
}

export function applyAppearance(settings: AppearanceSettings, systemDark = false) {
  const root = document.documentElement;
  const palette = appearancePalette(settings, systemDark);
  root.dataset.theme = palette.dark ? 'dark' : 'light';
  root.dataset.backgroundImage = String(!!settings.backgroundImage);
  root.style.colorScheme = palette.dark ? 'dark' : 'light';
  const variables: Record<string, string> = {
    '--app-bg': palette.background, '--paper': palette.surface, '--surface': palette.surface,
    '--text': palette.text, '--ink': palette.text, '--green': palette.accent,
    '--accent-contrast': contrastText(palette.accent),
    '--muted': 'color-mix(in srgb, var(--text) 67%, var(--paper))',
    '--line': 'color-mix(in srgb, var(--text) 18%, var(--paper))',
    '--surface-alt': 'color-mix(in srgb, var(--paper) 94%, var(--text))',
    '--surface-hover': 'color-mix(in srgb, var(--paper) 88%, var(--green))',
    '--accent-soft': 'color-mix(in srgb, var(--paper) 88%, var(--green))',
    '--danger': palette.dark ? '#f2a89e' : '#a5443a',
    '--reader-text': settings.colors.text || (palette.dark ? palette.text : settings.palette === 'default' ? '#515d46' : palette.text),
    '--interface-font': appearanceFontFamily(settings.interfaceFont, settings.interfaceCustomFont),
    '--reading-font': appearanceFontFamily(settings.readerFont, settings.readerCustomFont),
    '--ui-scale': String(settings.uiScale / 100), '--reading-font-size': `${settings.fontSize}px`,
    '--reading-line-height': String(settings.lineHeight), '--reading-letter-spacing': `${settings.letterSpacing}px`,
    '--reading-paragraph-spacing': `${settings.paragraphSpacing}px`, '--reading-indent': settings.indent ? '2em' : '0',
    '--reading-width': `${settings.contentWidth}px`, '--reading-padding': `${settings.horizontalPadding}px`,
    '--reading-align': settings.textAlign, '--reading-weight': settings.fontWeight,
    '--reader-paper': `color-mix(in srgb, var(--paper) ${settings.paperOpacity}%, transparent)`,
    '--background-image': settings.backgroundImage ? `url("${settings.backgroundImage}")` : 'none',
  };
  for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
}

let state = { settings: normalizeAppearance(null), error: '' };
const listeners = new Set<() => void>();
let media: MediaQueryList | undefined;
export const getAppearanceState = () => state;
export const getAppearance = () => state.settings;
export function subscribeAppearance(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish() { state = { ...state }; applyAppearance(state.settings, media?.matches); for (const listener of listeners) listener(); }
export function saveAppearance(value: AppearanceSettings) {
  const settings = normalizeAppearance(value);
  let error = '';
  try { localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(settings)); }
  catch { error = '外观已临时应用，但浏览器未能保存。请释放浏览器存储空间或移除背景图片后重试；刷新后可能恢复原设置。'; }
  state = { settings, error }; publish();
}
export function initializeAppearance() {
  media = window.matchMedia('(prefers-color-scheme: dark)');
  try { state = { settings: normalizeAppearance(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) || 'null')), error: '' }; }
  catch { state = { settings: normalizeAppearance(null), error: '浏览器中的外观设置无法读取，当前使用默认外观。' }; }
  publish();
  media.addEventListener('change', () => publish());
  window.addEventListener('storage', event => {
    if (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return;
    try { state = { settings: normalizeAppearance(JSON.parse(event.newValue || 'null')), error: '' }; publish(); }
    catch { /* Ignore a damaged value from another tab; keep the current appearance. */ }
  });
}
