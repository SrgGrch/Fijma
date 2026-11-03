import { createBridgeController } from '../../plugin/bridge-controller';
import { diagnosticControlSchema, diagnosticEventSchema, yieldSchema } from '../../shared/ui-messages';

const input = (id: string) => document.getElementById(id)!;
const run = input('run') as HTMLButtonElement, stop = input('stop') as HTMLButtonElement;
const status = input('status'), output = input('report') as HTMLTextAreaElement;
const bridgeStatus = input('bridge-status'), bridgeOutput = input('bridge-report') as HTMLTextAreaElement;
const secret = input('secret') as HTMLInputElement, connect = input('connect') as HTMLButtonElement, disconnect = input('disconnect') as HTMLButtonElement;
let index = -1, bridgeConnected = false;
const events: unknown[] = [];
const record = (event: unknown) => { events.push(event); bridgeOutput.value = JSON.stringify(events, null, 2); };
const controller = createBridgeController({
  sendMain: message => parent.postMessage({ pluginMessage: message }, '*'),
  setStatus: message => { bridgeStatus.textContent = message; },
  setConnected: connected => { bridgeConnected = connected; connect.disabled = connected || index !== -1; disconnect.disabled = !connected; run.disabled = connected || index !== -1; },
  setDocument: name => { input('bridge-document').textContent = name ? 'Документ: ' + name : ''; },
  allowedCommands: ['getContext', 'getTree', 'applyBatch'], writeEnabled: true,
  onReject: (layer, code) => record({ event: 'rejected', layer, code }),
  extension: {
    parseControl: message => diagnosticControlSchema.parse(message),
    receive(message, scope) {
      const parsed = diagnosticEventSchema.safeParse(message);
      if (!parsed.success) return false;
      if (parsed.data.event === 'snapshot') {
        if (parsed.data.sessionId !== scope.sessionId || parsed.data.connectionGeneration !== scope.connectionGeneration) return false;
        input('bridge-document').textContent = 'Документ: ' + parsed.data.documentLabel;
      }
      if (parsed.data.event === 'replay-sent' && (parsed.data.current.sessionId !== scope.sessionId || parsed.data.current.connectionGeneration !== scope.connectionGeneration)) return false;
      record(parsed.data); return true;
    },
  },
});
connect.onclick = () => { if (index !== -1) return; const token = secret.value; secret.value = ''; controller.connect(token); };
disconnect.onclick = () => controller.disconnect();
for (const action of ['snapshot', 'positive', 'replay'] as const) {
  input(action).onclick = () => {
    try { controller.sendExtension({ type: 'diagControl', action }); }
    catch { bridgeStatus.textContent = 'Сначала подключите диагностический мост.'; }
  };
}

const phases = [
  { name: 'resources', suite: 'resources', type: 'probe' },
  { name: 'limits', suite: 'limits', type: 'measure' },
  { name: 'stop', suite: 'limits', type: 'measure' },
];
let reports: Record<string, any> = {}, stopTimer: ReturnType<typeof setTimeout> | undefined, stopAt: number | undefined, userStopped = false;
const send = (suite: string, type: string) => parent.postMessage({ pluginMessage: { suite, type } }, '*');
const requestStop = () => {
  if (stopAt !== undefined) return;
  stopAt = performance.now(); stop.disabled = true;
  send('limits', 'stop');
};
const next = () => {
  clearTimeout(stopTimer); stopTimer = undefined;
  index++;
  if (userStopped || index === phases.length) {
    index = -1; run.disabled = bridgeConnected; connect.disabled = bridgeConnected; stop.disabled = true;
    status.textContent = userStopped ? 'Остановлено. Отчёт содержит выполненные проверки.' : 'Все проверки завершены.';
    return;
  }
  stopAt = undefined;
  const phase = phases[index];
  stop.disabled = phase.suite !== 'limits';
  status.textContent = phase.name + ': запуск…';
  send(phase.suite, phase.type);
};
run.onclick = () => { if (index !== -1 || bridgeConnected) return; reports = {}; output.value = ''; userStopped = false; run.disabled = true; connect.disabled = true; next(); };
stop.onclick = () => { userStopped = true; requestStop(); };
onmessage = event => {
  const message = event.data?.pluginMessage;
  const yielded = yieldSchema.safeParse(message);
  if (yielded.success) { parent.postMessage({ pluginMessage: yielded.data }, '*'); return; }
  if (message?.type !== 'progress' && message?.type !== 'report') { controller.handleMain(message); return; }
  if (index === -1) return;
  const phase = phases[index];
  if (message.type === 'progress' && typeof message.action === 'string') {
    status.textContent = phase.name + ': ' + message.action;
    if (phase.name === 'stop' && stopTimer === undefined) stopTimer = setTimeout(requestStop, 500);
    return;
  }
  if (message.type !== 'report') return;
  clearTimeout(stopTimer); stopTimer = undefined;
  reports[phase.name] = message.results ?? message.report;
  if (stopAt !== undefined) reports[phase.name].uiStopRoundTripMs = performance.now() - stopAt;
  output.value = JSON.stringify(reports, null, 2);
  setTimeout(next, 0);
};
