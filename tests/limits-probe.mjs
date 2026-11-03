import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile('experiments/limits-probe/main.js', 'utf8');
for (const scenario of ['success', 'stop', 'export-error']) {
  const messages = [];
  let removed = false, exports = 0, selectedPageLoads = 0;
  const frame = {
    id: '1:1', type: 'FRAME', name: '', children: [],
    resize() {}, appendChild(node) { this.children.push(node); },
    remove() { removed = true; },
    async exportAsync() {
      exports++;
      if (scenario === 'export-error') throw new Error('export failed');
      return new Uint8Array([1, 2, 3]);
    },
  };
  const figma = {
    showUI() {}, ui: { postMessage: message => {
      messages.push(message);
      if (message.type === 'yield') queueMicrotask(() => {
        time += 5;
        if (scenario === 'stop' && !stopped) {
          stopped = true;
          figma.ui.onmessage({ type: 'stop' });
        }
        figma.ui.onmessage({ type: 'yield', id: message.id + 1 });
        figma.ui.onmessage({ type: 'yield', id: message.id });
      });
    } },
    currentPage: { async loadAsync() { selectedPageLoads++; } },
    createFrame: () => frame,
    createRectangle: () => ({ id: `1:${frame.children.length + 2}`, name: 'Rectangle', type: 'RECTANGLE', resize() {} }),
  };
  let stopped = false;
  let time = 0;
  runInNewContext(source, { figma, __html__: '', Date: { now: () => time }, setTimeout() { throw new Error('Unexpected timer'); } });
  await figma.ui.onmessage({ type: 'measure' });
  const report = messages.find(message => message.type === 'report').report;
  assert.equal(removed, true);
  assert.equal(selectedPageLoads, 1);
  assert.equal(report.cleanup, 'removed');
  if (scenario === 'stop') {
    assert.equal(exports, 0);
    assert.equal(report.fixture.count, 50);
    assert.ok(report.stop);
  } else {
    assert.equal(report.fixture.count, 5000);
    assert.equal(report.read.count, 1000);
    assert.equal(report.read.truncated, true);
    assert.equal(report.read.yields, 20);
    assert.equal(report.read.yieldMs, 100);
    assert.equal(report.read.workMs, 0);
    assert.equal(Object.values(report.boundaries).every(value => value === true), true);
    if (scenario === 'export-error') assert.match(report.error, /export failed/);
    else assert.equal(report.export.bytes, 3);
  }
}
console.log('Стенд лимитов: чтение, stop, ошибка экспорта и очистка — OK');
