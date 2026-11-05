# Plugin API catalog

The static catalog is available without a connected Figma document through MCP resources:

- `figma-api://index` lists catalog metadata, pinned typings and source SHA-256, and the index page URIs.
- `figma-api://index/0`, `figma-api://index/1`, ... list names and the first page URI for each declaration.
- `figma-api://types/InstanceNode/0`, `figma-api://types/InstanceNode/1`, ... return consecutive parts of the declaration, the total page count, and links to related types. Concatenate `signature` in page order for the complete declaration. Names and page numbers are exact allowlisted resource identifiers; they are not file paths.

Every serialized JSON resource is limited to 32 KiB. The generator checks the actual published JSON, including names, URIs, related links and metadata. The catalog is derived from `@figma/plugin-typings` 1.142.0; an unexpected source hash stops generation for review. A declaration is not proof of runtime availability: `runtimeSupport` is `unknown`; check the connected runtime's capabilities and actual editor context separately. Type links are lexical pointers for navigation, not a type checker or a guarantee of supported usage.

After installing the development dependencies with `npm ci`, run `npm run catalog:generate` to regenerate `server/api-catalog.generated.ts`. `npm run build:server` also generates it before bundling. `npm test` runs the catalog and examples checks once those scripts are included in the test command; these commands do not establish Figma Desktop behavior. See [execution examples](execution-examples.md) and [Desktop probe protocol](execution-probe.md).
