import type {
  AgentInstance,
  AgentInstanceIntervalEndReason,
  AgentInstanceState,
  AgentRunLauncher,
  AgentSignInState,
  AgentTerminalServer,
  Prisma,
} from '@/generated/prisma/client';
import { RUNNING_STATES } from '@/lib/agentInstances/stateMachine';

// Single Prisma operations on `agent_instance` — one developer's long-lived
// agent machine and its home volume (Story MOTIR-6860 · MOTIR-6870,
// `docs/decisions/agent-instances.md` §4).
//
// ⚠️ EVERY METHOD TAKES `tx`, READS INCLUDED — the departure
// `dispatchRunRepository` makes, for its reason: every row is gated by an RLS
// policy on `app.workspace_id`, bound only on a transaction, and a read through
// the bare singleton returns an EMPTY LIST rather than failing. Requiring `tx`
// makes that a type error. The cross-tenant reads (the fleet-wide count, the
// sweep's discovery) run under `withSystemContext` against the table's
// `FOR SELECT` system arm; every write runs bound to the row's own workspace.
//
// No business logic, no transactions, no DTO mapping — the lifecycle service
// (MOTIR-6872) composes these.

/** The create payload, named here so callers above never spell a Prisma input type. */
export type AgentInstanceCreateInput = Prisma.AgentInstanceUncheckedCreateInput;

/** The persistent handle `provisionPersistent` returns (§1), as stored on the row. */
export interface AgentInstanceHandleColumns {
  flyApp: string;
  machineId: string;
  volumeId: string;
}

/**
 * Where an instance lives (MOTIR-9468): its fleet account and the zone of its
 * disk. Recorded once, at placement; an instance with none is on the
 * process-wide Fly app.
 */
export interface AgentInstancePlacement {
  fleetShardId: string;
  availabilityZone: string | null;
}

/** What a guarded transition may write beside the new state. */
/** The image-update columns a patch carries, only where the patch names them. */
function imagePatch(patch: AgentInstanceTransitionPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'imageDigest',
    'imageVersion',
    'targetImageDigest',
    'targetImageVersion',
    'updateFailureReason',
    'updateFailedAt',
  ] as const) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  return out;
}

export interface AgentInstanceTransitionPatch {
  /** `failed`'s reason in words; `null` clears it (a later wake). */
  failureReason?: string | null;
  /** Bump the idle signal in the same write (create and wake do). */
  lastActivityAt?: Date;
  /** Why a stop was begun (MOTIR-7406), with `→ hibernating`; `null` clears it. */
  hibernateReason?: AgentInstanceIntervalEndReason | null;
  /**
   * The image-update fields (`agent-image-update.md` Q6, MOTIR-6952), written in
   * the same guarded move as the state they belong to. `null` clears.
   */
  imageDigest?: string;
  imageVersion?: string | null;
  targetImageDigest?: string | null;
  targetImageVersion?: string | null;
  updateFailureReason?: string | null;
  updateFailedAt?: Date | null;
}

/** One page of the owner's list. */
export interface AgentInstanceOwnerPage {
  ownerId: string;
  /** Narrow to one project; omit for every project in the bound workspace. */
  projectId?: string | undefined;
  take: number;
  skip: number;
}

/** A live row — `deletedAt IS NULL` — the only rows any list or owner read returns. */
const LIVE = { deletedAt: null } as const;

/**
 * A probe's answer lands only while the row still runs that digest — or is
 * updating TO it (`agent-image-update.md` Q3): the update's liveness check reads
 * the new image's terminal server and run launcher before `imageDigest` moves.
 */
function pinsOrTargets(digest: string) {
  return { OR: [{ imageDigest: digest }, { targetImageDigest: digest }] };
}

export const agentInstanceRepository = {
  /** Insert an instance at `starting`. `tx` required — a write. */
  async create(
    data: AgentInstanceCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance> {
    return tx.agentInstance.create({ data });
  },

  /** A live instance by id, ONLY if `ownerId` owns it (§8 — no key opens another's). */
  async findLiveForOwner(
    id: string,
    ownerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance | null> {
    return tx.agentInstance.findFirst({ where: { id, ownerId, ...LIVE } });
  },

  /** An instance by id, deleted or not — the sweep's and the charge's read. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<AgentInstance | null> {
    return tx.agentInstance.findUnique({ where: { id } });
  },

  /** The owner's live instances, newest first, one page. */
  async listLiveForOwner(
    page: AgentInstanceOwnerPage,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({
      where: {
        ownerId: page.ownerId,
        ...(page.projectId ? { projectId: page.projectId } : {}),
        ...LIVE,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.take,
      skip: page.skip,
    });
  },

  /** The owner's live instance of exactly this name in the project — create's
   *  name-clash read, independent of how many agents the owner holds. */
  async findLiveForOwnerByName(
    where: { ownerId: string; projectId: string; name: string },
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance | null> {
    return tx.agentInstance.findFirst({
      where: { ownerId: where.ownerId, projectId: where.projectId, name: where.name, ...LIVE },
    });
  },

  /** The total behind {@link listLiveForOwner}, for the page's pagination. */
  async countLiveForOwner(
    page: Pick<AgentInstanceOwnerPage, 'ownerId' | 'projectId'>,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.agentInstance.count({
      where: {
        ownerId: page.ownerId,
        ...(page.projectId ? { projectId: page.projectId } : {}),
        ...LIVE,
      },
    });
  },

  /**
   * THE GUARDED TRANSITION (§4) — ONE conditional UPDATE that applies only while
   * the row is live and still in one of `from`. Returns how many rows moved: `1`
   * for the winner, `0` for a caller whose prior state was already stale. Two
   * concurrent callers from the same state therefore cannot both win: Postgres
   * re-evaluates the `WHERE` on the row the first one committed, and the second
   * finds it no longer matches.
   *
   * `stateChangedAt` is written by the same statement, so the timestamp can
   * never disagree with the state it dates.
   *
   * `expected.imageDigest` narrows the guard to the image the caller read as
   * well (MOTIR-7340): a state alone cannot tell `running` before an update from
   * `running` after one that already settled.
   */
  async transition(
    id: string,
    from: readonly AgentInstanceState[],
    to: AgentInstanceState,
    at: Date,
    patch: AgentInstanceTransitionPatch,
    tx: Prisma.TransactionClient,
    expected: { imageDigest?: string } = {},
  ): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: {
        id,
        state: { in: [...from] },
        ...(expected.imageDigest !== undefined ? { imageDigest: expected.imageDigest } : {}),
        ...LIVE,
      },
      data: {
        state: to,
        stateChangedAt: at,
        ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
        ...(patch.lastActivityAt ? { lastActivityAt: patch.lastActivityAt } : {}),
        ...(patch.hibernateReason !== undefined ? { hibernateReason: patch.hibernateReason } : {}),
        ...imagePatch(patch),
      },
    });
    return result.count;
  },

  /**
   * Write image-update fields WITHOUT a state move, guarded on the state the
   * caller read (MOTIR-6952): Update on a hibernated agent pins its target, and a
   * rollback records its reason while the agent stays `updating`. `tx` required.
   */
  async patchImage(
    id: string,
    inStates: readonly AgentInstanceState[],
    patch: AgentInstanceTransitionPatch,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, state: { in: [...inStates] }, ...LIVE },
      data: imagePatch(patch),
    });
    return result.count;
  },

  /** Record the persistent handle once `provisionPersistent` answers. `tx` required. */
  async setHandle(
    id: string,
    handle: AgentInstanceHandleColumns,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, ...LIVE },
      data: handle,
    });
    return result.count;
  },

  /**
   * Record the account and zone the instance was placed in — ONCE. The update is
   * guarded on `fleetShardId IS NULL`, so a second placement, or a racer that
   * lost, changes nothing and answers `applied: false`: the disk lives in one
   * account and one zone for the instance's life. `tx` required.
   */
  async recordPlacement(
    id: string,
    placement: AgentInstancePlacement,
    tx: Prisma.TransactionClient,
  ): Promise<{ applied: boolean }> {
    const result = await tx.agentInstance.updateMany({
      where: { id, fleetShardId: null },
      data: placement,
    });
    return { applied: result.count === 1 };
  },

  /**
   * Release a RESERVED placement whose provision was refused (Story MOTIR-9361 ·
   * MOTIR-9471) — legal only while the row has no machine, so a placement that
   * already holds a disk can never be released. Answers how many rows changed
   * (0 or 1). `tx` required.
   */
  async releasePlacement(
    id: string,
    fleetShardId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, fleetShardId, machineId: null },
      data: { fleetShardId: null, availabilityZone: null },
    });
    return result.count;
  },

  /**
   * Write the handle, and the account's region, beside the placement that
   * reserved it (MOTIR-9471, MOTIR-9472) — only
   * while the row is live, still placed on `fleetShardId` and has no machine yet.
   * `applied: false` means the placement is no longer this call's: what it
   * provisioned must be destroyed. `tx` required.
   */
  async setPlacedHandle(
    id: string,
    fleetShardId: string,
    handle: AgentInstanceHandleColumns & { region: string },
    tx: Prisma.TransactionClient,
  ): Promise<{ applied: boolean }> {
    const result = await tx.agentInstance.updateMany({
      where: { id, fleetShardId, machineId: null, ...LIVE },
      data: handle,
    });
    return { applied: result.count === 1 };
  },

  /**
   * How many live instances one account holds — reserved, running or asleep
   * (MOTIR-9471): admission's per-account in-flight count for the agent hoster.
   * A sleeping instance counts, because its wake comes back to the same account
   * and never chooses. `tx` required.
   */
  async countLiveOnFleetShard(fleetShardId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.agentInstance.count({ where: { fleetShardId, ...LIVE } });
  },

  /**
   * Every record in one fleet account, live AND deleted — the reconciler and the
   * headroom reading count an account's instances. An instance with no account
   * (the process-wide Fly app) is in no account's list. `tx` required.
   */
  async listByFleetShard(
    fleetShardId: string,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({ where: { fleetShardId }, orderBy: { createdAt: 'asc' } });
  },

  /** Bump the idle signal (§2) — later stories' relay and runs call it. `tx` required. */
  async touchActivity(id: string, at: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, ...LIVE },
      data: { lastActivityAt: at },
    });
    return result.count;
  },

  /**
   * Bump the idle signal ONLY IF it is older than `staleBefore` — the run-event
   * bump, at most once a minute (`agent-instance-run.md` §6). The guard is the
   * WHERE clause, so concurrent events move it once. `tx` required.
   */
  async touchActivityIfStale(
    id: string,
    at: Date,
    staleBefore: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, ...LIVE, lastActivityAt: { lt: staleBefore } },
      data: { lastActivityAt: at },
    });
    return result.count;
  },

  /**
   * Record the terminal-server probe (`agent-terminal.md` Q8): whether the image
   * `digest` serves a terminal. Guarded on the digest the row still pins (or is
   * updating to — {@link pinsOrTargets}), so a probe that raced an image move can
   * never stamp the new digest with the old image's answer. `tx` required.
   */
  async recordTerminalServer(
    id: string,
    probe: { terminalServer: AgentTerminalServer; digest: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, ...pinsOrTargets(probe.digest), ...LIVE },
      data: { terminalServer: probe.terminalServer, terminalServerDigest: probe.digest },
    });
    return result.count;
  },

  /**
   * Record the run-launcher probe (`agent-instance-run.md` §4, MOTIR-7026):
   * whether the image `digest` can start a card's run. Guarded on the digest the
   * row still pins, as {@link recordTerminalServer} is. `tx` required.
   */
  async recordRunLauncher(
    id: string,
    probe: { runLauncher: AgentRunLauncher; digest: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, ...pinsOrTargets(probe.digest), ...LIVE },
      data: { runLauncher: probe.runLauncher, runLauncherDigest: probe.digest },
    });
    return result.count;
  },

  /**
   * Record the coding agent's sign-in as the terminal server answered it (§4),
   * and when. `tx` required.
   */
  async recordSignIn(
    id: string,
    probe: { signInState: AgentSignInState; at: Date },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, ...LIVE },
      data: { signInState: probe.signInState, signInCheckedAt: probe.at },
    });
    return result.count;
  },

  /**
   * The end of `deleting` (§4): stamp `deletedAt`, only from `deleting`, so a
   * row that never passed through the guard cannot be hidden from its owner.
   */
  async markDeleted(id: string, at: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.agentInstance.updateMany({
      where: { id, state: 'deleting', ...LIVE },
      data: { deletedAt: at },
    });
    return result.count;
  },

  /**
   * Running instances for §6's caps — every live row in {@link RUNNING_STATES},
   * narrowed to one organisation when given. The fleet-wide count spans tenants
   * and runs under `withSystemContext`.
   */
  async countRunning(
    scope: { organizationId?: string | undefined },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.agentInstance.count({
      where: {
        state: { in: [...RUNNING_STATES] },
        ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
        ...LIVE,
      },
    });
  },

  /**
   * The org's running cap count (MOTIR-9374): its instances in a running state,
   * UNION the instances it holds a fleet slot for (`admittingIds`) whose row has
   * not moved yet — a create whose row is not inserted, or a wake still
   * `hibernated`. ONE statement, so a racer that moves its row between two reads
   * can be neither missed nor counted twice; two wakes one below the figure
   * cannot both pass the guard that holds the fleet admission lock.
   */
  async countRunningOrAdmitting(
    organizationId: string,
    admittingIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const states = [...RUNNING_STATES];
    const rows = await tx.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS "n" FROM (
        SELECT "id" FROM "agent_instance"
        WHERE "organization_id" = ${organizationId}
          AND "deleted_at" IS NULL
          AND "state"::text = ANY(${states}::text[])
        UNION
        SELECT unnest(${admittingIds}::text[])
      ) AS "counted"
    `;
    return rows[0]?.n ?? 0;
  },

  /** Live instances a user holds in ANY project — §6's per-user cap. */
  async countLiveForOwnerEverywhere(
    ownerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.agentInstance.count({ where: { ownerId, ...LIVE } });
  },

  /** Live instances in any of `states`, oldest state change first — the sweep's discovery. */
  async listLiveInStates(
    states: readonly AgentInstanceState[],
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({
      where: { state: { in: [...states] }, ...LIVE },
      orderBy: [{ stateChangedAt: 'asc' }, { id: 'asc' }],
      take,
    });
  },

  /**
   * Every instance that EXISTED at some moment in `[from, to)` — the daily storage
   * charge's discovery (`agent-instance-storage.md` §2), across tenants, so it runs
   * under `withSystemContext`. Existed means created before `to` and either deleted
   * at or after `from`, or not deleted and not mid-delete: a row still `deleting`
   * with no `deletedAt` is left for the pass after its delete completes, which
   * charges it through `deletedAt` for every day it stood.
   */
  async listExistedBetween(
    from: Date,
    to: Date,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({
      where: {
        createdAt: { lt: to },
        OR: [{ deletedAt: { gte: from } }, { deletedAt: null, state: { not: 'deleting' } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * Every live record in one instance app — the reconcile's "who owns this
   * machine / volume" read. Deleted rows are excluded, so a machine or volume
   * that only a deleted record names is an orphan.
   */
  async listLiveInApp(app: string, tx: Prisma.TransactionClient): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({ where: { flyApp: app, ...LIVE } });
  },

  /**
   * The record — live OR deleted — that names this machine in this app: the
   * attribution reconciler's read (MOTIR-6925). A deleted row still answers, so
   * a machine that outlived its instance is told apart from one no record ever
   * named. The newest wins when a machine id was somehow reused.
   */
  async findByMachine(
    app: string,
    machineId: string,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance | null> {
    return tx.agentInstance.findFirst({
      where: { flyApp: app, machineId },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Every instance app any record (live or deleted) has ever named — the
   * reconcile walks each one. Distinct, sorted for a stable pass.
   */
  async listDistinctApps(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.agentInstance.findMany({
      where: { flyApp: { not: null } },
      distinct: ['flyApp'],
      select: { flyApp: true },
      orderBy: { flyApp: 'asc' },
    });
    // The `where` already excludes null; the narrowing is for the type, not the data.
    /* v8 ignore next */
    return rows.flatMap((r) => (r.flyApp ? [r.flyApp] : []));
  },
  // ── The plan-lapse deletion (MOTIR-6921, `agent-instance-storage.md` §4) ──

  /** An org's live instances — the lapse schedules and clears them (a system read). */
  async listLiveForOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({
      where: { organizationId, ...LIVE },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Schedule the bound workspace's live instances of one org for deletion at
   * `at`. Only rows not already scheduled — a repeated lapse keeps its date.
   */
  async scheduleDeletion(
    organizationId: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.agentInstance.updateMany({
      where: { organizationId, scheduledDeletionAt: null, ...LIVE },
      data: { scheduledDeletionAt: at },
    });
    return count;
  },

  /** Clear the bound workspace's schedule for one org — the plan was renewed. */
  async clearScheduledDeletion(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.agentInstance.updateMany({
      where: { organizationId, scheduledDeletionAt: { not: null } },
      data: { scheduledDeletionAt: null, deletionNoticedAt: null },
    });
    return count;
  },

  /** Record that the owner was told — only a row still scheduled and not yet told. */
  async markDeletionNoticed(
    ids: readonly string[],
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.agentInstance.updateMany({
      where: { id: { in: [...ids] }, scheduledDeletionAt: { not: null }, deletionNoticedAt: null },
      data: { deletionNoticedAt: at },
    });
    return count;
  },

  /** Live, scheduled instances whose owner has not been told yet (a system read). */
  async listScheduledUnnoticed(
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({
      where: { scheduledDeletionAt: { not: null }, deletionNoticedAt: null, ...LIVE },
      orderBy: { scheduledDeletionAt: 'asc' },
      take,
    });
  },

  /** Live instances whose deletion date has passed, oldest first (a system read). */
  async listDueForDeletion(
    now: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstance[]> {
    return tx.agentInstance.findMany({
      where: { scheduledDeletionAt: { lte: now }, ...LIVE },
      orderBy: { scheduledDeletionAt: 'asc' },
      take,
    });
  },
};
