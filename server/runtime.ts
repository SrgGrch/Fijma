import { createServer } from './catalog';
import { createPairingFile } from './pairing-file';
import { createPairingListener } from './pairing-listener';
import { ExportResourceStore } from './export-resources';
import { exportChunkBytes } from '../shared/export-wire';

export async function createBridge(pairing: Awaited<ReturnType<typeof createPairingFile>>, port: number) {
  let resources: ExportResourceStore | undefined;
  let executionResources: ExportResourceStore | undefined;
  const listener = await createPairingListener(pairing.secret, port, undefined, binding => {
    resources?.close(); resources = undefined; executionResources?.close(); executionResources = undefined;
    if (binding) {
      resources = new ExportResourceStore({ ttl: binding.limits.resourceTtl, maxEntries: 16,
        maxBytes: binding.limits.maxExportBytes * 4, maxResourceBytes: binding.limits.maxExportBytes });
      resources.beginSession(binding.sessionId);
      executionResources = new ExportResourceStore({ ttl: 60000, maxEntries: 16, maxBytes: 4 * 1024 * 1024, maxResourceBytes: 256 * 1024 });
      executionResources.beginSession(binding.sessionId);
    }
  });
  let closing: Promise<void> | undefined;
  return {
    listener,
    createClientServer(beforeRequest?: () => void) {
      const operation = async (request: Promise<unknown>) => {
        const result = await request as any;
        if (!result?.executionResourceData) return result;
        const binding = listener.getBinding();
        if (!binding || binding.sessionId !== result.sessionId || binding.connectionGeneration !== result.connectionGeneration || !executionResources) throw new Error('SESSION_EXPIRED');
        const { executionResourceData, valueResourcePending, ...rest } = result;
        try { return { ...rest, resource: executionResources.putExecution(binding.sessionId, executionResourceData) }; }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'RESOURCE_LIMIT') throw error;
          return { ...rest, status: 'failed', effects: 'unknown', error: { code: 'RESOURCE_LIMIT', phase: 'transfer', message: 'Execution result resource limit exceeded.', recoveryAction: 'Inspect the document and request a smaller result with a new operation.' } };
        }
      };
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
          return uri.startsWith('figma-resource://execution/') ? executionResources!.read(binding.sessionId, uri) : resources.read(binding.sessionId, uri);
        }, args => listener.applyBatch(args), args => operation(listener.getOperation(args)), args => operation(listener.cancel(args)), beforeRequest, pairing.path,
        args => operation(listener.execute(args)));
    },
    close() {
      return closing ??= (async () => {
        try { await listener.close(); }
        finally { resources?.close(); resources = undefined; executionResources?.close(); executionResources = undefined; await pairing.dispose(); }
      })();
    },
  };
}
