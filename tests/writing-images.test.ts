import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import type { ExtractionResult, Settings } from '../shared/types.js';

const fixtures: { store: Store; engine: StoryEngine }[] = [];
afterEach(async () => { for (const { store, engine } of fixtures.splice(0)) { await engine.close(); store.close(); } });
const prose = '林舟身穿青色长袍走进城门。\n城外千军万马正在迎战。';
const extracted = (): ExtractionResult => ({ summary: '林舟入城，城外大战。', entities: [{ kind: 'character', name: '林舟', aliases: [], description: '青色长袍', visibility: 'public', nameStatus: 'confirmed', facts: [{ text: '身穿青色长袍', attribute: 'appearance', temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 1, quote: '林舟身穿青色长袍走进城门。' }] }], relations: [], foreshadows: [] });
async function waitFor(done: () => boolean) { const end = Date.now() + 3000; while (!done()) { if (Date.now() > end) throw new Error('等待任务超时'); await new Promise(resolve => setTimeout(resolve, 5)); } }
function harness(autoCG: boolean, toolCalls = true, configured = true, imageFailure = false) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-writing-images-'))); const project = store.createProject({ title: '图片工具测试' });
  const settings: Settings = { providers: [{ id: 'fixture', name: '模拟', baseUrl: 'http://fixture.invalid/v1', protocol: 'openai-chat', model: 'text', maxOutputTokens: 1024, contextTokens: 64000 }], writingProviderId: 'fixture', planningProviderId: 'fixture', extractionProviderId: 'fixture', imageSettings: { ...defaultImageSettings(), providerId: configured ? 'fixture' : '', model: configured ? 'picture' : '', autoCG } };
  const generateAutomatic = vi.fn(() => { if (imageFailure) throw new Error('模拟生图失败'); });
  const models: TextModels = {
    generateText: vi.fn(async (_provider, request) => {
      if (toolCalls) {
        await request.tools?.find(tool => tool.name === 'generate_character_portrait')?.execute({ name: '林舟', description: '青色长袍' });
        await request.tools?.find(tool => tool.name === 'generate_scene_cg')?.execute({ sourceText: '城外千军万马正在迎战。', description: '战场大场面' });
      }
      request.onTextDelta?.(prose); return { text: prose, inputTokens: 10, outputTokens: 20 };
    }),
    generateStructured: vi.fn(async (_provider, _request, validate) => ({ value: validate(extracted()), inputTokens: 4, outputTokens: 8 })),
  };
  const engine = new StoryEngine(store, () => settings, models, { generateAutomatic } as any); fixtures.push({ store, engine }); engine.start();
  const job = engine.enqueue(project.mainBranchId, 'generate', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, mode: 'original', instruction: '写新人物与大战' });
  return { store, engine, project, job, models, generateAutomatic };
}

describe('writing illustration requests', () => {
  it('offers tools and binds their requests only after saved prose and confirmed entity extraction', async () => {
    const ctx = harness(true); await waitFor(() => ctx.engine.listJobs().filter(job => job.kind === 'extract').some(job => job.status === 'completed'));
    const request = vi.mocked(ctx.models.generateText).mock.calls[0][1];
    expect(request.system).toContain('每次切换场景'); expect(request.messages?.[0].content).toContain('generate_character_portrait');
    const state = ctx.store.state(ctx.project.mainBranchId); const chapter = state.chapters[0];
    expect(ctx.store.chapter(ctx.project.mainBranchId, chapter.id).text).toBe(prose);
    expect(ctx.generateAutomatic).toHaveBeenCalledTimes(1);
    expect(ctx.generateAutomatic.mock.calls[0].slice(0, 5)).toEqual([ctx.project.mainBranchId, expect.any(String), chapter.id, [{ kind: 'portrait', name: '林舟', description: '青色长袍' }, { kind: 'cg', description: '战场大场面', sourceText: '城外千军万马正在迎战。' }], [state.entities[0].id]]);
  });
  it('leaves automatic CG unavailable when disabled and still supplies newly extracted characters', async () => {
    const ctx = harness(false, false); await waitFor(() => ctx.generateAutomatic.mock.calls.length > 0);
    const request = vi.mocked(ctx.models.generateText).mock.calls[0][1];
    expect(request.tools?.some(tool => tool.name === 'generate_scene_cg')).toBe(false);
    expect(ctx.generateAutomatic.mock.calls[0][3]).toEqual([]); expect(ctx.generateAutomatic.mock.calls[0][4]).toHaveLength(1);
  });
  it('preserves successful prose and extraction if illustration registration fails', async () => {
    const ctx = harness(true, true, true, true); await waitFor(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed'));
    expect(ctx.engine.listJobs().every(job => job.status === 'completed')).toBe(true);
    expect(ctx.store.state(ctx.project.mainBranchId).chapters[0].status).toBe('ready'); expect(ctx.models.generateText).toHaveBeenCalledTimes(1);
  });
  it('does not expose illustration tools before an image model is configured', async () => {
    const ctx = harness(true, true, false); await waitFor(() => ctx.engine.listJobs().some(job => job.kind === 'extract' && job.status === 'completed'));
    expect(vi.mocked(ctx.models.generateText).mock.calls[0][1].tools?.some(tool => tool.name.startsWith('generate_'))).toBe(false);
  });
});
