import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createPairingFile() {
  const directory = await mkdtemp(join(tmpdir(), 'figma-mcp-'));
  const path = join(directory, 'pairing-secret.txt');
  try {
    if (process.platform === 'win32') {
      const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!sid) throw new Error('Cannot determine current Windows user');
      execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { stdio: 'pipe', windowsHide: true });
    }
    const secret = randomBytes(32).toString('hex');
    await writeFile(path, secret, { mode: 0o600, flag: 'wx' });
    return { path, secret, async dispose() { await unlink(path); await rmdir(directory); } };
  } catch {
    await unlink(path).catch(() => {});
    await rmdir(directory).catch(() => {});
    throw new Error('PAIRING_FILE_UNAVAILABLE');
  }
}
