import { randomUUID } from 'node:crypto';
import type { FleetInFlightSlot, Prisma } from '@/generated/prisma/client';

// Data access for the FLEET IN-FLIGHT SLOTS (Story MOTIR-1916 · MOTIR-1997) —
// one row per container held by a workload that does not own a table of its own.
// Single-op methods only (CLAUDE.md 4-layer); every write requires a `tx`, and
// the count that guards a write takes one too.
//
// The decision these rows serve lives in `fleetCeilingService`; the registry
// that says WHICH workloads count from here lives in `lib/ciFleet/workloads.ts`.
// Nothing in this file knows what a ceiling is.

export interface FleetInFlightSlotTakeInput {
  /** A `FleetWorkloadKind`. Typed as the string the column holds, because a
   *  repository does not import the policy layer that names them. */
  workload: string;
  /** The workload's own id for the thing holding the container. */
  ref: string;
  /** WHICH RUN is taking it (MOTIR-2160) — the workload's own identifier for the
   *  dispatch, stamped so a later admission can tell this holder apart from a
   *  second run asking for the same `ref`, and so a release can be refused unless
   *  it owns the row. Omit it to keep the pre-MOTIR-2160 behaviour. */
  ownerRef?: string | null;
  /** The organisation whose pool this slot counts against — REQUIRED
   *  (MOTIR-6907): a slot with no org is a container no org's pool bounds. */
  organizationId: string;
  workspaceId?: string | null;
  /** WHICH ACCOUNT of the fleet pool the container boots on (MOTIR-9421);
   *  null or omitted means the process-wide Fly fleet. */
  fleetShardId?: string | null;
  /** When this slot stops being counted if it is never released. NOT the
   *  release mechanism — see the model comment. */
  expiresAt: Date;
}

export const fleetInFlightSlotRepository = {
  /**
   * Take one slot, idempotently.
   *
   * `ON CONFLICT (workload, ref) DO NOTHING` rather than a plain insert, because
   * every caller of this is a retryable background dispatch: a redelivered index
   * job or a re-run agent step must not occupy two slots for one container. The
   * return value distinguishes the two outcomes — `true` means THIS call took
   * the slot, `false` means it was already held — and the caller needs that
   * difference, since only the taker owes a release.
   *
   * `DO NOTHING` and not `DO UPDATE`: refreshing `expires_at` on a redelivery
   * would let a caller extend a slot's safety net indefinitely by retrying,
   * turning the leak bound back into no bound at all. It is also what keeps
   * `owner_ref` truthful (MOTIR-2160) — a losing insert must not restamp the row
   * with ITS run, or the holder's own settle would then fail to recognise the
   * slot it is holding.
   *
   * Two things raw SQL bypasses and this supplies explicitly (the pair
   * `ciPeriodChargeRepository.ensureRow` documents): `@updatedAt` (hence the
   * `NOW()`) and the id default (hence `randomUUID()`, an opaque id for a row
   * nothing joins to by id).
   */
  async take(data: FleetInFlightSlotTakeInput, tx: Prisma.TransactionClient): Promise<boolean> {
    const inserted = await tx.$executeRaw`
      INSERT INTO "fleet_in_flight_slot"
        ("id", "workload", "ref", "owner_ref", "organization_id", "workspace_id",
         "fleet_shard_id", "claimed_at", "expires_at", "created_at", "updated_at")
      VALUES (
        ${randomUUID()},
        ${data.workload},
        ${data.ref},
        ${data.ownerRef ?? null},
        ${data.organizationId},
        ${data.workspaceId ?? null},
        ${data.fleetShardId ?? null},
        NOW(), ${data.expiresAt}, NOW(), NOW()
      )
      ON CONFLICT ("workload", "ref") DO NOTHING
    `;
    return inserted === 1;
  },

  /**
   * Take the slot for `(workload, ref)` AS `ownerRef`, whoever held it before —
   * the one write that may restamp an existing row's owner (MOTIR-7492).
   *
   * {@link take} is `DO NOTHING` on purpose: a LOSING insert must never restamp
   * the holder's row. This is the other case — the caller has just WON the
   * state transition the slot stands for, so its run is the one the container
   * will belong to, and a row stamped with a different run (a concurrent
   * attempt that then lost, or one that leaked) would make the winner's own
   * ownership-checked release fail to recognise it, while the loser's would
   * delete it from under a live container. `DO UPDATE` restamps the owner and
   * renews the safety net for the run that now holds it; the INSERT arm puts the
   * row back when the loser's release got there first, so either order ends
   * with exactly one row, owned by the winner.
   *
   * The account (MOTIR-9421) is written when the caller names one and KEPT when
   * it names none: a restamp must never clear the account a live machine is on.
   */
  async adopt(
    data: FleetInFlightSlotTakeInput & { ownerRef: string; workspaceId: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "fleet_in_flight_slot"
        ("id", "workload", "ref", "owner_ref", "organization_id", "workspace_id",
         "fleet_shard_id", "claimed_at", "expires_at", "created_at", "updated_at")
      VALUES (
        ${randomUUID()},
        ${data.workload},
        ${data.ref},
        ${data.ownerRef},
        ${data.organizationId},
        ${data.workspaceId},
        ${data.fleetShardId ?? null},
        NOW(), ${data.expiresAt}, NOW(), NOW()
      )
      ON CONFLICT ("workload", "ref") DO UPDATE SET
        "owner_ref" = EXCLUDED."owner_ref",
        "fleet_shard_id" = COALESCE(EXCLUDED."fleet_shard_id", "fleet_in_flight_slot"."fleet_shard_id"),
        "expires_at" = EXCLUDED."expires_at",
        "updated_at" = NOW()
    `;
  },

  /**
   * Give a slot back — the release half, and the one that actually frees
   * capacity for every workload (`expires_at` is only the backstop for when this
   * never runs).
   *
   * A DELETE rather than a status flip: the row's whole meaning is "a container
   * exists right now", so the honest representation of "it does not" is its
   * absence. Nothing reports over this table — MOTIR-1924 and MOTIR-1995 own the
   * durable cost record — so there is no history to preserve here, and keeping
   * settled rows would put a growing `WHERE` on the most contended read in the
   * fleet.
   *
   * Returns whether a row was removed, so a double-release is visible to the
   * caller rather than silent.
   */
  async release(workload: string, ref: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const result = await tx.fleetInFlightSlot.deleteMany({ where: { workload, ref } });
    return result.count === 1;
  },

  /**
   * Give a slot back ONLY IF THIS RUN IS THE ONE HOLDING IT (MOTIR-2160).
   *
   * The ownership-checked half of {@link release}, and the smaller of the two
   * halves that stop two runs sharing one slot's capacity. `release` deletes by
   * `(workload, ref)` alone, which is correct for a workload whose ref already
   * names one run — and was silently wrong for the index workload, whose ref is
   * `(projectId, repoRef)`: the first run to settle deleted the row while the
   * OTHER run's container was still alive and still billing, and the census then
   * under-counted a live container. Worse, the freed row could be taken by a
   * third run and deleted in turn by the second's settle — a cascade in which no
   * slot ever names the container it stands for.
   *
   * ⚠️ THE NULL ARM IS DELIBERATE, and it is the migration window, not a loophole.
   * A row with no `owner_ref` was taken before this column existed, so no run can
   * prove it; refusing those would strand every slot in flight at deploy time for
   * its full TTL. It is safe exactly where this method is called from — after a
   * SUCCESSFUL teardown, i.e. once the caller's own container is provably gone —
   * so the only way it under-counts is a pre-MOTIR-2160 overlapping pair, which
   * is the defect this column removes and cannot arise for rows written after it.
   * A slot owned by a DIFFERENT named run is never released.
   *
   * Returns whether a row was actually removed, so a refused release is visible
   * to the caller rather than silent.
   */
  async releaseOwned(
    workload: string,
    ref: string,
    ownerRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.fleetInFlightSlot.deleteMany({
      where: { workload, ref, OR: [{ ownerRef }, { ownerRef: null }] },
    });
    return result.count === 1;
  },

  /**
   * How many slots one workload is holding RIGHT NOW — the ceiling's read for
   * every workload that counts from this table.
   *
   * ⚠️ Read UNDER THE `fleet` ADMISSION LOCK and inside the same transaction as
   * the claim it guards, never on its own: it is the read half of a read-derived
   * write, and a count taken outside the lock is a snapshot two racers can both
   * act on (`notes.html` #35; the CLAUDE.md lock-before-read-derived-update
   * contract). See `ciFleetAdmissionLockRepository.lockScope`.
   *
   * ⚠️ `now` IS A PARAMETER, NOT `NOW()`. The comparison is against a Date bound
   * from the caller so the count agrees with the caller's clock — a `$queryRaw`
   * comparing a Prisma timestamp to SQL `NOW()` reads the DATABASE's clock,
   * which skews against the service's and is unpinnable under fake timers, so a
   * test asserting expiry would be asserting the wrong instant.
   */
  async countLiveForWorkload(
    workload: string,
    now: Date,
    tx: Prisma.TransactionClient,
    /** Accounts whose slots are not counted — a Host org's own indexer accounts,
     *  which the global index cap does not cover (MOTIR-9589). A slot on no
     *  account (the Fly fleet) is always counted. */
    excludedShardIds: readonly string[] = [],
  ): Promise<number> {
    return tx.fleetInFlightSlot.count({
      where: {
        workload,
        expiresAt: { gt: now },
        ...(excludedShardIds.length > 0
          ? { OR: [{ fleetShardId: null }, { fleetShardId: { notIn: [...excludedShardIds] } }] }
          : {}),
      },
    });
  },

  /**
   * How many LIVE slots one organisation is holding, per workload — the
   * slot-backed terms of the per-organisation pool (MOTIR-6907,
   * `docs/decisions/fleet-per-org-pool.md` §2), and with one workload the
   * per-organisation index share (§7).
   *
   * ⚠️ The same locking contract as {@link countLiveForWorkload}: read under the
   * `fleet` admission lock, in the same transaction as the take it guards. Two
   * racers from the same organisation reading this outside the lock both see
   * room. Rides `[organization_id, expires_at]`.
   */
  async countLiveForWorkloadInOrganization(
    workload: string,
    organizationId: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.fleetInFlightSlot.count({
      where: { workload, organizationId, expiresAt: { gt: now } },
    });
  },

  /**
   * How many LIVE slots of one workload one ACCOUNT of the fleet pool is holding
   * (MOTIR-9421) — the per-account in-flight count admission chooses an account
   * by. The same locking contract as {@link countLiveForWorkload}: read under the
   * `fleet` admission lock, in the transaction that writes the account on the
   * slot. Rides `[fleet_shard_id, workload]`.
   */
  async countLiveForWorkloadOnShardInTx(
    workload: string,
    fleetShardId: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.fleetInFlightSlot.count({
      where: { workload, fleetShardId, expiresAt: { gt: now } },
    });
  },

  /**
   * Move ONE run's slot to another account (MOTIR-9421) — the write an in-boot
   * move after a capacity refusal or an outage makes. Only the row `ownerRef`
   * holds is moved, so a run can never move another run's container. Returns
   * whether a row moved.
   */
  async reassignShardInTx(
    workload: string,
    ref: string,
    ownerRef: string,
    fleetShardId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.fleetInFlightSlot.updateMany({
      where: { workload, ref, ownerRef },
      data: { fleetShardId },
    });
    return result.count === 1;
  },

  /**
   * The DISTINCT organisations holding at least one LIVE slot, any workload — the
   * slot-backed term of the fleet monitor's "who is running anything"
   * (MOTIR-7316). Agent instances hold `agent_instance` slots, so they are
   * counted here too. Rides `[organization_id, expires_at]`.
   */
  async listOrganizationsInFlight(now: Date, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.fleetInFlightSlot.findMany({
      where: { expiresAt: { gt: now } },
      distinct: ['organizationId'],
      select: { organizationId: true },
    });
    return rows.map((row) => row.organizationId);
  },

  /**
   * One organisation's LIVE slots of one workload, oldest first — what a
   * platform admin's stop of that org acts on (MOTIR-7317): a `hosted_agent`
   * slot's `ref` names the run it holds. Bounded by the org's pool. Rides
   * `[organization_id, expires_at]`.
   */
  async listLiveForOrganization(
    organizationId: string,
    workload: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<FleetInFlightSlot[]> {
    return tx.fleetInFlightSlot.findMany({
      where: { organizationId, workload, expiresAt: { gt: now } },
      orderBy: { claimedAt: 'asc' },
    });
  },

  /**
   * When one organisation's OLDEST live slot of the given workloads was claimed,
   * or null — the fleet monitor's "has this been running longer than a period"
   * for hosted runs and agent instances (MOTIR-7316).
   */
  async oldestLiveClaimForOrganization(
    organizationId: string,
    workloads: readonly string[],
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const agg = await tx.fleetInFlightSlot.aggregate({
      where: { organizationId, workload: { in: [...workloads] }, expiresAt: { gt: now } },
      _min: { claimedAt: true },
    });
    return agg._min.claimedAt ?? null;
  },

  /** One slot by its workload-owned key — the read that answers "is this run
   *  still holding capacity?" without counting the whole fleet. */
  async findByRef(
    workload: string,
    ref: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetInFlightSlot | null> {
    return tx.fleetInFlightSlot.findUnique({ where: { workload_ref: { workload, ref } } });
  },

  /**
   * Drop every slot whose safety net has expired — the RECOVERY path, not the
   * release path.
   *
   * ⚠️ IT USED TO SAY *"the count already ignores these rows, so this changes no
   * decision"*, AND THAT SENTENCE WENT FALSE WITHOUT ANYTHING EDITING IT
   * (MOTIR-3684). It was a true statement about the two COUNTS — both still
   * filter `expiresAt > now` — and it was written when counting was the only
   * thing this table decided. MOTIR-2160 then added a read that decides on a
   * row's mere EXISTENCE ({@link findByRef}, in
   * `codeGraphIndexAdmissionService.admit`), and from that commit an expired row
   * refused every future admission for its `(workload, ref)` — permanently,
   * because nothing called this method. Measured: one repository's code-graph
   * refresh at a 100% failure rate for a day behind a row that had expired 19
   * hours earlier, and another that had been dead for twenty.
   *
   * So: a comment asserting an invariant about a table is a claim the NEXT
   * reader of that table can falsify without touching the comment. What keeps
   * this one honest now is the caller — `admit` reaps under the fleet admission
   * lock before it reads — not the sentence.
   */
  async deleteExpired(now: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.fleetInFlightSlot.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return result.count;
  },
};
