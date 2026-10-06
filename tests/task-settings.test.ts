import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../server/app.js';
import { SettingsStore } from '../server/security.js';
import { defaultTaskSettings, normalizeTaskSettings, parseTaskSettings } from '../shared/task-settings.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import { defaultPromptTemplates } from '../shared/prompt-templates.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const ctx of apps.splice(0)) await ctx.app.close(); });
const base = { providers: [], writingProviderId: '', planningProviderId: '', extractionProviderId: '' };
async function context() {
  const ctx = await buildApp({ initialPassword: 'task-settings-fixture', dataDir: mkdtempSync(join(tmpdir(), 'novel-task-settings-')), startEngine: false }); apps.push(ctx);
  const loginResponse = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'task-settings-fixture' } });
  return { ...ctx, cookies: { session: loginResponse.cookies.find(cookie => cookie.name === 'session')!.value } };
}

describe('task settings compatibility and validation', () => {
  it('defaults old and new installations without rewriting stored settings on read', async () => {
    const ctx = await context();
    expect((await ctx.app.inject({ url: '/api/settings', cookies: ctx.cookies })).json().taskSettings).toEqual(defaultTaskSettings());
    expect(ctx.settings.meta('settings')).toBeUndefined();
    const old = JSON.stringify({ ...base, imageSettings: { ...defaultImageSettings(), stylePrompt: '保留原画风' } });
    ctx.settings.setMeta('settings', old);
    const read = (await ctx.app.inject({ url: '/api/settings', cookies: ctx.cookies })).json();
    expect(read.taskSettings).toEqual({ extraction: { autoRetry: false, maxRetries: 2, retryDelayMs: 5000 }, planning: { enabled: true, mode: 'separate' } });
    expect(read.imageSettings.stylePrompt).toBe('保留原画风');
    expect(ctx.settings.meta('settings')).toBe(old);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: base })).statusCode).toBe(200);
    expect(ctx.settings.get().taskSettings).toEqual(defaultTaskSettings());
  });

  it('fills absent nested fields during stored-config migration and saves a complete value', async () => {
    const ctx = await context();
    const partial = { extraction: { autoRetry: true }, planning: { enabled: false } };
    const expected = { extraction: { autoRetry: true, maxRetries: 2, retryDelayMs: 5000 }, planning: { enabled: false, mode: 'separate' } };
    expect(normalizeTaskSettings(partial)).toEqual(expected);
    const raw = JSON.stringify({ ...base, taskSettings: partial }); ctx.settings.setMeta('settings', raw);
    expect(ctx.settings.get().taskSettings).toEqual(expected);
    expect(ctx.settings.meta('settings')).toBe(raw);
    ctx.settings.save(ctx.settings.get());
    expect(JSON.parse(ctx.settings.meta('settings')!).taskSettings).toEqual(expected);
  });

  it('roundtrips configured settings and preserves them with other settings when an older client omits them', async () => {
    const ctx = await context();
    const taskSettings = { extraction: { autoRetry: true, maxRetries: 4, retryDelayMs: 1200 }, planning: { enabled: false, mode: 'tool' } };
    const promptTemplates = defaultPromptTemplates(); promptTemplates.presets.writing[0].blocks[0].content = '保留作者提示词';
    const imageSettings = { ...defaultImageSettings(), stylePrompt: '保留作者画风' };
    const input = { ...base, providers: [{ id: 'text', name: '测试连接', protocol: 'openai-chat', baseUrl: 'https://fixture.invalid/v1', apiKey: 'task-fixture-secret' }], promptTemplates, imageSettings, taskSettings };
    const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: input });
    expect(saved.statusCode).toBe(200); expect(saved.json().taskSettings).toEqual(taskSettings);
    expect(new SettingsStore(ctx.store.db, ctx.dataDir).get().taskSettings).toEqual(taskSettings);
    const { taskSettings: _omitted, ...legacy } = saved.json();
    const updated = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: legacy });
    expect(updated.statusCode).toBe(200); expect(updated.json().taskSettings).toEqual(taskSettings);
    expect(ctx.settings.get().promptTemplates).toEqual(promptTemplates);
    expect(ctx.settings.get().imageSettings).toEqual(imageSettings);
    expect(ctx.settings.get().providers[0].apiKey).toBe('task-fixture-secret');
    expect(ctx.settings.meta('settings')).not.toContain('task-fixture-secret');
  });

  it('strictly rejects malformed settings before changing storage and accepts numeric boundaries', async () => {
    const ctx = await context();
    const taskSettings = defaultTaskSettings();
    ctx.settings.save({ ...base, taskSettings }); const before = ctx.settings.meta('settings');
    const invalid = [
      null, {}, { ...taskSettings, unexpected: true },
      ...[{ autoRetry: 'yes' }, { maxRetries: -1 }, { maxRetries: 11 }, { maxRetries: 1.5 }, { maxRetries: '2' }, { retryDelayMs: -1 }, { retryDelayMs: 300001 }, { retryDelayMs: 0.5 }, { unexpected: true }].map(patch => ({ ...taskSettings, extraction: { ...taskSettings.extraction, ...patch } })),
      ...[{ enabled: 'yes' }, { mode: 'auto' }, { unexpected: true }].map(patch => ({ ...taskSettings, planning: { ...taskSettings.planning, ...patch } })),
    ];
    for (const value of invalid) {
      expect(() => parseTaskSettings(value)).toThrow();
      const rejected = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: { ...base, taskSettings: value } });
      expect(rejected.statusCode).toBe(400); expect(ctx.settings.meta('settings')).toBe(before);
    }
    for (const extraction of [{ autoRetry: true, maxRetries: 0, retryDelayMs: 0 }, { autoRetry: true, maxRetries: 10, retryDelayMs: 300000 }]) {
      const input = { ...taskSettings, extraction };
      expect(parseTaskSettings(input)).toEqual(input);
      const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: { ...base, taskSettings: input } });
      expect(saved.statusCode).toBe(200); expect(saved.json().taskSettings).toEqual(input);
    }
  });
});
