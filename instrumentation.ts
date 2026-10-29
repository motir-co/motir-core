// Next.js instrumentation hook (Next 13.4+).
//
// Runs ONCE per Node.js server boot, before any handler runs. The default
// build does nothing; the only side effects are env-gated E2E seams:
//
//   - E2E_TEST_OAUTH=1 → lib/test-oauth-mock intercepts outbound HTTPS calls
//     to Google's OAuth token endpoint and returns a synthetic id_token, so
//     Playwright drives the real Better-Auth callback handler end-to-end
//     without leaving localhost.
//   - E2E_TEST_BLOB=1 → lib/test-blob-mock installs an IN-PROCESS object store
//     at the S3 SDK's transport seam, so the attachments E2E journey performs
//     real uploads through the real route without a real blob store (CI runs
//     placeholder credentials by design). NOTE this one does NOT use the shared
//     undici agent below: undici's dispatcher governs `fetch`, and the AWS SDK
//     transports over `node:https`, so an intercept there cannot see it — see
//     that module's header (MOTIR-2389).
//   - E2E_TEST_BILLING=1 → lib/test-billing-mock intercepts the motir-ai billing
//     seam (the MOTIR_AI_URL origin's /v1/usage + /v1/stripe/*) and returns
//     synthetic plan/usage state + hosted session URLs, so the billing journeys
//     (checkout / paywall / portal) drive the real surfaces with no live Stripe
//     and no motir-ai instance (Subtask 8.1.10's dedicated cloud-on E2E lane).
//   - E2E_TEST_CODE_HEALTH=1 → lib/test-code-health-mock intercepts the motir-ai
//     code-health seam (the MOTIR_AI_URL origin's /v1/code-audit,
//     /v1/convention and /v1/code-context/refresh) and answers from a JSON
//     fixture, so the audit-coverage journey (MOTIR-2244) can drive the
//     SERVER-rendered /code-health page — which a browser `page.route` cannot
//     reach — with no motir-ai instance.
//   - E2E_TEST_CODE_GRAPH_READ=1 → lib/test-code-graph-read-mock intercepts the
//     motir-ai CODE-GRAPH READ (the MOTIR_AI_URL origin's POST /v1/code-graph/read)
//     and answers from a JSON fixture, journalling every request, so the MCP
//     code-read journey (MOTIR-7866) pages a `code_explore` result through the
//     real `/api/mcp` route with no motir-ai instance.
//   - E2E_TEST_LESSONS=1 → lib/test-lessons-mock intercepts the motir-ai LESSON
//     LIBRARY seam (the MOTIR_AI_URL origin's GET /v1/lessons and
//     /v1/lessons/:id) and answers from a JSON fixture, so MOTIR-3340 can drive
//     the SERVER-rendered library — which a browser `page.route` cannot reach —
//     with no motir-ai instance. A TRANSPORT mock: the real client and the real
//     permission-asserting service both stay in the path.
//   - E2E_TEST_PLANNER_MODEL=1 → lib/test-planner-model-mock intercepts the
//     motir-ai PLANNER-MODEL settings (GET / PUT /v1/planner-model-settings) and
//     answers from a JSON fixture, so the console's SERVER-rendered AI planning
//     page (MOTIR-7231) can be driven with no motir-ai instance.
//   - E2E_TEST_PLATFORM_LESSONS=1 → lib/test-platform-lessons-mock intercepts the
//     motir-ai PLATFORM planning-lessons console (/v1/admin/lessons… and
//     /v1/admin/lesson-retention…) and answers from a JSON fixture, so the
//     console's SERVER-rendered planning-lessons pages (MOTIR-1413) can be
//     driven with no motir-ai instance.
//   - E2E_TEST_AI_JOBS=1 → lib/test-ai-jobs-mock intercepts the motir-ai JOBS
//     seam (the MOTIR_AI_URL origin's POST /v1/jobs, GET /v1/jobs/:id and its
//     /stream). The ask journey crosses that seam three times and only the
//     stream RELAY is browser-visible, so a `page.route` stub would have to fake
//     the answer — and an answer the browser faked was never written, which is
//     precisely what MOTIR-1823's reload step has to prove.
//   - E2E_TEST_SHARPEN=1 → lib/test-sharpen-mock claims the `sharpen_turn` jobs
//     on that same seam (installed BEFORE the jobs seam, which accepts any kind)
//     and answers a Sharpen session from a scripted control file, making core's
//     write-back call itself when a session ends (MOTIR-8180).
//
//   - E2E_TEST_CODE_GRAPH=1 → lib/test-code-graph-mock intercepts the INDEX
//     WRITER's two boundaries: motir-ai's POST /v1/code-graph/run-credential and
//     api.github.com's installation-token mint + `/tarball/` 302. Crossed only by
//     the index SUPERVISOR, which is a job — so the LANE sets this flag on the
//     WORKER only, never on a webServer. See that module's header for why the
//     app server must not get MOTIR_AI_URL.
//
//   - E2E_TEST_GITHUB_MERGE=1 → lib/test-github-merge-mock intercepts the MERGE
//     calls to api.github.com (the repository and pull request reads, the base
//     branch's rules, the merge and the merge-queue enqueue), steered per pull
//     request by a control file, so the approve-and-merge journey (MOTIR-5487)
//     presses the real merge path and NO REAL PULL REQUEST IS EVER MERGED. It is
//     registered BEFORE the repos seam and answers only the repositories its
//     control names — see that module's header (MOTIR-5572).
//
//   - E2E_TEST_GITHUB_FLEET_ORG_CI=1 → lib/test-github-fleet-org-ci-mock answers the
//     GitHub calls behind /admin/fleet-settings (the org's App installation, its
//     repositories, their visibility, the workflow commit, the org's MOTIR_RUNNER
//     variable) for the orgs its control file names, so the fleet settings journey
//     (MOTIR-8717) reads a real readiness verdict and flips the real setting.
//
//   - E2E_TEST_GITHUB_REPOS=1 → lib/test-github-repos-mock intercepts the
//     repo-PROVISIONING and COLLABORATOR calls to api.github.com (create, the
//     readiness read, the CI stub, the admin invite), so the repository-set
//     journey (MOTIR-1785) drives the real establish + access paths end to end
//     and NO REAL REPOSITORY IS EVER CREATED by the suite.
//
// All mocks share ONE undici MockAgent (lib/test-mock-agent) installed as
// the global dispatcher — installing two agents would silently disconnect
// the first mock's intercepts (only the last setGlobalDispatcher wins). That
// agent REFUSES any api.github.com call no seam intercepted, in every process
// that installs it, so an unfaked GitHub call fails here by name instead of
// leaving the box (MOTIR-5837; see that module).
//
// ⚠️ THE TABLE LIVES IN `lib/test-mock-seams.ts`, NOT HERE (MOTIR-5837). This
// file is a Next.js hook, and the E2E lane's job WORKER is a third process that
// never runs it — so while the table was here, a job handler reaching GitHub got
// no intercept at all. Both processes now install from that one table.
//
// Each seam above is ONE record in that table (`E2E_MOCK_SEAMS`): its
// flag, what it installs, and the line it prints at boot. The early return is
// DERIVED from that table rather than re-listing the flags, because re-listing
// them is what broke: `E2E_TEST_AI_JOBS` was read into a local and then left
// out of a hand-copied five-of-six enumeration, so a lane that set only that
// flag returned before the shared agent was installed and the jobs seam never
// registered — silently, and several layers from where it surfaced
// (MOTIR-3244). A seam added to the table now cannot be half-wired: there is
// no second list to forget it in.
//
// Why dynamic import to separate modules: Next compiles instrumentation.ts
// for BOTH Node and Edge runtimes. A static `import 'undici'` or
// `import 'node:crypto'` at the top of this file would make the Edge
// bundler emit "node module in edge runtime" errors. Dynamic-importing the
// node-only helpers from inside an `if (NEXT_RUNTIME === 'nodejs')` block
// hides those imports from the edge analysis entirely.
//
// Production safety: the env-gates keep these code paths completely dormant
// outside the Playwright run — `register()` returns immediately when neither
// flag is set.

import { onRequestError as reportRequestError } from '@/lib/monitoring/requestError';

export async function register() {
  // ── Error monitoring (Subtask 8.5.6 / MOTIR-1162) ────────────────────────
  // FIRST, and above the early return, because it is the one thing here that is
  // not a test seam. Two runtimes, two SDK builds, two configs — the Edge
  // runtime resolves `@sentry/nextjs` through its `edge-light` export condition
  // to a different bundle, so it cannot share the Node init. Both are no-ops
  // when no DSN is set (the self-host path); see those files.
  //
  // The imports are dynamic and their paths are string literals — Turbopack
  // resolves them statically, so neither runtime's bundle drags in the other's,
  // and neither trips the unresolvable-read tracing fallback the Dockerfile's
  // standalone assertion exists to catch (MOTIR-3219).
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env['NEXT_RUNTIME'] === 'edge') {
    await import('./sentry.edge.config');
  }

  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  // A production build with `MOTIR_RATE_LIMIT_STORE=memory` refuses to start
  // (MOTIR-8614): per-process counters on a multi-machine fleet are a limit of
  // `limit × machines`. The guard's module imports nothing, so this opens no
  // database pool; see its header.
  //
  // ⚠️ It EXITS rather than throws. Measured on `next start` and on the
  // standalone `node server.js` (Next 16.3.6): an error thrown from `register()`
  // is logged as "Failed to prepare server" and the process KEEPS LISTENING,
  // answering every request with an error — a machine that looks up to a health
  // probe's TCP check and serves nothing. Exiting non-zero is what makes the
  // deploy fail at the release instead.
  const { assertRateLimitStoreAllowed } = await import('@/lib/rateLimit/storeGuard');
  try {
    assertRateLimitStoreAllowed();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Per-response `close` listener ceiling (MOTIR-8171): the framework stack puts
  // 8–9 on an ordinary response, so a couple more tip it over Node's 10. See the
  // module for the measurement and why this is not a leak.
  const { installResponseCloseListenerLimit } =
    await import('@/lib/http/responseCloseListenerLimit');
  installResponseCloseListenerLimit();

  // Every transaction's wait and hold, per route and MCP tool, sampled or not
  // (MOTIR-8553), served on the private metrics port when
  // `MONITORING_METRICS_PORT` is set. Node only: `prom-client` and `node:http`
  // must never reach the Edge bundle, which is why both imports sit below the
  // runtime gate.
  const { registerRequestDbTimingListener } = await import('@/lib/monitoring/requestDbTiming');
  registerRequestDbTimingListener();
  const { startMetricsServer } = await import('@/lib/monitoring/metricsServer');
  startMetricsServer();

  // This process's event-loop delay as CloudWatch embedded-metric lines on
  // stdout when `MONITORING_CLOUDWATCH_NAMESPACE` is set (MOTIR-9881); unset
  // starts nothing and writes nothing. The worker and relay start their own from
  // `main()`.
  const { startEventLoopDelayPublisher } = await import('@/lib/monitoring/cloudwatchMetrics');
  startEventLoopDelayPublisher();
  // Each ended loop block's length, and CPU steal when MONITORING_CLOUDWATCH_STEAL
  // is on (MOTIR-9882). Starts the loop-block watchdog itself when no Sentry DSN
  // started it.
  const { startWatchdogMetricsPublisher } = await import('@/lib/monitoring/watchdogMetrics');
  startWatchdogMetricsPublisher();

  // Every E2E seam, from the ONE table the job worker installs from too
  // (`lib/test-mock-seams.ts`, MOTIR-5837). Dynamic, like every import below the
  // runtime gate, so the Edge bundle never analyses the mocks.
  const { installE2EMockSeams } = await import('@/lib/test-mock-seams');
  // eslint-disable-next-line no-console -- instrumentation boot is the right place for this signal
  await installE2EMockSeams((line) => console.log(`[INSTRUMENT] ${line}`));
}

/**
 * Next hands every unhandled server-side request error to this hook — an App
 * Router page, a route handler, a Server Action — and `captureRequestError`
 * turns it into a Sentry event with the request's route and method attached
 * (Subtask 8.5.6 / MOTIR-1162). The wrapper adds the error's `digest` as a tag,
 * the value the browser's error-boundary event carries too, so a redacted client
 * report joins its server exception by tag (Bug MOTIR-8214).
 *
 * Exported UNCONDITIONALLY, even on a build with no DSN: the SDK's capture is a
 * no-op when `Sentry.init` was never called, and Next reads this module's
 * EXPORTS rather than calling anything to discover the hook — so gating the
 * export on an env var would make a self-hosted build differ from a monitored
 * one in shape, not just in behaviour.
 *
 * The static import is safe for the Edge bundle: the wrapper imports only
 * `@sentry/nextjs`, which resolves through its `edge-light` export condition
 * there, so no Node built-in reaches the Edge compilation. That is why THIS
 * import may be static while every mock import above must be dynamic.
 */
export const onRequestError = reportRequestError;
