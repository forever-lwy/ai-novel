import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { CapturedModelResponse, ModelOutputRecord, ModelOutputSummary, OutputIssue, OutputStage } from '../shared/types.js';

export const modelOutputSchema = z.object({
  id: z.string().min(1), jobId: z.string().min(1), projectId: z.string().min(1), branchId: z.string().min(1), baseRevisionId: z.string().min(1),
  stage: z.enum(['planning', 'writing', 'extraction']), chapterId: z.string().optional(), blockIndex: z.number().int().nonnegative().optional(),
  createdAt: z.string(), updatedAt: z.string(), status: z.enum(['received', 'invalid', 'applied']),
  rawResponse: z.string(), text: z.string(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), httpStatus: z.number().int().optional(), incomplete: z.boolean().optional(),
  request: z.object({ protocol: z.enum(['openai-chat', 'openai-responses', 'gemini', 'claude']), model: z.string(), url: z.string(), method: z.literal('POST'), headers: z.record(z.string(), z.string()), body: z.string(), startedAt: z.string(), timeoutMs: z.number().positive(), stream: z.boolean() }).optional(),
  diagnostics: z.object({ elapsedMs: z.number().nonnegative(), responseBytes: z.number().nonnegative(), responseHeaders: z.record(z.string(), z.string()), transport: z.enum(['http', 'network_error', 'timeout', 'cancelled', 'interrupted']), errorCode: z.string().optional(), modelOutcome: z.enum(['completed', 'blocked', 'truncated', 'empty', 'error']).optional(), finishReason: z.string().max(100).optional(), promptBlockReason: z.string().max(100).optional() }).optional(),
  editedText: z.string().optional(), normalizedText: z.string().optional(), adjustments: z.array(z.object({ path: z.string(), message: z.string(), paragraph: z.number().int().optional(), quote: z.string().optional(), sourceText: z.string().optional() })).optional(), error: z.string().optional(), issues: z.array(z.object({ path: z.string(), message: z.string(), paragraph: z.number().int().optional(), quote: z.string().optional(), sourceText: z.string().optional() })),
});

export class OutputStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS model_outputs(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,project_id TEXT NOT NULL,branch_id TEXT NOT NULL,base_revision_id TEXT NOT NULL,stage TEXT NOT NULL,chapter_id TEXT,block_index INTEGER,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outputs_job ON model_outputs(job_id); CREATE INDEX IF NOT EXISTS outputs_project ON model_outputs(project_id);`);
  }
  create(binding: { jobId: string; projectId: string; branchId: string; baseRevisionId: string; stage: OutputStage; chapterId?: string; blockIndex?: number }, response: CapturedModelResponse): ModelOutputRecord {
    const date = new Date().toISOString();
    const record: ModelOutputRecord = { ...binding, ...response, id: randomUUID(), createdAt: date, updatedAt: date, status: 'received', issues: [] };
    this.insert(record); return record;
  }
  insert(record: ModelOutputRecord) {
    this.db.prepare('INSERT INTO model_outputs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(record.id, record.jobId, record.projectId, record.branchId, record.baseRevisionId, record.stage, record.chapterId ?? null, record.blockIndex ?? null, record.status, record.createdAt, record.updatedAt, JSON.stringify(record));
  }
  get(id: string): ModelOutputRecord | undefined { const row = this.db.prepare('SELECT data FROM model_outputs WHERE id=?').get(id); return row ? JSON.parse(String(row.data)) : undefined; }
  list(jobId: string): ModelOutputSummary[] {
    return this.db.prepare('SELECT data FROM model_outputs WHERE job_id=? ORDER BY rowid DESC').all(jobId).map(row => { const { rawResponse: _raw, text: _text, editedText: _edited, normalizedText: _normalized, adjustments: _adjustments, issues: _issues, request: _request, diagnostics: _diagnostics, ...summary } = JSON.parse(String(row.data)) as ModelOutputRecord; return summary; });
  }
  all(projectId: string): ModelOutputRecord[] { return this.db.prepare('SELECT data FROM model_outputs WHERE project_id=? ORDER BY rowid').all(projectId).map(row => JSON.parse(String(row.data))); }
  completeResponse(id: string, response: CapturedModelResponse): ModelOutputRecord {
    const old = this.get(id); if (!old) throw new Error('模型请求记录不存在');
    if (old.diagnostics || old.httpStatus !== undefined || old.rawResponse || old.text || old.status !== 'received') throw new Error('模型响应已经留存，不能覆盖');
    const record = { ...old, ...response, request: old.request ?? response.request, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE model_outputs SET updated_at=?,data=? WHERE id=?').run(record.updatedAt, JSON.stringify(record), id);
    return record;
  }
  update(id: string, changes: { editedText?: string; normalizedText?: string; adjustments?: OutputIssue[]; status?: ModelOutputRecord['status']; error?: string; issues?: OutputIssue[] }): ModelOutputRecord {
    const old = this.get(id); if (!old) throw new Error('模型输出不存在');
    const record = { ...old, ...changes, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE model_outputs SET status=?,updated_at=?,data=? WHERE id=?').run(record.status, record.updatedAt, JSON.stringify(record), id);
    return record;
  }
}
