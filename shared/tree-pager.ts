import { readTree, type ReadableNode, type TreeContinuation, type ReadLimits } from './read-tree';

type Scope = { sessionId: string; connectionGeneration: number };
type Query = { rootId: string; depth: number; limit: number; cursor?: string };
type Stored = { query: string; revision: number | string; expires: number; continuation: TreeContinuation; depthCut: boolean };

export class TreePager {
  private cursors = new Map<string, Stored>();
  private sequence = 0;
  constructor(private limits: ReadLimits, private maxCursors: number, private ttl: number) {
    if (!Number.isSafeInteger(maxCursors) || maxCursors < 1 || !Number.isSafeInteger(ttl) || ttl < 1) throw new Error('INVALID_ARGUMENT');
  }
  clear() { this.cursors.clear(); }
  checkCursor(query: Query, scope: Scope, now: number) {
    if (!query.cursor) return;
    const stored = this.cursors.get(query.cursor);
    const signature = JSON.stringify([scope.sessionId, scope.connectionGeneration, query.rootId, query.depth, query.limit]);
    if (!stored || stored.expires <= now || stored.query !== signature) throw new Error('INVALID_CURSOR');
  }
  async read(root: ReadableNode, query: Query, scope: Scope, revision: () => number | string, now: number, options: { yieldControl?: () => Promise<void> } = {}) {
    if (root.id !== query.rootId || !Number.isSafeInteger(query.depth) || query.depth < 0 || query.depth > this.limits.maxDepth ||
      !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.limits.maxNodes) throw new Error('INVALID_ARGUMENT');
    for (const [key, value] of this.cursors) if (value.expires <= now) this.cursors.delete(key);
    const signature = JSON.stringify([scope.sessionId, scope.connectionGeneration, query.rootId, query.depth, query.limit]);
    const version = revision();
    const stored = query.cursor ? this.cursors.get(query.cursor) : undefined;
    if (query.cursor && (!stored || stored.query !== signature || stored.revision !== version)) throw new Error('INVALID_CURSOR');
    if (!stored && this.cursors.size >= this.maxCursors) throw new Error('RESOURCE_LIMIT');
    const result = await readTree(root, { ...this.limits, maxDepth: query.depth, maxNodes: query.limit,
      maxResponseBytes: this.limits.maxResponseBytes - 256 }, { ...options, continuation: stored?.continuation });
    if (revision() !== version) throw new Error('INVALID_CURSOR');
    if (!result.nodes.length && result.continuation.length) throw new Error('RESOURCE_LIMIT');
    // A consumed token cannot silently restart a traversal on retry.
    if (query.cursor) this.cursors.delete(query.cursor);
    let nextCursor: string | undefined;
    if (result.continuation.length) {
      nextCursor = `${scope.sessionId}:${++this.sequence}:${Math.random().toString(36).slice(2)}`;
      this.cursors.set(nextCursor, { query: signature, revision: version, expires: now + this.ttl, continuation: result.continuation, depthCut: Boolean(stored?.depthCut || result.depthCut) });
    }
    return { nodes: result.nodes, truncated: result.truncated || Boolean(stored?.depthCut), ...(nextCursor ? { nextCursor } : {}) };
  }
}

type SearchQuery = { rootId?: string; document?: true; name?: string; types?: string[]; limit: number; cursor?: string };
type SearchFrame = { children: readonly ReadableNode[]; index: number; depth: number; pageId: string };
type SearchState = { query: string; revision: string; expires: number; pageIndex: number; frames: SearchFrame[] };

export class SearchPager {
  private cursors = new Map<string, SearchState>();
  private sequence = 0;
  constructor(private limits: ReadLimits, private maxCursors: number, private ttl: number) {
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < (key === 'maxDepth' ? 0 : 1)) throw new Error('INVALID_ARGUMENT');
    }
    if (limits.maxResponseBytes < 258 || !Number.isSafeInteger(maxCursors) || maxCursors < 1 ||
      !Number.isSafeInteger(ttl) || ttl < 1) throw new Error('INVALID_ARGUMENT');
  }
  clear() { this.cursors.clear(); }
  extendCursor(cursor: string, now: number) {
    const state = this.cursors.get(cursor);
    if (!state || state.expires <= now) throw new Error('INVALID_CURSOR');
    state.expires = now + this.ttl;
  }
  checkCursor(query: SearchQuery, scope: Scope, now: number) {
    if (!query.cursor) return;
    const stored = this.cursors.get(query.cursor);
    const signature = JSON.stringify([scope.sessionId, scope.connectionGeneration, query.rootId, query.document, query.name, query.types, query.limit]);
    if (!stored || stored.expires <= now || stored.query !== signature) throw new Error('INVALID_CURSOR');
  }
  async read(pages: readonly ReadableNode[], root: ReadableNode | undefined, pageId: string | undefined,
    query: SearchQuery, scope: Scope, revision: () => string, now: number,
    loadPage: (page: ReadableNode) => Promise<void>, yieldControl: () => Promise<void>) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.limits.maxNodes) throw new Error('INVALID_ARGUMENT');
    for (const [key, value] of this.cursors) if (value.expires <= now) this.cursors.delete(key);
    const signature = JSON.stringify([scope.sessionId, scope.connectionGeneration, query.rootId, query.document, query.name, query.types, query.limit]);
    const version = revision();
    const stored = query.cursor ? this.cursors.get(query.cursor) : undefined;
    if (query.cursor && (!stored || stored.query !== signature || stored.revision !== version)) throw new Error('INVALID_CURSOR');
    if (!stored && this.cursors.size >= this.maxCursors) throw new Error('RESOURCE_LIMIT');
    const state: SearchState = stored ? { ...stored, frames: stored.frames.map(frame => ({ ...frame })) } : {
      query: signature, revision: version, expires: now + this.ttl, pageIndex: 0,
      frames: root && pageId ? [{ children: [root], index: 0, depth: 0, pageId }] : [],
    };
    const nodes: { nodeId: string; name: string; type: string; depth: number; pageId: string }[] = [];
    let bytes = 2, visited = 0;
    let windowDepth = state.frames.length ? state.frames[state.frames.length - 1].depth : 0;
    while (state.frames.length || (query.document && state.pageIndex < pages.length)) {
      if (!state.frames.length) {
        const page = pages[state.pageIndex++];
        await loadPage(page);
        if (revision() !== version) throw new Error('INVALID_CURSOR');
        state.frames.push({ children: [page], index: 0, depth: 0, pageId: page.id });
        windowDepth = 0;
      }
      const frame = state.frames[state.frames.length - 1];
      if (frame.index >= frame.children.length) { state.frames.pop(); continue; }
      const node = frame.children[frame.index++], depth = frame.depth;
      windowDepth = Math.min(windowDepth, depth);
      const matches = (query.name === undefined || node.name.includes(query.name)) && (!query.types || query.types.includes(node.type));
      const row = { nodeId: node.id, name: node.name, type: node.type, depth, pageId: frame.pageId };
      if (matches) {
        const rowBytes = encodeURI(JSON.stringify(row)).replace(/%[A-F\d]{2}/g, 'x').length;
        const nextBytes = bytes + rowBytes + (nodes.length ? 1 : 0);
        if (nodes.length >= query.limit || nextBytes > this.limits.maxResponseBytes - 256) {
          frame.index--;
          if (!nodes.length) throw new Error('RESOURCE_LIMIT');
          break;
        }
        nodes.push(row); bytes = nextBytes;
      }
      if (node.children?.length) {
        if (state.frames.length >= this.limits.maxNodes) throw new Error('RESOURCE_LIMIT');
        state.frames.push({ children: node.children, index: 0, depth: depth + 1, pageId: frame.pageId });
        if (depth - windowDepth >= this.limits.maxDepth) break;
      }
      if (++visited % this.limits.chunkSize === 0) {
        await yieldControl();
        if (revision() !== version) throw new Error('INVALID_CURSOR');
      }
      if (visited >= this.limits.maxNodes || nodes.length >= query.limit) break;
    }
    if (revision() !== version) throw new Error('INVALID_CURSOR');
    if (query.cursor) this.cursors.delete(query.cursor);
    const more = state.frames.length > 0 || Boolean(query.document && state.pageIndex < pages.length);
    let nextCursor: string | undefined;
    if (more) {
      nextCursor = `${scope.sessionId}:search:${++this.sequence}:${Math.random().toString(36).slice(2)}`;
      state.revision = version; state.expires = now + this.ttl; this.cursors.set(nextCursor, state);
    }
    return { nodes, truncated: more, ...(nextCursor ? { nextCursor } : {}) };
  }
}
