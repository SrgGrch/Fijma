import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/client';
import { WebSocket } from 'ws';

await build({ stdin: { contents: "export {createPairingListener} from './server/pairing-listener'; export {createServer} from './server/catalog'; export {bootstrapLimits} from './shared/bootstrap-limits';", resolveDir: process.cwd(), sourcefile: 'diagnostics-test-entry.ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'dist/diagnostics-runtime-test.mjs' });
const { createPairingListener, createServer, bootstrapLimits } = await import(pathToFileURL(resolve('dist/diagnostics-runtime-test.mjs')).href);
const secret = 'a'.repeat(64), text = 'PRIVATE_FIGMA_TEXT', image = 'PRIVATE_IMAGE_BYTES';
const bytes = Buffer.alloc(33 + image.length);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]).copy(bytes);
bytes.writeUInt32BE(1, 16); bytes.writeUInt32BE(1, 20); bytes.write(image, 33);

class LocalTransport {
  async start() {}
  async send(message) { queueMicrotask(() => this.peer.onmessage?.(message)); }
  async close() { this.onclose?.(); }
}
for (const enabled of [false, true]) {
  if (enabled) process.env.FIGMA_MCP_DIAGNOSTICS_TTL_MS = '30000';
  else delete process.env.FIGMA_MCP_DIAGNOSTICS_TTL_MS;
  const listener = await createPairingListener(secret, 0);
  const server = createServer(() => listener.getContext(), args => listener.getTree(args), args => listener.findNodes(args),
    args => listener.getNodes(args), args => listener.getLocalResources(args), args => listener.navigate(args), async args => {
      const result = await listener.exportNode(args);
      if (result.error) return result;
      return { sessionId: result.sessionId, nodeId: result.nodeId, format: 'PNG', mimeType: 'image/png', bytes: result.bytes, width: result.width, height: result.height, data: result.data.toString('base64') };
    });
  const client = new Client({ name: 'diagnostics-runtime-test', version: '1' });
  const serverTransport = new LocalTransport(), clientTransport = new LocalTransport();
  serverTransport.peer = clientTransport; clientTransport.peer = serverTransport;
  let socket;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let ready;
    const connected = new Promise(resolve => { ready = resolve; });
    socket = new WebSocket(`ws://127.0.0.1:${listener.address.port}`);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'pair', secret })));
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'paired') socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, sessionId: 'trusted-session', capabilities: ['getContext', 'getNodes', 'exportNode', 'applyBatch'], limits: bootstrapLimits, writeEnabled: false }));
      else if (message.type === 'welcome') ready(message);
      else if (message.type === 'getContext') socket.send(JSON.stringify({ type: 'context', requestId: message.requestId, sessionId: message.sessionId, connectionGeneration: message.connectionGeneration, document: { documentLabel: text, pages: [{ id: '0:1', name: text }], currentPageId: '0:1', selection: [] } }));
      else if (message.type === 'command' && message.command === 'applyBatch') socket.send(JSON.stringify({ type: 'operationResult', sessionId: message.sessionId, connectionGeneration: message.connectionGeneration, requestId: message.requestId, operationId: message.operationId, data: { sessionId: message.sessionId, connectionGeneration: message.connectionGeneration, operationId: message.operationId, status: 'succeeded', steps: [], affectedNodeIds: ['1:1'], affectedResourceIds: [], warnings: [secret] } }));
      else if (message.type === 'command' && message.command === 'getNodes') {
        const envelope = { type: 'nodesResult', sessionId: message.sessionId, connectionGeneration: message.connectionGeneration, operationId: message.operationId };
        if (message.params.nodeIds.includes('font')) socket.send(JSON.stringify({ ...envelope, error: { code: 'FONT_UNAVAILABLE', message: secret, recoveryAction: secret, details: { fonts: [{ family: 'Inter', style: 'Regular' }] } } }));
        else if (message.params.nodeIds.includes('font-secret')) socket.send(JSON.stringify({ ...envelope, error: { code: 'FONT_UNAVAILABLE', message: secret, recoveryAction: secret, details: { fonts: [{ family: secret, style: 'Regular' }] } } }));
        else if (message.params.nodeIds.includes('missing')) socket.send(JSON.stringify({ ...envelope, error: { code: 'NODE_NOT_FOUND', message: `${secret} ${text} ${image}`, recoveryAction: secret, details: { property: image } } }));
        else if (message.params.nodeIds.includes(secret)) socket.send(JSON.stringify({ ...envelope, data: { nodes: [{ nodeId: secret, error: { code: 'NODE_NOT_FOUND', message: `${secret} ${text} ${image}`, recoveryAction: secret, details: { property: image } } }] } }));
        else socket.send(JSON.stringify({ ...envelope, data: { nodes: [{ nodeId: '1:1', type: 'TEXT', properties: { characters: text }, mixed: [], unavailable: [] }] } }));
      } else if (message.type === 'command' && message.command === 'exportNode') {
        const envelope = { sessionId: message.sessionId, connectionGeneration: message.connectionGeneration, operationId: message.operationId };
        socket.send(JSON.stringify({ type: 'exportStart', ...envelope, nodeId: '1:1', format: 'PNG', bytes: bytes.length, total: 1, chunkBytes: 12288, width: 1, height: 1 }));
        socket.send(JSON.stringify({ type: 'exportChunk', ...envelope, index: 0, total: 1, data: bytes.toString('base64') }));
      }
    });
    const binding = await connected;
    const scope = { sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration };
    assert.equal((await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent.documentLabel, text);
    assert.equal((await client.callTool({ name: 'figma_get_nodes', arguments: { scope, nodeIds: ['1:1'], fields: ['characters'] } })).structuredContent.nodes[0].properties.characters, text);
    const exported = await client.callTool({ name: 'figma_export_node', arguments: { scope, nodeId: '1:1', format: 'PNG' } });
    assert.deepEqual(Buffer.from(exported.content.find(item => item.type === 'image').data, 'base64'), bytes);
    const failure = await client.callTool({ name: 'figma_get_nodes', arguments: { scope, nodeIds: ['missing'], fields: ['name'] } });
    assert.equal(failure.isError, true);
    assert.equal(failure.structuredContent.error.code, 'NODE_NOT_FOUND');
    for (const sentinel of [secret, text, image]) assert.equal(JSON.stringify(failure).includes(sentinel), false);
    const itemFailure = await client.callTool({ name: 'figma_get_nodes', arguments: { scope, nodeIds: [secret], fields: ['name'] } });
    assert.equal(itemFailure.structuredContent.nodes[0].error.code, 'NODE_NOT_FOUND');
    assert.equal(itemFailure.structuredContent.nodes[0].nodeId, '[redacted]');
    for (const sentinel of [secret, text, image]) assert.equal(JSON.stringify(itemFailure).includes(sentinel), false);
    const report = listener.readDiagnostics();
    assert.deepEqual(report.entries.map(item => item.action), ['getContext', 'getNodes', 'exportNode', 'getNodes', 'getNodes']);
    assert.deepEqual(report.entries.map(item => item.status), ['succeeded', 'succeeded', 'succeeded', 'failed', 'succeeded']);
    assert.ok(report.entries.every(item => item.sessionId === 'trusted-session' && item.affectedNodeIds.length === 0 && item.affectedResourceIds.length === 0));
    assert.equal(report.extendedEnabled, enabled);
    assert.equal(report.extended.length, enabled ? 1 : 0);
    for (const sentinel of [secret, text, image, bytes.toString('base64'), 'missing']) assert.equal(JSON.stringify(report).includes(sentinel), false);
    const font = await client.callTool({ name: 'figma_get_nodes', arguments: { scope, nodeIds: ['font'], fields: ['name'] } });
    assert.deepEqual(font.structuredContent.error.details, { fonts: [{ family: 'Inter', style: 'Regular' }] });
    const fontSecret = await client.callTool({ name: 'figma_get_nodes', arguments: { scope, nodeIds: ['font-secret'], fields: ['name'] } });
    assert.equal(fontSecret.structuredContent.error.details, undefined);
    assert.equal(JSON.stringify(fontSecret).includes(secret), false);
    const operationId = '019a4a10-0000-7000-8000-000000000001';
    const operation = await listener.applyBatch({ scope, operationId, steps: [{ stepId: 'x', op: 'createPage', name: text }] });
    assert.equal(operation.status, 'succeeded');
    assert.deepEqual(operation.warnings, []);
    assert.equal(listener.readDiagnostics().entries.at(-1).action, 'applyBatch');
    assert.deepEqual(listener.readDiagnostics().entries.at(-1).affectedNodeIds, ['1:1']);
    assert.equal(JSON.stringify(listener.readDiagnostics()).includes(secret), false);
    assert.equal(JSON.stringify(listener.readDiagnostics()).includes(text), false);
    listener.clearDiagnostics();
    assert.deepEqual(listener.readDiagnostics(), { entries: [], extended: [], extendedEnabled: false });
    await client.callTool({ name: 'figma_get_context', arguments: {} });
    assert.equal(listener.readDiagnostics().entries.length, 1);
    socket.close();
    await new Promise(resolve => socket.once('close', resolve));
    const deadline = Date.now() + 2000;
    while (listener.getBinding()) { if (Date.now() >= deadline) throw new Error('Listener did not release binding'); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.deepEqual(listener.readDiagnostics(), { entries: [], extended: [], extendedEnabled: false });
  } finally {
    socket?.terminate();
    await client.close(); await server.close(); await listener.close();
  }
}
delete process.env.FIGMA_MCP_DIAGNOSTICS_TTL_MS;
console.log('Diagnostics runtime: SDK and WS metadata, safe errors, opt-in and lifecycle OK');

