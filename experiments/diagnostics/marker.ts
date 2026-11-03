import { BatchExecutor } from '../../shared/batch-executor';
import { OperationJournal } from '../../shared/operation-journal';
import { pageOperations } from '../../plugin/scene-ops';

export const MARKER_NAME = 'FIGMA_MCP_DIAGNOSTIC_MARKER';
export function markerStep(pageId: string) {
  return { stepId: 'diagnostic-marker', op: 'createNode', type: 'RECTANGLE', parent: { nodeId: pageId },
    properties: { name: MARKER_NAME, width: 40, height: 40 } };
}

export function createMarkerProbe(api: PluginAPI) {
  let used = false;
  return { async run(command: any, scope: { sessionId: string; connectionGeneration: number }, checkScope: () => void) {
    const pageId = api.currentPage.id;
    const steps = command.params?.steps;
    if (used || JSON.stringify(steps) !== JSON.stringify([markerStep(pageId)])) throw new Error('INVALID_ARGUMENT');
    used = true;
    const check = (candidate: typeof scope) => {
      checkScope();
      if (candidate.sessionId !== scope.sessionId || candidate.connectionGeneration !== scope.connectionGeneration || api.currentPage.id !== pageId) throw new Error('SESSION_EXPIRED');
    };
    const executor = new BatchExecutor(new OperationJournal({ dedupTtl: 60000, clockSkew: 5000, maxJournalEntries: 1 }),
      { ...pageOperations(api), checkScope: check, commitUndo: () => api.commitUndo() }, 1);
    return executor.submit(scope, command.operationId, steps, Date.now());
  } };
}
