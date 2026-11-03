export type ReadableNode = {
  id: string;
  name: string;
  type: string;
  readonly children?: readonly ReadableNode[];
};

export type ReadLimits = { maxDepth: number; maxNodes: number; maxResponseBytes: number; chunkSize: number };
export type TreeContinuation = { children: readonly ReadableNode[]; index: number; depth: number }[];

export async function readTree(root: ReadableNode, limits: ReadLimits, options: {
  stopped?: () => boolean;
  yieldControl?: () => Promise<void>;
  continuation?: TreeContinuation;
} = {}) {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === 'maxDepth' ? 0 : 1)) throw new Error('INVALID_ARGUMENT');
  }
  if (limits.maxResponseBytes < 2) throw new Error('INVALID_ARGUMENT');
  const nodes: { nodeId: string; name: string; type: string; depth: number }[] = [];
  const frames: TreeContinuation = options.continuation?.map(frame => ({ ...frame })) ?? [{ children: [root], index: 0, depth: 0 }];
  let bytes = 2;
  let truncated = false;
  let depthCut = false;
  let cancelled = false;
  while (frames.length) {
    if (options.stopped?.()) { cancelled = true; break; }
    const frame = frames[frames.length - 1];
    if (frame.index >= frame.children.length) { frames.pop(); continue; }
    const node = frame.children[frame.index++];
    const row = { nodeId: node.id, name: node.name, type: node.type, depth: frame.depth };
    // Plugin main has no TextEncoder; count UTF-8 bytes including lone surrogate escaping.
    const rowBytes = encodeURI(JSON.stringify(row)).replace(/%[A-F\d]{2}/g, 'x').length;
    const nextBytes = bytes + rowBytes + (nodes.length ? 1 : 0);
    if (nodes.length >= limits.maxNodes || nextBytes > limits.maxResponseBytes) {
      frame.index--; truncated = true; break;
    }
    nodes.push(row);
    bytes = nextBytes;
    if (node.children?.length) {
      if (frame.depth < limits.maxDepth) frames.push({ children: node.children, index: 0, depth: frame.depth + 1 });
      else { truncated = true; depthCut = true; }
    }
    if (nodes.length % limits.chunkSize === 0) {
      await (options.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0))))();
    }
  }
  return { nodes, bytes, truncated: truncated || cancelled, depthCut, cancelled, continuation: frames };
}
