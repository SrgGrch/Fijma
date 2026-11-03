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
const alias = obj({ type: z.literal('VARIABLE_ALIAS'), id });
const componentLink = obj({ id, key: z.string(), remote: z.boolean() }).nullable();
const preferredValues = z.array(obj({ type: z.enum(['COMPONENT', 'COMPONENT_SET']), key: id }));
const componentPropertyType = z.enum(['BOOLEAN', 'TEXT', 'INSTANCE_SWAP', 'VARIANT', 'SLOT']);
const componentProperties = z.record(id, obj({ type: componentPropertyType, value: z.union([z.string(), z.boolean()]), preferredValues: preferredValues.optional(), boundVariables: obj({ value: alias.optional() }).optional() }));
const componentPropertyDefinitions = z.record(id, obj({ type: componentPropertyType, defaultValue: z.union([z.string(), z.boolean()]), preferredValues: preferredValues.optional(), variantOptions: z.array(z.string()).optional(), description: z.string().optional(), slotSettings: obj({ stretchChildOnInsert: z.boolean().optional(), displayEmptyByDefault: z.boolean().optional(), minChildren: index.nullable().optional(), maxChildren: index.nullable().optional(), allowPreferredValuesOnly: z.boolean().optional() }).optional(), boundVariables: obj({ defaultValue: alias.optional() }).optional() }));
const componentFields = { mainComponent: componentLink.optional(), componentSet: componentLink.optional(), componentProperties: componentProperties.optional(), componentPropertyDefinitions: componentPropertyDefinitions.optional(), variantProperties: z.record(id, z.string()).nullable().optional() };
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
const rangeStyle = obj({
  fontName: font, fontSize: positive, lineHeight: typographyFields.lineHeight.unwrap(),
  letterSpacing: typographyFields.letterSpacing.unwrap(), textCase: typographyFields.textCase.unwrap(),
  textDecoration: typographyFields.textDecoration.unwrap(), fills: z.array(paint),
});
const rangePatch = rangeStyle.partial();
const appearance = obj(appearanceFields);
const layout = obj({ layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']).optional(), layoutWrap: z.enum(['NO_WRAP', 'WRAP']).optional(),
  paddingTop: n.nonnegative().optional(), paddingRight: n.nonnegative().optional(), paddingBottom: n.nonnegative().optional(), paddingLeft: n.nonnegative().optional(),
  itemSpacing: n.optional(), counterAxisSpacing: n.nonnegative().optional(),
  primaryAxisAlignItems: z.enum(['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN']).optional(), counterAxisAlignItems: z.enum(['MIN', 'MAX', 'CENTER', 'BASELINE']).optional(),
});
const common = { name: z.string().optional(), x: n.optional(), y: n.optional(), width: positive.optional(), height: positive.optional(), rotation: n.optional(), visible: z.boolean().optional(), locked: z.boolean().optional() };
const nodeTypes = ['FRAME', 'RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR', 'TEXT'] as const;
const properties = (type: typeof nodeTypes[number]) => obj({ ...common,
  ...Object.fromEntries(Object.entries(appearanceFields).filter(([key]) => {
    if (key === 'cornerRadius') return type !== 'LINE' && type !== 'TEXT';
    if (['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'].includes(key)) return type === 'FRAME' || type === 'RECTANGLE';
    return true;
  })),
  ...(type === 'TEXT' ? { ...typographyFields, characters: z.string().optional() } : {}),
  ...(type === 'FRAME' ? { layout: layout.optional() } : {}),
  ...(type === 'POLYGON' || type === 'STAR' ? { pointCount: z.number().int().min(3).optional() } : {}),
});
const expectedFields = { name: z.string().optional(), parentId: id.optional(), children: strings.optional(), characters: z.string().optional(),
  ...common, ...appearanceFields, ...typographyFields, ...componentFields, fillStyleId: z.string().optional(), strokeStyleId: z.string().optional(), textStyleId: z.string().optional(), effectStyleId: z.string().optional(),
  boundVariables: z.record(id, obj({ type: z.literal('VARIABLE_ALIAS'), id })).optional(),
  description: z.string().optional(), hiddenFromPublishing: z.boolean().optional(),
  type: z.enum(['PAINT', 'TEXT', 'EFFECT', 'GRID', 'BOOLEAN', 'STRING', 'FLOAT', 'COLOR']).optional(),
  paints: z.array(paint).optional(), layoutGrids: z.array(obj({ pattern: z.literal('GRID'), sectionSize: positive, color, visible: z.boolean().optional() })).optional(),
  modes: z.array(obj({ modeId: id, name: z.string() })).optional(),
  valuesByMode: z.record(id, z.union([z.string(), z.boolean(), n, color, obj({ type: z.literal('VARIABLE_ALIAS'), id })])).optional(),
  variableIds: strings.optional(), explicitVariableModes: z.record(id, id).optional(),
};
const relatedExpected = obj(expectedFields).refine(value => Object.keys(value).length > 0, 'expected must not be empty');
const expected = obj({ ...expectedFields, related: z.record(id, relatedExpected).optional() }).refine(value => Object.keys(value).length > 0 && (Object.keys(value).some(key => key !== 'related') || Object.keys(value.related ?? {}).length > 0), 'expected must not be empty');
const base = { stepId: id, expected: expected.optional() };
const step = (op: string, fields: Record<string, z.ZodType>) => obj({ ...base, op: z.literal(op), ...fields });
const target = { target: node }, parent = { parent: node };
const styleType = z.enum(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const styleProperty = z.enum(['fills', 'strokes', 'text', 'effects', 'layoutGrids']);
const grid = obj({ pattern: z.literal('GRID'), sectionSize: positive, color, visible: z.boolean().optional() });
const styleValue = z.union([obj({ paints: z.array(paint) }), typography, obj({ effects: z.array(effect) }), obj({ layoutGrids: z.array(grid) })]);
const variableValue = z.union([z.string(), z.boolean(), n, color]);
const composedColor = z.union([obj({ color, opacity: alias }), obj({ color: alias, opacity: z.union([n, alias]) })]);
const readBindings = z.record(id, z.union([alias, z.array(alias), z.record(id, alias)]));
const sourceColor = z.discriminatedUnion('space', [
  obj({ space: z.enum(['SRGB', 'DISPLAY_P3']), r: n, g: n, b: n }),
  obj({ space: z.literal('HSL'), h: n, s: n, l: n }), obj({ space: z.literal('HSB'), h: n, s: n, b: n }),
  obj({ space: z.literal('OKLAB'), l: n, a: n, b: n }), obj({ space: z.literal('OKLCH'), l: n, c: n, h: n }),
]);
const readColor = color.extend({ sourceColor: sourceColor.optional() });
const blendMode = z.enum(['PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY']);
const transform = z.tuple([z.tuple([n, n, n]), z.tuple([n, n, n])]);
const readPaintCommon = { visible: z.boolean().optional(), opacity: n.optional(), blendMode: blendMode.optional() };
const readPaint = z.discriminatedUnion('type', [
  obj({ type: z.literal('SOLID'), color: readColor, ...readPaintCommon, boundVariables: readBindings.optional() }),
  obj({ type: z.enum(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']), gradientTransform: transform,
    gradientStops: z.array(obj({ position: n, color: readColor, boundVariables: readBindings.optional() })), ...readPaintCommon }),
  obj({ type: z.literal('IMAGE'), imageHash: z.string().nullable(), scaleMode: z.enum(['FILL', 'FIT', 'CROP', 'TILE']), imageTransform: transform.optional(),
    scalingFactor: n.optional(), rotation: n.optional(), filters: obj({ exposure: n.optional(), contrast: n.optional(), saturation: n.optional(), temperature: n.optional(), tint: n.optional(), highlights: n.optional(), shadows: n.optional() }).optional(), ...readPaintCommon }),
]);
const readEffect = z.union([
  obj({ type: z.enum(['DROP_SHADOW', 'INNER_SHADOW']), color: readColor, offset: point, radius: n, spread: n.optional(), visible: z.boolean(), blendMode, showShadowBehindNode: z.boolean().optional(), boundVariables: readBindings.optional() }),
  obj({ type: z.enum(['LAYER_BLUR', 'BACKGROUND_BLUR']), radius: n, visible: z.boolean(), blurType: z.literal('NORMAL'), boundVariables: readBindings.optional() }),
  obj({ type: z.enum(['LAYER_BLUR', 'BACKGROUND_BLUR']), radius: n, visible: z.boolean(), blurType: z.literal('PROGRESSIVE'), startRadius: n, startOffset: point, endOffset: point, boundVariables: readBindings.optional() }),
]);
const readFont = font.extend({ variationSettings: z.record(z.string().regex(/^[\x20-\x7e]{4}$/), n).optional() });
const readTypographyFields = { ...typographyFields, fontName: readFont.optional() };
const textSegment = obj({ start: index, end: index, characters: z.string(), ...readTypographyFields, fills: z.array(readPaint).optional(), textStyleId: z.string().optional(), boundVariables: readBindings.optional() }).refine(v => v.end >= v.start);
const readGrid = z.discriminatedUnion('pattern', [
  obj({ pattern: z.literal('GRID'), sectionSize: n, visible: z.boolean().optional(), color: readColor.optional(), boundVariables: readBindings.optional() }),
  obj({ pattern: z.enum(['ROWS', 'COLUMNS']), alignment: z.enum(['MIN', 'MAX', 'STRETCH', 'CENTER']), gutterSize: n, count: n, sectionSize: n.optional(), offset: n.optional(), visible: z.boolean().optional(), color: readColor.optional(), boundVariables: readBindings.optional() }),
]);
const bindingField = z.enum(['height', 'width', 'characters', 'itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'visible', 'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'counterAxisSpacing', 'strokeWeight', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'opacity', 'gridRowGap', 'gridColumnGap', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing', 'lineHeight', 'paragraphSpacing', 'paragraphIndent']);
const matchesVariableType = (type: string, value: unknown) => {
  if (alias.safeParse(value).success) return true;
  switch (type) {
    case 'BOOLEAN': return typeof value === 'boolean';
    case 'STRING': return typeof value === 'string';
    case 'FLOAT': return typeof value === 'number' && Number.isFinite(value);
    case 'COLOR': return color.safeParse(value).success || composedColor.safeParse(value).success;
    default: return false;
  }
};
const styleMatches = (type: string, value: unknown) => {
  const field: Record<string, string> = { PAINT: 'paints', EFFECT: 'effects', GRID: 'layoutGrids' };
  return type === 'TEXT' ? typography.safeParse(value).success : !!value && typeof value === 'object' && field[type] in value;
};
export const nodeProjectionSchema = obj({ ...common, width: n.nonnegative().optional(), height: n.nonnegative().optional(), ...appearanceFields, ...readTypographyFields, ...componentFields,
  fills: z.array(readPaint).optional(), strokes: z.array(readPaint).optional(), effects: z.array(readEffect).optional(), textSegments: z.array(textSegment).optional(),
  characters: z.string().optional(), parentId: id.nullable().optional(), children: strings.optional(),
  layout: layout.optional(), fillStyleId: z.string().optional(), strokeStyleId: z.string().optional(),
  textStyleId: z.string().optional(), effectStyleId: z.string().optional(),
  boundVariables: readBindings.optional(), explicitVariableModes: z.record(id, id).optional(),
});
const readStyleValue = z.union([obj({ paints: z.array(readPaint) }), obj(readTypographyFields), obj({ effects: z.array(readEffect) }), obj({ layoutGrids: z.array(readGrid) })]);
export const resourceProjectionSchemas = {
  components: obj({ name: z.string().optional(), description: z.string().optional(), key: z.string().optional(), remote: z.boolean().optional(), parentId: id.nullable().optional(), ...componentFields }),
  styles: obj({ name: z.string().optional(), description: z.string().optional(), key: z.string().optional(), remote: z.boolean().optional(), type: styleType.optional(), value: readStyleValue.optional(), boundVariables: readBindings.optional() }).refine(v => !v.type || !v.value || (v.type === 'TEXT' ? obj(readTypographyFields).safeParse(v.value).success : styleMatches(v.type, v.value))),
  collections: obj({ name: z.string().optional(), modes: z.array(obj({ modeId: id, name: z.string() })).optional(), defaultModeId: id.optional(), variableIds: strings.optional(), remote: z.boolean().optional() }),
  variables: obj({ name: z.string().optional(), description: z.string().optional(), collectionId: id.optional(), type: z.enum(['BOOLEAN', 'STRING', 'FLOAT', 'COLOR']).optional(), valuesByMode: z.record(id, z.union([variableValue, alias, composedColor])).optional(), hiddenFromPublishing: z.boolean().optional(), remote: z.boolean().optional() }).refine(v => !v.type || !v.valuesByMode || Object.values(v.valuesByMode).every(value => matchesVariableType(v.type!, value))),
};
const definitions = z.record(id, z.discriminatedUnion('type', [
  obj({ type: z.literal('BOOLEAN'), defaultValue: z.boolean() }),
  obj({ type: z.enum(['TEXT', 'INSTANCE_SWAP', 'VARIANT']), defaultValue: z.string() }),
]));
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
  step('replaceTextRange', { ...target, start: index, end: index, text: z.string(), insertionFormatting: z.union([obj({ inherit: z.enum(['BEFORE', 'AFTER']), format: rangePatch.optional() }), obj({ format: rangeStyle })]) }),
  step('formatTextRange', { ...target, start: index, end: index, format: rangePatch }),
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
  step('bindVariable', { ...target, property: bindingField, variableId: variable }), step('unbindVariable', { ...target, property: bindingField }), step('setNodeMode', { ...target, collectionId: collection, modeId: mode }),
];
export const stepSchema = z.union(operations as [z.ZodType, z.ZodType, ...z.ZodType[]]).superRefine((raw, ctx) => {
  const value = raw as Record<string, any>;
  const mutable = ['target', 'targets', 'pageId', 'styleId', 'variableId', 'collectionId'];
  const creates = ['createPage', 'createNode', 'createText', 'importImage', 'importSvg', 'createComponent', 'createInstance', 'createStyle', 'createCollection'];
  if (!creates.includes(value.op) && mutable.some(key => {
    const refs = Array.isArray(value[key]) ? value[key] : [value[key]];
    return refs.some((ref: any) => typeof ref === 'string' || ref && 'nodeId' in ref);
  }) && !value.expected) ctx.addIssue({ code: 'custom', message: 'expected required for existing object' });
  if (value.start !== undefined && value.end < value.start) ctx.addIssue({ code: 'custom', message: 'Invalid text range' });
  if (value.op === 'createStyle') {
    if (!styleMatches(value.type, value.value)) {
      ctx.addIssue({ code: 'custom', message: 'Style value does not match type' });
    }
  }
});
export const batchSchema = z.array(stepSchema).min(1).superRefine((steps, ctx) => {
  try { validateBatchRefs(steps as never); } catch { ctx.addIssue({ code: 'custom', message: 'INVALID_ARGUMENT: batch refs' }); }
});
export const operationIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const scoped = { scope: scopeSchema };
const resourceInput = (kind: keyof typeof resourceProjectionSchemas) => obj({ ...scoped, kind: z.literal(kind), ids: strings.optional(), fields: z.array(resourceProjectionSchemas[kind].keyof()).min(1), limit: z.number().int().positive(), cursor: id.optional() });
export const toolInputs = {
  figma_get_context: obj({}),
  figma_get_tree: obj({ ...scoped, rootId: id, depth: index, limit: z.number().int().positive(), cursor: id.optional() }),
  figma_find_nodes: obj({ ...scoped, rootId: id.optional(), document: z.literal(true).optional(), name: z.string().optional(), types: strings.optional(), limit: z.number().int().positive(), cursor: id.optional() }).refine(v => Boolean(v.rootId) !== Boolean(v.document)),
  figma_get_nodes: obj({ ...scoped, nodeIds: strings.min(1), fields: z.array(nodeProjectionSchema.keyof()).min(1) }),
  figma_get_local_resources: z.discriminatedUnion('kind', [resourceInput('components'), resourceInput('styles'), resourceInput('collections'), resourceInput('variables')]),
  figma_navigate: obj({ ...scoped, pageId: id.optional(), nodeIds: strings, select: z.boolean(), reveal: z.boolean() }),
  figma_apply_batch: obj({ ...scoped, operationId: operationIdSchema, steps: batchSchema }),
  figma_get_operation: obj({ ...scoped, operationId: operationIdSchema }),
  figma_cancel_operation: obj({ ...scoped, operationId: operationIdSchema }),
  figma_export_node: obj({ ...scoped, nodeId: id, format: z.enum(['PNG', 'SVG']), scale: positive.optional() }),
};
export const errorSchema = obj({ code: z.enum(['NOT_CONNECTED', 'AUTH_FAILED', 'SESSION_BUSY', 'PROTOCOL_MISMATCH', 'SESSION_EXPIRED', 'DOCUMENT_MISMATCH', 'INVALID_ARGUMENT', 'INVALID_CURSOR', 'NODE_NOT_FOUND', 'CAPABILITY_UNAVAILABLE', 'FONT_UNAVAILABLE', 'CONFLICT', 'OPERATION_ID_CONFLICT', 'OPERATION_EXPIRED', 'RESOURCE_LIMIT', 'RESOURCE_EXPIRED', 'WRITE_DISABLED', 'FIGMA_API_ERROR', 'OUTCOME_UNKNOWN']), message: z.string(), failedStep: id.optional(), details: z.record(z.string(), z.json()).optional(), recoveryAction: z.string() });
export const toolErrorSchema = obj({ error: errorSchema });
