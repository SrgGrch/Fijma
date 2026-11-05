import { z } from 'zod';
import { errorSchema, operationIdSchema, scopeSchema, toolErrorSchema } from './contracts';
import { operationOutputSchema, operationStatusSchema } from './operation-result';
import { executionLimits } from './execution-limits';

export const executionResourceSchema = z.strictObject({
  uri: z.string().regex(/^figma-resource:\/\/execution\/[A-Za-z0-9_-]{43}$/),
  mimeType: z.literal('application/json'), bytes: z.number().int().positive().max(executionLimits.maxResultBytes), expiresAt: z.string(),
});
export const executionResultSchema = z.strictObject({
  operationId: operationIdSchema, ...scopeSchema.shape, kind: z.literal('execute'), status: operationStatusSchema,
  effects: z.enum(['none', 'unknown']), value: z.json().optional(), resource: executionResourceSchema.optional(),
  valueResourcePending: z.literal(true).optional(),
  logs: z.array(z.strictObject({ level: z.enum(['log', 'info', 'warn', 'error', 'debug']), message: z.string().max(executionLimits.maxLogBytes) })).max(executionLimits.maxLogEntries),
  logsTruncated: z.boolean(), warnings: z.array(z.string().max(2048)).max(100), error: errorSchema.optional(),
}).refine(v => Number(v.value !== undefined) + Number(v.resource !== undefined) + Number(v.valueResourcePending === true) <= 1,
  'Only one result representation is allowed')
  .refine(v => v.status === 'failed' ? v.error !== undefined : v.status !== 'succeeded' || v.error === undefined,
    'Execution status and error disagree');
export const executionOutputSchema = z.union([executionResultSchema, toolErrorSchema]);
export const anyOperationOutputSchema = z.union([operationOutputSchema, executionResultSchema]);
