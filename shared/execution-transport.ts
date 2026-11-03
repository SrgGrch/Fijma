import { BatchExecutor } from './batch-executor';
import { scopeSchema } from './contracts';

type Scope = { sessionId: string; connectionGeneration: number };
type Snapshot = { status: string; result?: unknown };

// The caller must retain the original scope of each command across reconnects.
export class ExecutionTransport {
  private connected = true;
  private pending = new Set<() => void>();
  constructor(private executor: BatchExecutor, private scope: Scope) {
    this.scope = scopeSchema.parse(scope);
  }
  disconnect() {
    this.connected = false;
    for (const notify of this.pending) notify();
  }
  reconnect(scope: Scope) {
    scope = scopeSchema.parse(scope);
    if (scope.sessionId !== this.scope.sessionId || scope.connectionGeneration === this.scope.connectionGeneration) throw new Error('SESSION_EXPIRED');
    this.scope = { ...scope };
    this.connected = true;
  }
  private envelope(scope: Scope, operationId: string, status: string) {
    return { operationId, ...scope, status, steps: [], affectedNodeIds: [], affectedResourceIds: [], warnings: [] };
  }
  private check(scope: Scope) {
    scopeSchema.parse(scope);
    if (!this.connected) throw new Error('NOT_CONNECTED');
    if (scope.sessionId !== this.scope.sessionId) throw new Error('SESSION_EXPIRED');
  }
  status(operationId: string) {
    if (!this.connected) throw new Error('NOT_CONNECTED');
    const known = this.executor.get(operationId);
    return known.result ?? this.envelope(this.scope, operationId, known.status);
  }
  submit(originalScope: Scope, operationId: string, input: unknown, now: number, timeoutMs: number): Promise<unknown> {
    this.check(originalScope);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('INVALID_ARGUMENT');
    if (originalScope.connectionGeneration !== this.scope.connectionGeneration) {
      const known = this.executor.recover(operationId, input, now);
      return Promise.resolve(known.result ?? this.envelope(originalScope, operationId, known.status));
    }
    const operation = this.executor.submit(originalScope, operationId, input, now);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (value: unknown) => { clearTimeout(timer); this.pending.delete(lost); resolve(value); };
      const lost = () => finish(this.envelope(originalScope, operationId, 'unknown'));
      this.pending.add(lost);
      timer = setTimeout(lost, timeoutMs);
      operation.then((value: any) => {
        if (value && 'fresh' in value) {
          const known = value as Snapshot;
          finish(known.result ?? this.envelope(originalScope, operationId, known.status));
        } else finish(value);
      }, e => { clearTimeout(timer); this.pending.delete(lost); reject(e); });
    });
  }
}
