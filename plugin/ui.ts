import { createBridgeController } from './bridge-controller';
import { pairingReplySchema, pairingSecret } from '../shared/pairing';

const element = (id: string) => document.getElementById(id)!;
const secret = element('secret') as HTMLInputElement;
const connect = element('connect') as HTMLButtonElement;
const disconnect = element('disconnect') as HTMLButtonElement;
const execute = element('execute') as HTMLInputElement;
const write = element('write') as HTMLInputElement;
const stop = element('stop') as HTMLButtonElement;
const forget = element('forget') as HTMLButtonElement;
const resume = element('resume') as HTMLButtonElement;
const sendMain = (message: unknown) => parent.postMessage({ pluginMessage: message }, '*');
let credential = '';
let saved = false;
let automatic = true;
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let storagePending = false;
let ready = false;
let savingCredential = '';

const descriptions: Record<string, string> = {
  AUTH_FAILED: 'Ключ больше не подходит. Введите ключ из файла сопряжения.',
  SESSION_BUSY: 'Мост уже занят другим плагином. Отключите его и попробуйте снова.',
  PROTOCOL_MISMATCH: 'Версии плагина и сервера не совпадают. Пересоберите и перезапустите их.',
  DOCUMENT_MISMATCH: 'Документ изменился. Откройте плагин в нужном файле заново.',
  SESSION_EXPIRED: 'Сессия истекла. Подключитесь заново и перечитайте контекст.',
};
function showError(message: string) {
  element('last-error').textContent = descriptions[message] ?? message;
  element('error-panel').hidden = !message;
}
function state(kind: string, title: string, help: string) {
  element('connection').dataset.state = kind;
  element('status').textContent = title;
  element('connection-help').textContent = help;
}
function pairingView() {
  element('pairing-panel').hidden = !!credential;
  element('remembered').hidden = !credential;
  element('storage-status').textContent = saved ? 'Сопряжение сохранено' : storagePending ? 'Сохраняем сопряжение…' : 'Сопряжение не сохранено';
  forget.disabled = storagePending;
}
function cancelRetry() { if (retry !== undefined) clearTimeout(retry); retry = undefined; }
function savePairing() {
  storagePending = true; savingCredential = credential;
  sendMain({ type: 'pairing-save', secret: credential });
}
function start() {
  cancelRetry();
  if (!automatic || !credential) return;
  controller.connect(credential);
}
function reconnect() {
  if (!automatic || !credential) return;
  state('waiting', 'Ждём локальный мост', 'Подключимся автоматически, когда сервер запустится.');
  retry = setTimeout(start, Math.min(1000 * 2 ** Math.min(attempt++, 4), 15000));
}
const controller = createBridgeController({
  sendMain,
  setStatus: message => {
    const titles: Record<string, string> = { AUTH_FAILED: 'Нужен новый ключ', SESSION_BUSY: 'Мост занят', PROTOCOL_MISMATCH: 'Не удалось подключиться', DOCUMENT_MISMATCH: 'Документ изменился', SESSION_EXPIRED: 'Сессия истекла' };
    if (descriptions[message]) state('error', titles[message], descriptions[message]);
    else if (message === 'Отключено пользователем.') state('offline', 'Подключение приостановлено', 'Нажмите «Подключиться», чтобы продолжить.');
  },
  setError: showError,
  setConnected: connected => {
    ready = false;
    connect.disabled = connected;
    disconnect.disabled = !connected;
    disconnect.hidden = !connected;
    resume.hidden = connected || !credential;
    write.disabled = true; execute.disabled = true; stop.disabled = true;
    element('workspace').hidden = true;
    if (connected) state('connecting', 'Подключаемся…', 'Проверяем ключ и связываемся с документом.');
  },
  setDocument: name => { element('document').textContent = name || 'Документ не выбран'; },
  setOperation: operation => {
    element('operation').textContent = operation || 'Ожидаем команды';
    element('activity').dataset.active = String(!!operation);
  },
  setWriteState: (enabled, reason) => {
    write.checked = enabled;
    element('write-status').textContent = enabled ? 'Запись включена' : reason === 'CAPABILITY_UNAVAILABLE' ? 'Запись недоступна' : 'Строгая запись выключена';
    element('write-help').textContent = enabled ? 'Агент может изменять весь этот документ.' : 'Пакетные изменения выключены. Доверенный код имеет отдельное разрешение.';
  },
  setExecuteState: (enabled, reason) => {
    execute.checked = enabled;
    element('execute-status').textContent = enabled ? 'Доверенный код разрешён' : reason === 'CAPABILITY_UNAVAILABLE' ? 'Выполнение недоступно' : 'Доверенный код выключен';
  },
  allowedCommands: ['getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate', 'exportNode', 'applyBatch', 'getOperation', 'cancel', 'execute'],
  writeEnabled: false,
  onReady: () => {
    ready = true; attempt = 0;
    state('ready', 'Мост подключён', 'Агент работает с этим файлом, даже когда окно скрыто.');
    showError('');
    write.disabled = false; execute.disabled = false; stop.disabled = false;
    element('workspace').hidden = false;
    if (!saved) savePairing();
    pairingView();
  },
  onDisconnect: reason => {
    if (reason === 'AUTH_FAILED') {
      automatic = false; credential = ''; savingCredential = ''; saved = false;
      storagePending = true; sendMain({ type: 'pairing-forget' });
      pairingView();
    } else if (reason === 'Disconnected.') reconnect();
    else {
      automatic = false; resume.hidden = !credential;
      if (!descriptions[reason]) state('error', 'Соединение остановлено', 'Проверьте сообщение ниже и подключитесь снова.');
    }
  },
});
connect.onclick = () => {
  const token = secret.value.trim(); secret.value = '';
  if (!pairingSecret.safeParse(token).success) { showError('Введите ключ из 64 символов из локального файла сопряжения.'); secret.focus(); return; }
  credential = token; saved = false; automatic = true; attempt = 0;
  showError(''); pairingView(); start();
};
secret.onkeydown = event => { if (event.key === 'Enter' && !connect.disabled) { event.preventDefault(); connect.click(); } };
resume.onclick = () => { automatic = true; attempt = 0; showError(''); start(); };
disconnect.onclick = () => { automatic = false; cancelRetry(); controller.disconnect(); };
forget.onclick = () => {
  automatic = false; cancelRetry(); credential = ''; savingCredential = ''; saved = false;
  controller.disconnect(); storagePending = true; pairingView();
  sendMain({ type: 'pairing-forget' });
  state('offline', 'Сопряжение удаляется', 'Подождите, пока сохранённый ключ будет удалён.');
};
window.addEventListener('pagehide', () => { automatic = false; cancelRetry(); controller.disconnect(); });
execute.onchange = () => { if (ready) controller.setExecuteEnabled(execute.checked); };
write.onchange = () => { if (ready) controller.setWriteEnabled(write.checked); };
stop.onclick = () => { if (ready) controller.stop(); };
onmessage = event => {
  // Figma Desktop can deliver main messages from the top-level host rather than the direct parent.
  if (event.source && event.source !== parent && event.source !== window.top) return;
  const raw = event.data?.pluginMessage;
  if (typeof raw?.type === 'string' && raw.type.startsWith('pairing-')) {
    const parsed = pairingReplySchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'pairing-loaded') {
      // A late initial read must not overwrite a key the user already entered.
      if (credential || !automatic || !message.secret) return;
      credential = message.secret; saved = true; pairingView(); start();
    } else if (message.type === 'pairing-saved') {
      storagePending = false; saved = !!credential && credential === savingCredential;
      savingCredential = '';
      if (ready && !saved) savePairing();
      pairingView();
    } else if (message.type === 'pairing-forgotten') {
      storagePending = false; pairingView();
      if (!credential && !automatic) state('offline', 'Нужно сопряжение', 'Введите ключ один раз. Следующее подключение будет автоматическим.');
    } else {
      storagePending = false;
      showError(message.action === 'forget' ? 'Не удалось удалить сохранённый ключ. Нажмите «Забыть» ещё раз.' : 'Локальное хранилище недоступно. Сопряжение не сохранено; после перезапуска потребуется ключ.');
      pairingView();
      if (message.action === 'forget') {
        element('remembered').hidden = false;
        element('storage-status').textContent = 'Не удалось удалить сопряжение';
      }
    }
    return;
  }
  controller.handleMain(raw);
};
sendMain({ type: 'pairing-load' });
