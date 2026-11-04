import { createUIElements } from './ui-elements.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const built = await build({ entryPoints: ['plugin/main.ts', 'plugin/ui.ts'], bundle: true, target: 'es2017', outdir: 'out', write: false });
const main = built.outputFiles.find(file => file.path.endsWith('main.js')).text;
const uiScript = built.outputFiles.find(file => file.path.endsWith('ui.js')).text;
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/server/index.js'], env: { ...process.env, FIGMA_MCP_PORT: '0' }, stderr: 'pipe' });
let diagnostics = ''; transport.stderr.on('data', bytes => diagnostics += bytes.toString());
const client = new Client({ name: 'design-system-test', version: '0.1.0' });
const sockets = []; let deadline;
try {
  await client.connect(transport);
  const url = diagnostics.match(/Локальный мост: (ws:\/\/[^\r\n]+)/)[1];
  const token = await readFile(diagnostics.match(/Файл сопряжения: ([^\r\n]+)/)[1], 'utf8');
  const elements = createUIElements();
  const nodes = new Map(), styles = new Map(), collections = new Map(), variables = new Map(); let serial = 0;
  const make = type => {
    const node = { id: `node:${++serial}`, type, name: type, key: `key:${serial}`, remote: false, children: [], x: 0, y: 0, width: 100, height: 100, rotation: 0, visible: true, locked: false, fills: [], strokes: [], effects: [], opacity: 1, boundVariables: {}, explicitVariableModes: {}, fillStyleId: '', layoutMode: 'NONE',
      appendChild(child) { if (child.parent) child.parent.children = child.parent.children.filter(n => n !== child); child.parent = this; this.children.push(child); }, resize(w, h) { this.width = w; this.height = h; }, async loadAsync() {}, on() {},
      async setFillStyleIdAsync(id) { this.fillStyleId = id; if (id) this.fills = styles.get(id).paints; },
      setBoundVariable(key, v) { if (v) this.boundVariables[key] = { type: 'VARIABLE_ALIAS', id: v.id }; else delete this.boundVariables[key]; } };
    nodes.set(node.id, node); return node;
  };
  const page = make('PAGE'); page.id = '0:1'; nodes.set(page.id, page); page.selection = [];
  const root = { id: 'root', type: 'DOCUMENT', name: 'Fixture', children: [page] }; page.parent = root;
  let ui, resolveBound; const bound = new Promise(resolve => resolveBound = resolve);
  const figma = { root, currentPage: page, mixed: Symbol('mixed'), async getNodeByIdAsync(id) { return nodes.get(id) ?? null; }, async loadFontAsync() {},
    createComponent() { const n = make('COMPONENT'); n.componentPropertyDefinitions = {}; n.addComponentProperty = (key, type, defaultValue) => { const name = key + '#1'; n.componentPropertyDefinitions[name] = { type, defaultValue }; return name; }; n.createInstance = () => { const i = make('INSTANCE'); i.componentProperties = {}; i.overrides = []; i.getMainComponentAsync = async () => n; page.appendChild(i); return i; }; page.appendChild(n); return n; },
    createNodeFromSvg() { const n = make('FRAME'); page.appendChild(n); return n; },
    createPaintStyle() { const s = { id: `S:${++serial}`, name: '', type: 'PAINT', paints: [], remote: false }; styles.set(s.id, s); return s; },
    async getStyleByIdAsync(id) { return styles.get(id) ?? null; }, async getLocalPaintStylesAsync() { return [...styles.values()]; }, async getLocalTextStylesAsync() { return []; }, async getLocalEffectStylesAsync() { return []; }, async getLocalGridStylesAsync() { return []; },
    variables: { async getVariableByIdAsync(id) { return variables.get(id) ?? null; }, async getVariableCollectionByIdAsync(id) { return collections.get(id) ?? null; }, async getLocalVariablesAsync() { return [...variables.values()]; }, async getLocalVariableCollectionsAsync() { return [...collections.values()]; },
      createVariableCollection(name) { const c = { id: `VariableCollectionId:${++serial}`, name, remote: false, modes: [{ modeId: 'm1', name: 'Default' }], defaultModeId: 'm1', variableIds: [] }; collections.set(c.id, c); return c; },
      createVariable(name, c, type) { const v = { id: `VariableID:${++serial}`, name, remote: false, description: '', hiddenFromPublishing: false, variableCollectionId: c.id, resolvedType: type, valuesByMode: { m1: 0 }, setValueForMode(id, value) { this.valuesByMode[id] = value; } }; c.variableIds.push(v.id); variables.set(v.id, v); return v; } },
    commitUndo() {}, showUI() {}, ui: { postMessage(message) { queueMicrotask(() => { ui.onmessage({ data: { pluginMessage: message } }); if (message.type === 'bound') resolveBound(message); }); } } };
  runInNewContext(main, { figma, __html__: '' });
  class Socket extends WebSocket { constructor() { super(url); sockets.push(this); } }
  ui = { setTimeout: () => 1, clearTimeout() {}, document: { getElementById: id => elements[id], addEventListener() {}, visibilityState: 'visible' }, window: { addEventListener() {} }, WebSocket: Socket, parent: { postMessage: ({ pluginMessage }) => queueMicrotask(() => figma.ui.onmessage(pluginMessage)) } };
  runInNewContext(uiScript, ui); elements.secret.value = token; elements.connect.onclick();
  const binding = await Promise.race([bound, new Promise((_, reject) => deadline = setTimeout(() => reject(Error('Handshake timeout')), 5000))]); clearTimeout(deadline);
  const scope = { sessionId: binding.sessionId, connectionGeneration: binding.connectionGeneration };
  elements.write.checked = true; elements.write.onchange();
  for (let i = 0; i < 50 && !(await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent.writeEnabled; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const stamp = Date.now().toString(16).padStart(12, '0'); let seq = 0;
  const run = steps => client.callTool({ name: 'figma_apply_batch', arguments: { scope, operationId: `${stamp.slice(0,8)}-${stamp.slice(8)}-7000-8000-${String(++seq).padStart(12,'0')}`, steps } });
  const red = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
  const batch = (await run([
    { stepId: 'component', op: 'createComponent', parent: { nodeId: '0:1' }, properties: { name: 'Button', opacity: 0.7 } },
    { stepId: 'instance', op: 'createInstance', componentId: { stepId: 'component', output: 'nodeId' }, parent: { nodeId: '0:1' } },
    { stepId: 'style', op: 'createStyle', type: 'PAINT', name: 'Red', value: { paints: red } },
    { stepId: 'apply', op: 'applyStyle', target: { stepId: 'instance', output: 'nodeId' }, property: 'fills', styleId: { stepId: 'style', output: 'styleId' } },
    { stepId: 'collection', op: 'createCollection', name: 'Tokens' },
    { stepId: 'variable', op: 'createVariable', collectionId: { stepId: 'collection', output: 'collectionId' }, name: 'Width', type: 'FLOAT' },
    { stepId: 'value', op: 'setVariableValue', variableId: { stepId: 'variable', output: 'variableId' }, modeId: 'm1', value: 24 },
    { stepId: 'bind', op: 'bindVariable', target: { stepId: 'instance', output: 'nodeId' }, property: 'width', variableId: { stepId: 'variable', output: 'variableId' } },
    { stepId: 'svg', op: 'importSvg', parent: { nodeId: '0:1' }, svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>' },
  ])).structuredContent;
  assert.equal(batch.status, 'succeeded', JSON.stringify(batch));
  const instanceId = batch.steps[1].outputs.nodeId, styleId = batch.steps[2].outputs.styleId, variableId = batch.steps[5].outputs.variableId;
  const read = (await client.callTool({ name: 'figma_get_nodes', arguments: { scope, nodeIds: [instanceId], fields: ['fillStyleId', 'boundVariables', 'mainComponent', 'opacity'] } })).structuredContent.nodes[0];
  assert.equal(read.properties.fillStyleId, styleId); assert.equal(read.properties.boundVariables.width.id, variableId); assert.equal(read.properties.mainComponent.id, batch.steps[0].outputs.nodeId);
  assert.equal(nodes.get(batch.steps[0].outputs.nodeId).opacity, 0.7); assert.equal(read.properties.opacity, 1);
  const resources = (await client.callTool({ name: 'figma_get_local_resources', arguments: { scope, kind: 'variables', ids: [variableId], fields: ['name', 'valuesByMode'], limit: 10 } })).structuredContent;
  assert.equal(resources.resources[0].properties.valuesByMode.m1, 24);
  console.log('Production design system: SDK through UI, component, style, variable, SVG and readback OK');
} finally { clearTimeout(deadline); for (const socket of sockets) socket.terminate(); await client.close(); }
