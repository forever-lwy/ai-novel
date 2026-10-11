import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CapturedModelResponse, ExtractionResult, GenerateInput, Job, JobKind, ModelActivityEvent, ModelOutputDetail, ModelOutputRecord, ModelOutputSummary, ModelRequest, OutputIssue, OutputStage, ProviderConfig, Settings, StoryState, WritingActivity, WritingEvent, PromptTask } from '../shared/types.js';
import { normalizeModelSettings, resolveModelConfig } from '../shared/model-settings.js';
import { normalizeTaskSettings } from '../shared/task-settings.js';
import { compileTaskPrompt, normalizePromptTemplates } from '../shared/prompt-templates.js';
import { writingResponseTool } from '../shared/writing-output.js';
import type { PromptRuntime, PromptPreviewInput, PromptPreviewResult } from '../shared/prompt-runtime.js';
import { emptyState } from '../shared/types.js';
import { generateStructured, generateText, buildRequestSnapshot, estimateModelRequestInputTokens, ModelOutputError, ModelInteractionPause, ModelChapterComplete, parseStructuredText, redactModelPayload, unwrapModelOutput, validateProviderOptions } from './providers.js';
import { normalizeChapterWords, chapterBudgetReached } from '../shared/rpg-chapter.js';
import { HttpError, OutputValidationError, Store, rpgSetupSchema, rpgChoiceSchema } from './store.js';
import { extractionContext, normalizeExtraction, splitExtractionBlocks as splitBlocks } from './extraction.js';
import { buildWritingContext } from './writing-context.js';
import type { ImageService } from './images.js';
import { normalizeImageSettings } from '../shared/image-settings.js';
import type { ModelTool, WritingImageRequest, RpgChoice, ModelToolContinuation, StoryReference } from '../shared/types.js';
export { extractionSchema } from './extraction.js';

const now = () => new Date().toISOString();
const estimateTokens = (text: string) => Math.ceil([...text].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 1.3 : 0.3), 0));
const MAX_COMPRESSION_PASSES = 3;
interface CompressionWork { pass: number; chunks: string[]; index: number; results: string[]; completed: number }
const requestTokens = (provider: ProviderConfig, request: ModelRequest) => request.messages?.length || request.tools?.length || request.structuredOutput ? estimateModelRequestInputTokens(provider, request) : estimateTokens(request.system + request.prompt);
/** Size segments using the selected template, including repeated variables and JSON requirements. */
function compressionChunks(source: string, provider: ProviderConfig, build: (text: string) => ModelRequest): string[] {
  // A whitespace-only sizing probe still needs a user message; it is never sent to the model.
  const fits = (text: string) => requestTokens(provider, build(text.trim() ? text : `${text}\u200b`)) + provider.maxOutputTokens <= provider.contextTokens;
  const characters = [...source]; const chunks: string[] = [];
  if (!fits(characters[0] ?? ' ')) throw new HttpError('摘要压缩提示词与完整输出上限已超出摘要压缩模型的上下文，请缩短提示词或提高上下文上限');
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
    for (const job of this.jobsInternal()) if (job.kind === 'plan' && job.payload.purpose !== 'compress-summary' && ['queued', 'running', 'paused', 'failed'].includes(job.status)) {
      job.status = 'cancelled'; job.message = '剧情规划功能已移除；原记录保留供查看'; job.error = undefined; this.save(job);
    }
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
  assertIdle(branchId: string) {
    const branch = this.store.getBranch(branchId);
    if (this.closed) throw new HttpError('任务服务正在关闭', 503);
    if (this.deletingProjects.has(branch.projectId)) throw new HttpError('作品正在删除', 409);
    if (this.jobsInternal(branch.projectId).some(job => job.branchId === branchId && (['queued', 'running', 'paused'].includes(job.status) || this.controllers.has(job.id)))) throw new HttpError('请先完成或取消当前故事线的任务，再操作章节或资料', 409);
  }
  reextractChapter(branchId: string, base: string, chapterId: string) {
    this.assertIdle(branchId); this.store.assertVersion(branchId, base); this.store.chapter(branchId, chapterId);
    // Missing model configuration must not clear already extracted materials.
    this.provider('extraction');
    let job!: Job;
    const view = this.store.clearChapterExtraction(branchId, base, chapterId, revisionId => {
      job = { id: randomUUID(), projectId: this.store.getBranch(branchId).projectId, branchId, baseRevisionId: revisionId, kind: 'extract', status: 'queued', progress: 0, total: 1, message: '等待重新提取所选章节', inputTokens: 0, outputTokens: 0, createdAt: now(), updatedAt: now(), payload: { targetChapterId: chapterId, extractChapterId: chapterId, blockIndex: 0 } };
      this.save(job);
    });
    queueMicrotask(() => this.pump()); return { view, job: this.publicJob(job) };
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
    if (job.payload.rpgChoice && !job.payload.rpgChoiceAnswer && !job.payload.generatedChapterId && !job.payload.rpgNextChoice) return '剧情正在等待用户选择，请先回答当前剧情节点';
    if (output.stage === 'planning' && job.payload.purpose !== 'compress-summary') return '剧情规划功能已移除，历史输出仅供查看';
    if (!['failed', 'paused'].includes(job.status)) return '请先暂停任务；已取消、过期或完成的任务不能应用输出';
    if (this.controllers.has(job.id)) return '请求仍在结束中，请稍后再应用';
    if (job.branchId !== output.branchId || job.baseRevisionId !== output.baseRevisionId || this.store.getBranch(job.branchId).revisionId !== output.baseRevisionId) return '故事线已有新版本，此输出只能查看';
    if (this.jobsInternal(undefined, true).some(other => other.id !== job.id && other.branchId === job.branchId)) return '本故事线有其他进行中的任务';
    if (output.stage === 'extraction' && (String(job.payload.extractChapterId ?? '') !== output.chapterId || Number(job.payload.blockIndex ?? 0) !== output.blockIndex)) return '资料整理进度已经变化，此输出只能查看';
    if (['planning', 'compression'].includes(output.stage) && job.payload.purpose === 'compress-summary' && output.blockIndex !== undefined && output.blockIndex !== (job.payload.compressionWork as CompressionWork | undefined)?.completed) return '摘要压缩进度已经变化，此输出只能查看';
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
  private failOutput(output: ModelOutputRecord, error: unknown) { if (this.store.outputs.get(output.id)?.status !== 'applied') this.store.outputs.update(output.id, { status: 'invalid', error: this.redact(error instanceof Error ? error.message : '输出未通过校验，可在作者模式中修正'), issues: this.issues(error).map(issue => ({ ...issue, path: this.redact(issue.path), message: this.redact(issue.message), ...(issue.quote !== undefined ? { quote: this.redact(issue.quote) } : {}), ...(issue.sourceText !== undefined ? { sourceText: this.redact(issue.sourceText) } : {}) })) }); }
  private redact(text: string): string { return redactModelPayload(text, this.getSettings().providers.flatMap(config => config.apiKey ? [config.apiKey] : [])); }
  importOutput(jobId: string, text: string): ModelOutputRecord {
    const job = this.get(jobId); if (job.payload.purpose !== 'compress-summary' && (job.kind === 'plan' || job.payload.generatedChapterId && job.payload.pendingStage === 'planning')) throw new HttpError('剧情规划功能已移除，历史输出仅供查看', 410); if (!['failed', 'paused'].includes(job.status) || this.controllers.has(job.id)) throw new HttpError('仅可为已暂停或失败且请求已结束的任务导入输出', 409);
    this.store.assertVersion(job.branchId, job.baseRevisionId);
    let stage = job.payload.pendingStage as OutputStage | undefined;
    let chapterId: string | undefined; let blockIndex: number | undefined;
    if (!stage) {
      if (job.kind === 'plan') { if (job.payload.purpose !== 'compress-summary') throw new HttpError('剧情规划功能已移除，不能导入新的规划输出', 410); stage = 'compression'; }
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
      if (['planning', 'compression'].includes(output.stage) && job.payload.purpose === 'compress-summary') this.applyCompression(job, output, parseStructuredText(editedText, value => z.object({ text: z.string().min(1) }).parse(value)).text);
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
      this.charge(jobId, result, content(result), stage); this.live(jobId); return { result, output };
    } catch (error) {
      // Providers may wrap a failed persistence callback; retain the response charge and stop extraction retries.
      if (stage === 'extraction' && captureFailed) {
        if (failedCaptureUsage && !(error instanceof ModelOutputError)) error = new ModelOutputError(error instanceof Error ? error.message : '保存模型响应失败', failedCaptureUsage);
        if (error instanceof Error) this.nonRetryableExtractionErrors.add(error);
      }
      if (error instanceof ModelInteractionPause) { this.chargeRpgUsage(jobId, error); throw error; }
      if (output) { if (stage === 'writing') { const draft = this.store.db.prepare('SELECT text FROM job_writing_drafts WHERE job_id=?').get(jobId); if (draft?.text) this.store.outputs.update(output.id, { normalizedText: this.redact(String(draft.text)) }); } this.failOutput(output, error); }
      throw error;
    }
    finally { pending = false; }
  }
  private publicJob(job: Job): Job { return { ...job, chapterStartChoiceId: (job.payload.rpgChapterAnswer as { choiceId?: string } | undefined)?.choiceId, pendingChoice: job.status === 'paused' && !job.payload.rpgChoiceAnswer && !job.payload.generatedChapterId && !job.payload.rpgNextChoice ? job.payload.rpgChoice as RpgChoice | undefined : undefined, usageEstimated: Boolean(job.payload.usageEstimated), generatedChapterId: job.payload.generatedChapterId as string | undefined, title: job.payload.title as string | undefined, generationInput: job.kind === 'generate' ? { mode: job.payload.mode as GenerateInput['mode'], instruction: String(job.payload.instruction ?? ''), maxWords: job.payload.maxWords as number | undefined, title: job.payload.title as string | undefined } : undefined, purpose: job.payload.purpose === 'compress-summary' ? 'compress-summary' : undefined, payload: {} }; }
  writingSnapshot(jobId: string): Extract<WritingEvent, { type: 'snapshot' }> {
    const job = this.get(jobId); if (job.kind !== 'generate') throw new HttpError('此任务不是正文生成任务', 400);
    const row = this.store.db.prepare('SELECT text FROM job_writing_drafts WHERE job_id=?').get(job.id);
    return JSON.parse(this.redact(JSON.stringify({ type: 'snapshot', text: String(row?.text ?? ''), title: String(job.payload.title ?? '新章节'), job: this.publicJob(job), chapterId: job.payload.generatedChapterId as string | undefined, activities: this.store.listWritingActivities(jobId) }))) as Extract<WritingEvent, { type: 'snapshot' }>;
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
      const activities = ['completed', 'failed', 'cancelled', 'stale', 'paused'].includes(job.status) && !(job.status === 'paused' && job.payload.rpgChoice && !job.payload.rpgChoiceAnswer && !job.payload.generatedChapterId && !job.payload.rpgNextChoice)
        ? this.store.finishWritingActivities(job.id, job.status === 'completed' ? undefined : this.redact(job.error || job.message)) : [];
      if (publish) this.notifyWriting(job, activities);
    }
  }
  enqueue(branchId: string, kind: JobKind, payload: Record<string, unknown>, onQueued?: () => void): Job {
    if (this.closed) throw new HttpError('任务服务正在关闭', 503);
    if (kind === 'plan' && payload.purpose !== 'compress-summary') throw new HttpError('剧情规划功能已移除', 410);
    let branch = this.store.assertVersion(branchId, String(payload.baseRevisionId ?? ''));
    if (this.deletingProjects.has(branch.projectId)) throw new HttpError('作品正在删除，不能创建任务', 409);
    let state = this.store.state(branchId); const rewriting = kind === 'generate' && Boolean(payload.chapterId);
    const startingRpg = kind === 'generate' && payload.mode === 'rpg' && payload.rpg !== undefined;
    const branchJobs = this.jobsInternal().filter(job => job.branchId === branchId && ['queued', 'running', 'paused', 'failed'].includes(job.status));
    const backgroundJobs = branchJobs.filter(job => job.kind === 'extract' && (job.status !== 'failed' || this.store.state(branchId).chapters.some(chapter => chapter.status !== 'ready')));
    const unfinished = state.chapters.some(chapter => chapter.status !== 'ready');
    if (rewriting && (backgroundJobs.length || unfinished) && !payload.discardBackground) throw new HttpError('后台资料整理尚未完成，可以等待完成，或选择放弃后台任务后重新生成', 409);
    if (!startingRpg && branchJobs.some(job => ['queued', 'running', 'paused'].includes(job.status) && !(rewriting && payload.discardBackground && job.kind === 'extract'))) throw new HttpError('此故事线已有进行中或暂停的任务，请先完成或取消', 409);
    if ((kind === 'generate' || kind === 'import') && unfinished && !rewriting && !startingRpg) throw new HttpError('请先完成上一章资料整理', 409);
    if (kind === 'import' && (!Array.isArray(payload.chapters) || !payload.chapters.length)) throw new HttpError('导入目录为空');
    if (kind === 'generate') {
      if (!['original', 'continuation', 'fanfiction', 'rewrite', 'rpg'].includes(String(payload.mode))) throw new HttpError('写作模式不正确');
      if (payload.rpg !== undefined && payload.mode !== 'rpg') throw new HttpError('穿越角色设置仅用于 RPG 模式');
      if (state.rpg && payload.mode !== 'rpg') throw new HttpError('RPG 体验线请使用 RPG 模式继续剧情');
      if (payload.mode === 'rpg') {
        if (payload.chapterId || payload.selection || payload.regenerate) throw new HttpError('RPG 模式不支持改写或重新生成章节，请从原作另开体验线');
        if (startingRpg) rpgSetupSchema.parse(payload.rpg);
        else if (!state.rpg) throw new HttpError('请先选择原创角色或已有角色，创建 RPG 体验线');
        else if (state.rpg.nextChoice) throw new HttpError('本章已结束，请先回答章末选择以进入下一章', 409);
      }
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
      if (startingRpg) {
        const fork = this.store.startRpgFork(branchId, branch.revisionId, payload.rpg as GenerateInput['rpg'] & {});
        branch = fork.branch; state = fork.state; smallPayload.rpg = state.rpg;
        smallPayload.sourceBranchId = branchId;
      }
      if (rewriting) {
        const original = this.store.chapter(branchId, String(payload.chapterId));
        const fork = this.store.forkForGeneration(branchId, branch.revisionId, original.id); branch = fork.branch;
        smallPayload.sourceBranchId = branchId; smallPayload.sourceChapterId = original.id;
        smallPayload.chapterId = undefined; smallPayload.title = payload.title || original.title;
        if (payload.discardBackground) for (const background of backgroundJobs) { background.status = 'cancelled'; background.message = '作者放弃后台整理，已创建重新生成分支'; this.save(background); }
      }
      if (kind === 'generate') {
        const reference = this.store.resolveSourceReference(branch.id);
        if (reference && !(kind === 'generate' && payload.mode === 'original' && !reference.sourceIds?.length)) smallPayload.sourceReference = reference;
        else delete smallPayload.sourceReference;
        smallPayload.sourceReferenceCaptured = true;
      }
      if (kind === 'generate' && !smallPayload.title) smallPayload.title = `第 ${state.chapters.length + 1} 章`;
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
      if (action === 'cancel' && job.payload.generatedChapterId && job.payload.postWritingPlanning === 'pending') {
        job.payload.postWritingPlanning = 'cancelled'; delete job.payload.pendingPlotPlan; delete job.payload.pendingStage; this.save(job);
      }
    } else {
      if (!['paused', 'failed'].includes(job.status)) throw new HttpError('只能继续暂停或失败的任务');
      if (job.payload.rpgChoice && !job.payload.rpgChoiceAnswer && !job.payload.generatedChapterId && !job.payload.rpgNextChoice) throw new HttpError('请先选择剧情选项或填写自定义行动', 409);
      if (job.payload.mode === 'rpg' && job.payload.rpgContinuation && !job.payload.generatedChapterId) {
        this.assertRpgProvider(job);
        const continuation = job.payload.rpgContinuation as ModelToolContinuation;
        // A manual retry starts a new billable attempt after the last complete turn.
        // The previous failed attempt remains charged and available in output records.
        job.payload.rpgChargedUsage = { inputTokens: continuation.inputTokens, outputTokens: continuation.outputTokens };
        this.store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET text=excluded.text').run(job.id, continuation.text);
      }
      if (job.kind === 'plan' && job.payload.purpose !== 'compress-summary') throw new HttpError('剧情规划功能已移除，历史记录仅供查看', 410);
      this.store.assertVersion(job.branchId, job.baseRevisionId);
      if (this.jobsInternal(undefined, true).some(other => other.id !== job.id && other.branchId === job.branchId)) throw new HttpError('故事线已有其他任务', 409);
      delete job.payload.extractionRetry;
      job.status = 'queued'; job.error = undefined; job.message = '等待继续'; this.save(job); queueMicrotask(() => this.pump());
    }
    return this.publicJob(job);
  }
  choose(jobId: string, input: { choiceId: string; optionId?: string; customText?: string; baseRevisionId?: string; branchId?: string }): Job {
    const job = this.get(jobId);
    if (this.deletingProjects.has(job.projectId)) throw new HttpError('作品正在删除，不能提交剧情选择', 409);
    const branchId = input.branchId ?? job.branchId;
    const branch = this.store.getBranch(branchId);
    if (branch.projectId !== job.projectId) throw new HttpError('此剧情选项不属于当前作品', 409);
    const state = this.store.state(branchId);
    const nextChoice = state.rpg?.nextChoice;
    if (job.kind === 'generate' && job.payload.mode === 'rpg' && nextChoice?.jobId === job.id && nextChoice.id === input.choiceId) {
      if (!input.baseRevisionId) throw new HttpError('章末选择需要当前故事版本，请刷新后重试', 409);
      this.store.assertVersion(branchId, input.baseRevisionId);
      if (state.chapters.at(-1)?.id !== nextChoice.chapterId || nextChoice.chapterId !== job.payload.generatedChapterId) throw new HttpError('章末剧情已经变化，此选项已失效', 409);
      if (state.chapters.some(chapter => chapter.status !== 'ready')) throw new HttpError('请先完成本章资料整理，再选择进入下一章', 409);
      if (this.jobsInternal(undefined, true).some(other => other.branchId === branchId)) throw new HttpError('故事线已有进行中或暂停的任务，请先完成或取消', 409);
      const answer = this.choiceAnswer(nextChoice, input);
      // The choice, new version and next job commit together; a duplicate cannot queue another request.
      delete state.rpg!.nextChoice;
      const reference = this.store.resolveSourceReference(branchId);
      const title = `第 ${state.chapters.length + 1} 章`;
      let nextJob!: Job;
      this.store.commit(branchId, branch.revisionId, state, '确认章末选择，开始下一章', revisionId => {
        nextJob = { id: randomUUID(), projectId: job.projectId, branchId, kind: 'generate', status: 'queued', baseRevisionId: revisionId, progress: 0, total: 1, message: '已保存章末选择，等待开始下一章', inputTokens: 0, outputTokens: 0, createdAt: now(), updatedAt: now(), payload: { mode: 'rpg', instruction: nextChoice.instruction, maxWords: nextChoice.maxWords, title, rpgChapterAnswer: { question: nextChoice.question, ...answer, ...(nextChoice.followingChoices?.length ? { unansweredQuestions: nextChoice.followingChoices } : {}) }, sourceReferenceCaptured: true, ...(reference ? { sourceReference: reference } : {}) } };
        this.save(nextJob, false);
      });
      this.notifyWriting(nextJob); queueMicrotask(() => this.pump()); return this.publicJob(nextJob);
    }
    if (branchId !== job.branchId) throw new HttpError('此剧情选项已失效或不属于当前故事线', 409);
    const choice = job.payload.rpgChoice as RpgChoice | undefined;
    if (job.kind !== 'generate' || job.payload.mode !== 'rpg' || job.status !== 'paused' || !choice || choice.id !== input.choiceId || job.payload.rpgChoiceAnswer) throw new HttpError('此剧情选项已失效或已经回答，请刷新后重试', 409);
    this.store.assertVersion(job.branchId, job.baseRevisionId);
    this.assertRpgProvider(job);
    const answer = this.choiceAnswer(choice, input);
    if (this.jobsInternal(undefined, true).some(other => other.id !== job.id && other.branchId === job.branchId)) throw new HttpError('故事线已有其他任务', 409);
    job.payload.rpgChoiceAnswer = answer;
    job.status = 'queued'; job.error = undefined; job.message = '已保存选择，等待继续剧情'; this.save(job);
    queueMicrotask(() => this.pump()); return this.publicJob(job);
  }
  private choiceAnswer(choice: RpgChoice, input: { optionId?: string; customText?: string }) {
    const customText = input.customText?.trim(); const hasOption = Boolean(input.optionId); const hasCustom = Boolean(customText);
    if (hasOption === hasCustom) throw new HttpError('请选择一个选项，或填写一条自定义行动');
    const option = hasOption ? choice.options.find(option => option.id === input.optionId) : undefined;
    if (hasOption && !option) throw new HttpError('所选选项不存在');
    if (customText && customText.length > 10000) throw new HttpError('自定义行动最多 10000 字符');
    return option ? { choiceId: choice.id, optionId: option.id, text: option.label, ...(option.description ? { description: option.description } : {}) } : { choiceId: choice.id, customText, text: customText! };
  }
  private assertRpgProvider(job: Job) {
    const provider = this.provider('writing'); const previous = job.payload.rpgProvider as { id: string; protocol: string; model: string; baseUrl: string } | undefined;
    if (previous && (previous.id !== provider.id || previous.protocol !== provider.protocol || previous.model !== provider.model || previous.baseUrl !== provider.baseUrl)) throw new HttpError('RPG 续接需要使用原供应商、协议、服务地址和模型，请恢复原配置后继续', 409);
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
    const task = role === 'writing' ? '写作' : role === 'planning' ? '摘要压缩' : '资料提取';
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
  private charge(jobId: string, result: { inputTokens: number; outputTokens: number; usageEstimated?: boolean }, output: string, stage: OutputStage = 'writing') {
    const job = this.get(jobId); const missingUsage = !result.inputTokens || !result.outputTokens;
    if (stage === 'writing' && job.payload.mode === 'rpg' && job.payload.rpgContinuation) { this.chargeRpgUsage(jobId, result); return; }
    job.inputTokens += result.inputTokens || Number(job.payload.lastRequestInputEstimate ?? 0); job.outputTokens += result.outputTokens || estimateTokens(output);
    if (missingUsage || result.usageEstimated) job.payload.usageEstimated = true; this.save(job);
  }
  private chargeRpgUsage(jobId: string, cumulative: { inputTokens: number; outputTokens: number; usageEstimated?: boolean }) {
    const job = this.get(jobId); const charged = (job.payload.rpgChargedUsage ?? { inputTokens: 0, outputTokens: 0 }) as { inputTokens: number; outputTokens: number };
    job.inputTokens += Math.max(0, cumulative.inputTokens - charged.inputTokens); job.outputTokens += Math.max(0, cumulative.outputTokens - charged.outputTokens);
    job.payload.rpgChargedUsage = { inputTokens: Math.max(charged.inputTokens, cumulative.inputTokens), outputTokens: Math.max(charged.outputTokens, cumulative.outputTokens) };
    if (cumulative.usageEstimated || (job.payload.rpgContinuation as ModelToolContinuation | undefined)?.usageEstimated) job.payload.usageEstimated = true;
    this.save(job);
  }
  private promptVariables(job: Job, state = this.store.state(job.branchId)): Record<string, string> {
    const project = this.store.getProject(job.projectId);
    return { projectTitle: project.title, premise: project.premise || '', chapterNumber: String(state.chapters.length + 1), instruction: String(job.payload.instruction ?? '') };
  }
  private writingReference(job: Job) {
    let reference = job.payload.sourceReference as StoryReference | undefined;
    // Old jobs and derived lines acquire a reference without rewriting historical states.
    if (!reference && !job.payload.sourceReferenceCaptured) {
      reference = this.store.resolveSourceReference(job.branchId);
      if (reference && job.kind === 'generate' && job.payload.mode === 'original' && !reference.sourceIds?.length) reference = undefined;
      if (reference) job.payload.sourceReference = reference;
      job.payload.sourceReferenceCaptured = true; this.save(job);
    }
    return reference && !(job.kind === 'generate' && job.payload.mode === 'original' && !reference.sourceIds?.length) ? this.store.originalReference(job.branchId, reference) : undefined;
  }
  private taskPrompt(task: PromptTask, variables: Record<string, string>, runtime: PromptRuntime = {}): ModelRequest {
    return compileTaskPrompt(this.getSettings().promptTemplates, task, variables, runtime);
  }
  /** Read-only preview: uses actual prompt and tool builders, never executes a tool or reads a work. */
  previewPrompt(input: PromptPreviewInput): PromptPreviewResult {
    const { task, templates, variables, runtime, protocol } = input;
    const compiled = compileTaskPrompt(templates, task, variables, runtime);
    const tools: ModelTool[] = [];
    if (task === 'writing') tools.push(...buildWritingContext({ state: emptyState(), chapterText: () => '' }).tools);
    if (task === 'writing') {
      tools.push(...this.imageTools('', runtime.illustrations ?? { portrait: false, cg: false }).tools);
      if (variables.mode === 'rpg' && runtime.rpg) tools.push(...this.rpgTools('').tools);
    }
    const request: ModelRequest = { ...compiled, tools, ...(task === 'writing' && variables.mode === 'rpg' ? { chapterBudget: { targetWords: normalizeChapterWords(Number(variables.maxWords)) } } : {}) };
    const body = buildRequestSnapshot({ id: 'preview', name: '提示词预览', protocol, baseUrl: 'https://preview.invalid', model: 'preview-model', maxOutputTokens: 4096, contextTokens: 2000000 }, request).body;
    const native = JSON.parse(body);
    const messages = protocol === 'openai-chat' ? native.messages : protocol === 'openai-responses' ? native.input : protocol === 'gemini'
      ? [...(native.systemInstruction ? [{ role: 'system', content: native.systemInstruction.parts.map((part: { text: string }) => part.text).join('\n\n') }] : []), ...native.contents.map((message: { role: string; parts: { text: string }[] }) => ({ role: message.role === 'model' ? 'assistant' : 'user', content: message.parts.map(part => part.text).join('\n\n') }))]
      : [...(native.system ? [{ role: 'system', content: native.system }] : []), ...native.messages.map((message: { role: string; content: string | { text: string }[] }) => ({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join('\n\n') }))];
    const previewTools: PromptPreviewResult['tools'] = compiled.writingOutputMode === 'tool' ? [writingResponseTool(tools)] : tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
    if (compiled.structuredOutput?.mode === 'tool') previewTools.push({ name: compiled.structuredOutput.name, description: compiled.structuredOutput.description, parameters: compiled.structuredOutput.schema });
    return { messages, runtimeBlocks: compiled.runtimeBlocks, tools: previewTools, body };
  }
  private compressionSegments(source: string, provider: ProviderConfig, job: Job): string[] {
    const config = normalizePromptTemplates(this.getSettings().promptTemplates);
    const variables = this.promptVariables(job);
    return compressionChunks(source, provider, summaryText => compileTaskPrompt(config, 'compression', { ...variables, summaryText }));
  }
  private checkpoint(job: Job, payload: Record<string, unknown>, progress = job.progress, message = job.message) {
    return (revisionId: string, branchId: string) => { job.baseRevisionId = revisionId; job.branchId = branchId; job.payload = payload; job.progress = progress; job.message = message; this.save(job, !(job.kind === 'generate' && job.status === 'completed')); };
  }
  private outputCheckpoint(job: Job, output: ModelOutputRecord, payload: Record<string, unknown>, progress: number, message: string, local: boolean, completed = false) {
    if (local) { job.status = completed ? 'completed' : 'paused'; job.error = undefined; }
    return (revisionId: string, branchId: string) => { this.checkpoint(job, payload, completed ? job.total : progress, local && !completed ? `${message}；已暂停，可点击继续` : message)(revisionId, branchId); this.store.outputs.update(output.id, { status: 'applied', error: undefined, issues: [] }); };
  }
  private rpgTools(jobId: string): { tools: ModelTool[] } {
    return { tools: [{
      name: 'ask_user', description: '在玩家需要决定行动、台词、立场或关键剧情走向时暂停剧情并询问玩家。给出 2 至 6 个不同且基于角色当前已知信息的可行选项，玩家也可以自定义行动。调用后等待真实用户选择，不能替用户回答、代做行动或继续决定后果；不展示未来剧情和隐藏设定。',
      parameters: { type: 'object', properties: { question: { type: 'string', maxLength: 3000 }, options: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'object', properties: { id: { type: 'string', maxLength: 100 }, label: { type: 'string', maxLength: 500 }, description: { type: 'string', maxLength: 2000 } }, required: ['id', 'label'], additionalProperties: false } } }, required: ['question', 'options'], additionalProperties: false },
      execute: args => {
        const parsed = rpgChoiceSchema.safeParse(args);
        if (!parsed.success) return { error: '询问须包含非空问题和 2 至 6 个选项，每个选项提供唯一 id 与非空 label；请修正参数。' };
        const job = this.live(jobId); const continuation = job.payload.rpgContinuation as ModelToolContinuation | undefined;
        const pending = continuation?.pending; const call = pending?.calls[pending.nextIndex];
        if (!call || call.name !== 'ask_user') throw new HttpError('剧情选择缺少可恢复的工具上下文，请重新开始本段剧情', 409);
        const callKey = `${continuation!.round}:${pending!.nextIndex}:${call.id}`;
        if (job.payload.rpgChoiceCallKey === callKey && job.payload.rpgChoiceAnswer) return { status: 'answered', ...(job.payload.rpgChoiceAnswer as Record<string, unknown>), message: '这是用户确认的选择。只按该选择继续剧情；下一个关键决定仍须询问用户。' };
        const choice: RpgChoice = { id: randomUUID(), ...parsed.data };
        job.payload.rpgChoice = choice; job.payload.rpgChoiceCallKey = callKey; delete job.payload.rpgChoiceAnswer;
        if (chapterBudgetReached(continuation!.text, normalizeChapterWords(job.payload.maxWords as number | undefined))) {
          const followingChoices = pending!.calls.slice(pending!.nextIndex + 1).flatMap(other => {
            if (other.name !== 'ask_user') return [];
            try { const value = rpgChoiceSchema.safeParse(typeof other.arguments === 'string' ? JSON.parse(other.arguments) : other.arguments); return value.success ? [{ id: randomUUID(), ...value.data }] : []; } catch { return []; }
          });
          job.payload.rpgNextChoice = { ...choice, ...(followingChoices.length ? { followingChoices } : {}) }; job.message = '本章达到目标字数，正在保存正文与章末选择'; this.save(job);
          throw new ModelChapterComplete();
        }
        job.status = 'paused'; job.message = '剧情停在选择节点，等待你的决定'; job.error = undefined; this.save(job);
        throw new ModelInteractionPause('剧情等待用户选择。');
      },
    }] };
  }
  private applyWriting(job: Job, output: ModelOutputRecord, prose: string, local: boolean) {
    if (!prose.trim()) throw new OutputValidationError([{ path: '$', message: '小说正文不能为空' }]);
    if (job.payload.mode === 'rpg' && !job.payload.rpgChoice && !job.payload.rpgChapterAnswer) throw new OutputValidationError([{ path: '$', message: 'RPG 剧情没有询问玩家的选择节点，请使用支持工具调用的写作模型并重新生成；正文已保留供作者查看' }]);
    const input = job.payload as unknown as GenerateInput; const original = job.payload.sourceChapterId ? this.store.db.prepare('SELECT text FROM chapter_texts WHERE id=?').get(String(job.payload.sourceChapterId)) : undefined; const state = this.store.state(job.branchId);
    const text = original && input.selection ? String(original.text).slice(0, input.selection.start) + prose + String(original.text).slice(input.selection.end) : prose;
    this.store.saveChapter(job.branchId, { baseRevisionId: job.baseRevisionId, title: input.title || `第 ${state.chapters.length + 1} 章`, text }, (revisionId, branchId) => {
      const saved = this.store.revisionState(revisionId).chapters.at(-1)!;
      job.status = 'completed'; job.error = undefined;
      if (original && input.selection) this.store.shiftWritingActivityOffsets(job.id, this.redact(String(original.text).slice(0, input.selection.start)).length);
      this.store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET text=excluded.text').run(job.id, text);
      this.outputCheckpoint(job, output, { ...job.payload, pendingPlotPlan: undefined, generatedChapterId: saved.id, postWritingPlanning: undefined, pendingStage: undefined }, job.total, '正文已保存，资料在后台整理', local, true)(revisionId, branchId);
      this.queueExtraction(job, saved.id, local);
    }, state => {
      if (job.payload.sourceReference) state.sourceReference = structuredClone(job.payload.sourceReference as StoryReference);
      if (state.rpg && job.payload.rpgNextChoice) state.rpg.nextChoice = { ...structuredClone(job.payload.rpgNextChoice as RpgChoice), jobId: job.id, chapterId: state.chapters.at(-1)!.id, maxWords: normalizeChapterWords(input.maxWords), instruction: input.instruction };
    });
    this.notifyWriting(job);
    queueMicrotask(() => this.pump());
  }
  private queueExtraction(writing: Job, chapterId: string, paused: boolean, blockIndex = 0) {
    const background: Job = { id: randomUUID(), projectId: writing.projectId, branchId: writing.branchId, kind: 'extract', status: paused ? 'paused' : 'queued', baseRevisionId: writing.baseRevisionId, progress: 0, total: 1, message: paused ? '正文已修复；请手动继续后台资料整理' : '正文已保存，等待后台资料整理', inputTokens: 0, outputTokens: 0, createdAt: now(), updatedAt: now(), payload: { extractChapterId: chapterId, blockIndex, writingJobId: writing.id } };
    this.save(background);
  }
  private imageTools(jobId: string, preview?: PromptRuntime['illustrations']): { tools: ModelTool[] } {
    const config = preview ? { autoPortrait: preview.portrait, autoCG: preview.cg } : normalizeImageSettings(this.getSettings().imageSettings);
    if (!preview && (!this.images || !('providerId' in config) || !config.providerId || !config.model)) return { tools: [] };
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
    return { tools };
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
    if (work.pass + 1 >= MAX_COMPRESSION_PASSES) throw new HttpError(`摘要压缩已完成 ${MAX_COMPRESSION_PASSES} 轮，合并候选仍超出摘要压缩模型的上下文；已完成片段保留，请提高摘要压缩模型上下文上限后继续，或重新创建压缩任务`);
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
      const { result, output } = await this.requestCaptured(jobId, 'compression', request, req => this.models.generateStructured(provider, req, value => z.object({ text: z.string().min(1) }).parse(value)), result => JSON.stringify(result.value), undefined, work.completed);
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
      else { progress++; finished = job.payload.targetChapterId === output.chapterId || this.store.state(job.branchId).chapters.every(c => c.id === output.chapterId || c.status === 'ready'); }
    }
    this.store.applyExtraction(job.branchId, job.baseRevisionId, output.chapterId, value, complete, this.outputCheckpoint(job, output, payload, progress, complete ? '本章资料已保存' : `已保存片段 ${output.blockIndex + 1}/${blocks.length}`, local, finished));
    if (complete) this.illustrateChapter(job, output.chapterId);
  }
  private async extractChapter(jobId: string, chapterId: string, signal: AbortSignal) {
    let job = this.live(jobId); const chapter = this.store.chapter(job.branchId, chapterId); const blocks = splitBlocks(chapter.text); let blockIndex = job.payload.extractChapterId === chapterId ? Number(job.payload.blockIndex ?? 0) : 0;
    for (; blockIndex < blocks.length; blockIndex++) {
      let lastFailure: unknown;
      for (;;) {
        job = this.live(jobId); const provider = this.provider('extraction'); const state = this.store.state(job.branchId);
        const context = extractionContext(this.store.readingState(job.branchId, chapterId), blocks[blockIndex]);
        const retry = job.payload.extractionRetry as { chapterId?: string; blockIndex?: number; failedAttempts?: number } | undefined;
        const failedAttempts = retry?.chapterId === chapterId && retry.blockIndex === blockIndex ? Number(retry.failedAttempts ?? 0) : 0;
        const retryConfig = normalizeTaskSettings(this.getSettings().taskSettings).extraction;
        if (failedAttempts && (!retryConfig.autoRetry || failedAttempts > retryConfig.maxRetries)) throw lastFailure ?? new HttpError('资料提取自动重试已关闭或次数已用完，请检查设置后手动继续');
        const message = `整理「${chapter.title}」片段 ${blockIndex + 1}/${blocks.length}`;
        job.message = failedAttempts ? `${message}；正在第 ${failedAttempts} 次自动重试` : message; this.save(job);
        // Configuration and context-budget failures require an author change, not another request.
        const request = this.budget(job, provider, { ...this.taskPrompt('extraction', { ...this.promptVariables(job, state), chapterNumber: String(state.chapters.findIndex(value => value.id === chapterId) + 1), context, chapterTitle: chapter.title, blockText: blocks[blockIndex].text }, { extractionOutputMode: retryConfig.outputMode }), signal });
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
        throw new HttpError('剧情规划功能已移除', 410);
      }
      if (job.kind === 'generate') {
        // Completed prose owns an independent extraction job; tool continuations do not regenerate it.
        if (job.payload.generatedChapterId) {
          const chapter = this.store.chapter(job.branchId, String(job.payload.generatedChapterId));
          this.store.db.exec('BEGIN IMMEDIATE');
          try {
            job.status = 'completed'; job.progress = job.total; job.message = '正文已保存，资料在后台整理'; job.error = undefined;
            delete job.payload.postWritingPlanning; delete job.payload.pendingPlotPlan; delete job.payload.pendingStage;
            this.store.db.prepare('INSERT OR IGNORE INTO job_writing_drafts VALUES(?,?)').run(job.id, chapter.text); this.save(job, false);
            if (chapter.status !== 'ready' && !this.jobsInternal(undefined, true).some(other => other.branchId === job.branchId && other.kind === 'extract')) this.queueExtraction(job, chapter.id, false, job.payload.extractChapterId === chapter.id ? Number(job.payload.blockIndex ?? 0) : 0);
            this.store.db.exec('COMMIT');
          } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
          this.notifyWriting(job); return;
        }
        const input = job.payload as unknown as GenerateInput;
        const state = this.store.state(job.branchId); const provider = { ...this.provider('writing'), stream: true };
        const context = buildWritingContext({ state, premise: this.store.getProject(job.projectId).premise, chapterText: id => this.store.chapter(job.branchId, id).text, original: this.writingReference(job) });
        const original = job.payload.sourceChapterId && !input.regenerate ? this.store.db.prepare('SELECT text FROM chapter_texts WHERE id=?').get(String(job.payload.sourceChapterId)) : undefined;
        const selected = original ? input.selection ? String(original.text).slice(input.selection.start, input.selection.end) : String(original.text) : undefined;
        const continuation = input.mode === 'rpg' ? job.payload.rpgContinuation as ModelToolContinuation | undefined : undefined;
        if (!continuation) {
          this.store.clearWritingActivities(job.id);
          this.store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET text=excluded.text').run(job.id, '');
        }
        this.emitWriting(job.id, this.writingSnapshot(job.id));
        job.message = '正在流式生成正文'; this.save(job);
        if (!continuation) { job.payload.imageStartingEntityIds = state.entities.map(entity => entity.id); job.payload.imageRequests = []; delete job.payload.pendingPlotPlan; this.save(job); }
        const illustrations = this.imageTools(jobId);
        const rpg = input.mode === 'rpg' && state.rpg ? this.rpgTools(jobId) : { tools: [] };
        const prompt: ModelRequest = continuation ? { system: '', prompt: '', writingOutputMode: continuation.writingOutputMode } : this.taskPrompt('writing', {
          ...this.promptVariables(job, state), ...context.variables, context: context.text, mode: input.mode,
          maxWords: String(Math.min(20000, Math.max(100, Number(input.maxWords) || 2000))), sourceText: selected ?? '',
          writingTarget: selected ? `需要改写的${input.selection ? '片段（只输出替换片段）' : '章节'}：\n${selected}` : `请写第 ${state.chapters.length + 1} 章。`,
        }, { rpg: state.rpg, illustrations: { portrait: illustrations.tools.some(tool => tool.name === 'generate_character_portrait'), cg: illustrations.tools.some(tool => tool.name === 'generate_scene_cg') }, chapterAnswer: job.payload.rpgChapterAnswer ? JSON.stringify(job.payload.rpgChapterAnswer) : undefined });
        const aliases = job.payload.rpgLookupAliases as Record<string, string> | undefined;
        const retrievalTools = aliases ? context.tools.map(tool => ({ ...tool, execute: (args: Record<string, unknown>) => tool.execute({ ...args, ...(typeof args.id === 'string' ? { id: aliases[args.id] ?? args.id } : {}), ...(typeof args.chapterId === 'string' ? { chapterId: aliases[args.chapterId] ?? args.chapterId } : {}) }) })) : context.tools;
        const tools = [...retrievalTools, ...illustrations.tools, ...rpg.tools];
        if (continuation) {
          const declared = (continuation.body.tools ?? []) as Record<string, any>[];
          const names = declared.flatMap(tool => tool.functionDeclarations ?? [tool.function ?? tool]).flatMap(tool => [tool.name ?? '', ...((tool.parameters ?? tool.parametersJsonSchema ?? tool.input_schema)?.properties?.toolCalls?.items?.properties?.name?.enum ?? [])]);
          for (const name of names.filter(name => ['update_plot_plan', 'generate_character_portrait', 'generate_scene_cg'].includes(name) && !tools.some(tool => tool.name === name))) tools.push({ name, description: '原会话工具已经停用。', parameters: { type: 'object' }, execute: () => ({ error: name === 'update_plot_plan' ? '剧情规划功能已移除，此工具不会执行。' : '此工具已由用户停用，本次请求未执行；请继续剧情，不得假设图片已经生效。' }) });
        }
        if (input.mode === 'rpg') {
          const previous = job.payload.rpgProvider as { id: string; protocol: string; model: string; baseUrl: string } | undefined;
          if (continuation && previous && (previous.id !== provider.id || previous.protocol !== provider.protocol || previous.model !== provider.model || previous.baseUrl !== provider.baseUrl)) throw new HttpError('RPG 续接需要使用原供应商、协议、服务地址和模型，请恢复原配置后继续');
          job.payload.rpgProvider = { id: provider.id, protocol: provider.protocol, model: provider.model, baseUrl: provider.baseUrl }; this.save(job);
        }
        const request = this.budget(job, provider, { ...prompt, signal: controller.signal, tools, onTextDelta: text => this.writingDelta(jobId, text), onActivity: event => this.writingActivity(jobId, event), ...(input.mode === 'rpg' ? { continuation, chapterBudget: { targetWords: normalizeChapterWords(input.maxWords) }, maxToolRounds: 24, onContinuation: (value: ModelToolContinuation) => { const fresh = this.live(jobId); fresh.payload.rpgContinuation = JSON.parse(this.redact(JSON.stringify(value))) as ModelToolContinuation; this.save(fresh); } } : {}) });
        const { result, output } = await this.requestCaptured(jobId, 'writing', request, req => this.models.generateText(provider, req), result => result.text);
        this.applyWriting(this.live(jobId), output, result.text, false);
        return;
      }
      if (job.kind === 'extract') {
        job = this.live(jobId);
        if (typeof job.payload.pendingIllustrationChapterId === 'string') this.illustrateChapter(job, job.payload.pendingIllustrationChapterId);
        job = this.live(jobId); const pending = this.store.state(job.branchId).chapters.filter(c => c.status !== 'ready' && (!job.payload.targetChapterId || c.id === job.payload.targetChapterId));
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
      if (error instanceof ModelInteractionPause) return;
      job = this.get(jobId);
      if (error instanceof ModelOutputError && !this.chargedExtractionErrors.has(error)) { if (job.payload.pendingStage === 'writing' && job.payload.mode === 'rpg' && job.payload.rpgContinuation) { this.chargeRpgUsage(jobId, error); job = this.get(jobId); } else { job.inputTokens += error.inputTokens || Number(job.payload.lastRequestInputEstimate ?? 0); job.outputTokens += error.outputTokens || Number(job.payload.lastRequestOutputLimit ?? 0); if (!error.inputTokens || !error.outputTokens) job.payload.usageEstimated = true; this.save(job); } }
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
