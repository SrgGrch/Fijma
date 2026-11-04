import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { createPairingFile } from './pairing-file';
import { createBridge } from './runtime';
import { ipcPath } from './ipc';
import { runBridge } from './daemon';
import { runAdapter } from './adapter';

try {
  const args = process.argv.slice(2), rawPort = process.env.FIGMA_MCP_PORT ?? '55263';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('INVALID_PORT');
  const port = Number(rawPort);
  if (args.length > 1 || args.length === 1 && !['--bridge', '--stop-bridge'].includes(args[0]) || port === 0 && args.length) throw new Error('INVALID_ARGUMENT');
  const directory = process.env.FIGMA_MCP_PAIRING_DIR ?? join(homedir(), '.figma-mcp-bridge');
  const pairing = await createPairingFile(directory);
  if (port === 0) {
    const bridge = await createBridge(pairing, port);
    process.stderr.write(`Файл сопряжения: ${pairing.path}\nЛокальный мост: ws://127.0.0.1:${bridge.listener.address.port}\n`);
    const server = bridge.createClientServer();
    server.server.onclose = () => { void bridge.close(); };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void bridge.close().then(() => process.exit(0)); });
    try { await server.connect(new StdioServerTransport()); }
    catch { await bridge.close(); throw new Error('MCP_CONNECT_FAILED'); }
  } else {
    const path = ipcPath(await realpath(directory), port);
    if (args[0] === '--bridge') await runBridge(pairing, port, path);
    else {
      if (args[0] !== '--stop-bridge') process.stderr.write(`Файл сопряжения: ${pairing.path}\nЛокальный мост: ws://127.0.0.1:${port}\n`);
      await runAdapter(path, pairing.secret, args[0] === '--stop-bridge');
    }
  }
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    INVALID_PORT: 'Недопустимый FIGMA_MCP_PORT: требуется целое число от 0 до 65535.',
    INVALID_ARGUMENT: 'Допустимы --bridge или --stop-bridge; FIGMA_MCP_PORT=0 используется без аргументов.',
    PAIRING_FILE_UNAVAILABLE: 'Файл сопряжения недоступен. Проверьте права и содержимое файла; ключ автоматически не заменяется.',
    IPC_PATH_TOO_LONG: 'Слишком длинный путь IPC. Укажите более короткий FIGMA_MCP_PAIRING_DIR.',
    IPC_VERSION_MISMATCH: 'Версия общего моста несовместима. Остановите прежнюю версию моста перед запуском новой.',
    IPC_AUTH_FAILED: 'Общий мост не прошёл аутентификацию. Проверьте каталог сопряжения и перезапустите мост.',
    BRIDGE_SPAWN_FAILED: 'Не удалось создать процесс общего моста. Проверьте доступ к Node.js.',
    BRIDGE_START_FAILED: 'Общий мост не запустился за 8 секунд. Проверьте порт и права: если порт занят старым сервером, остановите его MCP-клиент и повторите запуск.',
  };
  process.stderr.write((messages[code] ?? 'Не удалось подключить локальный мост. Проверьте порт, права и состояние общего процесса.') + '\n');
  process.exitCode = 1;
}
