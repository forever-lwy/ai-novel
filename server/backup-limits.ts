import type { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { RESTORE_MAX_REVISIONS, RESTORE_MAX_STATE_BYTES, RESTORE_MAX_EXPANDED_STATE_BYTES } from './store.js';

export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
/** Check sizes before materializing the complete backup, including binary files. */
export function checkBackupSize(db: DatabaseSync, uploadDir: string, projectId: string, maximum = MAX_BACKUP_BYTES) {
  const fail = () => { throw Object.assign(new Error('作品备份超过安全容量，请停止服务并备份完整数据目录。'), { statusCode: 413 }); };
  let bytes = 4096; const add = (count: number) => { bytes += count; if (bytes > maximum) fail(); };
  const chapterIds = new Set<string>(); let expanded = 0, count = 0;
  for (const row of db.prepare('SELECT r.id,r.data,length(r.state) AS state_bytes FROM revisions r JOIN branches b ON b.id=r.branch_id WHERE b.project_id=?').iterate(projectId)) {
    if (++count > RESTORE_MAX_REVISIONS) fail();
    add(Math.ceil(Number(row.state_bytes) / 3) * 4 + Buffer.byteLength(String(row.data)) + 64);
    const snapshot = db.prepare('SELECT state FROM revisions WHERE id=?').get(row.id)!.state as Uint8Array;
    let decoded: Buffer;
    try { decoded = gunzipSync(snapshot, { maxOutputLength: Math.min(RESTORE_MAX_STATE_BYTES, RESTORE_MAX_EXPANDED_STATE_BYTES - expanded) }); } catch { fail(); }
    expanded += decoded!.byteLength;
    const state = JSON.parse(decoded!.toString('utf8')) as { chapters: { id: string }[] };
    for (const chapter of state.chapters) chapterIds.add(chapter.id);
  }
  // SQL size checks avoid reading an oversized record before the budget check.
  for (const table of ['projects', 'branches', 'jobs', 'model_outputs', 'image_assets'] as const) {
    const predicate = table === 'projects' ? 'id=?' : 'project_id=?';
    const row = db.prepare(`SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes,COUNT(*) AS records FROM ${table} WHERE ${predicate}`).get(projectId)!;
    add(Number(row.bytes) + Number(row.records) * 128);
  }
  const ids = JSON.stringify([...chapterIds]);
  const chapterSize = db.prepare('SELECT COALESCE(SUM(length(CAST(text AS BLOB))+length(CAST(data AS BLOB))),0) AS bytes FROM chapter_texts WHERE id IN (SELECT value FROM json_each(?))').get(ids)!;
  add(Number(chapterSize.bytes));
  for (const row of db.prepare('SELECT text FROM chapter_texts WHERE id IN (SELECT value FROM json_each(?))').iterate(ids)) {
    const text = String(row.text); add(Buffer.byteLength(JSON.stringify(text)) - Buffer.byteLength(text) + 64);
  }
  for (const table of ['job_import_chapters', 'job_writing_drafts', 'job_writing_activities'] as const) {
    const column = table === 'job_writing_activities' ? 'data' : 'text';
    const titleSize = table === 'job_import_chapters' ? '+length(CAST(c.title AS BLOB))' : '';
    const row = db.prepare(`SELECT COALESCE(SUM(length(CAST(c.${column} AS BLOB))${titleSize}),0) AS bytes,COUNT(*) AS records FROM ${table} c JOIN jobs j ON j.id=c.job_id WHERE j.project_id=?`).get(projectId)!;
    add(Number(row.bytes) + Number(row.records) * 128);
    if (column === 'text') for (const entry of db.prepare(`SELECT c.text FROM ${table} c JOIN jobs j ON j.id=c.job_id WHERE j.project_id=?`).iterate(projectId)) { const text = String(entry.text); add(Buffer.byteLength(JSON.stringify(text)) - Buffer.byteLength(text)); }
  }
  for (const row of db.prepare('SELECT length(content) AS bytes FROM image_assets WHERE project_id=? AND content IS NOT NULL').iterate(projectId)) add(Math.ceil(Number(row.bytes) / 3) * 4);
  for (const row of db.prepare('SELECT storage_name,length(CAST(preview AS BLOB)) AS preview_bytes FROM sources WHERE project_id=?').iterate(projectId)) {
    const path = resolve(uploadDir, String(row.storage_name));
    if (dirname(path) !== resolve(uploadDir)) fail();
    add(Math.ceil(statSync(path).size / 3) * 4 + Number(row.preview_bytes) + 1024);
  }
}
