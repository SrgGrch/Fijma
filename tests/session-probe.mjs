import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const messages = [];
let created = 0;
const figma = {
  fileKey: undefined,
  showUI() {},
  ui: { postMessage: message => messages.push(message) },
  createRectangle() { created++; return { resize() {} }; },
};
runInNewContext(await readFile('experiments/session-probe/main.js', 'utf8'), { figma, __html__: '' });
figma.ui.onmessage({ type: 'probe', sequence: 1 });
const session = messages.pop().session;
figma.ui.onmessage({ type: 'test-write', session: 'old-session' });
assert.equal(messages.pop().status, 'SESSION_EXPIRED');
assert.equal(created, 0);
figma.ui.onmessage({ type: 'test-write', session });
assert.equal(messages.pop().status, 'CREATED');
assert.equal(created, 1);
console.log('Диагностическая проверка сессии: OK');
