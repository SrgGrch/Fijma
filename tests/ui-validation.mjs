import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const html = await readFile('dist/plugin/ui.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const built = await build({ entryPoints: ['shared/bootstrap-limits.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { bootstrapLimits } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const operationId = '019a4a10-0000-7000-8000-000000000001';
const hello = { type: 'hello', protocolVersion: 1, sessionId: 's', capabilities: ['getContext', 'getTree', 'navigate'], limits: bootstrapLimits, writeEnabled: false };
const welcome = { ...hello, type: 'welcome', connectionGeneration: 1 };
function setup() {
  const elements = Object.fromEntries(['secret', 'connect', 'disconnect', 'status', 'document'].map(id => [id, { value: '', textContent: '' }]));
  const sentMain = [], sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 1; sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  const ui = { document: { getElementById: id => elements[id] }, WebSocket: Socket, parent: { postMessage: value => sentMain.push(value.pluginMessage) } };
  runInNewContext(script, ui);
  elements.secret.value = 'a'.repeat(64); elements.connect.onclick();
  const socket = sockets[0]; socket.onopen();
  const server = value => socket.onmessage({ data: JSON.stringify(value) });
  const main = value => ui.onmessage({ data: { pluginMessage: value } });
  return { socket, sentMain, server, main, elements };
}
function paired() { const h = setup(); h.server({ type: 'paired' }); return h; }
function awaitingWelcome() { const h = paired(); h.main(hello); return h; }
function ready() { const h = awaitingWelcome(); h.server(welcome); return h; }

for (const bad of [{ type: 'paired', extra: true }, { type: 'welcome' }, { type: 'paired', protocolVersion: 1 }]) {
  const h = setup(), before = h.sentMain.length; h.server(bad);
  assert.equal(h.socket.readyState, 3); assert.equal(h.sentMain.length, before + 1); assert.equal(h.sentMain.at(-1).type, 'disconnected');
}
{
  const h = paired(); h.main({ ...hello, protocolVersion: 2 });
  assert.equal(h.socket.readyState, 3); assert.equal(h.socket.sent.length, 1);
}
for (const bad of [{ ...welcome, protocolVersion: 2 }, { ...welcome, sessionId: 'other' }, { ...welcome, extra: 1 }, { ...welcome, writeEnabled: true }]) {
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
for (const bad of [{ ...command, params: { ...command.params, execute_js: 'bad' } }, { ...command, sessionId: 'other' }, { ...command, connectionGeneration: 2 }, { ...command, command: 'applyBatch', params: { steps: [] } }]) {
  const h = ready(), before = h.sentMain.length; h.server(bad);
  assert.equal(h.socket.readyState, 3); assert.equal(h.sentMain.length, before + 1); assert.equal(h.sentMain.at(-1).type, 'disconnected');
  h.server(command);
  assert.equal(h.sentMain.length, before + 1);
  assert.equal(h.elements.status.textContent, 'PROTOCOL_MISMATCH');
}
for (const bad of [
  { type: 'navigateResult', sessionId: 's', connectionGeneration: 1, operationId, data: { currentPageId: '0:1', selection: [], extra: true } },
  { type: 'navigateResult', sessionId: 'other', connectionGeneration: 1, operationId, data: { currentPageId: '0:1', selection: [] } },
  { type: 'ack', sessionId: 's', connectionGeneration: 1, operationId, status: 'succeeded' },
]) {
  const h = ready(), before = h.socket.sent.length; h.main(bad);
  assert.equal(h.socket.readyState, 3); assert.equal(h.socket.sent.length, before);
}
{
  const h = ready(), before = h.sentMain.length; h.main({ type: 'yield', id: 1, extra: true });
  assert.equal(h.socket.readyState, 3); assert.equal(h.sentMain.length, before + 1); assert.equal(h.sentMain.at(-1).type, 'disconnected');
}
console.log('UI message validation: phases, version, scope, schema, navigation and ACK OK');
