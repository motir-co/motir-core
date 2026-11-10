# The dispatched path's run-found trigger — the runner reports to a motir-core endpoint, and only a motir-ai plan files a planning bug

**Status:** proposed, rewritten to the reviewer's direction (decision gate `changes_requested`,
2026-09-25) · **MOTIR-6226** (story MOTIR-5544) · read at `motir-core` `origin/main` `e1aeac8ac`
and `origin/parent/MOTIR-5544-run-found-verdict` for the verdict (MOTIR-6225, not yet on main)

**Extends** [`run-findings-protocol.md`](run-findings-protocol.md) **Q3** (_Where a run-filed bug
is parented_), **Q5** (_How the RUN RECORD points at the bug it filed and the plan it submitted_)
and **Q6** (_The submit is a TOOL CALL, and the agent COMPOSES the WHAT_). That file is not edited.

## Context

MOTIR-5544 makes a run that finds its target unbuildable ask one more question: **is the target
still what the last approved plan approved?** The server answers it as a verdict,
`unchanged | changed | no_plan` (`plansService.resolveApprovedShapeVerdict`, MOTIR-6225). Only
`unchanged` blames the planner. On the product path the dispatched agent is kept out of that
question on purpose: **Q3** keeps its bugs out of the planner-bug home, **Q6** has it compose
what is wrong with the CARD and submit once without classifying (_"an agent asked to classify
invents"_), and **Q5** has the SERVER record `plan_submitted` on the run's leg.

The first version of this record gave the question to the shipped planner (motir-ai), read
through an internal route. The reviewer rejected that and set the direction below.

> 1. there's a precondition, the plan needs to be made by motir-ai, the plan made by MCP planner
>    will never fire a planning bug
> 2. the shipped planner -- motir-ai won't be involved in this process. We change the runner
>    prompt to let the runner call an endpoint when stop the run -- unbuildable, the endpoint
>    will collect the data -- the plan, the run target (sent by the runner), why can't not run
>    (sent by the runner) then compose the planning bug, we will debug using those information
>    later

The reviewer then scoped point 1: the MCP-planner exclusion is the PRODUCT's rule, and
**motir-meta's runbook is an exception** — its plan and run procedures are not changed by this
record (below).

Two findings from the first version still hold. They are kept because the direction depends on
them:

- **Planning bugs file into Motir's own planner-bug home, never into the customer's project.**
  motir-ai's `log_planning_bug` files through `lessonService.filePlanningBug` into
  `META_PROJECT_KEY` with `parentKey` `@planner-bug-home` (MOTIR-1460; motir-ai
  `planner-files-tenant-bug.md` §2b: a wrong planning bug is _"a card **we** cancel … Never seen
  by a customer"_). `aiWorkItemsService.filePlannerBug` is `log_bug`'s sink, which files a
  product defect into the job's own project, so it does not serve here.
- **The leg is closed before anything downstream reads it.** `submit_plan_session` returns at
  once, the agent exits, and the CLI settles the leg `replanned` and closes the run
  (`packages/cli/src/dispatchLeg.ts`, `commands/dispatch.ts`). A reader that comes later finds no
  open leg (`dispatchRunCardRepository.findOpenLegForWorkItem` needs `endedAt: null` on a
  `running` run). That is reported separately as MOTIR-6279.

## Decision

### (a) The actor: a motir-core endpoint the runner calls once, when it stops on an unbuildable target

**The dispatched runner calls one new motir-core endpoint at the moment it stops because its
target is unbuildable. The runner sends the target key and why it cannot run it. The server
resolves the plan, reads the verdict, and composes and files the planning bug. motir-ai takes no
part.** Option 1 (the shipped planner reads the verdict and files) is not taken, because the
reviewer directed otherwise. MOTIR-6228's internal route and the motir-ai pass have no job left
to do.

- **Where it lives.** It is an MCP tool on motir-core's `/api/mcp`, working name
  `report_unbuildable_target`, over one new service method. The runner reaches motir-core only
  through that MCP server, and every other step of the card-is-wrong lane is already a tool call.
  Q6 point 1 chose the MCP tool as the door for the same reason. A `/api/v1` mirror is not needed
  because nothing but the runner calls it.
- **Its key: `work_item:edit`.** `CLI_TOKEN_GRANT` (`lib/mcp/toolPermissions.ts`) already carries
  that key, so **the grant is not widened**. `POST /api/v1/dispatch-runs/{id}/events` asserts the
  same key for the same kind of write, which is a run recording what happened on its leg. It is
  deliberately not `ai:view_plan`. The runner reads nothing back: the tool returns an
  acknowledgement only, never the verdict, the plan or a bug key. The service computes the verdict
  beneath `resolveApprovedShapeVerdict`'s `ai:view_plan` assertion, so that gate is not
  laundered: what the gate protects never reaches the caller.
- **Timing fixes the leg.** The runner calls while it is still running, so the leg is open. The
  server resolves it with `findOpenLegForWorkItem` in the caller's own tenant. If there is no open
  leg (a call from outside a dispatch), the server records and files nothing and says so in the
  acknowledgement. MOTIR-6279's late-read problem cannot reach this trigger.

### The precondition: only a plan motir-ai made fires a bug

**The server reads `Plan.authorSource` (`prisma/schema.prisma`, enum `WorkItemPlanningSource`
`native | mcp | manual | api`) on the approving plan. A bug is composed only when it is
`native`.** This field is written by the server and never taken from the caller. `native`
(with `authorHarness: 'Motir'`) is written only on the two paths that hand the tree to motir-ai
to write: `aiGenerationService` (`lib/services/aiGenerationService.ts`) and `aiPlanEditsService`
(expand, augment, replan and contextual submits, plus the cadence watcher). `mcp` is written by
the `create_plan` MCP tool (`lib/mcp/tools/authorPlan.ts`). **A plan with `mcp`, or any value
other than `native`, never fires a bug.** A `null` from before MOTIR-2996 does not fire either.
This is the strict reading, and the reviewer can relax it to `sourceJobId != null`.

**This precondition is the dispatched (product) path's, and motir-meta is an exception.** The
runbook `motir run` plans Motir itself through the MCP (`authorSource: 'mcp'`) and keeps filing
its planning bugs under its own run-found rule (MOTIR-6231, conditional on the same verdict).
**The runbook NEVER calls this endpoint**: it files a planning bug directly, from its own plan
procedure (the re-plan's planning-bug act, `create_work_item` into the planner-bug home). This
record changes nothing in motir-meta's plan or run procedures.

**The verdict (recommended, the reviewer can overrule): file only on `unchanged`.** That is the
story's premise: a target edited after approval (`changed`) or never shaped by a plan
(`no_plan`) is not the planner's defect. The verdict and its diverging revision are recorded on
every arm, on the leg and on the bug when one is filed. The order is: no open leg → nothing;
`no_plan` → record; approving plan not `native` → record; `changed` → record; `native` and
`unchanged` → record and file.

### Which plan, and where the bug lands

**"The plan" is the last approved plan that shaped the target, and the server resolves it.** It
is the verdict's approving plan (the latest `approved` entry of `listPlanHistoryForWorkItem`).
The runner never names a plan.

**There is one destination: Motir's planner-bug home.** A defect in Motir's planner is Motir's
defect in every tenant. The service resolves the system principal (`resolveSystemPrincipal`,
`lib/ai/serviceAuth.ts`) and calls `aiWorkItemsService.fileBug` with
`projectKey: metaProjectKey()` and `parentKey: PLANNER_BUG_HOME_MARKER` (`@planner-bug-home`,
`lib/ai/plannerBugHome.ts`). That call resolves `bugDestinationService.resolvePlannerBug`, and
the bug is filed into the `Bugs / Planning bugs` folder. It is the same in-process pattern
`dlqStandingDepthService.fileOne` already uses to file into the meta project as the system
principal.

**When the tenant is a customer's, no tenant is read from another.** Every read runs in the
caller's own workspace under its own request context: the target, the leg, the plan and the
verdict. Then ONE record is written outward to Motir's project, which is the direction MOTIR-1460
and §2b already allow. No LLM takes part, so sanitizing is a fixed allowlist rather than a
judgement:

- **Motir's own workspace** (the caller's workspace is the system principal's). The bug carries
  everything verbatim.
- **A customer's workspace.** The bug carries only ids, enums, timestamps and field names. It
  carries no titles, no card keys and no runner text. The runner's reason and the plan title stay
  in the customer's tenant, on the leg's finding event. The bug points at them by workspace id
  and leg id.

**What the bug carries:** the plan id and title; the shaping proposal id (the verdict's
`proposalId`); the run target key; the runner's stated reason, verbatim; the verdict, and on
`changed` the diverging revision (id, `changeKind`, `changedKeys`) or the container's child-set
delta; the plan's author triple (`authorSource`, `authorHarness`, `authorModel`); and the
dispatch run id and leg (`DispatchRunCard`) id. In a customer tenant, the title, key and reason
are replaced by the pointer described above.

**Idempotency: one bug per stopped leg, keyed by the `DispatchRunCard` id.** A filing row that is
unique on the leg id is inserted and locked before the create, following the
`job_dlq_standing_filing` pattern. A retried call finds the row and returns its first outcome.

### The prompt change, and why it does not reopen Q3

**In `lib/dispatch/promptTemplate.ts`, `cardIsWrongSteps` gains one call, placed right after
step 3's comment. It is added in both lanes (with and without re-planning), because the lane
changes what the runner does next, not what it found:**

```text
report_unbuildable_target  projectKey: <PROJECT>  targetKey: <KEY>
                           reason: the SAME text as your step-3 comment
```

The prompt tells the runner that the call spends nothing, that it is safe to repeat (the server
keeps one record per run), and that it returns no answer to act on.

**This does not reopen Q3.** The runner still reports only what is wrong with the CARD. That is
the text it already composes for the comment and for Q6's WHAT, and it still never says why the
card was PLANNED that way. The server does the classifying, from the approving plan's author and
from a verdict computed off recorded rows.

### `--auto-approve-replan` changes nothing

The report is made before `submit_plan_session` and does not depend on it. Q4 and Q2's B1 limit
who may APPROVE the plan that follows. They do not limit what a finding records. The verdict is
read against the plan that shaped the target before the refusal, not against the re-plan, so
the filing and the destination are the same with or without the flag.

## Consequences

- motir-core owns trigger 2 on the product path end to end. motir-ai gains nothing, and
  `SHARED_PLANNING_RULES` does not carry this trigger. MOTIR-5544's fourth criterion (the shipped
  home carries the rule) needs re-planning with the story.
- Motir's own tenant plans through the MCP, so its dispatched runs will rarely fire this trigger.
  That is the precondition working as intended, not a gap.
- A customer-tenant bug cannot be fully debugged from Motir's project alone. The reason is read
  in the customer's tenant, under that tenant's access rules.
- **Named as amended, not edited here (`run-findings-protocol.md`):**
  - **Q3, _Why not the planner-bug home_.** Its claim that a dispatched agent cannot produce a
    planning defect through the card-is-wrong branch, and that the home is unreachable, stays
    true of the agent. It no longer holds of the run: the server now files into the home on the
    runner's report.
  - **Q6, _"Run it ONCE" now has two parts_.** It now has three. The report is free and safe to
    repeat, and the submit is still the only act that spends credits and is never retried.
- The comment on `get_approved_shape_verdict` in `lib/mcp/toolPermissions.ts` (on the parent
  branch) says the shipped planner reads the verdict through its internal AI route. That becomes
  false and is corrected by the endpoint's card.

## Consumed by

- **MOTIR-5544**: criterion 3, the dispatched path behaves as this record says. Its body is
  re-planned to this direction.
- **MOTIR-6231** (the runbook's `run.md` condition, motir-meta): unchanged in scope. The
  motir-ai-only precondition does not bind the runbook, which is the stated exception above.
- **New work owed** (to be planned under MOTIR-5544): the endpoint (the MCP tool, the service,
  the leg-keyed filing row and a new `DispatchEventKind` member for the finding); the bug
  composition and allowlist; the `cardIsWrongSteps` prompt change.
- **MOTIR-6232**: re-scoped. Its gate covers the verdict, the runbook door and this endpoint,
  with one case per arm of the precondition and the verdict, instead of MOTIR-6228's route.
- **No longer needed:** **MOTIR-6228** (the internal AI route), **MOTIR-6229**, **MOTIR-6230**
  and **MOTIR-6233** (the motir-ai rule, the pass and its gate).

## Supersedes

None. This record **extends** `run-findings-protocol.md` Q3, Q5 and Q6 and amends the two
clauses named above. motir-ai's `planner-files-tenant-bug.md` §2b and MOTIR-1460 stand
unchanged.

## What this does NOT decide

- **The leg-timing bug MOTIR-6279** (Q5's `plan_submitted` read after the leg closes). This
  trigger avoids it by calling early. It does not fix it.
- **When** a run judges a target unbuildable, and **what counts as a CHANGE**. The existing
  guards own the first, and MOTIR-6225's verdict owns the second.
- **How Motir staff read a customer's verbatim reason** when they debug a customer-tenant bug.
  That is a support-access question, not a filing question.

## AMENDMENT 1 — the report reaches the server in every lane, and Motir's own MCP plans file (MOTIR-8698, 2026-10-15)

**What was wrong.** The record assumed _"The runner reaches motir-core only through that MCP
server"_ with a `CLI_TOKEN_GRANT` token. That held only for a tenant running the agent on their
own machine with a Motir MCP configured. A hosted run's agent and an agent-instance run's agent
hold no Motir token (`AGENT_RUN_WITHHELD_ENV`), and `/api/mcp` refuses a run token
(`lib/mcp/auth.ts`), so step 4 had nothing to land on. A local agent with no Motir MCP had the
same problem. And the precondition _"only a plan motir-ai made fires a bug"_ excluded every one of
Motir's own plans, which are written by `plan.py` over the MCP (`authorSource = mcp`).

**What changes.**

1. **A run door.** `POST /api/v1/dispatch-runs/{id}/unbuildable`, body `{ targetKey, reason }`,
   gated `work_item:edit` and admitted to a run token bound to its own run
   (`lib/hostedRuns/runTokenRoutes.ts`, binding `own_run`). It runs the same service as the MCP
   tool (`runFoundReportService.reportUnbuildableTargetForRun`). The one difference is which leg:
   the leg `targetKey` holds on THIS run, read under the run's lock. Only the run's operator (or
   the run's own credential) may report for it. The answer is the same acknowledgement.
2. **The CLI makes the call, not the agent.** Step 4 of the prompt's STOP branch now tells an agent
   that has `$MOTIR_AGENT_REPORT` to write its reason into that file as `"unbuildable"`. The CLI
   reads it when the agent exits (`runAgent`), and the leg posts the report with the run's own
   credential before any verdict settles the leg (`runDispatchLeg`). The MCP tool stays as the
   fallback for a reader with no such file. One path covers rows 4, 5 and 6, because hosted runs
   and agent-instance runs execute the CLI's own `motir run`.
3. **Motir's own MCP plans file.** The precondition admits `mcp` as well as `native` when the
   target is in the system principal's workspace (Motir's own). Everywhere else it is unchanged: a
   tenant's `mcp` plan, and `manual`, `api` or `null` anywhere, never fire. The reviewer's
   precondition on MOTIR-6226 stands for every tenant.

Nothing about WHERE a bug lands changes. It is always Motir's planner-bug home, filed as the system
principal, and the `customer_workspace` regime and its allowlist are unchanged.

### The rows, as they stand now

| #   | Who runs, and how                                                 | How the report reaches motir-core                                                                     | Planning bug filed?                                                                      |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Motir team, runbook (`motir run` skill, motir-meta `run.md`)      | The runbook reads the verdict and files with `create_work_item` into `@planner-bug-home` (MOTIR-6231) | ✅ into Motir's `Bugs / Planning bugs`                                                   |
| 2   | Motir team, CLI dispatch (`motir run/auto`)                       | The CLI posts the run door with the developer's credential                                            | ✅ for a `native` **or `mcp`** plan, unchanged since approval (`motir_workspace` regime) |
| 3   | Tenant, CLI dispatch on their own machine, agent with a Motir MCP | The CLI posts the run door; the agent may also call the tool (one record per leg)                     | ✅ for a `native` plan, unchanged (`customer_workspace` regime)                          |
| 4   | Tenant, CLI dispatch, agent with no Motir MCP                     | The CLI posts the run door from the agent's `$MOTIR_AGENT_REPORT`                                     | ✅ for a `native` plan, unchanged                                                        |
| 5   | Hosted run (Motir cloud)                                          | The container's CLI posts the run door with the run token                                             | ✅ for a `native` plan, unchanged                                                        |
| 6   | Run inside the user's agent instance (MOTIR-7024)                 | The instance's CLI posts the run door with the run token                                              | ✅ for a `native` plan, unchanged                                                        |

The arms after the call (no open leg, `no_plan`, not admitted, `changed`, no system principal,
admitted and `unchanged`) are the ones in [Decision](#decision), with "not `native`" read as "not
admitted" above.

### What this amendment does NOT decide

- The other MCP calls the prompt asks a hosted or agent-instance agent to make (the STOP branch's
  comment, Planning transition, `append_plan_turn` and `submit_plan_session`, and the build-through's
  `record_run_discrepancy`). They have the same wall and are filed as **MOTIR-8722**.
- `motir next`, which only prints the prompt for a person's own agent. No CLI is around the agent to
  read a report file, so that agent still needs the MCP tool.

## AMENDMENT 2 — the build-through record and the STOP's own writes reach the server too (MOTIR-8722, 2026-10-15)

**What was wrong.** AMENDMENT 1 gave ONE of the agent's Motir calls a run door: the unbuildable
report. Every other call the dispatch prompt names was still an MCP call, so a hosted run's agent
and an agent-instance run's agent (no Motir token, `/api/mcp` refuses a run token) could make none
of them. A build-through left no discrepancy record (only the prompt's _"Discrepancy record
missing"_ line), and a STOP left the card In Progress with no comment, no Planning status and no
re-plan.

**What changes.**

1. **The build-through record.** `POST /api/v1/dispatch-runs/{id}/discrepancy`, body
   `{ key, points }`, runs `runDiscrepancyService.recordDiscrepancy` pinned to the card's leg on
   THIS run. One comment on the card, one `discrepancy_recorded` finding on the leg, one record per
   leg. The agent writes the points into `$MOTIR_AGENT_REPORT` as `"discrepancy"` when the
   `record_run_discrepancy` tool is not available to it, and the CLI posts them when it exits.
2. **The STOP's writes.** `POST /api/v1/dispatch-runs/{id}/stop`, body
   `{ key, comment, toPlanning, requirement? }`, runs `runStopReportService.reportStopForRun`: one
   comment carrying the agent's finding and, with `toPlanning`, the move to Planning in the same
   transaction, with the agent's re-plan brief kept in that comment. The agent writes `"stop"`
   beside `"unbuildable"` when it has no Motir tools; the comment text is the `unbuildable` text.
   The CLI posts it before the leg's verdict, so a card it moved to Planning settles the leg as
   `replanned`.
3. Both doors are `work_item:edit`, admitted to a run token for its own run only (`own_run` in
   `lib/hostedRuns/runTokenRoutes.ts`), and refuse a card that is not an open leg of the run.

**What does NOT change, and why: the re-plan is not submitted from a run's credential.** The
card's acceptance allowed either a submitted re-plan or a prompt that says what to do instead.
This amendment takes the second for the submit, and only for the submit. A run's credential holds
no `ai:*` key by decision (`HOSTED_RUN_TOKEN_GRANT`: _"a run token can neither author nor read a
plan"_; `permission-inventory.md` R75 refuses _"every plan or AI route"_ by name), and submitting
is the act that spends the owner's AI credits. Granting it would widen what every hosted and
agent-instance run can spend unattended, which is a decision for the owner of that grant, not a
side effect of a bug fix. So on these lanes the card goes to Planning, out of the pickable set,
with the finding and the brief on it, and the comment and the prompt both say the re-plan was not
submitted. A person submits it from the card. An agent that has the Motir tools (a local run with
a Motir MCP) still makes every STOP call itself, the submit included.

| Lane                                 | Build-through record           | STOP: comment and Planning     | STOP: re-plan submitted                          |
| ------------------------------------ | ------------------------------ | ------------------------------ | ------------------------------------------------ |
| Local run, agent with a Motir MCP    | the agent's tool call          | the agent's tool calls         | ✅ the agent's `submit_plan_session`             |
| Local run, agent with no Motir MCP   | the CLI posts `…/discrepancy`  | the CLI posts `…/stop`         | ❌ the brief is on the card; a person submits it |
| Hosted run                           | the container's CLI, run token | the container's CLI, run token | ❌ as above: the run token holds no `ai:*` key   |
| Run inside the user's agent instance | the instance's CLI, run token  | the instance's CLI, run token  | ❌ as above                                      |

## AMENDMENT 3 — the file is the route only when the client says it posts it (MOTIR-8810, 2026-10-16)

**What was wrong.** AMENDMENTS 1 and 2 moved three reports into `$MOTIR_AGENT_REPORT`
(`unbuildable`, `discrepancy`, `stop`) and made the CLI post them. The server half deploys on
merge; the CLI half reaches people only in a release. When MOTIR-8698 deployed, the only CLI
anyone could install was `@motir/cli` 0.12.0 (published 2026-10-04), which reads `model` from
that file and nothing else. So the deployed prompt told every agent with the file to put its
unbuildable reason there instead of calling `report_unbuildable_target`, and the report was
lost: no `unbuildable_reported` event and no planning bug (reproduced on MOTIR-8806, two runs at
12:24 and 12:27 UTC, 2026-10-16; the same card with a CLI built from `main` filed MOTIR-8808).

**What changes.** `GET /api/v1/work-items/{key}/dispatch-prompt` takes an optional
`agentReport=1`, the client's declaration that it posts all three. The CLI sends it on every
prompt read. Without it the STOP branch's step 4 is the `report_unbuildable_target` call it was
before AMENDMENT 1, and the two _NO MOTIR TOOLS?_ file routes are not rendered, because the
runner would drop them. The MCP `dispatch_prompt` tool never declares it, because nobody reading
a prompt through it is the runner that would post, so the REST and MCP transports still render
the same text for the same card.

**Why a declaration and not the version header.** `x-motir-client-version` already exists, but a
CLI built from `main` reports the same version string as the release it is ahead of (both read
`0.12.0` at `ed2a90c87`), so a version floor could not tell the CLI that posts from the one that
does not. The declaration is sent only by code that does the posting.

**The rule this leaves.** A prompt change that routes work through the runner is a contract with
a CLI release that ships after the server. It renders behind the client's own declaration, never
on the assumption that the CLI on `main` is the CLI people run.

## AMENDMENT 4 — the pull request link and How to test reach the server too (MOTIR-10877, 2026-11-10)

**What was wrong.** AMENDMENTS 1 to 3 gave the run doors to what an agent _reports_. The two calls
that _deliver_ a card were still MCP-only: `link_pull_request` and `publish_test_instructions`. An
agent with no Motir tools (a hosted run, or a run inside the user's agent instance) opened its
pull request and could make neither call. The CLI then moved the card to Implemented anyway. The
CI watch found no delivery to watch (`ci_verdict` `nothing`), no How to test was published, and
the card sat at Implemented linked to nothing, so its merge would never close it.

**What changes.**

1. **The CLI links the pull request itself**, in the shared dispatch leg (`runDelivery.ts`), after
   the agent exits and before any caller moves the card. For each repository it takes the URL the
   agent wrote into `$MOTIR_AGENT_REPORT` as `"pullRequests"`, or else the work branch's open pull
   request (`gh pr view <branch>`, through the run's own `gh` shim and git credential), and links
   it through `POST /api/v1/work-items/{key}/pull-requests`, the door the session close-out
   already uses. A pull request the card already delivers (an agent _with_ the tools linked it)
   counts as linked with no second call. Each link is a `delivery_linked` event on the leg.
2. **The CLI publishes the How to test** the agent wrote as `"howToTest"` (`bodyMd`, and
   `previewPath` when there is one) through a new run door,
   `POST /api/v1/dispatch-runs/{id}/how-to-test` (`work_item:edit`, `own_run`). It is the same
   record `publish_test_instructions` writes, attributed to THIS run and refused unless the run is
   the caller's own, still running, and holds the card as an open leg. The CLI sends each
   repository's pushed head commit, which it reads itself (`headRefOid`, else `git ls-remote`)
   rather than taking from the agent.
3. **The order is link, then How to test, then Implemented**, so the transition and the CI watch
   that follow read a linked card.
4. **A run that pushed work but could link no pull request does not report a clean
   Implemented.** The card stays In Progress, the leg settles `failed` with a
   `no_linked_pull_request` reason naming each branch, the run closes `halted`, and `motir run`
   exits 1. `motir batch` records the card as failed with `no pull request linked: <branch>`.
5. **The prompt names the file route only where it is true** (AMENDMENT 3's rule): behind a new
   declaration, `agentReportDelivery=1`, beside `agentReport=1`; only for a card that opens its own
   pull request (no session branch, whose pull request the loop links); and only for a card that
   is its own run target (a scoped run's child publishes no How to test). The MCP
   `dispatch_prompt` tool never declares it.

| Lane                                 | Pull request link                   | How to test                             |
| ------------------------------------ | ----------------------------------- | --------------------------------------- |
| Local run, agent with a Motir MCP    | the agent's `link_pull_request`     | the agent's `publish_test_instructions` |
| Local run, agent with no Motir MCP   | the CLI, from the file or `gh`      | the CLI posts `…/how-to-test`           |
| Hosted run                           | the container's CLI, run credential | the container's CLI, run token          |
| Run inside the user's agent instance | the instance's CLI, run credential  | the instance's CLI, run token           |

## AMENDMENT 5 — a partial delivery is not Implemented either (MOTIR-10888, 2026-11-10)

**What was wrong.** AMENDMENT 4's rule 4 held the card only when the run linked NO pull request.
On a card in two repositories where one pull request linked and the other repository's pushed
branch had none (`gh pr view` found nothing), the unlinked branch was dropped, the card went to
Implemented, and nothing on the leg or the run named the repository. Motir completes a card on
its LINKED pull requests alone (`changeRequestStatusSync.ts`, MOTIR-10135), so the first merge
would close the card with the second repository's work still open, and the CI watch could not see
that work.

**What changes.**

1. **Each unlinked repository says whether its work is on its remote** (`pushed`): its work branch
   answers `git ls-remote`, a remote branch names the card, or a pull request for it was found.
2. **With at least one pull request linked, a pushed repository with no linked pull request keeps
   the card from Implemented**, exactly as rule 4 does with none linked: the card stays In
   Progress, the leg settles `failed` with an `unlinked_pull_request` reason naming each such
   branch beside the pull requests that did link (`linked`), the run closes `halted`, and
   `motir run` exits 1. The CLI prints the branches to link by hand. `motir batch` records the card
   failed with `no pull request linked: <branch>`.
3. **A listed repository the run pushed NOTHING to holds nothing back.** Runs routinely find one
   listed repository needs no change, which is why MOTIR-10135 stopped reading the repository set
   as a promise. The card reaches Implemented, and its `card_settled` event carries the repository
   under `unlinked` with `pushed: false`, so the run says it was left alone rather than forgotten.
