import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['plugin/write-operations.ts', 'shared/batch-executor.ts', 'shared/operation-journal.ts'], outdir: 'out', bundle: true, format: 'esm', platform: 'node', write: false });
const load = async n => import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[n].text).toString('base64')}`);
const { writeOperations } = await load(0), { BatchExecutor } = await load(1), { OperationJournal } = await load(2);
const now = Date.now(), hex = now.toString(16).padStart(12,'0');
const id = n => `${hex.slice(0,8)}-${hex.slice(8)}-7000-8000-${String(n).padStart(12,'0')}`;
const font = { family: 'Inter', style: 'Regular' };
const text = { id: 't', type: 'TEXT', name: 'Text', characters: 'A😀BC', fontName: font, hasMissingFont: false, textStyleId: '', boundVariables: {}, styles: [1,2,2,3,4],
  getRangeAllFontNames() { return [font]; },
  getStyledTextSegments() { return this.styles.map((size, i) => ({ start: i, end: i + 1, fontName: font, fontSize: size, textStyleId: '', boundVariables: {} })); },
  deleteCharacters(start,end) { this.characters = this.characters.slice(0,start) + this.characters.slice(end); this.styles.splice(start,end-start); },
  insertCharacters(start,value,style) { const inherited = style === 'BEFORE' ? this.styles[start-1] : this.styles[start]; this.characters = this.characters.slice(0,start) + value + this.characters.slice(start); this.styles.splice(start,0,...Array(value.length).fill(inherited)); },
  setRangeFontSize(start,end,size) { this.styles.fill(size,start,end); },
  setRangeFontName(start,end,value) { this.appliedFont = value; },
  setRangeLineHeight(start,end,value) { this.appliedLineHeight = value; },
  setRangeLetterSpacing(start,end,value) { this.appliedLetterSpacing = value; },
  setRangeTextCase(start,end,value) { this.appliedTextCase = value; },
  setRangeTextDecoration(start,end,value) { this.appliedDecoration = value; },
  setRangeFills(start,end,value) { this.appliedFills = value; },
};
const loaded = [];
const api = { async getNodeByIdAsync(id) { return id === 't' ? text : null; }, async loadFontAsync(value) { loaded.push(value); if (value.family === 'Missing') throw Error('missing'); } };
const executor = new BatchExecutor(new OperationJournal({ dedupTtl: 10000, clockSkew: 10, maxJournalEntries: 20 }), { ...writeOperations(api), checkScope() {}, commitUndo() {} }, 10);
const scope = { sessionId: 's', connectionGeneration: 1 };
const run = (n, step) => executor.submit(scope, id(n), [step], now);
const replace = (start,end,value,format) => ({ stepId: 'replace', op: 'replaceTextRange', target: { nodeId: 't' }, start, end, text: value, insertionFormatting: format, expected: { characters: text.characters } });
const invalid = await run(1, replace(2,3,'bad',{ inherit: 'BEFORE' }));
assert.equal(invalid.error.code, 'INVALID_ARGUMENT'); assert.equal(text.characters, 'A😀BC');
const result = await run(2, replace(3,4,'LONG',{ inherit: 'AFTER' }));
assert.equal(result.status, 'succeeded'); assert.equal(text.characters, 'A😀LONGC'); assert.deepEqual(text.styles, [1,2,2,4,4,4,4,4]);
const formatted = await run(3, { stepId: 'format', op: 'formatTextRange', target: { nodeId: 't' }, start: 3, end: 7, format: { fontSize: 20 }, expected: { characters: text.characters } });
assert.equal(formatted.status, 'succeeded'); assert.deepEqual(text.styles, [1,2,2,20,20,20,20,4]);
const before = text.characters;
assert.throws(() => run(4, replace(3,4,'new',{ format: { fontSize: 14 } })));
assert.equal(text.characters, before);
const boundary = await run(5, replace(0,1,'x',{ inherit: 'BEFORE' }));
assert.equal(boundary.error.code, 'INVALID_ARGUMENT'); assert.equal(text.characters, before);
assert.throws(() => run(6, { stepId: 'format', op: 'formatTextRange', target: { nodeId: 't' }, start: 0, end: 1, format: { textAlignHorizontal: 'CENTER' }, expected: { characters: text.characters } }));
text.hasMissingFont = true;
assert.equal((await run(7, replace(3,4,'x',{ inherit: 'BEFORE' }))).error.code, 'FONT_UNAVAILABLE'); assert.equal(text.characters, before);
text.hasMissingFont = false;
const fullStyle = { fontName: { family: 'Serif', style: 'Regular' }, fontSize: 18, lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 0 }, textCase: 'ORIGINAL', textDecoration: 'NONE', fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] };
const full = await run(9, replace(3, 4, 'XY', { format: fullStyle }));
assert.equal(full.status, 'succeeded'); assert.equal(text.characters, 'A😀XYONGC');
assert.deepEqual(text.styles.slice(-4), [20,20,20,4]);
assert.deepEqual(text.appliedFont, fullStyle.fontName); assert.deepEqual(text.appliedFills, fullStyle.fills);
assert(loaded.some(value => value.family === 'Serif'));
const patched = await run(10, replace(3, 5, 'z', { inherit: 'AFTER', format: { fontSize: 25 } }));
assert.equal(patched.status, 'succeeded'); assert.equal(text.characters, 'A😀zONGC');
assert.deepEqual(text.styles.slice(3), [25,20,20,20,4]);
const beforeMissing = text.characters;
const missing = await run(11, replace(3, 4, 'x', { inherit: 'BEFORE', format: { fontName: { family: 'Missing', style: 'Regular' } } }));
assert.equal(missing.error.code, 'FONT_UNAVAILABLE'); assert.equal(text.characters, beforeMissing);
assert.deepEqual(missing.error.details, { fonts: [{ family: 'Missing', style: 'Regular' }] });
const missingFull = await run(12, replace(3, 4, 'x', { format: { ...fullStyle, fontName: { family: 'Missing', style: 'Regular' } } }));
assert.equal(missingFull.error.code, 'FONT_UNAVAILABLE'); assert.equal(text.characters, beforeMissing);
const deletedAll = await run(13, replace(0, text.characters.length, '', { inherit: 'BEFORE' }));
assert.equal(deletedAll.status, 'succeeded'); assert.equal(text.characters, ''); assert.deepEqual(text.styles, []);
const insertedEmpty = await run(14, replace(0, 0, '😀', { format: fullStyle }));
assert.equal(insertedEmpty.status, 'succeeded'); assert.equal(text.characters, '😀'); assert.deepEqual(text.styles, [18, 18]);
text.characters = '😀x👩y😀'; text.styles = [1, 1, 2, 3, 3, 4, 5, 5];
const emojiBefore = text.characters;
assert.equal((await run(15, replace(1, 3, '', { inherit: 'AFTER' }))).error.code, 'INVALID_ARGUMENT');
assert.equal((await run(16, replace(2, 4, '', { inherit: 'AFTER' }))).error.code, 'INVALID_ARGUMENT');
assert.equal((await run(17, replace(5, 7, '', { inherit: 'AFTER' }))).error.code, 'INVALID_ARGUMENT');
assert.equal(text.characters, emojiBefore);
const emojiReplace = await run(18, replace(2, 5, '', { inherit: 'AFTER' }));
assert.equal(emojiReplace.status, 'succeeded'); assert.equal(text.characters, '😀y😀'); assert.deepEqual(text.styles, [1, 1, 4, 5, 5]);
text.insertCharacters = () => { throw Error('insertion failed'); };
const partial = await run(8, replace(2,3,'x',{ inherit: 'BEFORE' }));
assert.equal(partial.status, 'partially_applied'); assert.deepEqual(partial.affectedNodeIds, ['t']);
console.log('Text ranges: UTF-16, tail styles, inheritance, missing fonts and partial writes OK');
