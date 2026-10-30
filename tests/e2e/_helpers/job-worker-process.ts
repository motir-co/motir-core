import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
  E2E_PROVISIONING_ORG,
  E2E_STUDIO_APP_ID,
} from './github-const';

// The Postgres job engine's WORKER, running inside the E2E lane
// (Story MOTIR-3414 · Subtask MOTIR-3427).
//
// ⚠️ WHY THIS IS NOT A `webServer` ENTRY, which is where a reader will look for
// it first. Playwright's `webServer` polls a `url` or a `port` for readiness, and
// the worker binds neither — it is a claim loop, not a server. So it is started
// from `globalSetup` (which runs after the webServers are up and before the first
// spec) and stopped from `globalTeardown`.
//
// ⚠️ AND IT IS A THIRD PROCESS IN THE LANE ON PURPOSE. MOTIR-3427's original text
// asked for "no bespoke server configuration", which could not hold: the engine
// runs in its OWN process group by design (MOTIR-3421 — job load must not contend
// with request serving), so a run queued onto it has nothing to claim it unless
// the lane starts one. The card was amended to say so. This is the exact analogue
// of the `inngest-cli dev` entry already in the lane: the OLD engine needed its
// executor there too.
//
// It runs the BUNDLE — the same `.worker/worker.mjs` artifact the Dockerfile
// stages at `/app/worker/` — rather than the TypeScript source, so the lane
// exercises what production actually runs. A source-run would prove the code and
// not the packaging, and the packaging is where `argon2`'s native binding and the
// standalone tree's module resolution live.

const WORKER_BUNDLE = path.resolve('.worker/worker.mjs');
/**
 * THE FAKE ERROR MONITOR, mirrored into the worker (Story MOTIR-4931 · MOTIR-5709).
 *
 * The acceptance lane selects the fake monitor provider with
 * `MOTIR_MONITOR_FAKE_PROVIDER=1` on its **webServer** only, and encrypts the
 * grant's token with `E2E_GITHUB_TOKEN_ENCRYPTION_KEY` there too (the monitor
 * crypto falls back to the GitHub key). The resolve-back is a JOB, so it runs
 * HERE — and without both, this process registers the REAL Sentry adapter and
 * cannot decrypt the grant: every `monitor-issue-resolve` run throws before it
 * reaches a provider, retries, and dead-letters. The MOTIR-3498 shape again:
 * a webServer-only variable a job handler reads.
 *
 * Opt-in (`E2E_JOB_WORKER_MONITOR_FAKE=1`, set by `playwright.acceptance.config.ts`)
 * because the main lane's server does not select the fake, and the two processes
 * must agree about which provider is `sentry`.
 */
function monitorFakeEnv(): Record<string, string> {
  if (process.env['E2E_JOB_WORKER_MONITOR_FAKE'] !== '1') return {};
  return {
    MOTIR_MONITOR_FAKE_PROVIDER: '1',
    GITHUB_TOKEN_ENCRYPTION_KEY: E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
  };
}

/**
 * ⚠️ THE GITHUB MERGE SEAM, mirrored into the worker — and its App credentials
 * WITH it, never without (Bug MOTIR-5837).
 *
 * An approval pressed BEFORE a pull request's checks pass is carried to the next
 * green verdict, and the CI promotion dispatches that merge as
 * `pull-request/auto-merge.requested` — a JOB, so it runs HERE, not in the
 * server `instrumentation.ts` fakes GitHub in. `system.pull-request-reconcile`
 * reads the same host on every pass. Before this, both failed in two layers:
 *
 *   * with no App env, the repository resolved to the USER-facing App and threw
 *     `GITHUB_APP_NOT_CONFIGURED` before any call — so the carried merge
 *     dead-lettered where no browser assertion can see it;
 *   * with the App env mirrored ALONE, the worker minted an installation token
 *     against the REAL api.github.com and died on its 401 — outbound traffic from
 *     a lane whose contract is that NO REAL PULL REQUEST IS EVER MERGED.
 *
 * So the flag and the credentials travel TOGETHER, in this one function: the
 * worker installs `lib/test-github-merge-mock.ts` from the shared seam table
 * (`lib/test-mock-seams.ts`) and resolves a `motir-projects-e2e` repository to
 * the Studio App exactly as the server does. The control and journal paths are
 * the runner's own, so the spec steers both processes through ONE file and
 * reads ONE journal. And the shared agent refuses any api.github.com call no seam
 * answers (`lib/test-mock-agent.ts`), so a path this seam does not cover fails
 * here by name instead of leaving the box.
 *
 * ⚠️ THE REPOS SEAM (`E2E_TEST_GITHUB_REPOS`) IS DELIBERATELY NOT MIRRORED. Its
 * fake keeps the repositories it "created" in a PROCESS-LOCAL map, so a second
 * copy here would be a second GitHub that disagrees with the first. With it off
 * in this process, the merge seam answers the installation-token mint itself
 * (its own header says so).
 *
 * Opt-in (`E2E_JOB_WORKER_GITHUB_MERGE_SEAM=1`, set by
 * `playwright.acceptance.config.ts`), because only that lane's server selects the
 * merge seam, and the two processes must agree about what GitHub is.
 */
export function githubMergeSeamEnv(): Record<string, string> {
  if (process.env['E2E_JOB_WORKER_GITHUB_MERGE_SEAM'] !== '1') return {};
  return {
    E2E_TEST_GITHUB_MERGE: '1',
    ...(process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']
      ? { MOTIR_GITHUB_MERGE_CONTROL_PATH: process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH'] }
      : {}),
    ...(process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']
      ? { MOTIR_GITHUB_MERGE_JOURNAL_PATH: process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH'] }
      : {}),
    GITHUB_FALLBACK_ORG: E2E_PROVISIONING_ORG,
    GITHUB_STUDIO_APP_ID: E2E_STUDIO_APP_ID,
    GITHUB_STUDIO_APP_PRIVATE_KEY: generateAppPrivateKey(),
    GITHUB_TOKEN_ENCRYPTION_KEY: E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
  };
}

/**
 * ⚠️ A HOSTED RUN'S GATEWAY + motir-ai + GITHUB SEAMS, mirrored into the worker
 * (Story MOTIR-683 · MOTIR-6452).
 *
 * `hostedRunService.supervise` — the durable job the fake orchestrator's
 * cancel and stall paths run through — calls `endHostedRun` from INSIDE the
 * worker: the gateway key revoke and, once the container settles, the
 * machine-time charge to motir-ai (and, for a run the worker itself boots, the
 * paid-AI-plan read, through the billing seam). These are HTTP calls `instrumentation.ts`'s
 * seam table never reaches from here, exactly the shape this file's other two
 * mirrors (`monitorFakeEnv`, `githubMergeSeamEnv`) already document — a job
 * handler reaches a boundary the app server's own fake never installs itself
 * into this THIRD process.
 *
 * The App credentials for the repo-installation read travel with it, same as
 * the merge seam's: `repositoriesForItems` is only ever called from `start`
 * (the webServer), never from a job, so strictly this worker never needs to
 * mint an App JWT itself — but `installHostedRunMock` is one module shared by
 * both processes, and `createAppJwt`'s throw-before-fetch means a config gap
 * here would surface as a confusing crash the first time this seam's table
 * entry runs in this process, rather than as nothing at all. Cheap to carry,
 * expensive to have to re-diagnose.
 *
 * Opt-in (`E2E_JOB_WORKER_HOSTED_RUN_SEAM=1`, set by
 * `playwright.acceptance.config.ts`), because only that lane's server selects
 * this seam, and the two processes must agree about what the gateway,
 * motir-ai and GitHub are.
 */
export function hostedRunSeamEnv(): Record<string, string> {
  if (process.env['E2E_JOB_WORKER_HOSTED_RUN_SEAM'] !== '1') return {};
  return {
    E2E_TEST_HOSTED_RUN: '1',
    MOTIR_FLEET_ORCHESTRATOR: 'fake',
    // The paid-AI-plan gate (Story MOTIR-6906 · MOTIR-6909): a hosted run the
    // worker boots (the review agent's `agent-review/requested`) asks motir-ai for
    // the org's subscription first. Without the billing seam that read fails, the
    // plan reads `unknown`, and the boot defers — so the worker reads the same
    // billing fixture the webServer does.
    E2E_TEST_BILLING: '1',
    ...(process.env['MOTIR_AI_BILLING_FIXTURE_PATH']
      ? { MOTIR_AI_BILLING_FIXTURE_PATH: process.env['MOTIR_AI_BILLING_FIXTURE_PATH'] }
      : {}),
    ...(process.env['MOTIR_GATEWAY_URL']
      ? { MOTIR_GATEWAY_URL: process.env['MOTIR_GATEWAY_URL'] }
      : {}),
    ...(process.env['MOTIR_GATEWAY_RUN_URL']
      ? { MOTIR_GATEWAY_RUN_URL: process.env['MOTIR_GATEWAY_RUN_URL'] }
      : {}),
    ...(process.env['MOTIR_RUN_KEY_MINT_SECRET']
      ? { MOTIR_RUN_KEY_MINT_SECRET: process.env['MOTIR_RUN_KEY_MINT_SECRET'] }
      : {}),
    ...(process.env['MOTIR_AI_URL'] ? { MOTIR_AI_URL: process.env['MOTIR_AI_URL'] } : {}),
    MOTIR_AI_SERVICE_TOKEN:
      process.env['MOTIR_AI_SERVICE_TOKEN'] ?? 'e2e-acceptance-hosted-run-token',
    ...(process.env['MOTIR_HOSTED_RUN_FIXTURE_PATH']
      ? { MOTIR_HOSTED_RUN_FIXTURE_PATH: process.env['MOTIR_HOSTED_RUN_FIXTURE_PATH'] }
      : {}),
    ...(process.env['MOTIR_HOSTED_RUN_JOURNAL_PATH']
      ? { MOTIR_HOSTED_RUN_JOURNAL_PATH: process.env['MOTIR_HOSTED_RUN_JOURNAL_PATH'] }
      : {}),
    ...(process.env['MOTIR_FAKE_CONTAINER_STATE_PATH']
      ? { MOTIR_FAKE_CONTAINER_STATE_PATH: process.env['MOTIR_FAKE_CONTAINER_STATE_PATH'] }
      : {}),
    // The fake AWS (MOTIR-9429): this process polls, settles and reaps a run an
    // `aws` account booted, so it reads the same EC2 state file, switch fixture and
    // image the webServer does.
    ...(process.env['MOTIR_FAKE_AWS_STATE_PATH']
      ? { MOTIR_FAKE_AWS_STATE_PATH: process.env['MOTIR_FAKE_AWS_STATE_PATH'] }
      : {}),
    ...(process.env['MOTIR_FAKE_FLEET_SWITCH_PATH']
      ? { MOTIR_FAKE_FLEET_SWITCH_PATH: process.env['MOTIR_FAKE_FLEET_SWITCH_PATH'] }
      : {}),
    ...(process.env['MOTIR_HOSTED_AGENT_IMAGE']
      ? { MOTIR_HOSTED_AGENT_IMAGE: process.env['MOTIR_HOSTED_AGENT_IMAGE'] }
      : {}),
    // The agent instances' persistent fake fleet (MOTIR-6877): the idle and sweep
    // jobs run here, so this process must read the same machines the webServer made.
    ...(process.env['MOTIR_FAKE_PERSISTENT_STATE_PATH']
      ? { MOTIR_FAKE_PERSISTENT_STATE_PATH: process.env['MOTIR_FAKE_PERSISTENT_STATE_PATH'] }
      : {}),
    // The stall watchdog's test-only config seam (`hostedRunStallWindowMs`,
    // `lib/hostedRuns/limits.ts`) — the stall READ itself runs in this process
    // (`hostedRunService.stallDetail`, called from `supervise`), so without this
    // the worker keeps the real 15-minute window regardless of what the webServer
    // was told.
    ...(process.env['E2E_HOSTED_RUN_STALL_WINDOW_MS']
      ? { E2E_HOSTED_RUN_STALL_WINDOW_MS: process.env['E2E_HOSTED_RUN_STALL_WINDOW_MS'] }
      : {}),
    GITHUB_STUDIO_APP_ID: E2E_STUDIO_APP_ID,
    GITHUB_STUDIO_APP_PRIVATE_KEY: generateAppPrivateKey(),
    GITHUB_TOKEN_ENCRYPTION_KEY: E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
  };
}

/**
 * THE FAKE HOSTING PORT'S SHARED STORE (Story MOTIR-5766 · MOTIR-10098). A
 * preview's lifecycle deploys, polls and destroys in THIS process (its effects
 * are jobs), while the app server's gate reads the release and the spec arranges
 * both — so all three must read one file. The runner defaults the path in both
 * lane configs; it is forwarded here BY NAME, from both spawn sites, rather than
 * left to `...process.env`, under this file's rule that a variable a job handler
 * reads is mirrored here.
 */
export function previewHostingSeamEnv(): Record<string, string> {
  const path = process.env['MOTIR_FAKE_HOSTING_STATE_PATH'];
  return path ? { MOTIR_FAKE_HOSTING_STATE_PATH: path } : {};
}

/** The preview configuration a lifecycle effect reads, by name, when the lane sets it. */
const PREVIEW_WORKER_ENV = [
  'MOTIR_PREVIEW_DOMAIN',
  'MOTIR_PREVIEW_SCHEME',
  'MOTIR_HOSTING_ORIGIN_SECRET_KEY',
] as const;

/**
 * A PREVIEW'S GITHUB CALLS, mirrored into the worker (Story MOTIR-5766 ·
 * MOTIR-5781). The lifecycle's effects run HERE: they create the preview's GitHub
 * deployment, post its statuses and read the hosting manifest at the pull
 * request's head, so the seam that answers them (`lib/test-github-preview-mock.ts`)
 * must be installed in this process, with its control and journal files. Its state
 * lives in those files, so a copy in the app server would agree with this one.
 *
 * ⚠️ IT CARRIES NO TOKEN MINT OF ITS OWN: the installation token those calls carry is
 * the merge seam's (`githubMergeSeamEnv`), so the lane turns both on together.
 *
 * Opt-in (`E2E_JOB_WORKER_GITHUB_PREVIEW_SEAM=1`, set by the acceptance config).
 */
export function githubPreviewSeamEnv(): Record<string, string> {
  if (process.env['E2E_JOB_WORKER_GITHUB_PREVIEW_SEAM'] !== '1') return {};
  const env: Record<string, string> = { E2E_TEST_GITHUB_PREVIEW: '1' };
  for (const name of [
    'MOTIR_GITHUB_PREVIEW_CONTROL_PATH',
    'MOTIR_GITHUB_PREVIEW_JOURNAL_PATH',
    ...PREVIEW_WORKER_ENV,
  ]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

/**
 * THE motir-ai EMBEDDINGS SEAM, mirrored into the worker (Story MOTIR-9490 ·
 * MOTIR-9577).
 *
 * A page's embedding is written by the `page/embedding.requested` JOB, so its
 * `POST /v1/embeddings` is made HERE, while the search query's is made by the
 * webServer. Both must reach the same fake, or a saved page is never findable
 * by meaning and the spec waits for a hit that cannot come. The fake keeps no
 * state in memory (its vectors are a pure function of the text, its control and
 * journal are files), so a second copy in this process agrees with the first.
 * `MOTIR_AI_URL` and its token already reach this process from the runner.
 *
 * Opt-in (`E2E_JOB_WORKER_EMBEDDINGS_SEAM=1`, set by
 * `playwright.acceptance.config.ts`), because only that lane's server selects
 * this seam.
 */
export function embeddingsSeamEnv(): Record<string, string> {
  if (process.env['E2E_JOB_WORKER_EMBEDDINGS_SEAM'] !== '1') return {};
  return {
    E2E_TEST_EMBEDDINGS: '1',
    ...(process.env['MOTIR_AI_EMBEDDINGS_CONTROL_PATH']
      ? { MOTIR_AI_EMBEDDINGS_CONTROL_PATH: process.env['MOTIR_AI_EMBEDDINGS_CONTROL_PATH'] }
      : {}),
    ...(process.env['MOTIR_AI_EMBEDDINGS_JOURNAL_PATH']
      ? { MOTIR_AI_EMBEDDINGS_JOURNAL_PATH: process.env['MOTIR_AI_EMBEDDINGS_JOURNAL_PATH'] }
      : {}),
  };
}

/** A fresh RSA private key (PKCS#8 PEM) for an App JWT nothing will verify. */
function generateAppPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return privateKey;
}

/**
 * ⚠️ THE INDEX-WRITER SEAM'S ENVIRONMENT — WORKER ONLY, and the "only" is the
 * decision (Story MOTIR-3417 · MOTIR-3564).
 *
 * The index supervisor mints a motir-ai run credential and resolves a GitHub
 * tarball redirect before it provisions anything. Both calls happen HERE: the
 * supervisor is a job, and the app server's whole part in a refresh is the
 * webhook writing a `job_queue` row.
 *
 * ⚠️ AND THESE MUST NOT REACH THE APP SERVER. `lib/ai/availability.ts` reads
 * `MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN` process-wide to decide whether the AI
 * layer is configured, so setting them on the webServer would flip the whole lane
 * CLOUD-ON — and `ai-callout-gate`, `cloud-orb-clearance`, `cloud-board-load` and
 * `top-bar-budget` all assert the OFF state against that server. That is why they
 * are set in this SPAWN and not in `playwright.config.ts`'s `webServer.env` or on
 * the runner (a runner variable is inherited by the webServer too).
 *
 * `MOTIR_AI_URL` is a deliberately UNRESOLVABLE host, exactly like the acceptance
 * lane's: a missing intercept then fails loud instead of escaping to the network.
 * The App key is GENERATED per run — `createAppJwt` has to really sign, even
 * though nothing verifies the signature behind the intercept.
 *
 * The mirror-image failure this repeats nothing of: MOTIR-3498, where
 * `EMAIL_PROVIDER` was set on the webServer only and every engine-routed send
 * went to the console provider while every signal stayed green.
 */
function indexWriterSeamEnv(): Record<string, string> {
  if (process.env['E2E_JOB_WORKER_CODE_GRAPH_SEAM'] !== '1') return {};
  const privateKey = generateAppPrivateKey();
  return {
    E2E_TEST_CODE_GRAPH: '1',
    MOTIR_AI_URL: 'http://motir-ai.index-e2e.local',
    // ⚠️ THE CONTAINER'S OWN ADDRESS, AND IT IS REQUIRED (MOTIR-4518). It has no
    // fallback to `MOTIR_AI_URL` by design — a default is what let every
    // production index run build its graph and then die at
    // `getaddrinfo ENOTFOUND motir-ai.internal` for two weeks — so without this
    // line `bootIndexContainer` throws in its deployment gate and no supervised
    // run in this lane can settle. A DIFFERENT host from the one above, because
    // in production the worker and the container are in different organizations
    // and reach motir-ai at different addresses; unresolvable for the same
    // reason its neighbour is, and never actually fetched from here — the value
    // only has to arrive in the container spec.
    MOTIR_AI_CONTAINER_URL: 'http://motir-ai-public.index-e2e.local',
    MOTIR_AI_SERVICE_TOKEN: 'e2e-index-placeholder-token',
    GITHUB_APP_ID: '990001',
    GITHUB_APP_PRIVATE_KEY: privateKey,
    // The fake orchestrator's container has to EXIT for a supervised run to
    // settle, and `completeJob()` is an in-process call the Playwright runner
    // cannot reach across into this child. `0` makes the first poll observe a
    // clean exit, which is what a `succeeded` ledger row requires. Set here for
    // the same reason as everything above it: this is the process that supervises.
    MOTIR_FAKE_CONTAINER_AUTO_EXIT_CODE: '0',
    // ⚠️ AND THE CONTAINER HAS TO OUTLIVE THE WORKER (MOTIR-3828). A supervision
    // is a state machine over RUNS now, so the pass that BOOTS a container and
    // the pass that first POLLS it are different worker processes by design —
    // and `killJobWorker()` makes that explicit. The fake's machine map is a
    // module singleton, so without a shared store a restarted worker reports a
    // perfectly healthy container as `exists: false`, which
    // `pollIndexContainer` correctly classifies `never_started`.
    //
    // The seam is opt-in and file-backed (`lib/orchestrator/adapters/fake`), so
    // every vitest suite keeps the in-memory singleton it drives today. One file
    // per lane, under the same output directory Playwright already owns.
    MOTIR_FAKE_CONTAINER_STATE_PATH:
      process.env['MOTIR_FAKE_CONTAINER_STATE_PATH'] ?? FAKE_CONTAINER_STATE_PATH,
  };
}

/**
 * Where the fake orchestrator's cross-process container store lives for this
 * lane. Under `out/`, which the run already owns and CI already ignores.
 */
const FAKE_CONTAINER_STATE_PATH = 'out/playwright-output/.fake-containers.json';

let worker: ChildProcess | undefined;

/**
 * ⚠️ A SECOND, SPEC-OWNED WORKER — and it exists for ONE property the lane's
 * shared worker structurally cannot show (Story MOTIR-3416 · Subtask MOTIR-3473).
 *
 * The `skip` catch-up disposition suppresses a fire from BEFORE the scheduler
 * started. The lane's worker starts in `globalSetup`, before every spec, so by
 * construction every fire a spec can observe is one that scheduler WAS watching
 * for — `skip` and `latest` are indistinguishable through it, however long the
 * spec waits. Only a scheduler that starts DURING the spec can be shown to have
 * missed something, and that is what a worker restart across a fire is.
 *
 * It takes its OWN routing file rather than sharing the lane's, which is what
 * keeps the two workers from scheduling each other's jobs: `routedJobIdsFromFile`
 * reads `MOTIR_POSTGRES_JOB_IDS_FILE` per call, so handing this child a different
 * path gives it a private view of the switch while the lane's worker and the app
 * server keep reading the shared one, untouched.
 *
 * Claiming is NOT routed — either worker may claim any pending row — so this adds
 * a claimant and never a second scheduler for the same job.
 */
let specWorker: ChildProcess | undefined;

/** True when the E2E lane should run a worker at all. */
export function jobWorkerEnabled(): boolean {
  return process.env['E2E_JOB_WORKER'] === '1';
}

/**
 * Start the worker and wait until it has announced itself.
 *
 * Resolves on the worker's own startup line rather than after a sleep — the
 * authoritative signal, the same discipline every spec in this lane owes its
 * assertions.
 */
export async function startJobWorker(): Promise<void> {
  if (!jobWorkerEnabled() || worker) return;

  if (!existsSync(WORKER_BUNDLE)) {
    throw new Error(
      `[e2e-job-worker] ${WORKER_BUNDLE} is missing. The lane runs the SHIPPED bundle, not the ` +
        `TypeScript source, so it must be built first: \`pnpm build:worker\`. ` +
        `(playwright.config.ts's app webServer command builds it; if you are running the spec ` +
        `against an already-running server, build it by hand.)`,
    );
  }

  const child = spawn(process.execPath, [WORKER_BUNDLE], {
    env: {
      ...process.env,
      // The worker is a background process; nothing about it is a request path.
      NODE_ENV: process.env['NODE_ENV'] ?? 'production',
      // ⚠️ THE WORKER NEEDS THE SAME HARNESS FLAG THE APP webServer GETS, and
      // omitting it is not a subtle failure — it is an immediate refusal to boot.
      // The worker runs the app's own modules, so `NODE_ENV=production` (correct
      // for it: it runs the shipped bundle) trips every guard written for a real
      // deployment. The first one it hits is `lib/email.ts`'s:
      //
      //   Error: Email provider 'file' is not allowed in production.
      //
      // …because the pilot job SENDS EMAIL, through the test sink. This flag is
      // exactly what re-relaxes those seams for a production-mode test process,
      // and the worker is one. Found by running the spec, not by reading it.
      E2E_PROD_HARNESS: '1',
      // ⚠️ AND THE EMAIL SINK, FOR THE SAME REASON ONE FLAG OVER (Bug MOTIR-3498).
      // `playwright.config.ts` sets `EMAIL_PROVIDER: 'file'` on the **webServer
      // only**. This is a THIRD process and inherits the RUNNER's env, which
      // carries `EMAIL_OUTBOX_PATH` (set at config load) but not the provider —
      // so every job the engine runs sent its mail through the dev-CONSOLE
      // provider and the outbox never saw it. The failure is maximally quiet: the
      // send succeeds, the ledger row reaches `succeeded`, the message is printed
      // to this process's stdout, and `waitForEmail` times out having seen zero.
      //
      // Any webServer-only variable a JOB HANDLER reads has to be mirrored here.
      // The worker runs the same app modules; it just is not the app server.
      EMAIL_PROVIDER: 'file',
      ...(process.env['EMAIL_OUTBOX_PATH']
        ? { EMAIL_OUTBOX_PATH: process.env['EMAIL_OUTBOX_PATH'] }
        : {}),
      // ⚠️ THE LONG-RUNNING PROBE (MOTIR-3767), always on for this lane and
      // DORMANT until something enqueues it. Unlike the index-writer seam below
      // it needs no opt-in: registering the job costs one `defineJob` call and
      // installs no interceptor, so a spec that never enqueues
      // `system.e2e-slow-probe` cannot tell it is there. Set unconditionally
      // because the worker starts ONCE in `globalSetup` — a per-spec opt-in
      // would mean restarting it, which is exactly the cost this avoids.
      E2E_TEST_SLOW_JOB: '1',
      E2E_TEST_DEFERRING_JOB: '1',
      // The index-writer seam — see `indexWriterSeamEnv` for why it is here and
      // nowhere else.
      ...indexWriterSeamEnv(),
      // The fake error monitor — see `monitorFakeEnv`.
      ...monitorFakeEnv(),
      // The GitHub merge seam and the App it merges as — see `githubMergeSeamEnv`.
      ...githubMergeSeamEnv(),
      // The hosted-run gateway/motir-ai/GitHub seams — see `hostedRunSeamEnv`.
      ...hostedRunSeamEnv(),
      ...embeddingsSeamEnv(),
      // The fake hosting port's shared store — see `previewHostingSeamEnv`.
      ...previewHostingSeamEnv(),
      // A preview's GitHub deployment and manifest — see `githubPreviewSeamEnv`.
      ...githubPreviewSeamEnv(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker = child;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('[e2e-job-worker] the worker did not announce itself within 30s'));
    }, 30_000);

    const onLine = (buf: Buffer) => {
      const text = buf.toString();
      // Surface the worker's output into the runner's log: a spec that hangs
      // waiting for a run needs to see whether the worker claimed it, and a
      // silent child process is the worst thing to debug against.
      process.stderr.write(`[e2e-job-worker] ${text}`);
      if (text.includes('[worker] started as')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`[e2e-job-worker] exited before starting (code ${code})`));
    });
  });
}

/**
 * Stop the worker, letting it DRAIN.
 *
 * `SIGTERM` rather than `SIGKILL` deliberately: draining is a behaviour the
 * worker ships (MOTIR-3421), and using the graceful path here means the lane
 * exercises it on every run rather than only in the unit test that asserts it.
 */
export async function stopJobWorker(): Promise<void> {
  const child = worker;
  if (!child) return;
  worker = undefined;

  await new Promise<void>((resolve) => {
    const done = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 15_000);
    child.on('exit', () => {
      clearTimeout(done);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * KILL the worker outright — SIGKILL, no drain (Story MOTIR-3417 · MOTIR-3487).
 *
 * ⚠️ THE DIFFERENCE FROM `stopJobWorker` IS THE WHOLE POINT, and a spec that
 * reached for the graceful one would prove the opposite of what it meant to.
 * `stopJobWorker` sends SIGTERM, which makes the worker DRAIN: it stops claiming,
 * WAITS for its in-flight runs (up to `DRAIN_TIMEOUT_MS`) and then releases them.
 * A supervisor mid-index would simply finish, and the spec would assert nothing
 * about resuming.
 *
 * SIGKILL is the crash: the process dies holding the claim, the row stays
 * `running` with a lease nobody renews, and it becomes reclaimable only when that
 * lease expires (`LEASE_MS`, 60 s). That is the path the story's criterion is
 * about — *"a supervisor survives a worker restart mid-run and resumes
 * supervising its container — asserted by a test that actually restarts, not by
 * reading the code"* — and it exercises the reclaim's attempt REFUND rather than
 * the drain's.
 *
 * `startJobWorker()` brings a fresh one up; the module-level handle is cleared
 * here so it will.
 */
export async function killJobWorker(): Promise<void> {
  const child = worker;
  if (!child) return;
  worker = undefined;
  await new Promise<void>((resolve) => {
    // Resolve on the real exit rather than after a sleep — the same
    // authoritative-signal discipline every assertion in this lane owes.
    const done = setTimeout(resolve, 10_000);
    child.on('exit', () => {
      clearTimeout(done);
      resolve();
    });
    child.kill('SIGKILL');
  });
}

/**
 * Start an ADDITIONAL worker owned by the calling spec, with a PRIVATE routing
 * file. See the `specWorker` note above for why a spec ever needs one.
 *
 * Resolves on the worker's own startup line, like `startJobWorker`.
 */
export async function startSpecJobWorker(routingFile: string): Promise<Date> {
  if (specWorker) throw new Error('[e2e-spec-worker] one is already running; stop it first');
  if (!existsSync(WORKER_BUNDLE)) {
    throw new Error(
      `[e2e-spec-worker] ${WORKER_BUNDLE} is missing — run \`pnpm build:worker\` first.`,
    );
  }

  const child = spawn(process.execPath, [WORKER_BUNDLE], {
    env: {
      ...process.env,
      NODE_ENV: process.env['NODE_ENV'] ?? 'production',
      E2E_PROD_HARNESS: '1',
      // The private view of the cutover switch — the whole point of this worker.
      MOTIR_POSTGRES_JOB_IDS_FILE: routingFile,
      ...indexWriterSeamEnv(),
      // The fake error monitor — see `monitorFakeEnv`.
      ...monitorFakeEnv(),
      // The GitHub merge seam and the App it merges as — see `githubMergeSeamEnv`.
      ...githubMergeSeamEnv(),
      // The hosted-run gateway/motir-ai/GitHub seams — see `hostedRunSeamEnv`.
      ...hostedRunSeamEnv(),
      ...embeddingsSeamEnv(),
      // The fake hosting port's shared store — see `previewHostingSeamEnv`.
      ...previewHostingSeamEnv(),
      // A preview's GitHub deployment and manifest — see `githubPreviewSeamEnv`.
      ...githubPreviewSeamEnv(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  specWorker = child;

  return new Promise<Date>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('[e2e-spec-worker] the worker did not announce itself within 30s'));
    }, 30_000);
    const onLine = (buf: Buffer) => {
      const text = buf.toString();
      process.stderr.write(`[e2e-spec-worker] ${text}`);
      if (text.includes('[worker] started as')) {
        clearTimeout(timer);
        // The moment its scheduler began watching, which is what every `skip`
        // assertion is stated against.
        resolve(new Date());
      }
    };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`[e2e-spec-worker] exited before starting (code ${code})`));
    });
  });
}

/** Stop the spec-owned worker, letting it drain. Idempotent. */
export async function stopSpecJobWorker(): Promise<void> {
  const child = specWorker;
  if (!child) return;
  specWorker = undefined;
  await new Promise<void>((resolve) => {
    const done = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 15_000);
    child.on('exit', () => {
      clearTimeout(done);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
