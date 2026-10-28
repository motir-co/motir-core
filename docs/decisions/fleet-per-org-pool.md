# ADR: Fleet capacity is per organisation, and the organisation's credits are the only limit

- **Status:** Proposed (2026-09-29), for acceptance at MOTIR-6901's `decision_approval` gate. The
  direction was settled with the product owner in the planning conversation on 2026-09-29; this
  record writes it up and derives the numbers it left open.
- **Card:** MOTIR-6901 · **Epic:** MOTIR-4329 (AI economics)
- **Evidence pinned at:** `motir-core` `origin/main` @ `be6fdb9`, and
  `origin/parent/MOTIR-6860-agent-instances` @ `3c2cffc` for `agent-instances.md` AMENDMENT 1 and 2.
- **Supersedes:**
  - **MOTIR-1997** — the cross-workload fleet ceiling as the bound on fleet spend.
  - **MOTIR-1922** — the provisioning gate's per-project caps and the fleet-wide ceiling as the
    admission limit.
  - `ci-runner-fleet.md` **§9, item 1** (_"A FLEET-WIDE in-flight ceiling, in MOTIR-1922's gate"_)
    and **§9.1a** (_"the ceiling is CROSS-WORKLOAD"_), as the thing that stops Motir's spend.
  - The researched and earlier recorded versions of this card (a per-plan ladder with a fixed
    circuit breaker; then a calendar-month platform budget at 80% of paid credits granted, dropped
    because it read Motir's own records and so could not see a leaked machine).
- **Amends (names the clause; the edit rides the consuming card, not this diff):**
  - `ci-minutes-allowance.md` **§6.4** and **§H** — for fleet CI, _"the next DISPATCH is refused"_ and
    the overshoot bound stated against the pause are replaced by §3 and §4 below. The code's reading
    of an unreadable balance as _not exhausted_ (`resolveState`, `lib/ciMetering/allowance.ts`), which
    leans on §6.4's accepted overshoot, is replaced by fail-closed admission.
  - `code-graph-index-fleet.md` **§7** — the per-WORKSPACE index share becomes per-ORGANISATION (§7).
  - `agent-instances.md` **§5**'s reconcile bullet _"A machine or volume in an instance app that no
    live record owns is destroyed, and logged"_ and **AMENDMENT 1**'s orphan cleanup — the MACHINE
    half moves to the reconciler (§5); the volume half stays with the instance sweep.
  - **AMENDMENT 1 (2026-10-23)** — the pool layer of story **MOTIR-8953** under the fleet-capacity
    epic **MOTIR-9356**: one pool of AWS accounts per fleet kind, a Fly↔AWS switch per kind,
    admission that defers when a pool is full, and the sizing targets as named config. It amends §2's
    default pool.
- **Unchanged, and cited:** `ci-runner-fleet.md` **§8** (the ≈ $0.00195/min cost basis),
  `ci-minutes-allowance.md` **§1** (300 minutes per seat, 1,000 per org floor), **§2** (1 credit = 1
  minute), **§E** (Motir's own GitHub budget is a tripwire, never a valve), and `agent-instances.md`
  **§7** (one Fly app per organisation) and **AMENDMENT 2** (instances keep their own pool).
- **Cadence rule relied on:** `application-hosting.md` §21 as amended by **MOTIR-6893**, which retires
  the :00/:30 cluster. The job worker's ≤ 5 s poll (`IDLE_MAX_MS`, `lib/jobs/engine/worker.ts`)
  already holds the database awake, so a sub-hourly job runs every 5 minutes by default and finer only
  through a named exception list. MOTIR-6932 carries that into `lib/jobs/schedules.ts`.
- **Consumed by:** the fleet per-org build story **MOTIR-6906** (MOTIR-6907, 6908, 6909, 6910, 6911,
  6912, 6913, 6925) and the platform admin's monitor story **MOTIR-6905**. §8 maps each piece.
  AMENDMENT 1 is consumed by **MOTIR-8953** (MOTIR-8963 writes it; MOTIR-8966, 8968 and 8969 read its
  config) and the epic **MOTIR-9356**.

---

## Context

On `main` today the CI, index and hosted-agent fleet runs under one Motir-wide ceiling,
`MOTIR_FLEET_MAX_IN_FLIGHT` = **24** (`lib/ciFleet/limits.ts`), with per-project tier caps under it
(`PROJECT_IN_FLIGHT_CAPS`: free 1, scaled 12). `ci-runner-fleet.md` §9 put that ceiling there because
Fly offers neither a spending cap nor a billing alert, so the number was the only thing between
Motir and an unbounded invoice.

Four things are wrong with that shape now:

1. **One org's burst queues every org.** A single pull request of a real repository fans out to about
   50 jobs (motir-core#3243). Two such pushes fill 24 slots for everybody.
2. **CI is charged after the run.** A completed `workflow_run` is debited
   (`ciAllowanceService.chargeForMeteredRun`), and `ci-minutes-allowance.md` §6.2 / §6.4 refuse only
   the _next_ dispatch. A running org's balance never moves while it runs.
3. **An unreadable balance lets work start.** `resolveState` reads `balance: null` as not exhausted.
4. **Leaks are found late, in one app, silently.** `ciRunnerBootService.reapOrphans` destroys only
   machines older than `DEFAULT_REAP_AFTER_MS` (the 60-minute job timeout + 10 minutes), only
   machines carrying the `motir_fleet` tag (`packages/orchestrator/src/adapters/fly/index.ts`, `reap`),
   and only in the fleet app. Agent instances live in one Fly app per org (`agent-instances.md` §7)
   with their own orphan step. Nobody is told when a machine is destroyed for belonging to no one.

Motir-hosted repositories are created by **Motir Studio** (the `provisioning` GitHub App role,
`lib/github/appAuth.ts`) through `projectRepoProvisioningService.establishSet`, with no plan check.

---

## Decision

**Fleet capacity belongs to the organisation, and the organisation's credits are the only limit.**

1. **Only paid-AI-plan orgs use the fleet for CI.** The fleet runs CI only for Motir-hosted
   repositories, which only Motir Studio creates. Creating one requires a paid monthly AI plan
   (Standard, Pro, Max or Enterprise), and fleet admission re-checks it.
2. **Each such org has its own pool of 500 concurrent containers**, tunable by env. That is about ten
   pull requests' worth of a real repository's CI (≈ 50 jobs each, motir-core#3243). One org's burst
   never queues another's.
3. **Credits are debited while a container runs.** An org may start a container only if its remaining
   included minutes plus its balance cover everything it has running, plus the new one, for one debit
   period. At zero its running jobs are cancelled and its machines destroyed. **A balance that cannot
   be read refuses admission.**
4. **Every machine belongs to a paying organisation, or it is destroyed.** A reconciler lists every
   machine Fly runs for Motir **from the provider**, never from Motir's tables, across the fleet app
   and every per-org agent-instance app. It matches each to an organisation's live record: a CI
   intent, a hosted run, an index slot or an agent instance. A machine that matches nothing after a
   short grace, or whose record says it should have stopped, is **destroyed and the platform admin is
   alerted**.

**There is no platform-wide spend budget.** Credits bound what attributed machines cost; the
reconciler removes unattributed ones; the Epic 10 monitor (MOTIR-6905) catches attributed machines
whose debit is not moving.

The sections below fix what the direction left open.

### §1 · Who may use the fleet

- **A paid monthly AI plan** is the motir-ai `PlanTier` `standard`, `pro`, `max` or `enterprise`
  (`billing-tiering.md` §2's AI menu; §4 uses the same three Stripe tiers to lift the tracker caps).
  For the three Stripe-billed tiers the subscription must be `active` or `past_due`
  (`PAID_AI_SUBSCRIPTION_STATUSES`, `lib/services/billingService.ts`). **Enterprise has no Stripe
  object** (§2: _"platform staff sets tier"_), so it is read from its tier, and the build must not
  read `hasPaidAiPlan` alone, which is false for a null subscription.
- The check runs at **two doors**: where Motir Studio creates a repository (`establishSet`), and at
  fleet CI admission. **A plan that cannot be read refuses at both** (fail closed).
- **`isMeta` passes both doors** and is never debited or refused for credits, exactly as
  `ci-minutes-allowance.md` §6.5's _bypassed_ row already says. It keeps the same pool, and its live
  records attribute its machines (§5), so the reconciler never destroys dogfood work.
- **Indexing is not plan-gated by this record.** Code-graph index containers run for connected
  repositories that Motir Studio did not create, Motir does not charge for indexing
  (`code-graph-index-fleet.md`, the internal-allowance section), and that record already rejected
  gating the code graph behind a CI balance. Decision (1) is read as a statement about **CI**.

### §2 · The pool

- **`MOTIR_FLEET_ORG_MAX_IN_FLIGHT`, default 500**, counted per organisation under the one existing
  `fleet` admission lock (`FLEET_ADMISSION_SCOPE`). A per-org lock is rejected: it re-opens the race
  `fleetCeilingService`'s header closes.
- **What counts in it:** the org's CI runners (from `CiRunnerProvisioningIntent.organizationId`), its
  hosted-agent runs and its index containers (from `FleetInFlightSlot.organizationId`, which becomes
  required). **Agent instances do not**: they keep their own pool (`agent-instances.md` AMENDMENT 2).
- **Enterprise override:** a per-organisation number platform staff set, stored with the org the way
  its tier is. It is never a per-org env var. Where it is stored is MOTIR-6907's to choose.
- **Why 500 and not a tier ladder.** A ladder re-introduces a product limit the product owner removed:
  the money is the limit (§3). 500 is sized to the workload, not to a price: ten concurrent pull
  requests of a 50-job repository, which no single org reaches in ordinary use. An org that does is
  still bounded by §3. **Amended:** the default is now one target tenant's peak, derived from
  `TENANT_TARGET.peakRunners`, and only Motir's own (meta) orgs keep 500. See AMENDMENT 1, _The pool
  default_.

### §3 · The debit period, and what it costs to overshoot

**The debit period is 5 minutes.** Every live CI container's seconds are accrued each period and
charged through the existing `ci_overage` debit, idempotent on (container, period). The org's included
minutes (§1 of the allowance) are consumed first, then credits at 1 per minute (§2, unchanged). Each
period charges whole minutes; the remainder carries to the container's end, where the end-of-run
meter rounds once as it does today, so no container pays more than it does now.

**Admission by coverage.** A new CI container is admitted only when

```
remaining included minutes + balance  ≥  (charged containers running + 1) × 5
```

where _charged containers_ are the org's CI runners and hosted-agent runs (both are debited from the
same balance; index containers are never charged and do not count).

**At zero, the org stops** (§4). A tick finds zero when the included minutes are spent and the balance
is ≤ 0 after that period's debit.

**The worst-case overshoot for one org at 500 containers.** A tick can find the balance at 1 credit.
The next period then accrues a full period for every container before the next tick sees zero, and
the stop takes up to one more period to complete (MOTIR-6906 criterion 2: _"gone within one debit
period"_):

```
overshoot  ≤  500 containers × (5 min accrued + 5 min to stop)  =  5,000 container-minutes
           =  5,000 credits   (face value $50.00 at $0.01 per credit)
           ≈  $9.75 of Fly compute at §8's $0.00195 per minute
```

**Why 5 minutes.**

| Period     | Overshoot at 500  | Fly cost  | Debit calls, full org |
| ---------- | ----------------- | --------- | --------------------- |
| 1 minute   | 1,000 credits     | $1.95     | 500 / minute          |
| **5 min**  | **5,000 credits** | **$9.75** | **100 / minute**      |
| 30 minutes | 30,000 credits    | $58.50    | ~17 / minute          |

Five minutes keeps a runaway org to under $10 of compute while one full org costs motir-ai 100 debit
calls a minute, not 500. Thirty minutes (the old :00/:30 cluster's floor) would make the worst case a
$58.50 event for each org that runs out. One minute buys $7.80 of worst case for five times the calls.

**The period came from the overshoot, and it lands on the default cadence.** The period is chosen by
the table above, not by a schedule rule. It happens to equal the 5-minute default MOTIR-6893 sets for
every sub-hourly job, so the debit is an ordinary `system.*` job on `*/5 * * * *` and **needs no entry
on the sub-hourly exception list**. It is one job over every org with a live CI container, not a timer
per org, and it is **never gated on user activity**: an org at zero matters most when nobody is
watching it. A tick over an org with nothing running does nothing.

**Until MOTIR-6932 lands**, `SCHEDULE_CLUSTER_MINUTES` and its quiet-gap test still reject a `*/5`
schedule, so MOTIR-6910 schedules the debit after MOTIR-6932, not by adding a cluster exception.

**An unreadable balance.** Admission refuses (§4). A tick that cannot reach motir-ai stops nothing
already running, keeps the accrual, and charges it on the next tick that can. Running work is then
bounded by the 60-minute CI hard kill (`DEFAULT_JOB_TIMEOUT_MS`): at most 500 × 60 = 30,000
container-minutes, ≈ $58.50 of compute, for the length of a motir-ai outage. Stopping every org's CI
because motir-ai is down is the outage this rule refuses to cause.

### §4 · What a person sees

Each row is observable behaviour; the words are the ones shown. Deferral codes are admission's
`reason`, and the sentence is its `detail`.

| Situation                                                                                 | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Words                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **An org without a paid AI plan** asks Motir Studio to create a hosted repository         | `establish` is refused; no repository is created                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | _"Motir-hosted repositories need a paid AI plan (Standard, Pro, Max or Enterprise). Upgrade your AI plan to create one here."_ (code `ai_plan_required`)                            |
| The same org's CI reaches fleet admission (its plan lapsed after the repository was made) | Deferred; the job waits queued on GitHub                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `ai_plan_required` — _"This organization has no paid AI plan, so its CI does not run on Motir's runners."_                                                                          |
| **An org whose pool is full** (500 running)                                               | Deferred; only that org waits. GitHub shows the job as _Waiting for a runner to pick up this job_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `org_pool` — _"Your organization is running 500 of its 500 CI containers. This job starts when one finishes."_                                                                      |
| An org whose minutes and credits do not cover running + 1 for one period                  | Deferred until they do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `credits_insufficient` — _"Your organization's remaining CI minutes and credits do not cover another container. Add credits to run it."_                                            |
| **An org at zero**                                                                        | Every in-flight GitHub Actions workflow run on its Motir-hosted repositories is cancelled through GitHub's cancel endpoint and shows **Cancelled** on GitHub. Every one of its CI containers is destroyed; each intent settles `failed` with teardown reason `credits_exhausted`. The per-repository Actions pause (`ci-minutes-allowance.md` §A, MOTIR-1906) converges as today, and the billing page's _Motir CI_ line shows the paused state with §D's two options. Hosted runs, agent instances and index containers are **not** stopped by this path (see _What this does NOT decide_) | `ci_credits_exhausted` — _"The org is past its included pool and out of credits."_ (the existing admission string)                                                                  |
| **An unreadable balance**                                                                 | Deferred; nothing already running is stopped. The next sweep retries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `balance_unavailable` — _"Motir could not read this organization's credit balance. The job starts as soon as it can."_                                                              |
| **An unattributed machine**                                                               | Destroyed by the reconciler on the first pass after the grace (§5), and recorded for MOTIR-6905's list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | One Sentry issue per machine, `UnattributedMachineDestroyedError`: _"Destroyed Fly machine {machine id} ({name}) in {app}, {age} old: {no_record \| record_ended \| org_stopped}."_ |
| A provider listing fails                                                                  | Nothing is destroyed in that app; if the app list itself fails, nothing is destroyed anywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | One Sentry issue, `FleetInventoryUnavailableError`: _"Could not list machines in {app}: {detail}. Nothing was destroyed there."_                                                    |

The billing panel's copy for the paused state is `ci-minutes-allowance.md` §D's and is not re-written
here.

### §5 · The attribution rule

**The inventory comes from the provider.** Each pass lists every app in the fleet Fly organisation
(`ci-runner-fleet.md` §7.5: a separate, single-purpose Fly org), then every machine in each app,
**tagged or not**. Today's `reap()` skips a machine without the `motir_fleet` tag, so a machine started
by hand was invisible to it; here it is judged like any other. An app nothing in Motir created is in
scope: the fleet org must stay single-purpose, and anything else run in it is destroyed.

**A live record, per workload.** Metadata on the machine (`motir_org_id`, `motir_intent_id`) is
context for the alert, never attribution: anyone holding the token can write it.

| Workload         | The machine is attributed when                                                                                                                                                            | The record says it should have stopped when                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI runner        | a `CiRunnerProvisioningIntent` in `provisioning` or `running` names it as `containerId`                                                                                                   | the intent has settled, or `bootedAt` + the 60-minute job timeout + 10 minutes has passed (today's `DEFAULT_REAP_AFTER_MS`, kept as the record's own end, no longer as an age cutoff on the machine) |
| Hosted-agent run | a live `ci_container_usage` checkpoint (workload `agent`, no `container_stopped_at`) names its handle and the run still holds its unexpired fleet slot (today's `reapOrphans` spare rule) | the checkpoint is closed, or the slot has expired (its 12-hour backstop)                                                                                                                             |
| Index container  | a live checkpoint (workload `index`) names its handle and its index slot is unexpired                                                                                                     | the checkpoint is closed, or the slot has expired                                                                                                                                                    |
| Agent instance   | a non-deleted `AgentInstance` in that app names it as `machineId`                                                                                                                         | the instance is deleted. A `hibernated` or `failed` instance whose machine runs is **stopped**, not destroyed, because the record owns a persistent machine; it is alerted the same way              |
| Any of the above | —                                                                                                                                                                                         | its organisation is the target of a zero-credit stop or an admin stop (`org_stopped`)                                                                                                                |

The reconciler does **not** re-check the org's plan or balance. Refusing work for money is
admission's and the zero-stop's job (§3, §4); two killers for one reason would race.

**The grace is 10 minutes**, derived from the longest window in which a legitimate machine exists
before its record names it:

| Workload             | Create-then-record window                                                                                                            | Bound                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| CI runner            | `provision` returns, then `recordBoot` writes `containerId`                                                                          | ≤ 30 s (`ORCHESTRATOR_REQUEST_TIMEOUT_MS`) |
| Agent instance       | `createMachine` returns, then `setHandle`                                                                                            | ≤ 30 s                                     |
| Index container      | `provision` (≤ 30 s), boot up to its 120 s deadline, then the first poll that sees it running writes the checkpoint (≤ 15 s backoff) | ≤ 165 s                                    |
| **Hosted-agent run** | the same, with a poll backoff of up to 60 s (`AGENT_MAX_POLL_INTERVAL_MS`)                                                           | **≤ 210 s (3.5 min)**                      |

Ten minutes is about three times the longest window, room for a delayed poll or one worker restart.
The same grace applies from a record's end instant before a
should-have-stopped machine is destroyed, so the reconciler never races an ordinary teardown. A
machine Fly reports without a creation instant is not destroyed, and is alerted.

**The cadence is 5 minutes**, on `*/5 * * * *`, replacing `system.ci-runner-reap`'s schedule. It
has to be a scheduled job, never gated on user activity: a leak exists precisely when nothing in Motir
is running. A leaked machine therefore lives at most grace + cadence = **15 minutes**, ≈ $0.03 for a
2-core fleet machine at §8's $0.00195 per minute, against today's 70 minutes for a tagged machine and
forever for an untagged one. A leak of a full org's worth, 500 machines, costs ≈ $14.60 at that bound.

**Why 5 and not finer.** The grace, not the cadence, dominates the lifetime: going to 1 minute takes a
leak from 15 to 11 minutes, saving ≈ $0.008 per machine, and puts a full provider listing of every app on
the exception list. Going back to 30 minutes would make it 40 minutes, ≈ $0.08 per machine and
≈ $39 for 500. So the reconciler uses the 5-minute default and **needs no entry on the sub-hourly
exception list**. It is scheduled after MOTIR-6932, as the debit is.

**A failed listing destroys nothing, and alerts.** A failed app list stops the pass. A failed machine
list for one app skips that app and the pass continues with the rest. A listing error is never read as
_"nothing is running"_. A failed destroy is alerted and retried on the next pass.

**Every AWS account is walked too** (MOTIR-9426, 2026-10-24). After the Fly organisation, each `aws`
fleet account of either kind is listed over its own EC2 client — the account's whole region, every
instance, **no tag filter**, so a VM started by hand is judged like any other — with the table above
unchanged. A hosted VM it kills is torn down through the account it was listed in, so its usage row,
slot release, charge and `lost_supervision` end come from that account. An account whose credential
cannot be read is alerted and skipped, and the pass walks the rest; a transient 429 or 5xx listing is
asked once more before it alerts.

### §6 · What becomes of the old limits

| Thing                                                    | Becomes                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOTIR_FLEET_MAX_IN_FLIGHT`                              | **The operator's kill switch only.** `0` stops every new boot of every workload. Unset, or any positive number, imposes no platform ceiling. `DEFAULT_FLEET_IN_FLIGHT_CEILING = 24` is deleted. An environment that still sets it to 24 should drop it, or it keeps the old ceiling's meaning in the logs and none in the gate. |
| `PROJECT_IN_FLIGHT_CAPS` and `MOTIR_FLEET_PROJECT_CAP_*` | **Retired.** How an org shares its pool between its own projects is its own business.                                                                                                                                                                                                                                           |
| `reapOrphans`' cutoff (`DEFAULT_REAP_AFTER_MS`)          | **No longer a destruction trigger.** A machine is destroyed because nothing attributes it, never for being old. The 70 minutes survives only as a CI intent's own end instant (§5). `reapOrphans`' half that settles and charges a hosted run's last container is kept.                                                         |
| The agent-instance sweep's orphan step                   | Its **machine** half moves to the reconciler, so one rule in one place raises one alert. Its **volume** half stays.                                                                                                                                                                                                             |
| The index cap                                            | See §7.                                                                                                                                                                                                                                                                                                                         |

### §7 · The index cap, re-derived per organisation

`workspaceIndexInFlightCap(global) = ceil(global / 2)` divides `MOTIR_INDEX_MAX_IN_FLIGHT` (default
6), the index workload's own global cap, not the fleet ceiling. What changes is **why the global
exists**. It was _"a quarter of the fleet"_ of 24. With no fleet ceiling left, it is **the one
Motir-side bound on a workload nobody is charged for**: Motir does not charge for indexing, so money
cannot bound it the way it bounds CI.

- **`MOTIR_INDEX_MAX_IN_FLIGHT` stays, default 6**, as that bound, the same shape as
  `MOTIR_INSTANCE_MAX_RUNNING`'s safety valve in `agent-instances.md` AMENDMENT 2.
- **The share is per organisation: `ceil(global / 2)` = 3**, replacing the per-workspace share. The
  organisation is now the unit of capacity, so it is the tenant that must not hold more than half. It
  stays a derived relation, never a second env var (`code-graph-index-fleet.md` §7's reasoning holds).
- Index containers also count in their org's pool of 500 (§2). At 3 per org they cannot crowd its CI.

---

## §8 · The build, checked against MOTIR-6906's subtasks

| Piece                                                                                                                                                                                                                                           | Repository                                                         | Subtask                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| Per-org count and reserve under the one lock; `MOTIR_FLEET_ORG_MAX_IN_FLIGHT` = 500 and the enterprise override; `org_pool`; `PROJECT_IN_FLIGHT_CAPS` removed; `MOTIR_FLEET_MAX_IN_FLIGHT` as kill switch; the per-org index share (§2, §6, §7) | motir-core                                                         | MOTIR-6907 ✓               |
| One idempotent org stop: cancel in-flight Actions runs, destroy CI containers, settle `credits_exhausted`; called by the zero-credit stop and the admin (§4)                                                                                    | motir-core                                                         | MOTIR-6908 ✓               |
| The paid-plan check at `establishSet` and at admission, fail-closed, enterprise by tier, `isMeta` passing (§1, §4)                                                                                                                              | motir-core                                                         | MOTIR-6909 ✓               |
| The 5-minute debit job (`*/5`, after MOTIR-6932), idempotent on (container, period), included minutes first, end-of-run meter reduced to reconciliation (§3)                                                                                    | motir-core (uses motir-ai's existing `ci_overage` route unchanged) | MOTIR-6910 ✓               |
| Coverage admission, `credits_insufficient`, `balance_unavailable`, and the stop at zero (§3, §4)                                                                                                                                                | motir-core                                                         | MOTIR-6911 ✓               |
| The attribution reconciler: provider inventory over every app, the per-workload match, 10-minute grace, 5-minute job, the two Sentry errors, the kill record (§5)                                                                               | motir-core (`packages/orchestrator` gains app and machine listing) | MOTIR-6925 ✓               |
| Integration gate and E2E over the above                                                                                                                                                                                                         | motir-core                                                         | MOTIR-6912 ✓, MOTIR-6913 ✓ |
| The admin's per-org view, mismatch alert, list of kills and _Stop containers_                                                                                                                                                                   | motir-core                                                         | MOTIR-6905 (Epic 10) ✓     |

Every piece has a subtask and every subtask has a piece. No piece lands in motir-ai: its `ci_overage`
debit already takes an idempotency key, and this record changes neither the price nor the route.

---

## Alternatives rejected

- **Keep one platform ceiling and raise it.** Any shared number re-creates finding 1: one org's burst
  queues the rest. And a ceiling bounds concurrency, not money.
- **A per-plan ladder with a fixed circuit breaker** (the researched version). A product limit the
  owner removed; credits already express how much an org may run.
- **A calendar-month platform budget at 80% of paid credits granted** (the earlier recorded version).
  Its fleet term was computed from Motir's own records, so a leaked machine, the one thing that costs
  Motir unrecovered money, never appeared in it.
- **A 1-minute or a 30-minute debit period.** §3's table: five times the debit calls for a $7.80 better
  worst case, or a $58.50 worst case per org.
- **A per-organisation debit timer instead of a job.** The earlier draft of this record used one, to
  avoid waking an idle database off the :00/:30 cluster. MOTIR-6893 removed that reason: the database
  is always awake, so one `*/5` job is simpler and has no timer to lose on a restart.
- **Attributing by the machine's metadata tags.** Anyone holding the Fly token writes metadata; the
  record in Motir's database is what money was charged against.
- **Fail open on an unreadable balance** (today). It starts work nobody can be shown to pay for.

---

## Consequences

- One org's burst no longer queues another's, and an org's CI capacity grows from its share of 24 to 500.
- A running org's credits move during the run, every 5 minutes, and an org that runs out stops within
  about two periods at a worst-case cost to Motir of ≈ $9.75.
- A motir-ai outage starts no new fleet CI for any org, and stops none that is running.
- An org on the free AI plan, or tracker-only, can no longer get a Motir-hosted repository. Its
  existing hosted repositories stop getting fleet runners.
- Every Motir app in the fleet Fly org is inventoried every 5 minutes; nothing unattributed lives
  past 15 minutes, and every kill reaches a person.
- Neither new job needs an entry on MOTIR-6893's sub-hourly exception list, and neither can run before
  MOTIR-6932 replaces the :00/:30 cluster constants.
- Index containers remain Motir's own cost, bounded by their own global of 6.

---

## What this does NOT decide

- **Prices and allowances.** 1 credit per minute and 300 minutes per seat (1,000 per org floor) are
  unchanged.
- **The job cadence rule.** MOTIR-6893 owns it; this record only places its two jobs on the default.
- **The agent-instance pool** (`agent-instances.md` AMENDMENT 2), and **agent storage and the plan
  gate for agents** (MOTIR-6902).
- **A running debit for hosted-agent runs.** They count in the pool and in coverage, and are still
  charged for machine time when the run settles (`hosted-agent-machine-charge.md`), with the gateway's
  429 stopping their model calls. Whether their machine time is debited live is not decided here.
- **Whether a prolonged motir-ai outage should stop running work.** §3 bounds it by the CI hard kill
  and stops nothing.
- **What an org whose plan lapses does with the hosted repositories it already has**, beyond their CI
  waiting (the MOTIR-711 handover path is unchanged). GitHub's own 24-hour limit on a job waiting for a
  runner still applies.
- **`internalBilling` orgs.** This record applies `ci-minutes-allowance.md` §6.5's existing `isMeta`
  bypass and nothing wider; MOTIR-6926 decides internal orgs for agents only.
- **Whether indexing ever needs a paid plan or is ever charged.**
- **Volumes.** The reconciler judges machines; orphan volumes stay with the agent-instance sweep.
- **The admin monitor's screens** (MOTIR-6905) and **the copy of the billing panel's paused state**
  (`ci-minutes-allowance.md` §D).

---

## AMENDMENT 1 — the pool layer, the provider decision, and targets as config (MOTIR-8963, 2026-10-23)

- **Story:** MOTIR-8953 (the provider-neutral fleet pool layer) · **Epic:** MOTIR-9356 (fleet capacity
  grows by itself) · **Decision card:** MOTIR-9357.
- **Amends:** §2's default pool (500 → one target tenant's peak; meta orgs keep 500). Every other
  clause of this record stands: the pool is still per organisation and still the fairness limit, the
  credits still bound the spend (§3), and `MOTIR_FLEET_MAX_IN_FLIGHT` is still the kill switch for
  every fleet kind, on Fly and on AWS (§6).
- **Config:** every number below that the code reads lives once, in `lib/ciFleet/shardTargets.ts`,
  and is named here by its constant. Nothing is typed twice and no `MOTIR_*` env var is added for a
  target or an account ceiling: the `orgIndexInFlightCap` rule (§7) — _derived, never separately
  configured_ — applies.

### A1.1 · Why the fleet needs a pool of accounts

No single provider account can hold Motir's growth. Motir's own org reached about 105 runners on
2026-10-18 and Fly refused creates with `HTTP 422: Your organization has reached its machine limit`.
Fly links at most 100 orgs to one billing organisation, only by hand in its dashboard, and a new
org's machine limit is dynamic. A new AWS account starts at 5 vCPU of on-demand EC2 (quota
`L-1216C47A`). §2's pool of 500 already promised one org more than any single account can run.

### A1.2 · The account

An **account** is one provider account in one fleet kind's pool, recorded as one `fleet_shard` row
(MOTIR-8961): its fleet kind, its provider and location, its GitHub org and App installation, its
credentials reference, and its **real limits** (the granted vCPU quota or machine limit, with where it
was read). An account belongs to exactly one kind's pool.

GitHub's limits are counted **per GitHub org**, whichever account booted the machine. A job's runner
always registers in its repository's own GitHub org; the machine account a job boots in never decides
its GitHub org (MOTIR-8966, MOTIR-8974).

### A1.3 · The provider decision

- **Every fleet kind runs on AWS:** the CI runner (`ci_runner`), the agent runner (`hosted_agent`), the
  indexer (`code_graph_index`) and the agent hoster (`agent_instance`), in a US region: `us-east-1`,
  with `us-east-2` as the fallback.
- **Each kind has its own Fly↔AWS switch** (a feature flag, read on every boot) and flips on its own.
  A kind whose switch is on Fly boots exactly as today, on the process-wide Fly fleet. The Fly code
  stays.
  - The agent runner's switch is `MOTIR_FLEET_AGENT_RUNNER_PROVIDER` (`aws` ⇒ its pool; anything
    else ⇒ Fly), and its in-flight count per account is the live `hosted_agent` fleet slots carrying
    that account (`fleet_in_flight_slot.fleet_shard_id`) (MOTIR-9421, 2026-10-24).
- **Fly is never a backup.** There is no `backup` role and no overflow to Fly: a job of a kind switched
  to AWS never boots on Fly. Existing Fly-hosted agents are not migrated; only Motir's own orgs have
  them, and that they may stop working after the hoster flips is accepted (MOTIR-9356).
- **Why:** A1.1. Fly cannot be grown by script past its per-org machine limit and its 100-org billing
  link; AWS accounts are created through AWS Organizations and their quota is read live from Service
  Quotas.

### A1.4 · The shared pools

**One shared pool of AWS accounts per fleet kind — four pools in all.** Any org's job can land on any
shared account of its kind, chosen per job. There is no per-tenant machine account in the shared
pools (Host's own accounts, A1.6, are a separate arrangement).

### A1.5 · The admission order

Built by MOTIR-8968. For one job of kind _K_:

1. **Pick the account of kind _K_ with the most headroom**, among _K_'s active accounts. An account's
   ceiling is `shardAdmissionCeiling` (A1.9).
2. **On a capacity refusal** (quota exceeded, out of stock, throttled — `OrchestratorCapacityError`,
   MOTIR-8973) **or a provider outage, move to the next account of kind _K_**, never to another kind's
   account and never to Fly.
3. **When every account of _K_ is full, defer** with reason `shard_capacity`, exactly as `org_pool`
   defers (§4): the job stays pending and is woken when a slot frees or by the sweep.

A job is **never lost** and **never marked `provision_failed`** for a capacity reason (MOTIR-8941's
rule). The per-org pool (§2, A1.11) stays the fairness limit, counted **across** every account.

Two config lines carry it (MOTIR-8968): **`fleetKindOnPool(kind)`** is the one read of a kind's
Fly↔AWS switch, read uncached on every job (a kind whose story has not wired its switch reads Fly), and
**`SHARD_PAUSE_SECONDS`** (120 s) is how long an account that refused is skipped before the next job
re-tests it.

GitHub's per-org mint limit (A1.7) is a pacing rule on the same path: admission counts per-minute mints
per GitHub org beside the per-5-minute count, and defers rather than mint past
`GITHUB_SECONDARY_LIMITS.jitconfigMintsPerMinute`.

### A1.6 · Growth and own accounts, as decided

- **The pool grows at 70%.** When an account reaches `HEADROOM_ALERT_FRACTION` (70%) of its **currently
  granted** EC2 on-demand standard vCPU quota (`L-1216C47A`, read live from Service Quotas, never
  assumed), the Motir spare account of that kind joins the shared pool and a new spare is created with
  the scripted add-shard. Built by the pool-growth story **MOTIR-9362**.
- **Host and the larger pool plans run on three AWS accounts of their own:** a CI runner account, an
  agent runner account, and **one merged account for the indexer and the agent hoster**. In the merged
  account the indexer has priority: **10 machine spots (20 vCPU)** are always kept for index
  containers, used or not, and agent instances use only the rest. Hosted-agent caps on these plans are
  **10 per user and 50 per org** (live agents, running or asleep — `agent-instances.md` AMENDMENT 7). Built by the Host-accounts story **MOTIR-9365** (and
  MOTIR-9366 for the larger pool plans).

### A1.7 · The measured results

**GitHub's secondary limits** — MOTIR-8959, measured 2026-10-23 against two throwaway Enterprise Cloud
orgs with a throwaway App (the findings comment on that card carries the raw logs):

| limit                                         | `generate-jitconfig` (mint)                                      | `DELETE` (settle)                                    | in config                                                      |
| --------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| content-creating 80/min                       | does not apply (300/min held, all `201`)                         | does not apply (300/min alongside 300 mints/min)     | not counted                                                    |
| content-creating 500/h                        | does not apply (2,741 mints in ~43 min)                          | does not apply (5,051 deletes in ~45 min)            | not counted                                                    |
| points 900/min                                | does not apply at 5 points                                       | does not apply at 5 points (600 writes/min passed)   | not counted                                                    |
| concurrency 100 (REST + GraphQL)              | not reached (107 in flight passed)                               | **not tested above ~5 in flight — assumed to apply** | `GITHUB_SECONDARY_LIMITS.concurrentRequests` (both calls)      |
| **unpublished: ~300–340 mints / rolling min** | **applies**, per GitHub org (one installation each), not per App | does not count toward it                             | `GITHUB_SECONDARY_LIMITS.jitconfigMintsPerMinute` = 300/min    |
| registrations 1,500 / 5 min (Actions limits)  | applies; not reached on its own                                  | n/a                                                  | `GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN` (`runnerJitConfig.ts`) |
| `core` 15,000 / h (Enterprise Cloud)          | applies, 1 request per call                                      | applies                                              | `GITHUB_INSTALLATION_API_PER_HOUR`                             |

A refusal of the mint limit is an `HTTP 403` with `retry-after: 60`, `x-ratelimit-remaining > 0` and the
message _"You have exceeded a secondary rate limit"_; no header names the limit. Telling it apart from
the registration ceiling is MOTIR-8968's and MOTIR-8969's.

**The AWS figures are pre-launch targets, not measurements:** the boot time on an EC2 VM-per-job runner
and the granted `L-1216C47A` quota of a fleet account are **not measured here: see MOTIR-9274 /
MOTIR-9275**. Until those cards record them, `SHARD_VCPU_QUOTA_TARGET` (2,500 vCPU) is the target
account's quota and a real account's ceiling is computed from its own recorded quota (A1.9).

### A1.8 · The targets

_Pre-launch targets, not measurements._ One target tenant is at most ¼ of Motir's own measured CI usage
(`ci_runner_provisioning_intent`, 2026-10-16 to 10-18).

| target                          | value                  | config constant                                                      |
| ------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| runners at once                 | ≤ 26                   | `TENANT_TARGET.peakRunners`                                          |
| starts per 5 minutes            | ≤ 31                   | `TENANT_TARGET.startsPer5Min`                                        |
| starts per hour                 | ≤ 40                   | `TENANT_TARGET.startsPerHour`                                        |
| vCPU at peak                    | ≤ 52 (26 × 2, derived) | `TENANT_TARGET.peakVcpu` = `peakRunners × FLEET_CONTAINER_SIZE.cpus` |
| GitHub calls per runner         | 2 (mint + settle)      | `TENANT_TARGET.githubCallsPerRunner`                                 |
| the target account's vCPU quota | 2,500                  | `SHARD_VCPU_QUOTA_TARGET`                                            |
| headroom threshold              | 70%                    | `HEADROOM_ALERT_FRACTION`                                            |

A runner is 2 vCPU / 8 GB (`FLEET_CONTAINER_SIZE`, `packages/orchestrator/src/rates.ts`).

### A1.9 · The derivations

**Tenants per account** — `tenantsPerShard(limits)` is `floor(min(limit ÷ one target tenant's demand on
that limit))` over every limit given, and names the limit that bound it. A limit not given is not
counted, so a GitHub org's limits alone give the number of target tenants that org can carry. A
tenant's demand on each limit:

- vCPU quota: `peakVcpu`; machine limit: `peakRunners`;
- registrations per 5 min: `startsPer5Min`;
- installation API per hour: `startsPerHour × githubCallsPerRunner`;
- a secondary limit: the tenant's starts in its period × the calls it counts. The starts in a period are
  the 5-minute target spread evenly over it — the **paced** reading admission enforces (A1.5) — and
  never more than the hourly target allows in any hour. The concurrency limit is counted as calls over
  one second (Little's law at the measured ~1 s per call).

**The target account** (`DERIVED_TENANTS_PER_SHARD_TARGET`, computed from `TARGET_SHARD_LIMITS`):

| limit                         | limit value | one tenant's demand | tenants               |
| ----------------------------- | ----------- | ------------------- | --------------------- |
| vCPU quota                    | 2,500       | 52                  | **48**                |
| registrations / 5 min         | 1,500       | 31                  | 48                    |
| installation API / h          | 15,000      | 40 × 2 = 80         | 187                   |
| jitconfig mints / min (paced) | 300         | 31 × 60 ÷ 300 = 6.2 | 48                    |
| concurrency 100 (assumed)     | 100 / 1 s   | 31 ÷ 300 × 2 ≈ 0.21 | 483                   |
| **result**                    |             |                     | **48**, bound by vCPU |

The secondary-limit verdict leaves the number at **48**: the content-creating limit, which would have
made it about 12 (500 ÷ 40) — or 6 if it counted both calls (500 ÷ 80) — does not apply. The mint limit
only holds at 48 **when admission paces mints** to ≤ 300 a minute per GitHub org; unpaced, with every
tenant's peak in the same minute, the worst case is 300 ÷ 31 = **9**.

**An account from its granted quota** — `shardAdmissionCeiling(limits)` is
`floor(vcpuQuota ÷ FLEET_CONTAINER_SIZE.cpus)`, never above a recorded machine limit. It follows the
**granted** value: when a raise is granted and recorded, the ceiling moves with it.

- An account granted **200 vCPU** admits `floor(200 ÷ 2)` = **100** containers at once, and carries
  `floor(200 ÷ 52)` = **3** target tenants, bound by vCPU (its GitHub lines are its GitHub org's and
  give 48).
- A new account at AWS's starting **5 vCPU** admits 2 containers and carries no full target tenant.
- The target account (2,500 vCPU) admits 1,250 containers.

### A1.10 · The headroom threshold

**70%** (`HEADROOM_ALERT_FRACTION`) of an account's granted vCPU quota, and of each GitHub limit per
GitHub org — registrations per 5 minutes, installation API per hour, and each applicable secondary
limit (the mint limit reads 70% of 300/min = 210/min) — with every runner counted against its
**repository's** GitHub org. It is the input of the headroom reading (MOTIR-8969) and the trigger of
the pool-growth story (MOTIR-9362).

Sustained deferral alerts separately, per fleet kind: at least `SUSTAINED_DEFERRAL_MIN_JOBS` (10) of
the kind's jobs deferred `shard_capacity` and at least `SUSTAINED_DEFERRAL_FRACTION` (20%) of them,
over `SUSTAINED_DEFERRAL_WINDOW_MINUTES` (60) — pre-launch targets (MOTIR-8969).

### A1.11 · The pool default

The default pool of a tenant org drops from 500 to **one target tenant's peak concurrency**:
`DEFAULT_ORG_POOL_CAP = TENANT_TARGET.peakRunners` (`lib/ciFleet/limits.ts`). Accounts are sized in
target tenants (A1.9), so a tenant that may hold more of the fleet than a tenant was sized for would
take another tenant's room. The per-org pool keeps its fairness semantics and its order: the org's own
`Organization.fleetPoolCap`, then `MOTIR_FLEET_ORG_MAX_IN_FLIGHT`, then the default.

**Motir's own (meta) orgs keep 500** (`META_ORG_POOL_CAP`) when neither is set: Motir's org is the
**source** of the measurements the targets are a quarter of, not a target-sized tenant, and shrinking
it to 26 would throttle Motir's own CI the day this lands. The pool is read with `isMeta` by
`fleetCeilingService.resolveOrgPool`, which still fails closed when the org row cannot be read, and
the platform monitor's per-org rows show the same number admission enforces. Per-plan caps across
every account (MOTIR-9363) are that story's; changing a production org's `fleetPoolCap` and flipping
any kind's switch are the epic's production turn-on (MOTIR-9369).

**Superseded before it shipped.** MOTIR-9363 (MOTIR-9375 and MOTIR-9377, under the fleet-capacity
decision record MOTIR-9357) removed the organisation's pool from admission and from the monitor while
this story was open: every workload is now held to its own plan figure (`lib/billing/planCaps.ts`),
and `Organization.fleetPoolCap` overrides the plan's CI burst cap alone. So `DEFAULT_ORG_POOL_CAP`,
`META_ORG_POOL_CAP` and `resolveOrgPool` were dropped when `main` was merged into this story; the
rest of AMENDMENT 1 (the accounts, the switch, `shard_capacity`, the headroom alert) stands.
