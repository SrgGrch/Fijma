import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, unlink, rmdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createUIElements } from './ui-elements.mjs';
import { ipcPath, connectIPC } from '../dist/test-support/ipc.mjs';

const directory = await mkdtemp(join(tmpdir(), 'figma-shared-'));
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const env = { ...process.env, FIGMA_MCP_PORT: String(port), FIGMA_MCP_PAIRING_DIR: directory };
const path = ipcPath(await realpath(directory), port);
const clients = [], sockets = [];
let daemonPid, elements, count = 0, holding = false, heldYield, ui;
async function start() {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/server/index.js'], env, stderr: 'pipe' });
  let diagnostics = ''; transport.stderr.on('data', data => diagnostics += data.toString());
  const client = new Client({ name: 'shared-process-test', version: '1' });
  const protocolErrors = []; client.onerror = error => protocolErrors.push(error);
  const instance = { client, transport, get diagnostics() { return diagnostics; } }; clients.push(instance);
  let deadline;
  try { await Promise.race([client.connect(transport), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Adapter deadline')), 15000); })]); }
  catch (error) { throw new Error(`Adapter connection failed: ${diagnostics}`, { cause: error }); }
  finally { clearTimeout(deadline); }
  const pid = Number(diagnostics.match(/Общий мост: PID (\d+)/)?.[1]); assert.ok(pid);
  if (daemonPid) assert.equal(pid, daemonPid); else daemonPid = pid;
  let discoveryDeadline;
  try { assert.equal((await Promise.race([client.listTools(), new Promise((_, reject) => { discoveryDeadline = setTimeout(() => reject(Error('Discovery deadline: ' + diagnostics)), 5000); })])).tools.length, 11); }
  finally { clearTimeout(discoveryDeadline); }
  await client.ping();
  assert.equal(protocolErrors.length, 0, 'stdout must contain only valid MCP');
  return instance;
}
async function run(args, overrides = {}) {
  const child = spawn(process.execPath, ['dist/server/index.js', ...args], { env: { ...env, ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const timeout = setTimeout(() => child.kill(), 15000);
  try { const [code] = await once(child, 'exit'); return { code, stdout, stderr }; }
  finally { clearTimeout(timeout); }
}
const call = (instance, name, args = {}) => instance.client.callTool({ name, arguments: args });
async function ready(instance) {
  for (let i = 0; i < 250; i++) {
    const result = (await call(instance, 'figma_get_context')).structuredContent;
    if (result.state === 'ready') return result;
    assert.ok(!result.error || result.error.code === 'SESSION_BUSY', JSON.stringify(result));
    await delay(20);
  }
  throw Error('Shared bridge handshake timeout');
}
const operationId = suffix => {
  const stamp = Date.now().toString(16).padStart(12, '0');
  return `${stamp.slice(0, 8)}-${stamp.slice(8)}-7000-8000-${String(suffix).padStart(12, '0')}`;
};
try {
  const [a, b] = await Promise.all([start(), start()]);
  console.log('Shared bridge: concurrent adapters connected');
  assert.equal((await call(a, 'figma_get_context')).structuredContent.state, 'disconnected');
  assert.equal((await call(b, 'figma_get_context')).structuredContent.error.code, 'SESSION_BUSY');
  const keyPath = join(directory, 'pairing-secret.txt'), token = await readFile(keyPath, 'utf8');
  assert.ok(!a.diagnostics.includes(token) && !b.diagnostics.includes(token));

  const page = { id: '0:1', name: 'Page', type: 'PAGE', selection: [], children: [], async loadAsync() {}, on() {} };
  const output = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">' + ' '.repeat(90000) + '</svg>');
  const node = { id: 'n', name: 'Frame', type: 'FRAME', width: 10, height: 10, children: [], async exportAsync() { return output; } };
  const nodes = new Map([[page.id, page], [node.id, node]]);
  const figma = { root: { name: 'Shared test document', children: [page] }, currentPage: page, mixed: Symbol('mixed'),
    getNodeByIdAsync: async id => nodes.get(id) ?? null, base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    createPage() { const p = { id: 'new:' + ++count, name: '', type: 'PAGE', async loadAsync() {} }; nodes.set(p.id, p); return p; },
    commitUndo() {}, showUI() {}, clientStorage: { async getAsync() {}, async setAsync() {}, async deleteAsync() {} },
    ui: { postMessage(message) {
      if (message.type === 'yield' && holding && count >= 2) { heldYield = message; return; }
      queueMicrotask(() => ui.onmessage({ data: { pluginMessage: message } }));
    } } };
  runInNewContext(await readFile('dist/candidate/main.js', 'utf8'), { figma, __html__: '' });
  class Socket extends WebSocket { constructor() { super(`ws://127.0.0.1:${port}`); sockets.push(this); } }
  elements = createUIElements();
  const visibilityListeners = {};
  ui = { setTimeout, clearTimeout, document: { hidden: false, addEventListener(type, handler) { visibilityListeners[type] = handler; }, getElementById: id => elements[id] }, WebSocket: Socket,
    parent: { postMessage: ({ pluginMessage }) => queueMicrotask(() => figma.ui.onmessage(pluginMessage)) } };
  ui.window = ui; ui.addEventListener = () => {};
  const html = await readFile('dist/plugin/ui.html', 'utf8'); runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
  elements.secret.value = token; elements.connect.onclick();
  const context = await ready(a), scope = { sessionId: context.sessionId, connectionGeneration: context.connectionGeneration };
  await b.client.close(); await delay(30);
  assert.equal((await ready(a)).connectionGeneration, scope.connectionGeneration, 'non-owner close must preserve plugin');
  assert.equal(sockets.length, 1);
  const c = await start();
  console.log('Shared bridge: plugin ready; non-owner disconnect preserved binding');
  assert.equal((await call(c, 'figma_get_context')).structuredContent.error.code, 'SESSION_BUSY');
  const exported = (await call(a, 'figma_export_node', { scope, nodeId: node.id, format: 'SVG' })).structuredContent;
  assert.ok(exported.uri, JSON.stringify(exported));
  assert.deepEqual(Buffer.from((await a.client.readResource({ uri: exported.uri })).contents[0].blob, 'base64'), output);
  await assert.rejects(c.client.readResource({ uri: exported.uri }), /SESSION_BUSY/);

  // Pending unauthenticated pipes cannot displace authenticated MCP sessions.
  const unauthenticated = [];
  for (let i = 0; i < 4; i++) { const s = createConnection(path); s.on('error', () => {}); await once(s, 'connect'); unauthenticated.push(s); }
  const overflow = createConnection(path); overflow.on('error', () => {}); await once(overflow, 'connect'); const overflowClosed = once(overflow, 'close'); overflow.resume(); await overflowClosed;
  assert.equal((await ready(a)).state, 'ready'); for (const s of unauthenticated) s.destroy();

  elements.write.checked = true; elements.write.onchange();
  for (let i = 0; i < 50 && !(await ready(a)).writeEnabled; i++) await delay(10);
  ui.document.hidden = true; visibilityListeners.visibilitychange?.();
  const background = await ready(a);
  assert.equal(background.connectionGeneration, scope.connectionGeneration);
  assert.equal(background.writeEnabled, true);
  assert.equal(sockets.length, 1, 'backgrounding must not reconnect');
  const complete = await call(a, 'figma_apply_batch', { scope, operationId: operationId(1), steps: [{ stepId: 'first', op: 'createPage', name: 'Applied' }] });
  assert.equal(complete.structuredContent.status, 'succeeded'); assert.equal(count, 1);
  holding = true;
  const pendingId = operationId(2), queuedId = operationId(3);
  const pending = call(a, 'figma_apply_batch', { scope, operationId: pendingId, steps: [
    { stepId: 'partial', op: 'createPage', name: 'Partial' }, { stepId: 'later', op: 'createPage', name: 'Must not run' },
  ] }).catch(() => undefined);
  for (let i = 0; i < 100 && !heldYield; i++) await delay(10);
  assert.ok(heldYield); assert.equal(count, 2);
  const queued = call(a, 'figma_apply_batch', { scope, operationId: queuedId, steps: [{ stepId: 'queued', op: 'createPage', name: 'Must not run' }] }).catch(() => undefined);
  await delay(30);
  ui.document.hidden = false; visibilityListeners.visibilitychange?.();
  ui.document.hidden = true; visibilityListeners.visibilitychange?.();
  assert.equal((await call(a, 'figma_get_operation', { scope, operationId: pendingId })).structuredContent.status, 'running');
  assert.equal((await call(a, 'figma_get_operation', { scope, operationId: queuedId })).structuredContent.status, 'queued');
  process.kill(a.transport.pid, 'SIGKILL'); await Promise.all([pending, queued]);
  console.log('Shared bridge: owner killed during batch');
  const next = await ready(c), nextScope = { sessionId: next.sessionId, connectionGeneration: next.connectionGeneration };
  assert.notEqual(next.connectionGeneration, scope.connectionGeneration); assert.equal(next.writeEnabled, false);
  holding = false; ui.onmessage({ data: { pluginMessage: heldYield } }); await delay(50);
  assert.equal(count, 2, 'in-flight and queued background writes must stop on owner loss without replay');
  assert.equal((await call(c, 'figma_get_tree', { scope, rootId: page.id, depth: 1, limit: 10 })).structuredContent.error.code, 'SESSION_EXPIRED');
  await assert.rejects(c.client.readResource({ uri: exported.uri }), /RESOURCE_EXPIRED/);
  const tree = await call(c, 'figma_get_tree', { scope: nextScope, rootId: page.id, depth: 1, limit: 10 });
  assert.ok(!tree.isError, JSON.stringify(tree));
  await c.client.close();
  const d = await start(); await ready(d); await d.client.close();
  console.log('Shared bridge: ownership handed over after crash and EOF');
  const e = await start(); assert.equal((await ready(e)).writeEnabled, false);
  assert.equal((await readFile(keyPath, 'utf8')), token);

  const stopped = await run(['--stop-bridge']); assert.equal(stopped.code, 0, stopped.stderr); assert.equal(stopped.stdout, '');
  console.log('Shared bridge: explicit stop completed');
  assert.match(stopped.stderr, /мост остановлен/);
  assert.equal((await run(['--stop-bridge'])).code, 0);
  daemonPid = undefined;
  const restarted = await start(); await ready(restarted); assert.equal(await readFile(keyPath, 'utf8'), token);
  process.kill(daemonPid, 'SIGKILL'); await delay(50); daemonPid = undefined;
  console.log('Shared bridge: daemon crash');
  const afterCrash = await start(); await ready(afterCrash); assert.equal(count, 2);
  await afterCrash.client.close();
  assert.equal((await run(['--stop-bridge'])).code, 0); daemonPid = undefined;

  elements.disconnect.onclick();
  const blocker = createServer(socket => socket.destroy()); await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve));
  try {
    const failed = await run([]); assert.equal(failed.code, 1); assert.equal(failed.stdout, ''); assert.match(failed.stderr, /порт занят старым сервером/);
    assert.equal(blocker.listening, true, 'port owner must not be killed');
  } finally { await new Promise(resolve => blocker.close(resolve)); }
  // Failure to publish IPC must also release the already acquired Figma port.
  let occupiedIPC;
  if (process.platform === 'win32') {
    occupiedIPC = createServer(socket => socket.destroy()); await new Promise(resolve => occupiedIPC.listen(path, resolve));
  } else await writeFile(path, 'occupied', { flag: 'wx' });
  try {
    const failed = await run(['--bridge']); assert.equal(failed.code, 1); assert.equal(failed.stdout, '');
    const checkPort = createServer(); await new Promise(resolve => checkPort.listen(port, '127.0.0.1', resolve));
    await new Promise(resolve => checkPort.close(resolve));
  } finally {
    if (occupiedIPC) await new Promise(resolve => occupiedIPC.close(resolve)); else await unlink(path);
  }
  for (const [args, override] of [[['--unknown'], {}], [['--bridge', '--stop-bridge'], {}], [['--bridge'], { FIGMA_MCP_PORT: '0' }], [[], { FIGMA_MCP_PORT: '-1' }]]) {
    const result = await run(args, override); assert.equal(result.code, 1); assert.equal(result.stdout, '');
  }
  console.log('Shared bridge processes + plugin runtime: concurrent startup, ownership, export isolation, crash/EOF handover, no write replay, persistence, stop/restart and occupied port OK');
} catch (error) { console.error(error); throw error; }
finally {
  console.log('Shared bridge: cleaning up test processes');
  elements?.disconnect.onclick(); for (const socket of sockets) socket.terminate();
  for (const { client } of clients) await client.close().catch(() => {});
  const stopped = await run(['--stop-bridge']);
  if (stopped.code !== 0 && daemonPid) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
  await unlink(join(directory, 'pairing-secret.txt')); await rmdir(directory);
}
