// Execute body. By default inspect the current page; sectionId narrows the scope.
await figma.currentPage.loadAsync();
const root = args?.sectionId ? await figma.getNodeByIdAsync(args.sectionId) : figma.currentPage;
if (!root || (args?.sectionId && root.type !== 'SECTION')) throw new Error('sectionId must identify a section');
const counts = new Map(), stack = [root];
let visited = 0, textNodes = 0, segments = 0;
while (stack.length) {
  const node = stack.pop();
  if (++visited % 50 === 0) await execution.yield();
  if (node.type === 'TEXT') {
    textNodes++;
    for (const segment of node.getStyledTextSegments(['fontName', 'fontSize', 'lineHeight'])) {
      if (++segments % 50 === 0) await execution.yield();
      const key = JSON.stringify({ fontName: segment.fontName, fontSize: segment.fontSize, lineHeight: segment.lineHeight });
      counts.set(key, (counts.get(key) || 0) + (segment.end - segment.start));
    }
  }
  if ('children' in node) for (const child of node.children) stack.push(child);
}
const combinations = [...counts].map(([key, characters]) => ({ ...JSON.parse(key), characters }));
combinations.sort((a, b) => b.characters - a.characters || JSON.stringify(a).localeCompare(JSON.stringify(b)));
return { textNodes, uniqueCombinations: combinations.length, combinations: combinations.slice(0, 100), truncated: combinations.length > 100 };
