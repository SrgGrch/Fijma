import { BatchExecutor } from './batch-executor';
import { scopeSchema } from './contracts';

type Scope = { sessionId: string; connectionGeneration: number };
type Snapshot = { status: string; result?: unknown };
type ExecuteInput = { language: 'javascript' | 'typescript'; code: string; compiledCode: string; args?: unknown };
type ExecuteExecutor = { get(id: string): Snapshot; recover(scope: Scope, id: string, input: ExecuteInput, now: number): Snapshot; submit(scope: Scope, id: string, input: ExecuteInput, now: number): Promise<unknown> };

// The caller must retain the original scope of each command across reconnects.
export class ExecutionTransport {
  private connected = true;
  private pending = new Set<() => void>();
  constructor(private executor: BatchExecutor, private scope: Scope, private execute?: ExecuteExecutor) {
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
  executeStatus(operationId: string) {
    if (!this.connected) throw new Error('NOT_CONNECTED');
    if (!this.execute) throw new Error('CAPABILITY_UNAVAILABLE');
    const known = this.execute.get(operationId);
    return known.result ?? this.executeEnvelope(this.scope, operationId, known.status);
  }
  private executeEnvelope(scope: Scope, operationId: string, status: string) {
    return { operationId, ...scope, kind: 'execute', status, effects: status === 'queued' ? 'none' : 'unknown', logs: [], logsTruncated: false, warnings: [] };
  }
  submitExecute(originalScope: Scope, operationId: string, input: ExecuteInput, now: number, timeoutMs: number): Promise<unknown> {
    this.check(originalScope);
    if (!this.execute) throw new Error('CAPABILITY_UNAVAILABLE');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('INVALID_ARGUMENT');
    if (originalScope.connectionGeneration !== this.scope.connectionGeneration) {
      const known = this.execute.recover(originalScope, operationId, input, now);
      return Promise.resolve(known.result ?? this.executeEnvelope(originalScope, operationId, known.status));
    }
    const operation = this.execute.submit(originalScope, operationId, input, now);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (value: unknown) => { clearTimeout(timer); this.pending.delete(lost); resolve(value); };
      const lost = () => finish(this.executeEnvelope(originalScope, operationId, 'unknown'));
      this.pending.add(lost);
      timer = setTimeout(lost, timeoutMs);
      operation.then((value: any) => finish(value && 'fresh' in value ? value.result ?? this.executeEnvelope(originalScope, operationId, value.status) : value),
        e => { clearTimeout(timer); this.pending.delete(lost); reject(e); });
    });
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
