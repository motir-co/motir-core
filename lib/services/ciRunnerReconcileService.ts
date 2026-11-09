import * as Sentry from '@sentry/nextjs';
import { Prisma, type CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { dispatchCiRunnerBoot } from '@/lib/ciFleet/bootDispatch';
import { fleetRunnerTargetFor } from '@/lib/ciFleet/runnerTarget';
import { isCiFleetConfigured } from '@/lib/orchestrator';
import {
  fleetQueueClient,
  type QueuedFleetJob,
  type SkippedFleetRun,
} from '@/lib/github/fleetQueue';

// THE GITHUB-SIDE RECONCILE (Bug MOTIR-8976).
//
// The fleet boots one ephemeral runner per `workflow_job.queued` delivery and
// settles that intent when ITS runner finishes. But a runner is not tied to a job:
// every fleet runner carries the same label and GitHub gives a new runner to the
// OLDEST queued job in the group. So once ONE runner is lost for any reason, one
// job is left queued and that shortfall never shrinks — every later batch's
// runners serve the older stranded jobs first, and every intent still settles
// `job_completed`. The fleet's only record of demand was its own intents, and
// GitHub's queue was never checked.
//
// This sweep makes GitHub's queue the record. Per org the fleet serves:
//
//   queued fleet jobs (older than the grace)
//     − idle live runners registered there
//     − intents still `pending` / `provisioning` (a runner already on its way)
//   = jobs with no runner coming → one NEW intent each (a reconcile generation of
//     the job), dispatched through the ordinary boot, so the admission gate (pool
//     cap, `ci_credits_exhausted`) still decides.
//
// ⚠️ IT NEVER BOOTS PAST THE GAP: coverage is counted before anything is minted,
// the oldest jobs are the ones minted for, and the unique index on
// `(run, attempt, job, reconcile_generation)` makes two racing sweeps collide
// instead of double-booting.

/** A queued job younger than this is the webhook's hot path's to serve. */
export const RECONCILE_GRACE_MS = 2 * 60_000;

/** How far back the fleet's own records name the repos worth asking GitHub about. */
const REPO_LOOKBACK_MS = 3 * 24 * 60 * 60_000;

/** A job reconciled this many times and still queued is not one more boot will
 *  fix (a credits refusal settles each attempt `failed`) — stop minting for it. */
export const MAX_RECONCILE_GENERATION = 5;

export interface ReconcileOrgOutcome {
  org: string;
  queued: number;
  idleRunners: number;
  awaiting: number;
  added: number;
  /** Runs whose jobs GitHub would not serve this tick (MOTIR-10790). Their jobs
   *  are not counted; the other runs of the org are. Present only when non-empty. */
  skippedRuns?: SkippedFleetRun[];
  /** Set when the org could not be read; the other orgs are unaffected. */
  error?: string;
}

export interface ReconcileOutcome {
  orgs: ReconcileOrgOutcome[];
  added: number;
  /** Set by the provision sweep when the reconcile itself threw. */
  error?: string;
}

export const ciRunnerReconcileService = {
  async reconcile(options: { now?: () => Date } = {}): Promise<ReconcileOutcome> {
    // The CI fleet's own gate, which follows its Fly↔AWS switch (MOTIR-10625).
    if (!(await isCiFleetConfigured())) return { orgs: [], added: 0 };
    const now = (options.now ?? (() => new Date()))();

    const latest = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.listLatestPerRepoSince(
        new Date(now.getTime() - REPO_LOOKBACK_MS),
        tx,
      ),
    );

    // Group the repos by org, case-insensitively. The first (newest) intent of an
    // org supplies the installation its target is built from.
    const byOrg = new Map<string, CiRunnerProvisioningIntent[]>();
    for (const intent of latest) {
      const key = intent.repoOwner.trim().toLowerCase();
      byOrg.set(key, [...(byOrg.get(key) ?? []), intent]);
    }

    const orgs: ReconcileOrgOutcome[] = [];
    for (const repos of byOrg.values()) {
      const org = repos[0]!.repoOwner;
      try {
        orgs.push(await reconcileOrg(org, repos, now));
      } catch (err) {
        // One org's outage (a revoked installation, GitHub down) must not starve
        // the others — the next tick retries it.
        const detail = err instanceof Error ? err.message : 'unknown';
        console.error('[ciRunnerReconcile] could not reconcile an org', { org, detail });
        orgs.push({ org, queued: 0, idleRunners: 0, awaiting: 0, added: 0, error: detail });
      }
    }

    const added = orgs.reduce((n, o) => n + o.added, 0);
    return { orgs, added };
  },
};

async function reconcileOrg(
  org: string,
  repos: CiRunnerProvisioningIntent[],
  now: Date,
): Promise<ReconcileOrgOutcome> {
  const target = fleetRunnerTargetFor(repos[0]!);

  const queued: QueuedFleetJob[] = [];
  const skippedRuns: SkippedFleetRun[] = [];
  for (const repo of repos) {
    const read = await fleetQueueClient.listQueuedFleetJobs(
      { owner: repo.repoOwner, repo: repo.repoName },
      target,
    );
    queued.push(...read.jobs);
    skippedRuns.push(...read.skippedRuns);
  }
  for (const run of skippedRuns) {
    // A run GitHub will not serve is left out, not fatal (MOTIR-10790). Its own
    // queued jobs are not counted this tick; every other run's still are.
    console.warn('[ciRunnerReconcile] skipped a run whose jobs GitHub would not serve', {
      org,
      ...run,
    });
  }
  const runners = await fleetQueueClient.listFleetRunners(target);
  const idleRunners = runners.filter((r) => r.online && !r.busy).length;
  const awaiting = await withSystemContext((tx) =>
    ciRunnerProvisioningIntentRepository.countAwaitingRunnerForOwner(org, tx),
  );

  // Oldest first: GitHub gives a runner to the oldest queued job, so the oldest
  // are the ones the available runners will serve and the uncovered are the rest.
  queued.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const uncovered = Math.max(0, queued.length - idleRunners - awaiting);
  const gaps = queued
    .slice(queued.length - uncovered)
    .filter((job) => now.getTime() - job.createdAt.getTime() > RECONCILE_GRACE_MS);

  let added = 0;
  for (const job of gaps) {
    const repoIntent = repos.find(
      (r) =>
        r.repoOwner.toLowerCase() === job.repoOwner.toLowerCase() && r.repoName === job.repoName,
    );
    if (!repoIntent) continue;
    const intentId = await mintReconcileIntent(job, repoIntent);
    if (intentId === null) continue;
    added += 1;
    // The ordinary boot path: `admit` is where the pool cap and the credit refusal
    // are decided, so a full pool defers this intent rather than exceeding it.
    await dispatchCiRunnerBoot(intentId, 'hot-path');
  }

  const outcome: ReconcileOrgOutcome = {
    org,
    queued: queued.length,
    idleRunners,
    awaiting,
    added,
    ...(skippedRuns.length > 0 ? { skippedRuns } : {}),
  };
  if (added > 0) {
    console.warn(
      '[ciRunnerReconcile] queued fleet jobs had no runner coming — booted more',
      outcome,
    );
    Sentry.addBreadcrumb({
      category: 'ci-runner-reconcile',
      level: 'warning',
      message: `reconcile added ${added} runner(s) for ${org}`,
      data: outcome,
    });
  }
  return outcome;
}

/** Mint the next reconcile generation of a job, or null when it is not ours to
 *  mint (generation cap, or a racing sweep won the unique index). */
async function mintReconcileIntent(
  job: QueuedFleetJob,
  base: CiRunnerProvisioningIntent,
): Promise<string | null> {
  try {
    return await withSystemContext(async (tx) => {
      const max = await ciRunnerProvisioningIntentRepository.maxReconcileGeneration(
        job.runId,
        job.runAttempt,
        job.jobId,
        tx,
      );
      const generation = max + 1;
      if (generation > MAX_RECONCILE_GENERATION) return null;
      const intent = await ciRunnerProvisioningIntentRepository.create(
        {
          workspaceId: base.workspaceId,
          organizationId: base.organizationId,
          projectId: base.projectId,
          githubRepoId: base.githubRepoId,
          installationId: base.installationId,
          runId: job.runId,
          runAttempt: job.runAttempt,
          jobId: job.jobId,
          jobName: job.jobName,
          workflowName: job.workflowName,
          repoOwner: base.repoOwner,
          repoName: base.repoName,
          requestedLabels: job.labels,
          queuedAt: job.createdAt,
          reconcileGeneration: generation,
        },
        tx,
      );
      return intent.id;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}
