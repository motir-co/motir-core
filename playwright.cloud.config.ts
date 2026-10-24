import { defineConfig, devices } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  E2E_GITHUB_APP_SLUG,
  E2E_GITHUB_CLIENT_ID,
  E2E_GITHUB_CLIENT_SECRET,
  E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
  E2E_GITHUB_WEBHOOK_SECRET,
  E2E_PROVISIONING_ORG,
} from './tests/e2e/_helpers/github-const';
import { E2E_CORE_CALLBACK_SECRET } from './tests/e2e/_helpers/log-bug-as-ai';
import { E2E_LEGAL_DOCUMENTS_JSON } from './tests/e2e/_helpers/legal-manifest';
import { NEXT_START_KEEP_ALIVE_FLAG } from './tests/e2e/_helpers/server-keep-alive';

// The CLOUD-ON regression lane (Subtask 8.1.10, widened by MOTIR-2849).
//
// ── WHAT THIS LANE IS FOR, AND WHY IT GREW ──────────────────────────────────
//
// It began as the billing lane and is now the home for EVERY regression spec
// whose subject only exists cloud-on. MOTIR-2765 retires the acceptance lane's
// role as a permanent home for specs: once a story's receipt is approved the
// spec that produced it must be PROMOTED into a lane that runs on every PR, or
// retired. For nine of those specs the main lane is not a legal destination —
// it sets none of MOTIR_CLOUD, E2E_TEST_BILLING, MOTIR_AI_URL or
// E2E_TEST_CODE_HEALTH, so the product they assert is switched off there.
//
// ⚠️ AND THEY WOULD NOT GO RED — THEY WOULD GO GREEN. Off-cloud the entitlement
// paths short-circuit to the same inert value they return for an EXEMPT org
// (`billingService.getAiAccess` → `applicable: false`), so an assertion passes
// because billing does not exist rather than because the rule works. That is
// MOTIR-2601, already paid for once. `tests/e2e/ai-callout-gate.spec.ts` states
// the main lane's ground truth from the other side: with Motir AI unconfigured
// there is no orb at all.
//
// WHY WIDEN THIS LANE RATHER THAN BUILD A THIRD (MOTIR-2849). It is already
// cloud-on, already has its own ports and its own CI leg, and the only thing in
// the way was a single hard-coded filename in `testMatch`. A third lane costs a
// third `next build` on every PR, forever, for an env this one already provides.
// Rejected alternatives: adding the flags to the MAIN lane (that turns ~115
// specs cloud-on — a product-posture change smuggled in as a test refactor, and
// it breaks the specs that assert the OFF-cloud shape, `ai-callout-gate` and
// `billing-selfhost` most obviously); and retiring the nine (seven have no twin
// anywhere, and `cloud-acceptance-video.spec.ts` is the only coverage of the
// paid / toggle / pending / upgrade gate states and the board's awaiting badge).
//
// MEMBERSHIP: `billing-cloud.spec.ts` plus the `cloud-*.spec.ts` prefix. The main
// config `testIgnore`s both, so nothing runs twice.
//
// ── The original billing rationale, unchanged ───────────────────────────────
//
// Billing is cloud-only (MOTIR_CLOUD) and turning it on globally would activate
// the §4 entitlement caps (250 work items / 3 projects / 1 workspace) + surface
// the billing menu row — which breaks unrelated specs that seed past those caps
// through the service path (epic6-at-scale's 10k items, workspace-flows' 2nd
// workspace) and the one that asserts the billing row ABSENT off-cloud
// (org-admin). So billing runs in its OWN lane with its OWN cloud-on server,
// leaving the main suite (playwright.config.ts) untouched and off-cloud. The
// self-host-ABSENT scenario is the inverse and stays in the main (off-cloud) lane
// (tests/e2e/billing-selfhost.spec.ts).
//
// The motir-ai side of billing (AI plan/usage + Stripe sessions) is stood in for
// by the E2E_TEST_BILLING boundary mock (instrumentation.ts → lib/test-billing-mock),
// so no live Stripe secret and no motir-ai instance are needed in CI.

loadEnv();

// A SEPARATE default port from the main lane (3000) so the two can run
// concurrently and a stray off-cloud :3000 dev server is never reused here.
const USING_CUSTOM_ORIGIN = Boolean(process.env['E2E_BASE_URL']) || Boolean(process.env['PORT']);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3100'}`;
const PORT = new URL(BASE_URL).port || '3100';

// The boundary the mock intercepts — an unresolvable host, so a missing intercept
// fails loud instead of silently escaping to a real network.
const MOTIR_AI_URL = 'http://motir-ai.e2e.local';
const MOTIR_AI_BILLING_FIXTURE_PATH = path.resolve('/tmp/motir-test-billing-fixture.json');
const MOTIR_AI_JOBS_FIXTURE_PATH = path.resolve('/tmp/motir-cloud-ai-jobs-fixture.json');
// The SHARPEN seam's control file (Task MOTIR-1101 · MOTIR-8180): the spec writes
// each target's script, the server's fake appends the submits and write-backs.
const MOTIR_AI_SHARPEN_CONTROL_PATH = path.resolve('/tmp/motir-cloud-sharpen-control.json');
process.env['MOTIR_AI_SHARPEN_CONTROL_PATH'] ??= MOTIR_AI_SHARPEN_CONTROL_PATH;

// ── The boundary fixtures the specs promoted by MOTIR-2849 drive ─────────────
// Carried over from `playwright.acceptance.config.ts` verbatim in intent: each
// is a file the SPEC writes and the SERVER reads, so both sides must agree on
// the path, and both the runner and the webServer must see it.
const CODE_HEALTH_FIXTURE = path.join(__dirname, 'out', 'e2e-code-health-fixture.json');
// The LESSON LIBRARY's boundary fixture (Subtask MOTIR-3340), on the same terms:
// the library's three screens are all SERVER rendered, so `page.route` reaches
// none of them and the spec seeds through this file instead.
const LESSONS_FIXTURE = path.join(__dirname, 'out', 'e2e-lessons-fixture.json');
// The console's AI PLANNING page (MOTIR-7231) — server rendered with a Server
// Action write, so the spec seeds and reads back through this file.
const PLANNER_MODEL_FIXTURE = path.join(__dirname, 'out', 'e2e-planner-model-fixture.json');
const MOTIR_GITHUB_CONTROL_PATH = path.resolve('/tmp/motir-cloud-github-control.json');
const MOTIR_GITHUB_JOURNAL_PATH = path.resolve('/tmp/motir-cloud-github-journal.jsonl');
process.env['MOTIR_GITHUB_CONTROL_PATH'] ??= MOTIR_GITHUB_CONTROL_PATH;
process.env['MOTIR_GITHUB_JOURNAL_PATH'] ??= MOTIR_GITHUB_JOURNAL_PATH;
// ── The GitHub MERGE seam (MOTIR-5572), carried here by Story MOTIR-7460 ─────
// `cloud-approve-and-merge.spec.ts` (promoted from the acceptance lane) presses
// *Approve and merge*, which merges SERVER-side, so the fake GitHub merge lives in
// the Next process (lib/test-github-merge-mock.ts, behind E2E_TEST_GITHUB_MERGE=1)
// exactly as `playwright.acceptance.config.ts` wires it. The spec WRITES the control
// file and READS the journal, so both paths are set on the runner as well as the
// server. The seam claims a path only for a repository its control file names, so
// no other spec in this lane meets it. The worker half travels with it
// (`githubMergeSeamEnv`, MOTIR-5837), so a job that reads the host is faked too.
const MOTIR_GITHUB_MERGE_CONTROL_PATH = path.resolve('/tmp/motir-cloud-github-merge-control.json');
const MOTIR_GITHUB_MERGE_JOURNAL_PATH = path.resolve('/tmp/motir-cloud-github-merge-journal.jsonl');
process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH'] ??= MOTIR_GITHUB_MERGE_CONTROL_PATH;
process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH'] ??= MOTIR_GITHUB_MERGE_JOURNAL_PATH;
process.env['E2E_JOB_WORKER_GITHUB_MERGE_SEAM'] ??= '1';

// ── The motir-ai CODE-GRAPH READ seam (Story MOTIR-7858 · MOTIR-7866) ───────
// `cloud-mcp-code-read.spec.ts` pages a `code_explore` result over `/api/mcp`, and the
// server calls motir-ai's `POST /v1/code-graph/read` itself, so the fake lives in the
// Next process (lib/test-code-graph-read-mock.ts, behind E2E_TEST_CODE_GRAPH_READ=1).
// The spec WRITES the fixture and READS the journal, so both paths are set on the
// runner as well as the server.
const MOTIR_AI_CODE_GRAPH_READ_FIXTURE_PATH = path.resolve(
  '/tmp/motir-cloud-code-graph-read-fixture.json',
);
const MOTIR_AI_CODE_GRAPH_READ_JOURNAL_PATH = path.resolve(
  '/tmp/motir-cloud-code-graph-read-journal.jsonl',
);
process.env['MOTIR_AI_CODE_GRAPH_READ_FIXTURE_PATH'] ??= MOTIR_AI_CODE_GRAPH_READ_FIXTURE_PATH;
process.env['MOTIR_AI_CODE_GRAPH_READ_JOURNAL_PATH'] ??= MOTIR_AI_CODE_GRAPH_READ_JOURNAL_PATH;

/** The Studio App's credentials. The private key is GENERATED per run rather
 *  than committed: `createAppJwt` really signs RS256 with it (the shipped path
 *  runs unchanged), and a PEM in the repo is a secret-scanner finding for no
 *  benefit. Same decision as the acceptance config. */
const E2E_STUDIO_APP_ID = '424242';
const { privateKey: E2E_STUDIO_APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ⚠️ THE EXECUTOR IS THE ENGINE'S OWN WORKER (MOTIR-3418). This lane used to
// boot a vendor dev server as a second `webServer` and point the runner's SDK
// at it, because seed helpers call services that emit post-commit and a
// key-less SDK threw. An emit is a row in this run's database now, and the
// thing that EXECUTES it is `startJobWorker` in `globalSetup` below — without
// which `email.send` never delivers and every `waitForEmail` in this lane hangs.
// Config-module scope runs before workers fork; they inherit it.
process.env['E2E_JOB_WORKER'] ??= '1';
// The cloud gate the billing surfaces read — also set for the runner process so
// seed-side service reads see the same cloud state the server does.
process.env['MOTIR_CLOUD'] ??= 'true';
// ⚠️ THE LEGAL MANIFEST, ON THE RUNNER TOO — AND IT IS NOT OPTIONAL HERE
// (MOTIR-4015). `motir-core` reads its legal documents from configuration now
// (MOTIR-4007); an unset variable is a VALID state meaning "this operator
// published none", and on that build `outstandingReconsent` has nothing to
// compare and the re-consent gate holds nobody. So without this line
// `cloud-legal-reconsent.spec.ts` does not go red in an informative way — it
// asserts a hold that the build can no longer perform. The runner needs the SAME
// value as the webServer because that spec calls `listLegalDocuments()` itself
// to learn the published versions it then expects on the screen.
process.env['MOTIR_LEGAL_DOCUMENTS'] ??= E2E_LEGAL_DOCUMENTS_JSON;
process.env['MOTIR_AI_BILLING_FIXTURE_PATH'] ??= MOTIR_AI_BILLING_FIXTURE_PATH;
process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ??= MOTIR_AI_JOBS_FIXTURE_PATH;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['**/billing-cloud.spec.ts', '**/cloud-*.spec.ts'],
  // The observability lane (MOTIR-8557) needs a server with Sentry on, which this
  // one is not; its prefix never matches here, and this says so.
  testIgnore: ['**/observability-*.spec.ts'],
  // MOTIR-921: resolve `server-only` to an empty stub for the RUNNER only (see
  // tsconfig.node.json). A spec that seeds through a service reaching
  // lib/ai/motirAiClient otherwise dies at import, before collection. Same
  // decision, same stub, as vitest.config.ts and the acceptance config; the Next
  // build still enforces the real boundary.
  tsconfig: './tsconfig.node.json',
  // ⚠️ ADDED BY MOTIR-3418, AND THE LANE DOES NOT WORK WITHOUT IT. `globalSetup`
  // starts the Postgres engine's worker (and `globalTeardown` drains it) — the
  // executor that replaced the vendor dev server this config used to boot as a
  // second `webServer`. It is not a `webServer` entry because it binds no port.
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  // Raised from 30s/5s by MOTIR-2849: the nine promoted specs are long journeys
  // (the repository-set one alone drives nine), and they were authored against
  // the acceptance lane's 90s/20s budget. Lowering their budget as part of a
  // MOVE would be a behaviour change wearing a rename's clothes.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'out/playwright-report-billing' }]],
  outputDir: 'out/playwright-output-billing',
  use: {
    baseURL: BASE_URL,
    // ⚠️ WITHOUT THIS A NAVIGATION IS BOUNDED ONLY BY THE TEST CEILING, and in
    // this lane that ceiling is FIFTEEN MINUTES (MOTIR-4423). Playwright's
    // default `navigationTimeout` is `0` — no timeout — so `page.goto` /
    // `page.goBack` / `page.waitForURL` inherit whatever the test has left.
    // `cloud-plans-surface.spec.ts` sets `timeout: 900_000` for its seed, which
    // is CORRECT (see the note there: the budget is the seed, and a green run
    // pays nothing for headroom) — but a bare `waitForURL` then gets that same
    // quarter-hour. It happened on merge-group run 33856167486: one hung
    // `waitForURL` at `cloud-plans-surface.spec.ts:344` burned the full 900s and
    // PASSED ON RETRY, so nothing went red — it only turned a 7.5-minute lane
    // into a 23-minute one and held a merge-queue build slot for the difference.
    //
    // 30s is not a new number: it is what a dozen call sites in `tests/e2e`
    // already pass explicitly to `waitForURL`. Setting it here bounds the ones
    // that forgot, and leaves every test ceiling exactly as authored.
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // A PRODUCTION build, not `pnpm dev` (MOTIR-2849, adopting MOTIR-1682's
      // finding). `next dev`'s on-demand compiler made the first test to hit a
      // heavy route pay a cold-compile cost that blew even a 60s assertion
      // timeout under CI load — the original test-1 flake. The nine specs moving
      // in here were authored against a pre-built server for exactly that
      // reason, so the lane they move into has to be one too.
      // ⚠️ `build:worker` IS PART OF THE SERVER COMMAND, and this lane needs it
      // (MOTIR-3418). `globalSetup` starts the engine's worker from the SHIPPED
      // bundle at `.worker/worker.mjs` — never the TypeScript source — so a lane
      // that does not build it fails in globalSetup before a single spec runs.
      // The main config's command has carried this since MOTIR-3427; this one did
      // not need it while the executor was a second `webServer`.
      // MOTIR-5697: the server must outlive the runner's idle sockets — see the helper.
      command: `pnpm exec prisma generate && pnpm exec next build && pnpm run build:worker && pnpm exec next start --port ${PORT} ${NEXT_START_KEEP_ALIVE_FLAG}`,
      // The promoted public-redirect regression intentionally redirects `/`.
      url: `${BASE_URL}/sign-in`,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      // Generous: now covers a full `next build` before the server binds.
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // ── The cloud posture ──
        MOTIR_CLOUD: 'true',
        E2E_TEST_BILLING: '1',
        MOTIR_AI_URL,
        // A placeholder service token: motirAiClient.config() requires it to be
        // set, but the boundary mock intercepts every call before it leaves.
        MOTIR_AI_SERVICE_TOKEN: 'e2e-billing-placeholder-token',
        MOTIR_AI_BILLING_FIXTURE_PATH,
        E2E_TEST_AI_JOBS: '1',
        MOTIR_AI_JOBS_FIXTURE_PATH,
        // The Sharpen seam (MOTIR-8180). An ending turn makes core's REAL
        // write-back call, `PUT /api/internal/ai/plan-sharpening`, so the server
        // needs the ai → core service bearer that route checks — the same literal
        // the acceptance lane sets for its log-bug walk.
        E2E_TEST_SHARPEN: '1',
        MOTIR_AI_SHARPEN_CONTROL_PATH,
        CORE_CALLBACK_SECRET: E2E_CORE_CALLBACK_SECRET,
        MOTIR_PUBLIC_SITE_URL: 'https://public.motir.e2e',
        // ⚠️ THE TENANT BASE DOMAIN, and WITHOUT IT `cloud-public-address-release`
        // CANNOT REACH THE STATES IT ASSERTS (Story MOTIR-4451 · MOTIR-4457).
        // The Public address pane renders an operator explanation and NO claim
        // field when this is unset, so the spec would walk that instead of the
        // room — `plan-rules/type-test.md` tell (d), a lane that cannot reach the
        // asserted state. It is armed here for the same reason
        // `playwright.acceptance.config.ts` arms it, and with the same value, so
        // the two lanes agree about what `<base>` is.
        //
        // The certificate + DNS fakes the acceptance lane also arms are NOT
        // needed here: the release walk never touches a custom domain, and a
        // workspace subdomain is covered by the wildcard `*.<base>` (ADR §6), so
        // claiming one issues no certificate and releasing one withdraws none.
        MOTIR_PUBLIC_TENANT_DOMAIN: 'motir.e2e',
        // The configured legal manifest (MOTIR-4015) — the same value the runner
        // above reads, from the same module, so the two cannot drift. Its URLs
        // sit under the synthetic public origin on the line above, which is
        // deliberately unreachable: every assertion reads the `href`, none
        // follows it.
        MOTIR_LEGAL_DOCUMENTS: E2E_LEGAL_DOCUMENTS_JSON,
        // The rail's Docs row is conditional too (MOTIR-4167), and
        // `regression-legal-manifest.spec.ts` reads it as the CONTROL for the
        // Legal row's absence — so it is configured, under the same synthetic
        // public origin as the legal urls above.
        MOTIR_DOCS_URL: 'https://public.motir.e2e/docs',
        // ── The prod-build harness (MOTIR-1682) ──
        // `next start` forces NODE_ENV=production; this re-relaxes ONLY the test
        // seams (Secure cookies / the `/api/_test` 404 gate / 'file' email — see
        // lib/e2eProdHarness.ts). The specs here seed via `/api/_test`, so it MUST
        // be set.
        E2E_PROD_HARNESS: '1',
        // `next build` is memory-heavy; and `next start` reads every static chunk
        // through the libuv threadpool, whose default of FOUR queues Prisma's
        // in-flight interactive transactions behind it until they blow the 5s
        // budget and the render 500s (MOTIR-1753 — measured 4 → stalls, 64 → none).
        UV_THREADPOOL_SIZE: '64',
        NODE_OPTIONS: '--max-old-space-size=6144',
        // ── The boundary seams the promoted specs drive (MOTIR-2849) ──
        // Each is the same fixture the acceptance lane provided; a spec that moved
        // here without its seam would assert against a product half switched on.
        E2E_TEST_CODE_HEALTH: '1',
        MOTIR_AI_CODE_HEALTH_FIXTURE_PATH: CODE_HEALTH_FIXTURE,
        E2E_TEST_LESSONS: '1',
        MOTIR_AI_LESSONS_FIXTURE_PATH: LESSONS_FIXTURE,
        E2E_TEST_PLANNER_MODEL: '1',
        MOTIR_AI_PLANNER_MODEL_FIXTURE_PATH: PLANNER_MODEL_FIXTURE,
        E2E_TEST_CODE_GRAPH_READ: '1',
        MOTIR_AI_CODE_GRAPH_READ_FIXTURE_PATH,
        MOTIR_AI_CODE_GRAPH_READ_JOURNAL_PATH,
        E2E_TEST_GITHUB_REPOS: '1',
        MOTIR_GITHUB_CONTROL_PATH,
        MOTIR_GITHUB_JOURNAL_PATH,
        // The merge seam (see its block above) and the signed-webhook secret the
        // promoted approve-and-merge walk delivers its pull requests through.
        E2E_TEST_GITHUB_MERGE: '1',
        MOTIR_GITHUB_MERGE_CONTROL_PATH,
        MOTIR_GITHUB_MERGE_JOURNAL_PATH,
        GITHUB_WEBHOOK_SECRET: E2E_GITHUB_WEBHOOK_SECRET,
        GITHUB_FALLBACK_ORG: E2E_PROVISIONING_ORG,
        GITHUB_STUDIO_APP_ID: E2E_STUDIO_APP_ID,
        GITHUB_STUDIO_APP_PRIVATE_KEY: E2E_STUDIO_APP_PRIVATE_KEY,
        GITHUB_TOKEN_ENCRYPTION_KEY: E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
        GITHUB_APP_SLUG: E2E_GITHUB_APP_SLUG,
        E2E_TEST_OAUTH: '1',
        GITHUB_APP_CLIENT_ID: E2E_GITHUB_CLIENT_ID,
        GITHUB_APP_CLIENT_SECRET: E2E_GITHUB_CLIENT_SECRET,
        // The object store is mocked — CI has no real credentials, and the
        // acceptance panel's player reads through the private content path.
        E2E_TEST_BLOB: '1',
        MOTIR_S3_ENDPOINT: 'https://e2e.s3.invalid',
        MOTIR_S3_REGION: 'auto',
        MOTIR_S3_ACCESS_KEY_ID: 'e2e-playwright-only-placeholder',
        MOTIR_S3_SECRET_ACCESS_KEY: 'e2e-playwright-only-placeholder-secret',
        MOTIR_S3_PRIVATE_BUCKET: 'motir-e2e-private',
        MOTIR_S3_PUBLIC_BUCKET: 'motir-e2e-public',
        MOTIR_S3_PUBLIC_BASE_URL: 'https://e2etest.public.store.invalid',
        // ── The shared E2E server env (mirrors playwright.config.ts) ──
        EMAIL_PROVIDER: 'file',
        EMAIL_OUTBOX_PATH: path.resolve('/tmp/motir-test-emails.jsonl'),
        MOTIR_BASE_URL: BASE_URL,
        E2E_DISABLE_RATE_LIMIT: '1',
        E2E_DISABLE_DEV_INDICATOR: '1',
      },
    },
  ],
});
