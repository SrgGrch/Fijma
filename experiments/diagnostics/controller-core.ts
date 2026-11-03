import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { createPairingListener } from '../../server/pairing-listener';
import { markerStep, MARKER_NAME } from './marker';
import { diagnosticEventSchema } from '../../shared/ui-messages';

const id = () => {
  const time = Date.now().toString(16).padStart(12, '0'), random = randomUUID();
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15, 18)}-${random.slice(19)}`;
};
export async function createDiagnosticController(secret: string, port: number) {
  let listener: Awaited<ReturnType<typeof createPairingListener>>;
  let original: { type: 'command'; sessionId: string; connectionGeneration: number; operationId: string; command: 'applyBatch'; params: { steps: ReturnType<typeof markerStep>[] } } | undefined;
  let busy = false, waiting: WebSocket | undefined;
  const send = (socket: WebSocket, message: unknown) => socket.send(JSON.stringify(diagnosticEventSchema.parse(message)));
  const hook = {
    onControl(socket: WebSocket, control: { action: 'positive' | 'replay' | 'snapshot' }, binding: { sessionId: string; connectionGeneration: number; limits: { maxNodes: number } }) {
      if (busy || waiting) { send(socket, { type: 'diagEvent', event: 'error', code: 'RESOURCE_LIMIT' }); return; }
      busy = true;
      void (async () => {
        const scope = { sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration };
        if (control.action === 'replay') {
          if (!original || (original.sessionId === scope.sessionId && original.connectionGeneration === scope.connectionGeneration)) throw new Error('INVALID_ARGUMENT');
          send(socket, { type: 'diagEvent', event: 'replay-sent', original: { sessionId: original.sessionId, connectionGeneration: original.connectionGeneration }, current: scope });
          socket.send(JSON.stringify(original));
          return;
        }
        const context = await listener.getContext() as { state: string; currentPageId: string | null; documentLabel: string; sessionId: string; connectionGeneration: number };
        if (context.state !== 'ready' || !context.currentPageId || context.sessionId !== scope.sessionId || context.connectionGeneration !== scope.connectionGeneration) throw new Error('SESSION_EXPIRED');
        if (control.action === 'positive') {
          if (original) throw new Error('RESOURCE_LIMIT');
          original = { type: 'command', ...scope, operationId: id(), command: 'applyBatch', params: { steps: [markerStep(context.currentPageId)] } };
          waiting = socket;
          socket.once('close', () => { if (waiting === socket) waiting = undefined; });
          socket.send(JSON.stringify(original));
          return;
        }
        let cursor: string | undefined;
        const markerIds: string[] = [];
        do {
          const tree = await listener.getTree({ scope, rootId: context.currentPageId, depth: 1, limit: Math.min(binding.limits.maxNodes, 100), ...(cursor ? { cursor } : {}) }) as any;
          if (tree.error) throw new Error(tree.error.code);
          for (const row of tree.nodes) if (row.depth === 1 && row.type === 'RECTANGLE' && row.name === MARKER_NAME) markerIds.push(row.nodeId);
          if (markerIds.length > 100) throw new Error('RESOURCE_LIMIT');
          cursor = tree.nextCursor;
        } while (cursor);
        send(socket, { type: 'diagEvent', event: 'snapshot', ...scope, documentLabel: context.documentLabel, pageId: context.currentPageId, markerIds });
      })().catch(() => {
        if (socket.readyState === socket.OPEN) send(socket, { type: 'diagEvent', event: 'error', code: 'FIGMA_API_ERROR' });
      }).finally(() => { busy = false; });
    },
    onResult(socket: WebSocket, reply: any) {
      if (!original || waiting !== socket || reply.operationId !== original.operationId || reply.sessionId !== original.sessionId || reply.connectionGeneration !== original.connectionGeneration) throw new Error('PROTOCOL_MISMATCH');
      waiting = undefined;
      send(socket, { type: 'diagEvent', event: 'positive', result: reply.data });
    },
  };
  listener = await createPairingListener(secret, port, hook);
  return listener;
}
