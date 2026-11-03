import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/server/index.js'], env: { ...process.env, FIGMA_MCP_PORT: '0' }, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => diagnostics += bytes.toString());
const client = new Client({ name: 'full-bridge-test', version: '0.1.0' });
const sockets = [];
let secretPath, deadline;
try {
  await client.connect(transport);
  assert.equal((await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent.state, 'disconnected');
  secretPath = diagnostics.match(/Файл сопряжения: ([^\r\n]+)/)[1];
  const url = diagnostics.match(/Локальный мост: (ws:\/\/[^\r\n]+)/)[1];
  const token = await readFile(secretPath, 'utf8');
  const main = await readFile('dist/plugin/main.js', 'utf8');
  const html = await readFile('dist/plugin/ui.html', 'utf8');
  const elements = Object.fromEntries(['secret', 'connect', 'disconnect', 'status', 'document'].map(id => [id, { value: '', textContent: '' }]));
  let invalidate;
  const textNode = { id: '1:1', name: 'Target', type: 'TEXT', visible: false, locked: true };
  const page = { id: '0:1', name: 'Page', type: 'PAGE', selection: [], children: [textNode], async loadAsync() {}, on(_event, handler) { invalidate = handler; } };
  textNode.parent = page;
  let ui, resolveBound;
  const bound = new Promise(resolve => resolveBound = resolve);
  const figma = { root: { name: 'Test document', children: [page] }, currentPage: page, mixed: Symbol('mixed'),
    getNodeByIdAsync: async id => id === textNode.id ? textNode : null,
    variables: { getLocalVariablesAsync: async () => [{ id: 'v1', name: 'Color', resolvedType: 'COLOR', variableCollectionId: 'c', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'v2' } } }] },
    showUI() {}, ui: {
    postMessage(message) { queueMicrotask(() => {
      ui.onmessage({ data: { pluginMessage: message } });
      if (message.type === 'bound') resolveBound(message);
    }); },
  } };
  runInNewContext(main, { figma, __html__: '' });
  class Socket extends WebSocket {
    constructor(requested) { assert.equal(requested, 'ws://localhost:55263'); super(url); sockets.push(this); }
  }
  ui = { document: { getElementById: id => elements[id] }, WebSocket: Socket,
    parent: { postMessage: ({ pluginMessage }) => queueMicrotask(() => figma.ui.onmessage(pluginMessage)) } };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
  elements.secret.value = token;
  elements.connect.onclick();
  const binding = await Promise.race([bound, new Promise((_, reject) => deadline = setTimeout(() => reject(new Error('Handshake timeout')), 5000))]);
  clearTimeout(deadline);
  const context = await client.callTool({ name: 'figma_get_context', arguments: {} });
  assert.equal(context.structuredContent.state, 'ready');
  assert.equal(context.structuredContent.documentLabel, 'Test document');
  assert.equal(context.structuredContent.selection.length, 0);
  assert.equal(context.structuredContent.writeEnabled, false);
  assert.equal(JSON.stringify(context).includes(token), false);
  const scope = { sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration };
  const tree = await client.callTool({ name: 'figma_get_tree', arguments: { scope, rootId: '0:1', depth: 1, limit: 10 } });
  assert.equal(tree.structuredContent.nodes[0].nodeId, '0:1');
  assert.deepEqual(JSON.parse(tree.content[0].text), tree.structuredContent);
  const found = await client.callTool({ name: 'figma_find_nodes', arguments: { scope, document: true, name: 'Target', types: ['TEXT'], limit: 10 } });
  assert.equal(found.structuredContent.nodes[0].nodeId, '1:1');
  assert.equal(found.structuredContent.nodes[0].pageId, '0:1');
  const nodes = await client.callTool({ name: 'figma_get_nodes', arguments: { scope, nodeIds: ['1:1', 'missing'], fields: ['name', 'visible', 'locked', 'fontName'] } });
  assert.equal(nodes.structuredContent.nodes[0].properties.visible, false);
  assert.equal(nodes.structuredContent.nodes[0].properties.locked, true);
  assert.deepEqual(nodes.structuredContent.nodes[0].unavailable, ['fontName']);
  assert.equal(nodes.structuredContent.nodes[1].error.code, 'NODE_NOT_FOUND');
  const variables = await client.callTool({ name: 'figma_get_local_resources', arguments: { scope, kind: 'variables', fields: ['name', 'type', 'valuesByMode'], limit: 10 } });
  assert.equal(variables.structuredContent.resources[0].properties.valuesByMode.m.id, 'v2');
  const firstSearch = await client.callTool({ name: 'figma_find_nodes', arguments: { scope, document: true, limit: 1 } });
  assert.ok(firstSearch.structuredContent.nextCursor);
  invalidate();
  const changedSearch = await client.callTool({ name: 'figma_find_nodes', arguments: { scope, document: true, limit: 1, cursor: firstSearch.structuredContent.nextCursor } });
  assert.equal(changedSearch.structuredContent.error.code, 'INVALID_CURSOR');
  page.selection = [{ id: '1:1' }];
  assert.deepEqual((await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent.selection, ['1:1']);
  const stale = await client.callTool({ name: 'figma_get_tree', arguments: { scope: { ...scope, sessionId: 'old' }, rootId: '0:1', depth: 1, limit: 10 } });
  assert.equal(stale.structuredContent.error.code, 'SESSION_EXPIRED');
  const unsupported = await client.callTool({ name: 'figma_export_node', arguments: { scope, nodeId: '0:1', format: 'PNG' } });
  assert.equal(unsupported.structuredContent.error.code, 'CAPABILITY_UNAVAILABLE');
  elements.disconnect.onclick();
  console.log('Сквозной stdio → WebSocket → UI → main: контекст, пустая страница, дерево, живое выделение и stale scope — OK');
} finally {
  clearTimeout(deadline);
  for (const socket of sockets) socket.terminate();
  await client.close();
}
await assert.rejects(readFile(secretPath));
