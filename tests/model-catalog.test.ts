import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listProviderModels } from '../server/model-catalog.js';
import type { ProviderConnection, ProviderProtocol } from '../shared/types.js';

const secret = 'catalog-test-api-key';
const servers: Server[] = [];
const config = (protocol: ProviderProtocol, extra: Partial<ProviderConnection> = {}): ProviderConnection => ({
  id: 'provider', name: '供应商', protocol, baseUrl: 'https://gateway.example/prefix/v1?tenant=book',
  apiKey: secret, maxOutputTokens: 4096, contextTokens: 32000, ...extra,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function mockFetch(...responses: Response[]) {
  const mock = vi.fn<typeof fetch>();
  for (const response of responses) mock.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('provider model catalogs', () => {
  it.each(['openai-chat', 'openai-responses'] as const)('loads %s models with Bearer authentication and the custom API prefix/query', async protocol => {
    const fetchMock = mockFetch(json({ data: [{ id: 'model-b', name: '模型 B' }, { id: 'model-a' }, { id: 'model-b' }, { id: '' }, { id: 123 }, null] }));
    const models = await listProviderModels(config(protocol, { apiKey: ` ${secret} `, baseUrl: 'https://gateway.example/prefix/v1///?tenant=book&api-version=2026-01#fragment' }));
    expect(models).toEqual([{ id: 'model-b', name: '模型 B' }, { id: 'model-a' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gateway.example/prefix/v1/models?tenant=book&api-version=2026-01');
    expect(init).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' }, redirect: 'error' });
    expect(init?.body).toBeUndefined();
  });

  it('paginates Gemini, strips models/ and excludes models that declare no generateContent support', async () => {
    const fetchMock = mockFetch(
      json({ models: [
        { name: 'models/gemini-text', displayName: 'Gemini Text', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/disabled', supportedGenerationMethods: [] },
        { name: 'models/compatible' },
      ], nextPageToken: 'page /+&token' }),
      json({ models: [{ name: 'models/gemini-text' }, { name: 'models/gemini-later', displayName: 'Later' }] }),
    );
    expect(await listProviderModels(config('gemini', { baseUrl: 'https://gateway.example/prefix/v1beta?tenant=book&pageSize=2' }))).toEqual([
      { id: 'gemini-text', name: 'Gemini Text' }, { id: 'compatible' }, { id: 'gemini-later', name: 'Later' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(firstUrl.pathname).toBe('/prefix/v1beta/models');
    expect(firstUrl.searchParams.get('pageSize')).toBe('2');
    expect(firstUrl.searchParams.has('pageToken')).toBe(false);
    expect(secondUrl.searchParams.get('pageToken')).toBe('page /+&token');
    expect(secondUrl.searchParams.get('tenant')).toBe('book');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json', 'x-goog-api-key': secret });
  });

  it('paginates Claude with after_id and preserves display names and provider queries', async () => {
    const fetchMock = mockFetch(
      json({ data: [{ id: 'claude-first', display_name: 'Claude First' }], has_more: true, last_id: 'cursor /+&' }),
      json({ data: [{ id: 'claude-next', display_name: 'Claude Next' }], has_more: false, last_id: 'claude-next' }),
    );
    expect(await listProviderModels(config('claude'))).toEqual([{ id: 'claude-first', name: 'Claude First' }, { id: 'claude-next', name: 'Claude Next' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json', 'x-api-key': secret, 'anthropic-version': '2023-06-01' });
    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(secondUrl.searchParams.get('after_id')).toBe('cursor /+&');
    expect(secondUrl.searchParams.get('tenant')).toBe('book');
    expect(secondUrl.searchParams.get('limit')).toBe('1000');
  });

  it('accepts an empty Gemini response and supports gateways without an API key', async () => {
    const fetchMock = mockFetch(json({}));
    expect(await listProviderModels(config('gemini', { apiKey: undefined }))).toEqual([]);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json' });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('pageSize')).toBe('1000');
  });

  it('does not mistake an HTTP 200 Gemini error envelope for an empty list', async () => {
    mockFetch(json({ error: { message: secret } }));
    const error = await listProviderModels(config('gemini')).catch(error => error);
    expect(error.message).toContain('模型列表格式不正确');
    expect(error.message).not.toContain(secret);
  });

  it('keeps model IDs within the task model-name length limit after stripping the Gemini resource prefix', async () => {
    mockFetch(json({ models: [{ name: `models/${'a'.repeat(300)}` }, { name: `models/${'b'.repeat(301)}` }, { id: 'wrong-field' }] }));
    expect(await listProviderModels(config('gemini'))).toEqual([{ id: 'a'.repeat(300) }]);
  });

  it('redacts API keys and sensitive query values in names and removes credential echoes used as model IDs', async () => {
    mockFetch(json({ data: [
      { id: 'valid', name: `Model ${secret} route-secret` },
      { id: secret }, { id: 'route-secret' }, { id: 'control\u0000character' },
      { id: 'safe', name: { apiKey: secret } },
    ] }));
    const models = await listProviderModels(config('openai-chat', { baseUrl: 'https://gateway.example/v1?api_key=route-secret' }));
    expect(models).toEqual([{ id: 'valid', name: 'Model [REDACTED] [REDACTED]' }, { id: 'safe' }]);
    expect(JSON.stringify(models)).not.toContain(secret);
    expect(JSON.stringify(models)).not.toContain('route-secret');
  });

  it.each([401, 403, 404, 429, 500])('returns a safe HTTP %s error with the custom-model fallback and does not retry', async status => {
    const fetchMock = mockFetch(json({ error: { message: `private https://gateway.example/?token=route-secret ${secret}` } }, status));
    const error = await listProviderModels(config('openai-chat')).catch(error => error);
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).toContain('自定义模型名称');
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('route-secret');
    expect(error.message).not.toContain('https://');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([new Response('not json'), json([]), json({ data: 'models' }), json({ error: 'failed' })])('rejects malformed catalog responses without leaking their body', async response => {
    mockFetch(response);
    await expect(listProviderModels(config('openai-chat'))).rejects.toThrow('模型列表格式不正确');
  });

  it('does not disclose network exceptions, provider URLs or credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`connect failed https://gateway.example/?token=route-secret ${secret}`));
    vi.stubGlobal('fetch', fetchMock);
    const error = await listProviderModels(config('claude')).catch(error => error);
    expect(error.message).toContain('无法读取供应商模型列表');
    for (const text of [secret, 'route-secret', 'gateway.example', 'connect failed']) expect(error.message).not.toContain(text);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['file:///private', 'https://user:password@gateway.example/v1', 'invalid'])('rejects invalid or credential-bearing base URL %s before sending a request', async baseUrl => {
    const fetchMock = mockFetch();
    const error = await listProviderModels(config('openai-chat', { baseUrl })).catch(error => error);
    expect(error.statusCode).toBe(400);
    expect(error.message).not.toContain(baseUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not forward credentials to an HTTP redirect destination', async () => {
    let destinationRequests = 0;
    const destination = createServer((_req, res) => { destinationRequests++; res.end(JSON.stringify({ data: [{ id: 'redirected' }] })); });
    const original = createServer((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${secret}`);
      const address = destination.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      res.writeHead(302, { Location: `http://127.0.0.1:${address.port}/models` }); res.end();
    });
    servers.push(destination, original);
    await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => original.listen(0, '127.0.0.1', resolve));
    const address = original.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    await expect(listProviderModels(config('openai-chat', { baseUrl: `http://127.0.0.1:${address.port}/v1` }))).rejects.toThrow('无法读取');
    expect(destinationRequests).toBe(0);
  });

  it.each(['gemini', 'claude'] as const)('stops repeated %s pagination cursors', async protocol => {
    const response = () => protocol === 'gemini' ? { models: [{ name: 'models/text' }], nextPageToken: 'same' } : { data: [{ id: 'text' }], has_more: true, last_id: 'same' };
    const fetchMock = mockFetch(json(response()), json(response()));
    await expect(listProviderModels(config(protocol))).rejects.toThrow('重复的分页标记');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects missing Claude cursors and malformed Gemini cursors', async () => {
    const fetchMock = mockFetch(json({ data: [], has_more: true, last_id: null }), json({ models: [], nextPageToken: { token: secret } }));
    await expect(listProviderModels(config('claude'))).rejects.toThrow('格式不正确');
    await expect(listProviderModels(config('gemini'))).rejects.toThrow('格式不正确');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds pagination rather than following an unlimited catalog', async () => {
    let page = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => json({ models: [], nextPageToken: `cursor-${++page}` }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listProviderModels(config('gemini'))).rejects.toThrow('超过 20 页');
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it('counts all upstream entries, including duplicates, against the model limit', async () => {
    mockFetch(json({ data: Array.from({ length: 5001 }, () => ({ id: 'same' })) }));
    await expect(listProviderModels(config('openai-chat'))).rejects.toThrow('超过 5000 条');
  });

  it('bounds aggregate response bytes across pages', async () => {
    const fetchMock = mockFetch(
      json({ models: [{ name: 'models/one' }], nextPageToken: 'next', padding: 'x'.repeat(2300000) }),
      json({ models: [{ name: 'models/two' }], padding: 'x'.repeat(2300000) }),
    );
    await expect(listProviderModels(config('gemini'))).rejects.toThrow('超过 4 MiB');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized declared response before reading it', async () => {
    const response = new Response('{}', { headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) } });
    mockFetch(response);
    await expect(listProviderModels(config('openai-chat'))).rejects.toThrow('超过 4 MiB');
    expect(response.bodyUsed).toBe(false);
  });

  it('applies one configured timeout to the entire paginated request without retry', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(json({ models: [], nextPageToken: 'next' })), 600)))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(secret)), { once: true })));
    vi.stubGlobal('fetch', fetchMock);
    const result = listProviderModels(config('gemini', { timeoutMs: 1000 })).catch(error => error);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(error.message).toContain('超时（1 秒）');
    expect(error.message).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps long provider timeouts at 30 seconds while loading models', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))));
    const result = listProviderModels(config('openai-chat', { timeoutMs: 3600000 })).catch(error => error);
    await vi.advanceTimersByTimeAsync(30000);
    expect((await result).message).toContain('超时（30 秒）');
  });

  it('keeps the timeout active when an upstream body stops arriving', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":['));
        init?.signal?.addEventListener('abort', () => controller.error(new Error(secret)), { once: true });
      },
    }))));
    const result = listProviderModels(config('openai-chat', { timeoutMs: 1000 })).catch(error => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).message).toContain('超时（1 秒）');
  });
});
