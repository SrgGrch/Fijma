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
for (const [kind, field] of [['components', 'remote'], ['styles', 'value'], ['collections', 'modes'], ['variables', 'valuesByMode']]) {
  assert.equal(toolInputs.figma_get_local_resources.safeParse({ scope, kind, fields: [field], limit: 10 }).success, true, kind);
  assert.equal(toolInputs.figma_get_local_resources.safeParse({ scope, kind, fields: ['valuesByMode.m'], limit: 10 }).success, false, kind);
}
assert.equal(toolInputs.figma_get_local_resources.safeParse({ scope, kind: 'variables', fields: ['modes'], limit: 10 }).success, false);
assert.equal(toolInputs.figma_get_nodes.safeParse({ scope, nodeIds: ['1:1'], fields: ['fills.0.color'] }).success, false);
assert.equal(toolInputs.figma_get_nodes.safeParse({ scope, nodeIds: ['1:1'], fields: ['textSegments'] }).success, true);
const valid = [
  create,
  { stepId: 'style', op: 'createStyle', type: 'PAINT', name: 'Red', value: { paints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] } },
  { stepId: 'collection', op: 'createCollection', name: 'Tokens' },
  { stepId: 'variable', op: 'createVariable', collectionId: 'c', name: 'Width', type: 'FLOAT', expected: { variableIds: [] } },
  { stepId: 'text', op: 'createText', parent: { nodeId: '0:1' }, characters: 'Hello', font: { family: 'Inter', style: 'Regular' }, typography: { fontSize: 16 } },
  { stepId: 'geometry', op: 'setGeometry', target: { nodeId: '1:1' }, position: { x: 1, y: 2 }, expected: { name: 'Before' } },
  { stepId: 'setValue', op: 'setVariableValue', variableId: 'v', modeId: 'm', value: 10, expected: { valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'v2' } } } },
  { stepId: 'renameMode', op: 'renameMode', collectionId: 'c', modeId: 'm', name: 'Dark', expected: { modes: [{ modeId: 'm', name: 'Light' }] } },
  { stepId: 'appearance', op: 'setAppearance', target: { nodeId: '1:1' }, appearance: { opacity: 0.5 }, expected: { opacity: 1 } },
  { stepId: 'component', op: 'createComponent', parent: { nodeId: '0:1' }, properties: { name: 'Button' } },
  { stepId: 'layout', op: 'setAutoLayout', target: { nodeId: '1:1' }, layout: { layoutMode: 'HORIZONTAL', itemSpacing: 8 }, expected: { name: 'Frame' } },
  { stepId: 'range', op: 'replaceTextRange', target: { nodeId: '1:2' }, start: 0, end: 2, text: 'Hi', insertionFormatting: { inherit: 'AFTER' }, expected: { characters: 'Hello' } },
];
for (const value of valid) assert.equal(stepSchema.safeParse(value).success, true, value.op);
for (const value of [
  { ...create, properties: { vectorNetwork: {} } },
  { ...create, type: 'INSTANCE' }, { ...create, properties: { width: Infinity } },
  { ...create, properties: { width: -1 } },
  { ...create, properties: { width: 0 } },
  { ...create, properties: { fills: [{ type: 'IMAGE', imageHash: null, scaleMode: 'FILL' }] } },
  { ...create, type: 'RECTANGLE', properties: { characters: 'no' } },
  { ...valid[1], type: 'EFFECT' },
  { ...valid[5], expected: undefined },
  { ...valid[5], target: { nodeId: '1:1', output: 'nodeId' } },
]) assert.equal(stepSchema.safeParse(value).success, false, JSON.stringify(value));
assert.equal(batchSchema.safeParse([create, create]).success, false);
assert.equal(batchSchema.safeParse([create, { stepId: 'child', op: 'createNode', type: 'RECTANGLE', parent: { stepId: 'frame', output: 'nodeId' }, properties: {} }]).success, true);
assert.equal(batchSchema.safeParse([{ ...create, parent: { stepId: 'later', output: 'nodeId' } }]).success, false);
assert.equal(batchSchema.safeParse([{ ...valid[1] }, { ...create, parent: { stepId: 'style', output: 'styleId' } }]).success, false);
assert.equal(stepSchema.safeParse({ ...valid[6], expected: { valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 1 } } } }).success, false);
assert.equal(stepSchema.safeParse({ ...valid[7], expected: { modes: [{ modeId: 'm', name: 'Light', extra: true }] } }).success, false);
assert.equal(stepSchema.safeParse({ ...valid[5], expected: { parentId: 'p', related: { p: { children: ['1:1'] } } } }).success, true);
assert.equal(stepSchema.safeParse({ ...valid[5], expected: { related: { p: {} } } }).success, false);
for (const type of ['LINE', 'TEXT']) assert.equal(stepSchema.safeParse({ ...create, type, properties: { cornerRadius: 4 } }).success, false, type);
for (const type of ['ELLIPSE', 'POLYGON', 'STAR', 'TEXT', 'LINE']) assert.equal(stepSchema.safeParse({ ...create, type, properties: { topLeftRadius: 4 } }).success, false, type);
for (const type of ['FRAME', 'RECTANGLE']) assert.equal(stepSchema.safeParse({ ...create, type, properties: { topLeftRadius: 4 } }).success, true, type);
const target = { nodeId: '1:1' }, expected = { name: 'before' };
const bind = { stepId: 'bind', op: 'bindVariable', target, expected, property: 'width', variableId: 'v' };
assert.equal(stepSchema.safeParse(bind).success, true);
assert.equal(stepSchema.safeParse({ ...bind, property: 'fills.0.color' }).success, false);
assert.equal(stepSchema.safeParse({ ...bind, op: 'unbindVariable', property: 'execute_js', variableId: undefined }).success, false);
const definitions = { stepId: 'defs', op: 'setComponentProperties', target, expected, definitions: { enabled: { type: 'BOOLEAN', defaultValue: true }, title: { type: 'TEXT', defaultValue: 'Hi' } } };
assert.equal(stepSchema.safeParse(definitions).success, true);
assert.equal(stepSchema.safeParse({ ...definitions, definitions: { enabled: { type: 'BOOLEAN', defaultValue: 'true' } } }).success, false);
assert.equal(stepSchema.safeParse({ ...definitions, definitions: { title: { type: 'TEXT', defaultValue: true } } }).success, false);
const expectedComponent = { componentPropertyDefinitions: { 'Enabled#1': { type: 'BOOLEAN', defaultValue: true, boundVariables: { defaultValue: { type: 'VARIABLE_ALIAS', id: 'v' } } } }, related: { '1:2': { mainComponent: { id: 'c', key: 'key', remote: true } } } };
assert.equal(stepSchema.safeParse({ ...definitions, expected: expectedComponent }).success, true);
assert.equal(stepSchema.safeParse({ ...definitions, expected: { mainComponent: { id: 'c', key: 'key', remote: 'yes' } } }).success, false);
assert.equal(toolInputs.figma_get_nodes.safeParse({ scope, nodeIds: ['1:1'], fields: ['mainComponent', 'componentProperties', 'componentPropertyDefinitions', 'componentSet', 'variantProperties'] }).success, true);
const parent = { nodeId: '0:1' }, targets = [target, { nodeId: '1:2' }];
const cases = {
  createPage: { name: 'Page' }, renamePage: { pageId: parent, name: 'Page' }, clonePage: { pageId: parent }, movePage: { pageId: parent, index: 0 }, deletePage: { pageId: parent },
  createNode: { type: 'FRAME', parent, properties: {} }, updateNode: { type: 'FRAME', target, patch: {} }, cloneNode: { target, parent }, deleteNode: { target }, moveNode: { target, parent, index: 0 }, groupNodes: { targets, parent }, ungroupNode: { target },
  setGeometry: { target, rotation: 1 }, setConstraints: { target, value: { horizontal: 'MIN', vertical: 'MIN' } }, setAutoLayout: { target, layout: { layoutMode: 'HORIZONTAL' } }, setLayoutSizing: { target, sizing: { horizontal: 'FIXED', vertical: 'FILL' } },
  createText: { parent, characters: 'Hi', font: { family: 'Inter', style: 'Regular' }, typography: {} }, setText: { target, characters: 'Hi' }, replaceTextRange: { target, start: 0, end: 1, text: 'x', insertionFormatting: { inherit: 'BEFORE' } }, formatTextRange: { target, start: 0, end: 1, format: { fontSize: 12 } },
  setAppearance: { target, appearance: { opacity: 0.5 } }, importImage: { parent, data: 'bytes', mimeType: 'image/png', placement: { x: 0, y: 0, width: 1, height: 1 } }, importSvg: { parent, svg: '<svg/>' }, booleanNodes: { parent, targets, kind: 'union' },
  createComponent: { parent, properties: {} }, componentFromNode: { target }, combineVariants: { parent, targets }, setComponentProperties: { target, definitions: definitions.definitions }, createInstance: { parent, componentId: target }, setInstanceProperties: { target, values: { Enabled: true } }, swapVariant: { target, componentId: { nodeId: '2:1' } }, detachInstance: { target },
  createStyle: { type: 'PAINT', name: 'Style', value: { paints: [] } }, updateStyle: { styleId: 's', patch: { name: 'New' } }, applyStyle: { target, property: 'fills', styleId: 's' }, unbindStyle: { target, property: 'fills' }, deleteStyle: { styleId: 's' },
  createCollection: { name: 'Tokens' }, updateCollection: { collectionId: 'c', patch: { name: 'New' } }, deleteCollection: { collectionId: 'c' }, createMode: { collectionId: 'c', name: 'Dark' }, renameMode: { collectionId: 'c', modeId: 'm', name: 'Dark' }, deleteMode: { collectionId: 'c', modeId: 'm' },
  createVariable: { collectionId: 'c', name: 'Spacing', type: 'FLOAT' }, updateVariable: { variableId: 'v', patch: { name: 'New' } }, deleteVariable: { variableId: 'v' }, setVariableValue: { variableId: 'v', modeId: 'm', value: 3 }, setVariableAlias: { variableId: 'v', modeId: 'm', targetVariableId: 'v2' }, bindVariable: { target, property: 'width', variableId: 'v' }, unbindVariable: { target, property: 'width' }, setNodeMode: { target, collectionId: 'c', modeId: 'm' },
};
for (const [op, fields] of Object.entries(cases)) assert.equal(stepSchema.safeParse({ stepId: op, op, ...fields, expected }).success, true, op);
console.log('Контракты: 10 инструментов, группы операций, strict fields, expected и несовместимые значения — OK');
