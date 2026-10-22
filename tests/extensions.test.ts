import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import { buildApp } from '../server/app.js';
import { importSkill } from '../server/skill-import.js';
import { executeScript } from '../server/extension-execution.js';
import { defaultPromptTemplates } from '../shared/prompt-templates.js';
import { EXAMPLE_SCRIPT, EXAMPLE_SCRIPT_SCHEMA, type ScriptTool, type McpConnection } from '../shared/extensions.js';
import { listenLocalServer } from './local-server.mjs';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [], servers: Server[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.app.close(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } vi.unstubAllEnvs(); });
async function make() { const ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'novel-extensions-')), initialPassword: 'extensions-password-123', startEngine: false }); apps.push(ctx); return ctx; }
const script = (extra: Partial<ScriptTool> = {}): ScriptTool => ({ id: 'counter', name: '统计字数', description: '核对篇幅', enabled: true, inputSchema: EXAMPLE_SCRIPT_SCHEMA, code: EXAMPLE_SCRIPT, timeoutMs: 5000, ...extra });
const mcp = (extra: Partial<McpConnection> = {}): McpConnection => ({ id: 'external', name: '测试 MCP', description: '查阅外部资料', enabled: true, transport: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/extension-mcp.mjs')], url: '', env: {}, headers: {}, timeoutMs: 5000, tools: [], ...extra });
const skillText = '---\nname: scene-check\ndescription: 核对场景是否连贯\n---\nSKILL_BODY_ONLY_ON_LOAD\n读取 references/check.md。';
const skill = () => importSkill('skill.zip', zipSync({ 'scene-check/SKILL.md': strToU8(skillText), 'scene-check/references/check.md': strToU8('RESOURCE_ONLY_ON_READ'), 'scene-check/assets/icon.bin': new Uint8Array([0, 255, 12]) }));
const tool = (session: ReturnType<Awaited<ReturnType<typeof make>>['extensions']['session']>, name: string) => session.tools.find(value => value.name === name)!;
async function login(ctx: Awaited<ReturnType<typeof make>>) { return (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'extensions-password-123' } })).cookies.find(cookie => cookie.name === 'session')!.value; }

describe('skill imports and progressive disclosure', () => {
  it('preserves a complete skill and binary assets, rejects traversal, duplicate roots and oversized expansion', () => {
    const imported = skill();
    expect(imported).toMatchObject({ enabled: false, name: 'scene-check', description: '核对场景是否连贯' });
    expect(imported.files.find(file => file.path === 'assets/icon.bin')).toMatchObject({ encoding: 'base64', content: 'AP8M' });
    expect(() => importSkill('x.zip', zipSync({ '../SKILL.md': strToU8(skillText) }))).toThrow('相对路径');
    expect(() => importSkill('x.zip', zipSync({ 'a/SKILL.md': strToU8(skillText), 'b/SKILL.md': strToU8(skillText) }))).toThrow('一个技能');
    expect(() => importSkill('x.zip', zipSync({ 'SKILL.md': strToU8(skillText), 'large.txt': new Uint8Array(600000) }))).toThrow('容量');
    expect(() => importSkill('x.md', strToU8('---\nname: BAD\ndescription: x\n---\nbody'))).toThrow('name');
    expect(() => importSkill('x.md', strToU8('---\nname: scene-check\nname: duplicate\ndescription: x\n---\nbody'))).toThrow('YAML');
  });
  it('starts with summaries, loads instructions and individual attachments separately, and gates execution', async () => {
    const ctx = await make(); const imported = { ...skill(), enabled: true };
    ctx.extensions.save({ ...ctx.extensions.public(), scripts: [script()], skills: [imported] });
    const session = ctx.extensions.session(); const first = JSON.stringify({ catalog: session.catalog, tools: session.tools });
    for (const hidden of ['SKILL_BODY_ONLY_ON_LOAD', 'RESOURCE_ONLY_ON_READ', '"text":{"type":"string"', 'Array.from(text.replace']) expect(first).not.toContain(hidden);
    expect(session.catalog).toContain('核对场景');
    expect(await tool(session, 'run_extension').execute({ id: 'script:counter', argumentsJson: '{"text":"中文"}' })).toMatchObject({ error: expect.stringContaining('先') });
    expect(await tool(session, 'read_skill_resource').execute({ id: `skill:${imported.id}`, path: 'references/check.md' })).toMatchObject({ error: expect.stringContaining('先') });
    const loaded = await tool(session, 'load_extension').execute({ id: `skill:${imported.id}` });
    expect(JSON.stringify(loaded)).toContain('SKILL_BODY_ONLY_ON_LOAD'); expect(JSON.stringify(loaded)).not.toContain('RESOURCE_ONLY_ON_READ');
    expect(await tool(session, 'read_skill_resource').execute({ id: `skill:${imported.id}`, path: 'references/check.md', offset: 9, limit: 4 })).toMatchObject({ text: 'ONLY', nextOffset: 13 });
    expect(await tool(session, 'read_skill_resource').execute({ id: `skill:${imported.id}`, path: '../secret' })).toMatchObject({ error: expect.stringContaining('相对路径') });
    expect(await tool(session, 'read_skill_resource').execute({ id: `skill:${imported.id}`, path: 'assets/icon.bin' })).toMatchObject({ binary: true });
    await tool(session, 'load_extension').execute({ id: 'script:counter' });
    expect(await tool(session, 'run_extension').execute({ id: 'script:counter', argumentsJson: '{"text":"中文 🌧️"}' })).toEqual({ characters: 4 });
    expect(await tool(session, 'run_extension').execute({ id: 'script:counter', argumentsJson: '{"text":123}' })).toMatchObject({ error: expect.stringContaining('格式') });
    expect(await tool(session, 'run_extension').execute({ id: 'script:counter', argumentsJson: '{"text":' })).toMatchObject({ error: expect.stringContaining('完整有效') });
    const resumed = ctx.extensions.session(undefined, JSON.parse(JSON.stringify(session.loaded)));
    expect(await tool(resumed, 'run_extension').execute({ id: 'script:counter', argumentsJson: '{"text":"恢复"}' })).toEqual({ characters: 2 });
    ctx.extensions.save({ ...ctx.extensions.public(), scripts: [script({ code: 'return { changed: true };' })] });
    expect(await tool(session, 'run_extension').execute({ id: 'script:counter', argumentsJson: '{"text":"旧任务"}' })).toMatchObject({ error: expect.stringContaining('修改') });
    expect(await tool(ctx.extensions.session(undefined, resumed.loaded), 'run_extension').execute({ id: 'script:counter', argumentsJson: '{"text":"新任务"}' })).toMatchObject({ error: expect.stringContaining('先') });
  });
  it('excludes disabled entries, searches paged summaries, and exposes the same catalog in actual prompt preview', async () => {
    const ctx = await make();
    ctx.extensions.save({ ...ctx.extensions.public(), scripts: Array.from({ length: 45 }, (_, index) => script({ id: `s${index}`, name: `工具 ${index}`, enabled: index !== 44, inputSchema: { type: 'object', properties: { schemaSentinel: { type: 'string' } } } })), skills: [{ ...skill(), enabled: true }] });
    const session = ctx.extensions.session();
    expect(session.catalog).not.toContain('工具 44'); expect(session.catalog).not.toContain('工具 43');
    expect(await tool(session, 'search_extensions').execute({ query: '工具 43' })).toMatchObject({ total: 1, items: [{ id: 'script:s43' }] });
    const preview = ctx.engine.previewPrompt({ task: 'writing', templates: defaultPromptTemplates(), variables: { mode: 'original', context: '测试', maxWords: '1000' }, runtime: {}, protocol: 'openai-chat' });
    expect(preview.runtimeBlocks.find(block => block.name === '工具与技能目录')?.content).toBe(session.catalog);
    expect(preview.body).toContain('search_extensions');
    for (const hidden of ['schemaSentinel', 'SKILL_BODY_ONLY_ON_LOAD', 'RESOURCE_ONLY_ON_READ', EXAMPLE_SCRIPT]) expect(preview.body).not.toContain(hidden);
    const extraction = ctx.engine.previewPrompt({ task: 'extraction', templates: defaultPromptTemplates(), variables: { blockText: '测试' }, runtime: {}, protocol: 'openai-chat' });
    expect(extraction.body).not.toContain('search_extensions');
  });
});

describe('script execution boundaries', () => {
  it('accepts JSON Schema 2020-12 definitions and rejects invalid arguments before running them', async () => {
    const ctx = await make();
    expect(() => ctx.extensions.save({ ...ctx.extensions.public(), scripts: [script({ inputSchema: { type: 'object', $async: true, required: ['text'] } })] })).toThrow('异步');
    ctx.extensions.save({ ...ctx.extensions.public(), scripts: [script({ inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { text: { type: 'string' } }, required: ['text'], unevaluatedProperties: false } })] });
    await expect(ctx.extensions.testScript('counter', { text: 'ok', extra: 'invalid' }, ctx.extensions.public().revision)).rejects.toThrow('格式');
    expect(await ctx.extensions.testScript('counter', { text: 'ok' }, ctx.extensions.public().revision)).toEqual({ characters: 2 });
  });
  it('preserves ordinary environment values in IDs, JSON output and prose while redacting actual credentials', async () => {
    const ctx = await make();
    ctx.extensions.save({ ...ctx.extensions.public(), scripts: [script({ id: 'counter-1', code: 'return { count: 1, environment: "production" };' })], mcpServers: [mcp({ enabled: false, env: { PORT: '1', NODE_ENV: 'production', API_TOKEN: 'known-private-token' } })] });
    const session = ctx.extensions.session(); expect(session.catalog).toContain('counter-1');
    await tool(session, 'load_extension').execute({ id: 'script:counter-1' });
    expect(await tool(session, 'run_extension').execute({ id: 'script:counter-1', argumentsJson: '{"text":"ok"}' })).toEqual({ count: 1, environment: 'production' });
    expect(ctx.extensions.redact('production 1 known-private-token')).toBe('production 1 [REDACTED]');
  });
  it('validates before side effects, does not inherit application secrets, bounds output, times out and cancels', async () => {
    const ctx = await make(); const marker = join(ctx.dataDir, 'must-not-exist.txt');
    ctx.extensions.save({ ...ctx.extensions.public(), scripts: [script({ code: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(marker)}, 'executed'); return true;` })] });
    await expect(ctx.extensions.testScript('counter', { text: 1 }, ctx.extensions.public().revision)).rejects.toThrow('格式'); expect(existsSync(marker)).toBe(false);
    vi.stubEnv('NOVEL_TEST_SECRET', 'do-not-inherit-credentials');
    expect(await executeScript(script({ code: 'return { inherited: process.env.NOVEL_TEST_SECRET ?? null };' }), {}, ctx.extensions.runtimeDir)).toEqual({ inherited: null });
    await expect(executeScript(script({ code: 'return "x".repeat(70000);' }), {}, ctx.extensions.runtimeDir)).rejects.toThrow('64 KiB');
    await expect(executeScript(script({ code: 'while (true) {}', timeoutMs: 150 }), {}, ctx.extensions.runtimeDir)).rejects.toThrow('超时');
    const controller = new AbortController(); const pending = executeScript(script({ code: 'await new Promise(() => {});', timeoutMs: 10000 }), {}, ctx.extensions.runtimeDir, controller.signal);
    controller.abort(); await expect(pending).rejects.toThrow('取消');
  });
  it('cancels an active script when its configuration is changed', async () => {
    const ctx = await make(); ctx.extensions.save({ ...ctx.extensions.public(), scripts: [script({ code: 'await new Promise(resolve => setTimeout(resolve, 10000)); return true;', timeoutMs: 15000 })] });
    const execution = ctx.extensions.testScript('counter', { text: 'x' }, ctx.extensions.public().revision);
    const rejected = expect(execution).rejects.toThrow('取消');
    ctx.extensions.save({ ...ctx.extensions.public(), scripts: [script({ enabled: false })] });
    await rejected;
  });
});

describe('MCP transports and configuration persistence', () => {
  it('connects to a real local stdio process only on discovery, then loads and invokes a tool with redacted credentials', async () => {
    const ctx = await make();
    ctx.extensions.save({ ...ctx.extensions.public(), mcpServers: [mcp({ env: { MCP_FIXTURE_SECRET: 'private-mcp-fixture-credential' } })] });
    expect(ctx.extensions.session().tools).toHaveLength(0);
    const found = await ctx.extensions.discover('external', ctx.extensions.public().revision);
    expect(found.mcpServers[0]).toMatchObject({ env: {}, headers: {}, hasSecrets: true, tools: [{ name: 'echo' }] });
    const session = ctx.extensions.session(); const key = 'mcp:external:echo';
    expect(await tool(session, 'run_extension').execute({ id: key, argumentsJson: '{"text":"先拒绝"}' })).toMatchObject({ error: expect.stringContaining('先') });
    await tool(session, 'load_extension').execute({ id: key });
    const result = await tool(session, 'run_extension').execute({ id: key, argumentsJson: '{"text":"已调用"}' });
    expect(JSON.stringify(result)).toContain('已调用'); expect(JSON.stringify(result)).toContain('[REDACTED]'); expect(JSON.stringify(result)).not.toContain('private-mcp-fixture-credential');
    expect(ctx.settings.meta('extensions-v1')).not.toContain('private-mcp-fixture-credential');
    ctx.extensions.save(found); expect(ctx.extensions.get().mcpServers[0].env.MCP_FIXTURE_SECRET).toBe('private-mcp-fixture-credential');
    ctx.extensions.save({ ...ctx.extensions.public(), mcpServers: [mcp({ args: ['changed.mjs'] })] });
    expect(ctx.extensions.get().mcpServers[0]).toMatchObject({ env: {}, tools: [] });
  });
  it('uses HTTP initialization and paged tools/list, forwards auth only to that server, and never retries calls', async () => {
    const received: any[] = []; let calls = 0;
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') { response.writeHead(405).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()); received.push({ ...message, authorization: request.headers.authorization });
      if (!('id' in message)) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'local', version: '1' } }
        : message.method === 'tools/list' ? { tools: [{ name: message.params?.cursor ? 'second' : 'echo', description: 'HTTP_ECHO_DESCRIPTION', inputSchema: EXAMPLE_SCRIPT_SCHEMA }], ...(message.params?.cursor ? {} : { nextCursor: 'next' }) }
        : { content: [{ type: 'text', text: message.params?.arguments.text }], isError: false };
      if (message.method === 'tools/call') { calls++; response.writeHead(503).end('temporary error'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    }); servers.push(server); await listenLocalServer(server);
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/mcp`;
    const ctx = await make(); ctx.extensions.save({ ...ctx.extensions.public(), mcpServers: [mcp({ transport: 'http', url, headers: { Authorization: 'Bearer private-http-fixture-secret' } })] });
    await ctx.extensions.discover('external', ctx.extensions.public().revision);
    expect(ctx.extensions.public().mcpServers[0].tools).toHaveLength(2);
    const session = ctx.extensions.session(); await tool(session, 'load_extension').execute({ id: 'mcp:external:echo' });
    expect(await tool(session, 'run_extension').execute({ id: 'mcp:external:echo', argumentsJson: '{"text":"one attempt"}' })).toMatchObject({ error: expect.stringContaining('503') });
    expect(calls).toBe(1); expect(received.every(message => message.authorization === 'Bearer private-http-fixture-secret')).toBe(true);
    expect(received.filter(message => message.method === 'tools/list')).toHaveLength(2);
  });
  it('requires login and origin, detects stale saves, keeps global extensions outside work backups, and never trusts supplied MCP schemas', async () => {
    const ctx = await make(); const session = await login(ctx);
    expect((await ctx.app.inject('/api/extensions')).statusCode).toBe(401);
    const config = { ...ctx.extensions.public(), scripts: [script()], mcpServers: [mcp({ tools: [{ name: 'forged', description: 'must ignore', inputSchema: { type: 'object' } }] })] };
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/extensions', payload: config, cookies: { session }, headers: { origin: 'https://wrong.invalid' } })).statusCode).toBe(403);
    const saved = await ctx.app.inject({ method: 'PUT', url: '/api/extensions', payload: config, cookies: { session } }); expect(saved.statusCode).toBe(200); expect(saved.json().mcpServers[0].tools).toEqual([]);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/extensions', payload: config, cookies: { session } })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/settings', payload: ctx.settings.public(), cookies: { session } })).statusCode).toBe(200);
    expect(ctx.extensions.get().scripts).toHaveLength(1);
    const test = await ctx.app.inject({ method: 'POST', url: '/api/extensions/scripts/counter/test', payload: { revision: saved.json().revision, arguments: { text: '两个' } }, cookies: { session } });
    expect(test.statusCode).toBe(200); expect(test.json()).toEqual({ characters: 2 });
    const project = ctx.store.createProject({ title: '无扩展备份' });
    const backup = await ctx.app.inject({ url: `/api/projects/${project.id}/backup`, cookies: { session } });
    const { gunzipSync } = await import('node:zlib'); expect(gunzipSync(backup.rawPayload).toString()).not.toContain('extensions-v1');
    const storedDir = ctx.dataDir; await ctx.app.close(); apps.splice(apps.indexOf(ctx), 1);
    const reopened = await buildApp({ dataDir: storedDir, startEngine: false }); apps.push(reopened); expect(reopened.extensions.get().scripts[0].code).toBe(EXAMPLE_SCRIPT);
  });
});
