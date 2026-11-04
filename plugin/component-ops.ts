import { stepSchema } from '../shared/contracts';
import type { BatchStep } from '../shared/batch-refs';
import { nodePreconditions } from './resource-expected';
import { unavailableFonts } from './text-links';
import { appearanceKeys, appearancePatch, preflightAppearance, applyAppearance } from './appearance-ops';
import { bootstrapLimits } from '../shared/bootstrap-limits';

type Changes = { nodeIds: string[]; resourceIds: string[]; details?: unknown[] };
const ops = ['createComponent', 'componentFromNode', 'combineVariants', 'setComponentProperties', 'createInstance', 'setInstanceProperties', 'swapVariant', 'detachInstance'];
const inside = (node: any, type: string) => { for (let n = node; n; n = n.parent) if (n.type === type) return true; return false; };
const within = (node: any, ancestor: any) => { for (let n = node; n; n = n.parent) if (n === ancestor) return true; return false; };
const copy = (value: any) => JSON.parse(JSON.stringify(value));

// The executor runs one step at a time; these references belong to its current step.
export function componentOperations(figma: any, limits: () => { maxNodes: number } = () => bootstrapLimits, yieldControl: () => Promise<void> = async () => {}) {
  const checks = nodePreconditions(figma);
  let target: any, parent: any, component: any, targets: any[], dependencies: any[], original: BatchStep, snapshot = '', textSnapshot = '', main: any, guard: () => void = () => {};
  const find = async (id: string) => {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.removed) throw new Error('NODE_NOT_FOUND');
    let page = node; while (page && page.type !== 'PAGE') page = page.parent;
    if (page) await page.loadAsync();
    return node;
  };
  const local = (node: any) => { if (!node || node.type !== 'COMPONENT' || node.remote) throw new Error('CAPABILITY_UNAVAILABLE'); };
  const checkCycle = async (destination: any, candidate: any) => {
    const ancestors = new Set<any>();
    for (let n = destination; n; n = n.parent) if (n.type === 'COMPONENT') ancestors.add(n);
    const seen = new Set<any>(), queue = [candidate];
    while (queue.length) {
      const node = queue.pop(); if (!node || seen.has(node)) continue;
      if (ancestors.has(node)) throw new Error('INVALID_ARGUMENT');
      seen.add(node); if (seen.size > limits().maxNodes) throw new Error('RESOURCE_LIMIT');
      if (seen.size % 50 === 0) { await yieldControl(); guard(); }
      if (node.type === 'INSTANCE') { queue.push(await node.getMainComponentAsync()); guard(); }
      for (const child of node.children ?? []) queue.push(child);
    }
  };
  const definitions = (step: BatchStep) => {
    const wanted = step.definitions as Record<string, any>, current = target.componentPropertyDefinitions;
    for (const [name, next] of Object.entries(wanted) as [string, any][]) {
      const def = current[name];
      if (!def && next.type === 'VARIANT') throw new Error('CAPABILITY_UNAVAILABLE');
      if (def && (def.type !== next.type || def.boundVariables?.defaultValue)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (def?.type === 'VARIANT' && next.defaultValue !== def.defaultValue) throw new Error('CAPABILITY_UNAVAILABLE');
    }
  };
  const signature = (step: BatchStep) => JSON.stringify(step.op === 'setComponentProperties' ? target.componentPropertyDefinitions : step.op === 'setInstanceProperties' ? [target.componentProperties, target.overrides] : step.op === 'swapVariant' ? [target.componentProperties, target.overrides, main?.id] : null);
  const textFonts = (keys: string[]) => {
    const values: any[] = [], seen = new Set<any>(), queue = [target];
    while (queue.length) {
      const node = queue.pop(); if (!node || seen.has(node)) continue;
      seen.add(node); if (seen.size > limits().maxNodes) throw new Error('RESOURCE_LIMIT');
      if (node.type === 'TEXT' && keys.includes(node.componentPropertyReferences?.characters)) {
        if (node.hasMissingFont) throw new Error('FONT_UNAVAILABLE');
        const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
        if (!Array.isArray(fonts) || fonts.some((f: any) => !f || typeof f.family !== 'string' || typeof f.style !== 'string')) throw new Error('FONT_UNAVAILABLE');
        values.push({ id: node.id, characters: node.characters, fonts });
      }
      for (const child of node.children ?? []) queue.push(child);
    }
    return values;
  };
  const yieldTextTraversal = async () => {
    const seen = new Set<any>(), queue = [target];
    while (queue.length) {
      const node = queue.pop(); if (!node || seen.has(node)) continue;
      seen.add(node); if (seen.size > limits().maxNodes) throw new Error('RESOURCE_LIMIT');
      if (seen.size % 50 === 0) { await yieldControl(); guard(); }
      for (const child of node.children ?? []) queue.push(child);
    }
  };
  const validate = (step: BatchStep) => {
    if (!stepSchema.safeParse(original).success) throw new Error('INVALID_ARGUMENT');
    if ([target, parent, component, ...targets, ...dependencies].some(n => n?.removed)) throw new Error('NODE_NOT_FOUND');
    for (const node of dependencies) local(node);
    if (parent && (!('appendChild' in parent) || inside(parent, 'INSTANCE'))) throw new Error('INVALID_ARGUMENT');
    if (parent?.type === 'COMPONENT_SET' && step.op === 'createInstance') throw new Error('INVALID_ARGUMENT');
    if (target?.parent && inside(target.parent, 'INSTANCE') && ['componentFromNode', 'detachInstance'].includes(step.op)) throw new Error('INVALID_ARGUMENT');
    if (step.op === 'componentFromNode' && (!target.parent || ['DOCUMENT', 'PAGE', 'COMPONENT', 'COMPONENT_SET'].includes(target.type) || inside(target.parent, 'COMPONENT') || inside(target.parent, 'COMPONENT_SET'))) throw new Error('INVALID_ARGUMENT');
    if (step.op === 'combineVariants') {
      if (new Set(targets).size !== targets.length || targets.some(n => n.type !== 'COMPONENT' || n.remote || !n.parent || inside(n.parent, 'INSTANCE') || within(parent, n))) throw new Error('INVALID_ARGUMENT');
    }
    if (step.op === 'setComponentProperties') { if (!['COMPONENT', 'COMPONENT_SET'].includes(target.type) || target.remote || target.type === 'COMPONENT' && target.parent?.type === 'COMPONENT_SET') throw new Error('CAPABILITY_UNAVAILABLE'); definitions(step); }
    if (['setInstanceProperties', 'swapVariant', 'detachInstance'].includes(step.op) && target.type !== 'INSTANCE') throw new Error('INVALID_ARGUMENT');
    if (component) { local(component); if (parent && within(parent, component)) throw new Error('INVALID_ARGUMENT'); }
    if (step.op === 'swapVariant' && (!main || main.remote || main.parent?.type !== 'COMPONENT_SET' || main.parent !== component.parent)) throw new Error('INVALID_ARGUMENT');
    if (step.op === 'setInstanceProperties') {
      for (const [key, value] of Object.entries(step.values as Record<string, any>)) {
        const property = target.componentProperties[key];
        if (!property || property.type === 'SLOT' || property.boundVariables?.value || typeof value !== (property.type === 'BOOLEAN' ? 'boolean' : 'string')) throw new Error('CAPABILITY_UNAVAILABLE');
      }
    }
  };
  return {
    preflight(step: BatchStep) {
      if (!ops.includes(step.op)) throw new Error('CAPABILITY_UNAVAILABLE');
      if (!stepSchema.safeParse(step).success) throw new Error('INVALID_ARGUMENT');
      if (step.op === 'createComponent') {
        const p = step.properties as any;
        if (p.width !== undefined && p.width < .01 || p.height !== undefined && p.height < .01) throw new Error('INVALID_ARGUMENT');
        preflightAppearance(figma, appearancePatch(p));
      }
    },
    async prepare(step: BatchStep, raw: BatchStep = step, check: () => void = () => {}) {
      guard = check;
      checks.reset(); original = raw; target = parent = component = main = undefined; targets = []; dependencies = []; snapshot = ''; textSnapshot = '';
      if (!ops.includes(step.op) || !stepSchema.safeParse(raw).success) throw new Error('INVALID_ARGUMENT');
      if (step.target) target = await find((step.target as any).nodeId);
      if (step.parent) parent = await find((step.parent as any).nodeId);
      if (step.componentId) component = await find((step.componentId as any).nodeId);
      if (step.targets) targets = await Promise.all((step.targets as any[]).map(ref => find(ref.nodeId)));
      if (step.op === 'swapVariant') main = await target.getMainComponentAsync();
      if (step.op === 'setComponentProperties') {
        for (const def of Object.values(step.definitions as Record<string, any>)) if (def.type === 'INSTANCE_SWAP') dependencies.push(await find(def.defaultValue));
      }
      if (step.op === 'setInstanceProperties') {
        for (const [name, value] of Object.entries(step.values as Record<string, any>)) if (target.componentProperties[name]?.type === 'INSTANCE_SWAP') dependencies.push(await find(value));
        if (Object.keys(step.values as object).some(key => target.componentProperties[key]?.type === 'TEXT')) {
          await yieldTextTraversal();
          const keys = Object.keys(step.values as object).filter(key => target.componentProperties[key]?.type === 'TEXT');
          const texts = textFonts(keys), fonts: any[] = [];
          textSnapshot = JSON.stringify(texts);
          for (const text of texts) for (const font of text.fonts) if (!fonts.some(f => f.family === font.family && f.style === font.style)) fonts.push(font);
          const missing = []; for (const font of fonts) try { await figma.loadFontAsync(font); } catch { missing.push(font); }
          if (missing.length) throw unavailableFonts(missing);
          if (textSnapshot !== JSON.stringify(textFonts(keys))) throw new Error('CONFLICT');
        }
      }
      if (step.op === 'createInstance') await checkCycle(parent, component);
      if (step.op === 'swapVariant') await checkCycle(target.parent, component);
      if (step.op === 'setInstanceProperties') for (const node of dependencies) await checkCycle(target.parent, node);
      validate(step); snapshot = signature(step);
    },
    async readExpected(step: BatchStep) {
      return checks.read(target ?? targets[0] ?? parent, step.expected as Record<string, any>);
    },
    async execute(step: BatchStep, record: (changes: Changes) => void) {
      checks.verify();
      validate(step);
      if (snapshot !== signature(step)) throw new Error('CONFLICT');
      if (textSnapshot && textSnapshot !== JSON.stringify(textFonts(Object.keys(step.values as object).filter(key => target.componentProperties[key]?.type === 'TEXT')))) throw new Error('CONFLICT');
      const changed = (nodes: any[], details?: unknown[]) => record({ nodeIds: [...new Set(nodes.filter(Boolean).map(n => n.id))], resourceIds: [], ...(details ? { details } : {}) });
      if (step.op === 'createComponent') {
        const node = figma.createComponent(); changed([node]); parent.appendChild(node); changed([node, parent]);
        const p = step.properties as Record<string, any>;
        for (const [key, value] of Object.entries(p)) if (!['width', 'height', 'layout', 'locked', ...appearanceKeys].includes(key)) { node[key] = value; changed([node]); }
        applyAppearance(node, appearancePatch(p), n => changed([n]));
        if ('width' in p || 'height' in p) { node.resize(p.width ?? node.width, p.height ?? node.height); changed([node]); }
        if (p.layout) for (const [key, value] of Object.entries(p.layout)) { node[key] = value; changed([node]); }
        if ('locked' in p) { node.locked = p.locked; changed([node]); }
        return { nodeId: node.id };
      }
      if (step.op === 'componentFromNode') { const sourceId = target.id, parentId = target.parent.id; const node = figma.createComponentFromNode(target); record({ nodeIds: [node.id, sourceId, parentId], resourceIds: [] }); changed([node], [{ effect: 'component-created-from-node', sourceId }]); return { nodeId: node.id }; }
      if (step.op === 'combineVariants') { const ids = [...targets.map(n => n.id), ...targets.map(n => n.parent.id), parent.id]; const node = figma.combineAsVariants(targets, parent); record({ nodeIds: [node.id, ...ids], resourceIds: [] }); changed([node], [{ componentPropertyDefinitions: copy(node.componentPropertyDefinitions) }]); return { nodeId: node.id }; }
      if (step.op === 'setComponentProperties') {
        const wanted = step.definitions as Record<string, any>, current = copy(target.componentPropertyDefinitions);
        let mutated = false;
        for (const [name, def] of Object.entries(wanted)) {
          if (!current[name]) { target.addComponentProperty(name, def.type, def.defaultValue); changed([target]); mutated = true; }
          else if (def.type !== 'VARIANT' && current[name].defaultValue !== def.defaultValue) { target.editComponentProperty(name, { defaultValue: def.defaultValue }); changed([target]); mutated = true; }
        }
        if (mutated) changed([target], [{ componentPropertyDefinitions: copy(target.componentPropertyDefinitions), effect: 'existing instances may update; count unknown' }]); return {};
      }
      if (step.op === 'createInstance') { const node = component.createInstance(); changed([node]); parent.appendChild(node); changed([node, parent]); return { nodeId: node.id }; }
      if (step.op === 'setInstanceProperties' || step.op === 'swapVariant') {
        const before = copy(target.overrides ?? []);
        if (step.op === 'setInstanceProperties') target.setProperties(step.values); else target.swapComponent(component);
        changed([target], [{ componentProperties: copy(target.componentProperties), overridesBefore: before, overridesAfter: copy(target.overrides ?? []), ...(step.op === 'swapVariant' ? { mainComponentId: component.id } : {}) }]); return {};
      }
      if (step.op === 'detachInstance') { const oldId = target.id, previous = target.parent; const node = target.detachInstance(); changed([node, previous], [{ effect: 'component-link-detached', previousInstanceId: oldId }]); return { nodeId: node.id }; }
      throw new Error('CAPABILITY_UNAVAILABLE');
    },
  };
}
