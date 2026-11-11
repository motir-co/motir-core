# Notifications — design notes

Design reference for the `notifications` UI area (Story 5.7 — in-app
notifications), **extended 2026-09-10 by Story MOTIR-5010 · MOTIR-5012 with the
ACCESS-REFUSED row** (its own section below — the first notification whose
subject is a PROJECT and whose actor is nobody). Each surface names the design asset it lives in, the primitives
it composes from, copy strings, placement, and the decisions a code subtask
must honour. Produced by **Subtask 5.7.1** (the design subtask that gates the
UI code subtasks **5.7.5** the bell + drawer and **5.7.6** the preferences
page).

Every asset is an HTML mockup built FROM the shipped design system
(`components/ui/*` primitives' markup + the `app/globals.css` `--el-*` colour
tokens + the element-semantic shape tokens), so there is no Pencil→code gap —
the reviewer and the code subtask see the same tokens. Tokens are copied 1:1
from `app/globals.css`; colour flows only through Tier-3 `--el-*`, shape only
through the element-semantic radius / spacing / sizing / shadow tokens. Toggle
dark in any mockup for theme parity.

| Surface                                     | Asset                                 | Notes                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Header notification bell + unread badge** | `bell.mock.html` + `.png`             | The shell-header bell + the unread/_seen_ count pill. Gates 5.7.5. `design/shell/desktop.pen` draws the TopNav but no bell. See below.                                     |
| **Notification drawer / feed**              | `drawer.mock.html` + `.png`           | The header-anchored popover the bell opens: Direct/Watching split, per-row read state, mark-all, cursor-paged feed. Gates 5.7.5. See below.                                |
| **Notification preferences (settings)**     | `preferences.mock.html` + `.png`      | The per-user × event-type × channel matrix on `/settings/account` — the channel gate both the in-app job (5.7.3) and the email job (5.1.6) honour. Gates 5.7.6. See below. |
| **Preferences — page replies (delta)**      | `preferences--page-replies.mock.html` | Amends Panel 0 of the preferences mock: the Commented row and the defaults note name page replies (MOTIR-10868). See § Page replies in the Commented row.                  |

**Mirror-product anchor (decision-ladder rung 1, verified at plan time in the
5.7 story module — Atlassian + Linear sources, not memory):** the Jira Cloud
header notification bell + drawer (Direct/Watching split, unread blue-dot,
"Mark all as read" in the overflow) and the Jira _Personal settings →
Notification settings_ page; Linear's Inbox is the feed-model cross-check
(per-row read state, a per-row toggle, keyboard-navigable, deep-link on open).
Motir mirrors the _model_ at Jira's _altitude_ — a header bell + popover, not a
separate Inbox route.

---

## Notification bell + unread badge (Story 5.7 · 5.7.1 → 5.7.5)

`design/shell/desktop.pen` draws the TopNav (workspace switcher · Create ·
Search · theme · user menu) but **no bell and no badge** — whole elements no
design specifies, so this mockup (`bell.mock.html`) is the design asset. Code
subtask 5.7.5 composes the same primitives.

### Placement

The bell mounts in **`TopNav`'s right cluster**, between the `ThemeToggle` and
the `UserMenu` (`app/(authed)/_components/TopNav.tsx`). On the collapsed
desktop rail and inside the off-canvas mobile `SidebarDrawer` it renders
icon-only, beside the project-context affordance `SidebarHeader` already owns
(panel 2).

### Anatomy

- **The bell** is an **`IconButton`** — the same affordance the Search / theme
  controls use: `rounded-(--radius-control)` + `p-(--spacing-icon-btn)`, text
  `--el-text-muted`, hover lifts to `--el-text` over an `--el-surface` wash.
  The 20px lucide `Bell` glyph. The open (drawer-anchored) state shows the
  pressed `--el-surface` background.
- **The count pill** (the "badge") is anchored top-right of the bell in the
  `Pill`/`Badge` grammar: `--radius-badge` + the small chip padding,
  **`--el-accent` fill with `--el-accent-text`** (white), `min-width: 16px`,
  10px/700 text, and a 2px `--el-page-bg` ring so it reads on the header
  surface. **Decision — accent, not danger.** A "you have N new" count is not
  an error, so the fill is the brand accent (purple), NOT `--el-danger` red;
  accent is on-brand, AA in both themes (white on purple), and avoids the
  finding-#54 grey-everything trap.

### Badge states (panel 1)

- **Zero** → no pill at all.
- **1–99** → the count (e.g. `3`).
- **99+** → capped at `99+` (the Jira/GitHub cap).
- **Open** → the badge is **cleared** (the bell shows its pressed state).

### The seen-vs-read distinction (load-bearing)

The badge counts **NEW notifications since the drawer was last opened**; opening
the drawer marks them **seen** and the badge clears (the Jira "seen-since-open"
rule). This is **distinct from per-row `read` state** (the blue-dot in the
drawer): a row can still be unread (its dot showing) _after_ the badge has
cleared. The schema (5.7.2) and services (5.7.4) model BOTH — a cheap indexed
unread-count aggregate for the badge, and a per-row `readAt` for the dot +
mark-read. The accessible name carries the live count
(`"Notifications, 3 unread"`) so the number is announced, not colour-only.

### Copy

- Bell accessible name: `Notifications, {n} unread` (`Notifications, no unread`
  at zero).
- Badge cap: `99+`.

---

## Notification drawer / feed (Story 5.7 · 5.7.1 → 5.7.5)

`drawer.mock.html` is the header-anchored popover the bell opens (a sheet on
mobile). Code subtask 5.7.5 composes the same primitives on the 5.7.4 read/mark
API.

### Container + header

A **`Popover`** container — `--radius-card`, `--shadow-elevated`, hairline
`--el-border`, ~384px wide, `align="end"` under the bell. The header row = the
**"Notifications"** title (`--el-text`, 15px/600) + the **overflow** three-dots
`IconButton`. Below it a **`Segmented`** control: **Direct** (default, carries
the unread count) | **Watching**.

### Direct vs Watching (the 5.4 seam)

**Direct** = the actions involving you (mentioned · assigned · reporter — the
"mentions first" set), shipped in 5.7. **Watching** is drawn **disabled** (the
`is-disabled` segment grammar 2.5.3 used for the view-switcher seam, with a
`title` tooltip) because issue-watching's `work-item/transitioned` event is
**Story 5.4's**; the 5.7.3 fan-in consumer is built to populate it with **no
5.7 change**.

### Notification row anatomy

Each row is a horizontal flex:

- **Leading unread dot** — an 8px `--el-accent` dot (Jira's "blue-dot"; Motir
  uses one accent unread signal shared with the badge). On a read row the dot
  is transparent (the gutter is preserved so rows align).
- **Avatar + event-type glyph** — the initial-letter `Avatar` (30px, `--el-text`
  fill, `--el-text-inverted` letter) with a small **event-type glyph** badge at
  its bottom-right taking the **event's hue** (finding #54: the palette, not
  grey): mention → `--el-accent` + `@`, comment → `--el-type-task` + message,
  assigned → `--el-type-story` + user-check, transitioned → `--el-type-subtask`
  - pull-request. White glyph on the hue fill, a `--el-page-bg` ring.
- **Body** — line 1 = the one-line summary (actor + action + issue key, actor &
  key in `--el-text-strong`) with the **relative time** pushed right (absolute
  on hover/`title`); line 2 = the denormalized excerpt, single-line truncated.
- **Read treatment** — read rows persist in the feed (NOT purged): greyed via
  `--el-text-secondary`/`--el-text-faint`, no dot (the summary was
  `--el-text-muted` until MOTIR-4255 — 4.17:1 once the row takes its `:hover`
  tint, which is the state a row being read is in). Unread rows take a faint
  `--el-surface-soft` wash.

**Clickable target + the no-nested-interactive rule.** The whole row is ONE
clickable deep-link to `/items/[key]`. The per-row hover **mark-read toggle**
(the Linear `U` model) is a **SIBLING control overlaid top-right — NOT nested
inside the link** (the nested-interactive / portal-popover lessons): in markup
the `<a class="n-row">` and the `<button class="n-toggle">` are siblings under a
`position: relative` wrapper. Clicking the row body also marks it read.

### Overflow menu (panel 3)

The three-dots opens the `IssueViewSwitcher` overflow-menu vocabulary
(`--radius-card` + `--shadow-elevated` container, `--radius-control` rows):

- **Mark all as read** (check-check glyph) — a **single server operation** over
  the caller's whole unread set (a bulk `updateMany` in 5.7.4), NOT a client
  loop over rendered rows (that loop is the JRACLOUD-85017 bug where reload
  re-shows the dots). After it runs every dot clears and the count returns 0
  **from the mutation response** (no whole-tree refresh — the
  inline-edit-no-tree-refresh memory).
- **Notification settings** (gear glyph) — deep-links to `/settings/account` →
  Notifications (`preferences.mock.html`).

### Feed states (panel 4) + scale (panel 5)

- **Loading** → the `BacklogSkeleton` pulse (avatar circle + two `--el-muted`
  lines per row).
- **Empty** → the inbox glyph + **"You're all caught up"** / "No notifications
  yet. Mentions, comments, and assignments will land here." — inviting, never
  blank.
- **Error** → the `ErrorState` alert glyph + **"Couldn't load notifications"** +
  a **"Try again"** `Button variant="secondary"`, `role="alert"`.
- **Scale (finding #57)** → the feed is **cursor-paginated** — newest 20, body
  scrolls within a bounded max-height, **"Show more (N older)"** at the older
  edge pages the next window. Never a load-all; the badge count is the cheap
  indexed unread aggregate (5.7.2's partial index).

### Copy

- Title: `Notifications`. Tabs: `Direct` · `Watching`. Overflow: `Mark all as
read` · `Notification settings`. Older edge: `Show more` / `Show more (N
older)`. Empty: `You're all caught up` / `No notifications yet. Mentions,
comments, and assignments will land here.` Error: `Couldn't load
notifications` / `Something went wrong fetching your feed.` / `Try again`.
- Row summaries: `{Actor} mentioned you on {KEY}` · `{Actor} commented on
{KEY}` · `{Actor} assigned you {KEY}` (· later: `{Actor} moved {KEY} to
{Status}` for the Watching/transitioned event).

### A11y

The bell is a labelled button announcing the count; the drawer is a
keyboard-navigable feed/list; read state is conveyed as text + dot, not colour
alone; focus returns to the bell on close; **no nested interactive elements
inside a row** (the toggle is a sibling). The strict axe sweep covers the
header with the drawer open.

---

## Notification preferences (Story 5.7 · 5.7.1 → 5.7.6)

`preferences.mock.html` is the per-user notification-preferences section. Code
subtask 5.7.6 composes the same primitives + the `NotificationPreference` model
behind it.

### Placement

A **`Card`** (the `ContentSectionCard` `<h2>`-header grammar `LanguageCard` /
`NameCard` use) on the existing **`/settings/account`** personal-settings area,
beside the Language card.

### The matrix

A grid: **rows = event types**, **columns = the two channels (Email · In-app)**,
each cell a **`Switch`** (`role="switch"`, `--el-accent` track on, `--el-muted`

- `--el-border-strong` off, the `--el-surface` knob with `--shadow-subtle`).
  Column header labels (`EVENT` · `EMAIL` · `IN-APP`) in the faint uppercase
  mono-label grammar over an `--el-border` rule; rows divided by `--el-border-soft`.

Event rows (the Jira personal-notification-settings set, generalized):

- **Mentioned** — "Someone @-mentions you in a comment or description."
- **Commented on an item you're involved in** — "A new comment on an item you
  reported, are assigned, or commented on."
- **Assigned to you** — "An item is assigned to you."
- **An item you're watching changes status** `[Soon]` — drawn **disabled** (the
  Story 5.4 seam, the same seam the drawer's Watching tab draws). "Available
  once issue-watching ships (Story 5.4)." The `Soon` tag is a `--radius-badge`
  pill in `--el-tint-lavender` + `--el-text-strong` (AA-safe — hue in the tint
  bg, strong text, finding #35).

### Defaults (annotated)

Direct events — mentions, comments on your items, and assignments — **default
on for both channels**. An untouched row uses that default: **the resolver
supplies it (an unset row is NOT "off")**, so the matrix already reflects
"direct events on" without writing a `NotificationPreference` row. Recorded in
the footnote under the matrix.

### The channel gate (load-bearing)

The resolved preference is the **single channel gate** consulted by BOTH the
**5.7.3 in-app job** (`in_app` channel) AND the **DONE 5.1.6 email job**
(`email` channel) — 5.7.6 wires the gate at the email job's _send decision_,
touching no emit site (the event still fires once). Toggling **in-app off**
stops the bell row; toggling **email off** stops the mail — both off the same
matrix.

### Inline status (panel 1) — success IS confirmation

Each toggle is an inline mutation through a Server Action. The **success
response IS the confirmation** — the switch stays where the user put it, with
**no `router.refresh()` / `revalidatePath` whole-tree fan-out** (the
inline-edit-no-tree-refresh memory; the fan-out is what caused the revert bug).
A transient **"Saved"** (`--el-success` check) confirms; **"Saving…"** shows a
spinner; on failure the switch reverts to its prior position and an inline
**"Couldn't save · Retry"** (`--el-danger` + a `--el-link` Retry) appears.

### Copy

- Section header: `Notifications`. Helper: `Choose how you're notified for each
kind of update. These apply to you across every workspace.`
- Columns: `Email` · `In-app`. Status: `Saving…` · `Saved` · `Couldn't save` /
  `Retry`.

### A11y

Each switch carries an explicit `aria-label` naming its event + channel (e.g.
`Email for Mentioned`) so the matrix is fully screen-reader-legible; disabled
rows carry `aria-disabled`.

---

## The ACCESS-REFUSED row (Story MOTIR-5010 · MOTIR-5012 → the code card it gates)

**The one access outcome nobody else tells the user about: GitHub refused the
collaborator invitation.**

Every other outcome already has a carrier. An invitation that SENDS is carried by
GitHub's own email, straight to the account it names. An identity that was never
connected is carried by the plan review rail's `needs_access` outcome and by
`/settings/project/code-access`. **A refusal has neither**: no email left the
building, and the user has private code they cannot reach with nothing on any
screen saying so. Verified at rung 2 rather than assumed —
`projectRepoAccessService`'s `inviteOne` catch is a `console.error` and a
`return false`, deliberately, so the pass survives one member of one row failing.
That log line is currently the only record.

### ⚠️ The RULE, so the next person adding an access state has one rather than a precedent

**A notification is owed exactly when NO other carrier reaches the user.** Not
when something failed, and not when something is important: an invitation that
sends is GitHub's email to tell, and an identity that was never connected is the
rail's outcome and the code-access surface to tell. A refusal is the only state
with no carrier at all, which is why it is the only one that gets a row.

### Why it is a drawn row and not a string

`app/(authed)/_components/NotificationRow.tsx` renders a row from three
type-keyed things — `summaryKey(type, hasKey)`, `TYPE_META[type]` (glyph +
`--el-notif-*` hue), and `DEFAULT_META` for an unmodelled type. **A new type is a
new drawn row.** And it is the first one in the product whose subject is a
**project** and whose actor is **nobody**: the four modelled types
(`mentioned` · `commented` · `assigned` · `transitioned`) are all work-item
events with a human actor, so the avatar, the actor line and the summary grammar
each need a decision rather than an inherited default. Left to be filled in while
wiring, the two absences become a blank avatar and an actor line reading as
though somebody did this to you.

### The four decisions

| Axis            | Decision                                                                                                                                        | Why, and what was rejected                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Glyph**       | lucide **`shield-alert`**                                                                                                                       | The row is about a permission that did not land. **`user-x` rejected** — it reads as a PERSON being removed from the project. **`key-round` rejected** — a key reads as access you HAVE                                                                                                                                                                                                                        |
| **Hue**         | **`--el-notif-access-refused`** → `--color-warning` (a NEW token, added to theme.css's `--el-notif-*` block by the code card)                   | The same hue the review rail's `needs_access` outcome and `design/repository-set/`'s panel-2 arm B already use, so one product story is told in one colour. **Not `--el-danger`**: nothing was lost or destroyed — the repository exists and the plan is safe; the user simply cannot open it yet. It is a NEW slot rather than a reused `--el-notif-*` because none of the four existing hues means "blocked" |
| **Actor**       | **None, and the row says so by SHAPE**: the type glyph is promoted into the 30px avatar slot in the event's hue, and the small badge is dropped | No initial letter, no borrowed face. `NotificationRow`'s `actorFallback` string is **NOT** used — a fallback name puts a fictional actor into the summary grammar, which is the failure this decision exists to prevent                                                                                                                                                                                        |
| **Destination** | **`/settings/project/code-access`** for the project the row names                                                                               | Not `/items/[key]` — there is no work item. `Notification.workItemId` is nullable and this row has none                                                                                                                                                                                                                                                                                                        |

### What the code card owes beyond a new `TYPE_META` entry

**The shipped row routes on `issueKey !== null`**, falling to a non-navigating
`<button>` and `summary.genericNoKey` when there is none. This type has no issue
key and DOES navigate, so:

- `NotificationDTO.data`'s discriminated union gains an arm carrying the
  project's key and name;
- `NotificationRow`'s destination is resolved from the **TYPE**, not from the
  presence of an issue key;
- `summaryKey` gains a case that does not depend on `hasKey`.

Each is a consequence of this being the first project-subject row. None of them
is drawn here because none of them is pixels.

### Copy

**Summary** (`summary.accessRefused`), with the project name bolded through the
existing `<s>` rich-text tag:

> **{Project}**'s code is ready, but you can't open it yet — try sending the
> invitation again

It reads as a **consequence** and a **remedy**. It names no GitHub status code,
no credential, no billing state and no internal cause — a user who cannot open
their repository does not need to know which API call returned what; they need to
know they are blocked and what to press. The remedy is also WHERE THE ROW GOES,
which is why one sentence is enough.

**No excerpt line.** The shipped row renders one only for `kind === 'mentioned'`,
and this row has nothing to quote.

**Preferences matrix row:** label `Code access couldn't be granted`, description
`Motir couldn't give you access to a repository it made for your project.`

### Placement in the preferences matrix

**LAST — the fifth row**, which is where `NOTIFICATION_PREFERENCE_EVENT_TYPES`'
array order puts it: the matrix renders that array, and a new member is appended
rather than sorted in, so the four rows above keep the positions users have
learned. **Settable** (not a seam), defaulting **ON for both channels** like every
other direct event.

**Email ON is a decision, not an oversight.** This event exists because GITHUB's
invitation email never left the building. Motir's own notification email is a
second, independent carrier, and defaulting it off would re-create exactly the
silence the row was added to end. It stays the user's to turn off.

### The bell — CHECKED, and UNCHANGED

`bell.mock.html` and `bell.png` are **not edited**, and that is the deliverable
rather than an omission. The badge is a **count of unread notifications**, with no
per-type branch anywhere in its anatomy: the pill renders `n`, caps at `99+`,
takes `--el-accent` because a count is not an error, and clears on open. A fifth
type changes none of that — it changes what `n` counts, which is the number the
badge was already rendering. **The one thing worth stating explicitly**: the badge
stays `--el-accent` even though this type is the first whose own hue is a warning.
Per-type tinting of a shared count would be a lie about the other four rows behind
it.

### A11y

- The summary carries the whole message as **text** — the warning hue is on the
  avatar glyph only, so nothing about this row is conveyed by colour alone.
- The promoted glyph is `aria-hidden` like every other avatar in the feed; it is
  decoration over a sentence that already says everything.
- White (`--el-accent-text`) on `--color-warning` is the same ink/fill pair the
  existing badges use on their hues, and the badge is a **graphic** rather than
  text, so **1.4.11** (3:1 non-text contrast) is the bar it must clear against the
  row surface — not 4.5:1. The `--el-page-bg` ring the badge grammar already
  carries is what guarantees it against both the `--el-surface-soft` unread wash
  and the `--el-surface` hover tint.
- Both preference switches carry an explicit `aria-label` naming event + channel,
  as every other cell does.

---

## Tokens / primitive inventory (what 5.7.5 + 5.7.6 reuse — invent nothing)

- **`IconButton`** — the bell + the drawer overflow + the per-row toggle.
- **`Pill`/`Badge`** — the bell count pill (`--el-accent`) + the `Soon` seam
  tag (`--el-tint-lavender` + `--el-text-strong`).
- **`Popover`** — the drawer container + the overflow menu (`--radius-card` +
  `--shadow-elevated`).
- **`Segmented`** — the Direct/Watching filter (with the disabled-segment seam).
- **`Avatar`** — the actor initial-letter circle; the event-type glyph badge
  takes `--el-accent` / `--el-type-{task,story,subtask}`.
- **`Card` (ContentSectionCard)** + the `<h2>` settings-card header grammar.
- **`Switch`** — the preferences matrix cells.
- **`Button variant="secondary"`** — the drawer error "Try again".
- **`BacklogSkeleton`** pulse · the inbox **empty state** · **`ErrorState`** ·
  the **"Show more"** ghost edge.
- **New token need for 5.7.5/5.7.6:** none. Every colour resolves to an existing
  `--el-*` and every shaped surface to an existing element-semantic shape token;
  no Tier-0 `--color-*` and no raw `rounded-*` / fixed control padding are used.

## Page replies in the Commented row (Story MOTIR-10868 · MOTIR-10931)

**Amends** § Notification preferences above, and Panel 0 of
`preferences.mock.html`. The change is drawn in
**`preferences--page-replies.mock.html`**, which holds only the panel that
changes. The older mock and its `preferences.png` are left as the record of
Story 5.7. Per `docs/decisions/design-result.md` AMENDMENT 4, no new export is
made.

**Why it changes.** Story MOTIR-10868 sends a reply in a page discussion through
the existing `commented` preference: the row's two switches now also gate the
`page_replied` notification. So the row has to name both subjects it gates, and
the defaults note has to list the new direct event. No default changes: the row
was already on for both channels.

**The three strings,** each read from `messages/en.json` and drawn verbatim:

- **Label** (`settings.account.notifications.events.commented.label`) —
  "Comments on your items or in your page discussions". It replaces "Commented
  on an item you're involved in" in the event-row bullet above.
- **Description** (`…events.commented.desc`) — "A new comment on an item you
  reported, are assigned, or commented on — or a reply in a page discussion you
  started or took part in."
- **Defaults note** (`settings.account.notifications.defaultsNote`) — "Direct
  events — mentions, comments on your items, replies in your page discussions,
  and assignments — default on for both channels. An untouched row uses that
  default (it is not off until you turn it off)." The mock keeps its own
  emphasis on **on**. The § Defaults paragraph above reads the same with this
  fourth item added, and the rest of its reasoning still holds: the resolver
  supplies an untouched row's default.

**The switches.** Each switch's accessible name is `cellAria`
(`{channel} for {event}`) over the row's label, so the shipped switches read
"Email for Comments on your items or in your page discussions" and "In-app for
…". The delta mock draws those names. The older mock's shorthand ("Email for
Commented") was never the shipped name.

**Unchanged,** and so not drawn: every other event row, the Watching seam, the
column headers, the switch states, the inline save status (Panel 1) and the
switch closeups (Panel 2). Tokens and primitives are the ones the original mock
draws. The style block is copied unchanged, and colour and shape flow through
the same `--el-*` and element-semantic shape tokens.

**Judged and left:** the plan-seed records in `scripts/plan-seed/data/epics.ts`
and `story-5.7.ts` still print the old label. They are the seeded text of Story
5.7 and are never rendered, so rewriting them would falsify that record.
