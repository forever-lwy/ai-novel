import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { SettingsStore } from '../server/security.js';
import { DataCleanupService } from '../server/data-cleanup.js';
import { defaultDataCleanupSettings } from '../shared/data-cleanup.js';
import type { Job, ModelOutputRecord } from '../shared/types.js';
import { legacyReadingProgressStory, mixedVisibilityStory } from './fixtures/reading-progress.js';

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'novel-cleanup-'));
  const store = new Store(directory), settings = new SettingsStore(store.db, directory), service = new DataCleanupService(store, settings);
  disposals.push(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, settings, service };
}
function addJob(store: Store, branchId: string, status: Job['status'] = 'completed', createdAt = '2000-01-01T00:00:00.000Z', payload: Job['payload'] = {}) {
  const job: Job = { id: randomUUID(), branchId, projectId: store.getBranch(branchId).projectId, baseRevisionId: store.getBranch(branchId).revisionId, kind: 'extract', status,
    progress: 0, total: 0, message: '', inputTokens: 0, outputTokens: 0, createdAt, updatedAt: createdAt, payload };
  store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, job.branchId, job.projectId, job.status, JSON.stringify(job));
  return job;
}
function output(store: Store, job: Job, date = job.createdAt) {
  const record = store.outputs.create({ jobId: job.id, projectId: job.projectId, branchId: job.branchId, baseRevisionId: job.baseRevisionId, stage: 'writing' }, { rawResponse: 'RAW_PRIVATE_RESPONSE', text: 'saved text', inputTokens: 0, outputTokens: 0 });
  record.createdAt = date;
  store.db.prepare('UPDATE model_outputs SET created_at=?,data=? WHERE id=?').run(date, JSON.stringify(record), record.id);
  return record;
}
function policy() { const settings = defaultDataCleanupSettings(); settings.requests.maxAgeDays = 1; return settings; }

describe('data cleanup dependencies and compatibility', () => {
  it('supports days OR counts per project, and clears requests independently of tasks and their last-output pointer', () => {
    const { store, service } = setup();
    const projects = [store.createProject({ title: '一' }), store.createProject({ title: '二' })];
    for (const project of projects) {
      const owner = addJob(store, project.mainBranchId);
      const records = ['2000-01-01', '2000-01-02', '2999-01-01'].map(date => output(store, owner, `${date}T00:00:00.000Z`));
      owner.payload.lastOutputId = records[1].id;
      store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(owner), owner.id);
    }
    const settings = policy(); settings.requests.maxCount = 2;
    const report = service.run(settings, service.preview(settings).fingerprint);
    expect(report).toMatchObject({ requests: 4, jobs: 0 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM model_outputs').get()!.n).toBe(2);
    const jobs = store.db.prepare('SELECT data FROM jobs').all().map(row => JSON.parse(String(row.data)) as Job);
    expect(jobs.every(job => !job.payload.lastOutputId)).toBe(true);
    for (const project of projects) expect(() => store.restoreProject(store.exportProject(project.id))).not.toThrow();
  });

  it('keeps resumable, in-flight and pending confirmation work with its diagnostic records', () => {
    const { store, settings: settingsStore } = setup(), project = store.createProject({ title: '保护任务' });
    const jobs = (['queued', 'running', 'paused', 'failed'] as const).map(status => addJob(store, project.mainBranchId, status));
    const compression = addJob(store, project.mainBranchId, 'completed', undefined, { purpose: 'compress-summary', compressionText: '等待确认' });
    const inFlight = addJob(store, project.mainBranchId);
    const pendingImage = addJob(store, project.mainBranchId, 'completed', undefined, { pendingCGChapterId: 'awaiting' });
    [...jobs, compression, inFlight, pendingImage].forEach(job => output(store, job));
    const service = new DataCleanupService(store, settingsStore, () => new Set([inFlight.id]));
    const settings = policy(); settings.jobs.maxAgeDays = 1;
    const result = service.run(settings);
    expect(result.jobs).toBe(0); expect(result.protectedJobs).toBe(3);
    // Pending local image association does not need old raw text diagnostics.
    expect(result.requests).toBe(1);
    for (const job of [...jobs, compression, inFlight]) expect(store.outputs.list(job.id)).toHaveLength(1);
  });

  it.each([false, true])('compacts applied extraction wire data while keeping effective visibility and backup recovery (legacy=%s)', legacy => {
    const { store, service } = setup();
    const ctx = legacy ? legacyReadingProgressStory(store) : mixedVisibilityStory(store, true);
    const beforeAuthor = store.state(ctx.branchId), beforeReader = store.readingState(ctx.branchId);
    const recordCount = store.outputs.all(ctx.project.id).length;
    for (const record of store.outputs.all(ctx.project.id)) {
      record.createdAt = '2000-01-01T00:00:00.000Z'; record.rawResponse = 'RAW_PRIVATE_RESPONSE';
      record.request = { protocol: 'gemini', model: 'fixture', url: 'https://fixture.test', method: 'POST', headers: {}, body: 'PRIVATE_FULL_PROMPT', startedAt: record.createdAt, timeoutMs: 1000, stream: false };
      store.db.prepare('UPDATE model_outputs SET created_at=?,data=? WHERE id=?').run(record.createdAt, JSON.stringify(record), record.id);
    }
    for (const row of store.db.prepare('SELECT data FROM jobs WHERE project_id=?').all(ctx.project.id)) {
      const job = JSON.parse(String(row.data)) as Job; job.updatedAt = '2000-01-01T00:00:00.000Z';
      store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id);
    }
    const cleanup = policy(); cleanup.jobs.maxAgeDays = 1;
    const report = service.run(cleanup);
    expect(report.requests).toBe(recordCount); expect(store.outputs.all(ctx.project.id)).toEqual([]);
    expect(report.jobs).toBe(1);
    expect(store.extractionEvidence(ctx.project.id)).toHaveLength(recordCount);
    expect(JSON.stringify(store.extractionEvidence(ctx.project.id))).not.toMatch(/PRIVATE_FULL_PROMPT|RAW_PRIVATE_RESPONSE/);
    expect(store.state(ctx.branchId)).toEqual(beforeAuthor); expect(store.readingState(ctx.branchId)).toEqual(beforeReader);
    const backup = store.exportProject(ctx.project.id), restored = store.restoreProject(backup);
    expect(store.readingState(restored.mainBranchId).entities.map(entity => [entity.name, entity.visibility])).toEqual(beforeReader.entities.map(entity => [entity.name, entity.visibility]));
    expect(store.outputs.all(restored.id)).toEqual([]); expect(store.extractionEvidence(restored.id)).toHaveLength(recordCount);
    expect(store.db.prepare('SELECT count(*) AS n FROM jobs WHERE project_id=?').get(restored.id)!.n).toBe(0);
    const forged = structuredClone(backup); forged.extractionEvidence[0].baseRevisionId = 'missing';
    expect(() => store.restoreProject(forged)).toThrow('依据关联');
    store.deleteProject(ctx.project.id); expect(store.extractionEvidence(ctx.project.id)).toEqual([]);
  });

  it('removes terminal tasks with their requests, drafts and activities without overriding the request policy', () => {
    const { store, service } = setup(); const project = store.createProject({ title: '结束任务' });
    const owner = addJob(store, project.mainBranchId); output(store, owner);
    store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?)').run(owner.id, '未保存草稿');
    store.db.prepare('INSERT INTO job_writing_activities VALUES(?,?,?)').run(owner.id, 'activity', '{}');
    const settings = defaultDataCleanupSettings(); settings.jobs.maxAgeDays = 1;
    const result = service.run(settings); expect(result).toMatchObject({ jobs: 1, requests: 1 });
    for (const table of ['jobs', 'model_outputs', 'job_writing_drafts', 'job_writing_activities']) expect(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
  });

  it('cleans cancelled summary candidates together with their outputs without leaving dangling task references', () => {
    const { store, service } = setup(); const project = store.createProject({ title: '已取消压缩' });
    const owner = addJob(store, project.mainBranchId, 'cancelled', undefined, { purpose: 'compress-summary' }); output(store, owner);
    const settings = policy(); settings.jobs.maxAgeDays = 1;
    expect(service.run(settings)).toMatchObject({ jobs: 1, requests: 1 });
    expect(() => store.restoreProject(store.exportProject(project.id))).not.toThrow();
  });

  it('protects the writing owner of a surviving placement task and rolls all deletion back on storage failure', () => {
    const { store, service, settings } = setup(); const project = store.createProject({ title: '关联和回滚' });
    const owner = addJob(store, project.mainBranchId); output(store, owner);
    addJob(store, project.mainBranchId, 'failed', undefined, { writingJobId: owner.id });
    const cleanup = policy(); cleanup.jobs.maxAgeDays = 1;
    expect(service.preview(cleanup)).toMatchObject({ jobs: 0, requests: 1, protectedJobs: 1 });
    store.db.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON model_outputs BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END");
    expect(() => service.run(cleanup)).toThrow('fixture storage failure');
    expect(store.outputs.list(owner.id)).toHaveLength(1); expect(settings.meta('data-cleanup-last-run')).toBeUndefined();
  });

  it('keeps old prose edit bodies in backups after intermediate versions are cleaned', () => {
    const { store, service } = setup(); const project = store.createProject({ title: '正文修订' }); const branchId = project.mainBranchId;
    let view = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title: '初章', text: '旧正文' });
    const oldChapter = view.state.chapters[0].id;
    view = store.saveChapter(branchId, { baseRevisionId: view.branch.revisionId, chapterId: oldChapter, title: '初章', text: '新正文' });
    for (let index = 0; index < 4; index++) view = store.commit(branchId, view.branch.revisionId, store.state(branchId), '设定修订');
    const settings = defaultDataCleanupSettings(); settings.history.maxCount = 1;
    const result = service.run(settings); expect(result.revisions).toBeGreaterThan(0);
    expect(store.chapter(branchId, store.state(branchId).chapters[0].id).text).toBe('新正文');
    const backup = store.exportProject(project.id); expect(backup.chapters.some(chapter => chapter.id === oldChapter)).toBe(true);
    const restored = store.restoreProject(backup); expect(store.chapter(restored.mainBranchId, store.state(restored.mainBranchId).chapters[0].id).text).toBe('新正文');
  });
});
