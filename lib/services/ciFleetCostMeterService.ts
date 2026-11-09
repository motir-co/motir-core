import { Prisma } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  ciContainerUsageRepository,
  type CiContainerUsageCreateInput,
  type CiContainerWorkload,
  type DispatchRunMachineTime,
} from '@/lib/repositories/ciContainerUsageRepository';
import {
  ciContainerUsageSliceRepository,
  IDLE_SLICE_REF,
} from '@/lib/repositories/ciContainerUsageSliceRepository';
import {
  ciContainerPeriodCostRepository,
  type MetaSplitContainerCost,
  type OrgPeriodContainerCost,
  type WorkloadPeriodContainerCost,
} from '@/lib/repositories/ciContainerPeriodCostRepository';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { containerWorkloadFor } from '@/lib/ciFleet/workloads';
import { isCloudBilling } from '@/lib/billing/availability';
import { periodStartFor } from '@/lib/ciMetering/period';
import type { ContainerAccrual, ContainerUsage, ContainerWorkSlice } from '@motir/orchestrator';

// The FLEET COST METER (Story MOTIR-1916 · MOTIR-1924) — the SECOND meter, and
// the first thing in Motir that measures what Motir's own compute costs.
//
// `docs/decisions/ci-minutes-allowance.md` §P states the problem this closes:
// before the fleet, "what the customer is charged" and "what Motir pays" were
// one number seen from two sides, because GitHub billed Motir for the minute it
// charged the user for. On Motir's own runners they are independent, and only
// the first was measured — the 9.0 gateway meters TOKENS, `ciMinutesMeterService`
// meters Actions job WALL-CLOCK, and neither sees a container. This service
// persists the container-seconds record the orchestrator emits (`ci-runner-fleet.md`
// §5), attributed the same way the minutes are, so margin per org is a number
// that can be read rather than inferred.
//
// ⚠️ IT IS NOT BILLING, AND MUST NOT BECOME IT. Nothing here debits a credit
// ledger, reads a balance, refuses anything or reaches a user-facing surface.
// This is Motir's own COGS: the customer is metered by §3's Linux-equivalent
// minutes at the ×1.00 fleet rate (§M), a PRODUCT decision that this meter's
// numbers deliberately do not feed back into. What it DOES enable is §L's margin
// claim becoming a measurement, which is the stated precondition for ever
// re-opening the allowance (§1) — in the open, with evidence, and with its own
// card.
//
// ⚠️ IT METERS ALL THREE FLEET WORKLOADS, NOT JUST CI (MOTIR-1995). The fleet org
// is SHARED: CI runners, code-graph index containers (`code-graph-index-fleet.md`
// §2) and Epic 9's hosted agents all bill one uncapped Fly account. MOTIR-1981
// originally claimed index container-seconds were already "attributable per
// MOTIR-1924's cost meter" — false, and the reason this card exists: nothing routed
// an index container here, and the fleet would have spent real money with no meter
// at all. Every row now carries its `workload`, the rollup is keyed by it, and a
// fourth workload that fails to declare its line is a compile error
// (`CONTAINER_WORKLOAD_BY_FLEET_KIND`). One meter over one record; two meters over
// one record is how they diverge, and three is worse.
//
// ⚠️ AND THERE IS NO `isMeta` BRANCH IN IT ANY MORE — read this as the correction
// it is (MOTIR-1995). MOTIR-1924 bypassed the meta org entirely, which was right
// THERE for a reason that does not hold here: meta CI never runs on the fleet
// (MOTIR-1915), so there was nothing to record. META INDEXING DOES run on the fleet
// (`code-graph-index-fleet.md` decision 7 — the circularity test passes for
// indexing, unlike CI), so the same bypass would produce real Fly spend with no
// row: dogfooding unbounded AND invisible, which is the exact shape MOTIR-1935 was
// filed over. `isMeta` orgs are therefore metered exactly like any tenant, and
// their cost is readable as its OWN line (`getMetaPeriodCostSplit`) so it neither
// pollutes per-customer margin nor hides.
//
// The generalization, worth carrying past this file: `isMeta` is a BILLING flag
// that has been used as a proxy for "this workload is not real." That proxy stops
// being safe the moment meta shares infrastructure with customers. Read every
// `isMeta` branch as "should this be un-CHARGED?", never as "should this be
// un-MEASURED?" — and this meter charges NOBODY, which is why it needs no branch:
// there is no charge here for `isMeta` to suppress. `MOTIR_CLOUD=false` keeps its
// bypass, because that flag says no fleet EXISTS, which is a different claim.
//
// The pipeline, and where each step is decided:
//
//   1. Enabled?         §8.5  — off-cloud there is no fleet and no meter.
//   2. Materialize.     §5    — the row exists, idempotently, so step 3 can lock it.
//   3. LOCK + derive.   #35   — what has this container already contributed?
//   4. Record it.       §4.5  — one transaction: the row's new total + the delta.

export type RecordContainerUsageOutcome =
  /** Off-cloud — the fleet does not run and the meter is inert (§8.5). */
  | { outcome: 'disabled' }
  /** This container was already SETTLED — counted once (§5). A settled row is
   *  final: the reaper reaching the same handle, or a replayed settle step,
   *  changes nothing. */
  | { outcome: 'duplicate'; containerProvider: string; handleId: string }
  | {
      outcome: 'recorded';
      containerProvider: string;
      handleId: string;
      organizationId: string;
      workspaceId: string;
      periodStart: Date;
      /** Which cost line the row was recorded under. */
      workload: CiContainerWorkload;
      /** The container's TOTAL billable seconds as now stored. */
      billableSeconds: number;
      /** Decimal string — never a float. The container's TOTAL cost as stored. */
      costUsd: string;
      /**
       * What this write ADDED to the period rollup — signed, and 0 for a write
       * that changed nothing (a replayed checkpoint). Surfaced rather than kept
       * private because it is the only thing distinguishing "recorded 240 s
       * again, for free" from "recorded 240 s twice", and a caller that logs the
       * outcome should be able to see which happened.
       */
      accruedSecondsDelta: number;
      /**
       * MOTIR-3255 — how this handle's figure DIVIDES, when it served more than
       * one repo. `attributedSeconds` is Σ work slices as now stored;
       * `idleSeconds` is the derived remainder the ORG owns. Both 0 for a
       * one-container-one-repo handle, which the row's own columns already
       * attribute exactly.
       */
      attributedSeconds: number;
      idleSeconds: number;
    };

/** What one CHECKPOINT on a still-running container did (MOTIR-1995). Shaped like
 *  the settle outcome above so a caller logs both the same way, minus `duplicate`:
 *  a checkpoint on an already-settled container is not a duplicate, it is a LATE
 *  observation, and it is named as one. */
export type RecordContainerAccrualOutcome =
  | { outcome: 'disabled' }
  /** The container has already been torn down and settled, so its figure is final
   *  and this observation is simply too late — a normal race between the last poll
   *  and the teardown, not an error. */
  | { outcome: 'already_settled'; containerProvider: string; handleId: string }
  | {
      outcome: 'accrued';
      containerProvider: string;
      handleId: string;
      organizationId: string;
      workspaceId: string;
      periodStart: Date;
      workload: CiContainerWorkload;
      billableSeconds: number;
      costUsd: string;
      accruedSecondsDelta: number;
      /**
       * MOTIR-3255 — how this handle's figure DIVIDES, when it served more than
       * one repo. `attributedSeconds` is Σ work slices as now stored;
       * `idleSeconds` is the derived remainder the ORG owns. Both 0 for a
       * one-container-one-repo handle, which the row's own columns already
       * attribute exactly.
       */
      attributedSeconds: number;
      idleSeconds: number;
    };

/** What one org's CI cost Motir in a period, beside what it was metered for —
 *  the margin readout, derived ENTIRELY from stored values. */
export interface OrgPeriodCostBasis {
  organizationId: string;
  periodStart: Date;
  /** Motir's side: Σ container-seconds and their cost (this meter). */
  containerSeconds: number;
  costUsd: string;
  containerCount: number;
  /** The customer's side: Σ Linux-equivalent minutes (`ciMinutesMeterService`'s
   *  rollup), which at the fleet's ×1.00 rate is also the raw billable figure. */
  linearEquivalentMinutes: number;
  /**
   * Motir's cost per metered minute — the one derived figure, and the number
   * §M's `usdPerMinute: 0.001` estimate can finally be checked against.
   *
   * NULL when the org was metered no minutes in the period: a cost with no
   * minutes under it is a real state (a container that booted for a run whose
   * `workflow_run` webhook has not landed yet, or a month of pure failed boots),
   * and dividing by zero to report it would invent a number rather than admit
   * one is not yet available.
   */
  costPerLinearEquivalentMinute: string | null;
}

export const ciFleetCostMeterService = {
  /**
   * Persist ONE container's cost record, and add it to the org's period rollup.
   *
   * Never throws for a record it simply does not meter: every "no" is a typed
   * outcome the caller logs. The caller is the teardown `finally` that
   * guarantees a container is destroyed (and the reaper), so a throw from here
   * would turn "the container is gone and we could not record it" into "the
   * container may still be running" — trading a bookkeeping gap for a billing
   * leak, which is the wrong direction every time.
   */
  async recordContainerUsage(usage: ContainerUsage): Promise<RecordContainerUsageOutcome> {
    // 1 · §8.5 — a self-hosted build runs no fleet, so there is nothing to
    // meter. Deliberately gated on `MOTIR_CLOUD` ALONE, not on
    // `isCiMeteringEnabled()`: that helper also requires a provisioning ORG
    // login, which qualifies whether GITHUB bills Motir for a repo — a question
    // this meter never asks. A container Motir booted cost Motir money whatever
    // `GITHUB_FALLBACK_ORG` says, and dropping the record because an unrelated
    // env var is unset would lose real spend.
    if (!isCloudBilling()) return { outcome: 'disabled' };

    const workload = containerWorkloadFor(usage.workload);
    const written = await writeContainerFigure({
      // §4.5's period rule, applied to the container's own STOP instant: a pure
      // function of the record, so the write reads no billing state at all and
      // lands in the same monthly bucket the minute meter uses. It is used ONLY if
      // this settle creates the row — a container that has been checkpointing
      // keeps the period of its FIRST accrual (see `writeContainerFigure`).
      periodStartIfNew: periodStartFor(usage.stoppedAt),
      workload,
      billableSeconds: usage.billableSeconds,
      costUsd: usage.costUsd,
      // A SETTLE, so the row's terminal fields are written together with the stop
      // instant — the three of them are what make the row final.
      settle: {
        stoppedAt: usage.stoppedAt,
        terminalState: usage.terminalState,
        teardownReason: usage.teardownReason,
      },
      row: rowInputFor(usage),
      startedAt: usage.startedAt,
      slices: usage.slices,
    });

    if (written.outcome === 'already_settled') {
      // A second teardown of the same handle — the `finally` and the reaper both
      // reaching it, or a replayed settle step. `teardown` is required to be
      // idempotent, so this must cost nothing, and it does: the locked read saw a
      // settled row and wrote neither the row nor the rollup.
      return { outcome: 'duplicate', containerProvider: usage.provider, handleId: usage.handleId };
    }

    return {
      outcome: 'recorded',
      containerProvider: usage.provider,
      handleId: usage.handleId,
      organizationId: usage.orgId,
      workspaceId: usage.workspaceId,
      periodStart: written.periodStart,
      workload,
      billableSeconds: usage.billableSeconds,
      costUsd: usage.costUsd,
      accruedSecondsDelta: written.accruedSecondsDelta,
      attributedSeconds: written.attributedSeconds,
      idleSeconds: written.idleSeconds,
    };
  },

  /**
   * CHECKPOINT a container that is STILL RUNNING — record what it has accrued so
   * far, so its spend is visible before it stops (MOTIR-1995).
   *
   * ⚠️ WHY A LIVE CONTAINER NEEDS A ROW AT ALL. `recordContainerUsage` above is
   * driven by `teardown`, which is what makes the meter unskippable — and also
   * means a container produces nothing until it ends. For an index container
   * (minutes) that is fine. For Epic 9's agent container, which spans a whole
   * `motir run <story>` and therefore HOURS, teardown-only costing means the entire
   * run is invisible spend against a Fly account with NEITHER a spending cap nor a
   * billing alert (`ci-runner-fleet.md` §9). A figure that arrives after the money
   * is gone is a record, not a meter.
   *
   * Same never-throws contract as the settle path: every "no" is a typed outcome.
   */
  async recordContainerAccrual(accrual: ContainerAccrual): Promise<RecordContainerAccrualOutcome> {
    if (!isCloudBilling()) return { outcome: 'disabled' };

    const workload = containerWorkloadFor(accrual.workload);
    const written = await writeContainerFigure({
      // A checkpoint buckets by the instant it was OBSERVED at, and only when it
      // is the row's first write. Every later write reuses the stored period.
      periodStartIfNew: periodStartFor(accrual.observedAt),
      workload,
      billableSeconds: accrual.accruedSeconds,
      costUsd: accrual.costUsd,
      // NOT a settle — the row stays open, so a later checkpoint or the teardown
      // can still raise (or correct) the figure.
      settle: null,
      row: rowInputFor(accrual),
      startedAt: accrual.startedAt,
      slices: accrual.slices,
    });

    if (written.outcome === 'already_settled') {
      // The container was torn down between this poll and its write. Its figure is
      // final and this observation is simply late — the normal race, not an error.
      return {
        outcome: 'already_settled',
        containerProvider: accrual.provider,
        handleId: accrual.handleId,
      };
    }

    return {
      outcome: 'accrued',
      containerProvider: accrual.provider,
      handleId: accrual.handleId,
      organizationId: accrual.orgId,
      workspaceId: accrual.workspaceId,
      periodStart: written.periodStart,
      workload,
      billableSeconds: accrual.accruedSeconds,
      costUsd: accrual.costUsd,
      accruedSecondsDelta: written.accruedSecondsDelta,
      attributedSeconds: written.attributedSeconds,
      idleSeconds: written.idleSeconds,
    };
  },

  /**
   * What ONE WORKLOAD cost Motir for one org in the period containing `at` — the
   * single indexed read, no recomputation from per-container rows and none from
   * logs.
   *
   * ⚠️ THE WORKLOAD IS AN ARGUMENT, NOT A DEFAULT (MOTIR-1995). Before the fleet
   * org was shared this method's answer was unambiguous; now "what did this org
   * cost?" has three answers and a total, and picking one silently is how index
   * spend would end up inside a CI margin figure. Callers that want the whole
   * picture use {@link getOrgPeriodCostByWorkload}, where the addition is visible.
   */
  async getOrgPeriodCost(
    organizationId: string,
    at: Date,
    workload: CiContainerWorkload,
  ): Promise<OrgPeriodContainerCost> {
    return withSystemContext((tx) =>
      ciContainerPeriodCostRepository.sumForOrgPeriod(
        organizationId,
        periodStartFor(at),
        workload,
        tx,
      ),
    );
  },

  /**
   * Every workload's line for one org and period — what "separable within the
   * shared fleet org" means as a call.
   *
   * This is the read that answers MOTIR-1981's actual question ("what did indexing
   * cost us?") and the one whose absence made the story's original claim false.
   * Lines the org did not run are omitted rather than reported as zero: the rollup
   * holds rows for what ran, and a zero `agent` line before Epic 9 ships would
   * state a fact the table does not contain.
   */
  async getOrgPeriodCostByWorkload(
    organizationId: string,
    at: Date,
  ): Promise<WorkloadPeriodContainerCost[]> {
    return withSystemContext((tx) =>
      ciContainerPeriodCostRepository.sumForOrgPeriodByWorkload(
        organizationId,
        periodStartFor(at),
        tx,
      ),
    );
  },

  /**
   * The period's fleet cost split META vs TENANT, per workload — Motir's own
   * dogfood spend AS ITS OWN LINE (MOTIR-1995).
   *
   * The counterpart to removing MOTIR-1924's `isMeta` bypass: meta is metered like
   * any tenant (it runs on the same fleet, so a bypass would mean real spend with
   * no row), and this is what stops that decision from quietly folding the house's
   * bill into per-customer margin. Same rows, two readings.
   */
  /**
   * ONE hosted run's machine time — its billable seconds and cost, live while the
   * container runs and final once it has settled (MOTIR-6448). The third figure a
   * hosted run's panel shows beside motir-ai's tokens and credits.
   *
   * Keyed by `DispatchRun.id`, the one id a hosted run carries everywhere
   * (`docs/decisions/hosted-agent-run.md` §1). A run with no container row answers
   * zeroes, never a throw.
   */
  async getMachineTimeForDispatchRun(dispatchRunId: string): Promise<DispatchRunMachineTime> {
    return withSystemContext((tx) =>
      ciContainerUsageRepository.getMachineTimeForDispatchRun(dispatchRunId, tx),
    );
  },

  async getMetaPeriodCostSplit(at: Date): Promise<MetaSplitContainerCost[]> {
    return withSystemContext((tx) =>
      ciContainerPeriodCostRepository.sumForPeriodByMetaSplit(periodStartFor(at), tx),
    );
  },

  /**
   * THE MARGIN READOUT — this meter's cost beside the minute meter's metered
   * quantity, for the same org and the same period.
   *
   * Both halves are STORED ROLLUPS read by the same key, which is the acceptance
   * this card is built to meet: margin is a subtraction over two rows, never a
   * recomputation from logs or a scan of per-run history. It reads
   * `ciPeriodUsageRepository` directly rather than calling `ciMinutesMeterService`
   * — one read of a sibling meter's rollup table, not a dependency on its
   * behaviour, so neither meter can change the other's numbers.
   *
   * It returns quantities and ONE ratio, and deliberately no verdict: what a
   * minute is SOLD for lives in the entitlement + credit layer (§2, §7), and
   * pulling a price in here would couple the COGS meter to billing — the exact
   * coupling the module header refuses.
   *
   * ⚠️ IT READS THE `ci` LINE ONLY, and that is a correctness fix, not a narrowing
   * (MOTIR-1995). The denominator is the org's metered Linux-equivalent CI MINUTES.
   * Putting the org's WHOLE fleet cost over it — index containers included, which
   * generate no metered minute at all — would inflate cost-per-CI-minute by
   * whatever else the org ran, in the one figure §M's estimate is supposed to be
   * checkable against. That is `ci-minutes-allowance.md` §Q.2's phantom drift in a
   * ratio instead of a reconciliation: a number that looks like a measurement and
   * is a mixture.
   */
  async getOrgPeriodCostBasis(organizationId: string, at: Date): Promise<OrgPeriodCostBasis> {
    const periodStart = periodStartFor(at);
    const { cost, consumption } = await withSystemContext(async (tx) => ({
      cost: await ciContainerPeriodCostRepository.sumForOrgPeriod(
        organizationId,
        periodStart,
        'ci',
        tx,
      ),
      consumption: await ciPeriodUsageRepository.sumForOrgPeriod(organizationId, periodStart, tx),
    }));

    const minutes = consumption.linearEquivalentMinutes;
    const costPerLinearEquivalentMinute =
      minutes > 0 ? new Prisma.Decimal(cost.costUsd).div(minutes).toFixed(12) : null;

    return {
      organizationId,
      periodStart,
      containerSeconds: cost.containerSeconds,
      costUsd: cost.costUsd,
      containerCount: cost.containerCount,
      linearEquivalentMinutes: minutes,
      costPerLinearEquivalentMinute,
    };
  },

  /**
   * REPAIR the index rows a lost settle write left unsettled (MOTIR-8913).
   *
   * ⚠️ WHY THIS EXISTS. `settleIndexContainer` destroys the container and THEN
   * records its usage through the sink, whose contract is to never throw — so a
   * failed or lost write leaves the supervision `settled` and the usage row a
   * checkpoint with NULL `terminal_state` forever. Nothing else re-reads that row:
   * the reaper only sees machines that still exist, and a settled supervision stops
   * matching the abandoned-supervision sweep. Production held four such rows, the
   * oldest from August, and each is a container the margin readout counts as
   * running and the platform meter backfill (`container_stopped_at IS NOT NULL`)
   * never reports.
   *
   * ⚠️ AGE IS THE EVIDENCE THE CONTAINER IS GONE. A row older than the fleet reaper's
   * window belongs to a machine the reaper has destroyed whatever this row says,
   * so settling it claims nothing the provider does not already hold. The stop
   * instant is derived from the row's own figures — the last checkpoint's billable
   * seconds past the observed start — rather than invented, and the figures are
   * left alone: the rollup already holds them, which is why the repair writes no
   * rollup delta.
   *
   * IDEMPOTENT: `settleStranded` only writes a row whose `container_stopped_at` is
   * still NULL, so a tick that races the real settle, or a replay, changes nothing.
   *
   * ⚠️ IT ANSWERS THE ROWS IT SETTLED, AND THE CALLER REPORTS THEM (MOTIR-10822).
   * A repaired row is a settled container the platform meter has never seen: the
   * settle path's report rides `withPlatformMeterReport`, which this write never
   * passes through, and the backfill is a hand-run script. This service cannot
   * enqueue the report itself — it is on the fleet-cost READ graph, which must not
   * reach the job registry (`platformMeterReportEnqueue`'s header) — so it hands
   * back each settled row's identity, and `supervisionSweepService` enqueues one
   * report per row once this transaction has committed. A row `settleStranded`
   * skipped is not in the list, so a tick that raced the real settle reports
   * nothing twice.
   */
  async settleStrandedIndexUsage(
    options: { now?: () => Date; strandedAfterMs?: number; batch?: number } = {},
  ): Promise<StrandedUsageRepair> {
    const now = (options.now ?? ((): Date => new Date()))();
    const createdBefore = new Date(now.getTime() - (options.strandedAfterMs ?? STRANDED_AFTER_MS));

    return withSystemContext(async (tx) => {
      const stranded = await ciContainerUsageRepository.listStrandedIndexUsage(
        createdBefore,
        options.batch ?? STRANDED_BATCH,
        tx,
      );
      const repaired: ContainerHandleRef[] = [];
      for (const row of stranded) {
        const from = row.containerStartedAt ?? row.containerCreatedAt;
        const stoppedAt = new Date(from.getTime() + row.billableSeconds * 1000);
        const count = await ciContainerUsageRepository.settleStranded(
          row.id,
          { stoppedAt, terminalState: 'repaired', teardownReason: 'reaped' },
          tx,
        );
        if (count === 0) continue;
        repaired.push({ containerProvider: row.containerProvider, handleId: row.handleId });
        // The one trace of the swallowed write: the sink logged (or lost) the failure
        // without ever reaching a row, so the handle id is named here, where the
        // repair is the only thing that knows the record was missing.
        console.warn('[containerUsage] settled an index usage row its teardown never closed', {
          handleId: row.handleId,
          provider: row.containerProvider,
        });
      }
      return { scanned: stranded.length, settled: repaired.length, repaired };
    });
  },
};

/** One container usage row, by the identity the platform meter report is keyed on. */
export interface ContainerHandleRef {
  containerProvider: string;
  handleId: string;
}

/** What one stranded-row repair tick did (MOTIR-8913, MOTIR-10822). */
export interface StrandedUsageRepair {
  /** Stranded rows the tick read. */
  scanned: number;
  /** Rows it settled — `repaired.length`. */
  settled: number;
  /** The rows it settled, so the caller can report each one to the platform meter. */
  repaired: ContainerHandleRef[];
}

/** The reaper's window (70 min) with generous margin: older than this, an index
 *  container is destroyed whatever its usage row says (MOTIR-8913). */
const STRANDED_AFTER_MS = 2 * 60 * 60_000;
/** Rows one repair tick settles; a backlog drains over several ticks. */
const STRANDED_BATCH = 50;

/**
 * THE ONE WRITE PATH (MOTIR-1995) — the shared body of both the checkpoint and the
 * settle, and the only place a container's figure or its rollup delta is decided.
 *
 * Both callers state the container's TOTAL to date; this derives what that means
 * for the rollup. Keeping it in one function is the "extended, not duplicated"
 * requirement made structural: two write paths over one record would each need
 * their own lock, their own delta arithmetic and their own idempotency argument,
 * and the first divergence would surface as a rollup that no longer equals the sum
 * of its rows — months later, in a reconciliation, attributable to nothing.
 *
 * ⚠️ THE ORDER OF THE THREE STEPS IS THE CORRECTNESS ARGUMENT (`notes.html` #35):
 *
 *   1. `createIfAbsent` — MATERIALIZE the row, so there is something to lock. A
 *      `FOR UPDATE` on a row that does not exist locks nothing, and two concurrent
 *      first checkpoints would each read "no prior" and each add their whole
 *      figure: the container counted twice.
 *   2. `lockAccruedState` — LOCK it and read what it already contributed. This is
 *      the serialization point; everything after it is derived from a value no
 *      sibling transaction can change underneath.
 *   3. `accrue` + `incrementForPeriod` — write the new total and the SIGNED
 *      difference, in the same transaction, so the row and the rollup can never
 *      disagree.
 *
 * All three run inside ONE `withSystemContext` transaction (the rows are RLS-gated
 * and the fleet has no session workspace), which is also what makes the lock last
 * until the rollup is written rather than being released mid-flight.
 */
async function writeContainerFigure(input: {
  periodStartIfNew: Date;
  workload: CiContainerWorkload;
  billableSeconds: number;
  costUsd: string;
  settle: { stoppedAt: Date; terminalState: string; teardownReason: string } | null;
  row: ContainerRowIdentity;
  startedAt: Date | null;
  /** MOTIR-3255 — what a MULTI-REPO handle's seconds were spent on. Absent for
   *  every one-container-one-repo workload, which is all of them today. */
  slices: readonly ContainerWorkSlice[] | undefined;
}): Promise<
  | { outcome: 'already_settled' }
  | {
      outcome: 'written';
      periodStart: Date;
      accruedSecondsDelta: number;
      /** Σ seconds this handle attributed to WORK, and the idle remainder that
       *  belongs to the org. Both 0 for a single-repo handle, which attributes
       *  its whole figure by the row's own columns. */
      attributedSeconds: number;
      idleSeconds: number;
    }
> {
  const { periodStartIfNew, workload, billableSeconds, costUsd, settle, row } = input;

  return withSystemContext(async (tx) => {
    // 1 · Materialize. Every value here is provisional — `ON CONFLICT DO NOTHING`,
    // so an existing row (which may already hold a larger figure) is untouched.
    const created = await ciContainerUsageRepository.createIfAbsent(
      {
        ...row,
        workload,
        periodStart: periodStartIfNew,
        billableSeconds,
        costUsd,
        containerStoppedAt: settle?.stoppedAt ?? null,
        terminalState: settle?.terminalState ?? null,
        teardownReason: settle?.teardownReason ?? null,
      },
      tx,
    );

    // 2 · Lock and read the prior. Non-null by construction after step 1 — a
    // concurrent DELETE is the only way it could vanish, and nothing deletes these
    // rows (a deleted PROJECT nulls the column, it does not remove the record).
    const prior = await ciContainerUsageRepository.lockAccruedState(
      row.containerProvider,
      row.handleId,
      tx,
    );
    if (!prior) {
      // Defensive rather than expected: report it as settled (which writes nothing)
      // instead of guessing a delta from a row we cannot see.
      return { outcome: 'already_settled' as const };
    }

    // A SETTLED row is FINAL. This is the idempotency guarantee for both callers at
    // once: a second teardown, a replayed settle step, and a checkpoint that lost
    // the race to the teardown all land here and all write nothing. Note it is
    // checked AFTER the lock, so two concurrent settles cannot both pass it.
    if (prior.settled && !created) return { outcome: 'already_settled' as const };

    // 3 · The delta. SIGNED: a settle that lands below the last checkpoint (the
    // container stopped between two observations) corrects the rollup DOWNWARD
    // rather than leaving it overstating a container that has finished.
    //
    // `created` is the one case with no prior contribution — the row we just
    // inserted already carries this figure, so the whole of it is the delta.
    const priorSeconds = created ? 0 : prior.billableSeconds;
    const priorCost = created ? '0' : prior.costUsd;
    const accruedSecondsDelta = billableSeconds - priorSeconds;
    const costDelta = new Prisma.Decimal(costUsd).sub(priorCost).toFixed();

    // The row is bucketed at its FIRST write and never re-bucketed: the rollup it
    // has already been added to is the one this delta has to reach, whatever period
    // the settle instant now falls in. A container running across a month boundary
    // therefore keeps its original period — re-bucketing would leave the first
    // period's rollup permanently overstated with no row pointing at why.
    const periodStart = created ? periodStartIfNew : prior.periodStart;

    // Write the row's new absolute total. Skipped only when nothing about it would
    // change: a replayed checkpoint on a row we did not create and whose figure and
    // openness already match. `created` still needs no update — step 1 wrote it.
    const settlingAnOpenRow = settle !== null;
    if (!created && (accruedSecondsDelta !== 0 || settlingAnOpenRow)) {
      await ciContainerUsageRepository.accrue(
        {
          containerProvider: row.containerProvider,
          handleId: row.handleId,
          billableSeconds,
          costUsd,
          usdPerSecond: row.usdPerSecond,
          rateEffectiveFrom: row.rateEffectiveFrom,
          // The later observation wins: a settle carries the provider's own start
          // instant, which is at least as good as whatever a poll saw. NULL only
          // ever means "never started" — a state a checkpoint cannot report, since
          // a container that has not started has accrued nothing to checkpoint.
          containerStartedAt: input.startedAt,
          containerStoppedAt: settle?.stoppedAt ?? null,
          terminalState: settle?.terminalState ?? null,
          teardownReason: settle?.teardownReason ?? null,
          // Persisted on the accrual too, so a LIVE row already names its run
          // (MOTIR-6448). A null here never clears a named row.
          dispatchRunId: row.dispatchRunId,
        },
        tx,
      );
    }

    // A zero delta writes nothing to the rollup — the replayed-checkpoint case, and
    // the reason a replay is free by arithmetic rather than by bookkeeping.
    if (accruedSecondsDelta !== 0 || created) {
      await ciContainerPeriodCostRepository.incrementForPeriod(
        {
          workspaceId: row.workspaceId,
          organizationId: row.organizationId,
          periodStart,
          // The row was created under `workload`, and a delta must reach the SAME
          // line it was counted on — never the workload this call happens to name,
          // which for a settle after a checkpoint is the same value but need not be
          // assumed to be.
          workload: created ? workload : (prior.workload as CiContainerWorkload),
          billableSeconds: accruedSecondsDelta,
          costUsd: costDelta,
          // Counted ONCE, when the row appears. A checkpointed container writes
          // many times and is one container.
          containerCountDelta: created ? 1 : 0,
        },
        tx,
      );
    }

    // 4 · ATTRIBUTION, for a handle that served more than one repo (MOTIR-3255).
    //
    // Runs inside the SAME transaction and AFTER the figure, deliberately: the
    // idle slice is the complement of the figure, so deriving it before the row
    // held its new total would attribute the difference to a lifetime that had
    // not been written yet.
    const attribution = await writeSlices({
      slices: input.slices,
      row,
      periodStart,
      lifetimeSeconds: billableSeconds,
      tx,
    });

    return {
      outcome: 'written' as const,
      periodStart,
      accruedSecondsDelta,
      attributedSeconds: attribution.attributedSeconds,
      idleSeconds: attribution.idleSeconds,
    };
  });
}

/**
 * Divide a handle's lifetime among the projects it served, and give the remainder
 * to the org (MOTIR-3255).
 *
 * ⚠️ THE CALLER REPORTS **WORK**; THIS DERIVES **IDLE**. That asymmetry is the
 * whole reason the reconciliation holds: `Σ slices = the handle's billable
 * seconds` is arithmetic performed here, not a property a container is trusted to
 * maintain. A worker that under-reports its work does not break the sum — it
 * moves seconds into idle, where they are visibly nobody's.
 *
 * ⚠️ AND IDLE'S OWNER IS THE ORG, WHICH IS A DECISION AND NOT A DEFAULT
 * (`code-graph-index-fleet.md` §16.2). A machine waiting for work is costing
 * money on nobody's behalf in particular; the alternatives were to spread it
 * across the projects it happened to serve (inventing an attribution nobody
 * measured) or to leave it unattributed (making the slices sum short of the
 * handle, which is the hole this card exists to close). A row with a null project
 * on the org's own line says exactly what happened.
 *
 * Absent `slices` writes NOTHING — not an empty set, not a whole-lifetime idle
 * slice. Every one-container-one-repo workload is already exactly attributed by
 * the handle row's own columns, and a slice table that also held those rows would
 * be a second place to read the same fact.
 */
async function writeSlices(input: {
  slices: readonly ContainerWorkSlice[] | undefined;
  row: ContainerRowIdentity;
  periodStart: Date;
  lifetimeSeconds: number;
  tx: Prisma.TransactionClient;
}): Promise<{ attributedSeconds: number; idleSeconds: number }> {
  const { slices, row, periodStart, lifetimeSeconds, tx } = input;
  if (!slices) return { attributedSeconds: 0, idleSeconds: 0 };

  const rate = new Prisma.Decimal(row.usdPerSecond);
  for (const slice of slices) {
    await ciContainerUsageSliceRepository.upsert(
      {
        containerProvider: row.containerProvider,
        handleId: row.handleId,
        sliceRef: slice.sliceRef,
        kind: 'work',
        workspaceId: row.workspaceId,
        organizationId: row.organizationId,
        projectId: slice.projectId,
        repoFullName: slice.repoFullName,
        seconds: slice.seconds,
        usdPerSecond: row.usdPerSecond,
        costUsd: rate.mul(slice.seconds).toFixed(),
        periodStart,
      },
      tx,
    );
  }

  // Read the sum back from the TABLE rather than from the argument: a checkpoint
  // reports the slices it knows about, and a handle's earlier work may have been
  // attributed by an earlier checkpoint that this one does not repeat.
  const attributedSeconds = await ciContainerUsageSliceRepository.sumWorkSecondsForHandle(
    row.containerProvider,
    row.handleId,
    tx,
  );

  const idleSeconds = Math.max(0, lifetimeSeconds - attributedSeconds);
  if (attributedSeconds > lifetimeSeconds) {
    // Not clamped silently. A handle claiming more work than it has lived is a
    // reporting bug, and the floor above keeps the idle row from going negative —
    // but the discrepancy is the interesting fact, so it is SAID. The slices are
    // still written: what was reported is evidence, and dropping it would leave
    // the bug invisible in exactly the record that could show it.
    console.warn(
      `[fleet-cost-meter] ${row.containerProvider}/${row.handleId}: slices attribute ` +
        `${attributedSeconds}s of work against a ${lifetimeSeconds}s lifetime — the handle ` +
        'reported more work than it lived, so idle is floored at 0 and Σ slices exceeds the ' +
        'figure. Reconciliation will not balance for this handle.',
    );
  }

  await ciContainerUsageSliceRepository.upsert(
    {
      containerProvider: row.containerProvider,
      handleId: row.handleId,
      sliceRef: IDLE_SLICE_REF,
      kind: 'idle',
      workspaceId: row.workspaceId,
      organizationId: row.organizationId,
      projectId: null,
      repoFullName: null,
      seconds: idleSeconds,
      usdPerSecond: row.usdPerSecond,
      costUsd: rate.mul(idleSeconds).toFixed(),
      periodStart,
    },
    tx,
  );

  return { attributedSeconds, idleSeconds };
}

/**
 * Everything about a usage row that describes the CONTAINER rather than the moment
 * — so a checkpoint and a settle supply it identically, and only the four
 * per-moment fields (the figure, the period, the stop and the terminal pair)
 * distinguish them.
 */
type ContainerRowIdentity = Omit<
  CiContainerUsageCreateInput,
  | 'workload'
  | 'periodStart'
  | 'billableSeconds'
  | 'costUsd'
  | 'containerStoppedAt'
  | 'terminalState'
  | 'teardownReason'
>;

/**
 * Project either record shape onto {@link ContainerRowIdentity}.
 *
 * ⚠️ `String(null)` IS `'null'`, NOT NULL. The port's `workflowJobId` is nullable
 * since MOTIR-2025 and the column has been `String?` since it was written
 * ("NULLABLE because only a CI container has one"); a bare `String()` would write
 * the four-character string `null` and make the absence indistinguishable from a
 * job actually called that. Now that index containers reach this writer, the null
 * path is the COMMON one rather than a hypothetical.
 */
function rowInputFor(record: ContainerUsage | ContainerAccrual): ContainerRowIdentity {
  return {
    containerProvider: record.provider,
    handleId: record.handleId,
    containerRegion: record.region,
    workspaceId: record.workspaceId,
    organizationId: record.orgId,
    projectId: record.projectId,
    repoFullName: record.repoFullName,
    workflowJobId: record.workflowJobId === null ? null : String(record.workflowJobId),
    cpuKind: record.cpuKind,
    cpus: record.cpus,
    memoryMb: record.memoryMb,
    containerCreatedAt: record.createdAt,
    containerStartedAt: record.startedAt,
    usdPerSecond: record.usdPerSecond,
    rateEffectiveFrom: record.rateEffectiveFrom,
    dispatchRunId: record.dispatchRunId ?? null,
  };
}
