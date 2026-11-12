# A token GRANTS permission keys — the six 7.7-era scopes are retired

**Status:** accepted · **Story MOTIR-2572 · Subtask MOTIR-2573** · **Decided 2026-08-10**

## Context

The Create-token modal shows a section headed **Permissions**
(`messages/en.json` → `settings.apiTokens.scopes.permissionsLabel`) and puts six
switches under it. The six are the `TokenScope` values from Story 7.7 —
`read` · `work_items:write` · `work_items:archive` · `work_items:delete` ·
`sprints:write` · `integration` — authored in `lib/mcp/scopes.ts` when the MCP
server was the only thing a token could reach.

Two things changed since.

1. **[MOTIR-2254](https://app.motir.co) shipped a real permission catalog.**
   `lib/permissions/catalog.ts` carries **31 keys across 16 domains** in
   `resource:action` form, each with a shipped `permissions.<slug>.label` /
   `.description` and a gate that consults it. `PLANNED_PERMISSIONS` is **empty**
   — every key is `enforced`.
2. **A token stopped being an MCP credential.** It now authenticates **39 MCP
   tools**, **40 `/api/v1` operations**, and the acceptance-video publish. Forty
   REST operations were filed into six boxes built for a different surface, and
   the filing was lossy in one direction only: where no scope was narrow enough,
   the operation went into a wider one.

So the screen says _Permissions_, the product has permissions, and the switches
are something else.

### Rung-1 evidence (checked 2026-08-10, not recalled)

- **GitHub fine-grained PATs** select capability per resource and state that
  _"a token cannot grant additional access capabilities to a user"_ — the
  intersect-with-the-owner rule this decision keeps.
  <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>
- **Atlassian** — the mirror product — has already made this move: unscoped
  classic API tokens are replaced by tokens whose granular
  `read:jira-work` / `write:jira-work` scopes are chosen at create time, with
  pre-2024-12-15 tokens expiring by May 2026.
  <https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/>

Both mirrors select capability in the same `resource:action` vocabulary their
product enforces, per resource, capped by the owner.

---

## ⚠️ This SUPERSEDES two recorded statements that say the opposite

Both were correct when written. Neither is correct now. A reversal recorded only
as a deletion is indistinguishable from someone not having read the sentence, so
the sentences are quoted here and the two file headers are amended to point at
this document in the same PR.

**`lib/mcp/scopes.ts` (Story 7.7, 2026-06) currently says:**

> "scopes", NOT "permissions" — the durable industry convention for API-token
> capabilities … Motir already uses "permissions" for the project access model …
> so reusing that word here would collide. The two axes COMPOSE and never merge:
> a permission says what the token's owner may do, a scope narrows what this
> particular token may do on their behalf.

**`lib/permissions/catalog.ts` (MOTIR-2260, 2026-08) currently says:**

> ⚠️ "PERMISSION", NOT "SCOPE". `lib/mcp/scopes.ts` deliberately records that an
> API-token SCOPE is a separate axis … The two vocabularies stay distinct;
> nothing here is a scope and nothing there is a permission.

**Why they are superseded.** Both rest on a premise that expired: that the
catalog is a _project access_ model too narrow to describe what a token reaches.
When 7.7 was written the catalog was eleven predicates over one project surface;
it is now 31 enforced keys covering the operations a token actually calls. The
sentences separated two vocabularies because one of them could not express the
other's subject matter. It can now. What survives of the original reasoning is
the part that was never about naming — **the two axes still compose and are
still intersected at dispatch** (§4). What is retired is the claim that they
must use _different words for the same idea_.

**The reversal is Yue's explicit call (2026-08-10).** No card may cite the two
superseded statements after this document lands.

---

## Decision

### 1. A grant is a SET of `PermissionKey`s — not a per-domain access LEVEL

A token's grant is `readonly PermissionKey[]`. It is **not** a per-resource
`read`/`write`/`admin` selector.

GitHub can offer levels because its permissions are uniform CRUD over
repositories. Motir's catalog is **not uniform**: `work_item:triage`,
`saved_filter:manage`, `ai:plan` and `ai:view_plan` are not read/write pairs of
anything, and `project:administer` is not the "admin level" of `project:browse`.
A level selector would have to invent an ordering the catalog does not carry,
and the first key that did not fit the ordering would be filed under the wrong
rung — the same lossy filing this story exists to undo.

A key set also composes trivially with the existing `∩ role` rule and needs no
new persisted shape: `api_token.scopes` is `String[]`, and permission keys are
strings.

**Rejected:** per-domain levels (above); a role-per-token (a token would then
carry authority its owner does not have, breaking §4); free-text scopes (the
catalog's opening rule forbids a capability with no operation behind it).

### 2. GRANTABLE = the keys some TOKEN-REACHABLE operation asserts

Not all 31. A permission is grantable **because an operation a token can call
asserts it** — reachable through `/api/mcp`, `/api/v1`, or the acceptance-video
publish. `lib/permissions/catalog.ts` opens by forbidding a switch that gates
nothing; a picker offering `board:configure` — which no token-reachable
operation asserts — would be exactly that lie, one level up.

`GRANTABLE_PERMISSIONS` is therefore **DERIVED** from the operation maps
(§3, §6), never hand-listed, and a guard asserts the derivation in both
directions: no grantable key without an operation, no operation whose key is
ungrantable.

At this document's date the derived set was **six keys** (it is seven since
MOTIR-3629 split archive out of delete — §10):

| key                 | domain    | reachable through                                               |
| ------------------- | --------- | --------------------------------------------------------------- |
| `project:browse`    | project   | every read, on both seams                                       |
| `work_item:edit`    | work_item | create / update / transition / link / move / integration writes |
| `work_item:archive` | work_item | archive · unarchive (the reversible one — MOTIR-3629, §10)      |
| `work_item:delete`  | work_item | delete (the irreversible cascade) and its dry run               |
| `comment:add`       | comment   | `add_comment`, `POST …/comments`                                |
| `sprint:manage`     | sprint    | the sprint lifecycle + backlog/sprint membership                |
| `ai:plan`           | ai        | `expand_item`, the three plan-session operations                |

The number is a consequence, not a target: it moves when an operation moves, and
the guard is what keeps the picker and the gates agreeing about it.

### 3. The per-operation maps are read off the SERVICE, not off the old scope

`TOOL_PERMISSIONS: Record<McpToolName, PermissionKey>` (total over all 39 tools,
so a tool added without one is a compile error) and each `V1Operation.permission`
name **the permission the route's own service already asserts** — sourced from
`docs/decisions/permission-inventory.md`, which walked every route and recorded a
decided policy per operation.

Three consequences are deliberate, and each is a real narrowing:

- **AI planning stops hiding under "edit work items".** `expand_item`,
  `open_plan_session`, `append_plan_turn` and `submit_plan_session` were filed
  under `work_items:write` because nothing narrower existed, and
  `lib/mcp/scopes.ts` says so in a comment. They assert `ai:plan`
  (`aiPlanEditsService.assertCanPlan`, `planChangeSessionsService.assertCanPlan`),
  and that is what they now declare. A token wired to file work items can no
  longer spend the owner's AI credits.
- **Commenting separates from editing.** `add_comment` asserts `comment:add`
  (`commentsService` → `getCommentCapabilities` → `canComment`), not
  `work_item:edit`.
- ~~**Archive joins delete.**~~ **⚠️ REVERSED by MOTIR-3629 (2026-08-26) — see
  §10.** This consequence read: _"`archiveWorkItem` / `unarchiveWorkItem` assert
  `work_item:delete` in shipped code, so the old `work_items:archive` /
  `work_items:delete` split does not survive contact with the gates. It is a
  narrowing for archive, and the honest one: the product already governs both with
  one key."_

  It was an accurate reading of the gates, and the rule it applied — _read the map
  off the SERVICE, never off the old scope_ — was the right rule. What it could not
  see is that the SERVICE was itself reading a mis-grouped key: the two operations
  shared `work_item:delete` because `permission-inventory.md` R42 grouped them on
  _"cascades over a subtree"_, which archive does not do. So this bullet faithfully
  propagated a defect one tier up, and the legacy split it dismissed was the
  evidence rather than the noise. `work_item:archive` restores it, at the tier
  where it belongs.

**No exceptions — the rule is total.** Every one of the 39 tool entries and 40
operation declarations names the permission its own service asserts, with no row
held on an exception list.

> **There was ONE, and it is closed (MOTIR-2603, 2026-08-10).**
> `POST /api/v1/work-items/{key}/implementation` declared `work_item:edit` while
> its service (`workItemsService.reportImplementation`) asserted only
> `project:browse` — it called `getWorkItem` and then wrote provenance. This ADR
> declared `work_item:edit` anyway, because declaring `project:browse` would have
> matched the service and LOOSENED a write from `integration` to any read token,
> and logged the service's missing assertion as a bug rather than ratifying it in
> the map. That bug is fixed: the service now asserts `work_item:edit` before the
> provenance write, in the shape `markIntegrated` / `completeSession` use, so the
> declaration and the gate agree and the exception list is empty rather than
> one row long. It is recorded here because the reasoning — _a write gated by a
> read permission is a defect in the gate, not a fact the map should ratify_ —
> is the rule the next such row gets read against, and because an exception that
> vanishes without a trace reads as one that was never noticed.

> **A second candidate was raised and DECLINED (MOTIR-3051, 2026-08-19).** `create_plan` is
> gated by `work_item:edit` while its partner `add_plan_items` is gated by `ai:view_plan`, so a
> grant holding the first and not the second — `CLI_TOKEN_GRANT` — can open a plan it can never
> fill. The proposal was to make that one tool declare BOTH keys, i.e. the first entry on a new
> exception list and a widening of `TOOL_PERMISSIONS`' value type. It was declined: the harm was
> not the empty plan but a downstream consumer reading it as a pending review, the same row
> arrives from a generation job that dies before its first append (which holds every key), and
> the totality this map buys — an unmapped tool is a compile error, `lib/tokens/grant.ts` derives
> the grantable set from it, `/docs/mcp/tools` groups by it — is worth more than closing a door
> whose room was the actual defect. Fixed at the gate instead; the reasoning is on the record in
> `agent-authored-plans.md` AMENDMENT 1. **§3 and the map still agree, and the exception list is
> still empty.**

### 4. Composition is unchanged: the grant NARROWS, the role decides

`granted ∩ role`, exactly as `scope ∩ role` is today. An operation is permitted
only when the owner's project role allows it **AND** the token's grant contains
the operation's permission. A token can grant **less** than its owner's access,
never more — which is already the sentence the Roles & permissions screen
promises, and is now literally the same vocabulary on both screens.

This is the part of the two superseded statements that survives intact.

### 5. The legacy six map FORWARD, on READ — no migration, no rewritten rows

`LEGACY_SCOPE_PERMISSIONS: Record<TokenScope, readonly PermissionKey[]>` expands
each stored string into the permission set its operations assert, applied when a
token is read. Nothing rewrites a row. `TokenScope` survives **only** as this
table's key type; nothing new may be typed against it.

| stored scope         | expands to                                                |
| -------------------- | --------------------------------------------------------- |
| `read`               | `project:browse`                                          |
| `work_items:write`   | `work_item:edit`, `comment:add`, `ai:plan`                |
| `work_items:archive` | `work_item:archive` (MOTIR-3629 — was `work_item:delete`) |
| `work_items:delete`  | `work_item:delete`                                        |
| `sprints:write`      | `sprint:manage`                                           |
| `integration`        | `work_item:edit`                                          |

The union of the six equals the set the pre-change default grant conferred plus
`work_item:delete` — i.e. everything — and a test checks that rather than
asserting it.

> ⚠️ **AMENDED 2026-08-20 (MOTIR-3188): "everything" now has exactly one
> exclusion, and it is the rule working rather than a gap.** The union of the six
> is everything the six's OPERATIONS could reach — which was the whole grantable
> set until a key arrived for an operation that postdates these strings.
> `ai:decide_plan` gates plan APPROVAL, whose only token entrance
> (`POST /api/v1/work-items/{key}/plan-approval`) MOTIR-3021 created in 2026. No
> legacy scope expands to it, because a legacy row is stale data and stale data
> may never WIDEN access — the same posture `expandStoredValue`'s third arm takes
> for a value it cannot interpret at all.
>
> **And the split is what kept it from widening.** `work_items:write` expands to
> `ai:view_plan`, and for the hours between MOTIR-3021 merging and MOTIR-3188
> landing, that key gated plan approval — so a token carrying a legacy string
> could have approved a proposed subtree into somebody's tree. Nobody planned that
> and nobody would have noticed it; separating DECIDE from AUTHOR removed it as a
> side effect. `tests/tokens/grant.test.ts` pins the exclusion by name so the next
> reader meets it as a decision instead of an anomaly.

**⚠️ ONE pair does not preserve exactly, and the direction is stated here.**
`integration` and `work_items:write` both expand through `work_item:edit`,
because `markIntegrated` and `completeSession` reach
`applyStatusTransition → assertCanEdit` — the same gate `transition_status`
reaches. So under the permission vocabulary the two scopes become
indistinguishable at that key: an `integration`-only token gains the work-item
edit operations, and a `work_items:write`-only token gains the two integration
writes. The old vocabulary drew a line the product's gates do not draw.

We accept it rather than paper over it, for three reasons: the catalog gains no
key in this story (MOTIR-2572's scope boundary), so there is nothing narrower to
map to; `∩ role` still caps both directions, so nobody gains authority their role
withholds; and the widening touches no irreversible operation —
`work_item:delete` is reached by neither scope. An `integration`-only token is
also only producible by explicitly deselecting everything else in the modal:
neither `DEFAULT_TOKEN_SCOPES` nor `CLI_TOKEN_SCOPES` is that shape.

**⚠️ AND ONE OPERATION IS LOST BY A LEGACY `read` TOKEN — `open_plan_session`.**
Measured, not estimated: walking all 39 tools, exactly one has a new permission
its old scope does not forward-map to. `open_plan_session` declared `read`
("opening the door is not starting a conversation"), and its service
`planChangeSessionsService.getOrCreateForScope` asserts **`ai:plan`**. The old
scope was over-permissive relative to its own gate, so a stored `read`-only token
that could open a planning thread no longer can.

We do NOT widen `read` to cover it. `read → ai:plan` would hand every legacy
read-only token `expand_item` and `submit_plan_session` — billable operations it
never had — which is a widening in the one direction that costs the owner money.
Losing the mount read of a planning thread is the cheapest of the four planning
operations to lose, and the loss is a correction of the scope, not of the gate.
`tests/mcp/scopes.test.ts` pins this as a NAMED exception, so the tool-by-tool
coverage check stays exhaustive and a second loss cannot appear unnoticed.

**Why expand-on-read and not a migration.** Tokens are credentials living in
other people's CI systems and agent containers. A migration would have to be
exactly right the first time, against live rows, with no way afterwards to tell
which values were original — and it would buy nothing, because the column stores
strings either way. An unrecognised stored string **yields no authority and does
not throw**: a malformed row must degrade to _less_ access, never to a default
grant nobody chose.

**The column keeps its name.** `api_token.scopes` stores strings; permission keys
are strings. Renaming it is a migration with RLS blast radius against a database
mid `motir_app` role cutover, for a name no reader sees — the same call
MOTIR-2532 made about the `api_token` table. Its Prisma doc-comment is rewritten
to say what it now holds and to name the expansion function.

### 6. `x-motir-scope` becomes `x-motir-permission`, with NO compatibility window

The emitted OpenAPI carries `x-motir-permission` on every operation.
`V1_SCOPE_DESCRIPTIONS` is **deleted**, not renamed: the published description of
a permission is read from `PERMISSION_CATALOG`, so the meaning on the reference
page and the meaning on the Roles & permissions page are the same string and
cannot drift.

**No compatibility window for the old extension**, and the reason is specific:
`x-motir-scope` carried values from a vocabulary that no longer exists after this
story. Emitting both would publish two names for one requirement, one of which
resolves to a scope the modal cannot grant — worse documented than emitting one.
The only in-repo consumer is `packages/cli/src/api/operations.ts`, which moves in
the same story (MOTIR-2583) and gains a drift check against the emitted document.
An out-of-repo generated client sees a renamed extension in a minor release; the
`bearerPat` scheme, the paths and every schema are untouched.

`V1_EXPOSED_SCOPES` / `V1_UNEXPOSED_SCOPES` become permission-shaped and stay
**derived**. `work_item:delete` remains unexposed by `/api/v1`
(`tests/helpers/v1RouteAudit.ts`'s `declares-delete-scope` rule, re-expressed),
so the irreversible cascade is reachable only through MCP.

### 7. The device grant is RE-EXPRESSED, never widened

`CLI_TOKEN_GRANT` replaces `CLI_TOKEN_SCOPES` and stays the narrowest set
covering exactly what the CLI calls. The CLI's MCP surface is
`packages/cli/src/client.ts` (**not** `packages/cli/src/mcpClient.ts` — the path
`lib/mcp/scopes.ts` names does not exist; corrected here so the next reader does
not go looking for it).

`['read', 'work_items:write', 'integration']` expands to
**`project:browse`, `work_item:edit`, `comment:add`, `ai:plan`** — which is a
widening of the _expressed_ set only in the sense §5 describes, and is what the
three legacy strings already conferred. It excludes `sprint:manage` and
`work_item:delete`, which is the property that mattered: a credential living
unattended on a remote box cannot delete a subtree.

The approval screen still SHOWS the fixed grant and still cannot edit it —
neither widen (a `work_item:delete` control on a socially-engineerable screen
turns a phishing success into a destructive one) nor narrow (a hand-narrowed
grant breaks `motir auto` mid-run).

`CLI_TOKEN_GRANT` stays co-located with the maps, for the same reason
`CLI_TOKEN_SCOPES` did: adding an MCP tool must carry the question _does the CLI
call it, and does this set already cover it?_

### 8. The default grant — and the one thing it stops conferring

`DEFAULT_TOKEN_GRANT` is `GRANTABLE_PERMISSIONS` minus `work_item:delete` —
the same "all but the irreversible one" rule `DEFAULT_TOKEN_SCOPES` encoded, now
derived rather than filtered by hand. `work_item:delete` is the one key marked
**irreversible**, and the surfaces set it apart visually (MOTIR-2578).

**⚠️ It NARROWS, and the narrowing is archive.** `DEFAULT_TOKEN_SCOPES` was
`TOKEN_SCOPES` minus `work_items:delete`, so it INCLUDED `work_items:archive` —
archive was on by default because it is recoverable. But archive and delete both
assert `work_item:delete` in shipped code (§3), so under one key "all but the
irreversible one" necessarily withholds both. A token minted after this story
with the default grant **cannot archive**; it could before.

The alternative is to put `work_item:delete` in the default grant so archive
keeps working — which would make every default-minted token able to
subtree-delete, the exact thing 7.7 was careful to prevent, and a far worse trade
than losing a recoverable operation from a default. So the default narrows, and
someone who wants archive ticks the key.

This affects NEW tokens only. An existing row carrying `work_items:archive`
expands to `work_item:delete` on read (§5) and keeps archiving — and, being the
same key, can now also delete. That is the second half of the §5 merge, in the
`work_items:archive` → `work_items:delete` direction, and it is accepted on the
same grounds: the gates already govern both with one key, so the old split was
describing a distinction the product stopped making.

> ⚠️ **BOTH PARAGRAPHS ABOVE ARE UNDONE BY MOTIR-3629 (2026-08-26), and the
> second one's closing sentence is what this section got wrong.** The old split
> was describing a distinction the product had never stopped NEEDING — it had
> only stopped being able to SAY it. With `work_item:archive` in the catalog:
>
> - `DEFAULT_TOKEN_GRANT` **confers archive again**, by the same derivation that
>   had excluded it — archive is grantable and is not in
>   `IRREVERSIBLE_PERMISSIONS`, so no arm was added anywhere. The narrowing this
>   section regretted, and the trade it explicitly refused to make (putting
>   `work_item:delete` in the default grant so archive would work), are both gone:
>   a default-minted token archives and still cannot subtree-delete.
> - A stored `work_items:archive` row **stops conferring delete**. It expands to
>   `work_item:archive` alone (§5), which is what that string meant when it was
>   minted. That is a NARROWING of stored data, always legal here; the direction a
>   legacy row may never take is wider.
>
> `work_item:delete` remains the one key marked irreversible and the one the
> default grant withholds. Nothing in that rule changed — only the set it applies
> to stopped containing an operation it was never about.

### 9. The denial wire code

The MCP gate's stable code becomes **`PERMISSION_NOT_GRANTED`**;
`SCOPE_NOT_GRANTED` is removed rather than kept as a compatibility surface. It is
a tool-error code read by an agent's operator, not a persisted or signed value,
and its whole job is to be readable: keeping a code that names a vocabulary the
product no longer has would preserve the exact confusion this story removes. The
message names the missing `resource:action` key.

`/api/v1` keeps its **403** and its error envelope; only the message and the
error class's name change (`InsufficientScopeError` → the permission-shaped one).

### 10. REMOVAL is TWO keys — `work_item:archive` and `work_item:delete` (MOTIR-3629, 2026-08-26)

**§3's third consequence — _"archive joins delete"_ — is reversed here, and §8's
regretted narrowing goes with it.** The two sections are struck in place above;
this is the decision.

**The defect.** `permission-inventory.md` R42 grouped archive with delete because
both _"cascade over a subtree"_. Archive does not: `archiveWorkItem` stamps
`archivedAt` on ONE row and leaves the children live, which the v1 route header
and the `archive_work_item` tool description each say unprompted. So the two
operations were grouped on the single property archive does NOT have, and they
differ on **both** axes that make delete dangerous — reversibility and blast
radius — under a key named after the destructive one. §3 read that key off the
service and faithfully propagated it, which is the rule working on a bad input.

**The tell that it was a real gap and not a tidiness complaint: the product was
already paying for the missing term, in two places.** `/api/v1` exposes archive
and not delete, so its route audit had to admit the archive PATHS by name because
the permission could no longer express the difference; and §5's own table carried
`work_items:archive` and `work_items:delete` as two legacy strings that had
collapsed onto one key. A path allow-list standing in for a permission is a
missing vocabulary item announcing itself.

**The decisions, each of which had a live alternative:**

**(a) The split.** `work_item:archive` gates `archiveWorkItem` / `unarchiveWorkItem`
on all three seams — the service, the two MCP tools, the two `/api/v1`
operations. `work_item:delete` keeps the irreversible cascade and its dry run,
stays the sole member of `IRREVERSIBLE_PERMISSIONS`, and stays unexposed by v1.
No OPERATION changed: archive is still reversible and still non-cascading. What
changed is the boundary of who may invoke which.

**(b) Back-compatibility: IMPLICATION, not migration, and not accepted loss.**
An existing grant holding `work_item:delete` alone would otherwise lose archive on
the day this shipped. The three candidates were: imply archive from delete at
resolution; migrate the stored grants; or accept the loss and name it.

- **Accepting the loss is rejected** — it silently breaks live credentials and
  live custom roles for no gain, and it is the only part of this change that
  could.
- **Migration is rejected, and by a rule this document already made.** §5's
  posture is _no migration, no rewritten rows_, and `ApiToken.scopes`' own schema
  comment says NOTHING rewrites them. `project_role_definition.permissions` is
  read the same way (`customRoleBase` drops what the catalog no longer knows and
  never widens). A migration here would be the first exception to a rule with two
  carriers, in exchange for nothing the read path cannot do.
- **IMPLICATION is chosen.** `PERMISSION_IMPLICATIONS` (`lib/permissions/catalog.ts`)
  maps `work_item:delete → work_item:archive`, and `withImpliedPermissions` is
  applied by both resolution seams — `resolvePermissions` for a role or a stored
  custom-role array, `expandStoredGrant` for a token's stored column. Every
  credential and every role that could archive before can archive after, with
  nothing rewritten.

  **⚠️ It is not a compatibility shim, and that is why it has no sunset.** It is a
  statement about the OPERATIONS: destroying a subtree irreversibly strictly
  dominates hiding one row reversibly, so withholding archive from a holder of
  delete expresses nothing a grantor could mean. It is equally true of a grant
  authored tomorrow. The map is deliberately single-entry, expanded in ONE pass
  rather than as a closure, and a guard pins that no implied key is itself an
  implier — this is not a permission hierarchy, and the catalog stays a flat set.

  It applies at RESOLUTION, so the role editor still shows what a role LISTS while
  the grid and the gates agree on what it CONFERS — the same relationship a legacy
  scope string has to its §5 expansion.

**(c) Role assignment: `member` GAINS `work_item:archive`.** Not behaviour-neutral,
deliberately. Under one key a member — who may edit every field of every work
item — could not archive at all, which is a far stronger restriction than _"may not
destroy a subtree"_ and one nobody chose: it fell out of the grouping. It was
also already visible as a defect, because the shared ⋯ menu drew the Archive row
on `work_item:edit` while the service refused it on `work_item:delete`, so the
product has been offering members an affordance that 403s. The mirror is Linear,
whose archive semantics this operation already copies — `archiveWorkItem`'s own
header cites _"the Linear shape"_ for leaving children intact — and where
archiving is every member's ordinary remove. `viewer` does not gain it (a
read-only actor removes nothing), and neither does the implicit workspace-member
grant: taking a row out of every active view for the whole team is an act of
ownership on a project nobody put you on, reversible or not.

**⚠️ The implicit-grant exclusion is the one that COSTS something, so its
argument is written out rather than assumed.** That actor — a workspace member
with no `ProjectMembership`, on an `open` project — holds `work_item:edit`, and
the shipped ⋯ menu drew them an Archive row on that key while the service refused
it on `work_item:delete`. So they are LOSING a control that was on screen (and
403ing) rather than one that worked, and `tests/e2e/work-item-delete.spec.ts` was
asserting its presence with a reasoned comment. Three things decide it:

- **§2's rule is about acts of OWNERSHIP, and archiving is one.** Editing a field
  changes a card; archiving takes it out of every active view for the whole team.
- **`levelGrants` is the load-bearing constraint, and it is what makes the
  alternative worse.** It names only `work_item:edit` / `comment:add` /
  `attachment:create`; every other key takes the default arm. So putting
  `work_item:archive` in the implicit set _without_ a branch there would leave an
  outsider on a `limited` project able to ARCHIVE while unable to EDIT — a state
  neither answer wants. Adding that branch is a per-level policy change
  `lib/permissions/resolve.ts` explicitly reserves for a card that argues for it,
  and `tests/permissions/accessParity.test.ts` proves the current no-branch
  property over the whole 64-row space.
- **This card asked about ROLES.** It named `member`, and the implicit grant is
  not a role. Narrowing is the reversible direction for a permission change; a
  later card that wants an outsider to archive on an `open` project can add the
  key AND the `levelGrants` branch together, which is the only coherent way to add
  it.

Recorded here rather than left to be re-derived from an absent test assertion.

**(d) The device grant is NOT widened.** `CLI_TOKEN_GRANT` covers exactly what the
CLI CALLS, and the CLI calls neither archive tool. The workflow that wants archive
routinely — the re-plan procedure's _archive the superseded nodes_ — runs under a
workspace PAT that chooses its own grant, and that PAT is the caller this split
was filed for. §7's rule stands: this set widens only where a card argues for it.

**(e) The legacy map is corrected rather than left merged.** `work_items:archive`
now expands to `work_item:archive` alone, restoring what that string meant when it
was minted and closing the archive → delete half of §5's accepted merge — a
credential granted only the recoverable operation had silently gained the
irreversible one. `work_items:delete` is unchanged and its holder keeps archiving,
via (b).

**What is machine-checked, so this cannot quietly revert:** the v1 route audit's
`ARCHIVE_PATHS` carve-out is DELETED and the rule keys on the permission again —
any v1 route declaring `work_item:delete` is a violation with no exception, which
is the proof that the vocabulary now says what the product means.

---

---

## AMENDMENT 1 — a token may also bind to a PROJECT (Yue, 2026-08-10)

**This overturns Story MOTIR-2572's own scope boundary**, which reads:

> **Workspace-level authority.** A token is still BOUND to one workspace and the
> binding picker is untouched.

Correct when the story was cut, and not correct once §1–§3 above landed. The
reversal is Yue's explicit call, recorded here with its date for the same reason
the story's other reversal is: a boundary that changes silently is
indistinguishable from a boundary nobody read.

### A.1 What was wrong — the PICKER, not the binding

`apiTokensService.create` validates a requested grant against the STATIC
`GRANTABLE_PERMISSIONS` and never against the caller's own access. So a project
VIEWER can tick _Delete work items_, mint the token, and hold a grant they cannot
exercise anywhere.

It is not privilege escalation — §4's `grant ∩ role` still decides every call —
but it is the lie `lib/permissions/catalog.ts` opens by forbidding, one level up,
on a screen that promises _"You can grant less than your own access, never
more."_

And the fix is not "filter the picker by the user's role", because **there is no
single such role.** `resolvePermissions` (`lib/permissions/resolve.ts`) resolves
per PROJECT from `accessLevel` + `workspaceRole` + `projectRole` + the custom
role's stored set. A token binds to a WORKSPACE. An admin in project A can be a
viewer in project B of the same workspace, so _"may this token edit work items?"_
has no answer until a project is named.

### A.2 The rule: the binding is REQUIRED where the GRANT IS CHOSEN

| Credential  | Minted by                          | Grant                                             | Binding                           |
| ----------- | ---------------------------------- | ------------------------------------------------- | --------------------------------- |
| Hand-minted | the create-token modal             | **chosen** from that project's set for that actor | **project** — required            |
| Device      | `motir login` → `/device` approval | **fixed** `CLI_TOKEN_GRANT`, unconfigurable       | **workspace** — `project_id` NULL |

A **chosen** grant needs a project, because the question the picker asks is
meaningless without one. A **fixed** grant asks nothing: the approval screen
SHOWS `CLI_TOKEN_GRANT` and cannot edit it (§7), so there is no offer to be wrong
and `grant ∩ role` resolves per project at dispatch. That is precisely the
property that makes a device credential _"what the holder can do, decided by their
roles in the projects."_

**No picker, no lie.** The rule follows from that sentence and nothing else.

### A.3 `project_id` is NULLABLE, and NULL is a MEANING

Not "optional", and not "legacy tolerated". **NULL is the device-credential
shape**, and it is a permanent legal state.

Write it that way in the Prisma doc-comment. A column documented as optional
acquires a `NOT NULL` and a backfill within a year, and this one has no correct
value to backfill: there is no project a `motir login` credential should be
pinned to.

No migration rewrites a row. Every token minted before this amendment is the
device shape by construction, which is also why the token list can render them
without a special case.

### A.4 The grantable set has ONE arm

Project-bound → `projectAccessService.getPermissions(projectId, actor)` ∩
`GRANTABLE_PERMISSIONS`, in catalog order.

A union-across-the-workspace arm was considered and is **dead**: nothing reaches
it, because the only tokens without a project are the ones whose grant is fixed,
and a fixed grant is not chosen from an offer. Recorded so a reader does not
re-derive it as a missing case.

**The workspace-owner rail makes this a no-op for most people.** `resolvePermissions`
layer 2 hands a workspace owner/admin the whole role-gated catalog in EVERY
project, so their offer is the full grantable set either way. This amendment
changes nothing for them and everything for members and viewers — worth saying,
or the filtering reads as dead code.

### A.5 What `create` must enforce

Two legal shapes, and only two:

- `{ permissions, projectId }` — a chosen grant, bound to a project. Each key
  validated against **what the caller can confer in THAT project**, not against
  the static set. A key they do not hold is a typed error → 422.
- `{ }` (fixed grant, no project) — the device path, which supplies
  `CLI_TOKEN_GRANT` and no `projectId`.

A chosen grant with no project, and a fixed grant with a project, are both
refused. Four combinations of which two are bugs is a shape worth designing out
rather than testing around.

A `projectId` the caller cannot browse is a **404**, never a 403 — the shipped
404-not-403 contract, so the binding cannot be used to discover projects.

### A.6 What DISPATCH does with the binding

A project-bound token calling an operation that resolves to a DIFFERENT project
is refused as **NOT-FOUND**, not as a permission denial.

"Forbidden" is the intuitive answer and the wrong one: it confirms the other
project exists, turning a deliberately-narrowed credential into an oracle for
enumerating a workspace. Every cross-tenant read in the product already answers
404-not-403 for exactly this reason; a new gate that answered differently would
be a hole shaped like the contract everything else keeps.

A NULL-bound token is unaffected at both seams. That is not a compatibility shim
to remove later — **it is the specification of how `motir login` works.**

### A.7 `list_projects` STAYS

An earlier revision of this amendment proposed retiring it. It does not, and the
reason is the one that decides A.2: the device credential legitimately spans the
projects its holder's roles reach, and `list_projects` is how an agent — and
`motir link` — discovers them. `packages/cli/src/projectLink.ts` (`resolveProject`,
`autoLinkAfterLogin`) calls it to bind a folder.

Its two behaviours are part of the contract:

- a NULL-bound (device) token → every project its holder can browse in the
  workspace;
- a project-bound token → exactly its one project.

That pair is what makes the binding legible to an agent at the moment it asks
what it can reach, in both shapes.

### A.8 OPEN — a workspace with NO project (not settled)

A.2 makes the binding required wherever the grant is chosen. It says nothing
about the workspace that has no project to bind to, and that case is real: a
freshly created workspace has none until someone makes one.

**What happens today, recorded rather than decided:** the modal renders, the
project picker is empty, and `submit`'s guard (`!selectedProject`) returns — a
fillable form whose Create button does nothing, with no empty state and no
message. `tests/components/create-token-modal.test.tsx` pins this and labels it
_RECORDED, NOT ENDORSED_, so whichever way it is settled the change is visible in
a diff rather than silent.

The two candidate resolutions, neither chosen here:

- give the modal an EMPTY STATE that names the reason and points at project
  creation; or
- decide that a project-less workspace offers only the DEVICE credential, and
  say so on the pane.

The device flow is unaffected either way: a fixed grant binds to no project
(A.3), so `motir login` works in a workspace with nothing in it.

## AMENDMENT 2 — the room view keys are read FORWARD, never written (MOTIR-6329, 2026-09-25)

Story MOTIR-6179 splits two VIEW keys out of `project:browse`'s reach —
`plan:view_any` (the Plans room) and `run:view_any` (the Runs room) — and the
rooms' reads start asserting them (MOTIR-6330 / MOTIR-6331). Every token that can
browse opens both rooms today, so without a carry each would lose them the day the
reads land. The carry follows §5's rule for a stored value, not a migration:

- **`expandStoredGrant` reads a stored grant holding `project:browse` forward into
  both keys** (`ROOM_VIEW_FORWARD_KEYS`, `lib/tokens/grant.ts`). On READ, beside the
  legacy-scope expansion; **no migration touches `api_token`**, for the reason the
  column's own comment gives — nothing rewrites a live credential's row.
- **The cutover is a MARKER written into every grant minted from this change on,
  not a date** (`GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER`, stored beside the keys in
  `api_token.scopes` by `apiTokensService.create`). A CHOSEN grant (project-bound)
  stored WITHOUT it was minted by a path that could not offer either key — neither
  was grantable — so it is read forward; one stored WITH it was chosen from an offer
  that held them, so it is taken exactly as stored, and a person who deliberately
  leaves a room's key out of a new token keeps it out. `expandStoredGrant` reads the
  marker and drops it; no surface displays it.
  **Why not a date:** a cutover date is right only if it equals the deploy that makes
  the keys grantable, which is unknown when the code is written — set early, a grant
  minted in between loses the rooms; set late, a deliberate narrowing minted in
  between is widened; and every test that mints a token reads differently depending
  on the day it runs. The marker is exact by construction: the code that writes it is
  the code that offers the keys. (The first cut of MOTIR-6329 used `created_at`
  against a constant, and CI on its own head showed the third failure.)
- **A FIXED grant (the device credential, `project_id` NULL) follows the SAME
  rule.** One minted before this change holds neither key and no marker, and is
  read forward; one minted after stores `CLI_TOKEN_GRANT` — which now carries both
  keys, in catalog order, for the reads the CLI already performs — and the marker.
- **No `PERMISSION_IMPLICATIONS` edge `project:browse ⇒ *:view_any`.** An
  implication would make the view keys impossible to withhold anywhere, and the
  DECISION card (MOTIR-6165 Q2) says a custom role and a token must be able to
  close a room.
- **Custom project roles are configuration, not credentials**, so they ARE
  migrated: `20260925170000_room_view_keys_for_custom_roles` appends both keys to
  every `project_role_definition` row holding `project:browse`, idempotently.

## AMENDMENT 3 — the CLI's fixed grant carries `repository:manage` (MOTIR-11038, 2026-11-11)

§7 holds `CLI_TOKEN_GRANT` fixed unless a card argues for widening it. Story
MOTIR-10162 is that card's occasion: an init card's run creates the repository its
card declares, through the new MCP tool `create_project_repository`, and the agent
making that call drives the CLI. `projectRepoSetService` asserts
`repository:manage` on every write to a project's set, so the tool's row names
that key — and the dispatch seam refuses before any handler runs, so without the
widening the tool would register, pass every suite against a wider token, and
refuse the one caller it exists for (the MOTIR-3058 / MOTIR-3051 failure).

**The blast radius, measured:**

- On the MCP surface `create_project_repository` is the ONLY `TOOL_PERMISSIONS`
  row that asserts `repository:manage`, so the key became grantable by derivation
  with this tool and enters `DEFAULT_TOKEN_GRANT` the same way.
- No `/api/v1` operation declares it — the v1 project-repositories route reads on
  `project:browse` — and no route changes in this card.
- A minted token still holds it only where its OWNER already holds it on the
  project (`grantableFor(held)`), and the dispatch gate composes the grant with the
  owner's role.

So what a device-minted credential gains is this one door: append a row and
establish it. It cannot remove, move, re-point, skip or take over a row, because
none of those writes has a token-reachable door. No legacy scope confers the key,
so a stored legacy row never gains it. A device token minted before today gains it
at its next `motir login`; nothing rewrites a live credential's row (§5).

## Consequences

- The picker offers six switches today and grows when an operation's permission
  grows the derived set — without a card that "adds a switch".
- Every already-minted token keeps working, with the one merge in §5 recorded.
- Two narrowings reach existing tokens: AI planning and commenting separate out
  of `work_items:write`. Both are the point of the story; both are called out in
  the implementing PR bodies rather than discovered in a 403.
- `docs/mcp.md`, the `/docs` pages, `docs/cli.md` and both CLI READMEs stop
  teaching the six-scope vocabulary (MOTIR-2581).
- **From Amendment 1:** a hand-minted token now names a project, and the token
  list shows two credential shapes side by side. Nothing a `motir login` user
  does changes, and no existing token is migrated.
- **Left open by Amendment 1 (A.8):** a workspace with no project cannot mint a
  hand-minted token, and the modal does not yet say so. Pinned by a test, not
  resolved by this document.

## Superseded / related

- Supersedes the two file-header statements quoted above.
- Supersedes MOTIR-2254's scope boundary insofar as it named API-token scopes
  "a separate, deliberately separate vocabulary" out of its scope.
- Builds forward of MOTIR-983 / MOTIR-985 / MOTIR-986 (the 7.8 scope model, its
  design, and the modal picker) and re-opens none of them.
- `docs/decisions/permission-inventory.md` — the per-operation policy this
  document reads FROM.
- `docs/decisions/public-api-conventions.md` — where the v1 extension vocabulary
  is pinned.
- `docs/decisions/cli-login.md` Q2 — the device grant this document re-expresses.
