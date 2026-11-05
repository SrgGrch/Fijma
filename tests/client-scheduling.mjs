import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/client';
await build({ entryPoints: ['server/runtime.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'dist/test-support/client-scheduling.mjs' });
const { createBridge } = await import('../dist/test-support/client-scheduling.mjs');
const secret = 'a'.repeat(64);
const bridge = await createBridge({ secret, path: 'test-only', async dispose() {} }, 0);
const clients = [];
async function client() {
  const lifetime = new AbortController();
  const server = bridge.createClientServer(undefined, lifetime.signal);
  const transport = () => ({ async start() {}, async send(message) { queueMicrotask(() => this.peer.onmessage?.(message)); }, async close() { this.onclose?.(); this.peer.onclose?.(); } });
  const a = transport(), b = transport(); a.peer = b; b.peer = a;
  const sdk = new Client({ name: 'scheduler-test', version: '1' });
  await server.connect(a); await sdk.connect(b);
  const entry = { sdk, server, lifetime, call: async (name, args = {}) => (await sdk.callTool({ name, arguments: args })).structuredContent };
  clients.push(entry); return entry;
}
const socket = new WebSocket(`ws://127.0.0.1:${bridge.listener.address.port}`);
let scope;
const commands = [];
const results = new Map();
const reply = (request, status = 'succeeded') => {
  const kind = request.command === 'execute' ? 'execute' : results.get(request.operationId)?.kind;
  const data = { ...scope, operationId: request.operationId, status, warnings: [],
    ...(kind === 'execute' ? { kind, effects: 'unknown', logs: [], logsTruncated: false } : { steps: [], affectedNodeIds: [], affectedResourceIds: [] }) };
  results.set(request.operationId, data);
  socket.send(JSON.stringify({ type: 'operationResult', ...scope, requestId: request.requestId, operationId: request.operationId, data }));
};
async function commandCount(n) {
  for (let i = 0; i < 200 && commands.length < n; i++) await delay(5);
  assert.equal(commands.length, n);
}
let suffix = 0;
const args = kind => {
  const stamp = Date.now().toString(16).padStart(12, '0');
  return { scope, operationId: `${stamp.slice(0, 8)}-${stamp.slice(8)}-7000-8000-${String(++suffix).padStart(12, '0')}`,
    ...(kind === 'execute' ? { language: 'javascript', code: 'return 1;' } : { steps: [{ stepId: 'p', op: 'createPage', name: 'Test' }] }) };
};
try {
  await once(socket, 'open');
  let response = once(socket, 'message'); socket.send(JSON.stringify({ type: 'pair', secret })); await response;
  response = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, sessionId: 's', capabilities: ['getContext', 'applyBatch', 'execute', 'getOperation', 'cancel'], writeEnabled: true,
    limits: { maxMessageBytes: 65536, maxBatchSteps: 10, maxQueuedOperations: 4, maxDepth: 8, maxNodes: 1000, maxResponseBytes: 32768, maxImportBytes: 262144, maxExportPixels: 1000000, maxExportBytes: 262144, operationTimeout: 400, dedupTtl: 60000, maxJournalEntries: 100, resourceTtl: 60000, clockSkew: 5000 } }));
  const welcome = JSON.parse((await response)[0].toString());
  scope = { sessionId: 's', connectionGeneration: welcome.connectionGeneration };
  socket.on('message', bytes => {
    const request = JSON.parse(bytes.toString());
    if (request.type === 'getContext') socket.send(JSON.stringify({ type: 'context', ...scope, requestId: request.requestId, document: { documentLabel: 'Test', currentPageId: 'p', pages: [{ id: 'p', name: 'Page' }], selection: [] } }));
    else if (request.command === 'getOperation' || request.command === 'cancel') reply(request, request.command === 'cancel' ? 'cancelled' : results.get(request.operationId)?.status ?? 'running');
    else { commands.push(request); results.set(request.operationId, { kind: request.command, status: 'running' }); }
  });
  const a = await client(), b = await client();
  assert.equal((await b.call('figma_apply_batch', args('applyBatch'))).error.code, 'SESSION_EXPIRED');
  for (const c of [a, b]) assert.equal((await c.call('figma_get_context')).state, 'ready');
  const firstArgs = args('applyBatch'), secondArgs = args('applyBatch');
  const first = a.call('figma_apply_batch', firstArgs); await commandCount(1);
  const second = b.call('figma_apply_batch', secondArgs); await delay(20);
  assert.equal(commands.length, 1);
  const controlArgs = input => ({ scope, operationId: input.operationId });
  assert.equal((await b.call('figma_get_operation', controlArgs(secondArgs))).status, 'queued');
  assert.equal((await b.call('figma_cancel_operation', controlArgs(firstArgs))).error.code, 'OPERATION_NOT_OWNED');
  assert.equal((await a.call('figma_get_operation', controlArgs(firstArgs))).status, 'running');
  reply(commands[0]); assert.equal((await first).status, 'succeeded');
  await commandCount(2); reply(commands[1]); assert.equal((await second).status, 'succeeded');
  assert.equal((await a.call('figma_apply_batch', firstArgs)).status, 'succeeded');
  assert.equal(commands.length, 2, 'retry must not execute a completed write again');
  assert.equal((await b.call('figma_apply_batch', firstArgs)).error.code, 'OPERATION_NOT_OWNED');
  assert.equal((await a.call('figma_apply_batch', { ...firstArgs, steps: [{ stepId: 'p', op: 'createPage', name: 'Changed' }] })).error.code, 'OPERATION_ID_CONFLICT');

  const thirdArgs = args('applyBatch'), cancelledArgs = args('execute');
  const third = a.call('figma_apply_batch', thirdArgs); await commandCount(3);
  const cancelled = b.call('figma_execute', cancelledArgs); await delay(20);
  assert.equal((await b.call('figma_cancel_operation', controlArgs(cancelledArgs))).status, 'cancelled');
  assert.equal((await cancelled).error.code, 'CANCELLED');
  reply(commands[2]); await third; assert.equal(commands.length, 3);

  for (const kind of ['applyBatch', 'execute']) {
    const input = args(kind), index = commands.length;
    const pending = a.call(kind === 'execute' ? 'figma_execute' : 'figma_apply_batch', input);
    await commandCount(index + 1);
    const waiting = b.call('figma_get_context');
    assert.equal((await pending).error.code, 'OUTCOME_UNKNOWN');
    assert.equal((await waiting).error.code, 'RECOVERY_REQUIRED');
    assert.equal((await b.call('figma_get_context')).error.code, 'RECOVERY_REQUIRED');
    assert.equal((await a.call('figma_get_operation', controlArgs(input))).status, 'running');
    reply(commands[index]); await delay(20);
    assert.equal((await b.call('figma_get_context')).state, 'ready', 'late terminal reply releases recovery barrier');
  }
  console.log('Client scheduling: two clients, FIFO, queued status/cancel, ownership, batch/execute timeout and late completion OK');
} finally {
  socket.terminate();
  for (const { sdk, server, lifetime } of clients) { lifetime.abort(); await sdk.close(); await server.close(); }
  await bridge.close();
}
