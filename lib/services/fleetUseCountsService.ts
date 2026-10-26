import { withSystemContext } from '@/lib/workspaces/context';
import { bindOrganizationContext } from '@/lib/organizations/context';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import type { AdmissionDeferralReason } from '@/lib/services/ciRunnerAdmissionService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';

// PER-ORG FLEET USE COUNTS (Story MOTIR-9368 · MOTIR-9660) — for ONE organisation,
// what it has in flight against each plan figure, how many of its members are at
// the per-person agent figure, and the work waiting behind each figure, split
// into waits its own plan limit causes and waits a full pool causes.
//
// ⚠️ ADMISSION'S OWN STATEMENTS, never look-alikes. The in-flight counts are
// `fleetCeilingService.orgCensus` (agent runs, CI, indexing) and the running-cap
// guard's `countRunningOrAdmitting` over the org's live `agent_instance` slots,
// so the page and the gates cannot disagree. The waits are read from the reason
// admission itself recorded (MOTIR-9666), never parsed from words or guessed
// from today's counts.
//
// ⚠️ A REPORT, NOT A DECISION. It takes no fleet admission lock and writes
// nothing — as the platform monitor reads `orgCensus`. Every statement is
// filtered by the one `organizationId`.
//
// ⚠️ A FAILED READ THROWS. The caller shows "not read"; a silent 0 would be a lie.

/** Waiting work behind one figure. The three always add up to every waiting job. */
export interface FleetWaitingCounts {
  /** Held by the org's own plan figure (`plan_cap`) — what a plan change fixes. */
  planLimit: number;
  /** Held because every account of the kind is full (`shard_capacity`). */
  poolFull: number;
  /** Every other reason, and a job no admission pass has judged yet. */
  other: number;
}

export interface FleetUseCounts {
  agentRuns: { inFlight: number; waiting: FleetWaitingCounts };
  ciJobs: { inFlight: number; waiting: FleetWaitingCounts };
  /** Agent instances are REFUSED at create and wake, never queued: no waits
   *  exist to count, which is not the same as zero waiting. */
  agentsRunning: { inFlight: number; waiting: null };
  /** Null when the plan sets no per-person figure (or could not be read). */
  agentsPerUser: { membersAtFigure: number | null; waiting: null };
  /** Held to no plan figure. */
  codeGraphIndex: { inFlight: number };
}

type WaitingBucket = keyof FleetWaitingCounts;

/** The ONE place a waiting reason gets a meaning. Keyed by the whole union, so a
 *  new deferral reason is a compile error here rather than a silent `other`. */
export const WAITING_BUCKET_BY_REASON: Record<AdmissionDeferralReason, WaitingBucket> = {
  plan_cap: 'planLimit',
  shard_capacity: 'poolFull',
  ai_plan_required: 'other',
  plan_unknown: 'other',
  fleet_ceiling: 'other',
  ci_credits_exhausted: 'other',
  credits_insufficient: 'other',
  balance_unavailable: 'other',
  gate_unavailable: 'other',
};

function bucketOf(reason: string | null): WaitingBucket {
  if (reason === null || !Object.hasOwn(WAITING_BUCKET_BY_REASON, reason)) return 'other';
  return WAITING_BUCKET_BY_REASON[reason as AdmissionDeferralReason];
}

/** Sum grouped waiting rows into the three buckets. A null reason (not judged
 *  yet) and an unrecognised one both land in `other`. */
export function bucketWaitingReasons(
  rows: ReadonlyArray<{ reason: string | null; count: number }>,
): FleetWaitingCounts {
  const out: FleetWaitingCounts = { planLimit: 0, poolFull: 0, other: 0 };
  for (const row of rows) out[bucketOf(row.reason)] += row.count;
  return out;
}

export const fleetUseCountsService = {
  /**
   * The org's fleet use counts at `now`. `figures.agentsPerUser` is the plan's
   * per-person figure, passed in by the caller (this service reads no plan);
   * null answers `membersAtFigure: null`. Throws when any read fails.
   */
  async countsFor(
    organizationId: string,
    figures: { agentsPerUser: number | null },
    now: Date,
  ): Promise<FleetUseCounts> {
    // Sequential on one `tx`, as `orgCensus` is: Prisma serialises a single
    // transaction's queries anyway.
    return withSystemContext(async (tx) => {
      const census = await fleetCeilingService.orgCensus(organizationId, now, tx);
      const agentSlots = await fleetInFlightSlotRepository.listLiveForOrganization(
        organizationId,
        'agent_instance',
        now,
        tx,
      );
      const agentsRunning = await agentInstanceRepository.countRunningOrAdmitting(
        organizationId,
        agentSlots.map((slot) => slot.ref),
        tx,
      );
      const ciWaiting = await intents.countPendingForOrganizationByWaitingReason(
        organizationId,
        tx,
      );
      const runsWaiting = await dispatchRunRepository.countWaitingHostedForOrganizationByReason(
        organizationId,
        now,
        tx,
      );
      let membersAtFigure: number | null = null;
      if (figures.agentsPerUser !== null) {
        // `organization_membership` has no system arm: its rows are visible only
        // under the org's own GUC, bound here from the caller's TRUSTED org id.
        // The member's agents in OTHER orgs still count — read through
        // `agent_instance`'s system read arm, exactly as the per-user cap reads them.
        await bindOrganizationContext(tx, organizationId);
        membersAtFigure = await agentInstanceRepository.countMembersAtLiveFigure(
          organizationId,
          figures.agentsPerUser,
          tx,
        );
      }

      return {
        agentRuns: {
          inFlight: census.byWorkload.hosted_agent,
          waiting: bucketWaitingReasons(runsWaiting),
        },
        ciJobs: {
          inFlight: census.byWorkload.ci_runner,
          waiting: bucketWaitingReasons(
            ciWaiting.map((row) => ({ reason: row.waitingReason, count: row.count })),
          ),
        },
        agentsRunning: { inFlight: agentsRunning, waiting: null },
        agentsPerUser: { membersAtFigure, waiting: null },
        codeGraphIndex: { inFlight: census.byWorkload.code_graph_index },
      };
    });
  },
};
