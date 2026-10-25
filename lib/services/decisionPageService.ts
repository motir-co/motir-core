import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { decisionPagePublicationRepository } from '@/lib/repositories/decisionPagePublicationRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { AppliedGateTransition } from '@/lib/approvalGates/registry';
import { emitAppliedGateTransitions } from '@/lib/approvalGates/gateTransition';
import { reconcileGatesFor } from '@/lib/services/gateSetFor';
import { asksTheDecisionQuestion } from '@/lib/approvalGates/decisionDocument';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { isTerminalStatus } from '@/lib/workItems/blockerReadiness';
import { RUNG_RANK, rankOfStatus } from '@/lib/workItems/statusLadder';
import { pageStoreFor } from '@/lib/pages';
import { toDecisionPagePublicationDto } from '@/lib/mappers/decisionPageMappers';
import {
  DecisionCardFinishedError,
  DecisionPageArchivedError,
  DecisionPageEmptyError,
  DecisionPageInAnotherProjectError,
  DecisionPageNotFoundError,
  NotADecisionCardError,
} from '@/lib/decisionPages/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { DecisionPagePublicationDto, PublishDecisionPageInput } from '@/lib/dto/decisionPage';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// PUBLISH A PAGE AS A CARD'S DECISION (Story MOTIR-5761 · MOTIR-7432;
// `docs/decisions/approval-gates.md` §8 NINTH AMENDMENT, clauses 1–3, and
// `docs/decisions/pages.md` AMENDMENT 3).
//
// One transaction: SEAL the page's latest version, record a
// `decision_page_publication`, and on an AGENT decision card raise
// `decision_approval` about that version — superseding an awaiting one with the
// cause `republished` — and walk the card to review, as a design result's
// publish does. A HUMAN decision card raises nothing and moves nothing: the
// publication is its candidate record (clause 7).
//
// ⚠️ LOCK ORDER: the card's awaiting gates → the card → the page. That is the
// decide door's order (the gate FOR UPDATE, then the card its effect
// transitions, then — for a page subject — the page it freezes), so an Approve
// racing a republish resolves by WAITING. And the page lock is the one every
// save takes (`lockPage`), so a racing save lands INSIDE the version before it
// is sealed, or starts N+1 after it — never extends a sealed one (the version
// policy refuses to, MOTIR-7431).

/** `page:view` on `projectId`, as a boolean — a denial is not an error here. */
async function canViewPages(
  projectId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  try {
    await projectAccessService.assertCanViewPages(projectId, ctx, tx);
    return true;
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError || err instanceof ProjectNotFoundError) {
      return false;
    }
    /* v8 ignore next -- the access read throws only those two; anything else is a fault */
    throw err;
  }
}

/**
 * Walk the card to review when nothing delivers it — the same walk a design
 * result's publish takes (`designEvidenceService.moveToReviewWhenUndelivered`):
 * a card with an open pull request stays where it is (its merge writes the
 * status), and a card already at or above review is left alone. `hopsToReview`
 * lands on `implemented` in a workflow with no review status.
 *
 * ⚠️ EVERY HOP IT APPLIES IS RECORDED ON `appliedTransitions` (Bug MOTIR-9485).
 * `applyStatusTransition` leaves `work-item/transitioned` to its caller, and the
 * caller here is a transaction that may still roll back — so the hop is handed to
 * `publish`, which announces it once the publish has committed. Without it the
 * parent rollup, the bell and automation rules never saw a decision card enter
 * review.
 */
async function moveToReviewWhenUndelivered(
  item: WorkItem,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
  appliedTransitions: AppliedGateTransition[],
): Promise<void> {
  if ((await workItemDeliveryRepository.countOpenByWorkItem(item.id, tx)) > 0) return;
  const statuses = await workflowsService.listStatusesByProject(
    item.projectId,
    ctx.workspaceId,
    tx,
  );
  /* v8 ignore next 5 -- every project's workflow is seeded with the three ladder rungs */
  const rank = rankOfStatus(item.status, statuses, {
    reviewKey: statuses.find((s) => s.key === 'in_review')?.key ?? null,
    implementedKey: statuses.find((s) => s.key === 'implemented')?.key ?? null,
    approvedKey: statuses.find((s) => s.key === 'approved')?.key ?? null,
  });
  if (rank >= RUNG_RANK.in_review) return;
  // LAZY, for the cycle `designEvidenceService` documents: the walk is applied
  // through `workItemsService`, which reaches back into the gate services.
  const { hopsToReview } = await import('@/lib/services/choiceGateService');
  const { workItemsService } = await import('@/lib/services/workItemsService');
  for (const key of await hopsToReview(item, tx)) {
    const { transition } = await workItemsService.applyStatusTransition(item.id, key, ctx, tx);
    /* v8 ignore next -- a hop `hopsToReview` chose always leaves the current status, so it always applies a transition */
    if (transition) appliedTransitions.push({ workItemId: item.id, ...transition });
  }
}

export const decisionPageService = {
  /**
   * Publish the page's LATEST version as the card's decision. `work_item:edit`
   * on the card and `page:view` on the page. Re-publishing the version that is
   * already the card's publication is a REPLAY: it returns that publication and
   * writes nothing, so an agent retrying an unclear result raises no second gate.
   */
  async publish(
    input: PublishDecisionPageInput,
    ctx: ServiceContext,
  ): Promise<DecisionPagePublicationDto> {
    // The walk to review's status hops, announced once this publish commits (Bug
    // MOTIR-9485) — the walk runs in this transaction and cannot.
    const appliedTransitions: AppliedGateTransition[] = [];
    const published = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const found = await workItemRepository.findById(input.workItemId, tx);
        if (!found) throw new WorkItemNotFoundError(input.workItemId);
        await projectAccessService.assertPermission(found.projectId, ctx, 'work_item:edit', tx);
        if (found.type !== 'decision') throw new NotADecisionCardError(found.identifier);
        const agentCard = asksTheDecisionQuestion(found);

        // Locks, in the order the header gives.
        if (agentCard) await approvalGateRepository.lockAwaitingByWorkItem(found.id, tx);
        await workItemRepository.lockById(found.id, tx);
        /* v8 ignore next -- the row is locked, so the re-read cannot miss it */
        const item = (await workItemRepository.findById(found.id, tx)) ?? found;

        const terminal = await workflowsService.getTerminalStatusKeysByProjects(
          [item.projectId],
          ctx.workspaceId,
          tx,
        );
        if (isTerminalStatus(item, terminal)) {
          throw new DecisionCardFinishedError(item.identifier, item.status);
        }

        const page = await pageStoreFor(tx).lockPage(input.pageId);
        if (!page) throw new DecisionPageNotFoundError(input.pageId);
        if (page.projectId !== item.projectId) {
          // Named only to a caller who can read the page where it is filed;
          // anyone else gets the one not-found answer.
          if (await canViewPages(page.projectId, ctx, tx)) {
            throw new DecisionPageInAnotherProjectError(input.pageId, item.identifier);
          }
          throw new DecisionPageNotFoundError(input.pageId);
        }
        /* v8 ignore next 3 -- every built-in role holding work_item:edit also holds
           page:view; only a custom role written without it lands here */
        if (!(await canViewPages(page.projectId, ctx, tx))) {
          throw new DecisionPageNotFoundError(input.pageId);
        }
        if (page.archivedAt !== null) throw new DecisionPageArchivedError(input.pageId);

        const latest = await pageVersionRepository.findLatest(page.id, tx);
        /* v8 ignore next -- a page is created with its first version */
        const body = latest ? await pageVersionRepository.findVersionById(latest.id, tx) : null;
        if (!latest || !body || body.bodyMarkdown.trim() === '') {
          throw new DecisionPageEmptyError(input.pageId);
        }

        const previous = await decisionPagePublicationRepository.latestForWorkItem(item.id, tx);
        if (previous && previous.pageVersionId === latest.id) {
          const [publisher] = await userRepository.findByIds([previous.publishedById], tx);
          return toDecisionPagePublicationDto(previous, {
            workItemKey: item.identifier,
            pageTitle: page.title,
            versionNumber: latest.number,
            /* v8 ignore next -- the publication this replays sealed the version */
            sealedAt: latest.sealedAt ?? previous.publishedAt,
            publishedByName: publisher?.name,
            gateId: null,
            replayed: true,
          });
        }

        const now = new Date();
        await pageVersionRepository.sealVersion(latest.id, now, tx);
        const publication = await decisionPagePublicationRepository.insert(
          {
            workspaceId: ctx.workspaceId,
            projectId: item.projectId,
            workItemId: item.id,
            pageId: page.id,
            pageVersionId: latest.id,
            publishedById: ctx.userId,
            publishedAt: now,
          },
          tx,
        );

        let gateId: string | null = null;
        if (agentCard) {
          // A new version is a new question (§6b): whatever was awaiting — an
          // earlier page version, or a file a pull request carried — is retired.
          await approvalGateRepository.supersedeAwaitingByWorkItem(
            item.id,
            'decision_approval',
            'republished',
            tx,
          );
          // RAISED BY THE PREDICATE (`reconcileGatesFor`), the one place a gate row is
          // created from what the card owes: it now reads the publication just written
          // (MOTIR-7433), so it asks `page:<pageId>@<versionId>` of this card.
          await reconcileGatesFor(item, tx);
          const raised = (await approvalGateRepository.findAwaitingByWorkItem(item.id, tx)).find(
            (gate) => gate.kind === 'decision_approval',
          );
          /* v8 ignore next -- the predicate always asks an agent card's question here */
          gateId = raised?.id ?? null;
          // The status follows the question, after it, in the same transaction.
          await moveToReviewWhenUndelivered(item, ctx, tx, appliedTransitions);
        }

        const [publisher] = await userRepository.findByIds([ctx.userId], tx);
        return toDecisionPagePublicationDto(publication, {
          workItemKey: item.identifier,
          pageTitle: page.title,
          versionNumber: latest.number,
          // A version another card's publication sealed keeps that first seal.
          sealedAt: latest.sealedAt ?? now,
          publishedByName: publisher?.name,
          gateId,
          replayed: false,
        });
      },
    );
    await emitAppliedGateTransitions(appliedTransitions, ctx);
    return published;
  },
};
