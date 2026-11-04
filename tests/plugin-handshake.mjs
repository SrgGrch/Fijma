import { createUIElements } from './ui-elements.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile('dist/plugin/main.js', 'utf8');
const messages = [];
let loaded = false, invalidate;
const otherPage = { id: '0:2', name: 'Other', type: 'PAGE', async loadAsync() { loaded = true; }, on(_event, handler) { invalidate = handler; },
  get children() { assert.equal(loaded, true); return [{ id: '2:1', name: 'Child', type: 'RECTANGLE' }]; } };
const figma = { showUI() {}, root: { name: '<Document>', children: [{ id: '0:1', name: 'Page', get children() { throw new Error('Page contents loaded'); } }, otherPage] },
  currentPage: { id: '0:1', selection: [{ id: '1:1' }] }, ui: { postMessage: message => messages.push(message) } };
runInNewContext(source, { figma, __html__: '' });
figma.ui.onmessage({ type: 'hello-request' });
const hello = messages.pop();
assert.equal(hello.type, 'hello');
assert.equal(hello.writeEnabled, false);
assert.ok(['applyBatch', 'getOperation', 'cancel'].every(command => hello.capabilities.includes(command)));
assert.ok(Buffer.byteLength(JSON.stringify(hello)) <= 1024);
const welcome = { ...hello, type: 'welcome', connectionGeneration: 10 };
figma.ui.onmessage({ ...welcome, writeEnabled: true });
assert.equal(messages.pop().code, 'PROTOCOL_MISMATCH');
figma.ui.onmessage({ type: 'hello-request' }); messages.pop();
figma.ui.onmessage({ ...welcome, sessionId: 'another' });
assert.equal(messages.pop().code, 'PROTOCOL_MISMATCH');
figma.ui.onmessage({ type: 'hello-request' }); messages.pop();
figma.ui.onmessage(welcome);
assert.equal(messages.pop().type, 'bound');
figma.ui.onmessage({ type: 'getContext', requestId: 'context-1', sessionId: hello.sessionId, connectionGeneration: 10 });
const document = messages.pop().document;
assert.equal(document.pages[0].name, 'Page');
assert.equal(document.selection[0], '1:1');
assert.equal('fileKey' in document, false);
figma.currentPage.selection = [];
figma.ui.onmessage({ type: 'getContext', requestId: 'context-2', sessionId: hello.sessionId, connectionGeneration: 10 });
assert.equal(messages.pop().document.selection.length, 0);
const command = { type: 'command', sessionId: hello.sessionId, connectionGeneration: 10,
  operationId: '019a4a10-0000-7000-8000-000000000001', command: 'getTree', params: { rootId: '0:2', depth: 1, limit: 1 } };
await figma.ui.onmessage(command);
const firstTree = messages.pop();
assert.equal(firstTree.data.nodes[0].nodeId, '0:2');
assert.ok(firstTree.data.nextCursor);
assert.equal(figma.currentPage.id, '0:1');
await figma.ui.onmessage({ ...command, params: { ...command.params, cursor: firstTree.data.nextCursor } });
assert.equal(messages.pop().data.nodes[0].nodeId, '2:1');
await figma.ui.onmessage(command);
const beforeChange = messages.pop();
invalidate();
await figma.ui.onmessage({ ...command, params: { ...command.params, cursor: beforeChange.data.nextCursor } });
assert.equal(messages.pop().error.code, 'INVALID_CURSOR');
await figma.ui.onmessage(command);
const beforeReconnect = messages.pop();
figma.ui.onmessage({ type: 'disconnected' });
figma.ui.onmessage(welcome);
assert.equal(messages.length, 0);
figma.ui.onmessage({ type: 'hello-request', extra: true });
assert.equal(messages.length, 0);
figma.ui.onmessage({ type: 'hello-request' }); messages.pop();
figma.ui.onmessage({ ...welcome, connectionGeneration: 11 }); messages.pop();
await figma.ui.onmessage({ ...command, connectionGeneration: 11, params: { ...command.params, cursor: beforeReconnect.data.nextCursor } });
assert.equal(messages.pop().error.code, 'INVALID_CURSOR');
console.log('Main: hello, чужая сессия, welcome и отключение — OK');

const html = await readFile('dist/plugin/ui.html', 'utf8');
const elements = createUIElements();
const sentMain = [], sockets = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent = [];
  constructor(url) { this.url = url; sockets.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}
const ui = { setTimeout: () => 1, clearTimeout() {}, document: { hidden: false, addEventListener() {}, getElementById: id => elements[id] }, WebSocket: FakeSocket, parent: { postMessage: message => sentMain.push(message.pluginMessage) } };
ui.window = ui; ui.addEventListener = () => {};
runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
elements.secret.value = 'a'.repeat(64);
elements.connect.onclick();
assert.equal(elements.secret.value, '');
const first = sockets[0]; first.onopen();
assert.equal(first.sent[0].type, 'pair');
first.onmessage({ data: JSON.stringify({ type: 'paired' }) });
assert.equal(sentMain.at(-1).type, 'hello-request');
ui.onmessage({ data: { pluginMessage: hello } });
assert.equal(first.sent.at(-1).type, 'hello');
elements.disconnect.onclick();
assert.equal(sentMain.at(-1).type, 'disconnected');
assert.equal(first.readyState, 3);
first.onmessage({ data: JSON.stringify({ type: 'welcome' }) });
assert.equal(sentMain.at(-1).type, 'disconnected');
console.log('UI: очистка секрета, main/UI/socket, disconnect и старое соединение — OK');
