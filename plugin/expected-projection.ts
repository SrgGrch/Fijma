import { projectNode } from './projections';

export async function projectExpected(api: any, node: any, fields: Record<string, any>) {
  if (!node || node.removed) throw new Error('NODE_NOT_FOUND');
  let main: unknown;
  if ('mainComponent' in fields && node.type === 'INSTANCE') {
    try {
      const component = await node.getMainComponentAsync();
      main = component ? { id: component.id, key: component.key, remote: component.remote } : null;
    } catch { throw new Error('CAPABILITY_UNAVAILABLE'); }
  }
  const projected = projectNode(node, Object.keys(fields), api.mixed, main);
  if (projected.mixed.length || projected.unavailable.length) throw new Error('CAPABILITY_UNAVAILABLE');
  const values = projected.properties;
  if (fields.layout && values.layout) values.layout = Object.fromEntries(Object.keys(fields.layout).map(key => [key, (values.layout as any)[key]]));
  return values;
}
