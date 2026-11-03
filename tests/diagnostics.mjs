import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const html = await readFile('experiments/diagnostics/ui.html', 'utf8');
for (const manual of [false, true]) {
  const elements = Object.fromEntries(['run', 'stop', 'status', 'report'].map(id => [id, {}]));
  const sent = [], timers = new Map();
  let timerId = 0;
  const ui = {
    document: { getElementById: id => elements[id] },
    parent: { postMessage: message => sent.push(message.pluginMessage) },
    performance: { now: () => 1000 },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
  const receive = message => ui.onmessage({ data: { pluginMessage: message } });
  receive({ type: 'yield', id: 1 });
  assert.equal(sent.pop().id, 1);
  const tick = ms => {
    const [id, timer] = [...timers].find(([, value]) => value.ms === ms);
    timers.delete(id); timer.fn();
  };
  elements.run.onclick();
  assert.equal(sent.at(-1).suite, 'resources');
  elements.run.onclick();
  assert.equal(sent.length, 1);
  receive({ type: 'report', results: [{ action: 'resources', ok: true }] });
  tick(0);
  assert.equal(sent.at(-1).suite, 'limits');
  if (manual) {
    elements.stop.onclick();
    assert.equal(sent.at(-1).type, 'stop');
    receive({ type: 'report', report: { cleanup: 'removed' } }); tick(0);
    assert.equal(elements.run.disabled, false);
    assert.equal(sent.length, 3);
    continue;
  }
  receive({ type: 'report', report: { read: { count: 1000 } } }); tick(0);
  receive({ type: 'progress', action: 'fixture' });
  tick(500);
  assert.equal(sent.at(-1).type, 'stop');
  receive({ type: 'report', report: { stop: {}, cleanup: 'removed' } }); tick(0);
  const report = JSON.parse(elements.report.value);
  assert.equal(report.resources.length, 1);
  assert.equal(report.limits.read.count, 1000);
  assert.equal(report.stop.uiStopRoundTripMs, 0);
  assert.equal(elements.run.disabled, false);
  assert.equal(timers.size, 0);
}
console.log('Единая диагностика: последовательность, общий отчёт, авто-Stop и ручной Stop — OK');
