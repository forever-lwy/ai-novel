import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildApp } from '../server/app.js';
import type { Entity, Settings } from '../shared/types.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const ctx of apps.splice(0)) await ctx.app.close(); });
async function make() { const ctx = await buildApp({ initialPassword: 'story-password-123', dataDir: mkdtempSync(join(tmpdir(), 'ai-novel-api-')), startEngine: false }); apps.push(ctx); return ctx; }
async function login(ctx: Awaited<ReturnType<typeof buildApp>>) {
  const response = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'story-password-123' } });
  expect(response.statusCode).toBe(200);
  return response.cookies.find(c => c.name === 'session')!.value;
}
function form(filename: string, contents: string | Buffer) {
  const boundary = 'novel-testing-boundary';
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(contents), Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}
describe('HTTP boundaries and persistence', () => {
  it('requires a session, rate limits login and rejects cross-origin mutation', async () => {
    const ctx = await make();
    expect((await ctx.app.inject('/api/auth/status')).json()).toEqual({ initialized: true, authenticated: false });
    expect((await ctx.app.inject('/api/projects')).statusCode).toBe(401);
    const session = await login(ctx);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/projects', cookies: { session }, headers: { origin: 'https://untrusted.invalid' }, payload: { title: 'bad' } })).statusCode).toBe(403);
    for (let i = 0; i < 9; i++) expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong-password-123' } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong-password-123' } })).statusCode).toBe(429);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { session } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ url: '/api/projects', cookies: { session } })).statusCode).toBe(401);
  });
  it('persists encrypted keys, masks them in responses and keeps them out of backups', async () => {
    const ctx = await make(), session = await login(ctx);
    const input: Settings = { providers: [{ id: 'test', name: '测试', protocol: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'example', apiKey: 'private-test-secret', maxOutputTokens: 2048, contextTokens: 32000 }], writingProviderId: 'test', planningProviderId: 'test', extractionProviderId: 'test' };
    const response = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: { session }, payload: input });
    expect(response.statusCode).toBe(200); expect(response.body).not.toContain('private-test-secret');
    expect(response.json().providers[0]).toMatchObject({ hasKey: true });
    expect(ctx.settings.meta('settings')).not.toContain('private-test-secret');
    input.providers[0].apiKey = '';
    await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: { session }, payload: input });
    expect(ctx.settings.get().providers[0].apiKey).toBe('private-test-secret');
    const project = ctx.store.createProject({ title: '秘密之外', premise: '故事设定' });
    const backup = await ctx.app.inject({ url: `/api/projects/${project.id}/backup`, cookies: { session } });
    expect(backup.statusCode).toBe(200); const backupText = gunzipSync(backup.rawPayload).toString(); expect(backupText).not.toContain('private-test-secret'); expect(backupText).not.toContain('story-password-123');
    expect(readFileSync(join(ctx.dataDir, '.encryption-key')).length).toBe(32);
    input.providers[0].baseUrl = 'http://127.0.0.1:12345/v1';
    await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: { session }, payload: input });
    expect(ctx.settings.get().providers[0].apiKey).toBe('');
    input.providers[0].apiKey = 'second-secret';
    await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: { session }, payload: input });
    input.providers[0].apiKey = ''; input.providers[0].clearApiKey = true;
    await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: { session }, payload: input });
    expect(ctx.settings.public().providers[0].hasKey).toBe(false);
  });
  it('reader views and search omit private planning and private entity facts', async () => {
    const ctx = await make(), session = await login(ctx);
    const p = ctx.store.createProject({ title: '隐秘档案', premise: '未来真相不公开' });
    let branch = ctx.store.getBranch(p.mainBranchId);
    const entity: Entity = { id: 'public-person', name: '林舟', aliases: [], kind: 'character', description: '城中旅人', locked: false, visibility: 'public', facts: [{ id: 'hidden-fact', text: '幕后身份是守门人', temporal: 'current', certainty: 'fact', visibility: 'secret' }, { id: 'future-fact', text: '明天成为城主', temporal: 'future', certainty: 'fact', visibility: 'public' }] };
    branch = ctx.store.updateEntity(branch.id, branch.revisionId, entity).branch;
    branch = ctx.store.updateEntity(branch.id, branch.revisionId, { ...entity, id: 'other', name: '隐藏人物', visibility: 'secret' }).branch;
    ctx.store.updateForeshadows(branch.id, branch.revisionId, [{ id: 'f1', title: '最后的钥匙', detail: '秘密揭晓答案', status: 'planned', revealCondition: '第三章', relatedEntityIds: [] }]);
    const reader = await ctx.app.inject({ url: `/api/branches/${branch.id}`, cookies: { session } });
    expect(reader.statusCode).toBe(200);
    for (const secret of ['幕后身份', '明天成为城主', '隐藏人物', '秘密揭晓答案', '未来真相不公开']) expect(reader.body).not.toContain(secret);
    const author = await ctx.app.inject({ url: `/api/branches/${branch.id}?view=author`, cookies: { session } });
    expect(author.body).toContain('秘密揭晓答案');
    expect((await ctx.app.inject({ url: `/api/projects/${p.id}`, cookies: { session } })).body).not.toContain('未来真相不公开');
    expect((await ctx.app.inject({ url: '/api/projects', cookies: { session } })).body).not.toContain('未来真相不公开');
    expect((await ctx.app.inject({ url: `/api/projects/${p.id}?view=author`, cookies: { session } })).body).toContain('未来真相不公开');
    expect((await ctx.app.inject({ url: `/api/branches/${branch.id}/search?q=${encodeURIComponent('幕后')}`, cookies: { session } })).json().entities).toEqual([]);
    ctx.store.saveChapter(branch.id, { baseRevisionId: ctx.store.getBranch(branch.id).revisionId, title: '已完成正文', text: '林舟走进城里。' });
    const job = ctx.engine.enqueue(branch.id, 'plan', { baseRevisionId: ctx.store.getBranch(branch.id).revisionId });
    const row = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data));
    row.status = 'failed'; row.message = '规划幕后身份失败'; row.error = '幕后身份是守门人';
    ctx.store.db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run('failed', JSON.stringify(row), job.id);
    expect((await ctx.app.inject({ url: `/api/jobs?projectId=${p.id}`, cookies: { session } })).body).not.toContain('幕后');
    expect((await ctx.app.inject({ url: `/api/jobs?projectId=${p.id}&view=author`, cookies: { session } })).body).toContain('幕后');
  });
  it('keeps uploaded original bytes and restores a separate project without overwriting the original', async () => {
    const ctx = await make(), session = await login(ctx);
    const p = ctx.store.createProject({ title: '原文档案' });
    const contents = Buffer.from('第一章 雨\r\n林舟站在桥边。\r\n\r\n第二章 风\r\n他看见远处的灯。', 'utf8');
    const upload = await ctx.app.inject({ method: 'POST', url: `/api/projects/${p.id}/import`, cookies: { session }, ...form('novel.txt', contents) });
    expect(upload.statusCode).toBe(200);
    const source = upload.json().source; expect(upload.json().chapters).toHaveLength(2);
    const original = await ctx.app.inject({ url: `/api/sources/${source.id}/file`, cookies: { session } });
    expect(original.rawPayload).toEqual(contents);
    const backup = await ctx.app.inject({ url: `/api/projects/${p.id}/backup`, cookies: { session } });
    const restore = await ctx.app.inject({ method: 'POST', url: '/api/restore', cookies: { session }, ...form('novel.ai-novel.json.gz', backup.rawPayload) });
    expect(restore.statusCode).toBe(200); const restored = restore.json(); expect(restored.id).not.toBe(p.id);
    const detail = (await ctx.app.inject({ url: `/api/projects/${restored.id}`, cookies: { session } })).json();
    expect(detail.sources[0].id).not.toBe(source.id);
    expect((await ctx.app.inject({ url: `/api/sources/${detail.sources[0].id}/file`, cookies: { session } })).rawPayload).toEqual(contents);
    expect(ctx.store.getProject(p.id).title).toBe('原文档案');
  });
  it('uses revisions for API edits and leaves written prose available without a provider', async () => {
    const ctx = await make(), session = await login(ctx), p = ctx.store.createProject({ title: '离线记录' });
    const branch = ctx.store.getBranch(p.mainBranchId);
    const saved = await ctx.app.inject({ method: 'POST', url: `/api/branches/${branch.id}/chapters`, cookies: { session }, payload: { baseRevisionId: branch.revisionId, title: '第一章', text: '写下的第一段不应丢失。' } });
    expect(saved.statusCode).toBe(200); const view = saved.json();
    expect((await ctx.app.inject({ url: `/api/branches/${branch.id}/chapters/${view.state.chapters[0].id}`, cookies: { session } })).json().text).toBe('写下的第一段不应丢失。');
    const conflict = await ctx.app.inject({ method: 'PUT', url: `/api/branches/${branch.id}/outline`, cookies: { session }, payload: { baseRevisionId: branch.revisionId, outline: { coarse: '旧设备内容', locked: '', fine: [] } } });
    expect(conflict.statusCode).toBe(409);
    expect(ctx.store.state(branch.id).outline.coarse).not.toBe('旧设备内容');
  });
  it('restores a confirmed import with a resumable job and remapped original references', async () => {
    const ctx = await make(), session = await login(ctx), p = ctx.store.createProject({ title: '后台导入备份' });
    const upload = await ctx.app.inject({ method: 'POST', url: `/api/projects/${p.id}/import`, cookies: { session }, ...form('original.txt', '第一章\n白云过山。\n第二章\n夜色渐深。') });
    const source = upload.json().source;
    const confirmation = await ctx.app.inject({ method: 'POST', url: `/api/sources/${source.id}/confirm`, cookies: { session }, payload: { branchId: p.mainBranchId, baseRevisionId: ctx.store.getBranch(p.mainBranchId).revisionId, chapters: upload.json().chapters } });
    expect(confirmation.statusCode).toBe(200);
    const backup = await ctx.app.inject({ url: `/api/projects/${p.id}/backup`, cookies: { session } });
    const response = await ctx.app.inject({ method: 'POST', url: '/api/restore', cookies: { session }, ...form('backup.json.gz', backup.rawPayload) });
    expect(response.statusCode).toBe(200); const restored = response.json();
    const detail = (await ctx.app.inject({ url: `/api/projects/${restored.id}`, cookies: { session } })).json();
    expect(detail.sources[0].confirmed).toBe(true);
    const jobs = (await ctx.app.inject({ url: `/api/jobs?projectId=${restored.id}`, cookies: { session } })).json();
    expect(jobs).toHaveLength(1); expect(jobs[0].status).toBe('paused');
    const raw = JSON.parse(String(ctx.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(jobs[0].id)!.data));
    expect(raw.payload.sourceId).toBe(detail.sources[0].id); expect(raw.payload.chapters).toBeUndefined();
    expect((await ctx.app.inject({ method: 'POST', url: `/api/jobs/${jobs[0].id}/resume`, cookies: { session } })).json().status).toBe('queued');
    expect(ctx.store.listProjects()).toHaveLength(2);
  });
});
