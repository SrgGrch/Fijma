import assert from 'node:assert/strict';
import { once } from 'node:events';
import { build } from 'esbuild';
import { WebSocket } from 'ws';
await build({ entryPoints: ['server/pairing-listener.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: 'dist/test-support/export-listener.mjs' });
const { createPairingListener } = await import('../dist/test-support/export-listener.mjs');
const secret = 'a'.repeat(64), server = await createPairingListener(secret, 0);
const socket = new WebSocket(`ws://127.0.0.1:${server.address.port}`);
try {
  await once(socket, 'open');
  let next = once(socket, 'message'); socket.send(JSON.stringify({ type: 'pair', secret })); await next;
  const limits = { maxMessageBytes: 65536, maxBatchSteps: 1, maxQueuedOperations: 1, maxDepth: 8, maxNodes: 1000,
    maxResponseBytes: 32768, maxImportBytes: 262144, maxExportPixels: 1000000, maxExportBytes: 262144,
    operationTimeout: 30, dedupTtl: 60000, maxJournalEntries: 100, resourceTtl: 1000, clockSkew: 5000 };
  next = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, sessionId: 's', capabilities: ['getTree', 'exportNode'], limits, writeEnabled: false }));
  const binding = JSON.parse((await next)[0].toString());
  const scope = { sessionId: 's', connectionGeneration: binding.connectionGeneration };
  next = once(socket, 'message');
  const timedOut = server.exportNode({ scope, nodeId: 'n', format: 'SVG' });
  const first = JSON.parse((await next)[0].toString());
  await assert.rejects(timedOut, /FIGMA_API_ERROR/);
  await assert.rejects(server.getTree({ scope, rootId: 'p', depth: 1, limit: 10 }), /RESOURCE_LIMIT/);
  socket.send(JSON.stringify({ type: 'exportStart', ...scope, operationId: first.operationId, nodeId: 'n', format: 'SVG', bytes: 6, total: 1, chunkBytes: 12288 }));
  socket.send(JSON.stringify({ type: 'exportChunk', ...scope, operationId: first.operationId, index: 0, total: 1, data: Buffer.from('<svg/>').toString('base64') }));
  await new Promise(resolve => setTimeout(resolve, 20));
  next = once(socket, 'message');
  const current = server.getTree({ scope, rootId: 'p', depth: 1, limit: 10 });
  const request = JSON.parse((await next)[0].toString());
  assert.notEqual(request.operationId, first.operationId);
  socket.send(JSON.stringify({ type: 'exportChunk', ...scope, operationId: first.operationId, index: 0, total: 1, data: Buffer.from('<svg/>').toString('base64') }));
  socket.send(JSON.stringify({ type: 'treeResult', ...scope, operationId: request.operationId, data: { nodes: [], truncated: false } }));
  assert.deepEqual((await current).nodes, []);
  assert.equal(socket.readyState, WebSocket.OPEN);
  console.log('Export timeout: late chunks are isolated, new requests wait for drain and remain correlated OK');
} finally { socket.terminate(); await server.close(); }
