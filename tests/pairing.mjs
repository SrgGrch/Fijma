import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
await build({ entryPoints: ['server/pairing-file.ts', 'server/pairing-listener.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', outdir: 'dist/test-support', outExtension: { '.js': '.mjs' } });
const { createPairingFile } = await import('../dist/test-support/pairing-file.mjs');
const { createPairingListener } = await import('../dist/test-support/pairing-listener.mjs');
const file = await createPairingFile();
let listener;
const clients = [];
try {
  assert.equal(await readFile(file.path, 'utf8'), file.secret);
  if (process.platform === 'win32') {
    const acl = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$acl = [System.IO.Directory]::GetAccessControl($env:FIGMA_TEST_ACL_PATH); $rules = $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); @{protected=$acl.AreAccessRulesProtected; identities=@($rules | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, FIGMA_TEST_ACL_PATH: dirname(file.path) } }));
    assert.equal(acl.protected, true);
    assert.equal(acl.identities.length, 1);
  } else assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  listener = await createPairingListener(file.secret, 0);
  assert.equal(listener.address.address, '127.0.0.1');
  const url = `ws://127.0.0.1:${listener.address.port}`;
  const connect = async options => {
    const socket = new WebSocket(url, options); clients.push(socket);
    await once(socket, 'open'); return socket;
  };
  const invalid = await connect();
  const rejected = once(invalid, 'close');
  invalid.send(JSON.stringify({ type: 'pair', secret: '0'.repeat(64) }));
  assert.equal((await rejected)[1].toString(), 'AUTH_FAILED');
  const active = await connect({ origin: 'null' });
  const paired = once(active, 'message');
  active.send(JSON.stringify({ type: 'pair', secret: file.secret }));
  assert.equal(JSON.parse((await paired)[0].toString()).type, 'paired');
  const limits = Object.fromEntries(['maxMessageBytes', 'maxBatchSteps', 'maxQueuedOperations', 'maxDepth', 'maxNodes', 'maxResponseBytes', 'maxImportBytes', 'maxExportPixels', 'maxExportBytes', 'operationTimeout', 'dedupTtl', 'maxJournalEntries', 'resourceTtl', 'clockSkew'].map(key => [key, 10]));
  const welcome = once(active, 'message');
  active.send(JSON.stringify({ type: 'hello', protocolVersion: 1, sessionId: 'first', capabilities: ['getContext', 'getTree'], limits, writeEnabled: false }));
  const firstGeneration = JSON.parse((await welcome)[0].toString()).connectionGeneration;
  assert.ok(Number.isSafeInteger(firstGeneration) && firstGeneration > 0);
  assert.equal(listener.getBinding().sessionId, 'first');
  const requestMessage = once(active, 'message');
  const contextPromise = listener.getContext();
  const request = JSON.parse((await requestMessage)[0].toString());
  active.send(JSON.stringify({ type: 'context', requestId: request.requestId, sessionId: 'first', connectionGeneration: firstGeneration,
    document: { documentLabel: 'Test', currentPageId: '0:1', pages: [{ id: '0:1', name: 'Page' }], selection: [] } }));
  const context = await contextPromise;
  assert.equal(context.state, 'ready');
  assert.equal(context.documentLabel, 'Test');
  assert.equal(context.writeEnabled, false);
  const treeRequestMessage = once(active, 'message');
  const treePromise = listener.getTree({ scope: { sessionId: 'first', connectionGeneration: firstGeneration }, rootId: '0:1', depth: 1, limit: 10 });
  const treeRequest = JSON.parse((await treeRequestMessage)[0].toString());
  assert.match(treeRequest.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  active.send(JSON.stringify({ type: 'treeResult', sessionId: 'first', connectionGeneration: firstGeneration, operationId: treeRequest.operationId,
    data: { nodes: [{ nodeId: '0:1', name: 'Page', type: 'PAGE', depth: 0 }], truncated: false } }));
  assert.equal((await treePromise).nodes[0].nodeId, '0:1');
  await assert.rejects(listener.getTree({ scope: { sessionId: 'another', connectionGeneration: firstGeneration }, rootId: '0:1', depth: 1, limit: 10 }), /SESSION_EXPIRED/);
  const second = await connect();
  const busy = once(second, 'close');
  second.send(JSON.stringify({ type: 'pair', secret: file.secret }));
  assert.equal((await busy)[1].toString(), 'SESSION_BUSY');
  assert.equal(active.readyState, WebSocket.OPEN);
  const foreign = new WebSocket(url, { origin: 'https://example.com' }); clients.push(foreign);
  await once(foreign, 'error');
  const closed = once(active, 'close'); active.close(); await closed;
  const restored = await connect();
  const pairAgain = once(restored, 'message'); restored.send(JSON.stringify({ type: 'pair', secret: file.secret })); await pairAgain;
  const secondWelcome = once(restored, 'message');
  restored.send(JSON.stringify({ type: 'hello', protocolVersion: 1, sessionId: 'first', capabilities: [], limits, writeEnabled: false }));
  assert.equal(JSON.parse((await secondWelcome)[0].toString()).connectionGeneration, firstGeneration + 1);
  const pending = [];
  for (let i = 0; i < 4; i++) pending.push(await connect());
  const overflow = new WebSocket(url); clients.push(overflow);
  await once(overflow, 'error');
  for (const socket of pending) { const done = once(socket, 'close'); socket.close(); await done; }
  const oversized = await connect();
  const sizeRejected = once(oversized, 'close');
  oversized.send('x'.repeat(1025));
  await sizeRejected;
  const idle = await connect();
  await once(idle, 'close');
  assert.equal(restored.readyState, WebSocket.OPEN);
  console.log('Сопряжение: права файла, loopback, неверный секрет, Origin и второй плагин — OK');
} finally {
  for (const client of clients) client.terminate();
  await listener?.close();
  await file.dispose();
}
await assert.rejects(readFile(file.path));
