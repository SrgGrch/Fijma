import { PROTOCOL_VERSION, welcomeSchema, validateCommand, jsonMessageBytes } from '../shared/protocol';
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
import { BatchExecutor } from '../shared/batch-executor';
import { OperationJournal } from '../shared/operation-journal';
import { writeOperations } from './write-operations';
import { verifyWrite } from './write-verification';
import { ExecutionQueue } from '../shared/execution-queue';
import { TrustedExecution } from './trusted-execution';

export function createBridgeRuntime(diagnostic?: { run: (command: any, scope: { sessionId: string; connectionGeneration: number }, checkScope: () => void) => Promise<unknown> }, candidate = false) {
const documentRoot = figma.root;
const checkDocument = () => { if (figma.root !== documentRoot) throw new Error('DOCUMENT_MISMATCH'); };
const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let awaitingWelcome = false;
let connectionGeneration: number | undefined;
const capabilities = ['getContext', 'getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate', 'exportNode', ...(diagnostic ? ['applyBatch'] : candidate ? ['applyBatch', 'getOperation', 'cancel', 'execute'] : [])];
let writeEnabled = false;
let executeEnabled = false;
let limits = bootstrapLimits;
const operations = writeOperations(figma, () => limits, () => scheduler.wait());
let previousParents: string[] = [];
let previousGroups: string[] = [];
const journal = new OperationJournal(bootstrapLimits);
const queue = new ExecutionQueue(bootstrapLimits.maxQueuedOperations);
const executor = new BatchExecutor(journal, {
  ...operations,
  yieldControl: () => scheduler.wait(),
  async prepare(step, original, guard) {
    await operations.prepare(step, original, guard);
    guard?.();
    checkDocument();
    previousParents = []; previousGroups = [];
    for (const reference of [step.target, step.pageId, step.parent, ...((step.targets as unknown[]) ?? [])]) {
      const id = (reference as { nodeId?: string } | undefined)?.nodeId;
      if (!id) continue;
      const node = await figma.getNodeByIdAsync(id);
      guard?.();
      checkDocument();
      for (let parent = node?.parent; parent; parent = parent.parent) { previousParents.push(parent.id); if (parent.type === 'GROUP') previousGroups.push(parent.id); }
      if (reference === step.parent) previousParents.push(id);
    }
  },
  checkScope(scope) { checkDocument(); if (scope.sessionId !== sessionId || scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED'); if (!writeEnabled) throw new Error('WRITE_DISABLED'); },
  async verify(step, changes, stepCount) {
    return verifyWrite(figma, step, changes, previousParents, { ...limits, maxBatchSteps: stepCount }, checkDocument, previousGroups);
  },
  commitUndo() { checkDocument(); figma.commitUndo(); },
}, bootstrapLimits.maxQueuedOperations, queue);
const trusted = new TrustedExecution(journal, queue, {
  figma,
  checkScope(scope) { checkDocument(); if (scope.sessionId !== sessionId || scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED'); if (!executeEnabled) throw new Error('EXECUTION_DISABLED'); },
  yieldControl: () => scheduler.wait(),
  commitUndo: () => figma.commitUndo(),
}, bootstrapLimits.maxQueuedOperations, bootstrapLimits.operationTimeout);
const snapshot = (operationId: string, scope: { sessionId: string; connectionGeneration: number }, value: any) => value.result ?? { operationId, ...scope, status: value.status, steps: [], affectedNodeIds: [], affectedResourceIds: [], warnings: [] };
const executeSnapshot = (operationId: string, scope: { sessionId: string; connectionGeneration: number }, value: any) => value.result ?? { operationId, ...(journal.scope(operationId) as typeof scope ?? scope), kind: 'execute', status: value.status, effects: value.status === 'queued' ? 'none' : 'unknown', logs: [], logsTruncated: false, warnings: [] };
const scheduler = createUIYield(message => figma.ui.postMessage(message));
let pager = new TreePager({ maxDepth: 8, maxNodes: 1000, maxResponseBytes: 32768, chunkSize: 50 }, 100, 60000);
let search = new SearchPager({ maxDepth: 8, maxNodes: 1000, maxResponseBytes: 32768, chunkSize: 50 }, 100, 60000);
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
  if (message.type === 'setWriteEnabled' && typeof message.enabled === 'boolean' && Object.keys(message).length === 2) {
    writeEnabled = candidate && message.enabled && connectionGeneration !== undefined;
    if (!writeEnabled) executor.stop();
    figma.ui.postMessage({ type: 'writeState', enabled: writeEnabled, ...(!writeEnabled && message.enabled ? { reason: 'CAPABILITY_UNAVAILABLE' } : {}) });
    return;
  }
  if (message.type === 'setExecuteEnabled' && typeof message.enabled === 'boolean' && Object.keys(message).length === 2) {
    executeEnabled = candidate && message.enabled && connectionGeneration !== undefined;
    if (!executeEnabled) queue.stop('execute');
    figma.ui.postMessage({ type: 'executeState', enabled: executeEnabled, ...(!executeEnabled && message.enabled ? { reason: 'CAPABILITY_UNAVAILABLE' } : {}) });
    return;
  }
  if (message.type === 'stop' && Object.keys(message).length === 1) {
    writeEnabled = false; executeEnabled = false; queue.stop(); figma.ui.postMessage({ type: 'writeState', enabled: false }); figma.ui.postMessage({ type: 'executeState', enabled: false }); return;
  }
  if (message.type === 'hello-request' && Object.keys(message).length === 1) {
    awaitingWelcome = true;
    writeEnabled = false; executeEnabled = false; queue.stop();
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
    writeEnabled = false; executeEnabled = false; queue.stop();
    connectionGeneration = undefined;
    pager.clear(); search.clear(); resources.clear(); scheduler.release();
  } else if (message.type === 'getContext') {
    if (queue.hasExecute) { figma.ui.postMessage({ type: 'error', code: 'RESOURCE_LIMIT' }); return; }
    if (jsonMessageBytes(message) > limits.maxMessageBytes) { figma.ui.postMessage({ type: 'error', code: 'RESOURCE_LIMIT' }); return; }
    const request = contextRequestSchema.safeParse(message);
    if (!request.success || request.data.sessionId !== sessionId || request.data.connectionGeneration !== connectionGeneration) {
      figma.ui.postMessage({ type: 'error', code: 'SESSION_EXPIRED' });
      return;
    }
    try { checkDocument(); } catch { figma.ui.postMessage({ type: 'error', code: 'DOCUMENT_MISMATCH' }); return; }
    figma.ui.postMessage({ type: 'context', requestId: request.data.requestId, sessionId, connectionGeneration,
      document: { documentLabel: figma.root.name, ...(typeof figma.editorType === 'string' ? { editorType: figma.editorType } : {}), pages: figma.root.children.map(page => ({ id: page.id, name: page.name })),
        currentPageId: figma.currentPage.id, selection: figma.currentPage.selection.map(node => node.id) } });
  } else if (message.type === 'command') {
    let command;
    try {
      if (connectionGeneration === undefined) throw new Error('SESSION_EXPIRED');
      checkDocument();
      command = validateCommand(message, { sessionId, connectionGeneration });
      if (!['getTree', 'findNodes', 'getNodes', 'getLocalResources', 'navigate', 'exportNode', ...(diagnostic ? ['applyBatch'] : candidate ? ['applyBatch', 'getOperation', 'cancel', 'execute'] : [])].includes(command.command)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (reading && !['applyBatch', 'getOperation', 'cancel'].includes(command.command) || queue.hasExecute && !['applyBatch', 'getOperation', 'cancel', 'execute'].includes(command.command)) throw new Error('RESOURCE_LIMIT');
    } catch (error) { figma.ui.postMessage({ type: 'error', code: error instanceof Error && ['DOCUMENT_MISMATCH', 'SESSION_EXPIRED', 'RESOURCE_LIMIT', 'CAPABILITY_UNAVAILABLE'].includes(error.message) ? error.message : 'INVALID_ARGUMENT' }); return; }
    const scope = { sessionId, connectionGeneration };
    if (candidate && ['applyBatch', 'getOperation', 'cancel', 'execute'].includes(command.command)) {
      try {
        if (jsonMessageBytes(message) > limits.maxMessageBytes) throw new Error('RESOURCE_LIMIT');
        let data;
        if (command.command === 'applyBatch') {
          const steps = (command.params as { steps: unknown[] }).steps;
          if (steps.length > limits.maxBatchSteps) throw new Error('RESOURCE_LIMIT');
          data = await executor.submit(scope, command.operationId, steps, Date.now());
          if (data && 'fresh' in data) data = snapshot(command.operationId, scope, data);
        } else if (command.command === 'execute') {
          data = await trusted.submit(scope, command.operationId, command.params as any, Date.now());
          if (data && 'fresh' in data) data = executeSnapshot(command.operationId, scope, data);
        } else {
          const value = command.command === 'cancel' ? executor.cancel(command.operationId) : executor.get(command.operationId);
          data = journal.kind(command.operationId) === 'figma_execute' ? executeSnapshot(command.operationId, scope, value) : snapshot(command.operationId, scope, value);
        }
        if (scope.connectionGeneration === connectionGeneration) {
          const envelope = { ...scope, operationId: command.operationId, ...(message.requestId ? { requestId: message.requestId } : {}) };
          if (data?.kind === 'execute') {
            try {
              if ('value' in data && jsonMessageBytes({ type: 'operationResult', ...envelope, data }) > limits.maxResponseBytes) {
                if (!message.requestId) throw new Error('RESOURCE_LIMIT');
                const { value, ...metadata } = data;
                const pending = { ...metadata, valueResourcePending: true };
                if (jsonMessageBytes({ type: 'operationResult', ...envelope, data: pending }) > limits.maxResponseBytes) throw new Error('RESOURCE_LIMIT');
                const encoded = unescape(encodeURIComponent(JSON.stringify(value)));
                const bytes = Uint8Array.from(encoded, c => c.charCodeAt(0));
                const chunkBytes = Math.min(12288, Math.floor((limits.maxMessageBytes - jsonMessageBytes({ type: 'executionChunk', ...envelope, index: 999999, total: 999999, data: '' })) / 4) * 3);
                if (chunkBytes < 3) throw new Error('RESOURCE_LIMIT');
                const total = Math.ceil(bytes.length / chunkBytes);
                figma.ui.postMessage({ type: 'executionStart', ...envelope, bytes: bytes.length, total, chunkBytes });
                for (let index = 0; index < total; index++) figma.ui.postMessage({ type: 'executionChunk', ...envelope, index, total, data: figma.base64Encode(bytes.slice(index * chunkBytes, (index + 1) * chunkBytes)) });
                data = pending;
              }
              if (jsonMessageBytes({ type: 'operationResult', ...envelope, data }) > limits.maxResponseBytes) throw new Error('RESOURCE_LIMIT');
            } catch {
              data = { operationId: command.operationId, ...scope, kind: 'execute', status: 'unknown', effects: 'unknown', logs: [], logsTruncated: true, warnings: [],
                error: { code: 'RESOURCE_LIMIT', phase: 'transfer', message: 'Execution result could not be transferred.', recoveryAction: 'Inspect the document and operation status before retrying.' } };
            }
          }
          figma.ui.postMessage({ type: 'operationResult', ...envelope, data });
        }
      } catch (error) {
        const code = error instanceof Error && ['EXECUTION_DISABLED', 'WRITE_DISABLED', 'SESSION_EXPIRED', 'DOCUMENT_MISMATCH', 'RESOURCE_LIMIT', 'OPERATION_ID_CONFLICT', 'OPERATION_EXPIRED', 'CAPABILITY_UNAVAILABLE'].includes(error.message) ? error.message : 'INVALID_ARGUMENT';
        figma.ui.postMessage({ type: 'operationResult', ...scope, operationId: command.operationId, ...(message.requestId ? { requestId: message.requestId } : {}), data: { error: { code, message: code, recoveryAction: 'Check operation and document state.' } } });
      }
      return;
    }
    reading = true;
    if (command.command === 'applyBatch' && diagnostic) {
      try {
        if (jsonMessageBytes(message) > limits.maxMessageBytes) throw new Error('RESOURCE_LIMIT');
        const data = await diagnostic.run(command, scope, () => { checkDocument(); if (scope.connectionGeneration !== connectionGeneration) throw new Error('SESSION_EXPIRED'); });
        figma.ui.postMessage({ type: 'operationResult', ...scope, operationId: command.operationId, ...(message.requestId ? { requestId: message.requestId } : {}), data });
      } catch (error) { figma.ui.postMessage({ type: 'error', code: error instanceof Error && ['SESSION_EXPIRED', 'DOCUMENT_MISMATCH', 'RESOURCE_LIMIT'].includes(error.message) ? error.message : 'INVALID_ARGUMENT' }); }
      finally { reading = false; }
      return;
    }
    const replyType = { getTree: 'treeResult', findNodes: 'searchResult', getNodes: 'nodesResult', getLocalResources: 'resourcesResult', navigate: 'navigateResult', exportNode: 'exportError' };
    const reply = { type: replyType[command.command as keyof typeof replyType], ...scope, operationId: command.operationId };
    try {
      if (jsonMessageBytes(message) > limits.maxMessageBytes) throw new Error('RESOURCE_LIMIT');
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
