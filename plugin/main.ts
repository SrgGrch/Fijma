import { PROTOCOL_VERSION, welcomeSchema, validateCommand } from '../shared/protocol';
import { bootstrapLimits } from '../shared/bootstrap-limits';
import { contextRequestSchema } from '../shared/context';
import { TreePager } from '../shared/tree-pager';
import { loadDocumentRoot } from './document';
import { createUIYield } from '../shared/ui-yield';

const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let awaitingWelcome = false;
let connectionGeneration: number | undefined;
const capabilities = ['getContext', 'getTree'];
const scheduler = createUIYield(message => figma.ui.postMessage(message));
let pager = new TreePager({ maxDepth: 8, maxNodes: 1000, maxResponseBytes: 32768, chunkSize: 50 }, 100, 60000);
const revisions = new Map<string, { value: number }>();
let reading = false;
figma.showUI(__html__, { width: 450, height: 430 });
figma.ui.onmessage = async message => {
  if (!message || typeof message !== 'object') return;
  if (scheduler.accept(message)) return;
  if (message.type === 'hello-request' && Object.keys(message).length === 1) {
    awaitingWelcome = true;
    connectionGeneration = undefined;
    pager.clear(); scheduler.release();
    figma.ui.postMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION, sessionId,
      capabilities, limits: bootstrapLimits, writeEnabled: false });
  } else if (message.type === 'welcome' && awaitingWelcome) {
    const parsed = welcomeSchema.safeParse(message);
    if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.writeEnabled ||
      JSON.stringify(parsed.data.capabilities) !== JSON.stringify(capabilities)) {
      awaitingWelcome = false;
      figma.ui.postMessage({ type: 'error', code: 'PROTOCOL_MISMATCH' });
      return;
    }
    connectionGeneration = parsed.data.connectionGeneration;
    pager = new TreePager({ maxDepth: parsed.data.limits.maxDepth, maxNodes: parsed.data.limits.maxNodes,
      maxResponseBytes: parsed.data.limits.maxResponseBytes, chunkSize: 50 }, 100, parsed.data.limits.resourceTtl);
    awaitingWelcome = false;
    figma.ui.postMessage({ type: 'bound', sessionId, connectionGeneration, documentLabel: figma.root.name,
      writeEnabled: false, message: 'Сопряжено. Доступно чтение контекста и дерева. Запись выключена.' });
  } else if (message.type === 'disconnected' && Object.keys(message).length === 1) {
    awaitingWelcome = false;
    connectionGeneration = undefined;
    pager.clear(); scheduler.release();
  } else if (message.type === 'getContext') {
    const request = contextRequestSchema.safeParse(message);
    if (!request.success || request.data.sessionId !== sessionId || request.data.connectionGeneration !== connectionGeneration) {
      figma.ui.postMessage({ type: 'error', code: 'SESSION_EXPIRED' });
      return;
    }
    figma.ui.postMessage({ type: 'context', requestId: request.data.requestId, sessionId, connectionGeneration,
      document: { documentLabel: figma.root.name, pages: figma.root.children.map(page => ({ id: page.id, name: page.name })),
        currentPageId: figma.currentPage.id, selection: figma.currentPage.selection.map(node => node.id) } });
  } else if (message.type === 'command') {
    let command;
    try {
      if (connectionGeneration === undefined) throw new Error('SESSION_EXPIRED');
      command = validateCommand(message, { sessionId, connectionGeneration });
      if (command.command !== 'getTree') throw new Error('CAPABILITY_UNAVAILABLE');
      if (reading) throw new Error('RESOURCE_LIMIT');
    } catch { figma.ui.postMessage({ type: 'error', code: 'INVALID_ARGUMENT' }); return; }
    reading = true;
    const scope = { sessionId, connectionGeneration };
    const reply = { type: 'treeResult', ...scope, operationId: command.operationId };
    try {
      const query = command.params as { rootId: string; depth: number; limit: number; cursor?: string };
      const { root, page } = await loadDocumentRoot(figma, query.rootId);
      if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED');
      let revision = revisions.get(page.id);
      if (!revision) {
        if (revisions.size >= 100) throw new Error('RESOURCE_LIMIT');
        revision = { value: 0 }; revisions.set(page.id, revision);
        page.on('nodechange', () => { revision!.value++; });
      }
      const data = await pager.read(root, query, scope, () => revision!.value, Date.now(), { yieldControl: scheduler.wait });
      if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED');
      figma.ui.postMessage({ ...reply, data });
    } catch (error) {
      const code = error instanceof Error && ['SESSION_EXPIRED', 'NODE_NOT_FOUND', 'INVALID_CURSOR', 'INVALID_ARGUMENT', 'RESOURCE_LIMIT'].includes(error.message) ? error.message : 'FIGMA_API_ERROR';
      figma.ui.postMessage({ ...reply, error: { code, message: 'Не удалось прочитать дерево.', recoveryAction: 'Перечитайте контекст и начните чтение заново.' } });
    } finally { reading = false; }
  }
};
