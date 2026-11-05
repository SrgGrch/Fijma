import assert from 'node:assert/strict';
import { build } from 'esbuild';
const load = async file => {
  const built = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
};
// Bundle the compiler with esbuild external via a file import, so production resolution is exercised.
const compiler = await build({ entryPoints: ['server/execution-compiler.ts'], bundle: true, platform: 'node', format: 'esm', write: false, packages: 'external' });
const { writeFile, unlink } = await import('node:fs/promises');
const { pathToFileURL } = await import('node:url');
const { resolve } = await import('node:path');
const path = `./.execution-compiler-test-${process.pid}.mjs`;
await writeFile(path, compiler.outputFiles[0].text);
try {
  const { compileExecution } = await import(pathToFileURL(resolve(path)).href);
  globalThis.__executionCompilerMarker = 0;
  const js = await compileExecution('javascript', 'globalThis.__executionCompilerMarker++; return args.x;');
  assert.equal(globalThis.__executionCompilerMarker, 0);
  assert.match(js, /return args\.x/);
  const ts = await compileExecution('typescript', 'const value: number = args.x; return value;');
  assert.doesNotMatch(ts, /: number/);
  assert.match(await compileExecution('typescript', 'enum E { A }; return E.A;'), /__figma_execute__/);
  await assert.rejects(compileExecution('javascript', 'return await import("node:fs")'), /COMPILATION_FAILED/);
  await assert.rejects(compileExecution('javascript', 'return await import(args.module)'), /COMPILATION_FAILED/);
  await assert.rejects(compileExecution('typescript', '\nconst = ;'), error => error.message === 'COMPILATION_FAILED' && error.line === 2 && Number.isInteger(error.column));
  delete globalThis.__executionCompilerMarker;
} finally { await unlink(path); }
const { ExecutionTransfer } = await load('server/execution-transfer.ts');
const scope = { sessionId: 'session', connectionGeneration: 1, operationId: '019a4a10-0000-7000-8000-000000000001', requestId: '8d995904-2cc5-453f-90ba-5fa38aaa39dd' };
const data = Buffer.from('{"value":"123456"}');
const header = { type: 'executionStart', ...scope, bytes: data.length, chunkBytes: 6, total: Math.ceil(data.length / 6) };
const part = index => ({ type: 'executionChunk', ...scope, total: header.total, index, data: data.subarray(index * 6, (index + 1) * 6).toString('base64') });
const transfer = new ExecutionTransfer(scope); transfer.accept(header);
let received; for (let i = 0; i < header.total; i++) received = transfer.accept(part(i));
assert.deepEqual(received, data);
const outOfOrder = new ExecutionTransfer(scope); outOfOrder.accept(header); assert.throws(() => outOfOrder.accept(part(1)));
const wrongScope = new ExecutionTransfer(scope); assert.throws(() => wrongScope.accept({ ...header, sessionId: 'other' }));
const badBytes = new ExecutionTransfer(scope); badBytes.accept(header); assert.throws(() => badBytes.accept({ ...part(0), data: 'YWJj' }));
const { ExportResourceStore } = await load('server/export-resources.ts');
let now = 0; const store = new ExportResourceStore({ ttl: 100, maxEntries: 2, maxBytes: 100, maxResourceBytes: 100 }, () => now);
store.beginSession('session'); const resource = store.putExecution('session', data);
assert.equal(store.read('session', resource.uri).mimeType, 'application/json');
assert.throws(() => store.put('session', data, 'application/json'), /INVALID_ARGUMENT/);
assert.throws(() => store.read('other', resource.uri), /RESOURCE_EXPIRED/);
now = 100; assert.throws(() => store.read('session', resource.uri), /RESOURCE_EXPIRED/);
store.close();
