# Org administration — design notes

Design reference for the **`org-admin`** UI area — the **organization (root
tenancy tier) administration surfaces** (Story 6.10). The asset is the source of
truth for every UI subtask in Story 6.10. Built FROM the real design system
(`app/globals.css` `--el-*` colour tokens + `[data-display-style]` shape tokens +
the shipped `components/ui/*` primitives), so the code subtask composes the same
primitives — no Pencil→code gap.

| Surface                                           | Asset                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Org switcher + settings + members**             | **`org-admin.mock.html`** (HTML mockup)       | The whole org-admin surface — no `design/org-admin/` asset existed; the 6.10.1 design gate produces this. Multi-panel: switcher (single/multi-org) · settings · paginated members · role+invite · empty/loading/error/forbidden. **Gates 6.10.5.**                                                                                                                                                                                                                                 |
| **Members seat/billing affordances (scaled org)** | **`members-billing.mock.html`** (HTML mockup) | The **seat layer added onto the shipped Members page** for a SCALED org (Story 8.1 · 8.1.13 / MOTIR-1260): seat summary band, add-member prorated-charge note, remove-member prorated-credit confirm, free/self-host unchanged, `past_due`, non-admin. Cloud-only + scaled-only. **Gates 8.1.14 / MOTIR-1261.** See [§ Members seat / billing affordances](#members-seat--billing-affordances-scaled-org--story-81--8113) below.                                                   |
| **Require-2FA policy control (org + workspace)**  | **`security-policy.mock.html`** (HTML mockup) | The require-2FA control as BOTH tenancy tiers render it, plus its two access paths and the §6d fold-in (Story 8.13 · 8.13.1 / MOTIR-3642). Multi-panel: org menu · settings rail (above and below the reveal threshold) · off · on · **locked on, mandated above** · on-here-and-above · fold-in · refused · arrival · dark. **Gates 8.13.5 (MOTIR-3646) and 8.13.6 (MOTIR-3647).** See [§ The require-2FA policy control](#the-require-2fa-policy-control-story-813--8131) below. |

## What this area is

Story 6.10 introduces the missing **top tenancy tier** above the workspace — the
**`Organization`** (the root account a customer signs up as, the parent of N
workspaces, and the **billing entity** credits + usage roll up to). It is
**auto-created at signup and renameable**; every customer is an org from day one,
so a one-person company (**OPC**) and an enterprise share one model and one set
of surfaces — the difference is purely **progressive disclosure** (see the rule
below), not a separate "individual" product. The org-admin surfaces are the
**tenant** owner/admin's controls for that tier:

- the **org switcher** in the app shell,
- **org settings** (name / slug / metadata),
- **cross-workspace member management** (the roster across all the org's
  workspaces, with an org-scoped role and add / remove / change-role).

A NEW org-scoped `OrganizationRole` (**owner / admin / member**) sits **above**
the 6.4 workspace `MemberRole`: an org owner/admin administers the org and is
granted admin on **every** workspace under it; an org member belongs to the org
but is governed inside each workspace by their workspace role.

**Membership direction is ASYMMETRIC (Yue).** Adding a user to a **workspace**
auto-creates their **org membership** (you can't be in a workspace without being
in its org — the upward invariant). Adding a user to the **org** does **not** put
them in any workspace: a plain org member reaches only the workspaces they're
**explicitly** added to (an org owner/admin still spans all _by role_). So an
**"org-only" member in zero workspaces is a valid state** (e.g. a billing admin) —
the roster shows "No workspaces" for them. Removing someone from the org revokes
all their workspace access; removing them from a workspace leaves the org
membership intact.

### Mirror product (rung 1 — cited, not asserted)

- **Atlassian / Jira Cloud** — the Organization is the topmost structure; it
  controls licensing, **billing** and security across sites. The **org admin** is
  the highest level of admin and the one who sees billing; site admins below do
  not. All org administration (users, billing, multiple sites) lives at
  `admin.atlassian.com` — a **distinct admin area** from a single site's
  settings. (Atlassian Community "Jira's Structure — Orgs, Sites, Spaces";
  Atlassian Support "types of admin roles".)
- **Linear** — a workspace is "the home for all issues in an organization"; the
  workspace **Owner** holds the org-root settings (members, billing, security);
  members belong to one-or-many teams under the root. Billing sits at the
  org/workspace **root**. (Linear Docs — Workspaces; Members and roles.)

Motir's `Organization` = the Atlassian org / Linear workspace-root (the
billing + identity root); Motir's `Workspace` ≈ an Atlassian site / a Linear
team-container under it.

### ⚠️ Out of scope here (named, NOT drawn)

- **Billing / credit / usage.** The org is the billing entity (Yue, locked), but
  6.10 ships **no** billing surface. The org-scoped usage/credit **view is
  7.12.5**; checkout/pricing is **Epic 8**. Org settings draws only a **passive
  "billing lives here later" placeholder** (the "Billing & usage" card with a
  "Coming soon" pill and a dashed note) — no active control.
- **The cross-ORG platform-staff superadmin console** that reads ACROSS all orgs
  is **Epic 10 / 10.1** — a SEPARATE platform-staff concept. This area is the
  **tenant** org-admin (the customer administering their own org), NOT that
  console.

---

## ⚠️ Progressive disclosure — the governing rule of the shell chrome

The data model **always** carries all three tiers (`Organization → Workspace →
Project`), auto-created at signup, so there is **never a migration** as a
customer grows. The **UI reveals a tier only when it offers a choice** — i.e.
when its count is at least two. "Scale" is not a mode the product detects; it
emerges from counts. There is **no "individual" branch**: a one-person company
(**OPC**) is just an organization with one member.

| Tier             | When it shows in the header                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Organization** | **Always** — the top-left anchor (a `Button` + `ChevronDown` opening its menu). Auto-created at signup, renameable. The menu's **"Switch organization" section appears only when the account belongs to ≥2 orgs.** |
| **Workspace**    | **Hidden until the org has a 2nd workspace.** One workspace is implicit and never shown. At ws #2 the workspace switcher appears to the RIGHT of the org (`Acme › Engineering`).                                   |
| **Project**      | **Always** — in the sidebar header (1.5.3), unchanged. Switching the workspace re-scopes it.                                                                                                                       |

So **only two count-driven reveals exist**: the workspace switcher at ws #2, and
the org menu's switch-org section at org #2. The same components render every
scale — OPC, small org, multi-workspace org, multi-org enterprise — by hiding any
tier whose count is 1. (Mirror: Atlassian shows the org picker "only when you
have more than one"; Linear's single-workspace view is equally clean.)

## Where it lives

- **Org control** — a new client component (mirror
  `app/(authed)/_components/WorkspaceSwitcher.tsx`) rendered in the **TopNav**
  (`app/(authed)/_components/TopNav.tsx`) as the **leftmost** anchor, ALWAYS
  present. It is a menu button (org avatar + name + `ChevronDown`), not only a
  switcher: the menu carries **Settings · Members · Billing & usage (Coming
  soon) · New workspace**, then — **only when the account is in ≥2 orgs** — a
  **"Switch organization"** section (the org list + **Create organization**).
- **Workspace switcher** — the shipped `WorkspaceSwitcher`, rendered to the
  RIGHT of the org with a `›` separator (`--el-text-faint`) **only when the
  active org has ≥2 workspaces**. Below that threshold it is not rendered at
  all. So the header reads `Acme` (1 ws) → `Acme › Engineering` (2+ ws).
- **Settings — collapsed at one workspace, but the workspace tier still does
  the work underneath.** The data is ALWAYS 3 tiers, and **workspace-scoped
  config keeps living on the `Workspace` row** (workflows, statuses, custom
  fields, labels, components, automation, dashboards, saved filters, workspace
  members — all `workspaceId`-scoped in the schema today). What collapses is
  only the _surface_:
  - **At ONE workspace:** a **single Settings area**, entered from the org menu,
    that renders **both** the org-scoped sections (org name / slug / billing
    placeholder / org members / danger zone) **and** the workspace-config
    sections — and **each section persists to its own tier underneath** (org →
    `Organization`, workspace-config → the single `Workspace`). The org settings
    "pass through" to the workspace's settings; there is **no separate
    `/settings/workspace` surface shown**, but the workspace settings are still
    the underlying mechanism being written. This avoids showing a small team an
    org-vs-workspace split that is 1:1 for them.
  - **At ≥2 workspaces:** the workspace-config sections **split out** into a
    per-workspace Settings surface (scoped by the active workspace), and the org
    Settings page keeps only the org-scoped sections. The existing workspace's
    data does not move; the **new** workspace is **seeded by copying the source
    workspace's config at creation** (see below).
  - **"Inherit" is a BEHAVIOURAL ILLUSION, not a data relationship — there is NO
    org→workspace config inheritance in the model.** Config is purely
    `Workspace`-scoped; there are no org-level config defaults, no override rows,
    and no runtime resolution. The inherited _feel_ is achieved by
    **copy-on-create**: when a 2nd (or Nth) workspace is created, its config is
    **seeded by copying the source workspace's** workflows / statuses / fields /
    labels / components / automation / dashboards, so it opens already configured
    like the first one. After that the workspaces are fully independent — either
    can "overwrite" freely, with no link back. (Deliberately simpler than Jira's
    shared-scheme live inheritance; we get the consistent-defaults UX without the
    two-level config machinery. If real live inheritance is ever needed for
    enterprise, it's an additive future change, not a migration.)
  - Suggested routes: `app/(authed)/settings/organization/page.tsx` (org-scoped:
    general + billing placeholder + danger zone) and
    `app/(authed)/settings/organization/members/page.tsx` (the paginated roster);
    the existing `app/(authed)/settings/workspace/*` is the workspace-config
    surface that is **folded into** the org Settings page at one workspace and
    **re-surfaced standalone** at ws ≥ 2.

    ⚠️ **GATED PER SECTION, NOT PER PAGE** (MOTIR-3519 · `organization-tier.md`
    §6d). This line previously read "All org-owner/admin gated", four lines below
    the fold-in it describes — so the host refused the very people whose sections
    were being folded into it. A workspace invitee is a plain org `member`, and
    the collapse would have left them no route to their team roster and **no route
    to Leave workspace at all**. The corrected rule:
    - **org-scoped** sections (org name, billing, org danger zone, the roster) —
      org **owner/admin** only; a plain org member gets panel 5d's forbidden
      treatment **for those sections**, which is what 5d means once the page hosts
      two tiers;
    - **folded-in workspace** sections — any member **of that workspace**, the same
      gate the standalone area applies at ws ≥ 2 (rename and delete are
      membership-gated, not admin-gated, so this widens nothing);
    - **non-member of the org** — 404, never 403, unchanged.

    The general form, which every surface built on §6 inherits: **relocating a
    surface preserves its gate.** A hidden tier may change what the product NAMES,
    never what a user may DO.

The page shells reuse the `/items` + workspace-settings grammar: a serif `h2`
title + a muted subtitle, then a `stack` of `Card`s.

---

## Panels (review EACH — mistake #31)

### Panel 1 — progressive disclosure in the shell

The panel is a **ladder** demonstrating the count-driven reveal (above), not a
single switcher state:

- **A · 1 org · 1 workspace (top-left).** The header shows **only the org**
  (`Acme ▾`) as the top-left anchor; the **workspace is not shown at all**. The
  sidebar header carries the **project** switcher (`Mobile App ▾`). _This is the
  identical header for an OPC and for a 10-person small org — there is no
  individual mode._
- **B · 2+ workspaces (top-right).** The workspace switcher has appeared to the
  RIGHT of the org with a `›` separator (`Acme › Engineering`). This is the ONLY
  thing that surfaces the middle tier. Switching it re-scopes the sidebar project
  switcher.
- **C · the `Acme ▾` org menu, open (bottom).** One menu behind the org name:
  - **Settings · Members · Billing & usage (Coming soon) · New workspace** ("Adds
    the workspace switcher" — the discoverable path to reveal tier 2),
  - then a separator and the **"Switch organization"** section — **rendered only
    when the account is in ≥2 orgs**: one row per org with a `Check`
    (`--el-accent`, on the active org) + org avatar + "{n} workspaces" + the
    viewer's **org-role `Pill`**, plus **Create organization**.

**The load-bearing rule:** org is permanent top-left chrome; workspace is hidden
until ws #2; the org's switch-org list is hidden until org #2. (No "quiet label
vs dropdown" branch — the org is always a menu button; what its menu _contains_
is what scales.)

### Panel 2 — org settings (populated)

A `stack` of three `Card`s on the org-scoped settings page:

- **General** — `Input` fields: **Organization name**, **Contact email**.
  A header `Pill pill-owner` ("You're an owner"). Card foot: a "{n} workspaces ·
  {n} members" summary + a primary **Save changes** button.
  > **Amended 2026-08-10 (MOTIR-2548).** This card also drew an **Organization
  > URL** row — `motir.co/` + the slug, read-only, with a lowercase/hyphen hint.
  > It is removed. `docs/decisions/organization-url.md` records why: Motir does
  > not adopt organization-addressable URLs, nothing in the product resolves
  > `motir.co/<slug>`, and the row's own helper text ("used in links to this
  > organization") described a capability that does not exist.
  > `Organization.slug` survives as an internal column — it is simply no longer
  > a value anyone is shown.
- **Billing & usage** — the **PASSIVE placeholder** (a "Coming soon" neutral
  `Pill` + a dashed `note` reading that billing/credits/usage land later — org
  usage view 7.12.5, checkout Epic 8 — with **no active control**). This card
  exists so the layout stays stable when billing lands; it is NOT a billing UI.
- **Danger zone** — a destructive "Delete organization" `secondary`/`danger`
  button + the irreversibility copy (header in `--el-danger-text`).

**At one workspace, this page also folds in the workspace-config sections**
(workflows, statuses, custom fields, labels, components, automation, dashboards
— the existing `settings/workspace/*` surfaces), rendered below the org-scoped
cards as the same `stack` grammar. They are NOT redrawn in this org-admin asset
(they're owned by their own design areas); the org settings page simply hosts
them and writes them to the `Workspace` row underneath. At ws ≥ 2 these sections
move to a per-workspace Settings surface and this page keeps only the org-scoped
cards above. See "Settings — collapsed at one workspace" under _Where it lives_.

### Panel 3 — cross-workspace member management (PAGINATED)

The **roster of everyone across the org's workspaces**. One `Card` titled
**People** with a count `Pill` and an **"Invite to organization…"** `Combobox`
trigger in the header. Each member row (extends the workspace `MembersCard`
grammar):

- avatar + name (+ "(you)") + email,
- **workspace chips** (`pill-ws`, peach tint) naming which of the org's
  workspaces they belong to, with a **`+N` overflow** neutral pill when there are
  more than fit,
- the **org-role `Combobox`** (owner / admin / member) — except the **owner-self
  row**, whose role action is a disabled "Owner" affordance (you can't change
  your own owner role here),
- a **Remove** action (or **Revoke** for a pending invite row).
- A **pending-invite row** (faint avatar, "Invitation sent · awaiting
  acceptance", a "Pending" neutral pill) shows the invited-not-yet-joined state.

**⚠️ At-scale (finding #57 — NOT load-all).** The roster is **paginated**: a card
foot reads **"Showing 1–5 of 14"** + a **Prev / Page X of Y / Next** pager (Prev
disabled on page 1). A large org has hundreds of members across many workspaces —
the code subtask (6.10.5) MUST fetch a page at a time (the 6.10.4 service's
paginated `listMembers`), never `load-all`. Cursor or offset paging is
acceptable; the design shows page-numbered offset paging to match the count
display.

### Panel 4 — org-role + invite affordances

- **Org-role select OPEN** (owner / admin / member) with a one-line description
  per role, + a **role-explanation block** below it: an **owner/admin** pill row
  ("administer the org and are granted admin on **every** workspace under it") and
  a **member** pill row ("belongs to the org but … governed by their **workspace
  role** (the 6.4 MemberRole)"). This is where the design **distinguishes the org
  role from the workspace role** in writing.
- **Invite-to-organization picker OPEN** — a search `Combobox` over existing
  workspace members ("in workspace" meta) **plus** an **"Invite '…'"** send-email
  option for an address not yet present. Foot copy: invited people pick up the
  chosen org role; existing workspace members can be promoted to an org role here.
- An **info `note`**: _"Org membership gates workspace access: someone removed
  from the organization loses access to every workspace under it."_ (the 6.10.4
  gating decision, surfaced to the admin).

### Panel 5 — empty / loading / error + permission states

- **(a) Empty** — first-run / single-member org: an `EmptyState` ("It's just you
  so far") with an **Invite people** primary CTA.
- **(b) Loading** — the paginated-roster **`Skeleton`** (avatar + two lines +
  a chip placeholder per row), `aria-busy` / `aria-live="polite"` on the body.
- **(c) Error** — the roster fetch failed: an `ErrorState` (rose icon tint,
  "Couldn't load members") with a **Retry** secondary button.
- **(d) Forbidden** — signed in as an org **member** (not owner/admin): a gated
  `state` ("Organization settings are admin-only", lock icon, lavender tint) with
  a **Back to workspace** action — **the controls are NOT rendered** for a
  non-admin. (Distinct from the cross-tenant **404-not-403** posture for a
  non-org-member, which is a route-level not-found, not this in-app gated panel.)

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive. If 6.10.5 needs a
genuinely new primitive, that is a **new `design/` subtask**, not a code
workaround.

- **`Card`** — settings cards, the members card, the state panels (`--radius-card`,
  `--shadow-card`, `--spacing-card-padding`; head/body/foot regions split by
  `--el-border-soft`).
- **`Button`** — primary (Save, Invite people, Back to workspace), secondary
  (Retry), ghost (row Remove/Revoke), danger (Delete organization). Heights
  `--height-btn-md` / `--height-btn-sm`; padding `--spacing-btn-x[-sm]`.
- **`Popover` + `Combobox`** — the org switcher menu, the invite picker, the
  per-row org-role select, the per-row search. `--radius-card` container,
  `--shadow-elevated`, rows at `--spacing-control-*` / `--radius-control`.
- **`Input`** — the org-settings fields (`--height-input`, `--spacing-input-*`,
  `--radius-input`); the URL field uses a `--el-text-secondary` `motir.co/` prefix.
- **`Pill`** — org-role chips (see colour roles below), workspace chips, the
  count + pending + "Coming soon" neutral pills. `--radius-badge`,
  `--spacing-chip-*`; **hue in the tint BACKGROUND with `--el-text-strong` text
  (finding #35 — AA-safe), never a tinted page surface.**
- **`EmptyState` / `ErrorState`** family — panels 5a/5c/5d.
- **`Skeleton`** — panel 5b loading roster.
- **`Tooltip`** — the read-only / disabled-affordance explainer grammar (ink bg,
  `--el-text-inverted`).
- **Pagination** — a list-foot pager (count text + Prev/Next + page indicator).
  Reuse the at-scale list pattern Story 6.4 / the issues list established; do NOT
  hand-roll a new control.
- **Org avatar** — a small `--radius-control` square initial chip (lavender tint
  by default; per-org tint when shown in the switcher list), distinct from the
  round **user** avatar.

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                           | Token                                                   | Why                                                                        |
| --------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Org-role: owner**               | `--el-tint-lavender` bg + `--el-text-strong`            | The highest, special role — the brand-purple family; carries a crown icon. |
| **Org-role: admin**               | `--el-tint-sky` bg + `--el-text-strong`                 | Distinct blue tint, clearly below owner.                                   |
| **Org-role: member**              | `--el-tint-mint` bg + `--el-text-strong`                | Green tint — the baseline tier, still coloured (not bare grey).            |
| **Workspace-membership chips**    | `--el-tint-peach` bg + `--el-text-strong`               | "Scope" chips read as a different category from the role chip.             |
| **Count / pending / coming-soon** | `--el-surface` + `--el-text-secondary` (neutral `Pill`) | Genuinely neutral metadata.                                                |
| **Error icon tint**               | `--el-tint-rose` + `--el-danger-text`                   | Fetch-error state.                                                         |
| **Forbidden icon tint**           | `--el-tint-lavender` + `--el-text-strong`               | The lock/gated state.                                                      |
| **Primary CTAs / active check**   | `--el-accent` (+ `--el-accent-text`)                    | Save / invite / the active-org check.                                      |
| **Danger zone**                   | `--el-danger-text` / `--el-danger`                      | Delete-org header + button.                                                |
| Text / surfaces / borders         | `--el-text*`, `--el-surface*`, `--el-border*`           | Standard element tokens — never Tier-0 `--color-*`.                        |

All shaped surfaces use the **`[data-display-style]` shape tokens**
(`--radius-{btn,card,input,control,badge}`, `--spacing-{btn,input,control,chip,
card-padding}`, `--height-{btn-*,input,control}`, `--shadow-*`) — never the inert
Tier-0 radius/spacing scale or a fixed raw utility. `rounded-full` (`9999px`) is
used only for the round user avatar and status dots. Toggle the mock's dark mode
to confirm token parity (every colour flips through Tier-0 under `--el-*`).

## Copy strings (en — the `orgAdmin` i18n namespace 6.10.5 adds)

- Org menu: items **"Settings"**, **"Members"**, **"Billing & usage"** /
  **"Coming soon"**, **"New workspace"** ("Adds the workspace switcher"); the
  switch-org section (≥2 orgs only) heading **"Switch organization"**, per-org
  sub **"{count} workspace(s)"**, **"Create organization"**. Workspace switcher
  (≥2 ws only) reuses the shipped `shell.workspaceSwitcher` strings.
- Settings: **"Organization settings"** (title); **"Manage the {org}
  organization — the account your workspaces live under. Only organization owners
  and admins can change these."** (subtitle); fields **"Organization name"**,
  **"Contact email"** (the **"Organization URL"** field and its hint were removed
  by MOTIR-2548 — see the amendment under Panel 2); **"Save changes"**; billing card
  **"Billing & usage"** / **"Coming soon"** / the 7.12.5 + Epic 8 placeholder
  note; **"Danger zone"** / **"Delete organization"**.
- Members: **"Members"** (title); **"Everyone in the {org} organization, across
  all its workspaces. An organization role applies org-wide; workspace membership
  is shown per person."** (subtitle); **"People"**; **"Invite to organization…"**;
  roles **"Owner / Admin / Member"** with descriptions ("Full control — billing,
  delete, all workspaces" / "Manage members + settings + every workspace" /
  "Belongs to the org; access by workspace role"); **"Remove"** / **"Revoke"**;
  **"Pending"**; pager **"Showing {from}–{to} of {total}"**, **"Page {n} of
  {m}"**, **"Prev"** / **"Next"**.
- Role help: **"Owner / Admin administer the organization and are granted admin
  on every workspace under it — above any per-workspace role."**; **"An org Member
  belongs to the org but has no cross-workspace powers — what they can do inside a
  workspace is still governed by their workspace role (the 6.4 MemberRole)."**;
  gating note **"Org membership gates workspace access: someone removed from the
  organization loses access to every workspace under it."**
- States: empty **"It's just you so far"** / **"Invite teammates to the {org}
  organization. They'll get access to the workspaces you add them to."** /
  **"Invite people"**; error **"Couldn't load members"** / **"Something went
  wrong fetching this organization's members. Try again."** / **"Retry"**;
  forbidden **"Organization settings are admin-only"** / **"Only owners and
  admins of {org} can manage members and settings. Ask an organization admin if
  you need a change."** / **"Back to workspace"**.

The full string set is added to the app's locale files (en + zh, the shipped
locale set) by the 6.10.5 code subtask under the new `orgAdmin` namespace.

---

# Members seat / billing affordances (scaled org) — Story 8.1 · 8.1.13

> **Asset:** `members-billing.mock.html` + `members-billing.png` (this section is
> the third file of the THREE-file set). Subtask **8.1.13 (MOTIR-1260)**, the
> design gate **8.1.14 / MOTIR-1261** (the UI code) is `blocked` behind.

## What this is

The **seat / billing affordances LAYERED ONTO the existing org Members admin**
(6.10 · `settings/organization/members` · `OrgMembersClient`) for a **SCALED**
org. The members page already ships with zero billing content;
**8.1.12 (MOTIR-1256)** now keeps the Stripe seat `quantity` in sync with org
membership (prorated, charged promptly via Stripe `always_invoice`), but its
in-context UI was undesigned. Design-before-code (**Principle #13**) requires
THIS asset before the UI lands. This **extends** the org-admin area — it does NOT
replace the `org-admin.mock.html` roster; it adds the seat layer on top of it.

### Grounded in (read at run time — NOT invented)

- **`design/billing/design-notes.md` PANEL 6** — the seat model + proration copy:
  one seat per org **member**; **annual default $40/seat/yr** (6 × $40 = **$240 /
  yr**, ~$20/mo equiv); **add** a member → a **prorated CHARGE** for the rest of
  the term; **remove** → a **prorated CREDIT** on the next invoice, **NO mid-term
  refund**; seats track membership automatically (Linear's "seats = active
  members, prorated" model).
- **8.1.12 (MOTIR-1256) timing** — Stripe `proration_behavior: 'always_invoice'`
  → the added seat's prorated share is invoiced **+ collected NOW** (charged
  promptly), **NOT deferred to the annual renewal**. The add-member copy reads
  "**~$X charged now**, prorated to your renewal" to reflect this exactly (the
  default `create_prorations` would hold it to renewal = a free-seat loophole the
  decision rejects).
- **8.1.4c (MOTIR-1248)** — `Organization.scaledTrackerSubscription`
  (`{ status: active|past_due|canceled, priceId, currentPeriodEnd }`) is the
  **scaled-vs-free signal** every surface here gates on. `null` (free) → no seat
  UI.
- **`design/org-admin/design-notes.md`** (this file) — the members roster grammar
  the seat layer extends.

### Cloud-only + scaled-only (decision §6) · NO pay-wall (Linear-style)

Every surface here is gated behind **`MOTIR_CLOUD`** _and_ an **active** scaled
subscription. A **free** org and a **self-hosted** (GPL-3.0) build see the
members page **UNCHANGED** — no seat band, no cost notes (panel 4 draws this).
There is **no pay-wall**: inviting always works; the seat count and the next
invoice adjust automatically — the cost note is **informational, never a gate**.

### Permissions (decision §7)

Billing **mutations are owner-only**; an org **admin** can still manage
**membership** (add/remove — which moves seats) but does **not** own the seat
plan. So the admin view shows the seat count **read-only**, drops the "Manage
seats in Billing" CTA, and carries a "billing managed by an owner" note (panel
6). A plain org **member** never reaches this admin page at all (the org-admin
**panel 5d forbidden** state) — so "no cost actions for a non-billing-admin" is
realised as the org-**admin** treatment here.

## Design-against-shipped-reality (rendered, not redrawn)

The surface mirrors the **shipped `OrgMembersClient.tsx` EXACTLY** — a `Card`
with a head (`<h2>People</h2>` + a neutral count `Pill` left; a **secondary
`Invite` `Button`** with a `Mail` icon right) and a foot (the at-scale pager);
the body is a `<ul>` of member rows (avatar · name(+"(you)") · email · workspace
chips · a per-row org-role `Combobox` — a `Pill` + disabled affordance for the
self row · a ghost `Remove` `Button`). **Invite opens a `Modal`** (email `Input`

- role `Combobox` + the `roleHelp.gatingNote` paragraph + Cancel / Send). The
  seat layer is **added** to that reality; nothing is a redrawn stand-in. (The
  older `org-admin.mock.html` panel 3 drew the invite as a `Combobox` trigger — the
  SHIPPED component is a `Button`+`Modal`, which is what this asset matches.)

## Panels (review EACH — mistake #31)

### Panel 1 — scaled + active (the primary view + the access path)

The Members page for a scaled org. The **access path IS the existing Members
page** (crumb `Organization · {org} · Members`) — the door is the page itself; no
new nav. The new element is a **seat-summary band** at the **top of the People
card body** (above the roster), in-context where the seat count lives:

- a lavender product glyph (`i-layers`, the Motir glyph from billing panel 2),
- **"6 of 6 seats · $240 / yr"** (seats = active members), a **"Scaled"** mint
  status `Pill`, an **"Annual · saves $120/yr"** `save` pill,
- sub: _"Seats follow membership — 1 per active member ($40/seat/yr). Adding or
  removing a member adjusts your next invoice automatically (prorated)."_,
- a **"Manage seats in Billing"** `xlink` (`i-external`) → billing panel 6.

Below, the shipped roster (6 members = 6 seats) + the pager. A closing **info
`note`** states the **no-pay-wall** rule.

### Panel 2 — add a member (prorated-charge note · always_invoice)

The shipped Invite **`Modal`** (email `Input` filled, role `Combobox` "Member",
the gating `fhint`), now carrying a **one-line cost note** (a mint band, `i-user-
plus` accent glyph) directly above the footer:

> **Adds a seat.** ~**$33 charged now**, prorated to your 1 Jul 2026 renewal. Your
> plan goes from $240 to **$280 / yr** (7 seats).
> _Seats follow membership — you're not picking a plan. Stripe bills the prorated
> seat to your card on file; remove the member later for a prorated credit._

"Charged now" reflects 8.1.12's `always_invoice`. Footer: **Cancel** (ghost) /
**Send invite** (primary, `i-mail`). **No pay-wall** — Send always works.

### Panel 3 — remove a member (prorated-credit confirm)

The row's ghost **Remove** gains a **confirm popover** (a `Popover`, anchored to
the button) that discloses the **credit** before the seat-affecting change — the
shipped one-click remove is too consequential when it changes the bill:

> **Remove Mo from moooon?**
> _(i-user-minus)_ **Frees a seat** (6 → 5). A prorated credit for the unused time
> posts to your next invoice — **no mid-term refund**. Your plan returns to $200 /
> yr at renewal.
> _(i-info)_ They lose access to every workspace under moooon.
> [ Cancel ] [ **Remove** (danger) ]

The target row gets a **surface highlight + accent inset bar** (`--el-surface-
soft` + `box-shadow: inset 2px 0 0 --el-accent`) — **not** `opacity` (opacity
would form a stacking context and bleed transparency into the popover child; the
roster card's `overflow: hidden` also means the popover must float over rows
_within_ the card, not past its edge — both are real-component constraints the
8.1.14 code must respect, e.g. by portaling the Radix `Popover`). **A free org
keeps the one-click remove** (no confirm, no cost — panel 4).

### Panel 4 — free org + self-host (UNCHANGED · the gated difference)

Side-by-side: (left) the free-org Members page — **same People card, NO seat
band**, the roster, the pager; (right) the free-org Invite `Modal` — **NO cost
note**. A `note` states self-host is identical: with `MOTIR_CLOUD` off or no
active scaled subscription, the seat band and every cost note are gone — Motir is
unbounded and free within its caps.

### Panel 5 — past_due (dunning · seats still editable)

The seat band's **warning variant** (a `--el-tint-yellow` band, `i-alert`
`--el-warning` glyph, a **"Past due"** `pill-pastdue`): _"We couldn't charge your
card for the Motir seat plan. Motir stays active while we retry over the next ~2
weeks — **seats are still editable**. Update your payment method to avoid dropping
to the free caps."_ + an **"Update payment"** primary (`i-card`). Roster controls
stay fully editable. Grounds in **billing panel 3a** (keep-through-grace dunning).

### Panel 6 — non-admin for billing (org admin · owner-only billing)

An org **admin** (can manage membership, does NOT own the seat plan). The seat
band is **read-only**: **"6 of 6 seats · $240 / yr"** + **"Scaled"** + a **"View
only"** neutral `Pill` (`i-eye`), **no "Manage seats" CTA**, and a lock `costnote`
(`i-lock`): _"Billing is managed by an owner. Adding or removing a member still
adjusts the org's seats — the charge or credit is handled on the owner's plan."_
The roster stays manageable (admins manage membership). The page subtitle states
the split. _(A plain org member is gated out entirely — org-admin panel 5d.)_

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive (the same set the
6.10 members page already uses), so 8.1.14 reuses the shipped code:

- **`Card`** — the People card (head / body / foot), `--radius-card`,
  `--shadow-card`, `--spacing-card-padding`; regions split by `--el-border-soft`.
- **`Button`** — secondary `Invite` (`--height-btn-sm`, `i-mail`); ghost row
  `Remove`; primary `Send invite` / `Update payment`; danger `Remove` (in the
  confirm). Heights `--height-btn-{sm,md}`; padding `--spacing-btn-x[-sm]`.
- **`Pill`** — the count (neutral), the **"Scaled"** (mint), **"Past due"**
  (yellow), **"View only"** (neutral, `i-eye`), org-role chips (owner=lavender /
  admin=sky / member=mint), workspace chips (peach). `--radius-badge`,
  `--spacing-chip-*`; **hue in the tint BACKGROUND with `--el-text-strong`
  (finding #35 — AA-safe), never a tinted page surface.**
- **`Combobox`** — the per-row org-role select + the Modal's role select
  (`--height-control`, `--radius-input`, `--spacing-control-*`).
- **`Input`** — the Modal's email field (`--height-input`, `--spacing-input-*`,
  `--radius-input`).
- **`Modal`** — the Invite dialog (overlay `bg-black/40`; panel `--radius-modal`,
  `--spacing-card-padding`, `--shadow-modal`; serif title).
- **`Popover`** — the Remove confirm (`--radius-card` container,
  `--shadow-elevated`). **Portal it** so the card's `overflow: hidden` can't clip
  it (the portal-popover-in-overflow rule).
- **Seat band / cost note** — a token-styled band reusing billing's `.seatcalc`
  grammar (`--el-surface-soft`, `--radius-card`, `--el-border-soft`); the glyph
  chip is `--radius-control`. No new primitive. The `save` pill reuses billing's
  `.save` (`--el-tint-mint` + `--el-text-strong`). **8.1.14 sources the seat
  count from membership** (the same source 8.1.12 syncs to Stripe), never a
  hand-typed number; the `$` figures come from the scaled-subscription state.
- **Pager** — the shipped at-scale list-foot pager (unchanged from 6.10).

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                                  | Token                                                                                                        | Why                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Seat band glyph chip**                 | `--el-tint-lavender` bg + `--el-text-strong`, `i-layers`                                                     | The Motir product glyph (matches billing panel 2's Motir line).               |
| **Seat count / fee**                     | `--el-text` (count) · `--el-text-muted` (`· $240 / yr` unit)                                                 | Primary figure; the price reads quiet.                                        |
| **Status: Scaled (active)**              | `--el-tint-mint` bg + `--el-text-strong`, `i-check`                                                          | Healthy / paid — success family.                                              |
| **Status: Past due**                     | `--el-tint-yellow` bg + `--el-text-strong`, icon `--el-warning`                                              | Warning, recoverable — keep-through-grace, not danger.                        |
| **Annual-savings `save` pill**           | `--el-tint-mint` + `--el-text-strong`                                                                        | A positive saving, success family.                                            |
| **Add-seat cost note**                   | `--el-tint-mint` band + `--el-text-strong`/`-secondary`, glyph `--el-accent`                                 | A charge that _adds_ a teammate — framed positive, not alarming; no pay-wall. |
| **Past-due band**                        | `--el-tint-yellow` band + `--el-text-strong`, icon `--el-warning`                                            | Hue in the BANNER tint, never the page (finding #35).                         |
| **Remove confirm**                       | neutral `Popover` (`--el-page-bg`), `i-user-minus`/`i-info` `--el-text-muted`, danger CTA `--el-danger-text` | A consequential but reversible-credit action — disclosed, not red-alarmed.    |
| **Remove-target row**                    | `--el-surface-soft` + `inset 2px 0 0 --el-accent`                                                            | "This is the row" without opacity (which would fade the popover).             |
| **"View only" pill (admin)**             | neutral `Pill` (`--el-surface` + `--el-text-secondary`), `i-eye`                                             | Read-only billing for a non-owner.                                            |
| **Lock / owner-only note**               | `--el-text-muted`, `i-lock`                                                                                  | Billing mutations are owner-only (§7).                                        |
| **Primary CTAs**                         | `--el-accent` + `--el-accent-text`                                                                           | Send invite / Update payment.                                                 |
| **Cross-link (Manage seats in Billing)** | `--el-link`, `i-external`                                                                                    | Quiet inline nav to billing panel 6.                                          |
| Text / surfaces / borders                | `--el-text*`, `--el-surface*`, `--el-border*`                                                                | Standard element tokens — never Tier-0 `--color-*`.                           |

All shaped surfaces use the **`[data-display-style]` shape tokens**
(`--radius-{btn,card,input,modal,control,badge}`,
`--spacing-{btn,input,control,chip,card-padding}`, `--height-{btn-*,input,control}`,
`--shadow-*`) — never the inert Tier-0 radius/spacing scale or a fixed raw
utility. `rounded-full` (`9999px`, via `--radius-badge`) is used only for the
round user avatar and pill caps. Toggling the mock's dark mode confirms token
parity (every colour flips through Tier-0 under `--el-*`).

## Copy strings (en — `orgAdmin` namespace additions for 8.1.14, `seat.*`)

- Seat band: **"{n} of {n} seats"** · **"$ {total} / yr"**; **"Scaled"** /
  **"Past due"** / **"View only"**; **"Annual · saves ${save}/yr"**; sub
  **"Seats follow membership — 1 per active member (${seat}/seat/yr). Adding or
  removing a member adjusts your next invoice automatically (prorated)."**;
  **"Manage seats in Billing"**.
- Add note (scaled only): **"Adds a seat."** / **"~${charge} charged now,
  prorated to your {renewal} renewal. Your plan goes from ${cur} to ${next} / yr
  ({n} seats)."** / **"Seats follow membership — you're not picking a plan. Stripe
  bills the prorated seat to your card on file; remove the member later for a
  prorated credit."**
- Remove confirm (scaled only): **"Remove {name} from {org}?"** / **"Frees a seat
  ({from} → {to}). A prorated credit for the unused time posts to your next
  invoice — no mid-term refund. Your plan returns to ${next} / yr at renewal."** /
  **"They lose access to every workspace under {org}."** / **"Cancel"** /
  **"Remove"**.
- Past due: **"We couldn't charge your card for the Motir seat plan. Motir stays
  active while we retry over the next ~2 weeks — seats are still editable. Update
  your payment method to avoid dropping to the free caps."** / **"Update
  payment"**.
- Non-admin: subtitle **"You're an admin of {org} — you can manage who's in the
  organization. The seat plan and payment are managed by an owner."**; band note
  **"Billing is managed by an owner. Adding or removing a member still adjusts the
  org's seats — the charge or credit is handled on the owner's plan."**
- Free / self-host: no seat strings render (the band + notes are absent).

en is the source; keep it byte-stable as other locales are added (8.1.14 adds
these under the existing `orgAdmin` namespace, alongside a `MOTIR_CLOUD` +
scaled-flag gate).

---

## The require-2FA policy control (Story 8.13 · 8.13.1)

**Asset:** `security-policy.mock.html` + `security-policy.png`. Gates **8.13.5**
(MOTIR-3646, the org pane) and **8.13.6** (MOTIR-3647, the workspace control).
The member-facing half — the forced-enrolment screen a non-compliant person
meets — is **8.13.2**'s (MOTIR-3643) and lands in the **`design/auth`** area
beside the two-factor challenge and passkey sign-in screens; it is not drawn
here.

### What this asset owns, and what it deliberately does not

It owns **one card**, its **two access paths**, and the **locked state**. It
**COMPOSES** two surfaces it does not re-specify:

- `design/workspaces/settings.pen` / `settings.png` owns the workspace settings
  page. This asset adds a pane to it; it does not redraw it.
- `design/org-admin/org-admin.mock.html` owns the org settings home, and its
  **panel 5d** owns the refusal treatment reused verbatim in panel 8.
- `design/settings/arrival.mock.html` owns the settings-pane arrival frame,
  composed in panel 9. This pane adds **no `loading.tsx`** — see the arrival note
  below.

### ⚠️ Two primitives MOVED since `org-admin.mock.html` was drawn

This asset follows the shipped components, not its predecessor in this folder.
Both differences are visible in the export and both matter to the implementer:

| primitive | what `org-admin.mock.html` draws                                                   | what ships today                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Card`    | a bordered header strip (`.card-head` with a `border-bottom`), padding on the body | ONE padded box — `rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding)` on `--el-card`, whose `header` slot is a plain block with `mb-(--spacing-md)` and whose `footer` slot adds `border-t` + `mt/pt-(--spacing-md)` |
| `Switch`  | n/a (that asset draws none)                                                        | `h-5 w-9` (36×20) with a 14px knob; checked fill `--el-switch-on`, knob `--el-switch-knob`, unchecked track `--el-muted` on a `--el-border-strong` border; `disabled` is `opacity-50` + `cursor-not-allowed`                                     |

Build to the table's right-hand column. `AcceptanceVideoCard.tsx` is the shipped
worked example of exactly this card shape (an org-level boolean policy with a
`Switch` on the right of a label row), and 8.13.5 should read it before writing.

### The panels

| #   | panel                                 | what it shows                                                                                                                    |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Access path A — the org menu**      | `OrgControl.tsx`'s menu with **Security** inserted directly under Settings.                                                      |
| 2   | **Access path B — the settings rail** | `SidebarNav.tsx`'s bottom section with **Security** added, AND the same rail below the reveal threshold where the row is ABSENT. |
| 3   | **Off**                               | Nobody is required. The body copy carries the consequences.                                                                      |
| 4   | **On, set at this tier**              | The org control, operable, with the state named in text.                                                                         |
| 5   | **Locked on, mandated above**         | The workspace control when the org already requires it.                                                                          |
| 6   | **On here AND above**                 | Set locally, then mandated by the org too.                                                                                       |
| 7   | **The fold-in**                       | The workspace card hosted on `/settings/organization` for a single-workspace org, below the org card.                            |
| 8   | **Refused**                           | Panel 5d's `EmptyState`, replacing the CARD and not the page.                                                                    |
| 9   | **Arrival**                           | `SettingsPaneFrame` as the in-page `<Suspense>` fallback.                                                                        |
| 10  | **Dark**                              | Three of the states again with the tokens flipped.                                                                               |

### ⚠️ The locked state is the one an implementer will otherwise improvise

**The switch is `disabled`, NOT absent.** A missing control tells a workspace
admin nothing, and a live control that silently does nothing is worse than both.
The indicator is a **`Pill`** — never bespoke markup — carrying
**"Required by {org}"**, so the organization is named: a person denied a switch
is owed the name of whoever holds it.

**The Pill is `--el-tint-sky` with `--el-text-strong` ink, and it is NOT
`--el-danger`.** `design/settings/design-notes.md`'s shipped ruling applies:
nothing has gone wrong here, something was decided elsewhere. Sky rather than
lavender because lavender is already the org-role chip's tone in this area, and
the two must not read as the same class of thing. Hue in the tint BACKGROUND with
`--el-text-strong` text is what keeps it AA in both themes.

**Panels 5 and 6 are DIFFERENT states and must not be collapsed.** MOTIR-3644
stores the two tiers as two columns rather than their OR precisely so that
"the workspace chose this too" survives the org switching its own off. Panel 6's
copy says both; panel 5's says only the org. An implementer who renders one
treatment for both loses the distinction the schema was shaped to keep.

### ⚠️ The fold-in decides the layout (MOTIR-3502 · `organization-tier.md` §6d)

Below **two** workspaces in the active org, `/settings/workspace` **404s**
(`resolveWorkspaceTierDisclosure` → `notFound()`), and its sections are hosted on
`/settings/organization` by `WorkspaceFoldInSection` — _"a MOUNT, not a
rewrite"_. So the workspace require-2FA control has **two homes**, and a design
that drew only `/settings/workspace/security` would describe a surface most
organizations cannot reach. Panel 7 draws the second home: the identical card,
below the org-scoped cards, in the same `stack` grammar the fold-in already uses
for Name / Members / Danger zone. **It is the same component mounted twice, never
a second drawing.**

**The rail row follows the same threshold, and this is where this pane departs
from its neighbours.** `SidebarNav.tsx` says outright that Job runs and Git are
NOT gated on the reveal, because they are workspace-SCOPED but not
workspace-NAMED. `/settings/workspace/security` **is** workspace-named and 404s
below the threshold, so its row must be hidden there or it points at a 404.
Panel 2's right half is that state.

### Arrival

Panel 9 is `SettingsPaneFrame`, rendered as the fallback of an in-page
`<Suspense>` placed **after** the pane's own gate. The real header (`<h1>` +
subtitle) is painted ABOVE the boundary, so it is on screen immediately and no
placeholder covers it. **Do NOT add a `loading.tsx`** — `CLAUDE.md`'s rule
applies: a route-level boundary flushes the response head and fixes the status at
200, and this pane's siblings under `settings/` decide existence.

### Primitives composed

| element                   | primitive                        | tokens                                                                                                      |
| ------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The policy card           | `Card`                           | `--el-card` fill, `--el-border`, `--radius-card`, `--spacing-card-padding`; header slot `mb-(--spacing-md)` |
| Card title                | `<h3>` in the header slot        | `--el-text`, 16px/600                                                                                       |
| Card body copy            | `<p>` in the header slot         | `--el-text-muted` — safe here because the card fill IS the white page/card surface                          |
| State label               | `<span>`                         | `--el-text-secondary` off, `--el-text` on                                                                   |
| The toggle                | `Switch`                         | `--el-switch-on` / `--el-switch-knob` / `--el-muted` / `--el-border-strong`; `--shadow-subtle` on the knob  |
| Locked indicator          | `Pill`                           | `--el-tint-sky` background, `--el-text-strong` ink, `--radius-badge`, `--spacing-chip-x/y`                  |
| Locked explanation        | `<p>`                            | `--el-text-secondary`, `mt-(--spacing-md)`                                                                  |
| Refusal                   | `EmptyState` (which is a `Card`) | glyph `--el-icon-muted`, title `--el-text`, description `--el-text-subtitle`                                |
| Arrival blocks            | `SettingsPaneFrame`              | `--el-muted` fill, `--radius-control`                                                                       |
| Org menu                  | `Popover` + menu rows            | `--el-border`, `--shadow-elevated`, `--radius-card`; rows `--radius-control`, `--spacing-control-x/y`       |
| Rail rows                 | `Sidebar` rows                   | `--el-text-secondary`, active `--el-surface`, `--radius-control`                                            |
| The `›` context separator | `<span aria-hidden>`             | `--el-text-faint` — **decorative only**, which is what makes that ink legitimate                            |

No Tier-0 `--color-*` is referenced by any element rule (only the `:root` /
`[data-theme='dark']` token blocks define them), and no raw `rounded-*` / `p-*` /
`h-*` appears. The one `9999px` radius is `--radius-badge` and the genuinely
circular switch track/knob, which is the sanctioned carve-out.

### ⚠️ The `--el-*` layer is re-declared inside the dark block, and it has to be

A custom property is substituted at the element it is **declared** on. An
`--el-*` declared only on `:root` therefore computes against `:root`'s
`--color-*`, and a nested element that flips `--color-*` inherits the
already-resolved LIGHT value. Panel 10 rendered white until the `--el-*` layer
was re-declared inside `[data-theme='dark']`. This costs nothing in the app —
`data-theme` lives on `<html>` there — but any multi-panel board that wants light
and dark in ONE export needs it, and the next such asset in this folder should
copy the pattern rather than rediscover it.

### Copy strings (en — new keys for 8.13.5 / 8.13.6)

Both UI cards ship `en` + `zh` together; `tests/i18n-catalog.test.ts` enforces
the parity, so a missing `zh` twin is a red build.

- Pane title **"Security"**; org subtitle **"Sign-in requirements for everyone in
  {org}."**, workspace subtitle **"Sign-in requirements for everyone in
  {workspace}."**
- Card title (both tiers) **"Require two-factor authentication"**.
- Org body **"Everyone in this organization signs in with a second factor. Nobody
  is signed out and nobody is removed — the next time a person opens Motir they
  are asked to set one up, and any method counts: a passkey, an authenticator app
  or email codes."**
- Workspace body **"Additionally require a second factor for everyone in this
  workspace. Your organization's setting applies on top of this one and cannot be
  lowered here."**
- State labels **"Not required"** / **"Required for every member of {org}"** /
  **"Required for every member of {workspace}"**.
- Locked pill **"Required by {org}"**.
- Locked explanation (org mandates, workspace does not) **"{org} requires
  two-factor authentication for every member, so it cannot be switched off for
  this workspace. An owner or admin of {org} can change it in the organization's
  Security settings."**
- Locked explanation (BOTH) **"This workspace requires two-factor
  authentication, and so does {org}. Turning off the organization's requirement
  will leave this workspace's own requirement in place."**
- Refusal **"You don't have access to this"** / **"Only an owner or an admin of
  {org} can change its security settings. Ask one of them if this needs to
  change."**
- Menu / rail row label **"Security"**.
- Switch `aria-label` **"Require two-factor authentication"** — the switch is a
  bare control and announces nothing without it.

**No copy implies a deadline.** Rung 1 is explicit that neither Atlassian nor
GitHub ships a grace period or a countdown, so nothing here says "by" or
"within".

### ⚠️ Planning flags

1. **The rail row is gated and its neighbours are not**, which reads as an
   inconsistency to anyone who does not know §6d. 8.13.6's acceptance criteria
   already carry the `notFound()` requirement; the RAIL half is this asset's, and
   the comment beside it in `SidebarNav.tsx` should say why this row differs from
   Job runs and Git or the next reader will "fix" it.
2. **The org pane has no refusal ROUTE of its own.** Panel 8 refuses the CARD
   inside a rendered pane, matching how `settings/organization/page.tsx` gates
   per section rather than per page. If 8.13.5 instead makes the whole route
   404 for a non-admin, that is a different decision from the one drawn here and
   should be taken deliberately, not by accident.
3. **Nothing here draws a member LIST.** "Who is not yet compliant?" is a
   reasonable next question for an admin who has just switched this on, and this
   story does not answer it. Not a gap in 8.13 — a candidate for a later card,
   named so it is not smuggled into 8.13.5.

---

# The org menu gains a `Git` row (Story MOTIR-4669 · subtask MOTIR-4673)

**2026-09-05.** The git connect surface moves to the ORGANISATION tier, and **a surface with no
drawn entrance gets its entrance improvised at build time.** This amendment draws the entrance. It
is `org-admin.mock.html` **Panel 6**, and it decides one thing: where the row goes and what gates it.

**It does not describe the page behind it.** That is **MOTIR-4672**, `design/github/` Panel 6 —
the organisation's repository inventory, its index states, its `Used by N projects` column and its
disconnect disclosure. Cited here, described nowhere.

---

## ⚠️ AMENDMENT (2026-09-05, same day) — THE DOOR WAS STILL NOT VISIBLE. PANEL 7.

Panel 6 answers _"where does the row go"_ and it answers it correctly, but it answers a smaller
question than the card is for. Yue, on reading it:

> now organization → setting goes to a single page with left nav setting highlighted, the same
> setting nav as the project setting. you didn't make it clear in the design where the door is

Verified, and true. The rail's bottom `Settings` row points at `/settings/organization` whenever
there is no active project (`SidebarNav.tsx`, the area door). You arrive at a single page of cards,
the bottom `Settings` row is lit, and there is **nothing on the page that names `Git`** — or
`Members`, or `Security`, or `Usage`. The org menu is a pop-over you must already know to open, it
closes behind you, and it highlights nothing. So the menu row is a real door and it is not a
findable one.

**The decision (Yue): organisation settings gains a real settings nav** — the registry-driven rail
`settings/project/` and `settings/account/` each already have. That is **Panel 7**, and it changes
what this card's two superseded sections below concluded. Panel 6's row is kept: it is the FAST
door, and it is how `Members` and `Billing` have always been reached.

### Panel 7, arm by arm

| arm    | draws                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------- |
| **7a** | the area shell with `Git` active — the chrome around MOTIR-4672's pane, which is what was missing |
| **7b** | `Organisation` active: today's index page, card for card, inside the same chrome — nothing moves  |
| **7c** | the two filtered arms — a plain org member, and an org admin on a self-host build                 |
| **7d** | the registry, row by row: group · id · route · glyph · who sees the row                           |

### The registry

A sibling of `lib/settings/projectSettingsNav.ts` and `lib/settings/accountSettingsNav.ts`, with the
same `{ id, group, href, icon, labelKey, exact? }` entry shape and the same
`SETTINGS_NAV_GROUP_ORDER` discipline.

| group     | id             | route                             | glyph         | who sees the row                           |
| --------- | -------------- | --------------------------------- | ------------- | ------------------------------------------ |
| `general` | `organization` | `/settings/organization` (exact)  | `Building2`   | any org member — §6d gates it per SECTION  |
| `general` | `git`          | `/settings/organization/git`      | `GitBranch`   | any org member; WRITE controls owner/admin |
| `access`  | `members`      | `/settings/organization/members`  | `Users`       | org owner/admin                            |
| `access`  | `security`     | `/settings/organization/security` | `ShieldCheck` | org owner/admin                            |
| `billing` | `usage`        | `/settings/organization/usage`    | `Coins`       | org owner/admin                            |
| `billing` | `billing`      | `/settings/organization/billing`  | `CreditCard`  | org owner/admin, **cloud builds only**     |

**Groups mirror the two existing rails' shape** (`general / access / work / automation`;
`general / preferences / security / data`) and land on `general / access / billing`. `Git` sits in
`general` for the same reason the project rail puts `repositories` there: it is the tenant's own
resources, not a permission and not money.

**Two filter axes, both already precedented** by `visibleSettingsNav(held, NAV, availability)`:
what the actor HOLDS (org owner/admin vs plain member) and what this BUILD has (`billing` is
cloud-only, exactly as the org menu already gates it). A group with no surviving rows is not
rendered — no empty heading, no disabled row.

### The index row is called `Organisation`, not `Settings`

The word the org menu uses for the same route is `Settings`. Inside a settings area a row named
"Settings" names its own container; the project rail has the same row and calls it `Details`. The
MENU keeps its word — it is outside the area, where "Settings" is what the destination is. **Every
other label is the menu's, in full**: `Usage & cost`, `Billing & plans`, not truncated to fit a
rail. Two doors onto one room that disagree about its name are two rooms to the person using them.

### ⚠️ NOTHING MOVES — and `WorkspaceFoldInSection` in particular

The four existing sub-routes become rows; the index becomes the `Organisation` row; `Git` is the one
NEW row. No page's content changes. In particular **`WorkspaceFoldInSection` stays on the index
page**: below the workspace-tier reveal that page hosts two tiers' sections (`organization-tier.md`
§6d), and relocating them is a §6 decision this card has no business re-taking. The row filter
decides which ROWS exist; the index page keeps its own per-SECTION gating, unchanged.

### ⚠️ THE PREREQUISITE NOTHING IN THE PLAN BUILDS

`/settings/organization/*` has no area layout, no nav registry, and no `SidebarNav` branch. Panel 7
specifies all three, and **no subtask under MOTIR-4669 builds them** — MOTIR-4680 assumes the page
exists inside an area. This is surfaced as a planning proposal rather than absorbed here; a design
card may specify a prerequisite, it may not quietly grow one.

---

## ⚠️ SUPERSEDED BY THE AMENDMENT ABOVE — kept as the reading that produced Panel 6

### There is no org settings RAIL — this menu IS the navigation

`/settings/organization/*` has **no area layout and no settings rail**. `settings/project/` and
`settings/account/` each have one; the organisation does not. Its navigation is the **org menu**
behind the organisation name (`app/(authed)/_components/OrgControl.tsx`), plus the command palette.

So the row lands in the menu, and this asset already owns that menu (Panel 1, arm C). It is also why
**MOTIR-4672's Panel 6 draws its page with no rail beside it** — the two halves agree about what the
navigation is, which is the whole point of splitting the door from the room.

> **Every FACT above is still true of the shipped tree; the inference was not.** A tier that is the
> only one of three without a settings nav is a **gap**, and answering "where does the Git row go"
> with "the pop-over, because that is all there is" designs the gap in permanently. Panel 7 builds
> the rail. MOTIR-4672's Panel 6 gains it too.

## The convention that was read, and where the row goes

**Read from the SHIPPED menu, not from this asset's own Panel 1.** The shipped rows are
`Settings` · `Security` · `Members` · `Usage & cost` · `Billing & plans` (cloud-only), a separator,
then `New workspace` / `Switch organization`. Each is a lucide glyph at `--el-icon-muted` plus a
label.

**`Git` sits third — after `Security`, above `Members`.** The shipped menu's own reasoning for
`Security` is that it sits directly under `Settings` because it is _a settings-shaped destination_
and keeping it above `Members` _holds the two account-level concerns together_. `Git` is the third
such concern — the organisation's own resources — so it joins that block rather than landing among
the people and money rows. The menu then reads **configuration → people → money**, which is the
order it already had.

**The glyph and the word are the ones the row already had.** `git-branch`, labelled `Git` — the same
pair it carried in the shell rail's bottom section. It is the SAME row arriving, and drawing it with
a new glyph would hide that.

**One width.** The menu is a popover of a single fixed width (288px shipped, drawn at 300px as
Panel 1 draws it), so "every width the asset draws" is one — unlike a rail, which this is not.

## ⚠️ CORRECTED — the gate is ORG MEMBERSHIP on the ROW, owner/admin on the WRITES

This section first read _"the gate: ORG ADMIN, and the row is ABSENT when it is not held"_, and both
arms were drawn that way. **That was wrong**, and wrong in a way §6 of
`docs/decisions/organization-tier.md` names outright:

> a hidden tier may not remove a capability … relocating a surface preserves its gate. If the
> destination admits fewer actors than the source, the destination's gate is what must change — not
> the set of people who can act.

The surface this row relocates FROM is `/settings/workspace/github`. Read at `HEAD`: it checks a
session and a workspace context and **no role at all** — every workspace member reads it today. And
every workspace member is an org member, by §5's upward invariant. Admin-gating the row would have
taken a shipped capability away silently, which is the exact failure §6 was written to prevent.

**So: the row is org-membership-gated, and the owner/admin gate belongs on the page's WRITE controls
— Connect · Disconnect · Remove.** Panel 6 arm B and Panel 7c both draw it that way now.

**What survives from the first drawing is the DISPOSITION**, unchanged and still right for the rows
it applies to: **absent, not disabled**, because an entry point is a promise about a room and a
disabled row is a promise the product then refuses (MOTIR-2468). It is what `Billing & plans` does
off cloud and `Security` does below the workspace-tier reveal.

**⚠️ A consequence for MOTIR-4672, recorded not designed here.** If any org member can read the
inventory, the `Used by N projects` column can name a project the viewer may not browse. The count
and the expansion must read the SAME access-filtered set — never a count that reveals a project the
viewer cannot name. Noted on that asset; the column is drawn there.

## ⚠️ Panel 1's menu is a POINT-IN-TIME RECORD and stays as drawn

Panel 1 arm C draws the org menu as it stood when this asset was written —
`Settings · Members · Billing & usage (Coming soon) · New workspace`. The product has since added
`Security` and `Usage & cost` and made `Billing` active and cloud-conditional. **Panel 1 is not
amended**: bringing it up to date is a change to what that panel records and is not this card's
work. **But the new row is not drawn into it either** — a row placed by a convention read from a
stale list would be placed by nothing. Hence a second panel, drawn from the shipped menu, saying so
in its own label.

## The departure half — MOTIR-4640, and the two agree

The row LEAVES the shell rail's bottom section: **MOTIR-4640**, in `design/shell/`, which removes it
from `rail-bottom-section.mock.html` and narrows that section's floor to `Job runs` alone. **The two
are halves of one move and they agree about the destinations**, which MOTIR-4640 states as three:

| what leaves the rail row          | where it arrives                                                            |
| --------------------------------- | --------------------------------------------------------------------------- |
| the host connection's lifecycle   | **Settings → Organisation → Git** — the surface this row opens (MOTIR-4672) |
| the member's own git account      | Settings → Account → Git accounts (MOTIR-4675)                              |
| which repositories a project uses | Settings → Project → Repositories, which already exists (MOTIR-4674)        |

This asset's row is the first of those three. **Cited, not restated:** what any of those surfaces
contains belongs to the card that draws it.

## Primitives and token roles

| Element          | Primitive                                | Colour role                                                                    |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| The menu         | the shipped `Popover` + `ul role="list"` | `--el-page-bg` / `--el-border` / `--shadow-elevated`, `--radius-card`          |
| The row          | `MenuLink`                               | `--el-text`, `--radius-control`, `--spacing-control-x/y`                       |
| The row's glyph  | lucide `GitBranch`                       | `--el-icon-muted`                                                              |
| The menu heading | the existing `menu-head`                 | `--el-text-muted` on the white popover (4.54:1 — AA-safe there and only there) |

**Nothing new is introduced.** No new primitive, no new token, no new affordance — one row, in a
menu that already renders five.

**⚠️ The row is drawn AT REST, with no `.active`.** That class paints `--el-surface`, on which the
row glyph's `--el-text-muted` measures 4.17:1 and fails AA (`tests/design-ink-contrast.test.ts`
rules on it) — and a menu row is only active while the pointer is on it, which is not what this
panel is about.

## Explicitly OUT of scope here

- **What the org Git page contains** — MOTIR-4672, `design/github/` + `design/gitlab/` Panels 6–7.
- **The rail row's removal** — MOTIR-4640, `design/shell/`. Cited as the departure; not performed here.
- **The project's `Add repository` picker** — MOTIR-4674, `design/repository-set/`.
- **The member's own git credential and its account-nav row** — MOTIR-4675, `design/settings/`.
- **Bringing Panel 1's menu up to date** — a change to what that panel records, and not this card's.
- **BUILDING the org settings nav** — Panel 7 specifies it; no subtask under MOTIR-4669 builds it,
  and it is surfaced as a planning proposal rather than absorbed here.
- **Moving `WorkspaceFoldInSection`, or anything else off the index page** — a §6d decision, and
  Panel 7's whole claim is that nothing moves.

---

## ⚠️ AMENDMENT (2026-09-11, MOTIR-4942) — panel 7b: the organisation page LOSES the acceptance-video card

**`AcceptanceVideoCard` leaves `/settings/organization`.** MOTIR-4925 moves the
acceptance-video switch to the project tier, into the new
`Project settings → Approvals` room (`design/projects/design-notes.md`
§ _Approvals — the gate switches_). Panel **7b** of `org-admin.mock.html` is
amended to draw the page **as it will stand**: the section stack, in order,
without that card.

### The order, read off the page rather than remembered

```
OrgGeneralCard            admin
BillingCard               admin · cloud only   (isCloudBilling())
WorkspaceFoldInSection    workspace membership
JobRunsFoldInSection      workspace membership
DangerZoneCard            admin
```

Each keeps its own §6d per-SECTION gate. The row filter in panel 7c decides which
ROWS exist; it does not touch what is inside one.

> **⚠️ The list this panel used to carry was STALE IN TWO WAYS, and both are
> corrected.** It read _`OrgGeneralCard · AcceptanceVideoCard · BillingCard ·
WorkspaceFoldInSection · DangerZoneCard`_. Read off
> `app/(authed)/settings/organization/page.tsx` on `origin/main` (2026-09-11), the
> page renders **Billing BEFORE Acceptance**, and it has a fifth section —
> **`JobRunsFoldInSection`** — that the list omitted entirely. A card order is
> exactly the kind of claim a prose stub records once and nobody re-reads, which
> is why this amendment draws the stack instead of listing it.

### What does NOT move

**The ENTITLEMENT stays at the organisation.** `hasPaidAiPlan` is bought once,
for the organisation, and `acceptanceVideoEligibilityService` still reads it from
here — only the SWITCH moves. That is why the project-tier control has a
_no paid plan_ state at all, and why its footer says the plan is bought once for
the organisation rather than offering to buy one per project.

## Content language on the General card (MOTIR-8091 · Story MOTIR-7731) — AMENDS Panel 2

**Design system — verdict: ON MOTIR DESIGN, branch (a).** Read: `package.json`
(depends on `"@motir/design-system": "workspace:*"`), `app/globals.css` (line 13,
`@import '@motir/design-system/theme.css'`), and
`node_modules/@motir/design-system/package.json` (**0.13.0**, which exports
`./mock`). The axes are each person's own (`app/layout.tsx` stamps their applied
`data-style` / `data-palette` / `data-type`), so the mock is drawn at the
package defaults (`DEFAULT_STYLE_ID` · `DEFAULT_PALETTE_ID` · `DEFAULT_TYPE_ID`).
It is built with the package's `renderMock` from its real parts — `Card`,
`Input`, `FormField`, `Combobox`, `Button`, `Pill`, `SectionLabel`. Three
surfaces `renderMock` cannot open statically are drawn with the exact class lists
those parts carry in 0.13.0: the `Combobox` listbox (a portal), the `Modal`
panel and the `Toast` item (both Radix). The settings rails use
`components/ui/Sidebar.tsx`'s row classes. **Nothing new is proposed for the
package** and no product-local component is added: every element here is a part
that already ships.

**Asset:** [`org-admin--content-language.mock.html`](./org-admin--content-language.mock.html),
a DELTA of [`org-admin.mock.html`](./org-admin.mock.html) **Panel 2** (the
General card), which stays unmodified. The card is drawn as
`app/(authed)/settings/organization/_components/OrgGeneralCard.tsx` renders it
on `main` (512db0943), read from source and composed from the same parts, with
one row added.

### What changes

The General card gains a **Content language** row under **Organization name**.
It is the language Motir's planner and agents write this organisation's NEW work
in (`Organization.contentLanguage`, MOTIR-8092), and it is distinct from each
person's **display language** (`Account settings ▸ Language & region`, the
`NEXT_LOCALE` preference), which it never changes.

### ⚠️ How a member reaches the value — verified, and the design's answer

The card asked whether a plain member can open General at all. **They cannot,
and this design does not change that:**

- `app/(authed)/settings/organization/page.tsx` renders `OrgGeneralCard` only
  when `orgCan(current.role, 'manageOrgSettings')` — owner and admin. A member
  who reaches the page (below the workspace-tier reveal, for the §6d fold-in)
  sees the folded-in workspace sections and NO org-scoped card; above the reveal
  the page is `notFound()` for them (MOTIR-6312 · panel 3d).
- `lib/settings/organizationSettingsNav.ts` hides the org rail's rows from a
  member above the reveal, and the role model's approved criterion is that "an
  org Member sees no org settings beyond their own profile".
- `OrgGeneralCard` takes `role` but draws `isOwner ? owner : admin` without a
  member case, which is consistent: it is never rendered for one.

So the **read-only member variant lives on the member's OWN Language pane**,
the place every person already goes for language: `Account settings ▸ Language &
region` (`app/(authed)/settings/account/language/page.tsx`, `LanguageCard`). The
shipped card gains a second settings-row under **Display language**, separated
by the card's existing hairline grammar:

- label **"Content language · {org}"**, description _"The language Motir's
  planner and agents write {org}'s new work in. Set by the organization's owners
  and admins; it doesn't change your display language."_
- the value as **plain text** in the control column (`lang` set to the code), at
  the same position as the Display language select, so the row lines up with the
  editable row above it. No select, no Save.
- An **owner/admin** sees the same row plus a link, **"Change in Organization
  settings"** (`--el-link`), to `/settings/organization` — the way back to the
  control (panel 2b).
- `{org}` is the ACTIVE organisation, resolved the way the shell resolves it
  (`preferredOrganizationId`). A person with no active organisation sees no row.

**Consequence for the access path, flagged:** the control card (MOTIR-8095) now
touches TWO surfaces — `OrgGeneralCard` and `LanguageCard` — and the account
Language page must read the active organisation's `contentLanguage`
(`OrganizationDTO.contentLanguage`, MOTIR-8094 makes every member's read carry
it). The org page's gates are unchanged.

**The doors are drawn (panel 1):** owner/admin — the org menu's **Settings** row
(`OrgControl`) ▸ the org rail's **Organisation** row, General card first;
member — the user menu's **Account settings** ▸ the account rail's **Language &
region** row.

### States (panel by panel)

| panel | state                   | what is drawn                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | the doors               | org menu ▸ Settings ▸ Organisation (owner/admin); user menu ▸ Account settings ▸ Language & region (member)                                                                                                                                                                                                                                                                                             |
| 2     | at rest, side by side   | owner/admin: the General card with **Content language** = `中文` (`Combobox`, own-script label, helper text). Member: the Language card's read-only row                                                                                                                                                                                                                                                 |
| 2b    | in their panes          | the member's pane; the owner/admin's pane with **Change in Organization settings**                                                                                                                                                                                                                                                                                                                      |
| 3     | options open            | all eleven, each in its own script, in `lib/i18n/locales.ts` order — English, 中文, 日本語, 한국어, Deutsch, Français, Español, Italiano, Nederlands, Polski, Português — current one checked (`--el-accent-on-surface`), the hovered one on `--el-option-active-bg`. The list IS `locales.map(l => ({ value: l, label: localeLabel[l], lang: l }))`, `LanguageCard`'s own option list — no second copy |
| 4     | changed (dirty)         | `日本語` picked, nothing sent                                                                                                                                                                                                                                                                                                                                                                           |
| 5     | confirm, idle + pending | `Modal` size `md`, initial focus on **Cancel** (the `MembersOnlyConfirmDialog` precedent). Pending: Confirm `loading`, Cancel / × / Escape inert                                                                                                                                                                                                                                                        |
| 5b    | cancelled               | dialog closed, nothing sent, the select back on the STORED value                                                                                                                                                                                                                                                                                                                                        |
| 6     | saving error            | the select back on the stored value + the card's existing error toast **"Couldn't save changes"** (`orgAdmin.settings.saveError`)                                                                                                                                                                                                                                                                       |
| 7     | saved                   | the card's existing success toast **"Organization updated"** (`orgAdmin.settings.saved`), the new value shown, and the attribution line                                                                                                                                                                                                                                                                 |
| 8     | narrow (360px)          | the card's header and footer stack (Save full-width), the dialog fits with its buttons stacked (primary on top), the member row stacks; `Português` and `Nederlands` render whole — the trigger is `16rem` max and the listbox sizes to its widest label (`w-max`, capped `18rem`), so no own-script label truncates                                                                                    |

**No "nothing recorded yet" state.** Every organisation has a value: existing
ones are backfilled `en` (MOTIR-8092) and new ones are set at registration
(MOTIR-8093). The control is never empty and draws no placeholder.

### Save covers Name AND language — one button, the confirm first

The card keeps ONE **Save changes** with its shipped enable rule (disabled only
while the name is blank). On Save:

1. **Language unchanged** → the name saves exactly as today (`PATCH
/api/organizations/[orgId]`), no dialog.
2. **Language changed** → the confirm opens FIRST; **nothing is sent until
   Confirm.** Cancel / × / Escape closes it, sends nothing (not the name either),
   returns focus to Save and puts the select back on the stored value; a typed
   name stays typed.
3. **Confirm** → `PATCH /api/organizations/[orgId]/content-language` (MOTIR-8094)
   first; only when it succeeds is a changed name sent. Either failing → the
   error toast, and the select reverts to the stored value. One success toast for
   the whole save, then `router.refresh()` (the card's existing explicit-Save
   pattern).

### The confirm — copy (en)

- Title: **"Change the content language?"**
- From → to chips: the old language on `--el-muted`, an arrow, the new on
  `--el-tint-lavender` (`--el-text-strong`), each with its own `lang`.
- _"From now on, Motir's planner and agents write {org}'s new work in **{to}**
  instead of **{from}**."_
- _"Work that already exists keeps its text and its language. Nothing is
  translated or rewritten — only new writing changes."_
- _"The change is recorded with your name and today's date."_ (`text-xs`)
- Buttons: **Cancel** (`secondary`) · **"Change to {to}"** (`primary`).

`{from}` / `{to}` are `localeLabel` endonyms, never translated into the display
language — the reader is choosing a language by its own name.

### Attribution — shown on the General card only, latest change only

**Under the control, below the helper text:** _"Changed from {from} by {person}
on {date}"_ (`text-xs`, `--el-text-secondary`), from the NEWEST row of
`listContentLanguageChanges` (MOTIR-8094). `{person}` is that user's display
name (their email when they have none; "a former member" when the user is
gone); `{date}` is the date formatted in the reader's display language.

- **Shown only when a change has been recorded.** The registration default
  writes no history row, so a never-changed organisation shows no line.
- **Owner/admin only.** `listContentLanguageChanges` is refused to a member, and
  the member's row shows the value alone.
- **Not a history.** One line, the latest change. The full list stays readable
  through the service; any page that shows it is later work.

### Token roles

| element                             | colour                                                                 | shape                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| row label                           | `--el-text` (`FormField`)                                              | —                                                                             |
| helper text                         | `--el-text-helper` (`FormField`)                                       | —                                                                             |
| attribution line                    | `--el-text-secondary`                                                  | —                                                                             |
| select trigger / listbox            | `Combobox`'s own                                                       | `--radius-input` · `--height-control` / `--radius-card` · `--shadow-elevated` |
| option row · hovered · check        | `--el-text` · `--el-option-active-bg` · `--el-accent-on-surface`       | `--radius-control` · `--spacing-control-x/y`                                  |
| member read-only value              | `--el-text`                                                            | —                                                                             |
| member row description (white card) | `--el-text-muted` (as `LanguageCard`'s)                                | —                                                                             |
| "Change in Organization settings"   | `--el-link`                                                            | —                                                                             |
| dialog panel                        | `Modal`'s own                                                          | `--radius-modal` · `--shadow-modal`                                           |
| dialog body copy                    | `--el-text-secondary`, names `--el-text`                               | —                                                                             |
| from chip · to chip                 | `--el-muted` + `--el-text` · `--el-tint-lavender` + `--el-text-strong` | `--radius-badge` · `--spacing-chip-x/y`                                       |
| toasts                              | `Toast`'s `success` / `error`                                          | `--radius-card` · `--shadow-elevated`                                         |

### Copy strings (en)

New keys, `orgAdmin.settings.*` unless noted:

- `contentLanguageLabel` — "Content language"
- `contentLanguageHelp` — "The language Motir's planner and agents write this
  organization's new work in. It doesn't change the language Motir's own menus
  are shown in — that is each person's display language."
- `contentLanguageChangedBy` — "Changed from {from} by {person} on {date}"
- `contentLanguageConfirmTitle` — "Change the content language?"
- `contentLanguageConfirmBody` — "From now on, Motir's planner and agents write
  {org}'s new work in <b>{to}</b> instead of <b>{from}</b>."
- `contentLanguageConfirmKeeps` — "Work that already exists keeps its text and its
  language. Nothing is translated or rewritten — only new writing changes."
- `contentLanguageConfirmRecorded` — "The change is recorded with your name and
  today's date."
- `contentLanguageConfirmCta` — "Change to {to}"
- `settings.language.contentLanguage.label` — "Content language · {org}"
- `settings.language.contentLanguage.desc` — "The language Motir's planner and
  agents write {org}'s new work in. Set by the organization's owners and admins;
  it doesn't change your display language."
- `settings.language.contentLanguage.changeLink` — "Change in Organization
  settings"

Cancel reuses `common.cancel`; the toasts reuse `orgAdmin.settings.saved` /
`saveError`. Every key lands in all eleven catalogues
(`tests/i18n-catalog.test.ts`).

### Cards this design reads (`relates_to`)

MOTIR-8094 (the change service/route: owner/admin only, members refused, the
who/from/to/when record) and MOTIR-8095 (the control, which builds every state
above). The story's acceptance criteria and its Verification steps 5–6 are what
panels 4–7 draw.

## Settings › Organisation › Fleet — what the organisation runs on Motir's fleet, and how an owner or admin stops it (delta, 2026-11-04)

**Design system — verdict: ON MOTIR DESIGN, branch (a).** Read: `package.json`
(`"@motir/design-system": "workspace:*"`), `app/globals.css`
(`@import '@motir/design-system/theme.css'`) and
`packages/design-system/package.json` (**0.19.0**, which exports `./mock`). The
axes are each person's own (`app/layout.tsx` stamps their applied `data-style` /
`data-palette` / `data-type`), so the mock is drawn at the package defaults
(`DEFAULT_STYLE_ID` · `DEFAULT_PALETTE_ID` · `DEFAULT_TYPE_ID`) on a full-width
board. It is built with the package's `renderMock` from the real parts — `Card`,
`Button`, `Pill`, `EmptyState` — and the app's own `components/ui/Sidebar.tsx`
rail, driven by the real `lib/settings/organizationSettingsNav.ts` registry with
the proposed row inserted, plus `Meter` from the billing pane. Two surfaces
`renderMock` cannot open statically are drawn with the exact class lists their
parts carry: the `Modal` panel (Radix portals) and the notification drawer row
(`app/(authed)/_components/NotificationRow.tsx`). **Nothing new is proposed for
the package**, and no product-local component beyond the page's own sections.

**Asset:** [`org-admin--fleet.mock.html`](./org-admin--fleet.mock.html), a NEW
delta. It amends § _Where it lives_ (the organisation settings rail, panels
7a–7d of [`org-admin.mock.html`](./org-admin.mock.html)) by one row, and adds
one pane to the area. No existing mock is edited.

**Composed from shipped grammar, not redrawn.** The tiles are the platform
tenant page's Fleet card tiles (`OrgFleetCard`: the four-up grid, the index tile
on `--el-surface-soft`) carrying the organisation's own Fleet use figures, with
the Billing & plans `Meter` under each figure that has one. The section cards
use `OrgFleetCard`'s header grammar (tinted icon chip, `text-sm` title, a
secondary lead). The Stop everything confirmation, its effect list, its
unreadable-counts state and the result banner are the platform's
`StopContainersDialog` grammar, minus the operator's reason field. The member's
forbidden panel is the area's existing `EmptyState` + `Lock` state
(`orgAdmin.states.forbiddenTitle`).

### Where it lives — the door

The organisation settings rail gains **Fleet** in the **Billing** group,
**after Usage & cost and before Billing & plans**, at
`/settings/organization/fleet`, icon `Server` (the Fleet card's own glyph). The
row is **owner/admin only** and **present only where the fleet meter is**
(the registry's `orgAdminOnly` + `cloudOnly`, the same flags Billing & plans
carries). So a plain member's rail has no Fleet row, and on a build without the
fleet meter the row is absent for everyone and the route answers 404. Panel 1
draws all three rails side by side.

### The page (top to bottom)

| element                        | what it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| page header                    | breadcrumb **"{org} · Settings"**, `h1` **"Fleet"** (`font-serif text-3xl`), lead _"What {org} is running on Motir's fleet right now, and the controls to stop it. Capacity requests stay on Billing & plans › Fleet use."_ — the last four words a `--el-link` to `/settings/organization/billing#fleet-use`. Column `mx-auto max-w-[64rem]`, the Usage pane's width.                                                                                                                                                                                        |
| refresh bar                    | between two `--el-border` hairlines. Left: the cue _"Updated {time} · refreshes every 30 seconds while this tab is open"_ (`RotateCw`, `--el-text-secondary`, an `aria-live="polite"` region) and under it the **last-stop line**. Right: **Refresh** (`Button` secondary, `RotateCw`) and **Stop everything** (`Button` secondary, `Ban` — the platform's trigger grammar; the danger fill is the confirm's).                                                                                                                                                |
| last-stop line                 | _"Last stopped by {name}, {when}"_; before any stop _"No one in {org} has stopped fleet work yet."_ After this person's own stop it reads _"Last stopped by you, {when}"_.                                                                                                                                                                                                                                                                                                                                                                                    |
| tiles                          | four tiles: **Agent runs in parallel** (`Sparkles`, _n of figure_, meter), **Agents** (`Server`, live agents of the org figure, meter, _"Running and hibernating"_), **CI jobs in flight** (`Layers`, _n of figure_, meter, _"{n} waiting"_), **Index jobs** (`Folder`, a bare count, _"Not charged"_, on `--el-surface-soft`). The figures are the Fleet use figures; the page derives none.                                                                                                                                                                 |
| Agent runs                     | chip `--el-tint-lavender` / `--el-accent-on-surface`. One row per live run: the card key (mono, `--el-text-secondary`) and title, then _"{project} · started by {name} · {time} · Open run"_ (`--el-link` to the run page). Status `Pill severity="info"` **Running**. Action **Cancel** (`Button` secondary `sm`), labelled _"Cancel the run of {key}"_. Count chip `Pill tone="neutral"` _"{n} live"_.                                                                                                                                                      |
| Agent instances                | chip `--el-tint-sky` / `--el-info`. Lead _"Every member's agents, running or hibernating. Only Hibernate is offered here."_ Row: _"{owner}'s agent · {profile}"_, then _"{project} · running since {time}"_ / _"hibernating since {when}"_. Status `Pill severity="success"` **Running** or `Pill tone="archived"` **Hibernating**. A running row has **Hibernate** (`Button` secondary `sm`, `Moon`), labelled _"Hibernate {owner}'s agent"_; a hibernating row has **no action**. **No row links anywhere**: not to the agent's panel, not to its terminal. |
| CI jobs                        | chip `--el-tint-mint` / `--el-success`. Row: the repository `owner/name` (mono) · workflow · job, then _"{project} · queued {time} · View on GitHub"_ (`--el-link` + `ExternalLink`, to the Actions run). Status `Pill severity="success"` **Running**, or `Pill tone="awaiting"` **"Waiting · {cause}"** with the cause in Fleet use's three words: _plan limit_, _pool full_, _other_. No stop control per job.                                                                                                                                             |
| Index jobs                     | chip `--el-surface-soft` / `--el-text-secondary` (inactive: nothing to do here). A count _"{n} running"_ and the line _"Indexing keeps code search current. It is not charged and is not stopped here."_ **No control.**                                                                                                                                                                                                                                                                                                                                      |
| Stopped by Motir · last 7 days | chip `--el-tint-peach` / `--el-warning`. Lead _"Machines Motir itself stopped for this organisation, and why."_ Row: the kind of work (_CI job container_, _Agent run_, _Agent instance_), then _"{when} · {reason}"_ with the reason in plain words: _"its job had already ended"_, _"no record of it was found"_, _"the organisation's work was stopped"_. Status `Pill tone="neutral"` **Done**, or `Pill severity="warning"` **Did not complete**.                                                                                                        |

Index jobs and Stopped by Motir sit side by side (`md:grid-cols-2`) under the
three live sections.

### States (panel by panel)

| panel | state                               | what is drawn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | the door                            | owner/admin rail with Fleet after Usage & cost (active); a plain member's rail (Organisation only); an owner/admin rail on a build without the fleet meter (no Fleet, no Billing & plans)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2     | populated                           | a live hosted run, another member's running agent, a second running agent, a hibernating one, a CI job in flight and one waiting on the plan limit, one index job, three Motir stops                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3     | empty                               | every section in its own words (_"No agent run is live."_, _"No agent is running or hibernating."_, _"No CI job is in flight or waiting."_, _"0 running"_, _"Motir stopped nothing for this organisation in the last 7 days."_); tiles at 0; **Stop everything disabled**; the never-stopped line                                                                                                                                                                                                                                                                                                                                  |
| 4a    | first load                          | the page header is real (it needs no read); tiles and sections show `--el-muted` pulse lines with `aria-busy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4b    | the 30-second refresh               | the LAST data stays on screen; Refresh shows its `loading` spinner and the cue reads _"Refreshing…"_. A refresh never blanks a section                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5     | one section fails                   | Agent instances shows the error callout (`--el-tint-rose`, `TriangleAlert` in `--el-danger`, `role="alert"`): **"Couldn't read the agent instances"** / _"Nothing here is shown as zero. The other sections are unaffected."_ with **Retry**. Every other section still shows data, and its count chip is not drawn — never a 0                                                                                                                                                                                                                                                                                                    |
| 6a/6b | Cancel run                          | `Modal` (`alertdialog`, size `md`): **"Cancel this run?"**, description _"{key} · {title}"_, body _"{name} started this run at {time}. Cancelling closes it as **cancelled** and stops its machine now. Work the agent pushed stays on its branch."_ Footer **Keep it running** (ghost) · **Cancel run** (danger, `Ban`). In flight: **Cancelling…** `loading`, Keep it running and × inert                                                                                                                                                                                                                                        |
| 7a/7b | Hibernate another member's agent    | **"Hibernate {owner}'s agent?"**, description _"{profile} · {project} · running since {time}"_, body _"The machine stops and its files are kept. A card running in it is cancelled first."_ and the sky callout _"**{owner} will be told** that you hibernated it, and when. Only they can wake, open or delete it."_ Footer **Keep it running** · **Hibernate agent** (danger, `Moon`). In flight: **Hibernating…** in the dialog and on the row's button                                                                                                                                                                         |
| 7c    | after Hibernate                     | the row reads **"Hibernating · since {time}"** (`tone="archived"`) and offers no action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8a    | Stop everything — counting          | pulse lines + _"Counting what is running…"_ (`aria-live`); the confirm is disabled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8b    | Stop everything — counts read       | **"Stop everything {org} runs?"**, _"This stops the charged work below, now."_ The effect list, count first: _"{n} CI job cancelled and **{n} container** stopped"_, _"{n} agent run ended"_, _"{n} running agents hibernated"_, and the kept line on `--el-surface-soft`: _"{n} index job keeps running — indexing is not stopped here"_. Sky callout _"Nothing is blocked afterwards: members can start new work straight away. The owners of hibernated agents are told."_ and _"Counted at {time}."_ Footer **Cancel** · **Stop everything** (danger). No reason field: that is the platform operator's audit, not this page's |
| 8c    | Stop everything — counts unreadable | the rose callout **"Couldn't count what is running"** / _"Nothing has been stopped. Try again to read the counts before you confirm."_ and **Try again** (secondary, `RotateCw`) **replaces** the confirm. Nobody confirms against counts nobody read                                                                                                                                                                                                                                                                                                                                                                              |
| 9a    | result — everything stopped         | a banner under the refresh bar (`--el-tint-mint`, `CircleCheck` in `--el-success`, `role="status"`): **"Everything was stopped"**, one line per path, _"Index jobs were left running."_, _"Stopped by you, {when}."_ and **Dismiss** (ghost `sm`). The page under it shows the after-state; the last-stop line reads _"Last stopped by you, {when}"_                                                                                                                                                                                                                                                                               |
| 9b    | result — partial failure            | `--el-tint-yellow`, `TriangleAlert` in `--el-warning`: **"Some work did not stop"**, each path as _"{done} of {total} …"_ and, under a path that failed, which one and what to do (_"{owner}'s agent did not stop: the stop did not confirm. Try Hibernate on its row."_)                                                                                                                                                                                                                                                                                                                                                          |
| 10    | Index jobs and Motir's stops        | each with entries and empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 11    | plain member on the URL             | the area's forbidden `EmptyState` (`Lock`): **"You don't have access to this"** / _"Only an owner or admin of {org} can see this page. Ask one of them if you need it."_, beside the member's rail with no Fleet row                                                                                                                                                                                                                                                                                                                                                                                                               |
| 12    | the agent's owner                   | the drawer's notification row: the actor's initial avatar with a `Moon` badge on **`--el-notif-agent-hibernated`**, summary _"**{actor}** hibernated your agent **{agent}**"_, the relative time right (absolute on hover), excerpt _"An organisation admin stopped it at {time}. Its files are kept; wake it from Agents."_ It has an actor, so it is NOT an actorless row. It deep-links nowhere                                                                                                                                                                                                                                 |
| 13    | longest strings                     | en and zh: the rail row (_Fleet_ / _集群_), Refresh / Stop everything / Hibernate agent / Cancel run / Try again (_刷新_ / _全部停止_ / _让智能体休眠_ / _取消运行_ / _重试_) and the three confirmation titles; none clips, the titles wrap inside the `28rem` panel                                                                                                                                                                                                                                                                                                                                                              |

### The result stays until dismissed

The banner is the page's own state and survives the 30-second re-read and a
press of Refresh: it goes only when **Dismiss** is pressed or the page is left.
It is never a toast, because a partial failure must stay readable until it has
been read (the platform's `StopContainersDialog` rule). A Cancel or a Hibernate
on one row writes no banner: its row changes, and a failure there is an error
toast naming the run or the agent.

### The one token this delta proposes

**`--el-notif-agent-hibernated` → `var(--color-info)`**, beside
`--el-notif-access-refused`, for the owner's notification badge. Info, not
warning or danger: nothing was lost (the files are kept and the owner can wake
it), but somebody else acted on their agent and they should know. It is declared
in the mock's own token block until the build adds it to `theme.css`.

### Accessibility contract

- **Each confirmation** is a `Modal` with `role="alertdialog"`. Opening it moves
  focus to the **safe** button (_Keep it running_ / _Cancel_), never to the
  destructive one. Escape, × and the safe button close it and return focus to
  the control that opened it (the row's Cancel or Hibernate, or the header's Stop
  everything). While a stop is in flight, ×, Escape and the safe button are
  inert, so the dialog cannot be closed mid-request.
- **Every row action is labelled with its subject** — _"Cancel the run of
  {key}"_, _"Hibernate {owner}'s agent"_ — so a list of identical buttons reads
  apart. The Dismiss button is _"Dismiss the stop result"_.
- **Live regions.** The refresh cue is `aria-live="polite"` and announces
  _"Refreshing…"_ / _"Updated {time}"_. A section's read error is `role="alert"`.
  The stop result is `role="status"`. The counting line in Stop everything is
  `aria-live="polite"`.
- **Busy sections** carry `aria-busy` while their first read runs.
- **The auto-refresh pauses while the tab is hidden**, and is said in words on
  the page ("while this tab is open") rather than conveyed by motion.
- **Ink.** Every caption, meta line and lead is `--el-text-secondary`, which
  clears AA on every surface here; chips carry the hue in the tint background
  with `--el-text-strong` ink.

### Out of scope here

Spend by category, org-owned switches for hosted runs, AI planning and web
search, an organisation audit log, any platform-only view, and opening, waking,
deleting or reading inside another member's agent. Capacity requests stay on
Billing & plans › Fleet use, which the lead links to.

### Revision (2026-11-05) — "Hosted agent runs" reads "Agent runs"

Requested on the design review: the section and its words drop "hosted". The section title is
**Agent runs**, its tile **Agent runs in parallel**, its row kind _Agent run_, its empty state
_"No agent run is live."_, its stop-summary line _"{n} agent run ended"_, and its subtitle
_"Cards Motir’s agent is building for this organisation"_. Nothing else changes: the section still
lists the org's hosted runs (the `hosted_agent` fleet slots), and `data-testid="fleet-hosted"` stays.

## Settings › Organisation › AI models — which model each Motir AI function uses for the organisation (delta, 2026-11-10)

**Design system — verdict: ON MOTIR DESIGN, branch (a).** Read: `package.json`
(`"@motir/design-system": "workspace:*"`), `app/globals.css`
(`@import '@motir/design-system/theme.css'`) and
`packages/design-system/package.json` (which exports `./mock`). The axes are
each person's own (`app/layout.tsx` stamps their applied `data-style` /
`data-palette` / `data-type`), so the mocks are drawn at the package defaults
(`warm-editorial` · `motir` · `motir`) on full-width boards, built with the
package's `renderMock`. Rendered from the real parts: `SettingsCard`,
`Combobox`, `Pill`, `Button`, `Input`, the app's `Sidebar` rail, the console's
`RunModelList` and `PlannerModelsUnavailable`, and the Run hosted door's
`HostedModelPicker` and `HostedModelProvenance`. Drawn with the exact class
lists their parts carry, because they portal and render nothing statically:
the `Modal` panel and the `Toast`. **Nothing new is proposed for the package**;
the room is one product-local component composed from the parts above.

**Assets** (three delta mocks; no existing mock is edited):

| mock                                                                                                               | amends                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`org-admin--ai-models.mock.html`](./org-admin--ai-models.mock.html)                                               | § _Where it lives_ (the organisation settings rail, panels 7a–7d of [`org-admin.mock.html`](./org-admin.mock.html)) by one row, and adds one pane to the area                                                               |
| [`../platform-admin/console--function-defaults.mock.html`](../platform-admin/console--function-defaults.mock.html) | the AI planning page of [`../platform-admin/console--ai-planning.mock.html`](../platform-admin/console--ai-planning.mock.html) and the Hosted-run models page (`platform-admin/design-notes.md`, the Model lists amendment) |
| [`../runs/run-section--org-model-defaults.mock.html`](../runs/run-section--org-model-defaults.mock.html)           | the source line of `runs/design-notes.md` § _Run hosted — the picker says where its model came from_ (panels F1–F6)                                                                                                         |

This section is the spec for all three. `platform-admin/design-notes.md` and
`runs/design-notes.md` each carry a short section pointing here.

### Composed from shipped grammar, not redrawn

- **The room's rows are the project Hosted agent room's rows**
  (`HostedAgentSettingsEditor`): the effective model in a `Combobox`, a source
  `Pill`, a ghost reset button, a withdrawn note with the stored id struck
  through, the peach unavailable callout with Try again, and an explicit Save
  footer. Someone who knows that room reads this one.
- **The console's new rows are `PlannerModelRows`' rows**: a picker only for a
  superadmin, a per-row Save, the last-changed column, the confirm-with-reason
  dialog, the withdrawn chip and the console's error card.
- **The picker's line is the shipped `HostedModelProvenance` line**; only its
  words are new.

### The door — the AI models rail row

The organisation settings rail gains **AI models** in the **General** group,
**directly under Git**, at `/settings/organization/ai-models`, icon `Sparkles`
(the glyph the product uses for Motir AI, as on the console's AI planning card).

| decision                                                          | reason                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **General**, after Git                                            | It configures how the organisation's own tooling behaves, which is what General holds (Organisation, Git). It is not about people (Access) and not about money (Billing), even though the cost line mentions credits.                                                                        |
| **owner/admin only** (`orgAdminOnly`)                             | Every org row but Organisation is owner/admin only, and the shipped org-admin design gives a plain member no org rows.                                                                                                                                                                       |
| **cloud only** (`cloudOnly`)                                      | Whether an organisation may choose depends on its plan tier, and plan tiers exist only on the cloud build. A self-host build has no tier to qualify on and no hosted planning or hosted runs to choose for, so the row is absent and the route answers 404, as Billing & plans and Fleet do. |
| present on **every tier** for an owner/admin                      | Below Pro the room is the place that says how to get the feature (the locked panel). Hiding the row would hide the upgrade path; an entry point that shows a lock is still a promise the room keeps.                                                                                         |
| a **plain member who opens the address** gets the read-only state | The Usage & cost posture: no row, but the page answers a member with what they may read. A member sees which model their organisation uses, which is useful when a result looks off.                                                                                                         |

Panel 1 draws the four rails: owner/admin (the room open), a plain member above
the workspace reveal (no org rows), a plain member with one workspace
(Organisation only), and an owner/admin on a self-host build (no AI models, no
Fleet, no Billing & plans).

### The page (top to bottom)

| element                   | what it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| page header               | breadcrumb **"{org} · Settings"** (`font-sans text-xs uppercase`, `--el-text-secondary`), `h1` **"AI models"** (`font-serif text-3xl`, `--el-text`), lead _"Which model each Motir AI function uses across {org}. A change applies from the next job or run."_ (`--el-text-secondary`). Column `mx-auto max-w-[64rem]`, the Fleet pane's width.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Function table**        | ONE `SettingsCard` (icon `Sparkles`), title **"Models by function"**, subtitle _"Each function uses the platform default until your organisation chooses another."_ Its body holds two groups and the precedence callout; its footer is the Save footer. One card and one Save, because the room is one setting with seven parts and a person changes several at once.                                                                                                                                                                                                                                                                                                                                                                                                              |
| group head                | per group: a mono eyebrow (`font-mono text-[11px] uppercase tracking-[0.06em]`, `--el-text-eyebrow`) and a list line (`text-xs`, `--el-text-secondary`) over a `--el-border` hairline. **"Planning-side"** / _"Chosen from the platform's planning-model list"_; **"Run-side"** / _"Chosen from the platform's run-model list"_.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Function row**          | a three-column grid `[minmax(0,13rem)_minmax(0,18rem)_minmax(0,1fr)]`, `py-3`, `--el-border-soft` rule: the function name (`text-sm font-medium`, `--el-text`) and its one-line description (`text-xs`, `--el-text-secondary`); the model chooser; the source cell.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| the rows                  | Planning-side: **Planning** _"Every session of a plan: the walk and its repairs"_ · **Guide** _"Guide me through, on a card a person does"_ · **Debug** _"Motir AI diagnosing a defect into a bug"_ · **Ask** _"The Motir AI conversation and Grill me"_. Run-side: **Review agent** _"Hosted reviews. Whether a project reviews with an agent stays in its Approvals settings."_ · **Agent run** as a heading row (_"Hosted build runs, by the card's difficulty. A project's own override for a difficulty still wins over the organisation's."_) over four difficulty rows **Trivial · Low · Medium · High** (easiest first, the name indented `pl-4`, no description) · **Design run** _"A hosted run on a design card"_. The dry-run review model appears nowhere in the room. |
| **model chooser**         | `Combobox`, `searchable={false}`, label _"Model for {function}"_. It shows the EFFECTIVE model (what the next job would use), never a blank. Options: that group's offered models only, each `label` the model id and `secondary` its provider (the console's option grammar); the platform default carries the description _"Platform default"_. Picking the platform default is the same as Clear: the organisation never stores the model it inherits. Design run, when it inherits and the platform has no design-run default, shows the placeholder _"Follows the card's difficulty"_.                                                                                                                                                                                         |
| **source pill**           | **"Organisation choice"** (`Pill` with `bg-(--el-tint-lavender)` + `--el-text-strong`, the Hosted room's Override pill) or **"Inherits platform default"** (`Pill tone="neutral"`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Clear**                 | `Button variant="ghost" size="sm"`, `RotateCcw` in `--el-icon-muted`, label **"Clear"**, accessible name _"Clear the {function} choice"_. Only on a row holding an organisation choice (offered or withdrawn). It stages like any change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| staged marker             | _"Not saved yet"_ (`text-xs`, `--el-text-secondary`) in the source cell of a row whose chooser differs from what is stored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| precedence + cost callout | the Hosted room's plain callout (`--el-surface`, `Info` in `--el-icon-muted`): **"Which model a job uses"**_, first match wins: the person's pick on Run hosted → the project's own override (agent run only) → {org}'s choice → the platform default._ and on its own line _"Each model is billed at its own rate, so a stronger model uses more of {org}'s credits."_                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Save footer**           | the Hosted room's footer: `--el-surface-soft` band, `--el-border-soft` top rule; left the hint _"You have unsaved changes."_ (only while dirty); right **Cancel** (secondary) and **Save changes** (primary), both disabled until a row differs. Save sends only the rows that differ; the response replaces the room in place (no refresh).                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| saved toast               | `Toast variant="success"`: **"AI models saved"** / _"{org} uses them from the next job or run."_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| refusal line              | under the refused row (`role="alert"`, `text-xs`, `--el-danger-on-surface`): _"Not saved: {model} stopped being offered for {function} before the save reached it. {function} keeps its current model; choose another."_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **withdrawn chip**        | `Pill severity="warning"` **"No longer offered"** beside the source pill, plus the Hosted room's note under the row (`role="note"`, `TriangleAlert` in `--el-warning`, `text-[12.5px]`, `--el-text`): _"~~{stored id}~~ is no longer offered, so {function} falls back to the platform default, {platform model}, until you choose another."_ The id is struck through in `--el-text-secondary`. The chooser shows the fallback, and the source pill reads Inherits, because that is what runs.                                                                                                                                                                                                                                                                                     |
| **locked panel**          | replaces both groups: a `--el-surface` box (`--radius-card`, `--el-border`, `--spacing-card-padding-16`) with a lavender `Lock` chip, **"Choosing models is part of Pro and above"** (`text-sm font-semibold`), _"{org} is on {plan}. On Pro and above, an owner or admin chooses which model each Motir AI function uses for the whole organisation. Until then every function uses the platform default."_ (`--el-text-secondary`), and **See plans** (`buttonVariants` secondary `sm`, a link to `/settings/organization/billing`). No model name, no chooser, no Clear, no Save footer.                                                                                                                                                                                         |
| **not-applying line**     | inside the locked panel, under its body (`text-xs`, `--el-text-strong`): _"{org}'s saved choices are kept. They apply again when it moves to Pro or above."_ It names no model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **read-only line**        | the Hosted room's plain callout with `Lock`: _"Only an owner or admin of {org} can change these."_ Rows show the effective model as text (`font-mono text-xs` id, provider in `--el-text-identifier`) with the source pill; no chooser, no Clear, no footer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **unavailable card**      | the Hosted room's peach callout (`role="status"`, `TriangleAlert` in `--el-warning`, `--el-text-strong`): _"Couldn't load the AI models, so no model is shown and nothing can be saved. Nothing has changed."_ and **Try again** (`Button` secondary `sm`, `RefreshCw`). No rows and no footer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### States (panel by panel, `org-admin--ai-models.mock.html`)

| panel | state                   | what is drawn                                                                                                                                                                |
| ----- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | the door                | the four rails above                                                                                                                                                         |
| 2     | loading                 | the header painted; every chooser in the picker's loading face (_"Loading models…"_, disabled); each source cell a `--el-muted` bar (`--radius-badge`); the card `aria-busy` |
| 3a    | editable, first visit   | every row Inherits, showing today's model; Design run _"Follows the card's difficulty"_; Save disabled                                                                       |
| 3b    | editable, mixed         | Guide, Review agent, High and Design run as Organisation choice with Clear; the rest Inherits                                                                                |
| 4     | staged, then saved      | Guide staged (_Not saved yet_, footer hint, Save enabled); after save the pill flips and the toast shows                                                                     |
| 5     | cleared                 | the cleared row reads Inherits with the platform model; no Clear                                                                                                             |
| 6     | refused save            | Debug keeps its model; the refusal line names `glm-5.1`                                                                                                                      |
| 7     | withdrawn choice        | Guide shows the fallback, Inherits + No longer offered, the struck-through note, Clear still offered                                                                         |
| 8     | locked                  | Standard org, owner: the locked panel only                                                                                                                                   |
| 9     | stored but not applying | the locked panel with the not-applying line                                                                                                                                  |
| 10    | read-only               | a member: values as text, the read-only line                                                                                                                                 |
| 11    | models cannot be read   | the unavailable card, no rows, no footer                                                                                                                                     |
| 12    | meta org on any tier    | editable; the card subtitle reads _"{org} is Motir's meta organisation, so it chooses its own models on any plan."_ and there is no upgrade note                             |
| 13    | dark                    | the editable room with a withdrawn row, and the not-applying panel                                                                                                           |

### The console's per-function default rows (`console--function-defaults.mock.html`)

**Where they live.** **Guide, Debug and Ask join the AI planning page's table**,
because they choose from the planning-model list that page already edits and
lists. **Review agent, Design run and the four agent-run difficulty defaults go
on the Hosted-run models page**, in a new **Run-side defaults** card under the
shipped list, because they choose from the run-model list that page holds, and
that list already says which model is the platform default per level. Each
page's pickers then draw from the list on the same page.

| element                | what it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI planning card       | the shipped card, retitled **"Planning-side models"** with subtitle _"Planning resolves its model from the organisation's audience: meta, then internal, then customer. Guide, Debug and Ask each have one platform default, or inherit that audience model. An organisation on Pro or above may choose its own."_ and count **"7 settings"**. First column header **"Applies to"**. The page subtitle becomes _"Which model Motir's planning-side functions use: planning for each of three audiences, and one platform default each for Guide, Debug and Ask. A change applies from the next job for every organisation that has not chosen its own."_                                                                                                      |
| group caption rows     | a full-width row, mono eyebrow (`--el-text-eyebrow`): **"Planning · by audience"**, **"Guide · Debug · Ask · platform defaults"**, **"Dry-run review · platform only"**. The audience rows and the dry-run review row are drawn exactly as they ship.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| new planning-side row  | name + description (**Guide** _"Guide me through turns"_, **Debug** _"Diagnosing a defect into a bug"_, **Ask** _"The Motir AI conversation and Grill me"_), the picker, the last-changed line, Save. Its picker's first option, in a **Default** group, is **"Inherits — the audience's planning model"** (stored unset; the dry-run row's _Same as the planning model_ pattern), then the planning list by provider. Read-only staff see the model as text or _"Inherits — the audience's planning model"_. An unset row's last-changed line reads **"Never set"**.                                                                                                                                                                                         |
| Run-side defaults card | `Card` grammar of the shipped list (icon chip `Cloud` on `--el-tint-sky`), title **"Run-side defaults"**, subtitle _"The model a hosted review, design run or agent run starts on when neither the person, the project nor the organisation chose one. Chosen from the list above."_, count **"6 settings"**, columns Function · Model · Last changed · Action. Rows: **Review agent** (_Hosted reviews_; inherits _"the run default ({model})"_), **Design run** (_A hosted run on a design card_; inherits _"the card's difficulty"_), **Agent run · Trivial / Low / Medium / High** (_Hosted build runs on a {level} card_). The four level rows arrive seeded from today's environment values and read **"Seeded from the environment · never changed"**. |
| confirm-with-reason    | the shipped `alertdialog` (size md): title **"Change the platform {function} model?"**, description _"{from} → {to}. Applies from the next {job noun} for every organisation that has not chosen its own. {Job noun plural} already running finish on the model they started with."_ (Guide: turn; Debug: diagnosis; Ask: conversation turn; Review agent: review; Design run: design run; Agent run: run). The reason `Input` is the shipped one; **Change model** stays disabled until a reason is typed (the reason-missing state).                                                                                                                                                                                                                        |
| saved                  | the row's last-changed line reads **"Changed just now by you"**; toast **"{function} model changed"** / _"{Job noun plural} now run on {model} for every organisation without its own choice."_ The audit entry records the function, from → to and the reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| withdrawn chip         | `Pill severity="warning"` **"No longer offered"** with _"{function} falls back to {what it inherits} until you choose another."_ (read-only: _"…until a superadmin chooses another."_)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| read-only              | operator and support: no picker, no Action column, and the shipped _"Only a superadmin can change these."_ under the card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| unavailable            | AI planning keeps its shipped error card. The Run-side defaults card, whose values motir-ai stores, gets the same `ErrorState`: **"Couldn't load the run-side defaults"** / _"The planning service (motir-ai) didn't respond, so no default is shown. Nothing has changed, and no value is guessed."_ and **Retry**. The run-model list above it is unaffected.                                                                                                                                                                                                                                                                                                                                                                                               |

### The Run hosted picker — the preselect reason line (`run-section--org-model-defaults.mock.html`)

The **preselect reason line** is the shipped `HostedModelProvenance` line (`-mt-1
basis-full text-xs`, `--el-text-secondary`, the bold part `font-semibold
--el-text`). New keys beside today's four (which are unchanged):

| source                           | leaf                                                 | parent                                                                                 |
| -------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| organisation default for a level | _"Organisation default for **{difficulty}**"_        | _"Organisation default for **{difficulty}**, the highest difficulty among its leaves"_ |
| organisation design-run model    | _"**Organisation design-run model**: a design card"_ | _"**Organisation design-run model**: every unfinished leaf is a design card"_          |
| platform design-run model        | _"**Design-run model**: a design card"_              | _"**Design-run model**: every unfinished leaf is a design card"_                       |

A project override still reads _"Project override for **{difficulty}**"_. A
parent with a leaf that is not a design card resolves by difficulty as today.

### Accessibility contract

- Each chooser is labelled with its function (_"Model for Guide"_); each Clear
  with its subject (_"Clear the Guide choice"_).
- The refusal line is `role="alert"`; the unavailable card is `role="status"`;
  the withdrawn note is `role="note"`; the card is `aria-busy` while loading.
- Save changes announces through the toast; the room's values change in place,
  so focus stays on the Save button.
- **Ink.** Every caption, description and lead is `--el-text-secondary` or
  stronger. `SettingsCard`'s own subtitle (`--el-text-muted`) sits on the white
  card, where it clears AA. No `--el-text-faint` text is drawn.

### Out of scope here

The Review agent switch (on/off, hosted or own agent) stays in a project's
Approvals settings. The usage page and plan review keep naming no model. The
dry-run review model stays platform-only and is never offered to an
organisation.
