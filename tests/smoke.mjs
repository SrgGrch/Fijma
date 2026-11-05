import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'bridge-smoke-test', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/server/index.js'], env: { ...process.env, FIGMA_MCP_PORT: '0' }, stderr: 'pipe' }));
  const result = await client.listTools();
  assert.equal(result.tools.length, 11);
  for (const tool of result.tools) {
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
  }
  const context = await client.callTool({ name: 'figma_get_context', arguments: {} });
  assert.equal(context.structuredContent.state, 'disconnected');
  assert.equal(context.structuredContent.writeEnabled, false);
  assert.deepEqual(JSON.parse(context.content[0].text), context.structuredContent);
  const scope = { sessionId: 'session', connectionGeneration: 1 };
  const disconnected = await client.callTool({ name: 'figma_get_tree', arguments: { scope, rootId: '0:1', depth: 1, limit: 10 } });
  assert.equal(disconnected.isError, true);
  assert.equal(disconnected.structuredContent.error.code, 'NOT_CONNECTED');
  const invalid = await client.callTool({ name: 'figma_get_context', arguments: { execute_js: 'no' } });
  assert.equal(invalid.isError, true);
  await assert.rejects(client.callTool({ name: 'execute_js', arguments: {} }));
  assert.equal((await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent.state, 'disconnected');
  console.log('MCP stdio: 10 инструментов, схемы, disconnected, tool/protocol errors и повторный вызов — OK');
} finally {
  await client.close();
}
