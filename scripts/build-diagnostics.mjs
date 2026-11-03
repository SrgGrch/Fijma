import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({ entryPoints: ['experiments/diagnostics/main.ts'], bundle: true, target: 'es2017', outfile: 'experiments/diagnostics/main.js' });
await build({ entryPoints: ['experiments/diagnostics/controller.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'dist/diagnostics/controller.js' });
const html = await readFile('experiments/diagnostics/ui.template.html', 'utf8');
const bundle = await build({ entryPoints: ['experiments/diagnostics/ui.ts'], bundle: true, target: 'es2017', minify: true, write: false });
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile('experiments/diagnostics/ui.html', html.replace('<!-- UI_SCRIPT -->', () => `<script>\n${script}\n</script>`));
