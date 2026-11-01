import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import type { Job, ModelOutputRecord, Project } from '../shared/types.js';

type Context = Awaited<ReturnType<typeof buildApp>>;
const contexts: Context[] = [];
const directories: string[] = [];
const password = 'cleanup-fixture-password';
const unlimited = () => ({ maxAgeDays: 0, maxCount: 0 });
const defaults = () => ({ enabled: false, history: unlimited(), requests: unlimited(), jobs: unlimited() });
const countPolicy = () => ({ ...defaults(), requests: { maxAgeDays: 0, maxCount: 1 }, jobs: { maxAgeDays: 0, maxCount: 1 } });

beforeEach(() => {
  for (const name of ['PUBLIC_ORIGIN', 'COOKIE_SECURE', 'TRUSTED_PROXIES', 'HOST', 'OUTBOUND_ALLOWED_ORIGINS', 'INITIAL_PASSWORD']) vi.stubEnv(name, '');
  vi.stubEnv('NODE_ENV', 'test');
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.app.close();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function make(dataDir?: string, startEngine = false) {
  if (!dataDir) { dataDir = mkdtempSync(join(tmpdir(), 'novel-cleanup-http-')); directories.push(dataDir); }
  const context = await buildApp({ dataDir, startEngine, staticDir: join(dataDir, 'no-web'), initialPassword: password });
  contexts.push(context); return context;
}
async function login(context: Context) {
  const result = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
  expect(result.statusCode).toBe(200);
  return { session: result.cookies.find(cookie => cookie.name === 'session')!.value };
}
async function close(context: Context) { await context.app.close(); contexts.splice(contexts.indexOf(context), 1); }
function addFinishedRequest(context: Context, project: Project, year: number) {
  const stamp = `${year}-01-01T00:00:00.000Z`;
  const job: Job = { id: randomUUID(), projectId: project.id, branchId: project.mainBranchId, baseRevisionId: context.store.getBranch(project.mainBranchId).revisionId, kind: 'extract', status: 'completed', progress: 1, total: 1, message: 'fixture complete', inputTokens: 1, outputTokens: 1, createdAt: stamp, updatedAt: stamp, payload: {} };
  const output: ModelOutputRecord = { id: randomUUID(), jobId: job.id, projectId: project.id, branchId: job.branchId, baseRevisionId: job.baseRevisionId, stage: 'writing', status: 'applied', createdAt: stamp, updatedAt: stamp, rawResponse: 'fixture response', text: 'fixture response', inputTokens: 1, outputTokens: 1, issues: [] };
  job.payload.lastOutputId = output.id;
  context.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, job.branchId, job.projectId, job.status, JSON.stringify(job));
  context.store.outputs.insert(output);
  return { job, output };
}
function fixture(context: Context) {
  const project = context.store.createProject({ title: 'cleanup fixture' });
  const records = [2001, 2002, 2003].map(year => addFinishedRequest(context, project, year));
  return { project, records };
}
function counts(context: Context) {
  return Object.fromEntries(['revisions', 'model_outputs', 'jobs', 'chapter_texts', 'image_assets'].map(table => [table, Number(context.store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count)]));
}

describe('data cleanup HTTP API', () => {
  it('requires authentication for reading, saving, previewing and executing cleanup', async () => {
    const context = await make();
    for (const request of [
      { method: 'GET' as const, url: '/api/data-cleanup' },
      { method: 'PUT' as const, url: '/api/data-cleanup', payload: { settings: defaults() } },
      { method: 'POST' as const, url: '/api/data-cleanup/preview', payload: { settings: defaults() } },
      { method: 'POST' as const, url: '/api/data-cleanup/run', payload: { settings: defaults(), expectedFingerprint: 'a'.repeat(64) } },
    ]) expect((await context.app.inject(request)).statusCode).toBe(401);
  });

  it('defaults to disabled and persists cleanup settings independently of provider settings', async () => {
    const context = await make(), cookies = await login(context);
    const initial = await context.app.inject({ url: '/api/data-cleanup', cookies });
    expect(initial.statusCode).toBe(200); expect(initial.json()).toEqual({ settings: defaults() });
    const originalSettings = context.settings.public();
    const settings = { enabled: true, history: { maxAgeDays: 90, maxCount: 200 }, requests: { maxAgeDays: 30, maxCount: 1000 }, jobs: { maxAgeDays: 60, maxCount: 300 } };
    const saved = await context.app.inject({ method: 'PUT', url: '/api/data-cleanup', cookies, payload: { settings } });
    expect(saved.statusCode).toBe(200); expect(saved.json().settings).toEqual(settings);
    expect(JSON.parse(context.settings.meta('data-cleanup-settings')!)).toEqual(settings);
    expect(context.settings.public()).toEqual(originalSettings);
    const dataDir = context.dataDir; await close(context);
    const reopened = await make(dataDir), nextCookies = await login(reopened);
    expect((await reopened.app.inject({ url: '/api/data-cleanup', cookies: nextCookies })).json().settings).toEqual(settings);
    expect(reopened.settings.public()).toEqual(originalSettings);
  });

  it('rejects invalid policies and unexpected fields without changing the saved policy', async () => {
    const context = await make(), cookies = await login(context);
    const badPolicies: unknown[] = [
      { ...defaults(), enabled: 'true' },
      { ...defaults(), history: { maxAgeDays: -1, maxCount: 0 } },
      { ...defaults(), requests: { maxAgeDays: 36501, maxCount: 0 } },
      { ...defaults(), jobs: { maxAgeDays: 0, maxCount: 1000001 } },
      { ...defaults(), history: { maxAgeDays: 1.5, maxCount: 0 } },
      { ...defaults(), requests: { maxAgeDays: 0, maxCount: '10' } },
      { ...defaults(), jobs: { maxAgeDays: 0 } },
      { ...defaults(), extra: true },
      { ...defaults(), history: { ...unlimited(), extra: true } },
    ];
    for (const settings of badPolicies) for (const route of [
      { method: 'PUT' as const, url: '/api/data-cleanup' },
      { method: 'POST' as const, url: '/api/data-cleanup/preview' },
    ]) expect((await context.app.inject({ ...route, cookies, payload: { settings } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'PUT', url: '/api/data-cleanup', cookies, payload: { settings: defaults(), projectId: 'unexpected' } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'POST', url: '/api/data-cleanup/run', cookies, payload: { settings: defaults() } })).statusCode).toBe(400);
    expect((await context.app.inject({ url: '/api/data-cleanup', cookies })).json().settings).toEqual(defaults());
  });

  it('previews deletions without writing settings, records or last-run metadata', async () => {
    const context = await make(), cookies = await login(context); fixture(context);
    const before = counts(context);
    const changes = context.store.db.prepare('SELECT total_changes() AS count').get()!.count;
    const preview = await context.app.inject({ method: 'POST', url: '/api/data-cleanup/preview', cookies, payload: { settings: countPolicy() } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ requests: 2, jobs: 2, revisions: 0, chapters: 0, images: 0 });
    expect(preview.json().fingerprint).toEqual(expect.any(String));
    expect(preview.json()).not.toHaveProperty('completedAt');
    expect(counts(context)).toEqual(before);
    expect(context.store.db.prepare('SELECT total_changes() AS count').get()!.count).toBe(changes);
    expect((await context.app.inject({ url: '/api/data-cleanup', cookies })).json()).toEqual({ settings: defaults() });
  });

  it('refuses an outdated preview and leaves all data intact', async () => {
    const context = await make(), cookies = await login(context), { project } = fixture(context);
    const settings = countPolicy();
    const preview = await context.app.inject({ method: 'POST', url: '/api/data-cleanup/preview', cookies, payload: { settings } });
    expect(preview.statusCode).toBe(200);
    addFinishedRequest(context, project, 2004);
    const before = counts(context);
    const result = await context.app.inject({ method: 'POST', url: '/api/data-cleanup/run', cookies, payload: { settings, expectedFingerprint: preview.json().fingerprint } });
    expect(result.statusCode).toBe(409); expect(counts(context)).toEqual(before);
    expect((await context.app.inject({ url: '/api/data-cleanup', cookies })).json()).not.toHaveProperty('lastRun');
  });

  it('executes the confirmed plan, keeps the newest records and reports the completed run', async () => {
    const context = await make(), cookies = await login(context), { records } = fixture(context);
    const settings = countPolicy();
    const preview = await context.app.inject({ method: 'POST', url: '/api/data-cleanup/preview', cookies, payload: { settings } });
    const result = await context.app.inject({ method: 'POST', url: '/api/data-cleanup/run', cookies, payload: { settings, expectedFingerprint: preview.json().fingerprint } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ requests: 2, jobs: 2, revisions: 0 });
    expect(Number.isNaN(Date.parse(result.json().completedAt))).toBe(false);
    expect(counts(context)).toMatchObject({ model_outputs: 1, jobs: 1 });
    expect(context.store.outputs.get(records[0].output.id)).toBeUndefined();
    expect(context.store.outputs.get(records[2].output.id)?.text).toBe('fixture response');
    const current = await context.app.inject({ url: '/api/data-cleanup', cookies });
    expect(current.json().lastRun).toEqual(result.json());
    expect(current.json().settings).toEqual(defaults());
  });

  it('leaves accumulated data alone on startup and hourly checks while automatic cleanup is disabled', async () => {
    const context = await make(); fixture(context); const dataDir = context.dataDir; await close(context);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const reopened = await make(dataDir, true);
    expect(counts(reopened)).toMatchObject({ model_outputs: 3, jobs: 3 });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(counts(reopened)).toMatchObject({ model_outputs: 3, jobs: 3 });
    await close(reopened); expect(vi.getTimerCount()).toBe(0);
  });

  it('runs a saved enabled policy on startup and hourly, and removes its timer on close', async () => {
    const context = await make(), cookies = await login(context), { project } = fixture(context);
    const settings = { ...countPolicy(), enabled: true };
    expect((await context.app.inject({ method: 'PUT', url: '/api/data-cleanup', cookies, payload: { settings } })).statusCode).toBe(200);
    const dataDir = context.dataDir; await close(context);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const reopened = await make(dataDir, true);
    expect(counts(reopened)).toMatchObject({ model_outputs: 1, jobs: 1 });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    addFinishedRequest(reopened, project, 2004);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(counts(reopened)).toMatchObject({ model_outputs: 1, jobs: 1 });
    await close(reopened); expect(vi.getTimerCount()).toBe(0);
  });
});
