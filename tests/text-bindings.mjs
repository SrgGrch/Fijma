import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['plugin/write-operations.ts', 'shared/batch-executor.ts', 'shared/operation-journal.ts'], outdir: 'out', bundle: true, format: 'esm', platform: 'node', write: false });
const load = async n => import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[n].text).toString('base64')}`);
const { writeOperations } = await load(0), { BatchExecutor } = await load(1), { OperationJournal } = await load(2);
const now = Date.now(), hex = now.toString(16).padStart(12,'0'), id = n => `${hex.slice(0,8)}-${hex.slice(8)}-7000-8000-${String(n).padStart(12,'0')}`;
const font = { family: 'Inter', style: 'Regular' }, alias = { type: 'VARIABLE_ALIAS', id: 'variable:1' };
const raw = () => ({ fontName: font, fontSize: 12, textStyleId: '', fillStyleId: '', boundVariables: {}, fills: [] });
const linked = () => ({ ...raw(), textStyleId: 'style:1', fillStyleId: 'paint:1', boundVariables: { fontSize: alias } });
function makeNode(value, spans, nodeLinks = {}) {
  let chars = value;
  const n = { id: `text:${value}`, type: 'TEXT', name: 'Text', hasMissingFont: false, fontName: font, nodeStyle: nodeLinks.textStyleId ?? '', fillStyleId: nodeLinks.fillStyleId ?? '', boundVariables: nodeLinks.boundVariables ?? {}, records: spans,
    get textStyleId() { return this.nodeStyle; },
    get characters() { return chars; },
    set characters(value) { chars = value; this.records = Array.from({ length: value.length }, () => ({ ...raw(), textStyleId: this.nodeStyle, fillStyleId: this.fillStyleId, boundVariables: { ...this.boundVariables } })); },
    getRangeAllFontNames() { return [font]; },
    getStyledTextSegments(fields) { return this.records.map((record, i) => ({ start: i, end: i + 1, characters: chars[i], ...Object.fromEntries(fields.filter(k => k in record).map(k => [k, record[k]])) })); },
    deleteCharacters(start,end) { chars = chars.slice(0,start) + chars.slice(end); this.records.splice(start,end-start); },
    insertCharacters(start,value,style) { const source = this.records[style === 'BEFORE' ? start-1 : start]; chars = chars.slice(0,start) + value + chars.slice(start); this.records.splice(start,0,...Array.from({ length: value.length }, () => structuredClone(source ?? raw()))); },
    setRangeFontSize(start,end,size) { for (let i=start;i<end;i++) this.records[i].fontSize = size; },
  }; return n;
}
const first = makeNode('abcTAIL', [raw(),raw(),raw(),linked(),linked(),linked(),linked()]);
const whole = makeNode('uniform', Array.from({ length: 7 }, linked), { textStyleId: 'style:1', fillStyleId: 'paint:1', boundVariables: { fontSize: alias } });
const nodes = new Map([[first.id, first], [whole.id, whole]]);
const api = { async getNodeByIdAsync(id) { return nodes.get(id); }, async loadFontAsync() {} };
const executor = new BatchExecutor(new OperationJournal({ dedupTtl: 10000, clockSkew: 10, maxJournalEntries: 30 }), { ...writeOperations(api), checkScope() {}, commitUndo() {} }, 10);
const scope = { sessionId: 's', connectionGeneration: 1 }, run = (n, step) => executor.submit(scope,id(n),[step],now);
const expected = node => ({ characters: node.characters });
const format = (node,start,end,size) => ({ stepId:'f', op:'formatTextRange', target:{nodeId:node.id}, start,end,format:{fontSize:size},expected:expected(node) });
const clean = await run(1, format(first,0,3,20));
assert.equal(clean.status, 'succeeded');
assert.deepEqual(first.records.slice(3).map(r => [r.textStyleId,r.fillStyleId,r.boundVariables.fontSize.id]), Array(4).fill(['style:1','paint:1','variable:1']));
const inserted = await run(2, { stepId:'r', op:'replaceTextRange',target:{nodeId:first.id},start:3,end:3,text:'x',insertionFormatting:{inherit:'AFTER'},expected:expected(first) });
assert.equal(inserted.status, 'succeeded'); assert.equal(first.characters, 'abcxTAIL');
assert.equal(first.records[3].textStyleId, 'style:1'); assert.equal(first.records[3].boundVariables.fontSize.id, 'variable:1');
assert.deepEqual(first.records.slice(4).map(r => [r.textStyleId,r.fillStyleId,r.boundVariables.fontSize.id]), Array(4).fill(['style:1','paint:1','variable:1']));
const refused = await run(3, format(first,3,4,25));
assert.equal(refused.error.code, 'CAPABILITY_UNAVAILABLE'); assert.equal(first.records[3].boundVariables.fontSize.id, 'variable:1');
const replacement = await run(4, { stepId:'all',op:'setText',target:{nodeId:whole.id},characters:'new',expected:expected(whole) });
assert.equal(replacement.status, 'succeeded'); assert.equal(whole.characters,'new');
assert.equal(whole.textStyleId,'style:1'); assert.equal(whole.fillStyleId,'paint:1'); assert.equal(whole.boundVariables.fontSize.id,'variable:1');
const mixedReplacement = await run(5, { stepId:'all',op:'setText',target:{nodeId:first.id},characters:'new',expected:expected(first) });
assert.equal(mixedReplacement.error.code,'CAPABILITY_UNAVAILABLE'); assert.equal(first.characters,'abcxTAIL');
whole.boundVariables.characters = alias;
const boundCharacters = await run(6, { stepId:'all',op:'setText',target:{nodeId:whole.id},characters:'wrong',expected:expected(whole) });
assert.equal(boundCharacters.error.code,'CAPABILITY_UNAVAILABLE'); assert.equal(whole.characters,'new');
console.log('Text bindings: unaffected tail, inherited links, conflicting edits and setText OK');
const readFields = ['fontName','fontSize','lineHeight','letterSpacing','fills','textStyleId','fillStyleId','boundVariables'];
const oldSegments = structuredClone(first.getStyledTextSegments(readFields));
first.records[4].textStyleId = 'style:changed';
const stale = await run(7, { stepId:'r',op:'replaceTextRange',target:{nodeId:first.id},start:0,end:1,text:'q',insertionFormatting:{inherit:'AFTER'},expected:{characters:first.characters,textSegments:oldSegments} });
assert.equal(stale.error.code,'CONFLICT'); assert.equal(first.characters,'abcxTAIL');
const beforeSize = first.records[4].fontSize;
const refusedPatch = await run(8, { stepId:'r',op:'replaceTextRange',target:{nodeId:first.id},start:3,end:3,text:'q',insertionFormatting:{inherit:'AFTER',format:{fontSize:30}},expected:expected(first) });
assert.equal(refusedPatch.error.code,'CAPABILITY_UNAVAILABLE'); assert.equal(first.records[4].fontSize,beforeSize); assert.equal(first.characters,'abcxTAIL');
const rename = await run(9, { stepId:'name',op:'updateNode',type:'TEXT',target:{nodeId:whole.id},patch:{name:'Changed'},expected:{name:'Text'} });
assert.equal(rename.status,'succeeded'); assert.equal(whole.textStyleId,'style:1'); assert.equal(whole.boundVariables.fontSize.id,'variable:1');
const blockedSize = await run(10, { stepId:'size',op:'updateNode',type:'TEXT',target:{nodeId:whole.id},patch:{fontSize:30},expected:{name:'Changed'} });
assert.equal(blockedSize.error.code,'CAPABILITY_UNAVAILABLE');
const boundSpan = makeNode('xy', [ { ...raw(), boundVariables: { characters: alias } }, raw() ]);
nodes.set(boundSpan.id, boundSpan);
const blockedCharacters = await run(11, { stepId:'r',op:'replaceTextRange',target:{nodeId:boundSpan.id},start:0,end:1,text:'z',insertionFormatting:{inherit:'AFTER'},expected:expected(boundSpan) });
assert.equal(blockedCharacters.error.code,'CAPABILITY_UNAVAILABLE'); assert.equal(boundSpan.characters,'xy');
