import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashPassword, tokenHash, verifyPasswordWithUpgrade, type SettingsStore } from './security.js';
import type { Store } from './store.js';

const authBodyLimit = 4096;
const loginPassword = z.string().min(8, '密码至少 8 位').max(256, '密码不能超过 256 位');
const newPassword = z.string().min(12, '新密码至少 12 位').max(256, '密码不能超过 256 位').refine(password => {
  const normalized = password.trim().toLowerCase();
  return normalized.length >= 12 && !/^(.)\1+$/su.test(normalized)
    && !/^(?:password|qwerty|admin|letmein|changeme)[\d!@#$%^&*._-]*$/i.test(normalized)
    && !['123456789012', '1234567890123456', '12345678901234567890', 'abcdefghijkl', 'qwertyuiop12', 'qwertyuiop123'].includes(normalized);
}, '请使用至少 12 位有效字符，并避开空白或常见弱密码');

function fail(message: string, statusCode: number): never { throw Object.assign(new Error(message), { statusCode }); }

/** An environment value seeds a new installation; it never overwrites a saved password. */
export async function initializePassword(settings: SettingsStore, password: string | undefined) {
  if (settings.meta('password')) return false;
  if (!password) throw new Error('首次启动请设置 INITIAL_PASSWORD 环境变量。');
  if (!newPassword.safeParse(password).success) throw new Error('INITIAL_PASSWORD 必须为 12～256 位，去除首尾空白后至少 12 位，且不能使用空白或常见弱密码。');
  const hash = await hashPassword(password);
  return settings.setInitialPasswordHash(hash);
}

/** Limit work before parsing the request body. Saturation denies new addresses rather than evicting active limits. */
function rateLimit(maximum: number) {
  const windowMs = 300000, maximumAddresses = 4096;
  const attempts = new Map<string, { count: number; since: number }>();
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    for (const [address, attempt] of attempts) if (now - attempt.since >= windowMs) attempts.delete(address);
    const previous = attempts.get(request.ip);
    if ((!previous && attempts.size >= maximumAddresses) || (previous && previous.count >= maximum)) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil((previous ? windowMs - (now - previous.since) : windowMs) / 1000))));
      fail('尝试次数较多，请五分钟后重试。', 429);
    }
    const attempt = previous || { count: 0, since: now };
    attempt.count++; attempts.set(request.ip, attempt);
  };
}

export type AuthOptions = {
  settings: SettingsStore;
  store: Store;
  secureCookies: boolean;
  loginAttempts?: number;
};

export function registerAuthRoutes(app: FastifyInstance, options: AuthOptions) {
  const { settings, store, secureCookies } = options;
  const isAuthenticated = (token?: string) => Boolean(token && store.db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash(token), Date.now()));
  const createSession = (reply: FastifyReply) => {
    const token = randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES (?,?)').run(tokenHash(token), Date.now() + 7 * 86400000);
    reply.setCookie('session', token, { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookies, maxAge: 7 * 86400 });
  };
  const requireSession = (request: FastifyRequest) => { if (!isAuthenticated(request.cookies.session)) fail('请先登录。', 401); };
  let activePasswordWork = 0;
  const passwordWork = async <T>(work: () => Promise<T>) => {
    if (activePasswordWork >= 4) fail('登录验证繁忙，请稍后重试。', 429);
    activePasswordWork++;
    try { return await work(); } finally { activePasswordWork--; }
  };
  const verifyCurrent = async (password: string, request?: FastifyRequest) => {
    const stored = settings.meta('password') || '';
    const result = await passwordWork(() => verifyPasswordWithUpgrade(password, stored));
    // Recheck both credentials and the session after asynchronous password work.
    if (!result.valid || settings.meta('password') !== stored) fail('密码不正确或已经变更。', 401);
    if (request) requireSession(request);
    return { stored, upgradedHash: result.upgradedHash };
  };
  const loginLimit = rateLimit(options.loginAttempts ?? 10), sensitiveLimit = rateLimit(5);
  const sensitiveOnRequest = async (request: FastifyRequest, reply: FastifyReply) => { requireSession(request); await sensitiveLimit(request, reply); };

  app.get('/api/auth/status', async request => {
    const initialized = Boolean(settings.meta('password'));
    return { initialized, authenticated: isAuthenticated(request.cookies.session) };
  });
  app.post('/api/auth/login', { bodyLimit: authBodyLimit, onRequest: loginLimit }, async (request, reply) => {
    const { password } = z.object({ password: loginPassword }).strict().parse(request.body);
    const { upgradedHash } = await verifyCurrent(password);
    if (upgradedHash) settings.setMeta('password', upgradedHash);
    createSession(reply); return { ok: true };
  });
  app.post('/api/auth/logout', { bodyLimit: authBodyLimit }, async (request, reply) => {
    if (request.cookies.session) store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(request.cookies.session));
    reply.clearCookie('session', { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookies });
    return { ok: true };
  });
  app.post('/api/auth/password', { bodyLimit: authBodyLimit, onRequest: sensitiveOnRequest }, async (request, reply) => {
    const { currentPassword, password } = z.object({ currentPassword: loginPassword, password: newPassword }).strict().parse(request.body);
    const { stored } = await verifyCurrent(currentPassword, request);
    const replacement = await passwordWork(() => hashPassword(password));
    if (settings.meta('password') !== stored) fail('密码已经变更，请重新登录。', 409);
    requireSession(request);
    store.db.exec('BEGIN IMMEDIATE');
    try { settings.setMeta('password', replacement); store.db.exec('DELETE FROM sessions'); createSession(reply); store.db.exec('COMMIT'); }
    catch (error) { store.db.exec('ROLLBACK'); throw error; }
    return { ok: true };
  });
  app.post('/api/auth/sessions/revoke', { bodyLimit: authBodyLimit, onRequest: sensitiveOnRequest }, async (request, reply) => {
    const { password } = z.object({ password: loginPassword }).strict().parse(request.body);
    const { upgradedHash } = await verifyCurrent(password, request);
    store.db.exec('BEGIN IMMEDIATE');
    try {
      if (upgradedHash) settings.setMeta('password', upgradedHash);
      store.db.exec('DELETE FROM sessions'); createSession(reply); store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    return { ok: true };
  });
}
