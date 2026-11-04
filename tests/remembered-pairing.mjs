import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdtemp, mkdir, writeFile, unlink, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createUIElements } from './ui-elements.mjs';

await build({ entryPoints: ['server/pairing-file.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/test-support/remembered-pairing.mjs' });
const { createPairingFile } = await import('../dist/test-support/remembered-pairing.mjs');
const directory = await mkdtemp(join(tmpdir(), 'figma-remembered-test-'));
const savedDirectory = join(directory, 'credentials');
let first;
try {
  first = await createPairingFile(savedDirectory);
  await first.dispose();
  assert.equal(await readFile(first.path, 'utf8'), first.secret);
  const second = await createPairingFile(savedDirectory);
  assert.equal(second.secret, first.secret, 'server restart reuses the key');
  assert.equal(second.path, first.path);
  if (process.platform === 'win32') {
    const acl = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$acl = [System.IO.File]::GetAccessControl($env:FIGMA_TEST_ACL_PATH); $rules = $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); @{protected=$acl.AreAccessRulesProtected; identities=@($rules | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress'],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, FIGMA_TEST_ACL_PATH: first.path } }));
    assert.equal(acl.protected, true); assert.equal(acl.identities.length, 1);
  } else {
    assert.equal((await stat(savedDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  }
  await writeFile(first.path, 'invalid');
  await assert.rejects(createPairingFile(savedDirectory), /PAIRING_FILE_UNAVAILABLE/);
  assert.equal(await readFile(first.path, 'utf8'), 'invalid', 'bad persistent files are not silently replaced');
  await unlink(first.path);
  await mkdir(first.path);
  await assert.rejects(createPairingFile(savedDirectory), /PAIRING_FILE_UNAVAILABLE/);
  await rmdir(first.path);
} finally {
  await unlink(join(savedDirectory, 'pairing-secret.txt')).catch(() => {});
  await rmdir(savedDirectory); await rmdir(directory);
}

const mainScript = await readFile('dist/plugin/main.js', 'utf8');
const key = 'bridge-pairing-v1', token = 'a'.repeat(64), otherToken = 'b'.repeat(64);
const settle = () => new Promise(resolve => setImmediate(resolve));
function mainStorage(store, broken = false) {
  const messages = [];
  const figma = {
    root: { name: 'Test', children: [] }, currentPage: { id: 'p', selection: [] }, showUI() {},
    ui: { postMessage: message => messages.push(message) },
    clientStorage: {
      async getAsync(k) { if (broken) throw Error('private data'); return store.get(k); },
      async setAsync(k, v) { if (broken) throw Error('private data'); store.set(k, v); },
      async deleteAsync(k) { if (broken) throw Error('private data'); store.delete(k); },
    },
  };
  runInNewContext(mainScript, { figma, __html__: '' });
  return { messages, send: figma.ui.onmessage };
}
{
  const store = new Map(), main = mainStorage(store);
  main.send({ type: 'pairing-save', secret: token, extra: true });
  main.send({ type: 'pairing-save', secret: 'bad' }); await settle();
  assert.equal(store.size, 0); assert.equal(main.messages.length, 0);
  main.send({ type: 'pairing-save', secret: token }); await settle();
  assert.equal(store.get(key), token); assert.equal(main.messages.at(-1).type, 'pairing-saved');
  const restarted = mainStorage(store);
  restarted.send({ type: 'pairing-load' }); await settle();
  assert.equal(restarted.messages.at(-1).secret, token);
  restarted.send({ type: 'pairing-save', secret: otherToken }); restarted.send({ type: 'pairing-forget' }); restarted.send({ type: 'pairing-load' }); await settle();
  assert.equal(store.size, 0); assert.equal(restarted.messages.at(-1).secret, undefined);
  store.set(key, { secret: token }); restarted.send({ type: 'pairing-load' }); await settle();
  assert.equal(restarted.messages.at(-1).secret, undefined);
  const broken = mainStorage(store, true);
  for (const message of [{ type: 'pairing-load' }, { type: 'pairing-save', secret: token }, { type: 'pairing-forget' }]) broken.send(message);
  await settle();
  assert.equal(broken.messages.length, 3);
  assert.ok(broken.messages.every(message => message.type === 'pairing-error'));
  assert.ok(!JSON.stringify(broken.messages).includes('private data'));
}

const uiBuild = await build({ entryPoints: ['plugin/ui.ts'], bundle: true, platform: 'browser', write: false });
const limitsBuild = await build({ entryPoints: ['shared/bootstrap-limits.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { bootstrapLimits } = await import('data:text/javascript;base64,' + Buffer.from(limitsBuild.outputFiles[0].text).toString('base64'));
function uiFixture() {
  const elements = createUIElements(), messages = [], sockets = [], timers = new Map(), listeners = {}, windowListeners = {};
  let timerId = 0;
  class Socket {
    static OPEN = 1; readyState = 1; sent = [];
    constructor() { sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  const document = { hidden: false, getElementById: id => elements[id], addEventListener: (type, callback) => { listeners[type] = callback; } };
  const ui = { document, WebSocket: Socket, parent: { postMessage: ({ pluginMessage }) => messages.push(pluginMessage) },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  ui.window = { addEventListener: (type, callback) => { windowListeners[type] = callback; } };
  runInNewContext(uiBuild.outputFiles[0].text, ui);
  const fromMain = message => ui.onmessage({ data: { pluginMessage: message } });
  const bind = (socket = sockets.at(-1), generation = 1) => {
    socket.onopen(); socket.onmessage({ data: JSON.stringify({ type: 'paired' }) });
    const hello = { type: 'hello', protocolVersion: 1, sessionId: 's', capabilities: ['getContext', 'applyBatch'], limits: bootstrapLimits, writeEnabled: false };
    fromMain(hello);
    socket.onmessage({ data: JSON.stringify({ ...hello, type: 'welcome', connectionGeneration: generation }) });
    fromMain({ type: 'bound', sessionId: 's', connectionGeneration: generation, documentLabel: '<Untrusted>', writeEnabled: false, message: 'Ready' });
  };
  const fireTimer = () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); };
  return { elements, messages, sockets, timers, listeners, windowListeners, document, fromMain, bind, fireTimer, ui };
}
{
  const h = uiFixture();
  assert.equal(h.messages[0].type, 'pairing-load'); assert.equal(h.sockets.length, 0);
  h.elements.secret.value = token; h.elements.connect.onclick();
  assert.equal(h.elements.secret.value, ''); assert.ok(h.elements.write.disabled);
  assert.ok(!h.messages.some(message => message.type === 'pairing-save'));
  h.bind(); assert.equal(h.messages.at(-1).type, 'pairing-save');
  assert.equal(h.elements.document.textContent, '<Untrusted>');
  h.fromMain({ type: 'pairing-saved' });
  assert.equal(h.elements['storage-status'].textContent, 'Сопряжение сохранено');
  const first = h.sockets[0]; first.onclose({ reason: '' });
  assert.equal(h.timers.size, 1); assert.equal(h.elements.write.checked, false);
  assert.equal(h.elements.workspace.hidden, true);
  h.fireTimer(); assert.equal(h.sockets.length, 2);
  h.bind(undefined, 2); assert.equal(h.elements.write.checked, false);
  assert.equal(h.messages.filter(message => message.type === 'pairing-save').length, 1);
  assert.equal(h.sockets[1].sent[0].secret, token);
  h.elements.disconnect.onclick(); assert.equal(h.timers.size, 0);
  h.document.hidden = true; h.listeners.visibilitychange(); h.document.hidden = false; h.listeners.visibilitychange();
  assert.equal(h.sockets.length, 2, 'manual disconnect stays paused on visibility changes');
  h.elements.resume.onclick(); assert.equal(h.sockets.length, 3);
  h.sockets.at(-1).onclose({ reason: 'SESSION_BUSY' }); assert.equal(h.timers.size, 0);
  assert.match(h.elements['connection-help'].textContent, /занят/);
  h.elements.forget.onclick(); assert.equal(h.messages.at(-1).type, 'pairing-forget');
  h.fromMain({ type: 'pairing-forgotten' }); assert.equal(h.elements['pairing-panel'].hidden, false);
  h.fromMain({ type: 'pairing-loaded', secret: token }); assert.equal(h.sockets.length, 3, 'late load cannot undo Forget');
}
{
  const h = uiFixture(); h.fromMain({ type: 'pairing-loaded', secret: token });
  assert.equal(h.sockets.length, 1); h.bind();
  assert.ok(!h.messages.some(message => message.type === 'pairing-save'));
  h.document.hidden = true; h.listeners.visibilitychange(); assert.equal(h.sockets[0].readyState, 3);
  h.document.hidden = false; h.listeners.visibilitychange(); assert.equal(h.sockets.length, 2);
  h.sockets.at(-1).onclose({ reason: 'AUTH_FAILED' }); assert.equal(h.timers.size, 0);
  assert.equal(h.messages.at(-1).type, 'pairing-forget');
  assert.equal(h.elements['pairing-panel'].hidden, false);
}
{
  const h = uiFixture(); h.document.hidden = true; h.fromMain({ type: 'pairing-loaded', secret: token });
  assert.equal(h.sockets.length, 0);
  h.document.hidden = false; h.listeners.visibilitychange(); h.sockets[0].onclose({ reason: '' });
  h.windowListeners.pagehide(); assert.equal(h.timers.size, 0);
}
{
  const h = uiFixture(); h.fromMain({ type: 'pairing-loaded', secret: 'invalid' }); assert.equal(h.sockets.length, 0);
  h.elements.secret.value = token; h.elements.connect.onclick();
  h.fromMain({ type: 'pairing-loaded', secret: otherToken });
  h.bind(); assert.equal(h.sockets[0].sent[0].secret, token);
  h.fromMain({ type: 'pairing-error', action: 'save' });
  assert.match(h.elements['last-error'].textContent, /не сохранено/);
  h.elements.forget.onclick(); h.fromMain({ type: 'pairing-error', action: 'forget' });
  assert.equal(h.elements.remembered.hidden, false); assert.equal(h.elements.forget.disabled, false);
}
console.log('Remembered pairing: persistent protected server key, main storage, auto-connect/retry, visibility, busy/auth failures, Forget and storage errors OK');
