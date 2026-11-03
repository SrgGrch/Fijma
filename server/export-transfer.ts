import { exportStartSchema, exportChunkSchema, pngDimensions, chunkSizeFor } from '../shared/export-wire';

type Scope = { sessionId: string; connectionGeneration: number; operationId: string };
export class ExportTransfer {
  private started?: { nodeId: string; format: 'PNG' | 'SVG'; bytes: number; total: number; chunkBytes: number; width?: number; height?: number };
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private scope: Scope, private query: { nodeId: string; format: 'PNG' | 'SVG' },
    private limits: { maxExportBytes: number; maxExportPixels: number; maxMessageBytes: number }) {}

  accept(raw: unknown) {
    if (!raw || typeof raw !== 'object') throw new Error('PROTOCOL_MISMATCH');
    const type = (raw as { type?: unknown }).type;
    if (type === 'exportStart') {
      const message = exportStartSchema.parse(raw);
      this.check(message);
      if (this.started || message.nodeId !== this.query.nodeId || message.format !== this.query.format || message.bytes > this.limits.maxExportBytes || message.chunkBytes > chunkSizeFor(this.scope, this.limits) ||
        (message.format === 'PNG' && message.width! > Math.floor(this.limits.maxExportPixels / message.height!))) throw new Error('PROTOCOL_MISMATCH');
      this.started = message;
      return;
    }
    const message = exportChunkSchema.parse(raw);
    this.check(message);
    const state = this.started;
    if (!state || message.index !== this.chunks.length || message.total !== state.total) throw new Error('PROTOCOL_MISMATCH');
    const chunk = Buffer.from(message.data, 'base64');
    const expected = Math.min(state.chunkBytes, state.bytes - this.size);
    if (chunk.length !== expected || chunk.toString('base64') !== message.data) throw new Error('PROTOCOL_MISMATCH');
    this.chunks.push(chunk); this.size += chunk.length;
    if (this.chunks.length !== state.total) return;
    const data = Buffer.concat(this.chunks, state.bytes);
    if (state.format === 'PNG') {
      const dimensions = pngDimensions(data);
      if (dimensions.width !== state.width || dimensions.height !== state.height || dimensions.width > Math.floor(this.limits.maxExportPixels / dimensions.height)) throw new Error('PROTOCOL_MISMATCH');
    }
    return { nodeId: state.nodeId, format: state.format, bytes: state.bytes, data,
      ...(state.format === 'PNG' ? { width: state.width!, height: state.height! } : {}) };
  }
  private check(message: Scope) {
    if (message.sessionId !== this.scope.sessionId || message.connectionGeneration !== this.scope.connectionGeneration || message.operationId !== this.scope.operationId) throw new Error('PROTOCOL_MISMATCH');
  }
}
