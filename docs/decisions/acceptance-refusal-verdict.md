# An acceptance sent back moves no status, withdraws the merge, and is fixed with `motir fix`

**Status:** proposed · **MOTIR-6499** (the decision Story **MOTIR-6071** is built to, under
Epic MOTIR-6010)

**Supersedes:** in [`approval-gates.md`](approval-gates.md), §10h's two `acceptance_result`
rows (_STORY run_ and _SUBTASK runs, last one finished_), §10h's silence on the story's merge
gate, and §10f's _"the press opens the planning surface straight after the decision commits"_
for `acceptance_result` · in [`design-refusal-verdict.md`](design-refusal-verdict.md), the
last sentence of §2 and the acceptance bullet of _What this does NOT decide_ · MOTIR-6071's
prior approved body · this card's prior approved body, which sent a Re-run's story and its
not-done children to To do and continued the delivery through `motir run`.

**Consumed by:** MOTIR-6071 (the story) and its children · MOTIR-6500 (the design) ·
MOTIR-6501 (the verdict offered by run shape) · MOTIR-6502 (`motir fix` takes a Re-run) ·
MOTIR-6503 (the withdrawal and the merge hold) · MOTIR-6504 (the planner seed) ·
MOTIR-6505 (the user doc, and the pointer lines this record owes in `approval-gates.md`) ·
MOTIR-6506 (the refusal band) · MOTIR-6507 / MOTIR-6508 (the integration and E2E gates)

## Context

[`approval-gates.md`](approval-gates.md) §10 (MOTIR-6072) decided what follows a refusal, per
gate kind. For `acceptance_result`, §10h has two rows:

- **Story run:** **Re-run** sent the story and every not-`done` child to To do, because a
  story re-run's scope claim re-asserts the to-do category. **Re-plan** wrote no status and
  opened the planner on the press.
- **Subtask runs, last one finished:** no verdict. The planner opened on the press, always,
  to plan a remedy.

Four things have changed or been found missing since then.

1. **The requester changed the status rule** (Yue, 2026-09-26). On Re-plan: _"we just need to
   withdraw the gate and let the statuses be."_ On Re-run: _"the implemented and in review
   child items don't need to be sent back to to do, rerun is a fix — a color is wrong, css
   style overflow, the user is complaining about the implementation details mostly. if it's a
   big structure change, then replan takes care of the status change."_
2. **The requester named the Re-run mechanism:** _"motir fix should be used, not motir
   run."_ The shipped code agrees. `scopeClaimService.claimScope` claims a scope only when
   EVERY locked row is in the to-do category (step 5), so `motir run <story>` cannot claim a
   story that stays at `in_review`. `motir fix` claims a repair as a `fix` dispatch run and
   writes no status (`workItemRepairService`, `packages/cli/src/commands/fix.ts`).
3. **Every planner hand-off now ASKS first.** [`design-refusal-verdict.md`](design-refusal-verdict.md)
   §3 says the ask _"holds for every kind that offers the planner"_. §10h's _on the press_ is
   false for acceptance too.
4. **Nothing stops the refused code from merging.** On a story run the acceptance gate is the
   PRIMARY of two gates raised on the same green (§1's MOTIR-5903 amendment, point 1). A
   refusal leaves the paired `pull_request_approval` gate awaiting, and
   `pullRequestApprovalHandler.approve` holds the merge for a pending DESIGN or DECISION
   primary only (`designResultHoldsMerge`, `decisionHoldsMerge`). There is no acceptance hold.
   One press on the merge row merges exactly the code the reviewer sent back.

## Decision

### 1. The run shape is read from the gate being refused

An acceptance gate exists only under one of the two raise conditions of §1's MOTIR-5903
amendment. A refusal inherits the shape that raised it:

- **Story run:** the story has open pull requests of its own (its delivery set is non-empty).
  Its acceptance question was raised on the set's green, beside the merge question.
- **Finished story:** the story has no open delivery of its own, and every descendant is in
  the `done` category. Its acceptance question was raised once the subtree settled.

**The MOTIR-5903 not-owed state is untouched.** While a story run's set is not green, or a
subtask-run story's subtree is not settled, no acceptance gate exists, so there is nothing to
refuse. This record changes no raise condition.

### 2. No acceptance refusal writes a status

No run shape, verdict or source writes a status. The story and its children stay exactly
where they are. The handler returns no `statusWritten`, so `outcomeRef` is NULL on every
acceptance refusal, and `refusal_verdict` (§10d) is what tells a Re-run from a Re-plan.

### 3. On a story run, BOTH verdicts withdraw the merge, and it stays held

On a Motir-pressed story-run refusal, the reason is required (§10a) and so is a verdict:
**Re-run** (stored `revise`) or **Re-plan** (stored `re_plan`). The two verdicts make the
same write:

- **Withdraw.** In the decide door's transaction, the story's OTHER `awaiting` gates, the
  merge gate included, are superseded with cause `pulled_back`. The deciding gate is never
  superseded. This is the shipped `approvalGateRepository.supersedeOtherAwaitingByWorkItem`
  from [`design-refusal-verdict.md`](design-refusal-verdict.md) §2, called WITHOUT
  `returnCardToTodo`, because nothing moves. The children's gates are untouched.
- **Hold.** Withdrawing alone does not keep the merge withdrawn. A `superseded` merge gate
  does not count as a decided one in `resolveGateSet` (`alreadyDecided`). So the next
  reconcile at the same green set raises the merge question again, alone. The acceptance
  question is not re-raised, because it is already decided over that receipt. Reconciles
  happen after `ciPromotion`, after any withdrawal and in the pull-request reconcile sweep,
  and one happens whenever `motir fix` pushes and CI goes green. **So, while the story's
  latest acceptance decision over its CURRENT receipt is a `changes_requested`, the story's
  merge is not asked on its own, and no manual-mode merge path proceeds.** That covers the
  approve press and the GitHub review sync. It is the rule a sent-back design already
  follows (`designHoldsMerge`: _"A design sent back is not an open question … and it still
  must not merge"_).
- **Release.** A NEWER receipt releases the hold. When it is published, the next green asks
  the acceptance question and the merge question together again, as §1's MOTIR-5903
  amendment raises them. An approval of that receipt decides the merge as it always has.

The code's own approve-to-merge refusal (`pull_request_approval` _Request changes_) is
unchanged.

> **AMENDMENT (2026-11-08) — the mirror: a refused MERGE withdraws a story run's video.**
> On a story run the acceptance video is the merge gate's evidence and its press merges, so
> the two are one question about one set of commits. Requesting changes on the code — a
> person's _Request changes_ on the `pull_request_approval` gate through any door, a GitHub
> review synced into it, or the review agent's send-back (`approval-gates.md` §12.14) — now
> supersedes the story's `awaiting` `acceptance_result` gate in the same transaction: cause
> `pulled_back` for a person's or GitHub's refusal, `agent_changes_requested` for the
> agent's. The receipt is not stamped; nobody answered it. `resolveGateSet` does not ask the
> video again while the merge is refused at the set's CURRENT version (a `changes_requested`
> merge gate there, or a standing, undismissed agent send-back). A push moves the version and
> the next green asks both again, acceptance leading; a newer recording from `motir fix`
> rides that same ask. A SUBTASK-run story is untouched: its video is not the merge gate.

### 4. Re-run is a FIX, served by `motir fix <story>`

A Re-run means the reviewer is complaining about implementation details: a wrong colour, an
overflowing style. The work stays built.

- **The repair claim admits it.** `workItemRepairService`'s predicate admits a story whose
  latest decided acceptance gate is a Motir-pressed `changes_requested` carrying `revise`.
  This is in addition to its shipped admissions (red CI, a standing merge-queue failure, a
  conflict). The claim is a `fix` dispatch run. It locks without moving the card and without
  writing an assignee, like every repair.
- **The fix works on the open delivery.** `motir fix` checks out each open pull request's OWN
  branch, as it does today. It hands the agent the reviewer's reason (the latest refusal's
  `noteMd`), pushes to the same pull requests, watches CI, and then re-records and publishes
  the acceptance video. The new receipt raises a fresh acceptance gate on the next green,
  which releases §3's hold.
- **One predicate offers it.** The Development block offers `motir fix <story>` through the
  same repair predicate the claim reads, so the page never offers a command the claim would
  refuse.
- **Why not `motir run`.** Its scope claim takes only to-do-category rows (`claimScope` step
  5). Serving a Re-run through it would mean writing the story and its children back to To
  do. The requester rejected that: it tells the board the work never happened, and it treats
  a small correction as a restart.

### 5. Re-plan ASKS before the planner opens on the story

After a Re-plan is recorded, the decided band asks _Re-plan with Motir AI?_, as on a refused
decision or design ([`design-refusal-verdict.md`](design-refusal-verdict.md) §3).

- **Re-plan with AI** opens the planning surface on the STORY, seeded from the gate. The
  first turn is written and UNSENT. It quotes the reason and says no subtask is done, so all
  of them may be re-planned.
- **Not now** opens nothing. The decided record keeps a **Re-plan with AI** door (§10f).
- **The PLAN owns every status change.** A plan that names a card parks it at Planning, and
  approving a plan that re-scopes a card returns it to To do
  ([`agent-authored-plans.md`](agent-authored-plans.md) AMENDMENTS 16 and 21;
  `lib/plans/rescopeReset.ts`).

### 6. A finished story takes a reason only, and asks to plan a remedy

- **No verdict is offered**, and the door refuses one (`refusal_verdict_not_offered`, §10d).
  The band says why: nothing is left to re-run.
- **No status is written** and no gate is withdrawn. A finished story has no merge gate.
- **The band asks to plan a remedy.** Yes opens the planner on the STORY, with an unsent first
  turn that quotes the reason and asks for new work under the still-open story. Not now
  leaves the door on the record.

### 7. What never varies

- **A GitHub-sourced refusal** carries no verdict, moves nothing, withdraws nothing and offers
  no planner (§10h's third note). The review sync decides only `pull_request_approval`, so an
  acceptance gate is never refused from GitHub. The rule is stated so that no later kind
  widens it.
- **Every seeded turn is unsent** (§10f). Nothing is billed until the person sends it.

### 8. Why the acceptance verdicts differ from the design verdicts

A design verdict returns the design card to To do ([`design-refusal-verdict.md`](design-refusal-verdict.md)
§1). An acceptance verdict does not. The two gates sit at different points:

- **A design card has nothing built yet.** Sending it back makes it work to pick up again,
  and To do is where the claim doors find it.
- **A story run has built, reviewable work** at `implemented` or `in_review`. A Re-run
  changes some of that work, and `motir fix` changes it in place without a claim through the
  to-do category. A Re-plan changes the plan, and the plan already parks and returns the
  cards it names.

In both cases the refusal withdraws the work's other waiting approvals. Only the status
differs.

### 9. What each amended clause now reads

| clause                                                                                                       | what it said                                                                                                               | what it now reads                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **§10h**, `acceptance_result` · STORY run                                                                    | status: **Re-run** → the story and every not-`done` child → To do; **Re-plan** → none. Planner: Re-plan only, on the press | status: none on either verdict. Both withdraw the story's other awaiting gates as `pulled_back`, and the merge stays held until a newer receipt (§3). Re-run: `motir fix <story>` (§4). Planner: Re-plan only, **asked first**, anchored on the story (§5) |
| **§10h**, `acceptance_result` · SUBTASK runs, last one finished                                              | planner: **always**, on the press                                                                                          | planner: **asked first**, anchored on the story, seeded to plan a remedy (§6). Status: none, unchanged                                                                                                                                                     |
| **§10h**, the table as a whole                                                                               | silent on the story's merge gate                                                                                           | a story-run refusal withdraws and holds it (§3)                                                                                                                                                                                                            |
| **§10h**, fourth note                                                                                        | the dispatch prompt for the RETURNED card carries the reason                                                               | on an acceptance Re-run nothing is returned. The `motir fix` run is handed the reason (§4)                                                                                                                                                                 |
| **§10f**, first bullet, for `acceptance_result`                                                              | _"the press opens the planning surface straight after the decision commits"_                                               | after the decision commits, the band ASKS. The surface opens only on **Re-plan with AI**, as [`design-refusal-verdict.md`](design-refusal-verdict.md) already reads for design                                                                             |
| [`design-refusal-verdict.md`](design-refusal-verdict.md) §2, last sentence                                   | the same rule governs _"MOTIR-6071's acceptance Re-run"_                                                                   | the acceptance Re-run writes no status. It reuses the WITHDRAWAL only (§3), not the return to To do                                                                                                                                                        |
| [`design-refusal-verdict.md`](design-refusal-verdict.md), _What this does NOT decide_, the acceptance bullet | MOTIR-6071 _"reuses §1 and §2 of this record for its Re-run write"_                                                        | it reuses §2's withdrawal, and neither §1 nor `returnCardToTodo`                                                                                                                                                                                           |

This record rewrites none of these clauses in place. Each gets a one-line pointer to this
record, which MOTIR-6505 adds.

## Consequences

- **A refused story's code cannot merge until a newer video is approved.** This holds under
  either verdict, through any manual-mode door.
- **The board does not move on a refusal.** The story stays `implemented` or `in_review`.
  Nobody can claim it through `motir run`, and an open `fix` run is the lock while it is being
  fixed.
- **A Re-run nobody fixes stays held**, with the merge held and `motir fix` offered on the
  Development block. A Re-plan nobody plans stays held too, with the door on the record.
  Neither expires.
- **`returnToTodo.ts`'s header note** that MOTIR-6071 _"will reuse"_ `returnCardToTodo` is now
  false. MOTIR-6503 removes it.
- **The hosted automatic re-run stays Story 9.2's** (§10g, MOTIR-700). A Re-plan never
  dispatches anything.

## What this does NOT decide

- **The copy and layout** of the verdict pair, the no-re-run line, the `motir fix` offer, the
  asks and the doors. Those are MOTIR-6500's to draw.
- **How the hold is built**: a gate-set condition, a refusal at each merge path, or both.
  That is MOTIR-6503's. This record fixes only the behaviour: the merge is neither asked on
  its own nor performed while the story's latest acceptance over its current receipt is sent
  back, and a newer receipt releases it.
- **Whether a refused acceptance holds an `auto` project's merge.** `auto` raises no merge
  gate (§7a), and whether an unanswered acceptance holds an `auto` merge is left open by §1's
  MOTIR-5903 amendment, point 5. This record does not settle it.
- **What the planner proposes** once a seeded turn is sent. That belongs to the planning
  conversation, under the shipped rules.
- **When an acceptance question is raised** (§1's MOTIR-5903 amendment), and any change to
  §10a, §10b, §10e or §10g.
- **A story in the `done` category.** It is closed and cannot be sent back (MOTIR-5552).
