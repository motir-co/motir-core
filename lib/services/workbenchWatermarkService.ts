import type { Prisma } from '@/generated/prisma/client';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { planRevisionHoldService } from '@/lib/services/planRevisionHoldService';
import { withWorkspaceContext } from '@/lib/workspaces';
import {
  workItemRepository,
  HOME_SLICE_DONE,
  HOME_SLICE_IN_PROGRESS,
  HOME_SLICE_TO_FIX,
  HOME_SLICE_TO_RESUME,
  HOME_SLICE_TODO,
} from '@/lib/repositories/workItemRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import {
  approvalGateRepository,
  type AwaitingRoutingScope,
} from '@/lib/repositories/approvalGateRepository';
import { reviewStateRepository } from '@/lib/repositories/reviewStateRepository';
import {
  finishedWindowStart,
  resolveActiveProjectScope,
  type HomeActorContext,
} from '@/lib/services/homeService';
import {
  WORKBENCH_TAB_KEYS,
  type WorkbenchTabKey,
  type WorkbenchTabWatermarkDto,
  type WorkbenchWatermarkDto,
} from '@/lib/dto/workbench';
import {
  decodeWatermarkCursor,
  encodeWatermarkCursor,
  latestDate,
  movedTabs,
} from '@/lib/workbench/watermarkCursor';

// THE WATERMARK READ (Story MOTIR-5238 · Subtask MOTIR-5240) — one cheap read
// answering, for one reader in one project: *has anything you can see changed
// since the watermark you hold, and in which tabs?*
//
// It is the only thing the Workbench stream polls, so its cost is paid once per
// second per open Workbench. Two properties are therefore load-bearing:
//
//   * IT RETURNS A SIGNAL, NEVER CONTENT. Per tab, a size and a freshness — no
//     rows, no titles, no ids. The client re-reads through the reads it already
//     has, which keeps every access decision in the reads that already make it
//     and means this read cannot leak a row a reader may not see.
//   * ITS OUTPUT IS BOUNDED BY CONSTRUCTION. Five pairs and a cursor, whatever
//     the project's size. That is what makes polling affordable at all.
//
// ⚠️ IT COMPOSES THE SHIPPED PREDICATES AND DEFINES NO SIXTH. The four work tabs
// are `homeService`'s assignee-OR-reporter union, scoped by
// `resolveActiveProjectScope`; the approvals tab is the gate's own routing
// predicate, reached exactly as `homeService.tabCounts` reaches it — the scoped
// project ids plus the reader. A watermark derived from its own idea of who sees
// what drifts from those five ASYMMETRICALLY and SILENTLY: nudging on something
// the reader cannot see is merely wasteful, while failing to nudge on something
// they CAN see is the feature not working, for one tab, for one kind of change,
// with nothing red anywhere because the list is still correct whenever anybody
// reloads.
//
// ⚠️ AND IT ADDS NO `db` AND NO TRANSACTION OF ITS OWN. One
// `withWorkspaceContext` — the same door every Workbench read already goes
// through, and the thing that binds `app.workspace_id` so the RLS-gated reads
// answer at all — with the repositories underneath it (the 4-layer rule).

/**
 * THE REVIEW HALF OF THE TO APPROVE READING (Bug MOTIR-10504) — the review rows behind the
 * rows routed to this reader that draw a review — approve-and-merge, and a story run's
 * acceptance (Bug MOTIR-10734): the cards first, from the gate's own routing predicate over
 * the kinds `carriesReviewPath` reads, then one reading over those cards.
 *
 * ⚠️ ONE ARM, TWO STATEMENTS IN SEQUENCE, AWAITED HERE. The second needs the first's ids,
 * and both run on the caller's transaction — so the arm is a single promise the fan-out
 * settles, never a read started inside the fan-out's argument list (Bug MOTIR-8284).
 */
async function reviewsOnApprovalRows(
  scope: AwaitingRoutingScope,
  tx: Prisma.TransactionClient,
): Promise<{ count: number; latest: Date | null }> {
  const cardIds = await approvalGateRepository.findAwaitingRoutedReviewCarryingWorkItemIds(
    scope,
    tx,
  );
  return reviewStateRepository.watermarkReviewsOfCards(cardIds, tx);
}

/**
 * The reading for every tab, taken inside ONE workspace context.
 *
 * ⚠️ SIX STATEMENTS, NOT TWELVE. Each work tab's size and freshness come back from
 * a single `aggregate` (`_count` + `_max` over one `where`), because a second
 * round trip per tab is a standing per-second cost rather than a tidiness
 * question. Watching is the one exception and the table's shape is why: `watcher`
 * carries no `updatedAt` of its own, so its freshness lives on the work item
 * across a relation Prisma's `_max` cannot reach, and it costs one extra one-row
 * read. Issued together under one context, exactly as `tabCounts` issues its
 * six counts — the project scope is the expensive half and every tab needs the
 * same one.
 */
async function readTabs(
  ctx: HomeActorContext,
): Promise<Record<WorkbenchTabKey, WorkbenchTabWatermarkDto>> {
  return withWorkspaceContext(ctx, async (tx) => {
    const projectScopes = await resolveActiveProjectScope(ctx, tx);
    const projectIds = projectScopes.map((scope) => scope.projectId);
    // The approvals tab's own exclusion (MOTIR-7988): a plan a revision holds is
    // off the list, so it is off the reading too — and its return moves the count.
    // And the planning-session liveness set (MOTIR-7913), as the approvals list
    // reads it. Both are INPUTS to the fan-out below, so both are read before it
    // starts — never awaited inside its argument list (see the note there).
    const [heldPlanIds, awaitingSessionIds] = await allSettledOrThrow([
      planRevisionHoldService.heldPlanIds({ workspaceId: ctx.workspaceId, projectIds }, tx),
      planChangeSessionRepository.listAwaitingPersonIdsInProjects(projectIds, tx),
    ]);
    // ⚠️ `allSettledOrThrow`, NOT `Promise.all`, AND NO `await` INSIDE THE ARRAY
    // (Bug MOTIR-8284). Every arm runs on the ONE interactive transaction above,
    // and that transaction ends the moment this callback returns or throws. An arm
    // still queued on it then is not cancelled: Prisma resolves it to `undefined`,
    // and the repository dereferencing that `undefined` rejects with nobody
    // listening. Production met exactly that — `Cannot read properties of
    // undefined (reading '_count')`, as an UNHANDLED rejection — because the
    // awaiting-sessions read used to be awaited INSIDE the array below, after the
    // work-tab aggregates had started and before anything was awaiting them; when
    // it failed, the transaction rolled back under all of them. Settling every
    // arm first means no read outlives the transaction it runs on, and a failure
    // surfaces once, as the read's own error.
    const approvalsScope: AwaitingRoutingScope = {
      projectIds,
      userId: ctx.userId,
      awaitingSessionIds,
      heldPlanIds,
    };
    const [
      toDo,
      inProgress,
      toFix,
      toResume,
      recentlyFinished,
      approvals,
      watching,
      failedSessions,
      endedSessions,
      approvalReviews,
    ] = await allSettledOrThrow([
      workItemRepository.watermarkByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        { slice: HOME_SLICE_TODO },
        tx,
      ),
      workItemRepository.watermarkByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        { slice: HOME_SLICE_IN_PROGRESS },
        tx,
      ),
      // TO FIX (MOTIR-6604) — the other half of In progress's category. A card whose
      // `fixReason` is recomputed moves between the two, and both readings see it.
      workItemRepository.watermarkByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        { slice: HOME_SLICE_TO_FIX },
        tx,
      ),
      // TO RESUME (MOTIR-7707) — the third slice of the category, read the same way.
      workItemRepository.watermarkByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        { slice: HOME_SLICE_TO_RESUME },
        tx,
      ),
      // The finished window is part of the PREDICATE here, exactly as it is in
      // the list and the count — a reading taken without it would be a
      // freshness for a different set, and the tab would nudge on work that
      // finished in June.
      workItemRepository.watermarkByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        { slice: HOME_SLICE_DONE, sortField: 'completedAt', since: finishedWindowStart() },
        tx,
      ),
      // ⚠️ THE GATE'S OWN PREDICATE, and deliberately NOT the membership `OR`
      // above it. A decision queue routes to exactly one recipient
      // (`assigneeId ?? reporterId`, `docs/decisions/approval-gates.md` §2), and
      // the scope is built here the same way `homeService.tabCounts` builds it
      // for the badge — the browsable project ids, which are `[]` for a reader
      // who may not browse their active project, and the reader.
      approvalGateRepository.watermarkAwaitingRoutedTo(approvalsScope, tx),
      watcherRepository.watermarkByUser(ctx.userId, ctx.workspaceId, projectScopes, tx),
      // …and the reader's FAILED PLANNING SESSIONS, which To resume now lists and counts
      // (MOTIR-7914): one aggregate over the list's own predicate, merged into the tab's pair
      // below so a new failure moves the tab's change detector as it moves the badge.
      planChangeSessionRepository.watermarkFailedOpenForOwner(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectIds },
        tx,
      ),
      // …and the sessions that ended `failed` before MOTIR-7905 and still hold a waiting plan
      // (MOTIR-7939), the third form the same tab lists and counts.
      planChangeSessionRepository.watermarkEndedWithWaitingPlanForOwner(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectIds },
        tx,
      ),
      // …and the REVIEW of the approve-and-merge rows (Bug MOTIR-10504): a review that
      // writes no gate — a gate-off pass, a GitHub approval at the head — changes a row's
      // review line and Reviewed badge, so it must move the tab the row is on.
      reviewsOnApprovalRows(approvalsScope, tx),
    ]);
    const pair = (reading: { count: number; latest: Date | null }): WorkbenchTabWatermarkDto => ({
      count: reading.count,
      latest: reading.latest?.toISOString() ?? null,
    });
    return {
      toDo: pair(toDo),
      inProgress: pair(inProgress),
      toFix: pair(toFix),
      toResume: pair({
        count: toResume.count + failedSessions.count + endedSessions.count,
        latest: latestDate(
          latestDate(toResume.latest, failedSessions.latest),
          endedSessions.latest,
        ),
      }),
      recentlyFinished: pair(recentlyFinished),
      // The gates and the review rows behind them, merged as To resume merges its three
      // reads: the pair is a change detector, and the strip's count comes from
      // `homeService.tabCounts`, never from here.
      approvals: pair({
        count: approvals.count + approvalReviews.count,
        latest: latestDate(approvals.latest, approvalReviews.latest),
      }),
      watching: pair(watching),
    };
  });
}

export const workbenchWatermarkService = {
  /**
   * READ the watermark, and say which tabs have moved since the one presented.
   *
   * `since` is the opaque cursor the caller last received, or nothing at all.
   * The three cases are deliberately different and the difference is the whole
   * of the resume contract:
   *
   *   * **ABSENT** — this reader has seen nothing, so nothing has moved under
   *     them. `moved: []`, and the surface they are rendering is its own first
   *     observation.
   *   * **READABLE** — the tabs whose pair differs, and only those. Replaying
   *     the same cursor is therefore idempotent: it names nothing the second
   *     time, which is what makes a reconnect neither a replay nor a gap.
   *   * **UNREADABLE** — a cursor from another build, truncated, or edited.
   *     EVERY tab, because the reader may be holding a list this stream can no
   *     longer speak about, and one redundant re-read is cheaper than a list
   *     that silently stops updating.
   */
  async read(ctx: HomeActorContext, since?: string | null): Promise<WorkbenchWatermarkDto> {
    const tabs = await readTabs(ctx);
    const presented = decodeWatermarkCursor(since);
    const moved: WorkbenchTabKey[] =
      since && presented === null ? [...WORKBENCH_TAB_KEYS] : movedTabs(presented, tabs);
    return { cursor: encodeWatermarkCursor(tabs), tabs, moved };
  },
};
