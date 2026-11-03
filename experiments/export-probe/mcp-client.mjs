import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [pngPath, svgPath] = process.argv.slice(2);
if (!pngPath || !svgPath) throw new Error('Укажите пути PNG и SVG');
const expectedPng = await readFile(pngPath);
const expectedSvg = await readFile(svgPath, 'utf8');
const client = new Client({ name: 'export-probe-client', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['experiments/export-probe/mcp-server.mjs', pngPath, svgPath] }));
  const image = (await client.callTool({ name: 'export_png', arguments: {} })).content[0];
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.data, 'base64'), expectedPng);
  const resource = (await client.readResource({ uri: 'probe://export.svg' })).contents[0];
  assert.equal(resource.mimeType, 'image/svg+xml');
  assert.equal(resource.text, expectedSvg);
  console.log('PNG image block и SVG resource получены без изменения данных');
} finally {
  await client.close();
}
