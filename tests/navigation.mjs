import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['plugin/navigation.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { navigate } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
let loads = [], revealed = [], switches = [];
const page = id => ({ id, type: 'PAGE', selection: [], async loadAsync() { loads.push(id); } });
const first = page('p1'), second = page('p2');
const selected = { id: 'a', type: 'RECTANGLE', parent: first }, target = { id: 'b', type: 'TEXT', parent: second };
first.selection = [selected];
const api = { root: { children: [first, second] }, currentPage: first,
  getNodeByIdAsync: async id => ({ a: selected, b: target, p2: second })[id] ?? null,
  async setCurrentPageAsync(next) { switches.push(next.id); this.currentPage = next; },
  viewport: { scrollAndZoomIntoView(nodes) { revealed.push(nodes.map(node => node.id)); } } };
const live = () => {};
await assert.rejects(navigate(api, { pageId: 'p1', nodeIds: ['b'], select: true, reveal: true }, live), /INVALID_ARGUMENT/);
await assert.rejects(navigate(api, { nodeIds: ['a', 'b'], select: true, reveal: true }, live), /INVALID_ARGUMENT/);
await assert.rejects(navigate(api, { nodeIds: ['missing'], select: true, reveal: true }, live), /NODE_NOT_FOUND/);
await assert.rejects(navigate(api, { nodeIds: ['p2'], select: true, reveal: false }, live), /INVALID_ARGUMENT/);
assert.equal(api.currentPage, first);
assert.deepEqual(first.selection, [selected]);
assert.deepEqual(revealed, []);
const result = await navigate(api, { nodeIds: ['b'], select: true, reveal: true }, live);
assert.deepEqual(result, { currentPageId: 'p2', selection: ['b'] });
assert.deepEqual(loads, ['p2']);
assert.deepEqual(switches, ['p2']);
assert.deepEqual(revealed, [['b']]);
const noSelectionChange = await navigate(api, { pageId: 'p2', nodeIds: [], select: false, reveal: false }, live);
assert.deepEqual(noSelectionChange.selection, ['b']);
await navigate(api, { pageId: 'p2', nodeIds: [], select: true, reveal: false }, live);
assert.deepEqual(second.selection, []);
let count = 0;
await assert.rejects(navigate(api, { nodeIds: ['a'], select: true, reveal: true }, () => { if (++count === 2) throw new Error('SESSION_EXPIRED'); }), /SESSION_EXPIRED/);
assert.equal(api.currentPage, second);
assert.deepEqual(revealed, [['b']]);
console.log('Навигация: целевая страница, selection/viewport, preflight и устаревшая сессия — OK');
