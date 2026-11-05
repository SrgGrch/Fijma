import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { WebSocket } from 'ws';

await build({ entryPoints: ['experiments/diagnostics/controller-core.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'dist/diagnostics/test-controller.mjs' });
const { createDiagnosticController } = await import(pathToFileURL(resolve('dist/diagnostics/test-controller.mjs')).href);
const server = await createDiagnosticController('a'.repeat(64), 0);
const markerBuild = await build({ entryPoints: ['experiments/diagnostics/marker.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { createMarkerProbe, markerStep } = await import(`data:text/javascript;base64,${Buffer.from(markerBuild.outputFiles[0].text).toString('base64')}`);
const source = await readFile('experiments/diagnostics/main.js', 'utf8');
const html = await readFile('experiments/diagnostics/ui.html', 'utf8');
assert.equal((await readFile('dist/plugin/main.js', 'utf8')).includes('FIGMA_MCP_DIAGNOSTIC_MARKER'), false);
assert.equal((await readFile('dist/server/index.js', 'utf8')).includes('FIGMA_MCP_DIAGNOSTIC_MARKER'), false);
const sockets = [];
let sequence = 0, writes = 0;
const until = async (condition, description) => {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error(`Timeout: ${description}`); await new Promise(resolve => setTimeout(resolve, 10)); }
};
function file(label) {
  const page = { id: '0:1', name: 'Page', type: 'PAGE', selection: [], children: [], async loadAsync() {}, on() {}, appendChild(node) { node.parent = this; this.children.push(node); writes++; } };
  return { root: { name: label, children: [page] }, currentPage: page, mixed: Symbol('mixed'),
    async getNodeByIdAsync(id) { return id === page.id ? page : page.children.find(node => node.id === id) ?? null; },
    createRectangle() { return { id: `marker:${++sequence}`, type: 'RECTANGLE', name: '', width: 100, height: 100, resize(w, h) { this.width = w; this.height = h; } }; },
    commitUndo() {}, showUI() {}, ui: {} };
}
function attach(figma) {
  const ids = ['run', 'stop', 'status', 'report', 'secret', 'connect', 'disconnect', 'bridge-status', 'bridge-document', 'bridge-report', 'snapshot', 'positive', 'replay'];
  const elements = Object.fromEntries(ids.map(id => [id, { value: '', textContent: '', disabled: false }]));
  let ui;
  figma.ui = { postMessage(message) { queueMicrotask(() => ui.onmessage({ data: { pluginMessage: message } })); } };
  runInNewContext(source, { figma, __html__: '' });
  class Socket extends WebSocket {
    constructor(requested) { assert.equal(requested, 'ws://localhost:55263'); super(`ws://127.0.0.1:${server.address.port}`); sockets.push(this); }
  }
  ui = { document: { getElementById: id => elements[id] }, WebSocket: Socket, setTimeout, clearTimeout, performance,
    parent: { postMessage: ({ pluginMessage }) => queueMicrotask(() => figma.ui.onmessage(pluginMessage)) } };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
  const events = () => JSON.parse(elements['bridge-report'].value || '[]');
  return { elements, events, async connect() {
    elements.secret.value = 'a'.repeat(64); elements.connect.onclick();
    await until(() => elements['bridge-document'].textContent.includes(figma.root.name), 'binding');
  }, async act(action, event) {
    const count = events().length; elements[action].onclick();
    await until(() => events().slice(count).some(item => item.event === event), `${action} ${event}`);
    return events().slice(count).find(item => item.event === event);
  }, disconnect() { elements.disconnect.onclick(); } };
}
try {
  const bad = new WebSocket(`ws://127.0.0.1:${server.address.port}`); sockets.push(bad);
  await new Promise((resolve, reject) => { bad.once('open', () => bad.send(JSON.stringify({ type: 'pair', secret: 'b'.repeat(64) }))); bad.once('close', code => code === 1008 ? resolve() : reject(new Error('Wrong auth close code'))); });
  const fileA = file('A'), first = attach(fileA);
  const scope = { sessionId: 's', connectionGeneration: 1 };
  for (const step of [{ ...markerStep('0:1'), type: 'FRAME' }, { ...markerStep('0:1'), properties: { ...markerStep('0:1').properties, name: 'other' } }, markerStep('wrong-page')]) {
    await assert.rejects(createMarkerProbe(fileA).run({ params: { steps: [step] } }, scope, () => {}), /INVALID_ARGUMENT/);
  }
  assert.equal(writes, 0);
  const rawMain = file('main-unit'), mainMessages = [];
  rawMain.ui = { postMessage(message) { mainMessages.push(message); } };
  runInNewContext(source, { figma: rawMain, __html__: '' });
  await rawMain.ui.onmessage({ type: 'hello-request' });
  const hello = mainMessages.pop();
  await rawMain.ui.onmessage({ ...hello, type: 'welcome', connectionGeneration: 2 });
  assert.equal(mainMessages.pop().type, 'bound');
  for (const stale of [{ sessionId: 'old', connectionGeneration: 2 }, { sessionId: hello.sessionId, connectionGeneration: 1 }]) {
    await rawMain.ui.onmessage({ type: 'command', ...stale, operationId: '019a4a10-0000-7000-8000-000000000001', command: 'applyBatch', params: { steps: [markerStep('0:1')] } });
    assert.equal(mainMessages.pop().code, 'SESSION_EXPIRED');
  }
  assert.equal(writes, 0);
  rawMain.root = { ...rawMain.root, children: [...rawMain.root.children] };
  await rawMain.ui.onmessage({ type: 'command', sessionId: hello.sessionId, connectionGeneration: 2,
    operationId: '019a4a10-0000-7000-8000-000000000001', command: 'applyBatch', params: { steps: [markerStep('0:1')] } });
  assert.equal(mainMessages.pop().code, 'DOCUMENT_MISMATCH');
  assert.equal(writes, 0);
  const delayed = file('delayed'), replacement = file('replacement'), delayedMessages = [];
  delayed.ui = { postMessage(message) { delayedMessages.push(message); } };
  runInNewContext(source, { figma: delayed, __html__: '' });
  await delayed.ui.onmessage({ type: 'hello-request' });
  const delayedHello = delayedMessages.pop();
  await delayed.ui.onmessage({ ...delayedHello, type: 'welcome', connectionGeneration: 3 }); delayedMessages.pop();
  delayed.getNodeByIdAsync = async () => { delayed.root = replacement.root; delayed.currentPage = replacement.currentPage; return replacement.currentPage; };
  const nowHex = Date.now().toString(16).padStart(12, '0');
  await delayed.ui.onmessage({ type: 'command', sessionId: delayedHello.sessionId, connectionGeneration: 3,
    operationId: `${nowHex.slice(0, 8)}-${nowHex.slice(8)}-7000-8000-000000000002`, command: 'applyBatch', params: { steps: [markerStep('0:1')] } });
  const delayedResult = delayedMessages.pop();
  assert.equal(delayedResult.type, 'operationResult');
  assert.equal(delayedResult.data.error.code, 'DOCUMENT_MISMATCH');
  assert.equal(writes, 0);
  await first.connect();
  assert.equal((await server.getContext()).writeEnabled, true);
  const initial = await first.act('snapshot', 'snapshot');
  assert.equal(initial.documentLabel, 'A');
  assert.deepEqual(initial.markerIds, []);
  const positive = await first.act('positive', 'positive');
  assert.equal(positive.result.status, 'succeeded');
  assert.equal(writes, 1);
  assert.equal((await first.act('snapshot', 'snapshot')).markerIds.length, 1);
  first.disconnect(); await until(() => sockets.at(-1).readyState === WebSocket.CLOSED, 'disconnect');
  await first.connect();
  const reconnected = await first.act('snapshot', 'snapshot');
  assert.equal(reconnected.sessionId, initial.sessionId);
  assert.notEqual(reconnected.connectionGeneration, initial.connectionGeneration);
  const tabB = file('B-active'), originalPage = fileA.currentPage;
  fileA.root.name = 'B-active'; fileA.root.children = tabB.root.children; fileA.currentPage = tabB.currentPage;
  const activeB = await first.act('snapshot', 'snapshot');
  assert.equal(activeB.documentLabel, 'B-active');
  assert.equal(activeB.sessionId, reconnected.sessionId);
  assert.equal(activeB.connectionGeneration, reconnected.connectionGeneration);
  assert.deepEqual(activeB.markerIds, []);
  await first.act('replay', 'rejected');
  assert.equal(first.events().at(-1).layer, 'ui');
  assert.equal(first.events().at(-1).code, 'SESSION_EXPIRED');
  assert.equal(writes, 1);
  await until(() => sockets.at(-1).readyState === WebSocket.CLOSED, 'replay close');
  fileA.root.name = 'A'; fileA.root.children = [originalPage]; fileA.currentPage = originalPage;
  await first.connect();
  const originalRoot = fileA.root;
  fileA.root = tabB.root; fileA.currentPage = tabB.currentPage;
  const mismatch = await first.act('snapshot', 'rejected');
  assert.equal(mismatch.layer, 'main');
  assert.equal(mismatch.code, 'DOCUMENT_MISMATCH');
  assert.equal(writes, 1);
  await until(() => sockets.at(-1).readyState === WebSocket.CLOSED, 'root mismatch close');
  fileA.root = originalRoot; fileA.currentPage = originalPage;
  const restarted = attach(fileA);
  await restarted.connect();
  const restartedSnapshot = await restarted.act('snapshot', 'snapshot');
  assert.notEqual(restartedSnapshot.sessionId, initial.sessionId);
  await restarted.act('replay', 'rejected');
  assert.equal(restarted.events().at(-1).layer, 'ui');
  assert.equal(writes, 1);
  await until(() => sockets.at(-1).readyState === WebSocket.CLOSED, 'restart close');
  const fileB = file('B'), second = attach(fileB);
  await second.connect();
  const beforeB = await second.act('snapshot', 'snapshot');
  assert.equal(beforeB.documentLabel, 'B');
  assert.deepEqual(beforeB.markerIds, []);
  await second.act('replay', 'rejected');
  await until(() => sockets.at(-1).readyState === WebSocket.CLOSED, 'B close');
  await second.connect();
  assert.deepEqual((await second.act('snapshot', 'snapshot')).markerIds, []);
  assert.equal(writes, 1);
  second.disconnect();
  console.log('Diagnostics: real auth/socket/UI/main positive marker and stale replay after reconnect/restart/file switch OK');
} finally {
  for (const socket of sockets) socket.terminate();
  await server.close();
}
