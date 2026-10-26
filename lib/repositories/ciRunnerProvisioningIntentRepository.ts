import {
  type CiRunnerProvisioningIntent,
  type FleetShardMoveReason,
  type Prisma,
} from '@/generated/prisma/client';

// Data access for the runner-fleet provisioning INTENTS (Story MOTIR-1916 ·
// MOTIR-1920). Single-op methods only (CLAUDE.md 4-layer); every write requires
// a `tx`, and the reads that guard a write take one too.

/** The intent lifecycle. MOTIR-1920 only ever writes `pending`; the transitions
 *  out of it belong to the provisioner (MOTIR-1921) and the gate (MOTIR-1922),
 *  which extend this vocabulary rather than migrate an enum. */
export const CI_RUNNER_INTENT_PENDING = 'pending';
/** CLAIMED by a provisioner: the JIT config is being minted and a container
 *  booted. The claim itself is what this status IS — see {@link claimPending}. */
export const CI_RUNNER_INTENT_PROVISIONING = 'provisioning';
/** The container is up and holding a registered runner. The state the reaper
 *  ages containers out of. */
export const CI_RUNNER_INTENT_RUNNING = 'running';
/** Terminal: the container ran and was torn down. */
export const CI_RUNNER_INTENT_COMPLETED = 'completed';
/** Terminal: no runner ever served this job, and nothing is still running for
 *  it. `teardownReason` says which path got here. */
export const CI_RUNNER_INTENT_FAILED = 'failed';

/** The statuses that mean "a container may still exist for this intent" — the
 *  reaper's and the in-flight count's window. */
export const CI_RUNNER_INTENT_IN_FLIGHT: readonly string[] = [
  CI_RUNNER_INTENT_PROVISIONING,
  CI_RUNNER_INTENT_RUNNING,
];

/** What a provisioner records once the container is up. */
export interface CiRunnerBootRecord {
  containerProvider: string;
  containerId: string;
  containerRegion: string;
  githubRunnerId: number | null;
  runnerName: string | null;
  bootedAt: Date;
  /** The fleet account the container was booted in (MOTIR-8964); null or
   *  absent = the process-wide fleet. */
  fleetShardId?: string | null;
}

/** What a provisioner records once the container is gone. */
export interface CiRunnerSettleRecord {
  status: string;
  teardownReason: string | null;
  settledAt: Date;
  failureDetail: string | null;
  startedAt?: Date | null;
  bootLatencyMs?: number | null;
}

export interface CiRunnerProvisioningIntentCreateInput {
  workspaceId: string;
  organizationId: string;
  projectId: string | null;
  githubRepoId: string | null;
  installationId: string;
  runId: string;
  runAttempt: number;
  jobId: string;
  jobName: string | null;
  workflowName: string | null;
  repoOwner: string;
  repoName: string;
  requestedLabels: string[];
  queuedAt: Date;
  /** 0 for the intent a delivery records; N+1 for a reconcile (MOTIR-8976). */
  reconcileGeneration?: number;
}

export const ciRunnerProvisioningIntentRepository = {
  /**
   * Record one queued job as a pending provisioning intent. The
   * `(run_id, run_attempt, job_id)` unique index is the real idempotency guard —
   * a webhook redelivery raises P2002 here, which the service translates to a
   * `duplicate` outcome. A RE-RUN (a new attempt) and every sibling job of the
   * same run each insert their own row, because each needs its own ephemeral
   * runner.
   */
  async create(
    data: CiRunnerProvisioningIntentCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent> {
    return tx.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: data.workspaceId,
        organizationId: data.organizationId,
        projectId: data.projectId,
        githubRepoId: data.githubRepoId,
        installationId: data.installationId,
        runId: data.runId,
        runAttempt: data.runAttempt,
        jobId: data.jobId,
        jobName: data.jobName,
        workflowName: data.workflowName,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        requestedLabels: data.requestedLabels,
        queuedAt: data.queuedAt,
        reconcileGeneration: data.reconcileGeneration ?? 0,
        status: CI_RUNNER_INTENT_PENDING,
      },
    });
  },

  /**
   * The intent for one job of one run attempt, if it exists — the cheap
   * redelivery pre-check. NOT the correctness guard: two concurrent deliveries
   * would both miss it, and the unique index above is what guarantees once.
   */
  async findByJobKey(
    runId: string,
    runAttempt: number,
    jobId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent | null> {
    return tx.ciRunnerProvisioningIntent.findUnique({
      where: {
        runId_runAttempt_jobId_reconcileGeneration: {
          runId,
          runAttempt,
          jobId,
          reconcileGeneration: 0,
        },
      },
    });
  },

  /**
   * The highest reconcile generation recorded for one job of one run attempt, or
   * -1 when it has no intent at all (MOTIR-8976). The next reconcile writes this
   * plus one; two sweeps that read the same value collide on the unique index.
   */
  async maxReconcileGeneration(
    runId: string,
    runAttempt: number,
    jobId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.ciRunnerProvisioningIntent.aggregate({
      where: { runId, runAttempt, jobId },
      _max: { reconcileGeneration: true },
    });
    return r._max.reconcileGeneration ?? -1;
  },

  /**
   * The newest intent of each repository the fleet served since `since` — the
   * reconcile sweep's list of where to ask GitHub what is queued, and the
   * attribution (workspace, org, project) a reconcile intent copies (MOTIR-8976).
   */
  async listLatestPerRepoSince(
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent[]> {
    return tx.ciRunnerProvisioningIntent.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      distinct: ['repoOwner', 'repoName'],
    });
  },

  /**
   * Intents of one GitHub org that already stand for a runner that is not yet
   * visible as an idle runner there: `pending` (awaiting admission or dispatch)
   * and `provisioning` (booting). Owner compared case-insensitively, as GitHub
   * logins are (MOTIR-8976).
   */
  async countAwaitingRunnerForOwner(owner: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.ciRunnerProvisioningIntent.count({
      where: {
        repoOwner: { equals: owner, mode: 'insensitive' },
        status: { in: [CI_RUNNER_INTENT_PENDING, CI_RUNNER_INTENT_PROVISIONING] },
      },
    });
  },

  /**
   * The oldest intents still awaiting a runner — the provisioner's (MOTIR-1921)
   * work queue, and the read that makes this table a seam rather than a
   * write-only log. Oldest-first by the job's own QUEUE time, not by insertion:
   * a redelivered or delayed webhook must not let a fresh job jump ahead of one
   * GitHub has already been holding.
   */
  async listPending(
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent[]> {
    return tx.ciRunnerProvisioningIntent.findMany({
      where: { status: CI_RUNNER_INTENT_PENDING },
      orderBy: { queuedAt: 'asc' },
      take: limit,
    });
  },

  /**
   * The oldest intent still awaiting a runner FOR ONE PROJECT — the read behind
   * the admission WAKE (MOTIR-2852).
   *
   * Scoped to a project, the wake's cheapest useful guess: the freed slot is the
   * ORG's (MOTIR-6907), so a completion in project A may also let the org's
   * project B boot — that one is left to the provisioning sweep. Ordered by `queuedAt`
   * exactly as {@link listPending} is, and for the same reason — the slot goes to
   * the job GitHub has been holding longest, not to whichever row was written
   * last.
   *
   * ⚠️ IT DOES NOT CLAIM. The row it returns is still `pending` and may be
   * claimed by the sweep, by the webhook's hot path, or by another wake before
   * the boot this feeds ever runs. {@link claimPending}'s compare-and-set is what
   * decides, and a wake that loses resolves as `already_claimed` with no second
   * container.
   */
  async findNextPendingForProject(
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent | null> {
    return tx.ciRunnerProvisioningIntent.findFirst({
      where: { projectId, status: CI_RUNNER_INTENT_PENDING },
      orderBy: { queuedAt: 'asc' },
    });
  },

  /** One intent by id, whatever its status. */
  async findById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent | null> {
    return tx.ciRunnerProvisioningIntent.findUnique({ where: { id } });
  },

  /**
   * CLAIM a pending intent — an atomic compare-and-set from `pending` to
   * `provisioning`, returning whether THIS caller won.
   *
   * ⚠️ THE `status: PENDING` PREDICATE IS THE CONCURRENCY GUARD, not decoration.
   * Two sweeps overlapping — a slow one still running when the next fires, or two
   * instances behind a load balancer — would otherwise both read the same pending
   * intent and both boot a runner for it. The second runner has no job to claim
   * (GitHub hands the job to whichever registers first) and would idle until its
   * timeout, billing the tenant's org for a container that did nothing. Postgres
   * evaluates the predicate under the row lock `UPDATE` takes, so exactly one
   * caller sees `count === 1`.
   *
   * A conditional UPDATE rather than `SELECT … FOR UPDATE` + write: there is
   * nothing to read between the two, so the compare-and-set is both shorter and
   * strictly harder to get wrong — no transaction has to be held open across the
   * GitHub and provider calls that follow.
   */
  async claimPending(
    id: string,
    tx: Prisma.TransactionClient,
    placement: { fleetShardId?: string | null } = {},
  ): Promise<boolean> {
    const result = await tx.ciRunnerProvisioningIntent.updateMany({
      where: { id, status: CI_RUNNER_INTENT_PENDING },
      // The ACCOUNT is written in the same compare-and-set (MOTIR-8968): the
      // per-account count is read-derived, so it is exact only if the account
      // lands in the transaction that counted it.
      data: {
        status: CI_RUNNER_INTENT_PROVISIONING,
        fleetShardId: placement.fleetShardId ?? null,
        fleetShardMoveReason: null,
        // A booted job is not waiting (MOTIR-9666): cleared in the same
        // compare-and-set, so no reader ever sees a claimed intent with a reason.
        waitingReason: null,
        waitingSince: null,
      },
    });
    return result.count === 1;
  },

  /** The CI containers in flight on one account — `provisioning` + `running`,
   *  the same in-flight set as `FLEET_WORKLOADS.ci_runner` (MOTIR-8968). */
  async countInFlightForShardInTx(shardId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.ciRunnerProvisioningIntent.count({
      where: {
        fleetShardId: shardId,
        status: { in: [CI_RUNNER_INTENT_PROVISIONING, CI_RUNNER_INTENT_RUNNING] },
      },
    });
  },

  /** Move a claimed intent to another account mid-boot, with why it left its
   *  first choice (MOTIR-8968). Guarded on `provisioning`. */
  async reassignShardInTx(
    id: string,
    fleetShardId: string,
    moveReason: FleetShardMoveReason,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.ciRunnerProvisioningIntent.updateMany({
      where: { id, status: CI_RUNNER_INTENT_PROVISIONING },
      data: { fleetShardId, fleetShardMoveReason: moveReason },
    });
    return result.count === 1;
  },

  /** Stamp the intent's FIRST `shard_capacity` deferral; a later one leaves it
   *  (MOTIR-8968). */
  async markShardCapacityDeferredInTx(
    id: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciRunnerProvisioningIntent.updateMany({
      where: { id, shardCapacityDeferredAt: null },
      data: { shardCapacityDeferredAt: at },
    });
  },

  /** Record why a PENDING intent waits now (MOTIR-9666) — the reason the
   *  admission gate gave it on its latest pass. CURRENT, unlike
   *  {@link markShardCapacityDeferredInTx}: written only when the reason CHANGED,
   *  so a job waiting an hour under one reason is one write and `waitingSince`
   *  keeps the instant that reason was first given. Guarded on `pending`, so a
   *  claim that won the race is never marked waiting. */
  async recordWaitingReasonInTx(
    id: string,
    reason: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.ciRunnerProvisioningIntent.updateMany({
      where: {
        id,
        status: CI_RUNNER_INTENT_PENDING,
        OR: [{ waitingReason: null }, { waitingReason: { not: reason } }],
      },
      data: { waitingReason: reason, waitingSince: at },
    });
    return result.count === 1;
  },

  /**
   * The inverse of {@link claimPending} — hand a claimed slot back to the pending
   * pool, for a refusal about the ENVIRONMENT (unconfigured, rate-limited) or one
   * the admission gate makes AFTER taking the slot (`ci_credits_exhausted`).
   *
   * Guarded on `status = provisioning` for the same reason the claim is guarded
   * on `pending`: this must never resurrect an intent that has since booted or
   * settled. `settledAt` is cleared because a row going back into the queue has
   * not settled — leaving a stale instant there would make a re-queued intent
   * read, in the table and in every report over it, as one that already finished.
   */
  async releaseClaim(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const result = await tx.ciRunnerProvisioningIntent.updateMany({
      where: { id, status: CI_RUNNER_INTENT_PROVISIONING },
      // The account goes with the claim, so a re-admission chooses again.
      data: {
        status: CI_RUNNER_INTENT_PENDING,
        settledAt: null,
        teardownReason: null,
        fleetShardId: null,
        fleetShardMoveReason: null,
      },
    });
    return result.count === 1;
  },

  /**
   * {@link releaseClaim} for a boot that FAILED transiently (MOTIR-8941): the
   * intent goes back to `pending` and the attempt is counted, so the bound on
   * retries survives the process. Same `provisioning` guard as the plain release.
   */
  async releaseClaimForRetry(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const result = await tx.ciRunnerProvisioningIntent.updateMany({
      where: { id, status: CI_RUNNER_INTENT_PROVISIONING },
      data: {
        status: CI_RUNNER_INTENT_PENDING,
        settledAt: null,
        teardownReason: null,
        fleetShardId: null,
        fleetShardMoveReason: null,
        bootAttempts: { increment: 1 },
      },
    });
    return result.count === 1;
  },

  /**
   * Record the GitHub runner a JIT mint just registered — BEFORE the container
   * exists.
   *
   * ⚠️ THE ORDERING IS THE POINT, not an implementation detail. §7.4's verified
   * finding is that `generate-jitconfig` registers the runner at MINT time: the
   * `201` returns a runner row before any container is created. So between the
   * mint and the boot there is a window in which GitHub holds a registered runner
   * and Motir holds nothing — and a crash in that window leaves a dangling
   * registered runner NOBODY CAN NAME, because the only id was in the dead
   * process's memory. Writing the id first closes it: the stale-claim sweep reads
   * this column and de-registers.
   */
  async recordMintedRunner(
    id: string,
    data: { githubRunnerId: number; runnerName: string },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciRunnerProvisioningIntent.update({
      where: { id },
      data: { githubRunnerId: data.githubRunnerId, runnerName: data.runnerName },
    });
  },

  /**
   * Intents CLAIMED but never booted, older than `claimedBefore` — the
   * stale-claim sweep's read.
   *
   * These are the crash-in-the-window rows above: status `provisioning`, no
   * container. They are found by `updatedAt` because the claim is the last thing
   * that touched them, and they carry the `githubRunnerId` that has to be
   * de-registered.
   */
  async listStaleClaims(
    claimedBefore: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent[]> {
    return tx.ciRunnerProvisioningIntent.findMany({
      where: {
        status: CI_RUNNER_INTENT_PROVISIONING,
        containerId: null,
        updatedAt: { lt: claimedBefore },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  },

  /**
   * In-flight intents that booted a container before `bootedBefore` — past their
   * own end, so a container they still own has outlived the job timeout. The
   * attribution reconciler reaches an intent only THROUGH a listed machine, so
   * one whose machine is already gone is found here instead (MOTIR-9347).
   */
  async listInFlightBootedBefore(
    bootedBefore: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent[]> {
    return tx.ciRunnerProvisioningIntent.findMany({
      where: {
        status: { in: [...CI_RUNNER_INTENT_IN_FLIGHT] },
        containerId: { not: null },
        bootedAt: { lt: bootedBefore },
      },
      orderBy: { bootedAt: 'asc' },
      take: limit,
    });
  },

  /** Record the container this intent booted, and flip it to `running`. Written
   *  as ONE statement so a handle never exists without the status that tells the
   *  reaper to watch it. */
  async recordBoot(
    id: string,
    data: CiRunnerBootRecord,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciRunnerProvisioningIntent.update({
      where: { id },
      data: {
        status: CI_RUNNER_INTENT_RUNNING,
        containerProvider: data.containerProvider,
        containerId: data.containerId,
        containerRegion: data.containerRegion,
        githubRunnerId: data.githubRunnerId,
        runnerName: data.runnerName,
        bootedAt: data.bootedAt,
        fleetShardId: data.fleetShardId ?? null,
      },
    });
  },

  /** Record when the container was observed running, and the boot latency that
   *  implies — ADR §6's budget made measurable. */
  async recordStarted(
    id: string,
    startedAt: Date,
    bootLatencyMs: number,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciRunnerProvisioningIntent.update({
      where: { id },
      data: { startedAt, bootLatencyMs },
    });
  },

  /**
   * Move an intent to a terminal status with the reason it got there.
   *
   * ⚠️ THE FIRST SETTLE WINS (MOTIR-6908). An intent already `completed` or
   * `failed` is left as it is, and the answer is `false`. Two paths can reach the
   * same intent: an org STOP settles it with `credits_exhausted` / `admin_stop`
   * while its supervisor is still polling, and the supervisor's own settle a
   * moment later must not overwrite why the container really ended.
   */
  async settle(
    id: string,
    data: CiRunnerSettleRecord,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.ciRunnerProvisioningIntent.updateMany({
      where: {
        id,
        status: { notIn: [CI_RUNNER_INTENT_COMPLETED, CI_RUNNER_INTENT_FAILED] },
      },
      data: {
        status: data.status,
        teardownReason: data.teardownReason,
        settledAt: data.settledAt,
        failureDetail: data.failureDetail,
        ...(data.startedAt === undefined ? {} : { startedAt: data.startedAt }),
        ...(data.bootLatencyMs === undefined ? {} : { bootLatencyMs: data.bootLatencyMs }),
      },
    });
    return count === 1;
  },

  /**
   * Intents still holding a container — the REAPER's read, and the read that
   * recovers attribution for a container the provider reports.
   *
   * Keyed on `containerId` rather than on the intent id because the reaper starts
   * from what the PROVIDER says exists, which is the only source that is still
   * right after the orchestrator has crashed.
   */
  async findByContainerId(
    provider: string,
    containerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent | null> {
    return tx.ciRunnerProvisioningIntent.findFirst({
      where: { containerProvider: provider, containerId },
    });
  },

  /**
   * How many runners are IN FLIGHT for one ORGANISATION — the `ci_runner` term of
   * the org's pool (MOTIR-6907, `docs/decisions/fleet-per-org-pool.md` §2).
   *
   * ⚠️ Read UNDER THE FLEET ADMISSION LOCK and inside the same transaction as the
   * claim it guards, never on its own: it is the read half of a read-derived
   * write, and a count taken outside the lock is a snapshot two racers can both
   * act on. See `ciFleetAdmissionLockRepository.lockScope`.
   *
   * "In flight" is `provisioning` + `running` — the same window the reaper uses,
   * and the reason completion frees a slot with no extra bookkeeping: settling an
   * intent to `completed`/`failed` drops it out of this set in the same write
   * that ends the container. Rides `[organization_id, status]`.
   */
  async countInFlightForOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.ciRunnerProvisioningIntent.count({
      where: { organizationId, status: { in: [...CI_RUNNER_INTENT_IN_FLIGHT] } },
    });
  },

  /**
   * Every intent ONE ORGANISATION has in flight — the input of an org STOP
   * (MOTIR-6908, `fleetStopService.stopOrganization`). Unbounded on purpose: the
   * org's pool bounds it (500 by default), and a stop that tore down only the
   * first page would leave the rest running on a zero balance. Rides
   * `[organization_id, status]`.
   */
  async listInFlightForOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent[]> {
    return tx.ciRunnerProvisioningIntent.findMany({
      where: { organizationId, status: { in: [...CI_RUNNER_INTENT_IN_FLIGHT] } },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Every CI container whose JOB HAS STARTED and has not settled — the input of
   * the live charge (MOTIR-6910). A container still booting has run nothing
   * GitHub would bill, so it accrues nothing yet. Rides `[status, bootedAt]`.
   */
  async listStartedInFlight(tx: Prisma.TransactionClient): Promise<CiRunnerProvisioningIntent[]> {
    return tx.ciRunnerProvisioningIntent.findMany({
      where: { status: { in: [...CI_RUNNER_INTENT_IN_FLIGHT] }, startedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Lock ONE intent for the live charge's read-derived write (MOTIR-6910) and
   * re-read what the decision needs. `FOR UPDATE`, because two ticks that
   * overlap (a slow one and the next) would otherwise both read the same
   * checkpoint and both add the minutes since it. Null when the row is gone.
   */
  async lockForAccrual(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ status: string; startedAt: Date | null } | null> {
    const rows = await tx.$queryRaw<{ status: string; started_at: Date | null }[]>`
      SELECT "status", "started_at" FROM "ci_runner_provisioning_intent"
      WHERE "id" = ${id}
      FOR UPDATE
    `;
    const row = rows[0];
    return row ? { status: row.status, startedAt: row.started_at } : null;
  },

  /**
   * How many CI RUNNERS are in flight across the whole fleet — the `ci_runner`
   * term of the fleet-wide census (`fleetCeilingService.census`).
   *
   * Since MOTIR-6907 no admission decides on this number: capacity is the
   * ORGANISATION's pool ({@link countInFlightForOrganization}), and the
   * fleet-wide total is an operator's reading, not a limit. Read the census from
   * `lib/ciFleet/workloads.ts`, where this is registered as `ci_runner`.
   */
  async countInFlightFleetWide(tx: Prisma.TransactionClient): Promise<number> {
    return tx.ciRunnerProvisioningIntent.count({
      where: { status: { in: [...CI_RUNNER_INTENT_IN_FLIGHT] } },
    });
  },

  /**
   * The DISTINCT organisations holding at least one intent in flight — the CI
   * term of the fleet monitor's "who is running anything" (MOTIR-7316). Ids only,
   * never the rows. Rides `[organization_id, status]`.
   */
  async listOrganizationsInFlight(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.ciRunnerProvisioningIntent.findMany({
      where: { status: { in: [...CI_RUNNER_INTENT_IN_FLIGHT] } },
      distinct: ['organizationId'],
      select: { organizationId: true },
    });
    return rows.map((row) => row.organizationId);
  },

  /**
   * How many of one organisation's intents SETTLED at or after `since` — the
   * fleet monitor's "was any CI running in the window" for an org with nothing
   * in flight now (MOTIR-7316).
   */
  async countSettledForOrganizationSince(
    organizationId: string,
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.ciRunnerProvisioningIntent.count({
      where: { organizationId, settledAt: { gte: since } },
    });
  },

  /** Every intent whose container is still supposed to be alive. Used to settle
   *  the rows a reap destroyed, so the table cannot keep claiming a container
   *  exists after the sweeper has removed it. */
  async listInFlight(
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent[]> {
    return tx.ciRunnerProvisioningIntent.findMany({
      where: { status: { in: [...CI_RUNNER_INTENT_IN_FLIGHT] } },
      orderBy: { bootedAt: 'asc' },
      take: limit,
    });
  },
};
