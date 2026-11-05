import { z } from 'zod';
import { executionStartSchema as start, executionChunkSchema as chunk } from '../shared/execution-wire';
export class ExecutionTransfer {
  private started?: z.infer<typeof start>;
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private expected: { sessionId: string; connectionGeneration: number; operationId: string; requestId: string }) {}
  accept(raw: unknown) {
    const message = (raw as { type?: string })?.type === 'executionStart' ? start.parse(raw) : chunk.parse(raw);
    for (const key of ['sessionId', 'connectionGeneration', 'operationId', 'requestId'] as const) if (message[key] !== this.expected[key]) throw new Error('PROTOCOL_MISMATCH');
    if (message.type === 'executionStart') {
      if (this.started || message.total !== Math.ceil(message.bytes / message.chunkBytes)) throw new Error('PROTOCOL_MISMATCH');
      this.started = message;
      return;
    }
    const state = this.started;
    if (!state || message.index !== this.chunks.length || message.total !== state.total) throw new Error('PROTOCOL_MISMATCH');
    const data = Buffer.from(message.data, 'base64');
    if (data.toString('base64') !== message.data || data.length !== Math.min(state.chunkBytes, state.bytes - this.size)) throw new Error('PROTOCOL_MISMATCH');
    this.chunks.push(data); this.size += data.length;
    if (this.chunks.length === state.total) {
      const result = Buffer.concat(this.chunks, state.bytes);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(result);
      JSON.parse(text);
      return result;
    }
  }
}
