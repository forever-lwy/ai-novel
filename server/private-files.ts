import { chmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, parse, resolve } from 'node:path';

/** Private data stays readable by its owner and the running service account. */
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
$queue = [Collections.Generic.Queue[string]]::new()
$queue.Enqueue($target)
while ($queue.Count -gt 0) {
  $path = $queue.Dequeue()
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '数据目录不能包含链接。' }
  $acl = Get-Acl -LiteralPath $path
  $owner = if ($acl.Owner -match '^S-1-') { [Security.Principal.SecurityIdentifier]::new($acl.Owner) } else { ([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]) }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inherit = [Security.AccessControl.InheritanceFlags]::None
  if ($item.PSIsContainer) { $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
  foreach ($sid in @($owner, $current, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
  if ($item.PSIsContainer) { foreach ($child in Get-ChildItem -LiteralPath $path -Force) { $queue.Enqueue($child.FullName) } }
}
`;
    const powershellDir = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['psmodulepath', 'initial_password'].includes(name.toLowerCase())));
    try { execFileSync(join(powershellDir, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...childEnv, PSModulePath: join(powershellDir, 'Modules'), AI_NOVEL_PRIVATE_DIR: target }, windowsHide: true, stdio: 'pipe', timeout: 120_000 }); }
    catch (error) { throw new Error('无法收紧数据目录权限，请让运行账号保留该目录所有权及访问权限后重试。', { cause: error }); }
    return;
  }
  const directories = [target];
  while (directories.length) {
    const path = directories.pop()!; chmodSync(path, 0o700);
    for (const child of readdirSync(path, { withFileTypes: true })) {
      if (child.isSymbolicLink()) throw new Error('数据目录不能包含符号链接。');
      const childPath = join(path, child.name);
      if (child.isDirectory()) directories.push(childPath); else if (child.isFile()) chmodSync(childPath, 0o600);
    }
  }
}
