import { timingSafeEqual, randomInt, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { negotiateHello } from '../shared/protocol';
import { contextReplySchema, disconnectedContext, contextSchema } from '../shared/context';
import { treeReplySchema, searchReplySchema } from '../shared/tree-result';
import { toolInputs } from '../shared/contracts';

const pairSchema = z.strictObject({ type: z.literal('pair'), secret: z.string().length(64).regex(/^[0-9a-f]+$/) });

export async function createPairingListener(secret: string, port: number) {
  const expected = Buffer.from(secret);
  if (expected.length !== 64) throw new Error('INVALID_ARGUMENT');
  const unauthenticated = new Set<WebSocket>();
  let active: WebSocket | undefined;
  let generation = randomInt(1, 2 ** 48);
  let binding: ReturnType<typeof negotiateHello> | undefined;
  let pending: { kind: 'context' | 'tree' | 'search'; id: string; promise: Promise<unknown>; resolve: (value: unknown) => void; reject: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const failPending = () => {
    if (!pending) return;
    const current = pending; pending = undefined; clearTimeout(current.timer); current.reject();
  };
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
    const release = () => { clearTimeout(timer); unauthenticated.delete(socket); if (active === socket) { active = undefined; binding = undefined; failPending(); } };
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
          const welcome = negotiateHello(JSON.parse(data.toString()), currentGeneration);
          binding = welcome;
          socket.send(JSON.stringify(welcome));
          socket.on('message', (bytes, binary) => {
            try {
              if (binary) throw new Error('PROTOCOL_MISMATCH');
              if (pending?.kind === 'tree' || pending?.kind === 'search') {
                const reply = (pending.kind === 'tree' ? treeReplySchema : searchReplySchema).parse(JSON.parse(bytes.toString()));
                if (!binding || reply.operationId !== pending.id || reply.sessionId !== binding.sessionId || reply.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
                const current = pending; pending = undefined; clearTimeout(current.timer);
                current.resolve(reply.error ? { error: reply.error } : reply.data);
                return;
              }
              const reply = contextReplySchema.parse(JSON.parse(bytes.toString()));
              if (!binding || !pending || reply.requestId !== pending.id || reply.sessionId !== binding.sessionId || reply.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
              const current = pending; pending = undefined; clearTimeout(current.timer);
              current.resolve(contextSchema.parse({ ...reply.document, state: 'ready', sessionId: binding.sessionId,
                connectionGeneration: binding.connectionGeneration, writeEnabled: false, capabilities: binding.capabilities.filter(item => ['getContext', 'getTree', 'findNodes'].includes(item)), limits: binding.limits }));
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
    if (pending) {
      if (pending.kind !== 'context') throw new Error('RESOURCE_LIMIT');
      return pending.promise;
    }
    let resolve!: (value: unknown) => void, reject!: () => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = () => no(new Error('NOT_CONNECTED')); });
    pending = { kind: 'context', id: randomUUID(), promise, resolve, reject, timer: setTimeout(failPending, 5000) };
    active.send(JSON.stringify({ type: 'getContext', requestId: pending.id, sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration }));
    return promise;
  }, async getTree(raw: unknown) { return read('getTree', raw); }, async findNodes(raw: unknown) { return read('findNodes', raw); }, async close() {
    failPending();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };

  async function read(command: 'getTree' | 'findNodes', raw: unknown) {
    if (!active || !binding) throw new Error('NOT_CONNECTED');
    const input = command === 'getTree' ? toolInputs.figma_get_tree.parse(raw) : toolInputs.figma_find_nodes.parse(raw);
    if (input.scope.sessionId !== binding.sessionId || input.scope.connectionGeneration !== binding.connectionGeneration) throw new Error('SESSION_EXPIRED');
    if (!binding.capabilities.includes(command)) throw new Error('CAPABILITY_UNAVAILABLE');
    if (('depth' in input && input.depth > binding.limits.maxDepth) || input.limit > binding.limits.maxNodes) throw new Error('RESOURCE_LIMIT');
    if (pending) throw new Error('RESOURCE_LIMIT');
    const timestamp = Date.now().toString(16).padStart(12, '0');
    const random = randomUUID();
    const operationId = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(15, 18)}-${random.slice(19)}`;
    let resolve!: (value: unknown) => void, reject!: () => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = () => no(new Error('NOT_CONNECTED')); });
    pending = { kind: command === 'getTree' ? 'tree' : 'search', id: operationId, promise, resolve, reject, timer: setTimeout(failPending, 5000) };
    const { scope, ...params } = input;
    active.send(JSON.stringify({ type: 'command', ...scope, operationId, command, params }));
    return promise;
  }
}
