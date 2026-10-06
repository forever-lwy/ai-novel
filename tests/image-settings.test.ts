import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../server/app.js';
import { defaultImageSettings } from '../shared/image-settings.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const ctx of apps.splice(0)) await ctx.app.close(); });
async function context() {
  const ctx = await buildApp({ initialPassword: 'image-settings-fixture', dataDir: mkdtempSync(join(tmpdir(), 'novel-image-settings-')), startEngine: false }); apps.push(ctx);
  const loginResponse = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'image-settings-fixture' } });
  const cookies = { session: loginResponse.cookies.find(cookie => cookie.name === 'session')!.value };
  return { ...ctx, cookies };
}
describe('image settings compatibility', () => {
  it('keeps old text settings usable with automatic CG off by default', async () => {
    const ctx = await context();
    const old = { providers: [], writingProviderId: '', planningProviderId: '', extractionProviderId: '' };
    ctx.settings.setMeta('settings', JSON.stringify(old));
    expect((await ctx.app.inject({ url: '/api/settings', cookies: ctx.cookies })).json().imageSettings).toEqual(defaultImageSettings());
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: old })).statusCode).toBe(200);
  });
  it('validates image assignments, keeps credentials encrypted and retains settings on older clients', async () => {
    const ctx = await context();
    const base = { providers: [{ id: 'picture', name: '图片供应商', protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1', apiKey: 'private-fixture-image-key' }], writingProviderId: '', planningProviderId: '', extractionProviderId: '' };
    const imageSettings = { ...defaultImageSettings(), providerId: 'picture', model: 'custom-image', autoCG: true };
    const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: { ...base, imageSettings } });
    expect(saved.statusCode).toBe(200); expect(saved.json().imageSettings).toEqual(imageSettings);
    expect(saved.body).not.toContain('private-fixture-image-key'); expect(ctx.settings.meta('settings')).not.toContain('private-fixture-image-key');
    const { imageSettings: _removed, ...legacy } = saved.json();
    const updated = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: legacy });
    expect(updated.json().imageSettings).toEqual(imageSettings);
    for (const patch of [{ providerId: 'missing' }, { model: '' }, { timeoutMs: 0 }, { autoCG: 'yes' }, { protocol: 'claude' }]) {
      const failed = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: { ...legacy, imageSettings: { ...imageSettings, ...patch } } });
      expect(failed.statusCode).toBe(400);
    }
    expect(ctx.settings.get().imageSettings).toEqual(imageSettings);
  });
});
