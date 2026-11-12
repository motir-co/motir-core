// The monitoring seam — ONE place that answers "is error monitoring on, and
// what is this build?" for all four Sentry entry points (server, edge, client,
// `next.config.ts`) — and, as of MOTIR-3606, for the job WORKER, which is a
// fifth and is not a Next entry point at all.
//
// ⚠️ THIS FILE IS IMPORTED BY `next.config.ts`, SO IT MAY IMPORT ALMOST NOTHING.
// Next transpiles the config with a plain Node resolver that does not understand
// the `@/` path alias, so a transitive import reaching one fails the BUILD with
// `MODULE_NOT_FOUND` — pointing at a file several hops away, which is a long way
// from the line that caused it. MOTIR-3606 hit exactly that by adding a
// `dropExpectedDomainErrors` import here; the options builder that needs it
// lives in `./serverInit` instead, which no Next config touches. Keep this
// module free of anything but `process.env` reads.
//
// The one import is RELATIVE and imports nothing itself: the host's identity
// (MOTIR-8549's `instance.*` tags) is read through `lib/deployment/identity.ts`,
// the one file the CI-fleet boundary guard lets name the host's variables.
import { hostInstanceId, hostProcessGroup, hostRegion } from '../deployment/identity';
//
// Subtask 8.5.6 / MOTIR-1162. The provisioned values and which of the two homes
// each belongs in are recorded on MOTIR-1161; this file is the code side of
// that split, and the split is the whole reason the file exists:
//
//   SERVER / EDGE  `SENTRY_DSN`, `SENTRY_ENVIRONMENT`  → Fly RUNTIME secrets,
//                  read from `process.env` when the process boots.
//   CLIENT         `NEXT_PUBLIC_SENTRY_DSN`            → a Docker BUILD
//                  ARGUMENT, inlined into the browser bundle by `next build`.
//
// ⚠️ THE CLIENT HALF CANNOT BE A RUNTIME SECRET, AND GETTING THAT WRONG FAILS
// SILENTLY. A `NEXT_PUBLIC_*` value is substituted into the JavaScript at BUILD
// time, so a Fly secret set afterwards is invisible to the browser: the
// integration reviews cleanly, its tests pass, and not one client-side error is
// ever reported. That is why the `Dockerfile` declares an `ARG` for it and
// `ci.yml`'s deploy step passes `--build-arg` — see both, and MOTIR-1161's
// warning table.
//
// ⚠️ AND THE LITERAL MATTERS. `process.env['NEXT_PUBLIC_SENTRY_DSN']` is
// replaced by the bundler because the key is written out here as a literal. A
// dynamic lookup (`process.env[name]`) is NOT replaced and yields `undefined`
// in the browser — the same silent failure one step further in. Every read
// below is a literal on purpose.

/**
 * The same-origin path browser events are relayed through, instead of being
 * posted straight at `*.ingest.sentry.io`.
 *
 * Ad blockers and tracking-protection lists match on the vendor host, so a
 * direct post is dropped for a large minority of real users — silently, and
 * disproportionately among the technical ones. `withSentryConfig`'s
 * `tunnelRoute` turns this path into a Next REWRITE (not a route handler) that
 * forwards the envelope on, so the request the browser makes is same-origin and
 * indistinguishable from any other.
 *
 * ⚠️ It is a REWRITE, which is why nothing in `app/api/**` implements it and why
 * no route-level guard sees it. It is nevertheless listed in
 * `RATE_LIMIT_EXCLUDED_PATHS` (`lib/rateLimit/guard.ts`, added by Subtask 8.5.9
 * naming this card) so the exclusion holds if the path ever DOES become a
 * handler. `tests/monitoring/sentry-wiring.test.ts` asserts the two agree —
 * a constant and a string literal in another file are exactly the pair that
 * drifts.
 */
export const MONITORING_TUNNEL_ROUTE = '/monitoring';

/**
 * The DSN the SERVER and EDGE runtimes report with — a Fly runtime secret.
 *
 * Empty / unset ⇒ monitoring is OFF and `Sentry.init` is never called. That is
 * the self-hoster path: a build with no DSN anywhere phones nowhere, and the
 * property falls out of the mechanism rather than needing a flag to enforce it.
 */
export function serverSentryDsn(): string | undefined {
  return nonEmpty(process.env['SENTRY_DSN']);
}

/**
 * The DSN the BROWSER reports with — inlined at build time. See the header.
 */
export function clientSentryDsn(): string | undefined {
  return nonEmpty(process.env['NEXT_PUBLIC_SENTRY_DSN']);
}

/**
 * Which BUILD this is — the 40-char commit SHA, passed as a build argument
 * (`--build-arg MOTIR_RELEASE=${{ github.sha }}`), per MOTIR-1161's release /
 * environment convention and `production-service-stack.md` §4.
 *
 * ⚠️ It has to be a build argument, and the reason is not stylistic: source maps
 * are uploaded DURING the image build and must be tagged with the same string
 * the running code reports. Fly injects `FLY_APP_NAME` / `FLY_MACHINE_ID` at
 * runtime, which identify the machine, not the build — and `.git` is in
 * `.dockerignore`, so the SDK's own `git rev-parse HEAD` fallback finds nothing
 * inside the image. Without this argument a release is simply never named.
 *
 * Read by `next.config.ts` — the SDKs then read the value back out of
 * `process.env._sentryRelease`, which `withSentryConfig` writes into Next's
 * `env` config from this same string — and, since MOTIR-3760, by
 * `/api/health/release`, which is how a monitor OUTSIDE the deployment learns
 * which commit is running and compares it against `main`. That second reader is
 * why the `Dockerfile`'s RUNNER stage now declares the argument as well as the
 * builder: the builder's `ENV` is scoped to its own stage, so until then this
 * accessor returned `undefined` in the running server.
 */
export function monitoringRelease(): string | undefined {
  return nonEmpty(process.env['MOTIR_RELEASE']);
}

/**
 * Which DEPLOYMENT this is, for the SERVER and EDGE runtimes — a Fly runtime
 * secret (`SENTRY_ENVIRONMENT=production`, already staged by MOTIR-1161).
 *
 * Deliberately NOT baked in: it is the one thing that distinguishes two
 * deployments of the SAME image, so a future staging app must be able to say so
 * without a rebuild. Baking it in surfaces as staging errors labelled
 * `production` — invisible until it matters.
 */
export function serverMonitoringEnvironment(): string | undefined {
  return nonEmpty(process.env['SENTRY_ENVIRONMENT']);
}

/**
 * Which DEPLOYMENT this is, for the BROWSER.
 *
 * ⚠️ THE RUNTIME RULE ABOVE CANNOT HOLD ON THIS SIDE, and saying so is better
 * than pretending it does. A browser bundle is a build artifact: there is no
 * `process.env` in it to read at runtime, so the environment is either compiled
 * in or shipped in the HTML. This card compiles it in, defaulting to
 * `production`, with `NEXT_PUBLIC_SENTRY_ENVIRONMENT` as the override a
 * non-production image can pass through the same build-argument seam.
 *
 * The consequence is bounded and worth naming: if a staging app is ever run
 * from the SAME image as production, its SERVER events will be labelled
 * `staging` (runtime secret) and its BROWSER events `production`. The fix at
 * that point is one more `--build-arg` on the staging build, not a code change.
 */
export function clientMonitoringEnvironment(): string {
  return nonEmpty(process.env['NEXT_PUBLIC_SENTRY_ENVIRONMENT']) ?? 'production';
}

/**
 * The share of the WEB SERVER's and EDGE runtime's transactions sampled for
 * performance tracing — a per-deployment RUNTIME setting, `SENTRY_TRACES_SAMPLE_RATE`
 * (MOTIR-8549), read when the process boots exactly as `SENTRY_ENVIRONMENT` is.
 *
 * It was a compiled `0` until MOTIR-8537, with the note "raising it is a
 * decision with a bill attached". It is still that decision; what changed is
 * WHERE it is made. A constant could only be raised for every deployment of an
 * image at once, and a staging load test needs a rate production must not pay
 * for. So it is a Fly runtime secret, set per app
 * (`flyctl secrets set -a <app> SENTRY_TRACES_SAMPLE_RATE=…`).
 *
 * **Unset ⇒ 0, which is the behaviour before this setting existed.** Nothing
 * traces until a deployment opts in. A value that is not a finite number in
 * `[0, 1]` (`"abc"`, `"1.5"`, `"-0.1"`) is also 0, with one warning naming the
 * variable: a typo must neither fail the boot nor silently trace 100%.
 *
 * ⚠️ ONLY THE WEB SERVER AND THE EDGE READ IT. A Fly secret is visible to every
 * process group of the app, the job worker and the terminal relay included, so
 * `serverSentryInitOptions` (`./serverInit`) passes an explicit 0 unless its
 * caller opts in with `{ traces: true }` — and only `sentry.server.config.ts`
 * does. The browser has its own constant, `BROWSER_TRACES_SAMPLE_RATE`.
 *
 * ## The cost model — how to choose a value
 *
 *     monthly spans ≈ (app requests per month) × rate × (spans per traced request)
 *     monthly cost  ≈ spans beyond the Sentry plan's included span quota
 *                     × the plan's per-span overage price
 *
 * None of the three inputs is known until it is measured, and none is invented
 * here:
 *
 * - **app requests per month** — Fly's metrics for the `app` process group;
 * - **spans per traced request** — one staging trace of a hot route, now that
 *   every interactive transaction and its SQL statements are spans (MOTIR-8550)
 *   — a `/workbench` render is one request span plus several transaction spans,
 *   each with its statements beneath it;
 * - **the quota and the per-span price** — the Sentry organisation's billing page.
 *
 * Production's chosen value and the cost computed for it are recorded on the
 * manual card that sets it (the production trace-rate task under MOTIR-8536),
 * not here: a number in a comment goes stale the day the traffic changes.
 */
export function serverTracesSampleRate(): number {
  const raw = process.env['SENTRY_TRACES_SAMPLE_RATE']?.trim();
  if (!raw) return 0;
  const rate = Number(raw);
  if (Number.isFinite(rate) && rate >= 0 && rate <= 1) return rate;
  console.warn(
    `[monitoring] SENTRY_TRACES_SAMPLE_RATE=${JSON.stringify(raw)} is not a number between 0 and 1 — tracing stays off (0)`,
  );
  return 0;
}

/**
 * The BROWSER's trace sample rate: 0, and a constant. A `NEXT_PUBLIC_*` value is
 * compiled into the bundle, so a runtime secret can never reach it, and browser
 * performance tracing is outside MOTIR-8537's scope.
 */
export const BROWSER_TRACES_SAMPLE_RATE = 0;

/**
 * Which INSTANCE an event came from — the Fargate task, its process (`web`,
 * `worker`, `relay`) and its region — as Sentry tags under `instance.*`
 * (MOTIR-8549; read from Fargate since MOTIR-10962). Set on the init's
 * `initialScope`, so they reach transaction events as well as errors (a
 * transaction never passes through `beforeSend`).
 *
 * `lib/deployment/identity.ts` reads all three, and only on a Fargate task. A
 * value that is absent is OMITTED rather than tagged `""`, so locally and on a
 * self-hosted build the answer is `{}`. The `instance.*` prefix keeps them apart from the `tx.*` keys
 * `tagTransactionStall` writes.
 */
export function monitoringInstanceTags(): Record<string, string> {
  const tags: Record<string, string> = {};
  // Read through the one file allowed to name the host's variables
  // (`tests/ciFleet/orchestratorPortBoundary.test.ts`).
  const machine = hostInstanceId();
  const processGroup = hostProcessGroup();
  const region = hostRegion();
  if (machine) tags['instance.machine'] = machine;
  if (processGroup) tags['instance.process_group'] = processGroup;
  if (region) tags['instance.region'] = region;
  return tags;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
