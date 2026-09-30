import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Store } from './store.js';
import { StoryEngine } from './engine.js';
import { parseNovel } from './importer.js';
import { generateText, validateProviderOptions } from './providers.js';
import { SettingsStore, hashPassword, verifyPassword, tokenHash } from './security.js';
import type { Source, SourcePreview, Settings, Entity, Foreshadow, Job, CapturedModelResponse, ModelRequestSnapshot } from '../shared/types.js';

const revision = z.string().min(1).max(100);
const mode = z.enum(['original', 'continuation', 'fanfiction', 'rewrite']);
const passwordBody = z.object({ password: z.string().min(8, '密码至少 8 位').max(256) });
const outlineSchema = z.object({ coarse: z.string().max(100000), locked: z.string().max(100000), fine: z.array(z.object({ chapter: z.number().int().positive(), title: z.string().max(500), goal: z.string().max(20000) })).max(1000) });
const providerSchema = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(100), protocol: z.enum(['openai-chat', 'openai-responses', 'gemini', 'claude']), baseUrl: z.string().url().max(2000).refine(v => { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }, '服务地址必须是 HTTP(S)，不能包含用户名或密码'), model: z.string().min(1).max(300), apiKey: z.string().max(4096).optional(), hasKey: z.boolean().optional(), clearApiKey: z.boolean().optional(), maxOutputTokens: z.number().int().min(256).max(128000), contextTokens: z.number().int().min(2048).max(2000000) }).extend({
  temperature: z.number().min(0).max(2).optional(), topP: z.number().min(0).max(1).optional(), topK: z.number().int().min(0).max(1000000).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(), frequencyPenalty: z.number().min(-2).max(2).optional(), seed: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  stopSequences: z.array(z.string().min(1).max(1000)).max(16).optional(), timeoutMs: z.number().int().min(1000).max(3600000).optional(), stream: z.boolean().optional(),
  openaiMaxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(), reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  geminiThinking: z.discriminatedUnion('mode', [z.object({ mode: z.literal('level'), level: z.enum(['minimal', 'low', 'medium', 'high']) }).strict(), z.object({ mode: z.literal('budget'), budget: z.number().int().min(-1).max(1000000) }).strict()]).optional(),
  geminiIncludeThoughts: z.boolean().optional(),
  claudeThinking: z.discriminatedUnion('type', [z.object({ type: z.literal('disabled') }).strict(), z.object({ type: z.literal('adaptive') }).strict(), z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().min(1024).max(128000) }).strict()]).optional(),
  claudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
const settingsSchema = z.object({ providers: z.array(providerSchema).max(30), writingProviderId: z.string(), planningProviderId: z.string(), extractionProviderId: z.string(), taskTokenLimit: z.number().int().min(1000).max(100000000) });
const citationSchema = z.object({ chapterId: z.string(), paragraph: z.number().int().positive(), quote: z.string().max(10000) });
const entitySchema = z.object({ id: z.string().min(1), kind: z.enum(['character', 'faction', 'location', 'item', 'ability', 'rule', 'event']), name: z.string().min(1).max(300), aliases: z.array(z.string().min(1).max(300)).max(200), description: z.string().max(30000), visibility: z.enum(['public', 'secret']), locked: z.boolean(), mergedInto: z.string().optional(), facts: z.array(z.object({ id: z.string(), text: z.string().max(10000), attribute: z.string().min(1).max(100).optional(), temporal: z.enum(['current', 'past', 'future', 'unknown']), certainty: z.enum(['fact', 'inference', 'conflict']), visibility: z.enum(['public', 'secret']), citation: citationSchema.optional(), locked: z.boolean().optional() })).max(5000) });
const foreshadowSchema = z.object({ id: z.string().min(1), title: z.string().min(1).max(300), detail: z.string().max(20000), status: z.enum(['planned', 'planted', 'resolved', 'abandoned']), plantedChapterId: z.string().optional(), resolvedChapterId: z.string().optional(), dueChapter: z.number().int().positive().optional(), revealCondition: z.string().max(20000), relatedEntityIds: z.array(z.string()).max(1000) });
const chaptersSchema = z.array(z.object({ title: z.string().min(1).max(500), text: z.string().max(20000000) })).min(1).max(20000);

function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }
type SourceRow = { id: string; project_id: string; filename: string; format: 'txt' | 'epub'; chapter_count: number; created_at: string; confirmed: number; preview: string; storage_name: string };
const sourcePublic = (r: SourceRow): Source => ({ id: r.id, projectId: r.project_id, filename: r.filename, format: r.format, chapterCount: r.chapter_count, createdAt: r.created_at, confirmed: Boolean(r.confirmed) });

export async function buildApp(options: { dataDir?: string; startEngine?: boolean; logger?: boolean; staticDir?: string } = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true });
  const uploadDir = join(dataDir, 'sources'); mkdirSync(uploadDir, { recursive: true });
  const store = new Store(dataDir);
  const settings = new SettingsStore(store.db, dataDir);
  const engine = new StoryEngine(store, () => settings.get());
  store.db.exec(`CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, filename TEXT NOT NULL, format TEXT NOT NULL, chapter_count INTEGER NOT NULL, created_at TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL, storage_name TEXT NOT NULL)`);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 128 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 128 * 1024 * 1024, files: 1, fields: 8 } });
  const attempts = new Map<string, { count: number; since: number }>();
  const isPublic = (path: string) => ['/api/health', '/api/auth/status', '/api/auth/setup', '/api/auth/login'].includes(path);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        const allowed = new Set([`http://${request.headers.host}`, `https://${request.headers.host}`, process.env.PUBLIC_ORIGIN]);
        if (process.env.NODE_ENV !== 'production') { allowed.add('http://127.0.0.1:5173'); allowed.add('http://localhost:5173'); }
        if (!allowed.has(origin)) fail('请求来源不匹配，请从应用页面操作。', 403);
      }
    }
    if (isPublic(path)) return;
    const session = request.cookies.session;
    const valid = session && store.db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash(session), Date.now());
    if (!valid) { reply.clearCookie('session', { path: '/' }); fail('请先登录。', 401); }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.status(400).send({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') });
    const err = error as Error & { statusCode?: number; code?: string };
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: '文件超过上传上限。' });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    // Do not expose SQL, file paths, upstream bodies or keys to the browser.
    return reply.status(status).send({ error: status === 500 ? '操作未完成，请查看任务状态或服务日志后重试。' : err.message });
  });
  const authenticated = (token?: string) => Boolean(token && store.db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash(token), Date.now()));
  const createSession = (reply: any) => {
    const token = randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES (?,?)').run(tokenHash(token), Date.now() + 7 * 86400000);
    reply.setCookie('session', token, { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 7 * 86400 });
  };
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/auth/status', async request => ({ initialized: Boolean(settings.meta('password')), authenticated: authenticated(request.cookies.session) }));
  let settingUp = false;
  app.post('/api/auth/setup', async (request, reply) => {
    if (settings.meta('password') || settingUp) fail('已经初始化，请登录。', 409);
    const { password } = passwordBody.parse(request.body);
    settingUp = true;
    try { settings.setMeta('password', await hashPassword(password)); createSession(reply); return { ok: true }; }
    finally { settingUp = false; }
  });
  app.post('/api/auth/login', async (request, reply) => {
    const { password } = passwordBody.parse(request.body);
    const now = Date.now(), ip = request.ip;
    for (const [key, item] of attempts) if (now - item.since > 300000) attempts.delete(key);
    const attempt = attempts.get(ip) || { count: 0, since: now };
    if (attempt.count >= 10) fail('尝试次数较多，请五分钟后重试。', 429);
    attempt.count++; attempts.set(ip, attempt);
    if (!await verifyPassword(password, settings.meta('password') || '')) fail('密码不正确。', 401);
    attempts.delete(ip); createSession(reply); return { ok: true };
  });
  app.post('/api/auth/logout', async (request, reply) => { if (request.cookies.session) store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(request.cookies.session)); reply.clearCookie('session', { path: '/' }); return { ok: true }; });
  const param = (req: any, key = 'id'): string => z.string().min(1).max(100).parse(req.params[key]);
  const base = (body: unknown) => z.object({ baseRevisionId: revision }).parse(body).baseRevisionId;
  const author = (req: any) => req.query?.view === 'author';
  const source = (id: string): SourceRow => (store.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as SourceRow | undefined) || fail('找不到原文文件。', 404);
  const sourceList = (projectId: string) => (store.db.prepare('SELECT * FROM sources WHERE project_id=? ORDER BY created_at').all(projectId) as SourceRow[]).map(sourcePublic);
  app.get('/api/projects', async request => store.listProjects().map(project => author(request) ? project : { ...project, premise: '' }));
  app.post('/api/projects', async request => store.createProject(z.object({ title: z.string().trim().min(1).max(200), premise: z.string().max(100000).default(''), mode: mode.default('original') }).parse(request.body)));
  app.get('/api/projects/:id', async request => { const project = store.getProject(param(request)); return { project: author(request) ? project : { ...project, premise: '' }, branches: store.listBranches(param(request)), sources: sourceList(param(request)) }; });
  app.get('/api/branches/:id', async request => store.view(param(request), author(request)));
  app.get('/api/branches/:id/chapters/:chapterId', async request => store.chapter(param(request), param(request, 'chapterId')));
  app.post('/api/branches/:id/chapters', async request => {
    const input = z.object({ baseRevisionId: revision, title: z.string().trim().min(1).max(500), text: z.string().max(2000000), chapterId: z.string().optional() }).parse(request.body);
    const view = store.saveChapter(param(request), input);
    // Saving prose must succeed even when a provider has not been configured.
    try { engine.enqueue(view.branch.id, 'extract', { baseRevisionId: view.branch.revisionId }); } catch { /* Explicit retry is available in the workbench. */ }
    return view;
  });
  app.post('/api/branches/:id/fork', async request => store.fork(param(request), z.object({ baseRevisionId: revision, chapterId: z.string().optional(), name: z.string().trim().min(1).max(200) }).parse(request.body)));
  app.post('/api/branches/:id/rollback', async request => store.rollback(param(request), z.object({ baseRevisionId: revision, revisionId: revision }).parse(request.body)));
  app.put('/api/branches/:id/outline', async request => { const body = z.object({ baseRevisionId: revision, outline: outlineSchema }).parse(request.body); return store.updateOutline(param(request), body.baseRevisionId, body.outline); });
  app.put('/api/branches/:id/entities/:entityId', async request => { const body = z.object({ baseRevisionId: revision, entity: entitySchema }).parse(request.body); if (body.entity.id !== param(request, 'entityId')) fail('资料标识不匹配。'); return store.updateEntity(param(request), body.baseRevisionId, body.entity as Entity); });
  app.post('/api/branches/:id/entities/merge', async request => { const b = z.object({ baseRevisionId: revision, fromId: z.string(), toId: z.string() }).parse(request.body); return store.mergeEntities(param(request), b.baseRevisionId, b.fromId, b.toId); });
  app.put('/api/branches/:id/foreshadows', async request => { const b = z.object({ baseRevisionId: revision, foreshadows: z.array(foreshadowSchema).max(10000) }).parse(request.body); return store.updateForeshadows(param(request), b.baseRevisionId, b.foreshadows as Foreshadow[]); });
  app.get('/api/branches/:id/search', async request => { const { q } = z.object({ q: z.string().max(300).default('') }).parse(request.query); return store.search(param(request), q, author(request)); });
  app.post('/api/projects/:id/import', async request => {
    const projectId = param(request); store.getProject(projectId);
    const file = await request.file(); if (!file) fail('请选择 TXT 或 EPUB 文件。');
    const bytes = await file.toBuffer(); if (bytes.length > 32 * 1024 * 1024) fail('小说文件不能超过 32 MiB。', 413);
    let parsed: ReturnType<typeof parseNovel>;
    try { parsed = parseNovel(file.filename, bytes); } catch (e) { fail(e instanceof Error ? e.message : '无法解析小说文件。'); }
    const id = randomUUID(), filename = basename(file.filename.replace(/\\/g, '/')), now = new Date().toISOString();
    writeFileSync(join(uploadDir, id), bytes, { flag: 'wx', mode: 0o600 });
    try { store.db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?)').run(id, projectId, filename, parsed.format, parsed.chapters.length, now, 0, JSON.stringify(parsed.chapters), id); }
    catch (e) { unlinkSync(join(uploadDir, id)); throw e; }
    return { source: sourcePublic(source(id)), chapters: parsed.chapters } satisfies SourcePreview;
  });
  app.get('/api/sources/:id/preview', async request => { const s = source(param(request)); return { source: sourcePublic(s), chapters: JSON.parse(s.preview) }; });
  app.get('/api/sources/:id/file', async (request, reply) => { const s = source(param(request)); return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(s.filename)}`).send(readFileSync(join(uploadDir, s.storage_name))); });
  app.get('/api/sources/:id/chapters/:index', async (request, reply) => { const s = source(param(request)), chapters = JSON.parse(s.preview) as { title: string; text: string }[]; const index = z.coerce.number().int().nonnegative().parse((request.params as any).index); if (!chapters[index]) fail('找不到该原文章节。', 404); return reply.type('text/plain; charset=utf-8').send(chapters[index].text); });
  app.post('/api/sources/:id/confirm', async request => {
    const s = source(param(request));
    const b = z.object({ branchId: z.string(), baseRevisionId: revision, chapters: chaptersSchema }).parse(request.body);
    if (s.confirmed) fail('这份原文已经确认导入，请在任务列表恢复或重试整理。', 409);
    if (store.getBranch(b.branchId).projectId !== s.project_id) fail('原文与故事线不属于同一作品。');
    if (b.chapters.reduce((n, c) => n + c.text.length, 0) > 20000000) fail('正文总长度超过上限。', 413);
    const job = engine.enqueue(b.branchId, 'import', { baseRevisionId: b.baseRevisionId, chapters: b.chapters, sourceId: s.id }, () => {
      store.db.prepare('UPDATE sources SET confirmed=1,chapter_count=?,preview=? WHERE id=?').run(b.chapters.length, JSON.stringify(b.chapters), s.id);
    });
    return job;
  });
  app.post('/api/branches/:id/generate', async request => { const b = z.object({ baseRevisionId: revision, mode, instruction: z.string().max(30000), title: z.string().max(500).optional(), chapterId: z.string().optional(), selection: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).optional(), maxWords: z.number().int().min(100).max(20000).optional() }).parse(request.body); return engine.enqueue(param(request), 'generate', b); });
  app.post('/api/branches/:id/plan', async request => { const b = z.object({ baseRevisionId: revision, instruction: z.string().max(30000).optional() }).parse(request.body); return engine.enqueue(param(request), 'plan', b); });
  app.post('/api/branches/:id/extract', async request => engine.enqueue(param(request), 'extract', { baseRevisionId: base(request.body) }));
  const jobView = (job: Job, asAuthor: boolean): Job => ({ ...job, payload: {}, message: asAuthor ? job.message : ({ queued: '任务等待中', running: '任务进行中', paused: '任务已暂停', failed: '任务未完成', completed: '任务已完成', cancelled: '任务已取消', stale: '起始版本已变化' })[job.status], error: asAuthor ? job.error : job.error ? '请进入作者视图查看具体原因。' : undefined });
  app.get('/api/jobs', async request => { const { projectId } = z.object({ projectId: z.string().optional() }).parse(request.query); return engine.listJobs(projectId).map(job => jobView(job, author(request))); });
  // Model outputs can contain unrevealed plot details; never expose them in reader requests.
  const requireAuthor = (request: unknown) => { if (!author(request)) fail('请在作者视图查看或修正模型输出。', 403); };
  app.get('/api/jobs/:id/outputs', async request => { requireAuthor(request); return engine.listOutputs(param(request)); });
  app.get('/api/jobs/:id/outputs/:outputId', async request => { requireAuthor(request); return engine.outputDetail(param(request), param(request, 'outputId')); });
  app.post('/api/jobs/:id/outputs', async request => {
    requireAuthor(request);
    const { text } = z.object({ text: z.string().min(1).max(16 * 1024 * 1024) }).parse(request.body);
    return engine.importOutput(param(request), text);
  });
  app.post('/api/jobs/:id/outputs/:outputId/apply', async request => {
    requireAuthor(request);
    const body = z.object({ text: z.string().min(1).max(16 * 1024 * 1024), baseRevisionId: revision }).parse(request.body);
    return jobView(engine.applyOutput(param(request), param(request, 'outputId'), body), true);
  });
  app.post('/api/jobs/:id/:action', async request => jobView(engine.action(param(request), z.enum(['pause', 'resume', 'retry', 'cancel']).parse((request.params as any).action)), author(request)));
  app.get('/api/settings', async () => settings.public());
  app.put('/api/settings', async request => {
    const b = settingsSchema.parse(request.body) as Settings;
    const ids = new Set(b.providers.map(p => p.id));
    if (ids.size !== b.providers.length) fail('模型配置的标识不能重复。');
    for (const id of [b.writingProviderId, b.planningProviderId, b.extractionProviderId]) if (id && !ids.has(id)) fail('所选用途对应的模型配置不存在。');
    for (const provider of b.providers) {
      if (provider.maxOutputTokens >= provider.contextTokens) fail('输出上限必须小于上下文容量，还需为输入内容留出空间。');
      try { validateProviderOptions(provider); } catch (error) { fail(error instanceof Error ? error.message : '模型参数组合无效。'); }
    }
    return settings.save(b);
  });
  app.post('/api/settings/test', async request => {
    const { providerId } = z.object({ providerId: z.string() }).parse(request.body);
    const p = settings.provider(providerId); if (!p) fail('模型配置不存在。', 404);
    let snapshot: ModelRequestSnapshot | undefined; let capture: CapturedModelResponse | undefined;
    try {
      const result = await generateText(p, { system: 'You are testing an API connection.', prompt: 'Reply with OK only.', maxOutputTokens: p.maxOutputTokens,
        onRequest: value => { snapshot = value; }, onResponse: value => { capture = value; },
      });
      return { ok: true, message: '服务已返回有效文字，本次使用当前保存的参数。', inputTokens: result.inputTokens, outputTokens: result.outputTokens, capture };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '模型连接失败。', inputTokens: capture?.inputTokens ?? 0, outputTokens: capture?.outputTokens ?? 0,
        capture: capture ?? (snapshot ? { request: snapshot, rawResponse: '', text: '', inputTokens: 0, outputTokens: 0 } : undefined) };
    }
  });
  app.get('/api/branches/:id/export', async (request, reply) => {
    const branch = store.getBranch(param(request));
    const state = store.state(branch.id);
    const text = state.chapters.map(c => { const full = store.chapter(branch.id, c.id); return `${full.title}\n\n${full.text}`; }).join('\n\n');
    return reply.type('text/plain; charset=utf-8').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(branch.name)}.txt`).send(text);
  });
  app.get('/api/projects/:id/backup', async (request, reply) => {
    const projectId = param(request), project = store.getProject(projectId);
    const sources = (store.db.prepare('SELECT * FROM sources WHERE project_id=?').all(projectId) as SourceRow[]).map(s => ({ metadata: sourcePublic(s), preview: JSON.parse(s.preview), originalBase64: readFileSync(join(uploadDir, s.storage_name)).toString('base64') }));
    const bytes = Buffer.from(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: store.exportProject(projectId), sources }));
    if (bytes.length > 512 * 1024 * 1024) fail('该作品备份已超过 512 MiB，请停止服务并备份完整数据目录以保留全部历史。', 413);
    const compressed = gzipSync(bytes);
    if (compressed.length > 128 * 1024 * 1024) fail('压缩备份已超过 128 MiB，请停止服务并备份完整数据目录。', 413);
    return reply.type('application/gzip').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(project.title)}.ai-novel.json.gz`).send(compressed);
  });
  app.post('/api/restore', async request => {
    const file = await request.file(); if (!file) fail('请选择作品备份文件。');
    let raw: unknown;
    try {
      const bytes = await file.toBuffer();
      const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }) : bytes;
      raw = JSON.parse(decoded.toString('utf8'));
    } catch { fail('备份文件不是有效的 JSON / GZIP 备份，或解压后超过 512 MiB。'); }
    const backup = z.object({ format: z.literal('ai-novel-backup'), version: z.literal(1), project: z.unknown(), sources: z.array(z.object({ metadata: z.object({ id: z.string(), filename: z.string().max(500), format: z.enum(['txt', 'epub']), confirmed: z.boolean(), createdAt: z.string() }), preview: chaptersSchema, originalBase64: z.string().max(48 * 1024 * 1024) })).max(1000) }).parse(raw);
    const map: Record<string, string> = {}, createdFiles: string[] = [];
    try {
      for (const s of backup.sources) {
        if (map[s.metadata.id]) fail('备份包含重复原文。');
        const id = randomUUID(); map[s.metadata.id] = id;
        const bytes = Buffer.from(s.originalBase64, 'base64'); if (bytes.length > 32 * 1024 * 1024) fail('备份中的原文件超过上限。');
        const path = join(uploadDir, id); writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); createdFiles.push(path);
      }
      const project = store.restoreProject(backup.project, map, restored => {
        for (const s of backup.sources) store.db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?)').run(map[s.metadata.id], restored.id, basename(s.metadata.filename), s.metadata.format, s.preview.length, s.metadata.createdAt, Number(s.metadata.confirmed), JSON.stringify(s.preview), map[s.metadata.id]);
      });
      return project;
    } catch (e) { for (const path of createdFiles) if (existsSync(path)) unlinkSync(path); throw e; }
  });
  const staticDir = resolve(options.staticDir || './dist/public');
  if (existsSync(join(staticDir, 'index.html'))) {
    await app.register(staticFiles, { root: staticDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.status(404).send({ error: '接口不存在。' }) : reply.sendFile('index.html'));
  }
  app.addHook('onClose', async () => { await engine.close(); store.close(); });
  if (options.startEngine !== false) engine.start();
  return { app, store, engine, settings, dataDir };
}
