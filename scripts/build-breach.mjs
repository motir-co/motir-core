// Bundle the `breach` command into ONE self-contained ESM file (MOTIR-9884).
//
// `node breach/breach.mjs <memory|cpu|loop>` runs as an ECS one-off task of the
// core image on a rehearsal service, to prove each CloudWatch alarm by a real
// breach. The runtime image carries no `scripts/` and no `lib/`, so — exactly as
// the worker, the relay and fleet-admin — the command brings its own bundle. This
// file differs from `scripts/build-fleet-admin.mjs` only in its entry and its
// output; the external set is the worker's, for the worker's measured reason.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The worker's external set (`scripts/build-worker.mjs`): native and present in the image. */
const WORKER_EXTERNALS = ['pg', 'pg-native', 'argon2', 'sharp'];

const result = await esbuild.build({
  entryPoints: [path.join(root, 'scripts/breach.ts')],
  outfile: path.join(root, '.breach/breach.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // `@/…` is the app's tsconfig path alias.
  alias: { '@': root },
  plugins: [
    {
      // `server-only` stubbed, for the worker's reason: a server process by construction.
      name: 'stub-server-only',
      setup(build) {
        build.onResolve({ filter: /^server-only$/ }, () => ({
          path: 'server-only',
          namespace: 'stub-server-only',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub-server-only' }, () => ({
          contents: 'export {};',
          loader: 'js',
        }));
      },
    },
  ],
  external: WORKER_EXTERNALS,
  // ESM has no require / __dirname / __filename; CJS dependencies inlined expect them.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`breach bundle: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
