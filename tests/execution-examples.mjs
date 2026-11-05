import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const run = async (file, figma, args = {}, execution = { yield: async () => {} }) => new AsyncFunction('figma', 'args', 'execution', await readFile(file, 'utf8'))(figma, args, execution);
const text = { type: 'TEXT', getStyledTextSegments: () => [
  { start: 0, end: 2, fontName: { family: 'Inter', style: 'Regular' }, fontSize: 12, lineHeight: { unit: 'PIXELS', value: 16 } },
  { start: 2, end: 5, fontName: { family: 'Inter', style: 'Bold' }, fontSize: 12, lineHeight: { unit: 'PERCENT', value: 120 } },
  { start: 5, end: 6, fontName: { family: 'Inter', style: 'Regular' }, fontSize: 12, lineHeight: { unit: 'AUTO' } },
] };
let section = { type: 'SECTION', children: [text] };
let pageLoads = 0;
const figma = { currentPage: { type: 'PAGE', selection: [section], children: [section, text], async loadAsync() { pageLoads++; } }, getNodeByIdAsync: async id => id === 'section' ? section : null, variables: { getVariableByIdAsync: async id => id === 'float' ? { resolvedType: 'FLOAT' } : { resolvedType: 'STRING' } } };
const stats = await run('examples/typography-statistics.js', figma);
assert.equal(pageLoads, 1); assert.equal(stats.textNodes, 2); assert.equal(stats.uniqueCombinations, 3);
assert.deepEqual(stats.combinations.map(x => x.lineHeight.unit).sort(), ['AUTO', 'PERCENT', 'PIXELS']);
assert.equal(stats.combinations.reduce((n, x) => n + x.characters, 0), 12);
assert.equal((await run('examples/typography-statistics.js', figma, { sectionId: 'section' })).textNodes, 1);
section.children = Array.from({ length: 50 }, () => text);
await assert.rejects(run('examples/typography-statistics.js', figma, {}, { yield: async () => { throw Error('stopped'); } }), /stopped/);
const bindings = [], props = [];
figma.variables.getVariableByIdAsync = async id => { if (id === 'broken') throw Error('unavailable'); return id === 'float' ? { resolvedType: 'FLOAT' } : { resolvedType: 'STRING' }; };
const nested = { id: 'n', name: 'Body', type: 'FRAME', layoutMode: 'VERTICAL', children: [] };
const unsupported = { id: 'u', name: 'Body', type: 'RECTANGLE' };
const card = { id: 'i', type: 'INSTANCE', children: [nested, unsupported], layoutMode: 'HORIZONTAL', overrides: [{ id: 'i', overriddenFields: ['fills'] }], componentProperties: { Label: {} }, setProperties: p => props.push(p), setBoundVariable: (field, v) => bindings.push([field, v.resolvedType]), detachInstance() { throw Error('must not detach'); } };
section.children = [card];
const result = await run('examples/cards.js', figma, { properties: { Label: 'new', Missing: 'x' }, layout: { itemSpacing: 8, bogus: 5 }, bindings: { opacity: 'float', paddingLeft: 'wrong', paddingRight: 'broken' }, nestedLayout: { selector: 'Body', layout: { itemSpacing: 12 } }, structuralChange: true });
assert.deepEqual(props, [{ Label: 'new' }]); assert.equal(card.itemSpacing, 8);
assert.equal(nested.itemSpacing, 12); assert.equal(unsupported.itemSpacing, undefined);
assert.deepEqual(bindings, [['opacity', 'FLOAT']]); assert.equal(result.cardCount, 1);
assert.deepEqual(result.cards[0].overrides[0].fields, ['fills']); assert.equal(result.skippedCount, 6);
