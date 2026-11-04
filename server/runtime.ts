import { createServer } from './catalog';
import { createPairingFile } from './pairing-file';
import { createPairingListener } from './pairing-listener';
import { ExportResourceStore } from './export-resources';
import { exportChunkBytes } from '../shared/export-wire';

export async function createBridge(pairing: Awaited<ReturnType<typeof createPairingFile>>, port: number) {
  let resources: ExportResourceStore | undefined;
  const listener = await createPairingListener(pairing.secret, port, undefined, binding => {
    resources?.close(); resources = undefined;
    if (binding) {
      resources = new ExportResourceStore({ ttl: binding.limits.resourceTtl, maxEntries: 16,
        maxBytes: binding.limits.maxExportBytes * 4, maxResourceBytes: binding.limits.maxExportBytes });
      resources.beginSession(binding.sessionId);
    }
  });
  let closing: Promise<void> | undefined;
  return {
    listener,
    createClientServer(beforeRequest?: () => void) {
      return createServer(() => listener.getContext(), args => listener.getTree(args), args => listener.findNodes(args),
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
        }, args => listener.applyBatch(args), args => listener.getOperation(args), args => listener.cancel(args), beforeRequest, pairing.path);
    },
    close() {
      return closing ??= (async () => {
        try { await listener.close(); }
        finally { resources?.close(); resources = undefined; await pairing.dispose(); }
      })();
    },
  };
}
