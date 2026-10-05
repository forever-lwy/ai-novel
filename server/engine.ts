import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CapturedModelResponse, ExtractionResult, GenerateInput, Job, JobKind, ModelActivityEvent, ModelOutputDetail, ModelOutputRecord, ModelOutputSummary, ModelRequest, OutputIssue, OutputStage, PlanningResult, ProviderConfig, Settings, StoryState, WritingActivity, WritingEvent, PromptTask } from '../shared/types.js';
import { normalizeModelSettings, resolveModelConfig } from '../shared/model-settings.js';
import { normalizeTaskSettings } from '../shared/task-settings.js';
import { compilePrompt, normalizePromptTemplates } from '../shared/prompt-templates.js';
import { generateStructured, generateText, estimateModelRequestInputTokens, ModelOutputError, parseStructuredText, redactModelPayload, unwrapModelOutput, structuredRequest, validateProviderOptions } from './providers.js';
import { HttpError, OutputValidationError, Store } from './store.js';
import { extractionContext, normalizeExtraction, splitExtractionBlocks as splitBlocks } from './extraction.js';
import { buildWritingContext } from './writing-context.js';
import type { ImageService } from './images.js';
import { normalizeImageSettings } from '../shared/image-settings.js';
import type { ModelTool, WritingImageRequest } from '../shared/types.js';
export { extractionSchema } from './extraction.js';

const foreshadowSchema = z.object({ title: z.string().min(1), detail: z.string(), status: z.enum(['planned', 'planted', 'resolved', 'abandoned']), dueChapter: z.number().int().positive().optional(), revealCondition: z.string(), relatedNames: z.array(z.string()) });
export const planningSchema = z.object({ fine: z.array(z.object({ chapter: z.number().int().positive(), title: z.string(), goal: z.string() })).min(1), foreshadows: z.array(foreshadowSchema) });
const now = () => new Date().toISOString();
const estimateTokens = (text: string) => Math.ceil([...text].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 1.3 : 0.3), 0));
const MAX_COMPRESSION_PASSES = 3;
interface CompressionWork { pass: number; chunks: string[]; index: number; results: string[]; completed: number }
const requestTokens = (provider: ProviderConfig, request: ModelRequest) => request.messages?.length || request.tools?.length ? estimateModelRequestInputTokens(provider, request) : estimateTokens(request.system + request.prompt);
/** Size segments using the selected template, including repeated variables and JSON requirements. */
function compressionChunks(source: string, provider: ProviderConfig, build: (text: string) => ModelRequest): string[] {
  // A whitespace-only sizing probe still needs a user message; it is never sent to the model.
  const fits = (text: string) => requestTokens(provider, build(text.trim() ? text : `${text}\u200b`)) + provider.maxOutputTokens <= provider.contextTokens;
  const characters = [...source]; const chunks: string[] = [];
  if (!fits(characters[0] ?? ' ')) throw new HttpError('摘要压缩提示词与完整输出上限已超出规划模型的上下文，请缩短提示词或提高上下文上限');
  for (let start = 0; start < characters.length;) {
    let low = 0; let high = Math.min(characters.length - start, Math.ceil(provider.contextTokens / 0.3));
    while (low < high) {
      const size = Math.ceil((low + high) / 2);
      if (fits(characters.slice(start, start + size).join(''))) low = size; else high = size - 1;
    }
    if (!low) throw new HttpError('摘要压缩提示词没有足够空间容纳摘要内容，请缩短提示词或提高上下文上限');
    let end = start + low;
    if (end < characters.length) {
      const lastBreak = characters.slice(start, end).lastIndexOf('\n') + start + 1;
      if (lastBreak > start + low / 2) end = lastBreak;
    }
    chunks.push(characters.slice(start, end).join('')); start = end;
  }
  return chunks;
}

export interface TextModels { generateText: typeof generateText; generateStructured: typeof generateStructured }
/** Durable, single-writer-per-story queue. Progress and story revisions commit in one SQLite transaction. */
export class StoryEngine {
  private controllers = new Map<string, AbortController>();
  private runs = new Map<string, Promise<void>>();
  private writingListeners = new Map<string, Set<(event: WritingEvent) => void>>();
  private deletingProjects = new Set<string>();
  private started = false;
  private closed = false;
  private chargedExtractionErrors = new WeakSet<ModelOutputError>();
  private nonRetryableExtractionErrors = new WeakSet<Error>();
  constructor(private store: Store, private getSettings: () => Settings, private models: TextModels = { generateText, generateStructured }, private images?: Pick<ImageService, 'generateAutomatic'>) {}
  start() {
    if (this.started) return; this.started = true;
    // Upgrade pre-release queues once; prose belongs in immutable input rows, never in the hot job record.
    for (const job of this.jobsInternal()) if (Array.isArray(job.payload.chapters)) {
      const chapters = job.payload.chapters as { title: string; text: string }[];
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        const insert = this.store.db.prepare('INSERT OR IGNORE INTO job_import_chapters VALUES(?,?,?,?)');
        chapters.forEach((c, index) => insert.run(job.id, index, c.title, c.text));
        delete job.payload.chapters; this.save(job); this.store.db.exec('COMMIT');
      } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
    }
    for (const job of this.jobsInternal()) if (job.status === 'running' || job.status === 'completed' && typeof job.payload.pendingIllustrationChapterId === 'string') { job.status = 'paused'; job.message = '服务已重启；已保存整理进度，请手动继续'; this.save(job); }
    this.pump();
  }
  async close() {
    this.closed = true;
    for (const [jobId, controller] of this.controllers) {
      const job = this.get(jobId);
      if (job.kind === 'generate' && job.status === 'running') { job.status = 'paused'; job.message = '服务已停止；生成过程已保留，请手动继续'; this.save(job); }
      controller.abort();
    }
    await Promise.allSettled([...this.runs.values()]);
  }
  async deleteProject(projectId: string, cleanup?: () => void) {
    this.store.getProject(projectId);
    if (this.deletingProjects.has(projectId)) throw new HttpError('作品正在删除，请稍候', 409);
    this.deletingProjects.add(projectId);
    try {
      const jobs = this.jobsInternal(projectId);
      for (const job of jobs) {
        if (['queued', 'running', 'paused', 'failed'].includes(job.status)) {
          job.status = 'cancelled'; job.message = '作品正在删除，任务已停止'; this.save(job);
        }
        this.controllers.get(job.id)?.abort();
      }
      // Response capture and failure handling may still write while an aborted request unwinds.
      // Wait for those callbacks before removing their persistent records.
      await Promise.allSettled(jobs.flatMap(job => { const run = this.runs.get(job.id); return run ? [run] : []; }));
      this.store.deleteProject(projectId, cleanup);
    } finally { this.deletingProjects.delete(projectId); }
  }
  private jobsInternal(projectId?: string, onlyActive = false): Job[] {
    const where = [projectId ? 'project_id=?' : '', onlyActive ? "status IN ('queued','running','paused')" : ''].filter(Boolean).join(' AND ');
    const rows = this.store.db.prepare(`SELECT data FROM jobs${where ? ` WHERE ${where}` : ''} ORDER BY rowid DESC`).all(...(projectId ? [projectId] : []));
    return rows.map(r => JSON.parse(String(r.data)) as Job);
  }
  listJobs(projectId?: string): Job[] { return this.jobsInternal(projectId).map(j => this.publicJob(j)); }
  listWritingActivities(jobId: string): WritingActivity[] {
    const job = this.get(jobId); if (job.kind !== 'generate') throw new HttpError('此任务不是正文生成任务', 400);
    return this.store.listWritingActivities(jobId);
  }
  listOutputs(jobId: string): ModelOutputSummary[] { this.get(jobId); return this.store.outputs.list(jobId); }
  private output(jobId: string, outputId: string): ModelOutputRecord { this.get(jobId); const output = this.store.outputs.get(outputId); if (!output || output.jobId !== jobId) throw new HttpError('模型输出不存在', 404); return output; }
  private outputBlocker(job: Job, output: ModelOutputRecord): string | undefined {
    if (output.status === 'applied') return '此输出已经应用，不能重复应用';
    if (!['failed', 'paused'].includes(job.status)) return '请先暂停任务；已取消、过期或完成的任务不能应用输出';
    if (this.controllers.has(job.id)) return '请求仍在结束中，请稍后再应用';
    if (job.branchId !== output.branchId || job.baseRevisionId !== output.baseRevisionId || this.store.getBranch(job.branchId).revisionId !== output.baseRevisionId) return '故事线已有新版本，此输出只能查看';
    if (this.jobsInternal(undefined, true).some(other => other.id !== job.id && other.branchId === job.branchId)) return '本故事线有其他进行中的任务';
    if (output.stage === 'extraction' && (String(job.payload.extractChapterId ?? '') !== output.chapterId || Number(job.payload.blockIndex ?? 0) !== output.blockIndex)) return '资料整理进度已经变化，此输出只能查看';
    if (output.stage === 'planning' && job.payload.purpose === 'compress-summary' && output.blockIndex !== undefined && output.blockIndex !== (job.payload.compressionWork as CompressionWork | undefined)?.completed) return '摘要压缩进度已经变化，此输出只能查看';
    return undefined;
  }
  outputDetail(jobId: string, outputId: string): ModelOutputDetail {
    const output = this.output(jobId, outputId); const job = this.get(jobId); let sourceParagraphs: ModelOutputDetail['sourceParagraphs'] = [];
    if (output.chapterId) {
      const state = this.store.revisionState(output.baseRevisionId);
      if (state.chapters.some(c => c.id === output.chapterId)) {
        const row = this.store.db.prepare('SELECT text FROM chapter_texts WHERE id=?').get(output.chapterId);
        if (row) sourceParagraphs = splitBlocks(String(row.text))[output.blockIndex ?? 0]?.sources ?? [];
      }
    }
    const unavailableReason = this.outputBlocker(job, output); return { output, sourceParagraphs, canApply: !unavailableReason, unavailableReason };
  }
  private capture(job: Job, stage: OutputStage, response: CapturedModelResponse, chapterId?: string, blockIndex?: number): ModelOutputRecord {
    const output = this.store.outputs.create({ jobId: job.id, projectId: job.projectId, branchId: job.branchId, baseRevisionId: job.baseRevisionId, stage, chapterId, blockIndex }, this.safeCapture(response));
    const fresh = this.get(job.id); fresh.payload.lastOutputId = output.id; this.save(fresh); return output;
  }
  private safeCapture(response: CapturedModelResponse): CapturedModelResponse { return JSON.parse(this.redact(JSON.stringify(response))) as CapturedModelResponse; }
  private issues(error: unknown): OutputIssue[] {
    if (error instanceof OutputValidationError) return error.issues;
    const supplied = error && typeof error === 'object' && 'issues' in error ? (error as { issues?: unknown }).issues : undefined;
    if (Array.isArray(supplied) && supplied.length) return supplied.map(issue => ({ ...issue, path: Array.isArray(issue.path) ? issue.path.reduce((path: string, part: string | number) => path + (typeof part === 'number' ? `[${part}]` : `${path ? '.' : ''}${part}`), '') || '$' : String(issue.path ?? '$'), message: String(issue.message ?? '格式不正确') }));
    return [{ path: '$', message: error instanceof Error ? error.message : '输出未通过校验' }];
  }
  private failOutput(output: ModelOutputRecord, error: unknown) { if (this.store.outputs.get(output.id)?.status !== 'applied') this.store.outputs.update(output.id, { status: 'invalid', error: '输出未通过校验，可在作者模式中修正', issues: this.issues(error).map(issue => ({ ...issue, path: this.redact(issue.path), message: this.redact(issue.message), ...(issue.quote !== undefined ? { quote: this.redact(issue.quote) } : {}), ...(issue.sourceText !== undefined ? { sourceText: this.redact(issue.sourceText) } : {}) })) }); }
  private redact(text: string): string { return redactModelPayload(text, this.getSettings().providers.flatMap(config => config.apiKey ? [config.apiKey] : [])); }
  importOutput(jobId: string, text: string): ModelOutputRecord {
    const job = this.get(jobId); if (!['failed', 'paused'].includes(job.status) || this.controllers.has(job.id)) throw new HttpError('仅可为已暂停或失败且请求已结束的任务导入输出', 409);
    this.store.assertVersion(job.branchId, job.baseRevisionId);
    let stage = job.payload.pendingStage as OutputStage | undefined;
    let chapterId: string | undefined; let blockIndex: number | undefined;
    if (!stage) {
      if (job.kind === 'plan') stage = 'planning';
      else if (job.kind === 'import' || job.kind === 'extract' || job.payload.generatedChapterId) stage = 'extraction';
      else stage = 'writing';
    }
    if (stage === 'extraction') {
      chapterId = String(job.payload.extractChapterId ?? job.payload.generatedChapterId ?? job.payload.importCurrentChapterId ?? this.store.state(job.branchId).chapters.find(c => c.status !== 'ready')?.id ?? '');
      if (!chapterId) throw new HttpError('任务没有可恢复的待整理章节', 409);
      blockIndex = Number(job.payload.blockIndex ?? 0); job.payload.extractChapterId = chapterId; job.payload.blockIndex = blockIndex;
    }
    job.payload.pendingStage = stage; this.save(job);
    let displayText = text; let unwrapError: unknown;
    try { displayText = unwrapModelOutput(text); } catch (error) { unwrapError = error; }
    const output = this.capture(job, stage, { rawResponse: text, text: displayText, inputTokens: 0, outputTokens: 0 }, chapterId, blockIndex);
    if (unwrapError) this.failOutput(output, unwrapError); return this.output(job.id, output.id);
  }
  applyOutput(jobId: string, outputId: string, input: { text: string; baseRevisionId: string }): Job {
    let job = this.get(jobId); const output = this.output(jobId, outputId); const blocked = this.outputBlocker(job, output);
    if (blocked) throw new HttpError(blocked, 409);
    if (input.baseRevisionId !== output.baseRevisionId) throw new HttpError('输出绑定版本不匹配，请刷新输出记录', 409);
    const editedText = this.redact(input.text); this.store.outputs.update(output.id, { editedText });
    try {
      if (output.stage === 'planning' && job.payload.purpose === 'compress-summary') this.applyCompression(job, output, parseStructuredText(editedText, value => z.object({ text: z.string().min(1) }).parse(value)).text);
      else if (output.stage === 'planning') this.applyPlan(job, output, parseStructuredText(editedText, value => planningSchema.parse(value)), true);
      else if (output.stage === 'writing') this.applyWriting(job, output, unwrapModelOutput(editedText), true);
      else this.applyExtracted(job, output, parseStructuredText(editedText, value => value), true);
      job = this.get(jobId); return this.publicJob(job);
    } catch (error) { this.failOutput(output, error); throw new HttpError('输出仍未通过校验；修改内容已保存，请查看作者输出记录中的具体位置', 422); }
  }
  private async requestCaptured<T extends { inputTokens: number; outputTokens: number }>(jobId: string, stage: OutputStage, request: ModelRequest, invoke: (request: ModelRequest) => Promise<T>, content: (result: T) => string, chapterId?: string, blockIndex?: number): Promise<{ result: T; output: ModelOutputRecord }> {
    const job = this.live(jobId); job.payload.pendingStage = stage;
    if (chapterId) { job.payload.extractChapterId = chapterId; job.payload.blockIndex = blockIndex ?? 0; } this.save(job);
    let output: ModelOutputRecord | undefined; let received = false; let pending = true; let captureFailed = false; let failedCaptureUsage: CapturedModelResponse | undefined;
    try {
      const saveResponse = (response: CapturedModelResponse) => {
        if (!pending) return;
        try { output = output ? this.store.outputs.completeResponse(output.id, this.safeCapture(response)) : this.capture(job, stage, response, chapterId, blockIndex); received = true; }
        catch (error) { captureFailed = true; failedCaptureUsage = response; throw error; }
      };
      const result = await invoke({ ...request,
        onRequest: snapshot => { if (!pending) return; try { output = this.capture(job, stage, { request: snapshot, rawResponse: '', text: '', inputTokens: 0, outputTokens: 0 }, chapterId, blockIndex); } catch (error) { captureFailed = true; throw error; } },
        onResponse: saveResponse,
      });
      if (!received) saveResponse({ rawResponse: content(result), text: content(result), inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      if (!output) throw new Error('模型输出未能保存');
      if (stage === 'writing') output = this.store.outputs.update(output.id, { normalizedText: this.redact(content(result)) });
      this.charge(jobId, result, content(result)); this.live(jobId); return { result, output };
    } catch (error) {
      // Providers may wrap a failed persistence callback; retain the response charge and stop extraction retries.
      if (stage === 'extraction' && captureFailed) {
        if (failedCaptureUsage && !(error instanceof ModelOutputError)) error = new ModelOutputError(error instanceof Error ? error.message : '保存模型响应失败', failedCaptureUsage);
        if (error instanceof Error) this.nonRetryableExtractionErrors.add(error);
      }
      if (output) { if (stage === 'writing') { const draft = this.store.db.prepare('SELECT text FROM job_writing_drafts WHERE job_id=?').get(jobId); if (draft?.text) this.store.outputs.update(output.id, { normalizedText: this.redact(String(draft.text)) }); } this.failOutput(output, error); }
      throw error;
    }
    finally { pending = false; }
  }
  private publicJob(job: Job): Job { return { ...job, usageEstimated: Boolean(job.payload.usageEstimated), generatedChapterId: job.payload.generatedChapterId as string | undefined, title: job.payload.title as string | undefined, generationInput: job.kind === 'generate' ? { mode: job.payload.mode as GenerateInput['mode'], instruction: String(job.payload.instruction ?? ''), maxWords: job.payload.maxWords as number | undefined, title: job.payload.title as string | undefined } : undefined, purpose: job.payload.purpose === 'compress-summary' ? 'compress-summary' : undefined, payload: {} }; }
  writingSnapshot(jobId: string): Extract<WritingEvent, { type: 'snapshot' }> {
    const job = this.get(jobId); if (job.kind !== 'generate') throw new HttpError('此任务不是正文生成任务', 400);
    const row = this.store.db.prepare('SELECT text FROM job_writing_drafts WHERE job_id=?').get(job.id);
    return { type: 'snapshot', text: String(row?.text ?? ''), title: String(job.payload.title ?? '新章节'), job: this.publicJob(job), chapterId: job.payload.generatedChapterId as string | undefined, activities: this.store.listWritingActivities(jobId) };
  }
  subscribeWriting(jobId: string, listener: (event: WritingEvent) => void): () => void {
    this.writingSnapshot(jobId); const listeners = this.writingListeners.get(jobId) ?? new Set(); listeners.add(listener); this.writingListeners.set(jobId, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.writingListeners.delete(jobId); };
  }
  private emitWriting(jobId: string, event: WritingEvent) { for (const listener of this.writingListeners.get(jobId) ?? []) listener(event); }
  private writingActivity(jobId: string, event: ModelActivityEvent) {
    this.live(jobId);
    const safeEvent = JSON.parse(this.redact(JSON.stringify(event))) as ModelActivityEvent;
    const activity = this.store.recordWritingActivity(jobId, safeEvent, json => this.redact(json));
    if (activity) this.emitWriting(jobId, { type: 'activity', activity });
  }
  /** Called after a chapter transaction commits, so clients see final activity before the closing status. */
  private notifyWriting(job: Job, activities = this.store.listWritingActivities(job.id).filter(activity => activity.status !== 'running')) {
    for (const activity of activities) this.emitWriting(job.id, { type: 'activity', activity });
    this.emitWriting(job.id, { type: 'status', job: this.publicJob(job), chapterId: job.payload.generatedChapterId as string | undefined });
  }
  private writingDelta(jobId: string, text: string) {
    if (!text) return; this.live(jobId);
    this.store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET text=text || excluded.text').run(jobId, text);
    this.emitWriting(jobId, { type: 'delta', text });
  }
  private get(jobId: string): Job { const row = this.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(jobId); if (!row) throw new HttpError('任务不存在', 404); return JSON.parse(String(row.data)); }
  private save(job: Job, publish = true) {
    job.updatedAt = now(); this.store.db.prepare('INSERT INTO jobs(id,branch_id,project_id,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET branch_id=excluded.branch_id,project_id=excluded.project_id,status=excluded.status,data=excluded.data').run(job.id, job.branchId, job.projectId, job.status, JSON.stringify(job));
    if (job.kind === 'generate') {
      const activities = ['completed', 'failed', 'cancelled', 'stale', 'paused'].includes(job.status)
        ? this.store.finishWritingActivities(job.id, job.status === 'completed' ? undefined : this.redact(job.error || job.message)) : [];
      if (publish) this.notifyWriting(job, activities);
    }
  }
  enqueue(branchId: string, kind: JobKind, payload: Record<string, unknown>, onQueued?: () => void): Job {
    if (this.closed) throw new HttpError('任务服务正在关闭', 503);
    if (kind === 'plan' && payload.purpose !== 'compress-summary') this.assertSeparatePlanning();
    let branch = this.store.assertVersion(branchId, String(payload.baseRevisionId ?? ''));
    if (this.deletingProjects.has(branch.projectId)) throw new HttpError('作品正在删除，不能创建任务', 409);
    const state = this.store.state(branchId); const rewriting = kind === 'generate' && Boolean(payload.chapterId);
    const branchJobs = this.jobsInternal().filter(job => job.branchId === branchId && ['queued', 'running', 'paused', 'failed'].includes(job.status));
    const backgroundJobs = branchJobs.filter(job => job.kind === 'extract' && (job.status !== 'failed' || this.store.state(branchId).chapters.some(chapter => chapter.status !== 'ready')));
    const unfinished = state.chapters.some(chapter => chapter.status !== 'ready');
    if (rewriting && (backgroundJobs.length || unfinished) && !payload.discardBackground) throw new HttpError('后台资料整理尚未完成，可以等待完成，或选择放弃后台任务后重新生成', 409);
    if (branchJobs.some(job => ['queued', 'running', 'paused'].includes(job.status) && !(rewriting && payload.discardBackground && job.kind === 'extract'))) throw new HttpError('此故事线已有进行中或暂停的任务，请先完成或取消', 409);
    if ((kind === 'generate' || kind === 'import') && unfinished && !rewriting) throw new HttpError('请先完成上一章资料整理', 409);
    if (kind === 'import' && (!Array.isArray(payload.chapters) || !payload.chapters.length)) throw new HttpError('导入目录为空');
    if (kind === 'generate') {
      if (!['original', 'continuation', 'fanfiction', 'rewrite'].includes(String(payload.mode))) throw new HttpError('写作模式不正确');
      if (payload.chapterId) {
        const chapter = this.store.chapter(branchId, String(payload.chapterId));
        if (payload.selection) { const selection = payload.selection as { start: number; end: number }; if (!Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end <= selection.start || selection.end > chapter.text.length) throw new HttpError('改写片段范围无效'); }
      }
      if (payload.regenerate && !payload.chapterId) throw new HttpError('请指定重新生成的章节');
    }
    const total = kind === 'import' ? (payload.chapters as unknown[]).length : kind === 'extract' ? state.chapters.filter(c => c.status !== 'ready').length : 1;
    const { chapters: inputChapters, ...smallPayload } = payload;
    let job: Job;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if (rewriting) {
        const original = this.store.chapter(branchId, String(payload.chapterId));
        const fork = this.store.forkForGeneration(branchId, branch.revisionId, original.id); branch = fork.branch;
        smallPayload.sourceBranchId = branchId; smallPayload.sourceChapterId = original.id;
        smallPayload.chapterId = undefined; smallPayload.title = payload.title || original.title;
        if (payload.discardBackground) for (const background of backgroundJobs) { background.status = 'cancelled'; background.message = '作者放弃后台整理，已创建重新生成分支'; this.save(background); }
      }
      if (kind === 'generate' && !smallPayload.title) smallPayload.title = (normalizeTaskSettings(this.getSettings().taskSettings).planning.enabled && state.outline.fine.find(plan => plan.chapter === state.chapters.length + 1)?.title) || `第 ${state.chapters.length + 1} 章`;
      job = { id: randomUUID(), projectId: branch.projectId, branchId: branch.id, kind, status: 'queued', baseRevisionId: branch.revisionId, progress: 0, total, message: '已排队', inputTokens: 0, outputTokens: 0, createdAt: now(), updatedAt: now(), payload: structuredClone(smallPayload) };
      if (kind === 'import') {
        const insert = this.store.db.prepare('INSERT INTO job_import_chapters VALUES(?,?,?,?)');
        (inputChapters as { title: string; text: string }[]).forEach((chapter, index) => insert.run(job.id, index, chapter.title, chapter.text));
      }
      this.save(job); onQueued?.(); this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
    if (rewriting && payload.discardBackground) for (const background of backgroundJobs) this.controllers.get(background.id)?.abort();
    queueMicrotask(() => this.pump()); return this.publicJob(job);
  }
  action(jobId: string, action: 'pause' | 'resume' | 'retry' | 'cancel'): Job {
    const job = this.get(jobId);
    if (this.deletingProjects.has(job.projectId)) throw new HttpError('作品正在删除，不能操作任务', 409);
    if (action === 'pause' || action === 'cancel') {
      if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'stale') throw new HttpError('任务已经结束');
      job.status = action === 'pause' ? 'paused' : 'cancelled'; job.message = action === 'pause' ? '已暂停，进度已保存' : '已取消；已经保存的正文和资料保留'; this.save(job); this.controllers.get(job.id)?.abort();
    } else {
      if (!['paused', 'failed'].includes(job.status)) throw new HttpError('只能继续暂停或失败的任务');
      if (job.kind === 'plan' && job.payload.purpose !== 'compress-summary') this.assertSeparatePlanning();
      this.store.assertVersion(job.branchId, job.baseRevisionId);
      if (this.jobsInternal(undefined, true).some(other => other.id !== job.id && other.branchId === job.branchId)) throw new HttpError('故事线已有其他任务', 409);
      delete job.payload.extractionRetry;
      job.status = 'queued'; job.error = undefined; job.message = '等待继续'; this.save(job); queueMicrotask(() => this.pump());
    }
    return this.publicJob(job);
  }
  private pump() {
    if (!this.started || this.closed) return;
    for (const job of this.jobsInternal(undefined, true).reverse()) if (job.status === 'queued' && !this.deletingProjects.has(job.projectId) && !this.controllers.has(job.id) && ![...this.controllers.keys()].some(key => this.get(key).branchId === job.branchId)) {
      const controller = new AbortController(); this.controllers.set(job.id, controller); const run = this.run(job.id, controller).finally(() => { this.controllers.delete(job.id); this.runs.delete(job.id); this.pump(); }); this.runs.set(job.id, run);
    }
  }
  private live(jobId: string): Job { const job = this.get(jobId); if (this.closed || job.status !== 'running') throw new DOMException('任务已停止', 'AbortError'); this.store.assertVersion(job.branchId, job.baseRevisionId); return job; }
  private provider(role: 'writing' | 'planning' | 'extraction'): ProviderConfig {
    const settings = normalizeModelSettings(this.getSettings()); const providerId = settings[`${role}ProviderId`]; const config = settings.providers.find(p => p.id === providerId);
    const task = role === 'writing' ? '写作' : role === 'planning' ? '规划' : '资料提取';
    if (!config) throw new HttpError(`请先在供应商配置中选择${task}供应商`);
    const model = (settings[`${role}Model`] ?? config.model ?? '').trim();
    if (!model) throw new HttpError(`请先为${task}任务选择或填写模型名称`);
    return resolveModelConfig(settings, config, model, role);
  }
  private budget(job: Job, provider: ProviderConfig, request: ModelRequest): ModelRequest {
    const inputEstimate = requestTokens(provider, request);
    const output = Math.min(request.maxOutputTokens ?? provider.maxOutputTokens, provider.maxOutputTokens);
    if (inputEstimate + output > provider.contextTokens) throw new HttpError(`本次预估输入 ${inputEstimate} tokens，加上单次输出上限 ${output} tokens，超过上下文上限 ${provider.contextTokens} tokens。请提高上下文上限或缩短输入；不会自动缩减单次输出上限。`);
    job.payload = { ...job.payload, lastRequestInputEstimate: inputEstimate, lastRequestOutputLimit: output }; this.save(job);
    return { ...request, maxOutputTokens: output };
  }
  private charge(jobId: string, result: { inputTokens: number; outputTokens: number }, output: string) {
    const job = this.get(jobId); const missingUsage = !result.inputTokens || !result.outputTokens;
    job.inputTokens += result.inputTokens || Number(job.payload.lastRequestInputEstimate ?? 0); job.outputTokens += result.outputTokens || estimateTokens(output);
    if (missingUsage) job.payload.usageEstimated = true; this.save(job);
  }
  private promptVariables(job: Job, state = this.store.state(job.branchId)): Record<string, string> {
    const project = this.store.getProject(job.projectId);
    return { projectTitle: project.title, premise: project.premise || '', chapterNumber: String(state.chapters.length + 1), instruction: String(job.payload.instruction ?? '') };
  }
  private taskPrompt(task: PromptTask, variables: Record<string, string>): ModelRequest {
    const request = compilePrompt(normalizePromptTemplates(this.getSettings().promptTemplates), task, variables);
    return task === 'writing' ? request : structuredRequest(request);
  }
  private compressionSegments(source: string, provider: ProviderConfig, job: Job): string[] {
    const config = normalizePromptTemplates(this.getSettings().promptTemplates);
    const variables = this.promptVariables(job);
    return compressionChunks(source, provider, summaryText => structuredRequest(compilePrompt(config, 'compression', { ...variables, summaryText })));
  }
  private checkpoint(job: Job, payload: Record<string, unknown>, progress = job.progress, message = job.message) {
    return (revisionId: string, branchId: string) => { job.baseRevisionId = revisionId; job.branchId = branchId; job.payload = payload; job.progress = progress; job.message = message; this.save(job, !(job.kind === 'generate' && job.status === 'completed')); };
  }
  private outputCheckpoint(job: Job, output: ModelOutputRecord, payload: Record<string, unknown>, progress: number, message: string, local: boolean, completed = false) {
    if (local) { job.status = completed ? 'completed' : 'paused'; job.error = undefined; }
    return (revisionId: string, branchId: string) => { this.checkpoint(job, payload, completed ? job.total : progress, local && !completed ? `${message}；已暂停，可点击继续` : message)(revisionId, branchId); this.store.outputs.update(output.id, { status: 'applied', error: undefined, issues: [] }); };
  }
  private assertSeparatePlanning() {
    const planning = normalizeTaskSettings(this.getSettings().taskSettings).planning;
    if (!planning.enabled) throw new HttpError('剧情规划已关闭，请先在任务模型设置中开启', 400);
    if (planning.mode !== 'separate') throw new HttpError('剧情规划当前由写作 AI 通过工具提交，请发起正文写作或切换为独立规划模型', 400);
  }
  private updatePlanState(state: StoryState, value: PlanningResult) {
    const next = state.chapters.length + 1;
    for (let chapter = next; chapter <= next + 3; chapter++) if (!value.fine.some(f => f.chapter === chapter)) throw new OutputValidationError([{ path: 'fine', message: `缺少第 ${chapter} 章预期规划，需提供当前章和接下来三章` }]);
    if (new Set(value.fine.map(plan => plan.chapter)).size !== value.fine.length) throw new OutputValidationError([{ path: 'fine', message: '章节规划序号不能重复' }]);
    state.outline.fine = value.fine.filter(f => f.chapter >= next && f.chapter <= next + 3);
    for (const [index, item] of value.foreshadows.entries()) {
      const relatedEntityIds = item.relatedNames.map((name, nameIndex) => { const matches = state.entities.filter(e => !e.mergedInto && [e.name, ...e.aliases].includes(name)); if (matches.length !== 1) throw new OutputValidationError([{ path: `foreshadows[${index}].relatedNames[${nameIndex}]`, message: '关联名称必须匹配唯一的已有实体' }]); return matches[0].id; });
      const titleKey = (title: string) => title.normalize('NFKC').trim().toLocaleLowerCase();
      const old = state.foreshadows.find(f => titleKey(f.title) === titleKey(item.title)); if (old) { if (old.status === 'planned') Object.assign(old, { detail: item.detail, dueChapter: item.dueChapter, revealCondition: item.revealCondition, relatedEntityIds }); } else state.foreshadows.push({ id: randomUUID(), title: item.title, detail: item.detail, dueChapter: item.dueChapter, revealCondition: item.revealCondition, relatedEntityIds, status: 'planned' });
    }
  }
  private applyPlan(job: Job, output: ModelOutputRecord, value: PlanningResult, local: boolean) {
    this.assertSeparatePlanning();
    const state = this.store.state(job.branchId); this.updatePlanState(state, value);
    this.store.commit(job.branchId, job.baseRevisionId, state, '更新未发生剧情的预期规划', this.outputCheckpoint(job, output, { ...job.payload, planned: true, pendingStage: undefined }, job.progress, '预期规划已保存', local, local && job.kind === 'plan'));
  }
  private planningTools(jobId: string): { tools: ModelTool[]; instruction: string } {
    const config = normalizeTaskSettings(this.getSettings().taskSettings).planning;
    if (!config.enabled || config.mode !== 'tool') return { tools: [], instruction: '' };
    const next = this.store.state(this.live(jobId).branchId).chapters.length + 1;
    const tool: ModelTool = {
      name: 'update_plot_plan', description: `直接编写第 ${next} 章至第 ${next + 3} 章尚未发生的预期剧情及隐藏伏笔。由你提供完整规划内容，不会调用其他模型。校验成功后暂存，随本次正文成功保存到同一个故事版本；同次写作再次调用会替换此前暂存规划。`,
      parameters: { type: 'object', properties: {
        fine: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'object', properties: { chapter: { type: 'integer', minimum: next, maximum: next + 3 }, title: { type: 'string' }, goal: { type: 'string' } }, required: ['chapter', 'title', 'goal'], additionalProperties: false } },
        foreshadows: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, status: { type: 'string', enum: ['planned'] }, dueChapter: { type: 'integer', minimum: next }, revealCondition: { type: 'string' }, relatedNames: { type: 'array', items: { type: 'string' } } }, required: ['title', 'detail', 'status', 'revealCondition', 'relatedNames'], additionalProperties: false } },
      }, required: ['fine', 'foreshadows'], additionalProperties: false },
      execute: args => {
        const job = this.live(jobId);
        const planning = normalizeTaskSettings(this.getSettings().taskSettings).planning;
        if (!planning.enabled || planning.mode !== 'tool') return { error: '剧情规划工具已停用，本次内容未暂存。' };
        try {
          const value = planningSchema.strict().parse(args);
          if (value.fine.length !== 4 || value.fine.some(plan => plan.chapter < next || plan.chapter > next + 3)) throw new Error('只提供当前待写章和接下来三章的四项规划。');
          if (value.foreshadows.some(item => item.status !== 'planned' || item.dueChapter !== undefined && item.dueChapter < next)) throw new Error('只能规划尚未发生的伏笔，status 必须为 planned，预期章节不能早于当前待写章。');
          this.updatePlanState(this.store.state(job.branchId), value);
          job.payload.pendingPlotPlan = value; this.save(job);
          return { status: 'staged', fine: value.fine, message: '预期规划已暂存，正文成功保存时一起生效。继续输出小说正文，不把隐藏规划或工具结果写进正文。' };
        } catch (error) { return { error: this.redact(error instanceof Error ? error.message : '剧情规划未通过校验，请修正工具参数。') }; }
      },
    };
    return { tools: [tool], instruction: `\n剧情规划使用工具模式：由你直接编写当前第 ${next} 章和接下来三章的预期剧情，在写正文前调用 update_plot_plan 提交 fine 与 foreshadows；不需要请求其他规划模型。遵守作者锁定设定、已有伏笔与本次写作要求，只规划尚未发生的事件。relatedNames 只能使用已有唯一明确的人物或实体名称，新人物留空。规划和工具结果不写入小说正文。` };
  }
  private applyWriting(job: Job, output: ModelOutputRecord, prose: string, local: boolean) {
    if (!prose.trim()) throw new OutputValidationError([{ path: '$', message: '小说正文不能为空' }]);
    const input = job.payload as unknown as GenerateInput; const original = job.payload.sourceChapterId ? this.store.db.prepare('SELECT text FROM chapter_texts WHERE id=?').get(String(job.payload.sourceChapterId)) : undefined; const state = this.store.state(job.branchId);
    const text = original && input.selection ? String(original.text).slice(0, input.selection.start) + prose + String(original.text).slice(input.selection.end) : prose;
    const planning = normalizeTaskSettings(this.getSettings().taskSettings).planning;
    const pendingPlan = planning.enabled && planning.mode === 'tool' && job.payload.pendingPlotPlan ? planningSchema.parse(job.payload.pendingPlotPlan) : undefined;
    this.store.saveChapter(job.branchId, { baseRevisionId: job.baseRevisionId, title: input.title || (normalizeTaskSettings(this.getSettings().taskSettings).planning.enabled && state.outline.fine.find(f => f.chapter === state.chapters.length + 1)?.title) || `第 ${state.chapters.length + 1} 章`, text }, (revisionId, branchId) => {
      const saved = this.store.revisionState(revisionId).chapters.at(-1)!;
      job.status = 'completed'; job.error = undefined;
      this.store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET text=excluded.text').run(job.id, text);
      this.outputCheckpoint(job, output, { ...job.payload, pendingPlotPlan: undefined, generatedChapterId: saved.id, pendingStage: undefined }, job.total, '正文已保存，资料在后台整理', local, true)(revisionId, branchId);
      this.queueExtraction(job, saved.id, local);
    }, pendingPlan ? state => this.updatePlanState(state, pendingPlan) : undefined);
    this.notifyWriting(job);
    queueMicrotask(() => this.pump());
  }
  private queueExtraction(writing: Job, chapterId: string, paused: boolean, blockIndex = 0) {
    const background: Job = { id: randomUUID(), projectId: writing.projectId, branchId: writing.branchId, kind: 'extract', status: paused ? 'paused' : 'queued', baseRevisionId: writing.baseRevisionId, progress: 0, total: 1, message: paused ? '正文已修复；请手动继续后台资料整理' : '正文已保存，等待后台资料整理', inputTokens: 0, outputTokens: 0, createdAt: now(), updatedAt: now(), payload: { extractChapterId: chapterId, blockIndex, writingJobId: writing.id } };
    this.save(background);
  }
  private imageTools(jobId: string): { tools: ModelTool[]; instruction: string } {
    const config = normalizeImageSettings(this.getSettings().imageSettings);
    if (!this.images || !config.providerId || !config.model) return { tools: [], instruction: '' };
    const tools: ModelTool[] = [];
    const register = (request: WritingImageRequest) => {
      const live = this.live(jobId);
      const requests = (live.payload.imageRequests ?? []) as WritingImageRequest[];
      if (requests.some(previous => previous.kind === request.kind && (request.kind === 'portrait' ? previous.name === request.name : previous.sourceText === request.sourceText))) return { status: 'requested', message: '同一人物或场景已请求生图，请继续写作。' };
      if (requests.length >= 12) throw new HttpError('本章最多接受 12 个自动生图请求，请完成正文后由作者补充。');
      live.payload.imageRequests = [...requests, request]; this.save(live);
      return { status: 'requested', message: '已登记生图请求；正文保存、资料确认后独立生成并绑定，不影响正文继续写作。' };
    };
    if (config.autoPortrait) tools.push({ name: 'generate_character_portrait', description: '新人物在本章首次出场时主动调用，按明确姓名请求生成对应立绘。只使用正文已描述的外观，不推断秘密身份。资料整理后绑定到该人物并展示。', parameters: { type: 'object', properties: { name: { type: 'string', description: '人物明确姓名或已有别名' }, description: { type: 'string', description: '正文已描述的外观与衣着' } }, required: ['name', 'description'], additionalProperties: false }, execute: args => {
      const value = z.object({ name: z.string().trim().min(1).max(300), description: z.string().trim().min(1).max(6000) }).strict().parse(args);
      return register({ kind: 'portrait', ...value });
    } });
    if (config.autoCG) tools.push({ name: 'generate_scene_cg', description: '正文切换到新的场景或出现大场面时主动调用生成场景 CG。sourceText 必须逐字引用本章实际正文片段，图片绑定该剧情。每个场景只请求一次。', parameters: { type: 'object', properties: { description: { type: 'string', description: '场景构图、人物动作、环境与氛围' }, sourceText: { type: 'string', description: '逐字引用本章正文中对应场景的文字，不得编造引用' } }, required: ['description', 'sourceText'], additionalProperties: false }, execute: args => {
      const value = z.object({ description: z.string().trim().min(1).max(6000), sourceText: z.string().trim().min(1).max(10000) }).strict().parse(args);
      return register({ kind: 'cg', ...value });
    } });
    return { tools, instruction: tools.length ? `\n插画任务：${config.autoPortrait ? '新人物首次出场时主动调用 generate_character_portrait 工具。' : ''}${config.autoCG ? '每次切换场景或出现大场面时主动调用 generate_scene_cg，并逐字引用本章对应正文。' : ''}生图请求和工具结果只展示在生成过程与图册，不要写入小说正文。` : '' };
  }

  private illustrateChapter(job: Job, chapterId: string) {
    if (!this.images || !job.payload.writingJobId || job.payload.imagesRequestedFor === chapterId) return;
    const writing = this.get(String(job.payload.writingJobId));
    const oldIds = new Set((writing.payload.imageStartingEntityIds ?? []) as string[]);
    const newIds = this.store.state(job.branchId).entities.filter(entity => entity.kind === 'character' && !entity.mergedInto && !oldIds.has(entity.id)).map(entity => entity.id);
    try {
      const checkpoint = (revisionId: string) => {
        job.baseRevisionId = revisionId; job.payload.imagesRequestedFor = chapterId;
        delete job.payload.pendingIllustrationChapterId; this.save(job);
      };
      // Image references and the extraction checkpoint commit in the same transaction.
      this.images.generateAutomatic(job.branchId, job.baseRevisionId, chapterId, (writing.payload.imageRequests ?? []) as WritingImageRequest[], newIds, checkpoint);
      if (job.payload.pendingIllustrationChapterId || job.payload.imagesRequestedFor !== chapterId) checkpoint(this.store.getBranch(job.branchId).revisionId);
    } catch (error) {
      // Images must never undo successfully saved prose or force another text-model request.
      // The SQL transaction may have rolled back after a checkpoint mutated this object.
      Object.assign(job, this.get(job.id));
      job.payload.imageError = this.redact(error instanceof Error ? error.message : '自动插画登记失败');
      delete job.payload.pendingIllustrationChapterId;
      this.save(job);
    }
  }
  private applyCompression(job: Job, output: ModelOutputRecord, text: string) {
    const work = job.payload.compressionWork as CompressionWork | undefined;
    const source = work?.chunks[work.index] ?? String(job.payload.summarySource ?? '');
    const candidate = text.trim();
    if (!candidate || estimateTokens(candidate) >= estimateTokens(source)) throw new OutputValidationError([{ path: 'text', message: '本段压缩摘要必须非空且比对应原始片段更短；请缩短候选后重新验证' }]);
    if (work && (work.index >= work.chunks.length || output.blockIndex !== work.completed)) throw new OutputValidationError([{ path: '$', message: '摘要压缩片段进度已经变化，此输出只能查看' }]);
    const manual = job.status !== 'running';
    job.payload = { ...job.payload, pendingStage: undefined };
    if (work) {
      const updated = { ...work, index: work.index + 1, results: [...work.results, candidate], completed: work.completed + 1 };
      job.payload.compressionWork = updated; job.progress = updated.completed;
      job.status = manual ? 'paused' : 'running'; job.message = `已保存第 ${work.pass + 1} 轮压缩片段 ${updated.index}/${updated.chunks.length}${manual ? '；请继续处理其余片段' : ''}`; job.error = undefined;
    } else {
      // A candidate from a pre-release single-request job is still confirmable.
      job.payload.compressionText = candidate; job.status = 'completed'; job.progress = job.total; job.message = '摘要压缩候选已生成，等待作者确认'; job.error = undefined;
    }
    this.store.db.exec('BEGIN IMMEDIATE');
    try { this.store.outputs.update(output.id, { status: 'applied', error: undefined, issues: [] }); this.save(job); this.store.db.exec('COMMIT'); }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    if (work && (job.payload.compressionWork as CompressionWork).index === work.chunks.length) this.finishCompressionPass(job);
  }
  private finishCompressionPass(job: Job) {
    const work = job.payload.compressionWork as CompressionWork;
    const combined = work.results.join('\n\n'); const provider = this.provider('planning');
    const nextChunks = this.compressionSegments(combined, provider, job);
    if (work.chunks.length === 1 || (work.pass + 1 >= MAX_COMPRESSION_PASSES && nextChunks.length === 1)) {
      if (estimateTokens(combined) >= estimateTokens(String(job.payload.summarySource ?? ''))) throw new HttpError('最终压缩候选没有比完整原摘要更短，请重新生成压缩候选');
      job.payload = { ...job.payload, compressionText: combined, pendingStage: undefined }; job.status = 'completed'; job.progress = job.total; job.message = '摘要压缩候选已生成，等待作者确认'; job.error = undefined; this.save(job); return;
    }
    if (work.pass + 1 >= MAX_COMPRESSION_PASSES) throw new HttpError(`摘要压缩已完成 ${MAX_COMPRESSION_PASSES} 轮，合并候选仍超出规划模型的上下文；已完成片段保留，请提高规划模型上下文上限后继续，或重新创建压缩任务`);
    job.payload = { ...job.payload, compressionWork: { pass: work.pass + 1, chunks: nextChunks, index: 0, results: [], completed: work.completed } satisfies CompressionWork, pendingStage: undefined };
    job.total = work.completed + nextChunks.length; job.message = `准备第 ${work.pass + 2} 轮${nextChunks.length === 1 ? '合并' : '分段'}压缩`; this.save(job);
  }
  summaryCompression(jobId: string) {
    const job = this.get(jobId); if (job.payload.purpose !== 'compress-summary' || job.status !== 'completed') throw new HttpError('压缩摘要尚未生成完成', 409);
    return { text: String(job.payload.compressionText ?? ''), chapterIds: job.payload.summaryChapterIds as string[], baseRevisionId: job.baseRevisionId };
  }
  confirmSummaryCompression(branchId: string, input: { baseRevisionId: string; jobId: string; text: string }) {
    this.store.assertVersion(branchId, input.baseRevisionId); const job = this.get(input.jobId); const proposal = this.summaryCompression(job.id);
    if (job.branchId !== branchId || proposal.baseRevisionId !== input.baseRevisionId) throw new HttpError('候选摘要对应的故事版本已变化，请重新生成候选', 409);
    const state = this.store.state(branchId);
    if (state.chapters.map(chapter => chapter.id).join('|') !== proposal.chapterIds.join('|')) throw new HttpError('摘要对应章节已变化', 409);
    if (!input.text.trim() || estimateTokens(input.text) >= estimateTokens(String(job.payload.summarySource ?? ''))) throw new HttpError('确认的压缩摘要必须非空且比原摘要更短');
    state.outline.summaryCompression = { text: input.text.trim(), chapterIds: proposal.chapterIds };
    return this.store.commit(branchId, input.baseRevisionId, state, '作者确认压缩剧情摘要');
  }
  private async compressSummary(jobId: string, signal: AbortSignal) {
    let job = this.live(jobId);
    if (!job.payload.compressionWork) {
      const state = this.store.state(job.branchId);
      if (!state.chapters.length || state.chapters.some(chapter => chapter.status !== 'ready' || !chapter.summary.trim())) throw new HttpError('请先完成所有章节的剧情摘要整理');
      const source = state.chapters.map(chapter => `${chapter.title}\n${chapter.summary}`).join('\n\n');
      const chunks = this.compressionSegments(source, this.provider('planning'), job);
      job.payload = { ...job.payload, summarySource: source, summaryChapterIds: state.chapters.map(chapter => chapter.id), compressionWork: { pass: 0, chunks, index: 0, results: [], completed: 0 } satisfies CompressionWork };
      job.total = chunks.length; job.progress = 0; this.save(job);
    }
    for (;;) {
      job = this.live(jobId); const work = job.payload.compressionWork as CompressionWork;
      if (work.index === work.chunks.length) { this.finishCompressionPass(job); if (job.status === 'completed') return; continue; }
      const provider = this.provider('planning');
      job.message = `第 ${work.pass + 1} 轮压缩片段 ${work.index + 1}/${work.chunks.length}`; this.save(job);
      const request = this.budget(job, provider, { ...this.taskPrompt('compression', { ...this.promptVariables(job), summaryText: work.chunks[work.index] }), signal });
      const { result, output } = await this.requestCaptured(jobId, 'planning', request, req => this.models.generateStructured(provider, req, value => z.object({ text: z.string().min(1) }).parse(value)), result => JSON.stringify(result.value), undefined, work.completed);
      this.applyCompression(this.live(jobId), output, result.value.text);
      if (this.get(jobId).status === 'completed') return;
    }
  }
  private applyExtracted(job: Job, output: ModelOutputRecord, input: unknown, local: boolean) {
    if (!output.chapterId || output.blockIndex === undefined) throw new OutputValidationError([{ path: '$', message: '输出缺少绑定的章节或片段位置' }]);
    const chapter = this.store.chapter(job.branchId, output.chapterId); const blocks = splitBlocks(chapter.text);
    if (output.blockIndex >= blocks.length) throw new OutputValidationError([{ path: '$', message: '绑定的章节片段不存在' }]);
    const normalized = normalizeExtraction(input, blocks[output.blockIndex]);
    this.store.outputs.update(output.id, { normalizedText: this.redact(normalized.normalizedText), adjustments: normalized.adjustments.map(issue => ({ ...issue, ...(issue.quote !== undefined ? { quote: this.redact(issue.quote) } : {}), ...(issue.sourceText !== undefined ? { sourceText: this.redact(issue.sourceText) } : {}) })) });
    if (!normalized.value) throw new OutputValidationError(normalized.issues);
    const value = normalized.value;
    const complete = output.blockIndex === blocks.length - 1;
    let payload: Record<string, unknown> = { ...job.payload, extractChapterId: output.chapterId, blockIndex: output.blockIndex + 1, pendingStage: undefined, extractionRetry: undefined }; let progress = job.progress; let finished = false;
    if (complete && this.images && job.payload.writingJobId) payload.pendingIllustrationChapterId = output.chapterId;
    if (local && complete) {
      if (job.kind === 'import') { const next = Number(job.payload.importIndex ?? 0) + 1; progress = next; payload = { ...payload, importIndex: next, importCurrentChapterId: undefined, extractChapterId: undefined, blockIndex: 0 }; finished = next >= job.total; }
      else if (job.kind === 'generate') { progress = job.total; finished = true; }
      else { progress++; finished = this.store.state(job.branchId).chapters.every(c => c.id === output.chapterId || c.status === 'ready'); }
    }
    this.store.applyExtraction(job.branchId, job.baseRevisionId, output.chapterId, value, complete, this.outputCheckpoint(job, output, payload, progress, complete ? '本章资料已保存' : `已保存片段 ${output.blockIndex + 1}/${blocks.length}`, local, finished));
    if (complete) this.illustrateChapter(job, output.chapterId);
  }
  private async plan(jobId: string, signal: AbortSignal) {
    this.assertSeparatePlanning();
    const job = this.live(jobId); const state = this.store.state(job.branchId); const provider = this.provider('planning'); const next = state.chapters.length + 1;
    const context = buildWritingContext({ state, premise: this.store.getProject(job.projectId).premise, chapterText: id => this.store.chapter(job.branchId, id).text });
    const request = this.budget(job, provider, { ...this.taskPrompt('planning', { ...this.promptVariables(job, state), ...context.variables, context: context.text, endChapter: String(next + 3) }), signal });
    const { result, output } = await this.requestCaptured(jobId, 'planning', request, req => this.models.generateStructured<PlanningResult>(provider, req, value => planningSchema.parse(value)), result => JSON.stringify(result.value));
    this.applyPlan(this.live(jobId), output, result.value, false);
  }
  private async extractChapter(jobId: string, chapterId: string, signal: AbortSignal) {
    let job = this.live(jobId); const chapter = this.store.chapter(job.branchId, chapterId); const blocks = splitBlocks(chapter.text); let blockIndex = job.payload.extractChapterId === chapterId ? Number(job.payload.blockIndex ?? 0) : 0;
    for (; blockIndex < blocks.length; blockIndex++) {
      let lastFailure: unknown;
      for (;;) {
        job = this.live(jobId); const provider = this.provider('extraction'); const state = this.store.state(job.branchId);
        const context = extractionContext(state, blocks[blockIndex]);
        const retry = job.payload.extractionRetry as { chapterId?: string; blockIndex?: number; failedAttempts?: number } | undefined;
        const failedAttempts = retry?.chapterId === chapterId && retry.blockIndex === blockIndex ? Number(retry.failedAttempts ?? 0) : 0;
        const retryConfig = normalizeTaskSettings(this.getSettings().taskSettings).extraction;
        if (failedAttempts && (!retryConfig.autoRetry || failedAttempts > retryConfig.maxRetries)) throw lastFailure ?? new HttpError('资料提取自动重试已关闭或次数已用完，请检查设置后手动继续');
        const message = `整理「${chapter.title}」片段 ${blockIndex + 1}/${blocks.length}`;
        job.message = failedAttempts ? `${message}；正在第 ${failedAttempts} 次自动重试` : message; this.save(job);
        // Configuration and context-budget failures require an author change, not another request.
        const request = this.budget(job, provider, { ...this.taskPrompt('extraction', { ...this.promptVariables(job, state), chapterNumber: String(state.chapters.findIndex(value => value.id === chapterId) + 1), context, chapterTitle: chapter.title, blockText: blocks[blockIndex].text }), signal });
        validateProviderOptions(provider, request.maxOutputTokens);
        let url: URL;
        try { url = new URL(provider.baseUrl); } catch { throw new HttpError('模型服务地址无效，请填写完整的 HTTP 或 HTTPS 地址。'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError('模型服务地址仅支持 HTTP/HTTPS，且不能在地址中包含用户名或密码。');
        const previousOutputId = job.payload.lastOutputId; let receivedResult = false;
        try {
          const { result, output } = await this.requestCaptured(jobId, 'extraction', request, req => this.models.generateStructured<unknown>(provider, req, value => value), result => JSON.stringify(result.value), chapterId, blockIndex);
          receivedResult = true;
          this.applyExtracted(this.live(jobId), output, result.value, false);
          break;
        } catch (error) {
          lastFailure = error;
          job = this.get(jobId);
          // Every returned failure has its own charge, including the final failed attempt.
          if (error instanceof ModelOutputError) {
            job.inputTokens += error.inputTokens || Number(job.payload.lastRequestInputEstimate ?? 0); job.outputTokens += error.outputTokens || Number(job.payload.lastRequestOutputLimit ?? 0);
            if (!error.inputTokens || !error.outputTokens) job.payload.usageEstimated = true;
            this.chargedExtractionErrors.add(error); this.save(job);
          }
          const output = job.payload.lastOutputId && job.payload.lastOutputId !== previousOutputId ? this.store.outputs.get(String(job.payload.lastOutputId)) : undefined;
          if (output && output.status !== 'applied') this.failOutput(output, error);
          if (this.closed || signal.aborted || job.status !== 'running') throw error;
          this.live(jobId);
          const config = normalizeTaskSettings(this.getSettings().taskSettings).extraction;
          const attempts = failedAttempts + 1;
          job.payload.extractionRetry = { chapterId, blockIndex, failedAttempts: attempts }; this.save(job);
          const nonRetryable = error instanceof HttpError && !(error instanceof OutputValidationError)
            || error instanceof Error && this.nonRetryableExtractionErrors.has(error)
            || receivedResult && !(error instanceof OutputValidationError)
            || error instanceof Error && error.name === 'AbortError'
            || output?.httpStatus !== undefined && output.httpStatus >= 400 && output.httpStatus < 500 && ![408, 429].includes(output.httpStatus);
          if (!config.autoRetry || attempts > config.maxRetries || nonRetryable) throw error;
          job.message = `${message}；等待第 ${attempts}/${config.maxRetries} 次自动重试`; this.save(job);
          await this.waitExtractionRetry(jobId, signal, config.retryDelayMs);
          if (!normalizeTaskSettings(this.getSettings().taskSettings).extraction.autoRetry) throw error;
        }
      }
    }
  }
  private async waitExtractionRetry(jobId: string, signal: AbortSignal, delayMs: number): Promise<void> {
    if (signal.aborted) throw new DOMException('任务已停止', 'AbortError');
    await new Promise<void>((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, delayMs);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('任务已停止', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
    });
    this.live(jobId);
  }
  private async run(jobId: string, controller: AbortController) {
    let job = this.get(jobId); const startingOutputId = job.payload.lastOutputId; job.status = 'running'; job.message = '正在处理'; this.save(job);
    try {
      this.live(jobId);
      if (job.kind === 'plan') {
        if (job.payload.purpose === 'compress-summary') { await this.compressSummary(jobId, controller.signal); return; }
        await this.plan(jobId, controller.signal);
      }
      if (job.kind === 'generate') {
        // Completed prose owns an independent extraction job; tool continuations do not regenerate it.
        if (job.payload.generatedChapterId) {
          const chapter = this.store.chapter(job.branchId, String(job.payload.generatedChapterId));
          this.store.db.exec('BEGIN IMMEDIATE');
          try {
            job.status = 'completed'; job.progress = job.total; job.message = '正文已保存，资料在后台整理'; job.error = undefined;
            this.store.db.prepare('INSERT OR IGNORE INTO job_writing_drafts VALUES(?,?)').run(job.id, chapter.text); this.save(job, false);
            if (chapter.status !== 'ready' && !this.jobsInternal(undefined, true).some(other => other.branchId === job.branchId && other.kind === 'extract')) this.queueExtraction(job, chapter.id, false, job.payload.extractChapterId === chapter.id ? Number(job.payload.blockIndex ?? 0) : 0);
            this.store.db.exec('COMMIT');
          } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
          this.notifyWriting(job); return;
        }
        const input = job.payload as unknown as GenerateInput;
        const state = this.store.state(job.branchId); const provider = { ...this.provider('writing'), stream: true };
        const context = buildWritingContext({ state, premise: this.store.getProject(job.projectId).premise, chapterText: id => this.store.chapter(job.branchId, id).text, planningEnabled: normalizeTaskSettings(this.getSettings().taskSettings).planning.enabled });
        const original = job.payload.sourceChapterId && !input.regenerate ? this.store.db.prepare('SELECT text FROM chapter_texts WHERE id=?').get(String(job.payload.sourceChapterId)) : undefined;
        const selected = original ? input.selection ? String(original.text).slice(input.selection.start, input.selection.end) : String(original.text) : undefined;
        this.store.clearWritingActivities(job.id);
        this.store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET text=excluded.text').run(job.id, '');
        this.emitWriting(job.id, this.writingSnapshot(job.id));
        job.message = '正在流式生成正文'; this.save(job);
        job.payload.imageStartingEntityIds = state.entities.map(entity => entity.id); job.payload.imageRequests = []; delete job.payload.pendingPlotPlan; this.save(job);
        const illustrations = this.imageTools(jobId);
        const planning = this.planningTools(jobId);
        const prompt = this.taskPrompt('writing', {
          ...this.promptVariables(job, state), ...context.variables, context: context.text, mode: input.mode,
          maxWords: String(Math.min(20000, Math.max(100, Number(input.maxWords) || 2000))), sourceText: selected ?? '',
          writingTarget: selected ? `需要改写的${input.selection ? '片段（只输出替换片段）' : '章节'}：\n${selected}` : `请写第 ${state.chapters.length + 1} 章。`,
        });
        const instruction = illustrations.instruction + planning.instruction;
        const messages = prompt.messages && instruction ? [{ role: 'system' as const, content: instruction }, ...prompt.messages] : prompt.messages;
        const request = this.budget(job, provider, { ...prompt, system: prompt.system + instruction, messages, signal: controller.signal, tools: [...context.tools, ...illustrations.tools, ...planning.tools], onTextDelta: text => this.writingDelta(jobId, text), onActivity: event => this.writingActivity(jobId, event) });
        const { result, output } = await this.requestCaptured(jobId, 'writing', request, req => this.models.generateText(provider, req), result => result.text);
        this.applyWriting(this.live(jobId), output, result.text, false);
        return;
      }
      if (job.kind === 'extract') {
        job = this.live(jobId);
        if (typeof job.payload.pendingIllustrationChapterId === 'string') this.illustrateChapter(job, job.payload.pendingIllustrationChapterId);
        job = this.live(jobId); const pending = this.store.state(job.branchId).chapters.filter(c => c.status !== 'ready');
        for (const chapter of pending) { await this.extractChapter(jobId, chapter.id, controller.signal); job = this.live(jobId); job.progress++; this.save(job); }
      }
      if (job.kind === 'import') {
        for (let index = Number(job.payload.importIndex ?? 0); index < job.total; index++) {
          job = this.live(jobId); let chapterId = job.payload.importCurrentChapterId as string | undefined;
          if (!chapterId) {
            const chapter = this.store.db.prepare('SELECT title,text FROM job_import_chapters WHERE job_id=? AND position=?').get(job.id, index) as { title: string; text: string } | undefined;
            if (!chapter) throw new HttpError('导入任务缺少原文片段，请从完整备份恢复');
            const state = this.store.state(job.branchId); const ref = this.store.putChapter(chapter.title, chapter.text, String(job.payload.sourceId ?? '')); chapterId = ref.id; state.chapters.push(ref);
            this.store.commit(job.branchId, job.baseRevisionId, state, `导入原文章节：${ref.title}`, this.checkpoint(job, { ...job.payload, importCurrentChapterId: ref.id, importIndex: index, blockIndex: 0, extractChapterId: ref.id }, index, `已保存原文 ${index + 1}/${job.total}`));
          }
          if (this.store.state(job.branchId).chapters.find(c => c.id === chapterId)?.status !== 'ready') await this.extractChapter(jobId, chapterId, controller.signal);
          job = this.live(jobId); job.progress = index + 1; job.payload = { ...job.payload, importIndex: index + 1, importCurrentChapterId: undefined, blockIndex: 0, extractChapterId: undefined }; this.save(job);
        }
      }
      job = this.live(jobId); job.status = 'completed'; job.progress = job.total; job.message = '处理完成'; this.save(job);
    } catch (error) {
      if (this.closed) return;
      job = this.get(jobId);
      if (error instanceof ModelOutputError && !this.chargedExtractionErrors.has(error)) { job.inputTokens += error.inputTokens || Number(job.payload.lastRequestInputEstimate ?? 0); job.outputTokens += error.outputTokens || Number(job.payload.lastRequestOutputLimit ?? 0); if (!error.inputTokens || !error.outputTokens) job.payload.usageEstimated = true; this.save(job); }
      const lastOutput = job.payload.lastOutputId && job.payload.lastOutputId !== startingOutputId ? this.store.outputs.get(String(job.payload.lastOutputId)) : undefined;
      if (lastOutput && lastOutput.status !== 'applied') this.failOutput(lastOutput, error);
      if (job.status !== 'running') return;
      job.status = error instanceof HttpError && error.statusCode === 409 ? 'stale' : 'failed';
      const failureMessage = error instanceof Error ? this.redact(error.message) : '任务失败';
      job.error = lastOutput && lastOutput.status !== 'applied'
        ? lastOutput.httpStatus && lastOutput.httpStatus >= 400 ? `模型服务请求失败（HTTP ${lastOutput.httpStatus}），请求与响应已保留供作者检查`
        : lastOutput.diagnostics && lastOutput.diagnostics.transport !== 'http' ? `${failureMessage} 请求诊断已保留。`
        : lastOutput.diagnostics?.modelOutcome === 'blocked' ? '模型服务拦截了输入或输出；请查看作者请求诊断中的模型结束原因与拦截反馈'
        : lastOutput.diagnostics?.modelOutcome === 'empty' ? '模型服务返回了 HTTP 成功响应，但没有正文；请查看作者请求诊断，保留的空结果不会自动写入资料'
        : '模型输出已保留，请在作者模式的输出记录中查看并修正'
        : failureMessage;
      job.message = job.status === 'stale' ? '起始版本已经变化，结果未写入' : '任务失败，已保存进度，可重试'; this.save(job);
    }
  }
}
