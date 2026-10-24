import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import {
  chosenOptionOf,
  parseChoiceOptions,
  type ParsedChoice,
} from '@/lib/approvalGates/choiceOptions';
import {
  ApprovalGateStaleSubjectError,
  ApprovalGateVerbNotOfferedError,
} from '@/lib/approvalGates/errors';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { requireArgsCard, requireGateCard } from './gateCard';
import { applyGateTransition } from './gateTransition';

// THE `decision_choice` HANDLER (Story MOTIR-4914 · Subtask MOTIR-5891; ADR
// `docs/decisions/approval-gates.md` §1's MOTIR-5887 amendment, the handler row).
//
// A person PICKS one of the options a `type: choice` work item states. The
// subject is the work item's OWN body, parsed (`choiceOptions.ts`) — never a
// structured copy — so the gate's `subjectId` is the work item and its version is
// the parser's hash of the sections the pick is made over.
//
// It follows `designResultHandler` exactly where the two agree — ADR §2's
// routing, `work_item:edit`, a TERMINAL approve that writes `done` through
// `applyStatusTransition` with `decidingGateId` (§8's Workflow A), a refusal that
// moves nothing — and differs in ONE place: its approve carries an argument, the
// option picked, which it refuses unless the subject holds it.

/** Choosing is terminal: Workflow A, the project's `done` category. */
export const CHOICE_DECISION_TARGET = { key: 'done', category: 'done' } as const;

async function parsedSubject(
  workItemId: string,
  tx: GateEffectArgs['tx'],
): Promise<ParsedChoice | null> {
  const item = await workItemRepository.findById(workItemId, tx);
  if (!item || item.type !== 'choice') return null;
  const parse = parseChoiceOptions(item.descriptionMd);
  return parse.ok ? parse : null;
}

export const decisionChoiceGateHandler: GateHandler<ParsedChoice> = {
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<ParsedChoice | null> {
    return parsedSubject(gate.subjectId, tx);
  },

  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    return (await this.resolveSubject(args))?.subjectVersion ?? null;
  },

  // The subject IS the work item, so the "current subject" is the item itself —
  // but only while its body still parses as a choice. A body that stopped
  // parsing has no subject to be asked about.
  async currentSubject(args: GateRoutingArgs): Promise<string | null> {
    const item = requireArgsCard(args, 'decision_choice', 'decisionChoiceHandler');
    if (item.type !== 'choice') return null;
    return parseChoiceOptions(item.descriptionMd).ok ? item.id : null;
  },

  routeTo(args: GateRoutingArgs): string | null {
    return routingTargetId(requireArgsCard(args, 'decision_choice', 'decisionChoiceHandler'));
  },

  permission: 'work_item:edit',

  statusIntent: CHOICE_DECISION_TARGET,

  /**
   * CHOOSE — record the pick and write `done` (points 5–7). Reached only as the
   * door's `choose` verb, so `choice` is always present here; the door refuses
   * `approve` on this kind before dispatching.
   *
   * The option must be one the subject holds. The door has already compared the
   * reader's stamp, so the options here ARE the ones they were shown: an id not
   * among them was never offered (`unknown_option`, a 400), not a body that moved.
   * A subject that no longer parses at all is the stale refusal — the question
   * itself went away under the lock.
   */
  async approve(args: GateEffectArgs): Promise<GateEffect> {
    const { gate, resolvedStatusKey, choice } = args;
    const subject = await this.resolveSubject(args);
    if (!subject) throw new ApprovalGateStaleSubjectError(gate.id, ['subject']);
    const chosenOption = choice ? chosenOptionOf(subject, choice.optionId) : null;
    if (!chosenOption) throw new ApprovalGateVerbNotOfferedError(gate.id, 'unknown_option');
    if (resolvedStatusKey === null) {
      return {
        statusWritten: null,
        statusDeferredReason: 'no_status_in_target_category',
        chosenOption,
      };
    }
    // Never meets MARKED_CARD_CANNOT_REOPEN (MOTIR-6681): the target is the done
    // category, and the obsolescence mark refuses only a move OUT of it.
    await applyGateTransition(
      args,
      requireGateCard(gate, 'decisionChoiceHandler'),
      resolvedStatusKey,
      {
        decidingGateId: gate.id,
      },
    );
    return { statusWritten: resolvedStatusKey, chosenOption };
  },

  /** NONE OF THESE — record `changes_requested`, move nothing, as `design_result` does. */
  async requestChanges(): Promise<GateEffect> {
    return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
  },
};
