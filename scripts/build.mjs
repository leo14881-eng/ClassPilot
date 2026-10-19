// Build script:
//   dist/              browser app (src/client) + public/
//   dist-server/       Node server (src/server), a single server.mjs with no runtime dependencies
// Usage: node scripts/build.mjs          -> production build
//        node scripts/build.mjs --serve  -> rebuilds the browser app on change (run the server separately)
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
  entryPoints: [join(root, 'src', 'client', 'main.ts')],
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

const serverOptions = {
  entryPoints: [join(root, 'src', 'server', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  outfile: join(root, 'dist-server', 'server.mjs'),
  sourcemap: true,
  logLevel: 'info',
};

if (serve) {
  await build(serverOptions);
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching src/client. Run the server with: CLASSPILOT_CONFIG=./config.local.json CLASSPILOT_STATIC=./dist CLASSPILOT_DATA=./data CLASSPILOT_INSECURE_COOKIE=1 npm start');
} else {
  await build(options);
  await build(serverOptions);
}
