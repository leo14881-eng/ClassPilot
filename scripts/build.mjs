// Build script: bundles src/main.ts with esbuild and copies public/ into dist/.
// Usage: node scripts/build.mjs          -> production build into dist/
//        node scripts/build.mjs --serve  -> local dev server on http://localhost:5173
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const serve = process.argv.includes('--serve');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, 'public'), dist, { recursive: true });

const html = readFileSync(join(root, 'public', 'index.html'), 'utf8').replaceAll('__VERSION__', version);
writeFileSync(join(dist, 'index.html'), html);

const options = {
  entryPoints: [join(root, 'src', 'main.ts')],
  bundle: true,
  format: 'esm',
  target: ['safari16'],
  outfile: join(dist, 'app.js'),
  sourcemap: true,
  minify: !serve,
  loader: { '.css': 'css' },
  define: { __APP_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
};

if (serve) {
  const ctx = await context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, port: 5173 });
  console.log(`ClassPilot dev server: http://localhost:${port}`);
} else {
  await build(options);
}
