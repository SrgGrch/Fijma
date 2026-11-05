import { ExecutionQueue } from '../shared/execution-queue';
import { OperationJournal } from '../shared/operation-journal';
import { executionJson } from '../shared/execution-json';
import { utf8Bytes } from '../shared/protocol';
import { executionLimits } from '../shared/execution-limits';

type Scope = { sessionId: string; connectionGeneration: number };
type Input = { language: 'javascript' | 'typescript'; code: string; compiledCode: string; args?: unknown };
type Log = { level: 'log' | 'info' | 'warn' | 'error' | 'debug'; message: string };

export class TrustedExecution {
  constructor(private journal: OperationJournal, private queue: ExecutionQueue, private platform: {
    figma: unknown; checkScope(scope: Scope): void; yieldControl(): Promise<void>; commitUndo(): void;
  }, private maxQueued: number, private deadlineMs: number) {}

  get(operationId: string) { return this.journal.get(operationId); }
  recover(scope: Scope, operationId: string, input: Input, now: number) {
    if (!this.journal.has(operationId)) return { status: 'unknown' as const };
    return this.journal.reserve(operationId, { command: 'figma_execute', params: { scope, language: input.language, code: input.code, ...(input.args === undefined ? {} : { args: input.args }) } }, now);
  }

  submit(scope: Scope, operationId: string, input: Input, now: number) {
    this.platform.checkScope(scope);
    if (!this.journal.has(operationId) && this.queue.size >= this.maxQueued) throw new Error('RESOURCE_LIMIT');
    const params = { scope, language: input.language, code: input.code, ...(input.args === undefined ? {} : { args: input.args }) };
    const reservation = this.journal.reserve(operationId, { command: 'figma_execute', params }, now);
    if (!reservation.fresh) return Promise.resolve(reservation);
    return this.queue.enqueue(operationId, 'execute', async job => {
      const logs: Log[] = [], warnings: string[] = [];
      let logsTruncated = false, logBytes = 0, started = false, serializing = false;
      const result: any = { operationId, ...scope, kind: 'execute', status: 'failed', effects: 'none', logs, logsTruncated, warnings };
      const deadline = Date.now() + this.deadlineMs;
      const check = () => {
        if (job.cancelled) throw new Error('CANCELLED');
        this.platform.checkScope(scope);
        if (Date.now() > deadline) throw new Error('EXECUTION_TIMEOUT');
      };
      const localConsole: Record<string, (...args: unknown[]) => void> = {};
      for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) localConsole[level] = (...args) => {
        if (logsTruncated) return;
        let message: string;
        try { message = args.map(v => typeof v === 'string' ? v : executionJson(v, executionLimits.maxLogBytes).json).join(' '); }
        catch { message = '[unserializable]'; }
        const bytes = utf8Bytes(JSON.stringify({ level, message }));
        if (logs.length >= executionLimits.maxLogEntries || logBytes + bytes > executionLimits.maxLogBytes) { logsTruncated = true; return; }
        logs.push({ level, message }); logBytes += bytes;
      };
      try {
        check();
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const run = new AsyncFunction('figma', 'args', 'console', 'execution', input.compiledCode);
        check();
        this.journal.update(operationId, 'running');
        started = true; result.effects = 'unknown';
        const value = await run(this.platform.figma, input.args ?? null, localConsole, {
          checkCancelled: check,
          yield: async () => { await this.platform.yieldControl(); check(); },
        });
        serializing = true;
        const dto = executionJson(value);
        result.value = dto.value;
        result.status = 'succeeded';
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        const serialize = serializing;
        result.status = code === 'CANCELLED' ? 'cancelled' : 'failed';
        if (result.status === 'failed') result.error = {
          code: serialize ? code === 'RESOURCE_LIMIT' ? code : 'RESULT_NOT_SERIALIZABLE' : started ? 'FIGMA_API_ERROR' : ['EXECUTION_DISABLED', 'SESSION_EXPIRED', 'DOCUMENT_MISMATCH'].includes(code) ? code : 'FIGMA_API_ERROR',
          phase: serialize ? 'serialize' : started ? 'execute' : 'prepare',
          message: serialize ? code : started ? String(code || 'Execution failed').slice(0, 1000) : (code || 'Execution failed').slice(0, 1000),
          recoveryAction: started ? 'Inspect the document before retrying with a new operation.' : 'Check permission, scope and source before retrying.',
        };
      }
      if (started) try { this.platform.commitUndo(); } catch { warnings.push('Unable to create an Undo boundary.'); }
      result.logsTruncated = logsTruncated;
      this.journal.update(operationId, result.status, result);
      return result;
    });
  }
}
