import { z } from 'zod';
import { scopeSchema, errorSchema } from './contracts';
import { operationResultSchema } from './operation-result';
import { helloSchema, welcomeSchema, ackSchema } from './protocol';
import { contextReplySchema, contextRequestSchema } from './context';
import { treeReplySchema, searchReplySchema, nodesReplySchema, resourcesReplySchema, navigateReplySchema } from './tree-result';

export const pairedSchema = z.strictObject({ type: z.literal('paired') });
export const yieldSchema = z.strictObject({ type: z.literal('yield'), id: z.number().int().positive().safe() });
export const boundSchema = z.strictObject({ type: z.literal('bound'), ...scopeSchema.shape, documentLabel: z.string(), writeEnabled: z.boolean(), message: z.string() });
export const operationReplySchema = z.strictObject({ type: z.literal('operationResult'), ...scopeSchema.shape,
  operationId: operationResultSchema.shape.operationId, data: operationResultSchema }).refine(value =>
  value.operationId === value.data.operationId && value.sessionId === value.data.sessionId && value.connectionGeneration === value.data.connectionGeneration);
export const diagnosticControlSchema = z.strictObject({ type: z.literal('diagControl'), action: z.enum(['positive', 'replay', 'snapshot']) });
export const diagnosticEventSchema = z.discriminatedUnion('event', [
  z.strictObject({ type: z.literal('diagEvent'), event: z.literal('positive'), result: operationResultSchema }),
  z.strictObject({ type: z.literal('diagEvent'), event: z.literal('snapshot'), ...scopeSchema.shape,
    documentLabel: z.string(), pageId: z.string().min(1), markerIds: z.array(z.string().min(1)) }),
  z.strictObject({ type: z.literal('diagEvent'), event: z.literal('replay-sent'), original: scopeSchema, current: scopeSchema }),
  z.strictObject({ type: z.literal('diagEvent'), event: z.literal('error'), code: errorSchema.shape.code }),
]);
export const mainErrorSchema = z.strictObject({ type: z.literal('error'), code: errorSchema.shape.code });
export const mainMessageSchema = z.union([helloSchema, boundSchema, contextReplySchema, treeReplySchema, searchReplySchema,
  nodesReplySchema, resourcesReplySchema, navigateReplySchema, operationReplySchema, ackSchema, mainErrorSchema, yieldSchema]);
export const serverMessageSchema = z.union([pairedSchema, welcomeSchema, contextRequestSchema]);
