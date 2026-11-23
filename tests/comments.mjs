import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const date = day => '2026-11-' + String(day).padStart(2, '0') + 'T12:00:00Z';
const row = (id, day, fields = {}) => ({
  id, message: 'Message ' + id, user: { id: 'user1', handle: 'Jane', img_url: 'ignored' },
  created_at: date(day), ...fields,
});
const comments = [
  row('closedReply2', 12, { parent_id: 'closed' }),
  row('openReply', 9, { parent_id: 'open', resolved_at: date(10) }),
  row('closed', 5, { parent_id: '', resolved_at: date(14), client_meta: { node_id: '1:2', node_offset: { x: 1, y: 2 } } }),
  row('old', 3),
  row('orphan', 11, { parent_id: 'unavailable' }),
  row('open', 8, { resolved_at: null }),
  row('closedReply1', 6, { parent_id: 'closed', resolved_at: null }),
];

const dir = await mkdtemp(join(tmpdir(), 'fijma-comments-'));
const preload = join(dir, 'figma.cjs');
const token = 'fake-comments-token-for-test';
const errorBody = 'private body ' + token;

const fetchFixture = ['const loads = new Map(); let clockOffset = 0;',
  'const realNow = Date.now; Date.now = () => realNow() + clockOffset;',
  'globalThis.fetch = '].join('\n') + (async function (url, options) {
  const assert = require('node:assert/strict');
  assert.equal(options.method, 'GET');
  assert.equal(new Headers(options.headers).get('X-Figma-Token'), process.env.FIGMA_MCP_ACCESS_TOKEN);
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  const match = /^https:\/\/api\.figma\.com\/v1\/files\/([a-zA-Z0-9]+)\/comments$/.exec(String(url));
  assert.ok(match);
  const fileKey = match[1];
  if (!process.env.FIGMA_MCP_ACCESS_TOKEN) {
    process.stderr.write('UNEXPECTED_FETCH\n');
    throw new Error('fetch called without token');
  }
  if (fileKey === 'network') throw new Error(process.env.FIGMA_MCP_ACCESS_TOKEN);
  const status = { denied: 403, missing: 404, throttled: 429 }[fileKey];
  if (status) return new Response(process.env.TEST_ERROR_BODY, {
    status, headers: fileKey === 'throttled' ? { 'Retry-After': '120' } : {},
  });
  if (fileKey === 'bad') return Response.json({ error: process.env.TEST_ERROR_BODY });
  if (fileKey === 'advanceClock') {
    clockOffset += 60_001;
    return Response.json({ comments: [] });
  }
  if (['cached', 'otherCached', 'failedRefresh', 'deniedRefresh'].includes(fileKey)) {
    const count = (loads.get(fileKey) ?? 0) + 1;
    loads.set(fileKey, count);
    if (fileKey === 'failedRefresh' && count === 2) return new Response('', { status: 503 });
    if (fileKey === 'deniedRefresh' && count > 1) return new Response('', { status: 403 });
    await new Promise(resolve => setTimeout(resolve, 25));
    const comments = JSON.parse(process.env.TEST_COMMENTS).map(comment => ({
      ...comment, message: comment.message + ' #' + count,
    }));
    return Response.json({ comments });
  }
  return Response.json({ comments: fileKey === 'empty' ? [] : JSON.parse(process.env.TEST_COMMENTS) });
}).toString();

async function withClient(accessToken, run) {
  const client = new Client({ name: 'comments-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--require', preload, 'dist/server/index.js'], stderr: 'pipe',
    env: {
      ...process.env, FIGMA_MCP_PORT: '0', FIGMA_MCP_PAIRING_DIR: join(dir, 'pairing'),
      FIGMA_MCP_ACCESS_TOKEN: accessToken, TEST_COMMENTS: JSON.stringify(comments), TEST_ERROR_BODY: errorBody,
    },
  });
  let diagnostics = '';
  transport.stderr.on('data', bytes => { diagnostics += bytes.toString(); });
  try {
    await client.connect(transport);
    await run(client);
    assert.doesNotMatch(diagnostics, /UNEXPECTED_FETCH|fake-comments-token-for-test/);
  } finally {
    await client.close();
  }
}

const call = (client, args = {}) => client.callTool({
  name: 'figma_get_comments', arguments: { fileKey: 'testFile', status: 'unresolved', ...args },
});

try {
  await writeFile(preload, fetchFixture);
  await withClient(token, async client => {
    const { tools } = await client.listTools();
    const tool = tools.find(tool => tool.name === 'figma_get_comments');
    assert.ok(tool, 'comment tool is published');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.ok(tool.outputSchema);
    assert.equal((await client.callTool({ name: 'figma_get_context', arguments: {} })).structuredContent.state, 'disconnected');

    const unresolved = await call(client, { limit: 1 });
    assert.equal(unresolved.isError ?? false, false);
    assert.deepEqual(JSON.parse(unresolved.content[0].text), unresolved.structuredContent);
    const first = unresolved.structuredContent;
    assert.equal(first.status, 'unresolved');
    assert.deepEqual(first.threads.map(thread => thread.id), ['open']);
    assert.equal(first.threads[0].resolvedAt, null);
    assert.deepEqual(first.threads[0].replies.map(reply => reply.id), ['openReply']);
    assert.equal(first.nextAfterThreadId, 'open');

    const next = (await call(client, { limit: 1, afterThreadId: first.nextAfterThreadId })).structuredContent;
    assert.deepEqual(next.threads.map(thread => thread.id), ['old']);
    assert.equal(next.nextAfterThreadId, undefined);

    const resolved = (await call(client, { status: 'resolved' })).structuredContent;
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(resolved.threads.map(thread => thread.id), ['closed']);
    const [thread] = resolved.threads;
    assert.equal(thread.resolvedAt, date(14));
    assert.equal(thread.message, 'Message closed');
    assert.deepEqual(thread.author, { id: 'user1', handle: 'Jane' });
    assert.deepEqual(thread.anchor, { node_id: '1:2', node_offset: { x: 1, y: 2 } });
    assert.deepEqual(thread.replies.map(reply => reply.id), ['closedReply1', 'closedReply2']);

    assert.deepEqual((await call(client, { fileKey: 'empty', status: 'resolved' })).structuredContent,
      { fileKey: 'empty', status: 'resolved', threads: [] });
    const get = async args => {
      const result = await call(client, { fileKey: 'cached', ...args });
      assert.equal(result.isError ?? false, false);
      return result.structuredContent;
    };
    const [openCached, closedCached] = await Promise.all([get({ limit: 1 }), get({ status: 'resolved' })]);
    assert.equal(openCached.threads[0].message, 'Message open #1');
    assert.equal(closedCached.threads[0].message, 'Message closed #1');
    assert.equal((await get({ afterThreadId: openCached.nextAfterThreadId })).threads[0].message, 'Message old #1');
    assert.equal((await get({ fileKey: 'otherCached' })).threads[0].message, 'Message open #1');
    assert.equal((await get({ forceReload: true })).threads[0].message, 'Message open #2');
    assert.equal((await get({ status: 'resolved', forceReload: false })).threads[0].message, 'Message closed #2');
    await get({ fileKey: 'advanceClock' });
    assert.equal((await get({})).threads[0].message, 'Message open #3');

    assert.equal((await get({ fileKey: 'failedRefresh' })).threads[0].message, 'Message open #1');
    const failed = await call(client, { fileKey: 'failedRefresh', forceReload: true });
    assert.equal(failed.structuredContent.error.code, 'FIGMA_API_ERROR');
    assert.equal((await get({ fileKey: 'failedRefresh' })).threads[0].message, 'Message open #1');
    await get({ fileKey: 'advanceClock', forceReload: true });
    assert.equal((await get({ fileKey: 'failedRefresh' })).threads[0].message, 'Message open #3');

    assert.equal((await get({ fileKey: 'deniedRefresh' })).threads[0].message, 'Message open #1');
    for (const forceReload of [true, false]) {
      const result = await call(client, { fileKey: 'deniedRefresh', forceReload });
      assert.equal(result.structuredContent.error.code, 'AUTH_FAILED');
    }

    for (const args of [{ status: undefined }, { fileKey: '../../other' }, { status: 'all' }, { token }, { limit: 51 }, { forceReload: 'true' }]) {
      const result = await call(client, args);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Input validation error/);
    }

    for (const [args, code, recovery] of [
      [{ afterThreadId: 'closed' }, 'INVALID_CURSOR', /afterThreadId/],
      [{ fileKey: 'denied' }, 'AUTH_FAILED', /file_comments:read/],
      [{ fileKey: 'missing' }, 'FIGMA_API_ERROR', /fileKey/],
      [{ fileKey: 'throttled' }, 'FIGMA_API_ERROR', /120 сек/],
      [{ fileKey: 'bad' }, 'FIGMA_API_ERROR', /позже/],
      [{ fileKey: 'network' }, 'FIGMA_API_ERROR', /позже/],
    ]) {
      const response = await call(client, args);
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent.error.code, code);
      assert.match(response.structuredContent.error.recoveryAction, recovery);
      assert.doesNotMatch(JSON.stringify(response), /private body|fake-comments-token-for-test/);
    }
  });
  await withClient('', async client => {
    const result = await call(client);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'CAPABILITY_UNAVAILABLE');
    assert.match(result.structuredContent.error.recoveryAction, /FIGMA_MCP_ACCESS_TOKEN/);
  });
  console.log('MCP comments: disconnected read, status filters, replies, pagination, caching, force refresh and safe errors OK');
} finally {
  await rm(dir, { recursive: true, force: true });
}
