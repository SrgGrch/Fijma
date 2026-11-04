import { projectExpected } from './expected-projection';
import { projectNode, projectResource } from './projections';

export async function localResource(api: any, kind: 'styles' | 'collections' | 'variables', id: string) {
  const item = kind === 'styles' ? await api.getStyleByIdAsync(id) : kind === 'collections' ? await api.variables.getVariableCollectionByIdAsync(id) : await api.variables.getVariableByIdAsync(id);
  if (!item) throw new Error('NODE_NOT_FOUND');
  if (item.remote || item.isExtension) throw new Error('CAPABILITY_UNAVAILABLE');
  return item;
}

export async function resourceExpected(api: any, kind: 'styles' | 'collections' | 'variables' | 'node', item: any, expected: Record<string, any>, guards: Array<() => boolean> = [], asyncGuards: Array<() => Promise<boolean>> = []) {
  const { related, ...fields } = expected;
  let values: Record<string, any>;
  if (!item && Object.keys(fields).length === 0) values = {};
  else if (kind === 'node') {
    values = await projectExpected(api, item, fields);
    const keys = Object.keys(fields).filter(key => key !== 'mainComponent');
    const read = () => JSON.stringify([item.removed, projectNode(item, keys, api.mixed)]);
    const snapshot = read(); guards.push(() => read() === snapshot);
    if ('mainComponent' in fields && item.type === 'INSTANCE') {
      const expectedMain = JSON.stringify(values.mainComponent);
      asyncGuards.push(async () => {
        const main = await item.getMainComponentAsync();
        return JSON.stringify(main ? { id: main.id, key: main.key, remote: main.remote } : null) === expectedMain;
      });
    }
  }
  else {
    const keys = Object.keys(fields);
    const styleValueFields = ['paints', 'effects', 'layoutGrids', 'fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration'];
    const projectionFields = [...new Set(keys.map(key => kind === 'styles' && styleValueFields.includes(key) ? 'value' : key))];
    const projected = projectResource(kind, item, projectionFields, api.mixed);
    if (projected.mixed.length || projected.unavailable.length) throw new Error('CAPABILITY_UNAVAILABLE');
    values = Object.fromEntries(keys.map(key => [key, kind === 'styles' && styleValueFields.includes(key) ? (projected.properties.value as any)?.[key] : (projected.properties as any)[key]]));
    if (Object.values(values).some(value => value === undefined)) throw new Error('CAPABILITY_UNAVAILABLE');
    const read = () => JSON.stringify([item.remote, item.isExtension, projectResource(kind, item, projectionFields, api.mixed)]);
    const snapshot = read(); guards.push(() => read() === snapshot);
  }
  if (related) {
    values.related = {};
    for (const [id, expectedFields] of Object.entries(related)) {
      const relatedKind = id.startsWith('S:') ? 'styles' : id.startsWith('VariableCollectionId:') ? 'collections' : id.startsWith('VariableID:') ? 'variables' : 'node';
      const target = relatedKind === 'node' ? await api.getNodeByIdAsync(id) : await localResource(api, relatedKind, id);
      if (relatedKind === 'node' && target?.type === 'PAGE') await target.loadAsync();
      values.related[id] = await resourceExpected(api, relatedKind, target, expectedFields as Record<string, any>, guards, asyncGuards);
    }
  }
  return values;
}

export function nodePreconditions(api: any) {
  let guards: Array<() => boolean> = [], asyncGuards: Array<() => Promise<boolean>> = [];
  const verify = () => { if (guards.some(check => !check())) throw new Error('CONFLICT'); };
  return {
    reset() { guards = []; asyncGuards = []; },
    async read(node: any, expected: Record<string, any>) {
      const result = await resourceExpected(api, 'node', node, expected, guards, asyncGuards);
      for (const check of asyncGuards) if (!await check()) throw new Error('CONFLICT');
      verify();
      return result;
    },
    verify,
  };
}
