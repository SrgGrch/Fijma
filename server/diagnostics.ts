import { z } from 'zod';

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_:;.,/#-]+$/);
const bindingSchema = z.strictObject({ sessionId: id, connectionGeneration: z.number().int().positive().safe() });
const actionSchema = z.enum(['getContext', 'getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate', 'applyBatch', 'getOperation', 'cancel', 'exportNode']);
const statusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'partially_applied', 'cancelled', 'unknown']);
const errorCodeSchema = z.enum(['NOT_CONNECTED', 'AUTH_FAILED', 'SESSION_BUSY', 'PROTOCOL_MISMATCH', 'SESSION_EXPIRED', 'DOCUMENT_MISMATCH', 'INVALID_ARGUMENT', 'INVALID_CURSOR', 'NODE_NOT_FOUND', 'CAPABILITY_UNAVAILABLE', 'FONT_UNAVAILABLE', 'CONFLICT', 'OPERATION_ID_CONFLICT', 'OPERATION_EXPIRED', 'RESOURCE_LIMIT', 'RESOURCE_EXPIRED', 'WRITE_DISABLED', 'FIGMA_API_ERROR', 'OUTCOME_UNKNOWN']);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const metadataSchema = z.object({ operationId: uuid, action: actionSchema, durationMs: z.number().finite().nonnegative(), status: statusSchema,
  affectedNodeIds: z.array(id).max(1000), affectedResourceIds: z.array(id).max(1000) });
const detailSchema = z.object({ errorCode: errorCodeSchema.optional(), stepCount: z.number().int().nonnegative().safe().optional(), queueDepth: z.number().int().nonnegative().safe().optional() });

// The binding and affected IDs must come from the authenticated bridge and confirmed results, never request payloads.
export function createDiagnostics(rawBinding: unknown, secret: string, limits = { maxEntries: 200, maxExtendedTtlMs: 300000 }) {
  const invalid = () => new Error('INVALID_ARGUMENT');
  const parsedBinding = bindingSchema.safeParse(rawBinding);
  if (!parsedBinding.success || typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret) || !Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 || limits.maxEntries > 10000 || !Number.isSafeInteger(limits.maxExtendedTtlMs) || limits.maxExtendedTtlMs < 1 || limits.maxExtendedTtlMs > 86400000) throw invalid();
  const binding = parsedBinding.data;
  if (binding.sessionId.includes(secret)) throw invalid();
  const entries: Array<z.infer<typeof metadataSchema> & { sessionId: string }> = [];
  const extended: Array<z.infer<typeof detailSchema> & { operationId: string; connectionGeneration: number }> = [];
  let expiresAt = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const clearExtended = () => { if (timer) clearTimeout(timer); timer = undefined; expiresAt = 0; extended.length = 0; };
  const trim = <T>(values: T[]) => { if (values.length > limits.maxEntries) values.splice(0, values.length - limits.maxEntries); };
  return {
    record(raw: unknown, rawDetail?: unknown) {
      const parsed = metadataSchema.safeParse(raw);
      const detail = rawDetail === undefined ? undefined : detailSchema.safeParse(rawDetail);
      if (!parsed.success || detail && !detail.success) throw invalid();
      const metadata = parsed.data;
      if ([metadata.operationId, ...metadata.affectedNodeIds, ...metadata.affectedResourceIds].some(value => value.includes(secret))) throw invalid();
      entries.push({ ...metadata, sessionId: binding.sessionId }); trim(entries);
      if (expiresAt && Date.now() >= expiresAt) clearExtended();
      if (expiresAt && detail?.success) {
        extended.push({ ...detail.data, operationId: metadata.operationId, connectionGeneration: binding.connectionGeneration }); trim(extended);
      }
    },
    enableExtended(ttlMs: number) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > limits.maxExtendedTtlMs) throw invalid();
      clearExtended(); expiresAt = Date.now() + ttlMs;
      timer = setTimeout(clearExtended, ttlMs); timer.unref?.();
    },
    read() {
      if (expiresAt && Date.now() >= expiresAt) clearExtended();
      return { entries: entries.map(entry => ({ ...entry, affectedNodeIds: [...entry.affectedNodeIds], affectedResourceIds: [...entry.affectedResourceIds] })),
        extended: extended.map(entry => ({ ...entry })), extendedEnabled: expiresAt !== 0 };
    },
    clear() { entries.length = 0; clearExtended(); },
  };
}
