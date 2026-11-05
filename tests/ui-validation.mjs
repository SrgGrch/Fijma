import { createUIElements } from './ui-elements.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const html = await readFile('dist/plugin/ui.html', 'utf8');
for (const id of ['stop', 'disconnect']) assert.match(html, new RegExp(`<button id="${id}"[^>]*>`));
assert.match(html, /<input id="write" type="checkbox"/);
const uiBuild = await build({ entryPoints: ['plugin/ui.ts'], bundle: true, format: 'iife', platform: 'browser', write: false });
const script = uiBuild.outputFiles[0].text;
const built = await build({ entryPoints: ['shared/bootstrap-limits.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { bootstrapLimits } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const operationId = '019a4a10-0000-7000-8000-000000000001';
const hello = { type: 'hello', protocolVersion: 2, sessionId: 's', capabilities: ['getContext', 'getTree', 'navigate'], limits: bootstrapLimits, writeEnabled: false };
const welcome = { ...hello, type: 'welcome', connectionGeneration: 1 };
function setup(initiallyHidden = false) {
  const elements = createUIElements();
  const sentMain = [], sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 1; sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  const listeners = {}, windowListeners = {};
  const document = { hidden: initiallyHidden, getElementById: id => elements[id], addEventListener: (event, fn) => { listeners[event] = fn; } };
  const ui = { setTimeout: () => 1, clearTimeout() {}, document, addEventListener: (event, fn) => { windowListeners[event] = fn; }, WebSocket: Socket, parent: { postMessage: value => sentMain.push(value.pluginMessage) } };
  ui.window = ui;
  runInNewContext(script, ui);
  elements.secret.value = 'a'.repeat(64); elements.connect.onclick();
  const socket = sockets[0]; if (socket) socket.onopen();
  const server = value => socket.onmessage({ data: JSON.stringify(value) });
  const main = value => ui.onmessage({ data: { pluginMessage: value } });
  return { socket, sockets, sentMain, server, main, elements, document, listeners, windowListeners };
}
function paired() { const h = setup(); h.server({ type: 'paired' }); return h; }
function awaitingWelcome() { const h = paired(); h.main(hello); return h; }
function ready() { const h = awaitingWelcome(); h.server(welcome); h.main({ type: 'bound', sessionId: 's', connectionGeneration: 1, documentLabel: 'Test', writeEnabled: false, message: 'Ready' }); return h; }

for (const bad of [{ type: 'paired', extra: true }, { type: 'welcome' }, { type: 'paired', protocolVersion: 2 }]) {
  const h = setup(), before = h.sentMain.length; h.server(bad);
  assert.equal(h.socket.readyState, 3); assert.equal(h.sentMain.length, before + 1); assert.equal(h.sentMain.at(-1).type, 'disconnected');
}
{
  const h = paired(); h.main({ ...hello, protocolVersion: 999 });
  assert.equal(h.socket.readyState, 3); assert.equal(h.socket.sent.length, 1);
}
for (const bad of [{ ...welcome, protocolVersion: 999 }, { ...welcome, sessionId: 'other' }, { ...welcome, extra: 1 }, { ...welcome, writeEnabled: true }]) {
  const h = awaitingWelcome(), before = h.sentMain.length; h.server(bad);
  assert.equal(h.socket.readyState, 3); assert.equal(h.sentMain.length, before + 1); assert.equal(h.sentMain.at(-1).type, 'disconnected');
}
const command = { type: 'command', sessionId: 's', connectionGeneration: 1, operationId, command: 'navigate', params: { nodeIds: ['1:1'], select: true, reveal: false } };
{
  const h = ready(); h.server(command);
  assert.equal(h.sentMain.at(-1).command, 'navigate');
  const ack = { type: 'ack', sessionId: 's', connectionGeneration: 1, operationId };
  h.main(ack); assert.equal(h.socket.sent.at(-1).type, 'ack'); assert.equal(h.socket.sent.at(-1).status, undefined);
  h.main({ type: 'navigateResult', sessionId: 's', connectionGeneration: 1, operationId, data: { currentPageId: '0:1', selection: ['1:1'] } });
  assert.equal(h.socket.sent.at(-1).type, 'navigateResult');
}
{
  const h = ready(), before = h.sentMain.length;
  h.server({ ...command, command: 'applyBatch', params: { steps: [{ stepId: 'huge', op: 'createPage', name: '界'.repeat(22000) }] } });
  assert.equal(h.socket.readyState, 3); assert.equal(h.sentMain.length, before + 1); assert.equal(h.sentMain.at(-1).type, 'disconnected');
}
for (const bad of [{ ...command, params: { ...command.params, execute_js: 'bad' } }, { ...command, sessionId: 'other' }, { ...command, connectionGeneration: 2 }, { ...command, command: 'applyBatch', params: { steps: [] } }]) {
  const h = ready(), before = h.sentMain.length; h.server(bad);
  assert.equal(h.socket.readyState, 3); assert.equal(h.sentMain.length, before + 1); assert.equal(h.sentMain.at(-1).type, 'disconnected');
  h.server(command);
  assert.equal(h.sentMain.length, before + 1);
  assert.equal(h.elements.status.textContent, 'Не удалось подключиться');
}
for (const bad of [
  { type: 'navigateResult', sessionId: 's', connectionGeneration: 1, operationId, data: { currentPageId: '0:1', selection: [], extra: true } },
  { type: 'navigateResult', sessionId: 'other', connectionGeneration: 1, operationId, data: { currentPageId: '0:1', selection: [] } },
  { type: 'ack', sessionId: 's', connectionGeneration: 1, operationId, status: 'succeeded' },
  { type: 'operationResult', sessionId: 's', connectionGeneration: 1, operationId, data: { sessionId: 's', connectionGeneration: 1, operationId, status: 'succeeded', steps: [], affectedNodeIds: [], affectedResourceIds: [], warnings: [] } },
]) {
  const h = ready(), before = h.socket.sent.length; h.main(bad);
  assert.equal(h.socket.readyState, 3); assert.equal(h.socket.sent.length, before);
}
{
  const h = ready(), before = h.sentMain.length; h.main({ type: 'yield', id: 1, extra: true });
  assert.equal(h.socket.readyState, 3); assert.equal(h.sentMain.length, before + 1); assert.equal(h.sentMain.at(-1).type, 'disconnected');
}
{
  const h = ready();
  h.elements.write.checked = true; h.elements.write.onchange();
  assert.equal(h.sentMain.at(-1).type, 'setWriteEnabled');
  h.main({ type: 'writeState', enabled: false, reason: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(h.elements.write.checked, false);
  assert.match(h.elements['write-status'].textContent, /недоступна/);
  h.elements.stop.onclick(); assert.equal(h.sentMain.at(-1).type, 'stop');
  h.server(command); assert.match(h.elements.operation.textContent, /navigate/);
  h.main({ type: 'navigateResult', sessionId: 's', connectionGeneration: 1, operationId, data: { currentPageId: '0:1', selection: [] } });
  assert.match(h.elements.operation.textContent, /Ожидаем команды/);
  h.server(command);
  h.main({ type: 'navigateResult', sessionId: 's', connectionGeneration: 1, operationId, error: { code: 'NODE_NOT_FOUND', message: 'Node missing', recoveryAction: 'Read again' } });
  assert.match(h.elements['last-error'].textContent, /NODE_NOT_FOUND: Node missing/);
  h.elements.disconnect.onclick();
  assert.equal(h.sentMain.at(-1).type, 'disconnected');
  assert.match(h.elements['last-error'].textContent, /NODE_NOT_FOUND/);
}
for (const reason of ['SESSION_BUSY', 'AUTH_FAILED', 'PROTOCOL_MISMATCH', 'private payload']) {
  const h = setup(); h.socket.onclose({ reason });
  assert.equal(h.elements.connection.dataset.state, reason === 'private payload' ? 'waiting' : 'error');
}
{
  const h = ready(); h.elements.write.checked = true;
  const before = h.sentMain.length;
  h.document.hidden = true; h.listeners.visibilitychange?.();
  assert.equal(h.socket.readyState, 1); assert.equal(h.sentMain.length, before); assert.equal(h.elements.write.checked, true);
  h.document.hidden = false; h.listeners.visibilitychange?.();
  assert.equal(h.sockets.length, 1, 'returning must not reconnect or reset the binding');
}
{ const h = setup(true); assert.equal(h.sockets.length, 1, 'a background plugin can connect'); }
{ const h = ready(); h.windowListeners.pagehide(); assert.equal(h.socket.readyState, 3); assert.equal(h.sentMain.at(-1).type, 'disconnected'); }
{
  const h = setup(), capabilities = [...hello.capabilities, 'applyBatch', 'getOperation', 'cancel', 'exportNode'];
  const extended = { ...hello, capabilities };
  h.server({ type: 'paired' }); h.main(extended); h.server({ ...extended, type: 'welcome', connectionGeneration: 1 });
  const idA = operationId, idB = operationId.replace(/1$/, '2'), readId = operationId.replace(/1$/, '3');
  const requestA = '550e8400-e29b-41d4-a716-446655440001', requestB = '550e8400-e29b-41d4-a716-446655440002', metaId = '550e8400-e29b-41d4-a716-446655440003';
  const send = (id, name, params, requestId) => h.server({ type: 'command', sessionId: 's', connectionGeneration: 1, operationId: id, command: name, params, ...(requestId ? { requestId } : {}) });
  const reply = (id, status, requestId) => h.main({ type: 'operationResult', sessionId: 's', connectionGeneration: 1, operationId: id, requestId, data: { operationId: id, sessionId: 's', connectionGeneration: 1, status, steps: [], affectedNodeIds: [], affectedResourceIds: [], warnings: [] } });
  const steps = [{ stepId: 'page', op: 'createPage', name: 'Page' }];
  send(idA, 'applyBatch', { steps }, requestA); send(idB, 'applyBatch', { steps }, requestB);
  assert.match(h.elements.operation.textContent, new RegExp(idA));
  send(readId, 'navigate', { nodeIds: [], select: false, reveal: false });
  h.main({ type: 'navigateResult', sessionId: 's', connectionGeneration: 1, operationId: readId, data: { currentPageId: '0:1', selection: [] } });
  assert.match(h.elements.operation.textContent, new RegExp(idA));
  send(idA, 'getOperation', {}, metaId); reply(idA, 'running', metaId);
  assert.match(h.elements.operation.textContent, new RegExp(idA));
  send(idA, 'cancel', {}, metaId); reply(idA, 'queued', metaId);
  assert.match(h.elements.operation.textContent, new RegExp(idA));
  send(idA, 'getOperation', {}, metaId); reply(idA, 'unknown', metaId);
  assert.match(h.elements.operation.textContent, new RegExp(idA));
  reply(idA, 'succeeded', requestA); assert.match(h.elements.operation.textContent, new RegExp(idB));
  reply(idB, 'succeeded', requestB); assert.match(h.elements.operation.textContent, /Ожидаем команды/);
  send(readId, 'exportNode', { nodeId: '1:1', format: 'SVG', scale: 1 });
  h.main({ type: 'exportStart', sessionId: 's', connectionGeneration: 1, operationId: readId, nodeId: '1:1', format: 'SVG', bytes: 4, total: 2, chunkBytes: 3 });
  h.main({ type: 'exportChunk', sessionId: 's', connectionGeneration: 1, operationId: readId, index: 0, total: 2, data: 'YWJj' });
  assert.match(h.elements.operation.textContent, /exportNode/);
  h.main({ type: 'exportChunk', sessionId: 's', connectionGeneration: 1, operationId: readId, index: 1, total: 2, data: 'ZA==' });
  assert.match(h.elements.operation.textContent, /Ожидаем команды/);
  send(idA, 'applyBatch', { steps }, requestA); h.elements.disconnect.onclick(); assert.match(h.elements.operation.textContent, /Ожидаем команды/);
}
console.log('UI message validation: phases, version, scope, schema, navigation and ACK OK');
