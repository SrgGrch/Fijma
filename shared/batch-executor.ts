import { batchSchema } from './contracts';
import { OperationJournal } from './operation-journal';
import type { BatchStep } from './batch-refs';

type Changes = { nodeIds: string[]; resourceIds: string[]; details?: unknown[] };
type Outputs = Partial<Record<'nodeId' | 'styleId' | 'collectionId' | 'modeId' | 'variableId', string>>;
type StepResult = { stepId: string; status: 'succeeded' | 'failed' | 'skipped'; outputs: Outputs; appliedChanges: Changes; error?: Failure };
type Failure = { code: string; message: string; failedStep?: string; details?: unknown; recoveryAction: string };
type Scope = { sessionId: string; connectionGeneration: number };
type Job = { cancelled: boolean; steps: BatchStep[]; scope: Scope; operationId: string };
type Platform = {
  checkScope(scope: Scope): void;
  preflight?(step: BatchStep): void;
  yieldControl?(): Promise<void>;
  prepare(step: BatchStep, original?: BatchStep, guard?: () => void): Promise<void>;
  readExpected(step: BatchStep): Promise<Record<string, unknown>>;
  execute(step: BatchStep, record: (changes: Changes) => void, cancelled: () => boolean): Promise<Outputs>;
  verify?(step: BatchStep, changes: Changes): Promise<unknown[]>;
  commitUndo(): void;
};
const empty = (): Changes => ({ nodeIds: [], resourceIds: [] });
const error = (e: unknown, stepId?: string): Failure => {
  const message = e instanceof Error ? e.message : String(e);
  const codes = ['INVALID_ARGUMENT', 'CONFLICT', 'SESSION_EXPIRED', 'DOCUMENT_MISMATCH', 'WRITE_DISABLED', 'NODE_NOT_FOUND', 'CAPABILITY_UNAVAILABLE', 'FONT_UNAVAILABLE', 'RESOURCE_LIMIT'];
  const code = codes.includes(message) ? message : 'FIGMA_API_ERROR';
  const fonts = code === 'FONT_UNAVAILABLE' && e && typeof e === 'object' ? (e as any).details?.fonts : undefined;
  const validFonts = Array.isArray(fonts) && fonts.length > 0 && fonts.length <= 100 && fonts.every(f => f && typeof f.family === 'string' && f.family.length > 0 && f.family.length <= 200 && typeof f.style === 'string' && f.style.length > 0 && f.style.length <= 200);
  const modeLimit = code === 'CAPABILITY_UNAVAILABLE' && e && typeof e === 'object' && (e as any).details?.reason === 'VARIABLE_MODE_LIMIT';
  return { code, message: modeLimit ? 'The editor cannot add another variable mode.' : code === 'FIGMA_API_ERROR' ? 'The operation failed.' : message, ...(validFonts ? { details: { fonts: fonts.map(f => ({ family: f.family, style: f.style })) } } : modeLimit ? { details: { reason: 'VARIABLE_MODE_LIMIT' } } : {}), ...(stepId ? { failedStep: stepId } : {}), recoveryAction: modeLimit ? 'Use an existing mode or check the editor limits.' : code === 'CONFLICT' ? 'Read the current state and prepare a new operation.' : 'Inspect the operation and current document state.' };
};
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(k => Object.prototype.hasOwnProperty.call(b, k) && equal((a as any)[k], (b as any)[k]));
}
function resolve(step: BatchStep, previous: Map<string, Outputs>): BatchStep {
  const result = { ...step };
  for (const key of ['target', 'targets', 'parent', 'pageId', 'componentId', 'styleId', 'collectionId', 'modeId', 'variableId', 'targetVariableId']) {
    const replace = (value: any): unknown => {
      if (!value || typeof value !== 'object' || !('stepId' in value)) return value;
      const id = previous.get(value.stepId)?.[value.output as keyof Outputs];
      if (!id) throw new Error('INVALID_ARGUMENT');
      return value.output === 'nodeId' ? { nodeId: id } : id;
    };
    if (key in result) result[key] = Array.isArray(result[key]) ? (result[key] as unknown[]).map(replace) : replace(result[key]);
  }
  return result;
}

// One instance and journal belong to one live plugin session.
export class BatchExecutor {
  private tail: Promise<void> = Promise.resolve();
  private jobs = new Map<string, Job>();
  constructor(private journal: OperationJournal, private platform: Platform, private maxQueuedOperations: number) {
    if (!Number.isSafeInteger(maxQueuedOperations) || maxQueuedOperations < 1) throw new Error('INVALID_ARGUMENT');
  }
  get(operationId: string) { return this.journal.get(operationId); }
  recover(operationId: string, input: unknown, now: number) {
    const steps = batchSchema.parse(input) as BatchStep[];
    if (!this.journal.has(operationId)) return { status: 'unknown' as const };
    return this.journal.reserve(operationId, { command: 'figma_apply_batch', params: { steps } }, now);
  }
  submit(scope: Scope, operationId: string, input: unknown, now: number) {
    this.platform.checkScope(scope);
    const steps = batchSchema.parse(input) as BatchStep[];
    for (const step of steps) this.platform.preflight?.(step);
    // A retry must remain available even when the queue is full.
    if (!this.journal.has(operationId) && this.jobs.size >= this.maxQueuedOperations) throw new Error('RESOURCE_LIMIT');
    const reservation = this.journal.reserve(operationId, { command: 'figma_apply_batch', params: { steps } }, now);
    if (!reservation.fresh) return Promise.resolve(reservation);
    const job: Job = { scope, operationId, steps, cancelled: false };
    this.jobs.set(operationId, job);
    const run = this.tail.then(() => this.run(job));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  cancel(operationId: string) {
    const job = this.jobs.get(operationId);
    if (job) job.cancelled = true;
    return this.get(operationId);
  }
  stop() { for (const job of this.jobs.values()) job.cancelled = true; }
  private async run(job: Job) {
    const { operationId, scope, steps } = job;
    const results: StepResult[] = [];
    const outputs = new Map<string, Outputs>();
    let failure: Failure | undefined;
    let status: 'succeeded' | 'failed' | 'partially_applied' | 'cancelled' = 'succeeded';
    if (!job.cancelled) this.journal.update(operationId, 'running');
    for (const original of steps) {
      const item: StepResult = { stepId: original.stepId, status: 'skipped', outputs: {}, appliedChanges: empty() };
      results.push(item);
      if (status !== 'succeeded') continue;
      if (job.cancelled) { status = 'cancelled'; continue; }
      try {
        await this.platform.yieldControl?.();
        if (job.cancelled) { status = 'cancelled'; continue; }
        this.platform.checkScope(scope);
        const step = resolve(original, outputs);
        await this.platform.prepare(step, original, () => { if (job.cancelled) throw new Error('CANCELLED'); this.platform.checkScope(scope); });
        if (job.cancelled) { status = 'cancelled'; continue; }
        this.platform.checkScope(scope);
        if (step.expected) {
          const actual = await this.platform.readExpected(step);
          if (job.cancelled) { status = 'cancelled'; continue; }
          this.platform.checkScope(scope);
          for (const [key, value] of Object.entries(step.expected as Record<string, unknown>)) {
            if (!equal(value, actual[key])) throw new Error('CONFLICT');
          }
        }
        item.outputs = await this.platform.execute(step, changes => {
          item.appliedChanges.nodeIds.push(...changes.nodeIds);
          item.appliedChanges.resourceIds.push(...changes.resourceIds);
          if (changes.details?.length) (item.appliedChanges.details ||= []).push(...changes.details);
        }, () => job.cancelled);
        if (this.platform.verify) {
          const details = await this.platform.verify(step, item.appliedChanges);
          if (details.length) (item.appliedChanges.details ||= []).push(...details);
        }
        item.status = 'succeeded';
        outputs.set(step.stepId, item.outputs);
        if (job.cancelled) status = 'cancelled';
      } catch (e) {
        if (job.cancelled && !item.appliedChanges.nodeIds.length && !item.appliedChanges.resourceIds.length && !item.appliedChanges.details?.length) { status = 'cancelled'; continue; }
        item.status = 'failed';
        item.error = failure = error(e, item.stepId);
        status = results.some(r => r.appliedChanges.nodeIds.length || r.appliedChanges.resourceIds.length || r.appliedChanges.details?.length) ? 'partially_applied' : 'failed';
      }
    }
    const affectedNodeIds = [...new Set(results.flatMap(r => r.appliedChanges.nodeIds))];
    const affectedResourceIds = [...new Set(results.flatMap(r => r.appliedChanges.resourceIds))];
    if (affectedNodeIds.length || affectedResourceIds.length || results.some(r => r.appliedChanges.details?.length)) {
      try { this.platform.commitUndo(); } catch (e) { failure ||= error(e); if (status !== 'cancelled') status = 'partially_applied'; }
    }
    const result = { operationId, ...scope, status, steps: results, affectedNodeIds, affectedResourceIds, warnings: [], ...(failure ? { error: failure } : {}) };
    this.journal.update(operationId, status, result);
    this.jobs.delete(operationId);
    return result;
  }
}
