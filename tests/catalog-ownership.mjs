import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/client';
await build({ entryPoints: ['server/catalog.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'dist/test-support/catalog-ownership.mjs' });
const { createServer } = await import('../dist/test-support/catalog-ownership.mjs');
const transport = () => ({ async start() {}, async send(message) { queueMicrotask(() => this.peer.onmessage?.(message)); }, async close() { this.onclose?.(); this.peer.onclose?.(); } });
const a = transport(), b = transport(); a.peer = b; b.peer = a;
let calls = 0;
const forbidden = () => { calls++; throw Error('handler must not run'); };
const server = createServer(forbidden, forbidden, forbidden, forbidden, forbidden, forbidden, forbidden, forbidden, forbidden, forbidden, forbidden, () => { throw Error('SESSION_BUSY'); });
const client = new Client({ name: 'ownership-test', version: '1' });
try {
  await server.connect(a); await client.connect(b);
  assert.equal((await client.listTools()).tools.length, 11);
  await client.listResourceTemplates(); await client.ping();
  const scope = { sessionId: 's', connectionGeneration: 1 }, operationId = '019a4a10-0000-7000-8000-000000000001';
  for (const [name, args] of [
    ['figma_get_context', {}], ['figma_get_tree', { scope, rootId: 'p', depth: 1, limit: 1 }],
    ['figma_find_nodes', { scope, document: true, limit: 1 }], ['figma_get_nodes', { scope, nodeIds: ['n'], fields: ['name'] }],
    ['figma_get_local_resources', { scope, kind: 'components', fields: ['name'], limit: 1 }],
    ['figma_navigate', { scope, nodeIds: [], select: false, reveal: false }],
    ['figma_export_node', { scope, nodeId: 'n', format: 'SVG' }],
    ['figma_apply_batch', { scope, operationId, steps: [{ stepId: 'p', op: 'createPage', name: 'Page' }] }],
    ['figma_get_operation', { scope, operationId }], ['figma_cancel_operation', { scope, operationId }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name); assert.equal(result.structuredContent?.error.code, 'SESSION_BUSY', name);
    assert.match(result.structuredContent.error.recoveryAction, /другого MCP-клиента/);
  }
  await assert.rejects(client.readResource({ uri: 'figma-resource://export/' + 'x'.repeat(43) }), /SESSION_BUSY/);
  assert.equal(calls, 0);
  console.log('Catalog ownership: discovery allowed, busy tool/resource blocked before handlers OK');
} finally { await client.close(); await server.close(); }
