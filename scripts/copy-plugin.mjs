import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
await copyFile('plugin/manifest.json', 'dist/plugin/manifest.json');
const html = await readFile('plugin/ui.html', 'utf8');
const bundle = await build({ entryPoints: ['plugin/ui.ts'], bundle: true, target: 'es2017', write: false });
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile('dist/plugin/ui.html', html.replace('<!-- UI_SCRIPT -->', () => `<script>\n${script}\n</script>`));
