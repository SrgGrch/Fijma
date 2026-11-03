export async function loadDocumentRoot(api: PluginAPI, rootId: string) {
  const page = api.root.children.find(item => item.id === rootId);
  if (page) {
    await page.loadAsync();
    return { root: page, page };
  }
  const root = await api.getNodeByIdAsync(rootId);
  if (!root || root.type === 'DOCUMENT') throw new Error('NODE_NOT_FOUND');
  let ancestor: BaseNode | null = root;
  while (ancestor && ancestor.type !== 'PAGE') ancestor = ancestor.parent;
  if (!ancestor) throw new Error('NODE_NOT_FOUND');
  const owner = ancestor as PageNode;
  await owner.loadAsync();
  return { root, page: owner };
}
