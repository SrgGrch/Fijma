import type { BatchStep } from '../shared/batch-refs';
import { unavailableFonts } from './text-links';

type Font = { family: string; style: string };
type GeometryApi = { getNodeByIdAsync(id: string): Promise<any>; loadFontAsync(font: Font): Promise<void>; hasMissingFont?: boolean };
type Changes = { nodeIds: string[]; resourceIds: string[] };

// Coordinates are relative to the node's current parent.
export function geometryOperations(figma: GeometryApi) {
  let node: any;
  let textFonts = '';
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
    if (size && node.type !== 'TEXT' && figma.hasMissingFont) throw new Error('FONT_UNAVAILABLE');
    if (step.position && node.parent?.layoutMode && node.parent.layoutMode !== 'NONE' && node.layoutPositioning !== 'ABSOLUTE') throw new Error('CAPABILITY_UNAVAILABLE');
  }
  return {
    async prepare(step: BatchStep) {
      if (step.op !== 'setGeometry') throw new Error('CAPABILITY_UNAVAILABLE');
      node = await find((step.target as { nodeId: string }).nodeId);
      if (!('x' in node) || typeof node.resize !== 'function') throw new Error('CAPABILITY_UNAVAILABLE');
      validate(step);
      textFonts = '';
      if (step.size && node.type === 'TEXT') {
        const fonts = readFonts();
        textFonts = JSON.stringify([node.characters, fonts]);
        const missing: Font[] = [];
        for (const font of fonts.filter((font, i) => fonts.findIndex(other => font.family === other.family && font.style === other.style) === i)) {
          try { await figma.loadFontAsync(font); } catch { missing.push(font); }
        }
        if (missing.length) throw unavailableFonts(missing);
        if (node.hasMissingFont) throw new Error('FONT_UNAVAILABLE');
      }
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
      if (step.size && node.type === 'TEXT') {
        if (node.hasMissingFont) throw new Error('FONT_UNAVAILABLE');
        if (textFonts !== JSON.stringify([node.characters, readFonts()])) throw new Error('CONFLICT');
      }
      const changed = () => record({ nodeIds: [node.id], resourceIds: [] });
      const position = step.position as { x: number; y: number } | undefined;
      const size = step.size as { width: number; height: number } | undefined;
      if (position) { node.x = position.x; changed(); node.y = position.y; changed(); }
      if (size) { node.resize(size.width, size.height); changed(); }
      if (step.rotation !== undefined) { node.rotation = step.rotation; changed(); }
      return {};
    },
  };

  function readFonts(): Font[] {
    let fonts: any;
    try { fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName]; }
    catch { throw new Error('FONT_UNAVAILABLE'); }
    if (!Array.isArray(fonts) || !fonts.length || fonts.some(font => !font || typeof font.family !== 'string' || typeof font.style !== 'string')) throw new Error('FONT_UNAVAILABLE');
    return fonts;
  }
}
