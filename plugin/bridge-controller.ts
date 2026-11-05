import { PROTOCOL_VERSION, validateCommand, utf8Bytes } from '../shared/protocol';
import { mainMessageSchema, serverMessageSchema } from '../shared/ui-messages';

type Options = {
  sendMain: (message: unknown) => void;
  setStatus: (message: string) => void;
  setError?: (message: string) => void;
  setConnected: (connected: boolean) => void;
  setDocument: (document: string) => void;
  setOperation?: (operation: string) => void;
  setExecuteState?: (enabled: boolean, reason?: string) => void;
  setWriteState?: (enabled: boolean, reason?: string) => void;
  onReady?: () => void;
  onDisconnect?: (reason: string) => void;
  allowedCommands: readonly string[];
  writeEnabled: boolean;
  mainSchema?: { safeParse: (value: unknown) => { success: boolean; data?: any } };
  onReject?: (source: 'ui' | 'main', reason: string) => void;
  extension?: { receive: (message: unknown, scope: { sessionId: string; connectionGeneration: number }) => boolean; parseControl: (message: unknown) => unknown };
};

export function createBridgeController(options: Options) {
  let socket: WebSocket | undefined;
  let phase: 'pairing' | 'hello' | 'welcome' | 'ready' = 'pairing';
  let sessionId: string | undefined;
  let binding: { sessionId: string; connectionGeneration: number; capabilities: string[]; limits: { maxMessageBytes: number } } | undefined;
  const pending = new Map<string, { id: string; command: string }>();
  const showOperation = () => {
    const entries = [...pending.values()];
    const current = entries.find(entry => ['applyBatch', 'execute'].includes(entry.command)) ?? entries[0];
    options.setOperation?.(current ? `${current.command} (${current.id})` : '');
  };
  const reset = () => {
    phase = 'pairing'; sessionId = undefined; binding = undefined;
    pending.clear();
    options.sendMain({ type: 'disconnected' });
    options.setConnected(false); options.setDocument(''); options.setOperation?.(''); options.setWriteState?.(false); options.setExecuteState?.(false);
  };
  const sameScope = (message: { sessionId: string; connectionGeneration: number }) =>
    !!binding && message.sessionId === binding.sessionId && message.connectionGeneration === binding.connectionGeneration;
  const fail = (current: WebSocket, reason = 'PROTOCOL_MISMATCH', source: 'ui' | 'main' = 'ui', rejectCode = reason) => {
    if (socket !== current) return;
    socket = undefined; reset(); options.setStatus(reason); options.setError?.(reason); options.onReject?.(source, rejectCode); current.close(); options.onDisconnect?.(reason);
  };
  return {
    connect(secret: string) {
      if (socket) return;
      let token = secret.trim();
      if (!/^[0-9a-f]{64}$/.test(token)) { options.setStatus('Нужен секрет из файла сопряжения.'); options.setError?.('Нужен секрет из файла сопряжения.'); return; }
      const current = new WebSocket('ws://localhost:55263'); socket = current;
      options.setConnected(true); options.setStatus('Сопряжение…');
      current.onopen = () => {
        if (socket === current) current.send(JSON.stringify({ type: 'pair', secret: token }));
        token = '';
      };
      current.onmessage = event => {
        if (socket !== current) return;
        try {
          if (typeof event.data !== 'string') throw new Error('PROTOCOL_MISMATCH');
          if (phase === 'ready' && binding && utf8Bytes(event.data) > binding.limits.maxMessageBytes) throw new Error('RESOURCE_LIMIT');
          const raw = JSON.parse(event.data);
          if (phase === 'ready' && binding && options.extension?.receive(raw, binding)) return;
          const parsed = serverMessageSchema.safeParse(raw);
          if (parsed.success) {
            const message = parsed.data;
            if (message.type === 'paired' && phase === 'pairing') { phase = 'hello'; options.sendMain({ type: 'hello-request' }); return; }
            if (message.type === 'welcome' && phase === 'welcome' && message.sessionId === sessionId && message.writeEnabled === options.writeEnabled) {
              binding = message; phase = 'ready'; options.sendMain(message); return;
            }
            if (message.type === 'getContext' && phase === 'ready' && sameScope(message) && binding?.capabilities.includes('getContext')) { options.sendMain(message); return; }
            throw new Error('PROTOCOL_MISMATCH');
          }
          if (phase !== 'ready' || !binding) throw new Error('PROTOCOL_MISMATCH');
          const command = validateCommand(raw, { sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration });
          if (!options.allowedCommands.includes(command.command) || !binding.capabilities.includes(command.command)) throw new Error('PROTOCOL_MISMATCH');
          pending.set(command.requestId ?? `${command.command}:${command.operationId}`, { id: command.operationId, command: command.command });
          showOperation(); options.sendMain(command);
        } catch (error) { fail(current, 'PROTOCOL_MISMATCH', 'ui', error instanceof Error && error.message === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : 'PROTOCOL_MISMATCH'); }
      };
      current.onerror = () => { if (socket === current) { options.setStatus('Ошибка подключения к локальному мосту.'); options.setError?.('Ошибка подключения к локальному мосту.'); } };
      current.onclose = event => {
        token = '';
        if (socket !== current) return;
        socket = undefined; reset();
        const reason = ['SESSION_BUSY', 'AUTH_FAILED', 'PROTOCOL_MISMATCH'].includes(event.reason) ? event.reason : 'Disconnected.';
        options.setStatus(reason); if (reason !== 'Disconnected.') options.setError?.(reason);
        options.onDisconnect?.(reason);
      };
    },
    disconnect() {
      const current = socket; socket = undefined;
      if (current) current.close();
      reset(); options.setStatus('Отключено пользователем.');
    },
    setExecuteEnabled(enabled: boolean) { options.sendMain({ type: 'setExecuteEnabled', enabled }); },
    setWriteEnabled(enabled: boolean) { options.sendMain({ type: 'setWriteEnabled', enabled }); },
    stop() { options.sendMain({ type: 'stop' }); },
    sendExtension(raw: unknown) {
      if (!socket || socket.readyState !== WebSocket.OPEN || phase !== 'ready' || !options.extension) throw new Error('NOT_CONNECTED');
      socket.send(JSON.stringify(options.extension.parseControl(raw)));
    },
    handleMain(raw: unknown) {
      const parsed = (options.mainSchema ?? mainMessageSchema).safeParse(raw);
      if (parsed.success && parsed.data.type === 'yield') { options.sendMain(parsed.data); return; }
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (!parsed.success) { fail(socket); return; }
      const message = parsed.data;
      if (message.type === 'hello' && phase === 'hello' && message.protocolVersion === PROTOCOL_VERSION && message.writeEnabled === options.writeEnabled) {
        sessionId = message.sessionId; phase = 'welcome'; socket.send(JSON.stringify(message)); return;
      }
      if (message.type === 'writeState' && phase === 'ready' && binding) { options.setWriteState?.(message.enabled, message.reason); socket.send(JSON.stringify({ ...message, sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration })); return; }
      if (message.type === 'executeState' && phase === 'ready' && binding) { options.setExecuteState?.(message.enabled, message.reason); socket.send(JSON.stringify({ ...message, sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration })); return; }
      if (message.type === 'error') { fail(socket, message.code, 'main'); return; }
      if (message.type === 'bound' && phase === 'ready' && sameScope(message) && message.writeEnabled === options.writeEnabled) {
        options.setStatus(message.message); options.setDocument(message.documentLabel); options.onReady?.(); return;
      }
      if (message.type === 'operationResult' && !(options.allowedCommands.includes('applyBatch') && binding?.capabilities.includes('applyBatch') || options.allowedCommands.includes('execute') && binding?.capabilities.includes('execute'))) {
        fail(socket); return;
      }
      if (['exportStart', 'exportChunk', 'exportError'].includes(message.type) && (!options.allowedCommands.includes('exportNode') || !binding?.capabilities.includes('exportNode'))) {
        fail(socket); return;
      }
      if (['executionStart', 'executionChunk'].includes(message.type) && (!options.allowedCommands.includes('execute') || !binding?.capabilities.includes('execute'))) { fail(socket); return; }
      if (phase === 'ready' && 'sessionId' in message && 'connectionGeneration' in message && sameScope(message)) {
        const result = 'data' in message && typeof message.data === 'object' ? message.data : undefined;
        const error = ('error' in message && message.error) || (result && 'error' in result && result.error) ||
          (result && 'steps' in result && result.steps.find(step => step.error)?.error);
        if (error) (options.setError ?? options.setStatus)(error.code + ': ' + error.message);
        if ('operationId' in message && message.type !== 'ack' && message.type !== 'exportStart' && message.type !== 'executionStart' && message.type !== 'executionChunk' && (message.type !== 'exportChunk' || message.index === message.total - 1)) {
          if (message.type === 'operationResult') {
            const key = message.requestId ?? [...pending].find(([, entry]) => entry.id === message.operationId && ['getOperation', 'cancel'].includes(entry.command))?.[0] ?? `applyBatch:${message.operationId}`;
            const request = pending.get(key);
            const terminal = 'operationId' in message.data && ['succeeded', 'failed', 'partially_applied', 'cancelled'].includes(message.data.status);
            if (terminal) for (const [pendingKey, entry] of pending) if (entry.id === message.operationId && ['applyBatch', 'execute'].includes(entry.command)) pending.delete(pendingKey);
            if (request && (!['applyBatch', 'execute'].includes(request.command) || terminal || !('operationId' in message.data))) pending.delete(key);
          } else {
            const command = ({ treeResult: 'getTree', searchResult: 'findNodes', nodesResult: 'getNodes', resourcesResult: 'getLocalResources', navigateResult: 'navigate', exportError: 'exportNode', exportChunk: 'exportNode' } as Record<string, string>)[message.type];
            pending.delete(`${command}:${message.operationId}`);
          }
          showOperation();
        }
        socket.send(JSON.stringify(message)); return;
      }
      fail(socket);
    },
  };
}
