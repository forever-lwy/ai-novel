import { gunzipSync } from 'node:zlib';
import type { Branch, Revision, StoryState } from '../shared/types.js';
import type { Store } from './store.js';

export interface HistoryRetentionPolicy { maxAgeDays: number; maxCount: number }
export interface HistoryCleanupOptions {
  deleteJobIds?: ReadonlySet<string>;
  deleteOutputIds?: ReadonlySet<string>;
}
export interface HistoryCleanupPlan {
  deleteIds: string[];
  candidateCount: number;
  protectedCount: number;
  /** Surviving RPG chapter-end choices still need their originating task. */
  protectedJobIds: string[];
  updates: { revision: Revision }[];
}

interface Snapshot {
  revision: Revision;
  sequence: number;
  chapters: string[];
  sourceRevisionId?: string;
  choiceJobId?: string;
  legacyEditedChapter: boolean;
}

/** Plan under the caller's transaction; applying the plan never starts a nested transaction. */
export function planHistoryCleanup(store: Store, policy: HistoryRetentionPolicy, now = Date.now(), options: HistoryCleanupOptions = {}): HistoryCleanupPlan {
  const rows = store.db.prepare('SELECT rowid AS sequence,id,data FROM revisions ORDER BY rowid').all();
  const revisions = new Map(rows.map(row => {
    const revision = JSON.parse(String(row.data)) as Revision;
    return [revision.id, { revision, sequence: Number(row.sequence) }];
  }));
  const candidates = new Set<string>();
  const groups = new Map<string, { revision: Revision; sequence: number }[]>();
  for (const entry of revisions.values()) {
    const group = groups.get(entry.revision.branchId) ?? []; group.push(entry); groups.set(entry.revision.branchId, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(b.revision.createdAt) - Date.parse(a.revision.createdAt) || b.sequence - a.sequence);
    for (const [index, { revision }] of group.entries()) {
      const time = Date.parse(revision.createdAt);
      // Invalid historical timestamps are not grounds for destructive cleanup.
      if (Number.isFinite(time) && (policy.maxAgeDays > 0 && time < now - policy.maxAgeDays * 86_400_000 || policy.maxCount > 0 && index >= policy.maxCount)) candidates.add(revision.id);
    }
  }
  const plan: HistoryCleanupPlan = { deleteIds: [], candidateCount: candidates.size, protectedCount: 0, protectedJobIds: [], updates: [] };
  const snapshots = new Map<string, Snapshot>();
  // Decode one compressed state at a time; cleanup must not retain every snapshot
  // plus every request/response body in memory when a long-lived database is large.
  for (const row of store.db.prepare('SELECT id,state FROM revisions ORDER BY rowid').iterate()) {
    const state = JSON.parse(gunzipSync(row.state as Uint8Array).toString('utf8')) as StoryState;
    const entry = revisions.get(String(row.id))!;
    snapshots.set(entry.revision.id, {
      ...entry,
      chapters: state.chapters.map(chapter => chapter.id),
      sourceRevisionId: state.sourceReference?.revisionId,
      choiceJobId: state.rpg?.nextChoice?.jobId,
      legacyEditedChapter: entry.revision.label.startsWith('编辑正文，保留已有资料') && state.chapters.some(chapter => !chapter.previousChapterIds),
    });
  }
  // Early deployments recorded a derived story's source only in its generating
  // task. Even an older cutoff snapshot may need that task during lineage lookup.
  const legacySourceBranches = new Set([...snapshots.values()].filter(snapshot => !snapshot.sourceRevisionId).map(snapshot => snapshot.revision.branchId));
  const sourceJobs = new Set<string>();
  for (const row of store.db.prepare("SELECT id,branch_id,json_extract(data,'$.payload.sourceBranchId') AS source_branch_id FROM jobs WHERE json_extract(data,'$.kind')='generate'").iterate()) {
    if (typeof row.source_branch_id === 'string' && row.source_branch_id !== row.branch_id && legacySourceBranches.has(String(row.branch_id))) sourceJobs.add(String(row.id));
  }
  if (!candidates.size) {
    plan.protectedJobIds = [...new Set([...sourceJobs, ...[...snapshots.values()].flatMap(snapshot => snapshot.choiceJobId ? [snapshot.choiceJobId] : [])])];
    return plan;
  }
  const retained = new Set<string>(); const queue: string[] = [];
  const keep = (revisionId: string | undefined) => {
    if (revisionId && snapshots.has(revisionId) && !retained.has(revisionId)) { retained.add(revisionId); queue.push(revisionId); }
  };
  for (const revisionId of snapshots.keys()) if (!candidates.has(revisionId)) keep(revisionId);

  const branches = store.db.prepare('SELECT data FROM branches').all().map(row => JSON.parse(String(row.data)) as Branch);
  for (const branch of branches) {
    keep(branch.revisionId);
    // generationParent and legacy source-reference resolution use the original creation snapshot.
    let cursor: string | undefined = branch.revisionId; const seen = new Set<string>(); let first: Snapshot | undefined;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor); const snapshot = snapshots.get(cursor); if (!snapshot) break;
      if (snapshot.revision.branchId === branch.id) first = snapshot;
      cursor = snapshot.revision.parentId;
    }
    if (first) { keep(first.revision.id); keep(first.revision.parentId); }
    // Old data may derive the reference from task/branch ancestry instead of an explicit field.
    if (!branch.deletedAt && !snapshots.get(branch.revisionId)?.sourceRevisionId) keep(store.resolveSourceReference(branch.id)?.revisionId);
  }
  for (const row of store.db.prepare("SELECT id,json_extract(data,'$.baseRevisionId') AS base_revision_id,json_extract(data,'$.payload.baseRevisionId') AS original_revision_id,json_extract(data,'$.payload.sourceReference.revisionId') AS source_revision_id FROM jobs").iterate()) {
    if (!options.deleteJobIds?.has(String(row.id))) {
      for (const key of ['base_revision_id', 'original_revision_id', 'source_revision_id']) if (typeof row[key] === 'string') keep(row[key]);
    }
  }
  for (const row of store.db.prepare('SELECT id,stage,status,base_revision_id FROM model_outputs').iterate()) {
    if (row.stage === 'extraction' && row.status === 'applied' || !options.deleteOutputIds?.has(String(row.id))) keep(String(row.base_revision_id));
  }
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extraction_evidence'").get()) {
    for (const row of store.db.prepare("SELECT json_extract(data,'$.baseRevisionId') AS base_revision_id FROM extraction_evidence").iterate()) if (typeof row.base_revision_id === 'string') keep(row.base_revision_id);
  }
  for (const row of store.db.prepare("SELECT json_extract(data,'$.baseRevisionId') AS base_revision_id FROM image_assets").iterate()) if (typeof row.base_revision_id === 'string') keep(row.base_revision_id);

  // These historical parent/child comparisons are still used by compatibility readers.
  // Keep both original operands, rather than silently changing their meaning after relinking.
  const exactParent = new Set<string>();
  for (const snapshot of snapshots.values()) {
    // A rollback changes canon traversal. Removing the jump and relinking only the
    // audit parent would make later snapshots read the abandoned timeline again.
    if (snapshot.revision.restoredFromRevisionId) { keep(snapshot.revision.id); keep(snapshot.revision.restoredFromRevisionId); }
    if (snapshot.revision.label === '人工修改资料与锁定状态' || snapshot.legacyEditedChapter) {
      exactParent.add(snapshot.revision.id);
      keep(snapshot.revision.id); keep(snapshot.revision.parentId);
    }
  }
  const protectedJobs = new Set<string>(sourceJobs);
  while (queue.length) {
    const snapshot = snapshots.get(queue.pop()!)!;
    keep(snapshot.sourceRevisionId); keep(snapshot.revision.restoredFromRevisionId);
    if (snapshot.choiceJobId) protectedJobs.add(snapshot.choiceJobId);
    // Preserve the newest matching chapter-prefix snapshot on this version's canon path.
    // This includes the zero-chapter start needed to rewrite the first chapter.
    const counts = new Set<number>(Array.from({ length: snapshot.chapters.length }, (_, index) => index));
    let cursor = snapshot.revision.restoredFromRevisionId ?? snapshot.revision.parentId; const seen = new Set<string>();
    while (cursor && counts.size && !seen.has(cursor)) {
      seen.add(cursor); const ancestor = snapshots.get(cursor); if (!ancestor) break;
      const count = ancestor.chapters.length;
      if (counts.has(count) && ancestor.chapters.every((chapterId, index) => chapterId === snapshot.chapters[index])) { keep(cursor); counts.delete(count); }
      cursor = ancestor.revision.restoredFromRevisionId ?? ancestor.revision.parentId;
    }
  }
  // If a retained RPG choice rescues a task scheduled for deletion, its other revision
  // references must also survive. Let callers re-plan after protecting these jobs.
  plan.protectedJobIds = [...protectedJobs];
  for (const revisionId of candidates) if (!retained.has(revisionId)) plan.deleteIds.push(revisionId);
  plan.protectedCount = candidates.size - plan.deleteIds.length;
  const deleting = new Set(plan.deleteIds);
  for (const snapshot of snapshots.values()) {
    if (deleting.has(snapshot.revision.id) || exactParent.has(snapshot.revision.id)) continue;
    let parentId = snapshot.revision.parentId; const seen = new Set<string>();
    while (parentId && deleting.has(parentId) && !seen.has(parentId)) { seen.add(parentId); parentId = snapshots.get(parentId)?.revision.parentId; }
    if (parentId !== snapshot.revision.parentId) {
      const revision = { ...snapshot.revision, parentId }; if (!parentId) delete revision.parentId;
      plan.updates.push({ revision });
    }
  }
  return plan;
}

export function applyHistoryCleanup(store: Store, plan: HistoryCleanupPlan): void {
  const update = store.db.prepare('UPDATE revisions SET parent_id=?,data=? WHERE id=?');
  for (const { revision } of plan.updates) update.run(revision.parentId ?? null, JSON.stringify(revision), revision.id);
  const remove = store.db.prepare('DELETE FROM revisions WHERE id=?');
  for (const revisionId of plan.deleteIds) remove.run(revisionId);
}
