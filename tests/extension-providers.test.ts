import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { strToU8 } from 'fflate';
import { buildApp } from '../server/app.js';
import { importSkill } from '../server/skill-import.js';
import { buildRequestSnapshot, generateText } from '../server/providers.js';
import { StoryEngine } from '../server/engine.js';
import { compileTaskPrompt, defaultPromptTemplates } from '../shared/prompt-templates.js';
import type { ModelActivityEvent, ModelToolContinuation, ProviderConfig, ProviderProtocol } from '../shared/types.js';
import { listenLocalServer } from './local-server.mjs';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [], servers: Server[] = [], engines: StoryEngine[] = [];
afterEach(async () => { for (const engine of engines.splice(0)) await engine.close(); for (const app of apps.splice(0)) await app.app.close(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } });
type Call = { name: string; args: Record<string, unknown> };
function response(protocol: ProviderProtocol, call?: Call, text = '') {
  if (protocol === 'openai-chat') return { choices: [{ message: { role: 'assistant', content: text, ...(call ? { tool_calls: [{ id: 'call-1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  if (protocol === 'openai-responses') return { status: 'completed', output: call ? [{ type: 'function_call', id: 'item-1', call_id: 'call-1', name: call.name, arguments: JSON.stringify(call.args) }] : [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 2 } };
  if (protocol === 'gemini') return { candidates: [{ content: { role: 'model', parts: call ? [{ functionCall: { id: 'call-1', name: call.name, args: call.args }, thoughtSignature: 'fixture-signature' }] : [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
  return { content: call ? [{ type: 'tool_use', id: 'call-1', name: call.name, input: call.args }] : [{ type: 'text', text }], stop_reason: call ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } };
}
async function setup(protocol: ProviderProtocol, mode: 'native' | 'wrapped' | 'carrier') {
  const ctx = await buildApp({ dataDir: mkdtempSync(join(tmpdir(), 'novel-extension-protocol-')), initialPassword: 'extensions-protocol-123', startEngine: false }); apps.push(ctx);
  const skill = importSkill('SKILL.md', strToU8('---\nname: scene-check\ndescription: 检查连贯性\n---\nSKILL_INSTRUCTIONS_DEFERRED'));
  skill.enabled = true; skill.files.push({ path: 'references/check.md', encoding: 'utf8', content: 'ATTACHMENT_DEFERRED' });
  ctx.extensions.save({ ...ctx.extensions.public(), scripts: [{ id: 'check', name: '统计', description: '核对篇幅', code: '// SCRIPT_SOURCE_NEVER_SENT\nreturn { count: args.text.length };', timeoutMs: 10000, enabled: true, inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'SCHEMA_DETAIL_DEFERRED' } }, required: ['text'], additionalProperties: false } }], skills: [skill] });
  const calls: Call[] = [{ name: 'load_extension', args: { id: `skill:${skill.id}` } }, { name: 'read_skill_resource', args: { id: `skill:${skill.id}`, path: 'references/check.md' } }, { name: 'load_extension', args: { id: 'script:check' } }, { name: 'run_extension', args: { id: 'script:check', argumentsJson: JSON.stringify({ text: '城门的灯亮了' }) } }];
  const bodies: any[] = [];
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const next = calls[bodies.length - 1]; const prose = next ? '' : '城门的灯亮了。';
    const call = mode === 'wrapped' ? { name: 'emit_writing_response', args: { prose, toolCalls: next ? [{ name: next.name, argumentsJson: JSON.stringify(next.args) }] : [] } } : !next && mode === 'carrier' ? { name: 'deliver_story', args: { text: prose } } : next;
    reply.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response(protocol, call, prose)));
  }); servers.push(server); await listenLocalServer(server);
  const provider: ProviderConfig = { id: 'fixture', name: 'local', protocol, baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, model: 'writer', maxOutputTokens: 1000, contextTokens: 64000, stream: false, timeoutMs: 10000 };
  return { ctx, bodies, provider };
}

describe('progressive extensions across writing transports', () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'gemini', 'claude'] as const) {
    it.each(['native', 'wrapped', 'carrier'] as const)(`${protocol} / %s discloses each layer only after its request and records actual tool results`, async mode => {
      const { ctx, bodies, provider } = await setup(protocol, mode);
      const session = ctx.extensions.session(); const activities: ModelActivityEvent[] = [], checkpoints: ModelToolContinuation[] = [];
      const request = compileTaskPrompt(defaultPromptTemplates(), 'writing', { mode: 'original', context: '一座城', maxWords: '1000' }, { extensionsCatalog: session.catalog });
      const result = await generateText(provider, { ...request, responseCarrier: mode === 'carrier' ? { name: 'deliver_story', field: 'text' } : undefined, writingOutputMode: mode === 'native' ? 'text' : 'tool', tools: session.tools, maxToolRounds: 10, extensionLoads: session.loaded, onActivity: event => activities.push(event), onContinuation: continuation => { checkpoints.push(continuation); } });
      expect(result.text).toBe('城门的灯亮了。'); expect(bodies).toHaveLength(5);
      const wire = bodies.map(body => JSON.stringify(body));
      expect(wire[0]).toContain('核对篇幅');
      for (const secret of ['SCHEMA_DETAIL_DEFERRED', 'SKILL_INSTRUCTIONS_DEFERRED', 'ATTACHMENT_DEFERRED']) expect(wire[0]).not.toContain(secret);
      expect(wire[1]).toContain('SKILL_INSTRUCTIONS_DEFERRED'); expect(wire[1]).not.toContain('ATTACHMENT_DEFERRED');
      expect(wire[2]).toContain('ATTACHMENT_DEFERRED'); expect(wire[2]).not.toContain('SCHEMA_DETAIL_DEFERRED');
      expect(wire[3]).toContain('SCHEMA_DETAIL_DEFERRED'); expect(wire[4]).toContain('count');
      expect(wire.join('')).not.toContain('SCRIPT_SOURCE_NEVER_SENT');
      expect(activities.filter(event => event.type === 'tool_call')).toHaveLength(4);
      expect(activities.find(event => event.type === 'tool_result' && event.name === 'run_extension')).toMatchObject({ result: { count: 6 } });
      expect(checkpoints.at(-1)?.extensionLoads?.['script:check']).toMatch(/^[a-f0-9]{64}$/);
    });
  }
  it('connects the real writing engine to extensions, saves clean prose and separate tool activity, then extracts', async () => {
    const { ctx, provider } = await setup('openai-chat', 'native');
    const settings = { ...ctx.settings.get(), providers: [provider], writingProviderId: provider.id, writingModel: provider.model, extractionProviderId: provider.id, extractionModel: provider.model, planningProviderId: provider.id, planningModel: provider.model };
    const structured = vi.fn(async (_provider, _request, validate) => ({ value: validate({ summary: '灯亮了', entities: [], relations: [], foreshadows: [] }), inputTokens: 1, outputTokens: 1 }));
    const textModel = vi.fn(generateText);
    const engine = new StoryEngine(ctx.store, () => settings, { generateText: textModel, generateStructured: structured }, undefined, ctx.extensions); engines.push(engine); engine.start();
    const project = ctx.store.createProject({ title: '扩展集成' }); const branch = ctx.store.getBranch(project.mainBranchId);
    const job = engine.enqueue(branch.id, 'generate', { baseRevisionId: branch.revisionId, mode: 'original', instruction: '写一段', title: '城灯', maxWords: 1000 });
    await vi.waitFor(() => expect(['completed', 'failed']).toContain(engine.listJobs().find(item => item.id === job.id)?.status), { timeout: 15000, interval: 20 });
    const finished = engine.listJobs().find(item => item.id === job.id)!;
    expect(finished.status, finished.error).toBe('completed');
    const preview = engine.previewPrompt({ task: 'writing', templates: defaultPromptTemplates(), variables: { mode: 'original' }, runtime: {}, protocol: 'openai-chat' });
    const actual = JSON.parse(buildRequestSnapshot(provider, textModel.mock.calls[0][1]).body);
    expect(actual.tools.map((tool: any) => tool.function.name)).toEqual(preview.tools.map(tool => tool.name));
    const state = ctx.store.state(branch.id); expect(ctx.store.chapter(branch.id, state.chapters[0].id).text).toBe('城门的灯亮了。');
    const activities = JSON.stringify(ctx.store.listWritingActivities(job.id)); expect(activities).toContain('run_extension'); expect(activities).toContain('count');
    await vi.waitFor(() => expect(structured).toHaveBeenCalled(), { timeout: 5000 });
  });
});
