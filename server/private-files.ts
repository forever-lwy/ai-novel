import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, parse, resolve } from 'node:path';

/** Check existing permissions; only repair entries that are not private and usable. */
export function secureDataDirectory(directory: string) {
  const target = resolve(directory);
  if (target === parse(target).root) throw new Error('DATA_DIR 不能是文件系统根目录。');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (lstatSync(target).isSymbolicLink()) throw new Error('数据目录不能使用符号链接，请使用独立本地目录。');
  if (process.platform === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$target = [IO.Path]::GetFullPath($env:AI_NOVEL_PRIVATE_DIR)
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$sections = [Security.AccessControl.AccessControlSections]'Owner,Access'
$rootAcl = [IO.Directory]::GetAccessControl($target, $sections)
$rootOwner = $rootAcl.GetOwner([Security.Principal.SecurityIdentifier])
$stage = 'check'
try {
$queue = [Collections.Generic.Queue[string]]::new()
$queue.Enqueue($target)
$items = [Collections.Generic.List[object]]::new()
while ($queue.Count -gt 0) {
  $path = $queue.Dequeue()
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '数据目录不能包含链接。' }
  $items.Add($item)
  if ($item.PSIsContainer) { foreach ($child in Get-ChildItem -LiteralPath $path -Force) { $queue.Enqueue($child.FullName) } }
}
foreach ($item in $items) {
  $path = $item.FullName
  $existing = if ($item.PSIsContainer) { [IO.Directory]::GetAccessControl($path, $sections) } else { [IO.File]::GetAccessControl($path, $sections) }
  $owner = $existing.GetOwner([Security.Principal.SecurityIdentifier])
  $allowed = @($owner.Value, $rootOwner.Value, $current.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4')
  $private = $true
  $granted = 0
  $denied = 0
  $required = [int]([Security.AccessControl.FileSystemRights]'Read,Write,Delete,Synchronize')
  if ($item.PSIsContainer) { $required = [int]([Security.AccessControl.FileSystemRights]'Modify,Synchronize') }
  foreach ($rule in $existing.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    $rights = [int]$rule.FileSystemRights
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rights -ne 0 -and $allowed -notcontains $sid) { $private = $false }
    $applies = $sid -eq $current.Value -or ($sid -eq 'S-1-3-4' -and $owner.Value -eq $current.Value) -or $principal.IsInRole($rule.IdentityReference)
    if ($applies -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) {
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) { $granted = $granted -bor $rights } else { $denied = $denied -bor $rights }
    }
  }
  if ($private -and ($granted -band $required) -eq $required -and ($denied -band $required) -eq 0) { continue }
  $stage = 'repair'
  # A fresh descriptor only marks Access as modified; owner and audit stay untouched.
  $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]::None
  if ($item.PSIsContainer) { $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
  foreach ($sid in @($owner, $rootOwner, $current, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
  }
  if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($path, $acl) } else { [IO.File]::SetAccessControl($path, $acl) }
  $stage = 'check'
}
@{ ok = $true } | ConvertTo-Json -Compress
} catch { @{ ok = $false; stage = $stage; linked = $_.Exception.Message -eq '数据目录不能包含链接。' } | ConvertTo-Json -Compress }
`;
    const powershellDir = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['psmodulepath', 'initial_password'].includes(name.toLowerCase())));
    let result: { ok: boolean; stage?: string; linked?: boolean };
    try { result = JSON.parse(execFileSync(join(powershellDir, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...childEnv, PSModulePath: join(powershellDir, 'Modules'), AI_NOVEL_PRIVATE_DIR: target }, windowsHide: true, encoding: 'utf8', timeout: 120_000 })); }
    catch (error) { throw new Error('无法检查数据目录访问权限，请确认运行账号能读取该目录的访问规则。', { cause: error }); }
    if (!result.ok) {
      if (result.linked) throw new Error('数据目录不能包含链接。');
      if (result.stage === 'repair') throw new Error('数据目录权限不合规，当前账号无权收紧访问规则（WRITE_DAC）。请由有权限的管理员一次性修复访问规则，保留原所有者；或停机复制完整数据到当前账号拥有的私有目录，再设置 DATA_DIR。日常运行不需要管理员权限。');
      throw new Error('无法检查数据目录访问权限，请确认运行账号能读取数据及其访问规则。');
    }
    return;
  }
  securePosixDataDirectory(target);
}

/** Separate from Windows ACL handling so POSIX decisions can be verified on either host. */
export function securePosixDataDirectory(target: string) {
  if (lstatSync(target).isSymbolicLink()) throw new Error('数据目录不能使用符号链接，请使用独立本地目录。');
  const directories = [target];
  const entries: { path: string; directory: boolean }[] = [];
  while (directories.length) {
    const path = directories.pop()!;
    entries.push({ path, directory: true });
    for (const child of readdirSync(path, { withFileTypes: true })) {
      if (child.isSymbolicLink()) throw new Error('数据目录不能包含符号链接。');
      const childPath = join(path, child.name);
      if (child.isDirectory()) directories.push(childPath); else if (child.isFile()) entries.push({ path: childPath, directory: false });
    }
  }
  for (const entry of entries) {
    const mode = entry.directory ? 0o700 : 0o600;
    try {
      const existing = lstatSync(entry.path).mode & 0o777;
      if ((existing & 0o077) !== 0 || (existing & mode) !== mode) chmodSync(entry.path, mode);
      accessSync(entry.path, constants.R_OK | constants.W_OK | (entry.directory ? constants.X_OK : 0));
    } catch (error) {
      throw new Error('数据目录或文件权限不合规，或当前运行账号无法读写。请一次性修复该数据目录的权限或账号归属，保留完整数据；也可停机复制到运行账号拥有的私有目录并设置 DATA_DIR。日常运行不需要 root。', { cause: error });
    }
  }
}
