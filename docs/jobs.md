# Background jobs

Motir runs background work on **its own Postgres-backed job engine** — durable
runs, step memoization, retries, a scheduler and a dead-letter queue, all in
tables this repository owns and a worker process it ships. This document covers
the runtime: the `defineJob` / `sendEvent` seam, the `job_run` ledger, how to add
a job, and the cross-cutting patterns — named **retry policies**, the
**dead-letter queue** + replay, **scheduled (cron) jobs**, event-level
**idempotency** and **debounce**.

> ⚠️ **THE SUBSTRATE CHANGED, AND MOST OF THIS DOCUMENT DID NOT** (Epic
> MOTIR-3413; the retirement is MOTIR-3418). Until 2026-08-27 the runtime was
> [Inngest](https://www.inngest.com/) — a hosted, event-driven function platform
> — and `defineJob` was a wrapper around `inngest.createFunction`. The AUTHORING
> surface is deliberately unchanged: the same options, the same `ctx.step`
> contract, the same 24 job definitions, not one of them edited by the migration.
> What changed is who executes them.
>
> Sections below that MEASURE the old scheduler are kept and marked **HISTORICAL**
> where they explain why an option is written the way it is. They describe a
> platform this repository no longer runs on, and a reader should treat them as a
> record rather than as behaviour to rely on.

## Runtime overview

```
emit:   route/service ──sendEvent("x.y", { workspaceId, … })──▶ job_event + job_queue rows
run:    worker (fly.toml `worker` group) ──claim──▶ runner ──▶ your handler
ledger: executeWithLedger writes a job_run row: running ─▶ succeeded | failed (+ DLQ on exhaustion)
```

- **The emit seam** — `lib/jobs/sendEvent.ts`. Writes ONE `job_event` row and one
  `job_queue` row per subscribing job, inside `withSystemContext`. Best-effort by
  contract: every caller emits POST-COMMIT, so a failure is logged rather than
  turning a saved change into a 500.
- **The worker** — `scripts/worker.ts`, bundled by `pnpm build:worker` and run by
  `fly.toml`'s `worker` process group. It claims runs (`SELECT … FOR UPDATE SKIP
LOCKED`), runs the scheduler's tick, executes handlers through the ledger, and
  drains on SIGTERM.
- **The registry** — `lib/jobs/registry.ts` imports every definition module, which
  is what populates `lib/jobs/engine/registry.ts` (handlers), the manifest (the
  handler-free view the emit path reads) and the schedule table. Adding a job
  means adding it there; there is nothing to register with anyone.
- **The 4-layer rule still holds.** No file outside `lib/jobs/**` and
  `scripts/worker.ts` may import the engine's internals (enforced by an ESLint
  `no-restricted-imports` rule). Routes/services emit events via `sendEvent`; job
  handlers receive the injected service-layer bag and call services exactly as a
  route would.

## Environment

**There is nothing to configure.** The engine needs the database the app already
has (`DATABASE_URL`, plus `DATABASE_URL_UNPOOLED` for the `LISTEN` connection —
a transaction-mode pooler cannot hold a session, which is bug MOTIR-3454) and the
`worker` process group in `fly.toml`. No API key, no account, no third-party
service.

> ⚠️ **HISTORICAL.** This section used to carry three variables —
> `INNGEST_DEV`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — and, during the
> migration, a fourth: `MOTIR_POSTGRES_JOB_IDS`, the per-job cutover switch that
> chose which of the two engines each job ran on. All four went with MOTIR-3418.
> If you find one set on a deployment, it is inert and can be unset.

## Local development

```bash
pnpm dev              # the app on :3000 — emits write job_queue rows
pnpm build:worker && node .worker/worker.mjs   # the executor, in a second terminal
```

An emit is a database write, so `pnpm dev` alone is enough to see events
enqueued; nothing runs them until a worker is up. The E2E lane does the same
thing — `tests/e2e/_helpers/job-worker-process.ts` starts the worker as a child
of the Playwright runner, which is why `globalSetup` is where it lives.

> ⚠️ **HISTORICAL.** This used to be `pnpm dev:inngest` plus a second terminal
> running `inngest-cli dev -u http://localhost:3000/api/inngest`, which gave a
> local dashboard on `:8288`. The in-app equivalent is
> `/settings/workspace/jobs` (below), which is the surface an operator uses in
> production too.

## `defineJob(options, handler)`

The canonical way to define a job — `lib/jobs/defineJob.ts`. It REGISTERS the
definition (with the engine registry, the emit-path manifest and, for a cron, the
schedule table) and returns it. It is a registration rather than a wrapper: the
run-ledger bookkeeping lives in `lib/jobs/engine/ledger.ts`, around every run the
worker executes. (Until MOTIR-3418 it also built an `inngest.createFunction`
carrying a second copy of that bookkeeping — the copy is what went, not the
ledger.)

```ts
import { defineJob } from '@/lib/jobs/defineJob';

export const sendInvoice = defineJob(
  { id: 'invoice.send', retryPolicy: 'transient' },
  async (ctx, services) => {
    const { workspaceId, invoiceId } = ctx.event.data;
    await services.workspaces.something(workspaceId);
    return { sent: true };
  },
);
```

**Options**

| Field         | Default                  | Meaning                                                                                                                                                                                      |
| ------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | —                        | The job id, **also the triggering event name** (1:1 convention). Must be a key of `JobEventDataMap` in `lib/jobs/types.ts`.                                                                  |
| `retryPolicy` | `'transient'`            | Named retry policy — the preferred way to declare retry intent. See **Retry policies** below. Mutually exclusive with `retries`.                                                             |
| `retries`     | —                        | Raw count of ADDITIONAL attempts after the first (escape hatch; prefer `retryPolicy`). Passing both throws.                                                                                  |
| `idempotency` | —                        | Event-payload-keyed dedup template, enforced by a partial UNIQUE index on `(job_id, idempotency_key)`. See **Event-level idempotency on the Postgres engine** and the `email.send` exemplar. |
| `cron`        | —                        | Schedule the job instead of event-triggering it. See **Scheduled jobs** below.                                                                                                               |
| `catchUp`     | — (REQUIRED with `cron`) | What a missed tick does: `all` / `latest` / `skip`. A `cron` job that omits it does not type-check, and a job without a `cron` may not supply it. See **Scheduled jobs** below.              |

**Handler signature** — `(ctx, services) => result`:

- `ctx` — the engine context (`JobContext` in `lib/jobs/defineJob.ts`):
  `ctx.event` (`.name`, `.data`, `.id`), `ctx.step` (durable step tools),
  `ctx.runId` (the `job_queue` row id) and `ctx.attempt` (zero-indexed). Those
  four are the whole surface, and `tests/jobs/engine-runner.test.ts` asserts it
  against the tree — a handler reaching for a fifth member fails a test rather
  than throwing inside a background job.
- `services` — the injected service-layer bag (`lib/jobs/services.ts`):
  `workspaces`, `workspaceInvites`, `projects`, `workItems`, `users`, `email`.
  Use these instead of importing service singletons directly, so handlers stay
  testable with a stubbed bag.
- The return value becomes the run's resolved output.

**Run ledger.** Around every handler, `executeWithLedger` writes one `job_run`
row: `running` at start → `succeeded` on return. On a throw, the row stays
`running` across retries; once the retry budget is exhausted the worker calls
`recordEngineTerminalFailure`, which flips the row to `failed` and writes a
dead-letter row (see **Dead-letter queue**). So a job that's mid-retry reads as
in-flight, not prematurely failed. The writes run inside `step.run(...)`, so they
execute exactly once per run even when the handler replays across step
boundaries — one row per run, not one per replay (the `job-run:start` step's
result is reused across retries too). This is the read path the operator
dashboard (1.6.5) renders. `workspace_id` is null for system jobs. On success the
row also records the handler's JSON-safe return value in its `output` column
(5.2.7) — a run's summary (e.g. the attachment-GC's
`{ scanned, deleted, failed }`) is readable from the ledger; a non-JSON-safe
return degrades to a NULL `output`, never a failed run.

> **Why a SEPARATE terminal hook, not a try/catch (1.6.6).** The dead-letter
> write used to live in a `try/catch` around the handler, on the "final attempt"
> branch. On a real durable executor a `step.run` scheduled from a catch block
> _after_ the step that terminally failed is never executed — the run is already
> finalizing as failed — so the failed/DLQ rows silently never got written in
> production (only the in-process unit harness, which runs the catch
> synchronously, made it look like they did). The engine settles a run whose
> `attempts` have reached `maxAttempts` and calls `recordEngineTerminalFailure`
> once, from the worker, outside the handler — the same shape the vendor's
> `onFailure` hook had, for the same reason. It carries the original event but not
> the row id, so `jobRunsService` correlates back to the `running` row by
> `(functionId, eventId)` (the `@@index([eventId])` exists for this). See
> `PRODECT_FINDINGS.md` #39, and MOTIR-3683 for the cron correlation key.

The ledger tables (`job_run`, `job_run_dlq`) are **workspace-scoped by RLS**
(1.6.4): a tenant sees only its own workspace's rows. The runtime writes them
under a trusted **system-admin context** (`withSystemContext`) so the ledger —
which has no workspace context — can record rows for any/no workspace, and
operator tooling can see untenanted `system.*` runs. See the
`add_job_run_dlq_and_rls` migration for the policy.

## `sendEvent(name, data)`

The only way to emit an event — `lib/jobs/sendEvent.ts`. Wraps the engine's dispatcher
and enforces the **workspace-scoping invariant**: every event carries an
**explicit** `workspaceId`. The field is required by each event's payload type
(a forgotten id is a compile error) and re-checked at runtime, where `undefined`
(missing) and `''` (empty) are rejected.

```ts
import { sendEvent } from '@/lib/jobs/sendEvent';

await sendEvent('invoice.send', { workspaceId, invoiceId });
```

**The `null` carve-out.** A handful of events are genuinely cross-workspace — a
password-reset email is identity-scoped, not workspace-scoped (the user may
belong to many workspaces or none). Such events type their `workspaceId` as
`string | null`, and `sendEvent` accepts an **explicit `null`** (but never a
forgotten field). `null` is what the `job_run` row stores — its `workspace_id`
FK is nullable. Do **not** invent a `"system"` sentinel string: that's not a
real workspace id and would violate the FK on insert.

System events (the `system.*` namespace) are untenanted by design, so
`sendEvent`'s type still excludes them — a system payload's `workspaceId` is
optional, and widening one function to accept both namespaces would mean dropping
the explicit-tenant assertion for the workspace-scoped events too. Many are
**cron-triggered** (e.g. `system.daily-health-check`, see **Scheduled jobs**) or
driven by the in-process test harness. The ones that are EMITTED go through
`sendSystemEvent` — see the emit seam directly below.

## The emit seam — every event goes through one of three doors (MOTIR-3456)

**Nothing outside `lib/jobs/` reaches the engine.** There are exactly three ways
to emit an event, all in `lib/jobs/sendEvent.ts`:

| door                              | for                                                | on a transport failure |
| --------------------------------- | -------------------------------------------------- | ---------------------- |
| `sendEvent(name, data)`           | workspace-scoped events                            | swallowed + logged     |
| `sendSystemEvent(name, data)`     | `system.*` events                                  | swallowed + logged     |
| `dispatchSystemEvent(name, data)` | `system.*`, for a caller that must SEE the failure | **rethrown**           |

**Why the rule exists, in one line: that module is the ONE description of what
emitting means, so an emitter that bypasses it is an emitter no change to that
description reaches.** When the rule was written the thing being bypassed was the
per-job cutover switch, and four `system.*` emitters that reached the queue
directly were enqueued on neither engine. The switch is gone (MOTIR-3418); what a
bypass skips today is the explicit-tenant assertion and the post-commit
best-effort contract — so a notification's transport failure becomes a 500 on a
request whose write already committed, which is PROD-443 exactly.

**The strict door is not an inconsistency.** Two callers legitimately need the
failure rather than a log line: `ciRunnerFleet`'s provision sweep emits inside a
`step.run`, where a thrown error buys a free retry of the step, and
`dispatchCiRunnerBoot` REPORTS `'send_failed'` to its caller. Both behaved that
way before they were routed through this module, and moving WHERE an event is
dispatched must not silently change WHETHER a caller finds out that it failed.

**Two things enforce this, and they cover different halves.**

- **ESLint** — `JOB_ENGINE_RESTRICTION` in `eslint.config.mjs` refuses an import
  of `@/lib/jobs/engine/*` from outside `lib/jobs/**` and `scripts/worker.ts`.
  ⚠️ It names OUR module graph rather than a package, and that is the lesson from
  the rule it replaced: `INNGEST_CLIENT_RESTRICTION` existed only because the
  package-level rule beside it guarded a door nobody used — every bypassing
  emitter imported `@/lib/jobs/client`, our own thin wrapper, which was not the
  vendor SDK and so was never restricted. A boundary that can be walked around by
  importing one file over is a convention, not a guard.
- **A guard test** — `tests/jobs/emit-seam.test.ts` asserts on the TypeScript AST
  that `dispatchEventToEngine` is CALLED in exactly one file (`sendEvent.ts`).
  ESLint cannot cover this half: one of the original bypasses lived INSIDE
  `lib/jobs/**`, where the import is legitimate. The test counts calls rather than
  grepping the name, because the tree names the function in several comments.

If one of these fails, it is telling you the switch cannot reach your job — the
fix is a door above, not a disable comment.

## Canonical job: `email.send`

`email.send` (`lib/jobs/definitions/emailSend.ts`) is the first production job
and the reference exemplar — every transactional email in motir-core flows
through it.

**Why it exists.** Password reset (`lib/auth/index.ts`) and workspace invites
(`lib/services/workspaceInvitesService.ts`) used to render + `sendEmail()`
**inside the HTTP request**. A slow or down provider stalled the request or
returned a misleading success while no mail went out. Now those sites call
`sendEvent('email.send', …)` and return immediately; the job does the delivery
with retries, off the request path. Terminal failures surface in the jobs
dashboard (1.6.5), not as a silent drop.

**Shape.**

```ts
// caller (request lifecycle) — enqueue and return
await sendEvent('email.send', {
  workspaceId, // a workspace id, or null for a cross-workspace email
  idempotencyKey: token, // the reset token / invite token
  to: user.email,
  template: 'password-reset', // discriminant
  data: { recipientName, resetUrl }, // exactly that template's props
});
```

- **Layering.** The job handler owns no email logic. Rendering + dispatch live
  in `emailService` (`lib/services/emailService.ts`), which the handler reaches
  via the injected `jobServices` bag — the 4-layer rule (a job handler is the
  "service caller" for a background trigger). `@/lib/email` (`sendEmail`) is
  import-restricted to `emailService` alone; every other caller must enqueue.
  Templates stay pure render functions in `lib/emailTemplates/`.
- **Durability.** The single `step.run('send', …)` persists the send result, so
  a retry of a different step never re-delivers.
- **Idempotency — TWO layers, at two different boundaries.** The job is
  configured with `idempotency: 'event.data.idempotencyKey'`, so a retried Server
  Action that re-fires the same token collapses to one delivery:

  | layer                                        | lives in                                                          | window                                                         |
  | -------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
  | `job_queue_job_idempotency_key` (MOTIR-3459) | the **job engine** — `lib/jobs/engine/idempotency.ts`             | **unbounded**: a partial UNIQUE on `(job_id, idempotency_key)` |
  | Resend's `Idempotency-Key` header            | the **provider adapter** — `resendIdempotencyKey`, `lib/email.ts` | Resend's own, per request                                      |

  > ⚠️ **HISTORICAL — there used to be a THIRD, and it was a different KIND of
  > mechanism.** The vendor ran its own server-side event dedup over the same
  > declaration, with an expiring WINDOW rather than a permanent index, and while
  > both engines ran the per-job cutover switch decided which of the two applied —
  > they never composed, because a job was on exactly one lane. That is why
  > **Event-level idempotency on the Postgres engine** below argues the unbounded
  > index as a DIVERGENCE rather than a port: the index does not expire, and that
  > was a decision, not an oversight.

  **The provider layer STACKS on the queue's**, and it is the only one that is a
  property of the DESTINATION rather than of the queue: it collapses two accepted
  sends of the same key at Resend even when both reached the provider.

  **⚠️ And the provider layer is absent locally and in E2E.**
  `resendIdempotencyKey` is called only from `resendProvider()`; `consoleProvider`
  and `fileProvider` never read `msg.idempotencyKey` at all. Whatever the lane
  does not catch is therefore written twice to the console log or the file
  outbox — dev and E2E differ from production in exactly this dimension, so a
  duplicate that production would swallow is visible here, and a behaviour that
  looks deduped here is not evidence that the queue deduped it.

  **What is tested where.** The in-process unit harness runs the handler directly
  and does **not** dedup, so the unit tests assert the _wiring_ (the definition
  carries the expression) and the _caller contract_ (the key is supplied), not the
  drop. The ENGINE's drop **is** tested —
  including a concurrent duplicate against real Postgres — in
  `tests/jobs/engine-idempotency.test.ts`. The key is also recorded on the
  `job_run` row.

- **Retry policy.** `email.send` uses `retryPolicy: 'transient'` — a send fails
  on transient provider/network blips, so a few attempts with backoff is the
  right intent (see **Retry policies**). A terminal failure dead-letters. A
  spent provider quota is not retried at all: it dead-letters on its first
  attempt as `EMAIL_QUOTA_EXHAUSTED` (`retryable: false`, below).
- **Notification budget.** Notification-class templates (watchers, mentions,
  subscriptions, digests, a failed automation) may use at most
  `EMAIL_NOTIFICATION_DAILY_BUDGET` accepted sends per rolling 24 hours — 60 by
  default on Resend — counted from `email_delivery`. Past it the send is SKIPPED:
  the run succeeds with `skipped: 'notification_budget_exhausted'` on its output
  and nothing reaches the provider, so the rest of the quota stays for password
  reset, email change, invites and sign-in codes, which are never budgeted
  (`EMAIL_TEMPLATE_CLASS`, `lib/services/emailService.ts`).
- **`workspaceId: null`** for password reset (cross-workspace); the invite path
  passes its real workspace id.

## How to add a new job

1. **Declare the event** in `lib/jobs/types.ts` — add a key + payload to
   `JobEventDataMap`. Business-event payloads must include `workspaceId` —
   `string`, or `string | null` for a genuinely cross-workspace event (see the
   `null` carve-out above).
2. **Define the job** in `lib/jobs/definitions/<name>.ts` via `defineJob`. Pick
   a `retryPolicy` that matches the failure surface (see **Retry policies**).
3. **Register it** — add it to the `jobFunctions` array in `lib/jobs/registry.ts`.
   (The serve route imports from the registry, so it never changes.)
4. **Emit it** from a route or service via `sendEvent` (business events) — or
   give it a `cron` **and a `catchUp`** (system jobs, see **Scheduled jobs**).
   The two go together and the compiler enforces it: there is no default, because
   a default is how a cron job added later inherits a catch-up disposition nobody
   chose for it. Decide it deliberately — the three answers and the argument for
   picking between them are in **Scheduled jobs**.
5. **Test it** with `JobTestEngine` (`tests/helpers/jobs.ts`) against the real
   Postgres (see `tests/jobs/scheduled.test.ts` for a cron job,
   `tests/jobs/dlq.test.ts` for the failure/DLQ path). For an **event-triggered**
   job pass the real event explicitly via `events: [{ name, data }]`; for a
   **cron** job omit `events` and the harness synthesizes `scheduled.<id>`. Its
   `step` is in-memory — a spec that needs the DURABLE semantics (a memo surviving
   a retry, a `sleep` that yields and re-enqueues) is testing the ENGINE and
   belongs in `tests/jobs/engine-*.test.ts` against the real runner.

### A worked consumer: `monitor-issue-resolve` (Story MOTIR-4931 · MOTIR-5703)

`lib/jobs/definitions/monitorIssueResolve.ts` — the resolve-back. A second
consumer of `work-item/transitioned` (beside `watcher-notify/transitioned`), so
it takes its own id and names the shared event through `trigger`. When a bug
linked to monitor issues reaches a done-category status it resolves each issue
at the provider through `monitorSyncService.resolveLinkedIssues`.

- **Idempotency is the LINK's claim, not the event's.** The event is
  at-least-once and the monitor poll runs a backstop sweep too, so exactly-once
  is one conditional `UPDATE` on `monitor_issue` — only its winner calls the
  provider.
- **A provider refusal is recorded and returned**, so it spends no retries; an
  unexpected error throws into the `transient` policy and the dead-letter queue,
  and the next poll's sweep re-claims the stale claim. The sweep is the recovery
  for anything that dead-letters here.

## Retry policies

A job declares its retry **intent** with a named policy (`lib/jobs/retries.ts`)
rather than a magic count, so the choice is self-documenting and visible in the
operator dashboard. Each policy is defined in terms of total **attempts**
(including the first), which is what `job_queue.max_attempts` stores; `defineJob`
does the one translation from a `retries` count of ADDITIONAL attempts
(`maxAttempts = retries + 1`). The engine applies exponential backoff between
attempts — the policies differ by their attempt **budget**, not by a hand-tuned
curve.

| Policy       | Attempts | When to pick it                                                                                                 |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------- |
| `transient`  | 3        | **Default.** Failures are usually transient (flaky provider, network blip). `email.send` uses this.             |
| `idempotent` | 5        | The operation is read-only or naturally idempotent, so repeating is always safe — a longer budget is upside.    |
| `none`       | 1        | Run **at most once**: a retry would be semantically wrong (e.g. "send this signup notification once or never"). |

```ts
defineJob({ id: 'invoice.send', retryPolicy: 'idempotent' }, handler);
```

Passing both `retryPolicy` and a raw `retries` throws (ambiguous intent). When a
job specifies neither, it gets `transient`. On the **final** failed attempt the
run dead-letters (below); `none` therefore dead-letters on the very first
failure.

### A failure can end the run early — `retryable: false`

A handler that KNOWS repeating cannot help throws an error carrying
`retryable: false`, and the worker dead-letters on that attempt — the same
terminal hook and the same dead-letter row as a spent budget, with the rest of
the budget unspent (`isNonRetryableFailure`, `lib/jobs/engine/worker.ts`). It
is a property rather than a class because the code that knows is usually a
provider adapter outside `lib/jobs/**`, which may not import the engine. Only an
explicit `false` counts: an error that says nothing keeps its whole budget.

The one producer today is a spent email-provider QUOTA (MOTIR-5873): a Resend
`429 daily_quota_exceeded` clears only when the provider's day rolls over, so the
`transient` schedule's minutes-apart retries each asked an exhausted quota again.
It now dead-letters at once as `EMAIL_QUOTA_EXHAUSTED`.

## Concurrency — HISTORICAL (the option is gone)

> ⚠️ **THE `concurrency` OPTION NO LONGER EXISTS** (MOTIR-3418). It was the
> vendor's own — `number | ConcurrencyOption | ConcurrencyOption[]`, a `limit`
> with an optional CEL `key` that gave each distinct value its own sub-queue —
> and `defineJob` forwarded it essentially verbatim (MOTIR-1982 widened it to do
> so, after the wrapper spent a year silently discarding `key` and `scope`).
>
> It is gone because **no job declared one by the time the engine took over**, and
> the engine never read the field: a forwarded option nothing consumes is a lie in
> a type signature. Removing it is not a decision to run jobs unbounded — it is
> the removal of a control that had already stopped working. The two jobs whose
> comments still discuss concurrency (`system.code-graph-index`,
> `system.code-graph-refresh`) each say in their own words why they carry none: a
> per-run cap bounds POLLS, not live containers, and the real bound is the fleet's
> admission cap.
>
> **What bounds work today** is the worker pool: `fly.toml`'s `worker` process
> group, its machine count, and each worker's claim batch. That is a deployment
> number rather than a per-job one, and `docs/decisions/job-lane-occupancy.md`
> carries the argument — including the measurement that motivated the whole epic,
> where a five-slot hosted account was oversubscribed by a single status change
> with four consumers.
>
> **If a job ever needs a real per-job or per-tenant limit**, it is an engine
> feature to add against `job_queue` (a claim predicate, not a config key), not a
> field to re-introduce on `defineJob`.

## Debounce — coalescing is REAL; the `timeout` cap and an unresolvable KEY are not

`debounce` delays a run until `period` has passed with no further same-`key`
event, then runs ONCE with the LATEST event. `timeout` is meant to cap the total
deferral so a continuous stream still runs.

```ts
debounce: { key: "event.data.installationId + '/' + event.data.repoOwner", period: '2m', timeout: '15m' }
```

**`key` is a CEL expression, not a typed reference**, and that is the sharp edge
below. The documented limits: `period` is at least 1 second and at most 7 days,
and debounce does not combine with batching.

> ⚠️ **EVERYTHING FROM "What the SCHEDULER actually does" DOWN IS HISTORICAL**
> (amended 2026-08-26 MOTIR-3488; re-marked by MOTIR-3418). It is a measurement of
> the **retired vendor's** executor, taken against its dev server, and it stays
> because it is why the option is written the way it is — in particular why an
> unresolvable key is a REFUSAL here rather than a silent merge. It is not
> behaviour to rely on: nothing in this repository runs on that executor.
>
> **The behaviour that IS current is § The engine's debounce**, below it. There is
> one lane now, so there is no lane to choose between.

### What the SCHEDULER actually does — MEASURED, not assumed

A config-level assertion (`expect(fn.opts.debounce).toEqual(…)`, which
`tests/jobs/code-graph-index.test.ts` makes for `system.code-graph-refresh`)
proves the option was FORWARDED. It passes whatever the runtime then does with
it — including dropping the runs it declines to enqueue, which is what
MOTIR-2994 was filed to look for. So the behaviour was measured against the real
scheduler: `scripts/experiments/inngest-debounce-coalescing.mjs` registers a
probe function, sends a burst, and counts the runs that execute.

`inngest-cli` **1.27.0** dev server, SDK 4.5.0. Re-check these on a CLI upgrade —
the version is the measurement's scope, not a footnote.

| Burst                                                         | Debounce           | Runs                              | Contract |
| ------------------------------------------------------------- | ------------------ | --------------------------------- | -------- |
| 4 events, no debounce (the CONTROL)                           | —                  | 4                                 | 4 ✓      |
| 4–8 same-key events, sent SERIALLY                            | `2s` (± `30s` cap) | **1**, carrying an ARBITRARY one  | 1 ✓ ⚠️   |
| the same 4–8, sent concurrently or as ONE batched `send`      | `2s` (± `30s` cap) | **1**, carrying an ARBITRARY one  | 1 ✓ ⚠️   |
| 30 DISTINCT keys in one `send`                                | `2s` + `30s` cap   | **30**                            | 30 ✓     |
| 24 events, 18 across 3 keys + **6 whose key field is ABSENT** | `2s` + `30s` cap   | **4** — 3 keyed + **1 for all 6** | 9 ✗      |
| same key, one event every **1.0 s** for 20 s                  | `30s` + `5s` cap   | **5**, at ~5 s intervals          | ✓        |
| same key, one event every **0.9 s** for 20 s                  | `30s` + `5s` cap   | 4                                 | ✓        |
| same key, one event every **0.7 s** for 14 s                  | `2s` + `4s`/`10s`  | **1**, only after the stream ends | ✗        |
| same key, one event every **0.5 s** for 20 s                  | `30s` + `5s` cap   | **1**, only after the stream ends | ✗        |

**Coalescing is real. WHICH event survives is arbitrary — including for a serially-sent
stream.** The property
`docs/decisions/code-graph-index-fleet.md` §7.3 leans on — a push storm to one
repo produces one refresh of the newest head — holds on the dev server in every
burst shape tried, including the one a bulk producer actually emits (the whole
array in a single `send`). No run was dropped, and
`error enqueueing debounce job: queue item already exists` appeared **zero**
times across ~20 trials. **Distinct keys stay independent**: one key's burst
never swallowed another's run.

**⚠️ WHICH event survives is not defined for ANY send shape — corrected 2026-08-22
(MOTIR-3398).** This section previously claimed the last event wins for a serially-sent
stream, and `tests/jobs/debounce-burst.test.ts` asserted it. **A measurement falsifies
it.** With `burst()` instrumented to read the dev server's OWN `received_at` per event
(the sibling field `ts` is client-supplied and echoes whatever the sender sets), six
SERIAL awaited sends landed inside **one millisecond** on the scheduler's clock —
`schedulerSpanMs: 0`, one run, nothing stalled or split — and that run carried **event
5**. On a second occasion, event **4**. Two of ten instrumented runs, `inngest-cli`
1.27.0 / SDK 4.5.0.

So serial sending buys no ordering at this timescale: the debounce keeps an arbitrary
member, exactly as it does for a batched `send`. The old claim survived because it
presents identically to a real stall in a CI log — one run, a non-last payload — and was
diagnosed as a timing failure four times before the scheduler-side span (MOTIR-3371)
made the two distinguishable. For
`system.code-graph-refresh` this is immaterial: the run re-reads the repo's
default-branch head rather than reading anything off the event. That is exactly
the property to check before relying on "the latest event wins" — a job that
takes a SHA from the event and is fed by a batched producer can coalesce onto a
stale one.

**⚠️ An UNRESOLVABLE key does not disable the debounce — it MERGES.** When the
`key` expression names a field the event does not carry, the scheduler does not
fall back to "not debounced": every such event lands in ONE shared bucket, so N
unrelated events produce ONE run and N−1 units of work vanish with nothing raised
to the sender. Inngest documents no behaviour here, so this is measured. **The
rule that follows: a debounce `key` may only name fields the event's payload type
makes REQUIRED.** `key` is a string, so TypeScript cannot check it and a field
turned optional later breaks it silently. MOTIR-2902 is the instance —
`key: 'event.data.parentId'` on `work-item/created`, where a ROOT item has no
parent, so every root creation in a bulk import debounced against every other
one; its E2E saw 3 derivation runs where it required 4.

**⚠️ `timeout` does NOT cap the deferral for a stream faster than ~1 event/second.**
At a 1.0 s inter-event gap the cap fires on schedule; at 0.7 s and below it never
fires at all and the run lands only after the stream stops — the exact scenario
`timeout` exists for. Treat the cap as a best-effort bound on a slow stream, and
never as a latency guarantee. (Whether a job is EXPOSED depends on its producer:
`system.code-graph-refresh` is driven by default-branch pushes to one repo, which
do not arrive faster than one a second, so its `15m` cap is unexercised rather
than wrong.)

### What this does NOT say

- **This was the DEV SERVER — the one CI's E2E lane and every self-hosted
  deployment ran — not the vendor's cloud.** Production used the cloud, whose
  scheduler was a different implementation and was NEVER measured: a controlled
  probe needed the production account's event key, and firing probe events into
  the production environment was human-gated. The vendor's own documentation
  stated the coalescing contract without distinguishing environments, and
  documented nothing about an unresolvable key — so for the cloud the first row
  of the table was a documented promise and the two ✗ rows were UNKNOWN rather
  than known-good. **That gap is now permanent** (MOTIR-3418): the account is
  closed and the probe cannot be run, which is the strongest argument for having
  written the numbers down.
- **A dev-only defect is still a defect.** Two of the three findings above bite
  exactly where nobody is watching: self-hosted runs on this scheduler, and CI's
  E2E lane is the only place any test can observe a debounce at all.

### The guard — HISTORICAL

`tests/jobs/debounce-burst.test.ts` booted the pinned CLI and asserted the first
three rows of that table against the real scheduler — one run for a same-key
burst, one run PER distinct key, and the keyless collapse pinned as a
characterization so a change upstream surfaced here. **It was deleted with the
dependency it drove** (MOTIR-3418); the current guard is
`tests/jobs/engine-debounce.test.ts`, and any job that grows a `debounce` belongs
in THAT one — a scheduler that drops runs then fails the build
instead of a story. It also asserts that `system.code-graph-refresh`'s key names
only fields `CodeGraphRefreshData` makes required, which is the compile-time half
of the unresolvable-key rule.

The standalone probe that produced the table (`LAB_MODE=…
scripts/experiments/inngest-debounce-coalescing.mjs`, driven against a
throwaway dev server) was **deleted by MOTIR-3418** along with the package it
imported, and so was `tests/jobs/debounce-burst.test.ts`, which booted the
pinned CLI to assert the first three rows against the real scheduler. Neither
could be run again: the dependency is not installed and the account is closed.
The numbers are preserved above BECAUSE they cannot be re-measured — that is
what makes them worth keeping rather than a link to a script.

**The engine's debounce has its own guard**, `tests/jobs/engine-debounce.test.ts`,
which drives the real dispatcher against a real Postgres and counts the runs a
burst produces. Any job that grows a `debounce` belongs in it.

### The ENGINE's debounce — the same option, implemented by us (MOTIR-3483)

`docs/decisions/job-queue-foundation.md` §9 chose the mechanism while rejecting
pg-boss, whose `singleton`/throttle options were the strongest argument for
adopting a library at all: _"a `run_at` that is pushed forward on each same-key
arrival, which is a column and an upsert on a table we own, not a subsystem."_
That is what shipped. `job_queue` carries `debounce_key` and
`debounce_first_seen_at`, and `lib/jobs/engine/debounce.ts` is the arithmetic.

**How the key is resolved, and when the resolver REFUSES.** One resolver serves
`debounce.key` and `idempotency` alike (`lib/jobs/engine/eventExpression.ts`).
The grammar is a `+`-joined sequence of `event.data.<field>` terms and
single-quoted literals — the shape `system.code-graph-refresh` declares — and it
is TOTAL: an expression it cannot parse throws at REGISTRATION, as the definition
module is evaluated, so every process that loads the registry sees it. **This is
the one place the engine is deliberately STRICTER than Inngest**, and it is the
finding directly above that makes it worth being: there an unresolvable key does
not disable the debounce, it MERGES, and N unrelated events become one run with
nothing raised to the sender. Here the job cannot start.

**What pushes `run_at` forward.** The enqueue looks for a PENDING, unclaimed run
holding `(job_id, debounce_key)`, locks it with `SELECT … FOR UPDATE`, moves its
`run_at` to `now + period` and REPOINTS its `event_id` at the newer event — which
is what makes the coalesced run carry the latest push rather than the first.
Two concurrent FIRST arrivals have no row to lock, so both insert; a PARTIAL
UNIQUE index on `(job_id, debounce_key) WHERE debounce_key IS NOT NULL AND
state = 'pending'` catches the loser, which then RETRIES the coalesce. Reading
that `P2002` as "already enqueued" — which is right for the idempotency
constraint beside it — would silently discard a push.

**A same-key event arriving while the debounced run is EXECUTING enqueues a NEW
run.** The claim clears `debounce_key`, so the window belongs to a pending row
and a push during an index is never folded into work that has already started.
Clearing it at the claim is also what keeps a RETRY safe: `rescheduleAt` puts the
row back to `pending`, and a row that still carried its key would collide with
the row that push enqueued — a unique violation on the retry path.

**The deferral cap FIRES here, and this is where the engine is better than what
it replaces.** MOTIR-2994 measured that Inngest's `timeout` does not fire for a
stream faster than ~1 event/second — the exact case it exists for. The engine
stamps `debounce_first_seen_at` on the first arrival and refuses to push `run_at`
past `first_seen + timeout`, whatever the arrival rate. A deliberate divergence
from MOTIR-3413's "no job's observable behaviour changes", stated on the day it
was made rather than discovered later — and one that can only make a run happen
SOONER than the lane it replaces would have.

**A payload that cannot supply the key gets its own row** (not coalesced, not
merged) — the opposite of Inngest's behaviour, and the safe direction: losing
coalescing costs money, merging loses events.

**An emitter can make ONE arrival due now — `immediate` (MOTIR-5360).**
`sendSystemEvent(name, data, { immediate: true })` resolves the same key and
takes the same lock, but writes `run_at = now` instead of `now + period`: a first
arrival opens a window that is already due, and a coalescing one pulls the
pending run forward. It is NOT a way to skip the debounce. The row still carries
the key, so every later same-key arrival coalesces into it and the queue still
never holds two pending runs for one key. The switch belongs to the EMITTER, per
dispatch, because one job can serve a trigger that arrives in bursts and one with
a person waiting. Its one user is the planning-session refresh
(`enqueueCodeGraphRefresh(…, { trigger: 'session_start' })`), where the push
debounce cost 122 s of a ≈ 211 s wait.

**An arrival never moves an already-due run back into the future.** Once
`run_at` has passed, the run is only waiting for a worker. A coalescing arrival
repoints the event as usual but leaves `run_at` where it is, so a push landing
between an immediate arrival and the claim cannot re-defer that run by a whole
`period`. A run that is not yet due is moved exactly as before.

**The guard** is `tests/jobs/engine-debounce.test.ts`, against real Postgres —
including the concurrent first arrival, which a serial test cannot see. It used to
have a sibling rather than a predecessor (`tests/jobs/debounce-burst.test.ts`,
above), because two implementations had to be measured separately; there is one
implementation now, and this is its guard.

## Wall clock — the step is the unit, and every I/O call needs a deadline

**A retry budget does not help a job that runs out of TIME**, and this is the
failure mode that has actually cost us production runs (MOTIR-1974). Three rules
follow, and they are coupled — changing one means checking the others.

**1 · A step is the unit of DURABILITY. It used to be the unit of the platform's
TIMEOUT as well, and that half has expired (amended 2026-08-26, MOTIR-3488).**

This rule read: _"The platform timeout applies to an INVOCATION, i.e. to a step …
A handler that does everything in one `step.run` has opted out of checkpointing
entirely: it must fit end-to-end in a single invocation, and if it doesn't, it is
killed mid-flight on **every** attempt and burns its whole budget getting
nowhere."_ **That was true, and it was true of VERCEL.** The retired serve route
declared `maxDuration = 300`, a Next.js route-segment directive the DEPLOYMENT
PLATFORM enforced; motir-core has run as a long-lived Fly process since
MOTIR-2384 (`Dockerfile` ends `CMD ["node", "server.js"]`), and the job engine's
worker is its own process group with a renewed lease. A long-running handler is
not killed by anything of ours.

**What is true now, and it is a different sentence:**

- **A run may span half an hour and that is the documented NORMAL case** — `lib/jobs/engine/worker.ts` says so, renewing a 60 s
  lease every 20 s so a long run and a dead worker stay distinguishable. A step
  is what survives a WORKER RESTART: `step.run` memoizes a completed operation in
  `job_step`, and a reclaim re-invokes the handler from the top and replays it.
  So the question a step answers is no longer "does this fit?" but **"if this ran
  a second time, what would exist twice?"** —
  `docs/decisions/job-queue-foundation.md` §13 states the rule and tables the
  per-call-site disposition for both container supervisors.
- **Rule 4 below (code outside a step runs once per PASS) is unchanged and still
  bites**, because a reclaim replays the handler from the top. What has gone is
  the CEILING, not the checkpointing.

**2 · THERE IS NO CEILING ANY MORE — the declaration that stated one is deleted**
(MOTIR-3418). `maxDuration = 300` lived on the serve route every job was invoked
through, and MOTIR-1974 declared it explicitly so the number would be reviewed
rather than inherited from a platform default. The route is gone with the vendor,
and with it the only thing in this repository that named an invocation budget.
`tests/ciFleet/fleetTimeBudgets.test.ts` used to assert the fleet's deadlines
against it and now asserts them against each other — the ordering and the
one-step-is-small property survive; the absolute number does not, and **do not
re-introduce one**: a hardcoded `300` would assert the constants against a bound
nothing enforces, which reads as a live constraint and is not.

**3 · Every network call a job makes carries a deadline.** `fetch` has none of
its own: an unresponsive dependency is waited on until the platform kills the
invocation, and that arrives as a bare `FUNCTION_INVOCATION_TIMEOUT` 504 with no
step output — indistinguishable from a crashed app, and nothing a retry budget
can reason about. A bounded call fails as a typed error instead, INSIDE the
budget, and retries meaningfully. The deadlines in play:
`MOTIR_AI_REQUEST_TIMEOUT_MS` (30s) in `lib/ai/motirAiClient.ts` — the only one
left on that boundary since the 180s tarball-upload deadline went with the
upload client itself (MOTIR-2138) — `REPO_TARBALL_TIMEOUT_MS` (60s) in
`lib/git/provider.ts`, `RUNNER_JIT_REQUEST_TIMEOUT_MS` (15s) in
`lib/github/runnerJitConfig.ts`, and `ORCHESTRATOR_REQUEST_TIMEOUT_MS` (30s) in
`lib/orchestrator/errors.ts`. **Their sum along the slowest step must stay under
a STATED ceiling** — currently the route's `maxDuration`, for want of a better
number (rule 2), and no longer because a platform enforces it. That inequality is
what guarantees a hung dependency surfaces as a typed failure.

⚠️ **The inequality survives rule 1's amendment; the WORD does not, quite.**
Nothing kills an invocation any more, so the failure it prevents has changed
shape: a step with no clock on its calls now hangs FOREVER, holding a lease it
keeps renewing, and a run that never returns is worse than one that is killed —
there is no error, no attempt spent, and nothing to alert on. So the deadlines
matter MORE than they did, and `maxDuration` is what the ceiling is still stated
against for want of a better number (rule 2).

The fleet's boot step is the worked example of the sum, because it is the one
step that makes TWO external calls: the JIT mint and the container provision.
Both deadlines are re-exported as `FLEET_TIME_BUDGETS.mintDeadlineMs` /
`.containerCallDeadlineMs` and `tests/ciFleet/fleetTimeBudgets.test.ts` asserts
their sum against `stepWorkBudgetMs` and the route's `maxDuration` — so the
inequality is a failing test rather than a paragraph. (It reads the route's
number deliberately: rule 2 keeps that declaration as the one STATED ceiling, and
re-choosing it is its own work item rather than a side effect of MOTIR-3488.) It was a paragraph until
MOTIR-2011: the boot path had the right SHAPE (one small step) with no CLOCK on
either call, and a step that makes one call still runs forever if the call does.

**What this looked like when it was wrong.** `system.code-graph-index` ran a
tarball fetch plus one motir-ai upload per project inside a single `step.run`,
against an undeclared `maxDuration`, with no deadline on either call. All five
production repos exhausted all five attempts on `FUNCTION_INVOCATION_TIMEOUT`
and dead-lettered — including a repo small enough that size cannot explain it.
The first fix (MOTIR-1974) split it into one `resolve-target` step plus one
`index-project:<id>` step per project — a shape `system.code-graph-refresh` kept
running until MOTIR-2057 (`lib/jobs/codeGraphSteps.ts`, now deleted; refresh
drives the container shape below, keeping only its per-repo debounce, after the
step-per-project shape left it failing ~68% of `motir-core`'s refreshes on the
180 s motir-ai deadline). MOTIR-2027 took the INDEX job off
the bytes path entirely: it dispatches one container per (repo × project) and
supervises it as `index-boot:<id>` → `ctx.step.sleep` → `index-poll:<id>:<n>` →
`index-settle:<id>` (`lib/jobs/indexFleetSteps.ts`), so the run spans minutes and
no step does — the same move `system.ci-runner-boot` made in MOTIR-2007. The
ledger contract is unchanged either way: ONE `job_run` per repo carrying one
`output.repoRef`, which is what makes a failed container fail the RUN rather than
record a diminished success.

**4 · Code OUTSIDE a step runs once per PASS, not once per run.** The same
re-invocation that makes rule 1 true also re-executes everything in the handler
body that is not inside a `step.run` — once for every step boundary the run
crosses. The count is therefore a property of the run's step TOPOLOGY, not of
the handler: adding one bookkeeping step adds one execution of every un-stepped
line, silently, in an unrelated card's diff. And the value the FUNCTION returns
is the last pass's, so an un-stepped body that is not idempotent also makes the
run's reported output disagree with the `job_run` row (which memoized the first
pass's).

Almost always the fix is to wrap the work in a step. **This paragraph used to
continue: *"When the work is LONGER than `maxDuration` — rule 2's ceiling on one
step — the answer is still steps: split it into short ones and let the RUN span
the time, waiting between them with `step.sleep`."* There is no ceiling to answer
(rule 1), and on this engine `step.sleep` is the wrong instrument for it: a sleep
is a `JobStepYield`, a re-enqueue, a re-claim and a replay of every earlier step,
so a loop that polls *N* times costs on the order of *N²* memo lookups. **Split
for DURABILITY, not for duration\*\* — around the operations whose repetition would
leave something existing twice.

`system.ci-runner-boot` is the worked example, and it is worth reading as a
sequence of THREE fixes now (MOTIR-2002, MOTIR-2007, MOTIR-3485). Its supervision
watches a container for up to an hour. It first stayed un-stepped and was made
explicitly **replay-aware**, memoizing its outcome onto the provisioning intent
keyed by the dispatch. That made the outcome consistent, but it could not make
the work FIT: the invocation was killed at 300s, so teardown never ran and the
intent held a fleet slot until the reaper. MOTIR-2007 took the shape apart —
one `step.run` to boot, then a `step.sleep` + one-provider-read `step.run` per
poll, then a `step.run` to tear down. Every step was milliseconds, the run spanned
the hour, and the memo columns were dropped because step memoization gives
once-per-run for free.

**MOTIR-3485 then took the poll loop back out**, because the ceiling it was
fitting inside had gone. What is left is boot and teardown as memoized steps with
an ordinary `while` loop between them — 2 step rows for a full-length CI job
instead of ~2 400. **None of MOTIR-2007's guarantees was given up**: the boot
still runs once per run (memoization, unchanged), teardown is still reached on
every path out of the loop (an ordinary `finally`, which a long-lived process
makes trustworthy again — and which reaches a THIRD exit the stepped form could
not, a throw from inside the loop), and the single attempt still survives a
restart (a lease reclaim REFUNDS it). The index fleet made the same move in
MOTIR-3484.

**The lesson is the ORDER of the three.** Reach for replay-awareness only when the
work genuinely cannot be split. Reach for splitting when the repetition costs
something. And **when a shape exists to satisfy a platform constraint, write down
which constraint** — MOTIR-2007's comments did, which is the only reason anyone
could tell, four stories later, that the shape had outlived its reason rather
than encoding a durability requirement. And note what un-stepped code
costs you either way: teardown cannot be reached from a `catch` (the executor
finalizes a failed run before running a step scheduled from one — see the
`onFailure` note above), so a stepped loop must return TYPED results rather than
throw, and route its only exit into the teardown step.

⚠️ **Testing a `step.sleep` loop.** `InngestTestEngine` records state only for
steps that RAN, and a sleep never runs — so an un-stubbed `step.sleep` is
re-found forever and `execute()` never resolves. It surfaces as a test TIMEOUT,
which reads like a slow test rather than a missing stub. Pre-fulfil each sleep by
id in the `steps` option (`{ id: 'my-wait:1', handler: () => null }`), and supply
more than the loop can consume.

⚠️ **The two container supervisors no longer have one, and the OPPOSITE problem
replaced it (MOTIR-3484 / MOTIR-3485).** They used to be this note's worked
examples, and `sleepSteps()` helpers in
`tests/jobs/ci-runner-fleet.test.ts` and `tests/helpers/indexFleet.ts` existed for
them. Their waits are ordinary `await`s now, so nothing hangs — and a job-level
test instead SLEEPS FOR REAL at the shipped cadence unless it shortens it.
`driveIndexFleetFast()` (`tests/helpers/indexFleet.ts`) and `superviseFast()`
(`tests/jobs/ci-runner-fleet.test.ts`) do that through the services' own options
seam, changing the cadence and nothing else. The cadence itself is asserted BY
VALUE in `tests/jobs/supervisor-cutover-story-gate.test.ts`, which is where a
number belongs.

**A retrying job looks identical to a healthy one.** `defineJob` writes its
`running` ledger row in a memoized step, so a retry replays it: the row stays
`running` with `attempt` frozen at 0 until the budget is spent. Until the DLQ
row lands, a dying job and an in-flight one are indistinguishable on the
dashboard — so when you are watching a long job, watch `job_run_dlq`, not
`job_run.status`.

## Deferring a run — `deferRun(at, reason)` (MOTIR-3825)

**A third way a pass can end.** `deferRun(at, reason)`
(`lib/jobs/engine/defer.ts`) throws `JobRunDefer`; the worker returns the
`job_queue` row to `pending` at `at`, releases the claim, REFUNDS the attempt,
and a worker claims it again later. Nothing is checkpointed, and the handler is
re-invoked **from the top**.

```ts
import { deferRun } from '@/lib/jobs/engine/defer';

// One unit of work, then hand the run back.
const advanced = await supervisionRepository.advance(runId, key, observation, tx);
if (!advanced.done) deferRun(new Date(Date.now() + waitMs), `poll ${advanced.pollNumber}`);
```

**⚠️ A DEFERRING HANDLER OWNS ITS OWN DURABLE STATE. This is the rule, not a
suggestion.** A defer writes NOTHING to `job_step`, so the next pass remembers
no loop counter, no cursor and no observation. Everything the handler needs
between passes has to be in a row it wrote itself and reads back at the top —
and it may not be a `step.run` memo instead, because a memo freezes its FIRST
answer for the life of the run (§13.3(b), which rejected exactly that for an
observed `startedAt`). `docs/decisions/job-queue-foundation.md` §16.2 is where
the container supervisors' own row is decided.

**When a job wants it.** When the work is a SEQUENCE OF SMALL STEPS SPREAD OVER
TIME and the waiting is most of the elapsed time — a container supervision
polling for half an hour, a chunked backfill, anything that would otherwise be
an in-process `while` loop holding one of `POOL_SIZE` slots while it sleeps. The
gain is exactly that slot: between passes the run occupies no worker capacity at
all.

**What it costs.** One claim round trip per pass, plus a replay of every memo
the handler still reads before it advances. That is LINEAR in the pass count —
which is the property to protect, and the one the alternative loses:

| shape                                 | per-pass cost                                                                                     | over N passes                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| an in-process `while` + `await`       | nothing extra, but ONE worker slot held throughout                                                | 1 slot × the whole duration                              |
| `step.sleep` between un-memoized work | a replay of every earlier step **plus a re-execution of every un-memoized call before the sleep** | **O(N²)** — measured at 4 sleeps → 10 polls (MOTIR-3763) |
| `deferRun`                            | one claim, plus the memos the handler reads                                                       | O(N), and no slot held between passes                    |

**⚠️ IT IS NOT `step.sleep`, and choosing wrong is silent.** Both release the
claim and refund the attempt, so a row deferred and a row slept look identical.
They differ in what the HANDLER may assume:

|                             | `step.sleep`                               | `deferRun`                      |
| --------------------------- | ------------------------------------------ | ------------------------------- |
| writes to `job_step`        | a `sleep` checkpoint, keyed by the step id | nothing                         |
| where the next pass resumes | back into the same place in the same loop  | at the top                      |
| who remembers the state     | the step ledger                            | **the handler, in its own row** |
| reported by `onOutcome` as  | `yielded`                                  | `deferred`                      |

Reach for `step.sleep` when the wait sits inside a short, already-memoized
sequence and the replay is cheap. Reach for `deferRun` when the loop is the
work.

**⚠️ A DEFER IS A SUSPENSION, NEVER A PATH OUT OF THE WORK.** It is a THROW, so
it unwinds through every `try`/`finally` between the call and the worker — and
§15.4 recorded what that costs a supervision that tears down in a `finally`:
_"a yielding poll loop would have called `settleIndexContainer` on its first
suspension and torn down the container it was watching."_ A handler that defers
must not have teardown in a `finally` above the call. The supervision driver's
answer is structural rather than a guard (§16.4): it has no `finally` at all,
and teardown is reachable only from an explicit terminal transition.

**The ledger needs nothing, and that is worth knowing rather than re-deriving.**
`executeWithLedger` writes `job-run:start` inside a memoized step and
`job-run:succeeded` only when the handler RETURNS. A deferred pass throws, so it
writes no success row; the next pass replays the memoized start. A supervision
that defers a hundred times and settles on the hundred-and-first therefore
leaves ONE `job_run` row, `succeeded`, with the last pass's output, and nothing
in the dead-letter queue. `tests/jobs/engine-defer.test.ts` asserts the counts.

## Dead-letter queue

When a job exhausts its retry budget, `recordEngineTerminalFailure` writes a row
to `job_run_dlq` **in the same transaction** that flips the `job_run` to `failed` — so a failed
run and its replayable record always land together. The DLQ row captures
everything needed to replay: the `function_id`, the original `event_name` +
full `event_data` payload, the serialized `failure`, the `attempts` count, and
`first_failed_at` / `last_failed_at`. This is the durable operator surface
(the 1.6.5 dashboard's DLQ tab reads it). It used to sit beside a vendor failure
view that was available for deep tracing and was never the source of truth for
operator action; there is one surface now, and it is this one.

**Operator runbook.**

- **How DLQ rows appear** — automatically, once a job's retries are exhausted.
  Each row is one dead-lettered run. `replayed_at` is null until you replay it.
- **How to replay** — click **Replay** on the dead-letter row in the operator
  dashboard (see below). Under the hood the owner-gated `jobsDashboardService`
  calls `replayDLQ(dlqId, tx)` (`lib/jobs/dlq.ts`), which re-emits the original
  event — with a **re-shaped idempotency key** (see below) — and stamps
  `replayed_at` so the action is auditable.
- **How to replay a dead letter with NO workspace** — every `system.*` job writes
  its dead letters with `workspace_id` NULL, and the workspace **Dead letter** tab
  cannot take them (it replays rows of the active workspace, as a workspace Manager).
  Platform staff at `operator` level or above replay them from **System** → **Dead
  letters with no workspace** on the jobs dashboard (`/settings/workspace/jobs?tab=system`,
  or the same tab in the organization's _Job runs_ section). That list is every
  unreplayed row plus the ones replayed in the last seven days; **Replay** is absent
  on a replayed row. Under the hood `replaySystemDlqAction` calls
  `jobsDashboardService.replaySystemDLQ`, which runs `replayDLQ(dlqId, tx)` under
  `withSystemContext` — the same re-emit, key re-shaping and stamp as above — and
  refuses a caller below `operator` and a row that has a workspace (replay
  that one from its workspace's Dead letter tab). MOTIR-8083.

  ⚠️ **"A second click does nothing" holds only for a job that declares an
  idempotency template.** The dedup is the `(job_id, idempotency_key)` unique index,
  and a job with no template (`system.platform-meter-report` is one; `email.send`
  is not) has a NULL key and nothing to collide on, so replaying the same row twice
  runs it twice. For the meter report that is harmless (its receiver accepts a
  duplicate), which is why the System tab takes **Replay** off a row once it is
  replayed instead of relying on the dedup to absorb a second press.

- **What a second click does** — nothing, and it says so. The row is already
  replayed, its key is already taken, and the dashboard toasts _"Already
  replayed"_ rather than an error; `replayed_at` keeps the time of the replay
  that actually queued a run (MOTIR-3730).
- **When NOT to replay** — if the failure was a bad payload or a since-removed
  code path, replaying just re-fails. Fix forward first; replay only transient
  infrastructure failures (provider outage, expired upstream token now renewed).

**Disposing of a standing dead letter.** A row nobody replays stands for ever:
nothing else in the system replays, discards or expires it. So every row needs
a verdict, taken from its `failure`, and one of two dispositions (the rule
MOTIR-5844 applied to the 1,381 rows that had accumulated by 2026-09-21):

- **Replay** it (a system job's row: from the System tab, see above) — only when the
  failure was transient AND the run is still wanted. A cron tick is almost never still wanted, because every later tick
  already ran; a superseded run (an index of a repository that has been indexed
  since) is not either. **Replaying `email.send` sends real mail**, late, to
  real people — decide that about the recipients, not about the row.
- **Otherwise, export it and delete it.** Export the rows first (they are the
  only record of the failure), then `DELETE` them, guarded by the
  `last_failed_at` of the newest row you read so a dead letter that arrives
  meanwhile is not swept up. **Do not stamp `replayed_at` by hand**: a row
  with it set always means the event was actually published (`lib/jobs/dlq.ts`),
  and a stamp without a replay makes that column lie.

A fault that is still reproducing is not a disposal question at all — it is a
bug to fix, and the dead letters it produced are disposed of after the fix.

**The standing-depth filer holds you to this (MOTIR-5869).**
`system.dlq-standing-depth-sweep` runs daily at 07:00 and files ONE bug, into
the Motir meta project's bug destination as the system principal, for each job
function whose OLDEST unreplayed row last failed more than seven days ago. The
bug names the function, the standing count and the oldest `last_failed_at`, and
points here. While that bug exists the sweep files nothing more for the
function; **closing the bug does not re-arm it** — only draining the function's
unreplayed rows to zero does, after which a new standing row files again. The
sweep never closes its own bug. It is a different signal from the event path
(a terminal failure → Sentry → a bound monitor's bug): that one says _a job is
failing_, this one says _nobody has disposed of its failures_.
`docs/decisions/dead-letter-standing-depth-filing.md` is the decision.

**Idempotency on replay (1.6.6).** A replay re-emits the original event but
**re-shapes its idempotency key** to `{original}:replay:{dlqId}`. This is
deliberate: an operator replays precisely when they've fixed a transient failure
and want the job to run **now** — but the original key is, by definition, already
deduped, so re-emitting it unchanged (the 1.6.4 behaviour) was silently
**dropped**, while the dashboard still toasted success and stamped `replayed_at`.
Re-keying makes the replay a genuinely new run that actually executes, so the
Replay button does what it says. (It was the vendor's expiring window that
dropped it then; it is the `(job_id, idempotency_key)` index that would drop it
now — the same silent no-op wearing different clothes, which is why the re-shape
survived the migration.) The new key is derived from the
**DLQ row id**, so a double-click of Replay on the same row still dedups to one
re-run (no double-delivery), while a genuinely new failure replays
independently. A job with **no** idempotency key was always replayed
unconditionally and is unaffected. See `PRODECT_FINDINGS.md` #40.

**And the second click is REPORTED, not raised (MOTIR-3730).** The dedup above is
enforced by the `(job_id, idempotency_key)` partial unique index, so for as long
as the engine has routed jobs the second replay of one row raised a `P2002` out of
the dashboard's Server Action — a Prisma constraint name shown to an operator who
had done nothing wrong. `replayDLQ` now enqueues through
`jobQueueRepository.createIfAbsent` (Prisma's `INSERT … ON CONFLICT DO NOTHING`)
and returns a discriminated `ReplayDLQResult`: `replayed`, or `already-replayed`
with nothing written and `replayed_at` untouched. Nothing about the dedup itself
changed. **The reason it is absorbed at the INSERT and not caught as a `P2002`:**
`replayDLQ` runs inside the transaction the dashboard service opens and goes on
using, and a raised unique violation aborts that whole transaction — every later
statement answers `25P02 current transaction is aborted` and the `COMMIT` then
rolls back while reporting success. `dispatchEventToEngine` and `enqueueScheduled`
may catch their own violations only because each wraps its insert in a
one-statement `withSystemContext` transaction of its own.

## Event-level idempotency on the Postgres engine (MOTIR-3459)

`defineJob`'s `idempotency` option is an expression evaluated against the
triggering event. **`email.send` is the only job in the tree that declares one**,
as `'event.data.idempotencyKey'`. The engine evaluates it in
`lib/jobs/engine/idempotency.ts`. (The syntax is the vendor's CEL subset, kept so
that not one of the 24 definitions had to change when the engine took over.)

**Which templates the resolver accepts.** Exactly one form: `event.data.<field>`,
one level deep. **Anything else THROWS at registration** — as the definition
module is evaluated, so every process that loads the registry fails loudly. That
is deliberate and is the opposite of the tempting behaviour: a resolver returning
`null` for a template it does not recognise would let a future job keep its
`idempotency` option, keep passing review, and quietly stop deduplicating. The
symptom of that is a second password-reset email to a real person, on the retry
path nobody exercises by hand. To support a richer template, extend the resolver
and its test together — never drop the option.

A missing or non-string VALUE resolves to `null`, which means "do not dedupe".
That is not the same silent arm: the template has already been validated, so it
means the EVENT carried no key. Deduping on a synthesised placeholder would
collide every such event with every other one and drop all but the first.

**How it dedupes: a constraint, not a lookup.** The resolved key is denormalised
onto `job_queue.idempotency_key` at enqueue, under a PARTIAL UNIQUE index on
`(job_id, idempotency_key) WHERE idempotency_key IS NOT NULL`, and a `P2002` is
read as "already enqueued". A check-then-insert would be a read-derived write
with a race in the middle, and the race here is two clicks on one button. This is
the same pattern the dispatcher already applies to its `(event_id, job_id)`
constraint.

### ⚠️ Engine dedup is UNBOUNDED where the vendor's was WINDOWED — chosen, not inherited

**This is a real difference in observable behaviour, and it was decided rather
than absorbed.** The vendor deduped same-key events inside a window; a unique
constraint dedupes forever.

Forever is the better behaviour for the keys actually in use — a password-reset
token and an invite token should each produce ONE email, not one per window — and
it is race-free where a windowed query is not. It is recorded here because
MOTIR-3413's scope boundary says no job's observable behaviour changes, and an
argued exception written down on the day it is made is a decision, while the same
exception found six months later by someone comparing lanes is a bug report. If a
window is ever wanted instead, that is its own decision and it needs the window's
number and where the number came from.

**Since MOTIR-8540 the horizon is 30 days, not forever.** The daily
`system.job-queue-retention` pass deletes `succeeded` queue rows older than
`JOB_QUEUE_RETENTION_MS`, and a deleted row no longer holds its key. Why that is
safe for every key in use, and the rule for a dedup that must outlive the
window, is `docs/decisions/job-queue-foundation.md` §17.

**A DLQ replay is not affected on either lane.** `lib/jobs/dlq.ts` re-shapes the
key to `{original}:replay:{dlqId}` before re-emitting, on the Inngest arm AND the
engine arm. The engine arm had nothing to be dropped by until dedup existed;
replaying with the original key would now be swallowed as a duplicate and hand
the operator a success toast for a run that never happened.

## Cutting a job over — HISTORICAL (there is one lane)

> ⚠️ **THIS SECTION DESCRIBED A MIGRATION THAT IS FINISHED** (MOTIR-3418 removed
> the mechanism). It is summarised rather than deleted because the FAILURE MODES it
> documented were paid for four times and generalise past the switch that produced
> them.
>
> **What it was.** `MOTIR_POSTGRES_JOB_IDS`, a comma-separated set of `defineJob`
> ids on the `motir-core` Fly app. An id in the set ran on the Postgres engine; an
> id absent from it ran on the vendor, and ABSENT was the default — a safety
> property, because the only way onto the new engine was for someone to name a
> job. `lib/jobs/engine/cutover.ts` read it live on every routing decision, so a
> job moved, and moved back, without a deploy.
>
> **The three things it cost, each worth carrying forward:**
>
> 1. **A DECLARATION IS HALF A CHANGE.** The census (`lib/jobs/engine/census.ts`)
>    listed each job's intended lane in reviewed code; the SECRET decided the
>    actual one. Four jobs drifted in ~34 hours (MOTIR-3682, MOTIR-3688,
>    MOTIR-3709) — each declared correctly and never deployed, each running on the
>    wrong engine while every code-side signal read green. The fix was
>    `reconcileLanes()`, a start-up warning plus a daily dead-letter (MOTIR-3716).
>    **The general form: when a property is split across a pull request and an
>    operator action, something in the running process has to compare the two.**
> 2. **ROUTING AN ID THE IMAGE DOES NOT HAVE ROUTES IT NOWHERE.** `fly secrets
set` restarts the machines on the CURRENT release, not on `main`, so
>    deploy-then-route was the only correct order and the window where code led
>    the secret was REQUIRED rather than tolerated. **The general form: a
>    configuration read at boot is about the image that is running.**
> 3. **A NEW JOB WAS NEVER COVERED BY EITHER.** A job added after the last wave
>    was absent from the secret by construction, so it silently stayed on the old
>    lane. That is the class the three bugs above all belong to, and it is exactly
>    the class a per-job switch creates.
>
> **None of it applies now.** A job runs on the engine because there is nowhere
> else; adding one to `lib/jobs/registry.ts` and deploying is the whole operation.

## Operator dashboard

`/settings/workspace/jobs` (Subtask 1.6.5) is the in-app surface for the ledger
above, and since MOTIR-3418 it is the ONLY one — there is no vendor dashboard to
fall back to. It's a
workspace-settings sub-page (a "Job runs" link under the sidebar's Settings
group) backed by `lib/services/jobsDashboardService.ts`.

**Tabs.**

- **Recent runs** (default) — every `job_run` for the active workspace,
  newest-first, 50 per page. Columns: status pill (succeeded / failed /
  running), function, event, attempts, started, duration, and the failure's
  first line (full JSON via the row's **View** dialog). A status-filter row
  (All / Succeeded / Failed / Running) narrows the list.
- **Dead letter** — the workspace's `job_run_dlq` rows, newest-failure-first.
  The tab carries a badge with the count of **not-yet-replayed** entries.
  **Replay** is gated to the workspace **owner** (others see a disabled button
  with a tooltip); **View** opens the failure + the replayable event payload.
- **System** — visible only to platform staff: an account whose
  `User.platformRole` is `support` or above (`lib/jobs/platformStanding.ts`). Same
  shape as Recent runs but spans **all** workspaces, including untenanted system
  jobs (`workspace_id IS NULL`). Replaying a dead letter with no workspace from it
  needs `operator` or above. Both are read fresh on every request, so a revoked
  role loses the tab on the next page load; roles are granted out-of-band, per
  `docs/decisions/platform-staff-auth.md` §6 (MOTIR-8196).

  _Migration note:_ `PLATFORM_ADMIN_EMAIL` was removed with no fallback; platform
  staff are granted a role instead. Setting the variable now does nothing.

**Scoping.** Tenant reads run under `withWorkspaceContext`, so the `job_run` /
`job_run_dlq` RLS policies scope every row to the active workspace (the repo
also filters by `workspace_id` explicitly, so the scope holds in dev/CI where
the superuser bypasses RLS). The System tab is the one `withSystemContext` read.

**No realtime in v1.** There is no polling or websockets — a **Refresh** button
reloads the data. Auto-refresh is deferred to a holistic reporting pass in
Epic 6 (PRODECT_FINDINGS #37).

## Scheduled jobs

A job runs on a schedule instead of an event when you give it a `cron`:

```ts
export const dailyHealthCheck = defineJob(
  { id: 'system.daily-health-check', cron: '0 9 * * *', retryPolicy: 'none' },
  () => ({ ok: true }),
);
```

**There IS a scheduler now, and it is not a service.** This line used to read
_"the hosted cron trigger means there's no separate scheduler service to run"_,
and the constraint it described has gone rather than the sentence having been
wrong: a **tick inside the existing worker process**
(`lib/jobs/engine/scheduler.ts`) turns a cron expression into a `job_queue` row.
It adds no machine, no process and no environment variable — which is why the
correction is worth stating rather than deleting.

### The registered schedules

This is every id `jobSchedules()` (`lib/jobs/schedules.ts`) returns, with its cron —
32 jobs. The cron is the definition's; a reason for the time a job runs lives in
its own header in `lib/jobs/definitions/`, not here.

**The cadence rule.** A `system.*` job that fires more than once an hour fires on
exactly `*/5 * * * *` (`SUB_HOURLY_CADENCE`) unless its id is named in
`SUB_HOURLY_CADENCE_EXCEPTIONS` with a reason — and that map is empty today. Hourly and
slower jobs keep whatever cron their own definition argues for.
`tests/jobs/schedule-cadence.test.ts` asserts it. It replaced the `:00`/`:30`
cluster rule (MOTIR-3314), which existed so the database could sleep between ticks.
The job worker polls Postgres every ≤ 5 s, so the database is always on and the
cluster bought nothing. The why is
[`docs/decisions/always-on-database-job-cadence.md`](decisions/always-on-database-job-cadence.md)
(MOTIR-6893), the amendment that supersedes the cluster clauses of
[`application-hosting.md` §21](decisions/application-hosting.md).

**Every 5 minutes**

| job                                         | cron          |
| ------------------------------------------- | ------------- |
| `system.agent-instance-sweep`               | `*/5 * * * *` |
| `system.ci-runner-provision-sweep`          | `*/5 * * * *` |
| `system.ci-runner-reap`                     | `*/5 * * * *` |
| `system.code-graph-drift-sweep`             | `*/5 * * * *` |
| `system.code-graph-index-catch-up`          | `*/5 * * * *` |
| `system.fleet-debit-monitor`                | `*/5 * * * *` |
| `system.migrate-onboarding-sweep`           | `*/5 * * * *` |
| `system.impersonation-expiry-sweep`         | `*/5 * * * *` |
| `system.monitor-issue-reconcile`            | `*/5 * * * *` |
| `system.plan-target-lock-sweep`             | `*/5 * * * *` |
| `system.public-address-certificate-refresh` | `*/5 * * * *` |
| `system.pull-request-reconcile`             | `*/5 * * * *` |
| `system.run-liveness-sweep`                 | `*/5 * * * *` |
| `system.supervision-sweep`                  | `*/5 * * * *` |

**Hourly**

| job                                 | cron         |
| ----------------------------------- | ------------ |
| `system.abandoned-plan-sweep`       | `0 * * * *`  |
| `system.filter-subscription-tick`   | `0 * * * *`  |
| `system.organization-erasure-sweep` | `0 * * * *`  |
| `system.auto-plan-cadence-tick`     | `30 * * * *` |
| `system.ci-actions-gate-sweep`      | `30 * * * *` |
| `system.work-item-embedding-sweep`  | `17 * * * *` |

**Daily (UTC)**

| job                                        | cron         |
| ------------------------------------------ | ------------ |
| `system.account-erasure-sweep`             | `0 3 * * *`  |
| `system.attachment-gc`                     | `30 3 * * *` |
| `system.rate-limit-sweep`                  | `0 4 * * *`  |
| `system.automation-retention-sweep`        | `30 4 * * *` |
| `system.code-graph-offboard-sweep`         | `0 5 * * *`  |
| `system.data-export-expiry-sweep`          | `30 5 * * *` |
| `system.public-hostname-reservation-sweep` | `45 5 * * *` |
| `system.job-run-reap`                      | `0 6 * * *`  |
| `system.job-queue-retention`               | `15 6 * * *` |
| `system.dispatch-run-sweep`                | `30 6 * * *` |
| `system.dlq-standing-depth-sweep`          | `0 7 * * *`  |
| `system.organization-retention-purge`      | `30 7 * * *` |
| `system.daily-health-check`                | `0 9 * * *`  |
| `system.organization-deletion-reminders`   | `0 9 * * *`  |

**Weekly (UTC)**

| job                                | cron        |
| ---------------------------------- | ----------- |
| `system.public-follow-digest-tick` | `0 9 * * 1` |

**Monthly (UTC)**

| job                           | cron         |
| ----------------------------- | ------------ |
| `system.ci-minutes-reconcile` | `30 5 3 * *` |

### Where the scheduler runs, and the guard that makes that safe

It rides the worker's claim loop, beside the claim rather than on a timer of its
own. A tick that runs late still enqueues the fire it OWED — every fire instant
is computed from the clock against the cron expression, never as "one interval
since the last tick" — so the tick's cadence decides latency and can never decide
which fire.

⚠️ **It refuses to start against an empty registry.** The engine's tables hold only
jobs whose definition module has been EVALUATED, and `scripts/worker.ts` carries a
side-effect `import '@/lib/jobs/registry'` that looks unused for exactly that
reason. A scheduler over an empty registry enqueues nothing, forever, in complete
silence — indistinguishable from a deployment with no cron jobs. So start-up
throws, naming the missing import, rather than proceeding.

### What a MISSED tick does — the catch-up policy

Every scheduled job declares a `catchUp` disposition beside its `cron`, and the
compiler will not let it omit one:

| disposition | on restart, the scheduler…                                    |
| ----------- | ------------------------------------------------------------- |
| `all`       | enqueues **every** fire owed across the gap, oldest first     |
| `latest`    | enqueues **only the most recent** owed fire                   |
| `skip`      | enqueues **nothing**; the next scheduled fire is the next run |

**Every scheduled job takes `latest`** — each is a convergent sweep, so one run
answers for every fire it missed. `system.ci-runner-provision-sweep` used to take
`skip`, an argument that held only while it ran every minute; at `*/5` it is
`latest` like the rest. No job takes `all` today.

**The per-job table and the reasoning live in
[`docs/decisions/job-queue-foundation.md` §11](decisions/job-queue-foundation.md),
and are deliberately not repeated here** — two copies of an argument disagree the
first time one is edited. §11 is the record; this section is the reference.

⚠️ **`retryPolicy` is not a catch-up licence.** `idempotent` says a handler may
safely run the same tick twice. It says nothing about whether a tick that is now
six hours _stale_ is worth running at all. The two are independent axes and every
scheduled job declares both.

### How a scheduled run is identified

- **On the ledger**, by `event_name = scheduled.{job_id}` — unchanged, and the
  key `jobScheduleHealthService` groups on.
- **On the queue**, by `job_queue.scheduled_for`: the cron FIRE INSTANT the row
  stands for, never the moment it was enqueued. A unique on
  `(job_id, scheduled_for)` is what guarantees **one run per tick regardless of
  how many workers are running** — the same NULL-never-equals-NULL property that
  keeps the `(event_id, job_id)` unique off scheduled rows, read the other way
  round. `run_at` is that same instant, so a caught-up run is claimable at once
  and the claim's `ORDER BY run_at` puts the oldest owed work first.

A handler cannot currently tell that it is running late: the engine hands a cron
run an empty payload, so `scheduled_for` sits on the row and never reaches `ctx`.
Every job today is a convergent sweep that does not need to know; the two that
would benefit are named in §11.6.

Cron jobs are uniform with event-triggered jobs in the ledger: the wrapper
records the `job_run` row's `event_name` as the synthetic `scheduled.{job_id}`
(a cron run carries no real triggering-event name), so the dashboard treats both
kinds the same, and a scheduled run that fails surfaces in the DLQ exactly like
any other job. `system.daily-health-check`
(`lib/jobs/definitions/dailyHealthCheck.ts`) is the reference example — it proves
the scheduled path end-to-end, and as of MOTIR-1970 it also carries the
**schedule-health probe** (see "Registration" below). `system.attachment-gc`
(`lib/jobs/definitions/attachmentGc.ts`, Subtask 5.2.7) is the first real
scheduled job: the daily orphan-attachment sweep (unlinked rows past the 7-day
safety window → blob, then row), cursor-bounded per run and idempotent, with
its `{ scanned, deleted, failed }` summary persisted as the run's `output`.

Cron jobs live in the `system.*` namespace (untenanted — `workspace_id` is null)
and are **not** emitted via `sendEvent`. The cron syntax is standard 5-field
(`min hour day month weekday`), parsed by `lib/jobs/cron.ts` and evaluated in
**UTC** — `previousFireAtOrBefore` is the one function that turns an expression
into an instant, and every fire the scheduler owes is computed from the clock
against it rather than from "one interval since the last tick".

## The schedule-health probe — the failure mode to know about (MOTIR-1970)

`system.daily-health-check` runs the **schedule-health probe**
(`lib/services/jobScheduleHealthService.ts`). It walks every registered cron job
and fails the run when one has missed more than one consecutive tick,
dead-lettering with the offenders named in the message — which lands on
`/settings/workspace/jobs` → DLQ, the surface a person actually opens. Cron jobs
are the tripwire because they are the only ones whose silence is unambiguous: an
event-triggered job that never ran may simply never have been triggered.

**What an overdue verdict means now: a dead worker or a stalled scheduler.**
Check `fly status -a motir-core` for the `worker` process group, then the worker
log's `[job-scheduler]` lines. A cron expression edited to one that never fires
looks identical from here, so check the definition too.

`system.daily-health-check` declares `catchUp: 'latest'` for a reason that feeds
back into its own probe: under `skip`, a routine worker restart spanning 09:00
would leave it two ticks stale and its first act the next day would be to report
ITSELF overdue — a fault manufactured by the schedule rather than observed.

### ⚠️ HISTORICAL — the fault this probe was BUILT for, and why it cannot recur

The probe was written for a **stale app registry**, and that failure mode went
with the vendor (MOTIR-3418). It is recorded here because it cost a month and
because the shape recurs whenever a second system holds a copy of what this one
knows.

**The vendor only invoked functions it had been TOLD about.** Registration was a
`PUT` to `/api/inngest`; adding a job to `lib/jobs/registry.ts` and deploying was
not enough on its own. When the cloud's registered function list fell behind the
deployed build, every function added since was **dead, silently**: the event was
accepted, the send succeeded, no run was created, no `job_run` row was written,
and nothing errored anywhere. A dead job was indistinguishable from a job nobody
triggered.

That happened. Production ran from 2026-07-02 to 2026-08-01 with five jobs
consuming nothing — `system.code-graph-index`, `system.code-graph-refresh`,
`system.auto-plan-cadence-tick`, `system.ci-minutes-reconcile`,
`system.ci-actions-gate-sweep`. **Root cause:** the vendor's Vercel integration
probed the per-deployment `motir-core-<hash>.vercel.app` URL, and the Vercel
project ran Deployment Protection at `all_except_custom_domains`, so that URL
answered with a 302 into Vercel's SSO login. The probe never reached the app.
Only the custom domain `app.motir.co` was exempt. (MOTIR-66 recurring — that card
fixed the PREVIEW probe with a protection-bypass secret; production deployment
URLs were never covered.) Two mechanisms then closed it: a deploy-time sync step
that failed the job on a non-200, and this probe.

**It cannot recur, and the reason is structural rather than careful.** There is no
second registry: `scripts/worker.ts` imports `lib/jobs/registry.ts` out of the
image it is running, so a job is registered by being deployed and cannot be
registered any other way. The deploy-time sync step, the manual
`inngest-sync.yml` workflow and the composite action it called are all deleted.

**The probe stays where it is.** It lives in `system.daily-health-check`
specifically because that job is OLD (2026-06-01) — under the old fault, an old
job checking on new ones was the only checker a stale sync could not strand. That
particular argument has expired with the fault, but the placement is still right
for a plainer reason: this job already has a loud, human-visible failure surface,
and a new checker would need one built for it.
