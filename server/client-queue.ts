type Job = { start: () => void; fail: (code: string) => void };

// The slot follows actual work, never the lifetime of an MCP connection.
export class ClientQueue {
  private active = false;
  private waiting: Job[] = [];
  constructor(private unavailable: () => string | undefined) {}

  run<T>(signal: AbortSignal, work: () => Promise<T>, limit: number, timeout: number): Promise<T> {
    const unavailable = this.active ? undefined : this.unavailable();
    if (signal.aborted || unavailable) return Promise.reject(new Error(unavailable ?? 'CANCELLED'));
    if (this.active && this.waiting.length >= limit) return Promise.reject(new Error('RESOURCE_LIMIT'));
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const job: Job = {
        fail: code => {
          this.waiting = this.waiting.filter(item => item !== job);
          cleanup(); reject(new Error(code));
        },
        start: () => {
          cleanup();
          const reason = this.unavailable();
          if (signal.aborted || reason) { job.fail(reason ?? 'CANCELLED'); this.next(); return; }
          this.active = true;
          Promise.resolve().then(() => { if (signal.aborted) throw new Error('CANCELLED'); return work(); }).then(resolve, reject).finally(() => { this.active = false; this.next(); });
        },
      };
      const abort = () => job.fail('CANCELLED');
      signal.addEventListener('abort', abort, { once: true });
      if (this.active) {
        this.waiting.push(job);
        timer = setTimeout(() => job.fail('QUEUE_TIMEOUT'), timeout);
      } else job.start();
    });
  }

  rejectWaiting(code: string) { for (const job of [...this.waiting]) job.fail(code); }
  private next() { this.waiting.shift()?.start(); }
}
