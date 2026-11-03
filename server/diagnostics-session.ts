import { operationResultSchema } from '../shared/operation-result';
import { errorSchema, scopeSchema } from '../shared/contracts';
import { createDiagnostics } from './diagnostics';

type Scope = { sessionId: string; connectionGeneration: number };
type ReadAction = 'getContext' | 'getTree' | 'findNodes' | 'getNodes' | 'getLocalResources' | 'navigate' | 'exportNode';
type OperationAction = 'applyBatch' | 'getOperation' | 'cancel';
type Event = { operationId: string; durationMs: number };

// Opt-in is local to the process, never an MCP command or document-provided value.
export function diagnosticsTtl(env: Record<string, string | undefined>) {
  const value = env.FIGMA_MCP_DIAGNOSTICS_TTL_MS;
  if (!value || !/^[1-9][0-9]{0,5}$/.test(value)) return 0;
  const ttl = Number(value);
  return ttl <= 300000 ? ttl : 0;
}

export function createDiagnosticsSession(rawScope: unknown, secret: string, env: Record<string, string | undefined> = {}) {
  let scope: Scope | undefined;
  let log: ReturnType<typeof createDiagnostics> | undefined;
  let closed = false;
  try {
    scope = scopeSchema.parse(rawScope);
    log = createDiagnostics(scope, secret);
    const ttl = diagnosticsTtl(env);
    if (ttl) log.enableExtended(ttl);
  } catch { scope = undefined; log = undefined; }

  return {
    // These inputs must be created by the bridge after an authenticated request; no input payload is examined.
    readCompleted(action: ReadAction, event: Event) {
      try { if (!closed) log?.record({ operationId: event.operationId, action, durationMs: event.durationMs, status: 'succeeded', affectedNodeIds: [], affectedResourceIds: [] }); } catch { /* Logging must not affect the request. */ }
    },
    operationCompleted(action: OperationAction, event: Event, rawResult: unknown) {
      try {
        if (closed || !scope || !log) return;
        const result = operationResultSchema.parse(rawResult);
        if (result.operationId !== event.operationId || result.sessionId !== scope.sessionId || result.connectionGeneration !== scope.connectionGeneration) return;
        log.record({ operationId: event.operationId, action, durationMs: event.durationMs, status: result.status,
          affectedNodeIds: result.affectedNodeIds, affectedResourceIds: result.affectedResourceIds },
        { ...(result.error ? { errorCode: result.error.code } : {}), stepCount: result.steps.length });
      } catch { /* A malformed result or logger failure must not affect the request. */ }
    },
    failed(action: ReadAction | OperationAction, event: Event, rawCode: unknown) {
      try {
        const code = errorSchema.shape.code.safeParse(rawCode);
        if (!closed) log?.record({ operationId: event.operationId, action, durationMs: event.durationMs, status: 'failed', affectedNodeIds: [], affectedResourceIds: [] },
          { errorCode: code.success ? code.data : 'FIGMA_API_ERROR' });
      } catch { /* Never expose exception text from logging. */ }
    },
    read() {
      try { return log?.read() ?? { entries: [], extended: [], extendedEnabled: false }; }
      catch { return { entries: [], extended: [], extendedEnabled: false }; }
    },
    clear() { try { log?.clear(); } catch { /* Cleanup is best effort. */ } },
    close() { closed = true; try { log?.clear(); } catch { /* Cleanup is best effort. */ } },
  };
}
