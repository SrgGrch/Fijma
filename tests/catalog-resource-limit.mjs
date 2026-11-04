import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/client';
const built = await build({ entryPoints:['server/catalog.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',write:false });
const module={exports:{}}, require=createRequire(import.meta.url);new Function('require','module','exports',built.outputFiles[0].text)(require,module,module.exports);
const transport = () => ({async start(){},async send(message){queueMicrotask(()=>this.peer.onmessage?.(message));},async close(){this.onclose?.();this.peer.onclose?.();}});
const a=transport(),b=transport();a.peer=b;b.peer=a;
const fail=async()=>{throw Error('RESOURCE_LIMIT')};
const server=module.exports.createServer(undefined,fail,undefined,undefined,undefined,undefined,fail,undefined,fail);
const client=new Client({name:'limit-error-test',version:'1'});
try {
 await server.connect(a); await client.connect(b);
 const scope={sessionId:'s',connectionGeneration:1};
 for (const [name,args] of [
  ['figma_get_tree',{scope,rootId:'p',depth:1,limit:10}],
  ['figma_export_node',{scope,nodeId:'n',format:'PNG'}],
  ['figma_apply_batch',{scope,operationId:'019a4a10-0000-7000-8000-000000000001',steps:[{stepId:'p',op:'createPage',name:'Page'}]}],
 ]) {
  const result=await client.callTool({name,arguments:args});assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'RESOURCE_LIMIT');
  assert.match(result.structuredContent.error.recoveryAction,/Уменьшите/);assert.doesNotMatch(result.structuredContent.error.recoveryAction,/Переподключ/i);
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
 }
 console.log('Catalog SDK: RESOURCE_LIMIT structured result recommends smaller request, batch or export OK');
} finally {await client.close();await server.close();}
