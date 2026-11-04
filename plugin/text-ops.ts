import { appearanceKeys, appearancePatch, preflightAppearance, validateAppearance, applyAppearance } from './appearance-ops';
import { nodePreconditions } from './resource-expected';
import type { BatchStep } from '../shared/batch-refs';
import { checkTextPatch, unavailableFonts } from './text-links';

type Font = { family: string; style: string };
type Changes = { nodeIds: string[]; resourceIds: string[] };
type TextApi = { getNodeByIdAsync(id: string): Promise<any>; loadFontAsync(font: Font): Promise<void>; createText(): any };
const fields = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration', 'textAutoResize'];
const common = ['name', 'x', 'y', 'width', 'height', 'rotation', 'visible', 'locked'];
const sameFont = (a: Font, b: Font) => a.family === b.family && a.style === b.style;
const validFont = (font: any): font is Font => font && typeof font.family === 'string' && typeof font.style === 'string';

// The dispatcher must keep this handler for prepare, readExpected and execute of the same step.
export function textOperations(figma: TextApi) {
  let node: any, parent: any, original = '';
  const checks = nodePreconditions(figma);
  const find = async (id: string) => {
    const value = await figma.getNodeByIdAsync(id);
    if (!value || value.removed) throw new Error('NODE_NOT_FOUND');
    if (value.type === 'PAGE') await value.loadAsync();
    return value;
  };
  const fonts = () => {
    let list: any;
    try { list = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName]; }
    catch { throw new Error('FONT_UNAVAILABLE'); }
    if (!Array.isArray(list) || !list.length || list.some((font: any) => !validFont(font))) throw new Error('FONT_UNAVAILABLE');
    return list as Font[];
  };
  const segments = () => node.characters.length ? node.getStyledTextSegments(['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'fills', 'textStyleId', 'fillStyleId', 'boundVariables', 'textStyleOverrides']) : [];
  const signature = () => JSON.stringify([node.characters, segments(), node.textStyleId, node.fillStyleId, node.boundVariables, fonts()]);
  const checkBindings = (step: BatchStep) => {
    const spans = segments();
    if (step.op === 'setText') {
      if (node.boundVariables?.characters || typeof node.textStyleId === 'symbol' || typeof node.fillStyleId === 'symbol') throw new Error('CAPABILITY_UNAVAILABLE');
      if (!step.characters && (node.textStyleId || node.fillStyleId || Object.keys(node.boundVariables ?? {}).length)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (spans.some((span: any) => span.textStyleId !== node.textStyleId || span.fillStyleId && span.fillStyleId !== node.fillStyleId || span.textStyleOverrides?.length || Object.entries(span.boundVariables ?? {}).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(node.boundVariables?.[key])))) throw new Error('CAPABILITY_UNAVAILABLE');
    } else {
      const patch = step.patch as Record<string, unknown>;
      checkTextPatch(spans.length ? spans : [{ textStyleId: node.textStyleId, fillStyleId: node.fillStyleId, boundVariables: node.boundVariables }], patch);
      checkTextPatch([{ boundVariables: node.boundVariables }], patch);
    }
  };
  return {
    async prepare(step: BatchStep) {
      node = parent = undefined; checks.reset(); original = '';
      const creating = step.op === 'createText' || step.op === 'createNode' && step.type === 'TEXT';
      if (creating) {
        parent = await find((step.parent as { nodeId: string }).nodeId);
        if (!['PAGE', 'FRAME', 'GROUP', 'COMPONENT', 'SECTION'].includes(parent.type) || typeof parent.appendChild !== 'function') throw new Error('INVALID_ARGUMENT');
      } else if (step.op === 'setText' || step.op === 'updateNode' && step.type === 'TEXT') {
        node = await find((step.target as { nodeId: string }).nodeId);
        if (node.type !== 'TEXT') throw new Error('INVALID_ARGUMENT');
      } else throw new Error('CAPABILITY_UNAVAILABLE');
      const typography = (step.op === 'createText' ? step.typography : step.op === 'createNode' ? step.properties : step.op === 'setText' ? {} : step.patch) as Record<string, any>;
      if (Object.keys(typography).some(key => !fields.includes(key) && !common.includes(key) && !appearanceKeys.includes(key) && !(creating && key === 'characters'))) throw new Error('CAPABILITY_UNAVAILABLE');
      preflightAppearance(figma, appearancePatch(typography));
      if (node) validateAppearance(figma, node, appearancePatch(typography));
      if (typography.width !== undefined && typography.width < 0.01 || typography.height !== undefined && typography.height < 0.01) throw new Error('INVALID_ARGUMENT');
      const newFont = step.op === 'createText' ? step.font as Font : typography.fontName as Font | undefined;
      if (step.op === 'createNode' && !newFont && Object.keys(typography).some(key => fields.includes(key) || key === 'characters')) throw new Error('CAPABILITY_UNAVAILABLE');
      if (step.op === 'createText' && typography.fontName && !sameFont(newFont!, typography.fontName)) throw new Error('INVALID_ARGUMENT');
      const needed = node ? [...fonts()] : [];
      if (node) { checkBindings(step); original = signature(); }
      if (newFont && !needed.some(font => sameFont(font, newFont))) needed.push(newFont);
      const missing: Font[] = [];
      for (const font of needed.filter((f, i) => needed.findIndex(other => sameFont(f, other)) === i)) {
        try { await figma.loadFontAsync(font); } catch { missing.push(font); }
      }
      if (missing.length) throw unavailableFonts(missing);
      if (node?.hasMissingFont) throw new Error('FONT_UNAVAILABLE');
    },
    async readExpected(step: BatchStep) {
      return checks.read(node ?? parent, step.expected as Record<string, any>);
    },
    async execute(step: BatchStep, record: (changes: Changes) => void) {
      checks.verify();
      if (node?.removed || parent?.removed) throw new Error('NODE_NOT_FOUND');
      if (node) { if (node.hasMissingFont) throw new Error('FONT_UNAVAILABLE'); if (signature() !== original) throw new Error('CONFLICT'); checkBindings(step); }
      const changed = (target: any) => record({ nodeIds: [target.id], resourceIds: [] });
      const creating = step.op === 'createText' || step.op === 'createNode';
      const typography = (step.op === 'createText' ? step.typography : step.op === 'createNode' ? step.properties : step.op === 'setText' ? {} : step.patch) as Record<string, any>;
      if (node) validateAppearance(figma, node, appearancePatch(typography));
      else preflightAppearance(figma, appearancePatch(typography));
      if (creating) {
        node = figma.createText(); changed(node);
        parent.appendChild(node);
        const font = step.op === 'createText' ? step.font : typography.fontName;
        if (font) { node.fontName = font; changed(node); }
        const characters = step.op === 'createText' ? step.characters : typography.characters;
        if (characters !== undefined) { node.characters = characters; changed(node); }
      }
      if (step.op === 'setText') {
        const previousLength = node.characters.length;
        const value = step.characters as string;
        if (value) { node.insertCharacters(0, value, previousLength ? 'AFTER' : undefined); changed(node); }
        if (previousLength) { node.deleteCharacters(value.length, value.length + previousLength); changed(node); }
      }
      for (const key of ['name', 'x', 'y', 'rotation', 'visible']) if (key in typography) { node[key] = typography[key]; changed(node); }
      for (const key of fields) {
        if (key in typography && !(creating && key === 'fontName')) { node[key] = typography[key]; changed(node); }
      }
      if ('width' in typography || 'height' in typography) { node.resize(typography.width ?? node.width, typography.height ?? node.height); changed(node); }
      applyAppearance(node, appearancePatch(typography), changed);
      if ('locked' in typography) { node.locked = typography.locked; changed(node); }
      return creating ? { nodeId: node.id } : {};
    },
  };
}
