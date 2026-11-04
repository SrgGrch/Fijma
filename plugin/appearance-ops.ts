import { nodePreconditions } from './resource-expected';
import { stepSchema } from '../shared/contracts';
import type { BatchStep } from '../shared/batch-refs';

type Changes = { nodeIds: string[]; resourceIds: string[]; details?: unknown[] };
const styleKeys: Record<string, string> = { fills: 'fillStyleId', strokes: 'strokeStyleId', effects: 'effectStyleId' };
const cornerKeys = ['cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'];
const hasBindings = (value: any) => value && typeof value === 'object' && Object.keys(value).length > 0;

export const appearanceKeys = ['fills', 'strokes', 'effects', 'opacity', 'strokeWeight', ...cornerKeys];
export const appearancePatch = (props: Record<string, any>) => Object.fromEntries(Object.entries(props).filter(([key]) => appearanceKeys.includes(key)));
export function preflightAppearance(figma: any, patch: Record<string, any>) {
  if ('cornerRadius' in patch && cornerKeys.slice(1).some(key => key in patch)) throw new Error('INVALID_ARGUMENT');
  for (const key of ['fills', 'strokes']) if (key in patch && patch[key].some((paint: any) => paint.type === 'IMAGE' && !figma.getImageByHash(paint.imageHash))) throw new Error('INVALID_ARGUMENT');
}
export function validateAppearance(figma: any, node: any, patch: Record<string, any>) {
  if (!node || node.removed) throw new Error('NODE_NOT_FOUND');
  preflightAppearance(figma, patch);
    for (const key of Object.keys(patch)) {
      if (!(key in node)) throw new Error('CAPABILITY_UNAVAILABLE');
      const style = styleKeys[key];
      if (style && (typeof node[style] === 'symbol' || node[style])) throw new Error('CAPABILITY_UNAVAILABLE');
      const bindings = node.boundVariables ?? {};
      if (bindings[key] || key === 'cornerRadius' && cornerKeys.some(k => bindings[k]) || cornerKeys.includes(key) && bindings.cornerRadius) throw new Error('CAPABILITY_UNAVAILABLE');
      if (['fills', 'strokes', 'effects'].includes(key)) {
        if (!Array.isArray(node[key]) || node[key].some((value: any) => hasBindings(value.boundVariables) || value.gradientStops?.some((stop: any) => hasBindings(stop.boundVariables)))) throw new Error('CAPABILITY_UNAVAILABLE');
        if (key === 'fills' && node.type === 'TEXT' && node.characters?.length && typeof node.getStyledTextSegments === 'function') {
          const segments = node.getStyledTextSegments(['fills', 'fillStyleId', 'boundVariables']);
          if (segments.some((segment: any) => segment.fillStyleId || segment.boundVariables?.fills || segment.fills?.some((paint: any) => hasBindings(paint.boundVariables)))) throw new Error('CAPABILITY_UNAVAILABLE');
        }
      }
    }
}
export function normalizeAppearanceValue(key: string, raw: any) {
  let value: any = raw;
  if (key === 'fills' || key === 'strokes') value = (raw as any[]).map(paint => {
    if (paint.type.startsWith('GRADIENT_')) return { ...paint, gradientStops: paint.gradientStops.map((stop: any) => ({ ...stop, color: { a: 1, ...stop.color } })) };
    if (paint.type !== 'SOLID') return paint;
    const { a = 1, ...color } = paint.color;
    return { ...paint, color, opacity: (paint.opacity ?? 1) * a };
  });
  if (key === 'effects') value = (raw as any[]).map(effect => ({ visible: true, ...(effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW' ? { blendMode: 'NORMAL', ...effect, color: { a: 1, ...effect.color } } : { blurType: 'NORMAL', ...effect }) }));
  return value;
}
export function applyAppearance(node: any, patch: Record<string, any>, changed: (node: any) => void) {
  for (const [key, raw] of Object.entries(patch)) {
    const value = normalizeAppearanceValue(key, raw);
    node[key] = value;
    changed(node);
  }
}

export function appearanceOperations(figma: any) {
  const checks = nodePreconditions(figma);
  let node: any, original: BatchStep;
  async function find(id: string) {
    const result = await figma.getNodeByIdAsync(id);
    if (!result || result.removed) throw new Error('NODE_NOT_FOUND');
    if (result.type === 'PAGE') await result.loadAsync();
    return result;
  }
  function validate(step: BatchStep) {
    if (!stepSchema.safeParse(original).success) throw new Error('INVALID_ARGUMENT');
    validateAppearance(figma, node, step.appearance as Record<string, any>);
  }
  return {
    preflight(step: BatchStep) { if (step.op !== 'setAppearance' || !stepSchema.safeParse(step).success) throw new Error('INVALID_ARGUMENT'); preflightAppearance(figma, step.appearance as Record<string, any>); },
    async prepare(step: BatchStep, raw: BatchStep = step) {
      checks.reset();
      original = raw;
      node = await find((step.target as { nodeId: string }).nodeId);
      validate(step);
    },
    async readExpected(step: BatchStep) { return checks.read(node, step.expected as Record<string, any>); },
    async execute(step: BatchStep, record: (changes: Changes) => void) {
      checks.verify();
      validate(step);
      applyAppearance(node, step.appearance as Record<string, any>, target => record({ nodeIds: [target.id], resourceIds: [] }));
      return {};
    },
  };
}
