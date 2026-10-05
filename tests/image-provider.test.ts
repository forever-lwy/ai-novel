import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateImage, ImageProviderError, MAX_IMAGE_BYTES } from '../server/image-provider.js';
import type { ImageSettings, ProviderConnection } from '../shared/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF4QAAAAASUVORK5CYII=', 'base64');
const secret = 'image-test-secret';
const provider: ProviderConnection = { id: 'p', name: '图片服务', protocol: 'openai-chat', baseUrl: 'https://images.example/prefix/v1?tenant=book', apiKey: secret };
const settings: ImageSettings = { providerId: 'p', model: 'gpt-image-1', protocol: 'openai-images', size: '1024x1536', quality: 'high', stylePrompt: '', autoPortrait: true, autoCG: false, timeoutMs: 60_000 };
const reference = { bytes: png, mimeType: 'image/png' as const };
const servers: Server[] = [];
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const imageResponse = () => json({ data: [{ b64_json: png.toString('base64') }] });
function mockFetch(...responses: Response[]) {
  const mock = vi.fn<typeof fetch>();
  for (const response of responses) mock.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', mock);
  return mock;
}
const geminiResponse = (extra: Record<string, unknown> = {}) => json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '已生成' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] }, ...extra }] });

afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('image provider wire protocols', () => {
  it('generates GPT Image with a single JSON request, configured quality and API prefix', async () => {
    const fetchMock = mockFetch(imageResponse());
    expect(await generateImage({ ...provider, apiKey: ` ${secret} `, baseUrl: `${provider.baseUrl}#fragment` }, settings, '绘制人物全身立绘')).toEqual(reference);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://images.example/prefix/v1/images/generations?tenant=book');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` } });
    expect(JSON.parse(init!.body as string)).toEqual({ model: 'gpt-image-1', prompt: '绘制人物全身立绘', n: 1, size: '1024x1536', quality: 'high' });
  });

  it('requests b64_json and preserves quality for custom OpenAI-compatible image model names', async () => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage({ ...provider, apiKey: undefined }, { ...settings, model: 'gateway-image-model' }, '大场景');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ quality: 'high', response_format: 'b64_json' });
    expect(fetchMock.mock.calls[0][1]!.headers).not.toHaveProperty('Authorization');
  });

  it('sends actual reference bytes through multipart edits and lets fetch set the boundary', async () => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage(provider, settings, '保持人物外貌，换为蓝衣', undefined, reference);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/images/edits?tenant=book');
    expect(init!.headers).not.toHaveProperty('Content-Type');
    const form = init!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(Object.fromEntries([...form].filter(([key]) => key !== 'image'))).toEqual({ model: 'gpt-image-1', prompt: '保持人物外貌，换为蓝衣', n: '1', size: '1024x1536', quality: 'high' });
    const file = form.get('image') as File;
    expect(file.name).toBe('reference.png');
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(png);
  });

  it.each([
    ['1024x1024', '1:1'], ['1024x1536', '2:3'], ['1536x1024', '3:2'],
  ] as const)('generates Gemini with %s aspect ratio %s', async (size, aspectRatio) => {
    const fetchMock = mockFetch(geminiResponse());
    expect(await generateImage(provider, { ...settings, model: 'models/gemini-2.5-flash-image', protocol: 'gemini', size }, '绘制故事场景')).toEqual(reference);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://images.example/prefix/v1/models/gemini-2.5-flash-image:generateContent?tenant=book');
    expect(init!.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'x-goog-api-key': secret });
    expect(JSON.parse(init!.body as string)).toEqual({ contents: [{ role: 'user', parts: [{ text: '绘制故事场景' }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } } });
  });

  it('edits Gemini by sending reference inlineData with the new instruction', async () => {
    const fetchMock = mockFetch(geminiResponse());
    await generateImage(provider, { ...settings, protocol: 'gemini', model: 'gemini-2.5-flash-image' }, '把背景改为海边', undefined, reference);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).contents[0].parts).toEqual([{ text: '把背景改为海边' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }]);
  });

  it.each([
    [Buffer.from([255, 216, 255, 224, 255, 217]), 'image/jpeg'],
    [Buffer.from('524946460400000057454250', 'hex'), 'image/webp'],
  ] as const)('detects image MIME from signature %#', async (bytes, mimeType) => {
    mockFetch(json({ data: [{ b64_json: bytes.toString('base64') }] }));
    expect(await generateImage(provider, settings, '场景')).toEqual({ bytes, mimeType });
  });

  it('serializes JSON generations and multipart edits over a local HTTP service', async () => {
    const requests: { path: string; authorization?: string; type?: string; bytes: Buffer }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ path: request.url!, authorization: request.headers.authorization, type: request.headers['content-type'], bytes: Buffer.concat(chunks) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const localProvider = { ...provider, baseUrl: `http://127.0.0.1:${port}/v1` };
    await generateImage(localProvider, settings, '绘制立绘');
    await generateImage(localProvider, settings, '换装', undefined, reference);
    expect(requests.map(item => item.path)).toEqual(['/v1/images/generations', '/v1/images/edits']);
    expect(JSON.parse(requests[0].bytes.toString('utf8')).prompt).toBe('绘制立绘');
    expect(requests[1].type).toMatch(/^multipart\/form-data; boundary=/);
    expect(requests[1].bytes.includes(png)).toBe(true);
    expect(requests[1].bytes.toString('utf8')).toContain('filename="reference.png"');
    expect(requests.every(item => item.authorization === `Bearer ${secret}`)).toBe(true);
  });
});

describe('image provider validation, bounds and cancellation', () => {
  it.each(['', '%%%%', 'data:image/png;base64,AAAA', 'iVBORw0KGgo', 'iVBORw0KGgo===', 'iVBORw0KGgp='])('rejects non-canonical or invalid image base64 %s', async b64_json => {
    const fetchMock = mockFetch(json({ data: [{ b64_json }] }));
    await expect(generateImage(provider, settings, '场景')).rejects.toThrow('有效的 PNG');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks Gemini MIME against actual bytes and ignores thought images', async () => {
    mockFetch(geminiResponse({ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: png.toString('base64') } }] } }));
    await expect(generateImage(provider, { ...settings, protocol: 'gemini' }, '场景')).rejects.toThrow('有效的 PNG');
    mockFetch(geminiResponse({ content: { parts: [{ thought: true, inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }));
    await expect(generateImage(provider, { ...settings, protocol: 'gemini' }, '场景')).rejects.toThrow('文字或空内容');
  });

  it('rejects URL-only results without fetching any vendor-controlled URL', async () => {
    const fetchMock = mockFetch(json({ data: [{ url: `http://127.0.0.1/admin?key=${secret}` }] }));
    const error = await generateImage(provider, settings, '场景').catch(error => error);
    expect(error.message).toContain('支持 b64_json');
    expect(error.message).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enforces decoded image size even when encoded data fits the base64 character budget', async () => {
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    png.copy(bytes);
    mockFetch(json({ data: [{ b64_json: bytes.toString('base64') }] }));
    await expect(generateImage(provider, settings, '场景')).rejects.toThrow('超过 20 MiB');
  });

  it('rejects an oversized declared response before reading its body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': '50000000' } });
    mockFetch(response);
    await expect(generateImage(provider, settings, '场景')).rejects.toThrow('响应过大');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('counts streamed response bytes without trusting content-length', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    mockFetch(new Response(new ReadableStream({ pull(controller) { controller.enqueue(chunk); }, cancel })));
    await expect(generateImage(provider, settings, '场景')).rejects.toThrow('响应过大');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404, 429, 500])('reports HTTP %s safely without retrying paid requests', async status => {
    const fetchMock = mockFetch(json({ error: { message: secret, apiKey: secret } }, status));
    const error = await generateImage(provider, settings, '场景').catch(error => error);
    expect(error).toBeInstanceOf(ImageProviderError);
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: { message: secret } },
    { candidates: [{ finishReason: 'IMAGE_SAFETY' }] },
    { candidates: [{ finishReason: 'MAX_TOKENS' }] },
    { promptFeedback: { blockReason: 'SAFETY', message: secret } },
    { candidates: [{ content: { parts: [{ text: secret }] } }] },
  ])('rejects Gemini error, block, partial or text-only results without leaking payload %#', async body => {
    mockFetch(json(body));
    const error = await generateImage(provider, { ...settings, protocol: 'gemini' }, '场景').catch(error => error);
    expect(error).toBeInstanceOf(ImageProviderError);
    expect(error.message).not.toContain(secret);
  });

  it('redacts transport exceptions by returning a static error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(`network error for ${secret}`));
    vi.stubGlobal('fetch', fetchMock);
    const error = await generateImage(provider, settings, '场景').catch(error => error);
    expect(error.message).toContain('无法连接或读取');
    expect(error.message).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['not-a-url', 'ftp://images.example', 'https://user:pass@images.example'])('rejects invalid or credential-bearing endpoints before sending %s', async baseUrl => {
    const fetchMock = mockFetch();
    await expect(generateImage({ ...provider, baseUrl }, settings, '场景')).rejects.toThrow('服务地址');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks prompt, model settings and references before sending', async () => {
    const fetchMock = mockFetch();
    await expect(generateImage(provider, settings, '   ')).rejects.toThrow('不能为空');
    await expect(generateImage(provider, { ...settings, timeoutMs: 0 }, '场景')).rejects.toThrow('超时必须');
    await expect(generateImage(provider, { ...settings, model: '' }, '场景')).rejects.toThrow('模型名称');
    await expect(generateImage(provider, settings, '场景', undefined, { ...reference, mimeType: 'image/webp' })).rejects.toThrow('内容与格式不一致');
    await expect(generateImage(provider, settings, '场景', undefined, { ...reference, bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) })).rejects.toThrow('不超过 20 MiB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send a request when already cancelled', async () => {
    const fetchMock = mockFetch();
    const controller = new AbortController(); controller.abort();
    await expect(generateImage(provider, settings, '场景', controller.signal)).rejects.toThrow('已取消');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards caller cancellation during an in-flight request without retry', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error(secret)), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const request = generateImage(provider, settings, '场景', controller.signal);
    controller.abort();
    await expect(request).rejects.toThrow('已取消');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a slow vendor at the configured timeout and never retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error(secret)), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const request = generateImage(provider, { ...settings, timeoutMs: 1000 }, '场景');
    const assertion = expect(request).rejects.toThrow('超时（1 秒）');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels while consuming the response stream', async () => {
    const caller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        init!.signal!.addEventListener('abort', () => controller.error(new Error(secret)), { once: true });
      },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const request = generateImage(provider, settings, '场景', caller.signal);
    await Promise.resolve(); await Promise.resolve();
    caller.abort();
    await expect(request).rejects.toThrow('已取消');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('image model controls and multiple references', () => {
  it('preserves legacy DALL-E 3 size and quality wire fields for compatible gateways', async () => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage(provider, { ...settings, model: 'dall-e-3', size: '1792x1024', quality: 'hd' }, '场景');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ model: 'dall-e-3', prompt: '场景', size: '1792x1024', quality: 'hd', n: 1, response_format: 'b64_json' });
    await expect(generateImage(provider, { ...settings, model: 'dall-e-3', quality: 'standard' }, '场景')).rejects.toThrow('不支持该图片尺寸');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps DALL-E 2 legacy square sizes without inventing a quality parameter', async () => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage(provider, { ...settings, model: 'dall-e-2', size: '512x512', quality: 'auto' }, '头像');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ model: 'dall-e-2', prompt: '头像', size: '512x512', n: 1, response_format: 'b64_json' });
  });

  it('sends OpenAI output controls and preserves zero compression values', async () => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage(provider, { ...settings, size: 'auto', outputFormat: 'webp', outputCompression: 0, background: 'transparent', moderation: 'low', inputFidelity: 'high' }, '角色全身立绘');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ model: 'gpt-image-1', prompt: '角色全身立绘', n: 1, size: 'auto', quality: 'high', output_format: 'webp', output_compression: 0, background: 'transparent', moderation: 'low' });
  });

  it('allows current GPT Image 2 preview transparency only with a compatible output format', async () => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage(provider, { ...settings, model: 'gpt-image-2', background: 'transparent', outputFormat: 'png' }, '透明立绘');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ background: 'transparent', output_format: 'png' });
    await expect(generateImage(provider, { ...settings, model: 'gpt-image-2', background: 'transparent', outputFormat: 'jpeg' }, '透明立绘')).rejects.toThrow('透明背景必须');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends multiple OpenAI portraits as multipart image[] in their original order', async () => {
    const fetchMock = mockFetch(imageResponse());
    const jpeg = { bytes: Buffer.from([255, 216, 255, 224, 255, 217]), mimeType: 'image/jpeg' as const };
    await generateImage(provider, { ...settings, inputFidelity: 'high', outputFormat: 'png' }, '图一人物与图二人物对话', undefined, [reference, jpeg]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/images/edits');
    const form = fetchMock.mock.calls[0][1]!.body as FormData;
    expect(form.get('input_fidelity')).toBe('high');
    expect(form.get('output_format')).toBe('png');
    const files = form.getAll('image[]') as File[];
    expect(files.map(file => file.name)).toEqual(['reference-1.png', 'reference-2.jpg']);
    expect(await Promise.all(files.map(async file => Buffer.from(await file.arrayBuffer())))).toEqual([png, jpeg.bytes]);
  });

  it.each(['1536x864', '2048x1024', '3840x2160'])('accepts custom GPT Image 2 dimensions %s', async size => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage(provider, { ...settings, model: 'gpt-image-2', size }, '宽屏场景');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).size).toBe(size);
  });

  it.each(['1537x864', '3856x1024', '1024x256', '640x640', '3840x3840'])('rejects unsupported GPT Image 2 dimensions %s before a billable request', async size => {
    const fetchMock = mockFetch();
    await expect(generateImage(provider, { ...settings, model: 'gpt-image-2', size }, '场景')).rejects.toThrow('图片宽高');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send GPT Image 2 input_fidelity or unsupported Mini high fidelity', async () => {
    const fetchMock = mockFetch();
    await expect(generateImage(provider, { ...settings, model: 'gpt-image-2', inputFidelity: 'high' }, '场景', undefined, reference)).rejects.toThrow('参考保真度');
    await expect(generateImage(provider, { ...settings, model: 'gpt-image-1-mini', inputFidelity: 'high' }, '场景', undefined, reference)).rejects.toThrow('参考保真度');
    await expect(generateImage(provider, { ...settings, size: '1536x864' }, '场景')).rejects.toThrow('不支持该图片尺寸');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['xhigh', 'max'] as const)('sends newer OpenAI quality %s only for the supported model family', async quality => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage(provider, { ...settings, model: 'gpt-image-2.5-sunburst', quality }, '精细立绘');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).quality).toBe(quality);
    await expect(generateImage(provider, { ...settings, quality }, '精细立绘')).rejects.toThrow('不支持该图片质量');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends native Nano Banana 2 thinking, resolution, sampling, system instruction and multiple references', async () => {
    const fetchMock = mockFetch(geminiResponse());
    await generateImage(provider, { ...settings, model: 'gemini-3.1-flash-image-preview', protocol: 'gemini', size: 'auto', aspectRatio: '16:9', imageSize: '2K', thinkingLevel: 'high', includeThoughts: false, systemInstruction: '保持作品画风', temperature: 0, topP: 0.9, topK: 32, seed: 0, maxOutputTokens: 32768 }, '两位角色在山顶对话', undefined, [reference, reference]);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({
      contents: [{ role: 'user', parts: [{ text: '两位角色在山顶对话' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] }],
      systemInstruction: { parts: [{ text: '保持作品画风' }] },
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' }, thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: false }, temperature: 0, topP: 0.9, topK: 32, seed: 0, maxOutputTokens: 32768 },
    });
  });

  it('honors Nano Banana 2 minimal thinking and 512 output while skipping thought images', async () => {
    const thoughtBytes = Buffer.from([255, 216, 255, 224, 255, 217]);
    const fetchMock = mockFetch(geminiResponse({ content: { parts: [{ thought: true, inlineData: { mimeType: 'image/jpeg', data: thoughtBytes.toString('base64') } }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }));
    const result = await generateImage(provider, { ...settings, protocol: 'gemini', model: 'gemini-3.1-flash-image', thinkingLevel: 'minimal', includeThoughts: true, imageSize: '512' }, '立绘');
    expect(result).toEqual(reference);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL', includeThoughts: true });
  });

  it('uses the native Gemini JPEG response format enum and keeps the response inline', async () => {
    const bytes = Buffer.from([255, 216, 255, 224, 255, 217]);
    const fetchMock = mockFetch(geminiResponse({ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: bytes.toString('base64') } }] } }));
    expect(await generateImage(provider, { ...settings, protocol: 'gemini', model: 'gemini-3.1-flash-image', outputFormat: 'jpeg' }, '场景')).toEqual({ bytes, mimeType: 'image/jpeg' });
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).generationConfig.responseFormat).toEqual({ image: { mimeType: 'IMAGE_JPEG', delivery: 'INLINE' } });
  });

  it('rejects wrong Gemini model-specific thinking and resolution controls', async () => {
    const fetchMock = mockFetch();
    await expect(generateImage(provider, { ...settings, protocol: 'gemini', model: 'gemini-3-pro-image', thinkingLevel: 'low' }, '场景')).rejects.toThrow('思考等级');
    await expect(generateImage(provider, { ...settings, protocol: 'gemini', model: 'gemini-3-pro-image', imageSize: '512' }, '场景')).rejects.toThrow('输出分辨率');
    await expect(generateImage(provider, { ...settings, protocol: 'gemini', model: 'gemini-2.5-flash-image', thinkingLevel: 'high' }, '场景')).rejects.toThrow('思考等级');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks reference counts and their combined byte budget before sending', async () => {
    const fetchMock = mockFetch();
    await expect(generateImage(provider, { ...settings, protocol: 'gemini', model: 'gemini-2.5-flash-image' }, '场景', undefined, Array(4).fill(reference))).rejects.toThrow('此数量的参考图片');
    await expect(generateImage(provider, { ...settings, protocol: 'gemini', model: 'gemini-3.1-flash-image' }, '场景', undefined, Array(15).fill(reference))).rejects.toThrow('此数量的参考图片');
    const bytes = Buffer.alloc(11 * 1024 * 1024); png.copy(bytes);
    await expect(generateImage(provider, settings, '场景', undefined, [{ bytes, mimeType: 'image/png' }, { bytes, mimeType: 'image/png' }])).rejects.toThrow('合计不超过 20 MiB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts Gemini base64 encoding and prompts within the total 20 MB inline request limit', async () => {
    const fetchMock = mockFetch();
    const bytes = Buffer.alloc(16 * 1024 * 1024); png.copy(bytes);
    await expect(generateImage(provider, { ...settings, protocol: 'gemini', model: 'gemini-3.1-flash-image' }, '场景', undefined, { bytes, mimeType: 'image/png' })).rejects.toThrow('合计超过 20 MB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses Together base64 response and multi-reference fields with model-specific generation controls', async () => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage(provider, { ...settings, protocol: 'together-images', model: 'black-forest-labs/FLUX.2-dev', size: 'auto', width: 1344, height: 768, steps: 28, guidanceScale: 3.5, seed: 0, outputFormat: 'png', disableSafetyChecker: false }, '双人对话', undefined, [reference, reference]);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://images.example/prefix/v1/images/generations?tenant=book');
    expect(fetchMock.mock.calls[0][1]!.headers).toMatchObject({ Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ model: 'black-forest-labs/FLUX.2-dev', prompt: '双人对话', n: 1, response_format: 'base64', width: 1344, height: 768, steps: 28, guidance_scale: 3.5, seed: 0, output_format: 'png', disable_safety_checker: false, reference_images: [`data:image/png;base64,${png.toString('base64')}`, `data:image/png;base64,${png.toString('base64')}`] });
  });

  it('uses Together Kontext single image_url and aspect_ratio on the generations endpoint', async () => {
    const fetchMock = mockFetch(imageResponse());
    const config: ImageSettings = { ...settings, protocol: 'together-images', model: 'black-forest-labs/FLUX.1-kontext-pro', aspectRatio: '16:9', steps: 28 };
    await generateImage(provider, config, '保留人物，换背景', undefined, reference);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ model: config.model, prompt: '保留人物，换背景', n: 1, response_format: 'base64', aspect_ratio: '16:9', steps: 28, image_url: `data:image/png;base64,${png.toString('base64')}` });
    await expect(generateImage(provider, config, '多人场景', undefined, [reference, reference])).rejects.toThrow('此数量的参考图片');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the documented Together Nano Banana 2 model ID and reference_images format', async () => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage(provider, { ...settings, protocol: 'together-images', model: 'google/flash-image-3.1' }, '保留两位人物的外貌', undefined, [reference, reference]);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ model: 'google/flash-image-3.1', width: 1024, height: 1536, reference_images: [`data:image/png;base64,${png.toString('base64')}`, `data:image/png;base64,${png.toString('base64')}`], response_format: 'base64' });
  });

  it('keeps Together Pro prompt upsampling separate from Dev and rejects unsupported fields rather than dropping them', async () => {
    const fetchMock = mockFetch(imageResponse());
    const config: ImageSettings = { ...settings, protocol: 'together-images', model: 'black-forest-labs/FLUX.2-pro', promptUpsampling: true };
    await generateImage(provider, config, '城市俯瞰图');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).prompt_upsampling).toBe(true);
    await expect(generateImage(provider, { ...config, steps: 20 }, '城市')).rejects.toThrow('生成步数');
    await expect(generateImage(provider, { ...config, guidanceScale: 3.5 }, '城市')).rejects.toThrow('提示遵循度');
    await expect(generateImage(provider, { ...config, negativePrompt: '模糊' }, '城市')).rejects.toThrow('负向提示词');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends negative prompts only to supported Together models', async () => {
    const fetchMock = mockFetch(imageResponse());
    await generateImage(provider, { ...settings, protocol: 'together-images', model: 'black-forest-labs/FLUX.1-schnell', negativePrompt: 'blurry, distorted', steps: 4 }, '场景');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ negative_prompt: 'blurry, distorted', steps: 4, width: 1024, height: 1536 });
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).not.toHaveProperty('quality');
  });

  it('allows basic custom Together generations but never guesses unknown reference-image support', async () => {
    const fetchMock = mockFetch(imageResponse());
    const config: ImageSettings = { ...settings, protocol: 'together-images', model: 'custom-vendor-image' };
    await generateImage(provider, config, '场景');
    await expect(generateImage(provider, config, '修改', undefined, reference)).rejects.toThrow('不支持此数量的参考图片');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { protocol: 'openai-images', outputFormat: 'jpeg', background: 'transparent' },
    { protocol: 'openai-images', outputFormat: 'png', outputCompression: 50 },
    { protocol: 'gemini', searchGrounding: true },
    { protocol: 'together-images', model: 'black-forest-labs/FLUX.2-dev', width: 1025, height: 1024 },
    { protocol: 'together-images', model: 'black-forest-labs/FLUX.2-dev', outputFormat: 'webp' },
  ] as const)('rejects conflicting or unsupported image controls before sending %#', async patch => {
    const fetchMock = mockFetch();
    await expect(generateImage(provider, { ...settings, ...patch }, '场景')).rejects.toBeInstanceOf(ImageProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
