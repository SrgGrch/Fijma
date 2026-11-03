import { z } from 'zod';
import { operationIdSchema, scopeSchema, errorSchema } from './contracts';

export const exportChunkBytes = 12_288;
const envelope = { ...scopeSchema.shape, operationId: operationIdSchema };
export const exportStartSchema = z.strictObject({ type: z.literal('exportStart'), ...envelope,
  nodeId: z.string().min(1), format: z.enum(['PNG', 'SVG']), bytes: z.number().int().positive(), total: z.number().int().positive(),
  chunkBytes: z.number().int().min(3).max(exportChunkBytes).multipleOf(3),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
}).refine(value => value.total === Math.ceil(value.bytes / value.chunkBytes) &&
  (value.format === 'PNG' ? value.width !== undefined && value.height !== undefined : value.width === undefined && value.height === undefined));
export const exportChunkSchema = z.strictObject({ type: z.literal('exportChunk'), ...envelope,
  index: z.number().int().nonnegative(), total: z.number().int().positive(),
  data: z.string().min(4).max(exportChunkBytes * 4 / 3).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export const exportErrorSchema = z.strictObject({ type: z.literal('exportError'), ...envelope, error: errorSchema });

export function chunkSizeFor(scope: { sessionId: string; connectionGeneration: number; operationId: string }, limits: { maxMessageBytes: number; maxExportBytes: number }) {
  const empty = JSON.stringify({ type: 'exportChunk', ...scope, index: limits.maxExportBytes, total: limits.maxExportBytes, data: '' });
  const overhead = encodeURI(empty).replace(/%[A-F\d]{2}/g, 'x').length;
  const size = Math.min(exportChunkBytes, Math.floor((limits.maxMessageBytes - overhead) / 4) * 3);
  if (size < 3) throw new Error('RESOURCE_LIMIT');
  return size;
}

export function pngDimensions(bytes: Uint8Array) {
  const magic = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || magic.some((byte, i) => bytes[i] !== byte) ||
      bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13 ||
      bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) throw new Error('FIGMA_API_ERROR');
  const read = (offset: number) => (bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
  const width = read(16), height = read(20);
  if (!width || !height) throw new Error('FIGMA_API_ERROR');
  return { width, height };
}
