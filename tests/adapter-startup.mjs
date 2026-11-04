import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { ipcPath, readFrame } from '../dist/test-support/ipc.mjs';
await build({ entryPoints: ['server/adapter.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'dist/test-support/adapter.mjs' });
const { runAdapter } = await import('../dist/test-support/adapter.mjs');
const originalSpawn = childProcess.spawn;
const directory = await mkdtemp(join(tmpdir(), 'figma-start-')), path = ipcPath(directory, 12345);
let spawned = 0, unref = 0, server;
try {
  childProcess.spawn = (command, args, options) => {
    spawned++; assert.equal(command, process.execPath); assert.equal(args[1], '--bridge');
    assert.deepEqual(options, { detached: true, windowsHide: true, stdio: 'ignore' });
    const child = new EventEmitter(); child.unref = () => unref++;
    queueMicrotask(() => child.emit('error', new Error('spawn unavailable'))); return child;
  };
  syncBuiltinESMExports();
  await assert.rejects(runAdapter(path, 'a'.repeat(64)), /BRIDGE_SPAWN_FAILED/);
  assert.equal(spawned, 1); assert.equal(unref, 1);
  let reply = { version: 2 };
  server = createServer(socket => {
    socket.on('error', () => {});
    void readFrame(socket).then(() => socket.end(JSON.stringify(reply) + '\n')).catch(() => socket.destroy());
  });
  await new Promise(resolve => server.listen(path, resolve));
  await assert.rejects(runAdapter(path, 'a'.repeat(64)), /IPC_VERSION_MISMATCH/);
  reply = { version: 1, nonce: '0'.repeat(64), proof: '0'.repeat(64) };
  await assert.rejects(runAdapter(path, 'a'.repeat(64)), /IPC_AUTH_FAILED/);
  assert.equal(spawned, 1, 'version/auth failures must not spawn extra processes');
  console.log('Adapter startup: spawn error, hidden detached launch and no spawn after auth/version refusal OK');
} finally {
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  if (server) await new Promise(resolve => server.close(resolve));
  await rmdir(directory);
}
