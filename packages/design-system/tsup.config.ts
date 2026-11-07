import path from 'node:path';
import { defineConfig, type Options } from 'tsup';

type EsbuildPlugin = NonNullable<Options['esbuildPlugins']>[number];

// Source modules whose module-level STATE must be one instance across chunks —
// today the DatePicker's format context. With `splitting: false` (below) every
// entry INLINES what it imports, so `DatePicker.js` would carry its own
// `createContext()` and never see a `DatePickerFormatProvider` imported from the
// barrel's `DatePickerFormatContext.js` chunk: the provider would silently do
// nothing in the built package (MOTIR-10551). A relative import of one of these
// from another entry is kept EXTERNAL and pointed at the module's own emitted
// chunk instead. Add a module here when a second chunk needs its React context.
const SINGLETON_MODULES = ['src/components/ui/DatePickerFormatContext.tsx'].map((f) =>
  path.resolve(__dirname, f),
);

const stripExt = (f: string) => f.replace(/\.tsx?$/, '');

const singletonModules: EsbuildPlugin = {
  name: 'singleton-modules',
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      // The module's OWN entry is built as usual; only imports of it go external.
      if (args.kind === 'entry-point') return undefined;
      const target = path.resolve(args.resolveDir, args.path);
      const hit = SINGLETON_MODULES.find((m) => stripExt(m) === stripExt(target));
      if (!hit || stripExt(args.importer) === stripExt(hit)) return undefined;
      // dist mirrors src 1:1, so the path between the two sources is the path
      // between their chunks.
      let spec = path.relative(path.dirname(args.importer), stripExt(hit)) + '.js';
      if (!spec.startsWith('.')) spec = `./${spec}`;
      return { path: spec, external: true };
    });
  },
};

// Build config for @motir/design-system. Mirrors the @motir/cli precedent
// (tsup + ESM + dts), with the differences a React component library needs:
//
//  • Multi-file entry (`src/**`) rather than one bundled entry, so each source
//    file emits its OWN output chunk and its `'use client'` directive is
//    preserved per-file (tsup hoists the directive onto the emitted chunk).
//    A single bundle would collapse the RSC-safe registries + init-script and
//    the client provider/primitives into one chunk with one directive — which
//    would wrongly mark the server-safe modules as client. Keeping the file
//    graph 1:1 preserves the client/server boundary the ADR (§5) fixes.
//  • `dts` for the published type surface.
//  • react / react-dom / next stay external (peers); the runtime deps
//    (radix, lucide, cva, clsx, tailwind-merge) are auto-externalized by tsup
//    from `dependencies`, so they resolve from the consumer's node_modules.
export default defineConfig({
  entry: ['src/**/*.ts', 'src/**/*.tsx'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  // Splitting OFF: code-splitting hoists shared modules into directive-less
  // chunks, which STRIPS the per-file `'use client'` banner (verified). With
  // splitting off, each entry is emitted 1:1 and tsup preserves its directive,
  // so the client components stay client and the RSC-safe modules stay server —
  // the boundary the ADR (§5) fixes. Some shared code (e.g. `cn`) duplicates
  // across entries; that's the accepted cost of correct directives.
  splitting: false,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ['react', 'react-dom', 'react/jsx-runtime', 'next'],
  esbuildPlugins: [singletonModules],
  // Post-build steps run HERE (not chained after `tsup` in the npm script) so
  // they are intrinsic to the build — a bare `tsup`, a `--watch` rebuild, or any
  // future caller ALL get the RSC-safe output by construction, never a raw bundle
  // that a dropped script step would leave behind (MOTIR-1538). Two fixups, in
  // order:
  //   1. `preserve-use-client.mjs` — esbuild strips directive prologues
  //      (`'use client'`) and tsup has no reliable built-in to keep them; this
  //      re-adds the directive to each emitted file whose SOURCE declared one, so
  //      the client components stay client-module boundaries for a Next (RSC)
  //      consumer (ADR §5).
  //   2. `build-index-barrel.mjs` — tsup bundles the `src/index.ts` entry into a
  //      monolithic `dist/index.js` with NO directive; this rewrites it as a THIN
  //      re-export barrel of the sibling per-file chunks, so a server import of a
  //      server-safe export doesn't eagerly pull a client-only API (ADR §5). The
  //      `test/barrel-rsc-safe.test.ts` guard asserts this held.
  // A non-zero exit from either script fails the (non-watch) build.
  onSuccess: 'node scripts/preserve-use-client.mjs && node scripts/build-index-barrel.mjs',
});
