import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

for (const path of ['dist/plugin/main.js']) {
  const source = await readFile(path, 'utf8');
  // Figma may reject this token even inside a comment.
  assert.doesNotMatch(source, /\bimport\s*\(/, `${path} contains a possible import expression`);
  new Script(source, { filename: path });
}

const manifest = JSON.parse(await readFile('dist/plugin/manifest.json', 'utf8'));
assert.equal(manifest.name, 'Fijma');
const ui = await readFile('dist/plugin/ui.html', 'utf8');
assert.ok(ui.includes('<title>Fijma</title>'));
assert.ok(ui.includes('<h1>Fijma</h1>'));
