import { createPairingFile } from '../../server/pairing-file';
import { createDiagnosticController } from './controller-core';

const pairing = await createPairingFile();
let controller;
try { controller = await createDiagnosticController(pairing.secret, 55263); }
catch { await pairing.dispose(); process.stderr.write('Диагностический мост не запущен: проверьте порт и права.\n'); process.exit(1); }
process.stderr.write(`Файл сопряжения: ${pairing.path}\nЛокальный мост: ws://127.0.0.1:${controller.address.port}\n`);
let closing = false;
const close = async () => { if (closing) return; closing = true; await controller.close(); await pairing.dispose(); };
process.stdin.once('end', () => { void close(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().then(() => process.exit(0)); });
