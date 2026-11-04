import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['plugin/scene-ops.ts', 'shared/batch-executor.ts', 'shared/operation-journal.ts'], outdir: 'out', bundle: true, format: 'esm', platform: 'node', write: false });
const load = async n => import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[n].text).toString('base64')}`);
const { pageOperations } = await load(0);
const { BatchExecutor } = await load(1);
const { OperationJournal } = await load(2);
const now = Date.now(), hex = now.toString(16).padStart(12, '0');
const id = n => `${hex.slice(0,8)}-${hex.slice(8)}-7000-8000-${String(n).padStart(12,'0')}`;
let next = 0;
const root = { id: 'root', type: 'DOCUMENT', children: [] };
const nodes = new Map([['root', root]]);
function createPage(name = 'Page') {
  let pageName = name;
  const page = { id: `page:${++next}`, type: 'PAGE', parent: root, children: [], loaded: false,
    async loadAsync() { this.loaded = true; },
    clone() { assert(this.loaded); return createPage(this.name); },
    remove() { root.children.splice(root.children.indexOf(this), 1); this.removed = true; },
    get name() { return pageName; },
    set name(value) { if (value === 'fail') throw Error('setting failed'); pageName = value; },
  };
  root.children.push(page); nodes.set(page.id, page); return page;
}
const initial = createPage('original');
const ops = pageOperations({ root, createPage, async getNodeByIdAsync(key) { return nodes.get(key) ?? null; } });
const executor = new BatchExecutor(new OperationJournal({ dedupTtl: 10000, clockSkew: 10, maxJournalEntries: 20 }), { ...ops, checkScope() {}, commitUndo() {} }, 10);
const scope = { sessionId: 's', connectionGeneration: 1 };
const submit = (n, steps) => executor.submit(scope, id(n), steps, now);
const created = await submit(1, [{ stepId: 'create', op: 'createPage', name: 'new' }]);
assert.equal(nodes.get(created.steps[0].outputs.nodeId).name, 'new');
const clone = await submit(2, [{ stepId: 'clone', op: 'clonePage', pageId: { nodeId: initial.id }, name: 'copy', expected: { name: 'original' } }]);
assert.equal(nodes.get(clone.steps[0].outputs.nodeId).name, 'copy');
const conflict = await submit(3, [{ stepId: 'rename', op: 'renamePage', pageId: { nodeId: initial.id }, name: 'wrong', expected: { name: 'stale' } }]);
assert.equal(conflict.error.code, 'CONFLICT');
assert.equal(initial.name, 'original');
const rename = await submit(4, [{ stepId: 'rename', op: 'renamePage', pageId: { nodeId: initial.id }, name: 'changed', expected: { name: 'original' } }]);
assert.equal(rename.status, 'succeeded');
assert.equal(initial.name, 'changed');
const partial = await submit(5, [{ stepId: 'create', op: 'createPage', name: 'fail' }]);
assert.equal(partial.status, 'partially_applied');
assert.equal(partial.affectedNodeIds.length, 1);
for (const page of [...root.children].slice(1)) page.remove();
const last = await submit(6, [{ stepId: 'delete', op: 'deletePage', pageId: { nodeId: initial.id }, expected: { name: 'changed' } }]);
assert.equal(last.status, 'failed');
assert.equal(last.error.code, 'INVALID_ARGUMENT');
assert.equal(root.children.length, 1);
console.log('Page callbacks: create, clone, live conflict, partial creation and last-page guard OK');
const fonts = [];
let nodeSequence = 0;
const sceneNodes = new Map();
function sceneNode(type) {
  const node = { id: `node:${++nodeSequence}`, type, name: type, x: 0, y: 0, width: 100, height: type === 'LINE' ? 0 : 100, rotation: 0, visible: true, locked: false, characters: '', children: [], parent: null,
    resize(w, h) { this.width = w; this.height = h; },
    clone() { return sceneNode(type); },
    appendChild(child) { child.parent = this; this.children.push(child); },
    insertChild(index, child) { child.parent = this; this.children.splice(index, 0, child); },
    remove() { this.removed = true; },
  };
  sceneNodes.set(node.id, node); return node;
}
const container = sceneNode('FRAME');
const sceneApi = { root, getNodeByIdAsync: async key => sceneNodes.get(key) ?? nodes.get(key),
  async loadFontAsync(font) { fonts.push(font); if (font.family === 'Missing') throw Error('missing'); },
};
for (const [type, method] of Object.entries({ FRAME: 'createFrame', RECTANGLE: 'createRectangle', ELLIPSE: 'createEllipse', LINE: 'createLine', POLYGON: 'createPolygon', STAR: 'createStar', TEXT: 'createText' })) sceneApi[method] = () => sceneNode(type);
const scene = pageOperations(sceneApi);
const sceneExecutor = new BatchExecutor(new OperationJournal({ dedupTtl: 10000, clockSkew: 10, maxJournalEntries: 40 }), { ...scene, checkScope() {}, commitUndo() {} }, 10);
const runScene = (n, steps) => sceneExecutor.submit(scope, id(n), steps, now);
for (const [index, type] of ['FRAME', 'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'TEXT'].entries()) {
  const properties = { name: `new ${type}`, x: 7, ...(type === 'TEXT' ? { fontName: { family: 'Inter', style: 'Regular' }, characters: 'Hello' } : {}) };
  const result = await runScene(10 + index, [{ stepId: 'create', op: 'createNode', type, parent: { nodeId: container.id }, properties }]);
  assert.equal(result.status, 'succeeded');
  const node = sceneNodes.get(result.steps[0].outputs.nodeId);
  assert.equal(node.parent, container);
  assert.equal(node.name, `new ${type}`);
  if (type === 'TEXT') assert.equal(node.characters, 'Hello');
}
assert.deepEqual(fonts, [{ family: 'Inter', style: 'Regular' }]);
const countBefore = sceneNodes.size;
const denied = await runScene(20, [{ stepId: 'unsupported', op: 'createNode', type: 'FRAME', parent: { nodeId: container.id }, properties: { layout: { layoutMode: 'HORIZONTAL' } } }]);
assert.equal(denied.error.code, 'CAPABILITY_UNAVAILABLE');
assert.equal(sceneNodes.size, countBefore);
const missingFont = await runScene(21, [{ stepId: 'text', op: 'createNode', type: 'TEXT', parent: { nodeId: container.id }, properties: { fontName: { family: 'Missing', style: 'Regular' }, characters: 'hello' } }]);
assert.equal(missingFont.error.code, 'FONT_UNAVAILABLE');
assert.equal(sceneNodes.size, countBefore);
const target = container.children[1];
const renamed = await runScene(22, [{ stepId: 'rename', op: 'updateNode', type: target.type, target: { nodeId: target.id }, patch: { name: 'renamed' }, expected: { name: target.name } }]);
assert.equal(renamed.status, 'succeeded');
assert.equal(target.name, 'renamed');
const cloned = await runScene(23, [{ stepId: 'clone', op: 'cloneNode', target: { nodeId: target.id }, parent: { nodeId: container.id }, expected: { name: 'renamed' } }]);
assert.equal(sceneNodes.get(cloned.steps[0].outputs.nodeId).parent, container);
const deleted = await runScene(24, [{ stepId: 'delete', op: 'deleteNode', target: { nodeId: target.id }, expected: { name: 'renamed' } }]);
assert.equal(deleted.status, 'succeeded');
assert(target.removed);
const failureParent = sceneNode('FRAME');
failureParent.appendChild = () => { throw Error('append failed'); };
const partialNode = await runScene(25, [{ stepId: 'partial', op: 'createNode', type: 'RECTANGLE', parent: { nodeId: failureParent.id }, properties: {} }]);
assert.equal(partialNode.status, 'partially_applied');
assert.equal(partialNode.affectedNodeIds.length, 1);
console.log('Scene callbacks: seven types, fonts, rejected fields, clone/delete and partial step OK');
const beforeUnsupportedUpdate = target.name;
const unsupportedUpdate = await runScene(26, [{ stepId: 'unsupported-update', op: 'updateNode', type: target.type, target: { nodeId: target.id }, patch: { name: 'must-not-write', opacity: 0.5 }, expected: { name: beforeUnsupportedUpdate } }]);
assert.equal(unsupportedUpdate.error.code, 'NODE_NOT_FOUND');
const liveTarget = container.children[0];
const rejectPatch = await runScene(27, [{ stepId: 'unsupported-update', op: 'updateNode', type: liveTarget.type, target: { nodeId: liveTarget.id }, patch: { name: 'must-not-write', layout: { layoutMode: 'HORIZONTAL' } }, expected: { name: liveTarget.name } }]);
assert.equal(rejectPatch.error.code, 'CAPABILITY_UNAVAILABLE');
assert.notEqual(liveTarget.name, 'must-not-write');
Object.defineProperty(liveTarget, 'x', { get() { return 0; }, set() { throw Error('write failed'); }, configurable: true });
const partialUpdate = await runScene(28, [{ stepId: 'partial-update', op: 'updateNode', type: liveTarget.type, target: { nodeId: liveTarget.id }, patch: { name: 'changed-first', x: 4 }, expected: { name: liveTarget.name } }]);
assert.equal(partialUpdate.status, 'partially_applied');
assert.deepEqual(partialUpdate.affectedNodeIds, [liveTarget.id]);
assert.equal(liveTarget.name, 'changed-first');
for (const [index, type] of ['INSTANCE', 'COMPONENT_SET', 'DOCUMENT'].entries()) {
  const invalidParent = sceneNode(type);
  const before = sceneNodes.size;
  const result = await runScene(29 + index, [{ stepId: 'invalid-parent', op: 'createNode', type: 'FRAME', parent: { nodeId: invalidParent.id }, properties: {} }]);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.equal(sceneNodes.size, before);
}
const fontWait = (() => { let release, started; return { waiting: new Promise(resolve => { started = resolve; }), continue: new Promise(resolve => { release = resolve; }), start: () => started(), release: () => release() }; })();
const disappearingParent = sceneNode('FRAME');
sceneApi.loadFontAsync = async () => { fontWait.start(); await fontWait.continue; };
const beforeRace = sceneNodes.size;
const raced = runScene(32, [{ stepId: 'raced', op: 'createNode', type: 'TEXT', parent: { nodeId: disappearingParent.id }, properties: { fontName: { family: 'Inter', style: 'Regular' }, characters: 'text' } }]);
await fontWait.waiting;
disappearingParent.removed = true;
fontWait.release();
assert.equal((await raced).error.code, 'NODE_NOT_FOUND');
assert.equal(sceneNodes.size, beforeRace);
const removedNode = sceneNode('RECTANGLE');
const removedId = removedNode.id;
Object.defineProperty(removedNode, 'id', { get() { if (this.removed) throw Error('removed id inaccessible'); return removedId; } });
const deletion = await runScene(33, [{ stepId: 'delete', op: 'deleteNode', target: { nodeId: removedId }, expected: { name: removedNode.name } }]);
assert.equal(deletion.status, 'succeeded');
assert.deepEqual(deletion.affectedNodeIds, [removedId]);
const removablePage = createPage('remove me');
const removablePageId = removablePage.id;
Object.defineProperty(removablePage, 'id', { get() { if (this.removed) throw Error('removed id inaccessible'); return removablePageId; } });
const pageDeletion = await submit(34, [{ stepId: 'delete', op: 'deletePage', pageId: { nodeId: removablePageId }, expected: { name: 'remove me' } }]);
assert.equal(pageDeletion.status, 'succeeded');
assert.deepEqual(pageDeletion.affectedNodeIds, [removablePageId]);
for (const [index, type] of ['GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'BOOLEAN_OPERATION', 'VECTOR', 'SECTION'].entries()) {
  const item = sceneNode(type); container.appendChild(item);
  if (['COMPONENT', 'INSTANCE'].includes(type)) {
    const updated = await runScene(35 + index * 3, [{ stepId: 'update', op: 'updateNode', type, target: { nodeId: item.id }, patch: { name: 'Updated' }, expected: { name: item.name } }]);
    assert.equal(updated.status, 'succeeded');
  }
  const clone = await runScene(36 + index * 3, [{ stepId: 'clone', op: 'cloneNode', target: { nodeId: item.id }, parent: { nodeId: container.id }, expected: { name: item.name } }]);
  assert.equal(clone.status, 'succeeded', type);
  const removed = await runScene(37 + index * 3, [{ stepId: 'delete', op: 'deleteNode', target: { nodeId: item.id }, expected: { name: item.name } }]);
  assert.equal(removed.status, 'succeeded', type);
  if (type === 'COMPONENT' || type === 'COMPONENT_SET') assert.match(removed.steps[0].appliedChanges.details[0].effect, /linked instances/);
}
