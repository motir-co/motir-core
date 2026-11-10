import type { Prisma } from '@/generated/prisma/client';
import {
  deriveReviewState,
  reviewAnswerAt,
  skippedByName,
  type ReviewState,
  type ReviewStateFacts,
  type ReviewStateMember,
} from '@/lib/agentReview/reviewState';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { parseMemberVersion } from '@/lib/approvalGates/memberVersion';
import { routedToDisplayName, routingTargetId } from '@/lib/approvalGates/routing';
import { reviewCommitsLabel } from '@/lib/agentReview/verdictActivity';
import {
  toCardReviewDto,
  toReviewStateDto,
  type ApprovedReviewDTO,
  type CardReviewMap,
  type ReviewStateDTO,
} from '@/lib/dto/reviewState';
import { githubPullRequestReviewRepository } from '@/lib/repositories/githubPullRequestReviewRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  reviewStateRepository,
  type ReviewStateCardRow,
  type ReviewStatePersonRow,
} from '@/lib/repositories/reviewStateRepository';
import type { WorkItemDeliveryWithChecks } from '@/lib/repositories/workItemDeliveryRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE REVIEW STATE READ MODEL (Story MOTIR-10327 · MOTIR-10340; `approval-gates.md` §12;
// `design/github/design-notes.md` § 32). ONE place answers, per card at its CURRENT
// delivery-set version, what every surface says about its agent review — the marker, the
// Reviewed state, the review line, a review to run, and whether the
// routed person opened every pull request — so the board, the list, the header, To approve
// and the gate frame cannot disagree about the same card at the same commits.
//
// ⚠️ A FIXED NUMBER OF QUERIES, whatever the page's size: every read below is one batch
// over the whole set (`reviewStateRepository`), and the derivation is pure
// (`lib/agentReview/reviewState.ts`). A per-card read here would cost a board page one
// round trip per card.
//
// ⚠️ ACCESS TRAVELS INTO THE READ. Every query runs in the reader's workspace transaction,
// so RLS keeps another workspace's card out, and a project the reader may not browse
// answers an empty map — never an error, the no-existence-leak convention the decision
// marker follows (`approvalGatesService.pendingDecisionsFor`).
//
// ⚠️ IT DECIDES NOTHING AND WRITES NOTHING. It never records a verdict, dismisses,
// supersedes or posts.

/**
 * §2's routed person — `assigneeId ?? reporterId` (`routingTargetId`). A card always has a
 * reporter, so a card always has one.
 */
function routedIdOf(card: ReviewStateCardRow): string {
  /* v8 ignore next -- `reporterId` is NOT NULL on `work_item`. */
  return routingTargetId(card) ?? card.reporterId;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const list = out.get(k) ?? [];
    list.push(row);
    out.set(k, list);
  }
  return out;
}

/** The set's version and its members; a member whose rows RLS hid makes the version unknown. */
function setOf(
  deliveries: readonly WorkItemDeliveryWithChecks[],
  reviewsByPr: Map<string, ReviewStateMember['reviews']>,
): { version: string | null; members: ReviewStateMember[] } {
  const members: ReviewStateMember[] = [];
  const versions: (string | null)[] = [];
  for (const delivery of deliveries) {
    // The type says these joins are never null; under RLS they can be (MOTIR-8215). A set
    // with a member the reader cannot see has no version anybody can name.
    /* v8 ignore next 6 -- a repository that left the card's organisation; the read model
       answers it as an unknown version rather than the 500 MOTIR-8215 fixed. */
    if (
      (delivery.pullRequest as WorkItemDeliveryWithChecks['pullRequest'] | null) === null ||
      (delivery.repo as WorkItemDeliveryWithChecks['repo'] | null) === null
    ) {
      return { version: null, members: [] };
    }
    const version = deliveryMemberVersion(delivery);
    versions.push(version);
    const member = version ? parseMemberVersion(version) : null;
    if (!member) continue;
    members.push({
      repo: member.repo,
      number: member.number,
      headSha: member.headSha,
      authorGithubUserId: delivery.pullRequest.authorGithubUserId,
      reviews: reviewsByPr.get(delivery.githubPullRequestId) ?? [],
    });
  }
  return { version: deliverySetVersion(versions), members };
}

/**
 * The review state of `workItemIds` in `projectId`, inside the caller's workspace-bound
 * transaction. A card that is not in the project, or not visible, is absent from the map.
 */
export async function readReviewStates(
  projectId: string,
  workItemIds: readonly string[],
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<Map<string, ReviewStateDTO>> {
  const out = new Map<string, ReviewStateDTO>();
  const project = await projectRepository.findById(projectId, tx);
  if (!project || project.workspaceId !== ctx.workspaceId) return out;
  if ((await projectAccessService.filterBrowsable([project], ctx, tx)).length === 0) return out;

  // ⚠️ THE ASKED CARDS ONLY — never their subtrees. A container used to carry an *n of m
  // reviewed* count over its tree, which made a page of 50 tree roots read every card under
  // its epics (2,751 on the MOTIR project) and ran `/items` past the 5 s transaction limit.
  // The count was dropped: a container wears no review state of its own.
  const allIds = [...new Set(workItemIds)];
  const [cards, statuses, deliveries, agentGates, latestDecided, records, dismissals] =
    await Promise.all([
      reviewStateRepository.listCards(allIds, tx),
      workflowsService.listStatusesByProject(projectId, ctx.workspaceId, tx),
      reviewStateRepository.listDeliveries(allIds, tx),
      reviewStateRepository.listAgentReviewGates(allIds, tx),
      reviewStateRepository.listLatestDecidedGates(allIds, tx),
      reviewStateRepository.listRecords(allIds, tx),
      reviewStateRepository.listDismissals(allIds, tx),
    ]);

  const finishedStatuses = new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
  const isFinished = (card: ReviewStateCardRow) => finishedStatuses.has(card.status);

  const awaitingGateIds = agentGates.filter((g) => g.state === 'awaiting').map((g) => g.id);
  const prIds = [
    ...new Set(
      deliveries
        .filter((d) => (d.pullRequest as unknown) !== null)
        .map((d) => d.githubPullRequestId),
    ),
  ];
  const personIds = new Set<string>();
  for (const card of cards) personIds.add(routedIdOf(card));
  for (const gate of agentGates) if (gate.decidedById) personIds.add(gate.decidedById);
  const [running, reviews, people] = await Promise.all([
    reviewStateRepository.listGateIdsWithRunningReview(ctx.workspaceId, awaitingGateIds, tx),
    githubPullRequestReviewRepository.listForPullRequests(prIds, tx),
    reviewStateRepository.listPeople([...personIds], tx),
  ]);

  const personById = new Map<string, ReviewStatePersonRow>(people.map((p) => [p.id, p] as const));
  const nameOf = (id: string | null) =>
    id ? routedToDisplayName(personById.get(id) ?? null) : null;
  const reviewsByPr = groupBy(reviews, (r) => r.githubPullRequestId);
  const deliveriesByCard = groupBy(deliveries, (d) => d.workItemId);
  const gatesByCard = groupBy(agentGates, (g) => g.workItemId);
  const latestByCard = new Map(
    latestDecided.flatMap((g) => (g.workItemId ? [[g.workItemId, g] as const] : [])),
  );
  const recordsByCard = groupBy(records, (r) => r.workItemId);
  const dismissalsByCard = groupBy(dismissals, (d) => d.workItemId);

  const stateOf = (card: ReviewStateCardRow): ReviewState => {
    const id = card.id;
    const set = setOf(deliveriesByCard.get(id) ?? [], reviewsByPr);
    const routedId = routedIdOf(card);
    const routed = personById.get(routedId);
    const gates = gatesByCard.get(id) ?? [];
    const facts: ReviewStateFacts = {
      identifier: card.identifier,
      finished: isFinished(card),
      reviewAgentEnabled: project.reviewAgentEnabled,
      reviewAgentSource: project.reviewAgentSource,
      currentVersion: set.version,
      members: set.members,
      agentGates: gates.map((gate) => ({ ...gate, decidedByName: nameOf(gate.decidedById) })),
      latestDecidedGate: latestByCard.get(id) ?? null,
      records: (recordsByCard.get(id) ?? []).map((record) => ({
        ...record,
        submittedByName: record.submittedBy?.name ?? null,
      })),
      dismissals: (dismissalsByCard.get(id) ?? []).map((dismissal) => ({
        ...dismissal,
        dismissedByName: dismissal.dismissedBy?.name ?? null,
      })),
      reviewRunInFlight: gates.some((g) => g.state === 'awaiting' && running.has(g.id)),
      routedTo: { id: routedId, name: nameOf(routedId) },
      routedGithubUserId: routed?.githubUserId ?? null,
      viewerUserId: ctx.userId,
    };
    return deriveReviewState(facts);
  };

  // In the asked order; a card of another project, or none, is absent from the map.
  const cardById = new Map(cards.map((card) => [card.id, card] as const));
  for (const id of allIds) {
    const card = cardById.get(id);
    if (card?.projectId === projectId) out.set(id, toReviewStateDto(card, stateOf(card)));
  }
  return out;
}

/** The pure derivation, exported beside the read so it can be pinned without a database. */
/** The key {@link readApprovedReviews} answers by — one card at one version. */
export function approvedReviewKey(workItemId: string, subjectVersion: string): string {
  return `${workItemId}\u0000${subjectVersion}`;
}

/**
 * WHAT ANSWERED THE AGENT REVIEW AT EACH APPROVED VERSION (MOTIR-10338) — the approval
 * record's second clause, for a whole page of approved merge gates in a FIXED number of
 * queries (records, `agent_review` gates, dismissals, then the skipping deciders' names).
 * Read at the version the merge was APPROVED at, never the card's current one, by the
 * review line's own precedence (`reviewAnswerAt`). The callers hand only gates they already
 * read under the workspace's context, so every card id here is the reader's.
 */
export async function readApprovedReviews(
  approved: readonly { workItemId: string; subjectVersion: string }[],
  tx: Prisma.TransactionClient,
): Promise<Map<string, ApprovedReviewDTO>> {
  const out = new Map<string, ApprovedReviewDTO>();
  if (approved.length === 0) return out;
  const ids = [...new Set(approved.map((a) => a.workItemId))];
  const [agentGates, records, dismissals] = await Promise.all([
    reviewStateRepository.listAgentReviewGates(ids, tx),
    reviewStateRepository.listRecords(ids, tx),
    reviewStateRepository.listDismissals(ids, tx),
  ]);
  const deciderIds = [
    ...new Set(agentGates.flatMap((g) => (g.decidedById ? [g.decidedById] : []))),
  ];
  const people = await reviewStateRepository.listPeople(deciderIds, tx);
  const personById = new Map(people.map((p) => [p.id, p] as const));
  const gatesByCard = groupBy(agentGates, (g) => g.workItemId);
  const recordsByCard = groupBy(records, (r) => r.workItemId);
  const dismissalsByCard = groupBy(dismissals, (d) => d.workItemId);

  for (const { workItemId, subjectVersion } of approved) {
    const answer = reviewAnswerAt(subjectVersion, {
      agentGates: (gatesByCard.get(workItemId) ?? []).map((gate) => ({
        ...gate,
        decidedByName: gate.decidedById
          ? routedToDisplayName(personById.get(gate.decidedById) ?? null)
          : null,
      })),
      records: (recordsByCard.get(workItemId) ?? []).map((record) => ({
        ...record,
        submittedByName: record.submittedBy?.name ?? null,
      })),
      dismissals: (dismissalsByCard.get(workItemId) ?? []).map((dismissal) => ({
        ...dismissal,
        dismissedByName: dismissal.dismissedBy?.name ?? null,
      })),
    });
    out.set(approvedReviewKey(workItemId, subjectVersion), approvedReviewDtoOf(answer));
  }
  return out;
}

function approvedReviewDtoOf(answer: ReturnType<typeof reviewAnswerAt>): ApprovedReviewDTO {
  switch (answer.kind) {
    case 'reviewed':
      return { kind: 'reviewed', commits: reviewCommitsLabel(answer.pass.subjectVersion) };
    case 'dismissed':
      return {
        kind: 'dismissed',
        by: answer.dismissal.dismissedByName,
        reason: answer.dismissal.reasonMd,
      };
    case 'skipped':
      return { kind: 'skipped', by: skippedByName(answer.gate), reason: answer.gate.noteMd };
    case 'none':
      return { kind: 'none' };
  }
}

export { deriveReviewState } from '@/lib/agentReview/reviewState';

export const reviewStateService = {
  /**
   * The review state of a page of cards — the board, a list, To approve. ONE workspace-bound
   * transaction and a fixed number of queries for the whole page.
   */
  async forCards(
    projectId: string,
    workItemIds: readonly string[],
    ctx: ServiceContext,
  ): Promise<Map<string, ReviewStateDTO>> {
    if (workItemIds.length === 0) return new Map();
    return withWorkspaceContext(ctx, (tx) => readReviewStates(projectId, workItemIds, ctx, tx));
  },

  /**
   * WHAT THE CARD SURFACES DRAW (MOTIR-10341) — the board, a List / Tree level and the item
   * header: {@link forCards}' one batch, sliced to the marker, the Reviewed state and the
   * container count, with an entry only for a card that wears one.
   */
  async cardReviewsFor(
    projectId: string,
    workItemIds: readonly string[],
    ctx: ServiceContext,
  ): Promise<CardReviewMap> {
    const out: CardReviewMap = {};
    for (const [id, state] of await reviewStateService.forCards(projectId, workItemIds, ctx)) {
      const card = toCardReviewDto(state);
      if (card) out[id] = card;
    }
    return out;
  },

  /** One card's review state — the item header and the gate frame. Null when not visible. */
  async forCard(
    projectId: string,
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<ReviewStateDTO | null> {
    return (
      (await reviewStateService.forCards(projectId, [workItemId], ctx)).get(workItemId) ?? null
    );
  },
};
