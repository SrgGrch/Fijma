import { nodeProjectionSchema, resourceProjectionSchemas } from '../shared/contracts';

type ObjectLike = Record<string, any>;
type Kind = 'components' | 'styles' | 'collections' | 'variables';
const layoutFields = ['layoutMode', 'layoutWrap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'itemSpacing', 'counterAxisSpacing', 'primaryAxisAlignItems', 'counterAxisAlignItems'];
const textFields = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'fills', 'textStyleId', 'boundVariables'];

function valueFor(source: ObjectLike, field: string, kind?: Kind): unknown {
  if (field === 'parentId') return source.parent?.id ?? null;
  if (field === 'children') return source.children?.map((child: ObjectLike) => child.id);
  if (field === 'layout') {
    if (!('layoutMode' in source)) return undefined;
    return Object.fromEntries(layoutFields.filter(key => key in source).map(key => [key, source[key]]));
  }
  if (field === 'textSegments') {
    if (source.type !== 'TEXT' || typeof source.getStyledTextSegments !== 'function') return undefined;
    return source.getStyledTextSegments(textFields);
  }
  if (field === 'componentSet') {
    if (source.type !== 'COMPONENT') return undefined;
    const parent = source.parent;
    return parent?.type === 'COMPONENT_SET' ? { id: parent.id, key: parent.key, remote: parent.remote } : null;
  }
  if (kind === 'variables' && field === 'type') return source.resolvedType;
  if (kind === 'variables' && field === 'collectionId') return source.variableCollectionId;
  if (kind === 'styles' && field === 'value') {
    if (source.type === 'PAINT') return { paints: source.paints };
    if (source.type === 'EFFECT') return { effects: source.effects };
    if (source.type === 'GRID') return { layoutGrids: source.layoutGrids };
    if (source.type === 'TEXT') return Object.fromEntries(['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration']
      .filter(key => key in source).map(key => [key, source[key]]));
    return undefined;
  }
  return source[field];
}

function properties(source: ObjectLike, fields: readonly string[], mixedValue: symbol, kind?: Kind, mainComponent?: unknown) {
  const values: Record<string, unknown> = {}, mixed: string[] = [], unavailable: string[] = [];
  for (const field of fields) {
    try {
      const value = field === 'mainComponent' ? mainComponent : valueFor(source, field, kind);
      if (value === mixedValue) { mixed.push(field); continue; }
      if (value === undefined) { unavailable.push(field); continue; }
      const encoded = JSON.stringify(value, (_key, item) => {
        if (typeof item === 'symbol' || typeof item === 'function' || typeof item === 'bigint') throw new Error('UNAVAILABLE');
        return item;
      });
      if (encoded === undefined) throw new Error('UNAVAILABLE');
      const result = JSON.parse(encoded);
      const schema = (kind ? resourceProjectionSchemas[kind].shape : nodeProjectionSchema.shape) as Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
      if (!schema[field]?.safeParse(result).success) throw new Error('UNAVAILABLE');
      values[field] = result;
    } catch { unavailable.push(field); }
  }
  return { properties: values, mixed, unavailable };
}

export function projectNode(node: ObjectLike, fields: readonly string[], mixedValue: symbol, mainComponent?: unknown) {
  return { nodeId: node.id, type: node.type, ...properties(node, fields, mixedValue, undefined, mainComponent) };
}

export function projectResource(kind: Kind, resource: ObjectLike, fields: readonly string[], mixedValue: symbol) {
  return { kind, id: resource.id, ...properties(resource, fields, mixedValue, kind) };
}

export async function readNodes(api: Pick<PluginAPI, 'getNodeByIdAsync' | 'mixed'>, nodeIds: readonly string[], fields: readonly string[], maxNodes: number, maxBytes: number,
  yieldControl: () => Promise<void> = async () => {}) {
  if (nodeIds.length > maxNodes) throw new Error('RESOURCE_LIMIT');
  const nodes = [];
  for (const nodeId of nodeIds) {
    const node = await api.getNodeByIdAsync(nodeId);
    if (node?.type === 'PAGE' && fields.some(field => field === 'children' || field === 'layout')) await node.loadAsync();
    let mainComponent: unknown;
    if (node && fields.includes('mainComponent') && node.type === 'INSTANCE') {
      try {
        const main = await node.getMainComponentAsync();
        mainComponent = main ? { id: main.id, key: main.key, remote: main.remote } : null;
      } catch { /* The requested link is marked unavailable. */ }
    }
    nodes.push(node ? projectNode(node, fields, api.mixed, mainComponent) : { nodeId, error: { code: 'NODE_NOT_FOUND',
      message: 'Узел не найден.', recoveryAction: 'Перечитайте дерево и используйте актуальный nodeId.' } });
    if (encodeURI(JSON.stringify({ nodes })).replace(/%[A-F\d]{2}/g, 'x').length > maxBytes - 256) throw new Error('RESOURCE_LIMIT');
    if (nodes.length % 50 === 0) await yieldControl();
  }
  return { nodes };
}

export async function localResources(api: PluginAPI, kind: Exclude<Kind, 'components'>) {
  if (kind === 'variables') return api.variables.getLocalVariablesAsync();
  if (kind === 'collections') return api.variables.getLocalVariableCollectionsAsync();
  const lists = await Promise.all([api.getLocalPaintStylesAsync(), api.getLocalTextStylesAsync(),
    api.getLocalEffectStylesAsync(), api.getLocalGridStylesAsync()]);
  return lists.flat();
}
