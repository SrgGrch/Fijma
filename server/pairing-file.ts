import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, chmod, lstat, unlink, rmdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function protect(path: string, directory: boolean) {
  if (process.platform !== 'win32') { await chmod(path, directory ? 0o700 : 0o600); return; }
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [System.Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', '${directory ? 'ContainerInherit, ObjectInherit' : 'None'}', 'None', 'Allow')
    $acl.SetAccessRule($rule)
    [System.IO.${directory ? 'Directory' : 'File'}]::SetAccessControl($env:FIGMA_PAIRING_ACL_PATH, $acl)
  `], { env: { ...process.env, FIGMA_PAIRING_ACL_PATH: path }, stdio: 'pipe', windowsHide: true });
}

// A directory opts production into a persistent key; probes keep disposable keys.
export async function createPairingFile(savedDirectory?: string) {
  const directory = savedDirectory ?? await mkdtemp(join(tmpdir(), 'figma-mcp-'));
  const path = join(directory, 'pairing-secret.txt');
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid pairing directory');
    await protect(directory, true);
    try { await writeFile(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (!savedDirectory || (error as { code?: string }).code !== 'EEXIST') throw error; }
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.size !== 64) throw new Error('Invalid pairing file');
    await protect(path, false);
    const secret = await readFile(path, 'utf8');
    if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('Invalid pairing key');
    return { path, secret, async dispose() { if (!savedDirectory) { await unlink(path); await rmdir(directory); } } };
  } catch {
    if (!savedDirectory) { await unlink(path).catch(() => {}); await rmdir(directory).catch(() => {}); }
    throw new Error('PAIRING_FILE_UNAVAILABLE');
  }
}
