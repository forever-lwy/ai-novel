// Browser acceptance fixture only: all model requests stay on loopback.
// It does not call or validate any real OpenAI/Gemini/Claude service.
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

process.env.NODE_ENV = 'production';
const port = Number(process.env.E2E_PORT || 14328);
const mockPort = Number(process.env.E2E_MODEL_PORT || 4329);
const staticDir = resolve('dist/public');
if (!existsSync(join(staticDir, 'index.html'))) throw new Error('请先 npm run build，再启动浏览器测试。');
const dataDir = mkdtempSync(join(tmpdir(), 'ai-novel-browser-'));

function fixtureReply(system, prompt) {
  if (system.includes('只压缩') && system.includes('剧情摘要')) return JSON.stringify({ text: '林舟调查白石城。' });
  if (system.includes('本片段提要') || system.includes('只做当前编号片段')) {
    const fragment = prompt.split('全文段落编号如下（仅提取本片段）：\n').at(-1) || '';
    const paragraphs = [...fragment.matchAll(/^\[(\d+)\]\s*(.+)$/gm)].map(match => ({ paragraph: Number(match[1]), quote: match[2] }));
    const person = paragraphs.find(p => p.quote.includes('林舟'));
    const place = paragraphs.find(p => p.quote.includes('白石城'));
    const fact = (p, text, attribute) => ({ text, attribute, temporal: 'current', certainty: 'fact', visibility: 'public', ...p });
    return JSON.stringify({
      summary: person ? '林舟来到白石城，继续探索城中的线索。' : '这段故事记录了新的经历。',
      entities: [
        ...(person ? [{ kind: 'character', name: '林舟', nameStatus: 'confirmed', isMain: true, aliases: ['小舟'], description: '来到白石城的旅人。', visibility: 'public', facts: [fact(person, '林舟正在白石城调查。', 'location')] }] : []),
        ...(place ? [{ kind: 'location', name: '白石城', aliases: [], description: '故事中出现的城池。', visibility: 'public', facts: [fact(place, '白石城是本章出现的地点。', 'identity')] }] : []),
      ],
      relations: person && place ? [{ from: '林舟', to: '白石城', label: '身处', visibility: 'public', ...place }] : [],
      foreshadows: [],
    });
  }
  if (system.includes('fine 必须包含')) {
    const next = Number(prompt.match(/请为第\s+(\d+)\s+章至第/)?.[1] || 1);
    return JSON.stringify({
      fine: Array.from({ length: 4 }, (_, index) => ({ chapter: next + index, title: `第${next + index}章 城中线索`, goal: '围绕白石城的线索推进人物行动。' })),
      foreshadows: [{ title: '旧钥匙的主人', detail: 'SECRET_E2E_FORESHADOW：旧钥匙属于失踪的守城人。', status: 'planned', dueChapter: next + 3, revealCondition: '打开钟楼后揭晓', relatedNames: [] }],
    });
  }
  if (prompt.includes('Reply with OK only.')) return 'OK';
  if (prompt.includes('REGEN_BRANCH_ONLY')) return '林舟来到白石城，发现标记为 REGEN_BRANCH_ONLY 的新线索。\n\n他拿起钥匙，走向守城人留下的石阶。';
  return '林舟来到白石城，发现城门下藏着一把旧钥匙。\n\n他拾起钥匙，决定沿着石阶寻找守城人留下的线索。';
}

let modelRequests = 0;
let modelListRequests = 0;
const modelRequestsByModel = {};
let lastModelParameters;
let imageRequests = 0; let imageEditRequests = 0; let lastImageRequest;
let promptOptimizationRequests = 0; let lastPromptOptimizationRequest; let lastOptimizedImagePrompt;
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=';
const modelServer = createServer(async (req, res) => {
  if (req.url === '/__e2e/stats' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ modelRequests, modelListRequests, modelRequestsByModel, lastModelParameters, imageRequests, imageEditRequests, lastImageRequest, promptOptimizationRequests, lastPromptOptimizationRequest, lastOptimizedImagePrompt })); return; }
  if (req.url === '/__e2e/shutdown' && req.method === 'POST') { res.writeHead(200); res.end('stopping test fixture'); setImmediate(() => void close()); return; }
  if (req.method === 'POST' && ['/v1/images/generations', '/v1/images/edits'].includes(req.url)) {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks); const edit = req.url.endsWith('/edits');
    imageRequests++; if (edit) imageEditRequests++;
    const data = edit ? undefined : JSON.parse(raw.toString('utf8'));
    const multipart = edit ? raw.toString('utf8') : '';
    const boundary = req.headers['content-type']?.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean);
    const field = name => { if (!boundary) return undefined; const marker = `name="${name}"\r\n\r\n`; const start = multipart.indexOf(marker); if (start < 0) return undefined; const end = multipart.indexOf(`\r\n--${boundary}`, start + marker.length); return end < 0 ? undefined : multipart.slice(start + marker.length, end); };
    const imageDataUrls = []; const collectReferences = value => { if (typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/.test(value)) imageDataUrls.push(value); else if (Array.isArray(value)) value.forEach(collectReferences); else if (value && typeof value === 'object') Object.values(value).forEach(collectReferences); };
    if (data) collectReferences(data);
    const multipartReferences = edit ? [...multipart.matchAll(/name="image(?:\[\])?"; filename=/g)].length : 0;
    const referenceCount = multipartReferences + imageDataUrls.length;
    const parameters = data ? Object.fromEntries(Object.entries(data).filter(([key]) => !['model', 'prompt', 'image_url', 'reference_images', 'image_urls', 'images'].includes(key) && !/^image_url_?\d*$/.test(key))) : Object.fromEntries(['size', 'quality', 'background', 'output_format', 'output_compression', 'input_fidelity', 'moderation'].flatMap(name => field(name) === undefined ? [] : [[name, field(name)]]));
    lastImageRequest = { protocol: data?.model?.includes('/') || imageDataUrls.length ? 'together-images' : 'openai-images', edit, model: data?.model || field('model'), prompt: data?.prompt || field('prompt'), referenceCount, referenceBytes: referenceCount > 0 && (!multipartReferences || raw.includes(Buffer.from(tinyPng, 'base64'))) && imageDataUrls.every(url => url.split(',')[1] === tinyPng), parameters };
    if (lastImageRequest.model === 'e2e-image-failure') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Deliberate image failure fixture' })); return; }
    setTimeout(() => { if (res.destroyed) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: tinyPng }] })); }, lastImageRequest.model === 'e2e-image-slow' ? 5000 : 100);
    return;
  }
  if (req.method === 'POST' && /^\/v1\/models\/[^/]+:generateContent$/.test(req.url)) {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); const parts = data.contents?.flatMap(content => content.parts || []) || []; const references = parts.filter(part => part.inlineData);
    imageRequests++; if (references.length) imageEditRequests++;
    lastImageRequest = { protocol: 'gemini', edit: references.length > 0, model: decodeURIComponent(req.url.match(/\/models\/(.+):generateContent$/)[1]), prompt: parts.filter(part => part.text).map(part => part.text).join('\n'), referenceCount: references.length, referenceBytes: references.length > 0 && references.every(part => part.inlineData.data === tinyPng), parameters: data.generationConfig, systemInstruction: data.systemInstruction, tools: data.tools };
    setTimeout(() => { if (res.destroyed) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: tinyPng } }] } }] })); }, 100); return;
  }
  if (req.method === 'GET' && new URL(req.url, 'http://fixture').pathname === '/v1/models') {
    modelListRequests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    const ids = ['e2e-fixture', 'e2e-planning'];
    res.end(JSON.stringify({ data: ids.map(id => ({ id, display_name: id })), models: ids.map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'] })) })); return;
  }
  const geminiBlockFixture = req.url === '/v1/models/e2e-gemini-blocked:streamGenerateContent?alt=sse';
  if ((req.url !== '/v1/chat/completions' && !geminiBlockFixture) || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  try {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const system = body.messages?.filter(message => message.role === 'system').map(message => message.content).join('\n') || '';
    const prompt = body.messages?.filter(message => message.role === 'user').map(message => message.content).join('\n') || '';
    if (/^e2e-image-prompts?/.test(body.model || '') || /生图提示词优化|IMAGE_PROMPT_OPTIMIZATION/.test(system)) {
      promptOptimizationRequests++; lastPromptOptimizationRequest = { model: body.model, system, prompt };
      if (body.model === 'e2e-image-prompt-failure') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Deliberate prompt optimization failure' })); return; }
      let input = {}; try { input = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1)); } catch { /* Inputs remain visible in fixture statistics. */ }
      const referenceEntityIds = [...new Set((input.characters || []).filter(character => character.imageId).map(character => character.entityId))];
      const config = input.config || {}; const parameters = config.protocol === 'gemini' ? { ...(config.aspectRatio === 'auto' || !config.aspectRatio ? { aspectRatio: '16:9' } : {}), ...(config.imageSize === 'auto' ? { imageSize: '1K' } : {}) } : config.protocol === 'together-images' && config.size === 'auto' && !config.width && !config.height ? { width: 1536, height: 1024 } : config.protocol === 'openai-images' && config.size === 'auto' ? { size: '1536x1024' } : {};
      lastOptimizedImagePrompt = 'E2E_OPTIMIZED_IMAGE_PROMPT, cinematic illustration, coherent character design, expressive poses, natural lighting, detailed environment';
      const text = JSON.stringify({ prompt: lastOptimizedImagePrompt, referenceEntityIds, parameters });
      setTimeout(() => { if (res.destroyed) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 40 } })); }, 100); return;
    }
    modelRequests++;
    const modelName = body.model || (geminiBlockFixture ? 'e2e-gemini-blocked' : 'unknown');
    modelRequestsByModel[modelName] = (modelRequestsByModel[modelName] || 0) + 1;
    if (geminiBlockFixture) {
      lastModelParameters = { generationConfig: body.generationConfig };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 12 } })}\n\n`); return;
    }
    lastModelParameters = Object.fromEntries(['model', 'temperature', 'top_p', 'seed', 'stream', 'max_tokens', 'max_completion_tokens', 'reasoning_effort'].filter(key => body[key] !== undefined).map(key => [key, body[key]]));
    if (body.model === 'e2e-http500') {
      setTimeout(() => { if (res.destroyed) return; res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Deliberate local HTTP 500 fixture' } })); }, 100);
      return;
    }
    if (body.model === 'e2e-images' && !body.messages?.some(message => message.role === 'tool')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sourceText = '林舟来到白石城，发现城门下藏着一把旧钥匙。';
      const calls = [
        { index: 0, id: 'image-portrait', type: 'function', function: { name: 'generate_character_portrait', arguments: JSON.stringify({ name: '林舟', description: '一位穿着旅行斗篷的年轻旅人。' }) } },
        ...(body.tools?.some(tool => tool.function?.name === 'generate_scene_cg') ? [{ index: 1, id: 'image-scene', type: 'function', function: { name: 'generate_scene_cg', arguments: JSON.stringify({ description: '古城门下，一位旅人拾起石阶边的钥匙。', sourceText }) } }] : []),
      ];
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    if (body.model === 'e2e-public-activities') {
      const queried = body.messages?.some(message => message.role === 'tool');
      if (queried && prompt.includes('ACTIVITY_HTTP_FAILURE')) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Deliberate activity-history failure' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'e2e-activity-stream' });
      const frame = (delta, finish_reason = null) => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`); };
      const done = () => { if (!res.destroyed) { res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 80 } })}\n\n`); res.end('data: [DONE]\n\n'); } };
      frame({ reasoning_content: queried ? 'AUTHOR_PUBLIC_THINK_2：根据查询结果安排人物行动。' : 'AUTHOR_PUBLIC_THINK_1：先核对故事资料，' });
      if (!queried) {
        setTimeout(() => frame({ reasoning_content: '再检查尚未确认的人物身份。' }), 250);
        setTimeout(() => {
          frame({ tool_calls: [
            { index: 0, id: 'activity-search', type: 'function', function: { name: 'search_story', arguments: JSON.stringify({ query: '林舟', scope: 'entities' }) } },
            { index: 1, id: 'activity-missing', type: 'function', function: { name: 'read_entity', arguments: JSON.stringify({ id: 'ACTIVITY_MISSING_ENTITY' }) } },
          ] });
          frame({}, 'tool_calls'); done();
        }, 900);
      } else {
        const prose = '林舟来到白石城，循着石碑上的纹路找到一处旧门。\n\n他握住钥匙，推开了门。'; const middle = Math.floor(prose.length / 2);
        setTimeout(() => frame({ content: prose.slice(0, middle) }), 150);
        setTimeout(() => { frame({ content: prose.slice(middle) }); frame({}, 'stop'); done(); }, 6000);
      }
      return;
    }
    const text = body.model === 'e2e-noncompact-summary' ? JSON.stringify({ text: prompt }) : body.model === 'e2e-compact-extraction' ? JSON.stringify({ summary: '林舟来到白石城。', entities: [{ kind: 'character', name: '林舟', visibility: 'public', facts: [{ text: '林舟走进白石城', paragraph: 1, temporal: 'current', certainty: 'fact', visibility: 'public', attribute: 'location' }] }] }) : body.model === 'e2e-quote-mismatch' ? JSON.stringify({ summary: '旅人进入古城。', entities: [{ kind: 'character', name: '林舟', aliases: [], description: '旅人', visibility: 'public', facts: [{ text: '林舟来到白石城', attribute: 'location', temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 1, quote: '回来了。林舟走进山谷。' }] }], relations: [], foreshadows: [] }) : fixtureReply(system, prompt);
    // A short real async wait exercises job polling and persisted checkpoints.
    setTimeout(() => {
      if (res.destroyed) return;
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'e2e-stream-request' });
        const middle = Math.floor(text.length / 2);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(0, middle) }, finish_reason: null }] })}\n\n`);
        const finish = () => {
          if (res.destroyed) return;
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(middle) }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 80 } })}\n\n`);
          res.end('data: [DONE]\n\n');
        };
        if (body.model === 'e2e-streaming-writing') setTimeout(finish, 3000); else finish();
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 80 } })); }
    }, body.model === 'e2e-slow-extraction' ? 5000 : 100);
  } catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid fixture request' })); }
});
modelServer.listen(mockPort, '127.0.0.1'); await once(modelServer, 'listening');
const { buildApp } = await import('../dist/server/app.js');
const { app } = await buildApp({ dataDir, staticDir });
await app.listen({ port, host: '127.0.0.1' });
console.log(`E2E only: http://127.0.0.1:${port}; mock model on ${mockPort}; isolated data ${dataDir}`);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await app.close(); modelServer.closeAllConnections();
  await new Promise(resolveClose => modelServer.close(resolveClose)); process.exit(0);
}
process.on('SIGINT', close); process.on('SIGTERM', close);
