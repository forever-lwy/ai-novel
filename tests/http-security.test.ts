import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { buildApp } from '../server/app.js';
import { httpSecurityConfig, safeRequestLog, RequestRateLimit } from '../server/http-security.js';
import { secureDataDirectory } from '../server/private-files.js';
import { checkBackupSize } from '../server/backup-limits.js';
import { verifyPassword } from '../server/security.js';
import type { FastifyRequest } from 'fastify';
import type { WritingEvent } from '../shared/types.js';

const contexts: Awaited<ReturnType<typeof buildApp>>[] = []; const directories: string[] = [];
const password = 'fixture-account-password';
beforeEach(() => { for (const name of ['PUBLIC_ORIGIN', 'COOKIE_SECURE', 'TRUSTED_PROXIES', 'HOST', 'OUTBOUND_ALLOWED_ORIGINS', 'INITIAL_PASSWORD']) vi.stubEnv(name, ''); vi.stubEnv('NODE_ENV', 'test'); });
afterEach(async () => { for (const context of contexts.splice(0)) await context.app.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function make() { const dataDir = mkdtempSync(join(tmpdir(), 'novel-http-security-')); directories.push(dataDir); const context = await buildApp({ dataDir, startEngine: false, staticDir: join(dataDir, 'no-web'), initialPassword: password }); contexts.push(context); return context; }
async function setup(context: Awaited<ReturnType<typeof make>>) { const response = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } }); expect(response.statusCode).toBe(200); return response.cookies.find(cookie => cookie.name === 'session')!.value; }

describe('HTTP authentication and deployment boundaries', () => {
  it('applies session protection to the matched route regardless of prefix spelling', async () => {
    const context = await make(); await setup(context);
    for (const url of ['/api/settings', '/%61pi/settings', '/a%70i/projects']) expect((await context.app.inject(url)).statusCode).toBe(401);
  });
  it('initializes before serving and uses secure cookies for a configured HTTPS site', async () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'https://novel.example');
    const context = await make();
    const status = await context.app.inject('/api/auth/status'); expect(status.json()).toEqual({ initialized: true, authenticated: false });
    expect(status.body).not.toContain(password); expect(status.body).not.toContain(context.settings.meta('password')!);
    expect(existsSync(join(context.dataDir, '.setup-token'))).toBe(false);
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password } })).statusCode).toBe(404);
    const result = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
    expect(result.statusCode).toBe(200); expect(String(result.headers['set-cookie'])).toContain('Secure');
    const session = result.cookies.find(cookie => cookie.name === 'session')!.value;
    expect((await context.app.inject({ method: 'POST', url: '/api/projects', cookies: { session }, headers: { origin: 'http://novel.example' }, payload: { title: 'fixture' } })).statusCode).toBe(403);
  });
  it('accepts only explicit trusted proxy ranges and refuses insecure public cookie configuration', () => {
    for (const value of ['true', '*', '0.0.0.0/0', '::/0']) { vi.stubEnv('TRUSTED_PROXIES', value); expect(() => httpSecurityConfig()).toThrow('代理'); }
    vi.stubEnv('TRUSTED_PROXIES', '127.0.0.1,::1'); expect(httpSecurityConfig().trustedProxies).toEqual(['127.0.0.1', '::1']);
    vi.stubEnv('PUBLIC_ORIGIN', 'https://novel.example'); vi.stubEnv('COOKIE_SECURE', 'false'); expect(() => httpSecurityConfig()).toThrow('安全 Cookie');
  });
  it('rejects missing or invalid initial passwords before starting an empty database', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const dataDir = mkdtempSync(join(tmpdir(), 'novel-bootstrap-security-')); directories.push(dataDir);
    const options = { dataDir, startEngine: false, staticDir: join(dataDir, 'no-web') };
    for (const value of [undefined, '', 'short']) {
      vi.stubEnv('INITIAL_PASSWORD', value);
      expect(process.env.INITIAL_PASSWORD).toBe(value);
      let failure: unknown;
      try { const unexpected = await buildApp(options); contexts.push(unexpected); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('INITIAL_PASSWORD');
      if (value) expect((failure as Error).message).not.toContain(value);
    }
    vi.stubEnv('INITIAL_PASSWORD', password);
    const context = await buildApp(options); contexts.push(context);
    expect(await verifyPassword(password, context.settings.meta('password')!)).toBe(true);
    expect((await context.app.inject('/api/auth/status')).json()).toEqual({ initialized: true, authenticated: false });
  });
  it('preserves a changed password on restart and removes an obsolete installation token', async () => {
    const context = await make(), session = await setup(context), replacement = 'Changed-Fixture-Password-84';
    const changed = await context.app.inject({ method: 'POST', url: '/api/auth/password', cookies: { session }, payload: { currentPassword: password, password: replacement } });
    expect(changed.statusCode).toBe(200);
    const stored = context.settings.meta('password')!;
    const dataDir = context.dataDir;
    await context.app.close(); contexts.splice(contexts.indexOf(context), 1);
    const path = join(dataDir, '.setup-token'); writeFileSync(path, 'obsolete-fixture-token');
    for (const initial of [undefined, 'weak', password]) {
      vi.stubEnv('INITIAL_PASSWORD', initial);
      const reopened = await buildApp({ dataDir, startEngine: false, staticDir: join(dataDir, 'no-web') }); contexts.push(reopened);
      expect(reopened.settings.meta('password')).toBe(stored); expect(existsSync(path)).toBe(false);
      expect((await reopened.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: replacement } })).statusCode).toBe(200);
      expect((await reopened.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } })).statusCode).toBe(401);
      await reopened.app.close(); contexts.splice(contexts.indexOf(reopened), 1);
    }
  });
  it('keeps login failure limits separate for visitors forwarded by a trusted proxy', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '127.0.0.1'); const context = await make(); await setup(context);
    for (let i = 0; i < 10; i++) expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.10' }, payload: { password: 'fixture-wrong-password' } })).statusCode).toBe(401);
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.11' }, payload: { password } })).statusCode).toBe(200);
  });
  it('bounds public login bodies and request receiving time', async () => {
    const context = await make();
    const result = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password, padding: 'fixture'.repeat(1000) } });
    expect(result.statusCode).toBe(413); expect(context.app.server.requestTimeout).toBe(120000); expect(context.app.server.headersTimeout).toBe(30000);
  });
  it('omits sensitive request fields and query values from logs and bounds limiter bookkeeping', () => {
    const log = safeRequestLog({ method: 'POST', url: '/api/auth/login?password=fixture-password', routeOptions: { url: '/api/auth/login' }, ip: '127.0.0.1', body: { password }, headers: { cookie: 'fixture-cookie' } } as unknown as FastifyRequest);
    expect(JSON.stringify(log)).not.toContain('fixture-password'); expect(log).not.toHaveProperty('body'); expect(log).not.toHaveProperty('headers');
    const limit = new RequestRateLimit(2, 100, 1); expect(limit.accept('a', 0)).toBe(true); expect(limit.accept('a', 1)).toBe(true); expect(limit.accept('a', 2)).toBe(false); expect(limit.accept('b', 3)).toBe(false); expect(limit.accept('b', 101)).toBe(true);
  });
  it('closes an existing author stream after its session is revoked', async () => {
    const context = await make(); const session = await setup(context); const project = context.store.createProject({ title: 'stream fixture' });
    const job = context.engine.enqueue(project.mainBranchId, 'generate', { mode: 'original', instruction: '', baseRevisionId: context.store.getBranch(project.mainBranchId).revisionId });
    const url = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${url}/api/jobs/${job.id}/events?view=author`, { headers: { cookie: `session=${session}` } }); const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/sessions/revoke', cookies: { session }, payload: { password } })).statusCode).toBe(200);
    (context.engine as unknown as { emitWriting(id: string, event: WritingEvent): void }).emitWriting(job.id, { type: 'delta', text: 'normal fixture continuation' });
    expect((await reader.read()).done).toBe(true); reader.releaseLock();
  });
  it('checks original-file size before building a complete backup', async () => {
    const context = await make(); const project = context.store.createProject({ title: 'backup fixture' }); const sources = join(context.dataDir, 'sources');
    writeFileSync(join(sources, 'fixture-source'), 'x'.repeat(8000));
    context.store.db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?)').run('fixture-source', project.id, 'fixture.txt', 'txt', 1, new Date().toISOString(), 0, '[{"title":"fixture","text":"fixture"}]', 'fixture-source');
    expect(() => checkBackupSize(context.store.db, sources, project.id, 12000)).toThrow('安全容量');
    expect(() => checkBackupSize(context.store.db, sources, project.id, 30000)).not.toThrow();
  });
  it('preserves fictional JSON prose in a backup while redacting known credentials in process drafts', async () => {
    const context = await make(); const session = await setup(context); const project = context.store.createProject({ title: 'author text fixture' });
    const text = '{"password":"fictional-book-word"}'; const branch = context.store.getBranch(project.mainBranchId);
    const state = context.store.state(branch.id); state.chapters.push({ ...context.store.putChapter('fixture', text), status: 'ready' });
    context.store.commit(branch.id, branch.revisionId, state, 'ready author fixture');
    const secret = 'fixture-backup-key-only'; context.settings.save({ providers: [{ id: 'fixture', name: 'fixture', protocol: 'openai-chat', baseUrl: 'https://provider.example/v1', apiKey: secret }], writingProviderId: '', planningProviderId: '', extractionProviderId: '' });
    const job = context.engine.enqueue(branch.id, 'generate', { mode: 'original', instruction: '', baseRevisionId: context.store.getBranch(branch.id).revisionId });
    context.store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?)').run(job.id, secret);
    const backup = await context.app.inject({ url: `/api/projects/${project.id}/backup`, cookies: { session } }); expect(backup.statusCode).toBe(200);
    const data = JSON.parse(gunzipSync(backup.rawPayload).toString()); expect(data.project.chapters[0].text).toBe(text);
    expect(data.project.writingDrafts[0].text).toBe('[REDACTED]');
  });
});

describe('private data permissions', () => {
  it('keeps existing fixture contents and confines permissions to owner and service accounts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-private-files-')); directories.push(directory); mkdirSync(join(directory, 'sources')); writeFileSync(join(directory, 'sources', 'fixture'), 'private fixture');
    secureDataDirectory(directory); expect(readFileSync(join(directory, 'sources', 'fixture'), 'utf8')).toBe('private fixture');
    if (process.platform === 'win32') {
      const powershellDir = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
      const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
      const rules = execFileSync(join(powershellDir, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; (Get-Acl -LiteralPath $env:AI_NOVEL_PRIVATE_DIR).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }"], { env: { ...childEnv, PSModulePath: join(powershellDir, 'Modules'), AI_NOVEL_PRIVATE_DIR: directory }, windowsHide: true, encoding: 'utf8' });
      for (const sid of ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545']) expect(rules).not.toContain(sid);
    } else { expect(statSync(directory).mode & 0o777).toBe(0o700); expect(statSync(join(directory, 'sources', 'fixture')).mode & 0o777).toBe(0o600); }
  });
});
