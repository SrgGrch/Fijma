import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';

const version = 1;
const nonce = () => randomBytes(32).toString('hex');
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const actionSchema = z.enum(['connect', 'stop']);
const helloSchema = z.strictObject({ version: z.literal(version), nonce: hex, action: actionSchema });
const challengeSchema = z.strictObject({ version: z.literal(version), nonce: hex, proof: hex });
const proofSchema = z.strictObject({ proof: hex });
const readySchema = z.strictObject({ ready: z.literal(true), pid: z.number().int().positive() });

export function ipcPath(directory: string, port: number) {
  const identity = `${process.platform === 'win32' ? directory.toLowerCase() : directory}:${port}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\figma-mcp-${createHash('sha256').update(identity).digest('hex')}`;
  const path = join(directory, `bridge-${port}.sock`);
  if (Buffer.byteLength(path) > 100) throw new Error('IPC_PATH_TOO_LONG');
  return path;
}

// Pause between frames so authentication never consumes the first MCP message.
export function readFrame(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer); socket.pause();
      socket.off('data', data); socket.off('error', fail); socket.off('end', closed); socket.off('close', closed);
      if (error) reject(error); else resolve(value);
    };
    const fail = () => finish(new Error('IPC_CONNECTION_CLOSED'));
    const closed = () => fail();
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end > 1024 || end < 0 && buffer.length > 1024) { finish(new Error('IPC_FRAME_TOO_LARGE')); return; }
      if (end < 0) return;
      try {
        const value = JSON.parse(buffer.subarray(0, end).toString('utf8'));
        socket.pause();
        if (buffer.length > end + 1) socket.unshift(buffer.subarray(end + 1));
        finish(undefined, value);
      } catch { finish(new Error('IPC_AUTH_FAILED')); }
    };
    const timer = setTimeout(() => finish(new Error('IPC_AUTH_TIMEOUT')), 2000);
    socket.on('data', data); socket.once('error', fail); socket.once('end', closed); socket.once('close', closed);
    if (socket.destroyed || socket.readableEnded) { fail(); return; }
    socket.resume();
  });
}

function proof(secret: string, role: string, client: string, server: string, action: string) {
  return createHmac('sha256', secret).update(JSON.stringify(['figma-mcp-ipc', version, role, client, server, action])).digest('hex');
}
function matches(expected: string, actual: string) {
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}
function send(socket: Socket, value: unknown) { socket.write(JSON.stringify(value) + '\n'); }

export async function acceptIPC(socket: Socket, secret: string) {
  const raw = await readFrame(socket);
  if (raw && typeof raw === 'object' && 'version' in raw && raw.version !== version) {
    send(socket, { version }); throw new Error('IPC_VERSION_MISMATCH');
  }
  const hello = helloSchema.parse(raw), server = nonce();
  send(socket, { version, nonce: server, proof: proof(secret, 'server', hello.nonce, server, hello.action) });
  const response = proofSchema.parse(await readFrame(socket));
  if (!matches(proof(secret, 'client', hello.nonce, server, hello.action), response.proof)) throw new Error('IPC_AUTH_FAILED');
  send(socket, { ready: true, pid: process.pid });
  return hello.action;
}

export async function connectIPC(path: string, secret: string, action: 'connect' | 'stop' = 'connect') {
  const socket = createConnection(path);
  socket.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error('IPC_CONNECT_TIMEOUT')), 2000);
      const done = (error?: Error) => {
        clearTimeout(timer); socket.off('connect', connected); socket.off('error', failed);
        if (error) reject(error); else resolve();
      };
      const connected = () => done();
      const failed = (error: Error) => done(error);
      socket.once('connect', connected); socket.once('error', failed);
    });
    const client = nonce();
    send(socket, { version, nonce: client, action });
    const raw = await readFrame(socket);
    if (raw && typeof raw === 'object' && 'version' in raw && raw.version !== version) throw new Error('IPC_VERSION_MISMATCH');
    const challenge = challengeSchema.parse(raw);
    if (!matches(proof(secret, 'server', client, challenge.nonce, action), challenge.proof)) throw new Error('IPC_AUTH_FAILED');
    send(socket, { proof: proof(secret, 'client', client, challenge.nonce, action) });
    const ready = readySchema.parse(await readFrame(socket));
    return { socket, pid: ready.pid };
  } catch (error) {
    socket.destroy();
    if (error instanceof z.ZodError) throw new Error('IPC_AUTH_FAILED');
    throw error;
  }
}
