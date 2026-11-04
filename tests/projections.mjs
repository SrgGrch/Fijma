import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['plugin/projections.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { projectNode, projectResource, readNodes } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const mixed = Symbol('mixed');
const segments = [{ start: 0, end: 2, characters: 'Hi', fontName: { family: 'Inter', style: 'Regular' }, textStyleId: 'text-style', fillStyleId: 'fill-style', boundVariables: { fontSize: { type: 'VARIABLE_ALIAS', id: 'v' } } }];
const node = { id: '1:1', type: 'TEXT', name: 'Text', visible: false, locked: true, fontName: mixed,
  parent: { id: '0:1' }, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, blendMode: 'NORMAL', boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'v' } } }],
  boundVariables: { fontSize: [{ type: 'VARIABLE_ALIAS', id: 'v' }] }, getStyledTextSegments: fields => { assert(fields.includes('fillStyleId')); return segments; } };
const projection = projectNode(node, ['name', 'visible', 'locked', 'fontName', 'parentId', 'fills', 'boundVariables', 'textSegments', 'width'], mixed);
assert.deepEqual(projection.mixed, ['fontName']);
assert.deepEqual(projection.unavailable, ['width']);
assert.equal(projection.properties.visible, false);
assert.equal(projection.properties.locked, true);
assert.equal(projection.properties.parentId, '0:1');
assert.deepEqual(projection.properties.fills, node.fills);
assert.deepEqual(projection.properties.boundVariables, node.boundVariables);
assert.deepEqual(projection.properties.textSegments, segments);
const layoutNode = { id: 'frame', type: 'FRAME', layoutMode: 'HORIZONTAL', layoutWrap: 'NO_WRAP', counterAxisSpacing: null,
  constraints: { horizontal: 'MIN', vertical: 'MAX' }, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG' };
assert.deepEqual(projectNode(layoutNode, ['layout', 'constraints', 'layoutSizingHorizontal', 'layoutSizingVertical'], mixed).properties,
  { layout: { layoutMode: 'HORIZONTAL', layoutWrap: 'NO_WRAP', counterAxisSpacing: null }, constraints: layoutNode.constraints, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG' });
const unsupported = projectNode({ id: '2:1', type: 'RECTANGLE', fills: [{ type: 'SHADER', id: 'shader' }] }, ['fills', 'characters'], mixed);
assert.deepEqual(unsupported.unavailable, ['fills', 'characters']);
assert.deepEqual(unsupported.properties, {});
const variable = { id: 'v', resolvedType: 'COLOR', variableCollectionId: 'c', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'other' } } };
assert.deepEqual(projectResource('variables', variable, ['type', 'collectionId', 'valuesByMode'], mixed).properties,
  { type: 'COLOR', collectionId: 'c', valuesByMode: variable.valuesByMode });
const style = { id: 's', type: 'PAINT', paints: node.fills };
assert.deepEqual(projectResource('styles', style, ['type', 'value'], mixed).properties, { type: 'PAINT', value: { paints: node.fills } });
const api = { mixed, getNodeByIdAsync: async id => id === '1:1' ? node : null };
const result = await readNodes(api, ['1:1', 'missing'], ['name', 'visible'], 10, 32768);
assert.equal(result.nodes[1].error.code, 'NODE_NOT_FOUND');
assert.equal(result.nodes[0].properties.visible, false);
await assert.rejects(readNodes(api, ['1:1', 'missing'], ['name'], 1, 32768), /RESOURCE_LIMIT/);
await assert.rejects(readNodes(api, ['1:1'], ['name'], 10, 256), /RESOURCE_LIMIT/);
const instance = { id: 'i', type: 'INSTANCE', componentProperties: { label: { type: 'TEXT', value: 'Hello' } },
  getMainComponentAsync: async () => ({ id: 'remote-id', key: 'remote-key', remote: true }) };
const linked = await readNodes({ mixed, getNodeByIdAsync: async () => instance }, ['i'], ['mainComponent', 'componentProperties'], 10, 32768);
assert.deepEqual(linked.nodes[0].properties.mainComponent, { id: 'remote-id', key: 'remote-key', remote: true });
assert.equal(linked.nodes[0].properties.componentProperties.label.value, 'Hello');
const component = { id: 'c', type: 'COMPONENT', parent: { id: 'set', type: 'COMPONENT_SET', key: 'set-key', remote: false } };
assert.deepEqual(projectResource('components', component, ['componentSet'], mixed).properties.componentSet, { id: 'set', key: 'set-key', remote: false });
const missingLink = await readNodes({ mixed, getNodeByIdAsync: async () => ({ ...instance, getMainComponentAsync: async () => null }) }, ['i'], ['mainComponent'], 10, 32768);
assert.equal(missingLink.nodes[0].properties.mainComponent, null);
const failedLink = await readNodes({ mixed, getNodeByIdAsync: async () => ({ ...instance, getMainComponentAsync: async () => { throw new Error('unavailable'); } }) }, ['i'], ['mainComponent'], 10, 32768);
assert.deepEqual(failedLink.nodes[0].unavailable, ['mainComponent']);
let pageLoaded = false;
const selection = [{ id: 'selected' }];
const currentPage = { id: 'current', selection };
const page = { id: 'page', type: 'PAGE', async loadAsync() { pageLoaded = true; },
  get children() { if (!pageLoaded) throw new Error('Page not loaded'); return [{ id: 'a' }, { id: 'b' }]; } };
const pageApi = { mixed, currentPage, getNodeByIdAsync: async () => page };
const pageResult = await readNodes(pageApi, ['page'], ['children'], 10, 32768);
assert.deepEqual(pageResult.nodes[0].properties.children, ['a', 'b']);
assert.equal(pageApi.currentPage, currentPage);
assert.equal(pageApi.currentPage.selection, selection);
const grids = [{ pattern: 'GRID', sectionSize: 8 }, { pattern: 'ROWS', alignment: 'STRETCH', gutterSize: 4, count: 12 }, { pattern: 'COLUMNS', alignment: 'CENTER', gutterSize: 6, count: 4, sectionSize: 20, offset: 2 }];
const gridNode = { id: 'grid', type: 'FRAME', gridStyleId: 'S:grid', layoutGrids: grids };
const gridResult = await readNodes({ mixed, getNodeByIdAsync: async () => gridNode }, ['grid'], ['gridStyleId', 'layoutGrids'], 10, 32768);
assert.deepEqual(gridResult.nodes[0].properties, { gridStyleId: 'S:grid', layoutGrids: grids });
console.log('Проекции: mixed, unavailable, связи, скрытие, блокировка, сегменты и локальные ресурсы — OK');
