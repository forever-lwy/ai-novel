import { describe, expect, it } from 'vitest';
import { appearanceFontFamily, appearancePalette, defaultAppearance, MAX_BACKGROUND_BYTES, normalizeAppearance } from '../client/appearance';

describe('browser appearance preferences', () => {
  it.each([undefined, null, false, 42, 'damaged value', [], {}])('recovers defaults from missing or incompatible saved data: %j', value => {
    expect(normalizeAppearance(value)).toEqual(defaultAppearance);
  });

  it('returns independent defaults so changing one preference cannot corrupt future resets', () => {
    const value = normalizeAppearance(null);
    value.colors.text = '#123456'; value.fontSize = 32;
    expect(normalizeAppearance(null)).toEqual(defaultAppearance);
    expect(defaultAppearance.colors).toEqual({});
  });

  it('round-trips valid saved preferences including explicit zero spacing and disabled indentation', () => {
    const value = {
      ...defaultAppearance, mode: 'dark' as const, palette: 'paper' as const,
      colors: { background: '#102030', surface: '#203040', text: '#ddeeff', accent: '#aabbcc' },
      readerFont: 'custom' as const, readerCustomFont: '霞鹜文楷', interfaceFont: 'hei' as const,
      fontSize: 24, uiScale: 110, lineHeight: 1.8, letterSpacing: 0, paragraphSpacing: 0,
      contentWidth: 760, horizontalPadding: 24, fontWeight: '500' as const, indent: false,
      textAlign: 'justify' as const, paperOpacity: 70,
    };
    expect(normalizeAppearance(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it('bounds extreme numeric values while preserving useful preferences', () => {
    const value = normalizeAppearance({ fontSize: 10000, uiScale: -1, lineHeight: 10, letterSpacing: -10,
      paragraphSpacing: 100, contentWidth: 1, horizontalPadding: 999, paperOpacity: 0 });
    expect(value).toMatchObject({ fontSize: 40, uiScale: 90, lineHeight: 3, letterSpacing: 0,
      paragraphSpacing: 40, contentWidth: 560, horizontalPadding: 80, paperOpacity: 60 });
    expect(normalizeAppearance({ fontSize: -10, uiScale: 999, lineHeight: 0, letterSpacing: 100,
      paragraphSpacing: -1, contentWidth: 99999, horizontalPadding: -1, paperOpacity: 101 })).toMatchObject({
      fontSize: 12, uiScale: 125, lineHeight: 1.2, letterSpacing: 5, paragraphSpacing: 0,
      contentWidth: 1200, horizontalPadding: 12, paperOpacity: 100,
    });
  });

  it.each([NaN, Infinity, -Infinity, '24', null, {}])('falls back for non-finite or nonnumeric values: %j', invalid => {
    const fields = ['fontSize', 'uiScale', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'contentWidth', 'horizontalPadding', 'paperOpacity'] as const;
    const value = normalizeAppearance(Object.fromEntries(fields.map(key => [key, invalid])));
    for (const key of fields) expect(value[key]).toBe(defaultAppearance[key]);
  });

  it('rejects unknown modes, fonts, weights and alignment instead of applying arbitrary CSS values', () => {
    expect(normalizeAppearance({ mode: 'sepia', palette: 'unlisted', readerFont: 'url(remote)', interfaceFont: 'other',
      fontWeight: '999', textAlign: 'url(remote)', indent: 'false' })).toEqual(defaultAppearance);
  });

  it('only accepts six-digit colors in supported color fields and normalizes their case', () => {
    expect(normalizeAppearance({ colors: { background: '#AABBCC', surface: 'red', text: '#123', accent: 'url(https://example.invalid/a)', arbitrary: '#112233' } }).colors)
      .toEqual({ background: '#aabbcc' });
    expect(normalizeAppearance({ colors: ['#aabbcc'] }).colors).toEqual({});
    expect(normalizeAppearance({ colors: { background: '#000000', surface: '#FFFFFF', text: '#102030', accent: '#abcdef' } }).colors)
      .toEqual({ background: '#000000', surface: '#ffffff', text: '#102030', accent: '#abcdef' });
  });

  it.each([
    'https://example.invalid/background.png', 'file:///private/background.png', 'url(https://example.invalid/background.png)',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:text/html;base64,PGh0bWwvPg==',
    'data:image/png;base64,not valid base64!', 'data:image/png;base64,',
    `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_BACKGROUND_BYTES / 3) * 4 + 100)}`,
  ])('rejects external, unsupported, malformed or oversized background images', backgroundImage => {
    expect(normalizeAppearance({ backgroundImage }).backgroundImage).toBe('');
  });

  it.each(['png', 'jpeg', 'webp', 'gif'])('preserves a bounded local %s background', type => {
    const image = `data:image/${type};base64,QUJDRA==`;
    expect(normalizeAppearance({ backgroundImage: image }).backgroundImage).toBe(image);
  });

  it('removes control characters and bounds custom font names, then quotes the name as one font family', () => {
    const value = normalizeAppearance({ readerFont: 'custom', readerCustomFont: ' \u0000霞鹜\n文楷\u007f ', interfaceCustomFont: '字'.repeat(200) });
    expect(value.readerCustomFont).toBe(' 霞鹜文楷 '); expect(value.interfaceCustomFont).toHaveLength(100);
    expect(normalizeAppearance({ readerCustomFont: 'Times ' }).readerCustomFont).toBe('Times ');
    expect(appearanceFontFamily('custom', ' Times New Roman ')).toContain('"Times New Roman"');
    const maliciousName = 'Example"; color:red; font-family:"Other';
    const family = appearanceFontFamily('custom', maliciousName);
    expect(family.startsWith(`${JSON.stringify(maliciousName)}, `)).toBe(true);
    expect(appearanceFontFamily('custom', '')).toBe(appearanceFontFamily('system', ''));
  });

  it('follows system darkness only in system mode and keeps custom colors ahead of the base palette', () => {
    const system = normalizeAppearance({ mode: 'system', palette: 'paper' });
    expect(appearancePalette(system, false).dark).toBe(false);
    expect(appearancePalette(system, true).dark).toBe(true);
    expect(appearancePalette(normalizeAppearance({ mode: 'light' }), true).dark).toBe(false);
    expect(appearancePalette(normalizeAppearance({ mode: 'dark' }), false).dark).toBe(true);
    const override = normalizeAppearance({ mode: 'system', colors: { text: '#123456', background: '#654321' } });
    for (const dark of [true, false]) expect(appearancePalette(override, dark)).toMatchObject({ text: '#123456', background: '#654321', dark });
    expect(appearancePalette(system, false).background).not.toBe(appearancePalette(normalizeAppearance({ palette: 'green' }), false).background);
  });
});
