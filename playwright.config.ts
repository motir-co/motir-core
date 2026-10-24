import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  E2E_GITHUB_APP_SLUG,
  E2E_GITHUB_CLIENT_ID,
  E2E_GITHUB_CLIENT_SECRET,
  E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
  E2E_GITHUB_WEBHOOK_SECRET,
} from './tests/e2e/_helpers/github-const';
import {
  E2E_GITLAB_CLIENT_ID,
  E2E_GITLAB_CLIENT_SECRET,
  E2E_GITLAB_TOKEN_ENCRYPTION_KEY,
  E2E_GITLAB_WEBHOOK_SECRET,
} from './tests/e2e/_helpers/gitlab-const';
import { legTestMatch } from './tests/e2e/shard-plan';
import { NEXT_START_KEEP_ALIVE_FLAG } from './tests/e2e/_helpers/server-keep-alive';

// Playwright doesn't pick up .env automatically the way Next.js does. The
// spec files import @/lib/db (via _helpers/db-reset) for DB assertions,
// which throws at module load if DATABASE_URL is missing. Load .env from
// the repo root before defineConfig() runs.
loadEnv();

// PRODECT_FINDINGS #8: the suite used to hardcode http://localhost:3000 for
// baseURL, webServer.url, and (implicitly) Better-Auth's trustedOrigins. That
// blocked running the suite from a `git worktree` while a sibling Subtask
// already owned :3000 — the parallel-worktree workflow the manual-merge mode
// assumes. Three things had to move off the fixed port together:
//   1. Playwright baseURL + webServer.url (below).
//   2. Better-Auth's CSRF origin guard — handled by passing MOTIR_BASE_URL
//      into webServer.env; lib/baseUrl.ts resolves it and lib/auth/index.ts
//      threads that through both baseURL and trustedOrigins, so no auth-code
//      change is needed.
//   3. reuseExistingServer — must be off when a custom port is requested, or a
//      worktree could silently reuse a sibling's :3000 server (wrong code).
// Usage from a worktree:  E2E_BASE_URL=http://localhost:3100 pnpm test:e2e
// (or PORT=3100). Default stays :3000 so existing invocations are unchanged.
// E2E_BASE_URL is the single source of truth when set: the dev-server PORT is
// derived FROM it so the spawned server and the URL Playwright drives can't
// disagree (a bare E2E_BASE_URL with a stale PORT would otherwise boot the
// server on one port and drive another).
// MOTIR-2816 — the `motir_app` E2E harness, the rehearsal for MOTIR-2515.
//
// `E2E_APP_ROLE=1` runs the webServer with `DATABASE_URL` rewritten to the
// NON-BYPASS runtime role, which is the configuration production will be in and
// the only one no other test in the repo exercises. `TEST_DB_APP_ROLE=1` cannot
// do this: it swaps the client inside a Vitest process and has no say over a
// webServer's connection.
//
// ⚠️ ONLY THE SERVER MOVES. The Playwright process, its fixtures and every
// seeding helper keep the OWNER url from `.env` — fixtures create tenants and
// need privileges the runtime role does not have, so seeding through the app
// role would fail at setup and prove nothing about the product.
//
// The role's throwaway password is provisioned in `globalSetup`; see
// `tests/e2e/_helpers/appRoleServer.ts` for why it is not a deployed credential.
/**
 * Set by `.github/actions/e2e-setup` once a usable `.next` is in place — either
 * downloaded from the `build` job's `next-build` artifact or compiled by the
 * action itself. See the `command` note on the app webServer below (MOTIR-3928).
 */
const REUSE_PREBUILT_NEXT = process.env['E2E_REUSE_BUILD'] === '1';

const APP_ROLE_SERVER = process.env['E2E_APP_ROLE'] === '1';
const OWNER_DATABASE_URL = process.env['DATABASE_URL'] ?? '';
function appRoleDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  url.username = process.env['TEST_APP_DB_ROLE'] ?? 'motir_app';
  url.password = process.env['TEST_APP_DB_PASSWORD'] ?? 'motir_app';
  return url.toString();
}

const USING_CUSTOM_ORIGIN = Boolean(process.env['E2E_BASE_URL']) || Boolean(process.env['PORT']);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3000'}`;
const PORT = new URL(BASE_URL).port || '3000';

// MOTIR-2617 — the cost-derived bulk-leg selection (see `testMatch` below).
// `null` for anything that is not a bulk leg id, including an unset E2E_SHARD.
const SHARD_TEST_MATCH = legTestMatch(process.env['E2E_SHARD'] ?? '');

// Subtask 3.5.1 board load-model test seam: forward the cap / Done-age overrides
// to the dev server ONLY when the run sets them, so a targeted
// `BOARD_ISSUE_CAP_OVERRIDE=… pnpm test:e2e --grep board-at-scale` run can reach
// the over-cap banner + Done-age trim with TENS of rows instead of 5,000. Unset
// by default → every other E2E spec (and production) keeps the shipped
// 5,000 / 14 constants (boardsService.resolve{BoardIssueCap,DoneAgeWindowDays}).
const BOARD_LOAD_SEAM_ENV: Record<string, string> = {};
for (const k of ['BOARD_ISSUE_CAP_OVERRIDE', 'DONE_AGE_WINDOW_DAYS_OVERRIDE']) {
  const v = process.env[k];
  if (v !== undefined && v !== '') BOARD_LOAD_SEAM_ENV[k] = v;
}

// ⚠️ THE RUNNER USED TO NEED AN EXECUTOR POINTED AT IT (Subtask 5.4.5 /
// 5.4.11, removed by MOTIR-3418). Seed helpers call services directly and those
// services emit post-commit, so the runner process published events too — and
// with no event key its SDK threw. Two config lines and a whole second webServer
// existed for that: `INNGEST_DEV=1`, a per-run `INNGEST_PORT` so sibling
// worktrees did not collide on :8288, and the pinned `inngest-cli` binary booted
// as the executor. An emit is a row in the run's own database now, so the runner
// needs nothing: the executor is `E2E_JOB_WORKER` below, a child of this process.

// Story MOTIR-3414 · Subtask MOTIR-3427 — the RUNNER starts the Postgres job
// engine's worker (globalSetup) and stops it (globalTeardown). It is a child of
// the runner rather than a `webServer` entry because it binds no port, and this
// flag is what globalSetup reads. Defaulted ON so the lane always carries an
// executor — it is the ONLY one now (MOTIR-3418); export `E2E_JOB_WORKER=0` to
// run the suite without it, which means no background job runs at all.
process.env['E2E_JOB_WORKER'] ??= '1';
// ⚠️ THE INDEX-WRITER SEAM, ON THE WORKER AND NOWHERE ELSE (MOTIR-3564). Its two
// boundaries — motir-ai's run-credential mint and GitHub's tarball redirect — are
// crossed only by the index SUPERVISOR, which is a job, so the process that makes
// both calls is the worker. This flag is what `job-worker-process.ts` reads to
// decide whether to hand the child `E2E_TEST_CODE_GRAPH` + the two credentials;
// setting those HERE would leak them to the app webServer (a runner variable is
// inherited unless `webServer.env` overrides it), and `lib/ai/availability.ts`
// reads exactly `MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN` process-wide — which
// would flip the whole lane cloud-on and break the four specs that assert the OFF
// state. `E2E_JOB_WORKER_CODE_GRAPH_SEAM=0` turns it off.
process.env['E2E_JOB_WORKER_CODE_GRAPH_SEAM'] ??= '1';

// ⚠️ THE EMAIL PATHS GET THE SAME TREATMENT, AND FOR A MEASURED REASON. They
// were hardcoded literals in `webServer.env` while the runner-side helpers
// (`email-capture.ts`, `email-fault.ts`) each accept an env override — so a run
// that set one got a runner reading one file and a server writing another. On a
// box where several sessions run the suite at once that is not hypothetical:
// the defaults live at fixed `/tmp` paths, so a sibling's `clearEmailFault()` in
// its `afterEach` disarms YOUR armed fault, and your forced-failure scenario
// then passes when it should fail.
//
// Defaulting here and forwarding the resolved value keeps CI byte-identical (no
// override -> the same literal it always used) while making a private-path run
// coherent end to end.
process.env['EMAIL_OUTBOX_PATH'] ??= path.resolve('/tmp/motir-test-emails.jsonl');
process.env['EMAIL_FAULT_PATH'] ??= path.resolve('/tmp/motir-test-email-fault');
const EMAIL_OUTBOX_FILE = process.env['EMAIL_OUTBOX_PATH'];
const EMAIL_FAULT_FILE = process.env['EMAIL_FAULT_PATH'];

// Story MOTIR-1981 · MOTIR-1993 — the container fleet's adapter SELECTOR, the
// same `MOTIR_FLEET_ORCHESTRATOR` variable `selectedOrchestratorProvider()`
// reads in production. Unset means `fly`, so leaving it alone would point this
// lane at a real fleet: an E2E that touched the index/CI dispatch path would
// need a Fly org and token, and could bill a machine. `fake` is the shipped
// alternative (`lib/orchestrator/adapters/fake/` — a real adapter behind the
// port, not a test fixture), and it is selected HERE rather than by a mock
// because the app runs in a separately-spawned process an in-process mock
// cannot reach. Set on the RUNNER too (below it also rides webServer.env), so a
// spec or seed helper that reads the selector sees the same answer the server
// does. `??=` keeps a deliberate local override (e.g. a `fly` smoke) possible.
process.env['MOTIR_FLEET_ORCHESTRATOR'] ??= 'fake';

/**
 * Playwright config for motir-core's E2E auth smoke suite.
 *
 * Specs live in tests/e2e/. The webServer block spawns `pnpm dev` on
 * :3000 and waits for it to come up; in CI it's a fresh server per job,
 * locally it reuses an already-running dev server if one is up.
 *
 * Email delivery during E2E uses the dev-only 'file' provider from
 * lib/email.ts (see EMAIL_PROVIDER + EMAIL_OUTBOX_PATH below). The
 * specs read /tmp/motir-test-emails.jsonl to capture reset links.
 *
 * Tagged-suite convention: tests in this Story carry an `@smoke` tag in
 * their describe/test titles. Playwright doesn't have first-class tag
 * filtering, but CI can use `--grep @smoke` (or set a `grep` here) to
 * filter when a later Story adds non-smoke specs.
 *
 * Workers are pinned to 1 because both specs touch the same auth tables
 * and `truncateAuthTables()` is global — parallel workers would race.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // MOTIR-921: resolve `server-only` to an empty stub for the RUNNER only (see
  // tsconfig.node.json). A spec that seeds through a service reaching
  // lib/ai/motirAiClient otherwise dies at import, before collection. Same
  // decision, same stub, as vitest.config.ts and the acceptance config; the Next
  // build still enforces the real boundary.
  tsconfig: './tsconfig.node.json',
  // MOTIR-1565 — the harness readiness gate. Runs AFTER the webServer below
  // reports its `url` ready, but BEFORE the first spec. Playwright's built-in
  // `url` check treats any status < 404 as ready, so a redirecting root URL is
  // "up" the instant the socket binds while `/sign-up` still 404s — which used to
  // red the whole shell-flows suite from one bad shard start. This gate polls the
  // authoritative app route with bounded retry/backoff and throws (failing THIS
  // step, not 8 specs) if the server never comes up. See
  // tests/e2e/global-setup.ts + tests/e2e/_helpers/readiness.ts.
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  // The cloud-on billing journeys (Subtask 8.1.10) run in their own MOTIR_CLOUD
  // lane (playwright.cloud.config.ts) — excluded here so this off-cloud suite
  // never boots them (they 404 without MOTIR_CLOUD, and turning it on globally
  // would break unrelated at-scale/menu specs). The self-host-ABSENT billing spec
  // (billing-selfhost) is off-cloud and DOES run in this lane. The done stories'
  // acceptance specs run in their own lane too (playwright.regression.config.ts,
  // MOTIR-9411), on the acceptance lane's triggers rather than on every PR.
  testIgnore: [
    '**/billing-cloud.spec.ts',
    '**/cloud-*.spec.ts',
    '**/acceptance*.spec.ts',
    '**/regression-*.spec.ts',
    '**/observability-*.spec.ts',
  ],
  // MOTIR-2617 — bulk-leg membership comes from MEASURED per-spec cost, not from
  // Playwright's `--shard=i/5`. `E2E_SHARD=bulk-N` (set per matrix leg in
  // ci.yml) narrows this run to that leg's specs; the a11y / at-scale / billing
  // lanes set nothing and so still see every file, selected by their own
  // `--grep`. The plan, the measurement behind it and the guard that keeps a new
  // spec from silently rejoining a shard live in tests/e2e/shard-plan.ts.
  ...(SHARD_TEST_MATCH ? { testMatch: SHARD_TEST_MATCH } : {}),
  // Each spec has its own truncate + sign-up flow; 30s is plenty for the
  // longest path (request reset → poll file outbox → follow link → set
  // new password).
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  // CI: fail fast on .only and surface flakes via retry counts. Local:
  // no retries, so flakes don't get silently masked during development.
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  // The two branches of the old `CI ? … : …` here were character-for-character
  // identical, so it is one list. The third entry is the MOTIR-2617 harness
  // watchdog: it records the memory series CI uploads per leg, and aborts the
  // shard when the webServer stops answering rather than letting the retry burn
  // a second 180s timeout against the same dead server. It writes files only
  // (`printsToStdio()` is false), so it composes with `list` + `html`.
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'out/playwright-report' }],
    ['./tests/e2e/_reporters/harness-watchdog.ts', { port: Number(PORT) }],
  ],
  outputDir: 'out/playwright-output',
  use: {
    baseURL: BASE_URL,
    // Bounds a navigation independently of the test ceiling (MOTIR-4423).
    // Playwright's default is `0` — no timeout — so `page.goto` / `page.goBack`
    // / `page.waitForURL` fall through to whatever the test has left. This
    // config's own `timeout` is 30s, but 126 specs raise their ceiling with
    // `test.describe.configure({ timeout: … })` (90s–300s here, 900s in the
    // cloud lane), and each one silently widens every bare navigation inside it.
    // The failure mode is not a red check — it is a retry that passes after the
    // hang has already spent the budget. Same 30s the explicit call sites use.
    navigationTimeout: 30_000,
    // Trace on failure keeps zips small (one per failing test) while
    // giving full debugging context. `on-first-retry` would also work
    // but we don't always retry; `retain-on-failure` is the safe pick.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // ONE server (Story 1.6.3; the second went with MOTIR-3418). Transactional
  // emails are not sent inline — password reset + invites enqueue an `email.send`
  // event that a background job delivers, so the lane still needs an EXECUTOR or
  // the email never reaches the file outbox the specs poll (waitForEmail would
  // hang). That executor is the Postgres engine's own worker, started by
  // `globalSetup` as a child of the runner (`E2E_JOB_WORKER` above) — it binds no
  // port, so it is not a `webServer` entry.
  webServer: [
    {
      // MOTIR-1679: run the E2E suite against a PRODUCTION build (`next build`
      // then `next start`), NOT `next dev`. `next dev` holds a resident on-demand
      // compiler that stalled and dropped connections under bulk-shard load
      // (`net::ERR_CONNECTION_RESET` on a random `page.goto` each run); a
      // production server has everything pre-compiled and is stable under load.
      // The build runs inside this command so the flow is identical locally and
      // in CI (prisma generate guards a fresh worktree that never generated the
      // client). `next start` forces NODE_ENV=production, which would trip the
      // Secure-cookie / `/api/_test` 404 / 'file'-email guards meant for a REAL
      // deploy — E2E_PROD_HARNESS=1 (below) re-relaxes ONLY those test seams,
      // exactly as the sibling E2E_* flags already do (see lib/e2eProdHarness.ts).
      // ⚠️ `pnpm build:worker` rides along here on purpose, and it rides along in
      // BOTH branches below. The lane runs the Postgres engine's worker as a
      // third process (see tests/e2e/_helpers/job-worker-process.ts), and it runs
      // the SHIPPED BUNDLE — the same artifact the Dockerfile stages — so the
      // lane exercises the packaging and not just the source. It is NOT part of
      // the `next-build` artifact (that is `.next` only), so nothing upstream can
      // supply it; building it here keeps the flow identical locally and in CI,
      // exactly as `prisma generate` does.
      //
      // ⚠️ `next build` RUNS ONLY WHEN NOTHING UPSTREAM ALREADY BUILT (MOTIR-3928).
      // It used to run unconditionally, which meant every CI leg compiled the app
      // from scratch on top of a `.next` it had just downloaded — measured at
      // 128–189s per leg on run 33260551040, of which 110s was `Running
      // TypeScript`, duplicating the dedicated `TypeScript` job eight to ten times
      // a run. `.github/actions/e2e-setup` is what puts a `.next` in place (by
      // artifact or by building), and it is what sets `E2E_REUSE_BUILD=1` to say
      // so — the flag is set by the step that made the claim true, rather than
      // inferred here from a `.next` directory that might be anyone's leftovers.
      //
      // The two paths, and what selects between them:
      //   • CI  — `e2e-setup` ran, flag set, no build. The suite still runs
      //           against a PRODUCTION `next start`; MOTIR-1679's requirement is
      //           about what SERVES the tests, not about who compiled it.
      //   • local — flag unset, full build, exactly as before. A fresh worktree's
      //           `pnpm test:e2e` still needs no manual step, and a stale local
      //           `.next` can never be silently served.
      command: [
        'pnpm exec prisma generate',
        ...(REUSE_PREBUILT_NEXT ? [] : ['pnpm exec next build']),
        'pnpm run build:worker',
        // MOTIR-5697: the server must outlive the runner's idle sockets — see the helper.
        `pnpm exec next start --port ${PORT} ${NEXT_START_KEEP_ALIVE_FLAG}`,
      ].join(' && '),
      url: BASE_URL,
      // Reuse a running dev server locally for fast iteration — but NEVER when a
      // custom origin was requested (a worktree run), since the only server that
      // could be reused on that port is a sibling's, running different code.
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      // Generous: this window now covers a full `next build` (minutes) before the
      // server binds, not just a `next dev` boot.
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // MOTIR-1679: run the suite against a production build; this flag
        // re-relaxes the NODE_ENV=production test seams (Secure cookies /
        // /api/_test 404 gate / 'file' email sink) that the production server
        // would otherwise trip. Only ever set here, never in a real deploy.
        E2E_PROD_HARNESS: '1',
        // Story 10.2 (MOTIR-7333): the system-health board's three providers,
        // bound to their in-memory fakes so the walk films populated cards without
        // calling Sentry, Fly or the gateway. Read server-side at call time, so they
        // must reach THIS process; each is refused in a production build unless
        // E2E_PROD_HARNESS is also set. FLY_APP_NAME / FLY_REGION give the Hosting
        // card the deployment identity it reports beside the fake fleet.
        MOTIR_E2E_FAKE_ERROR_COUNT: '1',
        MOTIR_E2E_FAKE_DEPLOYMENT_STATUS: '1',
        MOTIR_E2E_FAKE_GATEWAY_STATUS: '1',
        FLY_APP_NAME: 'motir-core-e2e',
        FLY_REGION: 'iad',
        // MOTIR-2816: the SERVER's own connection, and nothing else in the run.
        ...(APP_ROLE_SERVER && OWNER_DATABASE_URL
          ? { DATABASE_URL: appRoleDatabaseUrl(OWNER_DATABASE_URL) }
          : {}),
        // Give `next build` V8 old-space headroom (it is memory-heavy); harmless
        // for the lightweight `next start` that follows. 6 GB is safely inside
        // the 16 GB `ubuntu-latest` budget shared with Postgres, the worker
        // binary, the Playwright runner, and Chromium. (An earlier fix bumped
        // this to stop the `next dev` webServer GC-thrashing/OOMing under load;
        // moving to a production build removes that failure mode entirely, but
        // the headroom still helps the build.)
        // MOTIR-1753 — size the libuv THREADPOOL for a Node-served build.
        // `next start` reads every static chunk off disk through the threadpool,
        // whose libuv default is FOUR. Measured here: 125 outstanding
        // `fs/promises` requests against those 4 threads — a ~31x queue depth.
        // Everything else that shares the pool then queues behind it, including
        // the completions Prisma's in-flight INTERACTIVE transactions are waiting
        // on, so a transaction sits `idle in transaction` (Postgres reporting
        // `Client/ClientRead` — waiting on US) until it blows Prisma's 5s budget
        // and the render 500s with P2028 / "commit cannot be executed on an
        // expired transaction". A/B on this lane: pool 4 -> 8s stalls + failure;
        // pool 64 -> zero stalls, green, 4.5x faster.
        // Same exposure applies to any deployment where Node serves the assets
        // (self-host `next start`); behind a CDN the static reads never reach it.
        UV_THREADPOOL_SIZE: '64',
        NODE_OPTIONS: '--max-old-space-size=6144',
        EMAIL_PROVIDER: 'file',
        EMAIL_OUTBOX_PATH: EMAIL_OUTBOX_FILE,
        // E2E_TEST_OAUTH=1 makes instrumentation.ts install an undici
        // MockAgent that intercepts POSTs to oauth2.googleapis.com/token,
        // returning a synthetic id_token. See instrumentation.ts +
        // tests/e2e/auth-google.spec.ts for the wiring. Production builds
        // (and any local dev where this var isn't set) leave the dispatcher
        // untouched.
        E2E_TEST_OAUTH: '1',
        E2E_TEST_OAUTH_USER_PATH: path.resolve('/tmp/motir-test-oauth-user.json'),
        // Subtask 5.2.8: E2E_TEST_BLOB=1 makes instrumentation.ts mock the
        // object store (see lib/test-blob-mock.ts), so the attachments journey
        // uploads through the real route without a real blob store — CI
        // deliberately has no real credentials ("no E2E performs a real
        // upload", ci.yml). The placeholders below only have to be PRESENT and
        // well-formed; every request they authorize is intercepted before it
        // leaves the process. Forced even when real credentials are configured
        // locally, so the suite never writes to (or depends on) a live store.
        E2E_TEST_BLOB: '1',
        // MOTIR-2389: the store is now S3-compatible. The endpoint is the host
        // lib/test-blob-mock.ts intercepts, so it must match there.
        MOTIR_S3_ENDPOINT: 'https://e2e.s3.invalid',
        MOTIR_S3_REGION: 'auto',
        MOTIR_S3_ACCESS_KEY_ID: 'e2e-playwright-only-placeholder',
        MOTIR_S3_SECRET_ACCESS_KEY: 'e2e-playwright-only-placeholder-secret',
        MOTIR_S3_PRIVATE_BUCKET: 'motir-e2e-private',
        MOTIR_S3_PUBLIC_BUCKET: 'motir-e2e-public',
        MOTIR_S3_PUBLIC_BASE_URL: 'https://e2etest.public.store.invalid',
        // PRODECT_FINDINGS #8: hand the dev server the same origin Playwright
        // drives. lib/baseUrl.ts resolves MOTIR_BASE_URL, and lib/auth/index.ts
        // uses that as both its baseURL and a trustedOrigins entry, so this is
        // what lets /api/auth/* POSTs pass the CSRF origin guard on a
        // non-default port.
        MOTIR_BASE_URL: BASE_URL,
        // The rail's Docs row renders only when the operator has configured
        // where the documentation is published (MOTIR-4167) — the same shape as
        // the Legal row. Four specs read the row as the CONTROL for "the bottom
        // section is on screen", so the lane configures it; the value is
        // deliberately unreachable and nothing follows it, every assertion
        // reads visibility or the `href`.
        MOTIR_DOCS_URL: 'https://public.motir.e2e/docs',
        // PRODECT_FINDINGS #9: Better-Auth buckets /sign-in + /sign-up into one
        // IP-keyed window (10s / max 3). Multi-user specs sign up several users
        // from localhost inside that window and hit 429s. This flag disables the
        // limiter for the E2E dev server only; lib/auth/index.ts reads it and
        // leaves the limiter fully active everywhere it isn't set (i.e. prod).
        E2E_DISABLE_RATE_LIMIT: '1',
        // Subtask 1.6.6: arm-able deterministic email-fault injector. lib/email.ts
        // reads this file on every send and throws when the recipient matches the
        // armed substring, so the jobs-flow spec can drive the real failure →
        // DLQ → replay path. The file is absent (fault disarmed) unless a spec
        // writes it via tests/e2e/_helpers/email-fault.ts; it is test-only and
        // refused in production.
        EMAIL_FAULT_PATH: EMAIL_FAULT_FILE,
        // Subtask 1.5.6: hide the Next dev-tools indicator (a bottom-left
        // fixed portal) so it stops occluding the sidebar footer's collapse
        // toggle during the browser-driven shell-flows journey. next.config.ts
        // reads this flag; a normal `pnpm dev` session keeps its indicator.
        E2E_DISABLE_DEV_INDICATOR: '1',
        // Subtask 3.5.1: the board load-model overrides, forwarded from the run's
        // env only when set (empty by default — see BOARD_LOAD_SEAM_ENV above).
        ...BOARD_LOAD_SEAM_ENV,
        // Story 7.10 · MOTIR-897: the GitHub-integration E2E lane. The webhook
        // secret is the SAME value the spec's signWebhook uses (shared via
        // tests/e2e/_helpers/github-const.ts), so the real 7.10.4 signature
        // gate runs against the spec's signed POSTs. The OAuth app creds are
        // synthetic — the code→token exchange + /user read never leave the
        // process (E2E_TEST_OAUTH's MockAgent above intercepts GitHub too).
        GITHUB_WEBHOOK_SECRET: E2E_GITHUB_WEBHOOK_SECRET,
        GITHUB_APP_CLIENT_ID: E2E_GITHUB_CLIENT_ID,
        GITHUB_APP_CLIENT_SECRET: E2E_GITHUB_CLIENT_SECRET,
        GITHUB_TOKEN_ENCRYPTION_KEY: E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
        GITHUB_APP_SLUG: E2E_GITHUB_APP_SLUG,
        // Story 7.23 · MOTIR-1480: the GitLab-integration E2E lane. The webhook
        // secret is the SAME token the spec sends in X-Gitlab-Token (shared via
        // tests/e2e/_helpers/gitlab-const.ts), so the real MOTIR-1475 token gate
        // runs against the spec's deliveries. The OAuth creds are synthetic — the
        // code→token exchange + /api/v4/user read never leave the process
        // (E2E_TEST_OAUTH's MockAgent above intercepts gitlab.com too). GitLab
        // PERSISTS its OAuth tokens, so the connect callback needs the encryption
        // key. GITLAB_BASE_URL is left at its gitlab.com default so the mock host
        // matches.
        GITLAB_WEBHOOK_SECRET: E2E_GITLAB_WEBHOOK_SECRET,
        GITLAB_APP_CLIENT_ID: E2E_GITLAB_CLIENT_ID,
        GITLAB_APP_CLIENT_SECRET: E2E_GITLAB_CLIENT_SECRET,
        GITLAB_TOKEN_ENCRYPTION_KEY: E2E_GITLAB_TOKEN_ENCRYPTION_KEY,
        // Story MOTIR-1981 · MOTIR-1993: the fleet adapter selector, handed to
        // the SERVER (the runner sets its own copy at module scope above). This
        // is the seam the app reads at boot — `webServer.env` REPLACES the
        // child's environment for these keys, so an inherited `fly` from the
        // developer's shell cannot leak in.
        MOTIR_FLEET_ORCHESTRATOR: process.env['MOTIR_FLEET_ORCHESTRATOR'] ?? 'fake',
      },
    },
  ],
});
