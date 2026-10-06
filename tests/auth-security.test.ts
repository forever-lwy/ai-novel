import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../server/store.js';
import { SettingsStore, hashPassword, hasUrlCredentials, tokenHash, verifyPassword, verifyPasswordWithUpgrade } from '../server/security.js';
import { initializePassword, registerAuthRoutes, type AuthOptions } from '../server/auth.js';
import type { Settings } from '../shared/types.js';

const applications: Awaited<ReturnType<typeof make>>[] = [];
const password = 'Paper-Lantern-47';
async function make(options: Partial<AuthOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ai-novel-auth-security-'));
  const store = new Store(dataDir), settings = new SettingsStore(store.db, dataDir);
  const app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.status(400).send({ error: error.issues.map(issue => issue.message).join('；') });
    const problem = error as Error & { statusCode?: number };
    return reply.status(problem.statusCode || 500).send({ error: problem.statusCode ? problem.message : '操作未完成。' });
  });
  registerAuthRoutes(app, { settings, store, secureCookies: true, ...options });
  app.addHook('onClose', async () => store.close());
  const context = { app, store, settings, dataDir };
  applications.push(context);
  return context;
}
afterEach(async () => { for (const { app } of applications.splice(0)) await app.close(); });
const sessionCookie = (response: { cookies: { name: string; value: string }[] }) => response.cookies.find(item => item.name === 'session')!.value;
async function setup(context: Awaited<ReturnType<typeof make>>) {
  await initializePassword(context.settings, password);
  const response = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}
async function authenticated(context: Awaited<ReturnType<typeof make>>, session: string) {
  return (await context.app.inject({ url: '/api/auth/status', cookies: { session } })).json().authenticated;
}

describe('password storage and authentication security', () => {
  it('uses a versioned scrypt work factor, fresh salts and accepts only known formats', async () => {
    const first = await hashPassword(password), second = await hashPassword(password);
    expect(first).toMatch(/^scrypt\$v1\$16384\$8\$5\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(second).not.toBe(first);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword('Incorrect-Password-47', first)).toBe(false);
    expect(await verifyPasswordWithUpgrade(password, first)).toEqual({ valid: true, upgradedHash: undefined });
    for (const malformed of ['', 'salt:hash', first.replace('$16384$', '$1073741824$'), first + '$extra']) {
      expect(await verifyPassword(password, malformed)).toBe(false);
    }
  });

  it.each(['        ', '          abc', '123456789012', 'password123456', 'aaaaaaaaaaaa', 'qwertyuiop123'])('rejects a weak new password: %s', async weakPassword => {
    const context = await make();
    await expect(initializePassword(context.settings, weakPassword)).rejects.toThrow('INITIAL_PASSWORD');
    expect(context.settings.meta('password')).toBeUndefined();
  });

  it('sets a secure random session without returning the password or stored hash', async () => {
    const context = await make(), session = await setup(context);
    const hash = context.settings.meta('password')!;
    const status = await context.app.inject({ url: '/api/auth/status', cookies: { session } });
    expect(status.json()).toEqual({ initialized: true, authenticated: true });
    expect(status.body).not.toContain(password); expect(status.body).not.toContain(hash);
    expect(session).toMatch(/^[a-f0-9]{64}$/);
    const rows = context.store.db.prepare('SELECT token_hash FROM sessions').all();
    expect(rows).toEqual([{ token_hash: tokenHash(session) }]);
    const login = await context.app.inject({ method: 'POST', url: '/api/auth/login', cookies: { session: 'attacker-supplied-token' }, payload: { password } });
    expect(login.statusCode).toBe(200);
    expect(sessionCookie(login)).not.toBe(session);
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    expect(login.headers['set-cookie']).toContain('Secure');
    expect(login.headers['set-cookie']).toContain('SameSite=Strict');
  });

  it('requires an explicit initial password and exposes no web initialization endpoint', async () => {
    const context = await make();
    for (const value of [undefined, '']) await expect(initializePassword(context.settings, value)).rejects.toThrow('INITIAL_PASSWORD');
    expect(context.settings.meta('password')).toBeUndefined();
    expect((await context.app.inject('/api/auth/status')).json()).toEqual({ initialized: false, authenticated: false });
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password } })).statusCode).toBe(404);
    await initializePassword(context.settings, password);
    const stored = context.settings.meta('password')!;
    expect(stored).not.toContain(password); expect(await verifyPassword(password, stored)).toBe(true);
    expect((await context.app.inject('/api/auth/status')).body).not.toContain(password);
    expect(await initializePassword(context.settings, 'Replacement-Password-99')).toBe(false);
    expect(await initializePassword(context.settings, undefined)).toBe(false);
    expect(await initializePassword(context.settings, 'weak')).toBe(false);
    expect(context.settings.meta('password')).toBe(stored);
  });

  it('preserves a legacy 8-character password and upgrades its hash after successful login', async () => {
    const context = await make(), legacyPassword = 'oldpwd88', salt = randomBytes(16).toString('hex');
    const legacyHash = `${salt}:${scryptSync(legacyPassword, salt, 64).toString('hex')}`;
    context.settings.setMeta('password', legacyHash);
    const bad = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrongpwd' } });
    expect(bad.statusCode).toBe(401); expect(context.settings.meta('password')).toBe(legacyHash);
    const login = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: legacyPassword } });
    expect(login.statusCode).toBe(200);
    expect(context.settings.meta('password')).toMatch(/^scrypt\$v1\$16384\$8\$5\$/);
    expect(await authenticated(context, sessionCookie(login))).toBe(true);
  });

  it('sets only one password when startup initialization runs concurrently', async () => {
    const context = await make();
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => initializePassword(context.settings, `Concurrent-Fixture-Password-${index}`)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const matches = await Promise.all(Array.from({ length: 5 }, (_, index) => verifyPassword(`Concurrent-Fixture-Password-${index}`, context.settings.meta('password')!)));
    expect(matches.filter(Boolean)).toHaveLength(1);
    expect(context.store.db.prepare("SELECT count(*) count FROM app_meta WHERE key='password'").get()!.count).toBe(1);
  });

  it('limits malformed requests before JSON parsing, and success does not reset the login quota', async () => {
    const context = await make(); await setup(context);
    for (let i = 0; i < 10; i++) {
      expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.10', headers: { 'content-type': 'application/json' }, payload: '{' })).statusCode).toBe(400);
    }
    const limited = await context.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.10', headers: { 'content-type': 'application/json' }, payload: '{' });
    expect(limited.statusCode).toBe(429); expect(limited.headers['retry-after']).toBeDefined();
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.11', payload: { password } })).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.11', payload: { password: 'Incorrect-Password-47' } })).statusCode).toBe(401);
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.11', payload: { password } })).statusCode).toBe(429);
  });

  it('caps authentication request bodies at 4 KiB and rejects overlong passwords', async () => {
    const context = await make();
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'x'.repeat(257) } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password, padding: 'x'.repeat(4096) } })).statusCode).toBe(413);
    const session = await setup(context);
    for (const url of ['/api/auth/login', '/api/auth/password', '/api/auth/sessions/revoke', '/api/auth/logout']) {
      expect((await context.app.inject({ method: 'POST', url, cookies: { session }, payload: { password, padding: 'x'.repeat(4096) } })).statusCode).toBe(413);
    }
  });

  it('bounds simultaneous password work even when requests use different client addresses', async () => {
    const context = await make(); await setup(context);
    const logins = await Promise.all(Array.from({ length: 12 }, (_, index) => context.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `203.0.113.${index + 1}`, payload: { password } })));
    expect(logins.filter(result => result.statusCode === 200)).toHaveLength(4);
    expect(logins.filter(result => result.statusCode === 429)).toHaveLength(8);
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.99', payload: { password } })).statusCode).toBe(200);
  });

  it('changes the password only with current credentials and revokes every prior session', async () => {
    const context = await make(), firstSession = await setup(context);
    const other = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
    const secondSession = sessionCookie(other), replacement = 'River-Stone-84';
    const unauthorized = await context.app.inject({ method: 'POST', url: '/api/auth/password', payload: { currentPassword: password, password: replacement } });
    expect(unauthorized.statusCode).toBe(401);
    const wrong = await context.app.inject({ method: 'POST', url: '/api/auth/password', cookies: { session: firstSession }, payload: { currentPassword: 'Incorrect-Password-47', password: replacement } });
    expect(wrong.statusCode).toBe(401);
    const changed = await context.app.inject({ method: 'POST', url: '/api/auth/password', cookies: { session: firstSession }, payload: { currentPassword: password, password: replacement } });
    expect(changed.statusCode).toBe(200);
    expect(await authenticated(context, firstSession)).toBe(false); expect(await authenticated(context, secondSession)).toBe(false);
    expect(await authenticated(context, sessionCookie(changed))).toBe(true);
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } })).statusCode).toBe(401);
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: replacement } })).statusCode).toBe(200);
    expect(context.store.db.prepare('SELECT count(*) count FROM sessions').get()!.count).toBe(2);
  });

  it('rejects competing password changes after one request has invalidated the old credentials', async () => {
    const context = await make(), session = await setup(context);
    const replacements = ['River-Stone-84', 'Forest-Bridge-63'];
    const changes = await Promise.all(replacements.map(replacement => context.app.inject({ method: 'POST', url: '/api/auth/password', cookies: { session }, payload: { currentPassword: password, password: replacement } })));
    expect(changes.filter(result => result.statusCode === 200)).toHaveLength(1);
    expect(changes.filter(result => [401, 409].includes(result.statusCode))).toHaveLength(1);
    expect(context.store.db.prepare('SELECT count(*) count FROM sessions').get()!.count).toBe(1);
    const successfulIndex = changes.findIndex(result => result.statusCode === 200);
    expect(await verifyPassword(replacements[successfulIndex], context.settings.meta('password')!)).toBe(true);
  });

  it('requires the password to revoke other sessions and rotates the current session', async () => {
    const context = await make(), session = await setup(context);
    const other = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
    const bad = await context.app.inject({ method: 'POST', url: '/api/auth/sessions/revoke', cookies: { session }, payload: { password: 'Incorrect-Password-47' } });
    expect(bad.statusCode).toBe(401); expect(await authenticated(context, session)).toBe(true);
    const revoked = await context.app.inject({ method: 'POST', url: '/api/auth/sessions/revoke', cookies: { session }, payload: { password } });
    expect(revoked.statusCode).toBe(200);
    expect(await authenticated(context, session)).toBe(false); expect(await authenticated(context, sessionCookie(other))).toBe(false);
    expect(await authenticated(context, sessionCookie(revoked))).toBe(true);
    expect(context.store.db.prepare('SELECT count(*) count FROM sessions').get()!.count).toBe(1);
  });

  it('rejects expired or logged-out sessions', async () => {
    const context = await make(), session = await setup(context);
    const logout = await context.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { session } });
    expect(logout.statusCode).toBe(200); expect(await authenticated(context, session)).toBe(false);
    const login = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
    const token = sessionCookie(login);
    context.store.db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(Date.now() - 1, tokenHash(token));
    expect(await authenticated(context, token)).toBe(false);
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/sessions/revoke', cookies: { session: token }, payload: { password } })).statusCode).toBe(401);
  });
});

describe('provider URL credential migration', () => {
  const providerSettings = (): Settings => ({
    providers: [{ id: 'fixture-provider', name: '测试连接', protocol: 'openai-chat', baseUrl: 'https://provider.example/v1?tenant=fixture', apiKey: 'fixture-independent-api-key' }],
    writingProviderId: '', planningProviderId: '', extractionProviderId: '',
  });

  it('recognizes credential parameter names without rejecting ordinary routing parameters', () => {
    for (const name of ['api_key', 'accessToken', 'secret', 'password', 'signature', 'credential', 'authorization', 'session', 'sid', 'sig', 'jwt']) {
      expect(hasUrlCredentials(`https://provider.example/v1?${name}=fixture`)).toBe(true);
    }
    expect(hasUrlCredentials('https://provider.example/v1?tenant=fixture&model=example')).toBe(false);
    expect(hasUrlCredentials('invalid')).toBe(false);
  });

  it('rejects newly entered URL credentials before changing the saved settings', async () => {
    const context = await make(), settings = providerSettings();
    context.settings.save(settings);
    const before = context.settings.meta('settings');
    settings.providers[0].baseUrl += '&api_key=fixture-url-secret';
    expect(() => context.settings.save(settings)).toThrow('服务地址不能包含密钥');
    expect(() => context.settings.resolveProvider(settings.providers[0])).toThrow('服务地址不能包含密钥');
    expect(context.settings.meta('settings')).toBe(before);
  });

  it('encrypts old URL credentials at startup while retaining the full internal configuration', async () => {
    const context = await make(); context.settings.save(providerSettings());
    const original = JSON.parse(context.settings.meta('settings')!);
    const fullUrl = 'https://provider.example/v1?tenant=fixture&api_key=fixture-url-secret&token=fixture-url-token';
    original.providers[0].baseUrl = fullUrl;
    context.settings.setMeta('settings', JSON.stringify(original));
    const migrated = new SettingsStore(context.store.db, context.dataDir);
    const stored = migrated.meta('settings')!;
    expect(stored).not.toContain('fixture-url-secret'); expect(stored).not.toContain('fixture-url-token');
    for (const name of ['novel.sqlite', 'novel.sqlite-wal']) {
      const path = join(context.dataDir, name);
      if (existsSync(path)) {
        const bytes = readFileSync(path);
        expect(bytes.includes(Buffer.from('fixture-url-secret'))).toBe(false);
        expect(bytes.includes(Buffer.from('fixture-url-token'))).toBe(false);
      }
    }
    expect(JSON.parse(stored).providers[0].baseUrl).toBe('https://provider.example/v1?tenant=fixture');
    expect(JSON.parse(stored).providers[0].baseUrlEncrypted).toBeTruthy();
    expect(migrated.get().providers[0].baseUrl).toBe(fullUrl);
    expect(migrated.get().providers[0].apiKey).toBe('fixture-independent-api-key');
    const published = migrated.public();
    expect(published.providers[0]).toMatchObject({ baseUrl: 'https://provider.example/v1?tenant=fixture', hasKey: true, hasUrlCredentials: true });
    expect(published.providers[0]).not.toHaveProperty('baseUrlEncrypted');
    expect(JSON.stringify(published)).not.toContain('fixture-url-secret'); expect(JSON.stringify(published)).not.toContain('fixture-url-token');
    expect(new SettingsStore(context.store.db, context.dataDir).meta('settings')).toBe(stored);
    migrated.setMeta('url-credentials-cleanup', '1');
    expect(new SettingsStore(context.store.db, context.dataDir).meta('url-credentials-cleanup')).toBeUndefined();
    expect(() => migrated.save(published)).toThrow('请填写独立 API 密钥');
    expect(() => migrated.save({ ...published, providers: published.providers.map(provider => ({ ...provider, apiKey: '   ' })) })).toThrow('请填写独立 API 密钥');
    expect(migrated.get().providers[0].baseUrl).toBe(fullUrl);
    const saved = migrated.save({ ...published, providers: published.providers.map(provider => ({ ...provider, apiKey: 'fixture-independent-api-key' })) });
    expect(saved.providers[0]).not.toHaveProperty('hasUrlCredentials');
    expect(migrated.get().providers[0].baseUrl).toBe('https://provider.example/v1?tenant=fixture');
    expect(migrated.get().providers[0].apiKey).toBe('fixture-independent-api-key');
    expect(JSON.parse(migrated.meta('settings')!).providers[0]).not.toHaveProperty('baseUrlEncrypted');
    const otherOrigin = { ...saved, providers: saved.providers.map(provider => ({ ...provider, baseUrl: 'https://other-provider.example/v1' })) };
    migrated.save(otherOrigin);
    expect(migrated.get().providers[0].apiKey).toBe('');
  });

  it.skipIf(process.platform === 'win32')('restricts an existing POSIX encryption key to its owner', async () => {
    const context = await make(), keyPath = join(context.dataDir, '.encryption-key');
    chmodSync(keyPath, 0o644);
    new SettingsStore(context.store.db, context.dataDir);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });
});
