import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connectIPC } from './ipc';

const absent = (error: unknown) => ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '');

export async function runAdapter(path: string, secret: string, stop = false) {
  let connection: Awaited<ReturnType<typeof connectIPC>> | undefined;
  try { connection = await connectIPC(path, secret, stop ? 'stop' : 'connect'); }
  catch (error) { if (!absent(error)) throw error; }
  if (!connection && stop) { process.stderr.write('Общий мост уже остановлен.\n'); return; }
  if (!connection) {
    let spawnError = false;
    const child = spawn(process.execPath, [process.argv[1], '--bridge'], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => { spawnError = true; }); child.unref();
    const deadline = Date.now() + 8000;
    while (!connection && Date.now() < deadline) {
      if (spawnError) throw new Error('BRIDGE_SPAWN_FAILED');
      await delay(100);
      try { connection = await connectIPC(path, secret); }
      catch (error) { if (!absent(error)) throw error; }
    }
    if (!connection) throw new Error('BRIDGE_START_FAILED');
  }
  const { socket, pid } = connection;
  if (stop) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('BRIDGE_STOP_TIMEOUT')); }, 5000);
      socket.once('end', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('IPC_CONNECTION_CLOSED')); });
      socket.resume();
    });
    socket.destroy();
    process.stderr.write('Общий мост остановлен.\n'); return;
  }
  process.stderr.write(`Общий мост: PID ${pid}\n`);
  let inputClosed = false;
  const close = () => { inputClosed = true; socket.destroy(); process.stdin.destroy(); };
  process.stdin.once('end', close); process.stdin.once('close', close); process.stdin.once('error', close);
  process.stdout.once('error', close);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, close);
  socket.once('close', () => {
    if (!inputClosed) {
      process.stderr.write('Связь с общим мостом потеряна. Перезапустите MCP-подключение; запросы автоматически не повторяются.\n');
      process.exitCode = 1;
    }
    process.stdin.unpipe(socket); socket.unpipe(process.stdout); process.stdin.destroy();
  });
  process.stdin.pipe(socket); socket.pipe(process.stdout);
}
