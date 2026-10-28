# What breaks under the non-bypass runtime role — an inventory

**MOTIR-2514.** Measured 2026-08-10, on the branch that also lands MOTIR-2519 (the
`prodect_app` → `motir_app` rename), MOTIR-2513 (the two-client test harness) and
MOTIR-2512 (the tenant-root INSERT policies). It **fixes nothing**; its output is a
count, a root-cause grouping, and the cards that follow from it.

## The question

MOTIR-2435 plans to point production's `DATABASE_URL` at `motir_app`, so the workspace
RLS policies finally execute. Its original premise was that the obstacle was the test
suite's fixtures. **How much of what fails is application code rather than fixtures?** —
because those are two different kinds of problem. A failing fixture is test debt. A
failing `lib/` path is a production defect that would break a feature for every customer
on the day of the cutover.

## How it was measured

Four batches under `TEST_DB_APP_ROLE=1`, which points `@/lib/db` at `motir_app` while
fixtures and teardown stay on the owner:

| batch | directories                                               | tests    |   failed |
| ----- | --------------------------------------------------------- | -------- | -------: |
| 1     | `workspaces`, `projects`, `comments`                      | 178      |      131 |
| 2     | `boards`, `sprints`                                       | 229      |      200 |
| 3     | `workItems`, `integration/work-items`, `custom-fields`    | 559      |      469 |
| 4     | `notifications`, `attachments`, `labels-components-watch` | 259      |      201 |
|       | **total**                                                 | **1225** | **1001** |

Coverage: these directories are a cross-section, not the whole surface — **441 test files
import `@/lib/db`** in total. The classification below is stable across all four batches,
which is the reason for stopping here rather than running the rest; the failure profile
had converged by batch 2.

Frames were classified by the topmost non-`node_modules` stack entry:

```
cat b*.txt | grep -oE "❯ [^ ]+ (tests|lib|app|scripts)/[^ :]+" \
  | awk '{print $3}' | sed -E 's#^(tests|lib|app|scripts)/.*#\1#' | sort | uniq -c
```

→ **1044 `lib/`**, **730 `tests/`**.

## Finding 1 — the `lib/` failures are ONE defect, not many

Every one of the 1044 `lib/` frames resolves to a single file, and 1048 failure lines
name a single error:

```
NotAMemberError: User <id> is not a member of workspace <id>.
 ❯ Object.assertMembership lib/services/projectsService.ts:532:19
 ❯ Object.createProject    lib/services/projectsService.ts:225:5
```

The user **is** a member. The gate reads the membership through
`workspaceMembershipRepository.findByUserAndWorkspace`, which uses the `db` singleton —
no transaction, so no GUCs. Under RLS `membership_visible_active_or_own` requires
`"workspaceId" = current_setting('app.workspace_id')` **or**
`"userId" = current_setting('app.user_id')`; with neither bound both sides are NULL, the
row is invisible, and the lookup returns `null`. The gate reports that as "not a member".

**The codebase already knows.** A tx-aware sibling exists, and its docstring is explicit:

> Same lookup as `findByUserAndWorkspace`, but inside the caller's transaction so the
> `membership_visible` RLS policy … admits the row under the non-bypass `motir_app`
> role. Used by role-gated reads that MUST be correct in production …; **the db-singleton
> variant above returns NULL under RLS when no context is bound.**

So the fix is not new code — it is routing the gates through the variant that already
exists. **12 call sites, across 7 services**, all of them access gates:

| file                                      | sites |
| ----------------------------------------- | ----: |
| `lib/services/projectAccessService.ts`    |     3 |
| `lib/services/workspacesService.ts`       |     3 |
| `lib/services/workspaceInvitesService.ts` |     2 |
| `lib/services/workItemsService.ts`        |     2 |
| `lib/services/projectsService.ts`         |     1 |
| `lib/services/triageService.ts`           |     1 |

**Why this is the worst possible failure mode, and worth its own card.** It fails CLOSED
and it fails DISHONESTLY: the user is told they are not a member of a workspace they own.
Nothing logs an RLS denial, because there is no denial — the query succeeded and returned
nothing. A cutover would present as "permissions are broken for everyone", with an error
message pointing at membership data that is perfectly correct.

## Finding 2 — the `tests/` failures are volume, and they are mechanical

730 frames, all the same shape: a fixture seeds or asserts through `@/lib/db` with no
workspace context, so RLS hides its own setup. There is no defect here — the tests were
written against a connection where the policies were inert.

The remedy is the harness MOTIR-2513 already provides: fixtures move to `adminDb`. It is
per-file work with no design questions, and it is the reason `TEST_DB_APP_ROLE` is opt-in
rather than the default.

## Finding 3 — noise, called out so it does not inflate the numbers

- **6 × `EPERM: operation not permitted, open '…/node_modules/…'`** — this sandbox's
  hardlinked `node_modules`, not the product. Environmental.
- **1 × `[vitest-pool]: Worker forks emitted error` / `Worker exited unexpectedly`** —
  one worker died under batch 3's load. Environmental.
- **1 × `new row violates row-level security policy for table "workspace_membership"`** —
  a genuine RLS denial, and the ONLY one in 1001 failures. It is `addMember` running
  without a bound workspace context; the same root shape as Finding 1, one verb over.

No `P2025`, no SQLSTATE `42501` beyond that single case. **The RLS surface is far
narrower than the failure count suggests** — 1001 failures, one root cause, one variant.

## Is flipping `TEST_DB_APP_ROLE` to the default reachable?

**Not yet, and it is blocked on Finding 1, not on the fixtures.** Fixing the 12 gate call
sites removes ~1044 of the failures at a stroke. The remaining ~730 fixture failures are
what stands between that and a default flip, and they can be migrated directory by
directory behind the flag without ever red-lighting `main`.

## RE-MEASURED after MOTIR-2527 — the gates admit, and the layer behind them is now visible

**2026-08-10, same four batches, same flag, on the branch that lands MOTIR-2527.** The card's
own criterion was that the `NotAMemberError` count reach zero. It does.

| batch |    tests | failed (before → after) | `NotAMemberError` |
| ----- | -------: | ----------------------: | ----------------: |
| 1     |      178 |               131 → 108 |           131 → 0 |
| 2     |      236 |               200 → 202 |               → 0 |
| 3     |      676 |               469 → 581 |               → 0 |
| 4     |      259 |               201 → 207 |               → 0 |
|       | **1349** |         **1001 → 1098** |      **1048 → 0** |

Frames, by the same classification command: **1044 `lib/` → 143**, and `NotAMemberError`
does not appear once in any batch.

**But the total did not fall, and that is the finding.** Two things move underneath it. The
batches are bigger than in August's run (1225 → 1349 tests — other cards have landed since),
so the counts are not directly comparable. And more importantly:

### Finding 4 — the membership gate was MASKING a second layer of the same defect

The failures that replaced it are **not** the fixture debt Finding 2 predicted. The largest
single group is now `ProjectNotFoundError` (135), with **94 frames in
`lib/repositories/projectRepository.ts`**, plus 31 in `workItemsService` and 14 in
`projectTagsService`:

| error                           | count | where                                               |
| ------------------------------- | ----: | --------------------------------------------------- |
| `ProjectNotFoundError`          |   135 | `projectRepository.findById` on the `db` singleton  |
| `PrismaClientKnownRequestError` |   120 | mostly fixture writes with no bound context         |
| `AssertionError`                |    31 | downstream of the above                             |
| RLS denials (all tables)        |     4 | `workspace_membership` ×2, `project` ×1, `board` ×1 |

Same root cause, one layer down: `project`, `work_item` and `board` carry workspace-keyed RLS
policies of their own, and a service that opens with an unbound read of one of them fails
before any gate is consulted. `createWorkItem` and `getTriageItemDetail` are the clearest
cases — each starts with a `db`-singleton `findById`, so under the flag they now throw
`ProjectNotFoundError` / `WorkItemNotFoundError` and never reach the membership gate at all.

**Why the original inventory could not see this.** The membership gate was the FIRST unbound
read on essentially every path, so it consumed the failure and hid every read behind it. The
"1044 frames, one file, one error" result was true and was also a ceiling artefact: fixing the
gate did not remove 1044 failures, it removed 1044 _masks_. This is worth stating plainly
because the same shape will recur — each layer fixed will reveal the next, and a count that
does not fall is not evidence that the fix did nothing.

**Consequence for the chain.** The claim that flipping `TEST_DB_APP_ROLE` to the default is
blocked only on fixtures (MOTIR-2528) is no longer accurate: it is blocked on the application
reads above as well. That work is filed separately rather than absorbed into MOTIR-2527, whose
scope was the membership gates and the one `addMember` write.

## RE-MEASURED after MOTIR-2569 — the Finding-4 reads are bound, and the table above was mis-attributed

**2026-08-11, same four batches, same flag, on the branch that lands MOTIR-2569.**

### First, the correction — 94 of those frames are not what this document said they were

Finding 4's table reads `ProjectNotFoundError | 135 | projectRepository.findById on the db
singleton`. **The attribution is wrong, and it matters more than the count.** Re-reading the raw
stack blocks rather than the frame tally:

```
ProjectNotFoundError: Project cmso… not found.
 ❯ Object.allocateWorkItemNumber lib/repositories/projectRepository.ts:913:34
 ❯ tests/fixtures/workItemFixtures.ts:154:17
 ❯ buildScenario tests/comments/commentsService.test.ts:87:17
```

Those frames are **`allocateWorkItemNumber`** — a raw `UPDATE "project" … RETURNING` that throws
when it matches zero rows — and they are entered **directly from a test fixture**, which opens its
own bare `db.$transaction` and calls the repository. They are Finding 2 fixture debt wearing a
`lib/` frame, not an application read.

**The classifier is what hid it.** Grouping by the topmost non-`node_modules` frame cannot separate
_the application read unbound_ from _a fixture reached into a repository_ — both land in `lib/`.
Finding 4 read the file name as if it identified the caller. Splitting the same 2026-08-10 baseline
by whether the frame BELOW the `lib/` one is a service or a test file:

| batch |    tests |   failed | `ProjectNotFoundError` — application | — entered from a fixture |
| ----- | -------: | -------: | -----------------------------------: | -----------------------: |
| 1     |      178 |      108 |                                    7 |                       41 |
| 2     |      236 |      202 |                                   17 |                        0 |
| 3     |      776 |      581 |                                   42 |                       59 |
| 4     |      262 |      204 |                                    2 |                      122 |
|       | **1452** | **1095** |                               **68** |                  **222** |

`WorkItemNotFoundError` is **0** across all four batches in both runs — these batches do not
exercise `getTriageItemDetail`; `tests/permissions/membershipGate.test.ts` is where that case is
pinned, and it now passes under the flag.

### And then the result

| batch |    tests | failed (before → after) | application `ProjectNotFoundError` | fixture-entered |
| ----- | -------: | ----------------------: | ---------------------------------: | --------------: |
| 1     |      178 |                108 → 98 |                          7 → **0** |         41 → 41 |
| 2     |      236 |               202 → 202 |                         17 → **0** |           0 → 0 |
| 3     |      776 |               581 → 579 |                         42 → **0** |         59 → 59 |
| 4     |      262 |               204 → 204 |                          2 → **0** |       122 → 122 |
|       | **1452** |         **1095 → 1083** |                         **68 → 0** |   **222 → 222** |

**Every application-path `ProjectNotFoundError` / `WorkItemNotFoundError` from a `lib/` frame is
gone.** The 222 that remain are unchanged by design: each is a `tests/` file calling
`projectRepository.allocateWorkItemNumber` directly, which is MOTIR-2528's fixture migration and
which MOTIR-2569's scope excludes by name. **A card cannot be gated on a number its own scope
forbids it to move** — the criterion was amended on the record for exactly this, and the reasoning
is filed as planning bug MOTIR-2686.

And the headline lesson holds a second time: **the total fell by 12 out of 1095.** Read alone that
looks like a fix that did nothing. The named class it was aimed at went to zero.

### What MOTIR-2569 changed

`lib/workspaces/tenantRead.ts` — `readProject` / `readProjectByIdentifier` / `readWorkItem`, the
sibling of `lib/workspaces/membershipGate.ts` one layer down. Each binds
`withWorkspaceContext({ userId, workspaceId })` when the caller has no bound transaction and reuses
the caller's when it has one. Roughly 60 gate-preceding reads across 20 services now go through
them, and the services that no longer need `@/lib/db` or the repository at all have had those
imports removed — which is the invariant worth keeping: **a service that still imports `db` is a
service that can still open an unbound transaction.**

Three sub-shapes were NOT the plain unbound read, and each is worth naming because none is visible
from the call site:

- **A bare `db.$transaction` fed into a gate.** 18 sites passed their own unbound `tx` into
  `assertPermission` / `assertCanEdit` / `resolveGatedWorkItem`, which defeats the
  `if (!tx) withWorkspaceContext(...)` short-circuit MOTIR-2527 installed — the gate then reads
  through a transaction that binds nothing. `readMembership`'s docstring warns about exactly this
  ("do not pass a transaction that binds no GUCs"); the warning had no enforcement.
- **`createWorkItem`'s key-allocation transaction.** Fixing only its opening read moved the failure
  four gates later without removing it: `allocateWorkItemNumber` is the transaction's first
  statement. Worse, the gate probe in `membershipGate.test.ts` classifies ANY `ProjectNotFoundError`
  as `blocked-before-gate`, so an unbound write transaction reads as an unreached gate.
- **The operator backfills** (`boardsService.backfillDefaultBoard`,
  `workflowsService.backfillDefaultWorkflow`, `workItemsService.backfillProvenanceForProject`) have
  no session, and the workspace they would bind is what the read RESOLVES. They use the
  `app.system_admin` arm the 2026-07-27 migration added to `project_workspace_or_system_read` for
  operator tooling, then run everything after it tenant-scoped. Their existence probes moved inside
  that tenant transaction too — `board` and `workflow_status` are workspace-keyed as well, so an
  unbound probe would report "none" for a project that has one and seed a second.

### Two branches left, both filed

- **MOTIR-2684 — the PUBLIC-project read path is structurally dark.** `project` carries exactly one
  policy and its `USING` is `workspaceId = app.workspace_id OR app.system_admin = 'true'`. A public
  reader is anonymous or cross-org, so there is no user to bind and no workspace to bind that would
  not presume the answer — and no arm admits the row regardless. A binding cannot fix it; the policy
  needs a public arm, which MOTIR-2569's scope excludes. **Every public-project surface 404s after
  the cutover, including a team's own logged-out view.** **Done — see below.**
- **MOTIR-2685 — the USERLESS reads.** The job runtime and the `workspaceId`-only helpers
  (`workflowsService.requirePolicyMode` / `canTransition`,
  `projectsService.assertProjectInWorkspace`, whose own docstring already says it is
  "only safe under the BYPASSRLS dev role") have a workspace but no actor, so they want
  `withWorkspaceServiceContext`, not these readers. **Done — see below.**

**Consequence for the chain, updated.** MOTIR-2528's default flip is now `blocked_by` MOTIR-2684 and
MOTIR-2685 as well as by its own fixture migration — and, once MOTIR-2685 landed and surfaced it, by
MOTIR-2757 (`workflowsService`'s read surface; the last section below).

### MOTIR-2684, resolved — the arm the binding chain could not supply

The public branch closed with a POLICY change rather than a binding, because there was nothing
honest to bind. `20260811230000_public_project_read_policy` adds `project_public_read` — a
PERMISSIVE `FOR SELECT` policy, `USING ("accessLevel" = 'public')`.

**`FOR SELECT` is the load-bearing word.** Widening the existing FOR-ALL policy's `USING` would have
widened UPDATE and DELETE with it, and DELETE has no `WITH CHECK` to catch the difference — an
unbound caller could have deleted any public project. As a separate SELECT policy the write commands
stay governed by `project_workspace_or_system_read` exactly as before.

**Resolving the project turned out to be half the path.** Every public surface — board, roadmap,
work-items, tree, and `publicRequestsService.resolvePublicRequest`, which opens with an unbound
`work_item` read _before_ the grant check it exists to run — then reads `work_item` on the same
context-less connection. With the project arm alone the 404 becomes a blank page, and a public
request cannot be upvoted at all. So the migration adds `work_item_public_project_read` too, and
DELIBERATELY NARROWER: publicness is inherited via the parent project rather than carried on the
row, so the predicate is a join on the product's hottest table. It is gated on
`coalesce(app.workspace_id, '') = ''`, so it fires only on the genuinely context-less connection —
which is only ever the public path.

**The cost of that join was measured, not assumed** (PG 15, `EXPLAIN ANALYZE`, 500 work items):

| `app.workspace_id` | access path                             | the project lookup                  |
| ------------------ | --------------------------------------- | ----------------------------------- |
| bound              | unchanged (`work_item_projectId_*` idx) | `SubPlan 2 … (never executed)`      |
| unbound            | unchanged                               | `SubPlan 2 … loops=1` — HASHED, one |

The AND short-circuits on the row-independent GUC test, so a tenant read does not enter the join
once across all 500 rows; an unbound read enters it once per QUERY, not per row. The qual text grows
by a disjunct; the work does not.

The `EXISTS` is itself subject to `project`'s policies (a subquery in a policy runs under the
querying role), so it resolves through `project_public_read`: a work item is visible unbound exactly
when its project is, and the two cannot drift.

Two application reads on the same path were bound rather than policied, both with a workspace the
database had already handed back on a row proved `public` (a trusted resolution, not a guess made on
the reader's behalf): `resolvePublicInputs`' project-membership read — `project_membership` has no
"or your own" arm like the workspace-membership policy, so an unbound read silently cost a real
project ADMIN their 6.16.3 in-place Edit affordance — and `publicRequestsService.addComment`'s
INSERT, which `comment_active_workspace`'s `WITH CHECK` refused outright, leaving the public thread
write-dead. Both directions of all of it are pinned in
`tests/permissions/publicProjectAccess.test.ts`, which runs identically with the flag set and unset.

### MOTIR-2685, resolved — the userless branch, closed

`lib/workspaces/tenantRead.ts` gained a second TIER beside MOTIR-2569's actor-carrying readers:
`readProjectForService` / `readWorkItemForService`, binding `withWorkspaceServiceContext`
(`app.workspace_id`, no user). Eight sites moved onto it or onto that context directly — the five
job-runtime reads (`mentionNotificationsService`, `notificationFanInService`,
`watcherNotificationsService`, `automationEngineService.resolveProjectId`,
`autoPlanCadenceService.runForProject`) and the three `workspaceId`-only helpers
(`workflowsService.requirePolicyMode` / `canTransition`, `projectsService.assertProjectInWorkspace`).
`tests/permissions/userlessTenantRead.test.ts` pins all of them in both directions and, like its
MOTIR-2569 sibling, passes identically with the flag set and unset.

Three things are worth carrying forward rather than leaving in the diff:

- **`withWorkspaceServiceContext` IS sufficient for `work_item`, and its docstring said the
  opposite.** It read "NOT sufficient for a policy that also reads … `app.project_id` (the
  `work_item` project narrowing)". The restrictive `work_item_project_narrow` policy does read that
  GUC — and is SATISFIED, not defeated, when it is unbound, because its first branch is
  `coalesce(current_setting('app.project_id', true), '') = ''`. Narrowing is opt-IN, so not opting in
  is not a hole; and it is the behaviour these callers need, since they resolve an item before they
  know its project. The docstring now quotes the clause. _"The policy reads `app.project_id`"_ → _"the
  context must bind it"_ is a one-step inference that is wrong, and a shipped comment asserting it is
  how the next reader re-derives the wrong answer.

- **The enumeration by `findById` missed a read in the same path, and binding only the enumerated one
  would have left the defect in place.** The card listed the `project` / `work_item` reads, found by
  grepping `findById(`. `watcherNotificationsService`'s roster walk is a `findMany` on a THIRD table —
  `watcher`, whose `watcher_active_workspace` policy is an `EXISTS` over `work_item` keyed on
  `app.workspace_id` — so an unbound page read returns `[]` for a fully populated roster. Binding the
  item read alone moves the failure two statements later and the fan-out still drops every recipient,
  which is the card's own statement of the defect. Same sub-shape MOTIR-2569 recorded for
  `createWorkItem`'s key allocation. **The lesson is about the SEARCH, not this one line:** a grep for
  one repository method finds reads of the tables that method serves, and a path is not audited until
  every table it touches has been.

- **One refusal is role-dependent, and that is the shipped posture, not a gap.**
  `assertProjectInWorkspace` throws `ProjectWorkspaceMismatchError` under the owner role (the foreign
  row comes back and the explicit comparison refuses it) and `ProjectNotFoundError` under `motir_app`
  (RLS hides it first). `tests/e2e/project-isolation.spec.ts` already records exactly this for the
  in-tx variant — "Either typed error" — and the collapse is the BETTER posture: it is the
  no-existence-leak `getByKey` deliberately makes. The test asserts what holds in both roles.

**Still open in this family, and NOT part of MOTIR-2685** — filed as its own card rather than
absorbed, because nothing in 2685's criteria reaches it: **`workflowsService`'s READ SURFACE**.
`getWorkflow` (`findStatuses` + `findTransitions`), `listStatusesByProject` and `getStatusByKey` all
read `workflow_status` / `workflow_transition` on the `db` singleton, and both tables carry pure
`app.workspace_id` policies. Measured on this branch, one seeded status, same fixture, both roles:

| role                               | `getWorkflow(...).statuses.length` | `policyMode` |
| ---------------------------------- | ---------------------------------: | ------------ |
| owner (flag unset — what CI runs)  |                                  1 | `restricted` |
| `motir_app` (`TEST_DB_APP_ROLE=1`) |                              **0** | `restricted` |

So this is NOT a degradation — after the cutover the board renders no columns and every status picker
is empty, while the policy mode beside them reads correctly, because 2685 bound that one read and not
these. `getStatusByKey` is the milder member (its null falls back to the raw event key, so a watcher
email says `doing` instead of `Doing`). Each is a one-line bind on the same tier as the readers above.

## Cards filed from this inventory

Both are **successors** to MOTIR-2435, not children of it — tasks under Epic 8, in a
same-level chain. Filing them under the container would have made that container
un-completable by its own PR, which is recorded as planning bug MOTIR-2538.

- **MOTIR-2527** — route the 12 membership-gate reads through the tx-aware variant
  (the production defect; Finding 1). `high`, 5 points, `blocked_by` MOTIR-2435.
- **MOTIR-2528** — migrate the DB-backed fixtures onto `adminDb`, directory by directory,
  and flip the default when the last one lands (Finding 2). 8 points, `blocked_by` 2527.
  **ARCHIVED 2026-08-12, superseded by the twenty-one cards in the section below.**

Filed later, from the Finding-4 re-measurement above:

- **MOTIR-2569** — route the tenant-table reads that gate or precede a gate through a bound
  context (Finding 4). `high`, 5 points, `blocked_by` MOTIR-2527. **Done.**
- **MOTIR-2684** — give the `project` policy a public arm so the public-project path resolves
  at all. `high`, 5 points, `blocked_by` 2569. **Done** — and it needed a `work_item` arm as well;
  see the resolution note above.
- **MOTIR-2685** — bind the userless reads (job runtime + `workspaceId`-only helpers) through
  `withWorkspaceServiceContext`. 3 points, `blocked_by` 2569.

The flip is `blocked_by` 2684 and 2685 as well — an application path that cannot read
its own tenant is not made ready by migrating fixtures.

## The fixture migration, partitioned (2026-08-12)

MOTIR-2528 was one card describing several pull requests, which no single card can close. It was
split by planning bug **MOTIR-2587** and archived. Every card named in this section, together with
2435 / 2527 / 2569 / 2684 / 2685 / 2515, now sits under **MOTIR-2755**, the container story for the
`motir_app` cutover; it holds the same build order this document describes. The partition below was **measured on
`origin/main` at `9e7637cf`**, not carried over from the batch names at the top of this document —
those are vitest filter substrings, and three of the directories they name (`tests/sprints`,
`tests/workspaces`, `tests/projects`) do not exist.

**The real surface: 464 files importing `@/lib/db`, holding 3 042 `db.` call sites.** That is every
file under `tests/` other than the Playwright directory `tests/e2e`. Playwright's specs end in
`.spec.ts`, and the `include` glob in `vitest.config.ts` matches only `.test.ts` / `.test.tsx`, so
the flag never reached those 20 files and they are not in any batch. Roughly 402 of the 3 042 sites
sit inside an `expect(...)`; those are the ones that must **stay** on `@/lib/db`, and getting that
call wrong is the only way this work can fail silently.

Each batch is one card, one PR, and independent of the other nineteen — nothing in the fixture
layer orders them, so they can be worked in any order or in parallel.

|   # | card       | paths                                                                   |   files | `db.` sites |
| --: | ---------- | ----------------------------------------------------------------------- | ------: | ----------: |
|   1 | MOTIR-2735 | `tests/` root — tenancy + RLS suites                                    |      14 |         195 |
|   2 | MOTIR-2736 | `tests/` root — org / workspace / project services                      |      14 |          92 |
|   3 | MOTIR-2737 | `tests/` root — identity, billing, route tests                          |      29 |         117 |
|   4 | MOTIR-2738 | `tests/integration/work-items` (A–L)                                    |      24 |         164 |
|   5 | MOTIR-2739 | `tests/integration/work-items` (M–W)                                    |      24 |         122 |
|   6 | MOTIR-2740 | `tests/boards`                                                          |      21 |         157 |
|   7 | MOTIR-2741 | `tests/ciFleet`                                                         |      13 |         208 |
|   8 | MOTIR-2742 | `tests/projectRepos` + `tests/ciMetering`                               |      22 |         204 |
|   9 | MOTIR-2743 | `tests/mcp`                                                             |      28 |          93 |
|  10 | MOTIR-2744 | `tests/jobs` + `dispatch` + `hosting`                                   |      22 |         115 |
|  11 | MOTIR-2745 | `tests/ai` + `tests/integration/ai`                                     |      29 |         125 |
|  12 | MOTIR-2746 | `tests/github` + `tests/gitlab`                                         |      25 |         132 |
|  13 | MOTIR-2747 | `tests/integration/sprints` + `tests/ready`                             |      24 |         125 |
|  14 | MOTIR-2748 | `tests/integration/plans` + `plan-seed` + `planning`                    |      17 |         213 |
|  15 | MOTIR-2749 | `tests/workflows` + `tests/automation`                                  |      22 |         161 |
|  16 | MOTIR-2750 | `tests/permissions` + `publicProjects` + `api-tokens`                   |      26 |         154 |
|  17 | MOTIR-2751 | `tests/attachments` + labels + notifications + comments + custom-fields |      19 |         211 |
|  18 | MOTIR-2752 | `tests/integration` root + `reports` + `dashboards`                     |      31 |         172 |
|  19 | MOTIR-2753 | `tests/work-items` + `triage` + `import` + `migrations`                 |      29 |         189 |
|  20 | MOTIR-2754 | `tests/api/v1` + the long tail                                          |      31 |          93 |
|     |            | **total**                                                               | **464** |   **3 042** |

- **MOTIR-2734** — retire `TEST_DB_APP_ROLE` and make `motir_app` the suite's default connection.
  `blocked_by` all twenty batches **and** 2684 and 2685. MOTIR-2515, the deployed cutover, is now
  `blocked_by` this card rather than 2528.

Two claims 2528 carried are false on `origin/main` and are not rebuilt into 2734: **no CI workflow
has ever set the flag** (`grep -rn TEST_DB_APP_ROLE .github/` is empty), and the `gateReachable`
guards in `membershipGate.test.ts` were already removed by 2569. The flag's whole code footprint is
now five sites: `parallelDb.ts:109` and `:133`, `app-role-harness.test.ts:5,34,83`,
`tenant-root-creation-rls.test.ts:6,36`, and `membershipGate.test.ts:16,78`.

The chain then ends at **MOTIR-2515**, the deployed cutover — which is the point at
which RLS actually starts executing in production. Nothing before it changes what the
deployed application is subject to.

---

## Closing entry — the TEST call-site class (MOTIR-2797, 2026-08-13)

The twenty batches above migrated **fixtures**: lines matching `db.<model>.<op>(…)`. A third cause of
the suite being red under `motir_app` survived all of them, because it carries **no `db.` prefix
anywhere on the line** — a test calling a repository directly:

```ts
const counts = await workItemRepository.countByStatusCategory(fx.projectId, fx.workspaceId);
```

`countByStatusCategory` is bindable; the test simply passed no `tx`, so the read went to the
singleton, the policy saw no `app.workspace_id`, and it returned `{ todo: 0, in_progress: 0, done: 0 }`
while the rows existed. A sweep keyed on the CLIENT's name cannot see a call that reaches the client
through a named wrapper.

### Final classification — all 1 174 repository call sites under `tests/`

| verdict               |     n | disposition                                                                       |
| --------------------- | ----: | --------------------------------------------------------------------------------- |
| `in-scope`            | **0** | **Closed.** Was 458 when measured; the ratchet is now a hard `toEqual([])`.       |
| `already-bound`       |   721 | Nothing to do. ~250 of these were bound by the twenty fixture batches in passing. |
| `not-gated`           |   227 | No policy applies; unbound is correct.                                            |
| `pre-auth`            |    17 | Deliberately actorless (MOTIR-2784's adjudication).                               |
| `needs-binding-first` |   120 | **MOTIR-2830**, under MOTIR-2796 — no `tx` parameter to pass yet.                 |
| `adjudicated-unbound` |    89 | Seven files whose CLAIM binding would destroy — below.                            |
| `unclassifiable`      |     0 | An unknown method fails the build rather than defaulting to in-scope.             |

### The seven adjudicated files, and why each is not work

Binding these does not break a test; it makes one **vacuous**, which is the same failure this story
existed to remove, arriving from the opposite direction.

| files                                                                                           | adjudicated by  | the claim binding would destroy                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comments/` `custom-fields/` `labels-components-watch/` `notifications/` `repositories.test.ts` | MOTIR-2751      | Subject is the repository CONTRACT and migration-built CONSTRAINTS with RLS deliberately inert. A cross-workspace read would return `[]` because the _policy_ hid the row, and a constraint test failing with a policy error proves nothing about the constraint.                                  |
| `integration/sprints/repository.test.ts`                                                        | MOTIR-2739/2747 | Subject is the explicit `workspaceId` WHERE-clause gate. Bound, `[]` stops distinguishing a working gate from a broken one.                                                                                                                                                                        |
| `mcp/comment-counts.test.ts`                                                                    | MOTIR-2755/2840 | Subject is the QUERY COUNT (the N+1 guard), measured by spying on `db.comment.groupBy`. Binding relocates the query onto the tx client the spy cannot see, so every count reads 0.                                                                                                                 |
| `project-details-service.test.ts`                                                               | MOTIR-2843      | Its read exercises _"the repo's no-tx read path (the `?? db` branch)"_. Binding deletes the test and its branch coverage. **Follow-up: retire the fallback** — as MOTIR-2755 did for `projectRoleDefinitionRepository` once every caller bound. That is a `lib/` change and belongs to MOTIR-2796. |

### The cross-workspace pattern worth knowing

A gate assertion reads for a FOREIGN workspace and expects `[]`. It is bound to its **OWN** workspace,
not the one it reads: the policy then admits the caller's rows, so an empty result can only come from
the explicit `workspaceId` argument — which is what the test asserts. Binding the foreign workspace
would hide the rows twice. Instances: `sprint-filter`, `issue-detail`, `project-tree`,
`boards/repositories` (×3).

### What remains before `motir_app` is the default

`TEST_DB_APP_ROLE=1` is **not** green, and no batch of this story could have made it so. The residual
failures are unbound reads inside `backlogService`, `workItemsService`, `savedFiltersService` and
their peers — **MOTIR-2796**'s surface. This story's boundary forbade a `lib/` change, so those are
named per file in each batch's PR body rather than fixed here. The flag retires in **MOTIR-2734**,
now under MOTIR-2832, once 2796 lands.

## CLOSED — the READ surface is bound (MOTIR-2796, 2026-08-13)

The story this inventory's Finding-1/Finding-4 chain was building toward. It bound the read
surface for `motir_app` and then retired its own scaffolding; what follows is the closing
measurement, taken on the branch, so the next person can tell what is finished from what is not.

### The two instruments both report the class EMPTY

| scan                                    | measures                                  | before |  after |
| --------------------------------------- | ----------------------------------------- | -----: | -----: |
| `tests/rls/singletonReadScan.ts`        | a repository read that CANNOT take a `tx` |     55 |  **0** |
| `tests/rls/callSiteScan.ts`             | a read that CAN, whose caller passes none |    169 | **16** |
| ” — bare `db.$transaction` in a service | a transaction binding no GUCs             |     60 | **29** |

**55 reads across 20 services** were bound, one card per service, plus a public SELECT arm for
`public_request_vote` where there was no workspace to bind. `UNBOUND_READ_PATH_CEILING` and the
`unbound-read-path` verdict are **retired** (MOTIR-2814): a ratchet with no members is a number
that invites editing, where the set-equality assertion that replaces it cannot be nudged.

The call-site scan's 16 survivors are all adjudicated non-defects — 10 `public-arm` (9 in
`publicProjectsService`; 1 in `publicRequestsService`, whose opening read is the one that FINDS the
item's workspace, and `work_item_public_project_read` admits exactly that) and 1 `no-policy`.
**No site carries an `unbound-call-site` verdict**, and a guard test now fails the build if one
reappears. The 29 surviving bare transactions enclose no policy-gated statement — user preferences,
rate-limit counters, CLI device codes, the tenant bootstrap that runs before a workspace exists.

⚠️ **And the detector's SCOPE was wrong at the root until MOTIR-2815.** `policyGatedModels` decided
"is this table under RLS?" from a `workspaceId` FIELD on the Prisma model — a proxy that
UNDER-approximates: **18 of the 69 RLS-protected tables carry no such column** (they are gated
through a join), so `work_item_revision`, `watcher`, `comment_mention`, `github_pull_request`,
`dashboard_widget` and a dozen more were outside BOTH scanners. Every earlier "the class is empty"
claim in this story covered 51 of 69 tables. It now unions the schema heuristic with every table
named by a `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY` in the migrations, and that revealed —
among others — `automationEngineService`'s idempotency probe (unbound: no prior run found, so a
replayed event RE-APPLIED every action), `notificationFanInService`'s watcher roster (the fan-in
notified NOBODY) and `workItemsService.listRevisions` (an item's whole history came back empty).

`UNREVIEWED_CEILING` is untouched at **8** — the public-surface reads, which belong to MOTIR-2789
and need a green public-projects suite before a `public` verdict is honest.

### What `TEST_DB_APP_ROLE=1` reports over the WHOLE suite

`TEST_DB_APP_ROLE=1 pnpm vitest run` — **1 146 failed / 13 390 passed / 1 skipped, 1 019 files.**
(4 `does not exist` lines are worker-DB contention noise, not results. A run showing hundreds of
them has been trampled by a concurrent vitest and must be discarded, not read.)

Classified by the FIRST non-`node_modules` frame in each failure's stack:

|                                                                                            | failures | owner                                                     |
| ------------------------------------------------------------------------------------------ | -------: | --------------------------------------------------------- |
| only `tests/` frames                                                                       |      814 | MOTIR-2830 + the twenty fixture batches (MOTIR-2735…2754) |
| `scripts/seedLargeBoard.ts` — a bare `db.$transaction` in a test-seeding script            |       14 | MOTIR-2830                                                |
| a bare `db.$transaction` **in the test file itself**, around a `workItemRepository.update` |        7 | MOTIR-2830                                                |
| a mapper reading a row a test-side unbound read never returned                             |        1 | MOTIR-2830                                                |

**Not one of the 1 146 is a production read returning empty.** That is the criterion MOTIR-2789 was
wrongly given (planning bug MOTIR-2798) and it is satisfied here. What remains is the FIXTURE
population this document partitioned in the section above, and it is the last thing between here
and flipping the flag (MOTIR-2734 → MOTIR-2515).

### Two things the story found that its own plan did not name

1. **A second population, invisible to the partitioning scanner.** MOTIR-2796 was cut from
   `singletonReadScan`, which reads `lib/repositories/` and asks whether a read _can_ bind. The
   mirror question — whether its caller _does_ — had no card, and its instrument was scheduled
   LAST, blocked by the thirteen cards it would have classified. Three instances were hit by red
   suites mid-run before the gap was diagnosed. Carved out as MOTIR-2845/2846 and filed as planning
   bug MOTIR-2847 (`notes.html` #266).
2. **The forwarding helper — the same defect one frame up.** A service factors its tenant gate into
   a local helper taking its own `tx?`, forwards it to a bindable read, and falls through to the
   singleton when the caller passes none. The inner line looks bound; it is bound only when the
   caller supplied one. `backlogService.loadItem` alone accounted for **118 `backlogService` frames
   in `tests/integration/sprints` under the flag (0 after)**, and `componentsService.resolveComponent`,
   `commentsService.resolveComment`, `plansService.runPersistGate` and
   `planChangeSessionsService.toDto` were the same shape. The call-site scanner now reaches exactly
   one frame up to find their callers — and stops reporting once a helper binds its own fallback,
   because a guard that cannot go green is one people learn to ignore.

### Out of scope, and still open: the WRITE surface

Binding the reads does not bind the writes, and the flag-on suite still shows INSERTs refused by
policy (`new row violates row-level security policy for table "import"` in `tests/import`, which
reproduces without any of this story's changes). Those are a separate surface with no card in this
story; they are visible in the same run and should not be read as read-path residue.

---

## THE RESIDUAL, PARTITIONED (MOTIR-2862, 2026-08-15)

The measurement the section above deferred. MOTIR-2861 removed the last `beforeEach` mask — ten files
that died before a single assertion ran — so a partition taken now is a partition of what is broken
rather than of what fails first. **This section fixes nothing**; its output is a count, a three-class
partition in which every failure is attributed to exactly one class, and the eight cards that follow
from it.

### How it was measured

`TEST_DB_APP_ROLE=1 pnpm vitest run` on `origin/main` at **`6d1a385f`** (MOTIR-2857 merged, #2062),
against a Postgres cluster and base database created for this run alone (`prodect_b2862`, so the worker
DBs are `prodect_b2862_test_wN` and no concurrent session's teardown can drop them).

|                      |         |
| -------------------- | ------: |
| test files           |   1 018 |
| red files            |     108 |
| tests                |  14 356 |
| **failed**           | **652** |
| passed               |  13 703 |
| skipped              |       1 |
| **`does not exist`** |   **0** |

**The `does not exist` count is 0 — a clean run.** A run showing hundreds of those has been trampled by
a concurrent vitest and must be discarded, not read.

Two corrections to the raw output, both stated so the numbers reconcile:

- `tests/permissions/membershipGate.test.ts` produced **zero** test results, failing at import with
  `EPERM … zod/v3/helpers/typeAliases.js` — an unreadable file in the pnpm store, not a test failure.
  Re-run on its own it is **30 passed / 0 failed**, and those 30 are included above. The raw run
  reported 14 326 tests and 109 red files.
- The run emitted six `Worker exited unexpectedly` errors under memory pressure. Exactly one file lost
  its results (the one above); the other 1 017 are complete.

**⚠️ The flag, and why this is not literally the command MOTIR-2862 was written with.** That card says
_"re-run with no environment variable — i.e. with `@/lib/db` connected as the non-bypass role"_. Those
two clauses are equivalent only on MOTIR-2734's branch, where `isAppRoleTestMode()` is deleted. On
`origin/main` `parallelDb.ts:133` still branches, so **unset means the bypass OWNER role** and the
measurement the card asks for is `TEST_DB_APP_ROLE=1`. The card also requires `main` with MOTIR-2861
merged, which is where this was run. The nine `isAppRoleTestMode()` readers therefore execute their
app-role arms here — the same arms MOTIR-2734 will make unconditional — so this reading is the one
that generalises. (MOTIR-2860, which that card's criteria name, was **archived as a duplicate** on
2026-08-15; MOTIR-2734's own amendment already owns the defect it described.)

### The partition — three classes, no residual bucket

Classified on **two axes kept separate** (`notes.html` #257): the error's own class, and the first
non-`node_modules` frame. The axes disagree, which is the point of keeping both.

| class                                       | failures | files | what it is                                                                                                       |
| ------------------------------------------- | -------: | ----: | ---------------------------------------------------------------------------------------------------------------- |
| **1 — the WRITE surface, application side** |  **166** |    25 | a policy's `WITH CHECK` refuses a write issued by `lib/` or `scripts/` code on a connection binding no workspace |
| **2 — the test-side residue**               |  **240** |    41 | a test or seed script issues the statement through `@/lib/db` where it needs the owner client                    |
| **3 — downstream assertion failures**       |  **246** |    65 | a read came back empty; the cause is NOT separable from the assertion text                                       |
|                                             |  **652** |   108 |                                                                                                                  |

**There is no "other" bucket.** Every one of the 652 lands in exactly one class.

#### What the frame axis cannot see, and why the error axis alone would also mislead

- **All 267 RLS write denials carry NO repo frame at all.** Prisma 7 raises them as a bare
  `DriverAdapterError` from `PgTransaction.performIO`, whose stack is entirely inside
  `node_modules/@prisma/*`. A frame histogram is blind to the single largest cause in this run.
- **The absence of a caller frame does NOT imply the caller was application code.**
  `migrate-terminal-reconciliation.test.ts:69` is a plain fixture `db.migrateOnboarding.create` and
  still produces a bare adapter error. Class 1 and class 2 were separated by **reading the source of
  each failing (table, file) pair**, not by the stack.
- **The 29 `ProjectNotFoundError` / `WorkItemNotFoundError` / `TypeError` failures all book a
  `lib/repositories/*` frame and are all test-side** — called from `scripts/seedLargeBoard.ts` (10),
  eleven test files, and `scripts/plan-seed/preserveStatus.ts` (1). This is `notes.html` #257 verbatim:
  _a fixture that reaches into a repository books a `lib/` frame and reads as an application defect._
- **Conversely, the error axis alone splits ONE cause across four buckets.** Class 2's four error
  shapes — INSERT refused, row invisible to `USING`, repository reach, raw `TRUNCATE` — are the same
  defect. Sorting by message would have produced four cards fixing one thing in four places.

### Class 1 — the WRITE surface, application side (166 failures, 25 files) → **MOTIR-2865**

Refused by a policy's `WITH CHECK` where the writer is `lib/` or `scripts/` code. **These are production
defects**: they fail for exactly the reason they will fail once MOTIR-2515 points production's
`DATABASE_URL` at `motir_app`.

Two facts establish that no denial here is a _missing_ policy: all **69** RLS tables carry an
INSERT/UPDATE/DELETE/SELECT-capable policy, and **every `FOR ALL` policy carries a `WITH CHECK`** (65
`FOR ALL` + 15 SELECT + 4 each INSERT/UPDATE/DELETE = 92 policies). The writes are refused because the
session bound no workspace, not because nothing admits them.

A one-off scan of `lib/` for a bare `db.$transaction(…)` enclosing a repository write found **22 sites
across 14 service files**, and it corroborates the four largest groups by name:

| site                                                | table                       |   failures |
| --------------------------------------------------- | --------------------------- | ---------: |
| `automationEngineService.ts:483` (`writeExecution`) | `automation_rule_execution` |         49 |
| `notificationFanInService.ts:403`                   | `notification`              |         29 |
| `importService.ts:95`, `:190`                       | `import`                    |         18 |
| `organizationsService.ts:222`                       | `organization`              |          3 |
| `workspaceInvitesService.ts:331`                    | `workspace_membership`      | part of 37 |

**The scan does NOT reach every denial** — `watcher`, `work_item_embedding` and `custom_field_value` are
refused with no bare-transaction site to point at, which is why MOTIR-2870 is sized to find the route
rather than to apply a known fix.

| table                       | failures |     | table                     | failures |
| --------------------------- | -------: | --- | ------------------------- | -------: |
| `automation_rule_execution` |       49 |     | `custom_field_value`      |        6 |
| `workspace_membership`      |       37 |     | `organization`            |        3 |
| `notification`              |       29 |     | `project_membership`      |        2 |
| `import`                    |       18 |     | `custom_field_definition` |        1 |
| `work_item_embedding`       |       10 |     | `work_item`               |        1 |
| `watcher`                   |       10 |     |                           |          |

Files, by failure count: `automation-engine` 21 · `ai/work-items-route` 19 · `automation-story` 15 ·
`integration/notifications-journey` 12 · `notifications/notificationsService` 12 ·
`embeddings/workItemEmbeddingRls` 10 · `integration/import/importSeam` 10 · `ai/serviceAuth` 9 ·
`automation-epic5` 9 · `import/importService` 8 · `custom-fields/definitionsService` 7 ·
`integration/home/personal-reads` 6 · `jobs/notification-fan-in` 5 ·
`integration/migrations/ensure-planner-bug-home` 4 · `integration/plan-seed/system-principal` 4 ·
`integration/epic6-journey` 3 · `integration/home/story-seams` 3 · `organizations-service` 2 ·
and seven files at 1 (`billing-seat-sync`, `github/githubWebhookService`, `jobs/watcher-notify`,
`integration/epic6-at-scale`, `integration/plan-seed/onboarding-marker`,
`integration/plan-seed/test-project`, `integration/work-items/repository`).

Carved as **MOTIR-2865** (story) with five children: **MOTIR-2866** automation audit (49) ·
**MOTIR-2867** notification + watcher (39) · **MOTIR-2868** tenant-root + membership (42) ·
**MOTIR-2869** import (18) · **MOTIR-2870** the four surfaces the scan cannot see (18). 21 points.

### Class 2 — the test-side residue (240 failures, 41 files) → **MOTIR-2871**

The statement is issued by the test or a seed script through `@/lib/db` and needs `adminDb`. Four error
shapes, one cause:

| shape                                            | failures | files |
| ------------------------------------------------ | -------: | ----: |
| INSERT refused by `WITH CHECK`                   |      101 |    15 |
| row invisible to `USING` on UPDATE / `…OrThrow`  |      106 |    19 |
| a test or seed script reaching into a repository |       29 |    11 |
| raw `TRUNCATE` on the singleton                  |        4 |     1 |

**The middle shape is mechanically proven test-side.** Prisma prints ``Invalid `db.<model>.<op>()`
invocation in <file>`` for a `PrismaClientKnownRequestError`, and **all 106 name a file under `tests/`** —
`db.workItem.update` in a helper (`parentStatusRollup.test.ts:41`) being the dominant form.

**The raw-`TRUNCATE` shape is a twelfth instance of MOTIR-2861's own class**:
`tests/components/issue-inline-edit-race.test.tsx:88` runs
`db.$executeRawUnsafe('TRUNCATE TABLE "work_item_link", "work_item" …')` on the singleton. `motir_app`
holds SELECT/INSERT/UPDATE/DELETE on that table but not ownership, so it is refused `42501`.
(`tests/helpers/db.ts` is already correct — it imports `adminDb as db`.)

**⚠️ The twenty batches' path partition has holes, and that is the finding worth carrying.**
`tests/integration/workflows/parentStatusRollup.test.ts` contains **zero** `adminDb` references and nine
`db.` sites, and was last touched **2026-08-04** — before the batches ran. `tests/billing/meta-org-entitlement-seam.test.ts`
is the same shape. `tests/integration/workflows`, `tests/integration/backlog`, `tests/billing`,
`tests/migrate-onboarding` and `tests/embeddings` appear in no batch card's path list. A partition drawn
by directory goes stale the moment a directory is added.

Files, by failure count: `integration/workflows/parentStatusRollup` 25 ·
`migrate-onboarding/migrate-terminal-reconciliation` 25 · `migrate-onboarding/migrate-onboarding-service` 19 ·
`integration/workflows/childStatusCascade` 18 · `integration/workflows/statusDerivation` 16 ·
`migrate-onboarding/migrate-index-sweep` 15 · `integration/backlog/filter` 12 ·
`integration/github/historical-pr-backfill` 11 · `integration/import/repository` 10 ·
`billing/meta-org-entitlement-seam` 7 · `boards/at-scale-scrum-fixture` 6 ·
`integration/workflows/childrenStatusAggregate` 5 · `integration/triage/permission-gate` 5 ·
`billing-seat-sync` 5 · `boards/at-scale-fixture` 4 · `cli/cli-story` 4 ·
`integration/estimation/service` 4 · `integration/saved-filters/saved-filters` 4 ·
`integration/work-items/mention-search-route` 4 ·
`components/issue-inline-edit-race` 4 · `issues/createIssueAction` 3 ·
`integration/work-items/repository` 3 · `migrate-onboarding/migrate-index-status` 3 ·
`scripts`-driven and 1–2-failure files: `design-evidence-routes`, `cli/cli-connect-story`,
`tokens/story-gate`, `integration/workflows/projectStatusAutomation`, `jobs/code-graph-index`,
`jobs/notification-fan-in`, `integration/projectRepos/repositorySetStoryGate`,
`integration/plan-seed/preserve-status`, `integration/work-items/provenance-seams`,
`jobs/mention-notify`, `api/live-projects-route`, `github/githubWebhookEdges`,
`gitlab/gitlabWebhookEdges`, `ready/projectScopedDispatchRepo`,
`integration/saved-filters/subscriptions`, `integration/workflows/projectStatusAutomationRoutes`,
`migrate-onboarding/migrate-onboarding-routes`, `integration/projectRepos/repositorySetRoutes`.

Carved as **MOTIR-2871**, 8 points.

### Class 3 — downstream assertion failures (246 failures, 65 files) → **MOTIR-2872**

`expected [] to have a length of 1` · `expected undefined to be '<id>'` ·
`expected { indexed: false } to deeply equal { indexed: true }` ·
`expected "pollIndexContainer" to be called 4 times, but got 0`.

Every one is a read that came back empty. **Whether the cause is an unbound read, a fixture whose INSERT
was refused, or a genuine product defect cannot be told apart from the assertion text.**

Concentrations, offered as a starting point and not a conclusion: `jobs/code-graph-index*` 41 across
three files · `github/*` 43 · `gitlab/*` 14 · `integration/work-items` 16 · `projectRepos` 15 ·
`integration/sprints/repository` 11 · `custom-fields/repositories` 10 ·
`labels-components-watch/repositories` 10 · `comments/repositories` 9 · `notifications/repositories` 7 ·
`cli` 9 · `mcp` 7 · `boards` 5. **MOTIR-2864 already owns** `public_request_vote`'s missing
workspace-member read arm, where `publicRequests/upvoteComment` (3) sits.

Carved as **MOTIR-2872**, 3 points, `blocked_by` MOTIR-2865 and MOTIR-2871 — it re-measures on `main`
after both have MERGED, and files a card per surviving class.

### ⚠️ What this partition does NOT claim — `notes.html` #249

> _"An error census over short-circuiting paths measures ORDER, not extent. … The prediction to refuse
> is the one about the RESIDUE."_

**This partition is still a census of what fails FIRST.** It is a better one than the section above it —
the `beforeEach` mask is gone, and the two-axis method separates causes that a frame histogram fuses —
but it cannot see past a statement that never ran. So:

- **No claim is made about what class 3 becomes** once classes 1 and 2 clear. It may be most of the 246;
  it may be almost none. That is MOTIR-2872's measurement to take, on a run where the top causes are
  already suppressed, and it is why that card exists at all rather than being folded into this one.
- **The completion signal for each card is ITS NAMED CLASS reaching zero, never the suite total.** When
  MOTIR-2865 and MOTIR-2871 land, the total will **not** fall by 406. A layered defect gives back its
  layers one at a time, and a total that does not move is the expected shape of a real fix — the exact
  reading error that cost this document a re-measurement at MOTIR-2527.

### Cards filed from this partition

| card           | class                                          | kind    | points |
| -------------- | ---------------------------------------------- | ------- | -----: |
| **MOTIR-2865** | 1 — the write surface (166)                    | story   |      — |
| MOTIR-2866     | automation audit write (49)                    | subtask |      3 |
| MOTIR-2867     | notification + watcher writes (39)             | subtask |      5 |
| MOTIR-2868     | tenant-root + membership writes (42)           | subtask |      5 |
| MOTIR-2869     | import write path (18)                         | subtask |      3 |
| MOTIR-2870     | the four surfaces the scan cannot see (18)     | subtask |      5 |
| **MOTIR-2871** | 2 — the test-side residue (240)                | task    |      8 |
| **MOTIR-2872** | 3 — re-measure the downstream population (246) | task    |      3 |

**MOTIR-2734** (retire `TEST_DB_APP_ROLE`) is now `blocked_by` MOTIR-2865, MOTIR-2871 and MOTIR-2872,
and its edge to MOTIR-2862 is dropped.

> **⚠️ CORRECTED THE NEXT DAY — read the closing entry below before using class 1's split.** This
> section assigns **166** denials to application/script code and **101** to fixtures, split by reading
> the source of each failing (table, file) pair. MOTIR-2865's five children found that split wrong at
> its tail: **`watcher` (10) and `work_item_embedding` (10) have no unbound application writer at
> all** — every site is a fixture, and they belong to MOTIR-2871 — and **all four services MOTIR-2870
> was cut to bind turned out to be bound already**, which also covers `custom_field_value` (6),
> `custom_field_definition` (1) and `work_item` (1). Class 1 is therefore ~28 denials smaller than
> stated here, and class 2 correspondingly larger.
>
> The cause is the one this section already names one paragraph up and did not apply far enough: the
> classifier reads an **error message**, and an RLS `WITH CHECK` refusal is byte-identical whether the
> statement came from `lib/` or from a test's own `db.$transaction`. Source inspection of the failing
> test file narrows that but does not settle it — a file can hold both. `notes.html` #257, one instance
> further on.
>
> **The numbers below are left as measured rather than back-edited**, which is this document's
> convention (see _"First, the correction — 94 of those frames are not what this document said they
> were"_ above): a dated entry records what was seen on its date, and the correction goes in the entry
> that found it.

---

## CLOSED — the WRITE surface is bound (MOTIR-2865, 2026-08-16)

The section directly above — _"Out of scope, and still open: the WRITE surface"_ — was accurate,
prominent and terminal: it named a whole class and filed no card for it, in this story or any
other (`notes.html` #271, planning bug MOTIR-2863). MOTIR-2862's re-measurement carved it into
MOTIR-2865 and five children; this is their closing entry.

### The named class, before and after

Measured under `TEST_DB_APP_ROLE=1` over the union of the five children's own suites — 445 files,
`does not exist` count **0** (a clean run, not a trampled one):

| writer                        | denials before | after |
| ----------------------------- | -------------- | ----- |
| **application + script code** | **115**        | **0** |
| test fixtures (MOTIR-2871's)  | 59             | 59    |

**The suite total does not fall by 115, and that is the expected shape** (`notes.html` #249): what
sat behind a refused INSERT is the next layer, not nothing. Failing tests over the same union are
**111**, and the residue is the assertion class MOTIR-2872 re-measures after this lands. A reader
who expects the total to move by the class size will read a correct fix as a failed one.

### What was actually unbound, by site

| site                                                                                                                        | verdict                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `automationEngineService.writeExecution` (`:483`)                                                                           | bound on `rule.workspaceId`; takes the RULE, not a rule id, so the pair cannot be mismatched (49)                    |
| `notificationFanInService` (`:403`)                                                                                         | bound on `event.workspaceId`, the same tenant its reads at `:181`/`:224` already bound (17)                          |
| `organizationsService.createOrganization` (`:222`)                                                                          | BOOTSTRAP-bound inline (`app.bootstrap_slug` + `app.user_id`), the org-tier twin of `insertWorkspaceWithOwner` (3)   |
| `importService.createDraft` (`:95`) and `preview` (`:190`)                                                                  | bound on `ctx.workspaceId`, as `:231` already was (8)                                                                |
| `scripts/plan-seed/systemPrincipal.ts`, `testProject.ts`, `seed.ts` (×2), `seedReportingFixture.ts`, `seedCollabFixture.ts` | bound on the workspace (or, for `seed.ts:282`, on the ORG) — every one writes into a tenant that already exists (38) |

### Three things the five cards found that the partition did not predict

1. **59 of the 174 denials are FIXTURES, not application code.** The classifier that cut the
   partition reads an error message; it cannot see whether the statement came from `lib/` or from a
   test's own `db.$transaction`. `watcher` (10) and `work_item_embedding` (10) were assigned to the
   write surface and have **no unbound application writer at all** — every site is a fixture, and
   MOTIR-2870's four services were already bound before its card was written. They are handed to
   MOTIR-2871 by file and line. (`notes.html` #257, one instance further on.)
2. **`withSystemContext` is not an escape hatch for the tenant-root tables.** Neither
   `membership_insert_active_or_bootstrap` nor `org_membership_insert_active_or_bootstrap` has a
   `system_admin` arm, so a caller reaching for it is refused rather than over-permitted.
   `tests/github/githubWebhookService.test.ts` had done exactly that and was red for it.
3. **A denial was masking a SILENT gate failure.** `entitlementsService.assertCanCreateOrganization`
   counts the actor's existing org memberships inside `createOrganization`'s transaction, and
   `org_membership_visible_active_or_own` shows them only to `app.user_id`. Unbound, the §4.5
   org-creation gate read ZERO orgs for every actor and allowed every 2nd+ org it exists to refuse.
   The refused INSERT is the loud half of that transaction; this was the quiet half.

### Out of scope, and CARDED: three unbound tenant READS the read surface missed

Found by sweeping every remaining bare `db.$transaction` in `lib/` rather than only the ones a
failing test pointed at. All three READ `workspace_membership` with no GUC bound, so under
`motir_app` they return empty and **raise nothing** — invisible to this story's instrument, which
keys on a refusal:

- `workspacesService.getActiveWorkspace` (`:349`) — `GET /api/workspaces/current` resolves to null.
- `workspacesService.ensureDefaultWorkspace` (`:309`) — the membership count that makes it idempotent
  reads 0, so it mints a duplicate default workspace.
- `importEngineService.defaultLoadMembers` (`:39`) — the import's assignee resolution maps nobody.

Filed as a bug rather than absorbed (`notes.html` #27). They belong to the READ surface MOTIR-2796
closed and are a counter-example to its instruments: both scanners ask whether a repository read
_takes_ a `tx`, and these three pass one — from a transaction that binds nothing.

---

## `public_request_vote`'s THIRD arm — the member read (MOTIR-2864, 2026-08-16)

The **READ**-surface entry above (MOTIR-2796) records that it shipped "a public SELECT arm for
`public_request_vote` where there was no workspace to bind." That arm was correct and it was not
sufficient, and the gap is worth stating precisely because the shape recurs: **arming a table for
the reader you are currently looking at can leave the table armed for NOBODY ELSE.**

MOTIR-2811's arm is gated on `coalesce(current_setting('app.workspace_id', true), '') = ''` — it
fires only on the genuinely context-less connection. So after it the table admitted the vote's
OWNER, the system flag, and an anonymous reader. A workspace MEMBER matched none of the three:
`withWorkspaceServiceContext` binds `app.workspace_id` and not `app.user_id`, and the member
reading the queue is not the voter anyway. `workItemRepository.findTriageQueue` aggregates this
table inside exactly that transaction, so the triage inbox's `voteCount` came back **0 for every
request** — no error, no warning, just the 6.12.6 sort key quietly ceasing to exist.

`public_request_vote_active_workspace_read` (`20260815234500`) closes it: a `FOR SELECT` correlated
`EXISTS` resolving the vote's tenant through `work_item."workspaceId"`, the `work_item_label` /
`watcher` member shape, narrowed to reads so the owner arm keeps owning every write.

**Two notes for whoever audits the next table.**

- **Neither scanner could have found this — and that is now the SECOND independent instance.** Both
  ask whether a repository read is BOUND; this read was bound, correctly, from the start. The
  missing half was the POLICY, and a bound read against a table with no matching arm returns rows
  rather than an error — the vacuous-pass class MOTIR-2829 names, one layer down. A `COUNT` that
  reads 0 is the worst instance of it, because 0 is a legitimate answer.

  MOTIR-2865's closing section directly above reaches the same verdict from the opposite direction:
  its three unbound tenant READS "pass one — from a transaction that binds nothing." Put together
  the instruments have **two** blind spots on the same axis, and they are complementary: a `tx` that
  binds no GUC (theirs) and a GUC with no arm that reads it (this one). Neither is a call-site
  property, so no call-site scanner can see either. What would cover both is an assertion per
  (table, context) pair against `pg_policies` — nothing today makes that claim.

- **The trigger was a FIXTURE repair, not an audit.** MOTIR-2857 moved this suite's setup writes to
  `adminDb`; before that the file died in setup and the assertion was never reached. Expect more of
  this class to surface as the remaining fixture batches land — a suite that dies early is a suite
  whose later assertions have never run.

---

---

## CLOSED — both ratchets are at their floor (MOTIR-2833, 2026-08-16)

`tests/rls/singleton-read-guard.test.ts` carried two ratchets; this is where both finish, and they
closed for **different reasons**, which is the distinction the whole two-ratchet apparatus existed to
preserve. (Written while the WRITE surface was still open, and landed after it and the two arms
above had closed — the read-adjudication axis is independent of all three, so its position among the
closing entries carries no ordering claim.)

| ratchet                     | measures                                 | peak | final | closed by                          |
| --------------------------- | ---------------------------------------- | ---: | ----: | ---------------------------------- |
| `UNBOUND_READ_PATH_CEILING` | reads confirmed BROKEN under `motir_app` |   55 | **0** | MOTIR-2796 — RETIRED by MOTIR-2814 |
| `UNREVIEWED_CEILING`        | reads nobody had LOOKED at               |   73 | **0** | MOTIR-2833                         |

`'unreviewed'` is also gone from the `Verdict` union, so the state cannot be re-entered without an
explicit type change — the count and the type now say the same thing, which is the property a bare
ceiling could not give (it sat stale at 14 through four cards that each thought they had lowered it).

### The last eight, and the prediction that was wrong about half of them

The eight were all public-surface reads, and the closing card's own plan predicted all eight would
return `public`, on this reasoning: _"only `project` and `work_item` carry public arms … the reads
below all target `project` or `work_item`, which is why they are plausibly `public` rather than
plausibly broken."_

**Four of them were broken, by the very fact that sentence quotes.** They TARGET `project` /
`work_item` and they JOIN a third table that had no arm:

| read                                             | unarmed table it joined      |
| ------------------------------------------------ | ---------------------------- |
| `workItemRepository#findPublicRoadmapSubmitted`  | `workflow_status`            |
| `workItemRepository#countPublicRoadmapSubmitted` | `workflow_status`            |
| `workItemRepository#findPublicRequestMatches`    | `workflow_status`            |
| `projectRepository#listPublicDirectoryRanked`    | `workspace` → `organization` |

Under RLS an unadmitted join returns **zero rows and raises nothing**, so each of these was a live
production defect — latent only because production still runs a `BYPASSRLS` role, and due to arrive
all at once at MOTIR-2515's cutover, on the roadmap, the duplicate-detection pre-check and the whole
project square. `publicProjectsService` and `projectSquareService` bind no context anywhere, so the
request path IS the context-less connection the tests reproduce.

**A read is admitted only if EVERY table it touches is admitted.** A policy-arm inventory describes
the FROM clause, not the query. Recorded as `notes.html` #269, planning bug MOTIR-2858.

The control that makes this a measurement rather than a story: `findPublicRoadmapByStatus` joins only
armed tables and PASSED under `motir_app` in the same run in which its three neighbours failed.

### What each card contributed

- **MOTIR-2856** — the three missing arms (`workflow_status_public_project_read`,
  `workspace_public_project_read`, `organization_public_project_read`), each gated on an unbound
  `app.workspace_id` so a tenant read pays nothing (all three subplans report `never executed` on the
  bound path). Its measurement also found that a correlated `EXISTS` beats an uncorrelated hashed
  `IN` by ~8× under the project square's `LIMIT` — `hashed SubPlan` is not a win to chase.
- **MOTIR-2857** — the two test defects that had hidden the class. `tests/projectSquare` wrote its
  fixtures through the app-role client (so `makePublic` silently failed), and
  `publicProjects/publicRoadmap.test.ts` never marked its project `public` at all. Both suites were
  green for months while asserting a public-visibility guarantee against a private project.
- **MOTIR-2833** — the eight verdicts, each naming its policy arm AND the run that settles it; the
  ceiling to 0; `'unreviewed'` out of the union; and one missing test: `projectRepository#listPublic`
  (the sitemap read) had **no test anywhere**, so no run could be cited for it. It is now covered in
  `publicProjects/publicAccessAndProjection.test.ts`, and mutation-checked — dropping
  `project_public_read` turns it red.

### The evidence, as run

```
TEST_DB_APP_ROLE=1 pnpm vitest run tests/publicProjects
  Test Files  11 passed (11)        Tests  87 passed (87)

TEST_DB_APP_ROLE=1 pnpm vitest run tests/projectSquare
  Test Files   6 passed (6)         Tests  76 passed (76)

TEST_DB_APP_ROLE=1 pnpm vitest run tests/rls/singleton-read-guard.test.ts
  Test Files   1 passed (1)         Tests   5 passed (5)
```

### What this does NOT close

**This entry closes the two ratchets in `singleton-read-guard.test.ts` — not the flag.** Flipping
`TEST_DB_APP_ROLE` is MOTIR-2734, and cutting the deployment over is MOTIR-2515.

The WRITE surface this section originally listed as still-open closed one day later — see _"CLOSED —
the WRITE surface is bound"_ (MOTIR-2865), which bound `importService.createDraft`/`preview`, the
very `tests/import` denials cited here while this card was in review. What remains between here and
the flag is the assertion residue MOTIR-2872 re-measures and the fixture population MOTIR-2871 owns;
neither is a read returning empty.

## THE DOWNSTREAM POPULATION, RE-MEASURED (MOTIR-2872, 2026-08-16)

The measurement MOTIR-2862 deferred. Its class 3 was 246 failures whose error was an assertion rather
than a database refusal, and it made **no claim** about what they become once classes 1 and 2 clear
(`notes.html` #249). This section takes that measurement on a tree where both have landed, and carves a
card per surviving class. **This section fixes nothing.**

### How it was measured

`TEST_DB_APP_ROLE=1 pnpm vitest run` on `origin/main` at **`1ca67750`** — MOTIR-2865 (`1ce054ff`),
MOTIR-2871 (`8d9acbf2`) and MOTIR-2874 (`923366e9`) all merged — against a Postgres cluster and base
database created for this run alone (`prodect_b2872`, worker DBs `prodect_b2872_test_wN`, so no
concurrent session's teardown can drop them).

|                      | MOTIR-2862 (`6d1a385f`) | this run (`1ca67750`) |
| -------------------- | ----------------------: | --------------------: |
| test files           |                   1 018 |             **1 026** |
| red files            |                     108 |                **67** |
| tests                |                  14 356 |            **14 636** |
| **failed**           |                 **652** |               **342** |
| passed               |                  13 703 |                14 293 |
| skipped              |                       1 |                     1 |
| **`does not exist`** |                   **0** |                 **0** |

**The `does not exist` count is 0 — a clean run.** A run showing hundreds of those has been trampled by
a concurrent vitest and must be discarded, not read.

> ⚠️ **Count `3D000` / `database "…_test_wN" does not exist`, not the bare phrase.** A loose grep for
> _"does not exist"_ over the run LOG also matches ordinary test NAMES: this run's log carries **10**
> such lines and **all 10 are on a passing test** (`✓ rejects a project that does not exist with
ProjectNotFoundError`), against **0** occurrences of `3D000`. Among failure MESSAGES specifically both
> counts are 0. The loose form reads a clean measurement as a trampled one.

Classified on **two axes kept separate** (`notes.html` #257) — the error's own class, and the first
non-`node_modules` frame — and then attributed by **reading the source of each failing (file, site)
pair**, which is what actually separates a fixture from an application defect.

### The two predecessor classes, by name, before and after

| named class                                                            | before |                                                            after |
| ---------------------------------------------------------------------- | -----: | ---------------------------------------------------------------: |
| **MOTIR-2865 — the WRITE surface, application side**                   |    166 |                                                            **0** |
| **MOTIR-2871 — the test-side residue** (statements through `@/lib/db`) |    240 | **0 within its 40 files**; 49 remain in 7 files it never covered |

Both named classes reached **zero inside their own scope**, which is the completion signal
(`notes.html` #249) — cross-checked mechanically: of MOTIR-2871's 40 changed test files, 9 are still
red and **not one carries an RLS refusal**; of MOTIR-2865's 15 changed files, 1 is still red, likewise
with **0 refusals**. The failures remaining in those files are assertions, i.e. they have moved into the
downstream population this section measures.

**The suite total did NOT fall by 406.** It fell by 310, from 652 to 342. **That is the expected shape,
not a failed fix** — what sat behind a refused INSERT is the next layer, not nothing. A reader who
expects the total to move by the sum of the class sizes will read two correct fixes as broken ones. This
is the third time this document has had to say so; it is said here before the question is asked.

### The partition — four classes, no residual bucket

| class                                                                | failures |    % | files |
| -------------------------------------------------------------------- | -------: | ---: | ----: |
| **1 — `withSystemContext` reads a table with no `system_admin` arm** |  **219** | 64.0 |    44 |
| **2 — test-side unbound repository READ in an assertion**            |   **67** | 19.6 |    12 |
| **3 — fixture write refused, in files no batch covered**             |   **49** | 14.3 |     7 |
| **Z — measurement artifact (not product state)**                     |    **7** |  2.0 |     4 |
|                                                                      |  **342** |  100 |    67 |

**There is no "other" bucket.** Every one of the 342 lands in exactly one class.

#### Class 1 — `withSystemContext` binds no workspace, and 45 of 69 tables have no arm for it (219, 44 files)

**This is a production defect class, and it is the reason class 3 could not be diagnosed from its
assertion text.** `withSystemContext` (`lib/workspaces/context.ts:121`) opens a transaction that sets
**only** `app.system_admin`:

```ts
return db.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
  return fn(tx);
});
```

Read back from the live cluster: of the **69** RLS tables, **24 carry a `system_admin` arm** on a
SELECT/ALL policy and **45 do not** — including `work_item`, `workspace`, `organization`,
`workspace_membership`, `sprint`, `comment`, `notification`, `watcher` and `custom_field_definition`.
So under `motir_app` every `withSystemContext` read of one of those 45 **returns empty and raises
nothing**. There are **89 call sites across 41 service files**.

Two proven instances, both read at their failing line:

- `parentStatusRollupService.rollUpForChild` (`:90`) resolves the neighbourhood in
  `withSystemContext`, whose first statement is `workItemRepository.findById(childId, tx)`. `work_item`
  has no arm ⇒ `resolved` is `null` ⇒ **`{ outcome: 'no_parent' }`**, which is exactly what
  `parentStatusRollup` (24) and `childStatusCascade` (18, via `childStatusCascadeService.ts:74`) assert
  against. **Status rollup and cascade silently stop working** once MOTIR-2515 points production at
  `motir_app`.
- `codeGraphIndexService.resolveIndexTarget` (`:154`) reads `githubInstallationRepository` and
  `projectRepository` — both **armed** — and then `workspaceRepository.findByIdInTx`, which is **not**;
  all four of `workspace`'s SELECT policies lack the arm. That is the `code-graph-index*` cluster (47).

This generalises MOTIR-2865's finding 2 (_"`withSystemContext` is not an escape hatch for the
tenant-root tables"_) from the WRITE side to the READ side, and from two membership tables to 45.

> **This is the measurement the section directly above asks for.** MOTIR-2864's entry closes on the
> observation that the two scanners have complementary blind spots — _"a `tx` that binds no GUC
> (theirs) and a GUC with no arm that reads it (this one). Neither is a call-site property, so no
> call-site scanner can see either. What would cover both is an assertion per (table, context) pair
> against `pg_policies` — **nothing today makes that claim**."_ The 24-vs-45 split above IS that claim,
> made for the `system_admin` context: it is a property of the POLICY set, read from `pg_policies`, and
> no call site was consulted to produce it. The two entries were written the same day from opposite
> ends and meet here. Making the equivalent claim for the OTHER contexts (`app.workspace_id`,
> `app.user_id`) is not done, and is the natural next instrument.

> **⚠️ Attribution confidence, stated rather than implied.** The mechanism is **proven** for the
> services named above. The per-file counts below are assigned by **association** — the test exercises a
> service that calls `withSystemContext` — not by reading all 89 sites. The carved card must confirm
> site by site; some of the tail may belong to class 2. The counts are given so the card can be sized,
> which is what they are for.

> **⚠️ AND THE 24/45 SPLIT IS A FLOOR, NOT THE BLAST RADIUS — `notes.html` #269 applies to it directly.**
> The MOTIR-2833 entry directly above establishes that **_"a read is admitted only if EVERY table it
> touches is admitted. A policy-arm inventory describes the FROM clause, not the query."_** The split
> above is exactly such an inventory, so a `withSystemContext` read whose target table IS armed can
> still return nothing because of an unarmed table it JOINS. **This measurement already contains an
> instance of that and it was not read as one at first:** `codeGraphIndexService.resolveIndexTarget`
> reads two armed tables (`github_installation`, `project`) and fails only on the third,
> `workspace` — the same shape as `projectRepository#listPublicDirectoryRanked` in MOTIR-2833's table,
> against a different context. So MOTIR-2880 must audit each site's whole query, not its FROM clause,
> and should expect the 219 to be a lower bound on what the class actually covers.

`jobs/code-graph-index` 29 · `integration/workflows/parentStatusRollup` 24 ·
`integration/workflows/childStatusCascade` 18 · `integration/workflows/statusDerivation` 12 ·
`github/githubCiFeedback` 9 · `github/githubWebhookService` 9 · `jobs/code-graph-index-first-audit` 9 ·
`gitlab/gitlabWebhookService` 8 · `projectRepos/projectRepoTeamAccess` 8 ·
`github/changeRequestTrunkGate` 7 · `github/githubWebhookEdges` 7 ·
`projectRepos/projectRepoTakeoverService` 7 · `integration/github/historical-pr-backfill` 6 ·
`cli/cliDeviceService` 5 · `jobs/code-graph-index-ledger-seam` 5 · `mcp/dependency-edges` 5 ·
`github/codeGraphIndexService` 4 · `billingService` 3 · `gitlab/gitlabWebhookCustomWorkflow` 3 ·
`gitlab/gitlabWebhookEdges` 3 · `github/explicitPrLink` 3 · `github/githubWebhookCustomWorkflow` 3 ·
`publicRequests/upvoteComment` 3 · `integration/work-items/provenance-backfill-gate` 3 · and 20 files
with 1–2 each.

#### Class 2 — the fixture's WRITE was migrated, its assertion's READ was not (67, 12 files)

The mirror of class 1, test-side. The twenty batches converted fixture **writes** to `adminDb` —
writes fail loudly with a refusal — and left the **reads** on the unbound `db` singleton, where they
fail silently by returning nothing. `tests/comments/repositories.test.ts` is the clean specimen: it
writes through `adminDb.$transaction(...)` at `:91` and then asserts on
`commentRepository.findById(b.id)` at `:98`, a bare read with no bound context.

Note that passing a `workspaceId` **argument** does not save these — `sprintRepository.findById(s,
a.workspaceId)` is an application-level filter, not the RLS GUC.

`integration/sprints/repository` 11 · `custom-fields/repositories` 10 ·
`labels-components-watch/repositories` 10 · `comments/repositories` 9 · `notifications/repositories` 7 ·
`last-active-project-seam` 4 · `boards/repositories` 4 · `integration/work-items/link-repository` 4 ·
`last-active-project` 3 · `api/live-projects-route` 2 · `automation/automation-rules-service` 2 ·
`ai/planChangeSessionsService` 1.

#### Class 3 — MOTIR-2871's shape, in seven files its scope never included (49, 7 files)

Every one is a fixture helper issuing a repository write through `db.$transaction` — the `@/lib/db`
singleton, which binds no workspace — e.g.
`db.$transaction((tx) => watcherRepository.add(item.id, fx.ownerId, tx))`. **MOTIR-2871 changed 42
files and none of these seven**, so this is residue outside its scope, not an incomplete migration of
it. Tables: `notification` (12), `work_item_embedding` (10), `import` (10), `custom_field_value` (6),
`watcher` (10), `custom_field_definition` (1).

`notifications/notificationsService` 12 · `embeddings/workItemEmbeddingRls` 10 ·
`integration/import/importSeam` 10 · `custom-fields/definitionsService` 7 ·
`integration/home/personal-reads` 6 · `integration/home/story-seams` 3 · `jobs/watcher-notify` 1.

`tests/embeddings/workItemEmbeddingRls.test.ts` is worth naming: its own comment says the fixture is
_"Seeded as the OWNER (fixtures legitimately span tenants — adminDb rationale)"_ while the code below
it uses `db`. The intent was recorded and the client was not changed.

#### Class Z — measurement artifact, NOT product state (7, 4 files)

Recorded so the 342 reconciles, and excluded from the carve. All 7 pass on a re-run of their own files
(8 files, 86/86):

- **3 — `58P01 could not load library …/llvmjit.so`** in `projectSquare/projectSquareGuarantees` (2) and
  `projectSquareRanking` (1). An artifact of the **userspace Postgres this run used**: the install
  recipe skips `libllvm14`, so JIT cannot load on the queries expensive enough to trigger it. Fixed for
  future runs with `ALTER SYSTEM SET jit = off`. **Add that to the isolated-cluster recipe.**
- **4 — `STACK_TRACE_ERROR`** in `auth/session-request-memo` (3) and `ciFleet/orchestratorPortBoundary`
  (1). Both spawn a child-process probe and parse its stdout; both were starved under full-suite load.

### Cards filed from this partition

| card           | class                                                  | kind | points |
| -------------- | ------------------------------------------------------ | ---- | -----: |
| **MOTIR-2880** | 1 — `withSystemContext` vs the 45 unarmed tables (219) | task |      8 |
| **MOTIR-2881** | 2 — test-side unbound repository reads (67)            | task |      5 |
| **MOTIR-2882** | 3 — fixture writes in seven uncovered files (49)       | task |      3 |

**MOTIR-2734** (retire `TEST_DB_APP_ROLE`) is now `blocked_by` MOTIR-2880, MOTIR-2881 and MOTIR-2882,
and its edge to MOTIR-2872 is dropped.

**MOTIR-2864** already owns `public_request_vote`'s missing workspace-member read arm; its PR was still
open at the time of this run, so `publicRequests/upvoteComment` (3) is still red here and is **not**
carved into any card above.

### ⚠️ What this partition does NOT claim

**Class 1 is the last layer this instrument can see, not necessarily the last layer.** Every measurement
in this document has been a census of what fails FIRST, and each one has revealed a layer the one before
it could not. A read that returns empty because `withSystemContext` binds nothing may itself be standing
in front of a further defect that only executes once the row is visible. The honest form of the
prediction is the same one MOTIR-2862 used: **no claim is made about what these 342 become once class 1
clears.** That is the next re-measurement's job, and it should be taken the same way — on a tree where
this class is already suppressed, with its own base database, and with the total expected NOT to fall by 219.

---

## CLOSED — the test-side unbound READ (MOTIR-2881, 2026-08-17)

MOTIR-2872's **class 2**: the fixture batches migrated the WRITES onto `adminDb` and left the
assertion-side READS on the `@/lib/db` singleton, which under the role is `motir_app` and binds no
workspace GUC. Measured at `50dba13b` with `TEST_DB_APP_ROLE=1`, the class reproduced exactly as
partitioned — **67 failed / 138 passed across the 12 named files** — and it closes at **58 fixed in 9
files**, with the other **9 reclassified to two application-side owners** (below).

### Before / after, by file

| file                                     | before |            after | how                        |
| ---------------------------------------- | -----: | ---------------: | -------------------------- |
| `integration/sprints/repository`         |     11 |            **0** | owner-side read            |
| `custom-fields/repositories`             |     10 |            **0** | owner-side read            |
| `labels-components-watch/repositories`   |     10 |            **0** | owner-side read            |
| `comments/repositories`                  |      9 |            **0** | owner-side read            |
| `notifications/repositories`             |      7 |            **0** | owner-side read            |
| `boards/repositories`                    |      4 |            **0** | bound the OWN workspace    |
| `integration/work-items/link-repository` |      4 |            **0** | bound + owner (MOTIR-2884) |
| `automation/automation-rules-service`    |      2 |            **0** | bound the workspace        |
| `ai/planChangeSessionsService`           |      1 |            **0** | bound the OWN workspace    |
| **the nine this card owns**              | **58** |            **0** |                            |
| `last-active-project-seam`               |      4 | → **MOTIR-2886** | application read           |
| `last-active-project`                    |      3 | → **MOTIR-2886** | application read           |
| `api/live-projects-route`                |      2 | → **MOTIR-2880** | application read           |

```
TEST_DB_APP_ROLE=1 pnpm vitest run \
  tests/integration/sprints/repository.test.ts tests/custom-fields/repositories.test.ts \
  tests/labels-components-watch/repositories.test.ts tests/comments/repositories.test.ts \
  tests/notifications/repositories.test.ts tests/boards/repositories.test.ts \
  tests/integration/work-items/link-repository.test.ts \
  tests/automation/automation-rules-service.test.ts tests/ai/planChangeSessionsService.test.ts
  →  Test Files  9 passed (9)      Tests  166 passed (166)
```

### The two dispositions, and which site gets which

The card's rule is "bind a context, or use `adminDb` where the assertion legitimately spans tenants —
chosen per site". In practice the choice was decided by the FILE's subject, and it fell out cleanly:

- **Five files are `ADJUDICATED_UNBOUND_FILES`** in `tests/rls/testCallSiteScan.ts` (MOTIR-2751 /
  MOTIR-2739/2747): their subject is the repository contract, the migration-built constraints, and the
  application's explicit `workspaceId` WHERE-clause gate, **with RLS deliberately inert**. Their reads
  now go through the SAME owner client their writes already used — a local `readAsOwner` helper wrapping
  `adminDb.$transaction`. Binding a workspace instead would have hidden every cross-workspace row twice
  over and made the gate assertions vacuous, which is precisely what those adjudications record.
- **Four files bind**, because their subject is the running system: `boards/repositories`,
  `integration/work-items/link-repository`, `automation/automation-rules-service` and
  `ai/planChangeSessionsService` now open `withWorkspaceServiceContext` around the assertion read.

**And the move has a coverage consequence, paid in the file that owns it.** Routing these reads onto a
client removed the last unbound caller from eight more repositories — every production caller already
threads a `tx` — so their `tx ?? db` fallback arms went uncovered, on files gated at the ≥90% branch
floor. Measured per method with `scanTestCallSites`, then re-measured as coverage: `commentRepository`
15/23 → 10/23 branches, `componentRepository` 15/18 → 10/18, `watcherRepository` 10/14 → 7/14, and five
more. This is the third time that sweep has happened (MOTIR-2815, MOTIR-2830, now), and the answer is the
same one those two settled: the orphaned arms are exercised deliberately, per role, in
`tests/rls/tx-fallback-arm.test.ts` — rows under the owner, EMPTY under `motir_app`. With that block
added, every affected file is back at or above its baseline branch count.

**Where a cross-workspace gate is the subject, bind the OWN workspace and pass the FOREIGN id as the
argument.** `boards/repositories` is the fixture: its four failures were all positive-half reads bound to
tenant `b` while reading tenant `a`'s board, so the policy hid the row the assertion wanted. Its negative
halves were already right — bound to `a`, reading with `b`'s id — and that ordering is what keeps the
WHERE-clause gate distinguishable from the policy.

### What the vacuous passes cost, and why the fix is wider than the 58

The 67 are the failures. The class is bigger: in the same files, **every assertion expecting `null` /
`[]` / `0` was passing for the wrong reason** — the policy had hidden the row, so `findById` after a
cascade delete, `existsFor` after an unwatch, and every foreign-workspace probe asserted nothing at all.
Those sites are converted here too, which is why the diff touches more call sites than the failure count
suggests. A read that has to be admitted before its emptiness means anything is the whole lesson of this
class, stated once more in the direction that does not go red.

### Two findings filed, not absorbed

- **[MOTIR-2884] the cross-workspace link trigger is INERT under `motir_app`.** Two of the four failures
  in `integration/work-items/link-repository` were not empty reads — they were a WRITE the trigger exists
  to refuse SUCCEEDING. `enforce_work_item_link_workspace()` is SECURITY INVOKER, so its own
  `SELECT … FROM work_item WHERE id = NEW."toId"` is RLS-filtered: the foreign item reads as missing, the
  function takes its documented "defer to the FK" branch, and the cross-tenant row lands. The migration
  predicted this question in 2026-05 and answered it for the group — _"within a single workspace every
  row shares one workspaceId, so the GUC will match"_ — which is true of the five same-tenant triggers
  and is the negation of what the sixth is for. Those two cases run as the owner here; the role-specific
  hole is that card's, with its own regression case under the role.
- **[MOTIR-2886] `resolveLastActiveContext` reads `project` under a USER-only context.** Seven failures
  across the two `last-active-project*` files, and not a test defect: `withUserContext` binds only
  `app.user_id`, `project` has arms only for `app.workspace_id` / `app.system_admin` / `accessLevel =
'public'`, so the read returns null and every cold landing silently falls back to first-by-createdAt.

`api/live-projects-route`'s two were handed to **MOTIR-2880** by comment with the `pg_policies` read-back:
`liveProjectsService.resolve` is a `withSystemContext` read whose `workspace: { is: {} }` JOIN hits a
table with no `system_admin` arm, so the offboarding backstop is told every live project is `absent`.

### For the next re-measurement

The suite total is **not** expected to fall by 58: as with every class before it, what sat behind an
empty read is the next layer, not nothing. And the two scanners still cannot see this class —
`testCallSiteScan` classifies these five files' reads as `adjudicated-unbound`, which is the correct
verdict about BINDING and says nothing about the client the read runs on. The instrument that would have
caught it is the one MOTIR-2864's entry already asked for: an assertion per (table, context) pair.

---

## `project`'s THIRD arm — the `withUserContext` member read (MOTIR-2886, 2026-08-17)

The carve MOTIR-2881's entry directly above hands off — seven failures across its two
`last-active-project` files, and not a test defect — resolved here. **It is also the first entry in
this document whose dead read is under `withUserContext` rather than a `workspace_id`-shaped
context**: every arm above is keyed on a bound workspace, a bound org, or the system flag, and that is
exactly why this one survived all of them.

`workspacesService.resolveLastActiveContext` (Subtask 8.8.27) is a RESOLUTION read: it computes WHICH
workspace the request acts within, so by construction no `app.workspace_id` exists yet. It runs inside
`withUserContext`, which binds only `app.user_id`. `project`'s two policies key on
`app.workspace_id` / `app.system_admin` (`project_workspace_or_system_read`) and on
`"accessLevel" = 'public'` (`project_public_read`). A private tenant project read from a user-only
context matches neither, so `projectRepository.findById` returned **null and raised nothing**, and
`resolveLastActiveContext` returned null one line before its access gate.

**The production effect is a wrong answer, not an error.** `resolveActiveWorkspace` falls through to
first-by-createdAt, so once MOTIR-2515 points the deployed runtime at `motir_app`, "land on the project
you last worked in" stops working for every user, on every cold landing, cross-device — and the
fallback it degrades to is a perfectly plausible workspace, so nothing looks broken and nothing logs.

`project_user_membership_read` (`20260817140000`) closes it: a `FOR SELECT` correlated `EXISTS` over
`workspace_membership`, **gated on `coalesce(current_setting('app.workspace_id', true), '') = ''`**.
The gate is the difference between a resolution affordance and a cross-tenant hole —
`withWorkspaceContext` binds `app.user_id` AND `app.workspace_id`, so an ungated membership arm would
have let every ordinary tenant request see the projects of every other workspace its acting user
belongs to. Both directions are asserted in `tests/last-active-project.test.ts`.

**Three notes for whoever audits the next context.**

- **This is the third independent instance of "bound, and admitted by nobody"**, after
  `public_request_vote` (MOTIR-2864) and MOTIR-2865's three unbound tenant reads. Neither scanner can
  see it — the read was bound, correctly, from the day it was written. What is new here is the axis:
  the two earlier instances were missing arms on a table for a WORKSPACE-tier reader; this is a missing
  arm for a whole CONTEXT. The per-`(table, context)` assertion against `pg_policies` that this
  document has now wished for twice would have caught all three, and `withUserContext`'s docstring now
  carries a table-by-table sufficiency list as the manual stand-in.
- **The vacuous passes outnumbered the failures, and were the more dangerous half.** Seven assertions
  across the two files went red; **three others kept passing while checking nothing**, because a
  function that returns `null` for the right reason and one that returns `null` two lines too early are
  indistinguishable from outside. Dropping the arm against the fixed tree now fails **12** of 29, not
  7 — the gap is the measure of how much of this defect a green-chasing fix would have left behind. The
  rule that closes it: **assert the intermediate** (the resolved project, the gate's own verdict, the
  pointer) — never only the terminal `null`.
- **A policy must not absorb the gate it stands in front of.** The arm keys on WORKSPACE membership;
  `organizationsService.resolveWorkspaceAccess` keys on ORG membership. Keeping them independent is
  what makes the revoked-org-membership case testable at all: the project now resolves and the GATE
  says no, where before the read died first and the gate never executed. Encoding the whole gate in SQL
  would have made every one of its tests vacuous in the other direction.

---

## CLOSED — the SYSTEM-CONTEXT class (MOTIR-2880, 2026-08-17)

Class 1 of MOTIR-2872's 2026-08-16 partition: **219 failures across 44 test files**, and the only
class in that partition that was a **production defect** rather than a test-harness artifact.

`withSystemContext` (`lib/workspaces/context.ts`) binds ONE GUC, `app.system_admin`, and that GUC is
read by a policy ARM that was added PER TABLE for the jobs runtime and operator tooling. Read back
from the migrated schema at this card's base commit: of the **69** tables with RLS enabled, **24
carried such an arm** on a permissive SELECT/ALL policy and **45 did not** — `work_item`,
`workspace`, `organization`, `workspace_membership`, `sprint`, `comment`, `notification`, `watcher`
among them. A read of one of the 45 inside a system context returns **zero rows and raises nothing**.

### The adjudication — 88 sites, by the tables each QUERY touches

Every `withSystemContext` call site in `lib/` + `app/` was adjudicated against **every table its
query touches — FROM _and_ JOIN**, resolved through the repository method it calls, the relation keys
that method's `include` / `select` / relation-filter literals name, and the FROM / JOIN targets of its
raw SQL. The walk follows a `tx` up to three hops.

|                                                        |  sites |
| ------------------------------------------------------ | -----: |
| touch only tables that carry a `system_admin` read arm | **78** |
| reach a table with **no arm** — the finding            | **10** |
| **total**                                              | **88** |

`notes.html` #269 decided the shape of that count and was not a formality: **two of the ten were
found through the JOIN and would have been cleared by an arm inventory.**
`projectRepository#findLivePairs` reads the armed `project` and dies on its `workspace: { is: {} }`
relation filter; `ciContainerPeriodCostRepository#sumForPeriodByMetaSplit` reads the armed
`ci_container_period_cost` and dies on `JOIN "organization"`. An eleventh was found only after the
scanner's helper walk was made recursive — `historicalPullRequestBackfillService#sweepRepo` reaches
`work_item` two hops down, through `applyOne` into the imported `resolveChangeRequestWorkItem`, and a
one-hop walk reported it fully armed while six of its tests were red.

### The disposition — BIND is the default; ARM is for the cross-tenant read

The card owned a decision between binding the workspace and arming the 45 tables. **Neither, as a
uniform answer.** The discriminator is whether a tenant is KNOWABLE at the read:

**Bound (9 of 11)** — `bindWorkspaceContext(tx, id)` / `bindOrganizationContext(tx, id)` the moment
the id is known, or the whole block moved to `withWorkspaceServiceContext`. Binding is ADDITIVE: the
system flag stays set, so the connection-tier reads in the same transaction keep their own arm, and
nothing is widened.

| site                                              | tenant came from                      | how                                                              |
| ------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `parentStatusRollupService#rollUpForChild`        | the `work-item/transitioned` envelope | `withWorkspaceServiceContext` (new `workspaceId` parameter)      |
| `childStatusCascadeService#cascadeToChildren`     | the same envelope                     | `withWorkspaceServiceContext` (new `workspaceId` parameter)      |
| `firstAuditTriggerService#deriveFirstAudit` (×2)  | its own argument                      | `withWorkspaceServiceContext`                                    |
| `codeGraphIndexService#resolveIndexTarget`        | its own argument                      | `bindWorkspaceContext`, after the armed installation read        |
| `changeRequestStatusSync#syncChangeRequestStatus` | `repo.workspaceId` (MOTIR-1931)       | `bindWorkspaceContext`, after `resolveContext`                   |
| `changeRequestCiFeedback#applyCiStatusFeedback`   | `repo.workspaceId`                    | `bindWorkspaceContext`, after `resolveContext`                   |
| `historicalPullRequestBackfillService#sweepRepo`  | `repo.workspaceId`                    | `bindWorkspaceContext`, at the top of the per-PR block           |
| `projectRepoTakeoverService#applyTransferred`     | a `github_repo` read (armed)          | two-step: resolve the repo, bind, then read `project_repository` |
| `billingService#syncScaledTrackerSeatQuantity`    | its own argument                      | `bindOrganizationContext`                                        |

**Armed (2 of 11)** — `20260817120000_system_admin_read_arms_workspace_organization`, `FOR SELECT`
only:

| site                                       | table          | why it cannot bind                                                                                                |
| ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `liveProjectsService#resolve`              | `workspace`    | answers a BATCH of (workspaceId, projectId) pairs from motir-ai in one call — spanning workspaces is the endpoint |
| `ciFleetCostMeterService` (the meta split) | `organization` | groups EVERY org's container cost by `organization."isMeta"`                                                      |

**The arms are READ-only, deliberately.** MOTIR-2865 established that the ABSENCE of a system arm on
the tenant-root WRITE policies does useful work — a caller reaching for `withSystemContext` on a
membership INSERT is REFUSED rather than over-permitted. Postgres combines policies per COMMAND, so a
`FOR SELECT` policy widens reads and only reads; the six write policies on those two tables are
untouched, and `system-context-arm-guard.test.ts` asserts against a system arm ever appearing on one.

### Three production defects this was, not three test failures

- **Parent status rollup and child cascade stop.** Both resolve their neighbourhood with
  `workItemRepository.findById` as the FIRST statement inside the system context. `resolved` was
  `null`, so every rollup answered `{ outcome: 'no_parent' }` and every cascade `unresolvable`. A
  parent whose children all finished would simply never have moved, with nothing logged.
- **The change-request sync stops driving status, and CI feedback stops arriving.** Both resolve the
  connection tier (armed), then the linked work item (not armed). Every PR event resolved to
  `no_work_item` — no In Review on open, no Done on merge, no verification comment.
- **The historical PR backfill mirrors a null link for every PR**, because its work-item resolve was
  two hops below a system context. `unresolvable` is a legitimate outcome the report counts, so the
  sweep would have completed and reported success.

Plus: first-audit derivation reporting `no_owner` for every repo, code-graph indexing reporting
`workspace_missing` for a workspace that exists, seat billing reporting
`no_active_tracker_subscription` for every org, the repo-transfer saga reporting `unknown_repo` for a
transfer Motir itself requested, the live-project resolver answering `absent` for every pair (the
caller DELETES on that), and the fleet cost meter reporting zero.

### The guard — per (table, context), against `pg_policies`

`tests/rls/contextArmScan.ts` (named `systemContextScan.ts` until MOTIR-2959 made the GUC a
parameter) + `tests/rls/system-context-arm-guard.test.ts`. **This is the
instrument MOTIR-2864's entry asked for and MOTIR-2881's closing section names again** — _"an
assertion per (table, context) pair"_ — built here because this class is the one that cannot be
found any other way. It is the FOURTH scanner, and the first that asks a question about the
database:

```
singleton-read-guard   — can this read be bound?          (a `tx` parameter)
call-site-guard        — do its callers bind it?          (a `tx` argument)
bare-transaction-guard — what did the transaction bind?   (a `set_config`)
system-context-arm     — does any POLICY read what it bound?
```

Every site in this class answered YES to the first three and was dead anyway. The guard reads the
arm inventory from **`pg_policies`**, not from the migrations — the arm is a property of the deployed
policy set, and the migration files are a claim about it (`notes.html` #248) — and adjudicates each
statement by its POSITION relative to the binding, because the fix for nine of eleven sites is a bind
placed MID-BLOCK and a whole-site boolean would clear their surviving pre-bind reads.

Shown RED in both directions before it was trusted: dropping `workspace_system_read` from the
migrated base turns it red naming `liveProjectsService#resolve`; removing the
`bindWorkspaceContext` from `changeRequestStatusSync` turns it red naming `work_item` and
`workspace_membership`. `DELIBERATELY_SYSTEM_ONLY` is **empty**, and the second assertion fails a
verdict left behind for a pair the scan no longer reports.

### The evidence, as run

Reproduce-before-fix, the two named services, with phase 1 mutated back to `withSystemContext`:

```
TEST_DB_APP_ROLE=1 pnpm vitest run tests/integration/workflows/{parentStatusRollup,childStatusCascade,statusDerivation}.test.ts
  BEFORE (phase 1 on withSystemContext)   Tests  56 failed | 8 passed (64)
  AFTER                                   Tests  64 passed (64)
```

The class, over the 23 named files of MOTIR-2872's class-1 list:

```
TEST_DB_APP_ROLE=1 pnpm vitest run <the 23 named files>
  BEFORE (MOTIR-2872's measurement)  219 failed across 44 files
  AFTER                              Tests  26 failed | 401 passed (427)
```

And the default connection, which is what CI runs today — the 23 files plus every other file this
card touches, plus `tests/rls`:

```
pnpm vitest run <the 23 files> tests/ciFleet/ciFleetCostMeterService.test.ts \
  tests/api/live-projects-route.test.ts tests/billing-seat-sync.test.ts tests/rls
  Test Files  33 passed (33)        Tests  562 passed (562)
```

### ⚠️ What this does NOT close, and what the 26 are

**The suite total is not expected to fall by 219, and this entry does not claim it did.** The 44-file
attribution in MOTIR-2872 was explicitly BY ASSOCIATION — a test exercises a service that calls
`withSystemContext` — and part of the tail belongs to other classes. Measured per file: fifteen of
the 23 named files went to zero, and **26 failures survive in seven of them, none of them this
class.** The scan reports no system context reaching an unarmed table, and the mechanism behind the
survivors was read by hand for ten of the 26:

| file                                              | left | mechanism                                                                                                                                                        |
| ------------------------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectRepos/projectRepoTeamAccess`              |    8 | not a system context — `projectRepoAccessService` uses none                                                                                                      |
| `mcp/dependency-edges`                            |    5 | a test-side repository read with no `tx`, plus MOTIR-2884's inert trigger                                                                                        |
| `cli/cliDeviceService`                            |    5 | test-side `await db.apiToken.findMany()` assertions — MOTIR-2881's class 2, in a file its list does not name                                                     |
| `integration/work-items/provenance-backfill-gate` |    3 | test-side, undiagnosed                                                                                                                                           |
| `github/githubWebhookCustomWorkflow`              |    2 | `dropStatusCategory` is a **fixture written on `withSystemContext`** — `workflow_status` has no arm, so the deletion is a silent no-op and the workflow survives |
| `gitlab/gitlabWebhookCustomWorkflow`              |    2 | the same fixture helper                                                                                                                                          |
| `github/githubWebhookService`                     |    1 | a test-side `withSystemContext` fixture                                                                                                                          |

The last three are a class of their own and worth naming: **a test FIXTURE written on
`withSystemContext` fails the same silent way the application code did** — the memory rule is that a
fixture uses `adminDb`, the OWNER, never a wider GUC on the runtime client. This scanner does not
walk `tests/`, deliberately: extending it there is the natural next card and would collide with
MOTIR-2881 / MOTIR-2882, which own the test side today.

## CLOSED — the seven fixture files outside MOTIR-2871's scope (MOTIR-2882, 2026-08-17)

Class 3 of MOTIR-2872's 2026-08-16 re-measurement: **49 refused writes across 7 test files**, every
one a fixture helper issuing a repository write through `db.$transaction` — the `@/lib/db` singleton,
which under `motir_app` binds no workspace GUC, so the policy's `WITH CHECK` refuses it.

**These seven were never an incomplete migration of MOTIR-2871.** That card changed 42 files and none
of these; its named class reached zero inside its own scope. The file set was drawn from a
measurement, and a measurement taken at one moment names the files failing at that moment — these
seven were not on that list, so they were not in that card.

### Before / after, by name

Measured on this branch off `origin/main` @ `50dba13b`, `TEST_DB_APP_ROLE=1 pnpm vitest run` over
exactly the seven files:

| file                                               | table(s) refused                                 | before | after |
| -------------------------------------------------- | ------------------------------------------------ | -----: | ----: |
| `tests/notifications/notificationsService.test.ts` | `notification`                                   |     12 |     0 |
| `tests/embeddings/workItemEmbeddingRls.test.ts`    | `work_item_embedding`                            |     10 |     0 |
| `tests/integration/import/importSeam.test.ts`      | `import`                                         |     10 |     0 |
| `tests/custom-fields/definitionsService.test.ts`   | `custom_field_value` / `custom_field_definition` |      7 |     0 |
| `tests/integration/home/personal-reads.test.ts`    | `watcher`                                        |      6 |     0 |
| `tests/integration/home/story-seams.test.ts`       | `watcher`                                        |      3 |     0 |
| `tests/jobs/watcher-notify.test.ts`                | `watcher`                                        |      1 |     0 |
| **total**                                          |                                                  | **49** | **0** |

```
# BEFORE (origin/main content, same worktree, same database)
TEST_DB_APP_ROLE=1 pnpm vitest run <the seven files>
  Test Files  7 failed (7)          Tests  49 failed | 79 passed (128)

# AFTER
TEST_DB_APP_ROLE=1 pnpm vitest run <the seven files>
  Test Files  7 passed (7)          Tests  128 passed (128)
```

The before-run's refusals, counted by table, are exactly the distribution the partition predicted:
`work_item_embedding` 10, and one apiece for `custom_field_definition`, `custom_field_value`,
`import`, `notification`, `watcher` (the per-table count is of distinct error sites; the per-file
count above is of failing tests).

### The READS were done in the same pass — deliberately

Class 2 of the same partition exists because an earlier migration converted the half that RAISES an
error and left the half that returns an empty result. An RLS-denied `SELECT` removes rows and raises
nothing, so a fixture converted by error message leaves its assertions to fail silently later, under
a different class name. Two files carried assertion-side singleton reads and both were converted:

- **`tests/integration/import/importSeam.test.ts`** — 16 direct-DB assertion reads
  (`workItemCount`, `mappingRowCount`, and the per-test `findUniqueOrThrow` / `findMany` / `count`
  read-backs) plus one mid-test `workItem.update`. All now on `adminDb`, which is what the file's own
  two-client model already used for its `TRUNCATE`.
- **`tests/embeddings/workItemEmbeddingRls.test.ts`** — the ADR §4/§5 cascade block. `db.workItem.delete`
  followed by `expect(...findUnique(...)).toBeNull()` is the vacuous-pass shape in miniature: under
  `motir_app` with no GUC the delete is refused AND the read is denied, so the assertion passes while
  proving nothing about the cascade. Both halves are now `adminDb`.

**`asAppRole` in the embeddings file keeps its `db.$transaction` — it is the code under test.** That
helper deliberately `SET LOCAL ROLE motir_app` inside a singleton transaction; converting it would
delete the suite's entire point. This is the one site in the seven where the singleton is correct.

### No `lib/` file was modified, and no application-side writer was found

Every one of the 49 sites is a test fixture. The sweep found no application-side writer to hand to
MOTIR-2880 — the `lib/` write surface closed under MOTIR-2865, and the bare-`db.$transaction` axis
in `lib/` is MOTIR-2876's scanner. Nothing to file.

---

## The parent-chain triggers were leaning on the SERVICE (MOTIR-2895, 2026-08-17)

Not a dead read, and not a refused write — the first entry in this document about a **check that ran,
passed, and proved nothing**. It is the other half of MOTIR-2884, and it was found by writing that
card's per-function verdict rather than by any instrument.

`enforce_work_item_kind_parent`, `enforce_work_item_depth_limit` and `enforce_work_item_no_cycle`
(`prisma/sql/work_item_triggers.sql`) each RESOLVE the parent — by id for the kind matrix, by recursive
CTE up the ancestor chain for depth and cycle — and each DEFERS to the foreign key when that lookup
comes back NULL. Their premise, written down in 1.4.2 and re-affirmed as a group verdict by 1.4.5, is
that every row they walk shares the writer's context. **That premise was true, and it was true because
`workItemsService` refuses a cross-project parent (`CrossProjectParentError`, on create and on both
re-parent paths). Nothing in the database compared `parent."workspaceId"` or `parent."projectId"` with
the child's at all** — so the DB backstop's completeness rested on the application check it exists to
backstop, which is the one thing a backstop may not do.

`20260817160000_work_item_parent_tenancy` adds the missing check (`enforce_work_item_parent_tenancy`,
markers `WI_PARENT_CROSS_WORKSPACE` / `WI_PARENT_CROSS_PROJECT`, translated at the repository edge to the
same `CrossProjectParentError` the service throws) and re-decides the three on the evidence it creates.

**What the re-decision measured**, with a writer bound to (W1, P1) and a legal 4-deep chain in W1/P1b:

| write, as `motir_app`                                    | under SECURITY INVOKER                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| ORM `create` (emits `RETURNING`) of a 5th level into P1b | rejected — **by RLS**, `work_item_project_narrow`, not by the trigger |
| raw INSERT (no `RETURNING`) of a 5th level into P1b      | **ACCEPTED, row landed** — the depth walk under-counted               |
| raw INSERT (no `RETURNING`) of a kind-illegal child      | **ACCEPTED, row landed** — the kind matrix never applied              |
| raw UPDATE re-parent, `WHERE id = <a P1b row>`           | 0 rows — the restrictive SELECT policy hides the row from the UPDATE  |
| raw UPDATE re-parent with NO `WHERE`                     | reached the P1b rows (the kind trigger fired on one)                  |

Three things in that table are worth carrying forward:

- **The WORKSPACE axis is now a database invariant; the PROJECT axis is not.** RLS's own `WITH CHECK`
  pins the written row's `workspaceId` to `app.workspace_id`, and the new check pins the parent's to the
  child's, so the whole ancestor chain shares the bound workspace by induction. But
  `work_item_project_narrow` is RESTRICTIVE **FOR SELECT only**, so nothing pins the written row's
  PROJECT to the bound one: a caller bound to P may legally insert into Q of the same workspace, and the
  walk then truncates. **Chain tenancy is not chain visibility.** 39 shipped `withWorkspaceContext(`
  call sites bind a non-empty `projectId`, and two of them (`plansService`,
  `migrateOnboardingService`) are the paths that write work-item trees with parents.
- **The ORM masked it, which is why a year of tests could not see it.** Prisma's `create` always emits
  `RETURNING`, and the same restrictive policy rejects the RETURNED row — so through the ORM this shape
  surfaces as an RLS error and the trigger's silent under-count is never observed. The masking is absent
  for a direct SQL write, which is the first scenario the trigger file names as its own reason to exist.
  **A guard proved only through the ORM is a guard unproved against the case it was built for.**
- **The verdict is per function, including where it nearly went the other way.** `cycle` fires only on
  `UPDATE OF "parentId"`, and an UPDATE that reads any existing column value has the restrictive SELECT
  policy applied to its row lookup — so a row whose chain the invoker cannot walk is a row it cannot
  update (row 4). Given parent tenancy that argument is sound, and it is the one the card predicted.
  It is defeated only by row 5. All four functions are therefore SECURITY DEFINER with a pinned
  `search_path`, but on a narrower reachability for `cycle` than for `kind` / `depth`, and the migration
  records the difference rather than flattening it into a second group verdict.

**What makes the widened reach safe is the FIRING ORDER, not the audit.** Postgres fires per-row BEFORE
triggers in alphabetical order by trigger name, and the names sort `cotenancy` → `cycle` → `depth` →
`kind`. A cross-tenant `parentId` aborts the statement before the other three read anything, so their
definer lookups can only ever address rows sharing the writing row's workspace AND project. The
ordering is load-bearing for the security argument; `trg_work_item_cotenancy`'s name is chosen for it.

---

## CLOSED — the test-side FIXTURE on `withSystemContext` (MOTIR-2887, 2026-08-17)

MOTIR-2880's entry closes with _"what this does NOT close"_: 26 failures surviving in seven of the 23
files its class was attributed to, and a note that three of them were **a test FIXTURE written on
`withSystemContext`**. This is that class, plus the honest partition of the rest.

### The class, and why it is DIFFERENT from MOTIR-2880's by OWNER rather than by symptom

The two are indistinguishable in a failure log and identical in mechanism — a read inside a system
context touches a table with no `system_admin` arm, returns zero rows, and raises nothing. What
separates them is **who issued it**, and that changes which direction the failure points:

|                 | MOTIR-2880 (the RUNTIME class)      | MOTIR-2887 (the FIXTURE class)                            |
| --------------- | ----------------------------------- | --------------------------------------------------------- |
| issuer          | application code in `lib/`          | test setup / teardown / a direct-DB assertion             |
| what goes wrong | the product cannot see its own data | the SETUP silently does nothing                           |
| how it presents | a feature is visibly broken         | **the test passes, or fails pointing at the wrong thing** |
| the fix         | BIND the tenant, or ARM the table   | neither — a fixture belongs on `adminDb`, the OWNER       |

The fixture direction is the worse of the two. `dropStatusCategory` in
`tests/github/githubWebhookCustomWorkflow.test.ts` (and its `gitlab` twin) deleted every `done`-category
status to build a degenerate custom workflow. `workflow_status` carries one policy —
`workflow_status_active_workspace`, keyed purely on `app.workspace_id`, **no `system_admin` arm** — so
under `motir_app` the `findMany` returned `[]`, both `deleteMany`s matched nothing, and the custom
workflow was never created. The test then measured the DEFAULT workflow while its name claimed it was
measuring a custom one, and reported `outcome: 'transitioned'` against an expected
`'no_matching_status'` — an assertion that reads as a regression in the status sync and is in fact a
setup step that succeeded at doing nothing.

**The rule is not new, and that is the point.** A fixture uses `adminDb` (the database OWNER), never a
wider GUC on the runtime client — the same sentence `tests/helpers/adminDb.ts` has carried since
MOTIR-2513. What was missing was an instrument pointed at the test tree.

### The measured policy set — 2 of the 8 tables involved are unarmed

Read from `pg_policies`, not from the migrations (`notes.html` #248):

| table                    | policy                                          | `system_admin` arm |
| ------------------------ | ----------------------------------------------- | :----------------: |
| `workflow_status`        | `workflow_status_active_workspace` (ALL)        |       **no**       |
| `workflow_transition`    | `workflow_transition_active_workspace` (ALL)    |       **no**       |
| `code_graph_offboarding` | `code_graph_offboarding_system_only` (ALL)      |        yes         |
| `github_identity`        | `github_identity_owner_or_system` (ALL)         |        yes         |
| `github_installation`    | `github_installation_workspace_or_system` (ALL) |        yes         |
| `github_pull_request`    | `github_pull_request_workspace_or_system` (ALL) |        yes         |
| `github_repo`            | `github_repo_workspace_or_system` (ALL)         |        yes         |
| `import_source_identity` | `import_source_identity_owner_or_system` (ALL)  |        yes         |

**Only the `workflow_*` pair was actually blind**, which is worth stating plainly because the first
draft of this entry claimed otherwise for five of the eight. The 24 sites converted here split into
**4 failures fixed** and **20 sites moved for rule-conformance** — the arm is a property of the
DEPLOYED policy set, and the `workflow_*` row above is this same sweep's proof that a table can simply
not have one.

### The sweep — 24 FIXTURE sites converted, 72 CODE-UNDER-TEST sites left alone

`git grep -l withSystemContext -- tests/` returns **39 files**, far more than the three MOTIR-2880
named — and the card's parenthetical _"there should be none [exercising the code under test] in
`tests/`"_ is empirically false. `tests/ciFleet/fleetCeiling.test.ts` alone carries both kinds. The
discriminator is the block's ROLE in the test, not its syntax:

- **CONVERTED (24 sites, 15 files)** — the callback addresses `tx.<model>` directly. Setup, teardown, or
  a direct-DB assertion. These are the fixture class.
- **LEFT (72 sites)** — the callback hands `tx` to the service or repository under test.
  `withSystemContext((tx) => fleetCeilingService.census(NOW, tx))` is the jobs runtime's own calling
  context; `withSystemContext((tx) => replayDLQ(dlqId, tx))` is the operator route's — today
  `platformJobReplayService.replayOne`, reached from `/admin/jobs` → **Dead letters**' **Replay** and
  **Replay all** controls (MOTIR-9985 · MOTIR-9986). It replaced the tenant dashboard's System tab
  door (`replaySystemDLQ`, MOTIR-8083) and its manager-gated `withWorkspaceContext` door, both
  deleted with that dashboard (Story MOTIR-9982), so it is now the only `replayDLQ` caller outside the
  tests. It bypasses tenant RLS, so its refusal lives in the SERVICE, not the action or the UI: the
  caller must hold the `operator` platform role or above (`User.platformRole`, read fresh through
  `requirePlatformStaff`; the page itself opens at `support`). Moving these to
  `adminDb` would make them pass by taking the code under test off the restricted role, which is the
  one way this work fails silently (`tests/helpers/adminDb.ts`'s own ⚠️).

The convention was already established in the tree and simply not applied uniformly: `tests/jobs/dlq.test.ts`
keeps `replayDLQ` on `withSystemContext` and asserts through `adminDb.jobRunDlq.findUnique` in the same test.

### The instrument — `systemContextScan` (now `contextArmScan`) walks `tests/`, and the guard adjudicates it

`SCAN_ROOTS` gains `tests`, `walk()` skips `__fixtures__` (the scanner's own negative fixture is a
separate root with its own cache key), and `enclosingName` gains a case for a test callback. That last
one is not cosmetic: in `lib/` every site sits in a named function or const, and in `tests/` the
commonest enclosing scope is an ANONYMOUS arrow handed to `it(…)` — every such site would key as
`<module>` and collapse onto its neighbours. The key is now `it:<the test's title>`, which is
line-independent in exactly the way the sibling guards' keys are.

**156 sites total, 72 of them in `tests/`.** All 72 are green: every table they reach is either armed or
has RLS disabled, which is the correct verdict — a system-context read of an ARMED table from a test
that is reproducing the production caller is coverage, not a defect.

Shown RED by re-introducing the `dropStatusCategory` fixture, which names both tables:

```
tests/github/githubWebhookCustomWorkflow.test.ts#dropStatusCategory :: workflowStatus
  -> "workflow_status" has RLS and NO system_admin read arm (reached via tx.workflowStatus, tx.workflowTransition)
tests/github/githubWebhookCustomWorkflow.test.ts#dropStatusCategory :: workflowTransition
  -> "workflow_transition" has RLS and NO system_admin read arm (reached via tx.workflowStatus, tx.workflowTransition)
```

…then green on restore.

### The measurement — 26 → 22, and the 22 re-attributed per site

```
TEST_DB_APP_ROLE=1 pnpm vitest run <the 7 files>
  before:  Tests  26 failed | 100 passed (126)
  after:   Tests  22 failed | 104 passed (126)
```

Both `customWorkflow` files went to **zero**. The remaining 22 are **not this class**, and none of them
is left undiagnosed — MOTIR-2872's partition attributed all 26 to class 1 BY ASSOCIATION and said so;
this is the per-site reading it deferred:

| file                                              |   n | mechanism                                                                                                                                                                                                                                                      | owner                                                                                          |
| ------------------------------------------------- | --: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `projectRepos/projectRepoTeamAccess`              |   8 | `github_identity`'s only arms are `system_admin` and `user_id = app.user_id`. `listTeamAccess` reads OTHER members' logins inside `withWorkspaceContext`, which binds `app.user_id` to the CALLER → `no_github_identity` for every teammate                    | **MOTIR-2910** (new; production)                                                               |
| `github/githubWebhookService`                     |   1 | `membership_visible_active_or_own` has **no `system_admin` arm**, and `resolveGithubChangeRequestContext` passes `repo.workspaceId` as an argument without BINDING it → `resolveBoundMember` returns null → a member's PR is attributed to the workspace OWNER | **MOTIR-2910** (new; production)                                                               |
| `mcp/dependency-edges`                            |   4 | `workItemLinkRepository.findBlockedEdgesForItems([…])` called with no `tx` — the unbound singleton                                                                                                                                                             | **MOTIR-2911** (MOTIR-2881's class 2)                                                          |
| `cli/cliDeviceService`                            |   4 | `db.apiToken.findMany()` / `.count()` assertion reads on the unbound singleton                                                                                                                                                                                 | **MOTIR-2911** (MOTIR-2881's class 2)                                                          |
| `cli/cliDeviceService`                            |   1 | `db.organizationMembership.deleteMany(…)` fixture write deletes nothing, so the "lost the workspace" precondition never happens                                                                                                                                | **MOTIR-2911** (MOTIR-2882's class 3)                                                          |
| `integration/work-items/provenance-backfill-gate` |   3 | `findProvenanceBackfillCandidates(…)` with no `tx`; the comparison case's `db.$transaction` binds nothing either, so both arms read empty                                                                                                                      | **MOTIR-2911** (+ MOTIR-2876's bare-transaction class)                                         |
| `mcp/dependency-edges`                            |   1 | the cross-workspace pre-check reads the foreign item through the caller's context, so it is MISSING before the cross-workspace rule is reached — `WorkItemNotFoundError`, not `CrossWorkspaceLinkError`                                                        | **undecided** — flagged NOT-in-scope on MOTIR-2911; arguably the new behaviour is more correct |

### ⚠️ What this does NOT close

**Nine of the 22 are a PRODUCTION defect this card surfaced and did not fix** (MOTIR-2910). A workspace
member's GitHub login is invisible to every other member, so the repo-access team grid renders
`not_invited` for the whole team, and the webhook attributes a member's PR to the workspace owner. Both
are silent. Neither is a test problem, and neither was visible before the suite ran as `motir_app` —
which is the case for the cutover, stated in the one form that is hard to argue with.

**And MOTIR-2880's scanner reports the webhook site GREEN.** The read is two hops from its
`withSystemContext`, through a function that receives `tx` as a parameter. Whether that is
`MAX_HELPER_HOPS`, a resolution shape `reachableHelpers` does not follow, or a `binds-tenant` verdict
off a bind on another branch is MOTIR-2910's to establish — but the instrument built to find exactly
this class did not find this instance, and that is the more durable finding of the two.

## The INSTRUMENT for the direct-singleton statement (MOTIR-2918, 2026-08-17)

Not a class closed — a class **enumerated for the first time**. MOTIR-2911's fourth acceptance
criterion asked which instrument was supposed to have found its three files, and for
`tests/cli/cliDeviceService.test.ts` the answer was _none_. A statement written straight onto the
`@/lib/db` singleton inside a test — `expect(await db.apiToken.count()).toBe(0)` — matches no pattern
in any of the five scanners this document tracks, and never has. `testCallSiteScan` is the near miss:
it reads the same directory and asks about a `<x>Repository.<method>(…)` CALL, which a test that
addresses Prisma directly does not have anywhere on the line.

`tests/rls/testSingletonStatementScan.ts` + `tests/rls/test-singleton-statement-guard.test.ts` are
that instrument. It walks `tests/` for `db.<model>.<ANY-op>(…)` — no whitelist of operation names —
reusing `testCallSiteScan`'s `isClientExpression` over a NARROWER name set (`SINGLETON_ONLY = {db}`)
so `adminDb` and a bare `tx`, the two already-correct forms, are not reported, while the inline
`(tx ?? db)` fallback is.

### The population, measured on `origin/main` @ `bd0584c5`

**575 statements across 130 files**, plus **30** `$queryRaw*` / `$executeRaw*` whose target table a
parser cannot name (28 outside `tests/e2e/**`, 2 within). **0 unclassifiable.**

|                 | not-gated | no-policy | subject | fixture | assertion | undispositioned | **has to change** |
| --------------- | --------: | --------: | ------: | ------: | --------: | --------------: | ----------------: |
| `tests/e2e/**`  |        68 |         1 |       0 |       0 |         0 |         **454** |           **454** |
| everywhere else |         6 |        41 |       1 |       0 |         4 |               0 |             **4** |

Two ceilings, not one, because the two halves have different remediations: the E2E half is a spec
seeding through the singleton before it drives the browser, and its fix is a seeding HELPER on
`adminDb` rather than 454 per-line swaps. It is latent today only because the E2E lane still runs as
the owner, and it becomes a hard failure the moment **MOTIR-2734** makes `motir_app` the only
connection. The vitest half is a per-line decision and is four statements in one file.

### Two verdicts that are NOT work, and how each was established

- **`no-policy` — `device_code`, 42 statements (41 of them the CLI suites).** `policyGatedModels`
  over-approximates on purpose: a model carrying a `workspaceId` column is in scope whether or not
  its table was ever put under RLS. Measured on a cluster built by `prisma migrate deploy` from
  empty: `device_code` is `relrowsecurity=f, 0 rows in pg_policies`. The same query settles the
  other direction, which an exemption list normally cannot show — of every model addressed anywhere
  under `tests/`, exactly six tables have RLS off, and the other five (`user`, `account`, `session`,
  `idea_draft`, `user_appearance_preference`) already come out `not-gated` on their own. So the
  exemption list is COMPLETE against that measurement, not merely populated with what someone
  noticed. The guard additionally refuses any entry that a migration contradicts.
- **`subject` — `tests/tenant-root-creation-rls.test.ts`, 1 statement.** The file asserts that an
  INSERT into a tenant root outside a bootstrap context is REFUSED, which only happens on the unbound
  singleton. `adminDb` is the owner and would be allowed; a bound context supplies the very GUC the
  test withholds. Either "fix" deletes the assertion and leaves it green.

### What the first run found that two hand sweeps did not

Four `expect(await db.apiToken.count()).toBe(N)` assertion reads in
**`tests/cli/cli-device-routes.test.ts`** — MOTIR-2911's exact founding shape, against the same table
(`api_token`: `relrowsecurity=t`, 1 policy), in the sibling file its hand-built list never named.
Three of the four assert `toBe(0)`, which under `motir_app` passes because the policy hides the rows.
They are recorded as `assertion` in `DISPOSITIONED_FILES` and **not converted here** — this card
changes no test's behaviour by design, so the ruling is inherited rather than re-derived.

### ⚠️ What this does NOT close

**Nothing is converted.** 458 statements still have to change, and the numbers above are what the
conversion cards are sized off — the whole point of measuring with nobody holding the instrument.

**The 30 raw statements have no per-site adjudication.** Their target tables are not nameable from
the syntax; they are ratcheted so the count cannot grow, and reading them is the next card's.

**A file-level ruling is coarse, deliberately.** A statement of a different kind added to a
dispositioned file later inherits that file's ruling in silence. What bounds it is the ceiling, which
counts `fixture` + `assertion` + `undispositioned` together, so a new statement in an `assertion` file
still raises the number it must not raise.

**And the scanner's own blind spots, stated because the absence of this sentence is what let the
class survive five scanners:** it reads `tests/` only, never `lib/` / `app/` / `scripts/`; it does not
follow a client passed into a helper as a parameter; and it does not resolve `db` re-exported under
another name.

---

## A BOUND read is only bound if the policy has THAT arm (MOTIR-2956, 2026-08-17)

The free-tier **2 GB total-storage cap silently never fired** — for any organization, on any tier
with a finite `maxTotalStorageBytes`. Not loose; **absent**. Surfaced by MOTIR-2734's PR CI
(motir-core#2098), the first full-suite run with `motir_app` as the default connection, as one
failing assertion in `tests/entitlementsService.test.ts`:

```
> accumulates org storage and blocks an upload that would exceed 2 GB on free
  AssertionError: promise resolved "undefined" instead of rejecting
```

Reproduced on `origin/main` @ `45dd9a48` with `TEST_DB_APP_ROLE=1` — byte-identical failure, so the
defect is on `main` and MOTIR-2734 only removes the flag that hides it.

### The rule this entry exists to state

**Binding a read means naming a value that some access rule on the queried tables actually consults.
Naming a different value is not a weaker form of binding. It IS NOT BINDING, and from the calling
code the two are indistinguishable** — the transaction opens, the `set_config` succeeds, the query
returns, and the answer is zero.

This is the fixture, and it is an unusually pure one because the author of the defect had already
found the hazard and written the safeguard. `entitlementsService.assertWithinStorageCap` read:

```ts
// Bound to the ORG (MOTIR-2846): `attachment`'s policy is org-scoped, so
// unbound the sum is 0 and the storage cap never fires — the one arm of §4.3b
// that silently stops enforcing.
const current = await withOrgServiceWriteContext(organizationId, (tx) =>
  attachmentRepository.sumSizeByOrganization(organizationId, tx),
);
```

The comment names the failure mode exactly. The three lines beneath it bind `app.organization_id`,
which no policy on `attachment` reads: `attachment_workspace_or_system_admin` (20260610160411) has
exactly two arms, `app.workspace_id` and `app.system_admin`. **The safeguard and the defect are the
same three lines**, and a reviewer who sees an author that understood the risk has the strongest
possible reason not to check whether the address was correct.

**The only way to tell a bound read from a bound-looking one is to open the policies for the
specific tables the query touches and confirm one of them names the GUC you are binding.** This is
the third table in this effort to lack the arm a caller assumed (`public_request_vote` — MOTIR-2864;
`github_identity` — MOTIR-2910), and all three were found by a test failing rather than by anyone
reading a policy.

### The fix — TWO arms, because a read is admitted only where EVERY table it touches is

`notes.html` #269, applied at the fix rather than at the diagnosis. `sumSizeByOrganization` is

```sql
SELECT COALESCE(SUM(a."size_bytes"), 0) AS total
  FROM "attachment" a
  JOIN "workspace" w ON w."id" = a."workspace_id"
 WHERE w."organizationId" = $1
```

so `workspace` is exactly as load-bearing as `attachment`, and it had no org arm either. An arm on
`attachment` alone would have left the sum at zero — the fix reading as applied while changing
nothing, which is the failure it replaces. `20260818010000_attachment_org_service_read_arm` adds
both, `FOR SELECT`, leaving every existing policy untouched (permissive policies OR-combine).

**Both arms require `app.user_id` to be EMPTY.** Three helpers bind `app.organization_id` and only
one is the userless service path this read runs on:

| helper                               | binds                      | arm fires                 |
| ------------------------------------ | -------------------------- | ------------------------- |
| `withOrgServiceWriteContext(orgId)`  | org only, **no user**      | yes                       |
| `withOrgContext({ userId, orgId })`  | org + the acting user      | no                        |
| `bindOrganizationContext(tx, orgId)` | org, additively, in either | per the enclosing context |

An unguarded org arm would fire under `withOrgContext` too, which is a product change rather than a
defect fix: `organizationsService.summarizeOrgFootprint` documents its own posture in source —
_"`workspaces` is what the actor can see in the org — the workspace policy admits the workspaces
they're a member of"_ — and `listMembers` enriches every member row from that same list. Both would
begin reporting workspaces the actor is not a member of. The guard uses the idiom
`workspace_public_project_read` already established for scoping an arm to one context:
`coalesce(current_setting(…), '') = ''`.

### The SWEEP — every `withOrgServiceWriteContext` / `bindOrganizationContext` caller

Read per call site as the tables its statements TOUCH, joins included, against the policies on
`origin/main` @ `45dd9a48`. **One site was broken; eleven were not**, and the eleven are recorded
here rather than left as "we looked", because an unnamed caller is indistinguishable from an unswept
one.

| call site                                                  | tables touched under the org binding                          | org arm?                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `entitlementsService.assertWithinStorageCap` :172          | `attachment` ⨝ `workspace`                                    | **✗✗ — THE DEFECT, fixed here**                                                   |
| `entitlementsService.tierForOrg` :53                       | `organization`                                                | ✓ `organization_active`                                                           |
| `billingPropagationService.setScaledTrackerState` :29      | `organization` (UPDATE + RETURNING)                           | ✓ `organization_mutate_active` / `organization_active`                            |
| `billingPropagationService.setAiIncludedSeat` :57          | `organization` (UPDATE + RETURNING)                           | ✓ same pair                                                                       |
| `ciActionsGateService` :95                                 | `organization`                                                | ✓ `organization_active`                                                           |
| `ciAllowanceService.getEntitlementState` :132              | `organization`, `organization_membership`, `ci_period_charge` | ✓ / ✓ `org_membership_visible_active_or_own` / ✓ `ci_period_charge_org_or_system` |
| `ciAllowanceService.chargePeriod` :267                     | `ci_period_charge`, `organization_membership`                 | ✓ / ✓                                                                             |
| `ciAllowanceService` :409 · :438 · :484                    | `ci_period_charge`                                            | ✓                                                                                 |
| `ciMinutesMeterService` :202                               | `organization`                                                | ✓                                                                                 |
| `ciRunnerAdmissionService.resolveCaps` :278                | `organization`                                                | ✓                                                                                 |
| `billingService.syncScaledTrackerSeatQuantity` :347 (bind) | `organization`, `organization_membership`                     | ✓ / ✓                                                                             |
| `workspacesService.addMember` :607 (bind)                  | `organization_membership` (INSERT)                            | ✓ `org_membership_insert_active_or_bootstrap`                                     |

> **⚠️ THIS TABLE IS NO LONGER WHERE THE SWEEP LIVES — `tests/rls/org-context-arm-guard.test.ts` IS
> (MOTIR-2959, 2026-08-20).** Every row above is now `ORG_SWEEP` in that guard, keyed
> line-independently as `file#enclosing`, and re-derived on every run by
> `contextArmScan`'s `ORG_SERVICE_CONTEXT` descriptor: a call site with no row fails the build, a row
> whose call site is gone fails the build, and every table named in a row is re-measured against
> `pg_policies` rather than believed. **The table below stays as the RECORD of what was read on
> 2026-08-17 and why; it is not the thing to update when a caller is added.** The paragraph directly
> under it — "a hand sweep is a snapshot; the thirteenth call site restores the class in silence" — is
> the whole reason, and it applied to this table from the day it was written.
>
> One row is carried by HAND inside the guard and says so: `workspacesService.addMember` reaches
> `organization_membership` through `organizationsService.ensureOrgMembership(…, tx)`, a SERVICE call
> the scan's walk does not follow (it follows repositories and name-resolvable helpers). That is the
> instrument's blind spot, named at the row rather than absorbed (`notes.html` #268 / #273); widening
> the walk to service objects would move the `withSystemContext` axis too and is a card of its own.

Every repository method behind those rows was read for JOINs rather than assumed from its name —
that is the half `notes.html` #269 says an arm inventory cannot answer. `organizationRepository`
(`findByIdInTx` / `findCapContext*` / `lockByIdForUpdate`), `organizationMembershipRepository.countByOrg`
and `ciPeriodChargeRepository` each address one table and join nothing; only `sumSizeByOrganization`
crosses a table boundary, and that is precisely where the defect was.

**Out of scope, and stated so it is not mistaken for swept:** `withOrgContext` is a THIRD family (it
binds `app.user_id` as well) whose readers are `organizationsService`, `billingService`,
`aiUsageService`, `acceptanceVideoEligibilityService` and `lib/ai/tenantOrg.ts`. Their reads are
member-scoped by design and admitted through `organization_membership_visible` /
`workspace_membership_visible`, which is why this card's guard deliberately leaves them alone.

> **AND THE "OUT OF SCOPE" IS NOW MEASURED RATHER THAN ASSERTED (MOTIR-2959).** `withOrgContext` is
> `ORG_USER_CONTEXT`, a declared descriptor with BOTH its GUCs, adjudicated in
> `tests/rls/other-context-arm-guard.test.ts` alongside the workspace and user families. On
> `origin/main` @ `7de5856f`:
>
> | descriptor                                             | sites | `context-only` | UNARMED (site, table) pairs |
> | ------------------------------------------------------ | ----: | -------------: | --------------------------: |
> | `SYSTEM_CONTEXT` (`withSystemContext`)                 |   166 |             27 |                           0 |
> | `ORG_SERVICE_CONTEXT` (the pair swept above)           |    31 |             30 |                           0 |
> | `WORKSPACE_CONTEXT` (service + `bindWorkspaceContext`) |   893 |            866 |                           0 |
> | `WORKSPACE_USER_CONTEXT` (`withWorkspaceContext`)      |   384 |            335 |                           0 |
> | `ORG_USER_CONTEXT` (`withOrgContext`)                  |    19 |             15 |                           0 |
> | `USER_CONTEXT` (`withUserContext`)                     |    39 |             27 |                           1 |
>
> The one pair is `publicRequestsService.toggleUpvote` reading `work_item` — a FALSE POSITIVE of an
> arm inventory keyed on a setting name, because `work_item_public_project_read` admits the row while
> reading no GUC at all. Adjudicated `guc-less-arm` in that guard, with the four test files that
> settle it.
>
> MOTIR-2959 asked for these families to sit behind a CEILING **if their verdict count is large**.
> The "if" was answered before the mechanism was chosen, and one pair is not a population to bound —
> it is a verdict to write down (`notes.html` #317: a count and a composition are two measurements,
> and only one of them had been taken).

### Blast radius, and why the timing was lucky

- **Cloud only** — `assertWithinStorageCap` returns early on `!isCloudBilling()`, so a self-hosted
  build is unaffected.
- **Dark on production only once the deployed runtime connects as `motir_app`** — which is
  MOTIR-2515, and has not landed. **This is a defect the cutover ACTIVATES**, found by the work that
  would have caused it, one step before it could bite.

### The regression net

- `tests/attachments/attachment-repository.test.ts` — four cases under `SET LOCAL ROLE motir_app`,
  so they discriminate **regardless of the suite's default connection**: the cross-workspace sum
  (44 with the arms, `+0` without), the fail-closed unbound case, and the two that pin the narrowing
  (an acting user withdraws the arm; the workspace arm is org-scoped, never global).
- `tests/entitlementsService.test.ts` — the service itself rejects with `entitlement: 'storage'`,
  including a new case whose two 1.2 GB attachments sit in **different workspaces of one org**, which
  is the reach no workspace binding could have supplied.

---

# CLOSED — `motir_app` is the suite's only connection (MOTIR-2734, 2026-08-17)

**`TEST_DB_APP_ROLE` no longer exists.** `isAppRoleTestMode()` is deleted and `currentWorkerUrl()`
returns `withAppRoleCredentials(url)` with no branch, so every vitest worker connects `@/lib/db` as the
non-bypass role. There is no longer a mode to be in — which was the point. `withAppRoleCredentials` and
`currentWorkerAdminUrl` both survive: the two-client model is what the flag was opt-in _to_, not what
was retired _with_ it.

This closes the document. Everything above it is the work that made the flip survivable.

## The count

The inventory opened at **1001 failures / 1225 tests** across four sampled directories (MOTIR-2514,
2026-08-10), and the widest single reading was **1048** under the flag. The measurements that followed
were taken on a moving tree, so they are a sequence rather than a series:

| date       | reading                              | taken on                                          |
| ---------- | ------------------------------------ | ------------------------------------------------- |
| 2026-08-10 | 1001 / 1225 (4 directories)          | MOTIR-2514's opening survey                       |
| 2026-08-12 | 2542 failed / 3979 passed            | batches 4–20 under the flag, before the app fixes |
| 2026-08-15 | 1146 / 13 390                        | MOTIR-2796's branch, under the flag               |
| 2026-08-15 | **759** failed / 13 695 passed       | `origin/main` @ `c99efdc7`, 118 red files         |
| 2026-08-17 | **0** in the flag's own blast radius | this card — see below                             |

**The final full-suite number is this PR's CI run, deliberately and not evasively.** A suite-wide count
is measured on a clean runner, merged with `main`, with the coverage gate — which is what CI is, and a
local re-run of it would be a second, worse copy taken against one developer's Postgres. What was
measured here is the diff's blast radius, which is the part a local run can answer better than CI can:

```
$ vitest run tests/rls/ tests/permissions/ <the 9 reader files>
  Test Files  38 passed | 1 failed (39)
       Tests  862 passed | 1 skipped | 1 failed (864)
```

The one failure is **not this card's and not new**: `test-singleton-statement-guard`'s `tests/e2e/**`
ceiling, which is red on `origin/main` @ `05ac5337` with a byte-identical message (verified on a clean
detached worktree). Filed as **MOTIR-2939**.

## The twelve readers, and why the number moved twice

The card enumerated **five** code readers, grepped on `origin/main` @ `9e7637cf` (2026-08-11). It ran
against **twelve**. Both re-counts are on the record as dated amendments, and the drift is the
interesting part rather than an embarrassment: this card is terminal by construction, so its own
subject matter kept being written by the siblings it was waiting for.

| readers | grepped at             | what had landed in between                             |
| ------: | ---------------------- | ------------------------------------------------------ |
|       5 | `9e7637cf`, 2026-08-11 | —                                                      |
|       9 | `c99efdc7`, 2026-08-15 | MOTIR-2755, MOTIR-2796, MOTIR-2797 — 400+ test files   |
|      12 | `b99f7e53`, 2026-08-17 | MOTIR-2871 / 2881 (tx-fallback cases), MOTIR-2888 (×2) |

## Two defects the mode split was standing in front of

Collapsing a branch is how a masked defect becomes a hard failure, and this happened twice — the same
shape `notes.html` #249 names, one level down.

1. **`app-role-bound-context-reads.test.ts`** — the arm labelled `unbound` called
   `workItemRepository.findByIds([blocker.id], tx)`, **passing `tx`**: a second copy of the bound call
   directly above it. The arm CI ran asserted rows, which a bound read of course returns; the `[]` arm
   that would have caught it ran only under the flag. The `tx` is dropped, and the site is now
   adjudicated in `ADJUDICATED_UNBOUND_FILES` — the `tx ?? db` pair asserted side by side, rows bound
   and `[]` unbound.
2. **`parentStatusRollup` / `childStatusCascade`** (arrived with MOTIR-2888) — each gated its
   FOREIGN-`workspaceId` case behind the flag, so on CI each was empty. Both now execute, and both
   pass: that pair is what pins the binding, and a system context would have crossed the tenant
   boundary silently.

## What got it here

Twenty fixture batches — **MOTIR-2735 … MOTIR-2754** — migrated the DB-backed fixtures onto `adminDb`,
directory by directory. Around them: MOTIR-2513 (the two-client harness), MOTIR-2684/2685/2796 (the
read surface), MOTIR-2797 (458 test call sites), MOTIR-2865 (the write surface), MOTIR-2861 (the raw
TRUNCATEs), MOTIR-2871/2881/2882/2887/2911 (the fixture classes five enumerations kept missing),
MOTIR-2880 (the system-context class), MOTIR-2884/2895/2919 (the trigger and boundary defects),
MOTIR-2886/2910 (the two user-context reads), and MOTIR-2862/2872 (the re-measurements that carved the
rest).

**The deployed cutover is MOTIR-2515 and is NOT done.** Production still connects as the owner; this
card changes the test suite only. Until 2515 lands, the policies are exercised on every run and enforced
nowhere that a customer can see.

## ⚠️ THE FOURTH SHORT ENUMERATION — why no fifth list is worth writing (MOTIR-2952, 2026-08-17)

MOTIR-2734's own PR CI (motir-core#2098) — the **first** run of the full suite with `motir_app` as the
default connection — reported **14 failures across 14 793 passing tests** over the three Vitest shards
(7 / 3 / 4, in 11 red files of 1031). Twelve were the same two dispositions this document has been
applying since MOTIR-2881; one was a boundary defect (below); one was a production defect filed apart
as **MOTIR-2956**, and a thirteenth turned out to be a second production defect on inspection and was
filed as **MOTIR-2960**. The number is small, and the fact that it is non-zero is the finding.

**It is the fourth time in four days, and MOTIR-2911's acceptance criteria predicted it in advance:**
_"A third recurrence of 'the list was short' is the finding, not the twelve fixes."_

| card       | claimed                | what came after                          |
| ---------- | ---------------------- | ---------------------------------------- |
| MOTIR-2871 | 41 files, 240 failures | MOTIR-2882 — 7 files its scope never saw |
| MOTIR-2881 | 12 files, 67 failures  | MOTIR-2911 — 3 more                      |
| MOTIR-2911 | 3 files, 13 failures   | **this card — 10 more files**            |

### The reason is measured, not theorised: the scanners cannot see this class by construction

Every one was invisible to `tests/rls/testCallSiteScan.ts` and `tests/rls/singletonReadScan.ts` **for a
stated reason, and the reason is the same one each time — there is nothing at the CALL SITE to match
on**:

| site                                    | how it reached the wrong connection                                             |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `project-details-service.test.ts:462`   | a repository method whose `tx` is OPTIONAL, called without one                  |
| `mcp/comment-counts.test.ts:124 / :144` | the same, on a call a spy REQUIRES to stay unbound                              |
| `epic6-at-scale.test.ts:129 / :155`     | a HELPER (`expectedCreatedVsResolved`) holding the client one level down        |
| `work-items/delete.test.ts:260`         | a local `exists()` helper, bound — to the WRONG workspace                       |
| `work-items/project-tree.test.ts:475`   | a hand-built `PrismaClient` off `DATABASE_URL`, passed in AS the `tx`           |
| `work-items/repository.test.ts:243/348` | the same hand-built client, twice more                                          |
| `plans/approvePersistGate.test.ts:394`  | a raw `UPDATE` in a bare `db.$transaction` — a WRITE that matched zero rows     |
| `cli/cli-device-routes.test.ts:253`     | `db.apiToken.count()` inside a route test, reading like ordinary assertion code |

The scanners find sites by SYNTACTIC SIGNATURE. A call that names the shared client is findable; a
call that passes no argument, that hands the client to a function defined elsewhere, or that
CONSTRUCTS its own `PrismaClient` from `DATABASE_URL`, has no signature at all. MOTIR-2918's own
closing section already says this in the form of a limitation — _"it does not follow a client passed
into a helper as a parameter"_ — and the honest reading of four short lists is that the limitation is
the dominant term, not a footnote. **No fifth enumeration will be complete, and running the scanner
more carefully cannot make it so.**

### What replaces them

**Running the whole suite as `motir_app` — which is exactly what MOTIR-2734 makes unconditional.** It
is not a better scanner; it is a different instrument, and it is exhaustive by construction: a site
that reads nothing is a red assertion, wherever the client came from and however many helpers deep it
sits. That is how all fourteen were found — not by a sweep, but by the first CI run of the flipped
suite.

So the sequencing to hold onto: **the enumeration problem is solved by the card that was blocked on
the enumeration.** The scanners keep their job — they are RATCHETS, and their ceilings may only ever
fall — but the ENUMERATOR is CI, from MOTIR-2734's merge onward. A future short list is no longer
evidence that the class is nearly closed; the suite's own green is.

### ⚠️ An ADJUDICATION is not an ASSERTION fix — the sub-finding, and the full re-read

`tests/project-details-service.test.ts` and `tests/mcp/comment-counts.test.ts` were **already in
`ADJUDICATED_UNBOUND_FILES`**, and both entries were correct: each file's subject genuinely IS the
unbound arm (the `?? db` branch; a query COUNT a bound read would move off the spied client). The
ruling tells the SCANNER to stop flagging the call. It says nothing about the ASSERTION, which went on
expecting rows the unbound read can no longer return — so a file can be correctly adjudicated and
still red, and in the guard's output the two are indistinguishable.

**All nine entries were re-read. The result, per entry:**

| entry                                          | verdict                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `comments/repositories.test.ts`                | clean — the file has **no `db.` at all**; every read is `adminDb`                                                                 |
| `custom-fields/repositories.test.ts`           | clean, same (29 `adminDb` sites, 0 `db.`)                                                                                         |
| `labels-components-watch/repositories.test.ts` | clean, same                                                                                                                       |
| `notifications/repositories.test.ts`           | clean, same                                                                                                                       |
| `integration/sprints/repository.test.ts`       | clean, same                                                                                                                       |
| `rls/tx-fallback-arm.test.ts`                  | correct BY CONSTRUCTION — the empty answer is its subject, seeded through `adminDb` so emptiness is evidence                      |
| `app-role-bound-context-reads.test.ts`         | correct — asserts the `tx ?? db` PAIR side by side, rows bound and `[]` unbound                                                   |
| **`project-details-service.test.ts`**          | **RED — fixed here**: the read stays unbound, the expectation becomes `[]`                                                        |
| **`mcp/comment-counts.test.ts`**               | **RED — fixed here**: the spied call keeps its unbound arm and asserts `[]`; each answer-shaped claim moved to its own BOUND read |

Two of nine, and the five `adminDb`-only files are clean for a structural reason rather than a lucky
one. **The residue this re-read cannot reach is the MIRROR shape** — an assertion expecting `[]` or
`0` that an unbound read satisfies for the wrong reason. Running the suite cannot surface those (they
are green), and three were found by hand in `cli/cli-device-routes.test.ts`: `toBe(0)` counts on
`api_token`, passing whether or not the route minted a credential. They moved to `adminDb` with the
one that was actually red.

### Two of the fourteen were not a fixture class at all, and they went opposite ways

Both arrived looking identical — a test asserting something the app did not do — and only reading the
`lib/` path told them apart. That reading is the step, not an optional flourish:

- **`boardsService.moveCard`** answered `BoardNotFoundError` as the owner and `WorkItemNotFoundError`
  as `motir_app`, because it locked the card before it resolved the board. A **mode-split in the shape
  MOTIR-2919 outlawed hours earlier** — _"the connection mode must never change which error a boundary
  owes"_ — so it was decided rather than matched. Verdict, rejected alternative and the generalisation
  are recorded beside 2919's own in `docs/decisions/public-api-conventions.md` §4.
- **`planChangeSessionsService.recordPlannerTurn`** calls `normalizeBodyRefs` with **no `tx`** — the
  only one of its five call sites that does not — so under `motir_app` the work-item keys in a planner
  turn resolve to nothing and stay plain text, silently. That is application code, not a test to
  convert, and it is filed as **MOTIR-2960**. Its test file is the one member of this card's ten left
  red on purpose.
- And the near-miss in the other direction: `plans/approvePersistGate.test.ts:394` read exactly like a
  gate failing to block, and was a TEST-side unbound WRITE — the concurrent transition it stages ran a
  raw `UPDATE` in a bare `db.$transaction`, matched zero rows, raised nothing, and left the approve
  with no race to lose. The gate was fine. **A test that fails because its own precondition silently
  did not happen is indistinguishable, from the assertion alone, from the code being broken.**
