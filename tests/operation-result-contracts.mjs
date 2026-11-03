import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['shared/operation-result.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const schemas = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const id = '019a4a10-0000-7000-8000-000000000001';
const error = { code: 'CONFLICT', message: 'changed', recoveryAction: 'Read again', details: { property: 'name' } };
const step = { stepId: 'one', status: 'failed', outputs: {}, appliedChanges: { nodeIds: ['1:1'], resourceIds: [], details: [{ property: 'name' }] }, error };
const operation = { operationId: id, sessionId: 's', connectionGeneration: 1, status: 'partially_applied', steps: [step], affectedNodeIds: ['1:1'], affectedResourceIds: [], warnings: [], error };
for (const status of ['queued', 'running', 'succeeded', 'failed', 'partially_applied', 'cancelled', 'unknown']) assert.equal(schemas.operationResultSchema.safeParse({ ...operation, status, error: status === 'succeeded' ? undefined : error }).success, true);
assert.equal(schemas.operationResultSchema.safeParse({ ...operation, status: 'skipped' }).success, false);
assert.equal(schemas.operationResultSchema.safeParse({ ...operation, status: 'succeeded' }).success, false);
assert.equal(schemas.operationResultSchema.safeParse({ ...operation, status: 'failed', error: undefined }).success, false);
assert.equal(schemas.stepResultSchema.safeParse({ ...step, status: 'succeeded' }).success, false);
assert.equal(schemas.stepResultSchema.safeParse({ ...step, error: undefined }).success, false);
assert.equal(schemas.operationResultSchema.safeParse({ ...operation, steps: [{ ...step, outputs: { arbitrary: 'x' } }] }).success, false);
for (const [name, value] of Object.entries({
  nodesOutputSchema: { nodes: [{ nodeId: '1:1', type: 'TEXT', properties: { characters: 'Hi' }, mixed: ['fontName'], unavailable: [] }, { nodeId: 'x', error }] },
  resourcesOutputSchema: { resources: [{ kind: 'variables', id: 'v', properties: { valuesByMode: { m: 3 } }, mixed: [], unavailable: [] }], truncated: false },
  navigateOutputSchema: { currentPageId: 'p', selection: ['1:1'] },
  operationOutputSchema: operation,
  exportOutputSchema: { sessionId: 's', nodeId: '1:1', bytes: 100, format: 'SVG', mimeType: 'image/svg+xml', uri: 'figma-export:opaque', expiresAt: '2026-11-04T00:00:00Z' },
})) {
  assert.equal(schemas[name].safeParse(value).success, true, name);
  assert.equal(schemas[name].safeParse({ error }).success, true, name);
  assert.equal(schemas[name].safeParse({ ...value, extra: true }).success, false, name);
}
assert.equal(schemas.exportOutputSchema.safeParse({ nodeId: 'x', format: 'SVG', mimeType: 'image/png', uri: 'x', expiresAt: 'x' }).success, false);
assert.equal(schemas.resourcesOutputSchema.safeParse({ resources: [{ kind: 'variables', id: 'v', properties: { valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 5 } } }, mixed: [], unavailable: [] }], truncated: false }).success, false);
for (const [type, value] of [['BOOLEAN', 'true'], ['STRING', 3], ['FLOAT', false], ['COLOR', 4]]) assert.equal(schemas.resourcesOutputSchema.safeParse({ resources: [{ kind: 'variables', id: 'v', properties: { type, valuesByMode: { m: value } }, mixed: [], unavailable: [] }], truncated: false }).success, false, type);
assert.equal(schemas.resourcesOutputSchema.safeParse({ resources: [{ kind: 'variables', id: 'v', properties: { type: 'FLOAT', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'other' }, n: 1 } }, mixed: [], unavailable: [] }], truncated: false }).success, true);
const png = { sessionId: 's', nodeId: '1:1', bytes: 100, width: 20, height: 10, format: 'PNG', mimeType: 'image/png', uri: 'figma-export:opaque', expiresAt: '2026-11-04T00:00:00Z' };
assert.equal(schemas.exportOutputSchema.safeParse(png).success, true);
assert.equal(schemas.exportOutputSchema.safeParse({ ...png, sessionId: undefined }).success, false);
assert.equal(schemas.exportOutputSchema.safeParse({ ...png, bytes: undefined }).success, false);
assert.equal(schemas.exportOutputSchema.safeParse({ ...png, width: undefined }).success, false);
assert.equal(schemas.resourcesOutputSchema.safeParse({ resources: [{ kind: 'styles', id: 's', properties: { type: 'EFFECT', value: { paints: [] } }, mixed: [], unavailable: [] }], truncated: false }).success, false);
assert.equal(schemas.nodesOutputSchema.safeParse({ nodes: [{ nodeId: 'x', type: 'TEXT', properties: { execute_js: 'bad' }, mixed: [], unavailable: [] }] }).success, false);
const alias = { type: 'VARIABLE_ALIAS', id: 'v' };
const readNode = { nodeId: 'x', type: 'TEXT', properties: {
  width: 0, height: 0, boundVariables: { fontSize: [alias], componentProperties: { label: alias } },
  fills: [{ type: 'IMAGE', imageHash: null, scaleMode: 'CROP', blendMode: 'COLOR_BURN', filters: { contrast: 0.2 } }],
  effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 1 }, radius: 2, visible: true, blendMode: 'OVERLAY', boundVariables: { radius: alias } }],
  textSegments: [{ start: 0, end: 2, characters: 'Hi', fontName: { family: 'Inter', style: 'Regular', variationSettings: { wght: 400 } }, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, boundVariables: { color: alias } }], textStyleId: 's' }],
}, mixed: [], unavailable: [] };
assert.equal(schemas.nodesOutputSchema.safeParse({ nodes: [readNode] }).success, true);
assert.equal(schemas.nodesOutputSchema.safeParse({ nodes: [{ ...readNode, properties: { ...readNode.properties, fills: [{ type: 'VIDEO', videoHash: null }] } }] }).success, false);
assert.equal(schemas.nodesOutputSchema.safeParse({ nodes: [{ ...readNode, properties: {}, unavailable: ['fills'] }] }).success, true);
assert.equal(schemas.resourcesOutputSchema.safeParse({ resources: [{ kind: 'variables', id: 'v', properties: { type: 'COLOR', valuesByMode: { m: { color: alias, opacity: 0.5 } } }, mixed: [], unavailable: [] }], truncated: false }).success, true);
assert.equal(schemas.resourcesOutputSchema.safeParse({ resources: [{ kind: 'styles', id: 's', properties: { type: 'GRID', boundVariables: { layoutGrids: [alias] }, value: { layoutGrids: [{ pattern: 'COLUMNS', alignment: 'STRETCH', gutterSize: 8, count: 12, boundVariables: { gutterSize: alias } }] } }, mixed: [], unavailable: [] }], truncated: false }).success, true);
const componentLinks = { mainComponent: { id: 'component', key: 'key', remote: true }, componentSet: { id: 'set', key: 'set-key', remote: true }, componentProperties: { 'Enabled#1': { type: 'BOOLEAN', value: true, boundVariables: { value: alias } } }, componentPropertyDefinitions: { Variant: { type: 'VARIANT', defaultValue: 'Small', variantOptions: ['Small', 'Large'], preferredValues: [{ type: 'COMPONENT', key: 'key' }] } }, variantProperties: { Size: 'Small' } };
assert.equal(schemas.nodesOutputSchema.safeParse({ nodes: [{ nodeId: 'i', type: 'INSTANCE', properties: componentLinks, mixed: [], unavailable: [] }] }).success, true);
assert.equal(schemas.resourcesOutputSchema.safeParse({ resources: [{ kind: 'components', id: 'c', properties: componentLinks, mixed: [], unavailable: [] }], truncated: false }).success, true);
assert.equal(schemas.nodesOutputSchema.safeParse({ nodes: [{ nodeId: 'i', type: 'INSTANCE', properties: { mainComponent: { id: 'c', key: 'k', remote: 'true' } }, mixed: [], unavailable: [] }] }).success, false);
console.log('Operation and tool result contracts OK');
