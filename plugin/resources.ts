import { SearchPager } from '../shared/tree-pager';
import { localResources, projectResource } from './projections';

type Kind = 'components' | 'styles' | 'collections' | 'variables';
type Scope = { sessionId: string; connectionGeneration: number };
type Query = { kind: Kind; ids?: string[]; fields: string[]; limit: number; cursor?: string };
type State = { query: string; expires: number; position: number; fingerprint?: string; searchCursor?: string };
type Limits = { maxDepth: number; maxNodes: number; maxResponseBytes: number; maxMessageBytes: number; resourceTtl: number };

export class ResourcePager {
  private cursors = new Map<string, State>();
  private sequence = 0;
  private search: SearchPager;
  constructor(private limits: Limits) {
    this.search = new SearchPager({ ...limits, chunkSize: 50 }, 100, limits.resourceTtl);
  }
  clear() { this.cursors.clear(); this.search.clear(); }
  async read(api: PluginAPI, query: Query, scope: Scope, now: number, revision: () => string,
    loadPage: (page: PageNode) => Promise<void>, yieldControl: () => Promise<void>) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.limits.maxNodes) throw new Error('RESOURCE_LIMIT');
    for (const [key, item] of this.cursors) if (item.expires <= now) this.cursors.delete(key);
    const signature = JSON.stringify([scope.sessionId, scope.connectionGeneration, query.kind, query.ids, query.fields, query.limit]);
    const state = query.cursor ? this.cursors.get(query.cursor) : undefined;
    if (query.cursor && (!state || state.query !== signature)) throw new Error('INVALID_CURSOR');
    if (!state && this.cursors.size >= 100) throw new Error('RESOURCE_LIMIT');
    const version = revision();
    let position = state?.position ?? 0, fingerprint: string | undefined, searchCursor: string | undefined;
    let resources: ReturnType<typeof projectResource>[] = [], more = false;
    if (query.kind === 'components') {
      const found = await this.search.read(api.root.children, undefined, undefined,
        { document: true, types: ['COMPONENT', 'COMPONENT_SET'], limit: 1, cursor: state?.searchCursor }, scope, revision, now,
        page => loadPage(page as PageNode), yieldControl);
      for (const row of found.nodes) {
        if (query.ids && !query.ids.includes(row.nodeId)) continue;
        const node = await api.getNodeByIdAsync(row.nodeId);
        if (!node) throw new Error('INVALID_CURSOR');
        if ('remote' in node && node.remote) continue;
        resources.push(projectResource('components', node, query.fields, api.mixed));
      }
      searchCursor = found.nextCursor; more = Boolean(searchCursor);
    } else {
      const all = (await localResources(api, query.kind)).filter(item => !query.ids || query.ids.includes(item.id));
      const projected: ReturnType<typeof projectResource>[] = [];
      const pieces: string[] = [];
      let bytes = 2;
      for (const item of all) {
        const projection = projectResource(query.kind, item, query.fields, api.mixed);
        const piece = JSON.stringify(projection);
        bytes += encodeURI(piece).replace(/%[A-F\d]{2}/g, 'x').length + (pieces.length ? 1 : 0);
        if (bytes > this.limits.maxMessageBytes) throw new Error('RESOURCE_LIMIT');
        projected.push(projection); pieces.push(piece);
        if (pieces.length % 50 === 0) await yieldControl();
      }
      fingerprint = `[${pieces.join(',')}]`;
      if (state && state.fingerprint !== fingerprint) throw new Error('INVALID_CURSOR');
      while (position < projected.length && resources.length < query.limit) {
        const next = [...resources, projected[position]];
        if (encodeURI(JSON.stringify({ resources: next })).replace(/%[A-F\d]{2}/g, 'x').length > this.limits.maxResponseBytes - 256) {
          if (!resources.length) throw new Error('RESOURCE_LIMIT');
          break;
        }
        resources = next; position++;
      }
      more = position < projected.length;
    }
    if (revision() !== version) throw new Error('INVALID_CURSOR');
    if (encodeURI(JSON.stringify({ resources })).replace(/%[A-F\d]{2}/g, 'x').length > this.limits.maxResponseBytes - 256) throw new Error('RESOURCE_LIMIT');
    if (query.cursor) this.cursors.delete(query.cursor);
    let nextCursor: string | undefined;
    if (more) {
      nextCursor = `${scope.sessionId}:resources:${++this.sequence}:${Math.random().toString(36).slice(2)}`;
      this.cursors.set(nextCursor, { query: signature, expires: now + this.limits.resourceTtl, position, fingerprint, searchCursor });
    }
    return { resources, truncated: more, ...(nextCursor ? { nextCursor } : {}) };
  }
}
