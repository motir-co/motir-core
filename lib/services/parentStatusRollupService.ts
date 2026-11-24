import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workflowsService } from './workflowsService';
import { readPlanHoldWithin } from './planTargetLockService';
import { workItemsService } from './workItemsService';
import { sendEvent } from '@/lib/jobs/sendEvent';
import {
  ApprovalGatePendingError,
  MarkedCardCannotReopenError,
  IllegalTransitionError,
  UnknownStatusError,
} from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  LADDER as SHARED_LADDER,
  rankOfStatus,
  type LadderRung,
} from '@/lib/workItems/statusLadder';

// The UPWARD half of bidirectional status derivation (Story MOTIR-1615 · Subtask
// MOTIR-1620, AMENDED by Story MOTIR-2888 · Subtask MOTIR-2891;
// `docs/decisions/status-derivation.md` §3 + §3a): a parent's child set changed,
// so its status is RECOMPUTED from that set.
//
// A RECOMPUTE, NOT A RATCHET (the 2026-08-17 amendment, settling MOTIR-2885).
// The parent's status is a pure function of its children's CURRENT statuses over
// a FIVE-rung ladder, and the result is applied whether it lands ahead of or
// behind where the parent stands. Reopening a child brings its parent back with
// it; a `done` parent given a fresh `todo` child returns to `todo`. The fourth
// (`todo`) rung is what lets the ladder say "there is open, unstarted work down
// here" at all — adding it without dropping the forward-only filter would have
// changed nothing, and dropping the filter without it would have had nowhere to
// land. No work item is exempt: there is no per-item or per-kind carve-out.
//
// ⚠️ AND THAT CLAIM IS NOW CONSISTENT WITH THE DOWNWARD HALF (Bug MOTIR-3334,
// 2026-08-21) — it was not, for eleven days, and the disagreement was stable
// rather than transient. `childStatusCascadeService` carried a `bug`-kind
// exemption (MOTIR-3229) while this header exempted nothing, so a parent whose
// only open children were exempt bugs was completed by its merge, then counted
// by THIS service and pulled back to `implemented` — with nothing able to
// complete the children the count was waiting on. Measured on MOTIR-3232 /
// motir-core#2237: `done` at 10:00:42, `implemented` at 10:03:30, still there
// until both bugs were closed by hand. The carve-out is deleted; the sentence
// above now describes both directions, which is the only reading under which it
// was ever safe.
//
// ⚠️ AND THE LADDER GAINED AN `implemented` RUNG (Bug MOTIR-3229). `implemented`
// (MOTIR-3003) sits in the `in_progress` CATEGORY, so a parent whose children
// were ALL implemented derived to `in_progress`: the ladder could not express
// "everything below me is BUILT", which is exactly the state a story run ends in.
// The rungs and the rank now live in `lib/workItems/statusLadder.ts`, shared with
// the gate that refuses a container's claim to be built while a child is not —
// two readers of one ordering, rather than two orderings.
//
// THE DIRECTION DECIDES THE AUTHORITY (ADR §3). The rank comparison still
// happens — it just picks the CALL instead of vetoing the move:
//   * FORWARD  — the ordinary `applyStatusTransition`, legality-gated, WALKING
//                the ladder one legal edge at a time (MOTIR-2901). "You configure
//                your workflow, the derivation respects it" is a promise about
//                ADVANCEMENT and is kept intact: every hop is a real edge of the
//                team's own graph, and every status stood on is a LADDER RUNG the
//                derivation could have chosen outright for some child set.
//   * BACKWARD — a privileged `{ system: true }` set (the shipped MOTIR-941
//                bypass the downward cascade already uses), with no
//                `canTransition` probe and no fallback: `done → todo` and
//                `in_review → todo` are not edges in the default workflow and
//                must NOT be added as `workflow_transition` rows, because those
//                are user-draggable board edges. A derived backward move is a
//                CLAIM ABOUT THE CHILDREN, not a user's workflow step.
//
// ⚠️ AND A CLAIM HAS A DATE — THE BACKWARD ARM STANDS DOWN FOR A NEWER USER
// WRITE (Bug MOTIR-2965). Needing no legal edge is what makes the backward arm
// the one that can silently overwrite a status a person just set; the cost lands
// on their NEXT click, as a bare 422, because the status they were moving from is
// no longer the one the row holds. So the arm compares the parent's own last
// status change against the newest edit to the child set it is reasoning about,
// and declines (`stale_backward`) when the row is the younger of the two. The
// children's reading is not what is wrong in that case — it is accurate; what is
// wrong is telling somebody something they already knew when they wrote the row.
// The same ordering hole MOTIR-2957 closed on the cascade's side.
//
// Direct parent only. The grandparent recomputes when the parent's OWN transition
// re-emits `work-item/transitioned` and the derivation job (MOTIR-1621) re-fires
// — recursion by re-emission, with no ancestor walk and no loop guard, because a
// level that does not change emits nothing (`already_there`). That no-op is now
// the whole of the termination argument, which no longer appeals to forward-only:
// a pass over an unchanged child set computes the same target and finds the
// parent already in it. The forward WALK is inside one pass and cannot disturb
// that: it only ever steps to a STRICTLY higher rung on a five-point scale, so it
// takes at most three hops and lands on the target it computed before it started.
// The downward mirror is `childStatusCascadeService`
// (MOTIR-1647), which fires only on ENTRY into a done-category status — which is
// what stops a parent that has just come back to `todo` from force-closing the
// child that brought it there.
//
// Runs WITHOUT an acting user — it is a background job — so the move is
// attributed to the WORKSPACE OWNER, the same fallback the change-request status
// sync uses. It is NOT userless in the tenant sense: the triggering event carries
// `workspaceId`, so both phases bind a workspace context (MOTIR-2880 — phase 1
// used to open a system context, which no `work_item` policy admits).

/**
 * The child-set edit that WOKE this recompute (Bug MOTIR-2965).
 *
 * ⚠️ ONLY the triggers whose edit is invisible to the aggregate need to pass it.
 * A create and a transition both leave their mark ON a live child row, so
 * `aggregateChildrenStatus`'s `lastChangedAt` already dates them — and reading it
 * off the SET rather than off the event is what keeps the recompute idempotent
 * under redelivery, the same property ADR §3's rejected "carry the event's
 * `toStatusKey`" alternative gave up. An archive, a re-parent or a delete removes
 * the row that changed, so there is nothing left in the set to read: those
 * triggers carry `occurredAt` and the LATER of the two is used.
 */
export interface RecomputeTrigger {
  /** When the child-set edit committed. Later than any row the aggregate can see
   *  precisely when the row it concerns is no longer in the set. */
  readonly occurredAt: Date;
}

/** The ladder, highest rung first — the FIRST match wins. Each rung names the
 *  intent it wants; the concrete status key is resolved against the project's own
 *  workflow by `workflowsService.resolveStatusKey`, so a renamed workflow still
 *  derives.
 *
 *  The `todo` rung is MOTIR-2891's: it matches when NO rung above it does, i.e.
 *  there is open work under the parent and none of it has started. It is last
 *  precisely so "first match wins" reads it as the fallthrough.
 *
 *  The `implemented` rung is MOTIR-3229's — see the shared module for why the set
 *  lives there now rather than here. */
const LADDER = SHARED_LADDER;

/** What a rollup pass did, for the caller's log. Every outcome is a NORMAL
 *  result — the rollup never throws on a shape it cannot act on, because it runs
 *  behind a status change the user already made successfully and must not turn
 *  that into a failed job. */
export type RollupOutcome =
  /** The parent ADVANCED — a forward move, through the legality-gated path.
   *  `via` lists the INTERMEDIATE rungs a multi-hop walk stood on, and is present
   *  only when there were any (MOTIR-2901). A run log that cannot say "this
   *  derivation passed through In Review on its way to Done" cannot answer the
   *  question an operator actually has when a status appears in the feed that
   *  nobody set — the same reason `rolled_back` is its own variant. */
  | { outcome: 'rolled_up'; parentId: string; toStatus: string; via?: string[] }
  /** The parent CAME BACK — a backward move, through the privileged system set.
   *  A distinct variant rather than a flag on `rolled_up`, because the two took
   *  different authority to perform and a run log that cannot tell them apart
   *  cannot answer "did a derivation bypass a workflow gate?" (MOTIR-2891). */
  | { outcome: 'rolled_back'; parentId: string; toStatus: string }
  | { outcome: 'no_parent' }
  | { outcome: 'toggle_off'; parentId: string }
  | { outcome: 'no_rung'; parentId: string }
  | { outcome: 'already_there'; parentId: string; toStatus: string }
  /** The recompute's target sits at the SAME rung as the parent's current status
   *  under a different key — the reachable case being a `blocked` parent whose
   *  children are all todo. Neither forward nor backward, so nothing moves and a
   *  human's `blocked` marker survives the next child event (MOTIR-2891). */
  | { outcome: 'same_rung'; parentId: string; toStatus: string }
  /** A BACKWARD set was declined because the parent's status is NEWER than the
   *  child-set edit that woke this recompute (Bug MOTIR-2965). Its own variant
   *  rather than folding into `same_rung`, for the reason `rolled_back` is one:
   *  a run log that cannot say "a derivation stood down in favour of a person's
   *  write" cannot answer why a parent is not where the ladder says it is. */
  | { outcome: 'stale_backward'; parentId: string; toStatus: string }
  /** A BACKWARD set was declined because the parent DELIVERS ITS OWN open pull
   *  request and stands on a review rung (Bug MOTIR-8327): its In Review /
   *  Approved is its own CI verdict and merge gate, not its children's, and the
   *  child set it would pull back to is still built. The backward twin of
   *  `approval_pending`, and its own variant for the same reason `stale_backward`
   *  is one: a run log must be able to say why a parent is not where the ladder
   *  says it is. */
  | { outcome: 'delivery_owned'; parentId: string; toStatus: string }
  | { outcome: 'no_matching_status'; parentId: string }
  | { outcome: 'illegal_transition'; parentId: string; toStatus: string }
  | { outcome: 'approval_pending'; parentId: string; toStatus: string }
  /** An UNDECIDED plan holds the parent at `planning` (MOTIR-6265; AMENDMENT 21
   *  §5(b)): the derivation reads the parent's OLD shape, which the plan is
   *  replacing, so it declines to answer rather than failing its job. */
  | { outcome: 'plan_held'; parentId: string; toStatus: string }
  /** The parent carries an OBSOLESCENCE mark (MOTIR-6672 · MOTIR-6681): a marked
   *  card stays finished, and a derivation from a reopened child is exactly the
   *  write that would reopen it. Recorded, never a failed job — the story's rule 4,
   *  "no system write reopens one". Clearing the mark is a person's act. */
  | { outcome: 'held_by_mark'; parentId: string; toStatus: string }
  | { outcome: 'access_denied'; parentId: string }
  | { outcome: 'unresolvable' };

export const parentStatusRollupService = {
  /**
   * RECOMPUTE the given child's DIRECT parent from its current child set.
   *
   * The rungs, evaluated against the parent's direct non-archived, non-triaged
   * children — first match wins:
   *   * **done** — every child is in a done-category status;
   *   * **in_review** — every child is in review or done, and at least one is in
   *     review;
   *   * **implemented** — every child is implemented-or-better, and at least one
   *     is at `implemented` (MOTIR-3229);
   *   * **in_progress** — at least one child has STARTED, i.e. sits in an
   *     in-progress-category status (which includes the two split-out buckets);
   *   * **todo** — none of the above matched, i.e. there is open work under the
   *     parent and none of it has started.
   *
   * Three properties this deliberately holds:
   *
   *   * **Both directions.** The highest matching rung is applied whether it
   *     ranks ahead of or behind the parent's current status. A `done` parent
   *     given a fresh `todo` child returns to `todo`; a reopened child brings its
   *     parent back with it. (This REPLACED the forward-only filter — MOTIR-2891.)
   *   * **The direction decides the authority.** Forward goes through the
   *     ordinary `applyStatusTransition` — NO system bypass — so an advance only
   *     ever walks the team's real workflow, hop by hop, and a graph with no path
   *     to the target at all gets a logged no-op. Backward is a
   *     `{ system: true }` set with no `canTransition` probe and no fallback,
   *     because the backward edges it needs (`done → todo`, `in_review → todo`)
   *     are absent from the default workflow and must not be added as
   *     user-draggable rows. See the file header and ADR §3.
   *   * **Lock BEFORE aggregate.** The parent row is locked FOR UPDATE before its
   *     children are counted. Two children finishing concurrently produce two
   *     passes over the same parent; if each read the aggregate before locking,
   *     both could observe "not all done" and the parent would never roll.
   *     Locking first serializes them, and the loser re-reads an aggregate that
   *     includes the winner's commit. `applyStatusTransition` takes its own lock,
   *     but that is too late — the derivation INPUT is read before it.
   *
   * Never throws for a business reason; returns a typed outcome instead.
   */
  async rollUpForChild(
    childId: string,
    workspaceId: string,
    trigger?: RecomputeTrigger,
  ): Promise<RollupOutcome> {
    // Resolve the child's parent, then hand off. The child is only ever an
    // ADDRESS for its parent — every rung reads the parent's whole child set — so
    // the two entry points share one implementation (MOTIR-2892: the child-set
    // triggers know a PARENT, not a child, and must not fork the ladder).
    //
    // No acting USER on a background job, but there IS a tenant: every event that
    // reaches derivation carries `workspaceId`, so the read binds the WORKSPACE
    // tier.
    //
    // ⚠️ THIS USED TO BE `withSystemContext`, AND IT WAS DEAD (MOTIR-2880). That
    // context binds only `app.system_admin`, and `work_item` /
    // `workspace_membership` carry no arm that reads it — so under `motir_app` the
    // very first statement here (`findById(childId)`) returned NULL and every
    // rollup answered `{ outcome: 'no_parent' }` without raising. Silent, because
    // RLS does not refuse a SELECT, it empties it. The same trap applies to
    // `recomputeParent` below, which is why it takes the workspace too rather
    // than resolving it from the row it is about to read.
    const parentId = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const child = await workItemRepository.findById(childId, tx);
      return child?.parentId ?? null;
    });
    if (!parentId) return { outcome: 'no_parent' };
    return parentStatusRollupService.recomputeParent(parentId, workspaceId, trigger);
  },

  /**
   * RECOMPUTE one parent from its current child set — the PARENT-keyed entry
   * point (Story MOTIR-2888 · Subtask MOTIR-2892).
   *
   * Identical in every respect to {@link rollUpForChild}, which is a thin
   * resolver in front of it; see that method's doc comment for the rungs and the
   * three properties. It exists because the child-set triggers — a re-parent's
   * PREVIOUS parent, a delete whose child row no longer exists — have a parent id
   * and no child to address it through, and handing them "any surviving child"
   * would be a lie in exactly the cases that matter (the last child left).
   *
   * `no_parent` is not reachable from here: the caller already has the parent.
   *
   * Takes the WORKSPACE explicitly, for MOTIR-2880's reason: the resolve phase is
   * an RLS-scoped read, and binding it to the tenant the triggering event named
   * is what makes it return rows at all under `motir_app`. Resolving the
   * workspace FROM the parent row would be circular — that read is the one being
   * scoped.
   */
  async recomputeParent(
    parentIdIn: string,
    workspaceId: string,
    trigger?: RecomputeTrigger,
  ): Promise<RollupOutcome> {
    const resolved = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const parent = await workItemRepository.findById(parentIdIn, tx);
      if (!parent) return null;
      const settings = await projectRepository.findStatusAutomation(parent.projectId, tx);
      const owner = await workspaceMembershipRepository.findStandInManagerByWorkspace(
        parent.workspaceId,
        tx,
      );
      return {
        parentId: parent.id,
        projectId: parent.projectId,
        enabled: settings?.autoRollupParentStatus ?? false,
        ownerUserId: owner?.userId ?? null,
      };
    });

    // The parent row is gone (deleted in the window between the emit and this
    // run). Nothing to recompute, and not an error.
    if (!resolved) return { outcome: 'unresolvable' };
    if (!resolved.enabled) return { outcome: 'toggle_off', parentId: resolved.parentId };
    // No workspace owner ⇒ nobody can author the move. Not an error: a workspace
    // in that state has bigger problems than a missing rollup.
    if (!resolved.ownerUserId) return { outcome: 'unresolvable' };

    // `workspaceId` is the caller's — the phase-1 read was RLS-scoped to it, so the
    // parent it resolved is that workspace's by construction.
    const { parentId, projectId, ownerUserId } = resolved;
    const ctx = { userId: ownerUserId, workspaceId };

    // Resolve the ladder's candidate keys ONCE, outside the locked transaction —
    // they depend only on the project's workflow, not on the children.
    //
    // BOTH split-out lifecycle keys, since MOTIR-3229: `in_review` and
    // `implemented` share the `in_progress` category, so neither the aggregate
    // nor the rank can tell them apart from a plain in-progress status without
    // being told which key each is.
    const reviewKey = await workflowsService.resolveStatusKey(projectId, workspaceId, {
      key: 'in_review',
      category: 'in_progress',
    });
    const implementedKey = await workflowsService.resolveStatusKey(projectId, workspaceId, {
      key: 'implemented',
      category: 'in_progress',
    });
    // THE THIRD split-out key (MOTIR-5140): `approved` shares the same category
    // as the two above, so without being told which key it is neither the
    // aggregate nor the rank can tell it from a plain in-progress status — and a
    // parent whose children were all approved derived BACKWARDS to In Progress.
    const approvedKey = await workflowsService.resolveStatusKey(projectId, workspaceId, {
      key: 'approved',
      category: 'in_progress',
    });
    // The project's status vocabulary, read ONCE. `rankOfStatus` is a pure
    // function over it (MOTIR-3229) — it used to issue a `getStatusByKey` per
    // comparison from inside the locked transaction below, which is one query per
    // rung per pass for an answer that never changes within a pass.
    const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
    // THE ONE KEY PULLED DOWN (MOTIR-12174), resolved by LITERAL key and never
    // through `resolveStatusKey`: its category fallback would hand back the
    // first `in_progress` status — `in_progress` itself — and rank real started
    // work at the todo rung. A project without the status passes `null`.
    const toPlanKey = statuses.find((s) => s.key === 'to_plan')?.key ?? null;
    const ladderKeys = { reviewKey, implementedKey, approvedKey, toPlanKey };
    // ⚠️ A DEGENERATE PROJECT CAN ALIAS THE TWO RUNGS ONTO ONE KEY. With no
    // `implemented` status of its own, `resolveStatusKey` falls back to the first
    // `in_progress`-category status — which on such a project is also what the
    // in-progress rung resolves to, and can be what the review rung resolves to.
    // That is handled where it matters: `stones`/`candidates` de-duplicate BY KEY
    // below, and `rankOfStatus` fixes a precedence when one key wears two hats.
    const rank = (statusKey: string) => rankOfStatus(statusKey, statuses, ladderKeys);

    /** The transaction returns its outcome AND, when it really moved the parent,
     *  the transition metadata the post-commit emit needs. */
    type Applied = {
      outcome: RollupOutcome;
      emit: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null;
    };

    const { outcome, emit } = await withWorkspaceContext(ctx, async (tx): Promise<Applied> => {
      // ⚠️ Lock the PARENT first, then read the aggregate — see the doc comment.
      const locked = await workItemRepository.lockById(parentId, tx);
      if (!locked) return { outcome: { outcome: 'unresolvable' }, emit: null };
      const parent = await workItemRepository.findById(parentId, tx);
      if (!parent) return { outcome: { outcome: 'unresolvable' }, emit: null };

      const agg = await workItemRepository.aggregateChildrenStatus(
        parentId,
        {
          reviewStatusKey: reviewKey,
          implementedStatusKey: implementedKey,
          approvedStatusKey: approvedKey,
          toPlanStatusKey: toPlanKey,
        },
        tx,
      );
      const rungs = matchingRungs(agg);
      // With the `todo` fallthrough rung in place this is reachable ONLY for a parent with no
      // LIVE children — none at all, or every one archived / triaged. An empty
      // aggregate must not satisfy "every child is done" vacuously, and must not
      // fall through to the todo rung either: there is nothing to derive FROM.
      if (rungs.length === 0) return { outcome: { outcome: 'no_rung', parentId }, emit: null };

      // Resolve EVERY ladder rung against this project's workflow ONCE, dropping
      // the ones it has no status for and de-duplicating by KEY (two rungs can
      // resolve to the same key when a project has renamed a status away). The
      // resolution serves two different readers:
      //
      //   * `candidates` — the MATCHING rungs, highest first. These say what the
      //     recompute claims the parent IS.
      //   * `stones` — ALL of them, highest rank first. These are the statuses a
      //     forward walk may stand on. The distinction is the whole of MOTIR-2901:
      //     a stepping stone need not be a rung the current child set matches, but
      //     it is always a rung the ladder itself can produce — so the walk can
      //     never park the parent in a status the derivation was not entitled to
      //     choose in the first place.
      const resolved = new Map<LadderRung, { key: string; rank: number }>();
      const stones: Array<{ key: string; rank: number }> = [];
      for (const entry of LADDER) {
        const key = await workflowsService.resolveStatusKey(projectId, workspaceId, entry.target);
        if (!key) continue;
        const known = stones.find((s) => s.key === key);
        const stone = known ?? { key, rank: rank(key) };
        if (!known) stones.push(stone);
        resolved.set(entry.rung, stone);
      }
      stones.sort((a, b) => b.rank - a.rank);

      const candidates: Array<{ key: string; rank: number }> = [];
      for (const rung of rungs) {
        const stone = resolved.get(rung.rung);
        if (!stone || candidates.some((c) => c.key === stone.key)) continue;
        candidates.push(stone);
      }
      const wanted = candidates[0];
      if (!wanted) return { outcome: { outcome: 'no_matching_status', parentId }, emit: null };

      // The HIGHEST matching rung is what the recompute says the parent IS. Where
      // it sits relative to the parent's current status decides only WHICH CALL
      // performs the move — never whether the move happens (ADR §3, MOTIR-2891).
      const currentRank = rank(parent.status);

      // Already exactly there: the no-op that emits nothing, and therefore the
      // fixed point the whole termination argument rests on.
      if (parent.status === wanted.key) {
        return {
          outcome: { outcome: 'already_there', parentId, toStatus: wanted.key },
          emit: null,
        };
      }

      // THE PLAN HOLD (MOTIR-6265; `agent-authored-plans.md` AMENDMENT 21 §5(b)).
      // A parent an UNDECIDED plan is rewriting is not the derivation's to move:
      // the children describe the shape the plan is replacing. Asked HERE, ahead of
      // both arms, because the BACKWARD arm is a `{ system: true }` set the funnel's
      // refusal exempts — without this it would walk a held parent out of
      // `planning` with no refusal at all. Recorded, never a failed job.
      if (await readPlanHoldWithin(parent, tx)) {
        return {
          outcome: { outcome: 'plan_held', parentId, toStatus: wanted.key },
          emit: null,
        };
      }

      /** The status keys to set, in order — one for a backward system set, one or
       *  more for a forward walk. The last one is where the parent ends up. */
      let steps: string[];
      let system = false;
      if (wanted.rank < currentRank) {
        // ⚠️ THE USER'S WRITE WINS ITS WINDOW (Bug MOTIR-2965, ADR §5). A
        // backward set needs no legal edge, so it is the one arm that can
        // overwrite a status the workflow would have protected — and the person
        // then meets a 422 on their NEXT click, for a reason that lives in the
        // previous one (`todo → done` is not an edge, deliberately).
        //
        // The reading of the children is not what is wrong here: it is accurate.
        // What is stale is the claim's DATE against the row it would overwrite.
        // A parent status written AFTER the newest edit to this child set was
        // written by someone who already knew about these children, so the
        // derivation has nothing to tell them. Decline, and say so in the log.
        //
        // This is deliberately the BACKWARD arm only. Forward is legality-gated,
        // so it can only ever take moves the person could have taken themselves;
        // `same_rung` already protects a deliberate `blocked` marker on the tie.
        // And it can only ever SUPPRESS a move: no new backward set becomes
        // possible, so the blast radius is one outcome variant.
        const statusChangedAt = await workItemRevisionRepository.findLatestStatusChangeAt(
          parentId,
          tx,
        );
        // A row that LEFT the set (archived / re-parented / deleted) is invisible
        // to the aggregate, so the child-set triggers pass their own instant and
        // the later of the two dates this pass's claim.
        //
        // `lastChangedAt` is non-null HERE by construction: it is null only for an
        // empty aggregate, and an empty aggregate returned `no_rung` above. A
        // parent that has never moved is the case with no date to beat, and it is
        // `statusChangedAt` that is null then — the arm proceeds, exactly as it
        // shipped, because a comparison with no evidence must not suppress.
        const fromSet = agg.lastChangedAt!;
        const fromTrigger = trigger?.occurredAt ?? null;
        const childSetChangedAt = fromTrigger && fromTrigger > fromSet ? fromTrigger : fromSet;
        if (statusChangedAt && statusChangedAt > childSetChangedAt) {
          return {
            outcome: { outcome: 'stale_backward', parentId, toStatus: wanted.key },
            emit: null,
          };
        }

        // ⚠️ A STORY RUN'S REVIEW RUNGS ARE ITS PULL REQUEST'S (Bug MOTIR-8327).
        // A container that delivers its own OPEN pull request reaches In Review
        // through its own green CI (`ciPromotion.promoteDeliveredCardsOnGreen`) and
        // Approved through its own merge gate — not through its children. The same
        // green pass promotes a child the pull request also delivers, and that
        // child's transition lands here a hop later, with the rest of the children
        // still at Implemented: the ladder says Implemented, and this set used to
        // take the story there, which withdrew its approve-to-merge question
        // `pulled_back` seconds after CI raised it (three times on MOTIR-8216).
        // The forward arm already stands down for such a container
        // (`approval_pending`, MOTIR-5526); this is the backward half.
        //
        // Only while the children are still BUILT — a target at or above the
        // Implemented rung. A child reopened below it is unbuilt work under the
        // story, which its own CI verdict cannot answer for, so that move applies
        // and the merge question goes with it. And only on an OPEN delivery: once
        // the pull request has merged or closed, the review rung is the children's
        // to answer again.
        const builtRung = resolved.get('implemented');
        const onReviewRung =
          (reviewKey !== null && parent.status === reviewKey) ||
          (approvedKey !== null && parent.status === approvedKey);
        if (
          onReviewRung &&
          builtRung &&
          wanted.rank >= builtRung.rank &&
          (await workItemDeliveryRepository.countOpenByWorkItem(parentId, tx)) > 0
        ) {
          return {
            outcome: { outcome: 'delivery_owned', parentId, toStatus: wanted.key },
            emit: null,
          };
        }

        // BACKWARD — a privileged system set. ONE call: no `canTransition` probe,
        // no walk and no fallback, because a backward derivation must not depend
        // on a board edge existing (`done → todo` is not one in the default
        // workflow, and must NOT be added — those rows are user-draggable). There
        // is nothing for a walk to buy here either: a system set reaches any
        // status in one hop.
        steps = [wanted.key];
        system = true;
      } else if (wanted.rank === currentRank) {
        // Same rung, different key — the parent already sits at the level the
        // children imply, under a status the derivation did not choose. The
        // reachable case is a `blocked` parent (a todo-category status a user set
        // deliberately) whose children are all todo: the todo rung "wants" To Do,
        // `blocked → todo` is a legal edge, and taking it would silently clear a
        // human's blocked marker on the next child event. Neither forward nor
        // backward: leave it alone.
        return { outcome: { outcome: 'same_rung', parentId, toStatus: wanted.key }, emit: null };
      } else {
        // FORWARD — legality-gated, and a WALK rather than a single hop
        // (MOTIR-2901). From where the parent stands, repeatedly take the HIGHEST
        // stepping stone at or below the target that this project's graph can
        // legally reach, until the target is reached or nothing above the cursor
        // is legal.
        //
        // Why a walk and not one hop. MOTIR-1623 already found that taking only
        // the top rung STRANDS a parent whose workflow cannot make that jump, and
        // the answer then was to fall to the next MATCHING rung. That answer has
        // a hole, and MOTIR-2901 fell into it: when every child finishes before
        // the first derivation pass runs, the aggregate is all-done, `done` is
        // the ONLY matching rung, and there is nothing below it to fall to. A
        // `todo` parent then has no legal single edge to `done` (`todo → done` is
        // not one, deliberately — MOTIR-1625 added `in_progress → done` and
        // stopped there), so it sat in `todo` forever: the aggregate never
        // changes again, so no later event gives it another chance. Exactly the
        // stranding the fallback was added to fix, in the one shape the fallback
        // could not reach.
        //
        // Why this still RESPECTS the workflow, which is the promise at stake:
        //   * every hop is a real `workflow_transition` edge — no `system` bypass,
        //     no new row, and a graph with no path simply gets a logged no-op;
        //   * every status stood on is a LADDER RUNG, i.e. one the derivation
        //     could have set outright for some other child set. The walk can
        //     never invent a resting place, only reach one sooner.
        // The parent therefore ends where the recompute says it is, having taken
        // precisely the moves a person would have had to make by hand.
        //
        // Termination: each hop moves to a STRICTLY higher rank on a five-point
        // scale bounded above by the target, so the loop runs at most
        // `stones.length` times and cannot revisit a stone. It never walks
        // BACKWARDS either — a stone at or below the cursor is skipped rather
        // than becoming a system set, since the recompute already decided the
        // direction from the highest matching rung.
        const path: string[] = [];
        let cursor = parent.status;
        let cursorRank = currentRank;
        for (let hop = 0; hop < stones.length && cursorRank < wanted.rank; hop += 1) {
          let next: { key: string; rank: number } | null = null;
          for (const stone of stones) {
            if (stone.rank <= cursorRank || stone.rank > wanted.rank) continue;
            if (await workflowsService.canTransition(projectId, cursor, stone.key, workspaceId)) {
              next = stone;
              break;
            }
          }
          if (!next) break;
          path.push(next.key);
          cursor = next.key;
          cursorRank = next.rank;
        }

        if (path.length === 0) {
          // Nothing above the parent is legal from where it stands. If the parent
          // is ALREADY sitting on one of the MATCHING rungs, that is a no-op and
          // not a refusal — reporting it as `illegal_transition` would put a false
          // negative in the run log. Otherwise a logged no-op naming the rung it
          // WANTED, never a throw — see the catch below.
          const here = candidates.find((c) => c.key === parent.status);
          if (here) {
            return {
              outcome: { outcome: 'already_there', parentId, toStatus: here.key },
              emit: null,
            };
          }
          return {
            outcome: { outcome: 'illegal_transition', parentId, toStatus: wanted.key },
            emit: null,
          };
        }
        steps = path;
      }

      const toStatusKey = steps[steps.length - 1]!;
      try {
        // `system: true` ONLY on the backward arm — it skips `canTransition` and
        // nothing else, keeping the row lock, the tenant gate, the project-access
        // gate, the target-exists check, the `done ⇒ sessionBranch = null`
        // invariant and the revision (MOTIR-941's shipped bypass, the same one
        // the downward cascade uses).
        //
        // A forward WALK applies its hops in order, in THIS transaction, so the
        // whole path commits or none of it does. Each hop writes its own revision
        // — that is the honest record of the edges walked, and the activity feed
        // should show a status the item genuinely held — but the walk emits ONE
        // event for the NET move (below), because an event is a notification and
        // a watcher must not be told three times about one derivation.
        let first: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null = null;
        let last: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null = null;
        for (const step of steps) {
          const { transition } = await workItemsService.applyStatusTransition(
            parentId,
            step,
            ctx,
            tx,
            system ? { system: true } : {},
          );
          /* istanbul ignore next -- unreachable: every step strictly changes the status */
          if (!transition) continue;
          first ??= transition;
          last = transition;
        }
        // A null transition on every step would mean the status matched after all;
        // the equality check above already returned, so this is belt-and-braces.
        /* istanbul ignore next -- unreachable: the already-there check above returns first */
        if (!first || !last) {
          return {
            outcome: { outcome: 'already_there', parentId, toStatus: toStatusKey },
            emit: null,
          };
        }
        // The intermediate rungs, for the run log — present only when the walk
        // actually passed through one. The backward arm is always a single hop,
        // so `rolled_back` never carries them.
        const via = steps.slice(0, -1);
        const emit = {
          fromStatusKey: first.fromStatusKey,
          toStatusKey: last.toStatusKey,
          revisionId: last.revisionId,
        };
        if (system) {
          return { outcome: { outcome: 'rolled_back', parentId, toStatus: toStatusKey }, emit };
        }
        return {
          outcome: {
            outcome: 'rolled_up',
            parentId,
            toStatus: toStatusKey,
            ...(via.length > 0 ? { via } : {}),
          },
          emit,
        };
      } catch (err) {
        // A workflow that cannot take the move, or a project the owner somehow
        // cannot edit, is a logged no-op — never a failed job behind a status
        // change the user already made successfully. Anything else is a real
        // fault and rethrows.
        if (err instanceof IllegalTransitionError) {
          return {
            outcome: { outcome: 'illegal_transition', parentId, toStatus: toStatusKey },
            emit: null,
          };
        }
        if (err instanceof UnknownStatusError) {
          return { outcome: { outcome: 'no_matching_status', parentId }, emit: null };
        }
        // The approval-gate guard (MOTIR-5526, rule 2b): a container with an OPEN
        // linked pull request — a parent run's draft, typically — reaches
        // `approved` only through its approval and `done` only through its merge.
        // A derivation must not take either, and must not fail its job trying.
        if (err instanceof ApprovalGatePendingError) {
          return {
            outcome: { outcome: 'approval_pending', parentId, toStatus: toStatusKey },
            emit: null,
          };
        }
        // A MARKED parent stays finished (MOTIR-6672 · MOTIR-6681). The BACKWARD arm
        // is the case: a marked `done` story whose child reopened would be set back
        // to the child set's rung, and `{ system: true }` does not exempt the mark.
        // The FORWARD arm cannot meet it — a marked parent is already in the done
        // category, the ladder's top, so there is nothing above it to walk to.
        // Either way the refusal fires on the FIRST hop, before any write, so the
        // transaction holds nothing to undo and nothing is emitted.
        if (err instanceof MarkedCardCannotReopenError) {
          return {
            outcome: { outcome: 'held_by_mark', parentId, toStatus: toStatusKey },
            emit: null,
          };
        }
        if (err instanceof ProjectAccessDeniedError || err instanceof ProjectNotFoundError) {
          return { outcome: { outcome: 'access_denied', parentId }, emit: null };
        }
        throw err;
      }
    });

    // Post-commit, never inside the transaction — a rollback must not have
    // notified, and this same event is what carries the derivation to the NEXT
    // level up (and to the automation engine / watchers, exactly as a board move
    // would).
    if (emit) {
      await sendEvent('work-item/transitioned', {
        workspaceId,
        workItemId: parentId,
        actorId: ownerUserId,
        fromStatusKey: emit.fromStatusKey,
        toStatusKey: emit.toStatusKey,
        revisionId: emit.revisionId,
      });
    }

    return outcome;
  },
};

/**
 * EVERY rung the children aggregate matches, highest first. The caller takes the
 * highest one as the recompute's answer, and — on the forward arm only — falls to
 * the next legal one, so a workflow that cannot make the top jump still advances
 * the parent as far as its graph allows (see the fallback note at the call site)
 * instead of stranding it.
 *
 * The `todo` rung (MOTIR-2891) is the FALLTHROUGH: it matches exactly when the
 * parent has live children and no rung above it matched — i.e. there is open work
 * down there and none of it has started. It is what lets the ladder express the
 * state a `done` parent enters when a fresh `todo` child is added to it.
 *
 * A parent with NO live children matches nothing — "every child is done" must not
 * be vacuously true (or creating a story would instantly complete it), and the
 * todo rung must not fire on an empty set either (or creating a story would
 * instantly un-complete its epic). Both are the same guard: derive from a child
 * set, or do not derive.
 */
function matchingRungs(agg: {
  total: number;
  todo: number;
  inProgress: number;
  implemented: number;
  inReview: number;
  approved: number;
  done: number;
}): Array<(typeof LADDER)[number]> {
  if (agg.total === 0) return [];
  const started = agg.inProgress + agg.implemented + agg.inReview + agg.approved;
  const out: Array<(typeof LADDER)[number]> = [];
  if (agg.done === agg.total) out.push(rungEntry('done'));
  // THE `approved` RUNG (MOTIR-5140) — "everything below me has been APPROVED".
  // Each clause below sums every bucket at-or-ABOVE its own rung, so inserting a
  // rung means adding its clause AND widening every clause beneath it; a rung
  // added without that widening silently stops its lower neighbours matching.
  if (agg.approved > 0 && agg.done + agg.approved === agg.total) out.push(rungEntry('approved'));
  if (agg.inReview > 0 && agg.done + agg.approved + agg.inReview === agg.total) {
    out.push(rungEntry('in_review'));
  }
  // THE `implemented` RUNG (MOTIR-3229) — "everything below me is BUILT". Every
  // child is implemented-or-better and at least one is at `implemented` itself;
  // the `at least one` clause is what the in-review rung above has, and for the
  // same reason: without it an all-in-review set would match here too and the
  // first-match-wins scan would be the only thing separating them.
  if (
    agg.implemented > 0 &&
    agg.done + agg.approved + agg.inReview + agg.implemented === agg.total
  ) {
    out.push(rungEntry('implemented'));
  }
  // ⚠️ `started` IS THE FOUR BUCKETS, NOT `inProgress` ALONE (four since
  // MOTIR-5140 added `approved`). The aggregate
  // splits `implemented` and `inReview` OUT of the in-progress category, so
  // asking `inProgress > 0` alone would answer "nothing has started" for a
  // parent whose every child is implemented — the exact reading MOTIR-3229 is
  // about, one rung lower.
  if (started > 0) out.push(rungEntry('in_progress'));
  if (out.length === 0) out.push(rungEntry('todo')); // the fallthrough
  return out;
}

/** The ladder entry for a rung — a lookup rather than an index, so the shared
 *  LADDER can grow a rung without silently re-pointing an index here. */
function rungEntry(rung: LadderRung): (typeof LADDER)[number] {
  /* istanbul ignore next -- every rung named here is in the shared LADDER; the
     non-null assertion narrows the type only */
  return LADDER.find((entry) => entry.rung === rung)!;
}
