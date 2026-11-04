import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['plugin/write-operations.ts', 'shared/batch-executor.ts', 'shared/operation-journal.ts'], bundle: true, format: 'esm', platform: 'node', write: false, outdir: 'out' });
const load = async n => import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[n].text).toString('base64')}`);
const { writeOperations } = await load(0), { BatchExecutor } = await load(1), { OperationJournal } = await load(2);
let seq = 0;
const all = new Map();
function node(type, parent = null) {
  const n = { id: `n${++seq}`, type, name: type, parent: null, children: [], x: 12, y: 9,
    async loadAsync() { this.loaded = true; },
    insertChild(index, child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); this.children.splice(index, 0, child); child.parent = this; },
  };
  all.set(n.id, n); if (parent) parent.insertChild(parent.children.length, n); return n;
}
const root = node('DOCUMENT'), p1 = node('PAGE', root), p2 = node('PAGE', root), a = node('FRAME', p1), b = node('FRAME', p2), x = node('RECTANGLE', a), y = node('RECTANGLE', a);
const api = { root, getNodeByIdAsync: async id => all.get(id),
  group(items, parent) { const g = node('GROUP', parent); for (const item of items) g.insertChild(g.children.length, item); return g; },
  ungroup(g) { const parent = g.parent, index = parent.children.indexOf(g); for (const [i, child] of [...g.children].entries()) parent.insertChild(index + i, child); parent.children.splice(parent.children.indexOf(g), 1); g.removed = true; },
};
const ops = writeOperations(api), now = Date.now(), hex = now.toString(16).padStart(12, '0');
const executor = new BatchExecutor(new OperationJournal({ dedupTtl: 10000, clockSkew: 10, maxJournalEntries: 100 }), { ...ops, checkScope() {}, commitUndo() {} }, 10);
let no = 0; const run = step => executor.submit({ sessionId: 's', connectionGeneration: 1 }, `${hex.slice(0,8)}-${hex.slice(8)}-7000-8000-${String(++no).padStart(12,'0')}`, [step], now);
const ref = n => ({ nodeId: n.id });
let result = await run({ stepId: 'move', op: 'moveNode', target: ref(x), parent: ref(b), index: 0, expected: { parentId: a.id, related: { [a.id]: { children: [x.id, y.id] }, [b.id]: { children: [] } } } });
assert.equal(result.status, 'succeeded'); assert.equal(x.parent, b); assert.equal(x.x, 12); assert(p1.loaded && p2.loaded); assert(result.affectedNodeIds.includes(a.id) && result.affectedNodeIds.includes(b.id));
result = await run({ stepId: 'stale', op: 'moveNode', target: ref(x), parent: ref(a), index: 0, expected: { related: { [a.id]: { children: [] } } } });
assert.equal(result.error.code, 'CONFLICT'); assert.equal(x.parent, b);
for (const [target, parent] of [[a, a], [a, y], [x, node('INSTANCE', p2)], [node('RECTANGLE', node('INSTANCE', p1)), b]]) {
  const old = target.parent;
  result = await run({ stepId: 'invalid', op: 'moveNode', target: ref(target), parent: ref(parent), index: 0, expected: { name: target.name } });
  assert.equal(result.error.code, 'INVALID_ARGUMENT'); assert.equal(target.parent, old);
}
result = await run({ stepId: 'back', op: 'moveNode', target: ref(x), parent: ref(a), index: 1, expected: { parentId: b.id } });
assert.equal(result.status, 'succeeded'); assert.deepEqual(a.children.map(n => n.id), [y.id, x.id]);
result = await run({ stepId: 'group', op: 'groupNodes', targets: [ref(y), ref(x)], parent: ref(a), expected: { parentId: a.id, related: { [x.id]: { parentId: a.id }, [a.id]: { children: [y.id, x.id] } } } });
assert.equal(result.status, 'succeeded'); const group = all.get(result.steps[0].outputs.nodeId); assert.equal(x.parent, group); assert(result.affectedNodeIds.includes(group.id));
const groupId = group.id;
result = await run({ stepId: 'ungroup', op: 'ungroupNode', target: ref(group), expected: { children: [y.id, x.id] } });
assert.equal(result.status, 'succeeded'); assert(group.removed); assert(result.affectedNodeIds.includes(groupId) && result.affectedNodeIds.includes(x.id)); assert.equal(x.parent, a);
result = await run({ stepId: 'page', op: 'movePage', pageId: ref(p1), index: 1, expected: { name: p1.name } });
assert.equal(result.status, 'succeeded'); assert.deepEqual(root.children.map(n => n.id), [p2.id, p1.id]);
const component = node('COMPONENT', p1), instance = node('INSTANCE', p1), beforeInstance = instance.parent;
result = await run({ stepId: 'nested-instance', op: 'moveNode', target: ref(instance), parent: ref(component), index: 0, expected: { parentId: p1.id } });
assert.equal(result.status, 'succeeded'); assert.equal(instance.parent, component);
const otherFrame = node('FRAME', p1), other = node('RECTANGLE', otherFrame);
result = await run({ stepId: 'group-different-parents', op: 'groupNodes', targets: [ref(x), ref(other)], parent: ref(a), expected: { parentId: a.id, related: { [other.id]: { parentId: otherFrame.id } } } });
assert.equal(result.status, 'succeeded'); const mixedGroup = all.get(result.steps[0].outputs.nodeId); assert.equal(other.parent, mixedGroup);
const foreign = node('RECTANGLE', b);
result = await run({ stepId: 'group-different-pages', op: 'groupNodes', targets: [ref(mixedGroup), ref(foreign)], parent: ref(a), expected: { parentId: a.id } });
assert.equal(result.error.code, 'INVALID_ARGUMENT'); assert.equal(foreign.parent, b);
api.ungroup(mixedGroup);
result = await run({ stepId: 'duplicate', op: 'groupNodes', targets: [ref(x), ref(x)], parent: ref(a), expected: { parentId: a.id } });
assert.equal(result.error.code, 'INVALID_ARGUMENT'); assert.equal(x.parent, a);
result = await run({ stepId: 'bad-index', op: 'moveNode', target: ref(x), parent: ref(a), index: a.children.length, expected: { parentId: a.id } });
assert.equal(result.error.code, 'INVALID_ARGUMENT'); assert.equal(x.parent, a);
console.log('Structure callbacks: cross-page move, order, conflict, safety, group/ungroup and pages OK');
