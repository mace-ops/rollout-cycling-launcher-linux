// Bündelt Hauptprozess, Preload und Oberfläche nach dist/ und kopiert die statischen Dateien.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: false, logLevel: 'info', target: 'es2022' };
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/renderer/main.ts'], outfile: 'dist/renderer/main.js', platform: 'browser', format: 'iife' });
await build({ ...common, entryPoints: ['src/renderer/art.ts'], outfile: 'dist/renderer/art.js', platform: 'browser', format: 'iife' });

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/art.html', 'dist/renderer/art.html');
cpSync('src/renderer/art.css', 'dist/renderer/art.css');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
cpSync('src/renderer/assets', 'dist/renderer/assets', { recursive: true });
