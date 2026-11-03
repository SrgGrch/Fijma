import { z } from 'zod';
import { scopeSchema, operationIdSchema, errorSchema } from './contracts';

export const treeDataSchema = z.strictObject({
  nodes: z.array(z.strictObject({ nodeId: z.string(), name: z.string(), type: z.string(), depth: z.number().int().nonnegative() })),
  truncated: z.boolean(), nextCursor: z.string().optional(),
});
export const treeReplySchema = z.strictObject({ type: z.literal('treeResult'), ...scopeSchema.shape,
  operationId: operationIdSchema, data: treeDataSchema.optional(), error: errorSchema.optional(),
}).refine(value => Boolean(value.data) !== Boolean(value.error));
export const treeOutputSchema = z.strictObject({
  nodes: treeDataSchema.shape.nodes.optional(), truncated: z.boolean().optional(), nextCursor: z.string().optional(), error: errorSchema.optional(),
}).refine(value => value.error ? value.nodes === undefined : value.nodes !== undefined && value.truncated !== undefined);

export const searchDataSchema = z.strictObject({
  nodes: z.array(treeDataSchema.shape.nodes.element.extend({ pageId: z.string() })),
  truncated: z.boolean(), nextCursor: z.string().optional(),
});
export const searchReplySchema = z.strictObject({ type: z.literal('searchResult'), ...scopeSchema.shape,
  operationId: operationIdSchema, data: searchDataSchema.optional(), error: errorSchema.optional(),
}).refine(value => Boolean(value.data) !== Boolean(value.error));
export const searchOutputSchema = z.strictObject({
  nodes: searchDataSchema.shape.nodes.optional(), truncated: z.boolean().optional(), nextCursor: z.string().optional(), error: errorSchema.optional(),
}).refine(value => value.error ? value.nodes === undefined : value.nodes !== undefined && value.truncated !== undefined);
