import { readTree, type ReadableNode, type TreeContinuation, type ReadLimits } from './read-tree';

type Scope = { sessionId: string; connectionGeneration: number };
type Query = { rootId: string; depth: number; limit: number; cursor?: string };
type Stored = { query: string; revision: number; expires: number; continuation: TreeContinuation };

export class TreePager {
  private cursors = new Map<string, Stored>();
  private sequence = 0;
  constructor(private limits: ReadLimits, private maxCursors: number, private ttl: number) {
    if (!Number.isSafeInteger(maxCursors) || maxCursors < 1 || !Number.isSafeInteger(ttl) || ttl < 1) throw new Error('INVALID_ARGUMENT');
  }
  clear() { this.cursors.clear(); }
  async read(root: ReadableNode, query: Query, scope: Scope, revision: () => number, now: number, options: { yieldControl?: () => Promise<void> } = {}) {
    if (root.id !== query.rootId || !Number.isSafeInteger(query.depth) || query.depth < 0 || query.depth > this.limits.maxDepth ||
      !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.limits.maxNodes) throw new Error('INVALID_ARGUMENT');
    for (const [key, value] of this.cursors) if (value.expires <= now) this.cursors.delete(key);
    const signature = JSON.stringify([scope.sessionId, scope.connectionGeneration, query.rootId, query.depth, query.limit]);
    const version = revision();
    const stored = query.cursor ? this.cursors.get(query.cursor) : undefined;
    if (query.cursor && (!stored || stored.query !== signature || stored.revision !== version)) throw new Error('INVALID_CURSOR');
    if (!stored && this.cursors.size >= this.maxCursors) throw new Error('RESOURCE_LIMIT');
    const result = await readTree(root, { ...this.limits, maxDepth: query.depth, maxNodes: query.limit }, { ...options, continuation: stored?.continuation });
    if (revision() !== version) throw new Error('INVALID_CURSOR');
    if (!result.nodes.length && result.continuation.length) throw new Error('RESOURCE_LIMIT');
    // A consumed token cannot silently restart a traversal on retry.
    if (query.cursor) this.cursors.delete(query.cursor);
    let nextCursor: string | undefined;
    if (result.continuation.length) {
      nextCursor = `${scope.sessionId}:${++this.sequence}:${Math.random().toString(36).slice(2)}`;
      this.cursors.set(nextCursor, { query: signature, revision: version, expires: now + this.ttl, continuation: result.continuation });
    }
    return { nodes: result.nodes, truncated: result.truncated, ...(nextCursor ? { nextCursor } : {}) };
  }
}
