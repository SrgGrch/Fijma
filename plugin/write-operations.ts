import type { BatchStep } from '../shared/batch-refs';
import { pageOperations } from './scene-ops';
import { textOperations } from './text-ops';
import { geometryOperations } from './geometry-ops';
import { textRangeOperations } from './text-range-ops';
import { layoutOperations } from './layout-ops';
import { structureOperations } from './structure-ops';
import { appearanceOperations, appearanceKeys, appearancePatch, preflightAppearance } from './appearance-ops';
import { graphicsOperations } from './graphics-ops';
import { componentOperations } from './component-ops';
import { styleOperations, stylePreflight } from './style-ops';
import { variableOperations } from './variable-ops';
import { bootstrapLimits } from '../shared/bootstrap-limits';

type Handler = { prepare(step: BatchStep, original?: BatchStep, guard?: () => void): Promise<void>; readExpected(step: BatchStep): Promise<Record<string, unknown>>; execute(step: BatchStep, record: (changes: { nodeIds: string[]; resourceIds: string[] }) => void): Promise<any> };

// A BatchExecutor executes one step at a time, so the selected handler stays fixed through the step.
export function writeOperations(figma: any, limits: () => { maxImportBytes: number; maxNodes: number } = () => bootstrapLimits, yieldControl: () => Promise<void> = async () => {}) {
  const scene = pageOperations(figma), text = textOperations(figma), geometry = geometryOperations(figma), ranges = textRangeOperations(figma), layout = layoutOperations(figma), structure = structureOperations(figma), appearance = appearanceOperations(figma), components = componentOperations(figma, limits, yieldControl), styles = styleOperations(figma);
  const graphicsOps = ['importImage', 'importSvg', 'booleanNodes'];
  const componentOps = ['createComponent', 'componentFromNode', 'combineVariants', 'setComponentProperties', 'createInstance', 'setInstanceProperties', 'swapVariant', 'detachInstance'];
  const styleOps = ['createStyle', 'updateStyle', 'applyStyle', 'unbindStyle', 'deleteStyle'];
  const variableOps = ['createCollection', 'updateCollection', 'deleteCollection', 'createMode', 'renameMode', 'deleteMode', 'createVariable', 'updateVariable', 'deleteVariable', 'setVariableValue', 'setVariableAlias', 'bindVariable', 'unbindVariable', 'setNodeMode'];
  const baseOps = ['movePage', 'moveNode', 'groupNodes', 'ungroupNode', 'createPage', 'renamePage', 'clonePage', 'deletePage', 'createNode', 'updateNode', 'cloneNode', 'deleteNode', 'setGeometry', 'setConstraints', 'setAutoLayout', 'setLayoutSizing', 'createText', 'setText', 'replaceTextRange', 'formatTextRange'];
  let current: Handler;
  return {
    preflight(step: BatchStep) {
      if (![...baseOps, ...graphicsOps, ...componentOps, ...styleOps, ...variableOps, 'setAppearance'].includes(step.op)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (graphicsOps.includes(step.op)) graphicsOperations(figma, limits()).preflight(step);
      if (step.op === 'setAppearance') appearance.preflight(step);
      if (componentOps.includes(step.op)) components.preflight(step);
      if (styleOps.includes(step.op)) stylePreflight(step, figma);
      if (step.op === 'createNode' || step.op === 'updateNode' || step.op === 'createText') {
        const props = (step.op === 'createText' ? step.typography : step.op === 'createNode' ? step.properties : step.patch) as Record<string, any>;
        const text = step.op === 'createText' || step.type === 'TEXT';
        const allowed = ['name', 'x', 'y', 'width', 'height', 'rotation', 'visible', 'locked', ...(step.op !== 'createText' ? appearanceKeys : []), ...(text ? ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration', 'textAutoResize', ...(step.op === 'createNode' ? ['characters'] : [])] : ['pointCount'])];
        if (Object.keys(props).some(key => !allowed.includes(key))) throw new Error('CAPABILITY_UNAVAILABLE');
        if (step.op !== 'createText') preflightAppearance(figma, appearancePatch(props));
        if (step.type === 'LINE' && props.height !== undefined || props.width !== undefined && props.width < 0.01 || props.height !== undefined && props.height < 0.01) throw new Error('INVALID_ARGUMENT');
        if (step.op === 'createNode' && text && !props.fontName && Object.keys(props).some(key => ['characters', 'fontSize', 'lineHeight', 'letterSpacing', 'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration', 'textAutoResize'].includes(key))) throw new Error('CAPABILITY_UNAVAILABLE');
        if (step.op === 'createText' && props.fontName && (props.fontName.family !== (step.font as any).family || props.fontName.style !== (step.font as any).style)) throw new Error('INVALID_ARGUMENT');
      }
      if (step.op === 'setGeometry' && step.size && ((step.size as any).width < 0.01 || (step.size as any).height < 0.01)) throw new Error('INVALID_ARGUMENT');
    },
    async prepare(step: BatchStep, original?: BatchStep, guard?: () => void) {
      current = graphicsOps.includes(step.op) ? graphicsOperations(figma, limits()) : componentOps.includes(step.op) ? components : styleOps.includes(step.op) ? styles : variableOps.includes(step.op) ? variableOperations(figma, limits().maxNodes) : step.op === 'setAppearance' ? appearance : ['movePage', 'moveNode', 'groupNodes', 'ungroupNode'].includes(step.op) ? structure : step.op === 'createText' || step.op === 'setText' || (step.op === 'createNode' || step.op === 'updateNode') && step.type === 'TEXT' ? text : step.op === 'setGeometry' ? geometry : ['setConstraints', 'setAutoLayout', 'setLayoutSizing'].includes(step.op) ? layout : step.op === 'replaceTextRange' || step.op === 'formatTextRange' ? ranges : scene;
      await current.prepare(step, original, guard);
    },
    readExpected(step: BatchStep) { return current.readExpected(step); },
    execute(step: BatchStep, record: (changes: { nodeIds: string[]; resourceIds: string[] }) => void) { return current.execute(step, record); },
  };
}
