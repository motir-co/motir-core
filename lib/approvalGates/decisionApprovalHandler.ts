import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { requireArgsCard } from '@/lib/approvalGates/gateCard';
import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import { asksTheDecisionQuestion } from '@/lib/approvalGates/decisionDocument';
import {
  decisionIdentityOf,
  decisionSubjectVersion,
  type DecisionIdentity,
  type DecisionMember,
  type PageDecisionIdentity,
} from '@/lib/approvalGates/decisionSubject';
import { ApprovalGateDecisionUnresolvableError } from '@/lib/approvalGates/errors';
import { decisionApprovalStandsForMerge } from '@/lib/approvalGates/gateSet';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { decisionPagePublicationRepository } from '@/lib/repositories/decisionPagePublicationRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { pageStoreFor } from '@/lib/pages';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { applyGateTransition } from './gateTransition';
import {
  workItemDeliveryRepository,
  type WorkItemDeliveryWithChecks,
} from '@/lib/repositories/workItemDeliveryRepository';

// THE `decision_approval` HANDLER (Story MOTIR-4907 · Subtask MOTIR-5676; ADR
// `docs/decisions/approval-gates.md` §8's FIFTH AMENDMENT).
//
// ONE question: *is this decision right?* — asked of the ONE `docs/decisions/*.md`
// file a `decision` + `coding_agent` card's pull request carries. It is the design
// gate's arrangement with a document for its port: PRIMARY over the approve-to-merge
// gate, one press decides both, and the merge webhook stays the only writer of `done`.
//
// ⚠️ EVERY SEAM HERE READS THE DATABASE AND NOTHING ELSE. The door calls them inside
// its transaction, under the gate's lock, and a transaction may not wait on a Git
// host (clause 7). So the subject is the document's IDENTITY — path and blob sha,
// captured onto the pull request when its head was observed (MOTIR-5674) — and the
// CONTENT a person reads is fetched separately, outside any transaction, through the
// resolver (`decisionDocumentResolver.ts`, `decisionDocumentService.ts`).
//
// ⚠️ MOTIR STORES NO DOCUMENT. Nothing here writes one, and the gate row carries only
// an opaque `subjectId` (the card) and a version string (the blob) — so moving
// decision documents into a pages domain later is a resolver change, never a
// migration on the audit table.
//
// ⚠️ AND NOW IT DOES ASK ABOUT A PAGE (Story MOTIR-5761 · MOTIR-7433; §8 NINTH
// AMENDMENT). A card that PUBLISHED a page version (`decisionPageService.publish`)
// is asked about that version, and the page WINS over any file its pull requests
// carry. The version string is `page:<pageId>@<versionId>`, still opaque to the
// gate table; Approve FREEZES that version in the door's transaction and, with no
// pull request open, writes `done` — so "approved" and "frozen" cannot diverge.

/** The `done` the page arm writes — the design gate's intent, for the same reason:
 *  a project may have renamed its statuses, so this is an INTENT, never a key. */
export const DECISION_APPROVAL_TARGET = { key: 'done', category: 'done' } as const;

/**
 * The card's OPEN delivering pull requests, as the subject reads them. A merged or
 * closed pull request asks nothing: its document either already shipped or never
 * will.
 */
export function decisionMembersOf(
  deliveries: readonly WorkItemDeliveryWithChecks[],
): DecisionMember[] {
  return deliveries
    .filter((delivery) => delivery.pullRequest.state === 'open' && !delivery.pullRequest.merged)
    .map((delivery) => ({
      repo: `${delivery.repo.owner}/${delivery.repo.name}`,
      number: delivery.pullRequest.number,
      outcome: delivery.pullRequest.decisionDocOutcome,
      path: delivery.pullRequest.decisionDocPath,
      blobSha: delivery.pullRequest.decisionDocBlobSha,
      headSha: delivery.pullRequest.decisionDocHeadSha,
      paths: delivery.pullRequest.decisionDocPaths,
    }));
}

/**
 * The decision identity of ONE card, read on the caller's transaction — the single
 * place the handler, the gate set (MOTIR-5677) and the document read load it from,
 * so they cannot disagree about what the card is being asked.
 */
export async function loadDecisionIdentity(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<DecisionIdentity | null> {
  // A PUBLISHED PAGE WINS (§8 NINTH AMENDMENT clause 2): read first, and only a
  // card with no publication falls through to the capture on its pull requests.
  return (
    (await loadPageDecisionIdentity(workItemId, tx)) ??
    decisionIdentityOf(
      decisionMembersOf(await workItemDeliveryRepository.listByWorkItemWithChecks(workItemId, tx)),
    )
  );
}

/**
 * The card's PUBLISHED PAGE as a decision identity, or `null` when it has none — the
 * half of {@link loadDecisionIdentity} the gate set (which reads the deliveries itself)
 * calls directly, so both answer "a page wins" from one read.
 */
export async function loadPageDecisionIdentity(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<PageDecisionIdentity | null> {
  const publication = await decisionPagePublicationRepository.latestForWorkItem(workItemId, tx);
  if (!publication) return null;
  const [version, page] = await Promise.all([
    pageVersionRepository.findVersionById(publication.pageVersionId, tx),
    pageRepository.findById(publication.pageId, tx),
  ]);
  // The version cannot go while the publication stands (its FK refuses it), so a
  // miss is a page invisible to this reader — read on as if unpublished.
  if (!version || !page) return null;
  return {
    source: 'page',
    resolvable: true,
    pageId: page.id,
    versionId: version.id,
    versionNumber: version.number,
    title: page.title,
  };
}

/**
 * DOES THE DECISION HOLD THIS CARD'S MERGE? (Story MOTIR-4907 · MOTIR-5677;
 * `approval-gates.md` §8's FIFTH AMENDMENT, clauses 5 and 6.)
 *
 * True for a `decision` + `coding_agent` card whose decision has NOT been approved over
 * the document its pull requests carry now — awaiting, sent back, unresolvable, never
 * captured, or approved over a document a later push rewrote. False for every other
 * card, which is what keeps a code card's and a design card's merges exactly as they
 * were.
 *
 * ⚠️ ONE ANSWER FOR EVERY DOOR THAT WOULD MERGE. `settleGreenVerdict`'s `auto` arm, the
 * approve-to-merge gate's own `approve` (the item page's merge row, the REST route) and
 * the GitHub review sync all ask it, so *the merge follows only the decision* is one
 * statement rather than three that could drift.
 */
export async function decisionHoldsMerge(
  item: Pick<WorkItem, 'id' | 'type' | 'executor'>,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  if (!asksTheDecisionQuestion(item)) return false;
  const [identity, latestDecisionGate, openPullRequests] = await Promise.all([
    loadDecisionIdentity(item.id, tx),
    approvalGateRepository.findLatestByWorkItem(item.id, 'decision_approval', tx),
    workItemDeliveryRepository.countOpenByWorkItem(item.id, tx),
  ]);
  // A PAGE decision with no pull request open holds no merge — there is none.
  if (identity?.source === 'page' && openPullRequests === 0) return false;
  return !decisionApprovalStandsForMerge(identity, latestDecisionGate);
}

export const decisionApprovalGateHandler: GateHandler<DecisionIdentity> = {
  /**
   * The document's IDENTITY (clause 1) — which file, at which blob, in which pull
   * request — or null when no open pull request delivers the card or none has been
   * captured. `subjectId` is the card, so this reads the card's delivery set.
   *
   * An UNRESOLVABLE identity is still a subject (clause 3): the gate exists, says
   * why, and holds the merge. Only `approve` refuses it.
   */
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<DecisionIdentity | null> {
    return loadDecisionIdentity(gate.subjectId, tx);
  },

  /** `owner/name:path@blobSha`, the unresolvable form (clause 4), or
   *  `page:<pageId>@<versionId>` for a published page (NINTH AMENDMENT clause 2). */
  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    const identity = await this.resolveSubject(args);
    return identity ? decisionSubjectVersion(identity) : null;
  },

  /**
   * RE-ASK ON REVIEW ENTRY (ADR §6d AMENDMENT, rule 7): the card itself, when it asks
   * the decision question at all (clause 10) and a captured head gives it something to
   * ask about; otherwise null.
   *
   * ⚠️ A `human` decision card answers null ALWAYS — its choice is Story MOTIR-4914's
   * `decision_choice`, never this gate — and so does every card whose TYPE is not
   * `decision`, whatever files its pull request touches.
   */
  async currentSubject(args: GateRoutingArgs): Promise<string | null> {
    const item = requireArgsCard(args, 'decision_approval', 'decisionApprovalHandler');
    if (!asksTheDecisionQuestion(item)) return null;
    return (await loadDecisionIdentity(item.id, args.tx)) ? item.id : null;
  },

  /** ADR §2: `assigneeId ?? reporterId` — the routing rule every kind shares. */
  routeTo(args: GateRoutingArgs): string | null {
    return routingTargetId(requireArgsCard(args, 'decision_approval', 'decisionApprovalHandler'));
  },

  /** The design gate's floor. Who may press on top of it is the door's §2 rule. */
  permission: 'work_item:edit',

  /**
   * `done` — written ONLY by the page arm with no pull request open (§8 NINTH
   * AMENDMENT clause 4, §3's first row), where nothing will ever merge and so
   * nothing else would write it. A FILE decision always has a pull request open
   * (clause 2), so its press still writes no status (clause 5): `approved` is the
   * COMPANION approve-to-merge gate's, and `done` the merge webhook's. The intent
   * is also what holds a hand move to `done` while a page decision awaits — with
   * a pull request open the merge already held it, so a file decision's holds are
   * unchanged.
   */
  statusIntent: DECISION_APPROVAL_TARGET,

  /**
   * APPROVE — for a FILE decision, record the decision (the door does that) and move
   * nothing, exactly as `designResultGateHandler.approve` does while a pull request is
   * open — and for a file one always is (clause 2). A PAGE decision freezes its
   * version and, with no pull request open, writes `done` (the page arm below). The merge that follows is carried by the press
   * (`pullRequestMergeService`) and, when the set is not green yet, by the next green
   * verdict (MOTIR-5677).
   *
   * ⚠️ REFUSED WHILE UNRESOLVABLE (clause 3), read UNDER THE DOOR'S LOCK from the
   * capture. A card whose pull requests carry no document, several, or one the host
   * could not name has nothing a person can have read and accepted.
   */
  async approve(args: GateEffectArgs): Promise<GateEffect> {
    const identity = await this.resolveSubject(args);
    if (!identity) throw new ApprovalGateDecisionUnresolvableError('none');
    if (!identity.resolvable) throw new ApprovalGateDecisionUnresolvableError(identity.reason);
    if (identity.source !== 'page') {
      return { statusWritten: null, statusDeferredReason: 'merge_writes_done' };
    }

    // THE PAGE ARM. Lock the card, then the page — the publish's order after the
    // gate this door already holds — so a racing save serialises behind the
    // freeze and starts a new version rather than extending the frozen one.
    const { gate, tx, resolvedStatusKey } = args;
    const workItemId = gate.subjectId;
    await workItemRepository.lockById(workItemId, tx);
    await pageStoreFor(tx).lockPage(identity.pageId);
    await pageVersionRepository.freezeVersion(identity.versionId, gate.id, new Date(), tx);

    if ((await workItemDeliveryRepository.countOpenByWorkItem(workItemId, tx)) > 0) {
      // The merge writes `done`; `approved` is the companion merge gate's (clause 5).
      return { statusWritten: null, statusDeferredReason: 'merge_writes_done' };
    }
    if (resolvedStatusKey === null) {
      return { statusWritten: null, statusDeferredReason: 'no_status_in_target_category' };
    }
    // `decidingGateId` exempts THIS gate from the approval-gate guard: it is still
    // `awaiting` here, the door writing the decision after the effect.
    await applyGateTransition(args, workItemId, resolvedStatusKey, { decidingGateId: gate.id });
    return { statusWritten: resolvedStatusKey };
  },

  /**
   * REQUEST CHANGES — record the decision and move nothing. ALLOWED on an unresolvable
   * subject: *"there is no document here"* is exactly what it exists to say.
   */
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
};
