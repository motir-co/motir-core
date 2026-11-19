import * as Sentry from '@sentry/nextjs';
import {
  Prisma,
  type CiRunnerProvisioningIntent,
  type CiSpotRerunPin,
} from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { attributeMirroredRepos } from '@/lib/services/ciRunnerProvisioningService';
import { findProvisioningInstallationId } from '@/lib/github/repoProvisioning';
import { dispatchCiRunnerBoot } from '@/lib/ciFleet/bootDispatch';
import { fleetRunnerTargetFor } from '@/lib/ciFleet/runnerTarget';
import { requestsOnDemandRunner } from '@/lib/ciFleet/config';
import { isCiFleetConfigured } from '@/lib/orchestrator';
import { retryPendingSpotReruns } from '@/lib/services/ciSpotRerunService';
import { ciSpotRerunPinService, isPinnedJob } from '@/lib/services/ciSpotRerunPinService';
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
// ⚠️ IT ASKS GITHUB ABOUT EVERY REPO THE FLEET'S ORGANISATIONS LINK, NOT ONLY THE
// REPOS IT HAS INTENTS FOR (Bug MOTIR-11437). The repo set used to come from the
// intents alone, so a repo whose `workflow_job` deliveries never arrive (the
// motir-studio App not installed on it: motir-codegraph, 2026-11-16) was invisible
// to the hot path AND to this sweep, while its jobs took the runners booted for
// other repos' jobs. Now every live GitHub repo linked to a project of an
// organisation the fleet served in the lookback is read too; a repo with no
// delivery but queued fleet jobs is minted for and REPORTED, and a linked repo the
// fleet's credential cannot read is named whenever jobs are left stranded.
//
// ⚠️ A RUNNER THAT SERVED ANOTHER JOB DOES NOT SPEND A GENERATION (MOTIR-11437).
// The cap exists for a job one more boot will not fix; a generation whose runner
// took a job while this one stayed queued proves the opposite — the runner was
// taken, and the job needs another. Only generations never seen serving a job
// count toward {@link MAX_RECONCILE_GENERATION}; {@link MAX_RECONCILE_GENERATION_CEILING}
// still bounds the total.
//
// ⚠️ COVERAGE IS COUNTED PER LABEL SET (MOTIR-11727). A job that asked for the
// on-demand label as well (`[motir-runner, motir-on-demand]`) can only be taken
// by a runner carrying both, while a runner carrying both can take ANY fleet job.
// So the on-demand partition is covered only by on-demand capacity, and the
// ordinary partition by ordinary capacity plus whatever on-demand capacity the
// on-demand jobs leave over:
//
//   uncovered on-demand = max(0, Q_od − I_od − A_od)
//   surplus on-demand   = max(0, I_od + A_od − Q_od)
//   uncovered other     = max(0, Q_other − I_other − A_other − surplus)
//
// One subtraction over the totals would let an idle ordinary runner "cover" a
// deploy job it can never take (the deploy waits for ever), and counting the
// partitions apart without the surplus would boot for an ordinary job an idle
// on-demand runner is about to take. A minted intent copies its job's labels,
// so a gap in the on-demand partition boots an on-demand runner on its own.
//
// ⚠️ A JOB PINNED TO ON-DEMAND IS ITS OWN PARTITION (MOTIR-11732). The second
// Spot re-run of a job holds an on-demand pin in its org, and only a runner on an
// on-demand MACHINE may take it — whatever its labels. So the pinned jobs are
// taken out of the ordinary partition and covered first by the ordinary capacity
// known not to be Spot (an idle runner whose machine was booted on-demand, an
// intent not yet booted or booted on-demand — under the pin every new boot is
// on-demand), then by the on-demand surplus; what is left of either covers the
// ordinary jobs. An idle Spot runner covers ordinary jobs only:
//
//   pinned capacity  = I_pin + A_pin (+ the on-demand surplus)
//   uncovered pinned = max(0, Q_pin − pinned capacity)
//   uncovered other  = max(0, Q_other − (I_other + A_other − used by pinned)
//                                     − surplus left)
//
// With no pin open, Q_pin is 0 and the formula above is the one before it.
//
// ⚠️ IT NEVER BOOTS PAST THE GAP: coverage is counted before anything is minted,
// the oldest jobs are the ones minted for, and the unique index on
// `(run, attempt, job, reconcile_generation)` makes two racing sweeps collide
// instead of double-booting.

/** A queued job younger than this is the webhook's hot path's to serve. */
export const RECONCILE_GRACE_MS = 2 * 60_000;

/** How far back the fleet's own records name the repos — and the organisations,
 *  whose linked repos are read too (MOTIR-11437) — worth asking GitHub about. */
const REPO_LOOKBACK_MS = 3 * 24 * 60 * 60_000;

/** A job reconciled this many times by runners that never served a job, and still
 *  queued, is not one more boot will fix (a credits refusal settles each attempt
 *  `failed`) — stop minting for it. A generation whose runner served another job
 *  does not count (MOTIR-11437). */
export const MAX_RECONCILE_GENERATION = 5;

/** The hard bound on a job's reconcile generations, served or not (MOTIR-11437):
 *  every served generation ran a real queued job, so this is reached only when a
 *  job is passed over far longer than any queue drains — stop there rather than
 *  boot for it without end. */
export const MAX_RECONCILE_GENERATION_CEILING = 25;

export interface ReconcileOrgOutcome {
  org: string;
  queued: number;
  idleRunners: number;
  awaiting: number;
  added: number;
  /** Runs whose jobs GitHub would not list, left out of `queued` this tick
   *  (MOTIR-10790). Present only when there are any. */
  skippedRuns?: SkippedFleetRun[];
  /** `owner/repo`s holding queued fleet jobs with no `workflow_job` delivery in the
   *  lookback (MOTIR-11437). Present only when there are any. */
  undeliveredRepos?: string[];
  /** Linked `owner/repo`s the fleet's credential cannot read, named when jobs were
   *  left uncovered this tick (MOTIR-11437). Present only when there are any. */
  unreadableRepos?: string[];
  /** The on-demand partition's share of the totals above (MOTIR-11727): queued
   *  jobs that asked for the on-demand label, idle runners carrying it, intents
   *  awaiting a runner that asked for it, and intents minted for such jobs.
   *  Present only when any of them is non-zero. */
  onDemand?: OnDemandCoverage;
  /** Set when the org could not be read; the other orgs are unaffected. */
  error?: string;
}

/** The on-demand partition of one org's reconcile (MOTIR-11727). */
export interface OnDemandCoverage {
  queued: number;
  idleRunners: number;
  awaiting: number;
  added: number;
}

export interface ReconcileOutcome {
  orgs: ReconcileOrgOutcome[];
  added: number;
  /** Set by the provision sweep when the reconcile itself threw (MOTIR-10790). */
  error?: string;
}

export const ciRunnerReconcileService = {
  async reconcile(options: { now?: () => Date } = {}): Promise<ReconcileOutcome> {
    // The CI fleet's own gate, which follows its Fly↔AWS switch (MOTIR-10625).
    if (!(await isCiFleetConfigured())) return { orgs: [], added: 0 };
    const now = (options.now ?? (() => new Date()))();

    // A Spot-interrupted job whose re-run GitHub refused for a reason that may
    // clear is asked for again here, until it is accepted, refused for good, or
    // 24 hours pass (MOTIR-11728). It never throws, and it rides no outcome
    // field: the memoised step's shape stays as it is.
    const reruns = await retryPendingSpotReruns(now);
    if (reruns.requested + reruns.refused + reruns.expired + reruns.pending > 0) {
      console.warn('[ciRunnerReconcile] retried pending Spot re-runs', reruns);
    }
    // An on-demand pin whose re-run a runner took, or which is 24 hours old,
    // closes here (MOTIR-11732) — before any org reads its pins below. Never
    // throws, and rides no outcome field either.
    await ciSpotRerunPinService.closeSettledPins(now);

    const since = new Date(now.getTime() - REPO_LOOKBACK_MS);
    const latest = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.listLatestPerRepoSince(since, tx),
    );
    const linked = await listLinkedRepos([...new Set(latest.map((i) => i.organizationId))]);
    const byOrg = groupByOrg(latest, linked);

    const orgs: ReconcileOrgOutcome[] = [];
    for (const group of byOrg.values()) {
      const org = group.org;
      try {
        const installationId = group.installationId ?? (await findProvisioningInstallationId(org));
        // No fleet App on an org the fleet has never served: no fleet runner can
        // exist there to be taken, and none can be booted — nothing to reconcile.
        if (installationId === null) continue;
        orgs.push(await reconcileOrg(org, installationId, group.repos, now));
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

/** What a reconcile intent copies from — the attribution a mint needs. */
type MintBase = Pick<
  CiRunnerProvisioningIntent,
  'workspaceId' | 'organizationId' | 'projectId' | 'githubRepoId' | 'repoOwner' | 'repoName'
> & { installationId: string | null };

/** One repository the sweep asks GitHub about. */
interface FleetRepo {
  base: MintBase;
  /** The fleet recorded a `workflow_job` delivery for it within the lookback. */
  delivered: boolean;
}

interface OrgGroup {
  /** The org login as the newest intent (or the mirror) spells it. */
  org: string;
  /** The installation the org's newest intent arrived on; null when the fleet has
   *  no intent in the org at all and it must be looked up. */
  installationId: string | null;
  repos: FleetRepo[];
}

const repoKey = (owner: string, name: string) =>
  `${owner.trim().toLowerCase()}/${name.trim().toLowerCase()}`;

/**
 * Every live GitHub repository linked to a project of `organizationIds`, with the
 * attribution a reconcile intent for it would carry (MOTIR-11437). The mirror rows
 * are read under the system context (`github_repo`'s policy has the system arm);
 * the links through {@link attributeMirroredRepos}, one transaction per mirror
 * workspace — the intake's own read, so the two cannot attribute a repo
 * differently. A repository no project uses is not the fleet's to serve.
 */
async function listLinkedRepos(organizationIds: string[]): Promise<MintBase[]> {
  const mirrors = await withSystemContext((tx) =>
    githubRepoRepository.listLiveGithubByOrganizations(organizationIds, tx),
  );
  const byMirror = new Map<string, typeof mirrors>();
  for (const row of mirrors) {
    const key = `${row.workspaceId}:${row.organizationId}`;
    byMirror.set(key, [...(byMirror.get(key) ?? []), row]);
  }
  const linked: MintBase[] = [];
  for (const rows of byMirror.values()) {
    const attribution = await attributeMirroredRepos({
      workspaceId: rows[0]!.workspaceId,
      organizationId: rows[0]!.organizationId,
      githubRepoIds: rows.map((r) => r.id),
    });
    for (const row of rows) {
      const tenant = attribution.get(row.id);
      if (!tenant) continue;
      linked.push({
        workspaceId: tenant.workspaceId,
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        githubRepoId: row.id,
        repoOwner: row.owner,
        repoName: row.name,
        installationId: null,
      });
    }
  }
  return linked;
}

/**
 * Group the repos to read by GitHub org, case-insensitively. A repo with an intent
 * keeps that intent as its base, exactly as before; a linked repo with none is
 * added beside it, once. The first (newest) intent of an org supplies the
 * installation its target is built from.
 */
function groupByOrg(latest: CiRunnerProvisioningIntent[], linked: MintBase[]) {
  const byOrg = new Map<string, OrgGroup>();
  const seen = new Set<string>();
  const add = (base: MintBase, delivered: boolean) => {
    const key = repoKey(base.repoOwner, base.repoName);
    if (seen.has(key)) return;
    seen.add(key);
    const org = base.repoOwner.trim().toLowerCase();
    const group = byOrg.get(org) ?? {
      org: base.repoOwner,
      installationId: base.installationId,
      repos: [],
    };
    group.repos.push({ base, delivered });
    byOrg.set(org, group);
  };
  for (const intent of latest) add(intent, true);
  for (const base of linked) add(base, false);
  return byOrg;
}

async function reconcileOrg(
  org: string,
  installationId: string,
  repos: FleetRepo[],
  now: Date,
): Promise<ReconcileOrgOutcome> {
  const target = fleetRunnerTargetFor({ repoOwner: org, installationId });

  const queued: QueuedFleetJob[] = [];
  const skippedRuns: SkippedFleetRun[] = [];
  const unreadable: string[] = [];
  const undelivered = new Set<string>();
  for (const repo of repos) {
    const read = await fleetQueueClient.listQueuedFleetJobs(
      { owner: repo.base.repoOwner, repo: repo.base.repoName },
      target,
    );
    queued.push(...read.jobs);
    skippedRuns.push(...read.skippedRuns);
    const ref = `${repo.base.repoOwner}/${repo.base.repoName}`;
    if (read.unreadable && !repo.delivered) unreadable.push(ref);
    if (!repo.delivered && read.jobs.some((job) => pastGrace(job, now))) undelivered.add(ref);
  }
  // A run GitHub would not list is skipped, never fatal (MOTIR-10790): the org's
  // other stranded jobs are still counted below. Its own queued jobs are simply
  // not seen this tick, so they can only be under-served, never double-booted.
  for (const run of skippedRuns) {
    console.warn('[ciRunnerReconcile] skipped a run whose jobs GitHub would not list', {
      org,
      repo: `${run.repoOwner}/${run.repoName}`,
      runId: run.runId,
      status: run.status,
      detail: run.detail,
    });
  }
  const runners = await fleetQueueClient.listFleetRunners(target);
  const idle = runners.filter((r) => r.online && !r.busy);
  const idleOnDemand = idle.filter((r) => requestsOnDemandRunner(r.labels)).length;
  const idleRunners = idle.length;
  const awaitingSplit = await withSystemContext((tx) =>
    ciRunnerProvisioningIntentRepository.countAwaitingRunnerForOwner(org, tx),
  );
  const awaiting = awaitingSplit.onDemand + awaitingSplit.other;

  // Oldest first: GitHub gives a runner to the oldest queued job, so the oldest
  // are the ones the available runners will serve and the uncovered are the rest.
  queued.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const queuedOnDemand = queued.filter((job) => requestsOnDemandRunner(job.labels));
  const pins = await openPinsQuietly(org, now);
  const queuedPinned = queued.filter(
    (job) => !requestsOnDemandRunner(job.labels) && isPinnedJob(job, pins),
  );
  const queuedOther = queued.filter(
    (job) => !requestsOnDemandRunner(job.labels) && !isPinnedJob(job, pins),
  );
  // Only read which idle machines are on-demand when a pinned job needs one.
  const idleOrdinary = idle.filter((r) => !requestsOnDemandRunner(r.labels));
  const idlePinnedCapable =
    queuedPinned.length === 0 ? 0 : await countOnDemandMachines(idleOrdinary.map((r) => r.id));
  const coverage = coverPartitions({
    queuedOnDemand: queuedOnDemand.length,
    queuedOther: queuedOther.length,
    queuedPinned: queuedPinned.length,
    idleOnDemand,
    idleOther: idleRunners - idleOnDemand,
    idlePinnedCapable,
    awaitingOnDemand: awaitingSplit.onDemand,
    awaitingOther: awaitingSplit.other,
    awaitingPinnedCapable: awaitingSplit.otherNotSpot,
  });
  const onDemandGaps = youngest(queuedOnDemand, coverage.uncoveredOnDemand).filter((job) =>
    pastGrace(job, now),
  );
  const pinnedGaps = youngest(queuedPinned, coverage.uncoveredPinned).filter((job) =>
    pastGrace(job, now),
  );
  const otherGaps = youngest(queuedOther, coverage.uncoveredOther).filter((job) =>
    pastGrace(job, now),
  );
  const gaps = [...onDemandGaps, ...pinnedGaps, ...otherGaps].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  if (queuedPinned.length > 0) {
    // Logged rather than carried on the outcome: the memoised step's shape is
    // pinned (`reconcile-github-queue-v4`).
    console.warn('[ciRunnerReconcile] a job pinned to on-demand is queued', {
      org,
      queued: queuedPinned.length,
      idleOnDemandMachines: idlePinnedCapable,
      awaitingNotSpot: awaitingSplit.otherNotSpot,
      added: pinnedGaps.length,
    });
  }

  let added = 0;
  let addedOnDemand = 0;
  for (const job of gaps) {
    const repo = repos.find(
      (r) => repoKey(r.base.repoOwner, r.base.repoName) === repoKey(job.repoOwner, job.repoName),
    );
    if (!repo) continue;
    const intentId = await mintReconcileIntent(job, {
      ...repo.base,
      installationId: repo.base.installationId ?? installationId,
    });
    if (intentId === null) continue;
    added += 1;
    if (requestsOnDemandRunner(job.labels)) addedOnDemand += 1;
    // The ordinary boot path: `admit` is where the pool cap and the credit refusal
    // are decided, so a full pool defers this intent rather than exceeding it.
    await dispatchCiRunnerBoot(intentId, 'hot-path');
  }

  // A linked repo nobody can read is named only when something was left stranded
  // here: most such repos simply do not run on the fleet, and naming them on every
  // quiet tick would bury the one that does.
  const unreadableRepos = gaps.length > 0 ? unreadable : [];
  const outcome: ReconcileOrgOutcome = {
    org,
    queued: queued.length,
    idleRunners,
    awaiting,
    added,
    ...(skippedRuns.length > 0 ? { skippedRuns } : {}),
    ...(undelivered.size > 0 ? { undeliveredRepos: [...undelivered] } : {}),
    ...(unreadableRepos.length > 0 ? { unreadableRepos } : {}),
  };
  const onDemand: OnDemandCoverage = {
    queued: queuedOnDemand.length,
    idleRunners: idleOnDemand,
    awaiting: awaitingSplit.onDemand,
    added: addedOnDemand,
  };
  if (Object.values(onDemand).some((n) => n > 0)) outcome.onDemand = onDemand;
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
  reportBlindSpots(org, outcome);
  return outcome;
}

/**
 * How many jobs of each label-set partition have no runner coming (MOTIR-11727),
 * by the formula in the module header: the on-demand jobs are covered only by
 * on-demand capacity, and the ordinary jobs by ordinary capacity plus the
 * on-demand capacity the on-demand jobs leave over. Pure. Exported for the
 * arithmetic's own tests.
 */
export function coverPartitions(counts: {
  queuedOnDemand: number;
  queuedOther: number;
  idleOnDemand: number;
  idleOther: number;
  awaitingOnDemand: number;
  awaitingOther: number;
  /** Ordinary jobs pinned to on-demand capacity (MOTIR-11732), NOT in `queuedOther`. */
  queuedPinned?: number;
  /** The part of `idleOther` whose machine is on-demand (MOTIR-11732). */
  idlePinnedCapable?: number;
  /** The part of `awaitingOther` not known to be Spot (MOTIR-11732). */
  awaitingPinnedCapable?: number;
}): { uncoveredOnDemand: number; uncoveredOther: number; uncoveredPinned: number } {
  const onDemandCapacity = counts.idleOnDemand + counts.awaitingOnDemand;
  const uncoveredOnDemand = Math.max(0, counts.queuedOnDemand - onDemandCapacity);
  const surplus = Math.max(0, onDemandCapacity - counts.queuedOnDemand);

  // The pinned jobs take the ordinary capacity that is not Spot first, then the
  // on-demand surplus; neither can serve an ordinary job once it has.
  const queuedPinned = counts.queuedPinned ?? 0;
  const pinnedCapable = Math.min(
    (counts.idlePinnedCapable ?? 0) + (counts.awaitingPinnedCapable ?? 0),
    counts.idleOther + counts.awaitingOther,
  );
  const pinnedFromOrdinary = Math.min(queuedPinned, pinnedCapable);
  const pinnedFromSurplus = Math.min(queuedPinned - pinnedFromOrdinary, surplus);
  const uncoveredPinned = queuedPinned - pinnedFromOrdinary - pinnedFromSurplus;

  const uncoveredOther = Math.max(
    0,
    counts.queuedOther -
      (counts.idleOther + counts.awaitingOther - pinnedFromOrdinary) -
      (surplus - pinnedFromSurplus),
  );
  return { uncoveredOnDemand, uncoveredOther, uncoveredPinned };
}

/** The org's open on-demand pins (MOTIR-11732), or none when they cannot be
 *  read — the reconcile then counts as it did before pins existed. */
async function openPinsQuietly(org: string, now: Date): Promise<CiSpotRerunPin[]> {
  try {
    return await ciSpotRerunPinService.listOpenForOrg(org, now);
  } catch (err) {
    console.error('[ciRunnerReconcile] could not read the on-demand pins', {
      org,
      detail: err instanceof Error ? err.message : 'unknown',
    });
    return [];
  }
}

/** How many of these idle runners run on an on-demand machine (MOTIR-11732). */
async function countOnDemandMachines(runnerIds: number[]): Promise<number> {
  const capacity = await withSystemContext((tx) =>
    ciRunnerProvisioningIntentRepository.findCapacityByRunnerIds(runnerIds, tx),
  );
  return runnerIds.filter((id) => capacity.get(id) === 'on_demand').length;
}

/** The `count` youngest of `oldestFirst` — the ones no runner will reach. */
const youngest = (oldestFirst: QueuedFleetJob[], count: number) =>
  count > 0 ? oldestFirst.slice(oldestFirst.length - count) : [];

const pastGrace = (job: QueuedFleetJob, now: Date) =>
  now.getTime() - job.createdAt.getTime() > RECONCILE_GRACE_MS;

/**
 * Say so when the fleet is blind to part of an org (MOTIR-11437) — the stall this
 * card is about was silent. Logged, and raised to Sentry as a warning grouped per
 * org and kind, so it is one issue that keeps counting rather than a breadcrumb no
 * one reads.
 */
function reportBlindSpots(org: string, outcome: ReconcileOrgOutcome): void {
  if (outcome.undeliveredRepos) {
    const detail = { org, repos: outcome.undeliveredRepos };
    console.warn(
      '[ciRunnerReconcile] motir-runner jobs are queued in repos with no workflow_job deliveries — is the motir-studio App installed on them, and are its deliveries arriving?',
      detail,
    );
    Sentry.captureMessage(`CI fleet: motir-runner jobs with no workflow_job deliveries in ${org}`, {
      level: 'warning',
      fingerprint: ['ci-runner-reconcile', 'undelivered', org.toLowerCase()],
      extra: detail,
    });
  }
  if (outcome.unreadableRepos) {
    const detail = { org, repos: outcome.unreadableRepos };
    console.warn(
      '[ciRunnerReconcile] fleet jobs are stranded and the fleet cannot read these linked repos — is the motir-studio App installed on them?',
      detail,
    );
    Sentry.captureMessage(`CI fleet: stranded jobs and unreadable linked repos in ${org}`, {
      level: 'warning',
      fingerprint: ['ci-runner-reconcile', 'unreadable', org.toLowerCase()],
      extra: detail,
    });
  }
}

/** Mint the next reconcile generation of a job, or null when it is not ours to
 *  mint (a generation cap, or a racing sweep won the unique index). */
async function mintReconcileIntent(
  job: QueuedFleetJob,
  base: MintBase & { installationId: string },
): Promise<string | null> {
  try {
    return await withSystemContext(async (tx) => {
      const max = await ciRunnerProvisioningIntentRepository.maxReconcileGeneration(
        job.runId,
        job.runAttempt,
        job.jobId,
        tx,
      );
      // Never 0, even for a job no delivery recorded: generation 0 is what a
      // delivery writes, and the repo set reads it as "this repo's deliveries
      // arrive" (MOTIR-11460).
      const generation = Math.max(max + 1, 1);
      if (generation > MAX_RECONCILE_GENERATION_CEILING) return null;
      const unserved = await ciRunnerProvisioningIntentRepository.countUnservedReconcileGenerations(
        job.runId,
        job.runAttempt,
        job.jobId,
        tx,
      );
      if (unserved >= MAX_RECONCILE_GENERATION) return null;
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
          // A reconcile generation of a re-run job carries its Spot-interruption
          // count exactly as the delivery's intent does (MOTIR-11728).
          spotInterruptionCount:
            job.runAttempt > 1
              ? await ciRunnerProvisioningIntentRepository.findCarriedSpotInterruptions(
                  {
                    repoOwner: base.repoOwner,
                    repoName: base.repoName,
                    runId: job.runId,
                    jobName: job.jobName,
                    runAttempt: job.runAttempt,
                  },
                  tx,
                )
              : 0,
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
