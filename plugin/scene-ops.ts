import type { BatchStep } from '../shared/batch-refs';

type Changes = { nodeIds: string[]; resourceIds: string[] };
type PageApi = {
  root: { children: readonly unknown[] };
  getNodeByIdAsync(id: string): Promise<any>;
  createPage(): any;
} & Record<string, any>;

// Page callbacks are intentionally separate from plugin main until session isolation is verified.
export function pageOperations(figma: PageApi) {
  let page: any;
  let parent: any;
  let related = new Map<string, any>();
  const find = async (id: string) => {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.removed) throw new Error('NODE_NOT_FOUND');
    if (node.type === 'PAGE') await node.loadAsync();
    return node;
  };
  const projection = (node: any, expected: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(expected)) {
      if (key === 'name') result.name = node.name;
      else if (key === 'parentId') result.parentId = node.parent?.id;
      else if (key === 'children' && 'children' in node) result.children = node.children.map((child: any) => child.id);
      else if (['x', 'y', 'width', 'height', 'rotation', 'visible', 'locked', 'characters', 'pointCount'].includes(key) && key in node && typeof node[key] !== 'symbol') result[key] = node[key];
      else throw new Error('CAPABILITY_UNAVAILABLE');
    }
    return result;
  };
  return {
    async prepare(step: BatchStep) {
      page = undefined;
      parent = undefined;
      related = new Map();
      if (!['createPage', 'renamePage', 'clonePage', 'deletePage', 'createNode', 'updateNode', 'cloneNode', 'deleteNode'].includes(step.op)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (['renamePage', 'clonePage', 'deletePage'].includes(step.op)) {
        const id = (step.pageId as { nodeId: string }).nodeId;
        page = await find(id);
        if (page.type !== 'PAGE') throw new Error('INVALID_ARGUMENT');
      }
      if (['updateNode', 'cloneNode', 'deleteNode'].includes(step.op)) {
        page = await find((step.target as { nodeId: string }).nodeId);
        if (!['FRAME', 'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'TEXT'].includes(page.type)) throw new Error('CAPABILITY_UNAVAILABLE');
        if (step.op === 'updateNode' && page.type !== step.type) throw new Error('INVALID_ARGUMENT');
      }
      if (step.op === 'createNode' || step.op === 'cloneNode') {
        parent = await find((step.parent as { nodeId: string }).nodeId);
        if (!['PAGE', 'FRAME', 'GROUP', 'COMPONENT', 'SECTION'].includes(parent.type) || typeof parent.appendChild !== 'function') throw new Error('INVALID_ARGUMENT');
        if (step.op === 'cloneNode' && step.index !== undefined && (step.index as number) > parent.children.length) throw new Error('INVALID_ARGUMENT');
      }
      if (step.op === 'createNode' || step.op === 'updateNode') {
        const props = (step.op === 'createNode' ? step.properties : step.patch) as Record<string, any>;
        const allowed = ['name', 'x', 'y', 'width', 'height', 'rotation', 'visible', 'locked', 'pointCount'];
        if (step.op === 'createNode' && step.type === 'TEXT') allowed.push('fontName', 'characters');
        if (Object.keys(props).some(key => !allowed.includes(key))) throw new Error('CAPABILITY_UNAVAILABLE');
        if (step.type === 'LINE' && props.height !== undefined || props.width !== undefined && props.width < 0.01 || props.height !== undefined && props.height < 0.01) throw new Error('INVALID_ARGUMENT');
        if (step.type === 'TEXT' && props.characters !== undefined && !props.fontName) throw new Error('CAPABILITY_UNAVAILABLE');
        if (props.fontName) {
          try { await figma.loadFontAsync(props.fontName); } catch { throw new Error('FONT_UNAVAILABLE'); }
        }
      }
      const expectations = (step.expected as any)?.related ?? {};
      for (const id of Object.keys(expectations)) related.set(id, await find(id));
    },
    async readExpected(step: BatchStep) {
      const { related: expectations, ...expected } = step.expected as Record<string, any>;
      const result = projection(page, expected);
      if (expectations) {
        result.related = Object.fromEntries(Object.entries(expectations).map(([id, fields]) => [id, projection(related.get(id), fields as Record<string, unknown>)]));
      }
      return result;
    },
    async execute(step: BatchStep, record: (change: Changes) => void) {
      const changed = (node: any) => record({ nodeIds: [node.id], resourceIds: [] });
      if (page?.removed || parent?.removed) throw new Error('NODE_NOT_FOUND');
      if (step.op === 'createPage') {
        const created = figma.createPage();
        changed(created);
        created.name = step.name;
        return { nodeId: created.id };
      }
      if (step.op === 'clonePage') {
        const created = page.clone();
        changed(created);
        if (step.name !== undefined) created.name = step.name;
        return { nodeId: created.id };
      }
      if (step.op === 'renamePage') {
        page.name = step.name;
        changed(page);
        return {};
      }
      if (step.op === 'deletePage') {
        if (figma.root.children.length <= 1) throw new Error('INVALID_ARGUMENT');
        const id = page.id;
        page.remove();
        record({ nodeIds: [id], resourceIds: [] });
        return {};
      }
      if (step.op === 'createNode' || step.op === 'cloneNode') {
        const factories: Record<string, string> = { FRAME: 'createFrame', RECTANGLE: 'createRectangle', ELLIPSE: 'createEllipse', LINE: 'createLine', POLYGON: 'createPolygon', STAR: 'createStar', TEXT: 'createText' };
        const created = step.op === 'cloneNode' ? page.clone() : figma[factories[step.type as string]]();
        changed(created);
        if (step.index !== undefined) parent.insertChild(step.index, created);
        else parent.appendChild(created);
        if (step.op === 'createNode') apply(created, step.properties as Record<string, any>, changed);
        return { nodeId: created.id };
      }
      if (step.op === 'updateNode') { apply(page, step.patch as Record<string, any>, changed); return {}; }
      if (step.op === 'deleteNode') { const id = page.id; page.remove(); record({ nodeIds: [id], resourceIds: [] }); return {}; }
      throw new Error('CAPABILITY_UNAVAILABLE');
    },
  };
}

function apply(node: any, props: Record<string, any>, changed: (node: any) => void) {
  for (const key of ['name', 'x', 'y', 'rotation', 'visible', 'pointCount', 'fontName', 'characters']) {
    if (key in props) { node[key] = props[key]; changed(node); }
  }
  if ('width' in props || 'height' in props) {
    node.resize(props.width ?? node.width, props.height ?? node.height);
    changed(node);
  }
  if ('locked' in props) { node.locked = props.locked; changed(node); }
}
