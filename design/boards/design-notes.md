# Boards — design notes

Design reference for the `boards` UI area. The asset is the source of truth for
every UI subtask in Story 3.2 (the Kanban board surface). Built FROM the real
design system (`app/globals.css` `--el-*`/shape tokens + the shipped
`components/ui/*` and issue-list primitives), so the code subtasks compose the
same primitives — no Pencil→code gap.

| Surface                                                    | Asset                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kanban board (columns + cards)**                         | **`board.mock.html`** (HTML mockup)                  | The whole board surface — no `design/boards/` asset existed; the 3.2.1 design gate produces this. Multi-panel: board · drag · snap-back · keyboard · scale · unmapped · states · mobile. Gates 3.2.2–3.2.6. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Swimlanes + WIP limits**                                 | **`swimlanes-wip.mock.html`** (HTML mockup)          | EXTENDS the board surface — the 3.2.1 mockup drew a WIP slot only as a NON-enforced placeholder and NO swimlanes / WIP editor / over-limit treatment (unspecified == no design), so the 3.3.1 design gate produces this. Multi-panel: group-by control · swimlanes (assignee/epic/priority + catch-all) · cross-lane drag · WIP config · over-limit · states. Gates 3.3.5–3.3.6. See "Swimlanes + WIP (Story 3.3)" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Board configuration (admin)**                            | **`board-config.mock.html`** (HTML mockup)           | The board ADMIN surface — the column manager + column ↔ status mapping the 3.2.6 unmapped tray points at; NO `design/boards/` asset drew it (the 3.2.1 board mockup is the board itself; its `[⋯]` menu is a disabled seam), so the 3.6.1 design gate produces this. A SIBLING of the Workflow editor (`settings/project/board`). Multi-panel: page · rename/add column · map-by-drag · map-by-keyboard · delete-confirm + guard · read-only · states · cross-links. Gates 3.6.3. See "Board configuration (Story 3.6)" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Board load model (correction)**                          | **`board-scale.mock.html`** (HTML mockup)            | EXTENDS the board surface — CORRECTS the scale UI (notes.html mistake #33). The 3.2.1/3.2.8 scale panel paged columns ("Load more" → auto scroll-to-load); Jira does NOT page a board, so the corrected model (whole bounded set + virtualize + over-cap "refine filter" banner + Done-age window) was unspecified (== no design), so the 3.8.1 design gate produces this. Multi-panel: bounded whole-set load · Done-age window · over-cap banner · swimlanes-sans-footer. Gates 3.8.3 / 3.8.4 / 3.8.5. See "Board load model (Story 3.8)" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Multiple boards (switcher + CRUD)**                      | **`multi-board.mock.html`** (HTML mockup)            | EXTENDS the board surface — the **board switcher** + **create / rename / set-default / delete** board UI. The 3.2.1 board mockup draws a SINGLE default board (its column `[⋯]` a disabled seam); the switcher + board-CRUD surfaces are unspecified (== no design), so the 3.7.1 design gate produces this. Multi-panel: header switcher (closed) · switcher open (active checked · default badged · New board) · manage menu (rename/set-default/delete) · New-board modal · rename modal · delete confirm · last-board guard + one-board state · states + permissions. Gates 3.7.4. See "Multiple boards (Story 3.7)" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Per-board settings (entry + page)**                      | **`per-board-settings.mock.html`** (HTML mockup)     | EXTENDS the 3.6.1 board-config page + the 3.7.1 switcher — makes board SETTINGS **per-board**. The 3.6 admin only configures the project DEFAULT board, and every entry point links there with NO board context; with many boards per project (3.7) each board has its OWN config, so settings must target the SELECTED board. That gap is unspecified (== no design), so the 3.7.7 design gate produces this. Multi-panel: board-scoped settings page (header names the board + switcher) · switcher open (change which board) · manage menu "Board settings" item · cross-links carrying `?board=` · states + permissions. Gates 3.7.8. See "Per-board settings (Story 3.7)" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Scrum board (sprint view)**                              | **`scrum.mock.html`** (HTML mockup)                  | EXTENDS the board surface — the SCRUM variant: the same 3.2/3.3 board scoped to a board's active sprint, under a **sprint header** (name + state · goal-with-reveal · dates + time remaining · committed/completed/remaining points · complete-sprint entry point) + **per-column point totals**. The 3.2.1 board mockup drew the Kanban surface only — the sprint header / points / no-active-sprint state / complete-sprint affordance were unspecified (== no design), so the 4.5.1 design gate produces this. CHROME over the reused board — it does NOT redraw columns / cards / drag / swimlanes / WIP. Multi-panel: full scrum board · sprint-header anatomy (Tooltip reveal) · no-active-sprint EmptyState (→ Backlog) · edge states ("—" unestimated · "Ended" overdue · loading skeleton) · column-header slot coexistence. Gates 4.5.3. See "Scrum board (Story 4.5)" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Board filtering (toolbar Filter)**                       | **`board-filter.mock.html`** (HTML mockup)           | EXTENDS the board surface — wires the permanently-DISABLED `[Filter]` seam (`page.tsx` `filterComingSoon`) into a working board filter, and points the 3.8.4 over-cap banner's "Refine filter" CTA at it. REUSES the shipped /items filter primitives verbatim (`IssueFilterBar` quick popover · `IssueAdvancedFilter`/`FilterConditionBuilder` builder · `SavedFilterDropdown` + `IssueAppliedFilterBar` picker + applied name-chip) — anchored on the BOARD toolbar, board-scoped + URL-addressable. The board mocks draw `[Filter]` only as a disabled seam; the enabled affordance + the on-board composition + the active-filter summary + the filtered/filtered-EMPTY states + coexistence with the 3.3 group-by Segmented and the 3.8 banner are unspecified (== no design), so the 6.15.1 design gate produces this. CHROME over the reused board — it does NOT redraw columns / cards / drag / swimlanes / WIP. **Also adds the NET-NEW Work type facet to the shared `IssueFilterBar`** (the `WorkItemType` field was reachable only via `[Advanced]`; owned by subtask 6.15.5 — benefits `/items` too). Multi-panel: closed · quick-Filter popover open (incl. the Work type facet) · Saved dropdown open · active (summary + re-projected board) · filtered-EMPTY · over-cap coexistence. Gates 6.15.3 / 6.15.5. See "Board filtering (Story 6.15)" below. |
| **Implemented column + status chip**                       | **`implemented-column.mock.html`** (HTML mockup)     | EXTENDS the board surface — the **eighth** default-workflow status (`implemented`, between In Progress and In Review) and the chip it renders as. The board mocks are drawn at six columns and predate `planning` (MOTIR-2425), and the shipped status chip is keyed on the lifecycle CATEGORY, so a new `in_progress`-category status renders byte-identically to In Progress / Planning / In Review — unspecified (== no design), so the MOTIR-3002 design gate produces this. Multi-panel: the board at eight columns · the fold, measured · the chip today · the chip as specified (`--el-status-implemented` + the `CircleEllipsis` glyph) · the three surfaces (list · detail picker · board) · CI at Implemented. Gates MOTIR-3003. See "Implemented — the eighth board column" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Approved column + status chip**                          | **`approved-column.mock.html`** (HTML mockup)        | EXTENDS the board surface — the **ninth** default-workflow status (`approved`, between In Review and Done, in the `in_progress` category) and the chip it renders as. Nothing in `design/` draws a workflow-status `approved`, and `design/boards/` draws the board at EIGHT columns; the shipped chip resolves a tone by KEY with exactly one entry (`implemented`), so a new `in_progress`-category status renders byte-identically to In Progress / Planning / In Review — unspecified (== no design), so the MOTIR-5138 design gate produces this. Multi-panel: the board at nine columns · the fold re-measured against eight · the chip today · the chip as specified with `--el-status-approved` measured across ten palettes · the three other surfaces (list · picker · canvas) · where a ninth status reaches. Gates MOTIR-5139 / MOTIR-5141. See "Approved — the ninth board column" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Swimlane lane paging + per-lane scroll + group-by menu** | **`swimlanes--lane-paging.mock.html`** (HTML mockup) | EXTENDS `swimlanes-wip.mock.html` and `board-scale.mock.html` — the source of truth for the group-by trigger and menu, the lane header band and label rail, the (lane × column) cell with its own paging (cell count, Load more, retry, skeleton states), and the per-lane horizontal scroll (the driven column-header row, the column-name strip, the per-lane column arrow pair). See "Swimlane lanes that page and scroll on their own" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The board is a **pure consumer** of the Story-3.1 board API
(`GET …/board` → `BoardProjectionDto`; `GET …/board/columns/[id]/cards` → the
lazy page; `POST …/board/move` → the moved card). **Moving a card = a workflow
transition, never a board-local write**; illegal drops snap back on the 3.1
typed errors. Mirror product: Jira / Linear boards.

The asset is multi-panel (review each, not just the first): **(0)** the full
board · **(1)** drag in progress · **(2)** illegal-move snap-back · **(3)**
keyboard DnD · **(4)** scale · **(5)** unmapped-statuses tray · **(6)** loading
/ empty / error states · **(7)** mobile.

---

## Where it lives

Replaces the `/boards` stub (`app/(authed)/boards/page.tsx`, today a
`ProjectStubPage … comingIn="Epic 3"`). The sidebar "Boards" nav link + the
Cmd-K "Go to Boards" entry already point at `/boards` (Story 1.5) — **no new
navigation wiring**. The board renders the active project's single default
Kanban board (Story 3.1 auto-seeds one per project).

## Layout (panel 0)

- **Page shell** inside the app shell (1.5.1): a serif `h2` "Board" title +
  muted project subtitle, and a right-aligned toolbar — a disabled `[Filter]`
  seam (Epic 6 wires it) + the primary `[+ New issue]` (`Button variant="primary"`,
  reusing the shipped create flow).
- **The board** is a horizontally-scrolling flex row of **columns**
  (`.board`, `overflow-x: auto`, `scroll-snap-type: x proximity`). Columns are
  fixed-width (288px). Page gutter 24px.
- **Columns** are in **workflow order** (`status.position`) — the seeded default
  is To Do / Blocked / In Progress / In Review / Done / Cancelled (one column
  per status), but a column maps to a SET of statuses (Story 3.1), so this is a
  default over the durable mapping, not 1:1.

## Column anatomy (`BoardColumn` — subtask 3.2.3)

- Container: `--el-surface` fill, `--el-border`, `--radius-card`, a **uniform
  height** with an internal scroll on `.col-body`. Every column is the SAME height
  regardless of card count (3.2.8) — a sparse column shows empty space below its
  cards rather than hugging them, so the columns line up. In the app this is a
  viewport-relative LAYOUT height (a raw `calc`, not a `--height-*` token, since
  it is not a shaped-control size):
  `h-[calc(100dvh - 10.5rem - var(--shell-bottom-clearance, 1.5rem))]` — the
  chrome ABOVE the board as a constant, and the space the shell reserves BELOW as
  the variable it sets (MOTIR-2763). The below-term is **not** a baked number: it
  tracks the floating orb's footprint, which is present only when the orb mounts.
  See `design/shell/design-notes.md`.
- **Header**: column `name` (13px semibold, `--el-text-strong`) + a **card-count
  badge** (`.col-count`, the per-column total from the projection) + a spacer +
  a **WIP-limit slot** (`.wip-slot`, drawn as a placeholder e.g. `3/5` — **NOT
  enforced here; Story 3.3 enforces** WIP + over-limit warnings) + a
  column-actions `[⋯]` icon button.
- **Empty column**: a dashed `.col-empty` "No issues" placeholder inside the
  column body (distinct from the board-level empty state).

## Card anatomy (`BoardCard` — subtask 3.2.3) — REUSES the issue primitives

A board card is the same issue, compact. It composes the EXACT primitives from
`app/(authed)/items/_components/issueCellPrimitives.tsx` + `components/ui/*` —
**no new card vocabulary**:

- **Top row**: `IssueTypeIcon` (lucide glyph in the kind hue via `--el-type-*` —
  epic=zap, story=book, task=square-check, bug=bug, subtask=list-checks) · the
  mono issue `key` (`PROD-23`, `--el-text-muted`) · a spacer · a **drag grip**
  (`grip-vertical`, revealed on hover; the whole card is the drag handle, the
  grip is the affordance cue).
- **Title**: 2-line clamp (`-webkit-line-clamp: 2`), `--el-text`.
- **Meta row**: the **priority `Pill`** (`PRIORITY_META` tone + direction icon —
  highest/high = rose + arrow-up, medium = sky + minus, low = mint + arrow-down)
  · a **story-point / estimate chip** (`.pts`, mono) · a spacer · the **assignee
  `Avatar`** (initial-letter; unassigned = dashed circle).
- **Blocked cards** swap the priority pill for a **"Blocked" peach pill**
  (`--el-tint-peach` + `circle-alert` in `--el-warning`) — the `ReadinessBadge`
  tone, driven by the finding-#21 readiness signal on `BoardCardDto` (Story
  3.1.4). State is carried by TEXT + icon, never colour alone (finding #35).
- **Interaction**: `cursor: grab`; hover raises `--el-border-strong` + underlines
  the title. Clicking the card opens the **existing `IssueQuickView`** (Story 2.5)
  — no new detail surface.
- Shape: `--radius-card`, `--shadow-subtle`; colour strictly `--el-*` (finding
  #54 — the palette, not grey + one accent).

## Drag-drop (subtask 3.2.4) — dnd-kit

dnd-kit (`@dnd-kit/core` + `@dnd-kit/sortable`) — the accessible standard
(pointer + keyboard sensors, `DragOverlay`, `announcements`). New dependency;
mirror-product standard, not a deviation.

### Pointer drag (panel 1)

- The **source card** leaves a dashed, 40%-opacity **ghost** in place while
  lifted.
- A **`DragOverlay` clone** follows the cursor — tilted ~2.5°, `--shadow-elevated`,
  `cursor: grabbing`, accent border.
- The **target column** shows an accent **ring** (`outline`) + a lavender
  **tint** AND an **insertion bar** (`.insertion`, 3px accent pill) at the drop
  position — redundant cues, never colour alone (finding #35).
- **Optimistic**: the card moves to the drop position immediately, then
  reconciles against `POST …/move`.

### Snap-back (panel 2)

- **200** → reconcile to the returned `BoardCardDto` (confirmed status/position;
  update both column counts).
- **409 `IllegalBoardMoveError`** → revert the optimistic move (card **animates
  back** to its origin, brief focus ring) + a **danger `Toast`** naming the
  rejected transition (`"To Do → Done" isn't a permitted transition…`).
- **422 `UnmappedColumnTargetError`** and **network/other errors** → snap back
  the same way with a toast. The card never stays in a rejected position; the
  issue status is unchanged.

### A move HELD by an approval or a merge (panel 2b) — ADDED 2026-09-14 (MOTIR-5525 · story MOTIR-4887)

**Yue's direction, 2026-09-14:** _"the design should be like near or on the status
control/change, there should be access directly to open the approval gate/port — the full
screen overlay, give the user a message saying status can't be changed directly and give the
user the access to the approval gate."_ On the board, the control being used is **the card
being dragged**, so the message sits ON the card.

**What is held depends on whether the card has an OPEN pull request** (Yue, the same day:
_"it's about if there's a PR"_ … _"not only done is blocked, approved manual set should be
blocked too"_ — `docs/decisions/approval-gates.md` §6d AMENDMENT, rules 1–5 and **2b**):

| the card has…        | a drop onto… | `waitingOn` | the door                                        |
| -------------------- | ------------ | ----------- | ----------------------------------------------- |
| no pull request      | Done         | `decision`  | Review & approve if `canDecide`, else the name  |
| an open pull request | Approved     | `decision`  | Review & approve if `canDecide`, else no button |
| an open pull request | Done         | `merge`     | **never a button** — merging moves it           |

**The branch, and the ONLY one:** `POST …/move` answers **409** with
`{ code: 'APPROVAL_GATE_PENDING', error, gate: { itemKey, kind, waitingOn, canDecide, routedToLabel } }`.
When — and only when — `code` is `APPROVAL_GATE_PENDING`:

1. **The card returns to its origin**, exactly as panel 2's snap-back does. The board never
   shows a status the item does not have.
2. **No toast.** The status-control design's held line is anchored **ON the returned card**,
   directly under it, rendered from `gate`:
   - `waitingOn: decision`, `canDecide` → the decision sentence + **Review & approve**, a link to
     the board's own URL with `withApprovalOverlay(href, { itemKey: gate.itemKey, kind: gate.kind })`
     (`lib/approvals/overlayAddress.ts`), written with `shallowPush` so the overlay opens over the
     board and Close returns to it;
   - `waitingOn: decision`, not `canDecide` → the _"… is waiting on {name}"_ sentence
     (`gate.routedToLabel`), no button — and, with no name (no gate raised yet), the
     _"asked for once the pull request's checks pass"_ sentence, no button;
   - `waitingOn: merge` → the merge sentence, **never a button**.
3. **It stays** until `Esc`, a click outside, or the start of the next drag. It never blocks
   dragging another card.
4. **Keyboard:** the `aria-live` region reads `{key} returned. {the held line}` — beside
   panel 3's `rejected:` announcement, not instead of it for other refusals — and focus moves to
   **Review & approve** when it renders, else stays on the returned card.
5. **Mobile:** the same line under the returned card, at the column's full width.

**The four refusals that KEEP panel 2's toast, unchanged:** the illegal workflow edge (409
`ILLEGAL_BOARD_MOVE`), missing artifact evidence (409, folded into `ILLEGAL_BOARD_MOVE`), open
children (409, folded into `ILLEGAL_BOARD_MOVE`) and the unmapped column (422
`UNMAPPED_COLUMN_TARGET`), plus network errors. The code branches on
`code: 'APPROVAL_GATE_PENDING'` and on nothing else — never on the status, the HTTP status
alone, or the message text.

**Copy — composed VERBATIM from `design/work-items/design-notes.md` § _The status control says
so_** (`approvalGate.statusHeld.decision` / `decisionSeeOnly` / `decisionNotRaised` / `merge`,
`decisionNoun.<kind>`, `reviewAndApprove`). This panel adds exactly one string:

| key (proposed)           | en                       | zh                     |
| ------------------------ | ------------------------ | ---------------------- |
| `board.announcementHeld` | `{key} returned. {line}` | `{key} 已退回。{line}` |

where `{line}` is the composed held sentence.

**Composed primitives and tokens:**

| element                  | composes                                               | colour                                                                                      | shape                                                              |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| the returned card        | `BoardCard` (unchanged) + panel 2's brief focus ring   | as today                                                                                    | `--radius-card`                                                    |
| the held line (anchored) | the status-control design's held message box, one line | background `--el-tint-yellow` · border `--el-border-soft` · text + glyph `--el-text-strong` | `--radius-control` · `--spacing-control-x/y` · `--shadow-elevated` |
| the glyph                | lucide `lock` (decision) / `git-merge` (merge), 14px   | `--el-text-strong`                                                                          | —                                                                  |
| **Review & approve**     | `Button` `variant="primary"` `size="sm"`, as a link    | `--el-accent` · `--el-accent-text`                                                          | `--radius-btn` · `--height-btn-sm`                                 |
| the announcement         | the board's `aria-live` region (sr-only)               | —                                                                                           | —                                                                  |

**Allocation:** every element above is built by MOTIR-5529 (the board and list card).

**Out of scope:** the "a decision is waiting" marker on a board card — now drawn by MOTIR-5875 in
`design/work-items/decision-waiting.mock.html`, specified in `design/work-items/design-notes.md` § _The
DECISION-WAITING MARKER_ (it also retires the _Awaiting acceptance_ pill); the overlay (MOTIR-5222);
every guard rule (the ADR amendment).

**Grounding:** the snap-back this branches from was read in
`app/(authed)/boards/_components/BoardContainer.tsx` (`runMove` → `snapBack` → an error
`Toast`, on `origin/main` @ `1871ec0e1`) and rendered from this asset's panel 2, which the
shipped board was built to; the held line was composed from the MERGED status-control asset
(#2900), not redrawn.

### Keyboard DnD (panel 3) — operable with no mouse

- **Space/Enter** pick up & drop · **↑↓** move within a column · **←→** move
  across columns · **Esc** cancel.
- The picked-up card shows a **strong focus ring + elevation** (`aria-grabbed`).
- Every step reads from an **`aria-live`** region (sr-only in prod; shown in the
  mock for review). Announcement copy:
  - pick up: `Picked up {key}. Over column {col}, position {i} of {n}.`
  - move: `{key} moved to {col}, position {i} of {n}. Press Space to drop, Escape to cancel.`
  - drop: `{key} dropped into {col}.`
  - rejected: `Move not allowed: {from} → {to}. {key} returned.`
  - cancel: `Move cancelled. {key} returned to {col}.`

## Scale (subtask 3.2.5) — finding #57, panel 4

The board never loads every card. From the 3.1 projection each column carries a
bounded first page + a `total` + a `cursor`.

- The column header **count** shows the full total (e.g. `214`, `1,280`) — the
  denominator. It **stays**; it is the column's issue count, distinct from "how
  many are loaded".
- Paging is **PURE auto scroll-to-load (3.2.8)**: an `IntersectionObserver`
  sentinel at the bottom of the scroll area fetches
  `GET …/columns/[id]/cards?cursor=` and **appends** the next page (advancing the
  cursor) when it scrolls into view. There is **no explicit "Load more" button**
  and **no "{n} loaded" note** — both were dropped. While a page is in flight a
  small in-flow **`Spinner` + "Loading…"** (`.load-spin`) shows at the bottom; a
  **failed** page leaves a minimal, **focusable inline retry** (`.load-retry`) so
  it is recoverable without a reload and reachable by keyboard (the card links are
  focusable, so keyboard scroll also trips the sentinel).
- Tall columns **virtualize** (only viewport rows render — bounded DOM),
  **reusing the windowing primitive Story 2.5.15** established (no second lib).
  Virtualization is invisible — it is documented here, not surfaced on the column.
- **Done/terminal columns** are additionally **windowed** server-side to a recent
  set (mirroring Jira's "hide done older than ~14 days") with the full count still
  in the header; the windowing is invisible on the column (no on-column note).

## Unmapped-statuses tray (subtask 3.2.6) — panel 5

From `BoardProjectionDto.unmappedStatuses` (project statuses mapped to no column;
the Jira behaviour — Story 3.1.4 surfaces them, never drops them). Rendered as a
**yellow tray** (`--el-tint-yellow`) above the board: an alert-triangle, the copy
`These statuses aren't on this board — work items in them are hidden here:` + the
status names as neutral pills + a link to the workflow admin (Story 2.2.5).
**Absent when `unmappedStatuses` is empty.**

> **CTA reality (updated by Subtask 3.6.3):** the board-column admin now exists
> (`settings/project/board`, Story 3.6 — the column manager + status mapping), so
> the tray's link finally does what this mock drew: it reads **`Map columns →`**
> and deep-links to Board settings. This SUPERSEDES the interim 3.2.6 build note,
> where the link was labelled `Manage statuses →` and pointed at the workflow
> editor while no mapping admin existed. The `boards` i18n key was renamed
> `unmappedManageStatuses` → `unmappedMapColumns` (en + zh) to match.

## States (panels 6) — completeness, not the happy path only

- **Loading** (ships in 3.2.2): a column scaffold of pulsing skeleton cards
  (`Spinner`/skeleton) while the projection streams.
- **Empty board** (ships in 3.2.6): `EmptyState` — inbox icon, "No issues yet",
  a "New issue" CTA (reuses the shipped create flow). NOT six blank columns.
- **Error / no-board** (ships in 3.2.2): `ErrorState` — alert icon, "Couldn't
  load the board", a **Retry**.

## Mobile (subtask 3.2.6) — panel 7

Narrow viewports: a single-column horizontal scroll with a **pager** (dots +
`To Do · 1 of 5`). Card anatomy is unchanged. Drag still works (pointer +
keyboard); long-press lifts a card on touch.

## Token / a11y rules honoured

- **Colour** strictly through `--el-*` (finding #54 — uses the palette: type
  hues, pill tones, the lavender drop tint, the yellow tray — not grey + one
  accent). Tints carry the hue in the BACKGROUND with `--el-text-strong` text
  (finding #35 AA).
- **Shape** through element-semantic tokens (`--radius-card`/`-btn`/`-badge`/
  `-control`, `--shadow-subtle`/`-card`/`-elevated`, `--spacing-chip-*`).
- **Not colour-alone** (finding #35): drop targets pair the tint with a ring +
  insertion bar; blocked/priority/readiness carry text + icon; sort/state never
  rely on hue alone.
- Columns are landmarked (`<section aria-label="{name}, {n} issues">`) and the
  drag flow is fully keyboard-operable with live announcements.

---

# Swimlanes + WIP (Story 3.3)

Design reference for Story 3.3 — the board's flow-management layer on top of the
3.2 Kanban surface. Asset: **`swimlanes-wip.mock.html`** (+ `swimlanes-wip.png`
export). It is the source of truth for the UI subtasks **3.3.5** (swimlanes +
cross-lane drag) and **3.3.6** (WIP config + over-limit warning), which both
carry **3.3.1** in `dependsOn`.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and **reuses the shipped board/issue primitives unchanged** —
the `BoardColumn`, the `BoardCard` (`IssueTypeIcon` in the `--el-type-*` hue ·
mono key · 2-line title · priority `Pill` · story-point chip · assignee
`Avatar` · the Blocked peach pill), the column `[⋯]` menu, `Tooltip`. Swimlanes

- WIP are a **new arrangement + two new affordances**, not a new board.

Mirror product = **Jira / Linear** swimlanes + column WIP (decision-ladder rung
1). Config is persisted on the `board` entity and shared across viewers.

The asset is multi-panel (review EACH): **(0)** group-by control · **(1)**
swimlanes by Assignee (+ collapse + catch-all) · **(2)** by Epic · **(3)** by
Priority · **(4)** cross-lane drag = reassign · **(5)** WIP config · **(6)**
over-limit (SOFT) · **(7)** states.

## Composing primitives (what 3.3.5 / 3.3.6 build with)

- **Group-by control** — the shipped **Segmented** control (`components/ui`,
  the `.seg`), in the 3.2.1-reserved 3.3-controls slot in the board header.
  Options **None / Assignee / Epic / Priority** with a leading lucide glyph
  (`user` / `zap` / `flag`); the active option carries `aria-pressed="true"` +
  the `--el-page-bg` raised treatment. Do NOT invent a control.
- **Lane header** — chevron (`chevron-down`, rotated −90° when collapsed) +
  the group label + a `.lane-count` aggregate badge. Label by dimension:
  - assignee → the `Avatar` (initial-letter, `.sm`) + name;
  - epic → the epic `IssueTypeIcon` (`zap`, `--el-type-epic`) + mono `epic-key`
    - `epic-title`;
  - priority → the priority `Pill` (the exact `PRIORITY_META` tone + direction
    icon the cards use);
  - catch-all → a muted label ("No assignee" / "No epic") + dashed/faint marker.
- **Card** — the unchanged 3.2.3 `BoardCard`, bucketed into `(lane, column)`
  cells by the projection's `swimlaneKey`.
- **WIP config** — the column `[⋯]` **menu** primitive gains a **"Set WIP
  limit"** item opening an inline integer field + **Clear** / **Save** (the
  shipped input + small buttons). `Tooltip` on the over-limit chip.

## Lane layout + order

- A lane is a horizontal row slicing **every** column; the board is a grid of
  `(column × lane)` cells. Column headers stay **pinned** at the top; the lane
  header is **sticky-left** so it stays visible while the board scrolls
  horizontally. Column boundaries align across lanes (same fixed 288px column
  width + gutters as the flat board).
- **Only group values present on the board get a lane** (no empty 200-row
  assignee list). The **catch-all** lane ("No assignee" / "No epic" — the
  unassigned / no-ancestor-epic bucket) **always sorts LAST**.
- **Lane-order rule:** assignee → alphabetical by name; priority → priority
  rank (Highest → Lowest); epic → epic backlog/position order; **catch-all last
  in every mode.**
- **Collapse** is per-lane and **persists client-side** (e.g. localStorage
  keyed by `boardId + laneKey`). A collapsed lane shows only its header +
  count; its card bodies unmount (cheap) — but the per-column total (which
  drives the WIP chip) still counts its cards.
- **group-by None** is the flat 3.2 board, unchanged (no lanes).

## Cross-lane drag = reassign the grouped field

Dragging a card to a **different lane** must DO something (a lane that silently
snaps back is a broken affordance). It reassigns the grouped field via the
**existing Story-2.5 issue-field update endpoints** (the same paths
`IssueInlineEdit` calls) — **NOT** the board/move endpoint (status only) and
**NOT** a new backend:

- assignee lane → reassign assignee · priority lane → change priority · epic
  lane → reparent to that epic · drop into the **catch-all** → clear the field
  (unassign / remove epic) where legal.
- A **column** change is the 3.2 transition (`POST …/board/move`). A
  **diagonal** drop (different column AND lane) applies **both** writes.
- Each write is **optimistic with INDEPENDENT snap-back** (the 3.2.4 pattern):
  if the transition is rejected (409) only the column axis reverts; the lane
  reassign stays (and vice-versa). The card never rests in a lying position.
- **Drop affordances (not colour-alone, finding #35):** the target lane shows a
  ring + `--el-tint-lavender` tint; the specific target cell (diagonal) shows
  its own ring + an **insertion bar**. Keyboard DnD moves a card across lanes
  too (`Shift`+`↑/↓`).
- **`aria-live` copy** (distinct per move kind):
  - reassign (lane only): `{key} moved to {group}'s lane. {Field} changed to {value}.`
  - transition (column only): `{key} moved to {col}, position {i} of {n}.`
  - diagonal (column + lane): `{key} moved to {col} and reassigned to {value}.`
  - catch-all clear: `{key} unassigned.` / `{key} removed from its epic.`

## WIP limits — per-column, SOFT (advisory, never blocks)

- The limit is **per-column** (Jira-classic), counted across **all** swimlanes
  (the per-column total, not per lane). Per-lane WIP is out of scope (no stated
  use case → match the mirror).
- The header count renders as **`n/limit`** (the `.wip` chip). States:
  - **under** (`3/5`) and **at** (`5/5`) → **quiet** (no warning). At-limit is
    `n == limit` and is **NOT** warned.
  - **over** (`n > limit`, strictly greater, e.g. `6/5`) → the over-limit
    treatment: a warning hue (`--el-tint-peach` background + `--el-warning`
    alert icon) **PAIRED with the icon + the `n/limit` label** so it is **not
    colour-alone** (finding #35), and announced via `role="status"`.
- **SOFT = advisory:** an over-limit column does **NOT** reject drops — the
  3.2.4 move contract is untouched; a drop into an at/over-limit column still
  succeeds and the warning persists. There is **no HARD/blocking enforcement**
  (the stub says soft).
- No limit set → the count renders **plain** (the neutral `.col-count` badge,
  no `n/limit` chip, no warning). Clearing a limit returns to this state.

## States (completeness)

- **group-by re-lay** — switching group-by shows a loading transition (the new
  layout streams in; the old layout does NOT flash).
- **single-lane** — one group value present collapses to one lane sensibly.
- **catch-all-only** — the catch-all lane renders even as the only populated
  lane.
- **over-limit + collapsed** — the WIP warning is independent of lane collapse;
  a collapsed lane keeps its header + count, and the per-column total still
  drives the chip.

## Permissions

Group-by + WIP are board-config **writes**. Roles/permissions are Epic 6.4, so
(matching the 2.2.5 workflow editor) they are **membership-gated now** with a
`TODO(6.4)` to role-gate later — no early RBAC build.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): type hues, `Pill` tones, the
  lavender drop tint, the peach over-limit tint. Tints carry the hue in the
  BACKGROUND with `--el-text-strong` text (finding #35, AA).
- **Shape** via element-semantic tokens (`--radius-card`/`-btn`/`-input`/
  `-badge`/`-control`, `--shadow-subtle`/`-elevated`, `--spacing-*`,
  `--height-control`).
- **Not colour-alone** (finding #35): the over-limit chip pairs hue with an
  icon + the `n/limit` label; drop targets pair the tint with a ring +
  insertion bar; lane state carries text + chevron, never hue alone.
- Lane headers are operable as `role="button"` with `aria-expanded`; group-by +
  collapse are keyboard-operable; the over-limit state is announced
  (`role="status"`), not signalled by colour alone.

---

# Board configuration (Story 3.6)

Design reference for Story 3.6 — the board's **administration** surface. Asset:
**`board-config.mock.html`** (+ `board-config.png` export). It is the source of
truth for the UI subtask **3.6.3** (the column manager + status mapping + the
unmapped-tray repoint), which carries **3.6.1** in `dependsOn`. The service /
API it consumes is **3.6.2**.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and reuses shipped vocabulary: the **settings-page grammar**
from `app/(authed)/settings/project/workflow` (serif `h2` + muted subtitle + an
`mx-auto` editor), the **board column visual language** from `board.mock.html`
(3.2.1), the **neutral `Pill`** from the 3.2.6 unmapped tray, `Input`, `Button`,
`Modal`/confirm, and the dropdown **Menu** (the keyboard fallback). No new card
vocabulary — a new ARRANGEMENT of shipped pieces.

**Mirror product = Jira board settings → COLUMNS** (decision-ladder rung 1): the
column manager where an admin creates columns and maps statuses into them.

The asset is multi-panel (review EACH): **(0)** the full board-settings page ·
**(1)** inline column rename + the Add-column input · **(2)** map a status by
DRAG · **(3)** map by the non-drag KEYBOARD fallback · **(4)** delete-column
confirm (normal + guard) · **(5)** read-only (non-admin) · **(6)** states ·
**(7)** cross-links + the settings nav.

## Where it lives

A new project-settings page **`app/(authed)/settings/project/board/`**, a
**SIBLING of the Workflow editor** (`settings/project/workflow`, Story 2.2.5).
The two are reached from the **project-settings landing page's nav CARDS** (the
`WorkflowSettingsCard` pattern, finding #47) — there is **no settings sidebar**,
so "the Board nav entry, next to Workflow" means a new sibling `Card`-as-`Link`
("Board", "Columns and which statuses each column shows.") added to
`settings/project/page.tsx` beside the existing Workflow card. The page mirrors
the Workflow page grammar: a server component resolves the active project + the
caller's admin role and hands typed data to a client `BoardConfigEditor`.

**Division of labour:** the **Workflow** editor owns the statuses and the
transitions between them; **Board** settings owns how those statuses map onto
board columns. Renaming/adding a status is Workflow; putting it on the board is
Board.

## Composing primitives (what 3.6.3 builds with)

- **Page** — the `settings/project/workflow` page shell: serif title (with a
  leading `columns` glyph), muted subtitle, an `mx-auto max-w-[…]` editor column.
- **Board-name field** — `Input` + an auto-save reconcile indicator (a
  "Saving…/Saved" chip, mirroring the 3.3 WIP-limit save feedback). No explicit
  Save button needed — writes are optimistic-with-reconcile.
- **Unmapped-statuses rail** — a bordered surface (header + body) listing the
  statuses with no column (`BoardProjectionDto.unmappedStatuses`) as draggable
  status chips. It carries the same warning hue as the 3.2.6 board tray, but the
  hue lives in a small icon + a count badge (NOT a tinted page surface — finding
  #35); it is an interactive drop source AND drop target (drop a chip back to
  unmap). Empty state = a positive "Every status is on the board — nothing is
  hidden."
- **Column manager** — a horizontally-scrolling row of columns reusing the board
  column language. Each column: a **drag handle** (`grip`, reorder), an editable
  **name** (a `pencil` swaps it for an accent-bordered `Input` with check/cancel;
  Enter commits, Esc cancels), a **count** badge (mapped-status count), a
  **delete** (`trash`) affordance, the **mapped status chips** (full-width neutral
  `Pill` rows, each with a grip + an `×` remove that unmaps it), and a dashed
  **"Add status"** button. A trailing dashed **"Add column"** ghost column
  appends a new column already in name-edit mode.
- **Status chip (`.schip`)** — the mappable unit: the 3.2.6 neutral `Pill` tone
  as a moveable row (grip + label + `×`). The drag affordance is the grip + the
  cursor, never colour alone (finding #35).
- **Delete-column confirm** — a `Modal`/confirm. Two shapes (see below).
- **Per-column status picker** — the dropdown `Menu` primitive, the non-drag
  keyboard path (see "Status mapping").

## The mapping contract (the invariant the UI must respect)

`board_column_status` carries `@@unique([boardId, statusId])` (Story 3.1.1) — a
status maps to **at most one column per board**. So mapping is a **MOVE, never a
duplicate**:

- Dragging a status from the rail (or from another column) into column C
  **moves** its mapping to C (`mapStatusToColumn`, the 3.6.2 transactional
  delete-then-create). It never appears in two columns.
- The `×` on a chip (or dropping it back on the rail) **unmaps** it — it returns
  to the unmapped rail, and its work items are **hidden from the board but never
  deleted** (a card's column is DERIVED from `work_item.status` — config never
  touches work items).
- Every write is **optimistic-with-reconcile** against the 3.6.2 endpoints; a
  failed write reverts the optimistic change + surfaces a danger `Toast`.

## Status mapping — drag AND a non-drag keyboard path (finding #35)

Mapping is **NOT drag-only**. Two equivalent paths, both firing the same 3.6.2
write:

- **Drag (panel 2)** — dnd-kit (reuses the 3.2.4 board setup, no second DnD
  lib). The source chip leaves a dashed 40%-opacity ghost; a tilted
  `DragOverlay` clone follows the cursor; the **target column** shows an accent
  **ring** + a lavender **tint** AND an **insertion bar** — redundant cues, never
  colour-alone (finding #35).
- **Keyboard / non-drag (panel 3)** — every column's **"Add status"** button
  opens a `Menu` of the currently-unmapped statuses; choosing one maps it. Chip
  reorder/move-across-columns is keyboard-operable via the dnd-kit **keyboard
  sensor** (`Space` pick up · `↑↓` within · `←→` across · `Space` drop · `Esc`
  cancel). Both paths drive an **`aria-live`** region that announces each step,
  so a keyboard or screen-reader user can fully configure the board.

## Delete-column — confirm + the Jira-style guard

`deleteColumn` unmaps the column's statuses (they return to the rail) and removes
only the `board_column` row — **never a work item** (decided at 3.6.2). Two
confirm shapes:

- **Normal (panel 4a)** — "Delete '{column}'? Its mapped status(es) return to
  Unmapped statuses — work items keep their status and are not deleted." An info
  callout names which statuses return. Destructive (`Button` danger) confirm.
- **Guard (panel 4b)** — when a mapped status **still holds board cards**, the
  delete is refused (`ColumnNotEmptyError` → 409, mirroring Jira's "you can't
  delete a column with issues"). The confirm becomes a guard: a warning callout
  naming the status + its card count, and a **primary action that deep-links to
  remap** that status first. No work item is ever removed by a board change.

State is carried by **text + icon**, never colour alone (finding #35); the
peach/danger callouts put the hue in the BACKGROUND with `--el-text-strong`
(finding #35 AA).

## Cross-links — the three entry points (panel 7)

1. **The board's 3.2.6 unmapped-statuses tray (the headline).** 3.6.3 repoints
   its CTA from the interim **"Manage statuses →"** (which went to the Workflow
   editor because no mapping admin existed) to **"Map columns →"** →
   `settings/project/board` — the real surface. The `boards` i18n keys update
   (en + zh) and this note's **"CTA reality"** block (in the Story-3.2 section
   above) is superseded: the tray now does what its copy promises.
2. **The board column `[⋯]` menu (3.2.3)** — a disabled seam until now — gains a
   **"Board settings →"** item that opens this surface.
3. **The project-settings nav** — a new **"Board"** card beside **"Workflow"** on
   `settings/project`.

## States (completeness)

- **Loading** — a header + name-field + column skeletons stream in.
- **Error / no-board** — an `ErrorState` with Retry (the 3.2.2 board pattern).
- **All-mapped** — the unmapped rail shows a positive empty state, not a blank
  box. (A board always auto-seeds ≥1 column per the Story-3.1 seed — 3.1.2 — so
  there is no zero-column state; "empty / brand-new board" means its only column
  holds the initial status and the rail is empty.)
- **Save feedback** — the per-write "Saving…/Saved" chip on the name field; a
  failed write surfaces a danger `Toast` and reverts the optimistic change.

## Permissions

Column + mapping writes are board-config **writes**. Roles/permissions are Epic
6.4, so (matching the 2.2.5 workflow editor + the 3.3 board config) the surface
is **membership-gated now** with a `TODO(6.4)` to role-gate later — no early RBAC
build. A non-admin sees the surface **read-only** (panel 5): no grips, no
rename/delete, no "Add status", the name field disabled, no rail drop target; the
server re-gates every write 403 regardless of the rendered affordances.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the warning hue on the rail +
  guard callout, the `--el-accent` drop ring/tint + rename border, the success
  green on "Saved" / all-mapped, the danger red on delete. Tints carry the hue in
  the BACKGROUND with `--el-text-strong` text (finding #35 AA — never a tinted
  page surface).
- **Shape** via element-semantic tokens (`--radius-card`/`-btn`/`-input`/
  `-modal`/`-badge`/`-control`, `--shadow-subtle`/`-elevated`/`-modal`,
  `--spacing-*`, `--height-input`/`-btn-sm`/`-control`).
- **Not colour-alone** (finding #35): the drop target pairs the tint with a ring
  - insertion bar; the rail icon + the chip grip signal interactivity; delete /
    guard state carries text + icon. Mapping is operable by keyboard (the picker
    menu + the dnd-kit keyboard sensor) with `aria-live` announcements, not
    drag-only.
- Columns are landmarked (`role="listitem"` with an `aria-label` carrying the
  name + mapped-status count); the rename/add/delete controls have explicit
  `aria-label`s; the picker is a `role="menu"`.

---

# Board load model (Story 3.8)

Design reference for Story 3.8 — the **correction** to the board's scale UI.
Asset: **`board-scale.mock.html`** (+ `board-scale.png` export). It is the source
of truth for the UI subtasks **3.8.3** (flat board), **3.8.4** (over-cap banner),
and **3.8.5** (swimlanes), which all carry **3.8.1** in `dependsOn`.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and **reuses the shipped board / lane primitives unchanged** —
the `BoardCard`, the column header + `[⋯]`, the swimlane lane/cell grammar
(3.3.1), and — for the over-cap banner — the **yellow-tray treatment the shipped
`UnmappedStatusesTray` (3.2.6) already uses, verbatim**. No new card / column /
lane vocabulary; this is a new LOAD behaviour over the shipped arrangement.

## Why this is a correction (notes.html mistake #33)

The earlier scale UI **paged the board**: first a per-column **"Load more"**
button (3.2.5), then **PURE auto scroll-to-load** + an in-flight spinner (3.2.8).
Both are a paging affordance the **mirror product does NOT use**. VERIFIED against
Jira (June 2026, Atlassian docs): a board renders the **whole saved-filter set up
to a hard cap** (5,000 Software / 3,000 Business), shows a **"maximum number of
viewable issues exceeded — refine your filter"** warning past the cap, windows the
**Done** column to issues resolved in the **last ~14 days**, and **virtualizes**
the render — it never paginates columns and has no "Load more." **Per surface
(mistake #33):** Jira's issue _navigator_ DOES paginate, so finding #57's
list/tree pagination stays correct and is **untouched** — only the _board_
loads-the-set. This asset is **STILL bounded** (the cap is the bound; it never
"loads every row," so finding #57 holds): the cap bounds the load, the Done-age
window trims terminal columns, and virtualization keeps the DOM bounded.

> This story does NOT edit the done subtasks it supersedes (3.1.4 / 3.2.5 / 3.3.4
> / 3.3.5) — what is done is done; the new 3.8 subtasks supersede them in code.

## The asset is multi-panel (review EACH)

- **(0) Bounded whole-set load** — a tall column rendering its **full bounded
  card list** with **NO "Load more" button, no scroll-to-load sentinel, no
  in-flight spinner, no `.col-foot` footer**. The only affordance is the column's
  own scroll. The header **count** is the FULL total (the denominator),
  unchanged. A dashed `.virt-note` (a **review-only** annotation, NOT shipped)
  documents that the rest of the cards render the same way and that tall columns
  virtualize via the 2.5.15 `useRowWindow` (kept) so the DOM stays bounded. A
  crossed-out `.removed` box shows the 3.2.5 "Load more" + 3.2.8 scroll-to-load
  spinner that 3.8.3 / 3.8.5 delete.
- **(1) Done-age window** — the **terminal** (resolved/closed) column windowed
  server-side to issues resolved in the **last ~14 days** (newest first), with the
  **full count still in the header**. Refines 3.2.5's count-based window to Jira's
  age-based behaviour. The window applies to every terminal status (by workflow
  status category), not just "Done" by name. Invisible on the column (the
  `.virt-note` is review-only; no on-column note ships).
- **(2) Over-cap banner** — when the projection signals **`truncated: true`**
  (board total > `cap`), a board-level banner renders **above the board** (in
  `BoardContainer`, so it shows for flat AND swimlane layouts). It **reuses the
  3.2.6 yellow-tray treatment** (`--el-tint-yellow` background + an
  `AlertTriangle` in `--el-warning` + `--el-text-strong` copy), pairs **hue +
  icon + text** (finding #35), and is announced via `role="status"`. Copy: _"This
  board has more than {cap} work items — refine the board filter to see them all.
  Only the first {cap} are shown."_ The affordance is the **Epic-6 `[Filter]`
  seam** (the disabled toolbar `[Filter]` button 3.2 already reserves) — rendered
  **disabled** (`aria-disabled`, "Board filters arrive in Epic 6") until Epic 6
  lands board filters. **Absent when `truncated` is false** (panels 0–1 show no
  banner).
- **(3) Swimlanes, no per-column footer** — the lane × column grid (3.3.1) with
  each `(lane, column)` cell rendered **in full**, virtualized per cell via
  `useRowWindow` (kept). The awkward per-column **"Load more" footer row** (3.3.5)
  is **gone** (3.8.5). Everything else is unchanged: group-by, collapsible lanes,
  the catch-all lane (always last), cross-lane drag-reassign, and the per-column
  WIP chip in the pinned column-header row.

## The cap is a generous bound, not a paging knob

`BOARD_ISSUE_CAP` (3.8.2) is a **generous bound** — a real team's active board
fits comfortably under it (Jira's figure is 5,000 Software / 3,000 Business). It
is **not** a page size and there is **no "next page"**: the board loads up to the
cap and stops. The rare board that exceeds it gets the over-cap banner, exactly as
Jira does. The control that lets a user shrink an over-cap board is the **board
filter / saved query — Epic 6**; until it lands, the banner explains the cap and
the `[Filter]` seam stays **disabled** (a documented seam, not an invented
control). This is **finding-#57-bounded** (the cap is the bound), the opposite of
"load all rows."

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): type hues, `Pill` tones, the
  `--el-tint-yellow` over-cap tray, `--el-warning` alert icon. The tray carries
  the hue in the BACKGROUND with `--el-text-strong` text (finding #35, AA — never
  a tinted page surface).
- **Shape** via element-semantic tokens (`--radius-card`/`-btn`/`-badge`/
  `-control`, `--shadow-subtle`, `--spacing-control-*`/`-chip-*`,
  `--height-control`).
- **Not colour-alone** (finding #35): the over-cap banner pairs the yellow hue
  with the alert-triangle icon + the cap text; nothing relies on hue alone.
- The over-cap banner is announced (`role="status"`); the column landmarks
  (`<section aria-label="{name}, {n} issues">`) and keyboard operability from
  3.2.1 are unchanged (this story changes loading, not interaction).

---

# Multiple boards (Story 3.7)

Design reference for Story 3.7 — turning the project's **single** auto-seeded
board into **many boards per project**. Asset: **`multi-board.mock.html`** (+
`multi-board.png` export). It is the source of truth for the UI subtask
**3.7.4** (the board switcher + create / rename / set-default / delete), which
carries **3.7.1** in `dependsOn`. The service / API it consumes is **3.7.3**;
the default-board flag + ordering it relies on is **3.7.2**; the selected-board
read it threads is **3.7.5**.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and reuses shipped vocabulary — the **board page-head +
toolbar** and the **group-by Segmented slot** (`board.mock.html` /
`swimlanes-wip.mock.html`), the **dropdown Menu** + **`Modal`/confirm** + the
**info `callout`** (`board-config.mock.html`), `Input`, `Button`, and the
**neutral `Pill`** (the "Default" badge). No new card / column vocabulary — a new
ARRANGEMENT of shipped pieces.

**Mirror product = Jira's board switcher + create / manage board** (decision-
ladder rung 1; VERIFIED June 2026, Atlassian docs — checked, not asserted, per
`notes.html` mistake #33): a project has many boards; any member creates one, an
admin renames/deletes from board settings; one board is the team's landing
board. A Jira board is ultimately backed by a saved **filter** (so it can span
projects) — but filters are **Epic 6**, so 3.7 ships **project-scoped** boards
and the JQL backing is the Epic-6 extension (the disabled `[Filter]` seam already
reserves it).

The asset is multi-panel (review EACH): **(0)** header switcher (closed) ·
**(1)** switcher open (the board list) · **(2)** the manage menu · **(3)**
New-board modal · **(4)** rename modal · **(5)** delete confirm · **(6)**
last-board guard + one-board state · **(7)** states + permissions.

## Where it lives

The board header on `/boards` (`app/(authed)/boards/page.tsx` +
`_components/BoardContainer.tsx`). The switcher sits at the **left of the header
toolbar**, before the 3.3 group-by `Segmented`, the disabled `[Filter]` seam, and
`[+ New issue]` — no new page, no new nav. The selected board is URL-addressable
via `?board=<id>` (mirroring the 2.5.19 `?peek` pattern — shareable, reload-safe),
defaulting to the project's `isDefault` board when absent (3.7.5).

## Composing primitives (what 3.7.4 builds with)

- **Switcher trigger** (`.bsw-trigger`) — a select-like `Button`/trigger
  (`--radius-input`, `--height-control`): a leading `columns` glyph + the active
  board's `name` + the **Default** `Pill` (only when the active board is the
  project default) + a trailing `chevron-down`. `aria-haspopup="menu"` +
  `aria-expanded`.
- **Switcher menu** — the shipped dropdown **Menu** (the board-config picker
  vocabulary: `--radius-card`, `--shadow-elevated`). A `menu-cap` header
  ("Boards · {project}"), then one row per board **ordered by `board.position`**
  (3.7.2), a separator, and a **New board** create action. Each board row is a
  flex container holding TWO sibling buttons (never nested):
  - **`.bsw-pick`** (`role="menuitemradio"`, `aria-checked`) — a leading
    **check** on the active board (hidden but space-reserved otherwise), the
    board `name`, and the **Default** `Pill` on the default board. Picking it
    sets `?board=<id>` and re-lays the board from that board's projection (3.7.5).
  - **`.icon-btn`** (the `[⋯]` manage affordance) — opens the per-board manage
    menu (panel 2).
- **Manage menu** — a second Menu opened from a row's `[⋯]`: **Rename** (`pencil`
  → panel 4), **Set as default** (`star` → promotes this board, 3.7.3), and a
  **danger Delete** (`trash` → panel 5). On the already-default board **Set as
  default** is disabled; on the last remaining board **Delete** is disabled
  (panel 6).
- **New-board / rename `Modal`** (`--radius-modal`) — an `Input` (name) and, for
  create, a two-option **type** picker: **Kanban** selected (the only enabled
  option) and **Scrum** disabled with an **Epic 4** `Pill` (Story 4.5 — the Scrum
  board variant is out of scope here). A `hint` notes new boards seed default
  columns off the project workflow.
- **Delete confirm `Modal`** — a danger `trash` glyph title + an **info
  `callout`** (the hue in the tinted box with `--el-text-strong`, finding #35)
  making the board-≠-issue-owner contract explicit; a danger confirm `Button`.

## Lifecycle contract (the invariants the UI must respect)

A board is **not** the owner of work items — a card's column is DERIVED from
`work_item.status`; the board only carries column/swimlane **config**. So:

- **Create** (`POST /api/boards`, 3.7.3) — names a board + seeds its default
  columns off the project workflow (so it's usable immediately), non-default,
  then the switcher switches to it.
- **Rename** (`PATCH …/[id]`) — label only; issues + config untouched.
- **Set as default** (`PATCH …/[id]`) — flips the project's single default in one
  tx (exactly one default per project, the 3.7.2 partial-unique invariant). New
  sessions open the default board.
- **Delete** (`DELETE …/[id]`) — removes the board + its column/config rows;
  **work items are never deleted** (they stay on the project, visible on the
  other boards). Two guards: the **last board can't be deleted** (typed `409`,
  mirrored as the disabled affordance + a `menu-note` explanation), and deleting
  the **default promotes** the next board by position to default.

Every write is **optimistic-with-reconcile** against the 3.7.3 endpoints; a
failed write reverts the optimistic change + a danger `Toast`. Outcomes (switch,
delete-and-promote) are announced via an `aria-live`/`role="status"` region.

## One-board + last-board (panel 6)

A project always keeps **≥1 board**, so the switcher is **always present** even
with one board (one row, no clutter). That board's manage menu disables **Set as
default** (it already is) and **Delete**, with a `menu-note` naming the
last-board guard. The disabled affordance is the **client mirror** of the API
guard — the server still rejects the last-board delete `409` regardless of what
is rendered.

## States (completeness)

- **Loading** — the switcher trigger renders as a skeleton while
  `GET /api/boards` resolves; the board still shows the current selection.
- **Error** — a failed board-**list** load shows an inline `ErrorState` with
  Retry (the 3.2.2 board pattern) and never blanks the board itself.
- **Empty** — there is no zero-board state (the project always has ≥1 board); the
  one-board case is panel 6.

## Permissions

Board CRUD is a project-config **write**. Roles/permissions are Epic 6.4, so
(matching the 2.2.5 workflow editor + the 3.3 / 3.6 board config) the surface is
**membership-gated now** (any project member) with a `TODO(6.4)` to role-gate
later — **board admin becomes project-admin-gated under Story 6.4**, after which a
non-admin sees the switcher (to switch boards) with the New / manage affordances
hidden and the server re-gating every write `403`. No early RBAC build.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the accent on the active-board
  check + the New-board action + the selected type option, the neutral `Pill` for
  the Default badge, the info-tint callout, the danger red on Delete, the
  issue-type hues on the board-preview cards. Tints carry the hue in the
  BACKGROUND with `--el-text-strong` text (finding #35 AA — never a tinted page
  surface).
- **Shape** via element-semantic tokens (`--radius-input`/`-card`/`-modal`/
  `-btn`/`-control`/`-badge`, `--shadow-subtle`/`-elevated`/`-modal`,
  `--spacing-control-*`/`-chip-*`/`-input-*`, `--height-control`/`-input`/
  `-btn-sm`).
- **Not colour-alone** (finding #35): the active board carries a check (not just
  the highlight), the default carries the **Default** Pill (not just position),
  delete/guard state carries text + icon. The switcher is a `role="menu"` with
  `menuitemradio` rows; the manage menu's disabled items carry `aria-disabled` +
  the explanatory note; outcomes are announced (`aria-live`).
- **No nested buttons** — a board row is a `div` holding the `.bsw-pick` and the
  `.icon-btn` as siblings, so the pick target and the manage target are distinct
  controls.

---

# Per-board settings (Story 3.7)

Design reference for Story 3.7's per-board **settings** delta. Asset:
**`per-board-settings.mock.html`** (+ `per-board-settings.png` export). It is the
source of truth for the UI subtask **3.7.8** (thread the selected board through
the settings page + entries), which carries **3.7.7** in `dependsOn`. The
selected-board read it relies on is **3.7.5**; the settings surface it scopes is
**3.6.3**; the switcher + manage menu it extends are **3.7.4**.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and **EXTENDS two shipped surfaces with NO new vocabulary** —
the **3.6.1 board-config page** (the `settings/project/workflow` grammar: serif
`h2` + muted subtitle + an `mx-auto` editor; the unmapped tray; the column `[⋯]`
menu; the settings-landing nav cards) and the **3.7.1 board switcher** (the
trigger + dropdown `Menu` + the per-board manage menu). It is a new ARRANGEMENT
of shipped pieces, not a new screen.

## Why this is a delta (the gap it closes)

Today board settings configure the project **default** board only:
`settings/project/board` resolves the default board (`boardsService.getBoard`
without a `boardId`), and every entry point — the column `[⋯]` "Board
settings →", the unmapped-tray "Map columns", the settings landing card — links
there with **no board context**. With many boards per project (Story 3.7) each
board carries its OWN columns / column→status mapping / swimlane group-by / WIP
(all already board-scoped in the schema), so settings must target the
**selected** board. That scoping was unspecified in `design/boards/`, so the
planning-time design gate (3.7.7) produces this asset FIRST — it gates 3.7.8.

**Mirror product = Jira's per-board "Configure board"** (decision-ladder rung 1;
VERIFIED June 2026, Atlassian docs — checked, not asserted, per `notes.html`
mistake #33): each board has its OWN configuration, reached FROM that board
(board → ⋯ → **Board settings / Configure board**), and the config screen NAMES
the board it edits and lets you switch board. Per-board settings reached from the
board is the standard; default-only is the gap.

## The asset is multi-panel (review EACH)

- **(0) Board-scoped settings page** — the 3.6.1 page, now board-scoped. The new
  header element is a right-aligned **board switcher** under a **"Configuring
  board"** label that NAMES the board being edited (here `Triage`, not the
  default); the crumb carries the board name (`Settings · motir · Board ·
Triage`). The editor body (name field · unmapped rail · column manager) is the
  **unchanged 3.6.3 surface**, just built from THAT board's projection.
- **(1) Switcher open on the settings page** — reuses the 3.7.4 switcher
  vocabulary (the dropdown `Menu` with `menuitemradio` rows ordered by
  `board.position`, the active board's **check**, the project default's
  **Default** Pill), but picking a board **re-targets which board you
  configure**: it updates `?board=<id>` and re-lays the settings editor. There is
  **no "New board" action here** — creating a board is the 3.7.4 switcher's job
  on `/boards`; this menu only switches the configured board.
- **(2) Manage-menu "Board settings" item** — the 3.7.4 switcher manage menu
  (a board row's `[⋯]`) gains a **"Board settings"** item (a `sliders` glyph)
  between **Set as default** and the destructive **Delete**. It navigates to
  `/settings/project/board?board=<id>` for THAT board — the Jira-faithful
  reached-from-the-board path.
- **(3) Cross-links carry the active board** — the column `[⋯]` **"Board
  settings →"** (`ColumnActionsMenu`), the unmapped-tray **"Map columns →"**
  (`UnmappedStatusesTray`), and the settings landing **"Board"** card all reflect
  board context. The three reached **from `/boards`** (manage menu, tray, column
  menu) carry `?board=<id>` so they open the board being viewed; the
  **settings-landing card** has no board context (it lives outside `/boards`), so
  it opens the **default** board, and the in-page switcher (panel 1) is then the
  way to any other board's settings.
- **(4) States + permissions** — **absent `?board=`** resolves the project's
  `isDefault` board (the default-only behaviour preserved, never broken); a
  **board outside the active project / workspace** → a 404 `ErrorState`, never a
  cross-tenant read (the 3.7.5 tenant-safety guard); **membership-gated now**,
  project-admin-gated under Story 6.4 (a non-admin then sees the 3.6.1 panel-5
  read-only treatment and the server re-gates every write `403`).

## Composing primitives (what 3.7.8 builds with)

- **Settings-page header** — the 3.6.1 `ed-head` (serif title + muted subtitle),
  PLUS a right-aligned **board switcher** reusing the 3.7.4 `BoardSwitcher`
  trigger + menu vocabulary, under a small "Configuring board" `SectionLabel`.
  The page reads `?board=<id>` (defaulting to the default board) and builds its
  `BoardConfigModel` from that board.
- **Manage-menu item** — a new `MenuItem` ("Board settings", `sliders`
  glyph) added to the 3.7.4 manage `Menu`, a `Link` to
  `/settings/project/board?board=<id>`.
- **Cross-link entries** — the existing `ColumnActionsMenu` "Board settings →",
  `UnmappedStatusesTray` "Map columns →", and `BoardSettingsCard` thread the
  active `?board=` (the board ones from the `/boards` URL; the landing card opens
  the default).

No service / schema change: 3.7.5 already taught `getBoard` to take a `boardId`,
and the 3.6.2 config writes are already board-scoped — this is a UI/URL threading
of the selected board.

## Permissions

Board settings is a board-config **write**. Roles/permissions are Epic 6.4, so
(matching the 2.2.5 workflow editor + the 3.3 / 3.6 / 3.7 board config) the
surface is **membership-gated now** with a `TODO(6.4)` to role-gate later —
board admin becomes **project-admin-gated under Story 6.4**, after which a
non-admin sees the page read-only and the server re-gates every write `403`. No
early RBAC build.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the `--el-accent` on the active
  board's check, the neutral `Pill` for the Default badge, the `--el-tint-yellow`
  unmapped tray + `--el-tint-peach` warn callout (the cross-tenant not-found
  note), the `--el-info` info callouts, the danger red on Delete. Tints carry the
  hue in the BACKGROUND with `--el-text-strong` text (finding #35 AA — never a
  tinted page surface).
- **Shape** via element-semantic tokens (`--radius-input`/`-card`/`-badge`/
  `-control`, `--shadow-subtle`/`-elevated`, `--spacing-control-*`/`-chip-*`/
  `-input-*`/`-card-padding`, `--height-control`/`-input`).
- **Not colour-alone** (finding #35): the active board carries a check (not just
  the highlight); the default carries the **Default** Pill; the "Board settings"
  item carries the `sliders` icon + label; the state callouts pair hue with an
  icon + text.
- **No nested buttons** — the switcher board rows stay the 3.7.1 `div` holding
  the `.bsw-pick` + `.icon-btn` siblings; the navcards are `<a>` links. The
  switcher is a `role="menu"` with `menuitemradio` rows; the settings-page
  switcher is announced as "Configure which board"; board switches re-lay the
  editor (the 3.7.5 selected-board re-read).

---

# Scrum board (Story 4.5)

Design reference for the **Scrum** variant of the board. Asset:
**`scrum.mock.html`** (+ `scrum.png` export). It is the source of truth for the
UI subtask **4.5.3** (scrum page resolution + sprint header + per-column point
totals + no-active-sprint state), which carries **4.5.1** in `dependsOn` and
binds to the **4.5.2** projection (`sprint` + `columnPoints`). The complete-
sprint flow it mounts is **Story 4.4**; the Backlog its empty-state links to is
**Story 4.2**; the burndown chart it seams for is **Story 4.6**.

Built FROM the real design system (the token block is copied 1:1 from
`app/globals.css`) and is **CHROME over the EXISTING board with NO new board
vocabulary** — it REUSES the **3.2 board** (columns, cards, drag-as-transition,
load-more / virtualization) and the **3.3 swimlanes / WIP** layer wholesale, fed
the 4.5.2 sprint-scoped projection. It draws ONLY the net-new Scrum surfaces (the
sprint header, the per-column point pill, the no-active-sprint state); it does
**not** redraw columns / cards / drag states / swimlanes / WIP (those are
referenced from `board.mock.html` + `swimlanes-wip.mock.html`, not re-spec'd).

## Why this is an extension (the gap it closes)

The 3.2.1 board mockup drew the **Kanban** surface only. A Scrum board is the
same board scoped to a board's **active sprint**, under a sprint header — and the
header (name / goal / dates / time remaining / points), the per-column point
totals, the **no-active-sprint** empty state, and the **complete-sprint** entry
point were all unspecified in `design/boards/` (== no design under the gate). So
the planning-time design gate (4.5.1) produces this asset FIRST — it gates 4.5.3.

**Mirror product = Jira's scrum board active-sprint view** (decision-ladder
rung 1; VERIFIED June 2026, Atlassian docs — checked, not asserted, per
`notes.html` mistake #33): a scrum board shows the **active sprint** under a
sprint header carrying the sprint name + goal + dates + a **sprint-health** points
summary, with **per-column point totals** in the column headers and a **Complete
sprint** button; before a sprint is started (or after it completes) the board
area shows a no-active-sprint state pointing at the Backlog. The numeric points +
per-column totals are the standard; the burndown CHART is a separate report
(here, Story 4.6).

## The asset is multi-panel (review EACH)

- **(0) The full scrum board** — the 3.2.2 page shell, then the **sprint header**
  (a labelled landmark), then the REUSED 3.2/3.3 board scoped to the active
  sprint, each reused column header gaining a muted **point-total pill**. A
  `reuse-note` ribbon marks what is reused vs net-new.
- **(1) Sprint-header anatomy** — name + state `Pill`; the **goal** truncated to
  one line with the `Tooltip` reveal shown OPEN (full goal text); the **date
  range** + **time remaining**; the **points summary** (committed / completed /
  remaining as labelled numbers, Remaining on the lavender emphasis tile); the
  **Complete-sprint** entry point.
- **(2) No active sprint** — `sprint: null` → the board area is replaced by an
  `EmptyState` (a **flag** icon, "No active sprint", a one-line explainer, a
  **Go to Backlog →** CTA). Distinct from the 3.2.6 "No issues yet" _inbox_
  empty-board state.
- **(3) Edge states** — **unestimated** (point figures show "—", never `NaN`);
  **overdue** (time-remaining becomes an "Ended" peach chip with an alert glyph +
  the word — never colour alone); **loading** (a header skeleton over the 3.2.2
  column-skeleton scaffold).
- **(4) Column-header slot coexistence** — the read order **name → card-count
  badge (3.2.1) → point-total pill (NEW) → spacer → WIP slot (3.3) → actions**,
  shown with and without a WIP limit so the three header slots are seen not to
  crowd.

## The sprint header (`SprintHeader` — subtask 4.5.3)

A **labelled landmark** (`<section aria-label="Sprint … — <state>, <remaining>">`)
above the reused board, built from the 4.5.2 `SprintSummaryDto`. It is a quiet
card BAND (`--el-surface-soft` + `--el-border` + `--radius-card`), NOT a tinted
page surface (finding #35). Two clusters:

- **Left (`.sh-main`)** — the sprint **name** (serif, `--el-text-strong`) + a
  state **`Pill`** (`Active` mint dot · `Planned` muted · `Complete` lavender);
  the **goal** on one line (`target` glyph + a bold `Goal ·` lead + the text),
  truncated with `text-overflow: ellipsis` and a `Tooltip` revealing the full
  text on hover/focus (keyboard-operable, not hover-only); the **dates** line
  (`calendar` glyph + `Jun 2 – Jun 14`) and **time remaining** (`clock` glyph +
  "5 days remaining" / "Ends Jun 14" / the "Ended" chip).
- **Right (`.sh-right`)** — the **points summary** (three `.stat` blocks —
  Committed / Completed / **Remaining**; Remaining on `--el-tint-lavender`, the
  others on `--el-muted`) + the **Complete-sprint** `Button`
  (`secondary`, `check-check` glyph).

`daysRemaining` (from `SprintSummaryDto`) drives time-remaining; it is floored at
0 (an overdue sprint reads **"Ended"**, never a negative number). The points are
the `SprintSummaryDto.points` aggregate (NOT a sum over the loaded card page —
finding #57). The **burndown CHART is Story 4.6** — the header shows numeric
remaining only and leaves a chart seam.

## Complete-sprint is an ENTRY POINT only (the flow is Story 4.4)

The header mounts a **Complete sprint** button, but the complete-sprint FLOW
(confirm modal + carry-over of unfinished issues + the sprint report) is **Story
4.4**. 4.5.3 mounts 4.4's exposed action if available, otherwise renders the
button as a **seam 4.4 wires** — the same seam pattern 3.2 used for the Epic-6
**Filter** button. 4.5 implements neither carry-over nor the report.

## Per-column point totals (the "sprint health" pill)

Each REUSED column header gains a `.col-pts` pill (muted, mono, `N pts`) from
`SprintSummaryDto.columnPoints[columnId]`. It sits in the **left** group, right
after the 3.2.1 card-count badge (both describe the column's contents), while the
3.3 **WIP slot** stays right-aligned by the `[⋯]` actions — so count · points ·
(spacer) · WIP · actions coexist without crowding. Same column-header component
as the Kanban board; the pill is **conditional** on a scrum board having an
active sprint (a kanban board never renders it).

## No-active-sprint state (`sprint: null`)

When the 4.5.2 projection returns `sprint: null` for a scrum board (the common
pre-start / post-complete state), the board area is replaced by an `EmptyState`
— a **flag** icon (distinct from the 3.2.6 inbox), "No active sprint", a one-line
explainer, and a CTA **Go to Backlog →** (Story 4.2 route). 4.5 does NOT start a
sprint (that's 4.2 / 4.4); it links there. It never falls back to showing the
unscoped backlog as if it were a sprint, and never shows an empty six-column
board. A project with **no scrum board at all** falls through to the existing
Kanban board (3.2) — 4.5 only _replaces_ the view when a scrum board is resolved.

## Reuse, not rebuild (the load-bearing scope decision)

The columns, cards, drag-as-transition, snap-back, keyboard DnD, per-column
load-more + virtualization (3.2) and the swimlanes + WIP layer (3.3) are the
**SAME** components, rendered with the sprint-scoped projection. Swimlanes / WIP
compose on the scrum board for free (Jira scrum boards have both) because it is
the same board component. The ONLY net-new UI is `SprintHeader` + the per-column
point pill + the no-active-sprint state + the page-level `type == scrum`
resolution. A card move is still a workflow transition (the 3.2 contract is
unchanged) and never changes the sprint.

## States (completeness)

- **Loading** — the 3.2.2 board scaffold PLUS a header **skeleton** (name / goal
  / points / button placeholders).
- **Error / no board** — the 3.2.2 `ErrorState` (Retry) — referenced from
  `board.mock.html` panel 6, not redrawn.
- **No active sprint** — the `EmptyState` above (NOT an empty board).
- **Unestimated sprint** — point figures show "—" (the DTO stays total, returns
  0s; the UI owns the "—" presentation). The board still renders.
- **Overdue sprint** — the "Ended" chip; `daysRemaining` floored at 0.

## Permissions

The scrum board is a **read** of the sprint-scoped projection; viewing is
**membership-gated now** (matching the 3.2 board), with the finding-#26
application-layer `workspaceId` gate on `getBoard` covering the new sprint reads.
The complete-sprint action's gating is **Story 4.4**'s concern (the flow 4.5
mounts); 4.5 only places the entry point.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the **state Pill** tones
  (`--el-tint-mint` Active · `--el-muted` Planned · `--el-tint-lavender`
  Complete), the Remaining emphasis tile (`--el-tint-lavender`), the "Ended" chip
  (`--el-tint-peach` bg + `--el-warning` glyph), the reused card type-hues
  (`--el-type-*`) + priority `Pill` tones. Tints carry the hue in the BACKGROUND
  with `--el-text-strong` text (finding #35 AA — never a tinted page surface; the
  header band is `--el-surface-soft`, not a tint).
- **Shape** via element-semantic tokens (`--radius-card`/`-btn`/`-badge`/
  `-control`, `--shadow-subtle`/`-elevated`, `--spacing-chip-*`/`-control-*`/
  `-btn-x`/`-card-padding`, `--height-btn-sm`/`-control`). `rounded-full` only on
  the genuinely-circular state dot + avatar.
- **Not colour-alone** (finding #35): time remaining is **text** ("5 days
  remaining" / "Ended"), never colour; the state is a Pill with a **dot + word**;
  the points are **labelled numbers** (not a colour-coded bar); the "Ended"
  treatment pairs the peach tint with an alert glyph + the word.
- **Landmark + labels** — the sprint header is a labelled `<section>`; the points
  summary carries an `aria-label` naming the committed/completed/remaining
  figures so assistive tech reads them as a sentence; the loading header is
  `aria-busy`.
- **No nested buttons** — the header's only controls are the standalone
  Complete-sprint `<button>` and (in the board) the column `[⋯]` buttons; the
  empty-state CTA is an `<a>`; cards stay `<a>` (the 3.2 whole-card link). Every
  icon `<svg>` carries a 24×24 `viewBox`.

---

# Board filtering (Story 6.15) — `board-filter.mock.html`

Wires the board toolbar's permanently-**disabled `[Filter]` seam**
(`app/(authed)/boards/page.tsx`: "Filter is a disabled seam here — Epic 6 wires
board filtering", tooltip `filterComingSoon`) into a working board filter, and
points the 3.8.4 over-cap banner's "Refine filter" CTA at it. The board mocks
(`board.mock.html`, `board-scale.mock.html`, `swimlanes-wip.mock.html`,
`scrum.mock.html`) draw `[Filter]` ONLY as a disabled seam; the COMPOSITION on
the board — the enabled affordance, the builder + saved-picker anchored in the
board toolbar, the active-filter summary, the filtered + filtered-EMPTY states,
and coexistence with the 3.3 group-by `Segmented` + the 3.8 over-cap banner — is
net-new board chrome no board mock depicts. Per the design gate (an element a
mockup does not depict == NO design → add a `type: design` subtask, never
improvise), the 6.15.1 gate produces this; the UI code subtask **6.15.3**
`dependsOn` it.

This is **CHROME over the reused board**, exactly like `scrum.mock.html`: it
does NOT redraw columns / cards / drag / swimlanes / WIP — it adds the filter
affordances to the toolbar + a summary row above the columns, and shows the
board re-projected.

## Where it lives

The `/boards` route (`app/(authed)/boards/page.tsx` + `BoardContainer`). 6.15.3
drops `disabled` + the `filterComingSoon` tooltip from the existing `[Filter]`
`ToolbarButton`, mounts the reused filter UI beside the 3.3 group-by
`Segmented` (which already portals into `#board-toolbar-groupby-slot`), and the
read goes through **6.15.2** (`boardsService.getBoard` / `loadColumnCards`
threaded with a compiled 6.1 predicate). No new navigation wiring; no schema
change.

## REUSE, do not redraw — the primitives this composes (6.15.3 builds with)

Every filter affordance is the SAME shipped /items component, anchored on the
board toolbar — there is **no hand-rolled board-specific filter UI**:

- **`IssueFilterBar`** — the quick-filter popover (`[Filter]` trigger →
  `Popover`/`role="dialog"`): a text quick-filter + the **Kind / Work type /
  Status / Assignee** multi-select listboxes (`role="listbox"
aria-multiselectable`, each option a `role="option"` row with a leading glyph
  — `IssueTypeIcon` in the kind hue / `WorkItemTypeIcon` in the work-type hue /
  status dot / `Avatar` — and a trailing accent `Check`), plus the header
  **Clear filters**. (See `design/work-items/filter.mock.html`.)

  > **⚠️ NET-NEW in 6.15 — the Work type facet (the fix the user flagged).**
  > The quick filter shipped as a curated four-facet subset (text · kind ·
  > status · assignee); the **Work type** field (`WorkItemType` —
  > `code/design/test/content/research/review/decision/deploy/manual/chore` +
  > the nullable **"Untyped"** bucket) was reachable ONLY via `[Advanced]`. The
  > FilterAST + registry already define `type`
  > (`enumField('type','type-select',{ nullable:true, valueWhitelist:
WORK_ITEM_TYPES })`) and compile it — so the **grammar/compiler/board read
  > need NO change**; 6.15 adds the missing **quick-filter FACET** only (the
  > facet group + the `IssueFilter` facet state + `facetFilterToAst`). Because
  > `IssueFilterBar` is SHARED, the `/items` navigator gains the facet too.
  > Glyph + hue per `WORK_ITEM_TYPE_META` (`--el-type-{code…chore}`); the
  > "Untyped" bucket = the registry's `IS NULL` / not-empty pair, drawn with a
  > faint dashed-circle glyph (`--el-text-faint`). Owned by the new subtask
  > **6.15.5**; the design above (panel 1, the Work type group between Kind and
  > Status) is its layout authority. (The popover SCROLLS at a fixed
  > `max-height` — it does not grow to fit every facet; text + Kind + the start
  > of Work type are in view, Status / Assignee scroll below the fold.)

- **`IssueAdvancedFilter` / `FilterConditionBuilder`** — the `[Advanced]`
  builder trigger (`i-funnel-plus`), for the structured 6.1 condition builder.
  (See `design/work-items/filter-builder.mock.html`.)
- **`SavedFilterDropdown`** — the `[Saved]` dropdown picker
  (`role="listbox"`): **Starred → My filters → Project filters → Defaults**,
  server-backed search, a per-row **star toggle** (a SIBLING `<button>` in the
  option row — never nested inside the option), owner/visibility hint
  (`i-users` shared · `i-lock` private · "Built-in"), and a "View all filters"
  foot. (See `design/work-items/saved-filters.mock.html`.)
- **`IssueAppliedFilterBar`** — the applied-filter **summary row** between the
  toolbar and the columns: the lavender **name-chip** (`i-bookmark` +
  visibility glyph; clicking it reopens `[Saved]`) + the condition **`sum-chip`s**
  (`<strong>` field + operator + value) + **Clear** + a match-count
  (`role="status"`).
- **`Segmented`** (3.3 group-by), **`OverCapBanner`** (3.8), **`Button`**,
  **`EmptyState`** — the existing board/shared primitives the filter coexists
  with or reuses.

## The trigger states (identical to /items)

- **Inactive** — plain `ToolbarButton` (the seam's label/icon, now enabled).
- **Active** — `--el-accent` border + `--el-tint-lavender` fill + accent icon
  - the **count badge** (`.tb-count`, accent fill, `--el-accent-text`) = the
    number of active filter values. AA: the badge text is `--el-accent-text` on
    `--el-accent`; the button label stays `--el-text`.
- **Open** — `aria-expanded="true"` on the trigger; the popover/menu is an
  elevated `--shadow-elevated` card anchored under it.

## URL-driven, board-scoped state (6.15.3)

The active filter lives in the **URL** — a `?filter=` AST param and/or a
saved-filter id — composing with the existing `?board=<id>` selection (the
3.7 board-selection / 2.5.19 `?peek` URL-state pattern). So it is shareable +
reload-safe, and **per board**: switching boards does not leak the filter. The
board re-projects server-side via 6.15.2; the UI waits on the board read
response before asserting cards (never races the optimistic UI — CLAUDE.md).

## Panels (review EACH, not just the first)

0. **Closed** — toolbar = group-by `Segmented` + enabled `[Filter]` +
   `[Advanced]` + `[Saved]` + `[New issue]`; full board, full column counts.
1. **Quick-filter popover open** — `IssueFilterBar` anchored under `[Filter]`:
   text + Kind / **Work type** (the 6.15 net-new facet — 10 types + Untyped) /
   Status / Assignee listboxes + Clear.
2. **Saved dropdown open** — `SavedFilterDropdown` anchored under `[Saved]`:
   Starred/My/Project/Defaults groups + star toggles + "View all filters".
3. **Active** — the `[Filter]` count badge, the `IssueAppliedFilterBar`
   summary row (name-chip + condition chips + Clear + "5 of 28 cards match"),
   the board **re-projected** so each column shows only matching cards (counts
   drop; a column with no match shows the dashed `col-empty` placeholder).
4. **Filtered-EMPTY** — no card matches → a **distinct `EmptyState`** ("No work
   items match this filter" + `i-search-x` glyph + a **Clear filter** CTA), NOT
   the 3.2 brand-new-board empty (which offers "New issue"). The summary +
   active toolbar stay so the user can see/edit what they filtered on.
5. **Over-cap coexistence** — the 3.8 yellow `OverCapBanner` whose "Refine
   filter" CTA is now an **enabled** `<button>` opening the filter (was the
   disabled `.tr-seam` with `cursor: not-allowed`). The cap / `truncated` are
   computed over the FILTERED set (6.15.2), so a filter that brings the set
   under the cap dismisses the banner.

## Scope (out of scope here)

The filter **grammar/compiler** (6.1 owns it — no change); **cross-project**
boards (still the 3.7 Epic-6 extension); altering the **4.5 Scrum** sprint-scope
filter (the board filter `AND`-composes WITH it, narrowing WITHIN the active
sprint, never widening it).

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the active-trigger
  `--el-tint-lavender` fill + `--el-accent` border/icon, the count badge
  `--el-accent` / `--el-accent-text`, the name-chip `--el-tint-lavender` +
  `--el-text-strong`, the reused type hues (`--el-type-*`) + priority/status
  `Pill` tones, the over-cap `--el-tint-yellow` tray with `--el-warning` glyph.
  Tints carry the hue in the BACKGROUND with `--el-text-strong` text (finding
  #35 AA — never a tinted page surface).
- **Shape** via element-semantic tokens (`--radius-card` popover/menu/tray ·
  `--radius-btn` triggers/CTA · `--radius-input` search fields ·
  `--radius-badge` chips/count · `--radius-control` option rows/star),
  `--shadow-elevated` for the open popover/menu, `--spacing-control-*` /
  `-chip-*` / `-icon-btn` / `-card-padding` for box padding,
  `--height-control` / `-btn-md` for sizing. `rounded-full` only on the
  genuinely-circular status dot + avatar.
- **No nested buttons** (axe `nested-interactive`) — the `[Saved]` option row
  is a `role="option"` div whose star toggle is a SIBLING `<button>`; the
  applied name-chip is a standalone `<button>`; the Clear / Refine-filter / CTA
  are standalone `<button>`s; cards stay `<a>` (the 3.2 whole-card link). Every
  icon `<svg>` carries a 24×24 `viewBox`.
- **Listbox a11y** — the quick-filter facets are `role="listbox"
aria-multiselectable="true"` with `role="option" aria-selected`; the empty
  filtered board uses `EmptyState`/`role="status"`, not an empty listbox
  (combobox-empty-listbox a11y). Keyboard-operable throughout; the strict axe
  sweep (closed / open builder / saved picker / active chips / filtered-empty)
  is the 6.15.4 gate.
- **next-intl en + zh** — every new string (the summary copy, the filtered-empty
  EmptyState, the over-cap CTA) is keyed; the `filterComingSoon` key is dropped
  when the seam is enabled (6.15.3).

---

# Implemented — the eighth board column (Story MOTIR-2999 · MOTIR-3002)

Design reference for the **`implemented` status**: a new default-workflow status
between In Progress and In Review, the board column it arrives in, and the status
chip it renders as on every surface a status is shown. Asset:
**`implemented-column.mock.html`** (+ `implemented-column.png`). It is the source
of truth for **MOTIR-3003** (the status, its edges and the backfill), and the
chip/dot half binds any card that renders the new status.

It **EXTENDS** `design/boards/board.mock.html` (3.2.1) and
`design/boards/board-scale.mock.html` (3.8.1). It redraws neither: no column,
card, lane, load behaviour or drag affordance changes here. What is new is one
column, one chip tone, and one token.

## ⚠️ It is the EIGHTH column, not the seventh — the card's premise is one status stale

MOTIR-3002 says _"a seventh column arrives"_ and _"the existing mock is drawn at
six."_ Both were true when `board.mock.html` was drawn and are not true now.
`lib/workflows/defaultWorkflow.ts` ships **seven** statuses today — `todo ·
blocked · in_progress · planning · in_review · done · cancelled` — because
MOTIR-2425 added `planning` (in the `in_progress` category, for the same
structural reason `implemented` needs: a card must leave the pickable set), and
`prisma/migrations/20260807220000_add_planning_default_status/migration.sql`
gave it a board column on every existing project. So `implemented` is the
**eighth** status and the **eighth** column, and the card's criterion "the mock
renders the board at SEVEN columns" is amended on the record to EIGHT. Nothing
else in the card changes: every other criterion reads the same at eight.

## Where `implemented` goes — slot 4, before Planning

Both placements satisfy MOTIR-2999's "positioned between `in_progress` and
`in_review`". The **fold decides**, and the measurement is in panel 1: slot 4 is
the last column a laptop shows, and slot 5 is off-screen at every laptop width.

- **`implemented` is inserted immediately after `in_progress`, before
  `planning`.** The happy path (`in_progress → implemented → in_review`) is the
  path every card walks, so it takes the visible slot; `planning` is an
  exceptional off-ramp whose own review surface is the plan queue, not the board.
- **Nothing existing is reordered.** This is ONE insert. Position:
  **`in_progress.position || 'F'`** — exactly the shape `planning` used
  (`in_progress.position || 'V'`), and `'a2' < 'a2F' < 'a2V'` lexicographically,
  so the new row sorts between them with no write to any other status. In the
  seed, `implemented` is inserted into `STATUS_ORDER` directly after
  `in_progress` and the positions generate themselves.
- A project whose statuses were reordered gets a well-ordered row, not
  necessarily the same literal key a fresh project would have — the same
  documented, invisible divergence the `planning` migration accepted.

## The fold — MEASURED, in this asset

| Viewport                    | Rail  | Content width | Columns fully visible | Implemented (slot 4) |
| --------------------------- | ----- | ------------- | --------------------- | -------------------- |
| 1280 × 800                  | 240px | 976px         | 3                     | 63px sliver          |
| 1366 × 768                  | 240px | 1062px        | 3                     | 149px sliver         |
| 1440 × 900                  | 240px | 1136px        | 3                     | 223px sliver         |
| 1512 × 982                  | 240px | 1208px        | 4                     | **FULL**             |
| 1920 × 1080                 | 240px | 1616px        | 5                     | **FULL**             |
| 1440 × 900 · rail collapsed | 56px  | 1320px        | 4                     | **FULL**             |

Read off a Chromium render of panel 1's frame set to each content width, with
every column's `getBoundingClientRect()` compared to the frame's box — not
derived. The inputs are the shipped ones: a column is `w-72` (288px, `shrink-0`)
in a `gap-4` row (`app/(authed)/boards/_components/BoardColumn.tsx` ·
`app/(authed)/boards/_components/BoardContainer.tsx`), inside the shell's
`lg:px-8` gutters beside a 240px rail — 56px collapsed —
(`components/ui/AppLayout.tsx` · `app/(authed)/layout.tsx`). Each column costs
**304px**; the count that fits is `floor((content + 16) / 304)`.

**What gives: nothing, and that is the finding.** The board is already a
horizontally-scrolling row, and six columns did not fit a laptop either — the
eighth column adds scroll distance, not a new failure mode. What it does change
is which statuses a reader sees without scrolling, which is a placement decision
(above), not a layout one. The board's existing answers to a long board are
unchanged and are enough: the rail collapses, the board scrolls and snaps
(`snap-x snap-proximity`), and Epic 6's board filter narrows it.

**The invariant for the build card:** `implemented` occupies slot 4. A later
status inserted before it moves it to slot 5, which the table above says is
off-screen on every laptop — so that insert is a fold decision, not a position
string.

## The chip — one new tone, `--el-status-implemented`

**The defect first.** The shipped status chip is keyed on the lifecycle
**CATEGORY**, not the status: `STATUS_TONE` in
`app/(authed)/items/_components/issueCellPrimitives.tsx` maps
`todo → planned · in_progress → in-progress · done → done` onto `Pill`'s three
status tones. `implemented` is in the `in_progress` category, so **without a new
tone it renders byte-identically to In Progress, Planning AND In Review** — four
statuses, one chip. Panel 2 draws that from the real component. It is exactly
what MOTIR-2999's criterion rules out.

**The recipe is already written down.** `packages/design-system/theme.css`'s
`--el-status-*` block says: _"The status DOT uses the hue at full strength; a
status CHIP bg = `color-mix(var(--el-status-X) 14%, var(--el-surface))` with
`--el-text-strong`."_ The shipped `Pill`'s `priority` variant already renders
exactly that. So the chip is not a new invention — it is the documented
per-status recipe, spent on one new tone.

| Element                          | Colour                                                                           | Shape                                  |
| -------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| Implemented chip fill            | `color-mix(in srgb, var(--el-status-implemented) 14%, var(--el-surface))`        | `--radius-badge`, `--spacing-chip-x/y` |
| Implemented chip ink             | `--el-text-strong` (AA on the tint — finding #35)                                | —                                      |
| Implemented chip border          | `transparent` (as every other `Pill` tone)                                       | —                                      |
| Implemented chip glyph           | `currentColor` (`CircleEllipsis`, `h-3 w-3`, `aria-hidden`)                      | —                                      |
| Status DOT (picker / filter)     | `var(--el-status-implemented)` at full strength                                  | `rounded-full`, 10px                   |
| Column header, card, count badge | unchanged — `--el-surface` / `--el-border` / `--el-count-bg` / `--el-count-text` | `--radius-card` / `--radius-badge`     |

**The token.** `--el-status-implemented` is a new Tier-3 token mapped to
`var(--color-accent)` — pink. It is the one saturated Tier-0 hue no other STATUS
spends (`todo` stone · `blocked` warning · `in_progress` info · `planning`
accent-teal · `in_review` primary · `done` success · `cancelled` steel), and
sharing a hue ACROSS families is the system's own convention — `--el-type-epic`
is also `--color-accent`. Riding a Tier-0 var means every palette re-skins it
with no per-palette block, exactly as the `--el-status-*` block's header
prescribes.

> **⚠️ FIVE palettes need an override — AMENDED by MOTIR-3003, on the
> measurement.** This asset first named `sienna` alone, which is what the base
> palette shows when read on its own and is wrong across the ten. The shipped
> guard `tests/theme/statusHueSeparation.test.ts` holds every pair of status hues
> at ΔE2000 ≥ 10 in all ten palettes × both themes, and it reports FIVE
> collisions for `--color-accent`: **amber** (vs `in_review`), **candy** (vs
> `planning`), **citrine** (vs `in_progress`), **graphite** (vs `in_progress`)
> and **sienna** (vs `blocked`, which re-maps onto `--color-accent` there).
> Each now carries its own `--el-status-implemented`, declared in BOTH themes so
> the light value cannot cascade into dark: amber takes its unspent red, the
> other four take the ink step. Measured nearest-neighbour distances:
> amber 21.2 / 33.7 · candy 20.0 / 16.2 · citrine 17.8 / **10.0** · graphite
> 15.9 / 11.8 · sienna 21.1 / 22.6 — and the base stays pink at 33.2 / 26.2.
> Citrine's dark figure sits exactly on the floor, so a palette change that moves
> either hue needs re-measuring rather than nudging.

**And the glyph is what carries it, not the hue.** The Implemented chip renders
`CircleEllipsis` — the SAME glyph the shipped CI-running pill uses
(`components/github/DevelopmentSection.tsx`, `CI_META.running`), which is
literally what a card at Implemented is waiting for. In Review stays unglyphed. A
14% tint is a subtle mark by construction, and finding #35 forbids resting a
state on colour alone; the glyph makes the distinction survive any tint strength,
any palette, and any colour vision. **A glyph on this ramp means "a machine is
still working."**

**The dot** is `statusDotColor` (`lib/workflows/statusColor.ts`), which resolves
by status KEY and falls back to the CATEGORY. Without a `STATUS_KEY_EL` entry for
`implemented` the option dot is `--el-status-in-progress` and is indistinguishable
from In Progress — the exact collapse MOTIR-1273 un-did for `in_review` and
MOTIR-2425 re-avoided for `planning`. **`STATUS_KEY_EL.implemented →
'--el-status-implemented'` is owed alongside the token.**

## The three surfaces (panel 4)

- **The list row** — `StatusValue` renders the chip, so the `/items` Status cell
  takes the new tone with no further work. Drawn on the real `IssueListTable`.
- **The detail page's status control** — `StatusPicker` is a `Combobox` over the
  LEGAL targets under the `restricted` policy. Drawn open at `implemented`,
  showing exactly the edges MOTIR-2999 asks for: In Review, In Progress, Blocked,
  Done, Cancelled.
- **The board** — a board card carries **no** status chip, because the COLUMN is
  the status. The one status-derived chip a board card does carry is "Awaiting
  acceptance" (`app/(authed)/boards/_components/BoardCard.tsx`), and that belongs
  to In Review. So on the board the Implemented chip appears where the board's own
  status chip appears: the quick view a card opens, and the column header the card
  sits under.

> **⚠️ A defect this asset found and does NOT fix: `MOTIR-3080`.** Rendering the
> real `StatusPicker` measured its status dot at **2 × 18px**, not 10 × 10 — the
> dot is a bare `<span>` inside `Combobox`'s icon wrapper, and only the WRAPPER is
> blockified, so the dot stays `display: inline` and its box never applies. The
> mock corrects it in one stylesheet rule (a design draws the target); the fix
> belongs to MOTIR-3080, not to this story.

## CI at Implemented — ~~the board shows nothing, deliberately~~ SUPERSEDED (MOTIR-5471)

> **⚠️ THIS SECTION IS A RECORD, NOT THE SPEC.** It deferred the CI signal on a board card and
> named the follow-up: _“Surfacing failure ON the board is a board-projection card.”_ That card is
> **MOTIR-5469**, and its design is **§ _The CI badge (MOTIR-5471)_** below, drawn in
> `board-card--ci-badge.mock.html`. Read that section for what the board now shows. The paragraphs
> that follow are kept because the REASONING is still correct about the moment it was written —
> `BoardCardDto` carried no CI field then, and adding one was outside MOTIR-2999's scope.

The card asks whether a board card at Implemented surfaces anything about checks.
**It does not**, and the reason is a boundary, not an oversight: `BoardCardDto`
(`lib/dto/boards.ts`) carries no CI field, and adding one is a change to the board
PROJECTION — outside MOTIR-2999's own stated scope, which ends at "one card's
status lifecycle". The board already answers the operator's question
structurally: a card in Implemented is built and waiting on checks; a card in In
Review is green.

**What that leaves unanswered is a RED build.** MOTIR-2999 leaves a failed card at
`implemented`, so "checks running" and "checks failed" share a column. The verdict
is one click away — the item's Development section renders the shipped CI pill, and
`lib/services/changeRequestCiFeedback.ts` already posts the per-head-sha comment
saying which check failed. **Surfacing failure ON the board is a board-projection
card and is not this story's** (see below).

## What this asset does NOT specify (named, so nobody infers it)

1. **Re-toning the whole status ramp.** The per-status chip recipe applied to all
   eight statuses would also un-collapse In Progress / Planning / In Review from
   each other, which is a real improvement and a change to every status chip on
   every surface. This asset spends the recipe on ONE tone, because that is what
   MOTIR-2999's criterion needs. Panel 3 draws the whole ramp under the recipe so
   the option is visible and costed — it is a separate card, owned by nobody yet.
2. ~~**A CI signal on the board card.** Needs a projection field; see above.~~
   **SUPERSEDED (MOTIR-5471)** — it is specified in § _The CI badge (MOTIR-5471)_ below, and the
   projection field it needed is `BoardCardDto.ciState`, which MOTIR-5474 adds.
3. **The `sienna` palette override**, which is a one-line follow-up on the token
   card if `implemented` ships before it.
4. **Swimlanes, scrum and the board-config admin** — an eighth status reaches all
   three through the same column mapping, and none of their layouts change.

## How this asset was produced (reproduce it, don't cite it)

Nothing here was redrawn from a reading of the code. Every column, card, chip,
list row and picker is the **real component's own markup**, and the stylesheet is
Tailwind's **real compiled output** — so the asset cannot drift from what the app
renders. The harness is temporary by construction (a design PR ships `design/**`
only), so it is reproduced here rather than cited:

1. **Dump the markup.** A throwaway spec under `tests/components/` renders
   `BoardColumn` (once per status), `StatusValue`, `StatusPicker` (closed and
   `autoOpen`), `IssueListTable` and `Pill` through the repo's own
   `renderWithIntl` helper (`tests/helpers/renderWithIntl.tsx`) and
   `writeFileSync`s `container.innerHTML` per state. The open `Combobox` listbox
   is PORTALED, so that one dumps `document.body.innerHTML`. Fixture shapes are
   the ones `tests/components/board-column.test.tsx` and
   `tests/components/issue-list-view.test.tsx` already use, including their
   `next/navigation` + edit-action mocks and the happy-dom pointer/ResizeObserver
   shims.
2. **Run it under a throwaway Vitest config** — `environment: 'happy-dom'`, no
   `globalSetup` (the root config provisions a Postgres per worker), and the `@`
   - `server-only` aliases copied from the root config. Some imported modules read
     env at import time, so it runs with placeholder `DATABASE_URL` / auth secrets;
     no database is touched.
3. **Compile the real CSS.** `@import 'tailwindcss' source(none);` +
   `@source` the assembled page + `@import '@motir/design-system/theme.css'`,
   through `@tailwindcss/postcss`. ~100KB carrying the Tier-0, dark-flip and
   Tier-3 layers verbatim, inlined into the mock — the mock's stylesheet IS
   Tailwind's real output, so no token is ever retyped.
4. **Assemble, `prettier --write`, then render** — the PNG is exported AFTER the
   format pass, full-page, light theme, `deviceScaleFactor: 2`, viewport 1200.

The only edits made to the dumped markup are the two the panels name: the
Implemented row's status cell carries the SPECIFIED chip rather than today's, and
the status dot is corrected per MOTIR-3080. Both are called out in the mock at the
point of use.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the new
  `--el-status-implemented` (mapped to a Tier-0 `--color-*`, never a literal), the
  14% `color-mix` chip tint over `--el-surface` with `--el-text-strong` ink, and
  the reused `--el-status-*` ramp for the dots. No raw hex, `rgb()`, named colour
  or fixed `rounded-*` / `p-*` / `h-*` appears in the product markup of the mock.
- **Shape** via element-semantic tokens — `--radius-badge` + `--spacing-chip-x/y`
  for the chip, `--radius-card` for the column and the open menu,
  `--radius-control` + `--spacing-control-x/y` + `--height-control` for the picker
  trigger and its option rows. `rounded-full` only on the genuinely-circular
  status dot and avatar.
- **Not colour-alone** (finding #35): Implemented pairs its tint with the
  `CircleEllipsis` glyph and its label; the glyph is `aria-hidden`, so the
  accessible name stays the status label.
- **AA**: every chip carries `--el-text-strong` on a 14% tint over `--el-surface`
  — the measured-safe pairing; no `--el-text-muted` on a tinted surface anywhere
  in the product markup.
- **The picker** keeps the shipped `role="combobox"` / `role="listbox"` /
  `role="option"` structure and its `aria-activedescendant`; the eighth status
  adds an option, not a control.

---

## The streaming allocation at ARRIVAL — `/boards` (MOTIR-3442)

Part of [MOTIR-3440](motir:cmt8s085i003li1ph06u469kx)'s sweep of the 24 heavy authed surfaces. The
rule this applies is `design/shell/design-notes.md` § _The navigation-pending grammar_ →
_WHICH SURFACES EARN A FRAME_, and the three-tier method is
`design/work-items/design-notes.md` § _The item page at ARRIVAL_'s. **Neither is restated here.**
Measured against `origin/main` `9455fc3c`.

|                            |                                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the gate**               | `getSession` → `getTranslations('boards')` → `getActiveProject` → `getCapabilities` (`canBrowse`)                                                                                                                                        |
| **with the frame**         | the `<h1>` + subtitle, and the **`BoardSwitcher`**, which owns its own board-list fetch and its own `?board=` selection — its own header comment says it stays present across the board's loading, error and empty states                |
| **with the first content** | the seven-way `Promise.all` (members, workflow, sprints, custom fields, components, referenced labels, saved-filter capabilities) — **already one wave** — which feeds the filter chrome and the group-by control                        |
| **after the page**         | the board columns themselves: `BoardContainer` fetches its own projection client-side                                                                                                                                                    |
| **settles**                | **twice, and legitimately** — the filter chrome, then the columns. The second settle is the canvas's own and predates this story                                                                                                         |
| **verdict**                | **NONE — reuse.** `app/(authed)/boards/_components/BoardSkeleton.tsx` is already the drawn pending state for the column region and is what the board shows today. This asset does not redraw it, and the code card composes it unchanged |

> ## ⚠️ AMENDMENT — 2026-08-26, MOTIR-3445. THE CITED SKELETON COVERS A TIER THIS SWEEP DOES NOT TOUCH.
>
> The entry's verdict — **NONE** — stands, and so does every tier. What it implies about the code
> card does not. `BoardSkeleton` is imported by `app/(authed)/boards/_components/BoardContainer.tsx`
> and by nothing else: it is the client island's own pending state for the COLUMN region, which is
> tier 3, and it is already composed there. There is nothing for a server-side boundary to do with
> it, and the card composes it "unchanged" by leaving it alone.
>
> The tier-2 region — the seven-way filter-chrome wave — has **no drawn stand-in**, so no boundary
> is added around it either. MOTIR-3445 therefore ships **no diff** for this page: its seven reads
> were already one wave, which is the finding the entry states correctly.

**Nothing here is serial**, which is the finding: the count of seven awaits is the `Promise.all`'s
own members. The only change this surface takes from the story is the boundary that lets the header
and the switcher paint before the filter chrome resolves.

**A route boundary is declined as a preference** — `/boards` does not call `notFound()`.

---

# Approved — the ninth board column (Story MOTIR-4905 · MOTIR-5138)

Design reference for the **`approved` status**: a new default-workflow status
between In Review and Done, in the **`in_progress` category**, the board column it
arrives in, and the chip it renders as on every surface a status is shown. Asset:
**`approved-column.mock.html`** (+ `approved-column.png`). It is the source of
truth for **MOTIR-5139** (the status, its edges and the backfill) and
**MOTIR-5141** (the chip, the token, the canvas tint and the glyph).

It **EXTENDS** `design/boards/board.mock.html` (3.2.1) and
`design/boards/implemented-column.mock.html` (MOTIR-3002), which is this asset's
template in both shape and method. It redraws neither: no column, card, lane,
load behaviour or drag affordance changes here. What is new is **one column, one
chip tone, one canvas tint and one glyph**.

## Where `approved` goes — slot 7, and the slot-4 invariant survives

The slot is settled by the record, not by this asset:
[MOTIR-4911](motir:cmtt4oguv000ihutxbryd9iz2) amended
`docs/decisions/approval-gates.md` to put `approved` between `in_review` and
`done`. This asset measures the CONSEQUENCE and leaves the decision alone.

- **`approved` is inserted immediately after `in_review`, before `done`** — slot
  7 of nine. **Nothing existing is reordered.** This is ONE insert, the same
  shape `planning` and `implemented` used: position `in_review.position || 'F'`,
  which sorts between `in_review` and `done` with no write to any other status.
- **The eighth column's invariant HOLDS.** That section pinned _"`implemented`
  occupies slot 4. A later status inserted before it moves it to slot 5, which
  the table above says is off-screen."_ This insert is at slot 7, **after**
  `implemented`, so it does not move it. Re-measured below rather than asserted.

## The fold — RE-MEASURED at nine columns, against eight

| Viewport                    | Rail  | Content | Fully visible (8 → 9) | Implemented (slot 4) | Approved (slot 7) | Scroll distance (8 → 9) |
| --------------------------- | ----- | ------- | --------------------- | -------------------- | ----------------- | ----------------------- |
| 1280 × 800                  | 240px | 976px   | 3 → 3                 | 64px sliver          | off-screen        | 1440px → 1744px         |
| 1366 × 768                  | 240px | 1062px  | 3 → 3                 | 150px sliver         | off-screen        | 1354px → 1658px         |
| 1440 × 900                  | 240px | 1136px  | 3 → 3                 | 224px sliver         | off-screen        | 1280px → 1584px         |
| 1512 × 982                  | 240px | 1208px  | 4 → 4                 | **FULL**             | off-screen        | 1208px → 1512px         |
| 1920 × 1080                 | 240px | 1616px  | 5 → 5                 | **FULL**             | off-screen        | 800px → 1104px          |
| 1440 × 900 · rail collapsed | 56px  | 1320px  | 4 → 4                 | **FULL**             | off-screen        | 1096px → 1400px         |

Read off a Chromium render at each content width, every column's
`getBoundingClientRect()` compared to the scroll frame's box — not derived. The
inputs are the shipped ones: a column is `w-72` (288px, `shrink-0`) in a `gap-4`
row (`app/(authed)/boards/_components/BoardColumn.tsx` ·
`app/(authed)/boards/_components/BoardContainer.tsx`), inside the shell's
`lg:px-8` gutters beside a 240px rail — 56px collapsed
(`components/ui/AppLayout.tsx` · `app/(authed)/layout.tsx`). Each column costs
**304px**. The board is measured at EIGHT and at NINE so the delta is the
finding rather than the absolute.

> The slot-4 figures are 1px larger than the eighth column's own table (64 vs 63,
> 150 vs 149, 224 vs 223). That is border-box accounting in the measuring frame,
> not a layout change: the geometry, the formula and every verdict are identical.

**What gives: nothing, and that is the finding.** The fully-visible column count
is **unchanged at every measured viewport** — 3 → 3, 4 → 4, 5 → 5.
`approved` at slot 7 is off-screen everywhere, exactly as `done` and `cancelled`
already were at slots 7 and 8 before it. **The only cost is +304px of scroll
distance**, one column's worth. The board's existing answers to a long board are
unchanged and are enough: the rail collapses, the board scrolls and snaps
(`snap-x snap-proximity`), and Epic 6's board filter narrows it.

**The invariant for the build cards, restated for the next insert:** `approved`
occupies slot 7 and `implemented` still occupies slot 4. A status inserted
BEFORE `implemented` still moves it to the off-screen slot 5 — that remains a
fold decision, not a position string.

## The chip — `--el-status-approved`, MEASURED

**The defect first, and it is not the one the card described.** The shipped
`StatusPill` (`components/issues/StatusPill.tsx`) resolves a tone by status KEY
and falls back to the lifecycle CATEGORY, and its `TONE_BY_STATUS_KEY` holds
**exactly one** entry — `implemented`. So a new `in_progress`-category status
renders byte-identically to In Progress, Planning and In Review. Panel 2 draws
that from the real component: all four resolve to `bg-(--el-tint-sky)`.

> **⚠️ AMENDMENT on the record.** MOTIR-5138's own description names the collapse
> set as _"In Progress, Planning, **Implemented** and In Review"_. `implemented`
> is the one status that does NOT collapse — MOTIR-3103 gave it the only
> per-status tone, which is precisely why it exists. The real set is **In
> Progress · Planning · In Review**, which `approved` would join. Nothing else in
> the card changes: the conclusion (a category-only treatment is unacceptable
> here) is unaffected, and the count of statuses rendering one chip is still four
> once `approved` lands.
>
> **And In Progress / Planning / In Review stay collapsed with each other.** That
> is the pre-existing gap the eighth column's asset recorded as _"a separate card,
> owned by nobody yet"_, and this story does not close it.

**The token.**

```css
--el-status-approved: color-mix(in srgb, var(--color-success) 30%, var(--color-ink));
```

The `done` green, one ink step deeper. **Approved is the same family as Done
because it is the same answer one rung earlier; it is DEEPER because it has not
shipped.** It rides Tier-0 `--color-success` and `--color-ink` — never a literal
— so every palette re-skins it with no per-palette block, which is what the
`--el-status-*` block's own header prescribes.

**Measured, not proposed**, through `tests/theme/statusHueSeparation.test.ts`'s
own resolver (`loadTokenLayer` / `resolveValue` / `deltaE2000` / `contrast`), so
the numbers below are the numbers that suite will compute:

| Palette       | light     | dark      | nearest status, ΔE2000 | vs `done`, ΔE2000 | min contrast |
| ------------- | --------- | --------- | ---------------------- | ----------------- | ------------ |
| motir (base)  | `#1a4623` | `#b2dfbd` | 28.2                   | 20.1              | 9.92         |
| cobalt        | `#123b37` | `#b1e1d0` | 16.5                   | 16.7              | 10.95        |
| graphite      | `#17382b` | `#b5dec9` | 17.4                   | 17.4              | 11.24        |
| **evergreen** | `#40366c` | `#cec7f0` | 12.3                   | 38.8              | 9.54         |
| spectrum      | `#194031` | `#b5dfd0` | 15.3                   | 17.4              | 10.41        |
| amber         | `#143d31` | `#a8e2ce` | **11.6**               | 15.5              | 10.87        |
| sienna        | `#1d3c2c` | `#bbe6c3` | 14.7                   | 14.7              | 10.73        |
| garnet        | `#0f3124` | `#b5e1cd` | 13.9                   | 16.1              | 12.11        |
| citrine       | `#0c2b27` | `#cbe3c7` | 14.3                   | 18.3              | 12.59        |
| candy         | `#243c2c` | `#c9e5cf` | 14.2                   | 14.2              | 10.35        |

**All twenty palette × theme contexts clear the suite's floor of ΔE2000 10.**
Global minimum **11.6** (amber/dark vs `planning`); against `done` specifically
the range is **14.2 – 42.6**. Contrast is **9.54 – 13.72:1** on `--el-card`,
`--el-surface` and `--el-page-bg`, against the 3:1 bar — so no
`KNOWN_SUB_BAR` entry is owed.

> **The ratio was chosen by sweep, not by eye.** At 35% the worst pair is ΔE 10.1
> — on the floor, the same razor margin citrine's `implemented` carries. At 25%
> citrine/light collides with `implemented` at 9.8. **30% is the interior of that
> window**, at 11.6. A palette change that moves `--color-success` or
> `--color-ink` needs re-measuring rather than nudging.

**ONE palette needs an override.** `evergreen` is green-and-jade throughout, and
its `in_review` is a deep jade a deep green cannot clear (6.9 light / 3.6 dark).
It takes its own unspent violet:

```css
[data-palette='evergreen'] {
  --el-status-approved: color-mix(in srgb, var(--color-accent) 40%, var(--color-ink));
}
[data-theme='dark'] [data-palette='evergreen']:not([data-theme]),
[data-palette='evergreen'][data-theme='dark'] {
  --el-status-approved: color-mix(in srgb, var(--color-accent) 40%, var(--color-ink));
}
```

**Declared in BOTH themes**, which is not a formality: `[data-palette='x']` and
the base `[data-theme='dark']` tie on specificity and the palette blocks come
later, so a status override written only in a palette's light block silently
leaks onto its dark canvas. That suite's cascade-pairing test enforces it, which
is why several shipped blocks carry what looks like a no-op. Measured at 14.3 /
12.3.

**This is one override where `implemented` needed five** — the deep-green step
is unspent in nine of the ten palettes.

### ⚠️ The CHIP is a different measurement from the DOT — with a control

The floor above is on the **dot**, which paints the hue at full strength. A
**chip** is that hue at **14% over `--el-surface`**, so every chip in this product
compresses into a narrow band. Approved's chip is nearest `done`'s at **ΔE2000
5.7** (sienna/light), with `--el-text-strong` ink at **7.59 – 11.97:1**.

That number is meaningless without a control, so: **the chip set the product
ALREADY ships has a global minimum of ΔE 2.8** (citrine/dark, `planned` vs
`in-progress`). **Approved's worst pair is twice as separated as the worst pair
on the board today.**

**This is why the glyph is load-bearing rather than decorative.** At 14% no
status on this ramp is told apart by tint alone — the position `StatusPill`'s own
header already takes. **Do not read the dot's ΔE 11.6 as a claim about the chip.**

### The chip's recipe, element by element

| Element                          | Colour                                                                 | Shape                                  |
| -------------------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| Approved chip fill               | `color-mix(in srgb, var(--el-status-approved) 14%, var(--el-surface))` | `--radius-badge`, `--spacing-chip-x/y` |
| Approved chip ink                | `--el-text-strong`                                                     | —                                      |
| Approved chip border             | `transparent` (as every other `Pill` tone)                             | —                                      |
| Approved chip glyph              | `currentColor` (`CircleCheck`, `h-3 w-3`, `aria-hidden`)               | —                                      |
| Status DOT (picker / filter)     | `var(--el-status-approved)` at full strength                           | `rounded-full`, 10px                   |
| Canvas node chip                 | `--el-tint-sage` fill, `--el-text-strong` ink, `CircleCheck`           | the canvas chip's own shape            |
| Column header, card, count badge | unchanged — `--el-surface` / `--el-border` / `--el-count-bg`           | `--radius-card` / `--radius-badge`     |

### The glyph, and the labels

**`approved` carries `CircleCheck`; `done` keeps `Check`.** The same mark,
formalised — a person put a ring around it — and it joins the `Circle*`
vocabulary this ramp already speaks (`CircleDot` · `CircleDotDashed` ·
`CircleEllipsis` · `CircleDashed`). Finding #35 forbids resting a state on colour
alone, and at a 14% tint that is not a formality but the actual mechanism.
**In Review stays unglyphed**, as it is today.

**Labels: `en` “Approved”, `zh` “已批准”.** Not a new coinage — that is the exact
string this product already ships for an approval, in `acceptance.status.approved`
and `planReview.status_approved`.

## The dot — `STATUS_KEY_EL.approved` is owed alongside the token

`statusDotColor` (`lib/workflows/statusColor.ts`) resolves by status KEY and falls
back to the CATEGORY. **Without a `STATUS_KEY_EL` entry the Approved option dot is
`--el-status-in-progress`** and is indistinguishable from In Progress and In
Review **in the one control a person uses to SET the status**. Panel 4 draws the
real `StatusPicker` and the blue dot is visible in it. This is the same collapse
MOTIR-1273 un-did for `in_review` and MOTIR-2425 re-avoided for `planning`:

```ts
STATUS_KEY_EL.approved = '--el-status-approved';
```

## The canvas — the `--el-tint-*` family is EXHAUSTED, and `approved` is what breaks it

The canvas node speaks a DIFFERENT chip language from the item page: the flat
six-member `--el-tint-*` family, deliberately, because those are PALETTE tokens
whose author keeps them mutually distinct (`design/roadmap/design-notes.md`;
`lib/workflows/canvasStatusMeta.ts`). All six are spent — peach `blocked`, sky
`in_progress`, rose `implemented`, yellow `planning`, lavender `in_review`, mint
`done` — with `--el-muted` carrying `todo` and `cancelled`. That module's own
comment records `planning` taking _"the one remaining unspent tint."_

**So a SEVENTH tint is specified:**

```css
--el-tint-sage: color-mix(in srgb, var(--color-success) 26%, var(--color-surface));
```

with the `CircleCheck` glyph. Measured against the other six plus `--el-muted`
across all twenty contexts: **worst ΔE2000 6.0** (amber/light vs `--el-tint-mint`)
against this family's own floor of **2** (`MIN_DELTA_E_TINT`,
`tests/theme/familyHueSeparation.test.ts`), and worst ink contrast **6.43:1** for
`--el-text-strong`.

> **⚠️ THIS IS AN OBLIGATION MOTIR-5141 MUST ABSORB, AND IT IS NOT A ONE-LINER.**
> A new `--el-tint-*` row is a PALETTE token, so it is declared in the base and
> checked across ten palettes, and `design/roadmap/design-notes.md` owes a
> one-line amendment naming the seventh member of a family its own notes describe
> as six. **Falling through to the category instead is not an option:** that
> resolves to `--el-tint-sky` and collides with In Progress on the canvas — the
> same defect, on the surface where MOTIR-3170 last fixed it.
>
> **And the tint family is NOT under a measured floor the way the status ramp is.**
> `familyHueSeparation.test.ts` measures priority, label, avatar and selection —
> not `--el-tint-*`. So the ΔE 6.0 above is a measurement this asset performed by
> hand, and nothing in CI will re-perform it when a palette moves.

## The three surfaces, and where a ninth status reaches

- **The list row** — `StatusValue` renders `StatusPill`, so the `/items` Status
  cell takes the new tone with no further work.
- **The item page's status control** — `StatusPicker` is a `Combobox` over the
  LEGAL targets under the project's `restricted` policy. Panel 4 draws it open at
  **In Review**, so its option list IS this story's declared edge set: Approved,
  Done, In Progress, Blocked, Cancelled.
- **The board** — a board card carries **no** status chip, because the COLUMN is
  the status. The Approved chip therefore appears where the board's own status
  chip appears: the quick view a card opens, and the column header.

| Surface                | What it renders the status through     | Verdict                                                           |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Swimlanes              | The same `BoardColumn`, once per lane  | No layout change — a lane is a row of the same columns            |
| Scrum board            | The same columns under a sprint header | No layout change — the header is chrome over the reused board     |
| Board config (admin)   | A column ↔ status mapping row          | One more mapping row; the backfill gives every project the column |
| Unmapped-statuses tray | Any status with no column              | Empty for `approved` — the backfill maps it                       |

**`approved` has NO surface of its own and adds NO entry affordance.** It has no
route, no nav item and no button; it appears inside surfaces a person already
reaches — `design/boards/board.mock.html` (the board),
`design/work-items/` (the item page's status control) and `design/roadmap/` (the
canvas node). There is no access path to draw because there is no new door.

**The cardinality constraint this mock must not contradict:** a project's status
set is per-project and customisable, so the asset draws nine columns as the
DEFAULT workflow's shape and **never as a fixed count**.

## What this asset does NOT specify (named, so nobody infers it)

1. **Un-collapsing In Progress / Planning / In Review from each other.** Three
   statuses still share one chip; giving each its own tone is a real improvement
   and a change to every status chip on every surface. It was already named as
   out of scope by the eighth column's asset and is still owned by nobody.
2. **Anything that WRITES `approved`.** No gate, no Approve button, no decide
   door, no GitHub sync. MOTIR-4905's own boundary is explicit that the status
   creates no gate; the gate stories are `blocked_by` it.
3. **The ladder rung, the rollup and the readiness consequence** — MOTIR-5140's,
   and `docs/decisions/status-derivation.md`'s. Not drawn here at all.
4. **`design/roadmap/`'s amendment** for the seventh tint. Named above as an
   obligation; the amendment itself belongs with the card that ships the token.

## How this asset was produced (reproduce it, don't cite it)

Nothing here was redrawn from a reading of the code. Every column, card, chip,
list row and picker is the **real component's own markup**, and the stylesheet is
Tailwind's **real compiled output** — so the asset cannot drift from what the app
renders. The harness is temporary by construction (a design PR ships `design/**`
only), so it is reproduced here rather than cited:

1. **Dump the markup.** A throwaway spec under `tests/components/` renders
   `BoardColumn` (once per status, with real `BoardCardDto` fixtures),
   `StatusPill` (once per status) and `StatusPicker` (`autoOpen`) through the
   repo's own `renderWithIntl` helper (`tests/helpers/renderWithIntl.tsx`), and
   `writeFileSync`s `container.innerHTML` per state, calling RTL's `cleanup()`
   between renders. The open `Combobox` listbox is PORTALED, so that one dumps
   `document.body.innerHTML`. Fixture shapes are the ones
   `tests/components/board-column.test.tsx` already uses.
2. **Run it under a throwaway Vitest config** — `environment: 'happy-dom'`, the
   `actEnvironment` setup file only (the root config's `perWorkerDb` provisions a
   Postgres per worker), and the `@` + `server-only` aliases copied from the root
   config. Some imported modules read env at import time, so it runs with
   placeholder `DATABASE_URL` / `BETTER_AUTH_SECRET` / `GOOGLE_CLIENT_*`; no
   database is touched.
3. **Measure the hue.** A second throwaway spec imports `loadTokenLayer`,
   `declaredIn`, `resolveValue` (`tests/theme/paletteCascade.ts`) and
   `deltaE2000` / `contrast` / `mixSrgb` (`tests/theme/colorMetrics.ts`) — the
   SAME resolver `statusHueSeparation.test.ts` uses — and sweeps candidate
   expressions across `PALETTE_IDS × {light, dark}`. Every figure in this section
   comes from that sweep, including the ratio search and the shipped-chip control.
4. **Measure the fold.** A Playwright Chromium script builds a frame at the
   shipped geometry (288px `shrink-0` columns in a 16px-gap `overflow-x` row),
   sets the viewport to each content width, and reads every column's
   `getBoundingClientRect()` against the frame's box — at eight columns and at
   nine.
5. **Compile the real CSS.** `@import 'tailwindcss' source(none);` + `@source`
   the assembled page + `@import '@motir/design-system/theme.css'`, through
   `@tailwindcss/postcss`. ~127KB carrying the Tier-0, dark-flip and Tier-3
   layers verbatim, inlined into the mock — the mock's stylesheet IS Tailwind's
   real output, so no token is ever retyped.
6. **Assemble, `prettier --write`, then render** — the PNG is exported AFTER the
   format pass with `node scripts/render-design-mock.mjs
design/boards/approved-column.mock.html --width 2960`.

**The edits made to the dumped markup are two, and both are called out at the
point of use:** the SPECIFIED Approved chip (its tone and glyph do not exist in
`Pill` / `StatusPill` yet — building them is MOTIR-5141's), and a
presentation-only `position: static` on the portaled listbox so it renders inside
its panel on a static sheet instead of at the viewport origin.

## Token / a11y rules honoured

- **Colour** strictly via `--el-*` (finding #54): the new `--el-status-approved`
  and `--el-tint-sage`, both mapped to Tier-0 `--color-*` steps and never a
  literal; the 14% `color-mix` chip tint over `--el-surface` with
  `--el-text-strong` ink; and the reused `--el-status-*` ramp for the dots. No
  raw hex, `rgb()`, named colour or fixed `rounded-*` / `p-*` / `h-*` appears in
  the product markup of the mock. The hex values in this note's tables are
  MEASUREMENTS of resolved tokens, not authored colours.
- **Shape** via element-semantic tokens — `--radius-badge` + `--spacing-chip-x/y`
  for the chip, `--radius-card` for the column and the open menu,
  `--radius-control` + `--spacing-control-x/y` for the picker's option rows.
  `rounded-full` only on the genuinely-circular status dot.
- **Not colour alone** (finding #35): Approved pairs its tint with the
  `CircleCheck` glyph and its label; the glyph is `aria-hidden`, so the accessible
  name stays the status label. At a 14% tint this is the actual mechanism — see
  the chip control above.
- **AA**: every chip carries `--el-text-strong` on a 14% tint over
  `--el-surface`, measured at 7.59 – 11.97:1. The board chrome in this asset uses
  `--el-text` and `--el-text-secondary` only — never `--el-text-muted` on
  `--el-surface`, and never `--el-text-faint` for anything that carries meaning.
- **The picker** keeps the shipped `role="combobox"` / `role="listbox"` /
  `role="option"` structure and its `aria-activedescendant`; the ninth status adds
  an option, not a control.

---

## The CI badge (MOTIR-5471)

**Asset: `board-card--ci-badge.mock.html`** (panels 1–5). It amends § _CI at Implemented_ above, which
deferred exactly this, and § _Card anatomy_. Story MOTIR-5469; built by MOTIR-5474.

**What it draws.** A card whose `WorkItem.ciState` reads `failing` or `running` carries a badge; one
reading `passing` or `null` carries none, and neither does a card in the `done` CATEGORY.

- **Primitive + tokens + copy are all the SHIPPED ones.** `Pill` with `severity="danger"`
  (`--el-tint-rose`) for `failing` and `severity="warning"` (`--el-tint-peach`) for `running`; the
  glyphs are `CircleX` and `CircleEllipsis` from `CI_STATE_META`
  (`components/github/DevelopmentSection.tsx`); the strings are
  `github.development.ciState.failing` / `.running`, already translated in `messages/zh.json`.
  **No new token, no new string, no second vocabulary** — the card and its own Development section say
  the same thing the same way.
- **`passing` earns no badge, deliberately.** Green CI is what moves a card to In Review, so a green
  badge would restate the column. `MOTIR-5470` makes that exact: the stored column reads `passing`
  precisely when the promotion would promote.
- **A `done`-category card carries none**, whatever column it sits in — a board maps statuses to
  columns many-to-one, so the rule is the STATUS CATEGORY, never the column. A done card's old red is
  not actionable.

### The slot, and the TWO changes the badge requires

**The badge is an ADDITIONAL pill in the card's existing pill row, immediately after the exclusive
one** (`BoardCard.tsx`'s `Awaiting acceptance` / priority / `Blocked` branch). It takes no existing
slot, so it can never hide _Blocked_ or _Awaiting acceptance_ — both render beside it.

Two changes come with it, and **both were found by RENDERING the sheet, not by reading the component:**

1. **The badge needs `whitespace-nowrap`.** `Pill` does not set it, and at the board's 288px column
   the two-word label breaks inside the chip — _“Checks / failing”_ on two lines with the glyph
   orphaned.
2. **The pill row needs `flex-wrap`.** `BoardCard.tsx` carries none (`grep flex-wrap`: 0 hits), so a
   second pill does not wrap — it **overflows**, pushing the story-point chip and the avatar past the
   card's right edge. With it, the longest pairing (_Awaiting acceptance_ + _Checks running_) takes a
   second line.

**Height:** unchanged except on a card carrying BOTH pills, which grows by one 22px line plus the 6px
row gap. That is the one height change this asset introduces, and it is recorded here against
`board-scale.mock.html`'s per-card height rather than in that sheet, which is a record of its moment.

### ⚠️ A BOARD CARD carries the LABEL; a ROW carries the GLYPH

The same fact is drawn two ways, and the split is forced by a width budget rather than chosen. A board
card has a wrapping row and 288px; an `/items` or Workbench row has a 160px title floor that a labelled
pill overflows. `design/work-items/design-notes.md` § _The CI badge (MOTIR-5471)_ carries that
measurement and is the authority for rows.

### AMENDMENT (MOTIR-5718, 2026-09-18) — an EJECTED card shows _Checks failing_

**A card whose pull request the merge queue threw out for a failure — while that pull request's own
checks stay green — shows the shipped _Checks failing_ badge.** No new pixels, no new value, no new
string. The fold that makes it true is MOTIR-5717 (`WorkItem.ciState` reads `failing` while a failure
exit stands at the pull request's current head); this amendment is the design half. The drawn
Development block for such a card is `design/github/design-notes.md` § 26.

**Why _Checks failing_ and not a fourth state** (the planner's reasons, kept):

1. The badge answers one question: _does this card need a fix?_ An ejection is a yes.
2. `ciState`'s value set is `CI_STATES` (`lib/github/prCiState.ts`), shared by the fold, the _Checks_
   filter's whitelist and the board, list and Workbench DTOs. A fourth value costs all of them, for a
   distinction the card page already draws in words (_Left the queue_, its reason and its check).
3. The _Checks: Failing_ filter then finds ejected cards with no new option.

**Rung 1 — how GitHub marks it, checked before settling.** GitHub records a merge-queue removal as a
**timeline event** on the pull request — _"The pull request timeline will display the reason why the
pull request was removed from the queue"_ (GitHub Docs, _Managing a merge queue_) — and names no
marker in the pull-request LIST. The list's status icon is the head commit's check rollup, and the
queue's checks run on the merge group's own commit, not on the head. Measured on this repository
(`gh api graphql`, `RemovedFromMergeQueueEvent.reason` beside the head's `statusCheckRollup.state`,
2026-09-18): **#2960, #2955, #2946, #2934 and #2914** (`failed_checks`) and **#2947**
(`merge_conflict`) all read **`SUCCESS`**. So GitHub's own list shows an ejected pull request as
green — which is the gap this story closes on Motir's surfaces — and it offers no distinct marker that
would argue for a fourth value. The three reasons above stand.

---

# ⭐ The board refuses ON THE CARD while a PLAN holds it (Story MOTIR-6017 · MOTIR-6264 — `board--plan-hold.mock.html`, DATED 2026-09-25)

**A DELTA of panel 2b** — § _A move HELD by an approval or a merge (panel 2b)_ above (MOTIR-5525,
`board.mock.html`). That panel is a RECORD and is not edited. This section draws the board when a
card is held by an **undecided PLAN**. The delta mock carries `board.mock.html`'s stylesheet and icon
sprite **verbatim**, so the two cannot drift, and adds one DELTA-ONLY block after them.

**The plan line is not ours.** Its copy, keys, glyphs and door belong to
`design/work-items/design-notes.md` § _⭐ The status control says a PLAN holds it_ (MOTIR-6263,
`design/work-items/status-held-by-decision--plan-hold.mock.html`), shipped in
`components/issues/StatusHeldNotice.tsx` by MOTIR-6267. The rule is
`docs/decisions/agent-authored-plans.md` **AMENDMENT 21**: §1 the hold (status `planning`, a
`plan_target_lock` naming a non-null `planId`, the plan `generating` · `planned` · `stale`; a
SESSION-held lock and an expired `generating` lease do not hold), §2 the refusal
`PLAN_TARGET_HELD` and its payload, §3 the exits (no manual escape hatch).

### Revision 2 — answering the review

> _"What is the logic? Why the the "Review plan" card is by itself? Several cards in the lane can be
> in the same plan."_

**Two faults, both real.**

1. **The refusal looked like a lane item of its own.** Revision 1 composed the shipped
   `BoardCardHeldRefusal` as it stands — a separately bordered, separately shadowed box in the gap
   under the card — so in a column of cards it read as one more card, a "Review plan" card. It is now
   drawn **inside the refused item's own border**, as that item's footer.
2. **The logic was drag-first, which is the gate's logic, not the plan's.** An approval gate holds
   ONE target status of an otherwise movable card, so the board fairly learns of it by trying that
   move. A plan holds the **whole item** — every move out of Planning — and it holds **several items
   at once**. A hold that only appears after a failed drag hides the one thing a reader of the
   Planning lane needs: _which of these items can I move, and which belong together?_

**The logic now.** A plan hold is a PROPERTY of the item, so the board draws it **up front, on every
held item, before anyone drags**:

- **One shell per held item.** The card body and a **plan footer** share one border, radius and
  shadow. The footer names the plan — `Plan · MOTIR-6017` — in the same words on every item of that
  plan, so a plan reads as a group by NAME (never by colour alone), and two plans in one lane read as
  two groups.
- **The footer is the door.** At rest it is a link: `Lock` · the plan name · `Sparkles` **Review
  plan**, sent where `planRowDestination` (`lib/planning/planDestination.ts`) sends the plan — the
  planning surface over the board with a session, `/plans/<id>` without one. Its `title` is the
  `planState.<status>` sentence. It is a **sibling** of the card's drag `<button>` inside the card
  wrapper, never nested in it (a link inside the button would be a nested-interactive violation and
  would steal the drag pointer) — the same arrangement the shipped `⋯` menu uses. Keyboard: the
  footer is the next tab stop after the card.
- **Hover or focus a footer → every item of that plan on the board is outlined**
  (`--el-status-planning`, 2px, offset 2px). The label is the first signal and the outline the second.
  Hover of the card body does NOT trigger it, so moving the pointer across a lane does not flash.
- **A refused drag grows the refusal from the refused item's OWN footer.** The item springs back
  (`runMove` restores the snapshot); the footer opens to show the plan name, a sibling count sentence,
  and the shipped `StatusHeldNotice` plan line (the refusal, the `planState` sentence, **Review
  plan**) inset inside the footer — all within the item's border, the whole shell raised to
  `--shadow-elevated`. The other items of the same plan stay outlined while the refusal is open, so a
  reader sees at once that moving them would be refused too.
- **The board still sends the move.** It knows the hold up front, but it does not refuse locally:
  the server is the authority (the plan may have been decided since the board was read), rank
  changes inside Planning must still land, and the refusal payload is what keeps the drawn state
  honest. A card no plan holds (panel 8) draws no footer and moves.

### The panels (every one in en and zh)

| #   | state                                                      | what it settles                                                                                             |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | **at rest** — plan A ×3, plan B ×1, one item no plan holds | the grouping, by name, before any drag; the un-held item has no footer                                      |
| 2   | hover / focus on a plan footer                             | every item of that plan outlined; the other plan and the un-held item untouched                             |
| 3   | **the refused drag**, plan `planned`                       | the item returns, the refusal opens in its own footer with the sibling count, its two siblings are outlined |
| 4   | plan `generating`                                          | only the `planState` sentence changes                                                                       |
| 5   | plan `stale`                                               | still held (§1); the longest sentence wraps inside the 288px column                                         |
| 6   | plan with **no session**                                   | same words; the resting footer AND the refusal's door link to `/plans/<id>` (`no-conversation`)             |
| 7   | a drag **within** Planning (rank only)                     | not refused; the lifted clone carries its (inert) plan footer; the ordinary `announcementDropped`           |
| 8   | an item parked only by a planning **session**              | no footer, and the drag out succeeds — drawn so the builder adds nothing here                               |
| 9   | dismissal and keyboard                                     | open (focus on **Review plan**) → `Esc` / click outside → the next drag start; the exact `aria-live` text   |
| 10  | a narrow board (320px phone, 292px column)                 | the resting footer still fits on one line; the refusal wraps and the door keeps its own line                |

### Which drags are refused, and which are NOT

| the drag                                              | refused? | why                                                                                                                                                                                                                          |
| ----------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a held item out of Planning onto any other column     | **yes**  | a status move out of `planning`, which §2 refuses on every door                                                                                                                                                              |
| a held item within Planning (a rank change)           | **no**   | not a status move: `boardsService.moveCard` (`lib/services/boardsService.ts`) sees the status already mapped to the target column and writes only `position`; `applyStatusTransition`, where the hold lives, is never called |
| an item parked only by a planning SESSION             | **no**   | §1 excludes a session-held lock by name — a conversation is not a decision about the item. It carries no footer                                                                                                              |
| an item under a `generating` plan whose lease EXPIRED | **no**   | §1's other exclusion; `planHoldFor` returns not-held, so no footer                                                                                                                                                           |
| anything INTO Planning                                | **no**   | §2: the hold is about leaving                                                                                                                                                                                                |

The refusal branches on `code: 'PLAN_TARGET_HELD'` beside the shipped `APPROVAL_GATE_PENDING`
branch (`readHeldRefusal`, `components/issues/heldRefusal.ts`). Every other refusal — the illegal
edge, the unmapped column, network errors — keeps panel 2's toast, unchanged.

### Dismissal, focus and the announcement

- The refusal closes on `Esc`, a click outside (shipped `useDismissOnEscapeOrOutside`), or the next
  drag start (`handleDragStart`'s `setHeld(null)` in
  `app/(authed)/boards/_components/BoardContainer.tsx`); the footer returns to its resting door and
  the sibling outlines go with it.
- Focus moves to the refusal's **Review plan** (the shipped focus effect: the door, else the card).
- The gate refusal keeps `boards.announcementHeld`. A plan refusal uses a new key,
  **`boards.announcementPlanHeld`**, because it now names the plan:
  `{line}` = the `planHeld` sentence + one space + the `planState.<planStatus>` sentence + one space +
  `boards.planHold.siblings`, as plain text; `{plan}` = `boards.planHold.marker`. One space in both
  locales — the region is `sr-only`, and it saves a locale branch. With two siblings:

| `planStatus` | en                                                                                                                                                                                                     | zh                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `generating` | MOTIR-6031 returned. It is held by Plan · MOTIR-6017. Status can't be changed while a plan is open. Motir AI is still writing this plan. 2 other items on this board are in this plan.                 | MOTIR-6031 已退回。它由 计划 · MOTIR-6017 占用。计划未决定前无法更改状态。 Motir AI 正在撰写该计划。 此面板上还有 2 个工作项属于该计划。        |
| `planned`    | MOTIR-6031 returned. It is held by Plan · MOTIR-6017. Status can't be changed while a plan is open. This plan is waiting for approval. 2 other items on this board are in this plan.                   | MOTIR-6031 已退回。它由 计划 · MOTIR-6017 占用。计划未决定前无法更改状态。 该计划正在等待审批。 此面板上还有 2 个工作项属于该计划。             |
| `stale`      | MOTIR-6031 returned. It is held by Plan · MOTIR-6017. Status can't be changed while a plan is open. This plan needs attention before it can be approved. 2 other items on this board are in this plan. | MOTIR-6031 已退回。它由 计划 · MOTIR-6017 占用。计划未决定前无法更改状态。 该计划需要先处理，然后才能批准。 此面板上还有 2 个工作项属于该计划。 |

### The copy — reused, and the three new keys

Reused unchanged: `approvalGate.statusHeld.planHeld`, `.planState.generating|planned|stale`,
`.reviewPlan` (MOTIR-6263 / MOTIR-6267). New, all under `boards` (no "card" in product copy — the
catalog test forbids it):

| key                           | en                                                                                                                                                                           | zh                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `boards.planHold.marker`      | `Plan · {name}`                                                                                                                                                              | `计划 · {name}`                                                                                        |
| `boards.planHold.siblings`    | `{count, plural, =0 {No other item on this board is in this plan.} one {# other item on this board is in this plan.} other {# other items on this board are in this plan.}}` | `{count, plural, =0 {此面板上没有其他工作项属于该计划。} other {此面板上还有 # 个工作项属于该计划。}}` |
| `boards.announcementPlanHeld` | `{key} returned. It is held by {plan}. {line}`                                                                                                                               | `{key} 已退回。它由 {plan} 占用。{line}`                                                               |

**`{name}` — how a plan is named, consistently.** The plan's **anchor key** (`PlanHoldDTO.anchorKey`,
its session's `targetKeys[0]`) — the handle the To-approve row already leads with, short enough for a
288px footer, and carried by both the up-front read and the `PLAN_TARGET_HELD` payload. With no
anchor (a project-wide session), the plan's `title`, one line, truncated; with neither, the project
name — the same fallback order as `ApprovalRow.tsx`'s `targeted` / `untargeted` / `untitled` forms.
**Grouping keys on `planId`, never on the label**, so two plans that happened to share a label would
still outline separately.

### What the code composes, and the data it needs

- **`BoardCard`** (`app/(authed)/boards/_components/BoardCard.tsx`): the outer `group/card` wrapper
  becomes the shell for a held item (border, radius, shadow, `overflow-hidden`; the inner button
  drops its own border and shadow) and renders the footer link after the button, beside the `⋯` menu.
  `BoardCardView` is unchanged; the `DragOverlay` clone renders the footer inert (spans, no link).
- **`BoardCardHeldRefusal`** (`app/(authed)/boards/_components/BoardHeldRefusal.tsx`) stays THE
  refusal component — **no second one**. It moves from `mt-2` under the card into the footer, and
  renders `StatusHeldNotice` with its `plan` prop (the shipped plan line) without the elevated
  shadow, which moves to the shell.
- **The sibling highlight** is one piece of board state beside `held` in `BoardContainer`: the
  highlighted `planId` (set by a footer's hover/focus, and by an open plan refusal). Each card
  compares its own `planId`.
- **Tokens:** the footer is `--el-tint-mint` over `--el-border-soft`, text `--el-text-strong`, the
  count sentence `--el-text-secondary`; the outline is **`--el-status-planning`**
  (`packages/design-system/theme.css`, the Planning hue — the delta declares it, since the base mock
  predates it); the notice keeps panel 2b's `--el-tint-yellow` box and `Button` `primary` `sm`. No new
  token.
- **THE DATA (no code here).** The board projection must carry each card's plan hold: ONE batched
  read of `plan_target_lock` for the board's `planning` cards (non-null `planId`), joined to the plan's
  `status`, `title`, `sessionId` and its session's first target key, each row passed through
  **`planHoldFor`** (`lib/plans/planHold.ts`) — the same rule `readPlanHoldWithin`
  (`lib/services/planTargetLockService.ts`) applies per item, so the board and the funnel cannot
  disagree. It returns, per card, `planHold: PlanHoldDTO | null`, and per plan its label fields and the
  COUNT of its held items on the board's project — counted server-side, because columns load their
  cards lazily and a client count would be wrong for a long lane. The refusal payload does not need to
  change: the board already holds the plan's label and count from the projection.

### Not drawn here, and owed by whom

| surface                                                                                                                                                                                                       | owner                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| the board: the batched plan-hold read in the projection, the held shell and footer door, the sibling highlight, the refusal in the footer, the three `boards.*` keys in en + zh; and the `/items` row refusal | **MOTIR-6268**                           |
| the item page, quick view and edit page status control and the `approvalGate.statusHeld.plan*` strings                                                                                                        | **MOTIR-6267** (shipped)                 |
| the server refusal — `PLAN_TARGET_HELD`, its payload, `planHoldFor`, `readPlanHoldWithin`                                                                                                                     | **MOTIR-6265** (shipped)                 |
| the planning surface and the plan page the doors land on                                                                                                                                                      | already shipped — MOTIR-6012, MOTIR-6043 |

### Grounding, and one honest limit

Read at `parent/MOTIR-6017-plan-hold` **`12d615981`** (which carries MOTIR-6265 and MOTIR-6267):
`board.mock.html` panel 2b and its section above; MOTIR-6263's section and mock; AMENDMENT 21 §1–§4;
`lib/plans/planHold.ts`, `readPlanHoldWithin`, `PlanHoldDTO` (`lib/dto/plans.ts`), `PlanTargetHeldError`
(`lib/workItems/errors.ts`), the shipped plan line in `StatusHeldNotice.tsx`, `heldRefusal.ts`,
`BoardHeldRefusal.tsx`, `BoardCard.tsx` (the button, the sibling `⋯` overlay, `BoardCardView`),
`BoardContainer.tsx` (`runMove`, `snapBack`, `showHeld`, the held `aria-live` region, the focus
effect), `boardsService.moveCard`'s in-column branch, `planDestination.ts`, `launcher.ts` and
`components/approvals/ApprovalRow.tsx`'s plan naming. The asset was rendered headlessly (Playwright
Chromium) in light and dark, every panel inspected, and no board in it scrolls horizontally.

**The limit:** the render used DejaVu Sans and Noto Sans CJK substitutes, because `--font-sans`'s
`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto` are not installed on the box that drew it.
That stack is copied unchanged from the base mock. The substitute is WIDER than the real face, so
every line that fits in the render fits in the product.

---

## Warm touches in the default Motir palette (MOTIR-7583)

**Amends** `design/boards/board.mock.html`'s COLOURS only — no layout, copy or component change.
Delta mock: `design/boards/board--motir-warm-touches.mock.html`. The spec — the role table, the
measurement matrix, every consumer with its disposition, the two intensities and the hand-off — is
`design/design-system/design-notes.md` § 8, because the change is a palette change and that is the
palette's area.

What the board panels show, today (left) vs proposed (right), light and dark: the Epic kind icon in
warm orange beside the burnt-orange **Blocked** pill and the amber **High** chip it was measured
against; the blue in-progress column, blue focus ring, ink **Create** button and ink brand tile
unchanged; a selected backlog row and a focused row; every work-item type chip (Design takes citrine
gold, its own hue apart from the orange Epic; Review and Verification keep the burnt orange); progress at 0 / 40 / 100% (the done/total meter stays green,
upload and import bars warm); avatars, labels, the Blocked pill and a warning callout on the warmer
peach; the planning-canvas glow and the donut ramp; the Appearance palette picker (unchanged); and
the two intensities, subtle recommended. Revision 2 (2026-10-05) added the citrine Design hue
after review asked for citrine too.

## Auto-translate: titles on this surface (Story MOTIR-7738 · MOTIR-8824, DATED 2026-10-17)

Amends the board header and the card in `board.mock.html` by delta mock `design/work-items/translation--titles.mock.html` (panels 4–6), whose decisions are in the `⭐ The title surfaces under auto-translate` section of `design/work-items/design-notes.md`. Changes here: the board header's controls slot gains the one **Show original / Show translation** switch beside the group-by `Segmented` (absent, not disabled, when off, nothing differs or no credit); and **a card whose title differs takes the reserved two-line region (`line-clamp-2 min-h-[2lh]`) from its first frame**, so the translation landing never moves the card below it. The no-credit state draws one non-dismissible notice in the header instead of the switch. Nothing else on the card changes.

## The card's tag row — the canvas card's status slot, Manual chip and blocked flag (MOTIR-10534, DATED 2026-11-06)

Amends **§ The card** above (the "Blocked cards swap the priority pill for a Blocked peach pill" bullet) and `board.mock.html`'s card. No new mock: the tag row it adopts is already drawn — it is the roadmap canvas card's tag row, design **MOTIR-10508** (built in MOTIR-10509), and the board card now renders the SAME component, `components/workItems/WorkItemStateTags.tsx`, so the canvas design is the drawing of record and a second copy here would only drift from it.

- **The status slot opens the tag row, right under the title**: exactly one pill, chosen by `lib/workItems/statusSlot.ts`'s precedence **Done › To plan › Ready › the status chip**. _Done_ is the solid dark stamp (`--el-text-secondary` fill, `--el-text-inverted` ink) and is withheld from a blocked card. _To plan_ is a childless story in a `todo`-category status. _Ready_ is a startable (`todo`-category) card that is fully unblocked — the card reads `BoardCardDto.readyToStart`, the rule the roadmap read writes into `RoadmapNodeDto.ready`. Otherwise the workflow status chip: the canvas's `--el-tint-*` fill per key, else per category, else the neutral chip (`lib/workflows/canvasStatusMeta.ts`), with the status's own label from the workflow (`BoardCardDto.statusLabel`).
- **The Manual chip follows the slot** for a human-gated card (`type: 'manual'` or `executor: 'human'`) — the shipped `WorkItemTypeChip`, hairline `--el-border`. Nothing for any other card.
- **The Blocked peach pill is retired.** A blocked card (`ready: false`, the cascaded readiness) draws the canvas's **blocked flag** in the same exclusive slot the pill held — `--el-danger-surface` fill, `--el-danger-on-surface` ink, `Flag` glyph, the short visible label _blocked_, and the full sentence **Blocked** (`ui.readiness.blocked`) on `title` and `aria-label` (`role="img"`). The exclusive slot's precedence is unchanged (MOTIR-5875): a decision waiting on YOU outranks the flag, and the flag outranks a review marker, a decision waiting on someone else and the priority chip.
- **Not public** (`EpicNotPublicPill`) stays where it was, in the header row.
- **Column header and slot double-up.** A card in the To Do column now names its status twice (the column and the chip) — deliberate, so one card reads the same off its column (swimlanes, a screenshot, the canvas) as on it.

Tokens: no new token; every colour above is an existing `--el-*` and every shape is `--radius-badge` / `--spacing-chip-*`. The tag row's give-way rule (glyph-only chips when the card is narrow) is the canvas's alone and is not applied on the board, whose card width is fixed.

# ⭐ Swimlane lanes that page and scroll on their own, and the group-by menu (DATED 2026-11-16) — `swimlanes--lane-paging.mock.html`

**Design system — identified before drawing.** The root `package.json` depends on
`"@motir/design-system": "workspace:*"`, `app/globals.css` imports its `theme.css`, and the document
wears the package's default axes (`warm-editorial` / `motir` / `motir`). **Verdict: ON MOTIR DESIGN.**
The mock is rendered with `renderMock` from `@motir/design-system/mock` from the **real shipped
parts**: `LaneCell` (and through it the real `BoardCard`), `LaneCountBadge`, `ColumnWipBadge`, the
lane-label primitives (`Avatar`, `PriorityValue`, `IssueTypeIcon`), the design-system `Button`,
`Spinner` and `EmptyState`, the `Popover.Content` box (classes verbatim, drawn in place because Radix
portals it), the board skeleton card (`BoardSkeleton`'s `SkeletonCard`, classes verbatim) and the
board filter trigger (`IssueFilterBar`, classes verbatim). No part is missing from the package; the
new compositions below (the lane row, the driven column-header row, the cell foot, the group-by
trigger) are product-local board layout, not primitives.

**What it amends, by name.** The bases stay as the record of what they specified; on the record
they now read as follows.

| Base                                                               | Part amended                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design/boards/swimlanes-wip.mock.html` panel 0                    | **The group-by control** — the segmented row becomes the group-by trigger and the group-by menu (below).                                                                                                                                                                                            |
| `design/boards/swimlanes-wip.mock.html` panels 1–3                 | **The lane and cell grammar and the single-scroller grid** — each lane's cell row is now its own horizontal scroller, the column-header row is driven by the active lane, and every cell pages itself.                                                                                              |
| `design/boards/board-scale.mock.html` panel 3                      | **The paging-free grouped board** ("each `(lane, column)` cell rendered in full") — a grouped board now pages each cell, 10 cards at a time, with a Load more control.                                                                                                                              |
| § _Swimlanes + WIP (Story 3.3)_ › _Composing primitives_           | The bullet **"Group-by control — the shipped Segmented control … Do NOT invent a control"** now reads: _the group-by control is the shipped menu idiom — `Popover` + `Popover.Trigger` + `Popover.Content` with `Button`-row items, as `ColumnActionsMenu` composes it_. Still no invented control. |
| `board--column-arrows.mock.html` (published design, not on `main`) | Not edited. Once lanes scroll on their own, **the column arrow pair moves to each lane** (below); the flat board keeps the board-edge pair exactly as that design draws it.                                                                                                                         |

Nothing else is redrawn: the card anatomy, the column anatomy, the WIP chip and its editor, the
sprint-point badge and the flat (group-by None) board are the base mocks' and are unchanged. No group-by
dimension is added (None and the three shipped dimensions), and lane order (assignee alpha, priority
rank, epic position, the catch-all last) is drawn as it ships.

## The elements, by name

| Name                         | What it is                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **the group-by trigger**     | the toolbar button showing the current dimension's glyph and label with a chevron; opens the group-by menu |
| **the group-by menu**        | the single-select menu of None, Assignee, Epic, Priority                                                   |
| **the lane header band**     | the full-width band above a lane's cells; never scrolls; the whole band toggles collapse                   |
| **the lane label rail**      | the chevron, the lane's label and the lane count at the band's left — pinned at any lane offset            |
| **the lane count**           | the lane's aggregate count, from the projection                                                            |
| **the collapse chevron**     | the chevron in the lane label rail, turned −90° when collapsed                                             |
| **the lane's cell scroller** | the lane's own horizontal scroller holding its cells                                                       |
| **the column-name strip**    | a thin row inside a lane's cell scroller naming each column above that lane's cells                        |
| **the column arrow pair**    | the left and right column arrows of the base navigation design, one pair per lane, at that lane's edges    |
| **the cell**                 | one `(lane × column)` cell: that lane's cards in that column                                               |
| **the cell count**           | the count in the cell foot                                                                                 |
| **the Load more control**    | the button in the cell foot that loads that lane's next 10 cards in that column                            |
| **the cell retry**           | the in-cell retry after a failed page                                                                      |
| **the empty cell**           | the shipped dashed placeholder                                                                             |

## The group-by trigger and menu (panels 1–2)

- **Why a menu.** Jira: Atlassian's board tutorial (_Tutorials for Jira boards_, Atlassian Support)
  says to open the **Group by dropdown menu** in the board header and choose the swimlane basis.
  Linear: grouping is a **display option** (_Display options_ documentation) whose list carries an
  explicit **no grouping** choice, and each group header carries the group's total. Both were
  checked; both make grouping a menu with a no-grouping entry. Our toolbar now also carries the board
  filter, so four segments plus a label no longer fit it.
- **The trigger** — the board toolbar's button grammar, identical to the Filter trigger beside it:
  `h-(--height-control)`, `rounded-(--radius-btn)`, `border-(--el-border)`,
  `px-(--spacing-control-x-12)`, hover `--el-surface`, focus `ring-(--focus-ring-color)`. Content: the
  current dimension's glyph (`LayoutGrid` None · `User` Assignee · `Zap` Epic · `Flag` Priority,
  `--el-text-secondary`), the words _Group by_ in `--el-text-secondary` and the dimension in
  `--el-text`, then a `ChevronDown`. The value is the board's stored grouping, the same for every
  reader.
- **States.** _Open_: `--el-surface` fill, `aria-expanded`. _Writing_: the glyph becomes the shipped
  `Spinner` (`sm`), the trigger is `disabled` and `aria-busy` while the board's group-by write is in
  flight, so a second choice cannot race the first. _Read-only_ (no `board:configure`): `disabled`, no
  menu, the shipped `Tooltip` on the wrapper carrying the reason (the shipped behaviour,
  MOTIR-6174's grammar). _Narrow viewport_ (below `sm`): the label is dropped; glyph and chevron only.
- **The menu** — `Popover.Content` `width={220}` `align="end"` (anchored to the trigger's end edge),
  `p-0` with an inner `p-1`, exactly `ColumnActionsMenu`'s idiom. Each option is a row: leading glyph
  (`--el-text-secondary`), label (`--el-text`), and the trailing `Check` in `--el-accent-on-surface`
  on the current option only (the filter popover's selectable-row grammar). Row:
  `rounded-(--radius-control)`, `px-(--spacing-control-x)`, `py-(--spacing-control-y)`, hover fill
  `--el-muted`, keyboard focus `ring-2 ring-(--focus-ring-color)`. Roles: `menu` +
  `menuitemradio` with `aria-checked`. Arrow keys move, Enter/Space choose, Escape or an outside press
  closes and returns focus to the trigger (Radix behaviour). Choosing None returns the flat board.

## The lane header (panel 3)

- **Unchanged anatomy, from what ships.** Assignee: `Avatar` + name. Priority: the priority `Pill`
  (`PriorityValue`). Epic: the epic `IssueTypeIcon` + the projection's label (key and title). The
  catch-all lane: `--el-muted` band, the dashed `–` marker and the shipped no-value label, sorted
  last. Each carries the lane count (`--el-count-bg` / `--el-count-text`, `--radius-badge`) and the
  collapse chevron.
- **What changes.** The band no longer sits inside the board's scroller: it spans the board and never
  scrolls, so the lane label rail is pinned at the left at any lane offset. The chevron ink moves to
  `--el-text-secondary` (it sits on `--el-surface-soft` / `--el-muted`, where `--el-text-muted` fails AA).
- **Collapsed** — the band alone, the chevron turned, the count kept; no cells, no column-name strip
  and no arrow pair.
- **The band's width rule and the spacer track.** The band spans the lane's own column track in both
  states. The width-establishing spacer track (`swimlane-track-<laneKey>`, one `w-72` spacer per
  column) is kept and drawn in both the expanded and the collapsed state, inside the lane's cell
  scroller, so the track's width never depends on cells being present — the fix
  `bug-swimlane-collapsed-lane-header-not-full-width` stands on it.
- **Empty lane** (a lane the dimension holds with no cards — e.g. under a filter): the band with a `0`
  count and one line across the lane, `text-xs` `--el-text-secondary`, instead of a row of empty cells.

## The cell (panel 4) — it pages itself

Seven states, each drawn in panel 4 in one lane's To Do column:

| State                    | What it shows                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Not yet loaded**       | two skeleton cards (the shipped board skeleton card), static; **no count, no control** — the lane has not asked yet                                                                       |
| **First page in flight** | the same skeleton with `animate-pulse`, `role="status"`, `aria-busy`; still no count                                                                                                      |
| **Loaded with more**     | the lane's first 10 cards in the column's order, the compound cell count (_10 of 40_), and the Load more control                                                                          |
| **Next page in flight**  | the cards and the count stay; the Load more control is `loading` (the `Button`'s own spinner, `disabled`, `aria-busy`)                                                                    |
| **Complete**             | every card of that lane in that column, the bare total (_3_), no control                                                                                                                  |
| **Failed**               | the cards already in it (or none), and the cell retry — the shipped retry grammar (`--el-link`, `text-xs`, underline on hover, focus ring); with no cards it sits centred in a dashed box |
| **Empty**                | the shipped dashed placeholder (`LaneCell`'s empty state), reading as an empty column reads today; no count                                                                               |

- **The cell foot** sits under the cards: the cell count at the start, the Load more control (or the
  cell retry) at the end. The count composes the shipped `LaneCountBadge` rule — compound while a next
  page exists, the bare total once complete. **No count is drawn before what it counts has loaded.**
- **The Load more control** — the design-system `Button`, `variant="secondary"` `size="sm"`, trailing
  `ChevronDown`. It is an explicit control, not a scroll sentinel: cells sit side by side, so a
  sentinel would fire for every visible cell at once.
- **A failure stays in its cell.** One failed lane page fails every cell of that lane (panel 13), so
  each retry's accessible name names its lane AND its column — ten identical "Retry" buttons would be
  indistinguishable to a screen reader.

## Where each count lives

- **The column header** (pinned) keeps the column's TOTAL across all lanes and reads it **bare** —
  on a grouped board a column no longer pages. The WIP chip still reads that total.
- **The lane count** keeps the lane's aggregate count (the grouping's own total, from the projection).
- **The cell count** is the only compound count on a grouped board.

## The scroll model (panels 5–9) — settled here, not borrowed

**Neither reference moves one group sideways on its own.** Jira's board and Linear's board each
scroll every group together; nothing shipped answers what happens when one group moves alone, so the
model below is this design's decision on the record.

1. **Each lane's cell row is its own horizontal scroller** (`overflow-x-auto`), with the base
   navigation design's hidden scrollbar (`[scrollbar-width:none]` + `[&::-webkit-scrollbar]:hidden`),
   pan cursor and column arrow pair applied to that lane instead of to the board. **No native
   horizontal scrollbar is drawn under any lane in any panel.**
2. **The lane header band and its lane label rail sit above that scroller and never move**, so the
   label is pinned at the left at any offset.
3. **The column-header row is DRIVEN, not scrolling.** It mirrors the offset of the **active lane** —
   the lane the reader is panning, pressing an arrow in, or holding focus inside. It follows that lane
   live while it moves, **holds that lane's offset once no lane is active**, and sits at offset 0 only
   before any lane has been acted on. So the totals above a cell belong to the lane being read.
4. **The column-name strip.** A lane whose offset differs from the header's draws its own column-name
   strip: a thin row inside its cell scroller, translating with the lane, naming each column directly
   above that lane's cells (`text-[11px]` uppercase `--el-text-secondary`, a `--el-border-soft` rule;
   `aria-hidden`, since each cell's accessible names already carry the column). That strip — not the
   header — is what makes a cell's column readable at an arbitrary lane offset. It is drawn by the card
   that builds the lane's scroller. **The active lane never draws one** (its offset is the header's);
   so in panel 6 the moved, active lane has none and the lanes still at 0 do, and in panel 7 the lane
   moved earlier keeps its offset and gains its strip once the reader moves to another lane.
5. **Offsets persist for the session and reset on a group-by change** — a re-lay is a new lane set.
   Linear's changelog records restoring a board's horizontal position when returning to it, which is
   the reference for keeping an offset at all.
6. **Rows line up.** The column-header row reserves the same two empty arrow gutters as a lane, so
   every row's track starts at the same x at offset 0.

**The column arrow pair, per lane (panel 8).** The base navigation design's `Button`
(`secondary`, `sm`, square, `ChevronLeft` / `ChevronRight`), in a gutter beside the lane's cell
scroller, level with the top of the lane's cells, acting on that lane only. States as the base gives
them: **resting** (both enabled); **left disabled** at that lane's start; **right disabled** at its
end; **absent** — neither arrow, the gutters kept empty — when that lane's cells fit its width (three
columns in panel 8). A collapsed or empty lane draws no arrows. Below `sm` no lane arrows are drawn,
as the base navigation design draws no arrows at that width.

**The lane background (panel 9).** `grab` over a lane's empty background, `grabbing` (on that lane's
scroller, `data-panning`) during a pan, which moves that lane only. A card keeps its own shipped
`grab` (it picks the card up); an arrow keeps the default arrow; the lane header band (chevron, label)
keeps its shipped pointer. Panel 5 is a working prototype: pan or press an arrow in any lane and the
header follows it and the strips appear and go.

## The board panels (10–15)

- **First paint (10)** — the column headers already carry their totals and every lane header its lane
  count (both come with the projection); every cell of an in-view lane is in the not-yet-loaded
  skeleton.
- **Loaded (11)** — every lane shows its own cards; the busy lane's To Do cell shows _10 of 40_ and
  Load more. The frame clips like a screen.
- **Group-by re-lay (12)** — the new grouping's lane headers at once, every cell in the in-flight
  skeleton while its lanes arrive (today a re-lay shows the whole-board skeleton).
- **A lane whose page failed (13)** — each cell of that lane in the failed state with its own retry;
  the lane count is still the projection's.
- **No cards at all (14)** — the shipped empty board, unchanged.
- **Under an applied toolbar filter (15)** — every cell and count over that filter's cards only, an
  empty cell wherever a lane has none of them, an empty lane where a lane has none at all.

## Why a grouped board pages each cell (a deviation on the record)

`board-scale.mock.html` records the Jira load model: a whole bounded set rendered and virtualized, no
paging. On our capacity target — up to 10 columns and 200 lanes on one board, any lane holding any
number of cards — that model is unbounded, and a column-level page leaves a lane empty wherever other
lanes filled the column's first page. So a grouped board pages **per cell**: a lane's cells load when
the lane is in view (a collapsed lane loads none), each cell loads 10 cards, and Load more loads that
cell's next 10. The flat board's paging is unchanged.

## The words each element needs (the wording is the strings card's)

The mock's English is illustrative. What each accessible name must CONTAIN:

| Element                          | Must contain                                             |
| -------------------------------- | -------------------------------------------------------- |
| the group-by trigger             | that it groups the board, and the current dimension      |
| each group-by menu option        | the dimension                                            |
| each column arrow                | its direction, and **the lane** it moves                 |
| the Load more control            | that it loads more, **the lane** and **the column**      |
| the cell retry                   | that it retries, **the lane** and **the column**         |
| a cell in flight (`role=status`) | that it is loading, the lane and the column              |
| the cell count                   | the loaded and the total (compound), or the total (bare) |
| the empty lane line              | that the lane has no work items                          |
| the read-only trigger tooltip    | why the grouping cannot be changed                       |

## Tokens

No new token. Colour: `--el-text`, `--el-text-strong`, `--el-text-secondary`, `--el-text-faint`
(the catch-all's decorative `aria-hidden` marker only), `--el-surface`, `--el-surface-soft`,
`--el-muted`, `--el-page-bg`, `--el-border`, `--el-border-soft`, `--el-border-strong`,
`--el-count-bg` / `--el-count-text`, `--el-link`, `--el-accent-on-surface`, `--el-tooltip-bg` /
`--el-tooltip-text`, `--focus-ring-color`, and the shipped card's own tokens. Shape:
`--radius-btn`, `--radius-card`, `--radius-control`, `--radius-badge`, `--height-control`,
`--height-btn-sm`, `--spacing-control-x(-12)`, `--spacing-control-y`, `--spacing-chip-x`,
`--spacing-card-padding(-8/-12)`, `--spacing-tooltip-x/y`, `--shadow-elevated`, `--shadow-subtle`.
Every panel renders in both themes through the mock's toggle (panel 0).

## How this asset was produced

Rendered with `renderMock` from a temporary generator (not committed) that imports the shipped parts
named above, read at `main` @ `3aaa94eb`. Board frames are a fixed 1200px viewport so overflow is the
same on every reviewer's screen; starting offsets and the live prototype are set by one small inline
script. Rendered headlessly in Chromium and every panel inspected in both themes.

---

# To plan — a tenth board column for work stopped for re-planning (DATED 2026-11-23) — `board--to-plan-status.mock.html`

**Design system.** Files read: `package.json` (depends on `@motir/design-system`, `workspace:*`) and
`app/globals.css` (imports `@motir/design-system/theme.css`). **Verdict: on Motir Design**, package
version 0.24.1, which exports `@motir/design-system/mock`, so the mock is built with `renderMock` at the
project's own axes (`warm-editorial` · `motir` · `motir`, the root layout's defaults) on a full-width
board. Every part used is the package's or the product's own; none is missing, so nothing is proposed
as an addition to the package.

This section draws ONE new default status, **To plan** (key `to_plan`, category `in_progress`), on every
surface a status shows. A work item at To plan is planned and not started, and its description is out
of date because a decision it rests on was corrected: a person (or a plan) must rewrite it before anyone
builds it. A reader must tell at a glance that such a card is **stopped for re-planning, not being
worked**.

It sits beside § _Approved — the ninth board column_ and § _Implemented — the eighth board column_,
whose method and shape it follows, and amends neither mock: `approved-column.mock.html` and
`implemented-column.mock.html` stay records of their moment. The delta mock draws only what is new:

| Panel | What it shows                                                                                                                                                                                                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | The default board, populated: ten columns in order, To plan in slot 6 immediately after Planning, holding a story and a subtask, each wearing the To plan tag; a childless story in To Do wearing the computed To plan slot pill. The row opens scrolled to Planning and To plan |
| 2     | To plan empty, in the board's own empty-column treatment (header, count `0`, _No work items_), beside Planning holding one card — light and dark                                                                                                                                 |
| 3     | The item page's status picker open on a To Do item: To plan offered after Planning, its dot in the new hue — light and dark                                                                                                                                                      |
| 4     | The state tag: To plan · Planning · In Progress · the computed To plan slot pill, at full size and glyph-only — light and dark                                                                                                                                                   |
| 5     | The list chip: In Progress · Planning · Implemented · Approved · To plan — light and dark                                                                                                                                                                                        |
| 6     | Every palette in both themes: the ten dots in board order, then the To plan dot, tag and chip beside Planning's and Blocked's                                                                                                                                                    |

## The hue — `--el-status-to-plan`

```css
--el-status-to-plan: color-mix(in srgb, var(--color-warning) 45%, var(--color-ink));
```

**Blocked's amber, taken deep toward the ink.** To plan and Blocked make the same claim to a reader,
_this cannot proceed_, for different reasons: Blocked waits on other work, To plan waits on its own
rewrite. So To plan is drawn in Blocked's family and pushed well away from it, the way Approved is
Done's green one ink step deeper. It reads as a deep umber on a light page and a pale sand on a dark
one, because `--color-ink` flips with the theme.

**One expression for every palette, no per-palette block.** Both inputs are Tier-0 sources every
palette declares, so each palette re-skins it from its own `--color-warning` and `--color-ink`. That is
the "source" of every row below. No palette needs an override, so no palette block, and no
both-themes pairing (the cascade trap the separation suite enforces) is owed.

**Measured, not proposed**, with `tests/theme/statusHueSeparation.test.ts`'s own resolver and metrics
(`loadTokenLayer` · `declaredIn` · `resolveValue` from `tests/theme/paletteCascade.ts`; `deltaE2000` ·
`contrast` · `mixSrgb` from `tests/theme/colorMetrics.ts`) against the nine shipped default status hues,
in all fourteen palettes × both themes:

| Palette   | Theme | Resolved  | Nearest status, ΔE2000 | Contrast on `--el-card` / `--el-surface` / `--el-page-bg` |
| --------- | ----- | --------- | ---------------------- | --------------------------------------------------------- |
| motir     | light | `#632b15` | blocked 20.6           | 11.13 / 9.75 / 11.13                                      |
| motir     | dark  | `#eec1a6` | blocked 16.4           | 11.86 / 10.73 / 11.86                                     |
| amethyst  | light | `#72370e` | blocked 24.8           | 9.26 / 8.50 / 9.26                                        |
| amethyst  | dark  | `#e9af87` | blocked 22.1           | 9.99 / 9.07 / 9.99                                        |
| cobalt    | light | `#602c1f` | blocked 22.2           | 11.19 / 9.96 / 11.19                                      |
| cobalt    | dark  | `#ebc0a9` | blocked 17.0           | 11.37 / 10.20 / 11.37                                     |
| evergreen | light | `#5c3713` | blocked 20.5           | 10.44 / 9.31 / 10.44                                      |
| evergreen | dark  | `#f1c59b` | blocked 15.9           | 11.83 / 10.83 / 11.83                                     |
| spectrum  | light | `#78341a` | blocked 26.6           | 9.11 / 8.22 / 9.11                                        |
| spectrum  | dark  | `#f3bfaa` | blocked 16.4           | 11.37 / 10.48 / 11.37                                     |
| amber     | light | `#5e3416` | in-review 20.0         | 10.61 / 9.73 / 10.61                                      |
| amber     | dark  | `#f2cfa6` | blocked 14.0           | 13.13 / 10.73 / 13.13                                     |
| sienna    | light | `#623615` | in-review 18.1         | 9.78 / 9.05 / 9.78                                        |
| sienna    | dark  | `#f8d09f` | implemented 12.0       | 12.91 / 11.65 / 12.91                                     |
| garnet    | light | `#5a2f0d` | cancelled 20.5         | 11.37 / 9.89 / 11.37                                      |
| garnet    | dark  | `#f4d0a6` | blocked 13.9           | 13.26 / 11.95 / 13.26                                     |
| citrine   | light | `#44362c` | implemented 14.0       | 11.60 / 10.54 / 11.60                                     |
| citrine   | dark  | `#fae9ad` | blocked 12.3           | 16.43 / 14.21 / 16.43                                     |
| candy     | light | `#5f3e15` | blocked 19.9           | 9.42 / 8.32 / 9.42                                        |
| candy     | dark  | `#f6de8e` | blocked 11.9           | 13.90 / 11.88 / 13.90                                     |
| lagoon    | light | `#5c3f14` | blocked 20.4           | 9.44 / 8.63 / 9.44                                        |
| lagoon    | dark  | `#f5de8e` | blocked 12.1           | 13.74 / 11.04 / 13.74                                     |
| olive     | light | `#5d3f0f` | implemented 18.4       | 9.43 / 8.47 / 9.43                                        |
| olive     | dark  | `#f5de8c` | blocked 11.9           | 14.05 / 11.95 / 14.05                                     |
| contrast  | light | `#5f3f12` | implemented 16.9       | 9.28 / 8.35 / 9.28                                        |
| contrast  | dark  | `#f6de8d` | blocked 11.8           | 13.19 / 10.77 / 13.19                                     |
| midnight  | light | `#5c3f14` | blocked 20.4           | 9.18 / 8.48 / 9.18                                        |
| midnight  | dark  | `#f5de8e` | blocked 12.1           | 13.17 / 11.91 / 13.17                                     |

**All 28 palette × theme contexts clear the floor of ΔE2000 10**; the global minimum is **11.8**
(contrast/dark, against Blocked). Contrast is **8.22 – 16.43:1** on card, surface and page, against the
3:1 bar for a graphical object, so no `KNOWN_SUB_BAR` entry is owed.

**The ratio is the interior of a window, chosen by sweep.** At 40% the worst pair is 10.6 (sienna/dark
against Implemented); at 35% it falls under the floor (9.4). At 50% the worst pair is 10.3 (contrast/dark
against Blocked), at 55% 9.0. 45% is the top of that window. A palette change that moves `--color-warning`
or `--color-ink` must be re-measured, not nudged; the separation suite will do it on the build, because
the status joins the default workflow and the suite derives its population from it.

The sweep covered every saturated Tier-0 source, each mixed toward ink, charcoal and the background at
5% steps, and every pair of sources mixed at 10% steps. Only a handful of expressions clear 10 in all
28 contexts; this one has the largest margin among those whose contrast stays far above 3:1.

### The full distance table

Every default status hue, nearest first, per context — the record behind the "nearest" column above.

| Palette   | Theme | ΔE2000 to each default status                                                                                                                |
| --------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| motir     | light | blocked 20.6 · implemented 25.8 · cancelled 31.0 · in-review 34.8 · approved 35.5 · todo 39.8 · in-progress 42.2 · done 45.5 · planning 49.4 |
| motir     | dark  | blocked 16.4 · implemented 18.7 · cancelled 27.2 · approved 30.7 · in-review 31.2 · todo 35.9 · in-progress 36.7 · done 38.3 · planning 38.3 |
| amethyst  | light | blocked 24.8 · cancelled 27.4 · approved 36.3 · todo 40.8 · implemented 41.3 · in-review 46.3 · in-progress 48.0 · planning 49.7 · done 52.3 |
| amethyst  | dark  | blocked 22.1 · cancelled 29.1 · approved 32.3 · implemented 35.1 · todo 38.9 · planning 40.5 · done 42.3 · in-review 47.0 · in-progress 48.5 |
| cobalt    | light | blocked 22.2 · in-review 30.5 · cancelled 33.0 · approved 36.5 · in-progress 39.6 · todo 42.8 · done 47.2 · implemented 48.4 · planning 49.4 |
| cobalt    | dark  | blocked 17.0 · cancelled 30.7 · approved 32.2 · implemented 35.7 · in-progress 36.1 · in-review 37.2 · planning 38.2 · todo 38.4 · done 38.6 |
| evergreen | light | blocked 20.5 · in-review 29.3 · cancelled 30.0 · approved 35.9 · done 36.6 · planning 42.2 · todo 43.5 · implemented 44.0 · in-progress 44.6 |
| evergreen | dark  | blocked 15.9 · cancelled 25.6 · in-review 30.9 · approved 31.0 · done 36.3 · planning 37.0 · implemented 40.1 · todo 40.6 · in-progress 41.7 |
| spectrum  | light | blocked 26.6 · cancelled 30.2 · implemented 30.9 · approved 38.0 · todo 38.9 · in-review 42.4 · in-progress 45.1 · planning 50.7 · done 53.4 |
| spectrum  | dark  | blocked 16.4 · implemented 27.9 · cancelled 30.6 · approved 33.9 · in-review 37.0 · in-progress 37.3 · todo 39.5 · planning 40.8 · done 42.3 |
| amber     | light | in-review 20.0 · blocked 20.3 · implemented 27.5 · cancelled 28.8 · approved 32.6 · todo 39.3 · done 42.3 · in-progress 43.4 · planning 45.0 |
| amber     | dark  | blocked 14.0 · in-review 17.6 · approved 27.5 · cancelled 31.2 · done 34.4 · planning 34.5 · implemented 37.0 · in-progress 40.3 · todo 42.3 |
| sienna    | light | in-review 18.1 · implemented 21.2 · blocked 22.8 · cancelled 24.7 · approved 31.3 · todo 33.9 · done 39.5 · in-progress 43.9 · planning 44.9 |
| sienna    | dark  | implemented 12.0 · blocked 12.7 · in-review 20.4 · approved 25.0 · cancelled 26.7 · done 34.1 · planning 35.8 · todo 38.2 · in-progress 42.2 |
| garnet    | light | cancelled 20.5 · blocked 21.1 · in-review 24.1 · todo 29.4 · approved 31.9 · implemented 33.5 · done 39.8 · in-progress 44.7 · planning 46.1 |
| garnet    | dark  | blocked 13.9 · approved 25.9 · cancelled 26.7 · done 33.5 · planning 34.8 · in-review 35.7 · todo 36.0 · implemented 40.9 · in-progress 44.3 |
| citrine   | light | implemented 14.0 · cancelled 17.0 · approved 22.2 · blocked 29.8 · planning 31.5 · todo 31.8 · in-review 32.4 · done 35.4 · in-progress 41.1 |
| citrine   | dark  | blocked 12.3 · approved 15.4 · implemented 21.1 · done 24.1 · in-review 32.5 · cancelled 33.6 · planning 43.3 · todo 48.1 · in-progress 54.9 |
| candy     | light | blocked 19.9 · cancelled 25.8 · approved 26.1 · done 31.1 · implemented 35.3 · todo 36.7 · in-review 41.6 · in-progress 42.2 · planning 47.5 |
| candy     | dark  | blocked 11.9 · approved 20.4 · done 23.8 · cancelled 30.4 · implemented 37.7 · in-progress 44.1 · todo 44.7 · in-review 51.8 · planning 66.5 |
| lagoon    | light | blocked 20.4 · implemented 21.2 · approved 25.4 · cancelled 25.6 · done 31.7 · in-review 36.1 · todo 36.6 · planning 37.4 · in-progress 46.7 |
| lagoon    | dark  | blocked 12.1 · approved 20.4 · done 24.9 · implemented 26.5 · cancelled 28.5 · planning 32.5 · in-review 40.3 · todo 44.5 · in-progress 53.1 |
| olive     | light | implemented 18.4 · blocked 20.0 · in-review 20.8 · cancelled 22.9 · approved 24.7 · done 31.6 · todo 33.7 · planning 37.8 · in-progress 47.7 |
| olive     | dark  | blocked 11.9 · implemented 15.2 · in-review 15.4 · approved 20.3 · cancelled 22.8 · done 23.7 · planning 32.5 · todo 39.1 · in-progress 53.4 |
| contrast  | light | implemented 16.9 · blocked 19.7 · cancelled 22.1 · approved 25.3 · done 31.7 · todo 33.4 · planning 38.2 · in-review 46.2 · in-progress 47.0 |
| contrast  | dark  | blocked 11.8 · implemented 17.9 · approved 20.3 · done 24.1 · cancelled 24.3 · planning 32.7 · todo 40.2 · in-progress 53.3 · in-review 56.4 |
| midnight  | light | blocked 20.4 · approved 25.4 · cancelled 25.6 · done 31.6 · in-review 32.1 · planning 34.7 · todo 36.6 · implemented 44.6 · in-progress 46.7 |
| midnight  | dark  | blocked 12.1 · approved 20.4 · done 24.8 · cancelled 28.5 · planning 30.7 · in-review 32.2 · todo 44.5 · implemented 50.9 · in-progress 53.1 |

## The dot

The dot paints `var(--el-status-to-plan)` at full strength, as every status dot does
(`statusDotColor`). The status card owes the key entry beside the token:

```ts
STATUS_KEY_EL.to_plan = '--el-status-to-plan';
```

Without it the dot falls back to the `in_progress` category, so To plan's option in the status picker
would wear In Progress's blue — the collapse the Planning, Implemented and Approved entries each exist to
avoid. Panel 3 draws the picker with the entry in place.

## The state tag — an EIGHTH tint, `--el-tint-clay`, and `CirclePause`

The state tag (canvas card, board card, quick view, item page eyebrow) speaks the flat tint family. All
seven are held: peach Blocked, sky In Progress, rose Implemented, yellow Planning, lavender In Review,
sage Approved, mint Done, with `--el-muted` for To Do and Cancelled. Borrowing one re-creates two
statuses that render as one, and falling back to the category draws sky, In Progress's tag. So To plan
takes an eighth tint:

```css
--el-tint-clay: color-mix(in srgb, var(--el-status-to-plan) 30%, var(--color-surface));
```

**The status hue, quietened to a fill.** It rides the status token, so it moves with it and needs no
palette block. It is a `color-mix` rather than a `var(--color-tint-*)` alias for the reason
`--el-tint-sage` gives: a new Tier-0 tint would oblige every palette block to declare it.

Measured against the seven tints and `--el-muted`, and for `--el-text-strong` ink on it:

| Palette   | Theme | Resolved  | Nearest tint, ΔE2000 | `--el-text-strong` on it |
| --------- | ----- | --------- | -------------------- | ------------------------ |
| motir     | light | `#c4b5b0` | rose 13.1            | 7.86                     |
| motir     | dark  | `#584b45` | peach 14.7           | 5.93                     |
| amethyst  | light | `#cebcaf` | peach 10.7           | 6.68                     |
| amethyst  | dark  | `#58473b` | peach 9.9            | 7.01                     |
| cobalt    | light | `#c3b7b7` | rose 12.9            | 7.24                     |
| cobalt    | dark  | `#544e52` | peach 17.0           | 5.96                     |
| evergreen | light | `#c2bbae` | peach 13.0           | 7.65                     |
| evergreen | dark  | `#564f3f` | yellow 13.7          | 6.00                     |
| spectrum  | light | `#cfb9b8` | rose 11.9            | 7.92                     |
| spectrum  | dark  | `#5d4a55` | rose 14.6            | 5.87                     |
| amber     | light | `#c7bbb3` | peach 12.6           | 8.43                     |
| amber     | dark  | `#5e574f` | yellow 17.7          | 4.87                     |
| sienna    | light | `#cdb99a` | peach 11.4           | 7.32                     |
| sienna    | dark  | `#605340` | yellow 14.2          | 5.54                     |
| garnet    | light | `#c2b5ab` | peach 12.9           | 8.70                     |
| garnet    | dark  | `#5b5144` | yellow 14.8          | 5.88                     |
| citrine   | light | `#bfbbb9` | muted 13.3           | 9.04                     |
| citrine   | dark  | `#5d5949` | sage 15.2            | 5.95                     |
| candy     | light | `#ceb6b2` | rose 12.2            | 6.31                     |
| candy     | dark  | `#70534c` | sage 15.8            | 5.11                     |
| lagoon    | light | `#b7c0b4` | sage 10.9            | 6.38                     |
| lagoon    | dark  | `#4f6150` | sage 10.0            | 5.17                     |
| olive     | light | `#c3bcac` | sage 13.0            | 5.81                     |
| olive     | dark  | `#615a40` | sage 14.9            | 6.00                     |
| contrast  | light | `#c5bbad` | peach 12.8           | 8.60                     |
| contrast  | dark  | `#676048` | sage 15.0            | 5.41                     |
| midnight  | light | `#c4bbb0` | sage 14.0            | 5.91                     |
| midnight  | dark  | `#615a45` | sage 15.3            | 5.74                     |

**Worst ΔE2000 9.9** (amethyst/dark against peach), against the family's floor of 2 and the family's
own worst shipped pair of **2.8** (citrine/dark, lavender against sky). **Worst ink contrast 4.87:1**
(amber/dark), above AA's 4.5. The 30% ratio is the top of its window: 32% separates further (10.8) but
takes the ink to 4.64; 26% (sage's ratio) leaves clay within 8 of peach in amethyst/dark.

> **This measurement is by hand, and nothing in CI repeats it.** `familyHueSeparation.test.ts` measures
> priority, label, avatar and selection, not the tint family, as § _Approved_ already records. A palette
> that moves `--color-warning`, `--color-ink` or `--color-surface` needs this table re-taken.

**The glyph is `CirclePause`.** A ring around a pause: stopped, and not being worked, which is exactly
what To plan means to a reader. It joins the ramp's `Circle*` vocabulary (`CircleDot` In Progress ·
`CircleDotDashed` Planning · `CircleEllipsis` Implemented · `CircleCheck` Approved · `CircleDashed`
To Do) and is neither Planning's `CircleDotDashed` nor the slot pill's `ListPlus`. It is `aria-hidden`;
the label stays the accessible name, and glyph-only it rides `aria-label` on `role="img"` as every slot
pill does. Panel 4 draws it at full size and glyph-only.

The status card owes the row:

```ts
META_BY_KEY.to_plan = {
  icon: CirclePause,
  tint: 'bg-(--el-tint-clay)',
  text: 'text-(--el-text-strong)',
};
```

## The list chip — its OWN tone and glyph: yes

**Decision: `StatusPill` gives To plan its own tone and glyph.** Without one, To plan's chip is the
`in_progress` category's chip, In Progress's sky tint, which tells a reader the work has **started** —
the opposite of what the status means. Planning and In Review still share that chip (a gap the two
earlier column sections name and leave), but neither of them makes a false claim about starting; To
plan would.

- **The tone** is a new `Pill` status tone, `to-plan`, on the documented chip recipe the
  `implemented` and `approved` tones use:
  `bg-[color-mix(in_srgb,var(--el-status-to-plan)_14%,var(--el-surface))] text-(--el-text-strong) border-transparent`.
- **The glyph** is `CirclePause`, `h-3 w-3`, `aria-hidden` — the same mark as the state tag, so the two
  surfaces tell the same story about the same status.
- `TONE_BY_STATUS_KEY.to_plan = 'to-plan'` and `GLYPH_BY_STATUS_KEY.to_plan = CirclePause`.

Panel 5 draws it beside In Progress, Planning, Implemented and Approved.

### ⚠️ The chip is told apart by its glyph, not its tint — with a control

At 14% over the surface every status chip compresses into a narrow band. Measured with the same recipe
over all ten default hues, To plan's chip is nearest Implemented's at **ΔE2000 1.7** (citrine/light).
The control is the same recipe over the nine shipped hues, whose worst pair is **0.9** (motir/light,
To Do against Cancelled). To plan's worst pair is about twice the worst pair the recipe already yields.
So, as for Implemented and Approved, the glyph is the mechanism and not decoration (finding #35); do
not read the dot's 11.8 as a claim about the chip.

## The column — slot 6, immediately after Planning

The default board's order becomes **To Do · Blocked · In Progress · Implemented · Planning · To plan ·
In Review · Approved · Done · Cancelled**. To plan goes immediately after Planning, so the two
re-planning states sit side by side: To plan is the state a plan parks into Planning. It is one insert
between Planning and In Review; nothing existing moves, and **Implemented keeps slot 4**, the invariant
the eighth column's section pinned.

**The fold, from the shipped geometry.** A column is `w-72` (288px) in a `gap-4` row, 304px a column,
beside a 240px rail (56px collapsed), as § _Approved_ measured. Adding a tenth column after slot 4:

| Viewport                    | Content | Fully visible (9 → 10) | Planning (slot 5) | To plan (slot 6) | Scroll distance (9 → 10) |
| --------------------------- | ------- | ---------------------- | ----------------- | ---------------- | ------------------------ |
| 1280 × 800                  | 976px   | 3 → 3                  | off-screen        | off-screen       | 1744px → 2048px          |
| 1366 × 768                  | 1062px  | 3 → 3                  | off-screen        | off-screen       | 1658px → 1962px          |
| 1440 × 900                  | 1136px  | 3 → 3                  | off-screen        | off-screen       | 1584px → 1888px          |
| 1512 × 982                  | 1208px  | 4 → 4                  | off-screen        | off-screen       | 1512px → 1816px          |
| 1920 × 1080                 | 1616px  | 5 → 5                  | **FULL**          | 96px sliver      | 1104px → 1408px          |
| 1440 × 900 · rail collapsed | 1320px  | 4 → 4                  | 104px sliver      | off-screen       | 1400px → 1704px          |

These figures are derived from that geometry, not re-rendered at each viewport; the nine-column
figures they extend were measured in Chromium. **What gives: nothing.** The fully visible count is
unchanged everywhere; the cost is one more column of scroll, 304px. The board's own answers to a long
board (the rail collapses, the row scrolls and snaps, the board filter narrows it) are unchanged.

The column header, the card, the count badge and the empty state are the shipped `BoardColumn` and
`BoardCard` unchanged: `--el-surface` column, `--el-border`, `--el-count-bg` / `--el-count-text`,
`--radius-card`, _No work items_ in the dashed empty well. To plan adds a column, not a column style.
The board card carries no status chip beyond its state tag, because the column is the status.

## Told apart from the computed "To plan" slot pill

The product already draws a computed pill labelled _To plan_ on a childless story or epic in a To Do
status: its children have not been laid yet. It is a white chip (`--el-page-bg` fill, `--el-border`
edge) with a `ListPlus` glyph in `--el-text-secondary`. A work item at the To plan **status** is in the
`in_progress` category, so the computed pill never applies to it and its slot shows the status tag: the
two never render on one card. They do render on one board, so they must read apart without the label:

|       | The To plan status tag                | The computed To plan slot pill                                    |
| ----- | ------------------------------------- | ----------------------------------------------------------------- |
| Fill  | `--el-tint-clay` (a warm filled chip) | `--el-page-bg` with an `--el-border` edge (a white outlined chip) |
| Glyph | `CirclePause` (a ring with a pause)   | `ListPlus` (a list with a plus)                                   |
| Ink   | `--el-text-strong`                    | `--el-text-strong`, glyph `--el-text-secondary`                   |

Filled against outlined, and a ring against a list: the shape of the chip and the shape of the glyph
both differ, so neither depends on the hue. Panel 1 draws both on one board (To Do column against To
plan column) and panel 4 side by side, at full size and glyph-only. Neither label changes; whether
either is relabelled is not this design's call.

## The status picker

`StatusPicker` is a `Combobox` over the legal targets under the project's restricted policy. Panel 3
draws it open on a To Do item, so its options are To Do's targets in board order: To Do · Blocked ·
In Progress · Planning · **To plan** · Cancelled. To plan's option row is the shipped row (dot, label,
`--radius-control`, `--spacing-control-x/y`), its dot in `--el-status-to-plan`. The picker adds an
option, not a control, and keeps its `role="combobox"` / `role="listbox"` / `role="option"` structure.

## What the build owes, in one place

For the card that adds the status, which waits on this design:

1. `--el-status-to-plan` and `--el-tint-clay` in the Tier-3 base block of
   `packages/design-system/theme.css`, with the expressions above. No palette block.
2. `STATUS_KEY_EL.to_plan`, `META_BY_KEY.to_plan`, `TONE_BY_STATUS_KEY.to_plan`,
   `GLYPH_BY_STATUS_KEY.to_plan`, and the `to-plan` tone on `Pill`.
3. The column at slot 6 for new and existing default-workflow projects, Implemented still at slot 4.
4. `design/roadmap/design-notes.md` names the tint family as seven; it owes a one-line note naming the
   eighth, as it did for sage.

## What this design does NOT specify

- How a work item reaches To plan or leaves it: no comment, no mark, no transition is drawn. The design
  shows what a work item at To plan looks like, not how it got there.
- The status's catalogue strings beyond the English label _To plan_, taken as named.
- Un-collapsing Planning and In Review from In Progress's chip: still nobody's, as before.
- Renaming either _To plan_ label.

## Token / a11y rules honoured

- **Colour** only through `--el-*`: the two new tokens, each a `color-mix` of Tier-0 sources declared
  the way the Tier-3 base declares its own (`:root, [data-appearance-scope]`), and the shipped
  `--el-status-*`, `--el-tint-*`, `--el-surface`, `--el-page-bg`, `--el-border`, `--el-count-*`,
  `--el-text`, `--el-text-strong` and `--el-text-secondary`. No raw colour appears in the mock's markup;
  the hex values in this section are measurements of resolved tokens.
- **Shape** through element-semantic tokens: `--radius-badge` and `--spacing-chip-x(-6)` /
  `--spacing-chip-y` for the chip and tag, `--radius-card` for the column and the menu,
  `--radius-control` and `--spacing-control-x/y` for the picker rows, `--radius-input` and
  `--height-control` for its trigger. `rounded-full` only on the status dot.
- **Not colour alone** (finding #35): every To plan mark carries its label and the `CirclePause` glyph.
- **AA**: the tag's `--el-text-strong` ink is at least 4.87:1 on clay; the chip's at least the level
  the shared 14% recipe gives Implemented and Approved. The board chrome uses `--el-text`,
  `--el-text-strong` and `--el-text-secondary` only.

## How this asset was produced

Rendered with `renderMock` from a temporary generator (not committed), in two steps. A happy-dom step
rendered the shipped `BoardColumn` (with `BoardCard`), `StatusPicker` (open), `StatusPill` and the
`WorkItemStateTags` slot pills through `NextIntlClientProvider` with the `en` catalogue, writing each
panel's markup out; the To plan rows come from copies of `statusColor.ts`, `canvasStatusMeta.ts` and
`StatusPill.tsx` with the entries above added, swapped in with `vi.mock`. A node step assembled the
panels with `renderMock`, the two new tokens passed in its leading CSS. Presentation-only edits to the
dumped markup, all named: a column's viewport-tall height is a fixed sheet height; the board card's
`group` hooks are dropped; the portaled listbox sits in its panel (`position: static`); a trailing
script opens panel 1's row scrolled to Planning and To plan. The measurements came from a third
temporary step that swept candidate expressions through the separation suite's own resolver.
Rendered headlessly in Chromium at 1600px and every panel inspected in both themes, read at `main`
@ `58d9e3c9`.
