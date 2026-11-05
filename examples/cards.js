// Execute body. Select a section on the loaded current page. No instance is detached.
const root = args?.sectionId ? await figma.getNodeByIdAsync(args.sectionId) : figma.currentPage.selection[0];
if (!root || root.type !== 'SECTION') throw new Error('Select a section on the current page');
const stack = [...root.children], cards = [], skipped = [];
const skip = (id, reason) => { if (skipped.length < 100) skipped.push({ id, reason: reason.slice(0, 160) }); else skippedCount++; };
let visited = 0, skippedCount = 0, cardCount = 0;
const applyLayout = (node, layout) => {
  for (const [key, value] of Object.entries(layout || {})) {
    if (!['itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].includes(key) || !('layoutMode' in node) || node.layoutMode === 'NONE' || typeof value !== 'number' || !Number.isFinite(value)) {
      skip(node.id, `Unsupported layout: ${key}`); continue;
    }
    try { node[key] = value; } catch { skip(node.id, `Cannot set layout: ${key}`); }
  }
};
while (stack.length) {
  const node = stack.pop();
  if (++visited % 50 === 0) await execution.yield();
  if (node.type !== 'INSTANCE') {
    if ('children' in node) for (const child of node.children) stack.push(child);
    continue;
  }
  cardCount++;
  if (cards.length < 20) cards.push({ id: node.id, overrides: node.overrides.slice(0, 5).map(o => ({ id: o.id, fields: o.overriddenFields.slice(0, 5), fieldsTruncated: o.overriddenFields.length > 5 })), overridesTruncated: node.overrides.length > 5 });
  for (const [key, value] of Object.entries(args?.properties || {})) {
    if (!(key in node.componentProperties)) { skip(node.id, `Unknown component property: ${key}`); continue; }
    try { node.setProperties({ [key]: value }); } catch { skip(node.id, `Cannot set component property: ${key}`); }
  }
  applyLayout(node, args?.layout);
  if (args?.nestedLayout) {
    const { selector, layout } = args.nestedLayout;
    if (typeof selector !== 'string' || !selector || !layout || typeof layout !== 'object' || Array.isArray(layout)) {
      skip(node.id, 'nestedLayout requires a selector and layout object');
    } else {
      const descendants = [...node.children]; let matches = 0;
      while (descendants.length) {
        const child = descendants.pop();
        if (++visited % 50 === 0) await execution.yield();
        if (child.id === selector || child.name === selector) { matches++; applyLayout(child, layout); }
        if ('children' in child) descendants.push(...child.children);
      }
      if (!matches) skip(node.id, `Nested layout target not found: ${selector}`);
    }
  }
  for (const [field, id] of Object.entries(args?.bindings || {})) {
    if (!['opacity', 'itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].includes(field) || typeof id !== 'string' || (field !== 'opacity' && node.layoutMode === 'NONE')) {
      skip(node.id, `Unsupported binding: ${field}`); continue;
    }
    try {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (!variable || variable.resolvedType !== 'FLOAT') { skip(node.id, `Incompatible variable: ${field}`); continue; }
      node.setBoundVariable(field, variable);
    } catch { skip(node.id, `Cannot bind variable: ${field}`); }
  }
  if (args?.structuralChange) skip(node.id, 'Structural changes inside instances are not supported');
}
return { cardCount, cards, cardsTruncated: cardCount > cards.length, skipped, skippedCount: skipped.length + skippedCount };
