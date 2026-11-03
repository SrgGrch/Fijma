import type { BatchStep } from '../shared/batch-refs';

type GeometryApi = { getNodeByIdAsync(id: string): Promise<any>; hasMissingFont?: boolean };
type Changes = { nodeIds: string[]; resourceIds: string[] };

// Coordinates are relative to the node's current parent.
export function geometryOperations(figma: GeometryApi) {
  let node: any;
  let related = new Map<string, any>();
  async function find(id: string) {
    const found = await figma.getNodeByIdAsync(id);
    if (!found || found.removed) throw new Error('NODE_NOT_FOUND');
    if (found.type === 'PAGE') await found.loadAsync();
    return found;
  }
  function projection(target: any, fields: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) {
      if (key === 'parentId') out[key] = target.parent?.id;
      else if (key === 'children' && 'children' in target) out[key] = target.children.map((child: any) => child.id);
      else if (['name', 'x', 'y', 'width', 'height', 'rotation', 'visible', 'locked'].includes(key) && key in target) out[key] = target[key];
      else throw new Error('CAPABILITY_UNAVAILABLE');
    }
    return out;
  }
  function validate(step: BatchStep) {
    if (node.removed) throw new Error('NODE_NOT_FOUND');
    if (node.boundVariables && Object.keys(node.boundVariables).length) throw new Error('CAPABILITY_UNAVAILABLE');
    const size = step.size as { width: number; height: number } | undefined;
    if (size && (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 0.01 || size.height < 0.01 || node.type === 'LINE')) throw new Error('INVALID_ARGUMENT');
    if (size && figma.hasMissingFont) throw new Error('FONT_UNAVAILABLE');
    if (step.position && node.parent?.layoutMode && node.parent.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE') throw new Error('CAPABILITY_UNAVAILABLE');
  }
  return {
    async prepare(step: BatchStep) {
      if (step.op !== 'setGeometry') throw new Error('CAPABILITY_UNAVAILABLE');
      node = await find((step.target as { nodeId: string }).nodeId);
      if (!('x' in node) || typeof node.resize !== 'function') throw new Error('CAPABILITY_UNAVAILABLE');
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
      const position = step.position as { x: number; y: number } | undefined;
      const size = step.size as { width: number; height: number } | undefined;
      if (position) { node.x = position.x; changed(); node.y = position.y; changed(); }
      if (size) { node.resize(size.width, size.height); changed(); }
      if (step.rotation !== undefined) { node.rotation = step.rotation; changed(); }
      return {};
    },
  };
}
