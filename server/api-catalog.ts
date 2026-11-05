import { McpServer, ProtocolError, ResourceTemplate } from '@modelcontextprotocol/server';
import { apiCatalog } from './api-catalog.generated';

const types: Record<string, { readonly pages: readonly string[]; readonly related: readonly string[] }> = apiCatalog.types;
const base = 'figma-api://';
const notes = 'Declarations describe pinned typings, not runtime support (unknown). Dynamic-page may require page.loadAsync(); load fonts before editing text. Check figma.mixed and instance restrictions; variable bindings require compatible types. Yield cooperatively; Stop is not a hard interruption.';
function result(uri: string, value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > 32768) throw new ProtocolError(-32603, 'API catalog page exceeds limit');
  return { contents: [{ uri, mimeType: 'application/json', text }] };
}
export function readApiCatalog(uri: string) {
  if (uri === `${base}index`) return result(uri, { typingsVersion: apiCatalog.typingsVersion, buildVersion: apiCatalog.buildVersion,
    sourceSha256: apiCatalog.sourceSha256, declarationCount: apiCatalog.declarationCount, runtimeSupport: 'unknown', notes,
    pages: apiCatalog.indexPages.map((_, i) => `${base}index/${i}`) });
  const index = /^figma-api:\/\/index\/(0|[1-9]\d*)$/.exec(uri);
  if (index) {
    const names = apiCatalog.indexPages[Number(index[1])];
    if (names) return result(uri, { names: names.map(name => ({ name, uri: `${base}types/${name}/0` })) });
  }
  const type = /^figma-api:\/\/types\/([A-Za-z_$][\w$]*)\/(0|[1-9]\d*)$/.exec(uri);
  if (type && Object.hasOwn(types, type[1])) {
    const declaration = types[type[1]], page = Number(type[2]);
    if (page < declaration.pages.length) return result(uri, { name: type[1], page, pages: declaration.pages.length,
      signature: declaration.pages[page], related: declaration.related.map(name => `${base}types/${name}/0`), runtimeSupport: 'unknown' });
  }
  throw new ProtocolError(-32602, 'Unknown API catalog resource');
}
export function registerApiCatalog(server: McpServer) {
  server.registerResource('figma-api-index', `${base}index`, { mimeType: 'application/json', description: 'Pinned Figma API declaration index; runtime support is unknown.' }, async uri => readApiCatalog(uri.href));
  server.registerResource('figma-api-index-page', new ResourceTemplate(`${base}index/{page}`, { list: undefined }), { mimeType: 'application/json' }, async uri => readApiCatalog(uri.href));
  server.registerResource('figma-api-type', new ResourceTemplate(`${base}types/{name}/{page}`, { list: undefined }), { mimeType: 'application/json' }, async uri => readApiCatalog(uri.href));
}
