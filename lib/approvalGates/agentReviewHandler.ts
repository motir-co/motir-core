import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import type { ApprovalGateState } from '@/generated/prisma/client';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { listOwnDeliveriesWithChecks } from '@/lib/approvalGates/ownDeliveries';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { reconcileGatesFor } from '@/lib/services/gateSetFor';
import type { GateSettingsDoor } from './settingsDoor';
import { requireArgsCard, requireGateCard } from './gateCard';
import type { PullRequestApprovalSubject } from './pullRequestApprovalHandler';

// THE `agent_review` HANDLER — the REVIEW AGENT's question (Story MOTIR-1626 · MOTIR-6819;
// ADR `docs/decisions/approval-gates.md` §12).
//
// A hosted AI reviews the run target's delivery set against the card BEFORE anyone is
// asked to approve it. It is the approve-and-merge gate's question — *is this code right
// for this card?* — one step earlier, so its subject is exactly that gate's (§12.1: one
// stamp, one function) and a pass hands its version to that gate unchanged (§12.4).
//
// ⚠️ IT OWNS NO STATUS TRANSITION. A pass raises the ORDINARY FLOW, which owns its own
// writes; the agent's Request changes records findings and moves nothing — the card is To
// fix `changes_requested` by derivation (`lib/workItems/fixReason.ts`), never by a write.
//
// ⚠️ WHO DECIDES IT is the door's to enforce, not this file's: the agent through the
// internal `approvalGatesService.decideAgentReview` entry (authority `review_agent`, which
// `resolveGateAuthority` never returns), or the routed person APPROVING with a reason —
// *Continue without the review* (§12.3). A person has no refusal verb on this kind.
//
// Raised ONLY by the gate set (`resolveGateSet` → `reconcileGatesFor`), on the green
// verdict with the switch on — never on review entry (`currentSubject` answers null).

/**
 * THE KIND'S SETTINGS DOOR (MOTIR-6825; `design/github/design-notes.md` § 30, band 3) — the
 * Approvals room's review-agent switch (`REVIEW_AGENT_ANCHOR`), handed only to a holder of
 * `workflow:manage` by `settingsDoorFor`.
 */
export const REVIEW_AGENT_SETTINGS_DOOR: GateSettingsDoor = {
  href: '/settings/project/approvals#review-agent',
  labelKey: 'reviewAgent',
};

export const agentReviewGateHandler: GateHandler<PullRequestApprovalSubject> = {
  /**
   * The run target's delivery SET — the approve-and-merge gate's own subject (§12.1) — less
   * every pull request an ancestor also delivers. The gate is raised over the card's OWN
   * members (`gateSetFor`, Bug MOTIR-11624), so the version a decision is checked against
   * is measured over the same set: over every linked row, a child sharing one pull request
   * with its story read a version that never matched its gate, and the review agent's
   * verdict was refused as stale (Bug MOTIR-11693).
   */
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<PullRequestApprovalSubject | null> {
    const deliveries = await listOwnDeliveriesWithChecks(gate.subjectId, tx);
    return deliveries.length > 0 ? deliveries : null;
  },

  /** WHICH commits were reviewed — `deliverySetVersion`, the merge gate's spelling. */
  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    const deliveries = await this.resolveSubject(args);
    return deliveries
      ? deliverySetVersion(deliveries.map((delivery) => deliveryMemberVersion(delivery)))
      : null;
  },

  /**
   * NO raise on review entry. The review is owed on the GREEN VERDICT with the switch on,
   * which only the gate set can judge; a review-entry raise would ask the agent about a
   * set that is not green (§12.2).
   */
  async currentSubject(): Promise<string | null> {
    return null;
  },

  /**
   * ADR §2's rule, written for §12.3's override ONLY — the gate is never listed on a
   * person's To approve (`awaitingRoutedToWhere` excludes the kind) and notifies nobody.
   */
  routeTo(args: GateRoutingArgs): string | null {
    return routingTargetId(requireArgsCard(args, 'agent_review', 'agentReviewHandler'));
  },

  /** A person's floor — the approve-and-merge gate's own (§12.1's registry row). */
  permission: 'work_item:edit',

  settingsDoor: REVIEW_AGENT_SETTINGS_DOOR,

  statusIntent: null,

  /**
   * APPROVE — the agent's pass, or a person continuing without it. Writes no status. The
   * ordinary flow for the SAME version is raised by {@link afterDecisionWritten}, in this
   * transaction, once the row reads `approved`; AFTER the commit the card is settled the
   * way a green verdict settles it — the post-raise GitHub review evaluation, and the merge
   * a primary's approval was carrying while the review held it (§12.2).
   */
  async approve({ gate, ctx }: GateEffectArgs): Promise<GateEffect> {
    const workItemId = requireGateCard(gate, 'agentReviewHandler');
    return {
      statusWritten: null,
      statusDeferredReason: 'agent_review_moves_nothing',
      afterCommit: async () => {
        // Lazy: `ciPromotion` reaches `workItemsService`, which reaches the decide door
        // that reaches this registry — the same cycle `planApprovalHandler` loads around.
        const { settleAfterPrimaryApproval } = await import('@/lib/services/ciPromotion');
        await settleAfterPrimaryApproval(workItemId, {
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        });
      },
    };
  },

  /** REQUEST CHANGES — the agent's findings are the note; nothing moves, nothing re-runs. */
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'agent_review_moves_nothing' };
  },

  /**
   * A PASS RAISES THE ORDINARY FLOW FOR THE SAME VERSION (§12.4) — `pull_request_approval`
   * at the reviewed `subjectVersion`, through `reconcileGatesFor`, the one creator. Under
   * the card's row lock, which the reconcile relies on its caller holding; taken after the
   * gate's, the order every transition takes them in. A refusal raises nothing: the gate
   * set reads a decided refusal at this version and asks nothing more for it.
   */
  async afterDecisionWritten(args: GateEffectArgs & { state: ApprovalGateState }): Promise<void> {
    if (args.state !== 'approved') return;
    const workItemId = requireGateCard(args.gate, 'agentReviewHandler');
    await workItemRepository.lockById(workItemId, args.tx);
    const item = await workItemRepository.findById(workItemId, args.tx);
    if (item) await reconcileGatesFor(item, args.tx);
  },
};
