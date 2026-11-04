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
  const path = stderr.match(/Файл сопряжения: ([^\r\n]+)/)?.[1];
  assert.ok(path);
  await access(path);
  const exit = once(child, 'exit');
  child.stdin.end('{"action":"quit"}\n');
  assert.equal((await exit)[0], 0);
  await assert.rejects(access(path));
  console.log('Manual client: bad input, disconnected call and pairing cleanup OK');
} finally {
  if (child.exitCode === null) child.kill();
}
