import type { BatchStep } from '../shared/batch-refs';
import { localResource, resourceExpected } from './resource-expected';
import { unavailableFonts } from './text-links';
import { normalizeAppearanceValue } from './appearance-ops';

const types: Record<string, string> = { fills: 'PAINT', strokes: 'PAINT', text: 'TEXT', effects: 'EFFECT', layoutGrids: 'GRID' };
const setters: Record<string, string> = { fills: 'setFillStyleIdAsync', strokes: 'setStrokeStyleIdAsync', text: 'setTextStyleIdAsync', effects: 'setEffectStyleIdAsync', layoutGrids: 'setGridStyleIdAsync' };
const textFields = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration'];
const hasBindings = (value: any): boolean => !!value && typeof value === 'object' && (Object.keys(value.boundVariables ?? {}).length > 0 || Object.values(value).some(hasBindings));

export function stylePreflight(step: BatchStep, api?: any) {
  const value = step.op === 'createStyle' ? step.value : (step.patch as any)?.value;
  if (value && typeof value === 'object' && !['paints', 'effects', 'layoutGrids'].some(key => key in value) && Object.keys(value).some(key => !textFields.includes(key))) throw new Error('CAPABILITY_UNAVAILABLE');
  for (const paint of (value as any)?.paints ?? []) if (paint.type === 'IMAGE' && (!api || !api.getImageByHash(paint.imageHash))) throw new Error('INVALID_ARGUMENT');
}

export function styleOperations(api: any) {
  let style: any, node: any;
  let kind: 'styles' | 'node';
  let snapshot: string;
  let guards: Array<() => boolean>, asyncGuards: Array<() => Promise<boolean>>;
  const value = (step: BatchStep) => (step.op === 'createStyle' ? step.value : (step.patch as any)?.value) as Record<string, any> | undefined;
  const state = () => JSON.stringify([style && [style.id, style.name, style.type, style.remote, style.boundVariables, style.type === 'TEXT' ? Object.fromEntries(textFields.map(key => [key, style[key]])) : style.type === 'PAINT' ? style.paints : style.type === 'EFFECT' ? style.effects : style.layoutGrids], node && [node.id, node.boundVariables, node.fillStyleId, node.strokeStyleId, node.textStyleId, node.effectStyleId, node.gridStyleId]]);
  return {
    async prepare(step: BatchStep) {
      stylePreflight(step, api); style = node = undefined; guards = []; asyncGuards = [];
      const property = step.property as string;
      if (step.styleId) style = await localResource(api, 'styles', step.styleId as string);
      if (step.target) {
        node = await api.getNodeByIdAsync((step.target as any).nodeId);
        if (!node || node.removed) throw new Error('NODE_NOT_FOUND');
        if (typeof node[setters[property]] !== 'function' || style && style.type !== types[property]) throw new Error('CAPABILITY_UNAVAILABLE');
        const bound = node.boundVariables ?? {};
        const affected = property === 'text' ? ['fontFamily', 'fontStyle', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing'] : [property];
        if (affected.some(key => bound[key] && (Array.isArray(bound[key]) ? bound[key].length : true))) throw new Error('CAPABILITY_UNAVAILABLE');
        if (property !== 'text' && hasBindings(node[property])) throw new Error('CAPABILITY_UNAVAILABLE');
        if (property === 'text' && node.characters?.length && node.getStyledTextSegments(['boundVariables']).some(hasBindings)) throw new Error('CAPABILITY_UNAVAILABLE');
      }
      const patch = value(step);
      if (style && patch) {
        const expected = { PAINT: 'paints', EFFECT: 'effects', GRID: 'layoutGrids' } as Record<string, string>;
        if (style.type === 'TEXT' ? Object.keys(patch).some(key => !textFields.includes(key)) : !(expected[style.type] in patch)) throw new Error('INVALID_ARGUMENT');
        if (style.boundVariables && Object.keys(style.boundVariables).some(key => key in patch || style.type === 'TEXT' && ['fontFamily', 'fontStyle', 'fontWeight'].includes(key) && 'fontName' in patch)) throw new Error('CAPABILITY_UNAVAILABLE');
        if (Object.keys(patch).some(key => hasBindings(style[key]))) throw new Error('CAPABILITY_UNAVAILABLE');
      }
      const fonts: any[] = [];
      if (node?.type === 'TEXT') fonts.push(...(node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName]));
      if (style?.type === 'TEXT' && style.fontName) fonts.push(style.fontName);
      if (patch?.fontName) fonts.push(patch.fontName);
      const missing: any[] = [];
      for (const font of fonts.filter((f, i) => fonts.findIndex(other => JSON.stringify(other) === JSON.stringify(f)) === i)) {
        try { await api.loadFontAsync(font); } catch { missing.push(font); }
      }
      if (missing.length) throw unavailableFonts(missing);
      kind = node ? 'node' : 'styles'; snapshot = state();
    },
    async readExpected(step: BatchStep) {
      const result = await resourceExpected(api, kind, node ?? style, step.expected as Record<string, any>, guards, asyncGuards);
      for (const check of asyncGuards) if (!await check()) throw new Error('CONFLICT');
      if (guards.some(check => !check())) throw new Error('CONFLICT');
      return result;
    },
    async execute(step: BatchStep, record: (changes: any) => void) {
      if (state() !== snapshot || guards.some(check => !check())) throw new Error('CONFLICT');
      const changed = (id: string) => record({ nodeIds: [], resourceIds: [id] });
      const apply = (target: any, patch: Record<string, any>) => {
        for (const [key, val] of Object.entries(patch)) {
          if (key === 'paints' || key === 'effects') {
            const field = key === 'paints' ? 'fills' : 'effects';
            target[key] = normalizeAppearanceValue(field, val);
          } else if (key === 'layoutGrids') target[key] = val.map((grid: any) => ({ ...grid, color: { a: 1, ...grid.color } }));
          else target[key] = val;
          changed(target.id);
        }
      };
      if (step.op === 'createStyle') {
        const factory = { PAINT: 'createPaintStyle', TEXT: 'createTextStyle', EFFECT: 'createEffectStyle', GRID: 'createGridStyle' }[step.type as string];
        if (!factory || typeof api[factory] !== 'function') throw new Error('CAPABILITY_UNAVAILABLE');
        style = api[factory](); changed(style.id); style.name = step.name; changed(style.id); apply(style, value(step)!); return { styleId: style.id };
      }
      if (step.op === 'updateStyle') {
        const patch = step.patch as Record<string, any>;
        if ('name' in patch) { style.name = patch.name; changed(style.id); }
        if (patch.value) {
          apply(style, patch.value);
          record({ nodeIds: [], resourceIds: [], details: [{ resourceId: style.id, effects: 'Linked consumers may change; consumer IDs are not enumerated.' }] });
        }
      } else if (step.op === 'deleteStyle') {
        const id = style.id; style.remove(); record({ nodeIds: [], resourceIds: [id], details: [{ resourceId: id, deleted: true, effects: 'Style consumers may lose their link; affected consumer IDs are not enumerated.' }] });
      } else if (step.op === 'applyStyle' || step.op === 'unbindStyle') {
        const id = node.id;
        const before = state();
        try { await node[setters[step.property as string]](step.op === 'unbindStyle' ? '' : style.id); }
        catch (error) {
          let changed = true;
          try { changed = state() !== before; } catch { /* The mutation outcome is unknown. */ }
          if (changed) record({ nodeIds: [id], resourceIds: [] });
          throw error;
        }
        record({ nodeIds: [id], resourceIds: [] });
      } else throw new Error('CAPABILITY_UNAVAILABLE');
      return {};
    },
  };
}
