import type { Prisma } from '@/generated/prisma/client';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { resolveExpectedRepos } from '@/lib/workItems/expectedRepos';
import {
  deliveryMembersOf,
  deliverySetShortfall,
  hasDeliverySetShortfall,
  hasLandedDelivery,
  EMPTY_DELIVERY_SHORTFALL,
  type DeliverySetShortfall,
} from '@/lib/workItems/deliverySet';
import {
  classifyRepoDelivery,
  hasRepoSetShortfall,
  repoSetShortfall,
  EMPTY_SHORTFALL,
  type RepoSetShortfall,
} from '@/lib/workItems/repoDelivery';
import { workflowsService } from './workflowsService';
import { workItemsService } from './workItemsService';
import { IllegalTransitionError, PlanTargetHeldError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// RE-EVALUATION of the repository-SET completion gate, WITHOUT a delivery event
// (MOTIR-3034).
//
// THE DEFECT THIS EXISTS FOR. `changeRequestStatusSync` is the only caller of the
// gate, and it runs on a change-request delivery. That is the right trigger for
// deciding a delivery — and it is the ONLY trigger, which makes the gate's
// fail-closed state a one-way door: a repository whose work merged BEFORE
// `github_pull_request.base_ref` existed has a null base, `classifyRepoDelivery`
// reads null as UNKNOWN (correctly — see that module's doctrine), and no further
// event is ever coming for a merge that already happened. The item is held
// forever by a row that will never be updated. MOTIR-2725 — the story that built
// the gate — was held by it on the day it shipped.
//
// The classifier is not relaxed by any of this, and must not be. This module is
// the SECOND CHANCE: it asks the same question, of the same shared rule, at a
// moment the answer may have changed — after a base-ref backfill, after an item's
// repository set is edited, after a repository's default branch is renamed.
//
// ⚠️ IT OWNS NO COPY OF THE RULE. The decision comes from
// `lib/workItems/repoDelivery.ts` (the module that exists precisely so the gate
// and the surface can never disagree) and the write goes through
// `workItemsService.updateStatus` (the shipped write authority). What is new here
// is only WHEN the question is asked and, below, which gate stands in for
// MOTIR-1604's when there is no delivering change request to exclude.
//
// ⚠️ AND IT ASKS THE MERGE'S QUESTION, NOT AN OLDER ONE (MOTIR-10135). The merge
// sync no longer reads the repository set: an item with a LANDED delivery (one
// merged onto its own repository's default branch) completes on its delivery set
// alone. So the same item completes here on the same facts — every linked change
// request closed, none open, none merged off the trunk or onto an unrecorded base
// — and the repository set is asked only of an item with NO landed delivery,
// where there is no evidence the work happened at all. A re-check that held what
// a merge would complete is the one-way door this module exists to remove.

/** What one re-evaluation concluded.
 *
 *  The three `held_*` / `abstained_*` outcomes are all "the item stays where it
 *  is", split so an operator report says WHY — a hold that reads as a silent
 *  no-op is the failure mode MOTIR-1873 already paid for. */
export type RepoSetReevaluationOutcome =
  /** Every repository delivered; the item moved to the project's done status. */
  | 'transitioned'
  /** Every repository delivered and the item was already there. */
  | 'noop'
  /** No such work item. */
  | 'no_work_item'
  /** The item has no linked change request at all, so no tenant can be resolved
   *  from the connection tier and there is nothing for the gate to read. */
  | 'no_linked_change_request'
  /** The item names no repository. The gate ABSTAINS on an empty set — exactly as
   *  it does on a delivery — so re-evaluation must not complete it either. */
  | 'abstained_no_repo_set'
  /** The item has NO landed delivery, and some repository it carries is
   *  `awaiting`, `unknown` or `unestablished`. */
  | 'held_incomplete_repo_set'
  /** The item has a landed delivery, and another linked change request merged off
   *  its repository's trunk or onto a base Motir never recorded (MOTIR-3659's
   *  rule, read the way the merge sync reads it — MOTIR-10135). */
  | 'held_incomplete_delivery_set'
  /** A linked change request is still OPEN (the MOTIR-1604 rule, event-free). */
  | 'held_open_change_request'
  /** The project's workflow has no status in the done category. */
  | 'no_matching_status'
  /** The item's current status has no legal edge to done (e.g. it is still To Do). */
  | 'illegal_transition'
  /** An UNDECIDED plan holds the item at `planning` (MOTIR-6265; AMENDMENT 21
   *  §5(b)) — the plan decides what happens to it next, not the repository set. */
  | 'plan_held'
  /** No workspace owner to author the move, or the write was refused. */
  | 'access_denied';

export interface RepoSetReevaluationResult {
  workItemId: string;
  outcome: RepoSetReevaluationOutcome;
  /** The repositories that do NOT satisfy the gate, split by which question a
   *  reader has to answer. Empty for every outcome but `held_incomplete_repo_set`. */
  shortfall: RepoSetShortfall;
  /** The linked change requests that have not landed. Present only on
   *  `held_incomplete_delivery_set`. */
  deliveryShortfall?: DeliverySetShortfall;
  /** The status the item was moved to (`transitioned` / `noop` only). */
  toStatus?: string;
}

/** Options a caller may pass; `dryRun` decides and reports without writing. */
export interface RepoSetReevaluationOptions {
  dryRun: boolean;
}

/**
 * The two shortfalls a re-check can hold on, for an item with no OPEN linked
 * change request (MOTIR-10135).
 *
 * A LANDED delivery retires the repository set: the item is then decided by its
 * delivery set alone, exactly as the merge sync decides it, so the repository
 * shortfall is empty whatever the list names. With none landed there is no
 * evidence of shipped work, and the repository set is asked as it always was —
 * which is what still holds an item whose only pull requests were closed
 * unmerged, or whose one merge awaits a base-ref backfill.
 */
async function completionShortfalls(
  workItemId: string,
  targetRepos: string[],
  tx: Prisma.TransactionClient,
): Promise<{ deliveryShortfall: DeliverySetShortfall; shortfall: RepoSetShortfall }> {
  const members = deliveryMembersOf(
    await workItemDeliveryRepository.listByWorkItem(workItemId, tx),
  );
  if (hasLandedDelivery(members))
    return { deliveryShortfall: deliverySetShortfall(members), shortfall: EMPTY_SHORTFALL };
  return {
    deliveryShortfall: EMPTY_DELIVERY_SHORTFALL,
    shortfall: repoSetShortfall(
      classifyRepoDelivery(
        // Through the REFERENCES — see `resolveExpectedRepos`. Same reason as the
        // sync's own site used to be: a renamed repository leaves the stored
        // projection naming something that no longer exists.
        await resolveExpectedRepos(workItemId, targetRepos, tx),
        await workItemDeliveryRepository.listCompletionFactsByWorkItem(workItemId, tx),
      ),
    ),
  };
}

export const repoSetCompletionService = {
  /**
   * Re-run the repository-SET completion gate for ONE work item and complete it
   * when every repository it carries has delivered.
   *
   * The shape mirrors `syncChangeRequestStatus`'s resolve phase deliberately:
   * a system transaction reaches the CONNECTION tier, binds the tenant the
   * moment a trusted row names it, reads the item and the completion facts under
   * that binding, and then applies the transition OUTSIDE the read transaction
   * through the shipped authority.
   *
   * ⚠️ THE TENANT BINDING IS LOAD-BEARING AND ITS FAILURE IS SILENT (MOTIR-2880).
   * `work_item` and `workspace_membership` carry no `system_admin` policy arm, so
   * a read of either inside a bare `withSystemContext` returns ZERO ROWS and
   * raises nothing — which would present here as "no such work item" for an item
   * that plainly exists. The workspace is therefore resolved FIRST, from a
   * DELIVERY row, and `bindWorkspaceContext` is called before the first
   * tenant-table statement.
   *
   * ⚠️ AND THE RESOLUTION ITSELF DEPENDS ON AN ARM THIS CARD ADDED (MOTIR-3721).
   * It used to read the connection tier (`github_pull_request` → `github_repo`,
   * both armed). `work_item_delivery` shipped with a pure workspace policy, so
   * repointing it here without the arm would have returned an EMPTY LIST and
   * raised nothing — `no_linked_change_request` for every card in the product,
   * MOTIR-3034's repair path dead in silence. Migration
   * `20260828120000_work_item_delivery_system_arm` is what makes this read
   * ADMITTED, and `docs/decisions/delivery-reader-migration.md` §1 demonstrates
   * both halves on a live cluster as a non-superuser role. Bound reads and
   * ADMITTED reads are different questions; this one needed both answered.
   */
  async reevaluateItem(
    workItemId: string,
    opts: RepoSetReevaluationOptions = { dryRun: false },
  ): Promise<RepoSetReevaluationResult> {
    const resolved = await withSystemContext(async (tx) => {
      // ARMED FOR THE SYSTEM FLAG (migration
      // `20260828120000_work_item_delivery_system_arm`). This is also the only
      // trusted source of the tenant for a caller holding just an item id: the
      // delivery row carries the workspace on the ROW, never request input.
      // Passing it in from the caller was considered and REJECTED — its failure
      // mode is a cross-tenant read rather than an empty one (ADR §1, option c).
      const workspaceId = await workItemDeliveryRepository.findWorkspaceIdByWorkItem(
        workItemId,
        tx,
      );
      if (!workspaceId) return { kind: 'no_linked_change_request' as const };

      // ⚠️ BIND THE TENANT NOW — every statement below reads a table with no
      // `system_admin` arm.
      await bindWorkspaceContext(tx, workspaceId);

      const item = await workItemRepository.findById(workItemId, tx);
      if (!item) return { kind: 'no_work_item' as const };

      // The gate ABSTAINS on an empty set, on a delivery and here alike. An item
      // that names no repository is decided by the other two gates, and there is
      // no delivery for them to decide — so re-evaluation of such an item must
      // change nothing. Completing it would turn a repair into a bulk status
      // rewrite over every card in the product.
      if (item.targetRepos.length === 0)
        return { kind: 'abstained_no_repo_set' as const, workspaceId };

      // MOTIR-1604's rule, restated for a caller with no delivering change
      // request: the sync excludes the row it is deciding, because that row has
      // just closed. Nothing is closing here, so EVERY open linked change request
      // counts — which is the conservative reading, and the only one that cannot
      // complete a card whose sibling pull request is still in review.
      const openChangeRequests = await workItemDeliveryRepository.countOpenByWorkItem(
        workItemId,
        tx,
      );

      const gates =
        openChangeRequests > 0
          ? { deliveryShortfall: EMPTY_DELIVERY_SHORTFALL, shortfall: EMPTY_SHORTFALL }
          : await completionShortfalls(workItemId, item.targetRepos, tx);

      const owner = await workspaceMembershipRepository.findStandInManagerByWorkspace(
        workspaceId,
        tx,
      );
      return {
        kind: 'resolved' as const,
        workspaceId,
        projectId: item.projectId,
        currentStatus: item.status,
        openChangeRequests,
        ...gates,
        ownerUserId: owner?.userId ?? null,
      };
    });

    if (resolved.kind === 'no_linked_change_request')
      return { workItemId, outcome: 'no_linked_change_request', shortfall: EMPTY_SHORTFALL };
    if (resolved.kind === 'no_work_item')
      return { workItemId, outcome: 'no_work_item', shortfall: EMPTY_SHORTFALL };
    if (resolved.kind === 'abstained_no_repo_set')
      return { workItemId, outcome: 'abstained_no_repo_set', shortfall: EMPTY_SHORTFALL };

    if (resolved.openChangeRequests > 0)
      return { workItemId, outcome: 'held_open_change_request', shortfall: EMPTY_SHORTFALL };

    if (hasDeliverySetShortfall(resolved.deliveryShortfall))
      return {
        workItemId,
        outcome: 'held_incomplete_delivery_set',
        shortfall: EMPTY_SHORTFALL,
        deliveryShortfall: resolved.deliveryShortfall,
      };

    if (hasRepoSetShortfall(resolved.shortfall))
      return {
        workItemId,
        outcome: 'held_incomplete_repo_set',
        shortfall: resolved.shortfall,
      };

    // Resolve the concrete done status BY CATEGORY against the project's live
    // workflow — never a hard-coded key, exactly as the sync does, so a renamed
    // status still completes.
    const targetKey = await workflowsService.resolveStatusKey(
      resolved.projectId,
      resolved.workspaceId,
      { key: 'done', category: 'done' },
    );
    if (!targetKey)
      return { workItemId, outcome: 'no_matching_status', shortfall: EMPTY_SHORTFALL };

    if (resolved.currentStatus === targetKey)
      return { workItemId, outcome: 'noop', shortfall: EMPTY_SHORTFALL, toStatus: targetKey };

    // Checked BEFORE the dry-run short-circuit on purpose: a rehearsal that
    // reports "would complete" for an item no one can author the move on is a
    // rehearsal of the wrong run.
    if (!resolved.ownerUserId)
      return { workItemId, outcome: 'access_denied', shortfall: EMPTY_SHORTFALL };

    if (opts.dryRun)
      return {
        workItemId,
        outcome: 'transitioned',
        shortfall: EMPTY_SHORTFALL,
        toStatus: targetKey,
      };

    try {
      // Attributed to the WORKSPACE OWNER. The sync prefers the change request's
      // author and falls back to the owner; there is no author here — nobody
      // delivered anything — so the fallback is the whole answer, and it is the
      // same automation-engine precedent.
      // Never meets MARKED_CARD_CANNOT_REOPEN (MOTIR-6681): `targetKey` is resolved
      // by the DONE category above, and the mark refuses only a move out of it.
      await workItemsService.updateStatus(workItemId, targetKey, {
        userId: resolved.ownerUserId,
        workspaceId: resolved.workspaceId,
      });
    } catch (err) {
      // The same two classifications the sync makes, and NOT a third: an
      // `UnknownStatusError` cannot occur on this path, because `targetKey` was
      // resolved from THIS project's own workflow one screen above rather than
      // handed in. Anything genuinely unexpected re-throws — an operator sweep
      // that swallowed a real fault would report a repair it did not make.
      if (err instanceof IllegalTransitionError)
        return {
          workItemId,
          outcome: 'illegal_transition',
          shortfall: EMPTY_SHORTFALL,
          toStatus: targetKey,
        };
      if (err instanceof PlanTargetHeldError)
        return {
          workItemId,
          outcome: 'plan_held',
          shortfall: EMPTY_SHORTFALL,
          toStatus: targetKey,
        };
      if (err instanceof ProjectAccessDeniedError || err instanceof ProjectNotFoundError)
        return { workItemId, outcome: 'access_denied', shortfall: EMPTY_SHORTFALL };
      throw err;
    }

    return {
      workItemId,
      outcome: 'transitioned',
      shortfall: EMPTY_SHORTFALL,
      toStatus: targetKey,
    };
  },

  /**
   * Re-evaluate a LIST of work items, in order, and return every verdict.
   *
   * Each item is its own transaction and its own outcome, so one item that
   * cannot be resolved does not cost the others their repair — the same
   * per-unit resumability the historical sweep uses.
   */
  async reevaluateItems(
    workItemIds: readonly string[],
    opts: RepoSetReevaluationOptions = { dryRun: false },
  ): Promise<RepoSetReevaluationResult[]> {
    const results: RepoSetReevaluationResult[] = [];
    for (const id of workItemIds) {
      results.push(await repoSetCompletionService.reevaluateItem(id, opts));
    }
    return results;
  },
};
