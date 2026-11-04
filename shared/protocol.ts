import { z } from 'zod';
import { operationIdSchema, scopeSchema, toolInputs } from './contracts';
import { bootstrapLimits } from './bootstrap-limits';

export function utf8Bytes(value: string) {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
export const jsonMessageBytes = (value: unknown) => utf8Bytes(JSON.stringify(value));

export const PROTOCOL_VERSION = 1;
const id = z.string().min(1);
const positive = z.number().int().positive();
export const limitsSchema = z.strictObject({
  maxMessageBytes: positive, maxBatchSteps: positive, maxQueuedOperations: positive,
  maxDepth: z.number().int().nonnegative(), maxNodes: positive, maxResponseBytes: positive,
  maxImportBytes: positive, maxExportPixels: positive, maxExportBytes: positive,
  operationTimeout: positive, dedupTtl: positive, maxJournalEntries: positive, resourceTtl: positive,
  clockSkew: z.number().int().nonnegative(),
});
export const helloSchema = z.strictObject({ type: z.literal('hello'), protocolVersion: positive,
  sessionId: id, capabilities: z.array(id), limits: limitsSchema, writeEnabled: z.boolean() });
export const welcomeSchema = z.strictObject({ type: z.literal('welcome'), protocolVersion: z.literal(PROTOCOL_VERSION),
  ...scopeSchema.shape, capabilities: z.array(id), limits: limitsSchema, writeEnabled: z.boolean() });
const commandTools = {
  getTree: 'figma_get_tree', findNodes: 'figma_find_nodes', getNodes: 'figma_get_nodes',
  getLocalResources: 'figma_get_local_resources', navigate: 'figma_navigate', applyBatch: 'figma_apply_batch',
  getOperation: 'figma_get_operation', cancel: 'figma_cancel_operation', exportNode: 'figma_export_node',
} as const;
const commandSchema = z.strictObject({ type: z.literal('command'), ...scopeSchema.shape,
  operationId: operationIdSchema, requestId: z.string().uuid().optional(), command: z.enum(Object.keys(commandTools) as [string, ...string[]]), params: z.record(z.string(), z.json()) });
export const ackSchema = z.strictObject({ type: z.literal('ack'), ...scopeSchema.shape, operationId: operationIdSchema, requestId: z.string().uuid().optional() });

export function negotiateHello(raw: unknown, generation: number, diagnostic = false) {
  const hello = helloSchema.parse(raw);
  if (hello.protocolVersion !== PROTOCOL_VERSION) throw new Error('PROTOCOL_MISMATCH');
  if (diagnostic && (!hello.writeEnabled || !hello.capabilities.includes('applyBatch'))) throw new Error('PROTOCOL_MISMATCH');
  const limits = Object.fromEntries(Object.entries(hello.limits).map(([key, value]) => [key, Math.min(value, bootstrapLimits[key as keyof typeof bootstrapLimits])]));
  return welcomeSchema.parse({ ...hello, type: 'welcome', connectionGeneration: generation, limits, writeEnabled: diagnostic,
    capabilities: hello.capabilities.filter(value => ['getContext', 'getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate', 'exportNode', 'applyBatch', 'getOperation', 'cancel'].includes(value)) });
}

export function validateCommand(raw: unknown, scope: z.infer<typeof scopeSchema>) {
  const command = commandSchema.parse(raw);
  if (command.sessionId !== scope.sessionId) throw new Error('SESSION_EXPIRED');
  if (command.connectionGeneration !== scope.connectionGeneration) throw new Error('SESSION_EXPIRED');
  const tool = commandTools[command.command as keyof typeof commandTools];
  const input = { scope, ...command.params,
    ...(['applyBatch', 'getOperation', 'cancel'].includes(command.command) ? { operationId: command.operationId } : {}),
  };
  // Params cannot override envelope identity; all identity fields live in the envelope.
  if ('scope' in command.params || 'operationId' in command.params) throw new Error('INVALID_ARGUMENT');
  toolInputs[tool].parse(input);
  return command;
}

export function validateAck(raw: unknown, pending: { sessionId: string; connectionGeneration: number; operationId: string }) {
  const ack = ackSchema.parse(raw);
  if (ack.sessionId !== pending.sessionId || ack.connectionGeneration !== pending.connectionGeneration || ack.operationId !== pending.operationId) {
    throw new Error('SESSION_EXPIRED');
  }
  return { status: 'running' as const };
}
