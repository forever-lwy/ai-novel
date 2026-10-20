import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store';

const fixtures: { store: Store; path: string }[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const { store, path } of fixtures.splice(0)) { store.close(); rmSync(path, { recursive: true, force: true }); } });
function fixture() { const path = mkdtempSync(join(tmpdir(), 'novel-snapshot-cache-')); const store = new Store(path); fixtures.push({ store, path }); return store; }

describe('repeated story snapshot reads', () => {
  it('validates browser snapshots across reads, in-place writes, external writes and restarts', () => {
    const store = fixture(); const project = store.createProject({ title: '浏览器版本校验' });
    const version = store.cacheVersion();
    store.view(project.mainBranchId, true);
    expect(store.cacheVersion()).toBe(version);
    // A branch revision ID alone cannot detect updates to an existing snapshot.
    store.db.prepare('UPDATE revisions SET state=state WHERE id=?').run(store.getBranch(project.mainBranchId).revisionId);
    const inPlace = store.cacheVersion(); expect(inPlace).not.toBe(version);
    const external = new DatabaseSync(join(fixtures.at(-1)!.path, 'novel.sqlite'));
    try { external.prepare("UPDATE revisions SET data=json_set(data,'$.label',?) WHERE id=?").run('外部修订标签', store.getBranch(project.mainBranchId).revisionId); } finally { external.close(); }
    expect(store.cacheVersion()).not.toBe(inPlace);
    const reopened = new Store(fixtures.at(-1)!.path);
    try { expect(reopened.cacheVersion()).not.toBe(store.cacheVersion()); } finally { reopened.close(); }
  });
  it('reuses ordinary snapshots without rescanning all extraction outputs and returns independent copies', () => {
    const store = fixture(); const project = store.createProject({ title: '快照复用' });
    const prepare = vi.spyOn(store.db, 'prepare');
    const first = store.state(project.mainBranchId); first.outline.locked = 'client mutation';
    expect(store.state(project.mainBranchId).outline.locked).toBe('');
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("stage='extraction'"))).toHaveLength(1);
  });

  it('invalidates cached author and reader state after a local write', () => {
    const store = fixture(); const project = store.createProject({ title: '快照更新' });
    const old = store.getBranch(project.mainBranchId).revisionId;
    store.view(project.mainBranchId, true); store.view(project.mainBranchId, false);
    store.updateOutline(project.mainBranchId, old, { worldview: '新的世界观', locked: '新的锁定设定', fine: [] });
    expect(store.view(project.mainBranchId, true).state.outline.locked).toBe('新的锁定设定');
    expect(store.view(project.mainBranchId, false).state.outline.locked).toBe('');
    expect(store.state(project.mainBranchId).outline.worldview).toBe('新的世界观');
  });
});
