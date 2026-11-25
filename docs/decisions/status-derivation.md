# ADR: Bidirectional status derivation — parent↔child

- **Status:** Accepted (2026-08-03)
- **Story / Subtask:** Bidirectional status derivation (MOTIR-1615) · Subtask MOTIR-1616
- **Supersedes / superseded by:** none
- **Consumed by:** MOTIR-1617 (design: the settings toggles), MOTIR-1618 (the two
  `Project` toggle columns + settings read/update), MOTIR-1619 (the direct-children
  status aggregate), MOTIR-1620 (`parentStatusRollupService` — the UPWARD ladder),
  MOTIR-1647 (`childStatusCascadeService` — the DOWNWARD cascade), MOTIR-1621 (the one
  `work-item/transitioned` consumer dispatching BOTH), MOTIR-1622 (settings UI),
  MOTIR-1625 (the `in_progress → done` default-workflow edge), MOTIR-1623 / MOTIR-1624
  (integration + E2E).
- **Amended:** 2026-08-17 (Yue · Story MOTIR-2888 · Subtask MOTIR-2889, settling
  MOTIR-2885) — **the UPWARD direction becomes a RECOMPUTE.** The parent's status is a
  function of its children's CURRENT statuses, applied whether the result is forward or
  backward. §3 gains a **fourth (`todo`) rung**; §5's `Forward-only` bullet is
  **replaced**, not softened; §3 records the direction-decides-the-authority split (a
  backward move is a privileged `{ system: true }` set); a new **§3a** records the
  trigger surface, because a recompute is a function of the CHILD SET and derivation
  rides `work-item/transitioned` alone today; §5's termination proof is replaced with one
  that does not appeal to forward-only. **No work item is exempt** — the rule changes for
  every parent in every project. **Amendment consumed by:** MOTIR-2890 (design: the
  four-rung settings surface), MOTIR-2891 (`parentStatusRollupService` — rung 4 + the
  recompute), MOTIR-2892 (the trigger seam), MOTIR-2893 (settings copy, en + zh),
  MOTIR-2894 (integration + E2E).
- **Amended:** 2026-08-17 (Yue · MOTIR-2901) — **the FORWARD arm applies the recompute by
  WALKING the ladder**, taking the highest legal stepping stone at or below the target and
  repeating, instead of one hop with a fallback to the next matching rung. The single-hop
  rule stranded a parent whose whole child set finished before the first derivation pass
  ran: the all-done aggregate matches exactly one rung, so there was nothing below `done`
  to fall to, and `todo → done` is not an edge. §3's FORWARD bullet and its
  one-move-per-pass bullet are **replaced**; §5's termination proof gains **part 3** (the
  walk is bounded by a strictly increasing rank on a four-point scale, inside one pass, and
  re-emits nothing without a child-set change); **Consequence 10** records the multi-revision
  activity feed. **NO `workflow_transition` row was added** — in particular not
  `todo → done`; the board's draggable edges are unchanged.

- **Amended:** 2026-08-17 (MOTIR-2957) — **§4's trigger is read off the TRANSITION, never
  off the row.** The clause itself is unchanged (_"an item **transitions into** a
  done-category status"_), and always described the MOVE; the implementation tested it by
  re-reading the item and asking whether it _was_ done at job time, which is a different
  predicate. The two agree except when a concurrent derivation has moved the item in
  between — the case the amendment above made common, because a `work-item/created`
  recompute for a child created moments BEFORE the parent was set Done pulls the parent
  back to rung 4 and the row read then **cancelled the very cascade that would have
  completed that child**. Neither direction acted, the child set never changed again, and
  the tree settled at `todo` with the user's Done discarded: **7 of 20** parents,
  measured on `origin/main` @ `a09c21ee`. §5's concurrency bullet gains the **cascade-trigger**
  half it was missing — it reasoned only about a stale CHILD read, and said nothing about
  the parent status the cascade itself reads to decide whether to fire (the sibling entry
  below adds the OTHER parent-side half, about the row a backward set overwrites). Part 2
  of the termination argument is now sound rather than nearly so — it always assumed the cascade
  an entry schedules actually runs. **No semantic change and no new toggle**; the
  `work-item/transitioned` payload already carried `fromStatusKey` / `toStatusKey`.
- **Amended:** 2026-08-17 (MOTIR-2965) — **a BACKWARD derivation stands down for a status
  the user set LATER than the child-set edit that triggered it.** §5's concurrency bullet
  reasoned only about a stale CHILD read and said nothing about the PARENT row a backward set
  overwrites; the answer to _"whose write wins when a derived recompute and a person's
  transition contend for one row"_ is now written down: **the person's, when theirs is the
  younger of the two.** The failure it settles: a user adds a subtask, moves the story along
  within the job's ~350 ms latency, and the rung-4 recompute — reading the children perfectly
  accurately — puts the story back to `todo`; their next click is refused **422**, because
  `todo → done` is not an edge and the status they were moving from is gone. **No semantic
  change to the ladder, no new toggle and NO `workflow_transition` row** — the arm declines
  a move it was making, and reports `stale_backward`. §3's BACKWARD bullet gains the date
  clause; §5 gains the parent-side half of its concurrency bullet.
- **Amended:** 2026-08-20 (Yue · Bug MOTIR-3229, from MOTIR-1343's close-out) — **the
  ladder gains an `implemented` RUNG, a container's CLAIM is gated at the transition, and
  the downward cascade EXEMPTS a `bug` child.** Three changes, one defect: MOTIR-1343
  reached `implemented`, then In Review, then Done — carrying two merged pull requests —
  while two of its direct children sat at `todo` the whole time, and the merge then
  cascaded both closed, mid-investigation. §3's ladder becomes **five rungs**
  (`implemented` sits between in-progress and in-review; it is an `in_progress`-CATEGORY
  status, so the four-rung ladder collapsed it into rung 3 and could not express
  _"everything below me is BUILT"_ — exactly the state a story run ends in). §3 gains a
  new **§3b** recording the transition GATE, because the measurement below proves a rung
  change alone cannot fix this: the Inngest run for the offending transition returned
  `rollup: { outcome: "already_there" }` / `cascade: { outcome: "not_done" }`, both
  directions doing precisely what they are specified to do and **neither looking down at
  the transitioning item's own children**, so no trigger exists that would ever contradict
  such a claim. §4 gains the **defect-report exemption**. **NO new toggle, NO new
  `workflow_transition` row**, and `done` is deliberately left ungated — completing a
  parent is a decision that completes its children, which is what §4 IS.

- **Amended:** 2026-08-21 (Yue · Bug MOTIR-3334) — **§4's defect-report exemption is
  DELETED and replaced by a DATED CLAIM.** The kind carve-out contradicted §3's _"no work
  item is exempt"_ and left a merged parent stranded at rung 4 with nothing able to
  complete the children the recompute counted (MOTIR-3232 / motir-core#2237). The
  measurement MOTIR-3229 filed stands; its conclusion moves layers. MOTIR-3229's card left
  open _why_ the cascade fired at 13:44:35 and warned against inferring it: the answer,
  read from `job_run` plus the event's ULID, is that the run was the **late execution of
  the merge's own 13:27:15 event — 17 min 18.7 s of queue delay, attempt 0** — so the two
  children it swept did not exist when the parent was declared done. §4's effect clause and
  its exemption block are **replaced**; the cascade now leaves a child whose `createdAt` is
  later than the transition's own `changedAt`, and reports `postDatedIds` /
  `post_dated_only` where it used to report `exemptIds` / `exempt_only`. §3b's
  cross-reference is updated. **NO new toggle, NO new `workflow_transition` row, and no
  per-kind rule anywhere in either direction.**

- **Amended:** 2026-08-27 (Task MOTIR-2974, the FIDELITY half split out of MOTIR-2902) —
  **an IMPORTED parent's status is DERIVED, not CSV-authoritative; the price is that the
  import PREVIEW says so before the run.** A new **§3c** records the decision, its reason
  and the rejected alternative. The importer is an INGRESS like every other (§1), so
  nothing about derivation changes: no per-path exemption, **no new toggle, no new
  `workflow_transition` row, no change to `setImportedStatus` and no change to the
  ladder.** What is added is a **disclosure** — one more per-row warning in the dry-run
  plan (`lib/import/engine/importDerivedStatus.ts`, surfaced by the preview's existing
  warning pill), so the user learns before Confirm that a parent row's status column does
  not govern that row. `tests/e2e/import.spec.ts` asserts the derived outcome **because
  it is decided here**, not merely because it is what shipped.

> Structured **Status → Context → Decision → Consequences**, with the load-bearing facts
> pinned in explicit tables so every downstream subtask implements against one
> authoritative source (the convention `work-item-type-taxonomy.md` set).

> **Filed under `docs/decisions/`, not `docs/adr/`.** The MOTIR-1616 card says
> `docs/adr/`; shipped reality is that every one of this repo's 22 ADRs lives in
> `docs/decisions/` and there is no `docs/adr/` directory. Decision-authority ladder
> rung 2 (shipped reality) outranks the card's path, so this ADR joins its siblings.

---

- **Amended:** 2026-09-11 (Yue · Story MOTIR-4905 · Subtask MOTIR-5140) — **the ladder
  gains a SIXTH rung, `approved`, between `in_review` and `done`.** MOTIR-5139 added
  `approved` to the default workflow in the `in_progress` CATEGORY, and §3's five-rung
  ladder ranked it as plain in-progress because it was not one of the named lifecycle
  keys — so a parent whose children had all been APPROVED derived BACKWARDS to In
  Progress, and the §3b container-completeness gate refused that parent's claim to be
  built. §3's rung table gains a row, §3b's claim set gains `approved`, and
  `LadderKeys` gains a third resolved key. The bar itself is unchanged.
  **No work item is exempt**, and a project whose workflow has no `approved` status is
  unaffected — its third key resolves to null and every rank is what it was.
  **Amendment consumed by:** MOTIR-5142 (the story's vitest gate), MOTIR-5143 (E2E).

- **Amended:** 2026-10-12 (Bug MOTIR-8327, found running MOTIR-8216) — **a BACKWARD
  derivation stands down for a container that delivers its OWN open pull request while
  it stands on a review rung** (`in_review` / `approved`) **and the child set still reads
  built** (a target at or above the `implemented` rung). It reports `delivery_owned`.
  Such a container is In Review because its own CI went green
  (`ciPromotion.promoteDeliveredCardsOnGreen`) and Approved because a person decided its
  merge gate — not because of its children — and the two automata fought: the same green
  pass promotes a CHILD the pull request also delivers, that child's
  `work-item/transitioned` recompute arrives one hop later reading the rest of the
  children at `implemented`, and the system set took the story back there, which
  withdrew its `pull_request_approval` gate `pulled_back` 2–4 s after it was raised —
  three times on MOTIR-8216 / motir-core#3538, and the one time it held was the one time
  no child transitioned after the story. The forward arm already stood down for such a
  container (`approval_pending`, MOTIR-5526); this is its backward half. **Not exempt:**
  a child reopened BELOW `implemented` (unbuilt work under the story, which its own CI
  verdict cannot answer for) still pulls the story back, merge question and all; and a
  container whose pull request has merged or closed is its children's again. **No new
  toggle, no new `workflow_transition` row, no change to the ladder.** §3's BACKWARD
  bullet gains the clause.

## Context

A work item's status and its children's statuses are, today, **completely
independent**. Closing the last child of a story leaves the story `todo`; marking a
story `done` leaves nine `todo` subtasks behind it. Both are wrong in the same way: a
parent's status is a _summary_ of its children, and a parent's completion is a _claim
about_ its children. Motir keeps neither in sync.

This was discovered as a suspected GitHub-webhook bug ("the webhook doesn't roll up
parent status when all children are done"), and debug-first showed it is not a webhook
bug at all — see _Shipped reality_, below. It is a **missing capability**, and the fix
belongs at the one seam every status change already passes through.

### Shipped reality this builds on (verified against `origin/main`, HEAD `3d7a9831`)

| Fact                                                                                                                                                                                                                                                                      | Where                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **`applyStatusTransition` is THE single choke-point for every status change** — board drag, MCP `transition_status`, the CLI, the change-request webhook. It writes **only the item's own status**: no parent read, no child write.                                       | `lib/services/workItemsService.ts:1609`                                  |
| Its sequence: `lockById` (`SELECT … FOR UPDATE`) → tenant gate → `projectAccessService.assertCanEdit` → no-op short-circuit → `getStatusByKey` (target must exist) → `canTransition` (legal-edge gate) → status write + `done ⇒ sessionBranch = null` → `recordRevision`. | same, `:1619`–`:1726`                                                    |
| **A privileged system bypass ALREADY EXISTS** — `opts.system?: boolean` skips **only** the `canTransition` check, keeping the lock, both gates, the target-exists check, the `done` invariant and the revision. Shipped for the issue importer (MOTIR-941).               | same, `:1614`, `:1675`                                                   |
| `setImportedStatus` is today's only `system: true` caller — and it deliberately **emits no event** (a bulk import must not fan out one notification per issue).                                                                                                           | same, `:1552`                                                            |
| `work-item/transitioned` is emitted **post-commit**, and **only on a real transition** (a no-op move carries `transition: null` and emits nothing).                                                                                                                       | same, `:1518`                                                            |
| `canTransition` short-circuits `true` when the project's `workflowPolicyMode` is `open`; under `restricted` it requires an explicit `workflow_transition` row.                                                                                                            | `lib/services/workflowsService.ts:283`                                   |
| The default workflow's 16 edges include `in_review → done` but **no** `in_progress → done`, **no** `todo → done`, **no** `blocked → done`.                                                                                                                                | `lib/workflows/defaultWorkflow.ts:73`                                    |
| Default statuses + categories: `todo`·`blocked` → **todo**; `in_progress`·`in_review` → **in_progress**; `done`·`cancelled` → **done**.                                                                                                                                   | `lib/workflows/defaultWorkflow.ts:27`                                    |
| **Resolve a target status BY CATEGORY, never a hard-coded key** — prefer the canonical key, fall back to the first status of the target category, else `null` (a logged no-op). Currently module-private in the change-request sync.                                      | `lib/services/changeRequestStatusSync.ts:309` (`resolveTargetStatusKey`) |
| **System-context attribution precedent**: `withSystemContext` + `workspaceMembershipRepository.findStandInManagerByWorkspace` — the webhook attributes its move to the change-request author when bound, else the workspace owner.                                        | `lib/services/changeRequestStatusSync.ts:30`, `:187`                     |
| The change-request webhook already transitions a merged PR's item to `done` correctly, through that shared authority. **It does its one job** — which is why the missing rollup is not its bug.                                                                           | `lib/services/changeRequestStatusSync.ts:217`–`:278`                     |
| Direct-children reads uniformly exclude `archivedAt IS NOT NULL` **and** `triagedAt IS NOT NULL`.                                                                                                                                                                         | `lib/repositories/workItemRepository.ts:1651` (`findChildren`)           |
| The kind-parent matrix — `epic → [story, task, bug]`, `story → [task, bug, subtask]`, `task → [bug, subtask]`, `bug → [subtask]`, `subtask → []`. Parenting is **deeper than Jira's**; `bug` is not a leaf.                                                               | `lib/issues/parentRules.ts`                                              |
| Per-project boolean settings columns with an app-side service are an established pattern (`aiAutoPlanEnabled`, `aiSprintPlanningEnabled`, …).                                                                                                                             | `prisma/schema.prisma` · `model Project`                                 |
| Event consumers are `defineJob` handlers registered in one registry; several consumers of the SAME event coexist by carrying distinct job ids.                                                                                                                            | `lib/jobs/definitions/automationEngine.ts`, `lib/jobs/registry.ts`       |

### Mirror check (Jira) — rung 1

Jira has **no first-class parent↔child status derivation in either direction**. Upward
is an automation _template_ ("transition parent when all sub-tasks are done"); downward
is a rule you assemble yourself from a trigger + a branch + a transition action
([Atlassian KB](https://support.atlassian.com/jira/kb/how-to-automatically-transition-the-parent-issue-based-on-the-sub-task-status/)).
Everything Jira lets you "configure" here — the trigger, which statuses count, the
target status, the branch — is configurable **only because Jira ships no opinion**.

---

## Decision

### 1. Two opinionated, first-class behaviours on the shared event — not a rule builder

Motir ships **the opinion**: an upward **recompute** and a downward **cascade**, both
built-in, both **ON by default**, both riding the shared `work-item/*` events so they
cover **every** ingress (board, MCP, CLI, webhook) without a single ingress knowing they
exist. _(Amended 2026-08-17: the upward direction was a forward-only ladder riding
`work-item/transitioned` alone. It is now a recompute over the child SET, so it consumes
every event that CHANGES that set — see §3a.)_ They resolve against **each project's own workflow, by
category**, so a team that renames or adds statuses keeps working derivation. That is
the meaningful sense of "configurable like Jira": **you configure your WORKFLOW, and the
derivation respects it.**

**Rejected — Option A: a generic automation condition-builder** (a parent branch + a
children-aggregate / parent-done condition + a transition action, extending the shipped
6.6 automation engine). With opinionated behaviours that resolve by category, every knob
such a builder would expose is _already answered_; exposing them would mainly enable
**incoherent** setups — "parent → Done when any one child starts", "close the children
when the parent merely starts". Freedom that makes no sense for the workflow is not a
feature. Recorded here so a future genuine use case for generic parent/child rules
starts from this rationale rather than re-deriving it; that would be its own story, and
it would extend the automation engine, not this ADR's services.

### 2. Toggle model — TWO independent project booleans, BOTH default ON

| Column (`Project`)                 | Governs                                  | Default |
| ---------------------------------- | ---------------------------------------- | ------- |
| `autoRollupParentStatus`           | the UPWARD ladder (child → parent)       | `true`  |
| `autoCompleteChildrenOnParentDone` | the DOWNWARD cascade (parent → children) | `true`  |

**The 2026-08-17 amendment adds no third column and no new flag.** The recompute — rungs
1–4, forward and backward alike — ships under the **existing `autoRollupParentStatus`**:
no new `Project` column, no new toggle on the settings surface, and **no per-item or
per-kind exemption flag of any kind**. A user who wants the derivation gets all of it; a
user who does not turns the one switch off. (The rejected alternatives, including a
`permanentContainer` flag on the work item, are recorded in _Consequences_ 7.)

The two directions have **different risk profiles**. Upward rollup only ever reflects
work that genuinely happened, and is universally expected. Downward cascade
**auto-completes children — including UNSTARTED (`todo`) ones** — which a team may
legitimately not want (they may treat a done parent as "the parent's own work is
finished", with children tracked separately).

**Rejected — one combined toggle.** It cannot express _upward-only_, which is exactly
the commonest preference ("I want the rollup, I don't want auto-close"). A single switch
would force such a team to lose the safe half to escape the risky half.

Each toggle is read **inside its own direction's service**, so one direction being off
never suppresses the other.

### 3. The UPWARD direction: a RECOMPUTE over a ~~four~~ **six**-rung ladder (child → parent)

_Amended 2026-08-17 (MOTIR-2888 / MOTIR-2889). The rung set gained a fourth row, the
rung-3 condition dropped its clause about where the parent currently stands, and the
whole evaluation became a **recompute** rather than a climb — see §5's first bullet for
the semantics and the paragraph below for the mechanism._

_Amended 2026-09-11 (MOTIR-5140). The rung set gained a **sixth** row, `approved`, between
`in_review` and `done` — see the table below and the paragraph after it. The struck word in
this section's own heading is kept rather than removed so that a reader arriving from an
older citation lands on the correction._

_Amended again 2026-08-17 (MOTIR-2901). The FORWARD arm applies the recompute by **walking**
the ladder rather than taking one hop with a fallback: the single-hop rule stranded a parent
whose whole child set finished before the first derivation pass ran, because the all-done
aggregate matches exactly one rung and there is nothing below it to fall to. **No
`workflow_transition` row was added** — see the walk bullet at the end of this section, and
§5's termination argument, part 3._

**The parent's status is a FUNCTION of its children's current statuses.** Evaluate the
function, and set the parent to what it returns — forward if that is ahead of where the
parent stands, backward if it is behind. Evaluated against the **direct**,
non-archived, non-triaged children of the parent whose child set changed. Rungs, highest
first — **the first matching rung wins**:

| Rung            | Condition on the children's aggregate                                                                                     | Parent target                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **done**        | **every** child is in a `done`-category status                                                                            | the `done` status (prefer key `done`, else first `done`-category)                      |
| **approved**    | every child is `approved` **or** a `done`-category status, **and** ≥ 1 is at `approved`                                   | the `approved` status (prefer key `approved`, else first `in_progress`-category)       |
| **in-review**   | every child is `in_review`-or-better (`in_review` / `approved` / done), **and** ≥ 1 is in `in_review`                     | the `in_review` status (prefer key `in_review`, else first `in_progress`-category)     |
| **implemented** | every child is `implemented`-or-better (`implemented` / `in_review` / `approved` / done), **and** ≥ 1 is at `implemented` | the `implemented` status (prefer key `implemented`, else first `in_progress`-category) |
| **in-progress** | ≥ 1 child has STARTED — i.e. sits in an `in_progress`-category status (`in_review`, `implemented` and `approved` all do)  | the `in_progress` status (prefer key `in_progress`, else first `in_progress`-category) |
| **todo**        | **no rung above matches** — i.e. ≥ 1 child is in a `todo`-category status and none has started                            | the `todo` status (prefer key `todo`, else first `todo`-category)                      |
| —               | **no children at all**                                                                                                    | **no derivation** — the parent is not touched                                          |

**The `approved` rung is MOTIR-5140's** _(added 2026-09-11)_. `approved` (MOTIR-5139) is an
`in_progress`-CATEGORY status, so before this rung `rankOfStatus` returned the IN PROGRESS
rank for it and **two things broke at once, neither of them loudly**:

1. **The recompute DOWNGRADED a parent.** A story whose children had all reached `approved`
   derived to **In Progress** — where the same children at `in_review` derived to In Review.
   The parent moved backwards as its children moved forwards.
2. **The §3b gate REFUSED A TRUE CLAIM.** An `approved` child ranked below
   `CONTAINER_CLAIM_BAR_RANK`, so `childrenBelowClaimBar` counted it as un-built and
   `applyStatusTransition` refused the parent's move to `implemented` / `in_review` with
   `CONTAINER_HAS_OPEN_CHILDREN` — on a container every one of whose children had been
   approved by a person.

This is the same defect MOTIR-3229 fixed one status earlier, in the same file, with the same
remedy: a named lifecycle key pulled OUT of the category as its own rung. **Each rung's
condition counts every bucket at-or-ABOVE its own**, so inserting a rung widens every
condition beneath it — a rung added without that widening silently stops its lower
neighbours matching. **`CONTAINER_CLAIM_BAR_RANK` is unchanged** and is now correct rather
than merely unchanged: an approved child ranks above it and clears.

**The `implemented` rung is MOTIR-3229's** _(added 2026-08-20)_. `implemented`
(MOTIR-3003) is an `in_progress`-CATEGORY status, so before this rung the ladder had
exactly one thing to say about a parent whose every child was BUILT: _"something has
started"_ — indistinguishable from a parent whose children had merely been picked up.
That is the state a story run ends in, on every card, which is why the gap was not
academic: MOTIR-1343 claimed `implemented` over two `todo` children and nothing in the
system could contradict it. The rung reads the same way the in-review rung above it does
(**every** child at-or-above, **and ≥ 1** exactly there), and it takes the same
prefer-key-then-category resolution — so a project whose workflow has no `implemented`
status resolves the rung onto a key it already has and the ladder de-duplicates, leaving
the shipped four-rung behaviour in place.

⚠️ **The in-progress rung's condition was RESTATED, not changed.** It always meant _"≥ 1
child has started"_, and it read `inProgress > 0 || inReview > 0` because the aggregate
splits review OUT of the in-progress category. With `implemented` split out too, the same
question is now three buckets. A reader who asks only `inProgress > 0` gets _"nothing has
started"_ for a parent whose every child is implemented — which would send it BACK to
`todo`, a worse failure than the one being fixed.

**The empty aggregate matches NOTHING, and rung 4 must not fire on it.** A parent with
zero live children (none, or every one archived / triaged) is left exactly where it
stands. This was already true of rung 1 — "every child is done" must not be vacuously
satisfied, or creating a story would instantly complete it — and rung 4 inherits the
same guard for the mirror reason: a newly created container has no children yet, and
knocking it back to `todo` on that basis would be deriving from an empty set. The rung-4
condition is therefore `total > 0` **and** no higher rung matched, never "the parent
looks unfinished".

**Rung 4 is what makes the recompute bite.** Rungs 1–3 are the shipped conditions and
their targets are unchanged; a ladder that can only report _started_, _in review_ or
_finished_ has no way to say **"there is open, unstarted work down here"**, which is
precisely the state a `done` parent enters the moment a fresh `todo` child is added to
it. Adding the rung without dropping the forward-only filter would change nothing at
all — the two halves of this amendment only work together.

Notes that are decisions, not detail:

- **`in_review` shares the `in_progress` CATEGORY**, so the in-review rung must target
  the specific status **KEY** and only fall back to the category if a project renamed
  it. This is precisely `resolveTargetStatusKey`'s prefer-key-then-category shape, which
  MOTIR-1620 **extracts from `changeRequestStatusSync` into `workflowsService`** so both
  consumers share one implementation rather than growing a second copy.
- **A parent with no children never rolls** (an empty aggregate matches no rung — in
  particular it must _not_ vacuously satisfy "every child is done", and _not_ fall
  through to rung 4 either).
- **`cancelled` counts as done** (it is a `done`-category status). A story whose every
  child is `done` or `cancelled` is finished.
- **THE DIRECTION DECIDES THE AUTHORITY** _(amended 2026-08-17)_. Rank the target on the
  same scale as the parent's current status, and use the comparison to pick **which call
  to make**, never to veto the move:
  - **FORWARD** (the target ranks ahead of where the parent stands) — **still
    legality-gated.** The move goes through the ordinary `applyStatusTransition`
    **without** `system`, i.e. along the project's **real** workflow edges, WALKING the
    ladder one legal edge at a time (the walk bullet below; MOTIR-2901 replaced the
    single-hop-with-fallback this line used to describe). A target with no legal PATH is a
    **logged no-op, never a
    throw**: a team whose workflow has no path to the derived status simply gets no
    derivation, which is the conservative reading of "the derivation respects your
    workflow". This is why MOTIR-1625 adds the `in_progress → done` edge to the default
    workflow — without it, the commonest shape (a parent already `in_progress` whose
    children all finish) could never reach `done`. **"You configure your workflow, the
    derivation respects it" (§1) is a promise about ADVANCEMENT, and it is kept intact.**
  - **BACKWARD** (the target ranks behind) — a **privileged SYSTEM set**:
    `applyStatusTransition(..., { system: true })`, the same shipped bypass (MOTIR-941)
    the downward cascade already uses, with **no** `canTransition` probe and **no** rung
    fallback. The reason is §4's own, applied to the other direction: **`done → todo` and
    `in_review → todo` are not edges in the default workflow, and must NOT be added as
    `workflow_transition` rows** — those rows are user-draggable board edges, and adding
    them would let anyone walk the workflow backwards by hand. `system: true` skips
    **only** `canTransition` and keeps everything else: the row lock, the tenant gate,
    the project-access gate, the target-status-exists check, the
    `done ⇒ sessionBranch = null` invariant, and the revision.
  - **Why a backward derivation may bypass a gate a user's own move may not.** A derived
    backward move is not a user's workflow step; it is a **claim about the children** —
    "there is unstarted work under this item" — and the workflow graph does not get a
    vote on whether that claim is true. A workflow says which moves a _person_ may make
    on the board.
  - **AND A CLAIM HAS A DATE — the backward arm stands down for a NEWER user write**
    _(added 2026-08-17, MOTIR-2965)_. Needing no legal edge is exactly what makes this the
    one arm that can overwrite a status a person just set, and the cost of doing so lands on
    their NEXT click rather than this one. So before the system set, compare the parent's
    **own last status change** with the **newest edit to the child set** this pass is
    reasoning about: **when the parent's status is the younger of the two, decline** and
    report `stale_backward`. What is wrong in that case is not the reading of the children —
    it is accurate — but the claim's date against the row: a status written after the newest
    child-set edit was written by somebody who **already knew** about those children, so the
    derivation has nothing to tell them. See §5's concurrency bullet for the mechanism and
    the two instants it compares. The FORWARD arm needs no counterpart: it is legality-gated,
    so it can only ever take moves the person could have taken by hand, and the `same_rung`
    tie already protects a deliberate `blocked` marker.
  - **AND A STORY RUN'S REVIEW RUNGS ARE ITS PULL REQUEST'S** _(added 2026-10-12,
    MOTIR-8327)_. A parent that delivers its own OPEN pull request and stands on
    `in_review` or `approved` got there through its own CI verdict and merge gate, not
    through its children. While the recompute's target is still at or above the
    `implemented` rung — the children are built, they just have not all been promoted —
    the arm declines and reports `delivery_owned`, the backward twin of the forward arm's
    `approval_pending`. A target BELOW `implemented` still applies: unbuilt work under the
    story is a claim about the children that the story's CI cannot answer for. And once
    the delivery is no longer open, the rung is the children's to answer again.
  - **This is a SECOND asymmetry, on a different axis from §4's.** §4's asymmetry is by
    direction of travel **in the tree** (up is legality-gated, down is a system set).
    This one is by direction of travel **along the ladder**, within the upward direction
    (forward is legality-gated, backward is a system set). Both exist for the same
    underlying reason — a move no user path allows is exactly the move a derivation must
    still be able to make.
- **One RECOMPUTE per pass, applied by WALKING the ladder — FORWARD only**
  _(amended 2026-08-17, MOTIR-2901; this bullet previously read "one move per pass, with a
  fallback to the next legal rung")_. The recompute picks the **highest matching rung** as
  what the parent IS, and then reaches it by taking the highest **stepping stone** at or
  below that rung which the project's workflow can legally reach, repeating from there
  until the target is reached or nothing above the cursor is legal. If nothing above it is
  legal at all, the outcome names the rung it wanted and nothing moves.

  **A stepping stone is a LADDER RUNG, not any status.** The walk resolves all four rungs
  against the project's workflow and may stand only on those, whether or not the current
  child set matches them. That is the containment property that makes it safe: every status
  the walk passes through is one the derivation **could have set outright** for some other
  child set, so a walk can never invent a resting place — only reach one sooner. A
  project's own extra statuses are never used as a bridge, even when they are the only way
  through.

  _(Why a walk and not a single hop. MOTIR-1623 found that taking only the top rung STRANDS
  a parent whose graph cannot make that jump — a `todo` parent whose only child goes
  straight to review matches the in-review rung, `todo → in_review` is not an edge, and no
  later event changes that aggregate. The answer then was to fall to the next MATCHING rung,
  and **that answer has a hole, which MOTIR-2901 fell into**: when every child finishes
  before the first derivation pass runs — a user dragging a card twice, or the agent loop's
  dispatch → PR-open → merge sequence — every pass reads the same final all-done aggregate,
  `done` is the ONLY matching rung, and **there is nothing below it to fall to**. `todo →
done` is not an edge and must not become one (see below), so the parent sat in `todo`
  permanently. Exactly MOTIR-1623's stranding, in the one shape its fallback could not
  reach. The walk subsumes the fallback: it lands on the wanted rung whenever any ladder
  path exists, and as far up it as the graph allows otherwise. MOTIR-12202 later declared
  `todo → in_review` in the default workflow, for a pull request delivering a card that
  still reads To Do, so MOTIR-1623's example now needs a graph without that edge; the walk
  is unchanged, and on the default graph it takes the direct hop.)_

  **"You configure your workflow, the derivation respects it" is untouched, and the third
  rejected alternative is why the walk is the fix.** Every hop is a real `workflow_transition`
  row of the team's own graph — no `system` bypass on the forward arm, and **no new
  transition row anywhere**. A graph with no path to the target still gets a logged no-op.
  What the walk changes is only that the derivation now takes the moves a _person_ would
  have had to take by hand, instead of giving up because it could not take them all at once.
  The rejected alternatives, both weighed on MOTIR-2901's card: making an illegal FORWARD
  derivation a **system set** — simplest, and it would have force-completed parents in teams
  that deliberately have no path to `done`, breaking the §1 promise for advancement; and
  carrying the **event's `toStatusKey`** as a floor — which reads one child's move where the
  recompute is a function of the whole child SET, and gives up the idempotence §3a's
  aggregate-only read buys.

  **The walk applies its hops in ONE transaction, writes one revision per hop, and emits ONE
  event.** A revision is a RECORD, so the feed shows each status the item genuinely held; an
  event is a NOTIFICATION, so watchers, the automation engine, the grandparent's recompute
  and the downward cascade each see the single NET move. Telling a watcher twice about one
  derivation, or recomputing the grandparent once per hop, would be a defect of the fix
  rather than a property of it. The `rolled_up` outcome carries the intermediate rungs as
  `via` when there were any, so a run log can answer "did a derivation pass through a status
  nobody set?".

  **The walk has no backward counterpart, and needs none:** a backward move is a system set
  that no edge can refuse, so it reaches any status in one hop. A target the parent is
  ALREADY in is a no-op that emits nothing — the fixed point that §5's termination argument
  rests on.

### 3a. The TRIGGER SURFACE — every edit to the CHILD SET recomputes _(added 2026-08-17)_

A ladder climb could ride the one event that moves a child along it. **A recompute
cannot: it is a function of the child SET, so every edit to that set must run it.**
Derivation today consumes `work-item/transitioned` alone
(`lib/jobs/definitions/statusDerivation.ts`), which is exactly why _adding_ a child to a
`done` parent currently fires nothing at all — the case this amendment exists for.

| Child-set edit                                           | Shipped today                                                                                                                                                                       | In scope for the recompute                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a child **transitions**                                  | ✅ `work-item/transitioned` → `statusDerivationOnTransitioned`                                                                                                                      | unchanged                                                                                                                                                                                 |
| a child is **created** under the parent                  | `work-item/created` is emitted post-commit by `workItemsService` (Story 6.6.2) but has **no derivation consumer**                                                                   | add a consumer. The payload carries `workItemId` and the service re-reads the item and its parent, so **no payload change is needed**                                                     |
| a child is **re-parented**                               | ✗ **`workItemsService.moveWorkItem` emits NO EVENT AT ALL** — verified on `origin/main`: the function contains no `sendEvent` call, so a `move_to_parent` is invisible to every job | emit post-commit on a real parent change, carrying the **PREVIOUS and the NEW** parent id, and recompute **BOTH** — the old parent may now be finished, the new one may need to come back |
| a child is **archived / unarchived / triaged / deleted** | ✗ nothing                                                                                                                                                                           | recompute the affected parent — these rows ENTER and LEAVE the aggregate, because every child read excludes `archivedAt IS NOT NULL` and `triagedAt IS NOT NULL`                          |

Three constraints that are decisions, not detail:

- **One recompute implementation, reached from more triggers.** Every trigger routes to
  the same `parentStatusRollupService` entry point; a trigger that knows a PARENT rather
  than a child (the re-parent's old parent, a delete) passes the parent directly. The
  ladder is never forked.
- **A recompute must NOT trigger the downward cascade.** The cascade fires only on an
  item ENTERING a `done`-category status, and that is load-bearing here: it is what stops
  a parent which has just come BACK to `todo` from force-closing the child that brought
  it there.
- **The toggle governs all of them.** `autoRollupParentStatus` gates every trigger in
  this table exactly as it gates the transition one, and a create with no parent or a
  move that does not actually change the parent is a cheap no-op — these events fire on
  every item creation in the workspace.

### 3b. The container-completeness GATE — a CLAIM is refused at the transition _(added 2026-08-20)_

_Amended 2026-09-11 (MOTIR-5140). The claim set gains a third member, **`approved`**, and
the BAR is unchanged — see the rule below._

§3 and §3a are about what a parent's status is DERIVED to be. This is about what a
parent is allowed to CLAIM, and it is a different mechanism because derivation
structurally cannot enforce it.

**The rule.** An item with live children may not enter **`implemented`**, **`in_review`**
or **`approved`** while any of those children is below `implemented` on §3's ladder.
(`approved` joined the set in MOTIR-5140: a container at `approved` claims its work is
built exactly as one at `in_review` does — a person has said yes to it — so the same
containment applies. The BAR stays at `implemented`: an approved CHILD is above it and
clears, which is the half that was broken before the sixth rung existed.) The
refusal is `CONTAINER_HAS_OPEN_CHILDREN` (422), raised by
`workItemsService.applyStatusTransition` — the single choke-point every status change
passes through — and it NAMES the children that are not landed.

**Why a gate and not a rung.** MOTIR-1343 was set `in_progress → implemented` at
11:24:59 with two `todo` children. The derivation run for that event (started 11:25:14,
`Completed`) returned:

```json
"rollup":  { "outcome": "already_there", "parentId": "<the epic>", "toStatus": "in_progress" }
"cascade": { "outcome": "not_done" }
```

Both directions did precisely what §3 and §4 specify, and **neither looks down at the
transitioning item's own children**: the upward direction recomputes the item's PARENT,
and the downward cascade fires only on entry into a done-category status, which
`implemented` is not. A container can therefore be set to `implemented` over `todo`
children and **no trigger exists that would ever contradict it**. Derivation was not
failing; it was never asked the question. Adding the rung above changes what a parent is
DERIVED to — it cannot refuse what a person, a webhook or a run SETS.

**Why those two statuses and not `done`.** `implemented` says the branch is pushed and
the pull request is open; `in_review` says a human should look at it. Both are claims
about everything under the item, and **the pull request is opened on that claim** — so
if it can be made with open children, the review gate rests on nothing. `done` is
deliberately left ungated: completing a parent is a DECISION that completes its
children, and §4 is the shipped expression of it. Gating `done` would break the feature
rather than the defect; §4's own DATED CLAIM is where that case is answered instead
(MOTIR-3334 — a done-entry completes the children that existed when it happened).

**ONE bar for both claim rungs — `implemented`-or-better — rather than the target's own
rank.** Reading In Review's rank as the bar would also refuse a parent whose children
are all built but whose individual builds have not been promoted, which is the ordinary
shape of a parent run: ONE pull request carries every child and the green verdict is a
single promotion over the set (MOTIR-3006). Refusing there would gate a TRUE claim on an
artifact of how CI reports.

**Two exemptions, both stated rather than incidental:**

- **`opts.system`.** The importer, the downward cascade and the recompute's backward arm
  are background writes behind a change somebody already made successfully, and a
  business rule must not fail them. The FORWARD recompute arm is not `system` and needs
  no exemption — it only ever targets a rung its children actually match.
- **A project that has RENAMED these statuses away.** The gate matches the two status
  KEYS literally rather than through the prefer-key-then-category resolver, because both
  live in the `in_progress` category and that resolver falls back to the FIRST such
  status — `in_progress` itself — which claims nothing at all. A project that renamed
  them has redefined what the claim means, and letting the move through is the honest
  answer there. (The same literal-key choice `ciPromotion.ts` already makes.)

**What each refusing caller does with it** — none of them 500s, and none of them retries
forever: the board SNAPS BACK with the refusal as its reason (`IllegalBoardMoveError`);
the change-request status sync reports `open_children` and leaves the item where it is;
the CI-green promotion treats it as SKIPPABLE, per-card, exactly like a workflow with no
legal edge; the MCP maps it to a self-correctable tool error naming the open children;
the v1 transitions route answers 422 with its own code.

### 3c. An IMPORTED parent's status is DERIVED — and the PREVIEW says so _(added 2026-08-27)_

§3a settles that **every edit to the child set** recomputes. A bulk import is the
largest such edit the product can make, and it arrives carrying its own answer: a CSV has
a `status` column, and the Map step tells the user it is mapping that column onto a Motir
workflow status. **For a row that becomes a PARENT, the mapped value does not govern the
row.** The shipped sequence is create → `setImportedStatus` (pin the mapped value) →
`work-item/derivation.requested` → recompute (MOTIR-2892, MOTIR-2902), so the parent
lands wherever its imported children put it. Fixture, from `tests/e2e/import.spec.ts`:
the CSV says `Checkout epic` is **To Do** and its child `Payment subtask` is **In
Progress**; after the import the parent reads **In Progress**.

**Decision: DERIVED. The status column is authoritative for the ROW; it is not
authoritative for the row's RELATIONSHIP TO ITS CHILDREN.** For a leaf the mapped value
is the final value. For a parent it is a starting value the recompute then reads the
child set over — exactly as it does for a parent a person set by hand.

**The reason, in one line:** the importer is an INGRESS, and §1 is explicit that
derivation rides the shared `work-item/*` events "so they cover **every** ingress (board,
MCP, CLI, webhook) without a single ingress knowing they exist." A CSV row is not a
privileged writer.

Three things follow that are worth stating, because each one is a place a reader
reasonably expects the opposite:

- **The supplied value is not discarded — it is applied, and recorded.**
  `setImportedStatus` writes it through `applyStatusTransition` and `recordRevision`
  keeps it, so the file's value is in the item's history. What happens next is the
  product's own rule moving a parent, not the importer dropping a column.
- **The alternative is not stable even on its own terms.** "The CSV's parent value wins"
  holds only until the next child-set edit — adding one subtask the next morning
  recomputes the parent anyway. It is a fidelity guarantee the product cannot keep past
  the first edit, so buying it at the cost below buys an hour of consistency.
- **It is the one moment an inconsistent tree would be created at scale.** An import is
  precisely where "unstarted work above started work" would be minted a thousand rows at
  a time — the state MOTIR-2888 exists to remove.

**Rejected — CSV-authoritative for parents** (suppress the recompute for import-created
items, or re-pin the mapped value after it). It needs a per-PATH exemption, and §3 says
**no work item is exempt**; the one exemption ever shipped in this ADR was per-KIND, and
the 2026-08-21 amendment deleted it for exactly this reason. Beyond the posture, the
carve-out would have to name its own end — a parent stays "import-authoritative" until
what? — and every answer is a second, weaker derivation rule living beside the first.
_(Recorded so a future reader with the same fidelity instinct starts from this rationale
rather than re-deriving it. If the CSV's parent value must ever win, that is a statement
about what the IMPORTER means by its status column and belongs in the importer's mapping
contract — not a hole here.)_

**The price, and it is owed: the PREVIEW discloses it BEFORE the run.** The complaint
this decision answers is not that derivation is wrong; it is that a screen which says it
is _mapping your columns_ then quietly does something else to some of them. So the
dry-run plan marks every row that will be a parent once the import has run — either
because another row in the same import names it as its parent, or because the item it
matched already has children. The mark is `markDerivedParentStatuses`
(`lib/import/engine/importDerivedStatus.ts`), applied in `importService.preview`, and it
reaches the user as one more warning pill in the per-row warnings the preview already
renders (`design/import/design-notes.md` § Preview — the `status → default` pill's
pattern; **no UI change**).

Three properties of the mark, each a decision:

- **It names the MECHANISM, not a predicted value.** Predicting the derived status means
  running §3's rung matching and stepping-stone walk over a child set that does not exist
  yet, against the project's own workflow. A preview that names a status the run then
  does not produce is worse than one that names none.
- **It is about the row's SHAPE, so it is always true.** A parent whose mapped status
  already equals the derived one is still a row whose status is governed by its children.
  Marking it is not a false positive; the disclosure is _the file does not govern this
  row_, not _this row will change_.
- **It is gated on `autoRollupParentStatus`.** With the toggle off nothing is derived, so
  nothing is disclosed — the same gate §3a puts on every other trigger.

**Preview-only, deliberately.** The engine's `classifyIssue` is shared by the preview and
the run so the two can never diverge on CREATE/UPDATE/SKIP; this annotation is a
whole-set post-pass at the service tier (the resolve path is streamed one issue at a
time and cannot see whether another row names this one as its parent), and it is a
disclosure rather than a plan verdict. The run's per-item progress carries the resolver's
warnings unchanged.

### 4. The DOWNWARD cascade (parent → children)

**Trigger:** an item transitions **into a `done`-category status** — by a user, by the
upward rollup, or by the change-request webhook when its PR merges. **Read off the
TRANSITION** (`toStatusKey` in a done category, `fromStatusKey` not), never off the item's
current status — see the 2026-08-17 / MOTIR-2957 amendment above for the failure the row
read produced once rung 4 could move that row underneath it. **Effect:** every
**not-done DIRECT child** (non-archived, non-triaged, **and not created after that
transition** — see the dated claim below) is set to the project's `done` status.
Grandchildren are reached by re-emission, never by a subtree walk.

**⚠️ THE CLAIM IS DATED: a child created AFTER the done-entry is NOT completed**
_(replaced 2026-08-21, MOTIR-3334; was **ONE EXEMPTION, BY CHILD KIND: a `bug` is NOT
completed**, added 2026-08-20, MOTIR-3229)_. The kind carve-out is **deleted**. The
paragraphs it stood on are kept below, because its evidence was measured and is still
true — what changed is the layer the conclusion belongs at.

**What MOTIR-3229 measured, which stands.** From the Inngest REST API for MOTIR-1343's
`in_review → done`:

```json
"cascade": { "outcome": "cascaded", "itemId": "<MOTIR-1343>",
             "childIds": ["<MOTIR-3218>", "<MOTIR-3219>"], "toStatus": "done" }
```

Both were bug reports that story's own run had filed while shipping it, and both were
closed by the merge of that story's own pull request — while a session was three minutes
into investigating them. **A story closing itself silently closed the defects found while
shipping it.** That loss was real and is the reason this clause exists at all.

**Why `kind` was the wrong reading of it.** The same job log says so: **both children were
`in_progress` when they were swept.** `filterNotDone` keeps every child not in a
done-category status, so an `in_progress` SUBTASK in the same position would have been
swept identically, with no exemption to save it — the carve-out protected one kind-shaped
slice of a kind-agnostic hole. It also put §4 in direct contradiction with §3, which
exempts nothing: a parent whose only open children were exempt bugs was completed by its
merge and then pulled BACK to `implemented` by the recompute, with nothing able to
complete the children the recompute was counting. Measured on MOTIR-3232 /
motir-core#2237 (2026-08-21): eleven subtasks completed at 10:02:34–36, two bugs skipped,
the story `done → implemented` at 10:03:30 — **stable, and self-repairing never.** It sat
there until both bugs were closed by hand.

**What actually made MOTIR-1343's children vulnerable** _(measured 2026-08-21 from
`job_run` plus the event's ULID; MOTIR-3229's card left this open and warned against
inferring it)_:

|                                              |                                           |
| -------------------------------------------- | ----------------------------------------- |
| event `01M0FNNFQVY6Y3Q8QEG159905T` emitted   | `2026-08-20T13:27:15.963Z` — the merge    |
| MOTIR-3218 / MOTIR-3219 created + claimed    | `13:41:45` / `13:41:56`                   |
| `status-derivation/transitioned` run STARTED | `13:44:34.642Z`, **attempt 0**, succeeded |

There is no unexplained parent transition at 13:44. The cascade that ran then was the
**late execution — 17 min 18.7 s of queue delay, first attempt, not a retry — of the
merge's own event.** The two children did not exist when the story was declared done.
They were completed by a claim made before they were filed.

**The rule.** §4's promise is a claim over the child set **as it stood when the parent
entered done**. So a child whose `createdAt` is later than the transition's own instant is
left alone. The instant is the `changedAt` of the **revision row the event names** — the
same preference §5 states for the rollup, read from a row rather than carried on an event,
so a redelivered stale event still dates itself correctly. **An unresolvable instant is not
evidence:** no `revisionId`, or one that resolves to no row, leaves every open child in
scope exactly as this shipped. The guard can only ever SUPPRESS.

**This is an ORDERING rule, and the third in the same family** — MOTIR-2957 fixed which
STATUS the cascade reads, MOTIR-2965 fixed which WRITE the rollup's backward arm may
overwrite, and this fixes which CHILDREN a done-entry speaks for. It asks nothing about
what a child IS, which is what separates it from the carve-out it replaces and from the
`createdAt`-against-status-history proxy MOTIR-3229 rejected: that proxy tried to date a
RUN, which the cascade has no notion of; this dates the cascade's OWN trigger, which it
already carries.

**And it does not replace the upstream containment — it is the residue that containment
cannot reach.** §3b's gate already refuses a container's move to `implemented` or
`in_review` while a live child is below the bar, and `packages/cli`'s close-out re-reads
the child set before opening a scoped run's pull request (MOTIR-3268). Both are
kind-agnostic and both sit upstream. Neither can cover a child FILED AFTER the parent
finished — and refusing that filing is not available, because §5 settles that _"a `done`
parent given a fresh `todo` child returns to `todo`. A `done` parent is not permanently
done."_ Rung 4 brings the parent back; this clause stops the already-emitted done-entry
from closing the child that brought it back.

_The cost, stated rather than hidden:_ a child filed under a finished parent and genuinely
finished by a LATER pull request is completed by that pull request's own cascade, not by
the parent's — which is correct, and means a parent can sit at rung 4 until it is. The
recoverable direction is the same one MOTIR-3229 chose: an open card is visible and one
click from closed, whereas a swept defect report leaves no trace at all.

_Reported, not silent:_ the pass returns `postDatedIds` alongside `cascaded`, and
`post_dated_only` when every open child post-dates the entry — distinct from
`no_open_children`, because a log that cannot tell _nothing to do_ from _declined to do
it_ cannot answer why a done parent still has open children. (These replace `exemptIds` /
`exempt_only`, which named the deleted carve-out's `bug` children.)

**Mechanism — the privileged SYSTEM set, reusing the shipped `opts.system` bypass.**
Forcing an unstarted `todo` / `blocked` child straight to `done` is **not a legal user
transition**: the default workflow has no such edge, and under `restricted`
`applyStatusTransition` throws `IllegalTransitionError`. We must **not** fix that by
adding `todo → done` / `blocked → done` transition rows — those are user-draggable
edges, and they would let anyone skip the whole workflow on the board. So the cascade
calls `applyStatusTransition(..., { system: true })`, which skips **only** the
`canTransition` check and keeps everything else: the row lock, the tenant gate, the
project-access gate, the target-status-exists check, the `done ⇒ sessionBranch = null`
invariant, and the revision row.

The card proposed _extending_ `applyStatusTransition` with `opts.system`; **it already
exists** (MOTIR-941, the issue importer). MOTIR-1647 therefore _reuses_ it and adds no
new bypass. It does **not** route through `setImportedStatus`, which is the existing
`system` caller but deliberately **emits no event** — the cascade _needs_ the event to
recurse to grandchildren. The cascade's own entry point emits `work-item/transitioned`
post-commit exactly as `updateStatus` does.

**This asymmetry with the upward direction is deliberate.** Upward _advances a parent
along the team's real workflow_ (conservative — it respects their stages). Downward
_performs a system completion no legal user path allows_, which is the honest shape of
"the parent is done, so its children are done".

_(Amended 2026-08-17: the upward direction is no longer wholly legality-gated. It is
gated **when it advances** and a system set **when it comes back**, for the identical
reason given here — the backward edges it needs are absent from the default workflow and
must not be added as user-draggable rows. See §3's "the direction decides the authority".
The tree-direction asymmetry this paragraph describes is unchanged; there are now two
asymmetries on two axes.)_

### 5. Cross-cutting semantics (both directions)

- **The upward direction is a RECOMPUTE, not a ratchet** _(replaced 2026-08-17;
  MOTIR-2888 / MOTIR-2889, settling MOTIR-2885 — this bullet previously read
  "Forward-only" and asserted the opposite of every clause below)_. The parent's status
  is a **function of its children's current statuses**, and the result is applied whether
  it is ahead of or behind where the parent stands. **Reopening a child brings its parent
  back with it. A `done` parent given a fresh `todo` child returns to `todo`. A `done`
  parent is not permanently done.** What survives from the old bullet: an
  already-`done` child is still never re-touched by the DOWNWARD cascade (§4), which is a
  separate mechanism with its own trigger.

  **Why the change.** A ratchet is right only while a plan can shrink and never grow,
  which is not how plans behave. A parent is a summary of the work underneath it, and a
  summary that can only ever improve stops being a summary the first time work is added.
  The concrete failure this settles: the planner-bug home MOTIR-1465 was carried to
  `done` twice by rollup and then given new children, and MOTIR-1464 sat `done` while its
  own child MOTIR-1465 sat `todo` — the tracker contradicting itself, in two places, from
  one rule.

  **No item is exempt.** The rule changes for every parent, of every kind, in every
  project. There is no per-item, per-kind or per-container carve-out — see
  _Consequences_ 7 for the three exemption-shaped alternatives that were rejected.

- **Hierarchy and kinds.** Both directions apply across **every** parent edge in
  `parentRules.ts` — `subtask ↔ story/task/bug`, `story ↔ epic`, `task`/`bug` ↔ their
  parents — and count **all** child kinds. There is no kind-specific carve-out: the
  matrix is the authority, and a bug with subtasks rolls up exactly like a task with
  subtasks.
- **Excluded children.** `archivedAt IS NOT NULL` and `triagedAt IS NOT NULL` children
  are excluded from the aggregate **and** from the cascade — the uniform read-exclusion
  every other child read applies. An archived child must not hold its parent back from
  rolling up, and must not be resurrected into `done` by a cascade.
- **Attribution.** The job has no session, so it runs under `withSystemContext` and
  attributes the move to the **workspace owner** — the same fallback the change-request
  sync uses. It reads in the activity feed as an ordinary status change by that user
  (it _is_ one: the same `updated` revision with a `status: {from, to}` diff), so no new
  revision kind or feed renderer is needed.
- **Recursion and termination** _(proof replaced 2026-08-17 — the old one appealed to
  forward-only, which no longer holds; part 3 added the same day for MOTIR-2901's forward
  walk; the shape of the mechanism is unchanged)_. Each pass transitions only the
  **direct** neighbour(s). The next level derives when its own transition **re-emits**
  `work-item/transitioned` — emitted only on a _real_ transition. **No explicit
  ancestor/descendant walk and no loop-guard flag**, and depth is bounded by the tree
  anyway (epic → story → task/bug → subtask). The argument, in three parts:
  1. **A level cannot oscillate while its children hold still.** Each pass sets a level
     to a target that is a **pure function of that level's children**. Run it twice on an
     unchanged child set and it computes the same target both times — and the second pass
     finds the level already there, which is a no-op that **emits nothing**. So an
     unchanging child set produces at most one transition per level, and the chain up the
     tree is finite because the tree is.
  2. **The two directions still cannot loop, without leaning on forward-only.** A parent
     _entering_ a `done`-category status cascades down; each completed child re-emits;
     each re-emission recomputes the parent, whose children are now all done, so rung 1
     returns `done` again — the parent is already there, a **fixed point**, and it emits
     nothing. A parent _leaving_ `done` triggers **no cascade at all**, because the
     cascade fires only on **entry into** a done-category status (§4), never on exit. So
     the one new motion this amendment introduces — a parent coming back — starts no
     downward wave that could push it forward again.
  3. **The forward WALK terminates, and does not touch parts 1 and 2** _(MOTIR-2901)_. The
     walk is INSIDE one pass, not a re-entry: it does not re-emit without a child-set change
     and it adds no new trigger. It terminates on its own because each hop moves the parent
     to a **strictly higher rank** on the four-point ladder scale, bounded above by the
     target the pass computed **before it started** — so at most three hops, no stone
     revisited, and the loop is additionally capped at the number of distinct rungs. It also
     STRENGTHENS part 1 rather than weakening it: the pass now lands ON the target it
     computed whenever any path exists, so the very next pass over an unchanged child set is
     the `already_there` fixed point, where before it could take several passes of
     single-hop fallbacks to get there.

  What the old proof got from forward-only, the fixed point now gets from
  _already-there emits nothing_, which is a property of `applyStatusTransition` itself
  and does not depend on which way the derivation is travelling.

- **Concurrency — lock the parent BEFORE reading the aggregate.** Two children
  finishing concurrently produce two rollup jobs against the same parent; if each reads
  the children aggregate before taking the parent's row lock, both can observe "not all
  done" and the parent never rolls. So the rollup opens its transaction, takes the
  parent's `lockById` **first**, and only then reads the aggregate — the racing job then
  blocks, and re-reads an aggregate that includes the winner's commit. (The standing
  read-derived-update rule; `applyStatusTransition`'s own lock is not sufficient because
  the derivation _input_ is read outside it.) The cascade needs no equivalent ordering:
  a stale "this child is not done" read is benign, because the action is an
  unconditional force-to-done that `applyStatusTransition` no-ops if the child got there
  first.

  **The cascade's stale read that is NOT benign is of the PARENT** _(added 2026-08-17,
  MOTIR-2957)_. The sentence above reasons about the CHILD aggregate and is right about
  it; what it does not cover is the cascade's own **trigger** condition. Deciding "did this
  item enter done?" by re-reading the item makes the cascade cancellable by any concurrent
  derivation that moved it since — and rung 4 introduced one that does so routinely, for a
  child created just before the parent was set Done. So the trigger is taken from the
  transition the event carries (§4), which no later write can rewrite, and the cascade
  needs no lock: the entry it acts on is a historical fact, not a current reading.
  (The paragraph that follows closes the same hole from the other end — there the parent row
  a backward set OVERWRITES, here the parent status the cascade READS.)

  **Whose write wins: the ROLLUP's stale read that is not of the children at all**
  _(added 2026-08-17, MOTIR-2965)_. The bullet above locks the parent so the CHILD aggregate
  is read consistently, and it is right about that. What it does not cover is the **parent
  row the backward arm overwrites** — a row the lock protects for the duration of the pass
  and not for a moment before it. A backward set needs no legal edge, so it is the only
  derivation that can land on a status a person set seconds earlier; and because the
  workflow deliberately has no `todo → done`, the person does not learn this on the click
  that was overwritten but on the **next** one, as a bare 422 about a status they never saw.

  **The rule: a backward set is DECLINED when the parent's status is newer than the
  child-set edit that triggered the pass.** Two instants, both compared inside the locked
  transaction:

  | instant              | where it comes from                                                                                                          |
  | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
  | the parent's status  | the `changedAt` of its most recent revision carrying a `status` diff (`workItemRevisionRepository.findLatestStatusChangeAt`) |
  | the child-set edit   | `aggregateChildrenStatus.lastChangedAt` — `MAX(GREATEST(createdAt, updatedAt))` over the LIVE children                       |
  | …for a row that LEFT | the trigger's own `occurredAt`, carried on `work-item/child-set.changed`; the later of the two is used                       |

  Three properties this deliberately has. **It reads the SET, not the event, wherever it
  can** — the same idempotence-under-redelivery §3a's aggregate-only read buys, and the
  reason §3's "carry the event's `toStatusKey`" alternative was rejected; only an archive /
  re-parent / delete, which removes the very row that changed, has to carry an instant.
  **It can only ever SUPPRESS** — no backward set becomes possible that was not possible
  before, so a wrong answer leaves the shipped behaviour rather than inventing a move.
  **And missing evidence is not evidence:** a parent with no status revision at all (an
  import, a fixture, a direct row write) has no date to beat, and the arm proceeds exactly
  as it shipped.

  **What this does NOT change.** The ladder's semantics are untouched: a `done` parent given
  a fresh `todo` child still comes back, because the create is then the younger instant. The
  rule bites only when a person has moved the parent SINCE — and a later child-set edit
  re-dates the claim, so the parent is never permanently stranded.

- **Derived transitions are REAL transitions.** They fire the automation engine and the
  watcher/bell notifications exactly like a board move, because that is what they are —
  a status genuinely changed and watchers asked to be told. Accepted consequence: a
  cascade over a wide parent notifies each child's watchers. They are not tagged with
  `viaAutomationRuleId`, which is automation-rule provenance and would wrongly suppress
  a user's own rules.

### 6. Rollout — existing projects backfill to ON

Both columns backfill **`true`** for existing projects. Motir is pre-GA with few live
tenants, and a uniform opinion is worth more than grandfathering. The one-time effect is
recorded here so it is not a surprise: on their **next** transition, an existing parent
whose children already satisfy a rung will advance, and an existing `done` parent with
open children will complete them. Nothing is derived retroactively at migration time —
there is no backfill job, only the column default; derivation begins at the next event.

---

## Consequences

1. **No ingress changes.** Board, MCP, CLI and webhook all keep calling
   `applyStatusTransition`; derivation is a consumer of the event they already emit.
   A new ingress gets derivation for free.
2. **`applyStatusTransition` gains one new `system: true` caller** — the cascade — and
   the bypass's blast radius grows accordingly. It remains reachable only from server
   job context, never from a user route.
3. **The default workflow gains one edge** (`in_progress → done`, MOTIR-1625), with the
   matching backfill for existing default-workflow projects. This is a user-visible
   change: the board now allows dragging `In Progress → Done` directly.
4. **`resolveTargetStatusKey` moves to `workflowsService`** and gains a second consumer;
   the change-request sync keeps identical behaviour through the shared function.
5. **A project on a custom workflow with no path to a derived status silently gets no
   derivation** for that rung. That is deliberate (rung 3's legality gate) and is why
   the outcome is _logged_, so it is diagnosable rather than invisible. _(MOTIR-2901: "no
   path" now means what it says — a chain of ladder edges, not a single one. A team that
   removed `in_progress → done` but kept `in_progress → in_review → done` DOES get the
   derivation, over the edges they kept. That is the intended reading of "respects your
   workflow": the derivation may take any sequence of moves a person on that board could,
   and no others.)_
6. **A generic parent/child automation rule remains unbuilt.** If one is ever wanted,
   it extends the 6.6 engine and must reckon with these built-ins (most likely: the
   built-in toggles off, the rule on).

_Consequences 7–9 added 2026-08-17 with the recompute amendment._

7. **A parent can now move BACKWARD with nobody touching it — including out of `done`.**
   This is the amendment's whole point and its main user-visible surprise, so it is
   stated here rather than left to be discovered: add an unstarted child to a finished
   story and the story returns to To Do; reopen a child and its parent reopens with it.
   **The settings copy changes with the behaviour.** The shipped
   `settings.statusAutomation.rollup.hint` promises the opposite in writing — _"It only
   ever moves a parent forward … reopening a child never moves a parent back"_ — and the
   surface's ladder read-out shows three rungs; both are now false, and MOTIR-2890 /
   MOTIR-2893 redraw and rewrite them (four rungs, a both-ways promise, `en` + `zh`).
   A behaviour change that leaves its own settings page asserting the old rule is not
   finished.

8. **`applyStatusTransition` gains a second `system: true` caller** — the backward arm of
   the upward recompute, alongside the downward cascade (Consequence 2). The bypass's
   blast radius grows by one call site and by nothing else: it remains reachable only
   from server job context, never from a user route, and it still skips only
   `canTransition`.

9. **Three exemption-shaped alternatives were REJECTED** (tabled on MOTIR-2885). Each
   answers "this one container should not close itself"; the recompute answers the
   general question — _a parent's status should tell the truth about its children_ — and
   the home stops closing itself as a **consequence of the rule**, with nothing about it
   named anywhere in the code.
   - **Exempt the marker-resolved planner-bug home (MOTIR-1465) from rollup** — rejected:
     it special-cases one row, and owes a second special case to the next permanent
     container.
   - **A general `permanentContainer` flag on the work item, honoured by rollup** —
     rejected: a schema column, a UI affordance and an admin story, to describe something
     the recompute makes moot.
   - **Declare the home's status meaningless and document it** — rejected: it leaves a
     `done` mistake log reading "no planning bugs", and owes a manual revert after every
     sweep.

_Consequence 10 added 2026-08-17 with the forward-walk amendment (MOTIR-2901)._

10. **A forward derivation can now write more than one revision for one pass.** A parent
    that walks two or three rungs shows each hop in its activity feed, at the same instant,
    attributed to the workspace owner. That is the honest record — each is a status the item
    genuinely held, reached over an edge the team configured — and it is paired with exactly
    ONE `work-item/transitioned` for the NET move, so watchers, the automation engine, the
    grandparent's recompute and the downward cascade are not multiplied. **An automation rule
    keyed on entry into an intermediate status will therefore NOT fire for a rung the walk
    merely passed through**, which is deliberate: the parent was never meaningfully there,
    and firing rules for a state that existed for the width of one transaction would be
    worse than not firing them. The `rolled_up` outcome carries the passed-through rungs as
    `via`, so the run log can say what the feed shows.
