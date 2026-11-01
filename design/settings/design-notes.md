# Settings — design notes

Design reference for the `settings` UI area. The headline surface is the
**account settings AREA** — the per-user settings surface, redesigned (Story 7.8
· 7.8.2) from a flat 2-card page into a grouped-nav **area** that scales as it
grows. Built FROM the real design system (`app/globals.css` `--el-*` / shape
tokens + the shipped `components/ui/*` primitives), so the code subtasks compose
the same primitives — no Pencil→code gap.

| Surface                                 | Asset                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account settings area**               | **`account-settings.mock.html`** (HTML mock)                                   | The account-settings area: the rail grouped nav + the **real** panes (Language · Notifications · Security/API tokens) + the API-token create / shown-once / revoke / empty / toast flows. Multi-panel. **Gates 7.8.3** (API tokens).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Token permission selection**          | **`token-scopes.mock.html`** (HTML mock)                                       | EXTENDS the API-tokens surface: the create-modal **permission-scope picker** (grouped Switch toggles, default all-on except delete) + the token-LIST **granted-scope display** (summary Pill + "Can delete" chip + expandable detail). Multi-panel. **Gates 7.7.19** (token scopes) and, as amended by **MOTIR-2578**, MOTIR-2579 / -2580 (the permission picker over the MOTIR-2254 catalog — SIX rows, five domains; see that section, which supersedes the 7.7.18 one).                                                                                                                                                                                                    |
| **Appearance pane**                     | **`appearance.mock.html`** (HTML mock)                                         | Motir dogfoods its own 3-axis design system: theme the Motir app itself — **Theme × Style × Palette × Type**. Applies instantly, so the whole page re-skins — the page itself is the showcase (controls + a real Motir slice), no separate preview. Reuses the area shell + onboarding picker language; flips the rail's "Soon" Appearance slot to active. Multi-panel (default · changed · dark). **Gates 7.3.58** (the pane + route).                                                                                                                                                                                                                                       |
| **Connect the CLI**                     | **`../cli-connect/cli-connect.mock.html`** (HTML mock)                         | Lives in its OWN area (`design/cli-connect/`) because it also owns the `/device` approval page, but its second surface COMPOSES INTO this area: the "Connect the CLI" panel is the first `Card` of the Security → API tokens pane, above "Your tokens". It re-specifies nothing here — the table / create modal / shown-once / revoke flows are unchanged. **Gates MOTIR-1869** (the panel); the page is MOTIR-1867.                                                                                                                                                                                                                                                          |
| **Profile pane**                        | **`profile.mock.html`** (HTML mock)                                            | The `General › Profile` personal-details pane (Linear-style Profile + Security): edit **name** (inline), **avatar** (upload / remove), **email** (change-with-confirmation), and **password** (Change-password modal for credential users · Send-a-reset-link for OAuth-only). Flips the rail's last "Soon" slot (Profile) to active. Multi-panel (resting · editing/pending/errors · change-password modal + toast · change-email + OAuth + loading · dark). **Gates the 8.8.x Profile build subtask.**                                                                                                                                                                      |
| **Two-factor authentication**           | **`two-factor.mock.html`** (HTML mock)                                         | The `Security › Two-factor authentication` pane: enrol an authenticator app, email as a labelled lower-security fallback, ten single-use recovery codes, the browsers that stopped being asked, and the way out. Adds a SECOND entry to the rail's Security group — that row is the access path. Multi-panel (off · on · enrol · codes shown once · low/exhausted/turn-off/errors · dark). **Gates MOTIR-1220**; the login challenge is `../auth/two-factor-challenge.mock.html`.                                                                                                                                                                                             |
| **Passkeys**                            | **`passkeys.mock.html`** (HTML mock)                                           | The `Security` pane's PASSKEYS card — register a WebAuthn credential, see the ones you hold, rename one, remove one. Its OWN card between the two-factor state card and the methods list, never a third row inside them. Adds NO rail entry: it is a new section on a pane that already has a door. Multi-panel (zero · populated · registering · rename · remove · refusals · dark). **Gates MOTIR-3612**; the sign-in half is `../auth/passkey-sign-in.mock.html`.                                                                                                                                                                                                          |
| **Workspace settings area**             | **`workspace-settings.mock.html`** (HTML mock)                                 | The FOURTH and last settings tier to become an AREA: the rail, its three-row registry, the switcher row that is its door, and — the thing no other tier has — the BELOW-THE-REVEAL arm, where all three routes `notFound()`, there is NO workspace rail, and every capability is folded into `/settings/organization`. Composes the three panes and re-specifies none (`design/workspaces/settings.pen` · `design/org-admin/security-policy.mock.html` · `design/jobs/`). Multi-panel (index · security · jobs · below-reveal · the switcher popover · dark · the registry). **Gates MOTIR-4846** (the area), **MOTIR-4847** (the entrance) **and MOTIR-4861** (the fold-in). |
| **Arrival frame**                       | **`arrival.mock.html`** (HTML mock)                                            | The settings family's PENDING drawing: the pane-only frame each of the 31 `settings/**` routes renders IN-PAGE after its own gate, the width-is-a-prop rule, and the three-tier streaming allocation for all 14 heavy panes. Applies `design/shell/design-notes.md` § _The navigation-pending grammar_ (2nd revision); adds no `loading.tsx`. Multi-panel (in situ · anatomy · widths · the two superseded skeletons · mount points · dark). **Gates MOTIR-3443 and MOTIR-3448.**                                                                                                                                                                                             |
| **Hosted agent room**                   | **`hosted-agent.mock.html`** (HTML mock)                                       | A PROJECT-settings room (Automation group, under AI planning): the model a hosted run uses per difficulty — Trivial · Low · Medium · High — with its source (_Platform default_ / _Override_), an override select per row and _Reset to default_. Multi-panel (access path · default · choosing · overridden · withdrawn · read-only · loading · unavailable · ~400px). Sibling: `../runs/run-section--from-difficulty.mock.html`. **MOTIR-6991.**                                                                                                                                                                                                                            |
| **Auto-translate room**                 | **`auto-translate.mock.html`** (HTML mock)                                     | A PROJECT-settings room, **Translation** (`/settings/project/translation`, Automation group, below Hosted agent): the Auto-translate work content switch that commits at once, its no-credit callout, its read-only rendering for a member without `project:administer`, and the read-back of who changed it (who · from → to · when, newest first, capped). Two keys: write `project:administer`, view `project:browse`. Multi-panel (access path · arrival · off · on · in flight + failed · no credit · read-only · refused door · read-back states · dark · ~400px). **MOTIR-8822.**                                                                                      |
| **Appearance — Typography by language** | **`appearance--fonts-by-language.mock.html`** (HTML mock, a DELTA)             | Amends the Appearance pane: no new field. The Typography axis lists the type pairings on a Latin-language page, and that language's fonts (Automatic first, each previewed in its own face) on a Japanese, Korean or Chinese page. Revision 3, after review. Multi-panel (en · ja · ja picked · ko · zh · couldn't sync · face loading · stale pick · dark · ~400px). **Gates MOTIR-7899.**                                                                                                                                                                                                                                                                                   |
| **Members — pending invitations**       | **`members-pending-invitations--pending-list.mock.html`** (HTML mock, a DELTA) | Amends the Members card: a Pending invitations block under the members list, each invitation's email delivery state, and a Resend button, with who sees it, the confirmation and refusal toasts, Show all and a narrow width. Multi-panel (Manager · pill legend · Full non-Manager · absent/empty · resend · refusals · show all + narrow).                                                                                                                                                                                                                                                                                                                                  |

## Why the whole area (the corner that was cut, then fixed)

The first pass designed **only** the API-tokens card, bolted onto the existing
flat account page. That was a corner cut: the account surface is about to hold
more personal settings, and a flat card stack does not scale. So 7.8.2 designs
the account-settings **area architecture** — but only the panes we will actually
build now (see the scope guard below).

## Architecture — an "area" with a grouped rail nav (rung 2: the shipped pattern)

Settled by **already-shipped code**, not invented: Motir's **project settings**
is an _area_ (Story 6.5) whose grouped nav swaps into the app rail (`SidebarNav`
renders it from the `lib/settings/projectSettingsNav` registry when the route is
inside the area), one page per sub-section, with a route↔registry **totality
guard** and a "Soon" placeholder slot for designed-for pages. The account
settings adopts the **same** pattern (Yue's call, 2026-06-14):

- A new **`lib/settings/accountSettingsNav`** registry — the exact shape of
  `projectSettingsNav` (typed entries with `id` / `group` / `href` / `icon` /
  `labelKey` / `access` / `placeholder`), driving (1) the rail area nav, (2) the
  command-palette deep links, (3) the totality test pairing every
  `settings/account/**/page.tsx` route 1:1 with a real (non-placeholder) entry.
- The rail's **header** shows **"← Back to Motir"** + the **user identity**
  (initial `Avatar` + name + email) + the eyebrow **"Account settings"**.
- **Groups** (rail order): **General · Preferences · Security**.
  - **General → Profile** — a reserved **"Soon"** placeholder (name / avatar /
    password later), the disabled placeholder row, like the project area's
    Automation slot.
  - **Preferences → Language** (real), **Notifications** (real), **Appearance**
    (reserved **"Soon"** — see the scope guard).
  - **Security → API tokens** — the 7.8.3 page.
- Each REAL sub-section is its own route under `app/(authed)/settings/account/…`
  (Language / Notifications / API tokens). The existing flat account page's
  `LanguageCard` / `NotificationPreferencesCard` move into their panes.

### ✅ Scope update — Appearance IS now designed (Story 7.3 · 7.3.57 / MOTIR-1074)

The scope guard below held for **7.8.2**: Appearance was a reserved **"Soon"**
slot, deliberately not mocked, because we didn't yet know how it would work.
**That future story has now arrived** — once the three design axes shipped
(`data-style` 7.3.32+, `data-palette` 7.3.48+, `data-type` 7.3.53+) the feature is
concrete, so **7.3.57 designs it for real** in a separate mock,
**`appearance.mock.html`** (the `# Appearance` section at the end of this file).
The original scope-guard reasoning is preserved verbatim below as the record of
WHY it waited.

> **(7.8.2 scope guard — Appearance is NOT designed here · Yue, 2026-06-14 — now
> SUPERSEDED by 7.3.57.)** Appearance (theme / accent / font / display style)
> appears in the nav **only as a reserved "Soon" slot**. It is deliberately
> **not** mocked as a concrete control set: **"we are not going to implement it
> like this — it's misleading."** A design that draws specific
> theme/accent/font/display-style controls we won't actually build would mislead
> the implementer. Appearance gets its **own future story** that designs it
> properly when we decide how it works. The "Soon" row keeps the area's shape
> honest without over-committing.

So the surfaces designed **in `account-settings.mock.html` (7.8.2)** are exactly:
the **area shell**, the **Language** pane, the **Notifications** pane, and the
**Security/API tokens** pane + flows. The **Appearance** pane is designed in
**`appearance.mock.html` (7.3.57)** — it flips the rail's "Soon" Appearance slot
to a real, active entry.

### ⚠️ Planning flags (surfaced, not silently absorbed)

1. **The account-settings AREA shell** — the `accountSettingsNav` registry, the
   rail-swap wiring, the `settings/account` layout, the route split (Language /
   Notifications / API tokens pages), the totality test. It is a prerequisite
   bigger than 7.8.3's original "API tokens settings UI" scope. **Recommend a new
   shell subtask under Story 7.8, with 7.8.3 `dependsOn` it** (or re-scope 7.8.3
   to "API tokens page _inside_ the new account area").
2. **Appearance** — a future personalization **story** owns it (design + build).
   Not part of 7.8; reserved as a "Soon" nav slot here. **UPDATE (7.3.57):** that
   story arrived — Story 7.3 designs (7.3.57) + builds (7.3.58) the Appearance
   pane; the design is `appearance.mock.html`, indexed below.

---

## Panel 1 — Language pane (the area shell + the shipped Language preference)

The area shell: the **rail** (`--el-sidebar-bg`, `border-(--el-sidebar-border)`)
with the back-link + user identity + grouped nav (Language active = the
canvas-inset treatment: `bg-(--el-sidebar-item-bg-active)` +
`border-(--el-sidebar-border)` + `shadow-(--shadow-subtle)` + accent icon; the
`languages` glyph), and the **content** with the serif `h2` page head + a
`max-w-[680px]` card stack.

The Language page uses the **settings-row grammar** inside a `Card` — a label +
description on the left, the control on the right, hairline-separated
(`border-(--el-border-soft)`) — the pattern that scales as region / timezone /
date-format rows land later:

- **Card "Language"** → row **"Display language"** with the shipped `Combobox`
  (input-shaped trigger + `chevron-down`), value "English". This is the existing
  `LanguageCard` (`setLocale` cookie) moved into its pane.

## Panel 2 — Notifications pane

The shipped **`NotificationPreferencesCard`** matrix inside the area — a
`grid-cols-[1fr_5rem_5rem]` of event rows × **Email / In-app** columns of
`Switch` toggles (`role="switch"`, accent track when on). Header caption
(`--el-text-secondary` uppercase) with a `--el-border` rule; rows hairline-separated.
Each switch carries an `aria-label`. No redesign — it just moves into its pane.

## Panel 3 — Security & access pane (API tokens) — the 7.8.3 surface

The human face of the **PAT substrate** (7.8.1) the MCP bearer gate (7.8.4)
consumes. A PAT is **generated once, shown once, stored only as a hash,
expiring, revocable** — the Jira / GitHub API-token shape.

**Mirror surface (rung 1, VERIFIED):** Atlassian API tokens (`id.atlassian.com`
→ Security → API tokens) — create with label + expiry, a list of label / created
/ expires / last-used, revoke per row, secret shown once. The `motir_pat_` prefix
and the shown-once monospace copy field follow GitHub's PAT shape (a greppable
prefix for secret scanners). Motir keeps its coloured personality (peach
"expiring soon" chip, accent CTA) without inventing primitives.

- **Card "Your tokens"** with a header slot: title + sub on the left, the
  **"Create token"** primary `Button` (size `sm`, `plus` glyph) on the right.
- **The table** — a borderless row list (org-members roster grammar). Columns:
  **Label · Token · Created · Expires · Last used · Actions** (last
  right-aligned). `thead` is the `--el-text-secondary` uppercase caption with a
  `--el-border` rule; rows hairline-separated (`--el-border-soft`).
  - **Label** — `text-sm font-medium`.
  - **Token** — the `tokenPrefix` in an inline **code chip** (`font-mono text-xs`
    on `--el-code-bg`/`--el-code-text`, `rounded-(--radius-control)`):
    `motir_pat_AbC1…` (the full secret is never in the list).
  - **Created / Last used** — short/relative dates in `--el-text-secondary`;
    last-used falls back to a muted "Never".
  - **Expires** — short date; within ~7 days a **`Pill severity="warning"`**
    (peach, `--el-text-strong`, AA — finding #35); never-expiring reads "Never".
  - **Actions** — a square icon `Button` (ghost, `trash-2`, hover →
    `--el-danger`) with `aria-label` "Revoke token {label}", opening panel 6.
  - **⚠️ There is NO revoked row (MOTIR-3546).** **Revoking DELETES the token**,
    so the table holds live credentials only and every row keeps its revoke
    control. This replaces the original spec — a muted row carrying a
    `Pill tone="neutral"` "Revoked" _instead of_ the revoke button, sorted below
    the live tokens, kept "for audit". There was no audit reader: nothing read
    `revokedAt` but `verify` and this table, so dead rows accumulated for the
    life of an account on the surface whose job is to answer _which of my
    credentials are live_ — and because the pill took the Actions cell, the one
    row a reader wanted gone was the one row with no way to remove it. The
    mirror this surface is drawn against already works this way: Atlassian
    (named above) _"permanently remove[s] it from your account"_ on revoke. An
    **expired** token is a different thing and is still listed, with its muted
    date and a working revoke button.

The list is a **client island** (`'use client'`): create / revoke are optimistic
in-place mutations (the page-state-after-mutation contract — the island owns its
state via `useState(initialTokens)`, doing its own optimistic insert on create
and REMOVING the row on revoke, NOT a `router.refresh()` it can't see). The page server-reads the
initial list via `apiTokensService.listForUser`.

## Panel 4 — Create modal

A `Modal` (`size="md"`, `title="Create API token"`, description "The token will
be shown once…"): a label `Input` (`helperText` "A name to recognise this token
by…", autofocus) + an expiry `Combobox` ("Expires" — 30 / 90 / 365 days / Never,
default **90 days**). Footer: ghost **Cancel** + primary **Create token**
(disabled until a non-empty label; `loading` while the POST is in flight).

## Panel 5 — Shown-once state

The SAME modal post-create (the create POST returns the plaintext exactly once —
7.8.1): title → **"Token created"**; a read-only, full-width **monospace secret
field** (`--el-surface` fill to read read-only) holding the full `motir_pat_…`
secret + a secondary **Copy** `Button` (`copy` glyph); a **peach-tint warning
callout** (`--el-tint-peach`, `--el-text-strong`, AA; `triangle-alert` in
`--el-warning`) — "This is the only time you'll see this token…"; footer a single
primary **Done**.

### ⚠️ The secret field is specified by LEGIBILITY, not by fit (MOTIR-3545)

**A PAT is always 53 characters** — `motir_pat_` plus `base64url(32 bytes)` = 43
(`lib/apiTokens/token.ts`). It is shown here and nowhere else, ever, so **this
field may not truncate, clip or scroll**: an ellipsis or an off-screen remainder
is a secret the reader cannot copy by eye and has no way to know is incomplete.
Two things carry that, and neither substitutes for the other:

- **The panel is `modal-wide` (42rem), not the 28rem default** — the same width
  the create phase already uses, so the modal does not resize under the reader
  between Create and the reveal. At 42rem the field gets ~471px against the
  ~360px 53 monospace characters need, and the secret lands on one line.
- **The field WRAPS at any character** (`word-break: break-all`, no fixed
  height). The panel is `w-[90vw]` UNDER its `max-w`, so a narrow viewport
  shrinks the field whatever the cap says — width alone cannot carry this. And
  base64url's only natural break opportunity is a `-`, which occurs in roughly
  half of all secrets: without a break rule such a token wraps AFTER the hyphen
  and clips the over-long run before it, rendering as a neatly wrapped complete
  token that is missing characters. That shape is the defect, not a milder
  version of it.

**The token drawn in the panel is real-shape** — 53 characters, carrying a `-`.
The earlier revision drew a 42-character placeholder inside a `nowrap` +
`text-overflow: ellipsis` field, which is precisely why 28rem read as
sufficient: **a placeholder shorter than the real value cannot specify a field
whose whole job is to hold the real value.** Any future revision of this panel
keeps a real-shape secret in it.

## Panel 6 — Revoke confirm

A destructive `Modal` (`size="sm"`, `title='Revoke "{label}"?'`): a **rose-tint
danger callout** (`--el-tint-rose`, `--el-text-strong`; `triangle-alert` in
`--el-danger`) — "Any agent using this token loses access… can't be undone."
Footer: ghost **Cancel** + **`Button variant="danger"`** "Revoke token"
(`trash-2`). On confirm the row is REMOVED from the table optimistically
(MOTIR-3546) — which is what makes this modal's own "can't be undone" literally
true rather than nearly true.

## Panel 7 — Empty state

The shipped **`EmptyState`** (Card + icon + title + description + action): lucide
**`key-round`** (48px, `--el-text-muted`) via the `icon` prop; title **"No API
tokens yet"**; description explaining what tokens do + a link to the **MCP setup
guide** (`docs/mcp.md`, the 7.8.8 doc); a primary **"Create token"** action.

## Panel 8 — Copy-confirmation toast

The shipped **`Toast`** (`variant="success"`, `--el-success` border +
`CheckCircle2`): title **"Token copied"**, body "Paste it into your agent's MCP
config now — it won't be shown again." Fired from the shown-once Copy handler.

## i18n

- **new `settings.account` namespace** — `eyebrow` ("Account settings"),
  `back` ("Back to Motir"), `nav.group.{general,preferences,security}`,
  `nav.{profile,language,notifications,appearance,apiTokens}`, `nav.soon`
  ("Soon").
- **`settings.language`** — `heading` ("Language & region"), `subtitle`,
  `card.title`, `card.subtitle`, `displayLanguage.{label,desc}`. (The Combobox
  options reuse the existing locale labels.)
- **`settings.apiTokens`** — `heading`, `subtitle`, `card.{title,subtitle}`,
  `create` ("Create token"), `columns.{label,token,created,expires,lastUsed,
actions}`, `expiresIn` ("in {n} days"), `expiresNever`, `lastUsedNever`,
  `revokeAria`, `create.{title,description,labelField,labelHelper,
expiresField,expiresHelper,submit,cancel}`, `expiry.{d30,d90,d365,never}`,
  `created.{title,description,secretLabel,copy,warning,done}`,
  `revokeConfirm.{title,body,confirm,cancel}`, `empty.{title,body,guideLink}`,
  `toast.{title,body}`.
- Notifications keeps its shipped `settings` keys (5.7.6). Same locale set.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the accent on the active nav
  row glyph; the CTAs + on-Switch track; the `--el-tint-peach` expiring chip +
  warning callout; the `--el-tint-rose` revoke callout; `--el-danger` revoke;
  `--el-success` toast; `--el-code-bg` token chips; the `--el-tint-yellow` "Soon"
  chips. No Tier-0 `--color-*` / Tailwind Tier-0 utilities. Tints carry the hue
  in the BACKGROUND with `--el-text-strong` text (finding #35, AA — verified
  light **and** dark).
- **Shape** via element-semantic tokens only (`--radius-card` / `-input` / `-btn`
  / `-badge` / `-control` / `-modal`, `--shadow-subtle` / `-card` / `-modal` /
  `-elevated`, `--spacing-card-padding` / `-control-*` / `-input-*` / `-chip-*` /
  `-icon-btn`, `--height-control` / `-input` / `-btn-*`) — no Tier-0 scale, no raw
  `rounded-md` / `p-1` / `h-9`. `rounded-full` only on the avatar / switch track.
- **Not colour-alone** (finding #35): the expiring chip carries text;
  callouts pair tint + icon + copy; the revoke button is icon + `aria-label`; the
  "Soon" nav rows carry a text chip, not just muting.
- **A11y**: the rail nav is grouped `SidebarSection`s; switches = `role="switch"`
  - `aria-label`; the create / shown-once / revoke surfaces are `Modal` (Radix
    focus trap, ESC, labelled); the secret field is read-only and the ONLY place
    the plaintext appears (never logged / in a DTO — 7.8.1); the toast is
    `role="status"`.
- **Dark mode** confirmed (toggle in the mock): every surface / text / tint /
  chip flips via the token layer and stays AA.

## Primitives composed (no hand-rolling)

| Element                      | Shipped primitive                                                        |
| ---------------------------- | ------------------------------------------------------------------------ |
| area shell (rail + content)  | `app/(authed)` rail + `SidebarNav` (the 6.5 settings-area shape)         |
| grouped nav registry         | `lib/settings/accountSettingsNav` (new — mirrors `projectSettingsNav`)   |
| card / empty                 | `components/ui/Card.tsx` · `components/ui/EmptyState.tsx`                |
| notification toggles         | `components/ui/Switch.tsx`                                               |
| language / expiry select     | `components/ui/Combobox.tsx`                                             |
| create / revoke / shown-once | `components/ui/Modal.tsx` (Radix Dialog)                                 |
| label field                  | `components/ui/Input.tsx` + `components/ui/FormField.tsx`                |
| chips                        | `components/ui/Pill.tsx` (`severity="warning"` / `tone="neutral"`)       |
| buttons                      | `components/ui/Button.tsx` (primary / secondary / ghost / danger / icon) |
| token-prefix chip            | inline `--el-code-bg` / `--el-code-text` code grammar                    |
| copy confirmation            | `components/ui/Toast.tsx` (`useToast`, `variant="success"`)              |

No new design-system primitive is invented for this surface. If a future need
arises that a shipped primitive can't cover, that is a NEW `design/` subtask, not
a code workaround.

---

# Token PERMISSION selection — `token-scopes.mock.html` (MOTIR-2578)

> **⚠️ THIS SECTION SUPERSEDES the 7.7.18 one below it**, which designed a picker
> over the six retired `TokenScope` values. Story MOTIR-2572 replaced those with
> the MOTIR-2254 permission catalog (`docs/decisions/token-permissions.md`), so the
> vocabulary the picker grants CHANGED. The old section is kept, unedited, as the
> record of what the shipped component was built to — read it to understand the
> code you are replacing, never as the target.

**Rendered before drawing** (the design-against-shipped-reality gate): the asset
was rendered with `scripts/render-token-scopes.mjs` (chromium, light, ×2, 1200px)
and the measurements below are that render's, not estimates. The composition was
amended against those pixels. The shipped `CreateTokenModal.tsx` cites this asset
as its source, and its markup was read alongside — the copy here is now the
SHIPPED `permissions.*` i18n strings, so the mock and the component resolve the
same words.

## ⚠️ THE COUNT — six rows, five groups. Measured, and it changes the answer.

**`GRANTABLE_PERMISSIONS` is SIX keys across FIVE domains**, derived from the
operation maps (`lib/tokens/grant.ts`): a permission is grantable because some
token-reachable operation asserts it.

| Domain (group label) | Permission key     | Label (shipped)   | Default                      |
| -------------------- | ------------------ | ----------------- | ---------------------------- |
| Project              | `project:browse`   | View project      | **on**                       |
| Work items           | `work_item:edit`   | Edit work items   | **on**                       |
| Work items           | `work_item:delete` | Delete work items | **off** — the one danger row |
| Comments             | `comment:add`      | Add comments      | **on**                       |
| Sprints & backlog    | `sprint:manage`    | Manage sprints    | **on**                       |
| AI planning          | `ai:plan`          | Run AI planning   | **on**                       |

Six of the catalog's 31 keys. The other 25 govern UI-administration surfaces no
API caller can reach; offering one would be a switch that gates nothing — the
lie `lib/permissions/catalog.ts` opens by forbidding.

**MOTIR-2578's brief assumed "twenty-plus rows across sixteen domains" and asked
which of a scrolling list / collapsing sections / a rail-and-pane / presets should
replace the two-column grid. At six rows the honest answer is NONE OF THEM.** Six
is the same row count the six retired scopes had. Adding a collapse to a panel
that does not need one, or presets over six switches, would be complexity bought
with nothing. **Rejected, with the reason: not enough rows.**

## THE MEASUREMENT — the number, not an adjective

Modal panel heights, natural (unclipped), from the render script:

| Panel | Shape                                                                                                                                | Height    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 1     | resting, single-org account + the optional Project picker                                                                            | **836px** |
| 1b    | **tallest reachable**: ≥2 orgs + ≥2 workspaces (discloses the Organization Combobox) + the Project picker + every permission granted | **938px** |
| 1c    | a viewer's capped offer — two grantable rows, four locked                                                                            | 646px     |

Against the shipped `max-h-[90vh]` ceiling:

| Viewport             | Ceiling | 938px verdict                |
| -------------------- | ------- | ---------------------------- |
| 720px (short window) | 648px   | scrolls                      |
| 800px (13" laptop)   | 720px   | scrolls                      |
| 900px (15" laptop)   | 810px   | scrolls                      |
| 1080px               | 972px   | **fits, with 34px to spare** |

⚠️ **The Project picker cost 102px, not 34.** It is a third field in a
`1fr 1fr` metadata grid, so it does not slot in beside Workspace — it WRAPS the
grid onto a second row. Worth knowing before anyone adds a fourth field: the
next one is free, the one after that costs another row.

**Decision: the body SCROLLS at the tallest shape, and that is the shipped
contract working, not a failure.** MOTIR-2488 already moved the fields into
`Modal.Body` with the footer PINNED beside it, precisely so a tall form scrolls
its body while Cancel / Create token stay reachable. The pre-change modal was
718px resting and already over the 13" ceiling at the two-org shape, so scrolling
is not a regression the new vocabulary introduces. What the vocabulary itself
costs is 16px (five domain groups carry one more label than the old four); the
Project picker costs the other 102px, and that is a binding-axis decision
(MOTIR-2605), not a picker one.

**What the code card must therefore check** (MOTIR-2580): at the ≥2-org /
≥2-workspace shape, with every permission on, BOTH footer buttons are visible and
reachable and the scroll is inside `Modal.Body`. That is the shape the
single-tenant fixture never renders — and the one the clipped-footer bug appeared
on.

## ⚠️ THE OFFER IS PER-ACTOR — and the token may bind to a PROJECT (Yue, 2026-08-10)

**This amends the section above, and overturns story MOTIR-2572's own scope
boundary** (_"a token is still BOUND to one workspace and the binding picker is
untouched"_). Recorded, not implied. The decision is MOTIR-2605's ADR section;
this is what it means for the pixels.

**What was wrong with the first pass.** The picker offered the same six rows to
everyone, and `apiTokensService.create` validates only against the STATIC
grantable set. So a viewer could tick _Delete work items_, mint the token, and
hold a grant they cannot exercise anywhere — the switch-that-gates-nothing lie,
one level up, on a screen that promises _"You can grant less than your own
access, never more."_

**Why it needed a decision and not a filter.** Permissions resolve **per
project** (`lib/permissions/resolve.ts`: `accessLevel` + `workspaceRole` +
`projectRole` + custom role) while a token binds to a **workspace**. There is no
single "the user's role" — an admin in project A can be a viewer in project B of
the same workspace.

**The decision: the project binding is REQUIRED where the GRANT IS CHOSEN, and
absent where it is fixed.**

| Credential                           | Grant                                             | Binding                           |
| ------------------------------------ | ------------------------------------------------- | --------------------------------- |
| Hand-minted (the create-token modal) | **chosen** from that project's set for that actor | **project** — required            |
| Device (`motir login` → `/device`)   | **fixed** `CLI_TOKEN_GRANT`, unconfigurable       | **workspace** — `project_id` NULL |

The incoherence was never the binding; it was the PICKER. A chosen grant on a
workspace-bound token asks _"may this token edit work items?"_ with no project to
answer for — permissions resolve per project, so the switch means nothing until
one is named. A FIXED grant asks nothing: `motir login`'s screen shows
`CLI_TOKEN_GRANT` and cannot edit it, so `grant ∩ role` resolves per project at
dispatch and there is no question on screen to be wrong.

`api_token.project_id` is therefore **nullable, and NULL is a MEANING** — the
device-credential shape — not a tolerance. Write it that way in the schema: a
column documented as "optional" becomes `NOT NULL` in six months with no correct
backfill; one documented as a shape does not.

**Two things this rules OUT, because earlier revisions of this note said
otherwise:** `list_projects` is NOT retired (it serves the device credential, and
`motir link` / `autoLinkAfterLogin` call it to bind a folder), and there is no
`NOT NULL` migration and no token cutover.

### What the picker draws

- **The Project picker sits beside Workspace**, labelled _The token acts in this
  project only_ — REQUIRED, because this modal is where the grant is chosen.
  Panels 1 and 1b.
- **A row the actor cannot confer is DISABLED with its reason** (`.scope-row.locked`
  - `.locked-why`), never hidden. A vanished row reads as a missing feature and
    sends someone hunting; a disabled one teaches the composition rule the helper
    text already states. At six rows this is never a wall — which is the second
    time the row COUNT decides the design.
- **The danger row stays rose even when locked.** The row a viewer most needs to
  understand they cannot grant is the destructive one.
- **Faint ink is correct here and only here.** `.scope-row.locked` uses
  `--el-text-faint`, which 1.4.3 exempts for disabled controls, and the REASON
  beside it carries the meaning at `--el-text-secondary`. This is the one place
  in the asset where faint on informational-looking text is right, and it is
  right because the control is disabled.
- **The offer RECOMPUTES when the Project picker changes.** A different project
  is a different set. Panel 1c pins this for MOTIR-2580.
- **A workspace owner sees no locked rows at all** — `resolvePermissions` layer 2
  hands them the whole role-gated catalog in every project. So this panel never
  appears for most people who mint tokens, and everything for members and
  viewers. Say it out loud, or the next reader will think the filtering is dead
  code.

### GIVES / TAKES for the binding

- **TAKES from [MOTIR-2605]** the required-where-chosen rule and the refusal shape.
- **GIVES to [MOTIR-2606]** the requirement that ONE service read feeds both the
  offer and `create`'s validation — two implementations would agree the day they
  are written and drift the first time an access level changed.
- **GIVES to [MOTIR-2580]** the recompute-on-project-change and the locked-row
  treatment.

## What CHANGED from the 7.7.18 design, and what did not

**Unchanged** — the wide (~42rem) modal, the two-column grid, `Switch` rows of
`icon + name + description`, the rose `.scope-danger` block for the irreversible
key, the list's summary Pill + persistent "Can delete" chip, the chevron
disclosure, and the binding-scope picker.

**Changed:**

1. **Grouping is the catalog's DOMAINS**, not invented buckets — `Project`,
   `Work items`, `Comments`, `Sprints & backlog`, `AI planning`, read from
   `permissions.domain.*`. Column split is 3 rows / 3 rows so neither column
   drives the height alone.
2. **Copy is the SHIPPED `permissions.<slug>.label` / `.description`** — the same
   strings the Roles & permissions screen renders. This asset authors NO copy for
   the rows, which is the point: one capability, one sentence, everywhere.
3. **The archive row is GONE.** `work_items:archive` and `work_items:delete` were
   two scopes and two rows; `archiveWorkItem` / `unarchiveWorkItem` /
   `deleteWorkItem` all assert `work_item:delete`. Two rows over one key would be
   two switches that cannot move independently. **One row**, and the caption names
   both acts — otherwise someone flips it expecting only the recoverable half.
4. **The default grant therefore no longer includes archiving.** "All but the
   irreversible one" now withholds archive too. Drawn: the danger row is the only
   one off in Panel 1.
5. **AI planning is its own row.** It used to ride inside _edit work items_, which
   meant a token wired to file issues could also spend the workspace's AI credits.
6. **No raw `resource:action` key is drawn anywhere.** An earlier revision of this
   asset put the key under each row so a 403 naming `work_item:edit` could be
   traced to its switch. **Removed** — MOTIR-2579's acceptance criteria forbid
   displaying a raw key to a reader, and a design that contradicts a sibling
   card's AC is a design that will not be built. The label is the surface; the
   shared presenter is what maps a key to it. (It also cost 63px of height.)
7. **"Create API token" → "Create token"**, and the pane is **Tokens** at
   `/settings/account/tokens` (MOTIR-2532's shipped copy).

## The panels

1. **Create token, resting** — single-org shape, default grant applied, with the
   optional Project picker. 836px.
   1b. **Dense / tallest** — ≥2 orgs, ≥2 workspaces, the Project picker, every
   permission on. **938px.** The panel the height decision is made against.
   1c. **A viewer's capped offer** — the same modal for someone holding only
   `project:browse` and `comment:add` in the bound project: four rows DISABLED
   with their reason. See § THE OFFER IS PER-ACTOR.
2. **The Work items group, Delete ON** — the danger close-up. Rose
   `--el-tint-rose` block, `· Danger` tag, trash icon, and the cascade caption
   that now names archiving too.
3. **Empty / invalid** — nothing granted; inline `.scope-error` + disabled CTA.
   The refusal is the SURFACE's: the service accepts an empty grant and mints a
   do-nothing token, so nothing below the UI would stop you.
4. **Token list** — the columns are now **Permissions** and **Acts in**. The
   second is what makes the two credential shapes legible side by side: a
   hand-minted token names its PROJECT, the `motir login` credential names its
   WORKSPACE and adds _"Every project your roles reach"_. Without that line the
   column reads as an inconsistency rather than two kinds of credential — and
   every pre-change token is the workspace shape, so a legacy row reads
   correctly too. Summary Pill (Full access /
   Standard / Read only / Custom) and the "Can delete" chip are **kept, not
   re-decided**: at six keys a cell could nearly list them, but a cell that grows
   with the catalog breaks the day the catalog grows, and the four words read
   correctly over the new set.
5. **A row expanded** — the granted permissions as chips, by shipped label.
6. **`/device` approval** — the CLI's FIXED grant, four permissions
   (`project:browse`, `work_item:edit`, `comment:add`, `ai:plan`). Names only,
   one-screen fit preserved. **What it CANNOT do is drawn**, because the two
   withheld keys (delete/archive, sprints) are exactly what someone approving a
   remote machine needs to know, and an omission is invisible unless stated.
7. **THE ACCESS PATH** — avatar menu → Settings → the Account rail →
   **Tokens** → the **Create token** button in the "Your tokens" card header,
   ringed with `--el-accent-on-surface`. There is no other route to the picker.

## Colour + contrast

Every colour is an `--el-*` token; every radius/spacing a shape token. Fixed in
this pass, because the AC asks for it and the AST ink guard cannot see CSS:

- `.scope-grp-label`, `.grp-label`, `.settings-eyebrow`, `.ttable thead th` moved
  `--el-text-faint` → `--el-text-secondary`. Faint measures **2.61** on the white
  modal and these are all INFORMATIONAL text (a domain heading, a nav section, an
  area eyebrow, a column heading), not decoration. Faint survives only on
  `.panel-label` (asset chrome, not product UI) and `.nav-row.soon` (disabled /
  inactive, which 1.4.3 exempts). The third site, `.ttable tr.revoked`, went with
  the revoked row itself (MOTIR-3546).
- `.scope-desc` stays `--el-text-muted` — **4.54 on the white modal panel**, which
  is where it renders. Inside `.scope-danger` it is already overridden to
  `--el-text-strong` on the rose tint.
- `.sw.on .kn` was a raw `#fff`; now `--el-text-inverted`, so the knob flips with
  the theme.

## GIVES / TAKES

- **GIVES to [MOTIR-2579]** — the group order, the summary vocabulary, the danger
  treatment, and the rule that no raw key is rendered.
- **GIVES to [MOTIR-2580]** — the composition, the default grant, and the 938px /
  ≥2-org footer-reachability check.
- **GIVES to [MOTIR-2586]** — the access path to walk, and the empty-grant refusal
  to assert.
- **TAKES from [MOTIR-2573]** the grantable set and which key is irreversible;
  **TAKES from [MOTIR-2532]** the "Tokens" label and the `/settings/account/tokens`
  address.

---

# The permission picker's two COLUMNS — the RULE, not the row count — `permission-columns.mock.html` (MOTIR-3580)

> **⚠️ THIS SECTION AMENDS the MOTIR-2578 section above on ONE axis — how the picker
> allocates its two columns — and on nothing else.** That asset stays exactly as it
> is: it is the record of the six-key moment it was drawn at, its measurements
> (836px resting / 938px tallest) were taken then, and a design asset is a record
> of its moment rather than a spec that tracks the product. What is superseded is
> its _"Column split is 3 rows / 3 rows"_ line, and only because that line states a
> COUNT where the design's durable content is a RULE.

## The disposition — DRAW THE RULE, not the count

MOTIR-3580 offered two ways out and this asset takes the second:

- **RE-MEASURE** — refresh the drawing at the current cardinality and accept that
  the next growth files the card again.
- **DRAW THE RULE** — state the _balance rule_ and show a representative set rather
  than a pinned one. ✅ **Chosen.**

**The evidence for choosing it is the card's own history, and it is unusually
clean.** `GRANTABLE_PERMISSIONS` (`lib/tokens/grant.ts`) is DERIVED — a permission
is grantable because some token-reachable operation asserts it — so the set grows
whenever a permission is minted, on a schedule nothing about this surface controls.
It has grown **seven** times since the picker was drawn. Each growth was recorded,
one at a time, as a new pair of literal row counts and a renewed note in
`tests/settings/permissionMeta.test.tsx`, and each renewal said the re-measure
belonged to a design card. None filed one. **Panel 3 of the mock derives all seven
of those pairs from a single rule.** Seven perishable measurements and one durable
statement, describing the same layout: that asymmetry is the argument, and it is
drawn rather than asserted.

**So the numbers in this asset are dated instances, and say so on the drawing.**
The row counts, the pixel heights and the group sizes are all labelled _as at
2026-09-03_. Nothing downstream may read them as a specification.

## The rule

`permissionColumnsForTokens` (`app/(authed)/settings/account/_components/permissionMeta.tsx`)
implements exactly this, and the mock's Panel 1 draws it:

1. **The unit is a DOMAIN GROUP, never a row.** A heading and its permissions move
   together; a group is never broken across the columns. A domain heading with its
   rows stranded in the other column is worse than any amount of imbalance.
2. **The cut is the FIRST boundary at which the left column holds at least half the
   rows.** Groups are taken in catalog order and the group that crosses half stays
   on the left. Two consequences worth stating because they are what make the rule
   checkable: the left column is never the shorter one, and dropping its last group
   would put it under half.
3. **Balance is what the rule BUYS, not a constraint it is held to.** The imbalance
   is whatever the group sizes allow. Neither column is padded, no group is split to
   even them up, and the modal's height is set by the taller column — the left one.

### ⚠️ It is GREEDY, not minimal-imbalance — and the difference is real

The rule takes the first boundary past half, which is not always the boundary with
the smallest imbalance. At group sizes `5 · 5 · 1` it cuts **10 / 1** where the best
non-breaking boundary is **5 / 6**. The two coincide at every cardinality the set has
actually had, which is why the gap has never been visible on screen.

**This corrects a claim made in the test file itself.** MOTIR-3629 replaced an
`Math.abs(left - right) <= 1` assertion — correctly, it had stopped being reachable —
with an assertion that the split takes _"the one with the SMALLEST imbalance"_, and
described that as _"the rule the splitter actually implements"_. It is not: it is a
second coincidence that holds today, which is exactly the thing the first assertion
was retired for being. The rule drawn here is what the code does. If a future catalog
makes the greedy cut lopsided, that is a design decision to take **then, on this
asset** — not a silent difference between a drawing and a component.

### The seven cardinalities, derived rather than quoted

Domains in catalog order: `project · work_item · comment · sprint · ai`.

| Card       | When       | What grew             | Group sizes         | Rows | Split (derived) |
| ---------- | ---------- | --------------------- | ------------------- | ---- | --------------- |
| MOTIR-2578 | measured   | the asset's moment    | `1 · 2 · 1 · 1 · 1` | 6    | **3 / 3**       |
| MOTIR-2988 | 2026-08-18 | + `ai:view_plan`      | `1 · 2 · 1 · 1 · 2` | 7    | **4 / 3**       |
| MOTIR-3188 | 2026-08-20 | + `ai:decide_plan`    | `1 · 2 · 1 · 1 · 3` | 8    | **4 / 4**       |
| MOTIR-3361 | 2026-08-25 | + `lesson:manage`     | `2 · 2 · 1 · 1 · 3` | 9    | **5 / 4**       |
| MOTIR-3480 | 2026-08-25 | + `lesson:view`       | `3 · 2 · 1 · 1 · 3` | 10   | **5 / 5**       |
| MOTIR-3553 | 2026-08-26 | + `lesson:reinforce`  | `4 · 2 · 1 · 1 · 3` | 11   | **6 / 5**       |
| MOTIR-3629 | 2026-08-27 | + `work_item:archive` | `4 · 3 · 1 · 1 · 3` | 12   | **7 / 5**       |

Every split in the right-hand column is COMPUTED by the rule from the group sizes
beside it. None is quoted from the test file's comment chain — that is the point of
the table, and it is what the mock's Panel 3 renders.

## THE MEASUREMENT — the number, not an adjective (as at 2026-09-03)

Measured in the mock's own render (chromium, light, 1200px, `getBoundingClientRect`),
with the picker inside the shipped modal geometry (`max-w-[42rem]`,
`p-(--spacing-card-padding)`):

|                             |                                                          |
| --------------------------- | -------------------------------------------------------- |
| Modal content width         | **672px** (42rem, the shipped `className` override)      |
| Picker grid                 | **590px**                                                |
| Left column · 7 rows        | **590px**                                                |
| Right column · 5 rows       | **473px**                                                |
| Residual imbalance          | **117px**                                                |
| Per-row height, left column | **66–91px** (the one-line description wraps at two rows) |

**⚠️ A row is not a fixed height, so the rule balances a PROXY.** Balancing row COUNT
is an approximation of balancing HEIGHT, and it is the right one: balancing measured
pixels would re-cut the columns whenever a translated description changed length,
which is a layout that moves for reasons a reader cannot see. The 117px residual is
the price of the proxy, and it is drawn so the next reader argues with a number
instead of an adjective.

**Not re-measured here, deliberately:** the modal's own total height. MOTIR-2578's
836px / 938px are measurements of a modal whose other fields this card does not
touch, and re-taking them would be re-cutting a frozen asset to chase a number. What
this asset owns is the column allocation.

## Grounded in shipped reality — the picker in Panel 2 is the app's own output

Panels 2 and 2b are **not a redraw**. The markup is `CreateTokenModal`'s rendered
output, lifted verbatim, with the compiled Tailwind stylesheet inlined — so every
class, every string and both column contents are the shipped ones and the asset
cannot drift from the running UI by being retyped.

Reproduced inline rather than cited, because the harness is a throwaway that does not
survive the commit:

```js
// 1. Dump the real component's markup through the repo's own vitest + RTL setup —
//    `tests/helpers/renderWithIntl.tsx` gives real `messages/en.json` with real ICU
//    plurals, and every path alias just works.
//      renderWithIntl(<ToastProvider><CreateTokenModal open … /></ToastProvider>)
//      writeFileSync('modal.html', document.body.innerHTML)
//    Run under a throwaway config: { environment: 'happy-dom', esbuild: { jsx: 'automatic' },
//    resolve.alias: { '@': <root>, 'server-only': 'tests/stubs/server-only.ts' } }.
//
// 2. Compile the CSS scoped to THAT markup, not to the repo:
//      @import 'tailwindcss' source(none);
//      @source './page.html';
//      @import '@motir/design-system/theme.css';
//    through `@tailwindcss/postcss` (its CJS entry needs `mod.default ?? mod`).
//
// 3. Lift the token layers UNLAYERED into a leading <style>, by brace-counting the
//    compiler's own output — never retyped. Two blocks need it, for two different
//    reasons, and both are invisible in a browser:
//      • Tailwind emits Tier-0 inside `@layer theme`, which a cascade-layer-blind
//        engine (happy-dom — three design guards run on it) drops entirely.
//      • `packages/design-system/theme.css` declares the Tier-3
//        `:root, [data-appearance-scope]` block BELOW its first `@scope` at-rule,
//        where happy-dom's parser has already stopped.
//    Three details, each of which produced a silently HALF-styled mock:
//      • Brace-count over the COMMENT-STRIPPED source. theme.css's prose quotes
//        selectors, so literal `{ … }` pairs inside comments mis-balance a raw
//        counter and it swallows the `@scope` at-rule that follows.
//      • Emit the Tier-3 block TWICE — once on its own selector and once as a
//        SEPARATE `[data-theme] { … }` rule, before the `[data-theme='dark']` one, so
//        the nested dark scope recomputes `--el-*` against its own Tier-0 flip. The
//        combined `:root, [data-appearance-scope], [data-theme]` form resolves in
//        Chromium and yields NOTHING in happy-dom.
//      • STRIP the nested `@supports` groups out of the lift. happy-dom discards the
//        declarations it parsed BEFORE a nested at-rule and keeps the ones after, so
//        `--el-page-bg` (first in the block) read unset while `--el-card` (5 KB later)
//        resolved — a half-applied palette, which is the shape that hides. Each
//        group's base declaration sits outside it, so the fallback survives, and
//        Chromium takes the full sheet below anyway.
//
// 4. `node scripts/render-design-mock.mjs design/settings/permission-columns.mock.html --width 1200`
//    AFTER `prettier --write` on the mock.
```

Verified by measurement rather than by looking (each of these produces a picture a
reviewer would accept): `--el-page-bg` resolves at `:root`, the Panel 2b scope
computes `--el-card: #0f0f0f` / `--el-text: #f3f4f6`, both frames measure 672px, and
the two columns carry 7 and 5 switches under the group headings the rule predicts.

## The panels

1. **The rule** — its three clauses, then the current set's group blocks with the
   running totals and the cut drawn at the boundary the rule picks.
2. **The picker at the current set (light)** — the shipped modal geometry at twelve
   rows, with the measurement strip beneath it.
   2b. **The same picker, dark** — token parity for the nested `[data-theme="dark"]`
   scope.
3. **The one rule reproduces every split the set has ever had** — the table above,
   plus one column-allocation strip per cardinality so the cut is visibly walking
   right and back as the groups grow.

**THE ACCESS PATH** is unchanged and is not redrawn here: avatar menu → Settings →
the Account rail → **Tokens** → the **Create token** button in the "Your tokens" card
header. It is DRAWN in `design/settings/token-scopes.mock.html` panel 7. This asset
amends how that surface allocates its columns; it does not re-specify the surface, so
redrawing its door would be a second copy to go stale.

## Colour + contrast

Every colour is an `--el-*` token and every radius a shape token. The picker markup
carries the shipped component's own classes untouched — including the two the
MOTIR-2578 pass corrected (`--el-text-secondary` on the domain heading, never
`--el-text-faint`; `--el-text-inverted` on the switch knob), which is a property this
asset inherits rather than re-decides, because the markup is the component's.

## What this CHANGES in the guard

`tests/settings/permissionMeta.test.tsx` asserted the split twice: three invariants
that state the rule, and two literals that pin a count. The literals were the tripwire
the renewal chain hung off — they went red on every growth, and the note explaining
why was renewed rather than discharged, five times.

**The literals are gone and the rule is asserted directly**: the columns are whole
domain groups in catalog order, the left column reaches at least half the rows,
removing its last group would drop it below half, and no group appears in both. That
is a strictly stronger statement than `7` and `5` — it holds at every cardinality, it
cannot be satisfied by a wrong split that happens to have the right sizes, and it
never needs touching again when a permission is minted. The renewed comment chain is
DELETED rather than extended; this section is where its content now lives, which is
where a design decision belongs.

## GIVES / TAKES

- **TAKES from MOTIR-2578** the two-column composition, the grouping-by-catalog-domain
  decision, the danger-row treatment and the access path. None of it is re-decided.
- **TAKES from `lib/permissions/catalog.ts`** the domain order and the contiguity of
  the `project` group, which is what makes "whole groups in catalog order" a layout
  rule rather than an accident.
- **GIVES to `tests/settings/permissionMeta.test.tsx`** the rule its assertions now
  state, and the licence to stop pinning a count.
- **GIVES to whoever mints the next permission** the thing the last five growths did
  not have: nothing to re-measure, and no note to renew.

---

# Token scope selection — `token-scopes.mock.html` (Story 7.7 · 7.7.18)

The reference the **7.7.19** code subtask builds against. It EXTENDS the
API-tokens surface designed in 7.7.2 (Panels 3–8 of `account-settings.mock.html`,
which cover list / create / shown-once / revoke / empty) by adding the one thing
that design lacked: **permission-scope selection**. Nothing else in the
create→shown-once→revoke flow changes. Built from the SAME token block + shipped
primitives as `account-settings.mock.html`, so 7.7.19 composes identical
primitives — no Pencil→code gap.

### ⚠️ Two senses of "scope" — do not conflate

- **Binding scope** (bug 7.21, already shipped in 7.7.2 / `CreateTokenModal`) —
  the **org → workspace** a token is bound to (the "Workspace" field, reading
  `Default` for a lone workspace). **Unchanged here.**
- **Permission scope** (THIS asset, the 7.7.16 scope list) — **what the token may
  DO**. New. Rendered as the create-modal "Permissions" picker + the list's
  "Scopes" column.

The 7.7.16 canonical scope list is the source of truth for the scope KEYS; this
asset owns their **plain-language labels/descriptions** (written for Yue's
non-developer acceptance — Principle #18 — never the raw `work_items:write`
string) and their **grouping + default state**.

## The 6 scopes — labels, copy, group, default, icon

The picker renders the 6 scopes (7.7.16) as grouped, plain-language **`Switch`**
toggles (`role="switch"`, accent track when on). Default state: **ALL on EXCEPT
delete.** Each row is `icon + name + one-line description` on the left, the
`Switch` on the right, hairline-separated within a group.

| Scope key (7.7.16)   | Group (column)                     | Label (plain)        | Description                                                                  | Default | lucide icon  |
| -------------------- | ---------------------------------- | -------------------- | ---------------------------------------------------------------------------- | ------- | ------------ |
| `read`               | Read (left)                        | Read everything      | View work items, boards, sprints, comments, and reports.                     | **on**  | `eye`        |
| `sprints:write`      | Sprints (left)                     | Manage sprints       | Create sprints and move work items in and out of them.                       | **on**  | `zap`        |
| `integration`        | Integrations (left)                | Connect integrations | Link external tools and post activity back to Motir.                         | **on**  | `plug`       |
| `work_items:write`   | Work items (right)                 | Edit work items      | Create and update work items, comments, links, and attachments.              | **on**  | `square-pen` |
| `work_items:archive` | Work items (right)                 | Archive work items   | Archive and restore work items. This can be undone.                          | **on**  | `archive`    |
| `work_items:delete`  | Work items (right, **danger row**) | Delete work items    | Permanently delete a work item and its entire subtree. This can't be undone. | **OFF** | `trash-2`    |

> The exact scope-key spelling above mirrors what 7.7.16 ships; if 7.7.16's final
> keys differ, 7.7.19 maps label→key by the **group + meaning**, not the literal
> string. The labels/descriptions/grouping/default here are the binding spec.

## Panel 1 — create modal with the Permissions picker (default)

### ⚠️ Width, not scroll (Yue, 2026-06-16) — show all scopes at once

A scrolled picker hides options: the user can't tell more scopes exist below the
fold. So the create modal **uses its width** instead. It **WIDENS** and lays the
fields out so all six scopes are visible without any scroll region:

- **The modal widens** from the 7.7.2 `size="md"` (28rem) to **~42rem**. 7.7.19
  applies a `max-w-[42rem]` className to the shipped `Modal` (or adds a size token
  if we want it reusable) — the size-variant rems are the swap-safe knob; a one-off
  `max-w-[…]` className is the same pattern the peek/lightbox modals already use.
- **Metadata pairs up:** Label is full-width; **Workspace + Expires sit side by
  side** in a 2-column row (`.meta-cols`) — using the width and saving a row.
- **The permission picker is a 2-COLUMN grid** (`.scope-cols`), capability groups
  split across the columns so the whole set fits:
  - **Left column:** **Read** (Read everything) · **Sprints** (Manage sprints) ·
    **Integrations** (Connect integrations).
  - **Right column:** **Work items** — Edit work items · Archive work items ·
    then the **Delete danger row**.
- Each **scope row** (`.scope-row`): a 16px lucide glyph in `--el-text-muted`, the
  name (`text-sm font-medium --el-text`), the one-line description (`text-xs
--el-text-muted`), and a `Switch` on the right. Hairline `--el-border-soft` between
  rows inside a group; `grp-label` captions (`--font-mono`, uppercase,
  `--el-text-secondary`) head each group.
- **Default render:** Read / Manage sprints / Connect integrations / Edit /
  Archive all **on** (accent track); **Delete off**.

No scroll, no hidden overflow — the whole capability set reads at a glance, and the
Cancel / Create footer sits directly below the grid. (If a future scope count grows
the grid beyond the 90vh cap, the shipped `Modal` still caps at `max-h-[90vh]` and a
`Modal.Body` wrapper would scroll as the fallback — but at six scopes the width
layout fits comfortably and is the intended shape.)

## The Delete danger row (distinct treatment, off by default)

`work_items:delete` is the LAST row of the **Work items** group (right column),
rendered as its **own rose danger row** (`.scope-danger`: `bg-(--el-tint-rose)`,
`border-(--el-border-soft)`, `rounded-(--radius-card)`), set apart from the safe
scopes so granting deletion is a **deliberate, visible act**:

- The scope name carries a small **"· Danger"** `tag` in **`--el-danger`**
  (`--font-mono`, uppercase) — colour-plus-text, never colour alone (finding #35).
- The scope glyph (`trash-2`) is `--el-danger`; the name is `--el-text-strong`;
  the "This can't be undone" caption is `--el-text-strong` (AA on the rose tint).
- The `Switch` is **OFF** by default. Flipping it on is shown in **Panel 2** — the
  rose row, tag, icon, and caption stay; only the track turns accent. (Confirmed AA
  in light AND dark — Panel 2 + the dark toggle on the wide modal.)

## Panel 2 — Work-items group with Delete turned ON (the deliberate grant)

A close-up of the right column's **Work items** group with the delete `Switch`
flipped **on**: Edit / Archive as plain rows above, then the rose danger row with
its accent track now on. Confirms the danger treatment in its granted state — the
distinct rose styling persists, so an on delete scope still reads as dangerous.

## Panel 3 — disabled / error state (every scope off)

A token must grant **at least one** permission. With every toggle off:

- An inline **`.scope-error`** ("Grant at least one permission to create a token.")
  in `--el-danger` with an `alert` glyph appears under the picker.
- The **"Create token" CTA is disabled** (the existing `disabled`/`loading` CTA
  grammar — 7.7.2 already disables it on an empty label; this adds the empty-scope
  condition). The binding `workspaceId` check from 7.7.2 is unchanged.

This is the only NEW validation state; create / shown-once / revoke / empty are
exactly 7.7.2.

## Panel 4 — token-list granted-scope display (the "Scopes" column)

The list (`ApiTokensManager`, Panel 3 of 7.7.2) gains a **Scopes** column between
**Token** and **Workspace** — compact, **no row bloat**:

- A single **summary `Pill`** classifies the grant, semantic not numeric (Yue
  reads meaning, not `5 of 6`):
  - **Full access** — all 6 (incl. delete) → `Pill` **mint** tone
    (`--el-tint-mint`, `--el-text-strong`).
  - **Standard** — the default set (all minus delete) → `Pill` **neutral**.
  - **Read only** — `read` alone → `Pill` **neutral**.
  - **Custom** — any other subset → `Pill` **neutral**.
- **`work_items:delete` is never hidden behind a summary.** Whenever delete is
  granted, a **persistent rose `Pill` "Can delete"** (`--el-tint-rose`,
  `--el-text-strong`, `trash-2` glyph) rides beside the summary — the dangerous
  capability is always visible at a glance, mirroring the create-modal's
  danger-zone emphasis.
- A **chevron `disclose` button** (`chevron-down`, `--radius-control`,
  `aria-expanded`) expands the row.
- **Every row gets the chevron.** The earlier carve-out — _revoked rows show the
  muted summary only_ — went with the revoked row itself (MOTIR-3546): revoking
  deletes the token, so there is no muted row left to except.

## Panel 5 — expanded scope detail

The chevron opens a **detail sub-row** (`.scope-detail` → a `td colspan`),
a `--el-surface-soft` card holding a "This token can:" lead + one **chip per
granted scope** (icon + plain label). The **Delete** chip reads as a rose
**`.scope-chip.danger`** (`--el-tint-rose`, `--el-text-strong`). Plain names
only — never the raw `work_items:*` keys. The chevron flips to point up
(`.disclose.open`).

## Token / a11y rules honoured (additions to the 7.7.2 list)

- **Colour** strictly via `--el-*`: the accent Switch track; `--el-tint-rose` +
  `--el-danger` for the delete danger row / "Can delete" chip; `--el-tint-mint`
  for the Full access pill; `--el-text-muted` scope glyphs; `--el-text-strong` on
  every tint (AA — finding #35, verified light + dark). No Tier-0 `--color-*`.
- **Shape** via element-semantic tokens only — `--radius-card` (danger row,
  detail card, summary `--radius-badge`), `--radius-control` (disclose button),
  `--spacing-chip-*` (chips), `--spacing-control-*`. No raw `rounded-md` / `p-1`.
- **Not colour-alone** (finding #35): the delete danger row pairs rose tint + the
  `trash-2` icon + the "can't be undone" copy + a "· Danger" text tag; the delete
  grant in the list carries the text chip "Can delete", not a bare colour; every
  scope toggle has a text label and `aria-label`.
- **A11y:** scope toggles are `role="switch"` + `aria-checked` + `aria-label`,
  wrapped in a `role="group"` labelled by the "Permissions" heading; the disclose
  control is a real `<button>` with `aria-expanded` + a descriptive `aria-label`
  ("Show scopes for {label}"); the empty-scope error is inline form text. The
  detail sub-row is plain table markup.
- **Dark mode** confirmed (toggle in the mock): the rose delete row, mint/rose
  pills, and accent switches all flip via the token layer and stay AA.

## Primitives composed (additions — no hand-rolling)

| Element                          | Shipped primitive                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| scope toggles                    | `components/ui/Switch.tsx` (`role="switch"`)                                                  |
| summary / "Can delete" / chips   | `components/ui/Pill.tsx` (mint / rose / neutral tones)                                        |
| Permissions section + danger row | `components/ui/Card.tsx` callout grammar + the `field` form row                               |
| 2-column scope grid              | layout-only CSS grid (`.scope-cols`) — gaps are layout, not shape                             |
| disclose / expand                | a ghost icon `button` (the existing `icon-btn` grammar) + `chevron`                           |
| modal / CTA / inputs             | unchanged from 7.7.2 (`Modal` / `Button` / `Input` / `Combobox`), the modal widened to ~42rem |

No new primitive is invented. The "Can delete" rose pill and mint "Full access"
pill are existing `Pill` tones; the delete danger row is the callout grammar
already used by the shown-once warning + revoke confirm. The 2-column grid is
layout-only (sibling gaps, not a control's own shape), so it stays raw per the
shape-token rule.

---

# Appearance pane — `appearance.mock.html` (Story 7.3 · 7.3.57 / MOTIR-1074)

**The meta concept made concrete.** Motir is built on a **three-axis design
system** — Colour (`data-palette`) · Type (`data-type`) · Shape/feel
(`data-style`), plus a light/dark base (`data-theme`) — that re-skins / re-types /
re-shapes the **whole** app at runtime from the `<html>` element. The Appearance
pane is **that system turned on itself**: it lets the signed-in user theme **the
Motir app itself**, and SHOWCASES the design ability by re-rendering live as they
choose. This is the account-settings face of the system the onboarding _design
wizard_ (7.3.27 / 7.3.44) introduced for the user's _own product_ — same axes,
same picker language, now pointed at Motir.

**This flips the reserved "Soon" slot to a real entry.** The pane lives at the
`appearance` slot in `lib/settings/accountSettingsNav.ts` (group `preferences`,
`Palette` icon) — 7.3.58 sets its `href`/removes `placeholder`. Until then the
rail shows it as "Soon" (the 7.8.2 state).

## What it reuses (no new vocabulary — the precondition checks)

- **The area shell** — rail + content + `Card` grammar — is **`account-settings.mock.html`**
  (7.8.2) verbatim: the back-link + user identity + grouped nav (General /
  Preferences / Security), the serif `h2` page-head, the hairline-separated cards.
- **The axis pickers** — the `.pick` **chip rows** — and the **showcase specimens**
  (the live card / type specimen / palette swatches) are the onboarding
  design-wizard's language (7.3.27 / 7.3.44 / 7.3.37,
  `design/ai-chat/onboarding.mock.html`), adapted to a settings-pane layout.
- **The three axis registries** drive the option sets, 1:1 with shipped code:
  **Style** `lib/theme/styles.ts` (6 styles: Warm Editorial, Soft / Playful,
  Swiss / Minimal-Flat, Neo-Brutalism, Glassmorphism, Cybercore / Y2K); **Palette**
  `lib/theme/palettes.ts` (5: Motir, Cobalt, Graphite, Evergreen, Spectrum);
  **Type** `lib/theme/typography.ts` (6: Motir, Motir Sans, Motir Mono, Grotesk,
  Editorial, Mono-Technical). **Theme** is the existing `ThemePattern` (Light /
  Dark / System; `THEME_STORAGE_KEYS`).
- **Authentic rendering.** The mock's `<style>` copies the `:root` tokens, the
  `[data-theme=dark]` block, and **every** `[data-style]` / `[data-palette]` /
  `[data-type]` axis block + the nested-palette specimen fix 1:1 from
  `app/globals.css` (via the onboarding mock), and loads the six real next/font
  faces — so each panel re-skins / re-shapes / re-types EXACTLY as the running app
  will. Component CSS references ONLY `--el-*` colour + element-semantic shape
  tokens (the colour + shape rules).

## Layout — the page IS the preview (no separate "live preview" widget)

**Key decision (Yue, 2026-06-19).** The three axes apply to **Motir itself**, and
they apply **instantly** (`localStorage` → `<html>`, the inline-edit-no-refresh
preference contract — like every theme toggle: Linear / GitHub / Notion all switch
immediately, the mirror-product standard). So the moment you pick, **the whole page
re-skins — this page included.** A separate "live preview" card would be redundant:
it would show "Motir in this selection" while you are already looking at exactly
that. The earlier v1 had such a preview rail; it was **removed**.

Instead the page is deliberately **design-rich** so that picking ANY axis visibly
transforms it — the Appearance page doubles as the **design-system showcase**
(which is the meta concept: showcase Motir's design ability on Motir itself). Single
column, two regions:

**1 — The controls** (one `Card`, "Theme & design"), four hairline-separated
`.axis-field`s (name + helper + control + a live registry `.axis-note`):

- **Theme** — a **segmented control** (`.segmented` / `.seg`): Light (`sun`) · Dark
  (`moon`) · System (`monitor`); active = `--el-page-bg` fill + `--shadow-subtle` +
  accent icon. (The shipped `ThemeToggle` pattern — the one new composition.)
  Picking Dark flips the **whole app chrome — the left rail included** (the rail is
  `--el-sidebar-bg`, which is `[data-theme=dark]`-driven), not just the content;
  Panel 3 shows the dark rail. This is the dogfood: Theme sits on `<html>`, so it
  themes everything.
- **Style** — a `.pick` **chip row** of the 6 styles; active = accent border +
  `--el-tint-lavender` fill + `--el-accent-on-surface` text + a `check`.
- **Palette** — chip row of the 5 palettes, each with an 11px **swatch dot** in the
  palette's accent hue.
- **Typography** — chip row of the 6 pairings, **each label set in its own headline
  face** (Source Serif 4 / Inter / JetBrains Mono / Space Grotesk / Fraunces / IBM
  Plex Mono) so the chips themselves preview the type. **Labelled "Typography", not
  "Type" (Yue, 2026-06-19):** `type` is the internal axis name (`data-type`,
  `typography.ts`, `TypeId`) and is correct designer jargon, but as a user-facing
  label next to Style / Palette it reads ambiguously to non-designers (= "kind"),
  so the UI says **Typography** (unambiguous, matches `typography.ts`). The
  `data-type` attribute / registry id stay `type`.

The card sub-copy + the page-head ("the whole app re-skins live… there's nothing to
save") state the instant-apply, no-Save model.

**2 — The showcase band** (`.showcase`, eyebrow "Your look — live across Motir") — a
real Motir slice that exercises EVERY axis, so each pick ripples visibly:

- a **work-item card** (`.sc-item`) — a `square-check` kind + `PROD-128` (mono), an
  **accent status `Pill`** ("In review"), a **serif/headline title** ("Rebuild the
  billing flow"), body copy (body face), a **label row of tinted `Pill`s**
  (`--el-tint-sky` / `-peach` / `-rose`, AA `--el-text-strong`), mono meta, and a
  **primary `Button`** ("Comment") + secondary ("Assign") + ghost icon-button;
- a **side stack** — a `Card` with a search `Input` + list rows (accent dots +
  muted bars), the **palette-role swatch strip**, and a **type specimen** ("Ag" +
  serif headline + body + mono meta).

So colour shows in the accent pill/button/dots + the tinted labels; shape shows in
the card/button/input/pill radii + elevation; type shows in the title, body, mono
meta and the "Ag" specimen — all token-driven, all re-rendering on every pick.

## The access path (mistake-#31 — DRAW the door)

Every panel draws the **account-settings rail** with **Appearance ACTIVE** under
**Preferences** (between Notifications and Security) — the "Soon" placeholder
flipped to the canvas-inset active treatment (`--el-sidebar-item-bg-active` +
`--el-sidebar-border` + `--shadow-subtle` + accent `palette` glyph). That IS the
entry affordance: how the user reaches the pane (Account settings → Preferences →
Appearance), drawn, not just named.

## Panels

- **Panel 1 — Default / factory.** Theme **System** · Style **Warm Editorial** ·
  Palette **Motir** · Type **Motir** — the base look. Shows the four controls, the
  showcase band, and the access path (rail Appearance active). The "empty/default"
  state.
- **Panel 2 — A changed state (light).** Theme **Light** · **Swiss / Minimal-Flat**
  · **Cobalt** · **Grotesk**. The **dogfooding moment**: because the choice applies
  to Motir _itself_, the WHOLE page — rail, cards, chips, buttons, pills AND the
  showcase — re-skins (cool Cobalt), re-shapes (flatter, sharper Swiss geometry) and
  re-types (Space Grotesk headlines) live. `data-style` / `data-palette` /
  `data-type` sit on the `.stage` (whole shell), exactly as they sit on `<html>`
  in-app.
- **Panel 3 — Dark + a changed state.** Theme **Dark** · **Soft / Playful** ·
  **Evergreen** · **Editorial**. Dark-mode parity across the whole area; rounded
  Soft/Playful geometry, an emerald Evergreen palette, Fraunces display headlines.
  Confirms light + dark both hold AA via the token layer.

## Token / a11y rules honoured

- **Colour** is `--el-*` only (text on tints → `--el-text-strong`; active chips put
  the accent in border + `--el-tint-lavender` background with
  `--el-accent-on-surface` text, AA in both themes — finding #35). No Tier-0
  `--color-*`, no page-level tint.
- **Shape** is element-semantic tokens only (`--radius-card` / `-btn` / `-input` /
  `-badge`, `--spacing-card-padding`, `--height-control` / `-input`,
  `--shadow-subtle`) — so a `data-style` swap actually reshapes the pane (visible
  across panels). The segmented active radius is `calc(--radius-btn - 2px)`; chip
  swatch dots are `rounded-full` (genuinely circular — allowed).
- **a11y** — the rail `nav` has `aria-label`; the active row carries
  `aria-current="page"`. The theme segmented is a `role="group"`; each axis chip
  row is a `role="radiogroup"` with an `aria-label`. Every icon-only `<svg use>`
  carries `viewBox="0 0 24 24"` (no clipping). The "Soon" → active flip is a real
  navigable row, not a disabled one.
- **Dark mode** confirmed (Panel 3): rail, cards, chips, segmented, the showcase
  card / pills / buttons / type specimen and swatches all flip via the token layer
  and stay AA.

## Primitives composed (no hand-rolling)

| Element                          | Source                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| area shell (rail + content)      | `account-settings.mock.html` (7.8.2) — `Card` / settings-row / nav grammar            |
| axis chips (`.pick`)             | the onboarding design-wizard chip language (7.3.44)                                   |
| showcase card / type / swatches  | the onboarding live specimens (`.vg-*` / `.type-spec` / `.pal-swatches`, 7.3.37)      |
| status / label pills             | `components/ui/Pill.tsx` (accent + tinted tones, AA `--el-text-strong`)               |
| buttons + search input           | `components/ui/Button.tsx` · the `Input` / `Combobox` trigger grammar                 |
| Theme segmented control          | a token-driven segmented toggle (the `ThemeToggle` pattern) — the one new composition |
| option sets (style/palette/type) | the shipped registries `lib/theme/{styles,palettes,typography}.ts`                    |

The only new composition is the **Theme segmented control**; everything else reuses
the area shell, the onboarding picker chips + specimens, and the shipped `Pill` /
`Button` / `Input` primitives. The axis options come straight from the registries,
so the pane never drifts from what the app can actually wear.

## Build dependency (for 7.3.58)

7.3.58 implements this pane + its `settings/account/appearance` route: a **client
island** (the selections live in `localStorage` via `THEME_STORAGE_KEYS` and are
applied to `<html>` by the existing theme bootstrap, so picking re-skins instantly
with no server write — no separate preview to wire), rendering the four pickers from
the registries + the showcase slice, and flipping the `accountSettingsNav`
`appearance` entry from a placeholder to a real route (which keeps the
route↔registry totality test green by construction). No new colour/shape primitive
is required.

---

# Appearance — Typography by language (MOTIR-7736)

**Design system (step 1).** Read `package.json` (depends on `@motir/design-system`
`workspace:*`) and `app/globals.css` (imports `@motir/design-system/theme.css`):
both hold, so this is **branch (a), on Motir Design**. The installed version is the
workspace package itself. The mock composes the shipped primitives' class strings
(`AxisField`, `AxisRadioGroup`, the `AppearanceCard` footer, `Card`) over the token block
`../auth/auth-frame--language-control.mock.html` carries, and copies theme.css's
**FONT SETS** section verbatim, so a page's `lang` and a picked member re-type the
mock exactly as they re-type the app. No part is missing from the package; the only
new thing is an option that previews its own face, which is the existing
`AxisRadioGroup` chip with a script sample beside the name.

**Amends** § _Appearance pane_ above (its panel list) and
`appearance.mock.html`, which is **not edited**. Asset:
**`appearance--fonts-by-language.mock.html`**, holding only the changed panels.
**Drawn from** `packages/design-system/src/theme/fontSets.ts` as of `f383bc6d3`
(`FONT_SET_REGISTRY`, `LOCALE_FONT_SET`, `FONT_SET_LOCALES`).

## Revision 3 — what the reviews changed

Revision 1 (published at `691a0bd`) listed all eleven languages at once.
Revision 2 added a separate _Font for ‹language›_ field below Typography,
for the page's language only. Yue sent both back. The second note reads:
_"There won't be Typography and Font for English, only Typography. Typography
is font. So, when English is chosen, the typography is Motir, Motir Sans ....
the list. When Chinese is chosen, it's a different list. When Japanese is
chosen, there's another list. The same for Korean."_

So there is **no new field**. The existing **Typography** axis is the font
choice, and **its list follows the page's language**. This matches dooooWeb's
`FontSettingsPage.tsx` (at `225af77`): one font list, filled from
`getFontsForLanguage(<current language>)`, with the system default first.
Nothing changes in the store: the Type axis already holds the Latin pairing,
and `font_pick_<locale>` already keeps one pick per CJK language.

## What changes

The Typography `AxisField` keeps its name and help. Only its options change,
and they depend on the page's language:

| Page language                       | Typography lists                                                                                 | Picking writes                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| English and the other Latin locales | the type pairings, as shipped: Motir, Motir Sans, Motir Mono, Grotesk, Editorial, Mono-Technical | the Type axis (`typeId`), as today |
| Japanese                            | Automatic (Noto Sans JP), Noto Sans JP, M PLUS Rounded 1c                                        | `setFontPick('ja', id)`            |
| Korean                              | Automatic (Noto Sans KR), Noto Sans KR, Nanum Gothic                                             | `setFontPick('ko', id)`            |
| Chinese                             | Automatic (Noto Serif SC), Noto Serif SC, LXGW WenKai TC                                         | `setFontPick('zh-Hans', id)`       |

- **On a CJK page each option draws its name and a script sample in its own
  face** (ja ひらがなと漢字 · ko 한글과 한자 · zh 汉字与诗文, with
  `lang="<locale>"`), as an `AxisRadioGroup` chip. **Automatic** comes first,
  names the role's default family and is selected when nothing is stored
  (picking it clears the stored pick). Then come the members of the role with
  more than one member, in registry order. The default member is offered
  alongside Automatic, because a stored explicit default survives a later
  change of default while Automatic follows it.
- **The Latin pairings are not offered on a CJK page, and the CJK fonts are not
  offered on a Latin page.** The pairing chosen on a Latin page keeps drawing
  the Latin words on a CJK page (Motir, PROD-128, Stripe), because the font
  sets fall back to it for Latin glyphs.
- **Each language keeps its own choice.** Switching the page language swaps
  the list and shows that language's stored choice. Nothing is lost.
- **Picking applies live**, through the existing optimistic, debounced save,
  like every axis. There is no Save button.

## Panels

1. **English page**: Typography lists the six pairings; Motir selected.
2. **Japanese page, nothing stored**: Typography lists Automatic, Noto Sans JP,
   M PLUS Rounded 1c; Automatic selected.
3. **Japanese page, M PLUS Rounded 1c picked**: the page re-types live; Latin
   words keep the pairing's face.
4. **Korean page, same person**: only the Korean fonts. The ja pick is kept.
5. **Chinese page**: the Serif role. LXGW WenKai TC draws Traditional forms and
   is never the default.
6. **Couldn't sync**: the existing footer, unchanged: `TriangleAlert` +
   `settings.appearance.sync.error`, `role="status"`. No new error string.
7. **Preview face still loading**: the option draws in the language's DEFAULT
   face at the same size (`font-display: swap`), then swaps. No spinner,
   skeleton or dimming.
8. **A stale stored pick**: Automatic selected (the store already drops it and
   `resolveFontSetMember` falls back). No warning.
9. **Dark**: all inks are `--el-*`, so the field flips.
10. **Narrow (~400px)**: the options wrap, like every other axis.

## Faces — loaded by the pane only

The six member faces (Noto Sans JP, M PLUS Rounded 1c, Noto Sans KR, Nanum
Gothic, Noto Serif SC, LXGW WenKai TC) are what the options preview (at most
two at a time, those of the page's language), and the mock loads exactly those
from Google Fonts, never a stand-in. **On the shipped pane these preview faces
are loaded by the Appearance pane only**, so no other page fetches a face just
because the picker could offer it. The page language's CHOSEN face is a
different thing: the first-byte apply loads that one on every page.

## Copy keys (English only; the other ten catalogues are the translate subtask's)

| Key                                                 | English                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `settings.appearance.type.name` (existing, reused)  | Typography                                                             |
| `settings.appearance.type.help` (existing, reused)  | The typeface pairing for headings and body.                            |
| `settings.appearance.type.automatic` (new)          | Automatic ({font})                                                     |
| `settings.appearance.sync.error` (existing, reused) | Couldn't sync to your account — your changes are saved on this device. |

Family names are not translated. The three script samples are fixed strings,
not keys.

## Colour, shape and ink

Nothing new: a CJK option is the same `AxisRadioGroup` chip as a pairing, so a
selected option takes the chip's existing `--el-accent` border, tint and
`--el-accent-on-surface` ink, and an unselected one `--el-text`. Shape is the
chip's `--radius-badge` and `--spacing-chip-x/y`.

## Build dependency (MOTIR-7899)

MOTIR-7899 builds this inside the existing Typography `AxisField` in
`AppearanceCard`: for a Latin page locale it renders the pairings as today;
for ja, ko and zh-Hans it renders Automatic plus the multi-member role's
members from the registry, reading and writing that locale's pick through
`useTheme()`'s `fontPicks` / `setFontPick`, and it loads the page language's
preview faces in the pane only. No fifth field is added.

---

# Profile pane (Story 8.8 · 8.8.20 / MOTIR-1205)

Asset: **`profile.mock.html`** → **`profile.png`**. Flips the **last reserved
"Soon" slot** — `General › Profile` (`accountSettingsNav` `placeholder: true`,
icon `User`, route `/settings/account/profile`) — into a real personal-details
surface. It is the standard **Linear-style Profile + Security split** (verified
linear.app/docs/profile): the photo / name / sign-in email you present to the
team, plus the password you sign in with. Item #11 of the 8.8 launch-readiness
pass; password change/reset is the explicitly-requested setting (Yue).

## Grounded in shipped reality (NOT invented) — per-behaviour source

The pane reuses the **shipped account-settings area** verbatim (rail + identity
header + grouped nav + `Card` panes + the `.srow` settings-row grammar from the
Language pane). The behaviours it depicts are sourced as follows — and, per the
design-against-shipped-reality rule, the mock is **honest about which backend is
already wired vs. which the follow-on build subtask must add** (this card has no
linked sibling subtasks, so the "specs" it cites ARE shipped code + the named
standard, which is richer than a phantom sibling spec would be):

| Behaviour in the mock                                                                         | Source / grounding                                                                                                                                                                                                                        | Backend state today                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Password — change (credential user)**                                                       | Better-Auth `emailAndPassword` default `/api/auth/change-password` (current → new); the **8-char minimum** mirrors the shipped `/reset-password/new` rule (`lib/auth/index.ts`).                                                          | **Shipped** (endpoint mounted by Better-Auth).                                                                                                                                                           |
| **Password — "Send a reset link" (OAuth-only user)**                                          | The **fully-shipped reset flow**: `sendResetPassword` → `/reset-password` → `/reset-password/new`, 1-hour token (`lib/auth/index.ts` ll. 93–134; `lib/emailTemplates/passwordReset.tsx`).                                                 | **Shipped.** Reused as-is so a Google-only user can SET a password.                                                                                                                                      |
| **Credential vs OAuth-only branch**                                                           | The real schema distinction: `Account.provider === 'credential'` (has a password) vs `'google'` only (`accountRepository` / `userRepository where: { providerId: 'credential' }`). Google OAuth is configured (`socialProviders.google`). | **Shipped** (the data to branch on exists).                                                                                                                                                              |
| **Avatar — upload / remove**                                                                  | `lib/blob/uploader.ts` `putAttachment()` (Vercel Blob, returns `{ url }`) + `deleteAttachmentBlob()`. The `User.image` field exists.                                                                                                      | **Primitive shipped; no avatar route/UI yet** — the build subtask adds the upload route + `updateUser(image)`.                                                                                           |
| **Name — inline edit**                                                                        | `User.name` exists; standard inline-edit grammar (the page-state inline-edit contract: success response = confirmation, no tree refresh).                                                                                                 | **No `updateUser(name)` route yet** — build subtask adds it.                                                                                                                                             |
| **Email — change-with-confirmation (link to the NEW address; pending state until confirmed)** | The card's own decision (confirmation sent to the new address); mechanism mirrors Better-Auth's `changeEmail` (verify-before-apply). The pending-state + email-taken error follow the standard.                                           | **NOT wired** — the `changeEmail` plugin is **off** (`requireEmailVerification: false`, no plugin). The build subtask must enable `changeEmail` + a confirmation email template (`lib/emailTemplates/`). |

> **Planning flag (surfaced, not silently absorbed — notes.html #27/#30 shape):**
> the **email-change**, **name update**, and **avatar update** write-backends do
> NOT exist yet (only the blob-uploader primitive does). Design-before-code
> (Principle #13) lets this pane _specify_ those flows, but the **8.8.x Profile
> build subtask must include** (a) `updateUser(name, image)` route(s) through the
> 4-layer stack, (b) an avatar-upload route over `putAttachment`, and (c)
> Better-Auth `changeEmail` + a new confirmation-email template. The
> change-password and reset-link branches need **no** new backend. The planner
> should ensure the build subtask's scope (and `dependsOn`) reflects this — it is
> not a one-file UI bolt-on.

## Layout — two Cards inside the shipped area shell

`page-head` (serif `h2` "Profile" + muted `.sub`), then a `.stack` (max-width
680px) of two `Card`s, each `card-head` (title + `hsub`) over a `card-body` of
`.srow` rows (label/desc left via `.sl .name`/`.desc`, control right via `.sc`,
hairline `--el-border-soft` between rows, none on the last):

**Card 1 — "Profile"** (General):

- **Photo** row — `Avatar` (circular; **initials fallback** `--el-text` fill /
  `--el-text-inverted` text when no image, OR the uploaded image) + **Change**
  (`Button` secondary sm, `camera` glyph) + **Remove** (`Button` danger-ghost sm,
  `trash` glyph — only when an image is set; revert-to-initials, per Linear).
- **Name** row — value + **Edit** (ghost sm, `pencil`). Edit mode: an `Input`
  (`--height-input`, focus ring `--el-accent`) + **Save** (primary sm) / **Cancel**
  (ghost sm); empty → `.err-text` "Name can't be empty." + `--el-danger` border.
- **Email** row — value + **Change email** (ghost sm, `mail`). Pending state:
  old email struck (`--el-text-muted`, line-through) + a **`Pill`** (`pill-warn`,
  peach tint + `--el-text-strong`, `clock` glyph) "Pending → newaddr" + helper
  "Confirmation sent. Applies once confirmed." + **Resend** / **Cancel** links.

**Card 2 — "Password & security"** (Security):

- **Password** row, by account type:
  - **Credential** → "Last changed …" desc + **Change password** (`Button`
    secondary sm, `lock`).
  - **OAuth-only** → a **`callout`** (sky tint, `--el-info`) "You sign in with
    **Google**. Send yourself a reset link to set a password…" + **Send a
    password-reset link** (secondary sm, `mail`).

## States drawn (panels)

1. **Resting** (credential, light) — the access path: rail **General › Profile
   ACTIVE** (canvas-inset active treatment, accent icon); all rows at rest,
   avatar = initials.
2. **Editing / pending / errors** — avatar uploaded (Change + Remove); Name in
   edit mode with the empty-name validation error; Email pending-confirmation.
3. **Change-password modal** (`Modal`, Radix Dialog grammar) — Current / New
   (`helper` "At least 8 characters") / Confirm, each `Input` with an `eye`
   show/hide; footer **Cancel** + **Update** showing the **saving spinner**; a
   success **`Toast`** ("Password updated").
4. **Change-email modal** with the **email-taken** error box (`--el-tint-rose` +
   `--el-danger`); the **OAuth-only** Password card variant; the **loading
   skeleton** (shimmer `.sk` rows + circular avatar placeholder).
5. **Dark parity** — the resting pane on `data-theme="dark"`.

## Token discipline

Colour only via `--el-*` (text `--el-text`/`-secondary`/`-muted`/`-faint`/
`-strong`/`-inverted`; accent `--el-accent`/`-text`/`-on-surface`; status
`--el-danger`/`-text`, `--el-success`, `--el-warning`, `--el-info`; tints
`--el-tint-{peach,rose,sky,mint}`; surfaces `--el-page-bg`/`-surface`/`-muted`;
borders `--el-border`/`-soft`/`-strong`; links `--el-link`). Shape only via
element-semantic tokens (`--radius-card`/`-input`/`-modal`/`-btn`/`-badge`/
`-control`; `--spacing-card-padding`/`-input-x`/`-btn-x`/`-chip-*`; `--height-
input`/`-btn-sm`/`-btn-md`; `--shadow-subtle`/`-modal`/`-elevated`). No Tier-0
`--color-*`, no raw `rounded-*`/`p-*`/`h-*` (avatar/spinner circles use
`border-radius: 9999px`, the sanctioned exception for genuinely circular things).

## Build dependency (for the 8.8.x Profile build subtask)

Implements this pane + the `settings/account/profile` route, flipping the
`accountSettingsNav` `profile` entry from `placeholder: true` to a real route
(keeps the route↔registry totality test green by construction, exactly as 7.8.3
did for API tokens and 7.3.58 for Appearance). Backend to add, per the table
above: `updateUser(name, image)` + avatar-upload route (over `putAttachment`) +
Better-Auth `changeEmail` enablement + a confirmation-email template; the
password change/reset paths reuse shipped Better-Auth. The name/email inline
edits follow the **inline-edit no-tree-refresh** page-state contract (success
response = confirmation), and the rail identity header (`.me`) re-reads the
updated name/avatar on a server refresh.

---

# Settings at ARRIVAL — the family frame (MOTIR-3441)

**Asset ·** `arrival.mock.html` / `arrival.png`. **Story ·**
[MOTIR-3440](motir:cmt8s085i003li1ph06u469kx) — the 24 heavy authed surfaces stop blocking on their
slowest read. **Grammar ·** `design/shell/design-notes.md` § _The navigation-pending grammar_, second
revision. This section applies that grammar to the settings family; it re-specifies none of it.

Settings is **31 of the 58** `app/(authed)` routes and **14 of the 26** heavy ones — over half the
story's population — and they share one body shape. That sameness is what makes a family answer right
here where the rest of the story needs a decision per surface.

## The frame is the PANE. The rail is not in it, and that is a fact rather than a preference

The card asked which of two readings the frame takes — _the whole surface_ or _the pane only_ — and
said the answer changes what the code card builds. **It is the pane only, and the reason is
structural: the rail is not the page's to draw.**

- `SidebarNav variant="rail"` is mounted in **`app/(authed)/layout.tsx`**, in `AppLayout`'s
  `sidebar` slot. It is a sibling of `{children}`, not a descendant, at every route in the app.
- The family has exactly **two** layouts — `settings/project/layout.tsx` and
  `settings/account/layout.tsx` (`git ls-tree -r origin/main --name-only | grep -E
'^app/\(authed\)/settings/.*layout\.tsx$'`) — and **neither renders a rail**. Both are guard-only:
  the project one returns the no-project / no-access states, the account one re-checks the session.
  Their own comments say where the nav lives: _"the grouped settings NAV itself lives in the app rail
  — SidebarNav swaps to it when the route is inside this area … the App Router keeps the rail in the
  parent (authed) layout, not a nested one under `<main>`."_
- The swap is a **client** read of `usePathname()`, so on a soft navigation the rail exchanges its
  item set in the same frame as the click; on a hard navigation it is server-rendered with the shell.

So the rail is never pending, at any width, from any entry point. A frame that drew it as ghost blocks
would put a skeleton over a rail that is already on screen and already correct — which is the flicker
the reveal delay exists to remove, arriving from the other direction. **The family shape survives as
_rail (untouched) + pane frame_.** Panel A draws both states with the rail held identical, because the
absence of a change is the thing to see.

**What this implies for the two navigations the card names:**

| navigation                                            | the rail                                                                                        | the pane                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **settings → settings** (Details → Automation)        | unchanged — same item set, the active mark moves                                                | the only region that exchanges: the frame, then the content |
| **into settings from outside** (Work Items → Details) | the item set swaps, instantly on a soft navigation (client) and with the document on a hard one | the frame, then the content                                 |
| **out of settings**                                   | swaps back the same way                                                                         | the destination's own frame, which is not this family's     |

## Which routes the frame is correct for — read from the layouts, not assumed

The card required this be read rather than assumed, and reading it changes one answer.

| group                      | routes | rail                                                                                                             | frame    |
| -------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- | -------- |
| `settings/project/**`      | 17     | the **project-settings rail** — `SidebarNav` swaps to `lib/settings/projectSettingsNav`, filtered per permission | this one |
| `settings/account/**`      | 6      | the **account-settings rail** — the same swap over `lib/settings/accountSettingsNav`                             | this one |
| `settings/workspace/**`    | 4      | **no settings rail.** The ordinary project rail, with Jobs and Git as bottom-nav rows                            | this one |
| `settings/organization/**` | 4      | **no settings rail.** The ordinary project rail                                                                  | this one |

**So the answer to _"do workspace and organization settings carry a rail?"_ is NO** — eight of the 31
routes render inside the app's ordinary rail, and only the 23 under `project/` and `account/` get a
swapped one. **It does not change the frame**, because the frame never contained the rail in the first
place; what it changes is the claim that may be made about the frame. The frame is correct for a pane
with an ordinary rail beside it exactly as for one with a settings rail beside it, and it is correct
because it draws neither.

## What the frame draws — and the one place it departs from the generic one

```
mx-auto flex max-w-[Wrem] flex-col gap-6      the pane wrapper — the page's own, W from the route
  header  flex flex-col gap-1                 THE REAL HEADER: <h1> + <p>. Not a placeholder.
  <Suspense fallback=…>                       the boundary, BELOW the gate
    animate-pulse                             one pulse for the region, so the blocks are in phase
      rounded-(--radius-card) border          the card stand-in: label bar + action bar + 3 rows
```

**The header is real, and that is the family's substantive difference from `PageSkeleton`'s generic
body.** Rule 2 of _WHICH SURFACES EARN A FRAME_ says a frame only ever covers a region that has
nothing to show yet. A settings pane's title is `t('<pane>.title')` and its subtitle interpolates the
project or organization name — **both already resolved by the gate**, because `getActiveProject()` is
what the guard runs on. A generic page draws a title block because a generic page's title is not
knowable before its read; here it is knowable before the read is even issued, so drawing a grey bar
over it would be a frame covering a region that has something to show.

**This is a requirement on `PageSkeleton`, and it is stated here because that primitive does not exist
yet** (`design/shell/design-notes.md` § _What this asset SPECIFIES that no card owns_, item 1):
`PageSkeleton` must let a caller supply a real header, or omit the header block, rather than always
drawing one. The settings frame composes its **wrapper and its reveal**; it does not take its header
block.

**The card stand-in is not a new drawing.** It is the composition that shipped as the Fields pane's
own route-level skeleton until MOTIR-3558 deleted it, and it now lives in
`components/settings/SettingsPaneFrame.tsx` — a `rounded-(--radius-card)` bordered box at `p-(--spacing-card-padding)`, a
`mb-4 flex items-center justify-between` row carrying an `h-4` label bar and an `h-7` action bar, then
three `flex items-center gap-3` rows of an `size-8` square and an `h-3.5` bar at 40 / 48 / 56% —
**with its two header placeholders removed**. Three rows is a screenful for a 42–46rem pane and is not
a count of anything.

## The WIDTH axis — the one thing the shell's no-shift claim does not reach

`design/shell/design-notes.md` § _THE NO-SHIFT CLAIM_ is _heights and gaps, never widths_, and its
reason is stated: _"the frame and the arriving page both fill `<main>`'s width."_ **On this family that
premise is false.** Every settings pane is a CENTRED column — `mx-auto max-w-[Wrem]` — so a frame whose
W differs from its page's moves the content horizontally on settle. Measured over all 31 routes, the
family uses **eight distinct W**:

| W       | routes                                                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `34rem` | `account/appearance`                                                                                                                                                                                                                                                                                               |
| `42rem` | `project` · `project/fields` · `project/components` · `project/estimation` · `project/members` · `project/code-access` · `project/roles` · `project/roles/new` · `project/ai-planning` · `project/ai-planning/lessons/[lessonId]` · `account/language` · `account/notifications` · `account/profile` · `workspace` |
| `45rem` | `organization`                                                                                                                                                                                                                                                                                                     |
| `46rem` | `project/automation` · `project/repositories` · `workspace/github` · `workspace/gitlab` (the last two via `GitSettingsShell`)                                                                                                                                                                                      |
| `48rem` | `project/workflow` · `organization/billing` · `organization/members` · `organization/usage`                                                                                                                                                                                                                        |
| `52rem` | `project/board` · `project/ai-planning/lessons`                                                                                                                                                                                                                                                                    |
| `60rem` | `workspace/jobs`                                                                                                                                                                                                                                                                                                   |
| `64rem` | `account/tokens`                                                                                                                                                                                                                                                                                                   |

**So W is a prop and each route passes its own** — the same literal its own wrapper carries, so the two
cannot disagree. A frame fixed at 42rem in front of the 60rem Job-runs pane settles by **144px on each
side**. Panel C draws 42 / 48 / 60 in the same stage so the movement is visible rather than argued.

**Two routes have no `max-w` of their own** and take it from a shell they render:
`workspace/github` and `workspace/gitlab` are `GitSettingsShell`'s `46rem`. `account` and
`project/roles/[roleKey]` are covered below.

## The allocation — all 14 heavy panes, with the honest rows written

Three tiers, per `design/work-items/design-notes.md` § _The item page at ARRIVAL_'s method: **with the
frame** = painted from the gate, above the boundary · **with the first content** = behind the
boundary · **after the page** = a second, later boundary. The gate is the reads that decide whether
this reader may see this page — nothing may be flushed until it has run.

Every project-settings pane shares the same gate prefix: `getSession` → `getTranslations` →
`getActiveProject` → `guardSettingsPage('<entry>')`.

| #   | route                                             | awaits | with the frame                                                         | with the first content                                                                  | after the page                              | what actually changes                                                                                                                                     |
| --- | ------------------------------------------------- | ------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `settings/project`                                | 6      | header                                                                 | `Promise.all([getDetails, getManageCapabilities])`, then `getFormatter`                 | —                                           | **the frame only.** The two reads are already one wave                                                                                                    |
| 2   | `settings/project/board`                          | 8      | `<h1>` + subtitle (see the breadcrumb note below)                      | `getBoard` ∥ `listStatusesByProject`                                                    | —                                           | **serial → concurrent.** The two are independent; `statusByKey` merely joins them                                                                         |
| 3   | `settings/project/workflow`                       | 6      | header                                                                 | `getWorkflow` ∥ `getStatusAutomation`                                                   | —                                           | **serial → concurrent.** Independent; two editors, one each                                                                                               |
| 4   | `settings/project/automation`                     | 6      | header                                                                 | `automationRulesService.list`, then the six-way `Promise.all`                           | —                                           | **the frame only.** The second wave needs the label ids the first returns, so it genuinely stays two waves                                                |
| 5   | `settings/project/repositories`                   | 6      | `<h1>` only                                                            | `getRoomView` → the lead line, the summary line, the CI-paused banner and the rows      | —                                           | **the frame only.** One read; nothing to make concurrent. **The lead line is tier 2**, because which of two strings it uses depends on `view.rows.length` |
| 6   | `settings/project/ai-planning`                    | 6      | header                                                                 | the five-way `Promise.all` (capabilities, settings, pause, formatter, `canViewLessons`) | `listLessons` — the lesson-library preview  | **a second boundary.** The preview is the one settings region that is genuinely late: it cannot start until `canViewLessons` returns                      |
| 7   | `settings/project/ai-planning/lessons`            | 6      | back-link + header                                                     | the three-way `Promise.all` (page, formatter, `mayManage`)                              | —                                           | **the frame only.** Already one wave                                                                                                                      |
| 8   | `settings/project/ai-planning/lessons/[lessonId]` | 7      | back-link + header                                                     | — **nothing**                                                                           | —                                           | **NOTHING STREAMS.** `getLesson` decides the `notFound()`, so it is a gate read — and once it returns the body has everything                             |
| 9   | `settings/project/roles/[roleKey]`                | 6      | — **nothing**                                                          | — **nothing**                                                                           | —                                           | **NOTHING STREAMS.** `getRoleCatalog` decides the 404 AND supplies `RoleDetail`'s own `<h1>`                                                              |
| 10  | `settings/project/roles/[roleKey]/edit`           | 6      | — **nothing**                                                          | — **nothing**                                                                           | —                                           | **NOTHING STREAMS.** The same catalog read, the same 404, `RoleEditor`'s header inside it                                                                 |
| 11  | `settings/workspace/jobs`                         | 9      | header                                                                 | `getMemberRole` → the tab strip, then `countDLQ` ∥ the selected tab's list              | —                                           | **serial → concurrent** on the second wave. The role selects which list is fetched, so it precedes them                                                   |
| 12  | `settings/workspace/gitlab`                       | 7      | the whole `GitSettingsShell` header — title, subtitle, provider switch | `getConnectionForWorkspace` → the connected / not-connected panel                       | —                                           | **the frame only.** One read, and the shell above it is pure `t('git')`                                                                                   |
| 13  | `settings/organization`                           | 7      | header                                                                 | `listUserWorkspaces` ∥ `listMembers` ∥ `getAiAccess`                                    | —                                           | **three serial → one wave.** The largest single win in the family                                                                                         |
| 14  | `settings/organization/billing`                   | 6      | the `sr-only` title                                                    | `listMembers` → `BillingClient`                                                         | `BillingClient`'s own screens (client-side) | **the frame only**, and a small one: the client island already owns its per-screen states                                                                 |

**Three of the fourteen have no allocation at all, and writing that down is the point.** Rows 8–10 are
`notFound()` deciders whose deciding read IS the read that fills the page. There is nothing left to put
behind a boundary, and a `<Suspense>` added there would wrap a value already in hand — the padding the
card said must not happen. Row 9 and row 10 do not even paint a header, because `RoleDetail` and
`RoleEditor` own theirs and both need `role`.

**Row 2's breadcrumb is the family's one no-shift hazard.** `BoardSettingsHeader` renders a
`text-xs` breadcrumb line above the `<h1>` **only when `boardName` is present**, and `boardName` comes
from the tier-2 `getBoard`. So the header grows by one line plus its `gap-2` when the content arrives.
**The frame reserves that line** — an `h-4` block in the same position — so the title does not jump.
This is the only settings pane where a tier-1 region changes height on settle.

**And row 6 is the only second boundary in the family.** Everywhere else the third tier is empty, which
is the expected shape for a pane that is one card of fields over two reads.

## The two shipped settings skeletons — SUPERSEDED

The Fields and Components panes each carried a route-level `loading.tsx` — the only two in the family.
They are drawn in Panel D as they rendered.

**Verdict: both are deleted, in the same commit that lands the shared component in those two routes.**

> ✅ **DONE — MOTIR-3558 (`2a27a1a2`).** Both files are gone and both panes mount
> `components/settings/SettingsPaneFrame.tsx` in-page instead, in that one commit. Their paths are
> deliberately no longer written out above: a design asset names the file an agent should MIRROR, and
> a path that resolves to nothing sends them looking for it — which is what
> `tests/design-asset-addresses.test.ts` caught on the story's own pull request.

- **Not because a boundary is illegal there.** Neither page calls `notFound()`, so both are legal
  under `motir-core/CLAUDE.md` § _A `loading.tsx` may NOT sit above a route that decides existence_.
- **Because they are the same drawing twice, from a second source, and have already drifted:** the
  title bar is `w-32` in one and `w-40` in the other; the action bar `w-24` and `w-28`. Neither number
  stands for anything — the real titles are _Fields_ and _Components_, which the family frame paints
  instead of approximating. Two hand-rolled copies of one drawing is precisely the drift rule 4 of
  _WHICH SURFACES EARN A FRAME_ names, and `IssueTreeSkeleton` is what it looks like after eighty days.
- **Because a route boundary that survives beside an in-page frame shows the same pending state
  twice for one navigation** — the route fallback while the page function runs, then the page's own
  fallback while its body resolves.

**Nothing else under `app/` is touched.** `app/(planning)/loading.tsx` and
`app/(public)/explore/(square)/loading.tsx` are outside this family and outside this story.

## Token / a11y rules honoured

- Every fill is `--el-muted`; every edge `--el-border`; the arrived card `--el-card` /
  `--shadow-(--shadow-card)`. **No Tier-0 `--color-*`, no invented hue.**
- Every radius is `--radius-card` / `--radius-control` / `--radius-btn`; padding is
  `--spacing-card-padding`; the action bar is `h-7`, matching the shipped skeletons. No raw
  `rounded-md` / `p-2`.
- Header ink is `--el-text`; subtitle `--el-text-muted` **on the page surface only**, where it is
  4.54:1 — the pane's wrapper paints no surface of its own, so the caveat in
  `motir-core/CLAUDE.md`'s contrast table does not bite. The board's own annotation ink is
  `--el-text-secondary`.
- `aria-busy="true"` on the frame region; the blocks are decorative and carry no text. The region is
  announced once, not per block.
- The reveal is `design/shell/`'s `nav-pending-reveal` keyframe at 120ms, **referenced, never
  re-declared** — one declaration governs the shell's mark and every page's frame.
- Dark is the same tokens re-emitted (Panel F). The mock's dark panel carries
  `data-appearance-scope` beside `data-theme="dark"` and declares `color` on the container, so the
  Tier-3 layer resolves on the subtree.

## Primitives composed (no hand-rolling)

| element              | primitive / token                                                                 | note                                                                  |
| -------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| the pane wrapper     | `mx-auto flex max-w-[Wrem] flex-col gap-6`                                        | the page's own wrapper, with W passed in — not a copy                 |
| the header           | the page's real `<h1>` + `<p>`                                                    | painted from the gate; the frame does not draw it                     |
| the wrapper + reveal | `PageSkeleton` (MOTIR-3433's, reverted — see the GIVES/TAKES below)               | composed, with the header block omitted                               |
| the card stand-in    | `rounded-(--radius-card)` · `border-(--el-border)` · `p-(--spacing-card-padding)` | `settings/project/fields/loading.tsx`'s composition, minus its header |
| the pulse            | `animate-pulse` on the region                                                     | one animation, so the blocks are in phase                             |
| the rail             | `SidebarNav variant="rail"` — **unchanged, and outside the frame**                | rendered in the asset from the real component, not redrawn            |

## The design-allocation sweep — what this asset GIVES and TAKES

| card                                                                                | GIVES / TAKES | what                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[MOTIR-3443](motir:cmt8s08bg003oi1phhs0qf51a)** — settings opens on its own frame | **GIVES**     | the frame's composition, the pane-only decision with its evidence, the W-is-a-prop rule and the eight-width table, rows 1–10 of the allocation, the breadcrumb reservation, and the delete-both-`loading.tsx` verdict                                                                                         |
| **[MOTIR-3448](motir:cmt8s08ik003ti1phu26fxgo9)** — workspace + organization panes  | **GIVES**     | rows 11–14, and the finding that these eight routes carry **no** settings rail — so the card must not reach for one                                                                                                                                                                                           |
| **[MOTIR-3442](motir:cmt8s088r003ni1phat3x1o9q)** — the remaining ten surfaces      | **GIVES**     | nothing to build, and one thing to know: the CENTRED-column caveat on the no-shift claim generalises to any surface that is `mx-auto max-w-[…]` rather than full-width                                                                                                                                        |
| **[MOTIR-3449](motir:cmt8s08js003ui1ph9dawc83l)** — the vitest gate                 | **GIVES**     | three assertions this asset makes checkable: no `loading.tsx` exists under `app/(authed)/settings/`, the frame's W equals its page's, and the two deleted files stay deleted                                                                                                                                  |
| **MOTIR-3433's `PageSkeleton`**                                                     | **TAKES**     | a requirement it does not yet have: the header block must be **omittable**, because this family paints a real header above the boundary. `PageSkeleton` was reverted with MOTIR-3433 and no card owns rebuilding it — named in `design/shell/design-notes.md` § _What this asset SPECIFIES that no card owns_ |
| **`design/shell/design-notes.md`** § _THE NO-SHIFT CLAIM_                           | **TAKES**     | its scope, not its content: _heights and gaps, never widths_ holds for a full-width `<main>` and not for a centred column. Stated here rather than edited there, because the shell asset's own subject is full-width                                                                                          |

## How the render was produced

Generated, not hand-drawn, so the asset cannot drift from the app:

1. **The rail is the real `SidebarNav variant="rail"`** in its project-settings state, dumped through
   the repository's own vitest + React-Testing-Library setup with the real `messages/en.json` and the
   admin permission set — the same technique `design/shell/navigation-pending.mock.html` § _How the
   render was produced_ describes. It is the settings rail the app renders, including its active mark.
2. **The two shipped settings skeletons are the real components**, rendered the same way — Panel D is
   their output, not a redraw of it.
3. **Every string is the real `en` catalog's** — `settings.automation.*`, `settings.details.*`,
   `settings.workflow.*`, `settings.jobs.*`.
4. **The stylesheet is Tailwind's own output** over this markup, with
   `@motir/design-system/theme.css`, so the token layers are the build's rather than a retyped block.
5. The `.png` is exported with `node scripts/render-design-mock.mjs`.

Two board artefacts, named so they are not read as design: the shell stage is held at a fixed
**820px** (the app's shell is `h-dvh`), and the frames showing a revealed state force the reveal
animation's end state, because a board is a still.

---

# Two-factor authentication — `two-factor.mock.html`

**Story 8.11 (MOTIR-1213) · Subtask MOTIR-1216.** The account-settings
`Security › Two-factor authentication` pane: enrol an authenticator app, keep
email as a labelled lower-security fallback, hold ten single-use recovery codes,
and revoke the browsers that stopped being asked. **Gates MOTIR-1220** (the pane

- its route). The LOGIN CHALLENGE half of the same subtask is a separate asset in
  its own area — `design/auth/two-factor-challenge.mock.html` — because it renders
  in the signed-out `(auth)` frame; the two cite each other and neither
  re-specifies the other.

## Grounded in shipped reality (rung 2 — what was verified, and where)

| the design assumes                                                                    | verified against                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the area shell, the rail, the identity header, the grouped nav, the Card pane grammar | `account-settings.mock.html` / `profile.mock.html`, copied 1:1 — not redrawn                                                                                                                                                                                                                                                         |
| the Security group exists and holds `API tokens`                                      | `lib/settings/accountSettingsNav.ts` — `group: 'security'`, one entry (`apiTokens`)                                                                                                                                                                                                                                                  |
| every control maps to an endpoint that already exists                                 | `lib/auth/index.ts` registers Better-Auth's `twoFactor` plugin (MOTIR-1217); the endpoint list is in the per-control table below                                                                                                                                                                                                     |
| recovery codes are **encrypted, not hashed**                                          | `BackupCodeOptions.storeBackupCodes` accepts `'plain' \| 'encrypted' \| {encrypt,decrypt}` — there is no hashed arm. The copy is written to match                                                                                                                                                                                    |
| "don't ask again" needs no new table                                                  | `plugins/two-factor/verify-two-factor.mjs` writes a `trust-device-<random>` row into the EXISTING `verification` table with an expiry                                                                                                                                                                                                |
| ten codes, six digits, 30-second TOTP step, 30-day trust                              | **MOTIR-1217**, which pins them as named constants beside the plugin registration — the pane RENDERS those values, so the copy reads them rather than restating them. Cited by CARD rather than by path: the file lands with that card, and an asset naming a path that does not exist yet sends the next reader looking for nothing |

## The ACCESS PATH — a new rail entry, first in the Security group

The pane is reached one way and one way only: **`Security › Two-factor
authentication`** in the account-settings rail, drawn ACTIVE in panels 1, 2 and 6. It is a NEW `accountSettingsNav` entry at `/settings/account/security`,
declared **before** `apiTokens` — the registry orders by declaration, and a
second factor is the more consequential of the two things in that group.

```ts
{ id: 'twoFactor', group: 'security', href: '/settings/account/security',
  icon: ShieldCheck, labelKey: 'twoFactor' }
```

Adding it with its route on disk keeps the route↔registry totality test green by
construction — the same move 7.8.3 made for API tokens and 7.3.58 for Appearance.

## Panels

| #   | what it draws                                                                                   |
| --- | ----------------------------------------------------------------------------------------------- |
| 1   | **Off** — the empty state + the "what you'll be asked for" explainer + the access path          |
| 2   | **On** — four cards: the methods, the recovery counter, the trusted devices, the way out        |
| 3   | **Enrol** — three steps: the password step-up, QR + manual key, then the confirming code        |
| 3b  | **Enrol, no password** — the Google-only account: step 1 skipped, and why that is a config fact |
| 4   | **Recovery codes** — the shown-once set, and the regenerate confirmation                        |
| 5   | **The states the happy path hides** — 2 left, 0 left, the turn-off step-up, a rejected code     |
| 6   | **Dark parity** — panel 2 under `data-theme="dark"`                                             |

## Per-control map — primitive, endpoint, tokens

| element                 | primitive                   | endpoint / source                                     | colour                                                                                               | shape                                      |
| ----------------------- | --------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| pane frame + cards      | `Card`                      | —                                                     | `--el-page-bg` on `--el-border`, `--shadow-subtle`                                                   | `--radius-card`, `--spacing-card-padding`  |
| page head               | serif `h2`                  | —                                                     | `--el-text`; sub `--el-text-muted` (on the white card — AA 4.54)                                     | —                                          |
| rail row (active)       | `SidebarNavItem`            | `accountSettingsNav`                                  | `--el-sidebar-item-bg-active`, icon `--el-accent`                                                    | `--radius-control`, `--height-control`     |
| method row              | `.mrow` (a `.srow` + glyph) | —                                                     | glyph tile `--el-muted` → `--el-tint-mint` when on                                                   | `--radius-control`                         |
| "Set up" / "Replace"    | `Button` secondary / ghost  | `authClient.twoFactor.enable`                         | `--el-border-strong` / `--el-text-secondary`                                                         | `--radius-btn`, `--height-btn-sm`          |
| email toggle            | `Switch`                    | `otpOptions` is server-level; the toggle is Motir's   | on: `--el-accent`; off: `--el-muted` on `--el-border-strong`                                         | pill (`rounded-full`, a true circle)       |
| "Lower security" chip   | `Pill`                      | —                                                     | `--el-tint-peach` + `--el-text-strong`, glyph `--el-warning`                                         | `--radius-badge`, `--spacing-chip-*`       |
| "Primary" chip          | `Pill`                      | —                                                     | `--el-tint-lavender` + `--el-text-strong`                                                            | `--radius-badge`                           |
| "On" chip               | `Pill`                      | `user.twoFactorEnabled`                               | `--el-tint-mint` + `--el-text-strong`, glyph `--el-success`                                          | `--radius-badge`                           |
| recovery counter        | mono numeral                | `twoFactorService.getStatus` → `backupCodesRemaining` | `--el-text` → `--el-warning` at ≤2 → `--el-danger` at 0                                              | —                                          |
| the code grid           | `.codes`                    | `POST /api/account/two-factor/backup-codes`           | `--el-page-bg` on `--el-border`; a used code `--el-text-faint`                                       | `--radius-input`                           |
| QR + manual key         | `.qr` / `.keyrow`           | `authClient.twoFactor.enable` → `totpURI`             | modules `--el-text` on `--el-page-bg`                                                                | `--radius-input`                           |
| six-digit field         | `.otp`                      | `authClient.twoFactor.verifyTotp`                     | `--el-border-strong`; focus `--el-accent`; error `--el-danger`                                       | `--radius-input`                           |
| enrol / confirm modals  | `Modal`                     | —                                                     | `--el-page-bg`, `--shadow-modal`                                                                     | `--radius-modal`, `--spacing-card-padding` |
| callouts                | `.callout`                  | —                                                     | info `--el-tint-sky` · warn `--el-tint-peach` · danger `--el-tint-rose`, all with `--el-text-strong` | `--radius-card`                            |
| "I've saved these" tick | `Checkbox`                  | —                                                     | on: `--el-accent` + `--el-accent-text`                                                               | `--radius-xs`                              |
| trusted-device row      | `.drow`                     | the `verification` `trust-device-*` rows              | `--el-text` / `--el-text-muted` on the white card                                                    | hairline `--el-border-soft`                |
| "Revoke" / "Turn off"   | `Button` danger-ghost       | `authClient.twoFactor.disable`                        | `--el-danger`, hover `--el-tint-rose`                                                                | `--radius-btn`, `--height-btn-sm`          |

## ⚠️ THE STEP-UP IS NOT DECORATION — the endpoints refuse without it

Added in review (the question _"can we actually link an authenticator app?"_),
after checking the drawing against the endpoint contracts rather than against the
story's prose. The first draft of panel 3 opened on the QR. **It could not have
been built**, and the reason generalises past this card.

**Three of this pane's actions are password-gated by the plugin, not by us:**

| action           | endpoint                                                   | gate                                                   |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| enrol            | `auth.api.enableTwoFactor` (`authClient.twoFactor.enable`) | `shouldRequirePassword` → `validatePassword`           |
| regenerate codes | `auth.api.generateBackupCodes`                             | the same, plus `twoFactorEnabled` must already be true |
| turn off         | `auth.api.disableTwoFactor`                                | the same                                               |

**And for enrol the ORDER is forced, which is the part a drawing gets wrong
silently.** `enableTwoFactor` is the call that MINTS the secret and returns the
`totpURI`, so the password comes BEFORE the QR — there is nothing to render until
that call returns. A design that puts the step-up after the scan is not a
different taste, it is a screen whose data does not exist yet.

So the enrol rail is **Confirm → Scan → Enter code**, and the step-up is ONE
shared modal that also fronts regenerate (drawn inline in panel 4, since one
destructive action does not earn two modals) and turn-off (panel 5). That is the
story's own _"all 2FA-management actions sit behind a recent-auth/step-up check"_
made concrete rather than restated.

**The codes come from `enable`, not from a later call.** `enableTwoFactor`
returns `{ totpURI, backupCodes }` together, at step 2. The pane shows the codes
after step 3 succeeds, so the client HOLDS them across the confirm — there is no
second endpoint to fetch them from, and looking for one is the obvious wrong
turn. (`viewBackupCodes` exists but takes a `userId` and is a server-side
administrative read, not this flow.)

**An abandoned enrolment is a real state and panel 1 draws it.** Step 2 has
already written the `two_factor` row with `verified: false` while
`twoFactorEnabled` stays false, so a reader who closes the modal leaves a stale
row behind. `verifyTOTP` is what flips both.

## ⚠️ AND THE STEP-UP IS SKIPPED FOR AN ACCOUNT WITH NO PASSWORD — panel 3b

The second half of the same finding, and the more serious one, because its
failure mode is total and silent:

```js
// shouldRequirePassword
if (!allowPasswordless) return true; // the DEFAULT — every user
return Boolean(credentialAccount); // with the flag — the real question

// validatePassword
if (!credentialAccount || !currentPassword) return false; // a Google-only user
```

On the default, a Google-only account — ordinary in Motir, since
`trustedProviders: ['google']` ships and this file's own Profile section already
branches on credential-vs-OAuth-only — is answered `INVALID_PASSWORD` for a
password it was never asked to set. **It could not turn 2FA on at all**, and no
copy on this pane could explain why.

`lib/auth/index.ts` now sets `allowPasswordless: true` (MOTIR-1217), which keeps
the password mandatory for every account that HAS one and stops excluding every
account that does not. Panel 3b draws what that reader sees: a two-step rail, and
a callout saying their Google account is what protects the change.

## The QR is a DRAWING, not an encoding — panel 3

Stated because it is exactly the kind of thing a reader assumes either way. The
`<svg>` in panel 3 is a deterministic module grid with real finder patterns,
timing rows and an alignment block: it reads as a QR code at a glance, which is
what a layout board needs, and it **encodes nothing**. Scanning it yields no
`otpauth://` URI.

The real one comes from `enable`'s `totpURI`, built by
`createOTP(secret, { digits, period }).url(issuer, user.email)` — so the string
the implementer renders is
`otpauth://totp/Motir:zhuyue@motir.co?secret=…&issuer=Motir&digits=6&period=30`,
with `issuer` and the two numbers coming from the constants MOTIR-1217 pins. The
mock's manual key (`JBSW Y3DP EHPK 3PXP`) is likewise a plausible Base32 sample,
not a secret.

## The copy, and the four places it is load-bearing

Every string on the pane is in the mock verbatim. Four of them are decisions:

1. **"Motir stores them encrypted, so we can't display them again"** — NOT "we
   can't read them". The plugin encrypts rather than hashes, so the second
   sentence would be false, and a design that overstates a security property
   teaches the implementer to overstate it in a UI a customer will quote back.
2. **"Lower security"** on email, in the SAME words on the pane and at the
   challenge. One caveat, worded once, wherever the method appears (NIST
   800-63B: an inbox is not a strong possession factor).
3. **The zero-codes callout names the consequence, not the count.** "You've used
   every recovery code. If you lose your authenticator now, only an emailed code
   can get you back in." A quiet `0` is a state a reader does not read.
4. **Turn-off says what is deleted.** "Your authenticator enrolment and all
   remaining recovery codes are deleted. Turning it back on starts from
   scratch." The plugin's disable does exactly that; the copy is the behaviour.

**i18n keys** — one namespace, `settings.account.twoFactor.*`:
`nav` · `title` · `subtitle` · `off.title` · `off.body` · `off.cta` ·
`methods.title` · `methods.subtitle` · `methods.totp.{name,desc,setUp,replace}` ·
`methods.email.{name,desc,lowerSecurity}` · `methods.primary` ·
`recovery.{title,subtitle,remaining,generate,generateDesc}` ·
`recovery.{low,exhausted}` · `enrol.{step1,step2,scan,cantScan,confirm,confirmDesc,next}` ·
`codes.{title,subtitle,copyAll,download,acknowledge,warning,done}` ·
`regenerate.{title,body,warning,confirm}` ·
`devices.{title,subtitle,revoke,revokeAll,trustedOn,expires}` ·
`disable.{title,subtitle,cta,confirmTitle,confirmBody,warning}` ·
`errors.{wrongCode,clockDrift}`. Every `en` key needs its `zh` twin
(`tests/i18n-catalog.test.ts`).

## States drawn, and the one that is NOT

Drawn: **off** (panel 1) · **enrolled** (2) · **enrolling, both steps** (3) ·
**codes shown once** (4) · **regenerate confirm** (4) · **low / exhausted
codes** (5) · **turn-off step-up** (5) · **a rejected confirming code** (5) ·
**dark** (6).

~~**Not drawn, deliberately: a passkey row.** Story 8.12 (MOTIR-1214) adds
WebAuthn as a third method, and the methods card is built as a LIST so that row
lands beside the other two without a re-layout.~~ **DISCHARGED by MOTIR-3609 —
and the prediction was half right.** The row DID land in the methods list
without a re-layout, exactly as this line expected, and `passkeys.mock.html`
draws it. What the line did not anticipate is that the row is READ-ONLY: every
control lives in a card of its own above, because a passkey replaces the
password rather than following it. So the methods card gained a row and gained
no control — see **Passkeys — `passkeys.mock.html`** below, and note that
`two-factor.mock.html` itself is NOT amended: this file is where the correction
lives, which is what "amended in the notes, not in the frozen mock" means.

## The workflow spec this design is grounded in (the design-content dependency)

This asset invents no behaviour. Each flow it draws is defined by a sibling
card, and the design cites them rather than deciding them:

- **MOTIR-1217** — which methods exist, the ten codes, the six digits, the
  30-second step, the 30-day trust, and the fact that trust is a `verification`
  row rather than a table.
- **MOTIR-1218** — the status DTO the pane renders (`enabled`, `methods`,
  `primaryMethod`, `backupCodesRemaining` / `Total`), the regenerate endpoint,
  and the typed refusals the error states show.
- **MOTIR-1220** — the card that BUILDS this pane.
- **MOTIR-1221** — the challenge, in the other asset.

## The nested-theme re-emit (a board artefact, named so it is not read as design)

`--el-*` is declared on `:root` as `var(--color-*)`, and a custom property's
`var()` is substituted where it is DECLARED — so a nested
`[data-theme='dark']` flips the Tier-0 palette under it while every `--el-*`
keeps the light value it computed at `:root`. This board puts `data-theme` on a
nested `.panel`, so it re-emits the Tier-3 block scoped to the attribute (the
same fix `appearance.mock.html` carries for its sidebar tokens). In the app
`data-theme` sits on `<html>` and none of it is needed.

**⚠️ MEASURED, and it is a finding about a NEIGHBOUR asset:**
`profile.mock.html`'s Panel 5, labelled _"Dark parity — the resting pane renders
correctly on `data-theme="dark"`"_, **does not render dark**.
`getComputedStyle` on its dark `.stage` returns `--el-page-bg: #ffffff`. The
panel is a light panel with a dark label, so the parity it claims to verify has
never been looked at. Filed rather than fixed in passing — it is another card's
asset (MOTIR-1205's).

## Self-review

- Every icon is a lucide path at `viewBox="0 0 24 24"`, sized by CSS.
- No nested interactive elements: the method rows are rows, not buttons, with the
  control as the only focusable thing in them.
- Ink/surface pairs: `--el-text-muted` appears only on the white card
  (4.54:1); every caption on `--el-surface` / `--el-muted` /
  `--el-surface-soft` uses `--el-text-secondary` (6.18–6.80:1).
- The two `--el-text-faint` uses are both decorative and say so: the empty
  code cell's placeholder dash is `aria-hidden`, and the struck-through
  spent-code rule is disabled text (1.4.3 exempts it).
- No Tier-0 `--color-*` outside the token block; no raw `rounded-*` / `p-*` /
  `h-9` on any control's own box.

---

# Passkeys — `passkeys.mock.html`

**Story 8.12 (MOTIR-1214) · Subtask MOTIR-3609, Surface A.** The `Security`
pane's **passkeys** card: register a WebAuthn credential, see the ones you hold,
rename one, remove one. **Gates MOTIR-3612** (the card + its island). The SIGN-IN
half of the same subtask is a separate asset in its own area —
`../auth/passkey-sign-in.mock.html` — because it renders in the signed-out
`(auth)` frame; the two cite each other and neither re-specifies the other.

`two-factor.mock.html` is NOT amended and is not re-exported. It is the record of
what 8.11 decided, and this asset composes the pane it drew rather than editing
it — the correction to its "not drawn, deliberately" line lives in this file,
above.

## Grounded in shipped reality (rung 2 — what was verified, and where)

**The pane was RENDERED before anything was drawn.** A production build
(`next build` + `next start`), signed in as a real account,
`/settings/account/security` screenshotted at 1440×1000 @2x, plus `/sign-in` for
Surface B. Reading `TwoFactorManager.tsx` would not have been enough, and one
thing it settled is a divergence nobody had recorded:

- ⚠️ **THE FROZEN MOCK AND THE RUNNING PANE DISAGREE ABOUT THE EMAIL ROW.**
  `two-factor.mock.html` draws its control as a **Switch**; the shipped
  `MethodRow` renders the text **"Set up an authenticator first"**, because the
  plugin's OTP arm is server-level and a per-user switch would write nowhere —
  which `lib/auth/index.ts`'s own comment says. This board follows the PANE. The
  frozen mock is not wrong about what was decided; it is stale about what
  shipped, and that is what a frozen asset is for.
- The area shell (rail + identity header + grouped nav + `Card` panes), the page
  head, the `.mrow` method-row grammar and every control primitive are copied
  1:1 from `two-factor.mock.html` / `account-settings.mock.html`, so the two
  surfaces are diffable.
- The MECHANISM is `@better-auth/passkey`, registered by **MOTIR-3610**. Every
  control here maps to an endpoint it mounts (below), so nothing on this surface
  is a capability that would have to be invented.
- `authenticatorSelection.userVerification: 'required'` is pinned at
  registration (MOTIR-3610), which is why the copy may say a passkey is two
  factors **on its own** (NIST SP 800-63B) without qualifying it.
- The read-only `Passkey` row in the methods card is `TwoFactorStatusDTO.methods`
  containing `'passkey'` (**MOTIR-3611**) — and it is drawn with two-factor
  **OFF**, because that DTO adds it on `passkeyCount >= 1` regardless of
  `enabled`. That is the seam 8.13 reads, and drawing it any other way would
  contradict the code that ships underneath it.

## The ACCESS PATH — an EXISTING rail row, and no new one is proposed

The rail's Security group keeps the two rows it already has
(`lib/settings/accountSettingsNav.ts`). The passkeys card is a new **section** on
the pane the `twoFactor` entry already opens, and the board draws the pane in its
rail so the placement is unambiguous rather than described in prose.

**Why not a third Security row.** A row of its own would split one subject —
"how do I prove it is me?" — across two pages, and the first thing a reader
would then have to do is compare them. It would also require the reader to
already know the word _passkey_ to find the thing that explains what a passkey
is. The one argument for a separate row is discoverability, and the card's
position at the top of a pane the reader is already on buys that more cheaply.

## Why its OWN card, and not a row inside "What you'll be asked for"

The story's reason, stated once so the build does not relitigate it: **a passkey
replaces the password, it does not follow it.** A screen that files it under
"second factor" teaches the reader that they still need the authenticator app,
or that removing the passkey leaves them locked out. Both are false and both are
expensive to unlearn. GitHub and Linear both present passkeys separately, which
is rung 1 agreeing.

The methods card still gains a **read-only** `Passkey` row, because the account
genuinely holds that method and a list that omitted it would be lying by
omission. Its control is the words **"Managed above"** with an up-arrow — not a
link, because the target is 200px up the same page and a link there would be a
navigation that does not navigate.

## ⚠️ The amendment this design asks of the SHIPPED hero (panel 2)

The pane's first card says **"Two-factor authentication is off"**. With a passkey
registered that sentence sits directly above a card explaining that the reader
already has two factors, and a reader who notices is right to be confused.

**So when `methods` contains `'passkey'` and `enabled` is false, the hero gains
one callout** — _"Your passkey already counts as a second factor. An
authenticator app adds a fallback for the days your device is not with you."_ —
and nothing else changes: same title, same button, same copy. It is additive, it
is derivable from the DTO MOTIR-3611 already ships, and MOTIR-3612 owns building
it. Naming it here is the point: it is the one change to a SHIPPED element this
story needs, and a card that only reads its own section would never find it.

## Panels

1. **Zero state** — three cards: the shipped 2FA hero, the new passkeys card,
   the shipped methods list. The empty state spends its words on what a passkey
   IS, because most readers have never knowingly used one and "Add a passkey"
   alone answers nothing.
2. **Populated** — three rows, plus the hero's amendment and the methods card's
   read-only `Passkey` row.
3. **Registering** — the pending row, and a labelled stand-in for the browser's
   own sheet.
4. **Rename** — the modal.
5. **Remove** — the confirmation, with the last-passkey consequence.
6. **The three reader-visible refusals**, drawn as the reader sees them; the
   error codes are in the board's captions, never on the page.
7. **Dark parity** — the populated pane on `data-theme="dark"`.

## Per-control map — primitive, endpoint, tokens

| Control                       | Primitive                                                                | Endpoint (`@better-auth/passkey`)                                                   |
| ----------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **Add a passkey**             | `Button variant="primary" size="sm"` in `Card` header                    | `authClient.passkey.addPasskey()` → generate-register-options → verify-registration |
| **The list**                  | rows in `Card` body, `--el-border-soft` hairlines                        | the Server-Component read `passkeyService.listForUser` (MOTIR-3611)                 |
| **Synced / This device only** | `Pill`                                                                   | `deviceType` — `multiDevice` / `singleDevice`                                       |
| **Rename**                    | `Button variant="ghost" size="sm"` → `Modal` + `FormField` + `Input`     | `auth.api.updatePasskey` (`…/api/auth/passkey/update-passkey`)                      |
| **Remove**                    | `Button variant="ghost" size="sm"` → `Modal` + `Button variant="danger"` | `auth.api.deletePasskey` (`…/api/auth/passkey/delete-passkey`)                      |
| **Passkey (methods)**         | the shipped `MethodRow`, control replaced by text                        | none — it is a read of `TwoFactorStatusDTO.methods`                                 |

## Two decisions this asset makes so the code card does not have to

**Rename is a MODAL, not an inline edit.** The row is already dense — name, chip,
date, two controls — and an inline field either pushes the controls out of reach
or grows the row in the middle of a list. A modal also gives the 64-character
bound somewhere to be **stated** rather than silently enforced. The value is the
current name, selected, so the common case is type-and-save.

**The row's Remove does NOT use red LABEL text**, and this is a measurement
rather than a preference. `--el-danger` is 4.51:1 on the light page and **4.25:1
on the dark one**, so a red label fails AA in dark; graphics need only 3:1. The
hue therefore goes in the trash GLYPH and the label stays on `--el-text`
(17.4:1, both themes). The weight this costs is bought back by the confirmation,
where a solid danger FILL is correct because the act really is destructive.

## The refusals, and the one that draws nothing

`PASSKEY_ERROR_CODES` has fourteen members; three reach a reader on this surface
and they take three shapes:

- **`PREVIOUSLY_REGISTERED`** — an inline notice, not an error: the reader asked
  for something they already have. _"This device already has a passkey for Motir.
  Use it to sign in, or add one from a different device."_
- **`CHALLENGE_NOT_FOUND`** — the plugin's challenge cookie lapsed after 300
  seconds. _"That took more than 5 minutes, so we started over."_ The copy states
  the number the server enforces, read from the passkey constants module, never a
  second literal.
- **`REGISTRATION_CANCELLED` / `AUTH_CANCELLED`** — **nothing is drawn.** The
  reader dismissed their own browser's sheet, which is a decision. A red banner
  here tells someone they did something wrong when they did not.

## The default NAME, and why the register flow proposes one

Two rows have to be tellable apart, and `name` is the only field that does it —
`deviceType` collapses to two values and the date collapses to one for anyone
who adds two passkeys in a sitting. The plugin's `name` is optional and it
proposes nothing, so an unnamed list is the default outcome unless we choose
otherwise. **The register call supplies a default read from the browser at
registration** ("MacBook Pro", "Chrome on Windows"), and the reader renames it
whenever they like. The DTO keeps `name` **nullable** rather than defaulting
server-side, so a row nobody named stays distinguishable from one somebody did.

## The copy, and the `en` keys it needs

All under `settings.account.passkeys.*`. Every `en` key needs its `zh` twin
(`tests/i18n-catalog.test.ts`).

`title` · `subtitle` · `add` · `empty.{title,body,promise}` ·
`row.{added,synced,singleDevice}` · `row.{rename,remove}` ·
`registering.{title,body}` ·
`rename.{title,desc,label,helper,cancel,save}` ·
`remove.{title,desc,lastWarning,keep,confirm}` ·
`errors.{previouslyRegistered,challengeExpired}` ·
`method.{name,badge,desc,managedAbove}` · `hero.passkeyCounts`.

**`errors.cancelled` is deliberately ABSENT** — there is no string, because
nothing is shown.

## States drawn, and the one that is NOT

Drawn: **zero** (1) · **populated** (2) · **registering** (3) · **rename** (4) ·
**remove confirm, last passkey** (5) · **the three refusals** (6) · **dark** (7).

**Not drawn, deliberately: the operating system's own passkey sheet.** It is the
browser's surface — we cannot style it, position it or read anything from it — so
panel 3 stands it in with a labelled placeholder. Drawing it would specify a
screen we do not own and cannot change.

**Also not drawn: a "remove ALL passkeys" control.** Nothing asks for one, the
list is short by construction, and a bulk destructive action on credentials is a
surface that deserves its own thought rather than a corner of this one.

## The workflow spec this design is grounded in (the design-content dependency)

This asset invents no behaviour. Each flow it draws is defined by a sibling card,
and the design cites them rather than deciding them:

- **MOTIR-3610** — the plugin, the seven endpoints, the ten `passkey` fields the
  rows render, the 300-second challenge cookie, the 64-character name bound, and
  `userVerification: 'required'`.
- **MOTIR-3611** — the `PasskeyDTO` the list renders, and `'passkey'` in
  `TwoFactorStatusDTO.methods` independent of `enabled`.
- **MOTIR-3612** — the card that BUILDS this surface.
- **MOTIR-3613** — the sign-in affordance, in the other asset.

## How the render was produced

1. The shipped pane was screenshotted first (production build, real session,
   1440×1000 @2x) and the board was composed against that render, not against
   the source.
2. The token block, the `[data-theme='dark']` block, the area shell and every
   control class are copied 1:1 from `two-factor.mock.html`; the passkey rules
   are APPENDED at the end of the style block, never edited into the copy.
3. Every icon is a real lucide path at `viewBox="0 0 24 24"`, read from
   `lucide-react`'s own `dist` — `fingerprint-pattern`, `laptop`, `usb`, `cloud`,
   `plus`.
4. The `.png` is exported with `node scripts/render-design-mock.mjs --width 1200`.

## Self-review

- No nested interactive elements: a passkey row is a row, and the two buttons in
  it are the only focusable things.
- Ink/surface pairs: every caption on `--el-surface` / `--el-muted` /
  `--el-surface-soft` is `--el-text-secondary`; `--el-text-muted` appears only on
  the white card.
- The one destructive control that carries the danger hue as TEXT is the
  confirmation's filled button, where the ink is `--el-danger-text` on an
  `--el-danger` fill — the pairing that token exists for.
- The `Synced` chip carries a glyph and `This device only` does not, and the
  asymmetry is deliberate: the cloud says where else the credential lives, and
  there is no mark for "nowhere else" that would not be inventing a claim.
- No Tier-0 `--color-*` outside the token block; no raw `rounded-*` / `p-*` /
  `h-*` on any control's own box.

---

# Data & privacy — `account-data.mock.html`

**Story 8.4 (MOTIR-657) · Subtask MOTIR-3680.** The account-settings
`Data › Data & privacy` pane: export your data, and delete your account.
**Gates MOTIR-1136** (data-subject-request handling), which was halted at the
design gate by the `motir run MOTIR-657` parent run rather than improvising an
irreversible surface.

**The pane is not a new idea — it is a promise already published.**
`content/legal/privacy.md` §7 says, in the product's own approved words:
_"In your account settings you can export your personal data and request deletion
of your account, without asking anyone."_ That sentence is counsel-reviewed and
live. This asset draws the surface it describes, and its whole job is to answer
the three questions the code card cannot answer for itself: what an export **is**
and how the reader receives it, what deletion does to things the reader does
**not solely own**, and whether it is **immediate**.

## Grounded in shipped reality (rung 2 — what was verified, and where)

| the design assumes                                                    | verified against                                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the area shell, rail, identity header, grouped nav, Card pane grammar | `account-settings.mock.html` / `two-factor.mock.html`, copied 1:1 — not redrawn                                                                                                       |
| neither surface exists yet, so this is a genuinely new door           | `lib/settings/accountSettingsNav.ts` — six entries (profile · language · notifications · appearance · twoFactor · apiTokens), three groups. Neither export nor deletion is among them |
| a new route owes the registry a matching entry                        | `tests/settings/accountSettingsNav.test.ts` — the route↔registry totality assertion, which a new pane satisfies by shipping its entry and its route together                          |
| the danger-zone treatment is not invented here                        | `app/(authed)/settings/workspace/_components/DangerZoneCard.tsx` — `border-2 border-(--el-danger)`, a `--el-danger` header, `Button variant="danger"`, type-to-confirm in a `Modal`   |
| a confirm dialog caps at 90vh and scrolls its body                    | `packages/design-system/src/components/ui/Modal.tsx` — `flex max-h-[90vh] flex-col overflow-hidden`; `Modal.Body` is `flex min-h-0 flex-1 overflow-y-auto`, so head and footer pin    |
| a private file is delivered by a short-lived presigned URL            | `lib/blob/uploader.ts` `signedDownloadUrl` — `ttlSeconds = 300`, a fresh presign per request; `docs/decisions/attachment-access-control.md` §5 pins the same 300 s                    |
| deletion is blocked by the ORG owner guard, not by a workspace role   | `lib/services/organizationsService.ts` `assertNotLastOwner` → `LastOrgOwnerError`                                                                                                     |
| a sole workspace member cannot LEAVE, but any member may DELETE       | `lib/services/workspacesService.ts` `removeMemberInTx` → `LastMemberError` (count ≤ 1); `deleteWorkspace` asserts membership only, never a role                                       |
| 30 days, anonymised contributions, seven-year billing records         | `content/legal/privacy.md` §6 and §7 — the retention table and the rights section, both approved copy                                                                                 |
| a reachable window is a grace period and an unreachable one is not    | `docs/decisions/code-graph-index-fleet.md` §14.3, and `lib/codeGraph/offboarding.ts`'s `isImmediate` / `CODE_GRAPH_RETENTION_WINDOW_DAYS = 30`                                        |

## The ACCESS PATH — a FOURTH rail group, ordered LAST

The pane is reached one way and one way only: **`Data › Data & privacy`** in the
account-settings rail, drawn ACTIVE in panels 1, 4, 5 and 6.

```ts
// ACCOUNT_SETTINGS_NAV_GROUP_ORDER gains a fourth member, at the END:
['general', 'preferences', 'security', 'data']

{ id: 'data', group: 'data', href: '/settings/account/data',
  icon: Database, labelKey: 'data' }
```

**Why a new group rather than an entry appended to `general`.** The rail renders
groups in array order, so an entry appended to `general` lands **second overall**,
directly beneath Profile — an irreversible account action three rows above the
language picker. Every mirror product puts account deletion at the BOTTOM of
account settings, and a fourth group ordered last is the only shape in this
registry that puts it there. It costs one member on a typed union and one i18n
key.

**Why ONE pane for both surfaces rather than two entries.** They are the same
right, exercised two ways, and the Privacy Policy already names a single place
(_"in your account settings"_). Splitting them would put the export behind one
door and the deletion behind another, and a reader who came to leave should meet
the export on the way out — which panel 5 makes literal.

## Panels

| #   | what it draws                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------- |
| 1   | **At rest** — the two cards, and the rail row that is the door                                        |
| 2   | **The export** — preparing · ready · failed, and what the reader actually receives                    |
| 3   | **The confirmation** — the deleted / anonymised / kept ledger, at its real 90vh ceiling, both scrolls |
| 4   | **BLOCKED** — sole owner of a shared organization, with the way out drawn on the pane                 |
| 5   | **Scheduled** — the 30-day grace period, and the two places it can be cancelled                       |
| 6   | **Dark parity** — the pane at rest                                                                    |

## DECISION 1 — what the export IS, which right it serves, and in what format

**It serves BOTH Article 15 (access) and Article 20 (portability), and it can only
do that because of the format.** Art. 20 is the demanding one: it is satisfied
only by _"a structured, commonly used and machine-readable format"_. A PDF or an
HTML page would answer Art. 15 alone and quietly fail the other. So:

- **`motir-export-<date>.zip`**, holding **JSON** for every record and the
  **original uploaded files** under `files/`, which the JSON references by path.
- The pane says which right it serves in the reader's words, not in article
  numbers: _"This is your right of access and your right to portability — one
  file serves both."_ The article numbers belong in the Privacy Policy, which
  already carries them; a settings pane that cites statute at a reader is
  performing compliance rather than doing it.

**Scope**: the user's own account and profile, plus the workspaces they are a
member of, **as far as their access reaches**. That last clause is load-bearing
and is drawn in the copy: an export is not a privilege escalation, and a member
of a shared workspace does not get a copy of things they cannot already read.

## DECISION 2 — how it is DELIVERED, and why the email does not carry the file

**The file is handed over in this pane. The email only says it is ready.**

This is measured, not stylistic. A private object is served through an
authenticated route that 302-redirects to a presigned URL minted per request with
a **300-second** TTL (`signedDownloadUrl` in `lib/blob/uploader.ts`;
`docs/decisions/attachment-access-control.md` §5 pins the same number). **A URL
that dies in five minutes cannot be emailed to a human being** — it would be
expired before most people open their inbox. Any design that mails the link is a
design the storage layer cannot implement.

So the shape is: request → background build → **email notification** → the reader
returns to this pane → **Download** mints a fresh 300 s URL on the click. Panel 2
draws the consequence as copy the reader can act on: _"Each Download makes a
fresh, private link that expires after five minutes."_ The built file is kept
**seven days**, which is what makes returning to the pane a real instruction
rather than a race.

**Art. 12(3) allows one month, extendable by two, and the copy says one month
rather than promising minutes.** The mechanism is a background job and will
usually finish in minutes, but the promise is the legal one; a surface that
promises instant owes instant. Panel 2's failed state routes to
`privacy@motir.co` for exactly the case where the automated path cannot deliver
inside that window.

## DECISION 3 — what deletion MEANS for what the reader does not solely own

**This is the decision the card exists to make, and most of it was already made —
in the Privacy Policy, which is approved, published, and binding.** The
confirmation is therefore a LEDGER with three groups, and each group's membership
follows from a source rather than from taste.

### Deleted — what is yours alone

Your profile, credentials, passkeys, two-factor enrolment and API tokens; **every
workspace where you are the only member**, with the projects and work items
inside them; and **every personal-data export you asked for, with the archive
each one built**.

**Why the archive is a member, and why the enumeration had to be reopened to say
so (MOTIR-3732 → MOTIR-3747 → MOTIR-3754).** This group's membership is not a
list somebody wrote down — like the other two, it follows from a SOURCE, and its
source is _what the erasure sweep actually deletes_. **That source widened after
this asset was authored**: MOTIR-3732 made erasure remove every export request
and the file it built, and MOTIR-3747 added the row to the shipped ledger. An
enumeration that follows from a source is only correct while the source holds
still, so **widening what erasure REACHES is also a change to what the design of
record DRAWS** — and this group is the one place a reader is told what deletion
means.

The archive is also the member that can least afford to be missing. It is the one
artefact that is a complete copy of everything the account held, and DECISION 2
deliberately routes the reader PAST the export on the way to this dialog — so a
ledger that names credentials and workspaces and stays silent about it omits the
largest thing it is about to destroy. The row is **hidden at zero**, the same rule
the workspace rows follow (the ledger states what deletion reaches, and a reader
who never asked for an archive loses none), and its copy names the **archive**
rather than promising a download exists: a `preparing` / `failed` / `expired`
request carries no file.

**Why whole workspaces go with the account, and why that is a CHOICE rather than
a block.** `removeMemberInTx` throws `LastMemberError` when the membership count
is ≤ 1 — the last member of a workspace cannot LEAVE it. But `deleteWorkspace`
asserts membership only and checks no role, so that same person may delete it
outright. A sole-membership workspace therefore has exactly two futures: it goes
with the account, or the reader invites somebody to it first. **The ledger names
the workspaces and states the escape** (_"To keep one, invite somebody to it
first"_) instead of discovering it at submit.

### Anonymised, not deleted — what is part of someone else's project

Comments the reader wrote in projects other people share, and work items they
reported or were assigned there. **The name is removed; the row stays.**

**The Privacy Policy already decided this**, §6: _"If you posted a request or a
comment on someone else's public project, deleting your account does not simply
erase it, because it is part of a conversation others took part in. We anonymise
your contributions — your name is removed — rather than deleting the thread around
them."_

**This design extends that from comments to work-item attribution, and says so
rather than assuming it.** The policy's sentence names contributions to a public
project; a work item reported inside a shared workspace is the same shape — a
row the team depends on, carrying a person's name — and the same answer follows:
the item belongs to the project, the attribution belongs to the person, so the
attribution goes and the item stays. Deleting a colleague's backlog because its
reporter closed their account is not erasure, it is data loss for a third party.
**The Privacy Policy's §6 wording is narrower than this behaviour and should be
widened to match when it is next revised** — flagged here rather than quietly
relied upon, because the copy is counsel-approved and this asset does not get to
amend it. The pane's own copy stays inside what §6 already says.

### Kept — what erasure does not reach

Invoices and tax records, for as long as Dutch tax and accounting law requires
(§6: _"generally seven years"_); and data still present in a backup, until the
backup rotates (§6: _"Data present only in a backup is not restored to active
use"_).

**Article 17 erasure is not absolute, and a confirmation that implies otherwise is
a false statement on a consent surface.** The ledger names the exception in the
reader's words — _"Erasure does not reach a record we are obliged to hold"_ —
rather than burying it or omitting it. This is the one place where saying less
would have been the more dangerous choice.

## DECISION 4 — a 30-day grace period, because here the window is REACHABLE

**Deletion schedules; it does not fire.** Confirming signs every device out — so
the account is closed as far as any open session is concerned — and the erasure
runs 30 days later. **Signing back in during those 30 days does NOT cancel it:
the reader lands on the app-wide banner and cancels from there, or from this
pane.** Both doors are one press, with no second confirmation.

~~Signing in before then cancels it.~~ **AMENDED 2026-08-28 (MOTIR-3742), struck
on the record rather than deleted, because it was built from and cited by five
files across the auth seam, the service, the banner and this asset.** That
auto-cancel shipped (MOTIR-3700, on
`session.create.after`) and it contradicted the day-nine paragraph below, which
is this decision's own argument for the banner: scheduling revokes every
session, so the reader's next act is a sign-in — and an auto-cancel there took
the deletion back **before any page rendered**, leaving both drawn doors
reachable only when that cancel had thrown. It also revoked, silently, the
deletion of anyone who signed in once to collect the export MOTIR-3703 delivers
through an authenticated download. The hook is removed;
`docs/decisions/account-deletion-cancel-path.md` carries the decision, the
rejected alternative, and what the placement argument is replaced by.

**The product already holds the doctrine that decides this.**
`docs/decisions/code-graph-index-fleet.md` §14.3 gives a workspace hard-delete
**no** window, and states why: _"A grace period the user cannot reach is not a
grace period."_ A workspace delete cascades away every surface a user could undo
into, so a window there would only extend retention.

**An account deletion is the mirror case: the reader can get BACK to a surface to
undo into.** Their own credentials survive until the erasure runs, so signing in
is the way back to the window — it is not itself the undo. So the same doctrine
that refuses a window there requires one here —
and the number is not invented: `content/legal/privacy.md` §6 already promises
_"we erase or anonymise within 30 days"_, and
`CODE_GRAPH_RETENTION_WINDOW_DAYS = 30` is the constant the product already
interpolates into user-facing copy for exactly this reason (_"so the promise and
the behaviour cannot drift"_). **The 30-day window IS the published promise, read
as the deadline it is** — the erasure runs at day 30, which is within 30 days.
The build card must interpolate a constant, never retype the number.

**And a grace period is only reachable if the reader can find it.** Panel 5
therefore draws **two** doors: this pane, and an **app-wide banner on every page**
carrying the date and a `Cancel deletion` action. A reader who changes their mind
on day nine will not think to navigate to Settings › Data & privacy to do it, and
a window they cannot find is the same as no window — which is the §14.3 test,
applied to its own mirror case. **These two are the ONLY doors, and that is what
the amendment above buys**: the banner is mounted once in the authed layout, so
it is on every page the reader lands on whichever way they signed in, and panel 5
draws the state the product is actually in for all 30 days rather than one it
reached by erroring.

**What a reader sees, in order.** Confirm → signed out, on `/sign-in` → sign back
in whenever they like → every page carries the banner with the date and
`Cancel deletion` → they press it, or day 30 arrives and the erasure runs. The
account is **scheduled**, not suspended: until the erasure they sign in, their
workspaces are open, and their team sees no difference, which is what panel 5's
own copy says.

## DECISION 5 — the BLOCKED case is the ORGANIZATION, and it is drawn at rest

**The card asked for the sole-admin-workspace case. The shipped code says the
blocking tier is the organization, and the measurement changes the design.**

| tier         | guard                                                        | effect on account deletion                        |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------- |
| organization | `assertNotLastOwner` → `LastOrgOwnerError` (owner count ≤ 1) | **HARD BLOCK.** The membership cannot be removed  |
| workspace    | `removeMemberInTx` → `LastMemberError` (member count ≤ 1)    | **NOT a block** — a choice, handled in the ledger |

An organization is where billing and cross-workspace administration live, and the
guard exists so an org can never drop to zero owners. A reader who is the only
owner of an org that other people belong to genuinely cannot be removed from it,
and no confirmation copy can talk its way past that.

**So the block is rendered on the pane at rest, with the Delete button disabled
and the way out drawn beside it** — the organization named, its member count
shown, and a control that goes straight to `Organization › Members` where the
owner role is handed over. The reader never types an email address into a form
that was always going to refuse. **A blocked state discovered at submit is a
design defect, not an error message**, and it is the specific failure this card
named.

## What this design does NOT decide, and who owns it

- **Account deletion is a FIFTH offboarding trigger, and §14.3 enumerates four.**
  `docs/decisions/code-graph-index-fleet.md` §14.3's table has
  `repo_disconnected` · `connection_disconnected` · `project_archived` ·
  `workspace_deleted`, and `CodeGraphOffboardReason` in
  `lib/codeGraph/offboarding.ts` is that same closed set. An account deletion that
  cascades a workspace away must feed the offboarding queue, or the derived code
  graphs become the unreferenced orphans §14 exists to prevent. **If the erasure
  reaches workspaces by calling `workspacesService.deleteWorkspace`, the existing
  `workspace_deleted` arm already fires and nothing is owed**; if it deletes rows
  by another path, a new reason is. **This is a build-time obligation on
  MOTIR-1136, recorded on that card as a comment, not left as a parenthetical
  here.**
- **The impact COUNTS are a backend read, and they are the second capability this
  surface needs.** The ledger renders _"2 workspaces · 12 projects · 1,483 work
  items · 3 data exports · 214 comments · 96 work items"_, and a destructive flow
  always has two
  distinct backend capabilities — the **preview/impact read** and the
  **do-the-action write**. MOTIR-1136 owns both; the numbers are not decoration
  and the preview is not free.
- **The export's contents are a schema question**, not a layout one. This asset
  fixes the format (JSON + files in a zip) and the scope rule (as far as the
  reader's access reaches); which tables are in it is MOTIR-1136's to enumerate.

## Token / a11y rules honoured

- **Colour via `--el-*` only.** No Tier-0 `--color-*`, no raw hex, no `rgb()`.
  Verified mechanically: the render sweep reports **0** inline styles carrying a
  hex or `rgb()` value.
- **AA measured across every text node, in BOTH themes — 0 failures.** Not
  eyeballed; the sweep is reproduced below. Two failures were found and fixed:
  - **`.me .em` (the rail's email) was `--el-text-muted` at 4.17:1** on
    `--el-sidebar-bg` — the documented sidebar trap. Raised to
    `--el-text-secondary`. ~~⚠️ **Six sibling assets in this folder carry the
    original** (`account-settings` · `profile` · `two-factor` · `passkeys` ·
    `appearance` · `token-scopes`); that is a pre-existing defect filed as its own
    bug, deliberately **not** half-fixed here.~~
    **DISCHARGED, and the enumeration was wrong (MOTIR-3693).** That bug fixed
    the GUARD first and then let the guard count: muted ink on `--el-sidebar-bg`
    stood on **18 assets across 9 areas**, not six in this folder. **This asset
    was one of them** — not for `.me .em`, which was already
    `--el-text-secondary`, but for its 24 rail glyph slots, which the sweep below
    could not see either: `--el-sidebar-bg` was on neither ink guard's list of
    tinted surfaces, so _"0 failures"_ meant 0 failures the guard could see on a
    surface it was not measuring. `TINTED_SURFACE_TOKENS` is now derived from
    `theme.css` and asserted total there, all 18 assets are swept, and the rail
    glyphs carry `aria-hidden` exactly as the shipped `Sidebar` does.
  - **`--el-danger` as the danger-card heading is 4.51:1 in light and 4.25:1 in
    dark** — it clears AA for normal text in one theme and misses it in the other,
    and the base dark block does not flip `--color-destructive`. So the heading is
    `--el-danger` in light and drops to `--el-text` in dark, and **the danger
    signal is carried by the 2 px border and the trash glyph**, which need only
    the 3:1 graphics bar and clear it at 4.25.
- **`--el-danger-text` appears exactly once, on the solid danger button**, where
  it sits ON the `--el-danger` fill. That is the only pairing the token is correct
  for; as ink on a surface it renders white-on-white.
- **The destructive entry is the shipped solid `Button variant="danger"`**, not a
  ghost with red label text — which also removes the dark-theme AA problem a red
  label would have carried.
- **State is never colour alone**: every pill carries a glyph, the blocked state
  carries an "Action needed" pill AND a warn callout AND a disabled control.
- **The dark panel carries `data-appearance-scope` beside `data-theme="dark"`**
  and declares `color` ON the panel — without both, `--el-*` is not re-emitted on
  the subtree and headings that only inherit their ink render near-black on
  near-black.

## The confirm dialog is drawn at its REAL ceiling, not expanded to fit

`contentVariants` caps a modal at `max-h-[90vh]`, `Modal.Body` scrolls, and the
head and footer are pinned by the flex column rather than by a bespoke sticky
rule. **On the 1366×768 laptop floor that is 691 px**, and the ledger does not
fit — so panel 3 draws it **cut off at the fold**, twice: as it opens, and
scrolled to the end. Raising the cap to show every row at once would draw a
dialog the product cannot render.

**That cut is a property worth keeping, not a problem to design away.** The
type-to-confirm field sits at the BOTTOM of the scroll, so the confirm button
cannot be reached without travelling past the facts — the exact discipline a
destructive confirmation wants, and the reason a pinned footer is safe here where
it would not be on a full-page approval screen. `size="lg"` (32 rem) rather than
the shipped delete modal's `md`: the ledger needs the width, and the next size up
is the 58 rem peek surface, which is not a confirmation dialog.

## Primitives composed (no hand-rolling)

`Card` (+ the danger variant's border/header treatment) · `Button`
(primary / secondary / ghost / **danger**, `btn-sm`) · `Modal` + `Modal.Body` +
`Modal.Footer` · `Input` / `FormField` (label + helper) · `Pill`
(mint / sky / peach / rose) · the callout (info / warn / danger) · `SidebarNav` +
`SidebarSection` rows · the `.srow` settings-row grammar from the shipped Language
and Profile panes. Icons are lucide, and the nine this pane adds
(`database` · `users` · `message-square` · `receipt` · `square-kanban` ·
`building-2` · `hourglass` · `user-x` · `file-archive`) are emitted from
`lucide-react`'s own `__iconNode` rather than drawn by hand.

## i18n

One namespace, `settings.account.data.*`: `nav` · `title` · `subtitle` ·
`export.{title,subtitle,cta,what.*,format,window,preparing,ready,failed,download,expiry,retention}` ·
`delete.{title,subtitle,cta}` ·
`delete.confirm.{title,body,typeLabel,helper,button}` ·
`delete.ledger.{deleted,anonymised,kept}` + one key per row ·
`delete.grace.{title,body,cancel,daysLeft}` ·
`delete.blocked.{title,body,orgRow,manageMembers,disabledReason}` ·
`banner.{scheduled,cancel}` · `mailbox`. Every `en` key needs its `zh` twin
(`tests/i18n-catalog.test.ts`).

## Build dependency (for MOTIR-1136)

1. **Registry + route together.** Add `'data'` to
   `ACCOUNT_SETTINGS_NAV_GROUP_ORDER` and the entry above to
   `ACCOUNT_SETTINGS_NAV`, and land `app/(authed)/settings/account/data/page.tsx`
   in the same commit — that keeps `tests/settings/accountSettingsNav.test.ts`
   green by construction, the same move 7.8.3, 7.3.58 and 8.11 each made.
2. **Two backend capabilities, not one**: the **impact preview** read that
   produces the ledger's counts, and the **schedule / cancel** write. Plus the
   export request, its background build, and the notification.
3. **Interpolate the window**, never retype `30`.
4. **The block is `assertNotLastOwner`'s answer, read BEFORE rendering the
   button** — the pane asks whether deletion is possible and renders panel 4's
   state when it is not; it does not call delete and catch `LastOrgOwnerError`.
5. **The erasure is a scheduled sweep**, and the offboarding obligation above is
   part of it.

## How the render was produced

Reproduced inline rather than cited by path — the harness is a throwaway that
does not survive the commit, and a design asset naming a file that does not exist
sends the next reader looking for nothing.

The token block, the dark block and the 29 shared icon defs are **extracted from
`two-factor.mock.html`**, never retyped; the nine added icons are generated from
`lucide-react`'s `__iconNode`:

```py
# ⚠️ collapse whitespace BEFORE matching: lucide wraps a long `d` across lines,
# and a single-line regex silently DROPS those nodes — which renders a plausible
# but wrong glyph (the hourglass came out as two horizontal strokes).
body = re.sub(r'\s+', ' ', iconNodeBlock)
re.findall(r'\[ ?"([a-z]+)", \{ (.*?) \} ?\]', body)
```

Every generated icon was then checked against its source by node count
(`key: "` occurrences in the `.mjs` versus emitted elements in the `<g>`), and
every `href="#i-*"` in the finished mock was checked to resolve to a def —
a referenced-but-undefined icon renders an empty box and is invisible in review.

The PNG is exported with the repo's own
`node scripts/render-design-mock.mjs --width 1200`, run **after**
`prettier --write` (prettier reformats the markup, so a PNG rendered from the
pre-format source is not an export of what lands).

The AA sweep walks every element holding a text node, resolves the nearest opaque
ancestor background, computes the WCAG ratio and compares it against 4.5:1
(3:1 for large text), once with `data-theme="light"` and once with
`data-theme="dark"` on the root — excluding the panel that is authored dark, so
each pass measures the theme under test.

## GIVES / TAKES

**GIVES** — to **MOTIR-1136**: the rail entry and route, the ledger's three groups
and their sources, the delivery mechanism and its 300 s constraint, the 30-day
schedule-and-cancel model, the blocked-state read, and the offboarding obligation.

**TAKES** — from `account-settings.mock.html` (the area shell), `two-factor.mock.html`
(the token block, the icon defs, the settings-row and modal grammar), the shipped
`DangerZoneCard` (the danger-zone treatment and type-to-confirm), and
`content/legal/privacy.md` (every retention and anonymisation promise the copy
makes).

**TAKES NOTHING FROM, AND GIVES NOTHING TO, `design/epic-privacy/`** — that area
is Story 6.14's public-project privacy filter and is unrelated despite the name.

---

# `Git accounts` — a personal credential, on the ACCOUNT surface (Story MOTIR-4669 · subtask MOTIR-4675)

**2026-09-05.** `account-settings.mock.html` **Panels 9–10.** Every other card in MOTIR-4669 moves
something UP a tier — the repository and its connection go from the workspace to the ORGANISATION.
**This one moves something DOWN**, and it is the piece most likely to be lost in the shuffle,
because it is small and because it currently lives on the same page as the thing being moved up.

`GithubIdentity` is `userId @unique`. It is a **personal credential** — it has never belonged to a
workspace, and `projectSettingsNav.ts` already calls connecting it _"the one action nobody can take
on [a member's] behalf."_ It belongs beside tokens and passkeys, and it is the only part of the git
surface that is not an organisation's.

## ⚠️ What this pane is NOT

**No repository list. No installation lifecycle.** Those are the organisation's —
`Settings → Organisation → Git`, drawn by **MOTIR-4672** (`design/github/` Panel 6). A pane here
showing _"repositories you can see"_ would re-introduce the tier confusion this story removes: the
member's credential and the organisation's grant are two independent things, and the shipped connect
page already says so.

## The nav row — where it goes, and by which convention

**Security group, THIRD — after `Two-factor` and `API tokens`.**

The convention was read from **`lib/settings/accountSettingsNav.ts`**, the registry that drives the
rail, the command palette and the route-totality test. Two things in it decide the placement:

1. **The group.** `Git accounts` is a credential, and the registry's `security` group is where
   credentials live (`twoFactor`, `apiTokens`). It is not a preference and it is not data.
2. **The order within the group**, which the registry states as its own rule: entries render in
   declaration order, and `twoFactor` is first _"above API tokens: … a second factor is the more
   consequential of the two things this group holds."_ Extending that ordering: a second factor
   **protects the account**; an API token **acts as you inside Motir**; a git identity grants Motir
   nothing about your account at all. Third.

**Glyph:** `GitBranch` — the same glyph the org's `Git` row carries (MOTIR-4673). Two rows in two
different navigations, deliberately of one family: a reader who has seen one recognises the other as
_the git surface_, at the tier they are standing on. **Label:** `Git accounts`, plural and
account-scoped, so it cannot be misread as the organisation's `Git`.

**⚠️ Panels 1–3's rail is a POINT-IN-TIME RECORD and is not amended.** It draws
`Profile (Soon) · Language · Notifications · Appearance (Soon) · API tokens`. The product has since
lit every reserved slot (the reservation mechanism is itself retired) and added `Two-factor` and a
fourth `Data` group. Bringing those panels up to date is a change to what they record and is not
this card's work — **but the new row is not drawn into them either**, because a row placed by a
convention read off a stale rail is placed by nothing. Hence Panel 9, drawn from the registry.

## The four states (Panel 9 · Panel 10)

| state                                  | drawn                      | what it says                                                                                                                     |
| -------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **connected**                          | Panel 9, in the area shell | the login, the host, the date, a mint `Connected` pill, and `Disconnect`                                                         |
| **none connected**                     | Panel 10 · A               | one sentence of what connecting is for and what it grants (_public profile only, no access to any code_), and one primary action |
| **revoked / needs re-auth**            | Panel 10 · B               | a danger notice + the row kept, with a peach `Needs re-auth` pill and `Reconnect`                                                |
| **connected, org has no installation** | Panel 10 · C               | **a complete, working state** — see below                                                                                        |

**Three of the four are failure or partial states the product already produces and no asset has ever
drawn**, so today they are rendered by whoever gets there first. That is the reason this card is
worth its points: the pane is small, and the states are the work.

### ⚠️ State C is the one an implementer would otherwise improvise as an error

**The two grants are INDEPENDENT** — the shipped connect page says so in as many words — so an
identity with no installation is **valid**. It is drawn as a quiet fact on a neutral surface:

- **NOT as a warning.** Nothing is wrong, and nothing is pending.
- **NOT as a call to action.** Connecting the organisation is an **org-admin** act. A member sent to
  do it is sent to a door that will not open for them, which is worse than saying nothing.

**The revoked state (B) is the opposite**, and the two are drawn differently on purpose: something
_is_ wrong, the member _can_ fix it, so it takes a danger notice and a primary `Reconnect`.

## Primitives — composed, not specified

| Element            | Primitive                                                             | Notes                                                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The pane           | the shipped account-settings area shell                               | rail + content, unchanged                                                                                                                                                                                                                                                                             |
| The account row    | `Card` + a flex row                                                   | login, caption, state pill, action                                                                                                                                                                                                                                                                    |
| State pills        | `Pill` on existing axes                                               | `Connected` = success/mint · `Needs re-auth` = warning/peach. No new tone                                                                                                                                                                                                                             |
| **`Disconnect`**   | **the shipped `DisconnectButton` treatment, verbatim**                | the `ghost` Button variant with `--el-danger` ink on an `--el-border` border, hovering to `--el-danger-surface`. The Button primitive has **no** danger-ghost variant, which is why that composition exists in the app; drawing a fourth version of it here would be a new treatment nobody asked for |
| `Connect …`        | `Button` `primary` (empty state) / `secondary` (adding a second host) |                                                                                                                                                                                                                                                                                                       |
| The re-auth notice | the shipped danger-callout shape                                      | left rule + tinted surface, as `NeedsAccessPanel` already renders                                                                                                                                                                                                                                     |

**No new design-system entry.**

## Token roles

| Element                     | Colour role                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Row login · caption         | `--el-text` · `--el-text-secondary`                                                                          |
| Host avatar disc            | `--el-muted` fill, glyph `--el-text-secondary`                                                               |
| `Connected` pill            | `--el-tint-mint` + `--el-text-strong`                                                                        |
| `Needs re-auth` pill        | `--el-tint-peach` + `--el-text-strong`                                                                       |
| `Disconnect`                | text `--el-danger` · border `--el-border` · hover `--el-danger-surface`                                      |
| Re-auth notice              | `--el-danger-surface` + left rule `--el-danger`, body `--el-text-strong`, **glyph `--el-danger-on-surface`** |
| The two-grants note (C)     | `--el-surface-soft` + `--el-border`, body `--el-text-secondary`, glyph `--el-icon-muted`                     |
| State labels (board chrome) | `--el-text-eyebrow`                                                                                          |

**⚠️ Danger ink on a page surface is `--el-danger-on-surface`, never `--el-danger-text`.** That
token is the ink FOR a danger FILL and measures 1.00–1.04:1 painted on a light page in all ten
palettes; its one correct use in the tree is `Button`'s danger variant. **Five tokens this asset did
not declare were added to its own token block**, verbatim from
`packages/design-system/theme.css`: `--el-danger-on-surface`, `--el-danger-surface`,
`--el-text-eyebrow`, `--el-icon-muted`, `--el-chip-bg` / `--el-chip-border`. An `--el-*` name a mock
does not declare resolves to nothing, which is the failure `tests/design-token-layer.test.ts` exists
to catch.

## Explicitly OUT of scope here

- **The organisation's repository inventory, its index states and its disconnect dialog** —
  **MOTIR-4672**, `design/github/` + `design/gitlab/`. Cited, described nowhere.
- **The org menu's own `Git` row** — **MOTIR-4673**, `design/org-admin/`.
- **The project's `Add repository` picker** — **MOTIR-4674**, `design/repository-set/`.
- **The OAuth round trip itself**, and where the callback returns to — a code card
  (`the callback returns to the surface that STARTED the flow`), not a drawing.
- **Bringing Panels 1–3's rail up to date** — a change to what those panels record.

---

# The workspace-settings AREA (MOTIR-4843 · MOTIR-4844)

`workspace-settings.mock.html` / `.png` is **the design of record for the workspace-settings area**:
its rail, its registry, both arms of the reveal threshold, and the switcher row that is its door. It
**gates MOTIR-4846** (the registry, the area layout and `SidebarNav`'s fourth branch) and
**MOTIR-4847** (the entrance moving into the workspace switcher).

Motir has **four settings tiers**, and this is the fourth and last to get an area. `settings/project/`,
`settings/account/` and — since **MOTIR-4710** — `settings/organization/` each have an area
`layout.tsx`, a nav registry in `lib/settings/`, and a `SidebarNav` branch that swaps the rail.
`settings/workspace/` has none of the three: its three routes appear as loose rows scattered through
the rail's no-project bottom section, and the surface's own door is a row labelled
`Workspace settings` inside the ACCOUNT menu — a workspace-tier destination filed under the user
tier, one line under `Account settings`.

**The model of record is `design/org-admin/org-admin.mock.html` panels 7a–7d (MOTIR-4673)**, which
drew the same move one tier up. This asset is that composition applied to the workspace, plus the one
thing the organisation does not have: **a reveal threshold**.

## The registry (Panel 7)

A sibling of `lib/settings/organizationSettingsNav.ts` and `lib/settings/accountSettingsNav.ts`, with
the same `{ id, group, href, icon, labelKey, exact? }` entry shape and the same group-order
discipline.

| group        | id          | route                             | glyph         | who sees the row                        |
| ------------ | ----------- | --------------------------------- | ------------- | --------------------------------------- |
| `general`    | `workspace` | `/settings/workspace` (**exact**) | `Boxes`       | any workspace member, **at the reveal** |
| `access`     | `security`  | `/settings/workspace/security`    | `ShieldCheck` | any workspace member, **at the reveal** |
| `operations` | `jobs`      | `/settings/workspace/jobs`        | `ListChecks`  | any workspace member, **at the reveal** |

**ONE filter axis, `revealedOnly`, it DEFAULTS CLOSED, and it applies UNIFORMLY to all three rows.**
The organisation registry has two (what the actor HOLDS, what the BUILD has); this tier has neither —
every route here is membership-gated with no role above it, and none is cloud-only. What it has
instead is the threshold, so the axis is the reveal. It defaults closed for the reason its two
siblings default closed: a surface that forgets to thread it drops the row rather than offering a
door onto a route that `notFound()`s.

> **⚠️ THE THIRD ROW USED TO BE AN EXCEPTION, AND THE EXCEPTION IS RETIRED.** Said here rather than
> silently corrected, because a reader who knows the old behaviour needs to see it was REMOVED and
> not overlooked. `/settings/workspace/jobs` answered **200 at every workspace count** while its two
> siblings `notFound()`ed, and that was written into MOTIR-3502 AC 6 as a property of the route.
>
> **It was an UNFINISHED COLLAPSE, not a decision.** `WorkspaceFoldInSection` folds in Name, Members,
> `RequireTwoFactorCard` and Danger zone; the jobs dashboard is the one workspace-tier capability
> nobody ever gave a fold-in, so it kept answering because hiding it would have stranded it. The
> FOLD-IN card (MOTIR-4861) builds that section, this row becomes reveal-gated like its siblings, and
> the axis stops carrying a carve-out.
>
> **What that buys is Panel 4**: with no exception left, below the reveal there is no workspace rail
> at all, and §6d is satisfied by RELOCATION rather than by an exempted route. MOTIR-4859 is the
> planning bug for the shape.

**The index row is called `Workspace`, not `Settings`** — the word the switcher's own row uses for
the same route. Inside a settings area a row named "Settings" names its own container; the
organisation rail has the same row and calls it `Organisation`, the project rail calls it `Details`.
The SWITCHER keeps its word: it is outside the area, where "Workspace settings" is what the
destination IS.

### The glyphs — two carried, one chosen

**`security` and `jobs` are CARRIED, not chosen.** Read out of
`app/(authed)/_components/SidebarNav.tsx`'s bottom section, where those two rows render
`<ShieldCheck />` and `<ListChecks />` today, quoted from the file:

```tsx
{ icon: <ShieldCheck />, label: t('nav.security'),  href: '/settings/workspace/security', … }
{ icon: <ListChecks />, label: t('nav.jobRuns'),   href: '/settings/workspace/jobs',     … }
```

Two doors onto one room that disagree about its icon are two rooms.

**`workspace` is this asset's own choice, and it is `Boxes`:** a workspace is the CONTAINER its
projects and teammates live in, so its glyph is a set of things held together — where `Building2`
(taken by the organisation in `organizationSettingsNav.ts`, and forbidden here for exactly that
reason) is the company itself. Stated because the family resemblance is real and deliberate rather
than accidental: the project rail's `components` row carries the singular `Box`, one tier down, in a
rail that never renders beside this one. `Boxes` is otherwise unused anywhere in `app/`,
`components/` or `lib/`.

### The group names

`general` and `access` mirror the organisation's. **The third is `operations`**, and the name is a
decision: `Job runs` configures nothing and gates nobody — it is where you look when something did
not happen — so it is neither of the other two. It gets its own group rather than being filed under
`general` because **a group whose rows all filter away is not rendered** (no empty heading, no
disabled row — `groupOrganizationSettingsNav`'s existing behaviour), which is exactly what Panel 4
needs to be true in reverse: at one workspace `operations` is the ONLY group that survives, and a
third group is what makes that arm cost nothing.

## The rail HEAD — it follows the ORGANISATION's shape, not the project's

Three heads exist: `SettingsSidebarHeader` (the project — a `ProjectSwitcher`),
`AccountSidebarHeader` (the user — a static identity) and `OrganizationSidebarHeader` (the
organisation — a static identity). The constant across all three is what the head NAMES: the tenant
the area configures.

**This one is STATIC, i.e. the organisation's shape.** The workspace HAS a switcher, so the project's
shape was available and is declined: a switcher in a settings rail would let you change WHICH
workspace you are configuring from inside the pane, and switching a workspace re-points the active
project and navigates away (`afterContextSwitchTarget`) — a context switch buried in a configuration
surface. The switcher stays in the top bar, where it already is and where Panel 5 draws it.

**Panel 4 draws the ORGANISATION's rail head, not the workspace's** — its own tile
(`--el-tint-lavender`) and its own `Building2` glyph, because below the reveal that is the rail a
reader is actually standing in. Stated because the two heads are one composition apart and drawing
the org's with the workspace's hue or glyph would contradict the paragraph directly below, inside the
same asset.

Composition, mirroring `OrganizationSidebarHeader.tsx`: a `← Back to Motir` link (the href is
`AUTHED_LANDING_PATH`, imported and never retyped — `tests/components/rail-head-back-link.test.tsx`
is the guard), the workspace's initial tile + name, and a `Workspace settings` eyebrow. The TILE is a
**square** with `--radius-control`, matching the organisation's: the circle is this product's PERSON
grammar (avatars, the `UserMenu`), and a workspace is not a person. Its fill is `--el-tint-sky` where
the organisation's is `--el-tint-lavender`, so the two tiers are told apart by hue at a glance when a
reader moves between the two rails; the ink on both is `--el-text-strong`, which is the AA-safe
pairing on a tint in both themes.

## ⚠️ THE REVEAL IS THE HARD EDGE, AND §6d GOVERNS IT (Panel 4)

Below two workspaces there is no workspace switcher, so there is no door — which is correct, because
below the reveal there is no room either. **ALL THREE `/settings/workspace/*` routes `notFound()`
there, and there is NO WORKSPACE RAIL AT ALL.** Panel 4 draws `/settings/organization` instead,
because that is where every one of the tier's capabilities lives at one workspace:
`WorkspaceFoldInSection`'s Name / Members / require-2FA / Danger zone, plus the **`Job runs` section
the FOLD-IN card (MOTIR-4861) adds**.

**`/settings/workspace/jobs` used to be the exception**, answering 200 at every workspace count
(MOTIR-3502 AC 6, and `SidebarNav.tsx`'s own comment said so) because it is workspace-SCOPED but not
workspace-NAMED, so §6's reveal left it alone.

**That was an UNFINISHED COLLAPSE rather than a decision.** It was the only workspace-tier surface
with no fold-in, so hiding it would have stranded its capability, and it kept answering for want of
anywhere to go. Giving it the fold-in retires the exception, and
`docs/decisions/organization-tier.md` §6d — _a hidden tier may not remove a capability … relocating a
surface preserves its gate_ — is then satisfied by **RELOCATION**, which is what the rule asks for.

**Nothing is stranded on that side.** Name, Members, **Leave workspace**, the require-2FA policy and
the job-runs dashboard are all reachable at `/settings/organization` for a plain org member who is a
workspace member (§6d's table, and `leaveWorkspaceAction`'s single consumer).

**And the rail's bottom section keeps NEITHER workspace row** — MOTIR-4845 removes both, on the
assets that own that section. A workspace-tier row inside the PROJECT rail is the tenancy mismatch
MOTIR-4640 removed for the `Git` row a week earlier, and keeping one in order to satisfy §6d was the
first shape of this story getting the rule right and the repair wrong. The planning bug is
MOTIR-4859; the general form is a global lesson — _a hiding rule owes every capability a RELOCATION,
and a surface exempted from it because it still answers is the tell that one is missing._

## THE ACCESS PATH — the switcher row (Panel 5)

The design gate requires the entry affordance drawn in its parent surface, and this asset owns that
decision: the row's label, its glyph and its position.

**The popover is `WorkspaceSwitcher.tsx`'s, unchanged** — a 320px `Popover.Content`, the `WORKSPACES`
mono-caps heading, one row per membership with a `Check` on the active one and a neutral role `Pill`,
then `Create workspace` and `Invite teammates` behind dividers (the composition
`design/workspaces/design-notes.md` § _Workspace switcher_ records). Only the `Workspace settings`
row is new.

**WHERE IT SITS: in the LAST group, ABOVE `Invite teammates`.** The three groups answer three
different questions — _which workspace am I in_, _make a new one_, and _act on THIS one_ — and both
of the last group's rows are about the active workspace. Settings goes first because
`Invite teammates` already points **into** it (`/settings/workspace#members`): the general door above
the shortcut through it, never the other way round.

**WHY THE `Settings` GEAR.** It is the glyph the account menu's `Workspace settings` row carries
today (`UserMenu.tsx`) and the one the rail's bottom `Settings` row carries, so the departure and the
arrival read as one move rather than as two rows — the same argument MOTIR-4673 made for keeping
`GitBranch` when the `Git` row changed tier.

**Below the reveal this panel does not exist**, and none is owed: there is no switcher at one
workspace, and the two rooms this row opens onto `notFound()` there. Panel 4 is the arm that matters,
and the row it depends on is in the rail, not in this popover.

## ⚠️ COMPOSED, not redrawn — the three panes and their owners

Every pane already has an owner and this asset re-specifies none of them. It draws the **frame**:

| pane                                          | drawn by                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| the index page's Name / Members / Danger zone | `design/workspaces/settings.pen` / `settings.png`                          |
| the require-2FA policy card                   | `design/org-admin/security-policy.mock.html` (MOTIR-3642 — for BOTH tiers) |
| the background-jobs dashboard                 | `design/jobs/`                                                             |

**Nothing moves.** The three existing sub-routes become rows and the index becomes the `Workspace`
row; no page's content changes. `Members` in particular stays a card ON the index page — giving it a
route of its own is a different deliverable (a route move, a redirect, and the
`WorkspaceFoldInSection` host that renders the same card below the reveal), and this story neither
performs it nor depends on it.

## Where it lives

- **This asset:** `design/settings/workspace-settings.mock.html` + `workspace-settings.png`, and this
  section. It owns the area rail, its registry, the rail head, both reveal arms, and the switcher
  row's label / glyph / position.
- **NOT this asset — `design/shell/account-menu.mock.html` and
  `design/shell/rail-bottom-section.mock.html` are the SIBLING card MOTIR-4845's.** The account menu
  losing its `Workspace settings` row, and the rail's bottom section losing `Security` while KEEPING
  `Job runs`, are amendments to the shell's own design of record, which has its own notes, its own
  asset inventory and its own address guard. This asset draws the switcher row (Panel 5) because that
  is the door to the room it draws; it touches neither shell asset.
- **NOT this asset — `design/workspaces/design-notes.md` § _Workspace switcher_** gains its
  `Workspace settings` entry from MOTIR-4845 too, pointing at Panel 5 here as the drawing of record.
  This asset DRAWS the row; that note RECORDS it.

## How the render was produced

Hand-authored HTML against `app/globals.css`'s token block, carried verbatim from
`design/org-admin/org-admin.mock.html` so two assets drawing one rail cannot draw it differently —
every `.shell` rule is that asset's panel-7 block, which is itself
`design/settings/account-settings.mock.html`'s drawing of the shipped `Sidebar` / `SidebarSection` /
`SidebarNavItem`. Every glyph is a real `lucide-react` `__iconNode` path read out of the installed
package rather than drawn.

**The Tier-3 `--el-*` layer is declared on `:root, [data-appearance-scope]`**, which is
`packages/design-system/theme.css`'s own selector, and Panel 6 carries
`data-theme="dark" data-appearance-scope` together. That pairing is what makes the dark panel
actually recompute: a custom property's `var()` is substituted where the property is DECLARED, so a
Tier-3 layer declared on `:root` alone inherits its LIGHT literal into a nested `data-theme="dark"`
subtree and the panel renders light under a dark caption (MOTIR-3592 ·
`tests/design-dark-parity.test.ts`).

Board-chrome ink is `--el-text-secondary`, never `--el-text-muted`: this board's body is
`--el-surface`, where muted is 4.17:1 and fails AA
(`docs/decisions/design-board-chrome-aa.md`).

`prettier --write`, then `node scripts/render-design-mock.mjs --width 1200` exported the `.png`
(a new asset has no committed export to recover a viewport from, so the width is passed).

## GIVES / TAKES

Every `MOTIR-<n>` this asset names, and whether the design gives that card an element, a structure or
a premise, or takes one away.

| card           | gives / takes | what                                                                                                                                                                                                                                                                                                    |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4846** | **GIVES**     | The registry's three rows with their ids, groups, routes, glyphs and `exact` flag; the `revealedOnly` axis and its default-closed disposition; the rail head's shape, tile and eyebrow; and the below-reveal arm as a ONE-ROW rail with its two empty groups unrendered.                                |
| **MOTIR-4847** | **GIVES**     | The switcher row: its label (`Workspace settings`), its glyph (`Settings`), and its position — last group, above `Invite teammates`, with the reason for that order.                                                                                                                                    |
| **MOTIR-4861** | **GIVES**     | Panel 4 IS that card's design of record: the `Job runs` section on `/settings/organization`, beside the existing fold-in, with its four capabilities named at the gates they assert, and the host page's own org-admin gate called out as NOT this section's.                                           |
| **MOTIR-4845** | neither       | The sibling design card. This asset names the two `design/shell/` assets as ITS, and draws neither. Nothing is taken from it and nothing added.                                                                                                                                                         |
| **MOTIR-4673** | neither       | The model. Its panel 7 is lifted as the composition and re-specified nowhere.                                                                                                                                                                                                                           |
| **MOTIR-4710** | neither       | The build that panel 7 gated — cited as the shape MOTIR-4846 mirrors.                                                                                                                                                                                                                                   |
| **MOTIR-3642** | neither       | Owns the require-2FA card, which Panel 2 composes as a stub and does not redraw.                                                                                                                                                                                                                        |
| **MOTIR-3502** | **TAKES**     | Its AC 6 — _`/settings/workspace/jobs` answers 200 at every count_ — is RETIRED by this story, and this asset is where the retirement is drawn. The card is `done`, so nothing is amended on it: we only plan FORWARD, and the retirement is recorded on MOTIR-4843, MOTIR-4861 and MOTIR-4859 instead. |
| **MOTIR-3500** | neither       | Cited as the defect Panel 4 exists not to reproduce.                                                                                                                                                                                                                                                    |
| **MOTIR-4640** | neither       | The `Git` row leaving this same rail section a week earlier — cited as the precedent for why a workspace-tier row does not belong in the project rail. A finished move this asset reasons from, not a scope it touches.                                                                                 |
| **MOTIR-4859** | neither       | The planning bug for the shape this asset's Panel 4 was re-drawn to correct. A defect RECORD; it produces nothing this asset consumes.                                                                                                                                                                  |
| **MOTIR-4843** | neither       | The parent story. Its acceptance criteria are met by the assembled children; this asset settles none of them alone.                                                                                                                                                                                     |
| **MOTIR-4844** | —             | This card. Named in the asset as its own provenance.                                                                                                                                                                                                                                                    |
| **MOTIR-3592** | neither       | The dark-parity guard's card, cited for the `:root, [data-appearance-scope]` mechanism Panel 6 uses. A guard this asset satisfies, not a scope it touches.                                                                                                                                              |

**ONE TAKES, and it is from a `done` card — so it is RECORDED rather than amended.** MOTIR-3502's
AC 6 is retired by this story (above). We only plan FORWARD: a `done` card is shipped reality, so the
retirement lives on MOTIR-4843's body, on MOTIR-4861's criteria and on the planning bug MOTIR-4859,
never as an edit to MOTIR-3502.

**No TAKES from any card this asset GATES, and that was CHECKED against their criteria rather than
assumed.** MOTIR-4846 asks for the same three registry entries, the same `exact` root, and the same
default-closed `revealedOnly` — now uniform across all three rows, which its own re-scope states —
plus a `WorkspaceSidebarHeader` carrying the workspace name and eyebrow. MOTIR-4847 defers the
switcher row's label, glyph and position to Panel 5 by name. MOTIR-4861 defers its section's
composition and its gates to Panel 4. So no `update_work_item` amendment is owed on any of the three.

## Explicitly OUT of scope here

- **The account menu's loss of its `Workspace settings` row**, and the rail bottom section's loss of
  BOTH its workspace rows — **MOTIR-4845**, `design/shell/`.
- **The reveal gate on `/settings/workspace/jobs` and the `JobRunsFoldInSection` itself** —
  **MOTIR-4861** builds both; this asset draws them (Panel 4) and writes no TypeScript.
- **Any pane's content** — the three owners are tabled above, and the jobs dashboard is
  `design/jobs/`'s in Panel 3 and Panel 4 alike.
- **`Members` as a route of its own**, `WorkspaceFoldInSection`'s own composition, and §6d's
  per-section gating on `/settings/organization` — untouched, and named so the boundary is checkable.
- **The command palette.** The organisation registry deliberately does not drive its palette group
  (`organizationSettingsNav.ts`'s own note: hand-written org actions would have to be retired in the
  same change), and this one inherits that disposition — the palette is not a surface this asset
  draws.

---

## Hosted agent room — `hosted-agent.mock.html` (MOTIR-6991)

**What it is.** A project-settings room that shows which model a **hosted run** uses for each
difficulty — **Trivial · Low · Medium · High**, easiest first — and lets a project admin override
any of them. Each row names the model a run of that difficulty actually uses and where that comes
from: **Platform default** (Motir AI's default for that difficulty) or **Override** (this project's
choice). Its sibling is the Run hosted picker's delta,
[`../runs/run-section--from-difficulty.mock.html`](../runs/run-section--from-difficulty.mock.html)
(§ _Run hosted — the picker says where its model came from_ in `design/runs/design-notes.md`), which
draws the line that tells the person starting a run where the preselected model came from. A new
surface, not a delta: no existing mock draws a hosted-agent room.

**Why it is owed.** Motir AI now picks a model per difficulty (platform defaults: `claude-sonnet-5-5`
for Trivial and Low, `claude-opus-5-5` for Medium and High). Without a room, a team cannot see that
mapping, cannot change it, and cannot find out why Run hosted preselected a given model.

**Composed, not redrawn.** The area chrome (rail, groups, pane head) is
`design/projects/settings-area.mock.html`'s; the token, chrome, primitive and room-shell layers are
spliced verbatim from `design/projects/bug-destination.mock.html`, the nearest room of this tier. The
card is `components/settings/SettingsCard.tsx`; the per-row select is the shipped `Combobox`, composed
as `PlannerModelField` (the AI planning room) and `HostedModelPicker` (Run hosted) compose it; the
callouts and the read-only banner are the AI planning room's `Callout` and `ReadOnlyBanner`; the
footer is that room's explicit **Save changes** band. **No new primitive, no new pill variant and no
second picker.** Icons are extracted from `lucide-react@1.16.0`.

### Placement — decided, and why

| question                 | decision                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| which rail group         | **Automation**, directly **under AI planning** and above Rules. Both rooms choose a model Motir runs on this project's behalf, and the group already holds "things that act on the project for you". Registry entry: `id: 'hosted-agent'`, `href: '/settings/project/hosted-agent'`, `labelKey: 'nav.hostedAgent'` (_Hosted agent_), `icon: Cloud` — the glyph the Run hosted button carries, so the row and the door read as one thing. |
| its own room, not a card | Not a fifth card in AI planning. That room configures the PLANNER (cadence, sprint packing, planner model) and its one Save footer covers the whole page; the hosted agent is a different consumer with a different audience (below) and a different failure face (Motir AI's hosted-model read). A card there would put a second gate and a second outage state inside a page that has one of each.                                     |
| WRITE key                | **`ai:configure`** — the key AI planning's writes assert. Only it renders the selects enabled, Reset and the footer.                                                                                                                                                                                                                                                                                                                     |
| VIEW key                 | **`work_item:edit`** — the key the hosted start itself asserts (`projectAccessService.assertCanEdit` in `hostedRunService`). Whoever may press Run hosted may read which model it will run on; a member who sees _Project override for High_ on the picker has somewhere to find out what it means (Panel 5).                                                                                                                            |
| where the room exists    | Only on a deployment that runs hosted agents: a second `SettingsNavAvailability` field (`hostedRunsAvailable`) beside `publicProjectsAvailable`, resolved on the server and **defaulting closed**; the route answers `notFound()` without it, as billing does off-cloud.                                                                                                                                                                 |
| a live outage            | The row STAYS. Availability is a build fact, not a live read: a row that came and went with Motir AI's health would read as a feature being removed and would 404 a bookmark mid-outage. The room draws the outage instead (Panel 7).                                                                                                                                                                                                    |

⚠️ **The view key is a product decision with a population consequence, and the build card must
carry it knowingly.** `projectSettingsNav.ts` warns that a distinct `viewPermission` held by
ordinary members brings the **Project settings** area door back for them (`hasVisibleSettingsArea`
is a `some()` over view-gated rows), and falsifies every suite that pins "a member is offered no
settings area". `work_item:edit` is such a key. The entry therefore declares
`viewPermission: 'work_item:edit'` **with its evidence row** in
`tests/settings/projectSettingsNav.test.ts`, and those suites are updated in the same change. **If
that consequence is declined,** the entry keeps the single key `ai:configure`, Panel 5 becomes
unreachable and is dropped — nothing else in this design changes.

The access path is **Panel 0**: the rail with the row active, and the table of who sees it. The
command-palette deep link `settings-hosted-agent` is lit by the same registry entry.

### The panels

| panel | state                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| 0     | **Access path** — the Automation group with _Hosted agent_ active; who sees the row, and what the route answers          |
| 1     | **Default** — all four rows on their platform default; no Reset; footer disabled                                         |
| 2     | **Choosing an override** — Low's select open, `claude-opus-5` picked; the row reads _Override_; footer _Unsaved changes_ |
| 3     | **Overridden row, saved** — Low on `claude-opus-5`, the lavender _Override_ pill and _Reset to default_                  |
| 4     | **Withdrawn override** — Low's saved `claude-opus-5` is no longer offered; the row shows what runs use, and says so      |
| 5     | **Read-only** — `work_item:edit` without `ai:configure`: lock banner, selects disabled, no Reset, no footer              |
| 6     | **Loading** — selects read _Loading models…_ (disabled), the source column a skeleton block; no footer                   |
| 7     | **Unavailable** — Motir AI did not answer: peach callout with _Try again_; selects read _Models unavailable_             |
| 8     | **~400px** — rows stack: difficulty + source (+ Reset) on line one, the select full width on line two                    |

**Not drawn, stated here:** the **empty** answer (Motir AI answered and offers no model) takes the
unavailable panel's layout with the picker's own empty face — selects read _No model available_ and
the callout is `plain`, not peach, because nothing is broken: _No model can run a hosted work item
right now, so there is nothing to choose._ Dark theme is the token flip; no dark board is drawn.

### The rules the rows follow

- **Effective model** = the project's override for that difficulty **if Motir AI still offers it**,
  else that difficulty's platform default. The select always shows the EFFECTIVE model — never a
  model runs will not use.
- **Source** = _Override_ when an override is stored and offered; _Platform default_ otherwise
  (including the withdrawn case, Panel 4).
- **Picking the row's platform default IS a reset.** No override is stored, so an override can never
  name the model it overrides, and _Override_ always means "different from the default".
- **Reset to default** appears on any row holding a stored override — offered (Panel 3) or withdrawn
  (Panel 4). It marks the row dirty; the footer saves it with everything else.
- **Withdrawn is not deleted.** The stored override stays until someone resets it; if Motir AI offers
  the model again, it applies again without a re-save.
- **The select offers exactly what Motir AI offers** (`searchable={false}`): label = model id,
  `secondary` = provider (`anthropic`) — Run hosted's labelling. The row's own platform default is
  marked in the open menu by the option's `description` line, _Platform default for {difficulty}_;
  the trigger stays label + provider, and the source pill carries the source.
- **A parent work item** uses the model of the highest difficulty among its leaves (the card
  subtitle); **a work item with no difficulty** uses the platform default — the one Run hosted marks
  _Default_ (the note under the rows).

### Copy — `en`

| key (`settings.hostedAgent.*`, proposed)                 | string                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav.hostedAgent` (under `settings`)                     | Hosted agent                                                                                                                                       |
| `title`                                                  | Hosted agent                                                                                                                                       |
| `pageDescription`                                        | Which model a hosted run uses. Run hosted preselects it from the work item's difficulty; whoever starts the run can still pick another.            |
| `card.title`                                             | Model by difficulty                                                                                                                                |
| `card.subtitle`                                          | Each difficulty runs on the platform default unless you override it. A parent work item uses the model of the highest difficulty among its leaves. |
| `col.difficulty` · `col.model` · `col.source`            | Difficulty · Model · Source (shown, `aria-hidden`; each select's accessible name is `modelFor`)                                                    |
| `modelFor`                                               | Model for {difficulty}                                                                                                                             |
| difficulty labels                                        | the shipped `labels.difficulty.{trivial,low,medium,high}` — Trivial · Low · Medium · High                                                          |
| `source.default`                                         | Platform default                                                                                                                                   |
| `source.override`                                        | Override                                                                                                                                           |
| `optionDefault`                                          | Platform default for {difficulty}                                                                                                                  |
| `reset`                                                  | Reset to default                                                                                                                                   |
| `withdrawn`                                              | The saved model, {model}, is no longer offered, so {difficulty} runs use the platform default. Reset to clear it.                                  |
| `noDifficulty`                                           | A work item with no difficulty runs on the platform default, {model} — the model Run hosted marks **Default**.                                     |
| `readOnlyBanner`                                         | Only a project admin can change hosted agent settings.                                                                                             |
| `loadingTrigger` · `unavailableTrigger` · `emptyTrigger` | reused BY KEY from `runs.hosted.picker`: Loading models… · Models unavailable · No model available                                                 |
| `unavailableBody`                                        | Couldn't reach Motir AI, so the hosted models can't be shown or changed right now. Hosted runs are off until it answers.                           |
| `retry`                                                  | reused: `runs.hosted.picker.retry` — Try again                                                                                                     |
| `emptyBody`                                              | No model can run a hosted work item right now, so there is nothing to choose.                                                                      |
| `footer.dirtyHint` · `footer.save`                       | reused from `aiPlanning.footer`: Unsaved changes · Save changes; Cancel is the common cancel                                                       |
| `savedTitle` · `savedDesc`                               | Hosted agent settings saved · New hosted runs use these models.                                                                                    |
| `errorTitle` · `saveError`                               | Couldn't save · Your hosted agent settings weren't saved. Please try again.                                                                        |

`zh` follows in the build card, in the same keys.

### Primitives, colour tokens and shape tokens — every element

| element                            | primitive                                         | colour (`--el-*`)                                                                                                                                                          | shape                                                                                  |
| ---------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| rail row                           | `SidebarNav` row, from the registry               | `--el-text-secondary`, glyph `--el-icon-muted`; active: `--el-sidebar-item-bg-active`, `--el-text`, glyph `--el-icon-active`                                               | `--radius-control`, `--spacing-control-x/y`                                            |
| rail group head                    | —                                                 | `--el-text-secondary`                                                                                                                                                      | —                                                                                      |
| pane eyebrow · title · description | the area's pane head                              | `--el-text-eyebrow` · `--el-text` · `--el-text-secondary`                                                                                                                  | —                                                                                      |
| card                               | `SettingsCard`                                    | `--el-card`, `--el-border`; head divider `--el-border-soft`; glyph `--el-icon-heading`                                                                                     | `--radius-card`, `--shadow-card`, `--spacing-card-padding`                             |
| card subtitle                      | `SettingsCard` subtitle                           | `--el-text-secondary` (the shipped `--el-text-muted` passes only on white; the mock raises it)                                                                             | —                                                                                      |
| column heads                       | —                                                 | `--el-text-eyebrow`; rule `--el-border`                                                                                                                                    | —                                                                                      |
| row divider · difficulty label     | —                                                 | `--el-border-soft` · `--el-text`                                                                                                                                           | row height ≥ `--height-control`                                                        |
| model select (trigger)             | `Combobox`, `searchable={false}`                  | `--el-page-bg`, `--el-border`; label `--el-text`; secondary `--el-text-identifier`; chevron `--el-icon-muted`; placeholder `--el-text-muted` (on the white trigger only)   | `--radius-input`, `--height-control`, `--spacing-control-x`; disabled `opacity-50`     |
| open menu                          | `Combobox` panel                                  | `--el-page-bg`, `--el-border`; active row `--el-option-active-bg`; `description` `--el-text-secondary`; `secondary` `--el-text-identifier`; check `--el-accent-on-surface` | `--radius-card`, `--shadow-elevated`; rows `--radius-control`, `--spacing-control-x/y` |
| _Platform default_ pill            | `Pill`, neutral                                   | `--el-chip-bg`, `--el-chip-border`, `--el-text-secondary`                                                                                                                  | `--radius-badge`, `--spacing-chip-x/y`                                                 |
| _Override_ pill                    | `Pill`, lavender tint                             | `--el-tint-lavender`, `--el-text-strong`                                                                                                                                   | `--radius-badge`, `--spacing-chip-x/y`                                                 |
| _Reset to default_                 | `Button` ghost sm, `RotateCcw` leftIcon           | `--el-text`; glyph `--el-icon-muted`                                                                                                                                       | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x-sm`                                |
| withdrawn line                     | inline note, `role="note"`                        | `--el-text`; `TriangleAlert` glyph `--el-warning` (a graphic, 3:1); the struck model `--el-text-secondary`                                                                 | —                                                                                      |
| no-difficulty note                 | `Callout` plain, `Info`                           | `--el-surface`, `--el-border`, `--el-text-secondary`; glyph `--el-icon-muted`                                                                                              | `--radius-card`                                                                        |
| read-only banner                   | `ReadOnlyBanner` (`Callout` plain, `Lock`)        | as the note                                                                                                                                                                | `--radius-card`                                                                        |
| unavailable callout                | `Callout` peach, `TriangleAlert`, `role="status"` | `--el-tint-peach`, `--el-text-strong`; glyph `--el-warning`                                                                                                                | `--radius-card`                                                                        |
| _Try again_                        | `Button` secondary sm, `RefreshCw`                | `--el-button-border`, `--el-text`                                                                                                                                          | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x-sm`                                |
| loading skeleton                   | the arrival frame's block                         | `--el-muted`                                                                                                                                                               | `--radius-badge` (the pill it stands in for)                                           |
| footer band · hint                 | the AI planning room's footer                     | `--el-surface-soft`, `--el-border-soft`; hint `--el-text-secondary`                                                                                                        | `--spacing-card-padding`                                                               |
| Cancel · Save changes              | `Button` secondary · primary                      | `--el-button-border`, `--el-text` · `--el-accent`, `--el-accent-text`                                                                                                      | `--radius-btn`, `--height-btn-md`, `--spacing-btn-x`                                   |

**Contrast.** Every text ink on a non-white surface is `--el-text-secondary`, `--el-text-identifier`
or `--el-text-strong`; `--el-text-muted` appears only as the trigger placeholder on the white
`--el-page-bg` trigger, and `--el-text-faint` nowhere. The warning hue is carried by the glyph and
the words by `--el-text` (the `DeviceApproval` composition).

### GIVES / TAKES

| to                                      | GIVES / TAKES                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the build card(s) blocked by MOTIR-6991 | **GIVES** every panel, the placement and both keys, the row rules, the copy and the tokens above. **TAKES** a read that returns, per difficulty, the platform default and the project's stored override (if any), plus the offered list and Motir AI's single default — so the room can tell _offered_ from _withdrawn_ without a second call; and a write that stores or clears one override per difficulty, asserting `ai:configure`. |
| the Run hosted picker (this card too)   | **GIVES** the vocabulary the picker's line quotes — _Project override for {difficulty}_ is only meaningful because this room exists and is reachable by the person who reads it (the view key above).                                                                                                                                                                                                                                   |

### Scope

**Drawn:** the room, its eight states, the narrow layout and the rail row. **Not drawn:** how Motir
AI chooses its platform defaults, and where the override is persisted — the build card's; the dark
board (the token flip); the command-palette row (lit by the same registry entry, with no design of
its own).

---

## Auto-translate room — `auto-translate.mock.html` (MOTIR-8822)

**Design system.** Files read: `package.json` (depends on `@motir/design-system`, `workspace:*`, installed `0.15.1`) and `app/globals.css` (imports `@motir/design-system/theme.css`). **Verdict: ON MOTIR DESIGN (branch a).** The root layout resolves `data-style` / `data-palette` from the applied appearance (`app/layout.tsx` lines 123–124), not a fixed pair, so the mock draws the package defaults (light, plus the dark flip in Panel 8); every element is an `--el-*` / shape token, so any applied palette or style re-skins it. The `./mock` entry exists but the room is composed from the neighbouring shipped assets' spliced layers instead (below), exactly as `hosted-agent.mock.html` is, so the two cannot drift. Parts the package lacks: **none proposed**. `SwitchRow` (`components/settings/SwitchRow.tsx`) and `SettingsCard` are product-local components and are composed, not redrawn.

**What it is.** A project-settings room, **Translation**, where a project administrator turns **Auto-translate work content** on or off, where every other member who may read the project reads what it is set to, and where anyone in the room can read who changed it, from what, to what and when. Story MOTIR-7738. A new surface, not a delta: no existing mock draws this room.

**Why it is owed.** With the switch on, every member reads the team's work in their own language without pressing anything (the story); the switch is the one place that decision is made, it spends the organization's AI credit, and a member who is shown translated text has to be able to find out why. Without a room there is no control, no consent wording at the point of the decision, and no record of who turned it on.

**Composed, not redrawn — and it redraws none of these.** The area chrome (rail, groups, pane head) is `design/projects/settings-area.mock.html`'s. The token, chrome, primitive and room-shell layers are spliced verbatim from `design/settings/hosted-agent.mock.html`, the nearest room of this tier; the token block gains the three `--el-switch-*` tokens that block does not carry (`--el-switch-on-border`, `--el-switch-off-border`, `--el-switch-knob-off`), copied from `packages/design-system/theme.css`. The pending frame is `design/settings/arrival.mock.html` Panel B (Panel 0b). The card is `components/settings/SettingsCard.tsx`; the control row is `components/settings/SwitchRow.tsx`; the primitives are the shipped `Switch`, `Pill`, `Button`, `Callout` (plain · peach) and `NoAccessState`. The control that returns when the setting is off is the predecessor's per-work-item **Translate** button, (the design published with MOTIR-8112; read with `get_design MOTIR-8112`). The dark panel re-declares the `--el-*` on a `[data-appearance-scope]` subtree, the mechanism `theme.css` provides for it. Icons are extracted from `lucide-react@1.16.0`.

### Placement — decided, and why

| question              | decision                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| address               | `/settings/project/translation`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| rail label            | **Translation** (`nav.translation`, under `settings`)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| rail group · position | **Automation**, directly **below Hosted agent** and **above Rules**. Registry entry: `id: 'translation'`, `group: 'automation'`, `labelKey: 'nav.translation'`, `icon: Languages`. The rooms that configure what Motir does on this project's behalf, and what it costs, sit together (AI planning · Hosted agent · Translation); **Rules** is user-authored automation and stays last. The command-palette deep link `settings-translation` is lit by the same entry. |
| why a room of its own | Not a card on an existing room. This registry names **one write key per room**, and no existing room's behaviour switch takes this one's key: Details is `project:administer` but is the project's identity (name, key, avatar, archive); Approvals is `workflow:manage`; AI planning and Hosted agent are `ai:configure`. A card on any of them would put a second gate inside a page that has one.                                                                   |
| build flag            | **None.** The room exists on every build, so unlike Hosted agent there is no `SettingsNavAvailability` field.                                                                                                                                                                                                                                                                                                                                                          |

### The two keys

| key       | value                    | how it was read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **WRITE** | **`project:administer`** | The story's criterion names the setting's changer as a `project:administer` holder. **The service that flips it does not exist yet** (MOTIR-8826 builds it), so this cannot be read off a shipped gate the way Hosted agent's was; the build card must assert **this key** in `update` and the registry entry's `permission` is `project:administer`. Its evidence row goes in `KEY_EVIDENCE` in `tests/settings/projectSettingsNav.test.ts` with that service as `source`. Nothing else in the shipped tree contradicts it: the other per-project boolean switches live under the Approvals room's `workflow:manage` because they are gate switches, which this is not. |
| **VIEW**  | **`project:browse`**     | Decided by the project owner on 2026-10-17: seeing the setting follows reading the project's work items, which `project:browse` gates, so every role that may read them (viewer, member, manager) may read whether they are auto-translated.                                                                                                                                                                                                                                                                                                                                                                                                                             |

**The two alternatives turned down.** (1) _The write key as the view key_ — a member would have nothing to read, yet the story requires a member to be able to read what the setting is, and it is the only way a reader who sees translated text can learn why. (2) _`work_item:edit`, the Hosted agent room's view key_ — that key hides the setting from a **viewer**, who is a reader of every translated surface this setting changes.

⚠️ **The consequence, stated in full.** `projectSettingsNav.ts` warns that a distinct `viewPermission` held by ordinary roles brings the **Project settings** area door back for them: `hasVisibleSettingsArea` is a `some()` over view-gated rows, and `project:browse` is held by **every role that can open the project**. So declaring this view key brings the settings-area door back for **every role that can browse the project, viewers included, on every build** — the room has no build flag, so there is no deployment on which it stays shut. What that obliges:

- the entry declares `viewPermission: 'project:browse'` **with its evidence row** in `VIEW_KEY_EVIDENCE` (`tests/settings/projectSettingsNav.test.ts`): `source` the settings service's `get`, `gate: 'assertPermission'` — the READ asserts `project:browse`, the FLIP asserts `project:administer`, one service and two keys, because the read-only state is the whole reason the view key exists;
- the suites that pin _a member is offered no settings area_ — `tests/settings/projectSettingsNav.test.ts`, `tests/settings/settings-area-access-matrix.test.ts`, `tests/permissions/gatedUiStoryGate.test.ts`, `tests/permissions/gatedUiRender.integration.test.ts` and `tests/e2e/permission-gated-ui.spec.ts` — **must say what they mean**: that statement was already narrowed to "on a build without hosted runs" by Hosted agent, and is now false on every build;
- the area's rail for such an actor offers **this one row** (every other room is gated on a key they do not hold), so their door opens onto a rail of one and onto Panel 5.

**Closure check — every role holding the write key also holds the view key.** Read in `lib/permissions/builtinRoles.ts` on `origin/main`: `project:administer` is in `ROLE_GATED_PERMISSIONS` (line 92) directly after `project:browse` (line 91); `WORKSPACE_ROLE_PERMISSIONS.manager` is `new Set(ROLE_GATED_PERMISSIONS)` and `BUILTIN_ROLE_PERMISSIONS.admin` is that same set (line 310). `member` and `viewer` hold `project:browse` and **not** `project:administer`. The workspace owner/admin always-pass rail resolves to the whole gated set. **Result: closed for every built-in role — no built-in holder of the write key can be refused the view key.** A **custom role** may be granted `project:administer` without `project:browse`; that actor cannot browse the project and never reaches the area (the project's not-found), so the refused state (Panel 6) is **drawn for the record and reached by nobody**.

### The panels

| panel | state                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| 0     | **Access path** — the Automation group with _Translation_ active; who sees the row and what the route answers            |
| 0b    | **Arriving** — the settings area's shipped pending frame, composed                                                       |
| 1     | **Off** — the default, every existing and every new project; empty read-back                                             |
| 2     | **On** — _What readers get_, the cost line linking to Usage & cost; populated read-back                                  |
| 3     | **3a In flight** · **3b Flip failed** — the switch back at its previous value, inline error, _Try again_                 |
| 4     | **No AI credit** — **4a** organization owner/admin (_Add credits_), **4b** project admin who is not                      |
| 5     | **Read-only** — **5a** off, **5b** on: the value in place of the control, the shipped _Read-only_ pill                   |
| 6     | **The refused door** — `NoAccessState` inside the chrome, for the record                                                 |
| 7     | **The read-back** — **7a** empty · **7b** populated (off→on and on→off) · **7c** capped · **7d** loading · **7e** failed |
| 8     | **Dark** — token parity                                                                                                  |
| 9     | **~400px** — the rail collapses, the card stacks                                                                         |

**Explicitly not states of this surface.** Translated / untranslated: this surface renders no work content, so the machine-translation marker belongs to the work item page and the per-surface no-credit notice to the reading surfaces.

### The rules the room follows

- **The switch commits immediately.** No save footer: a save bar would show the setting on while nothing had been recorded. The press is optimistic — the switch moves to the new value, dims and sets `aria-busy` with **Saving…** under the hint — and **returns to the value it held before the attempt** if the write fails (Panel 3b). The read-back is unchanged on failure because nothing was recorded.
- **Turning it on with no credit is allowed.** The setting is consent to spend and the balance changes without the setting changing; the callout (Panel 4) says translation needs AI credits, that work content shows as written, and that nothing is billed. **Add credits** goes to `/settings/organization/billing` — the same target the predecessor's no-credit message uses — and is offered only to an organization owner or admin; a project admin who is neither is told who can. The money itself is another page's: this room links Usage & cost and never renders a balance or a price table.
- **The price is quoted, not invented.** The cost line says the organization's AI credits are spent **at the model's cost plus 50%**, the settled policy (the `translation` credit lane, 1.5× the upstream cost); [AI economics](motir:cmtm1osx80026hwn8q1lzntj3) owns the number.
- **Read-only shows the value, not a dead control.** A holder of the view key and not the write key sees the setting's value as a pill (_On_ / _Off_) with one sentence saying what it means, the shipped **Read-only** pill in the card head (`SettingsCard`'s `action` slot, the Fields room's `readOnly`), and the line _Only a project admin can change auto-translate._ The switch is **absent, not disabled**.
- **What readers get appears only when it is on** — three sentences, one for each place the setting reaches: the work item page and quick view; lists, boards, backlog, sprints, roadmap, ready and triage (titles, with a per-view **Show original**); and the surfaces that always read the original (agents, the API, emails) and the editor that always opens it.
- **The read-back draws four things and no more** — **who**, the value **from**, the value **to**, **when** — newest first. Drawn as three columns (Who · Change · When) because from and to read as one cell, `Off → On`. **No fifth field**: no reason, no IP, no client. When the read returned fewer rows than the total it reports, the section says so (_Showing the 20 most recent of 47 changes._); a truncated list that does not say it is truncated is the defect this state prevents. The cap is **20**.

### Reference check

**Setting behaviour — what was checked and what it showed** (web search, 2026-10-17; no signed-in product session was reachable from this environment, so these are documented behaviours, not observed screens):

- **Jira Cloud** — no native setting that auto-translates user-written issue content. Atlassian's built-in translation covers issue type, status, resolution and priority _names_ only (Atlassian admin documentation, _Translating resolutions, priorities, statuses and issue types_). Automatic translation of summaries, descriptions and comments comes from Marketplace apps (Issue Translator, Auto Translator for Jira & JSM), which translate content written in another language into the project's language. **Showed:** the closest incumbent treats it as a per-project concern configured by an administrator and applied to everyone, which is this design's model; it showed no per-reader language and no show-original.
- **Notion** — page translation is on demand, per page, from the page menu, and reverts afterwards; no show-original control was found in the product (only third-party extensions draw one). **Showed:** the on-demand half is the predecessor's per-work-item **Translate**; the reader-level always-on behaviour is this setting, which no reference product offers as a native setting.
- **Linear** — the search returned nothing about issue translation; **not reached**.

**Read-back shape — no reference was reached.** No reference product's change-history surface for a single project setting could be observed from here. The design falls back to the shipped in-repo pattern for a who-did-what-when list, `design/work-items/activity-history.mock.html` (the item page's change trail: actor · change · time, newest first, with a _Show more_ cap), reduced to this surface's four fields, and to the shipped skeleton row (`design/settings/arrival.mock.html`) for loading.

### Copy — `en`

| key (`settings.translation.*`, proposed) | string                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nav.translation` (under `settings`)     | Translation                                                                                                                                                                                                                                                              |
| `title`                                  | Translation                                                                                                                                                                                                                                                              |
| `pageDescription`                        | How members who read in different languages see this project's work content.                                                                                                                                                                                             |
| `card.title`                             | Auto-translate                                                                                                                                                                                                                                                           |
| `card.subtitle`                          | Let every member read this project's work in their own language, and still see the original.                                                                                                                                                                             |
| `switch.label`                           | Auto-translate work content                                                                                                                                                                                                                                              |
| `hint.off`                               | Off. Work content shows as written, and a **Translate** button on each work item page translates that one work item when a member asks.                                                                                                                                  |
| `hint.on`                                | On. Every member reads work content in their own interface language without pressing anything, and **Show original** is always one press away.                                                                                                                           |
| `saving`                                 | Saving…                                                                                                                                                                                                                                                                  |
| `flipError`                              | Couldn't turn auto-translate {to}. Nothing was changed. (`{to}` = on / off)                                                                                                                                                                                              |
| `retry`                                  | Try again                                                                                                                                                                                                                                                                |
| `effects.title`                          | What readers get                                                                                                                                                                                                                                                         |
| `effects.page`                           | Work item pages and quick views show every field in the reader's language: the title, description, explanation and each to-do.                                                                                                                                           |
| `effects.lists`                          | Lists, boards, the backlog, sprints, the roadmap, ready and triage show titles in the reader's language, with a **Show original** switch on each view.                                                                                                                   |
| `effects.original`                       | Agents, the API and emails always receive the original text, and editing always opens the original.                                                                                                                                                                      |
| `cost`                                   | Each field is translated once per language and kept, so a later reader of the same text pays nothing, and text already in the reader's language is never sent. Translation spends your organization's AI credits at the model's cost plus 50%. <link>Usage & cost</link> |
| `noCredit.body`                          | **Translation needs AI credits.** Work content shows as written until credit is added. Nothing is billed.                                                                                                                                                                |
| `noCredit.add`                           | Add credits                                                                                                                                                                                                                                                              |
| `noCredit.askAdmin`                      | An organization owner or admin can add them.                                                                                                                                                                                                                             |
| `readOnly`                               | Read-only                                                                                                                                                                                                                                                                |
| `readOnlyNote`                           | Only a project admin can change auto-translate.                                                                                                                                                                                                                          |
| `value.on` · `value.off`                 | On · Off                                                                                                                                                                                                                                                                 |
| `readOnly.on`                            | Auto-translate is on for this project. Work content shows in each member's own language.                                                                                                                                                                                 |
| `readOnly.off`                           | Auto-translate is off for this project. Work content shows as written.                                                                                                                                                                                                   |
| `history.title`                          | Change history                                                                                                                                                                                                                                                           |
| `history.subtitle`                       | Who turned auto-translate on or off, and when.                                                                                                                                                                                                                           |
| `history.col.who` · `.change` · `.when`  | Who · Change · When (shown, `aria-hidden`; each row's accessible name is `history.row`)                                                                                                                                                                                  |
| `history.row`                            | {who} changed auto-translate from {from} to {to} on {when}.                                                                                                                                                                                                              |
| `history.empty`                          | No changes yet. Auto-translate has never been changed on this project.                                                                                                                                                                                                   |
| `history.capped`                         | Showing the {shown} most recent of {total} changes.                                                                                                                                                                                                                      |
| `history.failed`                         | **Couldn't load the change history.** The setting above is unchanged.                                                                                                                                                                                                    |
| `noAccess.section.translation`           | Whether this project's work content is translated for each reader is shown to people who can read the project's work items. Ask a project admin if you need to see it.                                                                                                   |

The card asks for **Add credit**; the product's shipped vocabulary is **Add credits** (the predecessor's design, `messages/en.json` `optionCreditsCta`), and the plural is used here so the two no-credit messages read as one thing. The ten non-English twins are the app-catalogue lane's: a string nobody has translated yet reads in English rather than as a raw key.

### Primitives, colour tokens and shape tokens — every element

| element                           | primitive                                        | colour (`--el-*`)                                                                                                                                                   | shape                                                      |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| rail row · group head · pane head | the area's, from the registry                    | as Hosted agent: `--el-text-secondary`, glyph `--el-icon-muted`; active `--el-sidebar-item-bg-active`, `--el-text`, `--el-icon-active`; eyebrow `--el-text-eyebrow` | `--radius-control`, `--spacing-control-x/y`                |
| card                              | `SettingsCard`                                   | `--el-card`, `--el-border`; head divider `--el-border-soft`; glyph `--el-icon-heading`                                                                              | `--radius-card`, `--shadow-card`, `--spacing-card-padding` |
| card subtitle                     | `SettingsCard`                                   | `--el-text-secondary` (the shipped `--el-text-muted` passes only on white; the mock raises it)                                                                      | —                                                          |
| switch                            | `Switch`                                         | on: `--el-switch-on`, edge `--el-switch-on-border`, knob `--el-switch-knob`; off: track `--el-muted`, edge `--el-switch-off-border`, knob `--el-switch-knob-off`    | `rounded-full` (a genuinely circular affordance)           |
| switch label · hint               | `SwitchRow`                                      | `--el-text` · `--el-text-secondary` (shipped `--el-text-helper`; raised, the row lands on `--el-card` and `--el-surface`)                                           | —                                                          |
| _Saving…_                         | `Spinner` + text                                 | `--el-text-secondary`; spinner `--el-border-strong` / `--el-accent`                                                                                                 | `rounded-full`                                             |
| inline error                      | row with `TriangleAlert` + `Button` secondary sm | text `--el-text`; glyph `--el-danger-on-surface` (never `--el-danger-text`)                                                                                         | `--radius-btn`, `--height-btn-sm`                          |
| _What readers get_ head           | `SectionLabel`                                   | `--el-text-eyebrow`                                                                                                                                                 | —                                                          |
| effect rows                       | list, `Check` glyph                              | text `--el-text`; glyph `--el-icon-muted`                                                                                                                           | —                                                          |
| divider                           | `hr`                                             | `--el-border-soft`                                                                                                                                                  | —                                                          |
| cost line                         | text + link                                      | `--el-text-secondary`; link `--el-link`                                                                                                                             | —                                                          |
| no-credit callout                 | `Callout` peach, `CircleAlert`, `role="status"`  | `--el-tint-peach`, `--el-text-strong`; glyph `--el-warning` (a graphic, 3:1); link `--el-link`                                                                      | `--radius-card`                                            |
| _Read-only_ pill                  | `Pill` neutral                                   | `--el-chip-bg`, `--el-chip-border`, `--el-text-secondary`                                                                                                           | `--radius-badge`, `--spacing-chip-x/y`                     |
| value pill _On_ · _Off_           | `Pill` — mint tint · neutral                     | `--el-tint-mint`, `--el-text-strong` · `--el-chip-bg`, `--el-text-secondary`                                                                                        | `--radius-badge`, `--spacing-chip-x/y`                     |
| read-back column heads            | —                                                | `--el-text-eyebrow`; rule `--el-border`                                                                                                                             | —                                                          |
| read-back row                     | grid                                             | divider `--el-border-soft`; who `--el-text`; when `--el-text-secondary`                                                                                             | row ≥ `--height-control`                                   |
| change cell                       | two `Pill`s and `ArrowRight`                     | as the value pill; arrow `--el-icon-muted`                                                                                                                          | `--radius-badge`                                           |
| capped line                       | text                                             | `--el-text-secondary`                                                                                                                                               | —                                                          |
| skeleton row                      | the arrival frame's block                        | `--el-muted`                                                                                                                                                        | `--radius-control`; the pill stand-in `--radius-badge`     |
| _Try again_                       | `Button` secondary sm, `RefreshCw`               | `--el-button-border`, `--el-text`                                                                                                                                   | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x-sm`    |
| refused state                     | `NoAccessState` (`EmptyState`, `Lock`)           | `--el-icon-muted`; title `--el-text`; body `--el-text-secondary`; button `--el-accent`, `--el-accent-text`                                                          | `--radius-btn`, `--height-btn-md`                          |

**Contrast.** Every text ink on a non-white surface is `--el-text-secondary`, `--el-text-strong` or `--el-text`; `--el-text-muted` and `--el-text-faint` appear nowhere. The danger hue rides the glyph only.

### GIVES / TAKES

| to                                                                      | GIVES / TAKES                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Schema and migration](motir:cmvbkboem0012hqop7hidf4e4) (MOTIR-8825)    | **GIVES** the read-back's four fields — the actor, the value from, the value to, the moment — and the cap of 20. **TAKES** a column off for every existing and every new project and a change record holding at least those four.                                                                                                                                          |
| [Service](motir:cmvbkboh1001ahqopxrj1n535) (MOTIR-8826)                 | **GIVES** both keys and the rule that the READ asserts `project:browse` and the FLIP `project:administer`, and that the change and its actor are recorded in the same transaction as the write. **TAKES** a read returning the value, the history newest first, the **total**, and enough to know the cap was hit.                                                         |
| [Settings → Project room](motir:cmvbkbovp001ohqop8zx43qox) (MOTIR-8830) | **GIVES** every panel, the placement and both keys, the consequence for the settings rail's audience and the evidence rows it obliges, the copy and the tokens. **TAKES** the registry entry, the route and page, the control and its refusals, and the read-back's read — a new room, not only a switch, so its estimate predates this asset and is the thing to re-read. |
| the work item page and the title surfaces                               | **GIVES** one sentence: the OFF state is where the per-work-item **Translate** button returns.                                                                                                                                                                                                                                                                             |

### Scope

**Drawn:** the room, its states, the narrow layout, the rail row, the read-back. **Not drawn:** the machine-translation marker and Show original (work item page and quick view: [the design](motir:cmvbkbo2z000yhqopkyuvd4kg)); the title surfaces and their per-surface switch and one no-credit notice ([the design](motir:cmvbkbode0010hqopplj8p1be)); the reader's context, the many-titles door and the render-site sweep; Usage & cost and the price of a model call ([AI economics](motir:cmtm1osx80026hwn8q1lzntj3)); the ten other locales; which language a field records and the reader's interface language; the public-page and email walls. The mock authors the English copy only and adds no key to a catalogue.

---

## Connected apps

**Asset:** `design/settings/account-settings--connected-apps.mock.html` — a DELTA (MOTIR-6981, Story
MOTIR-6973). **It amends `design/settings/account-settings.mock.html` § Panel 3** (_Security &
access pane — the API tokens card + table_, spec'd above in _Panel 3 — Security & access pane (API
tokens)_) by adding one card to that pane, and draws the rail as the same asset's **Panel 9** does
(_Git accounts_ amendment, MOTIR-4675) — the shipped `ACCOUNT_SETTINGS_NAV`. **The base mock is not
edited**; it stays the record of what it drew. This section holds only what changes.

**What it is.** Every app the person has connected to Motir over OAuth — Claude on claude.ai, Claude
Code, Cursor, any MCP client that signs in with a Motir account — listed one row per connection, with
a Revoke that makes that app's next call fail. It is the human face of the grant MOTIR-6983 records,
the way the tokens card is the human face of a PAT.

### ⚠️ What a row IS — MOTIR-6983, _A connection IS a grant_

Every fact on a row, and everything Revoke does, is read off
[A connection IS a grant](motir:cmunc4k7k003yhvshih02on3t) (MOTIR-6983). A connection is **one
consent record: one person, one workspace (and optionally one project), one set of permission keys,
one OAuth client.** Two consequences the drawing depends on:

- **One row per grant, not per app.** The same app connected to two workspaces is **two rows**
  (Panel 1 draws _Claude Code_ twice, in `Client work` and in `Motir`), and each revokes alone. A
  reader who spans workspaces does it with several connections, exactly as with several tokens.
- **Revoke deletes the grant and every access and refresh token issued under it.** The next MCP call
  from that app answers `401` with the `resource_metadata` pointer, so the client starts sign-in
  again. There is therefore no "Revoked" row state to render: the row leaves the list, the same
  disposition the tokens list has had since MOTIR-3546.

**Nothing on this surface edits a grant.** Narrowing a connection is revoke, then connect again and
approve fewer scopes on the consent screen (MOTIR-6980). That is GitHub's _Authorized OAuth Apps_ and
Linear's _Authorized applications_ both: a list with Revoke, never an editor.

### The ACCESS PATH — Settings → Account → Tokens, the last card in the pane (Panel 1)

**No new rail row.** The section is reached the way tokens are: avatar menu → **Settings** → the
account rail's **Security** group → **Tokens** (`/settings/account/tokens`, the `apiTokens` entry in
`lib/settings/accountSettingsNav.ts`, label _Tokens_ since MOTIR-2534). The rail is drawn as it ships
— _Profile · Language · Notifications · Appearance · Two-factor · **Tokens** · Git accounts · Data &
privacy_ — with Tokens active.

**Order in the pane** (`app/(authed)/settings/account/tokens/page.tsx`), top to bottom:

| #   | section                                                 | status                                |
| --- | ------------------------------------------------------- | ------------------------------------- |
| 1   | page header _Tokens_                                    | unchanged (heading and subtitle both) |
| 2   | `ApiDocsLinkPanel`                                      | unchanged                             |
| 3   | `ConnectCliPanel`                                       | unchanged                             |
| 4   | `ApiTokensManager` (_Your tokens_, or its `EmptyState`) | unchanged                             |
| 5   | **Connected apps**                                      | **NEW — this card**                   |

**Why LAST, below the tokens and not above them.** The pane is still the tokens pane — its heading,
subtitle and first three sections are about tokens, and the reader who arrives here most often is
minting one. And `ConnectCliPanel`'s tie line promises that an approved terminal _"appears below as
`CLI · {host}`"_ — in the tokens card, which must stay the next list down for that sentence to stay
true. Connected apps is the second kind of credential this pane holds, so it is the second list.

**The card carries `id="connected-apps"`**, so `/settings/account/tokens#connected-apps` is the one
link the docs (MOTIR-6976) and the consent screen's success copy can hand out for "manage it later".

**Always rendered**, whatever the tokens card shows: with no tokens the `EmptyState` sits at #4 and
this card still follows it.

### Panels

| Panel | State                       | What it shows                                                                                  |
| ----- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| 1     | **populated** + access path | the pane in the area shell; four connections across two workspaces; row 1's scopes disclosed   |
| 2     | **row anatomy**             | a Full-access grant with **Can delete**, its scopes disclosed, the **Unverified** tooltip open |
| 3     | **empty**                   | the card header, then one line and one link                                                    |
| 4     | **loading**                 | the card header, then three skeleton rows in the table's own columns                           |
| 5     | **error**                   | the card header, then an inline error line with **Try again**                                  |
| 6     | **revoke confirm**          | the destructive `Modal` (sm) naming the app, the workspace and the grant                       |
| 7     | **revoking**                | the same Modal with the danger Button `loading`, Cancel and close disabled                     |
| 8     | **revoked**                 | the list without the row + the success Toast; beside it the error Toast for a failed revoke    |
| 9     | **narrow viewport** (375px) | below `sm` the table becomes a stacked list, one block per connection                          |

### The card and its row — composed from `ApiTokensManager`, column for column

The card is the tokens card's structure with one fewer column and no header action. **The row is a
sibling of the token row**: the same `<table>` inside the same `Card` `header` slot, the same `Th`
(`text-xs font-medium tracking-wide uppercase text-(--el-text-secondary)`), the same cell padding
`py-(--spacing-control-y) pr-4`, the same chevron disclose and the same trash icon button. A builder
should extract the shared pieces (`Th`, the scopes cell, the disclose sub-row) rather than copy them.

| Column        | Content                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App**       | line 1: the client's registered name (`text-sm font-medium --el-text`), then the **Unverified** Pill when the client registered itself. Line 2: the **host** of the redirect URI the grant was issued to (`claude.ai`, `localhost`), `font-mono text-xs --el-text-secondary`.                                                                        |
| **Scopes**    | exactly the token row's cell: `summarizeGrant(grant)` → `Pill severity="success"` _Full access_, or `Pill tone="neutral"` _Standard_ / _Read only_ / _Custom_; the rose _Can delete_ Pill (`severity="danger"` with `Trash2`) whenever `work_item:delete` is granted, never hidden behind the summary; then the chevron disclose.                    |
| **Workspace** | line 1: the workspace name (`text-sm --el-text-secondary`), with the organisation as a prefix (`{org} · {workspace}`) only when the reader belongs to more than one organisation — the token row's `multiOrg` rule. Line 2: `All projects`, or the one project's name (`text-xs --el-text-secondary`).                                               |
| **Connected** | the date the grant was written, `formatDate(…, locale)` — absolute, as the token row's _Created_.                                                                                                                                                                                                                                                    |
| **Last used** | **relative** (`2 minutes ago`, `Yesterday`) up to 7 days, then the absolute date; `Never` when no call has been made. Relative, unlike the token row, because the story's verification step reads _"a last used of moments ago"_ — this is the column a person checks straight after connecting. The absolute timestamp rides in the cell's `title`. |
| **Actions**   | the trash icon button, `aria-label` `Revoke {app} in {workspace}`. It opens Panel 6.                                                                                                                                                                                                                                                                 |

**Order:** newest first by _Connected_, the order the token list uses.

**The column is headed _Scopes_, not _Permissions_,** because two tables stacked in one pane must not
name one thing twice. It reuses `settings.apiTokens.columns.scopes`.

#### The host line — why it is there

Every app on this list named itself. A dynamically registered client can call itself anything,
including the name of a different app, so the name alone does not tell two rows apart — and Panel 1
already has two _Claude Code_ rows. The host of the redirect URI is the one fact on the row that the
app did not choose, and it is what tells a reader where the tokens went. It is drawn quiet (mono,
secondary) because it is a disambiguator, not a headline.

#### The Unverified label

`Pill tone="neutral"` reading **Unverified**, beside the name, on every client that registered
itself (RFC 7591 dynamic registration — which, at launch, is every client). Wrapped in the shipped
`Tooltip`: _"This app registered itself. Motir hasn't verified who publishes it."_ It is the same
label and the same words the consent screen shows for the same client (MOTIR-6980), so the person
sees one vocabulary before and after they approve.

**Neutral, not warning.** At launch every row carries it, and a peach chip on every row is noise that
teaches the reader to ignore peach. It states a fact; it is not an alarm. A client Motir registered
itself carries **no** pill — there is no _Verified_ badge, because its absence is the case the label
is contrasted with.

#### The disclosed scopes — the token picker's columns, read-only (Panel 2)

The chevron discloses a sub-row (`colSpan` the whole table) holding the grant **in the token
picker's two columns** (`design/settings/permission-columns.mock.html`, MOTIR-3580): every
grantable permission, grouped by domain, split by the shipped `permissionColumnsForTokens()` — 7 / 7
at today's 14 keys, cut after _Work items_ — and read-only.

- **Box:** the token row's detail box — `rounded-(--radius-card) border border-(--el-border-soft)
bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)`, lead line _This app
  can:_ in `text-xs --el-text-secondary`.
- **Domain heading:** `font-mono text-[0.625rem] tracking-wide uppercase --el-text-secondary`, the
  picker's own; labels from `permissions.domain.*`.
- **Row:** the domain glyph from `PERMISSION_META` (`size-4 --el-icon-muted`), the label from
  `permissions.<slug>.label` (never new copy — `permissionMeta.tsx` writes none, and neither does
  this), and at the right the state:
  - **granted** — `CircleCheck` in `--el-success` (a graphic, 3:1 suffices) with a visually hidden
    _Granted_; label `--el-text`.
  - **not granted** — the words _Not granted_ (`text-xs --el-text-secondary`); label
    `--el-text-secondary`. Words, not a greyed row: `--el-text-faint` fails AA on every surface and
    this row is information, not a disabled control.
  - **the irreversible key** (`work_item:delete`) when granted — the picker's rose row:
    `bg-(--el-tint-rose)`, label `--el-text-strong` 500, glyph `--el-danger-on-surface`.
- **Below `sm` the two columns become one**, in the same order (Panel 9).

Showing the ungranted keys too is the point of "the picker's columns": a reader checking _what can
this app not do_ has the answer in the same place as _what can it_.

### Panel 3 — empty

The card keeps its place and its header. The body is one line:

- a 32px `--el-muted` disc holding `Plug` (`size-4 --el-icon-muted`, `aria-hidden`);
- the sentence, `text-sm --el-text-secondary`, ending in a link (`--el-link`, underline, hover
  `--el-link-pressed`) with a trailing `ArrowUpRight` (external, opens in a new tab,
  `rel="noopener"`).

**Not the `EmptyState` primitive.** That is a 48px glyph and a serif title — the treatment the tokens
card uses because tokens are the pane's subject. This is its second section, and a full empty state
under the tokens would out-shout them.

**The link's destination** is motir.co's _Add Motir to Claude_ page, which MOTIR-6976 publishes. Its
path is that card's to fix; the build card takes it from there (or from a constant it owns) rather
than from this asset.

### Panel 4 — loading

The header renders; the body is the table's own header row and **three skeleton rows** in its six
columns: two stacked bars for App and Workspace, a pill-shaped bar for Scopes, one bar each for the
dates, a 28px square for the action. Bars are `bg-(--el-muted) rounded-(--radius-control)` (the pill
bar `rounded-(--radius-badge)`), under `animate-pulse`, the whole body `aria-hidden`, with a visually
hidden `role="status"` reading `common.loading` (_Loading…_).

**It is an in-page `<Suspense>` around this card only, placed after the page's session gate** — never
a `loading.tsx` (CLAUDE.md § _A `loading.tsx` may NOT sit above a route that decides existence_). The
rail, the page header and the tokens above are painted when the frame shows; only the rows wait.

### Panel 5 — error

The header renders; the body is one inline line, `role="alert"`:

- `TriangleAlert`, 20px, `--el-danger-on-surface` (the glyph carries the hue);
- title `text-sm font-medium --el-text`; description `text-[13px] --el-text-secondary`;
- **Try again** — `Button variant="secondary" size="sm"`, re-running the list read, with `loading`
  while it runs.

**Not the `ErrorState` card**, for Panel 3's reason: a 48px danger glyph under the tokens reads as the
whole pane failing, and nothing else on the page did. The description says _Nothing was revoked_
because the person who came here to revoke something needs to know the failure did not do it for
them.

### Panel 6 — revoke confirm

`Modal size="sm"`, the shipped `RevokeTokenDialog` composition re-worded:

- **title** (`font-serif text-xl --el-text`): names the app.
- **callout**: `rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding)`,
  `TriangleAlert` `size-4 --el-danger`, sentence `text-sm --el-text-strong`, app and workspace in
  `font-semibold`.
- **facts** — a `<dl>` naming THIS connection among its siblings: _Workspace_ (`{workspace} ·
{All projects | project}`), _Scopes_ (the summary word), _Connected_ (date). Terms
  `text-[13px] --el-text-secondary`, values `--el-text`.
- **footer** (`Modal.Footer`): `Button variant="ghost"` **Cancel** · `Button variant="danger"`
  **Revoke access** with `Trash2`.

**The callout names the workspace** because "revoke Claude" is ambiguous to someone whose Claude
reaches two. **It does not say "can't be undone"**, unlike the token dialog: a connection IS
recoverable — connect again from the app and approve — so it says what recovering costs instead.

### Panel 7 — revoking

The danger Button takes `loading` (its `Spinner` replaces `Trash2`, `aria-busy`, disabled); the label
does not change. **Cancel and the close button are disabled, and Escape and the scrim do nothing**
while the request runs, so the dialog cannot close on a revoke whose outcome is unknown. (The token
dialog disables Cancel only; this is one step stricter, on purpose.)

### Panel 8 — revoked

On `2xx` the dialog closes, the row is **spliced out of the island's own state** — the list is a
client island seeded from the server read, so the page-state contract's case 3 applies and
`router.refresh()` is never the mechanism — and a success `Toast` fires. On failure the dialog stays
open, the button returns from `loading`, the row stays, and the error `Toast` fires. Revoking the last
row leaves Panel 3.

A revoke that answers `404` (already gone — revoked from another tab, or the membership was removed)
is treated as success: the row leaves and the success toast fires. The person's intent — that app
cannot act — holds either way.

### Panel 9 — narrow viewport

Below `sm` (640px) the table becomes a `<ul>`, one block per connection, `py-3.5` with an
`--el-border-soft` rule between blocks:

1. App name + Unverified, host under it — with the trash icon button top-right (36px hit area kept);
2. `{workspace} · {All projects | project}`, `text-[13px] --el-text-secondary`;
3. the scopes cell (summary Pill, Can delete, chevron) — disclosed columns collapse to one;
4. `Connected {date} · Last used {when}`, `text-xs --el-text-secondary`.

The account rail is the shipped drawer at this width and is not drawn. **The tokens table above keeps
its shipped `overflow-x-auto`** — bringing it to this list form is not this card's change.

### Copy — every string, `en`

A new namespace **`settings.connectedApps`**. The permission, domain and summary labels are NOT new:
they come from `permissions.*` and `settings.apiTokens.scopes.summary.*` / `.canDelete`, so this
surface describes a grant in the same words as the token list and the consent screen.

| key                         | `en`                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                     | Connected apps                                                                                                                                                                         |
| `subtitle`                  | Apps you've signed into with your Motir account. Each one acts as you, in one workspace, with the scopes you approved.                                                                 |
| `columns.app`               | App                                                                                                                                                                                    |
| `columns.scopes`            | _(reuse `settings.apiTokens.columns.scopes`)_ Scopes                                                                                                                                   |
| `columns.workspace`         | Workspace                                                                                                                                                                              |
| `columns.connected`         | Connected                                                                                                                                                                              |
| `columns.lastUsed`          | Last used                                                                                                                                                                              |
| `columns.actions`           | Actions                                                                                                                                                                                |
| `allProjects`               | All projects                                                                                                                                                                           |
| `lastUsedNever`             | Never                                                                                                                                                                                  |
| `unverified`                | Unverified                                                                                                                                                                             |
| `unverifiedTooltip`         | This app registered itself. Motir hasn't verified who publishes it.                                                                                                                    |
| `detailLead`                | This app can:                                                                                                                                                                          |
| `granted`                   | Granted _(visually hidden)_                                                                                                                                                            |
| `notGranted`                | Not granted                                                                                                                                                                            |
| `showScopes` / `hideScopes` | Show scopes for {app} / Hide scopes for {app}                                                                                                                                          |
| `revokeAria`                | Revoke {app} in {workspace}                                                                                                                                                            |
| `empty.body`                | No apps connected. When you add Motir to Claude, or another app that signs in with your Motir account, it appears here.                                                                |
| `empty.link`                | How to add Motir to Claude                                                                                                                                                             |
| `error.title`               | Couldn't load your connected apps.                                                                                                                                                     |
| `error.body`                | Your tokens above are unaffected. Nothing was revoked.                                                                                                                                 |
| `error.retry`               | _(reuse `common.retry`)_ Try again                                                                                                                                                     |
| `revokeConfirm.title`       | Revoke "{app}"?                                                                                                                                                                        |
| `revokeConfirm.body`        | **{app}** loses access to the **{workspace}** workspace now. Its next request is refused, and it will ask you to sign in again. Your tokens and other connected apps are not affected. |
| `revokeConfirm.workspace`   | Workspace                                                                                                                                                                              |
| `revokeConfirm.scopes`      | Scopes                                                                                                                                                                                 |
| `revokeConfirm.connected`   | Connected                                                                                                                                                                              |
| `revokeConfirm.cancel`      | Cancel                                                                                                                                                                                 |
| `revokeConfirm.confirm`     | Revoke access                                                                                                                                                                          |
| `revoked.title`             | Access revoked                                                                                                                                                                         |
| `revoked.body`              | {app} can no longer act in {workspace}. Connect it again from {app} to restore it.                                                                                                     |
| `revokeError.title`         | Couldn't revoke access                                                                                                                                                                 |
| `revokeError.body`          | Something went wrong. Please try again.                                                                                                                                                |

(The mock prints the revoked toast for Panel 1's first row: _Claude can no longer act in Motir.
Connect it again from Claude to restore it._) `zh` is owed alongside `en` by the build card, as for
every settings namespace.

### Primitives composed (no hand-rolling)

| Element                           | Primitive                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| The section                       | `Card` with the `header` slot (`ApiTokensManager`'s)                                 |
| Row list                          | the token list's `<table>` + `Th`                                                    |
| Summary / Can delete / Unverified | `Pill` — `severity="success"` · `tone="neutral"` · `severity="danger"`; no new tone  |
| Unverified explanation            | `Tooltip`                                                                            |
| Disclose · Revoke                 | the token row's two icon buttons, verbatim                                           |
| Disclosed grant                   | `PERMISSION_META` + `permissionColumnsForTokens()` (`permissionMeta.tsx`), read-only |
| Loading                           | in-page `<Suspense>`; bars under `animate-pulse`                                     |
| Error retry                       | `Button variant="secondary" size="sm"`                                               |
| Confirm                           | `Modal size="sm"` + `Modal.Footer`, `Button` ghost + danger (`loading`)              |
| Outcome                           | `useToast()` — `success` / `error`                                                   |

**No new design-system entry, no new token.**

### Token roles

| Element                     | Colour                                                                                                              | Shape                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Card                        | `--el-card` / `--el-border`                                                                                         | `--radius-card`, `--spacing-card-padding`, `--shadow-subtle`        |
| Card title · subtitle       | `--el-text` · `--el-text-muted` (on the white card — 4.54:1, allowed)                                               | —                                                                   |
| Column headers              | `--el-text-secondary`                                                                                               | `--spacing-control-y`                                               |
| App name · host             | `--el-text` · `--el-text-secondary`                                                                                 | —                                                                   |
| Workspace · project · dates | `--el-text-secondary`                                                                                               | —                                                                   |
| Summary / Unverified pills  | neutral: `--el-surface` + `--el-border` + `--el-text-secondary`; mint / rose tints + `--el-text-strong`             | `--radius-badge`, `--spacing-chip-x/y`                              |
| Tooltip                     | `--el-tooltip-bg` / `--el-tooltip-text`                                                                             | `--radius-control`, `--spacing-tooltip-x/y`                         |
| Disclose · trash buttons    | `--el-text-secondary`; hover `--el-surface` fill (trash ink → `--el-danger-on-surface`)                             | `--height-control` square, `--radius-control`, `--spacing-icon-btn` |
| Disclosed box               | `--el-surface-soft` + `--el-border-soft`; every ink on it `--el-text` or `--el-text-secondary`                      | `--radius-card`, `--spacing-control-x/y`                            |
| Granted check · danger row  | `--el-success` (graphic) · `--el-tint-rose` + `--el-text-strong` + glyph `--el-danger-on-surface`                   | `--radius-control`                                                  |
| Empty disc · link           | `--el-muted` + `--el-icon-muted` · `--el-link` / `--el-link-pressed`                                                | `rounded-full` (a disc)                                             |
| Skeleton bars               | `--el-muted`                                                                                                        | `--radius-control` / `--radius-badge`                               |
| Error glyph · text          | `--el-danger-on-surface` · `--el-text` / `--el-text-secondary`                                                      | —                                                                   |
| Confirm callout             | `--el-tint-rose`, glyph `--el-danger`, text `--el-text-strong`                                                      | `--radius-card`, `--spacing-card-padding`                           |
| Revoke access               | `Button` danger — the one element here carrying the danger FILL                                                     | `--radius-btn`, `--height-btn-md`                                   |
| Toasts                      | `--el-page-bg` + border `--el-success` / `--el-danger`, title `--el-text`, body `--el-text-muted` (white — allowed) | `--radius-card`, `--shadow-elevated`                                |

**AA, checked against the table in CLAUDE.md:** no `--el-text-muted` sits on `--el-surface`,
`--el-surface-soft` or `--el-muted` (the disclosed box and the narrow list use `--el-text-secondary`
throughout); no `--el-text-faint` carries text anywhere; danger ink on a page surface is
`--el-danger-on-surface`, and the danger-fill ink appears only inside the danger Button.

**The mock's own token block** is the base asset's, plus six Tier-3 tokens it did not need, verbatim
from `packages/design-system/theme.css`: `--el-card`, `--el-link-pressed` (+ `--color-link-pressed`),
`--el-tooltip-bg`, `--el-tooltip-text`, `--el-overlay-scrim` (light and dark values). Board chrome
(panel labels, notes, the dashed _unchanged_ slabs, the accent outline marking the new card) is
`--el-text-secondary` / `--el-text` on `--el-surface` and is not design.

### Open questions, decided here (reverse them on this asset, not in code)

1. **Section, not rail row.** Decided: a card in the Tokens pane, per the card's own access path. If
   the pane's heading should grow to name both credentials (_Tokens & apps_), that is a rename of a
   shipped rail label (MOTIR-2534's) and belongs to its own card.
2. **Page subtitle untouched.** It speaks of personal access tokens only; the new card's own subtitle
   carries its meaning. Rewriting the page subtitle is a copy change to a shipped surface outside
   this delta.
3. **Last used is relative, Connected absolute** — see the column table.
4. **No bulk "Revoke all".** GitHub offers one; at one to four connections it is a destructive
   control with little to do. Add it when a person has enough rows to want it.

### GIVES / TAKES

| card           | gives / takes | what                                                                                                                          |
| -------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-6986** | **GIVES**     | The whole surface: the card's place and anchor, the row's six columns, the disclose, every state in Panels 1–9, and the copy. |
| **MOTIR-6983** | neither       | The grant this surface renders and deletes — cited as the source of what a row shows and what Revoke does.                    |
| **MOTIR-6980** | neither       | The consent screen. Shares the _Unverified_ label and tooltip copy and the scopes vocabulary; draws nothing here.             |
| **MOTIR-6976** | neither       | Owns the motir.co _Add Motir to Claude_ page the empty state links to, and its path.                                          |
| **MOTIR-4675** | neither       | The base asset's last amendment; its rail drawing is followed, not changed.                                                   |
| **MOTIR-3580** | neither       | The picker's column rule, reused read-only in the disclosed row.                                                              |
| **MOTIR-6981** | —             | This card.                                                                                                                    |

## Pending invitations on the Members card — `members-pending-invitations--pending-list.mock.html`

A DELTA. It amends the Members card that `workspace-settings.mock.html` places on
`/settings/workspace` (and, below the reveal, inside the `/settings/organization` fold-in), whose own
drawing is `design/workspaces/workspace-roles--access-scope.mock.html`. It draws only what changes:
a **Pending invitations** block under the members list, one row per unexpired invitation, the
delivery state of each invitation's email, and a **Resend** button. The card's header, its Invite
button and the members list are copied from what ships, unchanged.

**Design system — read first.** Files read: `package.json` (depends on `@motir/design-system`
`workspace:*`, version `0.18.0` in `packages/design-system/package.json`) and `app/globals.css`
(imports `@motir/design-system/theme.css`). **Verdict: ON MOTIR DESIGN.** Built with `renderMock`
from `@motir/design-system/mock` at the default axes (`warm-editorial` · `motir`); every part is the
package's (`Card`, `Pill`, `Button`, the `Toast` and `Tooltip` markup) or the shipped Members card's
own. Nothing is missing, so nothing is proposed as an addition, and no token is added.

### Entry path

No new door. The block appears on the Members card wherever that card already renders: the
`/settings/workspace` Members pane (two or more workspaces) and the workspace fold-in on
`/settings/organization` (one workspace). A person reaches it the way they reach the members list
today. A new invitation sent from the card's Invite button appears in the block after the page
refreshes, as the newest row.

### Elements

| Element                       | What it is                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pending block**             | Under the members list, separated by a soft top rule. Heading _Pending invitations_ with a neutral count `Pill`, a mono column header _Invitation_ / _Delivery_, then the rows, newest first. Absent when there is no pending invitation. Past five rows, a ghost _Show all N pending invitations_ button reveals the rest. |
| **Pending row**               | A dashed envelope disc (no avatar: nobody has joined), the address, and a meta line: _Invited by {name}, {sent}_ · _Full_ or _Limited · N projects_ · _Expires in N days_. On its last day the expiry reads _Expires today_ with a warning clock glyph.                                                                     |
| **Delivery pill**             | A `Pill` with a glyph and a one-word state; its tooltip carries the helper line. States in the table below.                                                                                                                                                                                                                 |
| **Resend button**             | `Button size="sm"` with a rotate glyph, label _Resend_. `secondary` when the delivery state is a problem (Bounced, Complained, Failed), `ghost` otherwise. `loading` while in flight. `aria-label` _Resend the invitation to {address}_.                                                                                    |
| **Resend confirmation toast** | Success toast _New invitation sent to {address}_. The row moves to the top as _Queued_ with a fresh sent time and expiry.                                                                                                                                                                                                   |
| **Refusal messages**          | Error toasts, one per refusal: _Limit reached: 3 invitations per address per hour._ (_Try again later._) · _This person has already joined the workspace._ · _You can't resend this invitation._ · _This invitation is no longer pending._                                                                                  |
| **Scope tooltip**             | On a disabled Resend: _Only a Manager can resend a Limited invitation_.                                                                                                                                                                                                                                                     |

### Delivery states

| State      | Label        | Helper (tooltip)                    | `Pill`             |
| ---------- | ------------ | ----------------------------------- | ------------------ |
| queued     | _Queued_     | Waiting to be sent                  | tone `neutral`     |
| accepted   | _Accepted_   | The mail provider has it            | severity `info`    |
| delivered  | _Delivered_  | Reached the recipient's mail server | severity `success` |
| delayed    | _Delayed_    | The provider is still retrying      | severity `warning` |
| bounced    | _Bounced_    | The address refused it              | severity `danger`  |
| complained | _Complained_ | Marked as spam                      | severity `danger`  |
| failed     | _Failed_     | Could not be sent                   | severity `danger`  |

_Delivered_ means the recipient's server accepted it, not that it reached the inbox; the helper says
so in the words above and never claims more.

### Who sees what (Panels 1, 3, 4)

- **A Manager** sees the block and can resend every row.
- **A Full member who is not a Manager** sees the block; Resend is enabled on Full invitations and
  disabled on Limited ones, with the scope tooltip.
- **A Limited member** does not see the block at all (the card is unchanged for them).
- **No pending invitation** ⇒ no block, no empty state: the card looks as it does today.

### Resend (Panels 5, 6)

Resend sends a new email with a new link and a new seven-day expiry, and retires the earlier link.
The row keeps the original inviter's name; the sent time is the resend's. The earlier link opens as
the ordinary expired invite. The four refusals above are the only error copy: _Limit reached_ and
_You can't resend_ leave the row as it was; _already joined_ and _no longer pending_ are followed by a
refresh, which takes the row away.

### Token roles

| Element                     | Colour                                                                                                    | Shape                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Block rule · row dividers   | `--el-border-soft`                                                                                        | —                                                       |
| Heading · address           | `--el-text`                                                                                               | —                                                       |
| Count pill                  | `Pill` neutral                                                                                            | `--radius-badge`, `--spacing-chip-x/y`                  |
| Column header · meta line   | `--el-text-secondary`                                                                                     | —                                                       |
| Envelope disc               | dashed `--el-border-strong`, glyph `--el-text-secondary`                                                  | `rounded-full` (a disc)                                 |
| Expiring-soon glyph · label | glyph `--el-warning` (graphic, 3:1) · label `--el-text`                                                   | —                                                       |
| Delivery pills              | `Pill` tints (`--el-tint-sky` / `-mint` / `-peach` / `-rose`, neutral) + `--el-text-strong`               | `--radius-badge`, `--spacing-chip-x/y`                  |
| Resend                      | `Button` secondary / ghost                                                                                | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x-sm` |
| Scope tooltip               | `--el-tooltip-bg` / `--el-tooltip-text`                                                                   | `--radius-control`, `--spacing-tooltip-x/y`             |
| Toasts                      | `--el-page-bg` + border `--el-success` / `--el-danger`, title `--el-text`, body `--el-text-muted` (white) | `--radius-card`, `--shadow-elevated`                    |

**AA, checked against the table in CLAUDE.md:** every ink on the card is `--el-text`,
`--el-text-secondary` or `--el-text-strong` on a tint; `--el-text-muted` appears only as a toast body
on the white toast; no `--el-text-faint` carries text; no danger ink is painted on a page surface —
danger lives in the rose pill tint with `--el-text-strong`. Board chrome (panel labels and notes) is
`--el-text-secondary`.
