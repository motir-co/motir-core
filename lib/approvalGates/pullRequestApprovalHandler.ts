import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import type { GateSettingsDoor } from '@/lib/approvalGates/settingsDoor';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { routingTargetId } from '@/lib/approvalGates/routing';
import {
  workItemDeliveryRepository,
  type WorkItemDeliveryWithChecks,
} from '@/lib/repositories/workItemDeliveryRepository';
import { decisionHoldsMerge } from '@/lib/approvalGates/decisionApprovalHandler';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { acceptanceResultHoldsMerge, designResultHoldsMerge } from '@/lib/services/mergeGates';
import { ApprovalGatePrimaryPendingError } from '@/lib/approvalGates/errors';
import { requireArgsCard, requireGateCard } from './gateCard';
import { applyGateTransition } from './gateTransition';

// THE `pull_request_approval` HANDLER — the registry's THIRD member (Story MOTIR-4909 ·
// MOTIR-5481; ADR docs/decisions/approval-gates.md §8's amendment, decisions 2 and 6).
//
// ONE question over the card's pull requests TOGETHER: *are these commits right?* Its
// subject is the run target's DELIVERY SET, so `subjectId` is the work item's own id and
// §6b's partial unique index over `(work_item_id, kind, subject_id)` in `awaiting` holds
// ONE awaiting approve-and-merge gate per card with no index of its own.
//
// ⚠️ LIKE THE MERGE HANDLER, IT DOES NOTHING OUTSIDE THE DATABASE. Approving writes
// `approved` in the door's transaction and stops there; each pull request is merged or
// enqueued AFTER that commit by MOTIR-5483's press, through MOTIR-4882's entry point
// (decision 5). This file never names a Git host.

/** The status an approval moves the card to — ADR §6b's `approved`, between In Review
 *  and Done. An INTENT the door resolves per project; see {@link approve} for why the
 *  resolved key is checked before it is written. */
export const PULL_REQUEST_APPROVAL_TARGET = { key: 'approved', category: 'in_progress' } as const;

/**
 * The door this gate's frame carries (MOTIR-5513): the project setting that decides
 * whether merges ask a person at all, at `PrMergeModeCard`'s `#merge-mode` anchor.
 *
 * ⚠️ IT MOVED HERE FROM THE MERGE HANDLER (MOTIR-5616), and moving it rather than
 * deleting it is the point. The door was declared on `pull_request_merge`, which that
 * card retires — and the SETTING it points at did not retire with the kind: a project
 * whose `prMergeMode` is `manual` is precisely the project that raises THIS gate
 * (`pullRequestApprovalGates.raisePullRequestApprovalGate` returns false for `auto`).
 * Letting the door die with its old declaration would have removed a shipped
 * capability inside a retirement, which is the thing a retirement must not do.
 */
export const MERGE_MODE_SETTINGS_DOOR: GateSettingsDoor = {
  href: '/settings/project/approvals#merge-mode',
  labelKey: 'mergeMode',
};

/** What the gate is about: every delivery row the run target carries, with each pull
 *  request's check rows (its head) and repository. */
export type PullRequestApprovalSubject = WorkItemDeliveryWithChecks[];

// The set version lives in `deliverySetVersion.ts`, which imports no service, because the
// raise and the head-move withdrawal compute it inside the CI promotion too (MOTIR-5482).
export { deliverySetVersion };

export const pullRequestApprovalGateHandler: GateHandler<PullRequestApprovalSubject> = {
  /**
   * The subject is the card's delivery SET, read in the door's transaction. Null when
   * the card delivers nothing — the gate asks about pull requests, and there are none.
   *
   * `github_pull_request` stores no head sha of its own: a member's head is its latest
   * check run's commit, which is exactly the window the all-green verdict (and so the
   * gate) was formed over. `deliveryMemberVersion` reads it the merge handler's way.
   */
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<PullRequestApprovalSubject | null> {
    const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(
      gate.subjectId,
      tx,
    );
    return deliveries.length > 0 ? deliveries : null;
  },

  /** WHICH commits were approved — the set's canonical string (decision 2). */
  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    const deliveries = await this.resolveSubject(args);
    return deliveries
      ? deliverySetVersion(deliveries.map((delivery) => deliveryMemberVersion(delivery)))
      : null;
  },

  /**
   * NO re-ask on review entry (ADR `approval-gates.md` §6d AMENDMENT, rule 7 ·
   * MOTIR-5532): always `null` — the merge kind's answer, for the same reason.
   *
   * ⚠️ NOT an omission. This kind already asks again on its OWN trigger: the card's
   * WHOLE delivery set turning green raises the gate in the same transaction as the
   * `implemented → in_review` promotion, and re-raises it on the next green after a
   * withdrawal (MOTIR-5482, `pullRequestApprovalGates.ts`). A review-entry raise would
   * be a second writer of the same question — and one that could ask about a set whose
   * checks are not green, which decision 3 forbids.
   */
  async currentSubject(): Promise<string | null> {
    return null;
  },

  /** ADR §2: `assigneeId ?? reporterId` — the routing rule every kind shares. */
  routeTo(args: GateRoutingArgs): string | null {
    return routingTargetId(
      requireArgsCard(args, 'pull_request_approval', 'pullRequestApprovalHandler'),
    );
  },

  /**
   * The FLOOR — `work_item:edit`, the design gate's. Pressing it records a decision and
   * moves the card; the MERGE a press then performs asserts THIS SAME floor on each
   * member (`pullRequestMergeService`'s `APPROVAL_MERGE_PERMISSION`), because carrying a
   * decision out is not a second decision. It named a floor of its own,
   * `work_item:merge_pull_request`, until MOTIR-5613 re-keyed the merge onto this gate
   * and MOTIR-5616 retired that key. Who may press on top of the floor is the door's §2
   * rule, `resolveGateAuthority` (decision 6).
   */
  permission: 'work_item:edit',

  statusIntent: PULL_REQUEST_APPROVAL_TARGET,

  /** The merge-mode switch, which decides whether this gate is raised at all. */
  settingsDoor: MERGE_MODE_SETTINGS_DOOR,

  /**
   * APPROVE — record the decision (the door does that) and move the card to `approved`.
   *
   * ⚠️ THE RESOLVED KEY IS CHECKED, NOT TRUSTED. The door resolves the intent through
   * `workflowsService.resolveStatusKey`, which prefers the key and falls back to the
   * CATEGORY — and `approved` shares `in_progress` with In Progress, Implemented and In
   * Review. On a workflow with no `approved` status that fallback answers some OTHER
   * in-progress status, and writing it would move an approved card sideways or back to
   * In Progress, reading as though nobody had looked. So anything but `approved` writes
   * no status and says why; the decision is still recorded.
   *
   * The transition goes through `workItemsService.applyStatusTransition` in the door's
   * transaction — the one status funnel — never a raw column write.
   *
   * `decidingGateId`: this gate is still `awaiting` here (the door writes the decision
   * AFTER the effect), and `approved` is exactly the move an awaiting gate — and an open
   * delivering pull request — holds (`heldMoves`, ADR §6d AMENDMENT rules 1, 2b and 5).
   * Without it the guard would refuse the very move this approval exists to make. It
   * exempts THIS gate only.
   */
  async approve(args: GateEffectArgs): Promise<GateEffect> {
    const { gate, tx, resolvedStatusKey } = args;
    // ⚠️ THE MERGE FOLLOWS THE DESIGN, WHATEVER DOOR IT IS PRESSED THROUGH (Bug MOTIR-5785;
    // `design-result.md` AMENDMENT 6 Q1). MOTIR-5712 hid this gate from the To-approve
    // queue on a design card, and MOTIR-5762 held the `auto` arm and the GitHub review
    // sync — but the gate itself is still real, and any door naming its id (the REST
    // route, the merge row pressed alone) reached the merge over an undecided design. So
    // it is refused HERE, under the door's lock, before anything is written. Awaiting,
    // sent back, or approved for a result since superseded all hold (`designHoldsMerge`).
    // The design's own press decides the design first and this gate after, so it never
    // meets the refusal; Request changes is never refused.
    if (await designResultHoldsMerge(requireGateCard(gate, 'pullRequestApprovalHandler'), tx)) {
      throw new ApprovalGatePrimaryPendingError(
        requireGateCard(gate, 'pullRequestApprovalHandler'),
        'design',
      );
    }
    // ⚠️ …AND THE DECISION, the other primary (Story MOTIR-4907 · MOTIR-5677;
    // `approval-gates.md` §8's FIFTH AMENDMENT, clause 5), refused with the same tag so
    // the two primaries cannot drift into two differently-worded rules (MOTIR-5785).
    const item = await workItemRepository.findById(
      requireGateCard(gate, 'pullRequestApprovalHandler'),
      tx,
    );
    if (item && (await decisionHoldsMerge(item, tx))) {
      throw new ApprovalGatePrimaryPendingError(
        requireGateCard(gate, 'pullRequestApprovalHandler'),
        'decision',
      );
    }
    // ⚠️ …AND A STORY RUN'S REFUSED ACCEPTANCE (MOTIR-6503; `acceptance-refusal-verdict.md`
    // §3). The refusal withdrew this story's merge gate and the gate set asks no new one
    // while it stands, but a gate row can still be named from a stale page or the REST
    // route — so the merge of the code the reviewer sent back is refused here too, until a
    // newer video is approved.
    if (await acceptanceResultHoldsMerge(requireGateCard(gate, 'pullRequestApprovalHandler'), tx)) {
      throw new ApprovalGatePrimaryPendingError(
        requireGateCard(gate, 'pullRequestApprovalHandler'),
        'acceptance',
      );
    }
    if (resolvedStatusKey !== PULL_REQUEST_APPROVAL_TARGET.key) {
      return { statusWritten: null, statusDeferredReason: 'no_status_in_target_category' };
    }
    // MARKED_CARD_CANNOT_REOPEN (MOTIR-6681) PROPAGATES: this is a person's press, and
    // `approved` is outside the done category. A card marked under the rule is `done`
    // and holds no merge gate; only a LEGACY card marked while open can reach here,
    // and the refusal is the right answer to the person pressing — clear the mark.
    await applyGateTransition(
      args,
      requireGateCard(gate, 'pullRequestApprovalHandler'),
      resolvedStatusKey,
      { decidingGateId: gate.id },
    );
    return { statusWritten: resolvedStatusKey };
  },

  /** REQUEST CHANGES — record the decision and move nothing. */
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
};
