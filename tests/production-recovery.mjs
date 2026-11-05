import { createUIElements } from './ui-elements.mjs';
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
  const elements = createUIElements();
  const nodes = new Map(); let count = 0;
  const page = { id: '0:1', name: 'Page', type: 'PAGE', selection: [], children: [], async loadAsync() {}, on() {} }; nodes.set(page.id, page);
  let ui, resolveBound, holdYield = false, heldYield, dropId;
  const bound = new Promise(resolve => resolveBound = resolve);
  const figma = { root: { name: 'Test document', children: [page] }, currentPage: page, mixed: Symbol('mixed'),
    getNodeByIdAsync: async id => nodes.get(id) ?? null, createPage() { const node = { id: 'new:' + ++count, name: '', type: 'PAGE', async loadAsync() {} }; nodes.set(node.id, node); return node; }, commitUndo() {},
    showUI() {}, ui: {
    postMessage(message) { if (message.type === 'operationResult' && message.operationId === dropId) return; if (message.type === 'yield' && holdYield) { heldYield = message; return; } queueMicrotask(() => {
      ui.onmessage({ data: { pluginMessage: message } });
      if (message.type === 'bound') resolveBound(message);
    }); },
  } };
  runInNewContext(main, { figma, __html__: '' });
  class Socket extends WebSocket {
    constructor(requested) { assert.equal(requested, 'ws://localhost:55263'); super(url); sockets.push(this); }
  }
  ui = { setTimeout: () => 1, clearTimeout() {}, document: { hidden: false, addEventListener() {}, getElementById: id => elements[id] }, WebSocket: Socket,
    parent: { postMessage: ({ pluginMessage }) => queueMicrotask(() => figma.ui.onmessage(pluginMessage)) } };
  ui.window = ui; ui.addEventListener = () => {};
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
  const lostId = operationId.replace(/1$/, '4');
  dropId = lostId;
  const lost = client.callTool({ name: 'figma_apply_batch', arguments: { ...args, operationId: lostId } });
  for (let i = 0; i < 100 && count < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(count, 2);
  await new Promise(resolve => setTimeout(resolve, 50));
  elements.disconnect.onclick();
  const lostResult = (await lost).structuredContent;
  assert.equal(lostResult.error.code, 'OUTCOME_UNKNOWN');
  dropId = undefined;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent.error.code, 'RECOVERY_REQUIRED');
  runInNewContext(main, { figma, __html__: '' });
  elements.secret.value = token; elements.connect.onclick();
  let fresh;
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    fresh = (await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent;
    if (fresh.state === 'ready') break;
  }
  assert.equal(fresh.state, 'ready'); assert.equal(fresh.writeEnabled, false);
  const newScope = { sessionId: fresh.sessionId, connectionGeneration: fresh.connectionGeneration };
  assert.notEqual(newScope.sessionId, scope.sessionId); assert.notEqual(newScope.connectionGeneration, scope.connectionGeneration);
  const known = (await client.callTool({ name: 'figma_get_operation', arguments: { scope: newScope, operationId: lostId } })).structuredContent;
  assert.equal(known.error.code, 'OPERATION_NOT_OWNED');
  assert.equal(count, 2);
  const stale = (await client.callTool({ name: 'figma_apply_batch', arguments: { ...args, operationId: lostId } })).structuredContent;
  assert.equal(stale.error.code, 'SESSION_EXPIRED');
  elements.write.checked = true; elements.write.onchange();
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = new WebSocket(url); sockets.push(second);
  await new Promise((resolve, reject) => { second.once('open', () => second.send(JSON.stringify({ type: 'pair', secret: token }))); second.once('close', (code, reason) => { try { assert.equal(code, 1008); assert.equal(reason.toString(), 'SESSION_BUSY'); resolve(); } catch (e) { reject(e); } }); second.once('error', reject); });
  const timeoutId = operationId.replace(/1$/, '5'); dropId = timeoutId;
  const timed = await client.callTool({ name: 'figma_apply_batch', arguments: { ...args, scope: newScope, operationId: timeoutId } });
  assert.equal(timed.structuredContent.error.code, 'OUTCOME_UNKNOWN'); assert.equal(count, 3);
  dropId = undefined;
  const afterTimeout = (await client.callTool({ name: 'figma_get_operation', arguments: { scope: newScope, operationId: timeoutId } })).structuredContent;
  assert.equal(afterTimeout.status, 'succeeded'); assert.equal(count, 3);
  elements.disconnect.onclick(); await new Promise(resolve => setTimeout(resolve, 50));
  runInNewContext(main, { figma, __html__: '' });
  elements.secret.value = token; elements.connect.onclick();
  let restarted;
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    restarted = (await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent;
    if (restarted.state === 'ready') break;
  }
  assert.equal(restarted.state, 'ready'); assert.notEqual(restarted.sessionId, scope.sessionId); assert.equal(restarted.writeEnabled, false);
  const restartedScope = { sessionId: restarted.sessionId, connectionGeneration: restarted.connectionGeneration };
  const unknown = (await client.callTool({ name: 'figma_get_operation', arguments: { scope: restartedScope, operationId: timeoutId } })).structuredContent;
  assert.equal(unknown.error.code, 'OPERATION_NOT_OWNED');
  const expired = (await client.callTool({ name: 'figma_get_operation', arguments: { scope: newScope, operationId: timeoutId } })).structuredContent;
  assert.equal(expired.error.code, 'SESSION_EXPIRED'); assert.equal(count, 3);
  console.log('Production fakeFigma SDK recovery: disconnect, reconnect, conflict and timeout OK');
} finally {
  clearTimeout(deadline);
  for (const socket of sockets) socket.terminate();
  await client.close();
}
