import { copyFile } from 'node:fs/promises';
for (const name of ['manifest.json', 'ui.html']) {
  await copyFile(`plugin/${name}`, `dist/plugin/${name}`);
}
