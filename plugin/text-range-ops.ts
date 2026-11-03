import type { BatchStep } from '../shared/batch-refs';

type Font = { family: string; style: string };
type Changes = { nodeIds: string[]; resourceIds: string[] };
type Api = { getNodeByIdAsync(id: string): Promise<any>; loadFontAsync(font: Font): Promise<void> };
const setters: Record<string, string> = { fontName: 'setRangeFontName', fontSize: 'setRangeFontSize', lineHeight: 'setRangeLineHeight', letterSpacing: 'setRangeLetterSpacing', textCase: 'setRangeTextCase', textDecoration: 'setRangeTextDecoration', fills: 'setRangeFills' };
const isFont = (value: any): value is Font => value && typeof value.family === 'string' && typeof value.style === 'string';
const splitPair = (text: string, i: number) => i > 0 && i < text.length && text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff && text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff;

export function textRangeOperations(figma: Api) {
  let node: any, related = new Map<string, any>(), snapshot = '';
  const find = async (id: string) => {
    const found = await figma.getNodeByIdAsync(id);
    if (!found || found.removed) throw new Error('NODE_NOT_FOUND');
    if (found.type === 'PAGE') await found.loadAsync();
    return found;
  };
  const current = () => {
    if (node.hasMissingFont) throw new Error('FONT_UNAVAILABLE');
    if (node.textStyleId || node.boundVariables && Object.keys(node.boundVariables).length) throw new Error('CAPABILITY_UNAVAILABLE');
    const segments = node.characters.length ? node.getStyledTextSegments(['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'fills', 'textStyleId', 'boundVariables']) : [];
    if (segments.some((s: any) => s.textStyleId || s.boundVariables && Object.keys(s.boundVariables).length)) throw new Error('CAPABILITY_UNAVAILABLE');
    const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
    if (!Array.isArray(fonts) || !fonts.length || fonts.some((font: any) => !isFont(font))) throw new Error('FONT_UNAVAILABLE');
    return { fonts: fonts as Font[], signature: JSON.stringify([node.characters, segments, fonts]) };
  };
  const validate = (step: BatchStep) => {
    if (node.removed) throw new Error('NODE_NOT_FOUND');
    const start = step.start as number, end = step.end as number, length = node.characters.length;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > length || splitPair(node.characters, start) || splitPair(node.characters, end)) throw new Error('INVALID_ARGUMENT');
    if (step.op === 'formatTextRange') {
      if (Object.keys(step.format as object).some(key => !(key in setters))) throw new Error('CAPABILITY_UNAVAILABLE');
    } else {
      const insertion = step.insertionFormatting as any;
      if (step.text && (insertion.inherit === 'BEFORE' && start === 0 || insertion.inherit === 'AFTER' && end === length)) throw new Error('INVALID_ARGUMENT');
    }
    const patch = step.op === 'formatTextRange' ? step.format as Record<string, unknown> : (step.insertionFormatting as any).format;
    if (patch && Object.keys(patch).some(key => !(key in setters) || typeof node[setters[key]] !== 'function')) throw new Error('CAPABILITY_UNAVAILABLE');
  };
  const project = (target: any, expected: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(expected)) {
      if (key === 'parentId') result[key] = target.parent?.id;
      else if (key === 'children' && 'children' in target) result[key] = target.children.map((child: any) => child.id);
      else if (['name', 'characters', 'fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'textStyleId', 'boundVariables'].includes(key) && key in target && typeof target[key] !== 'symbol') result[key] = target[key];
      else throw new Error('CAPABILITY_UNAVAILABLE');
    }
    return result;
  };
  return {
    async prepare(step: BatchStep) {
      if (!['formatTextRange', 'replaceTextRange'].includes(step.op)) throw new Error('CAPABILITY_UNAVAILABLE');
      node = await find((step.target as { nodeId: string }).nodeId);
      if (node.type !== 'TEXT') throw new Error('INVALID_ARGUMENT');
      validate(step);
      const state = current(); snapshot = state.signature;
      const needed = [...state.fonts];
      const newFont = step.op === 'formatTextRange' ? (step.format as any).fontName : (step.insertionFormatting as any).format?.fontName;
      if (newFont && !needed.some(font => font.family === newFont.family && font.style === newFont.style)) needed.push(newFont);
      for (const font of needed.filter((font, i) => needed.findIndex(other => font.family === other.family && font.style === other.style) === i)) {
        try { await figma.loadFontAsync(font); } catch { throw new Error('FONT_UNAVAILABLE'); }
      }
      related = new Map();
      for (const id of Object.keys((step.expected as any)?.related ?? {})) related.set(id, await find(id));
    },
    async readExpected(step: BatchStep) {
      const { related: expectations, ...expected } = step.expected as Record<string, any>;
      const result = project(node, expected);
      if (expectations) result.related = Object.fromEntries(Object.entries(expectations).map(([id, fields]) => [id, project(related.get(id), fields as Record<string, unknown>)]));
      return result;
    },
    async execute(step: BatchStep, record: (changes: Changes) => void) {
      validate(step);
      if (current().signature !== snapshot) throw new Error('CONFLICT');
      const changed = () => record({ nodeIds: [node.id], resourceIds: [] });
      const start = step.start as number, end = step.end as number;
      if (step.op === 'replaceTextRange') {
        const insertion = step.insertionFormatting as any;
        const inherited = insertion.inherit ?? (end < node.characters.length ? 'AFTER' : start > 0 ? 'BEFORE' : undefined);
        if (end > start) { node.deleteCharacters(start, end); changed(); }
        if (step.text) {
          node.insertCharacters(start, step.text, inherited); changed();
          if (insertion.format) for (const [key, value] of Object.entries(insertion.format)) { node[setters[key]](start, start + (step.text as string).length, value); changed(); }
        }
      } else if (end > start) {
        for (const [key, value] of Object.entries(step.format as Record<string, unknown>)) { node[setters[key]](start, end, value); changed(); }
      }
      return {};
    },
  };
}
