import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './catalog';
import { createPairingFile } from './pairing-file';
import { createPairingListener } from './pairing-listener';
import { ExportResourceStore } from './export-resources';
import { exportChunkBytes } from '../shared/export-wire';

const pairing = await createPairingFile();
let listener;
let resources: ExportResourceStore | undefined;
try {
  const port = Number(process.env.FIGMA_MCP_PORT ?? 55263);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  listener = await createPairingListener(pairing.secret, port, undefined, binding => {
    resources?.close(); resources = undefined;
    if (binding) {
      resources = new ExportResourceStore({ ttl: binding.limits.resourceTtl, maxEntries: 16,
        maxBytes: binding.limits.maxExportBytes * 4, maxResourceBytes: binding.limits.maxExportBytes });
      resources.beginSession(binding.sessionId);
    }
  });
} catch {
  await pairing.dispose();
  process.stderr.write('Не удалось запустить локальный мост. Проверьте порт и права пользователя.\n');
  process.exit(1);
}
process.stderr.write(`Файл сопряжения: ${pairing.path}\n`);
process.stderr.write(`Локальный мост: ws://127.0.0.1:${listener.address.port}\n`);
const server = createServer(() => listener.getContext(), args => listener.getTree(args), args => listener.findNodes(args),
  args => listener.getNodes(args), args => listener.getLocalResources(args), args => listener.navigate(args),
  async args => {
    const result = await listener.exportNode(args) as any;
    if (result.error) return result;
    const binding = listener.getBinding();
    if (!binding || binding.sessionId !== result.sessionId || binding.connectionGeneration !== result.connectionGeneration || !resources) throw new Error('SESSION_EXPIRED');
    const { nodeId, format, bytes, data, width, height, sessionId } = result;
    if (format === 'PNG' && bytes <= exportChunkBytes) return { sessionId, nodeId, bytes, format, width, height, mimeType: 'image/png', data: data.toString('base64') };
    const mimeType = format === 'PNG' ? 'image/png' : 'image/svg+xml';
    const resource = resources.put(sessionId, data, mimeType);
    return { sessionId, nodeId, bytes, format, mimeType, uri: resource.uri, expiresAt: resource.expiresAt,
      ...(format === 'PNG' ? { width, height } : {}) };
  }, uri => {
    const binding = listener.getBinding();
    if (!binding || !resources) throw new Error('RESOURCE_EXPIRED');
    return resources.read(binding.sessionId, uri);
  });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await listener.close();
  resources?.close(); resources = undefined;
  await pairing.dispose();
};
process.stdin.once('end', () => { void close(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void close().then(() => process.exit(0));
});
try { await server.connect(new StdioServerTransport()); }
catch { await close(); process.exit(1); }
