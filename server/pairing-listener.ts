import { timingSafeEqual, randomInt, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { negotiateHello } from '../shared/protocol';
import { contextReplySchema, disconnectedContext, contextSchema } from '../shared/context';
import { treeReplySchema, searchReplySchema, nodesReplySchema, resourcesReplySchema, navigateReplySchema } from '../shared/tree-result';
import { toolInputs } from '../shared/contracts';
import { diagnosticControlSchema, operationReplySchema } from '../shared/ui-messages';
import { exportStartSchema, exportChunkSchema, exportErrorSchema } from '../shared/export-wire';
import { ExportTransfer } from './export-transfer';

const pairSchema = z.strictObject({ type: z.literal('pair'), secret: z.string().length(64).regex(/^[0-9a-f]+$/) });

export async function createPairingListener(secret: string, port: number, diagnostic?: {
  onControl: (socket: WebSocket, control: { action: 'positive' | 'replay' | 'snapshot' }, binding: ReturnType<typeof negotiateHello>) => void;
  onResult: (socket: WebSocket, reply: ReturnType<typeof operationReplySchema.parse>, binding: ReturnType<typeof negotiateHello>) => void;
}, onBinding?: (binding?: ReturnType<typeof negotiateHello>) => void) {
  const expected = Buffer.from(secret);
  if (expected.length !== 64) throw new Error('INVALID_ARGUMENT');
  const unauthenticated = new Set<WebSocket>();
  let active: WebSocket | undefined;
  let generation = randomInt(1, 2 ** 48);
  let binding: ReturnType<typeof negotiateHello> | undefined;
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
    const release = () => { clearTimeout(timer); unauthenticated.delete(socket); if (active === socket) { active = undefined; binding = undefined; late.clear(); draining = undefined; failPending(); onBinding?.(); } };
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
                  current.resolve({ error: reply.error }); return;
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
                current.resolve(reply.error ? { error: reply.error } : reply.data);
                return;
              }
              const reply = contextReplySchema.parse(message);
              if (!binding || !pending || reply.requestId !== pending.id || reply.sessionId !== binding.sessionId || reply.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
              const result = contextSchema.parse({ ...reply.document, state: 'ready', sessionId: binding.sessionId,
                connectionGeneration: binding.connectionGeneration, writeEnabled: binding.writeEnabled, capabilities: binding.capabilities.filter(item => ['getContext', 'getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate', 'exportNode', ...(diagnostic ? ['applyBatch'] : [])].includes(item)), limits: binding.limits });
              const current = pending; pending = undefined; clearTimeout(current.timer); remember(current.kind, current.id);
              current.resolve(result);
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
  return { address: server.address(), getBinding: () => binding, async getContext() {
    if (!active || !binding || !binding.capabilities.includes('getContext')) return disconnectedContext;
    if (drainingActive()) throw new Error('RESOURCE_LIMIT');
    if (pending) {
      if (pending.kind !== 'context') throw new Error('RESOURCE_LIMIT');
      return pending.promise;
    }
    let resolve!: (value: unknown) => void, reject!: (code: string) => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = code => no(new Error(code)); });
    pending = { kind: 'context', id: randomUUID(), promise, resolve, reject, timer: setTimeout(timeout, binding.limits.operationTimeout) };
    active.send(JSON.stringify({ type: 'getContext', requestId: pending.id, sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration }));
    return promise;
  }, async getTree(raw: unknown) { return read('getTree', raw); }, async findNodes(raw: unknown) { return read('findNodes', raw); },
    async getNodes(raw: unknown) { return read('getNodes', raw); }, async getLocalResources(raw: unknown) { return read('getLocalResources', raw); },
    async navigate(raw: unknown) { return read('navigate', raw); }, async exportNode(raw: unknown) { return read('exportNode', raw); }, async close() {
    failPending();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };

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
    const timestamp = Date.now().toString(16).padStart(12, '0');
    const random = randomUUID();
    const operationId = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(15, 18)}-${random.slice(19)}`;
    let resolve!: (value: unknown) => void, reject!: (code: string) => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = code => no(new Error(code)); });
    const kinds = { getTree: 'tree', findNodes: 'search', getNodes: 'nodes', getLocalResources: 'resources', navigate: 'navigate', exportNode: 'export' } as const;
    const transfer = command === 'exportNode' ? new ExportTransfer({ ...input.scope, operationId }, input as { nodeId: string; format: 'PNG' | 'SVG' }, binding.limits) : undefined;
    pending = { kind: kinds[command], id: operationId, promise, resolve, reject, transfer, timer: setTimeout(timeout, binding.limits.operationTimeout) };
    const { scope, ...params } = input;
    active.send(JSON.stringify({ type: 'command', ...scope, operationId, command, params }));
    return promise;
  }
}
