// Bundle the `fleet-admin` command into ONE self-contained ESM file (Story
// MOTIR-8953 · MOTIR-8967).
//
// `fleet-admin add-shard` must run inside a motir-core machine, where the
// Enterprise and App secrets live (`fly ssh console -a motir-core -C "node
// fleet/fleet-admin.mjs …"`). The runtime image is a Next standalone output with
// no `scripts/` and no `lib/` (the Dockerfile's standalone assertion fails the
// build if `scripts/` reaches it), so — exactly as the worker and the relay — the
// command brings its own bundle. This file differs from `scripts/build-worker.mjs`
// (whose header carries the whole argument) only in its entry and its output; the
// external set is the worker's, for the worker's measured reason.
//
// The entry is `scripts/fleet/fleetAdminMain.ts` (MOTIR-10264), not
// `fleetAdmin.ts`: it composes `DATABASE_URL` from a Fargate task's login parts
// BEFORE the commands' imports evaluate the database client, then loads them with
// a dynamic import that esbuild keeps lazy in this one-file bundle.
//
// `--outfile <path>` writes the bundle elsewhere — the entry's test builds its own
// copy (`tests/ciFleet/fleetAdminFargateEntry.test.ts`). The default is the path
// the Dockerfile copies from.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { outfile: { type: 'string' } } });
const outfile = values.outfile
  ? path.resolve(values.outfile)
  : path.join(root, '.fleet-admin/fleet-admin.mjs');

/** The worker's external set (`scripts/build-worker.mjs`): native and present in the image. */
const WORKER_EXTERNALS = ['pg', 'pg-native', 'argon2', 'sharp'];

const result = await esbuild.build({
  entryPoints: [path.join(root, 'scripts/fleet/fleetAdminMain.ts')],
  outfile,
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
console.log(`fleet-admin bundle: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
