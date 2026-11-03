import { createBridgeController } from './bridge-controller';

const secret = document.getElementById('secret') as HTMLInputElement;
const connect = document.getElementById('connect') as HTMLButtonElement;
const disconnect = document.getElementById('disconnect') as HTMLButtonElement;
const write = document.getElementById('write') as HTMLInputElement;
const stop = document.getElementById('stop') as HTMLButtonElement;
const status = document.getElementById('status')!;
const controller = createBridgeController({
  sendMain: message => parent.postMessage({ pluginMessage: message }, '*'),
  setStatus: message => { status.textContent = message; },
  setConnected: connected => { connect.disabled = connected; disconnect.disabled = !connected; write.disabled = !connected; stop.disabled = !connected; },
  setDocument: name => { document.getElementById('document')!.textContent = name ? 'Документ: ' + name : ''; },
  setOperation: operation => { document.getElementById('operation')!.textContent = 'Текущая операция: ' + (operation || 'нет') + '.'; },
  setWriteState: (enabled, reason) => { write.checked = enabled; document.getElementById('write-status')!.textContent = enabled ? 'Запись включена.' : reason === 'CAPABILITY_UNAVAILABLE' ? 'Запись выключена: требуется проверка границы документа в Desktop.' : 'Запись выключена.'; },
  allowedCommands: ['getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate', 'exportNode', 'applyBatch', 'getOperation', 'cancel'],
  writeEnabled: false,
});
connect.onclick = () => { const token = secret.value; secret.value = ''; controller.connect(token); };
write.onchange = () => controller.setWriteEnabled(write.checked);
stop.onclick = () => controller.stop();
disconnect.onclick = () => controller.disconnect();
onmessage = event => controller.handleMain(event.data?.pluginMessage);
