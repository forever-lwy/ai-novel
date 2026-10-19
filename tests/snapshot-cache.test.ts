import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store';

const fixtures: { store: Store; path: string }[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const { store, path } of fixtures.splice(0)) { store.close(); rmSync(path, { recursive: true, force: true }); } });
function fixture() { const path = mkdtempSync(join(tmpdir(), 'novel-snapshot-cache-')); const store = new Store(path); fixtures.push({ store, path }); return store; }

describe('repeated story snapshot reads', () => {
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
