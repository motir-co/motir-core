# The DISPATCH RUN record — one run over a SET of cards

**Status:** accepted · **Story MOTIR-1789 · MOTIR-1790**

## Context

Motir's third pillar is agent orchestration, and the product goes silent at
exactly the moment it should be demonstrating it. A person types `motir run
MOTIR-1789`, twelve cards flip to _In Progress_ in one transaction, and Motir
shows a board that cannot say which card is being worked, which were skipped and
why, how far along the run is, or that it stopped forty minutes ago because an
agent refused a card and submitted a re-plan. All of that exists — in a terminal,
on one machine, until the window closes.

MOTIR-1789 makes a run a first-class object. Before any table exists, four
questions have to be settled, and they are settled in ONE document because they
are not independent: the cardinality decides what the event stream is keyed by,
the vocabulary decides what a log body would even attach to, and the privacy
stance decides whether bodies are stored at all.

> **⚠️ EVERY ENUMERATION BELOW WAS READ OFF `origin/main` AT `435bce9bd`**
> (2026-08-29), from `packages/cli/src/autoLoop.ts`, `batchPlan.ts`,
> `scopedRun.ts`, `ciWatch.ts`, `dispatchLeg.ts`, `commands/dispatch.ts` and
> `lib/services/scopeClaimService.ts`. It is a reading of shipped code, not a
> design. A later reader comparing this document to the CLI should diff against
> that ref: anything the CLI has grown since is an addition to weigh, not a
> discrepancy to resolve in this document's favour.

---

## Q1 · CARDINALITY — a run is a SET, and one card is its degenerate case

**Decision: a run HEADER plus one LEG per card, not a row per card-execution.**

This is a reading of shipped code rather than a preference:

- `motir run <story|sprint>` claims **every member** of the scope in ONE atomic
  call (`POST /api/v1/scope-claims` → `scopeClaimService.claimScope`) and works
  them in intra-scope dependency order — `renderClaimedScope` prints the ready
  split _and_ the "also claimed, not startable yet" group; `orderClaimedSet`
  topologically sorts them.
- `motir batch` FREEZES a `Snapshot` of `taken` plus `skipped`, with a reason for
  each, **before it dispatches anything** (`batchPlan.ts`).
- `motir auto` holds no plan and asks for one item per iteration, but it is still
  ONE run with one `runId`, one `StopReason` and one set of session pull requests
  (`AutoSummary`).

So the object the product must be able to render is: _this run, over these cards,
in this order, of which these were skipped for these reasons, and it stopped for
that reason._

**The rejected alternative — one run row per card, correlated by a shared id.**
It has no home for the SET (a skipped card belongs to no executed card's row), no
home for the stop reason, and it turns _"show me this run"_ into a query whose
answer is "the cards the run got round to" — a weaker and more misleading answer
than the one the set gives, and one that loses the skips entirely.

### The three sub-answers

1. **A SKIPPED card gets a leg. Yes.** The skip and its reason is the single most
   useful thing on a run page and the only place it can live; `Snapshot.skipped`
   and `AutoSummary.skipped` already carry it in the terminal, and reconstructing
   it later is impossible because nothing else records a card the run chose not
   to take.
2. **The ORDER is STORED.** `DispatchRunCard.position` is written when the run
   opens (or when a card is appended, for `auto`, which discovers its set one
   card at a time). A client must never re-derive dispatch order from the
   dependency graph: the run's order is a fact about what the run DID, and the
   graph it was computed from moves underneath it.
3. **A LEG is keyed `@@unique([dispatchRunId, workItemId])`.** One leg per card
   per run. A card retried inside one run updates its leg; a card worked by a
   second run gets a leg on that run.

---

## Q2 · The EVENT VOCABULARY — derived from the shipped lifecycle

Every enum here is **CLOSED**, and every renderer must be total over it (a
`switch` with no `default` arm, so adding a member is a type error at every
render site rather than a blank cell in production).

### `DispatchCommand` — which command opened the run

`next` · `run` · `run_scope` · `batch` · `auto`

Five, because `motir run <key>` and `motir run <scope>` are the same word and
genuinely different runs: one claims a card, the other claims a container and
every leaf under it (`classifyScopeTarget`). A reader who cannot tell them apart
cannot explain why one run has eleven legs.

### `DispatchRunOrigin` — who executed it

`local` · `hosted`

`local` is a BYOK run on the operator's own machine. `hosted` is MOTIR-690's
container. **This discriminator is why there is one table and not two**: 9.1.7
becomes a second WRITER of the ingest operations rather than the owner of a
second record.

### `DispatchRunStatus` — the header's own state

`running` · `succeeded` · `failed` · `cancelled` · `timed_out`

Mirrors `JobRunStatus`, the run ledger this repository already has. `timed_out`
is what the abandoned-run reap writes (below); it is not something a CLI reports
about itself, because a process that died cannot.

### `DispatchStopReason` — why the run ended

`drained` · `completed` · `max` · `halted` · `interrupted` · `replanned` ·
`gated` · `abandoned`

The union of `autoLoop.ts`'s `StopReason` (`drained` · `max` · `halted` ·
`interrupted` · `replanned`) and `batchPlan.ts`'s `BatchStopReason` (`completed`
· `max` · `halted` · `interrupted` · `gated`), plus one value neither can report:

- **`completed`** also serves a single-card `next` / `run`, which has no loop —
  the run ends when its one leg does.
- **`abandoned`** is written by the reap, never by a client. A run whose process
  was killed leaves `running` for ever otherwise, and a `running` run that is not
  running is the state that makes every other number on the page a lie.

- **`gated`** was `motir batch`'s between-iteration stop. Since AMENDMENT 5 it is
  ALSO the stop of a parent run whose remaining children wait on an awaiting
  approval gate, and the close records which gates held it.

`replanned` stays distinct from `halted` for the reason `autoLoop.ts` gives: a
re-plan is a CORRECT outcome that exits 0, and a run summary that calls it a
failure teaches the operator to ignore failures.

### `DispatchCardDisposition` — the LEG's terminal state

`queued` · `running` · `integrated` · `implemented` · `failed` · `replanned` ·
`skipped` · `not_reached`

`integrated` / `implemented` / `failed` / `replanned` are `autoLoop.ts`'s
`AutoOutcome` verbatim (`batchPlan.ts`'s `BatchOutcome` is the two-member subset
`implemented` | `failed`). `not_reached` is `BatchSummary.notReached` — a card
the snapshot took and the run never got to (`--max`, a halt, a Ctrl-C), which is
neither a skip (nothing decided to leave it out) nor a failure (nothing ran).
`queued` and `running` are the non-terminal pair a live surface renders.

**This enum is worth naming separately from the event stream** because it is what
a ROW renders. A client deriving a row's state by folding the event log would
re-implement the lifecycle in the browser, and would be wrong in exactly the
window where the surface matters — while the run is in flight.

### `DispatchSkipReason` — non-null exactly when `disposition = skipped`

`needs_planning` · `needs_human` · `claim_refused` · `blocked_in_scope` ·
`integrated_dep` · `replan_submitted` · `checkout_unavailable`

The union of `SkipRecord.reason` (`needs_planning` · `needs_human` ·
`claim_refused` · `blocked_in_scope`) and `SnapshotSkipReason` (which adds
`integrated_dep` from `classifySnapshotItem`, plus `replan_submitted` and
`checkout_unavailable`).

> A `replan_submitted` skip and a `replanned` disposition are different facts and
> both are kept: `batch` records the card as SKIPPED because its snapshot never
> implemented it, while `auto` records it as a card whose agent RAN and refused.
> Folding them would lose which of the two happened.

### `DispatchEventKind` — the ordered stream

RUN-scoped (`dispatchRunCardId` is null):

| kind              | emitted when                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `run_opened`      | the command starts — its flags, scope label, agent and model                                                                       |
| `scope_claimed`   | a scope claim returned, with its typed outcome (`claimed` · `mine` · `taken` · `not_claimable` · `wrong_shape` · `not_finishable`) |
| `snapshot_frozen` | `motir batch` froze its plan: how many taken, how many skipped                                                                     |
| `session_pr`      | one repository's session pull request closed out, with its `PrReport.outcome` (`opened` · `existing` · `failed` · `empty`)         |
| `plan_approved`   | `--auto-approve-replan` approved a plan (`ApprovalRecord`)                                                                         |
| `run_closed`      | the stop reason                                                                                                                    |

CARD-scoped (`dispatchRunCardId` set):

| kind              | emitted when                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `card_claimed`    | `todo → in_progress` took, or was refused                                                                                               |
| `card_skipped`    | the leg was decided without dispatching, with its skip reason                                                                           |
| `checkout_ready`  | the repository checkouts were materialized, or could not be                                                                             |
| `prompt_issued`   | the server-generated prompt was fetched and delivered                                                                                   |
| `agent_started`   | the agent process spawned                                                                                                               |
| `agent_exited`    | it exited — exit code, signal, self-reported model                                                                                      |
| `leg_verdict`     | `dispatchLeg.ts`'s `DispatchLegVerdict` (`checkout_unavailable` · `agent_failed` · `replan_submitted` · `nothing_pushed` · `succeeded`) |
| `delivery_linked` | a pull request was opened and linked, per repository                                                                                    |
| `ci_verdict`      | the watch's verdict (`green` · `red` · `pending` · `nothing`)                                                                           |
| `ci_fix_attempt`  | one fixing iteration, with its attempt number                                                                                           |
| `ci_gave_up`      | `CiWatchOutcome` `gave_up` / `fix_failed`                                                                                               |
| `card_settled`    | the leg reached its terminal disposition                                                                                                |
| `log`             | an opt-in log body (Q4)                                                                                                                 |

> **⚠️ Twenty-one since MOTIR-3980.** `bug_filed` and `plan_submitted` join the
> CARD-scoped half — see AMENDMENT 1, which also explains why they are the only two
> members in this enum the CLI does not write.

**Nineteen values, and the split is the point.** A RUN-scoped event is one the
whole run owns; a CARD-scoped event hangs off a leg. The nullable
`dispatchRunCardId` expresses both without a second table, and the surface reads
one stream to render either.

> **⚠️ `ci_verdict` and `ci_fix_attempt` RECORD what the run observed; they are
> not the card's CI state.** The card's CI state is the delivery set's, derived in
> one place by `derivePrCiState` (Q3). The run says _"at 14:31 this run saw red
> and started fix 2 of 5"_, which is a fact about the run and exists nowhere else.

---

## Q3 · What the record does NOT own — three boundaries, all of them live

### 1. Pull requests and CI belong to the DELIVERY SET

MOTIR-3655 shipped `work_item_delivery` — every pull request that delivers a
card, with its repository — and MOTIR-3697 published it on the DTO and in v1 with
its `ci` verdict from `derivePrCiState`.

**No `prUrl`, no pull-request number, no CI verdict column on any of the three
models — ever.** A copy on the run row is a second source of truth for a fact that
already has one, and a second CI derivation drifts from the pill a person reads on
the same card. The run's EVENTS may record that a pull request was opened; the run's
SURFACES read the delivery set.

### 2. The work item's STATUS belongs to the CLI

Closing a run does not transition a card. The CLI already owns every transition,
and the CI-green → `in_review` promotion is server-side (MOTIR-2999). A second
status writer is a duplicate write path, and the two would disagree first in the
window a run surface exists to make legible.

**No work-item status column, and no status write from the ingest operations.**

### 3. Tokens, usage and cost never cross the open-core boundary

They belong to `motir-ai`'s metering record (9.1.6, which generalizes today's
`PlanningRun`), correlated by run id. **Not "not yet":** a BYOK-local run never
touches the gateway and has no metering row at all, so a cost column here would
be null for the only kind of run that exists today and would quietly become a
second billing store the moment hosted execution lands.

**No usage, token, credit or cost column — ever.**

> These three are asserted by a test over the generated Prisma client's FIELD
> NAMES, not by review (MOTIR-1791). A boundary nobody can violate by accident is
> the only kind that survives two epics.

### The NAME — `DispatchRun`, and why it is not `AgentRun`

The models are **`DispatchRun` / `DispatchRunCard` / `DispatchRunEvent`**
(`dispatch_run` / `dispatch_run_card` / `dispatch_run_event`).

An earlier decomposition of MOTIR-1789 named them `AgentRun`, documented at
length that the name already meant something else, and adopted it anyway
(MOTIR-1801, MOTIR-3890). Since then `JobRun` shipped — the Postgres job engine's
own ledger, with `JobStep`, `JobEvent`, `JobRunDlq` and `JobQueueRun` beside it —
so `AgentRun` would now be a THIRD "run" noun inside one schema file, beside a
FOURTH of the same name across the open-core boundary in `motir-ai`.

_Dispatch_ is the word this codebase already uses for exactly this thing:
`dispatch-prompt`, `dispatchLeg.ts`, `DispatchRecord`, `DispatchItem`,
`dispatch-prompt-assembly.md`.

**And it is NOT a `JobRun`.** `JobRun` records one invocation of a server-side
background job on Motir's own infrastructure. `DispatchRun` records one
invocation of a Motir CLI command on somebody else's machine, which Motir never
executes and only ever hears about. The schema comment says this, both ways.

> **Naming a hazard is not removing one.** That is the whole lesson of the first
> attempt, and it is why this section is a decision rather than a note.

---

## Q4 · The PRIVACY boundary — what a LOCAL run may send

A hosted run happens on Motir's own infrastructure, so streaming its full log is
uncontroversial — that is what 9.1.7 assumes. A **BYOK-local** run executes on the
user's machine, against their private checkout, under their own key. Its log
carries file paths, source excerpts, error output, and possibly environment
secrets.

**Rung 1 is silent, and that silence is itself evidence.** Devin, Google Jules,
OpenAI Codex cloud and the GitHub Copilot coding agent are hosted-only, so none of
them faces this boundary at all. The nearest real precedent is a self-hosted
GitHub Actions runner, which streams its full log — but it does so because the
runner is **enrolled INTO** the service, an analogy that has to be argued for
rather than assumed, and one Motir cannot make: nobody enrols a laptop.

### The decision: LIFECYCLE ALWAYS, LOG BODY OPT-IN, DEFAULT OFF

**What is ALWAYS sent** — the lifecycle metadata this document enumerates: the
command and its flags, the scope label, the agent name and model, each card's
key, its disposition and skip reason, exit codes, CI verdicts, timestamps, and the
stop reason.

**What is NEVER sent unless the operator turns it on** — any body: log lines,
file paths beyond a repository NAME, source excerpts, diffs, prompts, agent
output.

**Why option 2 and not the other two:**

- **Rung 2 already licenses metadata-without-content.**
  `implementationSource` / `implementationHarness` / `implementationModel` ship on
  `WorkItem` today: Motir already records _how_ work was done without recording
  what the agent read. This decision is the same line, one object out.
- **Lifecycle alone (option 1) under-delivers the story.** A failed run whose only
  artifact is `disposition: failed` sends the operator back to the terminal, and
  the failure tail is where a run surface earns its place.
- **Default-on (option 3) takes private content by default from a machine nobody
  enrolled.** It is also the one choice that cannot be walked back: content sent
  is content sent.

### The three things settled alongside it

1. **Log bodies are EVENT ROWS, not one appended blob.** `DispatchRunEvent.body`,
   on `kind: 'log'` events, ordered by the same `seq` as everything else. A blob
   cannot be tailed, cannot be resumed from a cursor, and cannot be interleaved
   with the lifecycle events it explains — and the surface's whole job is to show
   them in one stream. The bound is at INGEST: a body over **16 KiB** is refused
   at the operation (not truncated — a silently shortened log is worse than an
   absent one), and a run over **5 000** events stops accepting them and records
   that it did.
2. **RETENTION: the run and its lifecycle events are kept indefinitely; a LOG
   BODY expires after 30 DAYS.** Run history is small and is the product's
   memory of what it did; log bodies are the only unbounded, private and
   low-half-life part of it. **The sweep that nulls expired bodies, and the reap
   that closes an abandoned `running` run as `timed_out` / `abandoned`, are
   MOTIR-1792's** — one registered job beside the service that owns the terminal
   write. They are not deferred to nobody: MOTIR-1792 is the card, and this
   sentence is its specification.
3. **REDACTION: the opt-in IS the whole control. There is no scrubber.** A
   half-built scrubber is worse than none, because it converts _"this may contain
   secrets"_ into _"this has been cleaned"_ — and a regex over agent output cannot
   make the second sentence true. If a scrubber is ever wanted it is its own
   decision, with its own evidence; the honest control today is a switch the
   operator holds.

### The control, and where it lives

`motir <command> --report-log` turns bodies on for one run;
`reportLogBodies: true` in the user config turns them on persistently. **There is
no server-side setting**, deliberately: the machine that holds the content is the
machine that decides whether it leaves, and a workspace admin flipping a switch
that exfiltrates somebody else's laptop is the exact shape this decision refuses.

**The copy, verbatim, for the CLI and the surface to quote** (MOTIR-3894
publishes it; the run surfaces show the second paragraph where a run has no
bodies):

> Motir records what your run DID — the command, the cards it worked, what
> happened to each, and why it stopped. That is all it sends by default.
>
> Your agent's output stays on your machine. Log lines, file contents, diffs and
> prompts are only sent if you pass `--report-log` (or set `reportLogBodies` in
> your config), and they are deleted after 30 days.

---

## What this decision obliges each dependent to build

One line each, so five dependents inherit a settled contract rather than a
question:

- **MOTIR-1791 (schema)** — the three models and the seven enums exactly as named
  above; `position` on the leg, `seq` on the event, a nullable
  `dispatchRunCardId`, `origin` discriminating `local` from `hosted`; and NO
  column naming a pull request, a CI state, a status, a token, a credit or a
  cost, asserted over the generated client's field names.
- **MOTIR-1792 (service + `/api/v1` ingest)** — open-with-the-SET, append-events,
  close; the read-derived terminal guard under `FOR UPDATE`; the 16 KiB / 5 000
  ingest caps; and the retention sweep + abandoned-run reap named in Q4.2.
- **MOTIR-1793 (read + SSE)** — the run WITH its card set, a card's run history,
  and a stream resumable from `seq`; it READS the delivery set for pull requests
  and CI rather than any column of its own.
- **MOTIR-1794 (CLI reporter)** — one reporter for all five commands, emitting the
  vocabulary above; bodies only under `--report-log`; and best-effort throughout
  — reporting may never fail a dispatch, move a status, or change an exit code.
- **MOTIR-1795 / MOTIR-3893 (designs)** — a tone vocabulary total over
  `DispatchRunStatus` and `DispatchCardDisposition`, a skip that shows its
  reason, a stop reason that is always rendered, and a visible statement of the
  privacy stance where a run carries no bodies.
- **MOTIR-3894 (docs)** — `docs/cli.md`, `motir help`, and the privacy copy
  above, verbatim.

## Does this need a user-facing control the designs must draw?

**Yes, one, and it is not a new surface.** `--report-log` is a CLI flag and a
config key; nothing in the app switches it. What the SURFACES owe is the
statement — a run that carries no bodies says so, in place of an empty log
panel, and links to the docs card's copy. Both design cards are `blocked_by` this
decision, so the answer reaches them; neither needs a design amendment beyond
including that state in its state set.

## Consequences

- One table serves the local and hosted writers, so 9.1.7 adds a writer rather
  than a record, and 9.1.8 becomes the HOSTED MODE of these surfaces rather than a
  second run UI.
- The run surfaces are a JOIN of two owners: the run says what happened, the
  delivery set says what shipped. Two screens can never disagree about whether
  work landed, because only one of them holds the answer.
- The default-off log body means the first thing many operators see is a run with
  no tail. That is the accepted cost of the boundary, and it is why the surface
  states the reason rather than rendering an empty box.

---

## AMENDMENT 1 — a finding gets an EVENT, and the SERVER writes it (MOTIR-3980, 2026-08-30)

`run-findings-protocol.md` **Q5** is the decision; this records what it changes here.
Q2's vocabulary gains two CARD-scoped members and nothing else moves.

| kind             | scope | emitted when                                                  | `data`                       |
| ---------------- | ----- | ------------------------------------------------------------- | ---------------------------- |
| `bug_filed`      | CARD  | a `kind: 'bug'` work item was created while this leg was open | `{ key, workItemId, title }` |
| `plan_submitted` | CARD  | a plan-change job produced a plan while this leg was open     | `{ planId, proposalCount }`  |

`plan_approved` is untouched, keeps its `ApprovalRecord` and stays RUN-scoped: it is
a fact about the loop's own action, not about a leg's work.

**These two are the only members of this enum a CLI reporter never emits.** Every
other kind is written by the run's own writer as it does the thing; these two are
appended by the SERVICE that performs the write — `create_work_item`'s and the
plan-change job's — because the ids exist only there. The CLI cannot report them:
they come back on the dispatched agent's stdout, which the loop streams to the
terminal and never captures (`plansService.approvePlanForWorkItem`'s comment says
so, about the plan id exactly). Q5 rejects both remedies — scraping that output, or
a second read whose answer the caller then supplies — on the argument Q2 of the
findings ADR already used to bound the approve entrance.

So `DispatchRunReporter` does NOT grow two methods. **Q4's boundary is unmoved:**
both events are lifecycle, both are written from rows the server already holds, and
a BYOK-local run sends no additional byte to produce either. `body` stays null on
both, and `--report-log` gates neither.

The append is best-effort and never fails the write that triggered it, and no open
leg means no event — a bug filed in the app or a plan submitted from the
project-wide panel belongs to no run, and silence is the correct record.

Q3's boundaries hold: the event is a POINTER plus the one label a not-yet-loaded
row needs. The finding's copy stays the live row's, for the same reason the card's
status stays the CLI's — a record that froze a title would keep showing it after
triage rewrote it, while its immutability claimed it was current.

---

## AMENDMENT 2 — run liveness (MOTIR-6525, 2026-09-27)

[`run-death-keeps-work.md`](run-death-keeps-work.md) **§2** is the decision; this records
what it adds here. **Nothing above is contradicted** — the record gains a way to tell a
run that is working from one that has died, and every boundary in Q3 stands.

- **A LOCAL run heartbeats every 60 seconds** while it is open, onto its own
  `DispatchRun` (`lastHeartbeatAt`).
- **The lapse window is 5 minutes** — five missed heartbeats. A local run silent that
  long is DEAD: one late report is never read as a death, and a run that is really gone
  is known within minutes rather than the 12 hours the age reap took.
- **A lapsed local run is closed `abandoned`** (run status `timed_out`, as the age reap
  already writes), **and closing it writes no card status.** Q3 §2 — _"The work item's
  STATUS belongs to the CLI"_ — holds unchanged: the card keeps the status the work left
  it at, and the _run died_ marker is what makes that state legible.
- **A HOSTED run sends no heartbeat. Its liveness is its SUPERVISION** — the server-side
  chain that polls the container, the 15-minute stall, and a lost chain, all of which
  end it through the hosted end path (`hosted-agent-run.md` §5, as amended).
- **A run opened by a CLI too old to heartbeat** keeps the existing 12-hour age reap and
  is never marked dead before then.

Liveness is a timestamp and a rule, read when it is needed. Nothing is written when a run
"becomes" dead, and no status, event kind or workflow state is added.

See [`run-death-keeps-work.md`](run-death-keeps-work.md) for the decision and what it
rejected.

## AMENDMENT 4 — every LEG records the model that ran it (MOTIR-7502, 2026-10-03)

[`agent-reported-runs.md`](agent-reported-runs.md) is this record's AMENDMENT 3. This one
adds one column to the LEG and changes nothing above: Q1's set, Q2's enums, Q3's three
boundaries and Q4's privacy rule all stand.

- **The column.** `DispatchRunCard.model` (`dispatch_run_card.model`, nullable text) is
  the agent's **SELF-REPORTED** model for that leg — the `MOTIR_AGENT_REPORT` file the
  agent writes, read by the CLI's `readAgentReport` (MOTIR-2419). Null when the agent
  reported none. **It is never inferred**: not from the agent name, not from the profile,
  not from the run's `model`. An empty record is honest; a guessed one is not.
- **Its one producer is the `agent_exited` event that names the leg.** The append takes
  the event's TOP-LEVEL `model` when present, else its `data.model` — the shape every CLI
  since MOTIR-2419 already sends, so an installed CLI fills the column without upgrading.
  Top-level wins when both are present. The value is written onto the leg in the same
  transaction as the event and its `exitCode`, the path `exitCode` already takes.
- **One validity rule, in one place:** `normalizeReportedModel`
  (`lib/dispatchRuns/reportedModel.ts`) — a string, trimmed, non-blank, at most 200
  characters, else null. It restates the CLI's own rule (`MAX_MODEL_LENGTH` in
  `packages/cli/src/agentRun.ts`) on the server, because the server does not trust the
  wire. The back-fill migration (MOTIR-7503) mirrors it in SQL and cites it.
- **Nothing else writes it.** A null result writes nothing: an exit with no report never
  erases a model the leg already holds. No other event kind writes it, and a `model` on
  any other kind is **refused** (`DISPATCH_RUN_EVENT_MODEL_NOT_ALLOWED`, 422) rather than
  dropped, with nothing in that batch written. The server never fills it from its own
  inference.
- **Legs written before the writer deployed** are back-filled once, by a forward-only
  migration, from their latest `agent_exited` event's `data.model` under the same rule,
  only where the column is still null (MOTIR-7503).
- **THE READ RULE: the leg's `model`, else the run's `model`.** The run-level
  `DispatchRun.model` is what a hosted or instance start sets, and what an agent-reported
  run (AMENDMENT 3) opens with. A CLI leg is more specific than its run, because one run
  can hold legs worked by different models, so the CLI sets no run-level model. A reader
  asking "which model ran this item" takes the leg's and falls back to the run's.
- **Q3 §3 holds.** A model name is an identifier, not usage: no token, credit or cost
  column is added, here or anywhere in `motir-core`.

The two reads that carry a leg — `GET /api/v1/dispatch-runs/{id}` (`cards[].model`) and the
browser's run DTO (`DispatchRunCardDto.model`) — return it. Nothing renders it yet;
showing and comparing models across runs belongs to the reporting work that reads this
column.

## AMENDMENT 5 — `gated` is a parent run stopped at an approval gate, and the close names the gates (MOTIR-7703, 2026-10-07)

Story [MOTIR-7701](motir:cmuxemwju005vhvshdxfzq38v). Q2 defined `gated` as `motir batch`'s
between-iteration stop and nothing else. That left a parent run that ended because every
remaining child waited on a person's approval with two wrong words: the runbook closed it
`halted` (a _failed_ run, read as **Run died** and listed on To fix), and the CLI's scoped drain
closed it `drained` (indistinguishable from running out of work). This amends the definition:

- **`gated` is ALSO the stop of a run whose remaining work waits on an awaiting approval gate** —
  a parent run's design, decision, choice, confirmation or manual-work stopper still undecided at
  its final re-read. It stays `succeeded` (`statusForStopReason` is unchanged), which is what keeps
  it out of the died statuses. A stop at such a gate is never `halted`.
- **The close DERIVES the held gates and records them** in `dispatch_run_held_gate` — one row per
  gate `{ runId, gateId, workItemId, kind }`, unique on `(runId, gateId)`. On a `gated` close, in
  the close's own transaction and after its locks, it reads every `awaiting` gate of the kinds
  `design_result`, `decision_approval`, `decision_choice`, `decision_confirmation` and `manual_work`
  on the run's legs and, for a run pointed at a container, on that container's children. Every door
  closes through `closeWithin`, so the ingest close, `close_work_item_run` and the hosted end all
  write the same record, and **no reporter supplies a gate**.
- **A `gated` close that finds no awaiting gate** (it was decided in the same minute) writes no rows
  and still closes `succeeded`; the resume column reads it as ready. No other stop reason writes
  rows.
- **What reads the rows** is To resume and the gate-resume (MOTIR-7707, MOTIR-7708, MOTIR-7710) —
  not this record. `pull_request_approval`, `pull_request_merge`, `acceptance_result`,
  `plan_approval` and `agent_review` never stop a parent run mid-story and are not recorded.

## AMENDMENT 6 — `discrepancy_recorded`, a run's record of what it built through (MOTIR-8654, 2026-10-15)

> **Added 2026-10-15 (Story MOTIR-8651 · MOTIR-8655), by the decision page _A run builds
> through a wrong HOW — the discrepancy record_ (MOTIR-8654, approved).** `DispatchEventKind`
> gains one CARD-scoped member, **`discrepancy_recorded`**, written by
> `runDiscrepancyService.recordDiscrepancy` in the same transaction as the card comment it
> points at. Its `data` is `{ commentId, pointCount, dispatchRunCardId }` and never the text;
> its identity is the LEG (`data.dispatchRunCardId`, deduped by `findFindingOnRun`), so a leg
> carries at most one. It is **server-written**: the v1 ingest (`dispatchEventKindSchema`)
> refuses it, the CLI's `ReportableEventKind` excludes it, and `EVENT_STEP` maps it to `null`
> because a finding advances no step. Like the other findings it is not a stage the leg passed
> through. With no open leg the comment is still written and no event exists.

## AMENDMENT 7 — the same record carries the run's DECISIONS (MOTIR-10000, 2026-10-28)

> **Added 2026-10-28 (MOTIR-10000).** A run never asks the user about the implementation: what
> the card and its plan leave open it decides — the repository's conventions first, then the
> established industry best practice for the stack — and records. The record is AMENDMENT 6's,
> widened rather than doubled: `record_run_discrepancy` (and `POST
/api/v1/dispatch-runs/{id}/discrepancy`) take `decisions` — `{ planSaid, chose, why,
alternatives? }` — beside `points` or alone, in the same ONE call. **No new event kind.** The
> leg still carries at most one `discrepancy_recorded`; its `data` gains **`decisionCount`**, and
> **`pointCount` counts every entry** (points + decisions), so the run's findings strip, which
> reads `pointCount`, never shows _0 points_ for a decisions-only record. The card comment gives
> the decisions their own section. A points-only record writes exactly what it wrote before.
