# Runbook — restoring the production database (Neon PITR)

**Owner:** Yue (the only account with Neon console + Fly access today).
**Scope:** motir-core's production Postgres. Nothing here applies to motir-ai or
motir-gateway, which are separate Neon projects with their own retention.

**Executed and measured 2026-08-26 (MOTIR-1164).** Every number below is a
reading taken that day, not a quote from Neon's marketing pages. Where a figure
is a platform ceiling it says so; where it is a wall-clock measurement it names
what was timed.

---

## §1 — What the production database actually is

Read off the platform on 2026-08-26 and **confirmed against what the running app
connects to**, not inferred from an older card. This is the fact the previous
version of this card got wrong: the database moved _account_ during the
Vercel → Fly migration (`docs/decisions/application-hosting.md` §9/Q8), so a
remembered project name (`prodect-db`, invoiced through Vercel) is no longer the
right dashboard.

|                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Neon organization                 | **`moooon`** — `org-autumn-mountain-12023030`, plan **`launch`** (`launch_v3`), `managed_by: console` — i.e. **direct**, no longer a Vercel-managed marketplace resource                                                                                                                                                                                                                                                                                                                                                                         |
| Project                           | **`motir-core`** — `snowy-truth-13928044`, region `aws-us-east-1`, Postgres **18**                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Branch                            | **`main`** — `br-cool-king-auw0r6up`, the default (root) branch, and the **only** branch. Logical size 293 MB                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Endpoint                          | `ep-billowing-wildflower-au5s16ri` (`…c-10.us-east-1.aws.neon.tech`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| What the app connects as          | `DATABASE_URL` → the **`-pooler`** host as **`motir_app`** (NOBYPASSRLS — RLS executes in production); `DATABASE_URL_UNPOOLED` → the direct host as `neondb_owner`, which is what `release_command`'s `prisma migrate deploy` uses                                                                                                                                                                                                                                                                                                               |
| Where those live                  | **Fly secrets on `motir-core`** (`flyctl secrets list -a motir-core` — 51 secrets, `DATABASE_URL` digest `f1e463b6…`, `DATABASE_URL_UNPOOLED` digest `9efe4720…`). **Not** a Vercel environment variable                                                                                                                                                                                                                                                                                                                                         |
| One more consumer outside the app | the repo secret `SEED_DATABASE_URL`, read by four `workflow_dispatch`-only workflows (`backfill-boards.yml`, `backfill-ci-state.yml`, `backfill-fix-reason.yml`, `converge-ejected-cards.yml`). Any card that repoints `DATABASE_URL` must repoint it too. **After the AWS cutover's go it is deleted and stays unset** (motir-infra `docs/core-cutover.md`, step 9): production is then RDS, which admits no GitHub runner, so each workflow skips with a notice. Never point it at RDS; a backfill route to production after go is MOTIR-10465 |

**Confirmation method** (repeat it rather than trusting this table after a
hosting change): read the hostname — never the value — from inside a running
machine, e.g.
`node -e 'console.log(new URL(process.env.DATABASE_URL).hostname)'` via
`fly ssh console -a motir-core`, and match it against
`GET /api/v2/projects/{id}/endpoints`.

---

## §2 — RPO: how far back we can go

**7 days, and that is the ceiling of the plan we are on.**

`history_retention_seconds = 604800` on `snowy-truth-13928044` (read
2026-08-26). Within that window the restore point is **any timestamp or LSN** —
Neon keeps WAL, not nightly snapshots — so the effective RPO is _seconds_ of data
loss for anything discovered inside 7 days, and **total loss for anything
discovered after 8**.

Two ceilings that are not on Neon's pricing page and were established by probe:

- **Launch caps history retention at 7 days.** `PATCH /projects/{id}` with
  `1209600` (14 d) is refused: _"requested history retention seconds exceeds
  allowed maximum"_. Longer needs the Scale plan.
- **New Neon projects do not default to the cap** — the sibling projects sat at
  6 h. Read this setting on any new project rather than assuming it.

**There is no second backup.** No `pg_dump` runs anywhere on a schedule. If the
seven-day window is judged too short for a corruption that could go unnoticed
(the realistic case: a bad migration or a bad script noticed weeks later), the
fix is a periodic logical dump to object storage — **not carded yet**, and named
here so the gap is explicit rather than assumed away.

---

## §3 — RTO: how long a restore takes

Measured 2026-08-26 against this project.

| Step                                                           | Measurement                                                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create an ephemeral branch at a past timestamp, with a compute | API call returned **201 in 12.2 s**; Neon's own operations: `create_branch` 561 ms, `start_compute` 2.07 s, branch `ready` **1 s** after the request |
| Restore a branch in place (`POST …/branches/{id}/restore`)     | API returned in **6.7 s**; request → **verified query answering** in **12.4 s** total, of which 4.9 s was the compute cold start                     |
| First query against a freshly created branch                   | ~27 s end-to-end including tooling overhead (the Neon half of that was ~3 s)                                                                         |

**So the database half of a restore is seconds, and the RTO of an incident is
dominated by everything else**: deciding the restore point, and — see §5 —
reconciling the schema with the running image, which is a Fly deploy (minutes),
not a Neon operation.

Data volume did not move these numbers and will not: Neon's restore is a
metadata operation against shared storage, not a copy of the 293 MB.

---

## §4 — The procedure

### 4.0 Before anything: stop the writes you can

There is no maintenance mode. The closest lever is scaling the web group to zero
(`fly scale count app=0 -a motir-core`), which stops user writes but **also
stops the app**; the worker group writes too. For a targeted repair (one table,
one tenant) prefer §4.1 → §4.4 (copy the good rows out of a scratch branch) over
rewinding all of production.

### 4.1 Inspect first — an ephemeral branch, never a blind restore

This is the step that makes the whole thing safe: a branch at the candidate
timestamp is a full, writable copy that costs a few seconds and touches nothing.

```bash
K=$(cat ~/.config/neon/api-key-org)           # ORG-scoped key; ~/.config/neon/api-key is the old project-scoped one
curl -s -X POST "https://console.neon.tech/api/v2/projects/snowy-truth-13928044/branches" \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"branch":{"parent_id":"br-cool-king-auw0r6up",
                 "parent_timestamp":"2026-08-25T20:54:00Z",
                 "name":"pitr-inspect-<incident>"},
       "endpoints":[{"type":"read_write"}]}'
```

The response carries the new branch id and its endpoint host. Neon resolves the
timestamp to an LSN and reports the resolved `parent_timestamp` — check it: a
request for `20:54:00Z` resolved to `20:53:56Z`, i.e. **the restore point is the
last commit at or before the timestamp**, not the timestamp exactly.

### 4.2 Verify the branch WITHOUT moving the credential

The branch inherits the same roles and passwords as `main`, so the only thing
that differs is the host. Substitute the hostname **inside** the running machine
and the password never leaves it:

```js
// run via `fly ssh console -a motir-core`; see docs note in §7
const u = new URL(process.env.DATABASE_URL_UNPOOLED);
u.hostname = 'ep-<branch-endpoint>.c-10.us-east-1.aws.neon.tech';
// connect with /app/node_modules/pg and run read-only checks
```

Check, at minimum: `count(*)` on the affected table against the same count on
`main`; the specific rows the incident is about; and
`select migration_name from _prisma_migrations order by finished_at desc limit 1`
— that last one is §5.

### 4.3 Decide: extract, or rewind

- **Extract** (preferred, and the default for anything narrower than "the whole
  database is wrong"): copy the good rows from the scratch branch into
  production. No downtime, no schema problem, no loss of everything written
  since the incident.
- **Rewind** production only when the damage is broad and recent. It **discards
  every write since the restore point** — for this database that is on the order
  of 117 work items and 327 comments per day (measured 2026-08-26).

### 4.4 Rewinding the root branch

> ⚠️ **`main` is a protected branch, and a protected branch REFUSES a restore.**
> Measured 2026-08-26 (MOTIR-3617), not quoted from the docs — the same call
> that returns `200` on an unprotected branch returns
> `422 {"message":"cannot reset protected branch"}` on a protected one. The
> rewind is therefore a three-step sequence, not one call. Do not skip step 3.

**Step 1 — un-protect.** From here until step 3, production is deletable again;
that window is the price of the rewind, so keep it short and do not walk away.

```bash
curl -s -X PATCH "https://console.neon.tech/api/v2/projects/snowy-truth-13928044/branches/br-cool-king-auw0r6up" \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"branch":{"protected":false}}'
```

**Step 2 — restore.**

```bash
curl -s -X POST "https://console.neon.tech/api/v2/projects/snowy-truth-13928044/branches/br-cool-king-auw0r6up/restore" \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"source_branch_id":"br-cool-king-auw0r6up",
       "source_timestamp":"2026-08-25T20:54:00Z",
       "preserve_under_name":"pre-restore-<incident>"}'
```

**Step 3 — re-protect. This is not optional and it is not cleanup.** Until it
runs, the guard this database relies on is off. Re-assert it by reading the
branch back, not by trusting the `PATCH` response:

```bash
curl -s -X PATCH "https://console.neon.tech/api/v2/projects/snowy-truth-13928044/branches/br-cool-king-auw0r6up" \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"branch":{"protected":true}}'
# then, as a separate call:
curl -s "https://console.neon.tech/api/v2/projects/snowy-truth-13928044/branches/br-cool-king-auw0r6up" \
  -H "Authorization: Bearer $K" | grep -o '"protected":[a-z]*'
```

- **⚠️ `423` between these steps is a queue, not a refusal.** Back-to-back branch
  operations return
  `423 {"message":"project already has running conflicting operations, scheduling of new ones is prohibited"}`
  while the previous one settles. Observed repeatedly on 2026-08-26. Under
  incident pressure this reads as "the restore is blocked" and invites a wrong
  diagnosis — it is not `422`, and the fix is to retry the same call a moment
  later. Poll `GET …/branches/<id>` until `current_state` is `ready`.
- **`preserve_under_name` is not optional in practice.** It keeps the
  pre-restore state as a branch, which is the only undo this operation has. Use
  it every time.
- The branch's endpoint keeps its host, so **`DATABASE_URL` does not change** and
  no Fly secret needs setting. The compute restarts; connections in flight drop.
- **PITR by timestamp only works within a branch's own history.** `main` is the
  root branch and has 7 days of it. A _child_ branch's history starts at its
  creation — to take a child further back you must pass `source_branch_id`
  pointing at `main` (which is exactly how the drill in §6 was run).

### 4.5 Clean up

Delete every scratch branch when the incident closes — including the
`preserve_under_name` one, once the outcome is accepted. Branches cost storage
and the Launch plan's limit is 5000 (not a real constraint; the tidiness is):

```bash
curl -s -X DELETE -H "Authorization: Bearer $K" \
  "https://console.neon.tech/api/v2/projects/snowy-truth-13928044/branches/<branch-id>"
```

**If that call answers `422 {"message":"cannot delete protected branch"}`, you
have just aimed it at production.** `main` (`br-cool-king-auw0r6up`) is one
character away from most scratch ids and is protected precisely so this typo is
refused instead of obeyed (MOTIR-3617). Read the id, do not retry the call.

---

## §5 — ⚠️ The half that is not Neon's: the schema will have moved on

`fly.toml`'s `release_command` runs `prisma migrate deploy` in a temporary
machine on **every** deploy, before any new machine takes traffic. So the
database schema advances with the code, and **rewinding the data rewinds the
schema with it** — to a shape the running image does not expect.

This is not theoretical. Measured on the 24-hour drill branch, 2026-08-26:

- **5 migrations** had been applied to `main` since the restore point.
- **2 tables did not exist** at the restore point — `email_delivery`,
  `plan_revision` — both of which the running image queries.

A 24-hour rewind of this database, done in isolation, produces a running app
whose first request to a delivery-status page or a plan revision throws
`relation does not exist`. Restoring the data and matching the code are **two
different problems and only one of them is Neon's.**

**What the operator does, in order:**

1. After the restore, read the restored `_prisma_migrations` tail (§4.2) and
   diff it against `prisma/migrations/` on the deployed commit.
2. **If the restored schema is BEHIND the running image** (the common case —
   a rewind): re-run the migrations, which is what a deploy already does. The
   cheapest form is `fly deploy -a motir-core` on the **same** commit that is
   already running: `release_command` re-applies the missing migrations and
   nothing else changes. Prefer this over hand-running `prisma migrate deploy`.
   ⚠️ A migration that is not idempotent-safe on a rewound database (one that
   backfills, or that drops a column re-created by the rewind) needs reading
   before it is re-applied — `migrate deploy` will not stop to ask.
3. **If the restored schema is AHEAD of the image you want to run** (you also
   rolled the app back): redeploy the image whose migrations match the restore
   point, rather than rolling the schema forward. `fly releases -a motir-core`
   lists them.
4. Either way, **check the app after** — the smoke in MOTIR-1124's card is the
   right shape (sign in, open a work item, post a comment).

---

## §6 — The drill that was actually performed (2026-08-26, MOTIR-1164)

Not "backups are enabled". A restore was executed twice and verified against
known records.

**Baseline on `main`, 20:54:13Z:** 92 tables · `work_item` 3600 · `comment`
30 534 · `job_run` 200 545 · newest work item **MOTIR-3608** @ 20:25:49Z ·
oldest **TAQ-1** @ 2026-06-06 · 117 work items created in the last 24 h, 178 in
the last 48 h.

**Drill 1 — ephemeral branch at T−24 h** (`2026-08-25T20:54:00Z`, resolved
`20:53:56Z`, LSN `0/3E6733E0`):

| Check            | Expected              | Read on the branch                            |                                  |
| ---------------- | --------------------- | --------------------------------------------- | -------------------------------- |
| `work_item`      | 3600 − 117 = **3483** | **3483**                                      | ✅ exact                         |
| newest work item | ≤ the restore point   | MOTIR-**3490** @ 2026-08-25 20:35:14Z         | ✅ (MOTIR-3608 correctly absent) |
| oldest work item | unchanged             | TAQ-1 @ 2026-06-06 00:37:23.683Z              | ✅ byte-identical                |
| tables           | fewer                 | 90 (`email_delivery`, `plan_revision` absent) | ✅ — see §5                      |

**Drill 2 — `POST …/restore` on that branch, sourced from `main` at T−48 h**
(`2026-08-24T20:54:00Z`), exercising the same endpoint §4.4 tells the operator to
call:

| Check                     | Expected              | Read after the restore                               |          |
| ------------------------- | --------------------- | ---------------------------------------------------- | -------- |
| `work_item`               | 3600 − 178 = **3422** | **3422**                                             | ✅ exact |
| newest work item          | ≤ the restore point   | MOTIR-**3429** @ 2026-08-24 00:22:25Z                | ✅       |
| tables / latest migration | further behind        | 87 · `20260822010000_drop_code_graph_pending_change` | ✅       |
| RTO                       | —                     | **12.4 s** request → verified query                  | measured |

Both drill branches (and the `preserve_under_name` backup Neon created) were
deleted afterwards; the project is back to one branch, `main`. **Production was
read-only throughout** — no write, no restore, and no secret was touched, so
nothing needed rotating.

---

## §7 — Standing notes

- **The org-scoped Neon key is `~/.config/neon/api-key-org`** (`0600`, no
  trailing newline). `~/.config/neon/api-key` is the older project-scoped key.
  Neon has no read-only key tier: the key that reads retention can also change
  it.
- **Reading production is agent-runnable** without moving a credential — run the
  query inside a Fly machine over its own env. `fly ssh console -C` mangles
  quotes, so base64 the script. Never `printenv` wholesale (a multi-line secret
  defeats per-line truncation).
- **A system-scoped table needs the GUC or the read is blind.** `motir_app` is
  NOBYPASSRLS and tables like `email_delivery` FORCE RLS, so a plain `SELECT`
  returns 0 rows and no error. Wrap verification reads in
  `begin; select set_config('app.system_admin','true',true); … ; rollback;`.
- **A restored branch's compute may run a newer Postgres minor than the one it
  was branched from** — observed 18.6 on the drill branch against 18.4 on
  `main`. Harmless here; worth knowing before it reads as corruption.
- **`main` IS a protected branch as of 2026-08-26** (MOTIR-3617); it was
  `protected: false` when this runbook was first written. What that flag was
  measured to do, on this project, that day:

  | call against a protected branch         | result                               |
  | --------------------------------------- | ------------------------------------ |
  | `DELETE …/branches/{id}`                | `422 cannot delete protected branch` |
  | `POST …/branches/{id}/restore`          | `422 cannot reset protected branch`  |
  | the same two calls, branch un-protected | `200`                                |

  Both readings come from a control branch that was protected, called, then
  un-protected and called again with an identical body, so the flag is the only
  variable. The `DELETE` was deliberately **not** aimed at `main` itself. The
  restore refusal is why §4.4 is now three steps.

- **Protection does not currently enforce anything about IP.** The project's
  allow-list is empty with `protected_branches_only: false`, so that half of the
  feature buys nothing here today. Do not cite it as a control that exists.

## §8 — What this runbook does not cover

- **Blob storage (Tigris).** Attachments are not in Postgres and a database
  restore does not restore them; a work item restored with an attachment row may
  point at an object that still exists (Tigris was not rewound) or, after a
  deletion incident, at one that does not.
- **Anything outside this project** — motir-ai (`hidden-thunder-40380051`) and
  motir-gateway (`autumn-sky-90851862`) have their own Neon projects, both also
  at 7-day retention, and neither is covered by a drill. **Both are also
  `protected: false`** as of 2026-08-26; MOTIR-3617 protected only `motir-core`
  and knowingly left those two alone. Whether they warrant the same treatment is
  an open question, not an oversight.
- **A tested application-level rollback**, which is MOTIR-2516's card, not this
  one. §5 step 3 depends on it.
