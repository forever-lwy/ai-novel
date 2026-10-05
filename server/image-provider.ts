import type { ImageSettings, ProviderConnection } from '../shared/types.js';
import { imageModelCapabilities, type ImageModelCapabilities } from '../shared/image-capabilities.js';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024;
type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
export interface GeneratedImage { bytes: Uint8Array; mimeType: ImageMime }

export class ImageProviderError extends Error {
  constructor(message: string, readonly statusCode = 502) { super(message); this.name = 'ImageProviderError'; }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalidImage = () => new ImageProviderError('生图服务未返回有效的 PNG、JPEG 或 WebP 图片。');

/** Check bytes rather than trusting the vendor's content type or file extension. */
function imageMime(bytes: Uint8Array): ImageMime {
  if (bytes.length >= 8 && bytes.subarray(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  throw invalidImage();
}

function decodeImage(value: unknown, declaredMime?: unknown): GeneratedImage {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    if (typeof value === 'string' && value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new ImageProviderError('生成图片超过 20 MiB，请降低图片尺寸或质量后手动重试。');
    throw invalidImage();
  }
  // Node's decoder accepts junk and truncation. Require canonical base64 first.
  const padding = value.indexOf('=');
  if (value.length % 4 || /[^A-Za-z0-9+/]/.test(padding < 0 ? value : value.slice(0, padding)) || padding >= 0 && !/^={1,2}$/.test(value.slice(padding))) throw invalidImage();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageProviderError('生成图片超过 20 MiB，请降低图片尺寸或质量后手动重试。');
  if (bytes.toString('base64') !== value) throw invalidImage();
  const mimeType = imageMime(bytes);
  if (declaredMime !== undefined && declaredMime !== mimeType) throw invalidImage();
  return { bytes, mimeType };
}

function endpoint(provider: ProviderConnection, suffix: string): URL {
  let url: URL;
  try { url = new URL(provider.baseUrl); } catch { throw new ImageProviderError('生图服务地址无效，请填写完整的 HTTP 或 HTTPS 地址。', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ImageProviderError('生图服务地址仅支持 HTTP/HTTPS，且不能包含用户名或密码。', 400);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix}`;
  url.hash = '';
  return url;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImageProviderError('生图服务响应过大，请降低图片尺寸或质量后手动重试。');
  }
  if (!response.body) throw invalidImage();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ImageProviderError('生图服务响应过大，请降低图片尺寸或质量后手动重试。');
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); } catch { throw new ImageProviderError('生图服务返回的不是有效 JSON，请检查接口协议。'); }
  if (!object(data)) throw invalidImage();
  return data;
}

function result(protocol: ImageSettings['protocol'], data: Record<string, unknown>): GeneratedImage {
  if (data.error !== undefined) throw new ImageProviderError('生图服务未能完成本次请求，请检查模型与服务后手动重试。');
  if (protocol === 'openai-images' || protocol === 'together-images') {
    const first: unknown = Array.isArray(data.data) ? data.data[0] : undefined;
    if (object(first) && typeof first.b64_json === 'string') return decodeImage(first.b64_json);
    // Vendor-controlled URLs would require a separate SSRF-safe download boundary.
    if (object(first) && first.url !== undefined) throw new ImageProviderError('生图服务只返回了图片网址；请使用支持 b64_json 图片返回的模型或网关。');
    throw invalidImage();
  }
  const candidate: unknown = Array.isArray(data.candidates) ? data.candidates[0] : undefined;
  if (object(data.promptFeedback) && data.promptFeedback.blockReason) throw new ImageProviderError('生图服务拦截了本次请求，未生成图片。');
  if (!object(candidate) || candidate.finishReason && candidate.finishReason !== 'STOP') throw new ImageProviderError('生图服务未完成本次图片请求，可能被拦截或达到输出上限。');
  const content = candidate.content;
  const parts = object(content) && Array.isArray(content.parts) ? content.parts : [];
  for (const part of parts) {
    if (object(part) && !part.thought && object(part.inlineData)) return decodeImage(part.inlineData.data, part.inlineData.mimeType);
  }
  throw new ImageProviderError('生图模型只返回了文字或空内容，请选择支持图片输出的 Gemini 模型。');
}

const optionalParameters: (keyof ImageSettings)[] = ['aspectRatio', 'imageSize', 'systemInstruction', 'temperature', 'topP', 'topK', 'seed', 'maxOutputTokens', 'thinkingLevel', 'includeThoughts', 'outputFormat', 'outputCompression', 'background', 'inputFidelity', 'moderation', 'negativePrompt', 'steps', 'guidanceScale', 'width', 'height', 'promptUpsampling', 'disableSafetyChecker'];
const parameterNames: Partial<Record<keyof ImageSettings, string>> = { imageSize: '分辨率', systemInstruction: '系统提示', temperature: '温度', topP: 'Top P', topK: 'Top K', seed: '随机种子', maxOutputTokens: '输出上限', thinkingLevel: '思考等级', includeThoughts: '返回思考过程', outputFormat: '输出格式', outputCompression: '图片压缩', background: '背景', inputFidelity: '参考保真度', moderation: '内容过滤', negativePrompt: '负向提示词', steps: '生成步数', guidanceScale: '提示遵循度', promptUpsampling: '提示词扩展', disableSafetyChecker: '安全检查设置' };
const ratioForSize = (size: string) => ({ '1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2' }[size]);

function dimensions(size: string): [number, number] | undefined {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}
function validateDimensions(width: number, height: number, caps: ImageModelCapabilities) {
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < caps.minDimension || height < caps.minDimension || width > caps.maxDimension || height > caps.maxDimension || width % caps.dimensionMultiple || height % caps.dimensionMultiple || caps.minPixels !== undefined && pixels < caps.minPixels || caps.maxPixels !== undefined && pixels > caps.maxPixels || caps.maxAspectRatio !== undefined && Math.max(width / height, height / width) > caps.maxAspectRatio) {
    throw new ImageProviderError('图片宽高超出当前模型支持的范围，请检查尺寸、像素总数和宽高比例。', 400);
  }
}

export function validateImageParameters(config: ImageSettings): ImageModelCapabilities {
  const caps = imageModelCapabilities(config);
  if (config.searchGrounding) throw new ImageProviderError('当前生图流程尚未接入搜索素材与来源展示，请关闭搜索后再生成。', 400);
  for (const name of optionalParameters) {
    const value = config[name];
    const automaticDimension = value === 'auto' && (name === 'aspectRatio' || name === 'imageSize');
    if (value !== undefined && value !== '' && value !== false && !automaticDimension && !caps.supportedParams.includes(name)) throw new ImageProviderError(`当前模型不支持${parameterNames[name] ?? name}参数，请清除此项或更换模型。`, 400);
  }
  if (config.size !== 'auto') {
    const size = dimensions(config.size); if (!size) throw new ImageProviderError('生图尺寸必须是 auto 或合法的宽x高。', 400);
    if (!caps.sizes.includes(config.size) && !caps.customSize) throw new ImageProviderError('当前模型不支持该图片尺寸，请选择已有尺寸或自动决定。', 400);
    if (caps.customSize) validateDimensions(...size, caps);
  }
  if (config.protocol === 'openai-images' && !caps.qualityOptions.includes(config.quality)) throw new ImageProviderError('当前模型不支持该图片质量，请重新选择。', 400);
  if (config.aspectRatio && config.aspectRatio !== 'auto' && !caps.aspectRatios.includes(config.aspectRatio)) throw new ImageProviderError('当前模型不支持该宽高比例。', 400);
  if (config.imageSize && config.imageSize !== 'auto' && !caps.imageSizes.includes(config.imageSize)) throw new ImageProviderError('当前模型不支持该输出分辨率。', 400);
  if (config.thinkingLevel && !caps.thinkingLevels.includes(config.thinkingLevel)) throw new ImageProviderError('当前生图模型不支持该思考等级。', 400);
  if (config.outputFormat && !caps.outputFormats.includes(config.outputFormat)) throw new ImageProviderError('当前模型不支持该输出格式。', 400);
  if (config.background && !caps.backgroundOptions.includes(config.background)) throw new ImageProviderError('当前模型不支持该背景选项。', 400);
  if (config.inputFidelity && !caps.inputFidelities.includes(config.inputFidelity)) throw new ImageProviderError('当前模型不支持该参考保真度。', 400);
  if (config.outputCompression !== undefined && !['jpeg', 'webp'].includes(config.outputFormat ?? 'png')) throw new ImageProviderError('图片压缩仅适用于 JPEG 或 WebP 输出。', 400);
  if (config.background === 'transparent' && config.outputFormat === 'jpeg') throw new ImageProviderError('透明背景必须使用 PNG 或 WebP 输出。', 400);
  const ranges: [keyof ImageSettings, number, number, boolean][] = [['temperature', 0, 2, false], ['topP', 0, 1, false], ['topK', 1, 1000000, true], ['seed', -2147483648, 4294967295, true], ['maxOutputTokens', 1, 32768, true], ['outputCompression', 0, 100, true], ['steps', 1, 100, true], ['guidanceScale', 0, 20, false]];
  for (const [name, minimum, maximum, integer] of ranges) {
    const value = config[name];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || integer && !Number.isSafeInteger(value))) throw new ImageProviderError(`${parameterNames[name] ?? name}超出允许范围。`, 400);
  }
  if ((config.width === undefined) !== (config.height === undefined)) throw new ImageProviderError('图片宽度与高度必须同时填写。', 400);
  if (config.width !== undefined && config.height !== undefined) validateDimensions(config.width, config.height, caps);
  if (config.systemInstruction && config.systemInstruction.length > 32000 || config.negativePrompt && config.negativePrompt.length > 32000) throw new ImageProviderError('生图系统提示或负向提示词过长，请缩短后再生成。', 400);
  return caps;
}

/** One billable request; generation and edits are never retried automatically. */
export async function generateImage(provider: ProviderConnection, config: ImageSettings, prompt: string, signal?: AbortSignal, reference?: GeneratedImage | GeneratedImage[]): Promise<GeneratedImage> {
  if (!['openai-images', 'gemini', 'together-images'].includes(config.protocol)) throw new ImageProviderError('生图接口协议无效。', 400);
  if (!config.model?.trim() || /[\u0000-\u001f\u007f]/.test(config.model)) throw new ImageProviderError('请填写有效的生图模型名称。', 400);
  if (!prompt.trim()) throw new ImageProviderError('生图描述不能为空。', 400);
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 3_600_000) throw new ImageProviderError('生图超时必须是 1000 至 3600000 毫秒的整数。', 400);
  if (signal?.aborted) throw new ImageProviderError('生图请求已取消。', 499);
  const caps = validateImageParameters(config);
  if (config.protocol === 'openai-images' && prompt.length > 32000) throw new ImageProviderError('OpenAI 生图提示词不能超过 32000 字符，请精简素材。', 400);
  const references = reference ? Array.isArray(reference) ? reference : [reference] : [];
  if (references.length > caps.maxReferences || references.length && caps.referenceMode === 'none') throw new ImageProviderError('当前模型不支持此数量的参考图片，请减少参考图或选择支持多图输入的模型。', 400);
  let referenceBytes = 0;
  for (const item of references) {
    referenceBytes += item.bytes.byteLength;
    if (!item.bytes.byteLength || item.bytes.byteLength > MAX_IMAGE_BYTES || referenceBytes > MAX_IMAGE_BYTES) throw new ImageProviderError('参考图片必须大于 0，全部参考图合计不超过 20 MiB。', 400);
    if (imageMime(item.bytes) !== item.mimeType) throw new ImageProviderError('参考图片内容与格式不一致。', 400);
    if (config.protocol === 'openai-images' && config.model.trim().toLowerCase() === 'dall-e-2' && (item.mimeType !== 'image/png' || item.bytes.byteLength >= 4 * 1024 * 1024 || item.bytes.byteLength < 24 || Buffer.from(item.bytes).readUInt32BE(16) !== Buffer.from(item.bytes).readUInt32BE(20))) throw new ImageProviderError('DALL-E 2 参考图片须为小于 4 MiB 的正方形 PNG。', 400);
  }
  const model = config.model.trim();
  const suffix = config.protocol === 'gemini' ? `models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent` : `images/${config.protocol === 'openai-images' && references.length ? 'edits' : 'generations'}`;
  const url = endpoint(provider, suffix);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = provider.apiKey?.trim();
  if (key) headers[config.protocol === 'gemini' ? 'x-goog-api-key' : 'Authorization'] = config.protocol === 'gemini' ? key : `Bearer ${key}`;
  let body: string | FormData;
  if (config.protocol === 'gemini') {
    const parts: unknown[] = [{ text: prompt }];
    for (const item of references) parts.push({ inlineData: { mimeType: item.mimeType, data: Buffer.from(item.bytes).toString('base64') } });
    const aspectRatio = config.aspectRatio && config.aspectRatio !== 'auto' ? config.aspectRatio : ratioForSize(config.size);
    const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'], ...(aspectRatio || config.imageSize && config.imageSize !== 'auto' ? { imageConfig: { ...(aspectRatio ? { aspectRatio } : {}), ...(config.imageSize && config.imageSize !== 'auto' ? { imageSize: config.imageSize } : {}) } } : {}) };
    for (const name of ['temperature', 'topP', 'topK', 'seed', 'maxOutputTokens'] as const) if (config[name] !== undefined) generationConfig[name] = config[name];
    if (config.thinkingLevel || config.includeThoughts !== undefined && caps.supportedParams.includes('includeThoughts')) generationConfig.thinkingConfig = { ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel.toUpperCase() } : {}), ...(config.includeThoughts !== undefined ? { includeThoughts: config.includeThoughts } : {}) };
    if (config.outputFormat === 'jpeg') generationConfig.responseFormat = { image: { mimeType: 'IMAGE_JPEG', delivery: 'INLINE' } };
    body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig, ...(config.systemInstruction?.trim() ? { systemInstruction: { parts: [{ text: config.systemInstruction.trim() }] } } : {}) });
    // Gemini's inline limit applies to the whole encoded request, not just the
    // decoded reference files. Do not upload private files as an implicit fallback.
    if (Buffer.byteLength(body) > 20_000_000) throw new ImageProviderError('Gemini 内联参考图与提示词合计超过 20 MB，请减少参考图或使用更小的图片。', 400);
    headers['Content-Type'] = 'application/json';
  } else if (config.protocol === 'together-images') {
    const fields: Record<string, unknown> = { model, prompt, n: 1, response_format: 'base64' };
    if (caps.dimensionMode === 'aspect-ratio') {
      const ratio = config.aspectRatio && config.aspectRatio !== 'auto' ? config.aspectRatio : ratioForSize(config.size);
      if (ratio) fields.aspect_ratio = ratio;
    } else {
      const size = config.size !== 'auto' ? dimensions(config.size) : undefined;
      if (config.width !== undefined) { fields.width = config.width; fields.height = config.height; }
      else if (size) { fields.width = size[0]; fields.height = size[1]; }
    }
    const mapping = { seed: 'seed', outputFormat: 'output_format', steps: 'steps', guidanceScale: 'guidance_scale', negativePrompt: 'negative_prompt', promptUpsampling: 'prompt_upsampling', disableSafetyChecker: 'disable_safety_checker' } as const;
    for (const [name, wire] of Object.entries(mapping)) if (config[name as keyof typeof mapping] !== undefined && caps.supportedParams.includes(name as keyof ImageSettings)) fields[wire] = config[name as keyof typeof mapping];
    if (references.length) {
      const urls = references.map(item => `data:${item.mimeType};base64,${Buffer.from(item.bytes).toString('base64')}`);
      if (caps.referenceField === 'image_url') fields.image_url = urls[0];
      else fields.reference_images = urls;
    }
    body = JSON.stringify(fields); headers['Content-Type'] = 'application/json';
  } else {
    const fields: Record<string, string | number> = { model, prompt, n: 1, size: config.size };
    // GPT Image returns base64 by default and does not accept response_format.
    if (!/^dall-e-[23]$/i.test(model)) fields.quality = config.quality;
    else if (model.toLowerCase() === 'dall-e-3' && config.quality !== 'auto') fields.quality = config.quality;
    if (/^dall-e-[23]$/i.test(model) && config.size === 'auto') delete fields.size;
    if (!/^gpt-image(?:-|$)/i.test(model) && model !== 'chatgpt-image-latest') fields.response_format = 'b64_json';
    const mapping = { background: 'background', outputFormat: 'output_format', outputCompression: 'output_compression', moderation: 'moderation', inputFidelity: 'input_fidelity' } as const;
    for (const [name, wire] of Object.entries(mapping)) if (config[name as keyof typeof mapping] !== undefined && (name !== 'inputFidelity' || references.length)) fields[wire] = config[name as keyof typeof mapping]!;
    if (references.length) {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.set(name, String(value));
      references.forEach((item, index) => {
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[item.mimeType];
        form.append(references.length === 1 ? 'image' : 'image[]', new Blob([new Uint8Array(item.bytes)], { type: item.mimeType }), references.length === 1 ? `reference.${extension}` : `reference-${index + 1}.${extension}`);
      });
      body = form;
    } else { body = JSON.stringify(fields); headers['Content-Type'] = 'application/json'; }
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
  timer.unref?.();
  try {
    if (signal?.aborted) controller.abort();
    // Prevent credentials being forwarded even by same-origin redirects.
    const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const hint = response.status === 401 || response.status === 403 ? '请检查密钥及生图模型权限。' : response.status === 429 ? '额度不足或请求过于频繁，请稍后手动重试。' : response.status === 404 ? '请检查 API 前缀、协议与模型名称。' : '请检查生图服务后手动重试。';
      throw new ImageProviderError(`生图服务请求失败（HTTP ${response.status}）。${hint}`);
    }
    const data = await readJson(response);
    if (signal?.aborted) throw new ImageProviderError('生图请求已取消。', 499);
    if (timedOut) throw new ImageProviderError(`生图请求超时（${config.timeoutMs / 1000} 秒），请检查服务后手动重试。`, 504);
    return result(config.protocol, data);
  } catch (error) {
    if (signal?.aborted) throw new ImageProviderError('生图请求已取消。', 499);
    if (timedOut) throw new ImageProviderError(`生图请求超时（${config.timeoutMs / 1000} 秒），请检查服务后手动重试。`, 504);
    if (error instanceof ImageProviderError) throw error;
    // Do not surface network exception messages or vendor payloads containing secrets.
    throw new ImageProviderError('无法连接或读取生图服务，请检查服务地址、网络和接口配置。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export type ImageGenerator = typeof generateImage;
