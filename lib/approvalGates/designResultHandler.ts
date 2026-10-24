import type { DesignEvidence } from '@/generated/prisma/client';
import { sendEvent } from '@/lib/jobs/sendEvent';
import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { requireArgsCard, requireGateCard } from './gateCard';
import { returnCardToTodo } from './returnToTodo';
import { applyGateTransition } from './gateTransition';

// THE `design_result` HANDLER — the registry's first and, in this build, only
// member (Story MOTIR-4778 · Subtask MOTIR-4790; ADR
// docs/decisions/approval-gates.md §3 and its MOTIR-4911 amendment).
//
// It supplies the five things ADR §1's table asks of a kind — resolve the
// subject, route it, name its permission floor, and say what each verb DOES —
// and nothing else. Everything generic about deciding a gate (the lock, the
// re-read, the actor gate, the state refusals, the write of the decision itself)
// belongs to `approvalGatesService.decide` and is shared by every kind that will
// ever register.

/**
 * The status INTENT an approval resolves against. Never a hard-coded key: a
 * project may have renamed its statuses, so the resolver prefers the key and
 * falls back to the CATEGORY (`workflowsService.resolveStatusKey`). This is the
 * same intent shape `changeRequestStatusSync`'s `LIFECYCLE_TARGET` uses for a
 * merged pull request, deliberately — both are asking for "this project's done".
 */
export const DESIGN_APPROVAL_TARGET = { key: 'done', category: 'done' } as const;

export const designResultGateHandler: GateHandler<DesignEvidence> = {
  /**
   * The subject is the `DesignEvidence` row the gate was created for — the exact
   * VERSION that was published, not "the card's current design".
   *
   * ⚠️ Read by ID, never by `findCurrentByWorkItem`. A gate asks about the bytes
   * somebody is looking at, and a republish makes a different row current: a
   * current-row read would silently re-point an in-flight question at a version
   * the reviewer never saw. ADR §6a is explicit that *"approved the design"* is
   * not evidence and *"approved THESE bytes"* is.
   */
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<DesignEvidence | null> {
    return designEvidenceRepository.findById(gate.subjectId, tx);
  },

  /**
   * The VERSION those bytes are — the published `commitSha` (ADR §6a).
   *
   * ⚠️ IT GOES THROUGH {@link resolveSubject} RATHER THAN READING THE ROW ITSELF,
   * which is not indirection for its own sake: the subject read carries the
   * by-ID discipline in its own note — *a republish makes a different row
   * current, and a current-row read would re-point an in-flight question at a
   * version the reviewer never saw* — and that discipline is the whole content of
   * this field. Two reads would be two chances to get it wrong, and the second
   * one would be the one nobody re-reads.
   *
   * Null when the evidence row no longer resolves, and null when it resolves with
   * no `commitSha` — a design published from a tree with no commit behind it.
   * The door records either as null: an approval whose version is unknown is
   * weaker evidence than one whose version is a sha, and a refusal here would
   * throw the decision away to protect its own footnote.
   */
  async subjectVersion(args: GateEffectArgs): Promise<string | null> {
    const subject = await this.resolveSubject(args);
    return subject?.commitSha ?? null;
  },

  /**
   * The card's CURRENT design result — the `design_evidence_one_current_per_item`
   * row — or null when nothing has been published (ADR §6d AMENDMENT, rule 7).
   *
   * ⚠️ THE CURRENT ROW, which is the opposite of `resolveSubject`'s discipline and
   * correct for the opposite reason. `resolveSubject` answers *what was THIS gate
   * asked about* and must never re-point at a newer version. This answers *what
   * would a gate raised NOW ask about*, which is exactly the current version.
   */
  async currentSubject(args: GateRoutingArgs): Promise<string | null> {
    const item = requireArgsCard(args, 'design_result', 'designResultHandler');
    // ⚠️ THE OPEN-PULL-REQUEST `null` IS GONE (Story MOTIR-5652 · Subtask
    // MOTIR-5662; AMENDMENT 6 Q1 reverses AMENDMENT 4 Q8). It returned null when
    // the card had an open delivering pull request, mirroring the publish path's
    // suppression so the two ends of the rule agreed. They did agree — on a rule
    // that left a card with a published design and an open pull request holding
    // no question at all. Both ends are corrected together, for the same reason
    // they had to match.
    const current = await designEvidenceRepository.findCurrentByWorkItem(item.id, args.tx);
    return current?.id ?? null;
  },

  /** ADR §2: `assigneeId ?? reporterId` — exactly ONE recipient, assignee first.
   *
   *  Called by the PUBLISH path, which is where §6a says the answer is computed
   *  ("at creation; the assignee can change afterwards") — so it takes
   *  {@link GateRoutingArgs}, which is constructible before the gate row exists.
   *  It reads nothing but the item, which is exactly what §2's rule quantifies
   *  over. */
  routeTo(args: GateRoutingArgs): string | null {
    return routingTargetId(requireArgsCard(args, 'design_result', 'designResultHandler'));
  },

  /**
   * The FLOOR. ADR §2's amendment retired the role-derived answer to *who may
   * press* in favour of the relationship rule the door applies — and kept
   * `work_item:edit` as the permission the design gate still sits on, *"applied
   * on top of it, not instead of it"*.
   */
  permission: 'work_item:edit',

  /**
   * ADR §1's table: the design gate owns **the move into the project's `done`
   * category**. An INTENT, never a key — a project may have renamed its
   * statuses, and the door's resolver prefers the key then falls back to the
   * category. The same intent shape `changeRequestStatusSync`'s
   * `LIFECYCLE_TARGET` uses for a merged pull request, deliberately: both are
   * asking for "this project's done".
   */
  statusIntent: DESIGN_APPROVAL_TARGET,

  /**
   * APPROVE — record the decision (the door does that), then move the card.
   *
   * ⚠️ THE DISCRIMINATOR (ADR §8). Approval is a TRIGGER, not a status write, and
   * what it triggers is decided by ONE question asked once, at decision time,
   * from data the product already has: **does this work item have a linked OPEN
   * pull request?** It is READ from the delivery rows — never a setting, never a
   * field on the card — which is the same set `countOtherOpenByWorkItem` already
   * gates the `deferred_open_pr` defer on.
   *
   * | the work item has …             | what approval does                          |
   * | ------------------------------- | ------------------------------------------- |
   * | **no linked OPEN pull request** | write `done`. Approval is TERMINAL          |
   * | **a linked OPEN pull request**  | write NO status — the merge writes `done`   |
   *
   * **The invariant both arms preserve: `done` has exactly ONE writer.** In the
   * first arm nothing will ever merge, so nothing else would write it. In the
   * second the merge webhook writes it, exactly as when a person merges by hand.
   * *"Approved but still `in_review`"* is what a second writer looks like from
   * the board, and it is the collision §8 exists to end.
   *
   * ⚠️ WHY THE SECOND ARM WRITES NOTHING RATHER THAN `approved`, ON THE RECORD.
   * ADR §8's Workflow B lands such a card in the `approved` WORK-ITEM status —
   * and that status does not exist. §6b's amendment says so in its own words:
   * *"This record does not decide the status's MIGRATION — its transitions, its
   * position, and the `restricted`-policy edges it needs are a sibling story's."*
   * That sibling is **MOTIR-4905**, which is `todo`. Verified rather than
   * assumed: `lib/workflows/defaultWorkflow.ts` carries eight statuses and no
   * `approved`, and the live tenant's own project workflow carries the same
   * eight. Writing it here would resolve to `UnknownStatusError` at runtime on
   * every request that reached this arm.
   *
   * So this arm writes no status, which is CORRECT today and not merely
   * expedient: the merge is what moves the card, and that is true with or
   * without an intermediate status to pause in. When MOTIR-4905 ships
   * `approved`, this arm gains one `applyStatusTransition` call and the
   * invariant above is untouched — `done` still has one writer.
   *
   * ⚠️ AND THIS ARM IS NOT THE ORDINARY PATH FOR THIS KIND. ADR §1's amendment
   * keys `design_result` to *"a design with **no pull request**"*; a design that
   * DID open one is Workflow B and takes a `pull_request_approval` gate, which
   * this build leaves as a registry hole. The arm exists because the gate is
   * created when the subject is PUBLISHED and the question is asked at DECISION
   * time — a pull request can appear in between — so a door that assumed its own
   * kind's precondition still held would write `done` over work that had not
   * merged.
   *
   * The transition goes through `workItemsService.applyStatusTransition` — the
   * one shipped status funnel — in the DOOR's transaction, never a raw
   * `work_item.status` write. That is what inherits the row lock, the tenant
   * gate, the project-access gate, the legal-edge validation, the revision row
   * and the `completedAt` stamp; a gate that wrote the column directly would be a
   * second status writer, and the two would eventually disagree about one row in
   * a way that is very hard to trace.
   */
  async approve(args: GateEffectArgs): Promise<GateEffect> {
    const { gate, tx, resolvedStatusKey } = args;
    const openPullRequests = await workItemDeliveryRepository.countOpenByWorkItem(
      requireGateCard(gate, 'designResultHandler'),
      tx,
    );
    if (openPullRequests > 0) {
      return { statusWritten: null, statusDeferredReason: 'merge_writes_done' };
    }

    // A custom workflow with nothing in the `done` category. The resolver's own
    // contract calls null *"a legitimate answer the callers turn into a logged
    // no-op, never a crash"* — the decision is still recorded, which is the
    // audit artefact and the thing the reviewer pressed for.
    if (resolvedStatusKey === null) {
      return { statusWritten: null, statusDeferredReason: 'no_status_in_target_category' };
    }

    // `decidingGateId`: this gate is still `awaiting` here — the door writes the
    // decision AFTER the effect — so without it the approval-gate guard would
    // refuse the very move this approval exists to make (ADR §6d AMENDMENT,
    // rule 5). It exempts THIS gate only.
    // Never meets MARKED_CARD_CANNOT_REOPEN (MOTIR-6681): the target is the done
    // category, and the obsolescence mark refuses only a move OUT of it.
    await applyGateTransition(
      args,
      requireGateCard(gate, 'designResultHandler'),
      resolvedStatusKey,
      {
        decidingGateId: gate.id,
      },
    );
    return { statusWritten: resolvedStatusKey };
  },

  /**
   * REQUEST CHANGES — record the decision and SEND THE DESIGN BACK TO TO DO, on either
   * verdict (Story MOTIR-6070 · MOTIR-6423; `docs/decisions/design-refusal-verdict.md`
   * §1–§2, amending `approval-gates.md` §10c/§10d/§10h).
   *
   * | the refusal …                          | what it does                                     |
   * | -------------------------------------- | ------------------------------------------------ |
   * | pressed in Motir, `revise` or `re_plan` | card → the project's initial To do; the card's  |
   * |                                        | OTHER awaiting gates withdrawn as `pulled_back`  |
   * | synced from GitHub (no verdict)        | nothing — recorded only, as before (§10h note 3) |
   *
   * The two verdicts differ only in what the decided band asks afterwards (a Re-plan
   * asks to open the planner); the status, the withdrawal and `outcomeRef` are the
   * same. The write and the withdrawal are {@link returnCardToTodo}'s, shared with the
   * acceptance Re-run the same record governs (MOTIR-6071).
   *
   * **It re-dispatches nothing.** The revise loop — the agent republishing after a
   * rejection — is Story 9.2's (MOTIR-693). A card at To do is claimable again, and
   * `assertDesignSettled` refuses only over an APPROVED result, so a revised publish
   * raises a fresh gate.
   *
   * Its version supersedes and is reclaimed normally: only an APPROVAL pins its
   * bytes (§6c).
   */
  async requestChanges(args: GateEffectArgs): Promise<GateEffect> {
    // The door admits a verdict ONLY on a Motir-pressed design refusal and requires it
    // there (MOTIR-6421), so a null verdict here IS the GitHub-sourced refusal.
    if (args.refusalVerdict === null) {
      return { statusWritten: null, statusDeferredReason: 'request_changes_moves_nothing' };
    }
    const effect = await returnCardToTodo(args, 'designResultHandler');
    // A REVISE ASKS FOR AN AUTOMATIC HOSTED RE-RUN (Story MOTIR-693 · MOTIR-700;
    // `hosted-design-rerun-and-design-approval-switch.md` §1). Only ASKS: whether the
    // card qualifies (its last run was hosted, it is under the cap, the dispatcher can
    // still run) is the job's to decide, and it records the answer either way. AFTER
    // the commit (§1g) — a start boots a container, and a failed start must never undo
    // the refusal. A Re-plan never re-runs anything (`design-refusal-verdict.md` §3).
    if (args.refusalVerdict !== 'revise') return effect;
    const gateId = args.gate.id;
    const workspaceId = args.gate.workspaceId;
    return {
      ...effect,
      afterCommit: async () => {
        await sendEvent('design/auto-rerun.requested', {
          workspaceId,
          gateId,
          idempotencyKey: gateId,
        });
      },
    };
  },
};
