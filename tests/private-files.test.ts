import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { createDataTempDirectory, ensureDataDirectory, ensureDataFile, securePosixDataDirectory, writeDataFile } from '../server/private-files.js';

const fileSystem = vi.hoisted(() => ({ umask: 0o022, modes: new Map<string, number>(), contents: new Map<string, unknown>(), children: new Map<string, { name: string; kind: 'file' | 'directory' | 'link' }[]>(), chmod: vi.fn(), access: vi.fn(), scan: vi.fn(), write: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  lstatSync: (path: string) => ({ mode: fileSystem.modes.get(path), isSymbolicLink: () => false }),
  readdirSync: (path: string) => { fileSystem.scan(path); return (fileSystem.children.get(path) ?? []).map(entry => ({ name: entry.name, isDirectory: () => entry.kind === 'directory', isFile: () => entry.kind === 'file', isSymbolicLink: () => entry.kind === 'link' })); },
  chmodSync: (path: string, mode: number) => { fileSystem.chmod(path, mode); fileSystem.modes.set(path, mode); },
  accessSync: fileSystem.access,
  existsSync: (path: string) => fileSystem.modes.has(path),
  mkdirSync: (path: string, options: { mode?: number }) => {
    if (!fileSystem.modes.has(path)) fileSystem.modes.set(path, ((options.mode ?? 0o777) & ~fileSystem.umask) | ((fileSystem.modes.get(dirname(path)) ?? 0) & 0o2000));
  },
  mkdtempSync: (prefix: string) => { const path = prefix + 'fixture'; fileSystem.modes.set(path, 0o700); return path; },
  writeFileSync: (path: string, data: unknown, options: { mode?: number; flag: string }) => {
    if (fileSystem.modes.has(path) && options.flag === 'wx') throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
    fileSystem.write(path, data); fileSystem.contents.set(path, data); fileSystem.modes.set(path, (options.mode ?? 0o666) & ~fileSystem.umask);
  },
}));
beforeEach(() => { fileSystem.umask = 0o022; fileSystem.modes.clear(); fileSystem.contents.clear(); fileSystem.children.clear(); for (const mock of [fileSystem.chmod, fileSystem.access, fileSystem.scan, fileSystem.write]) mock.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe('POSIX permission decisions (simulated filesystem)', () => {
  it('starts with private readable data even when the account cannot change its permissions', () => {
    const root = '/private-data'; const file = join(root, 'fixture');
    fileSystem.modes.set(root, 0o700); fileSystem.modes.set(file, 0o600); fileSystem.children.set(root, [{ name: 'fixture', kind: 'file' }]);
    fileSystem.chmod.mockImplementation(() => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
    expect(() => securePosixDataDirectory(root)).not.toThrow();
    expect(fileSystem.chmod).not.toHaveBeenCalled(); expect(fileSystem.access).toHaveBeenCalledTimes(2);
  });
  it('preserves deliberately shared directories, files and ACL mask bits on repeated startup', () => {
    const root = '/private-data'; const safe = join(root, 'safe'), open = join(root, 'open'), nested = join(root, 'nested');
    fileSystem.modes.set(root, 0o777); fileSystem.modes.set(safe, 0o600); fileSystem.modes.set(open, 0o660); fileSystem.modes.set(nested, 0o2770);
    fileSystem.children.set(root, [{ name: 'safe', kind: 'file' }, { name: 'open', kind: 'file' }, { name: 'nested', kind: 'directory' }]);
    securePosixDataDirectory(root);
    securePosixDataDirectory(root);
    expect(fileSystem.chmod).not.toHaveBeenCalled();
    expect([root, safe, open, nested].map(path => fileSystem.modes.get(path))).toEqual([0o777, 0o600, 0o660, 0o2770]);
  });
  it('accepts usable shared data when the service is not allowed to chmod it', () => {
    fileSystem.modes.set('/private-data', 0o777);
    fileSystem.chmod.mockImplementation(() => { throw Object.assign(new Error('not the owner'), { code: 'EPERM' }); });
    expect(() => securePosixDataDirectory('/private-data')).not.toThrow();
    expect(fileSystem.chmod).not.toHaveBeenCalled(); expect(fileSystem.access).toHaveBeenCalled();
  });
  it('reports unreadable private data without trying to rewrite its already safe permissions', () => {
    fileSystem.modes.set('/private-data', 0o700); fileSystem.access.mockImplementation(() => { throw new Error('access denied'); });
    expect(() => securePosixDataDirectory('/private-data')).toThrow('无法读写'); expect(fileSystem.chmod).not.toHaveBeenCalled();
  });
  it('rejects links without changing any permissions', () => {
    fileSystem.modes.set('/private-data', 0o777); fileSystem.children.set('/private-data', [{ name: 'outside', kind: 'link' }]);
    expect(() => securePosixDataDirectory('/private-data')).toThrow('符号链接'); expect(fileSystem.chmod).not.toHaveBeenCalled();
  });
  it('reports directory scan failures with actionable context instead of a raw scandir stack', () => {
    fileSystem.modes.set('/private-data', 0o700);
    fileSystem.scan.mockImplementation(() => { throw Object.assign(new Error('scandir denied'), { code: 'EACCES' }); });
    expect(() => securePosixDataDirectory('/private-data')).toThrow('维护账号和服务账号');
    expect(fileSystem.chmod).not.toHaveBeenCalled();
  });
  it('leaves harmless owner-only execute permissions intact', () => {
    fileSystem.modes.set('/private-data', 0o700); fileSystem.modes.set(join('/private-data', 'fixture'), 0o700); fileSystem.children.set('/private-data', [{ name: 'fixture', kind: 'file' }]);
    securePosixDataDirectory('/private-data'); expect(fileSystem.chmod).not.toHaveBeenCalled();
  });
});

describe('data creation permissions (simulated POSIX filesystem)', () => {
  it.each([[0o022, 0o755, 0o644], [0o077, 0o700, 0o600], [0o002, 0o775, 0o664]])('uses ordinary creation defaults under umask %s', (umask, directoryMode, fileMode) => {
    fileSystem.umask = umask;
    ensureDataDirectory('/data'); ensureDataFile('/data/novel.sqlite');
    expect(fileSystem.modes.get('/data')).toBe(directoryMode);
    expect(fileSystem.modes.get('/data/novel.sqlite')).toBe(fileMode);
    expect(fileSystem.chmod).not.toHaveBeenCalled();
  });
  it.each([0o700, 0o770, 0o777, 0o2770])('does not expand new file write permissions to match parent mode %s', parentMode => {
    fileSystem.modes.set('/data', parentMode);
    ensureDataDirectory('/data/sources'); writeDataFile('/data/sources/source', 'original'); createDataTempDirectory('/data/delete-');
    expect(fileSystem.modes.get('/data')).toBe(parentMode);
    expect(fileSystem.modes.get('/data/sources')).toBe(0o755 | (parentMode & 0o2000));
    expect(fileSystem.modes.get('/data/delete-fixture')).toBe(0o700);
    expect(fileSystem.modes.get('/data/sources/source')).toBe(0o644);
    expect(fileSystem.contents.get('/data/sources/source')).toBe('original');
    expect(fileSystem.chmod).not.toHaveBeenCalled();
  });
  it('keeps an existing directory and database untouched when opening them', () => {
    fileSystem.modes.set('/data', 0o777); fileSystem.modes.set('/data/novel.sqlite', 0o666);
    fileSystem.contents.set('/data/novel.sqlite', 'existing database');
    ensureDataDirectory('/data'); ensureDataFile('/data/novel.sqlite');
    expect(fileSystem.chmod).not.toHaveBeenCalled(); expect(fileSystem.write).not.toHaveBeenCalled();
    expect(fileSystem.modes.get('/data')).toBe(0o777); expect(fileSystem.modes.get('/data/novel.sqlite')).toBe(0o666);
    expect(fileSystem.contents.get('/data/novel.sqlite')).toBe('existing database');
  });
  it('does not overwrite an existing original or encryption key', () => {
    fileSystem.modes.set('/data', 0o777); fileSystem.modes.set('/data/.encryption-key', 0o660);
    fileSystem.contents.set('/data/.encryption-key', 'original key');
    expect(() => writeDataFile('/data/.encryption-key', 'replacement')).toThrow('already exists');
    expect(fileSystem.chmod).not.toHaveBeenCalled(); expect(fileSystem.write).not.toHaveBeenCalled();
    expect(fileSystem.contents.get('/data/.encryption-key')).toBe('original key');
  });
});
