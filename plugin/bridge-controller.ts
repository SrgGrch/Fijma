import { PROTOCOL_VERSION, validateCommand } from '../shared/protocol';
import { mainMessageSchema, serverMessageSchema } from '../shared/ui-messages';

type Options = {
  sendMain: (message: unknown) => void;
  setStatus: (message: string) => void;
  setConnected: (connected: boolean) => void;
  setDocument: (document: string) => void;
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
  let binding: { sessionId: string; connectionGeneration: number; capabilities: string[] } | undefined;
  const reset = () => {
    phase = 'pairing'; sessionId = undefined; binding = undefined;
    options.sendMain({ type: 'disconnected' });
    options.setConnected(false); options.setDocument('');
  };
  const sameScope = (message: { sessionId: string; connectionGeneration: number }) =>
    !!binding && message.sessionId === binding.sessionId && message.connectionGeneration === binding.connectionGeneration;
  const fail = (current: WebSocket, reason = 'PROTOCOL_MISMATCH', source: 'ui' | 'main' = 'ui', rejectCode = reason) => {
    if (socket !== current) return;
    socket = undefined; reset(); options.setStatus(reason); options.onReject?.(source, rejectCode); current.close();
  };
  return {
    connect(secret: string) {
      if (socket) return;
      let token = secret.trim();
      if (!/^[0-9a-f]{64}$/.test(token)) { options.setStatus('Нужен секрет из файла сопряжения.'); return; }
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
          options.sendMain(command);
        } catch (error) { fail(current, 'PROTOCOL_MISMATCH', 'ui', error instanceof Error && error.message === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : 'PROTOCOL_MISMATCH'); }
      };
      current.onerror = () => { if (socket === current) options.setStatus('Ошибка подключения к локальному мосту.'); };
      current.onclose = event => {
        token = '';
        if (socket !== current) return;
        socket = undefined; reset();
        options.setStatus('Отключено' + (event.reason ? ': ' + event.reason : '.'));
      };
    },
    disconnect() {
      const current = socket; socket = undefined;
      if (current) current.close();
      reset(); options.setStatus('Отключено пользователем.');
    },
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
      if (message.type === 'error') { fail(socket, message.code, 'main'); return; }
      if (message.type === 'bound' && phase === 'ready' && sameScope(message) && message.writeEnabled === options.writeEnabled) {
        options.setStatus(message.message); options.setDocument(message.documentLabel); return;
      }
      if (message.type === 'operationResult' && (!options.writeEnabled || !options.allowedCommands.includes('applyBatch') || !binding?.capabilities.includes('applyBatch'))) {
        fail(socket); return;
      }
      if (['exportStart', 'exportChunk', 'exportError'].includes(message.type) && (!options.allowedCommands.includes('exportNode') || !binding?.capabilities.includes('exportNode'))) {
        fail(socket); return;
      }
      if (phase === 'ready' && 'sessionId' in message && 'connectionGeneration' in message && sameScope(message)) {
        socket.send(JSON.stringify(message)); return;
      }
      fail(socket);
    },
  };
}
