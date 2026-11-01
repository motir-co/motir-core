# Platform admin console — design notes

Design reference for the **`platform-admin`** UI area — the **INTERNAL operator
console for Motir platform staff** (moooon B.V.), Epic 10 · Story 10.1 · subtask
**10.1.1** (card **MOTIR-728**). The asset is the source of truth for the three
code subtasks it gates: the estate overview (**10.1.4**), the usage/cost rollups
(**10.1.5**) and the drill-down (**10.1.6**) — each `blocked` behind this design
gate (Principle #13 + the design-reference rule; without it the operator console
would be improvised — forbidden, `notes.html` #31). Built FROM the real design
system (`app/globals.css` `--el-*` colour tokens + `[data-display-style]` shape
tokens + the shipped `components/ui/*` primitives), so the code subtasks compose
the same primitives — no mock→code gap. Most of `console.mock.html`'s token
block + primitive CSS is shared 1:1 with `design/ai-usage/usage.mock.html`, the
closest existing usage surface.

| Surface                                                                                                                  | Asset                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform admin console (access · search · nav shell · overview · usage/cost · seats · read-only drill-down · states)** | **`console.mock.html`** (HTML mockup) | The whole operator surface. Seven panels: **access path** · **estate overview** (in the left-nav shell + search top bar) · **global search** · **usage/cost · by tenancy** (rollup + members) · **usage/cost · by model & consumers** · **drill-down** (seats + read-only inspect) · **gating / empty / loading / error**. **Gates 10.1.4 / 10.1.5 / 10.1.6.** A `console.png` full-page export sits beside it. |

| **ORG lookup · ORG page · the internal-billing CLASSIFICATION control** (AMENDMENT 2026-09-05) | **`console.mock.html`** (HTML mockup, Panels 10 · 10b · 11 · 12) | The ORG level of the reserved **Tenants** row. Four panels: the **org lookup** (a GET form, the shipped user-lookup grammar one entity over) · its **three states** (idle · query too short · no results) · the **org page** (identity, plan tier, balance, the `isMeta` and `internalBilling` chips drawn SEPARATELY, MOTIR-733's panels as RESERVED regions, and the allocation table) · the **classification control** in six states (not-classified · classified · confirm with a mandatory reason · reason-missing · already-in-that-state · generic failure) with the `PlatformAuditLog` row rendered back on the same surface. **Gates MOTIR-4566 and MOTIR-4568** (Story MOTIR-4337). Draws to `docs/decisions/internal-billing-classification.md`. |
| **The OPS TOOLKIT — org Operations tab · credits & plan · org suspend · kill-switches · View as · the audit log** (AMENDMENT 2026-10-03) | **`console--ops-toolkit.mock.html`** (delta, Panels 1–8) | Story 10.3’s governance writes on the shipped org and user pages, plus the hash-chained audit log at `/admin/audit-log`. **Gates MOTIR-747 … MOTIR-752.** |
| **ENTERPRISE REQUESTS — the rail row · the list (state filter, cursor paging, count) · the detail per state · support read-only · stale refusal** (AMENDMENT 2026-10-05) | **`console--enterprise-requests.mock.html`** (delta, Panels 1–10) | A new Platform-group page at `/admin/enterprise-requests` where staff work the requests orgs send from the Enterprise card’s Contact sales. **Gates MOTIR-7609.** |
| **IDEAS — the rail row · the list (status / kind / category / tag / text filters in the URL, keyset pages) · the detail · edit with evidence rows · retire with a reason · a superadmin’s delete · support read-only** (AMENDMENT 2026-10-07) | **`console--ideas.mock.html`** (delta, Panels 1–12) | A new Operations page at `/admin/ideas` where staff review, correct, retire and delete the ideas motir.co shows. **Gates MOTIR-7680 and MOTIR-7681.** |
| **FLEET SETTINGS — the rail row · the superadmin setting “Run Motir’s private repositories’ CI on the fleet” · the nine-condition readiness verdict · confirm ON / OFF with a reason · the refusals · read failed · not superadmin** (AMENDMENT 2026-10, MOTIR-8703) | **`console--fleet-settings.mock.html`** (delta, Panels 1–13) | A new Operations page at `/admin/fleet-settings` where a superadmin moves Motir’s private repositories’ CI onto the fleet once it is ready, and off at any time. **Gates the /admin setting UI card (story MOTIR-8699, `blocked_by` MOTIR-8703).** |
| **PROVIDER CAPACITY — the rail row · usage against limits per provider and model (planning and agent lanes) · the states · the edit dialog and its refusals · the alert share · the raised-alert banner · degraded, unreachable and refused reads · support read-only · zh** (AMENDMENT 2026-10-25, MOTIR-9607) | **`console--capacity.mock.html`** (delta, Panels 1–17) | A new Operations page at `/admin/capacity` where platform staff see how close each provider model is to its limits, and operators edit limits and the alert share. **Gates the capacity screen card (story MOTIR-9539, MOTIR-9614 `blocked_by` MOTIR-9607).** |
| **MONITORING · POOLS — one block per fleet kind on `/admin/monitoring`: provider, pool total, account rows, the Motir spare, quota raises, growth events, every state** (AMENDMENT 2026-10-25) | **`monitoring--pools.mock.html`** (delta, Panels 1–9, each light then dark) | A section added after the Fleet section of the shipped monitoring page; no new route. See § _AMENDMENT 2026-10-25 — Monitoring · Pools_. |

## What this area is

The **home base for Motir's own operators**. It is **NOT a customer surface** — a
single internal console from which platform staff see the WHOLE estate: every
organization, workspace, project and user across all tenants, plus the
platform-wide usage/cost rollup. It is the same multi-tenant superadmin idiom
GitLab, Sentry, Stripe and Vercel run for their own staff.

- **Internal & gated.** It lives at **`/admin`** (suggested route group
  `app/(admin)/admin/…`, a sibling of `(authed)` / `(public)`), reachable only
  by platform staff. For everyone else the route is a **404** — the surface does
  not exist for them; there is **no visible "403 / forbidden" page** (its very
  existence is not leaked). See Panel 7a. Staff ENTER via the account-menu item
  in Panel 1; they NAVIGATE via the left-nav shell + the top-bar search.
- **Read-mostly (this Story).** Story 10.1 draws **READ** views — overview, the
  usage/cost rollup, the drill-down — plus the **read-only inspect** (below). The
  governance **WRITE actions** (suspend a tenant, adjust credits, write-level
  impersonation, …) are **Story 10.3's governance toolkit**; this design draws no
  destructive control.
- **Denser, but the SAME design system.** Because an operator scans the whole
  estate, the console reads more table-heavy than a customer screen — but it
  composes **only** the shipped `components/ui/*` primitives + `--el-*` / shape
  tokens. **No bespoke admin CSS.** The thing that visually distinguishes it from
  a tenant view is the persistent **`--el-info` operator top bar** (a shield +
  "Platform staff" marker), carried on every page so an operator never confuses
  it with a customer tenant.

### Read-only "View as tenant" — the impersonation question (Yue review #2 · point 3)

Yue asked whether staff should be able to assume another org's identity for
debugging, **read-only**. Yes — and the read/write split is the safety boundary:

- **10.1 (here): READ-ONLY, audited inspection.** The drill-down (Panel 6) is the
  read view; a **"View as tenant (read-only)"** affordance opens a **read-only
  session** — the tenant's own app with a pinned banner and **every write control
  disabled**. Staff SEE exactly what the tenant sees (to debug) but cannot change
  anything; the session is audited (operator + tenant + time).
- **10.3 (governance): WRITE-level impersonation** — acting AS a user with the
  power to change things — is a **separate, heavily-gated** capability (reason
  required, time-boxed, fully audited, possibly two-person). It is **NOT** in
  10.1 and is **not** drawn here beyond naming the boundary.

This split is the answer to the question; the design implements the read-only
half and leaves the write half to 10.3.

### ⚠️ Shared shell — Stories 10.2 + 10.3 EXTEND this area

**This card establishes the `design/platform-admin/` shell language for the whole
of Epic 10.** Story **10.2** (platform monitoring — health / queue depth / error
rates) and Story **10.3** (governance toolkit — the tenant WRITE actions) both
**reuse this shell**: the `/admin` route group, the left-nav rail (their sections
slot into the **Operations** group, drawn here as reserved "10.2" / "10.3" rows),
the operator top bar + search, the `Platform · …` breadcrumb grammar, the
`Card`-stack body, the at-scale table+pager, and the per-entity / per-model colour
roles. Their skeletons should not re-invent any of it.

### ⚠️ Net-new capability (a planning dependency for 10.1.x)

A **platform-staff persona does not exist in the shipped schema** (recon
2026-06-21: only `OrganizationRole` and `MemberRole`, both tenant-scoped; no
`/admin` route, no cross-tenant operator capability). This console introduces a
**net-new platform-staff gate** orthogonal to the tenant roles — a prerequisite
the 10.1.x code subtasks (and likely an **Epic-10 foundation subtask** ahead of
them) must own:

- a **staff flag** (e.g. `User.isPlatformStaff`, seeded only for moooon staff),
- a **`requirePlatformStaff()` guard** that **404s** (not 403s) every non-staff
  request to `/admin` and its APIs,
- an **audit-log write on every cross-tenant read** (incl. each read-only
  session) — the posture Panels 6 makes visible.

Flagged here, not silently assumed. If the planner agrees, add that foundation
subtask to Story 10.1 (or Epic 10) as a `blocked_by` of 10.1.4/5/6.

### Data — usage aggregates the 7.2 `OrgUsageDTO`; seats from membership tables

The usage/cost panels are the **estate-scope** sibling of the **org-scope** 7.2
dashboard (`design/ai-usage/`). The org dashboard reads an **`OrgUsageDTO`**
(`lib/dto/aiUsage.ts`: `balance`, `tier`, `totalSpend`, `monthSpend`,
`monthlyHistory[]`, `perModel[{ model, inputTokens, outputTokens, credits }]`,
`recentRuns[…]`, `hasUsage`) from **motir-ai over the 7.1 boundary**. The platform
console reads the SAME shape **summed up one level** to a **`PlatformUsageDTO`**
(10.1.5 builds): estate counts + a hierarchical `byTenant[]` rollup (project →
workspace → org → platform) + an estate `perModel[]` + a `topConsumers[]`
leaderboard, all **pre-aggregated** (never a live scan). **Member / seat counts**
(Panels 4 + 6) come from **`Organization/Workspace/ProjectMembership`** counts in
`motir-core` (recon-confirmed model names); the **seat LIMIT** is the tier's
`monthlyCreditAllotment` sibling (a tier seat cap, Epic 8 billing) — shown as
`used / limit` only where a tier defines one. **Search** (Panel 3) queries the
same four entity tables. Numbers in the mock are illustrative.

### Where it lives

- A new staff-only route group **`app/(admin)/admin/`** (suggested):
  `admin/page.tsx` (overview), `admin/usage/page.tsx` (the two-view usage page —
  the segmented control switches `?view=tenancy|model` in place),
  `admin/tenants/[scope]/[id]/page.tsx` (drill-down), and a search API the top-bar
  box calls. Gated by `requirePlatformStaff()`; a non-staff request 404s.
- **At-scale (finding #57 — NOT load-all).** Hundreds of orgs, tens of thousands
  of jobs; **every list paginates** — the activity feed (Panel 2), the rollup
  (Panel 4), top-consumers (Panel 5), the per-tenant jobs list (Panel 6), and the
  search results are a bounded top-N per group. Off pre-aggregated reads.

## Access path & navigation (the door, the hallway, and finding things)

The design-reference rule requires drawing **how the surface is reached and moved
through** — not naming routes in prose. Three mechanisms, all drawn:

1. **Entering (Panel 1).** A platform-staff account's **account menu** (the
   shipped TopNav user-avatar `Popover`) carries a staff-only **"Platform admin"**
   item → `/admin`. Absent + a 404 for non-staff (Panel 7a).
2. **Section nav (the shell, Panels 2–6).** A **persistent left-nav rail**
   (`.admin-nav`, the `Sidebar` grammar): a **Platform** group (**Overview ·
   Usage & cost · Tenants**) and an **Operations** group (**Monitoring [10.2] ·
   Governance [10.3]**, reserved). Active section tinted `--el-tint-sky`. Footer:
   operator identity + **"Exit to app"**.
3. **Finding a specific tenant — GLOBAL SEARCH (Panel 3, Yue review #2 · point
   2).** A **search box in the operator top bar**, present on every console
   screen (⌘K). Typing matches the estate; results group **Organizations /
   Workspaces / Projects / Users**, each row showing a member count and a
   drill-in chevron → that tenant's drill-down. The `CommandPalette` grammar.

The **two Usage & cost views jump via a SEGMENTED control** (Yue review #2 · point
1 — see Panels 4–5), and the **drill-down (Panel 6) is reachable** from any tenant
row (Overview / rollup / top-consumers / search) or the Tenants section.

---

## Panels (review EACH — mistake #31)

### Panel 1 — ACCESS PATH (how staff enter /admin)

The normal Motir app `TopNav` with the **account menu open** (the shipped
user-avatar `Popover` + `opt` rows): **Account settings**, **Your organizations**,
then the staff-only **"Platform admin"** row (`i-shield`, a `--el-info` "Staff
only" tag, sub-label "Operator console · the whole estate"), then **Sign out**. A
side note states the gate: the item is **absent** for non-staff and `/admin`
**404s** for them. An `entry-call` line ties the click to the destination (the
console **Overview**).

### Panel 2 — estate OVERVIEW (populated, in the shell)

The landing page, inside the **left-nav shell** ("Overview" active) under the
**operator top bar** (`.adminbar`: the shield + "Platform staff / all reads
audited" marker, the **search box**, the operator avatar). Composes:

- **Estate counts** — four stat `Card`s: **Organizations / Workspaces / Projects /
  Users (seats)**, each a serif hero + a per-entity tinted icon + a
  `+n this month` `--el-success` delta. Per-entity tint, not grey (finding #54).
- **Recent estate activity** — a `Card` `.tbl`, newest first: **When**, **Event**
  (kind `Pill` — new org / new workspace / planning run / coding job), **Tenant**
  (avatar + dotted path), **Detail**. A card-foot **pager** (at-scale, NOT
  load-all · finding #57). Every tenant row drills to Panel 6.
- A footer `reach-note` spells out navigation: rail = sections, search = find a
  tenant, row-click = drill-down.

### Panel 3 — GLOBAL SEARCH (org / workspace / project / user)

The top-bar search, **open** (the box `.focused`, a value typed). A `.search-pop`
results popover (the `CommandPalette` grammar) groups matches by entity —
**Organizations / Workspaces / Projects / Users** — each `.sr-item` an avatar +
name + (for tenant rows) a member-count `.seatcell` + a drill chevron; selecting a
row opens that tenant's drill-down (Panel 6). A keyboard hint (Enter / ↑↓ / esc).
Search is reachable from **every** console screen (the box is in the top bar).

### Panel 4 — USAGE & COST · by tenancy (segmented · members)

Left-nav **"Usage & cost"** active. The page header carries a **`Segmented`
control** (`By tenancy` / `By model & consumers`) — the shipped
`components/ui/Segmented` (an `--el-surface` track, the active option raised with
`--el-page-bg` + `--shadow-subtle` and an `--el-accent` glyph). **This is the
explicit jump to Panel 5 — one page, two views** (Yue review #2 · point 1). The
body is the **rollup TreeTable** (`.tbl.tree`): columns **Tenant** (indented +
expand chevron), **Level** (`Org`/`Workspace`/`Project` `Pill`), **Members** (a
per-level member count — point 4), **Tokens**, **Share** (per-level-tinted
`.usebar`), **Credits**. Rows nest org → workspace → project by indentation; the
foot states "pre-aggregated, never a live scan" + a pager.

### Panel 5 — USAGE & COST · by model & consumers (segmented)

The **same page**, the OTHER `Segmented` option selected (the visible jump from
Panel 4). Two `Card`s (`.grid-2`):

- **By model** — a `.tbl`: per model a **model chip** (coloured `.dot` + name; the
  9.0-gateway models annotate "· 9.0 gateway"), **Tokens**, **Share** `.usebar`
  (per-model tint), **Credits**, **$ equiv** (muted). Palette-tinted per model so
  the costliest is visibly the bigger drain (finding #54).
- **Top consumers** — a `.tbl` leaderboard: a **rank** chip (`.rank.top` top-3,
  `--el-tint-yellow`), the **tenant**, a **Share** `.usebar`, **Credits**, a
  **drill chevron** (each row drills to Panel 6). Foot: "Top 5 of 214" + "View
  all".

### Panel 6 — DRILL-DOWN detail (org / workspace / project, in the shell)

Left-nav **"Tenants"** active. Reached via a tenant row (Overview / rollup /
top-consumers / search) or the Tenants section. Composes:

- **Scope breadcrumb** (`.scope`) — `Platform › Tenants › Acme Corp`, active
  segment `--el-tint-lavender` + the `i-updown` switcher (the Combobox/breadcrumb
  grammar from the org dashboard).
- **Audited-read banner** (`.audit-banner`) — `i-eye` in `--el-info`, **"You are
  viewing Acme Corp's data as platform staff — read-only. This cross-tenant read
  is recorded in the audit log…"**
- **Tenant header** — avatar + name + status `Pill` + tier `Pill` + created-date,
  and a **"View as tenant (read-only)"** `Button` (point 3, the read-only inspect).
- **Read-only session banner** (`.ro-session`, `--el-tint-yellow` dashed) — what
  "View as tenant" opens: the tenant's app with this banner pinned and **every
  write control disabled**, audited; names that write-impersonation is Story 10.3.
- **Seats & members card** (point 4) — a `48 / 50 seats` tier `Pill` + a
  `.seatmeter` (seats used vs tier limit) + a **per-workspace `.tbl`** (Workspace ·
  Members · Projects), so member counts are exposed at org AND workspace AND
  project granularity.
- **Usage & shape card** — a token-only `.trend` sparkline + a `.mini-stats`
  (Workspaces / Projects) + the tenant balance.
- **Recent jobs** — a `.tbl` of planning + coding runs, **paginated**.

### Panel 7 — gating · empty · loading · error

A 2×2 `.states-grid`:

- **(a) Access denied = a 404 (`.state.notfound`).** Non-staff hitting `/admin`
  get the **standard app 404** — "This page doesn't exist", "Back to Motir". A
  dashed reviewer note states the rule: NO "403 / forbidden" page, no hint the
  route is real. (The staff gate from "Net-new capability".)
- **(b) Empty (`.state`).** First run, no usage across any tenant — `i-coins`,
  "No usage yet", "View tenants".
- **(c) Loading (`.state` + `.sk` skeletons, `aria-busy`).** The dashboard
  skeleton while the rollup fetches over 7.1.
- **(d) Error (`.state.err`).** The usage fetch failed (motir-ai down) — `i-alert`
  in `--el-tint-rose`, "Couldn't load usage", an explicit "no tenant has zero
  usage; the figures are simply not loaded" (a fetch error, NOT a misleading
  zero), and a **Retry**.

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive. If a 10.1.x code
subtask needs a genuinely new primitive, that is a **new `design/` subtask**, not
a code workaround.

- **`Sidebar` (the left-nav shell · `.admin-nav`)** — the persistent console
  navigation on every page (Panels 2–6): brand header, grouped nav rows
  (`.nav-item`, `--radius-control` / `--spacing-control-*`, active row
  `--el-tint-sky`), the reserved 10.2/10.3 rows, the operator footer + "Exit to
  app". The shipped `Sidebar` / nav-row grammar (`design/shell/`).
- **`Popover` + menu rows (the access path · Panel 1)** — the account menu in the
  TopNav (the shipped user-avatar `Popover`) carries the staff-only "Platform
  admin" `opt` row → `/admin`.
- **`CommandPalette` / search (the operator top bar · Panel 3)** — the search box
  (`.searchbar`) + the grouped `.search-pop` results (Organizations / Workspaces /
  Projects / Users), the shipped grouped-keyboard-search grammar
  (`components/ui/CommandPalette.tsx`). The box lives in the top bar on every
  page; ⌘K opens it.
- **`Segmented` (the usage view switcher · Panels 4–5)** — the shipped
  `components/ui/Segmented`: an `--el-surface` track + a 2px inset, each option
  `--height-control` at `calc(--radius-btn - 2px)`, the active option raised
  (`--el-page-bg` + `--shadow-subtle`, `--el-accent` glyph). Switches `By tenancy`
  ↔ `By model & consumers` in place — do NOT hand-roll tabs.
- **`Card`** — every stat / rollup / per-model / top-consumers / seats / usage /
  recent-jobs / state card.
- **`Pill`** — level chips, event-kind chips, model chips, tenant status + tier
  chips (incl. the `48 / 50 seats` tier pill), neutral counts. Hue in the tint
  BACKGROUND with `--el-text-strong` text (finding #35 — AA-safe).
- **`Button`** — primary ("Back to Motir"), secondary ("View as tenant
  (read-only)", "Retry", "Exit read-only"), the pager / "View all" ghosts.
- **Table / list pattern + pagination** — the activity feed, the rollup TreeTable
  (level indentation + expand chevron + the Members column), the per-model + top
  consumers + per-workspace + recent-jobs tables, each with the at-scale foot
  pager. Reuse the issues-list / org-roster pattern.
- **`Combobox` / breadcrumb** — the `Platform › Tenants › …` drill scope (Panel 6).
- **`EmptyState` / `ErrorState`** — Panel 7 b / d (the 404 reuses the `.state`
  shell). **`Skeleton`** — Panel 7c.
- **Meter / bar (token-only)** — the share `.usebar`s, the per-tenant `.trend`,
  and the **`.seatmeter`** (seats used vs tier limit) are token-styled `div`s, no
  charting lib.

## The page header grammar (every console page in this delta)

Title and subtitle, then ONE **toolbar row** beneath them: what the page is scoped to on the left (the Tenants
filter, the org page's scope picker — nothing on Usage & cost), and the **period switch** (`Segmented`: the
month picker, then **All time**) always on the **right**. The switch never sits in the title row, so a long
subtitle cannot move it. A back button (`← Tenants`, `← {org}`), where there is one, sits above the title.

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                                               | Token                                                                                             | Why                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Operator top bar + staff marker / search**          | `--el-tint-sky` bar + `--el-info` rule & shield, text `--el-text-strong`                          | The OPERATOR marker on every page — the info family (finding #35).      |
| **Active left-nav row + active account-menu item**    | `--el-tint-sky` + `--el-text-strong`, icon `--el-info`                                            | The current section — matches the operator bar.                         |
| **Active segmented option**                           | `--el-page-bg` raised + `--shadow-subtle`, glyph `--el-accent-on-surface`                         | The shipped `Segmented` active treatment.                               |
| **Estate count / avatar: Organizations**              | `--el-tint-lavender` + `--el-accent-on-surface`                                                   | The tenancy root — the brand-purple family.                             |
| **… Workspaces / Projects / Users**                   | `--el-tint-sky`/`--el-info` · `--el-tint-mint`/`--el-success` · `--el-tint-rose`/`--el-highlight` | One tier, one hue, everywhere (counts, level pills, share bars).        |
| **Level pill + share bar: Org / Workspace / Project** | `--el-tint-lavender` · `--el-tint-sky`/`--el-info` · `--el-tint-mint`/`--el-success`              | The tier tints, consistent across the rollup.                           |
| **Member / seat counts (`.seatcell`, `.seatmeter`)**  | icon `--el-text-faint`, meter fill `--el-accent`, `n / limit` tier `Pill` `--el-tint-lavender`    | Seats read as neutral metadata; the tier pill carries the limit.        |
| **Audited-read banner**                               | `--el-tint-sky` + `--el-info` `i-eye`                                                             | "Viewing another tenant (read-only, audited)".                          |
| **Read-only SESSION banner (`.ro-session`)**          | `--el-tint-yellow` dashed + `--el-warning` `i-eye`                                                | A live read-only impersonation session — a cautionary (not danger) hue. |
| **Model: Opus / Sonnet / Haiku / DeepSeek**           | `--el-accent` · `--el-info` · `--el-success` · `--el-type-subtask`→`--color-accent-teal`          | Costliest = strongest hue; DeepSeek = the 9.0-gateway teal channel.     |
| **Top-consumer rank (top 3)**                         | `.rank.top` `--el-tint-yellow` + `--el-text-strong`                                               | The leaders stand out; 4+ neutral.                                      |
| **Tenant status Active / tier chip**                  | `--el-tint-mint` · `--el-tint-lavender` (+ `--el-text-strong`)                                    | Healthy tenant; the plan tier.                                          |
| **Error icon (Panel 7d) / 404 icon (Panel 7a)**       | `--el-tint-rose`+`--el-danger-text` · `--el-surface`+`--el-text-faint`                            | Fetch error; a plain not-found (no "forbidden" red).                    |
| Text / surfaces / borders                             | `--el-text*`, `--el-surface*`, `--el-border*`                                                     | Standard element tokens — never Tier-0 `--color-*`.                     |

> **One deliberate Tier-0 reach:** the DeepSeek dot/bar uses `--color-accent-teal`
> (via the `--el-type-subtask` fallback), exactly as `design/ai-usage/` does. When
> 10.1.5 builds this, prefer adding `--el-model-deepseek` (or reusing
> `--el-type-subtask`) over Tier-0 (`notes.html` #20). Every other colour routes
> through `--el-*`.

All shaped surfaces use the **`[data-display-style]` shape tokens** — never the
inert Tier-0 radius/spacing scale or a fixed raw utility. `rounded-full` (`9999px`)
only for round dots / bar caps / circular avatars. Toggle the mock's dark mode to
confirm token parity.

## Copy strings (en — the `admin` / `platformAdmin` i18n namespace 10.1.x adds)

- **Access path (account menu):** item **"Platform admin"** / sub **"Operator
  console · the whole estate"** / tag **"Staff only"**.
- **Operator top bar:** marker **"Platform staff"** / **"all reads audited"**;
  search placeholder **"Search organizations, workspaces, projects, users…"** (⌘K).
- **Left-nav shell:** brand **"Motir"** / **"Platform admin"**; groups
  **"Platform"** / **"Operations"**; items **"Overview"**, **"Usage & cost"**,
  **"Tenants"**, **"Monitoring"** (tag **"10.2"**), **"Governance"** (tag
  **"10.3"**); footer **"Platform staff"** / **"{email}"** / **"Exit to app"**.
- **Search results:** groups **"Organizations"** / **"Workspaces"** / **"Projects"**
  / **"Users"**; hint **"Enter opens the selected tenant's drill-down · ↑ ↓ to move
  · esc to close"**.
- **Overview:** breadcrumb **"Platform · Overview"**; title **"Platform
  overview"**; counts **"Organizations"** / **"Workspaces"** / **"Projects"** /
  **"Users (seats)"**, delta **"+{n} this month"**.
- **Usage & cost:** title **"Usage & cost"**; segmented **"By tenancy"** / **"By
  model & consumers"**; hero **"{n} credits · platform total this month"**; rollup
  **"Spend by tenancy"** / **"Expand an org to its workspaces and projects. Members
  shown per level."**; columns **"Tenant"**, **"Level"**, **"Members"**,
  **"Tokens"**, **"Share"**, **"Credits"**; levels **"Org"** / **"Workspace"** /
  **"Project"**; foot **"Top {n} of {total} orgs · pre-aggregated, never a live
  scan of raw usage rows."**
- **By model / top consumers:** **"By model"**; columns **"Model"**, **"Tokens"**,
  **"Share"**, **"Credits"**, **"$ equiv"**; **"· 9.0 gateway"**; **"Top
  consumers"** / **"The orgs & workspaces draining the most. Click to drill in."**
- **Drill-down:** scope **"Platform › Tenants › {tenant}"**; audit **"You are
  viewing {tenant}'s data as platform staff — read-only. This cross-tenant read is
  recorded in the audit log (operator {op} · {email}, just now)."**; **"View as
  tenant (read-only)"**; read-only session **"Read-only session. 'View as tenant'
  opens {tenant}'s own app with this banner pinned and every write control
  disabled — staff can SEE what the tenant sees to debug, but cannot change
  anything. The session is audited. (Acting as a user with write is Story 10.3
  governance, separately gated.)"** / **"Exit read-only"**; status **"● Active"**;
  tier **"{tier} tier"**.
- **Seats & members:** **"Seats & members"** / **"Members per level. Seat limit
  from the tier (Epic 8)."**; tier pill **"{used} / {limit} seats"**; **"{used} of
  {limit} {tier}-tier seats used across {w} workspaces & {p} projects."**; columns
  **"Workspace"**, **"Members"**, **"Projects"**; **"+{n} more workspaces"**.
- **States:** 404 **"This page doesn't exist"** / **"Back to Motir"**; empty **"No
  usage yet"** / **"View tenants"**; loading **"Loading the estate rollup…"**;
  error **"Couldn't load usage"** / **"…your figures are simply not loaded."** /
  **"Retry"**.

The full string set is added to the app's locale files (en + zh, the shipped
locale set) by the 10.1.x code subtasks under the new `admin` namespace.

---

# The DAY-1 operator panels — Panels 8 & 9 (Story 8.5 · Subtask 8.5.10, card MOTIR-1166)

Everything above this line is **Subtask 10.1.1**'s (card `MOTIR-728`, merged
2026-06-21/22) and is **NOT re-specified here**. Panels 1–7 — the access path, the
console shell, the global search, the two usage/cost views, the tenant drill-down
and the states — remain that card's design, unchanged. This section adds the two
panels 10.1.1 deliberately deferred, because **Story 8.5 (launch readiness) needs
them before Epic 10 runs**: a read-only **system-health glance** and a minimal
**audited support action**.

> **Why they live in THIS file rather than a second asset.** The area already has
> one asset with one basename. A second `platform-admin.*` trio would be two
> pictures of one screen, free to drift from the day both merged — the failure
> `notes.html` #82 names (_a design card COMPOSES an already-designed sub-surface;
> it does NOT REDRAW it_). So these panels extend `console.mock.html`, reuse its
> shell verbatim, and are drawn INSIDE the same left-nav.

| Surface                            | Asset                                 | Notes                                                                                                                                     |
| ---------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Day-1 system health** (Panel 8)  | **`console.mock.html`** (HTML mockup) | Six read-only signal cards + the overdue-schedules list. Occupies the **Operations → Monitoring** row. **Gates MOTIR-1167.**              |
| **Day-1 support action** (Panel 9) | **`console.mock.html`** (HTML mockup) | The USER drill-down, the two writes, the confirm step with a required reason, and the audit row the write produces. **Gates MOTIR-1167.** |

## The three boundaries, in writing

1. **Story 10.2 SUPERSEDES Panel 8.** The day-1 glance takes the left-nav
   **Operations → Monitoring** row that Panels 2–6 draw as a reserved `10.2` stub.
   When `MOTIR-737` (10.2.1) draws the full ops board — per-provider panels,
   thresholds, error-rate and traffic — that board takes this row and this panel
   goes away. The row has one owner at a time; 10.2.1's own notes must say which
   of these elements it replaces and which it keeps.
2. **Story 10.3 owns the rest of the WRITES.** Panel 9 draws exactly two: send
   password reset, and suspend / unsuspend an account. Credit and plan governance,
   tier changes, per-org feature flags, time-boxed WRITE-level impersonation and
   the tamper-evident **hash-chained** audit log are 10.3. The "Support actions"
   table here is the plain append-only row `MOTIR-1167` writes — deliberately not
   that. Suspending an ORGANIZATION is 10.3 too; the day-1 answer to an abusive
   tenant is to suspend the account behind it.
3. **Story 10.1 keeps the usage/cost rollups.** Panels 2, 4 and 5 are drawn but are
   NOT `MOTIR-1167`'s to build.

## Panel 8 — the day-1 system-health glance

**Access path (the door, drawn).** The left-nav **Operations → Monitoring** row,
`.nav-item.active` with `--el-tint-sky`, its reserved `10.2` `.soon` chip removed
for this panel. Everything else in the rail, the operator top bar and the footer is
Panel 2's shell verbatim. Breadcrumb `.crumb` → **"Platform · Monitoring"**.

**Posture: READ and LINK, never remediate.** Six cards, each a state and a link-out
to the provider's own dashboard. Motir does not redeploy, cancel or replay — the
link-out is how the operator acts. This is 10.2's _integrate-not-rebuild_ stance
applied one story early, and it is why there is no trace timeline, no log search
and no per-run viewer here.

**The six signals, and where each comes from** (all verified on `origin/main`,
2026-08-10 — a signal nobody can read is not a design, it is a wish):

| Card                  | Reads                                                                                                                                              | Drawn state     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **Database**          | A reachability + latency ping. Neon Postgres, region `iad` — `docs/decisions/application-hosting.md`                                               | Healthy         |
| **Hosting**           | Fly app `motir-core`, org `moooon`, `machine_count` — `production-service-stack.md` records 2, asserted from Fly's API by `ci.yml` on every deploy | Healthy         |
| **Scheduled jobs**    | `ScheduleHealthReportDTO.overdue` from `lib/services/jobScheduleHealthService.ts`, produced by the 09:00 `dailyHealthCheck` schedule probe         | **Degraded**    |
| **Failed jobs**       | The dead-letter set — `lib/jobs/dlq.ts` / `JobRunDlqDTO`                                                                                           | **Degraded**    |
| **Errors**            | Sentry. **Not wired yet** — `MOTIR-1161` provisions and `MOTIR-1162` wires it; `grep sentry package.json` returns nothing today                    | **Can't reach** |
| **Last health check** | The `job_run` row for `scheduled.system.daily-health-check` and its three probes (schedules, runner image, indexer image)                          | Healthy         |

**Three tones, and why all three are on ONE board rather than three boards.** An
operator's real screen is mixed, and the mixed board is the one that proves the
rule that matters: **an unreachable probe must never read as a zero.** The Errors
card says _"No response from Sentry"_ and _"this is **not** an error count of zero"_
in situ — a green card reading "0 errors" while the probe is down is the failure
this panel exists to prevent.

**The one list the glance owns.** _"Overdue schedules"_ — a `.tbl` of the crons
that missed more than one consecutive tick (`Job` / `Cron` / `Last fired` /
`Expected`), with the standard `.card-foot` pager. Everything deeper is a link-out.

**⚠️ Do NOT fork the existing jobs surface.** A per-WORKSPACE view of this same job
data already ships at **`/settings/workspace/jobs`** (`JobsDashboard.tsx`, tabs
`runs | dlq | system`, a DLQ badge count, status filter, paging, row-detail panel).
`MOTIR-1167` reads the platform-wide equivalent through its own staff-gated
service; it does not copy that component and it does not widen it in place.

### Panel 8 — primitives composed (no hand-rolling)

- **`Sidebar` / `.admin-nav`, `.adminbar`, `.navfoot`** — Panel 2's shell, verbatim.
- **`Card`** (`.card` + `.card-head` + `.card-body`) — every signal card and the
  overdue list. New modifier `.hcard` sets only the body padding and two text
  scales (`.hval`, `.hmeta`); it adds no colour and no shape of its own.
- **`Pill`** — the state chip: `.pill-active` (reused verbatim) for Healthy,
  `.pill-warn` and `.pill-down` added. Each carries a `.dot` in the matching tone.
- **The icon tile `.ico`** — with `.sig-ok` / `.sig-warn` / `.sig-down`, following
  `.ico.ent-*`'s exact pattern (a tint background + a stronger ink).
  **⚠️ NOT the `.ico.ent-*` entity tints** — those encode org / workspace / project /
  user identity, and borrowing them for a health card would say "this card is about
  users" in a system where that tint means exactly that.
- **Table + `.card-foot` pager** — the overdue list, the issues-list pattern.
- **`.linkout`** — the new text link-out affordance: `--el-link` + the `i-external`
  lucide glyph.
- **`.note`** — the dashed reviewer note carrying the scope boundary.

### Panel 8 — colour & shape roles

| Element           | Colour token                                                  | Why                                                                                            |
| ----------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Healthy pill      | `--el-tint-mint` bg + `--el-text-strong`                      | Hue in the tint BACKGROUND, strong ink on top — finding #35, AA-safe                           |
| Degraded pill     | `--el-tint-yellow` bg + `--el-text-strong`                    | Same rule, warning hue                                                                         |
| Unreachable pill  | `--el-tint-rose` bg + `--el-text-strong`                      | Same rule, danger hue                                                                          |
| Status dot        | `--el-success` / `--el-warning` / `--el-danger`               | The saturated ink, safe on a dot (no text on it)                                               |
| Signal icon tile  | tint bg + `--el-success` / `--el-warning` / `--el-danger` ink | Mirrors `.ico.ent-*`; the card states its tone twice, which is what an at-a-glance board wants |
| Link-out          | `--el-link`                                                   | The shipped link ink                                                                           |
| Card value / meta | `--el-text` / `--el-text-secondary`                           | The shipped text ramp                                                                          |

Shape everywhere is the element-semantic set — `--radius-card` (cards),
`--radius-badge` (pills), `--spacing-card-padding`, `--height-btn-md`. **No Tier-0
`--color-*` and no raw `rounded-*` / `p-*` / `h-*` in any element this card adds.**

### Panel 8 — copy strings (the `admin` namespace `MOTIR-1167` adds)

- Nav row **"Monitoring"**; breadcrumb **"Platform · Monitoring"**; title
  **"System health"**; sub **"Is the machinery running? Six signals, read-only,
  refreshed on load. Each card links OUT to the provider's own dashboard — Motir
  shows the state and never redeploys, cancels or replays. The deeper per-provider
  board is Story 10.2."**
- State chips: **"Healthy"** · **"Degraded"** · **"Can't reach"** · **"Ran"**.
- Cards: **"Database"** / **"Reachable · {ms} ms"** / **"Neon Postgres · region
  {region}, alongside the app."** / **"Neon console"** · **"Hosting"** /
  **"{n} machines running"** / **"Fly app {app} · org {org} · {region} — last deploy
  {ago}."** / **"Fly dashboard"** · **"Scheduled jobs"** / **"{n} of {total} crons
  overdue"** / **"From the 09:00 daily health check's schedule probe — a cron that
  stopped firing. Listed below."** / **"Inngest functions"** · **"Failed jobs"** /
  **"{n} dead-lettered · 24h"** / **"Failed after their retries. Inngest has no
  literal DLQ — this is the failed-set, and replay happens there."** /
  **"Inngest runs"** · **"Errors"** / **"No response from Sentry"** / **"The probe
  failed — this is not an error count of zero. Last good reading {ago}."** /
  **"Sentry issues"** · **"Last health check"** / **"{date} {time} · {n} probes"** /
  **"Schedules, runner image, indexer image. Runs once daily and does not retry, so
  a miss shows up here as a stale timestamp."** / **"Job runs"**.
- List: **"Overdue schedules"** / **"Crons that missed more than one consecutive
  tick, newest miss first."**; pill **"{n} overdue"**; columns **"Job"**,
  **"Cron"**, **"Last fired"**, **"Expected"**; foot **"Showing {n} of {total}
  overdue · {checked} schedules checked"**.

## Panel 9 — the day-1 support action

**Access path (the door, drawn).** The **USER** drill-down. Panel 3's global search
already groups results into Organizations / Workspaces / Projects / **Users**, each
row with a drill-in chevron — so the user destination is a door Panel 3 promises and
10.1.1 never drew. Panel 9 draws it, in Panel 6's exact grammar: the `.scope`
breadcrumb chips **"Platform › Users › {user}"**, the `--el-info` `.audit-banner`
recording the cross-tenant read, then the identity header.

**The two writes, and nothing else.** `Send password reset` (`.btn-secondary`,
`i-key`) and `Suspend account` (`.btn-danger`, `i-ban`) sit in the header's right
slot, exactly where Panel 6 puts _"View as tenant (read-only)"_. Every other field
on the account is read-only.

**The confirm step is the design.** Each action opens a `.confirm` dialog
(`--radius-modal` + `--shadow-modal`) that states the consequence in plain words —
what happens to the person, what happens to their data, and that it is reversible —
and requires a **reason** before the destructive button is usable. The reason is not
decoration: it is what makes the audit row readable months later. A row that says
only _"suspended by OP"_ answers nothing.

**The result is rendered back.** The **"Support actions"** card underneath is the
append-only log of every operator write on the account (`When` / `Action` /
`Operator` / `Reason`), newest first, with the just-performed row at the top. The
write and its record are one surface, so an operator can never perform an action and
wonder whether it was recorded.

### Panel 9 — primitives composed (no hand-rolling)

- **The shell**, `.scope` breadcrumb chips, `.audit-banner`, the `.row-between`
  identity header, `.ava.ent-user`, `.pill-active` / `.pill-neutral` / `.pill-tier`
  — all Panel 6's, verbatim.
- **`Button`** — `.btn-secondary` (reset, Cancel) and the new `.btn-danger`.
- **`Modal`** — `.confirm`, on `--radius-modal` / `--shadow-modal`.
- **`FormField` / `Input`** — `.field` label + `.input` + `.hint`, on
  `--radius-input`, `--height-input`, `--spacing-input-*`.
- **Table + `.card-foot` pager** — the Support-actions log.
- **`Pill`** — `.pill-down` for **"Suspended"**, `.pill-readonly` for **"Password
  reset sent"**.

### Panel 9 — colour & shape roles

| Element                    | Colour token                                     | Why                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Destructive button         | `--el-danger` fill + `--el-danger-text` label    | The shipped filled-danger CTA. `--el-danger-text` is the **ink ON the fill** (`--color-destructive-foreground`, white), NOT a red label — see the token-correction note below. Measured **4.51:1**, AA |
| Secondary action           | `--el-text` on transparent, `--el-border-strong` | The shipped secondary button                                                                                                                                                                           |
| Audit banner               | `--el-tint-sky` + `--el-text-strong`             | Panel 6's cross-tenant read banner, verbatim                                                                                                                                                           |
| "Suspended" row chip       | `--el-tint-rose` + `--el-text-strong`            | Hue in the tint background — finding #35                                                                                                                                                               |
| "Password reset sent" chip | `--el-tint-sky` + `--el-text-strong`             | A non-destructive operator action                                                                                                                                                                      |
| Confirm dialog             | `--el-page-bg`, `--el-border`, `--shadow-modal`  | The shipped modal surface                                                                                                                                                                              |

### Panel 9 — copy strings (the `admin` namespace `MOTIR-1167` adds)

- Breadcrumb **"Platform › Users › {name}"**; audit **"You are viewing {name}'s
  account as platform staff. This cross-tenant read is recorded in the audit log
  (operator {op} · {email}, just now)."**
- Actions **"Send password reset"** · **"Suspend account"** · **"Cancel"**.
- Confirm **"Suspend {name}?"** / **"They are signed out of every session
  immediately and cannot sign back in. Their workspaces, projects and work items are
  untouched, and another platform operator can lift the suspension. {org} keeps
  running for its other {n} members."**; field **"Reason"** + **"— required, written
  to the audit log"**; hint **"Shown to any operator reading this account later, and
  to {name} if they ask."**
- Log **"Support actions"** / **"Every operator write on this account, newest first.
  Append-only."**; pill **"This account"**; columns **"When"**, **"Action"**,
  **"Operator"**, **"Reason"**; chips **"Suspended"**, **"Password reset sent"**;
  foot **"Showing {n}–{m} of {total} actions"**.

## ⚠️ A correction to this file's own token block (made by 8.5.10)

The inlined Tier-3 block carried **`--el-danger-text: var(--color-destructive)`** —
the danger red itself. In the shipped design system
(`packages/design-system/theme.css`) that token is
**`var(--color-destructive-foreground)`**, i.e. the **white ink that goes ON the
danger fill**. Any filled destructive control built from this asset therefore
rendered **red text on a red fill — 1.00:1, invisible**, which is exactly how Panel
9's Suspend button first came out.

Corrected here: `--color-destructive-foreground: #ffffff` was added to the Tier-0
block and `--el-danger-text` re-aliased to it. `.state.err .ico` in Panel 7 had been
leaning on the wrong alias to obtain the RED, so it now names `--el-danger`
directly — which is the same value, so **Panels 1–7 render pixel-for-pixel
identically** (verified: a 2400×11220 device-pixel diff of panels 1–7 before and
after returns **0** differing pixels).

**One drift was left UNFIXED on purpose** — `--el-accent` — and is now fixed by
MOTIR-2595; see the next section.

## ⚠️ `--el-accent` aliases the FILL, not the ink (fixed by MOTIR-2595)

The block carried **`--el-accent: var(--color-primary)`** where `theme.css` says
**`var(--color-primary-fill)`**. The two are a deliberate pair — `--color-primary`
is the accent **as ink** on a pale surface, `--color-primary-fill` is the **block of
colour behind a white label** — and `--el-accent` is the fill role (`.btn-primary`
here is `background: var(--el-accent); color: var(--el-accent-text)`). The ink form
has its own token, `--el-accent-on-surface`, which was already correct.

Corrected: `--color-primary-fill` was added to the inlined Tier-0 block in both
themes (`#5645d4` light, `#6c5cdd` dark — the values `theme.css` carries) and
`--el-accent` re-aliased to it. What that changes:

| theme (default palette) | accent fill before  | after                | white label on it                                              |
| ----------------------- | ------------------- | -------------------- | -------------------------------------------------------------- |
| light                   | `#5645d4`           | `#5645d4`            | 6.57:1 — unchanged, **the light PNG export is byte-identical** |
| dark                    | `#7b6ce5` (the ink) | `#6c5cdd` (the fill) | **4.10:1 → 4.99:1**, i.e. below AA → AA                        |

So this was never only an other-palettes hazard: the mock's own dark mode was
painting the accent CTA with the ink colour and failing AA on its label. Under a
palette where the pair diverges further (several define a light `--color-primary`
against a near-black or near-white `--color-primary-fill`) the gap is larger.

## ⚠️ The inlined token block is a POINT-IN-TIME COPY — re-check it, don't trust it

`console.mock.html` inlines a **subset** of the design system's Tier-0 + Tier-3
layers so the asset renders standalone from a `file://` URL. That copy was taken by
hand and does not update when `packages/design-system/theme.css` moves, so **every
value in it is a claim about a past state of the design system.** Three corrections
have already been needed (`--el-danger-text`, above; `--el-accent`, here; and the
Tier-0 set below). The first two were invisible in the default light palette; the
third was not, which is the point — invisibility is not what makes drift worth
finding, and neither is visibility what makes it safe to leave.

Re-run this from the repo root before trusting the block — it parses every `--el-*`
declaration out of both files and diffs them, so it reports drift the eye cannot
see. It prints `DISAGREEMENTS: 0` today:

```bash
python3 - <<'PY'
import re
M='design/platform-admin/console.mock.html'; T='packages/design-system/theme.css'
def body(t,sel):
    for m in re.finditer(sel,t):
        j=t.index('{',m.start()); d,k=1,j+1
        while d: d+={'{':1,'}':-1}.get(t[k],0); k+=1
        yield t[j+1:k-1]
def decls(t,sel,pre='--el-'):
    o={}
    for b in body(t,sel):
        o.update({m[1]:' '.join(m[2].split())
                  for m in re.finditer('('+pre+r'[a-z0-9-]+)\s*:\s*([^;]+);',b)})
    return o
strip=lambda s: re.sub(r'/\*.*?\*/','',s,flags=re.S)  # a comment naming a token would fool the scan
mock=strip(open(M).read()); theme=strip(open(T).read()); bad=0
for label,ms,ts in [('LIGHT',r'(?m)^\s*:root\s*\{',r'(?m)^:root,\s*\n\[data-appearance-scope\]\s*\{'),
                    ('DARK',r"(?m)^\s*\[data-theme='dark'\]\s*\{",r"(?m)^\[data-theme='dark'\]\s*\{")]:
    m=decls(mock,ms); t=decls(theme,ts)
    print(f'== {label} == mock {len(m)} · theme {len(t)}')
    for k in sorted(m):
        if k not in t: print(f'  ONLY-IN-MOCK {k}: {m[k]}'); bad+=1
        elif m[k]!=t[k]: print(f'  DIFFERS {k}: mock={m[k]} theme={t[k]}'); bad+=1
print('DISAGREEMENTS:',bad)
PY
```

`ONLY-IN-MOCK` and `DIFFERS` are both defects — the first means the mock invented a
token or kept one the system dropped, the second is a stale alias. Tokens the mock
simply does not inline are fine (it copies 37 of the system's 200 `--el-*`). To
check the Tier-0 half the same way, change `pre='--el-'` to `pre='--color-'` **and**
the light theme-side selector to `r'(?m)^@theme\s*\{'` — Tier-0 lives in the
`@theme` block, Tier-3 in the `:root, [data-appearance-scope]` one.

**The Tier-0 half prints `DISAGREEMENTS: 0` today too** — MOTIR-2609 corrected the
four drifts it had (`--color-link` `#0075de`→`#0070d2`, `--color-tint-yellow`
`#fbf0c4`→`#fef7d6` light and `#332d12`→`#3a341a` dark, plus a dark
`--color-warning: #f08c3a` override the mock still carried and `theme.css` no longer
has, DELETED rather than re-pinned — an override the system dropped is not a value to
refresh). They were filed apart from MOTIR-2595 because they change rendered hues
across the panels rather than only the swap layer, and the re-export proves it: the
light PNG moved 289,487 pixels (0.745%), all of them the yellow-tint banner in the
view-as-tenant panel plus the external links in the estate and health panels, and
every one of the 1,311 distinct colour transitions traces to those two light values
or to an antialiasing blend of them. Nothing else moved.

The scan now covers the block completely: 33 light + 24 dark `--color-*`
declarations, which is every `--color-*` line in the file, against `theme.css`'s
37 + 28. The mock inlines no `--color-*` the system does not define, so there is no
ONLY-IN-MOCK exception to name here.

Whenever the block is corrected, re-export `console.png` after `prettier --write`:
Playwright chromium, light theme, `deviceScaleFactor: 2`, viewport width 1200,
`fullPage` — which reproduces the committed **2400×24962** export. (It was 2400×16180 until
the MOTIR-4564 amendment added Panels 10–12; `node scripts/render-design-mock.mjs
design/platform-admin/console.mock.html` recovers the viewport from the committed PNG and
reports `EXACT 1200x900@2x`, so the height is the only thing that moved.)

---

# AMENDMENT 2026-09-05 — the ORG level: lookup, page, and the internal-billing classification control

**Story MOTIR-4337 · card MOTIR-4564.** Panels **10 · 10b · 11 · 12** of
`console.mock.html`. This is an **amendment to this asset, not a new area** — it composes the
shell Panels 2–9 already draw and introduces no primitive and no bespoke admin CSS.

## What this amendment is, and the sentence in this file it corrects

The story's own body says the platform-admin console _"has no design area of its own today"_ and
calls that the NONE-exists case. **It is false on `origin/main`** — this area ships
`console.mock.html`, `console.png` and these notes, authored by MOTIR-728. What is genuinely
undrawn is narrower, and this file already said so: _"Story 10.1 draws READ views"_ and _"this
design draws no destructive control."_ Both of those statements survive. The control drawn in
Panel 12 is neither destructive nor 10.1's — it is a reversible per-org classification owned by
Story MOTIR-4337, and it is the only write this amendment adds.

**A reserved nav row is evidence the room is required, not evidence it is designed.** The rail
draws **Tenants** behind a `10.1` pill (`AdminShell.tsx`, `soonTenants`, `href="/admin/tenants"`,
`disabled: true`). Panels 10–12 draw that row **live and unbadged**, because this story builds its
ORG level.

## The ROUTE — `/admin/tenants`, not `/admin/orgs` (decision-authority rung 2)

The story's amendment block observes that `/admin/orgs` does not exist. So does `/admin/tenants` —
but the shipped rail already **points at `/admin/tenants`**, and this asset already reserves that
row for the tenant hierarchy. Inventing a second, sibling route would leave the reserved row
pointing at nothing while an unreserved one carried the surface. So:

| route                                   | owner          | what it is                                                      |
| --------------------------------------- | -------------- | --------------------------------------------------------------- |
| `/admin/tenants`                        | **MOTIR-4566** | the ORG lookup (Panel 10)                                       |
| `/admin/tenants/[orgId]`                | **MOTIR-4566** | the org page SHELL (Panel 11) + MOTIR-4568's control (Panel 12) |
| the workspace + project levels below it | **MOTIR-733**  | not drawn here at all                                           |

This is rung 2 — shipped reality — outranking the card's prose, the same call
`platform-staff-auth.md` recorded when it filed itself under `docs/decisions/` rather than the
path its own card named.

## Panel 10 — the ORG LOOKUP (review EACH panel — mistake #31)

- **The access path, end to end, drawn as a strip above the shell**: account menu → `/admin` →
  the left-nav **Tenants** row (live) → `/admin/tenants`. Panel 1 already draws step 1 in full;
  the strip is what makes the _whole_ path visible on one screen rather than inferred across two.
- **A GET form, not a type-ahead.** The shipped user lookup
  (`app/(admin)/admin/users/page.tsx`) settles this and the reasoning transfers unchanged: every
  search is an **audited cross-tenant read**, so a keystroke-per-request lookup would write an
  audit row per keystroke and bury the reads that mattered; and the query in the URL makes a
  result set linkable, reloadable and findable in history an hour later.
- **The ⌘K box in the top bar stays inert**, exactly as it does beside the user lookup. Panel 3's
  estate search groups four entity kinds and three of them still read tables with no
  `platform_staff` policy arm — this story ships the arms for `organization` **and only**
  `organization` (MOTIR-4565, carved from MOTIR-730). A palette that answered one group and
  silently returned nothing for the rest would be a search that lies about the estate.
- **The result row carries TWO classification chips**, `isMeta` and `internalBilling`, separately
  labelled. A single "Internal" chip would draw the conflation
  `docs/decisions/internal-billing-classification.md` §1 refuses; the two flags are true together
  on `moooon` today and that coincidence is not identity.

## Panel 10b — the lookup's three states

**Idle · query too short · no results.** There is deliberately no "forbidden" arm: a non-staff
user never reaches this route (Panel 7a's 404 is the whole answer, and it is the console's
standing rule). The idle state shows nothing until asked rather than listing the estate, because
the lookup answers a question and every answer is an audited read.

## Panel 11 — the ORG PAGE, and the ALLOCATION that keeps it honest

- **Header:** identity (name, slug), **plan tier**, **credit balance**, and the two chips. The
  balance reads `0` for a classified org and the panel says why in a `note`: the debits are real
  and each is paired with an `internal_offset` credit in the same transaction, so the balance nets
  to zero **while both entries stay visible** (ADR §2–§3). A reader who sees `0` and thinks
  _suppressed_ is the exact misreading this story exists to end.
- **One action:** _Classify as internal billing_ / _Remove internal classification_. Everything
  else on the page is read-only.
- **MOTIR-733's panels are drawn as RESERVED REGIONS** — a `card.reserved` with the owning card's
  key as a neutral `Pill` and one line saying what it will hold. Not content, not a skeleton (a
  skeleton claims the data is loading), not empty states (an empty state claims there is nothing
  to show).
- **The ALLOCATION TABLE is on the asset**, not in a card body, because it is the artifact three
  cards in two epics have to read the same way. It names, per element, whether MOTIR-4566,
  MOTIR-4568, MOTIR-4565, MOTIR-733 or MOTIR-745 builds it.

## Panel 12 — the CLASSIFICATION CONTROL, six states

The shipped `SupportActionsBar` pattern one entity over (`app/(admin)/admin/users/[userId]/`):
`Button` → `Modal` → `FormField` reason → confirm, with the audit row rendered back underneath.

| state                       | what it draws                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| **a** not classified        | no chip at all (absence is absence, not a badge) + the set button                              |
| **b** classified            | both chips + the unset button — the same control inverted                                      |
| **c** confirm, reason typed | the dialog, the required-reason field, the primary ENABLED                                     |
| **d** reason missing        | the same dialog with the primary **`disabled`** — a gate, never a post-submit error            |
| **e** already in that state | a warning toast: _no change made_, nothing written, **no audit row created**                   |
| **f** generic failure       | an error toast: the write and its audit row share one transaction, so a failure leaves neither |

- **The reason is mandatory and it is enforced twice** — `disabled` on the client, and the audit
  vocabulary's own reason policy inside the transaction. The client gate is convenience; the
  server gate is the rule.
- **The record is on the same surface as the action**, per this file's standing line that an
  operator can never perform an action and wonder whether it was recorded.
- **One `PlatformAuditLog` row, and no second audit log.** It is the shipped table from
  MOTIR-2896 and it joins `platform-staff-auth.md` §7's allocation as a `superadmin`-level,
  reason-required, audited write. When MOTIR-751's hash chain lands it extends this same table.

## Primitives composed (no hand-rolling)

`Sidebar` (the rail, with Tenants live), the `.adminbar` operator top bar, the `.scope` breadcrumb
grammar, `Card` (+ `card-head` / `card-body flush` / `card-foot`), the at-scale `table` + `pager`,
`Pill` (neutral / tier / platform / the new `internal` tone), `Button` (primary · secondary ·
disabled), `Modal` (the `.confirm` dialog) with `FormField` + its required-reason hint,
`EmptyState` (`.state`, three of them), and the `.note` / `.toast` annotation family. **No new
primitive is introduced.**

## Colour roles added by this amendment (`--el-*` only)

| Element                                       | Token                                                         | Why                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **`internalBilling` chip** (`.pill-internal`) | `--el-tint-sky` + `--el-text-strong`                          | The INFO family — a marker the platform set, the same family as the operator bar. Distinct from `isMeta`. |
| **`isMeta` chip** (`.pill-platform`)          | `--el-tint-lavender` + `--el-text-strong` (existing)          | The platform/tenancy family this asset already uses; keeps the two flags visually apart.                  |
| **Reserved region** (`.card.reserved`)        | `--el-surface-soft` + `--el-text-secondary` note              | Quieter than a live card, still a card. **No dashed border** — border style never carries state.          |
| **State-key badge** (`.ctrl-key`)             | `--el-tint-lavender` + `--el-text-strong`                     | A board-chrome index letter, the tint-plus-strong-ink rule (finding #35).                                 |
| **Already-in-state toast** (`.toast-warn`)    | `--el-tint-yellow` + `--el-text-strong`, glyph `--el-warning` | A refusal, not a failure — the cautionary hue, never danger.                                              |
| **Failure toast** (`.toast-err`)              | `--el-tint-rose` + `--el-text-strong`, glyph `--el-danger`    | Hue in the tint BACKGROUND with strong ink on top; the glyph carries the danger hue.                      |

Every caption in the new panels is `--el-text-secondary`, never `--el-text-muted` — muted clears
AA on the white page only, and these captions sit on `--el-surface`, `--el-surface-soft` and the
tints. `--el-danger-text` appears nowhere: it is the ink FOR a danger fill and there is no danger
fill in these panels.

## Copy strings (en — the `platformAdmin` namespace these panels add)

| Key                                        | String                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orgs.breadcrumb`                          | Platform · Tenants                                                                                                                                                                                                                                                                                                       |
| `orgs.title`                               | Organizations                                                                                                                                                                                                                                                                                                            |
| `orgs.subtitle`                            | Find an organization by name or slug. Opening one is an audited cross-tenant read.                                                                                                                                                                                                                                       |
| `orgs.searchLabel` / `orgs.searchSubmit`   | Name or slug / Search                                                                                                                                                                                                                                                                                                    |
| `orgs.idleTitle` / `orgs.idleDescription`  | Search for an organization / Type a name or slug above. Results are limited to 20; every match you open is recorded in the audit log.                                                                                                                                                                                    |
| `orgs.tooShort`                            | Enter at least {n} characters.                                                                                                                                                                                                                                                                                           |
| `orgs.noneTitle` / `orgs.noneDescription`  | No organizations match "{query}" / Check the spelling, or search by slug.                                                                                                                                                                                                                                                |
| `orgs.chip.isMeta` / `orgs.chip.internal`  | isMeta / internalBilling                                                                                                                                                                                                                                                                                                 |
| `orgs.action.classify`                     | Classify as internal billing                                                                                                                                                                                                                                                                                             |
| `orgs.action.unclassify`                   | Remove internal classification                                                                                                                                                                                                                                                                                           |
| `orgs.confirm.classify.title`              | Classify {name} as internal billing?                                                                                                                                                                                                                                                                                     |
| `orgs.confirm.classify.body`               | Every AI debit this org incurs will be paired, in the same transaction, with an offsetting credit — so it is charged exactly like a customer and its balance nets to zero. Both entries stay visible in the ledger. This changes no rate, lifts no cap and touches no Stripe object, and another operator can remove it. |
| `orgs.confirm.reasonLabel` / `…reasonHint` | Reason — required, written to the audit log / Shown to any operator reading this organization later. "Internal" on its own answers nothing.                                                                                                                                                                              |
| `orgs.action.error.alreadyInState`         | {name} is already classified as internal billing.                                                                                                                                                                                                                                                                        |
| `orgs.action.failedTitle`                  | Couldn't update the classification                                                                                                                                                                                                                                                                                       |
| `orgs.audit.title` / `orgs.audit.subtitle` | Platform actions on this organization / Every operator write on this org, newest first. Append-only.                                                                                                                                                                                                                     |

## The `meta` sweep of the customer areas (card criterion 7)

`grep -rin 'meta' design/billing/ design/ai-usage/` returns 37 hits. They fall into three groups,
and every one is disposed of:

1. **The `.meta` CSS class and its markup** (`.line .meta`, `<div class="meta">`) — 20 hits across
   `billing.mock.html`, `ci-line.mock.html`, `search-line.mock.html`. **UNRELATED**: it is a
   billed line's own metadata row, nothing to do with the META org.
2. **`Motir-state` / `metadata` prose** — 2 hits (`design/billing/design-notes.md:547`,
   `design/ai-usage/design-notes.md:329`). **UNRELATED**: the word inside "metadata".
3. **The META-org VARIANT** — the rest. **CORRECTED** in `design/billing/design-notes.md` and
   `design/ai-usage/design-notes.md` by an amendment section in each, which records that after
   MOTIR-4572 an internal org renders the ordinary customer panels and the CI line RENDERS in
   whatever state `ciAllowanceService` returns. The drawn META panels in `ci-line.mock.html`,
   `search-line.mock.html` and `search-spend.mock.html` are **annotated as superseded** in place
   rather than redrawn: they remain a true record of shipped behaviour until MOTIR-4572 merges,
   and redrawing customer pixels is out of this card's scope.

# AMENDMENT 2026-09-12 — INDEX & FLEET COST: Monitoring's allowance section, the org page's cost card, and their nothing-states

**Story MOTIR-4335 · card MOTIR-4594 (built by MOTIR-4595).** Panels **13 · 14 · 14b** of
`console.mock.html`, plus two rows in Panel 11's allocation table. An **amendment to this asset,
not a new area** — it composes the shell Panels 2–12 already draw and introduces no primitive.

> ⚠️ **Motir does NOT charge for code indexing.** Everything drawn here is **internal COGS** and
> an **internal index allowance**. No label, tooltip, route name or copy string describes index
> cost as charged, billed or priced — and no element here is reachable by a customer. This is a
> constraint on the design, not a style note: the phrasing written down becomes the answer the
> first time anyone greps for it (`docs/decisions/code-graph-index-fleet.md`, MOTIR-4541
> § _How this is described_).

## Where it lands — and why NOT on Usage & cost (decided by Yue, 2026-09-12)

The card told this design to extend the **Usage & cost** page (Panels 4–5). That page is **not
shipped**: it is Story MOTIR-727's, its rollup card MOTIR-732 is `blocked` (on MOTIR-589 and
MOTIR-730), and the live rail (`app/(admin)/_components/AdminShell.tsx`) shows its row behind a
`10.1` pill. Drawing the index views there would have made MOTIR-4595 — and so Story MOTIR-4335 —
wait on unbuilt work outside the story. So both views land on **shipped** surfaces:

| view                                                                                     | surface                                                 | panel                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------- |
| **Index allowance** — per-tier crossing rate, cost basis, the three hard-stop lists      | `/admin/monitoring` (shipped, live rail row)            | **13**                    |
| **Index & fleet cost** card — both pools, indexing state, fleet COGS by workload, tokens | `/admin/tenants/[orgId]` (shipped, Panel 11's page)     | **14**                    |
| estate workload COGS lines + the platform-wide meta/tenant split                         | `pnpm ops:fleet-cost` now; a Usage & cost segment later | follow-up under MOTIR-727 |

**Monitoring is the right home, not a compromise.** Its standing question is _"is the machinery
running?"_ (Panel 8). Which orgs have had indexing stopped, for how long and how far behind their
graph is, is exactly that question for the index fleet — and the crossing rate is its calibration
twin: _is the gate sized right?_

## Panel 13 — Monitoring · Index allowance

- **Placement:** a new `Card` below the shipped _Scheduled jobs · overdue_ card, which is drawn
  collapsed only to show position.
- **The headline is the CROSSING RATE, per tier** — three `mini-stat`s (tiers over threshold · the
  threshold · Free orgs at their limit) above a `.tbl` with one row per tier: orgs, crossed, the
  rate as a `.usebar` + figure, a **Reading** `Pill`, and the internal cost basis.
- **The operator's one-glance reading** is the card's own subtitle: _if a large share of a tier
  crossed, the gate is wrong — not the orgs._ The Reading pill states it per row
  (`Gate holds` / `Recalculate — over 25%`), so nobody has to compare a bar to a threshold by eye.
- **The Free row has no crossing rate.** Its one-time allowance is a **hard stop**, so it has no soft
  gate to cross; the rate cell reads `n/a — no soft gate · 11.1% at limit` and the Reading pill says
  `No soft gate — hard stop`. Drawing a crossing-rate bar there would contradict the tier's own shape.
- **Enterprise** reads `Allowance not configured` — set on the plan by staff.
- **Internal cost basis** is `advertised credits + index allowance`, drawn as a sum with its cadence,
  so it can never be read as the advertised figure (which stays `catalog.ts`'s `allotment.credits`).
- **ONE list of stopped orgs, the reason as a FILTER and a COLUMN** _(revised 2026-09-12, Yue: "Stopped · no credit and Stopped · Free allowance used are designed as 2 cards, I don't see how I can see a large list of orgs there")._ The first revision drew one card per reason, and it contradicted its own table: the Free row counts **212** exhausted orgs, and a card of rows cannot hold them. The stopped set is one collection, so it gets one layout:
  - **Head:** `Stopped orgs` + a `pill-down` total (`219 stopped`).
  - **Toolbar:** a `Segmented` reason filter, each option carrying its count — `All 219` · `No credit 7` · `Free allowance used 212` · `Margin ceiling · not active`. The last is **drawn disabled, never omitted**: hard gate B waits on MOTIR-4483 / MOTIR-4598 (MOTIR-5280), and a missing option would read as "no such stop". An org search sits beside it.
  - **Table:** `Org` · `Tier` · `Reason` (`pill-down`) · `Stopped for` (sorted, longest first) · `Graph behind` · `Resumes` (`on top-up or renewal` / `on upgrade`). The two reasons stay distinguishable per row, which is the point the separate cards were trying to make.
  - **Foot:** `Showing 1–25 of 219 · longest-stopped first` + the shipped `pager`, exactly Panel 4's at-scale grammar.
  - The per-tier counts above (the Free row's `212 exhausted`, the no-credit total) are the list's filter counts. MOTIR-4595 links a count to the filtered list, so a count and its list can never disagree.
- **The "nothing" states** (Panel 14b) gain two: `No org is stopped` (said in words, filter counts at 0) and `Margin ceiling · not active` (the disabled filter's meaning, moved from the retired reserved card).
- **Every figure is illustrative.** The index:token ratio and the recalculate threshold are
  MOTIR-4588's to measure and propose, and the card foot says so.

## Panel 14 — Org page · Index & fleet cost

- **Placement:** a new `Card` on the shipped org page, **above** MOTIR-733's reserved _Usage & cost
  rollup_ region, which is redrawn unchanged beneath it to show that no cell was taken.
- **BOTH POOLS, side by side and never conflated** — two `mini-stat`s, each with remaining (headline),
  a `seatmeter`, `granted · consumed`, and a percentage:
  - **Credit balance** — `Customer sees this` (`pill-active`). Drawn by the planner and the hosted
    agent; carries the period's token spend.
  - **Index allowance** — `Internal only` (`pill-neutral`). Drawn by indexing only; the note states
    that it never touches the credit balance, under any condition.
- **The org is drawn in state (b)** — `112%` of its allowance and still indexing — because it is the
  state most likely to be misread as a fault. A `.note` says so: _the normal, absorbed case — not a
  fault._ It also shows all four state pills as a key.
- **Fleet COGS by workload** — a `.tbl` of `ci` / `index` / `agent` with containers, billable seconds
  and internal COGS. The **index line counts failed containers** (`· 4 failed, counted`), and the
  **agent line is ABSENT**, drawn as a sentence rather than as `0` / `$0.00`.
- **Margin ceiling** appears only as `Not active · MOTIR-5280` beside the state.
- **The platform-wide meta/tenant split is not on this card**; the org's own meta status is the
  header's `isMeta` chip (Panel 11). The foot points to the readout and the later Usage & cost segment.

## Panel 14b — the nothing-states

Five `EmptyState`s (`.state`), each naming what it is, because an omission a reader has to notice is
read as a zero:

| state                                    | what it says                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| **No index activity this period**        | the index line is _absent_ — not a measured zero                                          |
| **Meter disabled**                       | a self-hosted build has no fleet, so no figures — no zero is drawn                        |
| **Never ran an AI job — indexed anyway** | billing and the one-time allowance were provisioned on the first index draw; a normal row |
| **Allowance not configured**             | Enterprise: set on the plan by staff; until then no gate to cross                         |
| **Couldn't read the pools**              | motir-ai did not answer; both pools read _unknown_ — never zero                           |

**There is deliberately no "no AI plan" state.** On cloud every connected repository is indexed
(MOTIR-4541, decision A, 2026-09-12), so that population no longer exists.

## The three indexing states — drawn to be told apart, and (b) must not read as an error

| state                                           | pill                        | token                                                                                       |
| ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| **a** under allowance                           | `a · Under allowance`       | `--el-tint-mint` + `--el-text-strong`                                                       |
| **b** over allowance, still indexing            | `b · Over — still indexing` | `--el-tint-sky` + `--el-text-strong` — the INFO family, deliberately **not** yellow or rose |
| **c** stopped (no credit · Free allowance used) | `c · Stopped · …`           | `--el-tint-rose` + `--el-text-strong`                                                       |
| gate B not active                               | `Not active · MOTIR-5280`   | `--el-surface` + `--el-text-secondary` (`pill-neutral`)                                     |
| a tier whose gate looks mis-sized               | `Recalculate — over 25%`    | `--el-tint-yellow` + `--el-text-strong` — cautionary, never danger                          |

## Primitives composed (no hand-rolling)

The shipped rail (`Sidebar`, Monitoring / Tenants active), the `.adminbar`, the `.scope` breadcrumb,
`Card` (+ `card-head` / `card-body` / `card-body flush` / `card-foot`), `card.reserved`, the `.tbl`
table, `Pill` (`pill-active` / `pill-internal` / `pill-down` / `pill-warn` / `pill-neutral` /
`pill-plan`), `mini-stat` / `stat-grid`, `.usebar` and `.seatmeter`, `.note`, and `EmptyState`
(`.state` / `.states-grid`). **No new primitive and no new CSS class.** The only inline styles are
layout and the `--el-text-secondary` ink.

## Ink

Secondary copy on a card body, a `card-foot`, a `mini-stat` or a `card.reserved` uses
`--el-text-secondary` — never `--el-text-muted` (fails AA off the white page) and never
`--el-text-faint`. The pool bars draw the consumed share in `--el-accent` (credit balance) and
`--el-info` (index allowance), matching the tenancy/model bar hues already in this asset.

## Allocation — two rows added to Panel 11's table

| element                                                             | built by       | note                                            |
| ------------------------------------------------------------------- | -------------- | ----------------------------------------------- |
| **Index & fleet cost card** — pools, state, fleet COGS, token spend | **MOTIR-4595** | Panel 14; a new card, takes none of 733's cells |
| **Margin ceiling** — each org's distance, and its hard-stop list    | **MOTIR-5280** | drawn not-yet-active until hard gate B lands    |

Panel 13 is on Monitoring, not on this page, and is also MOTIR-4595's. MOTIR-733 keeps the
by-workspace and by-model usage rollup; MOTIR-732 keeps the Usage & cost page.

## Copy strings (en — the `admin` namespace MOTIR-4595 adds)

| key                                              | string                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `monitoring.indexAllowance.title`                | Index allowance · is the gate sized right?                                                                         |
| `monitoring.indexAllowance.subtitle`             | This period, per tier. If a large share of a tier crossed, the gate is wrong — not the orgs.                       |
| `monitoring.indexAllowance.internal`             | Internal · never shown to customers                                                                                |
| `monitoring.indexAllowance.reading.holds`        | Gate holds                                                                                                         |
| `monitoring.indexAllowance.reading.recalc`       | Recalculate — over {threshold}%                                                                                    |
| `monitoring.indexAllowance.reading.free`         | No soft gate — hard stop                                                                                           |
| `monitoring.indexAllowance.reading.unconfigured` | Allowance not configured                                                                                           |
| `monitoring.indexAllowance.foot`                 | Crossing the allowance does not stop indexing on a paid tier — Motir absorbs the overrun and records the crossing. |
| `monitoring.stopped.title`                       | Stopped orgs                                                                                                       |
| `monitoring.stopped.subtitle`                    | Indexing paused by a hard stop. Every one resumes on its own — nobody re-arms it.                                  |
| `monitoring.stopped.total`                       | {count} stopped                                                                                                    |
| `monitoring.stopped.filter.all`                  | All                                                                                                                |
| `monitoring.stopped.filter.noCredit`             | No credit                                                                                                          |
| `monitoring.stopped.filter.freeUsed`             | Free allowance used                                                                                                |
| `monitoring.stopped.filter.margin`               | Margin ceiling                                                                                                     |
| `monitoring.stopped.filter.marginInactive`       | not active                                                                                                         |
| `monitoring.stopped.filter.marginInactiveHint`   | Hard gate B is not active yet. An empty result would mean the gate is off, not that no org is near the ceiling.    |
| `monitoring.stopped.search`                      | Find an org…                                                                                                       |
| `monitoring.stopped.col.stoppedFor`              | Stopped for                                                                                                        |
| `monitoring.stopped.col.graphBehind`             | Graph behind                                                                                                       |
| `monitoring.stopped.col.resumes`                 | Resumes                                                                                                            |
| `monitoring.stopped.resumes.topUp`               | on top-up or renewal                                                                                               |
| `monitoring.stopped.resumes.upgrade`             | on upgrade                                                                                                         |
| `monitoring.stopped.foot`                        | Showing {from}–{to} of {total} · longest-stopped first · the catch-up refreshes only repos that moved              |
| `monitoring.stopped.empty`                       | No org is stopped.                                                                                                 |
| `orgs.indexCost.title`                           | Index & fleet cost · this period                                                                                   |
| `orgs.indexCost.creditBalance`                   | Credit balance                                                                                                     |
| `orgs.indexCost.customerSees`                    | Customer sees this                                                                                                 |
| `orgs.indexCost.indexAllowance`                  | Index allowance                                                                                                    |
| `orgs.indexCost.internalOnly`                    | Internal only                                                                                                      |
| `orgs.indexCost.state.b`                         | Over allowance — still indexing                                                                                    |
| `orgs.indexCost.absorbedNote`                    | This is the normal, absorbed case — not a fault.                                                                   |
| `orgs.indexCost.agentAbsent`                     | absent — no agent container ran this period (not a zero)                                                           |
| `orgs.indexCost.foot`                            | The index line counts containers that FAILED. Internal COGS — nothing on this card is charged to the customer.     |

## What this amendment does NOT draw

- **The Usage & cost segment** (estate workload lines + the platform-wide meta/tenant split) — a
  follow-up design under MOTIR-727, beside the page it belongs on.
- **Any customer-facing surface.** `design/billing/ci-line.mock.html` is the customer's CI line and is
  referenced only as the thing this must never resemble or feed.
- **Hard gate B's live list or figures** — MOTIR-5280.

---

# AMENDMENT 2026-10 — AI planning (MOTIR-7222 · story MOTIR-7220)

**Design system check (first, per the design-system rule).** Read `package.json` (depends on
`@motir/design-system` `workspace:*`) and `app/globals.css` (`@import '@motir/design-system/theme.css'`).
**Verdict: the project is on Motir Design** (package `0.8.0`, `packages/design-system/package.json`),
so the page is drawn from that system's `--el-*` / shape tokens and the shipped primitives. The root
layout applies the signed-in person's own `data-style` / `data-palette` / `data-type`, so there are
no fixed project axes; the mock draws the base values, and every element routes through a token so
any applied axis re-skins it. **Nothing the package lacks is needed** — no proposed addition, no
product-local component.

**Mock (a DELTA):** [`console--ai-planning.mock.html`](console--ai-planning.mock.html), ten panels.
**Amends:** `console.mock.html` Panel 2 / Panel 13 (the shell — one rail row is added), Panel 7a
(the 404, referenced and not redrawn) and Panels 11–12 (the confirm-with-reason grammar, reused for
a second write). The older mock is a record and is not edited.
**Gates:** **MOTIR-7231** (the page, `/admin/ai-planning`, its nav row, every state below, en + zh).
It builds on **MOTIR-7227** (the console seam: `motirAiClient` get/put,
`platformPlannerModelService`, the `ai.planner_model.set` audit action) and on motir-ai's
`GET` / `PUT /v1/planner-model-settings` (MOTIR-7221) and reachability probe (MOTIR-7236).

**Composed, not redrawn.** The mock's token block, primitive CSS and lucide sprite are spliced
verbatim from `console.mock.html`; the shell is the shipped `AdminShell.tsx`; the confirm is the
shipped `ClassificationBar` (`Modal role="alertdialog"` + `Input` + a primary disabled until a reason
is typed); the picker is the shipped `Combobox` with `group` options. The additions block at the end
of the mock's `<style>` holds only that Combobox's markup, the table's cell styles and five Tier-3
tokens the point-in-time block predates (`--el-text-identifier`, `--el-text-eyebrow`,
`--el-option-active-bg`, `--el-icon-muted`, `--el-danger-on-surface`), each spelled exactly as
`theme.css` defines it.

## What this page is

The place where Motir platform staff see — and a **superadmin** changes — **which model plans** for
each of three audiences. Motir, not the tenant, chooses the planning model (story MOTIR-7220): the
model is a cost input, so it lives in the operator console beside the other cross-tenant knobs, and
no tenant surface names it. **Staff-facing only.** For a non-staff user `/admin/*` is a 404 (the
area's standing rule, Panel 7a).

| Audience (row)             | Who is in it                                         | Resolved when                 |
| -------------------------- | ---------------------------------------------------- | ----------------------------- |
| **Customer organisations** | Every organisation that is neither meta nor internal | `!isMeta && !internalBilling` |
| **Motir meta org**         | moooon B.V., `isMeta`                                | `isMeta` (wins over internal) |
| **Internal organisations** | Orgs classified `internalBilling`                    | `internalBilling && !isMeta`  |

All three are seeded `claude-opus-5-5`. A change applies from the **next** planning job: a job
resolves its model once, when it starts.

## The access path — a new rail row, drawn (Panels 1 · 2)

**Operations → AI planning**, after **Monitoring** and before the reserved **Governance (10.3)**
row, icon `Sparkles` (lucide), route **`/admin/ai-planning`**, active when
`pathname === '/admin/ai-planning'`. It is a LIVE row (no version badge) and it is **visible to every
staff role** — `support`, `operator` and `superadmin` all read the page; only the controls differ.
Added to `AdminShell.tsx`'s `operations` section as one more `SidebarSection` item, with a new
`navAiPlanning` label beside `navMonitoring`. It sits in Operations, not Platform, because it is a
knob on how the platform RUNS, the same family as Monitoring; the Platform group is the estate's
read views.

## The roles

| Staff role                                 | Sees                                | Can change                                                              |
| ------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------- |
| `support`                                  | the three rows, read-only (Panel 2) | nothing — no picker, no Save, no action column                          |
| `operator`                                 | the three rows, read-only (Panel 2) | nothing — no picker, no Save, no action column                          |
| `superadmin`                               | the three rows, editable (Panel 1)  | any row, to any OFFERED model, with a required reason and one audit row |
| not platform staff (an org owner included) | the app 404 (Panel 10 → Panel 7a)   | —                                                                       |

The read is `requirePlatformStaff('support')`; the write is `superadmin` and is re-gated in
`platformPlannerModelService` (MOTIR-7227) — the missing control is presentation, the service is the
rule. Changing what every customer's planning costs is a spend decision, which is why the write sits
at the top rung (`platform-staff-auth.md` §7 gains the row in MOTIR-7227).

## The panels (review EACH — mistake #31)

1. **Populated, editable (superadmin)** — inside the shell, with the rail row active. One card,
   **Planning model by audience**, holding a three-row table: **Audience** (name + who is in it) ·
   **Model** (a `Combobox` per row) · **Last changed** · an action column with a **Save** per row.
   The Internal row's picker is drawn OPEN: only offered models, **grouped by provider** (the
   Combobox's `group` header), the stored one checked, a one-line footer. **Save is disabled until
   the row's selection differs from its stored model** (Internal has been changed, so its Save is
   the primary; the other two are disabled secondaries). Save is per row because the confirm names
   ONE audience and the audit row records one from → to. **The open listbox floats OVER the card's
   bottom edge** (it is the last row's picker): the shipped `Combobox` panel is a `Popover` that
   portals out of the card, so the card never clips it. _(Revised after review: the first version
   drew it clipped by the card.)_
2. **Populated, read-only (operator · support)** — the same three rows with each model as plain text
   (id in mono + provider as secondary), no picker, no Save, no action column, and one quiet line
   under the card: _Only a superadmin can change these._ Nothing on the panel is interactive.
3. **Loading** — the card with its header, and the three rows as skeletons (name, a trigger-sized
   block, a last-changed line). The page header and the two page lines are static copy and paint at
   once. No model id is guessed while it loads.
4. **Confirm** — Panel 11/12's grammar, unchanged: `Modal role="alertdialog"`, size `md`. It names
   the **audience** in the title and **old → new** in the body, and warns that the change applies to
   the next planning job for every organisation in the audience. The **reason is required**: (a)
   reason typed, primary enabled; (b) reason missing — the primary is DISABLED, not a post-submit
   error. The server re-asserts the reason (`PLATFORM_AUDIT_ACTIONS` reason policy, `required`).
5. **Saved** — the row shows the new model and _Changed just now by you_; its Save is disabled
   again; a success `Toast`. The `ai.planner_model.set` audit row (operator, audience, from, to,
   reason) is written by the same request. **No audit browser is drawn** (Story 10.3, MOTIR-745):
   the change is visible as the row's last-changed line.
6. **Refused** — the PUT came back `validation_error` because the chosen model stopped being offered
   between load and save. The row KEEPS the old value (its trigger reads the stored model again),
   shows an inline error naming the model, and the picker re-reads the offered list. Nothing was
   written and there is no audit row.
7. **Withdrawn model** — a stored model the offered list no longer carries (`offered: false` on the
   setting) gets a **warning chip** under the trigger, _No longer offered_, with the fallback line
   beside it. The trigger still shows the stored id because that is what is stored; the picker's
   list does not contain it. Drawn for both faces (superadmin, read-only).
8. **Unreachable** — LEFT: a save whose one-token test call through the planner's own gateway token
   failed (`model_unreachable`, MOTIR-7236). The row keeps the old value and says why inline; the
   three reasons are drawn one per row. RIGHT: a **stored** model whose last boot test failed gets a
   **red chip**, _Planning is failing_, with the reason line and the time of that test.
9. **Unavailable** — motir-ai could not be reached: the console's error card (Panel 7's) with
   **Retry**, and **no rows**, so staff never see a guessed value.
10. **Not staff** — the app 404, drawn BY REFERENCE (Panel 7a). Not redrawn.

## Copy (en — the `platformAdmin` namespace MOTIR-7231 adds, with a `zh` twin each)

Model ids in the mock (`claude-opus-5-5`, `claude-sonnet-5-5`, `glm-5.2`, `claude-sonnet-4-6`) are
**examples only**: the offered list is read at runtime and **no model id is ever a string in the
catalogue**. Interpolated values are in `{braces}`.

| key                                        | string                                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.navAiPlanning`                      | AI planning                                                                                                                                                     |
| `aiPlanning.breadcrumb`                    | Platform · AI planning                                                                                                                                          |
| `aiPlanning.title`                         | AI planning                                                                                                                                                     |
| `aiPlanning.subtitle`                      | Which model Motir plans with, for each of three audiences. A change applies from the next planning job for every organisation in that audience.                 |
| `aiPlanning.precedence`                    | An organisation that is both meta and internal follows the meta row.                                                                                            |
| `aiPlanning.tenantSecretLead`              | Tenants never see this choice.                                                                                                                                  |
| `aiPlanning.tenantSecretBody`              | No tenant page, usage view or plan names the model that planned.                                                                                                |
| `aiPlanning.card.title`                    | Planning model by audience                                                                                                                                      |
| `aiPlanning.card.subtitle`                 | Every planning job resolves its model from the organisation it runs for: meta, then internal, then customer.                                                    |
| `aiPlanning.card.count`                    | 3 audiences                                                                                                                                                     |
| `aiPlanning.col.audience`                  | Audience                                                                                                                                                        |
| `aiPlanning.col.model`                     | Model                                                                                                                                                           |
| `aiPlanning.col.lastChanged`               | Last changed                                                                                                                                                    |
| `aiPlanning.audience.customer.name`        | Customer organisations                                                                                                                                          |
| `aiPlanning.audience.customer.desc`        | Every organisation that is neither meta nor internal                                                                                                            |
| `aiPlanning.audience.meta.name`            | Motir meta org                                                                                                                                                  |
| `aiPlanning.audience.meta.desc`            | moooon B.V., `isMeta`                                                                                                                                           |
| `aiPlanning.audience.internal.name`        | Internal organisations                                                                                                                                          |
| `aiPlanning.audience.internal.desc`        | Orgs classified `internalBilling`                                                                                                                               |
| `aiPlanning.pickerLabel`                   | Planning model                                                                                                                                                  |
| `aiPlanning.pickerFoot`                    | Only models motir-ai offers for planning. Every provider the gateway serves is listed.                                                                          |
| `aiPlanning.save`                          | Save                                                                                                                                                            |
| `aiPlanning.readOnly`                      | Only a superadmin can change these.                                                                                                                             |
| `aiPlanning.changed.seeded`                | Seeded default · never changed                                                                                                                                  |
| `aiPlanning.changed.by`                    | Changed {when} by {who}                                                                                                                                         |
| `aiPlanning.changed.justNowByYou`          | Changed just now by you                                                                                                                                         |
| `aiPlanning.confirm.title`                 | Change the planning model for {audience}?                                                                                                                       |
| `aiPlanning.confirm.body`                  | {from} → {to}. The change applies to the next planning job for every organisation in this audience. Jobs already running finish on the model they started with. |
| `aiPlanning.confirm.reasonLabel`           | Reason — required, written to the audit log                                                                                                                     |
| `aiPlanning.confirm.reasonPlaceholder`     | Why are you changing the model?                                                                                                                                 |
| `aiPlanning.confirm.reasonHint`            | Shown to any operator reading this change later. “Testing” on its own answers nothing.                                                                          |
| `aiPlanning.confirm.cancel`                | Cancel                                                                                                                                                          |
| `aiPlanning.confirm.confirm`               | Change model                                                                                                                                                    |
| `aiPlanning.saved.title`                   | Planning model changed                                                                                                                                          |
| `aiPlanning.saved.body`                    | {audience} now plan on {model} from their next job.                                                                                                             |
| `aiPlanning.refused`                       | {model} is no longer offered for planning, so it was not saved. The list has been refreshed — choose another model.                                             |
| `aiPlanning.withdrawn.chip`                | No longer offered                                                                                                                                               |
| `aiPlanning.withdrawn.body`                | Planning for this audience falls back to Claude Opus 5.5 until you choose another.                                                                              |
| `aiPlanning.withdrawn.bodyReadOnly`        | Planning for this audience falls back to Claude Opus 5.5 until a superadmin chooses another.                                                                    |
| `aiPlanning.unreachable.save`              | Not saved: the planner could not reach {model} — {reason}.                                                                                                      |
| `aiPlanning.unreachable.reason.keyRefused` | the provider key was refused                                                                                                                                    |
| `aiPlanning.unreachable.reason.noChannel`  | no enabled channel serves this model for the planner                                                                                                            |
| `aiPlanning.unreachable.reason.timeout`    | timed out                                                                                                                                                       |
| `aiPlanning.failing.chip`                  | Planning is failing                                                                                                                                             |
| `aiPlanning.failing.body`                  | Planning for this audience is failing: the planner cannot reach this model. Last tested {when}.                                                                 |
| `aiPlanning.unavailable.title`             | Couldn’t load the planning models                                                                                                                               |
| `aiPlanning.unavailable.body`              | The planning service (motir-ai) didn’t respond, so no setting is shown. This is a fetch error — nothing has changed, and no value is guessed.                   |
| `aiPlanning.unavailable.retry`             | Retry                                                                                                                                                           |

**Copy rule kept:** no customer-facing wording and no pricing anywhere on the page. The card's own
spelling (_organisation_) is kept verbatim, as the story writes it.

**⚠️ Two places the card's copy and the shipped contract do not line up, recorded rather than
papered over.**

- **There is no human model label.** The card asks for "human label + id as secondary text", but
  motir-ai's offered list is `[{ id, provider }]` (MOTIR-7221's contract) — there is no label to
  show. The page therefore uses the shipped `HostedModelPicker` grammar one console over: **the id
  leads (mono) and the provider is the secondary text**, and the Combobox groups by provider. A
  label invented in motir-core would be a second model list to keep current.
- **The withdrawn chip names "Claude Opus 5.5" in words**, verbatim from the card. That is the
  resolver's `PLANNER_MODEL_FALLBACK` (`claude-opus-5-5`). If the fallback ever changes, the string
  must change with it — MOTIR-7231 should interpolate the fallback id from the settings read rather
  than hard-code the words, and the zh twin follows.

## Data — what each element reads

| element                  | source                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| the three rows, in order | `settings[]` of `GET /v1/planner-model-settings` (always three, `customer · meta · internal`)                                             |
| a row's model            | `settings[i].model`                                                                                                                       |
| the withdrawn chip       | `settings[i].offered === false`                                                                                                           |
| last changed             | `settings[i].updatedAt` + `updatedByCoreUserId` resolved to the operator's email in motir-core; `null` → _Seeded default · never changed_ |
| the picker's options     | `offered[]` (`{ id, provider }`), grouped by `provider`, ordered by `id` within a group                                                   |
| refused                  | the PUT's `validation_error`                                                                                                              |
| unreachable (save)       | the PUT's `model_unreachable` and its reason (MOTIR-7236)                                                                                 |
| failing chip             | the setting's recorded boot-test result and time (MOTIR-7236)                                                                             |
| unavailable              | any failure of the GET — never rendered as rows                                                                                           |

## Colour and shape roles (`--el-*` only)

| element                                           | token                                                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| card, table, rows                                 | the console's `Card` + `.tbl` roles, unchanged                                                                                                              |
| card glyph tile                                   | `--el-tint-lavender` + `--el-text-strong` (the `ent-org` tile, reused)                                                                                      |
| audience name · description                       | `--el-text` · `--el-text-secondary`                                                                                                                         |
| model id · provider                               | `--el-text` (mono) · `--el-text-identifier`                                                                                                                 |
| last changed                                      | `--el-text-secondary`, the operator in `--el-text-strong`                                                                                                   |
| Combobox trigger                                  | `--el-page-bg`, `--el-border`, `--radius-input`, `--height-control`; chevron `--el-icon-muted`                                                              |
| listbox panel · group header · active row · check | `--el-page-bg` + `--shadow-elevated` + `--radius-card` · `--el-text-eyebrow` (on the white panel only) · `--el-option-active-bg` · `--el-accent-on-surface` |
| page lines (precedence, tenant)                   | `--el-text-secondary`; glyph `--el-info`                                                                                                                    |
| refused / unreachable inline error                | **`--el-danger-on-surface`** (never `--el-danger-text`, never raw `--el-danger` as ink)                                                                     |
| withdrawn chip                                    | `Pill` warning: `--el-tint-yellow` + `--el-text-strong`; reason line `--el-text-secondary`                                                                  |
| failing chip                                      | `Pill` danger: `--el-tint-rose` + `--el-text-strong`; reason line `--el-text-secondary`                                                                     |
| success toast                                     | `--el-tint-mint` + `--el-text-strong`, glyph `--el-success`                                                                                                 |
| Save                                              | `Button` sm: primary when dirty, secondary + disabled when not; `--radius-btn`, `--height-btn-sm`                                                           |

## A11y

- The table is a real `<table>` with header cells; each Combobox carries the accessible name
  _Planning model_ plus the row's audience (`aria-label="Planning model — {audience}"`).
- The refused and unreachable lines are `role="alert"` on the row; the toast is `role="status"`.
- The confirm is `role="alertdialog"`, focus lands in the reason field, and the primary carries
  `disabled` (not only a style) until the reason is non-blank.
- The read-only panel renders no disabled controls — plain text, so a screen reader is not offered a
  control it cannot use.

## What this amendment does NOT draw

- **An audit browser.** The change shows as the row's last-changed line; the full browser is Story
  10.3's (MOTIR-745).
- **Per-org overrides** beyond the three audiences — a fourth audience is a new story.
- **The hosted-agent run model** (MOTIR-6989's per-difficulty defaults) — the tenant chooses and pays
  for that one; it is not a secret and is not on this page.
- **The tenant surfaces that stop naming the model** — `design/ai-settings/` (MOTIR-7223) and
  `design/ai-usage/` (MOTIR-7224) carry those deltas.
- **A `.png` export.** The card asks for one; `docs/decisions/design-result.md` AMENDMENT 4 retired
  exports (the mock renders on the card), so none is produced.

---

# AMENDMENT 2026-10-01 — the estate overview, Usage & cost and the drill-down, redrawn and published (MOTIR-7237)

**Mock:** `design/platform-admin/console--estate-usage-drilldown.mock.html` — a DELTA (panels D1–D11). It
amends this file's **Panel 2** (estate overview), **Panels 4–5** (Usage & cost) and **Panels 6 and 11** (the
drill-down and the org page's reserved regions). Those panels were drawn by MOTIR-728, which closed before
design results were published, so they were never approved. This delta is what MOTIR-731, MOTIR-732, MOTIR-733
and MOTIR-5285/5286 build against. The older panels stay as the record of June's drawing — where they disagree
with this section, this section wins.

**The console is for platform monitoring, so it shows as much detail as the data holds.** Every spending
category, for any month and all time, with credits charged, usage in its own unit and **what it cost Motir**
— for the whole estate, for one organization, and inside an organization per workspace and per project, with
both kinds of token spend open to their models.

## Review history

1. **Published `c04ab4b`** — planning/coding split, an org → workspace → project tree on Usage & cost.
2. **Sent back:** _"I can't see per org/workspace/project per month spending. I should be able to see what they
   see, give the tenant bill and usage dashboard to me."_ Republished `97dc056` with tenant-view tabs and a
   By month tree.
3. **Sent back:** _"I don't see per-model usage for the tenant. Machine minutes are missing too, CI, indexing
   (even not charged), agent run all need to show separately and in total. Search is missing too. I should just
   be able to see what every tenant can see, with total number across all tenants."_ Then, in discussion: the
   information should be as detailed as possible; both agent-run and planning tokens drill to models; every
   month and all time, not only the current month; Motir's cost is needed; **no** org tree on the estate page —
   the estate page is each org's spend per category; one org's page carries the full breakdown, per workspace,
   project, month and all time, every axis combined, over every category. This version (D3, D4, D8, D11
   rewritten; the By month tree removed). Republished `9f39007`.
4. **Sent back:** _"Platform -> Tenants -> org ? why like this?"_ — the org page had inherited the shipped
   _Platform › Tenants › {org}_ chips. Agreed with Yue: the Organizations list moves from Usage & cost to the
   **Tenants** page, which shows the tenant list first; clicking an org opens its page; a **back button** returns
   to the list. No breadcrumb (D3, D5, D6, D8, D9, D10, D11). Republished `b3426f2`.
5. **Sent back:** _"Why screen D3 and D4 the period switch is one on the left and one on the right? Why only all
   time has models break down?"_ — D3's header had let the switch wrap under the title on the left, and the model
   tables had been drawn on the All-time panel only. Now one header grammar everywhere and the same sections for
   every period (D3, D4).

## The spending categories

Every surface uses the same eight rows, in this order. "Org-level" means the source records no workspace or
project, so the category appears at the org and estate and, below the org, as an explicit "not split by
project" row — never spread over projects.

| Category          | Usage unit                                    | Credits source (motir-ai ledger) | Motir cost                         | Lowest level              |
| ----------------- | --------------------------------------------- | -------------------------------- | ---------------------------------- | ------------------------- |
| Planning tokens   | tokens in / out / cache read / cache write    | `debit` (per planning turn)      | upstream price × tokens, per model | project                   |
| Agent-run tokens  | tokens in / out / cache read / cache write    | the run's model-call debits      | upstream price × tokens, per model | project (once attributed) |
| Agent-run machine | minutes (fleet meter, workload `agent`)       | `agent_machine` on a run         | fleet meter `costUsd`              | project (once attributed) |
| Agent instances   | minutes (fleet meter, `agent_instance`)       | `agent_machine` on an interval   | fleet meter `costUsd`              | org                       |
| Agent storage     | GB-days                                       | `agent_storage`                  | storage cost per GB-day            | org                       |
| CI                | minutes (fleet meter, `ci`), allowance + over | `ci_overage`                     | fleet meter `costUsd`              | project                   |
| Web search        | searches                                      | `search`                         | provider price per search          | org                       |
| Indexing          | minutes (fleet meter, `index`)                | **not charged**                  | fleet meter `costUsd`              | project                   |

**Totals, everywhere:** _Charged total_ (the seven charged categories' credits, and their Motir cost);
_Total incl. indexing_ (Motir's whole cost for the scope); _machine minutes_ (agent-run + instances + CI +
indexing).

Agent runs charged before they carried a project (MOTIR-7240) get their own row, _Agent runs with no project_,
beside the workspaces — never guessed into one.

## The panels

- **D1 — Estate overview (MOTIR-731).** Unchanged from the first publish: four counts with "+N in the last
  {period}", and the activity feed merging tenant events with planning and coding runs (`GET /v1/platform/runs`).
- **D2 — Overview states.** Unchanged: runs unavailable (the rest renders), empty estate, loading.
- **D3 — Usage & cost · estate, a month (MOTIR-732).** The estate as a whole for the chosen month: four
  figures (credits charged, Motir cost, machine minutes, orgs with spend), **the estate by category** (the eight
  rows summed over every org, with usage, credits and Motir cost, and the totals), and the two model tables —
  **planning tokens by model** and **agent-run tokens by model** (input, output, cache read, cache write, orgs
  using it, credits, Motir cost). No list of organizations here — that list is Tenants (D10).
- **D4 — Usage & cost · estate, All time (MOTIR-732).** The same page with the period on All time. **Every
  section answers for any period** — a month or all time; nothing (the model tables included) exists for one
  period only.
- **D10 — Tenants (MOTIR-733).** Replaces the shipped search-first `/admin/tenants`: the **tenant list comes
  first**. One flat row per org — credits per charged category, indexing minutes, charged total, Motir cost —
  with the **estate total over all orgs** as the first row; sorted by Motir cost, every column sorts, Show more
  (keyset). A filter field (name or slug) narrows the list; the period control (any month or All time) sets what
  every spend column answers for. Clicking an org opens its page (D5).
- **D5 — Drill-down · org · Overview tab (MOTIR-733).** Reached from Tenants (D10). **No breadcrumb**: a
  **← Tenants** button returns to the list with its filter and period kept, on every tab. The org page with three tabs (Overview, Usage &
  cost, Billing & plans). Overview: this month's spend per category (credits + Motir cost) linking to the Usage
  & cost tab, Members, Workspaces (charged credits this month), Recent jobs. Status is display-only (Story 10.3).
- **D6 — Drill-down · workspace (MOTIR-733).** A **← {org}** button returns to the org page. Projects with this month's spend, members, recent jobs
  (attributed runs only). Tabs: Overview and Usage & cost (the D8 tab with the scope preset to the workspace).
- **D7 — States.** No spend in the period; Usage & cost with motir-ai unreachable; a drill-down usage card
  unavailable while Motir's own cards render; loading.
- **D8 — Drill-down · org · Usage & cost tab (MOTIR-733).** The org's full breakdown, every axis combinable:
  **scope** picker (whole org, or any workspace or project) × **period** (any month or All time). Four figures
  (credits charged, Motir cost incl. indexing, machine minutes by kind, credit balance), then three tables over
  the same scope + period:
  1. **By category and model** — the eight categories with usage, credits and Motir cost; planning and
     agent-run tokens expand to one row per model; Charged total and Total incl. indexing.
  2. **By workspace and project** — each workspace (expanding to its projects) × every category, indexing
     minutes, charged total, Motir cost; plus _Agent runs with no project_ and _Org-level (not by project)_.
  3. **Month by month** — every month newest first × every category, with the **all-time total** row. A month
     row sets the period to that month.
- **D9 — Drill-down · org · Billing & plans tab (MOTIR-733).** Unchanged from the second publish: the tenant's
  own billing page read-only (seat line, AI plan + allotment, this month's bill line by line, payment method and
  invoices), every tenant action absent.
- **D11 — The same tab scoped to a project, All time (MOTIR-733).** Scope picker on _Engineering › Mobile App_,
  period All time: the category-and-model sheet (org-level categories listed with "Org-level — not split by
  project") and the project's month by month with its all-time total.

## What the views read

- **Credits, by category, at every level, for any month:** the platform usage rollup (motir-ai, MOTIR-7238)
  **gains a category dimension** — `(level, entityId, yearMonth, model, category)` with the eight categories
  above (indexing carries no credits) — and a **Motir-cost column** written at the moment the spend lands,
  from the upstream price (tokens) or the meter's `costUsd` (machine), so a later price change never rewrites
  history. All time is the sum of the entity's months; a month is one indexed read. Never a scan of the source
  tables.
- **Minutes and machine cost:** motir-core's fleet meter (`CiContainerUsage`, workloads `agent`,
  `agent_instance`, `ci`, `index`) rolled up per org / workspace / project / month on motir-core's side, so the
  operator's indexing figures exist even though no tenant is charged for them. This is the fleet & index
  COGS work MOTIR-5285/5286 were cut for; it becomes columns of these sheets rather than a separate segment.
- **Billing tab:** the tenant's subscription, plan, allotment, this month's charge lines and invoices, through
  the console's audited read. Every tab view, every scope and period change writes one audit row.

## Primitives composed (no hand-rolling)

The mock's style block and icon sprite are copied verbatim from `console.mock.html`; every element is one of
its existing components: the admin shell (`admin-nav`, `adminbar`, staff mark, search), `card` / `card-head` /
`card-foot` (`Card`), `tbl` and `tbl tree` (`Table`), `pill` (`Pill`), `segmented` (`Segmented` — tabs, scope
picker, period picker), `stat-grid` stats, `scope` breadcrumb, `audit-banner`, `note`, `states-grid` / `state`
/ `state err` (`EmptyState`, error state), `sk` skeletons. Two additions:

- **`tbl dense`** — the Table at compact density (12px, tighter cells, two-line headers) for the
  all-categories matrices, which carry 11–12 numeric columns. Wide tables also sit in a horizontal scroller.
- **The tenant view (D9)** reuses the tenant's shipped billing components (`gico`, `line`, `row1`, `meter`,
  `meterlbl`, `seatcalc`, `pay`, `pill-topup`), copied verbatim from `design/billing/billing.mock.html` and
  scoped under `.tv`; the `i-card` icon is copied from the billing sprite.

No new colour is introduced.

## Colour roles

Entity tints `ent-org` / `ent-ws` / `ent-proj` / `ent-user` for avatars and icons; run kinds `pill-plan` /
`pill-code`. The _no project_ and _org-level_ rows are deliberately neutral (a "?" avatar, no tint) so they
never read as a tenant. Numbers use `--el-text` / `--el-text-strong` (credits, totals) and
`--el-text-secondary` (`.muted` cells), never `--el-text-muted` on a surface.

## Copy strings (en — the `platformAdmin` namespace)

| key                                                               | en                                                                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `overview.period.7d` / `.30d` / `.month`                          | 7 days / 30 days / This month                                                                                                                                                  |
| `overview.stat.delta`                                             | +{count} in the last {period}                                                                                                                                                  |
| `overview.feed.title`                                             | Recent estate activity                                                                                                                                                         |
| `overview.feed.runsUnavailable`                                   | Runs are unavailable right now. The usage service didn’t answer, so planning and coding runs are missing from this feed. New tenants still show — they come from Motir itself. |
| `pager.newer` / `pager.older` / `pager.showMore`                  | Newer / Older / Show more                                                                                                                                                      |
| `period.allTime`                                                  | All time                                                                                                                                                                       |
| `usage.title`                                                     | Usage & cost                                                                                                                                                                   |
| `usage.subtitle`                                                  | The estate’s spend in every category — credits charged, usage, and what it cost Motir. Pick any month, or all time. Each organization’s figures are on Tenants.                |
| `usage.cat.plan` / `.agent` / `.agentMachine`                     | Planning tokens / Agent-run tokens / Agent-run machine                                                                                                                         |
| `usage.cat.instances` / `.storage` / `.ci` / `.search` / `.index` | Agent instances / Agent storage / CI / Web search / Indexing                                                                                                                   |
| `usage.col.usage` / `.credits` / `.cost` / `.charged`             | Usage / Credits / Motir cost / Charged                                                                                                                                         |
| `usage.notCharged`                                                | not charged                                                                                                                                                                    |
| `usage.total.charged` / `.inclIndexing`                           | Charged total / Total incl. indexing                                                                                                                                           |
| `usage.estateRow`                                                 | All {count} orgs                                                                                                                                                               |
| `usage.row.noProject` / `.orgLevel`                               | Agent runs with no project / Org-level (not by project)                                                                                                                        |
| `usage.orgLevelNote`                                              | Org-level — not split by project. See the whole org.                                                                                                                           |
| `usage.scope.wholeOrg`                                            | Whole org                                                                                                                                                                      |
| `usage.empty.title`                                               | No usage in {period}                                                                                                                                                           |
| `usage.error.title` / `.body`                                     | Couldn’t load usage / The usage service didn’t respond, so these figures aren’t available. Nothing is zero — the figures simply aren’t loaded.                                 |
| `tenants.title` / `tenants.subtitle`                              | Tenants / Every organization and what it spent, in every category. Click an org to open it. Opening one is an audited cross-tenant read.                                       |
| `tenants.filterLabel` / `.filterPlaceholder`                      | Filter by name or slug / moooon, acme, northwind…                                                                                                                              |
| `drill.back` / `drill.backToOrg`                                  | Tenants / {org}                                                                                                                                                                |
| `drill.tab.overview` / `.usage` / `.billing`                      | Overview / Usage & cost / Billing & plans                                                                                                                                      |
| `drill.workspaces.title` / `drill.members.title`                  | Workspaces · {count} / Members · {count}                                                                                                                                       |
| `drill.jobs.title`                                                | Recent jobs                                                                                                                                                                    |
| `drill.usageUnavailable`                                          | Usage isn’t available right now. Members and workspaces below are unaffected.                                                                                                  |
| `drill.tenantView.billing`                                        | What {org}’s owner sees on their Billing & plans page and in their invoices, read-only. Changing a tenant’s plan or credits is Story 10.3.                                     |

## What this amendment does NOT draw

- **Any governance action** (suspend, grant, impersonate, tier change) — Story 10.3.
- **The operator lessons console** — Story 10.5 (MOTIR-1408).

---

# AMENDMENT 2026-10-02 — Planning lessons (MOTIR-1409 · story MOTIR-1408)

**Design system check (first, per the design-system rule).** The same verdict as the AI planning
amendment above: the project is on Motir Design (`@motir/design-system`, `workspace:*`), so the page
is drawn from its `--el-*` / shape tokens and its shipped primitives. **Nothing the package lacks is
needed.** The page uses the shipped `Switch`, and its five `--el-switch-*` tokens are spelled in the
mock exactly as `packages/design-system/theme.css` defines them.

**Mock (a DELTA):**
[`console--planning-lessons.mock.html`](console--planning-lessons.mock.html), eleven panels.
**Amends:**

- `console.mock.html` Panel 2 / 13: the shell gets one more rail row.
- Panel 7a: the 404, referenced and not redrawn.
- Panels 11–12 and the AI planning amendment's Panel 4: the confirm-with-reason grammar, reused for
  four more writes.

The older mocks are records and are not edited.

**Gates:**

- **MOTIR-1411**: the page `/admin/planning-lessons`, the detail `/admin/planning-lessons/[id]`, the
  nav row, every state below, en + zh.
- **MOTIR-1463**: the retirement-window control, Panel 10.

It builds on motir-ai's `/v1/admin/lessons` API (MOTIR-1410, documented in motir-ai's boundary contract). That
API returns each write's audit record for motir-core to append.

**Composed, not redrawn.** The token block, primitive CSS and lucide sprite are spliced verbatim from
`console--ai-planning.mock.html`. The shell is the shipped `AdminShell.tsx`, and every confirm is the
shipped `ClassificationBar` grammar. The additions block at the end of the mock's `<style>` holds
three things only: this page's cell styles, the `Switch`'s tokens, and six lucide glyphs (`BookOpen`,
`Pencil`, `Globe`, `History`, `Filter`, `Hourglass`).

## What this page is

This is where Motir platform staff review what the planner has learned from its own mistakes,
**across every organisation**, beside the global corpus every planner reads. They curate it in three
ways: edit a lesson, switch it off, or promote it so every planner learns it. **Staff-facing only.**
For a non-staff user both routes are a 404 (Panel 7a). No tenant surface links here.

The tenant-facing lessons view (Settings → Project → AI planning, MOTIR-3335) shows one project its
OWN lessons. This page is the only one that shows them all, and the only one that writes.

## The access path — a new rail row (Panel 1)

The new row is **Operations → Planning lessons**:

- **Position:** after **AI planning** and before the reserved **Governance (10.3)** row.
- **Icon:** `BookOpen` (lucide).
- **Route:** `/admin/planning-lessons`, active when `pathname.startsWith('/admin/planning-lessons')`,
  so the detail keeps it lit.
- **Visibility:** it is a LIVE row, visible to **every staff role**.

It sits in Operations beside AI planning because both are knobs on how the planner runs.

## The roles

| Staff role               | Reads                                | Can change                                                                     |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------ |
| `support`                | the list and every detail (Panel 5b) | nothing — no switch, no Edit, no Promote, no window Change                     |
| `operator`               | the list and every detail            | **edit** and **switch on / off** (Panel 5a)                                    |
| `superadmin`             | the list and every detail            | the above, plus **promote** (Panel 4) and the **retirement window** (Panel 10) |
| not staff (owners incl.) | the app 404 (Panel 11 → Panel 7a)    | —                                                                              |

- **Reads** are `requirePlatformStaff('support')`.
- **Edit and enable/disable** are `operator`, re-asserted in the service, which is the rule. The
  missing control is only presentation.
- **Promote is `superadmin`**, for a reason specific to this page. Promoting takes one customer's
  words and puts them in front of every other customer's planner. That is a disclosure decision, not
  a curation one.
- **The window is `superadmin`**, because it changes what every organisation's planner is told
  (MOTIR-1463's card says so).

**Reads are audited.** A tenant lesson is customer text, so it is a cross-tenant read.

- Opening a detail writes one `estate.read` row targeting the lesson.
- Loading a list page writes one `estate.read` row targeting the platform.

This is the console's standing rule ("all reads audited" in the operator bar). The page line under
the title says so.

## The panels (review EACH — mistake #31)

1. **The list, populated.** It renders inside the shell, with the rail row active. Two cards stack:
   - **The retirement-window card** (Panel 10's door). It holds one sentence with the current N, a
     line saying who set it, and **Change** for a superadmin.
   - **Lessons**, holding the filter bar, the table and the pager. The table's columns:
     - **Lesson**: title, with its categories as mono chips beneath.
     - **Type**: the mistake type as a `Pill`, one tint per type.
     - **Owner**: the organisation with `workspace / project` beneath, or a **Global** pill with a
       globe glyph.
     - **Injection**: a dot + a word. **Injected**, **Off** (_Switched off by staff_) or **Resting**
       (_Not seen in N days_).
     - **Recurred**: `N×` with _last {when}_.
     - A chevron.

   The whole row opens the detail. Newest first, 50 a page.

2. **Filtered.**
   - **LEFT:** the filters narrow together. Each set filter becomes a removable chip on a strip
     under the bar, with **Clear all**. The pager drops when the results fit one page.
   - **RIGHT:** no match. A filter-shaped empty state with **Clear filters**, distinct from 3b.
3. **States.**
   - **(a) Loading:** the card, its head and the filters paint at once, and five skeleton rows wait.
     No count is guessed.
   - **(b) Empty store:** no lesson exists anywhere, so there is nothing to filter.
   - **(c) Unavailable:** motir-ai did not answer. The console's error card with Retry, and no rows.
4. **Detail, a superadmin.** At `/admin/planning-lessons/[id]`. The title is the page heading, with
   three pills: type, owner (or Global) and injection state.
   - **Left card:** _Why it matters_, _How to apply_, _What happened_ (the lesson's `body`), and
     _Categories_.
   - **Right column, Provenance:** organisation, workspace · project, source (`sourceRef`), captured
     date, and recurrence count with its last date.
   - **Right column, Recent occurrences:** the newest 20, each with ref, source and date.
   - **Right column, Changes by staff:** the platform audit rows for this lesson, newest first, each
     with the act, what changed, who, when and the reason.

   The curate controls sit top-right: the **Injected** `Switch`, **Edit**, and **Promote**. Promote
   is a menu, drawn open, whose two targets each explain themselves in one line.

5. **Controls by role** (header only).
   - **(a) operator:** the switch and Edit. No Promote.
   - **(b) support:** pills only, with one line saying who can change lessons. No disabled controls
     are rendered.
6. **Edit.**
   - **(a)** The form replaces the text card in place: Title (`Input`), Why it matters and How to
     apply (`Textarea`), and Categories. No field may be blank.
   - **(b)** **Review change** opens the confirm. It shows ONLY the fields that changed, old struck
     through above new: the same from → to the audit row records. It requires a reason.

   If nothing changed, Review change stays disabled.

7. **The switch.** Flipping it opens a confirm with a required reason. The switch moves only after
   the write succeeds.
   - **(a) Off:** names whose planner stops reading the lesson, and says nothing is deleted.
   - **(b) On, reason missing:** the primary is disabled.

   For a global lesson the sentence names _every organisation's planner_.

8. **Promote** (superadmin). One confirm per target.
   - **→ Global:** the lesson leaves its organisation, and every planner reads it.
   - **→ Global planning craft:** the same, and its type becomes Planning craft, so planners of
     both phases read it.

   Both carry a **warning box**: _this is {org}'s text; edit out anything that names their product,
   people, code or customers BEFORE you promote it_. Both say there is no demote on this page.
   Which targets the menu offers depends on the lesson:
   - A global regular lesson offers only the planning-craft target.
   - A global planning-craft lesson shows no Promote at all.

9. **After a write.**
   - **TOP:** the switch has moved, a success `Toast` says when it takes effect, and the change
     heads _Changes by staff_ with the reason.
   - **BELOW:** the three other answers a write can get:
     - **The lesson is gone** (`not_found`): back to the list.
     - **motir-ai did not answer:** nothing was written, and the form keeps the edit.
     - **Someone got there first:** a **no-op**. motir-ai answers `audit: null`, so no audit row is
       written, and the page says so in a warning toast rather than a success one.
10. **The retirement window** (MOTIR-1463, superadmin).
    - **(a)** The confirm takes one number in days, bounded 7–365. It counts how many currently
      injected lessons would rest under the new value before you commit, and it requires a reason.
    - **(b)** operator and support see the card with _Only a superadmin can change this._ in place
      of Change.
11. **Not staff.** The app 404, drawn BY REFERENCE (Panel 7a). Not redrawn.

## Copy (en — the `platformAdmin` namespace MOTIR-1411 adds, with a `zh` twin each)

Lesson text, organisation names, keys and counts in the mock are **examples**. Interpolated values
are in `{braces}`.

| key                                                     | string                                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.navPlanningLessons`                              | Planning lessons                                                                                                                                                                                                                                                     |
| `lessons.breadcrumb`                                    | Operations · Planning lessons                                                                                                                                                                                                                                        |
| `lessons.title`                                         | Planning lessons                                                                                                                                                                                                                                                     |
| `lessons.subtitle`                                      | What the planner has learned from its own mistakes, across every organisation, beside the global corpus every planner reads. Edit a lesson, switch it off, or promote it so every planner learns it.                                                                 |
| `lessons.readAuditedLead`                               | Tenant lessons are customer text.                                                                                                                                                                                                                                    |
| `lessons.readAuditedBody`                               | Opening one is a cross-tenant read and is written to the audit log.                                                                                                                                                                                                  |
| `lessons.card.title`                                    | Lessons                                                                                                                                                                                                                                                              |
| `lessons.card.subtitle`                                 | Every organisation’s lessons and the global corpus, newest first.                                                                                                                                                                                                    |
| `lessons.filter.search`                                 | Search · Search lesson titles                                                                                                                                                                                                                                        |
| `lessons.filter.scope`                                  | Scope · All · Global · Tenant                                                                                                                                                                                                                                        |
| `lessons.filter.type`                                   | Type · Any type                                                                                                                                                                                                                                                      |
| `lessons.filter.category`                               | Category · Any category                                                                                                                                                                                                                                              |
| `lessons.filter.org`                                    | Organisation · Any organisation                                                                                                                                                                                                                                      |
| `lessons.filter.state`                                  | State · All · On · Off                                                                                                                                                                                                                                               |
| `lessons.filter.count`                                  | {n} filters                                                                                                                                                                                                                                                          |
| `lessons.filter.clearAll`                               | Clear all                                                                                                                                                                                                                                                            |
| `lessons.col.*`                                         | Lesson · Type · Owner · Injection · Recurred                                                                                                                                                                                                                         |
| `lessons.type.*`                                        | Regular planning · Onboarding planning · Planning craft · Coding                                                                                                                                                                                                     |
| `lessons.owner.global`                                  | Global                                                                                                                                                                                                                                                               |
| `lessons.inj.on`                                        | Injected                                                                                                                                                                                                                                                             |
| `lessons.inj.off` / `.offSub`                           | Off / Switched off by staff                                                                                                                                                                                                                                          |
| `lessons.inj.resting` / `.restSub`                      | Resting / Not seen in {days} days                                                                                                                                                                                                                                    |
| `lessons.recur`                                         | {n}× · last {when}                                                                                                                                                                                                                                                   |
| `lessons.pager`                                         | Newest first · 50 a page · Page {n} · Previous · Next                                                                                                                                                                                                                |
| `lessons.noMatch.title` / `.body`                       | No lessons match these filters / Nothing is hidden by your role. Remove a filter, or clear them all.                                                                                                                                                                 |
| `lessons.noMatch.action`                                | Clear filters                                                                                                                                                                                                                                                        |
| `lessons.empty.title` / `.body`                         | No lessons yet / The planner writes a lesson when it notices it made a mistake. None has been captured on this platform yet, and no global lesson has been seeded.                                                                                                   |
| `lessons.unavailable.title` / `.body`                   | Couldn’t load the lessons / The planning service (motir-ai) didn’t respond, so no lesson is shown. This is a fetch error — nothing has changed.                                                                                                                      |
| `lessons.detail.why` · `.how` · `.what` · `.categories` | Why it matters · How to apply · What happened · Categories                                                                                                                                                                                                           |
| `lessons.detail.provenance`                             | Provenance — Organisation · Workspace · project · Source · Captured · Recurred                                                                                                                                                                                       |
| `lessons.detail.occurrences`                            | Recent occurrences · newest 20                                                                                                                                                                                                                                       |
| `lessons.detail.history`                                | Changes by staff                                                                                                                                                                                                                                                     |
| `lessons.detail.readOnly`                               | Only an operator or superadmin can change lessons.                                                                                                                                                                                                                   |
| `lessons.edit` · `.review` · `.save`                    | Edit · Review change · Save edit                                                                                                                                                                                                                                     |
| `lessons.edit.confirmTitle` / `.body`                   | Save your edit to this lesson? / The planner reads the new wording from its next planning job. Changing the title or how-to-apply also changes which tasks it is matched to.                                                                                         |
| `lessons.off.title` / `.body`                           | Stop injecting this lesson? / The planner for {owner} stops reading it from its next planning job. Nothing is deleted, its occurrences keep counting, and you can switch it back on at any time.                                                                     |
| `lessons.on.title` / `.body`                            | Inject this lesson again? / The planner for {owner} reads it again from its next planning job, as long as it has recurred in the last {days} days.                                                                                                                   |
| `lessons.ownerAll`                                      | every organisation’s planner (replaces “the planner for {owner}” on a global lesson)                                                                                                                                                                                 |
| `lessons.promote` · `.toGlobal` · `.toCraft`            | Promote · Make global · Make global planning craft                                                                                                                                                                                                                   |
| `lessons.promote.globalHint`                            | Every organisation’s planner reads it. Its type stays {type}.                                                                                                                                                                                                        |
| `lessons.promote.craftHint`                             | Every planner reads it, during onboarding and regular planning alike.                                                                                                                                                                                                |
| `lessons.promote.globalTitle` / `.body`                 | Make this lesson global? / It stops belonging to {owner}, and every organisation’s planner reads it from its next planning job. This cannot be undone from this page.                                                                                                |
| `lessons.promote.craftTitle` / `.body`                  | Make this lesson global planning craft? / Every planner reads it, during onboarding and regular planning alike, from its next planning job. Its type changes from {type} to Planning craft, and it stops belonging to {owner}. This cannot be undone from this page. |
| `lessons.promote.warning`                               | This is {org}’s text. Edit out anything that names their product, people, code or customers BEFORE you promote it — other organisations will be planned with it.                                                                                                     |
| `lessons.reasonLabel`                                   | Reason — required, written to the audit log                                                                                                                                                                                                                          |
| `lessons.saved.*`                                       | Lesson switched off. / Lesson switched on. / Lesson edited. / Lesson promoted. — each followed by: The planner {reads / stops reading} it from its next planning job.                                                                                                |
| `lessons.refused.gone`                                  | Not saved — this lesson no longer exists. It was removed while you had it open. Nothing was written.                                                                                                                                                                 |
| `lessons.refused.unavailable`                           | Not saved — the planning service didn’t answer. Nothing was written and no audit row exists. Your edit is still in the form; try again.                                                                                                                              |
| `lessons.noop`                                          | Already {state}. Someone changed this lesson a moment ago, so there was nothing to change and nothing was logged.                                                                                                                                                    |
| `lessons.window.line` / `.sub`                          | Retirement window: {days} days. A lesson that has not recurred in {days} days stops being injected. It is kept, and comes back the next time it recurs. / Default 90 · set by nobody yet                                                                             |
| `lessons.window.change`                                 | Change                                                                                                                                                                                                                                                               |
| `lessons.window.readOnly`                               | Only a superadmin can change this.                                                                                                                                                                                                                                   |
| `lessons.window.confirmTitle` / `.body`                 | Change the retirement window? / Lessons that have not recurred within the window stop being injected for every organisation, from the next planning job. Nothing is deleted: a resting lesson comes back the next time it recurs.                                    |
| `lessons.window.bounds`                                 | Between 7 and 365 days.                                                                                                                                                                                                                                              |
| `lessons.window.impact`                                 | At {days} days, {n} lessons that are injected today will rest.                                                                                                                                                                                                       |

## Data — what each element reads

| element                       | source                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| list rows, filters, pager     | `GET /v1/admin/lessons` (`scope`, `mistakeType`, `category`, `enabled`, `coreOrganizationId`, `coreProjectId`, `q`, cursor)  |
| owner                         | the row's `tenant` (`null` → Global); org name, workspace and project names resolved in motir-core from the core ids         |
| Organisation filter's options | motir-core's org list (the tenants lookup's read), sent as `coreOrganizationId`                                              |
| injection state               | the row's `injected` / `injectionBlock` (`disabled` → Off, `not_recurred` → Resting), N from `retentionDays`                 |
| detail, occurrences           | `GET /v1/admin/lessons/:id` (`occurrences`, newest 20)                                                                       |
| Changes by staff              | motir-core's platform audit log, rows whose target is this lesson (`ai.lesson.*`), newest first — a by-target read 1411 adds |
| edit / switch / promote       | `PATCH` · `PUT …/enabled` · `POST …/promote`; motir-core appends the returned `audit` record (skipped when it is `null`)     |
| no-op answer                  | `audit: null` on a write                                                                                                     |
| retirement window             | MOTIR-1463's persisted setting; the impact count is a read 1463 adds                                                         |

**There is no total count.** The list API is cursor-paged and returns no total. A count would be a
second, full-table query on every page turn, so the pager says _Page {n}_ and offers Previous and
Next. Previous walks back through the cursors the client has already seen.

## Audit actions this page adds

These go in motir-core's `PLATFORM_AUDIT_ACTIONS`, all with reason `required`:

- `ai.lesson.edit`
- `ai.lesson.enable`
- `ai.lesson.disable`
- `ai.lesson.promote`
- MOTIR-1463's window change.

The target is the lesson for the first four, and the platform for the window. `metadata` carries
motir-ai's `before` / `after`, which hold only the fields that changed.

## Colour and shape roles (`--el-*` only)

| element                                 | token                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| card, table, rows, pager                | the console's `Card` + `.tbl` + `.pager` roles, unchanged                                                                                         |
| lesson title · categories               | `--el-text` · mono `--el-text-identifier` on `--el-surface`, `--radius-badge`                                                                     |
| type pills                              | `Pill` tints: Regular `--el-tint-mint`, Onboarding `--el-tint-sky`, Craft `--el-tint-lavender`, Coding `--el-tint-peach`; text `--el-text-strong` |
| owner · its path                        | `--el-text` · mono `--el-text-identifier`; Global pill `--el-tint-lavender` + `--el-text-strong`                                                  |
| injection dot                           | Injected `--el-success`, Resting `--el-warning`, Off `--el-switch-off-border`; word `--el-text`, reason `--el-text-secondary`                     |
| filter triggers                         | `--el-page-bg`, `--el-border` (set: `--el-border-strong`, value `--el-text-strong`), `--radius-input`, `--height-control`                         |
| active-filter strip · chip              | `--el-surface-soft` with `--el-text-secondary` · chip on `--el-page-bg`, `--radius-badge`                                                         |
| Switch                                  | the shipped `Switch`: `--el-switch-on` / `-on-border` / `-off-border` / `-knob` / `-knob-off`, `--el-muted` track off                             |
| promote menu                            | `Popover`: `--el-page-bg`, `--shadow-elevated`, `--radius-card`; active row `--el-option-active-bg`; glyph `--el-accent-on-surface`               |
| promote warning · window impact         | `--el-tint-yellow` + `--el-text-strong`, glyph `--el-warning`                                                                                     |
| edit diff                               | old `--el-text-secondary` struck through, new `--el-text`                                                                                         |
| toasts                                  | success `--el-tint-mint`, no-op `--el-tint-yellow`, refused `--el-tint-rose`; all `--el-text-strong`                                              |
| retirement card glyph · page-line glyph | `--el-info`                                                                                                                                       |

**No muted or faint ink carries text on this page.** These rows sit on `--el-surface` / `--el-surface-soft`
as well as on white, and there `--el-text-muted` fails AA. Every secondary line is
`--el-text-secondary`.

## A11y

- **The table** is a real `<table>`. Each row is a link to the detail, and its accessible name is
  the lesson's title.
- **The filter bar** is `role="search"`. Each chip's remove control is labelled _Remove {filter}_.
- **The switch** is the shipped `Switch` (`role="switch"`, `aria-checked`), labelled _Inject this
  lesson_. Flipping it opens the confirm. The switch's own state changes only after the write.
- **Every confirm** is `role="alertdialog"`. Focus lands in the reason field, and the primary
  carries `disabled` until the reason is non-blank.
- **Toasts:** a success or no-op toast is `role="status"`; a refusal is `role="alert"`.
- **The read-only face** renders no disabled controls.

## What this amendment does NOT draw

- **Deleting a lesson.** Off is the reversible answer, and retirement is the automatic one. Delete
  is a later story if one is needed.
- **Demoting a global lesson** back to a tenant. The confirm says so.
- **Creating a lesson by hand.** Lessons come from the planner and from the `add_lesson` door.
- **An audit browser.** _Changes by staff_ is this lesson's rows only. The browser is Story 10.3's
  (MOTIR-745).
- **The routing axes** (`kinds` / `types` / `phases`) as filters. They are not on the API (MOTIR-1410)
  and nobody asked for them here.
- **A `.png` export.** `docs/decisions/design-result.md` AMENDMENT 4 retired exports.

---

# AMENDMENT 2026-10-03 — the ops toolkit (MOTIR-746 · story MOTIR-745)

**Design system check (first, per the design-system rule).** Read `package.json` (depends on
`@motir/design-system` `workspace:*`) and `app/globals.css` (`@import '@motir/design-system/theme.css'`).
**Verdict: the project is on Motir Design** (package `0.8.0`), so every element is drawn from that system's
`--el-*` / shape tokens and the shipped primitives. The root layout applies the signed-in person's own
`data-style` / `data-palette` / `data-type`, so the mock draws the base values and routes every element through
a token. **Nothing the package lacks is needed** — no proposed addition, no product-local component.

**Mock (a DELTA):** [`console--ops-toolkit.mock.html`](console--ops-toolkit.mock.html), eight panels.
**Amends:** D5 / D9 of `console--estate-usage-drilldown.mock.html` (the org page gains a fourth tab; D9's
_"Changing a tenant's plan or credits is Story 10.3"_ is now answered), Panel 9 of `console.mock.html` (the user
page gains one action), Panel 12 (its confirm-with-reason grammar, reused for every write here) and the rail's
reserved **Governance · 10.3** row (it goes live as **Audit log**). The older mocks are records and are not edited.
**Gates:** MOTIR-747 · 748 · 749 · 750 · 751 (each builds its panel's behaviour) and MOTIR-752 (the UI).

**Composed, not redrawn.** The mock's token block, primitive CSS and lucide sprite are spliced verbatim from
`console--ai-planning.mock.html` (itself from `console.mock.html`); the shell is the shipped `AdminShell.tsx`; the
org header and tabs are the shipped `OrgPageHeader` + `orgNav`; the confirm is the shipped `ClassificationBar` /
`SupportActionsBar` (`Modal role="alertdialog"` + `FormField` + a primary disabled until a reason is typed). The
additions block at the end of `<style>` holds only the `Switch` (with the five `--el-switch-*` tokens spelled as
`theme.css` defines them), the staff-session bar, the ledger amount cell, the audit row's detail list and two
layout helpers.

## ⚠️ Where the card's prose and this asset differ (rung 2 — shipped reality and this repo's rules win)

The card was written on 2026-06-15, before the console it extends existed. Four differences, each deliberate:

1. **File names.** The card asks for `ops-toolkit.mock.html` and a separate `ops-toolkit-design-notes.md`. This
   repo's rule is ONE `design-notes.md` per area and a change drawn as a `<surface>--<change>.mock.html` delta
   (CLAUDE.md § _Design assets_), so the asset is `console--ops-toolkit.mock.html` and these notes are a section here.
2. **No "drawer".** The card's Panel 1 says _"the tenant ops drawer"_. The shipped org page is tabbed
   (`?tab=overview|usage|billing`), so the toolkit is a fourth tab, **Operations**, not a drawer over the page.
3. **The "Governance" section is not a page.** The rail has reserved a disabled `Governance · 10.3` row
   since MOTIR-2896. Every 10.3 write targets ONE org or ONE user, so each sits on that entity's page; the only
   estate-wide 10.3 surface is the audit log. The reserved row therefore goes live as **Audit log** →
   `/admin/audit-log`, and the governance route the reserved row named is never served.
4. **"Read-only View as tenant" was 10.1's and never shipped.** `console.mock.html` Panel 6 drew it and named
   write-level impersonation as 10.3's. Nothing in `origin/main` serves either (`grep -ri impersonat app lib`
   finds only prose). MOTIR-749 therefore owns BOTH modes, read-only as the default.

## The access paths (the doors, drawn)

| Surface                            | Door                                                                                | Panel |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ----- |
| Status · Credits & plan · Switches | Tenants → an org → the **Operations** tab (`/admin/tenants/[orgId]?tab=operations`) | 1     |
| The org's own audit slice          | the same tab, last card, with **Open in the audit log** (pre-filtered to the org)   | 1     |
| Impersonation entry                | Users → a person → **View as {first name}** beside the two day-1 writes             | 4     |
| Exiting a staff session            | **Exit session** on the bar that rides every page of the session                    | 5     |
| The audit log                      | the rail's **Audit log** row in Operations (superadmin only)                        | 6     |

## Roles (ADR `platform-staff-auth.md` §7 — every 10.3 write is `superadmin`)

| Role                   | Operations tab                                | View as …       | Audit log                       |
| ---------------------- | --------------------------------------------- | --------------- | ------------------------------- |
| `superadmin`           | every card, every action (Panel 1)            | button + dialog | rail row + page                 |
| `operator` · `support` | every card READ-ONLY, no action rendered (8c) | button absent   | rail row absent; the route 404s |
| not platform staff     | the console's 404 (Panel 7a)                  | —               | 404                             |

The missing control is presentation; each service re-gates at `superadmin` (the rule MOTIR-7227 follows).

## The safe-action pattern (every write in this asset)

1. **The button opens a dialog; nothing writes on the first click.** `Modal role="alertdialog"`, the
   `ClassificationBar` shape.
2. **The dialog states the consequence before it asks for anything** — what changes, for whom, what is NOT
   touched (deleted, Stripe), and that it is reversible where it is.
3. **A REASON is required on every write.** `FormField` + `Textarea`, label _"Reason — required, written to the
   audit log"_. The primary is **`disabled` until it is non-empty** (Panel 2e) — a gate, never a post-submit
   error — and the service re-checks it (the `PLATFORM_AUDIT_ACTIONS` `reason: 'required'` policy).
4. **The heavy ones add a TYPED confirm** — type the org's slug. Applies to **Suspend organization** and to a
   **grant of 10,000 credits or more** (Panel 2b). The threshold is a constant MOTIR-747 owns; 10,000 is the
   proposal (half of the Team allotment; above any routine goodwill credit).
5. **The record is rendered back on the surface that made it** — the Operations tab ends with _"Platform actions
   on this organization"_, the user page keeps its _"Support actions"_ log. An operator never wonders whether a
   write was recorded.
6. **The write and its audit row share one outcome.** A refusal or an unreachable credit service leaves neither
   (Panel 2f), exactly as Panel 12f says for the classification.
7. **"This is audited" is said three times:** the `--el-info` audited-read banner at the top of every console
   page, the reason field's label, and the record card.

## Panels (review EACH — mistake #31)

1. **Org page · Operations tab (superadmin).** Four cards: **Organization status** (Active pill + who it
   affects + **Suspend organization**, `Button variant="danger"`); **Credits & plan** (balance, AI plan, **Grant
   credits** primary, **Adjust balance** and **Change plan** secondary, then the ledger newest first, keyset-paged
   with Newer/Older, 5 shown here, 25 a page in code); **Kill-switches** (one row per switch: `Switch` + name +
   key, what OFF stops, state pill, last change with who and why, **Turn off / Turn on**); **Platform actions on
   this organization** (the org's audit slice, 3 newest, link to the full log).
2. **Credits & plan dialogs.** (a) grant, with the balance-after preview; (b) a large grant, slug not yet typed,
   primary disabled; (c) adjust, signed amount, balance-after, may not go below zero; (d) change plan — a
   `Combobox` of the tiers motir-ai offers, each with its allotment, and a warning when the org pays through
   Stripe; (e) reason missing; (f) outcomes — a success toast and the unreachable-service toast.
3. **Org lifecycle.** (a) Suspend: consequence list, typed slug, reason, danger fill; (c) Reactivate: reason, a
   note that switches keep their own state; (b) the status card once suspended — who, when, why — and the header
   pill on every tab; (d) what a member sees on any page: a calm `EmptyState`-style refusal with a lock, never a 500.
4. **Impersonation entry.** The user page with **View as {first name}**; the dialog: Access (`Segmented`,
   **Read-only** default / Full access), Ends after (`Segmented`, 15 / **30** / 60 min, max 60), the mode's
   warning, reason. Full access turns the warning to the danger toast and the primary to the danger fill.
5. **The active session.** The bar above the tenant's own TopNav on every page — not dismissible,
   `role="status"`. (a) read-only: write controls disabled with a `Tooltip` _"Read-only staff session"_; (b) full
   access; (c) the session-ended page with **Back to the console** / **Start a new session**.
6. **Audit log.** `/admin/audit-log`: the integrity line (**Chain verified**, the count, when it was checked,
   **Verify again**), filters (free text over reason + target, operator, tenant, action, date range, and
   **Writes** / **Writes & reads**, default Writes), the entries table (when · operator + role at the time ·
   action key · target · reason), keyset-paged 50 a page, never a total scan. One row open: the entry number,
   exact time, actor, action, target with id, full reason, the metadata payload, and its hash chained to the
   previous entry's.
7. **Audit log, chain broken.** A danger toast naming the FIRST entry whose content no longer matches its hash,
   how many follow it, and **Show #n**; that row reads **Hash mismatch**, later rows **Unverified**. The view
   repairs and hides nothing.
8. **States.** (a) loading, one skeleton per card; (b) credit service unreachable — that card only, with Retry;
   (c) operator / support read-only; (d) ledger empty; (e) audit filters with no match; (f) the 404 for a
   non-superadmin at `/admin/audit-log` and for anyone not staff.

## Primitives composed (no hand-rolling)

- [x] **Shell** — `AdminShell` (`Sidebar` rail + operator bar), one row relabelled live.
- [x] **Org header + tabs** — `OrgPageHeader`, `Segmented` links (`orgNav.ts` gains `operations`).
- [x] **`Card`** (+ head / flush body / foot) for every block; **`Table`** (`.tbl`) for ledger, switches, log.
- [x] **`Pill`** — `pill-active` (Active, On, Chain verified), `pill-down` (Suspended, Off, Hash mismatch,
      Unverified), `pill-warn` (Adjustment), `pill-plan` (Grant), `pill-readonly` (Top-up), `pill-neutral`
      (Debit, counts), `pill-tier` (plan).
- [x] **`Button`** — primary, secondary, danger, `sm`; disabled as the reason gate.
- [x] **`Modal`** (`role="alertdialog"`) + **`FormField`** + **`Input`** / **`Textarea`**.
- [x] **`Combobox`** (plan; the audit filters' operator / tenant / action), **`DatePicker`** (the date range).
- [x] **`Segmented`** (tabs; impersonation access + length; Writes / Writes & reads).
- [x] **`Switch`** (kill-switches — the visual state; the flip goes through the confirm).
- [x] **`Toast`** (`toast-warn`, `toast-err`, success), **`Tooltip`**, **`EmptyState`** / **`ErrorState`**,
      the skeleton, the `.audit-banner`.

**No new primitive.** The staff-session bar is a page-level composition (an `role="status"` strip in the
existing tint grammar), not a component the design system lacks.

## Colour and shape roles (`--el-*` only — palette, not grey-only, finding #54)

| Element                               | Token(s)                                                               | Why                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Suspend · full-access primary         | `--el-danger` fill + `--el-danger-text` ink                            | the shipped danger button; the ONLY legal use of `--el-danger-text` |
| Suspended / Off / Hash mismatch pill  | `--el-tint-rose` + `--el-text-strong`, glyph `--el-danger`             | hue in the tint and the glyph, label on strong ink (finding #35)    |
| Active / On / Chain verified pill     | `--el-tint-mint` + `--el-text-strong`                                  | the success family                                                  |
| Grant pill · success toast            | `--el-tint-mint` + `--el-text-strong`                                  | grant and reactivate read as success                                |
| Adjustment pill · warnings in dialogs | `--el-tint-yellow` + `--el-text-strong`, glyph `--el-warning`          | a correction or a caution, never danger                             |
| Top-up pill                           | `--el-tint-sky` + `--el-text-strong`                                   | money in from the customer — informational                          |
| Staff session bar, read-only          | `--el-tint-yellow` + `--el-text-strong`, glyph `--el-warning`          | high-visibility, not alarming                                       |
| Staff session bar, full access        | `--el-tint-rose` + `--el-text-strong`, glyph `--el-danger`             | writes are real                                                     |
| Switch                                | `--el-switch-on` / `-on-border` / `-off-border` / `-knob(-off)`        | as the design system ships it                                       |
| Flag and action keys                  | `--el-text-identifier`, monospace                                      | the identifier ink                                                  |
| Captions, cell notes, hints           | `--el-text-secondary`                                                  | never `--el-text-muted` on a surface or tint                        |
| Radius · padding · height             | `--radius-modal/card/input/badge/control`, `--spacing-*`, `--height-*` | the shape axis                                                      |

**Reactivate is a secondary button with a check glyph**, not a green fill: the design system has no success-filled
button, and the success hue is carried by the **Active** pill the action produces.

## Copy (en — the `platformAdmin` namespace; MOTIR-752 adds a `zh` twin of each)

| Key                                                 | String                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drill.tab.operations`                              | Operations                                                                                                                                                                                                                                                                                                                                     |
| `ops.status.title` / `.subtitle`                    | Organization status / Suspending an organization refuses every member of every workspace under it.                                                                                                                                                                                                                                             |
| `ops.status.active`                                 | {members} members across {workspaces} workspaces can sign in and work.                                                                                                                                                                                                                                                                         |
| `ops.status.suspendedSince`                         | Since {at} · by {operator} · “{reason}”                                                                                                                                                                                                                                                                                                        |
| `ops.suspend` / `ops.reactivate`                    | Suspend organization / Reactivate organization                                                                                                                                                                                                                                                                                                 |
| `ops.suspend.title`                                 | Suspend {org}?                                                                                                                                                                                                                                                                                                                                 |
| `ops.suspend.lead`                                  | Suspension is the lever for non-payment or abuse. From the moment you confirm:                                                                                                                                                                                                                                                                 |
| `ops.suspend.c1` / `.c2` / `.c3`                    | All {members} members of all {workspaces} workspaces are refused at their next request and see that the organization is suspended. / New planning jobs and agent runs are refused; running ones are stopped. / Nothing is deleted. Work items, repositories and the ledger stay exactly as they are, and another superadmin can reactivate it. |
| `ops.suspend.confirm`                               | Suspend {org}                                                                                                                                                                                                                                                                                                                                  |
| `ops.reactivate.title` / `.body`                    | Reactivate {org}? / All {members} members can sign in and work again from their next request. Kill-switches keep their own state — a switch you turned off stays off.                                                                                                                                                                          |
| `ops.typeToConfirm`                                 | Type {slug} to confirm                                                                                                                                                                                                                                                                                                                         |
| `ops.reason.label` / `.placeholder`                 | Reason — required, written to the audit log / Why are you doing this? Name the ticket if there is one.                                                                                                                                                                                                                                         |
| `ops.reason.hint`                                   | Shown to any operator reading this organization later. “Support” on its own answers nothing.                                                                                                                                                                                                                                                   |
| `ops.credits.title` / `.subtitle`                   | Credits & plan / Credits are Motir’s internal unit, never a currency. Read from the credit service; every write is recorded.                                                                                                                                                                                                                   |
| `ops.credits.balance` / `.plan`                     | Balance / AI plan                                                                                                                                                                                                                                                                                                                              |
| `ops.credits.grant` / `.adjust` / `.changePlan`     | Grant credits / Adjust balance / Change plan                                                                                                                                                                                                                                                                                                   |
| `ops.grant.title` / `.body`                         | Grant credits to {org} / Adds credits to the org’s balance as a grant row in its ledger. It changes no plan and touches no Stripe object.                                                                                                                                                                                                      |
| `ops.grant.amount` / `.confirm`                     | Credits to grant / Grant {n} credits                                                                                                                                                                                                                                                                                                           |
| `ops.grant.large`                                   | This is a large grant — {threshold} credits or more, more than this org’s whole monthly allotment. Type the org’s slug to confirm.                                                                                                                                                                                                             |
| `ops.adjust.title` / `.body`                        | Adjust {org}’s balance / Corrects the balance with an adjustment row — for a billing mistake. A goodwill credit is a grant, not an adjustment.                                                                                                                                                                                                 |
| `ops.adjust.amount` / `.hint` / `.confirm`          | Change in credits / Use − to remove credits. The balance may not go below zero. / Adjust by {n} credits                                                                                                                                                                                                                                        |
| `ops.balanceAfter`                                  | Balance after: {after} credits (now {now})                                                                                                                                                                                                                                                                                                     |
| `ops.plan.title` / `.body` / `.current`             | Change {org}’s AI plan / Sets the tier the org’s monthly credit allotment is read from. The tiers are read from the credit service. / Currently {tier} · {allotment} credits a month.                                                                                                                                                          |
| `ops.plan.stripe`                                   | {org} pays for its plan through Stripe. This changes the tier Motir reads; it does not change or cancel the Stripe subscription.                                                                                                                                                                                                               |
| `ops.plan.confirm`                                  | Change plan to {tier}                                                                                                                                                                                                                                                                                                                          |
| `ops.result.granted`                                | Granted {n} credits to {org}. The ledger and the audit log both carry it.                                                                                                                                                                                                                                                                      |
| `ops.result.creditUnreachable`                      | Couldn’t reach the credit service. Nothing was granted and nothing was recorded. Try again in a moment.                                                                                                                                                                                                                                        |
| `ops.ledger.col.*`                                  | When / Kind / Credits / Balance after / By / Reason                                                                                                                                                                                                                                                                                            |
| `ops.ledger.kind.*`                                 | Grant / Adjustment / Top-up / Debit · planning / Debit · agent run / Debit · CI / Debit · search / Internal offset                                                                                                                                                                                                                             |
| `ops.ledger.empty.title` / `.body`                  | No credit transactions yet / {org} has not been charged, topped up or granted anything. Its balance is 0 credits.                                                                                                                                                                                                                              |
| `ops.credits.error.title` / `.body`                 | Couldn’t load credits / The credit service didn’t answer, so the balance, plan and ledger aren’t shown. Nothing is zero — the figures simply aren’t loaded. Status and kill-switches above still work.                                                                                                                                         |
| `ops.switches.title` / `.subtitle`                  | Kill-switches / Durable per-organization switches, ON by default. A change takes effect on the org’s next request — no deploy.                                                                                                                                                                                                                 |
| `ops.switches.col.*`                                | Switch / When OFF / State / Last changed                                                                                                                                                                                                                                                                                                       |
| `ops.switches.on` / `.off` / `.turnOff` / `.turnOn` | On / Off — disabled / Turn off / Turn on                                                                                                                                                                                                                                                                                                       |
| `ops.switch.ai_planning`                            | AI planning — New planning jobs are refused with “planning is paused for your organization”. Jobs already running finish.                                                                                                                                                                                                                      |
| `ops.switch.hosted_runs`                            | Hosted agent runs — New agent runs and agent instances are refused. Running containers are stopped.                                                                                                                                                                                                                                            |
| `ops.switch.web_search`                             | Web search — Planning and agents run without web search; a search call returns “not available”.                                                                                                                                                                                                                                                |
| `ops.switch.confirmOff.title`                       | Turn off {switch} for {org}? (body: the switch's own "When OFF" line, then the reason field)                                                                                                                                                                                                                                                   |
| `ops.readOnlyRole`                                  | Only a superadmin can change these. You can see them as an {role}.                                                                                                                                                                                                                                                                             |
| `ops.audit.title` / `.subtitle` / `.open`           | Platform actions on this organization / Every operator write on this org, newest first. Append-only. / Open in the audit log                                                                                                                                                                                                                   |
| `member.suspended.title` / `.body`                  | {org} is suspended / Your organization’s access to Motir is paused. Nothing has been deleted. Contact your organization’s owner, or write to support@motir.co.                                                                                                                                                                                 |
| `imp.viewAs`                                        | View as {firstName}                                                                                                                                                                                                                                                                                                                            |
| `imp.title` / `.body`                               | View Motir as {name} / Opens {org}’s app as {email} in a staff session. A banner stays on every page until you exit or the session expires.                                                                                                                                                                                                    |
| `imp.access` / `.readOnly` / `.full`                | Access / Read-only / Full access                                                                                                                                                                                                                                                                                                               |
| `imp.length` / `.lengthHint`                        | Ends after / At most 60 minutes. A new session needs a new reason.                                                                                                                                                                                                                                                                             |
| `imp.readOnlyNote`                                  | Read-only: you see exactly what {firstName} sees, and every control that would change something is disabled.                                                                                                                                                                                                                                   |
| `imp.fullWarning`                                   | Full access acts as {firstName}. Anything you change is real and lands in {org}’s data, recorded as made by you on {firstName}’s behalf.                                                                                                                                                                                                       |
| `imp.reasonHint`                                    | Recorded on the session and on every action taken in it.                                                                                                                                                                                                                                                                                       |
| `imp.start.readOnly` / `.full`                      | Start read-only session / Start full-access session                                                                                                                                                                                                                                                                                            |
| `imp.bar.readOnly`                                  | Viewing as {name} ({email}) · {org} — staff session, read-only, ends at {time}                                                                                                                                                                                                                                                                 |
| `imp.bar.full`                                      | Acting as {name} ({email}) · {org} — staff session, full access, every change is yours, ends at {time}                                                                                                                                                                                                                                         |
| `imp.bar.exit` / `imp.disabledTip`                  | Exit session / Read-only staff session                                                                                                                                                                                                                                                                                                         |
| `imp.ended.title` / `.body`                         | Your staff session ended at {time} / You are no longer viewing Motir as {name}. The session and everything you opened in it are in the audit log.                                                                                                                                                                                              |
| `imp.ended.back` / `.again`                         | Back to the console / Start a new session                                                                                                                                                                                                                                                                                                      |
| `nav.auditLog`                                      | Audit log                                                                                                                                                                                                                                                                                                                                      |
| `audit.title` / `.subtitle`                         | Audit log / Every platform-staff action, newest first. Append-only and hash-chained: an entry changed after it was written breaks the chain from that entry on.                                                                                                                                                                                |
| `audit.chain.ok` / `.okDetail`                      | Chain verified / All {count} entries hash-chain intact, checked through #{last} at {time}.                                                                                                                                                                                                                                                     |
| `audit.chain.verify`                                | Verify again                                                                                                                                                                                                                                                                                                                                   |
| `audit.chain.broken`                                | The chain is broken at entry #{n} ({at}). That entry no longer matches the hash recorded for it, so it and the {after} entries after it can’t be trusted as written. This check changed nothing; the entries are shown as stored.                                                                                                              |
| `audit.chain.show` / `.mismatch` / `.unverified`    | Show #{n} / Hash mismatch / Unverified                                                                                                                                                                                                                                                                                                         |
| `audit.filter.*`                                    | Search reasons and targets / Operator / Tenant / Action / When / Writes / Writes & reads / Anyone / Any organization / Any write                                                                                                                                                                                                               |
| `audit.col.*`                                       | When (UTC) / Operator / Action / Target / Reason                                                                                                                                                                                                                                                                                               |
| `audit.detail.*`                                    | Entry / Actor / Action / Target / Reason / Payload / Hash · chained to #{prev}                                                                                                                                                                                                                                                                 |
| `audit.empty.title` / `.body`                       | No entries match these filters / Nothing was recorded for “{query}” by anyone in {period}. Widen the dates, or switch to Writes & reads.                                                                                                                                                                                                       |
| `audit.clear`                                       | Clear filters                                                                                                                                                                                                                                                                                                                                  |

## The audit vocabulary this asset draws (PROPOSED — each owning card adds its members to `PLATFORM_AUDIT_ACTIONS` and ADR §7)

Named by the file's own rule — the domain is the SUBJECT — so they sit beside `org.internal_billing_set`:
`org.credit_grant`, `org.credit_adjust`, `org.plan_set` (MOTIR-747) · `org.suspend`, `org.reactivate`
(MOTIR-748) · `org.kill_switch_off`, `org.kill_switch_on` (MOTIR-750) · `user.impersonation_start`,
`user.impersonation_end` (MOTIR-749; every request inside a session carries the session id in `metadata`) — all
`reason: 'required'` except `user.impersonation_end`, whose reason is the session's. The existing
`org.internal_billing_set/unset` and `ai.planner_model.set` rows are sources the log shows like any other,
not gaps to close (the story's carve-out).

## Allocation — which card builds what this asset draws

| Element                                                                              | Card      |
| ------------------------------------------------------------------------------------ | --------- |
| Grant / adjust / change plan, the ledger read, the large-grant threshold             | MOTIR-747 |
| Org suspend / reactivate, the member-side refusal, the Suspended pill everywhere     | MOTIR-748 |
| View as, the session (mode, time-box, bar, read-only enforcement, ended page)        | MOTIR-749 |
| The switch registry, the per-org store, the evaluation on each request               | MOTIR-750 |
| The hash chain, the verifier, the audit-log page and its filters, the org slice card | MOTIR-751 |
| The Operations tab, the rail row, every rendered state above, en + zh strings        | MOTIR-752 |

## Open questions the asset does not settle (for the owning card, not for the reviewer)

- **Plan change vs Stripe** (MOTIR-747): the dialog promises the Stripe subscription is untouched. Whether the
  next Stripe event then overwrites the manual tier is a rule MOTIR-747 must decide and, if so, say in the warning.
- **Large-grant threshold** (MOTIR-747): 10,000 credits is a proposal.
- **Full-access two-person rule** (MOTIR-749): the ADR names it as possible. The asset draws one operator; a
  second approver would be a new state on Panel 4, not a change to the bar.

## What this amendment deliberately does NOT draw (the deferred future 10.x)

- **Abuse / content moderation** — a trust-and-safety queue beyond the blunt org-suspend lever.
- **DSAR / compliance export and right-to-erasure.**
- **Platform-wide status / maintenance banners** — distinct from the per-session staff bar drawn here.
- **Email-delivery ops** — bounces, complaints, suppression lists.
- **Granting / revoking `platformRole`** (ADR §7's last row, no card yet).
- **The internal-billing classification control** — shipped by MOTIR-4568 (Panel 12); not re-drawn or moved.

---

# AMENDMENT 2026-10-05 — the planning add becomes a picker (MOTIR-7614)

**Amends:** § _AMENDMENT 2026-10-04 — Model lists_ (MOTIR-7523), **Panel 3 (Planning add)** and the
first bullet of its _Where the card and the shipped contracts do not line up_ note. That section and
its mock `console--model-lists.mock.html` are the design result published on MOTIR-7523 (the
published result is the design of record; neither was committed here). **No new mock:** the changed
dialog is the run list's add, **Panel 6 of that same mock**, with the planning copy below, so
drawing it again would be a second copy of a panel the reviewer already has.

**Why it changes.** Panel 3 took a typed model id because _"motir-ai publishes no list of planning
candidates"_. It does now: `GET /v1/planner-model-list` answers `candidates: [{ id, provider }]`
(motir-ai MOTIR-7614) — every servable, chat, planning-rated model not on the list, sorted by provider
then id, judged by the same derivation as the add refusal. So the planning add is the picker the
MOTIR-7523 card asked for, and both lists on the console add the same way.

## Panel 3, redrawn by reference

- **(a) open with one chosen** — Panel 6a: a `Combobox` labelled _Model_ over `candidates`, grouped
  by provider, placeholder _Choose a model_, with the foot line under the options; then the reason
  `Input`; the primary disabled until a model is chosen and the reason is non-blank.
- **(b) refused by motir-ai** — unchanged from the 2026-10-04 Panel 3b: the dialog stays open with the
  reason inline (`--el-danger-on-surface`), nothing added, no audit row. It is still reachable: a
  candidate can stop being plannable between the read and the confirm.
- **(c) nothing addable** — Panel 6b with one difference: the line says every plannable model is
  listed and the dialog shows **no input at all** (neither the picker nor the reason), with the
  primary disabled. There is nothing to give a reason for.

## Copy (the `platformAdmin` namespace, each with a `zh` twin)

| key                            | string                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `planningList.add.modelLabel`  | Model _(was "Model id")_                                                                          |
| `planningList.add.placeholder` | Choose a model                                                                                    |
| `planningList.add.pickerFoot`  | Models the gateway serves that can plan (chat, with a planning rate) and are not on the list yet. |
| `planningList.add.nothing`     | Every model that can plan is already listed.                                                      |

**Retired:** `planningList.add.modelHint` (the picker only offers models that qualify, so the hint
explained a rule the admin can no longer break) and `planningList.add.modelRequired` (a picker cannot
submit a blank id; the action's server-side guard stays and reads as the generic failure line).

## Data and roles

| element      | source                                                                |
| ------------ | --------------------------------------------------------------------- |
| planning add | `candidates[]` of `GET /v1/planner-model-list`, grouped by `provider` |

Colour, shape and roles are Panel 6's: the foot line and the nothing line are `--el-text-secondary`,
the refusal line `--el-danger-on-surface`. Only a superadmin sees **Add model** (unchanged).

---

# AMENDMENT 2026-10-05 — Enterprise requests (MOTIR-7604 · story MOTIR-7602)

**Design system check (first, per the design-system rule).** Read `package.json` (depends on
`@motir/design-system` `workspace:*`) and `app/globals.css` (imports the package's `theme.css`).
**Verdict: the project is on Motir Design** (package `0.8.1`, `packages/design-system/package.json`).
The root layout applies the signed-in person's own `data-style` / `data-palette` / `data-type`, so
there are no fixed project axes: the mock draws the base values and routes every element through a
token. **Nothing the package lacks is needed** — no proposed addition, no product-local component.
`0.8.1` does export `@motir/design-system/mock`; the mock is nonetheless composed the way every
console delta in this area is (below), because the console shell, table and pager it draws are the
console's own markup, which `renderMock`'s parts do not carry, and a reviewer comparing this delta
with its siblings should see one grammar.

**Mock (a DELTA):** [`console--enterprise-requests.mock.html`](console--enterprise-requests.mock.html),
ten panels. **Amends:**

- `console.mock.html` Panel 2 / 13 (the shell): the rail gains one row. The rail is drawn as
  `AdminShell.tsx` ships it TODAY — Platform: Overview · Usage & cost · Tenants · Users; Operations:
  Monitoring · AI planning · Hosted-run models · Planning lessons · (Audit log, superadmin only) —
  not as the older mocks drew it (their reserved `Governance · 10.3` row is gone).
- Panel 7a: the 404, referenced and not redrawn.

The older mocks are records and are not edited.

**Gates:** **MOTIR-7609** — [the page's code](motir:cmuuwiepk00jshwoih49i7zi0) builds it: the rail
row in `app/(admin)/_components/AdminShell.tsx` + `app/(admin)/layout.tsx`, a new list page
at the URL `/admin/enterprise-requests`, a new detail page at `/admin/enterprise-requests/<id>`
(both under `app/(admin)/admin/`, which MOTIR-7609 creates), every state below, en + zh. It renders the
rules of **MOTIR-7608** (`platformEnterpriseRequestService`: `list` / `get` / `transition`, 50 a
page with a total, `ENTERPRISE_REQUEST_STALE`, `enterprise_request.transition` audit rows) on the
record of **MOTIR-7605**.

**Composed, not redrawn.** The token block, primitive CSS and lucide sprite are spliced verbatim
from `console--planning-lessons.mock.html` (itself from `console--ai-planning.mock.html` and
`console.mock.html`). The shell is the shipped `AdminShell.tsx` (the `Sidebar` primitive + the
tint-sky operator bar). The list is the console's `Card` + the shipped `Segmented` as a state filter

- the at-scale table + the cursor pager the audit log ships (Newer / Older). The detail is the
  lessons detail's grammar: `detail-head` with pills, a `kv` card, and a stacked right column. The
  closing confirm is the console's `Modal role="alertdialog"`. The additions block at the end of the
  mock's `<style>` holds only the five state pills, the list cells, the history timeline, the narrow
  frame and nine lucide glyphs (`Inbox`, `Bot`, `ScrollText`, `UserSearch`, `Mail`, `ArrowRight`,
  `CircleX`, `MessageSquare`, `Lock`).

## What this page is

Where platform staff work the **requests organisations send from the Enterprise card's Contact
sales** (the org-side form is the billing delta's, not this asset's). One list across every
organisation, newest first, and a detail per request that shows every answer the org gave, links to
the org's tenant page, records every move, and offers only the legal next state. **Staff-facing
only**: for a non-staff user both routes are the app 404 (Panel 10 → `console.mock.html` Panel 7a).

**No price appears anywhere** on either route. The org's tier at the moment it sent the request
(`tierKeyAtRequest`) is shown as a NAME ("on Team when sent"), never an amount. Setting a tier or
granting credits stays on the tenant page's Operations tab (`console--ops-toolkit.mock.html`); this
page only links there.

## The access path — a new rail row (Panel 1)

**Platform → Enterprise requests**, the LAST row of the Platform group, after **Users**:

- **Icon:** `Inbox` (lucide).
- **Route:** `/admin/enterprise-requests`, active when
  `pathname.startsWith('/admin/enterprise-requests')`, so a request's detail keeps it lit.
- **Visibility:** a LIVE row, visible to **every staff role** (`support` reads the page).
- **Label:** a new `navEnterpriseRequests` beside `navUsers` in `AdminShellLabels`.

It sits in **Platform**, not Operations, because it is a view of the estate's customers — the same
family as Tenants and Users, which it links into — while Operations holds knobs on how the platform
runs (Monitoring, AI planning, Hosted-run models, Planning lessons) and the audit log.

## The roles

| Staff role               | Reads                               | Can move a request                              |
| ------------------------ | ----------------------------------- | ----------------------------------------------- |
| `support`                | the list and every detail (Panel 7) | nothing — no Move-to buttons; one line says why |
| `operator`               | the list and every detail           | every legal edge (Panels 4–5)                   |
| `superadmin`             | the list and every detail           | the same as an operator                         |
| not staff (owners incl.) | the app 404 (Panel 10 → Panel 7a)   | —                                               |

Reads are `requirePlatformStaff('support')`; a move is `operator` and is re-gated in the service —
the missing buttons are presentation, the service is the rule. `support` sits below `operator` in
`PLATFORM_ROLE_LADDER` (`lib/platform/auth.ts`). **Reads are audited**: loading a list page writes
one `estate.read` row, opening a detail writes one — the page line under the title says so.

## The state set

| value        | label (en / zh)       | pill (`--el-*`)                                        | legal next (the Move-to buttons) |
| ------------ | --------------------- | ------------------------------------------------------ | -------------------------------- |
| `new`        | New / 新请求          | `--el-tint-sky` + `--el-text-strong`                   | **Mark contacted** · Mark lost   |
| `contacted`  | Contacted / 已联系    | `--el-tint-lavender` + `--el-text-strong`              | **Mark offer sent** · Mark lost  |
| `offer_sent` | Offer sent / 已发方案 | `--el-tint-yellow` + `--el-text-strong`                | **Mark won** · Mark lost         |
| `won`        | Won / 已成交          | `--el-tint-mint` + `--el-text-strong`                  | none — closed                    |
| `lost`       | Lost / 已流失         | `--el-surface` + `--el-border` + `--el-text-secondary` | none — closed                    |

The edge set is exactly `new → contacted → offer_sent → won`, plus any open state → `lost`. A skip
(`new → won`, `contacted → won`) is never drawn, so the page cannot ask the service for an illegal
edge. **Open** = `new` · `contacted` · `offer_sent`. The forward move is the primary `Button`; Mark
lost is a secondary `Button` with a `CircleX` glyph and `--el-danger-on-surface` ink (≥ 4.77:1 on
the white card in all palettes) — never `--el-danger-text`, which is only for a danger fill.

## The panels (review EACH — mistake #31)

1. **The list, populated.** Inside the shell, the new row active. One `Card`: title _Requests_ with
   the count line (_Newest first. **63 open** — new, contacted or offer sent._), then the state
   filter — a `Segmented` of **Open** (default) · New · Contacted · Offer sent · Won · Lost · All,
   each segment carrying its count — then the table:
   - **Organisation**: name, with _on {tier} when sent_ beneath (omitted when `tierKeyAtRequest` is
     null).
   - **Requester**: name, email beneath.
   - **Sent**: the date, the relative time beneath.
   - **Needs**: work items a day · parallel agents · which agents · runs on its own, joined by `·`; an
     unanswered one reads `{unit} —` in italic `--el-text-secondary`.
   - **State**: the state pill. Then a chevron; the whole row opens the detail.

   The foot: _Newest first · 50 a page_ and the pager — _1–50 of 63_, **Newer** / **Older** by
   cursor (the audit log's shipped grammar), the unavailable direction disabled.

2. **Filtered and paged.** LEFT: Lost chosen; the count line and the pager follow the filter. RIGHT:
   Won chosen with nothing in it — the filter-shaped empty state (`Filter` glyph, _No won
   requests_, **Show open requests**), never the never-any one. BELOW: a later page, _51–63 of 63_,
   Newer live and Older disabled.
3. **States.** (a) **Loading**: the card, its title and the filter paint at once; four skeleton rows;
   no count is guessed — the segments carry none until the read lands. (b) **Empty**: no request has
   ever been sent; no filter to clear. (c) **Error**: the read failed — the console's error card with
   Retry, no rows. A detail whose id does not exist is the app 404 (not redrawn).
4. **Detail, `new`, an operator.** `/admin/enterprise-requests/[id]`. A **Back to requests** link,
   the org name as the page heading, the state pill and _Sent {date}_. LEFT, _The request_: a `kv`
   list of Organisation (with the tier at request), Requester, Contact, Sent, Work items a day, Parallel
   agents, Which agents, Runs on its own, Start, Team size — an unanswered field reads _Not
   answered_ — then the **Note** as a quoted block. Its card head carries **Open {org} in Tenants →**,
   a link to `/admin/tenants/[orgId]`. RIGHT: **Move to** (Panel 5's buttons for this state, with a
   one-line hint), then **History**, oldest first: the request's own _Sent as New_ (by the
   requester) and every applied move as `{from pill} → {to pill}` with _{staff email} · {date,
   time}_.
5. **The controls per state** — the state card only, one cell per value (a–e), exactly the table
   above. The two closed states show a line instead: _Closed as {Won|Lost} on {date}. A closed
   request does not move again. The organisation can send a new one from its Billing page._
6. **A closed request in full** (Won): no controls; three moves by two staff members in History.
7. **A `support` viewer**, on an open (Contacted) request: everything read-only; in the Move-to
   card's place a _State_ card with a `Lock` glyph and the line _Read-only for support. Moving a
   request is an operator's or a superadmin's job; you can read everything here and in the history._
8. **Closing, and a refused move.** LEFT: **Mark won** and **Mark lost** close the request for good,
   so each asks once in an `alertdialog` (_Mark this request lost?_ … Cancel · Mark lost). No reason
   field: the history records who and when, and the move carries no judgement a reason would explain.
   The two open-state moves apply on one press. RIGHT: the **stale refusal**
   (`ENTERPRISE_REQUEST_STALE`): a `--el-tint-yellow` callout (`role="alert"`) — _Not changed —
   someone else moved this request first. {who} marked it **{current state}** a moment ago, so your
   "{action}" was refused and nothing was recorded. The page now shows its current state; choose
   again._ The page RE-READS the request (the page-state-after-mutation contract): the pill, the
   Move-to buttons and the History all show the current state.
9. **`zh` and the narrow reflow (390px).** Below `md` the shipped shell hides the rail; the bar keeps
   the staff marker and drops the inert search. The filter wraps; the table becomes one stacked row
   per request (org + state pill; requester · sent; needs); the pager foot wraps. The detail is one
   column: header, Move to, the request, then History. LEFT: the list in zh. RIGHT: a detail in en.
10. **Not staff** — by reference to `console.mock.html` Panel 7a.

## Copy (en — the `platformAdmin` namespace MOTIR-7609 adds, with a `zh` twin each)

| key                                                                   | en                                                                                                                                                                                                      | zh                                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------- |
| `shell.navEnterpriseRequests`                                         | Enterprise requests                                                                                                                                                                                     | 企业版请求                                                                                                                                  |
| `enterpriseRequests.title`                                            | Enterprise requests                                                                                                                                                                                     | 企业版请求                                                                                                                                  |
| `enterpriseRequests.subtitle`                                         | What organisations sent from the Enterprise card’s Contact sales. Work each request from new to won or lost; every move is recorded with who made it.                                                   | 组织在企业版卡片上点击“联系销售”后发来的请求。在这里跟进每一条请求，直到成交或流失；每次变更都会记录操作人。                                |
| `enterpriseRequests.auditLine`                                        | A request is customer data. Loading this list and opening a request are cross-tenant reads, written to the audit log.                                                                                   | 请求属于客户数据。加载此列表和打开请求均为跨租户读取，会写入审计日志。                                                                      |
| `enterpriseRequests.cardTitle`                                        | Requests                                                                                                                                                                                                | 企业版请求                                                                                                                                  |
| `enterpriseRequests.count.open`                                       | Newest first. {count} open — new, contacted or offer sent.                                                                                                                                              | 最新的在前。{count} 条进行中。                                                                                                              |
| `enterpriseRequests.count.state`                                      | Newest first. {count} {state}.                                                                                                                                                                          | 最新的在前。{count} 条{state}。                                                                                                             |
| `enterpriseRequests.filterLabel`                                      | Filter requests by state                                                                                                                                                                                | 按状态筛选                                                                                                                                  |
| `enterpriseRequests.filter.open` / `.all`                             | Open / All                                                                                                                                                                                              | 进行中 / 全部                                                                                                                               |
| `enterpriseRequests.status.*`                                         | New · Contacted · Offer sent · Won · Lost                                                                                                                                                               | 新请求 · 已联系 · 已发方案 · 已成交 · 已流失                                                                                                |
| `enterpriseRequests.col.*`                                            | Organisation · Requester · Sent · Needs · State                                                                                                                                                         | 组织 · 请求人 · 发送时间 · 需求 · 状态                                                                                                      |
| `enterpriseRequests.tierWhenSent`                                     | on {tier} when sent                                                                                                                                                                                     | 发送时为 {tier}                                                                                                                             |
| `enterpriseRequests.needs.cardsPerDay`                                | {n} items/day                                                                                                                                                                                           | 每天 {n} 个工作项                                                                                                                           |
| `enterpriseRequests.needs.agents`                                     | {n} agents                                                                                                                                                                                              | {n} 个智能体                                                                                                                                |
| `enterpriseRequests.agentPath.*`                                      | Motir-hosted · Their own · Both                                                                                                                                                                         | Motir 托管 · 自有智能体 · 两者                                                                                                              |
| `enterpriseRequests.autonomy.*`                                       | Runs on its own · Volume only · Not sure                                                                                                                                                                | 自主推进 · 仅需产能 · 尚未确定                                                                                                              |
| `enterpriseRequests.startWhen.*`                                      | Now · Within a month · Within a quarter · Just exploring                                                                                                                                                | 立即 · 一个月内 · 一个季度内 · 只是了解                                                                                                     |
| `enterpriseRequests.notAnswered`                                      | Not answered                                                                                                                                                                                            | 未填写                                                                                                                                      |
| `enterpriseRequests.pager.note`                                       | Newest first · 50 a page                                                                                                                                                                                | 最新的在前 · 每页 50 条                                                                                                                     |
| `enterpriseRequests.pager.range`                                      | {from}–{to} of {total}                                                                                                                                                                                  | 第 {from}–{to} 条，共 {total} 条                                                                                                            |
| `enterpriseRequests.pager.newer` / `.older`                           | Newer / Older                                                                                                                                                                                           | 较新 / 较早                                                                                                                                 |
| `enterpriseRequests.empty.title` / `.body`                            | No enterprise requests yet / When an organisation’s owner presses Contact sales on the Enterprise plan, the request lands here and platform staff are emailed.                                          | 还没有企业版请求 / 组织所有者在企业版上点击“联系销售”后，请求会出现在这里，平台员工也会收到邮件。                                           |
| `enterpriseRequests.emptyFilter.title` / `.body` / `.action`          | No {state} requests / No request is {state} right now. / Show open requests                                                                                                                             | 没有{state}的请求 / 目前没有{state}的请求。 / 查看进行中的请求                                                                              |
| `enterpriseRequests.error.title` / `.body`                            | Couldn’t load the requests / Something went wrong reading the requests, so none is shown. Nothing has changed.                                                                                          | 无法加载请求 / 读取请求时出错，因此没有显示任何请求。没有任何更改。                                                                         |
| `enterpriseRequests.detail.back`                                      | Back to requests                                                                                                                                                                                        | 返回请求列表                                                                                                                                |
| `enterpriseRequests.detail.sent`                                      | Sent {date}                                                                                                                                                                                             | 发送于 {date}                                                                                                                               |
| `enterpriseRequests.detail.requestTitle`                              | The request                                                                                                                                                                                             | 请求内容                                                                                                                                    |
| `enterpriseRequests.detail.orgLink`                                   | Open {org} in Tenants                                                                                                                                                                                   | 在租户中打开 {org}                                                                                                                          |
| `enterpriseRequests.detail.field.*`                                   | Organisation · Requester · Contact · Sent · Work items a day · Parallel agents · Which agents · Runs on its own · Start · Team size · Note                                                              | 组织 · 请求人 · 联系方式 · 发送时间 · 每天工作项数 · 并行智能体 · 使用哪种智能体 · 自主推进 · 开始时间 · 团队规模 · 备注                    |
| `enterpriseRequests.move.title`                                       | Move to                                                                                                                                                                                                 | 变更为                                                                                                                                      |
| `enterpriseRequests.move.contacted` / `.offerSent` / `.won` / `.lost` | Mark contacted / Mark offer sent / Mark won / Mark lost                                                                                                                                                 | 标记为已联系 / 标记为已发方案 / 标记为已成交 / 标记为已流失                                                                                 |
| `enterpriseRequests.move.hint.*`                                      | Next: you reached out to the requester. · Next: you sent them an offer. · Next: they accepted — or it is lost. (+ “Won and lost close the request.”)                                                    | 下一步：你已联系请求人。· 下一步：你已发送方案。· 下一步：对方接受，或已流失。（+“成交和流失会关闭请求。”）                                 |
| `enterpriseRequests.closed`                                           | Closed as {state} on {date}. A closed request does not move again. The organisation can send a new one from its Billing page.                                                                           | 已于 {date} 以{state}关闭。关闭的请求不能再变更。该组织可以在其账单页面重新发送请求。                                                       |
| `enterpriseRequests.readOnly`                                         | Read-only for support. Moving a request is an operator’s or a superadmin’s job; you can read everything here and in the history.                                                                        | 支持人员只读。变更请求需由运维人员或超级管理员操作；你可以查看这里和历史中的全部内容。                                                      |
| `enterpriseRequests.confirm.title`                                    | Mark this request {won                                                                                                                                                                                  | lost}?                                                                                                                                      | 将此请求标记为{已成交 | 已流失}？ |
| `enterpriseRequests.confirm.body`                                     | {org}’s request closes as {state} and cannot be moved again. The organisation can send a new request from its Billing page.                                                                             | {org} 的请求将以{state}关闭，且不能再变更。该组织可以在其账单页面重新发送请求。                                                             |
| `enterpriseRequests.stale`                                            | Not changed — someone else moved this request first. {who} marked it {state} a moment ago, so your “{action}” was refused and nothing was recorded. The page now shows its current state; choose again. | 未更改——其他人已先变更了此请求。{who} 刚刚将其标记为{state}，因此你的“{action}”被拒绝，未记录任何内容。页面现在显示其当前状态，请重新选择。 |
| `enterpriseRequests.history.title`                                    | History                                                                                                                                                                                                 | 历史                                                                                                                                        |
| `enterpriseRequests.history.sent`                                     | Sent as New                                                                                                                                                                                             | 以新请求发送                                                                                                                                |

`{who}` in the stale line is the staff email from the newest history entry the re-read returns;
when the re-read has none newer than the viewer's (an unexpected race), the line drops _{who}
marked it … a moment ago_ and reads _It is now **{state}**._

## Data — what each element reads

| element                  | source                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------- |
| list rows, total, cursor | `list(principal, { status, cursor })` — 50 a page, newest first, with a total          |
| segment counts           | the service's per-state count (`countByStatus`); omitted while loading                 |
| detail fields            | `get(principal, id)` — the request DTO (`PlatformEnterpriseRequestDTO`)                |
| history                  | `get(...)`'s history: the `enterprise_request.transition` audit rows, oldest first     |
| org link                 | `/admin/tenants/{orgId}`                                                               |
| Move-to buttons          | the legal edges from the current `status`, and `platformRoleAtLeast(role, 'operator')` |
| stale callout            | `transition` → `ENTERPRISE_REQUEST_STALE` with the current state; then re-`get`        |

## Colour and shape roles (`--el-*` only)

- State pills: the table above — the hue in a `--el-tint-*` background with `--el-text-strong`
  (finding #35); Lost is the neutral pill. Radius `--radius-badge`, padding `--spacing-chip-x/y`.
- Every secondary ink (sub-lines, needs, hints, history meta, the read-only and closed lines, the
  unanswered italic) is `--el-text-secondary` — it lands on the white card and on `--el-surface`
  board chrome alike. `--el-text-faint` carries no text.
- Mark lost: `--el-danger-on-surface` ink on a transparent secondary button with
  `--el-border-strong`. The stale callout: `--el-tint-yellow` + `--el-text-strong`, glyph
  `--el-warning`. The org link and Back link: `--el-link`.
- Buttons `--radius-btn` / `--height-btn-md`; the filter `--radius-btn` + `--height-control`;
  cards `--radius-card` + `--shadow-card`; the confirm `--radius-modal` + `--shadow-modal`; the note
  quote `--radius-control`.

## A11y

- The filter is a `radiogroup` labelled _Filter requests by state_; each segment's count is part of
  its name.
- The skeleton table is `aria-busy`.
- The history's arrow carries `aria-label="to"`, so a move reads _New to Contacted_.
- The confirm is an `alertdialog` with its title as the label; the stale callout is `role="alert"`
  so it is announced on the refused press.
- The read-only line is real text, not a tooltip on a disabled button: support sees no disabled
  control at all.

## What this amendment does NOT draw

- The org's request form and its _Request sent_ state (the billing delta).
- The tenant page it links to (shipped), and any tier-setting or credit-grant control (the tenant's
  Operations tab).
- A reason on a move, an assignee, notes by staff, or reopening a closed request — none is in the
  service's contract.
- Any price.

## Ideas — AMENDMENT 2026-10-07 (MOTIR-7679 · story MOTIR-7664)

**Design system check (first).** The project is on Motir Design (`@motir/design-system`
`workspace:*`, imported by `app/globals.css`); the root layout applies the person's own
`data-style` / `data-palette` / `data-type`, so the mock draws the base values and routes every
element through a token. **Nothing the package lacks is needed.** The mock is composed the way every
console delta in this area is, because the console shell, table and pager are the console's own
markup.

**Mock (a DELTA):** [`console--ideas.mock.html`](console--ideas.mock.html), twelve panels.
**Amends:** `console.mock.html` Panel 2 / 13 (the shell) — the rail gains one row. The rail is drawn
as `AdminShell.tsx` ships it on `main` TODAY (Platform: Overview · Usage & cost · Tenants · Users;
Operations: Monitoring · AI planning · Hosted-run models · Planning lessons · Audit log for a
superadmin). `console--enterprise-requests.mock.html` (MOTIR-7604) adds a Platform row that is not
on `main` yet; the two rows are in different groups and do not interact. Panel 12: the 404, by
reference. The older mocks are records and are not edited.

**Composed, not redrawn.** The token block, primitive CSS and lucide sprite are spliced verbatim
from `console--enterprise-requests.mock.html` (approved). The list is the console's `Card` + the
planning-lessons filter bar (`lookup-field` search, a `Segmented`, three `Combobox` triggers) + the
at-scale table + the pager. The detail is the console's `detail-head` + cards + `kv`. The edit form
is `FormField` + `Input` / `Textarea` / `Segmented` / `Combobox` / `MultiSelectPicker` /
`Checkbox`. Retire and delete are the console's `Modal role="alertdialog"`. The additions block at
the end of the mock's `<style>` holds only the status and kind pills, the list cells, the tag chip,
the evidence list and row editor, the retired box, the role grid, the narrow cards, and six lucide
glyphs (`Lightbulb`, `Trash2`, `Plus`, `X`, `Archive`, `Tag`).

**Gates:** **MOTIR-7680** (the rail row, the list and the read-only detail) and **MOTIR-7681** (edit,
retire, delete). Both build over `ideasAdminService` (`lib/services/ideasAdminService.ts`, MOTIR-7671)
in server actions; nothing here goes through `/api/platform/ideas`.

### What this page is

Where platform staff look over the **idea store** — the ideas motir.co shows under _Ideas to build_ —
and fix one by hand: correct its fields, retire it with a reason, or (a superadmin) delete one that
was a mistake. **It adds no idea**: new ideas come from the `motir-ideas` research skill's batch add,
and the empty state says so. It manages no tag vocabulary (it assigns existing tags only) and shows
no research-run log. Staff-facing only: for a non-staff user both routes are the app 404.

### The access path — a new rail row (Panel 1)

**Operations → Ideas**, directly **after Planning lessons** and before the superadmin's Audit log.

- **Icon:** `Lightbulb` (lucide).
- **Route:** `/admin/ideas`; active when `pathname.startsWith('/admin/ideas')`, so a detail keeps
  it lit. Detail: `/admin/ideas/<slug>` (the slug is the idea's stable, readable id).
- **Visibility:** a LIVE row for **every staff role** (`support` reads the page).
- **Label:** a new `navIdeas` in `AdminShellLabels`, beside `navPlanningLessons`.

It sits in **Operations** beside Planning lessons because both are curated content Motir's own
staff keep, not a view of the estate's customers (the Platform group).

### The roles

| Staff role               | Reads                       | Edit | Retire | Delete |
| ------------------------ | --------------------------- | ---- | ------ | ------ |
| `support`                | the list and every detail   | —    | —      | —      |
| `operator`               | the list and every detail   | ✓    | ✓      | —      |
| `superadmin`             | the list and every detail   | ✓    | ✓      | ✓      |
| not staff (owners incl.) | the app 404 (Panel 12 → 7a) | —    | —      | —      |

A control a role may not use is **absent, not disabled**; support sees one line instead (_Read-only
for support…_). The missing buttons are presentation; the service is the rule.

⚠️ **The service's READS are gated at `operator` today** — `listForStaff`, `getForStaff` and
`listTags` all `assertLevel(actor, 'operator')`. The story asks for `support` to read, so
**MOTIR-7680 lowers those three reads to `support`** (`platformRoleAtLeast(role, 'support')`) and
leaves every write where it is (`operator`; `deleteIdea` at `superadmin`). Without that change a
support viewer gets the page's error state, not a read-only page.

### The value sets (a CHECKLIST — every value is drawn)

| field  | value        | label (en / zh)              | pill (`--el-*`)                                        |
| ------ | ------------ | ---------------------------- | ------------------------------------------------------ |
| status | `active`     | Active / 生效中              | `--el-tint-mint` + `--el-text-strong`                  |
| status | `retired`    | Retired / 已下线             | `--el-surface` + `--el-border` + `--el-text-secondary` |
| kind   | `motir_buys` | Motir would buy / Motir 会买 | `--el-tint-lavender` + `--el-text-strong`              |
| kind   | `direction`  | Direction / 方向             | `--el-tint-sky` + `--el-text-strong`                   |

Category labels are `IDEA_CATEGORY_LABELS` (`lib/ideas/categories.ts`), shown as a neutral pill on
the detail and as text in the list; the Category picker lists them in the enum's grouped order.

### The panels (review EACH)

1. **The list, populated.** Inside the shell, the new row active, an operator. Page title _Ideas_,
   the subtitle and the audited line. One `Card`: title _Ideas_ with _Newest first. **15** shown._,
   the filter bar, the table, the pager foot. Columns: **Idea** (title, slug in mono beneath),
   **Kind** (pill), **Category**, **Tags** (up to three chips, then _+n_), **Status** (pill),
   **Added** (date), a chevron; the whole row opens the detail. All 15 seeded ideas.
2. **Filters.** (a) Category → E-commerce: two rows. (b) + Search _returns_: one row. Every filter
   in force is repeated as a chip that removes only it; **Clear all** resets to the default.
   (c) No match: the filter-shaped empty state with **Clear all filters**. (d) Status → Retired: a
   retired row carries _Retired {date} — "{reason}"_ under its title. (e) A later page.
3. **States.** (a) Loading: card, title and filters paint at once, five skeleton rows, no count.
   (b) Empty store. (c) Error with Retry. An unknown slug is the app 404 (not redrawn).
4. **Detail, operator, an active direction.** Back link, the title as heading, status / kind /
   category pills, and the role's actions (operator: **Edit** · **Retire**). LEFT, _The idea_:
   Pitch, What it does, The gap, Why now — an empty optional field reads in italic (_No capabilities
   listed._ / _Not written._) rather than vanishing; then **Evidence**, numbered in order, each
   claim with source, date and a link out (opens in a new tab). RIGHT: **Tags**, and **Record**
   (slug, added, last edited, last reviewed, whether motir.co shows it).
5. **Kind and status checklists.** (a) A Motir-would-buy idea adds **Why Motir would buy it** and
   **Who else needs it**. (b) Both statuses in a list row and in the detail header.
6. **Edit (operator · superadmin).** **Edit** turns the detail into the form in place. Fields, in
   order: Title (`Input`, counted to 120) · Pitch (`Textarea`, 400) · Kind (`Segmented`) · Category
   (`Combobox`) · Tags (`MultiSelectPicker` over EXISTING tags, at most 6, each option with how many
   ideas carry it; the panel foot says new tags come from the research skill) · What it does
   (ordered lines, up to 8, each 300) · Evidence (rows of Claim · Source · Source date
   `YYYY-MM-DD` or empty · Link; add, remove, move up / down; up to 10; a direction needs one) ·
   The gap · Why now (600 each) · on a `motir_buys` idea also Why Motir would buy it · Who else needs
   it (600 each). On a direction those two are hidden and a line says why; switching Kind shows them
   (and switching back to Direction clears them, because the service refuses them on a direction).
   Foot: **Mark as reviewed today** (`Checkbox`, sends `reviewed: true`) · **Cancel** · **Save
   changes**. No reason field: the audit row's reason is the service's own _Edited in the operator
   console_.
7. **A save refused, then accepted.** (a) `INVALID_IDEA_INPUT`: the form stays open with what was
   typed; a `toast-err` summary (_Not saved — {n} fields need fixing. Nothing was changed._); each
   field its own message in place, in `--el-danger-on-surface`, with `aria-invalid` on the input.
   `UNKNOWN_TAG` (a tag deleted meanwhile) shows on the Tags field the same way. (b) Saved: the form
   closes, a `toast-ok`, and the detail renders the DTO the action returned (new pitch, both
   evidence rows, the new one marked _New_ until the page is left).
8. **Retire (operator · superadmin).** (a) The alertdialog with a REQUIRED reason; **Retire idea**
   is disabled until one is typed. (b) Typed. (c) Retired: Retired pill, no Retire button (Edit
   stays), the **Retired box**: _Retired — {reason}_ and _{date, time} · {who} · no longer on
   motir.co_. (d) `IDEA_NOT_ACTIVE` from a second tab: a `toast-warn` callout (`role="alert"`) and
   the page re-reads the idea, showing (c) beneath it.
9. **Delete (superadmin only).** (a) The header adds **Delete** in danger ink. (b) The alertdialog:
   what is lost, a pointer to Retire, a REQUIRED reason and the slug typed back; the danger button is
   disabled until both are there. (c) Filled. (d) Back on the list with a confirmation; 14 rows.
10. **Roles.** One header per role (support · operator · superadmin), then a support viewer's whole
    detail.
11. **Narrow (390px).** Rail hidden, the bar keeps the staff marker; filters stack; one stacked row
    per idea (title + status; slug; kind · category · added); the detail is one column with
    full-width actions.
12. **Not staff** — by reference to `console.mock.html` Panel 7a.

### Copy (the `platformAdmin.ideas` namespace, with a `zh` twin each)

The console is translated today — every `platformAdmin.*` key has a `zh` twin in `messages/zh.json`
— so the story's "English-only" premise does not match shipped reality; the code cards add both.

| key                                                    | en                                                                                                                                                                                                                                                          | zh                                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.navIdeas`                                       | Ideas                                                                                                                                                                                                                                                       | 创意                                                                                                                                                  |
| `ideas.title`                                          | Ideas                                                                                                                                                                                                                                                       | 创意                                                                                                                                                  |
| `ideas.subtitle`                                       | The ideas motir.co shows under Ideas to build, active and retired. Correct an idea, or retire it with a reason; the research skill adds new ones.                                                                                                           | motir.co“值得做的创意”中展示的创意，包括生效中和已下线的。你可以修改创意，或填写原因将其下线；新创意由研究技能添加。                                  |
| `ideas.auditLine`                                      | Every change is audited. Saving, retiring and deleting each write a row to the audit log with your name. motir.co picks a change up within the hour.                                                                                                        | 每次更改都会被审计。保存、下线和删除都会以你的名义写入审计日志。motir.co 会在一小时内同步更改。                                                       |
| `ideas.count`                                          | Newest first. {count} shown.                                                                                                                                                                                                                                | 最新的在前。显示 {count} 条。                                                                                                                         |
| `ideas.search.label` / `.placeholder`                  | Search / Search title, pitch, gap or tag                                                                                                                                                                                                                    | 搜索 / 搜索标题、简介、空白点或标签                                                                                                                   |
| `ideas.filter.status` / `.kind` / `.category` / `.tag` | Status / Kind / Category / Tag                                                                                                                                                                                                                              | 状态 / 类型 / 分类 / 标签                                                                                                                             |
| `ideas.filter.any*`                                    | Any kind / Any category / Any tag                                                                                                                                                                                                                           | 任意类型 / 任意分类 / 任意标签                                                                                                                        |
| `ideas.filter.all`                                     | All                                                                                                                                                                                                                                                         | 全部                                                                                                                                                  |
| `ideas.filtered` / `.clearAll`                         | Filtered by / Clear all                                                                                                                                                                                                                                     | 筛选条件 / 全部清除                                                                                                                                   |
| `ideas.col.*`                                          | Idea · Kind · Category · Tags · Status · Added                                                                                                                                                                                                              | 创意 · 类型 · 分类 · 标签 · 状态 · 添加时间                                                                                                           |
| `ideas.status.*` / `ideas.kind.*`                      | Active · Retired / Motir would buy · Direction                                                                                                                                                                                                              | 生效中 · 已下线 / Motir 会买 · 方向                                                                                                                   |
| `ideas.retiredLine`                                    | Retired {date} — “{reason}”                                                                                                                                                                                                                                 | {date} 下线——“{reason}”                                                                                                                               |
| `ideas.pager.note` / `.first` / `.next`                | Newest first · 50 a page / First page / Next page                                                                                                                                                                                                           | 最新的在前 · 每页 50 条 / 第一页 / 下一页                                                                                                             |
| `ideas.empty.title` / `.body`                          | No ideas yet / Ideas are added in batches by the motir-ideas research skill, not on this page. Once a batch lands, every idea shows here for review.                                                                                                        | 还没有创意 / 创意由 motir-ideas 研究技能批量添加，而不是在此页面添加。批次添加后，所有创意都会显示在这里以供审阅。                                    |
| `ideas.emptyFilter.title` / `.action`                  | No ideas match these filters / Clear all filters                                                                                                                                                                                                            | 没有符合筛选条件的创意 / 清除所有筛选                                                                                                                 |
| `ideas.error.title` / `.body`                          | Couldn’t load the ideas / Something went wrong reading the idea store, so none is shown. Nothing has changed.                                                                                                                                               | 无法加载创意 / 读取创意库时出错，因此没有显示任何创意。没有任何更改。                                                                                 |
| `ideas.detail.back`                                    | Back to ideas                                                                                                                                                                                                                                               | 返回创意列表                                                                                                                                          |
| `ideas.detail.*` (sections)                            | The idea · Pitch · What it does · The gap · Why now · Why Motir would buy it · Who else needs it · Evidence · Tags · Record                                                                                                                                 | 创意 · 简介 · 功能 · 空白点 · 为什么是现在 · Motir 为什么会买 · 还有谁需要 · 证据 · 标签 · 记录                                                       |
| `ideas.detail.none.*`                                  | No capabilities listed. / Not written.                                                                                                                                                                                                                      | 未列出功能。/ 未填写。                                                                                                                                |
| `ideas.detail.sources`                                 | {n, plural, one {# source} other {# sources}}                                                                                                                                                                                                               | {n} 个来源                                                                                                                                            |
| `ideas.record.*`                                       | Slug · Added · Last edited · Last reviewed · On motir.co · Not yet reviewed · Yes, in {category} · No — retired                                                                                                                                             | 标识 · 添加时间 · 最后编辑 · 最后审阅 · 是否在 motir.co · 尚未审阅 · 是，在{category} · 否——已下线                                                    |
| `ideas.action.edit` / `.retire` / `.delete`            | Edit / Retire / Delete                                                                                                                                                                                                                                      | 编辑 / 下线 / 删除                                                                                                                                    |
| `ideas.readOnly`                                       | Read-only for support. Editing, retiring and deleting ideas is an operator’s or a superadmin’s job.                                                                                                                                                         | 支持人员只读。编辑、下线和删除创意需由运维人员或超级管理员操作。                                                                                      |
| `ideas.edit.title`                                     | Edit idea                                                                                                                                                                                                                                                   | 编辑创意                                                                                                                                              |
| `ideas.edit.field.*`                                   | Title · Pitch · Kind · Category · Tags · What it does · Evidence · The gap · Why now · Why Motir would buy it · Who else needs it                                                                                                                           | 标题 · 简介 · 类型 · 分类 · 标签 · 功能 · 证据 · 空白点 · 为什么是现在 · Motir 为什么会买 · 还有谁需要                                                |
| `ideas.edit.evidence.*`                                | Claim · Source · Source date · Link · YYYY-MM-DD, or empty · Add evidence · Move evidence {n} up · Move evidence {n} down · Remove evidence {n}                                                                                                             | 论据 · 来源 · 来源日期 · 链接 · YYYY-MM-DD，或留空 · 添加证据 · 上移证据 {n} · 下移证据 {n} · 删除证据 {n}                                            |
| `ideas.edit.addLine` / `.limit`                        | Add a line / {n} of {max}                                                                                                                                                                                                                                   | 添加一行 / {n}/{max}                                                                                                                                  |
| `ideas.edit.tags.hint`                                 | Existing tags only · at most 6 · new tags come from the research skill                                                                                                                                                                                      | 仅限已有标签 · 最多 6 个 · 新标签由研究技能添加                                                                                                       |
| `ideas.edit.motirOnly`                                 | Why Motir would buy it and Who else needs it belong to a Motir-would-buy idea only. Switch Kind to show them.                                                                                                                                               | “Motir 为什么会买”和“还有谁需要”仅适用于 Motir 会买的创意。切换类型即可显示。                                                                         |
| `ideas.edit.reviewed`                                  | Mark as reviewed today                                                                                                                                                                                                                                      | 标记为今天已审阅                                                                                                                                      |
| `ideas.edit.cancel` / `.save`                          | Cancel / Save changes                                                                                                                                                                                                                                       | 取消 / 保存更改                                                                                                                                       |
| `ideas.edit.refused`                                   | Not saved — {n, plural, one {one field needs} other {# fields need}} fixing. Nothing was changed. The fields are marked below.                                                                                                                              | 未保存——有 {n} 个字段需要修改。没有任何更改。相关字段已在下方标出。                                                                                   |
| `ideas.edit.saved`                                     | Saved. Your changes show here now and on motir.co within the hour.                                                                                                                                                                                          | 已保存。更改已在此显示，motir.co 会在一小时内同步。                                                                                                   |
| `ideas.retire.title` / `.body`                         | Retire “{title}”? / It leaves motir.co within the hour and moves under Retired here, with your reason. Nothing is deleted.                                                                                                                                  | 下线“{title}”？/ 它会在一小时内从 motir.co 移除，并带着你的原因移到这里的“已下线”中。不会删除任何内容。                                               |
| `ideas.retire.reason` / `.placeholder`                 | Reason — required, shown on the idea and written to the audit log / Why is this idea no longer worth building?                                                                                                                                              | 原因——必填，显示在创意上并写入审计日志 / 为什么这个创意不再值得做？                                                                                   |
| `ideas.retire.confirm`                                 | Retire idea                                                                                                                                                                                                                                                 | 下线创意                                                                                                                                              |
| `ideas.retired.box`                                    | Retired — {reason} / {date, time} · {who} · no longer on motir.co                                                                                                                                                                                           | 已下线——{reason} / {date, time} · {who} · 已不在 motir.co 上                                                                                          |
| `ideas.retire.already`                                 | Not retired — this idea was already retired. Someone retired it while you had the page open, so your reason was not recorded. The page now shows who retired it and why.                                                                                    | 未下线——此创意已被下线。在你打开页面期间有人将其下线，因此你的原因未被记录。页面现在显示了下线人和原因。                                              |
| `ideas.delete.title` / `.body`                         | Delete “{title}” for good? / Deleting removes the idea, its evidence and its tags and cannot be undone. Use it for an idea that was added by mistake; to take a real idea down, retire it instead. The audit log keeps the slug, the title and your reason. | 永久删除“{title}”？/ 删除会移除该创意及其证据和标签，且无法撤销。仅用于误加的创意；要撤下真实的创意，请改为下线。审计日志会保留标识、标题和你的原因。 |
| `ideas.delete.reason` / `.placeholder`                 | Reason — required, written to the audit log / Why is this idea being deleted?                                                                                                                                                                               | 原因——必填，写入审计日志 / 为什么要删除这个创意？                                                                                                     |
| `ideas.delete.typeSlug`                                | Type the slug to confirm: {slug}                                                                                                                                                                                                                            | 输入标识以确认：{slug}                                                                                                                                |
| `ideas.delete.confirm` / `.done`                       | Delete idea / Deleted “{title}”. It is gone from the store and from motir.co; the audit log keeps the record.                                                                                                                                               | 删除创意 / 已删除“{title}”。它已从创意库和 motir.co 中移除；审计日志保留了记录。                                                                      |

**Field messages** — the service's `INVALID_IDEA_INPUT` issues carry a `field` path
(`title`, `pitch`, `evidence[1].url`, …) and an English `message` written for API callers; the page
maps each `field` to its control and shows its own sentence, never the raw message:

| issue field                               | en                                                                                          | zh                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `title` / `pitch`                         | Give the idea a title of at most 120 characters. / Write a pitch of at most 400 characters. | 标题必填，最多 120 个字符。/ 简介必填，最多 400 个字符。 |
| `gap` · `whyNow` · `whyMotir` · `whoElse` | Keep this to 600 characters.                                                                | 最多 600 个字符。                                        |
| `evidence`                                | A direction needs at least one evidence row. / At most 10 rows.                             | 方向类创意至少需要一条证据。/ 最多 10 条。               |
| `evidence[i].claim` / `.sourceName`       | Write the claim (at most 400). / Name the source (at most 200).                             | 请填写论据（最多 400）。/ 请填写来源（最多 200）。       |
| `evidence[i].url`                         | Use a full link that starts with https://.                                                  | 请使用以 https:// 开头的完整链接。                       |
| `evidence[i].sourceDate`                  | Use a real date as YYYY-MM-DD, or leave it empty.                                           | 请使用 YYYY-MM-DD 格式的真实日期，或留空。               |
| `capabilities[i]`                         | Write the line (at most 300), or remove it.                                                 | 请填写这一行（最多 300），或将其删除。                   |
| `tags` / `UNKNOWN_TAG`                    | At most 6 tags. / {tag} is no longer a tag; remove it.                                      | 最多 6 个标签。/ {tag} 已不是标签，请移除。              |
| `reason` (retire, delete)                 | Write a reason (at most 2000 characters).                                                   | 请填写原因（最多 2000 个字符）。                         |

### Data — what each element reads and calls

| element                        | source                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| list rows, next page           | `listForStaff(actor, { status, kind, category, tag, q, cursor })` — 50 a page, newest first, `nextCursor` (no total)                                                                     |
| URL ↔ filters                  | `?q=&status=active\|retired\|all&kind=&category=&tag=&cursor=`; `status` absent = Active; `all` = no status filter; a changed filter drops `cursor`                                      |
| Tag picker, Tag filter options | `listTags(actor)` — label + count of ideas of any status                                                                                                                                 |
| detail                         | `getForStaff(actor, slug)` — `StaffIdeaDto`                                                                                                                                              |
| Retired box — who              | the idea's newest `idea.retire` row in `PlatformAuditLog` (`targetKind: 'idea'`, `targetId`); `StaffIdeaDto` carries reason and date but no actor, so MOTIR-7680 reads it beside the DTO |
| save                           | `updateIdea(actor, slug, patch)` — sends only the changed fields; `reviewed: true` when ticked                                                                                           |
| retire                         | `retireIdea(actor, slug, reason)`; `IDEA_NOT_ACTIVE` → Panel 8d + re-read                                                                                                                |
| delete                         | `deleteIdea(actor, slug, reason)` (superadmin); then redirect to the list with the confirmation                                                                                          |
| the actor                      | the console session → `IdeaActor` with `credential: session`, so every audit row reads `session`                                                                                         |

Two edits racing on one idea are **last write wins** — `updateIdea` has no version check, and this
asset draws no stale-edit refusal. A concurrent retire is the one race the page shows (8d).

### Allocation — which card builds what

| element                                                                                                                                                                                                                              | card           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| rail row (`AdminShell.tsx`, `navIdeas`), list page, filters + URL, pager, loading / empty / error, read-only detail (Panels 1–5, 10’s support view, 11), lowering the three service reads to `support`                               | **MOTIR-7680** |
| the Edit / Retire / Delete buttons by role, the edit form, field errors, save confirmation, retire dialog + Retired box + already-retired callout, delete dialog + post-delete list (Panels 6–9, 10’s operator / superadmin headers) | **MOTIR-7681** |

### Colour and shape roles (`--el-*` only)

- Pills: the value-set table above (hue in a `--el-tint-*` background with `--el-text-strong`); the
  category is `pill-neutral`. Radius `--radius-badge`, padding `--spacing-chip-x/y`.
- Every secondary ink (slugs aside, which are `--el-text-identifier`) is `--el-text-secondary`: the
  count line, the retired note, the tag chips (on `--el-surface-soft`), the Record keys, the
  unwritten-field italic, the read-only line. `--el-text-faint` and `--el-text-muted` carry no text
  this asset adds.
- Field errors and the Delete button's ink: `--el-danger-on-surface` (never `--el-danger-text`); the
  dialog's **Delete idea** is the `Button` danger variant (`bg-(--el-danger) text-(--el-danger-text)`).
  Retire is a secondary button with `--el-text`: retiring is the normal end of an idea, not a danger.
- Callouts: saved `--el-tint-mint`, refused `--el-tint-rose`, already-retired `--el-tint-yellow`, all
  with `--el-text-strong`. The Retired box is `--el-surface-soft` with `--el-border`. Links:
  `--el-link`.
- Buttons `--radius-btn` / `--height-btn-md` (row tools `--height-btn-sm` + `--radius-control`);
  inputs `--radius-input` / `--height-input`; cards and evidence rows `--radius-card`; dialogs
  `--radius-modal` + `--shadow-modal`.

### A11y

- The filter bar is `role="search"` labelled _Filter ideas_; Status is a `radiogroup`.
- The skeleton table is `aria-busy`.
- Each evidence-row tool has its own label (_Move evidence 2 up_, _Remove evidence 2_); a disabled
  move (first row up, last row down) is `aria-disabled`.
- A refused field sets `aria-invalid` and its message is linked with `aria-describedby`; the summary
  callout is `role="alert"`, and focus moves to the first invalid field.
- Retire and delete are `alertdialog`s labelled by their title; the already-retired callout is
  `role="alert"`; the save and delete confirmations are `role="status"`.
- The support line is real text, not a tooltip on a disabled button.
- An evidence link out opens in a new tab and says so to assistive tech (_opens in a new tab_).

### What this amendment does NOT draw

- Adding an idea by hand (the research skill's batch add), un-retiring one (no service method),
  creating or editing tags, and the research-run log.
- What motir.co shows after a change (MOTIR-7665), and any cache purge — the hourly revalidate is the
  agreed bound, which the page states.
- A stale-edit refusal (the service has none; last write wins).

---

# AMENDMENT 2026-10 — Fleet settings · Motir CI on the fleet (MOTIR-8703 · story MOTIR-8699)

**Design system check (first, per the design-system rule).** The project is on Motir Design
(`@motir/design-system` `workspace:*`, `app/globals.css` imports its `theme.css`), so the page is
drawn from that system's `--el-*` / shape tokens and its shipped primitives. Nothing the package
lacks is needed — no proposed addition, no product-local component.

**Mock (a DELTA):** [`console--fleet-settings.mock.html`](console--fleet-settings.mock.html),
thirteen states in fourteen frames (2 is drawn twice, as the card asks; 5 carries a 5b inset).
**Amends:** `console.mock.html` Panel 2 (the shell — one rail row is added), Panel 7a (the 404,
referenced and not redrawn) and Panel 11 (the confirm-with-mandatory-reason grammar, reused for a
third write after the classification control and AI planning). No existing mock is edited.
**Gates:** the **/admin setting UI** card of story MOTIR-8699, which is `blocked_by` MOTIR-8703 and
builds to the published result (`design-result.md` AMENDMENT 5 Q1). It builds on **MOTIR-8713**
(`lib/services/fleetReadinessService.ts`, the readiness verdict) and **MOTIR-8714**
(`lib/services/fleetOrgCiSettingService.ts` + `lib/dto/fleetOrgCiSetting.ts`, the setting and its
flip), both already merged into this worktree.

**Composed, not redrawn.** The token block, primitive CSS and lucide sprite are spliced verbatim
from `console.mock.html` by way of `console--ai-planning.mock.html` (the closest sibling: a
superadmin platform setting with a reason confirm). The rail is `AdminShell.tsx` as it stands on
`main` — Platform: Overview · Usage & cost · Tenants · Users · Enterprise requests; Operations:
Monitoring · **Fleet settings** · AI planning · Hosted-run models · Planning lessons · Ideas · Audit
log — not the older mocks' rail with its reserved `Governance · 10.3` row. The additions block at the
end of the mock's `<style>` holds only the `Switch` (as `Switch.tsx` renders it), the setting and
readiness layout, and eight Tier-3 tokens the point-in-time block predates (`--el-text-identifier`,
`--el-icon-muted`, `--el-danger-on-surface`, `--el-switch-on`, `--el-switch-on-border`,
`--el-switch-off-border`, `--el-switch-knob`, `--el-switch-knob-off`), each spelled exactly as
`packages/design-system/theme.css` defines it.

## ⚠️ Where the card and this asset differ (shipped code wins — each recorded, not papered over)

1. **NINE conditions, not six.** The card lists six; the verdict MOTIR-8713 actually built produces
   nine, in this order, each `met | unmet | unknown` with an English `message`, a `reasonCode` and
   `params`: `kill_switch`, `app_installed`, `app_runner_permission`, `app_variables_permission`,
   `workflow_job_subscription`, `app_repositories`, `delivery_attributable`, `runner_group`,
   `image_coverage`. The card's own scope boundary says the design follows the readiness card when
   the sets differ, so the readiness card draws nine rows. The card's six map onto 1, 3, 4, 5, 8
   and 9; `app_installed`, `app_repositories` and `delivery_attributable` are the three the card did
   not name.
2. **"Could not check" is `unknown`, and it is produced.** The card asked the readiness card to
   produce it or say why it cannot occur. It is produced: a failed GitHub read is `unknown` with
   reason `read_failed` (and the HTTP status in `params.status`), and when `app_installed` is not
   `met` every condition read through the installation (`app_runner_permission`,
   `app_variables_permission`, `workflow_job_subscription`, `app_repositories`,
   `delivery_attributable`, `image_coverage`) is `unknown` with reason `app_not_readable`.
   `ready` is true only when all nine are `met`, so an unknown blocks ON — drawn as **Couldn't
   check**, counted as not met.
3. **The verdict's count says "not met", not "unmet".** The card's _Not ready — N conditions unmet_
   would call an unknown "unmet", which the service deliberately does not. The header reads
   _Not ready — {n} conditions not met_ and a second line splits it (_{unmet} unmet · {unknown}
   couldn't be checked_).
4. **The setting is per (project, org) pair.** `fleetOrgCiSettingService` stores one row per
   `(projectId, org)` and `listTargets` returns every pair the console offers. Today that is one
   pair, project **MOTIR** × **moooon-B-V**, which is what the mock draws; the card's subtitle line
   names the pair (_Project MOTIR · GitHub organisation moooon-B-V_). If `listTargets` ever returns
   several, the page repeats the setting card + readiness card per pair, in `listTargets` order.
5. **Three repositories, not seven.** The card says _today's seven_. Of Motir's seven repositories
   on `moooon-B-V`, only **motir-ai, motir-gateway and motir-meta are private**; motir-core,
   motir-marketing, motir-skills and nextjs-prisma-vercel-starter are public
   (`docs/research/fleet-job-inventory.md`, summary table), and the fleet only ever serves private
   repositories (the runner group access-lists private repositories only, and every readiness
   condition considers the private set). The mock lists the three as examples, says the list is read
   at runtime from project MOTIR's private `moooon-B-V` repositories, and the ON confirm says
   _3 repositories_.
6. **The write-failed sentence carries a status, not a cause.** The card's example (_…the App lacks
   Variables (write) on moooon-B-V_) names a cause; `FleetOrgCiGithubWriteError` carries only the
   org, the HTTP status (`null` when GitHub was unreachable) and the operation (`read` / `set` /
   `delete`). The page therefore says what GitHub answered (_GitHub refused to set MOTIR_RUNNER on
   moooon-B-V (HTTP 403)_) and does not guess why. A missing Variables permission is in any case
   caught earlier, by condition 4, before ON writes anything.
7. **Extra read-back the card did not ask for: the GitHub variable.** `getState` returns the
   `MOTIR_RUNNER` variable read back from GitHub (`present` / `absent` / `unknown`), so the setting
   card carries a **GitHub variable** line, and a **drift** warning when the stored state and the
   variable disagree. Drift is folded into Panel 5 as inset 5b rather than drawn as a fourteenth
   state.
8. **The stored last reason is shown.** The row stores the last flip's reason (`lastReason`), so the
   _Last changed_ line quotes it without an audit read.
9. **No `.png` export.** The card asks for `console--fleet-settings.png`; CLAUDE.md and
   `docs/decisions/design-result.md` AMENDMENT 4 retired exports (the mock renders on the card), so
   none is produced.
10. **`Switch`, not `SwitchRow`.** The card names both. `SwitchRow` drops its label and hint to
    `--el-text-faint` when disabled, which would grey out the setting's title and explanation in
    exactly the not-ready frames where they matter most. The page uses the `Switch` primitive with
    `aria-labelledby` pointing at the card title, and keeps the title and explanation at full ink;
    the disabled state is carried by the switch's own `disabled` and the reason sentence beside it.

## What this page is

The home of one platform setting, **Run Motir's private repositories' CI on the fleet**. Its stored
row is the operator's INTENT; the org's `MOTIR_RUNNER` Actions variable is its EFFECT. ON writes the
variable (`motir-runner`, private repositories) so
`runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}` sends every new job in Motir's private
repositories to the shared `motir-fleet` machines, attributed to moooon B.V.; OFF deletes it, so the
same expression falls back to GitHub-hosted runners. No workflow file changes either way, and
running jobs are untouched: the variable only changes what NEW jobs request. **ON is allowed only
when the readiness verdict is ready. OFF never reads readiness** — it is also the recovery path when
the fleet breaks. Every flip needs a reason and writes one audit row.

## The access path — a new rail row (Panels 1 · 13)

**Operations → Fleet settings**, directly after **Monitoring** and before **AI planning**, icon
`ServerCog` (lucide, the shipped set's server family beside Monitoring's `Server`), route
**`/admin/fleet-settings`**, active when `pathname === '/admin/fleet-settings'`, label
`platformAdmin.shell.navFleetSettings`. It sits next to Monitoring so the fleet's read surface sits
beside its one write. It follows the **Audit log** row's rule, not Monitoring's: the row is added
only when `operator.role === 'superadmin'`, and is ABSENT for `support` and `operator`.

The page carries the reverse link: _Motir's machines appear under moooon B.V. in Monitoring ›
Fleet_, to `/admin/monitoring` (the Fleet section of MOTIR-7314, linked, not redrawn).

## The roles

| Staff role                                 | Rail row | `/admin/fleet-settings`                               |
| ------------------------------------------ | -------- | ----------------------------------------------------- |
| `superadmin`                               | present  | reads the setting and the verdict, and flips it       |
| `operator`                                 | absent   | the app 404 (Panel 13 → `console.mock.html` Panel 7a) |
| `support`                                  | absent   | the app 404 (Panel 13 → Panel 7a)                     |
| not platform staff (an org owner included) | —        | the app 404, as for every `/admin/*` route            |

Both `getState` and `setEnabled` are `requirePlatformStaff('superadmin')`
(`NotPlatformStaffError` below it, before any GitHub call), so the page has no read-only face: a
role that cannot write cannot read either. The page maps `NotPlatformStaffError` to `notFound()`.

## The panels (review EACH — mistake #31)

| #   | State                               | What is drawn                                                                                                                                                                                                                                                                                                                                                                                                                                 | Source                                                                                                                          |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **OFF · ready**                     | Inside the shell, rail row active. The setting card (title, pair, explanation, switch OFF + _Off_ chip + _Turn on_, last changed with its reason and audit-log link, GitHub variable _not set_, the three repositories, the Monitoring line) and the readiness card with all nine **Met** and the verdict **Ready**. The switch is enabled.                                                                                                   | card § States 1; MOTIR-8713 (nine conditions); MOTIR-8714 DTO (`updatedBy`, `lastReason`, `variable`)                           |
| 2a  | **OFF · not ready — one unmet**     | `runner_group` **Not met** (`sync_pending`) with its sentence. Verdict _Not ready — 1 condition not met · 1 unmet_. The switch is DISABLED and the reason sits beside it in words: _Can't turn on until every condition is met._ The title and explanation stay at full ink.                                                                                                                                                                  | card § States 2; `runnerGroupCondition` reason `sync_pending`                                                                   |
| 2b  | **OFF · not ready — several unmet** | `app_variables_permission` (`permission_missing`), `workflow_job_subscription` (`not_subscribed`) and `image_coverage` (`jobs_not_runnable`) **Not met**; image coverage EXPANDED to its jobs as _repo · workflow · job — missing tool_ / _can't be hosted: reason_, then the scope line. The three jobs are the real ones in `lib/ciFleet/fleetJobInventory.json` for the private set today. Past five, the list stops and ends _+{n} more_. | card § States 2; `permissionCondition`, condition 5, `imageCoverageCondition` and its `params.jobs`                             |
| 3   | **OFF · couldn't check**            | `app_installed` **Couldn't check** (`read_failed`, HTTP 502) and the six conditions read through the installation **Couldn't check** (`app_not_readable`); `kill_switch` and `runner_group` still **Met**. Verdict _Not ready — 7 conditions not met · 7 couldn't be checked_; switch disabled. The GitHub variable line says it could not be read. Fails closed: nothing unknown is drawn as met.                                            | card § States 3; MOTIR-8713's `failedRead` + the `app_not_readable` branch; MOTIR-8714 `variable.state === 'unknown'`           |
| 4   | **ON · ready**                      | Switch ON, _On_ chip (mint), _Turn off_. The variable reads back `MOTIR_RUNNER = motir-runner`. The Monitoring link is PROMINENT: a sky callout under the switch, _Open Monitoring › Fleet_.                                                                                                                                                                                                                                                  | card § States 4                                                                                                                 |
| 5   | **ON · degraded**                   | `kill_switch` **Not met** (`kill_switch_engaged`) after the setting went on. A warning band under the switch: _New jobs will queue until this is fixed or the setting is turned off._ The switch stays ENABLED, with _Turning off never waits on readiness._ beside it. **5b (inset): drift** — stored ON, variable read back ABSENT, with its warning band.                                                                                  | card § States 5; MOTIR-8714 (OFF never reads readiness; `variable` read-back)                                                   |
| 6   | **Confirm ON**                      | Panel 11's dialog: `Modal role="alertdialog"`, a reason `Input`, primary _Turn on_. Names **Off → On**, the 3 repositories and moooon B.V.'s pool.                                                                                                                                                                                                                                                                                            | card § States 6; MOTIR-8714 (`fleet.org_ci.enable`, reason `required`)                                                          |
| 7   | **Confirm OFF**                     | The same dialog for **On → Off**: new jobs go back to GitHub-hosted runners; jobs already on the fleet finish there; turning off never waits on readiness. Primary _Turn off_.                                                                                                                                                                                                                                                                | card § States 7; MOTIR-8714 (`fleet.org_ci.disable`)                                                                            |
| 8   | **Reason missing**                  | (a) empty reason — the primary is DISABLED (the console's rule: not a post-submit error); (b) a blank (spaces-only) reason that reached the server — `MissingAuditReasonError` — shown inline in the dialog under the field, the dialog stays open, nothing changed.                                                                                                                                                                          | card § States 8; `assertReasonSatisfied` → `MissingAuditReasonError`                                                            |
| 9   | **Already in that state**           | The flip answered `{ outcome: 'unchanged' }` (another superadmin flipped it first). The page shows the CURRENT state, an INFO note (sky, info glyph — not an error): _Already on — nothing changed._, and the last-changed line names who did it.                                                                                                                                                                                             | card § States 9; MOTIR-8714 `FleetOrgCiFlipDTO.outcome` (both the pre-read and the `UnchangedUnderLock` path answer it)         |
| 10  | **GitHub write failed**             | `FleetOrgCiGithubWriteError`: _Not turned on: GitHub refused to set MOTIR_RUNNER on moooon-B-V (HTTP 403)._ then _Nothing changed: the setting and the GitHub variable are as they were._ (rose callout, `role="alert"`). The switch shows its PREVIOUS state (OFF), still enabled.                                                                                                                                                           | card § States 10; MOTIR-8714 (GitHub write inside the audited transaction, rolled back; compensation restores the variable)     |
| 11  | **Not ready at flip time**          | `FleetOrgCiNotReadyError` lists every condition not met; the refusal names them (_Not met now: App permission: Variables (write)._), the readiness card re-reads (_Checked again just now_) and shows the same, and the switch is disabled again with its reason.                                                                                                                                                                             | card § States 11; MOTIR-8714 (readiness re-read inside `setEnabled`, thrown before any write)                                   |
| 12  | **Read failed**                     | The console's error card (Panel 7's) with **Retry**, and NO switch and NO verdict.                                                                                                                                                                                                                                                                                                                                                            | card § States 12; MOTIR-8714 (`listTargets`' `FleetOrgCiGithubWriteError('read')`, or a failed stored-state read in `getState`) |
| 13  | **Not superadmin**                  | The rail as `operator` / `support` see it — no Fleet settings row (and no Audit log row, the precedent) — and the 404 by reference to Panel 7a.                                                                                                                                                                                                                                                                                               | card § States 13; area _Roles_                                                                                                  |

No loading skeleton is drawn: the page is a server-rendered read (the card's instruction). The
readiness read does GitHub round trips, so if the build streams the readiness card it does so with an
in-page `<Suspense>` after the page's own 404 gate, never a `loading.tsx` (CLAUDE.md § _A
`loading.tsx` may NOT sit above a route that decides existence_ — this route 404s).

## The nine conditions — labels and sentences

The UI renders `reasonCode` (+ `params`), never the service's English `message` (MOTIR-8713's own
comment: _"The UI renders `reasonCode`"_). The sentences below are the catalogue's, written from those
messages; each unmet sentence says what is wrong and who fixes it.

| #   | key                         | label                                | reason codes it can show (state)                                                                                                          |
| --- | --------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `kill_switch`               | Fleet kill switch                    | `kill_switch_off` (met) · `kill_switch_engaged` (unmet)                                                                                   |
| 2   | `app_installed`             | App installed                        | `app_installed` (met) · `app_not_installed`, `app_suspended` (unmet) · `read_failed` (unknown)                                            |
| 3   | `app_runner_permission`     | App permission: Self-hosted runners  | `granted` · `permission_missing`, `permission_insufficient` · `app_not_readable`                                                          |
| 4   | `app_variables_permission`  | App permission: Variables (write)    | `granted` · `permission_missing`, `permission_insufficient` · `app_not_readable`                                                          |
| 5   | `workflow_job_subscription` | `workflow_job` delivery              | `subscribed` · `not_subscribed` · `app_not_readable`                                                                                      |
| 6   | `app_repositories`          | App reaches the repositories         | `all_reachable` · `repositories_not_granted`, `no_private_repositories` · `read_failed`, `app_not_readable`                               |
| 7   | `delivery_attributable`     | Jobs attributed to project {project} | `attributable` · `not_attributable`, `no_private_repositories` · `read_failed`, `app_not_readable`                                        |
| 8   | `runner_group`              | Runner group                         | `group_synced` · `no_runner_group`, `sync_pending` · `read_failed`                                                                        |
| 9   | `image_coverage`            | Image coverage                       | `all_runnable` · `jobs_not_runnable`, `not_inventoried`, `inventory_stale`, `no_private_repositories` · `read_failed`, `app_not_readable` |

A met row shows only its mark and label. An unmet or unknown row adds one sentence (`cond.*` below).

**⚠️ Observed while drawing (recorded, not fixed here):** the checked-in inventory marks
`motir-gateway`'s `macos-release.yml · release` and `windows-release.yml · release` as
`cannot-host`, and `imageCoverageCondition` counts every non-runnable job, `cannot-host` included.
So against today's data, image coverage is **Not met** and the verdict can never be Ready while
motir-gateway's private set carries those two jobs. Panel 1's _Ready_ is drawn as the target state;
Panel 2b draws today's real image-coverage row. Whether a `cannot-host` job should block readiness
(it can never run on the fleet, and will keep requesting `motir-runner` once the variable is set
unless its `runs-on` names its OS) is a question for the readiness card's owner, not for this design.

## Copy (en — the `platformAdmin` namespace the setting UI card adds, with a `zh` twin each)

Interpolated values are in `{braces}`. Repository names, org logins, emails and reasons are data,
never catalogue strings.

| key                                                  | string                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.navFleetSettings`                             | Fleet settings                                                                                                                                                                                                                                 |
| `fleetSettings.breadcrumb`                           | Operations · Fleet settings                                                                                                                                                                                                                    |
| `fleetSettings.title`                                | Fleet settings                                                                                                                                                                                                                                 |
| `fleetSettings.subtitle`                             | Where a superadmin decides whose CI runs on Motir's own machines. Every change asks for a reason and is written to the audit log.                                                                                                              |
| `fleetSettings.setting.title`                        | Run Motir's private repositories' CI on the fleet                                                                                                                                                                                              |
| `fleetSettings.setting.pair`                         | Project {project} · GitHub organisation {org}                                                                                                                                                                                                  |
| `fleetSettings.setting.superadminOnly`               | Superadmin only                                                                                                                                                                                                                                |
| `fleetSettings.setting.explanation`                  | When on, every CI job in Motir's private repositories on {org} requests the {label} label and runs on the shared {fleet} machines, attributed to moooon B.V. When off, they run on GitHub-hosted runners. No workflow file changes either way. |
| `fleetSettings.state.on`                             | On                                                                                                                                                                                                                                             |
| `fleetSettings.state.off`                            | Off                                                                                                                                                                                                                                            |
| `fleetSettings.action.turnOn`                        | Turn on                                                                                                                                                                                                                                        |
| `fleetSettings.action.turnOff`                       | Turn off                                                                                                                                                                                                                                       |
| `fleetSettings.blocked`                              | Can't turn on until every condition is met.                                                                                                                                                                                                    |
| `fleetSettings.offNeverBlocked`                      | Turning off never waits on readiness.                                                                                                                                                                                                          |
| `fleetSettings.meta.lastChanged`                     | Last changed                                                                                                                                                                                                                                   |
| `fleetSettings.meta.changedBy`                       | by {email}, {when} — “{reason}”                                                                                                                                                                                                                |
| `fleetSettings.meta.neverChanged`                    | Never changed                                                                                                                                                                                                                                  |
| `fleetSettings.meta.auditLink`                       | Audit log                                                                                                                                                                                                                                      |
| `fleetSettings.meta.variable`                        | GitHub variable                                                                                                                                                                                                                                |
| `fleetSettings.variable.present`                     | {name} = {value} on {org} (private repositories) — new jobs request the fleet.                                                                                                                                                                 |
| `fleetSettings.variable.absent`                      | {name} is not set on {org} — jobs fall back to GitHub-hosted runners.                                                                                                                                                                          |
| `fleetSettings.variable.unknown`                     | Couldn't read {name} on {org} — GitHub answered HTTP {status}.                                                                                                                                                                                 |
| `fleetSettings.variable.unreachable`                 | Couldn't read {name} on {org} — GitHub could not be reached.                                                                                                                                                                                   |
| `fleetSettings.drift.onAbsent.title`                 | Stored on, but GitHub disagrees.                                                                                                                                                                                                               |
| `fleetSettings.drift.onAbsent.body`                  | {name} is not set on {org}, so new jobs still run on GitHub-hosted runners. Turn the setting off and on again to write it.                                                                                                                     |
| `fleetSettings.drift.offPresent.title`               | Stored off, but GitHub disagrees.                                                                                                                                                                                                              |
| `fleetSettings.drift.offPresent.body`                | {name} is still set on {org}, so new jobs still request the fleet. Turn the setting on and off again to remove it.                                                                                                                             |
| `fleetSettings.meta.repositories`                    | Repositories                                                                                                                                                                                                                                   |
| `fleetSettings.repositories.count`                   | {count, plural, one {# private repository} other {# private repositories}}, read at runtime from project {project}'s private repositories on {org}                                                                                             |
| `fleetSettings.monitoringLine`                       | Motir's machines appear under moooon B.V. in Monitoring › Fleet                                                                                                                                                                                |
| `fleetSettings.onCallout.title`                      | Motir's CI is on the fleet.                                                                                                                                                                                                                    |
| `fleetSettings.onCallout.link`                       | Open Monitoring › Fleet                                                                                                                                                                                                                        |
| `fleetSettings.degraded.title`                       | Not ready while on.                                                                                                                                                                                                                            |
| `fleetSettings.degraded.body`                        | New jobs will queue until this is fixed or the setting is turned off.                                                                                                                                                                          |
| `fleetSettings.readiness.title`                      | Readiness                                                                                                                                                                                                                                      |
| `fleetSettings.readiness.subtitle`                   | Nine conditions, in the order a job meets them. A condition that couldn't be checked counts as not met.                                                                                                                                        |
| `fleetSettings.readiness.ready`                      | Ready                                                                                                                                                                                                                                          |
| `fleetSettings.readiness.readySub`                   | All {count} conditions met                                                                                                                                                                                                                     |
| `fleetSettings.readiness.notReady`                   | Not ready — {count, plural, one {# condition} other {# conditions}} not met                                                                                                                                                                    |
| `fleetSettings.readiness.unmetCount`                 | {count} unmet                                                                                                                                                                                                                                  |
| `fleetSettings.readiness.unknownCount`               | {count} couldn't be checked                                                                                                                                                                                                                    |
| `fleetSettings.readiness.checked`                    | Checked {when}                                                                                                                                                                                                                                 |
| `fleetSettings.readiness.checkedAgain`               | Checked again {when}                                                                                                                                                                                                                           |
| `fleetSettings.readiness.recheck`                    | Check again                                                                                                                                                                                                                                    |
| `fleetSettings.mark.met`                             | Met                                                                                                                                                                                                                                            |
| `fleetSettings.mark.unmet`                           | Not met                                                                                                                                                                                                                                        |
| `fleetSettings.mark.unknown`                         | Couldn't check                                                                                                                                                                                                                                 |
| `fleetSettings.cond.kill_switch.label`               | Fleet kill switch                                                                                                                                                                                                                              |
| `fleetSettings.cond.app_installed.label`             | App installed                                                                                                                                                                                                                                  |
| `fleetSettings.cond.app_runner_permission.label`     | App permission: Self-hosted runners                                                                                                                                                                                                            |
| `fleetSettings.cond.app_variables_permission.label`  | App permission: Variables (write)                                                                                                                                                                                                              |
| `fleetSettings.cond.workflow_job_subscription.label` | `workflow_job` delivery                                                                                                                                                                                                                        |
| `fleetSettings.cond.app_repositories.label`          | App reaches the repositories                                                                                                                                                                                                                   |
| `fleetSettings.cond.delivery_attributable.label`     | Jobs attributed to project {project}                                                                                                                                                                                                           |
| `fleetSettings.cond.runner_group.label`              | Runner group                                                                                                                                                                                                                                   |
| `fleetSettings.cond.image_coverage.label`            | Image coverage                                                                                                                                                                                                                                 |
| `fleetSettings.why.kill_switch_engaged`              | The fleet kill switch is engaged ({variable}=0), so no fleet machine boots. An operator unsets or raises it.                                                                                                                                   |
| `fleetSettings.why.app_not_installed`                | The motir-studio App is not installed on {org}. An owner of {org} installs it.                                                                                                                                                                 |
| `fleetSettings.why.app_suspended`                    | The motir-studio App on {org} has been suspended since {date}. An owner of {org} unsuspends it.                                                                                                                                                |
| `fleetSettings.why.permission_missing`               | The motir-studio App on {org} holds {permission}: none, and needs write. An owner of {org} accepts the permission request.                                                                                                                     |
| `fleetSettings.why.permission_insufficient`          | The motir-studio App on {org} holds {permission}: {granted}, and needs write. An owner of {org} accepts the permission request.                                                                                                                |
| `fleetSettings.why.not_subscribed`                   | The App is not subscribed to workflow_job events, so GitHub never tells Motir a job is queued. Whoever administers the motir-studio App subscribes it in the App's settings.                                                                   |
| `fleetSettings.why.repositories_not_granted`         | The App's installation on {org} does not reach {repositories}. An owner of {org} adds them to the installation's repository access.                                                                                                            |
| `fleetSettings.why.no_private_repositories`          | Project {project} has no private repository in {org}, so there is nothing for the fleet to run.                                                                                                                                                |
| `fleetSettings.why.not_attributable`                 | A queued job from {repositories} would not be attributed to project {project}, so it would stay queued until GitHub expires it. Reconnect the repository to the project so its mirror row is current.                                          |
| `fleetSettings.why.no_runner_group`                  | Project {project} has no runner group in {org}. An operator runs {script} --project {project}.                                                                                                                                                 |
| `fleetSettings.why.sync_pending`                     | The project's runner group in {org} is out of sync with its repositories. An operator runs {script} --project {project}.                                                                                                                       |
| `fleetSettings.why.jobs_not_runnable`                | {count, plural, one {# job} other {# jobs}} can't run on the fleet runner image yet. Whoever maintains the fleet image adds the missing tool; a job that needs another operating system stays unrunnable until it leaves the private set.      |
| `fleetSettings.why.not_inventoried`                  | {repositories} {count, plural, one {is} other {are}} not in the fleet job inventory, so nobody has checked the runner image can run {count, plural, one {its} other {their}} jobs. Whoever maintains the inventory re-runs it.                 |
| `fleetSettings.why.inventory_stale`                  | The workflows of {repositories} changed after the fleet job inventory measured them. Whoever maintains the inventory re-runs it.                                                                                                               |
| `fleetSettings.why.read_failed`                      | Couldn't check this: GitHub answered HTTP {status}. Counts as not met until a check succeeds.                                                                                                                                                  |
| `fleetSettings.why.read_unreachable`                 | Couldn't check this: GitHub could not be reached. Counts as not met until a check succeeds.                                                                                                                                                    |
| `fleetSettings.why.app_not_readable`                 | Can't be checked until the motir-studio App is installed and readable on {org}.                                                                                                                                                                |
| `fleetSettings.jobs.missing`                         | {repo} · {workflow} · {job} — missing {tools}                                                                                                                                                                                                  |
| `fleetSettings.jobs.cannotHost`                      | {repo} · {workflow} · {job} — can't be hosted: {reason}                                                                                                                                                                                        |
| `fleetSettings.jobs.more`                            | +{count} more                                                                                                                                                                                                                                  |
| `fleetSettings.jobs.scope`                           | This covers the inventoried image built from main, not the image production boots.                                                                                                                                                             |
| `fleetSettings.confirm.onTitle`                      | Turn on fleet CI for {org}?                                                                                                                                                                                                                    |
| `fleetSettings.confirm.onBody`                       | Off → On. Every new CI job in {count, plural, one {# repository} other {# repositories}} will run on the fleet and be charged to moooon B.V.'s pool: {repositories}. Jobs already running finish where they started.                           |
| `fleetSettings.confirm.offTitle`                     | Turn off fleet CI for {org}?                                                                                                                                                                                                                   |
| `fleetSettings.confirm.offBody`                      | On → Off. New jobs go back to GitHub-hosted runners; jobs already running on the fleet finish there. Turning off never waits on readiness.                                                                                                     |
| `fleetSettings.confirm.reasonLabel`                  | Reason — required, written to the audit log                                                                                                                                                                                                    |
| `fleetSettings.confirm.reasonPlaceholderOn`          | Why are you turning this on?                                                                                                                                                                                                                   |
| `fleetSettings.confirm.reasonPlaceholderOff`         | Why are you turning this off?                                                                                                                                                                                                                  |
| `fleetSettings.confirm.reasonHint`                   | Shown to any operator reading this change later. “Testing” on its own answers nothing.                                                                                                                                                         |
| `fleetSettings.confirm.reasonHintEmpty`              | The button stays disabled until a reason is typed — the same rule the server applies.                                                                                                                                                          |
| `fleetSettings.confirm.cancel`                       | Cancel                                                                                                                                                                                                                                         |
| `fleetSettings.confirm.confirmOn`                    | Turn on                                                                                                                                                                                                                                        |
| `fleetSettings.confirm.confirmOff`                   | Turn off                                                                                                                                                                                                                                       |
| `fleetSettings.refused.reasonMissing`                | Not turned {direction}: a reason is required, and it is written to the audit log with this change. Nothing changed.                                                                                                                            |
| `fleetSettings.refused.alreadyOn`                    | Already on — nothing changed.                                                                                                                                                                                                                  |
| `fleetSettings.refused.alreadyOff`                   | Already off — nothing changed.                                                                                                                                                                                                                 |
| `fleetSettings.refused.alreadyBody`                  | Another superadmin changed it first, so nothing was written and no audit row was added.                                                                                                                                                        |
| `fleetSettings.refused.githubStatus`                 | Not turned {direction}: GitHub refused to {operation} {name} on {org} (HTTP {status}).                                                                                                                                                         |
| `fleetSettings.refused.githubUnreachable`            | Not turned {direction}: GitHub could not be reached to {operation} {name} on {org}.                                                                                                                                                            |
| `fleetSettings.refused.nothingChanged`               | Nothing changed: the setting and the GitHub variable are as they were.                                                                                                                                                                         |
| `fleetSettings.refused.notReady`                     | Not turned on: the fleet stopped being ready after this page loaded.                                                                                                                                                                           |
| `fleetSettings.refused.notReadyList`                 | Not met now: {conditions}. Nothing changed. The readiness below has been checked again.                                                                                                                                                        |
| `fleetSettings.unavailable.title`                    | Couldn't load the fleet setting                                                                                                                                                                                                                |
| `fleetSettings.unavailable.body`                     | The setting or its readiness could not be read, so no state is shown and no switch is offered. This is a read error — nothing has changed, and no value is guessed.                                                                            |
| `fleetSettings.unavailable.retry`                    | Retry                                                                                                                                                                                                                                          |

`{direction}` is _on_ / _off_ and `{operation}` is _read_ / _set_ / _delete_ — each a catalogue word
of its own in the build, never the raw enum. The `label` / `fleet` / `name` / `variable` / `script`
values are the code constants (`MOTIR_RUNNER_LABEL` = `motir-runner`, `motir-fleet`,
`MOTIR_RUNNER_VARIABLE` = `MOTIR_RUNNER`, `MOTIR_FLEET_MAX_IN_FLIGHT`,
`scripts/ci-fleet/sync-project-runner-groups.ts`) interpolated, not spelled in the catalogue.

## Data — what each element reads

| element                        | source                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the pair (one card stack each) | `fleetOrgCiSettingService.listTargets` → `FleetOrgCiTargetDTO[]` (`projectKey`, `org`)                                                                                                                                                                                        |
| switch + On/Off chip           | `getState(...).enabled` (the stored INTENT)                                                                                                                                                                                                                                   |
| switch disabled (OFF only)     | `!enabled && !readiness.ready`; never disabled while `enabled`                                                                                                                                                                                                                |
| last changed                   | `updatedBy.email`, `updatedAt` (relative), `lastReason`; `updatedBy === null` → _Never changed_                                                                                                                                                                               |
| audit-log link                 | `/admin/audit-log?action=fleet.org_ci.enable` when `enabled`, else `?action=fleet.org_ci.disable` (the log filters by ONE action — the last flip's)                                                                                                                           |
| GitHub variable line           | `variable.state` (`present` → `value`; `absent`; `unknown` → `status`, `null` = unreachable)                                                                                                                                                                                  |
| drift warning                  | `enabled && variable.state === 'absent'`, or `!enabled && variable.state === 'present'`                                                                                                                                                                                       |
| repositories                   | the private repositories of the pair — `readiness.conditions[app_repositories].params.repositories` when met (also `image_coverage`'s); when neither is met the build needs the list from the service (open question for the UI card: `getState` does not return it directly) |
| readiness verdict + rows       | `readiness.ready`, `readiness.conditions[]` in order (`key`, `state`, `reasonCode`, `params`), `readiness.checkedAt`                                                                                                                                                          |
| uncovered jobs                 | `image_coverage.params.jobs[]` (`repoRef`, `workflow` basename, `jobId`, `verdict`, `missing[]`, `reason`) — first five, then _+N more_                                                                                                                                       |
| confirm count + list           | the same private-repository list                                                                                                                                                                                                                                              |
| flip                           | `setEnabled(principal, { projectId, org }, enabled, reason)` → `{ outcome: 'changed' \| 'unchanged', state }`                                                                                                                                                                 |
| refusals                       | `MissingAuditReasonError` (8b) · `FleetOrgCiNotReadyError.conditions` (11) · `FleetOrgCiGithubWriteError` `{ org, status, operation }` (10) · `NotPlatformStaffError` → 404 (13) · `FleetOrgCiTargetUnknownError` → 404 (a pair the console does not offer)                   |
| read failed                    | any throw from `listTargets` / `getState` other than the 404 ones (12)                                                                                                                                                                                                        |

## Colour and shape roles (`--el-*` only)

| element                                | token                                                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cards                                  | the console's `Card`: `--el-page-bg`, `--el-border`, `--radius-card`, `--shadow-card`, `--spacing-card-padding`                                                                                           |
| setting glyph tile                     | `--el-tint-lavender` + `--el-text-strong` (the `ent-org` tile)                                                                                                                                            |
| title · explanation · meta labels      | `--el-text` · `--el-text-secondary` · `--el-text-secondary`; codes `--el-text-strong` mono                                                                                                                |
| _Superadmin only_ chip                 | `Pill` tier: `--el-tint-lavender` + `--el-text-strong`, `--radius-badge`, `--spacing-chip-x/y`                                                                                                            |
| Switch                                 | track OFF `--el-muted` + `--el-switch-off-border`, knob `--el-switch-knob-off`; ON `--el-switch-on` + `--el-switch-on-border`, knob `--el-switch-knob`; `rounded-full`; disabled `opacity .5`             |
| On / Off chip                          | On `Pill` success: `--el-tint-mint` + `--el-text-strong`; Off `Pill` neutral: `--el-surface` + `--el-text-secondary` + `--el-border`                                                                      |
| blocked reason beside the switch       | `--el-text-secondary`, glyph `--el-warning`; the calm OFF line's glyph `--el-info`                                                                                                                        |
| **mark: Met**                          | **success role** — `--el-tint-mint` + `--el-text-strong`, `circle-check` glyph, word _Met_                                                                                                                |
| **mark: Not met**                      | **warning role** — `--el-tint-yellow` + `--el-text-strong`, `triangle-alert` glyph, word _Not met_                                                                                                        |
| **mark: Couldn't check**               | **warning role, its OWN word and icon** — `--el-tint-yellow` + `--el-text-strong`, `circle-question-mark` glyph, a dashed `--el-border-strong` edge, word _Couldn't check_. Never success, never neutral. |
| verdict Ready / Not ready              | `Pill` success (`--el-tint-mint`) / warning (`--el-tint-yellow`), `--el-text-strong`; header tile `sig-ok` (`--el-tint-mint` + `--el-success`) / `sig-warn` (`--el-tint-yellow` + `--el-warning`)         |
| unmet sentence · job list · scope line | `--el-text-secondary`; job list box `--el-border-soft`, `--radius-control`                                                                                                                                |
| ON callout (Panel 4)                   | `--el-tint-sky` + `--el-text-strong`, link underlined in `--el-text-strong`                                                                                                                               |
| degraded / drift band                  | toast warn: `--el-tint-yellow` + `--el-text-strong`, glyph `--el-warning`                                                                                                                                 |
| already-in-state note                  | **info**, not error: `--el-tint-sky` + `--el-text-strong`, glyph `--el-info`                                                                                                                              |
| write-failed / not-ready refusal       | toast error: `--el-tint-rose` + `--el-text-strong`, glyph `--el-danger`                                                                                                                                   |
| blank-reason inline error (8b)         | **`--el-danger-on-surface`** (never `--el-danger-text`, never raw `--el-danger` as ink)                                                                                                                   |
| links                                  | `--el-link`, underlined                                                                                                                                                                                   |
| confirm                                | Panel 11 unchanged: `--radius-modal`, `--shadow-modal`, `Input` `--radius-input`, buttons `--radius-btn`                                                                                                  |
| read-failed card                       | the console's error state: `--el-tint-rose` tile + `--el-danger` glyph, `--el-text` heading                                                                                                               |

Unmet and couldn't-check share a hue on purpose — both block ON — and differ by word, glyph and edge,
so they are told apart without colour.

## A11y

- The switch is the `Switch` primitive (`role="switch"`, `aria-checked`), named by
  `aria-labelledby` → the card title, and `aria-describedby` → the reason beside it when there is one.
  A blocked switch carries `disabled`; the reason is real text, not a tooltip.
- Moving the switch does not flip it: it opens the confirm, and the switch shows the stored state
  until the flip answers.
- Each mark is icon + word; the icon is `aria-hidden`. The condition list is a labelled `<ul>`.
- The confirm is `role="alertdialog"`, focus lands in the reason field, and the primary carries
  `disabled` until the reason is non-blank. 8b's server refusal is `role="alert"` under the field and
  keeps focus in the dialog.
- The degraded / drift bands and the already-in-state note are `role="status"`; the write-failed
  and not-ready refusals are `role="alert"`.
- The read-failed card's Retry is a real button; no switch is rendered, disabled or otherwise.

## What this amendment does NOT draw

- **Per-repository toggles** — one switch per (project, org) pair, by the story.
- **Any tenant-facing surface**, and **Monitoring › Fleet** itself (MOTIR-7314) — linked only.
- **Zero offered pairs.** If `listTargets` returns nothing, the UI card shows the console's empty
  state; suggested copy, not drawn: _No project offers fleet CI — no meta-org project has a private
  repository in a connected org._ (`fleetSettings.empty`).
- **A loading skeleton** — server-rendered read (see the panels table).
- **The zh strings** — the UI card's.
- **A `.png` export** — retired (AMENDMENT 4).

---

# AMENDMENT 2026-10-23 — Monitoring · Fleet orgs under per-plan caps (MOTIR-9382 · story MOTIR-9363)

**Mock:** `design/platform-admin/fleet-orgs--plan-caps.mock.html` — a DELTA mock. It amends
MOTIR-7314's mock `monitoring--fleet.mock.html` — published as that card's design result and
never committed to the tree — whose Fleet section shipped as `app/(admin)/admin/monitoring/_components/FleetSection.tsx`):
**Panel 1's "Fleet · organisations running containers" card** and **Panel 3's empty state**.
Nothing else on that mock changes — the kills card, the verdict chips, the disabled and read-failed
states and the tenant link stand as drawn. Built by **MOTIR-9377**.

## Why it changes

The fleet-capacity decision **MOTIR-9357** amends `docs/decisions/fleet-per-org-pool.md` §2: the
flat 500-container pool every paid org shared across CI, indexing and hosted runs is gone. Each
organisation is held to its **plan's** figures, one per workload (`lib/billing/planCaps.ts`,
MOTIR-9372): `agentRunsInParallel`, `agentsPerUser`, `agentsRunningPerOrg`, `ciBurstCap`. Code-graph
indexing is under no figure. So "Pool used · {used} / {pool}" no longer means anything, and each
workload must read against its own figure.

## The panels (review EACH)

| #   | Panel                    | What it shows                                                                                                                                                                                                                  |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Populated, IN PLACE      | The access path (Operations → Monitoring, shipped sections collapsed) and the changed card: five tiles, the Plan column, one group header _Held to the plan_ over CI / hosted / agent instances, index under _No plan figure_. |
| 2   | Tiles at the narrow step | The five tiles in the grid's two-column step (2 + 2 + 1).                                                                                                                                                                      |
| 3   | The cell states          | One row per state: at a figure (full bar), under it, the Standard row, a CI override, plan unknown, exempt.                                                                                                                    |
| 4   | Nothing running          | MOTIR-7314 Panel 3's empty state, body copy without "per-org pool".                                                                                                                                                            |
| 5   | Dark mode                | Panel 1's card under `data-theme="dark"` (the mock re-emits Tier 3 on every `[data-theme]` scope so the nested board really computes dark).                                                                                    |

## The table

Columns, in order: **Organisation · Plan · CI runners · Hosted-agent runs · Agent instances ·
Index containers · CI minutes · last {minutes} min · Credits this month · confirmed · Verdict.**

- **Removed:** the _Pool used_ column and both group headers (_In the {pool}-container pool_,
  _Own pool_). Agent instances are no longer "not in the pool" — they read against
  `agentsRunningPerOrg` like the other two capped workloads.
- **Group header row:** an empty cell over Organisation + Plan; **Held to the plan** (solid
  `--el-border-strong` underline, the old pool header's treatment) over CI runners, Hosted-agent runs
  and Agent instances; **No plan figure** (dashed underline, the old _Own pool_ treatment, with the
  dashed column rule) over Index containers.
- **Plan cell:** `{plan} · {n} per person` — the plan's display name (`planName` from motir-ai) in
  `--el-text` weight 500, then ` · {agentsPerUser} per person` in `--el-text-secondary`. No bar: it is
  a figure, not a usage.
- **A capped workload cell** (CI runners · Hosted-agent runs · Agent instances): `{used} of {figure}`
  — the count in `--el-text` 600, `of {figure}` in `--el-text-secondary` — over the shipped `.usebar`
  (`--radius-badge`, `--el-surface` track) at `used / figure`. Fill `--el-accent`; **at or over the
  figure the bar is full and takes `--el-warning`**, so "at the figure" reads without the number (a
  graphic: 3:1 suffices, and the number says it in words).
- **CI override:** when `Organization.fleetPoolCap` is set it replaces the plan's `ciBurstCap` for
  CI alone — the cell reads `{used} of {override}` with the sub-line **override** (`.sub2`,
  `--el-text-secondary`). Hosted and agent cells never show an override.
- **Index containers:** a bare count, no figure and no bar. Zero is the shipped `.muted` 0.
- **Exempt row** (Motir's own org — `isMeta` / `internalBilling`, or a build without billing): Plan
  reads **No plan limit** (italic, `--el-text-secondary`); every workload is a bare count with no
  "of" and no bar.
- **Plan unknown row** (the plan read failed, the subscription has no tier, or the key has no caps
  row): Plan is a `pill-warn` chip (`--el-tint-yellow`, `--el-text-strong`, help glyph)
  **Plan unknown · {key}** — the key named when there is one; with none it reads **Plan unknown**.
  Sub-line **new containers refused** (fail-closed: admission refuses on `plan_unknown`). Workloads are
  bare counts, no figure, no bar.
- Sort, mismatch rail, verdict chips, CI minutes, credits, footer and pager: unchanged.

## The stat tiles

The single pooled tile (_containers in per-org pools (CI · hosted · index)_) gives way to two, so
there are five MiniStats. The shipped grid `grid gap-3 sm:grid-cols-2 lg:grid-cols-4` becomes
**`sm:grid-cols-2 lg:grid-cols-5`** — one row at desktop; 2 + 2 + 1 at the `sm` step (Panel 2); one
per row below `sm`. Order: orgs · CI runners · hosted-agent runs · agent instances · mismatched.

## Copy (en — `platformAdmin.monitoring.fleet.orgs`, the UI card adds every locale)

| key                 | en                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subtitle`          | Each organisation holding a container now, against its plan’s figures, beside what the CI debit did for it in the last {minutes} minutes (two debit periods). Mismatched first.             |
| `stat.ciRunners`    | CI runners · each org held to its plan’s burst cap                                                                                                                                          |
| `stat.hostedAgents` | hosted-agent runs · each org held to its plan’s parallel runs                                                                                                                               |
| `stat.instances`    | agent instances running · each org held to its plan’s figure                                                                                                                                |
| `group.plan`        | Held to the plan                                                                                                                                                                            |
| `group.uncapped`    | No plan figure                                                                                                                                                                              |
| `col.plan`          | Plan                                                                                                                                                                                        |
| `plan.named`        | {plan} · {perUser} per person                                                                                                                                                               |
| `plan.exempt`       | No plan limit                                                                                                                                                                               |
| `plan.unknown`      | Plan unknown · {key}                                                                                                                                                                        |
| `plan.unknownNoKey` | Plan unknown                                                                                                                                                                                |
| `plan.unknownNote`  | new containers refused                                                                                                                                                                      |
| `usedOf`            | {used} of {figure}                                                                                                                                                                          |
| `override`          | override                                                                                                                                                                                    |
| `empty.body`        | No organisation holds a CI runner, hosted-agent run, agent instance or index container right now, so there is nothing to compare against the debit. This is a healthy reading, not a fault. |

Retired: `stat.pooled`, `group.pool`, `group.own`, `col.poolUsed`, `col.agentInstanceNote`,
`poolOf`, `poolUnknown`. `stat.orgs`, `stat.mismatched` and every other key stand.

## Colour and shape roles (`--el-*` only)

| element                                                | role                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| plan name · count · bare count                         | `--el-text`                                                                                  |
| per-person text · `of {n}` · sub-lines · No plan limit | `--el-text-secondary` (AA on the white card and every surface)                               |
| usage bar track · fill                                 | `--el-surface` · `--el-accent`; at the figure `--el-warning`; `--radius-badge`               |
| Plan unknown chip                                      | `pill-warn`: `--el-tint-yellow` + `--el-text-strong`, `--radius-badge`, `--spacing-chip-x/y` |
| group underline · column rule                          | `--el-border-strong` (solid for _Held to the plan_, dashed for _No plan figure_)             |
| tiles                                                  | the shipped MiniStat: `--el-border`, `--radius-card`, label `--el-text-secondary`            |

## A11y

- Each capped cell's text carries the meaning (`4 of 5`); the bar is `aria-hidden`, as the shipped
  pool bar is. The warning fill at the figure is never the only signal.
- The Plan unknown chip's glyph is `aria-hidden`; the word and the key carry it.
- The group header cells are `<th scope="colgroup">`.

## What this amendment does NOT draw

- **The tenant page's `OrgFleetCard`** — the UI card applies the same cell grammar there
  (`{used} of {figure}`, the Plan line); no new layout.
- **Per-user agent counts** — the per-person figure is shown as the plan's figure only; the table
  has no per-user breakdown.
- **Loading** — server-rendered read, as before. **A `.png` export** — retired (AMENDMENT 4).

---

# AMENDMENT 2026-10-25 — Provider capacity (MOTIR-9607 · story MOTIR-9539)

**Mock:** `console--capacity.mock.html` (delta, Panels 1–17). It amends `console.mock.html`
(Panel 2's shell and Panel 7a's 404, referenced and not redrawn). Its token block, primitive
CSS and sprite are spliced verbatim from `console--fleet-settings.mock.html`, the newest
Operations delta. **Gates MOTIR-9614**, the capacity screen card.

## Why it changes

The gateway now measures, per provider and model, how much of each published limit is in use,
split into the planning lane and the agent-run lane. Nobody can read it. Platform staff learn a
provider is saturated only when planning turns start to fail, and changing a limit when a tier
changes means editing gateway storage by hand. This page is the first consumer of the gateway's
capacity contract (motir-gateway, `motir-capacity-api.md`), and draws nothing that contract does
not return. The alert share and the raised-alert state are core's own (MOTIR-9609).

## The door and who sees what

- **Rail row:** a new Operations row, **Provider capacity**, lucide `Gauge`, directly after
  Monitoring (after Fleet settings for a superadmin, who also sees that row). Page address
  `/admin/capacity`.
- **Read:** every platform staff role (`support` and up on `PLATFORM_ROLE_LADDER`), behind
  `requirePlatformStaff`, the same as Monitoring. Anyone else gets the console's 404
  (`NotPlatformStaffError`, Panel 7a of `console.mock.html`), with no usage number.
- **Edit** (limits, planning share, tier note, alert share): `operator` and up. A `support` user
  sees the same page with no Edit buttons (Panel 16). The server door checks the role again; a
  hidden button is not the gate.
- No tenant, user or organisation identifier appears anywhere; the read carries none.

## The panels

| #   | state                                                                                            | contract field that decides it                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Loaded, live; the rail door; raised-alerts banner; alert-share card; provider groups             | `counter_store.state = live`, `scope = shared`                                                                                              |
| 2   | No alert raised: the banner is absent, with no "all clear" in its place                          | core raised-alert state empty                                                                                                               |
| 3   | Counter scope instance: a sky notice under the Freshness line; numbers still judged              | `counter_store.scope = instance`                                                                                                            |
| 4   | Counter store unavailable: limits, tier notes and shares shown; every usage cell **Unavailable** | `counter_store.state = unavailable`, all lanes `null`                                                                                       |
| 5   | One entry slow: only that entry reads Unavailable, with a warning line                           | that entry's `lanes.planning` and `lanes.agent` both `null`                                                                                 |
| 6   | Usage not reported: Claude's input and output tokens/min show the limit, never 0                 | lanes carry only a summed `tokens_per_minute`                                                                                               |
| 7   | Limit set to 0: **Limit 0**, share a dash, state from usage > 0                                  | `limits.<u> = { value: 0, status: set }`                                                                                                    |
| 8   | Unreachable or `capacity_config_unavailable`: the console ErrorState and Retry                   | no answer, or 500                                                                                                                           |
| 9   | Credential refused: same ErrorState with the credential sentence                                 | 401 `capacity_auth_missing` · `_invalid`, 403 `capacity_auth_forbidden`                                                                     |
| 10  | Loading: skeleton entries, `aria-busy`                                                           | first read pending                                                                                                                          |
| 11  | No entries: EmptyState, no add button (models are added in the gateway)                          | `entries = []`                                                                                                                              |
| 12  | Edit dialog: idle · Unknown checked · saving · saved                                             | the gateway limits write (PUT)                                                                                                              |
| 13  | Edit refused inline, under the named field                                                       | 400 `capacity_invalid_value` with `field`                                                                                                   |
| 14  | Edit refused at dialog level                                                                     | `capacity_invalid_body` · `capacity_unknown_model` · `capacity_unknown_provider` · `capacity_store_error` · `capacity_auth_*` · unreachable |
| 15  | Alert-share card: idle · editing · saving · saved · out of range · save failed                   | core setting (MOTIR-9609)                                                                                                                   |
| 16  | Support role: read-only                                                                          | `PLATFORM_ROLE_LADDER`                                                                                                                      |
| 17  | Chinese: the zh column of the copy deck                                                          | —                                                                                                                                           |

## How a row is judged

- **Rows shown:** one Limit row per unit whose `limits.<u>.status` is `set` or `unknown`, in the
  order concurrency, requests/min, input tokens/min, output tokens/min, tokens/min, tokens/day.
  Units with `not_applicable` go under the fold **Units this provider does not enforce (n)**,
  each reading **Not applicable**, never 0. The fold is a native `<details>`, closed by default.
- **Usage** is `lanes.planning + lanes.agent` for the matching lane field (`in_flight`,
  `requests_per_minute`, `tokens_per_minute`, `tokens_per_day`). The two lanes are shown apart
  under the total: **Planning 14 · Agent 40**. The state is judged on the sum.
- **Share** is `round(usage × 100 / limit)`. **States** at an alert share `A` (default 80):
  Normal below `A − 10`; **Near limit** from `A − 10` up to `A`; **Over alert share** at `A` or
  above. A limit of 0 with usage above 0 is Over, and its share is a dash.
- **Unknown limit** (`status: unknown`, `value: null`): usage shown, limit reads **limit not
  known**, share a dash, pill Unknown limit. `unknown_note` shows above the table when set.
- **429 answers:** one row under the limits with this minute's and today's (UTC) counts per
  lane, from `rate_limited_429`. It has no limit, so no share and no state.
- **Usage not reported:** Claude enforces `input_tpm` and `output_tpm`, but the gateway reports
  only a summed `tokens_per_minute` per lane, so those two rows can never show usage. They read
  **Usage not reported** with no share and no state colour. This is a gap against the gateway
  contract, not something this screen fills.
- **Freshness:** "Read at {time} UTC · refreshes every 15 s" from `read_at`, with Refresh. The
  gateway asks for at most one read a second; 15 s is well inside it.

## Copy (`platformAdmin.capacity.*`)

| key                                                                                | en                                                                                                                                                    | zh                                                                                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `nav`                                                                              | Provider capacity                                                                                                                                     | 服务商容量                                                                                                   |
| `title`                                                                            | Provider capacity                                                                                                                                     | 服务商容量                                                                                                   |
| `subtitle`                                                                         | How close each provider model is to its published limits, for planning and agent runs together. Edit a model’s limits when its provider tier changes. | 每个服务商模型距离其公布限额还有多少余量，规划与智能体运行合并计算。服务商档位变化时，在这里修改模型的限额。 |
| `fresh.readAt`                                                                     | Read at {time} UTC                                                                                                                                    | 读取于 UTC {time}                                                                                            |
| `fresh.every`                                                                      | refreshes every 15 s                                                                                                                                  | 每 15 秒刷新                                                                                                 |
| `fresh.refresh`                                                                    | Refresh                                                                                                                                               | 刷新                                                                                                         |
| `scope.instance`                                                                   | Numbers are from one gateway instance and may be partial.                                                                                             | 数据来自单个网关实例，可能不完整。                                                                           |
| `unavailable.notice`                                                               | Live numbers are unavailable: the gateway could not read its counters. Limits, tier notes and planning shares are shown as stored.                    | 实时数据不可用：网关无法读取其计数器。限额、档位说明和规划占比按已保存的值显示。                             |
| `slow.notice`                                                                      | Live numbers for this model were not read in time. Every other model is live.                                                                         | 该模型的实时数据未能及时读取。其他模型均为实时数据。                                                         |
| `alerts.title`                                                                     | {count, plural, one {1 limit is over the alert share} other {# limits are over the alert share}}                                                      | {count} 项限额已超过告警比例                                                                                 |
| `alerts.line`                                                                      | {provider} · {model} · {limit} — {share} %                                                                                                            | {provider} · {model} · {limit} — {share} %                                                                   |
| `alerts.since`                                                                     | raised since {time} UTC                                                                                                                               | 自 UTC {time} 起告警                                                                                         |
| `alertShare.title`                                                                 | Alert share                                                                                                                                           | 告警比例                                                                                                     |
| `alertShare.hsub`                                                                  | One share for every limit of every model                                                                                                              | 所有模型的所有限额共用一个比例                                                                               |
| `alertShare.label`                                                                 | Alert when any one limit reaches                                                                                                                      | 任一限额达到以下比例时告警                                                                                   |
| `alertShare.note`                                                                  | Checked once a minute, and each time this page loads.                                                                                                 | 每分钟检查一次，每次打开本页时也会检查。                                                                     |
| `alertShare.saved`                                                                 | Saved. The next evaluation uses {share} %.                                                                                                            | 已保存。下次检查将使用 {share} %。                                                                           |
| `alertShare.range`                                                                 | Enter a whole number from 1 to 100.                                                                                                                   | 请输入 1 到 100 之间的整数。                                                                                 |
| `alertShare.failed`                                                                | The alert share could not be saved. Nothing was changed; try again.                                                                                   | 告警比例未能保存，没有任何更改，请重试。                                                                     |
| `entry.tierNote`                                                                   | Tier note: {note}                                                                                                                                     | 档位说明：{note}                                                                                             |
| `entry.noTierNote`                                                                 | No tier note                                                                                                                                          | 无档位说明                                                                                                   |
| `entry.planningShare`                                                              | Planning share {share} %                                                                                                                              | 规划占比 {share} %                                                                                           |
| `entry.unknownNote`                                                                | Unknown: {note}                                                                                                                                       | 未知：{note}                                                                                                 |
| `entry.edit`                                                                       | Edit limits                                                                                                                                           | 编辑限额                                                                                                     |
| `col.limit` · `col.usage` · `col.share` · `col.state`                              | Limit · Usage / limit · Share used · State                                                                                                            | 限额 · 用量 / 限额 · 已用比例 · 状态                                                                         |
| `lanes`                                                                            | Planning {planning} · Agent {agent}                                                                                                                   | 规划 {planning} · 智能体 {agent}                                                                             |
| `unit.max_concurrency` · `rpm` · `input_tpm` · `output_tpm` · `tpm` · `tpd`        | Concurrency · Requests / min · Input tokens / min · Output tokens / min · Tokens / min · Tokens / day                                                 | 并发数 · 每分钟请求数 · 每分钟输入词元 · 每分钟输出词元 · 每分钟词元 · 每日词元                              |
| `state.normal` · `near` · `over` · `unavailable` · `unknown` · `na` · `unreported` | Normal · Near limit · Over alert share · Unavailable · Unknown limit · Not applicable · Usage not reported                                            | 正常 · 接近限额 · 超过告警比例 · 不可用 · 限额未知 · 不适用 · 未上报用量                                     |
| `limitZero`                                                                        | Limit 0                                                                                                                                               | 限额 0                                                                                                       |
| `limitUnknown`                                                                     | limit not known                                                                                                                                       | 限额未知                                                                                                     |
| `r429.label` · `minute` · `day` · `note`                                           | 429 answers · This minute · Today (UTC) · No limit — counted only                                                                                     | 429 响应 · 本分钟 · 今日（UTC） · 无限额 — 仅计数                                                            |
| `fold`                                                                             | Units this provider does not enforce ({count})                                                                                                        | 该服务商不限制的单位（{count}）                                                                              |
| `provider.claude` · `deepseek` · `qwen`                                            | Claude · DeepSeek · Qwen                                                                                                                              | Claude · DeepSeek · Qwen                                                                                     |
| `error.unreachable.title`                                                          | Capacity could not be read                                                                                                                            | 无法读取容量                                                                                                 |
| `error.unreachable.body`                                                           | The gateway did not answer, or it could not read its limits table. Nothing is shown until a read succeeds.                                            | 网关没有响应，或无法读取其限额表。读取成功前不显示任何内容。                                                 |
| `error.auth.title`                                                                 | The gateway credential is not accepted                                                                                                                | 网关凭据未被接受                                                                                             |
| `error.auth.missing`                                                               | Motir’s server has no gateway credential configured. No usage can be read until it is set.                                                            | Motir 服务器未配置网关凭据。设置之前无法读取用量。                                                           |
| `error.auth.invalid`                                                               | The gateway does not recognise Motir’s server credential. No usage can be read until it is replaced.                                                  | 网关无法识别 Motir 服务器的凭据。替换之前无法读取用量。                                                      |
| `error.auth.forbidden`                                                             | The gateway credential belongs to a user who is not a gateway admin. No usage can be read until it is replaced.                                       | 该网关凭据所属用户不是网关管理员。替换之前无法读取用量。                                                     |
| `error.retry`                                                                      | Retry                                                                                                                                                 | 重试                                                                                                         |
| `empty.title`                                                                      | No provider models configured                                                                                                                         | 尚未配置服务商模型                                                                                           |
| `empty.body`                                                                       | The gateway’s limits table has no rows, so there is nothing to show. Models are added in the gateway, not here.                                       | 网关的限额表没有任何记录，因此没有可显示的内容。模型需在网关中添加，而不是在这里。                           |
| `edit.title`                                                                       | Edit limits · {model}                                                                                                                                 | 编辑限额 · {model}                                                                                           |
| `edit.intro`                                                                       | Only the values you change are sent. A limit marked Unknown is stored as not known, never as 0.                                                       | 只发送你修改过的值。标记为“未知”的限额会保存为未知，而不是 0。                                               |
| `edit.unknown`                                                                     | Unknown                                                                                                                                               | 未知                                                                                                         |
| `edit.planningShare` · `edit.tierNote` · `edit.count`                              | Planning share % · Tier note · {count} / 1000                                                                                                         | 规划占比 % · 档位说明 · {count} / 1000                                                                       |
| `edit.save` · `saving` · `cancel` · `saved`                                        | Save · Saving… · Cancel · Limits saved for {model}.                                                                                                   | 保存 · 正在保存… · 取消 · 已保存 {model} 的限额。                                                            |
| `editError.wholeNumber`                                                            | {limit} must be a whole number of 0 or more.                                                                                                          | {limit}必须是大于或等于 0 的整数。                                                                           |
| `editError.tooLarge`                                                               | {limit} is larger than the gateway can store.                                                                                                         | {limit}超出了网关可保存的范围。                                                                              |
| `editError.planningShare`                                                          | Planning share must be a whole number from 0 to 100.                                                                                                  | 规划占比必须是 0 到 100 之间的整数。                                                                         |
| `editError.tierNote`                                                               | The tier note can be at most 1000 characters.                                                                                                         | 档位说明最多 1000 个字符。                                                                                   |
| `editError.invalidBody`                                                            | The gateway could not read this edit. Nothing was changed.                                                                                            | 网关无法读取此次修改，没有任何更改。                                                                         |
| `editError.unknownModel`                                                           | This model is no longer in the gateway’s limits table. Nothing was changed; close and refresh.                                                        | 该模型已不在网关的限额表中，没有任何更改。请关闭后刷新。                                                     |
| `editError.unknownProvider`                                                        | The gateway does not know this provider. Nothing was changed.                                                                                         | 网关无法识别该服务商，没有任何更改。                                                                         |
| `editError.storeError`                                                             | The gateway could not save the change. Nothing was changed; try again.                                                                                | 网关未能保存修改，没有任何更改，请重试。                                                                     |
| `editError.auth`                                                                   | The gateway credential is not accepted, so nothing was saved.                                                                                         | 网关凭据未被接受，因此没有保存任何内容。                                                                     |
| `editError.unreachable`                                                            | The gateway did not answer. Nothing was saved; try again.                                                                                             | 网关没有响应，没有保存任何内容，请重试。                                                                     |

`capacity_empty_edit` has no string: Save is disabled until a value changed, so the screen never
sends an empty edit. `capacity_invalid_value` on a limit key picks `wholeNumber` or `tooLarge`
from the typed value; the server's `field` decides which field shows it.

## Colour and shape roles (`--el-*` only)

| element                                                                              | role                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| model id                                                                             | `--font-mono`, `--el-text`                                                                                                               |
| tier note · planning share chip                                                      | `--el-text` · `pill-tier`                                                                                                                |
| lane split · freshness · fold summary · "no tier note" · Not applicable · unreported | `--el-text-secondary` (AA on the white card and on `--el-surface-soft`)                                                                  |
| usage bar track · fill                                                               | `--el-surface` · `--el-accent`; Near `--el-warning`; Over `--el-danger`; `--radius-badge`; `aria-hidden`                                 |
| Normal · Near · Over · Unavailable / Unknown / unreported pills                      | `pill-active` (mint) · `pill-warn` (yellow) · `pill-down` (rose) · `pill-neutral`; text `--el-text-strong`, `--radius-badge`             |
| 429 row                                                                              | `--el-surface-soft` fill, label `--el-text`, lanes `--el-text-secondary`                                                                 |
| raised-alerts banner                                                                 | `toast toast-err` (rose tint, `--el-text-strong`); "raised since" `--el-text-secondary`                                                  |
| unavailable · slow notices                                                           | `toast toast-warn`                                                                                                                       |
| counter-scope notice                                                                 | `audit-banner` (sky tint)                                                                                                                |
| field error · invalid field                                                          | `--el-danger-on-surface` text; `--el-danger` border and 1px ring                                                                         |
| saved line                                                                           | glyph `--el-success`, text `--el-text`                                                                                                   |
| cards · dialog · inputs · buttons                                                    | `--radius-card` · `--radius-modal` · `--radius-input` · `--radius-btn`; `--spacing-card-padding`, `--spacing-input-x`, `--height-btn-sm` |

## A11y

- Every state is a word in its pill; the bar and its colour are never the only signal.
- The raised-alerts banner is `role="alert"`; the notices and saved lines are `role="status"`.
- A refused field carries `aria-invalid="true"` and its message sits directly under it (the
  screen card adds `aria-describedby`). Focus returns to the first refused field.
- The Edit dialog is the shipped `Modal`: focus trap, Escape closes, focus returns to the entry's
  Edit limits button.
- The fold is a native `<details>`, so it is keyboard- and screen-reader-operable as shipped.
- Loading sets `aria-busy` on the list.

## What this amendment does NOT draw

- **The alert's delivery** beyond this page's banner — the notification itself goes through
  core's existing admin-alert mechanism (MOTIR-9611), which has its own surfaces.
- **A no-capacity verdict** or any launch label — that is the no-capacity label story's.
- **History or charts** — the page reads the gateway's current numbers only.
- **Adding or removing a model** — done in the gateway.
- **Dark mode panels** — the Toggle dark button flips the whole board; no separate dark board.
- **A `.png` export** — retired (AMENDMENT 4).

---

# AMENDMENT 2026-10-25 — Monitoring · Pools

**Design system (step 1, read before drawing).** `package.json` depends on `@motir/design-system`
(`workspace:*`, the in-repo package `packages/design-system`), and `app/globals.css` imports
`@motir/design-system/theme.css` (line 13): **on Motir Design, branch (a).** The project's own axes
come from `app/layout.tsx` (`data-style` / `data-palette` / `data-type` from the applied
appearance; the console renders the defaults): `warm-editorial` · `motir` · `motir`. The mock is
built with `renderMock` from `@motir/design-system/mock` at those axes, from the package's `Card`
and `Pill`; every other piece is the shipped Fleet section's own local markup, composed one for
one (below). No part is missing from the package, so nothing is proposed as an addition.

**Mock:** `design/platform-admin/monitoring--pools.mock.html` — a DELTA mock. It ADDS one section
to `/admin/monitoring` and amends no drawn panel: the Fleet section's mocks (§ _AMENDMENT
2026-10-23 — Monitoring · Fleet orgs under per-plan caps_ and the Fleet design it amends) stand as
records, and the shipped health cards, Overdue schedules, Index allowance and Fleet cards are not
redrawn. This section is the asset's whole specification.

**Verified on the default branch before drawing** (`origin/main` at the time of drawing):
`app/(admin)/admin/monitoring/page.tsx` — the page is `requirePlatformStaffPage('support')`, a
Server Component with `dynamic = 'force-dynamic'`, rendering in order: the breadcrumb _Platform ·
Monitoring_, the title _System health_, seven health cards, the Overdue schedules card,
`IndexAllowanceSection`, then `FleetSection`; each fleet read is settled on its own by
`settleFleetRead` so its failure stays in its card.
`app/(admin)/admin/monitoring/_components/FleetSection.tsx` — the card pattern this section
composes: `CardHead` (lavender icon tile, `h2` title, secondary subtitle, pills at the right),
`InsetState` (an empty / error state drawn inside the card body, `role="alert"` on error),
`MiniStat`, the paged-list `Foot` (an Info note with _Showing {from}–{to} of {total}_ and
Prev / _Page n of m_ / Next links that keep every other list's search params), `Th` / `Td` with
the 3px leading rail, `Mono`, `Sub`. The data this section draws is the shape of
`lib/services/fleetPoolStatusService.ts` / `lib/dto/fleetPools.ts` (the view behind
`fleet-admin pool-status` and `growth-events`) and the shard record in `prisma/schema.prisma`
(`FleetShardRole` `primary` | `spare`, `FleetShardState` `provisioning` | `active` | `disabled`).

## What this section is

One question for a Motir platform admin: **does any pool need a quota request from me, and has
growth been doing its job?** Each fleet kind has its own pool of AWS accounts that grows by itself
at 70% of an account's granted vCPU quota; this section shows each pool as the growth pass last
recorded it. It is **read-only** like the rest of the page: the only way to act is the
`fleet-admin request-quota` command, named in plain text.

## The access path (Panel 1)

**No new route and no new rail row.** The section is reached by opening the existing
`/admin/monitoring` page from the console's **Operations → Monitoring** row, exactly as its peers
are. It is the **last section of the page, directly after the Fleet section** (after the
_Fleet · reconciler kills_ card): the Fly blocks point _up_ to the Fleet section, where a Fly
kind's containers are counted per organisation. Panel 1 draws the page header and the shipped
sections collapsed above it.

## Elements — each named once

| Name                   | What it is                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pools section**      | A `<section aria-labelledby>` with an `h2` _Pools_ (serif, the page's section weight) and one secondary sentence, then the four Pool blocks in a fixed order: **CI runner · Agent runner · Indexer · Agent hoster**.                                                                                                                                                                                 |
| **Pool block**         | One `Card` per fleet kind, its own frame, so a failed read stays inside it. Header = the Fleet `CardHead` with an `h3` _Pool · {kind}_, the subtitle, and the pills (Provider statement, then the Over-70 count pill and the Growth-in-progress pill when they apply). Footer (AWS only) = the Read-only note.                                                                                       |
| **Provider statement** | A `Pill` in words with a glyph: **Runs on AWS** (`severity="info"`, cloud glyph) or **Runs on Fly** (`tone="neutral"`, plane glyph). Read from the kind's own switch.                                                                                                                                                                                                                                |
| **Pool total**         | Three `MiniStat`s: **Capacity** (the sum of the granted vCPU quotas of the shared accounts — the spare and disabled accounts not counted), **vCPU in use** across them, **Of capacity in use** (whole percent).                                                                                                                                                                                      |
| **Account row**        | One table row per shared account: Account (mono name) · Role (_Shared_) · State (`Pill`: _Active_ neutral, _Provisioning_ info) · Granted quota (`{n} vCPU` with _read {age}_ under it) · In use (`{n} vCPU`) · Percent (`{n}%` over the Use bar) · To 70% (`{n} vCPU to go`, or the Over-70 mark).                                                                                                  |
| **Use bar**            | The Fleet section's usage bar (`--radius-badge`, `--el-surface` track, `--el-accent` fill) plus a 1px tick at 70% in `--el-text-secondary`; at or past 70% the fill takes `--el-warning`. `aria-hidden` — the percent beside it carries the meaning.                                                                                                                                                 |
| **Over-70 mark**       | On an account at or past 70%: the `Pill severity="warning"` with a triangle glyph reading **Over 70%**, the sub-line **{n} vCPU past it** (or _at 70% exactly_), and the 3px **warning rail** on the row's leading cell. Words + glyph + rail: never colour alone. The header adds **{n} account(s) over 70%** in the same pill.                                                                     |
| **Not-read mark**      | Where a granted quota was never read or its read failed: the `Pill tone="awaiting"` with a help glyph reading **Not read** (`aria-label="Quota not read from AWS"`), and under it **last read {age}** (the last successful read) or **never read**. Every figure derived from it — that account's Percent and To 70%, the pool's Capacity and percent — reads **Not available** in italic secondary. |
| **Spare line**         | A soft box (`--el-surface-soft`, `--el-border-soft`, `--radius-card`) titled **Motir spare**: the spare's mono name, **Ready to join** (`severity="success"`, check glyph — its quota is granted and read) or **Waiting for quota** (`tone="awaiting"`, hourglass), its quota or the Not-read words, and one sentence saying what happens next. No spare reads _No Motir spare for this kind yet._   |
| **Quota request list** | A titled table (count at the right: _{n} requests · {open} open_): Account · Value asked · Status · Granted · Asked (sorted, ↓) · Last read from AWS. **Open requests first, then newest first.** Paged with the Fleet `Foot`.                                                                                                                                                                       |
| **Growth event list**  | A titled table (_Growth events · 70% reached_, count at the right): When (sorted, ↓, newest first) · Triggering account · Its use (`{used} of {granted} vCPU` with _{p}% of its granted quota_) · Outcome (the Outcome pill + one detail line). Paged with the Fleet `Foot`.                                                                                                                         |
| **Read-only note**     | The block footer: an Info glyph and _Read-only. To ask AWS for more quota, run `fleet-admin request-quota --account <name> --vcpu <n>` at a terminal._ Plain text — not a button, not a link.                                                                                                                                                                                                        |
| **Block error**        | The Fleet `InsetState` with `tone="error"` inside the block's card.                                                                                                                                                                                                                                                                                                                                  |
| **Block skeleton**     | The loading state: the header (title and subtitle, no pills), three `--el-muted` skeleton tiles and three skeleton lines, `aria-busy="true"` and one `role="status"` sentence.                                                                                                                                                                                                                       |

**Status pills (Quota request list).** `pending` → **Open · pending** and `case_opened` → **Open ·
case opened** (`tone="awaiting"`, hourglass) — both count as open; `approved` → **Approved**
(`severity="success"`, check); `denied` → **Denied** and `not_approved` → **Not approved**
(`severity="danger"`, triangle); `invalid_request` → **Invalid request** (danger); `case_closed`
→ **Case closed** (`tone="neutral"`, minus). Granted cell: the granted value; an open request
reads _Not yet_; a closed request with no grant reads _Not granted_ with _quota stays {n} vCPU_
(or _quota unchanged_) — the account's quota is never shown as changed by a denial.

**Outcome pills (Growth event list).** `spare_promoted` → **Spare promoted** (success) — _{spare}
joined the shared pool; new spare {name} being created_ (the second clause only when one was
created); `account_created` → **Account created** (success, server glyph) — _{name} added, with no
spare to promote_; `waiting_for_quota` → **Waiting for quota** (awaiting) — _the spare's raise is
still open, so nothing joined yet_; `refused` → **Refused** (danger) — then **AWS said: "{reason}"**
in `--el-danger-on-surface` with a triangle glyph (AWS's own words, verbatim), then _no account
was added; the next pass tries again after a backoff_, and the row's **danger rail**.

## The panels (review EACH) — every state in light, then the same state in dark

| #   | Panel                           | What it shows                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | In place — the access path      | The page header, the shipped sections collapsed, then the Pools section: CI runner **on AWS, healthy** (two shared accounts under 70%, the spare ready, three approved raises, one promoted event) · Agent runner **on AWS with no account yet** · Indexer and Agent hoster **on Fly**.                  |
| 2   | Account past 70% — growth fired | iad-1 at 75% with the Over-70 mark and rail; the header pill _1 account over 70%_ and _Growth in progress_; a third shared account (the spare promoted); the new spare **Waiting for quota** with its open raise listed first; a new _Spare promoted_ event.                                             |
| 3   | Not-read quota                  | iad-2's read failed (_Not read · last read 3 d ago_), iad-3 was never read (_Not read · never read_); their Percent and To 70% and the pool's Capacity and percent read _Not available_; the spare's quota not read, so it is not ready. vCPU in use stays a figure — it is measured, not read from AWS. |
| 4   | Quota raises                    | Two open requests first (case opened, pending), then a **Denied** one (_Not granted · quota stays 128 vCPU_), then approved ones, newest first.                                                                                                                                                          |
| 5   | Growth events                   | A **Refused** growth with AWS's reason in words, beside a _Spare promoted_ with no new spare, a _Waiting for quota_ and an older _Spare promoted_; the spare line reads _No Motir spare for this kind yet._                                                                                              |
| 6   | Empty lists                     | One account, a ready spare, and both lists empty: _No quota raise has been asked of AWS for this kind._ · _No growth events yet — no account of this kind has reached 70%._                                                                                                                              |
| 7   | Many accounts and paged lists   | Seven shared accounts (three over 70%), a request list on page 1 of 2 (_Showing 1–10 of 14_) and an event list on page 2 of 3 (_Showing 11–20 of 23_).                                                                                                                                                   |
| 8   | A block that fails              | The Agent runner block's read threw: its Block error in its own card, no provider claimed and no figure; the CI runner, Indexer and Agent hoster blocks render as usual.                                                                                                                                 |
| 9   | Loading                         | Two AWS blocks in their Block skeleton beside the two Fly blocks.                                                                                                                                                                                                                                        |

Each panel is followed by **the same state under `data-theme="dark"`** (a nested
`data-appearance-scope` board, so Tier 3 recomputes dark).

## Rules the drawing holds

- **A figure AWS has not answered for never renders as a number.** A null granted quota is the
  Not-read mark; nothing defaults it to 0, and every figure computed from it reads _Not available_.
  The pool's Capacity is _Not available_ (with _{n} account(s)' quota is not read, so the total is
  not known_) whenever any shared account's quota is not read — a partial sum is never shown as
  the pool's capacity.
- **A Fly kind shows words only**: the Provider statement, an `InsetState` _{kind} runs on Fly_ and
  one sentence pointing to the Fleet section above. No figure, no account row, no spare, no list.
- **A pool with no account yet** shows _No account yet_ in all three Pool total tiles, one sentence
  (_This pool has no AWS account yet, so it has no capacity to read. Its first account is added
  with `fleet-admin add-shard`._), no Account rows, and the spare line's _No Motir spare_ sentence.
- **Nothing on this section files, retries, promotes or changes anything.** The only interactive
  elements are the Prev / Next pager links, in the Fleet section's pattern; their search params are
  per list and per kind (the build names them), and they keep every other list's place.
- **No credential, credential reference, AWS account id, GitHub org or member email** is drawn: an
  account is named by its shard name only.
- **No Host organisation's own accounts** appear in any pool.

## Data — what each element reads

From the pools read service (one staff-gated, audited, system-context read; it calls no AWS API):
per kind `provider` (`aws` | `fly` | `unavailable`); for an AWS kind the pool total
(`grantedVcpu`, `usedVcpu`, `percent`, `complete`), the accounts (`name`, `state`, `grantedVcpu`,
`grantedReadAt`, `usedVcpu`, `percent`, `toThreshold`, `overThreshold`), the spares (`name`,
`state`, quota, read time, `ready`), every quota request (account, desired value, status, granted
value, `createdAt`, `lastReadAt`) and the growth events (newest first). _vCPU past it_ is
`usedVcpu − ⌈70% × grantedVcpu⌉`. Times render as the Fleet section's coarse _{age} ago_.

## Copy (en — a new `platformAdmin.monitoring.pools` namespace; every string needs a `zh` twin)

All strings below are new, and **every one needs a zh counterpart** (the build card adds both).
Account names, the command text and AWS's reason are data, not copy, and are not translated.

| key                       | en                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                   | Pools                                                                                                                                                                                                                                           |
| `subtitle`                | Each fleet kind’s pool of AWS accounts: capacity, use against 70%, the Motir spare, the quota raises asked of AWS and whether growth has been doing its job. Read from what the growth pass last recorded — loading this page asks AWS nothing. |
| `kind.ci_runner`          | CI runner                                                                                                                                                                                                                                       |
| `kind.hosted_agent`       | Agent runner                                                                                                                                                                                                                                    |
| `kind.code_graph_index`   | Indexer                                                                                                                                                                                                                                         |
| `kind.agent_instance`     | Agent hoster                                                                                                                                                                                                                                    |
| `block.title`             | Pool · {kind}                                                                                                                                                                                                                                   |
| `block.subtitle.aws`      | Its shared accounts, the Motir spare, quota raises asked of AWS and the growth events — as the growth pass last read them.                                                                                                                      |
| `block.subtitle.fly`      | This kind is switched to Fly, so it has no AWS pool.                                                                                                                                                                                            |
| `block.subtitle.other`    | Its shared accounts, the Motir spare, quota raises and growth events.                                                                                                                                                                           |
| `provider.aws`            | Runs on AWS                                                                                                                                                                                                                                     |
| `provider.fly`            | Runs on Fly                                                                                                                                                                                                                                     |
| `overCount`               | {count, plural, one {# account over 70%} other {# accounts over 70%}}                                                                                                                                                                           |
| `growthInFlight`          | Growth in progress                                                                                                                                                                                                                              |
| `fly.title`               | {kind} runs on Fly                                                                                                                                                                                                                              |
| `fly.body`                | Its switch is set to Fly, so there is no AWS capacity, quota or growth to show for it. Its running containers are counted per organisation in the Fleet section above.                                                                          |
| `error.title`             | Couldn’t read the {kind} pool                                                                                                                                                                                                                   |
| `error.body`              | This pool’s read didn’t answer, so nothing here is loaded — none of it is zero, and no provider is claimed. The other pools and the rest of this page are unaffected. Reload to try again.                                                      |
| `loading`                 | Loading the {kind} pool                                                                                                                                                                                                                         |
| `total.capacity`          | Capacity · granted quota of {count, plural, one {# shared account} other {# shared accounts}} · the spare not counted                                                                                                                           |
| `total.used`              | vCPU in use across them                                                                                                                                                                                                                         |
| `total.percent`           | Of capacity in use · growth starts when one account passes 70%                                                                                                                                                                                  |
| `total.percentShort`      | Of capacity in use                                                                                                                                                                                                                              |
| `total.capacityShort`     | Capacity · granted vCPU quota                                                                                                                                                                                                                   |
| `total.usedShort`         | vCPU in use                                                                                                                                                                                                                                     |
| `total.incomplete`        | {count, plural, one {# account’s quota is not read} other {# accounts’ quota is not read}}, so the total is not known                                                                                                                           |
| `total.noAccount`         | No account yet                                                                                                                                                                                                                                  |
| `total.noAccountBody`     | This pool has no AWS account yet, so it has no capacity to read. Its first account is added with {command}.                                                                                                                                     |
| `vcpu`                    | {n} vCPU                                                                                                                                                                                                                                        |
| `percent`                 | {n}%                                                                                                                                                                                                                                            |
| `notAvailable`            | Not available                                                                                                                                                                                                                                   |
| `accounts.title`          | Shared accounts                                                                                                                                                                                                                                 |
| `accounts.count`          | {count, plural, one {# account} other {# accounts}}                                                                                                                                                                                             |
| `accounts.col.*`          | Account · Role · State · Granted quota · In use · Percent · To 70%                                                                                                                                                                              |
| `role.shared`             | Shared                                                                                                                                                                                                                                          |
| `state.active`            | Active                                                                                                                                                                                                                                          |
| `state.provisioning`      | Provisioning                                                                                                                                                                                                                                    |
| `readAgo`                 | read {age}                                                                                                                                                                                                                                      |
| `notRead`                 | Not read                                                                                                                                                                                                                                        |
| `notReadLabel`            | Quota not read from AWS                                                                                                                                                                                                                         |
| `lastRead`                | last read {age}                                                                                                                                                                                                                                 |
| `neverRead`               | never read                                                                                                                                                                                                                                      |
| `toGo`                    | {n} vCPU to go                                                                                                                                                                                                                                  |
| `over`                    | Over 70%                                                                                                                                                                                                                                        |
| `overBy`                  | {n} vCPU past it                                                                                                                                                                                                                                |
| `atThreshold`             | at 70% exactly                                                                                                                                                                                                                                  |
| `spare.title`             | Motir spare                                                                                                                                                                                                                                     |
| `spare.none`              | No Motir spare for this kind yet.                                                                                                                                                                                                               |
| `spare.ready`             | Ready to join                                                                                                                                                                                                                                   |
| `spare.waiting`           | Waiting for quota                                                                                                                                                                                                                               |
| `spare.granted`           | granted · read {age}                                                                                                                                                                                                                            |
| `spare.notRead`           | Quota not read · {when}                                                                                                                                                                                                                         |
| `spare.readyBody`         | Not counted in capacity. It joins the shared pool the next time an account passes 70%, and a new spare is created behind it.                                                                                                                    |
| `spare.raisingBody`       | A raise to {n} vCPU was asked {age} and is still open. The spare joins the shared pool once AWS grants it.                                                                                                                                      |
| `spare.notReadBody`       | Its quota is not read, so it is not counted as ready. Growth promotes it only once a granted quota has been read.                                                                                                                               |
| `requests.title`          | Quota raises asked of AWS                                                                                                                                                                                                                       |
| `requests.count`          | {count, plural, one {# request} other {# requests}} · {open} open                                                                                                                                                                               |
| `requests.none`           | none                                                                                                                                                                                                                                            |
| `requests.empty`          | No quota raise has been asked of AWS for this kind.                                                                                                                                                                                             |
| `requests.col.*`          | Account · Value asked · Status · Granted · Asked · Last read from AWS                                                                                                                                                                           |
| `requests.status.*`       | Open · pending · Open · case opened · Approved · Denied · Not approved · Case closed · Invalid request                                                                                                                                          |
| `requests.notYet`         | Not yet                                                                                                                                                                                                                                         |
| `requests.notGranted`     | Not granted                                                                                                                                                                                                                                     |
| `requests.quotaStays`     | quota stays {n} vCPU                                                                                                                                                                                                                            |
| `requests.quotaUnchanged` | quota unchanged                                                                                                                                                                                                                                 |
| `requests.notReadYet`     | not read yet                                                                                                                                                                                                                                    |
| `requests.foot`           | Showing {from}–{to} of {total} · open first, then newest                                                                                                                                                                                        |
| `requests.pagerLabel`     | {kind} quota raises pages                                                                                                                                                                                                                       |
| `events.title`            | Growth events · 70% reached                                                                                                                                                                                                                     |
| `events.count`            | {count, plural, one {# event} other {# events}}                                                                                                                                                                                                 |
| `events.empty`            | No growth events yet — no account of this kind has reached 70%.                                                                                                                                                                                 |
| `events.col.*`            | When · Triggering account · Its use · Outcome                                                                                                                                                                                                   |
| `events.use`              | {used} of {granted} vCPU                                                                                                                                                                                                                        |
| `events.usePercent`       | {p}% of its granted quota                                                                                                                                                                                                                       |
| `events.accountRemoved`   | account removed                                                                                                                                                                                                                                 |
| `events.outcome.*`        | Spare promoted · Account created · Waiting for quota · Refused                                                                                                                                                                                  |
| `events.promoted`         | {spare} joined the shared pool                                                                                                                                                                                                                  |
| `events.promotedNew`      | {spare} joined the shared pool; new spare {created} being created                                                                                                                                                                               |
| `events.created`          | {created} added, with no spare to promote                                                                                                                                                                                                       |
| `events.waiting`          | the spare’s raise is still open, so nothing joined yet                                                                                                                                                                                          |
| `events.awsSaid`          | AWS said: “{reason}”                                                                                                                                                                                                                            |
| `events.refusedNote`      | no account was added; the next pass tries again after a backoff                                                                                                                                                                                 |
| `events.foot`             | Showing {from}–{to} of {total} · newest first                                                                                                                                                                                                   |
| `events.pagerLabel`       | {kind} growth events pages                                                                                                                                                                                                                      |
| `readOnly`                | Read-only. To ask AWS for more quota, run {command} at a terminal.                                                                                                                                                                              |

Reused from `platformAdmin.monitoring.fleet` (shipped, with their zh twins): `prev`, `next`,
`pageOf`, `ago`, `duration.*`.

## Colour and shape roles (`--el-*` only)

| element                                               | role                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| section title · block title · figures · account cells | `--el-text`                                                                                                           |
| subtitles · labels · sub-lines · Not available · ages | `--el-text-secondary` (AA on the white card, `--el-surface-soft` and every surface)                                   |
| account and spare names                               | `--el-text-identifier`, mono                                                                                          |
| Provider statement                                    | Runs on AWS: `Pill severity="info"` (`--el-tint-sky`); Runs on Fly: `Pill tone="neutral"`                             |
| Over-70 mark · rail                                   | `Pill severity="warning"` (`--el-tint-peach` + `--el-text-strong`); rail `--el-warning`, 3px                          |
| Not-read mark · Waiting · Open statuses               | `Pill tone="awaiting"` (`--el-tint-yellow` + `--el-text-strong`)                                                      |
| Ready · Approved · Spare promoted · Account created   | `Pill severity="success"` (`--el-tint-mint`)                                                                          |
| Denied · Not approved · Invalid · Refused             | `Pill severity="danger"` (`--el-tint-rose`); AWS's reason `--el-danger-on-surface`; event rail `--el-danger`          |
| Use bar                                               | track `--el-surface`, fill `--el-accent`, at or past 70% `--el-warning`, tick `--el-text-secondary`; `--radius-badge` |
| Spare line box                                        | `--el-surface-soft`, `--el-border-soft`, `--radius-card`, `--spacing-card-padding-12`                                 |
| Mini stats · cards · icon tile                        | the shipped MiniStat / `Card` / `CardHead` (`--el-border-soft`, `--radius-card`, `--el-tint-lavender` tile)           |
| Command chip                                          | `--el-muted` + `--el-text`, `--radius-control`, `--spacing-kbd-x/y`                                                   |
| Skeleton                                              | `--el-muted`, `--radius-card` (tiles) / `--radius-control` (lines)                                                    |

## Accessibility contract

- **Every mark has text.** Over 70%, Not read, Ready to join, Waiting for quota, each status and
  each outcome is a word in its pill; glyphs are `aria-hidden`. Rails and bars are graphics beside
  the word and never the only signal; the Use bar is `aria-hidden` and its percent is in text.
- **The Not-read mark carries `aria-label="Quota not read from AWS"`**, and its last-read time is
  text beside it.
- **Lists are tables with headers**: `<th scope="col">` on every column; the sorted column carries
  `aria-sort="descending"` (Asked on requests, When on events). Each list has a visible title
  (`h4`) and its count in text.
- **Headings follow the page**: the section `h2` _Pools_, each block's `h3` _Pool · {kind}_, each
  list's `h4`.
- **Errors announce**: the Block error is `role="alert"`, inside its card. A loading block is
  `aria-busy="true"` with one `role="status"` sentence.
- **Focus order follows block order**: CI runner, Agent runner, Indexer, Agent hoster; within a
  block, the request pager then the event pager. Pager links carry an `aria-label`ed `nav`
  (_{kind} quota raises pages_ / _{kind} growth events pages_) and the visible focus ring
  (`--focus-ring-color`); a disabled end is `aria-disabled="true"`.

## What this amendment does NOT draw

- **Any action**: filing, retrying, promoting, pausing or changing a ceiling stay the
  `fleet-admin` commands and the shard controls that own them.
- **The shipped sections** — health cards, Overdue schedules, Index allowance, Fleet — unchanged.
- **A Host organisation's own accounts**, any tenant-facing view, and any measurement or alert.
- **A `.png` export** — retired (AMENDMENT 4).

# AMENDMENT 2026-10-28 — Jobs

**Design system (step 1, read before drawing).** `package.json` depends on `@motir/design-system`
(`workspace:*`, the in-repo package `packages/design-system`), and `app/globals.css` imports
`@motir/design-system/theme.css`: **on Motir Design, branch (a).** The console renders the default
axes `warm-editorial` · `motir` · `motir`. The mock is built with `renderMock` from
`@motir/design-system/mock` at those axes, from the package's `Button`, `Pill`, `EmptyState`,
`ErrorState` and `SectionLabel`. The Sidebar row, the Combobox trigger and menu, the Modal panel and
the Toast item are drawn in place with their shipped classes, because their portals do not render
to static markup. The table anatomy is the workspace jobs dashboard's own (`Th`, `Td`, the table
shell, the status chips). No part is missing from the package, so nothing is proposed as an
addition.

**Mock:** `design/platform-admin/console--jobs.mock.html` — a DELTA mock. It ADDS one page,
`/admin/jobs`, and one row in the console's Operations sidebar. It amends no drawn panel:
`design/platform-admin/console.mock.html` and the workspace ledger's mocks under `design/jobs/`
stand as records. This section is the asset's whole specification, and the published design result
is its authority: the page and its sidebar row are built only after that result is approved,
because they put a write (replaying another tenant's work) in front of platform staff.

**Verified on the default branch before drawing:**

- `app/(admin)/layout.tsx` and `app/(admin)/_components/AdminShell.tsx` draw the console shell.
  Operations lists Monitoring, Fleet settings (superadmin), Provider capacity, AI planning,
  Hosted-run models, Planning lessons, Ideas and Audit log (superadmin). Its labels come from
  `platformAdmin.shell.*`.
- `app/(admin)/admin/monitoring/page.tsx` is the header pattern: a secondary breadcrumb
  _Platform · Monitoring_, a serif `h1`, one secondary sentence. The page is
  `requirePlatformStaffPage('support')` with `dynamic = 'force-dynamic'`.
- `lib/services/jobsDashboardService.ts` already reads every run (`listSystemRuns`, paged by 50) and
  the system dead letters (`listSystemDlq`, capped at 200, replayed rows kept 7 days).
  `lib/jobs/platformStanding.ts` sets the reading role to **support** and the replay role to
  **operator**.
- `lib/dto/jobs.ts`: a run's status is one of `running`, `succeeded`, `failed` or `abandoned`. A
  dead letter has a function, an event, an optional workspace, a failure, its attempts, its last
  failure time and `replayedAt`. **There is no column recording who replayed it**; who replayed is
  in the platform audit log.
- `app/(authed)/settings/workspace/jobs/_components/JobsDashboard.tsx` is the workspace manager's
  ledger, whose tab strip, status chips, table and Replay button this page reuses as anatomy (it
  does not import the component).

## What this section is

One place where platform staff see **every background job the platform ran, in every workspace and
in none**, and **every dead letter waiting**, and where an operator replays them: one at a time, or
every waiting dead letter of one function at once. It supersedes, for staff, the system
dead-letter view drawn in `design/jobs/design-notes.md` § System dead letters. That view is a
workspace manager's page and only ever showed rows with no workspace.

## The access path (Panel 1)

A new sidebar row, **Jobs** (lucide `Workflow` glyph), under **Operations**, directly after
**Monitoring**. It links to `/admin/jobs` and is selected on `/admin/jobs` and below. Its states are
the shipped Sidebar row's: default, hover, keyboard focus and selected. Every platform staff role
sees the row; the page itself answers 404 to anyone else, as its peers do.

## Elements — each named once

| Name                  | What it is                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Page header**       | Breadcrumb _Platform · Jobs_ (secondary, uppercase), `h1` _Jobs_ (serif), one secondary sentence.                                                                                                                                                                                                                                                                                                          |
| **Tabs**              | A tab strip with **Runs** and **Dead letters**. Dead letters carries a neutral count Pill of the waiting dead letters (`aria-label` _{n} waiting_). The tab is a link: `?tab=runs` / `?tab=dlq`.                                                                                                                                                                                                           |
| **Status filter**     | Chips **All · Running · Succeeded · Failed · Abandoned**, the shipped run statuses. A chip is a link (`?status=`), the current one `aria-current="true"`. There is no _dead-lettered_ run status; dead-lettered work lives on the Dead letters tab.                                                                                                                                                        |
| **Runs table**        | Function (mono) · Event (secondary) · Workspace · Status (`Pill`: Running info, Succeeded success, Failed danger, Abandoned warning) · Attempt · Started (relative, secondary) · Duration (_—_ while running). Newest first.                                                                                                                                                                               |
| **Workspace cell**    | The workspace's name. A run or dead letter with no workspace shows the neutral Pill **No workspace**. Where the read gives only the workspace id, the id shows in mono instead of the name.                                                                                                                                                                                                                |
| **Pager**             | _Page {n}_ (secondary) and secondary **Previous** / **Next** buttons, 50 rows a page; an end that has no page is disabled. Links keep the tab and status (`?page=`).                                                                                                                                                                                                                                       |
| **Read-only notice**  | For support (below operator) on the Dead letters tab: a `role="note"` box on `--el-tint-sky` with an Info glyph and _Read-only. Replaying a dead letter needs the operator role._ No Replay button and no Replay all are drawn for this role.                                                                                                                                                              |
| **Function filter**   | The Combobox trigger, 20rem, reading **All functions** or the chosen function (mono). Its menu lists **All functions** then one option per function that has a waiting dead letter, each with its waiting count at the right, most waiting first. The menu scrolls past its height. `?fn=` holds it.                                                                                                       |
| **Waiting line**      | Beside the filter: _{n} waiting · {m} replayed in the last 7 days_ (secondary).                                                                                                                                                                                                                                                                                                                            |
| **Dead-letter table** | Function · event (the function in mono, the event under it in secondary) · Workspace · Failure (one line, truncated; the full message is the cell's `title`) · Attempts · Last failed · the row's Replay. Newest failure first, at most 200 rows, then _Showing {shown} of {n}. The list shows the newest 200._                                                                                            |
| **Row Replay**        | Operator only. `Button` secondary, small, `RotateCcw` glyph, **Replay**, `aria-label` _Replay {function} dead letter_. While it runs the button shows its spinner and is busy. A replayed row turns secondary and shows the neutral Pill _Replayed {time}_ in place of the button; support sees the same Pill in that column.                                                                              |
| **Replay all**        | Operator only, and only when one function is chosen and it has waiting dead letters: `Button` secondary, small, **Replay all {n}**, at the right of the filter row. It opens the Replay-all dialog.                                                                                                                                                                                                        |
| **Replay-all dialog** | The Modal panel as an `alertdialog`. Confirm: title _Replay {n} dead letters of {function}?_, the sentence below, **Cancel** (ghost, the initial focus) and **Replay {n}** (primary). Running: the same title, no close button, Cancel disabled, the primary busy (_Replaying…_), and a `role="status"` line. Result: _Replay finished_ or _Replay finished with failures_, the counts as lines, **Done**. |
| **Toasts**            | After a row Replay: success _Dead letter replayed_, info _Already replayed_, error _The replay failed_ (each with its sentence).                                                                                                                                                                                                                                                                           |
| **Empty and error**   | `EmptyState` and `ErrorState` in place of a table (copy below). Loading is the table header over four `--el-muted` skeleton rows, `aria-busy="true"`.                                                                                                                                                                                                                                                      |

## The panels

| #   | Panel                          | What it shows                                                                                                              |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sidebar                        | The Operations section with the Jobs row default, hovered, keyboard-focused and selected.                                  |
| 2   | Runs                           | The page in place: header, tabs, status chips on All, six runs across every status, three with no workspace, page 1.       |
| 3   | Runs, filtered, empty          | Failed chosen, nothing matches.                                                                                            |
| 4   | Runs, loading and error        | The skeleton table; the error state with Try again.                                                                        |
| 5   | Runs at scale                  | Page 4 with both pager buttons live, a long function name and a long workspace name.                                       |
| 6   | Dead letters, support          | The Read-only notice, the filter, and the table with no Replay button; one row already replayed shows its Pill.            |
| 7   | Function filter open           | Operator, the menu open over the table: All functions (164) and six functions with their counts.                           |
| 8   | Function filter, long list     | Ten functions; the menu scrolls inside its height.                                                                         |
| 9   | One function chosen            | `system.platform-meter-report` with **Replay all 109** and the _Showing_ line.                                             |
| 10  | Row Replay                     | In flight; replayed (the row turns secondary, the button is gone); the three toasts.                                       |
| 11  | Replay all, confirm            | The alert dialog with Cancel first.                                                                                        |
| 12  | Replay all, running            | The dialog cannot be closed; one server call, so the line states the batch size rather than a per-row count.               |
| 13  | Replay all, result             | 108 replayed and 1 already replayed; a repeat that found all 108 already replayed; 104 replayed, 1 already, 4 failed.      |
| 14  | Dead letters, empty and states | Nothing waiting; nothing waiting for the chosen function (no Replay all); loading; error.                                  |
| 15  | Dark                           | Panel 9 with a replayed row, and the partial-failure result, under `data-theme="dark"` (a nested `data-appearance-scope`). |

## Rules the drawing holds

- **Reading is support; every replay is operator.** Support sees both tabs and the notice; it never
  sees a Replay button or Replay all. The server refuses a replay below operator whatever the page
  draws.
- **Replay all acts on one function only**, and only its waiting dead letters. It is never offered
  for All functions.
- **A replay is never undone and never repeated.** A dead letter someone else replayed first is
  counted as _already replayed_ and not sent again. Each replay is written to the platform audit
  log; the page shows _Replayed {time}_ and does not name who.
- **Replay all is one server call** that works through the dead letters 50 at a time. The dialog
  stays open and cannot be dismissed while it runs, and shows no per-row progress, because the
  server reports only when it finishes.
- **After Replay all, Done reloads the list.** When the chosen function has nothing left waiting it drops out of the Function filter and the filter returns to **All functions**; opening a function with nothing waiting by its link shows the empty state of Panel 14.
- **A partial failure leaves the failed dead letters in the list** to be replayed one by one.
- **Workspace rows are replayable here.** This is the one door staff use to replay a workspace's
  dead letter.

## Copy (en — `platformAdmin.shell.navJobs` and a new `platformAdmin.jobs` namespace; the build adds every locale)

| key                           | en                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `shell.navJobs`               | Jobs                                                                                                                                |
| `jobs.breadcrumb`             | Platform · Jobs                                                                                                                     |
| `jobs.title`                  | Jobs                                                                                                                                |
| `jobs.subtitle`               | Every background job the platform ran, in every workspace and in none, and every dead letter waiting for a replay.                  |
| `jobs.tabs.runs`              | Runs                                                                                                                                |
| `jobs.tabs.dlq`               | Dead letters                                                                                                                        |
| `jobs.tabs.waiting`           | {count} waiting                                                                                                                     |
| `jobs.status.*`               | All · Running · Succeeded · Failed · Abandoned                                                                                      |
| `jobs.columns.*`              | Function · Event · Function · event · Workspace · Status · Attempt · Attempts · Started · Duration · Failure · Last failed · Replay |
| `jobs.noWorkspace`            | No workspace                                                                                                                        |
| `jobs.pageLabel`              | Page {page}                                                                                                                         |
| `jobs.previous` · `jobs.next` | Previous · Next                                                                                                                     |
| `jobs.runsEmpty.title`        | No runs yet / No {status} runs                                                                                                      |
| `jobs.runsEmpty.body`         | Nothing in the ledger has this status. Choose All to see every run.                                                                 |
| `jobs.runsError.title`        | The job ledger could not be read                                                                                                    |
| `jobs.error.body`             | The database did not answer. Nothing was changed.                                                                                   |
| `jobs.retry`                  | Try again                                                                                                                           |
| `jobs.readOnly`               | Read-only. Replaying a dead letter needs the operator role.                                                                         |
| `jobs.fn.all`                 | All functions                                                                                                                       |
| `jobs.fn.label`               | Function                                                                                                                            |
| `jobs.waitingLine`            | {waiting} waiting · {replayed} replayed in the last 7 days                                                                          |
| `jobs.capped`                 | Showing {shown} of {count}. The list shows the newest 200.                                                                          |
| `jobs.replay`                 | Replay                                                                                                                              |
| `jobs.replayAria`             | Replay {function} dead letter                                                                                                       |
| `jobs.replayedAt`             | Replayed {time}                                                                                                                     |
| `jobs.toast.replayed`         | Dead letter replayed — {function} was sent again.                                                                                   |
| `jobs.toast.already`          | Already replayed — Someone replayed this dead letter first. Nothing was sent again.                                                 |
| `jobs.toast.failed`           | The replay failed — Nothing was sent. Try again.                                                                                    |
| `jobs.replayAll.button`       | Replay all {count}                                                                                                                  |
| `jobs.replayAll.title`        | Replay {count} dead letters of {function}?                                                                                          |
| `jobs.replayAll.body`         | Each one is sent again as a new run and written to the platform audit log. A dead letter someone else replays first is skipped.     |
| `jobs.replayAll.confirm`      | Replay {count}                                                                                                                      |
| `jobs.replayAll.cancel`       | Cancel                                                                                                                              |
| `jobs.replayAll.running`      | Replaying… · Replaying {count} dead letters, 50 at a time. Keep this open until it finishes.                                        |
| `jobs.replayAll.done`         | Replay finished · Replay finished with failures                                                                                     |
| `jobs.replayAll.replayed`     | {count} replayed                                                                                                                    |
| `jobs.replayAll.already`      | {count} already replayed by someone else                                                                                            |
| `jobs.replayAll.nothingLeft`  | 0 replayed — all {count} were already replayed                                                                                      |
| `jobs.replayAll.failed`       | {count} could not be replayed. They stay in the list; replay them one by one.                                                       |
| `jobs.replayAll.close`        | Done                                                                                                                                |
| `jobs.dlqEmpty.title`         | Nothing waiting                                                                                                                     |
| `jobs.dlqEmpty.body`          | No job has run out of attempts. Dead letters appear here when one does.                                                             |
| `jobs.dlqEmptyFn.title`       | Nothing waiting for {function}                                                                                                      |
| `jobs.dlqEmptyFn.body`        | Its dead letters were all replayed. Choose All functions to see the rest.                                                           |
| `jobs.dlqError.title`         | The dead letters could not be read                                                                                                  |

Counts use ICU plurals in the build. Function names, event names, workspace names and failure
messages are data and are not translated.

## Colour and shape roles (`--el-*` only)

| element                                                              | role                                                                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| title · table cells · function names                                 | `--el-text` (function names mono)                                                                                                                                          |
| breadcrumb · subtitle · events · times · waiting line · replayed row | `--el-text-secondary` (AA on every surface)                                                                                                                                |
| Sidebar row                                                          | the shipped Sidebar row: `--el-sidebar-item-bg-active` / `-hover`, `--el-icon-active` / `--el-icon-muted`, `--radius-control`, `--spacing-control-x/y`, `--height-control` |
| Tabs                                                                 | active `--el-accent` underline + `--el-text`; inactive `--el-text-muted` on the white page only                                                                            |
| Status chips                                                         | `--radius-badge`, `--spacing-chip-x/y`; current `--el-accent` border, `--el-tint-lavender`, `--el-text-strong`                                                             |
| Status pills · No workspace · count                                  | `Pill` severities (tints + `--el-text-strong`) · `Pill tone="neutral"`                                                                                                     |
| Table shell                                                          | `--radius-card`, `--el-border`; header row `--el-surface` with `--el-text-secondary` labels; row hover `--el-surface`                                                      |
| Read-only notice                                                     | `--el-tint-sky`, `--el-border-soft`, `--el-text-strong`, `--radius-card`, `--spacing-card-padding-12/-8`                                                                   |
| Function filter                                                      | Combobox trigger and menu: `--radius-input`, `--height-control`, `--radius-card` menu, `--shadow-elevated`, `--el-option-active-bg`; counts `--el-text-secondary`          |
| Buttons                                                              | `Button` secondary small (Replay, Replay all, pager), primary / ghost in the dialog                                                                                        |
| Dialog                                                               | the Modal panel: `--radius-modal`, `--shadow-modal`, `--spacing-card-padding`, scrim `--el-overlay-scrim`                                                                  |
| Result glyphs                                                        | replayed `--el-success`, already `--el-info`, failed `--el-danger-on-surface`; each beside its words                                                                       |
| Toasts                                                               | the Toast item: border `--el-success` / `--el-info` / `--el-danger`                                                                                                        |
| Skeleton                                                             | `--el-muted`, `--radius-control`                                                                                                                                           |

## Accessibility contract

- **Tabs** are a `tablist` of links with `aria-selected`; the count on Dead letters has an
  `aria-label`. Status chips are a labelled `group` with `aria-current` on the current chip.
- **Tables have headers** (`<th scope="col">`); the replay column's header is visually hidden
  (_Replay_). Every Replay button names its function in its `aria-label`.
- **The Function filter is the Combobox**: `role="combobox"` with `aria-label` _Function_, a
  `listbox` of options with `aria-selected`; counts are text in the option.
- **Replay all is an `alertdialog`** with Cancel as the initial focus. While it runs it cannot be
  dismissed (Esc and outside clicks are ignored) and its line is `role="status"`; the result's
  counts are a `role="status"` list, and focus moves to Done.
- **Every outcome is in words**: pills, the replayed line, toast titles and result lines. Glyphs are
  `aria-hidden`.
- **Loading** is `aria-busy="true"` with an `aria-label`; the error state's Try again reloads.

## What this amendment does NOT draw

- **The workspace manager's ledger** (`/settings/workspace/jobs`) — unchanged.
- **Who replayed a dead letter**: no column records it; it is in the platform audit log.
- **A per-row progress count** for Replay all, a cancel once it has started, or a replay of a run
  that did not dead-letter.
- **A `.png` export** — retired (AMENDMENT 4).
