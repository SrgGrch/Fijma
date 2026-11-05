import { randomBytes } from 'node:crypto';

type MimeType = 'image/png' | 'image/svg+xml' | 'application/json';
type Limits = { ttl: number; maxEntries: number; maxBytes: number; maxResourceBytes: number };
type Entry = { bytes: Buffer; mimeType: MimeType; expiresAt: number; timer: ReturnType<typeof setTimeout> };
const prefix = 'figma-resource://export/';
const uriPattern = /^figma-resource:\/\/(?:export|execution)\/[A-Za-z0-9_-]{43}$/;
const maxDate = 8_640_000_000_000_000;

export class ExportResourceStore {
  private sessionId: string | undefined;
  private entries = new Map<string, Entry>();
  private totalBytes = 0;
  private limits: Limits;

  constructor(limits: Limits, private now: () => number = Date.now) {
    if (!limits || typeof now !== 'function') throw new Error('INVALID_ARGUMENT');
    for (const key of ['ttl', 'maxEntries', 'maxBytes', 'maxResourceBytes'] as const) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new Error('INVALID_ARGUMENT');
    }
    if (limits.ttl > 2_147_483_647 || limits.maxResourceBytes > limits.maxBytes) throw new Error('INVALID_ARGUMENT');
    this.limits = { ...limits };
  }

  beginSession(sessionId: string) {
    if (typeof sessionId !== 'string' || !sessionId.length) throw new Error('INVALID_ARGUMENT');
    if (sessionId !== this.sessionId) { this.clear(); this.sessionId = sessionId; }
  }

  endSession(sessionId: string) {
    if (sessionId === this.sessionId) { this.clear(); this.sessionId = undefined; }
  }

  close() { this.clear(); this.sessionId = undefined; }

  put(sessionId: string, data: Uint8Array, mimeType: 'image/png' | 'image/svg+xml') {
    if (mimeType !== 'image/png' && mimeType !== 'image/svg+xml') throw new Error('INVALID_ARGUMENT');
    return this.store(sessionId, data, mimeType, prefix);
  }

  putExecution(sessionId: string, data: Uint8Array) {
    if (data.byteLength > 262144) throw new Error('RESOURCE_LIMIT');
    return this.store(sessionId, data, 'application/json', 'figma-resource://execution/');
  }

  private store(sessionId: string, data: Uint8Array, mimeType: MimeType, resourcePrefix: string) {
    if (!this.sessionId || sessionId !== this.sessionId) throw new Error('SESSION_EXPIRED');
    if (!(data instanceof Uint8Array) || data.byteLength < 1 || (mimeType !== 'image/png' && mimeType !== 'image/svg+xml' && mimeType !== 'application/json')) throw new Error('INVALID_ARGUMENT');
    const now = this.time();
    this.sweep(now);
    if (data.byteLength > this.limits.maxResourceBytes || this.entries.size >= this.limits.maxEntries ||
      data.byteLength > this.limits.maxBytes - this.totalBytes) throw new Error('RESOURCE_LIMIT');
    if (now + this.limits.ttl > maxDate) throw new Error('INVALID_ARGUMENT');
    let uri: string;
    do { uri = resourcePrefix + randomBytes(32).toString('base64url'); } while (this.entries.has(uri));
    const bytes = Buffer.from(data), expiresAt = now + this.limits.ttl;
    const timer = setTimeout(() => this.remove(uri), this.limits.ttl);
    timer.unref();
    this.entries.set(uri, { bytes, mimeType, expiresAt, timer });
    this.totalBytes += bytes.byteLength;
    return { uri, mimeType, bytes: bytes.byteLength, expiresAt: new Date(expiresAt).toISOString() };
  }

  read(sessionId: string, uri: string) {
    if (!this.sessionId || sessionId !== this.sessionId || typeof uri !== 'string' || !uriPattern.test(uri)) throw new Error('RESOURCE_EXPIRED');
    const now = this.time();
    this.sweep(now);
    const entry = this.entries.get(uri);
    if (!entry) throw new Error('RESOURCE_EXPIRED');
    return { uri, mimeType: entry.mimeType, data: Buffer.from(entry.bytes) };
  }

  private time() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > maxDate) throw new Error('INVALID_ARGUMENT');
    return value;
  }

  private sweep(now: number) { for (const [uri, entry] of this.entries) if (entry.expiresAt <= now) this.remove(uri); }
  private remove(uri: string) {
    const entry = this.entries.get(uri);
    if (!entry) return;
    clearTimeout(entry.timer); this.entries.delete(uri); this.totalBytes -= entry.bytes.byteLength;
  }
  private clear() { for (const uri of this.entries.keys()) this.remove(uri); }
}
