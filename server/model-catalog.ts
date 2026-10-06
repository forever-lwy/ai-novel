import type { ProviderConnection, ProviderModel } from '../shared/types.js';
import { providerFetch } from './outbound.js';
import { redactModelPayload } from './providers.js';

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 5000;
const MAX_PAGES = 20;
const MAX_TIMEOUT_MS = 30_000;
const customModelHint = '仍可自定义模型名称。';

class ModelCatalogError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(`${message}${customModelHint}`);
    this.name = 'ModelCatalogError';
  }
}

function endpoint(config: ProviderConnection): URL {
  let url: URL;
  try { url = new URL(config.baseUrl); }
  catch { throw new ModelCatalogError('供应商地址无效，请填写完整的 HTTP 或 HTTPS 地址。', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ModelCatalogError('供应商地址仅支持 HTTP/HTTPS，且不能包含用户名或密码。', 400);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  url.hash = '';
  if (config.protocol === 'gemini' && !url.searchParams.has('pageSize')) url.searchParams.set('pageSize', '1000');
  if (config.protocol === 'claude' && !url.searchParams.has('limit')) url.searchParams.set('limit', '1000');
  return url;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalidResponse = () => new ModelCatalogError('供应商返回的模型列表格式不正确，请检查接口协议。');

/** Read the catalog with one byte budget shared by all pages. */
async function readPage(response: Response, budget: { bytes: number }, controller: AbortController): Promise<Record<string, unknown>> {
  if (!response.body) throw invalidResponse();
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_CATALOG_BYTES - budget.bytes) {
    controller.abort();
    throw new ModelCatalogError('供应商模型列表超过 4 MiB，无法自动加载。');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let pageBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      budget.bytes += next.value.byteLength;
      if (budget.bytes > MAX_CATALOG_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new ModelCatalogError('供应商模型列表超过 4 MiB，无法自动加载。');
      }
      chunks.push(next.value);
      pageBytes += next.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks, pageBytes).toString('utf8')); }
  catch { throw invalidResponse(); }
  if (!object(data)) throw invalidResponse();
  return data;
}

function safeString(value: unknown, secrets: string[], maxLength = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return redactModelPayload(trimmed, secrets);
}

/** Fetch only the provider's catalog; model generation is never used as a fallback. */
export async function listProviderModels(config: ProviderConnection): Promise<ProviderModel[]> {
  if (!['openai-chat', 'openai-responses', 'gemini', 'claude'].includes(config.protocol)) {
    throw new ModelCatalogError('供应商接口协议无效。', 400);
  }
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000)) {
    throw new ModelCatalogError('请求超时必须是至少 1000 毫秒的整数。', 400);
  }
  const url = endpoint(config);
  const key = config.apiKey?.trim();
  const secrets = [config.apiKey ?? '', ...[...url.searchParams].filter(([name]) => /(?:key|token|secret|password|signature|credential|authorization|session|^sid$|^sig$|^jwt$)/i.test(name)).map(([, value]) => value)].filter(Boolean);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.protocol === 'gemini') { if (key) headers['x-goog-api-key'] = key; }
  else if (config.protocol === 'claude') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key) headers.Authorization = `Bearer ${key}`;
  const timeoutMs = Math.min(config.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref?.();
  const budget = { bytes: 0 };
  const models = new Map<string, ProviderModel>();
  const seenCursors = new Set<string>();
  const cursorParameter = config.protocol === 'gemini' ? 'pageToken' : 'after_id';
  const initialCursor = url.searchParams.get(cursorParameter);
  if (initialCursor) seenCursors.add(initialCursor);
  let entriesRead = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      // Do not send credentials to any redirect target, including another origin.
      const response = await providerFetch(new URL(url), { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        controller.abort();
        const hint = response.status === 401 || response.status === 403 ? '请检查密钥及模型列表权限。'
          : response.status === 404 ? '请检查 API 前缀；该供应商也可能不提供模型列表。'
          : response.status === 429 ? '请求过于频繁或额度不足，请稍后手动刷新。'
          : '请检查供应商服务后手动刷新。';
        throw new ModelCatalogError(`获取供应商模型列表失败（HTTP ${response.status}）。${hint}`);
      }
      const data = await readPage(response, budget, controller);
      if (data.error !== undefined) throw invalidResponse();
      // An empty repeated field may be omitted by the Gemini protobuf JSON encoder.
      const entries = config.protocol === 'gemini' ? data.models ?? [] : data.data;
      if (!Array.isArray(entries)) throw invalidResponse();
      entriesRead += entries.length;
      if (entriesRead > MAX_MODELS) throw new ModelCatalogError(`供应商模型列表超过 ${MAX_MODELS} 条，无法自动加载。`);
      for (const entry of entries) {
        if (!object(entry)) continue;
        if (config.protocol === 'gemini' && entry.supportedGenerationMethods !== undefined) {
          if (!Array.isArray(entry.supportedGenerationMethods) || !entry.supportedGenerationMethods.includes('generateContent')) continue;
        }
        const rawId = config.protocol === 'gemini' ? entry.name : entry.id;
        const modelId = config.protocol === 'gemini' && typeof rawId === 'string' ? rawId.trim().replace(/^models\//, '') : rawId;
        const safeId = safeString(modelId, secrets, 300);
        // A credential echoed as an ID is not a usable model and must not reach the browser.
        if (!safeId || safeId !== (modelId as string).trim()) continue;
        const id = safeId;
        if (!id || models.has(id)) continue;
        const name = safeString(config.protocol === 'gemini' ? entry.displayName : config.protocol === 'claude' ? entry.display_name : entry.name, secrets);
        models.set(id, { id, ...(name ? { name } : {}) });
      }
      let cursor: unknown;
      if (config.protocol === 'gemini') cursor = data.nextPageToken;
      else if (config.protocol === 'claude' && data.has_more === true) {
        cursor = data.last_id;
        if (typeof cursor !== 'string' || !cursor) throw invalidResponse();
      }
      if (cursor === undefined || cursor === null || cursor === '') return [...models.values()];
      if (typeof cursor !== 'string' || cursor.length > 2000) throw invalidResponse();
      if (seenCursors.has(cursor)) throw new ModelCatalogError('供应商模型列表返回了重复的分页标记，无法继续加载。');
      seenCursors.add(cursor);
      url.searchParams.set(cursorParameter, cursor);
      if (config.protocol === 'claude') url.searchParams.delete('before_id');
    }
    throw new ModelCatalogError(`供应商模型列表超过 ${MAX_PAGES} 页，无法自动加载。`);
  } catch (error) {
    if (timedOut) throw new ModelCatalogError(`获取供应商模型列表超时（${timeoutMs / 1000} 秒），请稍后手动刷新。`);
    if (error instanceof ModelCatalogError) throw error;
    // Never include upstream bodies, fetch errors, URLs or credentials in diagnostics.
    throw new ModelCatalogError('无法读取供应商模型列表，请检查服务地址、接口协议和网络连接。');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
