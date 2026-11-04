import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
await mkdir('dist/candidate', { recursive: true });
await build({ entryPoints: ['plugin/candidate.ts'], bundle: true, target: 'es2017', minifyWhitespace: true, outfile: 'dist/candidate/main.js' });
await copyFile('dist/plugin/ui.html', 'dist/candidate/ui.html');
const manifest = JSON.parse(await readFile('plugin/manifest.json', 'utf8'));
manifest.name = 'Figma MCP Bridge - manual test candidate';
await writeFile('dist/candidate/manifest.json', JSON.stringify(manifest, null, 2));
