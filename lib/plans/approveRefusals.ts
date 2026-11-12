// ── EVERY REFUSAL `approvePlan` CAN RAISE, CLASSIFIED BY CAUSE (MOTIR-3936) ───
//
// `planned` is the status that says *the author is finished and a person may now
// decide*. It only means that if the plan a reviewer is handed is one approve
// will accept — so every refusal approve can raise has to be sorted into one of
// two piles, and the sorting has to be a thing a test can read.
//
//   * PLAN-INTERNAL — the plan alone decides it. A dangling ref, a cycle, a
//     kind-parent violation, an out-of-enum value. Nothing about the tree can
//     make it true or false, so it is KNOWABLE at the close and is refused
//     there, while the plan is still `generating` and its author can fix it.
//   * TREE-CAUSED — the world moved between the close and the button. A target
//     went `done`, a repository was disconnected, a parent was archived, the
//     transaction ran out of budget. These CANNOT be caught at the close and
//     must not be, or the check would be a lie in the other direction. What is
//     owed instead is a message the reviewer can act on: which card, what
//     changed, and that the plan's author is who corrects it.
//
// A third pile is honest rather than a hedge: several errors exported by
// `lib/plans/errors.ts` belong to OTHER doors (the append, the deepen, the
// generation callback) and approve cannot raise them at all. They are listed as
// `not-approve` with the door that owns them, because the alternative is an
// enumeration with holes in it, and a hole is where the next unclassified reason
// lands.
//
// ⚠️ THIS TABLE IS THE ONLY PLACE THE CLASSIFICATION LIVES, and
// `tests/plans/approveRefusalClassification.test.ts` derives its subject set
// from `lib/plans/errors.ts`'s own exports and from the two violation arrays
// rather than from a list written beside it. So a refusal reason added later
// FAILS the enumeration until somebody classifies it here — which is the whole
// point: the defect this file exists for was a check that lived in one place and
// not its neighbour, and a hand-kept second copy reproduces that one release
// later.

import { PLAN_GRAMMAR_VIOLATIONS, PLAN_REF_GRAPH_VIOLATIONS } from '@/lib/plans/errors';

/** Where a refusal's truth comes from — see the header. */
export type RefusalCause = 'plan-internal' | 'tree-caused' | 'not-approve';

export interface RefusalClassification {
  /** Why this refusal is in the pile it is in. Required for every member. */
  readonly cause: RefusalCause;
  /**
   * The justification the header demands of a `tree-caused` or `not-approve`
   * entry, and the reason the classification cannot be a bare enum: a reason put
   * in the un-checked pile with no argument is indistinguishable from one nobody
   * looked at.
   */
  readonly justification: string;
}

/**
 * One refusal id per (code, reason) pair — `PLAN_GRAMMAR_VIOLATION:unknown_kind`
 * — and per bare code for the classes carrying no reason union.
 */
export function refusalId(code: string, reason?: string | null): string {
  return reason ? `${code}:${reason}` : code;
}

/**
 * The refusal set, classified. Keys are {@link refusalId} values.
 *
 * ⚠️ ADD A KEY HERE WHEN YOU ADD A REASON OR AN ERROR CLASS. The test will tell
 * you which one is missing; it will not tell you which pile it belongs in, and
 * that judgement is the thing being recorded.
 */
export const APPROVE_REFUSALS: Readonly<Record<string, RefusalClassification>> = {
  // ── PLAN-INTERNAL: refused at the close, before anybody is handed the plan ──
  ...Object.fromEntries(
    PLAN_REF_GRAPH_VIOLATIONS.map((reason) => [
      refusalId('INVALID_PLAN_REF_GRAPH', reason),
      {
        cause: 'plan-internal' as const,
        justification:
          'A property of the proposal set alone — its refs, its edges and its own graph. `plansService.markPlanned` runs the same gate, so it is refused while the plan is still `generating`.',
      },
    ]),
  ),
  ...Object.fromEntries(
    PLAN_GRAMMAR_VIOLATIONS.map((reason) => [
      refusalId('PLAN_GRAMMAR_VIOLATION', reason),
      {
        cause: 'plan-internal' as const,
        justification:
          'The kind-parent grammar and the closed-set columns are decided by the proposal plus the rows it names, both readable at the close — `plansService.markPlanned` runs the same gate.',
      },
    ]),
  ),
  PLAN_PROPOSAL_REFERENCED: {
    cause: 'plan-internal',
    justification:
      'A withdraw refused because a sibling proposal still points at the proposal being taken off the plan. Decided by the plan alone, and raised by `withdrawProposal` rather than reaching approve at all.',
  },
  DUPLICATE_PLAN_TARGET: {
    cause: 'plan-internal',
    justification:
      'Two proposals claiming one work item is a property of the proposal set; the append refuses it and the close would too.',
  },
  INVALID_PROPOSAL: {
    cause: 'plan-internal',
    justification:
      'A malformed proposal body — refused at the write door that received it, so it never reaches a closed plan. ONE shape also reaches approve (MOTIR-6663): a `modify` that marks a target no longer finished. The append, the correction and the close refuse it; approve re-asks only because a target can be reopened while the plan waits, and the 422 names the proposal to remove instead.',
  },
  UNRESOLVED_PLAN_REF: {
    cause: 'plan-internal',
    justification:
      'A `planItem:` ref naming no `add` in this plan. The append refuses it, and `markPlanned` re-runs the same resolution over the whole set.',
  },
  PLAN_ITEM_UNKNOWN_TARGET_REPO: {
    cause: 'plan-internal',
    justification:
      "The pin is a string the proposal carries, checked against the project's repository set — `markPlanned`'s gate resolves it before the plan closes.",
  },
  PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE: {
    cause: 'plan-internal',
    justification:
      "The role is a closed vocabulary and the proposal's own value, so the close decides it.",
  },
  PLAN_HAS_NO_PROPOSALS: {
    cause: 'plan-internal',
    justification:
      "How many proposals a plan holds is the plan alone, and the CLOSE already decides it: `plansService.markPlanned` discards an empty set rather than queueing it (MOTIR-4124). What reaches approve is a LEGACY row that closed before that rule existed — and, until MOTIR-4146, a `planned` plan whose last proposal had just been withdrawn. Both are properties of the plan's own contents.",
  },
  PLAN_ITEM_FIELD_REJECTED: {
    cause: 'plan-internal',
    justification:
      'A proposed value the `work_item` schema rejects. The closed-set columns (`kind`, `type`) are checked by the grammar gate at the close; this class remains the backstop for anything the ORM refuses that no gate models yet, and it is a 422 rather than a 500.',
  },

  // ── TREE-CAUSED: the world moved while the plan waited ──────────────────────
  PLAN_TARGET_IMMUTABLE: {
    cause: 'tree-caused',
    justification:
      "A `modify`/`remove` target reached a TERMINAL status after the plan closed. The close cannot foresee a transition nobody has made yet; what is owed is the card's key and title and a routing sentence, which the message carries. `plansService.approvePlan` also moves the plan to the drift status so the reviewer is not left holding an unapprovable plan.",
  },
  PLAN_ITEM_TARGET_MISSING: {
    cause: 'tree-caused',
    justification:
      'The work item a `modify`/`remove` names was deleted or archived between the close and the button. Not knowable at the close by construction.',
  },
  // MOTIR-11039 — a role in the vocabulary that the project's set cannot resolve.
  PLAN_ITEM_UNRESOLVABLE_TARGET_REPO_ROLE: {
    cause: 'tree-caused',
    justification:
      "The project's repository SET decides it, and the set can move between the close and the button — a second row of the role added, or the first row of a set appended — so the append and the correction refuse it when they can, and approve refuses it again, naming the card and the rows, before anything is written.",
  },
  PLAN_PROPOSAL_REPO_PIN_MOVED: {
    cause: 'tree-caused',
    justification:
      "A correction moved a proposal's repo pin between approve's pre-transaction snapshot and its transaction. It is a race INSIDE approve, so no earlier check can reach it.",
  },
  PLAN_APPROVE_TIMED_OUT: {
    cause: 'tree-caused',
    justification:
      "The transaction budget was exhausted — a property of the database's load at the moment the button was pressed, not of the plan.",
  },
  PLAN_NOT_IN_EXPECTED_STATUS: {
    cause: 'tree-caused',
    justification:
      'A concurrent approve or decline already moved the plan. The close cannot foresee another actor.',
  },
  PLAN_NOT_FOUND: {
    cause: 'tree-caused',
    justification: 'The plan was deleted between the close and the button.',
  },
  PLAN_APPROVING: {
    cause: 'tree-caused',
    justification:
      'Another approve of this plan has claimed it and is materializing (Bug MOTIR-9006). A property of concurrency, not of the plan.',
  },
  PLAN_REVISION_IN_FLIGHT: {
    cause: 'tree-caused',
    justification:
      'Another write to this plan is in flight. A property of concurrency, not of the plan.',
  },
  // The decide door's entrance refusals (MOTIR-6038) — none is a property of the
  // proposal set, so none is checked at the close.
  PLAN_NOT_DECIDABLE_YET: {
    cause: 'tree-caused',
    justification:
      'The plan reached `planned` before its approval gate was raised (the pre-backfill state). A property of when the plan closed, not of what it proposes.',
  },
  PLAN_GATE_AWAITING: {
    cause: 'tree-caused',
    justification:
      "A plain approve / decline body met an awaiting plan gate under the plan lock — a question raised between an entrance's read and its write. A property of concurrency, not of the plan.",
  },
  PLAN_DECISION_STAMP_REQUIRED: {
    cause: 'tree-caused',
    justification:
      'A press of an asked plan arrived without the stamp its reader was shown. A property of the REQUEST, not of the plan; the close has nothing to check.',
  },
  WORK_ITEM_LINK_CYCLE: {
    cause: 'tree-caused',
    justification:
      "The `work_item_link` no-cycle trigger, raised from inside `materialize`. The plan's OWN cycles are refused at the close by the edge-graph check; what survives is a ring closed by an edge somebody committed AFTER the plan closed — which is tree-caused by definition. It must still reach the caller as a typed 409, never a bare 500.",
  },
  SELF_LINK: {
    cause: 'tree-caused',
    justification:
      'A proposal edge whose two ends resolve to one work item. The close refuses the shapes it can see (`assertRefsSelfConsistent`); this is the trigger backstop, and like every trigger rejection it must arrive as a typed 4xx.',
  },
  CROSS_WORKSPACE_LINK: {
    cause: 'tree-caused',
    justification:
      'The two ends of an edge resolve into different workspaces. `runPersistGate` reads workspace-scoped, so a ref that resolves at the close cannot be cross-workspace then; reaching this means the row moved or the service guard was bypassed. Typed 404 — never a bare 500, and never a message confirming the far end exists elsewhere.',
  },
  DUPLICATE_LINK: {
    cause: 'tree-caused',
    justification:
      "The edge already exists — somebody wired it by hand while the plan waited. `createManyIfAbsent` absorbs it on the `add` path; a `modify`'s `blockedByAdd` can still meet it, and it is a 409.",
  },
  WORKSPACE_MISMATCH_LINK: {
    cause: 'tree-caused',
    justification:
      'An invariant violation the trigger catches. It stays a 500 by design (`linkErrors.ts`) — but a CLASSIFIED one carrying its code, not the bare rethrow this card exists to remove.',
  },
  PLAN_PERSISTENCE_FAILED: {
    cause: 'tree-caused',
    justification:
      'The wrapper for a database failure inside `materialize` that no gate models. It carries a code and a message, which is the property this card asserts.',
  },

  // ── NOT RAISED BY APPROVE: other doors own these ────────────────────────────
  NO_PLAN_FOR_JOB: {
    cause: 'not-approve',
    justification:
      'The generation callback resolves a plan by job id; approve is handed a plan id.',
  },
  PLANNER_BUG_CAP_EXCEEDED: {
    cause: 'not-approve',
    justification:
      "The planner's `log-bug` door refusing a sixth filing on one job (MOTIR-4076) — a bound on a work-item WRITE counted on the plan's trail. Approve materializes proposals and files nothing.",
  },
  NO_PLAN_FOR_WORK_ITEM: {
    cause: 'not-approve',
    justification: "The work-item plan lookup's refusal. Approve never asks that question.",
  },
  PLAN_ITEM_NOT_FOUND: {
    cause: 'not-approve',
    justification:
      'The deepen and correction doors address ONE proposal by id; approve addresses the plan.',
  },
  PLAN_NOT_GENERATING: {
    cause: 'not-approve',
    justification:
      "The append and deepen doors' status refusal. Approve's own status refusal is `PLAN_NOT_IN_EXPECTED_STATUS`.",
  },
  PLAN_NOT_EDITABLE: {
    cause: 'not-approve',
    justification:
      "The correction doors' status refusal — a plan already `approved` or `declined` cannot be corrected. Approve does not edit proposals.",
  },
  INVALID_PLAN_HISTORY_CURSOR: {
    cause: 'not-approve',
    justification:
      "The work-item plan-history read's refusal of a malformed page cursor (MOTIR-5546). Approve takes a plan id and pages nothing.",
  },
  APPROVED_SHAPE_VERDICT_TOO_MANY_IDS: {
    cause: 'not-approve',
    justification:
      "The approved-shape verdict read's refusal of an oversized id set (MOTIR-6225). It compares cards against an ALREADY approved plan; approve takes one plan id and reads no verdict.",
  },
  APPROVED_SHAPE_NOT_A_CHILD: {
    cause: 'not-approve',
    justification:
      "The approved-shape verdict MCP door's refusal of a `childKeys` entry that is not a child of `key` (MOTIR-6227). It reads a verdict against an ALREADY approved plan; approve takes one plan id and resolves no child keys.",
  },
  PLAN_REVISION_CLASSIFICATION_INVALID: {
    cause: 'not-approve',
    justification:
      "The re-plan classification door's refusal (MOTIR-5543) — a branch outside the four, missing or oversized evidence, a branch-vs-bug disagreement, or a key naming something that is not a `bug` in the plan's own project. It records WHY a reviewer asked for a change on an UNAPPROVED plan; approve is the act that ends that window, and it classifies nothing.",
  },
  PLAN_STEP_INVALID: {
    cause: 'not-approve',
    justification:
      "The step doors' refusal of a planner step it cannot record (MOTIR-7822) — a target on `settle` / `end`, a ref naming nothing on this plan or in its project, a bad session key. It records which step a session of a GENERATING plan is on; approve acts on a `planned` plan and records no step.",
  },
} as const;

/** The refusal ids the CLOSE must also raise — the card's invariant, as a set. */
export const PLAN_INTERNAL_REFUSAL_IDS: readonly string[] = Object.entries(APPROVE_REFUSALS)
  .filter(([, c]) => c.cause === 'plan-internal')
  .map(([id]) => id);
