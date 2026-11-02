# ADR: The approval gate — one way of saying yes, whatever is being decided

- **Status:** Accepted (2026-09-08, drafted for Subtask MOTIR-4786 per the
  decision-subtask ladder). This is the rung-1 policy the rest of Story
  MOTIR-4778 implements — no schema, service, route or surface ships until these
  seven decisions are pinned. **No application behaviour ships in this subtask**
  (the ADR only, plus the one-line pointer §5 owes `design-result.md` §7).
- **Story / Subtask:** MOTIR-4778 (The approval GATE — a contract, a record, one
  shared control, and the DESIGN gate as its first and only kind) · Subtask
  MOTIR-4786. Epic MOTIR-4878.
- **Consumed by:** MOTIR-4788 (the `ApprovalGate` record), MOTIR-4789 (the
  design of the shared control), MOTIR-4790 (the decide door and its registry),
  MOTIR-4792 (the control itself), MOTIR-4795 (the author-facing
  documentation) — and, in sibling stories, MOTIR-4879 (the Approvals tab),
  MOTIR-4880 (`prMergeMode`), MOTIR-4882 (the merge gate).
- **Builds on:** `acceptance-receipt-lifecycle.md` (the freeze this deliberately
  does NOT copy — §6c), `design-result.md` (§4's supersede/retention, the
  premise §6 amends, and §7, the deferral §5 discharges),
  `unlinked-pull-request-check.md` (both GitHub Apps' declared permissions),
  `token-permissions.md` (the grant a new key joins).
- **Who decided what:** Q2 and Q6 were answered by **Yue on 2026-09-08** and are
  marked **DECIDED BY THE REQUESTER** below. Q1, Q3, Q4, Q5 and Q7 were resolved
  from the decision-authority ladder and are marked **DECIDED BY THE PLANNER**;
  each states the rung it was decided on.
- **Supersedes / superseded by:** none. It is the authority for what an approval
  gate IS and for the gate LIFECYCLE. `design-result.md` remains the authority
  for the design artefact itself; `acceptance-receipt-lifecycle.md` remains the
  authority for the acceptance receipt, which this record does not re-home.
- **AMENDED 2026-09-08 (MOTIR-4911), by Yue, at six clauses.** The record was
  accepted the same day and is right about most things; the amendments below
  correct what the model settled afterwards. **Every one keeps its struck text**,
  so a reader arriving from an old citation lands on the correction rather than
  on nothing. **No behaviour ships in the amendment either** — the ADR only, plus
  the one-line pointer §6c owes `design-result.md` §7.

  | clause                    | what changed                                                                                                                                                                                                                    |
  | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | **§1** (INCOMPLETE)       | `decision_approval` joins the enum, and the SUBJECT is re-stated as _a document with a resolver_ rather than a concrete row                                                                                                     |
  | **§2** (WRONG)            | AUTHORITY is **assignee OR reporter OR admin** for both verbs, not two permission keys. ROUTING is unchanged. **⚠️ The reporter arm was itself narrowed on 2026-09-11 — see §2's SECOND amendment, which is the rule in force** |
  | **§3** (WRONG)            | approving writes `done` **only when there is no linked open pull request**; otherwise it writes `approved` and the merge closes                                                                                                 |
  | **§4** (partly falsified) | the merge gate DOES write a status — `approved` — and still does not write `done`                                                                                                                                               |
  | **§6b** (incomplete)      | the `approved` WORK-ITEM status, and `decisionSource: github` with the unmappable-actor rule                                                                                                                                    |
  | **§6c** (FAILS SILENTLY)  | the pin is keyed on the **SUBJECT**, not on the gate kind                                                                                                                                                                       |
  | **§8 · §9** (new)         | THE TWO WORKFLOWS, and HOW TO TEST as a first-class deliverable                                                                                                                                                                 |

  **§8 is the one to read first.** It is the discriminator the other five
  amendments are consequences of.

- **AMENDED 2026-09-13 (MOTIR-5174), at §7, additively.** The rule for when the
  provenance default is written, what a MIXED or EMPTY project seeds, and the
  three-release retirement of `Workspace.subtaskPrMergeMode`. §7's own text and
  value table are unchanged.

- **AMENDED 2026-09-15 (MOTIR-5479), at §8 row 4a, and additively after §8's
  Workflow B.** The approve-and-merge gate's contract: where it hangs, what it
  is about, when it is raised and withdrawn, how _Approve and merge_ is recorded,
  and who may press. Row 4a's _"ONE transaction"_ is struck and replaced;
  nothing else in §8 changes.

- **AMENDED 2026-09-19 (MOTIR-5800), at §4 and §8, by Yue.** §4's FOURTH
  AMENDMENT: **one approval authorizes ONE merge or enqueue action.** Every
  un-landed outcome — a queue exit of any disposition, or a host refusal at the
  press — is CLASSED by reason: retryable and setting-blocked re-ask at
  `in_review` with ONE fresh gate, a conflict drops to `implemented` with the
  promotion held, and _Retry merge_ / _Queue again_ on the pull request's row
  DECIDE that fresh gate rather than reusing the spent approval. The host's
  refusal is recorded on the pull request, and `implemented → approved` leaves the
  workflow. It supersedes the THIRD's decisions 5–7 and §8's point 5(e), each
  struck in place and still readable.

- **AMENDED 2026-09-19 (MOTIR-5672), at §1, §8 and _Deliberately NOT decided
  here_ — THE DECISION GATE.** A `coding_agent` decision card's subject is the
  `docs/decisions/*.md` file in its MANDATORY pull request; the gate is PRIMARY
  over the merge like the design gate, and one press accepts it and merges.
  §1's _"a decision with no pull request"_ cell and §8 Workflow A's
  `decision_approval` are struck in place, §1's handler table gains its third
  column, and the rest is **§8's FIFTH AMENDMENT**, after the FOURTH.

- **AMENDED 2026-09-19 (MOTIR-5787), at §1, additively.** A fourth kind,
  `acceptance_result`: it hangs on the STORY whatever the run target; on a story
  run it is the PRIMARY of two gates whose one press also merges the story's code
  (never a pull request for the video, which is never committed); and approval
  writes `done` only when nothing under the story is left for the cascade to
  close. Nothing else in §1 changes.

- **AMENDED 2026-09-21 (MOTIR-5903), at §1 — WHEN the acceptance question is
  asked.** The MOTIR-5787 amendment made it a free-standing question raised the
  moment a receipt exists (_"it does not depend on pull requests, on CI, or on the
  run target"_). The requester replaced that: _"acceptance video gate is story
  gate"_. On a story run it is asked only once the story's set is green, beside
  the merge question it leads; on a subtask run only once nothing under the story
  is open. Points 3–5 of the MOTIR-5787 amendment are struck in place.

- **AMENDED 2026-09-21 (MOTIR-5887), at §1, §8 and _Deliberately NOT decided
  here_ — the `decision_choice` kind is REGISTERED.** It was named and keyed on
  `type: decision` + `executor: human`; the taxonomy ADR's Amendment 3 admits a
  `choice` type for exactly that act, so the kind is re-keyed on `type: choice`
  in all three places that named it, and §1 gains its handler row: the subject
  is a parsed section of the work item's own body, the verbs are the options
  plus one refusal, the effect is terminal (Workflow A), and the record stamps
  the chosen option.

- **AMENDED 2026-09-21 (MOTIR-5952, for Story MOTIR-5871), at §1, §8 and
  _Deliberately NOT decided here_ — the `decision_confirmation` kind is
  REGISTERED.** A `type: decision` work item with `executor: human` — a decision
  the planner already made WITH the person, written down so they can accept it —
  raised no gate at all. §1 gains a sixth kind, keyed on exactly that pair: its
  subject is the work item's own body, parsed into four sections; its verbs are
  **Confirm** and **Overturn**, and Overturn is a refusal with its own state
  rather than `request_changes`; both effects are terminal (Workflow A); the
  written record is OPTIONAL and, until pages ship, a markdown ATTACHMENT; and
  two decisions on one epic ACCUMULATE rather than supersede.

- **AMENDED 2026-09-23 (MOTIR-6072, for Story MOTIR-6067) — §10, NEW: A
  REFUSAL SAYS WHY, and what FOLLOWS a refusal, per kind.** Every refusal a
  person presses now carries a REQUIRED reason (`request_changes_needs_a_note`);
  a GitHub-sourced one carries the review body or says it had none. §10's table
  decides, per kind, the verdict offered at the press, the status a refusal
  writes (a return to To do is a gate-owned SYSTEM write), and where the planner
  opens. It changes the meaning of §1's _what `request_changes` DOES_ row, §3's
  _Request changes … moves nothing_ and §5's line against 9.2; each carries a
  pointer. It strikes nothing.

- **AMENDED 2026-09-27 (MOTIR-6591, for Story MOTIR-6587), at §4 — a merge-queue
  FAILURE is CAN'T LAND.** §4's FIFTH AMENDMENT moves the queue reasons
  `CI_FAILURE`, `CI_TIMEOUT`, `INVALID_MERGE_COMMIT` and `GIT_TREE_INVALID` from
  retryable to can't-land: the card drops to `implemented` held at that head, no
  gate is raised, `motir fix` repairs it, and only a new green head raises the next
  gate. Neutral removals, setting outcomes and `auto` mode are unchanged. The
  FOURTH AMENDMENT's affected sentences carry superseded notes; none is struck.

- **AMENDED 2026-09-28 (MOTIR-6844, for Story MOTIR-6843), at §4 — a queue exit
  whose check HUNG re-asks.** §4's SIXTH AMENDMENT narrows the FIFTH for
  `CI_FAILURE` and `CI_TIMEOUT`: when the check the queue recorded as failing
  concluded `cancelled` or `timed_out`, nothing failed in the code, so the exit is
  `neutral` and `retryable` and the card goes back to `in_review` with ONE gate.
  The check's raw conclusion is recorded, and one that arrives after the exit (by
  webhook, or read by the reconcile tick) re-settles a still-standing exit. The
  FIFTH AMENDMENT's affected sentences carry narrowed notes; none is struck.

- **AMENDED 2026-09-29 (MOTIR-6815, for Story MOTIR-1626 · 9.8) — §12, NEW: the
  AGENT-REVIEW kind.** With `Project.reviewAgentEnabled` on, a green delivery
  set raises `agent_review` on the run target INSTEAD OF the approve-and-merge
  gate; a hosted review run decides it
  under the new `review_agent` authority, or the routed person continues without
  it on the record. A pass raises the ordinary flow at the same version; a
  refusal moves no status and makes the card To fix, repaired by `motir fix`;
  nothing re-runs by itself; one review per version; a review that cannot run
  holds the card with its reason. §12.4b (the requester, same day) lets a person
  repair a card a review sent back on the HOSTED agent. §12.7 also corrects the To-fix repair of a
  person's _Request changes_ from `run` to `fix`. §1, §4, §7, §7a, §8 (the
  MOTIR-5479 amendment's decision 3) and §10h each carry a pointer; nothing is
  struck. **Consumed by** MOTIR-6816 – MOTIR-6827 and MOTIR-6904.
  **Revised the same day by the requester** (Yue, on MOTIR-6816's design gate):
  _"Review agent on and Merge automatically can't be true at the same time."_
  The review agent exists only in a project that asks before merging, and the
  two settings refuse each other (§12.2a). The first draft's `auto` branch is
  struck in §12.2, §12.4 and §12.5.

- **AMENDED 2026-09-29 (MOTIR-6903), at §4 — a re-queue made OUTSIDE Motir.**
  §4's SEVENTH AMENDMENT handles GitHub's `enqueued` delivery: an exit still
  standing at the head it names is stamped re-queued, so the card's red, the
  promotion hold and `motir fix`'s claim lift. It moves no status and decides no
  gate; the merge moves the card. Nothing earlier is struck.

- **AMENDED 2026-09-30 (MOTIR-6971), at §8 — the merge question is asked ONLY at
  `in_review`.** §8's EIGHTH AMENDMENT (Yue, 2026-09-29): the approve-to-merge
  gate exists if and only if CI is all green AND the card is In Review. Green CI
  alone is not a finished run, so a card the run left at `in_progress` is asked
  nothing; leaving review — `blocked` and system writes included — withdraws the
  question as `pulled_back`, and an `approved` card whose commits moved is asked
  again at `in_review`. It reverses MOTIR-5652's parent-run case and narrows §6d's
  rule 6 for the merge question; both carry a note. Nothing is struck.

- **AMENDED 2026-10-03 (MOTIR-7427, for Story MOTIR-5761), at §1 and §8 — a
  decision may be a PAGE.** §8's NINTH AMENDMENT: `publish_decision_page` seals a
  page's latest version, records the publication and raises `decision_approval`
  about that version; Approve FREEZES it and writes `done`, because no pull
  request will ever merge. A card with a published page takes the page as its
  subject; a card with none keeps the FIFTH AMENDMENT's file in a pull request,
  unchanged. A `decision_confirmation` card's record may be a page too, frozen at
  Confirm (§1's MOTIR-5952 amendment, point 8). The FIFTH AMENDMENT's clauses 2,
  8 and 9 and point 8's interim sentence carry pointers; the one struck sentence
  is point 8's _interim home_. `pages.md` AMENDMENT 3 defines the SEALED and
  FROZEN marks.

- **AMENDED 2026-10-09 (MOTIR-7911, for Story MOTIR-7905, decided by MOTIR-7906), at §1
  and _Deliberately NOT decided here_ — a `planning-session` gate kind is
  RECORDED.** A hosted planning session that needs its person — the planner
  stopped with a WHAT question, or the conversation is waiting on the person's
  next turn and they left — raises one gate whose subject is the SESSION, routed to
  the session's owner, listed in Waiting on you and cleared by the person's next
  turn or the session's end. §1's MOTIR-7906 amendment states it; additive, nothing
  struck. A plan awaiting approval stays on `plan_approval` (§11).

- **AMENDED 2026-10-10 (MOTIR-7937, for Story MOTIR-7905, decided by MOTIR-7906), at
  _Deliberately NOT decided here_ — a failure beside a waiting plan is NOT a gate.** A
  session whose later run failed beside a `planned` / `stale` plan lists in To resume; it
  raises no `planning-session` gate, and the waiting plan's own gate stays `plan_approval`.
  Additive, nothing struck. `agent-authored-plans.md` AMENDMENT 23's 2026-10-10
  sub-amendment is its other half.

- **CLOSED OUT 2026-09-10 (MOTIR-4795).** Everything Story MOTIR-4778 ships has
  landed, and **_What SHIPPED — the dated close-out_** below records the three
  places the implementation diverged from this record, plus what has NOT shipped
  so this record's silence is not read as delivery. **Read it before building
  against any section here:** §1's registry shape, §8's Workflow B status write
  and §6a's routing field each say something the code deliberately does
  differently.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `acceptance-video.md` / `design-result.md` /
> `acceptance-receipt-lifecycle.md`): a decision record is a markdown file under
> `docs/decisions/`, structured **Status → Context → Decision → Consequences**,
> with the load-bearing facts pinned in explicit tables so downstream code has
> one authoritative source to implement against.

---

## Context

**Motir's promise is that an agent takes the work over end to end. It does not,
and the gap has a precise shape:** the agent produces something, and then a
person has to leave the product to say yes to it. They open GitHub to merge.
They look at a design in a panel that deliberately has no buttons. Motir finds
out afterwards, from a webhook. The tracker is a spectator at the two moments
that decide whether work ships.

### Shipped substrate this reconciles against (verified 2026-09-07/08 on `origin/main`)

| fact                                                                                                                                                                                                                                       | where                                                                          | why it matters here                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nothing delivers an approval gate.** `git grep -E 'model ApprovalGate\|approval_gate\|ApprovalGateKind' -- 'prisma/*'` and `git ls-tree -r --name-only \| grep -iE 'approvalGate'` both return nothing                                   | —                                                                              | this record is not re-deciding an existing mechanism. (A case-insensitive grep for _"approval gate"_ returns 23 hits and is the WRONG predicate — it matches prose and Story 9.2's unbuilt `Project.designApprovalGate`.) |
| **One approval language already ships, once** — Approve / Request changes over `pending \| approved \| changes_requested`, with `approvedById` and `approvedAt`                                                                            | `AcceptancePanel.tsx`, `acceptanceActions.ts`, `lib/dto/acceptanceEvidence.ts` | §1 generalises this vocabulary rather than inventing a second one                                                                                                                                                         |
| **…and it asserts NO decide permission of its own** — `acceptanceEvidenceService.decide` gates only through `workItemsService.updateStatus` → `assertCanEdit` → `work_item:edit`, which `member` holds                                     | `lib/services/acceptanceEvidenceService.ts`                                    | §2's authority decision either inherits this or improves on it deliberately. It improves on it, and says why                                                                                                              |
| **Design approval does not exist**, and the panel's own header says so                                                                                                                                                                     | `DesignResultPanel.tsx`; `design-result.md` §7                                 | §5 discharges that deferral                                                                                                                                                                                               |
| **No merge call exists anywhere** — `git grep -E "pulls/[^\"']*/merge\|merge_method\|mergeChangeRequest"` over `lib/**` and `app/**` returns nothing; and `GitProvider` declares no merge method                                           | `lib/git/provider.ts`                                                          | §4 is a new capability on an existing seam, not a call to add inline                                                                                                                                                      |
| **`motir-integration` (App 4206669) holds `contents: read`**, read back from `gh api /apps/motir-integration` on 2026-09-07 — matching `unlinked-pull-request-check.md`'s table exactly                                                    | GitHub's own API                                                               | §4's permission bump is genuinely owed (MOTIR-4787)                                                                                                                                                                       |
| **`motir-studio` (App 4445390) already holds `contents: write`**, but "is not a fallback: it is installed only on `motir-projects` … and is never installed where a user's repositories are"                                               | `unlinked-pull-request-check.md`                                               | §4 selects the App by repository PROVENANCE                                                                                                                                                                               |
| **`Workspace.subtaskPrMergeMode` has had no functional reader since MOTIR-30** — eight `git grep` hits, all schema / DTO / mapper / one test assertion / two prose comments / the frozen plan-seed snapshot; nothing branches on its value | `prisma/schema.prisma:1042`                                                    | §7 renames and re-tiers it while that is still free                                                                                                                                                                       |
| **A superseded design's blobs are RECLAIMED** — supersede unlinks the prior row's attachments and the orphan-GC sweeps them after a **7-day** window; `lib/dto/designEvidence.ts` documents `url` / `mimeType` / `sizeBytes` going null    | `designEvidenceService.ts`, `attachmentGc.ts`                                  | §6c's pin exists because of this                                                                                                                                                                                          |
| **`withdrawCurrentForWorkItem` already makes a row non-current WITHOUT unlinking** — "the row survives, its `design_asset` rows survive, and their `Attachment` rows are NOT unlinked — unlike a supersede"                                | `designEvidenceService.ts`                                                     | §6c is a predicate on an existing branch, not new machinery                                                                                                                                                               |
| **`Done → In Progress` is a declared workflow transition** (`cmqfb4dau000v2d0iki17vp82`)                                                                                                                                                   | the project's workflow                                                         | §6d's reopen path needs nothing built                                                                                                                                                                                     |
| **`boardsService.moveCard` routes through `workItemsService.applyStatusTransition`**                                                                                                                                                       | `lib/services/boardsService.ts`                                                | the status guard (a sibling story) has one funnel, not four                                                                                                                                                               |

### The precedent that shaped §6c, stated because it is the same bug one domain over

`lib/acceptanceEvidence/errors.ts` records what happened when an approval gate
met a supersede path with no status predicate (MOTIR-2764):

> _"`markSupersededByWorkItem` carries no status predicate, so before this error
> existed ANY publish flipped the approved row `isCurrent: false`, unlinked its
> attachments, and left the orphan-GC to reclaim **the very bytes the approval
> was given on** — triggered by something as small as a one-line fix to an
> `acceptance_.spec.ts`."\*

**The design supersede path still has no such predicate.** The design gate is
what will make it bite. §6c is the fix, and it is deliberately NOT the fix
acceptance took.

---

## Decision

### 1. What a gate IS, and how a kind registers — DECIDED BY THE PLANNER (rung 2: the shipped acceptance vocabulary)

An **approval gate** is a row with:

| field          | meaning                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| **subject**    | what is being decided — a `DesignEvidence` id, a pull-request delivery id                               |
| **kind**       | which vocabulary of verbs applies. A Prisma **enum**, not free text                                     |
| **state**      | where the decision stands (§6b)                                                                         |
| **the record** | who decided it, when, under which permission, through which surface, what it caused, and the note (§6a) |

`kind` is an enum rather than a string **so the registry can be TOTAL over it and
the compiler can prove it**: adding a member is a type error until its handler
exists. That is the whole mechanism by which a third kind cannot quietly ship
half-wired.

**The registry** is `Record<ApprovalGateKind, GateHandler>`. **What a third kind
must supply to register — the table this record exists to make re-usable:**

| a handler supplies                                                                                                                 | for `design_result`                              | for `pull_request_merge`                          | for `decision_approval` — §8's FIFTH AMENDMENT (MOTIR-5672)                                                                 | for `decision_choice` — §1's MOTIR-5887 AMENDMENT                                                                                                                                                                 | for `decision_confirmation` — §1's MOTIR-5952 AMENDMENT                                                                                                                                                                                                                                             | for `plan_approval` — §11 (MOTIR-6031)                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **how to resolve the SUBJECT** from the gate row                                                                                   | the current `DesignEvidence` for the work item   | the linked pull-request delivery                  | the ONE `docs/decisions/*.md` file at the pull request's head, through a resolver; UNRESOLVABLE otherwise (clauses 1, 3, 8) | the `## Why this is a choice`, `## Options` and `## What this choice gates` sections PARSED from the work item's own `descriptionMd`; a body that does not parse raises NO gate and names its defect (points 1–2) | the `## Decision`, `## What changed`, `## Supersedes` and `## Resulting direction` sections PARSED from the work item's own `descriptionMd`; a body that does not parse raises NO gate and names its defect (points 2–3). The optional record is resolved beside it, never as the subject (point 8) | the PLAN `subjectId` names; its version is the proposal-set digest (§11.3). The gate belongs to NO work item (§11.1–11.2) |
| **who it ROUTES to**                                                                                                               | §2's rule (`assigneeId ?? reporterId`)           | the same                                          | the same                                                                                                                    | the same                                                                                                                                                                                                          | the same                                                                                                                                                                                                                                                                                            | `Plan.createdById`, else the workspace owner (§11.6)                                                                      |
| **which PERMISSION authorises a decision**                                                                                         | `work_item:edit`                                 | `work_item:merge_pull_request`                    | `work_item:edit`                                                                                                            | `work_item:edit`, under §2's AUTHORITY rule in force (point 4)                                                                                                                                                    | `work_item:edit`, under §2's AUTHORITY rule in force (point 5)                                                                                                                                                                                                                                      | `ai:decide_plan` — no relationship rung (§11.6)                                                                           |
| **which STATUS TRANSITION the gate owns**, or none                                                                                 | the move into the project's `done` category      | none — the webhook moves the card (§4)            | none — `approved` is the companion merge gate's, `done` the merge webhook's (clauses 2, 5)                                  | the move into the project's `done` category — a choice never has a pull request (point 6)                                                                                                                         | the move into the project's `done` category on Confirm, and into `cancelled` on Overturn — a `human` decision never has a pull request (point 7)                                                                                                                                                    | none on a work item — the PLAN's status, in the effect (§11.5)                                                            |
| **what `approve` DOES**                                                                                                            | §3                                               | §4                                                | records the decision and carries the merge ONCE; refused while UNRESOLVABLE (clauses 3, 5)                                  | there is no `approve`: each OPTION is a verb, `choose(optionId)`, which records the pick and writes `done` (points 5–6)                                                                                           | **Confirm**: records the decision, stamps the record or its absence, writes `done` (points 7–8)                                                                                                                                                                                                     | materializes the plan, as `approvePlan` does; refused while a revision is in flight (§11.4, §11.5c)                       |
| **what `request_changes` DOES** — ⚠️ §10 (MOTIR-6072) makes its reason REQUIRED on every kind and decides what FOLLOWS it per kind | records the decision, moves nothing              | records the decision, moves nothing               | records the decision, moves nothing — allowed while UNRESOLVABLE (clause 3)                                                 | **None of these — revise the options**: records `changes_requested`, moves nothing (point 5)                                                                                                                      | **not offered — OVERTURN instead**: records `overturned` with its REQUIRED note, writes `cancelled`, touches no other work item; the re-plan it owes is derived from `## Supersedes` (points 6–7)                                                                                                   | **not offered — DECLINE instead**: records `declined`, writes the plan `declined` / `reviewed`, reason optional (§11.4)   |
| **what to RETAIN on approval**, or nothing                                                                                         | pin the approved `DesignEvidence`'s assets (§6c) | nothing — the merge commit is durable on the host | nothing — the blob sha and the merge commit are durable on the host (clause 9)                                              | nothing to pin — the chosen option is SNAPSHOTTED onto the immutable gate row (point 7)                                                                                                                           | nothing to pin — the record's IDENTITY is snapshotted onto the immutable gate row; the body is the subject (point 8)                                                                                                                                                                                | nothing — the proposals and the cards they became are durable rows                                                        |

_The third column is added by §8's FIFTH AMENDMENT (MOTIR-5672, 2026-09-19); the
first two are unchanged. The fourth is added by §1's MOTIR-5887 amendment
(2026-09-21), below, whose points it cites. The fifth is added by §1's MOTIR-5952
amendment (2026-09-21), below the MOTIR-5887 one, whose points it cites._

_The sixth — `plan_approval` — is added by §11 (MOTIR-6031, 2026-09-23), whose points it cites; it is the first kind whose gate belongs to NO work item._

_The third column's SUBJECT may also be a published PAGE VERSION, read by a
second resolver and frozen at Approve — §8's NINTH AMENDMENT (MOTIR-7427,
2026-10-03). Its retention row then reads: the FROZEN mark on that version is the
pin (clause 6)._

_The seventh — `agent_review` — is added by §12 (MOTIR-6815, 2026-09-29), whose registry row and KIND-table row are stated there (12.1): a question the review AGENT answers, in front of the merge question._

A third kind is then a row in the enum, a handler, and a renderer for its
subject body. **No second vocabulary, no second control, no second decide door.**

> ### §1 — AMENDMENT (MOTIR-4911, 2026-09-08): a third kind, and a SUBJECT that is a document with a RESOLVER
>
> **What was INCOMPLETE.** The section above is right about the mechanism and
> short by one kind, and its subject column named two concrete row types — _"a
> `DesignEvidence` id, a pull-request delivery id"_. Naming rows makes the enum
> look like it is keyed on STORAGE, so the next kind whose subject is not yet a
> row reads as needing a migration before it can register. It does not.
>
> **`decision_approval` is a third kind.** A `type: decision` card with
> `executor: coding_agent` produces a decision DOCUMENT — the agent researches,
> proposes, and writes it — and a person approves or requests changes on it, with
> exactly the verbs `design_result` already has. It is the same vocabulary over a
> different subject, which is the whole claim §1 makes.
>
> **The KIND axis, in full, after this amendment:**
>
> | kind                    | the port shows                                                            | fires when                                                                                                                                       |
> | ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
> | `design_result`         | the changed mock(s), the note as a link — `design-result.md` AMENDMENT 4  | a design with **no pull request**                                                                                                                |
> | `decision_approval`     | the decision **document**                                                 | ~~a decision with **no pull request**~~ **a `coding_agent` decision whose pull request carries the document** (§8's FIFTH AMENDMENT, MOTIR-5672) |
> | `pull_request_approval` | what the card produced — design assets, or **what changed + how to test** | **any** card **with a pull request**                                                                                                             |
> | `pull_request_merge`    | the same port; it is the second decision on the same subject (§8, row 4b) | **any** card **with a pull request**                                                                                                             |
>
> **The kind decides the VERBS and the EFFECT; the PORT decides what you LOOK
> at, and the port is chosen by what the card PRODUCED, not by the kind.** That
> is why a design with a pull request is approved through
> `pull_request_approval` and still shows its mock: same gate, design port.
>
> > ### §1 — AMENDMENT (MOTIR-5658, 2026-09-17): the `design_result` row's _fires when_ is WRONG, and the rule is ONE GATE PER QUESTION
> >
> > **`design_result` fires on a design with a published result, WITH OR WITHOUT a
> > pull request** — `design-result.md` AMENDMENT 6 Q1. The table's _a design with
> > **no pull request**_ is superseded, and so is the reading of the paragraph
> > above that a design with a pull request is approved through
> > `pull_request_approval` INSTEAD. It is approved through **both**: the
> > `design_result` gate is the PRIMARY question and the merge rides on the same
> > press.
> >
> > **What the port paragraph gets right and keeps:** the PORT is chosen by what
> > the card PRODUCED. A design card shows its mock. What changes is that the
> > design card now also has its own gate to show it in.
> >
> > **⚠️ AND [MOTIR-5603](motir:cmu396zoh005ihwtxd5xpny37) DID NOT SETTLE "ONE GATE
> > PER CARD".** It settled **one MERGE gate per card** — it was two merge gates,
> > a per-pull-request `pull_request_merge` beside the per-card
> > `pull_request_approval`. **The rule is one gate per QUESTION.** Two gates of
> > DIFFERENT kinds on one card is the model, not the defect; misreading it as
> > one-gate-per-card is what produced the suppression MOTIR-5652 was filed
> > against.
>
> **THE SUBJECT IS A DOCUMENT WITH A RESOLVER.** ~~what is being decided — a
> `DesignEvidence` id, a pull-request delivery id~~ **What a gate points at is a
> document, and the handler supplies the RESOLVER that fetches it.** The gate row
> stores an opaque `subjectId` plus its kind; nothing in the schema knows which
> table — or whether there is a table at all.
>
> **Why that matters concretely: Motir's `pages` domain will later host decision
> documents**, and a decision doc that moves from an attachment to a page must be
> a RENDERER change and a resolver change — never a migration on the gate table.
> A subject column typed to a concrete row would have made the move a schema
> change on the audit table, which is the one table that should never be
> rewritten. Registering a kind therefore stays exactly what §1's table says:
> **a row in the enum, a handler (resolver + routing + authority + effect +
> retention), and a renderer.**
>
> **A kind may also carry a VERB SET rather than two verbs.** `decision_choice`
> — ~~a `type: decision` card with `executor: human`~~ **a `type: choice` work
> item (AMENDED, MOTIR-5887, 2026-09-21 — the taxonomy ADR's Amendment 3 admits
> the type; a `decision` work item, of either executor, never raises this kind)**,
> where the card states two or
> more options on named axes and a person PICKS one — is a gate by every property
> that matters here: it blocks work, it routes to one person, it needs a surface,
> and what they chose must be stamped with the same audit §6a describes. What
> differs is only the verb set, N options instead of Approve / Request changes,
> and the frame already accommodates it because the KIND is what decides the
> verbs. ~~**This record ships none of these handlers** — see _Deliberately NOT
> decided here_.~~ **AMENDED (MOTIR-5887): the handler is now decided — §1's
> MOTIR-5887 amendment, below.**

> ### §1 — AMENDMENT (MOTIR-5787, 2026-09-19): `acceptance_result` — the gate hangs on the STORY whatever the run target, and on a story run it is the PRIMARY of two gates whose ONE press merges the story's code
>
> **Settled by the requester, 2026-09-19** (Story
> [MOTIR-4949](motir:cmttv7s6o0087i0txzqwrpdw2)): _"if the run is on the story,
> then it's the double gate like design result gate too. the difference is
> approval to merge the story code, not the PR for acceptance video, acceptance
> video will never be committed. if the run is not for the story, the acceptance
> video gate is not on the test subtask which produced the video, it's on the
> story work item."_ This amendment writes that down as the rule, and answers the
> HOW questions it leaves (points 4–7), each with the rung that settles it.
>
> **Why this is a kind and not a new mechanism.** §1 generalised its vocabulary
> FROM acceptance — the evidence table above cites `AcceptancePanel.tsx` and
> `acceptanceActions.ts` — and acceptance never joined the registry.
> `acceptanceEvidenceService.decide` still flips the story `in_review → done |
in_progress` through its own path, so an acceptance decision is invisible to
> every surface built for gates in general. Registering the kind is
> [MOTIR-4950](motir:cmttv7s970088i0txmuykzjcw)'s; this amendment is the rule it
> builds to.
>
> **The row, in the kind table's own shape** (point 8):
>
> | kind                | the port shows                                                                  | fires when                                                                                                            |
> | ------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
> | `acceptance_result` | the RECEIPT — player, chapters, provenance (the port `AcceptancePanel` renders) | a **story** holds a published receipt, on a project whose acceptance-video switch is ON — **whatever the run target** |
>
> Its **status intent** is the project's `done` category, as the design gate's is
> (`DESIGN_APPROVAL_TARGET`) — which is what lets §6d's rule 1 hold a story's move
> into `done` while its acceptance is awaiting. Its **effect** is point 7 below.
> Its **authority and routing** are §2's, unchanged. Its **retention** is not this record's:
> `acceptance-receipt-lifecycle.md` §2 freezes an approved receipt and §6c here
> already defers to it — nothing is pinned, because nothing is ever superseded.
> **⚠️ AMENDED (MOTIR-5872, 2026-09-21):** that record's AMENDMENT 1 replaces the
> freeze with a PIN. An approved receipt IS superseded when its story is reworked,
> and its bytes are kept. The refusal now keys on the story, as the design gate's
> does: the story is closed, or it still stands on the approval.
>
> **⚠️ THE ACCEPTANCE VIDEO IS NEVER COMMITTED, AND THE ONE PRESS MERGES THE
> STORY'S CODE — NEVER A PULL REQUEST FOR THE VIDEO.** The receipt is an
> uploaded artefact on the story (`publish_acceptance_result`), not a file in any
> repository; there is no pull request for it to ride on, and none is ever opened.
>
> #### 1 — the gate hangs on the STORY, always
>
> The `acceptance_result` row's work item is **the story that owns the receipt**,
> whatever the run target. The receipt row is already the story's:
> `publish_acceptance_result` resolves a leaf key UP to its parent story
> (`lib/mcp/tools/publishAcceptanceResult.ts` → `publishAuth.findOwningStoryParent`),
> and `acceptanceEvidenceService.resolveStory` refuses anything that is not a
> story. The gate follows the receipt. **It is never raised on the producing test
> subtask**, whose own approve-to-merge gate — when that subtask is its own run
> target — asks only about that subtask's commits.
>
> **Why the story and not the run target.** §8's second amendment hangs a MERGE
> gate on the run target (`lib/services/runTarget.ts`), because the merge question
> is about the commits a run delivered. The acceptance question is not about any
> commits: _is this what I wanted?_ is a question about the STORY, and the video
> shows the story working. Hanging it on the E2E subtask would have a person
> approve a story from a card that is not the story, tangled with that subtask's
> own merge.
>
> #### 2 — run on the STORY ⇒ TWO gates on the story, ONE press
>
> When the story is its own run target, its run's pull requests are the story's
> delivery set, and the story holds two questions with different lifetimes —
> exactly the shape `design-result.md` AMENDMENT 6 Q1 settled, and this record's
> [MOTIR-5658](motir:cmu5x38aa002shvtxdrj3hwy8) amendment above names the rule it
> follows: **ONE GATE PER QUESTION**, not one gate per card.
>
> | gate                              | the question             | lifetime        |
> | --------------------------------- | ------------------------ | --------------- |
> | `acceptance_result` — **PRIMARY** | _is this what I wanted?_ | **durable**     |
> | `pull_request_approval`           | _do these commits land?_ | **per attempt** |
>
> **The acceptance gate is PRESENTED as the question**, with the story's pull
> requests and How to test beneath it as what the approval will merge. **One
> Approve decides the acceptance AND merges (or enqueues) every member of the
> story's delivery set**, through the existing merge-or-enqueue path
> (`pullRequestMergeService.approveAndMerge`). Putting `acceptance_result` into
> the gate-set predicate (`lib/approvalGates/gateSet.ts`, whose
> `AwaitableGateKind` today is `'design_result' | 'pull_request_approval'`) and
> wiring the one press are [MOTIR-5789](motir:cmu8msz0i0058hvoig072s3ml)'s; the
> frame that says which question is being asked is
> [MOTIR-5790](motir:cmu8msz1x005ahvoi3kq80xij)'s, drawn by
> [MOTIR-5788](motir:cmu8msyyw0056hvoifd30otz6).
>
> **⚠️ A STORY CANNOT HOLD BOTH A DESIGN PRIMARY AND AN ACCEPTANCE PRIMARY**,
> because a design result belongs to the design LEAF that produced it
> (`design-result.md` §3 — a container target is refused, `NotALeafError`). So the
> predicate never has to rank the two: on a story only `acceptance_result` can
> lead.
>
> #### 3 — run NOT on the story ⇒ the story's acceptance gate stands ALONE
>
> A single-card run of the E2E subtask delivers the subtask's pull request, not
> the story's; the story has no delivery set of its own. So the story holds the
> `acceptance_result` gate alone, and the subtask holds its own
> `pull_request_approval` alone. **The two presses are independent**: approving
> the subtask's merge says nothing about the story's acceptance, and approving the
> acceptance merges nothing.
>
> #### 4 — approving BEFORE green holds the merge, not the press (rung: `design-result.md` AMENDMENT 6 Q4)
>
> Q4 applies unchanged. The acceptance gate rises on PUBLISH and the merge gate
> on GREEN, so the primary can be pressed first. **The decision stands, and the
> merge follows on the next green verdict with no second press** — the same
> one-time carry `settleGreenVerdict` (`lib/services/mergeGates.ts`) already reads
> for a design through `designApprovalStandsForMerge`, including its MOTIR-5666
> clause that the carry holds only while the card has never had a merge gate.
> Teaching that reader to accept a standing ACCEPTANCE approval is
> [MOTIR-5789](motir:cmu8msz0i0058hvoig072s3ml)'s.
>
> #### 5 — what re-asks WHICH question (rung: AMENDMENT 6 Q2, and §6b's supersede)
>
> - **A merge that fails after approval re-opens the merge question ALONE.** The
>   acceptance decision stands. The routes back are AMENDMENT 6 Q2's own: _Queue
>   again_ while the head is unchanged, and a PUSH, whose next green raises a fresh
>   merge gate. Neither touches the acceptance gate.
> - **A PUSH does not by itself re-ask acceptance.** It supersedes the merge gate
>   with `head_moved`, as it does today. The receipt is not a function of the
>   head: a push that changes the story's behaviour is expected to produce a new
>   recording, and it is the RECORDING that re-asks.
> - **A newly PUBLISHED receipt re-asks acceptance.** It supersedes an `awaiting`
>   `acceptance_result` gate with the cause **`republished`** — the value
>   AMENDMENT 6 Q5 already carries for "a newer version superseded the one the gate
>   asked about". No new cause is minted.
>
> #### 6 — a DECIDED acceptance CLOSES the receipt — and that rule already SHIPS, stronger than Q3 (rung: `acceptance-receipt-lifecycle.md` §2 and §6, read at `acceptanceEvidenceService.persistEvidence`)
>
> The card asked for the AMENDMENT 6 Q3 analogue: an approved gate refuses a
> republish while a story pull request is open at or above `implemented`, so an
> agent returning to a failed merge cannot swap the video under an approval.
> **Measured: acceptance already has it, unconditionally.** `persistEvidence`
> locks the story's current receipt row and throws
> `AcceptanceEvidenceAlreadyApprovedError` when its status is `approved`
> (MOTIR-2764), and `acceptance-receipt-lifecycle.md` §6 holds that even a
> re-opened story does not unfreeze it.
>
> **So this record keys the refusal on the RECEIPT's `approved` status, as today,
> and deliberately NOT on Q3's three conditions.** Q3 needs its open-delivery and
> `implemented`-rung conditions because a design is legitimately re-published
> after an approval when the work is pulled back and reworked; a receipt is a
> signature on one recording and is never re-published after it is signed —
> lifecycle §2 rejected every weaker trigger on the record. Narrowing the freeze
> to Q3's window would re-open the evidence loss MOTIR-2764 closed. **The one
> obligation this puts on the build:** the gate's approve effect must still stamp
> the receipt row `approved` in the same transaction as the decision, or the
> freeze stops firing. That is [MOTIR-4950](motir:cmttv7s970088i0txmuykzjcw)'s
> handler (its criterion 4), and it is the reason `stampStatus`'s lock-derived
> stamp (MOTIR-2851) moves into the handler rather than being dropped with
> `decide`. The refusal's copy stays `AcceptanceEvidenceAlreadyApprovedError`'s;
> no new refusal is minted, so [MOTIR-5789](motir:cmu8msz0i0058hvoig072s3ml) owes
> a test that the freeze holds under the gate, not a second refusal.
>
> #### 7 — which STATUS approval writes, per run shape (rung: §3's MOTIR-4911 amendment, and the code read below)
>
> §3's rule is _approval writes `done` only when nothing will ever merge_, and it
> exists to keep ONE writer of `done`. For acceptance the rule has to be read over
> the story's **subtree**, because a story's `done` does something a leaf's does
> not: **`childStatusCascadeService` closes every not-done direct child** — from
> any status, `blocked` included, by a `{ system: true }` write — and each child's
> own transition re-emits and carries the cascade down.
>
> **Measured — why the design handler's discriminator CANNOT be copied.**
> `designResultGateHandler.approve` (`lib/approvalGates/designResultHandler.ts`)
> asks `workItemDeliveryRepository.countOpenByWorkItem(gate.workItemId)`, which
> counts deliveries whose `workItemId` is **the gated card itself**. On a
> single-card run the story delivers nothing — the open pull request belongs to
> the E2E subtask — so that count reads **0**, the arm writes `done` on the story,
> and the cascade then closes the E2E subtask whose pull request is still open,
> plus every sibling not yet built. Approving acceptance would complete unmerged
> and unbuilt work. **That is the defect this point exists to prevent.**
>
> | the story …                                                                                                                                        | approve does                                                                                                                                                                                                                                                                                                                                                                     |
> | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **has an open delivery of its own** — a story run                                                                                                  | record the decision, stamp the receipt `approved` (point 6), write **no status** from the acceptance gate. The same press decides the companion `pull_request_approval`, whose handler writes **`approved`** (`PULL_REQUEST_APPROVAL_TARGET`, `pullRequestApprovalHandler.ts`), and **the merge writes `done`**. The cascade then closes children that merge delivered — correct |
> | **delivers nothing itself, and ANY descendant is not in the `done` category** — a single-card run with work still open, or children still to build | record the decision, stamp the receipt, write **no status**. The story reaches `done` through `parentStatusRollupService`'s forward arm when its LAST child completes — by then the acceptance gate is decided, so §6d's rule 1 no longer holds that move                                                                                                                        |
> | **delivers nothing itself, and EVERY descendant is in the `done` category**                                                                        | record the decision, stamp the receipt, and write **`done`** — approval is TERMINAL. The rollup already tried this move when the last child finished and was refused `approval_pending` (§6d rule 1: the awaiting gate held the status its intent names), and it does not re-fire, so nothing else would write it                                                                |
>
> **The discriminator is therefore "is anything left under this story that a
> `done` would close?"** — the subtree's done-category check — **plus** the
> story's own open deliveries, never the card's own open-delivery count alone.
> `done` keeps exactly one writer in every row: the merge, the rollup, or the
> approval, and never two. `request_changes` moves nothing, as for every kind
> (§3); the old path's `in_review → in_progress` write retires with
> `acceptanceEvidenceService.decide`. Building the effect is
> [MOTIR-4950](motir:cmttv7s970088i0txmuykzjcw)'s (its criterion 4 names this
> point), and the placement matrix that proves it on both run shapes is
> [MOTIR-5791](motir:cmu8msz3a005chvoioew71yhw)'s.
>
> **What this amendment does NOT change.** The gate mechanism, routing, authority
> and state set ([MOTIR-4778](motir:cmtqhxi7r000vhvphp60vjymc)'s);
> `pull_request_approval`'s own raise conditions (§8's MOTIR-5479 amendment); the
> switch and its tier ([MOTIR-4925](motir:cmttap29j006dhxoipknbjh7v)); what a run
> records, how the video is paced, and the storage caps (`acceptance-video.md`).

> ### §1 — AMENDMENT (MOTIR-5903, 2026-09-21): the acceptance question is the STORY's gate, and WHEN it is asked follows the run shape — never merely because a receipt exists
>
> **Settled by the requester, 2026-09-21** (Bug
> [MOTIR-5903](motir:cmub3ulch000phwoizrkscton)): _"there should be no acceptance
> video gate, acceptance video gate is story gate"_. The acceptance video is not a
> question of its own that can be asked at any time. It is the story's gate, and
> an approval exists to let a person say yes to something that can actually
> happen. **This REPLACES the MOTIR-5787 amendment's timing** — its point 2's
> placement, point 6's closed receipt and point 7's status table all stand; the
> sentence it inherited from the design gate, _"it does not depend on pull
> requests, on CI, or on the run target"_, does not.
>
> **What shipped under the old wording, and why it was wrong.** `resolveGateSet`
> owed `acceptance_result` whenever a current receipt existed, and
> `acceptanceEvidenceService.persistEvidence` raised it right after the publish —
> during the run, before any pull request was green or merged. So a red story run
> held an acceptance "To approve" row and NO merge question, and a single-card
> run's story was asked while the E2E subtask's pull request was still open —
> where approving it could not finish the story at all
> (`nothingLeftForTheCascade` → `rollup_writes_done`).
>
> #### 1 — the raise condition, per run shape
>
> | run shape                                                                                               | what is approved                                                                     | "To approve" records                                                                             | when the acceptance question is owed                                                                                                                                                          |
> | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **story run** — the story delivers pull requests of its own                                             | the story's pull requests merge; the video is the **evidence** for that one approval | **one**: the story's approve-and-merge, the receipt leading it as its subject                    | exactly when **every member of the story's set could be merged now** — the merge question's own green test. **Never while any member is red, pending, a draft or closed.**                    |
> | **subtask run** — the story delivers nothing; the E2E subtask recorded the video and delivered the code | two separate things                                                                  | **two**: (a) the subtask's approve-to-merge; (b) the acceptance, which sets the **story** `done` | only once **every live descendant of the story is in the `done` category** — the recording subtask included. While it is unmerged the story cannot finish, so there is nothing to approve yet |
>
> The shape is read off the story's own delivery set, the same fact the handler's
> `merge_writes_done` row already reads — never off the run target and never off
> `producedByKey`, which is optional on a publish.
>
> **Why the WHOLE subtree and not only the producing subtask.** Approving (b) is
> what sets the story `done`. A sibling still open means that press would record a
> yes and move nothing (point 7's `rollup_writes_done` row), which is the same
> unactionable question this amendment removes. Waiting for the subtree makes the
> press TERMINAL in the ordinary case, as the requester described it.
>
> **The row stays kind `acceptance_result`**, the PRIMARY carrier on a story run.
> Folding it into `pull_request_approval` was the alternative, and it would have
> given up point 6's stamp: the handler is what stamps the receipt `approved`, and
> the stamp is what closes it. Keeping the kind and changing only WHEN it is owed
> keeps the one press, the stamp and the frame exactly as MOTIR-5787 built them.
> On a story run the two gates are therefore raised TOGETHER, on the same green,
> which is the one question the requester asked for — the frame already presents
> the pair as ONE row led by the receipt.
>
> #### 2 — what withdraws it on a story run (rung: §6b's supersede, the same causes)
>
> The question rides on the green set, so every event that takes the set out of
> green withdraws it WITH the merge question, under the same cause: a head move
> (`head_moved`), a close (`member_closed`), a draft (`member_drafted`) and a set
> change (`set_changed`) (`lib/services/pullRequestApprovalGates.ts`) — joined since by
> a conflict (`conflict`, MOTIR-5914), a red build (`ci_failed`, §8's SIXTH AMENDMENT)
> and a check at the asked-about commits running again (`ci_rerunning`, §8's SEVENTH
> AMENDMENT). The next
> green asks both again. **This reverses MOTIR-5787 point 5's _"a PUSH does not by
> itself re-ask acceptance"_ for an AWAITING question**: an unanswered question
> about a set that is no longer green is not a question anybody can act on. A
> DECIDED acceptance is untouched, as before — a push after the press re-asks the
> merge alone (AMENDMENT 6 Q2).
>
> #### 3 — what asks it on a subtask run (the WAKE)
>
> The subtree settles on a CHILD's status write, which no event on the story ever
> saw. So `workItemsService.applyStatusTransition`, on every move INTO the done
> category, re-asks the nearest story ancestor that holds a current receipt
> (`reconcileAcceptanceOwnerOf`, `lib/services/gateSetFor.ts`) — in the child's
> own transaction, under the story's row lock. That ordering is load-bearing: the
> upward rollup runs as a job AFTER the commit, and it finds the gate already
> there, so §6d's rule 1 holds the story's `done` for the approval instead of the
> rollup closing the story around an unasked question. `raiseOnReviewEntry` asks
> the same predicate for this kind, so a story rolling up into review does not
> raise it early by the back door.
>
> #### 4 — what this STRIKES in the MOTIR-5787 amendment
>
> - **Point 3** (_"the story holds the `acceptance_result` gate alone"_ while the
>   subtask holds its merge) — the story holds NOTHING until the subtask is done.
>   The two presses are still independent; they are now also sequential.
> - **Point 4** (_approving BEFORE green holds the merge_) — unreachable on a
>   story run, because the question does not exist before green. Q4's one-time
>   carry stays in the code for the design and decision gates, and still reads a
>   standing acceptance approval, which is now only ever given on green.
> - **Point 5**'s push rule, as §2 above says.
> - The kind table's _fires when_ cell (_"a story holds a published receipt …
>   whatever the run target"_) reads: _a story holds a published receipt AND the
>   work it shows can finish — its set green on a story run, its subtree done on a
>   subtask run_.
>
> #### 5 — what an `auto` project sees
>
> `auto` raises no merge gate (§7a). A story run's acceptance question is still
> owed on green and is the only question then; the item page keeps the
> standalone Acceptance section as its door, because the Development frame needs a
> merge gate to lead (MOTIR-5792). Whether an unanswered acceptance should HOLD an
> `auto` merge, as an unanswered design does (MOTIR-5762), is **not decided
> here** — it was not held before this amendment either.
>
> Pinned by `tests/approvalGates/gateSet.test.ts` (the run-shape cases),
> `tests/approvalGates/acceptanceStoryGate.test.ts` (the placement matrix, the
> wake, and the withdraw on a push), `tests/attachments/acceptance-gate.test.ts`,
> and `tests/e2e/acceptance-gate.spec.ts`'s single-card and not-yet-green
> chapters.

> ### §1 — AMENDMENT (MOTIR-5887, 2026-09-21): `decision_choice` is REGISTERED — keyed on `type: choice`, its verbs are the OPTIONS plus one refusal, its subject is a parsed section of the body, and its record stamps the pick
>
> **What was WRONG.** §1 named `decision_choice` and keyed it on `type:
decision` + `executor: human` — the verb-set paragraph above, §8's fifth
> amendment clause 10, and _Deliberately NOT decided here_. That pair already
> meant something else: `decision` is the type whose work item holds a DECIDED
> record for a person to accept (`decision_approval`). The taxonomy ADR's
> Amendment 3 (MOTIR-5886) splits the undecided act out as its own type,
> **`choice`** — a question the planner correctly declined to decide, two or
> more options each carrying its WHY and what it is best for, and a person PICKS one.
> All three places are re-keyed in place. **A `decision` work item, of either
> executor, never raises `decision_choice`.**
>
> **What this amendment settles is the HANDLER ROW** — the fifth column of §1's
> table cites the points below. It ships no code: the kind, its parser and its
> handler are MOTIR-5891's; the decide door's new verb is MOTIR-5893's; the port
> is MOTIR-5896's, drawn by MOTIR-5888.
>
> #### 1 — the SUBJECT is a PARSED SECTION of the work item's own body, never a new table
>
> The body is what the reviewer read. A structured copy of the options beside it
> would be a second source of truth with two writers, and the first edit to one
> of them would make the gate decide something nobody read. So the subject is
> the work item's own `descriptionMd`, in this canonical structure — the one the
> parser, the port and the `type-choice` authoring pack (MOTIR-5889 /
> MOTIR-5892) all read:
>
> ```
> ## Question
> <the question the planner declined to decide>
>
> ## Why this is a choice
> **Situation:** <contradicts your decision · better than your decision · two workflows>
> **You said:** <the decision the person gave, quoted — situations 1 and 2 only>
> <what research found, or where in the requirement the fork sits>
>
> ## Options
>
> ### <label>
> **Best if you want:** <what this option is best for — e.g. more cost-effective ·
> faster to the goal · more customisable later · less to operate>
> <its WHY, prose>
>
> ### <label>
> …
>
> ## What this choice gates
> <the follow-up work that will be planned once an option is chosen>
> ```
>
> - **`## Why this is a choice` names which of the THREE situations brought it
>   back** — the exhaustive set `kind-container.md`'s choice rule (MOTIR-4915)
>   defines, one `**Situation:**` value each:
>
>   | `**Situation:**` value      | situation id                | the situation                                                   | `**You said:**` |
>   | --------------------------- | --------------------------- | --------------------------------------------------------------- | --------------- |
>   | `contradicts your decision` | `contradicts_your_decision` | research CONTRADICTS the architecture decision the person gave  | required        |
>   | `better than your decision` | `better_than_your_decision` | a BETTER option exists, and the person's decision is NOT wrong  | required        |
>   | `two workflows`             | `two_workflows`             | the requirement itself admits two genuinely different WORKFLOWS | not used        |
>
>   The first two DEBATE a decision the person already made, so they carry it
>   quoted on a `**You said:**` line; the rule's precondition — _no HOW offered ⇒
>   nothing to contradict, and no choice_ — is thereby CHECKABLE rather than
>   asserted. The third debates nothing, so it names where the fork sits in the
>   requirement instead. **Why it is here matters to the person picking**: a
>   choice that overrules what they said reads differently from one their own
>   requirement forked, and without the section they cannot tell which they are
>   facing. (Added on review of MOTIR-5888's first published design, 2026-09-21.)
>
> - **An option's id is the kebab-case slug of its label.** It is what the
>   verb, the stored pick and `outcomeRef` name.
> - **`subjectVersion` is a hash of the `## Why this is a choice`, `## Options`
>   and `## What this choice gates` sections** — not of the whole body, so
>   editing the question's wording or a typo elsewhere does not retire a pending
>   decision, while any change to what is being chosen between, or to why it is
>   being asked at all, does. An edit that moves it trips the shipped
>   stale-stamp refusal (`APPROVAL_GATE_STALE_SUBJECT`, MOTIR-5232) for anyone
>   who pressed against the old version.
> - **Where a subject lives stays the handler's business**, as §1's MOTIR-4911
>   amendment requires: the gate row stores the opaque `subjectId` (the work
>   item) and nothing in the schema knows the options live in Markdown.
>
> #### 2 — a COMPLETE body raises a gate; an incomplete one raises NONE and says why
>
> The defect reasons are a CLOSED set, and the parser returns exactly one of
> them or the parsed options:
>
> | reason                    | when                                                                                   |
> | ------------------------- | -------------------------------------------------------------------------------------- |
> | `fewer_than_two_options`  | `## Options` holds zero or one `###` option                                            |
> | `option_without_best_for` | an option has no `**Best if you want:**` line — the reason NAMES the option            |
> | `duplicate_option`        | two options slug to the same id                                                        |
> | `no_follow_up_section`    | `## What this choice gates` is missing or empty                                        |
> | `no_why_section`          | `## Why this is a choice` is missing, or carries no `**Situation:**` line              |
> | `unknown_situation`       | the `**Situation:**` value is not one of the three — the reason QUOTES it              |
> | `no_quoted_decision`      | the situation debates a decision (the first two) and no `**You said:**` line quotes it |
>
> The item renders the reason rather than a bare list — the story's honest
> defect state. **And it is what makes "a follow-up planning pass is owed" true
> of EVERY choice that can be decided**: one that does not say what it gates
> cannot raise a gate, so there is no path to `done` that leaves the unplanned
> work unnamed.
>
> _Options that cannot be weighed against each other_ — each best for something
> the others never mention, the second defect the `type-choice` authoring bar
> names — is **not** a parser reason: whether two such options can be weighed
> against each other is a judgement, not a property of the Markdown. It stays
> an authoring rule, and a person facing such options refuses with the one
> refusal verb (point 5).
>
> #### 3 — RAISE and SUPERSEDE
>
> - **Raised** `awaiting` on a `type: choice` work item whose body parses
>   complete, that has **no open blocker**, and that is **not in a `done`-category
>   status**. The work item then moves to `in_review` **along declared workflow
>   edges only** (the same hop-walking the status sync does); where the project's
>   workflow offers no path, the gate is still raised and the status is left
>   where it is.
> - **An edit that moves `subjectVersion`** supersedes the `awaiting` gate and
>   raises a fresh one from the new body, as the other kinds do on a new version.
>   The supersede cause is the shipped `republished` — the subject was restated
>   under the question — so no new `ApprovalGateSupersedeCause` value is needed.
>   An edit that makes the body stop parsing supersedes the gate and raises
>   none; the defect state takes its place.
> - **After `changes_requested`**, the next edit that moves `subjectVersion` and
>   parses complete raises a fresh gate. Nothing re-asks the unchanged options.
>
> #### 4 — ROUTING and AUTHORITY: §2, unchanged
>
> Routed to `assigneeId ?? reporterId`. Decided under §2's AUTHORITY rule **in
> force** — the assignee, or the reporter when there is no assignee (§2's second
> amendment), or a holder of `approval:decide_any` (§2's third amendment) — with
> `work_item:edit` as the permission floor, the same as `design_result` and
> `decision_approval`. Nothing about who decides a choice differs from who
> decides a design.
>
> #### 5 — the VERB SET is the OPTIONS, plus ONE refusal
>
> - **Each option is a verb: `choose(optionId)`.** There is no separate confirm-
>   the-recommendation step, because nothing was recommended — that is what
>   makes it a `choice` and not a `decision`. The frame's own confirm step (the
>   press, then the commit) is the only confirmation.
> - **_None of these — revise the options_** is this kind's `request_changes`.
>   A gate a person cannot refuse traps them into picking something wrong. It
>   records `changes_requested` with its note and **moves nothing**, exactly as
>   `design_result`'s `requestChanges` does (`designResultHandler.ts`); the gate
>   is routed, so the work item's assignee — or its reporter — is who revises
>   the body.
> - **The decide door gains the verb** (`GateDecision` takes `choose` +
>   `optionId` on the route, the server action and the service — MOTIR-5893). An
>   `optionId` that is not in the gate's `subjectVersion` is refused as a stale
>   subject, never matched loosely.
>
> #### 6 — the EFFECT is TERMINAL: Workflow A
>
> A choice work item never has a pull request, so nothing would ever merge and
> nothing else would write `done`. Choosing writes the project's `done`-category
> status through `applyStatusTransition` with `decidingGateId` — the
> `design_result` handler's own path, exempting only this gate from the held-move
> guard (§6d's amendment, rule 5). §8's Workflow A diagram names
> `decision_choice` beside `design_result`.
>
> #### 7 — the RECORD stamps the pick, and it survives the body
>
> - `state: approved` on a choice — **no new state value**. The verb that
>   produced it is readable from the stamp below.
> - **`outcomeRef` = the chosen option's id.** ⚠️ **This is the one kind where
>   `outcomeRef` does NOT carry `statusWritten`** (`approvalGatesService.decide`
>   writes `outcomeRef: effect.statusWritten` today, `approvalGatesService.ts`
>   ~L1641). For `decision_choice` the status written is implied by the kind —
>   Workflow A always writes `done` — so the column holds what the kind uniquely
>   caused: which option won.
> - **A new nullable `chosenOption` JSON column on `approval_gate`** stamps
>   `{ optionId, label, bestFor, followUp, situation }` — the pick's label, what it
>   is best for, the text of `## What this choice gates`, and the situation id that
>   brought the choice back — **in the deciding write**, under
>   the existing `trg_approval_gate_decided_immutable` trigger. The pick stays
>   readable months later without re-reading a body that may since have changed:
>   _why were we asked, what did we pick, what was it best for, and what does it unblock?_
>   is one row. It
>   is null on every other kind and on a `changes_requested` choice.
> - **Retention: nothing to pin.** The snapshot IS the retained artefact, and it
>   lives on the immutable row.
>
> #### 8 — the KIND table's row
>
> | kind              | the port shows                                                                                                                                              | fires when                                                                                      |
> | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
> | `decision_choice` | the QUESTION, WHY it is a choice (the situation), the N options each with its WHY and what it is BEST FOR, and what the choice gates — or the defect reason | a **`type: choice`** work item whose body parses complete, unblocked, not done — **never** a PR |
>
> **The frame is the SAME component** as every other kind's (§1's claim that the
> KIND decides the verbs and the PORT decides what you look at). This is the
> first kind whose verb set is not a fixed pair, so it is where that claim is
> exercised rather than asserted. How band 3 behaves as N grows — select an
> option row, then commit it — is MOTIR-5888's to draw.
>
> **Not decided here:** where a choice work item may be created or when one is
> warranted (MOTIR-4915's placement rule); ~~the DECISION work item's own gate
> (MOTIR-5871)~~ **AMENDED (MOTIR-5952, 2026-09-21): decided — §1's MOTIR-5952
> amendment, directly below**; and whether a lay session may write a choice's body
> (MOTIR-5870).

> ### §1 — AMENDMENT (MOTIR-5952, 2026-09-21): `decision_confirmation` is REGISTERED — keyed on a `human` decision, its subject is the parsed body, its verbs are Confirm and Overturn, its record is optional, and decisions ACCUMULATE
>
> **What was MISSING.** Story MOTIR-5871 makes the planner lay a `decision` work
> item at the epic whenever a re-plan changes already-approved work by WORKFLOW,
> MORE requirement or LESS requirement. That work item carries a decision the
> planner settled WITH the person in the conversation, and it needs a gate the
> person can REFUSE: _"that's not what we discussed"_. Verified on `origin/main`
> `5b9ad67fb`, no existing kind asks the question:
>
> - `decision_approval` answers `null` — `asksTheDecisionQuestion`
>   (`lib/approvalGates/decisionDocument.ts`) is `type === 'decision' &&
executor === 'coding_agent'`, and its subject is a `docs/decisions/*.md`
>   file captured from an OPEN pull request, which a `human` decision never has.
> - `decision_choice` requires `type: choice` (the MOTIR-5887 amendment above).
> - `design_result`, `pull_request_approval`, `pull_request_merge` and
>   `acceptance_result` each need an evidence row or a pull request.
>
> So a `human` decision work item was plain text: nothing asked anybody to confirm
> it, nothing held a hand move to `done`, and nothing recorded who agreed. **This
> amendment settles the HANDLER ROW** — the sixth column of §1's table cites the
> points below. It ships no code: the kind, its parser, its raise and Confirm are
> MOTIR-5954's; Overturn is MOTIR-5956's; the port is drawn by MOTIR-5953 and built
> by MOTIR-5960 and MOTIR-5961; the planner's rule is MOTIR-5955's (the runbook)
> and MOTIR-5957's (the shipped planner).
>
> #### 1 — the KIND is `decision_confirmation`, and the three decision kinds are DISJOINT over `(type, executor)`
>
> | `type`     | `executor`     | kind                                                                                   |
> | ---------- | -------------- | -------------------------------------------------------------------------------------- |
> | `decision` | `coding_agent` | `decision_approval` — **unchanged**: the agent researched and proposed, in a PR        |
> | `decision` | `human`        | **`decision_confirmation`** — the planner decided WITH the person; the person confirms |
> | `choice`   | any            | `decision_choice` — **unchanged**: nobody decided; the person picks                    |
>
> **Why a NEW kind rather than one of the two beside it.** Reusing
> `decision_approval` would mean giving a `human` decision a pull request so
> there is a document to capture, and a `human` decision is never dispatched, so
> no run exists to open one. Reusing `decision_choice` would put a decided
> question behind a verb set whose premise is that nothing was decided. The
> keying is the taxonomy ADR's Amendment 3 §1d gloss read literally: _"a decision
> already made — by the agent researching it, or by the planner with the person in
> conversation — written down so a person can accept it"_. The executor is what
> tells the two halves of that sentence apart, and its default stays `human`.
>
> **The gate is keyed on `type` + `executor` and NOTHING ELSE** — not on where the
> work item hangs, and not on whether a re-plan produced it. A `human` decision
> written by hand, anywhere, gets the same gate.
>
> #### 2 — the SUBJECT is the work item's own BODY, parsed — the `decision_choice` arrangement
>
> The planner writes the body at LAY, in the conversation where the direction was
> settled (Story MOTIR-5870's phase exception), so the content exists before any
> record could. A structured copy beside it would be a second source of truth
> with two writers. The canonical structure, in this ORDER:
>
> ```
> ## Decision
> <the direction agreed in the conversation, in one paragraph>
>
> ## What changed
> **Change:** <workflow · more requirement · less requirement>
> <what the approved plan said before, and what it says now>
>
> ## Supersedes
> <each already-approved work item this re-plan changed or removed, by key — and
> any earlier decision work item on this epic that this one partially contradicts,
> by key; never empty>
>
> ## Resulting direction
> <the epic's direction in full after this decision, so a reader never has to
> fold N decisions together>
> ```
>
> - **`**Change:**` carries ONE OR MORE of three values**, separated by `·` or a
>   comma, each matched case-insensitively:
>
>   | `**Change:**` value | change id          | what moved                                               |
>   | ------------------- | ------------------ | -------------------------------------------------------- |
>   | `workflow`          | `workflow`         | how the approved work is sequenced or performed          |
>   | `more requirement`  | `more_requirement` | the person committed to MORE than the approved plan held |
>   | `less requirement`  | `less_requirement` | the person dropped part of what the approved plan held   |
>
>   **DEVIATION from the planner's recommendation, with its reason:** the card
>   read the line as one value. One re-plan routinely drops a story AND
>   re-orders what remains, and forcing a single value makes the decision
>   misstate itself; the three remain a CLOSED set, so an unknown value is still
>   a defect. The values are stored in the order written, de-duplicated.
>
> - **`## Supersedes` is a list of work-item KEYS** — every `<PROJECT>-<n>` token
>   in the section, bare or as the text of a link, in the order written,
>   de-duplicated. The parser is PURE and does not resolve them: a key that names
>   nothing renders as plain text on the port, never as a defect, because a
>   removed work item is precisely what a LESS-requirement decision supersedes.
> - **`subjectVersion` is a hash of the four sections**, the section bodies
>   whitespace-normalised. Editing anything else in the body — a closing note, a
>   typo outside the four — does not retire a pending confirmation; changing the
>   decision does. An edit that moves it trips the shipped stale-stamp refusal
>   (`APPROVAL_GATE_STALE_SUBJECT`, MOTIR-5232) for anyone who pressed against
>   the old version.
> - **Where the subject lives stays the handler's business** (§1's MOTIR-4911
>   amendment): the gate row stores the opaque `subjectId` (the work item).
>
> #### 3 — a COMPLETE body raises a gate; an incomplete one raises NONE and says why
>
> The parser (`parseDecisionRecord`, beside `choiceOptions.ts`) returns the
> parsed sections or EXACTLY ONE defect reason — the FIRST it meets, in the
> section order above. The set is CLOSED:
>
> | reason                   | when                                                                 |
> | ------------------------ | -------------------------------------------------------------------- |
> | `no_decision_section`    | `## Decision` is missing or empty                                    |
> | `no_change_section`      | `## What changed` is missing, or carries no `**Change:**` line       |
> | `unknown_change`         | a `**Change:**` value is not one of the three — the reason QUOTES it |
> | `no_supersedes_section`  | `## Supersedes` is missing                                           |
> | `empty_supersedes`       | `## Supersedes` names no work-item key                               |
> | `no_resulting_direction` | `## Resulting direction` is missing or empty                         |
>
> A body that does not parse raises NO gate, and the item renders the reason
> rather than a broken port — `decision_choice`'s point 2 behaviour. **With no
> gate, nothing is held**: a hand move to `done` on a defective decision
> succeeds, which is the _"both steps optional"_ promise of point 7 applied to the
> gate itself. Motir helps build an auditable project; it does not trap a person
> behind a body they chose not to finish.
>
> **Why `## Supersedes` may never be empty.** The trigger for laying this work
> item is a re-plan that changes ALREADY-APPROVED work; a decision that
> supersedes nothing was laid on no trigger, and an empty section is how that
> mistake shows.
>
> #### 4 — RAISE and SUPERSEDE: `choiceGateService.reconcile`'s shape
>
> - **Raised** `awaiting` on a `decision` + `human` work item whose body parses
>   complete, that has **no open blocker**, and that is **not in a
>   `done`-category status** — at three call sites, the ones `reconcileChoiceGate`
>   already has in `workItemsService`: on create; on an update to `descriptionMd`,
>   `type` **or `executor`**; and when its last open blocker reaches `done`. The
>   work item then moves to `in_review` along DECLARED workflow edges only, as a
>   choice does; where the workflow offers no path, the gate is still raised and
>   the status left alone.
> - **Superseded `withdrawn`** when the work item stops being a `human`
>   decision (its type or its executor changed). `executor` is the new trigger a
>   choice does not have: flipping a decision to `coding_agent` hands it to
>   `decision_approval`, and the pending confirmation must not linger beside it.
> - **Superseded `republished`** when an edit moves `subjectVersion`, followed by
>   a fresh gate from the new body; when the body stops parsing, superseded and
>   none raised. No new `ApprovalGateSupersedeCause` value is needed.
> - **A hand move to `cancelled` WITHDRAWS the question; it is not an overturn.**
>   A hand move to `done` is HELD while the gate awaits (§6d's rule 1 — the kind's
>   status intent resolves to the `done` category), but `cancelled` is never held
>   (`heldMoves.ts`, `CANCELLED_STATUS_KEY`), and the shipped pull-back rule
>   already supersedes every awaiting gate on that move with cause `pulled_back`
>   (§6d's amendment, rule 6 — `workItemsService.applyStatusTransition`). Nothing
>   new is built for it; it is stated because the two look alike from outside:
>   an overturn is a DECISION with a decider and a note, a cancel is the question
>   going away, and the record tells them apart by carrying no decider.
> - `raiseOnReviewEntry` skips this kind, as it skips `decision_choice`: the raise
>   is the reconcile's, never a review-entry side effect.
>
> #### 5 — ROUTING and AUTHORITY: §2, unchanged
>
> Routed to `assigneeId ?? reporterId`. Both verbs are decided under §2's
> AUTHORITY rule **in force** — the assignee, or the reporter when there is no
> assignee (§2's second amendment), or a holder of `approval:decide_any` (§2's
> third amendment) — with `work_item:edit` as the permission floor. The person
> who settled the direction with the planner is the natural assignee; nothing in
> the gate requires it.
>
> #### 6 — the VERBS are CONFIRM and OVERTURN, and Overturn is NOT `request_changes`
>
> - **Confirm** is this kind's `approve`.
> - **Overturn** is a new verb on the decide door (`GateDecision` gains
>   `overturn`, on the route, the server action and the service — MOTIR-5956).
>   _"That's not what we discussed"_ does not ask somebody to revise the text; it
>   refuses the DIRECTION, and the honest consequence is a re-plan of the work it
>   changed. Folding it into `request_changes` would leave a refused decision
>   looking like one waiting for an edit.
>   - **(a) A new `ApprovalGateState` value: `overturned`**, not an overloaded
>     `changes_requested`. `changes_requested` is non-terminal in every kind that
>     has it — the subject is revised and a fresh gate asks again — and a reader
>     counting refusals would mis-read an overturn as a pending revision. The
>     decided-row immutability trigger (`trg_approval_gate_decided_immutable`)
>     covers it exactly as it covers the other decided states.
>   - **(b) Overturn REQUIRES a note** — what was actually discussed. An empty
>     note is refused with a typed validation error. The note is the only place
>     the correct direction is written down until the re-plan happens.
>   - **(c) Both verbs sit under point 5's authority** — no separate permission.
> - **`request_changes` is NOT offered on this kind**, and `overturn` is offered
>   on NO other kind; the decide door refuses either with
>   `ApprovalGateVerbNotOfferedError`. A decision whose WORDING is off is edited
>   (point 4 re-asks); one whose DIRECTION is off is overturned. There is no third
>   case for a middle verb to cover.
>
> #### 7 — the EFFECTS are TERMINAL: Workflow A
>
> A `human` decision never has a pull request, so nothing would ever merge and
> nothing else would write a status.
>
> - **Confirm** writes the project's `done`-category status through
>   `applyStatusTransition` with `decidingGateId` — `decision_choice`'s point 6,
>   exempting only this gate from the held-move guard (§6d's amendment, rule 5).
>   `outcomeRef` carries `statusWritten`, as on every kind but `decision_choice`.
> - **Overturn** writes the project's `cancelled` status (category `done`,
>   `lib/workflows/defaultWorkflow.ts`) through the same exempt path, so the
>   decision stops counting as open work, and stamps `overturned` with its note.
>   **It writes to NO other work item.** The re-plan it implies is a planning act a
>   person starts — the gate does not undo the plan, move a status or file a card.
>   **What is owed is DERIVED, not stored twice**: an overturned gate plus the keys
>   its subject's `## Supersedes` parsed. It is readable in two places — the
>   port's overturned record band (MOTIR-5960), and the gate DTO as
>   `replanOwed: { keys: string[] }` (null on any other state), which the AI
>   boundary read carries to the planner (MOTIR-5958).
> - A project whose workflow has no `cancelled` status still records the
>   overturn; the status is then left where it is and the stamp's
>   `outcomeRef` is null. The DECISION is the audit; the status is a
>   convenience.
>
> #### 8 — the RECORD is OPTIONAL, never what the gate reads, and — for now — an ATTACHMENT
>
> The gate's subject is the body. A longer written record is welcome and is never
> a precondition: **a decision is confirmable with no record at all.**
>
> ~~**The record's interim home is an ATTACHMENT on the decision work item — a
> TEMPORARY solution by requester decision (2026-09-21), until the pages epic
> ships and a PAGE replaces it through MOTIR-5761's resolver.**~~
> **⚠️ AMENDED by §8's NINTH AMENDMENT, clause 7 (MOTIR-7427, 2026-10-03): a NEW
> record is a published PAGE VERSION, named through `publish_decision_page` and
> FROZEN at Confirm.** The attachment rules below keep governing every record
> made as an attachment: those records keep rendering and are not migrated, and a
> card with both a publication and an attachment takes the page. A page is the
> long-term home because an epic can span repositories and a `docs/decisions/*.md`
> file must pick one; a `human` decision is never dispatched, so no run or pull
> request writes one either. **The pull-request / `docs/decisions/` path is not a
> record for this kind.**
>
> - **Which attachment counts:** one linked to the decision work item itself,
>   that the item's attachments PANEL lists (the source is not in
>   `attachmentRepository.LIFECYCLE_OWNED_SOURCES` — so a design result's
>   extracted `design-notes.md`, which is `text/markdown` too, never counts), and
>   that is MARKDOWN: `mimeType` `text/markdown`, or an `originalFilename` ending
>   in `.md`. With more than one, the NEWEST by `createdAt`, and the port says
>   which file it chose. No repository and no pull request is involved.
> - **The STAMP at Confirm** — the `Attachment` row carries no content hash, so
>   the stamp is its identity: `{ kind: 'attachment', attachmentId,
originalFilename, mimeType, sizeBytes, createdAt }`, written into a new
>   nullable JSON column on `approval_gate` in the deciding write, under the
>   decided-row trigger — `decision_choice`'s `chosenOption` pattern. With no
>   counting attachment it stamps `{ kind: 'none' }`. **A later replacement is
>   detectable by ID, not by content**: a different newest attachment is a
>   different id, and nothing can tell whether an edited file with the same name
>   says the same thing. That is the honest limit of an attachment, and the page
>   arm's reason to exist.
> - **Deletion.** `attachmentsService.deleteAttachment` is a HARD delete — the
>   row is unlinked in the transaction and removed once its blob is gone, with no
>   tombstone — so a confirmed record can vanish. The AUDIT survives because the
>   subject was the body and the stamp holds the file's identity. The record band
>   then reads **_record removed_**, naming the stamped filename with no link;
>   never a broken link.
> - **No record** — the band reads, in words, **_Confirmed without a written
>   record_**; with one, **_Confirmed with a written record_** and the file's
>   name as a link. Neither is an error.
> - **The move to pages is a RESOLVER change, never a migration on the gate
>   table** (§1's MOTIR-4911 amendment). The seam is one function,
>   `resolveDecisionRecord(workItemId)`, returning `{ kind: 'attachment', … }` or
>   `{ kind: 'none' }`; MOTIR-5761 adds a `{ kind: 'page', pageId, … }` arm and
>   the renderer that draws it. The stamp is a DISCRIMINATED union for exactly
>   that reason: a page stamp is a new arm in a JSON column, and every gate
>   confirmed against an attachment keeps reading as one.
>
> #### 9 — DECISIONS ACCUMULATE: a second decision never supersedes the first
>
> Two `decision_confirmation` gates on two work items under one epic are
> INDEPENDENT. Confirming the later one changes nothing on the earlier one, which
> stays `done`, stamped and readable.
>
> **Why supersede is wrong here, and not merely unnecessary.** Each decision
> explains a contradiction between what SHIPPED and what is now planned, and the
> shipped half does not go away: the code from the earlier direction is still in
> the repository, and the re-plan could not have rewritten the work items that
> built it — `validateProposals` refuses a `modify` or `remove` of a
> done-category target (`PlanTargetImmutableError`,
> `lib/plans/validateProposals.ts`). A card that later deletes what a `done` card
> shipped is indistinguishable from a mistake without the decision that
> explains it, and that need is PERMANENT. A superseded decision would be a false
> statement about code that still exists.
>
> **What the later decision does instead** is name the earlier one in its own
> `## Supersedes` by key and restate the direction IN FULL under `## Resulting
direction` — so _"why does this card delete story 6's tests?"_ follows one
> reference, and _"how do I lay story 7?"_ reads the latest decision without
> folding N of them. Readers are shown them in order, oldest-confirmed first.
>
> #### 10 — the CALENDAR rule the readers apply: a confirmed decision is auditable INTENT, not enforcement
>
> The decision-authority ladder points the wrong way here on its own: rung 3 ranks
> an explicit, informed decision above the shipped code, so a later pass could
> read a confirmed decision as authority and "repair" code that contradicts it —
> when the person changed the project by hand and the code is simply NEWER.
>
> **A reader compares the gate's `decidedAt` with the date of the code it
> contradicts** — the instrument the corpus already uses for _a `done` design
> blocker that merged AFTER the card_, whose trigger is the calendar:
>
> - **Decision newer** ⇒ it governs work not yet done.
> - **Code newer and contradicting** ⇒ the decision is STALE, the code is what
>   IS, and the contradiction is a finding to REPORT — never a repair to perform.
>
> This record states the rule. The readers that apply it are the dispatched
> prompt (MOTIR-5959) and the planner (MOTIR-5955 · MOTIR-5957); the gate itself
> enforces nothing about code.
>
> **AMENDMENT (Bug MOTIR-10146, 2026-10-31): the AI boundary's `decision` block reads
> BOTH deciding gates.** The block MOTIR-5958 put on `plan-tree`, `get-subtree` and
> `get-item` was read from `decision_confirmation` alone, on `human` decisions alone,
> so the hosted planner could not date — or even see as decided — a decision the
> planner recorded itself (`coding_agent`, approved at its `decision_approval` gate),
> while plan.py could through `get_approval_gate`. The batched read
> (`approvalGateRepository.findDecisionGatesByWorkItemIds`) now joins each decision
> to its latest gate of the kind its executor is decided at, and the block carries
> that `kind` plus, on an overturn, the person's `noteMd` — the reason this point's
> reader needs to explain why a direction was dropped. A `decision_approval` sent
> back (`changes_requested`) reads `awaiting`: it is owed a new version, not settled.
> Both fields are additive, so the two repositories deploy in either order.
>
> #### 11 — where the work item HANGS: a fact about placement the gate does NOT enforce
>
> A `task` under the epic whose work it governs — the nearest not-`done`
> ancestor, or parentless when that epic is `done` — the same home as a choice
> work item, because its readers are the same: the person at approval, and the
> next `(lay, epic)` pass, whose SURVEY reads the epic's own children. **Never in
> the epic's body**: the epic body's first section is the capability _"in THEIR
> words rather than the code's"_, and a decision is implementation or workflow
> detail. The planner's rule owns the placement (MOTIR-5955 · MOTIR-5957); the
> gate is keyed on point 1 alone.
>
> #### 12 — the KIND table's row
>
> | kind                    | the port shows                                                                                                                                                            | fires when                                                                                            |
> | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
> | `decision_confirmation` | the DECISION, what CHANGED (its change values), what it SUPERSEDES as work-item chips, the RESULTING direction, and the record link or its absence — or the defect reason | a **`decision` + `human`** work item whose body parses complete, unblocked, not done — **never** a PR |
>
> **The frame is the SAME component** as every other kind's; the port is new
> content and two verbs inside it. How the Overturn note is drawn is MOTIR-5953's.
>
> **Not decided here:** WHEN a re-plan lays a decision work item, and the
> `type-decision` authoring bar (MOTIR-5955 · MOTIR-5957); the PAGE resolver
> (MOTIR-5761); any automatic re-plan on an overturn — there is none, by point 7.

### 2. Routing and authority — DECIDED BY THE REQUESTER (Yue, 2026-09-08)

**ROUTING: `assigneeId ?? reporterId`.** Assignee first; the reporter receives
the gate **only when there is no assignee**. Exactly one person is shown a gate.

**⚠️ This is a deliberate DIVERGENCE from `homeService`'s membership predicate,
and the reason is recorded here so the next reader does not "fix" it back.** The
three Workbench work tabs use assignee **OR** reporter, deduped, and MOTIR-2649
argues for that union because an item filed through the MCP carries its creator
as reporter and that same person runs it — two hats, one person. **That
reasoning is about a WORK LIST and does not transfer to a DECISION QUEUE.** A
work list may be generous: showing you your own item twice costs a glance. A
gate shown to two people is a decision neither owns — each waits for the other,
and _who_ is the entire question a gate asks. The fallback yields one recipient
in every case, including the MCP case the union was built for: no assignee ⇒ the
reporter, who is the same person anyway.

**Options A–D as originally framed (assignee-only; assignee-or-reporter;
browse-scoped; assignee-or-reporter with a permission) were all rejected.** The
answer is none of them: it is the fallback above, with the authority axis split
off entirely.

**AUTHORITY: two permission keys, because the two kinds differ in severity.**

| gate kind            | key                                      | rationale                                                                                       |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `design_result`      | the existing **`work_item:edit`**        | flips a subtask `done` inside Motir — reversible, in-product, exactly what edit already governs |
| `pull_request_merge` | a NEW **`work_item:merge_pull_request`** | writes a commit to the default branch on an external host — **irreversible, and outside Motir** |

The merge key **also joins `IRREVERSIBLE_PERMISSIONS`** (`lib/tokens/grant.ts`,
today `['work_item:delete']`), which `apiTokensService` filters out of what an
API token may confer — otherwise a minted PAT could merge to `main`. Both keys
enter the catalog as `enforcement: 'planned'` and are excluded from
`getRoleCatalog` until their call sites are wired.

**Why two rather than one, when the shipped acceptance gate asserts none.**
Inheriting `work_item:edit` for both would mean every `member` can merge to
`main`, with no way for a custom role to withhold it. Motir has unpicked exactly
this shape twice — `ai:view_plan` / `ai:decide_plan` (MOTIR-3188) and
`work_item:archive` / `work_item:delete` (MOTIR-3629) — and both times the fix
was a migration over a persisted `role_definition.permissions` value. Splitting
at the point the vocabulary is introduced costs one row in a frozen array.

**ROUTING and AUTHORITY are separate axes.** A gate appears in one person's tab;
a permission-holder who is neither assignee nor reporter may still decide it
from the item page, without it cluttering their queue. A reader who may see a
gate but not decide it sees its state and no control.

> ### §1 — AMENDMENT (MOTIR-7911, 2026-10-09, decided by MOTIR-7906): a `planning-session` gate — the SESSION is the subject, and it asks its owner to come back
>
> **Additive.** Nothing in §1's table is edited or struck; this records one more kind,
> decided by the planner-recorded decision MOTIR-7906 for Story MOTIR-7905
> (`agent-authored-plans.md` AMENDMENT 23's 2026-10-09 sub-amendment is its other half).
> The code is MOTIR-7913 and MOTIR-7917 through MOTIR-7921; this amendment ships none.
>
> 1. **The kind is `planning-session`, and its subject is a planning SESSION.** It follows
>    §11's `plan_approval` shape — a gate that belongs to a plan-side subject rather than to
>    a card — with the session in place of the plan.
> 2. **Two causes, one kind.** (a) The planner stopped with a WHAT question
>    (`returned-to-conversation`) and the answer is the person's; (b) the conversation is
>    waiting on the person's next turn and they left. The cause is recorded on the session
>    (`awaitingPersonCause`) and names the question in words.
> 3. **Routing is the session's OWNER, alone.** It is listed in Waiting on you for that
>    person and nobody else; there is no assignee/reporter fallback, because a session has
>    one owner.
> 4. **Raised on the event, cleared by the next turn or the end.** The gate is raised when a
>    hosted session enters either wait, and it clears when the person sends a turn or the
>    session ends — by a person's restart, a decline or an approve. A session in either wait
>    is spared by `closeIdleSessions` and `endSessionForAbandonedPlan`.
> 5. **There is no decide verb.** The only act the row offers is opening the planning overlay
>    at that session; answering is typing the next turn. No Approve, Decline or Request
>    changes is added by this kind.
> 6. **A failed session is NOT this kind.** A failed hosted attempt waits in the Workbench's
>    **To resume** tab, not in Waiting on you; it is a different wait on the same session
>    (never both at once).

> ### §2 — AMENDMENT (MOTIR-4911, 2026-09-08): AUTHORITY is a RELATIONSHIP or ADMIN, not two permission keys
>
> **ROUTING IS UNCHANGED, and the paragraphs above stand in full.**
> `assigneeId ?? reporterId`, exactly one recipient, and the recorded divergence
> from `homeService`'s union is still the right divergence for the reason it
> gives. Only the AUTHORITY half is amended.
>
> **What was WRONG.** The table above settles authority on **two permission
> keys** — `work_item:edit` for the design gate, a new
> `work_item:merge_pull_request` for the merge gate — and derives who may press
> from a ROLE. Yue settled it the other way on 2026-09-08:
>
> ~~| gate kind | key | rationale |~~
> ~~| `design_result` | the existing **`work_item:edit`** | … |~~
> ~~| `pull_request_merge` | a NEW **`work_item:merge_pull_request`** | … |~~
>
> **THE RULE IS: assignee OR reporter OR admin — for BOTH verbs, and an admin
> may approve and merge ANY work item.** Authority follows a RELATIONSHIP to the
> work item, with an org-wide override for admins; it does not follow a
> permission a role happens to carry. Three people may press a gate that is shown
> to one.
>
> | axis                                          | rule                                                                        |
> | --------------------------------------------- | --------------------------------------------------------------------------- |
> | **ROUTING** — whose Approvals tab it lands in | `assigneeId ?? reporterId` — exactly ONE recipient. **Unchanged**           |
> | **AUTHORITY** — who may press                 | **assignee OR reporter OR admin**, both verbs; an admin may act on ANY item |
>
> **A gate appears in ONE queue and can be pressed by THREE people, and that is
> coherent rather than sloppy** — because the two axes answer different
> questions. ROUTING answers _whose job is it to look?_, and a gate shown to two
> people is a decision neither owns, which is the whole argument the routing half
> already makes. AUTHORITY answers _may this press be honoured?_, and the failure
> it must prevent is the OPPOSITE one: a gate whose single recipient is on leave,
> has left the company, or was never the right person, with nobody able to
> unblock the work. **Widening authority costs the queue nothing** — a
> reporter or an admin who presses from the item page never sees the gate in
> their own tab — so the two can be tuned independently, and are.
>
> **The design gate keeps `work_item:edit` as its floor**; the relationship test
> is applied on top of it, not instead of it. What is retired is the ROLE-derived
> answer to who may merge.
>
> **`work_item:merge_pull_request` SURVIVES, and its only remaining job is to sit
> in `IRREVERSIBLE_PERMISSIONS`** (`lib/tokens/grant.ts`, today
> `['work_item:delete']`), which `apiTokensService` filters out of what an API
> token may confer. **So no API token can ever confer merge**, whatever grant it
> is minted with. The key is no longer how a PERSON is authorised — that is the
> relationship rule above — it is how a TOKEN is refused. It enters the catalog
> as `enforcement: 'planned'` and is excluded from `getRoleCatalog` exactly as
> §2 originally said.
>
> **What this costs, stated because §2's original argument was good.** The
> rejected split bought a custom role that could withhold merge from a `member`.
> The relationship rule cannot express that: every assignee and every reporter
> may merge their own item. **That is the accepted trade** — the merge is gated
> by a person pressing a button on an item that is already theirs, and a team
> that wants a narrower rule sets `prMergeMode` per project (§7) rather than
> per role.

> ### §2 — SECOND AMENDMENT (MOTIR-5192, 2026-09-11): the REPORTER may press only when there is NO ASSIGNEE
>
> **This REVERSES the reporter half of the amendment directly above.** That
> amendment is dated, reasoned and was right about the question it was answering;
> it stays in full, above, so a reader can see that authority was considered the
> other way round and why. What follows is the rule in force.
>
> **ROUTING IS STILL UNCHANGED.** `assigneeId ?? reporterId`, exactly one
> recipient, for the reason §2's original paragraphs give. Every amendment to
> this section so far has left routing alone, and this one does too.
>
> **THE RULE IS: the ASSIGNEE, or the REPORTER WHEN THE ITEM HAS NO ASSIGNEE, or
> an ADMIN.** The reporter arm becomes conditional on `assigneeId === null`.
>
> | axis                                          | rule                                                                                                    |
> | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
> | **ROUTING** — whose Approvals tab it lands in | `assigneeId ?? reporterId` — exactly ONE recipient. **Unchanged, again**                                |
> | **AUTHORITY** — who may press                 | **assignee, or reporter when there is no assignee, or admin**, both verbs; an admin may act on ANY item |
>
> **AUTHORITY NOW COLLAPSES ONTO THE ROUTING RULE for the relationship arms.**
> `assigneeId ?? reporterId` and _"the assignee, or the reporter when there is no
> assignee"_ are the same person, term for term. A gate is pressed by the person
> it is shown to, or by an admin. The two axes have not stopped being different
> questions — they part company at the admin override, and only there.
>
> **WHY, and it is a different failure from the one the first amendment
> optimised for.** An approval is a statement that somebody looked, and it means
> less when it is ambiguous who. With an assignee on the item and two people able
> to press, the decision belongs to neither in particular: either can sign off
> work the other was accountable for, and each can reasonably assume the other
> is the one being asked. Ownership is the whole question a gate exists to ask,
> and the routing rule already answers it — the amendment above then let two
> people answer it.
>
> **WHY THE ADMIN ARM IS A SUFFICIENT ESCAPE HATCH, stated rather than assumed —
> because the worry it is answering is a real one.** The 2026-09-08 amendment's
> stated reason was _"a gate whose single recipient is on leave, has left the
> company, or was never the right person, with nobody able to unblock the work."_
> That stall is still possible and still must be answerable. **It is now answered
> by an admin instead of by the reporter, and that is a better shape for an
> override, not merely an equivalent one:**
>
> - **It is VISIBLE.** Workspace owner/admin is a role in the permission grid. A
>   team can see who can unblock a stuck gate without reading a work item's
>   reporter column.
> - **It is GRANTABLE.** ⚠️ _False as written, and corrected on the record by the
>   THIRD amendment below (MOTIR-5292): a workspace role is not grantable in the
>   sense the permission model means._ A team that needs more unblockers grants the role; a
>   team that needs fewer does not. The reporter arm was un-tunable — it came
>   attached to whoever happened to file the item, which for an MCP-filed card is
>   an automation's account.
> - **It is AUDITABLE.** `decided_under_authority` records `admin`, and a reader
>   of that row can ask what that role was and who held it. `reporter` on an
>   assigned item recorded a relationship that answered no question anybody was
>   asking.
> - **It costs the queue nothing**, exactly as the first amendment's own argument
>   had it: an admin pressing from the item page never sees the gate in their own
>   tab.
>
> **WHAT THIS COSTS.** An unblock now needs an admin rather than anyone with a
> relationship to the item, so a small team with one admin has one unblocker. That
> is the accepted trade: the stall is rare, an admin is reachable, and the thing
> being bought — an approval that belongs to exactly one person — is paid for on
> every gate rather than on the rare one.
>
> **WHAT WOULD REVERSE THIS AGAIN.** Evidence that gates actually stall: a
> measurable population of `awaiting` gates whose routed recipient is inactive
> and whose project has no reachable admin. The instrument is the gate table's own
> `created_at` against `routed_to_id` — if such gates accumulate, the answer is to
> widen the ESCAPE HATCH (a project-scoped approver role, say), and **not** to
> re-widen the relationship arms, which is what makes ownership ambiguous. A
> narrower `prMergeMode` per project (§7) remains the per-team dial either way.
>
> **`decided_under_authority` IS UNCHANGED, and historical rows are NOT
> migrated.** The `reporter` member stays legal in the vocabulary — it simply
> becomes reachable only on an unassigned item. Rows that say `reporter` on an
> assigned item record what was true when the press happened, which is the entire
> reason §6a freezes the arm rather than re-deriving it; a migration over them
> would destroy the one thing the column exists to preserve.
>
> **THE FLOOR IS UNCHANGED.** The kind's permission key is still asserted first
> and independently, and the relationship test is applied on top of it. A project
> `viewer` who is the assignee is still refused, at the floor.

> ### §2 — THIRD AMENDMENT (MOTIR-5292, 2026-09-13): the escape hatch is a PERMISSION, `approval:decide_any` — not the workspace role
>
> **ROUTING IS UNCHANGED, and so are both relationship arms and their order.**
> This amendment touches only the third arm — WHO ELSE may press — and it
> corrects the second amendment's argument for that arm rather than reversing
> its rule.
>
> **What was WRONG.** The second amendment defended the admin arm as _GRANTABLE_:
> _"a team that needs more unblockers grants the role."_ The arm it shipped asked
> `isWorkspaceManager(workspaceRole)` — owner or admin of the WORKSPACE — and that
> is not grantable in the sense Motir's permission model means. A role in Motir
> only CARRIES permissions; no custom role could carry this, because there was no
> key. A team wanting its QA lead to unblock a stuck gate had one lever — making
> them a workspace admin, which hands over every project and every setting — and
> a user who is **Admin on the project itself** but a plain member of the
> workspace was refused. The check was also invisible to the role editor and to
> `tests/permissions/storyGate.test.ts`, because it was laundered through
> `projectAccessService.isWorkspaceManagerFor`, inside the one file that guard
> trusts to derive policy.
>
> **THE RULE IS: the ASSIGNEE, or the REPORTER WHEN THE ITEM HAS NO ASSIGNEE, or
> anyone holding `approval:decide_any` on the project.** It is the shape Motir
> already uses for acting on what is not yours — your OWN row by relationship,
> ANYONE's by an `_any` key (`attachment:delete_any`, `comment:moderate`) — and
> the reversal clause above had already named it: _"widen the ESCAPE HATCH (a
> project-scoped approver role, say)."_
>
> | who                                                | before                      | after                                                          |
> | -------------------------------------------------- | --------------------------- | -------------------------------------------------------------- |
> | workspace owner / admin                            | may decide any gate         | **unchanged** — the always-pass rail holds the key             |
> | project **Admin** (workspace `member`)             | refused                     | **may decide any gate** — the built-in Admin set holds the key |
> | a CUSTOM role granted the key                      | impossible — no key existed | **may decide any gate**                                        |
> | project Member / Viewer, implicit workspace member | refused                     | refused — none of those sets holds the key                     |
>
> **The widening to project Admins is the point, not a side effect**: they are
> the people a project already names as able to run it.
>
> **The key.** `approval:decide_any`, domain `approval` (the Approvals room's
> `approval:view_any`, MOTIR-5305, joins it), `enforcement: 'enforced'` in the
> same change that consults it, in `ROLE_GATED_PERMISSIONS` and so in the built-in
> Admin set, and in neither `member`, `viewer` nor
> `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS`. `levelGrants` gives it the default arm,
> so on a `private` project it still requires a project membership. It is
> **UNGRANTABLE to an API token by derivation** (`lib/tokens/grant.ts`): the
> decide route is session-authed and no MCP tool or `/api/v1` operation asserts
> the key, and §6a's rule that a decision names a PERSON is exactly why none
> should.
>
> **`decided_under_authority` — the vocabulary is KEPT, and its meaning is
> restated.** The `admin` member now means **decided under
> `approval:decide_any`**. No member is added. Every row that already says
> `admin` was written by a workspace owner/admin, who holds the key, so no
> historical row becomes false and nothing is migrated — the same treatment
> `reporter` got in the second amendment. A second member would have given one
> authority two names, split by the date of this amendment, and every reader of
> the column would have had to know that date.
>
> **Asked, never derived.** `approvalGatesService.resolveGateAuthority` asks
> `projectAccessService.getPermissions` for the key. `isWorkspaceManagerFor` is
> deleted, and `tests/permissions/storyGate.test.ts` now refuses the access
> service handing a bare role predicate back to a caller — the laundering path
> this defect used.
>
> **What would reverse this.** Nothing in the second amendment's reversal
> evidence changes: a population of stalled gates is answered by granting the key
> more widely, which is now possible, and never by re-widening the relationship
> arms.

### 3. What approving a DESIGN result does — DECIDED BY THE PLANNER (rung 3: the story's own stated intent)

**Approve** records the decision, performs §6c's pin, and transitions the design
subtask into the project's `done` category — which is what unblocks the cards
`blocked_by` it. It goes through `workItemsService.applyStatusTransition`, the
one shipped status funnel, rather than writing `work_item.status` directly, so
it inherits the `completedAt` stamp and every existing guard.

**Request changes** records the decision and moves nothing. **It re-dispatches
nothing** — the revise loop is Story 9.2's (§5).

> **⚠️ AMENDED BY §10 (MOTIR-6072, 2026-09-23).** Request changes on a design
> now carries a REQUIRED reason and a VERDICT: **Revise** returns the design card
> to To do through a gate-owned system write, and **Re-plan** opens the planner
> and moves nothing. _Moves nothing_ above is therefore true only of Re-plan.
> _It re-dispatches nothing_ still holds: the next run is whichever picks the card
> up, and making it automatic is still 9.2's (§10g).
>
> **Amended for `design_result` by [`design-refusal-verdict.md`](design-refusal-verdict.md) (MOTIR-6419).**

> ### §3 — AMENDMENT (MOTIR-4911, 2026-09-08): approval writes `done` ONLY when nothing will ever merge
>
> **What was WRONG, and it is the clause that produced the confusion this whole
> amendment exists to end.** The paragraph above says approve _"transitions the
> design subtask into the project's `done` category"_ — unconditionally:
>
> ~~**Approve** records the decision, performs §6c's pin, and transitions the
> design subtask into the project's `done` category — which is what unblocks the
> cards `blocked_by` it.~~
>
> **The shipped status sync says the MERGE writes `done`.** Both cannot be the
> single writer, and §4 four paragraphs below states the invariant in its own
> words — _"there is **one status writer, not two**"_. So the record contradicted
> itself, and _"approved but still `in_review`"_ is what that collision looks
> like from the board.
>
> **THE CORRECTION — approval is a TRIGGER, not a status write, and the
> discriminator decides what it triggers:**
>
> | the work item has …             | approve does                                                                              |
> | ------------------------------- | ----------------------------------------------------------------------------------------- |
> | **no linked OPEN pull request** | record the decision, perform §6c's pin, and write **`done`** — approval is TERMINAL       |
> | **a linked OPEN pull request**  | record the decision, perform §6c's pin, and write **`approved`**; the MERGE writes `done` |
>
> **Nothing else changes.** It still goes through
> `workItemsService.applyStatusTransition`, the one shipped status funnel, rather
> than writing `work_item.status` directly, so it inherits the `completedAt`
> stamp and every existing guard — and **Request changes** still records the
> decision and moves nothing.
>
> **The invariant is PRESERVED, not weakened: there is still exactly one writer
> of `done`.** In the first row nothing will ever merge, so nothing else would
> write it. In the second the merge writes it, and approval stops one status
> short. §8 is the discriminator and both workflows in full; §6b is the
> `approved` status it writes.

### 4. What approving a MERGE does — DECIDED BY THE PLANNER (rung 2: the shipped provider seam)

**Approve merges the pull request on the host**, through the `GitProvider` seam.

- **The seam gains `mergeChangeRequest`**, returning a normalised success or a
  typed refusal. **It is not a direct GitHub call.** GitLab is a shipped,
  registered second provider (Story 7.23 / MOTIR-1474) whose merge requests
  already drive the same status machine; a GitHub-only merge would give every
  GitLab-backed card a gate that renders, routes to a person and can never be
  satisfied. GitLab's own implementation is Epic MOTIR-4608's (MOTIR-4883).
- **The App is chosen by repository PROVENANCE** — a Motir-HOSTED repository
  mints through `motir-studio`, which already holds `contents: write`; an
  IMPORTED repository mints through `motir-integration`, which needs MOTIR-4787's
  bump. The choice is read from the repository row, never defaulted.
- **The gate does NOT write the card's status.** The card advances on the
  resulting webhook, exactly as when a person merges by hand, so there is **one
  status writer, not two**.
- **Every refusal renders in the control rather than being thrown** — checks not
  green, merge conflict, protected branch, no linked pull request, the App
  lacking permission, and a gate somebody else decided while the row was on
  screen.

**Merging for real is the point, and it costs a permission and a re-consent.**
An approval that does not merge is a note, not a gate.

> **§4 · POINTER (MOTIR-6815, 2026-09-29).** With the review agent on, nothing
> in this section runs until the delivery set's `agent_review` has passed or
> been overridden at the current version: no merge gate is asked before it,
> and a primary's carried merge waits for it too (§12.2, §12.4). The review
> agent cannot be on in an `auto` project (§12.2a), so no auto-merge ever waits
> on it. What approving a merge DOES is unchanged.

> ### §4 — AMENDMENT (MOTIR-4911, 2026-09-08): the gate writes `approved`, and still does not write `done`
>
> **Everything above stands except one bullet, and it is falsified in a narrow
> way that matters.** The seam, the provider argument, the App-by-provenance
> rule and the render-every-refusal rule are all unchanged.
>
> ~~**The gate does NOT write the card's status.** The card advances on the
> resulting webhook, exactly as when a person merges by hand, so there is **one
> status writer, not two**.~~
>
> **The gate DOES write a status — `approved` — and it does NOT write `done`.**
> The sentence conflated the two, and correcting it is what makes §3's amendment
> and §8's Workflow B expressible at all: a person pressing Approve is an EVENT
> the board has to be able to show, and before `approved` existed there was no
> status for it to land in.
>
> **The invariant the struck sentence was protecting is intact and is now stated
> exactly:** `done` has **one writer**, the merge webhook. `approved` has one
> writer too, the decision. Two statuses, two writers, no contention — which is
> strictly stronger than the original claim, because it also says who writes the
> intermediate state instead of leaving it unwritten.
>
> ~~**Approving in GITHUB decides only the FIRST gate.** A GitHub review approval
> syncs `pull_request_approval` and leaves `pull_request_merge` `awaiting`; the
> card reaches `approved` either way, and somebody still presses merge. §8's
> Workflow B row 4b is why there are two gates rather than one.~~
>
> **⚠️ STRUCK by §8's SECOND AMENDMENT (MOTIR-5609, 2026-09-16).** There is no
> second gate for a GitHub approval to leave behind. What a synced approval does
> under one gate is MOTIR-4910's, recorded by MOTIR-5590.

> ### §4 — SECOND AMENDMENT (MOTIR-5510, 2026-09-14): the MERGE gate's contract — one per pull request, raised on green, merged or enqueued OUTSIDE the decision, and its outcome recorded on the PULL REQUEST
>
> **What was OPEN.** §4 decides the seam, the App-by-provenance rule and that
> every refusal renders; §8 row 3 says the gates are raised on green and row 5
> says _merge — or ENQUEUE_. Nothing here said what one merge gate is ABOUT on a
> card with several pull requests, when it goes away, how an Approve that must
> call a host is recorded by a door that runs in one transaction, or what an
> automatic merge leaves behind. Story MOTIR-4882's children build against those
> answers, so they are written down once, here. **Everything above in §4 stands**;
> this block adds to it and supersedes one earlier card's wording (decision 2).
>
> **Read at base `cc09db183`.** Written to merge in EITHER order with
> MOTIR-5479's amendment for the approve-and-merge gate: this block touches no
> line that one edits (§8 row 4a), and its decisions 4 and 5 are the merge gate's
> side of 5479's decision 5 — merge, or enqueue where the repository has a queue;
> each merge gate decided only on success, with `outcomeRef: null`; the merge
> commit or queue entry on the pull request; a refused one stays `awaiting`.
>
> **1. SUBJECT — one gate per pull request** (rung 2: the shipped uniqueness
> key). `subjectId` is the `github_pull_request` row id and `subjectVersion` is
> `owner/name#number@headSha`. The gate hangs on the **run target** — the work
> item the delivering run was launched against, as
> `howToTestService.getForWorkItem` resolves it (`runTarget`). The partial unique
> index `approval_gate_one_awaiting_per_subject` over
> `(work_item_id, kind, subject_id) WHERE state = 'awaiting'`
> (`prisma/migrations/20260908210000_add_approval_gate/migration.sql:91-93`)
> already allows exactly this, and §6b states why: a card carrying several open
> pull requests legitimately has several simultaneous awaiting merge gates. This
> narrows §1's amendment row _"**any** card **with a pull request**"_ to the run
> target; a child the same pull requests also deliver gets no merge gate of its own.
>
> **2. RAISED on the all-green verdict, and only there** (rung 2: §8 row 3, and
> §7's amendment point 4). The raise takes §8 row 3's verdict and moment — the
> run target's delivery set turning green, as `lib/services/ciPromotion.ts`
> judges it (`everyDeliveryIsGreen`) — and fires only when the project's
> `prMergeMode` is `manual` and only for a provider that can merge (decision 11).
> **A merge gate is never raised on a pull request whose checks are not green, in
> either mode**: only a green pull request is a merge candidate (§7 amendment
> point 4). **This supersedes, by quotation, the wording MOTIR-4793 carried before
> plan `cmu1iamkg009rhutxld323mnw` re-scoped it** — that its gate is _"created
> when a pull request is LINKED"_. A link is not a verdict; a gate raised on it
> would ask a person to merge code CI has not judged.
>
> **3. WITHDRAWN** (rung 2: §6b's `superseded`, written by the product). An
> awaiting merge gate is set `superseded` when its pull request's head moves, when
> the pull request closes, or when its delivery row leaves the run target. It
> writes `state` and nothing else, exactly as the design publish path does (§6b
> SHIPPED). The next all-green verdict raises a fresh gate against the new head.
>
> **4. APPROVE IS EXECUTED OUTSIDE THE DECIDE TRANSACTION, and its OUTCOME is
> recorded on the PULL REQUEST, not on the gate** (rung 2: the shipped decide
> door). `approvalGatesService.decide` is one transaction with no post-commit
> hook — its own doc comment says _"a failing effect still discards the
> decision"_ — so it cannot call a host and survive the call failing. The merge
> entry point therefore runs:
>
> - **(a) check** — read the gate; it is `awaiting`, the actor holds §2's
>   authority, and the pull request still matches `subjectVersion`, is open, and
>   is still delivered. A mismatch SUPERSEDES that gate (decision 3) and returns
>   the shipped `APPROVAL_GATE_SUPERSEDED`;
> - **(b) call the seam** — merge or enqueue, outside any transaction;
> - **(c) on `merged` or `enqueued`** — call `decide` normally. The handler writes
>   no status, so the gate's **`outcomeRef` is `null`**; then record
>   `merge_authority = 'gate'` and `merge_outcome_ref` (the merge commit SHA, or
>   `queue:<entryId>`) on the pull request;
> - **(d) on a refusal** — write NOTHING. The gate stays `awaiting` and decidable.
>
> **Why not `outcomeRef`.** `outcome_ref` is written as `effect.statusWritten`
> (`lib/services/approvalGatesService.ts:909`), and the item page applies it as a
> status KEY — `OptimisticStatusProvider.tsx`, and
> `DesignResultSection.tsx:168`'s `applyOptimisticStatus(result.gate.outcomeRef)`.
> A merge SHA there would be painted onto the card as a status.
>
> **The race.** Two people press at once and one merges. The other's seam call
> returns `MERGE_ALREADY_MERGED`, or its `decide` loses to the partial index or to
> `APPROVAL_GATE_ALREADY_DECIDED`. Neither is a 500.
>
> **The stamp.** When MOTIR-5234's stamp is required on `decide`, the entry point
> carries it through from its caller, and its `APPROVAL_GATE_STALE_SUBJECT` is
> checked after (a)'s supersede check, never instead of it.
>
> **5. THE MERGE METHOD is the repository's, never hard-coded** (rung 2: the host
> setting). It is read from the repository's own settings, first allowed wins:
> `allow_squash_merge` → `allow_merge_commit` → `allow_rebase_merge`.
>
> **6. THE QUEUE** (rung 2: GitHub's documented API; the permission is a
> HYPOTHESIS). A base branch whose active rules include `merge_queue` is detected
> with `GET /repos/{owner}/{repo}/rules/branches/{branch}`, which GitHub lists
> under _Repository permissions for Metadata_ (read) on its _Permissions required
> for GitHub Apps_ page — so no App needs anything new to ASK. Such a pull request
> is enqueued with the GraphQL mutation `enqueuePullRequest`, passing
> `expectedHeadOid` so a moved head cannot be enqueued. A `405` from the merge
> call reading _"must be merged through the merge queue"_ also routes to enqueue.
> An enqueued pull request leaves the card where it is: `done` still arrives only
> through the merge webhook, when the queue lands it. **The enqueue is expected to
> need `pull_requests: write` — recorded as a hypothesis, not a reading**, to be
> confirmed by the first real enqueue. `motir-studio` holds no `pull_requests`
> permission, so a HOSTED repository could not be enqueued today; MOTIR-4161
> carries that consequence.
>
> **7. THE APP** (rung 2: the shipped provenance helper). The role is
> `'provisioning'` (`motir-studio`) when
> `isMotirHostedOwner(repo.owner, provisioningOrgLogin())`
> (`lib/git/hostOwnership.ts:43`, `lib/ciMetering/config.ts:33`) holds, and
> `'user-facing'` (`motir-integration`) otherwise — including when the host owner
> is `null`. The two grants, as read in
> `docs/decisions/unlinked-pull-request-check.md:30-31` after its 2026-09-14
> amendment:
>
> | App                 | what matters here                                                                                       |
> | ------------------- | ------------------------------------------------------------------------------------------------------- |
> | `motir-integration` | `contents: write` (MOTIR-4787) · `pull_requests: write` · `metadata: read` — merges an imported repo    |
> | `motir-studio`      | `contents: write` · `metadata: read` · **no `pull_requests`** — merges a hosted repo, cannot enqueue it |
>
> The merge itself needs `contents: write`: GitHub lists
> `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` under _Repository
> permissions for Contents_ (write).
>
> **8. THE REFUSAL UNION — FIVE new members** (rung 2: `lib/approvalGates/refusals.ts`,
> which mirrors the server's tag and forbids a second vocabulary):
>
> | member                         | the host's answer                                                                          |
> | ------------------------------ | ------------------------------------------------------------------------------------------ |
> | `MERGE_CHECKS_NOT_GREEN`       | `405` — not mergeable while required checks are pending or failing                         |
> | `MERGE_CONFLICT`               | `mergeable_state: dirty`                                                                   |
> | `MERGE_BRANCH_PROTECTED`       | `405` — a required review or rule is not satisfied                                         |
> | `MERGE_ALREADY_MERGED`         | the pull request is already merged                                                         |
> | `MERGE_APP_PERMISSION_MISSING` | `403`, or GraphQL `FORBIDDEN` — naming the permission from `X-Accepted-GitHub-Permissions` |
>
> **A changed subject is NOT a sixth member.** A moved head (`409`, which GitHub
> documents as _"sha was provided and pull request head did not match"_), a closed
> pull request or a lost link SUPERSEDES the gate and returns
> `APPROVAL_GATE_SUPERSEDED`; a gate somebody else decided is
> `APPROVAL_GATE_ALREADY_DECIDED`; MOTIR-5234's `APPROVAL_GATE_STALE_SUBJECT` is
> its own. A second name for any of these is exactly the second vocabulary
> `refusals.ts`'s header forbids. (§4's original list above — _"no linked pull
> request"_ and _"a gate somebody else decided"_ — maps onto those two shipped
> members rather than onto new ones.)
>
> **9. AUTO MODE, and §7a's authority record made concrete** (rung 3: §7a's own
> reading, still the planner's). On the same green verdict, in an `auto` project,
> **no gate is raised**; Motir merges or enqueues each pull request after commit,
> through the same seam. The pull request records `merge_authority = 'auto_mode'`
> and `merge_outcome_ref`. **§7a's _"the `work_item_delivery` / pull-request row"_
> is settled as the pull request**: the columns are
> `github_pull_request.merge_authority` (`gate` | `auto_mode`) and
> `merge_outcome_ref`, written only when Motir merges or enqueues — a hand merge on
> the host leaves both `null`, which is the honest answer. A refused automatic
> merge writes no record: it posts ONE comment on the run target naming the pull
> request, the refusal and its next action, and is not retried for the same head
> SHA.
>
> **10. THE PERMISSION KEY** (rung 2: §1's handler table). `work_item:merge_pull_request`
> is the permission §1 names for this kind, and it does not exist yet —
> `git grep -n "merge_pull_request" cc09db183 -- lib prisma` returns no hits (exit
> 1). It is added to `lib/permissions/catalog.ts`, granted to every built-in role
> that holds `work_item:edit`.
>
> **11. CAPABILITY** (rung 2: the seam's own convention). Merging is declared by the
> optional `mergeChangeRequest?` method and a `providerSupportsMerge` helper, the
> way `resolveRepoTarballUrl?` (`lib/git/provider.ts:161`) declares its capability
> today. MOTIR-4610 replaces capability-by-optional-method with a declared set, and
> this helper is one of the sites it converts.
>
> **Not decided here:** §8 row 4a (MOTIR-5479's), how a GitHub review maps onto
> gates (MOTIR-4910), and whether a provisioned repository gets a queue at all
> (MOTIR-4161). What a queue EJECTION does to the card is decided by §4's THIRD
> AMENDMENT, directly below.

> ### §4 — THIRD AMENDMENT (MOTIR-5629, 2026-09-16): a merge-queue EJECTION — the reason map, the exit recorded on the pull request, the card's ONE decided gate stands, _Queue again_ while the heads are unchanged, and a push re-arms
>
> **What was OPEN.** Decision 6 above enqueues a pull request, and §8's second
> amendment makes approving the card's ONE `pull_request_approval` gate merge or
> enqueue every member. Nothing said what happens when the queue then REMOVES a
> member: to the card, to the approval a person already gave, to the pull
> request's _Queued to merge_ record, and to the card's other members. Story
> MOTIR-5461's children build against these answers. **Everything above in §4,
> and §8's second and third amendments, stands. No path this amendment
> describes raises a gate per pull request, and no path raises a second
> `pull_request_approval` over commits a person already approved.**
>
> **Read at base `58bb046d0`.** The evidence is MOTIR-5627's capture, attached to
> that card as `mq-deliveries-cla-hook-2026-09-13.json.txt` with its findings in
> the card's comments: 963 real deliveries to a repository hook on
> `moooon-B-V/motir-core` (2026-09-13 12:32 → 2026-09-16 12:31), read back with
> `gh api repos/moooon-B-V/motir-core/hooks/<id>/deliveries/<delivery-id>`.
>
> **1. THE EVENT** (rung 2: the capture). The signal is the `pull_request`
> event, action **`dequeued`**. Motir's App (`motir-integration`) already
> subscribes to `pull_request`, so no grant is needed to HEAR an ejection. The
> payload carries `number`, `pull_request` (head SHA included) and `reason`, and
> **nothing about the merge group or the check that failed.** It is normalised
> through the `GitProvider` seam as an OPTIONAL capability, the way
> `parseWorkflowRunEvent?` (`lib/git/provider.ts:362`) is. GitLab merge trains are
> MOTIR-4608's.
>
> **2. THE REASON MAP — closed and total** (rung 2: the capture; rung 1: the
> published webhook schema). **A delivery spells the reason in the webhook
> schema's UPPER_SNAKE enum, not in the GraphQL timeline's lowercase one.**
> Counted over 110 real `dequeued` deliveries: `MERGE` 88, `CI_FAILURE` 15,
> `MANUAL` 4, `MERGE_CONFLICT` 3. The timeline's `failed_checks` / `merged` /
> `checks_timed_out` never appear in a delivery. A successful merge is `MERGE`,
> not `merged`. The match is EXACT; nothing is case-folded.
>
> | `reason` (exact)         | seen in a delivery | disposition | why                                                                                             |
> | ------------------------ | ------------------ | ----------- | ----------------------------------------------------------------------------------------------- |
> | `CI_FAILURE`             | yes (15)           | failure     | the queue's checks failed on the merge group                                                    |
> | `CI_TIMEOUT`             | no — schema        | failure     | the checks did not finish; GitHub lists a timeout as a removal cause beside failures            |
> | `MERGE_CONFLICT`         | yes (3)            | failure     | the pull request does not combine with what is ahead of it; the work needs a change             |
> | `INVALID_MERGE_COMMIT`   | no — schema        | failure     | the queue could not build a merge commit for it                                                 |
> | `GIT_TREE_INVALID`       | no — schema        | failure     | the queue could not build a tree for it                                                         |
> | `BRANCH_PROTECTIONS`     | no — schema        | failure     | GitHub: _"branch protection failure that could not automatically be resolved"_ — it cannot land |
> | `MANUAL`                 | yes (4)            | neutral     | somebody took it out on purpose; nothing is said about the work                                 |
> | `QUEUE_CLEARED`          | no — schema        | neutral     | the queue was reset                                                                             |
> | `ROLL_BACK`              | no — schema        | neutral     | removed for a roll-back, not for its own content                                                |
> | `UNKNOWN_REMOVAL_REASON` | no — schema        | neutral     | GitHub itself does not know; a card never moves on an unknown                                   |
> | `MERGE`                  | yes (88)           | landed      | it merged                                                                                       |
> | `ALREADY_MERGED`         | no — schema        | landed      | it was merged already                                                                           |
> | **any other string**     | —                  | neutral     | recorded raw and logged once, so a new spelling is visible and moves no card                    |
>
> The three schema-only failure rows are decided as failures because in each
> the queue could not produce a mergeable result for that pull request as it
> stands, which is what `implemented` says (MOTIR-3685: committed code whose
> build has not passed).
>
> **3. WHAT A REMOVAL RECORDS, AND WHAT A FAILURE DOES** (rung 2: §4 decision 4
> and §8's second amendment, decision 4 — the outcome lives on the PULL
> REQUEST).
>
> - **Every non-landed removal writes ONE queue-EXIT ROW** on the pull request:
>   the raw reason, its disposition, the head SHA it left at, the time, the
>   delivery GUID (decision 9), and a nullable `requeuedAt` (decision 5). Rows
>   accumulate; the latest is the pull request's current exit. The failing
>   check's name and link are added by decision 8.
> - **A `queue:` `merge_outcome_ref` is CLEARED**, and only a `queue:` one, so the
>   pull request stops reading _Queued to merge_. `merge_authority` stays: it
>   still says who asked for the enqueue.
> - **On a failure, every card the pull request DELIVERS moves to
>   `implemented`** — from `approved` in a `manual` project, from `in_review` in
>   an `auto` one — through `applyStatusTransition` as a SYSTEM write. A
>   delivered card at any other status (somebody moved it) is left alone and
>   named in the handler's result. §6d rule 6 does not fire, because it is scoped
>   to a person's move, and there is no awaiting gate to withdraw anyway.
> - **The card's OTHER members still in the queue are left there.** They were
>   approved at their own heads, and those heads have not moved.
> - **All of it is ONE transaction**, and nothing external is called. A failure
>   inside it answers non-2xx; GitHub does not retry by itself, so recovery is a
>   hand redelivery, which decision 9 makes safe.
>
> **4. NEUTRAL AND LANDED.** A neutral removal writes the row, clears the ref,
> and moves no card; the pull request is put back by _Queue again_. A landed
> removal writes nothing and moves nothing: the merge webhook already owns
> `done` (§4 amendment).
>
> **⚠️ SUPERSEDED by the FOURTH AMENDMENT below (MOTIR-5800, 2026-09-19)** for
> EVERY un-landed removal in a `manual` project, NEUTRAL included: the merge
> question is asked again on ONE fresh gate (or, for a `MERGE_CONFLICT`, the card
> drops to `implemented` and no gate is raised), and _Queue again_ DECIDES that
> gate rather than reusing the spent approval. It still holds for `auto` mode.
> Kept visible as the record.
>
> ~~**5. THE CARD'S ONE DECIDED GATE STANDS, AND _QUEUE AGAIN_ REUSES IT WHILE THE
> HEADS ARE UNCHANGED**~~ (rung 1: GitHub; rung 3: MOTIR-5603's record).
>
> - **An ejection neither supersedes nor re-opens the decided
>   `pull_request_approval` gate.** A decided gate is a record (§6a), and the
>   trigger `trg_approval_gate_decided_immutable` refuses to edit it anyway.
> - **While a member's head still equals its entry in the gate's
>   `subjectVersion`, the approval still describes that code.** GitHub agrees:
>   its documented removal causes do not touch a review, and an approval is
>   dismissed only when new commits change the diff, and only where the branch
>   rule _Dismiss stale pull request approvals when new commits are pushed_ is on
>   (_About protected branches_, and _Managing a merge queue_, read 2026-09-16).
>   Asking again for the same commits is _"the same person answering the same
>   question twice"_, which MOTIR-5603 retired.
> - **_Queue again_ in a `manual` project is the shipped per-member RETRY**
>   (`pullRequestMergeService.retryApproveAndMergeMember`, MOTIR-5613), addressed
>   by (the card's approved gate, the pull request), extended to accept an
>   exited member whose latest exit is not yet re-queued. Under the card's row
>   lock it re-runs merge-or-enqueue, records the outcome
>   (`recordMotirMerge`), stamps the exit row's `requeuedAt`, and, if a failure
>   had moved the card, writes `implemented → approved` carrying
>   `decidingGateId` = that gate. **It decides nothing and raises nothing.** A
>   moved head is refused by the retry's shipped head check.
> - **_Queue again_ in an `auto` project** has no gate to reuse, so it is a
>   person's press on (the card, the pull request): the same permission floor as
>   the press (`work_item:edit`), an unchanged head, and an un-re-queued exit. It
>   re-dispatches `pull-request/auto-merge.requested` with an idempotency key
>   that includes the exit row's id, because the shipped key is `prId:headSha`
>   (`lib/services/ciPromotion.ts`, `dispatchAutoMerges`) and would otherwise
>   refuse the same head for ever. It stamps `requeuedAt` and returns the card
>   `implemented → in_review`, the status the failure moved it from.
>   `merge_authority` stays `auto_mode`.
> - **Two presses on one exit enqueue once.** The card's row lock plus a
>   `requeuedAt IS NULL` predicate decide it; the loser gets a named refusal.
>
> **⚠️ SUPERSEDED by the FOURTH AMENDMENT below (MOTIR-5800, 2026-09-19)** in its
> first half: a manual RETRYABLE or SETTING outcome now moves the card to
> `in_review` and DOES raise ONE fresh gate over the same commits, computed from
> the standing outcome rather than from the promotion. For a CAN'T-LAND outcome
> the promotion hold below is exactly what the amendment keeps, and the push
> re-arm is unchanged. Kept visible as the record.
>
> ~~**6. NO SECOND GATE OVER THE SAME COMMITS, AND A PUSH RE-ARMS**~~ (rung 2: the
> shipped promotion). **This is the rule the story turns on, because the shipped
> latch would otherwise break decision 5 by itself.** After a failure exit the
> card is `implemented` while its members' OWN checks are still green: only the
> queue's merge commit failed. Two shipped paths would promote it straight back:
>
> - `workItemsService.latchCiGreen` runs `promoteIfCiAlreadyGreen` whenever a card
>   ARRIVES at `implemented`, which includes the ejection's own write; and
> - `promoteDeliveredCardsOnGreen` promotes on the next green check event at that
>   head.
>
> Either promotion calls `raisePullRequestApprovalGate`, which checks only for an
> `awaiting` gate, so it would raise a second gate over the commits the decided
> gate already covers. **So the promotion HOLDS a card while any delivered
> member has an un-re-queued FAILURE exit at its CURRENT head**, in both edges,
> read in the transaction the promotion already opens. The hold lifts in exactly
> two ways:
>
> - **a push** moves that member's head, the exit is no longer at the current
>   head, and the next green verdict promotes the card to `in_review` through the
>   shipped path, which raises **ONE fresh awaiting gate** over the new heads
>   (§8's amendment, decisions 3 and 4; the partial unique index is on `awaiting`
>   only). Nothing new raises a gate;
> - **_Queue again_** stamps the exit, and moves the card itself (decision 5).
>
> **And the raise itself never asks about commits a person already approved.**
> `REVIEW_STATUSES` includes `approved`, so a late green check on an `approved`
> card whose member is still queued reached `raisePullRequestApprovalGate`, which
> found no `awaiting` gate and raised a second one over the approved commits —
> MOTIR-5632 reproduced it before fixing it. The raise now refuses when the card's
> latest gate of this kind is `approved` with the SAME `subjectVersion`. A push
> changes the version, so the re-arm above is untouched. (Refusing queued members
> as merge candidates was the alternative, and it was rejected: a card with one
> member re-pushed and another still queued would then never be asked again.)
>
> **⚠️ SUPERSEDED by the FOURTH AMENDMENT below (MOTIR-5800, 2026-09-19)** at its
> second bullet: `implemented → approved` is REMOVED and `approved → in_review`
> is DECLARED. The first and third bullets stand. Kept visible as the record.
>
> ~~**7. THE WORKFLOW EDGES**~~ (rung 2: `DEFAULT_TRANSITIONS`, which carries 33
> edges at this base).
>
> - `approved → implemented` and `in_review → implemented` are declared
>   defaults: a person in an `auto` project may make the same move by hand, and
>   the workflow editor must show the real lifecycle even though the ejection's
>   own write is a system write.
> - `implemented → approved` is declared for _Queue again_. **It was
>   deliberately ABSENT** (`lib/workflows/defaultWorkflow.ts`, the `approved`
>   block): an undeclared hop kept a card from skipping CI. The protection
>   survives where there is a build to skip: the product's only writer is
>   _Queue again_, which carries a decided gate whose `subjectVersion` names
>   heads CI already judged green, and a HAND move into `approved` while an open
>   pull request delivers the card is still refused by §6d rule 2b. A card with
>   no open pull request may now be moved there by hand; it has no build to
>   skip. The tests asserting the absence are rewritten to assert rule 2b,
>   citing this decision.
> - Existing default-workflow projects are backfilled by a KEY join with a
>   `NOT EXISTS` guard, the pattern of
>   `prisma/migrations/20260911140000_add_approved_default_status/migration.sql`.
>   A project missing any of the three keys gets nothing, which leaves a custom
>   workflow alone.
>
> **8. THE FAILING CHECK — the `merge_group` event, which needs a grant**
> (rung 2: the capture). Two candidates were open; the capture settles it:
>
> - **REJECTED — a `check_run` delivery's `check_suite.head_branch`.** Over REST a
>   failed merge-group check run reads `pull_requests: []` and
>   `check_suite.head_branch: null`, and no webhook sample of it was captured.
>   Nothing verified says a delivery names the queue branch.
> - **CHOSEN — the `merge_group` event.** 126 `checks_requested` and 129
>   `destroyed` deliveries were captured. Each carries
>   `merge_group.head_sha` and `merge_group.head_ref` =
>   `refs/heads/gh-readonly-queue/<base>/pr-<N>-<base_sha>`; `destroyed` also
>   carries a lowercase `reason` (`merged` 88, `invalidated` 24, `dequeued` 17).
>   Every `CI_FAILURE` `dequeued` pairs with a `destroyed`/`dequeued` for the same
>   `pr-<N>`, delivered about 0.3 s EARLIER; a `MERGE_CONFLICT` removal, and some
>   `MANUAL` ones, have no merge group at all, and so no failing check.
>
> So Motir records a QUEUE ATTEMPT at `checks_requested` (the merge group's
> `head_sha` and the pull request number(s) parsed from `head_ref`), before any of
> its checks can complete. A failed `check_run` whose `head_sha` is a known
> attempt writes its `name` and `html_url` onto that attempt (the first failure
> to complete wins), and the failure exit row takes its failing check from the
> pull request's latest attempt. Because the attempt exists first, a check that
> completes before the `dequeued` delivery is not lost. **A queue check NEVER
> writes `github_check_run`**: that table is the pull request's own CI state at
> its head (`derivePrCiState`), and a red row there would stop decision 6's
> re-arm. **A named step with its own owner:** the App needs the `merge_group`
> event and the _Merge queues_ (read) permission — MOTIR-5638, a person's card
> in the App settings. Until an installation has accepted it, an exit row's
> failing check is null and the surface says the check is unknown; nothing
> else degrades.
>
> **9. IDEMPOTENCY — the delivery GUID** (rung 2: the capture). There is no
> delivery-id table today, and `app/api/github/webhook/route.ts` reads
> `x-hub-signature-256` and `x-github-event` but not `X-GitHub-Delivery`. **The
> key is that header, UNIQUE on the exit row.** MOTIR-5627 redelivered a
> delivery and read both rows back: a new delivery id
> (`3843060808573517824`, `redelivery: true`) with the SAME GUID as the
> original (`3843059981840547840`, `redelivery: false`) —
> `0e648c86-b1d0-11f1-8f8e-188ebfa2d67b`, in the list and in the request header
> alike. So a hand-redelivered old exit is a no-op, even after _Queue again_,
> while a genuine second exit at the same head, which is a new event, acts.
> **A `(head, reason)` key is REJECTED on the record**: the capture shows one
> head ejected four times (pull request #2877 at `1a74b77`: `CI_FAILURE`,
> `CI_FAILURE`, `MANUAL`, `CI_FAILURE`), each by a different merge group, and
> such a key would collapse them. No fallback is needed, because the GUID is
> repeated.
>
> **10. DELIBERATELY NOT DECIDED HERE.** The card BADGE and the `motir fix`
> claim for an ejected card (MOTIR-5628); any notification; GitLab merge trains
> (MOTIR-4608).
>
> **Which card builds which decision:**
>
> | decisions    | card                                                        |
> | ------------ | ----------------------------------------------------------- |
> | 1–4, 6 and 9 | MOTIR-5632 — the ejection arm and the two promotion guards  |
> | 5            | MOTIR-5634 — _Queue again_, in both modes                   |
> | 7            | MOTIR-5630 — the edges and their backfill                   |
> | 8            | MOTIR-5633 — the failing check · MOTIR-5638 — the App grant |
> | the surface  | MOTIR-5631 — the design delta · MOTIR-5635 — the frame      |

> ### §4 — FOURTH AMENDMENT (MOTIR-5800, 2026-09-19): ONE APPROVAL = ONE MERGE/ENQUEUE ACTION — every un-landed outcome is classed by REASON, retryable and setting-blocked re-ask at `in_review` with ONE fresh gate, a conflict drops to `implemented` HELD, _Retry merge_ / _Queue again_ ARE the new approval, and `implemented → approved` leaves the workflow
>
> **DECIDED BY THE REQUESTER (Yue, 2026-09-19)**, first answering MOTIR-5144's
> open criterion and then widening it at the design review of MOTIR-5801. Their
> words:
>
> - _"every merge/requeue needs to be approved again, one approval for one
>   merge/enqueue action"_
> - _"retry merge is needed too, retry merge can be on the work item link PR"_
> - _"if it's conflict the PR really can't be merged, retry is useless"_
> - a NEUTRAL removal: _"re-ask too"_
>
> The requester's reasoning, in their terms: `approved` serves two gates, the
> DESIGN gate and the MERGE gate. The design gate never rolls back. The merge gate
> does — a pull request that did not land did not honour the yes a person gave
> about those commits — and the yes was about ONE attempt.
>
> **What this reverses.** The THIRD AMENDMENT's decisions 5, 6 (first half) and 7
> (second bullet), struck in place above, and §8's point 5(e) _"a retry is step (b)
> for that one gate alone"_, struck in place below (point 8). Its decisions 1–4, 8
> and 9 stand unchanged: the event, the reason map, the exit row, the failing check
> and the delivery-GUID idempotency. **Every rule below is for a `manual`-mode
> project.** `auto` mode is unchanged throughout and is restated at point 10.
>
> **1. ONE APPROVAL AUTHORIZES ONE MERGE OR ENQUEUE ACTION.** Once that action has
> been attempted and has NOT landed, the approval is SPENT. No door re-performs it
> on the same approval — not _Queue again_, not _Retry merge_, not a second press
> of the same gate. _Why:_ an approval is a person saying "land these commits
> now"; when that attempt fails, nobody has said "try again", and the product must
> not supply that sentence on their behalf.
>
> **2. EVERY UN-LANDED OUTCOME IS CLASSED BY ITS REASON**, by ONE total map in
> `lib/mergeQueue/queueExit.ts` over BOTH sources: the queue's exit reason
> (`GithubPullRequestQueueExit.rawReason`) and the host's `MergeRefusalCode`
> (`lib/git/types.ts`) when a press is refused.
>
> | class                       | reasons                                                                                                                                                              | the card                 | the gate                                    |
> | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------- |
> | **RETRYABLE**               | queue `CI_FAILURE`, `CI_TIMEOUT`, `INVALID_MERGE_COMMIT`, `GIT_TREE_INVALID`, and every NEUTRAL removal (`MANUAL`, `QUEUE_CLEARED`, `ROLL_BACK`, an unmapped reason) | `approved → in_review`   | ONE fresh awaiting gate                     |
> | **CAN'T LAND AS IT STANDS** | queue `MERGE_CONFLICT`; host `conflict`, `checks_not_green`                                                                                                          | `approved → implemented` | none — the promotion is HELD at that head   |
> | **BLOCKED BY A SETTING**    | queue `BRANCH_PROTECTIONS`; host `branch_protected`, `app_permission_missing`                                                                                        | `approved → in_review`   | ONE fresh awaiting gate, naming the setting |
> | **LANDED**                  | `MERGE`, `ALREADY_MERGED`; host `already_merged`                                                                                                                     | unchanged                | none                                        |
>
> The reason for each class, one sentence each:
>
> - **RETRYABLE** — re-running the SAME commits can succeed (a flaky check, a
>   cleared queue, a hand removal), so the question is worth asking again.
> - **CAN'T LAND AS IT STANDS** — the same commits cannot land however many times
>   anyone says yes, so asking would offer a button guaranteed to fail; the card
>   goes back to `implemented`, where `motir fix` claims it.
> - **BLOCKED BY A SETTING** — a person can change the setting and the same
>   commits then land, so the question is asked and the surface NAMES the setting.
> - `subject_changed` is **NOT an outcome at all.** It is the stale-stamp refusal
>   (MOTIR-5232): the action was never attempted, so nothing was spent and no row
>   is written.
>
> **⚠️ SUPERSEDED by the FIFTH AMENDMENT below (MOTIR-6591, 2026-09-27)** for
> the four queue FAILURE reasons in the RETRYABLE row — `CI_FAILURE`, `CI_TIMEOUT`,
> `INVALID_MERGE_COMMIT`, `GIT_TREE_INVALID` — and for the _"a flaky check"_ in the
> RETRYABLE sentence: those four are now CAN'T LAND AS IT STANDS, with
> `MERGE_CONFLICT`. The NEUTRAL removals stay RETRYABLE, and the other three rows
> stand. Kept visible as the record.
>
> **3. THE RE-ASKED GATE** is ONE fresh awaiting `pull_request_approval` gate over
> the SAME delivery-set version, standing alone.
>
> - **The decided gate row is never edited.** It is a record (§6a), and
>   `trg_approval_gate_decided_immutable` refuses the write anyway. _Why:_ the
>   first yes happened and stays true as history; what changed is that it did not
>   land.
> - **The re-ask is COMPUTED from the STANDING OUTCOME** — a queue exit that is
>   not re-queued, or a recorded host refusal that is not superseded — at the
>   member's CURRENT head and later than the approval. `resolveGateSet` treats
>   such an outcome as making the merge question OWED even though the latest merge
>   gate is `approved` at the same set version. _Why:_ the old row cannot carry the
>   change, so the only honest input is the outcome record.
> - **A decided `design_result` gate stays decided and is not re-asked**, also
>   where the un-landed merge had been carried by the design approval (MOTIR-5664's
>   one-press carry). _Why:_ the design was never the problem, only the merge. The
>   new gate stands alone, drawn the way MOTIR-5667's state 2 draws a merge gate
>   re-opened beside a decided design.
> - **Exactly one.** A redelivered `dequeued` (the same delivery GUID, decision 9)
>   raises nothing new, and the partial unique index on `awaiting` still holds.
>   _Why:_ asking twice about one set of commits is the thing MOTIR-5603 retired.
> - **A CAN'T-LAND outcome raises NOTHING, and the promotion is HELD at that
>   head.** A green check at the same head must not raise a gate; the head moving
>   is what re-arms it (point 6).
>
> **4. _RETRY MERGE_ AND _QUEUE AGAIN_ ARE THE NEW APPROVAL.** They stay on the
> PULL REQUEST's own row, where the person sees the outcome — the requester's
> _"retry merge can be on the work item link PR"_. Pressing one **DECIDES the
> awaiting re-asked gate** with the member's stamp and then performs ONE merge or
> enqueue, stamping the exit's `requeuedAt` or the refusal's `supersededAt` and
> moving the card `in_review → approved` under that gate's `decidingGateId`. With
> NO awaiting gate they refuse by name (`MERGE_REQUEUE_NEEDS_APPROVAL`) and press
> nothing. Approving the gate from the item page or the full-screen overlay
> performs the SAME action through the same service path. A CAN'T-LAND member
> offers neither verb. _Why:_ the familiar button is kept where people look for it,
> and it is made to MEAN the fresh yes rather than a replay of the spent one.
>
> **⚠️ SUPERSEDED by the FIFTH AMENDMENT below (MOTIR-6591, 2026-09-27)** for a
> queue FAILURE: a member whose standing exit is `CI_FAILURE`, `CI_TIMEOUT`,
> `INVALID_MERGE_COMMIT` or `GIT_TREE_INVALID` is now a CAN'T-LAND member, so it
> offers neither verb and _Queue again_ refuses it. The verbs stay the approve for a
> NEUTRAL removal and a SETTING outcome. Kept visible as the record.
>
> **5. THE HOST'S REFUSAL IS RECORDED** on the pull request —
> `GithubPullRequestMergeRefusal`: the `MergeRefusalCode`, the head it refused, the
> gate whose approval it spent, and when — written in its own transaction after the
> press's transaction has rolled back. _Why:_ before this the refusal existed only
> in the press's HTTP response, so a reload showed a card reading **Approved** with
> nothing anywhere saying the merge had been refused or why. A class cannot be
> assigned to an outcome nobody wrote down.
> **AMENDED (Bug MOTIR-6735, 2026-09-28): the row also keeps the host's OWN message**
> (`reason`, nullable, verbatim, bounded at 2000 characters). The classifier files
> every host error it does not recognise under `branch_protected`, so for that code
> the message is the only record of WHICH setting refused the merge — and without it
> the card told a person to "change the setting" and named none. It is quoted,
> attributed to the host, beneath the refusal's own line in the Development block
> and the approval overlay, and returned by the work item's delivery set
> (`mergeRefusal`, MCP and `/api/v1` `1.47.0`).
>
> **6. `motir fix` IS FOR THE CLASSES WHERE THE CODE MAY BE AT FAULT.** It claims a
> CAN'T-LAND card at `implemented` (where it already did) and a `CI_FAILURE` /
> `CI_TIMEOUT` / `INVALID_MERGE_COMMIT` / `GIT_TREE_INVALID` card at `in_review`.
> It REFUSES a BLOCKED-BY-A-SETTING card and a NEUTRAL one, naming what would help
> instead. It is offered wherever the re-asked gate is decided: the item page's
> Development block AND the full-screen approval overlay. A push after an un-landed
> outcome supersedes the fresh gate `head moved`, and the next green raises exactly
> one gate over the new commits (MOTIR-5604's path, unchanged) — which is also how
> a CAN'T-LAND card leaves its hold. _Why:_ `motir fix` sends an agent to change
> code; against branch protection or a hand removal it has nothing to change.
>
> **⚠️ SUPERSEDED by the FIFTH AMENDMENT below (MOTIR-6591, 2026-09-27)** in its
> first sentence's second half: a `CI_FAILURE` / `CI_TIMEOUT` /
> `INVALID_MERGE_COMMIT` / `GIT_TREE_INVALID` card no longer reaches `in_review`,
> so `motir fix` claims it at `implemented`, as a CAN'T-LAND card. The refusals
> of a SETTING and a NEUTRAL card stand. Kept visible as the record.
>
> **7. THE EDGES.** After this amendment the ejection edges in the default workflow
> read:
>
> | edge                      | state        | writer                                                  |
> | ------------------------- | ------------ | ------------------------------------------------------- |
> | `approved → in_review`    | **DECLARED** | a RETRYABLE or SETTING outcome (point 2)                |
> | `implemented → approved`  | **ABSENT**   | none — an approval is only ever given from `in_review`  |
> | `approved → implemented`  | kept         | a CAN'T-LAND outcome (point 2); also a legal hand move  |
> | `in_review → implemented` | kept         | an `auto` FAILURE removal (THIRD AMENDMENT, decision 3) |
>
> _Why:_ the absence of `implemented → approved` is what guarantees a card only
> becomes Approved where CI has spoken and a person has said yes, and its only
> product writer was _Queue again_, which point 4 turns into a gate decision.
> Existing default workflows are converged by a KEY-joined migration that inserts
> `approved → in_review` behind a `NOT EXISTS` guard and deletes only the
> `implemented → approved` rows Motir's own backfill wrote, never a transition a
> person added in the workflow editor.
>
> **8. §8's point 5(e) — _"a retry is step (b) for that one gate alone. The
> approval stands above it."_ (MOTIR-5613) — is SUPERSEDED**, struck in place at
> §8 below. A refused merge still writes no decision on its gate and still renders
> its refusal on the surface naming that pull request; what changes is that the
> retry no longer rides on the standing approval. The refusal is recorded (point
> 5), classed (point 2), and the card leaves `approved` accordingly; _Retry merge_
> then decides the fresh gate (point 4). _Why:_ that rule is the same shortcut as
> _Queue again_, one door over, and point 1 admits no exception for it.
>
> **9. CARDS LEFT STRANDED BY THE OLD RULES ARE CONVERGED, by an operator, after
> deploy.** Four populations, each moved through the SAME service entry point a
> live outcome runs: a card at `implemented` with a standing RETRYABLE or SETTING
> exit at its head (→ `in_review` plus one fresh gate); a card at `implemented`
> with a standing `MERGE_CONFLICT` exit (already in its new state — counted, not
> moved); a card at `approved` with a standing NEUTRAL exit (→ `in_review` plus one
> gate); and a card at `approved` holding an un-landed member with no outcome at
> all, which is a host refusal the press never recorded (a refusal row is written
> with the backfill-only code `unrecorded`, classed RETRYABLE, then the same move).
> A card whose head has moved is skipped: it re-arms on its next green, as today.
> _Why:_ changing a rule going forward must not leave the cards caught under the
> old one with no way back, and RETRYABLE is the safe default for an outcome nobody
> recorded — a person is asked, and can still reach for `motir fix`.
>
> **⚠️ SUPERSEDED by the FIFTH AMENDMENT below (MOTIR-6591, 2026-09-27)** in its
> first population for a queue FAILURE exit: a card at `implemented` with a
> standing `CI_FAILURE` / `CI_TIMEOUT` / `INVALID_MERGE_COMMIT` /
> `GIT_TREE_INVALID` exit is already in its new state, and is counted with the
> `MERGE_CONFLICT` population rather than moved. The FIFTH AMENDMENT's point 4 adds
> the population that runs the other way. Kept visible as the record.
>
> **10. `auto` MODE IS UNCHANGED.** No gate is raised, a failure exit still writes
> `in_review → implemented`, and `requeueAutoMember` (MOTIR-5634) still
> re-dispatches the same head on a person's press. _Why:_ there is no approval in
> `auto` mode to spend, so point 1 has nothing to bind.
>
> **Not decided here:** GitLab merge trains (MOTIR-4608); any notification.
> MOTIR-5785 (the design-card direct-merge defect) is `done` and its design-hold
> refusal stays ahead of every merge or enqueue this amendment describes.
>
> **Which card builds which point** (Story MOTIR-5799):
>
> | points      | card                                                                  |
> | ----------- | --------------------------------------------------------------------- |
> | 2, 3, 7     | MOTIR-5805 — the class map, `settleUnlandedOutcome`, and the gate set |
> | 1, 4        | MOTIR-5802 — no door reuses a spent approval after a queue exit       |
> | 5           | MOTIR-5833 — the host refusal record                                  |
> | 4, 8        | MOTIR-5834 — _Retry merge_ after a host refusal                       |
> | 6 (claim)   | MOTIR-5803 — `motir fix` claims by class                              |
> | 6 (surface) | MOTIR-5801 — the design · MOTIR-5806 — the frame and the overlay      |
> | 7 (edges)   | MOTIR-5804 — the edges and their migration                            |
> | 9           | MOTIR-5809 — the script · MOTIR-5810 — its production run             |

> ### §4 — FIFTH AMENDMENT (MOTIR-6591, 2026-09-27): a merge-queue FAILURE is CAN'T LAND — `CI_FAILURE`, `CI_TIMEOUT`, `INVALID_MERGE_COMMIT` and `GIT_TREE_INVALID` join `MERGE_CONFLICT` at `implemented` with no gate; neutral and setting outcomes keep the re-ask
>
> **DECIDED BY THE REQUESTER (Yue, 2026-09-27).** Their words: _"when a PR failed
> in the merge queue, we should not open a new approval gate"_. Story MOTIR-6587.
>
> **What this reverses.** For the four queue FAILURE reasons only, the FOURTH
> AMENDMENT's re-ask: its point 2 RETRYABLE row, point 4's verbs, point 6's
> `in_review` claim and point 9's first population, each carrying a superseded note
> above. Nothing is struck and the FOURTH AMENDMENT's text is not edited. Every rule
> below is for a `manual`-mode project, as the FOURTH's are.
>
> **1. WHAT MOVES.** The queue reasons `CI_FAILURE`, `CI_TIMEOUT`,
> `INVALID_MERGE_COMMIT` and `GIT_TREE_INVALID` move from `retryable` to
> `cant_land` in `lib/mergeQueue/queueExit.ts`. _Why:_ a failure says the commits as
> they stand cannot land, so a second approval of the same head is a button
> guaranteed to fail. A flaky failure, where the code is fine, is repaired the same
> way: `motir fix` merges the default branch first (MOTIR-3744), so there is always
> a new head and a new green run.
>
> **⚠️ NARROWED by the SIXTH AMENDMENT below (MOTIR-6844, 2026-09-28)** for
> `CI_FAILURE` and `CI_TIMEOUT`: _"a failure says the commits as they stand cannot
> land"_ is false when the recorded failing check was CANCELLED or TIMED OUT, which
> says nothing about the commits. Such an exit is `neutral` / `retryable`. A check
> that concluded anything else stays as this point says. Kept visible as the record.
>
> The class table after this amendment, over every key of `QUEUE_EXIT_REASONS` and
> every `MergeRefusalCode` (`lib/git/types.ts`):
>
> | source | reason                   | disposition | class after           | changed |
> | ------ | ------------------------ | ----------- | --------------------- | ------- |
> | queue  | `CI_FAILURE`             | failure     | `cant_land`           | **yes** |
> | queue  | `CI_TIMEOUT`             | failure     | `cant_land`           | **yes** |
> | queue  | `INVALID_MERGE_COMMIT`   | failure     | `cant_land`           | **yes** |
> | queue  | `GIT_TREE_INVALID`       | failure     | `cant_land`           | **yes** |
> | queue  | `MERGE_CONFLICT`         | failure     | `cant_land`           | no      |
> | queue  | `BRANCH_PROTECTIONS`     | failure     | `setting`             | no      |
> | queue  | `MANUAL`                 | neutral     | `retryable`           | no      |
> | queue  | `QUEUE_CLEARED`          | neutral     | `retryable`           | no      |
> | queue  | `ROLL_BACK`              | neutral     | `retryable`           | no      |
> | queue  | `UNKNOWN_REMOVAL_REASON` | neutral     | `retryable`           | no      |
> | queue  | an unrecognised string   | neutral     | `retryable`           | no      |
> | queue  | `MERGE`                  | landed      | `landed`              | no      |
> | queue  | `ALREADY_MERGED`         | landed      | `landed`              | no      |
> | host   | `checks_not_green`       | —           | `cant_land`           | no      |
> | host   | `conflict`               | —           | `cant_land`           | no      |
> | host   | `branch_protected`       | —           | `setting`             | no      |
> | host   | `app_permission_missing` | —           | `setting`             | no      |
> | host   | `already_merged`         | —           | `landed`              | no      |
> | host   | `subject_changed`        | —           | none (not an outcome) | no      |
>
> **⚠️ NARROWED by the SIXTH AMENDMENT below (MOTIR-6844, 2026-09-28)** in the
> `CI_FAILURE` and `CI_TIMEOUT` rows: their disposition and class now follow the
> raw conclusion of the recorded failing check, and are `neutral` / `retryable`
> when it is `cancelled` or `timed_out` (and, for `CI_TIMEOUT`, when no check that
> genuinely failed is recorded). The other rows stand. Kept visible as the record.
>
> **2. WHAT THAT MEANS, SURFACE BY SURFACE — the shipped `cant_land` behaviour,
> applied to four more reasons.** No new mechanism is introduced:
>
> - the card goes `approved → implemented`, HELD at that head (`settleUnlandedOutcome`);
> - no gate is raised, and a green check at the SAME head raises none, because a
>   failure disposition already holds the promotion (`queueExitHoldsAtHead`);
> - _Queue again_ is refused for these reasons, with a refusal of their own
>   (`MERGE_QUEUE_FAILED_NEEDS_FIX`) rather than `MERGE_CONFLICT`, so a CI failure is
>   never reported as a conflict;
> - `motir fix` claims the card at `implemented`;
> - a push whose CI goes green raises ONE gate through the ordinary CI promotion
>   (the FOURTH's point 6, unchanged).
>
> **⚠️ NARROWED by the SIXTH AMENDMENT below (MOTIR-6844, 2026-09-28)** for a
> `CI_FAILURE` / `CI_TIMEOUT` exit whose recorded check was cancelled or timed out:
> none of these five bullets applies to it. The card goes to `in_review` with ONE
> fresh gate, _Queue again_ is its approve, and `motir fix` is not offered. The
> bullets stand for every other queue failure. Kept visible as the record.
>
> **3. WHAT DOES NOT MOVE, AND WHY.**
>
> - **NEUTRAL removals** (`MANUAL`, `QUEUE_CLEARED`, `ROLL_BACK`,
>   `UNKNOWN_REMOVAL_REASON`, an unrecognised string) stay `retryable`: nothing
>   failed, so asking again is the honest question.
> - **SETTING outcomes** (`BRANCH_PROTECTIONS`, host `branch_protected` /
>   `app_permission_missing`) stay `setting`: changing a setting is not a push, so
>   without a gate nothing would ever bring the question back.
> - **The host refusal classes** are already `cant_land` for `conflict` and
>   `checks_not_green`, and are unchanged.
> - **`auto` mode** is unchanged: no gate is raised, and `requeueAutoMember` still
>   re-dispatches the same head on a person's press (the FOURTH's point 10).
>
> **4. THE CONVERGENCE.** A card already at `in_review` holding an AWAITING
> `pull_request_approval` gate that was re-asked from one of the four reasons — a
> standing, un-re-queued failure exit at the member's current head, later than the
> card's last approval — is moved to `implemented` through the same
> `settleUnlandedOutcome` a live exit runs, and that awaiting gate is withdrawn with
> a new supersede cause, `queue_failed`. A decided gate row is never edited (§6a),
> and a second run moves nothing. It runs through the MOTIR-5809 script and its
> `workflow_dispatch`, operated after deploy.
>
> **⚠️ NARROWED by the SIXTH AMENDMENT below (MOTIR-6844, 2026-09-28)** for a
> re-ask that came from a HUNG check: that re-ask was correct, and a card this
> convergence already moved to `implemented` on such an exit is re-asked again by
> the SIXTH's point 4 (the reconcile tick), with no push. Kept visible as the record.
>
> **5. SUPERSEDED TEXT.** The FOURTH AMENDMENT's point 2 RETRYABLE row and its
> RETRYABLE sentence, point 4 for a failure, point 6's `in_review` claim and point
> 9's first population carry a `⚠️ SUPERSEDED by the FIFTH AMENDMENT below` note,
> in the form the FOURTH used on the THIRD. Sentences about the neutral and setting
> classes are left unmarked.
>
> **Not decided here:** listing a failed card on a Workbench tab (the To fix story,
> MOTIR-6588); the `→ planning` edges (MOTIR-5643); GitLab merge trains
> (MOTIR-4608); any notification.
>
> **Which card builds which point** (Story MOTIR-6587):
>
> | points      | card                                                                       |
> | ----------- | -------------------------------------------------------------------------- |
> | 1, 2        | MOTIR-6594 — the class map, the refusal, `motir fix` and its help          |
> | 2 (surface) | MOTIR-6593 — the design delta · MOTIR-6596 — the row, the overlay and copy |
> | 4           | MOTIR-6595 — the convergence · MOTIR-6592 — its production run             |

> ### §4 — SIXTH AMENDMENT (MOTIR-6844, 2026-09-28): a queue exit whose check HUNG re-asks — a `CI_FAILURE` / `CI_TIMEOUT` exit whose recorded failing check was CANCELLED or TIMED OUT is `neutral` and `retryable`, the check's raw conclusion is recorded, and a late or reconciled conclusion re-settles a still-standing exit
>
> **DECIDED BY THE REQUESTER (Yue, 2026-09-28)**, accepting _"re-ask with one gate /
> Queue again"_ for a hung check. Story MOTIR-6843. It narrows the FIFTH
> AMENDMENT for `CI_FAILURE` and `CI_TIMEOUT` only; the FIFTH's affected sentences
> carry a narrowed note above, and nothing is struck. Every rule below is for a
> `manual`-mode project, as the FOURTH's and the FIFTH's are.
>
> **1. WHAT MOVES, AND WHY.** A `CI_FAILURE` or `CI_TIMEOUT` exit is judged by the
> RAW GitHub conclusion of its recorded failing check. When that conclusion is
> `cancelled` or `timed_out`, nothing failed in the code: the job was stopped, by a
> person or by its own time limit, before it could say anything about the commits.
> The exit's disposition becomes `neutral` and its class `retryable`, the same as
> `MANUAL`: the card goes `approved → in_review` with ONE fresh awaiting
> `pull_request_approval` gate (`settleUnlandedOutcome`, unchanged), its CI state
> does not read failing, _Queue again_ is its approve, it is listed on To approve,
> and it is not on To fix. A `CI_TIMEOUT` exit with no recorded check that
> concluded a genuine failure is judged the same way, because a queue timeout is
> itself the statement that the checks did not finish.
>
> _Why:_ the FIFTH's premise, _"a failure says the commits as they stand cannot
> land"_, is true of a check that FAILED and false of one that HUNG. Holding a
> hung card at `implemented` sends `motir fix` to repair code that has nothing
> wrong with it, and the only other way forward is a hand-made push.
>
> **The fixture.** MOTIR-6765 / `motir-core` PR #3227, 2026-09-28. Its merge-group
> run `36443325714` ran the `TypeScript` job, which hung in
> `pnpm -r --filter './packages/*' build` from 15:25 to 15:44 UTC and was cancelled
> at its timeout. 23 of the 24 surrounding merge-group runs passed the same job in
> 3–4 minutes. The queue exited the pull request `CI_FAILURE`, the card sat at
> `implemented` with a green pull request and nothing to press, and the 30-minute
> reconcile tick left it there on every pass, because it trusts the recorded exit
> and the exit could not tell a hang from a failure.
>
> The table after this amendment, over every key of `QUEUE_EXIT_REASONS`
> (`lib/mergeQueue/queueExit.ts`); the host `MergeRefusalCode` rows of the FIFTH's
> table are unchanged:
>
> | reason                   | recorded check's conclusion                     | disposition | class       | changed |
> | ------------------------ | ----------------------------------------------- | ----------- | ----------- | ------- |
> | `CI_FAILURE`             | `cancelled` or `timed_out`                      | neutral     | `retryable` | **yes** |
> | `CI_FAILURE`             | anything else, or none recorded yet             | failure     | `cant_land` | no      |
> | `CI_TIMEOUT`             | `cancelled`, `timed_out`, or none recorded      | neutral     | `retryable` | **yes** |
> | `CI_TIMEOUT`             | anything else (`failure`, `startup_failure`, …) | failure     | `cant_land` | no      |
> | `INVALID_MERGE_COMMIT`   | — (names no check)                              | failure     | `cant_land` | no      |
> | `GIT_TREE_INVALID`       | — (names no check)                              | failure     | `cant_land` | no      |
> | `MERGE_CONFLICT`         | —                                               | failure     | `cant_land` | no      |
> | `BRANCH_PROTECTIONS`     | —                                               | failure     | `setting`   | no      |
> | `MANUAL`                 | —                                               | neutral     | `retryable` | no      |
> | `QUEUE_CLEARED`          | —                                               | neutral     | `retryable` | no      |
> | `ROLL_BACK`              | —                                               | neutral     | `retryable` | no      |
> | `UNKNOWN_REMOVAL_REASON` | —                                               | neutral     | `retryable` | no      |
> | an unrecognised string   | —                                               | neutral     | `retryable` | no      |
> | `MERGE`                  | —                                               | landed      | `landed`    | no      |
> | `ALREADY_MERGED`         | —                                               | landed      | `landed`    | no      |
>
> **The disposition is WRITTEN on the exit row, and the class follows it.** An exit
> row already stores its `disposition`, and every reader of the promotion hold, the
> card's CI state and the repair claim keys on it (`queueExitHoldsAtHead`). So the
> conclusion decides the row's disposition when it is known, at the exit or later
> (point 4), and a `CI_FAILURE` / `CI_TIMEOUT` exit's class is `retryable` exactly
> when its stored disposition is `neutral`. One stored fact, read the same way by
> every surface, is what keeps the badge, the hold, To fix and _Queue again_ from
> disagreeing about one exit.
>
> **2. WHAT DOES NOT MOVE.**
>
> - A recorded check that concluded `failure`, `startup_failure`,
>   `action_required`, or anything other than `cancelled` / `timed_out`, stays
>   `failure` / `cant_land`, exactly as the FIFTH left it: held at `implemented`,
>   no gate, `motir fix`.
> - `INVALID_MERGE_COMMIT`, `GIT_TREE_INVALID` and `MERGE_CONFLICT` are unchanged.
>   They name no check, and each says the commits could not be combined.
> - The neutral reasons and the setting reasons are unchanged, and so are the host
>   refusals at the press (Story MOTIR-5799).
> - **`auto` mode is unchanged.** A queue failure still moves the card
>   `in_review → implemented`, holds it, and `requeueAutoMember` re-dispatches the
>   same head on a person's press. The neutral re-disposition is written only when
>   no card the pull request delivers sits in an `auto` project; otherwise the exit
>   keeps its `failure` disposition and its hold. _Why:_ in `auto` nobody is asked,
>   so a released hold would let the CI promotion merge the same head again
>   unattended, and a hang that repeats would loop.
>
> **3. WHICH CHECK COUNTS.** The one the queue attempt records: the FIRST check to
> complete as a failure at the merge-group commit (`setFailingCheckIfUnset`, which
> writes only while no check is named). Its raw conclusion is recorded beside its
> name, on the attempt and on the exit (`failingCheckConclusion`), because
> `mapConclusion` folds `cancelled` and `timed_out` into `failure` and the fold is
> where the difference was lost. An aggregate job such as `CI complete`, which
> finishes after the jobs it waits on, is never the first, so it is never the one
> recorded.
>
> _The known imprecision._ If a hung job is recorded first and a genuine failure
> completes later in the same run, the exit reads as a hang and the card is
> re-asked. That costs one extra queue run and one press, never a wrong merge:
> _Queue again_ sends the commits back through the queue, which runs every check
> again, and a genuine failure then exits the pull request with a failure recorded
> first. The same holds for a genuine failure that arrives after a `CI_TIMEOUT`
> exit was re-asked: the re-ask stands and the next queue run decides.
>
> **4. ORDERING — THE CONCLUSION MAY ARRIVE AFTER THE EXIT.** The check's
> completion routinely lands after the `dequeued` delivery, and a delivery can be
> lost. So:
>
> - **At the exit**, the conclusion that is known decides. A `CI_FAILURE` exit with
>   no conclusion yet is recorded as today, `failure` / `cant_land`, and the card
>   holds at `implemented`.
> - **When the conclusion arrives**, by the `check_run` webhook
>   (`mergeQueueCheckService.attachFailingCheck`) or read from GitHub by the
>   `system.pull-request-reconcile` tick, it is recorded on the exit, and a
>   `cancelled` / `timed_out` conclusion RE-SETTLES the exit: its disposition is
>   written `neutral`, and each card it delivers is moved through
>   `settleUnlandedOutcome` with `retryable` (`implemented → in_review`, ONE gate),
>   the same entry point a live exit runs. No push and no `motir fix` are needed.
> - It re-settles only while the exit still STANDS at the pull request's current
>   head (`queueExitStandsAtHead`: not re-queued, head not moved) and the card is
>   still where the exit put it, `implemented`. A moved head or a requeue settles
>   nothing: the push re-arms the card through the ordinary CI promotion, and a
>   requeue has already asked its own question.
> - **The reconcile tick is the backstop** for a lost delivery and for an exit
>   recorded before this amendment shipped. For a standing `CI_FAILURE` /
>   `CI_TIMEOUT` exit with no recorded conclusion, it reads the check runs at the
>   pull request's latest queue attempt's merge-group commit, records the failing
>   check (the one already named, or else the first to complete as a failure) with
>   its raw conclusion, and re-settles as above.
> - A re-settle only ever moves an exit TOWARDS the re-ask. A conclusion is written
>   once, the first time it is known, and nothing turns a `neutral` exit back into
>   a `failure` (point 3's imprecision says why that is safe).
>
> **5. ONE APPROVAL = ONE ACTION IS UNCHANGED** (the FOURTH's point 1, Story
> MOTIR-5799). The re-ask is a NEW gate that a person presses. Nothing re-queues
> without a person pressing _Queue again_ on it, so a deterministic hang costs one
> press per attempt and can never loop unattended.
>
> **6. SUPERSEDED TEXT.** The FIFTH AMENDMENT's point 1 sentence _"a failure says
> the commits as they stand cannot land"_, its table's `CI_FAILURE` and
> `CI_TIMEOUT` rows, point 2's surface-by-surface bullets and point 4's
> convergence carry a `⚠️ NARROWED by the SIXTH AMENDMENT below` note, in the form
> the FIFTH used on the FOURTH. Sentences about `INVALID_MERGE_COMMIT`,
> `GIT_TREE_INVALID`, conflicts, and neutral or setting outcomes are left
> unmarked. Nothing is struck and nothing is deleted.
>
> **What this does NOT decide:** re-queueing WITHOUT a person (point 5 forbids
> it); retrying a hung job inside one queue run; which checks a repository marks
> as required; any notification; GitLab merge trains (MOTIR-4608); and whether a
> host refusal at the press can be a hang (it names no check, and is unchanged).
>
> **Which card builds which point** (Story MOTIR-6843):
>
> | points        | card                                                                       |
> | ------------- | -------------------------------------------------------------------------- |
> | 3 (recording) | MOTIR-6846 — `failingCheckConclusion` on the attempt and the exit          |
> | 1, 2, 4       | MOTIR-6847 — the disposition, the class, and the late re-settle            |
> | 4 (backstop)  | MOTIR-6848 — the reconcile tick reads the conclusion from GitHub           |
> | 1 (surface)   | MOTIR-6845 — the design delta · MOTIR-6849 — the row, the overlay and copy |
>
> ### §4 — SEVENTH AMENDMENT (MOTIR-6903, 2026-09-29): a re-queue made OUTSIDE Motir clears the exit and nothing else — GitHub's `enqueued` stamps a standing exit re-queued, the red, the hold and the repair claim lift, and no status moves and no gate is decided
>
> **DECIDED BY THE IMPLEMENTING RUN (MOTIR-6903, 2026-09-29)**, which the card asked
> to choose between two answers and say which; the requester confirms or reverses it
> on the pull request. It amends no earlier decision. It adds a THIRD writer of
> `requeuedAt` beside the two presses (_Queue again_ in `auto`, and the re-asked
> gate's approve in `manual`), and says what that writer does and does not do.
>
> **What was OPEN.** An exit stops standing when `requeuedAt` is stamped or a push
> moves the head (`queueExitStandsAtHead`). Only Motir's own presses stamped it, and
> the webhook read `dequeued` but not `enqueued`. So a pull request put back into
> the queue anywhere else — GitHub's _Merge when ready_ / _Add to merge queue_,
> `gh pr merge --auto`, another integration — sat in the queue on GitHub while its
> card read _Left the queue_, folded `ciState: failing`, held the promotion, and was
> claimable by `motir fix`. **The fixture:** MOTIR-6829 / `motir-core` PR #3235,
> 2026-09-29 — ejected `CI_FAILURE` at 09:04:27 UTC, re-added on GitHub by a person
> at 09:28:07, and still red on the card while queued at position 5.
>
> **1. THE EXIT.** A `pull_request` `enqueued` delivery whose pull request's LATEST
> exit still stands at the head the delivery names stamps that exit's `requeuedAt`
> (`githubPullRequestQueueExitRepository.claimRequeue`, the claim the presses make),
> and recomputes every delivered card's `ciState` and fix reason in the same
> transaction, exactly as a press does. The row stops reading _Left the queue_ /
> _Removed from the queue_, the card stops reading red, the promotion hold lifts, and
> `motir fix` stops claiming it. Every disposition is answered, a `neutral` exit as
> well as a `failure`: both stood, and both are what the queue now contradicts.
>
> - **At another head** it changes nothing. A pull request whose head moved since
>   the exit is already past it (the push ended the exit), and the queue is testing
>   commits the exit says nothing about.
> - **Twice** it changes nothing: the claim writes only while `requeuedAt` is null.
>   So a redelivery, and the `enqueued` GitHub sends after Motir's own _Queue again_,
>   are no-ops, and a press racing this delivery enqueues once. Whichever claims
>   first wins, and the other finds the exit already re-queued.
> - **Motir's first enqueue** has no exit to answer and changes nothing.
>
> **2. NO STATUS MOVES AND NO GATE IS DECIDED.** A queue action taken on GitHub is
> not an answer to the question Motir asks. Point 1 of the FOURTH AMENDMENT (_one
> approval = one merge or enqueue_) is about Motir's approval, and a GitHub-side
> enqueue is not one; treating it as one would write a decision into the gate table
> that nobody made in Motir, from a delivery whose sender Motir does not read. So:
>
> - A card held at `implemented` by a can't-land exit (the FIFTH) stays at
>   `implemented`, with no gate. It is no longer red and no longer on To fix.
> - A card at `in_review` with the re-asked gate (a neutral or setting exit, the
>   FOURTH and SIXTH) keeps that gate awaiting. Answering it is harmless: the enqueue
>   finds the pull request already queued and records that entry.
> - An `auto` card stays where the exit put it.
> - **The merge is what moves the card.** When the queue lands the pull request, the
>   merge webhook writes `done` and withdraws any awaiting merge question, as for any
>   merge. When the queue ejects it again, the new exit is recorded and settled like
>   any exit.
> - Because the hold has lifted, a check that goes green at that head afterwards is
>   promoted by the ordinary CI path and may ask the merge question; answering it is
>   the same harmless enqueue.
>
> _Why not the other answer:_ reading the enqueue as the approval would give a person
> with merge rights on GitHub a way to decide a Motir gate that _Approving on GitHub_
> deliberately limits to reviews at the current commit. Clearing only the red keeps
> the one fact the card was wrong about — whether the pull request is out of the
> queue — and leaves the question of who approved it where it was.
>
> **3. THE APP SUBSCRIPTION IS UNCHANGED.** `enqueued` is an action of the
> `pull_request` event, which the Motir GitHub App already receives for `dequeued`;
> no permission and no event is added.
>
> **What this does NOT decide:** recording a GitHub-side enqueue as Motir's merge
> record (`mergeOutcomeRef` stays written only by Motir's own merge paths); reading
> who enqueued; GitLab merge trains (MOTIR-4608).

### 5. The line against Story 9.2 — DECIDED BY THE PLANNER (rung 3, and it re-scopes existing cards)

| owned HERE (Epic MOTIR-4878)                   | kept by MOTIR-693 (9.2)                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| the DECISION, its record and its status effect | the ephemeral hosted PREVIEW, its deploy and teardown                         |
| the shared control and its confirm step        | the **revise-chat re-dispatch** after a rejection                             |
| the routing surface                            | `Project.designApprovalGate` and the HOLD it applies to the `motir auto` loop |

**9.2's review UI COMPOSES this record's control rather than drawing its own.**

**Amended by [`hosted-design-rerun-and-design-approval-switch.md`](hosted-design-rerun-and-design-approval-switch.md) (MOTIR-695).**

> **⚠️ RE-DRAWN BY §10g (MOTIR-6072, 2026-09-23).** Returning a sent-back card to
> To do, handing its reason to the next run, and opening the planner on a refusal
> are now Epic MOTIR-6010's. The table above keeps the HOSTED, automatic
> re-dispatch and its preview for 9.2; read _the revise-chat re-dispatch after a
> rejection_ as that automatic loop only.

**Why the decision moved out of 9.2 at all:** 9.2 sits behind hosted agent
execution (MOTIR-683), so leaving design approval there means nobody can approve
a design until an entire epic lands — while the artefact it would approve has
been shipping to cards since MOTIR-2664.

`design-result.md` §7 currently points the other way and is amended by this
record's own pull request to point here for the half this epic takes.

### 6. The gate LIFECYCLE — DECIDED BY THE REQUESTER (Yue, 2026-09-08), mechanics by the planner

#### 6a. A gate is an EAGER row, and the row is an AUDIT ARTEFACT

A gate row is written **when its subject appears** — in the same transaction as
the design-result publish, or the `link_pull_request` call — not derived on read.

Two things forced it and both are already requirements elsewhere in the story: a
**partial unique index** over the awaiting state cannot exist without a row, and
the decide door's **`SELECT … FOR UPDATE`** has nothing to lock without one.
Locking the subject instead would make two gate kinds on one card contend with
each other. And since `decidedById` / `decidedAt` need a row at decision time
regardless, a derived model is the eager model minus its index and its lock.

**But the row is not a workflow row that happens to keep a timestamp.** Yue:
_"it has to be informational, that will be used for later audits … **the human in
the agent loop evidence**."_ It is read months later by someone who was not
there, so it carries:

| field                                                                                                               | why an auditor needs it                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| the subject **and its immutable VERSION** — the design's `commitSha`, the pull request's `headSha` at decision time | a design can be republished and a pull request can gain commits, so _"approved the design"_ is not evidence and _"approved these bytes"_ is |
| **who decided, surviving their departure** — a denormalised actor label beside the nullable FK                      | `onDelete: SetNull` preserves _that_ a decision happened and destroys _who made it_, which is the one thing the audit is for                |
| **when**                                                                                                            | the server's timestamp                                                                                                                      |
| **who it was ROUTED to**                                                                                            | §2's answer computed at creation; the assignee can change afterwards                                                                        |
| **under which PERMISSION**                                                                                          | answers _"was this person entitled?"_ without re-deriving a role that has since changed                                                     |
| **through which SURFACE** — `ui \| api \| mcp`                                                                      | a human click must be distinguishable from a programmatic call                                                                              |
| **what it CAUSED** — the merge commit sha, or the transition applied                                                | closes the loop from decision to effect                                                                                                     |
| **the note**                                                                                                        | why they said yes, or what they sent back                                                                                                   |

**A decided gate is IMMUTABLE.** There is no update path for a decided row —
audit evidence that can be edited is not evidence.

> **⚠️ AMENDED 2026-09-24 (Bug MOTIR-6191): THE RECORD IS READABLE BY A TOKEN.
> `GET /api/v1/work-items/{key}/approval-gate` and the `get_approval_gate` MCP
> tool answer one `(work item, gate kind)` pair with this audit set, gated on
> `project:browse`.**
>
> **The defect.** Every door onto `noteMd` was SESSION-authed — the overlay's
> `GET /api/work-items/approval-gate` resolves `getActiveProject()` on its first
> line, the item page's read is a server component inside `(authed)`, `/api/v1`
> had no gate route and MCP had no gate tool — and a gate decision is not a
> comment, so `get_work_item`, `get_work_item_activity` and the comment threads
> did not carry it either. So an agent holding a workspace PAT, or the narrower
> CLI grant, could not read the answer to a question it had raised. **The
> asymmetry landed on the one kind whose author is ALWAYS an agent**:
> §8's FIFTH AMENDMENT makes `decision_approval` the gate of a `type: decision` +
> `executor: coding_agent` card, so _"I pressed Request changes — read my note"_
> was an instruction the only possible recipient could not follow.
>
> **Why it was worth a door rather than a workaround.** The failure is silent, not
> loud. An agent that cannot read WHY changes were requested acts on what it
> EXPECTS the reviewer objected to, and on a decision record or a design that
> produces a confident second wrong version with nothing anywhere going red. The
> manual alternative — a person re-typing the note into the agent's chat — is the
> hand-carrying epic MOTIR-6010 exists to remove.
>
> **⚠️ AND IT CHANGES NOTHING ABOUT DECIDING. §2's _"the decide route is
> session-authed and no MCP tool or `/api/v1` operation asserts the key"_ stays
> true word for word**, and §1's _"there is no agent path to approving … and
> there is not meant to be"_ stands: `approval:decide_any` is still ungrantable to
> an API token by derivation, still asserted by no tool and no v1 operation, and
> an agent-written approval would still put a decision nobody made into the one
> table an audit trusts. **The two questions are opposites and §11.5b's wording
> invites merging them** — one is _may a machine DECIDE_, the other is _may a
> machine READ a decision a person already made_. The second leaks no authority,
> which is why `project:browse` is the whole of its gate: reading a decision about
> the card you are working on is browsing the project. That key is already in
> `CLI_TOKEN_GRANT`, so the fix reaches a dispatched agent with **no widening of
> any grant**.
>
> **What it returns, and what it deliberately does not.** The audit set in the
> table above — `state`, `noteMd`, `decidedAt`, `decidedByLabel`,
> `decidedUnderAuthority`, `decisionSource`, `subjectVersion`, `supersededCause`,
> `outcomeRef` — plus the live `routedToLabel` so a caller that cannot act can at
> least say who can. NOT the render machinery: no `canDecide` (an agent may never
> decide, so the flag could only mislead), no stamp pair (a stamp is handed back
> with a PRESS), no port. The two doors project the SAME service read the approval
> frame uses (`approvalGatesService.getForWorkItem`), so the record an agent reads
> and the record a person is looking at cannot disagree — including about WHICH
> gate wins when a card holds several of one kind.
>
> **`gate: null` is an answer, not a 404**: the card has no gate of that kind, so
> nothing is waiting and nothing was decided. A key that does not resolve, or a
> project the caller may not browse, is the indistinguishable not-found, as
> everywhere else.
>
> **What would reverse this.** Nothing about the read; it is the minimum that makes
> §10's _a refusal says why_ reach the actor it is addressed to. What would need
> re-deciding is the OPPOSITE move — a decide door for a token — and the argument
> against that is §1's and is untouched by this amendment.

#### 6b. The state set

| state               | written by                                             | is it a decision?                   |
| ------------------- | ------------------------------------------------------ | ----------------------------------- |
| `awaiting`          | the product, when the subject appears                  | —                                   |
| `approved`          | a person                                               | **yes**                             |
| `changes_requested` | a person                                               | **yes**                             |
| `superseded`        | **the product**, when the gate's subject is superseded | **no** — the question was withdrawn |

**`superseded` is required, and its absence was a real gap.** The revise loop
publishes v2 while v1's gate is still `awaiting`. Without this state the
Approvals tab would ask about a design that is no longer current, and approving
it would pin bytes for a version the product had already moved past. It carries
no actor, no permission and no note, **so that the audit can never read a
withdrawn question as a human decision.**

**Uniqueness is keyed on `(workItemId, kind, subjectId)`, not `(workItemId,
kind)`.** For `design_result` there is one current design, so superseding frees
the slot; for `pull_request_merge` a card carrying a repository SET legitimately
has several open pull requests and therefore several simultaneous awaiting gates.

> ### §6b — AMENDMENT (MOTIR-5658, 2026-09-17): a supersede records its CAUSE
>
> **A supersede writes `state` and nothing else, and that is why no surface can
> say a true sentence about a withdrawn gate.** State `G` and the
> `APPROVAL_GATE_SUPERSEDED` refusal both say _a newer design was published … the
> current version is above_ — true for ONE of the writing paths and false for the
> rest ([MOTIR-5586](motir:cmu30qjra00g6hvoiiu6ljuhv),
> [MOTIR-5651](motir:cmu5aympl0020hvoik1mfccrg)). Both were repaired by making
> the sentence vaguer, which is the only repair available while the row is
> silent.
>
> **A `superseded` row now carries a CAUSE**, from a closed vocabulary with one
> value per writing path and **no value meaning _unsaid_**: `republished` ·
> `withdrawn` · `head_moved` · `member_closed` · `member_drafted` · `set_changed` ·
> `pulled_back` (`member_drafted` added by MOTIR-5699; **`ci_failed` by MOTIR-6271** —
> a terminal CI failure at the commits the gate asked about, §8's SIXTH AMENDMENT;
> **`ci_rerunning` by MOTIR-6946** — a check at those commits `pending` again, the set
> leaving green without going red, §8's SEVENTH AMENDMENT; **`subject_gone` by MOTIR-7146**
> — the subject no longer resolves through its kind's handler, see the amendment below).
> The full table, with which path writes each, is `design-result.md`
> AMENDMENT 6 Q5. (A seventh, `reopened_by_hand`, was named here when the
> amendment was written and removed before it shipped — MOTIR-5661 found that a
> decided gate cannot be updated at all, so nothing was left to write it.)
>
> **Rows superseded before this amendment carry an UNKNOWN value**, which a
> surface renders as _the reason was not recorded_ — never as one of the real
> causes. Inferring a cause from a row's shape manufactures evidence, and these
> sentences are shown to a person as fact.
>
> **It is still a product write with NO actor, no authority and no note.** A
> cause does not make a withdrawn question readable as a human decision, which is
> what §6b's no-actor rule exists to guarantee.

> ### §6 AMENDMENT — MOTIR-7146, 2026-10-01: a question whose SUBJECT IS GONE is withdrawn when it is SEEN
>
> Every writer of `superseded` above reacts to an EVENT on the subject — a republish,
> a push, a close, a set change, a pull-back. A subject that stops resolving by any
> other route (a body edited past its parser by a door that skips the gate's service,
> an evidence row that no longer reads, a delivery set emptied without a set-change
> event) had no writer at all: its gate stayed `awaiting` for ever, listed and counted
> on To approve as a _Gone_ row whose overlay offered nothing to press.
>
> **The rule: a read that observes an `awaiting` gate whose subject no longer
> resolves withdraws it, cause `subject_gone`.** To approve, the Approvals room and the
> approval overlay make that observation already (`summarizeGateSubjects` omits the
> subject; the overlay's port answers `gone`), so they hand the candidates to
> `approvalGatesService.withdrawGoneQuestions`.
>
> - **ON OBSERVATION, NOT ON A SWEEP.** A reconcile job would read every awaiting gate
>   in every workspace through every kind's resolver to find the rare gone one, and
>   would still leave it on screen until its next tick. The read has already done
>   that work for exactly the gates a person is looking at.
> - **AFTER THE READ, IN ITS OWN TRANSACTION.** A read never holds a gate's lock and
>   never writes inside its own snapshot. Each candidate is re-read UNDER ITS LOCK
>   (its subject's lock first where the kind takes one — a plan) and withdrawn only
>   if it is still `awaiting` and its KIND'S HANDLER — the registry's `resolveSubject`,
>   the seam the decide door reads — still answers null. So the rule covers every
>   registered kind through the registry, never a list here, and a subject that came
>   back between the read and the write is left alone.
> - **A FAILED WITHDRAWAL NEVER FAILS THE READ**: the row stays as it was read, and the
>   next read observes it again.
> - **A DECIDED gate over a gone subject is untouched** — it is somebody's answer — and
>   the overlay still draws Panel 4b for it. An awaiting one is withdrawn before the
>   overlay answers, so opening it draws state `G` with its cause, never Panel 4b.
> - **A Visitor's read observes and writes nothing.**
>
> It is a product write with no actor, like every cause above. No person-pressed
> withdraw is added: the approved overlay design (§22, Panel 4b) draws one action,
> _Open work item_, and the observation retires the question before that panel could
> be reached for an awaiting gate.

> ### §6b — SHIPPED (MOTIR-4913, 2026-09-10): what WRITES `superseded`, and when
>
> The state has been in the enum since MOTIR-4788 and the decide door has refused
> it since MOTIR-4790. **Nothing wrote it until now**, so a republish left the
> prior version's gate `awaiting` and the Approvals tab kept asking about a
> design that was no longer current.
>
> **The writer is the PUBLISH path** — `designEvidenceService`'s supersede
> transaction, via
> `approvalGateRepository.supersedeAwaitingByWorkItem(workItemId, 'design_result')`.
> It writes `state` and **nothing else**: no actor, no authority, no note, no
> `decided_at`. That is what keeps §6b's _"the audit can never read a withdrawn
> question as a decision somebody made"_ true on the row rather than only in
> prose, and `tests/approval-gate-retention.test.ts` asserts every one of those
> columns is still null.
>
> **It is keyed on `(work_item_id, kind)`, not on the superseded subject's id**,
> and that is a domain fact rather than a shortcut: `design_evidence` carries one
> CURRENT row per work item, so an `awaiting` `design_result` gate on the item is
> by construction asking about the version the publish is replacing.
>
> **⚠️ AND IT RUNS BEFORE THE `design_evidence` LOCK, WHICH IS A LOCK-ORDER
> DECISION, NOT A STYLE ONE.** The decide door locks the GATE row (step 1) and
> then writes `design_evidence` (§6c's pin, step 4b). A publish that locked
> `design_evidence` first and reached for the gate afterwards would take the same
> two locks in the opposite order — a deadlock, on precisely the interleaving §6c
> exists for. Retiring the gate first makes both paths take `approval_gate` then
> `design_evidence`, so the race resolves by WAITING and lands on one of two
> legitimate outcomes: the publish wins and the decide door refuses with
> `ApprovalGateSupersededError` (nothing was approved, nothing needed pinning), or
> the decide wins and the supersede finds the pin and keeps the bytes.
>
> ### §6b — AMENDMENT (MOTIR-5574, 2026-09-15): WITHDRAWAL is the second writer
>
> **A republish is not the only product write that retires the question. A
> withdrawal does too.** A reviewer who withdraws the current design result
> (`DELETE /api/work-items/<KEY>/design-evidence`, MOTIR-3215) takes the gate's
> subject away with nothing in its place. Until this amendment that path wrote no
> gate, so the gate stayed `awaiting`. The To-approve tab kept the row, and the
> held transitions that read an awaiting gate kept holding the card.
>
> **So `designEvidenceService.withdrawCurrentForWorkItem` makes the same call as
> the publish path**: `supersedeAwaitingByWorkItem(workItemId, 'design_result')`,
> in the withdrawal's own transaction, **before the `design_evidence` lock** for
> the lock-order reason above. The rest of this section holds unchanged:
>
> - it writes `state` alone;
> - a DECIDED gate is untouched;
> - a withdrawal refused for having no current result rolls back and retires
>   nothing.

> ### §6b — AMENDMENT (MOTIR-4911, 2026-09-08): the `approved` WORK-ITEM status, and `decisionSource: github`
>
> **The gate state set above is unchanged and complete.** What was missing is
> everything on the OTHER side of the decision: the status the work item lands
> in, and where the decision came from.
>
> **⚠️ TWO DIFFERENT THINGS ARE SPELLED `approved`, AND CONFLATING THEM IS THE
> ONE READING ERROR THIS SECTION INVITES.** The table above is the **GATE's**
> state — one row's answer to one question. What follows is the **WORK ITEM's**
> workflow status. ~~A card can hold an `approved` `pull_request_approval` gate and
> an `awaiting` `pull_request_merge` gate at the same time (§4's amendment), and
> be at work-item status `approved` because of the first.~~ **STRUCK by §8's
> SECOND AMENDMENT (MOTIR-5609, 2026-09-16): that state no longer exists, because
> a card has exactly one approve-to-merge gate.** The warning itself stands: a
> GATE's state is not a WORK ITEM's status. The two never have to
> agree, and nothing derives one from the other by name.
>
> #### The `approved` work-item status
>
> ```
> todo → in_progress → implemented → in_review → approved → done
>                      PR open       CI green    a person   merged
>                                                said yes
> ```
>
> `in_review → approved → done`, joining the project's default workflow beside
> the seven statuses it already has. **Its CATEGORY is `in_progress`. Only `done`
> and `cancelled` are terminal**, and that is the load-bearing field rather than
> a detail of presentation — **three things follow from it, and each would be a
> defect if the category were `done`:**
>
> | consequence           | what the `in_progress` category buys                                                                                                                                             |
> | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **open counts**       | an `approved` card is still OPEN in every count, board column total, sprint burndown and report. A card whose pull request has not merged has not shipped                        |
> | **the parent rollup** | `parentStatusRollupService` must NOT complete a container out of `approved` children. A story is finished when its work is on `main`, not when somebody said yes to it           |
> | **dependents**        | cards `blocked_by` it stay BLOCKED. Readiness is computed from `done`, so an approved-but-unmerged blocker cannot make a dependent claimable against substrate that is not there |
>
> **This record does not decide the status's MIGRATION** — its transitions, its
> position, and the `restricted`-policy edges it needs are a sibling story's.
> What is decided here is the status, its category, and the three consequences
> above.
>
> #### `decisionSource` gains `github`
>
> §6a already records **through which SURFACE** a decision arrived — `ui | api |
mcp`. **A fourth value, `github`, is required**, because a pull request
> approved in GitHub's own review UI syncs into the
> `pull_request_approval` gate (§4's amendment, §8 row 4b) and none of the three
> existing values is true of it: nobody clicked in Motir, no token called an API,
> no agent called the MCP.
>
> **⚠️ AND THE APPROVING ACTOR MAY BE A GITHUB IDENTITY MOTIR CANNOT MAP TO A
> MEMBER.** A reviewer with no linked Motir account, a GitHub App, a former
> member whose row is gone. **The record states that in WORDS rather than leaving
> `decidedById` null**, because `decidedById: null` already means something else
> and something worse: §6b's `superseded` state uses exactly that shape to mean
> **the question was withdrawn and nobody decided it**. An unmappable human
> approver recorded as a null FK is therefore indistinguishable, in the one table
> an auditor trusts, from a decision that never happened.
>
> So the row carries the **denormalised actor label** §6a already requires — for
> this case the GitHub login and the fact that it did not resolve to a member —
> beside the nullable FK. The audit then answers _"who approved this?"_ with _"a
> GitHub identity we could not map, and here is the handle"_, which is true,
> legible, and not the same sentence as _"nobody"_. It is the same argument §7a
> makes about `auto`: **an absence and an unattributable presence must not read
> the same.**

> ### §6b / §6c — AMENDMENT (MOTIR-5234, 2026-09-18): a press carries a STAMP of what the reader was shown
>
> **Story MOTIR-5232.** §6b's `superseded` refuses a WITHDRAWN question. It cannot refuse a
> press from a page rendered an hour ago about a question that is still live but has CHANGED,
> because the decide door recorded nothing about what the reader saw. Two changes were
> uncaught: the card's **acceptance criteria** (the how-to-test a reviewer judges against)
> belong to no subject, so editing them supersedes nothing; and since MOTIR-5652, one press on
> a design with pull requests also decides the card's approve-to-merge gate and merges its
> members, and that press did not check them.
>
> **Decided:**
>
> 1. **Every read that renders a gate returns a `stamp`** (`WorkItemGateRead.stamp`, and the
>    overlay's `ApprovalGateOverlayReadDTO.stamp`). **The decide door REQUIRES it**
>    (`DecideGateInput.stamp`, no default). A surface hands back what it was handed, and the
>    REST route refuses a body without one with a `400`.
> 2. **What it covers:** the pressed gate's `subjectVersion`; for a `design_result` gate, the
>    `subjectVersion` of the card's awaiting `pull_request_approval` gate (the _companion_ the
>    press also decides); and the work item's `descriptionMd`. **Nothing else.** The assignee,
>    labels, status, watchers and `updatedAt` never make a decision stale. `lib/approvalGates/stamp.ts`
>    is the only definition.
> 3. **Derived, never stored.** No column, no migration, no backfill.
> 4. **Opaque to the client, composite on the server.** One digest per component, so the door
>    can say WHAT moved: `subject` · `pull_requests` · `criteria`. A pressed approve-to-merge
>    gate reports its own subject as `pull_requests`, because that is what its reader was looking at.
> 5. **It errs wide.** The whole `descriptionMd` is hashed, so a typo fix also invalidates. A
>    false stale costs one re-read; a missed one applies an approval to a question that changed.
> 6. **Checked UNDER THE LOCK, AFTER the state refusals** (`decide` step 3b), recomputed from the
>    locked gate, the item read after it, and the companion as it stands. A mismatch raises
>    `APPROVAL_GATE_STALE_SUBJECT` (`409`, carrying `moved`) and writes nothing: no state, no
>    audit columns, no status, no pin. **It runs BESIDE §6b's supersede check and never replaces it.**
>    `superseded` means _withdrawn, leave_; stale means _still yours, look again_.
> 7. **The ONE bypass is a symbol, `DECIDED_WITHOUT_A_READER`**, for a decision nobody pressed:
>    the GitHub review sync (§8's fourth amendment), and the companion gate inside
>    `approveDesignAndMerge`, whose primary was already checked. A symbol cannot be serialised,
>    so no request can carry it.
> 8. **The two-gate press decides the companion only while its version is the one checked.**
>    The door returns the companion version it read under its lock, and `approveDesignAndMerge`
>    leaves a companion raised since then awaiting. Its commits are a new question.
>
> **The refusal is the mechanism.** A live _this changed while you were reading_ notice is
> MOTIR-5243's (Story MOTIR-5238) and reads its own stream. It does not replace this check.
> The refusal's copy and its one control are drawn in
> `design/work-items/approval-control--stale-refusal.mock.html` (MOTIR-5233) and built by MOTIR-5235.

#### 6c. Retention — only an approval keeps its bytes, and it PINS rather than FREEZES

**Yue:** _"I don't think we should keep the not approved versions. We don't need
to record all the user behaviours, we just need to record the user said 'yes'
behaviour — the 'yes' moves the project and agent forward."_

**Evidence is retained for decisions that had an EFFECT.** An auditor asks _what
authorised this change?_, and only an approval answers it: a rejection moves
nothing, the agent revises, and the next version supersedes the one sent back.

|                     | the gate ROW                   | the subject's BYTES                 |
| ------------------- | ------------------------------ | ----------------------------------- |
| never decided       | no gate, or `superseded`       | superseded → reclaimed after 7 days |
| `changes_requested` | **kept** — who, when, the note | superseded → reclaimed              |
| **`approved`**      | **kept**                       | **PINNED — kept indefinitely**      |

So the trail still says _"Yue sent v1 back on the 8th because the confirm step
was wrong."_ It does not keep a picture of v1. **That is the intended loss.**

**The mechanism is a PREDICATE on an existing branch.**
`withdrawCurrentForWorkItem` already makes a row non-current without unlinking
its attachments. The supersede path gains the same behaviour under one more
condition: **do not unlink the attachments of a row an approved gate
references.** The pin is written **in the same transaction as the decision** —
written afterwards, a republish racing an approval re-opens the window it exists
to close.

~~**⚠️ PIN, do NOT FREEZE — this is where we deliberately diverge from
`acceptance-receipt-lifecycle.md`.** The acceptance gate refuses to supersede an
approved receipt at all (`AcceptanceEvidenceAlreadyApprovedError`, 409,
MOTIR-2764). That is right for a story that is finished and **wrong here**: a
design legitimately evolves after approval, and 9.2's revise loop depends on
republishing. The design path keeps superseding; it simply stops feeding
approved blobs to the GC.~~ **AMENDED 2026-09-15 (MOTIR-5554):** a design
evolves after approval only once a person reopens its card. A design card in the
`done` status category is CLOSED — read the _A DONE DESIGN CARD IS CLOSED_
amendment below, which retires this divergence. The pin itself is unchanged.

> ### §6c — AMENDMENT (MOTIR-4911, 2026-09-08): the pin is keyed on the SUBJECT, never on the gate KIND
>
> **What FAILS SILENTLY as written, and this is the expensive one.** The
> mechanism paragraph keys retention on the **`design_result` gate**:
>
> ~~The supersede path gains the same behaviour under one more condition: **do
> not unlink the attachments of a row an approved gate references** [where the
>
> > approved gate is the `design_result` one].~~
>
> **A design with a pull request is approved through `pull_request_approval`, not
> through `design_result`** (§1's amendment: the KIND is chosen by whether there
> is a pull request; the PORT is chosen by what the card produced). So the clause
> as written **stops pinning for the common case** — a design card that opened a
> pull request, which is most of them.
>
> **⚠️ Keying retention on the gate KIND would fail with no error and no red
> test: the supersede path simply stops finding an approved `design_result` gate,
> unlinks the attachments as it always did, and the orphan-GC reclaims the bytes
> seven days later — so the failure is invisible for a week and then arrives as
> an approval pointing at nothing.**
>
> **THE CORRECTION — key it on the SUBJECT.** ⚠️ **When a WORK ITEM carrying a
> current design result is approved, pin THAT version's assets — whichever gate
> kind carried the decision.** The predicate is _does an approved gate on this
> work item reference this `DesignEvidence` version?_, and it does not read the
> gate's `kind` at all.
>
> **Everything else about §6c is unchanged**, and each half is now stated against
> the subject rather than the kind:
>
> - **PIN, do not FREEZE.** The design path keeps superseding; it stops feeding
>   approved blobs to the GC. The divergence from
>   `acceptance-receipt-lifecycle.md` stands for the reason given.
> - **Written in the SAME TRANSACTION as the decision** — written afterwards, a
>   republish racing an approval re-opens the window it exists to close.
> - **PER APPROVED VERSION, never "the approved one"** (§6d) — approvals
>   accumulate, and a card approved, reopened and approved again holds two pinned
>   sets.
> - **Only approvals pin.** `changes_requested` and `superseded` keep the ROW and
>   let the bytes go, which is the intended loss.
>
> **The general form, worth stating once because the next kind will need it:**
> §1's registration table asks a handler for _what to RETAIN on approval_, and
> the answer is a property of the SUBJECT — what was decided — never of the gate
> that carried the decision. A retention rule keyed on a kind is a rule that
> stops applying the moment the same subject can be decided through a second
> door, which is exactly what happened here.
>
> **`design-result.md` §7 carries the pointer** — its statement of this clause is
> amended in the same pull request, because the trigger it was told about has
> changed.

> ### §6c — SHIPPED (MOTIR-4913, 2026-09-10), and the AMENDMENT's restatement of the predicate is CORRECTED
>
> **The mechanism is a nullable `design_evidence.pinned_at`**, written by the
> decide door on every APPROVAL — step 4b, in the decision's own transaction —
> and read by the supersede path as one predicate on an existing branch: a row
> with `pinned_at` set is made non-current WITHOUT its attachments being unlinked,
> so the orphan-GC never reaches them. PIN, not FREEZE: the supersede always
> proceeds.
>
> **⚠️ THE AMENDMENT ABOVE RESTATES THE PREDICATE AS _"does an approved gate on
> this work item reference this `DesignEvidence` version?"_, AND THAT SENTENCE IS
> NOT IMPLEMENTABLE — the correction it is part of is what proves it.** A gate
> references its subject through `subject_id`, and a `pull_request_approval`
> gate's subject is a PULL REQUEST, not a design version. So the only gate that
> can be found "referencing this `DesignEvidence` version" is a `design_result`
> one — which is exactly the kind-keying the amendment was written to remove. The
> amendment's own governing sentence is the correct one and is what shipped:
> **when a work item carrying a current design result is approved, pin THAT
> version, whichever gate kind carried the decision.**
>
> **So the pin is a WRITE at decision time, not a JOIN at supersede time**, and
> the difference is not cosmetic. At the moment of the decision the product knows
> which version was current; at supersede time it can only know which gates
> exist, and for every kind but one those gates say nothing about design bytes.
> Writing the answer down is also what §6c already required for a second reason —
> _written in the same transaction as the decision_ — so the two halves of the
> rule turn out to be the same instruction.
>
> **What this buys, concretely:** the door contains no reference to a gate kind,
> and `pull_request_approval` inherits the pin the day MOTIR-4909 / MOTIR-4910
> register it, with no line of code in its handler.
>
> **First pin wins on any one row.** §6d's _per approved version_ accumulates
> across DIFFERENT rows; re-approving the SAME version keeps the timestamp of the
> decision that first bought the retention, rather than quietly re-dating it.

> ### §6c — SECOND AMENDMENT (MOTIR-5554, 2026-09-15): a DONE design card is CLOSED — it accepts no new version and gives up none
>
> **Decided by the requester (Yue, 2026-09-15).** Read on `origin/main` @
> `570ecd199`.
>
> **The question.** What happens when a design result is published, an upload
> grant is minted, or the current result is withdrawn, on a design card that is
> already `done`?
>
> **The options.**
>
> 1. **Keep _pin, do not freeze_.** The supersede always proceeds, so a `done`
>    card's current design can change. That was this section's rule, restated in
>    the comment above `DesignEvidence.pinnedAt` in `prisma/schema.prisma` and in
>    `designEvidenceService`'s supersede comments.
> 2. **A publish onto a `done` card moves it back to review.** Rejected: it puts a
>    status write on the publish path, and it lets an agent silently reopen a
>    decision a person made.
> 3. **Close the `done` card — CHOSEN.** The publish, the mint and the withdrawal
>    are refused. The way back is a person reopening the card by hand; after that,
>    today's behaviour applies.
>
> #### 1. The rule and its scope
>
> **A design card whose status is in the `done` CATEGORY accepts no new design
> result and gives up none.**
>
> - **The category, not the key.** `cancelled` is in the done category, so a
>   cancelled design card is closed too. A project that renamed its done status is
>   covered, because the category is resolved through the project's workflow and
>   never by comparing a key to the string `'done'` — the same predicate readiness
>   applies to a `blocked_by` edge (`isTerminalStatus`).
> - **The card's STATUS, never a gate.** A `done` design card whose result was
>   approved through a pull request raises no `design_result` gate at all
>   (`design-result.md` AMENDMENT 4 Q8), and it is closed exactly the same. A rule
>   keyed on the gate would miss the common case — the failure this section's
>   first amendment already recorded once.
>
> #### 2. The four acts, and the one refusal
>
> Each of these is refused on a closed card, and nothing is written — no evidence
> row, no asset row, no gate row, no supersede, no upload grant:
>
> | act                         | service method               | doors                                                           |
> | --------------------------- | ---------------------------- | --------------------------------------------------------------- |
> | publish inline              | `recordFromBytes`            | `publish_design_result` (`contentBase64`)                       |
> | publish by upload pathnames | `recordFromPathnames`        | `publish_design_result` (`pathname`) · `POST …/design-evidence` |
> | mint an upload grant        | `createUploadTokens`         | `create_design_upload` · `POST …/design-evidence/upload-token`  |
> | withdraw the current result | `withdrawCurrentForWorkItem` | `DELETE …/design-evidence`                                      |
>
> **One typed error, code `DESIGN_CARD_CLOSED`, HTTP 409** on the routes and a
> tool error carrying the same code on the MCP tools. Its message names **both
> ways forward**:
>
> - **reopen the card by hand** — the default workflow's `done → in_progress`
>   edge, a status change the card's history records; or
> - **propose a new design card beside the card that needs it, `relates_to` this
>   one** — when the old design did not cover something, rather than being wrong.
>   The closed card then stays as the record of what was decided.
>
> An agent told only _not allowed_ retries or improvises. One told these two
> things has two moves, and both leave a visible record.
>
> **The upload-grant mint is refused as well, although it writes no row**, for
> the reason the mint already refuses a card nothing waits on: a grant for a
> publish that can never succeed is bytes uploaded for nothing.
>
> #### 3. The race: a publish against the approval that closes the card
>
> A person can press Approve while an agent is still publishing. **The outcome is
> exactly one of the two, never both a new current version and a `done` status**,
> and it is reached by waiting under the lock order the two paths already share:
>
> **`approval_gate` → `design_evidence` → `work_item`.** That is the order
> `approvalGatesService.decide` takes — the gate `FOR UPDATE` (step 1), the pin's
> `design_evidence` lock (step 4), then the kind's effect, which transitions the
> card and locks the `work_item` row — and the publish path already takes the
> first two in that order (§6b's shipped note, the comment above
> `supersedeAwaitingByWorkItem`). **So the closed check reads the card's status
> AFTER the `design_evidence` lock, under a `work_item` row lock**, inside the
> publish's own transaction. Taking the `work_item` lock any earlier would
> reverse the last two locks against `decide` and deadlock precisely on the
> interleaving this rule exists for. The existing order is unchanged.
>
> The approval that CLOSES a card is §8's first arm — no open pull request, so
> approving writes `done`. (With a pull request open, approving writes `approved`
> and the merge writes `done`; part 7 below.)
>
> - **The approval wins** → the publish waits on the gate row (or on the
>   `design_evidence` row the pin holds), then reads a `done` status and is
>   refused. Nothing is written.
> - **The publish wins** → it commits a new version and supersedes the prior
>   version's `awaiting` `design_result` gate; `decide` then re-reads that gate
>   under its own lock and refuses it as `superseded`. The card is not `done`.
>
> The pre-checks the publish makes before it uploads are courtesies that stop a
> doomed publish writing orphan objects. **The read inside the transaction is the
> authoritative one**, exactly as for _does work wait on this?_. The withdrawal
> takes the same order — `design_evidence`, then `work_item`. The mint writes
> nothing, so its check needs no lock.
>
> #### 4. What is unchanged
>
> - **Every card that is NOT `done`.** Supersede, pin, retention, idempotency and
>   the gate lifecycle behave exactly as before. **The revise loop is untouched**
>   — publish, changes requested, publish again — because it runs before
>   approval.
> - **The pin.** An approval still pins the version it was given on; §6d's
>   _approvals accumulate_ still holds. A card approved, reopened and approved
>   again holds two pinned versions.
> - **Reopening.** §6d's lifecycle step 4 is now the ONLY way back: after a
>   person moves the card `done → in_progress`, it is open, a new version
>   publishes as it does today, and it is decided again.
> - **No status, no column, no migration.**
>
> #### 5. What it supersedes
>
> - **_PIN, do NOT FREEZE — a design legitimately evolves after approval_** —
>   struck above. Its replacement: **a design evolves after approval only once a
>   person reopens its card.**
> - **The divergence from the acceptance domain is RETIRED.** This section called
>   it deliberate: the acceptance gate refuses a republish over an approved
>   receipt (`AcceptanceEvidenceAlreadyApprovedError`, 409, MOTIR-2764) while the
>   design path kept superseding. The two now agree that a decided subject is not
>   silently replaced. They still differ in WHAT they key on — the receipt on its
>   own `approved` status, the design on its CARD's status — because a design
>   result has no status of its own, and a card can be reopened while a receipt
>   cannot.
>
> #### 6. Why
>
> The next story in this epic (MOTIR-5553) hands every agent run the current
> result of a `done` design card as _the approved design_. That reading is true
> only if the result cannot change while the card is `done`. Under _pin, do not
> freeze_ it could, and the card would still say the decision was made.
>
> #### 7. Deliberately NOT decided here
>
> - **A card at `approved` with an open pull request** — decided, but not yet
>   `done` until the merge (§2b). This rule closes the `done` category and nothing
>   else, so a publish in that window still supersedes, and after the merge the
>   card can be `done` with a current version nobody approved. Which version a run
>   is handed as _the approved design_ — the pinned one, or a closed `approved`
>   window — is MOTIR-5555's to decide; the finding is on that card.
> - **What an agent is handed from an approved design** — MOTIR-5553's own
>   decision card.
>
> #### Which card implements which part
>
> | part     | card                                                                                |
> | -------- | ----------------------------------------------------------------------------------- |
> | 1–3      | MOTIR-5556 — the refusal, `DESIGN_CARD_CLOSED`, every door, the in-transaction read |
> | 3, 4     | MOTIR-5558 — the approve → refuse → reopen → accept seam and the race, on Postgres  |
> | the walk | MOTIR-5559 — the browser E2E                                                        |

#### 6d. The reopen lifecycle, and why the guard keys on `awaiting`

**Yue:** _"if a design is approved, the card should be marked to done. Our agent
run will never be instructed to reopen the card again, but the project
management system is allowed to reopen the card, so the user may open the card
manually and run again, then the new design needs to be approved again, the old
approved design should be kept."_

1. A design result is published → a gate is created `awaiting`.
2. Approving records the decision, pins that version, and moves the design
   subtask `done`.
3. **No agent ever reopens that card** — a dispatched run is never instructed to.
4. **A person may**, through the ordinary board (`Done → In Progress`, a declared
   transition).
5. The new run publishes a new design result, which supersedes the old row and
   gets its own new gate, `awaiting`.
6. **Every previously approved version stays pinned. Approvals ACCUMULATE.**

**The pin is PER APPROVED VERSION, never "the approved one."** A card approved,
reopened and approved again holds two pinned sets, both fetchable. The naive
singular would silently destroy exactly the history this policy exists to keep.
The bound is human clicks, which is inherently small.

**A guard on manual status changes keys on `awaiting`, not on "a gate exists"** —
which is what makes the reopen legal: after approval the gate is `approved`, so
a person reopening the card is not blocked by the decision that already
happened. ~~That guard is a sibling story, not this record's to ship.~~
**AMENDED 2026-09-14 (MOTIR-5522):** the guard is still built by a sibling
story (MOTIR-4887), but its RULES are now this record's, in the amendment
directly below. Build to them.

> ### §6d — AMENDMENT (MOTIR-5522, 2026-09-14): the manual-flip GUARD, the withdraw, the re-ask, and the lock order
>
> **Why the rules are written here and not on the cards.** Five cards under
> MOTIR-4887 change `applyStatusTransition` — the funnel every status change
> passes through — or render what it refuses. Each needs the same answers: which
> move a gate holds, how its own approval gets through, when pulling work back
> withdraws the question and when coming back asks it again, and in what order
> rows are locked. Stated once, here, those cards build to one contract rather
> than to each other's guesses. Read on `origin/main` @ `cc09db183`.
>
> #### 1. What a gate OWNS is the registry's answer, resolved per project
>
> A gate owns the status its kind's `GateHandler.statusIntent`
> (`lib/approvalGates/registry.ts`) resolves to in the item's project — **key
> first, then category**, the same rule `workflowsService.resolveStatusKey`
> applies for the decide door. Three things own NOTHING:
>
> - **A `null` intent** — `pull_request_merge` (§4), where the webhook is the one
>   writer of `done`.
> - **A kind this build does not register** (`isRegisteredGateKind` false). Such
>   a row has no door it can be decided through, so refusing its move would
>   strand the card with no way forward.
> - **An intent the project's workflow cannot resolve** — a custom workflow with
>   no status of that key or category. There is nothing to hold.
>
> **Never a `design_result` literal.** The guard reads the handler, so the next
> kind (`pull_request_approval`, the acceptance receipt) is covered the day it
> registers, with no line of guard code.
>
> _Why:_ the kind already declares what approving it moves. A guard with its own
> list of kinds and statuses is a second declaration, and the two drift.
>
> #### 2. The key is `awaiting`
>
> Only an `awaiting` gate refuses. `approved`, `changes_requested` and
> `superseded` refuse nothing.
>
> _Why:_ this is what keeps the reopen path above legal. After approval the gate
> is `approved`, so a person reopening the card is not blocked by a decision that
> already happened; a `changes_requested` gate has already sent the work back;
> a `superseded` one asks nothing.
>
> #### 2b. It is about whether there is a PULL REQUEST — with one open, `approved` and `done` each have ONE writer — ADDED 2026-09-14 (Yue)
>
> **Yue:** _"when the design work item has a linked PR, approve the design should
> change the status to approved, and merge should be auto triggered or auto
> enqueued, webhook changes approved to done after PR merge. if no PR, the work
> item status will be changed to done after approving. so it's about if there's a
> PR. if there's a PR, the design gate is actually gone, approval gate is the
> trigger merge gate like any other regular PR"_ — and, of this story's guard:
> _"not only done is blocked, approved manual set should be blocked too."_
>
> | the work item has…                  | the decision…                              | `approved` is written by                     | `done` is written by  |
> | ----------------------------------- | ------------------------------------------ | -------------------------------------------- | --------------------- |
> | **no open pull request**            | the kind's own gate (e.g. the design)      | —                                            | **approving**         |
> | **an open delivering pull request** | the approve-to-merge gate (§1, MOTIR-4909) | **approving**, which also merges or enqueues | **the merge webhook** |
>
> So, beside rule 1's hold on an `awaiting` gate's owned status, **while the item
> has an OPEN delivering pull request a hand move INTO `approved` is refused unless
> it is the deciding gate's own write, and a hand move INTO the done category
> (Cancelled excepted) is refused outright.** Same code, `APPROVAL_GATE_PENDING`:
> `waitingOn: 'decision'` for `approved`, `waitingOn: 'merge'` for `done`. The
> payload's `canDecide` is true only when a gate is actually awaiting a decision —
> never for the merge wait, and never while the pull request is open but not yet
> green, when no gate has been raised (the refusal then names the
> `pull_request_approval` kind with no gate id).
>
> - **Checked BEFORE rule 1**, because with a pull request open the answer to
>   "what is Done waiting for?" is the merge, whichever gate rows exist.
> - **The merge itself passes.** The status sync commits its pull request as
>   closed before it transitions the card, so it sees no open delivery (and a
>   sibling still open is already `deferred_open_pr`).
> - **System writes are exempt**, and the parent rollup treats the refusal as a
>   logged no-op (`approval_pending`) — a derivation must not take either status
>   from its writer, nor fail its job trying.
> - **Every other move stays open**, as rule 3 says.
> - **Not decided here:** the approve-to-merge gate itself, the `approved` write
>   and the merge or enqueue (MOTIR-4909 / MOTIR-4882), and a design card with a
>   pull request raising no `design_result` gate (MOTIR-5534). This rule is the
>   guard's half of that model and holds whichever of them has landed.
>
> #### 3. Exactly ONE move is refused per gate: the move INTO the owned status
>
> Every other move the workflow declares stays legal — `→ in_progress`,
> `→ blocked`, `→ cancelled` — and re-assignment and every field edit are
> untouched. The refusal is placed with `applyStatusTransition`'s two sibling
> gates (the artifact-evidence gate and the container-completeness gate), AFTER
> the legal-edge check.
>
> _Why:_ a pending decision must not make the card unusable. A guard that holds
> more than the one move the decision itself performs teaches people that
> approvals get in the way, and the next request is to turn them off.
>
> #### 4. The refusal has its own code, `APPROVAL_GATE_PENDING`
>
> Not `ILLEGAL_TRANSITION`: the edge IS legal, and a caller told otherwise goes
> and edits their workflow. `ContainerHasOpenChildrenError`
> (`lib/workItems/errors.ts`) makes the same argument for its own code.
>
> - **`/api/v1`** answers **422**, beside the other refusal codes on the
>   transitions sub-resource.
> - **The board move** (`POST /api/board/move`) answers **409 carrying `code`**,
>   so the board can tell it apart from an illegal edge and render it in place.
> - **Every door carries one payload** — `{ itemKey, kind, canDecide,
routedToLabel }` — with `canDecide` computed as the Approvals read computes
>   it (the permission floor AND §2's authority), so a surface never offers a
>   door that would refuse the person pressing it.
>
> #### 5. Two exemptions, and only two
>
> - **`opts.system` writes** — the importer, the downward cascade, the parent
>   rollup — exactly as both sibling gates in `applyStatusTransition` are scoped.
>   None of them is a person deciding the work is finished.
> - **The deciding gate's OWN effect.** `approvalGatesService.decide` runs the
>   kind's effect (step 5) BEFORE it writes the decision (step 6) — the order
>   MOTIR-5046 set so `outcome_ref` is written in the deciding write. So the gate
>   is still `awaiting` at the moment its own approval writes `done`. The door
>   passes THAT gate's id (`decidingGateId`), and the guard skips that gate and
>   no other: a second `awaiting` gate owning the same status still refuses.
>
> _Why:_ without the second exemption, approving a gate is refused by the guard
> the gate exists to protect, and approval breaks the day the guard ships.
>
> **A consequence, not a third exemption (recorded by MOTIR-5526, 2026-09-14): a
> MERGE is a door like any other.** `changeRequestStatusSync` moves a card
> through `workItemsService.updateStatus`, which is neither `system` nor a
> deciding gate, so a pull request that merges while a gate owning `done` is
> still `awaiting` is HELD — outcome `approval_pending`, with a note on the card
> saying so. Nothing is stranded: with the pull request merged, approving the
> gate finds no open delivery and writes `done` itself (§8's first arm). That is
> the order the gate exists to enforce — the decision, then the status — and a
> merge that skipped it is exactly the walk-around this amendment closes.
>
> #### 6. Pulling the work back WITHDRAWS the question
>
> A move that is not `opts.system`, and is either of:
>
> - a move from a status ranked at or above `in_review` (`rankOfStatus`,
>   `lib/workItems/statusLadder.ts`) to one ranked below it, other than the
>   status keyed `blocked`; or
> - any move to the cancelled status,
>
> **supersedes the item's `awaiting` gates**, in the same transaction as the
> move. **A PERSON's move, not the product's lifecycle:** the merge status sync
> moving a card out of review because one of its pull requests closed passes
> `keepPendingQuestions` and withdraws nothing here — it withdraws merge gates BY
> SUBJECT itself (MOTIR-4882), and a blanket withdraw would take a sibling pull
> request's question with it. **`→ blocked` does not:** blocking pauses the work, it does not abandon
> the question.
> **⚠️ NARROWED by §8's EIGHTH AMENDMENT (MOTIR-6971, 2026-09-30) for the MERGE
> question:** the approve-to-merge gate — and a story run's acceptance question
> beside it — exists only while the card is `in_review`, so `→ blocked` withdraws
> THAT one (`pulled_back`), and so does a system write out of review. Every other
> kind's question is still kept through `→ blocked`, as written here. The supersede writes `state` and nothing else, exactly as §6b's
> publish-path supersede does — no actor, no note, no `decided_at` — so the audit
> still cannot read a withdrawn question as a decision. Who pulled the work back
> is recorded where it already is: the work item's own status revision.
>
> _Why:_ a person who takes the card out of review has answered the question by
> other means. Leaving it `awaiting` would keep it in somebody's Approvals queue
> asking about work that is no longer on offer — and, under rule 3, would hold a
> move on a card that is no longer anywhere near it.
>
> #### 7. Entering review ASKS AGAIN
>
> **Any move INTO `in_review`**, whoever makes it, raises a fresh `awaiting`
> gate when both hold:
>
> - the item's kind resolves a CURRENT subject (a registry seam every registered
>   kind supplies; for `design_result`, the item's current design result); and
> - that subject has no `awaiting` or `approved` gate.
>
> The CI-green promotion (`lib/services/ciPromotion.ts`, which moves a card to
> `in_review` through `workItemsService.updateStatus`) is exactly the return to
> review this rule is for. The importer and the rollup reach cards with no
> current subject, so they raise nothing whatever their context.
>
> _Warrant:_ the story's own outcome. Without this rule, withdraw-then-re-enter
> leaves a card with no gate, and that card can be moved to Done by hand — the
> precise walk-around MOTIR-4887 exists to close.
>
> _Mirror, as corroboration only:_ Jira Service Management starts a new approval
> round when an issue is transitioned back into its approval step — _"an approval
> round is started and the approvers list is populated from the defined field
> when the issue is subsequently transitioned to the 'Needs Approval' workflow
> step"_ ([Atlassian Support — _How to automatically update Jira Service
> Management Approvals when Assets approvers change_](https://support.atlassian.com/jira/kb/how-to-automatically-update-jira-service-management-approvals-when-assets-approvers-change/),
> read 2026-09-14). The rule stands on the warrant above; the mirror agrees.
>
> **Rules 6 and 7 are ADDITIONAL triggers, not replacements.** MOTIR-5482
> raises and withdraws the pull-request gate on its own triggers (a delivery set
> turning green, a head moving); those stand.
>
> #### 8. Lock order: gate rows first, then the work item — on every transition
>
> The decide door locks the gate `FOR UPDATE` (step 1) and then, through the
> kind's effect, transitions the item, which locks the work item
> (`workItemRepository.lockById`). A funnel that locked the item first and then
> reached for the gate to supersede it (rule 6) would take the same two locks in
> the opposite order: a deadlock on exactly the interleaving where a person
> approves while another pulls the card back. **So the funnel locks the item's
> `awaiting` gate rows BEFORE the work item**, matching the door — the same
> argument §6b's shipped note makes for the publish path's supersede preceding
> the `design_evidence` lock. The race then resolves by waiting, onto one of two
> legitimate outcomes: the approval wins and the pull-back is an ordinary move
> off an approved card, or the pull-back wins and the decide door refuses a
> `superseded` gate.
>
> #### 9. Deliberately NOT decided here
>
> - Any notification on a withdraw or a re-ask.
> - Any new surface for a withdrawn record.
> - The acceptance receipt, which inherits all of the above when MOTIR-4949
>   registers its kind.
>
> #### Which card implements which rule
>
> | rules        | card                                                                                       |
> | ------------ | ------------------------------------------------------------------------------------------ |
> | 1–5, 2b      | MOTIR-5526 — the guard, `APPROVAL_GATE_PENDING` and its payload on every door              |
> | 6 and 8      | MOTIR-5527 — the withdraw, and the lock order                                              |
> | 7            | MOTIR-5532 — the re-ask, and the current-subject registry seam                             |
> | the surfaces | MOTIR-5528 — the item page, quick view and edit page · MOTIR-5529 — the board and the list |

### 7. `prMergeMode` — DECIDED BY THE PLANNER, tier and rename BY THE REQUESTER (Yue, 2026-09-08)

**`Workspace.subtaskPrMergeMode` becomes `Project.prMergeMode`**, and
`enum SubtaskPrMergeMode` becomes `PrMergeMode`.

- **The RENAME**, because a pull request is no longer a subtask's: a parent run
  opens ONE pull request for a whole story and links the parent. A field name
  encoding a retired cardinality is what the next reader will trust.
- **The TIER MOVE**, because a merge policy is a property of a codebase and its
  team, and a workspace holds several projects with different ones — and because
  a gate is scoped `workspaceId` + `projectId`, so reading a workspace column to
  decide a project's card is a tier mismatch.
- Both are nearly free **today**: the column has no functional reader, and will
  have one the moment §4 ships.

| value                    | behaviour                                                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`manual`**             | a `pull_request_merge` gate IS created; a person decides it. The default for a project whose repositories are imported                                                                                                             |
| **`auto`**               | **no gate is created.** The default for a project established with Motir-hosted repositories                                                                                                                                       |
| ~~**`review_on_fail`**~~ | ~~**RESERVED and UNIMPLEMENTED.** It behaves as `manual`. Stated here rather than left to be discovered; the enum value ships to avoid a later Postgres enum `ALTER`~~ — **RETIRED 2026-09-13, see the amendment below (point 4)** |

**The DEFAULT is derived from repository PROVENANCE, and it is a default rather
than a law.** A project established with Motir-hosted repositories seeds `auto`;
anything else seeds `manual`. It cannot be a law because
`lib/projectRepos/roomSections.ts` renders the Motir-hosted set and the
organisation's repositories as two sections of one project — a project can hold
both, so a provenance law for one would silently govern the other. The setting
overrides in either direction, which is what makes the deep link from the
approval surface meaningful: someone who defaulted to `manual` and cannot read a
diff can reach the switch that stops asking them.

#### 7 · AMENDED 2026-09-13 (MOTIR-5174) — WHEN the default is written, what a MIXED project gets, and what retiring the old column costs

§7 above decides the rename, the tier and that the default follows provenance.
It left three things unsaid, and Story MOTIR-4880's cards build on all three.
They are settled here, so every card reads one record rather than three plan
summaries. **One row above is struck**: `review_on_fail` is retired (point 4).

**1. The default is written at ESTABLISHMENT, not at `project.create`.** A
project row exists before it has any repositories. `projectRepository`'s create
runs long before the _"where should your code live?"_ step, whose read model is
`lib/services/projectRepoEstablishService.ts` and whose rows
`lib/services/projectRepoSetService.ts` owns. At `create` there is no provenance
to read, so the provenance default **cannot be a column `@default`**. The column
default (`manual`) is a FLOOR: it is what a row holds until something decides
the value.

- **The moment.** A project is ESTABLISHED the first time its repository set
  holds at least one row and every row is settled (`created` / `connected` /
  `skipped` — `transitions.isSettledState`, the ADR §4.1 machine's own
  definition). The check runs at the seams that settle a row or append a settled
  one: `projectRepoSetService`'s `attachRealizedRepo` (the `created` and
  `connected` hops) and `transitionRow` (the `skipped` hop), and
  `organizationRepoService`'s `linkRealized` / `connectAndLink`. Those two write
  a `connected` organisation row directly, and they are how a project connected
  to its organisation's repositories gets its set.
- **ONCE, and a stamp says whether it has happened.** `Project` carries a
  nullable `prMergeModeDecidedAt`. Null means nothing has decided the value yet
  and the floor stands. Deriving the default writes the value AND the stamp,
  under the project row's lock, and only where the stamp is null. A person
  changing the setting writes the stamp too. So later events never re-derive
  the value: re-establishing, adding a hosted repository to a `manual` project,
  or removing a row and settling the set again. **A value a person holds is
  never overwritten by a default.** Without the stamp, a floor `manual` and a
  chosen `manual` are the same bytes.
- **The backfill stamps established projects only.** The migration that adds
  `Project.prMergeMode` copies each project's workspace value, so nobody's
  effective answer changes on the day it lands. It stamps
  `prMergeModeDecidedAt` only on a project that already holds a settled row. A
  project that was already established never has an establishment event to wait
  for, so it keeps the carried value. A project that has not established yet
  gets the provenance default when it does. Nobody could have chosen the carried
  workspace value: the column was never rendered and never read.

**2. The rule is total. A MIXED project and an EMPTY one both seed `manual`.**

| the set's REPOSITORIES at establishment (a `skipped` row has none, and is ignored) | seeds    |
| ---------------------------------------------------------------------------------- | -------- |
| at least one, and **every** one is Motir-hosted                                    | `auto`   |
| at least one is not Motir-hosted — imported, or MIXED with hosted ones             | `manual` |
| **none** — an empty set, or every row `skipped`                                    | `manual` |

**Why the mixed case falls to `manual`, for a reader who never opens the code:**
asking a question nobody needed costs one click, but merging into somebody's
own repository without asking costs their trust. So Motir stops asking only when
every repository in the project is one it hosts.
§7's own argument, that a project can hold both sections
(`lib/projectRepos/roomSections.ts`), is exactly why a project that is not
wholly Motir's must not be governed by the hosted default.

**Provenance is `isMotirHostedOwner` (`lib/git/hostOwnership.ts`) and nothing
else**, composed over each realized repository's owner login with the
`hostOwner` the server resolves once (`provisioningOrgLogin()`). **Do not
re-spell the comparison.** Bug MOTIR-4892 found three surfaces spelling it three
times and disagreeing about one row, which is the whole reason that module
exists. `hostOwner: null` classifies nothing as hosted, so a deployment that
cannot provision seeds every project `manual`. That is the correct answer, not a
degraded one.

**3. Retiring `Workspace.subtaskPrMergeMode` takes THREE releases, and so it is
not in this story.** An expand/contract removal is normally two phases: move the
readers, then drop the column. Here that is one phase short, **because the
Prisma datamodel declaration is itself a reader**. A client asked for a
`Workspace` without a `select` fetches every field the model declares, and the
declaration is removed by the same commit that drops the column. The migration
is applied before the new build takes traffic, so a two-phase retirement leaves
the still-serving build selecting a column that is gone for the whole rollout. A
search for the field's name cannot find that reader, because no line names it.
The phases:

| release | what ships                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**   | Story MOTIR-4880: every application reader moves to `Project.prMergeMode`. The workspace column and its Prisma field both STAY                                 |
| **2**   | the field leaves the generated client while the column stays in the database, deployed on its own, so a build that neither selects nor names it serves traffic |
| **3**   | the column is dropped                                                                                                                                          |

Releases 2 and 3 are Story **MOTIR-5175**, `blocked_by` MOTIR-4880.

**Completed (2026-09-19).** The three phases shipped as MOTIR-4880 (readers),
MOTIR-5505 (`@ignore`, in Story MOTIR-5175) and MOTIR-5508 (the drop, migration
`20260919150000_drop_workspace_subtask_pr_merge_mode`, whose marker is
`-- @client-stopped-selecting: MOTIR-5505`). Between phases 2 and 3, MOTIR-5506
read the platform at 2026-09-19T13:58:48Z. Fly release **v595** was `complete`
and served by all four `motir-core` machines (app ×2, worker, standby worker)
from one image whose `GH_SHA` is **`5ce9c84ecfe96cb90394238367c62f5cb3d2e0f2`**.
That commit contains MOTIR-5505's merge `6dccc212f` and declares the field
`@ignore`. The column no longer exists, and the `pr_merge_mode` type stays
because `Project.prMergeMode` uses it.

**4. `review_on_fail` is RETIRED, not reserved (Yue, 2026-09-13).** Only a
**green** pull request is ever a merge candidate, in every mode. A red pull
request never reaches In Review: it belongs to the run's fix loop, and when that
loop gives up the work item is stuck, which is not an approval. So a mode that
"asks when checks fail" would put a merge approval on broken code, and no
meaning survives its name. The reason it was reserved had the cost backwards:
adding a Postgres enum value later is a cheap `ALTER TYPE … ADD VALUE`, and
**removing** one is the expensive direction.

- `PrMergeMode` is `auto | manual`. The migration that renames the type
  (`20260913120000_project_pr_merge_mode`) rebuilds it without the retired
  member, mapping any workspace that held it to `manual`, which is how it
  behaved.
- The two modes, stated against the lifecycle: **`manual`** — a person approves
  a green pull request before it merges; **`auto`** — Motir merges a green pull
  request with no gate.
- A future mode that needs a third value (e.g. _merge automatically unless the
  run had to repair its own checks_) is added then, as its own decision.

#### 7a. What the audit trail says when `auto` means no gate — DECIDED BY THE PLANNER (rung: Yue's own §6c principle)

`auto` creates no gate, which is correct and means **no human was in the loop for
that merge**. An audit must be able to say that explicitly: _"no record"_ and
_"no human reviewed this"_ must not read the same.

**An earlier draft of this record recommended writing a terminal
`auto_approved` gate. That recommendation is WITHDRAWN**, because it contradicts
the principle Yue set in §6c: the gate table records **a person saying yes**, and
an automatic merge is not a person saying yes. A synthetic approval row would put
a decision nobody made into the one table an auditor trusts to contain only
decisions people made.

**Instead: the MERGE record carries the authority it merged under.** The
`work_item_delivery` / pull-request row records that the merge was performed by
Motir under `prMergeMode: auto`, with no gate. The gate table stays exactly what
it claims to be, and the audit answers _"who authorised this?"_ with _"the
project's merge mode, not a person"_ — which is a true and legible answer rather
than a fabricated approval.

**This is the one decision in this record that the requester has not
confirmed.** It follows from their stated principle and is recorded as the
planner's reading of it; it is cheap to reverse before MOTIR-4882 ships.

> **§7 · §7a · POINTER (MOTIR-6815, 2026-09-29).** `Project.reviewAgentEnabled`
> is a second project switch, default off, and it is **EXCLUSIVE with `auto`**
> (Yue, 2026-09-29; §12.2a): it may be on only while `prMergeMode` is `manual`,
> and `auto` may be chosen only while it is off. With it on, `manual` raises
> its gate only after `agent_review` passes or is overridden at that version
> (§12.2). **§7a is untouched**: `auto` still raises no gate and writes no
> synthetic row, and no review stands in front of it.

### 8. THE TWO WORKFLOWS — NEW (MOTIR-4911, 2026-09-08), DECIDED BY THE REQUESTER (Yue, 2026-09-08)

**This section is the record's own statement of the model, not a pointer at
one.** It was settled in conversation and would otherwise live only in a plan
summary — which is read once, by whoever approves it, and then archived. A
decision record is read by everyone who builds against it, months later, and the
two workflows are the thing they will need most. §3, §4 and §6b are consequences
of what is stated here.

**The defect it fixes: approval and the merge were both trying to write `done`.**
§3 said approving flips the design subtask `done`; the shipped status sync says
the merge flips the card `done`. Both cannot be the single writer, and
_"approved but still `in_review`"_ is what that collision looks like from the
board.

**APPROVAL IS A TRIGGER, NOT A STATUS WRITE.** What it triggers is decided by one
question, asked once.

#### The discriminator: does the work item have a linked OPEN pull request?

**It is READ, never configured.** The answer comes from the work item's own
**delivery rows** — `work_item_delivery` joined to the pull request's `state`,
the same set `countOtherOpenByWorkItem` already counts for the
`deferred_open_pr` defer. There is no setting, no field on the card, and nothing
for a planner to get wrong: a card that opened a pull request has a delivery row
because `link_pull_request` wrote one, and a card that never will has none.

_(`prMergeMode` (§7) is a different question and does not enter here. The
discriminator asks whether a merge is COMING; `prMergeMode` asks whether a PERSON
decides it. `auto` still merges, so `done` still comes from the merge.)_

#### WORKFLOW A — no pull request

```
implemented → in_review → [ design_result ] → done
                           approve is TERMINAL
```

**AMENDED (MOTIR-5887, 2026-09-21): `decision_choice` takes Workflow A
beside `design_result`.** A choice never has a pull request, so nothing would
ever merge and nothing else would write `done`; choosing an option writes it.

```
implemented → in_review → [ design_result | decision_choice ] → done
                           approve / choose is TERMINAL
```

For `decision_choice` row 1 is the author writing a body that parses (there is
no agent publish), and row 3 is **Choose {option}** rather than **Approve**.

**AMENDED (MOTIR-5952, 2026-09-21): `decision_confirmation` takes Workflow A
too.** A `human` decision never has a pull request either, and it is the one
Workflow A kind with TWO terminal effects — Confirm writes `done`, Overturn
writes `cancelled` (§1's MOTIR-5952 amendment, point 7).

```
implemented → in_review → [ design_result | decision_choice | decision_confirmation ] → done
                           approve / choose / confirm is TERMINAL
                                              └ overturn is TERMINAL too → cancelled
```

For `decision_confirmation` row 1 is the planner writing a body that parses (at
lay, in the conversation), row 3 is **Confirm**, and row 3′ is **Overturn** —
which, unlike **Request changes**, is terminal: it writes `cancelled` and
records the re-plan it owes.

~~`implemented → in_review → [ design_result | decision_approval ] → done`~~
**AMENDED (MOTIR-5672, 2026-09-19): a decision never takes Workflow A.** Its
pull request is MANDATORY, so a merge always writes its `done` (§8's FIFTH
AMENDMENT, clause 2). The diagram above is the struck line with
`decision_approval` removed and nothing else changed.

| #   | event                             | actor      | status        |
| --- | --------------------------------- | ---------- | ------------- |
| 1   | the subject is published          | agent      | `implemented` |
| 2   | the gate is created `awaiting`    | product    | `in_review`   |
| 3   | **Approve** — records, pins (§6c) | **person** | **`done`**    |
| 3′  | _or_ **Request changes**          | person     | unchanged     |

**Nothing will ever merge, so nothing else would write `done`. Approval writes
it**, and that is why §3's rule is conditional rather than simply reversed.

#### WORKFLOW B — a pull request exists (design and code, IDENTICALLY)

| #   | event                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | actor                                                                                 | status         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------- |
| 1   | the agent opens the pull request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | agent                                                                                 | `implemented`  |
| 2   | CI goes green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | CI, server-side                                                                       | `in_review`    |
| 3   | ~~**both** gates created `awaiting` — `pull_request_approval` and `pull_request_merge`~~ **ONE gate created `awaiting` — `pull_request_approval`** (§8's second amendment, MOTIR-5609)                                                                                                                                                                                                                                                                                                                                                                                | product                                                                               | —              |
| 4a  | **"Approve and merge" in Motir** — ~~decides BOTH gates in ONE transaction~~ **commits the approval FIRST, then merges or ENQUEUES each pull request after that commit, deciding each merge gate only on success** (§8's amendment, MOTIR-5479, decision 5)                                                                                                                                                                                                                                                                                                           | **person**                                                                            | **`approved`** |
| 4b  | _or_ **EVERY** pull request the card delivers is approved **IN GITHUB**, each at its current head, by a reviewer with write access → ~~syncs the approval gate only; the **merge gate stays `awaiting`**~~ **decides the card's ONE gate — and the merge follows it, per member, after the decision commits** (§8's second amendment for the one gate; what a review decides is §8's FOURTH amendment, MOTIR-5590 — the set rule, which reviews count, the synced actor and its `github_review` authority). One member of several approved leaves the gate `awaiting` | **GitHub reviewer** (recorded as a member, or as `@login` when Motir cannot map them) | **`approved`** |
| 5   | merge — or ENQUEUE, where the repository has a merge queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | product, after either 4a or 4b — ~~a second press (4b)~~                              | —              |
| 6   | the merge lands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | webhook                                                                               | **`done`**     |

**Design and code take the SAME rows.** A design card that opened a pull request
— one or many — is Workflow B; only its PORT differs: the Development block shows
the design result once (the mock(s) with the note as a link), then How to test,
then every pull-request row, ~~and no `design_result` gate is raised for the card
(`design-result.md` AMENDMENT 4 Q8)~~ **and the card ALSO holds its own
`design_result` gate, which is the PRIMARY question the block is a port for**
(`design-result.md` AMENDMENT 6 Q1, MOTIR-5658).

> ### WORKFLOW B — AMENDMENT (MOTIR-5658, 2026-09-17): a DESIGN card in Workflow B holds TWO gates, and row 4a's press decides both
>
> The rows above are unchanged for a code card. **A design card with a published
> result additionally holds a `design_result` gate, presented as the PRIMARY**,
> with the pull requests beneath it as what the approval will merge. Row 4a's one
> press decides both; rows 5 and 6 are unchanged.
>
> **Row 2 is not a precondition of the design half.** The `design_result` gate
> rises at PUBLISH, so it can exist — and be pressed — before CI has spoken.
> **The merge is then HELD until green** and follows on the next green verdict
> with no second press (AMENDMENT 6 Q4). `done` still has exactly one writer.
>
> **And when a merge FAILS after row 4** — an ejection, a conflict, a failed
> validation — **the merge gate re-opens ALONE and the design gate stays
> decided** (AMENDMENT 6 Q2). A decided design gate also CLOSES the design:
> publish, upload and withdraw are refused on that card whatever its status, so a
> failure after approval can only be about the commits (AMENDMENT 6 Q3).

~~**Row 4b is WHY there are two gates rather than one.** A GitHub approval tells
Motir the code was approved and **nothing else** — it is not a merge, and
treating it as one would merge on somebody's review. And the audit needs two rows
regardless: **if one person approves in GitHub and another merges in Motir, that
is two decisions by two people, and one row could not record it.**~~

**⚠️ STRUCK by §8's SECOND AMENDMENT (MOTIR-5609, 2026-09-16), and kept visible
because it was a considered position rather than an oversight.** The product
owner has decided that approving a card's pull requests IS the instruction to
merge them, so the two gates asked one question twice. The case this paragraph
defends — a GitHub approval that is not a merge — was never built:
`githubWebhookService` has no `pull_request_review` arm. What a synced approval
does under one gate is decided by MOTIR-4910, and recorded by **§8's FOURTH
AMENDMENT (MOTIR-5590) below** — which builds the arm this paragraph says was
never built, and answers the audit worry it raises: one row, naming the reviewer
who completed the set, with the merge following the same decision rather than a
second press.

**`decisionSource` gains `github` for row 4b**, and the approving actor may be a
GitHub identity Motir cannot map to a member — §6b's amendment says what the
record holds then, and why a null FK would be the wrong answer.

> ### §8 — AMENDMENT (MOTIR-5479, 2026-09-15): the APPROVE-AND-MERGE gate — hung on the run target, about its delivery SET, raised on green, withdrawn by a moved head, and _Approve and merge_ recorded as the approval first, then a merge per pull request
>
> **What was OPEN.** §1's amendment names `pull_request_approval` and gives it
> _"**any** card **with a pull request**"_; §2 says who may press; row 3 says the
> gates are raised on green; row 4a says one press decides both gates. Nothing
> said what this gate is ABOUT when a card has several pull requests, when it
> goes away, or how a press that has to call a host is recorded by a door that
> runs in one transaction. Six cards of Story MOTIR-4909 build against those
> answers, so they are written down once, here. **Everything else in §8
> stands**: this block adds to it, strikes one cell (row 4a, above), and
> supersedes two cards' wording (decision 3).
>
> **Read at base `f174964e6`.** It is the approval half of the pair §4's second
> amendment (MOTIR-5510) is the merge half of. Where the two meet — decision 5
> here, decision 4 there — they say the same thing, and this block edits no line
> that one wrote. It is also written to merge in either order with MOTIR-5522's
> §6d amendment (open as a draft on `parent/MOTIR-4887-gate-owns-status`); see
> decision 3's last paragraph.
>
> **1. WHERE it hangs — the RUN TARGET** (rung 2: the shipped run-target
> resolution). The gate hangs on the work item the delivering run was launched
> against: `resolveRunTarget` (`lib/services/runTarget.ts`), the one resolution
> `howToTestService.getForWorkItem` returns as `runTarget` and §4's merge gates
> already hang on (`lib/services/mergeGates.ts`, via `resolveRunTargetFor`). **A
> child card the same pull requests also deliver gets NO gate.** Its Development
> card shows _Tested as part of_ the target instead (`design/github/design-notes.md`
> §20, Panel 12m; `howToTestService`'s `tested_via_ancestor` state). This narrows
> §1's amendment row to the run target, exactly as §4's second amendment,
> decision 1, narrows it for the merge gate.
>
> **2. WHAT it is about — the delivery SET, at its commits** (rung 2: the shipped
> uniqueness key). The subject is every pull request the run target's
> `work_item_delivery` rows name.
>
> - **`subjectId` is the work item's own id.** The partial unique index
>   `approval_gate_one_awaiting_per_subject` over
>   `(work_item_id, kind, subject_id) WHERE state = 'awaiting'`
>   (`prisma/migrations/20260908210000_add_approval_gate/migration.sql:91-93`)
>   then enforces _one awaiting approve-and-merge gate per card_, with no new
>   index.
> - **`subjectVersion` is the set written canonically**: each member as
>   `owner/name#number@headSha` — the per-member form a merge gate's
>   `subjectVersion` already uses — sorted, and comma-joined. The row then says
>   _these commits_ rather than _these pull requests_, which is §6a's first audit
>   row.
>
> **3. WHEN it is raised — the all-green verdict, in a `manual` project** (rung 2:
> §8 row 3, the shipped promotion, §7a). It is raised on the verdict
> `lib/services/ciPromotion.ts` computes in `everyDeliveryIsGreen` for the run
> target's set, and only when the project's `prMergeMode` is `manual`. It is
> raised at the same two moments as §4's merge gates: in the promotion's own
> transaction (`settleGreenVerdict`), and for a card already in review
> (`reRaiseMergeGates`). In `auto`, Motir merges without a person (§4's second
> amendment, decision 9), so a gate would sit in somebody's To-approve tab while
> the merge happened anyway. §7a's rule — no synthetic approval row — is why
> nothing is written instead.
>
> **3 · POINTER (MOTIR-6815, 2026-09-29).** With `Project.reviewAgentEnabled`
> on, the trigger above gains a clause: _all green **and** this version's
> `agent_review` passed or was overridden_. The verdict raises `agent_review`
> in its place, and the pass raises this gate at the reviewed version (§12.2,
> §12.4). Every raise path reaches it through `resolveGateSet`, so the clause
> holds on all of them.
>
> **This SUPERSEDES, by quotation, the "created when the pull request is linked"
> wording.** MOTIR-4910's scope boundary said the pull-request gates _"are
> created when the pull request is linked"_, and MOTIR-4793's sealed body
> _"created the gate when a pull request was LINKED"_. Both cards were corrected
> on the record on 2026-09-14, and the second is also superseded for the merge
> gate by §4's second amendment, decision 2. A link is not a verdict: a gate
> raised on it would ask a person to approve code CI has not judged.
>
> **If §6d's re-ask rule lands** (MOTIR-5522, rule 7: _entering review ASKS
> AGAIN_, through a current-subject seam every registered kind supplies), **this
> kind's current subject EXISTS only when decision 3 holds**: the run target's
> set is green and its project is `manual`. A hand move into `in_review` over a
> red set then raises nothing, and one rule answers when this gate is asked,
> whichever record merges first.
>
> **4. WHEN it is withdrawn — a moved head, or a changed set** (rung 2: §6b's
> `superseded`, written by the product). The awaiting gate is set `superseded`
> when any member's head moves, when a member closes, or when a delivery row
> joins or leaves the run target's set. The write sets `state` and nothing else,
> as §6b's shipped note requires. The next all-green verdict raises a fresh gate
> over the new `subjectVersion`.
>
> **4 · AMENDED (MOTIR-5901, 2026-09-21) — a MERGED member is SETTLED, so the
> re-ask above can happen.** As shipped, "the next all-green verdict" never came
> for a member that closed by MERGING. `resolveGateSet` required every member to
> be a merge candidate, and `mergeCandidateHead` answers `null` for a merged pull
> request, so a set with one member merged on the host's own button was
> unaskable for good. The gate was withdrawn (`member_closed`), nothing ever
> raised a new one, and the members still open could only be merged on the host.
> The Development frame's _"Motir asks again when every check is green"_ could
> not be kept. The only record of that behaviour was a regression guard that
> MOTIR-5805 added around its own ejection carve-out (_"…and WITHOUT an ejection
> a merged member still blocks, exactly as before"_). It was not a decision
> about a merge made on the host. MOTIR-5805 had already given the reason for
> the reverse (`gateSet.ts`, the `merged` member field): a merged member is
> settled, and nothing about it is asked again. What made it merge does not
> change that.
>
> - **A merged member is SETTLED, not blocking, in every case, not only after a
>   queue ejection.** The question is about the commits that have NOT landed.
>   `subjectVersion` still names the WHOLE set, merged members included, which
>   is the form the ejection arm already used. So the row records which commits
>   the set held when the person was asked, and approving it merges or enqueues
>   only the members still open. A merged member reaches the press as `stale`,
>   exactly as it did under the ejection arm.
> - **At least one member must still be OPEN and a merge candidate.** A set with
>   nothing left to land asks nothing, and that holds with or without an
>   ejection. (On the ejection arm, a set whose every member had merged used to
>   raise a gate. That was a latent hole, and this closes it.) A card whose
>   whole set merged is normally `done` anyway and asks nothing through
>   `cardIsTerminal`. This clause is what keeps the answer right while the
>   status catches up.
> - **A member CLOSED WITHOUT MERGING still BLOCKS, deliberately.** Its commits
>   will never land. A gate over the set would ask a person to approve a merge
>   the set cannot finish, and approving it would complete the card without that
>   member's work. Unlike a merge, closing is reversible and has two exits, and
>   both put the question back: **reopening** it makes it a candidate again on
>   its next green, and **unlinking** it changes the set (`set_changed` re-asks
>   over the smaller set). Which exit to take is a person's call about what the
>   card still delivers, and the product should not make it for them.
>   (MOTIR-5004 settles the completion gate differently for a closed member, and
>   the two are consistent. That gate asks whether the card is FINISHED, and an
>   abandoned pull request must not hold it open for ever. This gate asks whether
>   a person should be asked to MERGE, and the answer is not until they have
>   said what the closed member means.)
>
> Pinned by `tests/approvalGates/gateSet.test.ts` (the rewritten case and three
> beside it) and, through the real webhook sequence, by
> `tests/github/pullRequestApprovalGates.test.ts`'s MOTIR-5901 cases.
>
> **Why a withdraw needs its own trigger: the card never leaves `in_review` on a
> push.** Nothing moves a work item back when its pull request gains a commit.
> Re-run at this amendment's base:
>
> ```sh
> git grep -n -i "demot" f174964e6 -- lib/services
> ```
>
> It returns **10 hits in 5 files, and none is a work-item status**:
>
> | file                                            | lines              | what it demotes                            |
> | ----------------------------------------------- | ------------------ | ------------------------------------------ |
> | `lib/services/organizationsService.ts`          | 432, 434, 761, 765 | an organisation owner's role               |
> | `lib/services/projectMembersService.ts`         | 286, 288, 290      | a project member's role                    |
> | `lib/services/projectAccessService.ts`          | 327                | project members to their workspace role    |
> | `lib/services/ciRunnerBootService.ts`           | 697                | a comment on a runaway guard, not a status |
> | `lib/services/codeGraphIndexDispatchService.ts` | 1748               | a comment on a runaway guard, not a status |
>
> So a raise keyed on the `implemented → in_review` transition alone would fire
> once and never again. That is why §4's merge gates already carry a second raise
> arm for cards in review (`reRaiseMergeGates`, MOTIR-5515), and why this gate
> rides both arms (decision 3).
>
> **5. HOW _Approve and merge_ is recorded — row 4a is amended on the record**
> (rung 2: the shipped decide door, and §4's merge entry point). Row 4a said the
> press _"decides BOTH gates in ONE transaction"_. The shipped record makes that
> impossible for the merge gate, whose outcome is not known inside the
> transaction:
>
> - §4 attempts the merge and renders a refusal rather than recording one;
> - §6a writes `outcome_ref` in the deciding write
>   (`approvalGatesService.decide`, step 6: `outcomeRef: effect.statusWritten`);
> - `trg_approval_gate_decided_immutable`
>   (`prisma/migrations/20260910120000_approval_gate_audit_columns/migration.sql:138`)
>   refuses any later edit of a decided row;
> - and `decide` is one transaction in which _"nothing external happens"_.
>
> **Row 4a's AUDIT promise is kept — one person's decision, at one instant,
> naming the commits — and its MECHANISM is replaced:**
>
> - **(a) The approval commits FIRST.** `decide` runs on the
>   `pull_request_approval` gate in the door's own transaction, and the card moves
>   `in_review → approved`. A refusal the door already raises (not authorised,
>   already decided, superseded) ends the press, and nothing is merged or queued.
> - **(b) Each pull request is then handed to §4's merge entry point, AFTER that
>   commit and outside any transaction** — `pullRequestMergeService.approveMergeGate`
>   (MOTIR-5517), in `subjectVersion`'s canonical order. **That path MERGES it,
>   or ENQUEUES it where the repository has a merge queue** (§8 row 5: _merge — or
>   ENQUEUE_; §4's second amendment, decision 6). Every member is attempted: a
>   refusal on one does not stop the next, because the approval covers all of
>   them.
> - **(c) Each `pull_request_merge` gate is decided only once that path reports
>   success.** It carries the approval's `decidedById`, its `decisionSource`, and
>   the approval's `decidedAt` as its own — the press instant, supplied rather
>   than stamped again, so the rows of one press agree. The shipped door stamps
>   `decidedAt: new Date()` itself, so the press adds an internal input that only
>   its own service may pass (MOTIR-5483). **Its `outcomeRef` is `null`.**
>   `outcome_ref` is the status KEY the decision applied, and the item page paints
>   it as one: `OptimisticStatusProvider.tsx` reads `ApprovalGateDTO.outcomeRef`
>   as _"the status KEY the deciding transaction actually applied"_. A merge gate
>   applies none. The merge commit, or the queue entry for an enqueue, is recorded
>   on `github_pull_request.merge_outcome_ref` with `merge_authority = 'gate'` by
>   §4's path — §4's second amendment, decision 4(c).
> - **(d) A queued pull request leaves the card `approved`.** `done` still
>   arrives only through the merge webhook, when the queue lands it. `done`'s one
>   writer is unchanged.
> - **(e) A refused merge or enqueue writes NO decision on its merge gate.** The
>   gate stays `awaiting` and decidable, and the refusal renders on the surface
>   naming that pull request. ~~and a retry is step (b) for that one gate alone.
>   The approval stands above it.~~ **⚠️ SUPERSEDED by §4's FOURTH AMENDMENT
>   (MOTIR-5800, 2026-09-19), point 8:** one approval authorizes ONE merge or
>   enqueue action, so a retry does NOT ride on the standing approval. The refusal
>   is recorded on the pull request, classed by reason, and the card leaves
>   `approved` accordingly; _Retry merge_ then DECIDES the fresh gate the class
>   raised. Kept visible as the record.
>
> **Why the approval is not held back until every merge succeeds:** a person did
> approve, at that moment, and the record should say so. A merge that did not
> happen then stays visibly unmerged under that approval, rather than hiding
> behind it or erasing it.
>
> **6. WHO may press — §2 as SHIPPED, restated so no later card copies the
> superseded wording** (rung 2: `resolveGateAuthority`; MOTIR-5192, MOTIR-5292).
> The **assignee**, or the **reporter when the item has no assignee**, or
> **anyone holding `approval:decide_any`** on the project. That is
> `approvalGatesService.resolveGateAuthority`, asked by the door and asked again
> by §4's entry point for each merge gate. Nothing changes here. §2's first
> amendment, _"assignee OR reporter OR admin"_, is superseded twice (§2's second
> and third amendments), and a card that repeats it is wrong. The kind's
> permission floor is still asserted first, and routing is still
> `assigneeId ?? reporterId`, one recipient.
>
> **Which card builds which decision:**
>
> | decisions    | card                                                                                                                                                                        |
> | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 2 and 6      | MOTIR-5481 — the `pull_request_approval` handler                                                                                                                            |
> | 1, 3 and 4   | MOTIR-5482 — raise and withdraw                                                                                                                                             |
> | 5            | MOTIR-5483 — the press                                                                                                                                                      |
> | the surfaces | MOTIR-5484 — the Development frame's verbs, plus `docs/approval-gates.md` and `CLAUDE.md`'s merge-gate paragraph once the behaviour ships · MOTIR-5485 — the To-approve row |
>
> **Not decided here:** §4's merge and enqueue seam and §7's modes (MOTIR-4882's);
> what a merge queue EJECTING a pull request does to the card (MOTIR-5461 —
> decided since by §4's THIRD AMENDMENT, MOTIR-5629); how one pull request's GitHub review maps onto a gate over a set (MOTIR-4910); and
> refusing a press whose stamp moved (MOTIR-5232). _What SHIPPED_'s _"What has NOT
> shipped"_ line still lists the `pull_request_approval` handler, correctly: this
> block ships no code.

> ### §8 — SECOND AMENDMENT (MOTIR-5609, 2026-09-16): ONE approve-to-merge gate per card — approving it MERGES every pull request the card delivers, and the merge gate retires
>
> **What was DECIDED, and by whom.** A card in a `manual` project carried TWO
> awaiting gates once its pull requests went green: `pull_request_approval` over
> the card's delivery set, and one `pull_request_merge` per pull request. The
> Workbench's **To approve** tab listed the same pull request twice, one row
> reading _Not built yet_. The product owner decided (2026-09-16, rung 3):
> **approving a card's pull requests IS the instruction to merge them, so it is
> ONE decision and ONE gate.** MOTIR-5603 is the defect; this block is the
> contract its seven other children build against.
>
> **Read at base `09e30b21f`.** This block STRIKES text in §4, §6b and §8 in
> place, each strike kept visible. **It supersedes MOTIR-5510's §4 second
> amendment, decision 1**, and it leaves §4's merge-and-enqueue SEAM, §2's
> authority rule and §6c retention untouched.
>
> **1. ONE GATE PER CARD** (rung 3: the decision above). The
> `pull_request_approval` gate over the run target's delivery set is the ONLY
> approve-to-merge gate. Its subject, its `subjectVersion` and its raise moment
> are unchanged from MOTIR-5479's amendment, decisions 2 and 3. **No
> `pull_request_merge` gate is raised, in either merge mode.** A second gate asks
> the same person the same question twice: if the commits are right, approving
> merges them.
>
> **2. §8 row 3 is STRUCK in place.** It read _"**both** gates created
> `awaiting`"_. One gate is created.
>
> **3. §8 row 4b's RATIONALE is STRUCK in place**, including the paragraph that
> began _"Row 4b is WHY there are two gates rather than one."_ **Row 4b's own
> promise SURVIVES** — a pull request approved on GitHub reaches Motir — but
> **what a GitHub review DECIDES under one gate is not decided here**: it is
> MOTIR-4910's, recorded by its own amendment, MOTIR-5590. The case the struck
> paragraph defended is unbuilt in any event: `githubWebhookService` has no
> `pull_request_review` arm (`lib/services/githubWebhookService.ts:192-214`).
>
> **4. A PULL REQUEST'S MERGE IS AN OUTCOME, NOT A GATE — this SUPERSEDES §4's
> second amendment, decision 1**, which reads _"**1. SUBJECT — one gate per pull
> request** (rung 2: the shipped uniqueness key)"_. That decision is struck by
> this one. Where the merge result lives is unchanged and already shipped:
> `githubPullRequestRepository.recordMotirMerge`
> (`lib/repositories/githubPullRequestRepository.ts:513-528`) writes
> `merge_authority` (`gate` | `auto_mode`) and `merge_outcome_ref` — the merge
> commit SHA, or `queue:<entryId>` for an enqueue — on the pull request itself.
> **Nothing new is stored, and both of that function's existing callers stay**:
> `pullRequestMergeService` writes `'gate'` (`:283-288`) and
> `pullRequestAutoMergeService` writes `'auto_mode'` (`:139-148`).
>
> **5. §6b's simultaneous-gates sentence is STRUCK in place.** A card can no
> longer hold an `approved` `pull_request_approval` beside an `awaiting`
> `pull_request_merge`, because the second gate does not exist. §6b's warning
> that a GATE's state is not a WORK ITEM's status is unaffected.
>
> **6. THE REFUSAL UNION SURVIVES, UNCHANGED.** The five `MERGE_*` members are
> facts about a merge ATTEMPT, not about a gate kind: they render on the card's
> own gate, and a refused pull request is retried from the Development frame
> against **(the card's approved gate, that pull request)**. Stated explicitly
> because the obvious misreading of decision 1 is that the refusals retire with
> the kind. They do not.
>
> **7. `auto` MODE IS UNCHANGED** (§7a). It raises no gate and merges or enqueues
> through the same seam, recording `merge_authority = 'auto_mode'`.
> `settleGreenVerdict` (`lib/services/mergeGates.ts:87`) is the hook BOTH modes
> pass through; only its `manual` arm's raise goes.
>
> **8. THE POSTGRES ENUM VALUE STAYS.** `pull_request_merge` is a member of
> `approval_gate_kind`
> (`prisma/migrations/20260908210000_add_approval_gate/migration.sql:36`) and
> gates already raised keep referencing it after they are superseded. **The kind
> is retired at the REGISTRY tier** — moved into `UNREGISTERED_GATE_KINDS`
> (`lib/approvalGates/registry.ts`) — **and the enum member is NOT dropped.**
> Recorded as a decision because the obvious next edit is to drop it, which would
> break every superseded row.
>
> **9. What this does NOT decide**, each with its key: what a GitHub review
> decides under one gate (MOTIR-4910 / MOTIR-5590); a merge-queue EJECTION
> (MOTIR-5461 — decided since by §4's THIRD AMENDMENT, MOTIR-5629); the decision STAMP (MOTIR-5234); GitLab merge-request approvals
> (MOTIR-5593).
>
> ### §8 — THIRD AMENDMENT (MOTIR-5624, 2026-09-16): EVERY door that approves the card's gate MERGES — the REST decide route included
>
> **The defect.** Decision 1 above is door-agnostic — _approving merges every pull
> request_ — but MOTIR-5613 made `pullRequestMergeService.decideGate` a straight
> pass-through to the decide door, and `POST /api/approval-gates/[id]/decide`
> calls `decideGate`. Approving through the route therefore moved the card to
> `approved` and merged nothing, leaving no gate for anyone to press. Only the
> item page's _Approve and merge_ (`approveAndMerge`) merged.
>
> **1. ONE ARM, KEYED ON THE SURVIVING GATE** (rung 2: decision 1 above).
> `decideGate` sends an `approve` on a `pull_request_approval` gate through the
> press's own two steps — decide first, then merge or enqueue each member — so
> the order MOTIR-5613 protected holds. Every other decision reaches the door
> unchanged. The press and the route share one internal step, so they cannot
> drift apart again. The decision still records the door it came through:
> `source: 'api'` for the route.
>
> **2. THE RESPONSE GAINS `members` — ADDITIVE** (rung 3: the route returns its
> result verbatim). The route's 200 body is the decision it always was (`gate`,
> `effect`, `filesKept`) plus `members`: one outcome per pull request, in the
> same shape the press returns (`merged` / `enqueued` / `refused` with its typed
> refusal / `no_merge_gate`). It is `[]` for a decision that merged nothing. **A
> host refusal is a MEMBER outcome of a 200, never an error status**: the
> approval committed first and stands, every other member is still attempted,
> and the refused one is retried from the Development frame (decision 6). So the
> route no longer returns a merge refusal's status, or a 502 for a host that did
> not answer, for this gate. Those now arrive as a member's `refused`
> (`UNEXPECTED` for a host that did not answer), exactly as the press reports
> them.
>
> **3. AN API CALLER MAY MERGE — NO SEPARATE KEY** (rung 3: decision 1 above and
> §2). The route is gated on the same permission floor
> (`work_item:edit`, `APPROVAL_MERGE_PERMISSION`) and the same §2 authority check
> the press uses, and the merge step re-asserts both per member. Refusing the
> verb for this kind on the route was the alternative. It was rejected because
> it would leave the API unable to approve the card at all: under decision 1,
> approving and merging are one decision. The retired
> `work_item:merge_pull_request` key (MOTIR-5616) is **not** revived. Whoever may
> approve the card's pull requests may merge them, through any door.
>
> **4. What this does NOT decide:** the GitHub-sync door's merge, which is
> MOTIR-5608's under MOTIR-4910 and the same principle applied to a third door.

> ### §8 — FOURTH AMENDMENT (MOTIR-5590, 2026-09-17): what a GitHub REVIEW decides — every member approved at its current head by a writer decides the card's ONE gate, and the merge follows
>
> **What was OPEN.** §8's second amendment (MOTIR-5609) made the
> approve-to-merge gate ONE PER CARD and struck row 4b's two-gate rationale, but
> it deliberately left row 4b's own promise — _a pull request approved on GitHub
> reaches Motir_ — undecided under the new model, naming this amendment as where
> it lands. Four things were unrecorded: how a review of ONE pull request maps
> onto a gate whose subject is the run target's delivery SET; which reviews
> count; who the decision is recorded as, under which authority, and how it
> reaches a door that requires a signed-in Motir actor; and that the merge
> follows a synced decision exactly as it follows a press.
>
> **Read at base `6471cac0f`.** MOTIR-5609's one-gate block is the BASE this
> extends, not a thing it re-decides: every rule below is stated under one gate,
> and none of them revives `pull_request_merge`. It strikes nothing in §2, §4's
> merge seam, §6c retention, or MOTIR-4909's raise and withdraw rules.
>
> **1. THE SET RULE** (rung 2: the gate's own `subjectVersion`). The gate is
> decided `approved` only when EVERY member of the set named in its
> `subjectVersion` has a countable approving review at the head that version
> names. **One member's approval decides nothing**, because the row would then
> claim commits nobody approved. `subjectVersion` is each member as
> `owner/name#number@headSha`, sorted and comma-joined
> (`deliverySetVersion`, `lib/approvalGates/deliverySetVersion.ts`) — MOTIR-5479's
> amendment, decision 2. The gate is decided **`changes_requested` on the FIRST**
> countable changes-requested review on any member; the remaining members are not
> consulted, because one reviewer asking for changes is already the answer.
>
> **2. WHICH REVIEWS COUNT** (rung 1: GitHub's own required-review rule). A
> review counts only when ALL of these hold:
>
> - its `state` is `approved` or `changes_requested` — `commented` never counts;
> - its `commit_id` equals that member's head in the gate's `subjectVersion`;
> - it has not been dismissed;
> - its author held `write`, `maintain` or `admin` on the repository when the
>   review arrived.
>
> **Per member, each reviewer's LATEST countable review is the one that counts** —
> a reviewer who requests changes and then approves has approved. This mirrors
> GitHub's own rule for required approving reviews: approvals count from people
> with write access, and a review made at an older commit is stale
> (<https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-protected-branches#require-pull-request-reviews-before-merging>).
> **A reviewer whose permission could not be READ counts for nothing.** The
> decision is safe in that direction: nothing is decided on an unverified
> permission, and the person can still approve in Motir.
>
> **3. THE ACTOR** (rung 3: §6b's amendment, and §8's `decisionSource` line
> above). Resolve the reviewer's GitHub user id through `GithubIdentity`
> (`githubUserId @unique → userId`, `prisma/schema.prisma:6191-6192`), and accept
> the resolution only when that user is a member of the gate's workspace.
>
> - **Resolved:** `decidedById` is that user, and `decidedByLabel` is the member's
>   label followed by ` (@login)`.
> - **Unresolved:** `decidedById` is `null`, and `decidedByLabel` is `@login`.
>
> `decisionSource` is **`github`** in both cases — already a member of
> `ApprovalGateDecisionSource` (`prisma/schema.prisma:4498-4513`), so no enum
> changes for it. **The pair `decisionSource = github, decidedById = null` is what
> a surface reads as _"not a Motir member"_**; it is not an error and not a hole
> in the audit, which is exactly why §6b's amendment kept a surviving label beside
> the nullable FK. The recorded actor is **the reviewer whose review COMPLETED the
> set** — the decision has one decider, and that is the one whose act made it
> true. `noteMd` lists every member's counting review, one per line, as
> `owner/name#number@sha — approved by @login`, so the row names the reviews it
> rests on and not only the last of them.
>
> **4. THE AUTHORITY — a FOURTH value, `github_review`** (rung 2: `enum
ApprovalGateAuthority` is `assignee | reporter | admin`,
> `prisma/schema.prisma:4479-4488`). None of the three is true of a GitHub
> reviewer: they are not the card's assignee or reporter, and they hold no Motir
> permission — an unmapped reviewer holds no Motir anything. So
> `decidedUnderAuthority` gains **`github_review`**: _authority conferred by the
> HOST's review permission_, which decision 2 is the check for. **§2 is unchanged
> for every Motir surface** — this value is never resolved by
> `resolveGateAuthority` and never reachable from a route, a press or the MCP.
>
> **5. THE DOOR — still exactly one** (rung 2: `tests/approval-gate-one-language.test.ts`,
> _ONE DOOR_, MOTIR-4796). A synced decision goes through
> `approvalGatesService.decide`, which stays the single caller of
> `approvalGateRepository.decide`. It arrives as an **internal option carrying the
> synced actor** — never a route, a server action or an MCP tool, because there is
> no caller to authenticate: the webhook's signature is the authentication, and
> the reviewer may have no Motir account at all. The **status transition** runs as
> the resolved member, else the workspace owner — the same fallback
> `changeRequestStatusSync` uses for a webhook-driven move
> (`lib/services/changeRequestStatusSync.ts:487-505`) — and **that actor is the
> WRITER, never the recorded decider.** The two are different questions and the
> row keeps them apart: `decidedById` answers who said yes, and the transition's
> actor answers who had standing to write a status from a webhook.
>
> **6. ⚠️ THE MERGE FOLLOWS THE DECISION** (rung 3: MOTIR-5609's model; rung 2:
> MOTIR-5479's press, §8 row 4a). Because approving the gate IS the instruction to
> merge, a synced approval runs the **SAME merge-or-enqueue the press runs, per
> member, AFTER the decision's transaction commits**, recording each outcome on
> its pull request (`merge_authority: 'gate'`,
> `githubPullRequestRepository.recordMotirMerge`). A host refusal on one member
> **leaves the approval standing** and the other members still attempted; the
> refused one is retried from the Development frame, exactly as MOTIR-5609's
> decision 6 says. **A synced approval and a press differ in WHO decided and in
> nothing else.** There is no state in which a card is approved from GitHub and
> its pull requests are left with no question and no merge — that state was the
> old two-gate model's, and it is gone.
>
> **7. FIRST DECISION STANDS.** A countable review for a gate already `approved`,
> `changes_requested` or `superseded` overwrites nothing — the database refuses it
> (`trg_approval_gate_decided_immutable`) — and **merges nothing a second time.**
> The delivery's outcome names what it found rather than failing: a second
> reviewer approving after the set was complete is normal, not an error.
>
> **8. A GATE RAISED AFTER THE REVIEWS ARRIVED.** Reviews are recorded **whether
> or not a gate exists** — the row is a fact about GitHub, not about Motir's
> workflow. When a gate is later raised (`raisePullRequestApprovalGate`,
> `lib/services/pullRequestApprovalGates.ts`), the recorded reviews are evaluated
> ONCE after that transaction commits. **An approval given while CI was still
> running is therefore not lost**, and the reviewer is not asked a second time —
> which is the whole promise of row 4b.
>
> **9. ONE-DIRECTIONAL.** Motir posts **no review, comment or status to GitHub**
> from any approval path. Approving in Motir must not write into a customer's
> review history: their GitHub record is theirs, and a Motir press is not a review
> by the person whose token Motir holds. Asserted by the ABSENCE of the call, not
> by a comment.
>
> **10. `auto` MODE.** No gate is raised (§7a), so a review is **recorded and
> decides nothing**; the merge there is the automatic one, unchanged
> (`merge_authority = 'auto_mode'`). A team on `auto` that reviews on GitHub gets
> the history without a second question, which is the point of the mode.
>
> **11. What this does NOT decide:** **GitLab merge-request approvals**, deferred
> to MOTIR-5593 by key. GitLab's approval model is not GitHub's — it has approval
> RULES with counts — and nothing here is written to generalise to it.

> ### §8 — FIFTH AMENDMENT (MOTIR-5672, 2026-09-19): the DECISION gate — its subject is the `docs/decisions/*.md` file in the card's MANDATORY pull request, it is PRIMARY over the merge like the design gate, and one press accepts it and merges
>
> **What was OPEN, and what was WRONG.** §1's MOTIR-4911 amendment named
> `decision_approval` and gave it _"a decision with **no pull request**"_; §8's
> Workflow A listed it as a terminal `done` writer; and _Deliberately NOT decided
> here_ left its HANDLER open — _"the resolver for a decision document, and where
> that document lives before the `pages` domain hosts it"_. **This block decides
> the handler and reverses the first two.** Each is struck in place above, and
> Story MOTIR-4907's seven other children build against the clauses below.
>
> **The requester decision it records (Yue, 2026-09-19, rung 3).** A
> `type: decision` + `executor: coding_agent` card ships its decision document as
> a FILE in a PULL REQUEST, and **the pull request is MANDATORY**. Motir builds
> **no document store and no document API** for it — no table, no asset, no
> upload door — because the lasting home for documents is a pages domain
> (Epic MOTIR-5746), and a document API built now would be thrown away. The
> decision gate works like the design gate: approval-gated, PRIMARY over the
> approve-to-merge gate, one press. Decision documents are Motir's own, at its
> ADR convention `docs/decisions/*.md`; Motir hosts no customer project whose
> layout this has to guess.
>
> **Read at base `5ce9c84ec`.** It strikes text in §1's MOTIR-4911 amendment
> table, §8's Workflow A and _Deliberately NOT decided here_, and fills §1's
> handler table's third column. It changes nothing for a design card or a code
> card: every rule MOTIR-5609, MOTIR-5479, MOTIR-5590 and `design-result.md`
> AMENDMENT 6 set stands, and this block reuses them rather than restating them.
>
> **1. THE SUBJECT — the decision document in the card's pull request** (rung 3:
> the requester decision). For a `type: decision` + `executor: coding_agent`
> card, the subject is the markdown file under `docs/decisions/` that the card's
> delivering pull request ADDS or MODIFIES, read at that pull request's HEAD.
> **Motir keeps no copy of it** — not its text, not a render, not an excerpt on
> the gate row. What Motir stores is only the file's IDENTITY at the head
> (clause 7), which is a fact about the host, not a copy of the document.
>
> **⚠️ NARROWED by §8's NINTH AMENDMENT (MOTIR-7427, 2026-10-03):** clause 2
> holds for a card whose subject is the FILE. A card with a published decision
> PAGE needs no pull request, and its approval writes `done` (NINTH, clauses 2,
> 4 and 8).
>
> **2. THE PULL REQUEST IS MANDATORY — there is no Workflow A for a decision**
> (rung 3). A decision card with no delivering pull request has nothing to
> accept, and raises no decision gate. It reaches `done` **only by a merge**,
> exactly like a code card; §8's _`done` has exactly ONE writer_ is the merge
> webhook for every decision card, always. The agent's side of this — the
> dispatch prompt telling a decision card's agent to write ONE
> `docs/decisions/<slug>.md` and open a pull request carrying it — is
> MOTIR-5682's.
>
> **3. EXACTLY ONE DOCUMENT, OR UNRESOLVABLE — and an unresolvable gate still
> HOLDS the merge** (rung 3: the principle §6c and §8 already rest on — a merge
> ships what a person said yes to). The document is the ONE `docs/decisions/*.md`
> file added or modified across the card's delivery SET (every open pull
> request the card's `work_item_delivery` rows name). Any other count still
> RAISES the decision gate, in a state that cannot be approved:
>
> | captured outcome (clause 7)           | the gate                  | Approve     | Request changes | the merge            |
> | ------------------------------------- | ------------------------- | ----------- | --------------- | -------------------- |
> | `one`                                 | resolvable over that file | allowed     | allowed         | follows the approval |
> | `none` — no such file                 | UNRESOLVABLE, says so     | **refused** | allowed         | **HELD**             |
> | `several` — two or more               | UNRESOLVABLE, names them  | **refused** | allowed         | **HELD**             |
> | `unreadable` — the host could not say | UNRESOLVABLE, says so     | **refused** | allowed         | **HELD**             |
>
> **Why a missing document does not simply raise nothing:** a decision card
> must not merge without a person accepting a decision, and _"we could not find
> it"_ must never become _"nobody had to accept it"_. A gate with no Approve and a
> held merge is the loud version of that state; no gate at all is the silent one.
> The same UNRESOLVABLE answer covers a document that the resolver (clause 8)
> cannot fetch when the port renders it — the file is gone at the head, the host
> is unreachable — and there the surface disables Approve because nothing was
> rendered to approve; the door's own refusal keys on the CAPTURED outcome, which
> it can read inside its transaction. Request changes is allowed in every row,
> because _"there is no document here"_ is exactly the answer it exists to give.
>
> **4. IDENTITY AND VERSION — `subjectId` is the CARD, `subjectVersion` is the
> document's BLOB** (rung 2: MOTIR-5479's amendment, decision 2 — the
> approve-to-merge gate's precedent for `subjectId`).
>
> - **`subjectId` = the work item's own id.** The partial unique index
>   `approval_gate_one_awaiting_per_subject` over
>   `(work_item_id, kind, subject_id) WHERE state = 'awaiting'` then enforces
>   _one awaiting decision gate per card_ with no new index — the same reuse the
>   approve-to-merge gate made.
> - **`subjectVersion` = `<owner/name>:<path>@<blobSha>`** for a resolvable
>   document — the repository, the file's path, and the git BLOB sha the host
>   reports for that file at the head. For an UNRESOLVABLE outcome it is
>   `<owner/name>:unresolvable:<outcome>@<headSha>` (the head of the member that
>   produced the outcome), so each unresolvable head is its own question and a
>   push that fixes it raises a resolvable one.
>
> **Why the BLOB sha and not the head sha — the rule this clause exists for.**
> A head sha changes on EVERY push, including a push that only fixes a test or
> a typo in code next to the document. Keyed on the head, an accepted decision
> would be re-asked after every unrelated commit, and a person would be asked to
> accept the same text again and again until they stopped reading it. The blob
> sha is git's content address for exactly that file's bytes: it changes when,
> and only when, the document changes. So:
>
> - **a push that leaves the blob unchanged keeps the decision question AND its
>   answer** — an awaiting decision gate stays awaiting over the same version, a
>   decided one stays decided — and only the merge question moves (MOTIR-5479's
>   decision 4 withdraws the approve-to-merge gate on a moved head, unchanged);
> - **a push that changes the blob SUPERSEDES the decision gate** and raises a
>   fresh one over the new version. The supersede records the cause
>   `head_moved` (`design-result.md` AMENDMENT 6 Q5): the writing path is the head
>   move, and for this kind that path writes only when the head move changed the
>   document, so a surface can render it truthfully as _"a push changed the
>   decision document"_. No new cause is minted — Q5's rule is one value per
>   writing PATH, and this is an existing path.
>
> **5. TWO GATES, ONE PRESS, THE DECISION PRIMARY — `design-result.md`
> AMENDMENT 6, clause by clause** (rung 2: the shipped design arm, MOTIR-5658 /
> MOTIR-5664 / MOTIR-5666). A decision card whose delivery set is green in a
> `manual` project holds two questions, and they have different lifetimes
> exactly as a design card's do:
>
> | gate                              | the question              | lifetime    |
> | --------------------------------- | ------------------------- | ----------- |
> | `decision_approval` — **PRIMARY** | _is this decision right?_ | **durable** |
> | the approve-to-merge gate         | _do these commits land?_  | per attempt |
>
> - **The decision gate is PRIMARY** (AMENDMENT 6 Q1): presented as the thing
>   being decided, with the pull requests beneath it as what the approval will
>   merge. `resolveGateSet`'s `primary` prefers it the way it prefers the design
>   gate.
> - **One press accepts the decision AND authorises the merge**, carried ONCE,
>   and only while the card has had no approve-to-merge gate at all — the
>   MOTIR-5666 clause `resolveGateSet` already applies to the design carry
>   (`lib/approvalGates/gateSet.ts:258-265`). Once a merge gate has existed, a
>   later push is a new question about new commits, and the decision approval
>   does not authorise it.
> - **The merge is HELD until green** (Q4): the press is never refused for CI,
>   the decision stands, and the merge follows on the next green verdict with no
>   second press — the arm `settleGreenVerdict` already carries for a design
>   approval (`lib/services/mergeGates.ts:110-122`).
> - **A failed merge re-opens ONLY the merge question** (Q2): an ejection, a
>   conflict or a refusal leaves the decision gate decided, and the routes back
>   are MOTIR-5461's _Queue again_ and a push — neither touches the decision.
>   (Q3's _a decided design gate closes the design_ has no analogue to build here:
>   the document lives in the pull request, so the only way to change it is a
>   push, and clause 4 already makes a push that changes it a new question.)
> - **`done` has exactly one writer, the merge webhook.**
>
> **Which STATUS the decision press writes: NONE.** Its `approve` returns
> `{ statusWritten: null, statusDeferredReason: 'merge_writes_done' }` — the
> arm `designResultGateHandler.approve` takes when a pull request is open
> (`lib/approvalGates/designResultHandler.ts:176-182`), and for this kind a pull
> request is always open while the gate is live. **The `approved` work-item status
> MOTIR-4905 shipped is written by the COMPANION decision** — the approve-to-merge
> gate the same press decides, through `pullRequestApprovalGateHandler.approve`
> (`PULL_REQUEST_APPROVAL_TARGET`, `lib/approvalGates/pullRequestApprovalHandler.ts:32`)
> — exactly as for a design card. When the press lands before green, no companion
> exists yet, nothing writes `approved`, and the card waits in the review band
> until the held merge follows. Request changes records the decision and moves
> nothing.
>
> **And the merge follows ONLY the decision.** While a card's decision gate is
> awaiting or unresolvable, approving its approve-to-merge gate through a door
> that is not the decision press — the REST decide route on that gate alone, or
> the GitHub review sync of §8's FOURTH AMENDMENT — merges nothing. The GitHub
> reviews are still RECORDED (FOURTH AMENDMENT decision 8), so nobody is asked
> twice; they are carried out when the decision is accepted. Built by MOTIR-5677
> with the gate set, because it is the gate set's question: _does anything still
> hold this merge?_
>
> **6. `auto` MERGE MODE — an unanswered decision HOLDS the automatic merge**
> (rung 3: §7a says `auto` means no MERGE gate; it never said no decision). In an
> `auto` project no approve-to-merge gate is raised (§7a), and the decision gate
> is raised exactly as in `manual`. **An awaiting or unresolvable decision gate
> holds the automatic merge**, and so does a decision card whose document has not
> yet been captured (clause 7's `null`), because the safe reading of _"not known
> yet"_ is _"not accepted"_. The automatic merge follows the decision's approval
> on the next green verdict. Built by MOTIR-5677, in `settleGreenVerdict`.
>
> **What the `auto` arm does TODAY for an awaiting DESIGN gate — read, and then
> reproduced:** it MERGES over it. `settleGreenVerdict`'s `auto` arm
> (`lib/services/mergeGates.ts:123-135` at `5ce9c84ec`) checks only the run
> target and returns an `AutoMergeRequest` for every merge candidate; it never
> reads the `design_result` gate, and `pullRequestAutoMergeService` checks no gate
> either. A real-Postgres spec — an `auto` project, a green design card, its
> design gate `awaiting` — got a merge back. **That is a defect, filed as
> [MOTIR-5762](motir:cmu8fyt3h007phvoi9s2sz9i6)**, and it is out of this record's
> scope: the rule for the design arm is AMENDMENT 6's, and this clause states only
> the decision arm's. The two holds are the same rule for two kinds, so whichever
> card lands second extends the first.
>
> **7. WHERE THE IDENTITY COMES FROM — CAPTURED at the head, never fetched in a
> gate transaction** (rung 2: `lib/services/gateSetFor.ts` reads every input on
> its caller's transaction and makes no network call). Which `docs/decisions/*.md`
> file a head carries is known only to the host, so it is CAPTURED onto the
> pull-request mirror when the head is observed, and the gate set and the handler
> read the captured value. Four nullable columns on `github_pull_request`,
> expand-only:
>
> | column                  | holds                                                            |
> | ----------------------- | ---------------------------------------------------------------- |
> | `decision_doc_outcome`  | `one` · `none` · `several` · `unreadable`; null = never captured |
> | `decision_doc_path`     | the file's path, for `one`                                       |
> | `decision_doc_blob_sha` | the file's git blob sha at that head, for `one`                  |
> | `decision_doc_head_sha` | the head the capture was read at, for every outcome              |
>
> **When it is captured:** on `opened`, `synchronize` and `reopened` for a pull
> request delivering a `decision` + `coding_agent` card, **and when a delivery
> row is written for such a card** (`link_pull_request`) — because a run links its
> pull request right after opening it, so the `opened` delivery routinely arrives
> before the link and would find no decision card to capture for. The read runs
> OUTSIDE any transaction (the file list is a host call), filters the head's file
> list to `docs/decisions/*.md` with an added or modified status, and writes the
> outcome. A failed read writes `unreadable` and never fails the webhook.
>
> **`changedPaths` / `changedPathsTruncated` stay what MOTIR-2922 made them: the
> MERGE's file list**, captured once at merge for the subsumption question. The
> decision columns are a separate HEAD-time fact; one column meaning two
> different moments would make both answers wrong. Built by MOTIR-5674, which also
> extends `lib/github/pullRequestFiles.ts` to return each file's `sha` and
> `status`.
>
> **⚠️ EXTENDED by §8's NINTH AMENDMENT (MOTIR-7427, 2026-10-03):** the seam
> now has its SECOND implementation, a page resolver reading a `page_version` by
> id (NINTH, clause 5). _"Its one production implementation"_ below is true of
> the file subject only.
>
> **8. THE RESOLVER — content is read through an interface, and its one
> implementation reads the host** (rung 3: the requester decision; rung 2: §1's
> MOTIR-4911 amendment, _the subject is a document with a resolver_). The handler
> resolves the document's CONTENT through a `DecisionDocumentResolver`. Its one
> production implementation reads the file at the captured head through the
> shipped core-owned read, `repoFileReadService.readFile`
> (`lib/services/repoFileReadService.ts`), whose outcomes are all NAMED
> (`RepoFileServiceResult`: `found`, `not_found`, `ref_not_found`, `too_large`,
> `unauthorized`, `invalid_path`, `unreachable`, plus `repo_not_connected` and
> `provider_unavailable`). `found` is content; every other outcome maps to a named
> UNRESOLVABLE reason, and the mapping is total. **The interface is the seam a
> later pages domain replaces** — a decision document that moves into a page is a
> new resolver and a new renderer, never a migration on the gate table, which is
> the whole reason §1's amendment made the subject opaque. **No Motir-side
> document store exists until then**, by the requester decision above. Built by
> MOTIR-5676, whose second-resolver test is what proves the seam.
>
> **⚠️ For a PAGE subject, §8's NINTH AMENDMENT clause 6 applies instead
> (MOTIR-7427, 2026-10-03):** a page version is not durable by itself, so the
> approval FREEZES it. Clause 9 below stays true of the file subject.
>
> **9. RETENTION — NOTHING is pinned** (rung 2: §6c; the retired merge kind's
> answer). The approved version is the blob sha on the decided gate's
> `subjectVersion` plus the merge commit on `github_pull_request.merge_outcome_ref`,
> and both are durable on the host: a merged blob is reachable from the trunk for
> as long as the repository exists. Motir holds no bytes to pin, so §6c's row for
> this kind is _nothing_, the same answer the retired `pull_request_merge` gave.
>
> **10. THE EXECUTOR DISCRIMINATOR** (rung 2: §1's MOTIR-4911 amendment).
> `decision` + **`coding_agent`** raises `decision_approval`. `decision` +
> **`human`** raises NONE here: a person picking one of N options is
> `decision_choice`, which Story MOTIR-4914 owns. **AMENDED (MOTIR-5887,
> 2026-09-21): `decision_choice` is keyed on `type: choice`, not on this pair —
> so `decision` + `human` raises NO gate of either kind; a person picking among
> options is a `choice` work item (§1's MOTIR-5887 amendment).** A card whose `type` is not
> `decision` never raises this kind, whatever files its pull request touches — a
> code card that also edits an ADR is a code card.
>
> **11. §1's HANDLER TABLE gains a `decision_approval` column**, filled from
> clauses 1–10 above; it is marked there as this amendment's.
>
> **Which card builds which clause:**
>
> | clauses                        | card                                                                                                        |
> | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
> | 7                              | MOTIR-5674 — the head capture and its columns                                                               |
> | 1, 3, 4, 8, 9, 10, 5's verbs   | MOTIR-5676 — the handler, the resolver and the subject summary                                              |
> | 3's raise, 4's supersede, 5, 6 | MOTIR-5677 — the gate set, the one-time carry and both merge holds                                          |
> | 2                              | MOTIR-5682 — the agent's decision lane in the dispatch prompt                                               |
> | the surfaces                   | MOTIR-5673 (design) · MOTIR-5678 (the port, and `docs/approval-gates.md`) · MOTIR-5679 (the To-approve row) |
>
> **Not decided here:** how a pages domain later imports these documents
> (Epic MOTIR-5746, Story MOTIR-5761); what the `decision` TYPE means in the
> taxonomy (MOTIR-4155, which owns `work-item-type-taxonomy.md`); how a planner
> chooses a decision card's executor (MOTIR-4915); the `human` decision path
> (MOTIR-4914); and the design arm's `auto` hold (MOTIR-5762).

#### What the two workflows settle, in one line each

- **`done` has exactly ONE writer, in both workflows.** In A it is the approval,
  because nothing else ever will. In B it is the merge webhook, exactly as when a
  person merges by hand.
- **`approved` exists so that B has somewhere to land** between _a person said
  yes_ and _it shipped_ — and it is `in_progress`-category, so the card is still
  open (§6b).
- **The discriminator is asked ONCE, at decision time**, from data the product
  already has.

### 9. HOW TO TEST is a first-class deliverable, and it belongs on the WORK ITEM — NEW (MOTIR-4911, 2026-09-08), DECIDED BY THE REQUESTER (Yue, 2026-09-08)

**A person deciding a `pull_request_approval` gate is being asked to say yes to
something they have not seen run.** The port shows what changed; that is
necessary and it is not sufficient. **So a coding card's agent writes a HOW TO
TEST section as part of its deliverable — onto the WORK ITEM, not into the
pull-request body — and the port renders it.**

**Why the work item rather than the pull request.** The gate is decided in Motir,
by someone who may not open GitHub at all; a pull-request body is a surface the
decision surface does not read. It is also the wrong lifetime — a pull-request
body is edited by whoever pushes next, while the work item is the record the
audit trail (§6a) points back at.

**It carries EVERY path available, and the diff is a link out rather than the
lead:**

| path               | what it must state                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **the preview**    | the URL the repository's own CI produced, **and its click-path** — how to reach the changed surface once it is open         |
| **locally**        | fetch, install, migrate, seed, run — then the click-path. Name the SEED that makes the surface non-empty or hits the branch |
| **what CI proved** | which lanes ran and what they assert, so the reader knows what they do NOT have to re-check by hand                         |

**A path that is unavailable is SAID to be unavailable**, with what is missing. A
reviewer who cannot tell _"there is no preview"_ from _"nobody wrote this
section"_ is being asked to approve on faith.

**⚠️ SCOPE: SELF-HOSTED REPOSITORIES ONLY.** The preview URL above is one the
repository's OWN CI produced — Motir reads it, it does not create it. **A
Motir-hosted deploy, where Motir stands up the preview itself, is epic
MOTIR-4527 (_Hosting what the agent builds — tenant applications on
motir.site_)** and is not decided here. Until it lands, a project whose
repositories produce no preview has two paths rather than three, and says so.

> ### §8 — SIXTH AMENDMENT (MOTIR-6271, 2026-09-24): a RED BUILD withdraws the question — `ci_failed` joins the cause vocabulary, and the card is HELD at Implemented
>
> **This amendment ADDS NO RULE. It adds the writing path a rule that already
> shipped has always required.** §1's MOTIR-5903 amendment, decision 2, states
> the principle over every event:
>
> > _The question rides on the green set, so **every event that takes the set out
> > of green withdraws it** … an unanswered question about a set that is no
> > longer green is not a question anybody can act on._
>
> It then enumerates the events that do so — a head move (`head_moved`), a close
> (`member_closed`), a draft (`member_drafted`), a set change (`set_changed`),
> joined later by a conflict (`conflict`, MOTIR-5914) — and **the enumeration
> omits the most direct way a set stops being green: CI reporting a failure at
> the very commits the gate asked about.** `pullRequestApprovalGates.ts`
> implemented the enumeration faithfully, so a red build retired nothing.
>
> **What that cost, observed.** On `moooon-B-V/motir-core#3112` @ `88508fb2`
> (2026-09-24) the gate was raised at `22:45:19.033` and routed to a person.
> `Vitest (3/12)` and `(6/12)` concluded `failure` at `22:58`, `CI complete` at
> `23:02:17`. The feedback consumer did everything except the one thing that
> mattered: it re-rendered its comment as _"❌ CI failed — 4 of 43 checks did not
> pass … marked **not-ready**"_ and recomputed `ciState` to `failing` — and left
> the card at In Review with an `awaiting` gate over the commit that had just
> failed. A yes on that gate is what merges it.
>
> #### 1 — the cause: `ci_failed`
>
> §6b's vocabulary is CLOSED, with **one value per writing path and no value
> meaning _unsaid_**, so a new path owes a new value rather than borrowing one.
> `head_moved` was the nearest available lie — nothing moved; the build spoke.
> `ci_failed` joins `republished` · `withdrawn` · `head_moved` ·
> `member_closed` · `member_drafted` · `conflict` · `set_changed` ·
> `pulled_back` · `unknown`, and every surface that renders a cause carries its
> sentence.
>
> #### 2 — it is the CAN'T-LAND class, so it takes the CONFLICT's shape exactly
>
> A red set and a conflicted set are the same class (§4's FOURTH AMENDMENT, § 28's
> class table) reached from two directions — one from the base, one from the
> build — so the composer mirrors
> `pullRequestMergeabilityService.withdrawForConflict`: the same lock order
> (each card's awaiting gates, then the card), the same `settleUnlandedOutcome`
> with `cant_land`, and the same rule that **ONLY a card at `in_review` moves**.
> A card already at Implemented, Approved mid-merge, or in a terminal status is
> left where it is; the gate is withdrawn either way, which is the part that
> matters for _To approve_.
>
> It lives in `ciPromotion.ts`, beside the promotion, because that module is the
> one place a CI verdict may move a card between `implemented` and `in_review`.
> Splitting the two directions would give the pair two homes to drift between.
>
> #### 3 — what it does NOT touch
>
> - **A DECIDED gate.** §8's decision 5 stands unchanged: a failure after an
>   approval re-opens the merge question through its own doors (_Queue again_, a
>   push), and never rewrites the answer a person gave.
> - **The RAISE.** This amendment does not claim the raise can be made exact, and
>   `ci-verdict-expected-check-set.md` records why it cannot: a host read sees
>   only the runs GitHub has CREATED (its failure mode 1), and an unreachable host
>   answers `null` and falls back to the recorded set (its failure mode 3). **Both
>   leave a window in which a verdict is formed over a partial set, and the
>   withdrawal is the correction this ADR's own principle prescribes for it.** On
>   `#3112` the failing lanes — `Vitest (3/12)` and `(6/12)` — were CREATED by
>   GitHub at `22:45:27/28`, eight seconds AFTER the gate was raised, so no read
>   of the host at raise time could have seen them.
> - **The re-ask.** The next green raises a FRESH gate over the commits that fixed
>   the build, through the ordinary predicate. Withdrawing without re-asking would
>   strand the card unapprovable, which is MOTIR-5604's defect from the other side.
>
> **Asserted** — `tests/github/pullRequestApprovalGates.test.ts`: the withdrawal
> and the hold at Implemented, the cause, the no-actor invariant (§6b) re-asserted
> for the new path, the fresh gate on the next green, a decided gate untouched by a
> later red, and a card not at In Review losing its gate without being dragged.

> ### §8 — SEVENTH AMENDMENT (MOTIR-6946, 2026-09-29): a set that leaves green WITHOUT going red withdraws the question too — `ci_rerunning` joins the cause vocabulary
>
> **Again this adds no rule; it adds the second writing path the SIXTH AMENDMENT's
> own principle required and its enumeration left out.** The SIXTH closed the RED
> arm of _every event that takes the set out of green_. The other arm is green →
> `running` at an UNCHANGED head: none of the causes — no head moved, no member
> closed, nothing failed — so the gate stood `awaiting` for the whole run that
> followed, and a person could press _Approve and merge_ over commits whose tests
> had not finished.
>
> **Observed.** `moooon-B-V/motir-core#3261` @ `688ce704` (2026-09-29): the gate was
> raised at `18:40:08` over a set only the acceptance lane had made green, because
> CI's workflow run was queued behind its `concurrency` group with no jobs
> (`ci-verdict-expected-check-set.md` AMENDMENT 3). CI's checks began arriving
> `pending` at the SAME head from `18:40:58`, and nothing withdrew the question.
>
> #### 1 — the cause: `ci_rerunning`
>
> A new value, for the SIXTH AMENDMENT's reason: one value per writing path and
> none meaning _unsaid_. `ci_failed` would be the nearest lie — nothing failed; the
> verdict is simply not in. Its sentence says the checks started running again and
> the question waits for them to pass; its cite is the re-ask, and that promise is
> exact — the next green at the SAME commits raises a fresh gate, no push needed.
>
> #### 2 — only at the gate's OWN version
>
> A delivery that takes the pull request's live set at its head to `running`
> (`derivePrCiState`) withdraws the awaiting merge gate ONLY where the set's
> current version (`deliverySetVersion`) still equals the gate's `subjectVersion`.
> A pending row at a NEW head is a push, which the same delivery already retired as
> `head_moved` (`withdrawPullRequestApprovalGatesOnHeadMove` runs first); this path
> never relabels it. A story run's acceptance question goes with it through the
> ordinary predicate (MOTIR-5903).
>
> It fires from BOTH doors a pending row enters by: a `pending` delivery, and a
> terminal delivery after which the reconcile recorded a pending row the host
> reported (the queued workflow run of AMENDMENT 3). The feedback consumer's
> aggregate `ciState` cannot tell the second apart from green — it reads `passing`
> while any check succeeded — so the path re-derives `running` itself, exactly as
> the promotion re-derives `passing`.
>
> #### 3 — the card, and what it does NOT touch
>
> The composer is the SIXTH AMENDMENT's (`ciPromotion.withdrawDeliveredCardsOffGreen`),
> with one narrowing: **only a card whose merge question this path just retired
> moves**, from `in_review` to Implemented via `settleUnlandedOutcome(… 'cant_land')`.
> No hold is recorded — no conflict reading, no queue exit — so the next green at
> the same head promotes it again with exactly one fresh gate. A card with no merge
> question (an `auto` project) is not asked to approve anything and is not moved.
> **A DECIDED gate is untouched** (§8's decision 5), as on every path.
>
> **Asserted** — `tests/github/pullRequestApprovalGates.test.ts` (the withdrawal, the
> hold, the single fresh gate on the next green at the same commits, a new head
> staying `head_moved`, a decided gate untouched, a red check still `ci_failed`) and
> `tests/github/ciExpectedCheckSet.test.ts` (the `688ce704` replay raising no gate).

> ### §8 — EIGHTH AMENDMENT (MOTIR-6971, 2026-09-30), DECIDED BY THE REQUESTER (Yue, 2026-09-29): the merge question is asked ONLY at `in_review` — CI all green AND the card in review, or no gate
>
> _"a CI is green doesn't mean anything, a random CI can be linked to the work
> item, when the run is finished the agent has to make the status right, that's
> part of the runbook. if the status is not right, the item stays in the in
> progress column and the run is considered dead."_ — Yue, 2026-09-29. And:
> _"a manual status flip from in review to in progress should close the gate too.
> so there is a gate only when CI is all green, the status is in review."_
>
> **Observed.** MOTIR-6914 — a story at `in_progress` with five `blocked` children
> — held an `awaiting` `pull_request_approval` gate over its two green pull
> requests (raised 2026-09-29 23:20Z). Pressing _Approve_ threw
> `IllegalTransitionError: "in_progress" → "approved"` (Sentry 7762359336, three
> presses): the MOTIR workflow reaches `approved` only from `in_review`, and
> `approved` is a container-claim status besides. The decision rolled back with the
> transaction, so the question stood and could never be answered.
>
> **Why it could be asked.** Every condition `resolveGateSet` put on the merge
> question was about the DELIVERY SET — manual mode, every member mergeable, not
> already answered, no acceptance or can't-land hold. None was about the card.
> MOTIR-5652 removed the one guard that had stood for the card (`resolveRunTargetFor
… 'ancestor'`) on purpose, so that a parent run whose promotion
> `ContainerHasOpenChildrenError` skipped would still be asked. So any reconcile —
> the 30-minute sweep, a withdrawer's re-ask, the status funnel's re-ask — raised
> the gate on a green set whatever status the card was in.
>
> #### 1 — the rule
>
> **`pull_request_approval` is `awaiting` if and only if the card's status is
> `in_review` (by KEY, never by category) AND its delivery set is all green and
> mergeable.** Leaving either condition withdraws it; only re-entering both raises
> it. A story run's `acceptance_result`, which rides the merge question
> (MOTIR-5903), takes the same condition; a subtask-run story's does not — it is
> timed by the subtree. The review agent's `agent_review` question (§12, MOTIR-1626),
> which stands in front of the merge question, takes the same condition and is
> withdrawn with it. The design and decision questions are untouched.
>
> The status is the run's own statement that it followed the runbook to the end:
> it opens its pull requests, sets the card to `implemented`, and CI's promotion
> writes `in_review`. Green CI is not that statement — any pull request can be
> linked to a card. A card still at `in_progress` is a DEAD run; it waits for a
> `motir continue` to set its status right, and nothing asks anybody to approve it.
> This REVERSES MOTIR-5652's parent-run case: a parent held below `implemented` by
> an open child is asked nothing until a run settles its status.
>
> #### 2 — where it is enforced
>
> - **The raise** — `resolveGateSet` takes `cardInReview`, loaded by `gateSetFor`
>   from the card read under the caller's lock. Every raiser goes through the
>   predicate, so the sweep, the withdrawers' re-ask and the funnel's re-ask all
>   stop asking of a card out of review at once. The funnel's re-ask reconciles
>   against the TARGET status, because it runs before the row write in the same
>   transaction. The CI promotion writes `implemented → in_review` before it
>   reconciles, so the ordinary path is unchanged.
> - **The withdrawal, on a move** — `applyStatusTransition` supersedes the awaiting
>   merge question (`pulled_back`) on any move to an open status other than
>   `in_review`: `blocked` included (narrowing §6d's rule 6 for this kind only) and
>   a system write included. Not into the done category (the merge sync and
>   Cancelled settle that), not the decide door's own write (`decidingGateId`), not
>   the merge sync's `keepPendingQuestions` move (it withdraws by subject).
> - **The withdrawal, on a reconcile** — `reconcileGatesFor` supersedes an awaiting
>   merge question on a card that is not `in_review`, as `pulled_back`. It is the
>   one exception to _it does not supersede_, and it keeps that rule's reason: the
>   cause is the card's own status, which every caller reads under its lock. It is
>   what retires a gate raised before this amendment (MOTIR-6914's) on the next
>   sweep.
> - **An `approved` card whose commits moved** (a push after the approval, then
>   green) is moved back to `in_review` — a declared edge (§4's FOURTH AMENDMENT),
>   as a system write — and asked there, by `ciPromotion.reRaiseMergeGates`. It was
>   re-asked AT `approved` before, which this rule no longer allows. A late green at
>   the SAME approved commits (MOTIR-5632) owes nothing and moves nothing.
>
> **No new cause.** `pulled_back` already reads as _the work left review_, which is
> exactly what happened, so no enum value or migration is added. **A DECIDED gate is
> untouched** (§8 decision 5).
>
> **Asserted** — `tests/integration/approvals/mergeGateOnlyInReview.test.ts` (a dead
> run asked nothing by CI or the sweep; MOTIR-6914's story shape; one gate at
> `in_review`; `→ in_progress` and `→ blocked` withdraw and nothing re-asks; a stray
> gate withdrawn; one fresh gate on coming back; the `approved` re-ask at
> `in_review`) and `tests/approvalGates/gateSet.test.ts` (the predicate's cases).

> ### §8 — NINTH AMENDMENT (MOTIR-7427, for Story MOTIR-5761, 2026-10-03): the decision's subject may be a PAGE VERSION — `publish_decision_page` seals it, approval FREEZES it and writes `done`, and a published page wins over the file
>
> **What changed, and why now.** The FIFTH AMENDMENT put a `coding_agent`
> decision in a file in a MANDATORY pull request because nothing else could hold
> a document Motir could show a person — _"the lasting home for documents is a
> pages domain (Epic MOTIR-5746), and a document API built now would be thrown
> away."_ That domain now exists: pages, their versions (`pages.md` §6) and the
> MCP doors `get_page` / `create_page` / `update_page` a dispatched agent's grant
> can use (MOTIR-5760). Story MOTIR-5761 lets a decision be a PAGE. A pull
> request costs a branch, a CI run and a merge for a document nobody builds, and
> it forces a decision to pick one repository even when its direction spans
> several. **This block adds the page path; it removes nothing.** The file path of
> the FIFTH AMENDMENT keeps working, for records already merged and for pull
> requests in flight. Its affected clauses carry a pointer here; none is struck.
>
> **1. THE PUBLICATION.** `publish_decision_page { key, pageId }` (MCP, and the
> REST route the confirm port calls) records ONE `decision_page_publication` row:
> the work item, the page, the page VERSION that was latest at the moment of the
> publish, the publisher and the time. **The newest row for a work item is its
> published page.** Earlier rows stay as history; nothing updates a row. In the
> same transaction the publish SEALS that version (`pages.md` AMENDMENT 3), so no later save can extend it. Each refusal is NAMED: a work
> item whose `type` is not `decision`; a page from another project; a page with
> an empty body; a page the caller cannot read (`page:view`); an archived page;
> a card already in the `done` category.
> The publish needs `work_item:edit` on the card, the same key the design and
> acceptance publishes need.
>
> **2. THE SUBJECT, AND WHICH ONE WINS.** For a `decision` + `coding_agent` card
> with a publication, the subject is that page VERSION, and **`subjectVersion` is
> `page:<pageId>@<versionId>`**. `subjectId` stays the work item's own id (the
> FIFTH AMENDMENT's clause 4), so the partial unique index still allows one
> awaiting decision gate per card whichever path raised it.
>
> **The precedence rule, in one sentence: a card with a published decision page
> takes the page as its subject, and a card with NO publication takes the
> `docs/decisions/*.md` file in its pull request exactly as the FIFTH AMENDMENT
> says.** A card that has both — a publication AND an open pull request carrying a
> decision file — takes the PAGE; the file is then an ordinary file in an ordinary
> pull request, and the gate set stops raising the file subject for that card.
>
> **3. RAISE, AND RE-ASK.** A page subject is raised by the PUBLISH, not by green
> CI: there is no pull request whose checks could go green. The publish raises an
> `awaiting` `decision_approval` over the published version and moves the card to
> `in_review` — forward only, through `applyStatusTransition`, exactly as
> `publish_design_result` does (`designEvidenceService`, MOTIR-6009).
>
> - **A new publication SUPERSEDES an awaiting gate** and raises a fresh one over
>   the new version. The supersede records the EXISTING cause `republished` (§6b's
>   AMENDMENT): the writing path is a newer published version, which is what that
>   value already means for a design, so no enum value is added. A publication of
>   the SAME version an awaiting gate already asks about changes nothing.
> - **An edit to the page that nobody publishes re-asks NOTHING.** The version the
>   gate asks about is sealed, so the edit lands in a new version; the port SAYS
>   the page has changed since it was published, and the question stays what it
>   was. A person decides on what the agent submitted, never on a moving document.
> - **An approved decision is closed.** Approval writes `done` (clause 4), and a
>   publish on a `done` card is refused by name, as §6c's SECOND AMENDMENT refuses
>   a new version on a done design card. After **Request changes**, a new
>   publication raises a new question, as a revised design does (§10e).
>
> **4. APPROVE — freeze, then `done`.** In the decide transaction, under the
> gate's row lock, Approve:
>
> 1. **FREEZES the subject version** — `frozen_at` and `frozen_by_gate_id` on that
>    `page_version` row (`pages.md` AMENDMENT 3). The version is
>    re-read by id under the lock; a version that no longer exists refuses the
>    press by name rather than approving nothing.
> 2. **Applies §3's AMENDMENT row _no linked OPEN pull request ⇒ `done`_.** A page
>    decision has no pull request, so nothing will ever merge and the approval is
>    TERMINAL: it writes `done` through `applyStatusTransition` and returns
>    `statusWritten: 'done'`. There is no companion approve-to-merge gate and
>    nothing to carry.
>
> **Request changes freezes nothing** and moves nothing (§3; §10's verdicts
> apply unchanged). The version stays SEALED, which is harmless: a seal only stops
> a save from extending that one version.
>
> **A page card that ALSO carries an open linked pull request** (an agent that
> published a page and opened one anyway) is the second row of §3's table: the
> press freezes and writes `approved`, and the merge writes `done`. The rule is
> §3's discriminator, read at decision time, never a special case of this block.
>
> **5. THE RESOLVER — the seam's second implementation.** `DecisionDocumentResolver`
> (`lib/approvalGates/decisionDocumentResolver.ts`) gains a page resolver beside
> the file resolver. It reads `page_version.body_markdown` by the version id the
> subject names, plus the version's number, author and save time and the page's
> title. **That read is a database read**, so — unlike the file resolver, which
> must stay outside every transaction because it calls the host — the page
> resolver MAY run inside one, and the decide door may read the subject under the
> gate's lock. Its unresolvable reasons are named: the version is gone, the page
> is gone, the reader cannot see the page. **This is the replacement the FIFTH
> AMENDMENT's clause 8 promised: a new resolver and a new renderer, never a
> migration on the gate table.**
>
> **6. RETENTION — the FROZEN mark is the pin.** The FIFTH AMENDMENT's clause 9
> pinned nothing because a merged blob is durable on the host. A page version is
> not durable by itself — a same-author save within ten minutes rewrites it, and
> the cap prunes the oldest past 100 (`pages.md` §6). So for this subject the
> approval's retention IS the freeze: a frozen version is never extended, never
> pruned, and its page cannot be hard-deleted while it holds it (`pages.md`
> AMENDMENT 3). §6c's principle
> holds exactly — only a _yes_ keeps its bytes — and a version sent back is merely
> sealed, which keeps nothing alive past the cap.
>
> **7. THE HUMAN RECORD — §1's MOTIR-5952 amendment, point 8.** A
> `decision_confirmation` card's optional written record MAY be a published page
> version: the card names the page through the same publication (clause 1), the
> confirm port shows it, and **Confirm FREEZES that version** in the deciding
> write, stamping `{ kind: 'page', pageId, versionId, versionNumber, title }` into
> the gate's record column — a new arm of the discriminated union point 8 built
> for exactly this. **It replaces the attachment for NEW records.** Attachment
> records keep rendering as they are and are NOT migrated; a gate stamped
> `{ kind: 'attachment', … }` reads as one forever. When a card has both a
> publication and a markdown attachment, the publication wins, by the same rule as
> clause 2. Overturn freezes nothing. The publish on a `human` decision card raises
> NO `decision_approval` — that kind is keyed on `coding_agent` (the FIFTH
> AMENDMENT's clause 10) — and moves no status; it only names the record.
>
> **8. WHAT THE RUN DELIVERS.** For a `decision` + `coding_agent` card, a run
> writes the decision as a page (`create_page` / `update_page`) in the card's
> project and calls `publish_decision_page`. **It opens no branch and no pull
> request.** The card's repository pin is CONTEXT the run reads — the code the
> decision is about — and is no longer the record's home. The FIFTH AMENDMENT's
> clause 2 (_the pull request is MANDATORY_) is therefore narrowed: it stays true
> for a card that takes the file subject, and a card with a publication needs no
> pull request at all.
>
> **Which card builds which clause:**
>
> | clauses                   | card                                                                                  |
> | ------------------------- | ------------------------------------------------------------------------------------- |
> | 1's columns, 4's columns  | MOTIR-7428 — the schema                                                               |
> | 6, `pages.md` AMENDMENT 3 | MOTIR-7431 — the version policy                                                       |
> | 1, 3                      | MOTIR-7432 — `decisionPageService.publish`                                            |
> | 2, 4, 5                   | MOTIR-7433 — the page subject and the freeze at Approve                               |
> | 1's doors                 | MOTIR-7434 — `publish_decision_page` and the REST route                               |
> | 7                         | MOTIR-7435 — the human record                                                         |
> | 8                         | MOTIR-7437 (the dispatch prompt) · MOTIR-7439 / MOTIR-7440 (the runbook) · MOTIR-7442 |
> | the surfaces              | MOTIR-7430 (design) · MOTIR-7436 (the port) · MOTIR-7444 (the confirm port)           |
>
> **What this does NOT decide.**
>
> - **Page ↔ work-item mention links**, and a card's _pages that mention this_ list
>   (Epic MOTIR-5747). The decision page is held by the PUBLICATION, not by a link
>   row.
> - **Archive and delete themselves** (Story MOTIR-5755). This block only adds the
>   refusal to hard-delete a page holding a frozen version (`pages.md` AMENDMENT 3).
> - **Migrating historical `docs/decisions/` records** into pages. They stay files;
>   the file resolver stays.
> - **Read-only pages.** Only the approved version is frozen; the page stays
>   editable.

> ### 9 — AMENDMENT: HOW TO TEST is per RUN (MOTIR-4906 re-plan, 2026-09-13), DECIDED BY THE REQUESTER (Yue, 2026-09-13)
>
> _"'how to test' should not be per PR, it should be per run, so the design is
> not right for a story/container run. how to test in the PR should still be
> there, the agent should produce 'how to test' in the run target before finish
> the run"_ — Yue, 2026-09-13.
>
> §9 said the section belongs on _the work item_ and the consequences amendment
> made it _"an authoring obligation on every card that produces a pull
> request"_. Read literally, that keys HOW TO TEST per card and per pull request,
> and that is the reading the first design of MOTIR-4906 drew: a block under
> every Development row. **For a story run that is wrong** — nobody accepts a
> story one child's pull request at a time. This amendment settles the unit:
>
> 1. **The unit is the RUN.** One HOW TO TEST record per run, written onto the
>    **run target** — the work item the run was launched against:
>    - a **container / parent run** (the runbook's parent run of a story) — the
>      container;
>    - a **scoped CLI run** — its scope target;
>    - a **single-card dispatch** (and each card of an unscoped batch) — the card
>      itself.
>
>    A run that touches several repositories writes **one** record with a
>    **section per repository** (that repository's head commit and setup
>    commands). The click-path is one, for the run. A child card of a container
>    run writes none of its own.
>
> 2. **The agent writes it BEFORE THE RUN FINISHES** — for a run delivered
>    through a session or parent pull request, before that pull request is
>    marked ready; for a single card, before `implemented`. Where a run finishes
>    in orchestrator code with no agent in it, the run gains a close-out step
>    that puts one there.
> 3. **The pull-request body KEEPS its How to test section.** This amends §9's
>    _"not into the pull-request body"_: the record on the work item is what
>    Motir renders; the body is what a reviewer on the host reads. Both carry the
>    same content, and neither replaces the other.
> 4. **Where it renders — ONE gate, ONE block** (Yue, 2026-09-13: _"'approve to
>    merge the PRs' is the gate, how to test is telling user how to validate the
>    PRs, so they are the same gate, not 2 separated things"_). On the run target's
>    item page the **Development block** carries the pull-request rows AND the
>    run's How to test in one section. How to test is the EVIDENCE of the one
>    gate _approve to merge the pull requests_, never a gate, section or verb of
>    its own. When that gate is awaiting, the block IS the universal approval
>    frame — its rows and How to test are the port — exactly as the Design result
>    section is for a design decision. A child card of a container run shows a
>    pointer to its run target instead. (The full-screen approval overlay is not
>    part of this amendment; it is MOTIR-5214's, for every gate.)
>
>    **Content.** The record's content is **rich text** (`bodyMd`, sections
>    allowed), written by the agent over MCP like a design note or an acceptance
>    receipt. Every command sits in a fenced code block, which renders
>    click-to-copy. Only what Motir derives stays structured: the repositories and
>    their commits, the preview, the checks CI ran, the branch fetch.
>
> 5. **Which record is current:** the newest run's. Earlier runs' records remain
>    as history.
>
> The three paths, the _an unavailable path is SAID_ rule and the self-hosted
> scope above are unchanged.

> ### 9 — AMENDMENT: a PERSON writes How to test too (MOTIR-5450, 2026-09-17), DECIDED BY THE REQUESTER (Yue, 2026-09-17)
>
> _"how to test should be able to added/edited manually, the human should be
> able to do the same job too, the human can already link the PRs, add/edit how
> to test should be the same"_ — Yue, 2026-09-17.
>
> _"the human should be able to add what an agent can add"_ — Yue, 2026-09-17.
>
> The amendment above settles the UNIT (the run) and leaves the AUTHOR implicit,
> because at the time an agent was the only one. Read literally, that makes How
> to test agent-only: a pull request a person delivered and linked by hand
> reaches its approve-to-merge gate with a _No How to test_ callout, and a wrong
> agent record can only be corrected by starting another run. Motir treats
> people as first-class executors (Principle #12), so this amendment settles the
> author:
>
> 1. **Two author kinds, one record, one writer.** A record is written by a RUN
>    — over `publish_test_instructions`, with `dispatchRunId` set while a
>    dispatch is running — or by a PERSON, from the item page, with
>    `dispatchRunId` null and `publishedById` the person. **Both go through
>    `testInstructionsService.publish`.** There is no second write path, no
>    second evidence field and no second table, and the block renders the two
>    kinds identically apart from the author line.
> 2. **What a person writes is the INSTRUCTIONS; what Motir derives is the
>    DELIVERY.** A person sets:
>    - the **rich-text body** (`bodyMd`), with headings, lists, links and fenced
>      code blocks _with their language_;
>    - the **preview path** (`previewPath`).
>
>    The **repository sections** (`repos[]`) are DERIVED from the work item's
>    linked pull requests. **A person never sets them — not through a picker,
>    not through a commit field, not as a read-only row** (Yue, 2026-09-17:
>    _"the team can still add repo/PR, they can just use the link PR feature,
>    which is there in the card already"_, and _"why read-only? they are simply
>    not needed, link a PR shows the PR in the development panel"_).
>
>    **⚠️ THE CUT IS BY WHO KNOWS, NOT BY WHAT THE WRITER ACCEPTS.** _"A person
>    may add what an agent may add"_ is a fairness rule, and reading it as
>    `publish`'s input list is what produced a form asking somebody to paste a
>    commit the page was already displaying one line higher. Nobody but the
>    person can write the instructions; nobody but Motir need supply the
>    delivery. **`+ Link pull request`, in the same Development block, is the
>    door that decides which repositories a record covers** — a second control
>    inside the form would be a second door onto one fact, and the worse of the
>    two: `assembleHowToTestRepo` composes the fetch command, the preview and
>    the checks FROM the bound pull request, so a hand-named repository renders
>    with all three empty.
>
> 3. **Motir does not decide how a team works.** A team may keep its pull
>    requests on the host and its work items in Motir and never link the two,
>    and that team must still be able to write How to test. Requiring a link
>    before the door opens would make Motir's own convention a precondition for
>    describing your work.
>
>    **So a record with ZERO repository sections is legal**, and
>    `publish` is changed to accept one: the `repos` list becomes optional, and
>    the refusal _"give one entry per repository the run pushed to — at least
>    one"_ is retired. Everything governing the entries that ARE given — the
>    cap, the 7–64 hex commit, the repository-in-the-project rule and the
>    no-repository-twice rule — is unchanged. **The form suggests nothing and
>    forces nothing**: on Edit it opens on the current record's body and preview
>    path, and on Add it opens empty.
>
> 4. **Who may write, and versions.** A person needs **`work_item:edit`** on the
>    item's project — the permission the explicit pull-request link and
>    `publish_test_instructions` both assert
>    (`githubPullRequestService.linkPullRequest*`). Only the RUN TARGET gets a
>    door; a `tested_via_ancestor` child shows its pointer and no door. A save is
>    a new current record and the previous one moves to history (point 5 of the
>    amendment above — newest wins, in both directions). Identical content writes
>    nothing.
> 5. **The pull-request body is a SNAPSHOT.** Point 3 of the amendment above says
>    the pull-request body and the record carry _"the same content"_. That is
>    amended to **the same content at the run's close-out**: after close-out
>    Motir's record is authoritative, and a person's later edit does not rewrite
>    the pull-request body. The quick-view peek and the approval overlay's port
>    (MOTIR-5214 / MOTIR-5438) draw no edit door.

### 10. A REFUSAL SAYS WHY, and what FOLLOWS a refusal, per kind — NEW (MOTIR-6072, 2026-09-23), the WHAT DECIDED BY THE REQUESTER (Yue, 2026-09-22), the HOW by the planner

**What was MISSING.** Every section above settles a refusal the same way:
`request_changes` _records the decision and moves nothing_ (§1's handler table,
§3, and every kind's `requestChanges` in `lib/approvalGates/*Handler.ts`). The
one exception is Overturn, which requires a note and writes `cancelled` (§1's
MOTIR-5952 amendment, point 6). So a person who sends a design, a video, a
decision or a set of pull requests back gets a row saying THAT they refused, and
nothing about WHY. Whoever picks the work up next (a teammate, an agent, the
planner) has to guess. And nothing happens next: §5 reserved the whole
after-a-refusal loop for Story 9.2.

**Read at base `0d01a9256`.** This section decides the rule once, for the four
stories of Epic MOTIR-6010 that build it (MOTIR-6067 · 6068 · 6069 · 6070 · 6071).
Each of them cites this section rather than re-reading the request.
**No behaviour ships in this section.** It strikes nothing above. Where it
changes what an earlier clause means, the pointer at that clause says so
(§1's handler table, §3, §5).

**What the requester settled (Yue, 2026-09-22, rung 3), written down as the
rule:**

1. A person must be able to give a **REASON** for every refusal.
2. **A decision gate** refused (`decision_approval` _Request changes_,
   `decision_confirmation` _Overturn_) means the decision is not what the
   planner and the person agreed. **The planner opens, offering a re-plan** —
   the conversation phase again, starting from the reason.
3. **A choice gate** answered _None of these_ behaves like a refused decision.
   **Choosing an option ALSO opens the planner**, offering to plan with the
   choice.
4. **A design gate** refused is a **VERDICT**: **Re-plan** (the design changes
   the cards planned after it, so the planner opens) or **Revise** (a small
   change: the reason is recorded, the design card goes back to **To do**, and a
   later agent run picks it up).
5. **An acceptance-video gate** is like the design gate. A small change inside
   the not-done work's scope is an agent **re-run**; otherwise a **re-plan**. On
   a **story run** nothing under the story is done, so the re-plan may re-plan
   ALL its subtasks. On a story whose **last subtask run** has finished,
   approval would only move the story's status, so the re-plan **plans a
   remedy**.

#### 10a. The reason is REQUIRED on every refusal a person presses — rung 3 (the requester), mechanics rung 2 (Overturn's shipped note)

- **Scope.** The verbs are `request_changes` on every kind that offers it
  (`design_result`, `acceptance_result`, `decision_approval`,
  `pull_request_approval`), its choice spelling _None of these — revise the
  options_ on `decision_choice` (the same verb, §1's MOTIR-5887 amendment,
  point 5), and `overturn` on `decision_confirmation`, which already requires
  one.
- **Where it is enforced: the ONE decide door**, `approvalGatesService.decide`,
  beside Overturn's check (`lib/services/approvalGatesService.ts`, step 3c,
  `overturn_needs_a_note`). A screen-only rule would be a suggestion: the REST
  route and the server action would still send an empty refusal. A
  `request_changes` whose trimmed `noteMd` is empty is refused with
  **`ApprovalGateVerbNotOfferedError(gateId, 'request_changes_needs_a_note')`**
  — the same error class and reason shape as `overturn_needs_a_note`, so the
  route's status map and the UI's refusal copy already have a slot for it.
- **Which sources it applies to: every source a PERSON presses from** —
  `ui` and `api` (`ApprovalGateDecisionSource`). **A `github` refusal is never
  refused for its reason**: nobody pressed it in Motir, it has already happened
  on the host, and refusing it would leave the gate awaiting over a decision a
  reviewer has made. The rule keys on `source`, never on the caller.
- **What is stored: the text as written**, in `approval_gate.note_md`, in the
  deciding write, under `trg_approval_gate_decided_immutable`. Nothing about the
  row's immutability changes.
- **Approve, Confirm and `choose` keep their OPTIONAL note.** A yes needs no
  justification; a no is the feedback somebody has to act on.

#### 10b. A GITHUB-SOURCED refusal carries the REVIEW BODY, or says it had none — rung 2 (§8's FOURTH AMENDMENT)

Today the review sync writes `noteMd: null` for a `request_changes` decision
(`lib/services/pullRequestReviewSync.ts`, `evaluateOne`), and it could not do
anything else: `github_pull_request_review` stores no body
(`prisma/schema.prisma`, `model GithubPullRequestReview`). So:

- **The review BODY is captured.** A new nullable `body` column on
  `github_pull_request_review`, written from `review.body` whenever the row is
  written — a `submitted` or `dismissed` delivery (`githubWebhookService`'s
  `pull_request_review` arm, via the normalised event in `lib/git/types.ts`).
  Expand-only. An empty or absent body is stored as NULL, trimmed otherwise.
  **An `edited` delivery stays ignored**, as it is today: a `changes_requested`
  review decides the gate on the delivery that SUBMITS it, so an edit always
  arrives after the decision, and the decided row is immutable anyway.
- **The deciding review's body is the reason.** §8's FOURTH AMENDMENT decision 1
  decides the gate `changes_requested` on the FIRST countable changes-requested
  review; that review's body is passed as `noteMd`, trimmed, NULL when empty.
- **A surface tells the two apart by `decisionSource`, already on the row.** A
  `changes_requested` gate with `decisionSource: github` and a null `noteMd`
  reads **_no reason given on GitHub_** — never a blank, and never the Motir
  wording, because nobody in Motir was asked. With a body, the record quotes it
  and says it came from a GitHub review by `decidedByLabel`.
- **Still one-directional** (decision 9): Motir posts nothing back to the review.

#### 10c. HOW a card goes back to To do: a GATE-OWNED SYSTEM WRITE, never a new workflow edge — rung 2

**The shipped facts.** `DEFAULT_TRANSITIONS` (`lib/workflows/defaultWorkflow.ts`)
declares no edge into `todo` from `implemented`, `in_review` or `approved`; the
project's live workflow is the same (`todo` is reachable only from
`in_progress`, `blocked`, `planning` and `cancelled`). And
`applyStatusTransition`'s `decidingGateId` option exempts ONE thing — the
held-move guard for the deciding gate (§6d's amendment, rule 5). **It does not
skip the legal-edge check**; only `system: true` does
(`lib/services/workItemsService.ts`, `applyStatusTransition`, _Legal-edge
validation, EXCEPT under a system context_). So Confirm and Overturn's own
write — `{ decidingGateId }` alone — would be refused `IllegalTransitionError`
for `in_review → todo`.

**The decision.** A refusal that returns a card to To do writes it through
`workItemsService.applyStatusTransition(workItemId, <target>, ctx, tx,
{ system: true, decidingGateId: gate.id })`, inside the decide door's
transaction, from the kind's handler — the same place every other gate effect
writes its status.

**Why not a new workflow edge.** A new `in_review → todo` edge would let ANY
writer make that move — a board drag, the REST status route, a script — and
remove the `IllegalTransitionError` every blind writer of `todo` relies on
today (the lesson _a new workflow edge removes a refusal_). The move is correct
only as the consequence of a recorded refusal, so it belongs to the gate, and
the refusal stays in place for everybody else. The `system` write still
validates that the target is a real status of the project, and still passes
the tenant and project-access gates; it skips only the edge list.

**What `<target>` is.** The project's status that is BOTH `isInitial` and in the
`todo` category — To do in the default workflow. **A project whose workflow has
no such status** gets the refusal and its verdict recorded and **no status
written**: the handler returns `{ statusWritten: null, statusDeferredReason:
'no_status_in_target_category' }`, Overturn's shipped answer for a project with
no `cancelled`. The DECISION is the audit; the status is a convenience.

**The pull-back rule still runs.** The move is below `implemented`, so §6d's
amendment rule 6 supersedes every OTHER `awaiting` gate on the card with cause
`pulled_back` (the approve-to-merge gate included). That is correct: the
commits are about to change.

**Amended for `design_result` by [`design-refusal-verdict.md`](design-refusal-verdict.md) (MOTIR-6419).**

#### 10d. The verdict is STORED on the decided gate — in a column of its own, NOT in `outcomeRef` — rung 2, DEVIATING from the card's recommendation

The card recommended `outcomeRef`, beside `chosenOption`'s precedent, _"unless
the reading of shipped code contradicts it"_. It does. **`outcomeRef` is read as
a STATUS KEY by the surfaces that repaint the card after a decision**:
`DevelopmentGateFrame` applies `result.gate.outcomeRef` as the optimistic
status, and so do `DecidedGateStatusBridge` and `OptimisticStatusProvider`
(`app/(authed)/items/[key]/_components/`). `decision_choice` got away with an
option id there only because the overlay special-cases it (MOTIR-5893). A
verdict value in that column would paint `re_plan` onto the card as its status.
And a **Revise** does write a status (10c), so `outcomeRef` must keep carrying
it.

**The decision.**

- **A new nullable enum column `approval_gate.refusal_verdict`**,
  `ApprovalGateRefusalVerdict = revise | re_plan`. Stamped in the deciding
  write, under the decided-row trigger. NULL on every approval, on every kind
  that offers no verdict, and on every gate decided before this section.
- **`outcomeRef` is unchanged**: it carries `statusWritten` — To do's key on a
  Revise, NULL on a Re-plan.

  **Amended for `design_result` by [`design-refusal-verdict.md`](design-refusal-verdict.md) (MOTIR-6419).**

- **The decide door takes the verdict** as `refusalVerdict` beside `noteMd`, on
  the route, the server action and the service. The door refuses a verdict on a
  kind or case that offers none, and refuses a verdict-offering refusal that
  names none, both as `ApprovalGateVerbNotOfferedError` (`refusal_verdict_not_offered`
  / `refusal_verdict_required`). A GitHub-sourced refusal carries no verdict:
  nobody was asked, and it behaves as a plain refusal (it moves nothing).

#### 10e. A sent-back design stays OPEN to a revised publish — already true on shipped code, restated so no later card narrows it back

§6c's second amendment and MOTIR-5658's Q3 (_"a decided design gate closes the
design"_) read as if any decision closed it. **The shipped refusal is already
narrowed to `approved`**: `assertDesignSettled`
(`lib/services/designEvidenceService.ts`) refuses a republish only over an
APPROVED current result, with an open delivery, at or above `implemented`, and
says in its own header why `changes_requested` must stay open — _"it is the one
that ASKS FOR A NEW VERSION"_. The status half, `assertStatusOpen`, refuses only
a `done`-category card, and neither verdict writes one.

**So nothing is built for (e).** It is the rule: **a `changes_requested` design
gate — either verdict — never closes the design.** A Revise's return to To do
(10c) is what makes the next run's publish the ordinary revise loop, and that
publish supersedes nothing that was approved.

#### 10f. The planner offer is a SEEDED, UNSENT first turn, addressed by the GATE — rung 3

- **The press opens the planning surface straight after the decision commits**,
  on the card the table below names as the anchor, in the `replan` mode the
  launcher already has (`lib/planning/launcher.ts`, `PlanningLaunchContext`
  gains `{ kind: 'refused-gate'; gateId }`).

  **Amended for `design_result` by [`design-refusal-verdict.md`](design-refusal-verdict.md) (MOTIR-6419).**

- **It is addressed by the GATE ID, never by the reason's text in a URL.** The
  surface reads the decided gate server-side and composes the first turn from
  the row: the card's key and title, the kind, what was refused, and the reason
  quoted. A reason in a query string would leak into history, logs and referrers,
  and would be editable by anyone who can edit a link. The gate is also the
  authorisation: the surface opens only for a person who can read the gate's work
  item.
- **The turn is UNSENT.** The person reads it, can edit it, and sends it. Nothing
  is billed and no session is started until they do (Story MOTIR-6011's session
  begins at the first SENT turn).
- **A decided record keeps a door to it**: the record band of a refused gate that
  offers the planner shows **Re-plan with AI**, which opens the same seeded turn.
  If the person already started that conversation, the door returns to it while
  it is recent (MOTIR-6011's rule); otherwise it seeds a new one.
- **Nothing about the plan is automatic.** The planner PROPOSES; a person approves
  the plan, as for every plan.

#### 10g. §5 re-drawn — the line against Story 9.2

| owned by Epic MOTIR-6010 (this section)                                                                              | still Story 9.2's (MOTIR-693)                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| the REASON on every refusal, and where it is shown                                                                   | the ephemeral hosted PREVIEW, its deploy and teardown                               |
| the VERDICT at the press, and returning a card to To do (10c)                                                        | the HOSTED, AUTOMATIC re-dispatch after a refusal — the revise-chat and its preview |
| handing the reason to WHICHEVER run picks the card up next (the dispatch prompt carries the latest refusal's reason) | `Project.designApprovalGate` and the HOLD it applies to the `motir auto` loop       |
| opening the planner, seeded, on a refused decision / choice / design / video, and on a picked option                 |                                                                                     |

9.2 may later make the run after a Revise automatic. It does not own the
hand-back, which is this epic's.

**Amended by [`hosted-design-rerun-and-design-approval-switch.md`](hosted-design-rerun-and-design-approval-switch.md) (MOTIR-695).**

#### 10h. THE FOLLOW-UP TABLE — one row per kind × case

"Planner anchor" is the work item the seeded re-plan opens on. "Status written"
is what the refusal's own handler writes; every other effect named in the rows
above this section is unchanged.

| kind · case                                                  | refusal verb(s), reason REQUIRED (10a)                                                                                                                       | verdict at the press (10d)                 | status written by the refusal                                                                                                                                                                | planner opens (10f) — anchor                                                                                                             | built by                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `design_result`                                              | Request changes                                                                                                                                              | **Revise** · **Re-plan**                   | **Revise**: the DESIGN CARD → To do (10c). **Re-plan**: none                                                                                                                                 | **Re-plan** only — anchored on the design card's PARENT (the cards planned after the design), seeded with the design card and the reason | MOTIR-6070                   |
| `acceptance_result` · STORY run (the gate on the run target) | Request changes                                                                                                                                              | **Re-run** (stored `revise`) · **Re-plan** | **Re-run**: the STORY and EVERY not-`done` child → To do (10c) — a story re-run's scope claim re-asserts the to-do category on every member (`scopeClaimService`, step 5). **Re-plan**: none | **Re-plan** only — anchored on the STORY; it may re-plan ALL its subtasks                                                                | MOTIR-6071                   |
| `acceptance_result` · SUBTASK runs, last one finished        | Request changes                                                                                                                                              | none — Re-plan is the only answer          | none — nothing under the story is open to re-run                                                                                                                                             | **always** — anchored on the STORY, seeded to PLAN A REMEDY                                                                              | MOTIR-6071                   |
| `decision_approval`                                          | Request changes                                                                                                                                              | none                                       | none (unchanged: the pull request stays open, the merge stays HELD — §8's FIFTH AMENDMENT clause 5)                                                                                          | **always** — anchored on the decision card, seeded to re-plan from the reason                                                            | MOTIR-6068                   |
| `decision_confirmation`                                      | Overturn (note already required)                                                                                                                             | none                                       | `cancelled` (unchanged, §1's MOTIR-5952 amendment point 7)                                                                                                                                   | **always** — anchored on the decision card; the seed also names the keys `replanOwed` derives from `## Supersedes`                       | MOTIR-6068                   |
| `decision_choice` · None of these                            | None of these — revise the options                                                                                                                           | none                                       | none (unchanged)                                                                                                                                                                             | **always** — anchored on the choice card, seeded to re-plan from the reason                                                              | MOTIR-6068                   |
| `decision_choice` · an option chosen                         | — (not a refusal; its note stays optional)                                                                                                                   | none                                       | `done` (unchanged, §1's MOTIR-5887 amendment point 6)                                                                                                                                        | **offered** — anchored on the choice card, seeded to plan `## What this choice gates` with the chosen option → amended [1][pop] [2][ps]  | MOTIR-6069                   |
| `pull_request_approval`                                      | Request changes                                                                                                                                              | none                                       | none (unchanged)                                                                                                                                                                             | **none** — the author reads the reason on the card and the pull request, as today                                                        | MOTIR-6067 (the reason only) |
| `agent_review` (MOTIR-6815)                                  | the AGENT's `changes_requested`, findings REQUIRED; a person has no refusal verb — _Continue without the review_ is an approval with a required note (§12.3) | none                                       | none — the card is To fix, repaired by `motir fix` (§12.4)                                                                                                                                   | **none** — the findings are the brief, and the repair is a fix, not a re-plan                                                            | MOTIR-6819                   |
| `plan_approval` (MOTIR-6012)                                 | ~~— no refusal verb~~ **Decline**, reason OPTIONAL — §11.10 amends this row                                                                                  | —                                          | —                                                                                                                                                                                            | —                                                                                                                                        | MOTIR-6035                   |

**Amended for `design_result` by [`design-refusal-verdict.md`](design-refusal-verdict.md) (MOTIR-6419)** — the `design_result` row.

**Amended by §12 (MOTIR-6815, 2026-09-29)** — the `agent_review` row is added (§12.8), and the `pull_request_approval` row's To-fix repair is `motir fix`, never `run` (§12.7).

[pop]: picked-option-planning.md
[ps]: picked-option-planning-starts.md

**Four notes on the table:**

- **The acceptance Re-run is stored as `revise`.** The two verbs are one verdict
  (_a small change, send the same work back_) spelled for what the reviewer is
  looking at: a design is revised, a story is re-run. One enum value keeps the
  audit's question — _did they send it back or re-plan it?_ — one column wide.
- **Which acceptance row applies is read from the gate, not guessed**: the story
  run is the case where the gate is the PRIMARY over a story-run delivery set
  (§1's MOTIR-5903 amendment); the finished case is the one raised once nothing
  under the story is open.
- **A refusal from GitHub** on any of these is a plain refusal: reason from 10b,
  no verdict, no status, no planner. It lands on `pull_request_approval`, the only
  kind the review sync decides.
- **The next run is handed the reason.** On a Revise / Re-run the dispatch prompt
  for the returned card carries the latest `changes_requested` gate's reason, as
  _what the reviewer asked for_ (MOTIR-6070 / MOTIR-6071 build it).

#### 10i. What this section does NOT decide

The HOSTED automatic re-dispatch (9.2, 10g); a refusal verb on the plan gate
(MOTIR-6012 has none — **read as _no `request_changes`_: its one refusal, `decline`, is decided in §11.4**); posting anything back to GitHub (§8's FOURTH AMENDMENT
decision 9); and the copy and layout of the reason field and the verdict pair,
which are MOTIR-6073's to draw.

### 11. The PLAN-APPROVAL kind — a gate whose subject is a PLAN and which belongs to NO work item — NEW (MOTIR-6031 for Story MOTIR-6012, 2026-09-23), DECIDED BY THE PLANNER on the story's settled shape

**What was MISSING.** Every kind above hangs off a work item: the row's
`workItemId` is NOT NULL with a cascading foreign key (`prisma/schema.prisma`,
`model ApprovalGate`), the queue reaches the routing half of its predicate
through that card, and the overlay is addressed by the card's key. **A PLAN is
decided outside all of it.** `plansService.approvePlan` / `declinePlan` sit
behind `ai:decide_plan` and are pressed from the plan page, the planning rail,
`ExpansionNudgeBanner` and the v1 route
`app/api/v1/work-items/[key]/plan-approval` (the `motir auto
--auto-approve-replan` caller). No list collects a waiting plan, and no gate row
records who approved which version of it.

> **⚠️ AMENDED 2026-10-08 by Story MOTIR-7883 (MOTIR-7891).** The sentence above
> — _"`plansService.approvePlan` / `declinePlan` sit behind `ai:decide_plan` and
> are pressed from the plan page, the planning rail, `ExpansionNudgeBanner` and
> the v1 route"_ — is kept as the record of what was missing on 2026-09-23. It is
> no longer true of the plan page for a member: a member decides an undecided plan
> in the planning overlay, whether its session is open or has ended, and a
> `/plans/<id>` for one replace-redirects there (11.5b, as amended). The page's
> verbs remain only for the null-session breach, which no surface explains.

**Read at base `983af7117`.** This section is the contract Story MOTIR-6012's
children build to. Each of them cites the numbered point it implements rather
than re-reading the story. **No behaviour ships in this section.**

| point                                                                  | built by                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1–2 — the kind, the card-less row, the index, the constraint           | MOTIR-6032 (schema) · MOTIR-6034 (every read that assumed a card)   |
| 3–6 — the subject, the stamp, the verbs, the effect, the hold, routing | MOTIR-6035 (the handler and its registry promotion)                 |
| 5b — the decision surface                                              | MOTIR-6033 (design) · MOTIR-6037 (the row and the planning surface) |
| 7 — raise and supersede                                                | MOTIR-6036                                                          |
| 8 — every decision through the door                                    | MOTIR-6038                                                          |
| 9 — the backfill                                                       | MOTIR-6039                                                          |

#### 11.1 The kind is `plan_approval`, and it is the FIRST kind whose gate may belong to NO work item

A plan that proposes a new epic has no card to hang on, and a re-plan of one
story is still not ABOUT that story: it is about the proposal set, which can
reach cards in other epics (`agent-authored-plans.md` AMENDMENT 18's `modify`
of any committed card). So **a `plan_approval` gate ALWAYS carries a NULL
`workItemId`, and every other kind ALWAYS carries one.** It is a biconditional,
not "may":

- **Enforced by a CHECK constraint**,
  `approval_gate_work_item_iff_not_plan`:
  `("kind" = 'plan_approval') = ("work_item_id" IS NULL)`. A constraint rather
  than an application check because the row is the audit artefact (§6a), and a
  card-less design gate written by a buggy path would be a question nobody can
  reach — no routing card, no item page, no overlay address.
- **`workItemId` becomes nullable in the datamodel.** The relation keeps
  `onDelete: Cascade` for every row that has a card. No other column changes
  meaning.
- **Every read that assumed a card must handle a gate without one** — and "every"
  is measured by the type, not by a list: once `workItemId` is `string | null`,
  the compiler names each site. The ones known at this base are
  `GateRoutingArgs.item` (`lib/approvalGates/registry.ts` — `routeTo` and
  `currentSubject` take a `WorkItem`), the decide door's pre-read
  (`approvalGatesService.decide`, which loads the card to resolve authority and
  the status intent), `listAwaitingMe` / `countAwaitingMe` (which join the card
  for routing), the Approvals room's record reads, the gate DTO, and
  `lib/approvals/overlayAddress.ts`. Handling them is MOTIR-6034's.

#### 11.2 The SUBJECT says what it is about — no second owner column, no foreign key to `Plan`

**`subjectId` is the `Plan.id`.** §1's MOTIR-4911 amendment already made the
subject an opaque id with a per-kind resolver, precisely so a kind whose subject
is not a work-item artefact needs no migration on this table. **No `plan_id`
column is added**: it would be a second polymorphic owner beside `subjectId`,
and a reader would have to learn which of the two a kind uses.

**Why no foreign key to `Plan` is owed.**

1. The row's own `workspaceId` and `projectId` already cascade, which is the
   only way a plan is deleted: **no code path deletes a `Plan` on its own**
   (measured: no `plan.delete` / `plan.deleteMany` outside tests at this base).
   A plan is declined, never removed.
2. A vanished subject is already a shipped answer for every kind:
   `resolveSubject` returns null, and the surfaces read that as the subject
   being gone. A plan gate uses the same answer.
3. §1's reasoning holds here unchanged: a polymorphic FK is worse than none, and
   an FK on one kind's subject would make this the one kind whose subject the
   schema knows.

**The awaiting-uniqueness index cannot key a NULL.**
`approval_gate_one_awaiting_per_subject` is `(work_item_id, kind, subject_id)
WHERE state = 'awaiting'` (`prisma/migrations/20260908210000_add_approval_gate`),
and in a unique index two NULLs are distinct, so it would admit any number of
awaiting plan gates for one plan. **A SECOND partial unique index is added**,
`approval_gate_one_awaiting_per_cardless_subject`, over `(subject_id, kind)
WHERE state = 'awaiting' AND work_item_id IS NULL`. The existing index is left
exactly as it is. Re-creating the existing index `NULLS NOT DISTINCT` (Postgres
15+, which the project's Postgres 16 supports) was considered and rejected. It
would rebuild the one index every write path of every kind relies on to key a
question only this kind asks. The new index covers the card-less rows alone, so
it is small, and the shipped index keeps its byte-identical definition. **Check the column list against every `@@index` on the model before
naming it** (CLAUDE.md's partial-index rule): `(subject_id, kind)` must not be
the column list of any datamodel index, or the differ will report a permanent
rename.

#### 11.3 The subject's VERSION is a digest of the PROPOSAL SET — enumerated here so two implementers compute the same one

`Plan` has no version column and `subjectVersion` is opaque text (§6a), so this
kind's version is a digest. **Its inputs are every `PlanItem` row of the plan,
and nothing else:**

```
subjectVersion = "plan.v1." + hex(sha256(canonicalJson({
  proposals: <every PlanItem where planId = the plan, sorted by id ascending,
              comparing the ids as byte strings>
             .map(item => ({
               id, op, workItemId, parentRef, blockedByRefs,
               proposedFields, patch, baseRevision,
             })),
})))
```

- **`canonicalJson`** is `JSON.stringify` over a copy in which every OBJECT's
  keys are sorted by UTF-16 code unit order, recursively, with no whitespace. A
  database NULL is JSON `null`, never an omitted key. Array order is kept as
  stored (`blockedByRefs` order is the author's, and a re-ordered list is a
  different proposal). The full digest is the 64-character hex string.
- **Excluded, deliberately:** `createdAt`, `workspaceId` and `planId` (they
  cannot change or say nothing about what is decided), and the plan's `title`,
  `summary` and `status`.
- **DEVIATION from the card, with its reason.** The card asked for _"each
  proposal's id and revision, plus the plan's status"_. **`PlanItem` has no
  revision column.** `baseRevision` is the revision of the TARGET work item a
  `modify` was written against, not of the proposal, and a deepen
  (`update_plan_item`) or a correction (`update_plan_proposal`) rewrites
  `proposedFields` / `patch` / `parentRef` / `blockedByRefs` IN PLACE. An
  id-only digest would stay the same over a corrected proposal, which is exactly
  the case the stamp exists to catch. So the CONTENT is hashed. **The status is
  left out** because it is a precondition, not content: the handler refuses
  anything but `planned` whatever the digest says (11.4), so including it adds
  no refusal and would make a digest mean two things.
- **The stamp is the shipped one** (`lib/approvalGates/stamp.ts`,
  `computeGateStamp`): `subjectVersion` is this digest,
  `companionSubjectVersion` is null (a plan gate has no companion merge gate),
  and `descriptionMd` is null (there is no card body). **A digest that moves is
  reported as `subject`.** That is how _"approving against a version read before
  the planner rewrote it is refused as stale"_ holds:
  `APPROVAL_GATE_STALE_SUBJECT` (MOTIR-5232), with no new refusal minted. The
  reader's words for it are MOTIR-6033's to draw.
- **The digest is ONE function** in `lib/approvalGates/`, beside `stamp.ts`, and
  the render read and the decide door both call it. The stamp's own header says
  why: two implementations would be two answers to _did this change?_.

#### 11.4 The VERBS — `approve`, a NEW `decline`, and NO `request_changes`

| verb                  | offered                                   | what it does beyond recording the decision                                                                                                   |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **`approve`**         | yes                                       | materializes the plan exactly as `plansService.approvePlan` does today — the proposals become work items, the targets are released (point 5) |
| **`request_changes`** | **NO**                                    | refused by the door with `ApprovalGateVerbNotOfferedError(gateId, 'request_changes_on_plan')`                                                |
| **`decline`**         | yes — **offered ONLY by `plan_approval`** | writes the plan `declined` with `decisionReason: 'reviewed'`, exactly as `plansService.declinePlan` does from `planned`                      |

- **Why no `request_changes`.** A plan is changed by TALKING to the planner,
  which writes a new version of the SAME plan (Story MOTIR-3595 — a revision
  appends to the `planned` plan where it stands, `agent-authored-plans.md`
  AMENDMENT 10). A _Request changes_ verb would record a refusal and then wait
  for a revision that only a conversation can produce, so it would leave the
  question looking open for something it cannot cause. The door refuses it the
  way it refuses `request_changes` on `decision_confirmation`.
- **Why a `decline` verb, and not the `request_changes` slot.** Without it a plan
  a person has changed their mind about waits in To approve for ever. **A decline
  ENDS the question**; changes-requested keeps it open and puts the ball in the
  author's court, which here is a conversation rather than a verb. It follows the
  optional-verb pattern `overturn?` established on `GateHandler`
  (`lib/approvalGates/registry.ts`): **`GateHandler.decline?`** is optional,
  `GateDecision` (`lib/dto/approvalGate.ts`) gains `'decline'` on the route, the
  server action and the service, and the door refuses it on any kind that does
  not supply it with `ApprovalGateVerbNotOfferedError(gateId,
'decline_on_other_kind')`.
- **It writes a NEW terminal state, `declined`** — not `changes_requested`
  (non-terminal on every kind that has it) and not `overturned` (which means _a
  direction was refused_, with a re-plan owed). A reader counting refusals must
  be able to tell a plan ended by a person from a decision sent back.
  `ApprovalGateState` gains the member, and **`enforce_approval_gate_decided_immutable`
  must list it**: the trigger names its decided states explicitly
  (`20260922000300_approval_gate_decided_immutable_overturned`), so a
  `declined` row it did not list would stay editable. Both are MOTIR-6032's.
- **Its reason is OPTIONAL — a DELIBERATE departure from §10a, stated so a later
  reader does not "fix" it.** §10a requires a reason on every refusal a person
  presses, because _"a no is the feedback somebody has to act on"_. A decline
  hands nothing to anybody: no run picks the plan up afterwards, no planner opens
  (11.4's row in §10h, below), and the gate is routed to the person who asked for
  the plan (11.6), so in the ordinary case the decider is declining their own
  request. The requester's rule 1 in §10 is that a person _must be able to_ give
  a reason, and they can: `noteMd` is stored when given, under the decided-row
  trigger like every note. **§10h's `plan_approval` row is amended below to say
  so.**
- **Approve and decline are decided under the SAME permission and the SAME
  hold** (points 5c and 6).

#### 11.5 `statusIntent` is NULL — the handler writes a PLAN's status, never a work item's

A plan gate owns no work-item transition, so `statusIntent: null` and
`resolvedStatusKey` is always null. **What approve and decline change is
`Plan.status`**, inside the handler's effect, in the door's transaction. The
effect reports `statusWritten: null` with a new `statusDeferredReason`,
`'plan_decision_writes_no_work_item'`, so the record never reads as a decision
that failed to move a card. Approve's materialize DOES write work-item statuses:
approve derives `blocked` from the proposals' edges, and the parked targets are
restored. Those are the plan's effects, recorded on each work item's own history
exactly as today. They are not the gate's `outcomeRef`, which stays null.

**THE LOCK ORDER — the PLAN row first, then the gate row.** Every plan-side
writer that touches a plan gate already holds the plan lock
(`planRepository.lockById`) when it gets there: markPlanned, the drift writers,
the last-withdrawal discard, and approve and decline themselves. The door's
generic order is the opposite: it locks the GATE (`SELECT … FOR UPDATE`) and then
calls the handler. Two transactions taking the same two rows in opposite orders
deadlock. **So for this kind the door takes the plan lock BEFORE the gate
lock.** `subjectId` is immutable, so it is read unlocked first, the plan is
locked, and then the gate is locked and re-read. This is a precondition of
MOTIR-6035's handler, and the supersede writers of MOTIR-6036 must keep the
plan-then-gate order. Any other order is a deadlock waiting for a busy project.

**The materialize runs in the door's transaction.** `approvePlan` and
`declinePlan` open their own today. The handler calls their bodies through a
`…Within(tx)` seam that takes the caller's transaction. The post-commit side
effects (events, the provisional-project rename) stay after the commit, exactly
where `approvePlan` puts them now.

#### 11.5b The DECISION SURFACE is the PLANNING SURFACE — a stated departure from _one control_

**This kind renders NO port, and the approval overlay is not where it is
decided.** Opening its To-approve row returns the person to the planning surface
at the plan's own conversation (the `planSession` address, Story MOTIR-6011),
where the plan is already rendered for review and where they can keep talking to
the planner. **Approve** and **Decline** sit there.

**What is unchanged, and why this is not a second vocabulary:** the routing
(11.6), the record (§6a, every column), the stamp (11.3) and the ONE decide door.
**What differs is only the surface.** Deciding a plan means reading it beside the
conversation that can change it, and a port inside the overlay can host the plan
but not the conversation. §1's _"No second vocabulary, no second control, no
second decide door"_ keeps its first and third clauses in full. Its second is
satisfied by the verbs and their copy, not by the frame, and this is the one
kind for which that is true.

- **The overlay ADDRESS is not extended.** A plan gate carries no card key to
  address, and it opens nowhere in the overlay. An overlay that is handed one
  anyway (a stale link) sends the person to the planning surface rather than
  rendering a frame with no port. That is MOTIR-6037's.
- **A plan with NO SESSION** — `Plan.sessionId` is null — opens its own plan page
  (`/plans/<id>`), where the same two verbs sit, and the row says why before it
  is clicked.

  **⚠️ AMENDED 2026-10-08 by Story MOTIR-7883 (MOTIR-7891) — an UNDECIDED plan
  is reached ONLY in the planning overlay, whether its session is open or has
  ended.**
  - **What this supersedes**, quoted verbatim from the bullet above: _"opens its
    own plan page (`/plans/<id>`), where the same two verbs sit, and the row says
    why before it is clicked."_ Nothing says why any more. The reason that copy
    rendered, `'no-conversation'`, is retired: the null arm of
    `planRowDestination` now answers `'no-session'`
    (`lib/planning/planDestination.ts`, MOTIR-7885), and no renderer reads it. A
    null `Plan.sessionId` is an invariant breach — `createPlan` attaches a
    session in the same transaction (MOTIR-6022) and MOTIR-6020 backfilled every
    older plan — so it degrades to the page silently. It is no longer a
    population, and it is no longer a sanctioned road to deciding a plan outside
    the overlay.
  - **The owner's rule (Yue, 2026-10-08), quoted:** _"the plan approval should
    always be on the overlay, the user needs to see the plan before approve"_;
    for `/plans/[id]`, _"open the overlay there if the plan is to approve or
    writing -- not approved, not declined, not closed"_; and of plans whose
    session has ended, _"open them in the overlay too"_.
  - **What replaces it.** A member reaches an UNDECIDED plan — `generating` ·
    `planned` · `stale` — **only in the planning overlay at that plan's
    session, whether the session is open or has ended** (`PlanChangeSession.endedAt`
    set; **Closed** on the Plans list). **A plan is _closed_ when it is decided,
    not when its session ends.** Every in-app door opens it in place, over the
    page the reader is on (MOTIR-4730). A typed, shared or followed `/plans/<id>`
    for such a plan **replace-redirects** to `/plans` with the overlay open on
    the plan's session (`app/(authed)/plans/[id]/_view.tsx`; MOTIR-7888), so Back
    does not return to an address that only bounces again. The redirect asks
    `planRowDestination` alone and reads no session end at all.
  - **MOTIR-7634's Closed-row read, NARROWED here.** That clause — a Closed row on
    the Plans list opens its CONVERSATION, as a read, because there is nothing
    left to decide — is not stated in any decision record under `docs/decisions/`
    (it lives in MOTIR-7634's published design section and in
    `app/(authed)/plans/_components/SessionRow.tsx`), so its narrowing is recorded
    in this amendment: **a Closed row whose latest plan is still undecided opens
    that plan in the overlay**, row and state chip alike (the chip is a
    `PlanOverlayDoor`; MOTIR-7889). A Closed row whose latest plan is decided —
    or which has no plan — keeps the read.
  - **What this does NOT drop.** The plan page itself, for an `approved` or
    `declined` plan (a record), for the null-session breach (with no copy) and
    for every Visitor (MOTIR-6888, to whom the planning workspace is not served).
    **A session-ended undecided plan is NOT among them.** The ONE decide door
    (11.6), the record (§6a) and the stamp (11.3) are untouched, and
    `Plan.sessionId` stays nullable at the database. So does MOTIR-7629's rule
    that an ended session is never resumed: the overlay SHOWS an ended session's
    plan; it does not reopen the session. Continuing that conversation — a new
    session carrying the plan — is a sibling story's to record, not this one's.

  **⚠️ AMENDED 2026-09-24 by Story MOTIR-6043 (MOTIR-6045), and the earlier
  wording is quoted here because it names three populations this now excludes.**
  It read: _"A plan with NO conversation (a backfilled plan, an agent-authored
  MCP plan whose session has no turns, a cadence plan) opens its own plan
  page."_ **All three of those have sessions, and all three open the PLANNING
  SURFACE.**
  - An **agent-authored MCP** plan: `docs/decisions/mcp-authored-plan-review.md`
    — _"An empty transcript is not an absent conversation … `has a session` and
    `has turns` are different questions, and it is the first that says whether
    there is a planning phase to watch."_ Its session exists from `create_plan`.
  - A **`cadence`** plan: `agent-authored-plans.md` AMENDMENT 17 §4 gives it a
    session of origin `cadence`.
  - A **backfilled** plan: AMENDMENT 17 §5 plus the MOTIR-6020 backfill gives
    every pre-existing plan one, of origin `legacy` unless its door is known.

  **So the predicate is the session's EXISTENCE — never its ORIGIN, and never
  whether it holds turns.** Keying on the origin is the same inference the
  decision record overturned, one door over; keying on the column is total, and
  it is how this section's own first paragraph already puts it (_"the planning
  surface at the plan's conversation, or the plan page when it has none"_).

  What is left is the rollout residue `prisma/schema.prisma` names on the column
  itself: _"NULLABLE AT THE DATABASE only so a build predating this column can
  still write a plan during a rollout."_ Deliberately near-empty, and the branch
  stays because nothing at the database enforces the non-null.

  **The rule is ONE function, `planRowDestination`
  (`lib/planning/planDestination.ts`), called by BOTH the Plans page's session
  row and this gate's To-approve row**, so the two lists cannot answer
  differently. It is total over `PlanStatus` with no default arm. The row's
  affordance, the retirement of
  `approvalGate.planApproval.noConversation.agent` / `.cadence` / `.earlier`,
  and the single `.none` cause this notice now carries are
  `design/ai-planning/design-notes.md` **Part XXI**.

  **⚠️ AMENDED 2026-10-08 by Story MOTIR-7883 (MOTIR-7891) — the single `.none`
  cause is retired too.** The paragraph above is kept word for word as the record
  of 2026-09-24; what it names as current is not. `approvalGate.planApproval.noConversation`
  and `planDestination.noConversation` / `.noConversationWhy` are deleted from
  the catalogue, and `PlanPageReason`'s `'no-conversation'` is renamed
  `'no-session'`, which no surface renders (MOTIR-7885). **What this does NOT
  drop:** the predicate — the session's EXISTENCE, never its origin and never its
  turns — and the one-function rule: `planRowDestination` is still the single
  rule both lists call, total over `PlanStatus` with no default arm.
  `design/ai-planning/design-notes.md` Part XXI stays as drawn, a record of the
  moment it was drawn.

  **⚠️ AMENDED 2026-10-08 by Story MOTIR-7883 (MOTIR-7891) — MOTIR-6043's
  reachability clause is REVERSED, on purpose.** Story MOTIR-6043 promised:
  _"Nothing becomes unreachable: a pending plan's own page keeps a way in,
  through a secondary link on the row"_, and _"a pending plan's own page is still
  reachable from the list or the surface in one step"_. Both sentences are
  superseded deliberately: a member is no longer meant to reach a pending plan's
  page at all (the amendment under this bullet's opening paragraph). The Plans
  row's state chip that was that secondary link now opens the plan in the
  overlay (`PlanOverlayDoor` in `app/(authed)/plans/_components/SessionRow.tsx`;
  MOTIR-7889). **What this does NOT drop:** the chip itself, drawn only while the
  row's plan has something to decide, and the decided plan's page, which its row
  still opens.

- The row's words, the two verbs' placement and copy, and the hand-off message
  before generation are MOTIR-6033's to draw.

- **The PLAN-HELD status refusal uses this same door rule.** While an undecided
  plan holds a card at `planning`, every hand move out of it is refused with
  `PLAN_TARGET_HELD`, and the **Review plan** button on that refusal goes where
  `planRowDestination` sends the plan — never the approval overlay
  (`agent-authored-plans.md` AMENDMENT 21 §2; story MOTIR-6017).

#### 11.5c HELD while the planner rewrites — NOT superseded, NOT re-raised

While a new version of the plan is being written, **the gate stays `awaiting`
and BOTH verbs are refused**, with a reason a person can read. It is the same
plan and the same question.

- **What "being rewritten" is, in code: the REVISION LEASE**, not the plan's
  status. A revision leaves the plan `planned` from start to finish (AMENDMENT
  10 D1). The lease lives on the plan's own trail, a `revision_started` with no
  `revision_ended` after it inside the window (`revisionLeaseOf`,
  `lib/planChange/revisionLease.ts`). **Decidability is DERIVED from it and never
  stored.** No column and no state record "held", so nothing can forget to clear
  it. _(A correction to the card, which said "derived from the plan's status":
  the status does not move during a revision, so there is nothing there to
  derive from.)_
- **The refusal already ships for both verbs.** `approvePlan` and `declinePlan`
  each call `assertNoRevisionInFlight` under the plan lock and throw
  `PlanRevisionInFlightError(planId, heldBy, expiresAt)`. `declinePlan` records
  why a decline is refused too: a revision finishing into a declined plan leaves
  proposals nobody will read. The handler inherits that refusal through the
  `…Within(tx)` seam. The gate DTO carries it as `held: { reason:
'revision_in_flight', heldBy, expiresAt } | null`, so the row and the surface
  can say so before anyone presses.
- **When the lease ends, the SAME gate is decidable again**, against the new
  version. Its `subjectVersion` is computed at decision time, and a reader
  holding a stamp from before the revision is refused stale (11.3).
- **Why supersede-and-re-raise is WRONG here, although other kinds do it on a
  moving subject.** A `republished` design or a `head_moved` delivery is a
  DIFFERENT subject, so the old question is withdrawn and a new one asked. A
  revised plan is the SAME plan. Superseding it would drop the row out of To
  approve while the person is mid-conversation about it, and the fresh gate would
  land a moment later as a new question. That is two rows in the record for one
  question.
- **The same holds for the correction doors outside a lease.**
  `update_plan_proposal`, `withdraw_plan_proposal` (short of the LAST proposal —
  11.7) and a `revision: true` append on a `planned` plan each move the digest,
  and none of them supersedes. The stamp is the only mechanism that answers
  _this changed since you read it_.

**AMENDMENT (2026-10-09, Bug MOTIR-7988) — a HELD plan is LISTED under Planning,
not in Waiting on you.** The paragraph above said the row stays listed in To
approve while held, with a _Being rewritten_ pill, and that superseding would
"drop the row out of To approve". The first half is reversed; the reason against
superseding stands.

- **Nothing waits on the person while the planner rewrites the plan.** A row in
  Waiting on you says _act on this_, and the plan they would act on is about to
  change. So while the lease is held the plan gate is EXCLUDED from the queue,
  its count and the tab's watermark (`awaitingRoutedToWhere`'s `heldPlanIds`),
  and the plan is listed under the Workbench's **Planning** tab with the plans
  being written (`generatingRequestedByWhere`'s `revisingPlanIds`). When the
  lease ends — `revision_ended`, or the window running out on a revision that
  died — the row is back in Waiting on you, decidable.
- **This is a LISTING rule, not a state.** The gate stays `awaiting`, the plan
  stays `planned`, both verbs are still refused with `PLAN_REVISION_IN_FLIGHT`,
  and nothing is superseded or re-raised: it is still one question with one row
  in the record. The lease is read off the trail exactly as above
  (`planRevisionHoldService.heldPlanIds` → `revisionLeaseOf`) and its ids ride
  INTO each list's own predicate, so a count and its rows still read one `where`.
- **Every revision takes the lease now.** The hosted revision always did (the
  in-app revise route). An MCP-driven revision — `prompts/plan.py --revise` —
  took none, so the plan stayed a plain decidable question with a LIVE Approve
  for the whole rewrite: the race this section exists to stop. It now takes it
  through the `hold_plan_revision` MCP door (`start` · `renew` · `end`); `renew`
  writes a `revision_renewed` heartbeat on the trail, which the lease counts and
  the timeline does not show.
- **The _Being rewritten_ pill** (`ApprovalRow`) is still drawn wherever a held
  plan gate is rendered from another read, and no longer appears on the Waiting
  on you tab, which no longer lists the row.
  MOTIR-6041's acceptance, _"held while the planner rewrites it"_ in To approve,
  is amended to match: held, and listed under Planning.

#### 11.6 Routing and authority

- **ROUTED to `Plan.createdById`**, the person who asked for the plan
  (MOTIR-2986), written into `routedToId` at creation as §6a requires.
- **`createdById` is NULL on a `cadence` plan** by design: nobody asked, so the
  schema will not attribute the request to anyone. Routing is not attribution:
  `routedToId` records who was ASKED, not who requested it. **A null requester
  routes to the workspace OWNER**
  (`workspaceMembershipRepository.findStandInManagerByWorkspace`), the identity the
  cadence watcher already acts as (`autoPlanCadenceService`). A gate routed to
  nobody would appear in no To approve at all, which is the exact failure this
  story exists to end. A workspace with no owner row (an invariant violation the
  cadence path already logs) routes to nobody, and the gate is still decidable
  from the planning surface.
- **AUTHORITY is the permission `ai:decide_plan`, and nothing else.** §2's
  relationship rule (assignee, reporter, `approval:decide_any`) is a rule about a
  WORK ITEM, and a plan gate has none. Today any holder of `ai:decide_plan` may
  approve or decline any plan in the project, and this kind keeps exactly that.
  **The door records it under a NEW `ApprovalGateAuthority` member,
  `plan_permission`**: none of the four existing members is true of the decider.
  Recording `assignee` or `admin` would be a claim about a relationship or a key
  that does not exist, which is the reasoning `github_review` already records
  for itself. The member is MOTIR-6032's.

#### 11.7 RAISED, HELD, SUPERSEDED

| when                                                                                                                                                                 | what the gate does                                                      | where                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| a plan reaches `planned` with at least one proposal — the close (`markPlanned`), and a drift restore (`planDriftService.restoreForRevivedTarget`, `stale → planned`) | **RAISED `awaiting`** — at most one per plan (11.2's index), idempotent | the plan's own transaction    |
| a revision lease is held                                                                                                                                             | **HELD** — still `awaiting`, both verbs refused (11.5c)                 | derived, never written        |
| the digest moves outside a lease (a correction)                                                                                                                      | **nothing** — the stamp refuses stale readers (11.3)                    | —                             |
| the plan goes `stale` — `planDriftService.markStaleForTerminalTarget`, and `approvePlan`'s lazy backstop on `PlanTargetImmutableError`                               | **SUPERSEDED**, cause **`plan_stale`** (NEW)                            | the stale write's transaction |
| the LAST proposal is withdrawn, so the plan is discarded (`withdrawProposal` → `declined` / `discarded`)                                                             | **SUPERSEDED**, cause **`plan_discarded`** (NEW)                        | the withdraw's transaction    |
| a person approves or declines                                                                                                                                        | **DECIDED** through the door                                            | the door                      |

- **Why two NEW causes.** `ApprovalGateSupersedeCause`'s own header requires
  _"ONE MEMBER PER WRITING PATH, AND NO MEMBER MEANING UNSAID"_. `withdrawn` is
  documented as _"the design result was withdrawn"_, and `pulled_back` is a work
  item leaving review. Neither is true of a plan that drifted or emptied, and a
  surface rendering one of them would be telling the person something false. The
  two members are MOTIR-6032's.
- **An EMPTY close raises nothing.** `markPlanned` over zero proposals writes
  `declined` / `discarded` (MOTIR-4124), so there was never a question.
- **The abandoned-plan sweep supersedes nothing.** `abandonedPlanService`
  selects only `generating` plans (its discovery predicate and its re-check under
  the lock), and a `generating` plan has no gate. The card named it as a
  supersede cause, and at this base it cannot meet one. If the sweep ever widens
  to `planned`, it owes a cause of its own under the enum's rule.
- **Drift that REVERSES re-raises.** `stale → planned` is a raise trigger, so a
  plan that drifted and recovered is asked again: a fresh gate, because the old
  one was superseded while nobody could approve it.
- **The HELD case is explicitly NOT a supersede** (11.5c).

#### 11.8 What stays a PLAIN status write — OUT of the door

The door owns the decision of **a plan whose question is ASKED**, meaning an
`awaiting` gate exists. These writers change `Plan.status` with no gate
decision, and they are not routed through the door:

1. **`markPlanned`** — `generating → planned` (it RAISES the gate, 11.7), and the
   empty-close `declined` / `discarded`.
2. **`planDriftService`** — `planned → stale` and `stale → planned`, and
   `approvePlan`'s lazy `stale` backstop.
3. **The last-withdrawal discard** in `withdrawProposal`.
4. **`abandonedPlanService.reconcileAbandoned`** — `generating → declined` /
   `abandoned`, decided by nobody.
5. **A person declining a plan nobody is being asked about** — `declinePlan` from
   `generating` (a discard: the plan never finished) or from `stale` (its
   question was superseded, 11.7). There is no `awaiting` gate to decide, so
   there is nothing for the door to record. The plan's own row and trail record
   the ending, as they do today. **Story MOTIR-6012's criterion _"no other path
   writes a decided plan status"_ is read over the four ENTRANCES that decide a
   `planned` plan** (the plan page, the planning rail, the nudge and the v1 route,
   MOTIR-6038). That reading is recorded here so a later pass does not route
   these two through a door that has no gate to lock.

   **⚠️ AMENDED 2026-10-08 by Story MOTIR-7883 (MOTIR-7891).** The entrance list
   above — _"the four ENTRANCES that decide a `planned` plan (the plan page, the
   planning rail, the nudge and the v1 route, MOTIR-6038)"_ — no longer holds for
   the plan page and a member: a member decides an undecided plan in the planning
   overlay, open session or ended (11.5b, as amended). The plan page's verbs
   remain only for the null-session breach. **What this does NOT drop:** the
   reading itself — the criterion is still read over the entrances that decide a
   `planned` plan, and the two ends above still need no door.

**And the converse, which MOTIR-6038 makes true:** while an `awaiting` plan gate
exists, **no path but the door** writes `approved` or `declined` onto that plan.
`plansService.approvePlan` / `declinePlan` stop being public deciding doors and
become the handler's `…Within(tx)` effects.

#### 11.9 The BACKFILL

> **⚠️ AMENDED 2026-09-23 (MOTIR-6039), by the requester's decision: the backfill
> RUNS AS A DATA MIGRATION, WITH THE DEPLOY.** The original text below is struck.
> Any gap between the deploy and a manual run leaves every already-`planned` plan
> missing from To approve and answering _not decidable yet_ at every approve door
> (11.8). The reasons given for "never through raw SQL" do not survive a check:
>
> - **routing** (11.6) is `COALESCE(plan.created_by_id, <the workspace's earliest
owner membership>)`, exactly `resolvePlanGateRoute`;
> - **uniqueness** (11.2) is `NOT EXISTS (awaiting gate)`, backed by
>   `approval_gate_one_awaiting_per_cardless_subject`;
> - the **digest** (11.3) cannot be reproduced in SQL, and it does not need to be.
>   The decide door stamps a `plan_approval` gate against the LIVE digest
>   (`stampsLiveVersion`) and records the version at decision time, so a
>   backfilled row carries a NULL `subject_version`.
>
> **What ships:**
>
> - `20260923200200_backfill_plan_approval_gates`: one `INSERT … SELECT` that
>   raises an `awaiting`, card-less gate for every `planned` plan with at least
>   one proposal and none awaiting. It is idempotent and cross-tenant (it runs as
>   the migration owner).
> - `pnpm db:backfill:plan-gates` stays as the tool that VERIFIES and REPAIRS.
>   It goes through the shipped raise, one transaction per plan, with a
>   `--dry-run`. After the deploy its dry-run reports 0 to raise.
>
> **The accepted cost** is that the population and routing rules exist a second
> time, in SQL, frozen at this deploy. A migration runs once, so it only has to
> match the rules as they stand at that deploy. A test proves the two copies agree
> by checking that the script's dry-run predicts exactly the migration's rows.
> **No operator step is owed after the deploy.**

~~Every plan already `planned`, with at least one proposal and no `awaiting` gate,
gets one **through the shipped raise** (MOTIR-6036's function, the same one
`markPlanned` calls), never through raw SQL, so the routing (11.6), the index
(11.2) and `routedToId` are exactly what a live raise writes. Idempotent by the
index. One transaction per plan, so one failure does not roll back the rest. A
`--dry-run` that reports what the real run would raise and routes nothing. The
script is MOTIR-6039's. **Running it on production is NOT this story's**: that is
an operator step after the deploy, owed as its own `manual` card.~~

#### 11.10 §10's plan row, and the KIND table's row

**§10h's `plan_approval` row is amended** — ~~_— no refusal verb_ · — · — · — ·
out~~:

| kind · case                  | refusal verb(s), reason (10a)                                          | verdict at the press (10d) | status written by the refusal                               | planner opens (10f)                                                                                                                       | built by   |
| ---------------------------- | ---------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `plan_approval` (MOTIR-6012) | **Decline** — reason OPTIONAL (11.4); _Request changes_ is not offered | none                       | none on a work item — the PLAN goes `declined` / `reviewed` | **none** — a decline ends the question; changing a plan is a conversation, and the planning surface is already where the decision is made | MOTIR-6035 |

**§10i's _"a refusal verb on the plan gate (MOTIR-6012 has none)"_** is read as
_"no `request_changes` on the plan gate"_. The gate's one refusal, `decline`, is
decided here.

**The KIND table's row:**

| kind            | the port shows                                                                                                                   | fires when                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `plan_approval` | **no port** — the planning OVERLAY at the plan's session, open or ended (11.5b); a member reaches an undecided plan nowhere else | a plan reaches `planned` with at least one proposal (11.7) — **never** a work item's review |

**⚠️ AMENDED 2026-10-08 by Story MOTIR-7883 (MOTIR-7891).** The port cell above
read: _"**no port** — the planning surface at the plan's conversation, or the plan
page when it has none (11.5b)"_. The plan-page fallback is retired: an undecided
plan is reached only in the planning overlay, whether its session is open or has
ended, and a typed `/plans/<id>` for one replace-redirects there (11.5b, as
amended). **What this does NOT drop:** _fires when_, unchanged, and the kind's
having no port.

#### 11.11 What this section does NOT decide

The row's and the surface's words and layout (MOTIR-6033). The hand-off message
before generation (MOTIR-6033 draws it; MOTIR-6037 builds it). Refusing a manual
move of a plan's cards out of Planning, which is Story MOTIR-6017, the consumer of
this gate. Notifications. Where a plans row opens (Story MOTIR-6043, which
consumes 11.5b's fallback). _(⚠️ AMENDED 2026-10-08 by Story MOTIR-7883
(MOTIR-7891): that fallback is retired by Story MOTIR-7883, which now owns where
every link to an undecided plan lands — the planning overlay at the plan's
session, open or ended (11.5b, as amended).)_ ~~Running the backfill on production (11.9).~~ The backfill now runs with the deploy (11.9, amended).

---

### 12. The AGENT-REVIEW kind — a hosted AI reviews the delivery set BEFORE anyone is asked to approve it — NEW (MOTIR-6815 for Story [9.8](motir:cmr89sbe1000104i85hxeotab) · MOTIR-1626, 2026-09-29), DECIDED BY THE PLANNER on the story's settled shape

**Why this is a gate kind and not a new mechanism.** A review agent answers the
same question a person answers on the approve-and-merge gate — _is this code
right for this card?_ — one step earlier, and its answer has to be recorded
with who gave it, at which commits, and what it caused (§6a). That is exactly
what a gate row is. So the agent joins the registry as a seventh kind rather
than as a column, a job status or a comment convention, and every rule below is
a rule about that kind.

**Read at base `351724043`** (motir-core `origin/main`, 2026-09-29), after
§4's SIXTH AMENDMENT (MOTIR-6844). Every seam named below was read there. The
story's other cards build against these subsections and cite them by number:
MOTIR-6818 (schema), MOTIR-6819 (the gate), MOTIR-6820 (starting the run),
MOTIR-6821 (the prompt and the verdict route), MOTIR-6822 (`motir fix`),
MOTIR-6904 (the convention), MOTIR-6824 (the CLI), and the two designs
MOTIR-6816 / MOTIR-6817 with their builds MOTIR-6823 / MOTIR-6825.
`hosted-agent-run.md` §8 decides the review RUN, which is what answers this gate.

#### 12.1 The kind is `agent_review`, hung on the run target, about the delivery SET

- **`ApprovalGateKind.agent_review`** is a new enum member, with a handler in
  the registry like every other kind (§1).
- **It hangs on the RUN TARGET**, `resolveRunTarget` (`lib/services/runTarget.ts`),
  exactly where `pull_request_approval` hangs (§8's MOTIR-5479 amendment,
  decision 1). A child the same pull requests also deliver gets no gate.
- **Its subject is the delivery SET**, in the approve-and-merge gate's own form
  (§8's MOTIR-5479 amendment, decision 2): `subjectId` is the work item's own
  id, and `subjectVersion` is `deliverySetVersion`
  (`lib/approvalGates/deliverySetVersion.ts`), each member as
  `owner/name#number@headSha`, sorted and comma-joined. **One stamp, one
  function**: the review is about exactly the commits the approve-and-merge gate
  would be about, so a pass can hand its version to that gate unchanged (12.4).
- **At most one awaiting `agent_review` per run target.** The partial unique
  index `approval_gate_one_awaiting_per_subject` over
  `(work_item_id, kind, subject_id) WHERE state = 'awaiting'` already enforces
  it, with no new index.
- **It is CARDLESS FOR ROUTING.** `routedToId` is written by §2's rule
  (`assigneeId ?? reporterId`) as for every card gate, because 12.3's override
  is that person's. But the gate asks the AGENT, not the person, so it **never
  appears on a person's To approve list and raises no notification**: the
  awaiting-routed read (`awaitingRoutedToWhere`,
  `lib/repositories/approvalGateRepository.ts`) excludes the kind, as it already
  excludes a carried merge gate. The person meets it on the card, in the
  Development frame, and only there.

**The KIND table's row** (§1's MOTIR-4911 amendment):

| kind           | the port shows                                                                                   | fires when                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_review` | the agent's verdict and findings, above the approve-and-merge gate's own port (MOTIR-6817 draws) | the run target's delivery set is **all green** and `Project.reviewAgentEnabled` is true (so the project asks before merging, 12.2a), at a version not yet decided (12.2) |

**The REGISTRY row** (§1's handler table):

| a handler supplies              | for `agent_review`                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| how to resolve the SUBJECT      | the run target's delivery set at `subjectVersion`, the same members the approve-and-merge gate resolves                           |
| who it ROUTES to                | §2's rule, written for 12.3's override only — never listed or notified (above)                                                    |
| which PERMISSION authorises it  | the agent: the review run's token on the verdict route (12.3). A person: `work_item:edit`, the approve-and-merge gate's own floor |
| which STATUS TRANSITION it owns | **none.** A pass raises the ordinary flow, which owns its own writes; a refusal writes nothing (12.4)                             |
| what `approve` DOES             | raises the ordinary flow for the SAME version (12.4)                                                                              |
| what `request_changes` DOES     | records the findings; the card is To fix `changes_requested`; nothing moves and nothing re-runs (12.4)                            |
| what to RETAIN on approval      | nothing — the findings are text on the row, and the commits are durable on the host                                               |

#### 12.2 WHEN it is raised — the green verdict, INSTEAD of the ordinary flow

The trigger is the all-green verdict on the run target's set — the one
`lib/services/ciPromotion.ts` judges in `everyDeliveryIsGreen` and settles in
`settleMergesForCard` — **when `Project.reviewAgentEnabled` is true.** Then,
and only then, the green verdict raises `agent_review` **INSTEAD OF**:

- **`pull_request_approval`** (§8's MOTIR-5479 amendment, decision 3), in a
  project that asks before merging.
- ~~**the `pull-request/auto-merge.requested` emit, in an `auto` project**
  (`dispatchAutoMerges`; §4's second amendment, decision 9).~~ **Struck the same
  day by the requester — §12.2a.** An `auto` project has no review agent.

#### 12.2a The review agent and `auto` merging EXCLUDE each other — DECIDED BY THE REQUESTER (Yue, 2026-09-29)

_"Review agent on and Merge automatically can't be true at the same time"_ —
the requester's note on MOTIR-6816's design gate, which sent back a design that
drew the switch ON beside _Merge automatically_. A review exists to stand in
front of a person's approval; a project that merges without asking anyone has
no such approval for it to stand in front of.

- **`Project.reviewAgentEnabled` may be `true` only while `Project.prMergeMode`
  is `manual`.** Turning it on in an `auto` project is REFUSED by the switch's
  write (`approvalGateSettingsService`, a typed `409 REVIEW_AGENT_NEEDS_MANUAL_MERGE`),
  never silently accepted and never silently switching the merge mode.
- **`auto` may be chosen only while the review agent is off.** Choosing
  _Merge automatically_ with it on is REFUSED by the merge-mode write
  (`projectPrMergeModeService`, `409 MERGE_MODE_REVIEW_AGENT_ON`). Neither write
  changes the other setting for the person: they turn one off, then the other on.
- **The establishment default cannot collide**: it writes `prMergeMode` only on a
  project nothing has decided yet (§7's MOTIR-5174 amendment), and a new project's
  review agent is off.
- **So `agent_review` is never raised in an `auto` project**, and nothing below
  has an `auto` branch. The settings room draws the exclusion on both controls
  (MOTIR-6816).

**The rule lives in ONE place: `resolveGateSet` (`lib/approvalGates/gateSet.ts`).**
Which gates a card asks is decided there and nowhere else, and
`reconcileGatesFor` (`lib/services/gateSetFor.ts`) is the one place a gate row
is created. The approve-and-merge gate is raised from more than the promotion:
from a status move into the review band, from the reconcile tick, after a
queue exit and after every withdrawal's re-raise. **A condition added at the
promotion alone would be bypassed by all of those.** So `agent_review` joins
`AwaitableGateKind`, and the predicate's answer for a green set with the switch
on is: _ask the review, and do not ask the merge question_, until the review at
this version has passed or been overridden.

- **One review per version.** A version already decided — `approved`,
  `changes_requested`, or overridden — is never raised again. A redelivered or
  repeated green verdict at the same version starts nothing: it finds the
  decided row and raises no gate, so no second review run starts (12.6).
- **A PRIMARY question is not delayed** — `design_result`, `decision_approval`
  and `acceptance_result` are still raised on their own triggers (§1, §8's
  FIFTH AMENDMENT). What the review holds is the MERGE, and that includes the
  merge a primary's press CARRIES (§8's FIFTH AMENDMENT clause 5, the carry in
  `resolveGateSet`). **A primary approved while the review is awaiting records
  its decision and carries nothing yet**; the merge it authorised is settled
  when the review passes, the same way `settleAfterPrimaryApproval` settles a
  primary approved before its set was green. So no code merges unreviewed,
  whichever gate a person pressed.
- **A GitHub review never decides `agent_review`.** §8's FOURTH AMENDMENT's
  review sync decides `pull_request_approval` only. A GitHub approval given
  while the agent is reviewing is RECORDED, as every review is (MOTIR-5597,
  decision 8), and it is applied to the approve-and-merge gate when a pass
  raises that gate (`evaluateAfterRaise`). A GitHub approval of a head the agent
  then sends back applies to nothing: the fix moves the head, and a review
  counts only at the current commit.

**THE TRIGGER DIFF, written out** (the lesson on collapsing two approvals —
compare the two gates' triggers before putting one in front of the other):

|                                                                                   | trigger                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| the approve-and-merge gate, before this section                                   | the run target's set is **all green** (and `manual`)                             |
| the approve-and-merge gate, after this section, switch on (`manual` only, §12.2a) | the set is all green **AND the review at this version passed or was overridden** |

**The population that difference strands is exactly _the review could not run_**:
a green set whose review never produced a verdict — no credits, no model, a
repository the run cannot read, a run that died or ended without a verdict.
Without a rule it would sit green, asked of nobody, with no surface saying a
decision is owed. **12.6 gives it both**: the gate stays awaiting on the card
and says why, and the person it is routed to can start it again or continue
without it, on the record.

#### 12.3 WHO decides it — the agent, or the routed person overriding on the record

- **The review agent**, under a new authority member
  **`ApprovalGateAuthority.review_agent`**. It decides through the run-token
  verdict route `POST /api/v1/work-items/{key}/agent-review`, never through the
  MCP, because a run token is refused by the MCP (`lib/mcp/auth.ts`, the
  `dispatchRunId` arm). The route accepts a verdict only from the token of a
  `review` run opened for THIS gate (`hosted-agent-run.md` §8). `decidedById` is
  the run's attributed user (§8 there), and the authority column is what says a
  machine decided — the same honesty §7a asks of `auto`: the row does not claim
  a person reviewed the code.
- **A person, through _Continue without the review_** — the person the card is
  routed to, by the existing `resolveGateAuthority` set (assignee, the reporter
  when there is no assignee, or `approval:decide_any`), at the
  `work_item:edit` floor. It decides the gate `approved` **under their name and
  authority**, with a **REQUIRED note** (§10a's rule, extended to this press
  although it is not a refusal: waving a review past is the decision that most
  needs its reason). The row then says _a person continued without the review,
  and why_ — never that the agent passed it.
- **Nobody else.** No other door decides the kind; a GitHub review does not
  (12.2).

#### 12.4 WHAT each decision does

- **`approved` (a pass, or an override) raises the ordinary flow for the SAME
  version**, in the decide transaction:
  - `pull_request_approval` at the reviewed `subjectVersion`, through
    `reconcileGatesFor`. The agent's review shows in that gate's frame, above its
    port (MOTIR-6817 draws, MOTIR-6825 builds).
  - ~~in **`auto`**: the auto-merge emit …~~ **Struck (§12.2a)** — there is no
    review in an `auto` project, so a pass never emits a merge.
  - The `agent_review` row is a real decision by a named authority, never a
    stand-in approval of the merge: the person still decides the merge.
  - If the set moved between the verdict and the decide transaction, the pass
    is stale and 12.5's last rule applies: it decides nothing.
- **`changes_requested` MOVES NO STATUS.** The card stays where CI put it. The
  gate records the agent's findings (Markdown, required and non-empty) as its
  note, and **the card is To fix `changes_requested`**: `lib/workItems/fixReason.ts`
  derives it from a standing refusal at the current delivery-set version,
  extended from the approve-and-merge gate (`standingMergeRefusalOf`) to this
  kind, with the review agent as the decider and the findings as the reason.
  - **The repair is `motir fix <KEY>`**, on the pull requests' own branches, with
    the findings in its prompt (MOTIR-6822 builds the repair class) — **or the
    same repair on the HOSTED agent, pressed by a person** (§12.4b).
  - **Nothing re-runs by itself** — not a hosted build, not a hosted fix, not a
    second review (Yue, 2026-09-28: the card may have been built on someone's
    own machine). The next review starts only from the next green version.

#### 12.4b A card SENT BACK can be repaired on the HOSTED agent — DECIDED BY THE REQUESTER (Yue, 2026-09-29)

_"To fix after review should be able to run in the hosted agent too"_ — the
requester's note on MOTIR-6817's design gate. It reverses the first draft's line
in 12.9 (_"a hosted `motir fix` … is its own ask"_) for exactly this population.

- **Who it is for:** a card that is To fix `changes_requested` because a REVIEW
  sent it back — the review agent's `changes_requested` (12.4) or a person's
  _Request changes_ on the approve-and-merge gate (12.7). Other To-fix reasons are
  not widened here (see 12.9).
- **What starts it: a PERSON'S PRESS, never the refusal.** Beside the copyable
  `motir fix <KEY>`, the Development frame, the To fix banner and the Workbench
  row offer **Fix on the hosted agent**. It is offered to whoever may start a
  hosted run on the card today (the Run hosted rule) and runs the SAME repair a
  local `motir fix` runs: the server's repair claim (one repair at a time), the
  pull requests' own branches, the findings in the prompt. 12.4's _nothing re-runs
  by itself_ is untouched — the press is the person choosing to spend.
- **What it does to the gate:** nothing directly. Its push moves the head, which
  supersedes the refusal's version (12.5), and the next green version is reviewed
  again (12.2). A repair that pushes nothing leaves the card To fix, as a local
  repair that pushes nothing does.
- **The run itself** — command, credential, mode, what it may push — is
  `hosted-agent-run.md` §8.6.

#### 12.5 WHEN it is withdrawn

- **A head move, a close, a draft or a red build** supersedes an awaiting
  `agent_review` exactly as it supersedes `pull_request_approval` — the
  withdrawals in `lib/services/pullRequestApprovalGates.ts` (head move, close,
  draft, conflict, CI failure, set change) retire both kinds, each with the
  `ApprovalGateSupersedeCause` it already writes, and no decision field is
  touched (§6b). The next all-green verdict raises a fresh review at the new
  version (12.2).
- **Switching the review agent OFF** supersedes every awaiting `agent_review`
  in the project, under a cause of its own (`review_agent_disabled`), and, for
  each run target whose current set is green, raises the ordinary flow for the
  current version at once — the approve-and-merge gate. A decided
  `agent_review` is history and stays.
- **A superseded review's RUN is CANCELLED.** Whatever superseded the gate — a
  withdrawal above or the switch — the review run in flight for it is cancelled
  (`DispatchRunStatus.cancelled`, `hosted-agent-run.md` §2), because its answer
  can no longer decide anything and it is still being paid for. That is what the
  switch card's _"reviews in progress are cancelled"_ means (MOTIR-6816).
- **Switching it ON** asks nothing of a card already holding an awaiting
  approve-and-merge gate — that question was asked before the switch and stays
  asked. The next version is reviewed.
- **A verdict arriving for a superseded gate** — the push landed mid-review —
  **decides nothing**. It never re-opens, re-decides or raises anything. Where
  the run is still alive to send it (a gate decided or superseded without the
  run being cancelled yet, or a verdict about another version), it is recorded
  on the review RUN as a `review_verdict` event naming the verdict and the
  version it was about. **Where the supersede already CANCELLED the run** (the
  rule above), its credential is revoked with it, so the late verdict is
  refused at authentication and nothing is recorded — the run's own cancelled
  close is the record (MOTIR-6826 found this; amended 2026-09-29).

#### 12.6 A review that CANNOT RUN

A review cannot run when the start is **refused before anything boots** — the
organisation has no agent credits, no model is offered (`hosted-agent-run.md`
§7), a delivery-set repository cannot be read with the run's credential — or
when the run **ends with no verdict** (it failed, stalled, timed out, was
cancelled, or exited without submitting one).

- **The gate STAYS `awaiting`, and carries the reason** on the gate row — never
  in the note, which belongs to whoever decides it (MOTIR-6820 writes it). The
  Development frame shows _Review could not run_ with that reason (MOTIR-6817).
- **_Review again_** — a press by the routed person, same authority as the
  override — re-requests ONE review run for the same gate and version, and
  clears the reason while it runs. **There is no automatic retry.**
- **The escape is 12.3's _Continue without the review_.** Nothing is waved
  through silently: a stranded card is visible on its own page, and leaving it
  takes a named person and a written reason.

#### 12.7 A person's REQUEST CHANGES on `pull_request_approval` — its repair is `motir fix`

Independently of the switch: a standing `changes_requested` on the
approve-and-merge gate derives To fix `changes_requested` today, with the repair
verb **`run`** (`lib/workItems/fixReason.ts`). `run` cannot repair it — the card
is in the in-progress category, and both claim doors take only the to-do
category (`lib/workItems/claimOutcome.ts`). **The repair is corrected to
`fix`**, the same repair 12.4 names for the agent's refusal (MOTIR-6822). An
acceptance Re-run keeps its own repair.

#### 12.8 §10's row

**§10h gains a row:**

| kind · case    | refusal verb(s), reason REQUIRED (10a)                                                  | verdict at the press (10d) | status written by the refusal                 | planner opens (10f)                                                           |
| -------------- | --------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `agent_review` | the agent's `changes_requested`, findings REQUIRED; a person has no refusal verb (12.3) | none                       | none — To fix, repaired by `motir fix` (12.4) | **none** — the findings are the brief, and the repair is a fix, not a re-plan |

**§10h's `pull_request_approval` row** keeps _status written: none_; its repair
is `motir fix`, not a run (12.7).

#### 12.9 What this section does NOT decide

- **The review RUN** — its command, mode, attribution, billing, credential,
  prompt inputs and the optional coding convention. That is
  `hosted-agent-run.md` §8.
- **The words and layout** of the switch card, the frame states and the To fix
  row. MOTIR-6816 and MOTIR-6817 draw them.
- **Merge mode, the approve-and-merge gate, its press and the merge** (§4, §7,
  §8; MOTIR-4909, MOTIR-4882). Consumed, not re-decided.
- **GitHub review sync** (§8's FOURTH AMENDMENT; MOTIR-4910). Motir still posts
  nothing to GitHub, and the agent's review lives in Motir only.
- **Automatic re-runs after any review.** Deliberately none. The design-only
  automatic re-run is Story 9.2's (§10g).
- ~~**A hosted `motir fix`.** The hosted launcher runs `run`, `continue` and, after
  this story, `review`. A hosted repair is its own ask.~~ **Reversed by the
  requester (12.4b):** a card a REVIEW sent back can be repaired on the hosted
  agent by a person's press. A hosted repair for the OTHER To-fix reasons (red CI,
  a merge-queue failure) is still not decided here.
- **Reviewing designs, acceptance videos or plans.** `agent_review` is about a
  delivery set's code only.

---

## Consequences

- **The `design_result` gate is the only kind that ships in MOTIR-4778.** The
  registry carries a deliberate compile-time hole where `pull_request_merge`'s
  handler goes, so MOTIR-4882 cannot register without the compiler agreeing.
- **MOTIR-4788 grows** — the audit columns of §6a, the fourth state of §6b, and
  the accumulate-don't-replace property of §6d. Its estimate predates all three
  and is flagged for re-sizing.
- **MOTIR-4790 grows** — the pin of §6c, the supersede predicate, and the
  `superseded` write of §6b, each needing a concurrency test. Same flag.
- **A new permission key reaches `member`'s effective capability set for the
  design gate only** (`work_item:edit`, already held). The merge key is
  additive and held by nobody until a role is edited.
- **`design-result.md` §7 is amended** by this record's pull request; it is the
  only file outside this one that changes.
- **Storage grows with approvals, and only with approvals** — bounded by human
  clicks, which does not scale the way CI artefacts do.

> ### Consequences — AMENDMENT (MOTIR-4911, 2026-09-08)
>
> - **The `approved` work-item status is a new consequence, and it is a
>   MIGRATION** — a status row, its two transitions, and its `restricted`-policy
>   edges. It is a sibling story's, not MOTIR-4778's, and §6b says so.
> - **MOTIR-4788 grows again** — `decisionSource: github`, the unmappable-actor
>   label, and a `subjectId` typed as an opaque id with a per-kind resolver rather
>   than a concrete FK (§1). Its estimate predates all of it.
> - **MOTIR-4790 grows again** — the pin's predicate is now keyed on the SUBJECT
>   (§6c), which is a different query from the one its estimate assumed, and the
>   discriminator read (§8) is a delivery-row join it did not carry.
> - **No new permission key reaches anybody.** §2's amendment retires the
>   role-derived answer entirely: authority is a relationship, and
>   `work_item:merge_pull_request` exists only to sit in
>   `IRREVERSIBLE_PERMISSIONS` so no API token can confer merge.
> - **`design-result.md` §7 is amended a SECOND time** by this record's
>   amendment pull request, for §6c's re-keying. It remains the only file outside
>   this one that changes.
> - **A coding card's deliverable grows a HOW TO TEST section** (§9), written onto
>   the work item (per RUN, on the run target — see §9's 2026-09-13 amendment). That is an authoring obligation on every card that produces a
>   pull request, and it is what the approval port renders.

## What SHIPPED — the dated close-out (MOTIR-4795, 2026-09-10)

Read on `origin/main` @ `d4981d354`, against the code MOTIR-4788 (the record),
MOTIR-4790 (the decide door and its registry), MOTIR-4792 (the frame), MOTIR-4912
(the audit columns) and MOTIR-4913 (retention) landed.

**Most of this record shipped as decided**, and where it did the code says so
itself: §1's registration table, §2's routing and its amended authority rule,
§6a's audit set, §6b's four states and its `(work_item_id, kind, subject_id)`
partial unique index over `awaiting`, §6c's pin, §6d's accumulate-don't-replace,
and §8's discriminator — read from the delivery rows exactly as §8 says, in
`designResultHandler.approve`. **§6b's and §6c's own SHIPPED notes above carry
the two clauses whose mechanism changed while they were being built**, including
the finding that the MOTIR-4911 amendment's restatement of §6c's predicate was
not implementable; they are not restated here.

**Three places the implementation DIVERGED, and each is a decision rather than a
shortfall:**

### 1 · §1 and Consequences — the registry is total over the REGISTERED half, and there are THREE holes, not one

§1 says the registry is `Record<ApprovalGateKind, GateHandler>`, and Consequences
names ONE deliberate hole, _"where `pull_request_merge`'s handler goes"_. Both
predate MOTIR-4911's amendment, which added `decision_approval` and split the
pull-request kind in two — so the enum has **four** members and this build
registers **one**.

A `Record` over the whole enum cannot express that: it would not compile with
three handlers missing. What shipped (`lib/approvalGates/registry.ts`) is
`Record<RegisteredGateKind, GateHandler>` plus a declared
`UnregisteredGateKind = Exclude<ApprovalGateKind, RegisteredGateKind>` and a
`UNREGISTERED_GATE_KINDS` tuple asserted, at the type level, to enumerate it
exactly.

**The guarantee §1 asks for is preserved and is strictly stronger:** a new enum
member fails the build until it is CLASSIFIED (registered, or named as a hole),
and promoting a kind fails the build until its handler exists. The obvious
alternative — `Record<ApprovalGateKind, GateHandler | null>` — was considered and
rejected in the file itself, because `null` is a value, so
`decision_approval: null` compiles silently and the hole stops being a decision
anybody made.

### 2 · §8's Workflow B — the design gate writes NO status when a pull request is open. It does not write `approved`

§3's amendment and §8's Workflow B land such a card in the **`approved`
work-item status**. That status does not exist:
`lib/workflows/defaultWorkflow.ts` carries eight statuses — `todo`, `blocked`,
`in_progress`, `implemented`, `planning`, `in_review`, `done`, `cancelled` — and
no `approved`, and the live tenant's own project workflow carries the same eight.
§6b's amendment already says the migration is a sibling story's; that sibling is
**MOTIR-4905**, still `todo`.

So `designResultGateHandler.approve` returns
`{ statusWritten: null, statusDeferredReason: 'merge_writes_done' }` in that arm.
Writing the status the ADR names would resolve to `UnknownStatusError` on every
request that reached it.

**The invariant is untouched, which is why this is a divergence in the WRITE and
not in the model:** `done` still has exactly one writer, and in this arm it is
the merge webhook. What is missing is only the intermediate place to pause. When
MOTIR-4905 ships, the arm gains one `applyStatusTransition` call and nothing else
moves.

**⚠️ And this arm is not the ordinary path for `design_result` at all.** §1's
amendment keys the kind to _a design with no pull request_; a design that opened
one is Workflow B and takes a `pull_request_approval` gate, which this build
leaves as a registry hole. The arm exists because a gate is created when the
subject is PUBLISHED and the question is asked at DECISION time — a pull request
can appear in between — so a door that assumed its own kind's precondition still
held would write `done` over work that had not merged.

### 3 · §6a — `routedToId` carries NO surviving label, and `decidedById` does

§6a's table asks for _who it was ROUTED to_ and _who decided, surviving their
departure_ as two separate rows, and says nothing about whether the first also
needs to survive. Both columns shipped `onDelete: SetNull`; only `decidedById`
gained the denormalised `decidedByLabel` beside it.

That is deliberate. The harm §6a names for the routing field is the ROUTING
MOVING — the assignee can change after the gate is created, so the live card
cannot answer who the product actually ASKED — and a deletion does not cause it.
The attribution the audit is built around is the DECIDER's, and a null there
already means something else and something worse: §6b's `superseded` uses exactly
that shape to mean _the question was withdrawn and nobody decided it_.

---

**What has NOT shipped**, so that this record's silence is not read as delivery:
the **Approvals tab** (gates are decided on the work item's own page), the
**merge gate** and everything in §4, **`prMergeMode`** and everything in §7 —
including the rename and the tier move, which are still pending, so
`Workspace.subtaskPrMergeMode` stands as it did — the **`decision_approval`** and
**`pull_request_approval`** handlers, §9's HOW TO TEST section as a rendered
port, and two states of the frame itself (MOTIR-5032's port floor / ceiling /
Expand and its `X` state; MOTIR-5033's decided and superseded states). The
user-facing page carries the same list in the user's own words —
[`docs/approval-gates.md`](../approval-gates.md) § _What does not exist yet_.

**Consequences' last pointer is discharged:** _"`design-result.md` §7 is amended
by this record's pull request"_ — it was, by MOTIR-4786, and twice more since
(MOTIR-4911's re-keying and MOTIR-4913's correction of it). Nothing further is
owed there.

### Deliberately NOT decided here

- **The decision gate.** ⚠️ **AMENDED (MOTIR-4911, 2026-09-08): the KIND is now
  decided — `decision_approval` is in §1's enum, with its port and its verbs.**
  ~~named by the requester as a future kind. §1's table says how it registers;
  this record ships none.~~ ~~What is still not decided is its **HANDLER** — the
  resolver for a decision document, and where that document lives before the
  `pages` domain hosts it.~~ **AMENDED (MOTIR-5672, 2026-09-19): the HANDLER is
  now decided too — §8's FIFTH AMENDMENT.** The document lives in the card's
  mandatory pull request, at `docs/decisions/*.md`; Motir stores only its
  identity at the head, and reads its content through a resolver the `pages`
  domain will later replace. ~~`decision_choice`, the N-option verb set, is named in
  §1 and likewise ships nothing here.~~ **AMENDED (MOTIR-5887, 2026-09-21):
  `decision_choice` is decided too — keyed on `type: choice`, its handler row in
  §1's MOTIR-5887 amendment.** **AMENDED (MOTIR-5952, 2026-09-21): and the
  DECISION work item's own gate — `decision_confirmation`, keyed on `type:
decision` + `executor: human` — is decided in §1's MOTIR-5952 amendment.**
  **AMENDED (MOTIR-7427, 2026-10-03): and the decision document's move into the
  `pages` domain is decided — §8's NINTH AMENDMENT.** A published page version is
  the subject when a card has one; the file in a pull request remains the subject
  when it has none. Migrating historical `docs/decisions/` files into pages, and
  page ↔ work-item mention links, are still not decided here.
- **A plan awaiting approval and the `planning-session` gate.** **AMENDED (MOTIR-7911,
  2026-10-09, decided by MOTIR-7906):** a plan that waits for approval — including one
  that sits beside a failed attempt in the same session — stays on `plan_approval` (§11)
  and keeps its row in Waiting on you. The `planning-session` gate is about the SESSION
  needing its person; it never replaces or doubles a plan's own question, and the two
  open the same overlay. **AMENDED (MOTIR-7937, 2026-10-10):** a failure beside a waiting
  plan (situation 2) is not a gate either — it lists in To resume, and the waiting plan's
  own gate is still `plan_approval`.
- **Re-homing the ACCEPTANCE gate.** `AcceptancePanel` is the language §1
  generalises from and is deliberately left where it is; folding it onto the
  Approvals tab is its own story.
- **Notifications** — no gate email, no bell change.
- **Cross-project routing** — the Workbench is active-project scoped.
- **A merge QUEUE or branch protection on a provisioned repository** — that is
  MOTIR-4161's separate decision, about semantic conflicts between two green
  pull requests, and is a different question from who presses merge.
- **Whether a gate can be delegated or re-routed** after creation. Nothing in
  this record forbids it; nothing implements it.
