/**
 * The WORKER ENTRYPOINT (Story MOTIR-3414 · Subtask MOTIR-3421).
 *
 * What `fly.toml`'s `worker` process group runs. It does four things and nothing
 * else: import the registry, start the loop, wire the signals, and stay up.
 *
 * As of MOTIR-3471 it also runs the SCHEDULER — the tick that turns a cron
 * expression into a `job_queue` row. It is not a fifth thing: the scheduler owns
 * no loop and no timer, and rides the claim loop this file already starts (see
 * `lib/jobs/engine/scheduler.ts` for why the poll, and not a `setTimeout` chain,
 * is the right driver). It adds no process, no machine and no environment
 * variable.
 *
 * It briefly also REPORTED a lane reconciliation at start-up (MOTIR-3716) — the
 * checked-in lane declaration against the live `MOTIR_POSTGRES_JOB_IDS`. Both went
 * with the second lane in MOTIR-3418: there is one engine now, so there is nothing
 * to route and nothing to reconcile.
 *
 * ⚠️ THE REGISTRY IMPORT BELOW IS LOAD-BEARING.
 * `JobScheduler.start()` REFUSES an empty registry rather than scheduling nothing
 * in silence, so deleting that import fails the process at start-up with a named
 * diagnosis instead of at run time with `UnknownEngineJobError`.
 *
 * ⚠️ IT LOOKS UNUSED AND IT IS NOT. `lib/jobs/engine/registry.ts`
 * is populated by `defineJob` as each definition MODULE is evaluated, so it holds
 * only the jobs something has imported. `lib/jobs/registry.ts` imports all 24
 * definition files, which is why importing it — for its side effect, not its
 * value — is what makes the engine's table complete. Deleting this import as
 * "unused" yields a worker that claims runs and cannot execute a single one,
 * with `UnknownEngineJobError` for every job id. `lib/jobs/schedules.ts` carries
 * the same warning for the same reason.
 *
 * ⚠️ IT IS BUNDLED, NOT RUN FROM SOURCE. `pnpm build:worker` esbuilds this file
 * and its transitive imports into one self-contained `.mjs`, which the Dockerfile
 * stages at `/app/worker/`. The runtime image is a Next.js STANDALONE bundle: its
 * `node_modules` is the minimal set Next traced for the SERVER's entries, and
 * `lib/` source arriving there at all is a tracing side effect the Dockerfile
 * explicitly refuses to depend on. So the worker brings its own bundle, exactly
 * as `/app/migrate` brings its own Prisma CLI, and for the same reason: a lane
 * that runs from the app's image must not inherit its files by accident.
 */
import * as Sentry from '@sentry/nextjs';
import { db } from '@/lib/db';
import { serverSentryInitOptions } from '@/lib/monitoring/serverInit';
import { startTransactionStallMonitor } from '@/lib/monitoring/transactionStall';
import { startEventLoopDelayPublisher } from '@/lib/monitoring/cloudwatchMetrics';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { JobScheduler } from '@/lib/jobs/engine/scheduler';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { listenForQueuedJobs } from '@/lib/jobs/engine/notify';
import {
  MONITOR_REFRESH_LEASE_MS,
  monitorCredentialService,
} from '@/lib/services/monitorCredentialService';
// Side-effect import: evaluates every definition module so `defineJob` has
// registered every job. See the warning above — this is not an unused import.
import '@/lib/jobs/registry';

/**
 * ⚠️ THE E2E BOUNDARY SEAMS, AND WHY THIS PROCESS INSTALLS THEM ITSELF
 * (Story MOTIR-3417 · MOTIR-3564; Bug MOTIR-5837).
 *
 * Every external boundary in the E2E lane is stubbed by a `lib/test-*-mock.ts`
 * behind a flag. `instrumentation.ts` installs them in the app server, and it is
 * a NEXT.JS HOOK: it runs once per Next server boot, and this process is not a
 * Next server — it is a plain Node bundle (`pnpm build:worker`). So a seam
 * registered there is invisible here, and this process installs from the same
 * table (`lib/test-mock-seams.ts`) on its own.
 *
 * It matters for every boundary a JOB crosses. The index SUPERVISOR mints a
 * motir-ai run credential and resolves a GitHub tarball redirect (MOTIR-3564);
 * `pull-request/auto-merge.requested` merges through GitHub, and
 * `system.pull-request-reconcile` reads it (MOTIR-5837). The process that makes
 * those calls is this one. A seam installed only in the app server leaves them
 * un-stubbed where they actually happen — the MOTIR-3498 shape, one layer up
 * (there it was `EMAIL_PROVIDER` set on the webServer only, and every
 * engine-routed send went to the console provider while every signal stayed
 * green). WHICH flags this process carries is `job-worker-process.ts`'s
 * decision, not this function's.
 *
 * DORMANT BY DEFAULT. No flag set ⇒ `installE2EMockSeams` installs nothing and
 * imports nothing, so a production worker never even loads `undici`'s mock
 * machinery. The code-graph seam additionally refuses outside the harness
 * (`E2E_PROD_HARNESS=1`, set by the Playwright configs and by no real deployment).
 */
async function installE2ESeams(): Promise<void> {
  // The LONG-RUNNING PROBE (MOTIR-3767) — its own flag, and checked FIRST so it
  // does not inherit the code-graph seam's early return. The two are independent
  // seams that happen to share this hook.
  const { slowJobEnabled } = await import('@/lib/test-slow-job');
  if (slowJobEnabled()) {
    const { registerSlowTestJob } = await import('@/lib/test-slow-job');
    registerSlowTestJob();
    console.info('[worker] E2E_TEST_SLOW_JOB active — the long-running probe is registered.');
  }

  // The SELF-RESCHEDULING PROBE (MOTIR-3832) — its own flag, and the same
  // independent-seam shape as the one above. It is a supervision rather than a
  // slow run: `lib/test-deferring-job.ts`'s header says why the two cannot be
  // one probe.
  const { deferringJobEnabled } = await import('@/lib/test-deferring-job');
  if (deferringJobEnabled()) {
    const { registerDeferringTestJob } = await import('@/lib/test-deferring-job');
    registerDeferringTestJob();
    console.info(
      '[worker] E2E_TEST_DEFERRING_JOB active — the self-rescheduling probe is registered.',
    );
  }

  // EVERY boundary seam whose flag this process carries, from the SAME table
  // `instrumentation.ts` installs from (MOTIR-5837). Until then this block
  // installed the code-graph seam alone, by hand — so a job that merged, read or
  // posted to GitHub reached the real api.github.com. The shared agent also
  // REFUSES any api.github.com call no seam intercepted (`lib/test-mock-agent`).
  const { installE2EMockSeams } = await import('@/lib/test-mock-seams');
  await installE2EMockSeams((line) => console.info(`[worker] ${line}`));
}

/**
 * ⚠️ ERROR MONITORING, AND THE REASON IT IS HERE RATHER THAN INHERITED
 * (MOTIR-3606).
 *
 * `instrumentation.ts` is what initialises Sentry for the app — and it is a
 * NEXT.JS HOOK, so this process never runs it, exactly as its own header says of
 * the E2E seams two functions up. The consequence was not a missing convenience:
 * **every scheduled job in production ran in a process with no error monitoring
 * at all.** `system.daily-health-check` dead-lettered every morning for 23 days
 * and the only trace it left anywhere was a `job_run` row, which is a surface a
 * person has to decide to go and look at. That is half of why nobody found out.
 *
 * The options come from the same builder the Next server uses
 * (`serverSentryInitOptions()`), so the two Node runtimes cannot drift in what
 * they report or in what they refuse to send — and it returns null with no
 * `SENTRY_DSN`, which keeps the self-host contract: no init, no integrations, no
 * transport, phones nowhere.
 *
 * FIRST in `main()`, above the seams and the loop, so an exception thrown while
 * the worker is still starting is reported rather than lost.
 */
function initMonitoring(): void {
  // Untraced on purpose: it does not opt in to tracing, so the rate is 0 whatever the
  // app-wide SENTRY_TRACES_SAMPLE_RATE says — MOTIR-8537 owns that choice.
  const options = serverSentryInitOptions();
  if (!options) return;
  Sentry.init(options);
  // A job's P2028 reports the worker's own event-loop delay (MOTIR-6701).
  startTransactionStallMonitor();
  console.info(`[worker] error monitoring on (environment: ${options.environment ?? 'unset'})`);
}

async function main(): Promise<void> {
  initMonitoring();
  // Event-loop delay as CloudWatch metrics when MONITORING_CLOUDWATCH_NAMESPACE
  // is set (MOTIR-9881). Outside initMonitoring's DSN return on purpose: a
  // Fargate task may run with no DSN and still owes the alarm its metric.
  startEventLoopDelayPublisher();

  // Before anything claims a run: a supervised job's first act is an external
  // call, so the seam has to be in place before the loop starts.
  await installE2ESeams();

  // The triggering event's payload lives on `job_event`; a cron run has no event
  // and gets an empty payload.
  const payloadFor = async (run: { eventId: string | null }): Promise<unknown> => {
    if (!run.eventId) return {};
    const event = await withSystemContext((tx) =>
      tx.jobEvent.findUnique({ where: { id: run.eventId! } }),
    );
    return event?.data ?? {};
  };

  // Armed BEFORE the worker starts, so an empty registry refuses at start-up
  // rather than after the first claim — `main`'s catch turns the throw into a
  // non-zero exit with the diagnosis, which is what makes the failure visible.
  const scheduler = new JobScheduler();
  scheduler.start();

  const worker = new JobWorker({
    async execute(run) {
      await executeWithLedger(run, await payloadFor(run));
    },
    // The scheduler rides the claim loop (MOTIR-3471) — one tick, at the top of
    // each poll, so a fire it enqueues is claimed by the same pass. It logs
    // through its own injected sink, so there is nothing to report here.
    onSchedulerTick: () => scheduler.tick().then(() => undefined),
    // The after-all-retries-exhausted hook — the engine's `onFailure`. See
    // `lib/jobs/engine/ledger.ts` for why it is not a catch inside `execute`.
    async onTerminalFailure(run, error) {
      await recordEngineTerminalFailure(run, error, await payloadFor(run));
    },
  });

  worker.start();
  console.info(`[worker] started as ${worker.workerId}`);

  const listener = await listenForQueuedJobs(() => worker.notify());

  let shuttingDown = false;
  const drain = (signal: string) => {
    // A second signal must not start a second drain: the release is idempotent
    // but a concurrent one would race the in-flight wait and cut it short.
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[worker] ${signal} — draining`);
    void (async () => {
      await listener.stop();
      // ⚠️ AN IN-FLIGHT CREDENTIAL REFRESH IS WAITED ON, NOT ONLY THE JOB AROUND
      // IT (MOTIR-8184). The job drain gives up after its own deadline and
      // releases the claim, which is fine for a job — it re-runs — and fatal for a
      // monitor token refresh: the provider rotates the refresh token as it
      // answers, so disconnecting before the new pair is stored kills the
      // connection until a person re-authorises. `fly.toml`'s `kill_timeout`
      // is sized to cover this wait.
      const [, refreshes] = await Promise.all([
        worker.shutdown(),
        monitorCredentialService.settleInFlightRefreshes(MONITOR_REFRESH_LEASE_MS),
      ]);
      if (refreshes.pending > 0) {
        console.warn(
          `[worker] ${refreshes.pending} credential refresh(es) still in flight at exit`,
        );
      }
      await db.$disconnect();
      console.info('[worker] drained; exiting');
      process.exit(0);
    })();
  };

  // SIGTERM is what Fly sends before a SIGKILL on every deploy — several times a
  // day. SIGINT is the local equivalent.
  process.on('SIGTERM', () => drain('SIGTERM'));
  process.on('SIGINT', () => drain('SIGINT'));

  // ⚠️ RELEASE ON AN UNCAUGHT CRASH TOO, best-effort. The lease already covers
  // this (an expired lease is reclaimed), but a lease takes a minute to expire
  // and a release is instant — so on the one crash path where we still have a
  // connection, hand the runs back rather than making the next claimant wait out
  // the lease.
  process.on('uncaughtException', (err) => {
    console.error('[worker] uncaught exception; releasing claims', err);
    void withSystemContext((tx) => jobQueueRepository.releaseClaims(worker.workerId, tx))
      .catch(() => {})
      .finally(() => process.exit(1));
  });
}

void main().catch((err: unknown) => {
  console.error('[worker] failed to start', err);
  process.exit(1);
});
