import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
const built = await build({ entryPoints:['shared/protocol.ts','plugin/candidate.ts'], bundle:true, format:'esm', target:'es2017', outdir:'out', write:false });
const protocol = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
for (const value of ['', 'ASCII', '汉字', 'a😀b', '\ud800', '\udc00', '\ud800x', '\u0000']) {
  assert.equal(protocol.utf8Bytes(value), Buffer.byteLength(value));
  assert.equal(protocol.jsonMessageBytes({ value }), Buffer.byteLength(JSON.stringify({ value })));
}
const messages=[],nodes=new Map();let count=0;
const figma={root:{name:'test',children:[]},currentPage:{id:'p',selection:[]},showUI(){},getNodeByIdAsync:async id=>nodes.get(id),createPage(){const n={id:`n${++count}`,type:'PAGE',name:''};nodes.set(n.id,n);return n},commitUndo(){},ui:{postMessage(m){if(m.type==='yield')setImmediate(()=>figma.ui.onmessage(m));else messages.push(m)}}};
runInNewContext(built.outputFiles[1].text,{figma,__html__:'',setTimeout,clearTimeout});
await figma.ui.onmessage({type:'hello-request'});const hello=messages.pop();
await figma.ui.onmessage({...hello,type:'welcome',connectionGeneration:1,limits:{...hello.limits,maxMessageBytes:512}});messages.pop();
await figma.ui.onmessage({type:'setWriteEnabled',enabled:true});messages.pop();
const h=Date.now().toString(16).padStart(12,'0'),operationId=`${h.slice(0,8)}-${h.slice(8)}-7000-8000-000000000001`;
const cmd={type:'command',sessionId:hello.sessionId,connectionGeneration:1,operationId,command:'applyBatch',params:{steps:[{stepId:'new',op:'createPage',name:''}]}};
const base=Buffer.byteLength(JSON.stringify(cmd)); const payload='汉'.repeat(Math.floor((512-base)/3));cmd.params.steps[0].name=payload+'x'.repeat(512-base-Buffer.byteLength(payload));
assert.equal(Buffer.byteLength(JSON.stringify(cmd)),512);
const oversize={...cmd,operationId:operationId.replace(/1$/,'2'),params:{steps:[{stepId:'first',op:'createPage',name:'safe'},{stepId:'last',op:'createPage',name:'x'.repeat(512)}]}};
await figma.ui.onmessage(oversize);assert.equal(messages.pop().data.error.code,'RESOURCE_LIMIT');assert.equal(count,0);
await figma.ui.onmessage(cmd);assert.equal(messages.pop().data.status,'succeeded');assert.equal(count,1);
const above={...cmd,operationId:operationId.replace(/1$/,'3'),params:{steps:[{...cmd.params.steps[0],name:cmd.params.steps[0].name+'x'}]}};
await figma.ui.onmessage(above);assert.equal(messages.pop().data.error.code,'RESOURCE_LIMIT');assert.equal(count,1);
console.log('Message bytes: UTF-8, JSON escapes, lower negotiated exact boundary and pre-write rejection OK');
