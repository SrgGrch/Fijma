import { z } from 'zod';
import { limitsSchema } from './protocol';

export const documentContextSchema = z.strictObject({
  editorType: z.string().optional(), documentLabel: z.string(), pages: z.array(z.strictObject({ id: z.string().min(1), name: z.string() })),
  currentPageId: z.string().min(1), selection: z.array(z.string().min(1)),
});
export const contextSchema = z.strictObject({
  state: z.enum(['disconnected', 'ready']), sessionId: z.string().nullable(), connectionGeneration: z.number().int().positive().nullable(),
  editorType: z.string().optional(), documentLabel: z.string().nullable(), currentPageId: z.string().nullable(),
  pages: z.array(z.strictObject({ id: z.string().min(1), name: z.string() })), selection: z.array(z.string()),
  executeEnabled: z.boolean().default(false), execution: z.strictObject({ mode: z.literal('trusted'), readOnlyEnforced: z.literal(false), hardTimeout: z.literal(false), editorType: z.string(), documentAccess: z.literal('dynamic-page'), typingsVersion: z.string(), runtimeSupport: z.literal('unknown'), limits: z.strictObject({ maxCodeBytes: z.number().int().positive(), maxArgsBytes: z.number().int().positive(), maxResultBytes: z.number().int().positive(), maxLogBytes: z.number().int().positive(), maxLogEntries: z.number().int().positive(), maxDepth: z.number().int().positive(), maxValues: z.number().int().positive(), maxResources: z.number().int().positive(), maxResourceBytes: z.number().int().positive(), resourceTtl: z.number().int().positive() }).optional() }).optional(),
  writeEnabled: z.boolean(), capabilities: z.array(z.string()), limits: limitsSchema.nullable(),
});
export const disconnectedContext = {
  state: 'disconnected' as const, sessionId: null, connectionGeneration: null, documentLabel: null,
  currentPageId: null, pages: [], selection: [], writeEnabled: false as const, executeEnabled: false as const, capabilities: [], limits: null,
};
export const contextRequestSchema = z.strictObject({ type: z.literal('getContext'), requestId: z.string().min(1), sessionId: z.string().min(1), connectionGeneration: z.number().int().positive() });
export const contextReplySchema = z.strictObject({ type: z.literal('context'), requestId: z.string().min(1), sessionId: z.string().min(1), connectionGeneration: z.number().int().positive(), document: documentContextSchema });
