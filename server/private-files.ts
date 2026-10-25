import { accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, unlinkSync, writeFileSync, type Dirent } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, parse, resolve } from 'node:path';

/** New data follows its containing directory's sharing policy; existing grants stay untouched. */
function creationMode(parent: string, directory: boolean): number {
  const inherited = lstatSync(parent).mode;
  return directory ? 0o700 | (inherited & 0o2077) : 0o600 | (inherited & 0o066);
}

export function ensureDataDirectory(directory: string, parent?: string): void {
  const existed = existsSync(directory);
  const mode = process.platform === 'win32' || !parent ? 0o700 : creationMode(parent, true);
  mkdirSync(directory, { recursive: true, mode });
  // Apply sharing bits after umask, only to a directory we just created.
  if (!existed && process.platform !== 'win32') chmodSync(directory, mode | (lstatSync(directory).mode & 0o2000));
}

export function writeDataFile(path: string, data: string | NodeJS.ArrayBufferView): void {
  const mode = process.platform === 'win32' ? 0o600 : creationMode(dirname(path), false);
  writeFileSync(path, data, { flag: 'wx', mode });
  // Explicit group/ACL sharing must survive a more restrictive process umask.
  if (process.platform !== 'win32') chmodSync(path, mode);
}

export function ensureDataFile(path: string): void {
  try { writeDataFile(path, ''); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export function createDataTempDirectory(prefix: string): string {
  const directory = mkdtempSync(prefix);
  if (process.platform !== 'win32') chmodSync(directory, creationMode(dirname(directory), true));
  return directory;
}

function accessError(path: string, cause: unknown): Error {
  return new Error('当前运行账号无法读写数据目录或文件：' + path + '。请检查挂载路径，并同时保留维护账号和服务账号的访问授权；应用不会自动修改已有所有者、权限或 ACL。', { cause });
}

/** Windows accessSync does not check ACLs; verify actual opens and directory writes instead. */
function verifyWindowsAccess(path: string, directory: boolean): void {
  if (!directory) { closeSync(openSync(path, 'r+')); return; }
  const probe = join(path, '.ai-novel-access-' + randomUUID());
  const descriptor = openSync(probe, 'wx', 0o600);
  try { closeSync(descriptor); } finally { unlinkSync(probe); }
}

function checkDataAccess(target: string, windows: boolean): void {
  if (lstatSync(target).isSymbolicLink()) throw new Error('数据目录不能使用符号链接，请使用独立本地目录。');
  const directories = [target];
  const entries: { path: string; directory: boolean }[] = [];
  while (directories.length) {
    const path = directories.pop()!;
    entries.push({ path, directory: true });
    let children: Dirent[];
    try {
      accessSync(path, constants.R_OK | constants.W_OK | (windows ? 0 : constants.X_OK));
      children = readdirSync(path, { withFileTypes: true });
    } catch (error) { throw accessError(path, error); }
    for (const child of children) {
      if (child.isSymbolicLink()) throw new Error('数据目录不能包含符号链接。');
      const childPath = join(path, child.name);
      if (child.isDirectory()) directories.push(childPath); else if (child.isFile()) entries.push({ path: childPath, directory: false });
    }
  }
  for (const entry of entries) {
    try {
      if (windows) verifyWindowsAccess(entry.path, entry.directory);
      else if (!entry.directory) accessSync(entry.path, constants.R_OK | constants.W_OK);
    } catch (error) { throw accessError(entry.path, error); }
  }
}

/** Check actual access, preserving the owner's modes, ACLs and inherited grants. */
export function secureDataDirectory(directory: string): void {
  const target = resolve(directory);
  if (target === parse(target).root) throw new Error('DATA_DIR 不能是文件系统根目录。');
  ensureDataDirectory(target);
  checkDataAccess(target, process.platform === 'win32');
}

/** Separate entry point keeps POSIX access decisions testable on Windows. */
export function securePosixDataDirectory(target: string): void {
  checkDataAccess(target, false);
}
