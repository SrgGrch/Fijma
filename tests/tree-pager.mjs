import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['shared/tree-pager.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { TreePager, SearchPager } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const limits = { maxDepth: 8, maxNodes: 1000, maxResponseBytes: 262144, chunkSize: 50 };
const root = { id: 'root', name: 'Root', type: 'FRAME', children: Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: 'Node', type: 'RECTANGLE' })) };
const scope = { sessionId: 'session', connectionGeneration: 1 };
const query = { rootId: 'root', depth: 1, limit: 10 };
const pager = new TreePager(limits, 5, 1000);
let revision = 0;
let cursor, ids = [];
do {
  const result = await pager.read(root, { ...query, cursor }, scope, () => revision, 0);
  ids.push(...result.nodes.map(node => node.nodeId)); cursor = result.nextCursor;
} while (cursor);
assert.equal(ids.length, 101);
assert.equal(new Set(ids).size, 101);
const first = await pager.read(root, query, scope, () => revision, 0);
await assert.rejects(pager.read(root, { ...query, cursor: first.nextCursor }, { ...scope, sessionId: 'other' }, () => revision, 0), /INVALID_CURSOR/);
await assert.rejects(pager.read(root, { ...query, cursor: first.nextCursor, limit: 11 }, scope, () => revision, 0), /INVALID_CURSOR/);
revision++;
await assert.rejects(pager.read(root, { ...query, cursor: first.nextCursor }, scope, () => revision, 0), /INVALID_CURSOR/);
await assert.rejects(pager.read(root, { ...query, cursor: first.nextCursor }, scope, () => revision, 1000), /INVALID_CURSOR/);
await assert.rejects(pager.read(root, { ...query, limit: 100 }, scope, () => revision, 2000, { yieldControl: async () => revision++ }), /INVALID_CURSOR/);
console.log('Cursor: продолжение без пропусков, scope/query/revision/TTL и изменения во время чтения — OK');

const loads = [];
const pages = [
  { id: 'p1', name: 'One', type: 'PAGE', children: Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, name: i % 2 ? 'Match' : 'Other', type: 'RECTANGLE' })) },
  { id: 'p2', name: 'Two', type: 'PAGE', children: [{ id: 'b', name: 'Match', type: 'TEXT' }] },
];
const search = new SearchPager({ ...limits, maxNodes: 4, maxResponseBytes: 1000, chunkSize: 2 }, 10, 1000);
const find = { document: true, name: 'Match', limit: 2 };
let version = '0', searchCursor, matches = [];
const runSearch = (q, s = scope, now = 0) => search.read(pages, undefined, undefined, q, s, () => version, now,
  async page => { loads.push(page.id); }, async () => {});
const firstSearch = await runSearch(find);
assert.deepEqual(loads, ['p1']);
assert.equal(firstSearch.truncated, true);
searchCursor = firstSearch.nextCursor; matches.push(...firstSearch.nodes);
await assert.rejects(runSearch({ ...find, name: 'Other', cursor: searchCursor }), /INVALID_CURSOR/);
await assert.rejects(runSearch({ ...find, cursor: searchCursor }, { ...scope, connectionGeneration: 2 }), /INVALID_CURSOR/);
do {
  const result = await runSearch({ ...find, cursor: searchCursor });
  matches.push(...result.nodes); searchCursor = result.nextCursor;
} while (searchCursor);
assert.deepEqual(matches.map(node => node.nodeId), ['a1', 'a3', 'a5', 'a7', 'a9', 'a11', 'b']);
assert.equal(matches.at(-1).pageId, 'p2');
assert.deepEqual(loads, ['p1', 'p2']);
const outdated = await runSearch(find);
version = '1';
await assert.rejects(runSearch({ ...find, cursor: outdated.nextCursor }), /INVALID_CURSOR/);
const noMatches = await runSearch({ document: true, name: 'absent', limit: 2 });
assert.deepEqual(noMatches.nodes, []);
assert.ok(noMatches.nextCursor);
let deep = { id: 'leaf', name: 'Match', type: 'TEXT' };
for (let i = 0; i < 25; i++) deep = { id: `d${i}`, name: 'Branch', type: 'FRAME', children: [deep] };
const deepPager = new SearchPager({ ...limits, maxDepth: 3 }, 5, 1000);
let deepCursor, deepMatches = [], deepPages = 0;
do {
  const page = await deepPager.read([], deep, 'p1', { rootId: deep.id, name: 'Match', limit: 10, cursor: deepCursor }, scope, () => '0', 0, async () => {}, async () => {});
  deepMatches.push(...page.nodes); deepCursor = page.nextCursor; deepPages++;
} while (deepCursor && deepPages < 50);
assert.equal(deepCursor, undefined);
assert.deepEqual(deepMatches.map(node => node.nodeId), ['leaf']);
assert.ok(deepPages > 1);
for (const invalid of [
  { ...limits, maxDepth: -1 }, { ...limits, maxNodes: 0 }, { ...limits, maxResponseBytes: 257 },
  { ...limits, chunkSize: 0 }, { ...limits, maxNodes: 1.5 },
]) assert.throws(() => new SearchPager(invalid, 5, 1000), /INVALID_ARGUMENT/);
for (const [count, ttl] of [[0, 1000], [1.5, 1000], [5, 0], [5, Infinity]]) {
  assert.throws(() => new SearchPager(limits, count, ttl), /INVALID_ARGUMENT/);
}
const guarded = new SearchPager({ ...limits, maxDepth: 1, maxNodes: 4 }, 5, 1000);
let guardedCursor;
await assert.rejects(async () => {
  do {
    const result = await guarded.read([], deep, 'p1', { rootId: deep.id, limit: 4, cursor: guardedCursor }, scope, () => '0', 0, async () => {}, async () => {});
    guardedCursor = result.nextCursor;
  } while (guardedCursor);
}, /RESOURCE_LIMIT/);
const rootSearch = new SearchPager({ ...limits, maxResponseBytes: 400 }, 5, 1000);
const byteRoot = { id: 'root', name: 'Root', type: 'FRAME', children: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, name: '汉'.repeat(20), type: 'TEXT' })) };
const byteQuery = { rootId: 'root', types: ['TEXT'], limit: 10 };
let byteCursor, byteIds = [];
do {
  const result = await rootSearch.read([], byteRoot, 'p1', { ...byteQuery, cursor: byteCursor }, scope, () => '0', 0, async () => {}, async () => {});
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 400);
  byteIds.push(...result.nodes.map(node => node.nodeId)); byteCursor = result.nextCursor;
} while (byteCursor);
assert.deepEqual(byteIds, Array.from({ length: 10 }, (_, i) => `n${i}`));
await assert.rejects(rootSearch.read([], byteRoot, 'p1', { ...byteQuery, cursor: 'foreign' }, scope, () => '0', 0, async () => {}, async () => {}), /INVALID_CURSOR/);
const shallowPager = new TreePager(limits, 5, 1000);
const shallowRoot = { id: 'r', name: 'r', type: 'FRAME', children: [{ id: 'c', name: 'c', type: 'FRAME', children: [{ id: 'g', name: 'g', type: 'RECTANGLE' }] }] };
const shallowFirst = await shallowPager.read(shallowRoot, { rootId: 'r', depth: 1, limit: 1 }, scope, () => 0, 0);
const shallowLast = await shallowPager.read(shallowRoot, { rootId: 'r', depth: 1, limit: 1, cursor: shallowFirst.nextCursor }, scope, () => 0, 0);
assert.equal(shallowLast.truncated, true);
console.log('Поиск: постепенные страницы, фильтры, cursor, границы обхода и усечение глубины — OK');
