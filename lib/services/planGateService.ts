import type { ApprovalGate, Plan, Prisma } from '@/generated/prisma/client';
import { planSubjectVersion } from '@/lib/approvalGates/planApprovalDigest';
import { currentPlanSubject, resolvePlanGateRoute } from '@/lib/approvalGates/planApprovalHandler';
import {
  approvalGateRepository,
  type LiveSupersedeCause,
} from '@/lib/repositories/approvalGateRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { planWalkCompletenessService } from '@/lib/services/planWalkCompletenessService';

// THE PLAN GATE'S LIFECYCLE — when a `plan_approval` gate is RAISED, and when it is
// WITHDRAWN (Story MOTIR-6012 · Subtask MOTIR-6036; ADR `approval-gates.md` §11.5,
// §11.5c, §11.7, §11.8).
//
// The one place a plan gate is asked or withdrawn. The plain status writers (§11.8)
// keep writing `Plan.status` themselves and call in here, INSIDE the transaction that
// writes the status, so a plan is never `planned` without its question and a plan that
// stops being a question never keeps one:
//
//   · RAISE — `plansService.markPlanned` (the close, ≥1 proposal) and
//     `planDriftService.restoreForRevivedTarget` (`stale → planned`, a FRESH gate:
//     the old one was superseded while nobody could approve it). MOTIR-6039's backfill
//     calls the same `raise`.
//   · SUPERSEDE `plan_stale` — `planDriftService.markStaleForTerminalTarget`, and
//     `approvePlan`'s lazy backstop (`markStaleOnImmutableTarget`).
//   · SUPERSEDE `plan_discarded` — `withdrawProposal`'s LAST-proposal discard.
//   · SUPERSEDE `subject_gone` — `markPlanned`'s `stopped` close (Bug MOTIR-11701): a
//     re-opened plan whose revision ended unfinished is no longer a question.
//
// ⚠️ WHAT DOES NOT TOUCH THE GATE (§11.5c, §11.7), stated so nobody "completes" it:
//
//   · A REVISION. Since Bug MOTIR-8208 a revision RE-OPENS a `planned` plan to
//     `generating` while it runs and closes it again through `markPlanned` (whose
//     `raise` is then a no-op) — but it never supersedes the gate: the gate stays
//     `awaiting` and is HELD, derived from the revision lease by the handler
//     (`planGateHeldOf`), never written. Superseding would drop the row out of To
//     approve mid-conversation and re-raise it a moment later as a new question: two
//     rows in the record for one question. A revision that dies gives the plan back
//     to `planned` and calls `raise`, again a no-op over the gate still awaiting.
//   · A CORRECTION outside a lease (`update_plan_proposal`, `withdraw_plan_proposal`
//     short of the last). It moves the digest and supersedes nothing — the door's
//     stamp refuses a reader who read the old version (§11.3).
//   · THE ABANDONED-PLAN SWEEP (`abandonedPlanService`). It declines only `generating`
//     plans no revision re-opened, which have no gate; a re-opened plan it gives back
//     to `planned`, gate untouched. If it ever declines a `planned` one it owes a
//     supersede cause of its own under the enum's one-member-per-path rule.
//   · The EMPTY close. `markPlanned` over zero proposals writes `declined` /
//     `discarded`: there was never a question.
//
// ⚠️ THE LOCK ORDER — THE PLAN ROW, THEN THE GATE ROW (§11.5). The decide door takes
// the plan's lock before the gate's for this kind, so every writer here must too, or a
// busy project deadlocks. Both verbs TAKE the plan lock themselves before they touch a
// gate row: a caller that already holds it re-locks a row its own transaction holds,
// which Postgres treats as a no-op, and a caller that does not (the backfill) cannot
// get the order wrong.

const KIND = 'plan_approval' as const;

/** The two causes a plan-side writer withdraws a plan gate with (§11.7). */
export type PlanGateSupersedeCause = Extract<
  LiveSupersedeCause,
  // `subject_gone` (Bug MOTIR-11701): a re-opened plan's revision closed `stopped`, so
  // the plan is no longer a question — its subject no longer resolves (`currentPlanSubject`
  // reads `planned` only), which is the sentence that cause already says.
  'plan_stale' | 'plan_discarded' | 'subject_gone'
>;

/**
 * Whether a plan asks a question RIGHT NOW (§11.7 row 1): it is `planned` and holds at
 * least one proposal. Returns the gate's subject id (the plan's), or null. The ONE
 * predicate both {@link planGateService.raise} and {@link planGateService.assess} use,
 * so the backfill's `--dry-run` cannot disagree with the raise it rehearses.
 */
async function askedSubjectOf(
  plan: Pick<Plan, 'id' | 'workspaceId'>,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  const subjectId = await currentPlanSubject(plan.id, plan.workspaceId, tx);
  if (!subjectId) return null;
  if ((await planItemRepository.countByPlan(plan.id, tx)) === 0) return null;
  // ⚠️ AN UNFINISHED WALK ASKS NOTHING (Bug MOTIR-11701). Every raise path —
  // the close, a drift restore, a revision's give-back, the backfill — reads this
  // predicate, so a `planned` row whose walk is owed a card (a legacy close from
  // before `stopped` existed) is never put in front of a person as a question.
  if (!(await planWalkCompletenessService.readByIdWithin(plan.id, plan.workspaceId, tx)).complete) {
    return null;
  }
  return subjectId;
}

/**
 * What {@link planGateService.raise} WOULD do to a plan, read without writing
 * (MOTIR-6039's backfill; ADR §11.9):
 *
 *   · `raise`           — a question with no awaiting gate: a raise inserts one.
 *   · `already_awaiting` — a question already asked: a raise is a no-op.
 *   · `no_proposals`    — `planned` but empty: nothing to ask.
 *   · `walk_incomplete` — `planned` with proposals, but its walk is owed a card (Bug
 *                         MOTIR-11701): nothing to ask until a Resume finishes it.
 *   · `not_planned`     — any other status (or gone): nothing to ask.
 */
export type PlanGateAssessment =
  | 'raise'
  | 'already_awaiting'
  | 'no_proposals'
  | 'walk_incomplete'
  | 'not_planned';

/** What {@link planGateService.raise} did. */
export interface PlanGateRaise {
  /** True when THIS call inserted the awaiting row. */
  raised: boolean;
  /** The plan's awaiting gate after the call — this call's, or the one it found —
   *  absent when the plan asks nothing (not `planned`, or no proposals). */
  gate?: ApprovalGate;
}

export const planGateService = {
  /**
   * RAISE the plan's `awaiting` gate, when the plan is a question right now: it is
   * `planned` and holds at least one proposal. Idempotent — a second call, or a
   * concurrent one, finds the first's row (the card-less partial unique index
   * resolves the race inside the statement, `ON CONFLICT DO NOTHING`).
   *
   * Routed per §11.6 (`resolvePlanGateRoute`), stamped with the digest it was raised
   * against. Reads the plan's status UNDER the plan lock, so a caller's stale copy
   * cannot raise a gate on a plan somebody decided meanwhile.
   */
  async raise(
    plan: Pick<Plan, 'id' | 'workspaceId' | 'projectId' | 'createdById'>,
    tx: Prisma.TransactionClient,
  ): Promise<PlanGateRaise> {
    await planRepository.lockById(plan.id, tx);
    const subjectId = await askedSubjectOf(plan, tx);
    if (!subjectId) return { raised: false };
    const raised = await approvalGateRepository.createCardlessAwaitingIfAbsent(
      {
        workspaceId: plan.workspaceId,
        projectId: plan.projectId,
        kind: KIND,
        subjectId,
        routedToId: await resolvePlanGateRoute(plan, tx),
        subjectVersion: await planSubjectVersion(plan.id, tx),
      },
      tx,
    );
    // Under the plan lock the row just raised — or the winner's — is the one awaiting.
    const [gate] = await approvalGateRepository.findAwaitingCardlessBySubject(KIND, subjectId, tx);
    return { raised, gate };
  },

  /**
   * PREDICT a {@link planGateService.raise} without writing (the backfill's `--dry-run`,
   * and the real run's classification of a plan the raise skipped). Shares the raise's
   * own predicate ({@link askedSubjectOf}); the only extra read is the awaiting row the
   * raise's `ON CONFLICT DO NOTHING` would collide with. Lock-free: a rehearsal must not
   * hold plan locks against live traffic, and a caller that needs the answer to be
   * stable reads it after `raise` has taken the lock in the same transaction.
   */
  async assess(
    plan: Pick<Plan, 'id' | 'workspaceId'>,
    tx: Prisma.TransactionClient,
  ): Promise<PlanGateAssessment> {
    const subjectId = await askedSubjectOf(plan, tx);
    if (!subjectId) {
      const row = await planRepository.findById(plan.id, plan.workspaceId, tx);
      if (row?.status !== 'planned') return 'not_planned';
      return (await planItemRepository.countByPlan(plan.id, tx)) === 0
        ? 'no_proposals'
        : 'walk_incomplete';
    }
    const [awaiting] = await approvalGateRepository.findAwaitingCardlessBySubject(
      KIND,
      subjectId,
      tx,
    );
    return awaiting ? 'already_awaiting' : 'raise';
  },

  /**
   * WITHDRAW the plan's `awaiting` gate, saying why. `cause` is REQUIRED — the
   * repository's rule (a supersede that cannot say why reads as a false sentence on
   * every surface). Returns how many rows moved: 0 when nothing was awaiting (a plan
   * raised before this shipped, or already decided through the door).
   */
  async supersede(
    planId: string,
    cause: PlanGateSupersedeCause,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    await planRepository.lockById(planId, tx);
    return approvalGateRepository.supersedeAwaitingCardlessBySubject(KIND, planId, cause, tx);
  },

  /**
   * The plan's `awaiting` gate, or null when nobody is being asked about it (MOTIR-6038;
   * ADR §11.8). READ-ONLY and lock-free: a caller that must act on the answer reads it
   * under the plan lock it already holds (`approvePlan` / `declinePlan`'s plain bodies,
   * which refuse while a question is asked), so a raise — which takes the same lock —
   * cannot land between the read and the write.
   */
  async awaitingFor(planId: string, tx: Prisma.TransactionClient): Promise<ApprovalGate | null> {
    const [gate] = await approvalGateRepository.findAwaitingCardlessBySubject(KIND, planId, tx);
    return gate ?? null;
  },
};
