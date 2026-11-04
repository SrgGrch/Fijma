import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/server/index.js'], env: process.env, stderr: 'pipe' });
const client = new Client({ name: 'manual-desktop-check', version: '0.1.0' });
const diagnostics = createInterface({ input: transport.stderr });
diagnostics.on('line', line => {
  if (/^(Файл сопряжения: |Локальный мост: ws:\/\/127\.0\.0\.1:)/.test(line)) process.stderr.write(`${line}\n`);
});
let directory, sequence = 0;
async function save(base64, mimeType) {
  // Bound local export files even if a server returns more than its advertised limit.
  if (base64.length > 4 * 1024 * 1024) throw new Error('Export exceeds manual client limit');
  const bytes = Buffer.from(base64, 'base64');
  directory ??= await mkdtemp(join(tmpdir(), 'figma-mcp-manual-'));
  const path = join(directory, `export-${++sequence}.${mimeType === 'image/png' ? 'png' : 'svg'}`);
  await writeFile(path, bytes, { flag: 'wx' });
  return { path, bytes: bytes.length, mimeType };
}

try {
  await client.connect(transport);
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    try {
      const request = JSON.parse(line);
      if (request.action === 'quit') break;
      let result;
      if (request.action === 'readResource' && typeof request.uri === 'string') {
        result = await client.readResource({ uri: request.uri });
        result.contents = await Promise.all(result.contents.map(async item => item.blob
          ? { uri: item.uri, ...await save(item.blob, item.mimeType) } : item));
      } else if (typeof request.name === 'string' && request.arguments && typeof request.arguments === 'object' && !Array.isArray(request.arguments)) {
        result = await client.callTool({ name: request.name, arguments: request.arguments });
        if (request.name === 'figma_export_node' && result.structuredContent?.data) {
          const { data, ...metadata } = result.structuredContent;
          result.structuredContent = { ...metadata, file: await save(data, metadata.mimeType) };
          result.content = result.content.filter(item => item.type !== 'image' && item.type !== 'text');
        }
      } else throw new Error('Expected {name, arguments}, {action: "readResource", uri}, or {action: "quit"}');
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed' })}\n`);
    }
  }
} finally {
  await client.close();
  diagnostics.close();
}
