import { createServer, type Socket } from 'node:net';
import { lstat, unlink } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { acceptIPC } from './ipc';
import { createBridge } from './runtime';
import type { createPairingFile } from './pairing-file';

export async function runBridge(pairing: Awaited<ReturnType<typeof createPairingFile>>, port: number, path: string) {
  const bridge = await createBridge(pairing, port);
  const sockets = new Set<Socket>();
  let pending = 0;
  let closing: Promise<void> | undefined;
  const ipc = createServer(socket => {
    socket.on('error', () => {});
    if (pending >= 4 || sockets.size >= 64 || closing) { socket.destroy(); return; }
    sockets.add(socket); pending++;
    socket.once('close', () => sockets.delete(socket));
    void (async () => {
      let action;
      try { action = await acceptIPC(socket, pairing.secret); }
      catch { socket.destroy(); return; }
      finally { pending--; }
      if (action === 'stop') { await close(socket); return; }
      if (closing || socket.destroyed) { socket.destroy(); return; }
      const lifetime = new AbortController();
      socket.once('close', () => lifetime.abort());
      socket.once('end', () => lifetime.abort());
      const server = bridge.createClientServer(() => {
        if (closing || socket.destroyed || socket.readableEnded) throw new Error('NOT_CONNECTED');
      }, lifetime.signal);
      server.server.onclose = () => { lifetime.abort(); socket.destroy(); };
      try { await server.connect(new StdioServerTransport(socket, socket)); socket.resume(); }
      catch { await server.close(); socket.destroy(); }
    })().catch(() => { socket.destroy(); });
  });
  function close(stopSocket?: Socket) {
    return closing ??= (async () => {
      const closed = new Promise<void>(resolve => ipc.close(() => resolve()));
      for (const socket of sockets) if (socket !== stopSocket) socket.destroy();
      try { await bridge.close(); }
      finally { stopSocket?.end(); await closed; }
    })();
  }
  try {
    if (process.platform !== 'win32') {
      try {
        const info = await lstat(path);
        if (!info.isSocket()) throw new Error('IPC_PATH_OCCUPIED');
        await unlink(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await new Promise<void>((resolve, reject) => {
      ipc.once('error', reject);
      ipc.listen(path, resolve);
    });
  } catch (error) { await close(); throw error; }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close(); });
}
