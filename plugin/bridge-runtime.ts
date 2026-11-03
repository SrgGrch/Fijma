import { PROTOCOL_VERSION, welcomeSchema, validateCommand } from '../shared/protocol';
import { bootstrapLimits } from '../shared/bootstrap-limits';
import { contextRequestSchema } from '../shared/context';
import { TreePager, SearchPager } from '../shared/tree-pager';
import { loadDocumentRoot } from './document';
import { createUIYield } from '../shared/ui-yield';
import { readNodes } from './projections';
import { ResourcePager } from './resources';
import { navigate } from './navigation';
import { exportNode } from './export';
import { chunkSizeFor } from '../shared/export-wire';

export function createBridgeRuntime(diagnostic?: { run: (command: any, scope: { sessionId: string; connectionGeneration: number }, checkScope: () => void) => Promise<unknown> }) {
const documentRoot = figma.root;
const checkDocument = () => { if (figma.root !== documentRoot) throw new Error('DOCUMENT_MISMATCH'); };
const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let awaitingWelcome = false;
let connectionGeneration: number | undefined;
const capabilities = ['getContext', 'getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate', 'exportNode', ...(diagnostic ? ['applyBatch'] : [])];
const scheduler = createUIYield(message => figma.ui.postMessage(message));
let pager = new TreePager({ maxDepth: 8, maxNodes: 1000, maxResponseBytes: 32768, chunkSize: 50 }, 100, 60000);
let search = new SearchPager({ maxDepth: 8, maxNodes: 1000, maxResponseBytes: 32768, chunkSize: 50 }, 100, 60000);
let limits = bootstrapLimits;
let resources = new ResourcePager(limits);
const revisions = new Map<string, { value: number }>();
let documentRevision = 0;
function observe(page: PageNode) {
  let revision = revisions.get(page.id);
  if (!revision) {
    if (revisions.size >= 100) throw new Error('RESOURCE_LIMIT');
    revision = { value: 0 }; revisions.set(page.id, revision);
    page.on('nodechange', () => { revision!.value++; documentRevision++; });
  }
  return revision;
}
let reading = false;
return async (message: any) => {
  if (!message || typeof message !== 'object') return;
  if (scheduler.accept(message)) return;
  if (message.type === 'hello-request' && Object.keys(message).length === 1) {
    awaitingWelcome = true;
    connectionGeneration = undefined;
    pager.clear(); search.clear(); resources.clear(); scheduler.release();
    figma.ui.postMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION, sessionId,
      capabilities, limits: bootstrapLimits, writeEnabled: Boolean(diagnostic) });
  } else if (message.type === 'welcome' && awaitingWelcome) {
    const parsed = welcomeSchema.safeParse(message);
    if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.writeEnabled !== Boolean(diagnostic) ||
      JSON.stringify(parsed.data.capabilities) !== JSON.stringify(capabilities)) {
      awaitingWelcome = false;
      figma.ui.postMessage({ type: 'error', code: 'PROTOCOL_MISMATCH' });
      return;
    }
    connectionGeneration = parsed.data.connectionGeneration;
    pager = new TreePager({ maxDepth: parsed.data.limits.maxDepth, maxNodes: parsed.data.limits.maxNodes,
      maxResponseBytes: parsed.data.limits.maxResponseBytes, chunkSize: 50 }, 100, parsed.data.limits.resourceTtl);
    search = new SearchPager({ maxDepth: parsed.data.limits.maxDepth, maxNodes: parsed.data.limits.maxNodes,
      maxResponseBytes: parsed.data.limits.maxResponseBytes, chunkSize: 50 }, 100, parsed.data.limits.resourceTtl);
    limits = parsed.data.limits;
    resources = new ResourcePager(limits);
    awaitingWelcome = false;
    figma.ui.postMessage({ type: 'bound', sessionId, connectionGeneration, documentLabel: figma.root.name,
      writeEnabled: Boolean(diagnostic), message: diagnostic ? 'Диагностика: разрешено только создание тестового маркера.' : 'Сопряжено. Доступно чтение контекста и дерева. Запись выключена.' });
  } else if (message.type === 'disconnected' && Object.keys(message).length === 1) {
    awaitingWelcome = false;
    connectionGeneration = undefined;
    pager.clear(); search.clear(); resources.clear(); scheduler.release();
  } else if (message.type === 'getContext') {
    const request = contextRequestSchema.safeParse(message);
    if (!request.success || request.data.sessionId !== sessionId || request.data.connectionGeneration !== connectionGeneration) {
      figma.ui.postMessage({ type: 'error', code: 'SESSION_EXPIRED' });
      return;
    }
    try { checkDocument(); } catch { figma.ui.postMessage({ type: 'error', code: 'DOCUMENT_MISMATCH' }); return; }
    figma.ui.postMessage({ type: 'context', requestId: request.data.requestId, sessionId, connectionGeneration,
      document: { documentLabel: figma.root.name, pages: figma.root.children.map(page => ({ id: page.id, name: page.name })),
        currentPageId: figma.currentPage.id, selection: figma.currentPage.selection.map(node => node.id) } });
  } else if (message.type === 'command') {
    let command;
    try {
      if (connectionGeneration === undefined) throw new Error('SESSION_EXPIRED');
      checkDocument();
      command = validateCommand(message, { sessionId, connectionGeneration });
      if (!['getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate', 'exportNode', ...(diagnostic ? ['applyBatch'] : [])].includes(command.command)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (reading) throw new Error('RESOURCE_LIMIT');
    } catch (error) { figma.ui.postMessage({ type: 'error', code: error instanceof Error && error.message === 'DOCUMENT_MISMATCH' ? 'DOCUMENT_MISMATCH' : 'INVALID_ARGUMENT' }); return; }
    reading = true;
    const scope = { sessionId, connectionGeneration };
    if (command.command === 'applyBatch' && diagnostic) {
      try {
        const data = await diagnostic.run(command, scope, () => { checkDocument(); if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED'); });
        figma.ui.postMessage({ type: 'operationResult', ...scope, operationId: command.operationId, data });
      } catch (error) { figma.ui.postMessage({ type: 'error', code: error instanceof Error && ['SESSION_EXPIRED', 'DOCUMENT_MISMATCH'].includes(error.message) ? error.message : 'INVALID_ARGUMENT' }); }
      finally { reading = false; }
      return;
    }
    const replyType = { getTree: 'treeResult', findNodes: 'searchResult', getNodes: 'nodesResult', getLocalResources: 'resourcesResult', navigate: 'navigateResult', exportNode: 'exportError' };
    const reply = { type: replyType[command.command as keyof typeof replyType], ...scope, operationId: command.operationId };
    try {
      if (command.command === 'exportNode') {
        const query = command.params as { nodeId: string; format: 'PNG' | 'SVG'; scale?: number };
        const check = () => { checkDocument(); if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED'); };
        const chunkBytes = chunkSizeFor({ ...scope, operationId: command.operationId }, limits);
        await exportNode(figma, query, limits, check, chunkBytes,
          data => {
            const message = { ...scope, operationId: command.operationId, ...data };
            if (encodeURI(JSON.stringify(message)).replace(/%[A-F\d]{2}/g, 'x').length > limits.maxMessageBytes) throw new Error('RESOURCE_LIMIT');
            figma.ui.postMessage(message);
          }, scheduler.wait);
        return;
      }
      if (command.command === 'navigate') {
        const query = command.params as { pageId?: string; nodeIds: string[]; select: boolean; reveal: boolean };
        if (query.nodeIds.length > limits.maxNodes) throw new Error('RESOURCE_LIMIT');
        const data = await navigate(figma, query, () => { checkDocument(); if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED'); });
        figma.ui.postMessage({ ...reply, data });
        return;
      }
      if (command.command === 'getNodes') {
        const query = command.params as { nodeIds: string[]; fields: string[] };
        const data = await readNodes(figma, query.nodeIds, query.fields, limits.maxNodes, limits.maxResponseBytes, scheduler.wait);
        checkDocument(); if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED');
        figma.ui.postMessage({ ...reply, data });
        return;
      }
      if (command.command === 'getLocalResources') {
        const query = command.params as { kind: 'components' | 'styles' | 'collections' | 'variables'; ids?: string[]; fields: string[]; limit: number; cursor?: string };
        const revision = () => JSON.stringify([documentRevision, figma.root.children.map(page => [page.id, page.name])]);
        const data = await resources.read(figma, query, scope, Date.now(), revision,
          async page => { await page.loadAsync(); observe(page); }, scheduler.wait);
        checkDocument(); if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED');
        figma.ui.postMessage({ ...reply, data });
        return;
      }
      if (command.command === 'findNodes') {
        const query = command.params as { rootId?: string; document?: true; name?: string; types?: string[]; limit: number; cursor?: string };
        search.checkCursor(query, scope, Date.now());
        let resolved;
        try { resolved = query.rootId ? await loadDocumentRoot(figma, query.rootId) : undefined; }
        catch (error) { if (query.cursor && error instanceof Error && error.message === 'NODE_NOT_FOUND') throw new Error('INVALID_CURSOR'); throw error; }
        if (resolved) observe(resolved.page);
        const revision = () => JSON.stringify([documentRevision, figma.root.children.map(page => [page.id, page.name])]);
        const data = await search.read(figma.root.children, resolved?.root, resolved?.page.id, query, scope, revision, Date.now(),
          async page => { const target = page as PageNode; await target.loadAsync(); observe(target); }, scheduler.wait);
        checkDocument(); if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED');
        figma.ui.postMessage({ ...reply, data });
        return;
      }
      const query = command.params as { rootId: string; depth: number; limit: number; cursor?: string };
      pager.checkCursor(query, scope, Date.now());
      let resolved;
      try { resolved = await loadDocumentRoot(figma, query.rootId); }
      catch (error) { if (query.cursor && error instanceof Error && error.message === 'NODE_NOT_FOUND') throw new Error('INVALID_CURSOR'); throw error; }
      const { root, page } = resolved;
      checkDocument(); if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED');
      const revision = observe(page);
      const data = await pager.read(root, query, scope, () => JSON.stringify([revision.value, page.name]), Date.now(), { yieldControl: scheduler.wait });
      checkDocument(); if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED');
      figma.ui.postMessage({ ...reply, data });
    } catch (error) {
      const code = error instanceof Error && ['SESSION_EXPIRED', 'DOCUMENT_MISMATCH', 'NODE_NOT_FOUND', 'INVALID_CURSOR', 'INVALID_ARGUMENT', 'RESOURCE_LIMIT'].includes(error.message) ? error.message : 'FIGMA_API_ERROR';
      const recoveryAction = command.command === 'exportNode' && code === 'RESOURCE_LIMIT' ?
        'Уменьшите область экспорта или масштаб и повторите запрос.' : 'Перечитайте контекст и начните чтение заново.';
      figma.ui.postMessage({ ...reply, error: { code, message: 'Не удалось прочитать документ.', recoveryAction } });
    } finally { reading = false; }
  }
};
}
