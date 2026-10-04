import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, post, put } from '../client/api.js';
import { buildApp } from '../server/app.js';
import type { BranchView, Job, Project, SourcePreview } from '../shared/types.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const context of apps.splice(0)) await context.app.close();
});

async function fixture() {
  const context = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'ai-novel-client-api-')), startEngine: false });
  apps.push(context);
  const received: { method: string; path: string; contentType?: string; customHeader?: string }[] = [];
  context.app.addHook('onRequest', async request => {
    received.push({ method: request.method, path: request.url, contentType: request.headers['content-type'], customHeader: request.headers['x-regression'] as string | undefined });
  });
  const setup = await context.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'client-api-test-password' } });
  expect(setup.statusCode).toBe(200);
  const session = setup.cookies.find(cookie => cookie.name === 'session')!.value;
  received.length = 0;
  // Keep the real client helpers and Fastify JSON/multipart parsers. Only bridge
  // browser fetch to injection; native Request performs FormData boundary encoding.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), 'http://client.test'), init);
    const url = new URL(request.url);
    request.headers.set('cookie', `session=${session}`);
    const response = await context.app.inject({
      method: request.method as 'GET' | 'POST' | 'PUT',
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      payload: request.body ? Buffer.from(await request.arrayBuffer()) : undefined,
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    }
    return new Response(response.body, { status: response.statusCode, headers: responseHeaders });
  }));
  return { ...context, received, session };
}

describe('real client requests through Fastify parsers', () => {
  it('retries and cancels a failed task without sending an empty JSON body', async () => {
    const context = await fixture();
    const project = context.store.createProject({ title: '任务操作回归' });
    const branch = context.store.getBranch(project.mainBranchId);
    const job = context.engine.enqueue(branch.id, 'import', { baseRevisionId: branch.revisionId, chapters: [{ title: '第一章', text: '只有测试正文。' }], sourceId: 'test-source' });
    const markFailed = () => {
      const saved = JSON.parse(String(context.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data)) as Job;
      saved.status = 'failed'; saved.error = '模拟的上游错误';
      context.store.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(saved.status, JSON.stringify(saved), job.id);
    };
    markFailed();
    expect((await post<Job>(`/jobs/${job.id}/retry?view=author`)).status).toBe('queued');
    markFailed();
    expect((await post<Job>(`/jobs/${job.id}/cancel?view=author`)).status).toBe('cancelled');
    expect(context.received).toHaveLength(2);
    expect(context.received.every(request => request.contentType === undefined)).toBe(true);
    expect(context.engine.listJobs(project.id)[0].status).toBe('cancelled');
  });

  it('logs out with a bodyless POST and invalidates the existing session', async () => {
    const context = await fixture();
    expect(await post('/auth/logout')).toEqual({ ok: true });
    expect(await api('/auth/status')).toEqual({ initialized: true, authenticated: false });
    expect(context.received[0]).toMatchObject({ method: 'POST', path: '/api/auth/logout', contentType: undefined });
  });

  it('still encodes JSON POST and PUT bodies for the actual API routes', async () => {
    const context = await fixture();
    const project = await post<Project>('/projects', { title: 'JSON 创建作品', premise: 'JSON 中的中文设定', mode: 'original' });
    expect(project.title).toBe('JSON 创建作品');
    const branch = context.store.getBranch(project.mainBranchId);
    const outline = { worldview: '旧城建于一座失落王国的遗址上。', locked: '主角只有一个。', fine: [] };
    const view = await put<BranchView>(`/branches/${branch.id}/outline`, { baseRevisionId: branch.revisionId, outline });
    expect(view.state.outline).toEqual(outline);
    expect(context.received.map(request => request.contentType)).toEqual(['application/json', 'application/json']);
  });

  it('lets FormData supply its boundary and imports the exact uploaded text', async () => {
    const context = await fixture();
    const project = context.store.createProject({ title: '上传边界回归' });
    const original = '第一章 城门\n林舟来到白石城。\n\n他看见城门旁的石碑。';
    const form = new FormData();
    form.append('file', new Blob([original], { type: 'text/plain' }), 'novel.txt');
    const preview = await api<SourcePreview>(`/projects/${project.id}/import`, { method: 'POST', body: form });
    expect(preview.chapters).toEqual([{ title: '第一章 城门', text: '林舟来到白石城。\n\n他看见城门旁的石碑。' }]);
    expect(context.received[0].contentType).toMatch(/^multipart\/form-data; boundary=.+/);
    const download = await context.app.inject({ url: `/api/sources/${preview.source.id}/file`, cookies: { session: context.session } });
    expect(download.rawPayload.toString('utf8')).toBe(original);
  });

  it('preserves a caller-supplied Headers object and an explicit JSON content type', async () => {
    const context = await fixture();
    const headers = new Headers({ 'X-Regression': 'keep-this-header', 'Content-Type': 'application/json; charset=utf-8' });
    const project = await api<Project>('/projects', { method: 'POST', headers, body: JSON.stringify({ title: '自定义请求头' }) });
    expect(project.title).toBe('自定义请求头');
    expect(context.received[0]).toMatchObject({ customHeader: 'keep-this-header', contentType: 'application/json; charset=utf-8' });
    expect(headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });
});
