import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints:['plugin/graphics-ops.ts','shared/batch-executor.ts','shared/operation-journal.ts'],outdir:'out',bundle:true,format:'esm',platform:'node',write:false });
const load=async n=>import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[n].text).toString('base64')}`);
const {graphicsOperations}=await load(0),{BatchExecutor}=await load(1),{OperationJournal}=await load(2);
let seq=0, created=0, calls=0; const all=new Map();
function make(type,parent=null){const n={id:`n${++seq}`,type,name:type,parent:null,children:[],async loadAsync(){},appendChild(child){if(child.parent){const i=child.parent.children.indexOf(child);if(i>=0)child.parent.children.splice(i,1);}child.parent=this;this.children.push(child);},resize(w,h){this.width=w;this.height=h;}};all.set(n.id,n);if(parent)parent.appendChild(n);return n;}
const page=make('PAGE'),parent=make('FRAME',page),other=make('FRAME',page),one=make('RECTANGLE',parent),two=make('ELLIPSE',other);
const api={mixed:Symbol(),getNodeByIdAsync:async id=>all.get(id),base64Decode:s=>new Uint8Array(Buffer.from(s,'base64')),base64Encode:b=>Buffer.from(b).toString('base64'),createImage(){created++;return {hash:'hash1'}},createRectangle(){created++;return make('RECTANGLE',page)},createNodeFromSvg(){created++;return make('FRAME',page)}};
for(const kind of ['union','subtract','intersect','exclude']) api[kind]=(nodes,p)=>{calls++;const n=make('BOOLEAN_OPERATION',p);for(const item of nodes)n.appendChild(item);return n;};
const ops=graphicsOperations(api,{maxImportBytes:256}),now=Date.now(),hex=now.toString(16).padStart(12,'0');
const executor=new BatchExecutor(new OperationJournal({dedupTtl:10000,clockSkew:10,maxJournalEntries:80}),{...ops,checkScope(){},commitUndo(){}},10);
let i=0;const run=steps=>executor.submit({sessionId:'s',connectionGeneration:1},`${hex.slice(0,8)}-${hex.slice(8)}-7000-8000-${String(++i).padStart(12,'0')}`,steps,now);
const svg=value=>({stepId:'svg',op:'importSvg',parent:{nodeId:parent.id},svg:value});
for(const bad of ['<svg><script/></svg>','<svg onload="alert(1)"/>','<svg><path fill="url(https://evil)"/></svg>','<svg><use href="//evil"/></svg>','<svg><use href="&#x68;ttps://evil"/></svg>','<!DOCTYPE svg [<!ENTITY x SYSTEM "http://evil">]><svg>&x;</svg>','<svg><foreignObject/></svg>','<svg><path fill="u\\72l(http://evil)"/></svg>','<svg><path></svg>']) {
  assert.throws(()=>run([svg(bad)]), e=>e.message==='INVALID_ARGUMENT');
}
assert.throws(()=>run([svg('<svg><filter/></svg>')]),e=>e.message==='CAPABILITY_UNAVAILABLE');
assert.throws(()=>run([svg(`<svg>${'x'.repeat(300)}</svg>`)]),e=>e.message==='RESOURCE_LIMIT');
assert.equal(created,0);
let result=await run([svg('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="20" height="20" fill="url(#a)"/></svg>')]);
assert.equal(result.status,'succeeded'); assert.equal(all.get(result.steps[0].outputs.nodeId).parent,parent);
const img=(data,mimeType='image/png')=>({stepId:'image',op:'importImage',parent:{nodeId:parent.id},data,mimeType,placement:{x:2,y:3,width:20,height:30}});
const png=Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64');
assert.throws(()=>run([img(png,'image/jpeg')]),e=>e.message==='INVALID_ARGUMENT');
assert.throws(()=>run([img('file:///test.png')]),e=>e.message==='INVALID_ARGUMENT');
const webp=Buffer.from('RIFF0000WEBP').toString('base64'); assert.throws(()=>run([img(webp,'image/webp')]),e=>e.message==='CAPABILITY_UNAVAILABLE');
assert.throws(()=>run([img(Buffer.alloc(257).toString('base64'))]),e=>e.message==='RESOURCE_LIMIT');
const before=created; assert.throws(()=>run([svg('<svg/>'),{...svg('<svg><script/></svg>'),stepId:'bad-svg'}]),e=>e.message==='INVALID_ARGUMENT'); assert.equal(created,before);
result=await run([img(png)]);assert.equal(result.status,'succeeded');const imageNode=all.get(result.steps[0].outputs.nodeId);assert.equal(imageNode.fills[0].imageHash,'hash1');assert.equal(imageNode.parent,parent);assert.deepEqual(result.steps[0].appliedChanges.details,[{kind:'image',imageHash:'hash1'}]);
const failParent=make('FRAME',page);failParent.appendChild=()=>{throw Error('failure')};result=await run([{...img(png),parent:{nodeId:failParent.id}}]);assert.equal(result.status,'partially_applied');assert.equal(result.steps[0].appliedChanges.details[0].imageHash,'hash1');assert.equal(result.affectedNodeIds.length,1);
for(const kind of ['union','subtract','intersect','exclude']){const a=make('RECTANGLE',parent),b=make('ELLIPSE',other);result=await run([{stepId:'boolean',op:'booleanNodes',kind,targets:[{nodeId:a.id},{nodeId:b.id}],parent:{nodeId:parent.id},expected:{parentId:parent.id,related:{[b.id]:{parentId:other.id}}}}]);assert.equal(result.status,'succeeded');assert.equal(all.get(result.steps[0].outputs.nodeId).type,'BOOLEAN_OPERATION');assert(result.affectedNodeIds.includes(other.id));}
const beforeCalls=calls;const foreign=make('RECTANGLE',make('PAGE'));result=await run([{stepId:'bad',op:'booleanNodes',kind:'union',targets:[{nodeId:one.id},{nodeId:foreign.id}],parent:{nodeId:parent.id},expected:{name:one.name}}]);assert.equal(result.error.code,'INVALID_ARGUMENT');assert.equal(calls,beforeCalls);
const failA=make('RECTANGLE',parent),failB=make('ELLIPSE',other);
api.union=(nodes,p)=>{const partial=make('BOOLEAN_OPERATION',p);partial.appendChild(nodes[0]);throw Error('native failed after mutation')};
result=await run([{stepId:'partial-boolean',op:'booleanNodes',kind:'union',targets:[{nodeId:failA.id},{nodeId:failB.id}],parent:{nodeId:parent.id},expected:{parentId:parent.id}}]);
assert.equal(result.status,'partially_applied'); assert(result.affectedNodeIds.includes(failA.id)); assert(result.affectedNodeIds.includes(failA.parent.id));
console.log('Graphics: safe SVG, byte limits/MIME, imports, all booleans and partial changes OK');
