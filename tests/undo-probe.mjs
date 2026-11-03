import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const markers = [], messages = [];
let commits = 0;
const figma = {
  showUI() {}, ui: { postMessage: m => messages.push(m) },
  createRectangle() { const node = { resize() {} }; markers.push(node); return node; },
  commitUndo() { commits++; },
};
runInNewContext(await readFile('experiments/undo-probe/main.js', 'utf8'), { figma, __html__: '' });
for (const type of ['batch-a', 'batch-b', 'partial']) figma.ui.onmessage({ type });
figma.ui.onmessage({ type: 'unknown' });
assert.equal(markers.length, 3);
assert.equal(commits, 3);
assert.equal(messages[2].partial, true);
console.log('Диагностические действия Undo: OK');
