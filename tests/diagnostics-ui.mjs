import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const html = await readFile('experiments/diagnostics/ui.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const bundled = await build({ entryPoints: ['shared/bootstrap-limits.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { bootstrapLimits } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const ids = ['run', 'stop', 'status', 'report', 'bridge-status', 'bridge-report', 'secret', 'connect', 'disconnect', 'bridge-document', 'snapshot', 'positive', 'replay'];
const elements = Object.fromEntries(ids.map(id => [id, { value: '', textContent: '' }]));
const main = [], sockets = [];
class Socket {
  static OPEN = 1;
  readyState = 1; sent = [];
  constructor() { sockets.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}
const ui = { document: { getElementById: id => elements[id] }, WebSocket: Socket,
  parent: { postMessage: value => main.push(value.pluginMessage) }, performance: { now: () => 0 }, setTimeout, clearTimeout };
runInNewContext(script, ui);
elements.secret.value = 'a'.repeat(64); elements.connect.onclick();
assert.equal(elements.secret.value, '');
const socket = sockets[0]; socket.onopen();
const server = value => socket.onmessage({ data: JSON.stringify(value) });
const fromMain = value => ui.onmessage({ data: { pluginMessage: value } });
const hello = { type: 'hello', protocolVersion: 2, sessionId: 'new', capabilities: ['getContext', 'getTree', 'applyBatch'], limits: bootstrapLimits, writeEnabled: true };
server({ type: 'paired' }); fromMain(hello);
server({ ...hello, type: 'welcome', connectionGeneration: 2 });
fromMain({ type: 'bound', sessionId: 'new', connectionGeneration: 2, documentLabel: 'Fixture', writeEnabled: true, message: 'diagnostic' });
fromMain({ type: 'operationResult', sessionId: 'new', connectionGeneration: 2, operationId: '019a4a10-0000-7000-8000-000000000001', data: { error: { code: 'CONFLICT', message: 'Document changed', recoveryAction: 'Read again' } } });
assert.match(elements['bridge-status'].textContent, /CONFLICT: Document changed/);
const beforeRun = main.length;
elements.run.onclick();
assert.equal(main.length, beforeRun);
elements.snapshot.onclick();
assert.deepEqual(socket.sent.at(-1), { type: 'diagControl', action: 'snapshot' });
server({ type: 'diagEvent', event: 'snapshot', sessionId: 'new', connectionGeneration: 2, documentLabel: 'B', pageId: 'p2', markerIds: [] });
assert.equal(elements['bridge-document'].textContent, 'Документ: B');
elements.replay.onclick();
server({ type: 'diagEvent', event: 'replay-sent', original: { sessionId: 'old', connectionGeneration: 1 }, current: { sessionId: 'new', connectionGeneration: 2 } });
const before = main.length;
server({ type: 'command', sessionId: 'old', connectionGeneration: 1, operationId: '019a4a10-0000-7000-8000-000000000001', command: 'applyBatch', params: { steps: [{ stepId: 'marker', op: 'createPage', name: 'Never forwarded' }] } });
assert.equal(socket.readyState, 3);
assert.equal(main.length, before + 1);
assert.equal(main.at(-1).type, 'disconnected');
const report = JSON.parse(elements['bridge-report'].value);
assert.deepEqual(report.map(item => item.event), ['snapshot', 'replay-sent', 'rejected']);
assert.equal(report.at(-1).layer, 'ui');
assert.equal(report.at(-1).code, 'SESSION_EXPIRED');
assert.equal(JSON.stringify(report).includes('a'.repeat(64)), false);
elements.run.onclick();
assert.equal(main.at(-1).suite, 'resources');
elements.secret.value = 'b'.repeat(64); elements.connect.onclick();
assert.equal(sockets.length, 1);
fromMain({ type: 'yield', id: 1 });
assert.equal(main.at(-1).type, 'yield');
console.log('Diagnostics UI: strict bridge, isolated suites and stale rejection evidence OK');
