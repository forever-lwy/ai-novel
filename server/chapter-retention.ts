import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import type { ChapterRef, StoryState } from '../shared/types.js';

export const jobChapterFields = ['generatedChapterId', 'extractChapterId', 'importCurrentChapterId', 'chapterId', 'targetChapterId', 'sourceChapterId', 'pendingTitleChapterId', 'placementChapterId', 'pendingCGChapterId', 'pendingIllustrationChapterId'] as const;
/** Chapter bodies are shared by revisions; old edit IDs and diagnostic evidence also need them. */
export function retainedChapterIds(db: DatabaseSync, options: { projectId?: string; excludeProjectId?: string; deleteRevisionIds?: ReadonlySet<string>; deleteJobIds?: ReadonlySet<string>; deleteOutputIds?: ReadonlySet<string> } = {}): Set<string> {
  const ids = new Set<string>();
  const add = (chapter: ChapterRef) => { ids.add(chapter.id); for (const previous of chapter.previousChapterIds ?? []) ids.add(previous); };
  for (const row of db.prepare('SELECT r.id,r.state,b.project_id FROM revisions r JOIN branches b ON b.id=r.branch_id').iterate()) {
    if (options.projectId && row.project_id !== options.projectId || row.project_id === options.excludeProjectId || options.deleteRevisionIds?.has(String(row.id))) continue;
    const state = JSON.parse(gunzipSync(row.state as Uint8Array).toString('utf8')) as StoryState;
    for (const chapter of state.chapters) add(chapter);
  }
  for (const table of ['jobs', 'model_outputs', 'extraction_evidence', 'image_assets'] as const) {
    const fields = table === 'jobs' ? jobChapterFields.map(field => `json_extract(data,'$.payload.${field}') AS ${field}`).join(',') : "json_extract(data,'$.chapterId') AS chapterId" + (table === 'model_outputs' ? ",stage='extraction' AND status='applied' AND COALESCE(length(json_extract(data,'$.normalizedText')),0)>0 AS hasEvidence" : '');
    for (const row of db.prepare(`SELECT id,project_id,${fields} FROM ${table}`).iterate()) {
      if (options.projectId && row.project_id !== options.projectId || row.project_id === options.excludeProjectId || table === 'jobs' && options.deleteJobIds?.has(String(row.id)) || table === 'model_outputs' && options.deleteOutputIds?.has(String(row.id)) && !row.hasEvidence) continue;
      if (typeof row.chapterId === 'string') ids.add(row.chapterId);
      if (table === 'jobs') for (const field of jobChapterFields) if (typeof row[field] === 'string') ids.add(row[field] as string);
    }
  }
  const pending = [...ids];
  while (pending.length) {
    const row = db.prepare('SELECT data FROM chapter_texts WHERE id=?').get(pending.pop()!);
    if (!row) continue;
    const chapter = JSON.parse(String(row.data)) as ChapterRef;
    for (const previous of chapter.previousChapterIds ?? []) if (!ids.has(previous)) { ids.add(previous); pending.push(previous); }
  }
  return ids;
}
