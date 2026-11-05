import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { build } from 'esbuild';
const built=await build({entryPoints:['server/pairing-listener.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',write:false});
const module={exports:{}},require=createRequire(import.meta.url);new Function('require','module','exports',built.outputFiles[0].text)(require,module,module.exports);
const server=await module.exports.createPairingListener('a'.repeat(64),0);let socket;
try {
 socket=new WebSocket(`ws://127.0.0.1:${server.address.port}`);await once(socket,'open');let next=once(socket,'message');socket.send(JSON.stringify({type:'pair',secret:'a'.repeat(64)}));await next;
 const limits={maxMessageBytes:512,maxBatchSteps:10,maxQueuedOperations:2,maxDepth:8,maxNodes:1000,maxResponseBytes:32768,maxImportBytes:262144,maxExportPixels:1000000,maxExportBytes:262144,operationTimeout:30000,dedupTtl:60000,maxJournalEntries:100,resourceTtl:60000,clockSkew:5000};
 next=once(socket,'message');socket.send(JSON.stringify({type:'hello',protocolVersion:2,sessionId:'s',capabilities:['getContext','getNodes','applyBatch','getOperation'],limits,writeEnabled:false}));const welcome=JSON.parse((await next)[0]);const scope={sessionId:'s',connectionGeneration:welcome.connectionGeneration};
 next=once(socket,'message');const ready=server.getContext();let request=JSON.parse((await next)[0]);socket.send(JSON.stringify({type:'context',requestId:request.requestId,...scope,document:{documentLabel:'Test',currentPageId:'p',pages:[{id:'p',name:'Page'}],selection:[]}}));await ready;
 const stamp=Date.now().toString(16).padStart(12,'0'),id=`${stamp.slice(0,8)}-${stamp.slice(8)}-7000-8000-000000000001`;
 const bad={scope,operationId:id,steps:[{stepId:'a',op:'createPage',name:'safe'},{stepId:'b',op:'createPage',name:'界'.repeat(300)}]};
 let received=0;socket.on('message',()=>received++);
 await assert.rejects(server.applyBatch(bad),/RESOURCE_LIMIT/);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(received,0);
 const envelope={type:'command',...scope,operationId:id,command:'getNodes',params:{nodeIds:[''],fields:['name']}};
 const base=Buffer.byteLength(JSON.stringify(envelope)), multibyte='界'.repeat(Math.floor((512-base)/3));const value=multibyte+'x'.repeat(512-base-Buffer.byteLength(multibyte));
 assert.equal(Buffer.byteLength(JSON.stringify({...envelope,params:{...envelope.params,nodeIds:[value]}})),512);
 next=once(socket,'message');const ok=server.getNodes({scope,nodeIds:[value],fields:['name']});request=JSON.parse((await next)[0]);
 socket.send(JSON.stringify({type:'nodesResult',...scope,operationId:request.operationId,data:{nodes:[]}}));assert.deepEqual(await ok,{nodes:[]});
 await assert.rejects(server.getNodes({scope,nodeIds:[value+'x'],fields:['name']}),/RESOURCE_LIMIT/);
 console.log('Listener: negotiated exact UTF-8 boundary, oversized batch and reads rejected before send OK');
} finally {socket?.terminate();await server.close();}
