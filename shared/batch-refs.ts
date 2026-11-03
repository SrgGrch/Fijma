type ResourceKind = 'nodeId' | 'styleId' | 'collectionId' | 'modeId' | 'variableId';
type Ref = { nodeId: string } | { stepId: string; output: ResourceKind };
export type BatchStep = { stepId: string; op: string; [field: string]: unknown };

const outputs: Record<string, ResourceKind[]> = {
  createPage: ['nodeId'], renamePage: [], clonePage: ['nodeId'], movePage: [], deletePage: [],
  createNode: ['nodeId'], updateNode: [], cloneNode: ['nodeId'], deleteNode: [], moveNode: [],
  groupNodes: ['nodeId'], ungroupNode: [], setGeometry: [], setConstraints: [], setAutoLayout: [], setLayoutSizing: [],
  createText: ['nodeId'], setText: [], replaceTextRange: [], formatTextRange: [], setAppearance: [],
  importImage: ['nodeId'], importSvg: ['nodeId'], booleanNodes: ['nodeId'],
  createComponent: ['nodeId'], componentFromNode: ['nodeId'], combineVariants: ['nodeId'],
  setComponentProperties: [], createInstance: ['nodeId'], setInstanceProperties: [], swapVariant: [], detachInstance: ['nodeId'],
  createStyle: ['styleId'], updateStyle: [], applyStyle: [], unbindStyle: [], deleteStyle: [],
  createCollection: ['collectionId'], updateCollection: [], deleteCollection: [], createMode: ['modeId'], renameMode: [], deleteMode: [],
  createVariable: ['variableId'], updateVariable: [], deleteVariable: [], setVariableValue: [], setVariableAlias: [],
  bindVariable: [], unbindVariable: [], setNodeMode: [],
};
const fields: Record<string, ResourceKind> = {
  parent: 'nodeId', target: 'nodeId', targets: 'nodeId', pageId: 'nodeId', componentId: 'nodeId',
  styleId: 'styleId', collectionId: 'collectionId', modeId: 'modeId', variableId: 'variableId', targetVariableId: 'variableId',
};

// Complements operation schemas; it does not validate patches or live Figma state.
export function validateBatchRefs(steps: BatchStep[]) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('INVALID_ARGUMENT');
  const previous = new Map<string, ResourceKind[]>();
  const check = (value: unknown, kind: ResourceKind) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENT');
    const ref = value as Ref;
    const keys = Object.keys(ref);
    if ('nodeId' in ref) {
      if (kind !== 'nodeId' || keys.length !== 1 || typeof ref.nodeId !== 'string' || !ref.nodeId) throw new Error('INVALID_ARGUMENT');
      return;
    }
    if (keys.length !== 2 || !keys.includes('stepId') || !keys.includes('output') ||
      typeof ref.stepId !== 'string' || ref.output !== kind || !previous.get(ref.stepId)?.includes(kind)) throw new Error('INVALID_ARGUMENT');
  };
  for (const step of steps) {
    if (!step || typeof step !== 'object' || typeof step.stepId !== 'string' || !step.stepId || previous.has(step.stepId) ||
      typeof step.op !== 'string' || !Object.prototype.hasOwnProperty.call(outputs, step.op)) throw new Error('INVALID_ARGUMENT');
    for (const [field, kind] of Object.entries(fields)) {
      if (!(field in step)) continue;
      const value = step[field];
      if (field === 'targets') {
        if (!Array.isArray(value) || value.length === 0) throw new Error('INVALID_ARGUMENT');
        for (const ref of value) check(ref, kind);
      } else if (typeof value === 'string' && kind !== 'nodeId') {
        if (!value) throw new Error('INVALID_ARGUMENT');
      } else check(value, kind);
    }
    previous.set(step.stepId, outputs[step.op]);
  }
}
