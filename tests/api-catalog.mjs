import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const built = await build({ entryPoints: ['server/api-catalog.ts'], bundle: true, format: 'esm', platform: 'node', packages: 'external', write: false });
// Use a file under the project so Node can resolve the installed SDK.
import { writeFile, unlink } from 'node:fs/promises';
const path = 'tests/.api-catalog-test.mjs';
await writeFile(path, built.outputFiles[0].text);
try {
  const { readApiCatalog } = await import('./.api-catalog-test.mjs');
  const read = uri => {
    const text = readApiCatalog(uri).contents[0].text;
    assert.ok(Buffer.byteLength(text, 'utf8') <= 32768, uri);
    return JSON.parse(text);
  };
  const index = read('figma-api://index');
  assert.equal(index.typingsVersion, '1.142.0');
  assert.equal(index.runtimeSupport, 'unknown');
  const names = index.pages.flatMap(uri => read(uri).names);
  assert.ok(names.some(item => item.name === 'InstanceNode'));
  const source = await readFile('node_modules/@figma/plugin-typings/plugin-api.d.ts', 'utf8');
  const expected = [...source.matchAll(/^(?:declare )?(?:interface|type) ([A-Za-z_$][\w$]*)\b/gm)].map(m => m[1]);
  assert.equal(index.declarationCount, expected.length);
  assert.deepEqual(names.map(x => x.name), [...new Set(expected)].sort());
  const matches = [...source.matchAll(/^(?:declare )?(?:interface|type) ([A-Za-z_$][\w$]*)\b/gm)];
  const expectedText = new Map();
  for (let i = 0; i < matches.length; i++) {
    const start = i === 0 ? 0 : matches[i].index;
    const end = matches[i + 1]?.index ?? source.length;
    expectedText.set(matches[i][1], (expectedText.get(matches[i][1]) || '') + source.slice(start, end));
  }
  let total = 0;
  for (const { name, uri } of names) {
    const first = read(uri); let signature = '';
    for (let i = 0; i < first.pages; i++) {
      const raw = readApiCatalog(`figma-api://types/${name}/${i}`);
      assert.ok(Buffer.byteLength(raw.contents[0].text) <= 32768);
      signature += JSON.parse(raw.contents[0].text).signature;
    }
    total += signature.length;
    assert.equal(signature, expectedText.get(name), `${name} declaration text must be complete`);
  }
  assert.equal(total, source.length);
  for (const bad of ['figma-api://types/../0', 'figma-api://types/%2e%2e/0', 'figma-api://types/toString/0', 'figma-api://types/InstanceNode/999999', 'figma-api://index/01', 'figma-api://index?x=1']) assert.throws(() => readApiCatalog(bad));
  assert.ok(read('figma-api://types/InstanceNode/0').related.length > 0);
} finally { await unlink(path); }
