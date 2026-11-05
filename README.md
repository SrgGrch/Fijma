# Fijma

English | [Русский](README.ru.md)

A local MCP bridge for reading and editing an open Design file in Figma Desktop. The MCP client gets structured tools for nodes, pages, local styles and variables, batch changes, and PNG/SVG exports. An optional trusted JavaScript/TypeScript executor provides full access to the pinned file after separate permission in the plugin UI.

## Requirements

- Node.js 20+ and npm.
- Figma Desktop with access to **Plugins → Development**.
- An MCP client that supports a local stdio server.

The project currently installs from source: there is no published npm package.

Fijma keeps the existing `figma_*` tool names, plugin ID, `FIGMA_MCP_*` environment variables, and `.figma-mcp-bridge` pairing directory for compatibility. Existing client configurations continue to work; new examples use `fijma` as the connection name.

## Installation

```powershell
git clone https://github.com/SrgGrch/Fijma.git
cd Fijma
npm ci
npm run build
```

Open a Design file in Figma Desktop. Select **Plugins → Development → Import plugin from manifest** and choose the absolute path to `dist/plugin/manifest.json`. Run **Fijma**.

Then connect the MCP server to your client. In the examples below, replace `C:\path\to\Fijma` with the absolute path to your cloned project. Backslashes are doubled in JSON. Node.js must be available in the client's `PATH`; specify the absolute path to `node.exe` if needed.

### Codex CLI / Codex Desktop

Add the following to `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.fijma]
command = "node"
args = ['C:\path\to\Fijma\dist\server\index.js']
```

Both CLI and Desktop read this configuration. In the CLI, you can also run `codex mcp add fijma -- node C:\path\to\Fijma\dist\server\index.js`. [Codex MCP documentation](https://developers.openai.com/codex/mcp/).

### Claude Code

Run this in the project directory:

```powershell
claude mcp add --transport stdio --scope local fijma -- node C:\path\to\Fijma\dist\server\index.js
```

`local` ties the configuration to the current project. Use `--scope user` for all projects. [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

### Cursor

Create `.cursor/mcp.json` in the project or `%USERPROFILE%\.cursor\mcp.json` for all projects:

```json
{
  "mcpServers": {
    "fijma": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\Fijma\\dist\\server\\index.js"]
    }
  }
}
```

[Cursor MCP documentation](https://cursor.com/docs/mcp).

### Gemini CLI

Run:

```powershell
gemini mcp add fijma node C:\path\to\Fijma\dist\server\index.js
```

Alternatively, add the same `mcpServers` object with `command` and `args` to `%USERPROFILE%\.gemini\settings.json`. [Gemini CLI MCP documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md).

### Pairing and your first request

Restart or refresh the client's MCP connection. The adapter automatically starts the shared local bridge. It prints the path to `pairing-secret.txt` to stderr. If the client does not show stderr, run `node scripts/manual-client.mjs` from the project root: it displays the path and lets you send MCP requests as one JSON object per line.

Open the key file locally, paste it into the plugin panel, and click **«Подключиться и запомнить»** (“Connect and remember”). Do not send the key in chat. Call `figma_get_context`: the status should be `ready`, and the document name should match the intended file. Enable the toggle in the plugin panel to allow writes; writes are disabled again on a new connection. Other tools use the `scope` (`sessionId` and `connectionGeneration`) from the current context. See [launch and pairing](docs/launch.md) for details.

## Building locally

```powershell
npm ci
npm run build
npm test
```

`npm run build` creates `dist/server/index.js` and the plugin files in `dist/plugin/`. `npm test` runs automated checks, including communication through the MCP SDK and loopback WebSocket with simulated Figma behavior. After updating the build, close the plugin window, stop the old shared process with `npm run stop`, then restart the plugin and MCP connection.

## How it works

```text
MCP client ── stdio ── adapter ── shared local bridge ── WebSocket ── plugin UI ── Figma Plugin API
```

Each client starts its own stdio adapter; the shared bridge listens only on `127.0.0.1:55263` and serves one paired plugin connection. Document commands use a shared bounded FIFO queue; idle clients do not block others. Status and cancellation bypass the queue for the submitting client. An uncertain write blocks new commands with `RECOVERY_REQUIRED` until completion is confirmed or the plugin is restarted. The pairing secret is stored locally, and the plugin remembers it in `figma.clientStorage`.

Reading is available after pairing. Writes are enabled in the plugin UI for the pinned document and run in sequential batches with preconditions and result verification. Stop cancels subsequent steps and the queue; changes already applied are not rolled back. When you switch Figma windows, the plugin keeps working with the file where it was started. To use another file, disconnect the previous plugin and connect the new one. PNG/SVG exports pass through size-limited messages and temporary MCP resources.

Document requests and exports are sent to your MCP client and its selected model provider. Start writes with a copy of the document. For operation and size limits, see [contracts](shared/contracts.md), the [limits profile](docs/limits.md), and [batch execution](shared/execution.md). Source code is in `plugin/`, `server/`, and `shared/`; checks are in `tests/`.

## Trusted execution

`figma_execute` runs an async JavaScript/TypeScript function with JSON arguments and cooperative cancellation. It is not a sandbox: code can modify the entire pinned document, and a timeout does not prove cancellation. Server and plugin must be updated together to protocol v2. See the [execution contract](docs/execution.md), [examples](docs/execution-examples.md), and [Desktop verification](openspec/changes/universal-executor/verification.md).

## License

[MIT](LICENSE).
