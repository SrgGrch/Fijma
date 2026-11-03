import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['plugin/resources.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { ResourcePager } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const limits = { maxDepth: 3, maxNodes: 10, maxResponseBytes: 1024, maxMessageBytes: 4096, resourceTtl: 1000 };
const scope = { sessionId: 's', connectionGeneration: 1 };
const mixed = Symbol('mixed');
const variables = [
  { id: 'v1', name: 'Color', resolvedType: 'COLOR', variableCollectionId: 'c', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'v2' } } },
  { id: 'v2', name: 'Base', resolvedType: 'COLOR', variableCollectionId: 'c', valuesByMode: { m: { r: 1, g: 0, b: 0 } } },
];
const component = { id: 'c1', name: 'Button', type: 'COMPONENT', description: '', key: 'key', remote: false };
const page = { id: 'p1', name: 'Page', type: 'PAGE', children: [component] };
const api = { mixed, root: { children: [page] }, variables: { getLocalVariablesAsync: async () => variables },
  getNodeByIdAsync: async id => id === 'c1' ? component : null };
const pager = new ResourcePager(limits);
let revision = '0', loads = 0;
const read = query => pager.read(api, query, scope, 0, () => revision, async () => { loads++; }, async () => {});
const query = { kind: 'variables', fields: ['name', 'type', 'collectionId', 'valuesByMode'], limit: 1 };
const first = await read(query);
assert.equal(first.resources[0].properties.valuesByMode.m.id, 'v2');
assert.ok(first.nextCursor);
await assert.rejects(read({ ...query, fields: ['name'], cursor: first.nextCursor }), /INVALID_CURSOR/);
const second = await read({ ...query, cursor: first.nextCursor });
assert.equal(second.resources[0].id, 'v2');
assert.equal(second.truncated, false);
const beforeChange = await read(query);
variables[1].name = 'Changed';
await assert.rejects(read({ ...query, cursor: beforeChange.nextCursor }), /INVALID_CURSOR/);
const components = await read({ kind: 'components', fields: ['name', 'remote'], limit: 5 });
assert.equal(components.resources[0].id, 'c1');
assert.equal(components.resources[0].properties.remote, false);
assert.equal(loads, 1);
const tiny = new ResourcePager({ ...limits, maxMessageBytes: 20 });
await assert.rejects(tiny.read(api, query, scope, 0, () => '0', async () => {}, async () => {}), /RESOURCE_LIMIT/);
const stylesApi = { ...api, getLocalPaintStylesAsync: async () => [{ id: 's1', name: 'Fill', type: 'PAINT', paints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] }],
  getLocalTextStylesAsync: async () => [], getLocalEffectStylesAsync: async () => [], getLocalGridStylesAsync: async () => [] };
const styles = await pager.read(stylesApi, { kind: 'styles', fields: ['name', 'type', 'value'], limit: 5 }, scope, 0, () => revision, async () => {}, async () => {});
assert.equal(styles.resources[0].properties.value.paints[0].color.r, 1);
console.log('Локальные ресурсы: значения, aliases, компоненты, cursor и ограничение состояния — OK');
