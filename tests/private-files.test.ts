import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { securePosixDataDirectory } from '../server/private-files.js';

const fileSystem = vi.hoisted(() => ({ modes: new Map<string, number>(), children: new Map<string, { name: string; kind: 'file' | 'directory' | 'link' }[]>(), chmod: vi.fn(), access: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  lstatSync: (path: string) => ({ mode: fileSystem.modes.get(path), isSymbolicLink: () => false }),
  readdirSync: (path: string) => (fileSystem.children.get(path) ?? []).map(entry => ({ name: entry.name, isDirectory: () => entry.kind === 'directory', isFile: () => entry.kind === 'file', isSymbolicLink: () => entry.kind === 'link' })),
  chmodSync: (path: string, mode: number) => { fileSystem.chmod(path, mode); fileSystem.modes.set(path, mode); },
  accessSync: fileSystem.access,
}));
beforeEach(() => { fileSystem.modes.clear(); fileSystem.children.clear(); fileSystem.chmod.mockReset(); fileSystem.access.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe('POSIX permission decisions (simulated filesystem)', () => {
  it('starts with private readable data even when the account cannot change its permissions', () => {
    const root = '/private-data'; const file = join(root, 'fixture');
    fileSystem.modes.set(root, 0o700); fileSystem.modes.set(file, 0o600); fileSystem.children.set(root, [{ name: 'fixture', kind: 'file' }]);
    fileSystem.chmod.mockImplementation(() => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
    expect(() => securePosixDataDirectory(root)).not.toThrow();
    expect(fileSystem.chmod).not.toHaveBeenCalled(); expect(fileSystem.access).toHaveBeenCalledTimes(2);
  });
  it('repairs only entries that expose data or lack needed owner access', () => {
    const root = '/private-data'; const safe = join(root, 'safe'), open = join(root, 'open'), nested = join(root, 'nested');
    fileSystem.modes.set(root, 0o700); fileSystem.modes.set(safe, 0o600); fileSystem.modes.set(open, 0o644); fileSystem.modes.set(nested, 0o500);
    fileSystem.children.set(root, [{ name: 'safe', kind: 'file' }, { name: 'open', kind: 'file' }, { name: 'nested', kind: 'directory' }]);
    securePosixDataDirectory(root);
    expect(fileSystem.chmod.mock.calls).toEqual([[open, 0o600], [nested, 0o700]]);
    fileSystem.chmod.mockClear(); securePosixDataDirectory(root); expect(fileSystem.chmod).not.toHaveBeenCalled();
  });
  it('does not silently accept unsafe data when chmod is denied', () => {
    fileSystem.modes.set('/private-data', 0o777);
    fileSystem.chmod.mockImplementation(() => { throw Object.assign(new Error('not the owner'), { code: 'EPERM' }); });
    expect(() => securePosixDataDirectory('/private-data')).toThrow('一次性修复');
    expect(fileSystem.access).not.toHaveBeenCalled();
  });
  it('reports unreadable private data without trying to rewrite its already safe permissions', () => {
    fileSystem.modes.set('/private-data', 0o700); fileSystem.access.mockImplementation(() => { throw new Error('access denied'); });
    expect(() => securePosixDataDirectory('/private-data')).toThrow('无法读写'); expect(fileSystem.chmod).not.toHaveBeenCalled();
  });
  it('preflights links before changing any permissions', () => {
    fileSystem.modes.set('/private-data', 0o777); fileSystem.children.set('/private-data', [{ name: 'outside', kind: 'link' }]);
    expect(() => securePosixDataDirectory('/private-data')).toThrow('符号链接'); expect(fileSystem.chmod).not.toHaveBeenCalled();
  });
  it('leaves harmless owner-only execute permissions intact', () => {
    fileSystem.modes.set('/private-data', 0o700); fileSystem.modes.set(join('/private-data', 'fixture'), 0o700); fileSystem.children.set('/private-data', [{ name: 'fixture', kind: 'file' }]);
    securePosixDataDirectory('/private-data'); expect(fileSystem.chmod).not.toHaveBeenCalled();
  });
});
