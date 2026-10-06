import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readBackupStates, RESTORE_MAX_DEPTH, RESTORE_MAX_REVISIONS, Store, validateBackupStructure } from '../server/store.js';
import { emptyState } from '../shared/types.js';

vi.mock('node:zlib', async importOriginal => {
  const original = await importOriginal<typeof import('node:zlib')>();
  return { ...original, gunzipSync: vi.fn(original.gunzipSync) };
});

const fixtures: { store: Store; directory: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, directory } of fixtures.splice(0)) {
    store.close();
    const path = resolve(directory);
    if (dirname(path) !== resolve(tmpdir()) || !path.includes('novel-store-security-')) throw new Error('Unexpected test cleanup path');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'novel-store-security-'));
  const store = new Store(directory); fixtures.push({ store, directory });
  const project = store.createProject({ title: '本地资料边界验证' });
  return { store, project, directory };
}

describe('bounded story search', () => {
  it.each(['字', '字词', '字词查询'])('restricts %s results in SQL and returns only short snippets', query => {
    const { store, project } = fixture();
    const own = store.state(project.mainBranchId);
    const first = store.putChapter('当前章节', `开头${query}${'正常正文'.repeat(100)}`); own.chapters.push(first);
    store.commit(project.mainBranchId, store.getBranch(project.mainBranchId).revisionId, own, '添加验证章节');
    store.putChapter('其他章节', `其他作品的${query}${'其他正文'.repeat(100)}`);
    const original = store.db.prepare.bind(store.db); const materialized: Record<string, unknown>[][] = [];
    vi.spyOn(store.db, 'prepare').mockImplementation(sql => {
      const statement = original(sql);
      if (sql.includes('AS snippet')) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
          const rows = all(...parameters); materialized.push(rows); return rows;
        });
      }
      return statement;
    });
    const result = store.search(project.mainBranchId, query, true);
    expect(result.chapters).toHaveLength(1); expect(result.chapters[0].id).toBe(first.id);
    expect(result.chapters[0].snippet).toContain(query); expect(result.chapters[0].snippet.length).toBeLessThanOrEqual(query.length + 140);
    expect(materialized).toHaveLength(1); expect(materialized[0]).toHaveLength(1);
    expect(materialized[0][0]).not.toHaveProperty('text');
  });

  it('limits matching chapter rows to sixty before sending them to JavaScript', () => {
    const { store, project } = fixture(); const state = store.state(project.mainBranchId);
    for (let index = 0; index < 65; index++) state.chapters.push(store.putChapter(`验证章节${index}`, '共同检索词，普通资料。'));
    store.commit(project.mainBranchId, store.getBranch(project.mainBranchId).revisionId, state, '添加普通查询样本');
    expect(store.search(project.mainBranchId, '共同检索词', true).chapters).toHaveLength(60);
  });

  it('keeps quoted phrases literal and handles a title-only match', () => {
    const { store, project } = fixture(); const state = store.state(project.mainBranchId);
    state.chapters.push(store.putChapter('他说"你好"', '普通正文。'));
    store.commit(project.mainBranchId, store.getBranch(project.mainBranchId).revisionId, state, '添加带引号的标题');
    expect(store.search(project.mainBranchId, '他说"你好"', true).chapters).toMatchObject([{ title: '他说"你好"', snippet: '普通正文。' }]);
    expect(() => store.search(project.mainBranchId, '关键词\0', true)).toThrow('空字符');
  });
});

describe('bounded backup expansion', () => {
  it('counts direct state objects and compressed snapshots in the same UTF-8 budget', () => {
    const state = emptyState(); state.outline.locked = '中文资料';
    const serialized = JSON.stringify(state); const bytes = Buffer.byteLength(serialized, 'utf8');
    const entries = [{ state }, { snapshot: gzipSync(serialized).toString('base64') }];
    expect(readBackupStates(entries, { maxStateBytes: bytes, maxExpandedStateBytes: bytes * 2 })).toEqual([state, state]);
    expect(() => readBackupStates(entries, { maxStateBytes: bytes, maxExpandedStateBytes: bytes * 2 - 1 })).toThrow('容量上限');
    expect(() => readBackupStates([{ state }], { maxStateBytes: bytes - 1 })).toThrow('容量上限');
    expect(() => readBackupStates([{ snapshot: entries[1].snapshot }], { maxStateBytes: bytes - 1 })).toThrow('容量上限');
  });

  it('checks depth, node count and array size with small local limits', () => {
    expect(() => validateBackupStructure({ outer: { inner: { text: '资料' } } }, { maxDepth: 2 })).toThrow('容量上限');
    expect(() => validateBackupStructure({ parts: [1, 2, 3] }, { maxNodes: 4 })).toThrow('容量上限');
    expect(() => validateBackupStructure({ parts: [1, 2, 3] }, { maxArrayLength: 2 })).toThrow('容量上限');
    const state = emptyState(); const nodes = validateBackupStructure(state);
    expect(() => readBackupStates([{ state }, { state }], { maxNodes: nodes * 2 - 1 })).toThrow('容量上限');
    expect(() => readBackupStates([{ state }, { state }], { maxRevisions: 1 })).toThrow('容量上限');
  });

  it('decompresses each snapshot once and keeps existing metadata and prose intact', () => {
    const { store, project } = fixture();
    store.saveChapter(project.mainBranchId, { baseRevisionId: store.getBranch(project.mainBranchId).revisionId, title: '普通章节', text: '作者已有的正文。' });
    const backup = store.exportProject(project.id) as { revisions: unknown[] };
    vi.mocked(gunzipSync).mockClear();
    const restored = store.restoreProject(backup);
    expect(gunzipSync).toHaveBeenCalledTimes(backup.revisions.length);
    expect(restored.id).not.toBe(project.id);
    expect(store.exportText(restored.mainBranchId)).toContain('作者已有的正文。');
    expect(store.getProject(project.id).title).toBe(project.title);
  });

  it('rejects oversized revision counts and overly nested data without persisting a project', () => {
    const { store, project } = fixture(); const backup = store.exportProject(project.id) as { revisions: unknown[]; extra?: unknown };
    const projects = store.listProjects();
    expect(() => store.restoreProject({ ...backup, revisions: Array.from({ length: RESTORE_MAX_REVISIONS + 1 }, () => backup.revisions[0]) })).toThrow('容量上限');
    let extra: unknown = '普通资料'; for (let depth = 0; depth <= RESTORE_MAX_DEPTH; depth++) extra = { nested: extra };
    expect(() => store.restoreProject({ ...backup, extra })).toThrow('容量上限');
    expect(store.listProjects()).toEqual(projects);
  });

  it('does not inherit source mappings from Object.prototype', () => {
    const { store, project } = fixture(); const state = store.state(project.mainBranchId);
    state.chapters.push(store.putChapter('来源标识验证', '普通正文。', 'constructor'));
    store.commit(project.mainBranchId, store.getBranch(project.mainBranchId).revisionId, state, '添加来源标识');
    const restored = store.restoreProject(store.exportProject(project.id));
    expect(store.state(restored.mainBranchId).chapters[0].sourceId).toBeUndefined();
    const ownMap = Object.create(null) as Record<string, string>; ownMap.constructor = 'restored-source';
    const withSource = store.restoreProject(store.exportProject(project.id), ownMap);
    expect(store.state(withSource.mainBranchId).chapters[0].sourceId).toBe('restored-source');
    expect(Object.prototype).not.toHaveProperty('restored-source');
  });
});

describe('POSIX database file permissions', () => {
  it.skipIf(process.platform === 'win32')('restricts the existing directory, database and journal files to the service account', () => {
    const { store, directory } = fixture(); store.close(); fixtures.pop();
    chmodSync(directory, 0o755); chmodSync(join(directory, 'novel.sqlite'), 0o644);
    const reopened = new Store(directory); fixtures.push({ store: reopened, directory });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const filename of ['novel.sqlite', 'novel.sqlite-wal', 'novel.sqlite-shm']) {
      const path = join(directory, filename); if (existsSync(path)) expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
});
