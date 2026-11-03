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
  const html = await readFile('plugin/ui.html', 'utf8');
  const elements = Object.fromEntries(['secret', 'connect', 'disconnect', 'status', 'document'].map(id => [id, { value: '', textContent: '' }]));
  const page = { id: '0:1', name: 'Page', type: 'PAGE', selection: [], children: [], async loadAsync() {}, on() {} };
  let ui, resolveBound;
  const bound = new Promise(resolve => resolveBound = resolve);
  const figma = { root: { name: 'Test document', children: [page] }, currentPage: page, showUI() {}, ui: {
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
