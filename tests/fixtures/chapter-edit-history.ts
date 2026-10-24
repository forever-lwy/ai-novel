import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Store } from '../../server/store.js';
import type { Job, StoryState } from '../../shared/types.js';
import { readingProgressStory } from './reading-progress.js';

export function chapterEditHistoryStory(store: Store) {
  const story = readingProgressStory(store); const chapter = story.third.state.chapters[2]; const stamp = new Date().toISOString();
  const job: Job = { id: randomUUID(), projectId: story.project.id, branchId: story.branchId, baseRevisionId: story.third.branch.revisionId, kind: 'generate', status: 'completed', progress: 1, total: 1, message: '本地样例已完成', inputTokens: 10, outputTokens: 20, payload: { generatedChapterId: chapter.id, title: chapter.title }, createdAt: stamp, updatedAt: stamp };
  store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, job.branchId, job.projectId, job.status, JSON.stringify(job));
  store.recordWritingActivity(job.id, { type: 'thinking', id: 'original-thinking', text: '原生成过程：先核对灯塔场景。' });
  store.recordWritingActivity(job.id, { type: 'thinking_done', id: 'original-thinking' });
  store.db.prepare('INSERT INTO job_writing_drafts VALUES(?,?)').run(job.id, store.chapter(story.branchId, chapter.id).text.slice(0, 6));
  store.recordWritingActivity(job.id, { type: 'tool_call', id: 'original-tool', name: 'search_story', arguments: { q: '灯塔' } });
  store.recordWritingActivity(job.id, { type: 'tool_result', id: 'original-tool', name: 'search_story', result: '核对灯塔的既有资料。' });
  return { ...story, job, chapter };
}

/** Reproduce the previously persisted edit format, including its detached illustration IDs. */
export function legacyChapterEdit(store: Store, branchId: string, text: string) {
  const current = store.state(branchId); const chapter = current.chapters.at(-1)!;
  const edited = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, chapterId: chapter.id, title: chapter.title, text });
  const row = store.db.prepare('SELECT state FROM revisions WHERE id=?').get(edited.branch.revisionId)!;
  const raw: StoryState = JSON.parse(gunzipSync(row.state as Uint8Array).toString());
  delete raw.chapters.at(-1)!.previousChapterIds;
  raw.imageIds = raw.imageIds?.filter(id => { const source = store.images.get(id)?.chapterId; return source !== chapter.id && !chapter.previousChapterIds?.includes(source ?? ''); });
  raw.activeImageIds = raw.activeImageIds?.filter(id => raw.imageIds?.includes(id));
  store.db.prepare('UPDATE revisions SET state=? WHERE id=?').run(gzipSync(JSON.stringify(raw)), edited.branch.revisionId);
  return edited.branch.revisionId;
}
