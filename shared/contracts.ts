import { z } from 'zod';
import { validateBatchRefs } from './batch-refs';

const obj = z.strictObject;
const id = z.string().min(1);
const n = z.number().finite();
const positive = n.positive();
const index = z.number().int().nonnegative();
const strings = z.array(id);
export const scopeSchema = obj({ sessionId: id, connectionGeneration: z.number().int().positive() });
const stepRef = (output: string) => obj({ stepId: id, output: z.literal(output) });
const node = z.union([obj({ nodeId: id }), stepRef('nodeId')]);
const resource = (kind: string) => z.union([id, stepRef(kind)]);
const style = resource('styleId'), collection = resource('collectionId'), mode = resource('modeId'), variable = resource('variableId');
const color = obj({ r: n.min(0).max(1), g: n.min(0).max(1), b: n.min(0).max(1), a: n.min(0).max(1).optional() });
const point = obj({ x: n, y: n });
const font = obj({ family: id, style: id });
const stops = z.array(obj({ position: n.min(0).max(1), color })).min(2);
const paint = z.discriminatedUnion('type', [
  obj({ type: z.literal('SOLID'), color, opacity: n.min(0).max(1).optional(), visible: z.boolean().optional() }),
  obj({ type: z.enum(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']), gradientStops: stops,
    gradientTransform: z.tuple([z.tuple([n, n, n]), z.tuple([n, n, n])]), opacity: n.min(0).max(1).optional(), visible: z.boolean().optional() }),
  obj({ type: z.literal('IMAGE'), imageHash: id, scaleMode: z.enum(['FILL', 'FIT', 'CROP', 'TILE']) }),
]);
const effect = z.discriminatedUnion('type', [
  obj({ type: z.enum(['DROP_SHADOW', 'INNER_SHADOW']), color, offset: point, radius: n.nonnegative(), spread: n.optional(), visible: z.boolean().optional(), blendMode: z.enum(['NORMAL', 'MULTIPLY', 'SCREEN']).optional() }),
  obj({ type: z.enum(['LAYER_BLUR', 'BACKGROUND_BLUR']), radius: n.nonnegative(), visible: z.boolean().optional() }),
]);
const appearanceFields = {
  fills: z.array(paint).optional(), strokes: z.array(paint).optional(), effects: z.array(effect).optional(),
  opacity: n.min(0).max(1).optional(), strokeWeight: n.nonnegative().optional(),
  cornerRadius: n.nonnegative().optional(), topLeftRadius: n.nonnegative().optional(), topRightRadius: n.nonnegative().optional(),
  bottomLeftRadius: n.nonnegative().optional(), bottomRightRadius: n.nonnegative().optional(),
};
const typographyFields = {
  fontName: font.optional(), fontSize: positive.optional(),
  lineHeight: z.union([obj({ unit: z.literal('AUTO') }), obj({ unit: z.enum(['PIXELS', 'PERCENT']), value: positive })]).optional(),
  letterSpacing: obj({ unit: z.enum(['PIXELS', 'PERCENT']), value: n }).optional(),
  textAlignHorizontal: z.enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']).optional(),
  textAlignVertical: z.enum(['TOP', 'CENTER', 'BOTTOM']).optional(),
  textCase: z.enum(['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS', 'SMALL_CAPS_FORCED']).optional(),
  textDecoration: z.enum(['NONE', 'UNDERLINE', 'STRIKETHROUGH']).optional(),
  textAutoResize: z.enum(['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE']).optional(),
};
const typography = obj(typographyFields);
const appearance = obj(appearanceFields);
const layout = obj({ layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']).optional(), layoutWrap: z.enum(['NO_WRAP', 'WRAP']).optional(),
  paddingTop: n.nonnegative().optional(), paddingRight: n.nonnegative().optional(), paddingBottom: n.nonnegative().optional(), paddingLeft: n.nonnegative().optional(),
  itemSpacing: n.optional(), counterAxisSpacing: n.nonnegative().optional(),
  primaryAxisAlignItems: z.enum(['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN']).optional(), counterAxisAlignItems: z.enum(['MIN', 'MAX', 'CENTER', 'BASELINE']).optional(),
});
const common = { name: z.string().optional(), x: n.optional(), y: n.optional(), width: positive.optional(), height: positive.optional(), rotation: n.optional(), visible: z.boolean().optional(), locked: z.boolean().optional() };
const nodeTypes = ['FRAME', 'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'TEXT'] as const;
const properties = (type: typeof nodeTypes[number]) => obj({ ...common,
  ...Object.fromEntries(Object.entries(appearanceFields).filter(([key]) => type !== 'LINE' || !key.toLowerCase().includes('radius'))),
  ...(type === 'TEXT' ? { ...typographyFields, characters: z.string().optional() } : {}),
  ...(type === 'FRAME' ? { layout: layout.optional() } : {}),
  ...(type === 'POLYGON' || type === 'STAR' ? { pointCount: z.number().int().min(3).optional() } : {}),
});
const expected = obj({ name: z.string().optional(), parentId: id.optional(), children: strings.optional(), characters: z.string().optional(),
  ...common, ...appearanceFields, ...typographyFields, fillStyleId: z.string().optional(), strokeStyleId: z.string().optional(), textStyleId: z.string().optional(), effectStyleId: z.string().optional(),
  boundVariables: z.record(id, obj({ type: z.literal('VARIABLE_ALIAS'), id })).optional(),
}).refine(value => Object.keys(value).length > 0, 'expected must not be empty');
const base = { stepId: id, expected: expected.optional() };
const step = (op: string, fields: Record<string, z.ZodType>) => obj({ ...base, op: z.literal(op), ...fields });
const target = { target: node }, parent = { parent: node };
const styleType = z.enum(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const styleProperty = z.enum(['fills', 'strokes', 'text', 'effects', 'layoutGrids']);
const grid = obj({ pattern: z.literal('GRID'), sectionSize: positive, color, visible: z.boolean().optional() });
const styleValue = z.union([obj({ paints: z.array(paint) }), typography, obj({ effects: z.array(effect) }), obj({ layoutGrids: z.array(grid) })]);
const variableValue = z.union([z.string(), z.boolean(), n, color]);
const definitions = z.record(id, obj({ type: z.enum(['BOOLEAN', 'TEXT', 'INSTANCE_SWAP', 'VARIANT']), defaultValue: z.union([z.string(), z.boolean()]) }));
const operations = [
  step('createPage', { name: z.string() }), step('renamePage', { pageId: node, name: z.string() }),
  step('clonePage', { pageId: node, name: z.string().optional() }), step('movePage', { pageId: node, index }), step('deletePage', { pageId: node }),
  ...nodeTypes.map(type => step('createNode', { type: z.literal(type), ...parent, properties: properties(type) })),
  ...nodeTypes.map(type => step('updateNode', { type: z.literal(type), ...target, patch: properties(type) })),
  step('cloneNode', { ...target, ...parent, index: index.optional() }), step('deleteNode', target), step('moveNode', { ...target, ...parent, index }),
  step('groupNodes', { targets: z.array(node).min(1), ...parent }), step('ungroupNode', target),
  step('setGeometry', { ...target, position: point.optional(), size: obj({ width: positive, height: positive }).optional(), rotation: n.optional() }),
  step('setConstraints', { ...target, value: obj({ horizontal: z.enum(['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE']), vertical: z.enum(['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE']) }) }),
  step('setAutoLayout', { ...target, layout }), step('setLayoutSizing', { ...target, sizing: obj({ horizontal: z.enum(['FIXED', 'HUG', 'FILL']), vertical: z.enum(['FIXED', 'HUG', 'FILL']) }) }),
  step('createText', { ...parent, characters: z.string(), font, typography }), step('setText', { ...target, characters: z.string() }),
  step('replaceTextRange', { ...target, start: index, end: index, text: z.string(), insertionFormatting: z.union([obj({ inherit: z.enum(['BEFORE', 'AFTER']) }), obj({ format: typography })]) }),
  step('formatTextRange', { ...target, start: index, end: index, format: obj({ ...typographyFields, fills: z.array(paint).optional() }) }),
  step('setAppearance', { ...target, appearance }), step('importImage', { data: id, mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), ...parent, placement: obj({ x: n, y: n, width: positive, height: positive }) }),
  step('importSvg', { svg: id, ...parent }), step('booleanNodes', { kind: z.enum(['union', 'subtract', 'intersect', 'exclude']), targets: z.array(node).min(2), ...parent }),
  step('createComponent', { ...parent, properties: properties('FRAME') }), step('componentFromNode', target), step('combineVariants', { targets: z.array(node).min(2), ...parent }),
  step('setComponentProperties', { ...target, definitions }), step('createInstance', { componentId: node, ...parent }),
  step('setInstanceProperties', { ...target, values: z.record(id, z.union([z.string(), z.boolean()])) }), step('swapVariant', { ...target, componentId: node }), step('detachInstance', target),
  step('createStyle', { type: styleType, name: z.string(), value: styleValue }), step('updateStyle', { styleId: style, patch: obj({ name: z.string().optional(), value: styleValue.optional() }) }),
  step('applyStyle', { ...target, property: styleProperty, styleId: style }), step('unbindStyle', { ...target, property: styleProperty }), step('deleteStyle', { styleId: style }),
  step('createCollection', { name: z.string() }), step('updateCollection', { collectionId: collection, patch: obj({ name: z.string() }) }), step('deleteCollection', { collectionId: collection }),
  step('createMode', { collectionId: collection, name: z.string() }), step('renameMode', { collectionId: collection, modeId: mode, name: z.string() }), step('deleteMode', { collectionId: collection, modeId: mode }),
  step('createVariable', { collectionId: collection, name: z.string(), type: z.enum(['BOOLEAN', 'STRING', 'FLOAT', 'COLOR']) }),
  step('updateVariable', { variableId: variable, patch: obj({ name: z.string().optional(), description: z.string().optional(), hiddenFromPublishing: z.boolean().optional() }) }),
  step('deleteVariable', { variableId: variable }), step('setVariableValue', { variableId: variable, modeId: mode, value: variableValue }),
  step('setVariableAlias', { variableId: variable, modeId: mode, targetVariableId: variable }),
  step('bindVariable', { ...target, property: id, variableId: variable }), step('unbindVariable', { ...target, property: id }), step('setNodeMode', { ...target, collectionId: collection, modeId: mode }),
];
export const stepSchema = z.union(operations as [z.ZodType, z.ZodType, ...z.ZodType[]]).superRefine((raw, ctx) => {
  const value = raw as Record<string, any>;
  const mutable = ['target', 'targets', 'pageId', 'styleId', 'variableId', 'collectionId'];
  const creates = ['createPage', 'createNode', 'createText', 'importImage', 'importSvg', 'createComponent', 'createInstance', 'createStyle', 'createCollection', 'createVariable'];
  if (!creates.includes(value.op) && mutable.some(key => {
    const refs = Array.isArray(value[key]) ? value[key] : [value[key]];
    return refs.some((ref: any) => typeof ref === 'string' || ref && 'nodeId' in ref);
  }) && !value.expected) ctx.addIssue({ code: 'custom', message: 'expected required for existing object' });
  if (value.start !== undefined && value.end < value.start) ctx.addIssue({ code: 'custom', message: 'Invalid text range' });
  if (value.op === 'createStyle') {
    const keys: Record<string, string> = { PAINT: 'paints', EFFECT: 'effects', GRID: 'layoutGrids' };
    if (keys[value.type] && !(keys[value.type] in value.value) || value.type === 'TEXT' && !typography.safeParse(value.value).success) {
      ctx.addIssue({ code: 'custom', message: 'Style value does not match type' });
    }
  }
});
export const batchSchema = z.array(stepSchema).min(1).superRefine((steps, ctx) => {
  try { validateBatchRefs(steps as never); } catch { ctx.addIssue({ code: 'custom', message: 'INVALID_ARGUMENT: batch refs' }); }
});
export const operationIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const scoped = { scope: scopeSchema };
export const toolInputs = {
  figma_get_context: obj({}),
  figma_get_tree: obj({ ...scoped, rootId: id, depth: index, limit: z.number().int().positive(), cursor: id.optional() }),
  figma_find_nodes: obj({ ...scoped, rootId: id.optional(), document: z.literal(true).optional(), name: z.string().optional(), types: strings.optional(), limit: z.number().int().positive(), cursor: id.optional() }).refine(v => Boolean(v.rootId) !== Boolean(v.document)),
  figma_get_nodes: obj({ ...scoped, nodeIds: strings.min(1), fields: strings.min(1) }),
  figma_get_local_resources: obj({ ...scoped, kind: z.enum(['components', 'styles', 'collections', 'variables']), ids: strings.optional(), fields: strings.min(1), limit: z.number().int().positive(), cursor: id.optional() }),
  figma_navigate: obj({ ...scoped, pageId: id.optional(), nodeIds: strings, select: z.boolean(), reveal: z.boolean() }),
  figma_apply_batch: obj({ ...scoped, operationId: operationIdSchema, steps: batchSchema }),
  figma_get_operation: obj({ ...scoped, operationId: operationIdSchema }),
  figma_cancel_operation: obj({ ...scoped, operationId: operationIdSchema }),
  figma_export_node: obj({ ...scoped, nodeId: id, format: z.enum(['PNG', 'SVG']), scale: positive.optional() }),
};
export const errorSchema = obj({ code: z.enum(['NOT_CONNECTED', 'AUTH_FAILED', 'SESSION_BUSY', 'PROTOCOL_MISMATCH', 'SESSION_EXPIRED', 'DOCUMENT_MISMATCH', 'INVALID_ARGUMENT', 'INVALID_CURSOR', 'NODE_NOT_FOUND', 'CAPABILITY_UNAVAILABLE', 'FONT_UNAVAILABLE', 'CONFLICT', 'OPERATION_ID_CONFLICT', 'OPERATION_EXPIRED', 'RESOURCE_LIMIT', 'RESOURCE_EXPIRED', 'WRITE_DISABLED', 'FIGMA_API_ERROR', 'OUTCOME_UNKNOWN']), message: z.string(), failedStep: id.optional(), recoveryAction: z.string() });
export const toolErrorSchema = obj({ error: errorSchema });
