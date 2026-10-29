import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { ciPeriodChargeRepository } from '@/lib/repositories/ciPeriodChargeRepository';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { debitCiOverage, getOrgUsage } from '@/lib/ai/motirAiClient';
import { isCiMeteringEnabled } from '@/lib/ciMetering/config';
import { periodEndFor, periodStartFor } from '@/lib/ciMetering/period';
import { computeIncrementalCharge, resolvePool, resolveState } from '@/lib/ciMetering/allowance';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';

// The CI-minutes ENTITLEMENT (Story MOTIR-1775 · MOTIR-1901) — the CHARGING half
// of the contract in `docs/decisions/ci-minutes-allowance.md`, sitting on top of
// MOTIR-1896's meter.
//
// The meter answers "how many Linux-equivalent minutes did this org burn this
// month?" and stops there. This service answers the three questions after it:
//
//   1. HOW MANY WERE FREE?   §1  — pool = max(members × 300, 1000), recomputed
//                                  from org MEMBERSHIP at read time (§4.2/§4.6),
//                                  never accrued and never from Stripe's lagging
//                                  seat quantity.
//   2. WHAT DOES THE REST COST?  §2  — 1 credit per Linux-equivalent minute,
//                                  debited to motir-ai's ledger AFTER the local
//                                  commit (§8.6).
//   3. CAN THE NEXT DISPATCH RUN? §6 — TWO thresholds, never conflated: crossing
//                                  the POOL keeps work running and merely starts
//                                  drawing credits; balance ≤ 0 REFUSES.
//
// ⚠️ SCOPE — this owns the DISPATCH-side refusal ONLY. It cannot by itself stop
// GitHub billing Motir: a push, a fix-up commit, the admin-collaborator grant
// (MOTIR-1900) and repo-resident triggers all reach Actions with no claim. Pausing
// Actions at the REPOSITORY is MOTIR-1907's job, and it drives that off
// `getEntitlementState` — which is why that state is a returned VALUE rather than
// a private branch inside the claim handler.

/** What one charge attempt did — returned for logging + tests, never thrown. */
export type CiChargeOutcome =
  /** Off-cloud, no provisioning org, or the META org — no accounting at all. */
  | { outcome: 'bypassed'; reason: 'disabled' | 'meta' }
  /** Nothing new to account for: a replay, or a racer already charged it. */
  | { outcome: 'no_new_consumption' }
  /** New minutes accounted, all still inside the pool — the ledger is untouched. */
  | { outcome: 'within_allowance'; accountedMinutes: number; poolMinutes: number }
  /** Overage accrued but under a whole credit — carried, not rounded away. */
  | { outcome: 'carried'; chargeableMinutes: number; chargedMinutes: number }
  /** Credits were booked locally AND confirmed by motir-ai's ledger. */
  | {
      outcome: 'charged';
      creditsToDebit: number;
      chargeableMinutes: number;
      balanceAfter: number;
      exhausted: boolean;
      idempotent: boolean;
    }
  /** Booked locally; the cross-boundary debit failed and is pending retry (§8.6). */
  | { outcome: 'debit_pending'; creditsToDebit: number; externalRef: string; detail: string };

/**
 * The idempotency key for one debit. It names the WATERMARK the debit advances
 * (`from → to` whole credits), not the run that triggered it — so a retry of a
 * timed-out debit reproduces the SAME ref and motir-ai's `externalRef` uniqueness
 * makes the replay a no-op. A run-keyed ref could not do that: a retry issued on
 * a later metering event would carry a different run id, motir-ai would see a new
 * charge, and an org whose first attempt actually landed would be billed twice.
 */
function debitRef(organizationId: string, periodStart: Date, from: number, to: number): string {
  const period = periodStart.toISOString().slice(0, 7); // YYYY-MM
  return `${organizationId}:${period}:${from}-${to}`;
}

/** One describer for every boundary failure this service logs, so the three
 *  call sites cannot drift into reporting the same condition differently. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const ciAllowanceService = {
  /**
   * THE READABLE STATE — the card's second output, and a deliberate public one:
   * *"EXPOSE the `ci_credits_exhausted` / `drawing_on_credits` /
   * `within_allowance` state as a readable service result … the state is this
   * card's output, not a private branch inside the claim handler."*
   *
   * MOTIR-1907 drives the repository-side Actions pause off it; MOTIR-1902/1903
   * render it as the billing panel's "Motir CI" line (§7.3 wants every field
   * here). Both would otherwise have to re-derive the pool and re-read the
   * balance, which is how two surfaces come to disagree about whether an org is
   * exhausted.
   *
   * The balance read crosses to motir-ai, so it can fail. That is reported as
   * `balance: null` rather than thrown or defaulted to 0: a transport blip must
   * not render as "you are out of credits", and it must not refuse dispatch
   * (§6.4 already accepts a bounded overshoot as the honest cost of compute that
   * cannot be un-run). Failing CLOSED on Motir's own outage would be the worse
   * error.
   */
  async getEntitlementState(organizationId: string, at: Date): Promise<CiEntitlementStateDTO> {
    const periodStart = periodStartFor(at);
    const base = {
      organizationId,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEndFor(periodStart).toISOString(),
    };

    // §8.5 — off-cloud there is no meter, no pool, no overage and no refusal.
    if (!isCiMeteringEnabled()) {
      return {
        ...base,
        applicable: false,
        internal: false,
        memberCount: 0,
        poolMinutes: 0,
        floorApplied: false,
        consumedMinutes: 0,
        consumedBySource: { ci: 0, preview: 0 },
        remainingMinutes: 0,
        overageMinutes: 0,
        chargedCredits: 0,
        balance: null,
        state: 'bypassed',
      };
    }

    // Membership + the charge row + `isMeta` all read under the ORG GUC. This is
    // the correct context and `withSystemContext` would be a silent bug: the
    // `org_membership_visible_active_or_own` policy has NO system escape, so a
    // system-context read returns ZERO members in production (where the app
    // connects as the non-BYPASSRLS `motir_app` role) and every org would
    // silently collapse to the 1,000-minute floor. Same trap the meter documents
    // for `project_repository`.
    const org = await withOrgServiceWriteContext(organizationId, async (tx) => {
      const organization = await organizationRepository.findByIdInTx(organizationId, tx);
      const memberCount = await organizationMembershipRepository.countByOrg(organizationId, tx);
      const charge = await ciPeriodChargeRepository.findForPeriod(organizationId, periodStart, tx);
      // A missing org row defaults to non-meta — the safe direction (it accounts
      // rather than silently bypassing), as `resolveTenantOrg` does.
      return { isMeta: organization?.isMeta ?? false, memberCount, charge };
    });

    // §4.4 — the META org is bypassed entirely: no pool, no overage, no charge,
    // no refusal. moooon B.V. pays its own bill directly; metering the ALLOWANCE
    // would bill the house to itself. The MEASUREMENT is still recorded for it
    // (MOTIR-5283), and Billing & plans shows that figure on an internal CI line
    // so the team can see what its own fleet runner costs — read here, never
    // turned into a pool or a charge.
    if (org.isMeta) {
      const consumption = await ciMinutesMeterService.getOrgPeriodConsumption(organizationId, at);
      return {
        ...base,
        applicable: false,
        internal: true,
        memberCount: org.memberCount,
        poolMinutes: 0,
        floorApplied: false,
        consumedMinutes: consumption.linearEquivalentMinutes,
        consumedBySource: consumption.bySource,
        remainingMinutes: 0,
        overageMinutes: 0,
        chargedCredits: 0,
        balance: null,
        state: 'bypassed',
      };
    }

    const pool = resolvePool(org.memberCount);
    const consumption = await ciMinutesMeterService.getOrgPeriodConsumption(organizationId, at);
    const consumedMinutes = consumption.linearEquivalentMinutes;
    const balance = await readBalance(organizationId);

    return {
      ...base,
      applicable: true,
      internal: false,
      memberCount: pool.memberCount,
      poolMinutes: pool.poolMinutes,
      floorApplied: pool.floorApplied,
      consumedMinutes,
      consumedBySource: consumption.bySource,
      remainingMinutes: Math.max(0, pool.poolMinutes - consumedMinutes),
      overageMinutes: Math.max(0, consumedMinutes - pool.poolMinutes),
      chargedCredits: org.charge?.chargedCredits ?? 0,
      balance,
      state: resolveState({
        consumptionMinutes: consumedMinutes,
        poolMinutes: pool.poolMinutes,
        balance,
      }),
    };
  },

  /**
   * THE REFUSAL (§6.2–6.3) — called on the paths that HAND OUT WORK, so the user
   * sees it BEFORE waiting on a run rather than after one.
   *
   * Throws `CiCreditsExhaustedError` only in the `ci_credits_exhausted` state:
   * past the pool AND balance ≤ 0. Crossing the pool alone never refuses — that
   * is §6.1's normal, visible `drawing_on_credits` event, and conflating the two
   * would block orgs that are still inside their allowance.
   *
   * Any other failure (motir-ai unreachable, no org resolvable, metering off) is
   * NOT a refusal: dispatch proceeds. A gate that fails closed on its own
   * dependency's outage would take the whole agent loop down with it, and §6.4
   * already prices the bounded overshoot that letting a run through can cause.
   */
  async assertDispatchAllowed(ctx: { userId: string; workspaceId: string }): Promise<void> {
    if (!isCiMeteringEnabled()) return;

    let state: CiEntitlementStateDTO;
    try {
      const { organizationId } = await resolveTenantOrg(ctx);
      state = await this.getEntitlementState(organizationId, new Date());
    } catch (err) {
      // Resolving the tenant or reading the state failed. Log and ALLOW — see
      // the fail-open reasoning above.
      console.error('[ciAllowanceService] dispatch gate could not resolve CI entitlement', err);
      return;
    }

    if (state.state !== 'ci_credits_exhausted') return;
    throw new CiCreditsExhaustedError({
      organizationId: state.organizationId,
      state: state.state,
      consumedMinutes: state.consumedMinutes,
      poolMinutes: state.poolMinutes,
      // `resolveState` only returns `ci_credits_exhausted` for a non-null balance
      // ≤ 0, so this coalesce is unreachable — it exists to keep the DTO's honest
      // nullability from leaking a `!` into the error payload.
      balance: state.balance ?? 0,
    });
  },

  /**
   * THE CHARGE (§4.6) — run once per METERED run, right after the meter's write
   * commits. *"Charge incrementally, at the metering event, against the pool as
   * it stood then — never by re-summing the period."*
   *
   * The shape, and why each piece is where it is:
   *
   *   * The decision is READ-DERIVED and CONTENDED (read consumption → read the
   *     watermark → decide → debit), so the (org, period) charge row is LOCKED
   *     `FOR UPDATE` and its state re-read INSIDE the transaction — `notes.html`
   *     #35, the rule a serial test cannot catch. Two runs completing at once
   *     would otherwise both read the same watermark and both bill the same
   *     minutes.
   *   * Consumption is read BEFORE the lock, and that is deliberate rather than
   *     sloppy: `ci_period_usage` is workspace-scoped with a `system_admin`
   *     escape, so it cannot be read under the org GUC this transaction needs for
   *     membership. It is safe because the watermark — not the consumption read —
   *     is what the decision is derived from: a racer that charged first has
   *     already advanced `accountedMinutes` past our figure, so we compute zero
   *     new minutes rather than double-billing, and the watermark never moves
   *     backwards.
   *   * The DEBIT crosses the open-core boundary, so it runs AFTER the local
   *     commit and is best-effort (§8.6; `notes.html` #39): a boundary failure
   *     leaves the metering and the local charge record intact, never fails the
   *     request, and leaves a pending ref the next event retries.
   */
  async chargeForMeteredRun(input: {
    organizationId: string;
    periodStart: Date;
    isMeta?: boolean;
  }): Promise<CiChargeOutcome> {
    if (!isCiMeteringEnabled()) return { outcome: 'bypassed', reason: 'disabled' };
    if (input.isMeta) return { outcome: 'bypassed', reason: 'meta' };

    const { organizationId, periodStart } = input;

    // Read the org's authoritative period consumption (the meter's ONE seam).
    // Outside the lock — see the method doc for why that is sound.
    const consumption = await ciMinutesMeterService.getOrgPeriodConsumption(
      organizationId,
      periodStart,
    );

    const decision = await withOrgServiceWriteContext(organizationId, async (tx) => {
      await ciPeriodChargeRepository.ensureRow(organizationId, periodStart, tx);
      // Non-null by construction: `ensureRow` just committed the row into this
      // same transaction, and the `FOR UPDATE` holds it for the rest of it. This
      // is an INVARIANT rather than optimism — a defensive `if (!locked) return`
      // here would be unreachable code that no test could honestly exercise.
      const locked = (await ciPeriodChargeRepository.lockForUpdate(
        organizationId,
        periodStart,
        tx,
      ))!;

      // The pool is recomputed from CURRENT membership on every charge (§4.6 —
      // "evaluated at read time from current membership, never accrued, never
      // prorated"), inside the lock so a concurrent membership change cannot
      // interleave between the read and the decision.
      const memberCount = await organizationMembershipRepository.countByOrg(organizationId, tx);
      const pool = resolvePool(memberCount);

      const computed = computeIncrementalCharge({
        consumptionMinutes: consumption.linearEquivalentMinutes,
        accountedMinutes: locked.accountedMinutes,
        chargedMinutes: locked.chargedMinutes,
        chargedCredits: locked.chargedCredits,
        poolMinutes: pool.poolMinutes,
      });

      // ⚠️ The amount to debit is the gap to what motir-ai has CONFIRMED
      // (`debitedCredits`), NOT this event's own increment. The two differ
      // exactly when an earlier debit failed: booking 100 fresh credits while 800
      // are still unconfirmed and debiting only the 100 would strand the 800
      // forever, because no later event ever revisits them. Pairing the amount
      // with a `from → to` watermark ref keeps the two definitions in lockstep.
      const outstandingCredits = computed.nextChargedCredits - locked.debitedCredits;

      // A debit is already outstanding. Do NOT issue a second one: it would need
      // its own ref while the first one's fate is still unknown, and if that
      // first attempt had in fact landed the org would be billed twice. The new
      // credits are still booked locally (`chargedCredits` grows), so the gap is
      // simply carried until the pending ref resolves — which the retry below
      // attempts on the next event that actually meters something.
      const hasPending = locked.pendingDebitRef !== null;
      const pendingDebitRef = hasPending
        ? locked.pendingDebitRef
        : outstandingCredits > 0
          ? debitRef(
              organizationId,
              periodStart,
              locked.debitedCredits,
              computed.nextChargedCredits,
            )
          : null;
      // When the slot was FIRST occupied (MOTIR-7316): kept while a debit stays
      // outstanding, stamped when one is first written, cleared with the slot. The
      // fleet monitor dates an unconfirmed debit from it, because this very write
      // moves `updatedAt` on every metered tick whether a debit is pending or not.
      const pendingDebitSince =
        pendingDebitRef === null ? null : (locked.pendingDebitSince ?? new Date());

      await ciPeriodChargeRepository.applyCharge(
        {
          organizationId,
          periodStart,
          accountedMinutes: computed.nextAccountedMinutes,
          chargedMinutes: computed.nextChargedMinutes,
          chargedCredits: computed.nextChargedCredits,
          pendingDebitRef,
          pendingDebitCredits: hasPending
            ? locked.pendingDebitCredits
            : Math.max(0, outstandingCredits),
          pendingDebitSince,
        },
        tx,
      );

      return { locked, pool, computed, hasPending, outstandingCredits, pendingDebitSince };
    });

    const { locked, pool, computed, hasPending, outstandingCredits, pendingDebitSince } = decision;

    // ── Everything below runs AFTER the transaction committed (§8.6). ──────────

    // Nothing new was accounted — a replay, or a racer that got there first.
    // Return BEFORE the pending retry: a burst of concurrent deliveries would
    // otherwise each re-attempt the same outstanding ref, turning one healing
    // retry into N redundant round-trips. Healing rides the next event that
    // actually meters something, which is the only one that needs it.
    if (computed.newMinutes === 0) return { outcome: 'no_new_consumption' };

    // A pending debit from an earlier event: retry it with its EXACT ref. This is
    // the only way to learn whether a timed-out debit landed — motir-ai answers
    // `idempotent: true` if it had.
    //
    // `confirmedCredits` is the ledger watermark AFTER that retry, and the rest of
    // this method must use it rather than `locked.debitedCredits`: a successful
    // retry has just advanced it, and billing the remainder from the stale value
    // would re-charge the credits the retry settled.
    let confirmedCredits = locked.debitedCredits;
    // A retry that settles CLEARS the pending slot, so a debit that then fails is
    // newly outstanding from now, not from when the settled one began.
    let outstandingSince = pendingDebitSince;
    if (hasPending && locked.pendingDebitRef) {
      const settled = await this.settlePendingDebit(organizationId, periodStart, locked);
      if (!settled) {
        return {
          outcome: 'debit_pending',
          creditsToDebit: locked.pendingDebitCredits,
          externalRef: locked.pendingDebitRef,
          detail: 'a prior CI-overage debit is still unconfirmed; the new charge is carried',
        };
      }
      confirmedCredits += locked.pendingDebitCredits;
      outstandingSince = null;
    }

    if (computed.chargeableMinutes === 0 && outstandingCredits <= 0) {
      return {
        outcome: 'within_allowance',
        accountedMinutes: computed.nextAccountedMinutes,
        poolMinutes: pool.poolMinutes,
      };
    }

    // What is left to send after the retry settled whatever it settled. Credits
    // booked while a debit was pending live HERE — they are the difference
    // between "booked locally" and "confirmed by the ledger", and billing this
    // gap (rather than just this event's own increment) is what stops them being
    // stranded forever once the outage clears.
    const remainingCredits = computed.nextChargedCredits - confirmedCredits;
    if (remainingCredits <= 0) {
      // Overage accrued but under a whole credit. §2's carry: booked in
      // `chargedMinutes`, billed once it reaches a credit. Not a no-op.
      return {
        outcome: 'carried',
        chargeableMinutes: computed.chargeableMinutes,
        chargedMinutes: computed.nextChargedMinutes,
      };
    }

    const externalRef = debitRef(
      organizationId,
      periodStart,
      confirmedCredits,
      computed.nextChargedCredits,
    );
    try {
      const result = await debitCiOverage({
        coreOrganizationId: organizationId,
        credits: remainingCredits,
        externalRef,
        reason:
          `${computed.chargeableMinutes} Linux-equivalent minutes over the ` +
          `${pool.poolMinutes}-minute included pool`,
      });
      await withOrgServiceWriteContext(organizationId, (tx) =>
        ciPeriodChargeRepository.settleDebit(
          { organizationId, periodStart, debitedCredits: computed.nextChargedCredits },
          tx,
        ),
      );
      return {
        outcome: 'charged',
        creditsToDebit: remainingCredits,
        chargeableMinutes: computed.chargeableMinutes,
        balanceAfter: result.balanceAfter,
        exhausted: result.exhausted,
        idempotent: result.idempotent,
      };
    } catch (err) {
      // §8.6 — the debit is a cross-boundary side effect. It must NOT roll back
      // the metering write and must NOT fail the request; it must only leave
      // enough behind for a SAFE retry.
      //
      // Re-persisting the pending slot here is not belt-and-braces: when the
      // retry above succeeded, `settleDebit` CLEARED the slot, so without this
      // write the next event would find no pending ref, mint a fresh one for the
      // same credits, and double-charge an org whose failed attempt had in fact
      // landed. Recording this exact ref is what makes the next retry a replay.
      const detail = describeError(err);
      console.error(
        '[ciAllowanceService] CI-overage debit failed; charge is booked locally and pending retry',
        { organizationId, externalRef, credits: remainingCredits, detail },
      );
      await withOrgServiceWriteContext(organizationId, (tx) =>
        ciPeriodChargeRepository.markPendingDebit(
          {
            organizationId,
            periodStart,
            debitedCredits: confirmedCredits,
            pendingDebitRef: externalRef,
            pendingDebitCredits: remainingCredits,
            pendingDebitSince: outstandingSince ?? new Date(),
          },
          tx,
        ),
      );
      return {
        outcome: 'debit_pending',
        creditsToDebit: remainingCredits,
        externalRef,
        detail,
      };
    }
  },

  /**
   * Retry ONE outstanding debit with its stored ref. Returns true when motir-ai
   * confirmed it (whether freshly applied or reported as an idempotent replay of
   * an attempt that had in fact landed), false when it is still unresolved.
   *
   * Exported on the service so a future operator/job path can drive it without
   * waiting for the org's next metered run.
   */
  async settlePendingDebit(
    organizationId: string,
    periodStart: Date,
    pending: {
      pendingDebitRef: string | null;
      pendingDebitCredits: number;
      debitedCredits: number;
    },
  ): Promise<boolean> {
    if (!pending.pendingDebitRef || pending.pendingDebitCredits <= 0) return true;
    try {
      await debitCiOverage({
        coreOrganizationId: organizationId,
        credits: pending.pendingDebitCredits,
        externalRef: pending.pendingDebitRef,
        reason: 'retry of a previously unconfirmed CI-overage debit',
      });
      await withOrgServiceWriteContext(organizationId, (tx) =>
        ciPeriodChargeRepository.settleDebit(
          {
            organizationId,
            periodStart,
            debitedCredits: pending.debitedCredits + pending.pendingDebitCredits,
          },
          tx,
        ),
      );
      return true;
    } catch (err) {
      console.error('[ciAllowanceService] retry of a pending CI-overage debit failed', {
        organizationId,
        externalRef: pending.pendingDebitRef,
        credits: pending.pendingDebitCredits,
        detail: describeError(err),
      });
      return false;
    }
  },
};

/**
 * The org's AI credit balance, or null when motir-ai could not be reached.
 *
 * Null rather than 0, and never a throw: a transport failure must not read as
 * exhaustion (it would refuse dispatch on Motir's own outage) and must not render
 * as a misleading zero on the billing panel — the same treatment `getOrgUsage`'s
 * other read-through caller gives it.
 */
async function readBalance(organizationId: string): Promise<number | null> {
  try {
    const usage = await getOrgUsage({ coreOrganizationId: organizationId, scope: 'org' });
    return usage.balance;
  } catch (err) {
    console.error('[ciAllowanceService] could not read the AI credit balance', {
      organizationId,
      detail: describeError(err),
    });
    return null;
  }
}
