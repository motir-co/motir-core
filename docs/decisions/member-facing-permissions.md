# ADR: The eight member-facing permissions — which built-in role holds each, and what a workspace member keeps

- **Status:** Accepted (2026-08-07)
- **Story / Subtask:** MOTIR-2291 (Close the ungoverned-operation gap) · Subtask MOTIR-2347
- **Extends:** MOTIR-2255's permission MODEL (`lib/permissions/catalog.ts`,
  `lib/permissions/builtinRoles.ts`, `lib/permissions/resolve.ts` — a role is a
  permission SET) and MOTIR-2256's administrative split
  (`assertPermission(projectId, ctx, key)` as THE gate). Decides over the rows in
  `docs/decisions/permission-inventory.md`.
- **Supersedes / superseded by:** none
- **Consumed by:** MOTIR-2349 (the eight keys enter the built-in role sets + the
  64-row parity table), MOTIR-2350 (`sprint:manage`), MOTIR-2351 (`report:view`),
  MOTIR-2352 (`saved_filter:manage`), MOTIR-2353 (`import:run`), MOTIR-2354
  (`work_item:triage` + `work_item:delete`), MOTIR-2355 / MOTIR-2357 /
  MOTIR-2358 / MOTIR-2359 (`ai:plan`, in four parts), MOTIR-2362 (the
  coding-convention four), MOTIR-2363 (`ai:view_plan`), MOTIR-2356 (the model
  fully enforced), MOTIR-2367 / MOTIR-2368 (the story's test gates); AMENDMENT 1:
  MOTIR-6328 – MOTIR-6337 (Story MOTIR-6179, the rooms' view-any keys); AMENDMENT 2:
  MOTIR-6459 (Story MOTIR-6168, roles move to the workspace).

> Structured **Context → Decision → Consequences → References**, the convention
> the repo's ADRs set. No application behaviour ships in this subtask. What it
> freezes is the answer sixteen wiring cards would otherwise each invent.

---

## Context

`lib/permissions/catalog.ts` carries eight keys whose `enforcement` is
**`planned`** — `ai:plan`, `ai:view_plan`, `sprint:manage`, `report:view`,
`saved_filter:manage`, `import:run`, `work_item:triage`, `work_item:delete`.
Read on `origin/main`, `PERMISSION_META` marks each of the eight `planned`, and
`ROLE_GATED_PERMISSIONS` in `lib/permissions/builtinRoles.ts` holds none of them,
so today **no built-in role holds any of the eight** and no gate consults them.

The operations they are meant to govern are not idle in the meantime. Per
`docs/decisions/permission-inventory.md`, the shipped gate on most of them is
`session only` or `workspace only`: a signed-in workspace member — a project
`viewer` included — can re-rank the backlog, start and complete a sprint, run a
planning job that spends the workspace's AI credits, read a burndown, and drive
an external-tracker importer.

That is what makes this story categorically different from MOTIR-2256. The
administrative split could promise that no built-in role's capabilities changed,
because `project:administer` already stood in front of every operation it moved.
**Nothing here can make that promise.** Every one of the eight decisions below
withdraws a capability from somebody who has it today. So the question is not
_where does the gate go_ — the inventory answered that, operation by operation —
but _who is on the other side of it_, and it is answered ONCE, here, rather than
sixteen times by whoever happened to be looking at a given route.

### The model the decision is expressed in

Three files, read on `origin/main`:

- **`lib/permissions/builtinRoles.ts`** — `BUILTIN_ROLE_PERMISSIONS` gives each
  built-in role its MAXIMAL set (`admin` = the whole of
  `ROLE_GATED_PERMISSIONS`; `member` = `project:browse`, `work_item:edit`,
  `comment:add`, `attachment:create`; `viewer` = `project:browse` alone), and
  `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS` gives the same four keys as `member`
  to a workspace member holding NO project membership.
- **`lib/permissions/resolve.ts`** — `resolvePermissions` applies three layers in
  order: the level-gated `public` grants, the workspace-manager always-pass rail,
  the null-deny rail for a non-workspace-member; and between the rails, the
  project role's base set MINUS whatever `levelGrants` subtracts for the access
  level. `levelGrants` names exactly three keys — `work_item:edit`,
  `comment:add`, `attachment:create` — and every other key takes its level's
  default arm.
- **`lib/services/projectAccessService.ts`** — `assertPermission` is the
  enforcement point, with the refusal ORDER that matters: a non-browser is
  `ProjectNotFoundError` (404) BEFORE the key is tested, so a surface an actor
  cannot browse looks missing rather than forbidden.

Two consequences of that shape frame every row below. First, **a key's answer is
a membership in a role SET, not a per-route condition** — so the eight answers
have to agree with each other, which is only checkable when they are written
together. Second, **the workspace-manager rail is above all of this**: a
workspace owner or admin holds the entire role-gated catalog on every access
level, so nothing decided here can lock a workspace owner out of their own
project.

---

## Decision

### 1 · The eight keys, and the role set each enters

`admin` holds all eight — it holds the whole of `ROLE_GATED_PERMISSIONS` by
construction, so the only real question per key is whether it also enters
`member` and `viewer`.

| Key                   | admin | member | viewer | Rung-1 evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | :---: | :----: | :----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sprint:manage`       |  ✅   |   ✅   |   ❌   | Plane grants cycle creation and management to Admin and Member and withholds it from Guest ([member roles](https://docs.plane.so/roles-and-permissions/member-roles), [permissions matrix](https://docs.plane.so/roles-and-permissions/permissions-matrix)). Jira company-managed makes _Manage Sprints_ its own permission, typically held by the Scrum Master ([sprint permissions](https://confluence.atlassian.com/spaces/ADMINJIRASERVER/pages/983794894/Sprint+permissions+and+defined+processes)) |
| `report:view`         |  ✅   |   ✅   |   ✅   | Jira has NO separate report permission — _Browse Projects_ is what governs reports and other aggregated reads ([company-managed permissions](https://confluence.atlassian.com/servicedeskcloud/permissions-for-company-managed-projects-1097175962.html)). Plane's analytics follow project visibility                                                                                                                                                                                                   |
| `saved_filter:manage` |  ✅   |   ✅   |   ❌   | A saved filter is authored content with a star and a subscription — creating one is a WRITE. Jira treats filter creation as a logged-in-user capability and governs SHARING separately                                                                                                                                                                                                                                                                                                                   |
| `import:run`          |  ✅   |   ❌   |   ❌   | Plane: only workspace admins may perform imports, to maintain governance ([Jira importer](https://docs.plane.so/importers/jira)). Linear: you must be a Linear Admin to run an import ([import issues](https://linear.app/docs/import-issues))                                                                                                                                                                                                                                                           |
| `work_item:delete`    |  ✅   |   ❌   |   ❌   | Jira's default permission scheme grants _Delete Issues_ to the Administrators project role ([company-managed permissions](https://confluence.atlassian.com/servicedeskcloud/permissions-for-company-managed-projects-1097175962.html))                                                                                                                                                                                                                                                                   |
| `work_item:triage`    |  ✅   |   ✅   |   ❌   | Plane: Admin and Member accept / decline / snooze an intake item; Guest may only SUBMIT ([permissions matrix](https://docs.plane.so/roles-and-permissions/permissions-matrix))                                                                                                                                                                                                                                                                                                                           |
| `ai:plan`             |  ✅   |   ✅   |   ❌   | Motir's own `ai:configure` (MOTIR-2300) already put AI SETTINGS behind admin; the mirrors put AI configuration at admin and AI USAGE at member. A planning job spends the workspace's credits — it is a write with a bill                                                                                                                                                                                                                                                                                |
| `ai:view_plan`        |  ✅   |   ✅   |   ❌   | Approving a generated plan MATERIALIZES work items — a create, not a read. Motir already gates the review surface's writes with `assertCanEdit` (`/api/plans/[id]/decline`, per the inventory)                                                                                                                                                                                                                                                                                                           |

**The revocation list — who can no longer do what, on the day this lands.** Read
this without opening another file:

| Key                   | The actor who loses it                                                         | What they can no longer do                                                                           | What they keep                                        |
| --------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `sprint:manage`       | a project **viewer**; a **workspace member with no project membership**        | start / complete a sprint, move an item into or out of one, re-rank the backlog                      | reading every sprint and the backlog order            |
| `report:view`         | **nobody who can browse the project**                                          | —                                                                                                    | everything (a non-browser already could not reach it) |
| `saved_filter:manage` | a project **viewer**; a **workspace member with no project membership**        | author, rename, delete, star or subscribe to a project saved filter                                  | running one and reading its results                   |
| `import:run`          | a project **member** and **viewer**; a **workspace member with no membership** | start an import, discover, preview or run it                                                         | seeing what a completed import produced               |
| `work_item:delete`    | a project **member** and **viewer**; a **workspace member with no membership** | archive or delete a work item and its subtree                                                        | editing every field of every work item (`member`)     |
| `work_item:triage`    | a project **viewer**; a **workspace member with no project membership**        | accept, decline or promote an inbound request                                                        | reading the triage queue                              |
| `ai:plan`             | a project **viewer**; a **workspace member with no project membership**        | run a planning job — chat, expand, augment, replan, generate, sprint-plan, explanation, the pre-plan | reading the plan a job produced                       |
| `ai:view_plan`        | a project **viewer**; a **workspace member with no project membership**        | approve, decline or edit a proposal on a generated plan                                              | reading a generated plan (via `project:browse`)       |

> ⚠️ **AMENDED by MOTIR-3629 (2026-08-26) — `work_item:delete`'s row was TWO
> operations, and only one of them belonged at admin.** Both tables above say
> _"archive or delete a work item and its subtree"_, which is one cell describing
> a reversible single-row hide and an irreversible subtree destroy at the same
> time. The Jira evidence quoted in the assignment table is about _Delete
> Issues_ and is unchanged; it was never evidence about archiving, and Jira has no
> archive permission for it to be evidence about.
>
> `work_item:archive` splits out (`docs/decisions/token-permissions.md` §10) and
> the assignment is **admin ✅ · member ✅ · viewer ❌**. Rung-1 evidence: Linear,
> whose archive semantics this operation already copies — `archiveWorkItem`'s own
> header cites _"the Linear shape"_ for leaving children intact — and where
> archiving is every member's ordinary remove while deleting is not. `viewer` is
> unchanged: a read-only actor removes nothing.
>
> So the revocation row now reads: a project **member** loses only the subtree
> DELETE, and keeps archiving; a project **viewer** and a **workspace member with
> no project membership** still lose both. The last of those is the one place
> archive parts from `member` — §2's argument decides it, because taking a row out
> of every active view for the whole team is an act of ownership on a project
> nobody put you on, reversible or not.
>
> Nothing here is a migration: `work_item:delete` confers `work_item:archive` at
> resolution, so every actor who could archive under the old row still can.

Two rows deserve their reasoning spelled out because the answer could plausibly
have gone the other way:

- **`report:view` at `viewer`, i.e. everywhere `project:browse` reaches.** The
  honest reading of the mirror is that a report permission separate from browse
  does not exist in Jira at all, and this project's own inventory already routes
  the reports through project-scoped reads. Giving the key to all three roles is
  therefore not a shrug — it is the decision that the key exists to make the
  operation NAMEABLE (a custom role in MOTIR-2257 may withhold it) without
  changing who may read a chart today. It is the one key in this table that takes
  nothing away from anybody.
- **`import:run` at `admin` only, which is the largest single revocation in the
  story.** Both mirrors put imports at admin, and the operation is a
  destructive-scale bulk write that creates work items in someone else's project.
  A `member` losing it is the intended outcome, not collateral: the recovery path
  is a project admin running the import, or MOTIR-2257's custom roles granting
  the key to a narrower set than "all members".

### 2 · The implicit workspace member gains `report:view`, and nothing else

`IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS` — what a workspace member holds on a
project they hold no membership in — is `project:browse`, `work_item:edit`,
`comment:add`, `attachment:create` on `origin/main`. **It gains `report:view` and
none of the other seven.**

The principle: a stranger to the project may read its charts because they may
already read its work items — a burndown is an aggregation of data they can
already see one row at a time, and withholding it would be a distinction without
a difference. But they may not **spend the workspace's AI credits**, **run an
importer**, **restructure a sprint**, **author a shared saved filter**,
**accept a triage submission**, or **delete a subtree** on a project nobody put
them on. Those are acts of ownership, and a workspace membership is not one.

This is the sub-question no single route can answer. "Does a workspace member
with no project membership keep the planner?" is not a fact about
`/api/ai/chat`; it is a fact about what a workspace membership MEANS, and it is
only decidable by looking at the whole set at once.

Note what it does NOT change: the access level still applies on top. On a
`private` project the implicit set resolves to nothing at all (the actor holds no
project membership, so `levelGrants` denies every key), which is why the
`report:view` row above says "a non-member on a `private` project already cannot
browse".

### 3 · `levelGrants` gains NO new branch

`lib/permissions/resolve.ts` names exactly three keys in `levelGrants` —
`work_item:edit`, `comment:add`, `attachment:create` — and its own comment
records that leaving the table alone is what made MOTIR-2256's split provably
behaviour-neutral over all 64 actors. **The decision is to add no branch for any
of the eight.**

Each of the eight then behaves per access level exactly as `project:administer`
already does:

| Access level | What the default arm does to one of the eight                                       |
| ------------ | ----------------------------------------------------------------------------------- |
| `open`       | kept — the role's base set survives intact                                          |
| `public`     | kept — same arm as `open` (a public project ADDS external read, it strips nothing)  |
| `limited`    | kept — the `work_item:edit` test does not match any of the eight                    |
| `private`    | gated on holding a project membership at all; a `viewer`'s base set is browse alone |

The reason to hold the line here is that it keeps the whole capability question
in ONE readable place. With no `levelGrants` branch, "what does Member mean?" is
answered by reading one set in `builtinRoles.ts`. Add a per-level rule for
`import:run` and the answer becomes a join across two files and four levels — and
worse, it becomes a second policy axis that MOTIR-2257's custom roles would have
to reproduce. A key that genuinely needs a per-level rule is a policy change and
belongs in a card that argues for it; none of the eight does.

### 4 · The one LOOSENING in the story: the coding-convention four

`/api/ai/coding-convention/{audit,audit-coverage,convention,refresh}` are gated
**today** by `assertCanManage` — i.e. `project:administer`, admin-only — reached
through `aiConventionService.getAudit` / `getConvention` / `reaudit` and
`auditCoverageService.getCoverage`, as the `Gate today` column of the inventory
records. The inventory maps all four to `ai:plan`, which §1 puts at `member`.
Wiring them naively would therefore **widen** who may spend AI credits, in a
story where every other row narrows.

**The decision: the four operations stay ADMIN-ONLY. The inventory mapping is
what is corrected, not the gate.**

The reasoning, in the order it settles:

1. Read what the four operations do. They read and RE-RUN the project's
   coding-convention audit — a project-wide configuration artifact that the
   planner then consumes. That is the same class of thing as the AI SETTINGS
   `ai:configure` (MOTIR-2300) already puts behind admin, not the same class as
   "submit a planning job for this work item".
2. `ai:plan` in §1 is justified by "a planning job spends the workspace's credits
   and proposes plan changes", and it is put at `member` on the strength of the
   mirrors placing AI **usage** at member. A convention re-audit is AI
   **configuration** wearing a usage-shaped URL.
3. A story whose stated purpose is to close holes should not, in passing, open
   one. If the widening were genuinely wanted, it deserves its own card and its
   own argument — not a line in a diff nobody reads.

So MOTIR-2362 re-points these four rows at **`ai:configure`** and leaves the
enforcement exactly where it stands (`assertCanManage` is `assertPermission(…,
'project:administer')`, and `admin` holds `ai:configure`, so no actor's answer
changes). Nobody gains or loses a capability from this row — which is precisely
the outcome a loosening buried inside a tightening would have prevented.

---

## Consequences

- **MOTIR-2349** adds the eight keys to `ROLE_GATED_PERMISSIONS`, adds the six
  that `member` holds and the one that `viewer` holds to
  `BUILTIN_ROLE_PERMISSIONS`, and adds `report:view` to
  `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS`. Its 64-row parity table records what
  each key takes away — and unlike MOTIR-2256's, it will NOT be an equivalence
  proof, because these keys are deliberately not equivalent to
  `project:administer`.
- **Every wiring card cites this record rather than re-deciding.** A wiring card
  that finds itself arguing about who should hold its key has found a gap in this
  document, and the fix is to amend this document.
- **`enforcement` flips from `planned` to `enforced` per key as its wiring card
  lands**, which is what lets the key appear in the Roles & permissions grid and
  the custom-role editor. A `planned` key is never offered.
- **MOTIR-2257's custom roles are the pressure valve.** Every row above is a
  DEFAULT. The narrowing a Jira user gets from a separate _Manage Sprints_
  permission, and the widening a team needs when a trusted contributor should run
  imports, are both expressible as a custom role over exactly these keys.
- **The refusal a user sees is a 403 the shipped client already renders**, except
  on a project they cannot browse, where the ordering rule makes it a 404. No UI
  work is implied here; what a permission-less actor SEES is MOTIR-2258's.

---

## AMENDMENT 1 (2026-09-25) — the three rooms' VIEW-ANY keys (MOTIR-6328, Story MOTIR-6179)

**Source:** the DECISION card MOTIR-6165, Q2, confirmed by the owner on 2026-09-24: _the Viewer
and Member roles hold every VIEW-ANY key by default, so Plans, Approvals and Runs are open to anyone
in the workspace; a team that wants a room closed creates a custom role without that room's key._

This record is the source `builtinRoles.ts` names, so the assignment is written here before it is
typed there:

| key                       | `admin`       | `member`  | `viewer`  | implicit workspace member | `PUBLIC_PROJECT_PERMISSIONS` |
| ------------------------- | ------------- | --------- | --------- | ------------------------- | ---------------------------- |
| `approval:view_any`       | ✓ (unchanged) | ✓ **new** | ✓ **new** | —                         | —                            |
| `plan:view_any` (new key) | ✓             | ✓         | ✓         | ✓                         | ✓                            |
| `run:view_any` (new key)  | ✓             | ✓         | ✓         | ✓                         | ✓                            |

- **`approval:view_any` WIDENS `member` and `viewer`.** Before, both saw only the approval records
  routed to them or decided by them — which, for a read-only viewer, was an empty room by
  construction. The owner chose the widening; §2's rule that a workspace stranger takes no act of
  ownership is untouched, because SEEING the trail is not acting on it. The implicit workspace
  member and the public non-member do NOT gain it: neither has ever held it, and widening a
  stranger's view of the approval trail is the workspace roles story's (MOTIR-6168) to decide.
- **`plan:view_any` and `run:view_any` are behaviour-neutral for every built-in actor.** Every
  actor listed above opens `/plans` and `/runs` on `project:browse` today, so holding the room's
  key is what keeps that reach once the reads assert it (MOTIR-6330 / MOTIR-6331). `levelGrants`
  does not name them, so each resolves exactly like `project:browse` on all four access levels and
  both rails (`tests/permissions/accessParity.test.ts`).
- **`ai:view_plan` is NOT renamed and NOT repurposed.** It keeps the AUTHOR meaning MOTIR-3188
  gave it; `plan:view_any` is a new, separate VIEW key. So a viewer holding every plan to READ
  holds nothing to WRITE — no `ai:plan`, `ai:view_plan`, `ai:decide_plan`, `approval:decide_any` or
  `work_item:edit`.
- **Persisted grants** — custom roles and API tokens stored before this amendment — are carried
  forward by MOTIR-6329, so nobody loses a room they have today.

## AMENDMENT 2 (2026-09-26) — the roles are WORKSPACE roles, and the implicit set retires (MOTIR-6459, Story MOTIR-6168)

**Source:** the DECISION `docs/decisions/role-model.md` (MOTIR-6165, approved 2026-09-25 with no
note), §2–§3 and its _What this amends elsewhere_, which names this record: _`admin` / `member` /
`viewer` stop being PROJECT role grants and become the Manager, Member and Viewer WORKSPACE roles._
This amendment records what that does to the assignment above. Every §1 row and every AMENDMENT 1
row stands as a statement about a SET; what changes is who holds the set, and one set disappears.

- **The three sets carry over unchanged, as workspace roles.** `admin` → **Manager**, `member` →
  **Member**, `viewer` → **Viewer** (`WORKSPACE_ROLE_PERMISSIONS`, `lib/permissions/builtinRoles.ts`).
  Every key §1 and AMENDMENT 1 put in a role set is in the same-named workspace role. A person's
  workspace role is their role in EVERY project of the workspace; no project role and no project
  custom role enters the resolution (`lib/permissions/resolve.ts`). A custom role is authored at the
  workspace, from a Manager, Member or Viewer base (`role-model.md` Q2).
- **§2's implicit workspace-member set RETIRES.** `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS` is
  deleted: there is no longer a "workspace member with no role", because every member holds a
  workspace role. §2's principle — that a stranger to a project takes no act of ownership there — is
  REPLACED by the model's own rule, _"a person has the same role in every project they can enter"_.
- **What a person who was never ADDED to a project gains there: their role's normal keys.** A Member
  never added to an `open` project used to hold the implicit set (browse, edit, comment, attach,
  `report:view`, `plan:view_any`, `run:view_any`); they now hold the whole Member set — the planner,
  sprints, saved filters, triage, archive, and `approval:view_any` among it. That is the ONE widening
  the model decides, and the role migration's never-wider check (MOTIR-6461) allows exactly it.
- **What they lose: a Viewer's old implicit EDIT.** A workspace `viewer` with no project membership
  used to fall to the implicit set too, which held `work_item:edit`, `comment:add` and
  `attachment:create`. A Viewer now holds the Viewer set in every project, and none of those three.
- **The access LEVEL still subtracts, keyed on whether the person was ADDED — never on a role.**
  `limited` withholds `work_item:edit` from someone not added; `private` withholds everything from
  someone not added and nothing from someone who was. `private`'s old edit / comment / attachment
  split by PROJECT role retires with project roles — the one place a level changed meaning, and a
  no-op for every built-in (a Viewer holds none of the three anyway). The project access story
  (MOTIR-6169) replaces the levels with the access modes.
- **§3 stands.** `levelGrants` still names one key only (now `work_item:edit`), and every key this
  record assigns resolves like `project:browse` on every level.

The truth table that proves the new shape is `tests/permissions/accessParity.test.ts`, rewritten by
MOTIR-6459: 4 levels × { no membership, Manager, Member, Viewer, a custom role } × { added, not
added }, each row's set written out.

---

## AMENDMENT 3 (2026-10-07) — §4: reading the convention and audit summary FOR PLANNING is `ai:plan` (MOTIR-7793, Story MOTIR-7782)

**Source:** Subtask MOTIR-7793, which adds the `get_code_health` MCP tool — each repository's index
state, latest audit health summary and current derived coding convention, for an agent planning over
the MCP.

§4 kept the coding-convention operations admin-only by re-pointing them at `ai:configure`. That
stands, unchanged, for every operation it named: the `/code-health` page's reads
(`aiConventionService.getAudit` / `getConvention`, `auditCoverageService.getCoverage`) and every
re-audit and refresh (`aiConventionService.reaudit`). What this amendment adds is ONE further read,
on a different key, and the reason the difference is not an oversight:

- **Reading a repository's derived convention and its latest audit SUMMARY for planning is gated on
  `ai:plan`** (`aiConventionService.getPlanningCodeHealth`; `TOOL_PERMISSIONS.get_code_health`).
- **The content is already shown to exactly that set of actors.** The hosted planner composes both
  into every planning session it runs (motir-ai `src/llm/retrievalTools.ts` `code_health` →
  `conventionTools.ts`), and that job is submitted under `ai:plan`. A member who can plan already
  reads this through their own plan; the tool gives an agent planning over the MCP the same evidence,
  and widens nobody's reach.
- **It is narrower than the page, not a second door to it.** No findings page and no convention
  version history cross it, and it re-runs nothing — §4's argument was about an operation that
  RE-RUNS an audit and spends credits, which this read cannot do.
- **Why not `project:browse` with `ai:configure` checked inside.** A token's grant is checked at the
  door, and the service's role check reads the token's OWNER, so a browse-only token minted by an
  admin would then read what the browser reserves for `ai:configure` — the narrowing the token was
  issued for would not apply (`token-permissions.md` §3: one key per tool, the key its own service
  asserts).
- **Why not `ai:configure` at the door.** That key is ungrantable to any token today — no tool and no
  `/api/v1` operation asserts it — and this tool would make it grantable, refusing every planning
  token already minted until an admin re-minted it. It would also gate a planning read on a
  configuration key.

So the door and the service ask the same question, `ai:plan`, which is already grantable and already
in `CLI_TOKEN_GRANT`: no grant widens, and `ai:configure` stays in `UNGRANTABLE_PERMISSIONS`.

**A second instance (MOTIR-7861, Story MOTIR-7858):** the `read_file` MCP tool — one repository
file's text at a ref (`repoFileReadService.readProjectFile`; `TOOL_PERMISSIONS.read_file`) — is
gated on `ai:plan` at the door and in the service on the same argument: the hosted planner's own
`read_file` already shows that text to every `ai:plan` holder, so nobody's reach widens.

**A third (MOTIR-7862, 2026-10-08):** the `code_explore` / `code_search` MCP tools — the hosted code
graph, read through motir-ai's `POST /v1/code-graph/read` (`codeGraphReadService.read`) — are gated
on `ai:plan` for the same reason: the hosted planner's own graph tools already show those answers
to every `ai:plan` holder.

**A fourth (MOTIR-10066, 2026-10-29):** the `code_grep` MCP tool — a search of the indexed file
contents, through the same `POST /v1/code-graph/read` — is gated on `ai:plan` for the same reason:
the hosted planner's own `code_grep` already shows those lines to every `ai:plan` holder, and
`read_file` already shows them the whole file.

## AMENDMENT 4 (2026-10-21) — §4: the `/code` READS are `ai:plan`; the writes stay `ai:configure` (MOTIR-9173)

§4 re-pointed all four coding-convention operations at `ai:configure`. That is right for the two that
WRITE and wrong for the two that READ, and the cost was a crash rather than a boundary: for any key but
`project:administer`, `assertPermission` throws `PermissionDeniedError`, which `/code` did not catch, so
every non-admin member of a project with a connected repository got an error page instead of the room.

The owner decided that members see the whole `/code` page read-only, Health included. So:

- **`aiConventionService.getAudit` and `getConvention` assert `ai:plan`**, the key
  `getPlanningCodeHealth` (the `get_code_health` tool) already uses for the same data — nobody's reach
  widens past what an MCP reader already had.
- **`saveConvention` and `reaudit` stay `ai:configure`.** The page resolves `canConfigure` on the server
  and hides the editor and every re-audit control from a reader without it; the routes refuse them
  regardless.
- **A role with `project:browse` but without `ai:plan`** (the built-in `viewer`) gets Health's admin-only
  empty state: the page catches `PermissionDeniedError` beside `NotProjectAdminError`.

## References

- `lib/permissions/catalog.ts` — `PERMISSIONS`, and the `planned` /
  `enforced` `enforcement` flag per key.
- `lib/permissions/builtinRoles.ts` — `ROLE_GATED_PERMISSIONS`,
  `BUILTIN_ROLE_PERMISSIONS`, `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS`,
  `PUBLIC_PROJECT_PERMISSIONS`.
- `lib/permissions/resolve.ts` — `resolvePermissions` and the `levelGrants`
  table this decision chooses not to touch.
- `lib/services/projectAccessService.ts` — `assertPermission` and the 404-before-403
  refusal order.
- `docs/decisions/permission-inventory.md` — the operation-to-key mapping this
  decides over, including the four coding-convention rows §4 re-points.
- `docs/decisions/public-projects.md` — the level-gated grants a role can neither
  hold nor withhold.
- `tests/permissions/accessParity.test.ts` — the 64-row truth table MOTIR-2349
  extends.
- Mirrors: [Plane member roles](https://docs.plane.so/roles-and-permissions/member-roles) ·
  [Plane permissions matrix](https://docs.plane.so/roles-and-permissions/permissions-matrix) ·
  [Plane's Jira importer](https://docs.plane.so/importers/jira) ·
  [Linear's importer](https://linear.app/docs/import-issues) ·
  [Jira company-managed permissions](https://confluence.atlassian.com/servicedeskcloud/permissions-for-company-managed-projects-1097175962.html) ·
  [Jira sprint permissions](https://confluence.atlassian.com/spaces/ADMINJIRASERVER/pages/983794894/Sprint+permissions+and+defined+processes)
