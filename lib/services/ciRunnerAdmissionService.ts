import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import {
  ciFleetAdmissionLockRepository as locks,
  FLEET_ADMISSION_SCOPE,
} from '@/lib/repositories/ciFleetAdmissionLockRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { resolveAdmissionCoverage } from '@/lib/ciMetering/allowance';
import { fleetKillSwitchEngaged } from '@/lib/ciFleet/limits';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import {
  ciBurstDetail,
  fleetCeilingService,
  describeFleetCensus,
  FLEET_KILL_SWITCH_DETAIL,
  planUnknownCapDetail,
} from '@/lib/services/fleetCeilingService';

// THE PROVISIONING GATE (Story MOTIR-1916 · MOTIR-1922, re-cut by MOTIR-6906 ·
// MOTIR-6907) — the one place that answers *should this intent get a runner at
// all?*, decided under a lock before anything is spent.
// `docs/decisions/fleet-per-org-pool.md` is the record.
//
// The guards, one call site, because they are answers to the same question about
// the same intent:
//
//   1. THE KILL SWITCH — `MOTIR_FLEET_MAX_IN_FLIGHT=0` stops every boot (§6).
//      What the fleet-wide ceiling (MOTIR-1997) became; nothing else of it is
//      left.
//   2. THE PLAN'S CI BURST CAP (MOTIR-9375; the fleet-capacity decision record
//      MOTIR-9357) — Standard 5, Pro 10, Max 25, Host and `pool_*` 50 — judged
//      against the org's in-flight CI RUNNERS alone (`orgCensus().byWorkload`),
//      so a hosted-agent run or an index container never keeps a CI job
//      waiting, and another org's work never does. `Organization.fleetPoolCap`,
//      set by platform staff, overrides that one figure
//      (`fleetCeilingService.resolveCiBurstCap`); Motir's own orgs with no
//      override are held by no figure. A plan that cannot be read defers
//      `plan_unknown`, whatever the override. It replaces the retired 500-container
//      org pool and MOTIR-1922's per-project tier caps.
//   2b. THE ACCOUNT (AMENDMENT 1, MOTIR-8968) — which account of the job's fleet
//      kind its machine boots on: none (the process-wide Fly fleet) while the
//      kind's switch is Fly, else the kind's shared account with the most
//      headroom. Every account full defers `shard_capacity`. Chosen and written
//      at the claim, in the same locked transaction, so the per-account count
//      is exact.
//   3. ADMISSION BY COVERAGE (§3, MOTIR-6911) — the org's remaining included
//      minutes plus its balance must pay for every charged container it runs
//      AND this one, for one debit period (`resolveAdmissionCoverage`). The
//      numbers come from the SHIPPED `ciAllowanceService.getEntitlementState`,
//      so the billing panel, MOTIR-1907's Actions pause and this gate read the
//      same pool, consumption and balance. An exhausted org still defers
//      `ci_credits_exhausted`; one that is not exhausted but cannot cover
//      running + 1 defers `credits_insufficient`.
//
// ⚠️ WHY THIS EXISTS AT ALL — the safety valve that was removed. Moving off
// GitHub-hosted runners removed the account-wide 60-concurrent-job cap, which
// had been bounding BOTH one tenant's spend and one tenant's ability to starve
// the others, by accident rather than by design. Nothing external replaces it.
// `notes.html` #185 is the lesson that says what must: enforcement expressed in
// terms the PRODUCT controls, so that changing provider changes nothing about
// what stops the spend.
//
// ── THE DELIBERATE ASYMMETRY ────────────────────────────────────────────────
// There is none any more (MOTIR-6911). Every guard fails CLOSED: an org's pool,
// its count or its balance that cannot be established means do NOT boot — a
// queued job is recoverable while a container nothing pays for is not. The
// balance is the one that used to fail open; it now defers `balance_unavailable`
// (§4), while the billing panel's own read keeps tolerating a null balance for
// display. Nothing already RUNNING is stopped for an unreadable balance.
//
// ── WHY THE CREDIT READ IS NOT INSIDE THE LOCKED TRANSACTION ────────────────
// It cannot be, and it should not be. `getEntitlementState` opens its own
// transaction under the ORG GUC (its membership read has no `system_admin`
// escape) and crosses the open-core boundary to motir-ai for the balance. Holding
// the FLEET-WIDE lock — which every admission in the system queues behind —
// across an HTTP call to another service would serialize the entire fleet behind
// motir-ai's latency, and a motir-ai timeout would become a fleet outage. So the
// pool is decided and the slot is CLAIMED under the lock; the credit state is
// read after, and a refusal RELEASES the claim. The window between them is
// microseconds of local work and errs toward the pool, never past it: for that
// moment the intent occupies a slot it may not keep. The CI burst cap — the plan
// and its override — is read BEFORE the lock for the same reason (a remote read
// and an org-GUC read).

/** Why an intent was not admitted. Every one of these leaves the intent PENDING,
 *  so the provisioning sweep retries it — a deferral, never a rejection. */
export type AdmissionDeferralReason =
  /** The organisation has no paid AI plan (MOTIR-6909) — the fleet is
   *  paid-AI-plan only. */
  | 'ai_plan_required'
  /** The organisation's AI plan could not be read. FAIL-CLOSED. */
  | 'plan_unknown'
  /** The org already runs as many CI jobs as its plan's CI burst cap (or its
   *  staff override) allows (MOTIR-9375). Only that org waits. */
  | 'plan_cap'
  /** The operator's kill switch is engaged (`MOTIR_FLEET_MAX_IN_FLIGHT=0`). */
  | 'fleet_ceiling'
  /** The org is past its pool AND out of credits. */
  | 'ci_credits_exhausted'
  /** The org's remaining minutes and credits do not cover its running charged
   *  containers plus this one for one debit period (§3). */
  | 'credits_insufficient'
  /** The org's credit balance could not be read. FAIL-CLOSED (§4). */
  | 'balance_unavailable'
  /** The gate itself could not decide. FAIL-CLOSED: an unestablished count is
   *  treated as a full pool, not an empty one. */
  | 'gate_unavailable'
  /** Every account of the job's fleet kind is full (AMENDMENT 1, MOTIR-8968):
   *  Motir's capacity, not the org's, is used up. */
  | 'shard_capacity';

export type AdmissionVerdict =
  /** Admitted AND CLAIMED — the intent is now `provisioning` and the caller owns
   *  it. `ciInFlight` is the org's CI runner count at the decision and
   *  `ciBurstCap` the figure it was judged against (`null`: none held it), for
   *  the caller's log. `fleetShardId` is the account its machine boots on; null
   *  = the process-wide fleet. */
  | {
      outcome: 'admitted';
      ciInFlight: number;
      ciBurstCap: number | null;
      fleetShardId: string | null;
    }
  /** Another provisioner claimed it first. Not an error; the compare-and-set
   *  worked. */
  | { outcome: 'already_claimed' }
  /** Not admitted. The intent is still `pending`. */
  | { outcome: 'deferred'; reason: AdmissionDeferralReason; detail: string };

/** The words a `credits_insufficient` deferral carries (`fleet-per-org-pool.md` §4). */
export const CREDITS_INSUFFICIENT_DETAIL =
  "Your organization's remaining CI minutes and credits do not cover another container. Add credits to run it.";

/** The words a `balance_unavailable` deferral carries (`fleet-per-org-pool.md` §4). */
export const BALANCE_UNAVAILABLE_DETAIL =
  "Motir could not read this organization's credit balance. The job starts as soon as it can.";

/** The words a `ci_credits_exhausted` deferral carries. */
export const CREDITS_EXHAUSTED_DETAIL = 'the org is past its included pool and out of credits';

/** A credit deferral, as admission returns it. */
export type CreditDeferral = {
  outcome: 'deferred';
  reason: 'ci_credits_exhausted' | 'credits_insufficient' | 'balance_unavailable';
  detail: string;
};

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

export const ciRunnerAdmissionService = {
  /**
   * Decide whether ONE provisioning intent may boot, and CLAIM it if so.
   *
   * The claim is part of the decision rather than a separate step the caller
   * takes afterwards, and that is the load-bearing detail: the claim is what
   * makes the intent count as in-flight, so a gate that decided and then let
   * someone else claim would be deciding from a count that does not yet include
   * the decisions already made. Deciding and claiming in ONE transaction, under
   * the lock, is what makes the caps exact.
   *
   * Never throws. Every refusal is a typed verdict, because the caller is a
   * background job: a throw becomes an Inngest retry, and retrying "the fleet is
   * full" achieves nothing a queued intent and the next sweep do not.
   */
  async admit(intent: CiRunnerProvisioningIntent): Promise<AdmissionVerdict> {
    // ONE instant for the whole decision. The census compares slot expiries
    // against it, and a gate that re-read the clock per workload could count a
    // slot as live for one workload and expired for the next.
    const now = new Date();
    const verdict = await this.decide(intent, now);
    // WHY IT WAITS (MOTIR-9666) — recorded AFTER the decision, outside the
    // fleet-wide lock, so the lock is held exactly as long as before and a write
    // that fails can never roll a correct verdict into `gate_unavailable`.
    if (verdict.outcome === 'deferred') {
      await this.recordWaitingReason(intent.id, verdict.reason, now);
    }
    return verdict;
  },

  /** {@link admit}'s decision itself: every guard, and the claim. */
  async decide(intent: CiRunnerProvisioningIntent, now: Date): Promise<AdmissionVerdict> {
    // ── 1 · THE KILL SWITCH ───────────────────────────────────────────────────
    if (fleetKillSwitchEngaged()) {
      return { outcome: 'deferred', reason: 'fleet_ceiling', detail: FLEET_KILL_SWITCH_DETAIL };
    }

    // ── 1b · THE PAID-AI-PLAN GATE (MOTIR-6909) — plan, then figure, then credits
    const refused = await fleetCeilingService.planDeferral(intent.organizationId);
    if (refused) return refused;

    // ── 1c · THE CI BURST CAP — read BEFORE the lock (MOTIR-9375) ─────────────
    const cap = await fleetCeilingService.resolveCiBurstCap(intent.organizationId);
    if (cap.kind === 'plan_unknown') {
      // FAIL CLOSED: no figure is ever assumed for a plan nobody could read.
      return {
        outcome: 'deferred',
        reason: 'plan_unknown',
        detail: planUnknownCapDetail(cap.planKey),
      };
    }
    if (cap.kind === 'unreadable') {
      return {
        outcome: 'deferred',
        reason: 'gate_unavailable',
        detail: "could not read the organization's CI burst cap",
      };
    }

    // ── 2 · The org's CI figure, and the claim — one locked transaction ───────
    // The org's CHARGED containers at the decision — its CI runners and hosted
    // runs, which draw on the balance coverage is checked against (§3).
    let chargedRunning = 0;
    let claimed: AdmissionVerdict;
    try {
      claimed = await withSystemContext(async (tx) => {
        await locks.ensureScope(FLEET_ADMISSION_SCOPE, tx);
        if (!(await locks.lockScope(FLEET_ADMISSION_SCOPE, tx))) {
          throw new Error('the fleet admission lock could not be taken');
        }

        // Counted from inside this transaction rather than through
        // `fleetCeilingService.reserve` precisely because it ALREADY holds
        // `FLEET_ADMISSION_SCOPE` and is mid-claim — re-entering would deadlock
        // the gate against itself. The CI count ALONE decides: the org's hosted
        // runs and index containers take none of CI's room.
        const census = await fleetCeilingService.orgCensus(intent.organizationId, now, tx);
        const ciInFlight = census.byWorkload.ci_runner;
        if (cap.kind === 'capped' && ciInFlight >= cap.figure) {
          return {
            outcome: 'deferred' as const,
            reason: 'plan_cap' as const,
            detail: `${ciBurstDetail(cap, ciInFlight)} (${describeFleetCensus(census)})`,
          };
        }

        // WHICH ACCOUNT (MOTIR-8968), chosen under the same lock the claim takes.
        const placement = await fleetShardAdmissionService.chooseInTx(
          { fleetKind: 'ci_runner', organizationId: intent.organizationId },
          now,
          tx,
        );
        if ('deferred' in placement) {
          await intents.markShardCapacityDeferredInTx(intent.id, now, tx);
          return {
            outcome: 'deferred' as const,
            reason: 'shard_capacity' as const,
            // The org's own account's words when that is what is full (MOTIR-9586).
            detail: placement.detail,
          };
        }

        // TAKE THE SLOT. The compare-and-set on `pending` is what makes the
        // count above true of the world the moment this transaction commits.
        const took = await intents.claimPending(intent.id, tx, {
          fleetShardId: placement.shardId,
        });
        if (!took) return { outcome: 'already_claimed' as const };

        chargedRunning = census.byWorkload.ci_runner + census.byWorkload.hosted_agent;

        return {
          outcome: 'admitted' as const,
          ciInFlight,
          ciBurstCap: cap.kind === 'capped' ? cap.figure : null,
          fleetShardId: placement.shardId,
        };
      });
    } catch (err) {
      // FAIL CLOSED. The transaction rolled back, so nothing was claimed and the
      // intent is still pending — the next sweep retries it. A count that could
      // not be established is treated as a full pool.
      console.error('[ciRunnerAdmissionService] the admission gate failed — not booting', {
        intentId: intent.id,
        organizationId: intent.organizationId,
        detail: detailOf(err),
      });
      return {
        outcome: 'deferred',
        reason: 'gate_unavailable',
        detail: `the in-flight counts could not be established: ${detailOf(err)}`,
      };
    }

    if (claimed.outcome !== 'admitted') return claimed;

    // ── 3 · admission by coverage, on the claim we now hold ───────────────────
    const credit = await this.creditDeferral(intent.organizationId, chargedRunning);
    if (credit) {
      // Give the slot back. A refusal must not leave the intent occupying
      // capacity it is not using.
      await this.releaseClaim(intent.id);
      return credit;
    }

    return claimed;
  },

  /**
   * May this org start one more charged container, given `chargedRunning`
   * already running? Null when it may; otherwise the deferral.
   *
   * ⚠️ FAILS CLOSED (§3–§4, MOTIR-6911). A null balance — motir-ai unreachable —
   * defers `balance_unavailable`, and so does an entitlement read that throws:
   * either way nobody can say the container will be paid for. It USED to fail
   * open, on the argument that a motir-ai blip must not stop every tenant's CI;
   * the record keeps that half (nothing already running is stopped) and drops
   * the other (nothing new starts on a balance nobody could read).
   *
   * Off-cloud and the meta org need no special case HERE: the shipped service
   * answers `bypassed` for both, which admits. Re-deriving either condition
   * locally is what MOTIR-1922 forbade.
   */
  async creditDeferral(
    organizationId: string,
    chargedRunning: number,
  ): Promise<CreditDeferral | null> {
    let state: Awaited<ReturnType<typeof ciAllowanceService.getEntitlementState>>;
    try {
      state = await ciAllowanceService.getEntitlementState(organizationId, new Date());
    } catch (err) {
      console.error(
        '[ciRunnerAdmissionService] could not read CI entitlement — not booting (fail-closed)',
        { organizationId, detail: detailOf(err) },
      );
      return {
        outcome: 'deferred',
        reason: 'balance_unavailable',
        detail: BALANCE_UNAVAILABLE_DETAIL,
      };
    }
    if (state.state === 'bypassed') return null;

    const coverage = resolveAdmissionCoverage({
      consumptionMinutes: state.consumedMinutes,
      poolMinutes: state.poolMinutes,
      balance: state.balance,
      chargedRunning,
    });
    switch (coverage) {
      case 'covered':
        return null;
      case 'ci_credits_exhausted':
        return {
          outcome: 'deferred',
          reason: 'ci_credits_exhausted',
          detail: CREDITS_EXHAUSTED_DETAIL,
        };
      case 'credits_insufficient':
        return {
          outcome: 'deferred',
          reason: 'credits_insufficient',
          detail: CREDITS_INSUFFICIENT_DETAIL,
        };
      case 'balance_unavailable':
        console.error('[ciRunnerAdmissionService] the credit balance is unreadable — not booting', {
          organizationId,
        });
        return {
          outcome: 'deferred',
          reason: 'balance_unavailable',
          detail: BALANCE_UNAVAILABLE_DETAIL,
        };
    }
  },

  /** Record the reason a deferred intent waits now (MOTIR-9666). Best-effort:
   *  the reason is a reading for the tenant's Fleet use section, and the wait
   *  itself does not depend on it — a throw is logged and the verdict stands. */
  async recordWaitingReason(
    intentId: string,
    reason: AdmissionDeferralReason,
    at: Date,
  ): Promise<void> {
    try {
      await withSystemContext((tx) => intents.recordWaitingReasonInTx(intentId, reason, at, tx));
    } catch (err) {
      console.error('[ciRunnerAdmissionService] could not record why an intent waits', {
        intentId,
        reason,
        detail: detailOf(err),
      });
    }
  },

  /** Put a claimed intent back in the pending pool. Best-effort: the worst case
   *  is an intent that sits in `provisioning` until the stale-claim sweep writes
   *  it off, which is visible and bounded — a throw here would be neither. */
  async releaseClaim(intentId: string): Promise<void> {
    try {
      await withSystemContext((tx) => intents.releaseClaim(intentId, tx));
    } catch (err) {
      console.error('[ciRunnerAdmissionService] could not release a claim', {
        intentId,
        detail: detailOf(err),
      });
    }
  },

  /** {@link releaseClaim} for a boot whose every account refused (MOTIR-8968):
   *  the claim goes back, the intent's first `shard_capacity` deferral is
   *  stamped, and its waiting reason reads `shard_capacity` (MOTIR-9666). Best-effort for the same reason. */
  async releaseClaimForShardCapacity(intentId: string, at: Date): Promise<void> {
    try {
      await withSystemContext(async (tx) => {
        await intents.releaseClaim(intentId, tx);
        await intents.markShardCapacityDeferredInTx(intentId, at, tx);
        // The claim cleared the waiting reason; the job waits again, for a full
        // pool, from now — without waiting for the next sweep pass (MOTIR-9666).
        await intents.recordWaitingReasonInTx(intentId, 'shard_capacity', at, tx);
      });
    } catch (err) {
      console.error('[ciRunnerAdmissionService] could not release a claim for shard capacity', {
        intentId,
        detail: detailOf(err),
      });
    }
  },

  /** {@link releaseClaim} for a boot that failed transiently: counts the attempt
   *  as it re-queues the intent (MOTIR-8941). Best-effort for the same reason. */
  async releaseClaimForRetry(intentId: string): Promise<void> {
    try {
      await withSystemContext((tx) => intents.releaseClaimForRetry(intentId, tx));
    } catch (err) {
      console.error('[ciRunnerAdmissionService] could not release a claim for retry', {
        intentId,
        detail: detailOf(err),
      });
    }
  },
};
