import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const [pngPath, svgPath] = process.argv.slice(2);
if (!pngPath || !svgPath) throw new Error('Укажите пути PNG и SVG');
const png = await readFile(pngPath);
const svg = await readFile(svgPath, 'utf8');
const server = new McpServer({ name: 'export-probe', version: '0.1.0' });
server.registerTool('export_png', { description: 'Тестовый PNG' }, async () => ({
  content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }],
}));
server.registerResource('export_svg', 'probe://export.svg', { mimeType: 'image/svg+xml' }, async uri => ({
  contents: [{ uri: uri.href, mimeType: 'image/svg+xml', text: svg }],
}));
await server.connect(new StdioServerTransport());
