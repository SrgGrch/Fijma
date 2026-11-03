import { timingSafeEqual, randomInt, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { negotiateHello, validateAck } from '../shared/protocol';
import { contextReplySchema, disconnectedContext, contextSchema } from '../shared/context';
import { treeReplySchema, searchReplySchema, nodesReplySchema, resourcesReplySchema, navigateReplySchema } from '../shared/tree-result';
import { toolInputs } from '../shared/contracts';
import { diagnosticControlSchema, operationReplySchema } from '../shared/ui-messages';
import { exportStartSchema, exportChunkSchema, exportErrorSchema } from '../shared/export-wire';
import { ExportTransfer } from './export-transfer';
import { createDiagnosticsSession } from './diagnostics-session';

const pairSchema = z.strictObject({ type: z.literal('pair'), secret: z.string().length(64).regex(/^[0-9a-f]+$/) });
const operationId = () => {
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const random = randomUUID();
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(15, 18)}-${random.slice(19)}`;
};

export async function createPairingListener(secret: string, port: number, diagnostic?: {
  onControl: (socket: WebSocket, control: { action: 'positive' | 'replay' | 'snapshot' }, binding: ReturnType<typeof negotiateHello>) => void;
  onResult: (socket: WebSocket, reply: ReturnType<typeof operationReplySchema.parse>, binding: ReturnType<typeof negotiateHello>) => void;
}, onBinding?: (binding?: ReturnType<typeof negotiateHello>) => void) {
  const safeError = (error: { code: string; details?: unknown }) => {
    const fonts = z.strictObject({ fonts: z.array(z.strictObject({ family: z.string().min(1).max(200), style: z.string().min(1).max(200) })).max(100) }).safeParse(error.details);
    const details = error.code === 'FONT_UNAVAILABLE' && fonts.success && !JSON.stringify(fonts.data).includes(secret) ? { details: fonts.data } : {};
    return { code: error.code, message: 'Operation in Figma failed.', recoveryAction: 'Check the error code and reread the context.', ...details };
  };
  const expected = Buffer.from(secret);
  if (expected.length !== 64) throw new Error('INVALID_ARGUMENT');
  const unauthenticated = new Set<WebSocket>();
  let active: WebSocket | undefined;
  let generation = randomInt(1, 2 ** 48);
  let binding: ReturnType<typeof negotiateHello> | undefined;
  let journal: ReturnType<typeof createDiagnosticsSession> | undefined;
  let contextRead = false;
  const operations = new Map<string, { id: string; action: 'applyBatch' | 'getOperation' | 'cancel'; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; started: number }>();
  type ReadAction = 'getContext' | 'getTree' | 'findNodes' | 'getNodes' | 'getLocalResources' | 'navigate' | 'exportNode';
  function deferred(action: ReadAction, id: string) {
    const current = journal, started = performance.now();
    let resolve!: (value: unknown) => void, reject!: (code: string) => void;
    const promise = new Promise<unknown>((yes, no) => {
      resolve = value => {
        try {
          const error = value && typeof value === 'object' && 'error' in value ? (value as { error?: { code?: unknown } }).error : undefined;
          const timing = { operationId: id, durationMs: performance.now() - started };
          if (error) current?.failed(action, timing, error.code);
          else current?.readCompleted(action, timing);
        } catch { /* Logging must never change the reply. */ }
        yes(value);
      };
      reject = code => {
        try { current?.failed(action, { operationId: id, durationMs: performance.now() - started }, code); } catch { /* Preserve the original error. */ }
        no(new Error(code));
      };
    });
    return { promise, resolve, reject };
  }
  type Kind = 'context' | 'tree' | 'search' | 'nodes' | 'resources' | 'navigate' | 'export';
  let pending: { kind: Kind; id: string; promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (code: string) => void; timer: ReturnType<typeof setTimeout>; transfer?: ExportTransfer } | undefined;
  const late = new Map<string, { kind: Kind; expires: number }>();
  let draining: { id: string; expires: number } | undefined;
  const drainingActive = () => { if (draining && draining.expires <= Date.now()) draining = undefined; return Boolean(draining); };
  const remember = (kind: Kind, id: string) => {
    const now = Date.now();
    for (const [key, item] of late) if (item.expires <= now) late.delete(key);
    while (late.size >= 100) late.delete(late.keys().next().value!);
    late.set(id, { kind, expires: now + Math.max(binding?.limits.resourceTtl ?? 60000, binding?.limits.operationTimeout ?? 0) });
  };
  const failPending = (code = 'NOT_CONNECTED', timedOut = false) => {
    if (!pending) return;
    const current = pending; pending = undefined; clearTimeout(current.timer);
    if (timedOut) {
      remember(current.kind, current.id);
      draining = { id: current.id, expires: late.get(current.id)!.expires };
    }
    current.reject(code);
  };
  const timeout = () => failPending('FIGMA_API_ERROR', true);
  let attempts = 0, windowStart = Date.now();
  const server = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: 65536, perMessageDeflate: false,
    verifyClient: ({ origin, req }) => {
      if (Date.now() - windowStart >= 60000) { attempts = 0; windowStart = Date.now(); }
      return ++attempts <= 60 && unauthenticated.size < 4 &&
        req.socket.remoteAddress === '127.0.0.1' && (!origin || origin === 'null' || origin === 'https://www.figma.com');
    },
  });
  server.on('connection', socket => {
    unauthenticated.add(socket);
    const timer = setTimeout(() => socket.terminate(), 5000);
    const release = () => { clearTimeout(timer); unauthenticated.delete(socket); if (active === socket) { active = undefined; binding = undefined; contextRead = false; late.clear(); draining = undefined; failPending(); for (const operation of operations.values()) { clearTimeout(operation.timer); operation.reject(new Error('OUTCOME_UNKNOWN')); } operations.clear(); journal?.close(); journal = undefined; onBinding?.(); } };
    socket.on('close', release);
    socket.on('error', () => { release(); socket.terminate(); });
    socket.once('message', (bytes, binary) => {
      let supplied;
      try { supplied = !binary && bytes.length <= 1024 && pairSchema.parse(JSON.parse(bytes.toString())); } catch { /* Invalid authentication has no payload diagnostics. */ }
      if (!supplied || !timingSafeEqual(Buffer.from(supplied.secret), expected)) { socket.close(1008, 'AUTH_FAILED'); return; }
      clearTimeout(timer); unauthenticated.delete(socket);
      if (active) { socket.close(1008, 'SESSION_BUSY'); return; }
      active = socket;
      socket.send(JSON.stringify({ type: 'paired' }));
      const currentGeneration = ++generation;
      const helloTimer = setTimeout(() => socket.terminate(), 5000);
      socket.once('close', () => clearTimeout(helloTimer));
      socket.once('message', (data, binary) => {
        clearTimeout(helloTimer);
        try {
          if (binary) throw new Error('PROTOCOL_MISMATCH');
          const welcome = negotiateHello(JSON.parse(data.toString()), currentGeneration, Boolean(diagnostic));
          binding = welcome;
          if (!diagnostic) journal = createDiagnosticsSession({ sessionId: welcome.sessionId, connectionGeneration: welcome.connectionGeneration }, secret, process.env);
          onBinding?.(welcome);
          socket.send(JSON.stringify(welcome));
          socket.on('message', (bytes, binary) => {
            try {
              if (binary) throw new Error('PROTOCOL_MISMATCH');
              if (!binding || bytes.length > binding.limits.maxMessageBytes) throw new Error('PROTOCOL_MISMATCH');
              const message = JSON.parse(bytes.toString());
              if (diagnostic && binding && message?.type === 'diagControl') {
                diagnostic.onControl(socket, diagnosticControlSchema.parse(message), binding);
                return;
              }
              if (diagnostic && binding && message?.type === 'operationResult') {
                const reply = operationReplySchema.parse(message);
                if (reply.sessionId !== binding.sessionId || reply.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
                diagnostic.onResult(socket, reply, binding);
                return;
              }
              if (!diagnostic && message?.type === 'writeState') {
                const state = z.strictObject({ type: z.literal('writeState'), sessionId: z.string(), connectionGeneration: z.number().int().positive(), enabled: z.boolean(), reason: z.string().optional() }).parse(message);
                if (state.sessionId !== binding.sessionId || state.connectionGeneration !== binding.connectionGeneration || state.enabled && !binding.capabilities.includes('applyBatch')) throw new Error('SESSION_EXPIRED');
                binding = { ...binding, writeEnabled: state.enabled }; return;
              }
              if (!diagnostic && message?.type === 'ack') { if (!operations.has(message.requestId)) return; validateAck(message, { sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration, operationId: operations.get(message.requestId)!.id }); return; }
              if (!diagnostic && message?.type === 'operationResult') {
                const reply = operationReplySchema.parse(message);
                if (reply.sessionId !== binding.sessionId || reply.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
                const operation = operations.get(reply.requestId ?? '');
                if (!operation) return;
                if (operation.id !== reply.operationId || 'operationId' in reply.data && (reply.data.connectionGeneration > binding.connectionGeneration || operation.action === 'applyBatch' && reply.data.connectionGeneration !== binding.connectionGeneration)) throw new Error('PROTOCOL_MISMATCH');
                operations.delete(reply.requestId!); clearTimeout(operation.timer);
                const timing = { operationId: reply.operationId, durationMs: performance.now() - operation.started };
                if ('operationId' in reply.data) {
                  journal?.operationCompleted(operation.action, timing, reply.data);
                  const data = { ...reply.data, warnings: [], ...(reply.data.error ? { error: safeError(reply.data.error) } : {}),
                    steps: reply.data.steps.map(step => ({ ...step, ...(step.error ? { error: safeError(step.error) } : {}) })) };
                  operation.resolve(data);
                } else { journal?.failed(operation.action, timing, reply.data.error.code); operation.resolve({ error: safeError(reply.data.error) }); }
                return;
              }
              const schemas = { tree: treeReplySchema, search: searchReplySchema, nodes: nodesReplySchema, resources: resourcesReplySchema, navigate: navigateReplySchema };
              const kinds: Record<string, Kind> = { context: 'context', treeResult: 'tree', searchResult: 'search', nodesResult: 'nodes', resourcesResult: 'resources', navigateResult: 'navigate', exportStart: 'export', exportChunk: 'export', exportError: 'export' };
              const kind = kinds[message?.type];
              const messageId = kind === 'context' ? message.requestId : message.operationId;
              const old = late.get(messageId);
              if (old && old.expires <= Date.now()) late.delete(messageId);
              else if (old && old.kind === kind) {
                const parsed = kind === 'context' ? contextReplySchema.parse(message) : kind === 'export' ?
                  (message.type === 'exportStart' ? exportStartSchema : message.type === 'exportChunk' ? exportChunkSchema : exportErrorSchema).parse(message) : schemas[kind].parse(message);
                if (!binding || parsed.sessionId !== binding.sessionId || parsed.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
                if (draining?.id === messageId && (kind !== 'export' || message.type === 'exportError' || (message.type === 'exportChunk' && message.index === message.total - 1))) draining = undefined;
                return;
              }
              if (pending?.kind === 'export') {
                if (kind !== 'export' || !binding || messageId !== pending.id) throw new Error('PROTOCOL_MISMATCH');
                if (message.type === 'exportError') {
                  const reply = exportErrorSchema.parse(message);
                  if (reply.sessionId !== binding.sessionId || reply.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
                  const current = pending; pending = undefined; clearTimeout(current.timer); remember(current.kind, current.id);
                  current.resolve({ error: safeError(reply.error) }); return;
                }
                const result = pending.transfer!.accept(message);
                if (result) {
                  const current = pending; pending = undefined; clearTimeout(current.timer); remember(current.kind, current.id);
                  current.resolve({ ...result, sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration });
                }
                return;
              }
              if (pending && pending.kind !== 'context') {
                const reply = schemas[pending.kind].parse(message);
                if (!binding || reply.operationId !== pending.id || reply.sessionId !== binding.sessionId || reply.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
                const current = pending; pending = undefined; clearTimeout(current.timer); remember(current.kind, current.id);
                let data = reply.data;
                if (current.kind === 'nodes' && data && 'nodes' in data) {
                  data = { ...data, nodes: data.nodes.map(node => 'error' in node ? { nodeId: node.nodeId.includes(secret) ? '[redacted]' : node.nodeId, error: safeError(node.error) } : node) };
                }
                current.resolve(reply.error ? { error: safeError(reply.error) } : data);
                return;
              }
              const reply = contextReplySchema.parse(message);
              if (!binding || !pending || reply.requestId !== pending.id || reply.sessionId !== binding.sessionId || reply.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
              const result = contextSchema.parse({ ...reply.document, state: 'ready', sessionId: binding.sessionId,
                connectionGeneration: binding.connectionGeneration, writeEnabled: binding.writeEnabled, capabilities: binding.capabilities.filter(item => ['getContext', 'getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate', 'exportNode', 'applyBatch', 'getOperation', 'cancel'].includes(item)), limits: binding.limits });
              const current = pending; pending = undefined; clearTimeout(current.timer); remember(current.kind, current.id);
              contextRead = true; current.resolve(result);
            } catch { socket.close(1008, 'PROTOCOL_MISMATCH'); }
          });
        } catch { socket.close(1008, 'PROTOCOL_MISMATCH'); }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { address: server.address(), getBinding: () => binding,
    readDiagnostics: () => journal?.read() ?? { entries: [], extended: [], extendedEnabled: false },
    clearDiagnostics: () => { journal?.clear(); },
    async getContext() {
    if (!active || !binding || !binding.capabilities.includes('getContext')) return disconnectedContext;
    if (drainingActive()) throw new Error('RESOURCE_LIMIT');
    if (pending) {
      if (pending.kind !== 'context') throw new Error('RESOURCE_LIMIT');
      return pending.promise;
    }
    const id = operationId();
    const { promise, resolve, reject } = deferred('getContext', id);
    pending = { kind: 'context', id, promise, resolve, reject, timer: setTimeout(timeout, binding.limits.operationTimeout) };
    active.send(JSON.stringify({ type: 'getContext', requestId: pending.id, sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration }));
    return promise;
  }, async getTree(raw: unknown) { return read('getTree', raw); }, async findNodes(raw: unknown) { return read('findNodes', raw); },
    async getNodes(raw: unknown) { return read('getNodes', raw); }, async getLocalResources(raw: unknown) { return read('getLocalResources', raw); },
    async navigate(raw: unknown) { return read('navigate', raw); }, async exportNode(raw: unknown) { return read('exportNode', raw); },
    async applyBatch(raw: unknown) { return execute('applyBatch', raw); }, async getOperation(raw: unknown) { return execute('getOperation', raw); }, async cancel(raw: unknown) { return execute('cancel', raw); }, async close() {
    failPending(); for (const operation of operations.values()) { clearTimeout(operation.timer); operation.reject(new Error('OUTCOME_UNKNOWN')); } operations.clear(); journal?.close(); journal = undefined;
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };

  async function execute(command: 'applyBatch' | 'getOperation' | 'cancel', raw: unknown) {
    if (!active || !binding) throw new Error('NOT_CONNECTED');
    const schema = { applyBatch: toolInputs.figma_apply_batch, getOperation: toolInputs.figma_get_operation, cancel: toolInputs.figma_cancel_operation }[command];
    const input = schema.parse(raw);
    if (input.scope.sessionId !== binding.sessionId || input.scope.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
    if (!binding.capabilities.includes(command)) throw new Error('CAPABILITY_UNAVAILABLE');
    if (command === 'applyBatch' && !contextRead) throw new Error('SESSION_EXPIRED');
    if (operations.size >= binding.limits.maxQueuedOperations + 2) throw new Error('RESOURCE_LIMIT');
    const { scope, operationId: id, ...params } = input;
    const requestId = randomUUID();
    const started = performance.now();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { operations.delete(requestId); journal?.failed(command, { operationId: id, durationMs: performance.now() - started }, 'OUTCOME_UNKNOWN'); reject(new Error('OUTCOME_UNKNOWN')); }, binding!.limits.operationTimeout);
      operations.set(requestId, { id, action: command, resolve, reject, timer, started });
    });
    active.send(JSON.stringify({ type: 'command', ...scope, operationId: id, requestId, command, params }));
    return promise;
  }

  async function read(command: 'getTree' | 'findNodes' | 'getNodes' | 'getLocalResources' | 'navigate' | 'exportNode', raw: unknown) {
    if (!active || !binding) throw new Error('NOT_CONNECTED');
    if (drainingActive()) throw new Error('RESOURCE_LIMIT');
    const inputs = { getTree: toolInputs.figma_get_tree, findNodes: toolInputs.figma_find_nodes,
      getNodes: toolInputs.figma_get_nodes, getLocalResources: toolInputs.figma_get_local_resources, navigate: toolInputs.figma_navigate, exportNode: toolInputs.figma_export_node };
    const input = inputs[command].parse(raw);
    if (input.scope.sessionId !== binding.sessionId || input.scope.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
    if (!binding.capabilities.includes(command)) throw new Error('CAPABILITY_UNAVAILABLE');
    if (('depth' in input && input.depth > binding.limits.maxDepth) || ('limit' in input && input.limit > binding.limits.maxNodes) ||
      ('nodeIds' in input && input.nodeIds.length > binding.limits.maxNodes)) throw new Error('RESOURCE_LIMIT');
    if (pending) throw new Error('RESOURCE_LIMIT');
    const id = operationId();
    const { promise, resolve, reject } = deferred(command, id);
    const kinds = { getTree: 'tree', findNodes: 'search', getNodes: 'nodes', getLocalResources: 'resources', navigate: 'navigate', exportNode: 'export' } as const;
    const transfer = command === 'exportNode' ? new ExportTransfer({ ...input.scope, operationId: id }, input as { nodeId: string; format: 'PNG' | 'SVG' }, binding.limits) : undefined;
    pending = { kind: kinds[command], id, promise, resolve, reject, transfer, timer: setTimeout(timeout, binding.limits.operationTimeout) };
    const { scope, ...params } = input;
    active.send(JSON.stringify({ type: 'command', ...scope, operationId: id, command, params }));
    return promise;
  }
}
