import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const directory = await mkdtemp(join(tmpdir(), 'figma-execution-owner-'));
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const env = { ...process.env, FIGMA_MCP_PORT: String(port), FIGMA_MCP_PAIRING_DIR: directory };
const clients = [], sockets = [];
let daemonPid;
const limits = { maxMessageBytes: 65536, maxBatchSteps: 100, maxQueuedOperations: 10, maxDepth: 10, maxNodes: 100, maxResponseBytes: 32768, maxImportBytes: 65536, maxExportPixels: 100000, maxExportBytes: 262144, operationTimeout: 5000, dedupTtl: 60000, maxJournalEntries: 100, resourceTtl: 60000, clockSkew: 1000 };
const start = async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/server/index.js'], env, stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', data => stderr += data);
  const client = new Client({ name: 'execution-ownership', version: '1' }); clients.push(client);
  await client.connect(transport); const pid = Number(stderr.match(/Общий мост: PID (\d+)/)?.[1]);
  assert.ok(pid); daemonPid = pid; return client;
};
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const pair = async (secret, sessionId) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(socket); await once(socket, 'open');
  let reply = once(socket, 'message'); socket.send(JSON.stringify({ type: 'pair', secret })); await reply;
  reply = once(socket, 'message'); const closed = once(socket, 'close');
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, sessionId, capabilities: ['getContext', 'execute', 'getOperation', 'cancel'], limits, writeEnabled: false }));
  const outcome = await Promise.race([reply.then(([data]) => ({ welcome: JSON.parse(data.toString()) })), closed.then(([, reason]) => ({ reason: reason.toString() }))]);
  return { socket, ...outcome };
};
const contextReply = (socket, sessionId, generation) => socket.on('message', raw => {
  const request = JSON.parse(raw.toString());
  if (request.type === 'getContext') socket.send(JSON.stringify({ type: 'context', requestId: request.requestId, sessionId, connectionGeneration: generation, document: { documentLabel: 'fixture', currentPageId: 'p', pages: [{ id: 'p', name: 'Page' }], selection: [] } }));
});
try {
  const owner = await start(), other = await start();
  const secret = await readFile(join(directory, 'pairing-secret.txt'), 'utf8');
  const first = await pair(secret, 'execution-session-a'); assert.ok(first.welcome);
  contextReply(first.socket, 'execution-session-a', first.welcome.connectionGeneration);
  const context = (await call(owner, 'figma_get_context')).structuredContent;
  const scope = { sessionId: context.sessionId, connectionGeneration: context.connectionGeneration };
  let resume, lateWrite = 0;
  const waiting = new Promise(resolve => { resume = resolve; });
  let simulatedExecution;
  const commandReceived = new Promise(resolve => first.socket.on('message', raw => { const msg = JSON.parse(raw.toString()); if (msg.command === 'execute') {
    simulatedExecution = (async () => { await waiting; lateWrite++; })(); resolve(msg);
  } }));
  const pending = call(owner, 'figma_execute', { scope, operationId: '019a4a10-0000-7000-8000-000000000001', language: 'javascript', code: 'await wait; figma.lateWrite();' }).catch(() => {});
  await commandReceived;
  await owner.close(); await pending; await delay(100);
  assert.equal((await call(other, 'figma_get_context')).structuredContent.error.code, 'SESSION_BUSY');
  resume(); await simulatedExecution; assert.equal(lateWrite, 1);
  const same = await pair(secret, 'execution-session-a'); assert.equal(same.reason, 'SESSION_BUSY');
  assert.equal((await call(other, 'figma_get_context')).structuredContent.error.code, 'SESSION_BUSY');
  const replacement = await pair(secret, 'execution-session-b'); assert.ok(replacement.welcome);
  contextReply(replacement.socket, 'execution-session-b', replacement.welcome.connectionGeneration);
  const recovered = (await call(other, 'figma_get_context')).structuredContent;
  assert.equal(recovered.sessionId, 'execution-session-b');
} finally {
  for (const socket of sockets) socket.terminate();
  for (const client of clients) await client.close().catch(() => {});
  const stop = spawn(process.execPath, ['dist/server/index.js', '--stop-bridge'], { env, windowsHide: true, stdio: 'ignore' });
  const [code] = await once(stop, 'exit'); if (code !== 0 && daemonPid) try { process.kill(daemonPid, 'SIGKILL'); } catch {}
  await rm(directory, { recursive: true, force: true });
}
