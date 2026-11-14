import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { versionSkewConfig } from './lib/build/versionSkew';
import { MONITORING_TUNNEL_ROUTE, monitoringRelease } from './lib/monitoring/config';

// Wires next-intl's request config (./i18n/request.ts by default) into the build.
const withNextIntl = createNextIntlPlugin();

// PRODECT_FINDINGS #3: `next build`'s "Collecting page data" step evaluates
// every route module — including pure server-handler routes that never touch
// Google — which transitively imports `lib/auth/index.ts` and runs its
// module-level `requiredEnv('GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET')`.
// A dev/CI/worktree checkout whose `.env` carries only DATABASE_URL then
// fails the build with a confusing "Failed to collect page data" error on a
// route that has zero coupling to Google.
//
// Fix: seed placeholder OAuth creds here so module-load `requiredEnv` checks
// pass during dev and `next build`. This file is evaluated by `next dev`,
// `next build`, AND the production server, so the injection MUST be gated to
// non-production — otherwise a genuinely-missing prod credential would be
// silently papered over with a placeholder instead of failing loud at the
// first /api/auth request (the property finding #3 explicitly wants to keep).
//
// The placeholders are inert build-time stand-ins: they only let module-load
// `requiredEnv` checks pass during `next build`'s page-data collection. They
// never authenticate against Google (no OAuth round-trip happens during a
// build). Gated to non-production so a production deploy that genuinely lacks
// the creds still fails loud at the first /api/auth request.
//
// This is purely a LOCAL build-DX fix and changes nothing on Vercel: both
// Production AND Preview targets carry real GOOGLE_CLIENT_ID/SECRET, so the
// `??=` never overwrites anything there. The branch only fires in local
// `git worktree` / CI builds whose hand-copied `.env` omits the OAuth vars
// (the scenario in PRODECT_FINDINGS #3) — those have NODE_ENV development/test,
// get placeholders, and `next build` collects page data cleanly instead of
// throwing on routes (e.g. /api/invites/[token]/accept) that never touch Google.
if (process.env['NODE_ENV'] !== 'production') {
  process.env['GOOGLE_CLIENT_ID'] ??= 'build-time-placeholder-client-id';
  process.env['GOOGLE_CLIENT_SECRET'] ??= 'build-time-placeholder-client-secret';
  process.env['BETTER_AUTH_SECRET'] ??= 'build-time-placeholder-secret-32-bytes-minimum';
}

/**
 * The documentation area moved from `/api-docs` to `/docs` (MOTIR-2286 · ADR
 * `public-api-conventions.md` Amendment 9 Q1), so every address it ever served
 * keeps working — PERMANENTLY.
 *
 * `permanent: true` is a 308, which is the point: a 307 tells a crawler and a
 * bookmark to keep asking the old address forever, and the whole reason the area
 * was renamed one day after it shipped is that a URL is a promise to strangers.
 *
 * The order matters. Next matches these top-to-bottom, and `/api-docs/:path*`
 * would swallow the bare `/api-docs` only if `:path*` matched empty — it does,
 * so the exact rule is declared FIRST and the reference keeps its own
 * destination (`/docs/api`) rather than landing on the area root.
 *
 * The LAST entry exists because the reference deliberately does NOT own the
 * area root: `/docs` is a directory, not a page, and a reader who trims the URL
 * should land on the reference rather than a 404. (Whether it should keep
 * landing there is Amendment 11's one recorded open question — MOTIR-2315.)
 *
 * Exported separately from `nextConfig` so `tests/api-docs/docs-redirects.test.ts`
 * can assert the map without booting a server.
 */
export const DOCS_REDIRECTS = [
  // ── MOTIR-2312 / ADR Amendment 11 Q3 ──────────────────────────────────────
  // The API's guide and policy moved INSIDE the reference's own prefix, so the
  // two `/api-docs/*` addresses that pointed at them get their own exact rules
  // AHEAD of the wildcard below. Without these they would still resolve, but in
  // TWO hops (`/api-docs/stability` → `/docs/stability` → `/docs/api/stability`),
  // and a chain is a thing that breaks one rule at a time.
  {
    source: '/api-docs/getting-started',
    destination: '/docs/api/getting-started',
    permanent: true,
  },
  { source: '/api-docs/stability', destination: '/docs/api/stability', permanent: true },
  { source: '/api-docs', destination: '/docs/api', permanent: true },
  { source: '/api-docs/:path*', destination: '/docs/:path*', permanent: true },
  // The addresses those two pages served between Amendment 9 and Amendment 11.
  { source: '/docs/getting-started', destination: '/docs/api/getting-started', permanent: true },
  { source: '/docs/stability', destination: '/docs/api/stability', permanent: true },
  // ── MOTIR-2523 / ADR Amendment 19 Q5 ──────────────────────────────────────
  // `/docs` → `/docs/api` IS GONE. `/docs` now RENDERS the area's index
  // (`app/(public)/docs/page.tsx`), and a Next redirect resolves BEFORE routing
  // — so while that rule existed the page was unreachable code, no matter how
  // green its tests were. Deleting it is a precondition of the page, not a
  // tidy-up, which is why the two ship in one commit.
  //
  // Rule 3 above (`/api-docs` → `/docs/api`) is deliberately NOT re-pointed at
  // `/docs`: `/api-docs` was the API reference's address when the area was
  // API-only, so an old bookmark to the reference must keep landing on the
  // reference. Only the CURRENT root changes meaning, and it has no legacy
  // readers to protect — it has never rendered anything of its own.
] as const;

/**
 * The signed-in landing's rename (Story MOTIR-4777 / MOTIR-4782).
 *
 * A THIRD sibling of the two maps around it, for the reason `SETTINGS_REDIRECTS`
 * gives about itself: each constant is a named contract some test reads, so
 * folding a rule into a map it does not belong to makes that name lie.
 *
 * `/home` became `/workbench` because the surface stopped being a place a
 * product puts things it has not decided about and became a place you stand
 * while you work — and a label that says Workbench over an address bar that says
 * `home` is exactly the drift MOTIR-3171 and MOTIR-3173 were filed for.
 *
 * `permanent: true` (308), not a temporary hop, and not a rewrite:
 *
 * - a URL is a promise to strangers, and this is the one every signed-in reader
 *   has in muscle memory, in their browser history and in whatever they pasted
 *   into chat;
 * - **308 rather than 307 because the METHOD must be preserved** — this address
 *   is only ever GET today, but a redirect outlives the assumptions of the day
 *   it was written;
 * - a REWRITE would keep serving the page at the old address, which is the
 *   half-rename this card exists to avoid: two addresses for one surface, and
 *   nothing to tell a reader which one is real.
 *
 * ⚠️ NEXT CARRIES THE QUERY STRING for a redirect whose destination names no
 * query of its own, so `/home?tab=watching&cursor=…` arrives intact. That is
 * what the acceptance criterion about `?tab=` is asserting, and it is a property
 * of the framework rather than of this rule — which is why the E2E asserts it
 * rather than this comment claiming it.
 */
export const LANDING_REDIRECTS = [
  { source: '/home', destination: '/workbench', permanent: true },
] as const;

/**
 * The members' inbox address (MOTIR-6772, then MOTIR-7043).
 *
 * A FOURTH sibling, for the reason `LANDING_REDIRECTS` gives: each constant is a
 * named contract some test reads, and this move is neither a landing, a settings
 * page nor a docs page.
 *
 * MOTIR-6772 moved `/triage` to `/requested-features`; MOTIR-7043 moved it BACK
 * (`docs/decisions/public-request-board-retired.md` Decision 4, AMENDMENT 1): the
 * members' inbox is Triage again, and only the Visitor's view keeps Requested
 * features. `/requested-features` was a member's bookmark for two days, so it
 * keeps landing for ever rather than 404ing. The rule now runs the other way; the
 * constant keeps its name because tests import it by that name.
 *
 * ⚠️ HERE AND NOT IN THE PAGE TREE. `next.config` redirects run BEFORE
 * `proxy.ts`, so a signed-out browser following `/requested-features` is
 * redirected to `/triage` first and only then meets the session bounce — the
 * same answer a signed-in one gets. A route handler would sit behind the proxy's
 * sign-in redirect and answer a signed-out reader with
 * `/sign-in?next=/requested-features`. 308 for the method-preserving reason
 * `LANDING_REDIRECTS` gives.
 */
export const REQUESTED_FEATURES_REDIRECTS = [
  { source: '/requested-features', destination: '/triage', permanent: true },
] as const;

/**
 * Settings-area address moves (MOTIR-2534 / Story MOTIR-2532).
 *
 * A SIBLING of `DOCS_REDIRECTS`, deliberately not an addition to it. That
 * constant is the docs map by name and by contract — `tests/api-docs/
 * docs-redirects.test.ts` asserts it as such, and `tests/design-asset-
 * addresses.test.ts` reads it as the set of addresses the repo declares dead —
 * so folding a settings rule into it would make both names lie.
 *
 * `permanent: true` (308) for the same reason the docs moves are: a URL is a
 * promise to strangers. This one is quoted in shipped `docs/`, in a published
 * `@motir/cli`'s help text, in five design assets and in whatever readers
 * bookmarked, so it has to keep working forever rather than for a deprecation
 * window.
 *
 * ⚠️ A redirect makes the old address RESOLVE but no longer SERVE, and
 * `tests/design-asset-addresses.test.ts` treats "redirects away" as a finding —
 * which is correct, and why the design assets that still quote the old address
 * carry `KNOWN` rows as point-in-time records. See that file.
 */
export const SETTINGS_REDIRECTS = [
  {
    source: '/settings/account/api-tokens',
    destination: '/settings/account/tokens',
    permanent: true,
  },
  // ⚠️ THE GIT SURFACE MOVED A TIER (Story MOTIR-4669 · MOTIR-4680). A repository
  // is connected ONCE, to the ORGANISATION — the workspace was never where it
  // lived — so both provider routes now answer at `/settings/organization/git`,
  // which renders the same shared shell with the same provider Segmented plus the
  // organisation's whole repository inventory.
  //
  // PERMANENT, and both spellings, because both were linked: the rail's `Git`
  // row, the project Repositories room's footer, the code-access connect prompt,
  // and every OAuth / App-install round trip that returned to one of them. A
  // temporary redirect on a surface people bookmark is a promise to move it back.
  //
  // The GitLab arm keeps its provider through the search param rather than a
  // second route — the inventory spans both providers, so the Segmented switches
  // the connection card rather than the page.
  {
    source: '/settings/workspace/github',
    destination: '/settings/organization/git',
    permanent: true,
  },
  {
    source: '/settings/workspace/gitlab',
    destination: '/settings/organization/git?provider=gitlab',
    permanent: true,
  },
] as const;

const nextConfig: NextConfig = {
  async redirects() {
    return [
      ...DOCS_REDIRECTS,
      ...SETTINGS_REDIRECTS,
      ...LANDING_REDIRECTS,
      ...REQUESTED_FEATURES_REDIRECTS,
    ];
  },
  // The two `next/og` cards read Inter's bytes off disk at request time
  // (`app/_brand/ogFonts.ts` — satori has no CSS tree and no system font stack,
  // so `ImageResponse`'s `fonts` option is the ONLY way a card gets a typeface).
  // A `readFile(join(process.cwd(), …))` is the kind of read a bundler's static
  // analysis can miss, and a font that is absent from the deployed function does
  // not error — the card falls back to a face nobody chose, invisibly, because
  // locally the file is always there. Naming the directory declares the intent.
  //
  // ⚠️ THE DIRECTORY MOVED (MOTIR-3848). The bytes now live in `@motir/brand` —
  // one home across both Motir properties, per MOTIR-3724 — and here that
  // package is the WORKSPACE one, so the app reads `packages/brand/fonts`
  // directly rather than through `node_modules/@motir/brand`. That is not a
  // stylistic choice: `node_modules/@motir/brand` is a symlink pointing OUTSIDE
  // `node_modules`, and `copyTracedFiles` reproduces traced files at their
  // resolved path without re-creating it, so the node_modules spelling resolves
  // in dev, test and CI and ENOENTs in the deployed image. motir-marketing
  // installs the same package from npm, where both spellings survive, and reads
  // `node_modules/@motir/brand/fonts`. See `app/_brand/ogFonts.ts` for the
  // measurement.
  //
  // ⚠️ This key does NOT currently do anything, and the fonts arrive anyway —
  // both halves verified, MOTIR-2403. `outputFileTracingIncludes` /
  // `outputFileTracingExcludes` are read in exactly one place,
  // `next/dist/build/collect-build-traces.js`, and `next/dist/build/index.js`
  // guards that call with `if (bundler !== Bundler.Turbopack && …)`. Next 16
  // builds with Turbopack, so the module never runs and neither key is consulted.
  // Turbopack's own tracer follows the read on its own — because every segment of
  // `FONT_DIR` and every entry of `OG_FONT_FACES` in `app/_brand/ogFonts.ts` is a
  // literal — and the three TTFs appear in
  // `.next/server/app/(public)/explore/(square)/opengraph-image-*/route.js.nft.json` and
  // in no unrelated route's trace.
  //
  // It is kept, rather than deleted, because it is the only written record of
  // WHY those bytes must ship, and it is the safety net on the webpack path
  // (`next build --webpack`, which CI still has available). Anything that
  // depends on it taking effect must not assume this build applies it.
  outputFileTracingIncludes: {
    '/explore/opengraph-image': ['./packages/brand/fonts/**'],
    '/p/[identifier]/opengraph-image': ['./packages/brand/fonts/**'],
  },
  // The Next.js dev-mode tools indicator renders a fixed portal in the
  // bottom-left corner by default — directly over the app shell's sidebar
  // footer (the collapse toggle). In `next dev` that portal intercepts pointer
  // events on the footer, so a browser-driven E2E click on "Collapse sidebar"
  // is occluded (Subtask 1.5.6's shell-flows spec). The indicator is a dev-only
  // affordance (it never ships to production), so disable it for the E2E dev
  // server — gated on an env flag the Playwright webServer sets, leaving a
  // normal `pnpm dev` session's indicator untouched.
  ...(process.env['E2E_DISABLE_DEV_INDICATOR'] ? { devIndicators: false as const } : {}),
  output: 'standalone',

  // ⚠️ A TAB LEFT OPEN ACROSS A DEPLOY (MOTIR-11241). In the production IMAGE
  // build only: `assetPrefix` serves `/_next/static` from static.motir.co, which
  // keeps every release's files after its task stops, and `deploymentId` (the
  // commit SHA) makes Next hard-navigate a tab whose build no longer matches the
  // server's instead of mixing two builds. Dev, CI and test builds get neither.
  // See `lib/build/versionSkew.ts`.
  ...versionSkewConfig(),

  // ⚠️ There is deliberately NO `outputFileTracingExcludes` here, and the
  // pruning it used to claim lives in the `Dockerfile`'s BUILDER stage instead
  // (MOTIR-2403). This file used to carry
  //
  //     outputFileTracingExcludes: { '**/*': ['./design/**', './tests/**', …] }
  //
  // with a comment stating a measured size, and it removed nothing. The key is
  // consulted only by `next/dist/build/collect-build-traces.js`, which
  // `next/dist/build/index.js` calls behind
  // `if (bundler !== Bundler.Turbopack && …)` — so under Next 16's Turbopack
  // build the whole module is skipped and the key is inert. Measured on a clean
  // build at `origin/main`: `.next/standalone` = 381 MB, of which `design/` was
  // 222 MB, every directory the exclusion named still present, and all 324
  // `design/` files reachable from one trace (`instrumentation.js.nft.json`).
  //
  // Re-adding an exclusion here will not shrink anything while this repo builds
  // with Turbopack. If that ever changes, the Dockerfile step is written to fail
  // loudly rather than quietly stop mattering.
  //
  // ⚠️ AMENDED 2026-08-20 (MOTIR-3219) — THE CAUSE OF THAT SWEEP, and it was
  // never the tracer being coarse. Turbopack traced `design/` (and `tests/`,
  // `docs/`, `scripts/`, `packages/cli/`, `prisma/migrations/`) because
  // `instrumentation.ts`'s E2E boundary mocks each read a fixture from a path it
  // could not resolve statically, and its fallback for an unresolvable read is to
  // trace the ENTIRE project. Marking those reads `turbopackIgnore`
  // (`lib/test-fixture-file.ts`) took `instrumentation.js.nft.json` from **4510
  // files to 168** and `.next/standalone` from **464 MB to 124 MB** — so the 381
  // MB / 324-design-files figures above are a record of the BUG, not of what a
  // Turbopack build costs.
  //
  // Two consequences for anyone re-reading this block: the paragraph above is
  // still correct that these keys are inert, so do not re-add them; and the
  // Dockerfile step no longer PRUNES — it asserts the sweep has not returned.
  // `pnpm assert:nft-trace` makes the same assertion on every pull request.
};

/**
 * Whether this build can upload source maps — i.e. whether a Sentry auth token
 * reached it (a GitHub Actions secret, mounted into the image build; see the
 * `Dockerfile` and `ci.yml`'s deploy job).
 *
 * It gates `sourcemaps.disable` rather than being ignored, because the Sentry
 * SDK's Turbopack path does two things on its own the moment source maps are
 * enabled: it flips `productionBrowserSourceMaps` on, and it DELETES the
 * generated maps after the upload. With no token the upload is a no-op, so
 * leaving it enabled would make a self-hosted `next build` generate browser
 * source maps and then delete them — pure cost, and a difference from today's
 * output for a build that is not being monitored at all.
 */
const canUploadSourceMaps = Boolean(process.env['SENTRY_AUTH_TOKEN']?.trim());

/**
 * Error monitoring (Subtask 8.5.6 / MOTIR-1162).
 *
 * ⚠️ THE CARD ASKED FOR THIS TO BE VERIFIED RATHER THAN ASSUMED, because
 * `outputFileTracingExcludes` above is a live example of a `next.config` key
 * this build never reads (MOTIR-2403). It was verified, and the answer is that
 * source-map upload DOES run here — by a different mechanism than the webpack
 * one most Sentry documentation describes:
 *
 *   - `next build` selects Turbopack when no bundler flag is set and sets
 *     `process.env.TURBOPACK = 'auto'` BEFORE it loads this file
 *     (`next/dist/lib/bundler.js`, called at the top of `next/dist/cli/
 *     next-build.js`), so the SDK's `detectActiveBundler()` sees `turbopack`.
 *   - On Turbopack with Next ≥ 15.4.1 — this repo is on 16.2.6 — the SDK does
 *     NOT install a webpack plugin. It sets `compiler.runAfterProductionCompile`,
 *     which Next invokes once the compile is done, and THAT injects debug ids
 *     and uploads the maps (`@sentry/nextjs`'s
 *     `getFinalConfigObjectBundlerUtils.ts` → `handleRunAfterProductionCompile.ts`).
 *
 * So the inert-key trap does not apply, and the evidence is a log line rather
 * than a reading: a build with a token prints
 * `Successfully uploaded source maps to Sentry` at info level, and the same hook
 * creates the Sentry release named after the commit. `aws-deploy.yml`'s last
 * step asks Sentry for that release and turns the deploy red when it is absent
 * (MOTIR-11059) — the same "fail loudly rather than quietly stop mattering"
 * shape the Dockerfile's standalone assertion uses, and the reason this card's
 * "demonstrated to have RUN" criterion keeps holding after today.
 */
export default withSentryConfig(withNextIntl(nextConfig), {
  // Read from the Actions secrets at image-build time; unset locally and in a
  // self-hosted build, where every option below degrades to a no-op.
  org: process.env['SENTRY_ORG'],
  project: process.env['SENTRY_PROJECT'],
  authToken: process.env['SENTRY_AUTH_TOKEN'],

  // The same-origin relay for browser events. `withSentryConfig` turns this into
  // a Next REWRITE and injects the path into the client bundle — see
  // `lib/monitoring/config.ts` and `instrumentation-client.ts`.
  tunnelRoute: MONITORING_TUNNEL_ROUTE,

  // The 40-char commit SHA, arriving as a build argument. `withSentryConfig`
  // writes it into Next's `env` as `_sentryRelease`, which is how BOTH bundles
  // report the same release the maps were uploaded against.
  release: { name: monitoringRelease() },

  sourcemaps: { disable: !canUploadSourceMaps },

  // ⚠️ NO `automaticVercelMonitors` KEY HERE, and its absence is the decision.
  // This app moved off Vercel (MOTIR-2384), so the option has nothing to do —
  // and passing it `false` to say so is worse than leaving it out: the SDK
  // answers with a DEPRECATION WARNING on every single build ("use
  // webpack.automaticVercelMonitors instead. (Not supported with Turbopack.)"),
  // which is a line a reader has to learn to ignore in the one log where the
  // source-map upload also reports itself.
});
