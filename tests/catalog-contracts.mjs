import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const scope = { sessionId: 's', connectionGeneration: 1 };
const operationId = '019a4a10-0000-7000-8000-000000000001';
const calls = {
  figma_get_tree: { scope, rootId: '0:1', depth: 1, limit: 10 },
  figma_find_nodes: { scope, document: true, limit: 10 },
  figma_get_nodes: { scope, nodeIds: ['1:1'], fields: ['name'] },
  figma_get_local_resources: { scope, kind: 'variables', fields: ['valuesByMode'], limit: 10 },
  figma_navigate: { scope, nodeIds: [], select: false, reveal: false },
  figma_apply_batch: { scope, operationId, steps: [{ stepId: 'p', op: 'createPage', name: 'Page' }] },
  figma_get_operation: { scope, operationId }, figma_cancel_operation: { scope, operationId },
  figma_export_node: { scope, nodeId: '1:1', format: 'PNG' },
};
const client = new Client({ name: 'catalog-contracts', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/server/index.js'], env: { ...process.env, FIGMA_MCP_PORT: '0' }, stderr: 'pipe' }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  for (const [name, field] of Object.entries({ figma_get_nodes: 'nodes', figma_get_local_resources: 'resources', figma_navigate: 'currentPageId', figma_apply_batch: 'affectedNodeIds', figma_get_operation: 'affectedNodeIds', figma_cancel_operation: 'affectedNodeIds', figma_export_node: 'bytes' })) {
    const schema = JSON.stringify(byName[name].outputSchema);
    assert.ok(schema.includes(`"${field}"`), `${name} advertises successful output`);
    assert.ok(schema.includes('"error"'), `${name} advertises errors`);
  }
  assert.ok(JSON.stringify(byName.figma_get_nodes.inputSchema).includes('"textSegments"'));
  assert.ok(JSON.stringify(byName.figma_get_local_resources.inputSchema).includes('"valuesByMode"'));
  assert.ok(JSON.stringify(byName.figma_get_nodes.outputSchema).includes('"textSegments"'));
  assert.ok(JSON.stringify(byName.figma_get_local_resources.outputSchema).includes('"boundVariables"'));
  for (const [name, args] of Object.entries(calls)) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.error.code, 'NOT_CONNECTED', name);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, name);
  }
  for (const [name, args] of [
    ['figma_get_nodes', { ...calls.figma_get_nodes, fields: ['fills.0.color'] }],
    ['figma_get_local_resources', { ...calls.figma_get_local_resources, fields: ['modes'] }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.notEqual(result.structuredContent?.error?.code, 'NOT_CONNECTED', name);
  }
  console.log('MCP catalog: output schemas, disconnected calls, projection allowlists OK');
} finally {
  await client.close();
}
