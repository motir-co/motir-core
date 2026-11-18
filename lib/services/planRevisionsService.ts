// =================================================================
// The plan CONTENT trail (Story MOTIR-3532 · Subtask MOTIR-3535). Every
// `plansService` mutation — the open, an append, an edit, the close, and both
// decisions — calls `recordRevision` to persist ONE append-only row describing
// what it did, INSIDE the same transaction as the mutation itself.
//
// ⚠️ THE REQUIRED `tx` IS THE WHOLE GUARANTEE. A revision written AFTER the
// commit can be lost while the mutation stands; one written in its OWN
// transaction can commit while the mutation rolls back. Both produce a trail
// that LIES, in opposite directions, and a trail that can lie is worse than no
// trail — it is read as evidence. So the parameter is non-optional and the
// service owns no transaction of its own: it threads the caller's `tx` straight
// into the repository write.
//
// ⚠️ AND THIS IS NOT A SIDE EFFECT — the side-effects-outside-the-transaction
// rule in `CLAUDE.md` does NOT apply to it, however much the neighbouring code
// reads as though it must. That rule governs external I/O — email, webhooks,
// blob operations, event emits — whose failure must not roll back a durable
// write. This is a database write ABOUT a database write, in the same database,
// and its atomicity with the mutation is the entire point of the card. Nothing
// here is best-effort and nothing here is swallowed.
//
// Layer rules (CLAUDE.md): no transaction, no DTO mapping (the read path and its
// DTO are the sibling card's), no reads. `workItemRevisionsService` is the
// shipped precedent this mirrors exactly.

import type { PlanRevision, Prisma, WorkItemPlanningSource } from '@/generated/prisma/client';
import { INTERNAL_PLAN_REVISION_CHANGE_KINDS } from '@/lib/plans/revisionReason';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';

/**
 * The audit verb for a plan revision — one per mutation site, and the reader's
 * whole vocabulary for what happened to a plan's contents.
 *
 * The column is plain text rather than an enum (the `WorkItemRevision.changeKind`
 * call, made for the same reason), so a seventh verb is a code change rather than
 * a migration. `withdrawn` is that seventh verb, added by MOTIR-3540 exactly as
 * this comment anticipated — a proposal taken OFF a plan.
 *
 * ⚠️ `revision_started` / `revision_ended` are the eighth and ninth, and they are
 * not describing a change to a PROPOSAL at all — they BRACKET a revision, and the
 * pair IS the lease `agent-authored-plans.md` AMENDMENT 10 D2 decides on. A plan
 * holds a revision lease when the latest `revision_started` has no
 * `revision_ended` after it and the most recent row at or after it is inside
 * `PLAN_REVISION_LEASE_MS`; `approvePlan` / `declinePlan` refuse while it is
 * held. Putting the lease here rather than in a table keeps it and its
 * VISIBILITY the same record — a reviewer learns a revision is running by
 * reading the timeline they were already reading — and costs no migration,
 * which is the property this comment already promised.
 *
 * ⚠️ A STRUCTURAL CORRECTION stays `edited` rather than gaining a verb of its
 * own: it changes a proposal that is still on the plan, which is what `edited`
 * already means, and its `diff` carries `correction: true` plus the fields it
 * touched for a reader who needs to tell the two apart. A withdraw is a
 * different verb because the proposal STOPS EXISTING, which no `edited` row can
 * say. And it is `withdrawn`, not `removed`: a `remove` OP is a proposal to
 * delete an existing work item from the tree, so rendering a withdraw as
 * *"1 proposal removed"* would read to a reviewer as a card being deleted.
 *
 * ⚠️ `brief_edited` is the ELEVENTH (MOTIR-4637), and it is the second verb —
 * after `bug_filed` — that is not about a proposal at all. It records an edit to
 * the PLAN'S OWN `title` / `summary`, the two lines a reviewer reads above the
 * tree. It is deliberately NOT `edited`: that verb means *a proposal on this plan
 * changed*, the timeline renders it as `N proposal(s) edited`, and a row saying
 * so when no proposal moved would be a trail that lies — the one failure the
 * required `tx` above exists to prevent, arriving through the vocabulary instead.
 * It carries no `planItemId`, for the same reason the open and the close do not,
 * and its `diff` names the fields the call supplied.
 *
 * AND IT IS RECORDED RATHER THAN SILENT, which is the decision MOTIR-4637 owed
 * and states here: a `planned` plan is a thing a person is deciding about, so
 * rewriting the sentence they are reading without a trace would trade one honesty
 * problem for another.
 *
 * ⚠️ `bug_filed` is the tenth (Story MOTIR-4053 · MOTIR-4076), and it is the
 * first verb that describes a WORK ITEM rather than a proposal: the planning
 * job filed a real `bug` into its own project, unreviewed, and this row is where
 * a reviewer of the plan sees it (`planner-files-tenant-bug.md` §3, RECORD). It
 * carries no `planItemId` — there is no proposal — and its `diff` names the
 * filed key. The same rows are what the VOLUME bound counts, under the plan's
 * row lock, so the record and the cap cannot disagree.
 */
export type PlanRevisionChangeKind =
  | 'created'
  | 'appended'
  | 'edited'
  | 'withdrawn'
  | 'planned'
  // Bug MOTIR-11701: the close of a walk that ended before every card was written.
  | 'stopped'
  | 'approved'
  | 'declined'
  | 'revision_started'
  | 'revision_ended'
  | 'revision_renewed'
  | 'bug_filed'
  | 'brief_edited'
  | 'reason_classified'
  | 'session_carried';

/**
 * ⚠️ `session_carried` is the THIRTEENTH (Story MOTIR-7928 · MOTIR-7930), and like
 * `brief_edited` it is about the PLAN, not a proposal. It records the plan MOVING
 * to a new planning session: its session ended while it still waited, and its
 * owner's next turn carried the conversation and the plan into a new one
 * (`planChangeSessionsService.startCopied`). It carries no `planItemId`, its
 * `diff` is `{ fromSessionId, toSessionId }`, and `changedById` is the person
 * whose turn carried it. It is tenant-visible — a reviewer reading the trail sees
 * the plan change conversations — so it is NOT internal.
 */

/**
 * ⚠️ `reason_classified` is the TWELFTH (Story MOTIR-5543 · MOTIR-6083), and it
 * is the first verb that is not about the plan's CONTENTS at all — it records
 * WHY a change was asked of a plan that is not yet approved, on every one of the
 * four branches `REVISION_REASON_BRANCHES` names, including the two that file
 * nothing. Recording it on all four is the point: a silent "no bug" cannot be
 * told from a forgotten one, and a recorded *different solution, no bug* can be
 * checked.
 *
 * It carries no `planItemId` — the classification is about the REQUEST, not
 * about a proposal — its `diff` is `{ branch, planningBugId }`, and its prose
 * evidence rides `noteMd` because `diff` is count-shaped by contract.
 *
 * ⚠️ AND IT IS INTERNAL: it is Motir's own judgement about its own planner, so
 * NO tenant-facing read returns it. `INTERNAL_PLAN_REVISION_CHANGE_KINDS` is the
 * one list, and `planRevisionRepository` applies it at the QUERY.
 *
 * The assertion below is what keeps that list and this union honest: it lives
 * HERE, where the union is, because `lib/plans/revisionReason.ts` may not import
 * this file. A kind listed as internal that is not a real change kind fails to
 * compile.
 */
export const INTERNAL_CHANGE_KINDS =
  INTERNAL_PLAN_REVISION_CHANGE_KINDS satisfies readonly PlanRevisionChangeKind[];

/**
 * WHICH AGENT performed a change, when one did — the
 * `source · harness · model` triple `docs/decisions/work-item-provenance.md`
 * Decision 2 fixes, recorded PER ACT.
 *
 * Deliberately not read off the `Plan` row at render time: the plan's
 * `authorSource` says who WROTE the plan, and that stops being the answer the
 * moment a person edits or decides an agent-written one. A row that carries its
 * own actor cannot disagree with itself later.
 */
export interface PlanRevisionAgentActor {
  source: WorkItemPlanningSource | null;
  harness: string | null;
  model: string | null;
}

/**
 * The arguments a plan mutation passes when recording its revision.
 *
 * `changedById` is NULLABLE and the null is a MEANING — the same one
 * `Plan.createdById` documents for itself. `autoPlanCadenceService` runs the
 * watcher under the PROJECT OWNER's credential so the job has one; recording that
 * owner would attribute to a person an act they never performed. So a
 * generation-time write on a `cadence` plan passes null, while the review edit
 * and both decisions always pass their actor, because only a person reaches them.
 *
 * `diff` is intentionally loose (`Record<string, unknown>`): it carries a
 * COUNT-shaped payload whose shape varies per kind — how many proposals an append
 * carried, which fields an edit supplied, how many items a decision covered —
 * never the proposal bodies themselves.
 *
 * ⚠️ The `planned` row's `summary` (MOTIR-11487) is the plan's OWN briefing as
 * that version closed with it — the plan-level text `brief_edited` already names,
 * never a proposal body. It is kept because the plan row holds only the current
 * one, and the planning rail draws every earlier version's briefing from it.
 *
 * `noteMd` is the ONE exception to that, and it is a separate field precisely so
 * the `diff` contract above stays true: a `reason_classified` row carries prose
 * EVIDENCE (the turn that raised the thing, or the rule search that came back
 * empty), which has no count-shaped form. Every other kind leaves it undefined.
 */
export interface RecordPlanRevisionArgs {
  planId: string;
  planItemId?: string | null;
  changedById: string | null;
  changeKind: PlanRevisionChangeKind;
  actor?: PlanRevisionAgentActor | null;
  diff: Record<string, unknown>;
  noteMd?: string | null;
}

export const planRevisionsService = {
  /**
   * Record one revision row for a plan mutation, inside the caller's transaction
   * (required `tx`).
   *
   * Returns the CREATED ROW; every call site but one is free to ignore it. The
   * exception is `recordRevisionClassification`, whose caller reports WHEN the
   * classification was recorded — and the only honest answer to that is the
   * row's own `changedAt`, written by the database. A service that returned the
   * id alone would leave its caller to stamp `new Date()`, which is the time it
   * ASKED rather than the time the row exists at.
   */
  async recordRevision(
    args: RecordPlanRevisionArgs,
    tx: Prisma.TransactionClient,
  ): Promise<PlanRevision> {
    return planRevisionRepository.create(
      {
        planId: args.planId,
        planItemId: args.planItemId ?? null,
        changedById: args.changedById,
        changeKind: args.changeKind,
        actorSource: args.actor?.source ?? null,
        actorHarness: args.actor?.harness ?? null,
        actorModel: args.actor?.model ?? null,
        diff: args.diff as Prisma.InputJsonValue,
        noteMd: args.noteMd ?? null,
      },
      tx,
    );
  },
};
