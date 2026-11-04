import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built=await build({entryPoints:['plugin/scene-ops.ts','plugin/text-ops.ts','shared/batch-executor.ts','shared/operation-journal.ts'],outdir:'out',bundle:true,format:'esm',platform:'node',write:false});
const load=async i=>import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[i].text).toString('base64')}`);
const {pageOperations}=await load(0),{textOperations}=await load(1),{BatchExecutor}=await load(2),{OperationJournal}=await load(3);
let seq=0;const map=new Map(),font={family:'Inter',style:'Regular'};
function node(type){const n={id:`n${++seq}`,type,name:type,children:[],parent:null,characters:'',fontName:font,fills:[],strokes:[],effects:[],opacity:1,locked:false,boundVariables:{},fillStyleId:'',strokeStyleId:'',effectStyleId:'',getStyledTextSegments(){return []},getRangeAllFontNames(){return [font]},resize(){},appendChild(c){this.children.push(c);c.parent=this;}};map.set(n.id,n);return n;}
const parent=node('FRAME');const api={mixed:Symbol(),root:{children:[]},getNodeByIdAsync:async id=>map.get(id),loadFontAsync:async()=>{},createRectangle:()=>node('RECTANGLE'),createText:()=>node('TEXT')};
const now=Date.now(),hex=now.toString(16).padStart(12,'0');let n=0;function executor(ops){const e=new BatchExecutor(new OperationJournal({dedupTtl:10000,clockSkew:10,maxJournalEntries:20}),{...ops,checkScope(){},commitUndo(){}},10);return step=>e.submit({sessionId:'s',connectionGeneration:1},`${hex.slice(0,8)}-${hex.slice(8)}-7000-8000-${String(++n).padStart(12,'0')}`,[step],now);}
const scene=executor(pageOperations(api)),text=executor(textOperations(api)); const fill=[{type:'SOLID',color:{r:1,g:0,b:0,a:.5}}];
for(const [type,run] of [['RECTANGLE',scene],['TEXT',text]]){
 let result=await run({stepId:'create',op:'createNode',type,parent:{nodeId:parent.id},properties:{fills:fill,locked:true,...(type==='TEXT'?{fontName:font,characters:'Hello'}:{})}});assert.equal(result.status,'succeeded');const created=map.get(result.steps[0].outputs.nodeId);assert.equal(created.fills[0].opacity,.5);assert.equal(created.locked,true);
 created.strokeStyleId='existing';created.boundVariables.width={type:'VARIABLE_ALIAS',id:'v'};
 result=await run({stepId:'update',op:'updateNode',type,target:{nodeId:created.id},patch:{name:'updated',opacity:.4},expected:{name:type}});assert.equal(result.status,'succeeded');assert.equal(created.opacity,.4);assert.equal(created.strokeStyleId,'existing');assert(created.boundVariables.width);assert.equal(created.locked,true);
 created.fillStyleId='linked';result=await run({stepId:'reject',op:'updateNode',type,target:{nodeId:created.id},patch:{name:'must-not-write',fills:[]},expected:{name:'updated'}});assert.equal(result.error.code,'CAPABILITY_UNAVAILABLE');assert.equal(created.name,'updated');
}
console.log('Scene and text appearance: create, partial update, locked and existing links OK');
