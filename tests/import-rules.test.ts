import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import { buildApp } from '../server/app.js';
import { listenLocalServer } from './local-server.mjs';
import type { ProviderProtocol } from '../shared/types.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = []; const servers: Server[] = [];
afterEach(async () => {
  for (const ctx of apps.splice(0)) await ctx.app.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'novel-import-rules-'));
  const ctx = await buildApp({ dataDir, initialPassword: 'import-rules-password-123', startEngine: false, rateLimits: { imports: 100 } }); apps.push(ctx);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'import-rules-password-123' } });
  const cookies = { session: login.cookies[0].value }; const project = ctx.store.createProject({ title: '分章测试作品' });
  const request = (method: string, url: string, payload?: unknown) => ctx.app.inject({ method: method as 'POST', url, cookies, payload });
  async function upload(text = original, filename = 'source.txt', bytes?: Buffer) {
    const boundary = 'chapter-rule-boundary';
    const response = await ctx.app.inject({ method: 'POST', url: `/api/projects/${project.id}/import`, cookies, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`), bytes ?? Buffer.from(text), Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    expect(response.statusCode).toBe(200); return response.json();
  }
  return { ctx, project, request, upload, dataDir, cookies };
}
const original = '场景01｜入城\r\n\r\n原文正文 SENTINEL_BODY。\r\n\r\n场景02｜夜谈\r\n\r\n第二段正文。\r\n\r\n场景03｜远行\r\n尾段正文。';
const rule = { name: '场景编号规则', pattern: '场景[0-9]+｜.+', flags: '', description: '按场景编号分章' };
async function provider(ctx: Awaited<ReturnType<typeof buildApp>>, protocol: ProviderProtocol = 'openai-chat', output: unknown = rule, status = 200) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    const value = status !== 200 ? { error: { message: 'fixture upstream failure' } } : protocol === 'openai-chat' ? { choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 18, completion_tokens: 12 } } : protocol === 'openai-responses' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 18, output_tokens: 12 } } : protocol === 'gemini' ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 12 } } : { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 18, output_tokens: 12 } };
    response.setHeader('Connection', 'close'); response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  }); servers.push(server); await listenLocalServer(server);
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing fixture address');
  ctx.settings.save({ providers: [{ id: 'text', name: 'local test model', baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol, apiKey: 'fake-rule-secret', model: 'test-rule-model' }], writingProviderId: '', extractionProviderId: 'text', planningProviderId: '', extractionModel: 'test-rule-model' });
  return bodies;
}

describe('import rule library and original-based previews', () => {
  it('requires authentication and author view for every new route', async () => {
    const { ctx, request, upload } = await setup(); const preview = await upload();
    expect((await ctx.app.inject('/api/chapter-rules?view=author')).statusCode).toBe(401);
    for (const [method, url, payload] of [['GET', '/api/chapter-rules'], ['POST', '/api/chapter-rules', rule], ['POST', `/api/sources/${preview.source.id}/split`, { ruleId: 'none' }], ['GET', `/api/sources/${preview.source.id}/heading-candidates`], ['POST', `/api/sources/${preview.source.id}/generate-rule`, { lines: [1, 5] }]] as const) expect((await request(method, url, payload)).statusCode).toBe(403);
  });
  it('saves, edits and deletes named reusable rules without changing model settings', async () => {
    const { ctx, request } = await setup(); const before = ctx.settings.public();
    const initial = (await request('GET', '/api/chapter-rules?view=author')).json(); expect(initial.rules).toHaveLength(10);
    const saved = (await request('POST', '/api/chapter-rules?view=author', rule)).json(); expect(saved).toMatchObject(rule);
    expect((await request('POST', '/api/chapter-rules?view=author', rule)).statusCode).toBe(400);
    expect((await request('PUT', `/api/chapter-rules/${saved.id}?view=author`, { ...rule, name: '场景新规则' })).json()).toMatchObject({ id: saved.id, name: '场景新规则' });
    expect((await request('PUT', '/api/chapter-rules/auto?view=author', rule)).statusCode).toBe(404);
    expect((await request('DELETE', '/api/chapter-rules/auto?view=author')).statusCode).toBe(404);
    expect((await request('DELETE', `/api/chapter-rules/${saved.id}?view=author`)).statusCode).toBe(200);
    expect((await request('GET', '/api/chapter-rules?view=author')).json().rules).toHaveLength(10); expect(ctx.settings.public()).toEqual(before);
  });
  it('preserves the rule library across service restarts', async () => {
    const { ctx, request, dataDir } = await setup(); await request('POST', '/api/chapter-rules?view=author', rule); await ctx.app.close(); apps.splice(apps.indexOf(ctx), 1);
    const reopened = await buildApp({ dataDir, startEngine: false }); apps.push(reopened);
    expect(JSON.parse(reopened.settings.meta('chapter-rules')!)).toHaveLength(1);
    expect(JSON.parse(reopened.settings.meta('chapter-rules')!)[0]).toMatchObject(rule);
  });
  it.each([{ ...rule, pattern: '(' }, { ...rule, flags: 'g' }, { ...rule, pattern: '.*' }, { ...rule, name: '' }])('rejects malformed/empty-matching rules without persisting them', async input => {
    const { ctx, request } = await setup(); const result = await request('POST', '/api/chapter-rules?view=author', input);
    expect(result.statusCode).toBe(400); expect(ctx.settings.meta('chapter-rules')).toBeUndefined();
  });
  it('computes previews from original bytes and only saves the chosen chapters on confirmation', async () => {
    const { ctx, project, request, upload } = await setup(); const uploaded = await upload(); const revision = ctx.store.getBranch(project.mainBranchId).revisionId;
    const saved = (await request('POST', '/api/chapter-rules?view=author', rule)).json();
    const resplit = await request('POST', `/api/sources/${uploaded.source.id}/split?view=author`, { ruleId: saved.id }); expect(resplit.statusCode).toBe(200);
    const preview = resplit.json(); expect(preview.headingCount).toBe(3); expect(preview.chapters.map((value: any) => value.title)).toEqual(['场景01｜入城', '场景02｜夜谈', '场景03｜远行']);
    expect((await request('GET', `/api/sources/${uploaded.source.id}/preview`)).json()).toEqual(uploaded); expect(ctx.store.getBranch(project.mainBranchId).revisionId).toBe(revision);
    expect((await request('GET', `/api/sources/${uploaded.source.id}/file`)).rawPayload).toEqual(Buffer.from(original));
    const unmatched = (await request('POST', `/api/sources/${uploaded.source.id}/split?view=author`, { ruleId: 'chinese' })).json(); expect(unmatched.headingCount).toBe(0); expect(unmatched.chapters).toHaveLength(1); expect(unmatched.chapters[0].text).toContain('场景02');
    const confirmed = await request('POST', `/api/sources/${uploaded.source.id}/confirm`, { branchId: project.mainBranchId, baseRevisionId: revision, chapters: preview.chapters }); expect(confirmed.statusCode).toBe(200);
    expect((await request('GET', `/api/sources/${uploaded.source.id}/preview`)).json().chapters).toEqual(preview.chapters);
    for (const [method, path, body] of [['POST', 'split', { rule }], ['GET', 'heading-candidates', undefined], ['POST', 'generate-rule', { lines: [1, 5] }]] as const) expect((await request(method, `/api/sources/${uploaded.source.id}/${path}?view=author`, body)).statusCode).toBe(409);
  });
  it('paginates original short lines with stable line numbers and literal keyword filtering', async () => {
    const { request, upload } = await setup(); const uploaded = await upload(); const path = `/api/sources/${uploaded.source.id}/heading-candidates?view=author`;
    const first = (await request('GET', path + '&limit=2')).json(); expect(first.candidates.map((value: any) => value.line)).toEqual([1, 3]); expect(first.nextOffset).toBe(3);
    const next = (await request('GET', path + '&offset=3&limit=2')).json(); expect(next.candidates[0]).toEqual({ line: 5, title: '场景02｜夜谈' });
    const filtered = (await request('GET', path + '&q=' + encodeURIComponent('场景'))).json(); expect(filtered.candidates).toHaveLength(3); expect(filtered.nextOffset).toBeNull();
  });
  it('preserves EPUB reading order by default and allows explicit custom re-splitting', async () => {
    const { request, upload } = await setup();
    const archive = zipSync({ 'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'), 'book.opf': strToU8('<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>'), 'one.xhtml': strToU8('<html><head><title>原有一章</title></head><body><p>场景01｜入城</p><p>正文一。</p><p>场景02｜夜谈</p><p>正文二。</p></body></html>') });
    const uploaded = await upload('', 'original.epub', Buffer.from(archive)); expect(uploaded.chapters).toHaveLength(1);
    expect((await request('POST', `/api/sources/${uploaded.source.id}/split?view=author`, { rule })).json().chapters).toHaveLength(2);
    expect((await request('POST', `/api/sources/${uploaded.source.id}/split?view=author`, { native: true })).json().chapters).toEqual(uploaded.chapters);
    expect((await request('GET', `/api/sources/${uploaded.source.id}/file`)).rawPayload).toEqual(Buffer.from(archive));
  });
});

describe('length rules in the import library and preview/confirmation flow', () => {
  const lengthRule = { type: 'length', name: '每章一百字', wordsPerChapter: 100, description: '用于无标题小说' };
  it('previews the built-in and adjusted length rule from original bytes, then confirms the chosen chapters', async () => {
    const { ctx, project, request, upload } = await setup();
    const text = '甲'.repeat(85) + '\r\n\r\n' + '乙'.repeat(85) + '\r\n' + '丙'.repeat(40);
    const uploaded = await upload(text); const revision = ctx.store.getBranch(project.mainBranchId).revisionId;
    const path = `/api/sources/${uploaded.source.id}/split?view=author`;
    expect((await request('POST', path, { ruleId: 'length' })).json()).toMatchObject({ wordsPerChapter: 3000, chapters: [{ title: '第1章', text: text.replace(/\r\n/g, '\n') }] });
    const split = await request('POST', path, { rule: lengthRule }); expect(split.statusCode).toBe(200);
    const preview = split.json(); expect(preview.wordsPerChapter).toBe(100); expect(preview.headingCount).toBeUndefined();
    expect(preview.chapters.map((chapter: any) => chapter.text)).toEqual(['甲'.repeat(85), '乙'.repeat(85), '丙'.repeat(40)]);
    expect((await request('GET', `/api/sources/${uploaded.source.id}/preview`)).json()).toEqual(uploaded);
    expect(ctx.store.getBranch(project.mainBranchId).revisionId).toBe(revision);
    expect(ctx.settings.meta('chapter-rules')).toBeUndefined();
    expect((await request('GET', `/api/sources/${uploaded.source.id}/file`)).rawPayload).toEqual(Buffer.from(text));
    expect((await request('POST', path, { native: true })).json().chapters).toEqual(uploaded.chapters);
    preview.chapters[0].title = '作者命名';
    expect((await request('POST', `/api/sources/${uploaded.source.id}/confirm`, { branchId: project.mainBranchId, baseRevisionId: revision, chapters: preview.chapters })).statusCode).toBe(200);
    expect((await request('GET', `/api/sources/${uploaded.source.id}/preview`)).json().chapters).toEqual(preview.chapters);
    expect((await request('POST', path, { ruleId: 'length' })).statusCode).toBe(409);
  });
  it('saves, edits, reuses and deletes length rules alongside legacy regex rules across a restart', async () => {
    const { ctx, request, upload, dataDir } = await setup(); const uploaded = await upload('甲'.repeat(250));
    const saved = (await request('POST', '/api/chapter-rules?view=author', lengthRule)).json(); expect(saved).toMatchObject(lengthRule);
    expect((await request('POST', `/api/sources/${uploaded.source.id}/split?view=author`, { ruleId: saved.id })).json().chapters).toHaveLength(3);
    const updated = { ...lengthRule, wordsPerChapter: 200 };
    expect((await request('PUT', `/api/chapter-rules/${saved.id}?view=author`, updated)).json()).toMatchObject(updated);
    expect((await request('POST', `/api/sources/${uploaded.source.id}/split?view=author`, { ruleId: saved.id })).json().chapters).toHaveLength(2);
    await request('POST', '/api/chapter-rules?view=author', rule);
    await ctx.app.close(); apps.splice(apps.indexOf(ctx), 1);
    const reopened = await buildApp({ dataDir, startEngine: false }); apps.push(reopened);
    const library = JSON.parse(reopened.settings.meta('chapter-rules')!);
    expect(library).toEqual([expect.objectContaining({ ...updated, id: saved.id }), expect.objectContaining(rule)]);
    const login = await reopened.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'import-rules-password-123' } });
    const cookies = { session: login.cookies[0].value };
    const split = await reopened.app.inject({ method: 'POST', url: `/api/sources/${uploaded.source.id}/split?view=author`, cookies, payload: { ruleId: saved.id } });
    expect(split.json().chapters).toHaveLength(2);
    expect((await reopened.app.inject({ method: 'DELETE', url: `/api/chapter-rules/${saved.id}?view=author`, cookies })).statusCode).toBe(200);
    expect(JSON.parse(reopened.settings.meta('chapter-rules')!)).toEqual([expect.objectContaining(rule)]);
  });
  it.each([{}, { wordsPerChapter: 99 }, { wordsPerChapter: 100001 }, { wordsPerChapter: 100.5 }, { wordsPerChapter: '100' }, { wordsPerChapter: null }, { wordsPerChapter: 100, pattern: '.+' }, { wordsPerChapter: 100, unexpected: true }])('rejects invalid length-rule parameters without changing the preview or library: %j', async fields => {
    const { ctx, request, upload } = await setup(); const uploaded = await upload();
    const invalid = { type: 'length', name: '无效规则', ...fields };
    expect((await request('POST', '/api/chapter-rules?view=author', invalid)).statusCode).toBe(400);
    expect((await request('POST', `/api/sources/${uploaded.source.id}/split?view=author`, { rule: invalid })).statusCode).toBe(400);
    expect(ctx.settings.meta('chapter-rules')).toBeUndefined();
    expect((await request('GET', `/api/sources/${uploaded.source.id}/preview`)).json()).toEqual(uploaded);
  });
  it('splits EPUB body in reading order without changing its original bytes or native chapter order', async () => {
    const { request, upload } = await setup();
    const archive = zipSync({ 'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'), 'book.opf': strToU8('<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="two"/><itemref idref="one"/></spine></package>'), 'one.xhtml': strToU8(`<html><head><title>后半</title></head><body><p>${'乙'.repeat(130)}</p></body></html>`), 'two.xhtml': strToU8(`<html><head><title>前半</title></head><body><p>${'甲'.repeat(120)}</p></body></html>`) });
    const uploaded = await upload('', 'length.epub', Buffer.from(archive));
    const preview = (await request('POST', `/api/sources/${uploaded.source.id}/split?view=author`, { rule: lengthRule })).json();
    expect(preview.wordsPerChapter).toBe(100);
    expect(preview.chapters.map((chapter: any) => chapter.text).join('').replace(/\s/gu, '')).toBe('甲'.repeat(120) + '乙'.repeat(130));
    expect((await request('POST', `/api/sources/${uploaded.source.id}/split?view=author`, { native: true })).json().chapters).toEqual(uploaded.chapters);
    expect((await request('GET', `/api/sources/${uploaded.source.id}/file`)).rawPayload).toEqual(Buffer.from(archive));
  });
});

describe('AI generates a reviewable chapter rule using selected titles only', () => {
  it.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('runs one %s request, validates all samples and exposes the redacted actual request', async protocol => {
    const { ctx, request, upload } = await setup(); const uploaded = await upload(); const bodies = await provider(ctx, protocol);
    const result = await request('POST', `/api/sources/${uploaded.source.id}/generate-rule?view=author`, { lines: [1, 5], instruction: '不要按卷分章' });
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ ok: true, rule, headingCount: 3, chapterCount: 3, inputTokens: 18, outputTokens: 12 });
    expect(bodies).toHaveLength(1); const sent = JSON.stringify(bodies[0]); expect(sent).toContain('场景01'); expect(sent).toContain('场景02'); expect(sent).not.toContain('SENTINEL_BODY'); expect(sent).not.toContain('场景03');
    expect(result.json().capture.request.body).toContain('分章规则生成'); expect(result.body).not.toContain('fake-rule-secret');
    expect(ctx.settings.meta('chapter-rules')).toBeUndefined(); expect((await request('GET', `/api/sources/${uploaded.source.id}/preview`)).json()).toEqual(uploaded);
  });
  it.each([['not JSON', 200], [{ ...rule, pattern: '不存在.+' }, 200], [{ ...rule, pattern: '(' }, 200], ['failure', 500]])('retains diagnostics after invalid output/upstream failure and never retries', async (output, status) => {
    const { ctx, request, upload } = await setup(); const uploaded = await upload(); const bodies = await provider(ctx, 'openai-chat', output, status);
    const result = await request('POST', `/api/sources/${uploaded.source.id}/generate-rule?view=author`, { lines: [1, 5] });
    expect(result.json().ok).toBe(false); expect(result.json().error).toBeTruthy(); expect(result.json().capture.request).toBeTruthy(); expect(bodies).toHaveLength(1); expect(ctx.settings.meta('chapter-rules')).toBeUndefined();
  });
  it('rejects missing models, stale line numbers, identical titles and too few samples before making requests', async () => {
    const { ctx, request, upload } = await setup(); const uploaded = await upload(); const path = `/api/sources/${uploaded.source.id}/generate-rule?view=author`;
    expect((await request('POST', path, { lines: [1, 5] })).statusCode).toBe(400); const bodies = await provider(ctx);
    for (const lines of [[1], [1, 1], [1, 200], [1, 2]]) expect((await request('POST', path, { lines })).statusCode).toBe(400);
    expect(bodies).toHaveLength(0);
  });
});
