# A manual card a run reaches is a `manual_work` gate — decided by doing the work

**Status:** proposed · **MOTIR-7472** (Story MOTIR-7460) · 2026-10-03 · read at `origin/main`
`0a04b26`

**Amends:** `docs/decisions/approval-gates.md` §1 — the registry gains a kind, the way §11
(`plan_approval`) and §12 (`agent_review`) added theirs. It is named here as amended and not
edited: this record is the kind's section, kept in a file of its own so it can be read as one
question at the gate (`approval-gates.md` is 6,167 lines).

**Builds on:** MOTIR-7458 (the planner-recorded decision that a manual child in a parent run is a
gate, and that the Workbench tab **To approve** becomes **Waiting on you**, zh **等你处理**). This
record cites that name and does not re-decide it.

**Consumed by:**

| card       | what it builds from this record                                                        |
| ---------- | -------------------------------------------------------------------------------------- |
| MOTIR-7473 | the design: the Waiting on you row, the overlay port, the renamed tab, the run wording |
| MOTIR-7474 | the handler and its registry promotion: verbs, decided-by, withdrawn-by (§3–§6)        |
| MOTIR-7475 | the raise from a run's `needs_human` leg (§2)                                          |
| MOTIR-7476 | the tab rename across `messages/en.json` and `messages/zh.json`                        |
| MOTIR-7477 | the run page's and the CLI's wording (§8)                                              |
| MOTIR-7478 | the row and the overlay port (§7)                                                      |
| MOTIR-7479 | the Postgres tests: every raise, deciding door and withdrawal in the tables below      |
| MOTIR-7480 | the acceptance run                                                                     |

## Context

A parent run (`motir run <story>`, `motir auto`, the scoped drain) that reaches a manual child
(`isManualReadyItem`, `lib/dto/ready.ts`: `executor === 'human' || type === 'manual'`) skips it.
The CLI classifies it `needs_human` (`packages/cli/src/autoLoop.ts` `classifyReadyItem`), labels
it _"needs a human"_ (`SKIP_LABEL`), and the server records a skipped leg with
`skipReason: 'needs_human'` (`dispatchRunService.openWithin` for a card skipped at open,
`appendEvents` for a leg moved to `skipped` later). The run page shows _"Skipped — needs a human."_
(`messages/en.json` `needsHuman`, via `lib/runs/timeline.ts` `SKIP_REASON_KEY`). Nothing is put in
front of the person who has to do the work.

Facts this record builds on, read at `0a04b26`:

| fact                                                                                                                                 | where                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| A kind joins by a handler in `APPROVAL_GATE_HANDLERS`; the registry is total over the enum at compile time.                          | `lib/approvalGates/registry.ts`                                   |
| An `awaiting` gate holds the hand move into the status its `statusIntent` names (`APPROVAL_GATE_PENDING`); system writes are exempt. | `approval-gates.md` §6d amendment, rules 1, 3, 5                  |
| A move to Cancelled, or an archive, supersedes the card's awaiting gates with cause `pulled_back`.                                   | §6d rule 6; `ApprovalGateSupersedeCause.pulled_back` (MOTIR-7109) |
| Entering review asks every registered kind for its `currentSubject` and raises when it answers one.                                  | §6d rule 7; `approvalGatesService.raiseOnReviewEntry`             |
| One awaiting gate per `(work_item_id, kind, subject_id)`; `createAwaitingIfAbsent` resolves a double raise as "already raised".      | `approvalGateRepository.createAwaitingIfAbsent`                   |
| A card row's routing and authority are re-derived from the card: `assigneeId ?? reporterId`, or an admin (`approval:decide_any`).    | §2; `resolveGateAuthority`, `recordRoutedToId`                    |
| A run carries its starter, `DispatchRun.createdById`.                                                                                | `prisma/schema.prisma` `model DispatchRun`                        |
| The guide's consented close goes through a pending gate's decide door, never around it.                                              | `conversation-turn-intent.md` A2.6                                |
| The shipped guide landing instead SKIPS its close when a pending gate owns the status (_"decide it on the card"_).                   | `lib/services/guideLandingService.ts`, the `close` case           |
| The guide overlay's address is `?plan=guide&planFrom=guide&planItem=<KEY>`.                                                          | `conversation-turn-intent.md` A2.2                                |
| A kind with no Request changes refuses it by name (`ApprovalGateVerbNotOfferedError`).                                               | `lib/approvalGates/planApprovalHandler.ts`                        |

## Decision

**Option 1: a new kind, `manual_work`, whose subject is the WORK ITEM and whose decision is the card
reaching Done.** It owns the move into Done, so a pending gate holds that move on every door and
routes it through the decide door, exactly as every status-owning kind does (§6d rule 1).

### 1. The kind

| concern            | pinned value                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| enum value         | `manual_work`, in `ApprovalGateKind`, registered in `APPROVAL_GATE_HANDLERS` (none left as a hole)            |
| card-bearing       | yes; `workItemId` is the card                                                                                 |
| `subjectId`        | the work item's id, so the one-awaiting-per-subject index is one awaiting gate per card                       |
| `subjectVersion`   | `null`. Nothing about the work has a version; the decision is that the work is done                           |
| `statusIntent`     | `{ key: 'done', category: 'done' }`                                                                           |
| `permission` floor | `work_item:edit`, as `decision_choice`                                                                        |
| `currentSubject`   | `null` always. A run is the one raiser (§2); entering review never asks this kind (§6d rule 7 raises nothing) |

### 2. Raise

| concern       | pinned value                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| trigger       | a `DispatchRunCard` leg written with `disposition: skipped` and `skipReason: needs_human`, by either writer (`openWithin`, `appendEvents`), in the same transaction as the leg write                                                                         |
| server guards | the card resolves, is not archived, is not in the done category, is not in Blocked and has no open `blocked_by` (`isOpenBlocker`), and `isManualReadyItem` holds on the card as read in that transaction. The server does not take the CLI's reason as proof |
| idempotency   | on the CARD, not the run: `createAwaitingIfAbsent` on `(card, manual_work, card.id)`. A second run, or the same run reporting twice, raises nothing new. A decided gate does not stop a later raise on a reopened card                                       |
| not raised by | the card's existence; a card entering review; the `motir-meta` runbook's parent run, which writes no dispatch run; a leg skipped for any other reason                                                                                                        |
| failure       | a raise that cannot be written fails the leg write, so a run is never told a card is waiting on someone when no gate exists                                                                                                                                  |

> **AMENDED 2026-10-24 (Bug MOTIR-9500).** The _server guards_ row gains the readiness guard, so the
> raise mirrors §6 as amended by MOTIR-8670: a card in Blocked, or with a `blocked_by` on work that
> `isOpenBlocker` calls open, skips as `not_ready`, writes no gate and assigns nobody. Before this the
> raise could open a gate in exactly the state §6 withdraws it in — MOTIR-9482 and MOTIR-9483 were
> asked for in Waiting on you while the code cards they configure were unbuilt. Nothing is lost: the
> next run that reaches the card once its blockers are done or integrated raises it, as §6 already
> says.

### 3. Routing and authority

**§2 unchanged: `assigneeId ?? reporterId`, re-derived from the card.** To get the story's _"or
whoever started the run"_, **the raise assigns an UNASSIGNED card to the run's starter**
(`DispatchRun.createdById`) through `workItemsService`, in the raise's transaction, with a revision.
§2 then answers the starter as assignee, and the authority arm is `assignee`.

| card at raise                 | routed to                                   |
| ----------------------------- | ------------------------------------------- |
| has an assignee               | the assignee                                |
| unassigned, run has a starter | the starter, written as the card's assignee |
| unassigned, no starter        | the reporter (§2's fallback)                |

A later reassignment re-routes the pending gate, as for every card-bearing kind.

_Refused:_ writing `routed_to_id` = starter and leaving the card unassigned. Card rows re-derive
routing from the card (`recordRoutedToId`), so the row would list under the reporter, and
`resolveGateAuthority` would refuse the starter's Mark done unless they were also an admin.

### 4. Verbs

| verb / door          | what it is                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mark done**        | the decide door's `approve`. Writes the project's Done (`statusIntent`), terminal, as `decision_choice`'s approve does. With an open linked pull request it writes no status (`merge_writes_done`, §6d rule 2b) |
| **Guide me through** | a DOOR, not a verb: opens `?plan=guide&planFrom=guide&planItem=<KEY>`. It decides nothing by opening                                                                                                            |
| Request changes      | **not offered.** The handler refuses it with `ApprovalGateVerbNotOfferedError`. A person who cannot do the work says so on the card or in the guide (`cannot_do`)                                               |
| Decline / Overturn   | not offered (they belong to `plan_approval` and `decision_confirmation`)                                                                                                                                        |

### 5. Decided by — the card reaching Done through a person's door

| door                                            | how it decides                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mark done (row, overlay, item page)             | `approve` through the decide door                                                                                                                                                            |
| the guide's consented close                     | `approve` through the decide door, as the person whose turn it was (A2.6 row 2). The shipped landing's skip on a pending gate is replaced for this kind; it still skips for every other kind |
| the card's status control, the board, REST, MCP | refused `APPROVAL_GATE_PENDING` with `canDecide` (§6d rules 1 and 4); the surface opens the approval, and the press there is Mark done. An agent has no path to decide it                    |

Each records `approved`, with the deciding person, source and authority, like every kind.

### 6. Withdrawn by, and not withdrawn by

Withdrawal is a supersede: `state: superseded`, no actor, no note (§6b).

| event                                                                                  | outcome                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| the card stops being manual (executor or type edited so `isManualReadyItem` is false)  | superseded, NEW cause `no_longer_manual`, in the edit's transaction                                     |
| the card moved to Cancelled, or archived                                               | superseded, `pulled_back` (shipped, §6d rule 6 and MOTIR-7109)                                          |
| the card reaches Done by an EXEMPT system write (the parent merge cascade, the rollup) | superseded, NEW cause `closed_without_decision`. Nobody decided it, so it is not recorded as `approved` |

| event                                    | the gate                                                     |
| ---------------------------------------- | ------------------------------------------------------------ |
| the run cancelled, ended or died         | stays awaiting; the work is still owed                       |
| a second run meets the card              | stays; no second gate                                        |
| the card moved to Blocked or In Progress | stays (§6d rule 6 keeps it through `blocked`)                |
| the card reassigned                      | stays, re-routed (§3)                                        |
| to-do rows added, ticked or all ticked   | stays; ticking moves no status (`work-item-todo-list.md` §3) |

The parent run does not resume when the gate is decided. The person runs it again.

> **AMENDED 2026-10-07 (MOTIR-7710, Story MOTIR-7701).** A parent run that stops because its
> remaining work waits on gates now closes `gated` and names them (MOTIR-7703). When one is decided
> (Mark done, an approval, a choice, a confirmation), a run on Motir's **hosted** agent resumes
> itself: the `run/gate-resume.requested` job starts a hosted continue on the run's own branch, as
> its dispatcher with its model, and records what it did (`gate_resume`). Any other run waits on the
> Workbench's **To resume** tab for `motir continue <KEY>`. The sentence above is kept as the record
> of what this decision first said; it now holds only for a run that is not hosted.

> **AMENDED 2026-10-15 (Bug MOTIR-8670).** The row _"the card moved to Blocked or In Progress —
> stays"_ is overturned for **Blocked**. Waiting on you asks a person to do the work now, and a card
> nobody can start asks them something they cannot act on — MOTIR-8529 sat there for hours after a
> re-plan rewrote it and blocked it on new, unstarted work. Rule 6 still keeps every OTHER kind's
> question through `blocked`: they judge a result, this one asks for the work. The gate is now also
> withdrawn, in the triggering write's transaction:
>
> | event                                                                                                                             | outcome                           |
> | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
> | the card moved to Blocked, by any writer                                                                                          | superseded, NEW cause `not_ready` |
> | a `blocked_by` written from the card to OPEN work (`isOpenBlocker`) — the link door, a create's `blocks`, a plan's `blockedByAdd` | superseded, `not_ready`           |
> | the card moved to Planning, by any writer — a plan's append parks it there                                                        | superseded, NEW cause `replanned` |
> | a plan approval's `modify` changed the card's title, body or repository (`patchRescopes`)                                         | superseded, `replanned`           |
>
> Still kept: a move to In Progress, a `blocked_by` to finished or integrated work, and every edit to
> a field the stamp does not hash (assignee, priority, labels). **Nothing re-raises a withdrawn
> gate**: the next run that reaches the card raises it through §2, exactly as for a card never asked.

### 7. Listing

| surface                    | pinned value                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting on you (Workbench) | an awaiting gate lists for its routed person, read by `listAwaitingMe` like every kind                                                                                                      |
| the row's sentence         | _"<card title> is waiting on you"_ (zh 等你处理), with to-do progress `<ticked>/<total> steps` from the card's to-do rows (none when it has no list), and the age since the gate was raised |
| the Approvals room         | a DECIDED (`approved`) `manual_work` gate is listed like every other decision: who marked the work done, and when. A superseded one is not, under `approvals-room-withdrawn-gates.md`       |

Exact copy, layout and the overlay port are MOTIR-7473's design.

### 8. Run wording

| where                         | today                      | after                                                                                         |
| ----------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| the CLI report (`SKIP_LABEL`) | _needs a human_            | _waiting on you_ when the card's assignee is the run's starter; _waiting on <name>_ otherwise |
| the run page (`needsHuman`)   | _Skipped — needs a human._ | the same meaning: the card is waiting on its routed person, named                             |

The wire value `skipReason: needs_human` is unchanged; only the words change. Exact copy is
MOTIR-7473's.

## Alternatives refused

- **Option 2, reuse `decision_confirmation`.** Its subject is a decision body parsed into sections,
  and its verbs Confirm and Overturn judge a direction. Manual work is done or not done; there is
  nothing to confirm or overturn, and Overturn's write of Cancelled would be wrong.
- **Option 3, no gate: a Workbench "waiting" list computed from skipped legs.** A second list beside
  the one approve language, which `approval-gates.md` §1 exists to prevent. It would also hold no
  status, so a hand move to Done would pass with nothing recorded.

## Consequences

1. Two new `ApprovalGateSupersedeCause` members, `no_longer_manual` and `closed_without_decision`,
   each with its one writer.
2. `guideLandingService`'s `close` decides a pending `manual_work` gate instead of skipping, which
   brings it to `conversation-turn-intent.md` A2.6 for this kind.
3. The skipped-leg writers in `dispatchRunService` gain one call each, and may write the card's
   assignee.
4. Every existing kind lists, decides and renders as before in the renamed tab.

## What this does NOT decide

- **The tab's name.** MOTIR-7458 decided it; this record only uses it.
- **Copy, layout, the overlay port, empty and error states.** MOTIR-7473.
- **A parent run continuing by itself once the gate clears.** MOTIR-6858. _(Amended 2026-10-07:
  a HOSTED parent run now does, MOTIR-7710 — see the amendment under §6. Anything beyond resuming
  that one run stays MOTIR-6858's.)_
- **The Approvals room's name or shape** (MOTIR-5299), beyond whether this kind's decisions are listed.
- **Whether the scoped claim should reassign a manual card it skips.** The claim assigns every member
  to the starter today (`scopeClaimService.claimScope`), so a pre-assigned manual card may already
  route to the starter by the time the gate is raised. Changing that is not this kind's question.
- **The guide's close for any OTHER kind's pending gate.** It still skips, as shipped.
- **A manual card nobody ran.** Its own page already offers Guide me through; no gate is raised.
