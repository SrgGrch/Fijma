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
  const main = await readFile('dist/candidate/main.js', 'utf8');
  const html = await readFile('dist/plugin/ui.html', 'utf8');
  const elements = Object.fromEntries(['secret', 'connect', 'disconnect', 'status', 'document', 'write', 'write-status', 'stop', 'operation'].map(id => [id, { value: '', textContent: '' }]));
  const nodes = new Map(); let count = 0;
  const page = { id: '0:1', name: 'Page', type: 'PAGE', selection: [], children: [], appendChild() {}, async loadAsync() {}, on() {} }; nodes.set(page.id, page);
  let ui, resolveBound, holdYield = false, heldYield;
  const bound = new Promise(resolve => resolveBound = resolve);
  const figma = { root: { name: 'Test document', children: [page] }, currentPage: page, mixed: Symbol('mixed'),
    getNodeByIdAsync: async id => nodes.get(id) ?? null, async loadFontAsync() { throw new Error('missing'); }, createPage() { const node = { id: 'new:' + ++count, name: '', type: 'PAGE', async loadAsync() {} }; nodes.set(node.id, node); return node; }, commitUndo() {},
    showUI() {}, ui: {
    postMessage(message) { if (message.type === 'yield' && holdYield) { heldYield = message; return; } queueMicrotask(() => {
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
  elements.write.checked = true; elements.write.onchange();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent.writeEnabled, true);
  const stamp = Date.now().toString(16).padStart(12, '0');
  const operationId = `${stamp.slice(0,8)}-${stamp.slice(8)}-7000-8000-000000000001`;
  const args = { scope, operationId, steps: [{ stepId: 'new', op: 'createPage', name: 'New' }] };
  const first = (await client.callTool({ name: 'figma_apply_batch', arguments: args })).structuredContent;
  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  assert.equal(first.steps[0].appliedChanges.details[0].properties.name, 'New');
  assert.equal((await client.callTool({ name: 'figma_apply_batch', arguments: args })).structuredContent.status, 'succeeded');
  assert.equal(count, 1);
  assert.equal((await client.callTool({ name: 'figma_get_operation', arguments: { scope, operationId } })).structuredContent.status, 'succeeded');
  const conflictId = operationId.replace(/1$/, '2');
  const conflict = (await client.callTool({ name: 'figma_apply_batch', arguments: { scope, operationId: conflictId, steps: [{ stepId: 'rename', op: 'renamePage', pageId: { nodeId: 'new:1' }, name: 'Other', expected: { name: 'stale' } }] } })).structuredContent;
  assert.equal(conflict.status, 'failed'); assert.equal(conflict.error.code, 'CONFLICT');
  const fontId = operationId.replace(/1$/, '8');
  const missingFont = (await client.callTool({ name: 'figma_apply_batch', arguments: { scope, operationId: fontId, steps: [{ stepId: 'text', op: 'createText', parent: { nodeId: '0:1' }, characters: 'Hi', font: { family: 'Missing', style: 'Regular' }, typography: {} }] } })).structuredContent;
  assert.equal(missingFont.error.code, 'FONT_UNAVAILABLE');
  assert.deepEqual(missingFont.error.details.fonts, [{ family: 'Missing', style: 'Regular' }]); assert.equal(count, 1);
  holdYield = true;
  const pendingId = operationId.replace(/1$/, '3');
  const pending = client.callTool({ name: 'figma_apply_batch', arguments: { ...args, operationId: pendingId } });
  for (let i = 0; i < 50 && !heldYield; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(heldYield);
  const status = (await client.callTool({ name: 'figma_get_operation', arguments: { scope, operationId: pendingId } })).structuredContent;
  assert.equal(status.status, 'running');
  const cancelled = (await client.callTool({ name: 'figma_cancel_operation', arguments: { scope, operationId: pendingId } })).structuredContent;
  assert.equal(cancelled.status, 'running');
  ui.onmessage({ data: { pluginMessage: heldYield } });
  assert.equal((await pending).structuredContent.status, 'cancelled'); assert.equal(count, 1);
  holdYield = false;
  elements.stop.onclick();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent.writeEnabled, false);
  console.log('SDK -> listener -> UI -> candidate fakeFigma: gated write, readback, dedup, status, stop OK');
} finally {
  clearTimeout(deadline);
  for (const socket of sockets) socket.terminate();
  await client.close();
}
