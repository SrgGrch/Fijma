import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
await build({ entryPoints: ['server/ipc.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'dist/test-support/ipc.mjs' });
const { acceptIPC, connectIPC, readFrame, ipcPath } = await import('../dist/test-support/ipc.mjs');
const dir = await mkdtemp(join(tmpdir(), 'figma-ipc-')), path = ipcPath(dir, 12345), secret = randomBytes(32).toString('hex');
const sockets = new Set();
let handler, transcript = '', accepted = 0;
const server = createServer(socket => {
  sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
  void handler(socket).catch(() => socket.destroy());
});
await new Promise(resolve => server.listen(path, resolve));
const raw = async () => { const s = createConnection(path); s.on('error', () => {}); await once(s, 'connect'); return s; };
const hello = nonce => ({ version: 1, nonce, action: 'connect' });
const sign = (client, challenge) => createHmac('sha256', secret).update(JSON.stringify(['figma-mcp-ipc', 1, 'client', client, challenge, 'connect'])).digest('hex');
try {
  handler = async socket => {
    socket.on('data', data => transcript += data.toString());
    await acceptIPC(socket, secret); accepted++;
    socket.write('{"jsonrpc":"2.0","method":"test"}\n');
  };
  const good = await connectIPC(path, secret);
  assert.equal(good.pid, process.pid);
  assert.equal((await readFrame(good.socket)).method, 'test', 'MCP bytes coalesced with ready must survive'); good.socket.destroy();
  await assert.rejects(connectIPC(path, '0'.repeat(64)), /IPC_AUTH_FAILED/);
  assert.equal(accepted, 1);
  assert.ok(!transcript.includes(secret), 'secret never traverses IPC');
  const clientNonce = randomBytes(32).toString('hex');
  let socket = await raw(); socket.write(JSON.stringify(hello(clientNonce)) + '\n');
  const challenge = await readFrame(socket);
  const oldProof = sign(clientNonce, challenge.nonce);
  socket.destroy();
  socket = await raw(); socket.write(JSON.stringify(hello(clientNonce)) + '\n');
  const newChallenge = await readFrame(socket); assert.notEqual(challenge.nonce, newChallenge.nonce);
  const replayClosed = once(socket, 'close'); socket.write(JSON.stringify({ proof: oldProof }) + '\n'); socket.resume(); await replayClosed;
  assert.equal(accepted, 1);
  socket = await raw(); const oversizedClosed = once(socket, 'close'); socket.write('x'.repeat(1025)); socket.resume(); await oversizedClosed;
  socket = await raw(); const timedOut = once(socket, 'close'); socket.resume(); await timedOut;
  handler = async socket => { await readFrame(socket); socket.end(JSON.stringify({ version: 2 }) + '\n'); };
  await assert.rejects(connectIPC(path, secret), /IPC_VERSION_MISMATCH/);
  handler = async socket => { await readFrame(socket); socket.end(JSON.stringify({ version: 1, nonce: '0'.repeat(64), proof: '0'.repeat(64) }) + '\n'); };
  await assert.rejects(connectIPC(path, secret), /IPC_AUTH_FAILED/);
  console.log('IPC: mutual auth, replay, fake endpoint, version, frame/time limits, secret privacy and coalesced MCP bytes OK');
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve)); await rmdir(dir);
}
