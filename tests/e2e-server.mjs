// Browser acceptance fixture only: all model requests stay on loopback.
// It does not call or validate any real OpenAI/Gemini/Claude service.
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { extractionFixtureParagraphs, imageFixtureInput } from './prompt-fixture-input.mjs';

process.env.NODE_ENV = 'production';
const port = Number(process.env.E2E_PORT || 14328);
const mockPort = Number(process.env.E2E_MODEL_PORT || 4329);
process.env.OUTBOUND_ALLOWED_ORIGINS = `http://127.0.0.1:${mockPort}`;
const staticDir = resolve('dist/public');
if (!existsSync(join(staticDir, 'index.html'))) throw new Error('请先 npm run build，再启动浏览器测试。');
const dataDir = mkdtempSync(join(tmpdir(), 'ai-novel-browser-'));

function fixtureReply(system, prompt) {
  if (system.includes('独立的插画定位任务')) {
    const scenes = JSON.parse(prompt.split('# 待定位的插画\n')[1].split('\n\n# 本章正文')[0]);
    const paragraphs = [...prompt.matchAll(/^\[(\d+)\] (.+)$/gm)];
    const paragraph = paragraphs.find(row => row[2].includes('旧钥匙')) || paragraphs[0];
    return JSON.stringify({ placements: scenes.map(scene => ({ imageId: scene.id, paragraph: paragraph ? Number(paragraph[1]) : null })) });
  }
  if (system.includes('# 章节标题修复')) {
    const input = JSON.parse(prompt);
    return JSON.stringify({ chapters: input.chapters.map(chapter => {
      const preceding = chapter.sourceContext?.split(chapter.beginning.trim().slice(0, 200))[0] || '';
      const heading = chapter.beginning.match(/^第[0-9]+章[^\n]*/)?.[0] || [...preceding.matchAll(/第[0-9]+章[^\n]*/g)].at(-1)?.[0];
      return { chapterId: chapter.chapterId, title: heading || '雨夜码头', reason: heading ? '原文标题与本章起点对应。' : '根据本章内容建议题名。', evidence: heading || chapter.beginning.slice(0, 80), confidence: heading ? 'high' : 'medium', multipleChapters: false };
    }) });
  }

  if (system.includes('# 分章规则生成')) return JSON.stringify({ name: 'AI 场景编号', pattern: '场景[0-9]+｜.+', flags: '', description: '按场景编号和竖线标题分章。' });
  if (system.includes('只压缩') && system.includes('剧情摘要')) return JSON.stringify({ text: '林舟调查白石城。' });
  if (system.includes('# 当前片段资料提取')) {
    const paragraphs = extractionFixtureParagraphs(prompt);
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
  if (system.includes('# 后续剧情规划')) {
    const next = Number(prompt.match(/为第\s+(\d+)\s+章至第/)?.[1] || 1);
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
let chapterTitleRequests = 0;
let modelListRequests = 0;
const modelRequestsByModel = {};
let lastModelParameters;
let finishGeminiArgsStream;
let finishImageWriter;
let imageRequests = 0; let imageEditRequests = 0; let lastImageRequest;
let promptOptimizationRequests = 0; let lastPromptOptimizationRequest; let lastOptimizedImagePrompt;
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPw6Sv6DwAEwgJMYzx9CAAAAABJRU5ErkJggg==';
const modelServer = createServer(async (req, res) => {
  if (req.url === '/__e2e/stats' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ modelRequests, chapterTitleRequests, modelListRequests, modelRequestsByModel, lastModelParameters, imageRequests, imageEditRequests, lastImageRequest, promptOptimizationRequests, lastPromptOptimizationRequest, lastOptimizedImagePrompt })); return; }
  if (req.url === '/__e2e/shutdown' && req.method === 'POST') { res.writeHead(200); res.end('stopping test fixture'); setImmediate(() => void close()); return; }
  if (req.url === '/__e2e/gemini-args-release' && req.method === 'POST') { const finish = finishGeminiArgsStream; finishGeminiArgsStream = undefined; finish?.(); res.writeHead(200); res.end('released'); return; }
  if (req.url === '/__e2e/image-writer-release' && req.method === 'POST') { finishImageWriter?.(); res.writeHead(200); res.end('released'); return; }
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
  const geminiReviewFixture = req.url === '/v1/models/e2e-gemini-review:streamGenerateContent?alt=sse';
  const geminiArgsFixture = req.url === '/v1/models/e2e-gemini-args:streamGenerateContent?alt=sse';
  if ((req.url !== '/v1/chat/completions' && !geminiBlockFixture && !geminiReviewFixture && !geminiArgsFixture) || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  try {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // A real provider also receives the neutral framework's task archive in tools.
    const archive = body.tools?.find(tool => tool.function?.description?.includes('【/workspace/archive/ 本地工作目录文件与历史章节归档】'))?.function.description;
    const archivedMessages = archive?.split('\n\n---\n\n').flatMap(section => {
      const match = section.match(/(?:^|\n)\[(system|user|assistant)\]\n([\s\S]*)/);
      return match ? [{ role: match[1], content: match[2] }] : [];
    });
    const taskMessages = archivedMessages?.length ? archivedMessages : body.messages || [];
    const system = taskMessages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    const prompt = taskMessages.filter(message => message.role === 'user').map(message => message.content).join('\n');
    if (/^e2e-image-prompts?/.test(body.model || '') || /生图提示词优化|IMAGE_PROMPT_OPTIMIZATION/.test(system)) {
      promptOptimizationRequests++; lastPromptOptimizationRequest = { model: body.model, system, prompt };
      if (body.model === 'e2e-image-prompt-failure') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Deliberate prompt optimization failure' })); return; }
      const input = imageFixtureInput(prompt);
      lastPromptOptimizationRequest.input = input;
      const referenceEntityIds = [...new Set((input.characters || []).filter(character => character.imageId).map(character => character.entityId))];
      const config = input.config || {}; const parameters = config.protocol === 'gemini' ? { ...(config.aspectRatio === 'auto' || !config.aspectRatio ? { aspectRatio: '16:9' } : {}), ...(config.imageSize === 'auto' ? { imageSize: '1K' } : {}) } : config.protocol === 'together-images' && config.size === 'auto' && !config.width && !config.height ? { width: 1536, height: 1024 } : config.protocol === 'openai-images' && config.size === 'auto' ? { size: '1536x1024' } : {};
      lastOptimizedImagePrompt = 'E2E_OPTIMIZED_IMAGE_PROMPT, cinematic illustration, coherent character design, expressive poses, natural lighting, detailed environment';
      const text = JSON.stringify({ prompt: lastOptimizedImagePrompt, referenceEntityIds, parameters });
      setTimeout(() => { if (res.destroyed) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 40 } })); }, 100); return;
    }
    modelRequests++;
    const modelName = body.model || (geminiBlockFixture ? 'e2e-gemini-blocked' : geminiReviewFixture ? 'e2e-gemini-review' : geminiArgsFixture ? 'e2e-gemini-args' : 'unknown');
    modelRequestsByModel[modelName] = (modelRequestsByModel[modelName] || 0) + 1;
    if (geminiArgsFixture) {
      if (body.toolConfig?.functionCallingConfig?.streamFunctionCallArguments !== true) { res.writeHead(400); res.end(JSON.stringify({ error: 'fixture requires streamed arguments' })); return; }
      const frame = (parts, finishReason) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 15, thoughtsTokenCount: 10 } })}\n\n`;
      const afterTool = body.contents.some(message => message.parts.some(part => part.functionResponse));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!afterTool) {
        res.end(frame([{ thought: true, text: 'STREAM_ARGS_NATIVE_THOUGHT：核对城门资料。' }, { functionCall: { id: 'args-query', name: 'search_story', partialArgs: [{ jsonPath: '$.keywords[0]', stringValue: '城门' }, { jsonPath: '$.scope', stringValue: 'chapters' }] }, thoughtSignature: 'args-query-signature' }], 'STOP')); return;
      }
      const sink = body.tools[0].functionDeclarations.find(tool => tool.name === 'emit_complete_text');
      res.write(frame([{ functionCall: { id: 'args-prose', name: sink.name, partialArgs: [{ jsonPath: '$.content', stringValue: '<draft>STREAM_ARGS_PRESET_NOTE</draft><game>林舟来到城门前。', willContinue: true }], willContinue: true }, thoughtSignature: 'args-prose-signature' }]));
      finishGeminiArgsStream = () => { if (!res.destroyed) res.end(frame([{ functionCall: { partialArgs: [{ jsonPath: '$.content', stringValue: '他推开城门，走进白石城。</game><summary>辅助摘要不得保存</summary>' }] } }], 'STOP')); };
      return;
    }
    if (geminiBlockFixture) {
      lastModelParameters = { generationConfig: body.generationConfig };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 12 } })}\n\n`); return;
    }
    if (geminiReviewFixture) {
      const afterTool = body.contents.some(message => message.parts.some(part => part.functionResponse));
      const parts = afterTool ? [{ text: '他握住钥匙，推开了城门。' }] : [{ thought: true, text: 'REVIEW_FIRST_THOUGHT：先核对城门线索。' }, { text: '林舟来到白石城。' }, { functionCall: { id: 'review-search', name: 'search_story', args: { query: '林舟', scope: 'entities' } }, thoughtSignature: 'opaque-fixture-signature' }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 15, thoughtsTokenCount: afterTool ? 116 : 72 } })}\n\n`); return;
    }
    lastModelParameters = Object.fromEntries(['model', 'temperature', 'top_p', 'seed', 'stream', 'max_tokens', 'max_completion_tokens', 'reasoning_effort'].filter(key => body[key] !== undefined).map(key => [key, body[key]]));
    if (system.includes('# 章节自动命名')) {
      chapterTitleRequests++;
      const text = JSON.stringify({ title: body.model === 'e2e-title-invalid' ? '新章节' : '城门下的钥匙' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 10 } })); return;
    }
    if (body.model === 'e2e-preset-activities') {
      const hasResults = body.messages?.some(message => message.role === 'tool');
      const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 30, completion_tokens: 15 } })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (hasResults) res.end(frame({ content: '<think>PRESET_AFTER：已收到资料及生图登记结果。</think>林舟走进白石城，开始寻找新的线索。' }, 'stop') + 'data: [DONE]\n\n');
      else {
        res.write(frame({ content: '林舟来到城门前。<thi' }));
        setTimeout(() => { if (res.destroyed) return; res.end(frame({ content: 'nking>PRESET_BEFORE：先查询城门资料，再登记人物立绘。</thinking>' }) + frame({ tool_calls: [
          { index: 0, id: 'preset-search', type: 'function', function: { name: 'search_story', arguments: JSON.stringify({ keywords: ['城门'], scope: 'chapters' }) } },
          { index: 1, id: 'preset-portrait', type: 'function', function: { name: 'generate_character_portrait', arguments: JSON.stringify({ name: '林舟', description: '穿着旧风衣的旅人。' }) } },
        ] }, 'tool_calls') + 'data: [DONE]\n\n'); }, 150);
      }
      return;
    }
    if (body.model === 'e2e-native-carrier') {
      const hasResults = body.messages?.some(message => message.role === 'tool');
      const sink = body.tools.find(tool => tool.function?.name === 'emit_complete_text').function;
      const args = JSON.stringify({ content: `<draft>NATIVE_CHECK：核对本轮场景。</draft><game>${hasResults ? '林舟走进白石城，开始寻找新的线索。' : '林舟来到城门前。'}</game><summary>不得保存的辅助摘要</summary>` });
      const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 30, completion_tokens: 15 } })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ tool_calls: [{ index: 0, id: `native-${hasResults ? 'final' : 'first'}`, type: 'function', function: { name: sink.name, arguments: args.slice(0, 40) } }] }));
      setTimeout(() => {
        if (res.destroyed) return;
        const calls = [{ index: 0, function: { arguments: args.slice(40) } }];
        if (!hasResults) calls.push({ index: 1, id: 'native-search', type: 'function', function: { name: 'search_story', arguments: JSON.stringify({ keywords: ['城门'], scope: 'chapters' }) } });
        res.end(frame({ tool_calls: calls }, 'tool_calls') + 'data: [DONE]\n\n');
      }, 100); return;
    }
    if (body.model === 'e2e-writing-envelope') {
      const hasResults = body.messages?.some(message => message.role === 'tool');
      const envelope = { prose: '<Interleaving><thinking>辅助场景核对</thinking>' + (hasResults ? '林舟走进白石城，开始寻找新的线索。' : '林舟来到城门前。') + '</Interleaving>', toolCalls: hasResults ? [] : [{ name: 'search_story', argumentsJson: JSON.stringify({ keywords: ['城门'], scope: 'chapters' }) }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const raw = JSON.stringify(envelope); const pivot = raw.indexOf('toolCalls');
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `outer-${hasResults ? 'final' : 'lookup'}`, type: 'function', function: { name: 'emit_writing_response', arguments: raw.slice(0, pivot) } }] } }] })}\n\n`);
      setTimeout(() => { if (res.destroyed) return; res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(pivot) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 15 } })}\n\ndata: [DONE]\n\n`); }, 150); return;
    }
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
    if (body.model === 'e2e-rpg-budget') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (delta, finish_reason = null) => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`); };
      const done = finish_reason => { frame({}, finish_reason); if (!res.destroyed) res.end('data: [DONE]\n\n'); };
      const actionMessage = taskMessages.find(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('# 上一章的待选问题与玩家已确认的行动\n'));
      const carried = actionMessage ? JSON.parse(actionMessage.content.split('# 上一章的待选问题与玩家已确认的行动\n')[1].split('\n')[0]) : undefined;
      if (carried) {
        frame({ content: `${carried.text || carried.customText || carried.optionId}\n\n你向守门人询问东门的路况，然后迈进城门。` });
        done('stop'); return;
      }
      const answered = body.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'budget-first-choice');
      const prose = answered ? '你按照刚才的选择走近石碑。'.repeat(5) : '你在白石城门前等待。'.repeat(18);
      const choice = answered ? { question: '石阶分成两路，你准备怎样进入城中？', options: [{ id: 'east', label: '进入东门' }, { id: 'watch', label: '继续观察守门人' }] } : { question: '城门前的石碑发出微光，你准备怎么做？', options: [{ id: 'investigate', label: '查看石碑' }, { id: 'enter', label: '直接进入城中' }] };
      frame({ content: prose + '\n\n' });
      setTimeout(() => {
        if (res.destroyed) return;
        frame({ tool_calls: [{ index: 0, id: answered ? 'budget-chapter-choice' : 'budget-first-choice', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify(choice) } }] });
        done('tool_calls');
      }, 400);
      return;
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
    if (['e2e-images', 'e2e-images-parallel'].includes(body.model) && !body.messages?.some(message => message.role === 'tool')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sourceText = '林舟来到白石城，发现城门下藏着一把旧钥匙。';
      // Scene descriptions do not need to quote prose or specify an insertion position.
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: sourceText + '\n\n' }, finish_reason: null }] })}\n\n`);
      const calls = [
        { index: 0, id: 'image-portrait', type: 'function', function: { name: 'generate_character_portrait', arguments: JSON.stringify({ name: '林舟', description: '一位穿着旅行斗篷的年轻旅人。' }) } },
        ...(body.tools?.some(tool => tool.function?.name === 'generate_scene_cg') ? [{ index: 1, id: 'image-scene', type: 'function', function: { name: 'generate_scene_cg', arguments: JSON.stringify({ prompt: 'WRITER_DIRECT_CG：古城门下，林舟穿着旅行斗篷拾起石阶边的钥匙，侧面中景，晨光照亮石阶。', referenceNames: ['林舟'], sceneDescription: '清晨的古城门前，林舟弯身拾起石阶旁的旧钥匙。' }) } }] : []),
      ];
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    if (body.model === 'e2e-images-parallel') {
      await new Promise(resolve => { finishImageWriter = resolve; res.once('close', resolve); });
      finishImageWriter = undefined;
      if (res.destroyed) return;
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
    let text = body.model === 'e2e-noncompact-summary' ? JSON.stringify({ text: prompt }) : body.model === 'e2e-compact-extraction' ? JSON.stringify({ summary: '林舟来到白石城。', entities: [{ kind: 'character', name: '林舟', visibility: 'public', facts: [{ text: '林舟走进白石城', paragraph: 1, temporal: 'current', certainty: 'fact', visibility: 'public', attribute: 'location' }] }] }) : body.model === 'e2e-quote-mismatch' ? JSON.stringify({ summary: '旅人进入古城。', entities: [{ kind: 'character', name: '林舟', aliases: [], description: '旅人', visibility: 'public', facts: [{ text: '林舟来到白石城', attribute: 'location', temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 1, quote: '回来了。林舟走进山谷。' }] }], relations: [], foreshadows: [] }) : fixtureReply(system, prompt);
    if (['e2e-images', 'e2e-images-parallel'].includes(body.model) && body.messages?.some(message => message.role === 'tool')) {
      const delivered = '林舟来到白石城，发现城门下藏着一把旧钥匙。\n\n';
      if (text.startsWith(delivered)) text = text.slice(delivered.length);
    }
    if (body.tools?.some(tool => tool.function?.name === 'submit_extraction')) {
      if (body.tool_choice?.function?.name !== 'submit_extraction' || body.parallel_tool_calls !== false) { res.writeHead(400); res.end('{"error":"missing submission choice"}'); return; }
      const call = { id: 'extraction-submission', type: 'function', function: { name: 'submit_extraction', arguments: text } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 80 } })); return;
    }
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
