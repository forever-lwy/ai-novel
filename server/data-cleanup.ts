import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defaultDataCleanupSettings, type CleanupPolicy, type DataCleanupReport, type DataCleanupSettings, type DataCleanupState } from '../shared/data-cleanup.js';
import type { Job, ModelOutputRecord, StoryImage } from '../shared/types.js';
import { retainedChapterIds } from './chapter-retention.js';
import { extractionEvidence } from './extraction-evidence.js';
import { applyHistoryCleanup, planHistoryCleanup } from './history-cleanup.js';
import { HttpError, type Store } from './store.js';
import type { SettingsStore } from './security.js';

const policySchema = z.object({ maxAgeDays: z.number().int().min(0).max(36500), maxCount: z.number().int().min(0).max(1000000) }).strict();
export const dataCleanupSettingsSchema = z.object({ enabled: z.boolean(), history: policySchema, requests: policySchema, jobs: policySchema }).strict();
const settingsKey = 'data-cleanup-settings', reportKey = 'data-cleanup-last-run';
const ended = (job: Job) => ['completed', 'cancelled', 'stale'].includes(job.status);
type CleanupOutput = Pick<ModelOutputRecord, 'id' | 'jobId' | 'projectId' | 'branchId' | 'baseRevisionId' | 'stage' | 'status' | 'chapterId' | 'createdAt'> & { hasEvidence: boolean };
function candidates<T extends { id: string }>(items: T[], policy: CleanupPolicy, now: number, groupOf: (item: T) => string, timeOf: (item: T) => string): Set<string> {
  const groups = new Map<string, T[]>(), ids = new Set<string>();
  for (const item of items) { const key = groupOf(item), group = groups.get(key) ?? []; group.push(item); groups.set(key, group); }
  for (const group of groups.values()) {
    // Input is in row order; reverse stable ties so that the newest stored record wins.
    group.reverse().sort((a, b) => Date.parse(timeOf(b)) - Date.parse(timeOf(a)));
    for (const [index, item] of group.entries()) {
      const time = Date.parse(timeOf(item));
      if (Number.isFinite(time) && (policy.maxAgeDays > 0 && time < now - policy.maxAgeDays * 86400000 || policy.maxCount > 0 && index >= policy.maxCount)) ids.add(item.id);
    }
  }
  return ids;
}

export class DataCleanupService {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private store: Store, private settingsStore: SettingsStore, private activeJobs: () => ReadonlySet<string> = () => new Set(), private onError: (error: unknown) => void = () => {}) {}
  state(): DataCleanupState {
    const value = this.settingsStore.meta(settingsKey), last = this.settingsStore.meta(reportKey);
    return { settings: value ? dataCleanupSettingsSchema.parse(JSON.parse(value)) : defaultDataCleanupSettings(), ...(last ? { lastRun: JSON.parse(last) as DataCleanupReport } : {}) };
  }
  save(settings: DataCleanupSettings): DataCleanupState {
    this.settingsStore.setMeta(settingsKey, JSON.stringify(dataCleanupSettingsSchema.parse(settings)));
    return this.state();
  }
  private plan(settings: DataCleanupSettings, now = Date.now()) {
    const db = this.store.db;
    const jobs = db.prepare('SELECT data FROM jobs ORDER BY rowid').all().map(row => JSON.parse(String(row.data)) as Job);
    const outputs = db.prepare(`SELECT json_object('id',id,'jobId',job_id,'projectId',project_id,'branchId',branch_id,'baseRevisionId',base_revision_id,'stage',stage,'status',status,'chapterId',chapter_id,'createdAt',created_at,
      'hasEvidence',stage='extraction' AND status='applied' AND COALESCE(length(json_extract(data,'$.normalizedText')),0)>0 AND chapter_id IS NOT NULL) AS data FROM model_outputs ORDER BY rowid`).all().map(row => JSON.parse(String(row.data)) as CleanupOutput);
    const jobMap = new Map(jobs.map(job => [job.id, job]));
    const images = db.prepare('SELECT data FROM image_assets').all().map(row => JSON.parse(String(row.data)) as StoryImage);
    const jobCandidates = candidates(jobs.filter(ended), settings.jobs, now, job => job.projectId, job => job.updatedAt);
    const requestCandidates = candidates(outputs, settings.requests, now, output => output.projectId, output => output.createdAt);
    const activeJobs = this.activeJobs(), protectedJobs = new Set(activeJobs), requestJobs = new Set<string>();
    const protectedRequests = new Set<string>();
    for (const job of jobs) {
      const branch = this.store.getBranch(job.branchId, true);
      if (!ended(job) || job.payload.pendingCGChapterId || job.payload.pendingIllustrationChapterId || job.payload.pendingTitleChapterId ||
        job.status === 'completed' && job.payload.purpose === 'compress-summary' && branch.revisionId === job.baseRevisionId) protectedJobs.add(job.id);
      // A failed or paused request remains available for repair/resume, including partial output.
      if (!ended(job) || activeJobs.has(job.id) || job.status === 'completed' && job.payload.purpose === 'compress-summary' && branch.revisionId === job.baseRevisionId) requestJobs.add(job.id);
    }
    for (const output of outputs) if (requestJobs.has(output.jobId)) { protectedRequests.add(output.id); protectedJobs.add(output.jobId); }
    for (const image of images) if ((image.bindingStatus === 'pending' || image.bindingStatus === 'discarded' || ['queued', 'running', 'paused'].includes(image.status)) && image.writingJobId) protectedJobs.add(image.writingJobId);
    let history = planHistoryCleanup(this.store, settings.history, now);
    for (const jobId of history.protectedJobIds) protectedJobs.add(jobId);
    // Dependencies are followed from every task that will survive, including its original writing task.
    let changed = true;
    while (changed) {
      changed = false;
      for (const job of jobs) if (!jobCandidates.has(job.id) || protectedJobs.has(job.id)) {
        const owner = job.payload.writingJobId;
        if (typeof owner === 'string' && jobMap.has(owner) && !protectedJobs.has(owner)) { protectedJobs.add(owner); changed = true; }
      }
    }
    const deleteJobs = new Set([...jobCandidates].filter(id => !protectedJobs.has(id)));
    const deleteRequests = new Set<string>();
    const recomputeRequests = () => {
      deleteRequests.clear();
      for (const output of outputs) if ((requestCandidates.has(output.id) || deleteJobs.has(output.jobId)) && !protectedRequests.has(output.id)) deleteRequests.add(output.id);
    };
    // Removing histories may rescue an RPG choice task. Reach a stable protection closure first.
    do {
      recomputeRequests(); changed = false;
      history = planHistoryCleanup(this.store, settings.history, now, { deleteJobIds: deleteJobs, deleteOutputIds: deleteRequests });
      for (const id of history.protectedJobIds) if (deleteJobs.delete(id)) changed = true;
      for (const job of jobs) if (!deleteJobs.has(job.id) && typeof job.payload.writingJobId === 'string' && deleteJobs.delete(job.payload.writingJobId)) changed = true;
    } while (changed);
    const beforeChapters = retainedChapterIds(db);
    const remainingChapters = retainedChapterIds(db, { deleteRevisionIds: new Set(history.deleteIds), deleteJobIds: deleteJobs, deleteOutputIds: deleteRequests });
    const deleteChapters = [...beforeChapters].filter(id => !remainingChapters.has(id));
    const fingerprint = createHash('sha256').update(JSON.stringify([this.store.cacheVersion(), settings, history.deleteIds, history.updates, [...deleteJobs], [...deleteRequests], deleteChapters])).digest('hex');
    const report: DataCleanupReport = { revisions: history.deleteIds.length, requests: deleteRequests.size, jobs: deleteJobs.size, chapters: deleteChapters.length, images: 0,
      protectedRevisions: history.protectedCount, protectedRequests: [...requestCandidates].filter(id => !deleteRequests.has(id)).length,
      protectedJobs: [...jobCandidates].filter(id => !deleteJobs.has(id)).length, fingerprint };
    return { history, jobs, outputs, deleteJobs, deleteRequests, deleteChapters, report };
  }
  preview(settings: DataCleanupSettings): DataCleanupReport { return this.plan(dataCleanupSettingsSchema.parse(settings)).report; }
  run(settings: DataCleanupSettings, expectedFingerprint?: string): DataCleanupReport {
    settings = dataCleanupSettingsSchema.parse(settings);
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const plan = this.plan(settings);
      if (expectedFingerprint !== undefined && plan.report.fingerprint !== expectedFingerprint) throw new HttpError('记录已变化，请重新预览清理范围后再确认。', 409);
      for (const output of plan.outputs) if (plan.deleteRequests.has(output.id)) {
        const evidence = output.hasEvidence ? extractionEvidence(JSON.parse(String(db.prepare("SELECT json_remove(data,'$.rawResponse','$.text','$.editedText','$.request','$.diagnostics','$.issues') AS data FROM model_outputs WHERE id=?").get(output.id)!.data)) as ModelOutputRecord) : undefined;
        if (evidence) db.prepare('INSERT OR REPLACE INTO extraction_evidence VALUES(?,?,?)').run(evidence.id, evidence.projectId, JSON.stringify(evidence));
        db.prepare('DELETE FROM model_outputs WHERE id=?').run(output.id);
      }
      for (const job of plan.jobs) if (!plan.deleteJobs.has(job.id) && typeof job.payload.lastOutputId === 'string' && plan.deleteRequests.has(job.payload.lastOutputId)) {
        db.prepare("UPDATE jobs SET data=json_remove(data,'$.payload.lastOutputId') WHERE id=?").run(job.id);
      }
      for (const jobId of plan.deleteJobs) {
        for (const table of ['job_import_chapters', 'job_writing_drafts', 'job_writing_activities']) db.prepare(`DELETE FROM ${table} WHERE job_id=?`).run(jobId);
        db.prepare('DELETE FROM jobs WHERE id=?').run(jobId);
      }
      applyHistoryCleanup(this.store, plan.history);
      for (const chapterId of plan.deleteChapters) {
        db.prepare('DELETE FROM chapter_search WHERE id=?').run(chapterId);
        db.prepare('DELETE FROM chapter_texts WHERE id=?').run(chapterId);
      }
      const report = { ...plan.report, completedAt: new Date().toISOString() };
      this.settingsStore.setMeta(reportKey, JSON.stringify(report));
      db.exec('COMMIT'); return report;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  start() {
    if (this.timer) return;
    const tick = () => { try { const settings = this.state().settings; if (settings.enabled) this.run(settings); } catch (error) { this.onError(error); } };
    tick(); this.timer = setInterval(tick, 3600000); this.timer.unref();
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

export function registerDataCleanupRoutes(app: FastifyInstance, cleanup: DataCleanupService) {
  const body = z.object({ settings: dataCleanupSettingsSchema }).strict();
  app.get('/api/data-cleanup', async () => cleanup.state());
  app.put('/api/data-cleanup', async request => cleanup.save(body.parse(request.body).settings));
  app.post('/api/data-cleanup/preview', async request => cleanup.preview(body.parse(request.body).settings));
  app.post('/api/data-cleanup/run', async request => {
    const input = body.extend({ expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
    return cleanup.run(input.settings, input.expectedFingerprint);
  });
}
