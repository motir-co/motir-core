# Story 1.3 project-UI design notes (Subtask 1.3.3 output)

This file is the canonical reference for Subtask 1.3.4 (implementation) —
which primitives compose each surface, which copy strings to use verbatim,
and the top-nav placement decision.

All surfaces are drafted in Pencil (`projects.pen`, one document, all
frames) with PNG exports for review. Open the `.pen` via Pencil to inspect
layers, variables, and annotations. The visual grammar deliberately matches
`/design/workspaces/*.png` (Subtask 1.2.1) — the project surfaces are the
direct analogue of the workspace surfaces.

---

> ### ⚠️ THE EMPTY-STATE SURFACE IS RETIRED (2026-09-08, MOTIR-4875)
>
> This file drafts four project surfaces, and one of them — the **empty state**
> (`empty-state.png`, and the _"Create your first project"_ copy in the tables
> below) — no longer exists in the product. It became `ProjectsEmptyState`, the
> Create-project screen a projectless reader was landed on inside project
> chrome, and MOTIR-4872 deleted it.
>
> **Not because it was drawn badly.** The state it served is gone: a default
> project is seeded at the WORKSPACE tier (MOTIR-4870), so
> `getActiveProject()` returns null on no path a member can take. The record
> is kept whole — this is a design record, and a surface that was right for the
> product it was drawn for should be readable as such.
>
> **The other three surfaces are unaffected**: the create modal, the switcher
> and the archive confirmation all still ship, and creating an ADDITIONAL
> project is still a real act on the switcher.
>
> `docs/decisions/home-scope.md`'s 2026-09-08 amendment carries the reasoning.

## Files

| `.pen` source                  | PNG exports                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `projects.pen`                 | `create-modal.png`, `empty-state.png`, `switcher.png`, `archive-confirm.png` |
| `inapp-plan-with-ai.mock.html` | `inapp-plan-with-ai.png` (MOTIR-1485 — the in-app AI-onboarding entry)       |

`switcher.png` is a single export holding BOTH the closed and open states
(stacked, each annotated) — matching how `/design/workspaces` documents the
workspace switcher across two states. `archive-confirm.png` holds both the
disabled (input empty) and armed (input matches) states side by side, exactly
mirroring `delete-confirm.png`.

---

## No new primitive required

Every surface composes ONLY primitives that already exist in
`components/ui/` as of Subtask 1.2.6:

- **`Modal`** (Radix-wrapped, `size="md"`) — create-project modal,
  archive-confirm modal.
- **`Input`** — name field, identifier field, typed-identifier confirm field
  (uses the `label` + `helperText` props; the identifier field uses
  `font-mono` for its value).
- **`Button`** — `variant="primary"` (Create project), `variant="ghost"`
  (Cancel), `variant="danger"` (Archive project).
- **`EmptyState`** — the empty-state surface is a near-verbatim instance of
  the shipped pattern (`Card` + lucide icon + headline + description +
  action button).
- **`Popover`** — the project switcher's open state. Popover EXISTS as of
  Subtask 1.2.6; no new primitive is needed (1.2.1 had to flag Popover as a
  NEW primitive; that gap is now closed).
- **`Card`** — implicitly via `EmptyState`.

No new component patterns are introduced.

---

## Primitives composed per surface

### Create-project modal (`create-modal.png`)

- `Modal` size="md", title `"Create project"` (serif heading, rendered by
  the `Modal` primitive's title slot).
- **Name field**: `Input label="Project name"`, placeholder `"Mobile App"`.
- **Identifier field**: `Input label="Identifier"`, value is auto-derived
  from the name (uppercased, truncated to 3–5 chars) but user-overridable.
  The displayed value uses `font-mono`. Below it, the `Input`'s `helperText`
  carries the LIVE KEY PREVIEW:
  `"3–5 uppercase characters. Work items will be keyed PROD-1, PROD-2, …"`
  The `PROD` substring is the live identifier value — it updates as the user
  types so the preview always reflects the current key.
- `Modal.Footer`: `Button variant="ghost"` Cancel + `Button variant="primary"`
  "Create project", right-aligned (`justifyContent: end`).

Implementation note for 1.3.4: the identifier auto-derive is a controlled
field — derive from name on each keystroke UNTIL the user manually edits the
identifier, after which it stops tracking the name (standard Linear/Jira
project-key behavior). The live preview string interpolates the current
identifier value, defaulting to the derived value.

### Empty state (`empty-state.png`)

- Rendered inside the `(authed)` top-nav + content shell. The active
  workspace has zero projects.
- `EmptyState` pattern: lucide `FolderOpen` icon (override the default
  `Inbox`), headline `"Create your first project"`, description, and a
  primary `Button leftIcon={<Plus />}` "Create project" that opens the
  create-project modal.
- The top-nav shows the workspace switcher (left) with the project switcher
  trigger immediately to its right reading `"No project"` (muted) since none
  exists yet.

### Project switcher (`switcher.png`, closed + open)

- **Closed state**: `Button variant="ghost"` trigger showing the active
  project name + lucide `ChevronDown`. Positioned in the top-nav BESIDE the
  workspace switcher — workspace-left, project-immediately-right, separated
  by a 1px hairline rule. The two-switcher layout is documented below.
- **Open state**: the existing `Popover` primitive, 320px wide, anchored
  below the trigger. Inside:
  - Section header: `"PROJECTS"` in `font-mono`, caps, `text-muted-foreground`,
    letter-spaced.
  - One row per project: lucide `Check` (`--color-primary`) on the active
    project + bold name + `--color-surface` row background; inactive rows are
    plain (no check, regular weight, transparent background).
  - Divider: `<div className="h-px bg-(--color-hairline)" />`.
  - "Create project" entry: lucide `Plus` + label — opens the create-project
    modal.
- The active trigger gets a `--color-primary` border + `--color-surface`
  fill while the popover is open (focus affordance), matching the workspace
  switcher's open-trigger treatment.

### Archive-confirm modal (`archive-confirm.png`, disabled + armed)

Reuses 1.2.1's `delete-confirm.png` typed-name double-confirmation grammar,
adapted for ARCHIVE (we archive, never hard-delete — work-item history is
preserved for Story 1.4):

- `Modal` size="md", **no `title` prop** — render a custom heading row
  inside the body: a lucide `TriangleAlert` icon in a `tint-rose` circle next
  to the heading `"Archive Mobile App?"` ({Project} interpolated).
- Body explains the consequence: items preserved, project hidden, restorable.
- `Input label="Type PROD to confirm"` — the user types the project
  IDENTIFIER (not the name) to enable the action. The displayed confirm value
  uses `font-mono` (identifiers are mono throughout).
- `Modal.Footer`: `Button variant="ghost"` Cancel + `Button variant="danger"`
  "Archive project".
- **The danger button is disabled (opacity 50, pointer-events none) until the
  typed input matches the project identifier EXACTLY** (case-sensitive, e.g.
  `PROD`). Two states are drawn: disabled (input empty) and armed (matches).

---

## Copy strings catalog (use verbatim in 1.3.4)

A consolidated list for grep convenience. If the implementation diverges
from these strings, update both the implementation AND this list so the
mockup stays the source of truth. `{Project}` = project display name,
`{IDENT}` = project identifier (e.g. `PROD`).

| Surface                        | String                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create modal title             | `"Create project"`                                                                                                                                                         |
| Create modal name label        | `"Project name"`                                                                                                                                                           |
| Create modal name placeholder  | `"Mobile App"`                                                                                                                                                             |
| Create modal identifier label  | `"Identifier"`                                                                                                                                                             |
| Create modal identifier helper | `"3–5 uppercase characters. Work items will be keyed {IDENT}-1, {IDENT}-2, …"`                                                                                             |
| Create modal Cancel button     | `"Cancel"`                                                                                                                                                                 |
| Create modal Create button     | `"Create project"`                                                                                                                                                         |
| Empty state headline           | `"Create your first project"`                                                                                                                                              |
| Empty state description        | `"Projects group your work items and give them a key like {IDENT}-1. Create one to start planning."`                                                                       |
| Empty state CTA button         | `"Create project"`                                                                                                                                                         |
| Switcher trigger placeholder   | (no placeholder when a project is active — shows the active project name; shows `"No project"` muted only when the workspace has zero projects)                            |
| Switcher no-project label      | `"No project"`                                                                                                                                                             |
| Switcher heading               | `"PROJECTS"`                                                                                                                                                               |
| Switcher: Create project entry | `"Create project"`                                                                                                                                                         |
| Archive confirm title          | `"Archive {Project}?"`                                                                                                                                                     |
| Archive confirm body           | `"Archiving hides this project from the switcher and lists. Its work items and history are preserved — you can restore the project later. This does not delete any data."` |
| Archive confirm input label    | `"Type {IDENT} to confirm"`                                                                                                                                                |
| Archive confirm Cancel button  | `"Cancel"`                                                                                                                                                                 |
| Archive confirm Archive button | `"Archive project"`                                                                                                                                                        |

Note: the empty-state description and the create-modal helper both reference
the work-item key shape. Use the literal default identifier `PROD` in the
empty-state copy (there is no project yet, so no real identifier exists);
interpolate the real `{IDENT}` in the create-modal helper as the user types.

---

## Top-nav placement — the minimal 1.3 form

Per the minimal-then-expand discipline 1.2.1 recorded for the workspace
switcher, the project switcher lands in its minimal 1.3 form: a second
`Popover`-backed switcher in the existing `(authed)` top-nav, placed
immediately to the RIGHT of the workspace switcher and separated by a 1px
hairline rule (`workspace-left, project-immediately-right`). The top-nav
order is therefore: workspace switcher → hairline → project switcher (left
cluster), user-menu avatar (right).

**This is intentionally minimal.** Story 1.5's app-shell Subtask moves
project navigation into a left sidebar (Linear/Notion-style), at which point
the top-nav project switcher is retired or demoted. Building the sidebar now
would be premature — Story 1.3 only needs project create / switch / archive,
which the two-switcher top-nav serves without inventing the full shell. This
mirrors how 1.2.1 shipped the workspace switcher in the top-nav knowing 1.5
would re-home it.

---

## Brand-mark deferral confirmation

Per `MOTIR.md` "Brand-mark deferral principle": no placeholder wordmark
appears on any of these surfaces. The top-nav (empty-state and switcher
frames) has NO logo slot — only the workspace switcher + project switcher
(left) and the user-menu avatar (right), identical to the 1.2.1 top-nav.

---

## Theme parity

Pencil variables are wired for light + dark via `--background`,
`--foreground`, `--surface`, `--muted-foreground`, `--hairline`,
`--hairline-strong`, `--primary`, `--destructive`, `--tint-rose`, etc.,
mirroring `app/globals.css`. The exported PNGs are light-mode renders (the
default theme). Dark-mode parity should be verified manually during 1.3.4's
smoke test by toggling `data-theme="dark"` and visiting each surface.

The `archive-confirm.png` warning icon uses `$--destructive` (`#e03131`)
inside a `$--tint-rose` (`#fde0ec`) circle — the same treatment as
`delete-confirm.png`, both with dark-mode overrides in `app/globals.css`.

---

## Source of truth

When a string in this doc disagrees with shipped 1.3.4 code, the code wins —
file a fix here so the mockup stays the source of truth. The `.pen` is the
layout-confirmation artifact; it is not generated from code and may drift
from pixel-exact production once the React lands.

---

# Roles & permissions (Story 6.4) — Subtask 6.4.1 output

Story 6.4 makes access **project-level** (not just workspace-level). This
section is the canonical reference for the code subtasks it gates —
**6.4.5** (project-settings Members + Access UI) and **6.4.6** (UI gating:
hidden projects, no-access state, scoped pickers, role affordances), both of
which carry **6.4.1** in `dependsOn`.

Unlike the rest of `design/projects/` (drafted in Pencil), this surface is an
**HTML mockup** — `access-members.mock.html`, built FROM the real design
system (the `app/globals.css` token block copied 1:1 + the shipped
`components/ui/*` primitives), with `access-members.png` as the light-mode
board render. The HTML is the source of truth; toggle `data-theme="dark"` in
it to confirm token parity. A coding agent should prefer it — there is no
Pencil→code translation gap.

## Files

| HTML source (truth)        | PNG export           |
| -------------------------- | -------------------- |
| `access-members.mock.html` | `access-members.png` |

The mockup is a **six**-panel board (review EACH): **(0)** the populated
project-admin settings view (Access + Members); **(1)** the add-member
Combobox open + a per-row role select open; **(2)** the Access control with
Private selected + the go-private note; **(3)** the no-access state;
**(4)** the role affordances (viewer disabled-with-tooltip + non-admin
read-only); **(5)** the role select once the project has **custom roles**
(MOTIR-2463 — see below).

## The role picker with CUSTOM roles — panel 5 (MOTIR-2463; **MOTIR-2485 builds it**)

[MOTIR-2257](motir:cmsgmdaim001g04joump8d6mi) lets a project author roles of
its own, and this is the surface where a person is put on one. The picker is
panel 1's, grown:

- **The three built-ins stay first, under a `Built-in` heading; the project's
  own roles are APPENDED under a `Custom roles` heading.** Not interleaved and
  not alphabetised across the two: the built-ins are the same three in every
  project and are what an admin reaches for by reflex.
- **The `Built-in` heading is drawn even when the project has NO custom roles**
  (panel 5 draws both cases side by side), so the list grows rather than
  changes shape the first time somebody creates a role.
- **Each custom option is labelled `Custom role`** — so the kind is read in
  words at the moment of the choice rather than inferred from a tint. (Not
  "based on …": nothing records which built-in seeded a role — Yue,
  2026-08-09.)

### The tint slot — why the roles asset's pairing does NOT transfer

`roles-permissions.mock.html` pairs **built-in `--el-tint-lavender`** with
**custom `--el-tint-sky`**, because on THAT surface the tile signals the
role's KIND. Here the three slots are already spent on role IDENTITY —
`pill-admin` lavender, `pill-member` sky, `pill-viewer` mint — so a custom
chip in sky would simply be a Member chip.

So a custom role's chip (`.pill-custom`) takes the next free slot,
**`--el-tint-peach` with `--el-text-strong` ink** — the same rule (hue in the
tint background, AA-safe per finding #35) applied to a slot this surface had
not used — plus the `user-round` glyph the roles asset gives the same role's
tile, so one role reads the same on both screens. **The kind is stated in
WORDS** in the picker headings, in each option's line, and in the chip's
accessible name (`Contractor — a custom role`), so nothing about
built-in-versus-custom rests on the hue.

**In code that slot is `--el-role-custom` (MOTIR-2485), not `--el-tint-peach`
directly** — and the difference is not a deviation from the asset, it is the
same recipe the three built-in chips already follow. `Pill`'s `memberRole`
tones each read a DEDICATED `--el-role-*` token (`--el-role-admin` /
`-member` / `-viewer`), every one of which defaults to the tint the mock
draws; the indirection exists so a palette can tune role chips apart from the
other meanings those tints carry. A fourth role needed a fourth token, so
`--el-role-custom: var(--color-tint-peach)` joins them in
`packages/design-system/theme.css` and the mock's `--el-tint-peach` remains
the value it resolves to. The chip is `<Pill memberRole="custom">` carrying
the role's own name as its text and the kind in its `aria-label`.

**The glyph the mock draws on the chip is NOT rendered** — the shipped
`Pill` takes no icon and no built-in role chip on this surface has ever
carried one, so adding one for custom roles alone would have made the KIND
visible as decoration on exactly the row where the notes above insist it be
carried in words. The `user-round` glyph continues to identify the role on
the roles screen's tile, where `RoleGlyph` renders it.

## Mirror product (rung 1, VERIFIED June 2026 — Atlassian docs, not asserted)

Jira team-managed projects gate by an **Access level**:

- **Open** — any site (workspace) member can view **and edit**.
- **Limited** — any workspace member can view **and comment**, but only
  project members can edit.
- **Private** — only people explicitly added to the project (via a project
  role) can find or open it; hidden from everyone else.

Setting a project **private keeps the people who currently have access**
(Jira seeds them as members) rather than emptying it and locking the owner
out. Assignable users on a private project are scoped to **project members**.
We mirror this three-level team-managed model (the simpler, more direct fit
for Motir's workspace→project shape).

**Migration defaults (no lockout):** existing projects default to **open** so
every current workspace member keeps access on deploy; **workspace
owner/admin always have access** regardless of project membership.

## Composing primitives (no new primitive required)

Every surface composes primitives already in `components/ui/` — nothing new:

- **`Card`** — the Access card and the Members card (header slot + body); the
  no-access panel is the `ErrorState`/`EmptyState` family (`Card` + lucide
  icon + serif headline + muted description + action `Button`s).
- **`Combobox`** — the **add-member** picker (trigger `+ Add a member…`,
  search field, option rows showing avatar + name + email, footer note
  "Members already on the project are hidden") **and** the per-row **role
  select** (`Admin` / `Member` / `Viewer`, each with a one-line description,
  selected row shows the `--el-accent` check). Both are the shipped Combobox
  trigger (`--height-control`, `--radius-input`, `ChevronsUpDown`) + elevated
  menu (`--shadow-elevated`, `--radius-card`).
- **`Pill`** — the role chip on the owner row + the read-only views
  (`Admin` → `--el-tint-lavender`, `Member` → `--el-tint-sky`, `Viewer` →
  `--el-tint-mint`, all with `--el-text-strong` text — AA-safe per finding
  #35), the member-count chip + the `Read-only` chip (`tone="neutral"`), and
  the access-level summary chip.
- **`Button`** — `primary` (Back to projects / disabled New issue),
  `secondary` (Request access), `ghost` (Remove).
- **`Tooltip`** — the disabled-affordance explainer (`--el-text` ink bg,
  `--el-text-inverted` text); a viewer's create/edit controls stay **visible
  but disabled** with this tooltip, never absent-and-confusing.
- The **Members row** extends the shipped workspace
  `MembersCard.tsx`: same avatar (ink `--el-text` circle + inverted initial,
  matching the shipped component — guaranteed AA) + name/email + trailing
  role chip grammar, with the per-project **role select** + **Remove** added.
  The owner row shows an `Admin` Pill + a disabled `Owner` affordance (the
  owner's role is not editable).

## The Access-level control

Three stacked radio cards (`open` / `limited` / `private`), each a tinted
icon tile + title + one-line explanation + a radio. Icons take their meaning's
hue via a pastel tint (`--el-tint-mint` globe = open, `--el-tint-sky` eye =
limited, `--el-tint-lavender` lock = private) with `--el-text-strong` glyphs.
The selected card carries the `--el-accent` border + filled radio. Selecting
**Private** reveals the **go-private note** (an `--el-tint-sky` info callout):
"the N people who can currently access this project will be added as members
so no one loses access" — the visible counterpart of 6.4.4's seeding.

## Gating affordances (6.4.6)

- **Hidden projects** — the switcher/nav omits projects the user can't browse
  (a private project they're not on is absent, not shown-then-denied).
- **No-access state** — a direct link to an inaccessible project's
  board/issues renders the ErrorState-family panel ("You don't have access to
  this project", lock icon, `Request access` + `Back to projects`), driven off
  the 6.4.3 `ProjectAccessDeniedError` — never a crash.
- **Scoped pickers** — assignee/reporter pickers list only **project members**
  on a private project (workspace members on open/limited).
- **Role affordances** — a viewer (or a member on a `limited` project) is gated
  by control TYPE (PM directive, 2026-06-09 — supersedes the earlier
  "everything disabled+tooltip" line; code is the reference per the footer):
  - **In-place controls stay visible-but-disabled, as a hint** — the **Create**
    button + the **`C` / ⌘K** shortcut, the **board** (drag disabled + a
    read-only banner), and the issue-detail **inline field pickers**
    (status / assignee / priority / …). Disabled, not removed, so the viewer
    sees _that_ the action exists and _that_ they lack rights.
    **UNCHANGED by the 2026-08-08 amendment below.**
  - **Navigation-to-an-edit-surface is HIDDEN, and the surface itself is
    blocked** — the issue-detail **"Edit"** link (header + per-section
    Description / Explanation edit links) and the relationships **add / remove**
    controls are **not rendered** for a read-only actor, and a direct nav to
    `/items/[key]/edit` **redirects back to the read-only detail view** (a
    viewer has no reason to land on an edit form; the server rejects the save
    regardless). A hidden Edit button + a guarded edit route is the
    mirror-product (Jira) behaviour.
    **UNCHANGED by the 2026-08-08 amendment below** — and generalised by it.
  - ~~A non-admin sees Members + Access **read-only** (a `Read-only` chip + an
    info line "Only project admins can add members or change access").~~
    **SUPERSEDED 2026-08-08** — see the amendment immediately below. The
    sentence is kept, struck, rather than deleted, so a reader who arrives
    holding it can tell it was retired on purpose and on what date. **Reason:**
    it was written when a project role was a RANK (admin / member / viewer), and
    in that world a read-only Members screen was the more informative of two
    poor options — the alternative was a door that vanished with no explanation
    and no way to ask about it. `project:administer` has since been split into
    twelve per-domain administrative permissions (MOTIR-2256) and a role is now
    a permission SET a person deliberately composed, so a missing entry is no
    longer a mystery: it is simply not part of the role someone was given. The
    reasoning expired; the sentence did not become false, it became obsolete.

## Amendment 2026-08-08 — hide the entry point, disable the in-place control, guard the destination

**Author:** MOTIR-2462, under Story MOTIR-2258 (_Permission-gated UI_).
**Amends:** the _Role affordances_ bullet list above, and only its third bullet.
**Scope:** which affordance families are HIDDEN and which stay visible-and-disabled.
It does **not** re-open the in-place treatments the 2026-06-09 directive settled —
this amendment widens the hidden set and leaves the disabled set exactly as it is.

### The rule, in three parts

1. **HIDE an entry point** whose destination the actor cannot use at all — a
   settings rail row, a settings AREA door, a command-palette action, a
   project-nav row, a menu item. An entry point is a promise about a room; if
   the room is closed to you, the honest interface does not draw the door.
2. **DISABLE with a tooltip an in-place control** on a surface the actor CAN
   see. There the control is what TEACHES the action exists, so removing it
   removes the only explanation the actor would ever get. It stays visible,
   disabled, and says why.
3. **GUARD every hidden destination on the server.** Hiding is presentation and
   never enforcement. A direct navigation to a hidden route renders the
   no-access state or redirects — exactly as `/items/[key]/edit` already does
   for a read-only actor — and the write behind it is refused by its own
   service gate regardless of what the interface drew.

The dividing line, stated once so it can be applied to a surface this table does
not list: **hide when the actor has no path to the destination and no need to
know it exists; disable when the actor is already standing on the surface and
the control is the only thing that would tell them the action exists.**

### Treatment table — every affordance family the product ships today

| #   | Affordance family                                                                                                            | Treatment                                                         | Why                                                                                                                                                                                                                               | Shipped today                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Settings rail entry** — one row per `PROJECT_SETTINGS_NAV` entry (`lib/settings/projectSettingsNav.ts`)                    | **HIDE**                                                          | The row's only purpose is to open a page; a page the role cannot use has no door to draw.                                                                                                                                         | The registry already filters (`visibleSettingsNav`), but 11 of 12 entries gate on `canBrowse`, so today a member sees nearly all of them.             |
| 2   | **Settings AREA door** — the sidebar `Settings` row that enters `/settings/project` (`SidebarNav.tsx`, the `bottom` section) | **HIDE when every entry inside filters away**                     | An area door that opens onto an empty rail is worse than no door: it promises a room and delivers a corridor.                                                                                                                     | Always rendered when a project is active. `groupSettingsNav` already drops an EMPTY GROUP; the area door is the same rule one level up.               |
| 3   | **Command-palette action** — the `settings-<id>` deep links in `AppCommandPalette.tsx`                                       | **HIDE**                                                          | ⌘K is the same door with a different handle. It reads the SAME registry, which is what stops the two from drifting.                                                                                                               | Reads `visibleSettingsNav(caps, PROJECT_SETTINGS_ROUTES)` — inherits row 1 automatically.                                                             |
| 4   | **Project-nav entry** — Dashboard / Work items / Ready / Boards / Roadmap / Plans / Backlog / Triage / Reports / Code health | **HIDE** the entries whose destination refuses the actor outright | Same reason as row 1. Note the qualifier: most of these are READ surfaces, so most stay for any actor who can browse — this row hides the ones whose page has nothing to show a role that cannot reach it, not the nav wholesale. | Ungated: every row renders for anyone with an active project.                                                                                         |
| 5   | **Work-item ⋯ action row** — `WorkItemActionsMenu` (Edit / Expand / Re-plan / Add to sprint / Copy link / Archive / Delete)  | **HIDE**                                                          | A menu row is an entry point, and this menu is only ever opened by someone already on the surface — the surface itself is the teaching, not the row.                                                                              | **Already correct.** The component's own comment states the rule: a user without a capability "does NOT see that row (hidden, never shown-disabled)". |
| 6   | **In-place field control** — the issue-detail inline pickers (status / assignee / priority / due date / estimate)            | **DISABLE**                                                       | The control IS the explanation. `CoreFieldsPanel` puts it plainly: disabling "makes the affordance honest rather than letting a viewer edit then bounce off a 403".                                                               | **Already correct** — `readOnly = !canEdit` in `CoreFieldsPanel.tsx`. UNCHANGED.                                                                      |
| 7   | **Board drag**                                                                                                               | **DISABLE** + the read-only banner                                | Ditto, at board scale: the banner is what tells a viewer the board is normally interactive.                                                                                                                                       | **Already correct** — `BoardContainer.tsx` renders a `role="status"` `readOnlyBoardBanner` and passes `canEdit` to the card. UNCHANGED.               |
| 8   | **Create button** — the top-bar `+`, the `C` shortcut, the ⌘K create action                                                  | **DISABLE** + tooltip                                             | The single most-used action in the product; a viewer who cannot find it at all cannot tell whether they lack the right or the product lacks the feature.                                                                          | **Already correct** — `CreateIssueButton.tsx` renders a `Tooltip`-wrapped `aria-disabled` span when `!canEdit`. UNCHANGED.                            |
| 9   | **Issue-detail Edit link** — the header link and the per-section Description / Explanation edit doors                        | **HIDE** (destination guarded)                                    | It navigates to an edit SURFACE — an entry point, not an in-place control.                                                                                                                                                        | **Already correct** — `editHref={canEdit ? … : undefined}` in `app/(authed)/items/[key]/page.tsx`, and `/items/[key]/edit` redirects. UNCHANGED.      |

Read the table as a whole and the amendment is small: rows 5–9 already follow
the rule, and what actually changes is rows 1–4 — the settings rail, its area
door, the palette links it feeds, and the project nav. The 2026-06-09 directive
got the ROOM right and the DOORS wrong, because in an admin-versus-member world
there was only ever one door to get wrong.

### Mirror evidence (rung 1) — what was OBSERVED, per product

Each row below records what was actually read on the date given, not what is
believed about the product. Where a product's documentation does not answer the
question, that is recorded as such rather than filled in from memory.

| Product                                                                           | What was observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Jira** (team-managed)                                                           | _"Today, space settings are completely hidden from non-admin users."_ Atlassian is **exploring** read-only visibility for some settings pages — i.e. hidden is the shipped behaviour and read-only is a proposal, not a product. The same article names the cost of hiding, honestly: a member "has to ask the administrator" what a field or workflow does.                                                                                                                                                                             | [Help us decide which space settings your team members should see](https://community.atlassian.com/forums/Jira-Cloud-Admins-articles/Help-us-decide-which-space-settings-your-team-members-should-see/ba-p/3261424) (Atlassian, 2026-07-14)                                                                                                                                                                                                                                     |
| **Plane** (open source; shipped custom roles + a permissions redesign 2026-04-25) | Read in source, since the docs do not state the UI treatment. Each project-settings nav item declares `access: [EUserProjectRoles…]`, and the sidebar filters: `const accessibleItems = categoryItems.filter((item) => allowPermissions(item.access, EUserPermissionsLevel.PROJECT, …)); if (accessibleItems.length === 0) return null;` — **items the role lacks are omitted, and a CATEGORY with nothing left renders nothing at all.** That second half is row 2 of our table, already shipped by the closest open-source equivalent. | `makeplane/plane` — [the project-settings constants](https://github.com/makeplane/plane/blob/preview/packages/constants/src/settings/project.ts) · [the settings-sidebar categories](https://github.com/makeplane/plane/blob/preview/apps/web/core/components/settings/project/sidebar/item-categories.tsx) · [changelog 2026-04-25](https://plane.so/changelog/2026-04-25-custom-roles-granular-access-permissions-redesign) (the two source links are Plane's tree, not ours) |
| **GitHub**                                                                        | A repository's **Settings** tab is admin-only, and a direct URL does not render a read-only form — it 404s. From the community thread: _"The 404 is GitHub's way of saying 'this page doesn't exist for your permission level.'"_ GitHub goes one step further than this amendment does (it hides the destination's EXISTENCE); we render the no-access state instead, because a Motir project member already knows the project exists.                                                                                                  | [community discussion #179083](https://github.com/orgs/community/discussions/179083) · [Managing teams and people with access to your repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-teams-and-people-with-access-to-your-repository)                                                                                                                                                |
| **Linear** (the counter-example — no custom roles)                                | A guest "cannot see or discover any other teams in the workspace" and cannot see workspace-wide features at all: the nav is filtered to what the role holds rather than shown-and-refused. Useful only as a third data point on nav treatment; Linear has no per-domain role model to mirror.                                                                                                                                                                                                                                            | [Members and roles](https://linear.app/docs/members-roles) · [Guest accounts changelog](https://linear.app/changelog/2022-07-14-guest-accounts)                                                                                                                                                                                                                                                                                                                                 |

Three of four hide the entry point; none of the four ships a read-only settings
screen for a role that cannot use it, and the one product publicly considering
one (Jira) frames it as a NEW capability rather than as the status quo. That is
the evidence the amendment rests on.

### What this amendment deliberately does NOT do

- It does not assign permission KEYS to surfaces. Which of the 31 catalog keys
  (`lib/permissions/catalog.ts`) gates each row is each implementing card's own
  work, decided against that surface's own server guard — because a key chosen
  here, away from the call site, is exactly the kind of claim that gets written
  down without being checked.
- It does not weaken any gate. Every row that changes is a change to what is
  DRAWN; the service- and route-level refusals behind them are untouched, which
  is what rule 3 exists to keep true.
- It does not treat "the actor cannot use this" as a UI-only fact. A row that
  hides without a matching server guard is a bug, not a shortcut.

## Amendment 2026-09-25 — three surfaces the treatment table did not rule on

**Author:** MOTIR-6326, under epic MOTIR-6164. **Extends:** the treatment table in
§ _Amendment 2026-08-08_ above, with rows **10–12**. **Mock:**
`permission-gated-ui--uncovered-surfaces.mock.html`, a DELTA of `permission-gated-ui.mock.html`
(six panels and a trace table, drawn as a Viewer beside a Member). **Found by:** the
permission-gating inventory, `docs/permissions/ui-gating-inventory.md` (story MOTIR-6166), which
marked five rows **NEEDS DESIGN** because no row of the table covered them.

The three-part rule does not change: hide an entry point, disable an in-place control with its
reason, guard every destination on the server. This section applies the rule's own dividing line to
three surfaces the 2026-08-08 table did not list. Two of the answers reuse an existing row's
treatment at a different scale, and the third is plain row-1 HIDE. **No new treatment is
introduced.**

### Drawn against a render

`/items` (list and tree), `/backlog` and `/boards` were rendered as a project Viewer and a Member on
`origin/main` @ `936c17022`, seeded with `tests/e2e/_helpers/permission-gated-ui-seed.ts`. The
render confirmed what the inventory said and added two facts the card did not have:

- **A Viewer's `/items` list and a Member's are pixel-identical** except for the faded
  **New work item** button. The Member's row holds five edit triggers (Priority, Assignee,
  Estimate, Points, Status); the Viewer's holds none. Nothing on the page says the difference is a
  permission.
- **The board card is not an `EstimateBadge` call site.** `BoardCard.tsx` renders its own static
  `.pts` span for every actor (the badge's own call-site comment explains why). So row B45's "board"
  limb has no read-only state to explain (panel 4).
- **Title is not inline-edited** in the shipped list. The inline set is status, assignee, priority,
  due and estimate (`IssueInlineEdit.tsx`), plus the Points badge. Rows B46 / A29 name "title…"
  loosely.

### Treatment table — rows 10–12

| #   | Affordance family                                                                                                                                                                      | Treatment                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Shipped today                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | **Collection inline cell** — the `/items` list and tree cells a Member edits in place (status / assignee / priority / due / estimate, `IssueInlineEdit.tsx`; the Points badge, row 11) | **DISABLE at the surface** — each cell renders its plain value, and the PAGE carries one read-only notice (row 7's grammar)                                       | It is an in-place control on a surface the actor can see, so row 6's reasoning holds: something has to teach that the action exists. But the control repeats on every row. A per-cell disabled trigger would add five `aria-disabled` tab stops per row, each announcing the same sentence, so a keyboard user pays for the reason on every row. Row 7 already settled this at collection scale: the board's cards simply do not drag, and one `role="status"` banner says why. The row the actor opens (quick view, detail page) then carries the per-field reason (row 6, shipped by MOTIR-6173).                             | **GAP.** The cells render their plain value (the provider returns a null context without `work_item:edit`) and nothing on the page says why. There is no notice.                                        |
| 11  | **Inline estimate badge** — `EstimateBadge` where it sits in a collection: the backlog row and the list's Points column                                                                | **DISABLE at the surface** — the badge keeps its shipped read-only arm, and the host surface carries the notice (row 10's list notice; the backlog gains its own) | Same scale argument as row 10. There is also a reason specific to the badge: its read-only arm is what EVERY actor sees in a project that estimates in Time or Issue count. A reason drawn on the chip would be false for a Member in those projects, so the chip cannot carry it. The item page rail and the quick view are row 6, not this row: there the field is always story points (`forceStoryPoints`), so a per-field reason is never wrong. Today those two surfaces draw no reason either, which is an implementation miss against row 6 filed as MOTIR-6338. The board card is not this family (panel 4).            | **GAP.** The static chip with no reason, on both the backlog and the list.                                                                                                                              |
| 12  | **Onboarding resume door** — the sidebar **Resume onboarding** row and its ⌘K twin (`SidebarNav.tsx`, `AppCommandPalette.tsx`)                                                         | **HIDE** unless the actor holds `ai:plan`; **GUARD** the destination with a redirect                                                                              | It is an entry point (row 1's family) to a flow whose writes the actor cannot make: every discovery answer goes through `aiChatService` and the design step through `aiPreplanService.saveDesignChoice`, and both assert `ai:plan`. For a Viewer the door is not "the highest-priority next action" (the row's own comment); it is a promise the product refuses at the first answer. The in-progress STATE still decides whether the door exists at all. The KEY decides whether this actor gets it. The shipped comment "a state, not a permission" is half right: it is both, exactly as the "Plan with AI" pill already is. | **GAP.** Gated on AI configured, an active project and an unfinished onboarding, with no key. The palette's own comment calls it "a state, not a permission". The destination does not check `ai:plan`. |

### Row 10 / 11 — the notice, and where it goes

- **Markup:** the shipped board banner, verbatim: `role="status"`, `rounded-(--radius-card) border
border-(--el-border) bg-(--el-surface) px-(--spacing-card-padding) py-(--spacing-control-y)
text-sm text-(--el-text-secondary)` (`BoardContainer.tsx`). **No new primitive.** If the
  implementing card extracts it into a shared component, it replaces the board's two copies too, so
  there is one banner rather than three.
- **Placement:** between the page's toolbar and its content (the table on `/items`, the first
  region on `/backlog`). On `/items` it belongs to the PAGE, so the List / Tree switch neither moves
  nor repeats it (panels 1–2).
- **Keyed on the capability the page's writes assert**, read through `useProjectAccess`:
  - `/items`: shown when `!can('work_item:edit')`, the exact condition under which
    `IssueInlineEditProvider` already returns its null context. One predicate, two readers.
  - `/backlog`: shown when `!can('work_item:edit')` (the badge and the inline create); otherwise
    when `!can('sprint:manage')`, with the second copy string. The second case is the partial role
    MOTIR-6174 left unexplained: it hid the drag, the selection box, the ⋯ menu and Create sprint
    for an actor without `sprint:manage` and said nothing (panel 3, third column). A Member holding
    both keys sees no notice.
- **Not shown on an empty `/items`:** the first-run state (`design/work-items/items-first-run.mock.html`
  panel 3, MOTIR-5540) already drops the create action for an actor who cannot create, and with no
  cells there is no read-only state to explain.
- **The cells are NOT changed.** A Viewer's cell stays a plain, unfocusable value, as it ships.

### Row 12 — the guard

A direct navigation to `/onboarding/discovery` (`ONBOARDING_RESUME_PATH`) by an actor without
`ai:plan` **redirects**. It reuses the page's own exit for a finished onboarding:
`onboardingReturnHref(…) ?? '/roadmap'`, the `onboardingRanAt` branch (panel 6). This is the
redirect precedent `/items/[key]/edit` set for an edit surface, not the base asset's no-access
screen. The page is a workspace to act in, and it already has a "nothing for you to do here" exit,
so there is no new screen and no new copy. The server refusals stay what rule 3 relies on.
The other `/onboarding/*` pages are the same family. The implementing card reads each page's writes
and applies the same guard where they assert `ai:plan`.

**Where the key is read.** The (authed) layout already computes `showPlanWithAi` from
`satisfiesRequirement(AI_PLANNING_REQUIREMENT, held)`. `resumeGateEnabled` takes the same boolean,
so the client never fetches `/api/ai/pre-plan` for an actor who could not use the answer. The ⌘K
twin moves under the same `satisfiesRequirement` check as "Plan with AI" beside it. With both AI
actions gone, the **AI** heading goes too: the shipped "a heading with nothing under it" rule
already does that.

**Hiding takes no capability away.** An actor without `ai:plan` could not resume the onboarding
before this change (the first answer is refused), so nothing needs relocating. The session is still
there for a teammate who holds the key.

### Copy (`projectAccess.*`, both catalogues)

| Key                       | en                                                                                                      | zh                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `readOnlyItemsBanner`     | Read-only access — you can view these work items but can’t edit them.                                   | 只读访问——你可以查看这些工作项，但无法编辑。                         |
| `readOnlyBacklogBanner`   | Read-only access — you can view the backlog but can’t rank, estimate or edit work items.                | 只读访问——你可以查看待办列表，但无法排序、估算或编辑工作项。         |
| `noGroomingBacklogBanner` | You can edit work items here, but ranking them and planning sprints needs permission to manage sprints. | 你可以在这里编辑工作项，但排序和规划 Sprint 需要管理 Sprint 的权限。 |

The first two follow the shipped `readOnlyBoardBanner` sentence shape (_Read-only access — you can
view … but can’t …_) and its zh twin. Row 12 adds no copy.

### Inventory rows this disposes of

The implementing card marks each of these in `docs/permissions/ui-gating-inventory.md`, moving it
from **NEEDS DESIGN** to its treatment, owned by that card:

| Inventory row                                   | Disposed of by                                   | Treatment                                                                                              |
| ----------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **B46** — `/items` list + tree inline cells     | row 10                                           | DISABLE at the surface: `readOnlyItemsBanner`, cells unchanged                                         |
| **A29** — list inline-edit cells                | row 10 (the inventory already says "see B46")    | as B46                                                                                                 |
| **A37** — status cell (list inline edit)        | row 10 (the inventory already says "see B46")    | as B46                                                                                                 |
| **B45** — inline estimate badge                 | row 11 (backlog, list); panel 4 (board, no work) | DISABLE at the surface: the list is covered by B46's strip; the backlog gains its own, in two variants |
| **D76** — sidebar Resume onboarding (+ ⌘K twin) | row 12                                           | HIDE on `ai:plan` + redirect guard on `/onboarding/discovery`                                          |

### Tokens & a11y

Every product colour in the mock is an `--el-*` token and every shape an element-semantic token. The
token block and the review chrome are copied 1:1 from `permission-gated-ui.mock.html`. Seven Tier-3
tokens it did not need are added, each defined as `packages/design-system/theme.css` defines it
(the priority tints, `--el-text-identifier`, `--el-accent-on-surface`, `--el-icon-muted`,
`--el-icon-active`). The notice's ink is `--el-text-secondary` on `--el-surface`: the shipped
banner's pair, which clears AA in both themes. The notice is `role="status"`, so a screen reader
announces the reason once per page rather than once per cell.

### Source of truth

As in the base asset: when a string or structure here disagrees with shipped code, **the code
wins**, except that the RULE (this section's rows 10–12, and the 2026-08-08 table they extend) is a
SPEC. On the day it landed, the shipped code disagreed with all three rows by construction, and that
disagreement is the implementing card's work.

## Tokens & a11y

Colour is `--el-*` only (no Tier-0 `--color-*`); shape is the element-semantic
tokens (`--radius-card/-input/-badge/-control/-btn`, `--spacing-card-padding`
/ `-control-*` / `-chip-*` / `-btn-x`, `--height-control/-btn-*`,
`--shadow-card/-elevated`) so the `data-display-style` swap reshapes it.
Coloured chips/tiles carry the hue in the **tint background** with
`--el-text-strong` text (AA-safe, finding #35); avatars are the ink circle
from the shipped `MembersCard`. `rounded-full` is used only for the avatar
and the radio dot.

## Source of truth

When a string here disagrees with shipped 6.4.5 / 6.4.6 code, the code wins —
file a fix so the mockup stays the reference. `access-members.mock.html` is
the layout-confirmation artifact; it may drift from pixel-exact production
once the React lands.

**One carve-out, and it is load-bearing: the _Amendment 2026-08-08_ section
above is a SPEC, not a description.** It states what the interface must become,
and on the day it landed the shipped code disagreed with rows 1–4 of its
treatment table by construction — that disagreement is the work Story MOTIR-2258
exists to do, not drift to file a fix against. Read the code-wins rule as
governing everything that DESCRIBES a surface; an amendment that carries a date,
a reason and the card that owns it governs the code until that card ships.

---

# Custom fields — Fields admin (Story 5.3) — Subtask 5.3.4 output

Story 5.3 adds per-project **custom field definitions** (Text / Number / Date /
Select / User) managed at **Project settings → Fields**. This section is the
canonical reference for code subtask **5.3.6** (the Fields admin UI), which
carries 5.3.4 in `dependsOn`. The companion rail surface (values on the issue
detail) is **5.3.5** → `design/work-items/custom-fields.mock.html`.

Like the 6.4.1 surface above, this is an **HTML mockup** —
`fields.mock.html`, built FROM the real design system (the `app/globals.css`
token block copied 1:1 + shipped `components/ui/*` primitives), with
`fields.png` as the light-mode board render. The HTML is the source of truth;
toggle `data-theme="dark"` in it to confirm token parity.

## Files

| HTML source (truth) | PNG export   |
| ------------------- | ------------ |
| `fields.mock.html`  | `fields.png` |

The mockup is a seven-panel board (review EACH): **(0)** the settings hub with
the new Fields card; **(1)** the populated project-admin field list; **(2)**
the empty state + the 50-field cap state; **(3)** the create-field modal with
the five-type picker (Select chosen → initial options); **(4)** the edit-field
modal — immutable type + the full options editor + the 55-option cap;
**(5)** the delete-field confirm naming the value count; **(6)** the non-admin
read-only state + loading skeleton + ErrorState.

## Mirror product (rung 1, VERIFIED June 2026 — Atlassian team-managed docs)

- **Five types**, each a verified member of Jira's team-managed set: Short
  text / Number / Date / Dropdown / People → our **Text / Number / Date /
  Select / User**. Team-managed Dropdown is **single-select only** (multi is
  the separate Checkbox type — a documented extension, not a cut).
- **Caps**: 50 fields per project, 55 options per field (the documented Jira
  limits). Both drawn: Add disabled + explanatory line, count pill `N / 50`.
- **Field delete is HARD** (no trash): immediate, permanent, destroys values —
  the confirm names the value count.
- **Options**: rename + reorder freely; an **in-use option archives** (hidden
  from new selection, existing values keep rendering); **delete only when
  unused** (the verified "Optimize" rule; the DB `Restrict` backstops).

## Composing primitives (no new primitive required)

- **`Card`** — the field-list card (header + flush body) and the hub cards.
  The **hub card** reuses the `MembersSettingsCard` grammar verbatim
  (`Card p-0` + whole-row `Link` + `ChevronRight`), placed **after Estimation,
  before Access & members** (field config groups with the issue-config cards;
  Archive stays last).
- **Field rows** — the members-row grammar (avatar slot → a **tinted type
  tile**) + the board-settings **grip** reorder grammar (3.6;
  keyboard-operable via the same dnd pattern). Label stacks over the gloss
  (`Type · option count · usage`; "not used yet" at zero). Row actions =
  ghost-sm `Edit` / `Delete`.
- **`Modal`** — create / edit (size md, ghost Cancel + primary confirm — the
  create-project grammar) and the delete confirm (the archive-confirm
  heading: `TriangleAlert` in a `--el-tint-rose` circle + `danger` confirm;
  **no typed-identifier arm step** — the value count is the consequence
  statement, fetched fresh when the confirm opens).
- **Type picker** — the 6.4.1 access radio-card grammar: tile + name +
  one-liner + radio; selected = `--el-accent` border + filled radio. The
  **type is immutable after create** (edit shows a frozen tile row + helper
  "The type can't be changed after the field is created").
- **Options editor** (select fields, inside create/edit) — option rows with
  grip / inline rename (`--el-accent` focus border + Save) / `Archive` ·
  `Unarchive` / `Delete`; in-use delete is **disabled with the Tooltip**
  ("In use on N issues — archive instead"); archived rows are muted +
  `Archived` neutral pill + "hidden from new selection", lose their grip, and
  sit last. Footer: ghost-sm `Add option` + the `N / 55` cap gloss.
- **`Pill`** — count chip (`pill-neutral`, `5 / 50`), `Archived`
  (`pill-neutral`), `Read-only` (the mint chip, the 6.4 grammar).
- **`EmptyState` / `ErrorState`** — "No custom fields yet" (lucide
  `SlidersHorizontal`) and "Couldn't load fields" + Retry; the loading
  skeleton extends the settings skeleton.

## The per-type glyph map (SHARED with 5.3.5 — keep the two surfaces in sync)

| Type   | lucide glyph        | tile tint            |
| ------ | ------------------- | -------------------- |
| Text   | `Type`              | `--el-tint-sky`      |
| Number | `Hash`              | `--el-tint-peach`    |
| Date   | `Calendar`          | `--el-tint-mint`     |
| Select | `SquareChevronDown` | `--el-tint-lavender` |
| User   | `CircleUserRound`   | `--el-tint-rose`     |

Glyphs render in `--el-text-strong` on the tint background (AA-safe, finding
#35; palette beyond grey+primary, finding #54). On the rail (5.3.5) the same
glyph map applies; the tile is the admin-page presentation.

## Copy strings catalog (use verbatim in 5.3.6; i18n under `settings.customFields`)

| Surface               | String                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub card title        | `"Fields"`                                                                                                                                                                              |
| Hub card description  | `"Custom fields that issues in this project can carry — like severity, customer, or a go-live date."`                                                                                   |
| Page title            | `"Fields"`                                                                                                                                                                              |
| Page subtitle         | `"Custom fields that issues in {projectName} can carry, alongside the built-in ones. Fields belong to this project only."`                                                              |
| List card title       | `"Custom fields"` (+ count pill `"{n} / 50"`)                                                                                                                                           |
| Add button            | `"Add field"`                                                                                                                                                                           |
| Usage gloss           | `"used on {n} issues"` / `"not used yet"`                                                                                                                                               |
| Empty headline        | `"No custom fields yet"`                                                                                                                                                                |
| Empty description     | `"Custom fields capture project-specific details — like severity, customer, or a go-live date — on every issue in this project."`                                                       |
| Field-cap tooltip     | `"This project has reached the 50-field limit"`                                                                                                                                         |
| Field-cap info line   | `"A project can hold up to 50 custom fields. Delete a field to add another."`                                                                                                           |
| Create modal title    | `"Create field"`                                                                                                                                                                        |
| Label field           | `"Label"` + helper `"Shown on issues and in filters."`                                                                                                                                  |
| Type section          | `"Type"` + helper `"The type can't be changed after the field is created."`                                                                                                             |
| Type one-liners       | Text `"A short line of text."` · Number `"A numeric value."` · Date `"A calendar date."` · Select `"One option from a list you manage."` · User `"A person who can view this project."` |
| Description field     | `"Description (optional)"` + placeholder `"What this field is for…"`                                                                                                                    |
| Create / save buttons | `"Create field"` / `"Save changes"` / `"Cancel"`                                                                                                                                        |
| Edit modal title      | `"Edit field"`                                                                                                                                                                          |
| Options section       | `"Options"` · `"Add option"` · cap gloss `"{n} / 55"` / `"55 / 55 — a field can hold up to 55 options"`                                                                                 |
| Option archive states | `"Archive"` / `"Unarchive"` · pill `"Archived"` · gloss `"hidden from new selection"` · `"used on {n} issues"`                                                                          |
| In-use delete tooltip | `"In use on {n} issues — archive instead"`                                                                                                                                              |
| Delete confirm title  | `"Delete {Field}?"`                                                                                                                                                                     |
| Delete confirm body   | `"Deletes the field and its values on {n} issues. This can't be undone."` (zero values: `"Deletes the field. No issues hold a value for it."`)                                          |
| Delete confirm button | `"Delete field"`                                                                                                                                                                        |
| Read-only chip + line | `"Read-only"` · `"Only project admins can manage fields."`                                                                                                                              |
| Error state           | `"Couldn't load fields"` · `"Something went wrong on our side. Try again."` · `"Retry"`                                                                                                 |

## Read-only degradation (differs from the viewer's board — deliberately)

A non-admin sees the list with the mutation affordances **absent** (no Add
field, no grips, no Edit/Delete) + the `Read-only` pill + the quiet permission
line — the 6.4 members-page degradation. Unlike the viewer's board (where
disabled-with-tooltip keeps the gate legible), every control on this page IS a
mutation, so hiding is the right shape. Reads stay open to members/viewers —
the rail needs the definitions.

## Deliberate non-features (the documented extension slots — do NOT build)

- No **required** flag, no **work-type layouts**, no **create-form
  placement** — the layout-config admin subsystem is 6.5's settings-hub
  extension; values are editable the moment an issue exists via the rail.
- No further types (paragraph / checkbox-multi / labels / multi-person /
  formula) — additive on the same EAV substrate, out of 5.3's scope.
- The **key** (machine slug) is generated from the label and immutable; it is
  deliberately NOT shown in this UI (an internal handle for revision diffs +
  Epic-6 predicates, not an admin concern).

## Tokens & a11y

Colour is `--el-*` only; shape via the element shape tokens
(`--radius-card/-modal/-input/-btn/-control/-badge`,
`--spacing-card-padding/-btn-x/-input-x/-chip-*/-tooltip-*`,
`--height-btn-sm/-btn-md/-input`, `--shadow-card/-elevated/-modal`).
Reorder must be keyboard-operable (the board-settings dnd precedent); the
delete confirm is focus-managed; tooltips on disabled controls need a
focusable wrapper. `rounded-full` only on the radio dot. Dark parity verified
by toggle.

## Source of truth

When a string here disagrees with shipped 5.3.6 code, the code wins — file a
fix so the mockup stays the reference. `fields.mock.html` is the
layout-confirmation artifact; it may drift from pixel-exact production once
the React lands.

---

# Components admin (Story 5.4) — Subtask 5.4.7 output

Story 5.4 adds an admin-managed **component** taxonomy (name + description +
default assignee, multi-valued per issue) managed at **Project settings →
Components**. This section is the canonical reference for code subtask
**5.4.10** (the Components admin UI), which carries 5.4.7 in `dependsOn`. The
companion issue-view surface (the Components rail card + chip picker) is
**5.4.6** → `design/work-items/labels-components-watch.mock.html`.

Like the 6.4.1 and 5.3.4 surfaces above, this is an **HTML mockup** —
`components.mock.html`, built FROM the real design system (the
`app/globals.css` token block copied 1:1 + shipped `components/ui/*`
primitives), with `components.png` as the light-mode board render. The HTML is
the source of truth; toggle `data-theme="dark"` in it to confirm token parity.

## Files

| HTML source (truth)    | PNG export       |
| ---------------------- | ---------------- |
| `components.mock.html` | `components.png` |

The mockup is an eight-panel board (review EACH): **(0)** the settings hub
with the new Components card; **(1)** the populated project-admin list;
**(2)** the empty state (+ the 5.4.6 cross-reference); **(3)** the create
modal with the default-assignee picker OPEN; **(4)** the edit modal + the
case-insensitive-unique inline 422; **(5)** the in-use delete dialog — the
move-or-remove choice, BOTH branches; **(6)** the unused delete confirm;
**(7)** the non-admin read-only state + loading skeleton + ErrorState.

## Mirror product (rung 1, VERIFIED at plan time 2026-06-10 — Atlassian docs)

**Company-managed Jira** is the shape mirror (team-managed gets Compass
components — a different product seam):

- `name` (required, **case-insensitively unique** per project — the 5.4.1
  `nameLower` unique), `description?`, `defaultAssigneeId?`; issues carry
  **multiple components**.
- **Default assignee (the verified rule):** an issue CREATED with components
  and no assignee takes the default assignee of its **first-alphabetical**
  component that has one — create-time only; later component edits never touch
  the assignee. The helper line under the picker states this.
- **Delete with issues = the verified move-or-remove choice:** move every
  association to another component, or just remove it — the work items
  themselves are untouched either way. Unused components confirm simply.

**Recorded simplification:** Jira's five-way default-assignee enum (project
default / project lead / component lead / unassigned / person) collapses to a
**nullable user** — Motir has no project-lead concept, and component _lead_
exists in Jira chiefly to feed that enum. Component lead = the documented
extension.

## Composing primitives (no new primitive required)

- **`Card`** — the component-list card (header + flush body) and the hub
  cards. The **hub card** reuses the `MembersSettingsCard` grammar verbatim
  (`Card p-0` + whole-row `Link` + `ChevronRight`), placed **after Fields**
  (the in-flight 5.3.6 card; both sit between Estimation and Access & members
  — the issue-config group; Archive stays last).
- **Component rows** — the members-row grammar with the avatar slot holding a
  **neutral component tile** (lucide `component` glyph in
  `--el-text-secondary` on `--el-surface`, `--radius-control`) — matching
  5.4.6's recorded decision that components stay NEUTRAL so the labels'
  name-hash tints read as meaningful (the two surfaces share one identity;
  finding #54 is satisfied by avatars + state grammars, not an invented
  component hue). Row = tile · name · description gloss (truncating) ·
  **default-assignee cluster** (28px ink avatar + name + the 11px "Default
  assignee" sublabel; a dashed empty avatar + muted "None" when unset) ·
  usage (`N issues` / `not used yet`) · ghost-sm `Edit` / `Delete`. **NO
  grip** — components are name-ordered (`listComponents` sorts by name), never
  manually reordered (unlike fields). The count pill is a plain count (no cap
  — the mirror has none; the read is bounded server-side).
- **`Modal`** — create / edit (size md, ghost Cancel + primary confirm — the
  create-project grammar) and the delete dialog (the archive-confirm heading:
  `TriangleAlert` in a `--el-tint-rose` circle + `danger` confirm; no
  typed-identifier arm step — the live count is the consequence statement,
  fetched when the dialog opens).
- **Default-assignee picker** — the 6.4.1 add-member **`Combobox`** grammar
  (trigger `--height-control`/`--radius-input` + elevated menu + avatar option
  rows + search), scoped via `assignableMembersService` ("Only people who can
  view this project are listed."), with an explicit **"None"** row (dashed
  empty avatar, gloss "No automatic assignment") so clearing the default is a
  first-class choice. The trigger shows the chosen member's 22px avatar +
  name, or muted "None".
- **Move-or-remove choice** — the 6.4.1 access **radio-card** grammar: two
  stacked cards (title + one-line consequence + radio; selected =
  `--el-accent` border + filled radio). The MOVE card embeds a component
  `Combobox` (component glyph + name) **excluding the component being
  deleted**; the picker collapses while the card is unselected.
- **`Pill`** — the count chip (`pill-neutral`) + `Read-only` (the mint chip,
  the 6.4 grammar).
- **`Input`** — name (helper "Unique within this project."), description; the
  unique-collision 422 uses the Input **error grammar** (`--el-danger` border
  - message) and names the EXISTING casing.
- **`EmptyState` / `ErrorState`** — "No components yet" (lucide `Component`
  icon) and "Couldn't load components" + Retry; the loading skeleton extends
  the settings skeleton.

## Copy strings catalog (use verbatim in 5.4.10; i18n under `settings.components`)

| Surface                   | String                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub card title            | `"Components"`                                                                                                                                                      |
| Hub card description      | `"The parts of the product issues belong to — like API, Web, or Billing — each with an optional default assignee."`                                                 |
| Page title                | `"Components"`                                                                                                                                                      |
| Page subtitle             | `"The parts of {projectName} that issues can belong to. An issue can carry several components; components belong to this project only."`                            |
| List card title           | `"Components"` (+ a plain count pill)                                                                                                                               |
| Add button                | `"Add component"`                                                                                                                                                   |
| Default-assignee sublabel | `"Default assignee"` (+ muted `"None"` when unset)                                                                                                                  |
| Usage gloss               | `"{n} issues"` / `"not used yet"`                                                                                                                                   |
| Empty headline            | `"No components yet"`                                                                                                                                               |
| Empty description         | `"Components group issues by part of the product — like API, Web, or Billing. New issues created with a component can pick up its default assignee automatically."` |
| Create modal title        | `"Create component"`                                                                                                                                                |
| Name field                | `"Name"` + helper `"Unique within this project."`                                                                                                                   |
| Description field         | `"Description (optional)"` + placeholder `"What part of the product this covers…"`                                                                                  |
| Default-assignee field    | `"Default assignee"` + helper `"New issues created with this component and no assignee are assigned to this person. Existing issues are never changed."`            |
| Picker None row           | `"None"` + gloss `"No automatic assignment"`                                                                                                                        |
| Picker scope note         | `"Only people who can view this project are listed."`                                                                                                               |
| Unique-name 422           | `"A component named “{Existing}” already exists in this project."`                                                                                                  |
| Create / save buttons     | `"Create component"` / `"Save changes"` / `"Cancel"`                                                                                                                |
| Edit modal title          | `"Edit component"`                                                                                                                                                  |
| Delete confirm title      | `"Delete {Component}?"`                                                                                                                                             |
| Delete in-use body        | `"{Component} is on {n} work items. Choose what happens to them — the work items themselves are untouched."`                                                        |
| Move choice               | `"Move {n} work items to…"` + gloss `"Their {Component} association is replaced. Items already carrying the target keep one."`                                      |
| Remove choice             | `"Remove the component from {n} work items"` + gloss `"They keep their other components."`                                                                          |
| Delete unused body        | `"No work items carry this component. This removes it from the project."`                                                                                           |
| Delete confirm button     | `"Delete component"`                                                                                                                                                |
| Read-only chip + line     | `"Read-only"` · `"Only project admins can manage components."`                                                                                                      |
| Error state               | `"Couldn't load components"` · `"Something went wrong on our side. Try again."` · `"Retry"`                                                                         |

## Read-only degradation (the 6.4 / 5.3 shape)

A non-admin sees the list with the mutation affordances **absent** (no Add
component, no Edit/Delete) + the `Read-only` pill + the quiet permission line
— the members-page / fields-page degradation: every control on this page IS a
mutation, so hiding is the right shape. Reads stay open to members/viewers —
the issue-view rail picker needs the component list.

## Deliberate non-features (the documented extension slots — do NOT build)

- **Component lead** + Jira's five-way default-assignee enum — the nullable
  user covers the use case (no project-lead concept; recorded simplification).
- **No manual reorder** — components are name-ordered, matching the mirror.
- **No per-project component cap** — the mirror has none; the admin read is
  bounded server-side (finding #57 honoured without inventing a limit).

## Tokens & a11y

Colour is `--el-*` only; shape via the element shape tokens
(`--radius-card/-modal/-input/-btn/-control/-badge`,
`--spacing-card-padding/-btn-x/-input-x/-control-*/-chip-*`,
`--height-btn-sm/-btn-md/-input/-control`, `--shadow-card/-elevated/-modal`).
The move-or-remove dialog is focus-managed with the radio group labelled; the
default-assignee picker is the shipped Combobox a11y bar; the dashed "None"
avatar conveys absence with text ("None"), never colour alone. `rounded-full`
only on avatars and radio dots. Dark parity verified by toggle.

## Source of truth

When a string here disagrees with shipped 5.4.10 code, the code wins — file a
fix so the mockup stays the reference. `components.mock.html` is the
layout-confirmation artifact; it may drift from pixel-exact production once
the React lands.

---

# Project settings AREA (Story 6.5) — Subtask 6.5.1 output

Story 6.5 turns the flat **card hub** at `/settings/project` into the
Jira-shaped project-settings **AREA**: ONE chrome wrapping every per-project
admin page behind a grouped settings navigation, **landing on a read-only
Details page**. It is a **composition** story — every section already exists
(Workflow 2.2.5, Boards 3.6/3.7, Estimation 4.3.5, Members & access 6.4.5,
Fields 5.3.6, Components 5.4.10); 6.5 ships the **area shell**, the
**settings-nav registry**, and the **Details landing**. It re-houses; it does
not rebuild.

This section is the canonical reference for the UI code subtasks **6.5.2**
(settings-nav registry + area `layout.tsx`) and **6.5.3** (the Details
landing) — both carry 6.5.1 in `dependsOn` and seed `'blocked'`. Like the
6.4.1 / 5.3.4 / 5.4.7 surfaces above, the asset is an **HTML mockup** —
`settings-area.mock.html`, built FROM the real design system (the
`app/globals.css` token block copied 1:1 — incl. the `--el-sidebar-*` shell
tokens — + shipped `components/ui/*` primitives), with `settings-area.png` as
the light-mode render. The HTML is the source of truth; toggle
`data-theme="dark"` in it to confirm token parity.

## Files

| HTML source (truth)       | PNG export          |
| ------------------------- | ------------------- |
| `settings-area.mock.html` | `settings-area.png` |

The mockup is a five-panel board (review EACH): **(0)** THE AREA — entry +
chrome + the Details landing (rail = grouped settings nav with the
project-identity header + back-to-project; content = Details, read-only
identity + Archive danger zone), the hero panel; **(1)** the grouped nav
close-up + the nav-entry ↔ registry mapping table (incl. the Automation
slot); **(2)** a re-housed page (Workflow exemplar) inside the area chrome;
**(3)** role states — the non-admin member view + the 6.4.4 no-access state;
**(4)** narrow viewport (the nav collapses to a "Settings menu" disclosure +
sheet) + the no-active-project empty state.

## Entry + chrome decision — the area REPLACES the project nav in the SAME rail

The load-bearing layout decision (the card called for "pick one and draw
it"): entering settings **swaps the app-shell rail's project-nav sections**
(Dashboard / Issues / Ready / Boards / Backlog / Reports) **for the grouped
settings nav**, and swaps the rail header (the `ProjectSwitcher`) for a **"←
Back to {project}"** link + a static **project-identity block** (avatar +
name + key). It does **NOT** nest a second rail beside the app rail.

- **Why replace, not nest (rung 1).** Jira's verified team-managed shape is
  exactly this: opening project settings turns the left sidebar INTO the
  settings nav, with a way back to the project. One rail, no double chrome.
  Nesting a second rail would burn horizontal space and invent a
  two-sidebar pattern the app does not otherwise have — complexity for
  nothing.
- **Primitive reuse.** The rail stays the shipped `Sidebar`
  (`components/ui/Sidebar.tsx`): groups are `SidebarSection`s with a
  `label` (the `SectionLabel` caption), rows are `SidebarNavItem`s (the
  inset active treatment — `--el-sidebar-item-bg-active` +
  `--el-sidebar-border` + `--shadow-subtle` + accent icon — and
  `aria-current="page"`). 6.5.2 renders the rail from the **registry**, not a
  hand-kept list. The "Back to {project}" + identity block sit in the
  Sidebar `header` slot (replacing the `SidebarHeader`/`ProjectSwitcher` while
  in the area).
- **Landing rule.** `/settings/project` **IS** the Details page (6.5.3) — it
  is no longer a hub. Entering settings from the app sidebar lands here with
  the `Details` nav entry active.

## The settings-nav registry (the 6.5.2 contract)

One typed entry per project-settings page drives the nav, the
command-palette deep links, AND the totality test:

```ts
{
  (id, group, href, icon, labelKey, access);
}
```

| Group · entry                 | `href` (route preserved)       | icon (lucide)       |
| ----------------------------- | ------------------------------ | ------------------- |
| **General** · Details         | `/settings/project`            | `SlidersHorizontal` |
| **Access** · Members & access | `/settings/project/members`    | `Users`             |
| **Work** · Workflow           | `/settings/project/workflow`   | `Workflow`          |
| **Work** · Boards             | `/settings/project/board`      | `Columns3`          |
| **Work** · Estimation         | `/settings/project/estimation` | `Gauge`             |
| **Work** · Fields             | `/settings/project/fields`     | `Tag`               |
| **Work** · Components         | `/settings/project/components` | `Box`               |
| **Automation** · Rules        | _reserved_ (6.6)               | `Bot`               |

- **Routes are preserved** — every existing settings URL resolves unchanged
  inside the chrome (zero deep-link breakage, no redirects). Only the landing
  moves (`/settings/project` → Details) and the per-page back-crumbs drop.
- **`icon`** uses the named lucide glyphs above (the `Columns3` boards glyph
  matches the app-nav Boards icon — keep them in sync; `Workflow` is the
  three-box connected glyph, NOT `GitBranch`).
- **`access`** rides the **shipped 6.4.3 policy** (`lib/projects/access.ts`
  - `projectAccessService`) — never a second role check. Admin manages;
    member sees the page's shipped read-only state; a role without browse
    access sees **neither the nav entry nor the page** (the 6.4.4 no-access
    state on direct nav).
- **Totality (mistake #29).** A unit test enumerates
  `app/(authed)/settings/project/**/page.tsx` and fails unless each route has
  **exactly one** registry entry (and vice versa) — drift is a red suite, not
  a silent gap. The reserved Automation slot is NOT a route entry until 6.6
  ships its page; it renders as a disabled "Soon" row, excluded from the
  route↔entry assertion.

## Groups & the Automation slot

Four groups, in rail order: **General** (Details), **Access** (Members &
access), **Work** (Workflow, Boards, Estimation, Fields, Components),
**Automation** (the 6.6 slot). The Automation **Rules** row is drawn as a
**designed-for "Soon" entry** — present (so the area's shape is legible from
day one) but disabled, with a `--el-tint-yellow` "Soon" chip and
`--el-text-secondary` ink; it is NOT a registry route entry until Story 6.6 adds
its page. This is the "draw the slot, don't build the page" convention.

## Composing primitives (no new primitive required)

- **`Sidebar` / `SidebarNav` vocabulary** — the rail: grouped sections, the
  inset active row, the hover lift (`--el-sidebar-item-bg-hover`), the
  back-link + identity header in the `header` slot. Icons at 18px in
  `--el-text-muted` (active → `--el-accent`).
- **The serif page-title grammar** — KEPT from every shipped settings page
  (`<h1 class="font-serif text-3xl">` + the muted `text-sm` sub). Re-housed
  pages keep their `<header>` exactly; only the back-crumb is removed.
- **`Card`** — the Details **Project details** card (identity rows) and the
  **Danger zone** card (the re-homed `ArchiveProjectCard` — `border-2
border-(--el-danger)`, the `Archive…` `danger` Button + its modal, UNCHANGED
  — a move, not a rebuild).
- **Identity rows** — label-and-value rows (a 132px muted label with a 15px
  lucide glyph + the value); the Key value is mono; the **Image** row holds the
  project's uploaded picture in a square `--radius-control` box (`object-fit:
cover`), or **nothing at all** when the project has none (MOTIR-2675). A quiet
  `--el-surface` **seam note** states "editing arrives with project-details
  editing" — the 6.8 seam (6.8 swaps these rows for edit forms + the
  key-change flow; **no edit affordances are improvised here**).
- **`Pill`** — the `Admin` chip (lavender tint, the 6.4 role grammar) and the
  member view's `Read-only` chip (mint tint, `--el-text-strong` — AA per
  finding #35).
- **`Button`** — `danger` (Archive…), `ghost`/`primary` (the no-access
  actions).
- **`EmptyState`** — the no-active-project state (kept from the hub; the
  route still resolves, no 404; the create CTA lives on the dashboard).
- **`ErrorState` family** — the 6.4.4 no-access panel, **referenced verbatim**
  (off `ProjectAccessDeniedError`), not redrawn here.
- **Command palette** — `AppCommandPalette` grows **per-section** entries
  generated FROM the registry (replacing today's single "Go to settings"
  action); each deep-links to its `href`.

## Role states

- **Member (non-admin)** — the SAME grouped nav (members can VIEW every
  section); each re-housed page renders its **shipped read-only state** (the
  5.4 / 6.4 degradation grammar); the **Details page shows NO danger zone** —
  archive is admin-gated (the 1.3.4 rule), so the member sees identity rows +
  a `Read-only` pill, no Archive.
- **No browse access** — a non-member who follows a direct
  `/settings/project*` link to a private project hits the **6.4.4
  ErrorState** ("You don't have access to this project" + Request access /
  Back to projects). The nav never leaks — the registry's `access` predicate
  filters the whole area away.

## Narrow viewport + empty state

- **Mobile (< md).** The rail collapses to a **"Settings menu" disclosure**
  in a top bar showing the current section; tapping opens the grouped nav
  **inline as a sheet** (same groups, same active state) — reachable, not
  clipped. (Parallels the app shell's `SidebarDrawer`.)
- **No active project.** Kept from the retiring hub: the `EmptyState`
  ("No project selected") renders on the route so it never 404s.

## Copy strings catalog (use verbatim in 6.5.2 / 6.5.3; i18n under `settings`)

| Surface                      | String                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rail back link               | `"Back to {projectName}"`                                                                                                                                                                                                    |
| Rail eyebrow                 | `"Project settings"`                                                                                                                                                                                                         |
| Group labels                 | `"General"` · `"Access"` · `"Work"` · `"Automation"`                                                                                                                                                                         |
| Nav entries                  | `"Details"` · `"Members & access"` · `"Workflow"` · `"Boards"` · `"Estimation"` · `"Fields"` · `"Components"` · `"Rules"`                                                                                                    |
| Automation slot chip         | `"Soon"`                                                                                                                                                                                                                     |
| Details page title           | `"Details"`                                                                                                                                                                                                                  |
| Details page subtitle        | `"Project name, key and avatar. Workspace owners and admins can edit these — editing arrives with project-details editing."`                                                                                                 |
| Details card title           | `"Project details"`                                                                                                                                                                                                          |
| Identity row labels          | _(the logo row carries NO label — see below)_ · `"Name"` · `"Key"` · `"Workspace"` · `"Created"`                                                                                                                             |
| 6.8 seam note                | `"Editing name, key and avatar — plus changing the project key with old-key redirects — arrives with project-details editing. For now these are read-only."`                                                                 |
| Danger zone heading          | `"Danger zone"` (the shipped `settings.danger.heading`)                                                                                                                                                                      |
| Archive row                  | `"Archive this project"` · `"Hide {projectName} from the project list and stop new work. You can restore it later."` · `"Archive…"` (shipped `settings.archive.*`)                                                           |
| Member read-only chip + line | `"Read-only"` · `"Only project admins can manage project settings."`                                                                                                                                                         |
| No-access state              | `"You don't have access to this project"` · `"{projectName} is a private project. Ask a project admin to add you, or pick another project to keep working."` · `"Request access"` · `"Back to projects"` (the 6.4.1 strings) |
| No-active-project empty      | `"No project selected"` · `"Choose a project from the switcher, or create one from the dashboard, to manage its settings."`                                                                                                  |
| Mobile disclosure            | `"{currentSection}"` (the active entry's label)                                                                                                                                                                              |

Details / Archive strings that already ship (`settings.project.*`,
`settings.danger.*`, `settings.archive.*`) are **reused** — 6.5.3 keeps the
existing keys; only the page LAYOUT changes (hub → Details landing).

## Recorded deviations from the mirror (justified — no complexity for nothing)

Verified against the Atlassian project-settings-sidebar + team-managed docs
at plan time (2026-06-10):

- **No Features toggle page** — Jira's kanban-vs-scrum / feature-flags axis is
  owned in Motir by board **TYPE** (3.7 multi-board CRUD + 4.5 Scrum board); a
  per-project toggle would duplicate it.
- **No project-level Notifications admin** — notification preferences are
  **per-USER** in Motir's event-driven model (the 5.7 surface); an
  admin-owned scheme has no stated use case.
- **No Apps page** — no marketplace.
- **No settings search box** — Jira ships one at site-admin scale; ~8 bounded
  entries do not earn it (finding #57: the nav is bounded, not a scale
  surface).

## The logo row has no label (Yue, 2026-08-11)

Every other identity row on this card is `label → value`. The logo row is not, and
the omission is deliberate: **a label reading "Image" above a picture of the
project's logo says nothing the picture has not already said.** It is chrome
describing its own contents.

**Where the word survives, and why exactly there.** The label can go because the
picture speaks; when there IS no picture, nothing speaks — so the word is
load-bearing in precisely the two states where the image is absent:

| state          | copy                     | why the word is needed                                       |
| -------------- | ------------------------ | ------------------------------------------------------------ |
| no logo set    | `"Upload logo"`          | the row is one button; without the noun it is "upload what?" |
| remove confirm | `"Remove project logo?"` | the dialog replaces the surface it is about                  |

Everywhere else the controls sit **beside the thing they act on** and read as
`Change` / `Remove` with no noun at all.

**And the noun is "logo", not "image."** That is the word Yue used, and it is the
more specific of the two — "image" describes the file format, "logo" describes
what the file is for. The DTO field and the column stay `image` (they are about
storage, and `User.image` sets that precedent); only the user-facing copy says
logo.

## The mixed switcher list — what drawing it changed (MOTIR-2675)

`MOTIR-2674` pinned the mark and its empty case, and for a LIST it predicted that a row without an
image would simply start where an imaged row starts its box — the text shifting left, nothing drawn
to hold the space. **Drawing it at four rows (two imaged, two not) showed that reads worse than the
prediction:** the un-imaged names hang left of the imaged ones and the list stops scanning as a
column, which is the one job a switcher list has.

**The corrected rule, and it is a refinement rather than a reversal:**

| surface  | a row/tier with no image                                                         |
| -------- | -------------------------------------------------------------------------------- |
| **LIST** | holds the **24px slot** open — nothing drawn in it; the NAME keeps one left edge |
| **BAR**  | the gap **closes** — a single tier has no column to align to                     |

Nothing is rendered in the held slot: no border, no fill, no glyph, no monogram. **The no-mark rule
is untouched** — what is preserved is ALIGNMENT, which is a property of the list, not a mark. After
the fix all four names measure to the same x.

`design/shell/design-notes.md` § _The MARK_ is amended in the same pass, because a spec two assets
disagree about is worse than either answer on its own.

## Extension slots (reserved — do NOT build here)

- **Automation rules** — Story 6.6 (the reserved Automation slot; mounts by
  adding a registry entry).
- **Details editing + project-key change with old-key redirects** — Story
  6.8 (grows the 6.5.3 Details page; keep the seam aligned with its
  description).
- **Per-work-type field layouts** — the 5.3 documented extension; the
  registry reserves a slot, it is NOT an entry here.

## Tokens & a11y

Colour is `--el-*` only (incl. the `--el-sidebar-*` shell tokens + the
`--el-type-task` project tile + the `--el-tint-*` pill/chip backgrounds —
finding #54: not grey + primary alone); shape via the element shape tokens
(`--radius-card/-input/-btn/-control/-badge/-modal`,
`--spacing-card-padding/-control-*/-chip-*/-btn-x`,
`--height-control/-btn-md`, `--shadow-subtle/-card`). The settings nav is a
labelled `navigation` landmark with `aria-current="page"` on the active row
and is fully keyboard-operable; the "Soon" row is `aria-disabled` and conveys
its state with the chip text, not colour alone; `rounded-full` only on the
avatar dots. AA holds on every tint chip (hue in the background,
`--el-text-strong` text). Dark parity verified by toggle.

## Source of truth

When a string here disagrees with shipped 6.5.2 / 6.5.3 code, the code wins —
file a fix so the mockup stays the reference. `settings-area.mock.html` is the
layout-confirmation artifact; it may drift from pixel-exact production once
the React lands.

---

# Automation rules (Story 6.6) — Subtask 6.6.4 output

The design asset for the whole **project automation** surface — the when/then
rule engine's authoring + observability UI. Nothing under `design/` covered
automation (the design-gate NONE-exists case: `projects/` held only
Members/Access + Fields + Components + the 6.5 settings area), so this asset is
the prerequisite that **gates the UI code subtasks 6.6.5** (rule list +
when/if/then editor) **and 6.6.6** (audit-log UI + last-run + auto-disabled
banner) — both carry 6.6.4 in `dependsOn` and seed `'blocked'` (Principle #13).

## Files

- `design/projects/automation.mock.html` — the source of truth (8 panels;
  toggle dark to confirm token parity).
- `design/projects/automation.png` — light full-page export for the board.
- This section.

## Mirror product (rung 1, VERIFIED at plan time 2026-06-10 — Atlassian docs)

Jira's automation **rule builder**: a rule = **trigger → conditions →
actions**, one trigger per rule, shown as a three-block editor ("When / If /
Then"); a per-rule **audit log** (success / failure / no-actions, per-step
detail, 90-day retention); rules run **as a configurable actor**;
**auto-disable** at 10 consecutive failures. Adopted 1:1 in shape. The Story
6.6 description records the verified core sets + the deviations (rule runs as
the **owner**, not a synthetic app user; loop prevention is the Jira default
only). This asset draws exactly that surface — it invents no rule-engine UI
beyond the verified anatomy.

## Entry + chrome — mounts INSIDE the 6.5 settings area (no second frame)

The surface is **one page in the 6.5 settings AREA**, not a new shell. It
mounts in the **reserved "Automation › Rules" nav slot** Story 6.5 drew as a
disabled "Soon" entry (`settings-area.mock.html` panel 1 / "Groups & the
Automation slot"). 6.6.4 **lights that slot up**: the row becomes an active
route entry (`aria-current="page"`, the inset treatment, accent icon), the
`Soon` chip drops. The rail, the back-to-project header, the serif page-title
grammar, and the `Card` are the 6.5 chrome verbatim — this asset designs the
**page bodies inside** it (the list, the editor, the audit log), never a frame.

## The settings-nav registry entry (extends the 6.5.2 contract)

The 6.5.2 registry reserved the slot without a route; 6.6.5 fills it with a
real entry, and the route↔entry totality test now includes it:

| Group · entry          | `href`                         | icon (lucide) |
| ---------------------- | ------------------------------ | ------------- |
| **Automation** · Rules | `/settings/project/automation` | `Bot`         |

`access` rides the **shipped 6.4.3 admin predicate** (`projectAccessService`,
the `manage-project` permission) — never a second role check. Automation is
**admin-only** end to end: the nav entry, the page, and every route 403/404 for
non-admins (no member/viewer read-only variant — unlike Fields/Components,
there is no useful read-only automation view, matching Jira).

## The editor-kind ↔ registry mapping (the 6.6.1 / 6.6.3 UI contract)

The editor is **registry-driven** — the trigger picker, its per-kind config
editor, the action picker, and its per-action config editor are ALL rendered
FROM the 6.6.1 + 6.6.3 registries (the 6.1.4 "rows render from the registry"
pattern; a new entry appears with zero editor changes, asserted in 6.6.5 with a
test-only entry). The editor NEVER hard-codes a trigger/action/field list.

**Triggers (the "When" block — one per rule):**

| Trigger (registry id) | Config editor kind                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `created`             | none ("No further configuration")                                                              |
| `transitioned`        | optional **from → to** status `Combobox`s (the 6.6.1 status-id narrowing)                      |
| `field-changed`       | built-in / CF **field picker** `Combobox`; **Assignee** surfaced first (the "assigned" preset) |
| `commented` (6.6.3)   | none                                                                                           |

**Actions (the "Then" block — ordered, max 10):**

| Action (registry id)       | Config editor kind                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `transition`               | status-target `Combobox`                                                                                                                      |
| `set-field` (built-ins)    | field `Combobox` + value editor per built-in: assignee (member) / priority (option) / due date (`DatePicker`) / story points (number `Input`) |
| `set-field` (custom 6.6.3) | field `Combobox` + value editor per 5.3 CF type: select (option) / user (member) / number / date / text                                       |
| `add-watcher` (6.6.3)      | member `MultiSelectPicker`                                                                                                                    |
| `add-comment` (6.6.3)      | body `Input`                                                                                                                                  |
| `add-label` (6.6.3)        | type-to-create `MultiSelectPicker` (the 5.4.2 find-or-create semantics)                                                                       |

**Conditions (the "If" block) — REUSE 6.1.3, do not fork.** The condition group
is the **6.1.3 filter-builder `.cond` row verbatim** (field `Combobox` ·
operator `Combobox` · value editor · remove ×) under the **Match all / any**
`Segmented` combinator, with the 6.1 **20-row cap** and the
`.chip.stale` stale-referent treatment + `role="status"` row notice. 6.6.5
reuses the **6.1.4 condition-row components** scoped to the rule editor — there
is exactly **one predicate UI in the product**. Empty group = "always".

## Composing primitives (no new primitive required)

- **The 6.5 settings-area chrome** — rail (`Sidebar`), serif page title, `Card`
  — verbatim; Automation is a page inside it.
- **The 6.1.3 condition rows** — `.cond` grid, `Segmented` combinator,
  `MultiSelectPicker` box, `.chip` / `.chip.tinted` / `.chip.stale`, the
  `addrow` add button, the cap + `stale-note` states — verbatim.
- **`Combobox`** — every trigger / action / field / operator / status target
  picker (the `.cb` trigger + the `.menu` listbox, the field-picker shown open
  with the Assignee preset + grouped built-in / custom sections).
- **`MultiSelectPicker`** — member (watcher / assignee), enum (kind / status /
  priority), and type-to-create (label) value editors.
- **`Input` / `DatePicker`** — comment body, number values, due date.
- **`Switch`** — the per-rule enable toggle (list rows + editor header),
  optimistic.
- **`Pill`** — the trigger summary chip on list rows, and the audit-log status
  pills: **Success** (mint, `check-circle`) · **Failure** (rose, `alert-
triangle`) · **No actions** (neutral, `minus-circle`) — AA per finding #35
  (hue in the tint bg, `--el-text-strong` text).
- **`Button`** — `primary` (Create rule / Save), `ghost` (Cancel / Re-enable),
  `danger` (Delete in the overflow).
- **`Avatar`** — the rule owner on list rows.
- **`EmptyState`** — "No rules yet" (list) and "No runs yet" (audit log).
- **Icon-button overflow menu** — Edit · Disable · Delete · View log per rule.
- **The drag `grip`** — keyboard-operable action reorder (↑/↓ when focused).

## The last-run glyph vocabulary (list + audit log share it)

| State         | glyph            | colour                | copy                          |
| ------------- | ---------------- | --------------------- | ----------------------------- | ------------------------------------------------------- |
| Success       | `check-circle`   | `--el-success`        | "Ran {time} ago"              |
| Failure       | `alert-triangle` | `--el-danger`         | "Failed · {time} ago"         |
| No actions    | `minus-circle`   | `--el-text-faint`     | "No actions · {time} ago"     | — faint is correct here: the `minus-circle` is a glyph. |
| Never run     | — (text only)    | `--el-text-secondary` | "Never run"                   |
| Auto-disabled | `alert-triangle` | `--el-danger`         | "Auto-disabled · 10 failures" |

## Real-product operations (finding #57 — bounded, drawn)

- **Audit log pagination** — reads page over the indexed `[ruleId, createdAt]`
  log (the 6.6.1 index); the foot shows "Showing 1–N of M" + a pager. **No
  load-all** (the finding-#57 tell, avoided).
- **Deleted triggering item** — renders the `tomb` tombstone (struck-through
  key, no link), not a dead link.
- **Failure detail** — a failure row expands (on a quiet `--el-surface-soft`
  band) to a rose-tinted `errbox` callout: a leading `alert-triangle`, the
  message in `--el-text-strong`, and the typed error as a mono `--el-page-bg`
  code chip (the finding-#35 hue-in-background grammar, shared with the
  auto-disabled banner — NOT a grey box with a danger stripe) + a per-step list
  (which action failed, which were skipped).
- **Auto-disable banner** — at 10 consecutive failures the rule switches off; a
  rose banner (AA, `--el-text-strong`) on the list + editor names the count and
  offers **Re-enable** (wired to the 6.6.1 counter reset).
- **90-day retention** — a quiet footer line states the cron-swept window
  (6.6.2).
- **Caps** — 100 rules / project, 10 actions / rule, 20 conditions / rule —
  each a disabled add affordance + an inline note, and a **typed 422** surfaced
  **per row** (danger outline + `role="alert"` message) on bypass, never a
  silent truncation or a detached toast.

## Copy strings catalog (use verbatim in 6.6.5 / 6.6.6; i18n under `settings.automation`)

| Surface                 | String                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nav entry               | `"Rules"` (group `"Automation"`)                                                                                                                                               |
| Page title · subtitle   | `"Automation"` · `"When something happens in {projectName}, run actions automatically. Rules run as their owner — only project admins can manage them."`                       |
| Create CTA              | `"Create rule"`                                                                                                                                                                |
| When / If / Then labels | `"When"` · `"If"` · `"Then"`                                                                                                                                                   |
| When block sub          | `"the trigger — one per rule"`                                                                                                                                                 |
| If block sub            | `"conditions on the triggering item — optional"`                                                                                                                               |
| Then block sub          | `"actions run in order, as the rule owner"`                                                                                                                                    |
| Combinator              | `"Match"` · `"all"` / `"any"` · `"of the following conditions:"`                                                                                                               |
| Trigger options         | `"Item created"` · `"Item transitioned"` · `"Field value changed"` · `"Item commented"`                                                                                        |
| Transitioned config     | `"from"` · `"to"` (status `Combobox`s; placeholder `"Any status"`)                                                                                                             |
| Field-changed config    | `"field"` + the field picker (preset `"Assignee"`)                                                                                                                             |
| Action options          | `"Transition"` · `"Set field"` · `"Add watcher"` · `"Add comment"` · `"Add label"`                                                                                             |
| Add affordances         | `"Add condition"` · `"Add action"`                                                                                                                                             |
| Editor foot             | `"Runs as {owner} (rule owner) · {n} of 10 actions"` · `"Cancel"` · `"Save rule"`                                                                                              |
| List meta               | `"{n} of {n} rules"` · `"100 rules per project"`                                                                                                                               |
| Last-run                | see the glyph vocabulary table above                                                                                                                                           |
| Empty (list)            | `"No rules yet"` · `"Automate repetitive work — transition items, set fields, add watchers or comments when something happens. Rules run as their owner."`                     |
| Auto-disabled banner    | `"{ruleName} was disabled automatically after 10 consecutive failures. Fix the rule and re-enable it — re-enabling resets the failure count."` · `"Re-enable"`                 |
| Cap (rules)             | `"100 of 100 rules — delete a rule to add another."`                                                                                                                           |
| Cap (conditions)        | `"20 of 20 conditions — the maximum for one rule."`                                                                                                                            |
| Audit log title         | `"Run history — {ruleName}"`                                                                                                                                                   |
| Audit status pills      | `"Success"` · `"Failure"` · `"No actions"`                                                                                                                                     |
| Audit no-actions reason | `"Condition not met — {summary}"`                                                                                                                                              |
| Audit tombstone         | `"{n} actions — triggering item since deleted"`                                                                                                                                |
| Audit pager · retention | `"Showing {a}–{b} of {total}"` · `"Run history is kept for 90 days."`                                                                                                          |
| Empty (audit)           | `"No runs yet"` · `"This rule hasn’t fired. When an item matches its trigger and conditions, each run appears here with its result, duration and the item that triggered it."` |
| Stale-referent (cond)   | `"“{value}” was removed from {field}. Remove it, or pick a current option."`                                                                                                   |
| Invalid action (422)    | `"{user} is no longer a member of this project — they can’t be a watcher. (422)"` (the per-referent shape)                                                                     |

## Recorded deviations from the mirror (justified — no complexity for nothing)

- **Runs as the rule OWNER, not a synthetic "Automation" actor** — the Story
  6.6 recorded deviation; the editor foot states "Runs as {owner}". A synthetic
  per-workspace user would leak into every member-bounded picker for no use
  case.
- **No "Soon"/disabled triggers or actions drawn** — only the verified core
  sets ship; the documented extension slots (scheduled triggers, branches,
  send-email/webhook actions, the chaining opt-in) are NOT drawn — drawing a
  disabled control implies a near-term page (the 6.5 "Soon" convention is for a
  reserved nav SLOT, not for unowned features).
- **Admin-only, no read-only variant** — unlike Fields/Components there's no
  useful viewer view of automation; the 6.4 gate hides the whole surface.

## Extension slots (reserved — do NOT build here)

Scheduled/cron triggers (need the 6.2 saved-filter item-selection substrate);
branches + smart values; global / multi-project rules; the "Allow rule trigger"
chaining opt-in; send-email / webhook / create-item actions; a manual "run now"
trigger; monthly usage quotas (Epic 8.1 metering). Each is an additive registry
entry when a use case lands — the registries (6.6.1/6.6.3) are the growth seam.

## Tokens & a11y

Colour is `--el-*` only — the `--el-tint-{sky,lavender,mint}` block wedges
(When/If/Then), the `--el-tint-{mint,rose}` status pills + banner (hue in the
bg, `--el-text-strong` text — finding #35, AA holds), the `--el-type-bug` /
`--el-success` / `--el-info` / `--el-warning` issue + status hues (finding #54:
not grey + primary alone), the `--el-danger` validation outline + error text.
Shape via the element shape tokens (`--radius-card/-input/-btn/-control/-badge`,
`--spacing-card-padding/-control-*/-chip-*/-input-*/-btn-x`,
`--height-control/-input/-btn-*`, `--shadow-subtle/-card/-elevated`); `rounded-
full` only on the avatar / status dots / the `Switch` knob. The When/If/Then
columns are labelled groups; every picker is a keyboard-complete `Combobox`;
the `Switch` + last-run status are announced; action reorder is keyboard-
operable (the `grip` + ↑/↓); validation is `role="alert"` on the offending row,
condition staleness `role="status"`; the audit log is a list with the failure
detail in an expandable region. Extends the settings strict axe sweep. Dark
parity verified by toggle.

## Source of truth

When a string here disagrees with shipped 6.6.5 / 6.6.6 code, the code wins —
file a fix so the mockup stays the reference. `automation.mock.html` is the
layout-confirmation artifact; it may drift from pixel-exact production once the
React lands.

---

# Editable project Details (Story 6.8) — Subtask 6.8.3 output

Story 6.8 grows the **6.5.3 read-only Details landing** (the identity page the
6.5 settings **AREA** lands on) into the **editable** surface: the project
**name**, **avatar** (preset icon + colour swatch), and — the load-bearing
piece — a **project-key change with old-key redirects** (PROD → NIF, every
issue identifier re-renders with its number preserved, old links keep working
forever via the `project_key_alias` table). It also lists **previous keys** with
a release control. The backend already shipped in **6.8.1** (schema + the locked
atomic `changeKey` tx + alias reservation/release + admin-gated PATCH) and
**6.8.2** (alias-aware resolution everywhere the key is addressed); this asset is
the **design gate** for the UI code subtask **6.8.4**.

This section is the canonical reference for **6.8.4** (the editable Details page),
which carries **6.8.3 + 6.5.3** in `dependsOn` and seeds `'blocked'` (Principle
#13). The asset is an **HTML mockup** — `details.mock.html`, built FROM the real
design system (the `app/globals.css` token block copied 1:1 — incl. the
`--el-sidebar-*` shell tokens — + shipped `components/ui/*` primitives), with
`details.png` as the light-mode render. The HTML is the source of truth; toggle
`data-theme="dark"` in it to confirm token parity.

**This EXTENDS the 6.5.1 area asset — it does NOT redraw the chrome.** The rail
(grouped settings nav + the project-identity header + back-to-project), the
serif page-title grammar, the Details landing's outer Card, and the re-homed
Archive danger zone are all the 6.5.1 drawing, reused whole. 6.8 changes only the
**content** of the Details card — the read-only identity rows become editable
controls — and adds three new things: the **avatar picker** (Popover), the
**change-key modal**, and the **previous-keys** rows + **release confirm**.

## Files

| Source of truth (HTML)              | Render (PNG)                          |
| ----------------------------------- | ------------------------------------- |
| `design/projects/details.mock.html` | `design/projects/details.png` (light) |

`details.mock.html` is one multi-panel review page (panels 0–5); `details.png`
is the full-page light render. Dark parity is in-file (the `Toggle dark` button).
Key-error contracts come from the shipped 6.8.1 code, not the mock — see the
catalog below. The avatar REGISTRY that used to be cited here is retired: the
mark is an uploaded image (`docs/decisions/entity-marks.md`), and its box, sizes
and empty case are pinned in `design/shell/design-notes.md` § _The MARK_.

## Mirror product (rung 1, VERIFIED at plan time 2026-06-10 — Atlassian docs)

Jira Cloud **project details** + the **"Previous project keys"** details-page
feature (the same sources the Story 6.8 seed cites — checked, not asserted, per
`notes.html` mistake #33):

- **Details owns name / key / avatar.** Adopted 1:1. The key is **not a
  free-typing field** — it shows as a read-only value with a guarded "change key"
  flow (Jira routes the rename through a confirmation, not an inline edit).
- **Old keys keep working + stay reserved.** After PROD → NIF: old `PROD-`
  issue links **redirect** to the new key, REST calls on the old key **resolve**
  (no redirect), and PROD **stays reserved** against other projects. Link text is
  never rewritten. The Details page lists **"Previous project keys"** with a
  **remove** that un-reserves the key and **breaks its old links** — drawn as the
  release-with-confirm row.
- **Re-key is one operation.** Jira runs a background re-index here; ours is
  structurally cheaper (search reads the denormalized `work_item.identifier`
  column), so the bulk `UPDATE` **is** the re-index — synchronous + atomic. The
  modal's in-flight state reflects that (one commit, "won't leave issues
  half-renamed"), not a progress bar over a background job.

## Composing primitives (no new primitive required)

Everything is a shipped `components/ui/*` primitive — the mock's classes name
the primitive each block maps to:

- **`Sidebar` / area chrome** — the 6.5.1 settings nav + rail header, REUSED
  whole. The rail's project chip now renders the **avatar** (preset icon over the
  tint, or the mono key-letters fallback) instead of a flat letter tile.
- **`Card`** — the Details card (`card` + `card-head` + `card-body`), the
  Previous-keys card, and the re-homed **Danger zone** (`card.danger` —
  `border-2` `--el-danger`, the `Archive…` `danger` Button + its modal,
  UNCHANGED from 6.5.1). Each editable row is a labelled `field`.
- **`Input`** — the **name** field (text), the **change-key** field
  (`font-mono`, `letter-spacing`). The error state is the Input **error
  grammar** (`--el-danger` border + an `--el-danger-text` message with an
  `alert` glyph); the success state is the `--el-success` "Available" line. The
  read-only **key** value is a `key-val` (mono, `--el-surface` fill, no border
  emphasis) — a display, not an input.
- **`Button`** — `primary` (Save changes / Change key), `ghost` (Cancel / Change
  avatar / Change key… / Release), `danger` (Archive… / Release key). Sizes via
  `--height-btn-md` / `-sm`.
- **`Pill`** — `Admin` (`--el-tint-lavender`) / `Read-only` (`--el-tint-mint`),
  AA-safe (hue in the tint bg, `--el-text-strong` text — finding #35). The
  `Soon` automation chip is the 6.5.1 drawing.
- **`Popover`** — the **avatar picker** (the 18-icon grid + the 6 colour swatches
  - a live preview + "None") AND the **project switcher** open state (redrawn
    from the 1.3.4 frames with the avatar chip; the active row keeps its `Check`).
- **`Modal`** — the **change-key** modal (no `title` prop; a custom heading row:
  a `Key` glyph in an `--el-tint-lavender` circle + the serif title) and the
  **release** confirm (the **archive-confirm danger grammar**: `TriangleAlert` in
  an `--el-tint-rose` circle + a `danger` Button). `Modal.Footer` = ghost Cancel
  - the action button.
- **`Toast`** — the change-key success feedback (inverted surface, `--el-success`
  check), naming the consequence.
- The **save bar** is the card footer action row (`save-bar`) with a
  dirty/saving/saved status region on the left.

## The avatar contract — RETIRED (MOTIR-2680, 2026-08-11)

**This section specified a picker that no longer exists.** Story 6.8 gave a
project a mark chosen from a preset library — 18 icon keys and 6 colour keys,
validated server-side against a registry, with the project's key letters
rendered on a tile when unset. MOTIR-2588 replaced the whole mechanism: the mark
is an **uploaded image** now, and a project with none renders **nothing at all**.
The registry, the two columns, the picker and the renderer are gone.

**Read the sections it touched, not this one.** _The logo row has no label_
(above) is the current spec for this card's mark row, and
`docs/decisions/entity-marks.md` is the stance behind it.

The full text is left out rather than struck through because a preset grid is a
concrete thing to build, and a reader skimming for "what does the mark row
look like" would have found it and built it. What IS worth keeping is the
argument that lost, because the reversal is only legible next to it:

> **NO image upload** (recorded deviation — Jira's own default avatars are a
> preset library; the 2.3.7 upload primitive is issue-attachment-scoped; an
> arbitrary user image as workspace chrome would need crop/moderation infra).

Two of those three held up and one did not. The mirror argument was sound and
was simply outranked by what Yue wanted. The attachment-scope argument was true
in June and false by August — the account Photo row (`User.image`) shipped a
public-bucket upload primitive in between, which is exactly what the project
logo composes. The crop/moderation cost never materialised: the row caps size
and MIME type and stores the file as uploaded. A deviation that rests on
infrastructure not existing yet is worth re-checking whenever it is cited, not
inherited.

## The change-key flow (the 6.8.1 service + errors contract)

The key is a **read-only `font-mono` value + a "Change key…" affordance** on the
card (never a free-typing field — the mirror shape, and a guard against an
accidental re-key of every issue). The affordance opens the modal. Validation is
**STRICT** — the field rejects a malformed key, it does **not** pad/truncate the
way the create-time `normalizeIdentifier` coerces (an admin re-key is surprising
to silently mutate). Live shape: `/^[A-Z0-9]{3,5}$/`. The **six modal states**
(panel 3) map 1:1 to the shipped errors:

| Modal state              | Source (`lib/projects/errors.ts`) | Surface                                                          |
| ------------------------ | --------------------------------- | ---------------------------------------------------------------- |
| Clean (valid, available) | — (passes)                        | green "Available" + the verbatim consequence; Change key enabled |
| Format invalid           | `InvalidIdentifierError` → 400    | Input error grammar; Change key disabled                         |
| Collision — live key     | `IdentifierTakenError` → 409      | "Another project … already uses the key …" (distinct copy)       |
| Collision — reserved     | `IdentifierReservedError` → 409   | "… is reserved by another project's previous key." (distinct)    |
| In-flight                | (the atomic tx committing)        | inputs locked + spinner; "won't leave issues half-renamed"       |
| Success                  | (resolves)                        | modal closes → Toast; card now lists the old key under Previous  |

The two collision states get **distinct copy** because they have distinct
remedies (a live key is taken now; a reserved key is freed only by releasing the
other project's alias or deleting it) — that's exactly why 6.8.1 split
`IdentifierTakenError` from `IdentifierReservedError`. `IdentifierUnchangedError`
(new == current) is a typed no-op the field prevents (Change key stays disabled
when the value equals the current key), so it has no error panel.

## Previous keys + release

The **Previous keys** row appears in the card only when `previousKeys.length > 0`
(panel 5 right shows the zero-aliases case — the row is **absent**, not an empty
box). Each row = a `Key` glyph + the mono key + its retired-date + a `ghost`
**Release** button. Chained renames each get their OWN row (PROD-row + NIFR-row
on the NIF project — they resolve flat, matching 6.8.2's no-chain-walk rule).
Release opens the **danger confirm** (archive-confirm grammar) naming the
consequence; **no typed-identifier arm step** — releasing is recoverable only by
a fresh rename back to that key, and the broken-links consequence is the gate
(parity with the automation rule's `DeleteRuleModal` in
`app/(authed)/settings/project/automation/_components/AutomationSettings.tsx`,
which also drops the arm-step when a consequence statement suffices).

## Save states (panel 1)

The card footer is the **save bar**: **clean** (Save disabled, no status),
**dirty** (amber dot + "Unsaved changes", Save enabled), **saving** (spinner,
both buttons locked), **saved** (`--el-success` check + "Saved", auto-clears).
Name + avatar edits batch through this single Save (one `updateDetails` PATCH);
the **key change is its own modal flow** (a separate, guarded mutation) and does
NOT ride the save bar — re-keying every issue is too consequential to fold into a
generic "Save changes".

## Gated state (panel 5 left — the 6.4.6 grammar)

A non-admin **member** sees the values but **no controls**: no Save bar, no
"Change" / "Remove" image controls, no "Change key" affordance, no Danger zone — the `Read-only` Pill
replaces the `Admin` Pill (the same degradation 6.5.1 drew for the read-only
Details landing). The actions also **reject server-side** (the 6.8.1
admin-gated PATCH/DELETE → typed 403) — hiding is presentation, the gate is the
service. This is the 6.4.6 read-only grammar 5.4 / 6.4 / 6.5 all share.

## Copy strings catalog (use verbatim in 6.8.4; i18n under `settings.details`)

`{Project}` = display name, `{IDENT}`/`{NEW}`/`{OLD}` = project keys (mono).

| Surface                       | String                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page title / sub              | `"Details"` / `"Your project's name, logo and key. Changing the key re-keys every issue and keeps old links working. Only project admins can edit these."`                                                                           |
| Card title                    | `"Project details"`                                                                                                                                                                                                                  |
| Logo row (no label) / help    | _no label — the logo identifies itself_ / `"PNG or JPG, up to 2 MB. Shown wherever the project is named; projects without one show their name alone."`                                                                               |
| Logo buttons                  | `"Change"` (a logo is set) · `"Upload logo"` (none is set — the ONE place the word is load-bearing) · `"Uploading…"` · `"Remove"`                                                                                                    |
| Remove-logo modal             | title `"Remove project logo?"` / body `"Motir will show {Project} by name wherever the logo appears. You can upload a new one at any time."` / buttons `"Cancel"` · `"Remove logo"`                                                  |
| Logo rejections (client)      | wrong type `"That file type is not supported. Use a PNG or JPG."` · too large `"That logo is over 2 MB. Choose a smaller file."`                                                                                                     |
| Logo success toasts           | `"Project logo updated"` · `"Project logo removed"`                                                                                                                                                                                  |
| Name field label / help       | `"Name"` / `"The display name across the app. The URL slug is not affected."`                                                                                                                                                        |
| Key field label / help        | `"Key"` / `"Issues are keyed {IDENT}-1, {IDENT}-2, … Changing it re-keys every issue and keeps old links working."`                                                                                                                  |
| Change-key affordance         | `"Change key…"`                                                                                                                                                                                                                      |
| Save bar (clean→saved)        | `"Unsaved changes"` · `"Saving…"` · `"Saved"` · buttons `"Cancel"` / `"Save changes"`                                                                                                                                                |
| Change-key modal title / lede | `"Change project key"` / `"The key prefixes every issue ID in {Project}. Pick a new one — 3–5 uppercase letters or digits."`                                                                                                         |
| Change-key field label        | `"New key"`                                                                                                                                                                                                                          |
| Available / consequence (go)  | `"Available"` · `"Every issue identifier becomes {NEW}-1, {NEW}-2, … — the numbers stay the same."` · `"Old {OLD}- links keep working — they redirect to the new key."`                                                              |
| Format error                  | `"\"{value}\" is not a valid project key (use 3–5 uppercase letters or digits)."` (≡ `InvalidIdentifierError`)                                                                                                                       |
| Collision — live key          | `"Another project in this workspace already uses the key \"{value}\"."` (≡ `IdentifierTakenError`)                                                                                                                                   |
| Collision — reserved          | `"The key \"{value}\" is reserved by another project's previous key."` (≡ `IdentifierReservedError`)                                                                                                                                 |
| In-flight lede / button       | `"Re-keying every issue to {NEW}-. This is one atomic change — it won't leave issues half-renamed."` · `"Changing key…"`                                                                                                             |
| Change-key buttons            | `"Cancel"` / `"Change key"`                                                                                                                                                                                                          |
| Success toast                 | `"Project key changed to {NEW}. Every issue is now {NEW}-<n>, and old {OLD} links keep working."`                                                                                                                                    |
| Previous keys label / row     | `"Previous keys"` · `"retired {date}"` · button `"Release"`                                                                                                                                                                          |
| Previous keys help            | `"Old links to these keys redirect to {IDENT}."`                                                                                                                                                                                     |
| Release confirm title / body  | `"Release {IDENT}?"` / `"Releasing {IDENT} frees it for other projects and breaks old {IDENT} links — they'll stop redirecting and start returning \"not found\". This can't be undone except by changing the key back to {IDENT}."` |
| Release confirm buttons       | `"Cancel"` / `"Release key"`                                                                                                                                                                                                         |

The change-key error strings are the SAME text the 6.8.1 `errors.ts` constructors
build — keep them in lock-step (the route returns the typed `code`; 6.8.4 maps
`code` → the i18n string above, so the wording lives once in the catalog).

## Recorded deviations from the mirror (justified — no complexity for nothing)

- **No image upload** for the avatar — preset icon + tint only (above). Jira's
  own default avatars ARE a preset library; upload is the documented extension.
- **No description / category / lead / default-assignee** fields — absent from
  the shipped `Project` model (rung 2); component default-assignees (5.4) cover
  the default-assignee need. Each is a documented extension slot.
- **`slug` is not regenerated** on rename — it's a create-time artifact no URL
  consumes; touching it would break nothing and help nothing.
- **Key change is its own modal**, not an inline save-bar field — matches Jira's
  guarded flow and protects against an accidental whole-project re-key.

## Extension slots (reserved — do NOT build here)

- ~~Avatar **image upload**~~ — **DELIVERED** by MOTIR-2588 (2026-08-11): the mark
  IS an upload now. What stays reserved is the richer half this slot also implied —
  **cropping / resizing / moderation**, which the shipped path deliberately omits
  (the file is stored as uploaded behind a MIME + size gate).
- **Project description / category / lead** — when the model grows the fields.
- A workspace-level **"reserved keys" admin view** — deletion already cascades
  the aliases (the 6.8.1 `onDelete: Cascade`), so there's no orphan to manage yet.

## Tokens & a11y

Colour is `--el-*` only — `--el-tint-{peach,rose,mint,lavender,sky,yellow}` for
the avatar swatches/chips + the modal-icon circles (hue in the bg,
`--el-text-strong` glyph — finding #35, AA holds), `--el-success` (Available +
Saved), `--el-warning` (the dirty dot), `--el-danger` + `--el-danger-text` (the
Input error outline + message + the release danger button), `--el-accent` (the
picker selection ring + Save / Change-key primary), `--el-type-task` (the mono
avatar fallback). No grey-+-primary collapse (finding #54): the picker, chips,
and modal icons carry real hue. Shape via the element shape tokens
(`--radius-card/-input/-modal/-btn/-control/-badge`,
`--spacing-card-padding/-input-*/-control-*/-chip-*/-btn-x`,
`--height-input/-btn-*/-control`, `--shadow-card/-elevated/-modal/-subtle`);
`rounded-full` only on the colour swatches / the dirty dot / the spinner / the
modal-icon circles. A11y: each editable row is a labelled `field`; the avatar
picker is a keyboard-complete `Popover` (the icon grid is a roving-tabindex
listbox, the swatches a radiogroup); the change-key field validation is
`role="alert"` on the message + the success line `role="status"`; both modals are
focus-trapped, ESC-closable, and the danger confirm's action is reachable without
a typed arm step; the Toast is `role="status"`. Extends the settings strict axe
sweep. Dark parity verified by toggle.

## Source of truth

When a string here disagrees with shipped 6.8.4 code, the code wins — file a fix
so the mockup stays the reference (and keep the change-key error strings in
lock-step with `lib/projects/errors.ts`). `details.mock.html` is the
layout-confirmation artifact; it may drift from pixel-exact production once the
React lands.

---

# In-app new-project entry — keep "Create project", add "Plan a new project with AI" (MOTIR-1485)

**Subtask:** MOTIR-1485 · 7.22 (`type: design`) · **Story:** MOTIR-1459 (Onboarding entrance — the
new-vs-existing front door & routing) · **Epic 7 · AI Planning Layer.**
**Asset:** `inapp-plan-with-ai.mock.html` (source of truth, standalone — re-states the real
`globals.css` `--el-*` values, **under the `--el-*` names**, so it paints without the Tailwind build,
exactly as `design/onboarding-entrance/*.mock.html` does) · `inapp-plan-with-ai.png` (full-page export,
light theme, `deviceScaleFactor: 2`).

> **⚠️ AMENDED 2026-09-03 (MOTIR-4352) — the line above said "`--el-*` VALUES", and the VALUES were
> never the problem. The NAMES were.**
>
> This asset's `:root` copied the design system's values onto privately-named aliases — `--text`,
> `--strong`, `--secondary`, `--muted`, `--faint`, `--page`, `--surface`, `--soft`, `--hub`, `--hair`,
> … — and painted through them at all 149 sites. `tests/theme/inkContrastMockScan.ts` and
> `tests/theme/mockStateInkScan.ts` classify ink by reading an `--el-*` name off the declaration AT
> THE PAINT SITE, so this file was outside every ink guard in the tree **by construction**, and their
> tree-wide greens said nothing about it. (Note the cross-reference above: `design/onboarding-entrance`
> was cited as the exemplar and carried the same defect — swept the same day by MOTIR-4351.)
>
> **Declaring the ink under its real name made it measurable, and it was carrying EIGHTEEN sub-AA
> elements:** thirteen on `--el-text-faint`, which clears AA on **no** surface at all (2.37–2.61:1),
> and five on `--el-text-muted` at 4.12–4.34:1 on `--el-surface`. All eighteen now take
> **`--el-text-secondary`** (6.18–6.80:1 on all four surfaces, both themes). The rules re-inked:
>
> - `.panel-cap` → `.note`
> - `.col-cap`
> - `.state` → `.st-cap`
> - `.closeup` → `.cu-cap`
> - `.forkref` → `.fr-cap`
> - the two inline sites in the "No project" empty state
>   `.rail .navitem.dim` KEEPS `--el-text-faint`: a dimmed nav
>   item is inactive text, which WCAG 1.4.3 exempts and the guard agrees with. The `.inp` placeholder
>   takes `--el-text-muted`, which the guard confirms clears AA on the white card it sits in.
>
> **`.helper.err` was painting `--el-danger` as page text — the MOTIR-3663 defect, 1.00:1 in every
> palette's light theme**, where the ink and the page are the same white. It now takes
> `--el-danger-on-surface` (`color-mix(in srgb, var(--el-danger) 70%, var(--el-text))`), which is the
> token that exists for exactly this. `.inp.err`'s BORDER keeps `--el-danger`, which is correct.
>
> **Four invented hues are gone**, each now a token or a `color-mix()` whose inputs are all tokens:
>
> | was                        | is                                                           | note                                                      |
> | -------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
> | `--page: #f4f3f1`          | `--el-surface` (`#f6f5f4`)                                   | nearest token by value and role; a 3-unit shift           |
> | `--border-strong: #d3cfc8` | `--el-border-strong` (`#c8c4be`)                             | the role is exact; the value was an invented intermediate |
> | `--accent-soft: #f4f2fd`   | `color-mix(in srgb, var(--el-accent) 7%, var(--el-page-bg))` | all-token inputs                                          |
> | `--danger-soft: #fdecec`   | _deleted_                                                    | declared and never used                                   |
>
> Four raw literals at points of use went with them, each now an all-token `color-mix()` or a token:
>
> - `#e3def8` on the `.ref` border → a 17% accent mix over `--el-page-bg`
> - `#1a1a1a26` on the `.canvas.dim` scrim → a 15% `--el-text` mix over `transparent`
> - `#ffffff66` on `.spin` → a 40% `--el-accent-text` mix over `transparent`
> - `#fff` on the accent fills → `--el-accent-text`
>   Nine dead aliases were deleted rather than translated. Shape and type aliases carry
>   no colour and are untouched. The `.png` re-export reports `EXACT` at 2560×5316 — the drawn design
>   did not move.

The **IN-APP door** to Journey 1 (create a project → plan it with AI). The first-login / marketing
door already exists (MOTIR-1457: root → `/sign-in` → "Plan with AI" → `/onboarding`). This card draws
the OTHER door: an **already-authenticated** user starting a new project from inside the app.

## The shape (per Yue): keep "Create project", ADD "Plan a new project with AI" as a peer door

There is **no mode-chooser modal and no restructure of the shipped modal.** Every host surface carries
**two independent, peer affordances**:

- **"Create project"** — the shipped manual flow, **kept verbatim**: it opens
  `app/(authed)/_components/CreateProjectModal.tsx` (`Modal`; Name + live-keyed Identifier; the
  `isPending` spinner; the `IDENTIFIER_COLLISION` inline error) — 1.3.4 / MOTIR-40, design 1.3.3 /
  MOTIR-39. This card adds NOTHING to that modal.
- **"Plan a new project with AI"** — the new affordance. On click it submits `startNewAiProjectAction`,
  which **mints a fresh draft project** (provisional "Untitled project" name), pins it active, then
  routes to `/onboarding` — the shipped fork screen (MOTIR-1461, `design/onboarding-entrance/`). No
  modal of its own; the draft is created **up front** (not downstream), so the door always plans a NEW
  project.

The two are siblings — neither is nested inside the other. (This replaces an earlier draft that folded
both into a single choice modal; Yue's direction is to keep the shipped "Create project" untouched and
add the AI door alongside it.)

## One fork UI, not two (the AC decision)

**"Plan a new project with AI" ROUTES to `/onboarding`** — it does NOT redraw a second inline fork.
The fresh-vs-import choice lives ONLY on that route (owned by MOTIR-1461). So **MOTIR-1486 wires the
door; it does not build a fork.** For the start-fresh (AI) path the door **mints a fresh draft project
up front** — `startNewAiProjectAction` calls `createProject` (provisional name) → `setActiveProject` →
`redirect('/onboarding')` — so onboarding plans into that NEW draft, not the previously-active project.

> **Correction (MOTIR-1552 / notes.html #130).** An earlier draft of this note claimed no project was
> created for the AI path because it was "created downstream (at discovery/materialize, done 7.3)". That
> premise was **false**: `/onboarding` → discovery → `plansService.materialize` writes into the
> **already-active** project via `getActiveProject` and never calls `createProject`, so a bare route to
> `/onboarding` planned into the existing project. MOTIR-1486 was re-scoped to create the draft up front
> (above); naming it from the generated plan is the follow-up MOTIR-1551 (`renameProject` consumes a
> suggested name the plan output does not carry yet).

The import path still hands off to the 7.15 / MOTIR-815 · 7.17 / MOTIR-817 wizard. Nothing on this
surface connects a repo or picks a Jira/Linear tracker.

## Access path — both doors drawn IN SITU on every host surface (notes.html #83)

The access-path rule applies **once per host surface**; a "start a project" affordance lives in these
places, so BOTH doors are drawn (label + placement + which mode each opens) in each:

| Host surface (shipped)                 | The two doors, placed                                                                                                        | What each opens                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Project switcher popover** (Panel 1) | Footer, below the _Projects_ list + hairline: **✨ Plan a new project with AI** (accent) directly above **+ Create project** | AI → `/onboarding` fork · Create project → the shipped modal |
| **Empty-project state** (Panel 2)      | Primary `Button` **Plan a new project with AI** + secondary `Button` **Create project**                                      | AI → `/onboarding` fork · Create project → the shipped modal |

"Plan a new project with AI" leads (accent row / primary button — Motir is chat-first, Principle #1);
"Create project" is the kept, always-present manual path. Exact labels: **"Plan a new project with
AI"** and **"Create project"** (verbatim).

---

# Roles & permissions — the role list, a role's permissions, and creating one (Story MOTIR-2255 · Subtask MOTIR-2259 output)

The surface at **Project settings → Access → Roles & permissions**: what each role in a project can
do. This story ships it **read-only** over the three built-in roles;
[MOTIR-2257](motir:cmsgmdaim001g04joump8d6mi) adds custom ones. This section is the canonical
reference for [MOTIR-2263](motir:cmsgmj2eu003904jo49c5r3k6) (the read screens + the rail entry) and
for MOTIR-2257 (the create page).

| HTML source (truth)           | PNG export              |
| ----------------------------- | ----------------------- |
| `roles-permissions.mock.html` | `roles-permissions.png` |

## The structure: a DRILL-DOWN, because a matrix capped the feature it exists to serve

The surface is **two screens**:

1. **The role LIST** — one **row** per role, carrying its name, its purpose, `N of 28 permissions`
   and how many people hold it.
2. **The role DETAIL** — drill into one role and read its permissions at **full width**, 28 rows
   under 15 domain headings, each on one line with its description beside it.

An earlier revision put permissions on ROWS and roles on COLUMNS. It read well at three roles and
**could not survive five**, which is why it was replaced. Measured in this mock:

|                        |                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Content column         | **902px**                                                                              |
| One role column        | **132px**                                                                              |
| Permission label needs | **~390px** to keep a description on one line                                           |
| So the matrix holds    | **3 roles comfortably, 4 with every description wrapped to three lines, 6 not at all** |

A permission catalog grows slowly and deliberately — 28 keys, added by a card that argues for each.
The number of roles a team invents does not, and **custom roles are the entire point of MOTIR-2257**.
A structure whose width is consumed by the thing the feature adds is the wrong structure: it would
have shipped a role editor onto a page that breaks at the second or third role somebody creates. The
list has no such ceiling, and the detail screen gets the whole 902px back — which is why a
description that wrapped to three lines in the matrix now sits on one.

**What the trade costs, and where it is paid back.** The matrix's one real virtue was side-by-side
comparison, and a drill-down loses it. Two things carry it instead, and both survive at any number of
roles:

- the list's **`N of 28`** on every row — the coarse comparison, scannable in one pass;
- a custom role's own **`N of 28`** on the SAME row, read against the built-ins above it. An earlier
  revision proposed a `Based on Viewer · +2` chip here instead; it was removed (Yue, 2026-08-09)
  because it compared against a base the product does not record — see § _A role is its name and its
  set_ below.

**Panels 1 and 2 are the same screen** in its built-in and custom states; the differences are the two
admin-only write affordances (`Edit`, `Delete`). The **breadcrumb and the
`← All roles` link both appear**, deliberately: the inherited crumb trail is orientation, the back
link is the control, and a drill-down needs a control rather than a place to read where you are.

## The model the screens render — as it WILL BE, not how far enforcement has got

|                       |                                                     |
| --------------------- | --------------------------------------------------- |
| Role-gated rows       | **28**                                              |
| Domain headings       | **15**                                              |
| Level-gated, own card | **3** (`public_request:*`)                          |
| The three built-ins   | Admin **28** · Member **10** · Viewer **2** (of 28) |

**Every mark is the grant the role holds when the epic is finished.** The marks come from two
records, and neither is a guess:

- **The 20 keys already wired** — `lib/permissions/builtinRoles.ts` on `origin/main`, after
  [MOTIR-2256](motir:cmsgmcpy2001a04joa4k7rjtb) put the twelve per-domain administrative keys into
  `admin`. `ROLE_GATED_PERMISSIONS` is the row set; `BUILTIN_ROLE_PERMISSIONS` is the marks.
- **The 8 member-facing keys [MOTIR-2291](motir:cmshequ8x000004jx8cty50hs) has yet to wire** —
  `work_item:delete`, `work_item:triage`, `sprint:manage`, `report:view`, `saved_filter:manage`,
  `import:run`, `ai:plan`, `ai:view_plan` — take the grants
  [MOTIR-2347](motir:cmsiao000001304lb5gsec1wp) decides, each argued from Jira / Plane / Linear.
  Admin holds all eight; Member holds six (not `import:run`, admin-only per Plane and Linear; not
  `work_item:delete`, admin-only per Jira's default scheme); Viewer gains only `report:view`, because
  Jira has no separate report permission — _Browse Projects_ is what governs a report.

**A settings page describes the product, not its migration.** Three revisions tried to put Motir's
own wiring progress into a customer's screen — hiding the unwired keys (8 of 32, implying that was
the model), marking them _"Not yet enforced"_, then showing them held by nobody, which read as "no
role in this project can manage a sprint, a board, a field or a report". All three describe a
half-finished migration; none describes the product.

> **This asset draws MOTIR-2347's recommendation as settled, and that card has not run.** It sits in
> a later story, so the design would otherwise be blocked on a decision nobody is scheduled to make
> before the screens are built. The recommendation is fully argued with its mirror evidence, so
> drawing it is the cheaper order — but it is a **ratification these screens depend on**: if
> MOTIR-2347 lands a different answer for any of the eight, that row's mark changes with it.

`repository:connect` is **absent**, not withheld: [MOTIR-2294](motir:cmshf0mm5000f04l1liqnk2a0)
retired it. Its operations bind a provider installation to a **workspace** and resolve no project, so
no project role could ever govern them.

**A withheld permission stays fully legible** — a dash, never a dimmed row. The screen's job is to
show the whole model, so "not held" has to be as readable as "held".

## Panels (inspect every one)

0. **The role LIST, project-admin view** — five roles, drawn at a size the matrix could not hold,
   inside the settings shell with the access path (the rail's ACCESS group, under _Members &
   access_). **MOTIR-2263 builds this screen.**
1. **A BUILT-IN role's permissions** — drilled into `Member`. The whole model at full width. A
   built-in is immutable, so the head carries a **lock and no control at all**. **MOTIR-2263 builds
   this screen.**
2. **A CUSTOM role's permissions** — `Contractor`, the epic's own motivating gap (_may comment and
   attach, but cannot edit a work item_), which none of the three built-ins can express. Same screen
   plus `Edit` and `Delete`. NO provenance chip — see § _A role is its name and its set_.
3. **Creating a role — a WHOLE PAGE** (MOTIR-2257) at `/settings/project/roles/new`. See below.
4. **The member (non-admin) view** — browse-gated, so a member reads the same list and drills into
   the same screens. Two differences, both admin-only WRITE affordances: no `Create role`, and a
   custom role's screen carries no `Edit` or `Delete`.
5. **Deleting a custom role** (MOTIR-2463) — the reassign dialog in both states. See below.
6. **`Create role` at the cap** (MOTIR-2463) — visible, disabled, explained. See below.

## Creating a role is a PAGE, not a dialog

A revision before this authored a role in a modal. Measured in a 1200×900 chromium, **that dialog was
2165px tall — 2.4× the viewport**, of which 1675px was the permission list.

A form that long is a page. So create is `/settings/project/roles/new`, and it gets three things a
dialog could not give it:

- **the same full width the detail screens have**, so every permission description sits on one line
  and the author reads the model rather than a wrapped column;
- **one layout for one catalog** — the create page's permission list is the detail screen's list with
  its marks swapped for checkboxes, not a second grammar invented for a dialog;
- **a pinned action bar** carrying the running count and `Cancel` / `Create role`, held at the
  bottom of the viewport for the whole scroll so the commit is never 1500px away from the tick that
  changed the answer.

### The pinned bar: the mechanism, and the trap that bit this mock

`position: sticky; bottom: 0` pins against the **nearest scrolling ancestor**. In the shipped app
that is `AppLayout`'s `<main>` — `min-h-0 overflow-y-auto` inside an `h-dvh overflow-hidden` column
(`components/ui/AppLayout.tsx:56,80`) — and `app/(authed)/settings/project/layout.tsx` is a
pass-through, so the bar pins correctly there.

⚠️ **Any ancestor between `<main>` and the bar that sets `overflow` to anything but `visible` kills
it silently.** The element keeps `position: sticky` in its computed style and simply never pins —
there is no warning and nothing looks wrong in the CSS. That is exactly what happened here: this
mock's inherited `.content` and the review page's `.stage` are both `overflow: hidden`, so an earlier
revision of this asset **declared a sticky bar that did not stick**, and the notes claimed a
behaviour the file did not have. It was caught by measuring — scroll the page, then read the bar's
`getBoundingClientRect().bottom` against `window.innerHeight` — not by reading the CSS.

Two consequences for **MOTIR-2257**:

1. Do not wrap this page in a clipping container, and do not add `overflow-hidden` to a wrapper for
   rounded corners without re-checking the bar.
2. **Assert the pinning in a test** rather than trusting the declaration — scroll the scroll
   container, then assert the bar's bottom edge is still at the container's bottom edge. A
   declaration that silently no-ops is precisely the thing a test is for.

**Panel 3 renders inside a fixed-height `overflow-y: auto` frame** (`.panel.vp .content`) that
reproduces what `<main>` actually is, so the bar pins for real in the mock and in the PNG — a
full-page screenshot can never show a pinned element otherwise. The 760px height is **review chrome**;
the app takes its height from `h-dvh`. No trailing spacer is needed: the bar is the last child, so at
full scroll it returns to its static position with every row above it.

The author names the role and picks one to **start from**; that role's grants arrive **ticked**, and
the author edits freely from there. Starting from a base rather than an empty list is the GitHub
custom-role pattern; it keeps a new role comprehensible instead of asking the author to derive 28
booleans from nothing.

⚠️ **The pick SEEDS the grid and is not stored** (Yue, 2026-08-09). So the ticks carry no
"where did this come from" distinction — there is one checked state, not two — and re-opening a saved
role shows its set without claiming a lineage. See § _A role is its name and its set_.

**Editing a custom role is this same page with the values filled in**, reached from the `Edit` button
on panel 2 — one authoring surface, built once.

Rejected: **a shorter modal** with a domain navigator inside it (still a dialog on top of the page it
duplicates); **a two-step dialog** (moves the height into step 2 rather than removing it); and
**authoring in a live column of the matrix** (elegant while the matrix existed, and dead with it).

## Deleting a custom role — panel 5 (MOTIR-2463; **MOTIR-2480 builds it**)

Panel 2 drew a `Delete` button and stopped there. This is the flow behind it, and it is the moment
this feature is most able to hurt somebody: a role that vanishes out from under the four people
holding it either silently promotes them or silently strips them, and both are discovered by the
person who can no longer do their job.

So **the delete is refused until the admin says where those people go.** The dialog is the shipped
`workflowsService.deleteStatus` shape one domain over — a typed in-use refusal carrying the affected
count when no destination is given, and a reassign-then-delete in one transaction when one is
(`lib/services/workflowsService.ts`'s `StatusInUseError`, and `ReassignModal` in `WorkflowEditor.tsx`,
which this composes rather than re-invents). Custom-field options are the _counter_-example, not the
precedent: `customFieldsService.deleteOption` throws and the UI offers archive instead. A role has no
archive.

**Two states, both drawn:**

|                    | members > 0                                                                           | members = 0                                                             |
| ------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| the count line     | `4 members hold this role.` — `--el-text`, not muted: it is the load-bearing sentence | `No one holds this role, so nobody is affected.`                        |
| destination picker | **required** (`Move those 4 members to`)                                              | **absent** — asking where nobody should go is a question with no answer |
| the confirm        | `.btn-danger`, **disabled** until a destination is chosen                             | `.btn-danger`, armed                                                    |

**Where the count comes from.** The DELETE is fired WITHOUT a destination first; the server answers
`409` with the count, and that number is what the dialog says. It is not re-fetched and not guessed —
which is also why a role somebody is added to between the refusal and the confirm is simply refused
again, with the new number (drawn as the second consequence line in state B).

**The picker stays CLOSED here, deliberately.** `access-members.mock.html` owns the role-select
grammar and this asset composes it; its panel 5 draws the open list (built-ins, then the project's
own roles). Drawing a second open list here would be this asset re-specifying something it inherits.

**The `Modal` block is used again.** This section previously recorded the inherited `Modal` as
_"inherited but no longer used"_ because role authoring became a page. Panel 5 uses it, and uses
`.btn-danger` with it — so of the two `color: #fff` literals the inheritance note lists, only
`.proj .pav`'s is still on an unused rule.

## `Create role` at the cap — panel 6 (MOTIR-2463; **MOTIR-2480 builds it**)

A project holds a bounded number of custom roles (`MAX_CUSTOM_ROLES_PER_PROJECT` in
`lib/permissions/limits.ts`, the posture `lib/customFields/limits.ts` already ships for fields). At
the cap the button is **visible and disabled, carrying its explanation in a `Tooltip`** — the
treatment § _Gating affordances (6.4.6)_ prescribes for an **in-place** control (as opposed to
navigation-to-an-edit-surface, which that section hides). The reason it is not hidden: a missing
button reads as _"this project cannot have custom roles"_, and a disabled one reads as _"you have
used them all"_ — which is the true statement and the one that tells the admin what to do next.

The tooltip composes the shipped `Tooltip` primitive verbatim — `--el-tooltip-bg` / `--el-tooltip-text`
(both added to this mock's token block from `packages/design-system/theme.css`, and both resolving
through `--color-foreground` / `--color-background`, so they invert with the theme on their own),
`--radius-control`, `--spacing-tooltip-x/y`, `--shadow-elevated`. **Disabled text is the one place
`--el-text-faint` would be legitimate** (1.4.3 exempts it) and it is still not needed here: the
button dims via `opacity`, and the explanation lives on the inverted tooltip.

**The number in the copy is read from the constant, never restated** — the page imports the same
`limits.ts` the service enforces, so the button and the refusal cannot disagree.

## The bulk grant-all / clear-all toggle — DECIDED, and REJECTED (MOTIR-2463)

**There is no domain-level grant-all / clear-all control, and its absence is a decision, not an
omission.** This paragraph exists so that nobody building the editor has to wonder.

The affordance was worth asking about: with 28 role-gated permissions, a heading that could tick its
whole group is the shape Jira's named permission bundles amount to on a catalog that is already
grouped. Two measurements killed it.

**First, the group sizes.** Counted from `PERMISSION_META` on `origin/main`, the 28 role-gated keys
fall under 15 headings like this:

| rows under one heading | headings                                                                         |
| ---------------------- | -------------------------------------------------------------------------------- |
| **3**                  | `work_item`, `field`, `ai`                                                       |
| **2**                  | `project`, `comment`, `attachment`, `member`, `workflow`, `report`, `repository` |
| **1**                  | `watcher`, `board`, `sprint`, `estimation`, `import`                             |

The **median heading governs two checkboxes** and five govern exactly one. A bulk control saves at
most two clicks and, on a third of the headings, saves none while adding a control that cannot be
anything but already-on or already-off. Against that: fifteen new tri-state controls on the page, an
indeterminate arm on a `Checkbox` primitive being introduced by this very story, and a second way to
change the same value — so a reader of the page has to work out which of two controls last spoke.

**Second, the job is already done by the base picker.** The one-move-to-a-sensible-set problem is
real, and this design already answers it: the editor opens on a copy of a **built-in base**, so the
author starts from a role that works and takes two things away. That is the same problem Jira's
bundles solve, solved once, at the top of the page, in the grammar the rest of the surface uses.

**What the editor does instead**: the pinned action bar carries the running count, so the author can
always see the size of what they are composing without a per-domain control to read it off.

If this is ever revisited, the trigger to watch for is the catalog growing headings of **six or more**
rows — not the total. That is the number at which "tick this whole group" stops being two clicks.

## Access path (drawn, not just named)

The rail's **ACCESS** group, beneath **Members & access** and above **Code access** — drawn in every
panel. The registry entry MOTIR-2263 adds is `id: 'roles'`, group `access`, href
`/settings/project/roles`, `access: browse` (every current entry is browse-gated; changing that to a
permission is MOTIR-2258's job). **Icon:** the `shield` glyph (`Shield` from `lucide-react`).

**Routes.** `/settings/project/roles` (list) · `/settings/project/roles/[roleKey]` (detail) ·
`/settings/project/roles/new` (create, MOTIR-2257). Only the first is a rail entry; the other two are
drilled into, so the rail keeps **Roles & permissions** active on all three.

## What this asset does NOT re-specify (it composes)

| Surface                                                                 | Owned by                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| Settings-area chrome — rail, groups, back-link header, `.content` frame | `design/projects/settings-area.mock.html` (6.5.1)  |
| Role-chip grammar, and the `secondary` Button variant                   | `design/projects/access-members.mock.html` (6.4.1) |
| `Input` / editable-field rows, and the `Modal`                          | `design/projects/details.mock.html` (6.8.3)        |

All three are inherited **verbatim** — their CSS is copied in unchanged so this asset cannot drift
from them. A change to any belongs in _that_ asset. (The `Modal` block was inherited and, while role
authoring became a page, unused — **MOTIR-2463's panel 5 uses it again** for the delete-with-reassign
dialog, which is the one thing on this surface that genuinely is a dialog. It was kept
byte-identical rather than pruned, which is exactly why it was there to compose from.)

> Two `color: #fff` literals survive inside the inherited blocks (`.proj .pav`, and `.btn-danger` —
> now used, by panel 5's destructive confirm). They are **pre-existing**, carried byte-identical
> rather than silently diverged; this asset introduces no colour literal of its own.

## Primitives composed — MOTIR-2263's screens need NO new primitive; MOTIR-2257's page needs exactly ONE

| Element                               | Shipped primitive                                   | Token role                                                                                                   |
| ------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| The role list · the permission card   | `Card`                                              | `--radius-card` · `--shadow-card` · `--el-border`                                                            |
| A role ROW                            | the `MembersCard` row grammar                       | `--spacing-card-padding` · hover `--el-surface-soft`                                                         |
| A role's TILE                         | `Pill` tint grammar                                 | built-in `--el-tint-lavender` · custom `--el-tint-sky` · `--el-text-strong` ink                              |
| `Built-in` lock · `Custom` chip       | `Pill`                                              | `--el-text-faint` · `pill-member` sky                                                                        | — faint is correct here: the `Built-in` lock is a glyph. |
| Domain heading                        | `SectionLabel` grammar                              | `--el-muted` · `--el-text-secondary`                                                                         |
| Held / withheld / level-gated mark    | icon + `aria-label`                                 | `--el-success` · `--el-text-faint`                                                                           |
| `Create role` · `Cancel` · `Edit`     | `Button` (primary / ghost / secondary)              | `--el-accent` / `--el-accent-text` · `--radius-btn` · `--height-btn-md`                                      |
| `Delete` on a custom role             | `Button` (icon)                                     | `--spacing-icon-btn` (PADDING) · `--radius-control`                                                          |
| Name field · Start-from picker        | `Input` / `FormField`                               | `--radius-input` · `--height-input` · `--spacing-input-x/y`                                                  |
| The sticky action bar                 | `Card`                                              | `--radius-card` · `--shadow-elevated`                                                                        |
| Rail, groups, rows                    | `Sidebar` / `SidebarSection` / `SidebarNavItem`     | `--el-sidebar-*` · `--radius-control` · `--height-control`                                                   |
| **Permission checkbox** — **NEW**     | ⚠️ **`Checkbox`, to be added by MOTIR-2257**        | `--radius-control` · `--el-border-strong` · `--el-accent`                                                    |
| Delete-with-reassign dialog (p5)      | `Modal` (inherited) + `Button` (`danger` / `ghost`) | `--radius-modal` · `--shadow-modal` · `--el-danger` · destination picker on `Input`/`FormField`              |
| Cap explanation on `Create role` (p6) | `Tooltip`                                           | `--el-tooltip-bg` / `--el-tooltip-text` · `--radius-control` · `--spacing-tooltip-x/y` · `--shadow-elevated` |

**The one new primitive.** `components/ui/` ships `Switch` and `MultiSelectPicker` but no `Checkbox`;
the product's only checkbox is a raw unstyled `<input type="checkbox">` in `WorkflowEditor.tsx`.
Twenty-eight of those on a settings page is not acceptable, and a `Switch` is the wrong grammar (it
says _this setting is on now_; a checkbox says _this is part of the set I am composing_). So
MOTIR-2257 adds one — and **MOTIR-2263's two read screens are unaffected**, since they draw marks,
not controls.

**One data note for MOTIR-2263.** The list's **member count** per role is the only thing on these
screens that is not derivable from the catalog and the role sets — it needs a group-by over project
memberships. It earns its place (an admin opening this page wants to know who is affected), but if
the count is not cheaply available it may be **deferred**: the row layout reserves the slot and reads
correctly without it. Nothing else on the screen depends on it.

### Colour + shape rules (mock === component)

> **⚠️ CONTRAST, MEASURED — the asset's first revision failed AA and the code had to
> diverge from it until this section was corrected (MOTIR-2455).** `AxeBuilder` on the
> real `/settings/project/roles` reported the `Built-in` chip and the member count at
> **2.39:1** and the role's purpose at **4.16:1**, against AA's 4.5:1. The cause was not
> the ink alone: this asset's own `.rolelist` / `.permcard` reached for `--el-surface`
> (`#f6f5f4`) while the inherited `.card` in this same file is already `#ffffff`, and that
> off-white halves the headroom every ink above it has.
>
> **Contrast is a property of the PAIR.** Measured across both themes:
>
> | ink                   | page / card | `--el-surface` | `--el-muted` | `--el-surface-soft` |
> | --------------------- | ----------- | -------------- | ------------ | ------------------- |
> | `--el-text-faint`     | 2.61 ✗      | 2.39 ✗         | 2.37 ✗       | 2.50 ✗              |
> | `--el-text-muted`     | **4.54 ✓**  | 4.17 ✗         | 4.12 ✗       | 4.34 ✗              |
> | `--el-text-secondary` | 6.80 ✓      | 6.24 ✓         | 6.18 ✓       | 6.51 ✓              |
>
> (Light theme, which is the binding one — every ink clears AA on every dark surface.)
>
> Three rules fall out, and they are the reason this section is worth reading before
> drawing the create page:
>
> 1. **`--el-text-faint` NEVER carries text that WCAG measures.** It clears AA on no
>    surface in either theme. It is for **decorative glyphs** (`.rchev`, `.lrow svg`, the
>    withheld `.pmark` — each `aria-hidden` or `role="img"` with its own label, so meaning
>    never rests on it) and for **disabled / inactive** text, which 1.4.3 exempts.
> 2. **`--el-text-muted` is AA-safe ONLY on the white page/card**, with 0.04 of headroom.
>    On any of the three off-white surfaces it fails. So a muted description is fine inside
>    a card and wrong on a tinted panel.
> 3. **This asset's own containers therefore take `--el-card`** — the same white the
>    inherited `.card` already paints and the same surface the shipped `Card` primitive
>    renders — so the descriptions can stay muted and the hierarchy survives.
>
> Every ACTIVE informational ink that was `--el-text-faint` is now `--el-text-secondary`:
> `.crumb`, `.lockchip`, `.rsum .rmembers`, `.pgroup`, `.permrow .from`, `.reserved-tag`.

- **Held** = `check` in `--el-success`; **withheld** = `minus` in `--el-text-faint`; **level-gated** (faint is correct here: the `minus` is a glyph)
  = `eye`. Each mark is a `role="img"` with an `aria-label` (_Held_ / _Not held_ / _Granted by
  access level_), so state is never carried by colour or glyph ALONE.
- On the create page a permission is held or it is not — **ONE checked state**, an accent-filled
  box. Each is a `role="checkbox"` with `aria-checked` and a label naming the state (_Held_ / _Not
  held_), so the state is never carried by fill colour alone. (An earlier revision had a second,
  grey "from the base" fill; it went with the stored base — with nothing recorded, a re-edit has no
  base for anything to have come from, so the two fills could not be told apart honestly.)
- A **built-in** role's tile is `--el-tint-lavender` and a **custom** one's is `--el-tint-sky` — the
  two tint slots `access-members.mock.html` already uses for Admin and Member. The kind is also
  stated in words (`Built-in` / `Custom`), never by tint alone.
- No Tier-0 `--color-*`, no raw `rounded-*` / `p-*` / `h-*` outside the inherited token block.
  `data-theme="dark"` verified on every panel.
- **`--spacing-icon-btn` is a PADDING token (4px), not a size.** Using it as `width`/`height`
  collapses an icon button to a 4px artifact — the glyph sizes the box, the token pads it.
- `.rp-headrow` / `.rp-stack` are named to AVOID colliding with the inherited `.page-head` /
  `.stack`; the latter is capped at 640px for the Details form column, which is wrong for these.

## Content grounding

The 28 role-gated permissions and their 15 domain headings are **transcribed from the shipped
catalog**, not invented: `lib/permissions/catalog.ts` on `origin/main` (MOTIR-2277), minus the three
level-gated `public_request:*` keys, which get their own card. **Row order is
`permissionsByDomain()`'s order** — `PERMISSION_DOMAINS` outer, `PERMISSIONS` inner — so the ordering
is a property of the catalog rather than a decision MOTIR-2263 re-makes in a component. (It is why
_Administer project_ precedes _View project_: that is the array's order, and matching it costs the
code nothing while diverging would cost it a sort.)

Copy matches the `permissions.*` i18n namespace, so MOTIR-2263 renders the same strings this mock
shows. **`Contractor` (4 of 28) and `Reporter` (6 of 28) are illustrative** — custom roles, not
shipped ones; they exist to draw the list at five roles.

### A role is its name and its set — nothing records where it started (Yue, 2026-08-09)

**Nothing stores which built-in an author started from, and no screen draws one.** An earlier
revision of this asset carried a `Based on Viewer · +2` chip on panel 2, fed by a `based_on` column.

The reason it went is the card's own words turned back on it: the base was **provenance, not
inheritance** — a snapshot taken at creation that never re-flows. That makes it a claim about how the
role was once _authored_ rather than a fact about what it _is_, and it goes stale the moment either
side is edited: change the role and the delta lies; change the built-in and the comparison lies. A
role that lists its permissions already says everything true about itself, and the list row's
`N of 28` gives the coarse comparison at a glance.

**`Start from` survives, because its argument was never provenance.** It exists so an author does not
face 28 blank checkboxes — a quiz rather than freedom. It seeds the grid in the browser and is not
sent, not stored and not rendered.

Three consequences, all of them simplifications:

- the checkbox has **one** checked state, not two (§ _Colour + shape rules_);
- `Reporter` and `Contractor` on panel 0 are just custom roles — neither chains off anything, and the
  earlier "re-cut Reporter onto a built-in" correction is moot;
- a membership on a custom role sits at one tier (`member`), so **the access level subtracts nothing
  from a custom role — it grants exactly what it lists**. That is the one behaviour change, and it is
  deliberate: the tier subtraction narrows the coarse built-ins, and a set an admin enumerated by
  hand is not coarse.

## Who builds what (MOTIR-2257's allocation, readable from the asset)

The 2026-08-09 amendment (MOTIR-2463) drew four things and rejected a fifth. Each is owned by exactly
one card, so no code card has to decide whether a surface is its:

| amendment                                                           | drawn in                                                          | **built by**                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| the delete-with-reassign dialog, both states                        | `roles-permissions.mock.html` panel 5                             | **MOTIR-2480** (the list + detail write affordances)                                                       |
| `Create role` at the cap, disabled + explained                      | `roles-permissions.mock.html` panel 6                             | **MOTIR-2480**                                                                                             |
| the Members role picker with custom roles, and the custom-role chip | `access-members.mock.html` panel 5 (+ its chip in panels 0 and 4) | **MOTIR-2485** (assigning a custom role)                                                                   |
| `Reporter` re-cut off a built-in base                               | `roles-permissions.mock.html` panels 0 and 4                      | asset-only — the content correction is this card's, and **MOTIR-2467** is what makes it true in the schema |
| the bulk grant-all / clear-all toggle                               | **REJECTED** — see the section above                              | nobody. The editor card (**MOTIR-2483**) does not build one, and does not need to ask                      |

The `Checkbox` primitive the create page composes is **MOTIR-2465**'s, and it needs **no**
indeterminate arm — that arm existed only for the bulk toggle, which is rejected.

## Source of truth

When a string or structure here disagrees with the shipped `lib/permissions/*` catalog or role sets,
**the code wins** — this mock renders them. The one deliberate exception is the eight keys MOTIR-2291
has yet to wire: for those, **MOTIR-2347's decision record wins over today's code**, because today's
code has no answer for them and this page must not show one it invented. When this asset disagrees
with `settings-area.mock.html`, `access-members.mock.html` or `details.mock.html` about chrome, chip
grammar, Input or Modal, **those assets win** — this one composes them.

---

# The permission-gated shell — the door that is not there (Story MOTIR-2258 · Subtask MOTIR-2464 output)

The shell as it renders for an actor whose role does not hold what a destination needs. Every other
card in Story MOTIR-2258 REMOVES something, and an absence is harder to specify than an addition:
adding a row has an obvious right answer (it looks like its neighbours), while removing one leaves a
hole and every hole has to be decided — does the gap close up, does anything acknowledge it, does the
group heading above it survive, does the separator below it. Decided once here so six sibling cards
do not answer those questions independently and differently.

## Files

| HTML source (truth)             | PNG export                |
| ------------------------------- | ------------------------- |
| `permission-gated-ui.mock.html` | `permission-gated-ui.png` |

A six-block board (five design panels + a trace table): **review EACH**. Toggle `data-theme="dark"`
on `<html>` (the button, top right) to confirm token parity.

## What this asset COMPOSES, and does not redraw

- **`design/projects/settings-area.mock.html`** (Subtask 6.5.1) — the settings rail, its groups, its
  rows, the back-to-project head. The token block and the `.rail` / `.grp` / `.nav-row` rules in
  this mock are copied from it **1:1**, so panels 1–3 show THE SAME rail with entries removed, in
  the same chrome. **This asset does not re-specify the rail.**
- **`design/shell/desktop.pen`** and **`design/shell/desktop-collapsed.pen`** — the app shell and its
  project nav (panels 1 and 4); **`design/shell/cmd-k.pen`** — the palette. **This asset does not
  redesign the shell.**

A second rail or shell specification would be built twice and drift; where a panel needs either, it
takes the shipped one.

## Where the RULE lives — this asset draws it, it does not author it

Every treatment below traces to a row of the **treatment table** in this file's
§ _Amendment 2026-08-08 — hide the entry point, disable the in-place control, guard the destination_
(Subtask **MOTIR-2462**). That section carries the three-part rule, the nine affordance families, and
the mirror evidence. **Do not read a rule out of this asset that the table does not carry** — and if
a surface needs a treatment the table lacks, that is a gap in the DECISION, not a licence to invent
one here. The trace table at the foot of the mock maps each panel to its table row, and states what
the asset adds that the table does not carry.

## The panels

### Panel 1 — the bottom nav: the Project settings door, present and absent

Table row **2** (HIDE, the settings AREA door). Two rails side by side: a project admin's, with
`Project settings` in the footer group; and a member's, with that row simply not rendered.

**Decided here: the gap is NOT marked.** No disabled row, no `Soon`-style chip, no tooltip, no "ask
an admin" line. The rows below (`Job runs`, `Git`, `Docs`) close up and the footer is one row
shorter. The dashed hatched block on the right of the mock is the REVIEW PAGE's annotation showing a
reader where the row was — **it is not product chrome and nothing renders in its place.** The reason
is the rule's own: an entry point is a promise about a room, and a disabled row is a promise the
product then refuses — the exact treatment the 2026-08-08 amendment supersedes for entry points.

**The door hides only when every entry INSIDE the area filters away.** An actor holding one settings
domain still gets the door and lands on panel 2's rail. The two workspace-scoped rows below it
(`Job runs`, `Git`) are not this story's and are drawn unchanged.

### Panel 2 — the settings rail for a partial role

Table row **1** (HIDE, the settings rail entry). A project admin's full rail — four groups, twelve
entries — beside a custom role holding two work domains and nothing else.

**A group with zero visible entries renders NO HEADING**, not an empty one. This is the panel that
earns the asset: a heading above nothing is what a naive filter produces, and it reads as a loading
failure rather than as policy. The surviving group sits directly under the rail head, with no gap and
no placeholder. The rule is already shipped one level down — `groupSettingsNav()` in
`lib/settings/projectSettingsNav.ts` ends `.filter((section) => section.entries.length > 0)` — and is
drawn here so the gating card keeps it rather than rediscovering it.

**WHICH entries survive for which role is deliberately NOT drawn.** The permission key each
destination gates on is **MOTIR-2468**'s to name, against that surface's own server guard. What this
panel fixes is the SHAPE of a partly-filtered rail, which is the same under any key map.

### Panel 3 — the refused destination

Table row **3** (the GUARD limb). `/settings/project/members` reached by direct navigation from an
actor who cannot see its row. Hiding is presentation, so the page stays reachable by URL or by an old
link, and what a person lands on is a real screen.

**The shipped component, unchanged:** `components/projects/NoAccessState.tsx` — the `EmptyState`
family, a `Lock` glyph at 48px, a serif title, a `--el-text-secondary` description and **one**
action rendered as a `primary` Button. Not a new screen: `/settings/project/automation` already
renders exactly this for a non-admin, and this asset extends that precedent to every destination the
story hides.

**The copy is per destination, and the back action resolves to the nearest page the actor can
actually reach** — a back button that lands on another refusal is worse than no back button:

| Destination                     | Title       | Description                                                                                                                                   |
| ------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/settings/project/members`     | Admins only | Who is on this project, and what each of them can do, is managed by project admins. Ask an admin if you need someone added or a role changed. |
| `/settings/project/roles`       | Admins only | What each role in this project can do is managed by project admins. Ask an admin if a role needs changing.                                    |
| `/settings/project/board`       | Admins only | Board configuration is managed by project admins. Ask an admin if a column or a limit needs changing.                                         |
| `/settings/project/workflow`    | Admins only | Statuses and transitions are managed by project admins. Ask an admin if the workflow needs changing.                                          |
| `/settings/project/estimation`  | Admins only | How this project estimates is managed by project admins. Ask an admin if the scale needs changing.                                            |
| `/settings/project/fields`      | Admins only | Custom fields are managed by project admins. Ask an admin if a field needs adding or changing.                                                |
| `/settings/project/components`  | Admins only | Components are managed by project admins. Ask an admin if one needs adding or changing.                                                       |
| `/settings/project/ai-planning` | Admins only | AI planning for this project is configured by project admins. Ask an admin if the cadence or model needs changing.                            |
| `/settings/project/automation`  | Admins only | Project automation is managed by project admins. Ask an admin if you need a rule changed. **(shipped, unchanged)**                            |

**Back label / href, in this order:**

1. The actor can see **any** settings entry → label `Details`, href `/settings/project`. (The shipped
   automation page's choice; keep it.)
2. The whole area filtered away (panel 1's actor) → label `Back to projects`, href `/dashboard` —
   the shipped `projectAccess.backToProjects` string, the same one `NoAccessState` already uses for a
   project a member cannot browse.

The `Admins only` title is deliberately repeated across rows: it is the shipped
`settings.automation.noAccess.title` and it says the one thing every one of these pages has in
common. The DESCRIPTION is what carries which room this is. New keys belong under
`settings.<section>.noAccess.*`, mirroring the shipped `settings.automation.noAccess` shape.

### Panel 4 — the project nav for a viewer

Table row **4** (HIDE, the project-nav entry). Before and after, so the code card can see what moves.

**What this panel decides is SHAPE only:** a removed row leaves no placeholder and no disabled
stand-in, and the rows below move up. **The primary section keeps its single separator from the
footer even when the footer has nothing in it** — the separator belongs to the section boundary, not
to the rows, so a viewer whose settings door is also gone sees the nav simply end rather than a
hairline floating under nothing. And **the primary section can never render empty**: Dashboard, Work
items, Boards, Roadmap, Backlog and Reports are reads that survive for any actor who can browse the
project at all. An actor who cannot browse never reaches this shell — they get panel 3's state on the
project itself.

**WHICH rows leave is NOT decided here.** The three drawn as closing up (`Ready`, `Plans`, `Triage`)
are illustrative. **MOTIR-2471** names the permission each destination needs, read off that
destination's own server guard — an entry stays unless its page refuses the actor outright, and a
page that merely renders fewer actions is a page-level concern, not a nav one.

### Panel 5 — UNCHANGED: the in-place treatments this story must NOT touch

Table rows **6, 7, 8** (DISABLE) and **9** (HIDE), all recorded UNCHANGED by the 2026-08-08
amendment — it widened the hidden set for ENTRY POINTS and did not re-open the disabled set for
IN-PLACE CONTROLS. Drawn verbatim from what ships, so a sibling card can see there is nothing to do:

- **The Create control** — `CreateIssueButton.tsx`: a `Tooltip`-wrapped `aria-disabled` span at
  `--el-text-secondary` with `opacity: 0.6`, carrying the `projectAccess.readOnlyHint` copy. Visible,
  disabled, explained.
- **The board** — `BoardContainer.tsx`: cards do not drag, and a `role="status"` notice
  (`readOnlyBoardBanner`) is what says so.
- **The issue-detail inline pickers** — `CoreFieldsPanel.tsx` sets `readOnly = !canEdit`; the shipped
  comment is the rationale, verbatim: disabling "makes the affordance honest rather than letting a
  viewer edit then bounce off a 403".
- **The Edit link** — absent from the header and from every per-section edit door
  (`editHref={canEdit ? … : undefined}`), and `/items/[key]/edit` redirects back to the read-only
  detail view. HIDE rather than DISABLE because it navigates to an edit SURFACE: an entry point, not
  an in-place control. This one already shipped correctly in 2026-06 and is drawn only so nobody
  "fixes" it.

Treatment-table row **5** (the work-item ⋯ menu) has no panel: `WorkItemActionsMenu` already hides
rows the actor lacks the capability for — its own source calls that "the permission law" — and it is
reached only from a surface the actor is already standing on, so there is no absence to draw.

## The access path

There is none to add, and that is the point: every panel is a state of a surface the shell already
renders. Panels 1 and 4 are the app-shell rail (`SidebarNav.tsx`, its `primary` and `bottom`
sections); panel 2 is the same rail inside the settings area; panel 3 is a settings route reached by
direct navigation, which is precisely the path that survives hiding; panel 5 is the top bar, the
board and the work-item detail page. Nothing here is entered from a new door.

## Composing primitives (no new primitive required)

`Sidebar` / `SidebarSection` / `SidebarNavItem` (`components/ui/Sidebar.tsx`) for both rails and
their group captions · `EmptyState` (`components/ui/EmptyState.tsx`) via `NoAccessState`
(`components/projects/NoAccessState.tsx`) for panel 3 · `Button` (`primary` for the back action,
`ghost` for Watch) · `Tooltip` for the disabled-Create explainer · `Pill` grammar for the role chips
in the state captions and the HIDE / DISABLE / GUARD tags · `Card` for the board columns and the
panel-5 sub-cards.

## Tokens & a11y

Colour is `--el-*` only — there is no hardcoded hue anywhere outside the token block copied from
`app/globals.css`, and both themes render from it. Shape is the element-semantic tokens
(`--radius-card/-input/-badge/-control/-btn/-kbd`, `--spacing-card-padding` / `-control-*` /
`-chip-*` / `-btn-x` / `-kbd-*` / `-tooltip-*`, `--height-control/-btn-sm`, `--shadow-subtle/-card/
-elevated`) so a `data-display-style` swap reshapes it. Role chips put the hue in the tint background
with `--el-text-strong` text (AA-safe, finding #35).

**On ink — the trap this asset was warned off.** `--el-text-faint` measures **2.39:1** on
`--el-surface` and fails AA (MOTIR-2455; the MOTIR-2459 scanner exists because of it), and
`--el-text-muted` is safe only on the white page/card. So **every secondary string inside a stage is
`--el-text-secondary`** (6.80:1, clears AA on every surface in both themes) — including the group
captions, which the 6.5.1 asset drew faint. `--el-text-faint` appears exactly four times: the review (faint is correct here: a historical count of the 6.5.1 asset, kept as the record of what was corrected)
page's own panel labels, which are not product surface, and the three **disabled** controls in panel
5 — disabled text is what WCAG 1.4.3 exempts, and it is the treatment `CreateIssueButton` already
ships.

## Source of truth

When a string or structure here disagrees with shipped MOTIR-2258 code, **the code wins** — file a
fix so the asset stays the reference. Two exceptions, both deliberate:

1. **The treatment RULE is MOTIR-2462's**, in this file's _Amendment 2026-08-08_ section. When this
   asset and that table disagree, the table wins and this asset is wrong.
2. **On chrome, chip grammar and the rail**, `settings-area.mock.html` and the `design/shell` assets
   win — this one composes them.

---

# Status automation — the four-rung ladder and the both-ways rollup promise (Story MOTIR-2888 · Subtask MOTIR-2890 output)

The STATUS AUTOMATION card on the project **Workflow** settings page
(`/settings/project/workflow`). Originally drawn by MOTIR-1617 for Story MOTIR-1615 and shipped by
MOTIR-1622; **re-drawn 2026-08-17** because the behaviour it describes changed under it.

## Files

- `design/projects/status-automation.mock.html` — the source (four panels).
- `design/projects/status-automation.png` — the full-page export. Playwright chromium, full page,
  light theme, `deviceScaleFactor: 2`, viewport width 1200 (the repo convention). Re-render after
  ANY edit to the mock, with the throwaway script reproduced below.
- This section.

The renderer is reproduced INLINE rather than committed, because a design PR ships only `design/**`
and a committed generator would be a path this asset cites that never reaches `main`:

```js
// node this from a worktree that has node_modules; it writes the PNG in place.
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';

const MOCK = 'design/projects/status-automation.mock.html';
const OUT = 'design/projects/status-automation.png';

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--no-sandbox'] });
const page = await browser.newPage({
  viewport: { width: 1200, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
await page.goto(pathToFileURL(MOCK).href, { waitUntil: 'load' });
await page.emulateMedia({ colorScheme: 'light' });

// The guard this pass is about: every ladder read-out has FOUR rungs, and no
// panel still promises the retired forward-only behaviour.
const report = await page.evaluate(() => ({
  ladders: [...document.querySelectorAll('dl.ladder')].map((dl) =>
    [...dl.querySelectorAll('dt')].map((dt) => dt.textContent.trim()),
  ),
  forwardOnly: /only ever moves|never moves a parent back/i.test(document.body.innerText),
}));
if (report.forwardOnly || report.ladders.some((l) => l.length !== 4)) {
  console.log('FAILED the asset guard', JSON.stringify(report));
  process.exitCode = 1;
}

await page.screenshot({ path: OUT, fullPage: true });
await browser.close();
```

Last run: `ladder rungs per read-out: [["In Progress","In Review","Done","To Do"]]` ·
`forward-only wording present: false`.

## Why it was re-drawn — the asset was asserting the opposite of the product

Status derivation became a **RECOMPUTE** (`docs/decisions/status-derivation.md` as amended by
MOTIR-2889, settling MOTIR-2885): a parent's status is a function of its children's CURRENT
statuses, applied whether the result is ahead of or behind where the parent stands. A parent now
comes BACK — when a child reopens, and when a new unstarted child is added to a finished parent.

The shipped asset promised the reverse, in writing, in three separate panels, and drew a
**three**-row ladder that had no way to express _"there is open, unstarted work down here"_. The
retired sentence was:

> "A parent follows its children's progress. It only ever moves a parent forward, along moves your
> workflow already allows — reopening a child never moves a parent back."

It is quoted here, and **only** here, on purpose: `git grep -in "only ever moves a parent forward"
design/` must return nothing, so the wording cannot be picked up again as a copy source from inside
the asset. The card's third clause is the one that had actually become false in the product; the
first was still true and survives, reworded.

**The cascade switch did not change** — not its copy, not its
_"This includes children nobody has started yet"_ warning, not its off-state. Only the upward
direction moved, so only the upward row moved.

## The copy, as it now reads

| Slot                                           | String                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card title                                     | **Status automation**                                                                                                                                                  |
| Card sub                                       | Keep a parent and its children in step. Motir derives status in both directions by default; each switch turns its own direction off.                                   |
| Rollup label                                   | **Roll up parent status from children**                                                                                                                                |
| Rollup hint (panel 1, the full form)           | A parent follows its children's progress, both ways — it moves forward as they progress, and comes back when one reopens or when a new unstarted child is added to it. |
| Rollup hint (panels 0 / 2 / 3, the short form) | A parent follows its children's progress, both ways — forward as they progress, and back when one reopens or a new unstarted child is added.                           |
| Cascade label                                  | **Complete children when a parent is done** _(unchanged)_                                                                                                              |
| Cascade hint                                   | _(unchanged — see the shipped `settings.statusAutomation.cascade.*` keys)_                                                                                             |
| Lock banner                                    | Only a project admin can change status automation. _(unchanged)_                                                                                                       |

**Every panel state carries the corrected hint** — the in-context card in panel 0, the default in
panel 1, the cascade-off in panel 2, and the disabled non-admin in panel 3. A behaviour promise that
is true on one panel and false on three is worse than one that is uniformly wrong, because a reader
takes the first one they see.

## The ladder read-out — FOUR rows

Still a plain `<dl class="ladder">`: a definition list, **not a new component**. The new row is a
row and a sentence.

| `dt`        | `dd`                                                       |
| ----------- | ---------------------------------------------------------- |
| In Progress | as soon as any child starts                                |
| In Review   | when every unfinished child is in review                   |
| Done        | when every child is finished or cancelled                  |
| **To Do**   | **when a child is added or reopened and none has started** |

Two decisions inside that table:

- **To Do is LAST, after Done** — not first, where an ascending ladder would put it. The list is
  read as a sequence of things that happen to a parent, and the To Do rung is the RETURN TRIP; it is
  also the only row that can fire on a parent the admin already considers finished, which is the
  behaviour they will be surprised by. Placing it first would re-order the three existing rows to
  make room for it, i.e. invent a second ordering of the same ladder for no gain.
- **In Review's wording changed** from _"when the last open child reaches review"_ to _"when every
  unfinished child is in review"_. Same rung, same condition — the shipped phrasing implied a single
  final child and the rule is a predicate over the whole set.

## Tokens — the new row adds none

The row inherits the `.ladder` rules exactly; the table below is the whole token surface of the
read-out, unchanged by this pass.

| Element                        | Colour                                                                          | Shape / size                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.ladder` container            | left rule `2px solid var(--el-border)`                                          | `padding: 10px 12px`, `gap: 4px 10px`, `grid-template-columns: auto 1fr` — layout spacing between siblings, not a control's own box, so raw values are correct here |
| `.ladder dt` (the status name) | `--el-text-secondary`                                                           | `12px`, `font-weight: 600`, `white-space: nowrap`                                                                                                                   |
| `.ladder dd` (the when)        | `--el-text-helper`                                                              | `12px`, `line-height: 1.5`                                                                                                                                          |
| the hint paragraph above it    | `--el-text-helper`                                                              | `12px`, `max-width: 54ch`                                                                                                                                           |
| the card it sits in            | `--el-card` on `--el-border`                                                    | `--radius-card`, `--spacing-card-padding`                                                                                                                           |
| the switch                     | `--el-switch-on` / `--el-border-strong` + `--el-muted`; knob `--el-switch-knob` | `h-5 w-9 rounded-full`, knob `size-3.5`, `--shadow-subtle`                                                                                                          |
| an OFF row                     | text drops to `--el-text-faint`                                                 | layout unchanged                                                                                                                                                    |

**No new `--el-*` token, no new shape token, and no invented hue** — the asset's whole Tier-0 →
Tier-3 block is copied from `packages/design-system/theme.css` and this pass added nothing to it.
`--el-text-faint` appears only on **disabled / off** rows, which is what WCAG 1.4.3 exempts and what
the repo's contrast table permits; every live string is `--el-text-secondary` or `--el-text-helper`
on `--el-card` (white), where both clear AA.

## Access path

Unchanged, and still drawn: **panel 0** shows the settings rail with **Work › Workflow** selected and
the card landing on that page above the transition editor — the door, not just the room. No registry
entry, no route, and no rail row was added, for the reason the mock's header records.

## Who builds what

- **MOTIR-2893** implements this: the `settings.statusAutomation.rollup.hint` rewrite and the fourth
  `settings.statusAutomation.rollup.ladder.*` pair, in `en` **and** `zh` (the catalog parity gate).
  It renders the fourth row through the existing `.ladder` markup — the component gains a row, not a
  redesign.
- **MOTIR-2891 / MOTIR-2892** are the behaviour this copy is now telling the truth about. The copy
  card is `blocked_by` both, deliberately: a settings page that promises a recompute the service
  does not yet perform is the same defect as this asset was, pointed the other way.

## Source of truth

`docs/decisions/status-derivation.md` §3 (the four rungs and the direction-decides-the-authority
split) and §3a (the trigger surface) own the BEHAVIOUR. When this asset and the ADR disagree, the ADR
wins and this asset is wrong. On chrome, the settings rail and the card grammar,
`settings-area.mock.html` and `design/shell` win — this asset composes them.

---

# Public page — the room in project settings where the tagline, tags and README are edited (Story MOTIR-3875 · Task MOTIR-4205 output)

`motir.co/p/<key>` renders three things a project admin wrote — a **tagline**, a set of **tags**
and a **README** — and since the public page moved to `motir.co` (MOTIR-3877) there has been no
screen anywhere from which to change a word of them. The only editor ever drawn lived in place on
the app-hosted public page (`design/public-projects/public-projects.mock.html` panels 1b / 1c / 1d,
Story 6.16), and that page was deleted by MOTIR-3951; the settings area's own door to it
(`ProjectMembersSettings.tsx`'s _Edit on the public page →_) points at `/p/<key>?edit=1`, which
returns 404 on `app.motir.co` today. MOTIR-4171 builds the replacement. This asset draws it.

**The placement is decided, not re-opened here.** MOTIR-4171's _✅ DECISION_ (2026-09-02, rungs
1–2) puts the overview where the project is configured: a settings room, **Settings › Project ›
Public page** at `/settings/project/public`, active-project-scoped like every other room, one entry
in `lib/settings/projectSettingsNav.ts`, saving through
`PATCH /api/projects/{key}/public-overview` with the active project's key. A project-keyed route
outside settings was rejected there (no shipped precedent in `app/(authed)/`, a second navigation
model for one screen, and the case the key-routed service was written for no longer arises once
the public page hosts no editor). What this section owes is the drawing that makes that decision
buildable: the doors, the room, and every state a project admin can meet in it.

## Files

| HTML source (truth)     | PNG export        |
| ----------------------- | ----------------- |
| `public-page.mock.html` | `public-page.png` |

A four-panel board (review EACH — mistake #31), 1200 px viewport, 2× export:

- **Panel A — the entrance.** Three doors, each a real affordance inside its shipped parent, haloed
  and numbered: ① the new **Public page** row in the settings rail; ② the Members room's **Hero &
  overview** row, whose link now opens the room; ③ the Members room's **View public page** link,
  retargeted to the public host.
- **Panel B — the room**, inside the settings shell: the rail with the new row active, the page in
  the shell's content column.
- **Panel C — states**: empty · unsaved changes · saving · per-field errors · saved · project not
  yet public. Two arms are stated as ABSENT rather than drawn (below).
- **Panel D — from motir.co**: the three-moment strip MOTIR-4171's criteria ask for — what a manager
  arriving from the public page does.

`settings-area.mock.html` (the area's asset of record) and `public-projects.mock.html` stay frozen
and are cited, never amended — a new surface is a new asset (MOTIR-3233).

## How the render was produced — shipped reality, not the source

The asset is generated, not hand-drawn, so the parents it composes into cannot drift from the app:

1. The real `app/(authed)/_components/SidebarNav.tsx` is rendered in settings mode (pathname
   `/settings/project/members`, the full `PERMISSIONS` set, inside `OnboardingResumeProvider`); the
   real `ProjectMembersSettings.tsx` is rendered with `accessLevel: 'public'`, `canManage` and
   `publicAccessAvailable` true; the real `components/ui/MarkdownEditor.tsx` is rendered at
   `size="full"` with a sample document; and the shipped `Input`, `Button`, `Pill`, `Card` and
   `components/settings/SettingsCard.tsx` are rendered in the variants the room uses — all through
   the repo's own vitest + RTL setup (`tests/helpers/renderWithIntl.tsx`, the real
   `messages/en.json`), `container.innerHTML` dumped per surface.
2. Tailwind compiles `app/globals.css`'s layers over the assembled board (`@import 'tailwindcss'
source(none)` + an `@source` for the board), so the mock's stylesheet is the build's own output
   rather than a retyped token block; `components/ui/markdown-editor.css` is appended for the
   editor's document styles.
3. Only three things are authored: the new rail row (the shipped row markup with `Globe`), the
   three retargets (anchored string replacements on the dumped cards, each asserted to match
   exactly once), and the room's composition from the dumped primitives.

The throwaway harness (`vitest.zz4205.config.ts` — happy-dom, the root config's `@` and
`server-only` aliases, `actEnvironment.ts` as the only setup file; a dump spec under
`tests/components/`; a postcss script importing `@tailwindcss/postcss` by its pnpm path) was deleted
before the commit. Reproduce it with:

```ts
// a throwaway spec beside the component tests  (// @vitest-environment happy-dom)
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/project/members',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
}));
const { container } = renderWithIntl(
  <OnboardingResumeProvider enabled={false} activeProjectId="p1">
    <SidebarNav activeProject={project} settingsPermissions={PERMISSIONS} user={user} />
  </OnboardingResumeProvider>,
);
writeFileSync('dumps/rail-settings.html', container.innerHTML);
// likewise <ToastProvider><ProjectMembersSettings … accessLevel="public" canManage publicAccessAvailable /></ToastProvider>
// and <MarkdownEditor value={md} onChange={set} label="README" size="full" />
```

```js
// build-css.mjs — postcss([tailwind()]).process(`@import 'tailwindcss' source(none);\n@source "<board>";\n` + globals.replace("@import 'tailwindcss';", ''), { from: 'app/globals.css' })
```

Two board-only overrides, both named in the asset so nobody reads them as design: the state frames
(Panel C) shorten the editor's `min-h-[22rem]` to `7rem` and keep the footer's button labels on one
line at the narrower frame width; the shipped room keeps both. Measured at `b2d7798b2`: the shell's
content column is **672 px** (`max-w-[42rem]`, the Members room's width), the settings card in
Panel B is **831 px** tall with the editor at its `22rem` floor, a rail row is **36 px**
(`--height-control`).

## The entrance — three doors, and the registry entry behind the first

**① The rail row** — a registry entry, nothing else (the area's own contract, § _The
settings-nav registry_ above; the route ↔ registry totality test pairs the page with it):

| field        | value                            | why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`         | `public-page`                    | also the palette action id `settings-public-page` and the `guardSettingsPage('public-page', ctx)` key                                                                                                                                                                                                                                                                                                                                                                                                  |
| `group`      | `access`                         | the row sits **directly under Members & access** — the room that owns the public concerns (the make-public control, the share link, the Hero & overview door) and the row a reader arrives from                                                                                                                                                                                                                                                                                                        |
| `href`       | `/settings/project/public`       | the route MOTIR-4171 mounts (`app/(authed)/settings/project/public/page.tsx`)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `icon`       | `Globe` (lucide)                 | the public-web glyph; **not** `Megaphone`, which is the _Building in public_ STATUS badge — a room and a status must not share a mark                                                                                                                                                                                                                                                                                                                                                                  |
| `labelKey`   | `nav.publicPage`                 | en _Public page_ · zh _公开页面_                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `permission` | `project:administer`             | **VERIFIED:** `publicProjectsService.setPublicOverview` refuses through `projectAccessService.assertCanManage`, which asserts `project:administer` (`lib/services/projectAccessService.ts:684`); the route asserts nothing of its own. Read off the destination's gate, per the registry's own rule. No read-only view: the 2026-08-08 amendment (§ _Amendment 2026-08-08_ above) supersedes read-only administrative rooms                                                                            |
| `cloudOnly`  | `true` — **a NEW optional flag** | the row is ABSENT off-cloud (below). The registry is static and `visibleSettingsNav` filters on permission only, so the entry carries the flag and the filter drops it when the layout's already-resolved `publicProjectsAvailable = isCloud()` (`app/(authed)/layout.tsx:282`) is false. The totality test keeps pairing the route with the entry regardless of the flag — the page itself answers `notFound()` off-cloud, the billing page's precedent (`settings/organization/billing/page.tsx:24`) |

**② The Members room's _Hero & overview_ door** (`PublicShareSection`, drawn in Panel A frame ②③):
the heading stays; the sub-heading, the link and the note change (copy below); `editPath` becomes
`/settings/project/public`, an in-app link with the shipped `ArrowRight`. It still renders only
while the project is public, as shipped — the room itself does not depend on that (state C6).

**③ _View public page_** (`BuildInPublicManageRow`): `href` becomes the public host's page,
`https://motir.co/p/<key>`, and the mono path beside the status badge shows `motir.co/p/<key>`
rather than the dead `/p/<key>`. **And a third retarget the two-link count missed:** the _Public
link_ card's share field and its **Copy** button build the value from `window.location.origin` +
`/p/<key>` — on `app.motir.co` that copies a URL that 404s, and MOTIR-4171's own test (_no `href`
under `app/(authed)/` points at `/p/`_) cannot see it because it is a copied string, not an `href`.
The asset draws the field showing `https://motir.co/p/<key>`. **`motir-core` has no public-host
accessor** — `git grep motir.co lib app/\(authed\)` at `b2d7798b2` finds only the API-docs example
origins — so the code card adds one (the `MOTIR_PUBLIC_SITE_URL` variable `lib/baseUrl.ts` already
names, MOTIR-3881) and routes all three through it, rather than spelling the host three times.

## The room (Panel B)

Composition, top to bottom, every element a shipped primitive:

- **Page header** — the settings page grammar kept from every room: `<h1 class="font-serif
text-3xl font-semibold">` _Public page_ + the muted `text-sm` sub (`settings.publicPage.subtitle`).
- **One `SettingsCard`** (`components/settings/SettingsCard.tsx` — icon `Globe` in
  `--el-icon-heading`, title _Hero & README_, subtitle) with a **`View public page`** link in its
  head (`--el-link`, `ExternalLink` glyph, target `_blank`) — present only while the project is
  public; absent in C6. Inside, in the card's `gap-5` body:
  - **Tagline** — the shipped `Input` (label · `data-surface="input"` box · helper). Helper carries
    the cap. Placeholder _One sentence about what this project is_. Empty saves as `null`.
  - **Tags** — a labelled group: each tag a neutral `Pill` (`bg-(--el-chip-bg)` /
    `--el-chip-border` / `--el-text-secondary`) carrying its own remove `<button>` (`X`, `size-4`,
    a button inside a span — never a nested button); a **two-state Add tag control** exactly as
    panel 1c decided — at rest a `secondary` `sm` `Button` with `Plus`, on click a small inline
    input (type, Enter adds, Esc cancels; panel 1d draws that moment and is not redrawn here); a
    running **`n / 8 tags`** count at the row's end; _No tags yet_ when empty; the helper carries
    both caps.
  - **README** — the shipped `MarkdownEditor` at `size="full"` (`min-h-[22rem]`), label _README_.
    The editor is WYSIWYG (tiptap), so **it is the preview**: no write/preview toggle is drawn and
    none should be built — the 6.16 "the page IS the preview" decision survives with the editor
    standing in for the page. The helper carries the cap and says so.
- **The save bar** — the AI-planning page's footer grammar (`AiPlanningSettingsEditor.tsx:449`):
  `bg-(--el-surface-soft)` strip, a hint at the left (`--el-text-secondary` — AA on that surface;
  `--el-text-muted` is not), `Cancel` (`secondary`), `Save changes` (`primary`). One PATCH carries
  all three fields (the partial-author contract: an absent field is untouched — the room sends
  all three every time so a cleared tagline arrives as `null`). The success response **is** the
  confirmation (page-state rule 1: keep the optimistic values, no `router.refresh()` — nothing else
  on the page re-reads these fields). Navigating away with edits pending asks first, the
  unsaved-changes guard panel 1d decided (`Discard unsaved changes?` — _Keep editing_ / _Discard_).

**The field rules, read live** (the caps the fields' helpers quote):

| field   | cap                                   | read from                                                                                                                                                                          |
| ------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README  | 50,000 characters                     | `PUBLIC_OVERVIEW_MAX_LENGTH = 50_000` (`lib/publicProjects/limits.ts:10`), checked at `projectsService.ts:946` → `ProjectOverviewTooLongError`                                     |
| Tagline | 500 characters                        | `PUBLIC_TAGLINE_MAX_LENGTH = 500` (`limits.ts:20`), checked at `projectsService.ts:954` → `ProjectTaglineTooLongError` — **not** the 140 the 6.16 panels drew; MOTIR-982 raised it |
| Tags    | at most 8, each at most 24 characters | `PUBLIC_TAGS_MAX_COUNT = 8` · `PUBLIC_TAG_MAX_LENGTH = 24` (`limits.ts:21–22`), `normalizePublicTags` at `projectsService.ts:105` / `:116` → `ProjectTagsInvalidError`             |

Both authors — `projectsService.setPublicOverview` (`:929`, the active-project author) and
`publicProjectsService.setPublicOverview` (`:493`, the key-routed one the route calls) — import the
same constants, so the helpers are right whichever the code card reaches. **The initial values
are an open seam the design does not decide:** `projectsService.getPublicOverview` returns the body
only, so the page either widens that read to the three hero fields or reads the public DTO
(`lib/dto/publicProjects.ts:400` carries `publicTagline`).

## States (Panel C) — and the two arms that are absent by design

| state                 | what is drawn                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 · empty            | placeholders; _No tags yet_ + the add control + `0 / 8 tags`; an empty document; the README helper says what the public page shows instead (_a short automatic introduction_ — the `null → auto-intro` fallback the public read documents, `publicProjectsService.ts:454`). Both actions disabled                                                                                                                 |
| C2 · unsaved changes  | hint _Unsaved changes_; Cancel reverts to the saved baseline; Save live                                                                                                                                                                                                                                                                                                                                           |
| C3 · saving           | hint _Saving…_ with the spinner; Save in its `loading` state; both actions disabled — one in-flight write, no double submit                                                                                                                                                                                                                                                                                       |
| C4 · per-field errors | `ProjectTaglineTooLongError` → the tagline's `box` error; `ProjectTagsInvalidError` → the tags' error line; `ProjectOverviewTooLongError` → the editor's border in `--el-danger` + an error line. Hint _Fix the highlighted fields to save_ (the AI-planning page's string). A failed save that is none of those (network, 5xx) is a toast — _Couldn't save the public page. Try again._ — and the edits are kept |
| C5 · saved            | `Check` + _Saved_ in `--el-success` (the Details card's `SaveStatus`); fields keep their values; clears after a beat                                                                                                                                                                                                                                                                                              |
| C6 · not yet public   | the room is fully usable; a `--el-tint-sky` band at the top of the card body (the shipped _Public link_ note's grammar: `Info` glyph, `--el-text-strong` ink) says the page is not live and links to Members & access, where that is decided; no _View public page_ link in the head                                                                                                                              |

**Absent, and why:**

- **Non-admin** — no rail row (`visibleSettingsNav` drops the entry: `project:administer` is not
  held), no room (`guardSettingsPage('public-page', ctx)` refuses the typed URL — MOTIR-2469's
  destination guard, same key), and **no read-only view** (the 2026-08-08 amendment). The service is
  the enforcement; the row and the guard are presentation.
- **Self-hosted** — `MOTIR_CLOUD` unset ⇒ `isCloud()` false ⇒ public projects do not exist
  (MOTIR-3908, `docs/decisions/billing-tiering.md` § the `MOTIR_CLOUD` flag): the entry is dropped by
  its `cloudOnly` flag, the page answers `notFound()`, and the route already 404s through
  `publicSurfaceUnavailable()` (`lib/publicProjects/cloudGate.ts:61`). Nothing renders.

## From motir.co (Panel D)

The public page shows **no edit affordance to anyone**, signed in or not
(`docs/decisions/public-surface-hosts.md` AMENDMENT 4 row 7 — a cross-origin page cannot know who
is looking, and a long-form authoring act with a preview and a save belongs where the author already
signs in). A manager who wants to change what they are reading signs in to `app.motir.co`, picks
the project, and opens **Settings › Public page**. Moments 1 and 2 are schematic — the public page
is motir-marketing's (MOTIR-4113) and the sign-in / project tier are `design/auth` and
`design/shell` — moment 3 is the real rail's Access group with the new row active.

## Copy strings catalog (use verbatim in MOTIR-4171; i18n under `settings`, en + zh)

The product's noun is **work item**; nothing here says otherwise.

| key                                    | en                                                                                                                  | zh                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `nav.publicPage`                       | Public page                                                                                                         | 公开页面                                                                              |
| `publicPage.title`                     | Public page                                                                                                         | 公开页面                                                                              |
| `publicPage.subtitle`                  | The tagline, tags and README of **{projectName}** on its public page.                                               | **{projectName}** 公开页面上的标语、标签和 README。                                   |
| `publicPage.card.title`                | Hero & README                                                                                                       | 横幅与 README                                                                         |
| `publicPage.card.subtitle`             | Saved together. Live on the public page the moment you save.                                                        | 一起保存。保存后立即在公开页面生效。                                                  |
| `publicPage.viewPublicPage`            | View public page                                                                                                    | 查看公开页面                                                                          |
| `publicPage.tagline.label`             | Tagline                                                                                                             | 标语                                                                                  |
| `publicPage.tagline.placeholder`       | One sentence about what this project is                                                                             | 用一句话介绍这个项目                                                                  |
| `publicPage.tagline.help`              | Shown under the project’s name. Up to {max} characters.                                                             | 显示在项目名称下方。最多 {max} 个字符。                                               |
| `publicPage.tags.label`                | Tags                                                                                                                | 标签                                                                                  |
| `publicPage.tags.help`                 | Up to {maxCount} tags, {maxLength} characters each.                                                                 | 最多 {maxCount} 个标签，每个最多 {maxLength} 个字符。                                 |
| `publicPage.tags.count`                | {count} / {maxCount} tags                                                                                           | {count} / {maxCount} 个标签                                                           |
| `publicPage.tags.add`                  | Add tag                                                                                                             | 添加标签                                                                              |
| `publicPage.tags.addPlaceholder`       | New tag                                                                                                             | 新标签                                                                                |
| `publicPage.tags.empty`                | No tags yet                                                                                                         | 暂无标签                                                                              |
| `publicPage.tags.remove`               | Remove {tag}                                                                                                        | 移除{tag}                                                                             |
| `publicPage.readme.label`              | README                                                                                                              | README                                                                                |
| `publicPage.readme.help`               | Markdown. Up to {max} characters. What you see here is what visitors see.                                           | Markdown 格式，最多 {max} 个字符。你在这里看到的就是访客看到的。                      |
| `publicPage.readme.emptyHelp`          | Nothing written yet. Until you write a README, the public page shows a short automatic introduction.                | 尚未撰写。在你写 README 之前，公开页面会显示一段简短的自动介绍。                      |
| `publicPage.footer.dirty`              | Unsaved changes                                                                                                     | 有未保存的更改                                                                        |
| `publicPage.footer.saving`             | Saving…                                                                                                             | 正在保存…                                                                             |
| `publicPage.footer.saved`              | Saved                                                                                                               | 已保存                                                                                |
| `publicPage.footer.invalid`            | Fix the highlighted fields to save                                                                                  | 请修正标出的字段后再保存                                                              |
| `publicPage.footer.save`               | Save changes                                                                                                        | 保存更改                                                                              |
| `common.cancel` (existing)             | Cancel                                                                                                              | 取消                                                                                  |
| `publicPage.error.taglineTooLong`      | Too long — {max} characters at most.                                                                                | 太长了——最多 {max} 个字符。                                                           |
| `publicPage.error.tagsInvalid`         | Each tag must be {maxLength} characters or fewer, and there can be at most {maxCount}.                              | 每个标签不能超过 {maxLength} 个字符，且最多 {maxCount} 个。                           |
| `publicPage.error.overviewTooLong`     | Too long — {max} characters at most.                                                                                | 太长了——最多 {max} 个字符。                                                           |
| `publicPage.error.saveFailed`          | Couldn’t save the public page. Try again.                                                                           | 无法保存公开页面，请重试。                                                            |
| `publicPage.notPublic.lead`            | Not building in public yet.                                                                                         | 尚未公开构建。                                                                        |
| `publicPage.notPublic.body`            | What you save here is kept, and goes live the moment you start building in public in <link>Members & access</link>. | 你在这里保存的内容会被保留，并在你于<link>成员与访问</link>中开始公开构建时立即生效。 |
| `publicPage.discard.title` (from 1d)   | Discard unsaved changes?                                                                                            | 放弃未保存的更改？                                                                    |
| `publicPage.discard.keep` (from 1d)    | Keep editing                                                                                                        | 继续编辑                                                                              |
| `publicPage.discard.discard` (from 1d) | Discard                                                                                                             | 放弃                                                                                  |

The Members room's three strings CHANGE (the retargets):

| key                             | en (was → now)                                                                                                                                                                      | zh                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `public.heroOverviewSubheading` | _Edit the tagline, tags, and README right on the public page — what you change is what visitors see._ → **The tagline, tags and README visitors see on your public page.**          | 访客在你的公开页面上看到的标语、标签和 README。 |
| `public.editOnPublicPage`       | _Edit on the public page_ → **Edit the public page**                                                                                                                                | 编辑公开页面                                    |
| `public.heroOverviewNote`       | _Opens the public Overview with the on-page editor. It's hidden while the project isn't public._ → **Opens Settings › Public page. You can write it before the project is public.** | 打开“设置 › 公开页面”。项目公开前也可以先写好。 |

`public.linkNote`'s _To stop sharing, set the access level above…_ and `buildInPublic.*` are
unchanged.

## Tokens & a11y — no new token, no new shape

Every colour is an `--el-*` role the shipped primitives already paint; every shaped surface is the
primitive's own shape token. The room adds nothing to the palette.

| element                    | colour                                                                               | shape                                                     |
| -------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| rail row · active          | `--el-sidebar-item-bg-active` · `--el-text` · glyph `--el-icon-active`               | `--radius-control` · `--height-control`                   |
| rail row · rest            | `--el-text-secondary` · glyph `--el-icon-muted` · hover `--el-sidebar-item-bg-hover` | same                                                      |
| settings card              | `--el-card` on `--el-border` · `--shadow-card` · head glyph `--el-icon-heading`      | `--radius-card` · `--spacing-card-padding`                |
| input box                  | `--el-input-bg` / `--el-input-border` · error `--el-danger` · text `--el-text`       | `--radius-input` · `--height-input` · `--spacing-input-x` |
| helper / hint              | `--el-text-helper` (fields) · `--el-text-secondary` (footer, on `--el-surface-soft`) | —                                                         |
| tag chip                   | `--el-chip-bg` / `--el-chip-border` · `--el-text-secondary`                          | `--radius-badge` · `--spacing-chip-x/y`                   |
| error line / box           | `--el-danger` (line) · `--el-danger-surface` + `--el-danger-surface-text` (box)      | `--radius-control` · `--spacing-tooltip-x/y`              |
| saved status               | `--el-success`                                                                       | —                                                         |
| not-yet-public band        | `--el-tint-sky` · `--el-text-strong`                                                 | `--radius-card` · `--spacing-card-padding`                |
| Save / Cancel              | `--el-accent` + `--el-accent-text` · `--el-button-border`                            | `--radius-btn` · `--height-btn-md` · `--spacing-btn-x`    |
| board chrome (annotations) | `--el-text` / `--el-text-secondary` only                                             | —                                                         |

State is never colour alone: every error has its text, _Saving…_ has its word, the chips' remove
control is a labelled button. The footer hint is `--el-text-secondary` on `--el-surface-soft`
(6.51:1); `--el-text-muted` appears only on the white page/card (the sub-heading, the helpers'
neighbours), where it clears AA.

## GIVES / TAKES — MOTIR-4171, and its size

| `MOTIR-` key                 | GIVES / TAKES | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-4205** (this)        | GIVES         | this section, `public-page.mock.html` / `.png`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **MOTIR-4171** (the builder) | GIVES         | the route `/settings/project/public` + `page.tsx` (guard, cloud `notFound()`, the initial read); the registry entry above **and the new `cloudOnly` flag + its filter**; the room's client island — three fields, the tag-chip control (a small NEW composition: no shipped chip-input primitive exists), the save bar, the unsaved-changes guard, per-field error mapping; the copy above in en **and** zh (~34 new keys, 3 changed); the **three** retargets and a public-host accessor; tests: the href sweep, the seam (`GET /api/public/p/{key}` reflects a save), the partial-author contract, the cloud arm |
| **MOTIR-4171**               | TAKES         | nothing it had — but its criteria say _two_ `/p/<key>` links and its test sweeps `href`s; the share field's copied value is a third that sweep cannot see (amend the criterion; assert the copied value instead of, or as well as, the `href`)                                                                                                                                                                                                                                                                                                                                                                     |
| MOTIR-3877 · 3908 · 3951     | GIVES         | cited as the decisions this room is built inside (the host split, the cloud gate, the deletion) — no card changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Sizing re-check, as the card asked.** MOTIR-4171 stands at **5 SP / 90 min** and already tripped
`likely-over-gate-sizing` on the minutes arm (disposed as ~55 agent + ~35 CI). Counted against the
list above the asset adds work the card did not carry when it was sized: the `cloudOnly` registry
flag and its filter, the initial read of the three hero fields (no shipped read returns all three),
the tag-chip control, the third retarget plus a host accessor, and the second locale for ~34 keys.
That does not fit 90 minutes; **8 SP / ~130 min** is the honest figure, and the agent half is over
the 60-minute ceiling — so the remedy is a SPLIT rather than a larger number: the Members-room
retargets + the host accessor + the href/copied-value sweep are a clean separate PR with no
dependency on the room. Recorded on MOTIR-4171 and submitted as a proposal from this run; the
approver decides.

## Source of truth

MOTIR-4171's _✅ DECISION_ owns the PLACEMENT; `docs/decisions/public-surface-hosts.md` AMENDMENT 4
row 7 owns the absence of an editor on the public host; `lib/publicProjects/limits.ts` owns the caps.
On chrome — the settings rail and the room grammar — `settings-area.mock.html` and `design/shell`
win; on the editor elements, `design/public-projects/public-projects.mock.html` panels 1c / 1d
decided them and this asset reuses them by citation. Where this asset and any of those disagree,
they win and this asset is wrong.

---

# Public address — the room where a workspace claims a subdomain and a customer connects their own domain (Story MOTIR-3878 · Subtask MOTIR-4211 output)

`motir.co/p/<key>` is the only address a public project has ever had. Story MOTIR-3878 gives the
customer one of their own — first a subdomain of Motir's public namespace, then a domain they own —
and **no asset drew the room it is configured from.** `access-members.mock.html` draws the access
level and the share link; `design/public-projects/` Panel 6 draws the share row. Neither depicts a
subdomain, a domain, a DNS instruction or a certificate state. This section is that room, and it
gates MOTIR-4221 (pane part 1) and MOTIR-4229 (pane part 2).

## Files

| HTML source (truth)        | PNG export           |
| -------------------------- | -------------------- |
| `public-address.mock.html` | `public-address.png` |

A **fourteen**-panel board (review EACH — mistake #31), 1200 px viewport, 2× export, 2400 × 19574.
Panels 0–9 are MOTIR-4211's; panels 10–13 are MOTIR-4453's RELEASE revision, appended rather than
interleaved (see § _REVISION 2_ at the end of this section for why).

## The surface table

| element                 | primitive                   | colour role                                                      | shape role                                |
| ----------------------- | --------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| settings card           | `Card`                      | `--el-page-bg` on `--el-border`                                  | `--radius-card`, `--spacing-card-padding` |
| card heading / sub      | `CardHeader`                | `--el-text` / `--el-text-secondary`                              | —                                         |
| subdomain field         | `Input` + suffix            | `--el-page-bg`, suffix `--el-surface` + `--el-text-secondary`    | `--radius-input`, `--height-input`        |
| live preview            | `Input` `helperText`        | `--el-text-secondary`, the address itself `--el-text`            | —                                         |
| inline refusal          | `Input` `helperText`, error | `--el-danger-on-surface`, border `--el-danger`                   | `--radius-input`                          |
| address row             | list row                    | `--el-surface-soft` on `--el-border`                             | `--radius-control`, `--height-control`    |
| state chip              | `Pill`                      | tint bg + `--el-text-strong` (finding #35)                       | `--radius-badge`, `--spacing-chip-*`      |
| DNS record table        | table                       | `--el-text`, headers `--el-text-secondary`, values `--font-mono` | —                                         |
| primary picker          | radio card                  | selected `--el-tint-lavender` + `--el-accent` ring               | `--radius-control`                        |
| consequence / warning   | callout                     | `--el-tint-lavender` / `--el-tint-yellow` + `--el-text-strong`   | `--radius-control`                        |
| remove confirm          | `Modal` + `Button` danger   | `bg-(--el-danger)` + `--el-danger-text`                          | `--radius-modal`, `--radius-btn`          |
| disabled-control reason | `Tooltip`                   | `--el-text` fill + `--el-text-inverted`                          | `--radius-control`                        |
| rail row (composed)     | `SidebarNav` row            | active `--el-tint-lavender` + `--el-text-strong`                 | `--radius-control`, `--height-control`    |

**Chip tones, and why the hue is never the meaning.** `active` / `issued` take mint, `verifying` /
`pending_certificate` take sky, `unverified` takes yellow, `alias` takes lavender, and **`failed`,
`expired` and `revoked` all take rose**. Three states sharing one tint is deliberate: they are told
apart by their words and by the action beside them, the same rule the custom-role chip follows in
`access-members.mock.html` (§ _Roles & permissions_). A reader who can only see the hue learns
"something is wrong", which is true of all three.

## The panels

| panel | what it draws                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------- |
| **0** | The access path — ① the rail row, ② the make-public flow's share row gaining _Set up your own address →_ |
| **1** | No subdomain claimed: the claim field, its live preview, and its two refusals (reserved, taken)          |
| **2** | Claimed: the address row, the retained alias, the renames-left counter, the rename confirm               |
| **3** | Custom domains empty · **3b** the same panel on a `free` org — the tier gate                             |
| **4** | Add a domain: the DNS instruction block in both record shapes (CNAME · A+AAAA), both with the TXT        |
| **5** | The state set — all nine `PublicAddressStatus` values, one row each, with meaning and action             |
| **6** | Primary: the radio, the disabled non-issued row with its reason, the consequence line                    |
| **7** | Remove a domain: the confirm                                                                             |
| **8** | Non-admin: read-only                                                                                     |
| **9** | Narrow (390 × 844) · **9b** dark                                                                         |

## The access path — both entrances, and the row that is NOT this asset's to place

**① The rail row.** A registry entry in `lib/settings/projectSettingsNav.ts` and nothing else.

| field        | value                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `id`         | `public-address`                                                                                                 |
| `group`      | `access`                                                                                                         |
| `href`       | `/settings/project/public-address`                                                                               |
| `labelKey`   | `nav.publicAddress` — en _Public address_ · zh _公开地址_                                                        |
| `cloudOnly`  | `true` — the capability is cloud-only (ADR §11), so the row is ABSENT off-cloud, not disabled                    |
| `permission` | **MOTIR-4221's to READ OFF its own service gate** — see the planning flags below. This asset does not decide it. |

**⚠️ The ORDER differs from what MOTIR-4211's card asked for, and the reason is a card that landed in
between.** The card says the row goes _"between Members & access and Roles"_. That slot is taken:
MOTIR-4205 (drawn while it was `in_review`; PR motir-core#2533 has since MERGED to `main`) puts a
**Public page** room there, `id: 'public-page'`, group `access`, _"directly under Members & access"_. Two public rooms
either side of the same door is the coherent shape, so this asset draws:

> Members & access → **Public page** → **Public address** → Roles → Code access

The card's intent — _in the `access` group, adjacent to Members & access_ — is honoured; only the
neighbour changed. **This is a rung-2 reading beating a rung-3 card, not a preference.**

**⚠️ AND `cloudOnly` IS NOT THIS STORY'S TO INVENT — it is MOTIR-4205's, and it does not exist in
the code yet.** That flag is a new optional field on `SettingsNavEntry`: MOTIR-4205 (merged, design
only) SPECIFIES it, MOTIR-4171 BUILDS it, and `lib/settings/projectSettingsNav.ts` on `main` still
carries no such field. This room needs it for exactly the same reason. **MOTIR-4221 must not add it a second time**: two
cards introducing one registry field is a merge conflict at best and two divergent filters at worst.
Recorded as a build dependency on MOTIR-4221 rather than drawn.

**② The make-public flow's share row.** `design/public-projects/` Panel 6 gains one line —
_Set up your own address →_ — under the existing share-link row. This is the door for the person who
has just made a project public and is looking at its address, which is the moment the question
occurs to them. Both parent assets are **cited, never amended**: a new surface is a new asset
(MOTIR-3233).

## What each control is, and which card specifies it

Every row is attributed. A control with no specifying card would be a planning flag, not an
invention — and there are two, listed after.

| control                            | specified by                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| claim field, grammar, live preview | MOTIR-4215 · ADR §8 (the label grammar, the reserved set)                                    |
| _reserved_ refusal                 | MOTIR-4215 (`isReservedLabel`) · ADR §8's enumerated set                                     |
| _taken_ refusal                    | MOTIR-4209 (`hostname` globally unique → `HostnameTakenError`)                               |
| rename + its warning copy          | MOTIR-4215 · ADR §8 (never released) — the wording is the decision in the customer's words   |
| renames-left counter               | MOTIR-4215 (`renamesLeft` on `PublicSubdomainDto`) · ADR §8's cap of 5                       |
| retained alias row                 | MOTIR-4209 (the `alias` kind) · ADR §8                                                       |
| _Add a domain_ + the tier gate     | MOTIR-4228 (`custom_domains`, `maxCustomDomains`) · ADR §9                                   |
| the upgrade prompt                 | `design/billing/` (8.1.7 / 8.1.8 `EntitlementExceededError` grammar) — composed              |
| the DNS instruction block          | ADR §5 (CNAME for a subdomain, A/AAAA for an apex, the `_motir-verify` TXT)                  |
| _Verify_                           | MOTIR-4216 (step 3 of the add → verify → issue order)                                        |
| every certificate state            | MOTIR-4209 (`PublicAddressStatus`) · MOTIR-4216 (the transitions) · MOTIR-4219 (the refresh) |
| `failureReason` on a failed row    | MOTIR-4209 (the column) · MOTIR-4219 (what writes it)                                        |
| _Make primary_ + the consequence   | MOTIR-4216 · ADR §7 (exactly one primary; every other address 301s)                          |
| _Remove_                           | MOTIR-4216 (removal + certificate teardown)                                                  |
| read-only (non-admin)              | the `canManage` shape in `ProjectMembersSettings.tsx`                                        |

### Planning flags — drawn as questions, not answered

1. **The permission key this room asserts is not decided by this asset.** The registry's own rule is
   that an entry's `permission` is READ OFF its destination's server gate, never inferred from the
   entry's name. MOTIR-4215 / MOTIR-4216 will assert something (a subdomain is a WORKSPACE-level
   resource per ADR §3, which is not obviously the same key a project-settings room usually carries)
   and MOTIR-4221 reads it off them. The neighbouring Public page room resolves
   `project:administer`. **Flagged rather than drawn.**
2. **Nothing specifies how a customer learns that a LIVE domain broke.** MOTIR-4219 refreshes
   `expired` / `revoked` / `failed` from the platform and records `lastCheckedAt`, and this asset
   draws each of those states in the pane. But a customer whose roadmap stops answering is not
   sitting in project settings — and no card in the story owns a notification, an email, or a
   frequency for the job. **Flagged. It is a real gap, not a drawing decision**, and it is named in
   the sweep below.

## The allocation sweep — GIVES / TAKES per card named

Per gate 8's design-allocation limb: for every card this asset names, what it GIVES that card, and
what it TAKES from it.

| card                               | GIVES                                                                                                                   | TAKES                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4221** (pane part 1)       | The rail row's field table, the pane shell, panels 1 / 2 / 8 / 9 in full, and the composition rules for both parents    | **The `cloudOnly` flag is NOT its to add** — MOTIR-4205 introduces it. **And the permission key is its to read off the service, not to copy from here.** |
| **MOTIR-4229** (pane part 2)       | Panels 3 / 3b / 4 / 5 / 6 / 7 — the domain list, the DNS block in both shapes, all seven domain states, primary, remove | The narrow-frame reshape of the DNS table (panel 9) is part of its scope, not a later polish card                                                        |
| **MOTIR-4215** (subdomain service) | The two refusals' copy and the renames-left surface, which tell it what its DTO must expose                             | Nothing structural                                                                                                                                       |
| **MOTIR-4216** (lifecycle)         | The add → verify → issue order drawn as three visible states; the remove confirm's promises                             | Nothing structural                                                                                                                                       |
| **MOTIR-4219** (status job)        | Every state it must be able to produce, each with the action the pane offers                                            | **A question it does not currently own** — see planning flag 2                                                                                           |
| **MOTIR-4228** (entitlement)       | Panel 3b: `free: 0` must refuse the FIRST domain, and the refusal must carry the upgrade prompt                         | Nothing structural                                                                                                                                       |
| **MOTIR-4211** (this card)         | —                                                                                                                       | —                                                                                                                                                        |

### The re-estimate this sweep implies — MOTIR-4221

**MOTIR-4221 is sized 5 points / 70 minutes and this asset does not grow it.** Counted against what
is drawn: the rail row (one registry entry), the pane shell, the subdomain card in its two states,
the rename modal, the read-only arm and the narrow frame — plus `en` + `zh`. That is what the card
already says it builds. **The two TAKES above REDUCE rather than add**: not inventing `cloudOnly`
and not choosing the permission key are both work removed from it. No re-estimate is recorded,
and that is a measurement rather than an omission — it was run because the sweep asks for it,
and it came back negative.

**MOTIR-4229 is sized 5 points / 70 minutes and this asset is a size question worth flagging.**
Panels 3, 3b, 4, 5, 6 and 7 are six distinct surfaces, one of which (panel 5) is a nine-row state
machine each row of which carries an action, and panel 4 has two record shapes. It is drawn as one
card's worth and it may not be. **Not re-estimated here — the sizing gate belongs to whoever runs
it, and this note is the input.**

## Composition — what is cited and never redrawn

- `settings-area.mock.html` — the settings shell and its rail. Panel 0 renders the rail rows in
  their shipped grammar to show WHERE the new row lands; it is not a new rail.
- `access-members.mock.html` — the settings-card grammar, the confirm-modal grammar, the chip rule.
- `design/public-projects/` Panel 6 — the share-link row that gains door ②.
- `design/billing/` — the upgrade prompt (8.1.7 / 8.1.8).
- `archive-confirm.png` — the destructive-confirm grammar panel 7 follows.

## The base domain is not in this asset

Every address renders `motir.site`. The ADR fixes the SHAPE of the base domain and leaves the string
to MOTIR-4208 (which buys it) and MOTIR-4214 (which sets `MOTIR_PUBLIC_TENANT_DOMAIN`). The room
reads that value. **No literal base domain reaches the code**, so read every `motir.site` on the
board as `<base>`. The Fly IP values in panel 4 are illustrative for the same reason — the real ones
come from `fly ips list` at provisioning.

## Ink

Secondary copy is `--el-text-secondary` throughout (6.18–6.80:1 on every surface in both themes).
`--el-text-muted` and `--el-text-faint` are declared in the token block, to mirror `theme.css`, and
used for **nothing** — muted clears AA only on the white page, and faint clears it nowhere. Danger
text is `--el-danger-on-surface`; `--el-danger-text` appears once, on the remove button, which is
the one element that also carries `bg-(--el-danger)`.

**The nested dark scope re-emits the Tier-3 block.** Panel 9b puts `data-theme="dark"` on a `div`,
so Tier-0 `--color-*` flips but the `:root`-declared `--el-*` would keep resolving against the outer
palette — the panel would paint the light page background under dark hues.
`tests/design-dark-parity.test.ts` measured exactly that on the first draft of this asset; the fix
is a `[data-theme]` block re-declaring the Tier-3 tokens, placed BEFORE the `[data-theme='dark']`
block (equal specificity, later wins — MOTIR-3712).

`vitest --config vitest.design.config.ts`: **7 files, 90 tests, green.**

## ⚠️ REVISION 2 (2026-09-04, Story MOTIR-4451 · Subtask MOTIR-4453) — RELEASE: the Remove control, its confirm, and the state it returns to

The room above was drawn for a workspace that CLAIMS and RENAMES. ADR §8
**Amendment 2** (MOTIR-4452) adds the third act: a workspace may **release** its
own subdomain. Never-released is a rule about who may take a name NEXT, not about
who must keep serving it, so the addresses go and the NAMES stay held for ever.
Panels **10–13** are that act; nothing above is redrawn.

**Panels 10–13 are APPENDED, not inserted.** They belong beside panel 2 by
subject and sit at the end by NUMBER, because the numbers are cited from outside
this file — `PublicSubdomainCard`'s own header names _"design panels 1, 2 and
8"_ — so renumbering to group them would silently re-point every one of those
citations at a different picture.

| panel  | what it draws                                                                                |
| ------ | -------------------------------------------------------------------------------------------- |
| **10** | The Remove control in the claimed state, and the confirm with THREE hostnames                |
| **11** | The singular case (one hostname), and the unclaimed state it returns to                      |
| **12** | The confirm in `zh`, and the claimed card's footer row in `zh`                               |
| **13** | Narrow (390 × 844) with three hostnames, one of them a 56-character label carrying no hyphen |

### Drawn against a RENDER of the shipped card, not against panel 2

`PublicSubdomainCard` has been live since MOTIR-4221, so the control was placed
against a **headless render of the real component at `origin/main`** (its own
source + the real `theme.css` + `messages/en.json`), not against this board's
picture of it. Two things the render settled that reading panel 2 would not have:

- **The footer is ONE `justify-between` row** — `renamesLeft` on the left, a
  `secondary` / `sm` Rename on the right. Panel 2 draws it the same way, and the
  render is what makes that a fact rather than an assumption.
- **The shipped card renders EVERY alias as its own row**, so a workspace that
  renamed twice already shows three rows before the confirm opens. Panel 2 drew
  one alias; panel 10 draws two, because the confirm's whole argument is about a
  set and the card behind it has to show the same set.

### The Remove control

| element                        | primitive                                  | why this weight                                                                                                                                                               |
| ------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remove** (card)              | `Button` `variant="ghost"` `size="sm"`     | Exactly what the shipped custom-domain row gives its own Remove (`CustomDomainsSection`: `action === 'remove' ? 'ghost' : 'secondary'`). One product, one weight for one act. |
| **Rename** (card)              | `Button` `variant="secondary"` `size="sm"` | Unchanged.                                                                                                                                                                    |
| **Remove subdomain** (confirm) | `Button` `variant="danger"` `size="md"`    | The ONE element on this board that may carry `--el-danger-text`, because it also carries `bg-(--el-danger)`.                                                                  |

**Placement: inside the footer row's RIGHT-hand group, to Rename's left.** Not a
third `space-between` column — that pushes the count, the quiet action and the
ordinary action to three edges and makes them read as three peers. Remove sits
LEFT of Rename so the pointer travelling to the ordinary action never passes over
the destructive one.

**No danger ink on the trigger.** `Button` ships four variants and none is a
danger ghost; the confirm is where the colour belongs. A danger-tinted trigger
would also be the loudest thing on a pane whose other controls are all neutral,
which inverts the emphasis the card asks for.

### The confirm — panel 7's grammar, three additions

It is a **sibling of the shipped remove-domain confirm**, not a new dialect:
`Modal` → a plain first line → the consequence in a `callout danger` on
`--el-tint-rose` with `--el-danger-on-surface` ink → the reversibility last →
`[ghost Cancel] [danger Confirm]`. That is `archive-confirm.png`'s grammar, which
panel 7 already follows. Three things are added, and each is required:

1. **THE HOSTNAMES ARE LISTED, NEVER SUMMARISED.** A workspace that renamed twice
   gives up three names in one click, and somebody who forgot a rename from months
   ago will not think of the old name as theirs to lose until it is gone. The rows
   are the card's own address rows, with the same pills — never the words _"and
   any previous addresses"_. The lead line is an ICU plural over the count.
2. **THE PERMANENCE SENTENCE IS NOT BOILERPLATE AND IS NOT DRAWN AS ONE.** _"This
   cannot be undone"_ would be true and would say nothing. What is unusual here is
   that the name stays held **against everyone, for ever, by design** — including
   the workspace releasing it. That is the sentence, and it is the callout's title.
3. **THE UPSIDE IS STATED, LAST.** Release is almost always performed BY somebody
   who wants their projects back on `motir.co`, and a confirm describing only
   destruction makes the correct action feel like a mistake. The last line names
   `motir.co/p/<identifier>` and says the projects appear on `motir.co` again.

**And the renames sentence, which is Amendment 2 in the customer's words.**
Releasing does **not** reset the rename cap — the cap counts names BURNT out of a
shared namespace, so releasing three spends three. Without that sentence the
confirm promises permanence and quietly omits the half a customer meets later as
a refusal. It rides in the callout body rather than as a fourth block, because it
is part of the permanence consequence rather than a separate one.

### The unclaimed state it returns to — DECIDED: identical, with no trace

**Byte-for-byte panel 1. There is no "you released `acme`" line, and that is a
decision rather than a rendering accident** (panel 11's right stage).

The reason is the reservation's own shape. `PublicHostnameReservation` stores a
one-way **digest** and deliberately does not retain the hostname — ADR §8
Amendment 1 reconciles _"held for ever"_ with Article 17 precisely by never
keeping the string. A trace would mean keeping the very value that table was
designed to discard, on the surface where a person can read it.

And the consequence a person actually needs is delivered where it is
**actionable**: at the moment they re-type the label, by panel 1's _already taken_
refusal. **CHECKED, and nothing is owed to that copy** — the shipped string
already reads _"A subdomain that has been renamed away from also keeps its name,
so this one may belong to a workspace that no longer answers on it"_, which
covers a released name unchanged.

### The confirm's rows WRAP where the card's rows TRUNCATE — a decision

The shipped `AddressRow` truncates (`min-w-0 flex-1 truncate`) and is right to: on
the card the hostname is a LABEL for a row a reader can copy, open or scroll to.
**In the confirm the hostname IS the message** — it is the thing being given up
for ever, and a name a person cannot finish reading is a name they cannot decide
about. So the modal's rows carry `overflow-wrap: anywhere` instead. This board's
own `.addr .host` has carried that rule since MOTIR-4211, so the departure is
consistent with every confirm already on it.

**Measured at 390 px** (panel 13) with a 56-character label carrying **no hyphen
to break at** — the case a hyphenated example silently passes. The label runs onto
three lines inside its own row, its pill stays on the first, and the page does not
scroll sideways. Two other things change at that width and are drawn rather than
described: the alias pill drops its verb (_Redirects here_ → _Redirects_), and the
renames sentence drops its second clause.

### The ACCESS PATH is UNCHANGED — confirmed, not redrawn

Panel 0 draws both entrances (① the rail row `/settings/project/public-address`,
② the make-public flow's _Set up your own address →_). **Release adds no third
door.** It is a control INSIDE the subdomain card on a pane a person is already
standing in — there is no route, no menu item and no notification that reaches it,
so there is nothing new to draw. Confirmed here rather than re-drawn, per the
never-redraw rule this section's _Composition_ list applies to the rail.

### Copy — `en` + `zh`, drawn on the board (panels 10–13)

New keys under `settings.publicAddress.release`, beside the existing `rename` and
`domains.removeModal` blocks:

| key            | `en`                                                                                                                                                                                | `zh`                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `remove`       | `Remove`                                                                                                                                                                            | `移除`                                                                                   |
| `title`        | `Remove {hostname}?`                                                                                                                                                                | `要移除 {hostname} 吗？`                                                                 |
| `lead`         | `{count, plural, one {This address will stop answering:} other {These # addresses will stop answering:}}`                                                                           | `{count, plural, other {以下 # 个地址将停止提供访问：}}`                                 |
| `warningTitle` | `{count, plural, one {This name is held for ever. Nobody can claim it again — including you.} other {These names are held for ever. Nobody can claim them again — including you.}}` | `{count, plural, other {这些名称将被永久保留，任何人都无法再认领它们——包括你自己。}}`    |
| `warningBody`  | `Motir keeps every released name out of its namespace permanently, so no other workspace can inherit links that pointed at yours.`                                                  | `Motir 会把每个已释放的名称永久排除在命名空间之外，因此其他工作区无法继承指向你的链接。` |
| `renamesAfter` | `You will have {count, plural, =0 {no renames} one {# rename} other {# renames}} left if you claim a subdomain again — releasing does not give them back.`                          | `若你再次认领子域名，将只剩 {count} 次重命名机会——释放不会把它们还给你。`                |
| `fallback`     | `Your public projects go back to {url}, and appear on {site} again.`                                                                                                                | `你的公开项目将回到 {url}，并重新出现在 {site} 上。`                                     |
| `cancel`       | `Cancel`                                                                                                                                                                            | `取消`                                                                                   |
| `confirm`      | `Remove subdomain`                                                                                                                                                                  | `移除子域名`                                                                             |

**Three things about the `zh`, each a decision:**

- **`永不释放` / `永久保留` is inherited, not invented.** `rename.warningTitle`
  already ships `旧地址将继续有效，并且永不释放。` for the same promise one control
  over, so the release confirm reuses that register rather than adding a second way
  to say _held for ever_.
- **`移除` / `移除子域名` reuse the verb the pane already has** —
  `domains.action.remove` ships `移除` and `domains.removeModal.confirm` ships
  `移除域名`. One word for one act, across both address kinds.
- **`zh` has one plural arm.** Every plural above renders the COUNT (`以下 3 个地址`),
  never a bare _"these addresses"_, because zh carries no plural morphology and the
  number is the message.

### The allocation sweep — GIVES / TAKES, revision 2

| card                                | GIVES                                                                                                                                                                                        | TAKES                                                                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4455** (the Remove control) | Panels 10–13 in full: the control's variant, size and PLACEMENT; the confirm's four blocks and their order; every `en` + `zh` string above; the unclaimed-state decision; the 390 px reshape | **The wrapping row is NOT `AddressRow` unchanged** — reuse it with `truncate` replaced by `break-words`, per the decision above. And the renames sentence's number comes off the DTO's `renamesLeft`, which MOTIR-4454 has already redefined; do not re-derive it in the browser. |
| **MOTIR-4454** (the release path)   | Nothing structural — the service was specified by the ADR, not by this asset                                                                                                                 | Nothing                                                                                                                                                                                                                                                                           |
| **MOTIR-4452** (the ADR amendment)  | Nothing — it is this asset's INPUT                                                                                                                                                           | Nothing                                                                                                                                                                                                                                                                           |

**The re-estimate this sweep implies — MOTIR-4455 is sized 3 points / 50 minutes,
and this asset does not grow it.** Counted against what is drawn: one ghost button
in an existing row, one `Modal` composed from primitives the file already imports,
nine string pairs, one `fetch` + `router.refresh()`, three error branches, and the
component tests the card already names. There is no new route, no background job,
no migration and no new i18n SURFACE — the catalogue block is a sibling of two that
already exist. **Run because the sweep asks for it, and it came back negative.**

**One thing it TAKES that is worth its own line, because it looks like polish and
is not:** the wrapping row. Reusing `AddressRow` verbatim inside the modal is the
path of least resistance, it compiles, it renders, and it silently truncates the
one string the confirm exists to show. That is why it is a TAKES rather than a
note.

### The guard lane, on this revision

`vitest --config vitest.design.config.ts`: **9 files, 141 tests, green** — run in
the design worktree before the pull request, which is the only lane whose specs
read `design/**` and therefore the one an asset-only diff would otherwise never
trigger. The temp render harness used for the shipped-card screenshot was deleted
before it ran: an asset citing its own generator fails the address guard.

---

## ⭐ Approvals — the gate switches (MOTIR-4942 — `approvals.mock.html`)

**A new project-settings ROOM: `Project settings → Approvals`, at
`/settings/project/approvals`, holding the switches that decide which approval
gates this project raises.** Its first and only inhabitant is the
**acceptance-video gate**; the asset is `approvals.mock.html` + `approvals.png`.

Card: **MOTIR-4942**, a design task under epic **MOTIR-4878** (_Approval gates_).
It gates **MOTIR-4925** (the switch's code) and informs **MOTIR-4949** /
**MOTIR-4950**.

> **⚠️ This card's FIRST pass is not in the tree.** It placed the same control in
> `automation ▸ AI planning` and drew it as panel 8 of
> `design/ai-settings/ai-planning-settings.mock.html`, with an A1–A11 amendment to
> that area's notes. The room decision was withdrawn on 2026-09-09 and pull
> request #2730 was closed **unmerged**, so neither file ever reached `origin/main`
> — verified by grep on 2026-09-11. **Nothing is superseded, and no superseded-by
> line is owed**; `design/ai-settings/` is untouched by this card. The withdrawn
> argument is recorded below under _Rejected candidates_ because the reasoning is
> the useful part, not the drawing.

### 1. WHERE it lives, and how that was decided

**The room was decided from the switch's READERS and WRITERS, never from what it
resembles.** Grepped on `origin/main`, 2026-09-11:

|             |                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Readers** | `lib/services/acceptanceVideoEligibilityService.ts` — the ONE computation of `hasPaidAiPlan AND the toggle`, and the only direct reader. Its consumers: `AcceptancePanel` (the item page), `lib/acceptanceEvidence/publishAuth.ts` (the CI publish gate), `lib/mcp/tools/publishAcceptanceResult.ts` (the MCP publish gate). Once MOTIR-4950 registers the kind, the `acceptance_result` gate's own creation path joins them. |
| **Writers** | this control, and the acceptance panel's own **Turn on** action — whose `settingsHref` + `#acceptance-video` anchor follow the switch to the project (MOTIR-4949 criterion 5).                                                                                                                                                                                                                                                |

Nothing in planning, board, estimation, fields or components touches it, in
either direction. **What those consumers add up to is an approval gate** — the
concept MOTIR-4878 exists for — so the switch belongs with the gates.

**And it is a ROOM rather than one card bolted onto an existing page**, because a
SECOND project-tier gate switch is already decided:
`docs/decisions/approval-gates.md` §7 moves `Workspace.subtaskPrMergeMode` to
`Project.prMergeMode`, where `manual` **raises** a `pull_request_merge` gate and
`auto` raises none — the same sentence this switch says, about a different kind.
§7 also asks for _"a deep link from the approval surface… to the switch that
stops asking them"_, and that link needs somewhere to land.

**Registry entry** (`lib/settings/projectSettingsNav.ts`), which is the whole of
the wiring — the rail, the ⌘K deep link and the route↔registry totality test all
follow from it, with no layout change:

```ts
{
  id: 'approvals',
  group: 'work',                       // directly after `workflow`
  href: '/settings/project/approvals',
  icon: ShieldCheck,
  labelKey: 'nav.approvals',
  permission: 'workflow:manage',       // SEE it, OPEN it, CHANGE it — §6, MANAGE-ONLY
}
```

**AMENDED 2026-09-13 (MOTIR-5393):** the snippet carried a second line,
`viewPermission: 'project:browse'` (_SEE the room — §6, MOTIR-5190_). It is removed,
not struck, because code cannot carry a strike: the room is MANAGE-ONLY and
`approvals` declares one key, as every other room does. See §6.

**Why `group: 'work'`, after Workflow.** A status graph and an approval gate are
the two things in Motir that decide when work may move; they are neighbours.
**Why `workflow:manage` is the WRITE key, and not a new one.** It is the shipped
key for _may you configure how work moves through this project_, and this card
has no warrant to add a permission to the catalog. A dedicated `gate:manage` is a
reasonable later split — the same shape as `ai:configure` / `lesson:view` — and
is explicitly NOT decided here.

> ~~**⚠️ `viewPermission` DOES NOT EXIST ON `SettingsNavEntry` YET — it is
> [MOTIR-5193](motir:cmtx9wctp013uhvoil4s80ykf)'s deliverable, and this snippet is
> the TARGET rather than a description.** The entry as
> [MOTIR-5170](motir:cmtx6c1m800awhvoidw3die74) shipped it carries
> `permission: 'workflow:manage'` alone, which is correct for a one-key registry
> and is what makes panel 4 unreachable today. **§6 below is the decision that
> second line records**, and it is the whole of what this asset owes that card.~~
>
> **SUPERSEDED 2026-09-13 (MOTIR-5393):** there is no second line to record. The room is
> MANAGE-ONLY (§6), and MOTIR-5193 is owed nothing by this asset.

### 2. Rejected candidates, and why each fails

- **`automation ▸ AI planning`** — the first pass's answer, withdrawn. Nothing in
  the planning path reads the flag; the room configures the PLANNER; and its
  `ai:configure` gate would make _"may this project ask for acceptance
  approval"_ depend on _"may this person configure the planner"_.
- **`work ▸ Estimation`** — chosen by resemblance to a small project-scoped
  toggle. Estimation reads nothing here.
- **A row inside `work ▸ Workflow`** — the closest call. The workflow room is
  about the status GRAPH; a gate is a decision a PERSON makes that the graph then
  obeys. Folding one into the other loses the distinction the epic exists to
  draw, so the two stay neighbours instead.

**The general lesson, and it is the one this card was re-subjected for:** decide
where a setting lives by tracing its readers and writers in code, never by which
surface it resembles. A survey of existing rooms can only return a room, so it
returns the best-fitting one and never the finding that the value is an instance
of a concept the plan already has a container for.

### 3. The surface — panels and states

| panel | what it draws                                                                                                                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | **the DOOR** — the project-settings rail with `Work ▸ Approvals` ACTIVE. The access path is drawn, not named.                                                                                 |
| **1** | the acceptance-video gate switch, **ON**                                                                                                                                                      |
| **2** | **OFF**                                                                                                                                                                                       |
| **3** | **no paid AI plan** — disabled, the entitlement explained, Upgrade                                                                                                                            |
| **4** | ~~**read-only** — a member who holds `project:browse` and not `workflow:manage`~~ **WITHDRAWN 2026-09-13 (MOTIR-5393)** — the room is manage-only (§6); the number is kept so 5–8 keep theirs |
| **5** | the readers/writers argument and the rejected candidates, drawn beside the thing they justify                                                                                                 |

### Copy — the gate is CONDITIONAL, and that is the whole of it

**The switch does not promise a video and does not govern recording. It says
what the PRESENCE of one means for this project:**

> **IF a story has an acceptance video, it is held for approval — and its status
> may not be moved by hand until someone gives it.**

**Why the conditional is load-bearing, and not a wording preference.** A video is
not guaranteed to exist. Motir's own path produces one — the planner plans the
story, a Motir agent runs it, the run publishes the receipt — but a team that
plans somewhere else, or runs its own agents, gets no video from that path at
all. **And they can still publish one**, because the acceptance API and the
`publish_acceptance_result` MCP tool are open doors that any CI or any agent can
call (`lib/acceptanceEvidence/publishAuth.ts` ·
`lib/mcp/tools/publishAcceptanceResult.ts`, both running the one eligibility
computation). **So the gate cannot be described in terms of a run**: the honest
rule is _video present ⇒ gate_, whoever put it there, and that is what the
setting has to say.

Any copy of the form _"when a run produces…"_ is wrong twice over — it promises a
run that may never happen, and it implies Motir owns the production of something
anyone can publish. The shipped org-tier card is the worked example of the
mistake: _"Record a short video when a story's E2E passes and attach it to the
story for review & approval."_ It describes a recording this flag has never
governed, on a run it cannot assume.

**The card reads:**

> **Acceptance video approval**
> A story that has an acceptance video is held until a person approves it — it
> cannot be finished, and its status cannot be moved by hand, until they do. It
> makes no difference where the video came from: a Motir agent run publishes one,
> and so does anything using the acceptance API.

**The state line carries a NAME and a CONSEQUENCE**, because "On" alone does not
tell a reader what their project just started doing:

| state         | name            | consequence line                                                                                             |
| ------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| on            | **On**          | Any story with an acceptance video waits for approval — whoever published it.                                |
| off           | **Off**         | No acceptance video is accepted for this project, and no story is held.                                      |
| no plan       | **Unavailable** | Your organisation has no paid Motir AI plan, so no acceptance video can be published.                        |
| ~~read-only~~ | ~~**On**~~      | ~~_(as above)_, plus the footer line below~~ **WITHDRAWN 2026-09-13 (MOTIR-5393)** — no read-only state (§6) |

**OFF is enforced at the PUBLISH doors, not only in the panel** — which is what
makes the OFF line true for a team outside Motir's path. `publishAuth` and
`publishAcceptanceResult` both resolve
`acceptanceVideoEligibilityService` and refuse: **`403
ACCEPTANCE_VIDEO_INELIGIBLE`** with `reason: toggle_off`, and **`402`** with
`reason: no_plan`. There is no door that skips the gate — the MCP tool's own
header says skipping it "is the only way a gate that exists stops meaning
anything."

> **⚠️ THE SECOND CLAUSE IS NOT THIS EPIC'S TO SHIP, AND MOTIR-4925 MUST NOT
> SHIP IT ALONE.** _"its status cannot be moved by hand"_ is **MOTIR-4887**'s
> deliverable (_A GATE OWNS ITS SUBJECT'S STATUS — the manual flip is refused
> while a decision is pending_), and MOTIR-4949's own scope boundary lists it as
> a NON-deliverable this gate **inherits as it lands**. So the copy above is the
> TARGET, and it becomes true when MOTIR-4887 does. **Either sequence MOTIR-4925
> after MOTIR-4887, or ship the first clause alone and add the second with
> MOTIR-4887** — a setting that claims a refusal the product does not perform is
> the same defect as the recording claim it replaces, one clause over. This is a
> decision for whoever schedules the two; the design states the end state.

> **AMENDED 2026-09-20 (MOTIR-5524) — DISCHARGED: the second clause SHIPPED, and
> the route taken was the second of the two above** (_ship the first clause
> alone and add the second later_). MOTIR-4925 shipped the first clause by
> itself; this card added _"it cannot be finished, and its status cannot be
> moved by hand, until they do"_ to `approvals.acceptanceVideo.desc` in
> `messages/en.json` and its `zh` twin, **after both prerequisites landed** —
> **MOTIR-4949** (`acceptance_result` is a registered gate kind:
> `lib/approvalGates/registry.ts`, and
> `acceptanceResultGateHandler.statusIntent = ACCEPTANCE_APPROVAL_TARGET`) and
> **MOTIR-4887** (a hand move onto a status an `awaiting` gate holds throws
> `ApprovalGatePendingError` from `workItemsService.applyStatusTransition`, via
> `heldMoves`' RULE 1). The copy above is therefore no longer a TARGET — it is
> what ships. The flag is kept, struck through nowhere, as the record of why the
> sentence arrived in two pieces.

Footers: the no-plan state carries _"The plan is bought once, for the
organisation — not per project."_ + **Upgrade**. ~~The read-only state carries
_"Only a project admin can change this. You are seeing what this project has
chosen."_ (`readOnlyNote`)~~ **STRUCK 2026-09-13 (MOTIR-5393):** there is no
read-only state, so there is no `readOnlyNote` string (§6).

**Primitives and token roles.** `Card` (header / body / footer slots — the same
composition `AcceptanceVideoCard.tsx` already uses) · `Switch` · `Button`
(primary, for Upgrade) · `Pill` for the rail's own chrome. Ink: title
`--el-text`; description and state gloss `--el-text-secondary` — **never**
`--el-text-muted`, which fails AA on every surface this card lands on. The OFF
track is `--el-border-strong`, deliberately not a danger colour: a project that
does not ask for acceptance approval has not done anything wrong. Radius
`--radius-card` / `--radius-badge`; padding `--spacing-chip-*`; elevation
`--shadow-card`.

### 4. What the CODE owes — read against SHIPPED REALITY

The current org-tier control was rendered from its own source before anything
here was drawn (`AcceptanceVideoCard.tsx` in all four states, with the real
`globals.css`). Two defects fell out of that render, and **MOTIR-4925 owes both**:

1. **The no-plan state contradicts itself.** The label is computed from
   `enabled`, the switch from `enabled && hasPlan` — so with no plan the card
   prints **"On"** beside a switch that is **off**. The two disagree on the one
   screen a reader would use to check. In this design the entitlement decides
   BOTH, and the state is named _Unavailable_.
2. ~~**The read-only state explains nothing.** `canManage: false` renders
   byte-identical to the admin state except that the switch will not move. A
   disabled control with no reason reads as a bug. The footer line is the whole
   fix.~~ **WITHDRAWN 2026-09-13 (MOTIR-5393):** the room has no `canManage:
false` render to fix (§6). The org-tier card that has one is deleted by
   MOTIR-5172.

**The rest of what MOTIR-4925 and MOTIR-4950 owe the code:**

- the registry entry above, and its `nav.approvals` message key (`en` + `zh`);
- the route `app/(authed)/settings/project/approvals/page.tsx`, gated on
  `workflow:manage`, so the route↔registry totality test stays green;
- the copy keys — `approvals.acceptanceVideo.{title,desc,on,off,unavailable,
onWhat,offWhat,unavailableWhat,orgPlanNote,upgrade}` — replacing
  the `acceptance.card.*` set, whose `desc` is the recording claim. ~~`readOnlyNote`~~
  is struck (MOTIR-5393, §6);
- **and `acceptance.states.toggleOff.desc` on the PANEL, which carries the same
  wrong claim one surface over:** _"Turn it on to record and attach a video
  receipt when this story's E2E passes."_ It becomes _"Turn it on and any
  acceptance video published for this story will be held for approval."_ The
  conditional has to hold on every surface that states the rule, or the one that
  still promises a recording is the one a reader believes;
- `settingsHref` on the acceptance panel re-pointed at
  `/settings/project/approvals`, and the `#acceptance-video` anchor retired or
  re-minted against the new room — a link to a page the setting has left is
  worse than no link, because it looks like it worked;
- **the org page's new card order**, which is the losing end and is drawn in
  `design/org-admin/` — see that area's notes.

### 5. Explicitly OUT of scope here

~~The merge-mode switch (ADR §7) is **not drawn**: it is MOTIR-4882's to design and
build, and drawing a second card this asset would be inventing is not how a room
earns its place.~~ **CORRECTED 2026-09-13 (MOTIR-5176):** the attribution was
stale. The surface is **MOTIR-4880's** (the setting, its control, its deep link);
MOTIR-4882 ships the merge itself. The row is now drawn in panels 6–8, see §7. The room is justified by the readers and writers in §1. Also out
of scope: the entitlement's tier (it stays with the organisation), what a run
records, the video's pacing, and the storage caps.

### 6. AMENDED 2026-09-13 — MANAGE-ONLY: the room is seen, opened and changed by a manager, and by nobody else (MOTIR-5393)

**DECIDED (Yue, 2026-09-13, at [MOTIR-5176](motir:cmtx6ghv900dchvoi9jg3gbam)'s design
review):**

> _"read only option doesn't stand, frontend is guarded by the permission too, if
> the user can't manage the project, the user won't be able to land on the page."_

This supersedes [MOTIR-5190](motir:cmtx85ynp00y6i0tx2lmi7cez)'s decision of
2026-09-11, whose body is kept below, struck, so a pointer to §6 lands on the
reversal rather than on nothing.

#### The rule in force

1. **`approvals` carries ONE key, `workflow:manage`,** for the rail row, the
   destination and the read. It declares no `viewPermission`. View equals write,
   as it does for every other room in the registry.
2. **A member who cannot manage the project is refused the room.** The room gives
   them no settings door, and they are not shown the value: no rail row, no
   read-only render, no footer naming who may change it.
3. **A deep link into the room renders only for a viewer holding
   `workflow:manage`.** That covers `#acceptance-video` and `#merge-mode` alike.
   Anyone else meets the settings guard's refusal, never the room.

#### What moves with it

- **Panel 4 is withdrawn** from `approvals.mock.html`. Its number is kept as a
  placeholder, so panels 5–8 keep the numbers MOTIR-5181 and MOTIR-5183 cite.
- **Struck where they stand:** §1's `viewPermission` line and the note under it,
  §3's panel-4 row, the copy table's read-only row, the read-only footer
  (`readOnlyNote`) and its key, and §4's read-only defect.
- **§7's two "out of step" flags** now say the contradiction is resolved here.

#### Why the struck argument no longer holds

It rested on a member's _need to know_ what the project asks of them, and on a
read-only room being where they learn it. The ruling does not answer that
argument; it removes its premise. The room's front end is guarded by the same
permission that changes the room, so a read-only render draws a state nothing
reaches. A member learns what the gate asks where the gate meets their work: on
their own story. That is the struck body's second rejected shape. It is now in
force as a consequence of the ruling, not because a new argument beat the old one.

**Amendment 2026-08-08 needs no reconciliation any more.** `approvals` is an
ordinary room under that amendment's rule 1: the entry point is hidden from an
actor with no path to the destination. The settings AREA door therefore stops
reappearing for every member on this room's account.

#### Who owns the code

[MOTIR-5394](motir:cmu09oxzx00a6hwtxme79ckyj) makes the room manage-only again. It
reverts what [MOTIR-5278](motir:cmtys0kdg00elhvoi3nesxn3w) merged as PR #2843:
`approvals` drops its view key, its read returns to `workflow:manage`, and the
suites MOTIR-5278 inverted are restored on the record. **Until it merges, the
shipped room is visible to every project browser, and this section outranks it.**
[MOTIR-5171](motir:cmtx6c1os00ayhvoiwsda64c0) builds panel 3 only. Whether the
registry keeps MOTIR-5193's two-key mechanism with no room declaring it is
MOTIR-5394's decision, not this asset's.

#### The retired body — MOTIR-5190, 2026-09-11, struck

~~WHO MAY SEE THE ROOM — the room is VISIBLE to a member, WRITABLE by an admin (MOTIR-5190)~~

~~**The asset shipped with its two halves contradicting each other**, and
[MOTIR-5190](motir:cmtx85ynp00y6i0tx2lmi7cez) is the card that found it. §1's
registry entry gated the row on `workflow:manage`; panel 4 drew a read-only state
for _"a member who may browse the project but does not hold `workflow:manage`"_
and said in terms that **the room is NOT hidden**. In this codebase those cannot
both ship, because a registry entry's `permission` does two jobs:
`visibleSettingsNav` filters the RAIL on it, and `resolveSettingsRefusal`
(`app/(authed)/settings/project/_guard.tsx`) reads **the same key off the same
entry** to refuse the DESTINATION — deliberately, so that _"the row that hides the
page and the page that refuses the actor cannot gate on different keys."_ So with
one key the reader panel 4 is drawn for never reaches the room, by the rail or by
a deep link.~~

#### ~~The decision~~

~~**DECIDED (Yue, 2026-09-11): the room is shown READ-ONLY to a member who cannot
manage it. Panel 4 ships as drawn.** The principle, in Yue's own words, was
stated about the gate's pending state and applies here unchanged:~~

> ~~_"the to be approved status should be showing read only for the user who can't
> approve, and just showing the first approver name there."_~~

~~Don't hide; show the state, and name who acts. Panel 4's _"what a project asks of
you is something you are entitled to know"_ is the same sentence about a
different surface, so **the asset's two halves are reconciled in panel 4's
favour** and §1's entry gains a second key.~~

#### ~~Why the other two shapes were not taken~~

- ~~**Withdraw panel 4** (the room stays admin-only; the read-only state stops
  existing). Cheap, and it is the shape that ratifies the defect rather than
  fixing it: the member keeps meeting a gate that holds their story and keeps
  having no way to find out what their project asks of them. It also throws away
  the argument panel 4 was making without anyone having answered it, which is
  exactly the move a design pass should not make — **an asset re-worded until it
  describes the shipped behaviour accurately is still an asset that specifies
  the shipped behaviour.**~~
- ~~**The acceptance PANEL carries the answer instead** (the room stays admin-only;
  the member learns the rule on their own story). The strongest of the three
  rejects, and it fails on COVERAGE rather than on principle: the panel exists
  only once a story already HAS a video, so it can explain a gate the member has
  already been stopped by and can never tell them the rule in advance. The two
  surfaces answer different questions — the panel answers _why is THIS story
  waiting_, the room answers _what does this PROJECT ask of me_ — and the first
  does not contain the second. It is also already owned elsewhere: the gate's own
  read-only state is shipped, and the one thing missing from it is the approver's
  NAME, filed as [MOTIR-5191](motir:cmtx98fys011lhvoioaqy2kuw). Nothing about
  this decision displaces that card; the two are the room and the story.~~

#### ~~The VISIBILITY key: `project:browse`~~

~~**`viewPermission: 'project:browse'`, and `permission: 'workflow:manage'`
unchanged.** `project:browse` is the shipped catalog key
(`lib/permissions/catalog.ts`) for _may you see this project at all_, and it is
the honest one here for a reason that is structural rather than aesthetic: it is
already the floor for reaching the settings shell. `layout.tsx` answers a
NON-browser with the project-level no-access state before any settings page
runs, so every actor who can arrive at this room's URL holds `project:browse`
by construction. **No new permission is invented** — MOTIR-5193's scope boundary
forbids growing the catalog, and nothing here needs it.~~

#### ~~What happens to the other rooms' entries: NOTHING, and that is a decision~~

~~**Every other registry entry keeps exactly one key, and `approvals` is the only
entry that splits.** A view key that is absent means view = write, so the other
sixteen rooms behave identically and the migration is the empty diff
(MOTIR-5193 criterion 1 asserts precisely this). They are right to: the rest of
the registry configures things a non-admin cannot act on and has no stake in —
which is what the **Amendment 2026-08-08** above settled, and this decision does
not re-open it. See the reconciliation below.~~

~~**⚠️ BUT THE SPLIT HAS ONE CONSEQUENCE THAT REACHES EVERY PROJECT, AND IT IS NOT
IN MOTIR-5193's CRITERIA — the settings AREA DOOR comes back for every member.**
`hasVisibleSettingsArea` is a `some()` over the same per-entry predicate, and the
`code-access` entry states the arithmetic outright: _"every actor who reaches
this shell holds `project:browse`, so one browse-gated entry means the settings
AREA door never disappears for anyone."_ That entry was de-browse-gated partly to
make the door disappear. **A browse-visible `approvals` brings it back**, for
every member of every project, permanently.~~

~~That is accepted, and it is coherent rather than a regression — but it must be
built knowingly:~~

- ~~A member's settings rail is **not empty and not full**: it holds exactly one
  row, Approvals, in the `work` group. `groupSettingsNav` drops the three empty
  groups on its own, so the rail is one section with one row.~~
- ~~The area door then opens onto a real room instead of a corridor, which is the
  condition Amendment 2026-08-08 row 2 actually states — it says HIDE the door
  _when every entry inside filters away_, not _when the actor is not an admin_.
  With one visible entry the antecedent is false and the door is correct.~~
- ~~**`resolveSettingsRefusal`'s back-link still resolves.** It takes
  `visibleSettingsNav(held)[0]`, so a member refused anywhere else in the area
  lands on Approvals rather than falling out to `/dashboard`. That is a better
  destination than the one they get today, and MOTIR-5193 criterion 4 is what
  holds it.~~

#### ~~Reconciling this with _Amendment 2026-08-08_ — it is NOT a carve-out~~

~~The amendment above is in this same file and its rule 1 says **HIDE an entry
point whose destination the actor cannot use at all**; six registry entries cite
it as the reason they stopped being browse-gated. This decision looks like a
reversal and is not one, because the amendment's dividing line has **two
conjuncts**, stated once so it could be applied to a surface its table does not
list:~~

> ~~_"hide when the actor has no path to the destination **and no need to know it
> exists**; disable when the actor is already standing on the surface and the
> control is the only thing that would tell them the action exists."_~~

~~**Every room swept in 2026-08-08 fails BOTH conjuncts.** A member has no path to
the repository connections and no need to know they exist; the same for roles,
fields, components, automation. **Approvals is the first room to fail the first
and PASS the second** — a member has no path to the switch, and a very direct
need to know it exists, because it is the thing that decides whether their own
finished work waits for someone. The amendment did not anticipate this room; it
wrote the clause that admits it. So nothing above is superseded, no row of its
treatment table changes, and **the strike-through / amendment convention it
established is not repeated here** — this is the amendment being applied, not
amended.~~

~~What DOES move is the amendment's own note that it _"does not assign permission
KEYS to surfaces"_: each implementing card decides that against its own server
guard, and §1's two keys above are this room's answer.~~

#### ~~What MOTIR-5193 owes, restated as this asset's demand~~

~~The one-key model is a **defence**, not an oversight — `_guard.tsx` looks the key
up rather than re-declaring it _"precisely so they cannot drift… That divergence
is invisible in review — everything renders, everything refuses, and the only
symptom is that the wrong people are let in or kept out."_ Splitting the keys
makes that hazard real for the first time. **So the split is only honest if it
arrives with the drift made LOUD**: a test that fails, naming the file and both
keys, when an entry's declared `viewPermission` is not the key its destination
checks — proven by a fixture that drifts on purpose rather than asserted to
exist. That is MOTIR-5193 criterion 5, and this asset is the reason it is
non-negotiable: a comment asking the next author for care is exactly what stops
working once there are two keys to keep aligned instead of one.~~

#### ~~The build order, and the state of the room today~~

~~`approvals` ships **admin-only right now** — MOTIR-5170 shipped §1's entry with
the single key, matching its own criterion 4, and that was correct on the day.
The sequence from here is:~~

1. ~~**[MOTIR-5193](motir:cmtx9wctp013uhvoil4s80ykf)** — the registry learns
   `viewPermission`, both consumers read the right key, the drift test fires, and
   `approvals` declares `project:browse`. Blocked by this card precisely so the
   vocabulary is chosen before the mechanism is built.~~
2. ~~**[MOTIR-5171](motir:cmtx6c1os00ayhvoiwsda64c0)** — renders the room's
   ENTITLEMENT and PERMISSION states, panel 4 among them. Its read-only state is
   **confirmed in scope**, not deleted: the shape that would have deleted it is
   the one not taken.~~

~~Until step 1 lands, panel 4 draws a state the product cannot reach. **That is a
design that outranks the code, in the ordinary direction** — the same standing
this file's _Source of truth_ carve-out gives the 2026-08-08 amendment: an
amendment carrying a date, a reason and the card that owns it governs the code
until that card ships.~~

### 7. AMENDED 2026-09-13 — the MERGE-MODE row (MOTIR-5176, story MOTIR-4880; panels 6–8)

**The room's second card, `Merging pull requests`, sits BELOW the acceptance-video
switch.** It is on the same axis: what the presence of a pull request means for
this project. It draws `Project.prMergeMode` (`docs/decisions/approval-gates.md`
§7 and its 2026-09-13 amendment). **It is a choice between two described modes,
so it is the shipped access-level radio-card grammar** (`access-members.mock.html`,
`ProjectMembersSettings` `role="radiogroup"`), not a copy of its neighbour's switch.

**Grounded in (read at design time):** ADR §7's value table and its
provenance-default amendment; §7a (the audit says the SETTING authorised an
`auto` merge, not a person); `projectPrMergeModeService` on
`parent/MOTIR-4880-pr-merge-mode` (the read and the write are both
`workflow:manage`).

> **⚠️ MANAGE-ONLY — there is NO read-only state (Yue, 2026-09-13, on this card's
> design review).** The room's front end is guarded by the permission: a member
> who cannot manage the project never lands on the page, so a read-only render
> draws a state nothing can reach. The first cut drew one (a panel 9 following
> §6 above), and it is withdrawn. ~~**This contradicts §6 (MOTIR-5190) and panel
> 4, and open PR #2843 (MOTIR-5278), which opens the room to `project:browse`.**
> Those are named here and not reworked by this card.~~ **RESOLVED 2026-09-13 by
> MOTIR-5393:** §6 is amended to MANAGE-ONLY and panel 4 is withdrawn. PR #2843
> merged, and MOTIR-5394 reverts it.

> **⚠️ TWO VALUES — `review_on_fail` is RETIRED (Yue, 2026-09-13).** Only a GREEN
> pull request is ever a merge candidate: a red one never reaches In Review and
> stays with the run that is fixing it. So "ask only when checks fail" would put
> a merge approval on broken code, and no meaning survives the name. The first
> cut drew it as a third option with a _Not built yet_ pill (a panel 8); that
> option, its pill and its panel are withdrawn, and the enum value is removed by
> the story's migration (ADR §7 amendment, point 4).

#### The copy — transcribe verbatim (MOTIR-5181)

| value    | LABEL (bold line)   | HINT (secondary line)                                                                                                                               | extra                             |
| -------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `manual` | Ask before merging  | When its checks pass, a person approves the pull request in Motir before it is merged. Nothing reaches your default branch without that yes.        | icon tile `--el-tint-sky`, `user` |
| `auto`   | Merge automatically | When its checks pass, Motir merges the pull request without asking anyone. The record says this setting allowed it — not that a person approved it. | icon tile `--el-tint-mint`, `zap` |

**Both hints open on _when its checks pass_**, because that is the only moment a
merge is on the table in either mode. A pull request whose checks fail is never
offered for merging; it stays with the run that is fixing it.

- **Card title:** Merging pull requests · **description:** _What happens when a
  pull request for this project's work is ready to merge. A project whose
  repositories Motir hosts starts at **Merge automatically**; a project holding
  any repository of your own starts at **Ask before merging**._
- ~~**The not-yet notice** (`--el-tint-sky` callout, `info` glyph, ink
  `--el-text-strong`): _Motir does not merge pull requests yet. Until it does,
  every pull request is merged on your git host by a person, whichever option is
  chosen here._ It is honest about today: nothing reads the value until
  MOTIR-4882, which removes the notice in the change that makes it false.~~
  **REMOVED 2026-09-15 (MOTIR-5539).** MOTIR-4882 merged (#2898) without taking
  it, so for a day the card said the opposite of what the product did: a `manual`
  project's approval merges the pull request, and an `auto` project's green pull
  requests are merged with no person. Nothing replaces it — the two hints already
  say what happens when checks pass, and that is now true in both modes. Panels
  6–8 of `approvals.mock.html` still draw the callout; they are the record of
  2026-09-13, when it was true, and are not redrawn (a notice removed on the
  schedule this note set is not a change to the design).
- **No enum member or column name is ever shown.**

#### Decisions, each with its reason

- **Apply on change**, reconciled from the response and put BACK on failure,
  which is the acceptance switch's idiom. A person's choice is stamped decided
  (`prMergeModeDecidedAt`), so no copy needs to warn that a default might
  overwrite it.
- **The deep link is `#merge-mode`** (the card's id, beside the shipped
  `#acceptance-video`). On arrival the card takes the ordinary
  `--focus-ring-color` ring once. It is not a tint and not a flash (panel 8). The
  link is guarded as the room is: ⌘K does not list it, and the approval frame
  renders no door, for anyone without `workflow:manage`.
- **Ink:** title `--el-text`, description / hint
  `--el-text-secondary` (never `--el-text-muted`), notice `--el-text-strong` on
  its tint (finding #35). Shape: `--radius-card` on each option, `--radius-control`
  on the tile and the notice.

#### ⚠️ Planning flags (surfaced, not silently absorbed)

- **MOTIR-5181 transcribes** panels 6–8 in `en` and `zh`, reading through
  `getPrMergeMode` and writing through `setPrMergeMode`, both `workflow:manage`.
- **The room is manage-only.** A non-manager is refused the route, and nothing
  here draws what they would see instead.
- ~~**Out of step with this decision:** §6 / panel 4 (MOTIR-5190) and open PR #2843
  (MOTIR-5278) both open the room to `project:browse`.~~ **RESOLVED 2026-09-13:**
  MOTIR-5393 amends §6 and withdraws panel 4; MOTIR-5394 reverts the merged #2843.
- **MOTIR-4882 ~~removes the not-yet notice and~~** builds the approval frame's
  settings door (`design/work-items/design-notes.md`, the UNIVERSAL APPROVAL
  FRAME's 2026-09-13 amendment). **The notice's removal landed in MOTIR-5539
  (2026-09-15)** — MOTIR-4882 merged without it.
- **MOTIR-5183 walks** panels 6, 7 and 8, and asserts a member without
  `workflow:manage` is refused the route.

#### GIVES / TAKES

| work item                    | GIVES / TAKES                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-5181** (the control) | **GIVES** the copy, the grammar, the three states, the anchor. **TAKES** — its criteria drop `review_on_fail` (amended on the card). |
| **MOTIR-4882** (the merge)   | **GIVES** the room its door lands in. ~~**TAKES** the notice's removal.~~ Merged without it; **MOTIR-5539** took it (2026-09-15).    |
| **MOTIR-5183** (E2E)         | **GIVES** the walk's surfaces. **TAKES nothing.**                                                                                    |
| **MOTIR-4942 / MOTIR-5190**  | **neither** — `done`; §5's stale attribution corrected on the record above.                                                          |

---

# Bugs — where a project's filed bugs land (Story MOTIR-4927 · Subtask MOTIR-4933 output, amended by MOTIR-5536)

## ⚠️ AMENDMENT 2026-09-14 (MOTIR-5536) — the destination is a FOLDER

**The room picks a folder, not a work item.** MOTIR-4927 was re-planned after
MOTIR-5296 decided the bug holder must not be a work item. Every project is now
born with a root folder named **Bugs** (MOTIR-4935), and the stored value is a
nullable pointer to a `folder` (MOTIR-4934). Everything below this block that
speaks of a _container_, a kind glyph or a work-item key is superseded where this
block says so. The room's entrance, its place in `Work`, its permission and its
three-choice shape are unchanged.

| What changed                    | Before (MOTIR-4933)                                     | Now                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The first choice's named target | kind glyph · `RENDE-1` · `Bugs` · Open                  | the lucide `folder` glyph (`--el-text-secondary`, as the `/items` tree draws it) · the folder name · Open                                                                                                       |
| The second choice's control     | the shipped `Combobox` over epics, stories and tasks    | the shipped **folder picker** — `components/folders/FolderPicker.tsx`'s panel: a title, the search `Input`, a listbox indented 22px per level, `Current location` tagged                                        |
| The picker's root option        | —                                                       | labelled **Project root**; picking it selects the third choice                                                                                                                                                  |
| The card description            | "…created under this container…"                        | adds one sentence: deleting the folder moves its bugs, and this destination, to its parent (MOTIR-5537)                                                                                                         |
| Panel 4 — the archived fallback | the warning banner and the struck-through stored choice | **deleted.** A folder has no archived state, and deleting the destination folder carries the destination to the folder's parent in the same transaction, so the room can never hold a destination that has gone |
| Panel numbering                 | 0–5                                                     | 0–4 — the access path is now panel 4                                                                                                                                                                            |

**Why a folder, in one sentence:** a seeded work item was work — it sat on every
board, report, ready list and Home list — while a folder is a placement that no
workflow read ever sees, and deleting one already moves its contents up, which
the destination now simply follows.

The copy strings changed by this amendment are in §5, marked **(amended)**; the
reason table in §5 is replaced by the pointer table below it.

**A new project-settings ROOM, `Project settings → Work → Bugs`, holding the one
setting that decides where Motir creates the bugs it files for this project.**
The asset is `bug-destination.mock.html` + `bug-destination.png`. Layout source of
truth for **MOTIR-4938** (the picker, its route, both catalogues), and the surface
**MOTIR-4940**'s E2E walks.

## Files

| HTML source (truth)         | PNG export            |
| --------------------------- | --------------------- |
| `bug-destination.mock.html` | `bug-destination.png` |

## 1. What it COMPOSES, and what it decides

**It composes shipped surfaces and re-specifies none of them.**

| Composed                                                         | What it owns, and this asset does not                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings-area.mock.html` (this file, Story 6.5)                 | The area chrome: the rail, its groups, the pane, the eyebrow → serif title → description head.                                                                                  |
| `design/monitoring/monitoring-room.mock.html`                    | The nearest room of the SAME epic. Its token, board-chrome, primitive and room-shell CSS is spliced in **verbatim** by line range, so the two assets of this tier cannot drift. |
| `components.mock.html` · the delete-with-reassign dialog         | The `choice-card` grammar — radio, title, description, an optional slot.                                                                                                        |
| `components/issues/ParentPicker.tsx` over the shipped `Combobox` | A searchable picker whose rows are kind glyph · title · key.                                                                                                                    |

**Rendered, not recalled.** Before drawing, the shipped area was rendered LIVE — a
signed-in account on a local `next dev`, capturing **Details** and **Estimation**.
Three things came from those renders rather than from reading source: the rail's
exact rows and group headings; the page head's serif title over a secondary line;
and the **settings card with an explicit `Cancel` / `Save changes` footer, Save
disabled until something is dirty** — Estimation's shipped behaviour, and the reason
this room saves explicitly rather than on pick. (The same render showed that the
rail differs per BUILD: `Public page` and `Public address` are absent off-cloud, and
`Approvals` is newer than that branch's base. The board draws the cloud rail at
`origin/main`.)

**What this asset DECIDES** is four things:

1. **Three named choices, and the third is a choice.** `Project root` has its own
   title and its own sentence. It is never an empty select, a cleared field or a
   `None` row: the stored value is a null pointer, null MEANS the root (MOTIR-4934),
   and an unset-looking control would tell every team that chose it their project is
   misconfigured.
2. **The first choice NAMES its container and links to it** — kind glyph, key,
   title, `Open`. A destination a person cannot open is one they cannot check.
3. **A container that has gone is STATED, not hidden** (panel 4).
4. **The room lives in `Work`**, gated on `project:administer` (§3, §4).

## 2. The panels

| Panel | State (amended, MOTIR-5536)      | What it draws                                                                                                                 |
| ----- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **0** | default — the seeded Bugs folder | The first choice selected, naming the **Bugs** folder with the tree's folder glyph and Open; Save disabled.                   |
| **1** | choosing another folder          | The shipped folder picker OPEN: `Project root`, `Bugs` tagged `Current location`, nested `Triage ▸ Incoming`, `Later`; dirty. |
| **2** | root chosen, saving              | `Project root` selected; both actions disabled; the primary carries the spinner.                                              |
| **3** | saved — the pointer is null      | Clean card with `Project root` selected, plus the success toast.                                                              |
| **4** | the ACCESS PATH                  | The rail with `Work ▸ Bugs` active, the group argument, and the stored-pointer → what-the-room-shows table.                   |

The former panel 4 (`container_archived` — a warning banner and a struck-through
stored choice) is **deleted**: a folder has no archived state, and deleting the
destination folder carries the destination to its parent in the same transaction
(MOTIR-5537), so the room never holds a destination that has gone.

**The picker's population is a CONTRACT, not an illustration (amended).** It is the
shipped `FolderPicker` panel over **this project's folders only** — never a work
item, never another project's folder — in tree order, indented 22px per level, with
the stored destination tagged `Current location` (`folders.currentLocation`). Its
root option is `Project root` (`folders.projectRoot`), and picking it selects the
third choice rather than being a fourth. The room composes the component; it adds no
second folder chooser, so the settings picker and the `/items` picker cannot drift.

## 3. WHERE it lives — decided from readers and writers

Following the approvals section's rule (_decide by who reads and writes the value,
never by what it resembles_), traced on `origin/main` plus the MOTIR-4927 branch:

|             |                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reader**  | `bugDestinationService.resolve` — the ONE seam. Its callers: `aiWorkItemsService.fileBug` (the `@planner-bug-home` marker path) today, and MOTIR-4929's monitor ingestion next. |
| **Writers** | `insertProjectWithSeedsInTx` (the seed, MOTIR-4935), the backfill migration (MOTIR-4936), and this room (MOTIR-4938).                                                           |

What those add up to is **where in this project's tree a kind of work item is
created** — the axis `Fields` and `Components` already occupy in `Work`, which shape
what a work item carries. So the row sits **last in `Work`, directly under
`Components`**, with the lucide `Bug` mark.

**Rejected candidates, and why each fails:**

- **`General ▸ Monitoring`** — the monitoring room holds a third party's CREDENTIAL,
  which is why it sits in General, and its own notes §7 name the bug-container
  picker as MOTIR-4927's and out of scope. The monitor is also one filer of several;
  a destination filed under it would read as monitor-only.
- **`Automation`** — holds rooms that configure how Motir BEHAVES (the planner's
  cadence, the rule engine). This value is a place in the tree, not a behaviour.
- **A card inside `Details`** — Details is the project's identity (name, key, logo,
  archive). A filing destination is not identity.

## 4. The permission — `project:administer`, and why not a new key

There is no `bug:*` key in `lib/permissions/catalog.ts`, and a design card has no
warrant to add one (the approvals section's own reasoning). Of the keys that exist:

- **`project:administer` — chosen.** Its registry evidence is _"the project-level
  administration that belongs to no domain"_, and a filing destination belongs to
  none of the existing domains.
- **`work_item:triage` — rejected.** Deciding where incoming bugs go sounds like
  triage, but the key's own catalogue copy is scoped to the QUEUE — _"Accept,
  decline, promote or snooze an item in the triage queue"_ — and widening a shipped
  key's meaning is a decision about that key, not about this room.
- **`workflow:manage` — rejected.** It governs how work MOVES (the status graph),
  not where it is created.

A dedicated key is a reasonable later split and is **not decided here**. The door is
therefore admin-only, the same as every row in the rail today; there is no read-only
panel because no reader without the key reaches the room.

## 5. Copy strings catalog (use verbatim in MOTIR-4938; i18n under `settings`)

| Surface                             | `en`                                                                                                                                                                        | `zh`                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Rail entry (`settings.nav.bugs`)    | `Bugs`                                                                                                                                                                      | `缺陷`                                                                                                     |
| Page title                          | `Bugs`                                                                                                                                                                      | `缺陷`                                                                                                     |
| Page description                    | `Where Motir files the bugs it creates on its own for this project — issues arriving from a connected monitor, for one. A bug a person files keeps the parent they choose.` | `Motir 为此项目自动创建缺陷时的存放位置——例如来自已连接监控服务的问题。由人工提交的缺陷保留其选定的父项。` |
| Card title                          | `Bug destination`                                                                                                                                                           | `缺陷去向`                                                                                                 |
| Card description **(amended)**      | `New bugs are filed into this folder. Changing it does not move bugs that are already filed. Deleting the folder moves its bugs, and this destination, to its parent.`      | `新缺陷将归档到此文件夹。更改设置不会移动已提交的缺陷。删除该文件夹会将其中的缺陷和此去向一并移到其上级。` |
| Choice 1 title · desc **(amended)** | `This project's Bugs folder` · `Created with the project. Rename it or move it and it stays the destination.`                                                               | `本项目的缺陷文件夹` · `随项目一同创建。重命名或移动后，它仍是缺陷去向。`                                  |
| Folder link                         | `Open`                                                                                                                                                                      | `打开`                                                                                                     |
| Choice 2 title · desc **(amended)** | `Another folder` · `Any folder in this project.`                                                                                                                            | `其他文件夹` · `本项目中的任意文件夹。`                                                                    |
| Folder picker **(amended)**         | the shipped `folders.*` strings — title `Bug destination` · search `folders.pickerSearch` · root `folders.projectRoot` · tag `folders.currentLocation` — no new keys        | 同上，沿用 `folders.*` 已有译文                                                                            |
| Choice 3 title · desc               | `Project root` · `Bugs are filed at the top of the project with no parent — nothing sits between a new bug and the backlog.`                                                | `项目根级` · `缺陷直接提交到项目顶层，不设父项——新缺陷与待办列表之间没有任何中间层。`                      |
| Footer                              | `Cancel` · `Save changes` · `Saving…`                                                                                                                                       | `取消` · `保存更改` · `正在保存…`                                                                          |
| Toast **(amended)**                 | `Bug destination saved` · `New bugs will be filed at the project root.` (root) · `New bugs will be filed into {path}.` (folder)                                             | `缺陷去向已保存` · `新缺陷将提交到项目根级。` · `新缺陷将归档到 {path}。`                                  |

~~Archived banner~~ · ~~Archived pill~~ · ~~Picker group headers~~ — **removed by the
amendment**: a folder has no archived state, and the folder picker has no kind groups.

**Stored pointer → what the room renders** (replaces the resolver-reason table —
`bugDestinationService.resolve` returns only `{ folderId }`, MOTIR-4937):
a folder id → the naming choice, with the folder glyph and Open · `null` →
`Project root`, selected · the pointed folder deleted → **never rendered**: the
delete carries the pointer to the folder's parent in the same transaction
(MOTIR-5537), so the room shows that parent or `Project root`.

## 6. Findings this design pass surfaced — each one is a card, not a paragraph

1. **A DELETED container cannot draw panel 4 — filed as MOTIR-5294.** MOTIR-4934's
   `ON DELETE SET NULL` turns a deleted container into a null pointer, and null
   already means `Project root`, so the room cannot tell a deleted container from a
   deliberate choice: the column no longer holds the difference. The story's
   _"records why"_ and MOTIR-4938's _"archived **or deleted**"_ both read on it, so
   MOTIR-4938 is now `blocked_by` MOTIR-5294, which owes the decision (accept and
   amend the criteria, or record the lost value). No dangling name is ever shown
   either way; until it is decided, panel 4 is drawn for an ARCHIVE only.
2. **The planner's in-tenant `log_bug` does not consult the destination yet — a
   gap in MOTIR-4937, being closed there.** `aiWorkItemsService.filePlannerBug`
   places a bug by the `parentKey` the planning tool supplies and files at the
   root when it supplies none. The story names _the MCP's `log_bug`_ as one of the
   resolver's three consumers, so this is that card's unmet criterion, recorded on
   it with the fix: a supplied parent is kept, a parentless planner bug resolves
   the destination. The page description above already holds under that fix — a
   parentless planner bug is one Motir creates _on its own_, and a bug that names
   a parent keeps it.
3. **The seed's container description already names this room** — _"Project
   settings → Bugs is where that choice lives"_ is the body MOTIR-4935 writes into
   every seeded container (its `DEFAULT_BUG_CONTAINER_DESCRIPTION_MD` constant, not
   yet on `main` while that card's pull request is open). This asset ratifies that
   name; if the room is ever renamed, that string moves with it.

## 7. Scope boundary — what this asset must NOT be read as specifying

- **No list of filed bugs**, and no count of what has landed in the destination.
- **No bulk "move existing bugs" action.** Changing the destination affects the
  next bug only — the card description says so.
- **No monitor connection surface** — that is `design/monitoring/`'s.
- **No route.** The room's page does not exist yet; MOTIR-4938 creates it and owns
  its address, so this asset names none and needs no `design-asset-addresses`
  exemption.

## 8. Tokens & a11y

Colour is `--el-*` only; shape through the element-semantic tokens
(`--radius-card/-input/-control/-badge`, `--height-input/-btn-md`,
`--spacing-control-*/-input-x`, `--shadow-card/-elevated`). Description ink is
`--el-text-secondary`, never `--el-text-muted` (the shipped `choice-card` used muted;
raised here so it clears AA on every surface the card lands on). Keys use
`--el-text-identifier`, the Combobox's own identifier ink. The three choices are a
`radiogroup` of `radio`s with `aria-checked`; the picker is the shipped WAI-ARIA
combobox + `listbox`; the archived state conveys itself with text and an icon, not
colour alone.

## Project Members without roles — `access-members--no-roles.mock.html` (MOTIR-6456)

A delta of `access-members.mock.html`: roles moved to the workspace (Story MOTIR-6168), so the project
Members card loses its role `Combobox` and role `Pill`, and the project rail loses **Roles &
permissions** (its routes redirect to `/settings/workspace/roles`). The spec — panels 3a–3c, copy,
tokens and the element → card allocation — is `design/workspaces/design-notes.md` § _Workspace roles_,
where the rest of the same room is drawn. The access-level card is unchanged here; MOTIR-6169 owns it.

## Access modes at the project — `access-members--access-modes.mock.html` (MOTIR-6540)

**Story MOTIR-6169 · design card MOTIR-6540.** Roles live on the workspace (MOTIR-6168); ACCESS lives on
the project. `docs/decisions/role-model.md` Q1 replaces the four access LEVELS (Building in public ·
Open · Limited · Private) with three **access modes** on the project — **Open to the workspace ·
Members only · Public** — and a **Full / Limited access scope** on each workspace membership. This
design draws the three surfaces that change, one delta mock per area:

| Surface                                                      | Delta mock (amends)                                                                                                                 | Spec section                                                                       | Builds it  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- |
| Project **Access &amp; members**                             | `design/projects/access-members--access-modes.mock.html` (amends `access-members.mock.html` + `access-members--no-roles.mock.html`) | this section                                                                       | MOTIR-6550 |
| Workspace **Members** — the Access column, invite            | `design/workspaces/workspace-roles--access-scope.mock.html` (amends `workspace-roles.mock.html`)                                    | `design/workspaces/design-notes.md` § _Access scope at the workspace (MOTIR-6540)_ | MOTIR-6551 |
| The **no-project shell** (a Limited person added to nothing) | `design/shell/no-project--limited.mock.html` (amends `top-bar.mock.html`)                                                           | `design/shell/design-notes.md` § _The no-project shell (MOTIR-6540)_               | MOTIR-6548 |

The base mocks are records and are not edited. All three were **rendered first**: `/settings/project/members`,
`/settings/organization` (the Members fold-in and the shipped Invite modal) and the top bar's project
switcher, at `origin/main` @ `c6cf7e5b4` on a `pnpm db:seed` tenant, and every panel composes what renders
there. Each mock carries a **Theme** and a **Language · 语言** toggle and a nested dark panel.

### The vocabulary — one set of words across the three surfaces

| concept                    | en                    | zh           | where it is chosen                                                  |
| -------------------------- | --------------------- | ------------ | ------------------------------------------------------------------- |
| project mode `workspace`   | Open to the workspace | 开放给工作区 | the project's Access &amp; members                                  |
| project mode `members`     | Members only          | 仅限成员     | the project's Access &amp; members                                  |
| project mode `public`      | Public                | 公开         | the project's Access &amp; members (via the build-in-public dialog) |
| membership scope `full`    | Full                  | 完全         | the workspace's Members, and the Invite modal                       |
| membership scope `limited` | Limited               | 受限         | the workspace's Members, and the Invite modal                       |

"Members only" (a project mode) and "Members" (the workspace page, and the project's people list) are
different nouns that share a word; the mode is always written in full, never shortened to "Members".
The retired level `limited` survives in exactly one sentence — the migration notice's reason line —
and nowhere else.

### The access path

Project settings rail → **Members &amp; access** — the shipped rail entry, gated on `member:manage`
(`lib/settings/projectSettingsNav.ts`). Unchanged; nothing new to reach.

### Panels

- **A1 — Open to the workspace, a Manager, populated.** The access card keeps the shipped radio-card
  markup of `ProjectMembersSettings.tsx` — `Card`, a `role="radiogroup"` of bordered cards, each with an
  icon tile (`--el-tint-mint` Users · `--el-tint-lavender` Lock · `--el-build-bg` Megaphone in
  `--el-build-glyph`), a label, a one-line description and a radio dot. **There is no `RadioGroup`
  primitive in `components/ui/*`; the card IS the radio** — build to this markup, not a new primitive.
  The header pill names the current mode. Below it, the **Members** card (the people list) keeps Add and
  Remove and gains two read-only chips per row: the workspace role (`--el-role-*` hues, as the workspace
  page) and the scope (neutral `Pill`, `Lock` glyph on Limited). A **Manager row has no scope chip** —
  scope is never read for a Manager.
- **A2 — choosing Members only opens a confirm that names who loses access.** The radio does not flip:
  the page first reads `GET /api/projects/<key>/access/preview?mode=members` (MOTIR-6544), then a `Modal`
  lists exactly the Full, non-Manager members who are not added (avatar, name, email, role pill, scope
  pill), says how many, and offers **Cancel** / **Make members only**. The switch adds nobody to the project.
- **A3 — the same confirm when nobody loses access.** One sentence in place of the list; still a confirm.
- **A4 — Members only with nobody added.** `Lock` glyph, _Only Managers can open this project_, and a
  prompt to add people. (Under Open to the workspace the empty list keeps the shipped 3b copy.)
- **A5 — Add people open.** The shipped searchable `Combobox`, scoped to workspace members not yet added;
  the secondary line is email · role · scope, and a Manager is offered but marked _always enters_.
- **A6 — read-only (no `project:manage_access`, no `member:manage`).** The mode is shown as TEXT — the
  selected card alone, no radio — plus one `info-note`. The people list has no Add / Remove and carries
  the shipped _Read-only_ pill. **A7** draws the split: `member:manage` without `project:manage_access`
  (people controls on, mode read-only); the reverse is the mirror.
- **A8 — saving → save failed.** Saving: `LoaderCircle` in place of the chosen card's radio, the group
  disabled. Failed: the selection reverts and an error `Toast` names the mode the project is still in.
- **A9 — loading.** An in-page skeleton behind the page's own gate (never a `loading.tsx`).
- **A10 — Public.** Selected: the shipped _Live_ chip, and the shipped build-in-public manage row and
  Public link card follow unchanged. `BuildInPublicDialog` / `StopBuildInPublicDialog` are re-pointed at
  the mode (`public` on confirm, `workspace` on stop), not redrawn. **Self-hosted: Public is DISABLED
  with an explanation.** ⚠️ The card called this "its existing cloud-only explanation"; the shipped page
  has none — it removes the option off-cloud (MOTIR-4035). The copy below is new.
- **A11 — dark.**

### Copy catalogue — `settings.access.*` (new or changed; en + zh)

| key (proposed)                            | en                                                                                                                                                                             | zh                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `mode.workspace` / `.members` / `.public` | Open to the workspace / Members only / Public                                                                                                                                  | 开放给工作区 / 仅限成员 / 公开                                                                           |
| `modeDesc.workspace`                      | Everyone in {workspaceName} with Full access can open it, plus the people added below.                                                                                         | {workspaceName} 中拥有完全访问权限的每个人都可以打开它，另加下方添加的人。                               |
| `modeDesc.members`                        | Only the people added below can find or open it. Hidden from everyone else.                                                                                                    | 只有下方添加的人才能找到或打开它，对其他人隐藏。                                                         |
| `modeDesc.public`                         | Open to the workspace, plus anyone with the link — the build-in-public page. Visitors read without an account and sign in only to submit, upvote or comment.                   | 开放给工作区，另加任何拥有链接的人——即公开构建页面。访客无需账号即可查看，仅在提交、点赞或评论时需登录。 |
| `modeGroupLabel`                          | Project access mode                                                                                                                                                            | 项目访问模式                                                                                             |
| `subtitle` (changed)                      | Control who can open {projectName}. Workspace Managers always can.                                                                                                             | 控制谁可以打开 {projectName}。工作区管理者始终可以。                                                     |
| `accessSubheading` (changed)              | Who in the {workspaceName} workspace can open this project.                                                                                                                    | {workspaceName} 工作区中谁可以打开此项目。                                                               |
| `publicUnavailable`                       | Publishing runs on Motir Cloud — this self-hosted install has no public site to publish to.                                                                                    | 公开发布依赖 Motir Cloud——此自托管实例没有可发布的公开站点。                                             |
| `membersOnlyConfirmTitle`                 | Make {projectName} members only?                                                                                                                                               | 将 {projectName} 设为仅限成员？                                                                          |
| `membersOnlyConfirmBody`                  | {count, plural, one {<b># person</b> will lose access} other {<b># people</b> will lose access}}. They have Full access to {workspaceName} but were not added to this project: | <b>{count} 人</b>将失去访问权限。他们拥有 {workspaceName} 的完全访问权限，但未被添加到此项目：           |
| `membersOnlyConfirmHint`                  | Add anyone who should keep access first, or add them afterwards. Managers always keep access.                                                                                  | 如需保留某人的访问权限，请先添加，或之后再添加。管理者始终保有访问权限。                                 |
| `membersOnlyConfirmNobody`                | Nobody loses access — everyone who can open {projectName} today was added to it or is a Manager.                                                                               | 没有人会失去访问权限——目前能打开 {projectName} 的每个人都已被添加或是管理者。                            |
| `membersOnlyConfirmAction`                | Make members only                                                                                                                                                              | 设为仅限成员                                                                                             |
| `modeChangedToast`                        | {projectName} is now {mode}                                                                                                                                                    | {projectName} 现为{mode}                                                                                 |
| `changeAccessErrorBody`                   | {projectName} is still {mode}. Please try again.                                                                                                                               | {projectName} 仍为{mode}。请重试。                                                                       |
| `membersFromWorkspaceRole` (changed)      | People added to this project. They can always open it, whatever the access mode. What each can do comes from their workspace role.                                             | 已添加到此项目的人。无论访问模式如何，他们始终可以打开它。每人能做什么取决于其工作区角色。               |
| `addPeople` / `addPeopleSearch`           | Add people… / Search people…                                                                                                                                                   | 添加人员… / 搜索人员…                                                                                    |
| `addPeopleFoot`                           | Workspace members who are not added yet. Managers enter every project anyway.                                                                                                  | 尚未添加的工作区成员。管理者本来就能进入每个项目。                                                       |
| `alwaysEnters`                            | always enters                                                                                                                                                                  | 始终可进入                                                                                               |
| `scope.full` / `scope.limited`            | Full / Limited                                                                                                                                                                 | 完全 / 受限                                                                                              |
| `emptyMembersOnlyTitle` / `…Body`         | Only Managers can open this project / It is members only and nobody has been added yet. Add people to let them in.                                                             | 只有管理者可以打开此项目 / 此项目仅限成员，且尚未添加任何人。添加人员即可让他们进入。                    |
| `readOnlyModeNote`                        | Only a workspace Manager can change who can open this project.                                                                                                                 | 只有工作区管理者可以更改谁能打开此项目。                                                                 |

**Retired** once no call site names them: `access.level.*`, `access.levelDesc.*`, `access.goPrivateNote`,
`access.levelGroupLabel`, `access.levelChangedToast`. Everything else on the page is shipped copy.

### What each control is, and which card specifies its behaviour

| Element                                   | Behaviour specified by                                 | Builds it  |
| ----------------------------------------- | ------------------------------------------------------ | ---------- |
| The three-mode radio cards, saving/failed | MOTIR-6544 (`PATCH …/access { accessMode }`)           | MOTIR-6550 |
| The Members-only confirm (A2 / A3)        | MOTIR-6544 (the preview read)                          | MOTIR-6550 |
| Who the mode admits                       | MOTIR-6543 (`canEnter`)                                | —          |
| Add / Remove people                       | shipped `addMember` / `removeMember` (`member:manage`) | MOTIR-6550 |
| Role + scope chips on each row            | MOTIR-6545 (`accessScope` on the workspace member DTO) | MOTIR-6550 |
| Public + the build-in-public dialogs      | MOTIR-6544 (the two dialogs' call sites)               | MOTIR-6550 |

### GIVES / TAKES — every card this design names

- **MOTIR-6550** — TAKES panels A1–A11. Amended on the record: the mode control is the shipped radio-card
  markup (no `RadioGroup` primitive exists), and Public's self-hosted explanation is NEW copy.
- **MOTIR-6551** — TAKES the whole workspace delta (W1–W11). Amended: the invite's project picker is the
  shipped `MultiSelectPicker`, and the migration notice gains two sub-heads, a widened title and an _Open
  project access_ action per access row.
- **MOTIR-6548** — TAKES the whole shell delta (S1–S4). Amended: the top bar's **Create** is not rendered
  when there is no active project.
- **MOTIR-6544** — GIVES A2 its list. Amended: each preview row carries the person's workspace role (or
  custom role name) so the confirm can show it.
- **MOTIR-6545** — GIVES W1 `accessScope` + `addedProjectCount` and W5's refusal; TAKES nothing drawn.
- **MOTIR-6546** — GIVES W7–W9 their rules (Manager-only Limited, Limited members cannot invite); TAKES nothing drawn.
- **MOTIR-6542** — GIVES W10 its `project_access_lost` rows; TAKES nothing drawn.
- **MOTIR-6543** — GIVES every "who can open" sentence its meaning; TAKES nothing drawn.
- **MOTIR-6170** (the Visitor) — Public's description names the Visitor's arrival; its chrome is that story's.
- **MOTIR-6456** — amended, not edited: its 3a–3c people list gains chips here, and its access-card stub is
  what A1 replaces.

### Tokens &amp; a11y

Colour is `--el-*` only (`--el-build-*`, `--el-chip-*`, `--el-warning-surface` and `--el-icon-muted` are
`packages/design-system/theme.css`'s own, declared in each mock's token block); shape through
`--radius-card/-input/-control/-badge/-btn/-modal`, `--height-control/-input/-btn-md`,
`--spacing-card-padding/-control-x/-control-y/-chip-*`, `--shadow-card/-elevated/-modal`. Secondary ink is
`--el-text-secondary` everywhere — the shipped `text-(--el-text-muted)` descriptions under each mode are
drawn secondary, since they sit on white only while unselected. The mode control is a `radiogroup` of
`radio`s with `aria-checked`; the disabled Public card carries `aria-disabled` and its reason in text. The
confirm is a `dialog` whose initial focus is Cancel.

### What this design does NOT decide

Who may be added (every workspace member, as today); whether a project can be switched to Public by
anyone but a Manager (it cannot — `project:manage_access`); the Visitor's own chrome (MOTIR-6170); and
dropping `access_level` from the schema (MOTIR-6554).

## Approvals — the Review agent switch — `approvals--review-agent.mock.html` (MOTIR-6816)

A DELTA of `design/projects/approvals.mock.html` (§ ⭐ Approvals, panels 0–3 and 6–8), for Story
MOTIR-1626 (9.8, the review agent). It adds ONE card to the Approvals room; the room, its rail row and
its two cards are unchanged and drawn only as context, as they ship at motir-core `origin/main`
`351724043`.

**Revised 2026-09-29 after the design gate sent the first version back** (Yue: _"Review agent on and
Merge automatically can't be true at the same time"_). The first version drew the switch ON in an
`auto` project; this one draws the two settings EXCLUDING each other (panel 2), per
`docs/decisions/approval-gates.md` §12.2a. Behaviour: `docs/decisions/approval-gates.md` §12 (MOTIR-6815). Built by MOTIR-6823.

### Placement and access path

- **Project settings › Work › Approvals** — the existing rail row (base mock panel 0). No new route,
  rail row or registry entry.
- The card is the room's **third**, after _Merging pull requests_, because its copy reads the merge mode
  above it. Anchor **`#review-agent`**, so the Development frame's settings door (MOTIR-6817) lands on
  it the way `#merge-mode` and `#acceptance-video` are landed on.
- **Manage-only, and no read-only state.** The room admits only `workflow:manage` (base mock panel 4,
  withdrawn 2026-09-13; MOTIR-5393 / MOTIR-5394), so whoever renders the card may change it — exactly
  as its two siblings render. The card asked for a read-only state "matching how the two existing cards
  render it"; they render none, so none is drawn.

### Primitives (no new primitive)

| element                  | primitive / token                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| the card                 | `Card` (header / body / footer), composed as `AcceptanceVideoGateCard`                                                         |
| title + glyph            | `h2` `--el-text`, lucide `Bot` `size-4` beside it, as `PrMergeModeCard` carries `GitMerge`                                     |
| description              | `--el-text-secondary`, `text-sm`; the merge-mode moment in `<strong>`                                                          |
| state name / state gloss | `--el-text` `font-medium` / `--el-text-secondary` `text-xs` — a NAME and a CONSEQUENCE, as the acceptance card                 |
| switch                   | `Switch`, `aria-label` = the title; disabled while saving (`isPending`)                                                        |
| footer                   | two lines on `--el-surface-soft`, `--el-text-secondary`: `Sparkles` + the billing line; `Info` + the switch-off note (ON only) |
| saved / refused          | the shipped `useToast` success / error toasts, with the room's own strings                                                     |

### States (panels)

0. **The room** — three cards, Review agent OFF (the default for every project).
1. **ON** — only possible while the project asks before merging: "before you are asked to approve".
2. **The exclusion** (§12.2a). **2a** — the project merges automatically: the card reads
   **Unavailable**, its switch is off and disabled, and the gloss says to choose _Ask before merging_
   first. **2b** — the review agent is on: _Merge automatically_ is disabled (dimmed, `aria-disabled`),
   keeps its label and hint, and adds one line saying to turn the review agent off first. Neither control
   changes the other for the person; the server refuses the same two writes
   (`409 REVIEW_AGENT_NEEDS_MANUAL_MERGE` / `409 MERGE_MODE_REVIEW_AGENT_ON`), which a racing stale page
   meets as panel 6's refused state. Both cards read the project's CURRENT pair on the page (the room's
   existing `projectPrMergeModeService` read plus this switch), and flipping one re-renders the other.
3. **OFF** — the gloss says what happens instead (the ordinary flow).
4. **Saving** — optimistic flip, switch disabled while `PATCH /api/projects/[key]/approval-gates`
   (`{ reviewAgentEnabled }`) is in flight. No spinner.
5. **Saved** — success toast.
6. **Refused** — the switch is put BACK to the server's value, error toast.

The switch-off note shows only while ON. It is true because switching off supersedes every awaiting
review and cancels its run (`approval-gates.md` §12.5). Switching ON asks nothing of a card that already
holds an approve-and-merge gate (§12.5); no copy is needed for that, because nothing visible changes on
those cards.

### Strings — `approvals.reviewAgent.*`

| key               | en                                                                                                                                                                                                                                                                                                               | zh                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | Review agent                                                                                                                                                                                                                                                                                                     | 审查代理                                                                                                                                                                                 |
| `desc`            | When a card's pull requests pass their checks, a Motir agent reads the change against the card — its description, acceptance criteria and How to test — **before you are asked to approve it**. If it finds a problem, the card goes to **To fix** with the agent's findings, and nobody is asked to approve it. | 当卡片的拉取请求通过检查后，Motir 代理会对照卡片——它的描述、验收标准和测试方法——审查这次变更，**然后才会请你批准**。如果发现问题，卡片会带着代理的发现进入**待修复**，不会请任何人批准。 |
| `on`              | On                                                                                                                                                                                                                                                                                                               | 已开启                                                                                                                                                                                   |
| `off`             | Off                                                                                                                                                                                                                                                                                                              | 已关闭                                                                                                                                                                                   |
| `onWhat`          | Every card is reviewed before you are asked to approve it.                                                                                                                                                                                                                                                       | 每张卡片都会先经过审查，然后才会请你批准。                                                                                                                                               |
| `offWhat`         | A card is offered for approval as soon as its checks pass.                                                                                                                                                                                                                                                       | 卡片的检查一通过，就会提交给你批准。                                                                                                                                                     |
| `unavailable`     | Unavailable                                                                                                                                                                                                                                                                                                      | 不可用                                                                                                                                                                                   |
| `unavailableWhat` | This project merges automatically, so nothing waits for a review. Choose **Ask before merging** to turn the review agent on.                                                                                                                                                                                     | 该项目会自动合并，因此没有需要等待审查的内容。请选择**合并前询问**以开启审查代理。                                                                                                       |
| `billingNote`     | Each review is a hosted agent run, paid from your organisation's AI credits.                                                                                                                                                                                                                                     | 每次审查都是一次托管代理运行，费用从你组织的 AI 额度中扣除。                                                                                                                             |
| `offNote`         | Turning this off cancels reviews in progress — those cards go straight to the ordinary flow.                                                                                                                                                                                                                     | 关闭后，进行中的审查会被取消——这些卡片将直接进入常规流程。                                                                                                                               |
| `saved`           | Saved                                                                                                                                                                                                                                                                                                            | 已保存                                                                                                                                                                                   |
| `saveError`       | Couldn't save — try again.                                                                                                                                                                                                                                                                                       | 保存失败，请重试。                                                                                                                                                                       |

**One new string on the merge-mode card** — `approvals.mergeMode.auto.blockedByReviewAgent`: en
"Turn the review agent off to merge automatically." · zh "关闭审查代理后才能自动合并。"

`To fix` / `待修复` must match the Workbench tab's own string when MOTIR-6823 builds it — read
`messages/*.json`, and use that tab's word if it differs.

### What this design does NOT decide

The Development frame, To fix and Workbench states (MOTIR-6817); what the review does (`approval-gates.md`
§12, `hosted-agent-run.md` §8); an organisation with no AI credits, which is a per-review outcome drawn in
the frame (_Review could not run_), not a state of this switch.

## ⭐ The DESIGN APPROVAL switch — a third card in the Approvals room (Story MOTIR-693 · MOTIR-694 — `approvals--design-gate.mock.html`, DATED 2026-09-29)

Amends § ⭐ Approvals and `approvals.mock.html` (not edited). The decision is
`docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §2 (MOTIR-695).

- **Reached from:** Project settings → Approvals (`/settings/project/approvals`), manage-only; anchor `#design-approval`.
- **Placement:** between _Acceptance video approval_ and _Merging pull requests_.
- **Grammar:** the sibling `AcceptanceVideoGateCard`'s — a `Card` header (title + description), then the state NAME and
  its one-line CONSEQUENCE beside a `Switch`. No entitlement footer: this switch needs no plan.
- **No read-only state:** the room is manage-only (§6 above, 2026-09-13), so no actor below `workflow:manage` renders it.

The full spec — every copy string, token and suggested key, and the two item-page deltas the same story draws — is
`design/work-items/design-notes.md` § ⭐ Design review without a babysitter.

## Public address — the subdomain card becomes a read-only workspace echo (Story MOTIR-4528 · Subtask MOTIR-9513)

**Amends** the `# Public address` section above and its mock
[`public-address.mock.html`](public-address.mock.html), panels 1, 2, 8 and 10–13
(the workspace-subdomain card). The custom-domain panels are unchanged. The delta
is [`public-address--workspace-echo.mock.html`](public-address--workspace-echo.mock.html),
panels A–C.

The control for the workspace's name moved to workspace settings
(`design/workspace-address/`, whose `design-notes.md` carries the elements, the
strings and the list of what the old card showed that is gone). The project page
keeps an **echo card** titled `Workspace address`: the workspace host with Copy
and open, the project's own public page (`motir.co/p/<KEY>`), and
`Change in workspace settings →`; or, with no name claimed, the project's
`motir.co/p/<KEY>` and `Claim a name for the workspace →`. No field, Rename or
Release, for any role. Strings: `settings.workspaceAddress.echo.*`.
