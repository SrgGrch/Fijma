import { createUIElements } from './ui-elements.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const dir = await mkdtemp(join(tmpdir(), 'figma-recovery-'));
const preload = join(dir, 'generation.cjs');
await writeFile(preload, `const crypto = require('node:crypto'); crypto.randomInt = () => Number(process.env.TEST_GENERATION); require('node:module').syncBuiltinESMExports();`);
let client, transport, url, token;
const sockets = [];
async function start(generation) {
  transport = new StdioClientTransport({ command: process.execPath, args: ['--require', preload, process.env.TEST_SERVER ?? 'dist/server/index.js'], env: { ...process.env, FIGMA_MCP_PORT: '0', FIGMA_MCP_PAIRING_DIR: join(dir, 'pairing'), TEST_GENERATION: String(generation) }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr.on('data', bytes => diagnostics += bytes.toString());
  client = new Client({ name: 'restart-recovery-test', version: '0.1.0' });
  await client.connect(transport);
  await client.callTool({ name: 'figma_get_context', arguments: {} });
  url = diagnostics.match(/Локальный мост: (ws:\/\/[^\r\n]+)/)[1];
  token = await readFile(diagnostics.match(/Файл сопряжения: ([^\r\n]+)/)[1], 'utf8');
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    const result = (await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent;
    if (result.state === 'ready') return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Handshake timeout');
}
try {
  await start(1000);
  const main = await readFile('dist/candidate/main.js', 'utf8');
  const html = await readFile('dist/plugin/ui.html', 'utf8');
  const elements = createUIElements();
  let count = 0, ui;
  const stored = new Map();
  const page = { id: '0:1', name: 'Page', type: 'PAGE', selection: [], children: [], async loadAsync() {}, on() {} };
  const nodes = new Map([[page.id, page]]);
  const figma = { root: { name: 'Test document', children: [page] }, currentPage: page, mixed: Symbol('mixed'), getNodeByIdAsync: async id => nodes.get(id) ?? null,
    createPage() { const node = { id: 'new:' + ++count, name: '', type: 'PAGE', async loadAsync() {} }; nodes.set(node.id, node); return node; }, commitUndo() {}, showUI() {},
    clientStorage: { async getAsync(k) { return stored.get(k); }, async setAsync(k, v) { stored.set(k, v); }, async deleteAsync(k) { stored.delete(k); } },
    ui: { postMessage(message) { queueMicrotask(() => ui.onmessage({ data: { pluginMessage: message } })); } } };
  runInNewContext(main, { figma, __html__: '' });
  class Socket extends WebSocket { constructor(requested) { assert.equal(requested, 'ws://localhost:55263'); super(url); sockets.push(this); } }
  ui = { setTimeout, clearTimeout, document: { hidden: false, addEventListener() {}, getElementById: id => elements[id] }, WebSocket: Socket, parent: { postMessage: ({ pluginMessage }) => queueMicrotask(() => figma.ui.onmessage(pluginMessage)) } };
  ui.window = ui; ui.addEventListener = () => {};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
  elements.secret.value = token; elements.connect.onclick();
  const first = await ready();
  const firstToken = token;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stored.get('bridge-pairing-v1'), firstToken);
  const oldScope = { sessionId: first.sessionId, connectionGeneration: first.connectionGeneration };
  elements.write.checked = true; elements.write.onchange();
  for (let i = 0; i < 100; i++) { if ((await ready()).writeEnabled) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  const stamp = Date.now().toString(16).padStart(12, '0');
  const operationId = `${stamp.slice(0, 8)}-${stamp.slice(8)}-7000-8000-000000000001`;
  const args = { scope: oldScope, operationId, steps: [{ stepId: 'new', op: 'createPage', name: 'New' }] };
  assert.equal((await client.callTool({ name: 'figma_apply_batch', arguments: args })).structuredContent.status, 'succeeded');
  assert.equal(count, 1);
  await client.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  await start(5);
  assert.equal(token, firstToken, 'server restart preserves the pairing credential');
  let second;
  for (let i = 0; i < 100; i++) { second = await ready(); if (second.writeEnabled) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  const scope = { sessionId: second.sessionId, connectionGeneration: second.connectionGeneration };
  assert.equal(scope.sessionId, oldScope.sessionId);
  assert.ok(scope.connectionGeneration < oldScope.connectionGeneration);
  assert.equal(second.writeEnabled, true, 'same plugin run restores write consent after server restart');
  const known = (await client.callTool({ name: 'figma_get_operation', arguments: { scope, operationId } })).structuredContent;
  assert.equal(known.status, 'succeeded', JSON.stringify(known));
  assert.equal(known.connectionGeneration, oldScope.connectionGeneration);
  const cancelled = (await client.callTool({ name: 'figma_cancel_operation', arguments: { scope, operationId } })).structuredContent;
  assert.equal(cancelled.status, 'succeeded');
  assert.equal(cancelled.connectionGeneration, oldScope.connectionGeneration);
  assert.equal((await client.callTool({ name: 'figma_apply_batch', arguments: args })).structuredContent.error.code, 'SESSION_EXPIRED');
  const retry = (await client.callTool({ name: 'figma_apply_batch', arguments: { ...args, scope } })).structuredContent;
  assert.equal(retry.status, 'succeeded', JSON.stringify(retry));
  assert.equal(retry.connectionGeneration, oldScope.connectionGeneration);
  assert.equal(count, 1);
  assert.equal((await ready()).state, 'ready');
  elements.disconnect.onclick();
  console.log('SDK/UI automatic restart recovery with remembered key, descending generations and deduplicated retry OK');
} finally {
  for (const socket of sockets) socket.terminate();
  await client?.close();
  await unlink(preload);
  await unlink(join(dir, 'pairing', 'pairing-secret.txt'));
  await rmdir(join(dir, 'pairing'));
  await rmdir(dir);
}
