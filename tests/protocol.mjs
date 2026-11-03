import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['shared/protocol.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { negotiateHello, validateCommand, validateAck } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const limits = Object.fromEntries(['maxMessageBytes', 'maxBatchSteps', 'maxQueuedOperations', 'maxDepth', 'maxNodes', 'maxResponseBytes', 'maxImportBytes', 'maxExportPixels', 'maxExportBytes', 'operationTimeout', 'dedupTtl', 'maxJournalEntries', 'resourceTtl', 'clockSkew'].map(key => [key, 10]));
const hello = { type: 'hello', protocolVersion: 1, sessionId: 'session', capabilities: [], limits, writeEnabled: false };
assert.equal(negotiateHello(hello, 1).type, 'welcome');
const claimedWrite = { ...hello, writeEnabled: true, capabilities: ['getContext', 'applyBatch'] };
assert.equal(negotiateHello(claimedWrite, 1).writeEnabled, false);
assert.deepEqual(negotiateHello(claimedWrite, 1).capabilities, ['getContext']);
assert.equal(negotiateHello(claimedWrite, 1, true).writeEnabled, true);
assert.throws(() => negotiateHello(hello, 1, true), /PROTOCOL_MISMATCH/);
assert.throws(() => negotiateHello({ ...hello, protocolVersion: 2 }, 1), /PROTOCOL_MISMATCH/);
assert.throws(() => negotiateHello({ ...hello, secret: 'not allowed' }, 1));
const scope = { sessionId: 'session', connectionGeneration: 1 };
const operationId = '019a4a10-0000-7000-8000-000000000001';
const command = { type: 'command', ...scope, operationId, command: 'getTree', params: { rootId: '0:1', depth: 1, limit: 10 } };
assert.equal(validateCommand(command, scope).command, 'getTree');
for (const raw of [
  { ...command, sessionId: 'other' }, { ...command, connectionGeneration: 2 },
  { ...command, command: 'execute_js' }, { ...command, params: { ...command.params, scope } },
  { ...command, params: { ...command.params, unknown: true } },
]) assert.throws(() => validateCommand(raw, scope));
const ack = { type: 'ack', ...scope, operationId };
assert.equal(validateAck(ack, { ...scope, operationId }).status, 'running');
assert.throws(() => validateAck({ ...ack, operationId: operationId.replace(/1$/, '2') }, { ...scope, operationId }));
console.log('Протокол: hello/welcome, версии, повреждённые команды, scope и ACK≠успех — OK');
