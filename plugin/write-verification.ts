import type { BatchStep } from '../shared/batch-refs';
import { projectNode, projectResource } from './projections';

type Changes = { nodeIds: string[]; resourceIds: string[] };

// Verification is bounded: a large affected layout fails explicitly instead of returning a partial snapshot.
export async function verifyWrite(api: any, step: BatchStep, changes: Changes, previousParents: string[], limits: { maxNodes: number; maxResponseBytes: number; maxBatchSteps: number }, check: () => void, previousGroups: string[] = []) {
  const direct = new Set(changes.nodeIds);
  const queue = [...new Set([...changes.nodeIds, ...previousParents])];
  const seen = new Set<string>();
  let resourceCount = 0;
  const result: any[] = [];
  const deletion = ['deleteNode', 'deletePage', 'ungroupNode', 'moveNode', 'groupNodes', 'componentFromNode', 'detachInstance'].includes(step.op);
  for (const id of new Set(changes.resourceIds)) {
    if (++resourceCount > limits.maxNodes) throw new Error('RESOURCE_LIMIT');
    const kind = id.startsWith('VariableID:') ? 'variables' : id.startsWith('VariableCollectionId:') ? 'collections' : id.startsWith('S:') ? 'styles' : undefined;
    if (!kind) throw new Error('CAPABILITY_UNAVAILABLE');
    check();
    const resource = kind === 'styles' ? await api.getStyleByIdAsync(id) : kind === 'variables' ? await api.variables.getVariableByIdAsync(id) : await api.variables.getVariableCollectionByIdAsync(id);
    check();
    if (!resource) {
      if (!['deleteStyle', 'deleteVariable', 'deleteCollection'].includes(step.op)) throw new Error('FIGMA_API_ERROR');
      result.push({ resourceId: id, deleted: true });
    } else {
      if (resource.remote) throw new Error('CAPABILITY_UNAVAILABLE');
      const fields = kind === 'styles' ? ['name', 'type', 'value'] : kind === 'variables' ? ['name', 'type', 'collectionId', 'valuesByMode'] : ['name', 'modes', 'defaultModeId', 'variableIds'];
      if ((kind === 'variables' && step.op === 'updateVariable') || (kind === 'styles' && step.op === 'updateStyle') || (kind === 'collections' && step.op === 'updateCollection')) {
        for (const field of Object.keys((step.patch ?? {}) as object)) if (!fields.includes(field)) fields.push(field);
      }
      const projection = projectResource(kind, resource, fields, api.mixed);
      if (projection.unavailable.length || projection.mixed.length) throw new Error('FIGMA_API_ERROR');
      result.push({ resourceId: id, kind, properties: projection.properties });
    }
    if (encodeURI(JSON.stringify(result)).replace(/%[A-F\d]{2}/g, 'x').length > Math.floor(limits.maxResponseBytes / limits.maxBatchSteps)) throw new Error('RESOURCE_LIMIT');
  }
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    if (seen.size + resourceCount >= limits.maxNodes) throw new Error('RESOURCE_LIMIT');
    seen.add(id);
    check();
    const node = api.root.id === id ? api.root : await api.getNodeByIdAsync(id);
    check();
    if (!node || node.removed) {
      if (!(deletion && direct.has(id)) && !(['booleanNodes', 'combineVariants'].includes(step.op) && previousGroups.includes(id))) throw new Error('FIGMA_API_ERROR');
      result.push({ nodeId: id, deleted: true });
      continue;
    }
    const fields = new Set<string>(['name']);
    const createdParent = ['createComponent', 'createInstance'].includes(step.op) && id === (step.parent as any)?.nodeId;
    if (direct.has(id) && !createdParent) {
      for (const field of Object.keys((step.patch ?? step.properties ?? step.typography ?? {}) as object)) if (field !== 'layout') fields.add(field);
      if ((step.properties as any)?.layout) for (const field of Object.keys((step.properties as any).layout)) fields.add(field);
      if (step.op === 'setAutoLayout') for (const field of Object.keys(step.layout as object)) fields.add(field);
      if (step.op === 'setConstraints') fields.add('constraints');
      if (step.op === 'setLayoutSizing') { fields.add('layoutSizingHorizontal'); fields.add('layoutSizingVertical'); }
      if (step.op === 'setGeometry' && step.rotation !== undefined) fields.add('rotation');
      const targetId = (step.target as any)?.nodeId;
      if (id === targetId && step.op === 'setAppearance') for (const field of Object.keys(step.appearance as object)) fields.add(field);
      if (id === targetId && ['applyStyle', 'unbindStyle'].includes(step.op)) {
        fields.add(({ fills: 'fillStyleId', strokes: 'strokeStyleId', text: 'textStyleId', effects: 'effectStyleId', layoutGrids: 'gridStyleId' } as Record<string, string>)[step.property as string]);
        if (step.property !== 'text') fields.add(step.property as string);
        else if (node.type === 'TEXT' && !node.characters.length) for (const field of ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration']) if (field in node) fields.add(field);
      }
      if (id === targetId && ['bindVariable', 'unbindVariable'].includes(step.op)) { fields.add('boundVariables'); fields.add(['fontFamily', 'fontStyle', 'fontWeight'].includes(step.property as string) ? 'fontName' : step.property as string); }
      if (id === targetId && step.op === 'setNodeMode') fields.add('explicitVariableModes');
      if (id === targetId && ['setInstanceProperties', 'swapVariant'].includes(step.op)) { fields.add('componentProperties'); fields.add('overrides'); }
      if (step.op === 'combineVariants' && node.type === 'COMPONENT_SET' || step.op === 'setComponentProperties' && id === targetId) fields.add('componentPropertyDefinitions');
      if (step.op === 'importImage' && node.type === 'RECTANGLE') fields.add('fills');
    }
    const properties: Record<string, unknown> = {};
    for (const field of ['x', 'y', 'width', 'height', 'layoutMode']) if (field in node) fields.add(field);
    for (const field of fields) {
      const value = node[field];
      if (value === undefined || typeof value === 'symbol') throw new Error('FIGMA_API_ERROR');
      properties[field] = JSON.parse(JSON.stringify(value));
    }
    if (direct.has(id) && step.op === 'combineVariants' && node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') {
      const projection = projectNode(node, ['variantProperties', 'componentSet'], api.mixed);
      if (projection.unavailable.length || projection.mixed.length) throw new Error('FIGMA_API_ERROR');
      Object.assign(properties, projection.properties);
    }
    if (direct.has(id) && node.type === 'INSTANCE' && ['createInstance', 'setInstanceProperties', 'swapVariant'].includes(step.op)) {
      const main = await node.getMainComponentAsync(); check();
      properties.mainComponent = main ? { id: main.id, key: main.key, remote: main.remote } : null;
    }
    properties.parentId = node.parent?.id ?? null;
    if ('children' in node) properties.children = node.children.map((child: any) => child.id);
    if (node.type === 'TEXT' && direct.has(id)) {
      properties.characters = node.characters;
      if (node.characters.length) {
        if (typeof node.getStyledTextSegments !== 'function') throw new Error('FIGMA_API_ERROR');
        result.push({ nodeId: id, textSegments: JSON.parse(JSON.stringify(node.getStyledTextSegments(['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'fills', 'textStyleId', 'fillStyleId', 'boundVariables']))) });
      } else {
        if (!('fontName' in node) || typeof node.fontName === 'symbol') throw new Error('FIGMA_API_ERROR');
        properties.fontName = node.fontName;
      }
    }
    result.push({ nodeId: id, properties });
    if (node.parent?.id) queue.push(node.parent.id);
    if (node.type !== 'PAGE' && node.type !== 'DOCUMENT' && 'children' in node) for (const child of node.children) queue.push(child.id);
    if (!changes.nodeIds.includes(id)) changes.nodeIds.push(id);
    if (encodeURI(JSON.stringify(result)).replace(/%[A-F\d]{2}/g, 'x').length > Math.floor(limits.maxResponseBytes / limits.maxBatchSteps)) throw new Error('RESOURCE_LIMIT');
  }
  if (encodeURI(JSON.stringify(result)).replace(/%[A-F\d]{2}/g, 'x').length > Math.floor(limits.maxResponseBytes / limits.maxBatchSteps)) throw new Error('RESOURCE_LIMIT');
  return result;
}
