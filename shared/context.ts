import { z } from 'zod';
import { limitsSchema } from './protocol';

export const documentContextSchema = z.strictObject({
  documentLabel: z.string(), pages: z.array(z.strictObject({ id: z.string().min(1), name: z.string() })),
  currentPageId: z.string().min(1), selection: z.array(z.string().min(1)),
});
export const contextSchema = z.strictObject({
  state: z.enum(['disconnected', 'ready']), sessionId: z.string().nullable(), connectionGeneration: z.number().int().positive().nullable(),
  documentLabel: z.string().nullable(), currentPageId: z.string().nullable(),
  pages: z.array(z.strictObject({ id: z.string().min(1), name: z.string() })), selection: z.array(z.string()),
  writeEnabled: z.literal(false), capabilities: z.array(z.string()), limits: limitsSchema.nullable(),
});
export const disconnectedContext = {
  state: 'disconnected' as const, sessionId: null, connectionGeneration: null, documentLabel: null,
  currentPageId: null, pages: [], selection: [], writeEnabled: false as const, capabilities: [], limits: null,
};
export const contextRequestSchema = z.strictObject({ type: z.literal('getContext'), requestId: z.string().min(1), sessionId: z.string().min(1), connectionGeneration: z.number().int().positive() });
export const contextReplySchema = z.strictObject({ type: z.literal('context'), requestId: z.string().min(1), sessionId: z.string().min(1), connectionGeneration: z.number().int().positive(), document: documentContextSchema });
