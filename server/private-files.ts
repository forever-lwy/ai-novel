import { accessSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, unlinkSync, writeFileSync, type Dirent } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, parse, resolve } from 'node:path';

/** Use ordinary filesystem creation rules and leave existing permissions untouched. */
export function ensureDataDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
}

export function writeDataFile(path: string, data: string | NodeJS.ArrayBufferView): void {
  writeFileSync(path, data, { flag: 'wx' });
}

export function ensureDataFile(path: string): void {
  try { writeDataFile(path, ''); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export function createDataTempDirectory(prefix: string): string {
  return mkdtempSync(prefix);
}

function accessError(path: string, cause: unknown): Error {
  return new Error('当前运行账号无法读写数据目录或文件：' + path + '。请检查挂载路径，并同时保留维护账号和服务账号的访问授权；应用不会自动修改已有所有者、权限或 ACL。', { cause });
}

/** Windows accessSync does not check ACLs; verify actual opens and directory writes instead. */
function verifyWindowsAccess(path: string, directory: boolean): void {
  if (!directory) { closeSync(openSync(path, 'r+')); return; }
  const probe = join(path, '.ai-novel-access-' + randomUUID());
  const descriptor = openSync(probe, 'wx');
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
