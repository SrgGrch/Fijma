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

// A catalogue may be larger than the wire limit; only the requested page is projected.
let conversions = 0;
const many = Array.from({ length: 700 }, (_, i) => ({ id: `v${i}`, name: `Variable ${i}`, resolvedType: 'FLOAT',
  variableCollectionId: 'c', valuesByMode: { m: i }, get description() { return { toJSON() { conversions++; return 'description'; } }; } }));
const largeApi = { ...api, variables: { getLocalVariablesAsync: async () => many } };
const largePager = new ResourcePager({ ...limits, maxMessageBytes: 4096 });
const largeQuery = { kind: 'variables', fields: ['name'], limit: 1 };
const largeRead = query => largePager.read(largeApi, query, scope, 0, () => '0', async () => {}, async () => {});
const largeFirst = await largeRead(largeQuery);
assert.equal(largeFirst.resources[0].id, 'v0');
assert.equal(conversions, 0); // Unrequested fields are neither fingerprinted nor projected.
const valueQuery = { ...largeQuery, fields: ['valuesByMode'] };
const valueFirst = await largeRead(valueQuery);
many[699].valuesByMode.m = 999;
await assert.rejects(largeRead({ ...valueQuery, cursor: valueFirst.nextCursor }), /INVALID_CURSOR/);
assert.equal((await largeRead({ ...largeQuery, cursor: largeFirst.nextCursor })).resources[0].id, 'v1');

const componentNodes = Array.from({ length: 100 }, (_, i) => ({ id: `component${i}`, name: `Component ${i}`, type: 'COMPONENT', remote: false }));
const componentMap = new Map(componentNodes.map(node => [node.id, node]));
let lookups = 0, pageLoads = 0;
const manyApi = { ...api, root: { children: [{ id: 'page', name: 'Page', type: 'PAGE', children: componentNodes }] },
  getNodeByIdAsync: async id => { lookups++; return componentMap.get(id) ?? null; } };
const manyPager = new ResourcePager({ ...limits, maxNodes: 150, maxResponseBytes: 4000 });
const componentQuery = { kind: 'components', fields: ['name'], limit: 100 };
const manyRead = query => manyPager.read(manyApi, query, scope, 0, () => '0', async () => { pageLoads++; }, async () => {});
let calls = 1;
let result = await manyRead(componentQuery);
const seen = [...result.resources.map(row => row.id)];
while (result.nextCursor) { calls++; result = await manyRead({ ...componentQuery, cursor: result.nextCursor }); seen.push(...result.resources.map(row => row.id)); }
assert.deepEqual(seen, componentNodes.map(node => node.id));
assert.ok(lookups <= 102);
assert.ok(calls <= 6, `unexpected call count: ${calls}`);
assert.equal(pageLoads, 1);
lookups = 0; pageLoads = 0;
const byId = await manyRead({ ...componentQuery, ids: ['component99'] });
assert.deepEqual(byId.resources.map(row => row.id), ['component99']);
assert.equal(lookups, 1);
assert.equal(pageLoads, 0);
componentMap.set('remote', { id: 'remote', type: 'COMPONENT', remote: true });
componentMap.set('frame', { id: 'frame', type: 'FRAME', remote: false });
const filteredIds = await manyRead({ ...componentQuery, ids: ['remote', 'frame', 'missing', 'component99'] });
assert.deepEqual(filteredIds.resources.map(row => row.id), ['component99']);




const spaciousPager = new ResourcePager({ ...limits, maxNodes: 150, maxResponseBytes: 40000, maxMessageBytes: 40000 });
let yields = 0;
const spacious = await spaciousPager.read(manyApi, componentQuery, scope, 0, () => '0', async () => {}, async () => { yields++; });
assert.equal(spacious.resources.length, 100);
assert.ok(yields >= 3); // Two search yields and one while projecting the page.

const timedNodes = componentNodes.map(node => ({ ...node, description: 'x'.repeat(400) }));
const timedMap = new Map(timedNodes.map(node => [node.id, node]));
const timedApi = { ...manyApi, root: { children: [{ id: 'page', name: 'Page', type: 'PAGE', children: timedNodes }] },
  getNodeByIdAsync: async id => timedMap.get(id) ?? null };
const timedPager = new ResourcePager({ ...limits, maxNodes: 150, maxResponseBytes: 4000 });
const timedQuery = { ...componentQuery, fields: ['name', 'description'] };
let now = 0, timedRevision = '0';
const timedRead = query => timedPager.read(timedApi, query, scope, now, () => timedRevision, async () => {}, async () => {});
let timed = await timedRead(timedQuery);
const timedSeen = [...timed.resources.map(row => row.id)];
while (timed.nextCursor) {
  now += 900;
  timed = await timedRead({ ...timedQuery, cursor: timed.nextCursor });
  timedSeen.push(...timed.resources.map(row => row.id));
}
assert.ok(now > limits.resourceTtl * 3);
assert.deepEqual(timedSeen, timedNodes.map(node => node.id));
const expiring = await timedRead(timedQuery);
now += limits.resourceTtl;
await assert.rejects(timedRead({ ...timedQuery, cursor: expiring.nextCursor }), /INVALID_CURSOR/);
const changing = await timedRead(timedQuery);
timedRevision = '1';
await assert.rejects(timedRead({ ...timedQuery, cursor: changing.nextCursor }), /INVALID_CURSOR/);
console.log('Resource pagination and lookup: OK');
