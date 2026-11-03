import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/server/index.js'], env: { ...process.env, FIGMA_MCP_PORT: '0' }, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', data => diagnostics += data.toString());
const client = new Client({ name: 'export-test', version: '0.1.0' });
const sockets = [];
let secretPath;
try {
  await client.connect(transport);
  secretPath = diagnostics.match(/Файл сопряжения: ([^\r\n]+)/)[1];
  const url = diagnostics.match(/Локальный мост: (ws:\/\/[^\r\n]+)/)[1];
  const token = await readFile(secretPath, 'utf8');
  const main = await readFile('dist/plugin/main.js', 'utf8');
  const html = await readFile('dist/plugin/ui.html', 'utf8');
  const elements = Object.fromEntries(['secret', 'connect', 'disconnect', 'status', 'document'].map(id => [id, { value: '', textContent: '' }]));
  const chunk = (name, body) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    let value = 0xffffffff;
    for (const byte of Buffer.concat([type, body])) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, type, body, crc]);
  };
  const png = (extra = 0) => {
    const header = Buffer.alloc(13); header.writeUInt32BE(10, 0); header.writeUInt32BE(10, 4); header[8] = 8; header[9] = 6;
    const rows = Buffer.alloc(10 * (1 + 10 * 4));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
      ...(extra ? [chunk('tEXt', Buffer.concat([Buffer.from('note\0'), Buffer.alloc(extra, 65)]))] : []),
      chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  };
  let output = png(), yielded = 0;
  const node = { id: '1:1', name: 'Export', type: 'FRAME', absoluteRenderBounds: { width: 10, height: 10 }, async exportAsync() { return output; } };
  const page = { id: '0:1', name: 'Page', type: 'PAGE', selection: [], children: [node], async loadAsync() {}, on() {} };
  node.parent = page;
  let ui, resolveBound;
  let bound = new Promise(resolve => resolveBound = resolve);
  const figma = { root: { name: 'Document', children: [page] }, currentPage: page, mixed: Symbol('mixed'),
    getNodeByIdAsync: async id => id === node.id ? node : null, base64Encode: bytes => Buffer.from(bytes).toString('base64'), showUI() {},
    ui: { postMessage(message) { queueMicrotask(() => { if (message.type === 'yield') yielded++; ui.onmessage({ data: { pluginMessage: message } }); if (message.type === 'bound') resolveBound(message); }); } } };
  runInNewContext(main, { figma, __html__: '' });
  class Socket extends WebSocket { constructor() { super(url); sockets.push(this); } }
  ui = { document: { getElementById: id => elements[id] }, WebSocket: Socket,
    parent: { postMessage: ({ pluginMessage }) => queueMicrotask(() => figma.ui.onmessage(pluginMessage)) } };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
  const connect = async () => {
    elements.secret.value = token; elements.connect.onclick();
    let deadline;
    try { return await Promise.race([bound, new Promise((_, reject) => deadline = setTimeout(() => reject(new Error('Handshake timeout')), 5000))]); }
    finally { clearTimeout(deadline); }
  };
  let binding = await connect();
  let scope = { sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration };
  const call = (format, scale) => client.callTool({ name: 'figma_export_node', arguments: { scope, nodeId: node.id, format, ...(scale === undefined ? {} : { scale }) } });
  const small = await call('PNG');
  assert.equal(small.structuredContent.width, 10);
  assert.equal(small.content.find(item => item.type === 'image').data, output.toString('base64'));
  output = png(70000);
  const large = await call('PNG');
  assert.equal(large.structuredContent.bytes, output.length);
  assert.ok(output.length > 65536);
  assert.ok(large.structuredContent.uri);
  assert.equal(large.content.find(item => item.type === 'resource_link').uri, large.structuredContent.uri);
  assert.deepEqual(Buffer.from((await client.readResource({ uri: large.structuredContent.uri })).contents[0].blob, 'base64'), output);
  assert.ok(yielded >= 5);
  output = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const svg = await call('SVG');
  assert.equal(svg.structuredContent.mimeType, 'image/svg+xml');
  assert.deepEqual(Buffer.from((await client.readResource({ uri: svg.structuredContent.uri })).contents[0].blob, 'base64'), output);
  assert.equal((await call('SVG', 2)).structuredContent.error.code, 'INVALID_ARGUMENT');
  output = png(262145);
  assert.equal((await call('PNG')).structuredContent.error.code, 'RESOURCE_LIMIT');
  const oldUri = svg.structuredContent.uri;
  elements.disconnect.onclick();
  await new Promise(resolve => sockets.at(-1).once('close', resolve));
  bound = new Promise(resolve => resolveBound = resolve);
  binding = await connect(); scope = { sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration };
  await assert.rejects(client.readResource({ uri: oldUri }), /RESOURCE_EXPIRED/);
  elements.disconnect.onclick();
  console.log('Export bridge: MCP image, chunked PNG, SVG resource and reconnect cleanup OK');
} finally {
  for (const socket of sockets) socket.terminate();
  await client.close();
}
await assert.rejects(readFile(secretPath));
