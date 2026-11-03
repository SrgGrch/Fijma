import type { BatchStep } from '../shared/batch-refs';
import { pageOperations } from './scene-ops';
import { textOperations } from './text-ops';
import { geometryOperations } from './geometry-ops';
import { textRangeOperations } from './text-range-ops';
import { layoutOperations } from './layout-ops';

type Handler = { prepare(step: BatchStep, original?: BatchStep): Promise<void>; readExpected(step: BatchStep): Promise<Record<string, unknown>>; execute(step: BatchStep, record: (changes: { nodeIds: string[]; resourceIds: string[] }) => void): Promise<any> };

// A BatchExecutor executes one step at a time, so the selected handler stays fixed through the step.
export function writeOperations(figma: any) {
  const scene = pageOperations(figma), text = textOperations(figma), geometry = geometryOperations(figma), ranges = textRangeOperations(figma), layout = layoutOperations(figma);
  let current: Handler;
  return {
    preflight(step: BatchStep) {
      if (!['createPage', 'renamePage', 'clonePage', 'deletePage', 'createNode', 'updateNode', 'cloneNode', 'deleteNode', 'setGeometry', 'setConstraints', 'setAutoLayout', 'setLayoutSizing', 'createText', 'setText', 'replaceTextRange', 'formatTextRange'].includes(step.op)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (step.op === 'createNode' || step.op === 'updateNode' || step.op === 'createText') {
        const props = (step.op === 'createText' ? step.typography : step.op === 'createNode' ? step.properties : step.patch) as Record<string, any>;
        const text = step.op === 'createText' || step.type === 'TEXT';
        const allowed = ['name', 'x', 'y', 'width', 'height', 'rotation', 'visible', 'locked', ...(text ? ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration', 'textAutoResize', ...(step.op === 'createNode' ? ['characters'] : [])] : ['pointCount'])];
        if (Object.keys(props).some(key => !allowed.includes(key))) throw new Error('CAPABILITY_UNAVAILABLE');
        if (step.type === 'LINE' && props.height !== undefined || props.width !== undefined && props.width < 0.01 || props.height !== undefined && props.height < 0.01) throw new Error('INVALID_ARGUMENT');
        if (step.op === 'createNode' && text && !props.fontName && Object.keys(props).some(key => ['characters', 'fontSize', 'lineHeight', 'letterSpacing', 'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration', 'textAutoResize'].includes(key))) throw new Error('CAPABILITY_UNAVAILABLE');
        if (step.op === 'createText' && props.fontName && (props.fontName.family !== (step.font as any).family || props.fontName.style !== (step.font as any).style)) throw new Error('INVALID_ARGUMENT');
      }
      if (step.op === 'setGeometry' && step.size && ((step.size as any).width < 0.01 || (step.size as any).height < 0.01)) throw new Error('INVALID_ARGUMENT');
    },
    async prepare(step: BatchStep, original?: BatchStep) {
      current = step.op === 'createText' || step.op === 'setText' || (step.op === 'createNode' || step.op === 'updateNode') && step.type === 'TEXT' ? text : step.op === 'setGeometry' ? geometry : ['setConstraints', 'setAutoLayout', 'setLayoutSizing'].includes(step.op) ? layout : step.op === 'replaceTextRange' || step.op === 'formatTextRange' ? ranges : scene;
      await current.prepare(step, original);
    },
    readExpected(step: BatchStep) { return current.readExpected(step); },
    execute(step: BatchStep, record: (changes: { nodeIds: string[]; resourceIds: string[] }) => void) { return current.execute(step, record); },
  };
}
