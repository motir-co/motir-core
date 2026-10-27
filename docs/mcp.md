# Model Context Protocol (MCP) server

Motir exposes its project-management core to AI agents over one
**streamable-HTTP MCP endpoint**. Point any Model Context Protocol client —
Claude Code, a custom agent, the Motir CLI — at the endpoint, authenticate with
a personal access token, and the agent can read the ready set, dispatch the next
item, create work items, transition statuses, comment, search, and run the full
sprint cadence — using exactly the same services, permissions, and data the web
UI uses.

This document covers the server landed in Story 7.8: the endpoint, the
bearer-PAT auth gate, how to create a token, how to wire an agent, and the
complete catalog of every shipped tool with its input and output shape.

> **Just trying to wire an agent? Start with the published guide instead:
> [`/docs/mcp`](https://app.motir.co/docs/mcp)** — what the MCP is for versus
> `/api/v1`, a config block for Claude Code, Cursor, VS Code, Codex CLI and any
> other streamable-HTTP client, and one call that comes back. Its
> [tool catalogue](https://app.motir.co/docs/mcp/tools) lists every tool with the
> permission that gates it.
>
> **This document is the REFERENCE**, and it is what the guide hands you off to:
> it keeps the per-tool input tables and output shapes below, which is the part
> that changes most and is therefore kept beside the code. (ADR
> `docs/decisions/public-api-conventions.md`, Amendment 12 Q3.)

## What the Motir MCP server is

- **One endpoint, streamable HTTP.** The server is a single route —
  `app/api/mcp/route.ts` — served at `POST /api/mcp`. It speaks streamable HTTP
  only (no legacy SSE), is stateless (a fresh transport per request, no redis),
  and is never cached (`dynamic = 'force-dynamic'` — readiness and work-item
  state change constantly). It runs on the Vercel `mcp-handler` adapter, which
  bridges Next.js's Web `Request`/`Response` to the MCP SDK transport.
- **Every tool is a thin adapter over a service.** A tool resolves the
  `<KEY>-<n>` keys in its input to ids, then calls the **same service method an
  HTTP route calls** — `workItemsService`, `commentsService`, `sprintsService`,
  `backlogService`, … No tool contains business logic and no tool re-implements
  authorization.
- **An agent sees exactly what its token's user sees.** The bearer PAT resolves
  to its owning user; every service call runs in that user's
  `ServiceContext` (`{ userId, workspaceId }`), so the Story 6.4 role checks and
  the 404-not-403 cross-tenant contract apply unchanged (see
  [Permission model](#permission-model)).
- **It lives in motir-core.** This is the open agent-dispatch surface of the
  Motir stack — the place a hosted or BYOK coding agent connects to pick up and
  update work.

```
agent ──POST /api/mcp (Authorization: Bearer motir_pat_…)──▶ withMcpAuth
        └─ verifyMcpToken: resolve PAT → { userId, workspaceId } (401 if absent/invalid/revoked/expired)
           └─ tool handler ──ServiceContext──▶ the SAME service the UI route calls
```

## Creating a token

The MCP server authenticates with a **personal access token (PAT)**. Mint one
from the web UI:

**Settings → Account → Tokens → Create.**

Give the token a **label** (a human name, e.g. `claude-code`, ≤ 100 chars) and
an **expiry** (the select offers 30 / 90 / 365 days or never; 90 days is the
recommended default). On create, the **full plaintext token is shown exactly
once**, with a copy affordance:

```
motir_pat_<43 url-safe characters>
```

**Copy it then — it is irretrievable afterward.** Motir stores only a SHA-256
hash of the token plus a short display prefix; nothing can reproduce the
plaintext. The token list afterward shows, per row, only:

- the display **prefix** (e.g. `motir_pat_Ab` — a hint, never the secret),
- **created**, **expires** (or "never"), and **last used** timestamps,
- a **Revoke** action.

Token management is a cookie-session UI action: you create, list, and revoke
your **own** tokens while signed in to the web app. A PAT itself cannot mint
more PATs — the MCP tool surface has no token-management tool. Cross-user token
ids read as not-found (the 404-not-403 contract), so a token only ever
sees/mutates its owner's tokens.

## Token permissions

Every token carries a **grant** — a set of the same **permissions** the rest of
Motir enforces, in `resource:action` form, chosen when the token is minted. At
dispatch, each tool call is gated by that grant: if the permission the tool's
own service asserts is not in the grant, the call is rejected with a typed
**`PERMISSION_NOT_GRANTED`** error _before_ any work runs, naming the missing
key.

> **This replaced six coarse "scopes" (`read`, `work_items:write`, …) in
> MOTIR-2572.** Those names no longer exist and are not accepted anywhere.
> **Every token minted before the change keeps exactly the authority it had** —
> Motir expands the stored values when it reads them, and nothing was reissued
> or rewritten. The reasoning is in
> [`docs/decisions/token-permissions.md`](decisions/token-permissions.md).

**The grant NARROWS; it does not replace the role.** The token still acts as its
owner, so the same workspace/project access checks apply on every call (a
foreign or unreachable item is still a 404-not-403 not-found). A call must pass
**both** gates: the grant must hold the tool's permission **and** the owner's
role must permit the operation. A token whose owner is an admin but whose grant
omits `work_item:delete` still cannot delete; a token holding it still cannot
delete in a workspace its owner can't reach. Granting a permission the owner's
role does not have changes nothing — you can grant less than your own access,
never more.

The permissions a token can hold, and the tools each one gates, are listed on
the [tool catalogue](https://app.motir.co/docs/mcp/tools), which is **generated
from the shipped map** rather than transcribed — so it cannot go stale the day
someone adds a tool. Each tool's own entry below names its permission too. The
same catalogue is PUBLISHED as JSON at
[`/api/docs/mcp-tools.json`](https://app.motir.co/api/docs/mcp-tools.json) —
anonymous, cacheable and deliberately unversioned — which is what that page
renders at request time (`docs/decisions/public-surface-hosts.md` AMENDMENT 5).

**Default grant.** A token minted without an explicit choice gets **every
grantable permission EXCEPT `work_item:delete`** — the one irreversible key. So a
default-granted token can archive (`work_item:archive`, a reversible soft-remove
that leaves an item's children untouched) and cannot delete a subtree; opting in
to the destroy is a deliberate tick.

> The two used to be ONE key, and a default-granted token could do neither. They
> were separated in 2026-08 because grouping them made the reversible operation
> ungrantable without the irreversible one. A grant that still names only
> `work_item:delete` reaches both — holding the destroy confers the hide — so
> nothing minted under the old vocabulary lost an operation.

**AI planning is its own permission.** `ai:plan` gates `expand_item` and the
three plan-session tools, all of which spend the workspace's AI credits. Under
the old vocabulary they travelled with _edit work items_ because nothing
narrower existed; an agent wired only to file work items can now be denied them.

## Authorization

Besides a personal access token, an MCP client can connect with **OAuth 2.1** —
the flow Claude's connectors and Claude Code use (MCP authorization spec,
2025-06-18). Motir is the authorization server for exactly one protected
resource, `<base>/api/mcp`. A client discovers everything from two documents:

- **Protected resource metadata** (RFC 9728):
  `<base>/.well-known/oauth-protected-resource`, also served at
  `<base>/.well-known/oauth-protected-resource/api/mcp`. It names the resource
  and its authorization server, `<base>/api/auth`.
- **Authorization server metadata** (RFC 8414):
  `<base>/.well-known/oauth-authorization-server`, also served at the
  issuer-path form `<base>/.well-known/oauth-authorization-server/api/auth`.

Both answer without a session and to any origin. From there a client:

1. **Identifies itself**, one of two ways:
   - **By a Client ID Metadata Document** — the client's `client_id` is an
     `https` URL serving a JSON document that describes it (its name and
     redirect URIs). The metadata advertises
     `client_id_metadata_document_supported: true`, and Claude and Claude Code
     use this path on their own; nothing is registered first. Motir fetches the
     document at authorize time and caches it for up to 30 minutes. The fetch
     resolves the host once and refuses a private or reserved address, never
     follows a redirect, and gives up after 5 seconds or 5 KB. The document's
     `client_id` must equal its own URL. A document Motir cannot use sends the
     person to `/oauth/error` naming the host and why. Consent names the
     client by that verified host, not by the name the document gives itself.
   - **By registering** (RFC 7591) at the advertised `registration_endpoint` —
     a public client (`token_endpoint_auth_method: none`).

   Either way a `redirect_uri` must be `https`, or `http` on `localhost` /
   `127.0.0.1` / `[::1]` (any port: a loopback redirect is matched without its
   port, RFC 8252). A registration naming anything else is refused
   `invalid_redirect_uri`.

2. **Sends the person to authorize** with PKCE (`code_challenge_method=S256`;
   `plain` is refused) and `resource=<base>/api/mcp` (RFC 8707; any other value,
   or none, is refused `invalid_target`). A signed-out person signs in first and
   comes back; a signed-in one is asked for consent at `/oauth/consent`.
3. **Exchanges the code** at `token_endpoint`, refreshes with the refresh token
   (ask for the `offline_access` scope to receive one), and **revokes** at
   `revocation_endpoint` (RFC 7009).

Tokens are opaque and stored hashed. Registration and token requests are
rate-limited per IP (`MOTIR_OAUTH_REGISTER_RATE_LIMIT`, default 60 a minute, and
`MOTIR_OAUTH_TOKEN_RATE_LIMIT`, default 300 a minute).

### A connection is a token

Consent picks **one workspace**, and either **every project** the person can
open or **one project**. Approving records a **connection**, and a connection
is a token in everything but its secret: the same workspace binding, the
same project binding, the same grant, the same "last used". An OAuth access
token resolves to its connection, so a tool called with it runs as the person
who approved, in that workspace, narrowed by that grant — exactly as a personal
access token with the same grant would, down to the error a tool outside the
grant returns.

- **All projects:** the grant is the default token grant (everything a token can
  hold except deleting work items), whatever the request asked for.
- **One project:** the grant is chosen from what the person can confer in that
  project, and a permission outside it is refused, as it is when creating a
  token.

Approving the same app for the same workspace and project again updates that
connection rather than adding a second one. Disconnecting an app deletes the
connection with every token minted from it, so its next call is refused. A
connection whose person has left the workspace is refused too.

### The 401

Every MCP request without a usable bearer — none at all, an unknown or expired
token, a disconnected app's token, a token whose person left the workspace — is
answered **401** before any tool runs, with the pointer an MCP client follows to
start OAuth:

```
WWW-Authenticate: Bearer error="invalid_token", error_description="…",
  resource_metadata="<base>/.well-known/oauth-protected-resource"
```

A `motir_pat_…` bearer is checked exactly as before; anything else is checked as
an OAuth access token.

## Rate limits

`POST /api/mcp` is metered on **three** budgets. The request volume is counted
**per credential**, so each agent you run gets its own allowance, and also
against one **ceiling per workspace** that every agent in it shares. The AI
generation budget is counted per token owner **+ workspace**, because it shares
its counter with Motir's own UI. Minting another token adds an agent allowance;
it adds no workspace ceiling and no generation allowance.

| What is spent                             | On                                                                    | Default           | Env                                               |
| ----------------------------------------- | --------------------------------------------------------------------- | ----------------- | ------------------------------------------------- |
| **Requests** (`mcp:call`)                 | every request, per credential (token or OAuth connection)             | 600 per minute    | `MOTIR_MCP_RATE_LIMIT` / `_WINDOW_MS`             |
| **Workspace ceiling** (`agent:workspace`) | every request, shared by every agent in the workspace (`/api/v1` too) | 12 000 per minute | `MOTIR_AGENT_WORKSPACE_RATE_LIMIT` / `_WINDOW_MS` |
| **AI generations** (`ai:generate`)        | `expand_item`, `submit_plan_session` — the tools that run a model job | 10 per minute     | `MOTIR_AI_GENERATE_RATE_LIMIT` / `_WINDOW_MS`     |

Reads, transitions and sprint writes only ever spend the first two budgets: an agent
polling `next_ready` is not metered as if it were generating a plan. The two
job-submitting tools spend **both**, and their generation budget is the same one
the "Expand" and plan buttons in the Motir UI draw from.

**How a refusal arrives**, in the two shapes:

- **Over the request budget or the workspace ceiling** — HTTP **429** with `Retry-After` and the
  `X-RateLimit-Limit` / `-Remaining` / `-Reset` triple, and a JSON-RPC error body:

  ```json
  {
    "jsonrpc": "2.0",
    "id": null,
    "error": {
      "code": -32029,
      "message": "Too many requests. Retry in 27 seconds.",
      "data": {
        "code": "RATE_LIMITED",
        "retryAfterSeconds": 27,
        "limit": 600,
        "remaining": 0,
        "resetAt": 1754835600
      }
    }
  }
  ```

  An SDK client surfaces this as a transport error carrying the 429; a client
  posting JSON-RPC directly can read `error.data` and back off precisely.

- **Over the generation budget** — an ordinary tool **error result**
  (`isError: true`) whose text carries `RATE_LIMITED` and the retry seconds, and
  whose `structuredContent` is `{ "code": "RATE_LIMITED", "retryAfterSeconds": n }`.
  The request itself succeeded, so it comes back as a normal `tools/call` response.

The `X-RateLimit-*` headers ride **every** response, not only the refusals, so a
client can pace itself before it hits the wall.

## Wiring an agent

Use the endpoint URL for your deployment. In **local development** it is:

```
http://localhost:3000/api/mcp
```

In a hosted deployment, replace the origin with your Motir host (e.g.
`https://<your-motir-host>/api/mcp`). Authenticate with the
`Authorization: Bearer <token>` header on every request.

### Claude Code CLI

```bash
claude mcp add --transport http motir http://localhost:3000/api/mcp \
  --header "Authorization: Bearer motir_pat_…"
```

### `.mcp.json`

The equivalent project config block:

```json
{
  "mcpServers": {
    "motir": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer motir_pat_…"
      }
    }
  }
}
```

### Any streamable-HTTP MCP client

Point the client at the endpoint and send the bearer header:

```
Transport:  streamable HTTP
URL:        http://localhost:3000/api/mcp
Header:     Authorization: Bearer motir_pat_…
```

A request with an absent, malformed, unknown, revoked, or expired token is
rejected with **401** (a `WWW-Authenticate` response) **before any tool runs** —
the rejection never distinguishes the reason, so a caller can't probe token
state.

## Tool catalog

The server reports itself as `{ name: "motir", version: "0.1.0" }` in the MCP
`initialize` handshake and registers **106 tools**.

**Dual-content convention.** Every successful tool result carries **both** a
human-readable `text` block (a compact summary a person watching the session can
read) **and** `structuredContent` — the JSON an agent parses. On a failure a
tool returns an `isError` result whose text is `CODE: message` (the service's
own typed error code + message), so an agent can self-correct.

**Where the shapes come from (Story 11.6).** `structuredContent` is DERIVED from
the same `zod` resource schemas `/api/v1` responds with, rather than hand-shaped
per tool — so the two surfaces cannot disagree about what a work item is, and a
CI guard fails the build if a field is added on one and forgotten on the other.
See `docs/decisions/public-api-conventions.md` Amendment 7.

**Nothing a caller SEES has moved.** The tools still declare **no**
`outputSchema`, deliberately and for new reasons: an `outputSchema` is published
in `tools/list` and validated by the SDK at request time, which would turn a
shape defect into a runtime error in front of an agent and would make every
additive change a published-contract change. The derivation is internal; the
guard is in CI.

**What is frozen and what is free.** Only the DATA SHAPE is shared and guarded —
it is the half with a second consumer. Tool **names**, `tools/list`
**descriptions**, **argument** names and **scopes** remain MCP's own and are
expected to churn: rewording a description is how an agent's behaviour gets
tuned, and nothing in the guard constrains it.

> ⚠️ **One field changed meaning**, and it is the only non-additive change in
> Story 11.6. On the work-item rows `key` used to be the NUMERIC key while
> `/api/v1` — and MCP's own `list_ready` rows — used it for the `<KEY>-<n>`
> identifier. `key` is now the **identifier everywhere**, and the numeric key
> rides beside it as **`numericKey`**, so nothing is lost. Readers of
> `identifier` are unaffected.

**An unknown argument is REFUSED, never dropped (bug MOTIR-3342).** Every tool's
published JSON Schema carries `"additionalProperties": false`, and the server now
enforces it: a call carrying a key the tool does not declare comes back as an
`isError` result whose text is the SDK's `MCP error -32602: Input validation
error: …`, naming the offending key, the nearest valid field where there is a
plausible one, and the full accepted set. So `descriptionMd` sent as
`description` is an error you can read, not a body that silently vanishes.
Two consequences worth stating:

- **`update_work_item` refuses a patch that changes nothing.** A call carrying
  only `key` returns `NO_FIELDS_TO_PATCH` rather than a success reading
  `Patched: nothing`. An update that patches no field is never what a caller
  meant.
- **`add_plan_items`' `modify` patch is the deliberate exception.** That object
  is declared `.passthrough()` so a field the service already understands can
  never be turned away by this schema; unknown keys inside a `patch` still reach
  the service unchanged — **and the service REFUSES them** (`INVALID_PROPOSAL`,
  naming every such key), at the append and at `update_plan_proposal` alike
  (MOTIR-6259). A `modify` has no `executor` key: re-typing a card that has no
  executor seeds the type's default at approve, shown on the review as an
  `executor` change row. The keys it DOES name — `difficulty` among them
  (MOTIR-6136) — are typed, so `patch.difficulty: "extreme"` is refused at the
  schema. Everything else — including `proposedFields` — is strict.

Shared input conventions:

- A **work item** is addressed by its `<KEY>-<n>` **identifier** (case-insensitive),
  e.g. `"ACME-7"`. The owning project is derived from the key prefix.
- A **project** is addressed by its **key**, e.g. `"ACME"` (case-insensitive) —
  the prefix chosen for that project at creation, not a reserved or
  platform-wide value. Obtain it from `list_projects`, which returns the `key`
  of every project the token can reach.
- A **sprint** is addressed by its opaque **id** (not a `<KEY>-<n>` key) — obtain
  it from `list_sprints`.
- Paginated reads take an opaque **`cursor`** in and return a **`nextCursor`**
  out (null at the tail); there is no load-everything path.

### Tool hints

Every tool in `tools/list` carries a human **`title`** and an **`annotations`**
object (Story MOTIR-6974). An MCP client reads them to decide how carefully to
treat a call: **Claude runs a read-only tool without asking, and asks before a
destructive one.** A tool that says nothing is assumed to be a possible write,
so without these every read would ask for approval.

Each tool's values come from ONE table, `TOOL_ANNOTATIONS` in
`lib/mcp/toolAnnotations.ts`, injected where tools are registered. A tool with
no row, no title or a title over 64 characters cannot register. Every field is
explicit on every tool, because the MCP defaults are the permissive ones. For a
Motir tool the fields promise:

- **`title`** — the tool's name in words, 1–64 characters, for a client to show
  a person in place of the snake_case `name`. It is served twice from the tool's
  one declaration: as the tool's own `title` and as `annotations.title`, which is
  where Claude's connector directory reads the name it lists (MOTIR-7189).
- **`readOnlyHint: true`** — the handler performs **no write** of any kind: no
  row created, updated or deleted, no job enqueued, no status moved, no counter
  or timestamp stamped. A tool that writes anything is a write, however it is
  named. A read-only tool carries only `readOnlyHint` and `openWorldHint`.
- **`destructiveHint`** (writes only) — `false` only when every write is
  **additive**: it creates, appends or links, and changes or removes no existing
  value. `true` for anything that deletes, archives, withdraws, unlinks, closes,
  moves a status, or overwrites a stored value.
- **`idempotentHint`** (writes only) — `true` only where a second identical call
  has no further effect (re-setting the same status, re-linking an existing
  edge), confirmed from the handler rather than assumed from the verb.
- **`openWorldHint`** — `true` only where the handler reaches a system outside
  Motir's own deployment, such as GitHub. Motir's own services, its planning
  backend and its file store are not the open world.

The hints are a promise about what a tool CAN do, which is what a client needs
before it asks. They do not replace the token's permissions: a read-only tool is
still refused to a token that was not granted its permission.

Every tool's values are published in the machine-readable catalogue,
`GET /api/docs/mcp-tools.json` (each tool object's `title` and `annotations`),
generated from the same `tools/list` a client receives. This page names no
per-tool value, so it cannot drift from them.

### Reads & dispatch

#### `list_ready`

Browse ONE **ready lane**: a cursor-paginated page of a project's ready work —
work whose every dependency is satisfied — partitioned the way work is run
(Story MOTIR-6829). The lanes are the ones the project's Ready view shows and the
`/api/v1/projects/{key}/ready/{leaves,containers,bugs}` operations serve:

- **`leaf`** (the default) — the ready leaves that are NOT bug work (a `bug`, or a
  leaf whose parent is a `bug`), each naming its runnable `container`: a `story`,
  `task` or `bug` whose every child is childless — the shape `motir run <parent>`
  accepts — or `null`.
- **`container`** — those runnable containers (bugs excluded) holding at least one
  leaf-lane row: what a parent run takes. An `epic` is never one.
- **`bug`** — a ready bug, or a ready subtask of one.

Rows come GROUPED by `container ?? self`: a group ranks by its best member's
`(kind, priority, key)`, members keep that rank inside it. The `leaf` and `bug`
lanes together hold exactly the unlaned ready set (`claim_next_ready` still reads
that set).

| Input        | Type                         | Required | Notes                                                                   |
| ------------ | ---------------------------- | -------- | ----------------------------------------------------------------------- |
| `projectKey` | string                       | yes      | Project key, e.g. `"ACME"`.                                             |
| `lane`       | `leaf` · `container` · `bug` | no       | Which lane; default `leaf`. Anything else is refused, naming the three. |
| `kinds`      | array of work-item kinds     | no       | Restrict to these kinds; omit for any. Not on `container`.              |
| `priority`   | array of priorities          | no       | Restrict to these priorities; omit for any.                             |
| `assigneeId` | string \| null               | no       | A user id; `null` or `"unassigned"` for the unassigned bucket.          |
| `cursor`     | string                       | no       | Opaque page cursor from a previous call's `nextCursor`.                 |
| `limit`      | integer (1–200)              | no       | Page size; default 50.                                                  |

**Output** — `structuredContent`: `{ lane, items, nextCursor: string | null }`. On the
`container` lane each item is a runnable container: `id`, `key`, `kind`, `title`,
`priority`, `assigneeId`, `assignee`, `readyLeafCount` (its leaf-lane rows),
`childCount` (every live child) and `runCommand` (`motir run <KEY>`); `priority` and
`assigneeId` filter on the container. On `leaf` / `bug`, each item is a `ReadyItemDto`
carrying its `container` (`{ key, kind, title, priority }` or `null`). Each `ReadyItemDto` has `id`, `key` (the `<KEY>-<n>` identifier), `kind`, `title`,
`priority`, `status: { key, category }`, `assignee` (or null), and
`descriptionExcerpt` — **plus the `dependencies` block** and the
**[`commentCount`](#the-commentcount-field)** below — and the
[obsolescence mark](#the-obsolescence-mark), `obsolescence` and
`obsolescenceNoteMd`. The mark gates nothing, but a marked card is FINISHED (a mark is
settable only in the done category), so it is not in a ready set; a row carrying one is a
legacy card marked before that rule.

##### The `dependencies` block (list reads)

Both LIST reads — `list_ready` and `search_work_items` — attach the **same**
per-row dependency projection, so one client renderer covers both:

```jsonc
"dependencies": {
  "blockedBy": [{ "key": "ACME-3", "title": "Ship the schema", "status": "done" }],
  "blocks": [{ "key": "ACME-9", "title": "Wire the UI", "status": "todo" }]
}
```

- `blockedBy` — what gates this item; `blocks` — what this item gates.
- Each entry is `{ key, title, status }`: `key` is the `<KEY>-<n>` identifier,
  `status` the raw workflow status key.
- **Both arrays are ALWAYS present** — empty when the item has no edge in that
  direction, so a renderer never branches on presence.
- Archived items on the far end are excluded (the MOTIR-1328 rule), and a
  cross-**project** edge inside the workspace resolves normally (links may cross
  projects); a far end in another tenant never appears.
- Ordered by `key` (numeric-aware), so repeated calls render identically.
- The whole page costs **two** queries regardless of page size — never one read
  per row. For a single item's full relationship set (including `relates_to` /
  `duplicates` / `clones` and the link ids the inline remove needs), use
  `get_work_item`.

The human-readable text block carries the same graph in compact form, appended
to each row's line: `ACME-7 [task/high] Wire the dispatch — unassigned · blocked
by ACME-3 · blocks ACME-9`.

##### The `commentCount` field

**All five work-item reads** — `list_ready`, `search_work_items`, `next_ready`,
`claim_next_ready`, and `get_work_item` — attach the same number to every work
item they return:

```jsonc
"commentCount": 3
```

- **What it counts** — every comment on the item, **replies included**. It is the
  same total [`get_work_item_activity`](#get_work_item_activity) reports as
  `totalCount` / `totalComments` and the web Activity header renders, so the
  badge and the thread behind it can never disagree.
- **Always present as a number**, `0` when there is no discussion — never
  `undefined`, never omitted at zero, so a renderer never branches on presence.
- **Why it is here** — the activity read has to be CALLED to discover a card has
  nothing to say. This is the signal that makes the call worth making: fetch the
  thread for the cards that have one, skip the round-trip for the rest. On a
  dispatch read (`next_ready` / `claim_next_ready`) a non-zero count means the
  card's prose is not the whole brief — read the discussion before starting.
- **One query per page**, whatever the page size — never one read per row.
- Scoped to the caller's workspace, over ids the read has already view-gated: a
  row you cannot see never appears, so it never carries a count.
- On **`get_work_item`** it rides the **item itself**, not the child rows —
  that aggregate answers for one card; the list reads answer per row.
- It is an MCP projection, not a web DTO field: `ReadyItemDto`,
  `WorkItemListItemDto` and `IssueDetailDto` are unchanged.

##### The obsolescence mark

A work item can be marked as no longer **true of the code** (Story MOTIR-6574 ·
MOTIR-6582), on ANY kind — and, since Story MOTIR-6575 · MOTIR-6672, **only on a
FINISHED card**: one whose status is in the project's done category (`done`,
`cancelled`, or a custom done-category status). That is the point of the mark: the
card that shipped the old behaviour is the one a later reader trusts. A card nobody
will finish is **archived**, not marked.

```jsonc
"obsolescence": "outdated",          // or "deprecated", or null
"obsolescenceNoteMd": "Rewritten by the v2 flow — read ACME-40 instead."
```

- **`outdated`** — the text no longer describes what shipped; the capability
  lives on in another shape. **`deprecated`** — retired or overturned on
  purpose; do not build on it. `null` — still current.
- **`obsolescenceNoteMd`** — the Markdown _why_, independent of the mark:
  clearing the mark keeps the note. The item that REPLACES a marked one is a
  real link, `supersedes` ([`link_work_items`](#link_work_items)), so
  `get_work_item` names it in its `supersededBy` group.
- **Written** by [`create_work_item`](#create_work_item) and
  [`update_work_item`](#update_work_item) (`null` clears; a value outside the
  enum is `INVALID_OBSOLESCENCE`).
- **A mark is a finished card's state, and a marked card stays finished** — two
  typed refusals, the same on MCP, REST v1 and every status door:
  - **`OBSOLESCENCE_REQUIRES_FINISHED`** — SETTING `outdated` or `deprecated` on a
    card whose status is outside the done category. A new card lands at the
    workflow's initial status, so `create_work_item` with a mark is refused unless
    that status is itself in the done category. Clearing (`null`) is always legal,
    and a write that omits the mark never meets it.

    ```text
    OBSOLESCENCE_REQUIRES_FINISHED: ACME-12 is at in_progress: only a finished work item can be marked outdated or deprecated. A work item nobody will finish is archived, not marked.
    ```

  - **`MARKED_CARD_CANNOT_REOPEN`** — moving a marked card to any status outside
    the done category ([`transition_status`](#transition_status), a board drag, the
    status control, a system mover), or putting new work under it (a child created
    or moved under a marked parent — a new child would reopen it through status
    derivation). A move WITHIN the done category (`done` ↔ `cancelled`) is not a
    reopen. The way out is to clear the mark with `update_work_item`, then move the
    card; background movers (the parent rollup, the PR-status sync) record it and
    leave the card where it is.

    ```text
    MARKED_CARD_CANNOT_REOPEN: ACME-12 is marked deprecated: clear the mark to reopen this item.
    MARKED_CARD_CANNOT_REOPEN: ACME-9 is marked outdated: a new child (ACME-31) would reopen it. Clear the mark to reopen this item.
    ```

  Over REST v1 both are `422`, with an additive payload: `item: { key, statusKey,
statusCategory }` for the first and `mark: { key, obsolescence, toStatusKey }` for
  the second (`toStatusKey` is `null` for a refused child write). Existing rows are
  not migrated: a card marked before this rule keeps its mark, the guards act on
  WRITES only, and clearing is always legal.

- **Read** by every work-item door: `get_work_item` (the item and each child
  row), `search_work_items`, `list_ready`, `next_ready`, `claim_next_ready` and
  every tool that returns a `WorkItemDto` carry both fields; `skeleton` carries
  the mark only (the note is a body, and bodies stay off the breadth read).
- **The text blocks** of `get_work_item` and `search_work_items` print
  `obsolescence: outdated — superseded by ACME-40` and the note's first line
  (`note: …`) on a marked card, and nothing new on an unmarked one.
- **No read hides a marked card.** No MCP read (and no internal AI read)
  excludes, dims or re-sorts a marked row, and the mark does not touch readiness. To select by it, filter on the `obsolescence` field of
  [`search_work_items`](#search_work_items).

##### The dispatch advisories

**Both dispatch surfaces** — `dispatch_prompt` and `claim_next_ready` — return an
`advisories` array beside their payload:

```jsonc
"advisories": [
  { "item": "ACME-7", "referenced": "ACME-5", "referencedStatus": "in_review", "severity": "likely-missing-edge" },
  { "kind": "shape", "item": "ACME-7", "severity": "likely-ordering-violation", "phrase": "once it lands", "criterionIndex": 5 },
  { "kind": "shape", "item": "ACME-7", "severity": "likely-repo-straddle", "path": "motir-ai/src/x.ts", "repo": "motir-ai", "reason": "contradiction", "criterionIndex": 2 },
  { "kind": "shape", "item": "ACME-7", "severity": "likely-over-gate-sizing", "threshold": "both", "storyPoints": 13, "estimateMinutes": 600 },
  { "kind": "shape", "item": "ACME-7", "severity": "likely-self-blocking-design", "designCriterionIndex": 1, "surfaceCriterionIndex": 4 },
  { "kind": "shape", "item": "ACME-9", "severity": "likely-post-merge-child-under-container", "phrase": "earliest legal start", "container": "ACME-7" },
  { "kind": "shape", "item": "ACME-7", "severity": "body-edit-above-field-move", "bodyEdit": { "at": "2026-09-04T21:53:11.847Z", "fields": ["descriptionMd", "explanationMd"] }, "fieldMove": { "at": "2026-09-04T21:25:39.100Z", "fields": ["title", "type", "executor"] } },
  { "kind": "shape", "item": "ACME-7", "severity": "likely-blocker-count-mismatch", "claim": "four siblings this card is blocked_by", "claimedCount": 4, "blockerCount": 2 }
]
```

Two families ride one array, discriminated by `kind`. **Narrow with
`kind === "shape"`; anything else is a `reference`** — the tag is absent on the
reference variant, deliberately, so widening the union changed no byte of the
shape three consumers already read.

A **`reference`** entry names a work item the dispatched card's **acceptance
criteria** reference while the card carries **no `blocked_by` edge to it**. An
acceptance criterion is what the card is closed against, so naming a not-done
item there is consuming it — and the graph, which is the only part a ready set
can read, does not say so.

A **`shape`** entry has no far end at all: the card contradicts itself. Six
severities, each with its own remedy:

| severity                                  | what it found                                                                                                                                                                                           | remedy                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `likely-ordering-violation`               | criterion `criterionIndex` carries the merge-word `phrase` — a PARTIAL tell: an evidence-phrased post-deploy criterion carries none, so no entry is not a pass (MOTIR-5426)                             | CUT the card at that criterion                                           |
| `likely-repo-straddle`                    | criterion `criterionIndex` names `path`, which lives in `repo` — a repo the card does not CARRY                                                                                                         | SPLIT the card per repo (one repo, one PR)                               |
| `likely-over-gate-sizing`                 | the card's own `storyPoints` / `estimateMinutes` are past the estimation gate (points = the gate's rule; minutes = a proxy)                                                                             | BUILD it and report the sizing — size never stops a run (MOTIR-5372)     |
| `under-authored`                          | a childless task / bug / subtask with no `storyPoints`, `estimateMinutes`, `type` or `executor` AND no enumerated criterion under `## Acceptance criteria` (`criteria`: `no-heading` or `no-criterion`) | BUILD it, state the criteria you worked to — never a gate (MOTIR-5427)   |
| `likely-self-blocking-design`             | criterion `designCriterionIndex` produces a design asset while criterion `surfaceCriterionIndex` builds the surface it draws                                                                            | LIFT the design criterion onto its own `type: design` card               |
| `likely-post-merge-child-under-container` | the CHILD `item` (a `verification` / `deploy` / `manual` or human card) reads the deployment (`phrase`) while sitting inside the runnable container `container` whose merge it waits on (MOTIR-8863)    | lay it as a sibling the container `blocks`, or split into two containers |
| `likely-blocker-count-mismatch`           | an explicit counted claim about the card's own blocker siblings disagrees with its current `blocked_by` edge count                                                                                      | update the stale prose or wire the genuinely missing edge                |
| `body-edit-above-field-move`              | the card's newest body write (`bodyEdit`) moved none of the fields a body describes, and the write beneath it (`fieldMove`) did                                                                         | RE-READ the body against those fields — a prompt, never a stop           |

**`likely-over-gate-sizing`'s two arms do not carry the same authority.**
`storyPoints >= 8` IS the gate's rule — its literal split signal, read off the
card's own column. `estimateMinutes > 70` is a **PROXY** for the gate's other
ceiling and not that ceiling: the gate ceilings a `coding_agent` **run** at one
hour **excluding CI**, while `estimateMinutes` is defined as agent run time
**plus** CI time, so no threshold on the sum can decide the addend. `70` is the
top of the largest total the gate's own calibration table endorses (5 points,
~50–70), which is the smallest threshold that stays silent on every size the
rules ask for. Two residual classes are accepted rather than denied: a short run
behind a heavy CI leg can fire, and a long run with a trivial CI leg can stay
quiet (MOTIR-3271).

**`likely-over-gate-sizing` is the one member that carries no `criterionIndex`**,
because its finding is about two COLUMNS rather than a criterion. At dispatch it
is a warning only: the agent builds the card and reports the sizing, and size
never stops a run (MOTIR-5372, `docs/decisions/over-gate-sizing-never-stops-a-run.md`). It carries `storyPoints` and
`estimateMinutes` as observed (either may be `null` — unestimated crosses no
ceiling) plus `threshold`: `"story_points"`, `"estimate_minutes"`, or `"both"`
when the card is past each. So **narrow on `severity` before reading
`criterionIndex`** — `kind === "shape"` alone no longer guarantees it. It fires
only for a card that is **childless** (a container is sized by rollup) and whose
`executor` is `coding_agent` (a `human` / `manual` card's minutes are human work,
not agent run time); the two thresholds are `storyPoints >= 13` — the split
signal read literally — and `estimateMinutes > 60`, a run that must fit in an
hour.

**`likely-self-blocking-design` carries a PAIR of indices and no `criterionIndex`
either** — `designCriterionIndex` and `surfaceCriterionIndex`, because its remedy
is a LIFT rather than a cut: the design criterion becomes its own `type: design`
card and what is left is `blocked_by` it, so somebody sees the drawing before the
files written to match it (Principle #13). It fires only for a **childless** card
— a container's design child can be reviewed before its code children run, which
is exactly the shape the finding asks for — that is **not itself `type: design`**:
a design card IS the card the lift would create, so it is never reported, whatever
its criteria say (MOTIR-6245). A criterion whose own deliverable is a design asset
is also never read as the rendered surface, which keeps a code card's own mock
criterion out of the surface arm. Read literally the planning-time
design gate is SATISFIED on such a card, because the `type: design` subtask a UI
card must be linked to is the card itself; that degenerate reading is what this
member exists to say out loud.

**`body-edit-above-field-move` is the one member read off the card's HISTORY
rather than its row, and the one named as a fact rather than a `likely-…` defect**
(MOTIR-5399). It reads the card's 20 newest revisions — the KEYS each moved, never
their text — skips every write that moved neither a body (`descriptionMd`,
`explanationMd`) nor a watched field (`title`, `type`, `executor`, `targetRepo`,
`targetRepos`, `kind`, `storyPoints`, `estimateMinutes`), and fires when the newest
remaining write moved a body and no watched field while the one beneath it is an
`updated` write that moved a watched field. `bodyEdit` and `fieldMove` are
`{ at, fields }` — the instant and the relevant fields of each write — so a reader
can act without opening the history. A `created` write beneath never counts
(`create_work_item` takes no `explanationMd`, so nearly every card is finished by a
body-only write), and neither does a second body edit — the edit must sit
DIRECTLY above the move. **It cannot tell a body rewritten to MATCH the move from
one that put the old framing back**; both leave the same trail, which is why it
carries no criterion index and a dispatched run proceeds on it. MOTIR-4513 is the
specimen: replayed at its 21:53 revert it fires, and after the 22:27 corrective
body pass it is silent.

`likely-repo-straddle` carries `reason`: `"contradiction"` when the card CARRIES
repositories and the criterion's path is in none of them, or `"unpinnable"` when
it carries none and its criteria name two or more repos — the pin is then not
merely missing, there is no single value it could take. **Since MOTIR-2728 the
comparison is against the card's whole `targetRepos` SET**, so a path in ANY
repository the card carries is not a contradiction; a path in a repository it
does NOT carry still is, which is the defect this was built to find. **It knowingly fires on a boundary-contract card** (a producer
plus its mirrored consumer, two coordinated PRs, legitimately one card) and
**cannot see the bare-symbol form** of the same tell (a symbol whose repo you
happen to know), so it narrows the human check rather than replacing it.

A **`subsumption`** entry has a far end like a `reference` does, but the far end
is a PULL REQUEST rather than a work item: a path the card's body names is being
changed somewhere else. **Two dispositions, and they are opposite instructions
rather than degrees of one** — read `state` (or `severity`, which agrees) and
never infer from `mergedAt`:

| `state`    | `severity`               | `mergedAt`           | what it found                                                    | remedy                                                                     |
| ---------- | ------------------------ | -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `"merged"` | `likely-already-shipped` | ISO-8601, never null | a MERGED pull request touched the path AFTER this card was filed | READ that diff against the acceptance criteria; close the card if subsumed |
| `"open"`   | `likely-in-flight`       | `null`, always       | an OPEN pull request is touching the path right now              | do NOT file a second card and do NOT branch to fix it — go and coordinate  |

```jsonc
{ "kind": "subsumption", "item": "ACME-7", "severity": "likely-already-shipped",
  "path": "lib/services/workflowsService.ts", "pullRequest": "acme/app#2059",
  "pullRequestTitle": "Bind the READ surface", "state": "merged",
  "mergedAt": "2026-08-15T12:00:00.000Z" },
{ "kind": "subsumption", "item": "ACME-7", "severity": "likely-in-flight",
  "path": "lib/services/workflowsService.ts", "pullRequest": "acme/app#2200",
  "pullRequestTitle": "Inject the resolver", "state": "open", "mergedAt": null }
```

**Why the OPEN arm exists at all (MOTIR-3230), because the merged one looks
sufficient.** A pull request is merged for the rest of time and open for about an
hour, so a merged-only check is loudest long after the answer stops mattering and
silent in the one window where it would change what somebody does. The cost of
the silence is not a duplicate card: a session that files against a path someone
is already changing usually goes on to FIX it, off the default branch, in
ignorance — and two fixes for one defect are each green alone and CANCEL when
both merge.

**The two arms carry different time semantics, deliberately.** The merged arm
requires `mergedAt` strictly after the card's own `createdAt`, because a merge
that predates the card is the substrate it was written against — the opposite
finding. The open arm carries **no such clause**: a pull request opened before
the card and still open is not old evidence, it is a colleague with the file open
now. Where both arms hit one path, the OPEN entry is reported, because its remedy
is right whether or not something also merged.

**What it cannot see: a path nobody has captured.** The finding matches against
each pull request's recorded `changedPaths`, which are captured on the `opened` /
`reopened` / `closed` deliveries — so an open pull request's list is a SNAPSHOT
from when it was opened, refreshed at merge, and a file added by a later push is
invisible until then. Rows written before path capture existed carry none at all
and match nothing. A silent array is therefore never proof that nobody is working
on a path.

- **Always present, `[]` when there are none** — so a client reads one shape.
- **The `likely-missing-edge` tier only.** The prose-vs-graph check also emits a
  plain `advisory` tier for a reference named anywhere ELSE in a body (an
  incident record, a superseded-by note, an out-of-scope aside). That is useful
  while browsing a card and noise in front of an agent about to branch, so the
  dispatch surfaces carry the acceptance-criteria tier alone.
  [`validate_work_item`](#validate_work_item) still reports both.
- **⚠️ NEVER a gate.** Readiness, `openBlockers`, the claim, and the selection
  order are **identical** whether the array is empty or not — an advisory changes
  what a caller is TOLD, never what it may do. Three legitimate shapes trip it: a
  boundary-contract card whose criteria name both halves of a two-PR split, a
  criterion naming a card for contrast, and a sibling that will be done before
  this item starts. Blocking any of them would teach authors to write vaguer
  acceptance criteria, which is worse than the miss it would catch.
- **What to do with one** — before branching, check that the substrate the
  referenced item provides is already on `origin/main` (`git ls-tree` /
  `git grep` for the file, symbol or test the criterion names). If it lives only
  on an open pull request, the card is blocked in fact: wire the `blocked_by`
  edge and stop, rather than rebuilding the other half or stacking onto the
  unmerged branch.
- `dispatch_prompt` **also renders them into the prompt's CONTEXT section**, so
  every agent harness inherits the instruction — no harness writes its own
  prompt. The array is the same content, handed over for the human watching.

The human-readable text block carries it in the same compact form the
`dependencies` marker uses, and renders **nothing at zero**: `ACME-7
[task/high] Wire the dispatch — unassigned · blocks ACME-9 · 3 comments`.

#### `next_ready`

Dispatch the next item of ONE ready lane (see [`list_ready`](#list_ready) for the
lanes and their order), not in `excludeIds`. On `leaf` (the default — it **never
hands out a bug**) and `bug` it is the full dispatch payload an agent runs; on
`container` it is the next runnable container — the unit a parent run takes. Walk
the lane by appending each handled id to `excludeIds`.

| Input        | Type                         | Required | Notes                                                 |
| ------------ | ---------------------------- | -------- | ----------------------------------------------------- |
| `projectKey` | string                       | yes      | Project key.                                          |
| `lane`       | `leaf` · `container` · `bug` | no       | Which lane; default `leaf`. Anything else is refused. |
| `kinds`      | array of work-item kinds     | no       | Restrict to these kinds.                              |
| `priority`   | array of priorities          | no       | Restrict to these priorities.                         |
| `assigneeId` | string \| null               | no       | User id; `null`/`"unassigned"` for unassigned.        |
| `excludeIds` | array of strings             | no       | Work item ids already dispatched this loop — skip.    |

**Output** — `structuredContent`: `{ lane, item: ReadyItemDispatchDto | null, container }`.
On `leaf` / `bug`, `item` is the dispatch payload (`null` when the lane is exhausted)
and `container` is `null`; on `container`, `item` is `null` and `container` is the next
runnable container (the `list_ready` container row, with `readyLeafCount` and
`runCommand: "motir run <KEY>"`) or `null`. `ReadyItemDispatchDto` extends `ReadyItemDto`
with `descriptionMd`, `contextRefs`, `blockerKeys`, `parentKey`, `runCommand`
(`motir run <key>`), `sessionBranch`, `targetRepo`, `targetRepoCloneUrl`, and
`targetRepoDefaultBranch` — plus the
[`commentCount`](#the-commentcount-field) the list reads carry and the
[obsolescence mark](#the-obsolescence-mark) (`obsolescence`,
`obsolescenceNoteMd`) every ready row carries. A marked card is finished, so only a
legacy card marked before that rule can be dispatched — read the note before building
on it. A non-zero
count on a dispatch payload is the cue to read
[`get_work_item_activity`](#get_work_item_activity) before starting.

**`targetRepo` — WHICH repo to run this in** (MOTIR-1804): the bare repo name
(`"motir-core"`) the CLI maps to a checkout via `.motir.json` (`motir link add
<repo> <path>`), so an item targeting repo B dispatches with the agent's cwd
inside B's checkout even when invoked from repo A. **Resolved**, unlike the raw
pin on `WorkItemDto`: the item's explicit `targetRepo` when it has one, else the
**single** repo of the item's project when it has exactly one, else `null`.
`null` means Motir cannot say — with two or more repos and no pin it never
guesses; the CLI falls back to its link-root rule.

The domain is the **project's repository set** (`project_repository`,
MOTIR-1780 · MOTIR-1783) and nothing else. A project that has **no** set resolves
to `null` — it never inherits the **workspace's connected repos** (MOTIR-4955
retired that compatibility fallback: the project link is the isolation
boundary). The single-repo default counts only **established** rows, so a
project whose repositories are all still planned also resolves to `null`. See
`docs/decisions/target-repo-attribution.md` and
`docs/decisions/project-repository-set.md`.

**`targetRepoCloneUrl` / `targetRepoDefaultBranch` — HOW to obtain it**
(MOTIR-1783): `targetRepo` is a bare NAME, which answers an agent that already
has the checkout; these two answer one that does not. The HTTPS clone URL
(`"https://github.com/moooon/motir-core.git"`, derived from the connected repo's
coordinates) and the branch a fresh clone lands on (`"main"`).

Both are **nullable and always present** — a null value, never an omitted key,
never `""`. They are `null` whenever Motir cannot know them: no repo resolved at
all; the pin names a repository that does not exist **yet** (a set row still
being planned — `targetRepo` is still served, because the routing decision
stands) or is no longer connected; or the repo's provider is one this build
cannot address. `targetRepoDefaultBranch` is deliberately **not** defaulted to
`"main"`: a guessed branch is the same class of error as a guessed repo, and a
consumer can only fall back sensibly if it can tell the two apart.

#### `claim_next_ready`

ATOMICALLY **claim** the next ready Subtask for dispatch and return the same
dispatch payload as `next_ready`. Unlike `next_ready` (which only READS), this is
the race-safe write that two concurrent `motir run` sessions use: in one
transaction it locks the highest-ranked ready item (`SELECT … FOR UPDATE SKIP
LOCKED`), **assigns it to you** and transitions it to **In Progress**, and returns
it. Two concurrent
callers therefore never claim the same item — the loser takes the next-best, or
gets an empty result and **retries**. The claim **IS** the assignment and the
dispatch status flip, so do NOT call `transition_status` — or `update_work_item`
to write the assignee — afterwards.

**The assignment (MOTIR-4996), and what it is for.** All three claim doors write
it now: this one, `claim_work_item`, and the scope claim. It answers _who is
working on this?_ for a teammate reading the board, and it is the only ownership
signal a second session can read — it cannot see your working tree, and "In
Progress" stopped meaning _somebody is on this right now_ once a scoped run began
claiming a whole subtree up front. It is a **LABEL, not a lock**: a `todo` card
assigned to somebody else is still claimable, deliberately, and this claim takes
it — taking a card off a teammate is a decision a person is allowed to make, they
just have to be able to see they are making it. A re-claim of a card already
assigned to you writes nothing.

**Scope** — resolved server-side: when the project has an **active sprint**, the
claim is scoped to it (dispatch only committed work); when there is **no active
sprint** — Motir used without sprint planning (plain Kanban) — the claim widens
to the whole project. A missing sprint is therefore never an error, and no sprint
id is passed.

| Input        | Type   | Required | Notes        |
| ------------ | ------ | -------- | ------------ |
| `projectKey` | string | yes      | Project key. |

**Output** — `structuredContent`:
`{ item: ReadyItemDispatchDto | null, advisories: [...], reason? }`.
On a claim, `item` is the same `ReadyItemDispatchDto` as `next_ready` (with
`status` now in the `in_progress` category) — including `targetRepo` and its
`targetRepoCloneUrl` / `targetRepoDefaultBranch` coordinates and its
[`commentCount`](#the-commentcount-field), resolved
identically (see `next_ready` above for the project-scoped rule and the null
semantics). When nothing could be claimed,
`item` is `null` and `reason` is `"none_ready"` (retry — a sibling may have just
claimed the last one — or check there is unblocked work to start). The returned
`assignee` / `assigneeId` are the POST-claim values — you — not the column as it
stood before the claim. Requires
`work_item:edit` (it assigns and flips status).

**`advisories`** — see [the dispatch advisories](#the-dispatch-advisories).
Always present, `[]` when there are none, on BOTH arms.

#### `claim_work_item`

ATOMICALLY **claim ONE NAMED work item** for dispatch. Same lock (and the same
assignment) as
`claim_next_ready`, for the caller that was **handed a card** rather than asking
for whatever is next: in one transaction the row is locked, its status is
re-checked against the **to-do CATEGORY**, and — if that holds — the item is
**assigned to you** and moved to **In Progress**. The claim **IS** the dispatch
status flip, so do NOT call `transition_status` afterwards.

**Which dispatch path uses which.** They are not alternatives; they answer
different questions, and both go through the same service method as the v1
route:

| You are…                      | Use                | Where it is served                                |
| ----------------------------- | ------------------ | ------------------------------------------------- |
| asking for whatever is next   | `claim_next_ready` | MCP only                                          |
| handed a specific card by key | `claim_work_item`  | MCP **and** `POST /api/v1/work-items/{key}/claim` |

`packages/cli` (`motir run` / `next` / `batch` / `auto`) speaks **v1**, not MCP —
it retired its MCP transport in 11.5.6 — which is why the keyed claim's primary
surface is the route and this tool is a second CALLER of the same service method.
There is one lock and one implementation behind both.

**The to-do CATEGORY, not the `todo` key.** The claimable set is `todo` **and**
`blocked`. That is load-bearing rather than incidental: a deliberately forced
dispatch of a card whose dependencies are unmet targets a card sitting at
`blocked`, and keying on the literal `todo` would refuse exactly the case the
force exists for.

| Input | Type   | Required | Notes                                  |
| ----- | ------ | -------- | -------------------------------------- |
| `key` | string | yes      | Work item identifier, e.g. `"ACME-7"`. |

**Output** — `structuredContent`: v1's `WorkItemClaim` resource —
`{ key, title, outcome, claimed, status: { key, category }, assignee, transitionedBy, transitionedAt }`.

**A refusal is a RESULT, not an error**, and it discriminates — the whole point
of the tool. `outcome` is one of four:

- **`claimed`** — it was in the to-do category; it is yours, In Progress, and
  assigned to you.
- **`mine`** — already In Progress **and already assigned to you**. This is a
  RESUME of your own interrupted run, not a lost race. Proceed — and read what
  is already committed on its branch before redoing anything.
- **`taken`** — In Progress and held by somebody else. `assignee` names them
  when the holder assigned it; `transitionedBy` + `transitionedAt` name them
  from the status history **even when nobody was assigned**, which is the common
  case for a session that flipped the status and never wrote the label.
- **`not_claimable`** — outside the to-do category: `implemented`, `in_review`,
  `planning`, `done`, `cancelled`, an archived row, or any custom status. A
  claim never re-opens finished work, which is a hole the CLI's own
  assign-then-transition pair left open.

Requires `work_item:edit` (it assigns and flips status).

> ⚠️ **A server-side claim cannot see the DISK.** A session that dies mid-run
> leaves a working tree behind and no status change at all. The lock and a
> worktree pre-flight answer different questions, and a runbook needs both.

#### `dispatch_prompt`

Return the **canonical, server-generated coding-agent prompt** for one work item.
This is the prompt a BYOK CLI prints and hands to the agent verbatim — **the
client never assembles its own prompt grammar**, so every agent harness (Claude
Code / Codex / opencode / …) receives the identical instruction and the grammar
versions with the product.

A pure **read**: it does NOT claim the item and does NOT change its status
(`claim_next_ready` is the tool that does both), and it works on ANY work item,
not only a ready one — so re-printing an in-progress item's prompt is safe.

| Input           | Type   | Required | Notes                                                                                                                  |
| --------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `key`           | string | yes      | Work item identifier, e.g. `"ACME-7"`.                                                                                 |
| `sessionBranch` | string | no       | Branch to FALL BACK to when the item carries no lineage of its own — the unattended-run seed (see `workflowMode`).     |
| `continueFrom`  | string | no       | A DEAD run's id (`deadRun.id` from `claim_work_item_continue`): the prompt continues it. Else `CONTINUE_FROM_INVALID`. |

**Output** — `structuredContent`:
`{ key, prompt, targetRepo, targetRepoCloneUrl, targetRepoDefaultBranch, workflowMode, sessionBranch, advisories }`.

- **`branch`** — the branch the prompt tells the agent to work on (MOTIR-6530): the
  session branch in `session_lineage` mode, else the item's own per-item branch, and on
  a CONTINUE (MOTIR-6531) the dead run's branch; `null` for a manual item. A local run
  records it on its leg's `checkout_ready` event, which is where `motir continue` finds it.

- **`advisories`** — see [the dispatch advisories](#the-dispatch-advisories).
  Always present, `[]` when there are none. The same content the `prompt` already
  renders in its CONTEXT section, handed over separately so a client can warn the
  HUMAN before the agent starts.
- **`prompt`** — the full text, in four sections: **CONTEXT** (project, item,
  sizing, repo, parent, satisfied dependencies, the context refs and the card
  body), **WHAT TO DO**, **ACCEPTANCE CRITERIA**, **GIT WORKFLOW**. The card's
  `## Acceptance criteria` and `## Context refs` sections are lifted into their
  own sections rather than repeated inside the body.
- **`targetRepo`** — the same RESOLVED repo `next_ready` returns, through the
  same project-scoped resolution (see `next_ready` above and
  `docs/decisions/target-repo-attribution.md`), so the two dispatch surfaces can
  never route differently.
- **`targetRepoCloneUrl`** / **`targetRepoDefaultBranch`** — the same clone
  coordinates `next_ready` returns, with the same null semantics (present with a
  null value whenever Motir cannot say).
- **`workflowMode`** — `"per_item_pr"` (branch from `origin/main`, one PR, stop)
  or `"session_lineage"` (branch from / integrate into the inherited session
  branch, then call `mark_integrated`). **Chosen server-side** from the item's
  inherited lineage. The `sessionBranch` INPUT is a fallback, never an override:
  an item whose dependencies are already integrated — or that is itself
  integrated — keeps that branch, so a caller can never redirect a live lineage
  onto a second branch. What the seed does enable is the FIRST item of an
  unattended `motir auto` run, which by definition has no integrated dependency
  yet and would otherwise be told to open a pull request of its own. A manual
  item ignores the seed entirely. The branch name must be a plain git ref
  (`[A-Za-z0-9][A-Za-z0-9._-/]*`); it is interpolated into prompt text that
  instructs an agent to run `git … origin/<branch>`.
- **`sessionBranch`** (output) — the branch the prompt instructs, or `null`.

**Variants, all decided server-side.** WHAT TO DO varies by the item's `type`
(`code` / `design` / `test` / `decision` / …). A **manual** item (`type: manual`
or `executor: human`) gets the human-instruction form and **no GIT WORKFLOW
section at all** — it has no branch and no PR — and reports `per_item_pr` with a
null branch.

The prompt is a **pure function of server state**: two calls for an unchanged item
return byte-identical text (no LLM, no timestamps). See
`docs/decisions/dispatch-prompt-assembly.md` for the grammar's rationale and the
single named extension point enrichment lands on. Requires `project:browse`.

#### `get_work_item`

Read one work item by identifier as the full issue-detail aggregate — the same
shape the detail page reads.

| Input             | Type    | Required | Notes                                                                                                                                                                 |
| ----------------- | ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`             | string  | yes      | Work item identifier, e.g. `"ACME-7"`.                                                                                                                                |
| `sessionBranch`   | string  | no       | Branch to FALL BACK to when the item carries no lineage of its own — the unattended-run seed (see `workflowMode`).                                                    |
| `includeSections` | boolean | no       | Default `false`. `true` also returns `parsedSections` — the body parsed at read time into the registry's sections for the card's kind × type (MOTIR-9033). See below. |

**Output** — `structuredContent`: the `IssueDetailDto` aggregate: the item
(description, status, priority, assignee, …), its parent, children, dependency
links, and a readiness verdict. The link groups are `blockedBy`, `blocks`,
`relatesTo`, `duplicates`, `clones`, **`supersedes`** (the older items this one
replaces) and **`supersededBy`** (the newer items that replace it) — each an
array of `{ linkId, item }`, `[]` when empty. The text block prints
`Supersedes: …` / `Superseded by: …` lines when either group is non-empty. The **item** additionally carries
[`commentCount`](#the-commentcount-field) — how much discussion this card has,
so the [`get_work_item_activity`](#get_work_item_activity) round-trip is only
paid when there is something to read. The child rows do **not** carry it: this
aggregate answers for one card, and the list reads answer per row.

**`includeSections`** (MOTIR-9033) is an opt-in read of the body as sections.
Unasked, the answer is byte-identical to before. Asked, the tool runs
`parseSections` on the body it already read, with the card's kind and type, and
returns `parsedSections: { sections, found, missing, invalid, signals }` beside the
unchanged `item.descriptionMd`, plus one `Sections: found … · missing …` text line
after `Readiness:`. It is computed at read time, never stored and never written back;
a hand-written body with no headings is answered (its text comes back as `framing`,
the required sections are `missing`, signal `no-headings`), never refused. With a
`planId` it parses the projected target's own body, kind and type.

The aggregate **declares** the item's OWN folder placement (MOTIR-5413) —
`folderId` (the folder it is filed in) and `folderPath` (that folder's names,
root-first) — the same two fields `/api/v1`'s work-item detail
publishes. Both are `null` for an unfiled item **and** for a child of a filed
item: only a root is ever filed, and a child's ancestry already travels as keys.

The aggregate carries **`latestRefusal`** (Story MOTIR-6070 · MOTIR-6422): when
the item's most recently DECIDED approval gate — of ANY kind, ordered by
`decidedAt` — is `changes_requested`, the refusal the next attempt must answer;
`null` otherwise, including when a later approval answered it (an `awaiting`
gate is not a decision and does not clear it). It is the same read the dispatched
prompt's **CHANGES REQUESTED** section renders, so a runbook run and a dispatched
agent are handed the same reason. `noteMd` is the reason verbatim, and is `null`
only on a GitHub review submitted with no body (surfaces say _no reason given on
GitHub_); `refusalVerdict` is set only on a design refusal pressed in Motir;
`subjectVersion` is the refused version.

```jsonc
"latestRefusal": {
  "gateId": "cm…", "kind": "design_result", "noteMd": "The empty state is missing.",
  "decidedByLabel": "Ada <ada@example.com>", "decidedAt": "2026-09-26T01:02:03.000Z",
  "decisionSource": "ui", "refusalVerdict": "revise", "subjectVersion": "cm…"
}
```

The item carries its **`difficulty`** (Story MOTIR-6016) — `trivial` / `low` /
`medium` / `high`, how hard the work is to reason about, or `null` when unset
and always `null` on an epic or story. Every tool returning a `WorkItemDto`, and
every ready row (`list_ready`, `next_ready`, `claim_next_ready`), carries it too.
Beside it the item carries the [obsolescence mark](#the-obsolescence-mark) —
`obsolescence` (`outdated` / `deprecated`, `null` while the card is still true
of the code) and `obsolescenceNoteMd` — and so does every **child** row. On a
marked card the text block prints `obsolescence: outdated — superseded by
ACME-40` (the tail names the `supersededBy` group) and `note: <first line>`; an
unmarked card prints no new line, and a marked child is never hidden or moved.
The folder fields `folderId` / `folderPath` are the ONLY folder fields on the payload, and the text summary prints a
`Folder: Parked ▸ 2025` line beside `Parent:` when one is set.

```jsonc
{ "folderId": "cm9…", "folderPath": ["Parked", "2025"], "item": { "identifier": "ACME-7", … } }
```

Each **CHILD** row additionally carries the same
[`dependencies` block](#the-dependencies-block-list-reads) the list reads attach
— identical shape, identical guarantees — so the children's build ORDER is
derivable from this one call. Since MOTIR-2228 the child rows are the SHARED
schema's output (v1's `WorkItemChild`) widened with the fields the aggregate has
always carried, so a child row's `key` is now its `<KEY>-<n>` identifier and the
numeric key rides as `numericKey`:

```jsonc
"children": [
  {
    "identifier": "ACME-8", "kind": "subtask", "title": "Ship the schema", "status": "todo",
    "dependencies": { "blockedBy": [], "blocks": [{ "key": "ACME-9", "title": "Wire the UI", "status": "todo" }] }
  }
]
```

It costs **two** queries regardless of child count (the same batched reader), and
it is the sibling sub-graph — the item's OWN edges are the richer top-level
`blockedBy` / `blocks` / `relatesTo` groups, which also carry link ids. `motir
show` folds it into the build-order WAVE column; `show --json` adds a computed
`wave` per child (`null` for a member of a dependency cycle).

The aggregate also carries **`deliveries`** — the card's DELIVERY SET, every pull
request that delivers it, oldest link first. This is the read an agent makes
after opening a pull request and calling
[`link_pull_request`](#link_pull_request): it says whether the card is delivered
by one branch or by several, and whether the others are green.

```jsonc
"deliveries": [
  {
    "pullRequest": {
      "title": "feat(api): the delivery set", "repo": "acme/web", "number": 2291,
      "state": "open", "ci": "passing",
      "url": "https://github.com/acme/web/pull/2291"
    },
    "baseRef": "main", "defaultBranch": "main"
  }
]
```

Three things about it are load-bearing:

- **Empty is the ordinary answer.** Most cards have no delivery row, and `[]`
  means _nothing is recorded_ — never _nothing has landed_. It is an array on
  every card and never `null`.
- **`pullRequest.ci` is the ONE CI verdict** — the same `derivePrCiState` the
  Development pill shows and the promotion to In Review acts on. Do not derive a
  second one from `gh pr checks`: two opinions about one commit is the drift this
  field exists to prevent.
- **A merge is not a delivery.** `baseRef` is the branch the pull request
  targets and `defaultBranch` is that repository's own trunk — never assume
  `main`. Merged onto anything else, the work reached no trunk; merged with
  `baseRef: null`, whether it did cannot be told.

The aggregate also **declares** **`errors`** (Story MOTIR-5975 · MOTIR-5981) —
every monitor issue linked to the card, with the facts and the latest event's
**EVIDENCE** Motir has stored: the same rows the item page's Errors section
renders, read through the same service. This is the read an agent makes to
start on a monitor-filed bug without an account on the monitor.

```jsonc
"errors": [
  {
    "id": "cm…", "title": "PrismaClientKnownRequestError: Transaction API error: …",
    "level": "error", "eventCount": 112, "environment": "production", "release": "2026.09.20-1",
    "connection": { "id": "cm…", "orgSlug": "acme", "projectSlug": "web" },
    "evidence": {
      "state": "present", "stale": false,
      "exception": { "type": "PrismaClientKnownRequestError", "message": "Transaction API error: A commit cannot be executed on an expired transaction. …" },
      "frames": [{ "filePath": "lib/services/githubWebhookService.ts", "function": "handle", "lineNumber": 88, "inApp": true }],
      "tags": [{ "key": "transaction", "value": "POST /api/github/webhook" }],
      "request": { "method": "POST", "path": "/api/github/webhook" },
      "eventId": "9fac2ceed9344f2bbfdd1fdacb0ed9b1", "eventAt": "2026-09-20T18:04:11.000Z",
      "readAt": "2026-09-20T18:30:02.000Z", "lastFailedAt": null
    }
  }
]
```

What each part guarantees:

- **It is Motir's STORE, never a live read.** Nothing on this call reaches the
  monitor. The evidence is what the reconciling poll or a hand-made link last
  read, so it can be older than the monitor's own view.
- **`evidence.state`** is one of three values, derived once for every surface:
  `present` (an exception or stack frames), `no_exception` (the event was read
  and carried no exception — its tags and request may still be present) or
  `never_read` (no latest event has been read for this link yet; it arrives on
  a later check). **`stale: true`** means the last check FAILED after the
  evidence was read, so what stands is older than the last attempt;
  `lastFailedAt` says when.
- **Frames are in-app first, then most recent call first**, cut at 20. Tags
  have already had every user-identifying key removed (`user`, `user.*`, `ip`,
  `ip_address`, `client_ip`, `email`, `username`), and the request is a method
  and a PATH — no query string, header, cookie or body is ever stored.
- **`[]` means the card has no monitor link.** On the projected answer
  (`planId`) the key is absent: a proposal has no link.

#### `get_work_item_activity`

Read one page of a work item's **discussion and change trail** — the comments
`add_comment` writes, and the history the Activity section shows. Deliberately a
SEPARATE call from `get_work_item`: that aggregate is a single round-trip and
stays one, so a card with 200 comments never slows an ordinary read.

| Input    | Type                                   | Required | Notes                                                                                 |
| -------- | -------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `key`    | string                                 | yes      | Work item identifier, e.g. `"ACME-7"`.                                                |
| `view`   | `"all"` \| `"comments"` \| `"history"` | no       | Which stream to read. Default `"all"`.                                                |
| `cursor` | string                                 | no       | Opaque continuation token from a previous call's `nextCursor`. Echo it back verbatim. |
| `order`  | `"asc"` \| `"desc"`                    | no       | Page-walk direction. Omit for each view's shipped default (below).                    |

**Output** — `structuredContent` is the page DTO of the selected view, exactly
as the app's own Activity routes return it (no MCP-specific reshaping):

| `view`     | Default `order` | Payload                  | Shape                                                                                                                         |
| ---------- | --------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `all`      | `desc`          | `ActivityAllPageDto`     | `{ entries: ({type:'comment', thread} \| {type:'history', entry})[], nextCursor, totalComments, totalChanges, workItemRefs }` |
| `comments` | `asc`           | `CommentsPageDTO`        | `{ threads: CommentThreadDTO[], totalCount, nextCursor, order, workItemRefs }`                                                |
| `history`  | `desc`          | `ActivityHistoryPageDto` | `{ entries: ActivityEntryDto[], nextCursor, totalCount }`                                                                     |

A `CommentThreadDTO` is a root comment (`id`, `author`, `bodyMd`, `createdAt`,
`editedAt`, `mentionedUserIds`) carrying its single-level `replies`. An
`ActivityEntryDto` is one displayable revision — `changeKind`, `changedAt`,
`actor`, and typed `parts` (`field` / `fieldEdited` / `link` / `collection` /
`commentDeleted` / `created` / `generic`); a body-field edit records only THAT
the field changed, never its text.

Three things to know when paging:

- **A short page with a non-null `nextCursor` is normal**, not an error — both
  `all` and `history` walk a bounded scan that can stop early inside a stretch
  of suppressed noise. Keep calling until `nextCursor` is `null`; the text block
  says `MORE REMAINS` for exactly this reason.
- **The `all` cursor is an opaque composite** carrying both sources' positions.
  Echo it back unchanged — never construct, parse or merge one. A malformed one
  returns `INVALID_ACTIVITY_CURSOR`.
- **Nothing is truncated.** Comment bodies come back in full in both the
  structured payload and the text block (the MOTIR-1709 rule). An item with no
  comments and no displayable revisions returns a well-formed EMPTY page —
  empty entries, zero totals, `nextCursor: null` — so "nothing was said" is
  distinguishable from "could not look".

Read-scoped, and access-gated exactly like the UI: an item in another workspace
(or one the token's role cannot browse) is an indistinguishable not-found.

#### `list_designs`

**What am I building against?** With `blockersOf`, the design cards a work item
is `blocked_by`, each with a verdict; without it, a page of the project's
APPROVED designs.

| Input        | Type   | Required | Notes                                                                                                                |
| ------------ | ------ | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `projectKey` | string | yes      | The project key, e.g. `"ACME"`. Case-insensitive.                                                                    |
| `blockersOf` | string | no       | A work item key. Answers the designs THAT item waits on instead of the project page; the filters below do not apply. |
| `pathPrefix` | string | no       | Only designs holding a file whose repository path starts with this — how a delta mock's amended BASE is found.       |
| `query`      | string | no       | A case-insensitive substring of the design card's TITLE.                                                             |
| `cursor`     | string | no       | Opaque page cursor from a previous call's `nextCursor`.                                                              |
| `limit`      | number | no       | Page size (1–100, default 25).                                                                                       |

**Output** — `structuredContent`: with `blockersOf`, `{ designs: DesignVerdict[] }`;
otherwise `{ items: ApprovedDesign[], nextCursor }`. Both derive from the
`/api/v1` design components, so the two surfaces cannot drift.

**A filtered page is filled, not cut.** With `pathPrefix` or `query`, the tool
reads on past the cards the filter drops until the page holds `limit` designs or
the project's designs run out, so an empty page normally means nothing matched.
It reads at most 1,000 cards per call; past that ceiling a page can come back
SHORT, even empty, with a `nextCursor` — and the text summary then says more
pages remain rather than "No approved designs matched". Keep paging until
`nextCursor` is null before concluding nothing matches (MOTIR-6272).

**No download links, on either arm.** A link lives minutes, so a page of them
would expire before you read the list. Find the design here; call
[`get_design`](#get_design) for links minted when you actually fetch.

#### `get_design`

The APPROVED design of ONE design card, with short-lived links to its files.

| Input | Type   | Required | Notes                                                                                     |
| ----- | ------ | -------- | ----------------------------------------------------------------------------------------- |
| `key` | string | yes      | The DESIGN CARD's identifier, e.g. `"ACME-7"` — not the key of the card that waits on it. |

**Output** — `structuredContent`: a `DesignVerdict`. `approved` carries the
design — its **version** (`evidenceId`), `publishedAt`, `commitSha` (which may
be null) and every asset with its `kind`, `sourcePath`, `fileName`,
`contentType`, `byteSize` and `state`, plus a `url` and `expiresAt` on each
`available` one.

**The answer is a VERDICT, not a design or nothing.** `not_approved` names one
of five reasons, and they call for different actions:

| `reason`            | what it means                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `not_done`          | The design card has not reached Done. Approved-with-an-open-pull-request counts as NOT done. |
| `cancelled`         | The card was cancelled; nothing it drew is going to be built.                                |
| `withdrawn`         | A result was published and then TAKEN BACK — different from never having had one.            |
| `no_result`         | The card is Done but never published a result. The surface is undesigned.                    |
| `not_a_design_card` | That card's `type` is not `design`, so it draws nothing.                                     |

**The version is the one the APPROVAL named**, never simply the card's current
result: a design approved and then republished before its merge would otherwise
be reported as approved when nobody approved it
(`docs/decisions/design-result.md` AMENDMENT 5 Q2).

**⚠️ The links EXPIRE within minutes.** Download every file as soon as you get
them — `curl -fsSL -o <fileName> "<url>"` — into a directory OUTSIDE the
repository checkout, so the design never lands in your diff, and call again for
fresh links if they lapse. An asset whose `state` is `unavailable` has no link
and never will: that approved version's files were reclaimed, which is a real
answer rather than an error, and it is still the design that was approved.

Both tools are read-scoped on `project:browse` — a key `CLI_TOKEN_GRANT` already
carries, so a dispatched agent reaches them without the grant being widened.

#### `get_approval_gate`

**The decision a person MADE on one approval gate — including the note they wrote
when they sent your work back.**

| Input  | Type      | Required | Notes                                                                                                                                                                                           |
| ------ | --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`  | string    | yes      | The work item the gate hangs off, e.g. `"ACME-7"`. Case-insensitive.                                                                                                                            |
| `kind` | kind enum | yes      | Which decision to read — `decision_approval`, `design_result`, `acceptance_result`, `pull_request_approval`, `decision_choice`, `decision_confirmation`, `plan_approval`, `pull_request_merge`. |

**Output** — `structuredContent`:
`{ workItemKey, workItemTitle, kind, gate, routedToLabel }`. The `gate` is an
`ApprovalGateDecision`, derived from the `/api/v1` component its twin
`GET /api/v1/work-items/{key}/approval-gate` returns, so the two surfaces cannot
drift: `state`, `noteMd`, `decidedAt`, `decidedByLabel`,
`decidedUnderAuthority`, `decisionSource`, `subjectVersion`, `supersededCause`,
`outcomeRef` and the two timestamps.

**⚠️ THIS IS HOW YOU READ A _REQUEST CHANGES_ NOTE.** When a reviewer sends work
back — a decision record, a published design, a run's pull requests — the reason
they gave is this gate's `noteMd`. It is not a comment, so
[`get_work_item`](#get_work_item) and
[`get_work_item_activity`](#get_work_item_activity) do not carry it, and neither
do the comment threads. Read it before you change anything: acting on what you
expect the reviewer objected to is how a confident second wrong version gets
produced.

**`gate: null` is an ANSWER, not a miss** — this card has no gate of that kind,
so nothing is waiting and nothing was decided. A key that does not resolve, or a
project the token may not browse, is the indistinguishable not-found instead.

**Read `state` before the audit fields.** Five of them are written BY the
decision, so a null means _not yet decided_ and never _decided by nobody_:

| `state`             | what it means                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `awaiting`          | The question is open. `routedToLabel` says who it is waiting on; there is no note yet because there is no decision. |
| `approved`          | A person approved it. `noteMd` is why, where they wrote one.                                                        |
| `changes_requested` | A person sent it back, and `noteMd` is what to change. It moves no status — the card is yours again as it was.      |
| `superseded`        | Withdrawn before anyone answered. `supersededCause` says what happened to the SUBJECT — never somebody's judgement. |
| `overturned`        | A person refused a `decision_confirmation`'s direction. Terminal, and it names a re-plan a person starts.           |
| `declined`          | A person ended the plan a `plan_approval` asked about. Terminal.                                                    |

Read-scoped on `project:browse`, like the design reads above. **There is no tool
that DECIDES a gate, deliberately** — an approval is a person's act, and the gate
table is the record that it was one
(`docs/decisions/approval-gates.md` §1, §2).

### Work-item writes

#### `create_work_item`

Create a work item (epic / story / task / bug / subtask) under a project,
optionally parented **or filed into a folder**. The reporter is pinned to the token owner. Use
`kind: "epic"` with no `parentKey` to create a **top-level capability area**;
`kind: "bug"` under a story/epic to **log a bug** (the bug-logging protocol). An
epic is **root-only** — the kind-parent matrix admits no parent for it, so
passing a `parentKey` alongside `kind: "epic"` is rejected with
`ILLEGAL_PARENT_TYPE` (MOTIR-1345 — the AI planner generates the whole tree,
epics included, so the agent surface can create one).

| Input                | Type                                                | Required | Notes                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectKey`         | string                                              | yes      | The project the item is created in, e.g. `"ACME"`.                                                                                                                                                                                                                  |
| `kind`               | `"epic" \| "story" \| "task" \| "bug" \| "subtask"` | yes      | The work item kind. `epic` is root-only (reject if `parentKey` is given).                                                                                                                                                                                           |
| `title`              | string                                              | yes      | The title (one line).                                                                                                                                                                                                                                               |
| `parentKey`          | string                                              | no       | Parent identifier — must be a kind-legal, same-project parent. Mutually exclusive with `folderId`.                                                                                                                                                                  |
| `folderId`           | string                                              | no       | A folder id (from [`list_folders`](#list_folders)) to FILE the new item into. Any kind may be filed, a subtask included. With `parentKey` → `PLACEMENT_CONFLICT`; unknown → `FOLDER_NOT_FOUND`; another project's → `CROSS_PROJECT_FOLDER`.                         |
| `descriptionMd`      | string                                              | no       | Markdown description body.                                                                                                                                                                                                                                          |
| `sections`           | object                                              | no       | The item's [sections](#get_section_sets) as named values — the door checks them for the kind × type, names a missing one (`INVALID_SECTIONS`) and renders them into `descriptionMd`. Never together with `descriptionMd` (`SECTIONS_AND_DESCRIPTION_CONFLICT`).     |
| `priority`           | priority enum                                       | no       | Omit for the project default.                                                                                                                                                                                                                                       |
| `storyPoints`        | number \| null                                      | no       | Story-point estimate (non-negative, ≤ 9999.99, ≤ 2 decimals). Omit/`null` → unestimated.                                                                                                                                                                            |
| `estimateMinutes`    | number \| null                                      | no       | Time estimate in minutes (non-negative integer). Omit/`null` → unestimated.                                                                                                                                                                                         |
| `type`               | type enum \| null                                   | no       | Work type (code / design / test / …) — leaf kinds only; rejected on a story. Seeds the executor from the type default unless `executor` is also given. Omit/`null` → untyped.                                                                                       |
| `executor`           | `"coding_agent" \| "human"` \| null                 | no       | Who executes the work — leaf kinds only; overrides the type default. Omit/`null` → the type default (or unset).                                                                                                                                                     |
| `difficulty`         | `"trivial" \| "low" \| "medium" \| "high"` \| null  | no       | How hard the work is to REASON about (not how big) — leaf kinds only; a non-null value on an epic/story is `DIFFICULTY_NOT_ALLOWED_ON_KIND`. Omit/`null` → unset.                                                                                                   |
| `obsolescence`       | `"outdated" \| "deprecated"` \| null                | no       | The [obsolescence mark](#the-obsolescence-mark) — any kind; a new item lands at the unfinished initial status, so a mark here is `OBSOLESCENCE_REQUIRES_FINISHED`. A value outside the enum is `INVALID_OBSOLESCENCE`. Omit/`null` → unmarked.                      |
| `obsolescenceNoteMd` | string \| null                                      | no       | Markdown note saying WHY the item is marked. Omit/`null` → none.                                                                                                                                                                                                    |
| `targetRepo`         | string \| null                                      | no       | WHICH repo the item ships in — bare repo name (`"motir-core"`) or `"owner/name"`. Must name a repo in **this project's** repository set (else `UNKNOWN_TARGET_REPO`). Omit/`null` → unpinned.                                                                       |
| `targetRepos`        | string[]                                            | no       | EVERY repo the item ships in, ORDERED — element 0 is the PRIMARY dispatch routes to. Same validation per element. MUTUALLY EXCLUSIVE with `targetRepo` (else `CONFLICTING_TARGET_REPO_INPUT`). Omit → the set comes from `targetRepo`; `[]` → the empty set.        |
| `targetRepositories` | string[]                                            | no       | The same set as REFERENCES — the project's repository ROW IDS, ORDERED, element 0 the primary. Survives a rename, and can name one of two rows sharing a role. MUTUALLY EXCLUSIVE with BOTH fields above; an id outside this project is `UNKNOWN_PROJECT_REPO_REF`. |
| `plannedWithHarness` | string                                              | no       | Self-reported planning **harness** (e.g. `"Claude Code"`, `"Codex"`). Recorded as planning provenance alongside the server-set source `mcp`. Omit → unrecorded.                                                                                                     |
| `plannedWithModel`   | string                                              | no       | Self-reported planning **model** (e.g. `"claude-opus-4-8"`, `"deepseek-chat"`). Recorded as planning provenance. Omit → unrecorded.                                                                                                                                 |

**Output** — `structuredContent`: the created `WorkItemDto`, plus a
**`placement`** field — `{ parentKey, folderId, folderPath }` — saying where the
item landed, read back off the row. At most one side is set; both null means the
top level. The text summary says the same in words (`Placed in folder Parked ▸
2025`).

Every item created through this tool is stamped with planning provenance
`source = mcp` (server-set — a caller cannot claim `manual`/`native`); the
optional `plannedWithHarness` / `plannedWithModel` record the agent's
self-reported harness + LLM (recorded as-is, no verification implied). See
`docs/decisions/work-item-provenance.md`.

The leaf-authoring fields (`estimateMinutes`, `type`, `executor`, `difficulty`,
`storyPoints`, `targetRepo`) mirror `update_work_item`, so a subtask can be created
fully-specified in a single call rather than a create-then-update round-trip. The
same service rules apply as on the patch path: `type`/`executor`/`difficulty` are
leaf-only (an epic/story kind is rejected), setting `type` without an explicit `executor`
seeds it from the type default, and `targetRepo` is validated against this
project's repository set.

**`sections` — typed input over the free-text body** (MOTIR-9031). `descriptionMd`
stays the one stored body and is always free text; `sections` is an optional way to
WRITE it. The door checks the sections against the set for the item's kind × type
(read it with [`get_section_sets`](#get_section_sets)), refuses a missing, unknown or
malformed section **by name** with `INVALID_SECTIONS` (the message lists each), writes
the headings itself and stores only the rendered text — nothing structured is stored,
and no read returns `sections`. Sending `sections` and `descriptionMd` together is
refused with `SECTIONS_AND_DESCRIPTION_CONFLICT`, and a write with `descriptionMd`
alone is stored exactly as sent: never parsed, never refused for its shape. On
`update_work_item` the stored body is read back into its sections first, so a partial
`sections` changes only what it names, and it is judged on the item's `type` after the
same write. The v1 API takes the same `sections` object on `POST …/work-items` and
`PATCH …/work-items/{key}`; the refusal body carries a `sections` field with the
`missing`, `unknown` and `invalid` names.

**`targetRepo` — pinning the repo an item ships in** (MOTIR-1804). This is what
makes _one subtask = one repo = one PR_ enforceable in the product rather than
only in the planner's rules, and it is what routes the CLI: `motir link add
<repo> <path>` maps a repo NAME to a checkout, and this field says which name the
item belongs to. Accepts the bare name or `"owner/name"` (normalized to the
name), matched case-insensitively against **this project's repository set** and
stored with that repo's own casing. An unknown name is rejected with
`UNKNOWN_TARGET_REPO`, whose message lists the names the project accepts.

**`targetRepos` — a card that ships in MORE THAN ONE repo** (MOTIR-2725 ·
MOTIR-2728). A work item carries an ORDERED SET of repositories, and
`targetRepo` is that set's FIRST element — the PRIMARY, the one dispatch routes
the CLI to. The two are not two facts, so **exactly one of them may be sent**: a
write carrying both is rejected with `CONFLICTING_TARGET_REPO_INPUT` rather than
resolved by a precedence rule that would drop a repository you believed you had
recorded. Send `targetRepo` (or `targetRepos: ["x"]`) for a card that ships in
one; send `targetRepos` for one that ships in several; send `targetRepos: []` to
clear the set.

Every element is validated against the same project-scoped domain a single pin
is validated against. Duplicates collapse (the first spelling wins, compared on
the matched name, so `motir-core`, `MOTIR-CORE` and `moooon/motir-core` are one
element), blank elements are dropped, and ONE unknown element rejects the whole
write — validation is all-or-nothing, because a partially-accepted set would
store a repository list you never wrote.

**`targetRepositories` — the same set, as REFERENCES** (MOTIR-2732 · MOTIR-3039).
A repository is a THING in a Motir project — a row with an id, a role, a label and
an establish state — and this field names those ROWS rather than their names. The
names you read back on `targetRepo` / `targetRepos` are what these references
RESOLVE to, which is the whole point: **rename the repository and a card keeps
pointing at it**, where a stored name would silently stop matching.

Prefer it whenever you have the ids. Two things a name cannot do: survive a
rename, and distinguish two rows that share a role (a project with two `api`
repositories). Its rules are the name field's, on an id — ORDERED with element 0
the primary, duplicates collapse keeping the first, `[]` is the empty set, and ONE
id outside THIS item's project rejects the whole write with
`UNKNOWN_PROJECT_REPO_REF`, whose message lists the project's rows as
`id (name)` so you can self-correct in one hop.

**All three fields are ONE field in three forms, so send exactly one.** Two of
them together is `CONFLICTING_TARGET_REPO_INPUT`, never a precedence rule.

A project that has **no repository set** has no rows to reference, so its cards
keep using the name fields — unchanged, and the reason both forms exist.

**What the set changes downstream, and what it does not.** It does not change
dispatch: `next_ready` / `claim_next_ready` / `dispatch_prompt` still resolve
exactly ONE repository — the primary — with its clone URL and default branch, so
an agent is still sent into one checkout. What it changes is COMPLETION: an item
carrying repositories does not reach Done until EVERY one of them has a pull
request merged onto that repository's own default branch. A merge that leaves any
of them outstanding holds the item at **In Review** and posts a note naming which.

**ONE SUBTASK = ONE REPO = ONE PR is untouched.** A subtask is one worktree, one
branch, one PR; that is physical. The set exists for the containers above it — a
story or a task whose children land in different checkouts — and for the
boundary-contract card that legitimately ships two coordinated PRs.

The validation domain is every row of the project's set — including rows whose
repository has not been **created yet** (MOTIR-1783). A plan pins repositories
before it creates them, so a pin at `proposed` is ordinary; what validation
catches is the typo, the **sibling project's** repo, and a repository the
workspace has connected but this project never linked — all three of which
workspace-wide validation used to accept. A project with no set of its own
accepts no pin at all (MOTIR-4955); it never falls back to the workspace's
connected repos. See
`docs/decisions/target-repo-attribution.md` and
`docs/decisions/project-repository-set.md`.

#### `transition_status`

Move a work item to a target workflow status. The `status` argument accepts the
status **key** (e.g. `"in_progress"`) **or** its display **label** (e.g.
`"In progress"`), case-insensitive. An illegal move returns an
`ILLEGAL_TRANSITION` error enriched with the **allowed targets** from the item's
current status, so the agent can self-correct.

Two refusals say the move is **held** rather than illegal — the edge exists, and
the way out is a decision somebody makes in Motir, not a workflow edit:

- `APPROVAL_GATE_PENDING` — an `awaiting` approval gate owns the target status
  (MOTIR-5526). The message names whose decision it is; every other move stays
  open.
- `PLAN_TARGET_HELD` — the item sits at `planning` under an **undecided plan**
  (`generating`, `planned` or `stale`), which is rewriting it, so **every** move
  out of `planning` is refused until the plan is approved or declined, or the
  proposal naming the item is withdrawn (MOTIR-6265;
  `docs/decisions/agent-authored-plans.md` AMENDMENT 21). The message names the
  plan and its state. A card parked by a planning SESSION with no plan is not
  held.
- `MARKED_CARD_CANNOT_REOPEN` — the item carries an
  [obsolescence mark](#the-obsolescence-mark), and a marked card stays finished: a
  move to any status outside the done category is refused until the mark is cleared
  with `update_work_item` (MOTIR-6672). `done` ↔ `cancelled` is not a reopen and is
  not refused. The message names the item and its mark and says to clear it.

| Input    | Type   | Required | Notes                                    |
| -------- | ------ | -------- | ---------------------------------------- |
| `key`    | string | yes      | Work item identifier.                    |
| `status` | string | yes      | Target status — its key or display name. |

**Output** — `structuredContent`: the updated `WorkItemDto`. The text block
reports the move (`from → to`, or `already in "x" (no-op)`).

#### `add_comment`

Post a Markdown comment on a work item as the token owner. Mention parsing,
`comment_mention` rows, auto-watch, and the comment-created job event all fire
exactly as from the UI — a mention emails the mentioned member with no
MCP-specific wiring.

| Input  | Type   | Required | Notes                                                    |
| ------ | ------ | -------- | -------------------------------------------------------- |
| `key`  | string | yes      | Work item identifier.                                    |
| `body` | string | yes      | Comment body (Markdown). Mention with `@[name](userId)`. |

**Output** — `structuredContent`: the created `CommentDTO`.

#### `edit_comment`

Replace the Markdown body of a comment **the token owner wrote**, and mark it
edited. It runs the same path as editing on the item page: an identical body is
a no-op (no write, no "Edited" tag, no notification), and a mention the edit
ADDS emails that member while mentions already present stay quiet.

**Author only, on purpose.** On the item page a project admin can edit anyone's
comment; through this tool nobody can. A token is gated on one permission per
tool and no token can hold `comment:moderate`, so the grant cannot tell
correcting your own note from rewriting a teammate's — the tool refuses the
second with `COMMENT_FORBIDDEN` whatever the owner's role. Gated on
`comment:add`.

| Input       | Type   | Required | Notes                                                                                   |
| ----------- | ------ | -------- | --------------------------------------------------------------------------------------- |
| `commentId` | string | yes      | The comment id — from `add_comment`'s result or a `get_work_item_activity` comment row. |
| `body`      | string | yes      | New comment body (Markdown). Mention with `@[name](userId)`.                            |

**Output** — `structuredContent`: the edited `CommentDTO`, the same shape
`add_comment` returns. An unknown id, or a comment on an item the token cannot
see, is `COMMENT_NOT_FOUND`.

#### `delete_comment`

Permanently delete a comment **the token owner wrote**. Deleting a top-level
comment deletes its replies with it, the item's history records a
`comment_deleted` entry, and uploads only that thread embedded are unlinked. It
cannot be undone. Author only, for the reason `edit_comment` gives; gated on
`comment:add`.

| Input       | Type   | Required | Notes           |
| ----------- | ------ | -------- | --------------- |
| `commentId` | string | yes      | The comment id. |

**Output** — `structuredContent`: `{ commentId, workItemKey, parentCommentId,
replyCount }` — `replyCount` is how many replies went with a deleted root (always
`0` for a reply).

#### To-do lists — `list_work_item_todos` · `add_work_item_todo` · `set_work_item_todo_done` · `update_work_item_todo` · `delete_work_item_todo` · `move_work_item_todo`

A work item's **to-do list** is the ordered steps of its own work — each step
ONE operation, with who it is for (`executor`), optional Markdown instructions
(`notesMd`) and an optional command to copy (`commandText`), ticked off as it is
done ([`docs/decisions/work-item-todo-list.md`](decisions/work-item-todo-list.md)).
These six tools read a card's list, append a step, tick or untick one, edit
one, delete one and move one, over the same service the **To-do list** section of the item
page uses — so a step an agent writes appears there exactly as a person's would,
and every rule the page enforces applies here unchanged.

| Tool                      | Permission       | What it does                                            |
| ------------------------- | ---------------- | ------------------------------------------------------- |
| `list_work_item_todos`    | `project:browse` | The card's steps in list order, with its progress.      |
| `add_work_item_todo`      | `work_item:edit` | Append ONE step at the END of the list.                 |
| `set_work_item_todo_done` | `work_item:edit` | Tick (`done: true`) or untick (`done: false`) one step. |
| `update_work_item_todo`   | `work_item:edit` | Edit one step — only the fields sent change.            |
| `delete_work_item_todo`   | `work_item:edit` | Delete one step.                                        |
| `move_work_item_todo`     | `work_item:edit` | Move one step to a new position in the list.            |

Every write needs permission to **edit the card** — the same key the item page's
to-do controls need. A token whose grant omits `work_item:edit` is refused every
write before anything runs (`PERMISSION_NOT_GRANTED`); a token whose owner can
only browse the card reads its list and is refused every write by the role
(`PROJECT_ACCESS_DENIED`). A card the token cannot see at
all, including one in another workspace, is `WORK_ITEM_NOT_FOUND` on every tool.
The write key is in the CLI grant, so a dispatched agent can append, tick, edit,
delete and move the steps of the card it was handed.

**Ticking the LAST step does not move the card.** The to-do list never writes
the card's status (ADR §3): a card whose every step is ticked stays where it is
until its own workflow moves it. **A tick is not a revision** either — it stamps
the step with who ticked it and when (`doneAt`, `doneBy`) and writes nothing to
the card's history, while an append, an edit, a delete and a move each record one (ADR §4). **Ticking is
idempotent:** ticking a step that is already ticked changes nothing and keeps the
original `doneAt` / `doneBy`, so a retried call never re-attributes a step.

Editing and deleting were absent until a re-planned card needed its list
brought in line with its new steps (MOTIR-7306): without them an agent could
only leave a step the card can never close on, or tick one nobody performed.
Moving was absent until the CLI guide began correcting a card's list on the
person's word (MOTIR-7556): without it a step in the wrong place could only be
fixed by rewriting the text of every row between.

##### `list_work_item_todos`

| Input | Type   | Required | Notes                 |
| ----- | ------ | -------- | --------------------- |
| `key` | string | yes      | Work item identifier. |

**Output** — `structuredContent`: `{ workItemKey, items, progress }`. `items` is
in list order; each step is `{ id, position, text, notesMd, commandText,
executor, done, doneAt, doneBy }` (`doneBy` is `{ id, name }` or `null`).
`progress` is `{ done, total }`, counted from the same read as `items`. A card
with no steps answers `items: []` and `{ done: 0, total: 0 }`.

##### `add_work_item_todo`

| Input         | Type   | Required | Notes                                                                                         |
| ------------- | ------ | -------- | --------------------------------------------------------------------------------------------- |
| `key`         | string | yes      | Work item identifier.                                                                         |
| `text`        | string | yes      | The step, ONE operation, in plain text (not Markdown), at most 200 characters.                |
| `notesMd`     | string | no       | Instructions for this step (Markdown), at most 2000 characters.                               |
| `commandText` | string | no       | A command the step runs, at most 500 characters; the item page renders it with a copy button. |
| `executor`    | enum   | no       | `human` or `coding_agent`. Omitted ⇒ the card's own executor, or `human` when it has none.    |

**Output** — `structuredContent`: `{ workItemKey, todo, progress }` — the new
step (its `id` is what `set_work_item_todo_done` takes) and the list's progress
after the append. The step is always appended **last**; concurrent appends to
one card are serialized, so none of them lands on another's position.

Text over the cap is **refused, never truncated** — a step that long is two
steps:

| Code                    | Meaning                                                 |
| ----------------------- | ------------------------------------------------------- |
| `EMPTY_TODO_TEXT`       | `text` is empty once trimmed.                           |
| `TODO_TEXT_TOO_LONG`    | `text` is over 200 characters. Split it into two steps. |
| `TODO_NOTES_TOO_LONG`   | `notesMd` is over 2000 characters. That is a work item. |
| `TODO_COMMAND_TOO_LONG` | `commandText` is over 500 characters.                   |

##### `set_work_item_todo_done`

| Input    | Type    | Required | Notes                                                                 |
| -------- | ------- | -------- | --------------------------------------------------------------------- |
| `key`    | string  | yes      | Work item identifier.                                                 |
| `todoId` | string  | yes      | The step's `id`, from `list_work_item_todos` or `add_work_item_todo`. |
| `done`   | boolean | yes      | `true` ticks the step; `false` unticks it.                            |

**Output** — `structuredContent`: `{ workItemKey, todo, progress }` — the step as
it now stands and the list's progress, read in the same transaction as the tick.
A `todoId` that is not a step of **that** card — another card's step, or no step
at all — is `WORK_ITEM_TODO_NOT_FOUND`, and nothing changes.

##### `update_work_item_todo`

| Input         | Type           | Required | Notes                                                                 |
| ------------- | -------------- | -------- | --------------------------------------------------------------------- |
| `key`         | string         | yes      | Work item identifier.                                                 |
| `todoId`      | string         | yes      | The step's `id`, from `list_work_item_todos` or `add_work_item_todo`. |
| `text`        | string         | no       | The new step text, plain text, at most 200 characters.                |
| `notesMd`     | string \| null | no       | New instructions (Markdown), at most 2000 characters. `null` clears.  |
| `commandText` | string \| null | no       | New command, at most 500 characters. `null` clears.                   |
| `executor`    | enum \| null   | no       | `human` or `coding_agent`. `null` clears.                             |

**SPARSE:** a field you omit is left exactly as it was, so sending only `text`
never blanks the step's notes or command. **Output** — `structuredContent`:
`{ workItemKey, todo, progress }` — the step as it now stands. An edit records a
revision naming each field's before and after, as the item page's edit does; a
call that sends no field changes nothing and records nothing. The caps and their
codes are `add_work_item_todo`'s. A `todoId` that is not a step of **that** card
is `WORK_ITEM_TODO_NOT_FOUND`, and nothing changes.

##### `delete_work_item_todo`

| Input    | Type   | Required | Notes                                                                 |
| -------- | ------ | -------- | --------------------------------------------------------------------- |
| `key`    | string | yes      | Work item identifier.                                                 |
| `todoId` | string | yes      | The step's `id`, from `list_work_item_todos` or `add_work_item_todo`. |

**Output** — `structuredContent`: `{ workItemKey, removed: { id, text },
progress }` — what was removed, and the list's progress after it, whose
`total` has gone down by one. The delete is permanent and records a revision
naming the removed step, as the item page's delete does. Deleting the same step
again is `WORK_ITEM_TODO_NOT_FOUND` and changes nothing; so is a `todoId` that
is not a step of **that** card.

##### `move_work_item_todo`

| Input     | Type    | Required | Notes                                                                 |
| --------- | ------- | -------- | --------------------------------------------------------------------- |
| `key`     | string  | yes      | Work item identifier.                                                 |
| `todoId`  | string  | yes      | The step's `id`, from `list_work_item_todos` or `add_work_item_todo`. |
| `toIndex` | integer | yes      | Where the step goes: its 0-based position in the list after the move. |

**The destination is an INDEX, not a pair of neighbour ids.** It is read against
the list as the service has just locked it, in the order the step will land in
(the list without the moving step), and an index past either end is clamped to
that end, so `0` always means first and a large number always means last. That
is the same call the item page's drag makes. **Output** — `structuredContent`:
`{ workItemKey, todo, progress }` — the moved step (its `position` is the new
key) and the list's progress, which a move does not change. A move writes ONE
row and records a revision naming the step and its new index; moving a step to
where it already is records one too. A `todoId` that is not a step of **that**
card is `WORK_ITEM_TODO_NOT_FOUND`, and nothing changes.

| Code                       | Meaning                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `WORK_ITEM_TODO_NOT_FOUND` | The step is not on that card, or does not exist.                           |
| `TODO_REORDER_CONFLICT`    | The step was deleted while it was being moved. Re-read the list and retry. |

#### Repairing a red card — `claim_work_item_repair` · `touch_work_item_repair` · `close_work_item_repair`

A card whose run has ended can be left with a **red pull request** — failing
checks, a merge-queue ejection, a conflict — and the agent that opened it has
gone. `motir fix <key>` hands that pull request to ONE fixing agent through the
**repair claim** (`POST /api/v1/work-items/{key}/repair`, Story MOTIR-5460).
These three tools are the same claim for an agent working from its own chat
(Story MOTIR-6804): it takes the lock, keeps it while it works, and hands it back
with how the repair ended.

**The REST route and `motir fix` share ONE lock with these tools.** The lock is
an open dispatch run of command `fix` on the card; whichever door claims first
holds it, and a claim through the other door is answered `taken`, naming the
holder. The card's status and assignee are never written — the item page reads
it as _being fixed_ by the token's owner, and green checks move it on their own.

| Tool                     | Permission       | What it does                                                  |
| ------------------------ | ---------------- | ------------------------------------------------------------- |
| `claim_work_item_repair` | `work_item:edit` | Take the repair lock, and be handed the pull requests to fix. |
| `touch_work_item_repair` | `work_item:edit` | Keep your repair alive; learn if it was closed under you.     |
| `close_work_item_repair` | `work_item:edit` | End your repair with its outcome, releasing the lock.         |

**The order is claim → touch → close.** Call `touch_work_item_repair` **at least
every two minutes** while you work. A repair run is recorded as `origin: local` —
a person's own agent on their own machine — so the run-liveness rule applies to
it exactly as to the CLI's (`lib/runs/runLiveness.ts`): **a run silent for five
minutes is dead**, the card stops reading _being fixed_, and the liveness sweep
closes it (`stopReason: abandoned`). The claim itself counts as the first beat.
When a touch answers **`open: false`**, the lock is gone — by your own close, the
sweep, or anyone else — so **stop pushing**: a second fixer may already be on the
card. Claim again if you still need to work on it.

All three need permission to **edit the card**, the key the REST repair route
asserts; the claim also runs the CI-credit gate before it opens anything. Without
`work_item:edit` the claim is refused by name and no run opens. A card the token
cannot see, including one in another workspace, is `WORK_ITEM_NOT_FOUND`.

**Deliberately absent:** the run's per-attempt events (`ci_watch_*`,
`card_settled`) the CLI appends. An agent holding a repair needs the lock, its
liveness and its outcome.

##### `claim_work_item_repair`

| Input | Type   | Required | Notes                 |
| ----- | ------ | -------- | --------------------- |
| `key` | string | yes      | Work item identifier. |

**Output** — `structuredContent`: **exactly** what the REST route answers — the
`WorkItemRepairClaim` resource, through the same presenter: `{ key, title,
outcome, reason, runTargetKey, runId, holder, startedAt, repairClass,
acceptanceRefusal, pullRequests }`. Each pull request is `{ repo, number, url,
headRef, baseRef, ci, failingChecks, queueExit }`; fix it on **its own** branch
(`headRef`).

| `outcome`        | Meaning                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `claimed`        | The repair is yours: `runId` is your run, `pullRequests` what to fix.                     |
| `mine`           | You already hold it (the same `runId`) — a resume, not a lost race.                       |
| `taken`          | Somebody else is fixing it: `holder` and `startedAt` name them. Do not push.              |
| `not_repairable` | Nothing to repair; `reason` says why. With `repair_on_run_target`, repair `runTargetKey`. |

`reason` is one of `not_implemented`, `repair_on_run_target`, `no_pull_requests`,
`ci_running`, `not_failing`, `repair_not_code` — the REST route's refusals, in its
order. **A refusal is a result, not an error**, and changes nothing on the card.
`repairClass` is `ci`, or `acceptance_rerun` when the story's acceptance video was
sent back with **Re-run** (then `acceptanceRefusal` carries the reviewer's reason).

##### `touch_work_item_repair`

| Input   | Type   | Required | Notes                                          |
| ------- | ------ | -------- | ---------------------------------------------- |
| `key`   | string | yes      | Work item identifier.                          |
| `runId` | string | yes      | The `runId` `claim_work_item_repair` answered. |

**Output** — `structuredContent`: `{ key, runId, open, status, stopReason,
startedAt, endedAt, lastHeartbeatAt }`. `open: true` means the run is alive and
`lastHeartbeatAt` has moved to now; `open: false` carries how it ended
(`status`, `stopReason`) and was written by nothing — a touch never re-opens a
run. It writes no status and no event.

##### `close_work_item_repair`

| Input     | Type   | Required | Notes                                          |
| --------- | ------ | -------- | ---------------------------------------------- |
| `key`     | string | yes      | Work item identifier.                          |
| `runId`   | string | yes      | The `runId` `claim_work_item_repair` answered. |
| `outcome` | enum   | yes      | `green`, `gave_up`, `halted` or `interrupted`. |

`outcome` maps onto the run's stop reason as the CLI maps its own watch results:
`green` → `completed` (the run succeeded), `gave_up` and `halted` → `halted` (a
failed run, which the item page shows as _gave up_), `interrupted` →
`interrupted` (cancelled). **Output** — the same shape as the touch, now
`open: false`. **Idempotent:** closing a run that is already closed returns it
as it stands and changes nothing, so a retry after a timeout is safe. A new claim
is admitted once it is closed.

Touch and close accept only **your own** repair run of **that** card:

| Code                   | Meaning                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `REPAIR_RUN_NOT_FOUND` | `runId` is not a repair run of this card (or not in your workspace). Claim it. |
| `REPAIR_RUN_NOT_YOURS` | The card's repair run, opened by somebody else. Nothing was written.           |

#### Continuing a dead run — `claim_work_item_continue` · `touch_work_item_continue` · `close_work_item_continue`

A card whose run **died** — its agent stopped hearing back, crashed, or was
killed — keeps its status (In Progress) and its branch. `motir continue <key>`
hands that branch to ONE continuing agent through the **continue claim**
(`POST /api/v1/work-items/{key}/continue`, Story MOTIR-6526). These three tools
are the same claim for an agent working from its own chat (Story MOTIR-7261):
it takes the card over, keeps it while it works, and hands it back with how the
continue ended. The shape is the repair tools' above, for a different lock.

**The REST route and `motir continue` share ONE lock with these tools.** The lock
is an open dispatch run of command `continue` on the card; whichever door claims
first holds it, and a claim through the other door is answered `taken`, naming
the holder. The claim re-assigns the card to the token's owner — its one card
write — and never writes its status.

| Tool                       | Permission       | What it does                                                      |
| -------------------------- | ---------------- | ----------------------------------------------------------------- |
| `claim_work_item_continue` | `work_item:edit` | Take over a dead run's card, and be handed where its work stands. |
| `touch_work_item_continue` | `work_item:edit` | Keep your continue alive; learn if it was closed under you.       |
| `close_work_item_continue` | `work_item:edit` | End your continue with how it went, releasing the lock.           |

**The order is claim → `dispatch_prompt` → touch → close.** Pass the dead run's
id (`deadRun.id` from the claim) to `dispatch_prompt` as **`continueFrom`**, and
the prompt says how that run ended and where its branch and pull requests stand
— the same text the REST route answers for `?continueFrom=`. A run that is
unknown, still running or succeeded is refused with `CONTINUE_FROM_INVALID`, not
ignored. Then call `touch_work_item_continue` **at least every two minutes**
while you work: the run-liveness rule applies to a continue exactly as to the
CLI's (`lib/runs/runLiveness.ts`) — **a run silent for five minutes is dead**,
and the liveness sweep closes it (`stopReason: abandoned`), which leaves the card
continuable again by somebody else. The claim itself counts as the first beat.
When a touch answers **`open: false`**, the lock is gone, so **stop pushing**.

All three need permission to **edit the card**, the key the REST continue route
asserts. A card the token cannot see, including one in another workspace, is
`WORK_ITEM_NOT_FOUND`.

##### `claim_work_item_continue`

| Input | Type   | Required | Notes                 |
| ----- | ------ | -------- | --------------------- |
| `key` | string | yes      | Work item identifier. |

**Output** — `structuredContent`: **exactly** what the REST route answers — the
`WorkItemContinueClaim` resource, through the same presenter. `outcome` is
`claimed` (the card is yours: `runId` is your run), `mine` (you already hold it —
a resume), `taken` (somebody else is continuing it; do not push) or
`not_continuable`, with `reason` one of `run_alive`, `use_fix`,
`not_in_progress`, `continue_the_parent`, `no_dead_run`, `gate_awaiting`,
`gate_sent_back`, `no_branch` — the REST route's refusals, in its order. **A
refusal is a result, not an error**, and changes nothing on the card. With
`use_fix`, the card's pull request is open: `claim_work_item_repair` is the door.
With `continue_the_parent`, continue `parentKey` as a whole.

A run that **stopped at a gate** (closed `gated`) is not dead, but it is resumed
through this same claim once a gate it stopped on is approved (MOTIR-7708): the
answer is `claimed` with `resumesGated: true` and the approved `gates`, on the
gated run's own branch. While every gate still waits the answer is
`gate_awaiting`; when they were declined or overturned and none approved it is
`gate_sent_back`. Both name the `gates`. A gate answered **changes requested** is
decided and carries a reason, so it releases the run like an approval does
(MOTIR-9185): the claim succeeds, the `gates` include it with that state, and the
CONTINUE prompt tells the agent to read the reason and redo the work.

##### `touch_work_item_continue`

| Input   | Type   | Required | Notes                                            |
| ------- | ------ | -------- | ------------------------------------------------ |
| `key`   | string | yes      | Work item identifier.                            |
| `runId` | string | yes      | The `runId` `claim_work_item_continue` answered. |

**Output** — `structuredContent`: `{ key, runId, open, status, stopReason,
startedAt, endedAt, lastHeartbeatAt }`. `open: true` means the run is alive and
`lastHeartbeatAt` has moved to now; `open: false` carries how it ended. A touch
never re-opens a run, and writes no status and no event.

##### `close_work_item_continue`

| Input     | Type   | Required | Notes                                            |
| --------- | ------ | -------- | ------------------------------------------------ |
| `key`     | string | yes      | Work item identifier.                            |
| `runId`   | string | yes      | The `runId` `claim_work_item_continue` answered. |
| `outcome` | enum   | yes      | The stop reason the REST close body accepts.     |

`outcome` is the run's stop reason, the same set `POST
/api/v1/dispatch-runs/{id}/close` takes as `stopReason`: `completed` (the work is
done), `halted` (you gave up), `interrupted` (cancelled), and the rest of that
enum. **Output** — the same shape as the touch, now `open: false`.
**Idempotent:** closing a run that is already closed returns it as it stands and
changes nothing, so a retry after a timeout is safe.

Touch and close accept only **your own** continue run of **that** card (the card
itself, or the parent whose continue it is a leg of):

| Code                     | Meaning                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `CONTINUE_RUN_NOT_FOUND` | `runId` is not a continue run of this card (or not in your workspace). Claim it. |
| `CONTINUE_RUN_NOT_YOURS` | The card's continue run, opened by somebody else. Nothing was written.           |

#### Reporting your own run — `start_work_item_run` · `report_action` · `close_work_item_run`

An agent that runs a card **without** `motir run` around it — the Motir skill in
Claude Code, Codex, Kimi, any agent that speaks MCP — reports its own run with
these three tools (Story MOTIR-7446, `docs/decisions/agent-reported-runs.md`). The
run shows on **Runs**, in the run modal and in the card's run section exactly as a
`motir run` does: who ran it, the harness and model, each step, and how long it
took. A delivered close records the harness and model as the card's implementer.

| Tool                  | Permission       | What it does                                                        |
| --------------------- | ---------------- | ------------------------------------------------------------------- |
| `start_work_item_run` | `work_item:edit` | Open your run of a card you hold, naming your harness and model.    |
| `report_action`       | `work_item:edit` | Say the step you are about to take; send a milestone; or heartbeat. |
| `close_work_item_run` | `work_item:edit` | End your run with how it went, on every exit, delivered or not.     |

**The order is claim → start → report before every step → close.** A run is
opened **over a claim, never instead of one**: claim the card with
`claim_work_item` first. Then call `report_action` with the card's `key` and a
one-line `action` **before every step** — "Reading the run service", "Running the
targeted tests" — and `close_work_item_run` on **every** exit path, including a
failure or an interruption. An action is one line of at most 500 characters:
**never a transcript, a diff, file contents, a prompt or a secret.**

**Liveness — every Motir call is a heartbeat.** An agent-reported run is alive
while its agent is heard from, and **a run silent for 60 minutes is closed** for
it (`stopReason: abandoned`, ended at its **last** heartbeat, so its duration is
the time it actually worked). The agent does not have to remember a heartbeat:
**every Motir MCP tool call it makes** — reading its card, linking a pull request,
moving a status — refreshes its open agent-reported runs after the call is
answered. A call never fails because of it. `report_action` with **no arguments**
is an explicit heartbeat. (A `motir run` keeps its own 5-minute window and beats
from its own timer.)

##### `start_work_item_run`

| Input     | Type   | Required | Notes                                                               |
| --------- | ------ | -------- | ------------------------------------------------------------------- |
| `key`     | string | yes      | The card you hold.                                                  |
| `harness` | string | yes      | The agent harness you are, as its makers name it (`"Claude Code"`). |
| `model`   | string | no       | The model id you run on. Omit it when you do not know it.           |

A **leaf** opens one run with one leg. A **parent** opens ONE run whose legs are
its children that are not done, and you must hold every one of them. **Output** —
`{ outcome, key, runId, reportedBy, legs: [{ key, title }] }`. `outcome` is
`started`, or `mine` when you already have an open run on this card (a retried
call, a resumed session, or the `motir run` you are inside) — that run is
answered, never a second one. **`not_claimed` is a result, not an error:** it
names the card you do not hold in `offenderKey` and writes nothing.

##### `report_action`

| Input    | Type   | Required             | Notes                                                                     |
| -------- | ------ | -------------------- | ------------------------------------------------------------------------- |
| `key`    | string | with `action`/events | The card the step is on: the run's card, or a child in a parent run.      |
| `action` | string | no                   | The step you are about to take, one line, ≤ 500 characters.               |
| `events` | array  | no                   | Milestones: `{ kind, data?, disposition?, skipReason?, sessionBranch? }`. |

The run is found from the card and you, so the same call works in a run you
started and **inside a `motir run` or hosted run** (where it records the step and
the runner writes everything else). In a run you started you may send four
milestone kinds: `checkout_ready` (put `{ branch }` in `data`), `delivery_linked`,
`leg_verdict` and `card_settled`. **Any other kind is refused by name while the
rest of the batch is stored.** Every event is stored as reported by the agent.
**A milestone's `disposition` is what moves your card's leg** on the run: send
`running` with `checkout_ready`, and the leg's end (`implemented`, or `failed`)
with `card_settled` before you close. A leg nobody moved reads _Not reached_ once
the run closes, whatever the card's own status says.
**Output** — `{ outcome, runId, accepted, refused: [{ kind, reason }] }` (plus
`seq` when it wrote, and `touched` for a heartbeat). `outcome` is `reported`,
`heartbeat`, `refused` (every event was refused and there was no step), or
**`no_open_run`** — a result telling you to call `start_work_item_run`, which
writes nothing.

##### `close_work_item_run`

| Input     | Type   | Required | Notes                                                                         |
| --------- | ------ | -------- | ----------------------------------------------------------------------------- |
| `key`     | string | yes      | The card you started the run on.                                              |
| `runId`   | string | yes      | The `runId` `start_work_item_run` answered.                                   |
| `outcome` | enum   | yes      | `completed`, `drained`, `max`, `halted`, `interrupted`, `replanned`, `gated`. |

`abandoned` is refused: only the 60-minute reap writes it. **`gated`** is the
outcome for a run that stopped because its remaining work waits on an approval
gate — a design, decision, choice, confirmation or manual card not yet decided —
and such a stop is **never `halted`** (`halted` reads as _Run died_). Motir
records which gates held the run itself, from the awaiting gates on the run's
cards (MOTIR-7703); you name none. A **`completed`** or
**`drained`** close records your harness and model as the implementer of every
leg card the run took to Implemented or later, and answers those keys in
`stamped`; any other outcome stamps nothing. **No outcome changes a card's
status** — your pull request and `transition_status` do that. **Output** —
`{ closed: true, alreadyClosed, runId, status, stopReason, endedAt, stamped }`.
**Idempotent:** closing a run that is already closed, by you or by the reap,
answers it as it stands with `alreadyClosed: true` and writes nothing.

| Code                               | Meaning                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `AGENT_RUN_NOT_YOURS`              | Somebody else opened this run; only its opener may close it.                        |
| `DISPATCH_RUN_NOT_FOUND`           | `runId` is not your agent-reported run on this card.                                |
| `AGENT_RUN_EVENT_KIND_NOT_ALLOWED` | A milestone sent into a runner's run — the runner writes those; send `action` only. |
| `AGENT_RUN_REPORT_INVALID`         | An empty or over-long `action`, `action`/`events` without `key`, or `abandoned`.    |

#### `add_lesson`

Record a **lesson** for a project — something that went wrong when planning it
and will go wrong again — so later plans for that project are given the lesson
before they are drafted. Write it as a standing instruction to a future planner,
not as a report about what just happened.

The store lives in motir-ai and is reached over the 7.1 boundary. The lesson is
bound to the acting project: it is never shared with another project, and there
is **no argument through which a caller can create a global lesson** — the
corpus every project reads is Motir's own and is curated through migrations.

The four routing axes (`kinds` / `types` / `phases` / `subject`) decide which
later plans are shown it. **An omitted axis means "everything on that axis"**,
which is occasionally right and usually the reason a lesson turns up where it
does not belong — so leaving one out is a decision to make, not a field to skip.

⚠️ **`subject` is SCALAR where the other three are sets** — a lesson carries one
subject or none, never a list, and a payload sending several is **refused rather
than coerced** (a card wanting two subjects is a split signal, so a lesson
captured from one cannot inherit a multiplicity its source never had). A lesson
that genuinely applies across subjects carries **none**: it is more general than
either, which is what omitting the axis says. Its membership is **not validated**
— the vocabulary is the rule-pack file set, so a well-formed unrecognised member
is accepted and simply never matches a subject-narrowed query.

**Do not add one** for a one-off that will not recur, for something an existing
lesson already covers (read the project's lessons first), or for a product
defect — that is a bug report. A **near-duplicate is refused**, and the refusal
names the lesson that already covers it so the caller can reword or retire it.

Not to be confused with motir-ai's internal `log_planning_mistake`, which the
planner calls during a run.

| Input         | Type     | Required | Notes                                                                                                                                                                                              |
| ------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectKey`  | string   | yes      | The project the lesson belongs to.                                                                                                                                                                 |
| `title`       | string   | yes      | The takeaway in one line — what to do differently, not a headline for an incident.                                                                                                                 |
| `body`        | string   | yes      | What goes wrong, stated so it is recognisable next time.                                                                                                                                           |
| `why`         | string   | yes      | Why it matters. The one field that may carry your own specifics.                                                                                                                                   |
| `howToApply`  | string   | yes      | The actionable rule, in the second person, addressed to a future planner.                                                                                                                          |
| `mistakeType` | enum     | no       | `regular_planning` (default) · `onboarding_planning` · `planning_craft`.                                                                                                                           |
| `kinds`       | string[] | no       | `project` · `onboarding` · `epic` · `story` · `task` · `bug` · `subtask` — every LAY TARGET (MOTIR-5622): a mistake made laying a level is filed under the level laid under. Omitted = every kind. |
| `types`       | string[] | no       | The work-type vocabulary (`code`, `design`, …). Omitted = every type.                                                                                                                              |
| `phases`      | string[] | no       | `lay` · `author`. Omitted = both. (`skeleton` · `deepen` still accepted.)                                                                                                                          |
| `subject`     | string   | no       | **SCALAR, not a list.** Which subject matter. Omitted = every subject.                                                                                                                             |
| `sourceRef`   | string   | no       | Provenance, and the idempotency key — a repeat returns the existing lesson.                                                                                                                        |

Requires the lesson-library-change permission (`lesson:manage`) — the same key
retiring a lesson takes, checked **before** any call to motir-ai.

#### `search_lessons`

READ the recorded **lessons** by MEANING — the read half of the pair `add_lesson`
opens. You get the **shared corpus AND this project's own lessons in one answer**,
because a caller about to act should be taught by both and it does not matter
which of the two a past mistake happens to be recorded in. (This is deliberately
wider than the AI-planning settings surface, which shows a project only its own
library — a customer's screen is not the place for the product's corpus.)

**Two steps, and the second decides what you get.** The three routing axes
(`kinds` / `types` / `phases`) choose the candidate **pool**; the `query` text
then chooses **which few arrive**:

```
WHERE  … kinds/types/phases overlap …      ← chooses the candidate POOL
ORDER BY "embedding" <=> query ASC         ← chooses which few arrive
LIMIT  n
```

So a vague query returns `n` near-arbitrary rows out of a correctly-filtered
slice — which reads as the mechanism working while it hands back noise. **Narrow
by axis, THEN ask a real question.** An omitted axis is unconstrained, which is
often the right answer here: a lesson tagged with no kind reaches every query
either way.

**Write the query in TAKEAWAY register.** A lesson is stored as _"a count taken
from a working tree is not a property of the ref"_, never as _"board filter at
scale"_. Describe the action you are about to take and the shape of what could go
wrong; a card title ranks against the wrong words.

**It returns PROSE**, unlike `search_work_items_semantic`, which returns keys and
scores and tells you to read each candidate through `get_work_item`. That rule
governs claims _about the product_, which must trace to a keyed read. A lesson
makes no claim about the product — it is guidance written to be read, and the
same rows already reach the hosted planner as prose by injection.

⚠️ **An empty result is not one thing.** Read `outcome`:

| `outcome`         | What it means                                                           |
| ----------------- | ----------------------------------------------------------------------- |
| `matched`         | Lessons came back, nearest first.                                       |
| `nothing-matched` | The corpus WAS searched and has nothing. A normal answer — proceed.     |
| `unavailable`     | The corpus could NOT be reached. **Not** evidence that nothing applies. |

The last two both carry an empty `lessons`, and treating `unavailable` as
`nothing-matched` is a search that reports "nothing exists" truthfully and
wrongly.

| Input        | Type     | Required | Notes                                                                                                                              |
| ------------ | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `projectKey` | string   | yes      | The project whose lessons join the shared corpus in the answer.                                                                    |
| `query`      | string   | yes      | The question, in takeaway register — the action and the risk shape.                                                                |
| `kinds`      | string[] | no       | `project` · `onboarding` · `epic` · `story` · `task` · `bug` · `subtask` — every LAY TARGET (MOTIR-5622). Omitted = unconstrained. |
| `types`      | string[] | no       | The work-type vocabulary (`code`, `design`, …). Omitted = unconstrained.                                                           |
| `phases`     | string[] | no       | `lay` · `author`. Omitted = unconstrained. (Old spellings still taken.)                                                            |
| `limit`      | number   | no       | How many to return, nearest first. Default 8, max 50.                                                                              |

**Output** — each lesson's `title`, `body`, `howToApply`, its `scope`
(`global` / `tenant`), the axes it is tagged on, and its cosine `distance`.

⚠️ **Costs an AI call**: the query is embedded through Motir's AI backend and
draws the same per-minute allowance as the planning chat, so do not call it in a
tight loop. Requires the lesson-read permission (`lesson:view`) — the READ key,
not `lesson:manage` — checked **before** any call to motir-ai.

**Output** — `structuredContent`: the recorded lesson's `id`, `title`, its three
axes as stored, and `sourceRef`.

#### `link_pull_request`

Declare **which work item a pull request belongs to** — called immediately after
opening one, once per pull request. The caller is the first party that knows the
answer with certainty, and it knows it before GitHub's own webhook does.

**Why this exists.** Until this tool, an executing agent could only put
`MOTIR-<n>` in the branch or the title and hope the sync's own resolver parsed it
back out. That guess failed in both directions, and both were measured on live
cards: a title that DROPS the key is invisible to the completion gate, so a card
is held open by work that has already shipped; a title that merely MENTIONS one
closes that card whether or not the pull request delivered it.

⚠️ **THE PARSE IS RETIRED** (MOTIR-3674, story MOTIR-3672). This paragraph used
to say the parse remained the FALLBACK for a pull request opened outside a run —
by a person, by Dependabot, by a script — where a guess was the only thing
available and was a reasonable one. That conservatism is what MOTIR-3672
revisited: a parse is not a weaker link, it answers a DIFFERENT question (_this
text mentions this card_, not _this pull request delivers this card_), and
keeping it as a fallback kept the wrong answer available on exactly the path
nobody watches. An explicit link is now the ONLY association a pull request has,
at both call sites — the live delivery and the historical backfill — and a pull
request nobody links carries a FAILING CHECK rather than a silent guess
(`docs/decisions/unlinked-pull-request-check.md`). A link already stored by the
retired parse is HONOURED, not orphaned: every one of the 1096 stored links was
carried into `work_item_delivery` by MOTIR-3657's backfill, which is why
MOTIR-3757 could drop the column without losing one. The link is a stored fact
and the sync reads nothing else, so a merge moves the card whether or not any
title ever named it.

⚠️ **It writes ONE link, and the link is a SET.** The call inserts a row in
`work_item_delivery`, a join table recording every `(work item, pull request)`
pair. One pull request may fill it for **several** work items — the shape a
`motir auto` or parent run actually produces — and one work item may be filled by
several pull requests. A second call naming a DIFFERENT work item therefore
**ADDS** a row; it takes nothing off the first, and nothing is unlinked except by
`unlink_pull_request`. The Development panel lists that set.

> **ONE pull request delivering a parent and its children can be declared either
> way.** Link the PARENT once and the merge cascades DOWN to the children on its
> own (`childStatusCascadeService`); or link each card the pull request actually
> delivers and the merge closes all of them, because the completion gate and the
> status sync read the delivery set. Linking the parent is the shorter of the two
> and stays correct as children are added.

⚠️ **THIS PARAGRAPH USED TO SAY THE OPPOSITE, and the reversal is the point.**
Until MOTIR-3721 / MOTIR-3757 the association a work item carried was a single
`github_pull_request.work_item_id`, the readers decided on it, and linking the
children in turn walked that one column down the chain — the merge closed
whichever card the last call landed on and stranded every sibling at
`implemented`. That is why the instruction was _link the PARENT, once_ as a rule
rather than as a preference. The readers moved to the delivery table
(MOTIR-3721 · MOTIR-3756), the column was dropped (MOTIR-3757), and with it the
`movedFrom` field a link result used to carry. A reader who remembers the old
rule is not reading a stale copy: it was true, and it is not any more. See ADR
`docs/decisions/delivery-reader-migration.md`.

> **⚠️ AMENDED 2026-08-28 (MOTIR-3735) — ONE scalar is dropped, not two.**
> `github_pull_request.work_item_id` is the one that goes; its readers and its
> drop are scoped by `docs/decisions/delivery-reader-migration.md` (MOTIR-3721 was
> re-scoped to EXPAND-1 and drops nothing itself). **`work_item.session_branch`
> is KEPT** — it answers a readiness question in the window BEFORE a pull request
> exists, where a delivery row cannot exist at all
> (`work_item_delivery.github_pull_request_id` is NOT NULL), so the readers that
> decide whether a session run can proceed cannot move onto the table. See
> `docs/decisions/session-branch-lineage.md`. `mark_integrated` keeps its
> `sessionBranch` argument.

⚠️ **A pull request nobody links carries a FAILING CHECK.** Since MOTIR-3674 the
title and the branch link nothing, so the absence of a link is the whole failure
mode — and it is a quiet one: a card whose pull request merged and which nobody
moved looks exactly like a card whose work never started. Motir therefore writes a
check run named **`Motir / work item link`** on every pull request in a repository
it plans work in, failing while the pull request is unlinked and turning green on
this call — not on the next push, which is what makes linking an actual remedy
rather than an instruction to go and push something.

Four kinds of pull request are exempt, stated as rules rather than as a list:
a **bot** author (`user.type === "Bot"` — Dependabot, renovate, and whatever is
installed next), a **draft** until it is marked ready for review, a repository
**connected but not bound to a project**, and any pull request carrying the
**`no-work-item`** label — the declared hatch, usable by anyone who can push.
Whether the failing check BLOCKS a merge is the repository's own
branch-protection setting and never Motir's.
`docs/decisions/unlinked-pull-request-check.md` records why, and what it costs.

⚠️ **It works BEFORE any webhook delivery** — that is the case it exists for. The
detail page's "+ Link pull request" picker can only choose a pull request Motir
has already ingested, and addresses it by an internal id an agent has never seen.
This tool addresses the pull request the way GitHub does, by **repository +
number**, and writes the row when there is none yet. So the two arms are
deliberately asymmetric:

| state when called | what is written                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| **no row yet**    | the row, from your `headRef` / `baseRef` / `title`, `state: "open"`, `merged: false`, plus the link (`created: true`) |
| **a row already** | **only** the link — your ref/title arguments are ignored, because a delivery has already spoken for those fields      |

The division of authority is what keeps the two from fighting: **you are
authoritative about the LINK, the webhook is authoritative about STATE.** They no
longer need a boundary marker, because they write different tables: a later
delivery refreshes `state` / `merged` / `headRef` / `baseRef` / `title` on the
pull-request row and reaches no delivery link at all.

Put the key in the BRANCH anyway: a human reads a branch list, and the
design-result publisher finds its card from any resolvable key in the ref. It is
a label now, not the mechanism.

| Input        | Type   | Required | Notes                                                                                  |
| ------------ | ------ | -------- | -------------------------------------------------------------------------------------- |
| `key`        | string | yes      | Work item identifier.                                                                  |
| `url`        | string | \*       | The full pull-request URL — the line `gh pr create` prints, passed through verbatim.   |
| `repository` | string | \*       | `"owner/name"` as the repository is connected (case-insensitive). Goes with `number`.  |
| `number`     | number | \*       | The pull-request number. Goes with `repository`.                                       |
| `headRef`    | string | yes      | The branch the pull request is FROM. Seeds the row when there is none; else ignored.   |
| `baseRef`    | string | yes      | The branch it TARGETS. Same rule.                                                      |
| `title`      | string | no       | Its title, for the row this call may create. The first delivery supplies the real one. |

\* Address the pull request **either** with `url` **or** with `repository` +
`number` — not neither. Both forms are accepted, and if both are given they must
AGREE: a disagreement is refused (`INVALID_PULL_REQUEST_REF`) rather than
resolved by preferring one, because picking arbitrarily would link a real pull
request that is not the one the caller meant, under a success message.

**Output** — `structuredContent`: `key`, `created` (the row existed only because
this call wrote it), and `pullRequest` — the same `LinkedPullRequestDto` the item
page's Development section renders. (`movedFrom` was removed by MOTIR-3757 along
with the column whose move it reported; a link adds, so there is no move.)

An unknown **repository** or another organisation's (`GITHUB_REPO_NOT_FOUND`)
and an unknown item key are all refused with no existence leak. The repository
is resolved from the repo row, never through its installation (MOTIR-1931), so a
repository Motir created resolves like any other — and across the caller's
ORGANISATION, not its workspace (MOTIR-5188): a repository is connected once, to
the organisation, so every workspace of it can link a pull request on it. The
same resolution backs `unlink_pull_request`.

Requires the work-item edit permission (`work_item:edit`) — linking a pull
request to a card is editing that card. It is already in the CLI's fixed grant,
so a dispatched agent can call it.

#### `unlink_pull_request`

**Undo ONE `link_pull_request`** — remove the delivery recorded between this work
item and this pull request. It is the correction door, and nothing else is.

**Why re-linking is not a correction.** While the association was a single FK, a
mis-link fixed itself: linking the pull request to the right card MOVED the column
and the wrong association ceased to exist, because there was only ever one. A
delivery is a ROW. Linking the right card ADDS a second row and leaves the
mistaken one exactly where it was — and the completion gate counts a card's
delivering pull requests, so that row holds the card open on a pull request that
will never merge for it. Nothing in a link result signals this, and since
MOTIR-3757 there is not even a `movedFrom` to misread as one: the only thing that
removes a delivery is this tool.

⚠️ **It removes EXACTLY ONE delivery — the pair you name**, which is what makes it
a correction rather than a retraction:

- every OTHER card the same pull request delivers keeps its own delivery — a
  session pull request carrying twelve cards loses one and still delivers eleven;
- this card keeps every other pull request that delivers it — unlinking one
  repository of a multi-repo card does not retract the others.

⚠️ **An unknown repository or number is REFUSED, not answered as a no-op.** A typo
in the coordinate and a link that was never there are opposite facts, and reporting
the first as a successful nothing lets a caller believe a mis-link was corrected
while it stands. `removed: false` is reserved for the benign case: the pull request
exists, the item exists, and they were simply not linked — a retry, or a correction
somebody else already made.

It leaves the pull-request row itself alone: state, title and checks are the
webhook's to say, and there is no association stored on that row for this tool to
clear (MOTIR-3757 dropped the last one).

| Input        | Type   | Required | Notes                                                                                 |
| ------------ | ------ | -------- | ------------------------------------------------------------------------------------- |
| `key`        | string | yes      | Work item identifier.                                                                 |
| `url`        | string | \*       | The full pull-request URL.                                                            |
| `repository` | string | \*       | `"owner/name"` as the repository is connected (case-insensitive). Goes with `number`. |
| `number`     | number | \*       | The pull-request number. Goes with `repository`.                                      |

\* The same two address forms `link_pull_request` takes, cross-checked the same
way: give `url`, or `repository` + `number`, and if both are given they must AGREE
(`INVALID_PULL_REQUEST_REF`).

**Output** — `structuredContent`: `key`, `removed` (whether a row was actually
taken out), and `pullRequest` — the `owner/name#number` coordinate you addressed.

Requires the work-item edit permission (`work_item:edit`) — **the same key
`link_pull_request` asserts**, deliberately: undoing a link is editing the card the
link was made against, and a correction door a token cannot reach while it can
reach the door that creates the mistake would be worse than no door at all. It is
already in the CLI's fixed grant.

#### `attach_file`

Put a **file on a work item** — so a reader sees the deliverable on the card
instead of hunting for a pull request. Use it for a deliverable that has no home
of its own: a `research` card's findings document, a `review`'s notes, a
`verification`'s evidence.

The **repository stays the source of truth** for anything that also lives in one.
The attachment is the card's view of that file, never a second home for it.

⚠️ **Not for a design asset.** A design result has its own publisher
(`publish_design_result`, below) and its own panel on the work item, and
`text/html` is refused here — the three layers that
make HTML safe to serve belong to that lifecycle. The rule, in the form a prompt
author can act on: _a deliverable a LIFECYCLE owns goes through that lifecycle's
publisher; everything else goes through this tool. If you are unsure, the test is
whether a dedicated panel exists for it._ (`docs/decisions/attachment-api-door.md` §3.)

Bytes arrive base64-encoded because MCP carries JSON, not multipart — the
transport's constraint, not a second upload path. A payload that is not valid
base64 is refused rather than salvaged: `Buffer.from(s, 'base64')` discards
characters outside the alphabet instead of failing, so an unchecked decode would
attach garbage that only fails when a human opens it.

| Input           | Type   | Required | Notes                                                              |
| --------------- | ------ | -------- | ------------------------------------------------------------------ |
| `key`           | string | yes      | Work item identifier, e.g. `"ACME-7"`.                             |
| `filename`      | string | yes      | The name a reader sees, e.g. `"findings.md"`.                      |
| `contentType`   | string | yes      | Media type. Must be on the upload allowlist; `text/html` is a 415. |
| `contentBase64` | string | yes      | The file's bytes, base64-encoded.                                  |

**Output** — `structuredContent`: the created attachment — `id`, `workItemKey`,
`filename`, `mimeType`, `sizeBytes`, `source`, `contentPath`, `uploader`,
`createdAt`. `source` is `api` for anything through this tool or the equivalent
`/api/v1` route: it records the DOOR, not the actor, because Motir cannot
distinguish an agent from a person holding a token. The row appears in the work
item's ordinary attachments panel, attributed to the token owner — the same
component, with no special treatment.

**Refusals** — every one comes from the shipped attachment service, so this tool
and the browser upload answer one rule with one status: a file over the
organization's per-file limit, a media type off the allowlist, an exhausted
per-user upload budget, the organization's total storage cap, and a work item the
token cannot reach (indistinguishable from one that does not exist). The size and
type limits are defined once, in `lib/blob/allowlist.ts` and the plan
entitlements — this page deliberately quotes no number that would drift.

**Permission** — `work_item:edit`. Attaching a file to a card is editing that
card, and this is a permission the token `motir auth login` mints **does** carry,
so a dispatched run can call it. (Worth checking for any tool you write: a
permission outside that grant produces a tool that works perfectly for an
interactive operator and not at all for the agent it was built for.)

#### `publish_design_result`

Put the **design result on a design work item** — WHAT TO REVIEW: the
`*.mock.html` mock(s) and the area's `design-notes.md` as the one `note_file`,
which the result shows as a link, in ONE call. For a change to an existing design
the mock is the NEW delta mock (`<surface>--<change>.mock.html`) only.
**No `.png` and no `noteMd`** — both are retired and refused by name
(`docs/decisions/design-result.md` AMENDMENT 4).

⚠️ **Publish ONLY when work waits on the design.** The call is refused
(`DESIGN_EVIDENCE_NOTHING_WAITS`) unless at least one work item that is not
archived and not in the `done` category is `blocked_by` the design card — read at
`create_design_upload` and again inside the publish transaction. A publish raises
an approval gate, and a gate is only worth a person's time when work is held up by
its answer; a design nothing waits on is reviewed on its pull request.

⚠️ **A done design card is CLOSED.** A design card whose status is in the `done`
category — `cancelled` included — accepts no new version: the publish, the
`create_design_upload` mint and the HTTP withdrawal are all refused with
`DESIGN_CARD_CLOSED` (409), read off the card's status inside the publish
transaction. To change an approved design, reopen the card by hand, or propose a
new design card beside the card that needs it, `relates_to` this one
(`docs/decisions/approval-gates.md` §6c second amendment).

⚠️ **When work does wait, nothing else publishes it.** There is no CI lane, no
check and no background job behind this call. A design card that something is
`blocked_by`, that commits its two files and never makes it looks _identical_ to
one that succeeded — files written, commit landed, pull
request open, checks green, and an empty panel. **The confirmation is the
evidence `id` this call returns.**

The **repository stays the source of truth**. The published result is the card's
VIEW of assets that are still committed, never a replacement for them, and
`sourcePath` is what records where each published copy came from.

⚠️ **It replaced a CI script, and the reason is worth one paragraph** because it
is the argument for declaring rather than inferring. Until MOTIR-3797 the
publisher was `scripts/upload-design-assets.mjs`, which resolved its target card
from the branch ref and then the pull-request title, and its file set from a
diff. Two consequences: a pull request that touched `design/**` in passing
published those assets onto whichever card its own branch happened to name,
under a green check; and the script had to BE PRESENT in whatever repository the
design landed in — met in one of four, with a SHA-pinned copy in a second and a
seventeen-day-stale fork in a third. **A stale copy is green**: nothing imports
it, nothing type-checks it, no check compares it to anything. The three
inferences are now three declarations, and the file is in no repository at all.
`docs/decisions/design-result.md` AMENDMENT 2 is the record.

| Input             | Type   | Required | Notes                                                                                                                       |
| ----------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `key`             | string | yes      | The work item this result belongs to, e.g. `"ACME-7"`. A LEAF — see the refusals.                                           |
| `assets`          | array  | yes      | One or more `mock` and exactly one `note_file`; each entry is the object below.                                             |
| `noteMd`          | string | no       | **RETIRED — refused if present** (`DESIGN_EVIDENCE_NOTE_MD_RETIRED`). Kept in the schema only so it is refused by name.     |
| `commitSha`       | string | no       | The commit the assets were published from. Also the **idempotency key**.                                                    |
| `producedByKey`   | string | no       | The work item whose pull request produced this result.                                                                      |
| `withinParentKey` | string | no       | On a PARENT-RUN publish: the container whose branch this belongs to. Asserts the target is one of its children; not stored. |

Each `assets[]` entry:

| Field           | Type   | Required             | Notes                                                                                                                          |
| --------------- | ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `kind`          | string | yes                  | `"mock"` for a `*.mock.html`, `"note_file"` for the area's notes file. `"image"` is RETIRED and refused.                       |
| `sourcePath`    | string | yes                  | The path the file has IN THE REPOSITORY, e.g. `"design/work-items/detail.mock.html"`.                                          |
| `contentType`   | string | with `contentBase64` | `text/html` or `text/markdown`. Anything else is refused. Omit it with `pathname` — the STORE's answer is authoritative there. |
| `contentBase64` | string | one of two           | The file's bytes, base64-encoded — the INLINE form, for a small file.                                                          |
| `pathname`      | string | one of two           | The `pathname` of a `create_design_upload` grant you have already PUT this file to.                                            |

⚠️ **Each asset carries `contentBase64` OR `pathname`, and one publish uses one
form for ALL of its assets.** Both, neither, or a mix are refused by name
(`AMBIGUOUS_ASSET_SOURCE` / `MISSING_ASSET_SOURCE` / `MIXED_ASSET_SOURCES`) —
the two forms reach two different service methods, so reconciling them here
would make the tool the one place that decides how a design result is assembled.
Minting a grant for every asset is one extra call and costs nothing.

**The schema still lists three kinds** (`mock` / `image` / `note_file`), mirroring
the `design_asset_kind` column, because stored results published before
AMENDMENT 4 carry `image` rows. A NEW publish uses two: `mock` (one or more) and
`note_file` (exactly one). `image` stays in the schema so a caller still sending a
`.png` is told `DESIGN_EVIDENCE_IMAGE_RETIRED` rather than a generic validation
error.

⚠️ **`text/html` has exactly ONE entrance and this is it.** A design mock is HTML
rendered to a signed-in user, so its safety rests on the design-asset allowlist
being reachable through this path and nowhere else. `attach_file` still refuses
`text/html` with a 415, and that refusal stays correct
(`docs/decisions/design-result.md` §5, `docs/decisions/attachment-api-door.md` §3).

Bytes arrive base64-encoded because MCP carries JSON, not multipart. A payload
that is not valid base64 is **refused rather than salvaged**: `Buffer.from(s,
'base64')` discards characters outside the alphabet instead of failing, so an
unchecked decode would publish a corrupt mock under a real evidence id that only
fails when a reviewer opens the panel. The refusal names WHICH asset, so a
several-asset publish does not have to be bisected.

**Output** — `structuredContent`: `id` (the evidence id — quote it on the card),
`workItemKey`, `assetCount`, `noteTruncated` (always `false` for a new publish;
kept so the payload shape does not change), `createdAt`.

**Refusals** — every one comes from the shipped design-evidence service, so this
tool and the HTTP publish route answer one rule:

| Refusal                                                                   | When                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_BASE64`                                                          | An asset's `contentBase64` is not valid base64. Names the `sourcePath`.                                                                                                   |
| `DESIGN_EVIDENCE_IMAGE_RETIRED` (422)                                     | An asset of kind `image`. A design result carries no screenshot. Names the `sourcePath`.                                                                                  |
| `DESIGN_EVIDENCE_NOTE_MD_RETIRED` (422)                                   | `noteMd` is present, empty or not. Publish the notes file as the `note_file`; the result links to it.                                                                     |
| `DESIGN_EVIDENCE_MOCK_REQUIRED` (422)                                     | No `mock` asset.                                                                                                                                                          |
| `DESIGN_EVIDENCE_NOTE_FILE_REQUIRED` (422)                                | Zero, or more than one, `note_file` asset.                                                                                                                                |
| `DESIGN_EVIDENCE_NOTHING_WAITS` (409)                                     | No open (not archived, not `done`-category) work item is `blocked_by` the card. Its pull request is its review.                                                           |
| `DESIGN_CARD_CLOSED` (409)                                                | The design card itself is in the `done` category (`cancelled` included). Reopen it by hand, or propose a new design card beside the card that needs it.                   |
| container target                                                          | `key` names an epic / story / task with children. A design result belongs to the LEAF that produced it.                                                                   |
| not a child                                                               | `withinParentKey` is given and `key` is not one of that container's children. One transposed digit once addressed 126 artifacts to a manual billing task in another epic. |
| disallowed media type                                                     | A `contentType` outside the design-asset allowlist.                                                                                                                       |
| oversize file                                                             | An asset over the per-file upload cap.                                                                                                                                    |
| `AMBIGUOUS_ASSET_SOURCE` · `MISSING_ASSET_SOURCE` · `MIXED_ASSET_SOURCES` | An asset carries both forms, neither, or the publish mixes them. Names the `sourcePath`.                                                                                  |
| unknown / cross-workspace `key`                                           | A 404, indistinguishable from a work item the token cannot reach.                                                                                                         |

**Permission** — `work_item:edit`. The same key `attach_file` asserts, and one
the token `motir auth login` mints **does** carry — so a dispatched run can
actually call it. Moving the publish from CI to the agent therefore added no
credential and no trust; it only stopped requiring a script to be present in the
repository.

#### `create_design_upload`

**STEP 1 OF 2 for a design asset that is too large to send inline.** Mints a
short-lived (~5 min) presigned PUT per file, each bound to one exact object and
one media type; you PUT the bytes straight to the store and then name the
`pathname` in `publish_design_result`. Same target rules as the publish (a LEAF,
and `withinParentKey` asserts the child relationship), same design-asset
allowlist, same per-file cap — it is the same service call the CI-authed HTTP
mint route makes. It refuses an `image` grant (`DESIGN_EVIDENCE_IMAGE_RETIRED`)
a card no open work item is `blocked_by` (`DESIGN_EVIDENCE_NOTHING_WAITS`) and a
done design card (`DESIGN_CARD_CLOSED`) **before** any bytes move; the mock / note-file count is a property of the whole
publish and is checked there.

**WHICH DOOR AT WHICH SIZE — and the second limit is the binding one.**

| the asset                               | the door                                               |
| --------------------------------------- | ------------------------------------------------------ |
| a note file, a small mock — tens of KB  | inline `contentBase64`, one call                       |
| a large mock or a very large notes file | `create_design_upload` → PUT → `publish_design_result` |

⚠️ **Two independent limits sit under an inline publish, and only the first one
is about Motir** (bug MOTIR-4750). The MCP route is a serverless function whose
body is capped around 4.5 MB, and base64 is 1.37× the file — so an inline
publish fails at roughly a 3 MB asset. But the bytes also have to be **EMITTED
by the agent, as a tool argument**: measured on MOTIR-4742, a 3,929,899-byte
board is 5.24 MB of base64, base64 tokenises at ≈0.4 characters per token, and
even a 44 KB thumbnail nobody could read costs ~150,000 tokens. **Raising the
route's cap would not make an inline publish of a real board possible.** A
multi-sheet design board is over both limits, which for that whole population
made the one tool the corpus calls mandatory uncallable — silently, in the shape
the door exists to prevent: files written, commit landed, checks green, panel
empty.

| Input             | Type   | Required | Notes                                                                                                                       |
| ----------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `key`             | string | yes      | The work item this result belongs to, e.g. `"ACME-7"`. A LEAF, as with the publish.                                         |
| `files`           | array  | yes      | `{ kind, sourcePath, contentType }` per file, at least one. One grant is minted per entry, in order.                        |
| `withinParentKey` | string | no       | On a PARENT-RUN publish: the container whose branch this belongs to. Asserts the target is one of its children; not stored. |

**Output** — `structuredContent`: `workItemKey` and `targets`, one per file, each
`{ kind, sourcePath, pathname, uploadUrl, contentType, maxBytes }`. `maxBytes` is
the org's per-file cap, told up front so an over-cap PUT is a decision rather
than an opaque store error.

**The PUT is yours and nothing about it goes through Motir** —
`curl -X PUT --upload-file <file> -H 'Content-Type: text/html' "<uploadUrl>"`.
The grant is bound to that exact object and that exact media type, so a PUT of
anything else is refused by the store. Then `publish_design_result` HEADs each
object for its authoritative size and type: a lying, absent or cross-tenant
`pathname` can never be recorded.

**Permission** — `work_item:edit`, the same key the publish asserts and one
`CLI_TOKEN_GRANT` already carries. Minting a presigned write is a WRITE even
though it persists no row.

#### `create_acceptance_upload` · `publish_acceptance_result`

Put the **acceptance receipt on a story** (or on a bug / task that has children and is run as a parent) — the recording of ONE watchable run of
the story working, which a person then watches and approves. It is the artifact
the acceptance gate rests on, and the pair is the receipt half of the same idea
`publish_design_result` is the design half of.

**TWO calls, and the reason is the artifact.** A design asset arrives inline as
base64; a recording cannot. The MCP route is a serverless function whose request
body is capped well below a video (base64 is 1.37× the file, so an inline receipt
would fail at roughly 3 MB — against a per-file entitlement of 10 MB baseline and
100 MB on cloud `scaled`), and the bytes would have to be EMITTED by the agent as
a tool argument: a 5 MB clip is 6.7 M characters. So this is the mint-then-PUT
shape — the same one `docs/decisions/design-result.md` deliberately kept its
routes for — expressed as two tools.

1. **`create_acceptance_upload`** `{ key, hasTrace? }` → a short-lived (~5 min)
   presigned PUT URL bound to one exact object and one content type.
2. **PUT the bytes yourself** to `video.uploadUrl` with
   `Content-Type: video/webm`. Nothing about this step goes through Motir.
3. **`publish_acceptance_result`** `{ key, videoPathname, tracePathname?,
chapters?, commitSha?, producedByKey? }` → the receipt.

⚠️ **WHO publishes depends on the repository, and the agent reads its checkout to
find out (MOTIR-7254).** In a repository whose acceptance lane carries the
`upload-acceptance-video` action — motir-core, and every project generated from
`nextjs-prisma-vercel-starter` since MOTIR-7255 — **CI publishes the receipt**, from
a green pull-request run over keyless GitHub OIDC, and the agent makes no call. The
dispatch prompt spells the check out:
`grep -rlE 'uses:\s*\./\.github/actions/upload-acceptance-video' .github/workflows/`
— a file printed means the lane publishes. **These two tools are the door for every
other repository**, and there nothing else publishes the receipt, exactly as with
the design result: a story whose receipt never arrives looks identical to one that
succeeded — spec green, checks green, pull request merged, and nobody able to
watch the story work. **The confirmation is the `id` this call returns**, and its
`status` is `pending`: the publish is not the acceptance, a person is.

⚠️ **Why both doors exist.** MOTIR-4096 retired the CI uploader on 2026-09-01: a CI
publisher has to be present in whatever repository the work lands in, which is a
requirement a customer's repository cannot be relied on to meet. That still holds
for a customer's repository, and this door is what travels there — the planner
writes the acceptance E2E subtask onto every user-facing story, and the runner's
dispatch prompt tells it to publish what it recorded. (Between MOTIR-4096 and
MOTIR-4704 there was no such door, and three documents said there was.) But Motir
DOES write the repository in two places — its own, and the starter every hosted
project is generated from — so on 2026-10-01 MOTIR-7253 restored the CI publisher
there, where it is the more reliable link
(`docs/decisions/acceptance-video.md`, the 2026-10-01 amendment). An agent and CI
publishing the same commit send the same `producedByKey` (the card key) and so
collapse to ONE receipt rather than superseding each other.

| Input           | Type    | Required | Notes                                                                                                    |
| --------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `key`           | string  | yes      | The E2E card's key or the story's — a receipt belongs to the STORY, so a leaf resolves UP to its parent. |
| `hasTrace`      | boolean | no       | Mint a second grant for the Playwright trace. `create_acceptance_upload` only.                           |
| `videoPathname` | string  | yes      | The video grant's `pathname`, exactly as returned. `publish_acceptance_result` only.                     |
| `tracePathname` | string  | no       | The trace grant's `pathname`, when one was minted and uploaded to.                                       |
| `chapters`      | array   | no       | `{ label, tSeconds }` markers from the run's `chapters.json` — what a reviewer scrubs by.                |
| `commitSha`     | string  | no       | The commit the run recorded at. Also the **idempotency key**, with `producedByKey`.                      |
| `producedByKey` | string  | no       | The E2E work item that produced the recording.                                                           |

**Output** — `create_acceptance_upload`: `workItemKey`, `video`
(`pathname`, `uploadUrl`, `contentType`, `maxBytes`) and `trace` (the same, or
null). `publish_acceptance_result`: `id`, `workItemKey`, `status`,
`chapterCount`, `sizeBytes`, `createdAt`.

**Refusals** — every one comes from the shipped acceptance-evidence service, so
these tools and the HTTP publish routes answer one rule:

| Refusal                            | When                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCEPTANCE_EVIDENCE_NOT_A_STORY`  | `key` resolves to something that cannot own a receipt: not a story, not a bug or task with children, and no such container above it (Principle #18; MOTIR-9209).                                                                                                                        |
| `ACCEPTANCE_VIDEO_INELIGIBLE`      | The org has no paid AI plan, or the acceptance-video toggle is off. Checked BEFORE any object-store spend.                                                                                                                                                                              |
| blob missing                       | The `pathname` names no object — the PUT never happened, or went somewhere else. The register step HEADs every artifact.                                                                                                                                                                |
| pathname outside the prefix        | A key that is not under this story's own acceptance prefix. A lying or cross-tenant pathname can never be recorded.                                                                                                                                                                     |
| oversize file                      | The object's AUTHORITATIVE size exceeds the org's per-file cap. Read from the store, never from what the caller reports.                                                                                                                                                                |
| disallowed media type              | Anything but `video/webm` / `video/mp4`. `text/html` is refused here exactly as video is refused by the design publisher.                                                                                                                                                               |
| unknown / cross-workspace `key`    | A 404, indistinguishable from a work item the token cannot reach.                                                                                                                                                                                                                       |
| `ACCEPTANCE_EVIDENCE_STORY_CLOSED` | 409. The story is closed, or it still stands on an APPROVED receipt: at or above Implemented with a pull request open, which would merge with it. Reopen the story (move it below Implemented) to record again. An approved recording is never deleted by a later publish (MOTIR-5872). |

**Permission** — `work_item:edit`. `ACCEPTANCE_PUBLISH_PERMISSION` _is_ that key,
the same one `publish_design_result` asserts and one `CLI_TOKEN_GRANT` already
carries — so a dispatched run can call these the day they ship, with no new
credential and no widened grant.

#### `publish_test_instructions`

Put a **RUN's HOW TO TEST** onto its **run target** — the work item the run was
launched against: the story for a story or scoped run, the card itself for a
single-card run (Story MOTIR-4906 · MOTIR-5331; `docs/decisions/approval-gates.md`
§9 and its 2026-09-13 amendment). Its content is **rich text**: a Markdown
`bodyMd` with sections — the precondition, local setup, and the click-path when
the run creates or changes a rendered surface — with **every command in its own
fenced code block**, which the page renders click-to-copy. It is written the way
`publish_design_result` takes a design note. It renders on the run target's item
page inside the **Development block**, with its pull requests — the evidence of
the one approve-to-merge decision — beside the preview each repository reported
and the checks CI ran. **Nothing else writes it.** It does **not** replace the
`## How to test` section of a pull-request body — both are written.

Call it **before the run finishes** — before a single card moves to
`implemented`, or before a story/scoped run's pull requests are marked ready —
**and again whenever a later commit changes a step it describes** (MOTIR-6065).
How to test is written for the **work item**, not for a commit: the item page
does not flag a record whose commit the pull request has since moved past, so
the agent that pushes the commit — the run itself, or a CI-fixing agent after
it — is the one that keeps the steps true. A commit that changes none of them
needs no new publish. Do **not** include the branch fetch — Motir composes it
from each pull request's own `headRef`.

**`repos` is OPTIONAL, and that is not an invitation to skip it** (MOTIR-5689).
It became optional because a PERSON writes How to test through the same writer,
from a form with no repository control — the repositories a person's record
covers are derived from the card's linked pull requests
(`docs/decisions/approval-gates.md` §9's 2026-09-17 amendment, point 2). A team
that keeps its pull requests on the host links nothing, so its record carries no
section, and a refusal there made the form unsaveable. An AGENT knows exactly
what it pushed to, and its record is the evidence for the delivery set a person
approves — so send one entry per repository.

| Input               | Type   | Required | Notes                                                                                                                                                                                            |
| ------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key`               | string | yes      | The run target's identifier, e.g. `ACME-7`.                                                                                                                                                      |
| `bodyMd`            | string | yes      | Markdown, not blank, at most 32 KiB (UTF-8 bytes). Stored as written, trimmed.                                                                                                                   |
| `repos`             | array  | no       | One `{ repo, commitSha }` per repository the run pushed to; at most 8. **Optional only because a PERSON writing from the form names none — as an agent, SEND ONE PER REPOSITORY YOU PUSHED TO.** |
| `repos[].repo`      | string | yes      | `name` or `owner/name`; one of the item's project repositories, and each at most once.                                                                                                           |
| `repos[].commitSha` | string | yes      | That repository's pushed head commit (7–64 hex).                                                                                                                                                 |
| `previewPath`       | string | no       | A PATH on the preview host starting with a single `/`, e.g. `/items/ACME-7`; never a URL.                                                                                                        |

**Behaviour.** A run target holds ONE current record — the newest run's — and
keeps every earlier run's as history. The owing dispatch run is resolved
server-side — the newest RUNNING run whose scope target is the item or that
holds a leg for it — and is never an argument. The same content from the same
run twice writes nothing and answers `created: false`; different content from the
same run, or any publish from another run, becomes the new current record.

**Output** — `structuredContent`: `{ id, workItemKey, repos: [{ repoId,
commitSha }], bodyBytes, created, isCurrent, dispatchRunId, createdAt }`.

**Refusals** — each a typed code whose message names what to fix:

| Refusal                                 | When                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `TEST_INSTRUCTIONS_REPO_NOT_IN_PROJECT` | A `repos[].repo` is not one of the project's repositories (or a bare name is ambiguous). Lists the valid set. |
| `TEST_INSTRUCTIONS_CAP_EXCEEDED`        | A field is over its limit — the message names the field and the limit. Never truncated.                       |
| `TEST_INSTRUCTIONS_INVALID_FIELD`       | A malformed field: a blank `bodyMd`, a repository twice, a non-hex `commitSha`, a URL as `previewPath`.       |
| `PERMISSION_DENIED`                     | The token or the member's role lacks `work_item:edit`.                                                        |
| unknown / cross-workspace `key`         | A 404, indistinguishable from a work item the token cannot reach.                                             |

**Permission** — `work_item:edit`, the key the evidence publishers above assert
and one `CLI_TOKEN_GRANT` already carries. The grant is **not** widened.

#### `link_work_items`

Create a relationship between two work items — the primitive for the **dependency
edges** the plan is built on. The `relationship` is read `fromKey <relationship>
toKey` and is one of seven relationships (`blocked_by` / `blocks` / `relates_to`
/ `duplicates` / `clones` / `supersedes` / `superseded_by`); `blocks` is the
inverse direction of `blocked_by`, both stored as the single `is_blocked_by`
edge. An `is_blocked_by` link removes the blocked item from the ready set
(`list_ready` / `next_ready` honor it) and renders the inverse edge on the other
item. Targets may live in **another project in the same workspace**.

**`supersedes` / `superseded_by`** (MOTIR-6580) record that one work item
REPLACES another. `A supersedes B` means A is the NEWER item and B the OLDER one
it replaces; `B superseded_by A` writes the very same stored row
(`from` = A, `to` = B, kind `supersedes`) from the older end. It is directed with
no reciprocal row, and it **gates nothing** — readiness, the ready set and the
claim doors read `is_blocked_by` alone, and there is no cycle guard on it. The
older item's own mark (`outdated` / `deprecated`) is a separate field; this edge
says which item took over. `get_work_item` lists the edge under `supersedes` on
the newer item and under `supersededBy` on the older one.

Re-creating an existing link is **idempotent** (a success no-op, not an error). A
**self** link (any relationship), a dependency **cycle** (`is_blocked_by` only),
or a **cross-workspace** link returns a typed error naming the violation. The
link is an edit of the FROM item, so the same Story-6.4 edit gate as the UI
applies.

**A dependency SHOULD join two items on the SAME LEVEL** (Story MOTIR-6015 ·
MOTIR-6369). The level is **position, not kind** (MOTIR-6387,
`docs/decisions/edge-level-is-position.md`): two items are on the same level
when they sit at the **same depth below their nearest common ancestor**, the
project root being the ancestor of every root item and a folder adding no depth.
So an edge **may cross parents** — a subtask `blocked_by` a subtask in another
story, a story `blocked_by` a story in another epic, a validation task under an
epic `blocked_by` the story beside it. **An epic is blocked only by another epic**
(the record's Amendment 1): the epic tier is decided by KIND, ahead of any depth,
so an epic and a root task, bug or story are never peers even though both hang
off the project root. Under an epic the position rule stands.

**A `blocked_by` / `blocks` between two levels is still WRITTEN** (the record's
Amendment 2, MOTIR-6509) — on this tool, on the REST link route and on the links
collected by `create_work_item` / the create modal. The dependency is real, so
the edge holds the blocked item out of the ready set and out of both claim doors
like any other. `validate_work_item` then reports it INVALID in
`crossLevelEdges` (_"blocked elsewhere"_), naming both keys and their depths,
until somebody re-wires it to the same-level item really waited on. Only the plan
gate refuses one (`INVALID_PLAN_REF_GRAPH` / `cross_level`): a planner may not
author it. `relates_to`, `duplicates` and `clones` are never judged.

| Input          | Type                                                                                                      | Required | Notes                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| `fromKey`      | string                                                                                                    | yes      | The first item's identifier, e.g. `"ACME-3"`.             |
| `toKey`        | string                                                                                                    | yes      | The second item's identifier (may be in another project). |
| `relationship` | `"blocked_by" \| "blocks" \| "relates_to" \| "duplicates" \| "clones" \| "supersedes" \| "superseded_by"` | yes      | Read `fromKey <relationship> toKey`.                      |

**Output** — `structuredContent`: the created `WorkItemLinkDto` (plus the
`relationship`). For an idempotent no-op, `{ idempotent: true, relationship }`.

#### `unlink_work_items`

Remove a relationship between two work items, addressed by the same `fromKey` +
`toKey` + `relationship` used to create it. **Idempotent** — removing a link that
is already absent succeeds as a no-op. Same edit gate as the UI link path. Either
direction of a directed pair names the same row: `A supersedes B` and
`B superseded_by A` both remove the one `supersedes` edge (likewise
`blocked_by` / `blocks`).

| Input          | Type                                                                                                      | Required | Notes                         |
| -------------- | --------------------------------------------------------------------------------------------------------- | -------- | ----------------------------- |
| `fromKey`      | string                                                                                                    | yes      | The first item's identifier.  |
| `toKey`        | string                                                                                                    | yes      | The second item's identifier. |
| `relationship` | `"blocked_by" \| "blocks" \| "relates_to" \| "duplicates" \| "clones" \| "supersedes" \| "superseded_by"` | yes      | The relationship to remove.   |

**Output** — `structuredContent`: `{ removed: boolean, relationship }` — `removed`
is `false` when no such link existed (the idempotent no-op).

#### `update_work_item`

Edit a work item's fields — the partial-patch counterpart of `create_work_item`,
which can only set kind/title/parentKey/description/priority/story-points on
create. Patch any
subset of the UI-editable fields; an omitted field is left unchanged, and an
explicit `null` clears a nullable one. The workflow **status** is NOT edited here
(use `transition_status`), and neither is `kind`/`parent` — each is a structural
move with its own tool (`change_kind` for the hierarchy kind, `move_to_parent`
for the parent). Note `type`/`executor` here are the **work type** axis
(code/design/test/…), a different thing from the hierarchy `kind`.
The leaf-only `type`/`executor` rule (setting them on an epic/story is rejected),
the type→executor seed, and the assignee-membership check all apply exactly as in
the UI; the same Story-6.4 edit gate gates the call.

| Input                | Type                                               | Required | Notes                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                | string                                             | yes      | Work item identifier, e.g. `"ACME-7"`.                                                                                                                                                                                                                           |
| `title`              | string                                             | no       | New title.                                                                                                                                                                                                                                                       |
| `descriptionMd`      | string \| null                                     | no       | New description; `null` clears it.                                                                                                                                                                                                                               |
| `sections`           | object                                             | no       | Named [sections](#get_section_sets) merged over the stored body (sparse: an omitted section is kept, `null` clears one, a list replaces the list), checked for the type AFTER this write and rendered into `descriptionMd`. Never together with `descriptionMd`. |
| `explanationMd`      | string \| null                                     | no       | New explanation ("why"); `null` clears it.                                                                                                                                                                                                                       |
| `priority`           | `lowest…highest`                                   | no       | New priority.                                                                                                                                                                                                                                                    |
| `type`               | work type \| null                                  | no       | Leaf items only; `null` clears it. First set seeds the executor.                                                                                                                                                                                                 |
| `executor`           | `"coding_agent" \| "human"` \| null                | no       | Leaf items only; `null` clears it.                                                                                                                                                                                                                               |
| `difficulty`         | `"trivial" \| "low" \| "medium" \| "high"` \| null | no       | Leaf items only; `null` clears it. A re-kind onto a container that keeps one is refused.                                                                                                                                                                         |
| `obsolescence`       | `"outdated" \| "deprecated"` \| null               | no       | The [obsolescence mark](#the-obsolescence-mark) — any kind, on a FINISHED card only (else `OBSOLESCENCE_REQUIRES_FINISHED`); `null` clears it, always.                                                                                                           |
| `obsolescenceNoteMd` | string \| null                                     | no       | Why the item is marked; `null` clears it. Independent of the mark.                                                                                                                                                                                               |
| `estimateMinutes`    | number \| null                                     | no       | Estimated minutes (time); `null` clears it.                                                                                                                                                                                                                      |
| `storyPoints`        | number \| null                                     | no       | Story-point estimate (non-negative, ≤ 9999.99, ≤ 2 decimals); set / change / `null` clears it.                                                                                                                                                                   |
| `targetRepo`         | string \| null                                     | no       | Repo the item ships in — bare name or `"owner/name"`; must be in this project's repo set. `null` clears.                                                                                                                                                         |
| `targetRepos`        | string[]                                           | no       | Replace the repo SET wholesale, ORDERED, element 0 the primary; `[]` clears it. Mutually exclusive with `targetRepo`.                                                                                                                                            |
| `targetRepositories` | string[]                                           | no       | Replace the set as REFERENCES — the project's repository row ids, ORDERED; `[]` clears it. Mutually exclusive with BOTH fields above.                                                                                                                            |
| `assigneeId`         | string \| null                                     | no       | Assignee user id (must be a workspace member); `null` unassigns.                                                                                                                                                                                                 |
| `dueDate`            | string (ISO-8601) \| null                          | no       | Due date; `null` clears it.                                                                                                                                                                                                                                      |

**Output** — `structuredContent`: the updated `WorkItemDto`. A non-member
assignee, a `type`/`executor` on a non-leaf, a `difficulty` on a non-leaf
(`DIFFICULTY_NOT_ALLOWED_ON_KIND`), an out-of-range `storyPoints` value,
a `targetRepo` (or any `targetRepos` element) outside this project's repository
set (`UNKNOWN_TARGET_REPO`), a `targetRepositories` element that is not one of this
project's repository rows (`UNKNOWN_PROJECT_REPO_REF`), or more than one of the
three repo fields at once (`CONFLICTING_TARGET_REPO_INPUT`), or an
`obsolescence` outside `outdated` · `deprecated` (`INVALID_OBSOLESCENCE` — the
message leads with the code and names the field), a mark set on a card outside the
done category (`OBSOLESCENCE_REQUIRES_FINISHED`), or a parent that carries a mark
(`MARKED_CARD_CANNOT_REOPEN`) returns a typed error.

`change_kind` needs no obsolescence rule: the mark has no kind constraint, so a
marked card is reclassified exactly like an unmarked one.

#### `change_kind`

**Reclassify** a work item: change its hierarchy **kind** between `story`,
`task`, `bug`, and `subtask`. This is the structural change `update_work_item`
leaves out (kind is "a structural move, not a field edit") and `create_work_item`
can set only at creation — so an agent that mis-typed an item can fix it
**without** the delete-and-recreate that would lose its identifier, history,
comments, and links. The sibling of `move_to_parent` (parent is the other
structural move update can't do).

This changes the hierarchy **kind**, NOT the **work type** — the `type`
(code/design/test/…) and `executor` axis stays on `update_work_item`. `epic` is
not an available target (epics are planner/seed scaffolding, excluded from the
agent surface exactly as in `create_work_item`).

The new kind must keep the kind-parent matrix legal on **both** sides: it must be
a legal child of the item's **current parent**, and must legally parent **every
existing child** — else `ILLEGAL_PARENT_TYPE`. A container kind (`story`) cannot
keep a leaf-only **work type**, so reclassifying a typed leaf into a container
without first clearing its `type` returns `TYPE_NOT_ALLOWED_ON_KIND`, and one that
still carries a `difficulty` returns `DIFFICULTY_NOT_ALLOWED_ON_KIND`. Same
Story-6.4 edit gate as the UI; a missing / cross-tenant key is an
indistinguishable 404.

| Input  | Type                                      | Required | Notes                                           |
| ------ | ----------------------------------------- | -------- | ----------------------------------------------- |
| `key`  | string                                    | yes      | Work item identifier, e.g. `"ACME-7"`.          |
| `kind` | `"story" \| "task" \| "bug" \| "subtask"` | yes      | The new hierarchy kind. `epic` is not a target. |

**Output** — `structuredContent`: the reclassified `WorkItemDto` (its `kind`
updated). An illegal parent/child pairing or a type-bearing container returns a
typed error.

#### `archive_work_item`

Soft-delete (archive) a work item: it leaves the ready set (`list_ready` /
`next_ready`) and search, but is fully recoverable. Archives **only this item** —
children are left intact (the deliberate "Linear shape", not a Jira parent→subtree
cascade; a destructive subtree delete is the separate `delete_work_item`). Gated
on **`work_item:archive`** — the reversible half of removal, which a project
member holds; the same gate the UI's Archive row asks for.

| Input | Type   | Required | Notes                 |
| ----- | ------ | -------- | --------------------- |
| `key` | string | yes      | Work item identifier. |

**Output** — `structuredContent`: the archived `WorkItemDto` (`archivedAt` set).

#### `unarchive_work_item`

Restore an archived work item — the inverse of `archive_work_item` (Jira
"restore"). Clears `archivedAt` so the item returns to active views and records an
`unarchived` history entry. Gated on **`work_item:archive`**, like its inverse —
restoring cannot be the tighter of the two.

| Input | Type   | Required | Notes                 |
| ----- | ------ | -------- | --------------------- |
| `key` | string | yes      | Work item identifier. |

**Output** — `structuredContent`: the restored `WorkItemDto` (`archivedAt` null).

#### `delete_work_item`

**PERMANENTLY** delete a work item **and its entire subtree** — the root plus
every descendant, and all their links / comments / history, are removed in one
transaction. This is **irreversible**: there is no undo, unlike
`archive_work_item`. Pick **archive** for a recoverable soft-remove that takes a
single card out of the ready set, **delete** to erase a mistaken subtree for
good. Gated on **`work_item:delete`** — the irreversible key, which a project
admin holds and a member does not (a member who can edit and archive but not
delete gets a typed access error). Holding it also confers `work_item:archive`:
destroying a subtree strictly dominates hiding one row. A missing / cross-tenant
key is an indistinguishable 404 not-found.

| Input | Type   | Required | Notes                 |
| ----- | ------ | -------- | --------------------- |
| `key` | string | yes      | Work item identifier. |

**Output** — `structuredContent`: the deletion summary
`{ deleted: true, id, identifier, title, totalCount, descendantCount, byKind }` —
`totalCount` is the number of rows removed (root + descendants), `descendantCount`
is `totalCount − 1`, and `byKind` is the per-kind breakdown of the descendants
(captured before the cascade). A denied or not-found key returns a typed error.

#### `move_to_parent`

**Re-place** a work item: move it under a different parent, promote it to a
top-level root, or file it into — or out of — a folder. This is the structural move `create_work_item` (parent is
set only at create) and `update_work_item` (a field patch, not a structural
move) deliberately leave out — so an agent can re-home a card **without** the
delete-and-recreate hack that would lose its identifier, history, comments, and
links. Re-parenting is its own verb for the same reason status
(`transition_status`) and sprint membership (`move_to_sprint`) are.

Pass `parentKey` to move the item under that parent (appended to the parent's
children at a freshly-minted position), or `null` to promote it to a top-level
root. The same rules as the UI's tree/board re-parent apply: the new parent must
be a **kind-legal** parent in the **same project**, and the move may not create a
**cycle** (under itself or a descendant) or exceed the **4-level depth** limit —
each returns a typed error naming the violation. Same Story-6.4 edit gate as the
UI; a missing / cross-tenant key is an indistinguishable 404.

A work item sits under a work-item parent **or** in a folder, never both, so the
tool takes **exactly one** of `parentKey` and `folderId` (MOTIR-5413):

- **`{ key, parentKey }`** — the re-parent above. Setting a work-item parent on a
  filed item also takes it out of its folder. `parentKey: null` on a filed item
  promotes it to the root and **keeps** its folder.
- **`{ key, folderId: "<id>" }`** — file the item into that folder (an id from
  [`list_folders`](#list_folders)), appended last at the folder's level. Its
  work-item parent is cleared; its own children travel with it.
- **`{ key, folderId: null }`** — take the item out of its folder, to the root. A
  subtask cannot go there: `SUBTASK_NEEDS_PLACEMENT`.
- **both, or neither** — refused before any read: both is `PLACEMENT_CONFLICT`,
  neither is `INVALID_REQUEST`, and the message names the rule.

| Input       | Type           | Required   | Notes                                                                                                                                                |
| ----------- | -------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`       | string         | yes        | The work item to move, e.g. `"ACME-7"`.                                                                                                              |
| `parentKey` | string \| null | one of two | The new parent's identifier, or `null` to promote to a top-level root. Same-project only.                                                            |
| `folderId`  | string \| null | one of two | A folder id to file the item into, or `null` to take it out of its folder. Unknown → `FOLDER_NOT_FOUND`; another project's → `CROSS_PROJECT_FOLDER`. |

**Output** — `structuredContent`: the moved `WorkItemDto`, plus a **`placement`**
field — `{ parentKey, folderId, folderPath }` — read back off the row, so it
agrees with a following [`get_work_item`](#get_work_item).

### Folders

A **folder** is a named, nestable place in a project's tree that holds work items
and other folders and carries **no workflow** of its own. These four tools see and
tidy a project's folders over the same folder service the `/items` tree uses.
Placing a _work item_ into a folder is the work-item tools' job, not these.
Every refusal is the folder service's own, returned as a typed tool error
carrying its code:

| Code                      | Meaning                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `FOLDER_NOT_FOUND`        | No such folder in your workspace (also a retried delete on a folder already gone).         |
| `INVALID_FOLDER_NAME`     | The name is empty or over the length cap.                                                  |
| `FOLDER_NAME_TAKEN`       | A folder with that name already sits at that level; the message names it.                  |
| `FOLDER_CYCLE`            | The move would put a folder inside itself or one of its own folders.                       |
| `CROSS_PROJECT_FOLDER`    | The folder belongs to another project.                                                     |
| `SUBTASK_NEEDS_PLACEMENT` | The change would leave a subtask with neither a parent nor a folder.                       |
| `PLACEMENT_CONFLICT`      | A work item was given a parent and a folder at once (reached through the work-item tools). |

#### `list_folders`

Every folder of a project in **one read**, in tree order — so an agent resolving
"the Backlog ideas folder" gets every path at once, the way `skeleton` hands it
the whole work-item tree. The read is capped (the Move to… picker's cap), and
`truncated` is always reported. Gated on `project:browse`.

| Input        | Type   | Required | Notes                       |
| ------------ | ------ | -------- | --------------------------- |
| `projectKey` | string | yes      | Project key, e.g. `"ACME"`. |

**Output** — `structuredContent`: `{ projectKey, folders, truncated }`, where each
row of `folders` is `{ id, parentFolderId, name, path }` and `path` is the
folder's name and every ancestor's, root first (`["Parked", "2025"]`). The text
summary is the indented tree.

#### `get_section_sets`

Which sections a work item of a given kind and type has, which of them are
**required**, and the heading each renders under in the free-text description.
A planner calls it before writing a card, instead of guessing and learning from a
refusal. The sets are a product contract, the same for every tenant, so the tool
takes **no `projectKey`**. It is the same descriptor `GET /api/v1/section-sets`
returns and the one motir-ai builds its author tool from. Gated on
`project:browse`, like `whoami`.

| Input  | Type   | Required | Notes                                                                                          |
| ------ | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `kind` | string | no       | Only this kind's sets: `epic`, `story`, `task`, `subtask` or `bug`.                            |
| `type` | string | no       | Only this type's sets, one cell per kind (a story and an epic have one set whatever the type). |

**Output** — `structuredContent`: `{ version, sections, sets }`. `sections` maps
each section name to its `heading` (`null` for the unheaded opening) and its value
`shape`; `sets` has one `{ kind, type, sections: [{ name, required }] }` per cell
asked for. The text summary lists each cell's required sections first, then the
optional ones. A `kind` or `type` that names nothing is refused by name
(`UNKNOWN_SECTION_CELL`), never answered with a default set.

#### `create_folder`

Create a folder at the project root, or inside another folder. Names are unique
among the folders at one level. **Re-delivery:** a retried create meets
`FOLDER_NAME_TAKEN` naming the folder the first call made — call `list_folders`
to find it rather than creating again. Gated on `work_item:edit`.

| Input            | Type           | Required | Notes                                                        |
| ---------------- | -------------- | -------- | ------------------------------------------------------------ |
| `projectKey`     | string         | yes      | Project key.                                                 |
| `name`           | string         | yes      | The folder's name.                                           |
| `parentFolderId` | string \| null | no       | The folder to create it inside; omit or `null` for the root. |

**Output** — `structuredContent`: the folder, exactly as `/api/v1` publishes it —
`{ id, projectKey, parentFolderId, name, path, position, createdAt, updatedAt }`.

#### `update_folder`

**Rename** a folder, **or place** it — move it into another folder and/or reorder
it among its siblings. A rename and a placement in **one call is refused**
(`INVALID_REQUEST`) and changes nothing: the service performs them as separate
writes, so a combined call could half-apply. Make two calls. A call carrying
neither is refused the same way. The split is the one `PATCH /api/v1/folders/{folderId}`
uses, so the two doors agree. Gated on `work_item:edit`.

| Input            | Type           | Required | Notes                                                                                            |
| ---------------- | -------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `projectKey`     | string         | yes      | Project key.                                                                                     |
| `folderId`       | string         | yes      | The folder to change, from `list_folders`.                                                       |
| `name`           | string         | no       | RENAME: the new name. Not with a placement.                                                      |
| `parentFolderId` | string \| null | no       | PLACE: the destination folder, or `null` for the root. Omit to keep the parent and only reorder. |
| `beforeId`       | string \| null | no       | PLACE: the sibling folder this one sorts AFTER.                                                  |
| `afterId`        | string \| null | no       | PLACE: the sibling folder this one sorts BEFORE.                                                 |

**Output** — `structuredContent`: the folder, in `create_folder`'s shape.

#### `delete_folder`

Delete a folder. **Nothing inside it is deleted**: its folders and filed work
items move up to the deleted folder's parent, or to the project root, and the
result names every id that moved. A retried delete returns `FOLDER_NOT_FOUND`.
Gated on `work_item:edit`.

| Input        | Type   | Required | Notes                                      |
| ------------ | ------ | -------- | ------------------------------------------ |
| `projectKey` | string | yes      | Project key.                               |
| `folderId`   | string | yes      | The folder to delete, from `list_folders`. |

**Output** — `structuredContent`: `{ deletedFolderId, destinationFolderId,
movedFolderIds, movedWorkItemIds }` — `destinationFolderId` is `null` when the
contents moved to the root.

### Pages

A **page** is a project's document — a decision, a spec, a runbook — kept in the
project's `/pages` tree beside the work it describes
([`docs/decisions/pages.md`](decisions/pages.md)). Its canonical body is the
editor's collaborative document; an agent reads and writes it as **markdown**,
converted on the server through the same package the editor uses (§8.2). A page
is addressed by its project key and its opaque **id** — the `<id>` in the page's
address `/pages/<id>`. The token `motir login` mints carries `page:view` and
`page:edit`, so a dispatched agent reaches every page tool below; it never carries
`page:delete` ([`docs/decisions/pages.md`](decisions/pages.md) §5). A token
minted before that grant changed gains them at its next `motir login`. Every
refusal is the page service's own, returned as a typed tool error carrying its
code:

| Code                         | Meaning                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAGE_NOT_FOUND`             | No such page in that project — the same answer for an unknown id and another project's page.                                                                |
| `PAGE_VERSION_NOT_FOUND`     | `get_page`'s `version` names a number the page has no version for. The message names the number.                                                            |
| `PAGE_REVISION_CONFLICT`     | `update_page` sent a `revision` the page has moved past. Nothing was written; the message names both revisions. Call `get_page`, redo the edit, send again. |
| `PAGE_BODY_TOO_LARGE`        | The markdown is over 1 MiB, or the body it makes is over 2 MiB. The message names the size and the limit. Nothing was written.                              |
| `PAGE_TITLE_TOO_LONG`        | `create_page`'s or `rename_page`'s `title` is over 255 characters.                                                                                          |
| `PAGE_PARENT_NOT_ALLOWED`    | A `parent.kind` other than `root`, `folder` or `page` — a page cannot be filed under a work item.                                                           |
| `PAGE_PARENT_ID_REQUIRED`    | A `folder` or `page` parent with no `id`.                                                                                                                   |
| `FOLDER_NOT_FOUND`           | The parent folder is not in this project.                                                                                                                   |
| `CROSS_PROJECT_PAGE_PARENT`  | The parent page or folder belongs to another project.                                                                                                       |
| `PAGE_CYCLE`                 | A page placed under itself or one of its own sub-pages.                                                                                                     |
| `PAGE_DEPTH_EXCEEDED`        | The sub-page would sit deeper than 10 levels.                                                                                                               |
| `PAGE_ARCHIVED`              | `move_page` or `archive_page` named a page that is already archived. Restore it first.                                                                      |
| `PAGE_NOT_ARCHIVED`          | `archive_page`'s `restore` named a live page.                                                                                                               |
| `PAGE_ARCHIVE_ROOT_REQUIRED` | `archive_page`'s `restore` named a sub-page that was archived with its parent. Restore the archive root instead.                                            |
| `PAGE_LINK_NOT_FOUND`        | `link_page`'s `unlink` named a pair with no hand link (a mention or embed is not one).                                                                      |
| `CROSS_PROJECT_LINK`         | `link_page` named a work item, or a page you can see, in another project than `projectKey`.                                                                 |
| `PAGE_PARENT_ARCHIVED`       | `move_page`'s destination page is archived.                                                                                                                 |
| `PAGE_NEIGHBOUR_INVALID`     | `move_page`'s `beforeId` / `afterId` is not a sibling at the destination.                                                                                   |
| `PAGE_SEARCH_QUERY_EMPTY`    | `search_pages`' `q` is empty or only whitespace. A search never lists every page.                                                                           |
| `PAGE_SEARCH_QUERY_TOO_LONG` | `search_pages`' `q` is over 200 characters.                                                                                                                 |
| `PAGE_CURSOR_INVALID`        | `search_pages`' `cursor` is not one a previous call returned.                                                                                               |

#### `get_page`

Read one page as markdown. The read an agent makes before it writes: the
`revision` it returns is what a write must send back. Gated on `page:view`, the
key the page's own address checks. It takes no lock, so it never waits on a
person's save.

| Input        | Type    | Required | Notes                                                                                           |
| ------------ | ------- | -------- | ----------------------------------------------------------------------------------------------- |
| `projectKey` | string  | yes      | Project key, e.g. `"ACME"`.                                                                     |
| `pageId`     | string  | yes      | The page id — the `<id>` in `/pages/<id>`.                                                      |
| `version`    | integer | no       | A version number from the page's history. Reads that version's body instead of the current one. |

**Output** — `structuredContent`: `{ id, projectId, title, placement, revision,
latestVersion, markdown, updatedAt }`. `placement` is `{ parentPageId, folderId }`
— at most one is set, both `null` at the project root. `latestVersion` is the
newest entry of the page's history, `{ number, authorId, authorName, savedAt }`
(`null` only for a page older than versions). The text summary is the title, the
placement, `revision N`, who saved the newest version, then the markdown.

**One version** (MOTIR-7429) — with `version`, `markdown` is that version's body
and the payload adds `version: { number, authorId, authorName, savedAt, sealed,
frozen }`. `sealed` means a decision was published at that version; `frozen`
means a person approved it (`docs/decisions/pages.md` AMENDMENT 3). Everything
else still describes the page as it is now, so a run told "read decision page X
at version 3" can see both what was approved and how far the page has moved
since. A number the page does not have is refused `PAGE_VERSION_NOT_FOUND`,
naming the page and the number — never the current body as a fallback. Without
`version`, the output is exactly the current-body read above.

#### `create_page`

Create a page with a markdown body, filed at the project root, in a folder, or
under another page as a sub-page. Gated on `page:edit`, the key the editor's save
checks. The page and its body are written in one transaction, so a refusal (a
parent that is not allowed, a body over the cap) leaves no page behind.

| Input        | Type   | Required | Notes                                                                                                                        |
| ------------ | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `projectKey` | string | yes      | Project key, e.g. `"ACME"`.                                                                                                  |
| `title`      | string | no       | Omit for an untitled page.                                                                                                   |
| `markdown`   | string | no       | The body. Omit for an empty page.                                                                                            |
| `parent`     | object | no       | `{ "kind": "root" }`, `{ "kind": "folder", "id" }` (an id from `list_folders`) or `{ "kind": "page", "id" }`. Default: root. |

**Output** — the new page, in `get_page`'s shape. The text summary names its id,
its address `/pages/<id>` and its `revision`, which is what `update_page` needs.

#### `update_page`

**Replace** a page's whole body with markdown. It does not append or patch: an
agent edits a page by reading it with `get_page`, changing the markdown, and
writing the full result back with the `revision` it read. Gated on `page:edit`.

A stale `revision` is **refused, not merged** (`PAGE_REVISION_CONFLICT`, nothing
written). The editor's own saves are collaborative updates that merge; a
whole-body replace cannot, and written over a newer revision it would silently
erase what a person saved in between. The refusal names the page's revision and
the one sent, and tells the agent to call `get_page`, apply its change to what
that returns, and send the new revision. Whatever a write replaces stays a
restorable version in the page's history, which is why the tool is annotated
`destructiveHint: false`. It does not rename the page — `rename_page` does.

| Input        | Type    | Required | Notes                                                      |
| ------------ | ------- | -------- | ---------------------------------------------------------- |
| `projectKey` | string  | yes      | Project key, e.g. `"ACME"`.                                |
| `pageId`     | string  | yes      | The page id — the `<id>` in `/pages/<id>`.                 |
| `markdown`   | string  | yes      | The page's whole new body.                                 |
| `revision`   | integer | yes      | The `revision` `get_page` or `create_page` returned (≥ 1). |

**Output** — the saved page, in `get_page`'s shape, at its new `revision`.

#### `rename_page`

**Set** a page's title. Gated on `page:edit`. It writes no body, so it takes no
`revision`, cannot be refused `PAGE_REVISION_CONFLICT`, and does not start a new
version: a published decision page renamed here stays at the version it was
published at. An empty `title` makes the page untitled. To change the body, use
`update_page`.

| Input        | Type   | Required | Notes                                      |
| ------------ | ------ | -------- | ------------------------------------------ |
| `projectKey` | string | yes      | Project key, e.g. `"ACME"`.                |
| `pageId`     | string | yes      | The page id — the `<id>` in `/pages/<id>`. |
| `title`      | string | yes      | The page's new title (may be empty).       |

**Output** — the page's summary: `{ id, projectId, title, position, revision, updatedAt }`.

#### `search_pages`

**Find** a project's live pages by a word in the title or the body (Story
MOTIR-9489). Gated on `page:view`. It calls the same `pagesService.searchPages`
door as `GET /api/v1/projects/{projectKey}/pages/search`, so the access filter,
the query rules and every refusal code are the REST route's. Archived pages are
never returned. Hits are ranked best first, 20 at a time.

| Input        | Type   | Required | Notes                                                         |
| ------------ | ------ | -------- | ------------------------------------------------------------- |
| `projectKey` | string | yes      | Project key, e.g. `"ACME"`.                                   |
| `q`          | string | yes      | The words to find (at most 200 characters; empty is refused). |
| `cursor`     | string | no       | The `nextCursor` a previous call returned.                    |

**Output** — `{ items: [{ id, title, place, snippet, rank }], nextCursor }`, each
hit v1's `PageSearchHit`. A hit is not the page: read it with `get_page`.

#### `move_page`

**Re-file** a page, with its whole subtree, under another page, into a folder or
at the project root (Story MOTIR-9487 · MOTIR-9556). Gated on `page:edit`. It
calls the same `pagesService.movePage` door as
`PATCH /api/v1/pages/{pageId}/placement`, so the structure lock and every tree
rule are the REST route's: a page under itself or its own sub-page is
`PAGE_CYCLE`, a destination page or folder in another project reads as missing
(`PAGE_NOT_FOUND` / `FOLDER_NOT_FOUND`, the same answer as an unknown id), an
archived page is `PAGE_ARCHIVED`, an archived destination page is
`PAGE_PARENT_ARCHIVED`, and a tree deeper than 10 levels is
`PAGE_DEPTH_EXCEEDED`. A move to where the page already is writes nothing and
answers `moved: false`.

| Input        | Type   | Required | Notes                                                                                |
| ------------ | ------ | -------- | ------------------------------------------------------------------------------------ |
| `projectKey` | string | yes      | Project key, e.g. `"ACME"`.                                                          |
| `pageId`     | string | yes      | The page id — the `<id>` in `/pages/<id>`.                                           |
| `parent`     | object | yes      | `{ "kind": "root" }`, `{ "kind": "folder", "id" }` or `{ "kind": "page", "id" }`.    |
| `beforeId`   | string | no       | A sibling at the destination the page lands right after. Omit both to place it last. |
| `afterId`    | string | no       | A sibling at the destination the page lands right before.                            |

**Output** — v1's `PagePlacement`: `{ id, parent, position, ancestorPageIds, moved }`.

#### `archive_page`

**Archive** a page, or **restore** it (Story MOTIR-9487 · MOTIR-9557). Gated on
`page:edit`. It calls the same `pagesService.archivePage` /
`pagesService.restorePage` doors as the page tree's Archive and Restore.
Archiving takes the page's live sub-pages with it; a sub-page archived earlier
keeps its own archive and stays out of the set. Nothing is deleted: permanent
delete is `page:delete`, which no tool carries.

Restore applies to an archive **root** and brings back the sub-pages that left
with it. It lands on the first place that still holds: where the page was
(`original`), its nearest live ancestor page (`ancestorPage`), its folder
(`folder`) or the project root (`root`); the tool text says so when the page did
not come back where it was.

| Input        | Type   | Required | Notes                                      |
| ------------ | ------ | -------- | ------------------------------------------ |
| `projectKey` | string | yes      | Project key, e.g. `"ACME"`.                |
| `pageId`     | string | yes      | The page id — the `<id>` in `/pages/<id>`. |
| `action`     | string | no       | `archive` (the default) or `restore`.      |

**Output** — archive: v1's `PageArchive`, `{ archivedIds, rootId, subPageCount }`,
the root first. Restore: v1's `PageRestore`,
`{ restoredIds, landing: { kind, parentPageId, folderId, title } }`.

#### `link_page`

**Link** a page to a work item by hand, or **unlink** it (Story MOTIR-9487 ·
MOTIR-9558). Gated on `page:edit`; the hand-link service also asks
`work_item:edit` and `page:view` on the work item's project, which the token
`motir login` mints carries. It calls the same
`pageLinksService.linkPageForWorkItem` / `unlinkPageForWorkItem` doors as the
work item's page strip, so the link shows there.

Linking a pair that is already linked succeeds with `changed: false` and writes
nothing. Unlinking a pair with no hand link is refused `PAGE_LINK_NOT_FOUND`. A
work item in another project than `projectKey` is refused `CROSS_PROJECT_LINK`
before anything is written; so is a page in another project you can view. A
page you cannot see is `PAGE_NOT_FOUND`, the answer an unknown id gets. An
archived page cannot be linked (`PAGE_ARCHIVED`), but a link to a page archived
since can still be removed.

| Input         | Type   | Required | Notes                                                  |
| ------------- | ------ | -------- | ------------------------------------------------------ |
| `projectKey`  | string | yes      | Project key, e.g. `"ACME"`.                            |
| `pageId`      | string | yes      | The page id — the `<id>` in `/pages/<id>`.             |
| `workItemKey` | string | yes      | The work item's key, e.g. `"ACME-7"`, in `projectKey`. |
| `action`      | string | no       | `link` (the default) or `unlink`.                      |

**Output** — v1's `PageLinkPair` plus `action` and `changed`:
`{ pageId, workItemId, source: "manual", action, changed }`.

#### `publish_decision_page`

Publish a page as a **`decision` card's decision** (Story MOTIR-5761). Call it
**once**, after `create_page` / `update_page` have written the decision, in the
same run. Gated on `work_item:edit` on the card — a key `CLI_TOKEN_GRANT` already
carries, so a dispatched agent's token can call it — and the service also
requires `page:view` on the page.

It **seals** the page's newest version: later edits start a new version, so the
text the card names can no longer change underneath it. On a card an agent runs
it then raises `decision_approval` about exactly that version and moves the card
to review — the card is **waiting on a person**, not finished. On a card a person
runs it raises nothing and moves nothing: the publication is that card's
candidate record.

Publishing the version that is already the card's decision writes nothing and
returns the same publication with `replayed: true`, so retrying an unclear result
is safe. Publishing after an edit seals the new version and **supersedes** the
awaiting question with one about it.

| Input    | Type   | Required | Notes                                                    |
| -------- | ------ | -------- | -------------------------------------------------------- |
| `key`    | string | yes      | The decision card's key, e.g. `"ACME-42"`.               |
| `pageId` | string | yes      | The page id — the `<id>` in `/pages/<id>`, same project. |

**Output** — the publication: `pageId`, `pageTitle`, `versionId`,
`versionNumber`, `sealedAt`, `publishedAt`, the publisher, `gateId` (the awaiting
`decision_approval`, or `null` on a human card or a replay) and `replayed`.

| Code                      | Meaning                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `NOT_A_DECISION_CARD`     | The card's type is not `decision`.                                           |
| `PAGE_NOT_FOUND`          | No such page, or one the caller cannot read — one answer, no existence leak. |
| `PAGE_IN_ANOTHER_PROJECT` | The page is readable but filed in another project than the card's.           |
| `PAGE_IS_EMPTY`           | The page's newest version has no text.                                       |
| `PAGE_ARCHIVED`           | The page is archived.                                                        |
| `CARD_IS_FINISHED`        | The card is already in a done-category status.                               |

The confirm port's _Choose page_ reaches the same service through
`POST /api/work-items/{key}/decision-page` with `{ "pageId" }` (201 for a new
publication, 200 for a replay, the codes above with their own statuses).

### Search

#### `search_work_items`

Search a project's work items with a versioned **FilterAST envelope** — the same
filter grammar the `/issues` advanced filter and saved filters use (one codec,
N carriers). Omit `filter` to page the whole project. Cursor-paginated.

| Input        | Type               | Required | Notes                                                          |
| ------------ | ------------------ | -------- | -------------------------------------------------------------- |
| `projectKey` | string             | yes      | Project key, e.g. `"ACME"`.                                    |
| `filter`     | FilterAST envelope | no       | `{ version, combinator, conditions }`; omit for whole project. |
| `cursor`     | string             | no       | Opaque page cursor from a previous `nextCursor`.               |
| `limit`      | integer (1–50)     | no       | Page size; default 50 (the List's server cap).                 |

The `filter` envelope:

- `version` — must be the supported envelope version (`v1`).
- `combinator` — `"and"` (match all rows) or `"or"` (match any).
- `conditions` — an array (up to the row cap) of
  `{ field, operator, value }`:
  - `field` — a built-in (`kind`, `status`, `priority`, `type`, `difficulty`,
    `obsolescence`, `assignee`, `reporter`, `sprint`, `text`, `created`,
    `updated`, `due`, `storyPoints`, `estimate`), a label/component (`lbl`,
    `cmp`), or a custom field (`cf:<fieldId>`).
  - `obsolescence` (MOTIR-6583) takes `is_any_of` · `is_none_of` over
    `outdated` · `deprecated`, plus `is_empty` · `is_not_empty`. An unmarked
    card is `null`: `is_empty` selects it, and `is_none_of ["outdated"]`
    INCLUDES it alongside the `deprecated` rows. A search without the condition
    never drops or re-sorts a marked card.
  - `operator` — one of `is_any_of`, `is_none_of`, `is_empty`, `is_not_empty`,
    `contains`, `not_contains`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`,
    `on_or_before`, `on_or_after`, `between`, `in_last_days`, `in_next_days`
    (must be in the field's set).
  - `value` — by operator arity: a string list for `is_any_of`/`is_none_of`
    (and a `[from, to]` pair for `between`), a string for `contains`/
    `not_contains` and single dates (`YYYY-MM-DD`), a number for comparisons and
    `in_last_days`/`in_next_days`, or `null` for `is_empty`/`is_not_empty`.

A malformed/foreign-version envelope returns a clean filter-decode error
(`MALFORMED_FILTER` / `UNSUPPORTED_FILTER_VERSION` / `INVALID_FILTER`); an
unknown field/operator or a bad value arity returns the registry's
validation error.

**Output** — `structuredContent`:
`{ items: WorkItemListItemDto[], total: number, nextCursor: string | null }`.
Each row also carries the same [`dependencies` block](#the-dependencies-block-list-reads)
and [`commentCount`](#the-commentcount-field) `list_ready` returns — identical
shapes, so one renderer covers both lists — and the
[obsolescence mark](#the-obsolescence-mark): `obsolescence` and
`obsolescenceNoteMd`. A marked row's text line is followed by
`  obsolescence: <mark>` and `  note: <first line>`; an unmarked row reads as
before. A marked row is never excluded or re-sorted.

#### `search_work_items_semantic`

**Has this already been built?** Search a project by **meaning** rather than by
substring — ask in your own words, and Motir embeds the query for you. It sits
**beside** `search_work_items`, never over it: the substring search is unchanged
and neither replaces the other. One finds a string; this finds a meaning.

`search_work_items` is a `contains` predicate, so a query for _"persist UI
preferences"_ cannot see a card titled _"Board columns remember their collapsed
state"_ — and a capability rebuilt because of that is the most expensive planning
mistake available. Call this **before** proposing anything.

| Input        | Type           | Required | Notes                                                                       |
| ------------ | -------------- | -------- | --------------------------------------------------------------------------- |
| `projectKey` | string         | yes      | Project key, e.g. `"ACME"`.                                                 |
| `query`      | string         | yes      | What you are looking for, in your own words — a phrase, not a keyword.      |
| `limit`      | integer (1–50) | no       | Candidates to return; default 10.                                           |
| `minScore`   | number (−1…1)  | no       | Optional cosine-similarity floor. **No default**, deliberately (see below). |

There is **no `model` argument and no `queryEmbedding` argument.** The internal
`similar-work-items` route takes a vector because its caller (`motir-ai`) owns the
embedding seam; an MCP client holds a Motir token and nothing else, so
`docs/decisions/plan-tree-embeddings.md` **Amendment 2** decides that `motir-core`
embeds the query through the same `POST /v1/embeddings` seam the write path
already uses. That is not only convenience: `model` is a **hard ranking filter**,
so a caller that guessed it wrong would get an empty result indistinguishable from
_"nothing similar exists"_ — the exact failure this tool exists to remove.

**Output** — `structuredContent`:

| Field      | Type                          | Notes                                                                     |
| ---------- | ----------------------------- | ------------------------------------------------------------------------- |
| `outcome`  | see below                     | Which of four states this is. **Read this before reading `results`.**     |
| `results`  | `{ key, title, score }[]`     | Candidates, best first. `score` is cosine similarity in `[-1, 1]`.        |
| `model`    | string \| null                | The model the ranking ran in; null when nothing was embedded.             |
| `coverage` | `{ embedded, total }` \| null | Rankable rows vs live items; null when the search did not run.            |
| `message`  | string                        | A readable sentence — what this state is, and what to do on a non-answer. |

**⚠️ An empty `results` means three different things, so `outcome` is computed
for you:**

| `outcome`         | What it means                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `ranked`          | Candidates found. Read each through `get_work_item` before concluding anything about it.   |
| `nothing-similar` | The project **is** indexed and nothing is close. **This is an answer.**                    |
| `not-indexed`     | The project has no vectors. **NOT evidence that nothing exists** — fall back to substring. |
| `unavailable`     | The query could not be embedded (no AI backend, or unreachable). **The search never ran.** |

The last two are still **successful** tool results carrying a readable `message`,
never an error and never an empty ranking — a planning turn must not fail because
a candidate-finder had nothing to offer, and it must not be told nothing exists
when the truth is that nobody looked.

**Keys, titles and scores — never prose.** `plan-tree-embeddings.md` §2 binds this
surface: no `descriptionMd`, no `explanationMd`, no comment, no acceptance
criterion. The tool NAMES candidates; the keyed reads dispose of them.

**No default `minScore`, deliberately** (ADR Amendment 1): a spurious candidate
costs one keyed read, a suppressed one costs a duplicate branch of the plan.

**⚠️ It costs an AI call.** Unlike `search_work_items`, this embeds your query
through Motir's AI backend, so it draws the same per-minute allowance as the
planning chat (`ai:chat`, keyed on user + workspace — one counter across every
door). Do not call it in a tight loop; over budget, it returns a `RATE_LIMITED`
tool error naming the retry delay.

**Access + tenancy.** `projectKey` selects **within** the token's workspace.
Another tenant's key is a plain not-found — and the refusal lands **before** the
embed, so a caller who cannot browse the project never spends the deployment's
gateway budget on a refusal.

### Sprints

The eight sprint tools cover the full Scrum cadence over the Epic-4 sprint
services. Run `list_sprints` first to get a sprint's `id`; the mutating tools
require **sprint-admin** permission (enforced in the service).

#### `list_sprints`

List a project's sprints (in sequence order), each with its `id`, `name`,
`state` (planned / active / complete), `goal`, window, and issue count. The
read every other sprint tool depends on.

| Input        | Type   | Required | Notes                           |
| ------------ | ------ | -------- | ------------------------------- |
| `projectKey` | string | yes      | The project key, e.g. `"ACME"`. |

**Output** — `structuredContent`: `{ sprints: SprintDto[] }`.

#### `validate_sprint`

Check whether a sprint is **finishable**: a sprint is VALID ⟺ every in-sprint,
not-done item has its OWN `blocked_by` edges (transitively, through in-sprint
blockers) AND all of its children either `done` or also in the sprint. Two rules,
and only the first is about blockers:

- **Own blockers only (HARD blocks).** An in-sprint item is gated by its OWN
  `blocked_by` edges — each must be `done` or in the sprint — never by an
  ancestor's (MOTIR-6354 / MOTIR-6368). An ancestor's blocker reaches a
  descendant only through the readiness cascade: a SOFT block, overridable at run
  time with `--allow-soft-block`, so it does not make the sprint unfinishable. A
  blocked epic or story that is ITSELF in the sprint still gates, as its own
  member. (`validate_work_item` reports a target's soft blocks, without gating,
  in `softBlocks`.)
- **A parent needs its children.** An in-sprint, not-done parent with a child
  that is neither `done` nor in the sprint can never be finished within it, so it
  gates (MOTIR-1337). This is not a blocker rule, and it is unchanged.

Productizes the _re-validate-the-active-sprint_ rule a planning agent
runs after any plan/re-plan that touches sprint membership or a sprint item's
`blocked_by` edges. Read-only.

| Input        | Type             | Required | Notes                                                                                                                                            |
| ------------ | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `projectKey` | string           | yes      | The project key, e.g. `"ACME"`.                                                                                                                  |
| `sprintId`   | string           | no       | The sprint to validate; omit to validate the **active** sprint.                                                                                  |
| `condition`  | `loose`\|`tight` | no       | Default `loose` — a `done` gating item outside the sprint counts as satisfied. `tight` requires it to be IN the sprint, else it gates. (7.8.22.) |

**Output** — `structuredContent`: a `SprintValidityDto` —
`{ sprintId, valid, blockers }`. When `valid` is `false`, `blockers` lists each
gated in-sprint item as `{ item, blockedBy, blockerStatus, blockerSprintId }`
(the out-of-sprint, not-done work to pull in or move the gated item off). Every
entry is the gated item's OWN edge or OWN child, so no entry carries a hard/soft
label. A missing active sprint (with no `sprintId`) returns a `NO_ACTIVE_SPRINT` tool
error; an unknown `sprintId` returns `SPRINT_NOT_FOUND`.

#### `validate_work_item`

The single-item analogue of `validate_sprint`: is a work item **finishable**?
Let `S` = the target + all its descendants (its **subtree**). The item is VALID
⟺ every not-`done` item in `S` has each `blocked_by` dependency either inside `S`
(its own work) or `done`. A blocker INSIDE the subtree never gates (it is the
target's own work); only out-of-subtree work can. The target may be any non-leaf
kind — epic / story / task / bug (a `subtask` is the leaf). Read-only.

| Input       | Type             | Required | Notes                                                                                                                                                 |
| ----------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`       | string           | yes      | The work item identifier, e.g. `"ACME-7"` (case-insensitive).                                                                                         |
| `condition` | `loose`\|`tight` | no       | Default `loose` — a `done` dependency outside the subtree counts as satisfied. `tight` requires every dependency to be IN the subtree, else it gates. |

**Output** — `structuredContent`: a `WorkItemValidityDto` —
`{ key, valid, blockers, invalidEdges, crossLevelEdges, advisories, softBlocks, sectionFindings }`. When `valid` is `false`,
`blockers` lists each gated in-subtree item as
`{ item, blockedBy, blockerStatus, blockerSprintId }` (the out-of-subtree,
unsatisfied work gating it — always an item's OWN edge). An unknown /
cross-workspace key returns a `WORK_ITEM_NOT_FOUND` tool error.

`sectionFindings` (MOTIR-9032) is a second **advisory** channel: each not-`done`
subtree card whose body, parsed against the section registry for its kind × type,
misses a required section or carries one it cannot read is reported as
`{ item, state: "unstructured" | "incomplete", missing, invalid, otherHeadings, signals }`,
sorted by `item`. It never changes `valid` (a VALID verdict states the count and says
so), and with a `planId` the body is the projected one. Fix a finding by re-writing the
card with `sections` (see `get_section_sets`).

`softBlocks` (MOTIR-6354 / MOTIR-6368) is **never gating**: it lists every open
`blocked_by` edge owned by one of the target's ANCESTORS (parent → … → root) — a
block that reaches the target only through the readiness cascade, and that a run
may override with `--allow-soft-block`. Each entry is
`{ via: { key, title }, blockedBy: { key, title }, blockerStatus }`: `via` is the
ancestor that owns the edge, `blockedBy` the open item it waits on, and
`blockerStatus` that item's raw workflow status key. "Open" means not in its own
project's `done` set — the same done-ness `blockers` judges by. Entries are sorted
by `via.key`, then `blockedBy.key`; the list is empty when no ancestor is blocked.
`valid` is unchanged by it — it still answers "can this subtree finish". With
`planId` it is read over the projected ancestor chain, where a proposed ancestor
or blocker is named by its `planItem:<id>` temp-ref and proposed title.

**A cross-parent edge is VALID only when the parents carry it** (Story MOTIR-6015 ·
MOTIR-6370). A `blocked_by` joins two items on the same level and may cross
parents, but then the blocked item's parent must itself be directly `blocked_by`
the blocker's parent — and that parent edge is asked the same question one level
up, so a subtask edge across epics owes the story edge AND the epic edge.
`invalidEdges` lists every same-level `blocked_by` FROM a not-done subtree member
that fails it, as `{ item, blockedBy, itemParent, blockerParent }`. Two items
under one parent are never listed, and an end with no work-item parent (a root,
or an item filed in a folder) is exempt.

**An edge across LEVELS is INVALID — "blocked elsewhere"** (MOTIR-6509,
`docs/decisions/edge-level-is-position.md` Amendment 2). `crossLevelEdges` lists
every `blocked_by` FROM a not-done subtree member to an item on another level (a
different depth below their nearest common ancestor — the position rule of
MOTIR-6387 — or an epic paired with a non-epic, since an epic is blocked only by
another epic), as
`{ item, blockedBy, itemDepth, blockedByDepth, reason: "blocked_elsewhere", explanation }`,
each depth counted below the project root and `explanation` the sentence the plan
gate's `cross_level` refusal uses. The link doors WRITE such an edge (it holds the
item out of the ready set like any other), so this is where it is reported. The
remedy is to re-wire it to the same-level item really waited on, which may sit
under another parent, or between the two containers. A cross-level edge is never
also an `invalidEdges` entry. With `planId` it is read over the projection, where
an edge to a blocker in another project is not judged (the projection carries
that blocker without its ancestors).

```jsonc
{
  "item": "ACME-9",
  "blockedBy": "ACME-2",
  "itemDepth": 0,
  "blockedByDepth": 2,
  "reason": "blocked_elsewhere",
  "explanation": "ACME-9 sits 0 level(s) below the project root and ACME-2 sits 2, …",
}
```

**`valid` is `true` only when `blockers`, `invalidEdges` AND `crossLevelEdges`
are all empty.** A caller asking only _"can this be
finished?"_ reads `blockers` — the scope claim (`motir run <story>`) does, so a
story with an uncovered edge is still claimable and its pull request is where the
parent edge gets added. The predicate is `lib/workItems/crossParentCoverage.ts`,
the one the roadmap's "blocked elsewhere" signal reads too.

`advisories` is the **prose-vs-graph** channel (MOTIR-1969) and is **never a
blocker**. It carries the same two families the dispatch surfaces return (see
[the dispatch advisories](#the-dispatch-advisories) for the full shape), except
that this surface reports **both reference tiers** rather than the
acceptance-criteria one alone.

A `reference` entry is `{ item, referenced, referencedStatus, severity }`, where
`item` is the card whose body names `referenced`, and `severity` is:

| severity              | trigger                                                       |
| --------------------- | ------------------------------------------------------------- |
| `advisory`            | the not-`done` item is named anywhere in the body             |
| `likely-missing-edge` | it is named inside the card's own acceptance-criteria section |

A `shape` entry (`kind: "shape"`) reports a defect the card asserts about
ITSELF, with no second work item involved: `likely-ordering-violation` (a
criterion carrying a merge-word — cut there; a partial tell whose absence clears
nothing, since a criterion phrased as EVIDENCE — "against real runs", "quoted
here" — carries none), `likely-repo-straddle`
(a criterion naming a path outside the card's `targetRepo` — split per repo), or
`likely-over-gate-sizing` (a childless `coding_agent` card at `storyPoints >= 13`
or `estimateMinutes > 70` — split by size), or `likely-self-blocking-design` (a
childless card one of whose criteria produces a design asset while another builds
the rendered surface it draws — LIFT the design criterion onto its own
`type: design` card), `likely-blocker-count-mismatch` (an explicit counted
claim about the card's own blocker siblings that disagrees with its `blocked_by`
edges), or `body-edit-above-field-move` (the card's newest body write moved none
of the fields a body describes while the write beneath it did — RE-READ the body
against that move; read off the card's revision trail, and a prompt rather than a
defect claim). The first two carry the `criterionIndex` they cut at; the third
carries `threshold`, `storyPoints` and `estimateMinutes`; the fourth carries
`designCriterionIndex` and `surfaceCriterionIndex`; the blocker-count member
carries the exact `claim`, its `claimedCount` and the graph's current
`blockerCount`; the body-edit member carries `bodyEdit` and `fieldMove`. Only two
of the six carry `criterionIndex`, so narrow on `severity` before reading one.

One more `shape` member is reported by `validate_work_item` and `validate_plan`
only, never on the dispatch wire: **`likely-mislabelled-link`** (MOTIR-9007). A
body link `[label](motir:<id>)` whose `label` names one or more work-item keys
(a token whose prefix is a project identifier in the workspace) none of which
is the key `<id>` actually opens — or whose `<id>` opens no work item the caller
can read. It carries the link's `label`, its `targetId`, and `targetKey`: the
key the id resolves to, or `null` when it resolves to nothing (an unknown id,
another workspace's id and an unbrowsable id all read the same, so the advisory
leaks no existence). A label that names no key — `[the export flow](motir:…)` —
is never checked. Fix the id (resolve the key you meant with `get_work_item`) or
the label; a link that opens the wrong card is consumed by every agent that
reads the body.

A `subsumption` entry (`kind: "subsumption"`) reports that a path this card's
body names is being changed SOMEWHERE ELSE — the one advisory family whose far
end is a pull request rather than a work item. It carries `state`, which is the
disposition: **`"merged"`** (`likely-already-shipped`, with an ISO-8601
`mergedAt`) means read that diff and close the card if it is subsumed, while
**`"open"`** (`likely-in-flight`, with `mergedAt: null`) means somebody is
editing that file right now — coordinate rather than filing a second card or
cutting a branch to fix it yourself. See
[the dispatch advisories](#the-dispatch-advisories) for the full shape, the two
arms' different time semantics, and what path capture cannot see. A card whose
body opts out (`isSubsumptionCheckExempt`) is never reported.

A `title-coverage` entry (`kind: "title-coverage"`, severity
`likely-unnamed-title-part`) is the other half of the same question: a
CONTAINER's body never mentions one or more distinguishing words its own TITLE
carries. Everything laid under a container is laid against its body, so a body
that silently drops a part of the title narrows the whole subtree with nothing
marking it as a choice. It carries `words` (stemmed), and the remedy is to
restore the part in the body or state it as excluded with the work item that
owns it. A body that mentions a part only to hand it to another work item
counts as naming it. Advisory only; it never gates.

A `coverage` entry (`kind: "coverage"`, severity `likely-unowned-criterion`) is
the one family about a CONTAINER's relationship to its children: one of its
acceptance criteria has no direct child whose TITLE carries that criterion's
distinguishing words (at least two of them, or its only one). It is emitted only
when at least one child was created BEFORE the container — an ADOPTED work item,
scoped and sealed against a different parent, which is the population where a
criterion goes unowned while every child is green. It carries `criterionIndex`
(numbered as the shape checks number criteria) and `adoptedChildren`, and the
remedy is to widen the adopted work item on the record or file the sibling that
covers the difference. Two kinds of criterion are never reported: one with no
distinguishing word, and one that quantifies over the children themselves
(_"Each story carries its own ADR"_). It reads child TITLES rather than bodies
by measurement (MOTIR-5362): bodies name a container's nouns as context and as
explicit non-scope, which read every unowned criterion on the live tree as
owned. So its false-positive class is a child whose body delivers a criterion
under a title that does not name it. It rides this tool only — the dispatch
surfaces hand out leaves, which have no children.

It answers on both paths. With `planId` it runs over the PROJECTED subtree
(MOTIR-5403): a container's criteria are the plan's body where the plan sets
one, a child's title is its proposal's or a `modify`'s patched `title`, and
adoption compares filing instants with a proposal filed at approve, after every
stored row. So a proposed child is never adopted, and an existing work item a
`modify` re-parents under a container (`patch.parentRef`) is adopted exactly
when it predates that container. That is the moment the check exists for: an
author re-parenting an existing card under a story sees the criterion that card
does not own before sealing the plan, not after approve.

A `path-reference` entry (`kind: "path-reference"`, severity
`likely-missing-path-edge`) is the reference family's PATH arm: the key-based
reference check sees a sibling only when a body names it by `MOTIR-<n>`, and a
criterion that cites a sibling's deliverable by FILE PATH — a design mock, a test
helper — is the same missing edge with nothing for that check to key on. It
fires for a card when one of its acceptance criteria names a repository file
path that (a) does NOT exist on the default branch of the card's own repository,
(b) sits under a top-level directory that DOES exist there, and (c) is also named
anywhere in the body of ANOTHER not-done work item in the project that shares a
repository with the card — with no `blocked_by` between the two, directly or
between any of their ancestors, and neither an ancestor of the other. It carries
the `path`, the `criterionIndex`, the `repo`, and the other item as `referenced`
/ `referencedStatus`, one entry per other item; the remedy is to wire
`blocked_by` from the card that CITES the file to the card that CREATES it.
Clause (c) is the discriminator: a path that does not exist yet is usually named
by exactly one work item, the card that will create it, and that card is never
reported. Clause (b) keeps out a file from somewhere else — a third party's
source cited as evidence, a repo-qualified spelling, a URL — because a forward
reference lands in a directory the repository already has. Existence is asked of
the repository host through the connected GitHub App; an unconnected repository,
a card pinning no repository, or a host that does not answer produces no entry
rather than a guess. It rides this tool only, and only without `planId`.

`valid`, `blockers`, and an item's readiness are **identical** whether or not
advisories are emitted, at EVERY severity — a card legitimately names cards it
does not depend on (out-of-scope sections, context refs, contrast references, a
boundary-contract card naming both halves of a two-PR split), so this reports the
gap without enforcing it. Wire a `blocked_by` edge if the card really consumes
the reference; ignore the advisory if the reference is context only. A `done`
reference, a self-reference, an ancestor, and anything already in the
`blocked_by` set never produce one. **Blind spots:** the reference check reads
`descriptionMd` only, so a `type: decision` card's deferrals — which live in the
document it produces, not in its card body — are outside its reach; and
`likely-repo-straddle` sees only repo-QUALIFIED paths, never a bare symbol whose
repo a reader happens to know. `likely-over-gate-sizing` has no blind spot of
that kind — its input is two integer columns and an enum — and it has no opt-out,
because a mute would put the answer back into a field nothing reads. But cheap
inputs are not an exact reading: its POINTS arm is the gate's rule and its
MINUTES arm is a proxy with a real false-positive class, since `estimateMinutes`
sums agent time and CI time while the gate ceilings the agent run alone
(MOTIR-3271, correcting the claim that this member had no false-positive class).
`likely-self-blocking-design` reads criterion PROSE, so it has the opposite
profile: a real false-positive class (a card amending an asset and adjusting the
one surface that reads it), accepted deliberately because the channel never
gates — a blocking version would hold out of the ready set exactly the card a
re-plan is in the middle of splitting.

#### `create_sprint`

Create a **planned** sprint (it starts empty). Scope it with `move_to_sprint`,
then `start_sprint`.

| Input        | Type   | Required | Notes                                           |
| ------------ | ------ | -------- | ----------------------------------------------- |
| `projectKey` | string | yes      | Project key.                                    |
| `name`       | string | no       | Defaults to `"Sprint <n>"` (the next sequence). |
| `goal`       | string | no       | Sprint goal.                                    |
| `startDate`  | string | no       | Planned start (ISO-8601).                       |
| `endDate`    | string | no       | Planned end (ISO-8601); must be ≥ `startDate`.  |

**Output** — `structuredContent`: the created `SprintDto`.

#### `update_sprint`

Rename, re-goal, or re-date a sprint. A completed sprint is frozen; an active
sprint can still have its goal/window changed. Omit a field to leave it
unchanged; pass `null` to clear the goal or a date.

| Input       | Type           | Required | Notes                                                             |
| ----------- | -------------- | -------- | ----------------------------------------------------------------- |
| `sprintId`  | string         | yes      | The sprint id (from `list_sprints`).                              |
| `name`      | string         | no       | New name; omit to leave unchanged.                                |
| `goal`      | string \| null | no       | `null` clears; omit to leave unchanged.                           |
| `startDate` | string \| null | no       | ISO-8601; `null` clears; omit to leave unchanged.                 |
| `endDate`   | string \| null | no       | ISO-8601 (≥ `startDate`); `null` clears; omit to leave unchanged. |

**Output** — `structuredContent`: the updated `SprintDto`.

#### `delete_sprint`

Delete a **planned or complete** sprint. Its issues are **not** deleted — they
fall back to the backlog in their existing order. The **active** sprint cannot
be deleted; complete it instead.

| Input      | Type   | Required | Notes          |
| ---------- | ------ | -------- | -------------- |
| `sprintId` | string | yes      | The sprint id. |

**Output** — `structuredContent`: `{ sprintId: string, deleted: true }`.

#### `move_to_sprint`

Add a bulk selection of work items to a sprint in one atomic move (all or none),
appended in selection order. All items must belong to the sprint's project.

| Input      | Type             | Required | Notes                                              |
| ---------- | ---------------- | -------- | -------------------------------------------------- |
| `keys`     | array of strings | yes      | Work item identifiers, e.g. `["ACME-7","ACME-8"]`. |
| `sprintId` | string           | yes      | The target sprint id.                              |

**Output** — `structuredContent`: `{ items: WorkItemDto[] }` (the moved items).

#### `move_to_backlog`

The inverse of `move_to_sprint`: move a bulk selection out of their sprint and
back to the backlog in one atomic move. Each item keeps its backlog order; an
item already in the backlog is a no-op.

| Input  | Type             | Required | Notes                                         |
| ------ | ---------------- | -------- | --------------------------------------------- |
| `keys` | array of strings | yes      | Work item identifiers to move to the backlog. |

**Output** — `structuredContent`: `{ items: WorkItemDto[] }` (the moved items).

#### `start_sprint`

Activate a planned sprint. A project can have only one active sprint at a time;
only a planned sprint is startable. Optionally rename/re-goal and set the window
on start.

| Input       | Type           | Required | Notes                                 |
| ----------- | -------------- | -------- | ------------------------------------- |
| `sprintId`  | string         | yes      | The sprint id.                        |
| `name`      | string         | no       | Rename on start.                      |
| `goal`      | string \| null | no       | Goal edit on start; `null` clears it. |
| `startDate` | string         | no       | ISO-8601; defaults to now.            |
| `endDate`   | string         | no       | ISO-8601; must be ≥ `startDate`.      |

**Output** — `structuredContent`: the updated `SprintDto`.

#### `complete_sprint`

Close out an active sprint. Only an active sprint is completable. Done items stay
on the completed sprint as its record; unfinished items carry over. The
carry-over disposition is **required** — there is no default.

| Input         | Type                                    | Required | Notes                                                                                      |
| ------------- | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `sprintId`    | string                                  | yes      | The sprint id.                                                                             |
| `carryOverTo` | `"backlog"` \| `{ "sprintId": "<id>" }` | yes      | Where unfinished items go: the backlog, or another **planned** sprint in the same project. |

**Output** — `structuredContent`: the updated `SprintDto`.

### AI planning

#### `expand_item`

Submit an **AI expansion** of one container work item — the planner drafts the
children it should have. This is the MCP surface for the same capability the
"Expand" action in Motir fires; an unattended CLI run uses it to grow its own
backlog when the ready set drains.

| Input | Type   | Required | Notes                                                                                |
| ----- | ------ | -------- | ------------------------------------------------------------------------------------ |
| `key` | string | yes      | The container's identifier, e.g. `"ACME-7"`. Epic / story / task / bug — not a leaf. |

**Output** — `structuredContent`: `{ jobId, planId }`.

**It submits and returns.** The call resolves the moment motir-ai accepts the
job — it never streams and never polls. The browser surfaces stream because a
human is watching a comet fill in; a headless caller has nobody to show it to,
and an agent blocked on an LLM run is an agent not working. Use
`get_plan_status` to find out what became of it.

> **⚠️ This does NOT create work items.** The job produces a **`Plan` of
> proposals**. `approvePlan` — a human decision made in Motir, not on this
> surface — is the only path from a proposal to a work item, and an `add`
> proposal's `workItemId` stays `null` until then. Firing this tool, and polling
> it all the way to `planned`, both leave the tree byte-for-byte unchanged. Do
> not report proposed children as created.

Errors: a leaf target (or one outside the caller's project) returns
`INVALID_TARGET` / `NOT_FOUND`; a refused job returns the motir-ai code verbatim
— `MOTIR_AI_OUT_OF_CREDITS` (buy credits; do not retry) or
`MOTIR_AI_UNAVAILABLE` (retryable). The job runs on the **token owner's** AI
credits, and draws the shared **`ai:generate`** budget (see
[Rate limits](#rate-limits)) — the same one the "Expand" button in Motir spends,
so a loop here cannot be paid for out of a looser allowance. Over budget returns
a `RATE_LIMITED` tool error _before_ the job is submitted; retry after the
seconds it names. Requires `ai:plan` — the permission that exists precisely so a
token allowed to file work items can still be denied a billable planning submit.

Two different limits, and they compose: `ai:plan` decides whether this token may
submit at all, `ai:generate` decides how much the workspace has left to spend.

#### `get_plan_status`

Read what became of a submitted planning job. The come-back-later half of
`expand_item`, for a client with no stream to hold open.

| Input    | Type   | Required | Notes                                                      |
| -------- | ------ | -------- | ---------------------------------------------------------- |
| `planId` | string | one of   | The plan id the submit returned. Pass this **or** `jobId`. |
| `jobId`  | string | one of   | The job id the submit returned. Pass this **or** `planId`. |

Exactly one of the two — both come out of the same `expand_item` result, and
passing both (or neither) returns `BAD_REQUEST`.

**Output** — `structuredContent`:
`{ planId, projectId, status, origin, jobId, itemCount, createdAt, plannedAt, decidedAt, job }`.

- **`status`** — the plan's own status: `generating` · `planned` · `approved` ·
  `declined`.
- **`itemCount`** — how many **proposals** the plan bundles. **Not** a count of
  created work items; see the gate note above.
- **`job`** — the motir-ai job's state, present **only while `status` is
  `generating`** (a settled plan's job already delivered, so it is never probed):
  `{ status, reachable, failure }`. This block exists because **a failed job
  writes no terminal plan state of its own** — so the plan status alone would
  strand a poller. An abandoned plan is settled to `declined` by a background
  reconciler within the hour (MOTIR-3064), but only eventually and only when it
  holds no proposals; this block is how a client polling a live submit learns
  its run died _now_.
  `reachable: false` means motir-ai itself could not be asked and `failure`
  describes _that_ outage, not a job failure; the plan read still answers.

A pure read. Errors: an unknown / other-tenant plan id returns `PLAN_NOT_FOUND`
and an unknown job id `NO_PLAN_FOR_JOB` — the same 404-not-403 contract every
other tool keeps. Requires `project:browse`.

#### `get_plan`

Read a plan **with the proposals it bundles** — what the planning pass actually
proposed, not just how many items it produced.

| Input             | Type    | Required | Notes                                                                                                       |
| ----------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `planId`          | string  | yes      | The plan id — from an `expand_item` submit, `get_plan_status`, or Motir.                                    |
| `includeSections` | boolean | no       | Default `false`. `true` also returns `parsedSections`, keyed by plan item id, for every `add` (MOTIR-9033). |

With `includeSections`, `structuredContent.parsedSections[<planItemId>]` holds each
`add` proposal's body parsed at read time (`{ sections, found, missing, invalid,
signals }`, the kind defaulting as the plan doors default it), and each `add` line
ends ` · sections missing: …` or ` · sections: complete`. `modify` and `remove`
proposals are not parsed, `items[]` is untouched, and an unasked call is unchanged.

**Which one to reach for:** `get_plan_status` answers _"what became of the job I
fired?"_ — a status, a count, and (while generating) whether the job died. It is
the poll. **`get_plan` answers _"what did it propose?"_** — the items themselves,
so a headless client can SHOW or judge the content instead of sending its user to
a browser. Neither takes a decision on the plan.

**Output** — `structuredContent`: the `PlanWithItemsDto` — the plan
(`id, projectId, status, title, summary, sourceJobId, origin, itemCount, createdAt, plannedAt, decidedAt, decidedById, decisionReason`)
plus `items[]`, one entry per proposal:

- **`op`** — `add` · `modify` · `remove`.
- **`proposedFields`** (`add`) — the new node's values: `title`, `kind`, `type`,
  `priority`, `executor`, `storyPoints`, `estimateMinutes`, `difficulty`,
  `descriptionMd`, `explanationMd`. The one-line render shows a leaf's size and
  difficulty together, e.g. `(3 pts · 40m · high)`.
- **`patch`** (`modify`) — only the CHANGED fields. A proposed MARK rides here
  (`obsolescence`, `obsolescenceNoteMd`, `supersedesAdd` / `supersedesRemove` /
  `supersededByAdd` / `supersededByRemove`), and the one-line render prints it as
  `mark: none → outdated · note: <first line> · supersedes +ACME-3 −ACME-4 ·
superseded by +ACME-9` — the old mark read from the target's live row, each ref
  by its key.
- **`supersedesRefs`** (`add`) — the older cards the new card replaces; rendered
  as `· supersedes ACME-3, ACME-4`. `[]` on every other op.
- **`workItemId`** — the target of a `modify` / `remove`; **`null` for an
  un-materialized `add`**.
- **`decisionReason`** — on a `declined` plan, WHY it ended: `reviewed` (a
  person read a finished plan and said no), `discarded` (a person ended one that
  never finished generating) or `abandoned` (Motir terminated one whose producer
  was gone). `null` on every other status, and on a plan declined before the
  field existed. **It is the difference between a decision to respect and a
  failure to retry**, and the status alone cannot tell you which you have.
- **`parentRef`** / **`blockedByRefs`** — each a real `work_item.id` **or** an
  intra-plan temp-ref `planItem:<planItemId>` pointing at another `add` in the
  same plan. Resolve the temp-refs against `items[].id` to rebuild the proposed
  tree and its dependency edges; the text block renders exactly that, indented.
  A `parentRef` may also be **`folder:<folderId>`** — the proposal is FILED into
  that folder rather than hung under a work item — and is returned verbatim.
- **`folderId`** / **`folderPath`** — the folder a proposal NAMES as its placement
  (an `add`'s `parentRef` or a `modify`'s `patch.parentRef` = `folder:<id>`) and
  that folder's names, root first (`["Parked", "2025"]`). Both `null` for a
  proposal that names no folder; `folderPath` alone is `null` when the folder was
  deleted after the plan was written — approve refuses such a plan. The text block
  groups folder-placed proposals under a `Folder: Parked ▸ 2025:` heading beside
  the committed-parent groups, and marks a deleted one.

A plan still `generating` returns the proposals that have arrived **so far**
rather than erroring — proposals stream in, so a caller polling the content sees
it fill.

> **⚠️ These are PROPOSALS, not work items.** Nothing in `items[]` exists in the
> tree. Approving the plan in Motir is the only path from a proposal to a
> `work_item` row, and an `add`'s `workItemId` stays `null` until then. Titles and
> sizing that read like work items are still proposals — do not report them as
> created.

A pure read. Errors: an unknown / other-tenant plan id returns `PLAN_NOT_FOUND`
(404-not-403, no existence leak). Requires `project:browse`.

#### `get_approved_shape_verdict`

Is this work item **still what the last approved plan approved?** The question a
run that finds its card unbuildable asks BEFORE it blames the planner (Story
MOTIR-5544 · MOTIR-6227). Returns the card's plan history, the last `approved`
plan that shaped it, and a verdict computed on the server.

| Input           | Type     | Required | Notes                                                                                                                             |
| --------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `key`           | string   | yes      | The work item identifier (`ACME-7`), case-insensitive.                                                                            |
| `childKeys`     | string[] | no       | Keys of `key`'s CHILDREN to judge as well — at most 49. Each must be a direct child of `key`; one that is not is refused by name. |
| `historyCursor` | string   | no       | A `planHistory.nextCursor` from a previous call, for the next page of the history. The verdict is always over the WHOLE history.  |

**Output** — `structuredContent`:

- **`key`**, **`workItemId`** — the card asked about.
- **`verdict`** — `unchanged` · `changed` · `no_plan`.
- **`planId`**, **`planTitle`**, **`decidedAt`** — the APPROVING plan: the
  latest `approved` plan in the card's history. All three `null` on `no_plan`.
- **`proposalId`** — that plan's proposal naming the card (`add` / `modify` /
  `remove`); `null` when the plan only added children under it.
- **`divergingRevision`** — on `changed`, the FIRST revision after `decidedAt`
  that departed from what the plan approved:
  `{ id, changedAt, changedById, changeKind, changedKeys }`. `changedKeys` is
  every key that revision wrote, not only the ones that count. `null` when
  nothing diverged — and also on a container that is `changed` by its child set
  ALONE.
- **`childSet`** — for a container (a card with children now, or children the
  plan approved): `{ verdict, approvedChildIds, currentChildIds, added, removed }`,
  card ids, each list sorted. `null` for a leaf.
- **`planHistory`** — the card's plan-history page, oldest plan first:
  `{ items, nextCursor }`, each item `{ planId, planTitle, planStatus, createdAt,
plannedAt, decidedAt, decidedById, decidedByName, author, relation: { op,
childCount }, proposalIds: { self, children } }` — the same page the item's
  Plan history panel reads.
- **`children`** — one verdict per `childKeys` entry, in the order given, each
  the same shape as the card's own verdict fields above (with its `key`).

**`no_plan` is an ANSWER, not an error.** The card was never shaped by an
approved plan — no plan touched it, or only plans that are still open or were
declined. It comes back as a successful result with `planId: null`.

**THE CHANGE DEFINITION — what counts against what the plan approved.** The
verdict walks the card's revision log after `decidedAt`, oldest first, and stops
at the first revision that is a change:

- **Counts:** an edit to `title`, `descriptionMd`, `explanationMd`, `kind`,
  `type`, `executor`, `storyPoints`, `estimateMinutes`, `difficulty`, `priority`
  or the target repository; a move to another parent or folder; a **blocked-by**
  edge added or removed; an **archive** (or an unarchive, when the plan was the
  one that removed the card); a child permanently deleted; and, for a container,
  a child **added** or **removed** against the set the plan approved.
- **Does not count:** status transitions, sprint and rank moves, assignee,
  reporter, due date, labels, components, to-dos, attachments, comments, custom
  fields, and `relates_to` links. Work happening ON a card is not a change TO it.

When the approving plan did not create a container (it amended it, or only added
children), the children it already had count as approved.

**Refusals**, each with its code:

- an unknown key, or a key in another workspace → the same `PROJECT_NOT_FOUND` /
  `WORK_ITEM_NOT_FOUND` every work-item tool returns (404-not-403 — nothing
  distinguishes "absent" from "not yours");
- a caller without `ai:view_plan` → `PERMISSION_DENIED` naming the key (or
  `PERMISSION_NOT_GRANTED` at the token gate) — never an empty history and never
  `no_plan`;
- a `childKeys` entry that is not a child of `key` → `APPROVED_SHAPE_NOT_A_CHILD`
  naming it — never silently dropped and never answered;
- a malformed `historyCursor` → `INVALID_PLAN_HISTORY_CURSOR`.

A PURE READ, safe to repeat: it files nothing, transitions nothing and creates
nothing — what to do with the verdict is the caller's. Requires **`ai:view_plan`**,
which is deliberately NOT in `CLI_TOKEN_GRANT`: a dispatched agent is not this
tool's caller (`docs/decisions/run-findings-protocol.md` Q3).

#### `report_unbuildable_target`

A dispatched runner's report that the card it stopped on **cannot be built as
written** (Story MOTIR-5544 · MOTIR-6286). It is called by a dispatched runner,
once, right after it comments on the card in its card-is-wrong steps — the
server does the rest (`docs/decisions/run-found-trigger-dispatched-path.md`).

| Input        | Type   | Required | Notes                                                                                            |
| ------------ | ------ | -------- | ------------------------------------------------------------------------------------------------ |
| `projectKey` | string | yes      | The card's project key, resolved in the caller's workspace. Case-insensitive.                    |
| `targetKey`  | string | yes      | The card the runner stopped on (`ACME-7`). Case-insensitive.                                     |
| `reason`     | string | yes      | What is wrong with the CARD — the same text as the runner's comment. 1–4000 characters, trimmed. |

**Output** — `structuredContent` is an acknowledgement and nothing else:

```json
{ "acknowledged": true, "recordedOnRun": true }
```

`recordedOnRun` is `true` when the card had an open leg on a running dispatch
run, and `false` otherwise (a call from outside a dispatch records nothing). The
answer is the same whatever the server concluded: it **returns nothing to act
on** — never a verdict, a plan or a bug key.

It spends nothing, and it is **safe to repeat — one record per leg**: a repeated
report on the same leg returns the same acknowledgement and records nothing more.

**Refusals**, each with its code:

- a `reason` that is empty or over 4000 characters once trimmed →
  `RUN_FOUND_REPORT_REASON_INVALID`;
- an unknown key, or a key in another workspace → the same `WORK_ITEM_NOT_FOUND`
  every work-item tool returns (404-not-403);
- a caller who may read but not edit the card → `PERMISSION_DENIED`.

Requires **`work_item:edit`**, which `CLI_TOKEN_GRANT` already carries — a token
from `motir login` reaches it without widening the grant.

**A dispatched agent usually does not call it** (MOTIR-8698, the record's
AMENDMENT 1). An agent `motir run` starts is handed `$MOTIR_AGENT_REPORT`, writes
its reason there as `"unbuildable"`, and the CLI makes the same report with the
run's own credential through `POST /api/v1/dispatch-runs/{id}/unbuildable` — the
only way a hosted or agent-instance run can, since its agent holds no Motir token.
This tool is the fallback for an agent with no such file.

#### `record_run_discrepancy`

A dispatched runner's record of **what it built differently from the plan**
(Story MOTIR-8651 · MOTIR-8657). It is called when the run built the card
through a plan that was wrong only about the HOW — the card's outcome and
acceptance criteria held (`docs/decisions/run-findings-protocol.md`, the
MOTIR-8654 amendment). It is called **once, after building and before the pull
request**.

| Input    | Type   | Required | Notes                                                                                                             |
| -------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `key`    | string | yes      | The card the run built (`ACME-7`). Case-insensitive.                                                              |
| `points` | array  | yes      | 1–20 entries of `planAsked`, `built` and `why`; each field is non-empty text of at most 2000 characters, trimmed. |

**Output** — the id of the card comment the server wrote, and whether the run
record was written too:

```json
{ "commentId": "…", "recorded": true }
```

`recorded` is `false` when the card had no open leg on a running dispatch run:
the comment is still written, and nothing is put on a run.

**One record per leg**: a second call on the same leg is refused with
`DISCREPANCY_ALREADY_RECORDED` and writes nothing more. Other refusals:

- an empty `points`, more than 20, or a field that is empty or over 2000
  characters → `RUN_DISCREPANCY_INVALID`;
- an unknown key, or a key in another workspace → `WORK_ITEM_NOT_FOUND`
  (404-not-403);
- a caller who may read but not edit the card → `PERMISSION_DENIED`.

If the WHAT itself cannot be built, this is the wrong tool: stop and use
`report_unbuildable_target`.

Requires **`work_item:edit`**, which `CLI_TOKEN_GRANT` already carries.

**A dispatched agent with no Motir tools does not call it** (MOTIR-8722,
`run-found-trigger-dispatched-path.md` AMENDMENT 2). A hosted or agent-instance run's
agent holds no Motir token, so it writes its points into `$MOTIR_AGENT_REPORT` as
`"discrepancy"`, and the CLI records them with the run's own credential through
`POST /api/v1/dispatch-runs/{id}/discrepancy`. Its STOP goes the same way, as `"stop"`,
through `POST /api/v1/dispatch-runs/{id}/stop`: the comment and the move to Planning,
with the re-plan brief kept on the card. That path does not submit the re-plan, because a
run's credential cannot plan.

#### Authoring a plan YOURSELF — `create_plan` · `add_plan_items` · `update_plan_item` · `update_plan_proposal` · `withdraw_plan_proposal` · `update_plan` · `record_plan_revision_reason` · `report_plan_step` · `hold_plan_revision`

The three tools above hand a **prompt** to Motir's planner and let it decide the
tree. These two are the other door: **you decide the tree, and Motir reviews it
exactly like any other plan.** Reach for them when you have already decomposed
the work — you are sitting in the repository with the code in front of you, which
is the position from which planning is easiest and Motir's own generator is not.

The comparison that matters is with `create_work_item`, not with the
conversation tools:

|                            | `create_work_item`             | `create_plan` + `add_plan_items`                         |
| -------------------------- | ------------------------------ | -------------------------------------------------------- |
| what lands                 | a `work_item` row, immediately | a `Plan` of proposals                                    |
| review                     | none                           | a person reads the tree and Approves / Declines in Motir |
| AI credits                 | none                           | none — no job runs, no prompt is assembled               |
| who is recorded as planner | `mcp` + the harness you report | the same, on the plan AND on every item it creates       |

##### `create_plan`

Open a `generating` plan on a project — the container you then fill.

| Input                | Type   | Required | Notes                                                                |
| -------------------- | ------ | -------- | -------------------------------------------------------------------- |
| `projectKey`         | string | yes      | The project key, e.g. `"ACME"`. Case-insensitive.                    |
| `title`              | string | no       | A short label — what this plan proposes, in a line.                  |
| `summary`            | string | no       | A longer Markdown summary, shown to the reviewer above the tree.     |
| `plannedWithHarness` | string | no       | The harness you run as, e.g. `"Claude Code"`. Shown to the reviewer. |
| `plannedWithModel`   | string | no       | The model you run, e.g. `"claude-opus-5"`. Shown beside the harness. |

**Output** — `structuredContent`: the plan (`id`, `status: "generating"`,
`projectId`, `title`, `summary`, `origin`, `itemCount`, `authorSource`,
`authorHarness`, `authorModel`, the lifecycle timestamps).

**The authorship is recorded, and it is not something you can claim.**
`authorSource` is set to `mcp` **server-side** — exactly as `create_work_item`
fixes its own `source` — so the two arguments you do supply are the harness and
the model, self-reported and stored as given. This is what the Plans list and the
plan-detail header show: a reviewer can see they are approving an agent's plan
rather than a Motir generation. When the plan is approved, every work item it
creates carries the same triple (`mcp · <harness> · <model>`).

Requires **`work_item:edit`** — the permission `plansService.createPlan` itself
asserts, even though no work item is created here.

##### `add_plan_items`

Append a batch of proposals, and optionally close the plan.

| Input       | Type    | Required | Notes                                                                                     |
| ----------- | ------- | -------- | ----------------------------------------------------------------------------------------- |
| `planId`    | string  | yes      | The id `create_plan` returned.                                                            |
| `proposals` | array   | yes      | The batch to append; see the shape below. **May be empty — but only with `final: true`.** |
| `final`     | boolean | no       | `true` on the LAST batch — closes the plan (`generating` → `planned`).                    |

Each proposal is `{ op, proposedFields?, workItemId?, patch?, parentRef?, blockedByRefs?, supersedesRefs?, baseRevision?, reason? }`
— the same shape `get_plan` returns, minus the fields the server owns:

- **`op`** — `add` · `modify` · `remove`.
- **`proposedFields`** (`add`, required) — `title` (required), `kind`,
  `descriptionMd`, `explanationMd`, `type`, `priority`, `executor`,
  `storyPoints`, `estimateMinutes`, `difficulty`, `targetRepo`, `targetRepos`,
  `targetRepositories`, `targetRepoRole`, `todos`.
- **`proposedFields.difficulty`** (leaf kinds only, MOTIR-6136) — how hard the
  card is to **REASON about**, not how big it is (that is `storyPoints` /
  `estimateMinutes`): `trivial` · `low` · `medium` · `high`, easiest first. The
  members are the schema enum, so any other value is refused at the schema
  naming the field. A value on an `epic` or `story` is refused with the typed
  `INVALID_PROPOSAL` naming `difficulty` — never silently dropped — and the check
  runs on the MERGED kind wherever a proposal is edited. A `modify`'s `patch`
  takes `difficulty` too, judged against the target's kind; `null` there clears
  it. Approving the plan writes it onto the created or modified work item.
- **`proposedFields.targetRepos` / `targetRepositories`** — the repository SET a
  card ships in, ORDERED, element 0 the PRIMARY (bug MOTIR-4904). The same axis
  and the same three spellings `create_work_item` takes, validated at approve
  against the project's repository domain by the same resolvers, and **mutually
  exclusive** with `targetRepo` and with each other — supplying two is
  `CONFLICTING_TARGET_REPO_INPUT` at the append rather than a precedence rule at
  approve. A `modify`'s `patch` takes both keys with the same meaning.
  **Until this bug was fixed a repository set could not be PROPOSED at all**: a
  planning pass may not use the direct write door, so a card that legitimately
  spanned two repositories could only be given its set after approval, with
  `update_work_item` — a field the approver never saw, written into a card they
  had already approved. `update_plan_item` (the deepen turn) still refuses all
  three, deliberately: a deepen may not change where a card SHIPS.
- **`proposedFields.todos`** (`add` only, leaf kinds only) — the card's **ORDERED
  STEPS**, written as its to-do list. **Array order is list order**, and
  approving the plan writes one real to-do row per element, none ticked. A
  `manual` card's steps belong here rather than only in the description: the
  reviewer reads the list they will tick before approving it, and the created
  card carries it from birth. Each row is
  `{ text, notesMd?, commandText?, executor? }` — one OPERATION per `text`
  (≤ 200 chars), the how in `notesMd` (≤ 2000), the command to copy in its own
  `commandText` (≤ 500) rather than inside the text, and `executor` only where
  the step differs from the card's (it inherits the proposal's, then `human`).
  A non-empty `todos` on a container kind is refused.

  ```jsonc
  proposedFields: {
    title: 'Provision the Stripe restricted key',
    kind: 'task', type: 'manual', executor: 'human',
    todos: [
      { text: 'Create a restricted API key' },
      { text: 'Scope it to charges:write', notesMd: 'Dashboard → Developers → API keys.' },
      { text: 'Set the deployment secret', commandText: 'fly secrets set STRIPE_KEY=… -a motir',
        executor: 'coding_agent' },
      { text: 'Confirm a test charge succeeds' },
    ],
  }
  ```

- **`workItemId`** / **`patch`** / **`baseRevision`** — for a `modify` / `remove`.
  `baseRevision` is the target's `revision` as `skeleton` returns it. A value that
  is not a revision of the target — a timestamp such as the card's `updatedAt`, a
  work-item id, another card's revision — is refused `INVALID_PROPOSAL` at the
  append, because it could never match and would flag the proposal "may be out of
  date" from the moment it was written (MOTIR-9603). An id taken from the card's
  history that names a pure status move is accepted and stored as the newest
  revision at or before it that is not one, which is what the staleness check
  compares against.
- **`parentRef`** / **`blockedByRefs`** — a work-item **key** (`ACME-7`, resolved
  to its id at the append — keys are accepted, not refused), a real
  `work_item.id`, **or** an intra-plan temp-ref `planItem:<id>`.
- **`parentRef` may instead be `folder:<folderId>`** — FILE the proposal into a
  folder of the plan's project rather than under a work item (MOTIR-5414). A filed
  card is a root, and a folder admits **any** kind, `subtask` included. The same
  form is accepted on a `modify`'s `patch.parentRef` (file a committed item into
  a folder) and on `update_plan_proposal`'s `parentRef`. It is judged **at the
  append**: a folder id naming nothing in this workspace is refused as
  `INVALID_PLAN_REF_GRAPH` (`dangling`), another project's folder as
  `PLAN_GRAMMAR_VIOLATION` (`illegal_parent`), and a `folder:` ref in
  `blockedByRefs` / `patch.blockedByAdd` / `patch.blockedByRemove` as
  `INVALID_PLAN_REF_GRAPH` — a folder is a placement and blocks nothing.
- **A `blocked_by` joins two items on the SAME LEVEL** (Story MOTIR-6015 ·
  MOTIR-6367 / MOTIR-6411). The level is **position, not kind** (MOTIR-6387):
  the two items sit at the same depth below their nearest common ancestor, in
  the tree the plan would leave — an `add` under its `parentRef`, a re-parented
  `modify` under its new parent, a folder adding no depth. An edge **may cross
  parents** (a subtask `blocked_by` a subtask in another story, a story
  `blocked_by` a story in another epic, a validation task under an epic
  `blocked_by` the story beside it) and **may not cross levels** (a subtask
  `blocked_by` a story, a subtask under a task under a story `blocked_by` a
  subtask directly under a story). **An epic is blocked only by another epic**
  (the record's Amendment 1): an edge with an epic at either end is cross-level
  unless both ends are epics, whatever their depths. A cross-level edge in `blockedByRefs` or
  `patch.blockedByAdd` is refused as `INVALID_PLAN_REF_GRAPH` with reason
  **`cross_level`**, naming both items and their depths — at the append for what
  the batch writes, and again at the close, on a correction (`update_plan_proposal`
  — so re-parenting an `add` under an edge it already carries into another depth
  is refused too), in `validate_plan`'s `rejections` and at approve.
  `patch.blockedByRemove` is never refused, so a bad committed edge can always be
  taken away.

###### Marking a card — the obsolescence mark and its `supersedes` edges

A plan can say that a FINISHED card is no longer true of the code (Story MOTIR-6577,
`agent-authored-plans.md` AMENDMENT 22). Six `modify` patch keys and one `add` field
carry it:

| Where             | Key                  | Meaning                                                                                                                                                                                                       |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modify` `patch`  | `obsolescence`       | `"outdated"` (the text no longer describes what shipped) · `"deprecated"` (retired or overturned on purpose) · `null` clears. Anything else: `INVALID_PROPOSAL`.                                              |
| `modify` `patch`  | `obsolescenceNoteMd` | Markdown WHY — what changed, what to read instead. `null` clears. Independent of the mark: clearing the mark keeps the note.                                                                                  |
| `modify` `patch`  | `supersedesAdd`      | **On the NEWER card**: the target REPLACES each listed (older) card. Approve writes one `supersedes` link target → ref.                                                                                       |
| `modify` `patch`  | `supersedesRemove`   | On the NEWER card: delete the link target → ref. A link that is not there is a no-op.                                                                                                                         |
| `modify` `patch`  | `supersededByAdd`    | **On the OLD card**: each listed (newer) card REPLACES the target. Approve writes one `supersedes` link ref → target — the row the newer card's `supersedesAdd` would write, so both spellings land one link. |
| `modify` `patch`  | `supersededByRemove` | On the OLD card: delete the link ref → target.                                                                                                                                                                |
| `add` (top level) | `supersedesRefs`     | The OLDER cards the created card replaces; approve writes one link new card → ref. Refused on a `modify` (use the patch lists) and on a `remove`.                                                             |

Every one of the five edge carriers takes the same three ref forms as
`blockedByRefs`: a work-item **key** (`ACME-7`, resolved to its id at the call — an
unknown key is refused `INVALID_PLAN_REF_GRAPH` / `dangling` there), a real id, or a
`planItem:<id>` naming an `add` from an **earlier** call. A `folder:` ref, a ref listed
twice in one list, a `modify` naming its own target, and an edge that closes a
**supersedes cycle** (A replaces B replaces A — the database does not refuse one, so the
plan path does) are refused `INVALID_PLAN_REF_GRAPH`. There is **no level rule**: any
kind may supersede any kind, and a supersedes edge orders nothing. On a merge (a second
`modify` of the same card) the four lists union like the blocker lists, and a ref in an
`…Add` and its `…Remove` cancels.

**A plan may mark only a FINISHED card.** A patch that SETS `obsolescence` on a target
whose status is not in the `done` category is refused `INVALID_PROPOSAL`, at the append,
at `update_plan_proposal` and again at approve (where `validate_plan` reports it as a
rejection):

> `<proposal>: a plan may mark only a finished work item; ACME-7 is at in_progress. A
work item nobody will finish is removed — send { op: 'remove', workItemId, reason }
instead.`

Unfinished work nobody will do is **removed**, not marked. Clearing a mark (`null`) is
legal on any card.

**The mark-only carve-out.** A `modify` whose patch carries NOTHING but these six keys
is the ONE change a plan may make to a `done` or `cancelled` card: approve writes the
mark, the note and the links and leaves the card's status, branch and parent alone. Add
any other key and the target is refused `PLAN_TARGET_IMMUTABLE`, as before. Marking is
never archiving — the card stays in the tree — and **a `remove` never marks anything**.

A worked example — mark a `done` story outdated, superseded by the story this plan adds,
in two calls (the second needs the first's `planItemIds`):

```jsonc
// 1 — the replacement story, naming the old one it replaces
add_plan_items({ planId, proposals: [
  { op: "add", proposedFields: { title: "Checkout, v2", kind: "story" },
    parentRef: "ACME-40", supersedesRefs: ["ACME-12"] },
]})
// → planItemIds: ["ck_v2"]

// 2 — a MARK-ONLY modify of the done story
add_plan_items({ planId, final: true, proposals: [
  { op: "modify", workItemId: "<ACME-12's id>",
    patch: { obsolescence: "outdated",
             obsolescenceNoteMd: "The flow moved to Checkout, v2.",
             supersededByAdd: ["planItem:ck_v2"] } },
]})
```

`supersedesRefs` on the `add` and `supersededByAdd` on the `modify` name the same link;
either alone draws it, both together draw it once. `get_plan` renders the pair as
`+ [story] Checkout, v2 · supersedes ACME-12` and
`~ modify ACME-12 — … · mark: none → outdated · note: The flow moved to Checkout, v2. · superseded by +planItem:ck_v2`.

**Output** — `structuredContent`: the plan and its `items[]`, plus
**`planItemIds`** — the ids of the proposals **this call** created, **in the order
you sent them**.

**That order is the contract, and it is how a tree gets built.** A proposal can
only be a parent once it has an id, so send the tree **layer by layer, parents
before children**, and pass `planItem:<id>` from a previous call's `planItemIds`
as the next layer's `parentRef` or `blockedByRefs` entry:

```jsonc
// 1 — the epics and stories
add_plan_items({ planId, proposals: [
  { op: "add", proposedFields: { title: "Billing", kind: "epic" } },
  { op: "add", proposedFields: { title: "Invoices", kind: "story" }, parentRef: "planItem:<epic id>" },
]})
// → planItemIds: ["ck_epic", "ck_story"]   (index-for-index with what you sent)

// 2 — the leaves, hung off ids from step 1, and CLOSE the plan
add_plan_items({ planId, final: true, proposals: [
  { op: "add", proposedFields: { title: "Invoice PDF", kind: "subtask", storyPoints: 3, estimateMinutes: 45 },
    parentRef: "planItem:ck_story" },
  { op: "add", proposedFields: { title: "Email the invoice", kind: "subtask", storyPoints: 2, estimateMinutes: 30 },
    parentRef: "planItem:ck_story", blockedByRefs: ["planItem:ck_pdf"] },
]})
```

`final: true` moves the plan to `planned`, which is what puts it in the review
queue. **Appending to a plan that has already been closed is refused** —
`PLAN_NOT_GENERATING` — so send `final` exactly once, on your last batch. The
plan row is locked for the append, so two concurrent callers serialize rather
than interleaving into each other's `planItemIds`.

**A pass with nothing left to append closes with an EMPTY batch:**

```jsonc
add_plan_items({ planId, proposals: [], final: true });
```

That is the normal ending for a **titles-first** author (`update_plan_item`
below): the skeleton batches carried the structure and the deepen turns wrote the
cards, so by the close there is no proposal left to ride the flag. An empty batch
appends nothing, keeps every proposal the plan already holds, and moves it to
`planned`.

**An empty batch WITHOUT `final` is refused** — `INVALID_PROPOSAL`, naming what
the call would have done. It would append nothing and leave the plan
`generating`, which is a forgotten flag or a batch built from a list that turned
out to be empty; answering it with a silent success would hide both.

You do **not** set planning provenance on a proposal: `add_plan_items` stamps
each `add` from the plan's own authorship, so the plan and the items it creates
can never disagree about who wrote them.

Requires **`ai:view_plan`** — the permission `plansService.addProposals` asserts.
Together with `create_plan`'s `work_item:edit`, a token needs **both** keys to
author a plan end to end.

> **⚠️ Neither tool creates a work item.** Approving the plan in Motir is the
> only path from a proposal to a `work_item` row, and approval does **not** happen
> on this surface. Do not report proposed work as created. Read the plan back with
> `get_plan` to show what you proposed.

Errors: an unknown / other-tenant `projectKey` or `planId` returns
`PROJECT_NOT_FOUND` / `PLAN_NOT_FOUND` (404-not-403, no existence leak); a
malformed proposal — or an EMPTY `proposals` array sent without `final: true` —
returns `INVALID_PROPOSAL`; an append after `final` returns
`PLAN_NOT_GENERATING`; a second `modify`/`remove` for a target the plan already
proposes against returns `DUPLICATE_PLAN_TARGET` (below); and an ORM failure
inside the append is contained as `PLAN_PERSISTENCE_FAILED`, never surfaced as
the database driver's own text.

###### One proposal per existing target — `DUPLICATE_PLAN_TARGET`

**A plan holds at most ONE `modify` or `remove` for any given `workItemId`.** A
second one — another `modify`, or a `remove` beside a `modify` — is refused,
naming the work item. Many `add`s are unaffected: an `add` has no target until
approve.

**Why the rule is kept** (asked and answered on MOTIR-3194, after the refusal was
found escaping as a raw ORM string). Nothing DOWNSTREAM needs it — `materialize`
applies each `modify` in sequence. Three things upstream do:

1. **The review surface could not render it honestly.** A proposal stores only the
   NEW values; every diff's OLD side is read live from the target. Two patches on
   one card therefore render as two diffs from the same committed state, the second
   silently omitting the first's changes — and a person approves what they read.
2. **`baseRevision` is per target.** It is the optimistic-concurrency anchor a
   `modify`/`remove` is computed against; two rows for one target carry two
   anchors with no defined precedence.
3. **The rule spans `modify` AND `remove`,** so relaxing it wholesale would admit
   a plan that patches a card and archives it in one approval.

**What to do instead**, and neither costs you anything:

- **Fold the second change into the one `modify`** — two patches that would merge
  cleanly can simply BE one patch.
- **For a dependency edge between two work items that ALREADY exist, call
  `link_work_items`.** An edge between committed items never needed a proposal:
  it is a direct write, legal at any time, and it does not wait for an approval.

##### `update_plan_item` — the DEEPEN turn

`add_plan_items` is append-only: a proposal is frozen the moment it lands. That
forbids the strategy Motir's own generator uses, so this tool is the other half —
**write the tree's SHAPE first, then fill each card in.**

| Input                                                                                                                                      | Type   | Required | Notes                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------- | ----------------------------------------------------------- |
| `planId`                                                                                                                                   | string | yes      | The id `create_plan` returned.                              |
| `planItemId`                                                                                                                               | string | yes      | One of the ids `add_plan_items` returned in `planItemIds`.  |
| `title`, `kind`, `descriptionMd`, `explanationMd`, `type`, `priority`, `executor`, `storyPoints`, `estimateMinutes`, `difficulty`, `todos` | —      | no       | The sparse patch. Everything except `title` accepts `null`. |

**The patch is SPARSE, and absent is not the same as `null`.** A field you omit is
left exactly as it was; an explicit `null` clears it. So a deepen turn sends only
what it is deciding, and nothing it has not thought about yet is destroyed.

**`difficulty`** (MOTIR-6136) is `trivial` · `low` · `medium` · `high` — how hard
the card is to REASON about, not how big it is. It is leaf-only and judged on the
MERGED kind: a deepen that sets one on an `epic` / `story`, or re-kinds a leaf that
carries one into a container, is refused with `INVALID_PROPOSAL` naming
`difficulty`. `null` clears it.

**`todos` is the one member that is sparse at the KEY and whole at the VALUE.**
It is the card's ordered steps (the shape and the caps are under
`add_plan_items` above), and a list has no meaningful partial edit — so omitting
it leaves the proposal's list alone, sending an array REPLACES the set, and `[]`
or `null` clears it. It is deepenable because a step list is what a card SAYS;
it is refused on a container kind here exactly as at the append, and the check
runs on the MERGED result, so a deepen that turns a leaf carrying steps into a
`story` is refused even though the patch names only `kind`.

```jsonc
// 1 — the SKELETON: titles, kinds and the edge graph. No `final`.
add_plan_items({ planId, proposals: [
  { op: "add", proposedFields: { title: "Invoices", kind: "story" }, parentRef: "planItem:ck_epic" },
]})
// → planItemIds: ["ck_story"]

// 2 — the DEEPEN pass: one call per proposal, now that every sibling exists
update_plan_item({ planId, planItemId: "ck_subtask",
  descriptionMd: "## What to do\n…",
  explanationMd: "Why it matters …",
  type: "code", executor: "coding_agent", priority: "high",
  storyPoints: 3, estimateMinutes: 45 })

// 3 — CLOSE. Nothing is left to append, so the batch is empty.
add_plan_items({ planId, proposals: [], final: true })
```

**Set `executor` whenever you set `type`.** Approving a plan does **not** derive
an executor from the work type — a proposal that never carried one materializes
unassigned — so the deepen turn is where a leaf gets both.

**`revision: true` — rewriting a card on a plan you already closed** (AMENDMENT 24
of `docs/decisions/agent-authored-plans.md`). Once `final: true` has put the plan
in front of a reviewer, this tool is refused (`PLAN_NOT_IN_EXPECTED_STATUS`,
naming the status) UNLESS the call carries `revision: true`. A revision is the
same sparse patch, applied to the SAME proposal — its id, its parent and its edges
are untouched — and the plan stays `planned` before, during and after. It lands on
the plan's timeline as an `edited` row under the harness and model that made it,
never as the reviewer's own edit. It is how a correction changes what a card
SAYS; never withdraw a proposal and append a copy to change its words, which loses
its id, its edges and its history. On a `generating` plan the flag changes
nothing; `approved` and `declined` stay frozen.

```jsonc
update_plan_item({ planId, planItemId: "ck_story", revision: true,
  descriptionMd: "## What to do\n… (corrected)" })
```

**What it deliberately cannot do**, because that is the shape you settled in the
skeleton pass: re-parent a proposal (`parentRef`), change its dependency edges
(`blockedByRefs`), or re-pin its repo (`targetRepo` / `targetRepoRole`). Nor can
it WITHDRAW a proposal — `op: "remove"` targets an existing work item, not a
proposal.

**That is a rule about the DEEPEN, and it is no longer a dead end.** Those four
things are exactly what `update_plan_proposal` and `withdraw_plan_proposal`
below are for. The split is deliberate: a deepen is the second phase of writing
a tree and should not be able to reshape it, while a CORRECTION is an author
fixing its own mistake and has to be able to.

**Legal only while the plan is `generating`.** Once `final: true` has closed it,
the plan is in front of a person and stops moving: a deepen is refused with
`PLAN_NOT_IN_EXPECTED_STATUS`, naming the status it actually found, so the refusal
reads as terminal rather than as something to retry. To change a `planned`
proposal, use `update_plan_proposal` — which is legal there precisely because it
records the change on the plan's timeline, so the reviewer can see it.

Requires **`ai:view_plan`** — the permission `plansService.deepenProposal`
asserts, the same key `add_plan_items` names.

Errors: `PLAN_NOT_FOUND` / `PLAN_ITEM_NOT_FOUND` (404-not-403 — an id from
another tenant is indistinguishable from one that does not exist);
`PLAN_NOT_IN_EXPECTED_STATUS` once the plan has closed; `INVALID_PROPOSAL` for a
`modify` / `remove` proposal (only an `add` can be deepened) or sizing outside the
Fibonacci range.

> **⚠️ This creates no work item either.** It edits a proposal in place, and
> nothing in the tree changes until a person approves the plan.

##### `update_plan_proposal` — CORRECT a proposal, structure included

The repair for a mistake you can see and previously could not fix. `add_plan_items`
returns a proposal's id only when its own call returns, so an intra-plan ref written
in the same batch as its target names nothing — and until this tool existed the only
remedy was to author a whole second plan and ask a person to decline the first.

| Input                                | Type           | Required | Notes                                                                                                                                                                                                             |
| ------------------------------------ | -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planId`                             | string         | yes      | The id `create_plan` returned.                                                                                                                                                                                    |
| `planItemId`                         | string         | yes      | The proposal to correct.                                                                                                                                                                                          |
| every field `update_plan_item` takes | —              | no       | Same sparse semantics — `difficulty` included, leaf-only on the merged kind (`INVALID_PROPOSAL` on a container).                                                                                                  |
| `parentRef`                          | string \| null | no       | `add` only. Re-parent it — a key, an id, `planItem:<id>`, or `folder:<folderId>` to file it into a folder; `null` makes it top-level. Re-validated as at the append.                                              |
| `blockedByRefs`                      | string[]       | no       | **REPLACES** the set — a list has no sparse edit. `[]` clears it.                                                                                                                                                 |
| `supersedesRefs`                     | string[]       | no       | `add` only. **REPLACES** the older cards the `add` supersedes (key, id or `planItem:<id>`); `[]` clears it. Re-checked as at the append, cycle included.                                                          |
| `targetRepo`                         | string \| null | no       | `add` only. Re-pin the repo; `null` unpins.                                                                                                                                                                       |
| `targetRepos`                        | string[]       | no       | `add` only. **REPLACES** the repository SET by NAME; `[]` unpins.                                                                                                                                                 |
| `targetRepositories`                 | string[]       | no       | `add` only. The same set as repository ROW IDS.                                                                                                                                                                   |
| `targetRepoRole`                     | string \| null | no       | `add` only. Re-pin the ROLE — the portable half; `null` unpins.                                                                                                                                                   |
| `patch`                              | object \| null | no       | `modify` only. **REPLACES** that proposal's patch — `patch.difficulty` included, judged against the target's kind; the six mark keys included, a SET mark refused on an unfinished target (see _Marking a card_). |

**It reaches the five things the deepen cannot, and that is the whole point.** The
field that is wrong is very often `patch.blockedByAdd` on a `modify` — the op no
door could touch at all — because that is where an intra-plan dependency edit rides.

**The repository axis is REPLACED, never merged** (bug MOTIR-4904). `targetRepo`,
`targetRepos` and `targetRepositories` are one field in three spellings — mutually
exclusive on any one call, exactly as they are on `create_work_item` — so correcting
one CLEARS the other two. Merging instead would store a proposal describing the axis
twice, which the append refuses and which approve would then have to guess at. The
set forms are what made a MULTI-REPOSITORY card proposable at all: until this bug was
fixed every plan-authoring door took only the singular, so a story spanning two
repositories could only be given its set with `update_work_item` AFTER approval —
outside the plan, after the review, with a window in between where dispatch routes
on the wrong pin.

**`targetRepoRole` is the half an ONBOARDING plan actually carries** (MOTIR-3865). At
generation the project's repositories do not exist yet — the set is derived from the
tree — so a fresh plan pins a ROLE and no name at all, and a correction that could
re-pin only the NAME could not correct that plan's pin. It is validated against the
closed role vocabulary (`web` / `api` / `mobile` / `shared` / `infra` / `other`)
rather than the project's rows, which is exactly what makes it sayable this early.

**Legal on `generating` AND `planned`.** Correcting a plan a reviewer is already
holding is the case this exists for, and it is safe because the correction lands on
the plan's TIMELINE with the harness and model that made it: a reviewer can see that
what they are approving is not what they started reading.

**`approved` and `declined` are FROZEN.** At approve the proposals have materialized
into work items, which are then the source of truth — so the refusal names the status
and points at `update_work_item`. A decline is a closed decision. Either way the
answer is `PLAN_NOT_EDITABLE`, which says which of the two it is.

**Every structural correction re-runs the append's own ref check**, so you cannot
correct your way into a `planItem:` ref that names nothing — and a ref naming the
proposal ITSELF is refused rather than stored as a one-node cycle.

```jsonc
// The batch that produced the mistake: two proposals in ONE call, the second
// referencing the first — whose id does not exist until this call returns.
add_plan_items({ planId, proposals: [
  { op: "add", proposedFields: { title: "The prerequisite", kind: "task" } },
  { op: "modify", workItemId: "cmq…", patch: { blockedByAdd: ["planItem:PLACEHOLDER"] } },
]})
// → REFUSED: UNRESOLVED_PLAN_REF, naming the ref and the proposal.

// Appended properly, in two calls, then corrected after the close:
update_plan_proposal({ planId, planItemId: "ck_modify",
  patch: { blockedByAdd: ["planItem:ck_prereq"] } })
```

Requires **`ai:view_plan`** — the key `plansService.correctProposal` asserts, the
same one `add_plan_items` and `update_plan_item` name.

Errors: `PLAN_NOT_FOUND` / `PLAN_ITEM_NOT_FOUND`; `PLAN_NOT_EDITABLE` on an
`approved` or `declined` plan; `UNRESOLVED_PLAN_REF` for a ref naming no proposal;
`INVALID_PROPOSAL` for a `patch` on an `add`, a body field on a `modify`, or a
correction that changes nothing; `PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE` for a
`targetRepoRole` outside the vocabulary.

##### `withdraw_plan_proposal` — take ONE proposal off a plan

So that a proposal you should not have appended does not have to be declined by a
person along with everything around it.

| Input        | Type   | Required | Notes                              |
| ------------ | ------ | -------- | ---------------------------------- |
| `planId`     | string | yes      | The id `create_plan` returned.     |
| `planItemId` | string | yes      | The proposal to take off the plan. |

**This is NOT the `remove` op.** `op: "remove"` PROPOSES deleting an existing work
item from the tree at approve and requires a `workItemId`. This takes a proposal off
the PLAN, and nothing in the tree is touched either way.

**A referenced proposal is REFUSED, not cascaded.** If a sibling still points at it
through a `planItem:` ref, the call comes back as `PLAN_PROPOSAL_REFERENCED` naming
every referrer — correct or withdraw those first. Cascading would take cards off the
plan you never asked to withdraw; blanking their refs would change what they mean.

**Withdrawing a `modify` RELEASES its target**, so you can append a corrected
`modify` for that work item where a second one was previously refused as a duplicate
target. That was a dead end for the life of the plan.

**Withdrawing the LAST proposal of a `planned` plan ENDS that plan** (MOTIR-4146) —
it becomes `declined` with `decisionReason: "discarded"`, the same ending a
generation that proposes nothing gets at the close. `planned` means _a person is
being asked to decide this_, and there is nothing left to decide; leaving it queued
would put an empty plan in the review queue with no decision to make. Open a new
plan to propose again. On a `generating` plan the last withdrawal does **not** end
it — that pass has not finished writing.

Same statuses, same key, same freeze as `update_plan_proposal` above.

##### `update_plan` — correct the PLAN'S OWN title and summary

The three tools above all address a PROPOSAL. This one addresses the **plan** — the
two lines a reviewer reads _above_ the tree, before any card. `create_plan` wrote
them once and nothing could reach them afterwards, so the cheapest possible mistake
had the most expensive remedy in this surface: withdraw every proposal (which ENDS a
`planned` plan as `declined` / `discarded`), re-create the plan, re-append every
proposal with every `planItem:` ref rebuilt, re-close it. One wrong sentence cost the
whole plan.

| Input     | Type           | Required | Notes                                                        |
| --------- | -------------- | -------- | ------------------------------------------------------------ |
| `planId`  | string         | yes      | The id `create_plan` returned.                               |
| `title`   | string \| null | no       | The plan's own short label. `null` clears it.                |
| `summary` | string \| null | no       | The Markdown summary shown above the tree. `null` clears it. |

**Sparse, and a call that sends neither is refused.** An omitted field is left
exactly as it was; an explicit `null` clears it. `INVALID_PROPOSAL` for a call that
changes nothing — the same refusal `update_plan_proposal` gives an empty correction.

**It touches NOTHING else, and that is asserted rather than assumed.** The plan keeps
every proposal it had, its `status`, its `plannedAt` and the staleness flags derived
from it. A brief edit corrects what the plan SAYS about itself; it does not re-open a
closed plan, re-date it, or make a reviewer's read of the tree stale.

**Legal on `generating` AND `planned`; `approved` and `declined` are FROZEN** — the
same boundary the two correction doors draw, because it is the same question: a plan
being written or awaiting a decision is editable, a decided plan is a record. The
refusal is `PLAN_NOT_EDITABLE` and it names the status.

**The edit is on the plan's TIMELINE**, as a `brief_edited` event carrying the harness
and model that made it. That is a decision rather than a side effect: a `planned` plan
is a thing a person is deciding about, and silently rewriting the sentence they are
reading would trade one honesty problem for another. It is deliberately not the
`edited` verb, which means _a proposal changed_ and renders as a proposal count.

```jsonc
// The summary said the org was the billing unit for code indexing. It is not.
update_plan({ planId, summary: "…the org is the ATTRIBUTION unit; indexing is absorbed." })
// → the same plan id, the same three proposals, still `planned`.
```

Requires **`ai:view_plan`** — the key `plansService.correctPlanBrief` asserts, the
same one every other authoring write names. A CLI-minted token does not carry it.

Errors: `PLAN_NOT_FOUND`; `PLAN_NOT_EDITABLE` on an `approved` or `declined` plan;
`INVALID_PROPOSAL` for a call that sends neither field.

##### `record_plan_revision_reason` — record WHY the plan had to change

The four tools above all CHANGE the plan. This one changes nothing about it: it
records **why a change was asked** of a plan that is not yet approved, once per
request, _before_ you correct anything.

It exists because the planner-bug home is only as useful as its signal. Filing a
planning bug on every re-plan makes a reviewer saying _"I'd rather have a side
panel"_ produce the same record as a plan that forgot to check whether its
repository still exists — and several hundred records later nobody can tell the
planner's real blind spots from ordinary conversation.

| Input            | Type   | Required | Notes                                                                                          |
| ---------------- | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `planId`         | string | yes      | The id `create_plan` returned.                                                                 |
| `branch`         | enum   | yes      | `new_ask` · `different_solution` · `rule_gap` · `rule_not_followed`.                           |
| `evidenceMd`     | string | yes      | Why you chose that branch. Required on EVERY branch; 4 000 characters.                         |
| `planningBugKey` | string | no       | The bug you filed (`MOTIR-123`) — required on the two rule branches, refused on the other two. |

**Four branches, and only two are about the planner.**

| the reason is…                                                                                   | planning bug? |
| ------------------------------------------------------------------------------------------------ | ------------- |
| **`new_ask`** — they now want something the conversation that settled the plan never raised      | no            |
| **`different_solution`** — the plan answered what was asked; they prefer another answer          | no            |
| **`rule_gap`** — the plan missed a check and NO planning rule asks for it; its fix is a new rule | yes           |
| **`rule_not_followed`** — a rule requires the check and this pass did not apply it               | yes           |

**Record it on EVERY branch, including the two that file nothing.** That is the
point rather than a completeness flourish: a silent "no bug" is indistinguishable
from a forgotten one, while a recorded _different solution, no bug_ is a judgement
somebody can check.

**Choosing between the two rule branches — and ruling both out — is a SEARCH and
not a judgement.** Search the planning rules and the lesson store for the check
that was missed and quote what came back in `evidenceMd`. A gap asserted without
that search is an unverified negative, which is why the evidence is required on
every branch rather than only on the two that file.

**The bug is filed FIRST and named here.** Create it with `create_work_item` into
the project's `Planning bugs` folder, then pass its key: the classification points
at the record it produced, and this tool files nothing itself. The branch and the
key must agree — a rule branch with no key, and a no-bug branch carrying one, are
both refused with `PLAN_REVISION_CLASSIFICATION_INVALID`, because each makes the
row say something its caller did not.

**It changes NOTHING about the plan** — not a proposal, not the heading, not the
status. Correcting the plan is a separate act through the doors above.

**The record is INTERNAL to Motir and no read returns it.** It is Motir's own
judgement about its own planner, not something a tenant asked to see: it is
excluded from every tenant-facing read at the query, the plan's timeline included,
and there is no tool, route or DTO that reads it back. Reading it is left to the
platform-operations epic.

**Legal on `generating` AND `planned`; `approved` and `declined` are FROZEN** — the
same boundary the correction doors draw, and for the same reason: a classification
recorded against a decided plan would be a judgement about a change that can no
longer happen.

```jsonc
// A reviewer: "this should have checked whether the repo is archived."
// You search the corpus; nothing asks for that check.
create_work_item({ projectKey: "MOTIR", kind: "bug", folderId: "<Planning bugs>",
                   title: "Planning bug: no rule checks whether the target repo is archived" })
// → MOTIR-6201
record_plan_revision_reason({ planId, branch: "rule_gap", planningBugKey: "MOTIR-6201",
  evidenceMd: "Searched the rule corpus and the lesson store for 'archived repository'; 0 hits." })
// → { kind: "reason_classified", branch: "rule_gap", planningBugKey: "MOTIR-6201", at }
```

Requires **`ai:view_plan`** — the key every other plan-authoring write names, so a
CLI-minted token cannot reach it either: classifying a revision is part of revising
a plan, and a run that may not revise one should not annotate one.

Errors: `PLAN_NOT_FOUND`; `PLAN_NOT_EDITABLE` on an `approved` or `declined` plan,
naming the status; `PLAN_REVISION_CLASSIFICATION_INVALID` for a branch/bug pairing
that contradicts itself, a key that names no work item or not a `bug`, evidence that
is empty or past its bound, and a call naming the bug twice.

##### `report_plan_step` — say which step a planner session is on

The doors above change what a plan PROPOSES. This one says what a planner is
**doing right now**, so a person following a plan being written sees the items
being laid and drafted — and can tell a plan that is working from one that has
stalled. Call it as each planner session **opens** a step, and with
`step: 'end'` under the same `sessionKey` as the session closes, however it closes.

| Input        | Type   | Required | Notes                                                                                                    |
| ------------ | ------ | -------- | -------------------------------------------------------------------------------------------------------- |
| `planId`     | string | yes      | The id `create_plan` returned.                                                                           |
| `sessionKey` | string | yes      | A stable name for the reporting session, 1–128 characters. A second report under it REPLACES its step.   |
| `step`       | enum   | one of   | `settle` · `lay` · `author` · `end`. Send exactly one of `step` or `narration`.                          |
| `narration`  | array  | one of   | 1–20 plain sentences the session says about what it is doing; appended, kept. See below.                 |
| `target`     | string | no       | A `planItem:<id>` ref naming an `add` on this plan, or a committed work item by key (`MOTIR-123`) or id. |

| `step`   | `target`                                                                     |
| -------- | ---------------------------------------------------------------------------- |
| `settle` | must be absent                                                               |
| `lay`    | the parent being laid, **or absent** for the project's top level             |
| `author` | the item being written, **or absent** for a new item not yet on the plan     |
| `end`    | must be absent — clears the session's step; a no-op success when it has none |

**`target` is optional on `lay` and `author`.** Both untargeted forms are real
moments in a walk — the root lay of an untargeted plan, and a create whose `add`
does not exist until the session's own append returns — so leave the target out
rather than guess one. The server sets the step's time; the result's `startedAt`
is the stored row's.

**Legal only while the plan is `generating`.** On `planned`, `approved` or
`declined` the call is refused with `PLAN_NOT_GENERATING` and nothing changes.

**It is ADVISORY.** Every refusal comes back as a code and a sentence, never as an
internal error, so a planner can match the code and keep planning. A refused report
must not stop a walk.

```jsonc
report_plan_step({ planId, sessionKey: "lay-root", step: "lay" })
// → { planId, sessionKey: "lay-root", step: "lay", targetRef: null, startedAt }
report_plan_step({ planId, sessionKey: "author-3", step: "author", target: "planItem:cm…" })
report_plan_step({ planId, sessionKey: "author-3", step: "end" })
// → { …, targetRef: null, startedAt: null }
```

**Narrate between steps.** Send `narration` (instead of `step`, and with no
`target`) with a few plain sentences on what the session is doing and why. A person
reads them in the plan's chat panel under that session's step, during the run and
after it — they are KEPT with the plan, unlike the step itself. Each call appends in
order (a plan-wide `seq`); whitespace is collapsed, and a sentence over 240
characters is cut with an ellipsis. The session must hold a step (`settle`, `lay` or
`author`) when it narrates. A step report also records the words shown at the head
of that session's narration — its kind, target and the target's title.

```jsonc
report_plan_step({ planId, sessionKey: "author-3", narration: ["Splitting the export into two stories."] })
// → { planId, sessionKey: "author-3", narration: [{ seq: 7, body: "Splitting the export into two stories." }] }
```

Requires **`ai:view_plan`**, the key every plan-authoring write names. A `motir run`
credential (`CLI_TOKEN_GRANT`) does not carry it and cannot reach this tool: a run
executing one work item has no business reporting progress on a plan.

Errors: `PLAN_NOT_FOUND`; `PLAN_NOT_GENERATING` off `generating`, naming the
status; `PLAN_STEP_INVALID` for a target on `settle` or `end`, a ref naming nothing
on this plan or in its project, a `folder:` ref, or a key that names no work item;
and, for `narration`, both or neither of `step` / `narration`, a `target`, an empty
or over-long batch, a blank sentence, or a session that holds no step.

##### `hold_plan_revision` — hold a plan still while you revise it

A plan that is already up for review (`planned`) stays `planned` while it is
revised — the revision appends with `revision: true` and is never re-closed. So
without a hold, a person can approve it halfway through your rewrite and turn a
proposal set that is neither the plan they read nor the plan they asked for into
real work items. Approve cannot be undone. This door takes the **revision lease**
the hosted revision has always taken: while you hold it, the plan is listed under
the Workbench's **Planning** tab instead of **Waiting on you**, and Approve and
Decline are refused with `PLAN_REVISION_IN_FLIGHT`. When you end it, the plan is
back in Waiting on you and can be decided.

| Input     | Type   | Required | Notes                                                                               |
| --------- | ------ | -------- | ----------------------------------------------------------------------------------- |
| `planId`  | string | yes      | The plan you are revising.                                                          |
| `action`  | enum   | yes      | `start` · `renew` · `end`.                                                          |
| `harness` | string | no       | Your harness as its makers name it (`Claude Code`) — what a refused Approve names.  |
| `model`   | string | no       | The model you run on, by its id. Leave it out when you do not know it; never guess. |

| `action` | What it does                                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`  | Takes the hold. Call it **before** the revision's first write. Refused with `PLAN_REVISION_IN_FLIGHT` while another revision holds the plan, `PLAN_NOT_EDITABLE` once it is decided.                                             |
| `renew`  | Keeps the hold. A hold lasts ten minutes from your **latest write** to the plan, so renew every few minutes while you go without one. On a hold that already lapsed it writes nothing and answers `held: false` — `start` again. |
| `end`    | Releases the hold. Call it however the revision finishes, failure included. A no-op success on a plan nobody holds.                                                                                                              |

A revision that dies without `end` is recovered when its hold runs out. Every
call but a no-op writes one row on the plan's own trail (the timeline shows the
start and the end; a renew is a heartbeat and is not shown).

```jsonc
hold_plan_revision({ planId, action: "start", harness: "Claude Code" })
// → { planId, action: "start", held: true, expiresAt }
add_plan_items({ planId, revision: true, proposals: [ … ] })
hold_plan_revision({ planId, action: "renew" })
hold_plan_revision({ planId, action: "end" })
// → { planId, action: "end", held: false, expiresAt: null }
```

Requires **`ai:view_plan`**, the key every plan-authoring write names. A `motir run`
credential (`CLI_TOKEN_GRANT`) does not carry it: a run executing one work item
revises no plan.

Errors: `PLAN_NOT_FOUND`; `PLAN_NOT_EDITABLE` on an `approved` or `declined`
plan; `PLAN_REVISION_IN_FLIGHT` on a `start` while another revision holds it,
naming who and until when.

##### `validate_plan` — CHECK the plan BEFORE `final: true`

The step between the last `add_plan_items` and the one that closes the plan, and
the only moment it is cheap. It answers _"is what I just proposed finishable?"_
over the project's live tree **⊕** this plan's proposals — the same check
Motir's own generator runs as its pre-commit post-condition, which is why a
Motir-generated plan arrives coherent.

| Input       | Type   | Required | Notes                                                                                                                             |
| ----------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `planId`    | string | yes      | The id `create_plan` returned.                                                                                                    |
| `condition` | enum   | no       | `loose` (default) — a done dependency outside the plan counts as satisfied. `tight` — every dependency must be IN the projection. |

**Output** — `structuredContent`: `{ planId, valid, blockers, rejections,
invalidEdges, crossLevelEdges, advisories }`. Each blocker is `{ item, blockedBy, blockerStatus,
blockerSprintId }`; an `item` or `blockedBy` of the form `planItem:<id>` names a
**proposal in this plan**, not a work item. `invalidEdges` is the cross-parent
rule under `validate_work_item` above, asked of the PROJECTION — proposed parents,
proposed kinds, an `add`'s `blockedByRefs`, and a `modify`'s `blockedByAdd` /
`blockedByRemove` on a child or on a parent. A **verdict only**: neither the
append nor approve refuses an uncovered edge, because a titles-first pass appends
children before it may have drawn every parent edge. `crossLevelEdges` is the
"blocked elsewhere" verdict under `validate_work_item` above, asked of the
PROJECTION: a PROPOSED cross-level edge is a `cross_level` rejection instead, so
what it reports is a COMMITTED cross-level edge (the link door writes one —
MOTIR-6509). `valid` is `true` only when all four lists are empty.

**`advisories` rides beside the verdict and never changes it (MOTIR-9007).** It
lists every `likely-mislabelled-link` shape advisory in a body the plan
PROPOSES — an `add`'s body, or a `modify` that rewrites one — as
`{ kind: "shape", item, severity, label, targetId, targetKey }`: a
`[label](motir:<id>)` link whose label names a work-item key the id does not
open, or whose id opens no card at all (`targetKey: null`). Fix the id before
sealing. The internal `validate-plan-forest` route answers the same
`advisories` beside its verdict (MOTIR-9873), so motir-ai's forest close can
re-open on one; its verdict is otherwise unchanged.

**Both edge lists hold only the findings the PLAN introduces (MOTIR-7727).** The
projection holds every edge anyone ever drew in the project, so judging all of
them made one old bad edge anywhere turn every plan on the project
`valid: false`, with no blocker and no rejection to act on. An edge is the
plan's when the plan touches either end, or an ancestor of either end (the chain
both rules read): an `add`, a `modify` carrying `parentRef`, `blockedByAdd` or
`blockedByRemove` (a title- or body-only `modify` touches no edge), or a
`remove` — including the removed parent of an end, which the projected chain can
no longer show. So a `blockedByRemove` on a parent that uncovers a child edge
still reports that child edge, and re-wiring one end of an old bad edge makes it
this plan's to fix. An old edge the plan touches nothing of is reported by
`validate_work_item` without a `planId`, unchanged. The same narrowing applies to
`validate_work_item` with a `planId`.

`validate_plan` also returns `sectionFindings` (MOTIR-9032), the same advisory
channel as on `validate_work_item`, over the cards the plan adds or modifies: the
projected body parsed against the section registry, a missing required section
named by `item`. It never changes `valid`.

```jsonc
validate_plan({ planId })
// → { planId: "cm…", valid: false, blockers: [
//      { item: "planItem:ck_email", blockedBy: "ACME-14",
//        blockerStatus: "todo", blockerSprintId: null } ] }
// "the invoice-email card I proposed is gated by ACME-14, which is neither in
//  this plan nor done" — fixable now, in the plan, before anybody reads it.
```

An approve refusal arrives in **`rejections`** (at most one, the gate is
fail-fast), each `{ code, reason, item, message }` — among them
`INVALID_PLAN_REF_GRAPH` / **`cross_level`** for a `blocked_by` between two
different levels (the same-level rule under `add_plan_items` above). A plan
appended before that rule shipped is reported here rather than silently
approvable.

> **⚠️ What `valid: true` means, exactly.** The containing set is the whole
> projected forest of the plan's PROJECT — so a not-done item in the same project
> is IN the set and does not gate, under either `condition`. The gate this
> catches is an out-of-forest one: a **cross-project** blocker, or (under
> `tight`) a done one. Read it as _"nothing outside this project's forest gates
> this plan"_, not as _"every dependency is satisfied"_.

**This is the WHOLE-plan verdict and takes no target.** Do not approximate it by
looping `validate_work_item` per root: a `blocked_by` edge between two sibling
roots — a story under proposed epic B gated by one under proposed epic A — is
FINISHABLE here, because both materialize together, and a false-positive BLOCKER
per-root. It is not automatically VALID any more (MOTIR-6370): the two stories sit
under different parents, so the edge is valid only when epic B is `blocked_by`
epic A, and without that edge it is reported in `invalidEdges` here AND per-root.
For ONE subtree, pass `planId` to `validate_work_item` instead.

Requires **`project:browse`** — the key `plansService.getPlan` asserts, the same
one the two other validators name. It is **not** `ai:view_plan`: that key gates
the plan DECISIONS (approve / decline / append), and this one decides nothing.

Errors: an unknown / other-tenant `planId` returns `PLAN_NOT_FOUND`
(404-not-403, no existence leak).

##### `get_plan_authoring_state` — WHICH SIBLINGS have not started (MOTIR-9821)

An author session may hand not-done work in its `## Scope BOUNDARY` only to a card
`blocked_by` its own, because only that card's author session reads the boundary.
The one edge a session may wire onto a SIBLING to make such a hand-off legal is
"that sibling `blocked_by` me" — and only while the sibling's own author session
has NOT STARTED. The level view a session opened on is a snapshot that cannot tell
"being written now" from "not started", so the session reads this, live, first.

```jsonc
get_plan_authoring_state({ planId })
// → { planId: "cm…", status: "generating", proposals: [
//      { ref: "planItem:ck_email", op: "add", title: "Send the invoice email", state: "authoring" },
//      { ref: "planItem:ck_retry", op: "add", title: "Retry a bounced email",  state: "not_started" } ] }
```

`authoring` — an `author` step reported through `report_plan_step` targets the
card and has not ended. `authored` — an author session that targeted it has
ended, or it was appended COMPLETE and never needed one (a `modify` always is).
`not_started` — no author session, live or ended, and the card is still
incomplete: a missing body or explanation, a `validate_plan` section finding, or,
on a childless leaf, a missing type, executor, size or difficulty. "Complete" is
plan.py's own `author_gaps` test, so a card the surgical add appended complete
reads `authored` rather than `not_started` for ever. `project:browse`, read
through the same reader gate as `get_plan`; it writes nothing.

##### The PROJECTED mode on the existing validators

`validate_work_item` and `validate_sprint` each take the same optional
**`planId`**, and ask their own question over the projection instead of the
committed tree:

- **`validate_work_item({ key, planId })`** — is this SUBTREE finishable once the
  plan materializes? `key` may be a committed identifier (`"ACME-7"`) **or** a
  `planItem:<id>` temp-ref naming an `add` in that plan, which is the case an
  authoring agent usually has: the card it wants to check has no key yet. Its
  `invalidEdges` and `crossLevelEdges` hold only the findings the plan introduces
  (MOTIR-7727, under `validate_plan` above); the committed call, without
  `planId`, still reports every edge in the subtree.
- **`validate_sprint({ planId })`** — will the project's ACTIVE sprint still be
  finishable once the plan materializes? On this path the plan names its own
  project, so `projectKey` is not required; `sprintId` is **refused** rather than
  ignored, because a projected verdict is always about the active sprint (an
  `add` lands in the backlog, and a plan cannot move anything into a sprint).

> **⚠️ Omitting `planId` is not a mode — it is the tool as it has always been.**
> A call without it never builds a projection at all and returns exactly what it
> returned before this existed. Both modes are **read-only**: a projection is
> assembled in memory, answered from, and thrown away. Nothing is created,
> nothing is mutated, and no proposal becomes a work item except by approving
> the plan in Motir.

> **The reads that deliberately do NOT take a `planId`:** `list_ready`,
> `next_ready` and `claim_next_ready`. **A proposal is not dispatchable** — it has
> no key, nothing can claim it, and a ready list that included one would put a
> card in front of an agent whose very next call is _claim this_. That exclusion
> is a decision, not an omission (`docs/decisions/agent-authored-plans.md`
> AMENDMENT 3, Q6).

##### The PROJECTED mode on the two READS

`get_work_item` and `search_work_items` take the same optional **`planId`** and
answer over the projection — the project's live tree **⊕** that plan's proposals
— so an agent can ask _"what does the tree look like WITH what I just
proposed"_ in one call, instead of fetching `get_plan` and merging it against a
search by hand on every turn.

**A proposal is never mixed into a work item's array.** It rides its own —
`proposals` on a search, `proposedChildren` on a projected detail — and each row
additionally carries `proposal: true` and `key: null`, because a proposal has no
key until the plan is approved and **none is ever invented for it**. Two locks,
so a caller that flattens the arrays still cannot confuse the two.

**`get_work_item({ key, planId })`** answers under a `projection` key, and the
ordinary `children` array comes back EMPTY — a keyless proposal cannot sit in the
array committed children use, and nothing about that array is widened:

| `projection.…`      | What it holds                                                                  |
| ------------------- | ------------------------------------------------------------------------------ |
| `target`            | the card itself — a proposal (addressed by `planItem:<id>`) or a committed row |
| `parent`            | the projected parent, or null                                                  |
| `committedChildren` | committed children, minus any the plan removes                                 |
| `proposedChildren`  | children **this plan** proposes under the target                               |
| `blockedBy`         | the projected dependency edges — committed and proposed, each self-marked      |

A caller branches on `projection` being present, exactly as it does on a search.

| Field              | What it holds                                                                  |
| ------------------ | ------------------------------------------------------------------------------ |
| `target`           | the card itself — a proposal (addressed by `planItem:<id>`) or a committed row |
| `parent`           | the projected parent, or null                                                  |
| `children`         | COMMITTED children only, minus any the plan removes                            |
| `proposedChildren` | children **this plan** proposes under the target                               |
| `blockedBy`        | the projected dependency edges — committed and proposed, each self-marked      |

`key` may be a committed identifier **or** a `planItem:<id>` temp-ref, which is
what an authoring agent usually holds. A committed row the plan `modify`s
carries the patch verbatim as `pendingPatch` — _this is the row as it stands,
and this is what the plan would change about it_ — and one the plan `remove`s
comes back with `status: "removed_by_plan"` rather than as a not-found.

**`search_work_items({ projectKey, filter, planId })`** keeps `items` as the
filtered committed page (minus anything the plan removes) and adds:

```jsonc
{
  "items": [ /* committed rows, exactly as without planId */ ],
  "total": 42,
  "nextCursor": null,
  "projection": {
    "planId": "cm…",
    "filterAppliesTo": "items",
    "removedIds": ["cmq…"],
    "modifiedIds": ["cmr…"]
  },
  "proposals": [
    { "proposal": true, "key": null, "tempRef": "planItem:ck_pdf",
      "planItemId": "ck_pdf", "title": "Invoice PDF", "kind": "subtask", … }
  ]
}
```

> **⚠️ THE FILTER DOES NOT REACH PROPOSALS, and `projection.filterAppliesTo`
> says so on every response.** The FilterAST compiles to parameterized SQL over
> `work_item` rows, through the one registry that makes it injection-safe. A
> proposal is not such a row, so the choice was between reimplementing the whole
> grammar in memory — a second compiler, guaranteed to drift from the one the
> `/items` page uses — and saying plainly what the filter covers. Motir says it:
> `items` is filtered, `proposals` is the plan's **whole** `add` set. That answer
> is the same every time, rather than an accident of which fields a given
> proposal happens to carry.

> **Omitting `planId` is not a mode.** Neither read builds a projection without
> it, and the response has no `projection` / `proposals` key at all — so a call
> without it is byte-identical to what it returned before this existed. Both
> modes are read-only.

#### Planning as a CONVERSATION — `open_plan_session` · `append_plan_turn` · `submit_plan_session`

Changing a plan in Motir is not a one-shot prompt: it is a **persisted,
resumable, multi-turn conversation** that ACCUMULATES intent and is SUBMITTED
when you are ready. These three tools are that conversation over MCP — the same
substrate the Motir web app's planning rail talks through, so a terminal client
and a browser are two views of one thread.

**Many conversations per scope, addressed by session id** (story MOTIR-6011,
`docs/decisions/agent-authored-plans.md` AMENDMENT 17). A project — or an anchor
set of work items — can hold several planning conversations over time. Every
one of these tools takes `projectKey` plus an optional `targetKeys`, and an
optional **`sessionId`**: the `id` any of the three returned. Pass it on every
later call to stay on that exact conversation.

| Input        | Type     | Required | Notes                                                                                                                                                                                                               |
| ------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectKey` | string   | yes      | The project key, e.g. `"ACME"` (case-insensitive).                                                                                                                                                                  |
| `targetKeys` | string[] | no       | Work-item identifiers to ANCHOR the conversation at (max 20, case-insensitive). Omit for the **project-wide** scope. Order and duplicates are irrelevant.                                                           |
| `sessionId`  | string   | no       | The conversation to address — the `id` a previous call returned. A session of another project is refused as `NOT_FOUND` (`PLAN_SESSION_NOT_FOUND`). Omit it and your own recent conversation for the scope is used. |
| `body`       | string   | yes\*    | `append_plan_turn` only — what you want changed about the plan.                                                                                                                                                     |

**Without a `sessionId`**, each tool behaves as it did before the id existed, for
a caller with one conversation: it uses **your own** conversation for the scope
if you were active in it within the last **2 hours** (AMENDMENT 17 §3), and
otherwise `open_plan_session` / a first `append_plan_turn` starts a new one. So
an agent that never passes an id keeps working — it simply cannot reach back to
an older conversation. Anchors are resolved and permission-checked before they
become a scope, so an item you cannot see is a `NOT_FOUND`, never a silent
anchor.

- **`open_plan_session`** — open or resume a conversation and read it: the one
  `sessionId` names, else your recent one for the scope, else a new one.
  **Output** — `structuredContent`: the session DTO
  `{ id, projectId, targetKeys, turnCount, lastJobId, lastSubmittedAt, createdAt, updatedAt, turns }`,
  where `turns` is the FULL ordered thread (`user` turns are what was typed,
  `system` turns are submission markers carrying their `jobId`). Submits
  nothing and costs nothing — but it still requires `ai:plan`, because opening
  the thread is what the shipped gate asks for.
- **`append_plan_turn`** — add one turn. **Output**: the updated session DTO.
  **⚠️ Appending does NOT submit.** Turns accumulate until you call
  `submit_plan_session`; that separation is the point — a later turn **refines**
  the earlier ones rather than replacing them, so _"add auth to the billing
  epic"_ then _"keep every subtask under 3 points"_ go out as ONE coherent
  change. A first turn opens the thread on its own, so no separate `open` call
  is required to start talking. Requires `ai:plan`.
- **`submit_plan_session`** — send the accumulated intent as ONE job.
  **Output** — `structuredContent`: `{ jobId, planId, session }`. It **submits
  and returns** exactly like `expand_item` — poll `get_plan_status` for the
  outcome, then `get_plan` to SHOW what was proposed. A single-turn thread is sent verbatim; a multi-turn thread is sent as
  the numbered accumulated intent. The submission is recorded on the thread as a
  `system` marker turn carrying the job id, and the thread stays open for
  further refinement.

> **⚠️ Submitting does NOT create work items.** The job produces a **`Plan` of
> proposals** — approving that plan, a decision made in Motir and not on this
> surface, is the only path from a proposal to a work item. Do not report
> proposed work as created.

Errors: a thread that was never opened returns `PLAN_CHANGE_SESSION_NOT_FOUND`;
one with no turns yet returns `PLAN_CHANGE_EMPTY_INTENT` (say what to change
first); an empty body returns `PLAN_CHANGE_EMPTY_TURN`; more than 20 anchors
returns `PLAN_CHANGE_TOO_MANY_TARGETS`. A refused job returns the motir-ai code
verbatim — `MOTIR_AI_OUT_OF_CREDITS` (do not retry) or `MOTIR_AI_UNAVAILABLE`
(retryable) — and **leaves the thread intact**, so your turns are never lost and
no orphan `Plan` is opened. The job runs on the **token owner's** AI credits, and
`submit_plan_session` — alone among these three — draws the shared
**`ai:generate`** budget (see [Rate limits](#rate-limits)): opening a thread and
appending turns cost nothing at the provider, submitting one does. Over budget
returns a `RATE_LIMITED` tool error before the job is submitted, and likewise
leaves the thread intact.

> **Fresh projects.** These tools drive plan CHANGE (augment / contextual
> re-plan) against an existing tree. Generating a plan for an empty project is
> driven by the onboarding interview in Motir, a different conversation — this
> surface does not reach it.

### Identity

#### `whoami`

Resolve the identity behind the presented token: the owning user (id, name,
email) and the active workspace the bearer gate resolved for this request. Takes
**no arguments**. Used by the CLI's auth commands to confirm and display the
authenticated account; it reads only the actor's own identity, so there is no
cross-user exposure.

**Input** — none.

**Output** — `structuredContent`: `{ user, workspace }` (the actor's user
profile and active-workspace summary; `workspace` may be null only in the race
where the membership was removed mid-request).

#### `list_projects`

Enumerate the projects the presented token can reach — the read that lets a
client **resolve** a project instead of asking the user to type its key. Takes
**no arguments**: the workspace is the one the token is bound to, so this can
never reach another tenant. `whoami`'s companion — `whoami` answers "who am I and
which workspace", this answers "which projects are in it".

**Input** — none.

**Output** — `structuredContent`: `{ projects: ProjectRow[] }`, where each
`ProjectRow` is:

| Field         | Type                                           | Notes                                                        |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `key`         | string                                         | The project key — exactly what `projectKey` takes elsewhere. |
| `id`          | string                                         | Opaque project id.                                           |
| `name`        | string                                         | Display name.                                                |
| `slug`        | string                                         | URL slug.                                                    |
| `accessLevel` | `"open" \| "limited" \| "private" \| "public"` | Browse-access level — disambiguates same-named projects.     |

The text block lists one project per line: `ACME — Acme Corp · open`.

**Access + tenancy.** Backed by the SAME service the app shell's project switcher
calls, so the checks are the UI's: workspace membership is asserted, then every
project the caller may not browse (Story 6.4) is filtered out. A workspace with no
reachable projects returns an **empty list**, not an error.

**A project-bound token lists ONLY its project** (MOTIR-2607, MOTIR-5763). Every
per-key tool refuses such a token's other projects as `PROJECT_NOT_FOUND`, so the
list answers with the same set: exactly the bound project, in BOTH the text block
and `structuredContent`. A device token (`motir login`) is unbound and lists every
project its holder may browse. `GET /api/v1/projects` applies the same rule — both
read through `projectsService.listProjects`, which takes the binding.

**No per-row cost.** The whole call is a constant number of queries regardless of
how many projects come back. `createdAt` and a work-item count are deliberately
omitted — either would cost an extra projection or a query per row, which a
client looping over projects would inherit as a scale bug.

#### `get_project_state`

Read a project's **planning preconditions** — the configuration an agent should
**verify** before planning against it, instead of assuming. `list_projects`
answers "which projects can I reach"; this answers "what state is one in".

Four questions, one call:

- **Is the project established?** The immutable onboarding marker, resolved
  through `resolvePlanningHostGate` — the same gate the planning surfaces read.
- **Is code connected?** Whether the workspace has a GitHub App installation and
  which repositories the grant covers.
- **Is that code INDEXED?** Per-repo `indexed` / `pending`, from the succeeded
  `system.code-graph-index` ledger, plus the set-level `hasRunning`.
- **What is the project's repository SET, and where did onboarding stop?**

**Input**

| Field        | Type   | Required | Notes                       |
| ------------ | ------ | -------- | --------------------------- |
| `projectKey` | string | yes      | Project key, e.g. `"ACME"`. |

**Output** — `structuredContent`: a `ProjectStateDto`:

| Field          | Type                           | Notes                                                                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `project`      | object                         | `{ key, id, name, onboardingRanAt }` — the marker is carried beside the verdict it produced.                        |
| `planningGate` | `"workspace" \| "onboarding"`  | `resolvePlanningHostGate`'s verdict: `workspace` = established, `onboarding` = never onboarded.                     |
| `code`         | object                         | `{ installed: boolean, index: MigrateIndexStatusDto }` — see below.                                                 |
| `repoSet`      | `ProjectRepoDto[]`             | The PROJECT's repository set (distinct from the workspace's connected set); `[]` when the establish step never ran. |
| `onboarding`   | `MigrateOnboardingDto \| null` | The migrate-onboarding run (`step` / `status` / `codeGraphReady` / `conventionApprovedAt`), or `null`.              |

`code.index` is the **shipped `MigrateIndexStatusDto`** — the exact shape the
migrate wizard's Index step polls — reused rather than re-invented:
`{ repos: [{ provider, repoRef, status }], indexedCount, total, hasRunning, allIndexed }`.
`status` is `indexed` when a succeeded index run matches the repo's `owner/name`
ref and `pending` otherwise; `pending` covers queued, in flight, **and never
attempted** — the ledger cannot separate them per repo, because a running row
carries no `repoRef` (which is why `hasRunning` is a set-level flag). A
repository connected before the index feature shipped reports `pending`, which is
the honest answer: it has no graph (MOTIR-1961).

`code.installed` is carried separately from `index.total === 0` on purpose: no
installation and an installation whose grant covers no repositories are different
states with different fixes.

**Nothing configured is an ANSWER, not an error.** A project with no
installation, no repos and no migrate run returns
`installed: false`, an empty index status, `repoSet: []` and `onboarding: null` —
every field present. A planner must be able to tell "there is no code" from "I
could not look".

**Read-only.** There is no way here to stamp the onboarding marker, trigger an
index, or advance a migrate run. Reporting a precondition and satisfying it are
different acts; only the first lives on this surface. It also makes no `motir-ai`
round-trip — pre-plan document contents and the code-graph query surface stay
behind the open-core boundary.

**Access + tenancy.** `projectKey` selects **within** the token's workspace, it
does not choose one: the key is resolved by the same browse-gated service every
other project-scoped tool uses, so another tenant's key reads as a plain
not-found (404-not-403, no existence leak).

**No per-repo cost.** The index state comes from ONE ledger query joined against
the repo list in memory, so the call's query count is invariant to how many
repositories the grant covers.

#### `get_code_health`

The **planning read** of a project's code health: what the hosted planner reads
for every planning session it runs (motir-ai's `code_health` retrieval over the
convention and audit stores), in one call per project. `get_project_state`
answers "is the code connected and indexed"; this answers "what does each
repository's code look like, and what conventions does it follow".

For **every realized repository in the project's set** (a proposed row with no
repository behind it contributes nothing), one entry carrying:

- its code-graph **index state** — `indexState`, `indexedAt`, `commitsBehind`,
  `refreshFailing`, read from motir-core's own columns through the same join
  `GET /api/ai/code-context` uses, so the two cannot disagree;
- its latest **audit's health summary** — the grade, conformance and per-category
  rollup. No findings page;
- its current derived **coding convention** — the latest version only, no
  version history.

**Input**

| Field        | Type   | Required | Notes                       |
| ------------ | ------ | -------- | --------------------------- |
| `projectKey` | string | yes      | Project key, e.g. `"ACME"`. |

**Output** — `structuredContent`: a `PlanningCodeHealthDTO`:

| Field     | Type     | Notes                                                                  |
| --------- | -------- | ---------------------------------------------------------------------- |
| `project` | object   | `{ key, name }`.                                                       |
| `repos`   | object[] | One per realized repository, in set order. `[]` when the set is empty. |

Each `repos[]` entry is
`{ repoRef, indexState, indexedAt, commitsBehind, refreshFailing, audit, convention }`,
where `audit` and `convention` each carry a **`state`**:

| `state`       | Meaning                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `present`     | The store has one. `audit` adds `{ healthSummary, createdAt, codeGraphRef }`; `convention` adds `{ convention }` (a `CodingConventionDTO`: `id`, `repoKey`, `version`, `contentMd`, `provenance`, `createdAt`). |
| `absent`      | The read succeeded and the store has nothing yet — no audit run, no convention derived. **Not an error.**                                                                                                       |
| `unavailable` | That one boundary read failed; `code` is the error's (e.g. `MOTIR_AI_UNAVAILABLE`). It degrades **that section only** — the call succeeds and every other section still answers.                                |

`absent` and `unavailable` are kept apart on purpose: a planner must be able to
tell "no audit yet" from "motir-ai could not be reached".

**A project with no repository returns `repos: []`**, and a summary saying so —
never an error.

**Permission: `ai:plan`, at the door and in the service.** The `/code-health`
page's own reads are gated on `ai:configure`; this planning read is gated on
`ai:plan`, because the hosted planner already composes the same convention and
audit summary into every `ai:plan` holder's sessions
(`docs/decisions/member-facing-permissions.md` AMENDMENT 3). The service asserts
the same key the door checks, so a token narrowed off `ai:plan` is refused at the
door and an owner whose role lacks it is refused by the service. Re-audit and
refresh stay on `ai:configure`, and are not reachable here.

**Read-only.** No write, no model job. `projectKey` selects **within** the token's
workspace; another tenant's key reads as a plain not-found.

#### `read_file`

The **text of one file** in one of the project's repositories, as the git host
holds it at a ref — the read the hosted planner's own `read_file` makes
(motir-ai `src/llm/codeReadTools.ts`, served by
`app/api/internal/ai/repo-file`), for an agent planning over the MCP. Reach for it
to CHECK a code fact before writing it into a card.

**Input**

| Field        | Type    | Required | Notes                                                                                                |
| ------------ | ------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `projectKey` | string  | yes      | Project key, e.g. `"ACME"`.                                                                          |
| `repo`       | string  | yes      | A repository in the project's set: the bare name (`motir-core`) or `owner/name`, case-insensitively. |
| `path`       | string  | yes      | Relative to the repository root. No URL, no absolute path, no `..` segment.                          |
| `ref`        | string  | no       | Branch, tag or commit. Omitted ⇒ the repository's default branch, as stored on its row.              |
| `startLine`  | integer | no       | 1-based, inclusive. With `endLine`, the range is clamped to the file and headed `lines a-b of N`.    |
| `endLine`    | integer | no       | 1-based, inclusive. Omit with `startLine` set to read to the end of the file.                        |

**The cap and the range.** The text returned — the range when one is asked for,
else the whole file — is capped at **24,000 characters**, motir-ai's
`FILE_CONTENT_CAP`. Over the cap it is cut, and ends with a SENTENCE, never a
bare ellipsis: _the first 24000 of N characters; the file continues; re-read with
startLine / endLine_. The cap, the marker and the range semantics are copied from
the planner's tool, so both planners read the same evidence in the same shape.

**Output** — `structuredContent.outcome` names what happened, and every outcome is
a **non-error** result with its own summary sentence:

| `outcome`              | Meaning                                                                                                                    | Extra fields                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `found`                | The file's text (ranged, then capped).                                                                                     | `repoRef`, `path`, `ref`, `bytes`, `lines`, `truncated`, `text` |
| `directory`            | The path is a directory: its immediate entries (`name`, `type` file/dir/symlink/submodule), sorted by name, at most 1,000. | `repoRef`, `path`, `ref`, `entries`, `truncated`                |
| `not_found`            | The ref resolved and the path is not there. A fact about the PATH, not the repository.                                     | `repoRef`, `path`, `ref`                                        |
| `ref_not_found`        | The ref does not exist. Says nothing about the path.                                                                       | `repoRef`, `path`, `ref`                                        |
| `too_large`            | The file exists and is over what the host serves inline.                                                                   | `repoRef`, `path`, `ref`, `limitBytes`                          |
| `binary`               | The file exists and holds a NUL character, so no text is returned.                                                         | `repoRef`, `path`, `ref`, `bytes`                               |
| `unauthorized`         | The host refused the stored credential. The file's existence is unknown.                                                   | `repoRef`, `path`, `ref`                                        |
| `invalid_path`         | The path was refused before any request.                                                                                   | `repoRef`, `path`, `reason`                                     |
| `unreachable`          | The host did not answer — a failure to ASK, not an answer.                                                                 | `repoRef`, `path`, `ref`, `failure`                             |
| `repo_not_connected`   | The repository is in the set but not connected to the organisation.                                                        | `repoRef`                                                       |
| `provider_unavailable` | The repository's git provider cannot be used on this deployment.                                                           | `repoRef`, `detail`                                             |
| `repo_not_in_project`  | `repo` matches no repository in the project's set. Answered **before** any host call.                                      | `repo`, `repoSet`                                               |

None of them means the project has no code, and none carries a provider
credential or a download URL.

**Listing a directory (MOTIR-9868).** A `path` naming a directory is LISTED, not
read: the outcome is `directory`, never the host's own listing JSON as `found`
text (which is what GitHub's contents endpoint used to hand back). GitLab answers
the same path the same way, from its repository tree. It is how a file that is not
code — a CI workflow, a Dockerfile, a config — is found when its exact path is not
known and `code_search` on its name did not return it.

**Permission: `ai:plan`, at the door and in the service** — the same gate as
`get_code_health`, on the same argument: the hosted planner already shows this
text to every `ai:plan` holder (`docs/decisions/member-facing-permissions.md`
AMENDMENT 3). **The project's set is the boundary**, not the organisation's
connections: a repository another project of the same organisation connected
reads as `repo_not_in_project`.

**Read-only**, but **open-world**: the read calls the third-party git host.
`projectKey` selects **within** the token's workspace; another tenant's key reads
as a plain not-found.

#### `code_explore` and `code_search`

The **hosted code graph**, for an agent planning over the MCP: the hosted
planner's own `code_explore` / `code_search` (motir-ai `src/llm/codeGraphTools.ts`),
run in motir-ai behind `POST /v1/code-graph/read`. An `ok` answer's text is that
executor's bytes **verbatim**, so the agent reads what the hosted planner reads
for the same query, repository set and graph commit. motir-core holds **no
graph-read credential**: only core ids, repo refs and the tool's arguments cross
the boundary (`docs/decisions/code-graph-service.md`, item 2 and its MOTIR-7860
amendment).

**Input**

| Field        | Type    | Required | Notes                                                                                                  |
| ------------ | ------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `projectKey` | string  | yes      | Project key, e.g. `"ACME"`.                                                                            |
| `query`      | string  | yes      | A symbol, a concept, or a few words naming the code.                                                   |
| `repo`       | string  | no       | ONE repository in the project's set — bare name or `owner/name`, case-insensitively. Omit to read all. |
| `cursor`     | string  | no       | The `cursor` a page line printed, passed back exactly, with the same other arguments.                  |
| `limit`      | integer | no       | `code_search` only: the page size.                                                                     |

**Paging.** A result with more than one page prints `page k of N` and a
`cursor`; pass it back for the next page. A cursor names one repository.

**Output** — `structuredContent.state`, every one a **non-error** result:

| `state`             | Meaning                                                                                                     | Extra fields                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ok`                | The executor's text, unchanged.                                                                             | `text`                                                                      |
| `no_repositories`   | The project's set holds no realized repository. Decided in core; motir-ai is not called.                    | —                                                                           |
| `repo_not_in_set`   | `repo` matches no repository in the set. Decided in core; motir-ai is not called.                           | `repo`, `available`                                                         |
| `not_indexed`       | A repository in the set has no graph yet. Enriched with core's own code-context facts.                      | `repoRef`, `indexState`, `commitsBehind`, `refreshFailing`, `graphTooLarge` |
| `no_graph`          | No repository of the set has a graph.                                                                       | —                                                                           |
| `stale_cursor`      | The code changed since that page — re-run without `cursor`.                                                 | —                                                                           |
| `invalid_cursor`    | A cursor this read did not issue.                                                                           | —                                                                           |
| `graph_unavailable` | The graph could not be read: motir-ai's own reason, or `ai_unreachable` / `ai_not_configured` / `ai_error`. | `reason`                                                                    |

A request motir-ai rejects as malformed stays an error, so it is seen rather
than read as a soft state.

**Permission: `ai:plan`, at the door and in the service** — as `get_code_health`
and `read_file`, on the same argument (`docs/decisions/member-facing-permissions.md`
AMENDMENT 3). **Read-only**, closed-world: the graph is Motir's own.

#### `get_coding_convention`

**One repository's coding convention, in full.** A repository's own rules live in
its Codebase coding convention (the card on the Code page), not in a file in its
checkout. `get_code_health` carries a convention too, but as one line per
repository inside a planning summary; this is the document itself, so a
`motir run` prompt can point the agent here instead of at `CLAUDE.md`.

**Input**

| Field        | Type   | Required | Notes                                                                              |
| ------------ | ------ | -------- | ---------------------------------------------------------------------------------- |
| `projectKey` | string | yes      | Project key, e.g. `"ACME"`.                                                        |
| `repo`       | string | yes      | A repository in the project's set — bare name or `owner/name`, case-insensitively. |

**Output.** The text result is headed by the repository, the version and whether
the version was `derived` from the code or `edited by <name> on <date>`, followed
by the convention document. `structuredContent.state` is one of these, every one
a **non-error** result:

| `state`               | Meaning                                                                           | Extra fields                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `present`             | The current version.                                                              | `repoRef`, `version`, `authorKind`, `editedByName`, `editedByUserId`, `updatedAt`, `pendingDerived`, `contentMd` |
| `absent`              | No convention has been derived or saved for the repository yet.                   | `repoRef`                                                                                                        |
| `unavailable`         | motir-ai did not answer; this does not mean none is recorded.                     | `repoRef`, `code`                                                                                                |
| `repo_not_in_project` | `repo` matches no repository in the set. Decided in core; motir-ai is not called. | `repo`, `repoSet`                                                                                                |

`pendingDerived: true` means a re-derive produced a newer document that is parked
beside a person's edited text; the text returned is still the one in force.

**Permission: `ai:plan`, at the door and in the service** — as `get_code_health`
and `read_file`, on the same argument (`docs/decisions/member-facing-permissions.md`
AMENDMENT 3). Every `motir run` token holds it. **Read-only**, closed-world.

#### `skeleton`

**Orient before proposing.** The whole project's tree SHAPE in ONE read — every
live work item's key, kind, title, status and parent — so an agent can answer
_does this already exist?_ before it proposes anything. It REPLACES paging
`search_work_items` fifty flat rows at a time and re-parenting them client-side;
it is not a second way to list items, and it deliberately carries no
descriptions, no assignees and no filters.

It is the same read `motir-ai`'s planner calls, under the same name
(`aiBoundaryService.readPlanTree`, served internally at `plan-tree` / `skeleton`),
so an agent that has read one tool surface finds the same concept called the same
thing on the other.

**Input**

| Field        | Type             | Required | Notes                                                                                             |
| ------------ | ---------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `projectKey` | string           | yes      | Project key, e.g. `"ACME"`.                                                                       |
| `limit`      | integer (1–5000) | no       | Row bound; default **and maximum 5000** — the whole tree. Pass a smaller number for a cheap peek. |

**Output** — `structuredContent`:

| Field              | Type             | Notes                                                                                        |
| ------------------ | ---------------- | -------------------------------------------------------------------------------------------- |
| `project`          | object           | `{ projectId, projectKey }`.                                                                 |
| `items`            | skeleton row\[\] | `{ key, id, kind, title, status, parentKey, revision, folderId, obsolescence }` — see below. |
| `total`            | integer          | Live work items in the project, **before** the bound is applied.                             |
| `returned`         | integer          | Rows in `items`.                                                                             |
| `truncated`        | boolean          | Whether the bound bit.                                                                       |
| `limit`            | integer          | The bound actually applied.                                                                  |
| `folders`          | folder\[\]       | `{ id, parentFolderId, name, path }` — every folder of the project, see below.               |
| `foldersTruncated` | boolean          | Whether the project holds more folders than `folders` lists.                                 |

`parentKey` is the parent's `<KEY>-<n>` identifier (null at a root), which is what
makes the response a TREE rather than a list — the hierarchy is rebuildable from
this one call. `id` is the real work-item cuid `add_plan_items` takes for
`parentRef` / `blockedByRefs` (it also accepts the `<KEY>-<n>` key), and `revision` is
the `baseRevision` a `modify` / `remove` proposal anchors on — both ride the row
so orienting and proposing do not cost a `get_work_item` per target.
`obsolescence` is the [obsolescence mark](#the-obsolescence-mark) — `outdated` /
`deprecated`, `null` while the card is still current. The mark only: its note is
a body, read with `get_work_item`. A marked row is never dropped or re-ordered.

**Folders.** `folderId` is the folder an item is **filed** in — its OWN placement,
null for everything else. Only a root can be filed (an item has a parent OR a
folder, never both), so a story under a filed epic reads `folderId: null`; its
placement follows from its ancestors' keys. `folders` lists every folder of the
project in tree order, each with `path` — its name and every ancestor's, root
first (`["Parked", "2025"]`) — so a `folderId` resolves to a name without a
second read. Folders travel **beside** the rows, never as rows of `items`, and
`total` / `returned` / `truncated` / `limit` count work items only; the folder list
has its own bound, reported by `foldersTruncated`. The text summary names each
returned filed row with its folder path (`Parked ▸ 2025`) and lists the folders.

**The bound announces itself, always.** `total` / `returned` / `truncated` /
`limit` are on every response, not only a truncated one. A skeleton that quietly
stopped at N would read as _"this is the whole project"_, and an agent that
believes it has seen everything proposes work that already exists two levels
down — which is the exact failure this tool was built to prevent.

**Access + tenancy.** `projectKey` selects **within** the token's workspace, it
does not choose one. Another tenant's key is a plain not-found — never a partial
tree, and never proof the project exists. (The internal route this shares a read
with takes no project at all, because a job token is scoped to exactly one; a PAT
is not, which is the whole reason this tool takes a key.)

**Read-only**, and no `motir-ai` round-trip.

#### `mark_integrated`

Record that a work item's work has been integrated onto a session branch (the
write the CLI loop calls on agent success): the item moves to **In review** and
its `sessionBranch` is recorded — in ONE transaction — which unblocks its
dependents while the session PR awaits a human merge. Optionally self-report the
**implementation provenance** — how the item was built (Story MOTIR-1685).

**Input**

| Field                   | Type                 | Required | Notes                                                                                                             |
| ----------------------- | -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `key`                   | string               | yes      | The work item identifier, e.g. `ACME-7`.                                                                          |
| `sessionBranch`         | string               | yes      | The integration branch the work was merged onto.                                                                  |
| `implementationSource`  | `"byok" \| "manual"` | no       | Self-reported execution lane; defaults to `byok` when a harness/model is reported. `hosted` is not accepted here. |
| `implementationHarness` | string               | no       | Self-reported harness (e.g. `opencode`, `Claude Code`). Recorded as-is (no verification implied).                 |
| `implementationModel`   | string               | no       | Self-reported model (e.g. `claude`, `deepseek`).                                                                  |

**Output** — `structuredContent`: the updated `WorkItemDto` (now `in_review`,
carrying `sessionBranch` and any recorded implementation provenance). Omitting
the provenance fields leaves the implementation triple untouched. See
`docs/decisions/work-item-provenance.md`.

#### `complete_session`

Close out a session branch after its PR is merged: every work item recorded on
the branch moves to **Done** and its branch is cleared, in one transaction.
Returns a per-item outcome (`completed` / `already_done` / `failed`). Optionally
self-report implementation provenance applied to **every item it closes**.

**Input**

| Field                   | Type                 | Required | Notes                                                                  |
| ----------------------- | -------------------- | -------- | ---------------------------------------------------------------------- |
| `sessionBranch`         | string               | yes      | The branch whose recorded items are being closed out.                  |
| `implementationSource`  | `"byok" \| "manual"` | no       | Self-reported lane; defaults to `byok`. `hosted` is not accepted here. |
| `implementationHarness` | string               | no       | Self-reported harness, stamped on every closed item.                   |
| `implementationModel`   | string               | no       | Self-reported model, stamped on every closed item.                     |

**Output** — `structuredContent`:
`{ sessionBranch, results: [{ key, outcome, reason? }] }`. Omitting the
provenance fields leaves each item's provenance as its `mark_integrated` report
or the manual-lane stamp.

## Permission model

The MCP layer does **not** re-implement authorization. There is exactly one auth
decision point: the transport-level bearer gate (`lib/mcp/auth.ts`).

- **The bearer gate resolves the actor once per request.** `verifyMcpToken`
  re-hashes the presented PAT, looks it up, and rejects absent / malformed /
  unknown / revoked / expired tokens with a **401 before any tool dispatch**. On
  success it resolves the token owner's active/default workspace (the same
  cookie-less resolution the HTTP middleware uses) and stashes
  `{ userId, workspaceId }` on the request's `AuthInfo.extra`.
- **Every tool runs in that user's `ServiceContext`.** `contextFromExtra` lifts
  the resolved `{ userId, workspaceId }` into the `ServiceContext`
  (`lib/mcp/context.ts`) and the tool calls the **same service method** an HTTP
  route calls. So the **Story 6.4 role checks** (browse gate on reads, edit gate
  on writes, sprint-admin gate on sprint mutations) apply **unchanged** — no
  tool re-checks them.
- **Cross-tenant access returns not-found, never a leak.** A work item, project,
  or sprint that is unknown or belongs to another tenant surfaces as the **same
  "not found"** result a genuinely missing one does (the service throws the same
  `WorkItemNotFoundError` / `ProjectNotFoundError` / `SprintNotFoundError` for
  both). This is the **404-not-403 contract** — the MCP surface never returns a
  403 that would confirm a resource exists.

In short: an agent acting through a PAT can do exactly what its token's owner can
do through the web UI in that user's active workspace — no more, no less.

## Security notes

- **The plaintext token is shown once.** When you create a token, copy it
  immediately — it is never displayed again and cannot be recovered.
- **Treat it like a password.** Store it in a secret manager or your agent's
  credential store, never in committed code or shared chat.
- **Set an expiry.** Prefer a bounded lifetime (30 / 90 / 365 days) over "never";
  90 days is a reasonable default for an agent you re-provision periodically.
- **Revoke on leak — instantly.** Revoking a token from Settings → Account → Tokens
  is instant: the very next tool call with that token fails the bearer
  gate with a 401. Revocation **DELETES the token row** (MOTIR-3546) — the list
  holds live credentials only. It used to be a soft revoke that stamped
  `revokedAt` and kept the row "for the audit trail"; nothing ever read that
  trail, so the row stayed in the owner's list for ever with no way to remove
  it. The 401 is undifferentiated either way: a revoked, expired, unknown or
  malformed token are all one `unauthenticated`, deliberately
  (`docs/decisions/public-api-conventions.md`).
- **Tokens are stored only as a SHA-256 hash.** Motir persists the hash plus a
  short display prefix — never the plaintext. A database read cannot reveal a
  usable token.
- **The `motir_pat_` prefix is greppable on purpose.** Like GitHub's `ghp_`
  convention, the fixed prefix lets secret scanners detect a leaked Motir token
  in code or logs.
