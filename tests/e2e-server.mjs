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
process.env.OUTBOUND_ALLOWED_ORIGINS = `http://127.0.0.1:${mockPort}`;
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
        ...(paragraphs.find(p => p.quote.includes('FUTURE_REFERENCE_SENTINEL')) ? [{ kind: 'item', name: '星钥', aliases: [], description: '原作后续出现的钥匙。', visibility: 'public', facts: [fact(paragraphs.find(p => p.quote.includes('FUTURE_REFERENCE_SENTINEL')), '星钥能够照亮星门。', 'ability')] }] : []),
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
    if (body.model === 'e2e-post-planning') {
      const attempt = modelRequestsByModel[modelName];
      if (attempt === 2) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Deliberate post-writing planning failure' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frames = []; const frame = (delta, finish_reason = null) => frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (attempt === 1) { frame({ content: '林舟来到白石城，推开城门。\n\n他望向星光下的街道。' }); frame({}, 'stop'); }
      else if (attempt === 3) {
        const tool = body.tools?.find(value => value.function?.name === 'update_plot_plan'); const next = Number(tool?.function?.description?.match(/第\s+(\d+)\s+章至第/)?.[1] || 2);
        frame({ reasoning_content: 'POST_PLANNING_THINK：根据已经保存的正文安排后续四章。' });
        frame({ tool_calls: [{ index: 0, id: 'post-planning-tool', type: 'function', function: { name: 'update_plot_plan', arguments: JSON.stringify({ fine: Array.from({ length: 4 }, (_, index) => ({ chapter: next + index, title: `第${next + index}章 星光街道`, goal: '从城门线索继续调查。' })), foreshadows: [] }) } }] }); frame({}, 'tool_calls');
      } else { frame({ reasoning_content: 'POST_PLANNING_AFTER_TOOL：确认后续安排已经提交。' }); frame({ content: 'POST_PLANNING_ACK：后续规划完成。' }); frame({}, 'stop'); }
      res.end(frames.join('') + 'data: [DONE]\n\n'); return;
    }
    if (body.model === 'e2e-inline-control') {
      const attempt = modelRequestsByModel[modelName];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (content, finish_reason = null) => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: content ? { content } : {}, finish_reason }] })}\n\n`); };
      setTimeout(() => frame(`INLINE_CONTROL_ATTEMPT_${attempt}：林舟来到白石城，等待城门打开。`), 100);
      if (attempt === 1) setTimeout(() => { if (!res.destroyed) res.destroy(); }, 350);
      else setTimeout(() => { if (!res.destroyed) { frame('\n\n他继续等待新的线索。', 'stop'); res.end('data: [DONE]\n\n'); } }, 6000);
      return;
    }
    if (body.model === 'e2e-original-reference') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const outputs = body.messages?.filter(message => message.role === 'tool') || [];
      const call = (id, name, args) => ({ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      const frame = delta => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      let finishReason = 'tool_calls';
      if (!outputs.length) {
        frame({ tool_calls: [
          call('reference-list', 'list_text_files', { collection: 'original' }),
          { ...call('reference-search', 'search_text', { collection: 'original', keywords: ['FUTURE_REFERENCE_SENTINEL'], contextLines: 1 }), index: 1 },
          { ...call('reference-read', 'read_text_file', { path: 'original/000002.txt', startLine: 3, endLine: 3 }), index: 2 },
          { ...call('reference-entities', 'search_story', { collection: 'original', keywords: ['星钥'], scope: 'entities' }), index: 3 },
        ] });
      } else if (!body.messages?.some(message => message.role === 'assistant' && message.tool_calls?.some(value => value.function?.name === 'ask_user'))) {
        frame({ content: '你站在白石城门前，守门人正等待你的回应。\n\n' });
        const entities = outputs.flatMap(message => { try { return JSON.parse(message.content).entities || []; } catch { return []; } });
        frame({ tool_calls: [
          call('reference-entity', 'read_entity', { collection: 'original', id: entities.find(entity => entity.name === '星钥')?.id || 'missing-original-item' }),
          { ...call('reference-choice', 'ask_user', { question: '守门人向你询问来意，你准备如何回应？', options: [{ id: 'greet', label: '友好问候' }, { id: 'wait', label: '先观察周围' }] }), index: 1 },
        ] });
      } else { frame({ content: '你按自己的选择回应守门人，故事开始发生变化。' }); finishReason = 'stop'; }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 30, completion_tokens: 15 } })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    if (body.model === 'e2e-rpg') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const answers = body.messages?.filter(message => message.role === 'tool').flatMap(message => {
        try { const value = JSON.parse(message.content); return value.text ? [value.text] : value.answer ? [value.answer] : value.customText ? [value.customText] : value.label ? [value.label] : []; } catch { return []; }
      }) || [];
      const asked = body.messages?.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.function?.name === 'ask_user'));
      const afterChoiceSearch = body.messages?.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'rpg-after-search'));
      const frames = []; const frame = delta => frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      if (!asked) {
        frame({ reasoning_content: 'RPG_START_THINK：先观察城门前的环境。' });
        frame({ content: '你站在白石城门前，石碑上的纹路隐约发亮。\n\n' });
        frame({ tool_calls: [{ index: 0, id: 'rpg-decision', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '城门前出现两条道路，你准备怎么做？', options: [{ id: 'investigate', label: '查看石碑', description: '先调查石碑上的纹路。' }, { id: 'enter', label: '进入城中', description: '走进城门寻找线索。' }] }) } }] });
        frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 15 } })}\n\n`);
      } else if (!afterChoiceSearch) {
        frame({ reasoning_content: 'RPG_AFTER_CHOICE_THINK：根据玩家刚才的选择核对石碑线索。' });
        frame({ tool_calls: [{ index: 0, id: 'rpg-after-search', type: 'function', function: { name: 'search_story', arguments: JSON.stringify({ keywords: ['石碑'], scope: 'chapters' }) } }] });
        frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 25, completion_tokens: 15 } })}\n\n`);
      } else {
        frame({ reasoning_content: 'RPG_AFTER_TOOL_THINK：将已确认的线索用于当前场景。' });
        frame({ content: `你选择了「${answers.at(-1) || '继续探索'}」，眼前的故事随之展开。` });
        frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 20 } })}\n\n`);
      }
      res.end(frames.join('') + 'data: [DONE]\n\n'); return;
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
        setTimeout(() => frame({ content: '林舟来到白石城，' }), 450);
        setTimeout(() => {
          frame({ tool_calls: [
            { index: 0, id: 'activity-search', type: 'function', function: { name: 'search_story', arguments: JSON.stringify({ query: '林舟', scope: 'entities' }) } },
            { index: 1, id: 'activity-missing', type: 'function', function: { name: 'read_entity', arguments: JSON.stringify({ id: 'ACTIVITY_MISSING_ENTITY' }) } },
          ] });
          frame({}, 'tool_calls'); done();
        }, 900);
      } else {
        const prose = '循着石碑上的纹路找到一处旧门。\n\n他握住钥匙，推开了门。'; const middle = Math.floor(prose.length / 2);
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
// Browser regression logs in and imports many independent fixtures; security limit tests use defaults.
const { app } = await buildApp({ dataDir, staticDir, initialPassword: 'browser-test-password-123', rateLimits: { login: 1000, imports: 1000, models: 1000 } });
await app.listen({ port, host: '127.0.0.1' });
console.log(`E2E only: http://127.0.0.1:${port}; mock model on ${mockPort}; isolated data ${dataDir}`);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await app.close(); modelServer.closeAllConnections();
  await new Promise(resolveClose => modelServer.close(resolveClose)); process.exit(0);
}
process.on('SIGINT', close); process.on('SIGTERM', close);
