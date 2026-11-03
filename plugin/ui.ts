import { createBridgeController } from './bridge-controller';

const secret = document.getElementById('secret') as HTMLInputElement;
const connect = document.getElementById('connect') as HTMLButtonElement;
const disconnect = document.getElementById('disconnect') as HTMLButtonElement;
const status = document.getElementById('status')!;
const controller = createBridgeController({
  sendMain: message => parent.postMessage({ pluginMessage: message }, '*'),
  setStatus: message => { status.textContent = message; },
  setConnected: connected => { connect.disabled = connected; disconnect.disabled = !connected; },
  setDocument: name => { document.getElementById('document')!.textContent = name ? 'Документ: ' + name : ''; },
  allowedCommands: ['getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate'],
  writeEnabled: false,
});
connect.onclick = () => { const token = secret.value; secret.value = ''; controller.connect(token); };
disconnect.onclick = () => controller.disconnect();
onmessage = event => controller.handleMain(event.data?.pluginMessage);
