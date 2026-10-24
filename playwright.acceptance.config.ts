import { defineConfig, devices } from '@playwright/test';
import { E2E_GITHUB_WEBHOOK_SECRET } from './tests/e2e/_helpers/github-const';
import { E2E_AI_TO_CORE_SERVICE_TOKEN } from './tests/e2e/_helpers/billing-push';
import { E2E_CORE_CALLBACK_SECRET } from './tests/e2e/_helpers/log-bug-as-ai';
import { NEXT_START_KEEP_ALIVE_FLAG } from './tests/e2e/_helpers/server-keep-alive';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  E2E_GITHUB_APP_SLUG,
  E2E_GITHUB_CLIENT_ID,
  E2E_GITHUB_CLIENT_SECRET,
  E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
  E2E_PROVISIONING_ORG,
  E2E_STUDIO_APP_ID,
} from './tests/e2e/_helpers/github-const';

// Dedicated ACCEPTANCE E2E lane (Story MOTIR-1627 · Subtask MOTIR-1632;
// per-story support MOTIR-1700).
//
// The main suite records `video: 'retain-on-failure'` — it keeps a clip only
// when a test FAILS. Story acceptance needs the opposite: a clip of the GREEN
// run, published as the story's acceptance receipt. So the acceptance E2E runs
// in its OWN lane with `video: 'on'` + `trace: 'on'`, capped to the ADR's budget
// (≤ ~60s per the spec's own scope, 720p, a few MB), leaving the main lane
// (playwright.config.ts) untouched at retain-on-failure.
//
// `testMatch` catches BOTH the MOTIR-1627 self-test dogfood
// (`acceptance-video.spec.ts`) AND story-specific acceptance specs
// (`acceptance-<story>.spec.ts`) — the planner rule (MOTIR-1644) creates an
// acceptance E2E subtask for every user-facing story, and each writes its
// spec using the `acceptance-<area>.spec.ts` naming convention so this lane
// discovers it. The main config (playwright.config.ts) `testIgnore`s the same
// `acceptance*.spec.ts` pattern so acceptance specs never run in the bulk
// shards (video:'retain-on-failure' + no upload step).
//
// ⚠️ WHO PUBLISHES — THE LANE AGAIN, SINCE 2026-10-01 (MOTIR-7253). This lane's
// `outputDir` is read by the CI uploader (`scripts/upload-acceptance-video.mjs`,
// through `.github/actions/upload-acceptance-video`), which POSTs the video +
// trace + chapters of each spec the PR changed to the publish endpoint
// (MOTIR-1631) from a green pull-request run, over keyless OIDC. From 2026-09-01
// (MOTIR-4096) until then that uploader was retired and the AGENT published;
// the dispatch prompt now reads the checkout and stands the agent down here
// (MOTIR-7254), while an agent in a repository with no such lane still
// publishes over MCP.
//
// ⚠️ THE MCP DOOR DID NOT EXIST UNTIL MOTIR-4704 — kept as the history of why it
// is there. This paragraph said "through the Motir MCP surface" for four days while the MCP
// surface had no acceptance publisher on it at all — so an agent that read this
// file, searched its tool palette and found nothing had been told, accurately,
// to use a door that was not there. The door is now `create_acceptance_upload`
// + `publish_acceptance_result` (two calls: a recording is far larger than a
// tool argument can carry), and the runner's own dispatch prompt asks for them
// on a card that records one — which is the half that makes this work without
// anybody reading this comment.
// What is unchanged is the PRODUCTION side, and it is what this config still
// owes: each spec declares its target story via the `acceptanceStory()` helper →
// `acceptance-story.json` sidecar, and `chapter()` writes `chapters.json`
// beside it, so whoever publishes can resolve a recording to its story. A
// failing run leaves no video — a red acceptance E2E still produces no receipt.
//
// ── Cloud posture: this lane runs CLOUD-ON ──────────────────────────────────
//
// `MOTIR_CLOUD` is set below on BOTH the runner process and the webServer, like
// playwright.cloud.config.ts. This is the file's ONE statement of its
// posture; the assignment sites point back here rather than restate it. Two
// reasons, and the second is why the paragraph is at the TOP of the file:
//
//  1. REACHABILITY. Acceptance video branches on the paid-AI-plan gate
//     (MOTIR-1630), which is inert off-cloud — an off-cloud run renders the
//     ungated player and can never reach the toggle-off / no-plan panel states
//     these specs are here to record.
//  2. FALSIFIABILITY. Entitlement paths short-circuit to the SAME inert value
//     off-cloud that they return for an EXEMPT organization
//     (`billingService.getAiAccess` → `applicable: false`). So off-cloud, an
//     assertion that a meta org sees no paywall passes because billing does not
//     exist, not because the exemption works — permanently green, and green for
//     a reason it is not testing. Cloud-on is what lets that assertion fail.
//
// The motir-ai side is the E2E_TEST_BILLING boundary mock — no live Stripe, no
// live motir-ai.
//
// (MOTIR-2601: this block used to open by saying the lane ran OFF-cloud. That
// was true for the 77 minutes between the lane landing and the flip to
// cloud-on; it then sat here as the file's first sentence about itself and
// misled a spec author into writing exactly the assertion reason 2 describes.)

loadEnv();

// A SEPARATE default port from the main (3000) and billing (3100) lanes so all
// three can run concurrently and a stray sibling server is never reused here.
const USING_CUSTOM_ORIGIN = Boolean(process.env['E2E_BASE_URL']) || Boolean(process.env['PORT']);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3200'}`;
const PORT = new URL(BASE_URL).port || '3200';

// ⚠️ THE EXECUTOR IS THE ENGINE'S OWN WORKER (MOTIR-3418). This lane used to
// boot a vendor dev server as a second `webServer` and point the runner's SDK
// at it, because seed helpers call services that emit post-commit and a
// key-less SDK threw. An emit is a row in this run's database now, and the
// thing that EXECUTES it is `startJobWorker` in `globalSetup` below — without
// which `email.send` never delivers and every `waitForEmail` in this lane hangs.
process.env['E2E_JOB_WORKER'] ??= '1';
// …and the worker must select the SAME fake monitor provider the webServer does
// below, with the same token key, or the resolve-back job (MOTIR-5703) runs
// against the real adapter and a grant it cannot decrypt (MOTIR-5709;
// `monitorFakeEnv` in `tests/e2e/_helpers/job-worker-process.ts`).
process.env['E2E_JOB_WORKER_MONITOR_FAKE'] ??= '1';

// The cloud posture and the two reasons for it: the "Cloud posture" block in
// this file's header. What follows is that block's mechanics — the boundary
// mock's origin, and the runner-side sets below (MOTIR_CLOUD is set on the
// runner too so seed-side reads like setOrgBillingState match the server).
const MOTIR_AI_URL = 'http://motir-ai.e2e.local';
// Set on the RUNNER too (not only in `webServer.env`, below), so
// `hostedRunSeamEnv` (`tests/e2e/_helpers/job-worker-process.ts`) can mirror the
// SAME host + token into the job worker for the hosted-run stall/cancel end
// path's motir-ai calls (Story MOTIR-683 · MOTIR-6452). Safe here specifically
// because this whole lane is already cloud-on with `MOTIR_AI_URL` reaching its
// webServer (unlike the index-writer's OWN, unrelated motir-ai host, which must
// NOT reach this lane's webServer — see `indexWriterSeamEnv`'s warning) — the
// runner process runs no app code, so this cannot flip anything cloud-on that
// was not already.
process.env['MOTIR_AI_URL'] ??= MOTIR_AI_URL;
process.env['MOTIR_AI_SERVICE_TOKEN'] ??= 'e2e-acceptance-placeholder-token';
// The code-health boundary fixture (MOTIR-2253): the audit-coverage spec drives
// the SERVER-rendered /code-health page, whose motir-ai reads no browser
// `page.route` can reach. `lib/test-code-health-mock` answers them from this
// file, which the spec rewrites between steps.
const CODE_HEALTH_FIXTURE = path.join(__dirname, 'out', 'e2e-code-health-fixture.json');
const MOTIR_AI_BILLING_FIXTURE_PATH = path.resolve('/tmp/motir-acceptance-billing-fixture.json');
// The motir-ai JOBS boundary fixture (MOTIR-1823): the ask journey's three
// crossings are server-side, so the spec declares what each job settles as by
// writing this file — re-read on every request, so it can change between turns.
const MOTIR_AI_JOBS_FIXTURE_PATH = path.resolve('/tmp/motir-acceptance-ai-jobs-fixture.json');
process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ??= MOTIR_AI_JOBS_FIXTURE_PATH;
// The SHARPEN seam's control file (MOTIR-1101 · MOTIR-8179): the Grill me receipt
// writes each session's script here and the server's fake appends the submits and
// write-backs — the same seam, and the same shape, the cloud lane carries.
const MOTIR_AI_SHARPEN_CONTROL_PATH = path.resolve('/tmp/motir-acceptance-sharpen-control.json');
process.env['MOTIR_AI_SHARPEN_CONTROL_PATH'] ??= MOTIR_AI_SHARPEN_CONTROL_PATH;
process.env['MOTIR_CLOUD'] ??= 'true';
process.env['MOTIR_AI_BILLING_FIXTURE_PATH'] ??= MOTIR_AI_BILLING_FIXTURE_PATH;
// The operator console's platform usage reads (Story MOTIR-727 · MOTIR-735,
// `lib/test-platform-usage-mock.ts`): a spec writes the estate it walks here, and
// the webServer's mock answers from it — the same two-sided path as the billing file.
const MOTIR_AI_PLATFORM_FIXTURE_PATH = path.resolve('/tmp/motir-acceptance-platform-fixture.json');
process.env['MOTIR_AI_PLATFORM_FIXTURE_PATH'] ??= MOTIR_AI_PLATFORM_FIXTURE_PATH;

// ── The GitHub repo-provisioning seam (MOTIR-1785) ───────────────────────────
//
// The repository-set journey establishes repositories SERVER-side, so the fake
// GitHub lives in the Next process (lib/test-github-repos-mock.ts, behind
// E2E_TEST_GITHUB_REPOS=1). NO REAL REPOSITORY IS EVER CREATED by this suite.
//
// The two paths are set on the RUNNER too (not only in `webServer.env`), because
// the spec is the other half of the seam: it WRITES the control file to say what
// GitHub should do, and READS the journal to assert the exact outbound request
// bodies the two boundaries sent. Same split as the billing fixture above.
const MOTIR_GITHUB_CONTROL_PATH = path.resolve('/tmp/motir-acceptance-github-control.json');
const MOTIR_GITHUB_JOURNAL_PATH = path.resolve('/tmp/motir-acceptance-github-journal.jsonl');
process.env['MOTIR_GITHUB_CONTROL_PATH'] ??= MOTIR_GITHUB_CONTROL_PATH;
process.env['MOTIR_GITHUB_JOURNAL_PATH'] ??= MOTIR_GITHUB_JOURNAL_PATH;

// ── The GitHub MERGE seam (MOTIR-5572) ───────────────────────────────────────
//
// *Approve and merge* merges server-side, so the fake GitHub merge lives in the Next
// process too (lib/test-github-merge-mock.ts, behind E2E_TEST_GITHUB_MERGE=1). NO REAL
// PULL REQUEST IS EVER MERGED. Its own control and journal, on the runner as well as
// the server, for the same reason as the repos seam's: the spec WRITES what GitHub
// answers per pull request and READS the calls the press made.
const MOTIR_GITHUB_MERGE_CONTROL_PATH = path.resolve(
  '/tmp/motir-acceptance-github-merge-control.json',
);
const MOTIR_GITHUB_MERGE_JOURNAL_PATH = path.resolve(
  '/tmp/motir-acceptance-github-merge-journal.jsonl',
);
process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH'] ??= MOTIR_GITHUB_MERGE_CONTROL_PATH;
process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH'] ??= MOTIR_GITHUB_MERGE_JOURNAL_PATH;
// …and the JOB WORKER installs the same merge seam, with the App credentials the
// merge needs (MOTIR-5837). The CI promotion dispatches an approval carried to a
// later green verdict as `pull-request/auto-merge.requested` — a JOB — and
// `system.pull-request-reconcile` reads the same host, so without this the
// worker either refused (`GITHUB_APP_NOT_CONFIGURED`) or, with the credentials
// alone, reached the REAL api.github.com. The two halves only ever travel
// together: `githubMergeSeamEnv` in `tests/e2e/_helpers/job-worker-process.ts`.
process.env['E2E_JOB_WORKER_GITHUB_MERGE_SEAM'] ??= '1';

// ── The GitHub FLEET ORG CI seam (Story MOTIR-8699 · MOTIR-8717) ─────────────
//
// `/admin/fleet-settings` reads its readiness verdict and flips the org's
// `MOTIR_RUNNER` variable server-side, so the fake GitHub for it lives in the Next
// process (lib/test-github-fleet-org-ci-mock.ts, behind E2E_TEST_GITHUB_FLEET_ORG_CI=1).
// It answers only the orgs its control names, through the Studio App credentials
// the repos and merge seams' lane already carries (`GITHUB_STUDIO_APP_*` below), so
// the App JWT and the installation-token mint run for real. Its control and journal
// are on the runner too: the spec WRITES what GitHub says and READS what was called.
// The webServer is NOT given `MOTIR_FLEET_MAX_IN_FLIGHT`, so the readiness kill-switch
// condition can be met (`0` would engage it; unset is no ceiling).
//
// Not mirrored onto the job worker: no fleet-settings call is a job.
const E2E_GITHUB_FLEET_ORG_CI_CONTROL = path.resolve(
  '/tmp/motir-acceptance-github-fleet-org-ci-control.json',
);
const E2E_GITHUB_FLEET_ORG_CI_JOURNAL = path.resolve(
  '/tmp/motir-acceptance-github-fleet-org-ci-journal.jsonl',
);
process.env['E2E_GITHUB_FLEET_ORG_CI_CONTROL'] ??= E2E_GITHUB_FLEET_ORG_CI_CONTROL;
process.env['E2E_GITHUB_FLEET_ORG_CI_JOURNAL'] ??= E2E_GITHUB_FLEET_ORG_CI_JOURNAL;

// ── The HOSTED RUN seams (Story MOTIR-683 · MOTIR-6452) ──────────────────────
//
// `hostedRunService.start` calls three real services this lane cannot reach:
// the GATEWAY (mints/revokes the run's model key), motir-ai (the offered-model
// list, the credit pre-flight, the run's usage and its machine-time charge) and
// GitHub (the repo-level installation read `repositoriesForItems` makes). None
// of those were stubbed here before this card — `card-MOTIR-6452.md`'s own
// "lane reachability" note is what found the gap, checked at `84b69443e`.
//
// The fleet half was ALREADY reachable (`MOTIR_FLEET_ORCHESTRATOR` below,
// mirroring the main lane's own `??= 'fake'`, `playwright.config.ts` L165); this
// section is the rest of it, `lib/test-hosted-run-mock.ts` behind
// `E2E_TEST_HOSTED_RUN=1`. NO REAL GATEWAY, motir-ai OR GITHUB CALL IS EVER MADE
// by this suite.
//
// Fixture + journal, same two-file split as every sibling seam: the fixture
// (models / credit pre-flight / repo-installation / usage) is re-read on every
// request so the model-withdrawn case can change it MID-TEST; the journal is
// how the spec — a separate process — proves each stub actually answered.
process.env['MOTIR_FLEET_ORCHESTRATOR'] ??= 'fake';
process.env['MOTIR_GATEWAY_URL'] ??= 'http://motir-gateway.e2e.local';
process.env['MOTIR_RUN_KEY_MINT_SECRET'] ??= 'e2e-acceptance-run-key-secret';
const MOTIR_HOSTED_RUN_FIXTURE_PATH = path.resolve('/tmp/motir-acceptance-hosted-run-fixture.json');
const MOTIR_HOSTED_RUN_JOURNAL_PATH = path.resolve(
  '/tmp/motir-acceptance-hosted-run-journal.jsonl',
);
process.env['MOTIR_HOSTED_RUN_FIXTURE_PATH'] ??= MOTIR_HOSTED_RUN_FIXTURE_PATH;
process.env['MOTIR_HOSTED_RUN_JOURNAL_PATH'] ??= MOTIR_HOSTED_RUN_JOURNAL_PATH;
// The fake orchestrator's cross-process container store (MOTIR-3828's shape,
// this lane's own copy — never the main/index-writer lane's `out/` path, which
// belongs to a different `webServer`). A hosted run BOOTS in the webServer
// (`start`) and is POLLED/SETTLED in the worker (`supervise`), so both processes
// — and the runner, which reads a booted container's launcher env to learn the
// run's own credential (`MOTIR_RUN_TOKEN`), exactly as the real container would
// receive it — must agree on one file.
process.env['MOTIR_FAKE_CONTAINER_STATE_PATH'] ??= path.resolve(
  'out/playwright-output-acceptance/.fake-containers.json',
);
// Story MOTIR-6860 · MOTIR-6877 — the agent instances' PERSISTENT fake fleet, on
// the same terms: the webServer's route bundles each hold their own module copy,
// so the machines and volumes must live in one file they all read, and the runner
// arms a provider failure through that file's sidecar for the webServer to meet.
process.env['MOTIR_FAKE_PERSISTENT_STATE_PATH'] ??= path.resolve(
  'out/playwright-output-acceptance/.fake-persistent.json',
);
// Story MOTIR-6862 · MOTIR-6955 — the published-image catalog's fake answers (the
// newest version per profile, and "could not check"), in one file the spec writes
// and the webServer reads on every list, so a release can be "published" mid-test.
process.env['MOTIR_FAKE_IMAGE_CATALOG_PATH'] ??= path.resolve(
  'out/playwright-output-acceptance/.fake-image-catalog.json',
);
// The stall watchdog's test-only config seam (`hostedRunStallWindowMs`,
// `lib/hostedRuns/limits.ts`) — shortened from the real 15 minutes so the
// "stalled" case can run in this lane at all. Read directly by whichever
// process runs `stallDetail` (the worker, via `supervise`); see
// `hostedRunSeamEnv` for why it also has to reach that process by hand.
// 25 s, not less: the window is lane-wide, and the paced happy path leaves a
// few seconds (its video beats) between the boot and its first event — at 4 s
// the supervisor rightly ended THAT run as stalled. 25 s clears those gaps and
// still ends the stall case well inside its 90 s wait.
process.env['E2E_HOSTED_RUN_STALL_WINDOW_MS'] ??= '25000';
// …and the JOB WORKER installs the same three seams, because the stall/cancel
// end path's gateway revoke and machine-time charge run inside `supervise`'s
// durable job — see `hostedRunSeamEnv` in `tests/e2e/_helpers/job-worker-process.ts`.
process.env['E2E_JOB_WORKER_HOSTED_RUN_SEAM'] ??= '1';

// ── The AGENT TERMINAL (Story MOTIR-6861 · MOTIR-6943) ───────────────────────
//
// A browser reaches an agent's shell through two more processes
// (`docs/decisions/agent-terminal.md` Q1–Q4), so this lane starts both as
// webServers below: the REAL relay (`scripts/relay.ts`, built as the image
// builds it) and the fake fleet's terminal servers
// (`tests/e2e/_helpers/agent-terminal/host.ts` — `packages/cli`'s real server,
// one per fake machine, on a Python PTY so CI needs no node-pty build).
//
// The master key is set on the RUNNER as well as the web server: the job worker
// inherits the runner's env, and the boot settle it runs probes the terminal
// server only while the terminal is configured. Setting it turns the terminal ON
// for the whole lane — machines get the terminal config, and the fake's `exec`
// answers the probe with exit 0 — which changes nothing an older spec asserts.
const RELAY_PORT = Number(process.env['E2E_RELAY_PORT'] ?? 3291);
const TERMINAL_HOST_PORT = Number(process.env['MOTIR_E2E_TERMINAL_HOST_PORT'] ?? 3292);
process.env['MOTIR_TERMINAL_MASTER_KEY'] ??= 'e2e-acceptance-terminal-master-key-0123456789';
process.env['MOTIR_RELAY_URL'] ??= `ws://localhost:${RELAY_PORT}/v1/terminal`;
process.env['MOTIR_FAKE_TERMINAL_URL'] ??= `ws://127.0.0.1:${TERMINAL_HOST_PORT}`;
process.env['MOTIR_E2E_TERMINAL_HOST_PORT'] ??= String(TERMINAL_HOST_PORT);
// The chat (Story MOTIR-6863 · MOTIR-7019): the agents' home volumes and the
// per-agent setup sidecar the host boots each machine with — set on the RUNNER
// too, because the spec is the other half: it seeds the sidecar and reads what
// the stub CLIs recorded under the homes (`_helpers/agent-terminal/host.ts`).
process.env['MOTIR_E2E_AGENT_HOMES'] ??= path.join(os.tmpdir(), 'motir-e2e-agent-homes');
process.env['MOTIR_E2E_AGENT_SETUP_PATH'] ??= path.join(os.tmpdir(), 'motir-e2e-agent-setup.json');
// The boot's clones (Story MOTIR-7393 · MOTIR-7402): the spec holds or refuses a
// repository's clone through this sidecar, and the host answers each clone exec
// from it — RUNNER and host, the same two-sided path as the setup sidecar.
process.env['MOTIR_E2E_CLONE_SCRIPT_PATH'] ??= path.join(
  os.tmpdir(),
  'motir-e2e-clone-script.json',
);

// ── A CARD'S RUN IN AN AGENT (Story MOTIR-6864 · MOTIR-7031) ─────────────────
//
// Motir starts a run in an agent through the orchestrator's `exec` — the sign-in
// query, the launcher, the stop (`agent-instance-run.md` §1, §4). The fake
// persistent orchestrator ROUTES every exec nothing scripted to the terminal
// host above, which runs the real `motir agent-terminal` commands against the
// machine's real server — so the run session a browser attaches to is a real
// one. Set on the RUNNER too: the launch job runs in the job worker, which
// inherits this env. Every exec answered 0-and-empty before this; the host
// answers the probes 0 and every command it does not own 0-and-empty still.
process.env['MOTIR_FAKE_EXEC_URL'] ??= `http://127.0.0.1:${TERMINAL_HOST_PORT}/exec`;
// …and the launch job writes the run's API origin into the run's credentials
// (`resolveBaseUrlTrimmed`), so the WORKER must know this lane's origin: without
// it the run in the agent would report to localhost:3000.
process.env['MOTIR_BASE_URL'] ??= BASE_URL;

/** The Studio App's credentials. The private key is GENERATED per run rather than
 *  committed: `createAppJwt` really signs RS256 with it (the shipped path runs
 *  unchanged), and a PEM in the repo is a secret-scanner finding for no benefit.
 *  The id is shared with the job worker's merge-seam mirror (`github-const.ts`). */
const { privateKey: E2E_STUDIO_APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** The user-facing GitHub App's credentials, for the Git room's account and
 *  repository pickers (Story MOTIR-8216 · MOTIR-8225): the repository read and
 *  the link mint an installation token with them, and `/user/installations` is
 *  filtered to this App id. Generated per run, like the Studio App's key above. */
const E2E_USER_APP_ID = '515151';
const { privateKey: E2E_USER_APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['**/acceptance*.spec.ts'],
  // MOTIR-921: resolve `server-only` to an empty stub for the RUNNER only (see
  // tsconfig.node.json). A spec that seeds through a service reaching
  // lib/ai/motirAiClient otherwise dies at import, before collection. Same
  // decision, same stub, as vitest.config.ts; the Next build still enforces the
  // real boundary.
  tsconfig: './tsconfig.node.json',
  // ⚠️ ADDED BY MOTIR-3418, AND THE LANE DOES NOT WORK WITHOUT IT. `globalSetup`
  // starts the Postgres engine's worker (and `globalTeardown` drains it) — the
  // executor that replaced the vendor dev server this config used to boot as a
  // second `webServer`. It is not a `webServer` entry because it binds no port.
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  timeout: 90_000,
  // Assertion headroom for CI load. This lane now runs a PRODUCTION build (see
  // webServer below, MOTIR-1682), so there is NO on-demand cold-compile cost on
  // the first `/items/[id]` hit — the source of the old test-1 flake. A generous
  // 20s is kept anyway as a margin under heavy CI contention (retries:0).
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0, // never retry — a retry would record a second (confusing) clip
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'out/playwright-report-acceptance' }],
  ],
  outputDir: 'out/playwright-output-acceptance',
  use: {
    baseURL: BASE_URL,
    // Record the GREEN run — the whole point of this lane. 720p keeps the clip a
    // few MB (the ADR's budget); the acceptance spec keeps itself short (≤ ~60s).
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    trace: 'on',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // MOTIR-1682: run the acceptance lane against a PRODUCTION build (`next
      // build` + `next start`), NOT `next dev` — mirroring the main lane
      // (playwright.config.ts, MOTIR-1679). `next dev`'s resident on-demand
      // compiler made the FIRST test to hit `/items/[id]` pay a cold-compile
      // cost that, under CI load, blew even the 60s assertion timeout (the
      // test-1 flake). A production server is fully pre-compiled and stable.
      // `next start` forces NODE_ENV=production; E2E_PROD_HARNESS=1 re-relaxes
      // ONLY the test seams (Secure cookies / `/api/_test` 404 gate / 'file'
      // email — see lib/e2eProdHarness.ts). This lane seeds via `/api/_test`, so
      // it MUST set the flag. `prisma generate` guards a fresh worktree.
      // ⚠️ `build:worker` IS PART OF THE SERVER COMMAND, and this lane needs it
      // (MOTIR-3418). `globalSetup` starts the engine's worker from the SHIPPED
      // bundle at `.worker/worker.mjs` — never the TypeScript source — so a lane
      // that does not build it fails in globalSetup before a single spec runs.
      // The main config's command has carried this since MOTIR-3427; this one did
      // not need it while the executor was a second `webServer`.
      // MOTIR-5697: the server must outlive the runner's idle sockets — see the helper.
      command: `pnpm exec prisma generate && pnpm exec next build && pnpm run build:worker && pnpm exec next start --port ${PORT} ${NEXT_START_KEEP_ALIVE_FLAG}`,
      // `/sign-in`, NOT the root: with `MOTIR_PUBLIC_SITE_URL` set (below) the
      // root 308s onto the unreachable public origin, and Playwright's
      // ready-check follows it — so the server would never read as ready. A
      // non-redirected auth route is a stable, 200-answering probe.
      url: `${BASE_URL}/sign-in`,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      // Generous: now covers a full `next build` (minutes) before the server binds.
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // MOTIR-1682: production-harness flag — re-relaxes the NODE_ENV=production
        // test seams the prod server trips (see lib/e2eProdHarness.ts). Test-only,
        // never a real deploy.
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
        // `next build` is memory-heavy; give V8 old-space headroom (harmless for
        // the lightweight `next start` that follows). Inside the CI 16 GB budget.
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
        // The GitHub webhook secret (Story MOTIR-2725 · MOTIR-2730). The
        // acceptance lane had never needed it — no acceptance story drove a
        // webhook until a card's completion depended on TWO merges arriving as
        // real `pull_request` deliveries. Without it `/api/github/webhook`
        // answers 500 `GITHUB_WEBHOOK_NOT_CONFIGURED` before verifying anything.
        //
        // The SAME synthetic literal the main lane sets and the spec signs with
        // (`tests/e2e/_helpers/github-const.ts`), so the real 7.10.4 signature
        // gate runs here exactly as it does there — the acceptance clip records
        // the shipped path, not a relaxed one.
        GITHUB_WEBHOOK_SECRET: E2E_GITHUB_WEBHOOK_SECRET,
        EMAIL_OUTBOX_PATH: path.resolve('/tmp/motir-test-emails.jsonl'),
        MOTIR_BASE_URL: BASE_URL,
        // MOTIR-3886 — the moved public surfaces' redirect destination. A
        // synthetic public origin so the redirect FIRES here and points at a
        // host that need not be reachable (the spec asserts the Location header
        // without following it). Must differ from MOTIR_BASE_URL above, which is
        // the gate `publicSiteRedirect` reads. Test-only, never a real deploy.
        MOTIR_PUBLIC_SITE_URL: 'https://public.motir.e2e',
        E2E_DISABLE_RATE_LIMIT: '1',
        E2E_DISABLE_DEV_INDICATOR: '1',
        // Mock the object store so any in-app upload the spec drives never needs
        // a real store (mirrors the main lane; CI has no real credentials).
        // MOTIR-2389: the store is S3-compatible; the endpoint is the host
        // lib/test-blob-mock.ts intercepts, so it must match there.
        E2E_TEST_BLOB: '1',
        // MOTIR-7176: the cimd plugin's document fetch is answered from
        // `lib/test-cimd-mock.ts`'s table (Claude, Claude Code, and a document
        // calling itself Claude from example.org) — the hardened transport
        // refuses a local fixture server, so the seam replaces the transport.
        E2E_TEST_CIMD: '1',
        MOTIR_S3_ENDPOINT: 'https://e2e.s3.invalid',
        MOTIR_S3_REGION: 'auto',
        MOTIR_S3_ACCESS_KEY_ID: 'e2e-playwright-only-placeholder',
        MOTIR_S3_SECRET_ACCESS_KEY: 'e2e-playwright-only-placeholder-secret',
        MOTIR_S3_PRIVATE_BUCKET: 'motir-e2e-private',
        MOTIR_S3_PUBLIC_BUCKET: 'motir-e2e-public',
        MOTIR_S3_PUBLIC_BASE_URL: 'https://e2etest.public.store.invalid',
        // ⚠️ THE DOCS ROW IS CONFIGURATION NOW (MOTIR-4167 / #2530, MOTIR-4257).
        //
        // `lib/docs/links.ts` resolves the rail's Docs row from an operator's
        // absolute `MOTIR_DOCS_URL` and returns `null` when it is unset, so the
        // row does not render at all — the shape the Legal row beside it already
        // took when MOTIR-3932 moved the public reading surface to
        // motir-marketing.
        //
        // `regression-legal-manifest.spec.ts` reads that row as its CONTROL: its
        // chapter asserts the rail offers Docs and NOT Legal, and the Docs half
        // is what makes Legal's absence mean *this build did not configure it*
        // rather than *the rail is empty*. Once the row became conditional, a
        // lane that configures no URL had no control — and the spec went red on
        // `main` for reasons that had nothing to do with legal documents.
        //
        // This lane is the CLOUD-ON arm, and a cloud build has its docs
        // configured, so setting it is what the arm is supposed to represent.
        // The ASSERTION is untouched: a receipt records what was accepted, and
        // relaxing it to match today is the reflex `acceptance-receipt-lifecycle.md`
        // forbids.
        MOTIR_DOCS_URL: 'https://motir.co/docs',
        // Cloud billing + the motir-ai boundary mock (the billing-lane vocabulary).
        MOTIR_CLOUD: 'true',
        // ── The public-address story's two seams (MOTIR-3878 · MOTIR-4225) ──
        //
        // ⚠️ WITHOUT THESE THE SPEC CANNOT REACH THE STATES IT ASSERTS, and
        // `plan-rules/type-test.md` tell (d) is exactly that: a lane that cannot
        // reach the asserted state stays green for ever.
        //
        // The BASE DOMAIN, because the pane renders an operator explanation and
        // no claim field when it is unset — the walk would film that instead of
        // the room.
        MOTIR_PUBLIC_TENANT_DOMAIN: 'motir.e2e',
        // The two PORTS the flow crosses that leave this machine: the certificate
        // platform and public DNS. `lib/publicAddresses/providers.ts` binds
        // in-memory versions on this flag — and REFUSES to, whatever the flag
        // says, when `NODE_ENV === 'production'`, which is what makes an env var
        // an operator could set by accident harmless. Asserted in
        // `tests/publicAddresses/dnsResolverPort.test.ts`.
        MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS: '1',
        E2E_TEST_BILLING: '1',
        MOTIR_AI_URL,
        E2E_TEST_CODE_HEALTH: '1',
        MOTIR_AI_CODE_HEALTH_FIXTURE_PATH: CODE_HEALTH_FIXTURE,
        // The console's AI planning page (Story MOTIR-7220 · MOTIR-7235): the
        // `/v1/planner-model-settings` intercept, from the same file the spec
        // seeds (`tests/e2e/_helpers/planner-model-fixture.ts`).
        E2E_TEST_PLANNER_MODEL: '1',
        MOTIR_AI_PLANNER_MODEL_FIXTURE_PATH: path.join(
          __dirname,
          'out',
          'e2e-planner-model-fixture.json',
        ),
        // The console's planning-lessons pages (Story MOTIR-1408 · MOTIR-1413):
        // the `/v1/admin/lessons…` + `/v1/admin/lesson-retention…` intercept, from
        // the same file the spec seeds (`tests/e2e/_helpers/platform-lessons-fixture.ts`).
        E2E_TEST_PLATFORM_LESSONS: '1',
        MOTIR_AI_PLATFORM_LESSONS_FIXTURE_PATH: path.join(
          __dirname,
          'out',
          'e2e-platform-lessons-fixture.json',
        ),
        // The Sharpen seam (MOTIR-1101 · MOTIR-8179) — installed BEFORE the jobs seam
        // by `lib/test-mock-seams.ts`. An ending turn makes core's REAL write-back,
        // `PUT /api/internal/ai/plan-sharpening`, under `CORE_CALLBACK_SECRET` below.
        E2E_TEST_SHARPEN: '1',
        MOTIR_AI_SHARPEN_CONTROL_PATH,
        E2E_TEST_AI_JOBS: '1',
        MOTIR_AI_JOBS_FIXTURE_PATH,
        MOTIR_AI_SERVICE_TOKEN: 'e2e-acceptance-placeholder-token',
        // The seat push the agent-billing walk makes (MOTIR-6924) — the literal
        // lives with the helper that signs with it.
        MOTIR_AI_TO_CORE_SERVICE_TOKEN: E2E_AI_TO_CORE_SERVICE_TOKEN,
        // The §4a service bearer the job-token routes check (Story MOTIR-7797 ·
        // MOTIR-7809): the confirmed-bug walk plays motir-ai's `log_bug` through
        // the REAL `POST /api/internal/ai/log-bug`, which fails closed — every
        // call 401 — while this is unset. The literal lives with the helper that
        // presents it.
        CORE_CALLBACK_SECRET: E2E_CORE_CALLBACK_SECRET,
        MOTIR_AI_BILLING_FIXTURE_PATH,
        E2E_TEST_PLATFORM_USAGE: '1',
        MOTIR_AI_PLATFORM_FIXTURE_PATH,
        // The GitHub repo-provisioning + collaborator boundary (MOTIR-1785).
        E2E_TEST_GITHUB_REPOS: '1',
        MOTIR_GITHUB_CONTROL_PATH,
        MOTIR_GITHUB_JOURNAL_PATH,
        E2E_TEST_GITHUB_MERGE: '1',
        MOTIR_GITHUB_MERGE_CONTROL_PATH,
        MOTIR_GITHUB_MERGE_JOURNAL_PATH,
        // The fleet settings journey's GitHub (MOTIR-8717) — see the block above.
        E2E_TEST_GITHUB_FLEET_ORG_CI: '1',
        E2E_GITHUB_FLEET_ORG_CI_CONTROL: process.env['E2E_GITHUB_FLEET_ORG_CI_CONTROL']!,
        E2E_GITHUB_FLEET_ORG_CI_JOURNAL: process.env['E2E_GITHUB_FLEET_ORG_CI_JOURNAL']!,
        GITHUB_FALLBACK_ORG: E2E_PROVISIONING_ORG,
        GITHUB_STUDIO_APP_ID: E2E_STUDIO_APP_ID,
        GITHUB_STUDIO_APP_PRIVATE_KEY: E2E_STUDIO_APP_PRIVATE_KEY,
        // The Git room's account + repository pickers (Story MOTIR-8216 ·
        // MOTIR-8225) — `lib/test-github-accounts-mock.ts`.
        E2E_TEST_GITHUB_ACCOUNTS: '1',
        GITHUB_APP_ID: E2E_USER_APP_ID,
        GITHUB_APP_PRIVATE_KEY: E2E_USER_APP_PRIVATE_KEY,
        // The identity/installation the seed binds are read back on this surface;
        // the App slug is what the settings pane the step hands off to renders.
        GITHUB_TOKEN_ENCRYPTION_KEY: E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
        // The hosted-run gateway/motir-ai/GitHub seams (Story MOTIR-683 ·
        // MOTIR-6452) — see the "HOSTED RUN seams" block above this config for
        // why each of these exists.
        MOTIR_FLEET_ORCHESTRATOR: process.env['MOTIR_FLEET_ORCHESTRATOR']!,
        E2E_TEST_HOSTED_RUN: '1',
        MOTIR_GATEWAY_URL: process.env['MOTIR_GATEWAY_URL']!,
        MOTIR_RUN_KEY_MINT_SECRET: process.env['MOTIR_RUN_KEY_MINT_SECRET']!,
        MOTIR_HOSTED_RUN_FIXTURE_PATH,
        MOTIR_HOSTED_RUN_JOURNAL_PATH,
        MOTIR_FAKE_CONTAINER_STATE_PATH: process.env['MOTIR_FAKE_CONTAINER_STATE_PATH']!,
        MOTIR_FAKE_PERSISTENT_STATE_PATH: process.env['MOTIR_FAKE_PERSISTENT_STATE_PATH']!,
        E2E_HOSTED_RUN_STALL_WINDOW_MS: process.env['E2E_HOSTED_RUN_STALL_WINDOW_MS']!,
        // Story MOTIR-4928 · MOTIR-5264 — the MONITORING room's connect walk.
        // ⚠️ THE FAKE IS SELECTED HERE OR NOWHERE. This server is spawned, so a
        // `vi.mock` cannot reach it; `lib/monitors/index.ts` re-registers the fake
        // provider under `sentry` when this switch is '1'. Without it every
        // exchange would reach the real adapter and fail on missing credentials —
        // a lane that could never reach a connected state. The slug and web base
        // make the start route build an install URL at all (it answers
        // `not_configured` without a slug); the base is a `.invalid` host the spec
        // intercepts in the browser, so nothing ever leaves for sentry.io. The
        // token key is the GitHub one above, which the monitor crypto falls back to.
        MOTIR_MONITOR_FAKE_PROVIDER: '1',
        SENTRY_APP_SLUG: 'motir-e2e',
        SENTRY_WEB_BASE_URL: 'https://sentry-install.e2e.invalid',
        GITHUB_APP_SLUG: E2E_GITHUB_APP_SLUG,
        // The access step's "connect" is a REAL identity OAuth round-trip, not a
        // seeded row: the recorded journey's whole point is that a user with no
        // GitHub account connects one and the invitation follows. Same seam
        // github.spec.ts drives (test-oauth-mock's synthetic `e2e-octocat`).
        E2E_TEST_OAUTH: '1',
        GITHUB_APP_CLIENT_ID: E2E_GITHUB_CLIENT_ID,
        GITHUB_APP_CLIENT_SECRET: E2E_GITHUB_CLIENT_SECRET,
        // The agent terminal (see "The AGENT TERMINAL" above): the ticket route
        // needs the master key, and hands the browser the lane's relay.
        MOTIR_TERMINAL_MASTER_KEY: process.env['MOTIR_TERMINAL_MASTER_KEY']!,
        MOTIR_RELAY_URL: process.env['MOTIR_RELAY_URL']!,
        // A card's run in an agent: the exec door (see "A CARD'S RUN IN AN AGENT").
        MOTIR_FAKE_EXEC_URL: process.env['MOTIR_FAKE_EXEC_URL']!,
      },
    },
    {
      // The terminal relay, from the SAME bundle the `motir-relay` app runs. It
      // dials agents through the fake adapter (MOTIR_FAKE_TERMINAL_URL) and
      // accepts only this lane's Origin.
      command: 'pnpm run build:relay && node .relay/relay.mjs',
      port: RELAY_PORT,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(RELAY_PORT),
        MOTIR_BASE_URL: BASE_URL,
        MOTIR_TERMINAL_MASTER_KEY: process.env['MOTIR_TERMINAL_MASTER_KEY']!,
        MOTIR_FLEET_ORCHESTRATOR: process.env['MOTIR_FLEET_ORCHESTRATOR']!,
        MOTIR_FAKE_TERMINAL_URL: process.env['MOTIR_FAKE_TERMINAL_URL']!,
        MOTIR_FAKE_PERSISTENT_STATE_PATH: process.env['MOTIR_FAKE_PERSISTENT_STATE_PATH']!,
      },
    },
    {
      // The fake fleet's terminal servers — what each agent's machine would run.
      command: 'pnpm exec tsx tests/e2e/_helpers/agent-terminal/host.ts',
      port: TERMINAL_HOST_PORT,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        MOTIR_E2E_TERMINAL_HOST_PORT: String(TERMINAL_HOST_PORT),
        MOTIR_FAKE_PERSISTENT_STATE_PATH: process.env['MOTIR_FAKE_PERSISTENT_STATE_PATH']!,
        MOTIR_E2E_AGENT_HOMES: process.env['MOTIR_E2E_AGENT_HOMES']!,
        MOTIR_E2E_AGENT_SETUP_PATH: process.env['MOTIR_E2E_AGENT_SETUP_PATH']!,
        MOTIR_E2E_CLONE_SCRIPT_PATH: process.env['MOTIR_E2E_CLONE_SCRIPT_PATH']!,
      },
    },
  ],
});
