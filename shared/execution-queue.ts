export type QueueJob = { cancelled: boolean; kind: 'batch' | 'execute' };

// One queue serializes all potential writes for a plugin session.
export class ExecutionQueue {
  private tail: Promise<void> = Promise.resolve();
  private jobs = new Map<string, QueueJob>();
  constructor(private max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('INVALID_ARGUMENT');
  }
  get size() { return this.jobs.size; }
  get hasExecute() { return [...this.jobs.values()].some(job => job.kind === 'execute'); }
  enqueue<T>(id: string, kind: QueueJob['kind'], run: (job: QueueJob) => Promise<T>): Promise<T> {
    if (this.jobs.size >= this.max) throw new Error('RESOURCE_LIMIT');
    const job: QueueJob = { cancelled: false, kind };
    this.jobs.set(id, job);
    const result = this.tail.then(() => run(job));
    this.tail = result.then(() => undefined, () => undefined);
    return result.finally(() => { this.jobs.delete(id); });
  }
  cancel(id: string) { const job = this.jobs.get(id); if (job) job.cancelled = true; }
  stop(kind?: QueueJob['kind']) { for (const job of this.jobs.values()) if (!kind || job.kind === kind) job.cancelled = true; }
}
