import { z } from 'zod';
import { scopeSchema, errorSchema } from './contracts';
import { operationResultSchema, operationOutputSchema } from './operation-result';
import { helloSchema, welcomeSchema, ackSchema } from './protocol';
import { contextReplySchema, contextRequestSchema } from './context';
import { treeReplySchema, searchReplySchema, nodesReplySchema, resourcesReplySchema, navigateReplySchema } from './tree-result';
import { exportStartSchema, exportChunkSchema, exportErrorSchema } from './export-wire';

export const pairedSchema = z.strictObject({ type: z.literal('paired') });
export const yieldSchema = z.strictObject({ type: z.literal('yield'), id: z.number().int().positive().safe() });
export const boundSchema = z.strictObject({ type: z.literal('bound'), ...scopeSchema.shape, documentLabel: z.string(), writeEnabled: z.boolean(), message: z.string() });
export const operationReplySchema = z.strictObject({ type: z.literal('operationResult'), ...scopeSchema.shape,
  operationId: operationResultSchema.shape.operationId, requestId: z.string().uuid().optional(), data: operationOutputSchema }).refine(value =>
  'error' in value.data && !('operationId' in value.data) || value.operationId === value.data.operationId && value.sessionId === value.data.sessionId);
export const diagnosticControlSchema = z.strictObject({ type: z.literal('diagControl'), action: z.enum(['positive', 'replay', 'snapshot']) });
export const diagnosticEventSchema = z.discriminatedUnion('event', [
  z.strictObject({ type: z.literal('diagEvent'), event: z.literal('positive'), result: operationResultSchema }),
  z.strictObject({ type: z.literal('diagEvent'), event: z.literal('snapshot'), ...scopeSchema.shape,
    documentLabel: z.string(), pageId: z.string().min(1), markerIds: z.array(z.string().min(1)) }),
  z.strictObject({ type: z.literal('diagEvent'), event: z.literal('replay-sent'), original: scopeSchema, current: scopeSchema }),
  z.strictObject({ type: z.literal('diagEvent'), event: z.literal('error'), code: errorSchema.shape.code }),
]);
export const writeStateSchema = z.strictObject({ type: z.literal('writeState'), enabled: z.boolean(), reason: errorSchema.shape.code.optional() });
export const mainErrorSchema = z.strictObject({ type: z.literal('error'), code: errorSchema.shape.code });
export const mainMessageSchema = z.union([helloSchema, boundSchema, contextReplySchema, treeReplySchema, searchReplySchema,
  nodesReplySchema, resourcesReplySchema, navigateReplySchema, exportStartSchema, exportChunkSchema, exportErrorSchema, operationReplySchema, ackSchema, mainErrorSchema, writeStateSchema, yieldSchema]);
export const serverMessageSchema = z.union([pairedSchema, welcomeSchema, contextRequestSchema]);
