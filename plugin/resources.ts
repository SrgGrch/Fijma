import { SearchPager } from '../shared/tree-pager';
import { localResources, projectResource, resourceFingerprint } from './projections';

type Kind = 'components' | 'styles' | 'collections' | 'variables';
type Scope = { sessionId: string; connectionGeneration: number };
type Query = { kind: Kind; ids?: string[]; fields: string[]; limit: number; cursor?: string };
type State = { query: string; expires: number; position: number; fingerprint?: string; searchCursor?: string; pending?: string[]; revision?: string };
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
    if (state?.revision !== undefined && state.revision !== version) throw new Error('INVALID_CURSOR');
    let position = state?.position ?? 0, fingerprint: string | undefined, searchCursor: string | undefined;
    let pending: string[] | undefined;
    const resources: ReturnType<typeof projectResource>[] = [];
    const fits = (resource: ReturnType<typeof projectResource>) =>
      encodeURI(JSON.stringify({ resources: [...resources, resource] })).replace(/%[A-F\d]{2}/g, 'x').length <=
        Math.min(this.limits.maxResponseBytes, this.limits.maxMessageBytes) - 256;
    let more = false;
    if (query.kind === 'components') {
      if (query.ids) {
        const ids = [...new Set(query.ids)];
        const start = position;
        while (position < ids.length && resources.length < query.limit && position - start < this.limits.maxNodes) {
          if (position > start && (position - start) % 50 === 0) await yieldControl();
          const node = await api.getNodeByIdAsync(ids[position]);
          if (!node || !['COMPONENT', 'COMPONENT_SET'].includes(node.type) || ('remote' in node && node.remote)) { position++; continue; }
          const projection = projectResource('components', node, query.fields, api.mixed);
          if (!fits(projection)) { if (!resources.length) throw new Error('RESOURCE_LIMIT'); break; }
          resources.push(projection); position++;
        }
        more = position < ids.length;
      } else {
        pending = [...(state?.pending ?? [])];
        searchCursor = state?.searchCursor;
        if (!pending.length) {
          const found = await this.search.read(api.root.children, undefined, undefined,
            { document: true, types: ['COMPONENT', 'COMPONENT_SET'], limit: query.limit, cursor: searchCursor }, scope, revision, now,
            page => loadPage(page as PageNode), yieldControl);
          pending = found.nodes.map(row => row.nodeId);
          searchCursor = found.nextCursor;
        }
        let processed = 0;
        while (pending.length && resources.length < query.limit) {
          if (processed > 0 && processed % 50 === 0) await yieldControl();
          processed++;
          const node = await api.getNodeByIdAsync(pending[0]);
          if (!node) throw new Error('INVALID_CURSOR');
          if ('remote' in node && node.remote) { pending.shift(); continue; }
          const projection = projectResource('components', node, query.fields, api.mixed);
          if (!fits(projection)) { if (!resources.length) throw new Error('RESOURCE_LIMIT'); break; }
          resources.push(projection); pending.shift();
        }
        more = Boolean(pending.length || searchCursor);
      }
    } else {
      const all = (await localResources(api, query.kind)).filter(item => !query.ids || query.ids.includes(item.id));
      fingerprint = await resourceFingerprint(query.kind, all, query.fields, yieldControl);
      if (state && state.fingerprint !== fingerprint) throw new Error('INVALID_CURSOR');
      while (position < all.length && resources.length < query.limit) {
        const projection = projectResource(query.kind, all[position], query.fields, api.mixed);
        if (!fits(projection)) { if (!resources.length) throw new Error('RESOURCE_LIMIT'); break; }
        resources.push(projection); position++;
      }
      more = position < all.length;
    }
    if (revision() !== version) throw new Error('INVALID_CURSOR');
    if (encodeURI(JSON.stringify({ resources })).replace(/%[A-F\d]{2}/g, 'x').length > this.limits.maxResponseBytes - 256) throw new Error('RESOURCE_LIMIT');
    if (searchCursor) this.search.extendCursor(searchCursor, now);
    if (query.cursor) this.cursors.delete(query.cursor);
    let nextCursor: string | undefined;
    if (more) {
      nextCursor = `${scope.sessionId}:resources:${++this.sequence}:${Math.random().toString(36).slice(2)}`;
      this.cursors.set(nextCursor, { query: signature, expires: now + this.limits.resourceTtl, position, fingerprint, searchCursor, pending, revision: version });
    }
    return { resources, truncated: more, ...(nextCursor ? { nextCursor } : {}) };
  }
}
