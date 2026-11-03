type Navigation = { pageId?: string; nodeIds: string[]; select: boolean; reveal: boolean };

export async function navigate(api: PluginAPI, query: Navigation, assertLive: () => void) {
  let target = query.pageId ? api.root.children.find(page => page.id === query.pageId) : undefined;
  if (query.pageId && !target) throw new Error('NODE_NOT_FOUND');
  const nodes: SceneNode[] = [];
  for (const id of query.nodeIds) {
    const node = await api.getNodeByIdAsync(id);
    assertLive();
    if (!node) throw new Error('NODE_NOT_FOUND');
    if (node.type === 'DOCUMENT' || node.type === 'PAGE') throw new Error('INVALID_ARGUMENT');
    let ancestor: BaseNode | null = node;
    while (ancestor && ancestor.type !== 'PAGE') ancestor = ancestor.parent;
    if (!ancestor || (target && target.id !== ancestor.id)) throw new Error('INVALID_ARGUMENT');
    target = ancestor as PageNode;
    nodes.push(node as SceneNode);
  }
  target ??= api.currentPage;
  await target.loadAsync();
  assertLive();
  if (target.id !== api.currentPage.id) {
    await api.setCurrentPageAsync(target);
    assertLive();
    if (api.currentPage.id !== target.id) throw new Error('SESSION_EXPIRED');
  }
  if (query.select) { assertLive(); api.currentPage.selection = nodes; }
  if (query.reveal && nodes.length) { assertLive(); api.viewport.scrollAndZoomIntoView(nodes); }
  return { currentPageId: api.currentPage.id, selection: api.currentPage.selection.map(node => node.id) };
}
