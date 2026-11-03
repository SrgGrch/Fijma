import type { BatchStep } from '../shared/batch-refs';

type Font = { family: string; style: string };
type Changes = { nodeIds: string[]; resourceIds: string[] };
type TextApi = { getNodeByIdAsync(id: string): Promise<any>; loadFontAsync(font: Font): Promise<void>; createText(): any };
const fields = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration', 'textAutoResize'];
const common = ['name', 'x', 'y', 'width', 'height', 'rotation', 'visible', 'locked'];
const sameFont = (a: Font, b: Font) => a.family === b.family && a.style === b.style;
const validFont = (font: any): font is Font => font && typeof font.family === 'string' && typeof font.style === 'string';

// The dispatcher must keep this handler for prepare, readExpected and execute of the same step.
export function textOperations(figma: TextApi) {
  let node: any, parent: any, related = new Map<string, any>(), original = '';
  const find = async (id: string) => {
    const value = await figma.getNodeByIdAsync(id);
    if (!value || value.removed) throw new Error('NODE_NOT_FOUND');
    if (value.type === 'PAGE') await value.loadAsync();
    return value;
  };
  const fonts = () => {
    if (node.hasMissingFont) throw new Error('FONT_UNAVAILABLE');
    const list = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
    if (!Array.isArray(list) || !list.length || list.some((font: any) => !validFont(font))) throw new Error('FONT_UNAVAILABLE');
    return list as Font[];
  };
  const signature = () => JSON.stringify([node.characters, fonts().map(font => [font.family, font.style]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  const checkBindings = () => {
    if (node.textStyleId || node.boundVariables && Object.keys(node.boundVariables).length) throw new Error('CAPABILITY_UNAVAILABLE');
    if (node.characters.length) {
      const segments = node.getStyledTextSegments(['textStyleId', 'boundVariables']);
      if (segments.some((segment: any) => segment.textStyleId || segment.boundVariables && Object.keys(segment.boundVariables).length)) throw new Error('CAPABILITY_UNAVAILABLE');
    }
  };
  const project = (target: any, expected: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(expected)) {
      if (key === 'parentId') result[key] = target.parent?.id;
      else if (key === 'children' && 'children' in target) result[key] = target.children.map((child: any) => child.id);
      else if (['name', 'characters', ...fields, 'textStyleId', 'boundVariables'].includes(key) && key in target && typeof target[key] !== 'symbol') result[key] = target[key];
      else throw new Error('CAPABILITY_UNAVAILABLE');
    }
    return result;
  };
  return {
    async prepare(step: BatchStep) {
      node = parent = undefined; related = new Map(); original = '';
      const creating = step.op === 'createText' || step.op === 'createNode' && step.type === 'TEXT';
      if (creating) {
        parent = await find((step.parent as { nodeId: string }).nodeId);
        if (!['PAGE', 'FRAME', 'GROUP', 'COMPONENT', 'SECTION'].includes(parent.type) || typeof parent.appendChild !== 'function') throw new Error('INVALID_ARGUMENT');
      } else if (step.op === 'updateNode' && step.type === 'TEXT') {
        node = await find((step.target as { nodeId: string }).nodeId);
        if (node.type !== 'TEXT') throw new Error('INVALID_ARGUMENT');
      } else throw new Error('CAPABILITY_UNAVAILABLE');
      const typography = (step.op === 'createText' ? step.typography : step.op === 'createNode' ? step.properties : step.patch) as Record<string, any>;
      if (Object.keys(typography).some(key => !fields.includes(key) && !common.includes(key) && !(creating && key === 'characters'))) throw new Error('CAPABILITY_UNAVAILABLE');
      if (typography.width !== undefined && typography.width < 0.01 || typography.height !== undefined && typography.height < 0.01) throw new Error('INVALID_ARGUMENT');
      const newFont = step.op === 'createText' ? step.font as Font : typography.fontName as Font | undefined;
      if (step.op === 'createNode' && !newFont && Object.keys(typography).some(key => fields.includes(key) || key === 'characters')) throw new Error('CAPABILITY_UNAVAILABLE');
      if (step.op === 'createText' && typography.fontName && !sameFont(newFont!, typography.fontName)) throw new Error('INVALID_ARGUMENT');
      const needed = node ? [...fonts()] : [];
      if (node) { checkBindings(); original = signature(); }
      if (newFont && !needed.some(font => sameFont(font, newFont))) needed.push(newFont);
      for (const font of needed.filter((f, i) => needed.findIndex(other => sameFont(f, other)) === i)) {
        try { await figma.loadFontAsync(font); } catch { throw new Error('FONT_UNAVAILABLE'); }
      }
      for (const id of Object.keys((step.expected as any)?.related ?? {})) related.set(id, await find(id));
    },
    async readExpected(step: BatchStep) {
      const { related: expectedRelated, ...expected } = step.expected as Record<string, any>;
      const result = project(node ?? parent, expected);
      if (expectedRelated) result.related = Object.fromEntries(Object.entries(expectedRelated).map(([id, fields]) => [id, project(related.get(id), fields as Record<string, unknown>)]));
      return result;
    },
    async execute(step: BatchStep, record: (changes: Changes) => void) {
      if (node?.removed || parent?.removed) throw new Error('NODE_NOT_FOUND');
      if (node) { checkBindings(); if (signature() !== original) throw new Error('CONFLICT'); }
      const changed = (target: any) => record({ nodeIds: [target.id], resourceIds: [] });
      const creating = step.op === 'createText' || step.op === 'createNode';
      const typography = (step.op === 'createText' ? step.typography : step.op === 'createNode' ? step.properties : step.patch) as Record<string, any>;
      if (creating) {
        node = figma.createText(); changed(node);
        parent.appendChild(node);
        const font = step.op === 'createText' ? step.font : typography.fontName;
        if (font) { node.fontName = font; changed(node); }
        const characters = step.op === 'createText' ? step.characters : typography.characters;
        if (characters !== undefined) { node.characters = characters; changed(node); }
      }
      for (const key of ['name', 'x', 'y', 'rotation', 'visible']) if (key in typography) { node[key] = typography[key]; changed(node); }
      for (const key of fields) {
        if (key in typography && !(creating && key === 'fontName')) { node[key] = typography[key]; changed(node); }
      }
      if ('width' in typography || 'height' in typography) { node.resize(typography.width ?? node.width, typography.height ?? node.height); changed(node); }
      if ('locked' in typography) { node.locked = typography.locked; changed(node); }
      return creating ? { nodeId: node.id } : {};
    },
  };
}
