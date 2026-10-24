import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import { resolveDecisionRecord } from '@/lib/approvalGates/decisionConfirmationRecord';
import { parseDecisionRecord, type ParsedDecision } from '@/lib/approvalGates/decisionRecord';
import { ApprovalGateStaleSubjectError } from '@/lib/approvalGates/errors';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { pageStoreFor } from '@/lib/pages';
import { requireArgsCard, requireGateCard } from './gateCard';
import { applyGateTransition } from './gateTransition';

// THE `decision_confirmation` HANDLER (Story MOTIR-5871 · Subtask MOTIR-5954; ADR
// `docs/decisions/approval-gates.md` §1's MOTIR-5952 amendment, the handler row).
//
// A person CONFIRMS a decision the planner settled WITH them — a `type: decision`
// work item whose `executor` is `human`. The subject is the work item's OWN body,
// parsed (`decisionRecord.ts`), so the gate's `subjectId` is the work item and its
// version is the parser's hash of the four sections.
//
// It follows `decisionChoiceGateHandler` exactly where the two agree — §2's
// routing, `work_item:edit`, a TERMINAL approve that writes `done` through
// `applyStatusTransition` with `decidingGateId` (§8's Workflow A) — and adds ONE
// thing: Confirm stamps the decision's optional written record, or its absence.
//
// ⚠️ ITS REFUSAL IS OVERTURN, NOT `request_changes` (point 6) — a verb with its own
// state (`overturned`), a REQUIRED note, and a terminal write of `cancelled`
// (MOTIR-5956). `requestChanges` is refused at the door by the kind's verb set.

/** Confirming is terminal: Workflow A, the project's `done` category. */
export const CONFIRM_DECISION_TARGET = { key: 'done', category: 'done' } as const;

/** Does this work item ask the CONFIRM question — `decision` decided with a person (point 1)? */
export function asksTheConfirmQuestion(item: { type: string | null; executor: string | null }) {
  return item.type === 'decision' && item.executor === 'human';
}

async function parsedSubject(
  workItemId: string,
  tx: GateEffectArgs['tx'],
): Promise<ParsedDecision | null> {
  const item = await workItemRepository.findById(workItemId, tx);
  if (!item || !asksTheConfirmQuestion(item)) return null;
  const parse = parseDecisionRecord(item.descriptionMd);
  return parse.ok ? parse : null;
}

export const decisionConfirmationGateHandler: GateHandler<ParsedDecision> = {
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<ParsedDecision | null> {
    return parsedSubject(gate.subjectId, tx);
  },

  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    return (await this.resolveSubject(args))?.subjectVersion ?? null;
  },

  // The subject IS the work item — but only while it is a `human` decision whose
  // body still parses. Anything else has nothing to be asked about.
  async currentSubject(args: GateRoutingArgs): Promise<string | null> {
    const item = requireArgsCard(args, 'decision_confirmation', 'decisionConfirmationHandler');
    if (!asksTheConfirmQuestion(item)) return null;
    return parseDecisionRecord(item.descriptionMd).ok ? item.id : null;
  },

  routeTo(args: GateRoutingArgs): string | null {
    return routingTargetId(
      requireArgsCard(args, 'decision_confirmation', 'decisionConfirmationHandler'),
    );
  },

  permission: 'work_item:edit',

  statusIntent: CONFIRM_DECISION_TARGET,

  /**
   * CONFIRM — stamp the record, write `done` (points 7–8). A subject that no longer
   * parses under the lock is the stale refusal: the question itself went away.
   *
   * The record is resolved INSIDE the deciding transaction, so the stamp names the
   * file that was current at the press — and a decision with no record confirms
   * exactly as well, stamping `{ kind: 'none' }` (point 8: never a precondition).
   */
  async approve(args: GateEffectArgs): Promise<GateEffect> {
    const { gate, tx, resolvedStatusKey } = args;
    const subject = await this.resolveSubject(args);
    if (!subject) throw new ApprovalGateStaleSubjectError(gate.id, ['subject']);
    const confirmedRecord = await resolveDecisionRecord(
      requireGateCard(gate, 'decisionConfirmationHandler'),
      tx,
    );
    // A PAGE record is frozen in the deciding write (MOTIR-7435), under the page's
    // lock — the one every save takes — so a racing save lands before the freeze
    // or starts the next version; "confirmed" and "frozen" cannot diverge.
    if (confirmedRecord.kind === 'page') {
      await pageStoreFor(tx).lockPage(confirmedRecord.pageId);
      await pageVersionRepository.freezeVersion(confirmedRecord.versionId, gate.id, new Date(), tx);
    }
    if (resolvedStatusKey === null) {
      return {
        statusWritten: null,
        statusDeferredReason: 'no_status_in_target_category',
        confirmedRecord,
      };
    }
    // Never meets MARKED_CARD_CANNOT_REOPEN (MOTIR-6681): the target is the done
    // category, and the obsolescence mark refuses only a move OUT of it.
    await applyGateTransition(
      args,
      requireGateCard(gate, 'decisionConfirmationHandler'),
      resolvedStatusKey,
      { decidingGateId: gate.id },
    );
    return { statusWritten: resolvedStatusKey, confirmedRecord };
  },

  /**
   * OVERTURN — "that's not what we discussed" (points 6–7). Writes the project's
   * `cancelled` status, so the decision stops counting as open work, and NOTHING
   * ELSE: not one other work item moves. The re-plan it owes is DERIVED from the
   * subject's `## Supersedes` on read (`replanOwed`), and it is a planning act a
   * person starts — never a gate effect.
   *
   * The door has already refused an empty note, and resolved `cancelled` BY KEY: a
   * project with no such status gets the decision recorded and no status written.
   * A subject that stopped parsing under the lock is stale, exactly as for Confirm.
   */
  async overturn(args: GateEffectArgs): Promise<GateEffect> {
    const { gate, resolvedStatusKey } = args;
    const subject = await this.resolveSubject(args);
    if (!subject) throw new ApprovalGateStaleSubjectError(gate.id, ['subject']);
    if (resolvedStatusKey === null) {
      return { statusWritten: null, statusDeferredReason: 'no_status_in_target_category' };
    }
    // Never meets MARKED_CARD_CANNOT_REOPEN (MOTIR-6681): the target is the done
    // category, and the obsolescence mark refuses only a move OUT of it.
    await applyGateTransition(
      args,
      requireGateCard(gate, 'decisionConfirmationHandler'),
      resolvedStatusKey,
      { decidingGateId: gate.id },
    );
    return { statusWritten: resolvedStatusKey };
  },

  /**
   * Never reached: `request_changes` is not in this kind's verb set (point 6), and
   * the door refuses it before dispatching. Answered rather than thrown so the
   * registry's contract stays total; a caller that reached it would move nothing.
   */
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
};
