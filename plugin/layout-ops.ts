import { stepSchema } from '../shared/contracts';
import type { BatchStep } from '../shared/batch-refs';

type Api = { getNodeByIdAsync(id: string): Promise<any> };
type Changes = { nodeIds: string[]; resourceIds: string[] };
const layoutFields = ['layoutMode', 'layoutWrap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'itemSpacing', 'counterAxisSpacing', 'primaryAxisAlignItems', 'counterAxisAlignItems'] as const;
const modes = ['HORIZONTAL', 'VERTICAL'];

export function layoutOperations(api: Api) {
  let node: any;
  let schemaStep: BatchStep;
  let related = new Map<string, any>();
  async function find(id: string) {
    const result = await api.getNodeByIdAsync(id);
    if (!result || result.removed) throw new Error('NODE_NOT_FOUND');
    if (result.type === 'PAGE') await result.loadAsync();
    return result;
  }
  function projection(target: any, expected: Record<string, any>) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(expected)) {
      if (key === 'parentId') out[key] = target.parent?.id;
      else if (key === 'children' && 'children' in target) out[key] = target.children.map((child: any) => child.id);
      else if (key === 'layout' && expected.layout && typeof expected.layout === 'object') {
        const layout: Record<string, unknown> = {};
        for (const field of Object.keys(expected.layout)) {
          if (!(layoutFields as readonly string[]).includes(field) || !(field in target)) throw new Error('CAPABILITY_UNAVAILABLE');
          layout[field] = target[field];
        }
        out.layout = layout;
      } else if (['name', 'x', 'y', 'width', 'height', 'rotation', 'visible', 'locked', 'constraints',
        'layoutSizingHorizontal', 'layoutSizingVertical', 'boundVariables'].includes(key) && key in target && typeof target[key] !== 'symbol') out[key] = target[key];
      else throw new Error('CAPABILITY_UNAVAILABLE');
    }
    return out;
  }
  function validate(step: BatchStep) {
    if (!stepSchema.safeParse(schemaStep).success) throw new Error('INVALID_ARGUMENT');
    if (!node || node.removed) throw new Error('NODE_NOT_FOUND');
    if (!node.parent || node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error('INVALID_ARGUMENT');
    const bindings = node.boundVariables ?? {};
    if (step.op === 'setConstraints') {
      if (!('constraints' in node)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (['HORIZONTAL', 'VERTICAL', 'GRID'].includes(node.parent.layoutMode) && node.layoutPositioning !== 'ABSOLUTE') throw new Error('CAPABILITY_UNAVAILABLE');
      return;
    }
    if (step.op === 'setAutoLayout') {
      const layout = step.layout as Record<string, any>;
      const fields = Object.keys(layout);
      if (!fields.length || !('layoutMode' in node) || !fields.every(key => (layoutFields as readonly string[]).includes(key) && key in node)) throw new Error('CAPABILITY_UNAVAILABLE');
      const mode = layout.layoutMode ?? node.layoutMode;
      if (fields.some(key => key !== 'layoutMode') && !modes.includes(mode)) throw new Error('INVALID_ARGUMENT');
      if (mode === 'VERTICAL' && (layout.counterAxisAlignItems ?? node.counterAxisAlignItems) === 'BASELINE') throw new Error('INVALID_ARGUMENT');
      const wrap = layout.layoutWrap ?? node.layoutWrap;
      if ('counterAxisSpacing' in layout && (wrap !== 'WRAP' || layout.counterAxisSpacing <= 0)) throw new Error('INVALID_ARGUMENT');
      if (layout.layoutMode !== undefined && layout.layoutMode !== node.layoutMode && Object.keys(bindings).length) throw new Error('CAPABILITY_UNAVAILABLE');
      if (fields.some(key => bindings[key] !== undefined) || layout.layoutWrap === 'NO_WRAP' && bindings.counterAxisSpacing) throw new Error('CAPABILITY_UNAVAILABLE');
      return;
    }
    if (step.op === 'setLayoutSizing') {
      const sizing = step.sizing as { horizontal: string; vertical: string };
      if (!('layoutSizingHorizontal' in node) || !('layoutSizingVertical' in node)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (bindings.width || bindings.height) throw new Error('CAPABILITY_UNAVAILABLE');
      for (const value of [sizing.horizontal, sizing.vertical]) {
        if (value === 'HUG' && node.type !== 'TEXT' && !modes.includes(node.layoutMode)) throw new Error('INVALID_ARGUMENT');
        if (value === 'FILL' && (!['HORIZONTAL', 'VERTICAL', 'GRID'].includes(node.parent.layoutMode) || node.layoutPositioning === 'ABSOLUTE')) throw new Error('INVALID_ARGUMENT');
      }
      return;
    }
    throw new Error('CAPABILITY_UNAVAILABLE');
  }
  return {
    async prepare(step: BatchStep, original: BatchStep = step) {
      schemaStep = original;
      if (!['setConstraints', 'setAutoLayout', 'setLayoutSizing'].includes(step.op)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (!stepSchema.safeParse(schemaStep).success) throw new Error('INVALID_ARGUMENT');
      node = await find((step.target as { nodeId: string }).nodeId);
      validate(step);
      related = new Map();
      for (const id of Object.keys((step.expected as any)?.related ?? {})) related.set(id, await find(id));
    },
    async readExpected(step: BatchStep) {
      const { related: expectations, ...fields } = step.expected as Record<string, any>;
      const result = projection(node, fields);
      if (expectations) result.related = Object.fromEntries(Object.entries(expectations).map(([id, fields]) => [id, projection(related.get(id), fields as Record<string, unknown>)]));
      return result;
    },
    async execute(step: BatchStep, record: (change: Changes) => void) {
      validate(step);
      const changed = () => record({ nodeIds: [node.id], resourceIds: [] });
      if (step.op === 'setConstraints') { node.constraints = step.value; changed(); }
      else if (step.op === 'setAutoLayout') {
        const layout = step.layout as Record<string, any>;
        for (const key of layoutFields) if (key in layout) { node[key] = layout[key]; changed(); }
      } else {
        const sizing = step.sizing as { horizontal: string; vertical: string };
        node.layoutSizingHorizontal = sizing.horizontal; changed();
        node.layoutSizingVertical = sizing.vertical; changed();
      }
      return {};
    },
  };
}
