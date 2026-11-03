import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './catalog';
import { createPairingFile } from './pairing-file';
import { createPairingListener } from './pairing-listener';

const pairing = await createPairingFile();
let listener;
try {
  const port = Number(process.env.FIGMA_MCP_PORT ?? 55263);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  listener = await createPairingListener(pairing.secret, port);
} catch {
  await pairing.dispose();
  process.stderr.write('Не удалось запустить локальный мост. Проверьте порт и права пользователя.\n');
  process.exit(1);
}
process.stderr.write(`Файл сопряжения: ${pairing.path}\n`);
const server = createServer(() => listener.getContext(), args => listener.getTree(args));
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await listener.close();
  await pairing.dispose();
};
process.stdin.once('end', () => { void close(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void close().then(() => process.exit(0));
});
try { await server.connect(new StdioServerTransport()); }
catch { await close(); process.exit(1); }
