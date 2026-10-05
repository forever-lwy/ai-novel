import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../server/app.js';
import { defaultTaskSettings } from '../shared/task-settings.js';
import type { PlanningResult, ProviderProtocol, Settings } from '../shared/types.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = []; const servers: Server[] = [];
afterEach(async () => {
  for (const ctx of apps.splice(0)) await ctx.app.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
const text = '阿青走到港口，看见一艘旧船。';
const plan = (): PlanningResult => ({
  fine: [1, 2, 3, 4].map(chapter => ({ chapter, title: `港口规划${chapter}`, goal: `尚未发生的港口事件${chapter}` })),
  foreshadows: [{ title: '旧船秘密', detail: '船底藏着尚未揭晓的秘密。', status: 'planned', dueChapter: 4, revealCondition: '第四章调查船底', relatedNames: [] }],
});
const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function until(done: () => boolean) { const deadline = Date.now() + 6000; while (!done()) { if (Date.now() > deadline) throw new Error('规划协议任务等待超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }

function toolRound(protocol: ProviderProtocol, value: unknown = plan()): string {
  const args = JSON.stringify(value); const call = { name: 'update_plot_plan', arguments: args };
  if (protocol === 'openai-chat') return sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'plan-call', type: 'function', function: { name: call.name, arguments: args.slice(0, 30) } }] } }] }) + sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(30) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }) + sse('[DONE]');
  if (protocol === 'openai-responses') return sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'plan-item', call_id: 'plan-call', name: call.name, arguments: '' } }) + sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'plan-item', delta: args }) + sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'plan-reasoning', encrypted_content: 'plan-signature' }, { type: 'function_call', id: 'plan-item', call_id: 'plan-call', ...call }], usage: { input_tokens: 10, output_tokens: 20 } } });
  if (protocol === 'gemini') return sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { id: 'plan-call', name: call.name, args: value }, thoughtSignature: 'plan-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } });
  return sse({ type: 'message_start', message: { content: [], usage: { input_tokens: 10 } } }) + sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先编写预期规划。' } }) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'plan-signature' } }) + sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'plan-call', name: call.name, input: {} } }) + sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args } }) + sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }) + sse({ type: 'message_stop' });
}
function proseRound(protocol: ProviderProtocol): string {
  if (protocol === 'openai-chat') return sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8 } }) + sse('[DONE]');
  if (protocol === 'openai-responses') return sse({ type: 'response.output_text.delta', delta: text }) + sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 30, output_tokens: 8 } } });
  if (protocol === 'gemini') return sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 8 } });
  return sse({ type: 'message_start', message: { content: [], usage: { input_tokens: 30 } } }) + sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }) + sse({ type: 'message_stop' });
}
function extractionReply(protocol: ProviderProtocol): unknown {
  const extracted = JSON.stringify({ summary: '阿青来到港口。', entities: [], relations: [], foreshadows: [] });
  if (protocol === 'openai-chat') return { choices: [{ message: { role: 'assistant', content: extracted }, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 7 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: extracted }] }], usage: { input_tokens: 6, output_tokens: 7 } };
  if (protocol === 'gemini') return { candidates: [{ content: { role: 'model', parts: [{ text: extracted }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 7 } };
  return { type: 'message', role: 'assistant', content: [{ type: 'text', text: extracted }], stop_reason: 'end_turn', usage: { input_tokens: 6, output_tokens: 7 } };
}
async function harness(protocol: ProviderProtocol, continuation?: (response: ServerResponse, index: number) => Promise<void> | void, initialPlan: unknown = plan()) {
  const requests: { url: string; model: string; body: any }[] = [];
  let writingRequests = 0;
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); const url = incoming.url || '';
    const model = body.model ?? decodeURIComponent(url.match(/\/models\/([^/:]+)/)?.[1] ?? ''); requests.push({ url, model, body });
    if (model === 'extractor') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(extractionReply(protocol))); return; }
    if (model !== 'writer') { response.writeHead(500); response.end('禁止调用独立规划模型'); return; }
    if (writingRequests++ === 0) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(toolRound(protocol, initialPlan)); return; }
    if (continuation) await continuation(response, writingRequests - 1);
    else { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(proseRound(protocol)); }
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'novel-planning-protocol-')) }); apps.push(ctx);
  const setup = await ctx.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'planning-protocol-fixture' } });
  const cookies = { session: setup.cookies.find(cookie => cookie.name === 'session')!.value };
  const settings: Settings = { providers: [{ id: 'local', name: '本地协议模拟', protocol, baseUrl }], writingProviderId: 'local', writingModel: 'writer', planningProviderId: 'local', planningModel: 'planner-forbidden', extractionProviderId: 'local', extractionModel: 'extractor', taskSettings: { ...defaultTaskSettings(), planning: { enabled: true, mode: 'tool' } } };
  const saved = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies, payload: settings }); expect(saved.statusCode).toBe(200);
  const project = ctx.store.createProject({ title: '港口故事' }); const branchId = project.mainBranchId; const baseRevisionId = ctx.store.getBranch(branchId).revisionId;
  const writing = ctx.engine.enqueue(branchId, 'generate', { baseRevisionId, mode: 'original', instruction: '阿青来到港口，安排后续故事。' });
  const job = () => ctx.engine.listJobs(project.id).find(job => job.id === writing.id)!;
  return { ...ctx, cookies, settings, project, branchId, baseRevisionId, writing, requests, job };
}

describe('writing planning tools through real provider adapters', () => {
  it.each<ProviderProtocol>(['openai-chat', 'openai-responses', 'gemini', 'claude'])('%s returns staged planning to the same writing model and saves prose with its future plan atomically', async protocol => {
    const held = deferred(); const finish = deferred();
    const ctx = await harness(protocol, async response => { held.resolve(); await finish.promise; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(proseRound(protocol)); });
    try {
      await held.promise;
      const staged = ctx.store.state(ctx.branchId);
      expect(ctx.store.getBranch(ctx.branchId).revisionId).toBe(ctx.baseRevisionId);
      expect(staged.chapters).toHaveLength(0); expect(staged.outline.fine).toEqual([]); expect(staged.foreshadows).toEqual([]);
      const writingRequests = ctx.requests.filter(request => request.model === 'writer'); expect(writingRequests).toHaveLength(2);
      const first = writingRequests[0].body; const second = writingRequests[1].body;
      expect(JSON.stringify(first.tools)).toContain('update_plot_plan');
      expect(JSON.stringify(second)).toContain('港口规划4'); expect(JSON.stringify(second)).toContain('staged');
      if (protocol === 'openai-chat') expect(second.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'plan-call' });
      else if (protocol === 'openai-responses') expect(second.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'plan-call' });
      else if (protocol === 'gemini') expect(second.contents.at(-1).parts[0].functionResponse).toMatchObject({ id: 'plan-call', name: 'update_plot_plan', response: { result: { status: 'staged' } } });
      else expect(second.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'plan-call' });
      if (protocol !== 'openai-chat') expect(JSON.stringify(second)).toContain('plan-signature');
      finish.resolve(); await until(() => ['completed', 'failed', 'stale'].includes(ctx.job().status));
      expect(ctx.job()).toMatchObject({ status: 'completed', inputTokens: 40, outputTokens: 28 });
      const saved = ctx.store.revisionState(ctx.job().baseRevisionId);
      expect(saved.chapters).toHaveLength(1); expect(saved.outline.fine).toEqual(plan().fine.slice(1));
      expect(saved.foreshadows).toMatchObject([{ title: '旧船秘密', status: 'planned', dueChapter: 4, relatedEntityIds: [] }]);
      expect(ctx.store.chapter(ctx.branchId, saved.chapters[0].id).text).toBe(text);
      expect(ctx.store.exportText(ctx.branchId)).toBe(`第 1 章\n\n${text}`);
      const output = ctx.engine.listOutputs(ctx.writing.id).find(output => output.status === 'applied')!;
      expect(ctx.store.revisionState(output.baseRevisionId).outline.fine).toEqual([]);
      expect(ctx.engine.listWritingActivities(ctx.writing.id)).toContainEqual(expect.objectContaining({ kind: 'tool', name: 'update_plot_plan', status: 'completed', result: expect.objectContaining({ status: 'staged' }) }));
      await until(() => ctx.engine.listJobs(ctx.project.id).some(job => job.kind === 'extract' && ['completed', 'failed'].includes(job.status)));
      expect(ctx.engine.listJobs(ctx.project.id).find(job => job.kind === 'extract')?.status).toBe('completed');
      expect(ctx.requests.map(request => request.model)).toEqual(['writer', 'writer', 'extractor']);
    } finally { finish.resolve(); }
  });

  it('retains failed HTTP output without applying staged planning or implicitly regenerating prose', async () => {
    const ctx = await harness('openai-chat', response => { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'fixture continuation failure' } })); });
    await until(() => ctx.job().status === 'failed');
    expect(ctx.requests.map(request => request.model)).toEqual(['writer', 'writer']);
    expect(ctx.store.getBranch(ctx.branchId).revisionId).toBe(ctx.baseRevisionId);
    expect(ctx.store.state(ctx.branchId).chapters).toEqual([]); expect(ctx.store.state(ctx.branchId).outline.fine).toEqual([]); expect(ctx.store.state(ctx.branchId).foreshadows).toEqual([]);
    expect(ctx.engine.listOutputs(ctx.writing.id).some(output => output.httpStatus === 503)).toBe(true);
  });

  it('discards staged planning after disabling it while the HTTP continuation is running', async () => {
    const held = deferred(); const finish = deferred();
    const ctx = await harness('openai-chat', async response => { held.resolve(); await finish.promise; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(proseRound('openai-chat')); });
    try {
      await held.promise;
      const updated = await ctx.app.inject({ method: 'PUT', url: '/api/settings', cookies: ctx.cookies, payload: { ...ctx.settings, taskSettings: { ...defaultTaskSettings(), planning: { enabled: false, mode: 'tool' } } } }); expect(updated.statusCode).toBe(200);
      finish.resolve(); await until(() => ['completed', 'failed'].includes(ctx.job().status));
      expect(ctx.job().status).toBe('completed'); const saved = ctx.store.revisionState(ctx.job().baseRevisionId);
      expect(saved.chapters).toHaveLength(1); expect(saved.outline.fine).toEqual([]); expect(saved.foreshadows).toEqual([]);
      expect(ctx.store.chapter(ctx.branchId, saved.chapters[0].id).text).toBe(text);
    } finally { finish.resolve(); }
  });

  it('feeds invalid planning parameters back to the writing model so it can correct them and continue prose', async () => {
    const ctx = await harness('openai-chat', (response, index) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(index === 1 ? toolRound('openai-chat') : proseRound('openai-chat')); }, { fine: plan().fine.slice(0, 3), foreshadows: [] });
    await until(() => ['completed', 'failed'].includes(ctx.job().status)); expect(ctx.job().status).toBe('completed');
    const writingRequests = ctx.requests.filter(request => request.model === 'writer'); expect(writingRequests).toHaveLength(3);
    expect(JSON.parse(writingRequests[1].body.messages.at(-1).content)).toMatchObject({ error: expect.stringContaining('四项规划') });
    expect(JSON.parse(writingRequests[2].body.messages.at(-1).content)).toMatchObject({ status: 'staged' });
    const saved = ctx.store.revisionState(ctx.job().baseRevisionId); expect(saved.outline.fine).toEqual(plan().fine.slice(1));
    expect(saved.foreshadows).toMatchObject([{ title: '旧船秘密', status: 'planned' }]); expect(ctx.store.chapter(ctx.branchId, saved.chapters[0].id).text).toBe(text);
    expect(ctx.requests.some(request => request.model === 'planner-forbidden')).toBe(false);
  });
});
