import { defineConfig } from 'tsup';

// Build config for @motir/orchestrator, in the mould of @motir/design-system's
// with the differences a SERVER-SIDE package needs:
//
//  • ONE bundled entry rather than a multi-file graph. The design system splits
//    per file to preserve each one's `'use client'` directive; nothing here is a
//    React component and nothing here has a directive, so a single bundle is the
//    simpler artefact.
//  • `decimal.js` stays EXTERNAL — tsup auto-externalises `dependencies`, so the
//    consumer resolves it from its own node_modules and there is one copy of the
//    money type in the process rather than two.
//  • node20 target: this package runs in the Next server runtime and in the
//    worker process, never in a browser.
//  • BOTH formats, unlike the design system's ESM-only build. This package is
//    reached from a CommonJS loader as well as from a bundler: Playwright
//    transpiles `tests/e2e/_helpers/job-registry.ts` to CJS, and that helper
//    pulls `lib/jobs/registry` → `lib/orchestrator` → this package, so the
//    barrel is `require`d. With an ESM-only `exports` map Node answers
//    `No "exports" main defined` — which is what E2E did, on a green
//    type-check and a green Vitest run, because neither of those loaders uses
//    the `require` condition. `tests/packages/importDirection.test.ts` holds
//    the assertion.
export default defineConfig({
  // NOT `tsconfig.json`: that one is the composite project the root solution
  // file references, and tsup's declaration build compiles through a synthetic
  // project that a composite config refuses (TS6307). See `tsconfig.tsup.json`.
  tsconfig: 'tsconfig.tsup.json',
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'node20',
  outDir: 'dist',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // `AWS_TENANT_STACKS_DIR` (MOTIR-10003) finds its directory from
  // `import.meta.url`, which the CommonJS build would otherwise leave empty.
  shims: true,
});
