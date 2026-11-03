import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['shared/contracts.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { toolInputs, stepSchema, batchSchema } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const scope = { sessionId: 'session', connectionGeneration: 1 };
const operationId = '019a4a10-0000-7000-8000-000000000001';
const create = { stepId: 'frame', op: 'createNode', type: 'FRAME', parent: { nodeId: '0:1' }, properties: { name: 'Frame', width: 100 } };
const examples = {
  figma_get_context: {}, figma_get_tree: { scope, rootId: '0:1', depth: 2, limit: 10 },
  figma_find_nodes: { scope, document: true, name: 'Frame', limit: 10 },
  figma_get_nodes: { scope, nodeIds: ['1:1'], fields: ['name'] },
  figma_get_local_resources: { scope, kind: 'variables', fields: ['name'], limit: 10 },
  figma_navigate: { scope, nodeIds: [], select: false, reveal: false },
  figma_apply_batch: { scope, operationId, steps: [create] },
  figma_get_operation: { scope, operationId }, figma_cancel_operation: { scope, operationId },
  figma_export_node: { scope, nodeId: '1:1', format: 'PNG', scale: 1 },
};
for (const [name, schema] of Object.entries(toolInputs)) {
  assert.equal(schema.safeParse(examples[name]).success, true, name);
  assert.equal(schema.safeParse({ ...examples[name], execute_js: 'code' }).success, false, name);
}
const valid = [
  create,
  { stepId: 'style', op: 'createStyle', type: 'PAINT', name: 'Red', value: { paints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] } },
  { stepId: 'collection', op: 'createCollection', name: 'Tokens' },
  { stepId: 'variable', op: 'createVariable', collectionId: 'c', name: 'Width', type: 'FLOAT' },
  { stepId: 'text', op: 'createText', parent: { nodeId: '0:1' }, characters: 'Hello', font: { family: 'Inter', style: 'Regular' }, typography: { fontSize: 16 } },
  { stepId: 'geometry', op: 'setGeometry', target: { nodeId: '1:1' }, position: { x: 1, y: 2 }, expected: { name: 'Before' } },
];
for (const value of valid) assert.equal(stepSchema.safeParse(value).success, true, value.op);
for (const value of [
  { ...create, properties: { vectorNetwork: {} } },
  { ...create, type: 'INSTANCE' }, { ...create, properties: { width: Infinity } },
  { ...create, properties: { width: -1 } },
  { ...create, type: 'RECTANGLE', properties: { characters: 'no' } },
  { ...valid[1], type: 'EFFECT' },
  { ...valid[5], expected: undefined },
  { ...valid[5], target: { nodeId: '1:1', output: 'nodeId' } },
]) assert.equal(stepSchema.safeParse(value).success, false, JSON.stringify(value));
assert.equal(batchSchema.safeParse([create, create]).success, false);
console.log('Контракты: 10 инструментов, группы операций, strict fields, expected и несовместимые значения — OK');
