import type { AcceptanceEvidence } from '@/generated/prisma/client';
import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { acceptanceEvidenceRepository } from '@/lib/repositories/acceptanceEvidenceRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { hasOpenOwnDelivery } from './verdictOffer';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { isTerminalStatus } from '@/lib/workItems/blockerReadiness';
import { workflowsService } from '@/lib/services/workflowsService';
import { requireArgsCard, requireGateCard } from './gateCard';
import { applyGateTransition } from './gateTransition';

// THE `acceptance_result` HANDLER — a story's acceptance receipt, decided through
// the one gate contract (Story MOTIR-4949 · Subtask MOTIR-4950; ADR
// `docs/decisions/approval-gates.md` §1, the MOTIR-5787 amendment).
//
// The acceptance vocabulary is where §1's approval language came from, and until
// this handler the acceptance decision still ran through its own path
// (`acceptanceEvidenceService.decide`), invisible to every surface built for gates.
// This handler is that path moved INTO the contract: the same stamp on the
// receipt, the same lock, and a status rule that no longer writes `done`
// unconditionally.
//
// ⚠️ THE GATE HANGS ON THE STORY. `acceptance_evidence.work_item_id` is always a
// story (`acceptanceEvidenceService.resolveStory` refuses anything else, and
// `publish_acceptance_result` resolves a leaf key UP to its story), and the gate is
// raised on the receipt's own work item — so it is the story's whatever card the
// run was launched against (the amendment's point 1).

/**
 * The status INTENT, exactly the design gate's: this project's `done`. It is what
 * lets §6d's rule 1 hold a story's move into `done` while its acceptance question
 * is awaiting — the parent rollup, the board and every other door are refused
 * that move until somebody answers.
 */
export const ACCEPTANCE_APPROVAL_TARGET = { key: 'done', category: 'done' } as const;

/**
 * Whether approving acceptance may write `done` on the story itself — the
 * amendment's point 7, read inside the deciding transaction.
 *
 * ⚠️ THE DESIGN HANDLER'S DISCRIMINATOR CANNOT BE COPIED, and this is why this
 * function exists. `designResultGateHandler.approve` asks
 * `countOpenByWorkItem(gate.workItemId)` — the GATED CARD's own deliveries. On a
 * single-card run the story delivers nothing (the open pull request is the E2E
 * subtask's), so that count is 0, the arm would write `done`, and
 * `childStatusCascadeService` would then close every not-done child — the subtask
 * whose pull request is still open, and every sibling not yet built. So the answer
 * is read over the story's SUBTREE:
 *
 * | the story …                                     | writes `done`? | who writes it then              |
 * | ----------------------------------------------- | -------------- | ------------------------------- |
 * | has an open delivery of its own (a story run)   | no             | the merge                       |
 * | has ANY live descendant not in the done category | no            | `parentStatusRollupService`     |
 * | otherwise                                        | **yes**       | this approval — it is TERMINAL  |
 *
 * `done` keeps exactly one writer in every row.
 */
async function nothingLeftForTheCascade(
  args: GateEffectArgs,
): Promise<
  { terminal: true } | { terminal: false; reason: 'merge_writes_done' | 'rollup_writes_done' }
> {
  const { gate, tx } = args;
  const item = requireArgsCard(args, 'acceptance_result', 'acceptanceResultHandler');
  // The RUN SHAPE, read through the one function the verdict offer reads too
  // (`verdictOffer.ts`, MOTIR-6501), so the door that asks for a verdict and this
  // handler never disagree about whether the story is a story run.
  if (await hasOpenOwnDelivery(requireGateCard(gate, 'acceptanceResultHandler'), tx)) {
    return { terminal: false, reason: 'merge_writes_done' };
  }

  const [members, terminalByProject] = await Promise.all([
    workItemRepository.findSubtreeMembersForValidity(
      requireGateCard(gate, 'acceptanceResultHandler'),
      item.workspaceId,
      tx,
    ),
    workflowsService.getTerminalStatusKeysByProjects([item.projectId], item.workspaceId, tx),
  ]);
  // Parent ↔ child is same-project, so the root's terminal set judges every member.
  const openDescendant = members.some(
    (member) =>
      member.id !== requireGateCard(gate, 'acceptanceResultHandler') &&
      !isTerminalStatus({ status: member.status, projectId: item.projectId }, terminalByProject),
  );
  return openDescendant ? { terminal: false, reason: 'rollup_writes_done' } : { terminal: true };
}

/**
 * Stamp the receipt the gate asked about, under the receipt lock the retired decide
 * path took (MOTIR-2851).
 *
 * ⚠️ THE STAMP IS WHAT KEEPS THE FREEZE FIRING. `persistEvidence` refuses a
 * republish over a receipt whose status is `approved` (MOTIR-2764;
 * `acceptance-receipt-lifecycle.md` §2) — and the amendment's point 6 keeps that
 * refusal as THE closed-receipt rule rather than minting a Q3-shaped one. So an
 * approval that recorded the gate and left the receipt `pending` would reopen the
 * very window the freeze closed. The two writes are in the door's one transaction.
 *
 * ⚠️ LOCK ORDER: the door already holds the GATE row; this takes the receipt. The
 * publish path retires the awaiting gate BEFORE it locks the receipt, so both paths
 * take `approval_gate` then `acceptance_evidence` and a race resolves by waiting —
 * the ordering `designEvidenceService` records for its own pair.
 */
async function stampReceipt(
  args: GateEffectArgs,
  status: 'approved' | 'changes_requested',
): Promise<void> {
  const { gate, ctx, tx } = args;
  await acceptanceEvidenceRepository.lockCurrentStatusByWorkItem(
    requireGateCard(gate, 'acceptanceResultHandler'),
    tx,
  );
  const approved = status === 'approved';
  await acceptanceEvidenceRepository.updateStatus(
    gate.subjectId,
    {
      status,
      approvedById: approved ? ctx.userId : null,
      approvedAt: approved ? new Date() : null,
    },
    tx,
  );
}

export const acceptanceResultGateHandler: GateHandler<AcceptanceEvidence> = {
  /**
   * The receipt the gate was raised for — by ID, never "the story's current
   * receipt". A republish makes a different row current, and a current-row read
   * would re-point an in-flight question at a recording the reviewer never watched
   * (the discipline `designResultGateHandler.resolveSubject` records).
   */
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<AcceptanceEvidence | null> {
    return acceptanceEvidenceRepository.findById(gate.subjectId, tx);
  },

  /** The commit the recorded run was at, or null when the publish carried none. */
  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    const subject = await this.resolveSubject(args);
    return subject?.commitSha ?? null;
  },

  /**
   * The story's CURRENT receipt — what a gate raised now would ask about (§6d
   * AMENDMENT, rule 7) — or null when there is none, or when it is already
   * approved: that question has been answered, and re-opening the story does not
   * un-answer it. A reworked story asks again by publishing a NEW recording, which
   * supersedes this one and keeps its bytes (`acceptance-receipt-lifecycle.md`
   * AMENDMENT 1, MOTIR-5872).
   */
  async currentSubject(args: GateRoutingArgs): Promise<string | null> {
    const item = requireArgsCard(args, 'acceptance_result', 'acceptanceResultHandler');
    const current = await acceptanceEvidenceRepository.findCurrentByWorkItem(item.id, args.tx);
    if (!current || current.status === 'approved') return null;
    return current.id;
  },

  /** ADR §2: `assigneeId ?? reporterId` — the story's. */
  routeTo(args: GateRoutingArgs): string | null {
    return routingTargetId(requireArgsCard(args, 'acceptance_result', 'acceptanceResultHandler'));
  },

  /**
   * The FLOOR, exactly the old path's: `acceptanceEvidenceService.decide` gated
   * through `updateStatus` → `assertCanEdit` → `work_item:edit`. §2's relationship
   * test is applied by the door on top of it.
   */
  permission: 'work_item:edit',

  statusIntent: ACCEPTANCE_APPROVAL_TARGET,

  /**
   * APPROVE — stamp the receipt `approved`, then write `done` ONLY when nothing
   * under the story is left for the cascade to close (the amendment's point 7).
   *
   * The transition goes through `workItemsService.applyStatusTransition`, the one
   * status funnel, in the door's transaction — `decidingGateId` exempts THIS gate
   * from §6d's guard, which would otherwise refuse the very move it exists to make.
   */
  async approve(args: GateEffectArgs): Promise<GateEffect> {
    await stampReceipt(args, 'approved');

    const verdict = await nothingLeftForTheCascade(args);
    if (!verdict.terminal) return { statusWritten: null, statusDeferredReason: verdict.reason };
    if (args.resolvedStatusKey === null) {
      return { statusWritten: null, statusDeferredReason: 'no_status_in_target_category' };
    }
    // Never meets MARKED_CARD_CANNOT_REOPEN (MOTIR-6681): the target is the done
    // category, and the obsolescence mark refuses only a move OUT of it.
    await applyGateTransition(
      args,
      requireGateCard(args.gate, 'acceptanceResultHandler'),
      args.resolvedStatusKey,
      { decidingGateId: args.gate.id },
    );
    return { statusWritten: args.resolvedStatusKey };
  },

  /**
   * REQUEST CHANGES — stamp the receipt `changes_requested`, and write NO status on any
   * verdict (`acceptance-refusal-verdict.md` §2). The retired path also moved the story
   * `in_review → in_progress`; that write retires with it.
   *
   * ⚠️ ON A STORY RUN, EITHER VERDICT WITHDRAWS THE STORY'S OTHER WAITING APPROVALS
   * (MOTIR-6503; §3). The door offers a verdict exactly on a story run
   * (`refusalVerdictOfferFor`), so a non-null `refusalVerdict` IS the story-run arm. The
   * paired merge gate is the one that matters: left awaiting, one press on it would merge
   * the code the reviewer just refused. It is superseded `pulled_back` in THIS
   * transaction, the deciding gate excluded, and the children and their gates are not
   * touched. Re-run and Re-plan make the SAME write — what differs is what comes next
   * (`motir fix` or the planner). The gate set then HOLDS the merge until a newer receipt
   * (`acceptanceRefusalHoldsMerge`), which is what keeps it withdrawn.
   *
   * `returnCardToTodo` is deliberately NOT used: nothing moves.
   *
   * A verdict-less refusal — a finished story's, or one synced from GitHub — withdraws
   * nothing and holds nothing, as before.
   */
  async requestChanges(args: GateEffectArgs): Promise<GateEffect> {
    await stampReceipt(args, 'changes_requested');
    if (args.refusalVerdict === null || args.refusalVerdict === undefined) {
      return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
    }
    await approvalGateRepository.supersedeOtherAwaitingByWorkItem(
      requireGateCard(args.gate, 'acceptanceResultHandler'),
      args.gate.id,
      'pulled_back',
      args.tx,
    );
    return {
      statusWritten: null,
      statusDeferredReason: 'acceptance_refusal_withdraws_merge_only',
    };
  },
};
