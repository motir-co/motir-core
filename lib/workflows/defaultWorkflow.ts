import type { StatusCategory } from '@/generated/prisma/client';
import { keyForAppend } from '@/lib/workItems/positioning';

// The v1 default per-project workflow (Story 2.2 · Subtask 2.2.2) — the typed
// constant `workflowsService.seedDefaultWorkflow` writes into every new
// project. Eight statuses spanning the full lifecycle, including a non-terminal
// `blocked` and a terminal `cancelled` (the two most common admin-added
// statuses in real Jira/Linear installs) so every project exercises the
// multi-terminal-status + non-linear-graph paths from day one — not only after
// admin customization.
//
// MOTIR-2425 added the seventh, `planning`. Read its note beside the row below
// before assuming it is decoration: its CATEGORY is what stops an unattended run
// re-dispatching a card whose plan is being reconsidered, and `blocked` cannot
// do that job.
//
// MOTIR-3003 added the eighth, `implemented`, for the same structural reason one
// rung further along the loop: an agent's process exiting 0 proves only that the
// process ended, so the card it just pushed must NOT claim a human should look at
// it until CI says the build is green. Its note beside the row below carries the
// reasoning, and where it sits in the order was decided by measurement — see
// `design/boards/design-notes.md` ("Implemented — the eighth board column").
//
// `position` is the SAME opaque fractional-index sort key `work_item.position`
// uses (finding #43): allocated here via `keyForAppend` (the Story-1.4 helper),
// NOT numeric literals. The statuses sort in declared order; a later reorder is
// a single-row write.

export interface DefaultStatusSpec {
  key: string;
  label: string;
  category: StatusCategory;
  isInitial: boolean;
  position: string;
}

// Declared in display order; `position` is filled below via the
// fractional-index helper so the order is encoded as sortable keys.
const STATUS_ORDER: ReadonlyArray<Omit<DefaultStatusSpec, 'position'>> = [
  { key: 'todo', label: 'To Do', category: 'todo', isInitial: true },
  // Non-terminal "can't proceed, full stop" — complements 1.4.3's
  // work_item_link.is_blocked_by (a link names a specific blocker; this status
  // captures "blocked" including external blockers).
  { key: 'blocked', label: 'Blocked', category: 'todo', isInitial: false },
  { key: 'in_progress', label: 'In Progress', category: 'in_progress', isInitial: false },
  // ⚠️ THE CATEGORY IS THE MECHANISM HERE TOO (MOTIR-3003), for the reason the
  // `planning` note below states in full: readiness is derived from the
  // `is_blocked_by` EDGES and never from the status, so what actually takes a
  // card out of the pickable set is its CATEGORY. A card whose pull request is
  // open and whose checks are still running must not be handed to the next run,
  // and `in_progress` is where it would stay if this status were anywhere else.
  //
  // It is also the honest word. Between "the agent stopped" and "a human should
  // look at this" there is a real state that Motir could not express: the branch
  // is pushed, the pull request is open, and NOTHING has been compiled, linted or
  // tested. In Review is a promise to a person; `implemented` is the fact.
  //
  // ⚠️ ORDER: immediately after `in_progress`, BEFORE `planning`, and that is a
  // MEASURED decision rather than a preference (`design/boards/implemented-column.mock.html`,
  // panel 1). A board column is 288px in a 16px-gap row beside a 240px rail, so
  // slot 4 is the last column a laptop shows in full (from 1512px; a 63–223px
  // sliver below that) and slot 5 is off-screen at every laptop width measured.
  // The path every card walks takes the visible slot; `planning` — an exceptional
  // off-ramp with its own review surface — takes the one after it.
  { key: 'implemented', label: 'Implemented', category: 'in_progress', isInitial: false },
  // ⚠️ THE CATEGORY IS THE MECHANISM (MOTIR-2425). When an agent finds a card it
  // cannot implement it submits a re-plan, and the card must stop being handed
  // out until a human has acted on that plan.
  //
  // `blocked` cannot express that. Readiness here is derived from the
  // `is_blocked_by` EDGES, never from the status, so `blocked` is a human
  // annotation with no structural consequence — a card can sit at `blocked` with
  // every blocker done and be perfectly ready, and one on this project currently
  // is (MOTIR-1762). Setting it and walking away is a status that lies and
  // changes nothing; the next run picks the card straight back up.
  //
  // `planning` sits in the **in_progress** category instead, and that is the
  // whole point: a run takes the TO DO category, so a card here leaves the
  // pickable set STRUCTURALLY. Nothing special-cases it and nothing has to
  // remember why. It is also the truthful word — the card is not blocked and not
  // abandoned, it is in progress on the planning axis rather than the
  // implementation one.
  { key: 'planning', label: 'Planning', category: 'in_progress', isInitial: false },
  // ⚠️ THE CATEGORY IS THE MECHANISM, A FOURTH TIME (MOTIR-12174). A card at
  // `to_plan` was planned and not finished, and its description is OUT OF DATE:
  // a decision it rests on was corrected after it was written. It must leave the
  // pickable set until it is re-planned, and it must not count as finished.
  //
  // The CATEGORY does both, not the key. Both claim doors (`claim_next_ready`,
  // `claim_work_item`) take only the `todo` category, so a card here is not
  // handed to a run; and only the `done` category is terminal
  // (`blockerReadiness.isOpenBlocker`), so its dependents stay blocked and no
  // count closes it. Nothing special-cases the key.
  //
  // It is NOT `blocked`, for the reason the `planning` note above gives in full:
  // readiness is computed from the `is_blocked_by` EDGES, and `blocked` sits in
  // the `todo` category, so a `blocked` card with no open blocker is claimable.
  // And it is NOT `planning`: nobody is re-planning it yet. A plan that names it
  // parks it at `planning` (`to_plan → planning`, below) and the decision on that
  // plan rests it.
  //
  // ⚠️ ORDER: slot 6, immediately after `planning`, which the design settles
  // (`design/boards/board--to-plan-status.mock.html`, panel 1). The two
  // re-planning states sit side by side, and the insert is AFTER `implemented`,
  // so the eighth column's slot-4 invariant survives.
  //
  // ⚠️ LABEL: a childless story or epic already draws a COMPUTED "To plan"
  // status-slot pill (`lib/workItems/statusSlot.ts`) that means something else.
  // The two never render on one card (`isToPlanItem` is false for an
  // `in_progress`-category status), and the glyph and fill tell them apart.
  { key: 'to_plan', label: 'To plan', category: 'in_progress', isInitial: false },
  { key: 'in_review', label: 'In Review', category: 'in_progress', isInitial: false },
  // ⚠️ THE CATEGORY IS THE MECHANISM, A THIRD TIME (MOTIR-5139), and here it is
  // the whole of the story rather than one of its consequences. A person's YES
  // is a state the product could not express: an approved card either sat at
  // `in_review`, which reads as NOBODY HAS LOOKED AT IT, or jumped to `done`,
  // which claims it merged. Both are false. GitHub models the same split — a
  // pull request is approved, and separately merged.
  //
  // `in_progress` is what makes "approved" mean "a person said yes and it has
  // NOT shipped", and it is load-bearing in three places that all read the
  // CATEGORY and never the key: an `approved` card stays OPEN in every count,
  // report, filter and board; `parentStatusRollupService` does not complete a
  // container out of it; and its dependents stay blocked, because
  // `lib/workItems/blockerReadiness.ts`'s `isOpenBlocker` asks whether the
  // blocker's status is in its project's `category = 'done'` set. Only `done`
  // and `cancelled` are terminal. Put this anywhere else and NOTHING ERRORS —
  // the board renders, the migration applies, the tests pass — while every
  // parent completes early, every open-items count under-reports, and every
  // dependent becomes claimable against work that has not shipped.
  //
  // ⚠️ ORDER: between `in_review` and `done`, which is the RECORD's decision
  // (`docs/decisions/approval-gates.md`, as amended by MOTIR-4911) and not a
  // preference. The fold consequence was re-measured rather than assumed
  // (`design/boards/approved-column.mock.html`, panel 1): at slot 7 the count of
  // fully-visible columns is unchanged at every viewport, `approved` is
  // off-screen exactly as `done` and `cancelled` already were, and the only cost
  // is one column of scroll. Crucially the insert is AFTER `implemented`, so the
  // eighth column's slot-4 invariant survives.
  //
  // ⚠️ VOCABULARY — `approved` is already a word in this repository, on FOUR
  // other entities: `ApprovalGateState.approved`, `AcceptanceEvidenceStatus
  // .approved`, `PlanStatus.approved` and the device-grant `approved`. None is
  // on `work_item.status`, so nothing collides. But the approval-gate code now
  // holds two `approved`s one hop apart, and they are NOT the same fact: the
  // GATE's is a DECISION a person recorded, this one is the card STATUS that
  // decision causes. A gate can be approved while the card is still `in_review`
  // — that is the ordinary state of a card whose pull request has not merged,
  // because the merge is the single writer of `done`.
  { key: 'approved', label: 'Approved', category: 'in_progress', isInitial: false },
  { key: 'done', label: 'Done', category: 'done', isInitial: false },
  // Terminal "won't do / duplicate / out-of-scope"; counted as resolved by
  // finding #21's readiness predicate via category = 'done'.
  { key: 'cancelled', label: 'Cancelled', category: 'done', isInitial: false },
];

export const DEFAULT_STATUSES: ReadonlyArray<DefaultStatusSpec> = (() => {
  let prev: string | null = null;
  return STATUS_ORDER.map((s) => {
    prev = keyForAppend(prev);
    return { ...s, position: prev };
  });
})();

/**
 * The keys of the ten default statuses (Subtask 2.2.10; derived from
 * `STATUS_ORDER`, so a status added there is protected without a second list). A status whose `key`
 * is in here is a PROTECTED default: it can be recolored but NOT renamed,
 * recategorized, reordered, or deleted (finding #49). Used by the service gates
 * and by the editor UI to render the "Default" badge + lock the affordances.
 */
export const DEFAULT_STATUS_KEYS: ReadonlySet<string> = new Set(STATUS_ORDER.map((s) => s.key));

// The default transition graph (restricted-mode), as [fromKey, toKey] pairs.
//
// NOTE ON COUNT (finding #45): the 2.2.2 card enumerated FIFTEEN distinct,
// individually-justified edges but its running total + the "13-transition"
// label undercounted by exactly the two Reopen edges (done→in_progress,
// cancelled→todo) — an arithmetic slip in the card. Every listed edge is
// justified in the card's prose (reopen explicitly: "cancellation is reversible
// …"), and dropping two justified edges to hit 13 has no basis. So the seed
// ships the full enumerated graph. (Decision-authority ladder: a
// self-contradicting card resolved to its substantive enumeration, not its
// mistaken tally.) Subtask 7.8.11 adds ONE more edge — `in_review → blocked`,
// so an item integrated-awaiting-review can stall on a blocker like any other
// active state — bringing the total to SIXTEEN. (The matching backfill
// migration adds this one edge to every EXISTING default-workflow project; the
// rest of the `in_review` graph already shipped in this constant from 2.2.2, so
// only this edge needs backfilling.) MOTIR-1625 adds the SEVENTEENTH —
// `in_progress → done` (see its comment on the forward path below), again with
// a matching backfill migration for existing default-workflow projects.
// MOTIR-2425 adds `planning` and FIVE more edges (two in, three out), bringing
// the total to TWENTY-TWO — with a backfill that adds the status, its edges and
// a board column to every existing default-workflow project. MOTIR-3003 adds
// `implemented` and SEVEN more (two in, five out), bringing the total to
// TWENTY-NINE — again with a backfill of the status, its edges and a board
// column. Each of the seven is justified beside it below; the tally is amended
// here rather than left stale, which is the convention this comment exists for.
// MOTIR-5139 adds `approved` and FOUR more (one in, three out), bringing the
// total to THIRTY-THREE — again with a backfill of the status, its edges and a
// board column.
//
// ⚠️ THREE of those four are the record's (`docs/decisions/approval-gates.md` as
// amended by MOTIR-4911); the FOURTH is this file's own convention, and it is
// flagged rather than smuggled. The record enumerates the LIFECYCLE path —
// `in_review → approved`, `approved → done`, `approved → in_progress` — and says
// nothing about cancellation, because that is not what it is about. This
// constant's convention IS about it: cancellation is legal from every
// non-terminal state, and all eight existing statuses follow it without
// exception. `approved` is non-terminal by construction, so `approved →
// cancelled` ships. If that omission was deliberate rather than incidental, the
// edge is one line to strike and the tally becomes 32.
//
// MOTIR-5630 adds THREE more with no new status — `approved → implemented`,
// `in_review → implemented` and `implemented → approved` — bringing the total to
// THIRTY-SIX, with a backfill of the edges alone
// (`20260916180000_add_queue_ejection_default_edges`). They are the merge-queue
// EJECTION's (`docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 7),
// and each is justified beside the `approved` block below.
//
// MOTIR-5804 REMOVES one of those three and ADDS one, so the total STAYS
// THIRTY-SIX (`docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT, point 6):
// `implemented → approved` leaves — an approval is only ever given from
// `in_review` — and `approved → in_review` joins, the move a `manual` project's
// FAILURE ejection now makes to put the merge question back to a person. The
// backfill is `20260919200000_reask_ejection_default_edges`.
//
// MOTIR-5643 adds FIVE more, again with no new status — `blocked → planning`,
// `implemented → planning`, `in_review → planning`, `approved → planning` and
// `planning → blocked` — bringing the total to FORTY-ONE, with a backfill of the
// edges alone (`20260920090000_add_planning_parking_edges`). They are the
// PLAN-TARGET STATUS contract's (`docs/decisions/agent-authored-plans.md`
// AMENDMENT 16, D10): every NON-terminal status may be parked while a plan
// rewrites the card, and a parked card may rest at `blocked` when the approved
// plan leaves it gated. `done` and `cancelled` get no edge in — a terminal card
// is not re-planned, and the park skips one itself rather than relying on
// `validateProposals`, whose `PlanTargetImmutableError` fires at the plan's
// CLOSE rather than at its append.
//
// ⚠️ THE TWO CARDS TOUCHED THIS TALLY IN PARALLEL, and MOTIR-5643 said so in
// advance: "whichever PR merges second rebases and sets the count to the sum."
// 5804 was net ZERO (one out, one in), so the sum is 36 + 5 = 41 — the same
// number either order, but a DIFFERENT edge set from the one MOTIR-5643 was
// first measured against.
//
// MOTIR-12174 adds `to_plan` and FIVE more edges (two in, three out), bringing
// the total to FORTY-SIX — with a backfill of the status, its edges and a board
// column (`20261124010000_add_to_plan_default_status`). Each is justified in the
// `to_plan` block at the end of this list, beside the three it deliberately
// leaves out.
//
// MOTIR-12202 adds TWO more with no new status — `todo → implemented` and
// `todo → in_review` — bringing the total to FORTY-EIGHT, with a backfill of the
// edges alone (`20261125000000_add_todo_delivery_default_edges`). They are the
// pull-request lifecycle's, for a card a pull request delivers while nobody moved
// it off To Do; each is justified in the `todo` block below the Implemented one.
export const DEFAULT_TRANSITIONS: ReadonlyArray<readonly [string, string]> = [
  // Forward main path
  ['todo', 'in_progress'],
  ['in_progress', 'in_review'],
  ['in_review', 'done'],
  // Review is OPTIONAL, not mandatory (MOTIR-1625). Both
  // `in_progress → in_review → done` and `in_progress → done` are legal, for two
  // reasons: (1) a project with no review gate should be able to finish work
  // without parking it in a review column it doesn't use (the Epic-9 configurable
  // review step); (2) the MOTIR-1615 upward rollup moves a parent to `done` once
  // every child is done — and that parent is usually `in_progress`, never
  // `in_review`, so without this edge the done rung would be an illegal move and
  // the rollup would log a no-op and strand the parent.
  ['in_progress', 'done'],
  // Block / unblock (block from any active state; unblock to either). `in_review`
  // can be blocked too (7.8.11) — review can stall on an external dependency.
  ['todo', 'blocked'],
  ['in_progress', 'blocked'],
  ['in_review', 'blocked'],
  ['blocked', 'todo'],
  ['blocked', 'in_progress'],
  // Backward / rework
  ['in_review', 'in_progress'],
  ['in_progress', 'todo'],
  // Reopen (a closed/cancelled item can come back)
  ['done', 'in_progress'],
  ['cancelled', 'todo'],
  // Cancellation (any non-terminal state can cancel)
  ['todo', 'cancelled'],
  ['in_progress', 'cancelled'],
  ['in_review', 'cancelled'],
  ['blocked', 'cancelled'],
  // ── Re-planning (MOTIR-2425) ───────────────────────────────────────────────
  // IN from EVERY non-terminal status (MOTIR-5643). Two of these are the
  // original pair: `in_progress` is the agent's path — it claims a card, starts
  // work, discovers the card is not implementable, and submits a re-plan — and
  // `todo` is the human's, noticing before anyone starts.
  //
  // ⚠️ THE OTHER FOUR SUPERSEDE THIS BLOCK'S FORMER "NOT from `in_review`" RULE
  // (`docs/decisions/agent-authored-plans.md` AMENDMENT 16, D2 and D10; product
  // owner, 2026-09-16: "all the statuses can be changed to planning … done and
  // cancelled should be excluded"). That rule reasoned from ONE user story — a
  // person noticing a card was wrong — for which routing through
  // `in_review → in_progress` really was enough. What it did not cover is the
  // PRODUCT parking a target on its own: a plan now parks every committed card
  // it names, whatever status that card is in, so a `blocked`, `implemented`,
  // `in_review` or `approved` card has to be reachable. Without these four, the
  // one path is not an inconvenience — a plan simply cannot hold those cards.
  //
  // ⚠️ AND NOTHING FROM `done` OR `cancelled`, deliberately (D2). We plan
  // forward: a terminal card is superseded by a new one, never re-planned in
  // place. The absence here is one of TWO guards, not the only one —
  // `planTargetLockService.acquireForPlanWithin` skips a terminal target
  // outright, because `validateProposals`' `PlanTargetImmutableError` fires at
  // the plan's CLOSE rather than at its append (MOTIR-5645).
  //
  // The park itself is a `{ system: true }` write and would not be refused
  // either way. These are declared so a PERSON can make the same move, and so a
  // `restricted` policy does not silently downgrade the product's own write to
  // the second-class `plan_reset` arm MOTIR-5359 had to invent.
  ['todo', 'planning'],
  ['in_progress', 'planning'],
  ['blocked', 'planning'],
  ['implemented', 'planning'],
  ['in_review', 'planning'],
  ['approved', 'planning'],
  // OUT — three, for the moves a PERSON may make:
  //   • `todo`        — the card belongs back in the queue.
  //   • `in_progress` — the human decided to just do it.
  //   • `cancelled`   — the plan replaces it.
  //
  // ⚠️ THE DECISION ON THE PLAN IS WHAT RETURNS THE CARD — superseding this
  // block's former rule that "a HUMAN moves it, and plan approval deliberately
  // does NOT" (bug MOTIR-5640, product owner 2026-09-16;
  // `docs/decisions/agent-authored-plans.md` AMENDMENT 16, D6–D8). Approving the
  // plan rests each parked target at `blocked` when a live `blocked_by` is still
  // open and at `todo` otherwise; declining it, or a close that materializes
  // nothing, restores the status it was parked from.
  //
  // The superseded rule's warrant was the re-dispatch LOOP — an unchanged,
  // still-wrong card going straight back into the pickable set. AMENDMENT 16 D7
  // answers it per plan SHAPE rather than by refusing to move: a `remove`d
  // target is archived and takes no status, a target that gains a blocker rests
  // at `blocked`, and for every other shape the approval IS the correction, so
  // what a run next claims is the card the plan rewrote. MOTIR-5359's
  // re-scope-only reset is folded into that one predicate.
  //
  // ⚠️ AND A FOURTH OUT, `planning → blocked` (MOTIR-5643, AMENDMENT 16 D6 and
  // D10). It is the resting status half of the contract: approving a plan puts
  // each parked target at `blocked` when one of its live `blocked_by` edges is
  // still open, and at `todo` otherwise. Without this edge the approve could
  // write only one of its two answers.
  //
  // It is also why `blocked` is the ONE downward move §6d keeps an approval
  // gate's question through (`withdrawsPendingQuestion`,
  // `lib/workItems/statusLadder.ts`): blocking pauses the work, it does not
  // abandon it.
  ['planning', 'todo'],
  ['planning', 'in_progress'],
  ['planning', 'cancelled'],
  ['planning', 'blocked'],
  // ── Implemented (MOTIR-3003) ───────────────────────────────────────────────
  // IN, two:
  //   • `in_progress → implemented` — the forward path a run takes when its agent
  //     finishes and its pull request is open.
  //   • `blocked → implemented`     — the inverse of the block edge below, so a
  //     card that stalled while its checks were pending can come back.
  ['in_progress', 'implemented'],
  ['blocked', 'implemented'],
  // OUT, five:
  //   • `implemented → in_review`   — what CI GREEN does, server-side, from the
  //     shared CI-feedback consumer. This is the edge the whole story is for.
  //   • `implemented → in_progress` — rework: the reviewer or the author reopens
  //     it (a red build, or a change of mind before review starts).
  //   • `implemented → blocked`     — an open pull request can still stall on
  //     something external, exactly as `in_review` can (7.8.11's reasoning).
  //   • `implemented → cancelled`   — cancellation is legal from any
  //     non-terminal state; this one is no different.
  //   • `implemented → done`        — a project with no review gate closes
  //     straight from here, the same latitude MOTIR-1625 gave `in_progress`, and
  //     for the same second reason: the MOTIR-1615 rollup moves a parent to
  //     `done` from wherever it is, and without this edge a parent sitting at
  //     `implemented` would strand.
  ['implemented', 'in_review'],
  ['implemented', 'in_progress'],
  ['implemented', 'blocked'],
  ['implemented', 'cancelled'],
  ['implemented', 'done'],
  // ── A pull request delivering a To Do card (MOTIR-12202) ───────────────────
  // One pull request often delivers more than one card, and a run does not always
  // claim every card it delivers first — so a card can be LINKED to an open pull
  // request while it still reads To Do. Before these two edges the link-time sync's
  // `→ implemented` and the CI-green latch's `→ in_review` were both refused as
  // undeclared hops, silently, and the merge's `→ done` was refused the same way:
  // the card stayed To Do after its code shipped (MOTIR-12189).
  //   • `todo → implemented` — linking (or opening) an open, non-draft pull request
  //     on a To Do card records the fact the same way it does from In Progress.
  //   • `todo → in_review`   — the CI-green latch, when the pull request's whole set
  //     is ALREADY green at the link (or turns green before anything else moved the
  //     card): it goes straight to review, as an In Progress card does since
  //     MOTIR-12094, and the approve-to-merge question is raised with it.
  // The merge then completes it through `implemented → done` / `in_review → done`,
  // so no `todo → done` is declared. `blocked` keeps its exclusion
  // (`HELD_BELOW_IMPLEMENTED`, MOTIR-12094): a person's block is never lifted by a
  // pull request, and `blocked → in_review` stays undeclared.
  ['todo', 'implemented'],
  ['todo', 'in_review'],

  // `approved` (MOTIR-5139) — a person's YES, between CI's verdict and the
  // merge. ONE edge in and THREE out — plus the ejection's TWO more out
  // (MOTIR-5630 · MOTIR-5804), at the end of this list.
  //
  // ⚠️ `implemented → approved` IS deliberately ABSENT (MOTIR-5139): an
  // undeclared hop is a 422 under the `restricted` policy, and this is the one
  // that would let a person approve past a build that never ran. MOTIR-5630
  // declared it for _Queue again_ reusing an ejected card's decided approval;
  // the FOURTH AMENDMENT (MOTIR-5804) REMOVED it again, because an approval is
  // only ever given from `in_review` — a failure ejection now asks the person
  // again there (`approved → in_review`, below) rather than reusing the old yes.
  // §6d rule 2b in `applyStatusTransition` still refuses a hand move into
  // `approved` while an open pull request delivers the card.
  // `tests/workflows/approved-status.test.ts` asserts both halves.
  ['in_review', 'approved'],
  // The merge lands. This is the edge, not the writer: `changeRequestStatusSync`
  // resolves a status by CATEGORY on merge, and `approved` is `in_progress`, so
  // a merge still targets `done` and this hop is what makes it legal.
  ['approved', 'done'],
  // Work pulled back after approval — a review that changed its mind, a defect
  // found before the merge. Without it an approved card has no way back and the
  // only exit is `done`, which would make approval irreversible.
  ['approved', 'in_progress'],
  // The FOURTH edge, and the one the record does not enumerate — see the
  // convention note in this constant's header. Cancellation is legal from every
  // non-terminal state; `approved` is non-terminal.
  ['approved', 'cancelled'],
  // ── The merge-queue EJECTION (MOTIR-5630 · MOTIR-5804) ─────────────────────
  // `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 7, as the
  // FOURTH AMENDMENT's point 6 amends it. The ejection's own write is a system
  // write, which skips the edge check; the edges are declared anyway so the
  // workflow editor shows the real lifecycle and a person can make the same move
  // by hand.
  //   • `approved → in_review`    — a `manual` project's card the queue ejected
  //     for a FAILURE after a person approved it: the merge question is asked
  //     again, on ONE fresh gate, and In Review is where a fresh yes comes from.
  //   • `in_review → implemented` — an `auto` project's card, which never
  //     reaches `approved` because no person decides it; a failure sends it back
  //     to committed code whose build (the queue's merge commit) has not passed.
  //   • `approved → implemented`  — kept as a legal HAND move; no system writer
  //     since the FOURTH AMENDMENT.
  // `implemented → approved` is NOT here — see the note at the top of the
  // `approved` block.
  ['approved', 'in_review'],
  ['approved', 'implemented'],
  ['in_review', 'implemented'],
  // ── To plan (MOTIR-12174) ──────────────────────────────────────────────────
  // IN, two — the moves the MARK makes when a corrected decision makes the
  // work planned against it stale. It moves only NOT-STARTED work, so the only
  // sources are the two `todo`-category statuses:
  //   • `todo → to_plan`
  //   • `blocked → to_plan`
  ['todo', 'to_plan'],
  ['blocked', 'to_plan'],
  // OUT, three:
  //   • `to_plan → planning`  — a plan that names the card PARKS it.
  //     `planTargetLockService.acquireOne` parks a target exactly when
  //     `canTransition(status → planning)` holds, so this one edge is all the
  //     park needs. Approving the plan then rests the card through the existing
  //     `planning → todo` / `planning → blocked`; DECLINING it restores
  //     `to_plan` by a system write (`releaseOne`), which skips the edge check,
  //     so there is no `planning → to_plan` edge.
  //   • `to_plan → todo`      — a person decides the card is fine as written.
  //   • `to_plan → cancelled` — cancellation is legal from every non-terminal
  //     state, this constant's convention.
  //
  // ⚠️ DELIBERATELY ABSENT, three: `to_plan → blocked`, `to_plan → in_progress`
  // and `to_plan → done`. A stale card goes back to the queue through `todo`
  // (readiness is computed from edges, so `todo` and `blocked` read the same to
  // a run), and it must not be STARTED or CLOSED without being re-planned. The
  // absence also keeps the upward rollup, which walks real edges, from pulling a
  // `to_plan` parent forward to In Progress.
  ['to_plan', 'planning'],
  ['to_plan', 'todo'],
  ['to_plan', 'cancelled'],
];
