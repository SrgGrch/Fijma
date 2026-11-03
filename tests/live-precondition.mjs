import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['plugin/projections.ts', 'plugin/scene-ops.ts', 'shared/batch-executor.ts', 'shared/operation-journal.ts'],
  outdir: 'out', bundle: true, format: 'esm', platform: 'node', write: false });
const load = async index => import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[index].text).toString('base64')}`);
const { readNodes } = await load(0);
const { pageOperations } = await load(1);
const { BatchExecutor } = await load(2);
const { OperationJournal } = await load(3);

let liveName = 'Before', writes = 0, undo = 0;
const node = { id: '1:1', type: 'FRAME', children: [{ id: 'old-child' }],
  get name() { return liveName; }, set name(value) { writes++; liveName = value; } };
const api = { mixed: Symbol('mixed'), root: { children: [] }, getNodeByIdAsync: async id => id === node.id ? node : null };
const read = () => readNodes(api, [node.id], ['name', 'children'], 10, 32768);
const before = (await read()).nodes[0].properties;
assert.deepEqual(before, { name: 'Before', children: ['old-child'] });

// A manual edit changes the same live object consulted by the real callbacks.
liveName = 'Manual';
node.children = [{ id: 'new-child' }];
const after = (await read()).nodes[0].properties;
assert.deepEqual(after, { name: 'Manual', children: ['new-child'] });

const callbacks = pageOperations(api);
const executor = new BatchExecutor(new OperationJournal({ dedupTtl: 10000, clockSkew: 100, maxJournalEntries: 10 }),
  { ...callbacks, checkScope() {}, commitUndo() { undo++; } }, 10);
const now = Date.now(), hex = now.toString(16).padStart(12, '0');
const operationId = suffix => `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${String(suffix).padStart(12, '0')}`;
const scope = { sessionId: 's', connectionGeneration: 1 };
for (const [index, expected] of [{ name: before.name }, { children: before.children }].entries()) {
  const result = await executor.submit(scope, operationId(index + 1), [{ stepId: 'update', op: 'updateNode', type: 'FRAME',
    target: { nodeId: node.id }, patch: { name: 'Must not be written' }, expected }], now);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CONFLICT');
  assert.deepEqual(result.affectedNodeIds, []);
  assert.equal(liveName, 'Manual');
  assert.equal(writes, 0);
  assert.equal(undo, 0);
}
console.log('Live precondition: manual name/children changes are read again and reject stale writes — OK');
