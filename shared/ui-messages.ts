import { z } from 'zod';
import { scopeSchema, errorSchema } from './contracts';
import { helloSchema, welcomeSchema, ackSchema } from './protocol';
import { contextReplySchema, contextRequestSchema } from './context';
import { treeReplySchema, searchReplySchema, nodesReplySchema, resourcesReplySchema, navigateReplySchema } from './tree-result';

export const pairedSchema = z.strictObject({ type: z.literal('paired') });
export const yieldSchema = z.strictObject({ type: z.literal('yield'), id: z.number().int().positive().safe() });
export const boundSchema = z.strictObject({ type: z.literal('bound'), ...scopeSchema.shape, documentLabel: z.string(), writeEnabled: z.literal(false), message: z.string() });
export const mainErrorSchema = z.strictObject({ type: z.literal('error'), code: errorSchema.shape.code });
export const mainMessageSchema = z.union([helloSchema, boundSchema, contextReplySchema, treeReplySchema, searchReplySchema,
  nodesReplySchema, resourcesReplySchema, navigateReplySchema, ackSchema, mainErrorSchema, yieldSchema]);
export const serverMessageSchema = z.union([pairedSchema, welcomeSchema, contextRequestSchema]);
