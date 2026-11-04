import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['shared/batch-executor.ts', 'shared/operation-journal.ts'], bundle: true, format: 'esm', platform: 'node', outdir: 'out', write: false });
const load = async n => import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[n].text).toString('base64')}`);
const { BatchExecutor } = await load(0);
const { OperationJournal } = await load(1);
const now = Date.now();
const id = n => `${now.toString(16).padStart(12, '0').slice(0,8)}-${now.toString(16).padStart(12, '0').slice(8)}-7000-8000-${String(n).padStart(12,'0')}`;
const scope = { sessionId: 's', connectionGeneration: 1 };
const create = stepId => ({ stepId, op: 'createNode', type: 'FRAME', parent: { nodeId: '1:1' }, properties: {} });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const journal = () => new OperationJournal({ dedupTtl: 10000, clockSkew: 100, maxJournalEntries: 20 });
let writes = [], undo = 0, gate = deferred(), live = { characters: 'old' }, prepareGate;
const platform = {
  checkScope(s) { if (s.connectionGeneration !== 1) throw Error('SESSION_EXPIRED'); },
  async prepare(step) { if (step.stepId === 'wait') await gate.promise; if (prepareGate) await prepareGate.promise; },
  async readExpected() { return live; },
  async execute(step, record) {
    writes.push(step.stepId);
    if (step.stepId === 'child') assert.deepEqual(step.parent, { nodeId: 'id:parent' });
    if (step.stepId === 'partial') { record({ nodeIds: ['partial:1'], resourceIds: [] }); throw Error('secret payload'); }
    const nodeId = `id:${step.stepId}`;
    record({ nodeIds: [nodeId], resourceIds: [] });
    return { nodeId };
  },
  commitUndo() { undo++; },
};
const executor = new BatchExecutor(journal(), platform, 10);
const a = executor.submit(scope, id(1), [create('wait'), create('next')], now);
await Promise.resolve();
const b = executor.submit(scope, id(2), [create('other')], now);
assert.equal((await executor.submit(scope, id(1), [create('wait'), create('next')], now)).status, 'running');
assert.throws(() => executor.submit(scope, id(1), [create('different')], now), /OPERATION_ID_CONFLICT/);
gate.resolve();
assert.equal((await a).status, 'succeeded');
assert.equal((await b).status, 'succeeded');
assert.deepEqual(writes, ['wait', 'next', 'other']);
assert.equal((await executor.submit(scope, id(1), [create('wait'), create('next')], now)).result.affectedNodeIds[0], 'id:wait');
const before = writes.length;
assert.throws(() => executor.submit(scope, id(3), [create('dup'), create('dup')], now));
assert.throws(() => executor.submit(scope, id(3), [{ ...create('first'), parent: { stepId: 'later', output: 'nodeId' } }, create('later')], now));
assert.equal(writes.length, before);
const ref = await executor.submit(scope, id(4), [create('parent'), { ...create('child'), parent: { stepId: 'parent', output: 'nodeId' } }], now);
assert.equal(ref.status, 'succeeded');
const partial = await executor.submit(scope, id(5), [create('partial'), create('skipped')], now);
assert.equal(partial.status, 'partially_applied');
assert.equal(partial.error.code, 'FIGMA_API_ERROR');
assert.equal(partial.error.failedStep, 'partial');
assert(!JSON.stringify(partial).includes('secret payload'));
assert.deepEqual(partial.affectedNodeIds, ['partial:1']);
assert.equal(partial.steps[1].status, 'skipped');
prepareGate = deferred();
const conflict = executor.submit(scope, id(6), [{ stepId: 'text', op: 'setText', target: { nodeId: 't' }, characters: 'new', expected: { characters: 'old' } }], now);
await Promise.resolve(); live = { characters: 'manual edit' }; prepareGate.resolve();
assert.equal((await conflict).error.code, 'CONFLICT');
prepareGate = undefined;
gate = deferred();
const cancel = executor.submit(scope, id(7), [create('wait'), create('never')], now);
await Promise.resolve();
const queued = executor.submit(scope, id(8), [create('queued')], now);
executor.stop(); gate.resolve();
assert.equal((await cancel).status, 'cancelled');
assert.equal((await queued).status, 'cancelled');
assert(!writes.includes('never') && !writes.includes('queued'));
assert.equal(undo, 4);
const afterFirst = deferred(), resume = deferred();
let boundaries = 0, globalUndo = 0;
const priority = new BatchExecutor(journal(), {
  ...platform,
  async yieldControl() { if (++boundaries === 2) { afterFirst.resolve(); await resume.promise; } },
  undo() { globalUndo++; },
}, 10);
const active = priority.submit(scope, id(19), [create('applied'), create('not-applied')], now);
await afterFirst.promise;
const waiting = priority.submit(scope, id(20), [create('not-queued')], now);
const undoBefore = undo;
priority.stop(); resume.resolve();
const stopped = await active;
assert.equal(stopped.status, 'cancelled');
assert.deepEqual(stopped.affectedNodeIds, ['id:applied']);
assert.deepEqual(stopped.steps.map(step => step.status), ['succeeded', 'skipped']);
assert.equal((await waiting).status, 'cancelled');
assert.equal(undo, undoBefore + 1); assert.equal(globalUndo, 0);
assert(!writes.includes('not-applied') && !writes.includes('not-queued'));
const guardWait = deferred(), guardResume = deferred();
const guarded = new BatchExecutor(journal(), {
  ...platform,
  async prepare(step, _original, guard) { if (step.stepId === 'guarded') { guardWait.resolve(); await guardResume.promise; guard(); } },
}, 10);
const guardedRun = guarded.submit(scope, id(21), [create('before-guard'), create('guarded')], now);
await guardWait.promise; guarded.stop(); guardResume.resolve();
const guardedResult = await guardedRun;
assert.equal(guardedResult.status, 'cancelled');
assert.deepEqual(guardedResult.steps.map(step => step.status), ['succeeded', 'skipped']);
assert.deepEqual(guardedResult.affectedNodeIds, ['id:before-guard']);
console.log('Batch executor: queue, refs, conflict, partial write, retries and stop OK');

const resultBuild = await build({ entryPoints: ['shared/operation-result.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { operationResultSchema } = await import(`data:text/javascript;base64,${Buffer.from(resultBuild.outputFiles[0].text).toString('base64')}`);
for (const value of [ref, partial, await conflict, await cancel, await queued]) assert.equal(operationResultSchema.safeParse(value).success, true);
live = { parentId: 'old-parent', related: { 'old-parent': { children: ['someone-else', 't'] } } };
const moved = await executor.submit(scope, id(9), [{ stepId: 'move', op: 'moveNode', target: { nodeId: 't' }, parent: { nodeId: 'new-parent' }, index: 0, expected: { parentId: 'old-parent', related: { 'old-parent': { children: ['t', 'someone-else'] } } } }], now);
assert.equal(moved.error.code, 'CONFLICT');
assert(!writes.includes('move'));
assert.equal(operationResultSchema.safeParse(moved).success, true);

const fullJournal = journal();
const unknownSteps = [create('unknown')];
fullJournal.reserve(id(10), { command: 'figma_apply_batch', params: { steps: unknownSteps } }, now);
fullJournal.update(id(10), 'running');
fullJournal.update(id(10), 'unknown');
gate = deferred();
const fullExecutor = new BatchExecutor(fullJournal, platform, 1);
const occupying = fullExecutor.submit(scope, id(11), [create('wait')], now);
await Promise.resolve();
const repeatedUnknown = await fullExecutor.submit(scope, id(10), unknownSteps, now);
assert.equal(repeatedUnknown.status, 'unknown');
assert.equal(repeatedUnknown.fresh, false);
assert.throws(() => fullExecutor.submit(scope, id(10), [create('changed')], now), /OPERATION_ID_CONFLICT/);
assert.throws(() => fullExecutor.submit(scope, id(12), [create('new')], now), /RESOURCE_LIMIT/);
gate.resolve();
await occupying;
assert(!writes.includes('unknown'));

const transportBuild = await build({ entryPoints: ['shared/execution-transport.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { ExecutionTransport } = await import(`data:text/javascript;base64,${Buffer.from(transportBuild.outputFiles[0].text).toString('base64')}`);
const written = deferred(), finishWrite = deferred();
let executions = 0;
const transportExecutor = new BatchExecutor(journal(), {
  ...platform,
  checkScope(s) { if (s.sessionId !== 's') throw Error('SESSION_EXPIRED'); },
  async execute(step, record) {
    executions++;
    record({ nodeIds: ['written:1'], resourceIds: [] });
    written.resolve();
    await finishWrite.promise;
    return { nodeId: 'written:1' };
  },
}, 10);
const transport = new ExecutionTransport(transportExecutor, scope);
const lost = transport.submit(scope, id(13), [create('transport')], now, 10);
await written.promise;
const timedOut = await lost;
assert.equal(timedOut.status, 'unknown');
assert.equal(operationResultSchema.safeParse(timedOut).success, true);
assert.equal(transport.status(id(13)).status, 'running');
transport.disconnect();
assert.throws(() => transport.status(id(13)), /NOT_CONNECTED/);
const generation2 = { sessionId: 's', connectionGeneration: 2 };
assert.throws(() => transport.reconnect({ sessionId: 'new', connectionGeneration: 2 }), /SESSION_EXPIRED/);
transport.reconnect(generation2);
assert.equal((await transport.submit(scope, id(13), [create('transport')], now, 100)).status, 'running');
assert.equal((await transport.submit(scope, id(14), [create('lost-before-journal')], now, 100)).status, 'unknown');
finishWrite.resolve();
await new Promise(resolve => setImmediate(resolve));
const recovered = transport.status(id(13));
assert.equal(recovered.status, 'succeeded');
assert.deepEqual(recovered.affectedNodeIds, ['written:1']);
assert.equal((await transport.submit(scope, id(13), [create('transport')], now, 100)).status, 'succeeded');
assert.equal(executions, 1);
assert.throws(() => transport.submit({ sessionId: 'old', connectionGeneration: 1 }, id(15), [create('stale')], now, 100), /SESSION_EXPIRED/);

const disconnectedWrite = deferred(), continueWrite = deferred();
const transport2 = new ExecutionTransport(new BatchExecutor(journal(), {
  ...platform,
  async execute(step, record) { record({ nodeIds: ['written:2'], resourceIds: [] }); disconnectedWrite.resolve(); await continueWrite.promise; return { nodeId: 'written:2' }; },
}, 10), scope);
const awaiting = transport2.submit(scope, id(16), [create('disconnect')], now, 5000);
await disconnectedWrite.promise;
transport2.disconnect();
assert.equal((await awaiting).status, 'unknown');
transport2.reconnect(generation2);
continueWrite.resolve();
await new Promise(resolve => setImmediate(resolve));
assert.equal(transport2.status(id(16)).status, 'succeeded');
const descendingScope = { sessionId: 's', connectionGeneration: 100 };
let descendingWrites = 0;
const descending = new ExecutionTransport(new BatchExecutor(journal(), {
  ...platform, checkScope() {},
  async execute(step, record) { descendingWrites++; record({ nodeIds: ['once:1'], resourceIds: [] }); return { nodeId: 'once:1' }; },
}, 10), descendingScope);
assert.equal((await descending.submit(descendingScope, id(17), [create('once')], now, 100)).status, 'succeeded');
descending.disconnect();
const lowerScope = { sessionId: 's', connectionGeneration: 5 };
descending.reconnect(lowerScope);
assert.equal((await descending.submit(descendingScope, id(17), [create('once')], now, 100)).status, 'succeeded');
assert.equal((await descending.submit(descendingScope, id(18), [create('missing')], now, 100)).status, 'unknown');
assert.equal(descendingWrites, 1);
assert.throws(() => descending.reconnect(lowerScope), /SESSION_EXPIRED/);
