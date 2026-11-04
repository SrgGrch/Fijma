import type { BatchStep } from '../shared/batch-refs';
import { localResource, resourceExpected } from './resource-expected';
import { unavailableFonts } from './text-links';

const strings = ['characters', 'fontFamily', 'fontStyle'];
const typeForField = (field: string) => field === 'visible' ? 'BOOLEAN' : strings.includes(field) ? 'STRING' : 'FLOAT';
const variableState = (item: any) => JSON.stringify([item.id, item.name, item.description, item.hiddenFromPublishing, item.remote, item.variableCollectionId, item.resolvedType, item.valuesByMode]);
const collectionState = (item: any) => JSON.stringify([item.id, item.name, item.remote, item.isExtension, item.modes, item.variableIds]);
const nodeState = (item: any) => JSON.stringify([item.id, item.boundVariables, item.explicitVariableModes, item.textStyleId, item.fillStyleId]);

export function variableOperations(api: any, maxGraphNodes = 1000, yieldControl: () => Promise<void> = async () => {}) {
  let variable: any, collection: any, node: any, alias: any;
  let snapshots: Array<() => string>, saved: string[];
  let guards: Array<() => boolean>, asyncGuards: Array<() => Promise<boolean>>;
  let kind: 'node' | 'variables' | 'collections';
  return {
    async prepare(step: BatchStep) {
      variable = collection = node = alias = undefined; snapshots = []; guards = []; asyncGuards = [];
      if (step.variableId) variable = await localResource(api, 'variables', step.variableId as string);
      if (step.collectionId) collection = await localResource(api, 'collections', step.collectionId as string);
      if (variable && !collection) collection = await localResource(api, 'collections', variable.variableCollectionId);
      if (step.targetVariableId) alias = await localResource(api, 'variables', step.targetVariableId as string);
      if (step.target) {
        node = await api.getNodeByIdAsync((step.target as any).nodeId);
        if (!node || node.removed) throw new Error('NODE_NOT_FOUND');
        if (step.op === 'setNodeMode' ? typeof node.setExplicitVariableModeForCollection !== 'function' : typeof node.setBoundVariable !== 'function' || !(step.property as string in node) && !['fontFamily', 'fontStyle', 'fontWeight'].includes(step.property as string)) throw new Error('CAPABILITY_UNAVAILABLE');
        if (step.op === 'bindVariable' && variable.resolvedType !== typeForField(step.property as string)) throw new Error('INVALID_ARGUMENT');
        if (step.op === 'bindVariable' && node.type === 'TEXT' && ['fontFamily', 'fontStyle', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing'].includes(step.property as string) && node.textStyleId) throw new Error('CAPABILITY_UNAVAILABLE');
      }
      if (step.modeId && (!collection || !collection.modes.some((mode: any) => mode.modeId === step.modeId))) throw new Error('INVALID_ARGUMENT');
      if (step.op === 'deleteMode' && collection.modes.length <= 1) throw new Error('CAPABILITY_UNAVAILABLE');
      if (step.op === 'setVariableValue') {
        const value = step.value;
        const valid = variable.resolvedType === 'BOOLEAN' ? typeof value === 'boolean' : variable.resolvedType === 'STRING' ? typeof value === 'string' : variable.resolvedType === 'FLOAT' ? typeof value === 'number' && Number.isFinite(value) : variable.resolvedType === 'COLOR' && !!value && typeof value === 'object';
        if (!valid) throw new Error('INVALID_ARGUMENT');
      }
      if (step.op === 'setVariableAlias') {
        if (alias.resolvedType !== variable.resolvedType) throw new Error('INVALID_ARGUMENT');
        const visited = new Set<string>(), queue = [alias], graph: Array<{ item: any; state: string }> = [];
        const edges = new Map<string, string[]>();
        while (queue.length) {
          const current = queue.shift();
          if (current.id === variable.id) throw new Error('INVALID_ARGUMENT');
          if (visited.has(current.id)) continue;
          if (visited.size >= maxGraphNodes) throw new Error('RESOURCE_LIMIT');
          visited.add(current.id); graph.push({ item: current, state: variableState(current) }); edges.set(current.id, []);
          if (visited.size % 50 === 0) await yieldControl();
          for (const value of Object.values(current.valuesByMode) as any[]) {
            const links = value && typeof value === 'object' ? [value, value.color, value.opacity] : [];
            for (const link of links) if (link?.type === 'VARIABLE_ALIAS') {
              edges.get(current.id)!.push(link.id);
              if (queue.length + visited.size >= maxGraphNodes) throw new Error('RESOURCE_LIMIT');
              queue.push(await localResource(api, 'variables', link.id));
            }
          }
        }
        const indegree = new Map([...visited].map(id => [id, 0]));
        for (const links of edges.values()) for (const id of links) indegree.set(id, indegree.get(id)! + 1);
        const roots = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
        let processed = 0;
        while (roots.length) {
          const id = roots.pop()!; processed++;
          for (const next of edges.get(id) ?? []) { const count = indegree.get(next)! - 1; indegree.set(next, count); if (!count) roots.push(next); }
        }
        if (processed !== visited.size) throw new Error('INVALID_ARGUMENT');
        if (graph.some(entry => variableState(entry.item) !== entry.state)) throw new Error('CONFLICT');
        for (const entry of graph) snapshots.push(() => variableState(entry.item));
      }
      if (node?.type === 'TEXT' && step.op !== 'setNodeMode') {
        const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
        const missing: any[] = [];
        for (const font of fonts) try { await api.loadFontAsync(font); } catch { missing.push(font); }
        if (missing.length) throw unavailableFonts(missing);
      }
      if (variable) snapshots.push(() => variableState(variable));
      if (collection) snapshots.push(() => collectionState(collection));
      if (node) snapshots.push(() => nodeState(node));
      saved = snapshots.map(read => read());
      kind = node ? 'node' : variable ? 'variables' : 'collections';
    },
    async readExpected(step: BatchStep) {
      const result = await resourceExpected(api, kind, node ?? variable ?? collection, step.expected as Record<string, any>, guards, asyncGuards);
      for (const check of asyncGuards) if (!await check()) throw new Error('CONFLICT');
      if (guards.some(check => !check())) throw new Error('CONFLICT');
      return result;
    },
    async execute(step: BatchStep, record: (changes: any) => void) {
      if (snapshots.some((read, index) => read() !== saved[index]) || guards.some(check => !check())) throw new Error('CONFLICT');
      const changed = (id: string) => record({ nodeIds: [], resourceIds: [id] });
      const sideEffects = (id: string, effects: string, extra: string[] = []) => record({ nodeIds: [], resourceIds: [id, ...extra], details: [{ resourceId: id, effects }] });
      switch (step.op) {
        case 'createCollection': collection = api.variables.createVariableCollection(step.name); changed(collection.id); return { collectionId: collection.id };
        case 'updateCollection': collection.name = (step.patch as any).name; changed(collection.id); break;
        case 'deleteCollection': {
          const id = collection.id, ids = [...collection.variableIds];
          if (ids.length >= maxGraphNodes) throw new Error('RESOURCE_LIMIT');
          collection.remove(); sideEffects(id, 'Collection and its variables were removed; consumers and aliases are not enumerated.', ids); break;
        }
        case 'createMode': {
          const ids = [...collection.variableIds];
          if (ids.length >= maxGraphNodes) throw new Error('RESOURCE_LIMIT');
          let id: string;
          try { id = collection.addMode(step.name); } catch (error) {
            if (/limited to \d+ modes? only/i.test(String(error))) throw Object.assign(new Error('CAPABILITY_UNAVAILABLE'), { details: { reason: 'VARIABLE_MODE_LIMIT' } });
            throw error;
          }
          record({ nodeIds: [], resourceIds: [collection.id, ...ids] }); return { modeId: id };
        }
        case 'renameMode': collection.renameMode(step.modeId, step.name); changed(collection.id); break;
        case 'deleteMode': {
          const ids = [...collection.variableIds];
          if (ids.length >= maxGraphNodes) throw new Error('RESOURCE_LIMIT');
          collection.removeMode(step.modeId); sideEffects(collection.id, 'Mode values and explicit mode references may change; consumers are not enumerated.', ids); break;
        }
        case 'createVariable': variable = api.variables.createVariable(step.name, collection, step.type); changed(variable.id); changed(collection.id); return { variableId: variable.id };
        case 'updateVariable': for (const [key, val] of Object.entries(step.patch as Record<string, any>)) { variable[key] = val; changed(variable.id); } break;
        case 'deleteVariable': { const id = variable.id; variable.remove(); sideEffects(id, 'Variable was removed; bindings and aliases may change and consumers are not enumerated.'); changed(collection.id); break; }
        case 'setVariableValue': variable.setValueForMode(step.modeId, step.value); sideEffects(variable.id, 'Bound consumers and aliases may change; consumer IDs are not enumerated.'); break;
        case 'setVariableAlias': variable.setValueForMode(step.modeId, api.variables.createVariableAlias(alias)); sideEffects(variable.id, 'Bound consumers and aliases may change; consumer IDs are not enumerated.'); break;
        case 'bindVariable': case 'unbindVariable': node.setBoundVariable(step.property, step.op === 'unbindVariable' ? null : variable); record({ nodeIds: [node.id], resourceIds: [] }); break;
        case 'setNodeMode': node.setExplicitVariableModeForCollection(collection, step.modeId); record({ nodeIds: [node.id], resourceIds: [] }); break;
        default: throw new Error('CAPABILITY_UNAVAILABLE');
      }
      return {};
    },
  };
}
