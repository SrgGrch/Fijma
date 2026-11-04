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
  const main = await readFile('dist/candidate/main.js', 'utf8');
  const html = await readFile('dist/plugin/ui.html', 'utf8');
  const elements = createUIElements();
  const nodes = new Map(); let count = 0;
  const make = type => { const n = { id: 'node:' + ++count, type, name: type, x: 0, y: 0, width: 100, height: 100, rotation: 0, visible: true, locked: false, children: [], layoutMode: 'NONE', layoutWrap: 'NO_WRAP', itemSpacing: 0, paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0,
    appendChild(child) { this.children.push(child); child.parent = this; }, resize(w, h) { this.width = w; this.height = h; }, async loadAsync() {}, on() {} }; nodes.set(n.id, n); return n; };
  const page = make('PAGE'); page.id = '0:1'; nodes.set(page.id, page); page.selection = [];
  let ui, resolveBound, holdYield = false, heldYield;
  const bound = new Promise(resolve => resolveBound = resolve);
  const figma = { root: { name: 'Test document', children: [page] }, currentPage: page, mixed: Symbol('mixed'),
    getNodeByIdAsync: async id => nodes.get(id) ?? null, async loadFontAsync() {}, createFrame() { return make('FRAME'); }, createText() { const n = make('TEXT'); n.characters = ''; n.fontName = { family: 'Inter', style: 'Regular' }; n.getStyledTextSegments = () => [{ start: 0, end: n.characters.length, characters: n.characters, fontName: n.fontName, fontSize: 12 }]; return n; }, commitUndo() {},
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
  const args = { scope, operationId, steps: [
    { stepId: 'frame', op: 'createNode', type: 'FRAME', parent: { nodeId: '0:1' }, properties: { name: 'Frame' } },
    { stepId: 'text', op: 'createText', parent: { stepId: 'frame', output: 'nodeId' }, characters: 'Hello', font: { family: 'Inter', style: 'Regular' }, typography: {} },
    { stepId: 'layout', op: 'setAutoLayout', target: { stepId: 'frame', output: 'nodeId' }, layout: { layoutMode: 'HORIZONTAL' } },
  ] };
  const result = (await client.callTool({ name: 'figma_apply_batch', arguments: args })).structuredContent;
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const frameId = result.steps[0].outputs.nodeId, textId = result.steps[1].outputs.nodeId;
  assert.equal(nodes.get(textId).parent.id, frameId);
  assert.equal(result.steps[1].appliedChanges.details.find(x => x.textSegments).textSegments[0].characters, 'Hello');
  assert.equal(result.steps[2].appliedChanges.details.find(x => x.nodeId === frameId).properties.layoutMode, 'HORIZONTAL');
  assert.ok(result.steps[2].appliedChanges.details.some(x => x.nodeId === textId && x.properties.width === 100));
  console.log('Candidate fakeFigma SDK: frame, text and layout readback OK');
} finally {
  clearTimeout(deadline);
  for (const socket of sockets) socket.terminate();
  await client.close();
}
