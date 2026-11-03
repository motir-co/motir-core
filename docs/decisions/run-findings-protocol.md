# A run's findings — what a dispatched agent may write, and who controls it

**Status:** accepted · **Date:** 2026-08-19 · **Card:** MOTIR-3019 (story MOTIR-3017)
**Q5 added** 2026-08-30 · MOTIR-3980 (story MOTIR-1789) — what the RUN RECORD says
about a finding, now that a run has a record to say it in.
**Q6 added** 2026-09-02 · MOTIR-4083 (story MOTIR-3942) — the submit is an MCP tool
call, not a shell-out, and the agent composes the WHAT it carries.

> **On the file name.** `docs/decisions/` is slug-named, not numbered — forty-three
> files, none carrying an ordinal. MOTIR-3019 asked for "the next free number";
> there is none to take, so this takes the next free SLUG, checked against
> `origin/main` and against every unmerged sibling branch (`git show <branch>:docs/decisions/`)
> for the same reason a number would have been: two parallel runs picking the same
> name collide (`adr-number-race`).

An agent working a card finds two kinds of trouble: **this card is wrong**, and
**something else is broken**. Today the prompt handles the first and forbids
acting on the second — and the first does not survive the loop's close-out
(MOTIR-3018, fixed alongside this). This ADR settles what a dispatched agent may
write, how an operator controls it per run, and what automating plan approval
costs. **Q5, added later, settles the half that was missing:** Q1–Q4 gave a run the
right to file a bug and submit a plan, but the shared run record — which did not
exist when they were written — records neither, so nothing connects the finding
back to the run that produced it.

Every premise below was re-read on `origin/main` at `e04e2b9f`. Where the card
that commissioned this ADR described the code inaccurately, the correction is
recorded rather than quietly applied — see **Premises, verified** at the end.

---

## Q1 — How a per-run policy reaches the prompt

### Decision

**A single optional query parameter on `GET /api/v1/work-items/{key}/dispatch-prompt`,
`findingsPolicy`, carrying a comma-separated list of DISABLED capabilities from a
closed vocabulary.** It feeds a new field on `DispatchPromptOptions`, which
`dispatchPromptService` passes into `DispatchPromptSource` for
`lib/dispatch/promptTemplate.ts` to assemble conditionally.

```
GET /api/v1/work-items/MOTIR-42/dispatch-prompt?findingsPolicy=log-bug,replan
```

- **Vocabulary:** `log-bug`, `replan`. Named after the CAPABILITY, not after the
  CLI flag — the wire must not inherit a `--disable-` prefix that belongs to one
  client's ergonomics.
- **Absent or empty ⇒ the full protocol.** Every existing caller, and a human
  reading `motir run --print`, keeps today's output byte for byte.
- **An unrecognised token is a `400 INVALID_FINDINGS_POLICY`, not an ignored
  one.** A typo that silently rendered the full protocol would be precisely the
  lie this story exists to remove: the operator would believe they had disabled
  something the agent was still being told to do.
- The MCP `dispatch_prompt` tool takes the same option, so the two transports
  cannot disagree about the contract.

### Alternatives rejected

| alternative                                                                          | why not                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A CLI-side filter** — the flags change what `motir` does, not what the prompt says | Inert. The prompt is the ENTIRE contract with a sandboxed agent; an instruction it never receives cannot be obeyed or disobeyed. This is the whole reason the parameter has to exist.                                                                                                       |
| **A project-level setting only**                                                     | Cannot vary per run, which is the request. A protocol that always files bugs is wrong for a demo; one that never does is wrong for a maintenance sweep.                                                                                                                                     |
| **A prompt MODE enum** (`full` / `quiet` / …)                                        | A mode is a closed set over a product of independent capabilities: two booleans need four members, three need eight, and every new capability renumbers the vocabulary. A list of what is OFF grows by one token.                                                                           |
| **Two separate boolean parameters**                                                  | Equivalent in reach and slightly worse on the wire: `?logBug=false&replan=false` reads as two knobs with no shared meaning, and neither can be validated against a vocabulary — an unknown KEY is ignored by convention in both shapes, but an unknown VALUE is catchable only in this one. |

### What this reverses, quoted

MOTIR-2406, the card that wrote the outcome protocol, states: _"It does NOT add
a prompt MODE or a new parameter: every instruction here is unconditional,
because a human-driven `motir run` agent should report the same way."_

That is traded deliberately. The reasoning it rested on — instructions must not
drift between MODES — survives intact and is not what this does: there is still
exactly one grammar, and the policy REMOVES a branch rather than rewording one.
What it gives up is a different property, stated plainly because it is real:

- **A prompt is no longer reproducible from the card alone.** `motir run --print
--disable-log-bug` and a plain `motir run --print` on the same card produce
  different text, and both are correct.
- **Two agents on the same card can receive different instructions.** An operator
  who wants to know what an agent was told has to know the policy too.
- **`promptTemplate`'s purity claim changes shape.** Its module header says
  _"PURE: a function of its input record only … two calls for an unchanged item
  return byte-identical output"_ — the property MOTIR-881 pins. The property is
  RESTATED, not weakened: the same item **with the same policy** returns
  byte-identical output; the same item with a DIFFERENT policy returns different
  output, and that second half must be asserted explicitly or the switch could be
  inert and every disabled-branch assertion would pass vacuously.

Judged worth it because the alternative is worse in kind: an operator can already
decide whether to run an agent at all, and refusing them a say in what it may
write while it runs is a control gap, not a safety property.

### The naming — recorded as decided, not re-opened

**Primary spelling `--disable-log-bug` / `--disable-replan`** (Yue, 2026-08-18),
deliberately NOT the repo's `--no-*` convention (`--no-browser`, `program.ts:98`,
is the shipped example). `--no-log-bug` is a verb+object compound reading
ambiguously between _"don't log a bug this time"_ and _"the bug-logging
capability is off"_, and only the second is meant. `--disable-x` also leaves room
for a symmetric `--enable-x` if the project-level default of Q2 lands, without
commander's negation defaults getting in the way.

**`--no-log-bug` and `--no-replan` are accepted as HIDDEN aliases** — identical
behaviour, absent from `motir help` (`commander`'s `Option.hideHelp()`). The point
is that someone typing the house convention on instinct gets what they meant
instead of `unknown option`; the point is NOT to offer two documented spellings.

There is no `--no-auto-approve-replan`: that flag is positive and has no negation.

---

## Q2 — Automated plan approval: surface, scope, and bounds

### Decision: `/api/v1` only, and deliberately NOT an MCP tool

`plansService.approvePlan` gains a second CALLER, never a second implementation.

**Route: `POST /api/v1/work-items/{key}/plan-approval`.** It resolves the
workspace from the bearer token, calls the shipped service, and maps its typed
errors. Everything that decides whether a proposal becomes a row stays inside
`approvePlan`; the re-validation on the way through is untouched.

> **⚠️ AMENDED 2026-08-19 while building the loop half (MOTIR-3023).** This was
> written as `POST /api/v1/plans/{planId}/approval`, with the card named in the
> body. **The caller cannot learn a plan id.** The plan is submitted by the
> AGENT, in a sandbox, with `motir plan --detach <KEY>`; the id comes back on
> that agent's stdout, which the loop streams straight to the terminal and never
> captures — and MOTIR-3023 forbids scraping it for exactly that reason. A
> plan-addressed route therefore needed either a second `/api/v1` read to
> discover the id or a second source of truth, and B1's anchoring check would
> have been a check on data the CALLER supplied.
>
> Addressed by the CARD, the bound stops being a check and becomes structural:
> **there is no way to name a plan the card did not produce.** The server derives
> it, and the route takes no body at all — so there is nowhere for a plan id to
> creep back in. One operation instead of two, and a stronger guarantee.

**Scope: `ai:view_plan`** — the key `lib/mcp/toolPermissions.ts` already records
as gating the plan DECISIONS (`approvePlan` / `declinePlan` / `addProposals`). No
new scope is minted.

> ⚠️ **AMENDED 2026-08-20 (MOTIR-3188): the route now declares `ai:decide_plan`.**
> The rule this answer applied is unchanged and still the right one — _a route
> names the key its own service asserts, and no new scope is minted for a decision
> that already has one._ What changed is the service. `ai:view_plan` gated no view
> and held two authorities at once (AUTHOR: `addProposals` / `markPlanned` /
> `editAddProposal`; DECIDE: `approvePlan` / `declinePlan`), which made a custom
> role ticking a switch labelled _"View AI plans"_ a bulk work-item creator.
> `approvePlan` moved to the DECIDE half and this route followed it. The operation's
> shape, statuses and error codes are untouched. See
> `docs/decisions/agent-authored-plans.md` AMENDMENT 5.

**Not an MCP tool, and that is the sharpest bound available.** MCP is the AGENT's
surface. A tool would put approval in reach of the credential the sandboxed agent
holds, which is the one party that must never approve its own re-plan — the
approving party is the OPERATOR's loop, not the agent it launched. Expressing
that structurally beats expressing it as a check, and it costs nothing: the CLI
speaks `/api/v1` exclusively (`docs/decisions/cli-v1-client.md`).

It is also already enforced from the other side and by accident of good design:
`CLI_TOKEN_GRANT` is `['project:browse', 'work_item:edit', 'comment:add',
'ai:plan']` — **no `ai:view_plan`** — so a token minted for a dispatched agent
cannot reach this endpoint even if someone hands it the URL. That is MOTIR-3051's
refusal working as intended, and it must not be "fixed" by widening the grant.

> ⚠️ **AND SINCE MOTIR-3188 THE BOUND IS STRUCTURAL, NOT AN OMISSION.** The
> argument above rests on one entry being absent from one grant — true, but a
> single edit away from false. The route now declares `ai:decide_plan`, which
> `CLI_TOKEN_GRANT` also omits AND which **no MCP tool asserts at all**, so a
> dispatched agent's credential cannot reach approval by any route — and could not
> even if somebody widened that grant to the full author key. The key is reachable
> by an OPERATOR's token, through this one v1 operation and no other:
> `lib/tokens/grant.ts`'s `V1_ONLY_PERMISSIONS` carries it, the first entry that
> array has ever held.

### The bounds — each implementable and testable from this text alone

**B1 — the CARD is the address, and the plan is DERIVED from it.**
The key is in the path and there is no request body. The server resolves the plan
through `buildScope([key])` → `planChangeSessionRepository.findByProjectAndScope`
→ that session's `lastJobId` → `plansService.findPlanIdForJob`. Every hop is
shipped; nothing new is stored. A `motir plan --detach <KEY>` thread is anchored
at exactly that scope, so this reaches the plan the card's refusal caused and
nothing else.

Refusal is a typed error naming why — `NO_PLAN_FOR_WORK_ITEM`, 422 — never a
silent narrowing. Two consequences worth stating:

- A card with **no** anchored conversation, or one that has never submitted, is
  **not** approvable here — and neither is a plan from the project-wide thread,
  which is the shape a cadence plan and an onboarding generation both have.
  That is correct: this endpoint exists for a plan a run's agent submitted about
  the card it was handed, and every other plan keeps the human gate.
- It bounds the endpoint to the plan a run **caused**, which is stronger than
  "the plan this run submitted" (unobservable server-side) and weaker than a
  per-run token (not worth a new mechanism). The gap is: a second run on the same
  card, in the same window, could approve the first's plan. It is named rather
  than hidden, and it is acceptable — both runs are the same operator's, working
  the same card, and the card is held out of the ready set the whole time.

**B2 — status, inherited not added.** `approvePlan` already refuses a plan that
is not `planned` (`PlanNotInExpectedStatusError`), and a second concurrent
approve observes `approved` and 409s. This endpoint adds nothing; it must not
re-derive the check.

**B3 — approving an already-approved or declined plan answers the same 409 the
session route answers.**

> **⚠️ CORRECTED 2026-08-19, before it was built (MOTIR-3021).** This bound was
> written as _"the same no-op the session route produces"_, taken from
> MOTIR-3019's own text and not verified. It is false: the session route maps
> `PlanNotInExpectedStatusError` to **409**
> (`app/api/plans/[id]/approve/route.ts`), which is the atomic one-shot guard —
> the loser of two concurrent approves observes `approved` and is refused. There
> is no no-op anywhere on that path.
>
> Mirroring the 409 is also the right answer, not merely the true one: two
> entrances answering ONE condition two different ways is exactly what "no second
> approval implementation" exists to prevent. What the loop does with a 409
> _because the plan was already approved_ is the loop's decision (MOTIR-3023),
> and it is a different question from what the endpoint says.

**B4 — cross-workspace refusal is indistinguishable from an unknown plan.** A
plan in another workspace and a plan id that does not exist return the same
response. No existence leak.

**B5 — an approved plan MAY change the run, and the loop absorbs it; the server
does not forbid it.** This is the case the endpoint exists for: the agent said
the card is wrong, so a plan that re-scopes or REMOVES that card is the correct
output, and a server that refused it would make the flag useless in its central
case. The obligations therefore sit in the loop (MOTIR-3023):

- The refused card is **not dispatched again by the same run**, approved plan or
  not — the existing `seenKeys` guard and exclude list, and the summary says it
  was held out. Without this, approve → ready → dispatch → refuse → approve is an
  infinite loop that spends AI credits every turn.
- **A card that stopped existing must not crash the run.** An archived or removed
  card is an ordinary outcome, recorded and stepped past.
- **Cards already FINISHED are not revisited.** The run's records are a log of
  what happened, not live state; a plan that re-scopes a card whose pull request
  is already open changes the card, not the history.
- **`--max` still binds.** An approved plan can enlarge the ready set without
  limit; the cap is what stops a run expanding forever.

**B6 — a REFUSED approval stops the run with the server's own message.** Never
continue as though it had succeeded: the loop's next iteration would dispatch
against a tree the operator has not agreed to.

### The project-level default — decided in shape, not built here

**Yes, a project must be able to forbid automatic approval outright**, and the
check belongs SERVER-SIDE where a CLI flag cannot route around it. Its shape is
fixed here so a later card does not re-derive it:

- A project setting `aiPlanAutoApproval: 'allowed' | 'forbidden'`, default
  **`allowed`**. Default-forbidden would make the flag inert until someone flipped
  a setting, which contradicts the request that produced it; a team that wants the
  human gate opts INTO it, which is the same direction every other Motir setting
  runs.
- Enforced in the route, before the service call, as a typed
  `AUTO_APPROVAL_FORBIDDEN` refusal naming the project.

**This story does not build it.** It is named so MOTIR-3021's "every bound the ADR
set is enforced server-side" reads unambiguously: B1–B6 are that story's bounds;
the setting is a specified follow-up, and the route should be written so adding it
is one guard.

### What this reverses, quoted

Four places in the codebase assert that plan decisions are not available off the
session surface. They are listed in **Comments the implementing cards must
correct**, below, with what each should say instead. The strongest is
`lib/mcp/tools/getPlan.ts:34`: _"`plansService.approvePlan` — a human decision
made in Motir — is the only path from a proposal to a `work_item` row."_

The half that stays TRUE is the important half: `approvePlan` **is** still the
only path from a proposal to a work item, and this ADR does not add a second one.
What changes is who may call it and from where. The trade is worth making because
the alternative on offer was not "a human decides" but "an unattended run stops
and the finding sits until someone notices" — and the operator who passes
`--auto-approve-replan` is a human deciding, once, in advance, with the bounds
above written down. What it costs is real and is the reason for B1 and the
project setting: **an unattended loop can now change a plan somebody owns while
they are not watching.**

---

## Q3 — Where a run-filed bug is parented

### Decision: ONE rule, no discriminator the agent can get wrong

**A bug a dispatched agent files is parented under the IN-FLIGHT CARD'S PARENT,
and `relates_to` the in-flight card.** Where the in-flight card has no parent, the
bug is parented under the in-flight card itself.

The parent key is already on the dispatch payload the agent was handed
(`DispatchPrompt.parentKey`, MOTIR-2445), so the prompt can state it as a
CONCRETE key rather than as a rule to apply. There is nothing to look up, nothing
to choose, and nothing to invent — which is the whole requirement.

### Why not the planner-bug home

> **AMENDED 2026-09-25** by [`run-found-trigger-dispatched-path.md`](run-found-trigger-dispatched-path.md)
> ([MOTIR-6226](motir:cmufwkaue00hmhutxnbeuujv6)): still true of the AGENT, which cannot produce
> a planning defect through the card-is-wrong branch; no longer true of the RUN — the server
> files into the home on the runner's `report_unbuildable_target`, only for a native plan's card
> unchanged since approval.

`lib/ai/plannerBugHome.ts` resolves `PLANNER_BUG_HOME_MARKER`, and
`aiWorkItemsService.fileBug` files there. (Since MOTIR-5822 the home is a FOLDER
— the project's planner-bug destination, falling back to its bug destination and
then its root — and the bug is filed into it with no parent; it was a `story`
titled `Captured planning-mistake bugs` when this record was written.) That home is for **PLANNING** defects — telemetry about the planner,
whose fix is the plan or the rule that would have prevented it.

A dispatched agent cannot produce one through this branch, by construction: a
defect in the CARD it was handed goes down the THE-CARD-IS-WRONG branch and
becomes a re-plan. The FOUND-A-DEFECT branch is, by definition, _"my card is fine
but something else is broken"_ — a product defect, whose fix is code in a repo.
So the two homes stay separate and the agent never has to tell them apart.

The home is also unreachable from a dispatched agent's credential: `fileBug` sits
behind the internal service-auth route, and `CLI_TOKEN_GRANT` does not carry what
it asserts. A rule the agent could not execute would be worse than no rule.

### What the prompt must REQUIRE, so a filed bug is not under-authored

- `kind: 'bug'`, `parentKey` as above, and a `relates_to` link to the in-flight
  card. The link is the discovery trace: the parent says where the bug LIVES, the
  link says where it was FOUND.
- A description carrying, in order: **the REPRODUCTION** (what to do to make it
  happen), **the EVIDENCE** (the command run and its verbatim output, or the file
  and line read), and **the CARD AND BASE it was seen at** — the key, and the
  branch or commit, because a figure measured on an unmerged branch is not a
  figure about `main`.
- **Reproduce FIRST.** A bug filed from a code-reading theory is a claim, not an
  observation, and it costs the next reader the same investigation twice.
- **It blocks nothing and claims no scope.** No `blocked_by` edge, no sprint, no
  estimate. Filing is purely additive — which is what makes it safe for an
  unattended run to do at all, and it must stay that way.
- **Only the description axis.** `create_work_item` has no `explanationMd`
  parameter, so the WHY axis cannot be set at create. The prompt asks for the
  description and nothing else; the standing rationale is written by whoever
  triages it, who has context the agent does not.

### And the branch must say what filing does NOT do

**Filing a bug does not end the run and does not change the card's own outcome.**
Stated explicitly in the prompt text, because an agent that has just found
something broken will otherwise treat it as a reason to stop. It reports what it
found and carries on with the card in hand.

### The contradiction this closes

`WHAT_TO_DO.code` step 5 (`promptTemplate.ts:156`) already tells the agent to
_"log anything else you find as a separate work item"_, while `outcomeProtocol`
two sections later forbids it: _"do not create or edit work items yourself. A
plan is PROPOSALS awaiting a human's approval; writing the cards would be doing
the approving."_ Both texts are in every `code` prompt shipped today.

The justification is also simply wrong about the mechanism: `create_work_item` is
a DIRECT write. Nothing about it is a proposal and nobody approves it — it is how
`motir log-bug` files bugs and how every card in this story was authored. The
prohibition is REPLACED, not deleted, and what survives is the part that is true
and load-bearing: **do not restructure the plan.** Creating a bug and submitting a
re-plan are permitted; archiving, re-parenting, re-scoping and editing another
card remain forbidden, and the prompt must say which is which.

---

## Q4 — Why `--auto-approve-replan` is `auto`-only

Settled by Yue on 2026-08-18. Recorded here because the RATIONALE is what keeps it
from being helpfully extended later.

- **`run` and `next` dispatch ONE item and exit.** The flag's whole value is
  _"the run can continue to finish the cards"_, and there is no continuation to
  have. Approving there would change the tree and then exit.
- **`batch`'s snapshot is FROZEN before the first agent starts**, and nothing
  re-reads the ready set to pick work — its defining contract
  (`packages/cli/src/batchPlan.ts`: _"it FREEZES the ready set once, up front, and
  implements exactly those items"_). Approving a plan there would change the tree
  and then decline to act on it, which is worse than refusing the flag. **Nothing
  in this story weakens that guarantee**; `batch` gains the two `--disable-*`
  flags and nothing else.
- **`auto` asks `next_ready` each iteration**, so newly-approved cards genuinely
  enter the run. It is the only command where the flag means anything.

**The other three REGISTER the flag in order to refuse it**, with a description
naming `auto`. A flag a command guards but never declares is rejected by commander
first with a bare `unknown option`, leaving the guard that carries the real
guidance unreachable — the MOTIR-1828 / MOTIR-1830 defect, shipped twice. The
remedy is already in `program.ts`: `auto` and `batch` register `--print` precisely
so their own guards can speak (`program.ts:234`, `program.ts:250`). Mirror it.

**On `auto`, `--auto-approve-replan` together with `--disable-replan` (or its
alias) is contradictory** and is refused at parse time, with a message naming both
flags. Approving a re-plan that the prompt was told not to offer cannot happen,
and a run that accepted both would be silently ignoring one of them.

---

## Q5 — How the RUN RECORD points at the bug it filed and the plan it submitted (MOTIR-3980, 2026-08-30)

Q2 and Q3 settled what a run may WRITE. Neither settled what the run RECORDS about
having written it — and today the answer is nothing. `DispatchEventKind` has one
finding-shaped member, `plan_approved`, and it fires only on the `auto`
`--auto-approve-replan` path. A run that files a bug, or submits a re-plan a person
must still decide, leaves no trace of it anywhere in `dispatch_run`,
`dispatch_run_card` or `dispatch_run_event`. The Consequences above already claim
the win — _"the bug it reproduced becomes a card; the re-plan it submitted survives
the close-out"_ — and that much is true. What does not survive is the CONNECTION:
the card exists, and nothing says which run produced it.

### Decision: the SERVER records the finding on the leg, at the moment it observes the write

**Three findings, one mechanism.** When a work item is created with `kind: 'bug'`,
and when a plan-change job produces a plan, the SERVICE THAT PERFORMS THAT WRITE
also appends a CARD-scoped event to the leg that is open for the work item in
question, if one is. Two new `DispatchEventKind` members carry them —
`bug_filed` and `plan_submitted` — alongside the shipped `plan_approved`, which
is unchanged and stays RUN-scoped.

| Finding                                     | Event                     | Written by                                | `data`                           |
| ------------------------------------------- | ------------------------- | ----------------------------------------- | -------------------------------- |
| A plan the run AUTO-APPROVED                | `plan_approved` (shipped) | the `auto` loop, via the reporter         | `{ key, planId, proposalCount }` |
| A plan the run SUBMITTED, awaiting a person | `plan_submitted` (new)    | the plan-change service, server-side      | `{ planId, proposalCount }`      |
| A bug the run FILED                         | `bug_filed` (new)         | `create_work_item`'s service, server-side | `{ key, workItemId, title }`     |

### Why the SERVER and not the CLI — the reason is already written down

The CLI cannot report either one, and this is not an accident of the current code.
`plansService.approvePlanForWorkItem`'s own comment says why, about the plan id
exactly:

> the plan id came back on that agent's stdout, which the loop streams straight to
> the terminal and never captures. So a plan-addressed entrance would have forced
> either a second read to discover the id or a scrape of the agent's output, and
> the anchoring check would have been a check on caller-supplied data.

A bug's key is on the same stdout and just as uncaptured. So a CLI-reported finding
would require exactly the two mechanisms Q2 rejected when it chose a card-addressed
approve over a plan-addressed one — a scrape, or a second read whose answer the
caller then supplies. The argument that bounded the approve entrance bounds this
identically, and rejecting it twice for one reason is better than inventing a
second.

The server has no such problem. Both findings are server-side writes in the first
place: the bug goes through `create_work_item`, the plan through the plan-change
job. The one party that already sees both, with the ids in hand and no scraping,
is the one that records them.

### Why RECORDED and not RESOLVED at read time

The tempting alternative is to write nothing and derive the answer when the run is
read — a bug is discoverable as _"`kind: 'bug'`, `relates_to` this leg's card
(Q3 REQUIRES that link), created inside the leg's `startedAt`/`endedAt` window"_,
and a plan through the shipped anchor chain, `buildScope([key])` → the plan-change
session at that scope → its `lastJobId` → the plan. Both queries are writable
today against shipped data, and neither needs a migration. It is a real option and
it was seriously considered.

It is rejected because it contradicts the record's own governing principle, which
is stated twice in the schema this decision extends. `dispatch_run_card.workItemId`
is `SET NULL` on delete, annotated _"a run's history outlives a deleted card"_.
`workItemKey` is denormalised beside it _"so a leg whose work item is gone still
says which card it was."_ And `position` is stored rather than re-derived because
_"the order is a fact about what the run DID, and the graph it came from moves
underneath it."_

A resolved pointer is precisely the thing those three annotations refuse. Archive
the bug and the run silently stops having found it. Re-plan the card and the anchor
chain answers about a later conversation. The run's history would move underneath
it — which is the failure mode the whole table shape was built to prevent. A run
record is a record of what HAPPENED, and what happened does not change when the
tree does.

### The leg the event lands on, and what happens when there is none

CARD-scoped, on the leg open for that work item — the same lookup shape the shipped
`@@index([workItemId, createdAt(sort: Desc)])` was added for. "Open" is
`endedAt IS NULL` on the newest leg for that item; the write is attributed to the
run that was in flight when it happened, and to no other.

> **Amended 2026-09-25 (MOTIR-6279): for a PLAN, "when it happened" is when the
> plan was CREATED, not when it reached `planned`.** A dispatched agent's
> `submit_plan_session` opens the plan `generating` and returns at once; the agent
> exits, the CLI settles the leg `replanned` and usually closes the run, and only
> then does the model finish. Resolving the leg open at `planned` therefore found
> nothing on every real refusal, reproduced in `tests/dispatchRunFindings.test.ts`.
> The plan finding now resolves the leg that SPANS the plan's `createdAt` —
> `startedAt <= createdAt`, and `endedAt >= createdAt` or still open on a running
> run — so the event can land on a settled leg of a closed run. The same reading
> keeps a person's plan, opened before a run picked the card up, off that run's
> leg when it happens to close mid-leg. A bug is unchanged: it is recorded at the
> moment it is filed, so "open now" is still the right question for it.

**No open leg means no event, and that is not an error.** A person filing a bug in
the app, `motir log-bug` from a terminal, a plan submitted from the project-wide
panel — none of them belong to a run, and the lookup returning nothing is the
correct answer for all three. The append is best-effort and never fails the write
that triggered it: a bug that was filed must stay filed even if the run it belonged
to closed a millisecond earlier. This is the same posture Q3 took on filing itself —
purely additive, never load-bearing.

### id and copy — the event carries the ID, the surface reads the ROW

`data` carries identifiers and the one label needed to render a row that has not
loaded yet (`title` for a bug, `proposalCount` for a plan). It does not carry the
description, the proposal bodies, or any other copy. A finding's copy is a live
row that gets edited, re-titled and triaged after the run ends, and a run record
that had frozen a copy of it would show the reader something that is no longer
true — while claiming, by sitting in an immutable log, that it is.

This is NOT a contradiction of the section above. What the run records immutably is
THAT IT FOUND SOMETHING AND WHICH ROW IT IS; what the row currently SAYS is the
row's business. The pointer is the fact; the copy is a read. So `bug_filed.title`
is a fallback for a row the surface has not fetched or may no longer fetch, and the
surface prefers the live row whenever it has it.

### The privacy line — this moves it not at all

Q4's boundary holds exactly as written: LIFECYCLE ALWAYS, LOG BODY OPT-IN, DEFAULT
OFF. Both new events are LIFECYCLE, and — because the server writes them from rows
it already stores, in the same project, under the same permissions — **a BYOK-local
run sends not one additional byte to produce either of them.** No new field crosses
the operator's machine boundary, `--report-log` gates nothing here, and `body` stays
null on both. A local run and a hosted run record findings identically, which is
the property the local-now/hosted-later story most needs to keep.

**On the bug's TITLE specifically**, which the commissioning card was right to flag
as the sharp case: a title is user content, and if the CLI reported it, it would be
content leaving the operator's machine and would have to sit behind `--report-log`.
Under this decision it does not leave the machine at all. The bug was created
through `create_work_item` — a server-side write — so its title was already stored,
in that project, before any event was written; the event copies a string from one
server-side row to another. **The id and the title fall on the SAME side, the
default-send side, for the same reason: neither is ever sent.** Had the CLI been the
writer, the honest answer would have been the id by default and the title behind the
flag, and the surface would have been left rendering bare keys — a second good
reason the writer is the server.

### Everything that must absorb the two members — named, because only ONE is compiler-enforced

`DispatchEventKind` is a closed enum with total renderers, so two members are a change
seven places must take. Measured on `parent/MOTIR-1789-agent-runs`:

| site                                              | what it is                                                       | how it fails today if missed                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `prisma/schema.prisma` — `enum DispatchEventKind` | the enum + its migration                                         | the ingest rejects the value                                                     |
| `lib/runs/timeline.ts:78` — `EVENT_STEP`          | `as const satisfies Record<DispatchEventKind, CardStep \| null>` | **`tsc` fails — the only compiler-enforced one**                                 |
| `lib/api/v1/workLoop/schema.ts:1583`              | the OpenAPI enum, hand-written                                   | silent: the documented contract omits them                                       |
| `packages/cli/src/client.ts:858`                  | the CLI's own union                                              | silent: the CLI cannot name a kind it never emits                                |
| `packages/cli/src/api/schema.d.ts:9110`           | generated from the OpenAPI doc                                   | regenerate, do not hand-edit                                                     |
| `tests/dispatchRunSchemaBoundaries.test.ts:84`    | the FROZEN key list, `toEqual`                                   | red, and correctly so                                                            |
| `tests/dispatchRunSchemaBoundaries.test.ts:223`   | `'DispatchEventKind — six run-scoped, thirteen card-scoped'`     | red — **and its NAME must change too**, to `six run-scoped, fifteen card-scoped` |

`tests/runs/runTimeline.test.ts:78` lists the kinds as fixture data and follows the
frozen list. `packages/cli/src/agentLogTee.ts:15` names several kinds in a comment
and should stay accurate.

**Both new members are CARD-scoped**, so the run-scoped count is unchanged at six and
the card-scoped one goes from thirteen to fifteen — twenty-one total.

### What each surface shows when the target is archived, declined or deleted

The three cases are NOT the same, and the record's answer differs:

- **A plan a person DECLINED.** The plan row is still there and the pointer still
  resolves. The run said _"I submitted this"_ and that stayed true; a person then
  said no. **The surface shows the plan with its current status** and never re-words
  the run's own event — a declined plan is the most informative outcome on the page,
  not an error to hide.
- **An ARCHIVED bug.** The row exists but is out of the tree. The finding renders,
  marked archived, still linked. A run that found a real defect somebody later
  archived is exactly the history a run record exists to keep.
- **A DELETED row, or one this reader may not see.** The pointer resolves to
  nothing. The surface renders the finding from `data` alone — the key and title it
  recorded — as a fact without a link. **It must not drop the row and must not show
  an empty state**, both of which would tell the reader the run found nothing when
  it did. This is the same posture `dispatch_run_card.workItemKey` already takes for
  a deleted work item, and it is why `data` carries a label at all.

### Nothing in the prompt or the findings contract changes

The dispatched agent reports nothing new, so **Q1's parameter shape, Q3's prompt
requirements and `promptTemplate.ts` are all untouched by this.** That is a
deliberate property of choosing the server as the writer: the prompt is the one
contract in this system whose determinism is load-bearing and whose every widening
has to be re-argued, and a decision that can be implemented without touching it
should be.

### The measurement this was written from

Re-read on `parent/MOTIR-1789-agent-runs`, 2026-08-30:

- `plan_approved` already carries `ApprovalRecord { key, planId, proposalCount }`,
  emitted once, in `packages/cli/src/commands/auto.ts:372`. The auto-approved case
  needed no record change — only a surface.
- `agentSubmittedReplan` returns a **boolean**, from `item.status === 'planning'`.
  The run learns THAT a re-plan happened and never which plan, which is why
  `batchPlan.ts`'s `SKIP_LABEL` promises _"a re-plan is waiting for you in Motir"_
  and cannot say where.
- There is **no** `bug_logged` member of `DispatchEventKind`, and no reference to a
  bug anywhere in `dispatchRunReporter` or `dispatchRunService`. Nothing ties a bug
  to a run.
- `dispatch_run_card` carries `startedAt` / `endedAt` and
  `@@index([workItemId, createdAt(sort: Desc)])`, which is the lookup the
  server-side append needs and does not have to add.

### What the surface may therefore promise

The run modal may state, for any run and without a `--report-log` opt-in, that this
run filed these bugs and submitted these plans, each as a link to the live row. It
must render a finding whose row is gone (deleted, archived, or not visible to this
reader) as the recorded fact it is, from `data` alone — never as an empty state and
never by dropping the row, both of which would tell the reader the run found
nothing when it did.

---

## Q6 — The submit is a TOOL CALL, and the agent COMPOSES the WHAT (MOTIR-4083, 2026-09-02)

Q2 and its amendments were written with the agent submitting its re-plan by
shelling out — `motir plan --detach <KEY>` — and the two mentions above are kept
as they were, because B1's anchoring argument does not depend on the door: the
thread is anchored at exactly one key either way. What this section changes is
the DOOR and what goes through it.

### Decision: `append_plan_turn` + `submit_plan_session`, anchored at `targetKeys: [<KEY>]`

The prompt's THE-CARD-IS-WRONG branch instructs five Motir MCP tools and, at
exactly one line, a command line — step 5 of a branch whose step 4 is a
`transition_status` call. `submit_plan_session` asserts `ai:plan`, which
`CLI_TOKEN_GRANT` already carries, so the agent could always have called it. It
now does: **step 5 appends the finding as a turn (`append_plan_turn`), step 6
submits (`submit_plan_session`), both anchored at `targetKeys: [<KEY>]`** — the
argument that replaces the old leading positional, carried on BOTH calls because
two calls are two chances to drop it and an unanchored submit files a plan about
one card's defect against the whole project.

**The `motir plan` command is untouched.** It is a person's terminal command; the
agent is an MCP client that happens to have a shell. `tests/mcp/submit-requirement-door.test.ts`
asserts, by absence, that no `--requirement` option grew there (MOTIR-4172).

### The WHAT is a STRUCT, composed by the agent — six fields, three required

The retired command sent a key and nothing else: the evidence went into a comment
a person reads, and the first thing a triggered re-plan did was open a
conversation to ask what was wrong — a question whose answer existed and was
discarded when the agent exited (MOTIR-4082 is the consumer that would rather not
ask). The submit now carries motir-ai's `SettledRequirement` — `outcome`,
`behaviour`, `scopeEdge`, `constraints`, `acceptance`, `assumptions`, in that
order (`REQUIREMENT_FIELDS`), with the first, second and fifth required non-empty
(`REQUIREMENT_REQUIRED_NON_EMPTY`) and the other three allowed to be `""`, which
says _considered, and there is none_. The prompt teaches the fields by name and
by what each is for; `assumptions` is translated for this actor (_what the agent
concluded that nobody has confirmed_), since its conversation-shaped definition
presumes a person present to not-correct it.

Three obligations on the prompt, each asserted on the COMPOSED text:

- **The agent gets ONE shot, and is told so.** Nothing goes back and asks it — it
  has exited — so the turn is framed as a brief, not a note.
- **A pointer is not a WHAT.** _"See my comment on the card"_ satisfies "pass your
  evidence" and supplies nothing; the prompt names it as insufficient. The struct
  is that rule made mechanical — a field a run must fill enforces what an
  instruction can only ask for.
- **The field names are motir-ai's, asserted against a fixture that mirrors
  motir-ai's own list** (`tests/fixtures/settledRequirement.ts`). This seam
  already failed once with both halves green (MOTIR-4168: the producer pinned
  prose, the consumer expected the struct, nothing converted). A prompt asserted
  only against itself is what let it.

### What the prompt does NOT ask, and what a refusal never waits on

- **No diagnosis of the planning rules.** Q3's reasoning holds one step over: an
  agent asked to classify invents. It describes what is wrong with the CARD.
- **A refusal is never conditional on writing well.** An agent that cannot
  articulate the problem submits anyway, without `requirement`; the tool accepts a
  partial or absent one (MOTIR-4082's partial-supply arm, MOTIR-4172's pass-through).
  A run's submit carries `fromRun: true`, so the planner asks it nothing: it plans
  from what it was given, or replies on the run's comment why it cannot
  (MOTIR-10233).
- **The comment stays.** The human-readable trail is not traded for the
  machine-readable one — the turn carries the SAME text as the step-3 comment.
  Composed once, delivered twice.

### "Run it ONCE" now has two parts

> **AMENDED 2026-09-25** by [`run-found-trigger-dispatched-path.md`](run-found-trigger-dispatched-path.md)
> ([MOTIR-6226](motir:cmufwkaue00hmhutxnbeuujv6)): it now has THREE — the report (free, safe to
> repeat), the append (free), and the submit (spends credits, never retried).

Appending costs nothing and starts no job; **submitting is the act that spends the
token owner's credits.** The prompt says both, in its own voice, because an agent
that thinks its append submitted stops having done nothing, and one that retries
the submit pays twice for one finding. **One exception, new with the tool:** a
`requirement` the tool's schema rejects is refused before the handler runs — no
job, no credits — so that ONE case is re-submitted once, without the requirement.
It is stated as its own sentence, apart from _never retry_, because collapsing the
two is how _never retry_ becomes _retry freely_. (The CLI door had the opposite
property: it had to swallow an unparseable file.)

### What does not change

`autoLoop`'s `replanned` outcome is read off the card's status (`planning`), not
off the door, so it still fires and still stops the loop; its operator line —
_review the submitted plan in Motir, then re-run it_ — still describes what is
waiting. Q4's `--auto-approve-replan` bound (B1) is unchanged: the plan is derived
from the conversation anchored at the card, and that conversation is exactly the
one `targetKeys: [<KEY>]` names. Q5's recorder walks the same session back.

### One product consequence, named rather than decided

An `append_plan_turn` from a dispatched agent lands on the SAME thread the user's
planning panel shows — one conversation, two surfaces. So an agent refusing a
card injects a turn into a conversation the operator may be having. That is
probably right (it is the run's own thread, and the operator is being sent there
anyway), but nobody has chosen it, and it is the kind of thing that surprises
someone the first time.

---

## Comments the implementing cards must correct

Left as they stand, the codebase argues with itself — a comment insisting
approval is never automated, beside the endpoint that automates it. Each is either
corrected to describe what is now true or annotated with this ADR. MOTIR-3021
discharges the list.

| path                                                 | the assertion                                                                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/mcp/tools/getPlan.ts:34`                        | _"`plansService.approvePlan` — a human decision made in Motir — is the only path from a proposal to a `work_item` row"_                                                            |
| `lib/mcp/tools/planSession.ts:53`                    | _"`plansService.approvePlan` — a decision made in Motir, not on this surface — is the only path from a proposal to a work item"_                                                   |
| `lib/mcp/tools/expandItem.ts:37`                     | _"`plansService.approvePlan` is the ONLY path from a proposal to a work item"_                                                                                                     |
| `app/api/v1/work-items/[key]/expansions/route.ts:20` | _"`plansService.approvePlan` — a human decision made in Motir, not on this surface"_                                                                                               |
| `lib/mcp/toolPermissions.ts:78–90`                   | two comments describing `ai:view_plan` as gating decisions that have no door; one already carries a 2026-08-18 amendment note for `add_plan_items` and needs the same for this one |
| `lib/mcp/scopes.ts:97`                               | _"`approvePlan` / `declinePlan` assert the same key and are not"_ [reachable]                                                                                                      |
| `lib/services/aiPlanEditsService.ts:19`              | _"the ONE path that turns proposals into work items is `plansService.approvePlan`"_ — **still TRUE, and must NOT be edited into saying otherwise.** Annotate only.                 |
| `lib/dto/plans.ts:572`                               | _"Nothing here has touched the tree: `plansService.approvePlan` is the…"_ — same: true, annotate only.                                                                             |

The discriminator: a comment saying `approvePlan` is the ONLY proposal→row path
stays, because it is still true. A comment saying it is reachable only from Motir,
or only from a session, is now false and is corrected.

---

## Premises, verified — and three the commissioning card got wrong

Every claim MOTIR-3019 makes was re-read on `origin/main` at `e04e2b9f`. Three did
not survive, and none changes a decision:

1. **"`planSession.ts`, `expandItem.ts` and `getPlan.ts` each say approval is _'a
   human decision made in Motir'_."** Only `getPlan.ts` uses that exact phrase.
   `planSession.ts` says _"a decision made in Motir, not on this surface"_ and
   `expandItem.ts` says only _"the ONLY path from a proposal to a work item"_. A
   FOURTH file the card does not name — `app/api/v1/work-items/[key]/expansions/route.ts`
   — carries the phrase verbatim. The corrected list is the table above.
2. **"`docs/decisions/` — grep for the next free ADR number."** The directory is
   slug-named; there are no numbers. Handled in the note at the top.
3. **The MOTIR-2406 quote about unconditionality** is from that CARD, not from
   `promptTemplate.ts`; the module carries the property in its header's purity
   claim instead (_"PURE: a function of its input record only"_). Both are quoted
   above, from where they actually live.

Confirmed as stated: `approvePlan` is the only proposal→row path and re-validates;
`app/api/plans/[id]/approve/route.ts` is session-bound via `getWorkspaceContext()`;
`toolPermissions.ts` records `ai:view_plan` as the decisions' key;
`CLI_TOKEN_GRANT` omits it; `plannerBugHome.ts` resolves a marker to a
title-matched story that `aiWorkItemsService.fileBug` uses; `batchPlan.ts` carries
the frozen-snapshot contract; `program.ts` carries both the `--no-browser`
convention and the `--print` refuse-by-registering precedent; and the
`WHAT_TO_DO.code` step-5 / `outcomeProtocol` contradiction is live in every `code`
prompt.

---

## Consequences

- **The prompt stops being unconditional.** That was a deliberate property; it is
  traded deliberately, and `promptTemplate`'s determinism contract is restated per
  policy rather than dropped.
- **An unattended run can change a plan somebody owns.** Only when the operator
  asks for it, only for a plan anchored to the card the run was refused on, only
  with a scope a dispatched agent's own token does not carry, and — once the
  follow-up lands — never in a project that has turned it off.
- **A run's most valuable output stops evaporating.** The bug it reproduced
  becomes a card; the re-plan it submitted survives the close-out. Both were
  previously prose on a card nobody re-reads.
- **And (Q5) it stops being anonymous.** The card exists AND says which run found
  it, permanently — two `DispatchEventKind` members, written server-side, costing a
  local run nothing it was not already sending.
- **`batch` is untouched in every respect but the two `--disable-*` flags.** Its
  frozen snapshot is the one contract this story must not bend, and the `auto`-only
  scoping of the approval flag is what protects it.

## Consumed by

- **MOTIR-3020** — Q1's parameter shape and Q3's parenting rule, in the prompt.
- **MOTIR-3021** — Q2's surface, scope and bounds B1–B6, and the comment list.
  Its two amendments above (B3's status and B1's address) were both made while
  building, from code that contradicted the text.
- **MOTIR-3022** — Q1's naming, Q4's registration-to-refuse and the contradictory-flag refusal.
- **MOTIR-3023** — Q2's B5 loop obligations and B6.
- **MOTIR-3026 / MOTIR-3027** — the documented protocol, in `motir-core` and in `motir-meta`.
- **MOTIR-3981** — Q5's two event members and the two server-side appends.
- **MOTIR-3982 / MOTIR-3983** — Q5's closing section, in the design and in the surface.
- **MOTIR-4083** — Q6: the tool-call door, the composed WHAT, the one-shot framing and
  the two-part _once_, in the prompt (MOTIR-4172 shipped the `requirement` argument it uses).

## AMENDMENT — a wrong HOW is built through and recorded, and only a broken WHAT stops (MOTIR-8654, 2026-10-15)

> **Amended 2026-10-15 (Story MOTIR-8651 · MOTIR-8655), by the decision page _A run builds
> through a wrong HOW — the discrepancy record_ (MOTIR-8654, approved).** This record's
> opening paragraph says an agent finds _"this card is wrong"_ and that the prompt handles it;
> Q3 files a bug and the prompt says _"Do not improvise"_. Both are **narrowed**: a run asks
> ONE question — is the WHAT (the card's outcome and acceptance criteria) unchanged,
> consistent and reachable by this run alone? **Yes** ⇒ it builds through, and records ONE
> discrepancy (what the plan asked · what was built · why) through `record_run_discrepancy`;
> the server writes one card comment and a pointer-only `discrepancy_recorded` finding on the
> card's open leg (`runDiscrepancyService.recordDiscrepancy`, one per leg). **No** ⇒ it stops
> exactly as above, and only that branch can file a planning bug. Q5's list of server-written
> findings gains a fifth member, `discrepancy_recorded`, and `dispatchEventKindSchema` does
> **not** gain it.
