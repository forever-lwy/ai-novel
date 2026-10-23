import { readProjectSettings, saveProjectSettings } from './project-settings.js';
import { resolveProjectSettings } from '../shared/project-settings.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync, unlinkSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Store, rpgSetupSchema } from './store.js';
import { StoryEngine } from './engine.js';
import { ExtensionService, registerExtensionRoutes } from './extensions.js';
import { ImageService } from './images.js';
import { ImagePreviews } from './image-previews.js';
import { validateImageParameters } from './image-provider.js';
import { parseNovel } from './importer.js';
import { registerImportRuleRoutes } from './import-rules.js';
import { registerChapterTitleRoutes } from './chapter-titles.js';
import { generateText, redactKnownSecrets, redactModelPayload, validateProviderOptions } from './providers.js';
import { listProviderModels } from './model-catalog.js';
import { SettingsStore, tokenHash, normalizeSettings, hasUrlCredentials } from './security.js';
import { initializePassword, registerAuthRoutes } from './auth.js';
import { httpSecurityConfig, safeRequestLog, RequestRateLimit } from './http-security.js';
import { checkBackupSize, MAX_BACKUP_BYTES } from './backup-limits.js';
import type { Source, SourcePreview, Settings, Entity, Foreshadow, Job, CapturedModelResponse, ModelRequestSnapshot } from '../shared/types.js';
import { modelRoles, resolveModelConfig } from '../shared/model-settings.js';
import { validatePromptTemplates } from '../shared/prompt-templates.js';
import { modelNameSchema, providerSchema, modelRoleSchema, settingsSchema, parseProjectSettingsOverrides } from './settings-schema.js';
import { parseTaskSettings } from '../shared/task-settings.js';
import type { PromptPreviewInput } from '../shared/prompt-runtime.js';

const revision = z.string().min(1).max(100);
const mode = z.enum(['original', 'continuation', 'fanfiction', 'rewrite', 'rpg']);
const outlineSchema = z.object({ worldview: z.string().max(100000).optional(), locked: z.string().max(100000), fine: z.array(z.object({ chapter: z.number().int().positive(), title: z.string().max(500), goal: z.string().max(20000) })).max(1000).optional() });
const promptPreviewSchema = z.object({
  task: z.enum(['writing', 'extraction', 'compression', 'image']), templates: z.unknown(), protocol: providerSchema.shape.protocol,
  variables: z.record(z.string().max(100), z.string().max(200000)).refine(value => Object.keys(value).length <= 150, '示例变量过多'),
  runtime: z.object({ extractionOutputMode: z.enum(['prompt', 'structured', 'tool']).optional(), illustrations: z.object({ portrait: z.boolean(), cg: z.boolean() }).strict().optional(), chapterAnswer: z.string().max(20000).optional(), rpg: z.object({ character: z.object({ kind: z.enum(['original', 'existing']), name: z.string().max(300), description: z.string().max(20000) }).strict(), entryInstruction: z.string().max(20000) }).strict().optional() }).strict(),
}).strict();
const citationSchema = z.object({ chapterId: z.string(), paragraph: z.number().int().positive(), quote: z.string().max(10000) });
const entitySchema = z.object({ id: z.string().min(1), kind: z.enum(['character', 'faction', 'location', 'item', 'ability', 'rule', 'event']), name: z.string().min(1).max(300), aliases: z.array(z.string().min(1).max(300)).max(200), description: z.string().max(30000), visibility: z.enum(['public', 'secret']), locked: z.boolean(), isMain: z.boolean().optional(), nameStatus: z.enum(['placeholder', 'confirmed']).optional(), mergedInto: z.string().optional(), facts: z.array(z.object({ id: z.string(), text: z.string().max(10000), attribute: z.string().min(1).max(100).optional(), temporal: z.enum(['current', 'past', 'future', 'unknown']), certainty: z.enum(['fact', 'inference', 'conflict']), visibility: z.enum(['public', 'secret']), citation: citationSchema.optional(), locked: z.boolean().optional() })).max(5000) });
const foreshadowSchema = z.object({ id: z.string().min(1), title: z.string().min(1).max(300), detail: z.string().max(20000), status: z.enum(['planned', 'planted', 'resolved', 'abandoned']), plantedChapterId: z.string().optional(), resolvedChapterId: z.string().optional(), dueChapter: z.number().int().positive().optional(), revealCondition: z.string().max(20000), relatedEntityIds: z.array(z.string()).max(1000) });
const chaptersSchema = z.array(z.object({ title: z.string().min(1).max(500), text: z.string().max(20000000) })).min(1).max(20000);

function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }
type SourceRow = { id: string; project_id: string; filename: string; format: 'txt' | 'epub'; chapter_count: number; created_at: string; confirmed: number; preview: string; storage_name: string };
const sourcePublic = (r: SourceRow): Source => ({ id: r.id, projectId: r.project_id, filename: r.filename, format: r.format, chapterCount: r.chapter_count, createdAt: r.created_at, confirmed: Boolean(r.confirmed) });

export async function buildApp(options: { dataDir?: string; startEngine?: boolean; logger?: boolean; staticDir?: string; initialPassword?: string; rateLimits?: { login?: number; imports?: number; models?: number } } = {}) {
  const config = httpSecurityConfig();
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const uploadDir = join(dataDir, 'sources'); mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const store = new Store(dataDir);
  let settings: SettingsStore;
  try {
    settings = new SettingsStore(store.db, dataDir);
    await initializePassword(settings, options.initialPassword ?? process.env.INITIAL_PASSWORD);
    const oldSetupPath = join(dataDir, '.setup-token'); if (existsSync(oldSetupPath)) unlinkSync(oldSetupPath);
  } catch (error) { store.close(); throw error; }
  const images = new ImageService(store, projectId => settings.get(projectId));
  const extensions = new ExtensionService(settings, dataDir);
  const engine = new StoryEngine(store, projectId => settings.get(projectId), undefined, images, extensions);
  store.db.exec(`CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, filename TEXT NOT NULL, format TEXT NOT NULL, chapter_count INTEGER NOT NULL, created_at TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL, storage_name TEXT NOT NULL)`);
  const app = Fastify({ logger: options.logger ? { serializers: { req: safeRequestLog }, redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
    bodyLimit: 2 * 1024 * 1024, requestTimeout: 120_000, keepAliveTimeout: 15_000, maxRequestsPerSocket: 100, trustProxy: config.trustedProxies });
  app.server.headersTimeout = 30_000;
  app.addHook('onRoute', route => {
    if (route.bodyLimit !== undefined) return;
    if (route.url === '/api/restore') route.bodyLimit = 128 * 1024 * 1024;
    else if (route.url.endsWith('/import')) route.bodyLimit = 32 * 1024 * 1024 + 4096;
    else if (/\/chapters(?:\/:chapterId)?$|\/outputs(?:\/:outputId\/apply)?$/.test(route.url) || route.url === '/api/sources/:id/confirm') route.bodyLimit = 64 * 1024 * 1024;
    else if (route.url.endsWith('/entities/:entityId')) route.bodyLimit = 16 * 1024 * 1024;
    else if (['/api/settings', '/api/settings/prompt-preview', '/api/projects/:id/settings'].includes(route.url)) route.bodyLimit = 8 * 1024 * 1024;
  });
  const deletionDir = join(dataDir, 'deleted-sources');
  // Originals move aside while SQLite commits. On restart, restore files if the
  // transaction rolled back, or finish removing them if the project was deleted.
  const finishSourceDeletion = (directory: string) => {
    if (dirname(resolve(directory)) !== deletionDir) throw new Error('无效的原文清理目录');
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (!file.isFile()) throw new Error('无效的原文清理文件');
      const original = join(uploadDir, file.name);
      if (store.db.prepare('SELECT 1 FROM sources WHERE storage_name=?').get(file.name) && !existsSync(original)) renameSync(join(directory, file.name), original);
    }
    rmSync(directory, { recursive: true });
  };
  if (existsSync(deletionDir)) for (const directory of readdirSync(deletionDir, { withFileTypes: true })) {
    if (directory.isDirectory() && /^delete-[a-zA-Z0-9]+$/.test(directory.name)) {
      try { finishSourceDeletion(join(deletionDir, directory.name)); } catch (error) { app.log.error(error, '原文文件清理未完成，下次启动将重试'); }
    }
  }
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 128 * 1024 * 1024, files: 1, fields: 8 } });
  const traffic = new RequestRateLimit(1200);
  const searches = new RequestRateLimit(60);
  const imports = new RequestRateLimit(options.rateLimits?.imports ?? 3, 300_000);
  const models = new RequestRateLimit(options.rateLimits?.models ?? 20);
  const isPublic = (path: string) => ['/api/health', '/api/auth/status', '/api/auth/login'].includes(path);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff');
    if (process.env.NODE_ENV === 'production') reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (config.publicOrigin) reply.header('Strict-Transport-Security', 'max-age=31536000');
    // Authentication follows the matched route, exactly as the router does.
    const path = request.routeOptions.url || '';
    if (!path.startsWith('/api/')) return;
    if (!request.url.startsWith('/') || request.url.startsWith('//')) fail('无效的请求目标。', 400);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        const allowed = new Set(config.publicOrigin ? [config.publicOrigin] : [`http://${request.headers.host}`, `https://${request.headers.host}`]);
        if (!config.publicOrigin && process.env.NODE_ENV !== 'production') { allowed.add('http://127.0.0.1:5173'); allowed.add('http://localhost:5173'); }
        if (!allowed.has(origin)) fail('请求来源不匹配，请从应用页面操作。', 403);
      }
    }
    if (isPublic(path)) return;
    const session = request.cookies.session;
    const valid = session && store.db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash(session), Date.now());
    if (!valid) { reply.clearCookie('session', { path: '/' }); fail('请先登录。', 401); }
    if (!traffic.accept(request.ip)) fail('请求过于频繁，请稍后重试。', 429);
    if (path.endsWith('/search') && !searches.accept(request.ip)) fail('搜索过于频繁，请稍后重试。', 429);
    if (['/api/restore', '/api/projects/:id/import', '/api/projects/:id/backup'].includes(path) && !imports.accept(request.ip)) fail('备份或导入操作过于频繁，请稍后重试。', 429);
    if (['/api/settings/models', '/api/settings/test', '/api/sources/:id/generate-rule', '/api/sources/:id/chapter-titles/preview', '/api/branches/:id/chapter-titles/preview'].includes(path) && !models.accept(request.ip)) fail('模型操作过于频繁，请稍后重试。', 429);
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.status(400).send({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') });
    const err = error as Error & { statusCode?: number; code?: string };
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: '文件超过上传上限。' });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    // Do not expose SQL, file paths, upstream bodies or keys to the browser.
    return reply.status(status).send({ error: status === 500 ? '操作未完成，请查看任务状态或服务日志后重试。' : err.message });
  });
  app.get('/api/health', async () => ({ ok: true }));
  registerAuthRoutes(app, { settings, store, secureCookies: config.secureCookies, loginAttempts: options.rateLimits?.login });
  registerExtensionRoutes(app, extensions);
  const param = (req: any, key = 'id'): string => z.string().min(1).max(100).parse(req.params[key]);
  const base = (body: unknown) => z.object({ baseRevisionId: revision }).parse(body).baseRevisionId;
  const source = (id: string): SourceRow => (store.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as SourceRow | undefined) || fail('找不到原文文件。', 404);
  const sourceList = (projectId: string) => (store.db.prepare('SELECT * FROM sources WHERE project_id=? ORDER BY created_at').all(projectId) as SourceRow[]).map(sourcePublic);
  registerImportRuleRoutes(app, { settings, source, sourcePublic: value => sourcePublic(source(value.id)), bytes: value => readFileSync(join(uploadDir, source(value.id).storage_name)) });
  registerChapterTitleRoutes(app, { store, settings, engine, source, bytes: id => readFileSync(join(uploadDir, source(id).storage_name)) });
  app.get('/api/projects', async () => store.listProjects());
  app.post('/api/projects', async request => store.createProject(z.object({ title: z.string().trim().min(1).max(200), premise: z.string().max(100000).default(''), mode: mode.default('original') }).parse(request.body)));
  app.get('/api/projects/:id', async request => { const project = store.getProject(param(request)); return { project, branches: store.listBranches(param(request)), branchTree: store.listBranchTree(param(request)), sources: sourceList(param(request)), cacheVersion: store.cacheVersion() }; });
  app.delete('/api/projects/:id', async request => {
    const projectId = param(request); let stagedDirectory: string | undefined;
    try {
      await images.deleteProject(projectId, () => engine.deleteProject(projectId, () => {
        const files = store.db.prepare('SELECT DISTINCT storage_name FROM sources s WHERE project_id=? AND NOT EXISTS (SELECT 1 FROM sources other WHERE other.storage_name=s.storage_name AND other.project_id<>?)').all(projectId, projectId);
        const paths = files.map(file => {
          const path = resolve(uploadDir, String(file.storage_name));
          if (dirname(path) !== uploadDir || basename(path) !== file.storage_name) throw new Error('无效的原文存储路径');
          return path;
        });
        if (paths.length) {
          mkdirSync(deletionDir, { recursive: true }); stagedDirectory = mkdtempSync(join(deletionDir, 'delete-'));
          for (const path of paths) {
            try { renameSync(path, join(stagedDirectory, basename(path))); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        }
        store.db.prepare('DELETE FROM sources WHERE project_id=?').run(projectId);
      }));
    } catch (error) {
      if (stagedDirectory) finishSourceDeletion(stagedDirectory);
      throw error;
    }
    if (stagedDirectory) {
      try { finishSourceDeletion(stagedDirectory); } catch (error) { app.log.error(error, '作品已删除，原文文件清理将在下次启动重试'); }
    }
    return { ok: true };
  });
  // This private workbench has one authenticated owner scope; legacy view/chapter queries do not filter it.
  app.get('/api/branches/:id', async request => ({ ...store.view(param(request), true), cacheVersion: store.cacheVersion() }));
  app.put('/api/branches/:id/name', async request => {
    const input = z.object({ baseRevisionId: revision, name: z.string().trim().min(1).max(200) }).strict().parse(request.body);
    return store.renameBranch(param(request), input.baseRevisionId, input.name);
  });
  app.delete('/api/branches/:id', async request => {
    const branchId = param(request); engine.assertIdle(branchId);
    return store.deleteBranch(branchId, base(request.body));
  });
  const imageInputSchema = z.object({ baseRevisionId: revision, kind: z.enum(['portrait', 'entity', 'map', 'cg']), entityId: z.string().min(1).max(100).optional(), chapterId: z.string().min(1).max(100).optional(), selection: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).optional(), instruction: z.string().max(20000).optional(), referenceImageId: z.string().min(1).max(100).optional(), selectedReferenceImageIds: z.array(z.string().min(1).max(100)).max(16).optional() }).strict();
  app.get('/api/branches/:id/images', async request => images.list(param(request), true));
  app.post('/api/branches/:id/images', async request => { return images.generate(param(request), imageInputSchema.parse(request.body)); });
  const imagePreviews = new ImagePreviews();
  app.get('/api/branches/:id/images/:imageId/content', async (request, reply) => {
    const { size } = z.object({ size: z.enum(['preview']).optional() }).parse(request.query);
    const branchId = param(request); const imageId = param(request, 'imageId');
    // Authorize the current reference before considering a browser's cached pixels.
    const contentTag = images.contentTag(branchId, imageId);
    const etag = `${size === 'preview' ? 'W/' : ''}"${contentTag}-${size === 'preview' ? 'preview-v1' : 'original'}"`;
    if (request.headers['if-none-match']?.split(',').some(value => value.trim().replace(/^W\//, '') === etag.replace(/^W\//, '') || value.trim() === '*')) {
      return reply.header('Cache-Control', 'private, no-cache').header('ETag', etag).code(304).send();
    }
    const content = size === 'preview'
      ? await imagePreviews.get(etag, () => images.content(branchId, imageId, true))
      : images.content(branchId, imageId, true);
    // A deletion or replacement while a thumbnail was being encoded must take effect.
    if (size === 'preview' && images.contentTag(branchId, imageId) !== contentTag) fail('图片已变化，请重新打开', 409);
    return reply.type(content.mimeType).header('Cache-Control', 'private, no-cache').header('ETag', etag).header('Content-Disposition', 'inline').send(Buffer.from(content.bytes));
  });
  app.post('/api/branches/:id/images/:imageId/retry', async request => { return images.retry(param(request), param(request, 'imageId'), base(request.body)); });
  app.post('/api/branches/:id/images/:imageId/cancel', async request => { return images.cancel(param(request), param(request, 'imageId')); });
  app.put('/api/branches/:id/images/:imageId/active', async request => { const input = z.object({ baseRevisionId: revision, active: z.boolean() }).strict().parse(request.body); return images.setActive(param(request), param(request, 'imageId'), input.baseRevisionId, input.active); });
  app.delete('/api/branches/:id/images/:imageId', async request => { return images.delete(param(request), param(request, 'imageId'), base(request.body)); });
  app.get('/api/branches/:id/chapters/:chapterId', async request => store.chapter(param(request), param(request, 'chapterId')));
  app.delete('/api/branches/:id/chapters/:chapterId', async request => {
    const branchId = param(request); engine.assertIdle(branchId);
    return store.deleteChapter(branchId, base(request.body), param(request, 'chapterId'));
  });
  app.delete('/api/branches/:id/chapters/:chapterId/extraction', async request => {
    const branchId = param(request); engine.assertIdle(branchId);
    return store.clearChapterExtraction(branchId, base(request.body), param(request, 'chapterId'));
  });
  app.post('/api/branches/:id/chapters/:chapterId/extract', async request => {
    return engine.reextractChapter(param(request), base(request.body), param(request, 'chapterId'));
  });
  app.post('/api/branches/:id/chapters', async request => {
    const input = z.object({ baseRevisionId: revision, title: z.string().trim().min(1).max(500), text: z.string().max(2000000), chapterId: z.string().optional() }).parse(request.body);
    if (input.chapterId) { engine.assertIdle(param(request)); }
    const view = store.saveChapter(param(request), input);
    // Saving prose must succeed even when a provider has not been configured.
    if (!input.chapterId) try { engine.enqueue(view.branch.id, 'extract', { baseRevisionId: view.branch.revisionId }); } catch { /* Explicit retry is available in the workbench. */ }
    return view;
  });
  app.post('/api/branches/:id/fork', async request => store.fork(param(request), z.object({ baseRevisionId: revision, chapterId: z.string().optional(), name: z.string().trim().min(1).max(200) }).parse(request.body)));
  app.post('/api/branches/:id/rollback', async request => store.rollback(param(request), z.object({ baseRevisionId: revision, revisionId: revision }).parse(request.body)));
  app.put('/api/branches/:id/outline', async request => { const body = z.object({ baseRevisionId: revision, outline: outlineSchema }).parse(request.body); const existing = store.state(param(request)).outline; if (body.outline.fine && JSON.stringify(body.outline.fine) !== JSON.stringify(existing.fine)) fail('剧情规划功能已移除，历史规划不能修改。', 410); return store.updateOutline(param(request), body.baseRevisionId, { ...body.outline, fine: existing.fine }); });
  app.put('/api/branches/:id/entities/:entityId', async request => { const body = z.object({ baseRevisionId: revision, entity: entitySchema }).parse(request.body); if (body.entity.id !== param(request, 'entityId')) fail('资料标识不匹配。'); return store.updateEntity(param(request), body.baseRevisionId, body.entity as Entity); });
  app.delete('/api/branches/:id/entities/:entityId', async request => {
    const branchId = param(request); engine.assertIdle(branchId);
    return store.deleteEntity(branchId, base(request.body), param(request, 'entityId'));
  });
  app.post('/api/branches/:id/entities/merge', async request => { const b = z.object({ baseRevisionId: revision, fromId: z.string(), toId: z.string() }).parse(request.body); return store.mergeEntities(param(request), b.baseRevisionId, b.fromId, b.toId); });
  app.put('/api/branches/:id/foreshadows', async request => { const b = z.object({ baseRevisionId: revision, foreshadows: z.array(foreshadowSchema).max(10000) }).parse(request.body); return store.updateForeshadows(param(request), b.baseRevisionId, b.foreshadows as Foreshadow[]); });
  app.get('/api/branches/:id/search', async request => { const { q } = z.object({ q: z.string().max(300).default('') }).parse(request.query); return store.search(param(request), q, true); });
  app.post('/api/projects/:id/import', async request => {
    const projectId = param(request); store.getProject(projectId);
    const file = await request.file(); if (!file) fail('请选择 TXT 或 EPUB 文件。');
    const bytes = await file.toBuffer(); if (bytes.length > 32 * 1024 * 1024) fail('小说文件不能超过 32 MiB。', 413);
    let parsed: ReturnType<typeof parseNovel>;
    try { parsed = parseNovel(file.filename, bytes); } catch (e) { fail(e instanceof Error ? e.message : '无法解析小说文件。'); }
    // The project may have been deleted while the multipart upload was arriving.
    store.getProject(projectId);
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
  app.post('/api/branches/:id/generate', async request => { const b = z.object({ baseRevisionId: revision, mode, instruction: z.string().max(30000), title: z.string().max(500).optional(), branchName: z.string().trim().min(1).max(200).optional(), chapterId: z.string().optional(), selection: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).optional(), maxWords: z.number().int().min(100).max(20000).optional(), regenerate: z.boolean().optional(), discardBackground: z.boolean().optional(), rpg: rpgSetupSchema.optional() }).parse(request.body); return engine.enqueue(param(request), 'generate', b); });
  app.post('/api/branches/:id/extract', async request => engine.enqueue(param(request), 'extract', { baseRevisionId: base(request.body) }));
  const jobView = (job: Job): Job => ({ ...job, payload: {} });
  app.get('/api/jobs', async request => { const { projectId } = z.object({ projectId: z.string().optional() }).parse(request.query); return engine.listJobs(projectId).map(job => jobView(job)); });
  app.get('/api/jobs/:id/activities', async request => { return engine.listWritingActivities(param(request)); });
  app.get('/api/jobs/:id/events', async (request, reply) => {
    const jobId = param(request); const snapshot = engine.writingSnapshot(jobId);
    const sessionHash = tokenHash(request.cookies.session || '');
    const stillAuthenticated = () => Boolean(store.db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(sessionHash, Date.now()));
    reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const terminal = (status: string) => ['completed', 'failed', 'cancelled', 'stale', 'paused'].includes(status);
    let unsubscribe = () => {}; let heartbeat: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => { unsubscribe(); if (heartbeat) clearInterval(heartbeat); };
    const send = (event: Parameters<typeof engine.subscribeWriting>[1] extends (event: infer T) => void ? T : never) => {
      if (!stillAuthenticated()) { cleanup(); reply.raw.end(); return; }
      if (reply.raw.destroyed || reply.raw.writableEnded) { cleanup(); return; }
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if ((event.type === 'snapshot' || event.type === 'status') && terminal(event.job.status)) { cleanup(); reply.raw.end(); }
    };
    unsubscribe = engine.subscribeWriting(jobId, send); reply.raw.on('close', cleanup);
    send(snapshot);
    if (!terminal(snapshot.job.status)) heartbeat = setInterval(() => { if (!stillAuthenticated()) { cleanup(); reply.raw.end(); } else if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(': keepalive\n\n'); else cleanup(); }, 15000);
  });
  app.post('/api/branches/:id/summary-compression', async request => { return engine.enqueue(param(request), 'plan', { baseRevisionId: base(request.body), purpose: 'compress-summary' }); });
  app.get('/api/jobs/:id/summary-compression', async request => { return engine.summaryCompression(param(request)); });
  app.post('/api/branches/:id/summary-compression/confirm', async request => {
    const body = z.object({ baseRevisionId: revision, jobId: z.string().min(1), text: z.string().trim().min(1).max(1000000) }).parse(request.body);
    return engine.confirmSummaryCompression(param(request), body);
  });
  app.get('/api/jobs/:id/outputs', async request => { return engine.listOutputs(param(request)); });
  app.get('/api/jobs/:id/outputs/:outputId', async request => { return JSON.parse(redactModelPayload(JSON.stringify(engine.outputDetail(param(request), param(request, 'outputId'))), settings.get().providers.flatMap(provider => provider.apiKey ? [provider.apiKey] : []))); });
  app.post('/api/jobs/:id/outputs', async request => {
    const { text } = z.object({ text: z.string().min(1).max(16 * 1024 * 1024) }).parse(request.body);
    return engine.importOutput(param(request), text);
  });
  app.post('/api/jobs/:id/outputs/:outputId/apply', async request => {
    const body = z.object({ text: z.string().min(1).max(16 * 1024 * 1024), baseRevisionId: revision }).parse(request.body);
    return jobView(engine.applyOutput(param(request), param(request, 'outputId'), body));
  });
  app.post('/api/jobs/:id/choice', async request => { const input = z.object({ choiceId: z.string().min(1).max(100), optionId: z.string().min(1).max(100).optional(), customText: z.string().trim().min(1).max(10000).optional(), baseRevisionId: revision.optional(), branchId: z.string().min(1).optional() }).strict().parse(request.body); return jobView(engine.choose(param(request), input)); });
  app.post('/api/jobs/:id/:action', async request => jobView(engine.action(param(request), z.enum(['pause', 'resume', 'retry', 'cancel']).parse((request.params as any).action))));
  app.get('/api/settings', async () => settings.public());
  const projectSettingsView = (projectId: string) => ({ ...readProjectSettings(store.db, projectId), global: settings.public(), effective: settings.public(projectId) });
  app.get('/api/projects/:id/settings', async request => projectSettingsView(param(request)));
  app.put('/api/projects/:id/settings', async request => {
    const projectId = param(request); store.getProject(projectId);
    const body = z.object({ revision: z.string().min(1).max(100), overrides: z.unknown() }).strict().parse(request.body);
    let overrides;
    try { overrides = parseProjectSettingsOverrides(body.overrides); }
    catch (error) { fail(error instanceof Error ? error.message : '作品设置格式无效。'); }
    const effective = normalizeSettings(resolveProjectSettings(settings.get(), overrides));
    const providerExists = (id: string) => !id || effective.providers.some(provider => provider.id === id);
    for (const role of modelRoles) {
      const task = overrides.tasks?.[role];
      if (!task) continue;
      if (!providerExists(task.providerId)) fail('作品任务所选供应商已不存在，请重新选择或恢复继承全局。');
      for (const profile of effective.modelParameters?.filter(profile => profile.role === role) ?? []) {
        const provider = effective.providers.find(provider => provider.id === profile.providerId);
        // Retain inactive profiles for removed connections; only the selected connection must exist.
        if (!provider) continue;
        try { validateProviderOptions(resolveModelConfig(effective, provider, profile.model, role)); }
        catch (error) { fail(error instanceof Error ? error.message : '模型参数组合无效。'); }
      }
    }
    const image = overrides.imageSettings;
    if (image) {
      if (!providerExists(image.providerId) || !providerExists(image.promptProviderId ?? '')) fail('作品生图或提示词优化的供应商已不存在，请重新选择或恢复继承全局。');
      if (image.providerId && !image.model || image.promptProviderId && !image.promptModel) fail('已选择供应商时需要填写对应模型名称。');
      try { if (image.providerId) validateImageParameters(image); }
      catch (error) { fail(error instanceof Error ? error.message : '图片模型参数无效。'); }
    }
    saveProjectSettings(store.db, projectId, body.revision, overrides);
    return projectSettingsView(projectId);
  });
  app.post('/api/settings/prompt-preview', async request => {
    const input = promptPreviewSchema.parse(request.body);
    try { return engine.previewPrompt({ ...input, templates: validatePromptTemplates(input.templates) } as PromptPreviewInput); }
    catch (error) { fail(error instanceof Error ? error.message : '提示词预览失败。'); }
  });
  app.put('/api/settings', async request => {
    const input = settingsSchema.parse(request.body) as Settings;
    if (input.providers.some(provider => hasUrlCredentials(provider.baseUrl))) fail('服务地址不能包含密钥或 Token 查询参数，请移到独立密钥字段。');
    if (input.promptTemplates !== undefined) {
      try { input.promptTemplates = validatePromptTemplates(input.promptTemplates); }
      catch (error) { fail(error instanceof Error ? error.message : '提示词编排配置无效。'); }
    } else input.promptTemplates = settings.get().promptTemplates;
    if (input.imageSettings === undefined) input.imageSettings = settings.get().imageSettings;
    input.taskSettings = input.taskSettings === undefined ? settings.get().taskSettings : parseTaskSettings(input.taskSettings, settings.get().taskSettings);
    const originalProfiles = new Set<string>();
    for (const profile of input.modelParameters ?? []) {
      const key = JSON.stringify([profile.role ?? null, profile.providerId, profile.model]);
      if (originalProfiles.has(key)) fail('同一任务、供应商和模型的参数不能重复。');
      originalProfiles.add(key);
    }
    const b = normalizeSettings(input);
    if ((b.modelParameters?.length ?? 0) > 3000) fail('按任务展开后的模型参数最多保存 3000 项。');
    const ids = new Set(b.providers.map(p => p.id));
    if (ids.size !== b.providers.length) fail('供应商连接的标识不能重复。');
    if (b.imageSettings?.providerId && !ids.has(b.imageSettings.providerId)) fail('生图对应的供应商连接不存在。');
    if (b.imageSettings?.providerId && !b.imageSettings.model) fail('生图需要填写图片模型名称。');
    if (b.imageSettings?.promptProviderId && !ids.has(b.imageSettings.promptProviderId)) fail('生图提示词优化对应的供应商不存在。');
    if (b.imageSettings?.promptProviderId && !b.imageSettings.promptModel?.trim()) fail('请填写生图提示词优化的文字模型名称。');
    if (b.imageSettings?.providerId && b.imageSettings.model) {
      try { validateImageParameters(b.imageSettings); } catch (error) { fail(error instanceof Error ? error.message : '图片模型参数无效。'); }
    }
    for (const role of ['writing', 'planning', 'extraction'] as const) {
      const id = b[`${role}ProviderId`];
      if (id && !ids.has(id)) fail('所选任务对应的供应商连接不存在。');
      if (id && !b[`${role}Model`]) fail(`${role === 'writing' ? '写作' : role === 'planning' ? '摘要压缩' : '资料提取'}任务需要选择或填写模型名称。`);
    }
    const profiles = new Set<string>();
    for (const profile of b.modelParameters ?? []) {
      if (!ids.has(profile.providerId)) fail('模型参数对应的供应商连接不存在。');
      const key = JSON.stringify([profile.role, profile.providerId, profile.model]);
      if (profiles.has(key)) fail('同一任务、供应商和模型的参数不能重复。');
      profiles.add(key);
      if (profile.maxOutputTokens >= profile.contextTokens) fail('输出上限必须小于上下文上限，还需为输入内容留出空间。');
      const provider = b.providers.find(value => value.id === profile.providerId)!;
      try { validateProviderOptions(resolveModelConfig(b, provider, profile.model, profile.role!)); } catch (error) { fail(error instanceof Error ? error.message : '模型参数组合无效。'); }
    }
    return settings.save(b);
  });
  app.post('/api/settings/models', async request => {
    const body = z.union([z.object({ providerId: z.string().min(1).max(100) }).strict(), z.object({ provider: providerSchema }).strict()]).parse(request.body);
    const provider = 'provider' in body ? settings.resolveProvider(body.provider) : settings.provider(body.providerId);
    if (!provider) fail('供应商连接不存在。', 404);
    try { return { models: await listProviderModels(provider) }; }
    catch (error) {
      const message = redactModelPayload(error instanceof Error ? error.message : '获取上游模型失败，请稍后重试或自定义模型名称。', provider.apiKey ? [provider.apiKey] : []);
      fail(message, (error as { statusCode?: number })?.statusCode === 400 ? 400 : 502);
    }
  });
  app.post('/api/settings/test', async request => {
    const { projectId, providerId, model: requestedModel, role: requestedRole } = z.object({ projectId: z.string().min(1).max(100).optional(), providerId: z.string().min(1).max(100), model: modelNameSchema.refine(value => Boolean(value), '请选择或填写用于测试的模型名称').optional(), role: modelRoleSchema.optional() }).parse(request.body);
    const current = settings.get(projectId); const connection = current.providers.find(provider => provider.id === providerId);
    if (!connection) fail('供应商连接不存在。', 404);
    const candidateRoles = requestedRole ? [requestedRole] : modelRoles;
    const assignedModel = candidateRoles.map(role => current[`${role}ProviderId`] === providerId ? current[`${role}Model`] : '').find(Boolean);
    const model = requestedModel ?? assignedModel;
    if (!model) fail('请选择或填写用于测试的模型名称。');
    const role = requestedRole ?? modelRoles.find(value => current[`${value}ProviderId`] === providerId && current[`${value}Model`] === model) ?? 'writing';
    const p = resolveModelConfig(current, connection, model, role);
    let snapshot: ModelRequestSnapshot | undefined; let capture: CapturedModelResponse | undefined;
    try {
      const result = await generateText(p, { system: 'You are testing an API connection.', prompt: 'Reply with OK only.', maxOutputTokens: p.maxOutputTokens,
        onRequest: value => { snapshot = value; }, onResponse: value => { capture = value; },
      });
      return { ok: true, message: '服务已返回有效文字，本次使用当前保存的参数。', inputTokens: result.inputTokens, outputTokens: result.outputTokens, capture };
    } catch (error) {
      return { ok: false, message: redactModelPayload(error instanceof Error ? error.message : '模型连接失败。', p.apiKey ? [p.apiKey] : []), inputTokens: capture?.inputTokens ?? 0, outputTokens: capture?.outputTokens ?? 0,
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
    checkBackupSize(store.db, uploadDir, projectId);
    const sources = (store.db.prepare('SELECT * FROM sources WHERE project_id=?').all(projectId) as SourceRow[]).map(s => ({ metadata: sourcePublic(s), preview: JSON.parse(s.preview), originalBase64: readFileSync(join(uploadDir, s.storage_name)).toString('base64') }));
    const data = store.exportProject(projectId);
    const keys = settings.get().providers.flatMap(provider => provider.apiKey ? [provider.apiKey] : []);
    data.outputs = JSON.parse(redactModelPayload(JSON.stringify(data.outputs), keys));
    data.writingActivities = JSON.parse(redactModelPayload(JSON.stringify(data.writingActivities), keys));
    data.writingDrafts = data.writingDrafts.map(draft => ({ ...draft, text: redactKnownSecrets(String(draft.text), keys) }));
    // Authoritative source bytes, prose and world snapshots are preserved verbatim.
    const bytes = Buffer.from(JSON.stringify({ format: 'ai-novel-backup', version: 1, project: data, sources }));
    if (bytes.length > MAX_BACKUP_BYTES) fail('该作品备份已超过 128 MiB，请停止服务并备份完整数据目录以保留全部历史。', 413);
    const compressed = gzipSync(bytes);
    if (compressed.length > 128 * 1024 * 1024) fail('压缩备份已超过 128 MiB，请停止服务并备份完整数据目录。', 413);
    return reply.type('application/gzip').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(project.title)}.ai-novel.json.gz`).send(compressed);
  });
  app.post('/api/restore', async request => {
    const file = await request.file(); if (!file) fail('请选择作品备份文件。');
    let raw: unknown;
    try {
      const bytes = await file.toBuffer();
      const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }) : bytes;
      if (decoded.byteLength > 128 * 1024 * 1024) fail('备份解压后不能超过 128 MiB。', 413);
      raw = JSON.parse(decoded.toString('utf8'));
    } catch { fail('备份文件不是有效的 JSON / GZIP 备份，或解压后超过 128 MiB。'); }
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
  app.addHook('onClose', async () => { extensions.close(); await Promise.all([engine.close(), images.close()]); store.close(); });
  if (options.startEngine !== false) engine.start();
  return { app, store, engine, images, settings, extensions, dataDir };
}
