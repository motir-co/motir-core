// Bundle the operator deploy check into ONE self-contained ESM file (Story
// MOTIR-9795 · MOTIR-9965).
//
// With `--repository` the check resolves a repository's stored environment, which
// needs the database and `ENVIRONMENT_CONFIG_ENCRYPTION_KEY`; both live on a
// motir-core machine, so the check runs there (`fly ssh console -a motir-core -C
// "node hosting/deploy-check.mjs <step> …"`) and the key never leaves it. The
// runtime image carries no `scripts/`, so — exactly as `fleet-admin`
// (`scripts/build-fleet-admin.mjs`, whose header carries the argument) — the
// command brings its own bundle, with the worker's external set. The image has no
// `tests/` either, so the committed fixture manifests are inlined as text
// (`define`), keyed by the paths the check defaults to.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The worker's external set (`scripts/build-worker.mjs`): native and present in the image. */
const WORKER_EXTERNALS = ['pg', 'pg-native', 'argon2', 'sharp'];

/** The fixture manifests the check defaults to (`lib/hosting/deployCheck.ts`). */
const MANIFESTS = [
  'tests/fixtures/hosting/motir.hosting.json',
  'tests/fixtures/hosting/motir.hosting.env-report.json',
];
const embedded = Object.fromEntries(
  MANIFESTS.map((p) => [p, readFileSync(path.join(root, p), 'utf8')]),
);

const result = await esbuild.build({
  entryPoints: [path.join(root, 'scripts/hosting-deploy-check.ts')],
  outfile: path.join(root, '.deploy-check/deploy-check.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // `@/…` is the app's tsconfig path alias.
  alias: { '@': root },
  define: {
    'process.env.MOTIR_DEPLOY_CHECK_EMBEDDED_MANIFESTS': JSON.stringify(JSON.stringify(embedded)),
  },
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
// eslint-disable-next-line no-console -- the build's own one-line report
console.log(`deploy-check bundle: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
