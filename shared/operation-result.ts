import { z } from 'zod';
import { errorSchema, operationIdSchema, scopeSchema, toolErrorSchema, nodeProjectionSchema, resourceProjectionSchemas } from './contracts';

const id = z.string().min(1);
export const operationStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'partially_applied', 'cancelled', 'unknown']);
export const stepResultSchema = z.strictObject({
  stepId: id,
  status: z.enum(['succeeded', 'failed', 'skipped']),
  outputs: z.strictObject({ nodeId: id.optional(), styleId: id.optional(), collectionId: id.optional(), modeId: id.optional(), variableId: id.optional() }),
  appliedChanges: z.strictObject({ nodeIds: z.array(id), resourceIds: z.array(id), details: z.array(z.json()).optional() }),
  error: errorSchema.optional(),
}).refine(v => v.status === 'failed' ? v.error !== undefined : v.error === undefined, 'Step status and error disagree');
export const operationResultSchema = z.strictObject({
  operationId: operationIdSchema, ...scopeSchema.shape, status: operationStatusSchema,
  steps: z.array(stepResultSchema), affectedNodeIds: z.array(id), affectedResourceIds: z.array(id),
  warnings: z.array(z.string()), error: errorSchema.optional(),
}).refine(v => v.status === 'failed' ? v.error !== undefined : v.status !== 'succeeded' || v.error === undefined, 'Operation status and error disagree');

const itemError = z.strictObject({ nodeId: id, error: errorSchema });
const node = z.strictObject({ nodeId: id, type: id, properties: nodeProjectionSchema, mixed: z.array(id), unavailable: z.array(id) });
const resource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('components'), id, properties: resourceProjectionSchemas.components, mixed: z.array(id), unavailable: z.array(id) }),
  z.strictObject({ kind: z.literal('styles'), id, properties: resourceProjectionSchemas.styles, mixed: z.array(id), unavailable: z.array(id) }),
  z.strictObject({ kind: z.literal('collections'), id, properties: resourceProjectionSchemas.collections, mixed: z.array(id), unavailable: z.array(id) }),
  z.strictObject({ kind: z.literal('variables'), id, properties: resourceProjectionSchemas.variables, mixed: z.array(id), unavailable: z.array(id) }),
]);
const result = (schema: z.ZodType) => z.union([schema, toolErrorSchema]);
export const nodesOutputSchema = result(z.strictObject({ nodes: z.array(z.union([node, itemError])) }));
export const resourcesOutputSchema = result(z.strictObject({ resources: z.array(resource), truncated: z.boolean(), nextCursor: id.optional() }));
export const navigateOutputSchema = result(z.strictObject({ currentPageId: id, selection: z.array(id) }));
export const operationOutputSchema = result(operationResultSchema);
const exportMetadata = { sessionId: id, nodeId: id, bytes: z.number().int().positive() };
const dimensions = { width: z.number().int().positive(), height: z.number().int().positive() };
const inlinePng = z.strictObject({ ...exportMetadata, ...dimensions, format: z.literal('PNG'), mimeType: z.literal('image/png') });
export const inlinePngTransferSchema = inlinePng.extend({ data: id });
export const exportOutputSchema = result(z.union([
  inlinePng,
  z.strictObject({ ...exportMetadata, ...dimensions, format: z.literal('PNG'), mimeType: z.literal('image/png'), uri: id, expiresAt: z.string() }),
  z.strictObject({ ...exportMetadata, format: z.literal('SVG'), mimeType: z.literal('image/svg+xml'), uri: id, expiresAt: z.string() }),
]));
