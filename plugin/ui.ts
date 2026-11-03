import { PROTOCOL_VERSION, validateCommand } from '../shared/protocol';
import { mainMessageSchema, serverMessageSchema } from '../shared/ui-messages';

const secret = document.getElementById('secret') as HTMLInputElement;
const connect = document.getElementById('connect') as HTMLButtonElement;
const disconnect = document.getElementById('disconnect') as HTMLButtonElement;
const status = document.getElementById('status')!;
let socket: WebSocket | undefined;
let phase: 'pairing' | 'hello' | 'welcome' | 'ready' = 'pairing';
let sessionId: string | undefined;
let binding: { sessionId: string; connectionGeneration: number; capabilities: string[] } | undefined;
const sendMain = (message: unknown) => parent.postMessage({ pluginMessage: message }, '*');
const reset = () => {
  phase = 'pairing'; sessionId = undefined; binding = undefined;
  sendMain({ type: 'disconnected' });
  connect.disabled = false; disconnect.disabled = true;
  document.getElementById('document')!.textContent = '';
};
const sameScope = (message: { sessionId: string; connectionGeneration: number }) =>
  !!binding && message.sessionId === binding.sessionId && message.connectionGeneration === binding.connectionGeneration;
const fail = (current: WebSocket) => {
  if (socket !== current) return;
  socket = undefined; reset();
  status.textContent = 'PROTOCOL_MISMATCH'; current.close();
};

connect.onclick = () => {
  if (socket) return;
  let token = secret.value.trim(); secret.value = '';
  if (!/^[0-9a-f]{64}$/.test(token)) { status.textContent = 'Нужен секрет из файла сопряжения.'; return; }
  const current = new WebSocket('ws://localhost:55263'); socket = current;
  connect.disabled = true; disconnect.disabled = false; status.textContent = 'Сопряжение…';
  current.onopen = () => {
    if (socket === current) current.send(JSON.stringify({ type: 'pair', secret: token }));
    token = '';
  };
  current.onmessage = event => {
    if (socket !== current) return;
    try {
      if (typeof event.data !== 'string') throw new Error('PROTOCOL_MISMATCH');
      const raw = JSON.parse(event.data);
      const parsed = serverMessageSchema.safeParse(raw);
      if (parsed.success) {
        const message = parsed.data;
        if (message.type === 'paired' && phase === 'pairing') { phase = 'hello'; sendMain({ type: 'hello-request' }); return; }
        if (message.type === 'welcome' && phase === 'welcome' && message.sessionId === sessionId && !message.writeEnabled) {
          binding = message; phase = 'ready'; sendMain(message); return;
        }
        if (message.type === 'getContext' && phase === 'ready' && sameScope(message) && binding?.capabilities.includes('getContext')) { sendMain(message); return; }
        throw new Error('PROTOCOL_MISMATCH');
      }
      if (phase !== 'ready' || !binding) throw new Error('PROTOCOL_MISMATCH');
      const command = validateCommand(raw, { sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration });
      if (!['getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate'].includes(command.command) || !binding.capabilities.includes(command.command)) throw new Error('PROTOCOL_MISMATCH');
      sendMain(command);
    } catch { fail(current); }
  };
  current.onerror = () => { if (socket === current) status.textContent = 'Ошибка подключения к локальному мосту.'; };
  current.onclose = event => {
    token = '';
    if (socket !== current) return;
    socket = undefined; reset();
    status.textContent = 'Отключено' + (event.reason ? ': ' + event.reason : '.');
  };
};
disconnect.onclick = () => {
  const current = socket; socket = undefined;
  if (current) current.close();
  reset(); status.textContent = 'Отключено пользователем.';
};
onmessage = event => {
  const parsed = mainMessageSchema.safeParse(event.data?.pluginMessage);
  if (parsed.success && parsed.data.type === 'yield') { sendMain(parsed.data); return; }
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!parsed.success) { fail(socket); return; }
  const message = parsed.data;
  if (message.type === 'hello' && phase === 'hello' && message.protocolVersion === PROTOCOL_VERSION && !message.writeEnabled) {
    sessionId = message.sessionId; phase = 'welcome'; socket.send(JSON.stringify(message)); return;
  }
  if (message.type === 'error') { status.textContent = message.code; socket.close(); return; }
  if (message.type === 'bound' && phase === 'ready' && sameScope(message)) {
    status.textContent = message.message;
    document.getElementById('document')!.textContent = 'Документ: ' + message.documentLabel;
    return;
  }
  if (phase === 'ready' && 'sessionId' in message && 'connectionGeneration' in message && sameScope(message)) {
    socket.send(JSON.stringify(message)); return;
  }
  fail(socket);
};
