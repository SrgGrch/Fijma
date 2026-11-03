import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['server/export-resources.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { ExportResourceStore } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const options = { ttl: 1000, maxEntries: 2, maxBytes: 8, maxResourceBytes: 6 };
for (const value of [{}, { ...options, ttl: 0 }, { ...options, maxEntries: 1.5 }, { ...options, maxBytes: 0 },
  { ...options, maxResourceBytes: 9 }, { ...options, ttl: 2_147_483_648 }]) {
  assert.throws(() => new ExportResourceStore(value), /INVALID_ARGUMENT/);
}
let time = 1000;
const store = new ExportResourceStore(options, () => time);
assert.throws(() => store.put('s', Buffer.from('a'), 'image/png'), /SESSION_EXPIRED/);
store.beginSession('session-secret');
const input = Buffer.from([1, 2, 3, 4]);
const image = store.put('session-secret', input, 'image/png');
assert.match(image.uri, /^figma-resource:\/\/export\/[A-Za-z0-9_-]{43}$/);
assert.equal(image.uri.includes('session-secret'), false);
assert.equal(image.bytes, 4);
assert.equal(image.expiresAt, new Date(2000).toISOString());
input[0] = 9;
const read = store.read('session-secret', image.uri);
assert.deepEqual([...read.data], [1, 2, 3, 4]);
read.data[0] = 8;
assert.deepEqual([...store.read('session-secret', image.uri).data], [1, 2, 3, 4]);
assert.throws(() => store.read('wrong-session', image.uri), /^Error: RESOURCE_EXPIRED$/);
for (const uri of ['file:///tmp/secret', 'C:\\secret', image.uri + '?x=1', image.uri + '/../x', 'figma-resource://export/short']) {
  assert.throws(() => store.read('session-secret', uri), /^Error: RESOURCE_EXPIRED$/);
}
assert.throws(() => store.put('session-secret', Buffer.alloc(7), 'image/png'), /^Error: RESOURCE_LIMIT$/);
assert.throws(() => store.put('session-secret', Buffer.alloc(0), 'image/png'), /^Error: INVALID_ARGUMENT$/);
assert.throws(() => store.put('session-secret', Buffer.from('data'), 'text/html'), /^Error: INVALID_ARGUMENT$/);
const svg = store.put('session-secret', Buffer.from('<svg'), 'image/svg+xml');
assert.notEqual(svg.uri, image.uri);
assert.throws(() => store.put('session-secret', Buffer.from('x'), 'image/png'), /^Error: RESOURCE_LIMIT$/);
store.beginSession('session-secret');
assert.equal(store.read('session-secret', svg.uri).mimeType, 'image/svg+xml');
time = 2000;
assert.throws(() => store.read('session-secret', image.uri), /^Error: RESOURCE_EXPIRED$/);
const next = store.put('session-secret', Buffer.alloc(6), 'image/png');
assert.throws(() => store.put('session-secret', Buffer.alloc(3), 'image/png'), /^Error: RESOURCE_LIMIT$/);
store.endSession('wrong-session');
assert.equal(store.read('session-secret', next.uri).data.length, 6);
store.beginSession('new-session');
assert.throws(() => store.read('new-session', next.uri), /^Error: RESOURCE_EXPIRED$/);
assert.throws(() => store.put('session-secret', Buffer.from('x'), 'image/png'), /^Error: SESSION_EXPIRED$/);
const newResource = store.put('new-session', Buffer.from('x'), 'image/png');
store.endSession('new-session');
assert.throws(() => store.read('new-session', newResource.uri), /^Error: RESOURCE_EXPIRED$/);
store.close();
const timed = new ExportResourceStore({ ttl: 20, maxEntries: 1, maxBytes: 1, maxResourceBytes: 1 });
timed.beginSession('timed');
const expired = timed.put('timed', Buffer.from('x'), 'image/png');
await new Promise(resolve => setTimeout(resolve, 40));
assert.throws(() => timed.read('timed', expired.uri), /^Error: RESOURCE_EXPIRED$/);
timed.put('timed', Buffer.from('y'), 'image/png');
timed.close();
console.log('Export resources: session, TTL, opaque URI, bytes/count limits and copying — OK');
