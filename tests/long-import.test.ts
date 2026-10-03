import { expect, it } from 'vitest';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { StoryEngine, type TextModels } from '../server/engine.js';
import { Store } from '../server/store.js';
import type { ExtractionResult, Job, Settings } from '../shared/types.js';

it('imports over one million Chinese characters through 200 durable chapter jobs and keeps only compact checkpoints hot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-novel-long-import-'));
  let store: Store | undefined = new Store(directory);
  let engine: StoryEngine | undefined;
  const started = performance.now();
  const chapters = Array.from({ length: 200 }, (_, index) => ({
    title: `第${index + 1}章`,
    text: `阿青（青姑娘）抵达${index % 2 === 0 ? '江城' : '山城'}。\n${'青山白云'.repeat(1250)}\n${'夜雨灯火'.repeat(250)}`,
  }));
  const characterCount = chapters.reduce((count, chapter) => count + chapter.text.length, 0);
  expect(characterCount).toBeGreaterThanOrEqual(1_000_000);
  const config: Settings = {
    providers: [{ id: 'local-fixture', name: '本地模拟模型（不联网）', protocol: 'openai-chat', baseUrl: 'http://unused.invalid/v1', model: 'fixture', maxOutputTokens: 2048, contextTokens: 128000 }],
    writingProviderId: 'local-fixture', planningProviderId: 'local-fixture', extractionProviderId: 'local-fixture',
  };
  let requestCount = 0;
  const blocksPerChapter = new Map<number, number>();
  const models: TextModels = {
    generateText: async () => { throw new Error('导入任务不应生成正文'); },
    generateStructured: async (_provider, request, validate) => {
      requestCount++;
      // Use only the currently supplied source block, never model context or summaries.
      const sourceBlock = request.prompt.split('待整理章节 ').at(-1)!;
      const chapterNumber = Number(sourceBlock.match(/^第(\d+)章/)?.[1]);
      expect(chapterNumber).toBeGreaterThanOrEqual(1);
      expect(chapterNumber).toBeLessThanOrEqual(200);
      blocksPerChapter.set(chapterNumber, (blocksPerChapter.get(chapterNumber) ?? 0) + 1);
      const result: ExtractionResult = { summary: `第${chapterNumber}章的已发生片段`, entities: [], relations: [], foreshadows: [] };
      const event = sourceBlock.match(/\[1\] (阿青（青姑娘）抵达(江城|山城)。)/);
      if (event) {
        const [, quote, place] = event;
        result.entities.push({
          kind: 'character', name: chapterNumber % 2 ? '阿青' : '青姑娘', aliases: chapterNumber % 2 ? ['青姑娘'] : ['阿青'],
          description: `当前所在地为${place}`, visibility: 'public',
          facts: [{ text: `当前所在地为${place}`, attribute: 'location', temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 1, quote }],
        }, {
          kind: 'location', name: place, aliases: [], description: '沿途城镇', visibility: 'public',
          facts: [{ text: `第${chapterNumber}章阿青到达${place}`, temporal: 'past', certainty: 'fact', visibility: 'public', paragraph: 1, quote }],
        });
        result.relations.push({ from: '阿青', to: place, label: '到访', visibility: 'public', paragraph: 1, quote });
      }
      // The adapter validates our fixture through the production extraction schema.
      return { value: validate(result), inputTokens: 100, outputTokens: 50 };
    },
  };
  try {
    const project = store.createProject({ title: '百万字导入集成验收', premise: '阿青在两座城镇间旅行。' });
    // Observe every INSERT/UPDATE of the hot job row, including atomic chapter checkpoints.
    // The trigger writes sizes only; it does not retain duplicate source text or model prompts.
    store.db.exec(`CREATE TABLE test_job_sizes(size INTEGER NOT NULL, has_book INTEGER NOT NULL);
      CREATE TRIGGER test_job_insert AFTER INSERT ON jobs BEGIN
        INSERT INTO test_job_sizes VALUES(length(CAST(NEW.data AS BLOB)), json_type(NEW.data,'$.payload.chapters') IS NOT NULL);
      END;
      CREATE TRIGGER test_job_update AFTER UPDATE ON jobs BEGIN
        INSERT INTO test_job_sizes VALUES(length(CAST(NEW.data AS BLOB)), json_type(NEW.data,'$.payload.chapters') IS NOT NULL);
      END;`);
    engine = new StoryEngine(store, () => config, models);
    engine.start();
    const job = engine.enqueue(project.mainBranchId, 'import', { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, sourceId: 'million-word-original', chapters });
    let finished: Job | undefined;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      finished = engine.listJobs(project.id).find(j => j.id === job.id);
      if (finished && ['completed', 'failed', 'stale', 'cancelled'].includes(finished.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(finished?.error).toBeUndefined();
    expect(finished?.status).toBe('completed');
    expect(finished?.progress).toBe(200);
    expect(requestCount).toBe(400);
    expect(blocksPerChapter.size).toBe(200);
    expect([...blocksPerChapter.values()].every(count => count === 2)).toBe(true);
    const state = store.state(project.mainBranchId);
    expect(state.chapters).toHaveLength(200);
    expect(state.chapters.every(chapter => chapter.status === 'ready')).toBe(true);
    expect(state.entities).toHaveLength(3);
    const character = state.entities.find(entity => entity.kind === 'character')!;
    expect(new Set(character.aliases).size).toBe(character.aliases.length);
    expect(character.facts).toHaveLength(200);
    expect(character.facts.filter(fact => fact.attribute === 'location' && fact.temporal === 'current')).toMatchObject([{ text: '当前所在地为山城', certainty: 'fact' }]);
    expect(character.facts.filter(fact => fact.attribute === 'location' && fact.temporal === 'past')).toHaveLength(199);
    expect(state.relations).toHaveLength(200);
    const hotRows = store.db.prepare('SELECT max(size) AS largest,max(has_book) AS hasBook,count(*) AS saves FROM test_job_sizes').get()!;
    expect(Number(hotRows.largest)).toBeLessThan(20 * 1024);
    expect(Number(hotRows.hasBook)).toBe(0);
    expect(Number(hotRows.saves)).toBeGreaterThan(400);
    expect(store.db.prepare('SELECT count(*) AS n FROM job_import_chapters WHERE job_id=?').get(job.id)?.n).toBe(200);
    expect(store.db.prepare('SELECT count(*) AS n FROM chapter_texts').get()?.n).toBe(200);
    const finalRevision = store.getBranch(project.mainBranchId).revisionId;
    await engine.close(); engine = undefined;
    store.close(); store = undefined;
    store = new Store(directory);
    expect(store.getBranch(project.mainBranchId).revisionId).toBe(finalRevision);
    expect(store.state(project.mainBranchId).chapters.every(chapter => chapter.status === 'ready')).toBe(true);
    const first = store.chapter(project.mainBranchId, state.chapters[0].id);
    const last = store.chapter(project.mainBranchId, state.chapters[199].id);
    expect(first.text).toBe(chapters[0].text);
    expect(last.text).toBe(chapters[199].text);
    const persistedJob = JSON.parse(String(store.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id)!.data)) as Job;
    expect(persistedJob.status).toBe('completed'); expect(persistedJob.progress).toBe(200); expect(persistedJob.payload.chapters).toBeUndefined();
    const databaseBytes = readdirSync(directory).filter(name => name.startsWith('novel.sqlite')).reduce((bytes, name) => bytes + statSync(join(directory, name)).size, 0);
    console.info(`[long-import fixture] ${characterCount.toLocaleString()} characters; ${requestCount} simulated model calls; ${Math.round(performance.now() - started)} ms; DB ${databaseBytes.toLocaleString()} bytes; hot job max ${hotRows.largest} bytes.`);
  } finally {
    await engine?.close();
    store?.close();
  }
}, 150_000);
