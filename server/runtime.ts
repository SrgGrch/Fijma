import { isDeepStrictEqual } from 'node:util';
import { ClientQueue } from './client-queue';
import { bootstrapLimits } from '../shared/bootstrap-limits';
import { createServer } from './catalog';
import { createPairingFile } from './pairing-file';
import { createPairingListener } from './pairing-listener';
import { ExportResourceStore } from './export-resources';
import { exportChunkBytes } from '../shared/export-wire';

export async function createBridge(pairing: Awaited<ReturnType<typeof createPairingFile>>, port: number) {
  let resources: ExportResourceStore | undefined;
  let executionResources: ExportResourceStore | undefined;
  type ClientOperation = { owner: symbol; args: any; kind: 'applyBatch' | 'execute'; sent: boolean; expires: number;
    abort: AbortController; promise?: Promise<unknown>; settled?: boolean; error?: string };
  const owners = new Map<string, ClientOperation>();
  const resourceOwners = new Map<string, { owner: symbol; expires: number }>();
  let closing: Promise<void> | undefined;
  const queue = new ClientQueue(() => closing ? 'NOT_CONNECTED' : listener.needsRecovery() ? 'RECOVERY_REQUIRED' : undefined);
  const listener = await createPairingListener(pairing.secret, port, undefined, binding => {
    queue.rejectWaiting('SESSION_EXPIRED'); owners.clear(); resourceOwners.clear();
    resources?.close(); resources = undefined; executionResources?.close(); executionResources = undefined;
    if (binding) {
      resources = new ExportResourceStore({ ttl: binding.limits.resourceTtl, maxEntries: 16,
        maxBytes: binding.limits.maxExportBytes * 4, maxResourceBytes: binding.limits.maxExportBytes });
      resources.beginSession(binding.sessionId);
      executionResources = new ExportResourceStore({ ttl: 60000, maxEntries: 16, maxBytes: 4 * 1024 * 1024, maxResourceBytes: 256 * 1024 });
      executionResources.beginSession(binding.sessionId);
    }
  });
  return {
    listener,
    createClientServer(beforeRequest?: () => void, signal = new AbortController().signal) {
      const client = Symbol('client');
      let contextGeneration: number | undefined;
      const limits = () => listener.getBinding()?.limits ?? bootstrapLimits;
      const enqueue = <T>(work: () => Promise<T>, cancellation = signal) => queue.run(cancellation, work, limits().maxQueuedOperations, limits().operationTimeout);
      const checkScope = (args: any) => {
        const binding = listener.getBinding();
        if (!binding) throw new Error(listener.needsRecovery() ? 'RECOVERY_REQUIRED' : 'NOT_CONNECTED');
        if (binding.sessionId !== args.scope.sessionId || binding.connectionGeneration !== args.scope.connectionGeneration) throw new Error('SESSION_EXPIRED');
        return binding;
      };
      const ownResource = <T extends { uri: string; expiresAt: string }>(resource: T) => {
        for (const [uri, entry] of resourceOwners) if (entry.expires <= Date.now()) resourceOwners.delete(uri);
        if (!signal.aborted) resourceOwners.set(resource.uri, { owner: client, expires: Date.parse(resource.expiresAt) });
        return resource;
      };
      signal.addEventListener('abort', () => {
        for (const record of owners.values()) if (record.owner === client && !record.sent) record.abort.abort();
        for (const [uri, entry] of resourceOwners) if (entry.owner === client) resourceOwners.delete(uri);
      }, { once: true });
      const operation = async (request: Promise<unknown>) => {
        const result = await request as any;
        if (!result?.executionResourceData) return result;
        const binding = listener.getBinding();
        if (!binding || binding.sessionId !== result.sessionId || binding.connectionGeneration !== result.connectionGeneration || !executionResources) throw new Error('SESSION_EXPIRED');
        const { executionResourceData, valueResourcePending, ...rest } = result;
        try { return { ...rest, resource: ownResource(executionResources.putExecution(binding.sessionId, executionResourceData)) }; }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'RESOURCE_LIMIT') throw error;
          return { ...rest, status: 'failed', effects: 'unknown', error: { code: 'RESOURCE_LIMIT', phase: 'transfer', message: 'Execution result resource limit exceeded.', recoveryAction: 'Inspect the document and request a smaller result with a new operation.' } };
        }
      };
      const submit = (kind: ClientOperation['kind'], args: any) => {
        const binding = checkScope(args);
        if (signal.aborted) throw new Error('CANCELLED');
        if (contextGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
        const createdAt = parseInt(args.operationId.slice(0, 8) + args.operationId.slice(9, 13), 16);
        if (createdAt > Date.now() + binding.limits.clockSkew) throw new Error('INVALID_ARGUMENT');
        if (Date.now() - createdAt > binding.limits.dedupTtl + binding.limits.clockSkew) throw new Error('OPERATION_EXPIRED');
        const existing = owners.get(args.operationId);
        if (existing) {
          if (existing.owner !== client) throw new Error('OPERATION_NOT_OWNED');
          if (existing.kind !== kind || !isDeepStrictEqual(existing.args, args)) throw new Error('OPERATION_ID_CONFLICT');
          if (!existing.settled || existing.sent || existing.error === 'CANCELLED') return existing.promise!;
        }
        for (const [id, record] of owners) if (record.expires <= Date.now() && !listener.isUnfinished(id)) owners.delete(id);
        if (!existing && owners.size >= binding.limits.maxJournalEntries) throw new Error('RESOURCE_LIMIT');
        const record: ClientOperation = existing ?? { owner: client, args, kind, sent: false,
          expires: createdAt + binding.limits.dedupTtl + binding.limits.clockSkew, abort: new AbortController() };
        record.settled = false; record.error = undefined;
        owners.set(args.operationId, record);
        record.promise = enqueue(async () => {
          checkScope(args);
          record.sent = true;
          const result = await operation(kind === 'execute' ? listener.execute(args) : listener.applyBatch(args));
          if (result.error && !('operationId' in result)) { record.sent = false; record.error = result.error.code; }
          return result;
        }, record.abort.signal).catch(error => { record.error = error.message; throw error; }).finally(() => { record.settled = true; });
        return record.promise;
      };
      const control = async (args: any, cancel = false) => {
        checkScope(args);
        const record = owners.get(args.operationId);
        if (!record || record.owner !== client) throw new Error('OPERATION_NOT_OWNED');
        if (!record.sent) {
          if (cancel) { record.error = 'CANCELLED'; record.abort.abort(); }
          if (record.error && record.error !== 'CANCELLED') throw new Error(record.error);
          return { ...args.scope, operationId: args.operationId, status: record.error ? 'cancelled' : 'queued', warnings: [],
            ...(record.kind === 'execute' ? { kind: 'execute', effects: 'none', logs: [], logsTruncated: false } : { steps: [], affectedNodeIds: [], affectedResourceIds: [] }) };
        }
        return operation(cancel ? listener.cancel(args) : listener.getOperation(args));
      };
      return createServer(() => enqueue(async () => {
        const result = await listener.getContext() as any;
        contextGeneration = result.state === 'ready' ? result.connectionGeneration : undefined;
        return result;
      }), args => enqueue(() => listener.getTree(args)), args => enqueue(() => listener.findNodes(args)),
        args => enqueue(() => listener.getNodes(args)), args => enqueue(() => listener.getLocalResources(args)), args => enqueue(() => listener.navigate(args)),
        args => enqueue(async () => {
          const result = await listener.exportNode(args) as any;
          if (result.error) return result;
          const binding = listener.getBinding();
          if (!binding || binding.sessionId !== result.sessionId || binding.connectionGeneration !== result.connectionGeneration || !resources) throw new Error('SESSION_EXPIRED');
          const { nodeId, format, bytes, data, width, height, sessionId } = result;
          if (format === 'PNG' && bytes <= exportChunkBytes) return { sessionId, nodeId, bytes, format, width, height, mimeType: 'image/png', data: data.toString('base64') };
          const mimeType = format === 'PNG' ? 'image/png' : 'image/svg+xml';
          const resource = ownResource(resources.put(sessionId, data, mimeType));
          return { sessionId, nodeId, bytes, format, mimeType, uri: resource.uri, expiresAt: resource.expiresAt,
            ...(format === 'PNG' ? { width, height } : {}) };
        }), uri => {
          const binding = listener.getBinding();
          if (!binding || !resources || resourceOwners.get(uri)?.owner !== client) throw new Error('RESOURCE_EXPIRED');
          return uri.startsWith('figma-resource://execution/') ? executionResources!.read(binding.sessionId, uri) : resources.read(binding.sessionId, uri);
        }, args => submit('applyBatch', args), args => control(args), args => control(args, true), beforeRequest, pairing.path,
        args => submit('execute', args));
    },
    close() {
      return closing ??= (async () => {
        queue.rejectWaiting('NOT_CONNECTED');
        try { await listener.close(); }
        finally { resources?.close(); resources = undefined; executionResources?.close(); executionResources = undefined; await pairing.dispose(); }
      })();
    },
  };
}
