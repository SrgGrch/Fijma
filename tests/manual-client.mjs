import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const child = spawn(process.execPath, ['scripts/manual-client.mjs'], { env: { ...process.env, FIGMA_MCP_PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', data => stderr += data.toString());
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
try {
  assert.equal(JSON.parse((await lines.next()).value).ready, true);
  child.stdin.write('invalid json\n');
  assert.ok(JSON.parse((await lines.next()).value).error);
  child.stdin.write('{"name":"figma_get_context","arguments":{}}\n');
  assert.equal(JSON.parse((await lines.next()).value).structuredContent.state, 'disconnected');
  child.stdin.write('{"action":"parallel","requests":[{"name":"figma_get_context","arguments":{}},{"name":"figma_get_context","arguments":{}}]}\n');
  assert.deepEqual(JSON.parse((await lines.next()).value).map(result => result.structuredContent.state), ['disconnected', 'disconnected']);
  child.stdin.write('{"action":"parallel","requests":[{"name":"figma_get_context","arguments":{}},{"name":"unknown_tool","arguments":{}}]}\n');
  const mixed = JSON.parse((await lines.next()).value);
  assert.equal(mixed[0].structuredContent.state, 'disconnected');
  assert.match(mixed[1].error, /unknown_tool/);
  for (const requests of [[], Array(4).fill({ name: 'figma_get_context', arguments: {} })]) {
    child.stdin.write(`${JSON.stringify({ action: 'parallel', requests })}\n`);
    assert.ok(JSON.parse((await lines.next()).value).error);
  }
  const path = stderr.match(/Файл сопряжения: ([^\r\n]+)/)?.[1];
  assert.ok(path);
  await access(path);
  const exit = once(child, 'exit');
  child.stdin.end('{"action":"quit"}\n');
  assert.equal((await exit)[0], 0);
  await access(path);
  console.log('Manual client: bad input, disconnected calls, parallel bounds and persistent pairing OK');
} finally {
  if (child.exitCode === null) child.kill();
}
