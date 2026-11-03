import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile('experiments/resources-probe/main.js', 'utf8');
for (const modeFails of [false, true]) {
  const created = [], removed = [], messages = [];
  const resource = (fields = {}) => {
    const item = { id: String(created.length), ...fields, remove() { removed.push(this.id); } };
    created.push(item);
    return item;
  };
  const variables = [];
  const collection = () => resource({
    defaultModeId: 'default', modes: [{ modeId: 'default', name: 'Default' }],
    addMode(name) {
      if (modeFails) throw new Error('Mode limit reached');
      this.modes.push({ modeId: 'second', name });
      return 'second';
    },
  });
  let currentCollection;
  const figma = {
    showUI() {}, ui: { postMessage: value => messages.push(value) },
    createComponent: () => resource({ createInstance: () => resource({ type: 'INSTANCE' }) }),
    createRectangle: () => resource({ boundVariables: {}, setBoundVariable(field, value) {
      if (value) this.boundVariables[field] = { type: 'VARIABLE_ALIAS', id: value.id };
      else delete this.boundVariables[field];
    } }),
    variables: {
      createVariableCollection() { return currentCollection = collection(); },
      createVariable() {
        const value = resource({ valuesByMode: {}, setValueForMode(mode, v) { this.valuesByMode[mode] = v; } });
        variables.push(value);
        return value;
      },
      createVariableAlias: value => ({ type: 'VARIABLE_ALIAS', id: value.id }),
      getLocalVariableCollectionsAsync: async () => [currentCollection],
      getLocalVariablesAsync: async () => variables,
    },
  };
  for (const kind of ['Paint', 'Text', 'Effect', 'Grid']) {
    let style;
    figma[`create${kind}Style`] = () => style = resource({ type: kind.toUpperCase() });
    figma[`getLocal${kind}StylesAsync`] = async () => [style];
  }
  runInNewContext(source, { figma, __html__: '' });
  await figma.ui.onmessage({ type: 'unknown' });
  assert.equal(created.length, 0);
  await figma.ui.onmessage({ type: 'probe' });
  assert.deepEqual(removed, created.map(item => item.id).reverse());
  const results = messages.find(message => message.type === 'report').results;
  assert.equal(results.find(item => item.action === 'mode/add').ok, !modeFails);
  assert.equal(results.find(item => item.action === 'variables').ok, true);
  assert.equal(results.find(item => item.action === 'binding').ok, true);
  assert.equal(results.filter(item => !item.ok).length, modeFails ? 1 : 0);
}
console.log('Локальные ресурсы: успех, отказ режима и очистка — OK');

const html = await readFile('experiments/resources-probe/ui.html', 'utf8');
const elements = Object.fromEntries(['probe', 'status', 'report'].map(id => [id, { textContent: '', value: '', disabled: false }]));
const parent = { postMessage() {} };
let timeoutCallback;
const ui = {
  document: { getElementById: id => elements[id] }, parent,
  setTimeout(callback) { timeoutCallback = callback; return 1; },
  clearTimeout() { timeoutCallback = null; },
};
runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
elements.probe.onclick();
assert.equal(elements.probe.disabled, true);
ui.onmessage({ source: null, data: { pluginMessage: { type: 'progress', action: 'style/Paint' } } });
assert.match(elements.status.textContent, /style\/Paint/);
timeoutCallback();
assert.match(elements.status.textContent, /30/);
ui.onmessage({ source: null, data: { pluginMessage: { type: 'report', results: [] } } });
assert.equal(elements.report.value, '[]');
assert.equal(elements.probe.disabled, false);
assert.equal(timeoutCallback, null);
ui.onmessage({ data: null });
console.log('UI: progress/report без source parent и таймаут — OK');
