import { z } from 'zod';
import { operationIdSchema, scopeSchema } from './contracts';
import { exportChunkBytes } from './export-wire';
import { executionLimits } from './execution-limits';

const envelope = { ...scopeSchema.shape, operationId: operationIdSchema, requestId: z.string().uuid() };
export const executionStartSchema = z.strictObject({ type: z.literal('executionStart'), ...envelope,
  bytes: z.number().int().positive().max(executionLimits.maxResultBytes), total: z.number().int().positive(),
  chunkBytes: z.number().int().min(3).max(exportChunkBytes).multipleOf(3),
}).refine(v => v.total === Math.ceil(v.bytes / v.chunkBytes));
export const executionChunkSchema = z.strictObject({ type: z.literal('executionChunk'), ...envelope,
  index: z.number().int().nonnegative(), total: z.number().int().positive(),
  data: z.string().min(4).max(exportChunkBytes * 4 / 3).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).refine(v => v.index < v.total);
