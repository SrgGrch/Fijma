export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'partially_applied' | 'cancelled' | 'unknown';
type Entry = { fingerprint: string; command: string; scope?: unknown; createdAt: number; status: OperationStatus; result?: unknown };

// Payloads come from the JSON protocol; sorting keys makes property order immaterial.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_ARGUMENT');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('INVALID_ARGUMENT');
    return encoded;
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}

export class OperationJournal {
  private entries = new Map<string, Entry>();
  constructor(private limits: { dedupTtl: number; clockSkew: number; maxJournalEntries: number }) {
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < (key === 'clockSkew' ? 0 : 1)) throw new Error('INVALID_ARGUMENT');
    }
  }

  private timestamp(operationId: string): number {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) throw new Error('INVALID_ARGUMENT');
    return parseInt(operationId.slice(0, 8) + operationId.slice(9, 13), 16);
  }

  reserve(operationId: string, payload: { command: string; params: unknown }, now: number) {
    const createdAt = this.timestamp(operationId);
    if (createdAt > now + this.limits.clockSkew) throw new Error('INVALID_ARGUMENT');
    if (now - createdAt > this.limits.dedupTtl + this.limits.clockSkew) throw new Error('OPERATION_EXPIRED');
    const fingerprint = canonical(payload);
    const existing = this.entries.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('OPERATION_ID_CONFLICT');
      return { fresh: false, ...this.get(operationId) };
    }
    // Never evict an in-flight operation: its eventual result must remain correlatable.
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt > this.limits.dedupTtl + this.limits.clockSkew && entry.status !== 'queued' && entry.status !== 'running') this.entries.delete(id);
    }
    if (this.entries.size >= this.limits.maxJournalEntries) throw new Error('RESOURCE_LIMIT');
    this.entries.set(operationId, { createdAt, fingerprint, command: payload.command, scope: (payload.params as any)?.scope, status: 'queued' });
    return { fresh: true, status: 'queued' as OperationStatus };
  }

  get(operationId: string): { status: OperationStatus; result?: unknown } {
    this.timestamp(operationId);
    const entry = this.entries.get(operationId);
    return entry ? { status: entry.status, result: entry.result } : { status: 'unknown' };
  }

  has(operationId: string): boolean {
    this.timestamp(operationId);
    return this.entries.has(operationId);
  }

  kind(operationId: string) { return this.entries.get(operationId)?.command; }
  scope(operationId: string) { return this.entries.get(operationId)?.scope; }

  update(operationId: string, status: OperationStatus, result?: unknown) {
    const entry = this.entries.get(operationId);
    if (!entry) throw new Error('OUTCOME_UNKNOWN');
    const allowed: Record<OperationStatus, OperationStatus[]> = {
      queued: ['running', 'failed', 'cancelled'],
      running: ['succeeded', 'failed', 'partially_applied', 'cancelled', 'unknown'],
      unknown: ['succeeded', 'failed', 'partially_applied', 'cancelled'],
      succeeded: [], failed: [], partially_applied: [], cancelled: [],
    };
    if (!allowed[entry.status].includes(status)) throw new Error('INVALID_ARGUMENT');
    entry.status = status;
    entry.result = result;
  }
}
