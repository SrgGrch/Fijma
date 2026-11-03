import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['shared/batch-refs.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { validateBatchRefs } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const create = { stepId: 'frame', op: 'createNode', parent: { nodeId: '1:1' } };
const child = { stepId: 'child', op: 'createNode', parent: { stepId: 'frame', output: 'nodeId' } };
validateBatchRefs([create, child]);
validateBatchRefs([
  { stepId: 'collection', op: 'createCollection' },
  { stepId: 'variable', op: 'createVariable', collectionId: { stepId: 'collection', output: 'collectionId' } },
  { stepId: 'bind', op: 'bindVariable', target: { nodeId: '1:1' }, variableId: { stepId: 'variable', output: 'variableId' } },
]);
for (const invalid of [
  [], [create, create], [child, create],
  [{ ...create, op: 'execute_js' }], [{ ...create, op: '__proto__' }],
  [create, { ...child, parent: { stepId: 'frame', output: 'styleId' } }],
  [{ stepId: 'style', op: 'createStyle' }, { ...child, parent: { stepId: 'style', output: 'nodeId' } }],
  [{ ...create, parent: { nodeId: '1:1', stepId: 'other' } }],
  [{ ...create, parent: '1:1' }],
  [{ stepId: 'group', op: 'groupNodes', targets: [] }],
]) assert.throws(() => validateBatchRefs(invalid), /INVALID_ARGUMENT/);
console.log('Refs пакета: порядок, duplicate stepId, типы ресурсов и неизвестные операции — OK');
