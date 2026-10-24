# Work-items — design notes

Design reference for the `work-items` UI area. Each surface names the design
asset it lives in, the primitives it composes from, copy strings, and placement.

| Surface                                                             | Asset                                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue detail page                                                   | `detail.pen` (Pencil) + `detail.png`                                                  | header eyebrow + Description / Explanation / Activity (left) · core-fields rail (right). Built across 2.4.1–2.4.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Create issue modal                                                  | `create.pen` + `create.png`                                                           | type/parent/title/description/priority + optional Explanation (panel 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tree view (issue list, nested)                                      | `tree.pen` + `tree.png`                                                               | issue tree rows + the `[Filter]`·`[Tree ▾]`·`[+ New issue]` toolbar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Tree view at scale (sort · lazy · virtual)**                      | **`tree-scale.mock.html`** (HTML mockup)                                              | The scale shape `tree.png` leaves unspecified (it loads the whole forest, no sort headers) — sortable treegrid headers + lazy-expand + virtualization. Finding #57. Gates 2.5.13 + 2.5.14. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Folders in the tree + the quick-view Folder field**               | **`folders.mock.html`** + `folders.png`                                               | Folder ROWS in the `/items` tree (pinned above work items, no work-item cells), the folder MENU (New folder inside · Rename · Move to… · Move up/down · Delete…), the toolbar `New folder`, the folder PICKER (move a folder / file a work item), the delete confirmation that moves contents up, and the quick view rail's Folder field. COMPOSES the shipped TreeTable and `QuickViewRailEdit`. Design card MOTIR-5311, story MOTIR-5308. See § Folders below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Placement — page Folder field, breadcrumb, filter**               | **`placement.mock.html`** + `placement.png`                                           | A filed work item outside the tree: the Folder `FieldCard` below Parent on its page (filed · through its root · not filed; open · saving · refused · read-only), the breadcrumb's folder segment, and the builder's Folder condition row on `/items` and in automation rules. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Flat sortable List view + view switcher**                         | **`list.mock.html`** (HTML mockup)                                                    | The List mode `tree.png` leaves unspecified (it draws only Tree + a disabled switcher seam). Gates 2.5.8. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Filter bar (kind · status · assignee · text)**                    | **`filter.mock.html`** (HTML mockup)                                                  | The open `[Filter]` popover `tree.png` leaves unspecified (it draws only a disabled `[Filter]` seam). Gates 2.5.4. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Relationships panel + ready/blocked badge**                       | **`relationships.mock.html`** (HTML mockup)                                           | The element `detail.pen` does NOT specify. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Link management (add / remove links)**                            | **`links.mock.html`** (HTML mockup)                                                   | Extends the relationships panel with the add/remove UI (2.4.8 → 2.4.9). See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **DatePicker calendar (Due-date field)**                            | **`datepicker.mock.html`** (HTML mockup)                                              | The design-system replacement for the native `<input type="date">` popup; consumed by the Due-date fields (2.4.11 → 2.4.12). See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Create modal — Due date field**                                   | **`create.mock.html`** (HTML mockup)                                                  | Extends `create.pen` with a Due-date row (`DatePicker`, after Priority) — finding #56 / "mirror Jira" (2.3.11 → 2.3.12). See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Work-item quick view (peek)**                                     | **`quick-view.mock.html`** + `quick-view.png`                                         | The peek modal + row trigger neither `tree.png` nor the 2.4 detail design specifies — a large two-column in-list preview (full description + core-fields rail) with "Open full page →", plus the **ready/blocked readiness banner** in the peek (2.5.20). Gates 2.5.19 + 2.5.21. **8.8.4 EXPANDS the rail to the full core-field set (gates 8.8.8) — overturns the curated subset.** **MOTIR-2561 makes the rail a WRITE surface (panels 7–12) — overturns the read-only decision; gates MOTIR-2563 / 2564 / 2565 / 2566.** See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **The status control says so — a move held by an approval**         | **`status-held-by-decision.mock.html`** + `status-held-by-decision.png` + `.dark.png` | While a move is held, the status control carries one held line per held status — Done with no pull request; Approved (decision) and Done (merge) with one open — and a **Review & approve** button into the full-screen overlay only on a decidable decision line; the held options in the dropdown; the `/items` row after a refused commit; the look-only reader; nothing-held states; `zh`. REVISED 2026-09-14. MOTIR-5523 (story MOTIR-4887) — gates MOTIR-5528 / MOTIR-5529, composed by MOTIR-5525. See § _The status control says so_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Comments + @mentions (Activity section)**                         | **`comments.mock.html`** (HTML mockup)                                                | The comment thread, composer, mention popup and every comment state — `detail.pen` draws ONLY the Activity placeholder ("Comments coming in Epic 5"). Single-level threading, oldest-first + sort toggle, "Edited" tag, hard-delete confirm, "Show more" paging. Gates 5.1.4 + 5.1.5. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Draft explanation with AI**                                       | **`draft-with-ai.mock.html`** + `draft-with-ai.png`                                   | The _Draft with AI_ INTERACTION for `explanationMd`, on BOTH the create modal and the detail page. Drawn against the SHIPPED components (`CreateIssueModal` disclosure + min `MarkdownEditor` + the existing disabled secondary "Draft with AI" button · `IssueExplanation` read-only card · `EditIssueForm`), NOT the legacy pens. Specifies streaming (SSE, 8.8.11), the draft landing in the editor (no accept/discard gate), `ai_draft` / `user_edited` source signalling, the cloud-gate, and the error state. Story 8.8 · 8.8.6 (MOTIR-1090). Gates 8.8.12 (MOTIR-1096). See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Work-item provenance on the detail rail**                         | **`provenance.mock.html`** + `provenance.png`                                         | `detail.pen`/`CoreFieldsPanel` draw no provenance surface — two new READ-ONLY rail `FieldCard`s (Planning · Implementation), each a `source · harness · model` triple + the "—" unknown state. Composes the shipped rail (does not redraw); source = a tinted `Pill`-chip (six values). Story MOTIR-1685 · MOTIR-1688 (design). Gates MOTIR-1693. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Plan / Re-plan entrance (detail + quick-view)**                   | **`plan-replan-entrance.mock.html`** + `plan-replan-entrance.png`                     | The contextual Plan / Re-plan entrance on BOTH the work-item detail page AND the quick-view / peek modal, for EVERY kind. COMPOSES the shipped surfaces — detail page (`detail.pen`), quick-view (`quick-view.mock.html`), universal workspace (`planning-workspace.mock.html` / 7.20.1), and `PlanWithAILauncher` (MOTIR-1299). **Plan / Re-plan is a CONVERSATION, not a single message** — the button opens the universal workspace directly; for Re-plan, the reason is captured as the FIRST CHAT TURN inside the workspace's chat rail (no pre-workspace form). Map scoped to item neighborhood, proposed nodes dashed, done work LOCKED. Confirm gate (MOTIR-911) as a bottom bar. Six panels: Plan button on detail · Re-plan button on detail · Plan button on quick-view · Re-plan button on quick-view · scoped workspace with conversation (Plan flow + Re-plan flow + continuing conversation) · states (loading/error/empty). Story 7.12 · MOTIR-1489 (design). Gates MOTIR-910. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Child panel — List ↔ Graph**                                      | **`child-panel-graph.mock.html`** + `child-panel-graph.png`                           | The Children section gains a `List` ↔ `Graph` view switcher; Graph mounts the shipped roadmap canvas **rooted at this item**, bounded in a 28rem block. COMPOSES `design/roadmap/` (node cards, edges, legend, ready highlight, breadcrumb, quick-view) — nothing there is redrawn. Five panels light + dark: the door · Graph · drilled · loading / empty-level / graph-unavailable · leaf-renders-nothing. Resolves the height, every canvas opt-in, the crumb root label, and the no-local-preference rule. Story MOTIR-2284 · MOTIR-2285 (design). Gates MOTIR-2287 + MOTIR-2288. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Design result panel**                                             | **`design-result.mock.html`** + `design-result.png`                                   | The published DESIGN RESULT of a design subtask — the rendered `design-notes.md` section, the `*.mock.html` in a bounded SANDBOXED cross-origin iframe, and the `.png` in the shipped lightbox. COMPOSES the detail page's left column, `ContentSectionCard`, `provenance.mock.html`'s chip grammar and `AttachmentPreview` — none is redrawn. BOTH the note and the frame MEASURED at 32rem with their own scroll in both axes — the note's bound is MOTIR-3510's amendment, and it renders through `MarkdownView` (`wmde-markdown motir-prose`). Three states, not five: the design-result decision record (MOTIR-2665) §2 decided there is no entitlement axis, so there is no upsell and no toggle. Story MOTIR-2664 · MOTIR-2669 (design), amended by MOTIR-3510. Gates MOTIR-2670. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **The UNIVERSAL APPROVAL FRAME (9 states)**                         | **`approval-control.mock.html`** + `approval-control.png`                             | The UNIVERSAL APPROVAL FRAME — a port that renders what is being decided, with the verbs below it. Gates MOTIR-4792 and, through it, every consumer. The Approvals TAB (MOTIR-4879) and the pull-request-merge subject body (MOTIR-4882) are NOT here. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **The item page hands the decision over — the call-to-action band** | **`approval-cta.mock.html`**                                                          | While the Design result section's gate is `awaiting` and the reader may decide it, the section's body is the version, how long it has waited, the state and ONE control, **Review & approve**, into the full-screen approval overlay. One container, one label: the frame never nests its own bordered card and _Design result_ heading inside the section; the kept states `B` / `E` / `F` / `G` render flush. No-gate unchanged. Narrow in `zh`. AMENDS the frame's item-page placement (dated 2026-09-15, revised on review). MOTIR-5228 (story MOTIR-5215) — gates MOTIR-5229. See § _The item page HANDS THE DECISION OVER_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **The STALE refusal — what you were looking at changed**            | **`approval-control--stale-refusal.mock.html`** (DELTA)                               | A DELTA on the UNIVERSAL APPROVAL FRAME (MOTIR-5233, Story MOTIR-5232): the fourth refusal a reader can meet on a live gate — the question is still theirs and something it is about MOVED (the published version, the pull requests, the acceptance criteria). One sentence per component, one for more than one, en + zh; ONE control, _Show the current version_, that re-reads in place. See § _The STALE refusal_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **The repository SET on the detail page**                           | **`repository-set.mock.html`** + `repository-set.png`                                 | EVERY repository a work item ships in, ordered, with each one's DELIVERY state — the surface table had no repository row at all, and MOTIR-2725 turns the single pin into a SET the completion gate reads. COMPOSES `FieldCard.tsx` and `components/github/DevelopmentSection.tsx` markup-for-markup (both RENDERED from the real components before this was drawn); the ONE new element is a Development row for a repository with no pull request yet. **REDRAWN against the REFERENCE model (Story MOTIR-2732 · MOTIR-3038):** every repository is now a LINK to the project's `project_repository` row, carrying its ROLE and — when it is not established — its establish STATE. TEN panels: the door · held · delivered · unrecorded branch · **the five delivery states** · **the destination** · one repo · none · **a `proposed` row** · editing. Story MOTIR-2725 · MOTIR-2413 (design), redrawn by MOTIR-3038. Gates MOTIR-2415 / MOTIR-3042; inherited by MOTIR-2414. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **The DELIVERY SET on the detail page**                             | **`delivery-set.mock.html`** + `delivery-set.png`                                     | The pull requests that DELIVER a card, many-to-many (MOTIR-3655). EXTENDS `repository-set.mock.html` and re-decides nothing it settled: the rail's glyph gains a truer PREDICATE (delivered = every delivery in that repository landed, not any linked pull request), and the caption's SUBJECT becomes whatever is outstanding — a repository, an open pull request, or one merged onto a base that is not its trunk. FOUR panels: the one-repository/two-pull-request card today's vocabulary reads as DELIVERED while the gate holds it · both merged · merged but not onto trunk · one delivery, unchanged. The ONE new element is a `Not on trunk` pill. Story MOTIR-3655 · MOTIR-3691 (design). Gates MOTIR-3660. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **The repository SET in the QUICK VIEW**                            | **`repository-set-quick-view.mock.html`** + `repository-set-quick-view.png`           | The COMPRESSION of the row above into the peek modal — a ROW CAP of three plus `+N more`, with the count caption always naming the TOTAL so no size renders as if the card carried fewer. Placement MEASURED at 1280×900 against the modal's `h-[680px]` / 621px rail: SECOND, after Status (y 137–246) — last-in-rail measured y 642–751, below the fold, which is why the two surfaces' field ORDER legitimately differs. The editor is deliberately UNcompressed: compression governs the READ, never the WRITE. **REDRAWN by MOTIR-3038:** the repository is a LINK here too, and the ROLE is DETAIL-ONLY — dropped in the compact row, MEASURED not asserted (see below). Story MOTIR-2725 · MOTIR-2414 (design), redrawn by MOTIR-3038. Gates MOTIR-2416 / MOTIR-3042. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **The item page at ARRIVAL / STREAMING**                            | **`detail-arrival.mock.html`** + `detail-arrival.png`                                 | What the page shows between the URL and the item: the page's OWN pending frame (the eyebrow row, the wide title, the `1fr / 18rem` split, the rail's card) — mounted as an in-page `<Suspense>` AFTER the gate, never as a `loading.tsx` (MOTIR-3492) — and the THREE-TIER allocation of every region — with the frame · with the first content · after the page. COMPOSES `design/shell/navigation-pending`'s grammar and the section skeletons this folder already draws; neither is redrawn. Decides that **the page settles TWICE**, so the five late sections are ONE boundary rather than five, and that the roll-up badge fills in place inside a reserved slot rather than earning a third. Story MOTIR-3430 · MOTIR-3432 (design), amended by MOTIR-3492. Gates MOTIR-3435 + MOTIR-3436. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **The Pages section — linking a page by hand**                      | **`item--pages-section--link.mock.html`** (DELTA, P1–P26)                             | The Link page door, its inline page picker, Unlink on a hand link only, the derived-link explanation, the unavailable row and the frames between them, as a delta of the shipped `PagesSection.tsx` (the component is the base of record). Gates MOTIR-9199 (the build), MOTIR-9202 (E2E + clip). Story MOTIR-7567 · MOTIR-9195.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **The TO-DO LIST on a work item**                                   | **`todo-list.mock.html`** + `todo-list.png`                                           | The ordered STEPS of a card's own work — one operation per row, ticked off, each carrying its own executor and, where the operation is a command, the command with a copy button. `design/work-items/` had NO checklist surface at all, so this is the NONE-exists case. COMPOSES `ContentSectionCard`'s header grammar over the shipped `Checkbox` / `Button` / `Tooltip`; nothing is redrawn and no colour or radius is invented. SEVENTEEN panels: placement (MEASURED at 1280×900) · the row in its three faces (plain · command · agent) plus the INSTRUCTIONS disclosure · empty · partly done · all done · read-only · adding · editing · dragging · delete confirm · at scale · the long command at 1280 AND at 390 · light + dark. Settles which of the two shipped copy grammars this surface takes (the button's own state, NOT a toast) and writes the overflow containment rule down in prose so the code card inherits it. Story MOTIR-3808 · MOTIR-3812 (design). Gates MOTIR-3815. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **The PENDING-PLAN indicator on the item page**                     | **`pending-plan-indicator.mock.html`** + `pending-plan-indicator.png`                 | What the item page says about a plan that proposes to change this card, ARCHIVE it, or ADD CHILDREN under it — the page read no plan at all when this was drawn, so it was the NONE-exists case. COMPOSES `ArchivedNotice` (the slot and the geometry), the shipped AI-proposal grammar (`ExpansionNudgeBanner`'s lavender `Card` + `Sparkles`), `detail-arrival`'s three-tier allocation and `WorkItemPlanEntrance`; none is redrawn. Settles the SLOT (first in `<main>`, above Description) and its TIER (**tier 2, inside the page's existing concurrent group** — not the late stack, which would resize a top-of-page box), the TONE with the archived mold rejected and every ink MEASURED, **one row per `PlanStatus` value including `stale`** (which MOTIR-4197's boundary never named), the copy per op and per plurality with its `zh` obligation, the three ABSENCES as panels, and the READ with its repository method and the reverse index that serves it. **AMENDMENT A (MOTIR-4364)** adds the THIRD case — a plan proposing CHILDREN under this card, which the reverse lookup could not return when the table was written — as five claims with six new keys, KEEPS the tone with a second alternative rejected, and settles that the count headline counts PLANS by collapsing the DTO to one row per plan. Nineteen panels, light + dark + 390. Design cards MOTIR-4256 · MOTIR-4364. Gates MOTIR-4197 · MOTIR-4365. See below. |

---

## Relationships panel + ready/blocked badge (Story 2.4 · 2.4.5)

`detail.pen` stops at the Parent rail field — it specifies no dependency/link
surface and no readiness signal. This HTML mockup (`relationships.mock.html`,
built from the live `--el-*` tokens + the shipped primitives) is the design
asset for that surface. The code subtask (2.4.5) composes the same primitives.

### Placement

A **left-column section card** (`Card` + `ContentSectionCard` header grammar),
a sibling of Description / Explanation / Activity, placed **after Explanation,
before Activity**. NOT a rail field-box — the rail holds single scalar values,
while relationships is a grouped, multi-row list that needs the content width.
On the **edit page** the same block renders read-only (panel 4), so an editor
keeps dependency context while editing.

### Anatomy

- **Header** — `ContentSectionCard` title `Relationships` + muted gloss
  `— dependencies & links`. Header-right carries a muted, non-interactive
  `Manage in Epic 5` note (link create/remove is Epic 5 — this surface is
  read-only; the note is the documented extension slot, mirroring Activity's
  "Comments coming in Epic 5").
- **Readiness banner** (the prominent ready/blocked treatment; the reusable
  `ReadinessBadge` primitive Epic 3 boards / Epic 6 reports reuse) — a
  full-width tinted row at the TOP of the card:
  - **Blocked** → `--el-tint-peach` bg, `circle-alert` icon in `--color-warning`,
    bold **Blocked**, detail `Waiting on N issue(s) — PROD-3, PROD-8` (the open,
    non-terminal blockers NAMED as mono links).
  - **Ready** → `--el-tint-mint` bg, `circle-check-big` icon in `--color-success`,
    **Ready to start** / `All blockers resolved`.
  - **Shown only when the item has blockers** (a "blocked by" in-edge). An item
    nothing blocks shows no banner — there is no readiness signal to give.
- **Groups** — one per kind, each rendered only when non-empty, in this order:
  **Blocked by · Blocks · Relates to · Duplicates · Clones**. Each group =
  a `SectionLabel` header + a mono count + a list of rows.
- **Row** (mirrors the 2.4.3 `ChildList` row): `IssueTypeIcon` (lucide glyph in
  the type's `--el-type-*` hue) · identifier (mono, `--el-text-identifier` —
  MOTIR-4255; it was `--el-text-muted`, which is 4.17:1 once the row takes its
  own `:hover` tint) · title (truncates) ·
  status `Pill`. The whole row is a link to that issue's detail page. An **open
  blocker** (non-terminal, in the Blocked-by group) carries a small
  `--color-warning` dot before its icon so the banner's named blockers are
  locatable in the list.
  - **Alignment:** the identifier and title share a **baseline** (the smaller
    mono id sits on the title's line, not vertically centered against it); the
    icon, dot, and status pill are vertically centered. In code (2.4.5) use
    `items-baseline` on the row with the icon/pill `self-center`, and truncate
    the title inside a `min-w-0` child so it keeps both the ellipsis and the
    text baseline.
- **Empty** (no links at all) → muted italic `No linked issues yet.` (never
  blank), and no readiness banner.

### States in the mockup

Panels, in order: **(0)** placement in the detail page · **(1)** blocked
(multi-group) · **(2)** ready · **(3)** no links · **(4)** edit-page read-only
block.

### Tokens / a11y

- Status pills go through `Pill`'s tones (`planned`/`in-progress`/`done` →
  lavender/sky/mint tint with `--el-text-strong` text — finding #35 AA-safe). A
  cross-project linked status the bundled workflow can't classify falls back to
  `Pill tone="neutral"` showing the raw key.
- Readiness state is conveyed by **text** ("Blocked" / "Ready to start"), never
  colour alone — the icon + tint are redundant cues. Clears the shell-a11y axe
  sweep (the detail-route sweep is 2.4.6's scope).
- Colour flows only through `--el-*` (the mockup copies the Tier-0→Tier-3 wiring
  from `globals.css`); toggle dark mode in the mockup to confirm token parity.

### Out of scope (documented extension slots)

Link **create/remove** UI (the "Manage" affordance) is Epic 5 collaboration —
this surface reads links only. `ReadinessBadge` is built reusable for Epic 3
boards + Epic 6 reports.

---

## Link management — add / remove relationship links (Story 2.4 · 2.4.8 → 2.4.9)

`links.mock.html` extends the relationships panel with the add/remove
interaction 2.4.5 deferred (it was read-only). Backend already ships —
`workItemsService.linkWorkItems` / `unlinkWorkItems` (1.4.4) + the typed trigger
errors. Mirror product: Jira's "Link issue" affordance on the issue detail view.

### Entry point

The read-only "Manage in Epic 5" header note is REPLACED by a quiet **"+ Link
issue"** button (`--el-link`, `Plus` icon) in the relationships card header.
Clicking it reveals the inline add form at the top of the card body (above the
banner/groups); it toggles to a "Cancel" affordance while open.

### Add form (inline, not a modal)

A `--el-surface-soft` bordered block holding one row:

- **Kind selector** — a `Combobox`/`Popover` trigger (`role="combobox"`) showing
  the current kind + chevron; the menu lists the five kinds **Blocked by ·
  Blocks · Relates to · Duplicates · Clones** (default "Blocked by"), the active
  one check-marked. Maps to `WorkItemLinkKindDto` (note: "blocks" is the inverse
  direction of `is_blocked_by` — the action layer flips from/to accordingly).
- **Issue-search Combobox** (the shipped 2.3.4 `Combobox`, listbox-combobox, not
  Radix Popover) — `Search` icon + input; the anchored `role="listbox"` shows
  candidate rows (type icon · identifier · title) from a workspace-scoped
  `listLinkCandidates` read (excludes self + already-linked; cross-project
  allowed per the link model). Empty results → muted "No matching issues."
- **Actions** — `Button variant="primary"` **Add** (disabled until an issue is
  selected) + ghost **Cancel**.
- A selected target shows as a **chip** (icon · id · title · clear ×) replacing
  the input until cleared.

### Errors (inline, AA-safe)

The 1.4.4 trigger errors round-trip to an inline **rose-tint banner**
(`--el-tint-rose` bg + `--el-text-strong` text + a `CircleAlert` in `--el-danger`
— finding #35, not red text on white): **self-link** ("PROD-N can't link to
itself"), **duplicate** ("This link already exists"), **cycle** ("That would
create a dependency cycle"), **cross-workspace** (candidate list already
prevents it, but the trigger backstops). Nothing persists on error.

### Remove

Each link row gains a quiet **× remove** button (`--el-text-muted`, hover →
`--el-tint-rose`/`--el-danger`) at the row end. Clicking opens a small **confirm
popover** ("Remove the blocked-by link to PROD-N? The issue isn't deleted — only
the link.") with a `--el-danger` Remove + ghost Cancel. Removing a `relates_to`
link drops both reciprocal rows (the service already does this).

### Tokens / a11y

- Reuses the relationships row grammar (id+title baseline, icon/pill centered).
- All new surfaces route through `--el-*`; the add combobox reuses the 2.3.4
  `Combobox` a11y (clears the STRICT axe sweep). Errors use strong-on-tint (AA),
  NOT `--el-danger` text on white. Light + dark parity (toggle in the mock).

### Create modal — Linked issues (panel 5)

`create.pen` ALSO designs a **"Linked issues"** section in the create modal (a
relationship-kind chip + a linked row + an "Add link" affordance + "Choose a
relationship") — but it was **never built** (2.3.3/2.3.4 shipped the modal
without it). It reuses the SAME kind selector + issue-search `Combobox` + remove
affordance as the detail panel, so the design is shared. The one real
difference is **timing**: at create the issue has no id yet, so chosen links are
**collected in form state** (rendered as pending rows with a relationship-kind
chip) and **written when the issue is created** — in / right after
`createWorkItem`, in the same flow — NOT immediately. Errors that need the new
id (cycle) are validated on create; self-link is impossible (no id yet);
duplicate is prevented in the pending list. This is a distinct code path from
the detail-page immediate write, so it's its own subtask (**2.4.10**), built on
the same AddLink control (2.4.9) + this design.

### States in the mockup

Panels: **(0)** entry point + per-row remove · **(1)** add form open + kind menu ·
**(2)** combobox typing (candidates) · **(3)** selected → Add enabled + the inline
error states · **(4)** remove confirm · **(5)** the create-modal Linked-issues
section (collect-then-write-on-create).

### Out of scope

Bulk-link / link from the list/board surfaces (Epic 3/2.5), and a typed
relationship beyond the five kinds, are not in 2.4.9 / 2.4.10.

---

## DatePicker calendar (Story 2.4 · 2.4.11 → 2.4.12)

The design-system **date picker** — the replacement for the native
`<input type="date">` calendar popup. The Due-date FIELD already uses the
`Input` primitive, but the native browser _calendar_ is OS chrome and breaks the
design system. This designs the in-system calendar so the 2.4.12 code subtask
(`components/ui/DatePicker`) composes our own primitives instead of improvising
(the design gate — there is no calendar in the system today). Asset:
`design/work-items/datepicker.mock.html`.

### Where it's used

The Due-date field on the issue **create modal** (2.3.3), the **edit form**
(2.3.6), and the **detail core-fields rail** (2.4.2). All three swap the native
control for `DatePicker`. Due date is **nullable**, so cleared is a first-class
state, not an error.

### Anatomy

- **Trigger** — an `Input`-styled field (composes `Input.tsx`'s chrome:
  `--height-input` 44px, `--radius-input`, `--el-border-strong` hairline,
  `--spacing-input-x` padding, the standard `focus` ring). A leading
  **calendar glyph** (lucide `calendar`, `--el-text-muted`); the value formats
  through the existing `formatDate` helper ("Jun 4, 2026"); a placeholder
  ("Select a date", `--el-text-muted`) when null. A trailing **Clear ×** shows
  ONLY when a date is set — hover tints `--el-tint-rose`/`--el-danger` (matches
  the link-row remove affordance from 2.4.9).
  - **Structure (important for 2.4.12):** the field is a **container**, not a
    single `<button>`. The calendar-open affordance (glyph + value) and the
    **Clear** button are **siblings** — the Clear `<button>` is NOT nested
    inside the trigger button (a `<button>` may not contain another `<button>`;
    the parser ejects the nested one and the × renders outside the field). So
    the field row = the `Popover.Trigger` surface (glyph + value → opens the
    calendar) + a separate Clear button at the row end.
- **Calendar popover** — floats in the `Popover` primitive (`--radius-card`,
  `--shadow-elevated`, `--el-border`), anchored to the trigger, `width ≈ 296px`.
  Contents:
  - **Caption row** — "June 2026" (`--el-text`, 14px/600) + prev/next-month
    `nav-btn`s (28px square, `--radius-control`, ghost → `--el-surface` hover,
    lucide `chevron-left`/`chevron-right`).
  - **Weekday header** — Su–Sa, `--el-text-secondary`, 11px/600 uppercase.
  - **Day grid** — 6 rows × 7 cols, each cell a 36px square button at
    `--radius-control`. The grid always shows leading/trailing days from the
    adjacent months (the `is-outside` state) so every month renders 6 full rows
    (no layout jump on month change).
  - **Footer** — **Today** (jumps the view + focus to the current date) and
    **Clear** (sets null), separated by a `--el-border-soft` rule.

### Day-cell states (the authority for 2.4.12)

| State                           | Treatment                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Default                         | `--el-text`, transparent bg, transparent border                                               |
| Hover                           | `--el-sidebar-item-bg-hover` fill                                                             |
| **Today**                       | `--el-border-strong` ring + **bold** + a small `--el-accent` **dot** under the number         |
| **Selected**                    | `--el-accent` **filled** circle, `--el-accent-text` ink, bold (hover → `--el-accent-pressed`) |
| Focused (keyboard)              | 2px `--focus-ring-color` ring (roving tabindex)                                               |
| Outside month                   | `--el-text-secondary`, still clickable/navigable                                              |
| Disabled (out of min/max range) | `--el-text-faint` + strikethrough, not selectable                                             |

**Today and selection are NOT conveyed by colour alone** (WCAG 1.4.1 /
finding #35): selected differs in _shape_ (a filled circle), today carries a
_ring + dot_ — a colour-blind / greyscale reader still distinguishes them. All
colour flows through `--el-*` (finding #54); when the selected fill needs an
inverted dot (today + selected), it uses `--el-accent-text`. Light + dark parity
(toggle in the mock).

### Keyboard model (for 2.4.12 to implement)

The grid uses **roving tabindex** — exactly one day is tabbable; focus moves
within the grid, re-rendering (and shifting the view month) as needed:

- `←` / `→` — focus previous / next day (±1)
- `↑` / `↓` — focus same weekday previous / next week (±7)
- `PageUp` / `PageDown` — previous / next month (same day-of-month)
- `Home` / `End` — first / last day of the focused week
- `Enter` / `Space` — select the focused day (closes the popover)
- `Esc` — close without changing; focus returns to the trigger

Crossing a month boundary with an arrow re-renders the grid to the new month
with focus on the landed day. The popover opens with focus on the selected day
(or today when null).

### States in the mockup

Panels: **(0)** placement in the core-fields rail · **(1)** trigger states
(placeholder / filled+Clear / focused / disabled) · **(2)** the open calendar
(live: click, nav, arrow-key the demo) · **(3)** every day-cell state, labelled ·
**(4)** cleared → placeholder. Selected = Jun 4, 2026; today = Jun 5, 2026.

### Out of scope

Range selection (start↔end), time-of-day, and a month/year quick-jump picker are
not in 2.4.12 — single nullable date only. Min/max range wiring (the `disabled`
state) is drawn here but only enforced where a field constrains it (none in 2.4).

---

## Flat sortable List view + the `[Tree ▾]` view switcher (Story 2.5 · 2.5.7 → 2.5.8)

`tree.png` designs only the **Tree** view and ships a **disabled** `[Tree ▾]`
control as a forward-compatible seam (2.5.3's `IssueListToolbar`). It does NOT
specify the **flat List mode** that control will toggle to, nor the open
switcher menu. `list.mock.html` is the design asset for both — built from the
live `--el-*` tokens + the shipped primitives, so the code subtask (**2.5.8**)
composes the same primitives with no Pencil→code gap. Mirror product: Jira's
issue-navigator "List" view + its view/sort headers.

### What's new vs. the Tree (and what's reused verbatim)

The List is the **same table as the Tree, un-nested and sortable**. Only three
things are new; everything else is the shipped `IssueTreeTable` (2.5.3):

- **Flat rows** — no indent, no chevron, no `treegrid` nesting. The rows are the
  project's issues in the active sort order (the Tree's depth-first order is
  gone).
- **Sortable column headers** — each header is a sort button (see below).
- **The switcher menu** — the `[Tree ▾]` control becomes a real menu.

Reused **with zero new primitives** (satisfies the AC "no new visual primitive
invented; consistent with tree.png"): the **whole column set** the shipped
`IssueTreeTable` already renders, the cell vocabulary, the container chrome
(`rounded-(--radius-card)` bordered box, `--el-surface-soft` header), and the
whole-row link to `/items/[key]`.

### Columns — the SAME set the shipped Tree renders

`IssueTreeTable` already renders seven columns (it went beyond `tree.png`'s
three drawn columns — that shipped code is enforced reality, rung 2). The List
**reuses that exact set and order**, so Tree↔List is column-identical and 2.5.8
reuses the same `cell` render-props:

| Column   | Width (px)   | Cell                                                  | Sorts by                       |
| -------- | ------------ | ----------------------------------------------------- | ------------------------------ |
| Title    | `≥10rem 1fr` | `IssueTypeIcon` (type hue) · mono identifier · title  | **issue key** (the default)    |
| Priority | 120          | `PRIORITY_META` chip (`Pill` tone + direction icon)   | priority rank (highest→lowest) |
| Assignee | 150          | initial-letter `Avatar` · name, or muted "Unassigned" | assignee name                  |
| Reporter | 150          | initial-letter `Avatar` · name                        | reporter name                  |
| Est.     | 72 (end)     | formatted duration, or muted `—` (right-aligned)      | estimate minutes               |
| Status   | 108          | `Pill` by lifecycle category (the `STATUS_TONE` map)  | workflow status order          |

**No Due column (Yue).** Due dates aren't a meaningful list/tree axis for Motir's
work, so the Due column is not drawn in any of the three views. Due is still
editable on the detail page's core-fields rail, stays a filter field, and the
`due` sort axis remains in the contract — only the table column is dropped.

Grid template (identical to `IssueTreeTable` / `IssueTreeSkeleton`; the live
template also carries the later **Type** (116), **Points** (80), and **Actions**
(76) columns added after this table was drawn):
`minmax(10rem,1fr) 120px 150px 150px 72px 108px`.

**Narrow-viewport floor (bug MOTIR-1307).** The Title track is `minmax(10rem,1fr)`,
**not** `minmax(0,1fr)`: a `0` floor let the flexible track collapse fully under
width pressure (a viewport narrower than the fixed-column sum), and the Title
cell's non-shrinkable content (the `IssueTypeIcon` + the mono `MOTIR-N`
identifier, both `shrink-0`) then spilled into — and visually overlapped — the
adjacent **Type** chip. The `10rem` floor clears the icon + identifier with a
little title showing, so the columns never collide. Est. (90→72) and Status
(130→108) were also trimmed to their content + a margin, shrinking the fixed
footprint so the row starts to clip at a narrower width. (A full horizontal-scroll
treatment for very narrow viewports is deferred: a naive `overflow-x-auto`
wrapper conflicts with the List's `sticky` header and the Tree's page-level
virtualization scroll model — it needs its own responsive-table design pass.)

**Decision — no NEW "Updated" column (the card offered Priority/Updated as
optional extras).** Priority is already a Tree column, and the seven existing
columns already give rich, meaningful sort axes — so the List earns its keep
through _sorting the existing columns_, not by adding data. Adding `updated_at`
would be new plumbing into `IssueRowData` + a new cell for marginal gain over
the existing Due/Est/Priority sorts ("no complexity for nothing"). An **Updated**
column (and column show/hide) belongs with Epic 6 saved-views, where recency
sort earns its place; noted as the documented extension, not built here.

### Sortable headers — the affordance

- Each header is a **sort button** (`text-(--el-text-secondary)`, uppercase
  11px, the existing header type) carrying a **caret** that is hidden by default.
- **Hover** a header → the caret fades in faint (`--el-text-faint`, ~55%) and
  the label goes to `--el-text` — the "this is sortable" affordance.
- **Active column** → caret is solid (`--el-text-secondary`), `ChevronUp` for
  **asc** / `ChevronDown` for **desc**, and the header cell carries
  `aria-sort="ascending|descending"`. Inactive headers are `aria-sort="none"`.
- **Default sort = `key` asc** — the **Title** column (the issue key is the mono
  identifier leading that cell), matching 2.5.8's AC. The Title header shows the
  active ascending caret on first paint.
- **Interaction (built in 2.5.8):** clicking a header sorts by that column asc;
  clicking the active header toggles asc↔desc; clicking another column moves the
  active sort there (asc). **Single-column sort only** — multi-sort is Epic 6.
- The right-aligned **Est.** column keeps its header + caret right-aligned.

### View switcher menu

The `[Tree ▾]` toolbar control (disabled placeholder in 2.5.3) becomes a real
menu (a `Popover` / menu, `aria-haspopup="menu"`). The trigger shows the
**active view's** label + icon (`ListTree` for Tree, `List` for List) + a
`ChevronDown`. The open menu lists two `menuitemradio` rows:

- **Tree** — `ListTree` icon + "Tree".
- **List** — `List` icon + "List".

The **active** row gets `--el-surface` bg, semibold weight, and a trailing
`Check` in `--el-accent`. Menu container is `--radius-card` + `--shadow-elevated`;
rows are `--radius-control` + `--spacing-control-*` padding (the shipped
menu-row shape). View choice is **URL-driven** in 2.5.8 (`?view=tree|list`), so
the trigger label reflects `?view` on load.

### Empty + loading

- **Empty** — reused **verbatim** from the Tree: the shipped `EmptyState`
  ("No issues yet" / "Create your first issue to start tracking work." +
  `NewIssueButton`). The switcher doesn't change an empty project; **no delta**.
- **Loading** — the Tree's `IssueTreeSkeleton` with **one delta: the rows are
  FLAT** — no per-row `INDENT` offset and no leading chevron block. Same column
  grid, same header, same shimmer bars/chips/avatars, so there's no layout shift
  on settle.

### Tokens / a11y

- Colour flows only through `--el-*`; status via `Pill`'s `status` tones,
  priority via the shared `PRIORITY_META` chip (hue in the tint, `--el-text-strong`
  text — finding #35 AA-safe), type icons take their `--el-type-*` hue.
- Shape via the element-semantic tokens (`--radius-card` / `--radius-control` /
  `--radius-badge`, `--spacing-control-*`, `--height-control`,
  `--shadow-elevated`) so the List re-shapes under `data-display-style`.
- **Sortable headers carry `aria-sort`** (2.5.8 wires the live value) — required
  by the 2.5.6 strict shell-a11y sweep, which adds the List view to its scope.
  Sort direction is conveyed by the caret glyph + `aria-sort` text, never colour
  alone. Toggle dark mode in the mock to confirm token parity.

### Pagination — server-paged navigator (2.5.10 → 2.5.12, finding #57)

The List **must not load every row** — a real backlog is thousands of issues
(finding #57). It is **server-paged** (mirroring Jira's issue navigator): a
fixed **page size of 50**, a `LIMIT/OFFSET` read + a count, and a **footer bar**
inside the same bordered table box (`--el-surface-soft`, top border):

- **Left — the range/count:** `Showing 1–50 of 1,234`. The total is the count of
  the **currently filtered** set (so the count tracks the 2.5.4 filter), with the
  `1–50` range reflecting the active page.
- **Right — the pager** (`<nav aria-label="Pagination">`): a **Prev** chevron
  button, numbered page buttons with **ellipsis truncation** at both ends
  (`1 … 12 [13] 14 … 25`), and a **Next** chevron button. The current page is the
  **accent chip** + `aria-current="page"` (not colour alone — it's also the only
  non-bordered, filled button). **Prev is disabled on page 1, Next on the last
  page** (`aria-disabled`, faint).
- **URL-driven:** the bar drives a `?page=` param that **composes with
  `?view`/`?sort`/filter** and is part of the route's Suspense key, so changing
  page re-shows the skeleton while the next page streams (panel 4's loader).
- **Edge states (for 2.5.12):** an out-of-range `?page` **clamps to the last
  page**; a filter that yields **0 rows** shows the empty state (panel 3) with
  **no pager** (or "0 of 0"); a single page hides/disables both chevrons. Page
  size 50 is a constant (Epic 6 may make it configurable — not here).
- **The Tree does NOT use this** — a hierarchy can't be cut at "row N"; the Tree
  scales via lazy-load + virtualization (2.5.11 → 2.5.13/2.5.14), a separate
  design.

Reuses shipped shape tokens (`--radius-control`, `--height-control`-class
buttons) + `--el-*`; no new primitive — page buttons are the Button affordance,
chevrons are lucide.

### States in the mockup

Panels: **(0)** the List view in the `/items` shell (toolbar + flat table,
default key asc) · **(1)** the switcher menu open (Tree / List, List checked) ·
**(2)** re-sorted by Priority desc (the active-sort indicator moved + the desc
caret) · **(3)** empty state · **(4)** the flat loading skeleton · **(5)** the
**pagination footer** — page 1 (Prev disabled, page-1 current) + a middle page
(13 of 25, both ends ellipsed).

### Out of scope (documented extension slots)

Saved / named views, multi-column sort, column show/hide config, and an
**Updated** column are **Epic 6** (saved views & advanced search) — not invented
here. Bulk actions from the list are also out of scope for 2.5.8. Configurable
page size + cursor (vs offset) paging are Epic-6 refinements; 2.5.12 ships
offset paging at a fixed 50.

---

## Tree view at scale — sortable headers · lazy-expand · virtualization (Story 2.5 · 2.5.11 → 2.5.13 / 2.5.14)

`tree.png` + the shipped `TreeTable` (2.5.2) / `getProjectTree` read (2.5.1)
load the **whole forest at once** with **no column sorting** — fine for a demo,
**prototype-thinking at real-product scale** (finding #57). Jira's hierarchy
grids (Structure / Advanced Roadmaps) don't paginate a tree; they **lazy-load a
node's children on expand** and **virtualize** rows, and they let you **sort
siblings within their parent**. `tree-scale.mock.html` is the design asset for
that scale shape — built from the live `--el-*` tokens + the shipped primitives
(the same `role="treegrid"` markup, 22px per-level indent, rotate-on-expand
chevron, stretched row link with the chevron raised `relative z-10` so no button
nests inside the `<a>`), so the code subtasks (**2.5.13** lazy reads · **2.5.14**
lazy/virtual/sortable `TreeTable`) compose the same vocabulary with no
Pencil→code gap. Mirror product: Jira Structure / Advanced Roadmaps.

### What's new vs. tree.png (and what's reused verbatim)

The tree is the **same treegrid**, made sortable + lazy + virtualized. Only
three things are new; everything else is the shipped `IssueTreeTable`:

- **Sortable tree-grid headers** — the **exact** asc/desc/unsorted caret
  affordance the List shipped (`list.mock.html`), applied to the
  `role="treegrid"` header row.
- **Lazy-expand** — a collapsed parent shows the chevron without loading its
  children; expanding fetches them (a spinner placeholder row on the expanding
  node); a **"Load more children"** affordance when a parent has more children
  than the per-node page.
- **Virtualization** — invisible (only viewport rows mount); documented, no
  distinct visual.

Reused **with zero new primitives** (satisfies the AC "no new visual primitive;
consistent with tree.png"): the seven-column set (Title · Priority · Assignee ·
Reporter · Due · Est. · Status — **column-identical to the List**, so Tree↔List
matches), the row vocabulary, the container chrome, the indent + chevron, the
whole-row link, and the empty / loading states (unchanged from `tree.png` —
not re-drawn here).

### Sortable headers — the affordance

Identical to the List's (see that section); on the treegrid:

- Each header is a **sort button** (uppercase 11px `--el-text-secondary`) with a
  **caret** hidden by default, faint on hover (`--el-text-faint`, ~55%), solid on
  the active column (`--el-text-secondary`): `ChevronUp` = **asc**,
  `ChevronDown` = **desc**. The active header cell carries
  `aria-sort="ascending|descending"`; the rest are `aria-sort="none"`.
- **Default sort = `key` asc** — the **Title** column (the mono identifier).
- **Single-column sort only** (multi-sort is Epic 6). Clicking a header sorts by
  it asc; clicking the active header toggles asc↔desc; clicking another moves the
  active sort there. The right-aligned **Est.** header keeps its caret
  right-aligned.
- **Sorting re-orders siblings WITHIN every parent — the hierarchy is
  preserved.** Each lazy children-fetch carries the same `ORDER BY <sort>`, so
  siblings sort under their own parent and **no row ever leaves its parent**.
  (Panel 1: by Priority desc, under PROD-12 the High story rises above the
  Medium ones; under it the Highest bug → High task → Medium task.) Sort is
  conveyed by the caret glyph **and** `aria-sort` text, **never colour alone**
  (WCAG 1.4.1 / finding #35).

### Lazy-expand — per-node paging

- **Per-node page size = 50 children.** A node's children are fetched on first
  expand, 50 at a time, ordered by the active sort. (2.5.13 shapes the read:
  `listRoots` + `listChildren(parentId, { sort, cursor, take: 50 })`.)
- **Collapsed parent** — shows the chevron (it has children) **without** loading
  them; `aria-expanded="false"`. The whole-forest count is NOT pre-fetched.
- **Expanding** — the node flips `aria-expanded="true"` + `aria-busy="true"` and
  renders **one spinner placeholder row** at the children's indent
  (`Loading children…`, the lucide `loader` ring) until the page arrives, then
  the real rows replace it.
- **"Load more children"** — when a parent has more children than the loaded
  page, a quiet `--el-link` row sits at the **end of that parent's loaded
  children**, at the children's indent: a `ChevronDown` glyph + **"Load more
  children"** + a faint `--el-text-secondary` count (`Showing 50 of 128`). Clicking
  fetches the next page (same `ORDER BY`) and **appends** — the parent never
  collapses. This is per-node paging, distinct from the **List**'s flat
  whole-result pagination (2.5.10 / 2.5.12).

### Virtualization — invisible, but a11y-honest

Only the rows in (or near) the viewport mount; off-view rows are removed from the
DOM and a spacer preserves scroll height. **No distinct visual** — a virtualized
row is identical to a non-virtualized one (so the mock documents it rather than
drawing it). **A11y holds across the window:** each mounted row keeps its true
`aria-level` / `aria-posinset` / `aria-setsize` (the lazy read returns the
per-node total for `aria-setsize`, e.g. `posinset 19 / setsize 128`), so a
screen reader announces the real position even though only a window exists. The
shipped `TreeTable`'s **roving-tabindex** keyboard model is unchanged:
<kbd>↑</kbd>/<kbd>↓</kbd> move the active row (auto-scroll mounts the landed
row), <kbd>→</kbd> expands a collapsed parent (triggering its lazy fetch) or
steps into children, <kbd>←</kbd> collapses or steps to the parent,
<kbd>Enter</kbd> activates the row link.

### Tokens / a11y

- Colour flows only through `--el-*`; status via `Pill`'s tones, priority via the
  shared `PRIORITY_META` chip (hue in the tint, `--el-text-strong` text — finding
  #35 AA-safe), type icons take their `--el-type-*` hue.
- Shape via element-semantic tokens (`--radius-card` container, `--radius-badge`
  chips, `--radius-control` chevron, `--spacing-control-*`, `--shadow-*`) so the
  tree re-shapes under `data-display-style`.
- The treegrid keeps the shipped WAI-ARIA pattern: `role="treegrid"` › rowgroup ›
  row(`aria-level`/`posinset`/`setsize`/`expanded`) › gridcell, sortable headers
  carrying `aria-sort` (2.5.14 wires the live value), exactly one row tabbable
  (roving tabindex). The full sweep is the Story E2E + strict a11y (2.5.6, which
  already lists 2.5.14 in `depends_on`). Toggle dark mode in the mock to confirm
  token parity.

### States in the mockup

Panels: **(0)** the Tree in the `/items` shell — sortable headers, nested rows,
default sort key asc, a **collapsed** parent (PROD-23) showing its chevron with
no children loaded · **(1)** sorted by **Priority desc** — siblings re-ordered
**within** every parent, hierarchy preserved, the active caret moved ·
**(2)** lazy-expand **in progress** — PROD-23 mid-expand with the spinner
placeholder child row · **(3)** **"Load more children"** — a paged parent
(showing 50 of 128) with the load-more affordance row · **(4)** virtualization +
keyboard / `aria-sort` note (no distinct visual).

### Out of scope (documented extension slots)

Multi-column sort, saved / named views, and column show/hide are **Epic 6**.
Cross-project / workspace-wide tree scale, and a count-all-descendants badge, are
not built here. The **List**'s flat pagination is its own design (2.5.10) + code
(2.5.12) — this section is the **tree** (per-node) shape only.

---

## Filter bar — kind · status · assignee · text (Story 2.5 · 2.5.9 → 2.5.4)

`tree.png` draws the `[Filter]` toolbar control only in its **disabled, closed**
state — a forward-compatible seam (2.5.3's `IssueListToolbar`, the same one
`list.mock.html` carries). It does NOT specify the **open filter surface** that
control opens. `filter.mock.html` is the design asset for it — built from the
live `--el-*` tokens + the shipped primitives, so the code subtask (**2.5.4**)
composes the same primitives with no Pencil→code gap. Mirror product: Jira's
issue-navigator basic filters / Linear's filter menu (a popover of faceted
multi-selects + a text quick-filter).

### Shape — a Popover of faceted multi-selects, NO new primitive

The `[Filter]` control becomes an **enabled** `ToolbarButton` (same `.tb-btn`
shape) that opens a **`Popover`** (`role="dialog"`, `aria-haspopup="dialog"`)
anchored under it (left-aligned). The popover surface reuses the **exact card
chrome the view-switcher menu uses**: `--radius-card` container, `--el-border`
hairline, `--shadow-elevated`. Inside, **four facets**, top to bottom:

| Facet        | Source (already in context)                                        | Row vocabulary (reused)                                                         |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Text**     | a free-text quick-filter over identifier + title                   | the bordered `Combobox` **search input** (`--radius-input`, leading `Search`)   |
| **Kind**     | `ISSUE_TYPE_META` (the five issue types)                           | `IssueTypeIcon` (type hue) · label · trailing `Check`                           |
| **Status**   | the project's **workflow statuses** (`StatusPicker` option source) | the `StatusPicker` **dot** (`status.color ?? category var`) · label · `Check`   |
| **Assignee** | workspace members + an explicit **"Unassigned"**                   | member-combobox `Avatar` (initial-letter) · name · `Check`; Unassigned is first |

Each facet is a **multi-select** `role="listbox"` (`aria-multiselectable="true"`)
of `role="option"` rows — the **same option-row vocabulary the `Combobox`
ships** (leading glyph · label · optional secondary · trailing `Check`), made
multi-select: `aria-selected="true"` adds the `--el-surface` row tint + the
`--el-accent` `Check`. **No new picker primitive** (satisfies the AC) — the kind
icons, the status dot, the member avatar, and the option row all already exist;
only the popover that composes them and the trigger's count badge are new, which
is exactly 2.5.4's scope. The Assignee facet carries the member-combobox's own
**"Search members…"** type-ahead since membership can be long; the top-level
**Text** facet is the issue quick-filter (distinct placeholder "Find by ID or
title…").

### The trigger — active state + the count badge

- **Inactive** (no filters): the `[Filter]` button reads exactly like the
  shipped seam (`Sliders` icon + "Filter"), now **enabled**.
- **Active** (≥1 filter applied): the button gains a faint accent ring
  (`--el-accent` border + `--el-tint-lavender` fill, the icon → `--el-accent`)
  and a trailing **count badge** — a small `--radius-badge` `--el-accent` chip
  with `--el-accent-text` ink showing the **number of active filter values**
  (each selected kind/status/assignee option counts 1; a non-empty text counts
  1). The badge is the **only net-new affordance** over the disabled seam. AA:
  the button label stays `--el-text` on the page bg (never hue-on-hue).

### Clear + apply

- **"Clear filters"** lives in the popover **header**, right-aligned (`X` glyph +
  label, `--el-link`). It is **disabled/greyed when nothing is selected** and
  active once any facet has a value; clicking it resets every facet to empty
  (→ the full unfiltered tree). The same reset is reachable from the trigger.
- **No Apply button.** Filters apply **live** and serialize to the **URL query**
  (`?kind=…&status=…&assignee=…&q=…`, `assignee=unassigned` for the Unassigned
  bucket) — the durable, shareable/reload-safe substrate Epic 6 saved filters
  persist. The Server Component reads the params and re-queries.

### Context-preserving result (reuses 2.5.1)

Filtering feeds `getProjectTree`'s **ancestor-retaining** filter (2.5.1): a
matching descendant keeps its **ancestor chain visible for context**. In the
mockup's applied panel, ancestor rows that don't themselves match read **muted**
(`--el-text-muted`); the actual matches read full-strength — so the tree stays
legible instead of collapsing to orphaned rows. This is the shipped Tree row
vocabulary (`IssueTypeIcon` · identifier · `Pill`), not a new surface.

### Tokens / a11y

- Colour flows only through `--el-*`: the count badge / selected-row tint /
  `Check` use `--el-accent`; status dots use the `StatusPicker` category vars
  via their `--el-*` equivalents (todo → `--el-text-faint`, in_progress → (faint is correct here: a status DOT, not the label)
  `--el-info`, done → `--el-success`; a custom-coloured status like "In Review"
  carries its own colour); kind icons take their `--el-type-*` hue; result pills
  are `Pill` tones (hue in the tint, `--el-text-strong` text — finding #35
  AA-safe).
- Shape via element-semantic tokens (`--radius-card` popover, `--radius-input`
  search field, `--radius-control` rows, `--radius-badge` count chip,
  `--spacing-control-*`, `--height-control`, `--shadow-elevated`) so the filter
  bar re-shapes under `data-display-style`.
- The popover is a labelled `role="dialog"`; each facet is a `role="group"` +
  multi-select `role="listbox"` of `role="option"` rows with `aria-selected`;
  the trigger carries `aria-haspopup="dialog"` + `aria-expanded`, and the count
  badge an `aria-label` ("N filters active"). Selection state is conveyed by the
  `Check` glyph + `aria-selected`, never colour alone. Toggle dark mode in the
  mock to confirm token parity. The end-to-end filter behaviour (incl. the URL
  round-trip + ancestor retention) is driven by the Story E2E (2.5.6).

### States in the mockup

Panels: **(0)** the `[Filter]` trigger — closed-inactive vs. closed-active
(accent ring + count badge) in the `/items` toolbar · **(1)** the popover open,
**empty** (nothing selected, "Clear filters" disabled) · **(2)** the popover
open, **populated** (text "oauth" · Bug · In Progress + In Review · Dana Kim +
Unassigned → badge 5, "Clear filters" active) · **(3)** the applied filter on the
page — the active trigger over the context-preserving tree.

### Out of scope (documented extension slots)

**Saved / named filters**, the shareable-filter management UI, **advanced search
operators** (boolean/JQL-style), and filtering by custom fields are **Epic 6**
(saved views & advanced search) — the URL serialization 2.5.4 ships is the
forward-compatible substrate they build on, not a throwaway. Sorting the
filtered set is the **List view's** job (2.5.8), not the filter bar's.

---

## Create modal — Due date field (Story 2.3 · 2.3.11 → 2.3.12)

`create.mock.html` extends the create-issue modal (2.3.3) with a **Due date**
field — finding #56 ("yes, mirror Jira"). Jira's create dialog collects a Due
date; Motir's modal did not, and `create.pen` designs the modal with
type/parent/title/description/priority (+ an **Assignee** field that was never
built — finding #51) but **no Due date**. This pins where it goes and how it
composes, so 2.3.12 isn't improvising (the design gate — `create.pen` omits it).

### What's new (and what's reused)

The field **reuses the shipped `DatePicker`** (2.4.11 design / 2.4.12 code) —
no new component. The only new design decision is its **placement and label**:

- **A "Due date" row placed right AFTER Priority** (and before "Linked issues"),
  matching the shipped **edit form**'s field order (Priority → Due date →
  Estimate, 2.3.6) and Jira's create dialog. It uses the modal's existing
  label-over-control row grammar (same as Type / Parent / Priority).
- The control is the **`DatePicker` trigger** — `Input`-styled field (calendar
  glyph + value or "Select a date" placeholder + a Clear ×), opening the
  `Popover` month grid. All states/tokens are exactly the `DatePicker`'s
  (see the DatePicker section); nothing about the calendar changes here.
- **Nullable** — Due date is optional at create; default is the placeholder, no
  value. (Jira likewise lets you create without a due date.)

### Behaviour (for 2.3.12)

- The chosen date is **collected in the modal's form state** (an ISO
  `YYYY-MM-DD` string, like the other create fields) and written when the issue
  is created — passed through `createIssueAction` → `createWorkItem`. The
  `work_item.dueDate` column already exists (the edit form writes it); this just
  wires the create path to it. No new calendar behaviour.
- UTC-safe conversion on submit (the same `${date}T00:00:00.000Z` the edit form
  - detail rail use) — no local-tz off-by-one.

### States in the mockup

Panels: **(1)** the modal with Due date **empty** (placeholder, after Priority) ·
**(2)** Due date **filled** (Jun 4, 2026) with the **calendar open** anchored
under the field (the same grid the shipped `DatePicker` draws; selected Jun 4,
today Jun 5). The other modal fields are drawn as representative controls (their
real pickers are already shipped) — only the Due-date field is specified here.

### Out of scope

The `create.pen` **Assignee** field (designed, never built — finding #51) is NOT
addressed here. Date ranges / relative presets / time-of-day stay out (the
`DatePicker` is single-date only).

---

## Work-item quick view (peek) modal (Story 2.5 · 2.5.18 → 2.5.19; readiness 2.5.20 → 2.5.21)

`quick-view.mock.html` is the design for the `/items` **quick view** — a _peek_
overlay that previews a work item **without leaving the list**, with a prominent
path to the full detail page. Neither `tree.png` nor the 2.4 detail design (`detail.pen`)
draws this surface, so the planning-time design gate (`notes.html` mistake #31)
requires it before code Subtask **2.5.19**, the same way `list.mock.html` (2.5.7)
and `filter.mock.html` (2.5.9) closed the gate for the List view and the filter
popover. Built from the live `--el-*` tokens + the shipped primitives; **no new
visual primitive is invented** (AC).

**Composing primitives (all shipped):**

- **`components/ui/Modal`** — the dialog shell (the same one `CreateIssueModal`
  (2.3.3) and `create.mock.html` use): backdrop, centered panel, `--shadow-modal`,
  `--radius-modal`, the `×` close button, and the focus-trap / `Esc` / return-focus
  behaviour. The peek is **large** — it takes a big part of the screen: **≈940px
  wide, ~82vh tall** (`max-w-[58rem]` + a `max-h-[82vh]`, capped so it never
  exceeds the viewport). This is wider than Modal's stock `size="lg"`, so 2.5.19
  passes an explicit `size="xl"` / a `max-w-[58rem]` className (add the `xl` size
  token to `Modal` if not present — the per-component growth pattern). **Sizing
  rationale (per Yue, 2026-06-06, decision-authority rung-0 user directive):** the
  card framed the peek as a small "condensed subset"; Yue overrode that — the peek
  should be generous and show the **full** description, not a teaser. It remains a
  _peek_ (read-only, prominent "Open full page", no inline edit / no comments feed),
  just a big one — the Linear/Jira peek shape.
- **`IssueTypeIcon`** — the type glyph in its type hue (`--el-type-{epic|story|task|bug|subtask}`),
  in the header bar.
- **`Pill`** — the Status chip (lifecycle-category tone via the `STATUS_TONE` map)
  in the header + the rail, and the Priority chip (`PRIORITY_META`) in the rail —
  the exact chips the rows + detail page already render.
- **Avatar** — the initial-letter assignee + reporter avatars (same as the row `cell-person`).
- **`Button`** — `btn-primary` "Open full page →" (in the header bar) + `btn-ghost`
  "Close" (in the empty state); the `×` close `icon-btn` in the header.

### The row trigger — resolving the nested-interactive problem

The Tree (2.5.3) and List (2.5.8) rows are **already a whole-row link** to
`/items/[key]`, shipped as a wrapping `<a class="lt-row" href>`. A quick-view
`<button>` **cannot nest inside that `<a>`** (no nested interactive elements; it
breaks AT semantics and HTML validity). Resolution:

- Render the row as a **relative `<div role="row">`** (was the `<a>`).
- The navigation link moves **into the Title cell** and is rendered as a
  **stretched link** — an `<a>` whose **`::after { position:absolute; inset:0 }`**
  overlay covers the whole row. Clicking anywhere on the row (except a layered
  control) navigates; the row title is the link's accessible name.
- Add a **trailing row-actions cell** (a new **40px** column appended to the
  shipped 7-column grid → `… 130px 40px`; **Tree and List share the same
  template**, so both gain it together). It holds the quick-view **icon
  `<button>`** (lucide **`eye`**, `aria-label="Quick view PROD-N: <title>"`),
  positioned **`z-index: 1` above** the stretched-link overlay. Button and link
  are **siblings, never nested**.
- The button is **hidden at rest** (`opacity: 0`), revealed on row `:hover` /
  `:focus-within` (and on its own `:focus-visible`), and **always visible on
  coarse pointers** (`@media (hover: none)`) so touch users get it. The 40px
  column is always reserved → no layout shift.

### Modal layout — a large, two-column peek

The peek is a generous overlay (NOT a small card): a **sticky header bar** over a
**two-column body** — a scrollable main column + a core-fields rail. It reads like
the detail page, scoped to a peek.

| Region                 | Content                                                                                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header bar (sticky)    | `IssueTypeIcon` (type hue) · **`PROD-N`** (mono, a **link** to `/items/[key]`) · Status `Pill` · spacer · **`btn-primary` "Open full page →"** · `×` close `icon-btn`                                                                                                                                           |
| Main (scrollable, 1fr) | the title (serif `--font-serif` 27px, matches the detail header), then the **full Markdown description** (`MarkdownView`) under a "Description" label, then a quiet `--el-text-muted` footer line naming what's full-page-only                                                                                  |
| Rail (300px)           | the detail page's **core-fields rail, condensed** — **Status** (`Pill`) · **Assignee** (Avatar + name) · **Reporter** (Avatar + name) · **Priority** (`PRIORITY_META` chip) · **Due date** · **Estimate** (clock glyph + duration) · **Parent** (breadcrumb link). `--el-surface-soft` bg, left hairline border |

**What the peek shows vs. what stays detail-only.** Shown: type, key, title, the
**readiness banner** (ready/blocked — 2.5.20, see below), the **full description**,
status, assignee, reporter, priority, due, estimate, parent.
**Detail-only** (reached via _Open full page →_ in the header bar / the header
identifier — both clearly go to the detail page): the **Explanation**, the
**child list**, the **full relationships/links panel** (2.4.5) — the Blocked-by /
Blocks / Relates-to / Duplicates / Clones groups and link add/remove — **attachments**,
**labels**, and the **activity / comments feed**. The peek is a big, read-only preview —
editing and the heavier sections live on the full page. **(Reconciliation, 2.5.20:** the
readiness **signal** moved OUT of detail-only and INTO the peek; only the full
relationships **panel** stays detail-only.)

### Readiness — ready / blocked (Subtask 2.5.20)

The peek surfaces the item's **readiness** so a viewer can tell, while scanning the
list, whether an item is **Ready to start** or **Blocked** (and on what) — without
opening the full page. It **reuses the shipped `ReadinessBadge` (2.4.5)** verbatim — the
SAME mint / peach banner the detail page's relationships panel renders — so **no new
visual primitive** is invented.

- **Placement** — a full-width banner at the **top of the main column, directly under
  the title and above the Description** (panel 2). Rationale: the title identifies the
  item; "can I start this?" is the next thing a scanner wants, so the banner is the first
  thing in the scrollable main area. NOT the rail — the rail holds scalar fields, while a
  full-width call-out reads stronger and matches how the badge sits atop its section on
  the detail page.
- **States** — **blocked** (peach, `circle-alert` in `--color-warning`, **Blocked** +
  `Waiting on N work item(s) — PROD-3, PROD-8` naming the open, non-terminal blockers);
  **ready** (mint, `circle-check-big` in `--color-success`, **Ready to start** / `All
blockers resolved`); and **no blockers → NO banner at all** — mirror the detail-page
  rule: an item with no `is_blocked_by` in-edge has no readiness signal to give. Panel 2
  draws **blocked** in context; **panel 3** draws **ready** + the **no-banner** case.
- **Only while the item is in the `todo` category** — once a peeked item is in-progress or
  done, the readiness banner is suppressed regardless of blockers: "can I start this?" is
  moot once work has started or finished (2.5.21). So the banner shows iff the item is
  todo-category AND has blockers.
- **Blocker links swap the peek** — a named blocker link pushes **`?peek=<blockerKey>`**
  (staying on `/items`, swapping the peeked item) rather than navigating to
  `/items/[key]`. Rationale: the peek exists to inspect _without losing your place_, so
  swapping keeps the user in-list and Back / `Esc` steps back through peeked items. This
  is a **justified deviation** from the detail-page badge (which links straight to
  `/items/[key]` because there is no peek there): the only delta 2.5.21 passes to the
  shared component is each blocker's `href` (`?peek=…` instead of `/items/[key]`) — the
  `ReadinessBadge` component itself is unchanged.
- **Data — no new query.** `readiness` is **already part of the core detail read** the
  peek issues: `getIssueDetail` returns `readiness: { ready, openBlockers }` — the same
  verdict the detail page feeds to `ReadinessBadge` — so 2.5.21 renders the badge from
  data already in hand (it maps `openBlockers` → `{ identifier, href }` exactly as the
  detail page does, only with the `?peek=` href). State is conveyed by **text + icon,
  never colour alone** (AA-safe, finding #35); colour flows only through `--el-*`.

### States (multi-panel)

1. **Populated** — panel 2 (drawn **blocked**, so the readiness banner is visible in
   context).
2. **Readiness states** (panel 3) — the **ready** banner + the **no-blockers** case
   (no banner), isolated side-by-side (2.5.20, see above).
3. **Loading** (panel 4) — the modal opens immediately (URL-driven, `?peek=PROD-N`);
   the item's fields fetch in the background. Skeleton bars (`--el-muted`, gentle
   pulse) hold the header / main / rail layout so the modal doesn't resize when data
   lands. The _Open full page_ button is live throughout.
4. **Not found / no access** (panel 5) — a stale `?peek=` key (deleted issue) or a
   forbidden one shows a centered empty state (the header bar keeps only the `×`):
   a `search-x` glyph in a muted circle, **"This issue isn't available"**, a line
   explaining it may have been moved/deleted or is in a workspace you can't access,
   and a `btn-ghost` **Close**. **Cross-workspace returns the same not-found**
   (finding #44's pure-workspace gate — never leak existence). A `lock` glyph
   variant covers an explicit no-access message if the product later distinguishes
   them. No _Open full page_ button (there is no page to open).
5. **Mobile / narrow** (panel 6) — the same Modal renders as a full-height bottom
   **sheet** (rounded top corners, grab handle, scrollable body, ~90% height)
   instead of a centered dialog. The 300px rail **collapses into a compact meta
   strip** (Assignee · Priority · Due) above the description; _Open full page_ is
   pinned full-width at the bottom as the primary action; close is backdrop /
   swipe-down / `Esc`.

### Opened from both views

The trigger lives in the **shared row-actions cell**, so the peek opens
identically from a Tree row or a List row. The modal is **URL-driven**
(`?peek=PROD-N` on `/items`) so it survives a refresh, is shareable/deep-linkable,
and Back closes it — the standard "preview as a URL state" pattern (Linear's peek,
GitHub's issue hovercard→modal). 2.5.19's data load reuses `getWorkItemByIdentifier`
/ the detail aggregate read (the same source the full page uses) — the peek shows
the full description + core fields, so it needs the same core read, just without the
heavier child-list / relationships / activity sub-queries (those stay full-page).

### Colour + shape

Colour only through `--el-*`: type hue via `--el-type-*`, status/priority via the
`Pill` tones (hue in the tint background, `--el-text-strong` text — AA-safe,
finding #35), `--el-link` for the identifier + "Open full page", `--el-text-secondary`
meta labels. Shape through the element-semantic tokens — `--radius-modal` (panel),
`--radius-badge` (pills), `--radius-control` (icon button + close), `--radius-btn`
(footer buttons), `--shadow-modal`, `--height-control` / `--spacing-icon-btn` (the
quick-view button). No Tier-0 utilities, no raw `rounded-*`.

### Out of scope

Inline editing inside the peek (status / assignee change without opening the full
page) is **not** in 2.5.19 — the peek is read-only with one write path (navigate to
the detail page to edit). Prev/next navigation _between_ peeked issues, comments,
and the hovercard-on-hover variant stay out; the modal-on-click peek is the
scope. Keyboard-shortcut opening (e.g. a row's `Space`/`O`) is a nice-to-have for
2.5.19, not required by this design.

### Expanded field set — the peek shows ALL core fields (Story 8.8 · 8.8.4 → 8.8.8)

**8.8.4 overturns the curated-subset decision above.** The 2.5 peek deliberately
showed only a curated rail (Status · Assignee · Reporter · Priority · Due ·
Estimate · Parent) — "a big, read-only preview, the heavier stuff on the full
page." The launch-readiness ask (8.8) is the opposite: **show ALL the work-item
fields in the peek**, so a scanner sees the complete picture without opening the
page. This is a deliberate reversal of the earlier call, recorded here so the next
reader knows it was a decision, not drift — `quick-view.png` is the rendered face,
`quick-view.mock.html` the source. It gates code subtask **8.8.8**.

**Mirror (rung 1) = the detail page.** "All the fields" means the **full
core-field set the detail rail (`detail.png`) carries**, rendered in the **same
order**, just condensed and read-only. The peek rail now is:

| #   | Field                 | Treatment in the peek (read-only)                                                                                                                          | New in 8.8.4? |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | **Status**            | `Pill` (lifecycle tone)                                                                                                                                    | —             |
| 2   | **Type**              | work-type value + leading `code`-family glyph (`--el-text-faint`) — the type/executor pair of `type-executor-picker.mock.html`                             | **yes**       |
| 3   | **Executor**          | `bot` / person glyph + `Coding agent` / `Human`                                                                                                            | **yes**       |
| 4   | **Priority**          | `PRIORITY_META` chip                                                                                                                                       | —             |
| 5   | **Assignee**          | Avatar + name                                                                                                                                              | —             |
| 6   | **Reporter**          | Avatar + name                                                                                                                                              | —             |
| 7   | **Parent**            | breadcrumb link (`corner-up-left` glyph + key + title)                                                                                                     | —             |
| 8   | **Labels**            | tinted chips (`--el-tint-lavender`), wrap                                                                                                                  | **yes**       |
| 9   | **Components**        | neutral chips (`Pill` neutral tone), wrap                                                                                                                  | **yes**       |
| 10  | **Due date**          | `formatDate`                                                                                                                                               | —             |
| 11  | **Sprint**            | `goal` glyph + sprint name (`sprint-field.mock.html`); muted **Backlog** when unset (status-dependent, per 2.4.15)                                         | **yes**       |
| 12  | **Story points**      | `gauge` glyph + the number                                                                                                                                 | **yes**       |
| 13  | **Estimate**          | `clock` glyph + duration                                                                                                                                   | —             |
| 14  | **Custom fields**     | the **valued** ones (per-type value lines, the `custom-fields.mock.html` grammar), then a read-only **Show more fields (N)** disclosure for the empty ones | **yes**       |
| 15  | **Created / Updated** | quiet `--el-text-muted` audit line at the foot of the rail                                                                                                 | **yes**       |

- **Why Story points is included even though the card's parenthetical didn't list
  it.** The ask is "show ALL the work-item fields," and the card's "(add type,
  executor, sprint, labels, components, custom fields, audit timestamps)" is
  illustrative, not exhaustive. Story points is a core scalar the detail rail
  carries, so omitting it would leave the peek NOT showing all fields. Included,
  mirroring detail (rung 1).
- **The kind is NOT a duplicate rail row.** The header already carries the
  **kind** via `IssueTypeIcon` (the same glyph every row/header uses), so the rail
  adds only the **work Type** (code/design/…) — a justified deviation from the
  detail rail (which lists kind as a row) to avoid duplicating what the peek header
  already shows.

**Read-only treatment (unchanged in spirit, reaffirmed).** Every field is
**display-only** — the rail keeps the condensed `<dl>`/`rail-field` grammar with
**no edit chevrons** (the detail rail's `FieldCard` chevrons are the EDIT
affordance and are deliberately absent here). The peek has **one write path: Open
full page →**. Built-in fields always render (muted **None** when empty, the
Parent-card convention); empty **custom** fields hide behind **Show more fields
(N)** exactly as the detail rail does (5.3.7) so the peek isn't a wall of "None".

**What stays detail-only (reached via Open full page → / the header identifier).**
The expansion is RAIL-only; the heavier sections are unchanged from 2.5: the
**Explanation**, the **child list**, the **full relationships / links panel** (the
Blocked-by / Blocks / Relates-to / Duplicates / Clones groups + link add/remove —
only the readiness **signal** is promoted, not the panel), **Attachments**, and
the **Activity / comments feed**. The peek's main column footer names them.

**Layout + scroll.** The two-column shell, header bar, readiness banner, and full
description are all unchanged. The rail simply grows longer; it keeps
`overflow-y: auto`, so it **scrolls independently** inside the `max-h-[82vh]`
modal — the modal does not get taller. The **loading skeleton** (panel 4) holds
the **expanded** rail's rows **at the new height**, so the modal doesn't resize
when the full field set lands (the AC's skeleton-first requirement). On **narrow
widths** the rail still collapses into the bottom-sheet meta strip, which now
carries the **same full field set** (it wraps; the sheet body scrolls).

**Access path (unchanged — shown, not just named).** The peek is still opened from
the **shared row-actions cell** (the `eye` icon button + stretched-link
resolution, panel 1) — already shipped in 2.5.19; 8.8.4 changes nothing about how
the peek is reached, only what it shows once open. Panel 1 keeps drawing it so the
asset stays self-contained.

**Composing primitives — still no new primitive (AC).** Every added field reuses a
shipped primitive: `Pill` (label/component chips, status, priority), Avatar
(assignee/reporter), the `FieldCard` value-line grammar for type/executor/sprint/
story-points/custom (condensed to `rail-field` rows), and the existing glyph
vocabulary. 8.8.8 invents nothing visual — it widens the data the peek already
reads (the detail aggregate read returns the full field set; the peek previously
rendered a subset of it).

**Colour + shape.** New tints route through `--el-*` (`--el-tint-lavender` for
label chips; chip text stays `--el-text-strong` for AA, finding #35); value glyphs
are `--el-text-faint`; the audit line is `--el-text-muted` / `--el-text-secondary`. (faint is correct here: value GLYPHS, as the line says; the audit text beside them is secondary)
Shape via tokens — chips `--radius-badge`, the Show-more button `--radius-control`,
the rail dividers a `--el-border-soft` hairline. No Tier-0 utilities, no raw
`rounded-*`.

### The rail becomes a WRITE surface — the read-only decision is OVERTURNED (MOTIR-2561 → MOTIR-2563 / 2564 / 2565 / 2566)

**This reverses a decision this file states twice.** 2.5.19 above says _"Inline
editing inside the peek (status / assignee change without opening the full page)
is **not** in 2.5.19 — the peek is read-only with one write path (navigate to the
detail page to edit)."_ 8.8.4 then reaffirmed it while widening the field set:
_"Every field is display-only — the rail keeps the condensed `<dl>`/`rail-field`
grammar with **no edit chevrons** … The peek has **one write path: Open full
page →**."_ Both sentences stand as the record of what was true; **neither is true
any more.** Recorded here as a decision so the next reader does not read the
change as drift — the same discipline 8.8.4 used on its own reversal of the
curated-subset call.

**Why it was overturned.** The read-only rule was proportionate when the peek
showed seven curated fields and read as a preview. 8.8.4 widened the rail to the
_complete_ core-field set, which made the peek a panel that shows everything about
a work item and can change none of it. **Rung 1 disagrees:** Jira's issue detail
view — the same surface, opened from a board or backlog — edits summary, assignee,
status, parent, priority and story points in place
(<https://confluence.atlassian.com/jirasoftware/configuring-the-issue-view-1688898481.html>).
The peek exists so a scanner does not lose their place; making them leave to change
a status is the cost the peek was built to remove.

**The rule the story ships, and it decides every field question:** _the peek edits
exactly what the detail page's rail edits, with the same controls and the same
Server Actions._ So Reporter and the Created / Updated audit line stay read-only
(the detail rail does not edit them either), and **Story points becomes editable on
BOTH surfaces** — it is `editable={false}` on the detail rail today, editable
nowhere inline, and the mirror edits it in this very view, so MOTIR-2565 fixes it in
both places rather than copying the gap.

Panels **7–12** of `quick-view.mock.html` carry it:

| Panel                            | What it settles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **7** — editable rail at rest    | The affordance: an always-rendered chevron `<button>` (`aria-label="Edit <field>"`) inline on the caption line, right-aligned, `--el-text-faint` → `--el-text-secondary` on hover/focus; the whole row is the hit target. Reveal-on-hover alone is unreachable on touch and invisible to a keyboard user. Order, density and content are unchanged from 8.8.4 — the panel is deliberately diffable against panel 2.                                                                                                                                                                                                                                                                                                                                                         |
| **8** — a row mid-edit           | The control is **full-bleed to the 300px column and its menu is an in-flow block below it, never an overlay** — because `Combobox` / `MultiSelectPicker` detect an enclosing `role="dialog"` and render the listbox INLINE instead of portaling to `<body>`. The consequence the code cards must honour: a menu near the bottom EXTENDS the rail's scroll height, so the opened control has to be scrolled into view.                                                                                                                                                                                                                                                                                                                                                       |
| **9** — write states             | Pending dims the value under a hairline bar — **no spinner and no disabled row**, because the picked value is already on screen (the optimistic commit) and the response only confirms it. Confirmed is a fading check; refused reverts the value and puts the typed reason under the row, not in a toast; stale is a rail-top notice naming the reload, because the whole payload is behind.                                                                                                                                                                                                                                                                                                                                                                               |
| **10** — multi-value + read-only | A collection row keeps its chip stack and gains a per-chip remove `×` plus a dashed **+ Add**; it stays in edit mode across several writes. The read-only actor is a DRAWN state: affordances **absent**, not disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **11** — the second surface      | Story points on the detail rail, taking the Estimate row's existing `FieldCard` chevron + numeric input verbatim. Clearing writes `null` — unestimated and zero are different values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **12** — behind the modal        | **The host list re-reads ONCE, on CLOSE, and only if an edit was confirmed.** Not per edit: refreshing the route on every successful inline edit is precisely what caused `bug-inline-status-revert-on-second-edit` (two edits raced, a stale RSC snapshot landed last and repainted an unrelated row). Not never: a list contradicting the change you just made is worse than one that lags. Close is the only moment that is both safe (the modal is going, so no optimistic cell can be repainted) and sufficient. **Both drivers do it** — `IssueQuickViewController.tsx` and `components/planning/WorkItemQuickView.tsx`; the canvas is a client island, so `router.refresh()` cannot reach it and its driver needs an explicit refetch (page-state contract, case 3). |

**Two token facts this pass established, both worth inheriting.**
`--el-danger-text` is `#ffffff` — it is ink FOR a danger fill, so a refusal message
coloured with it is invisible on the rail; and `--el-danger` **as text** measures
4.25:1 on the dark page, under AA at caption size. So the danger hue sits on the
**glyph** (graphics need 3:1) and the words stay on `--el-text`. Separately, the
mock was **using `--el-success` without declaring it** in its Tier-3 block, so the
confirmed check silently inherited the faint grey; `--el-success:
var(--color-success)` is now wired beside `--el-danger` / `--el-warning`.

#### ⚠️ Panel 11 CORRECTED (MOTIR-2591) — story points were never uneditable

The revision of panel 11 that shipped with this section drew a **chevron + numeric
input** for the Story-points row, and its note said the detail rail's row "stops
being `editable={false}`". Both were wrong, and the error is worth keeping
visible because the misreading is an easy one.

`editable` on `FieldCard` governs **that card's own chevron**, not the field. The
detail rail's Story-points row is `editable={false}` _because its contents are
already an editor_: `components/issues/EstimateBadge.tsx` is a click-to-edit chip
that opens the project's configured estimation scale deck and writes through
`PATCH /api/work-items/[id]/estimate`. It is composed by the backlog row, the
board card, the item list's Points column and the detail rail — by seven call
sites, and by no peek file.

So the finding inverts: **story points were editable everywhere except the quick
view**, and the gap was a missing COMPOSITION, not a missing capability. Panel 11
now draws the composed chip, and **the detail rail is unchanged by this story.**

Had the numeric input shipped it would have given one column a second writer
(`updateIssueAction` beside the estimate route), let a user type a value the
project's scale does not contain, and ignored the estimation statistic entirely.
Recorded as `MOTIR-2592` and `notes.html` #252.

**Access path — unchanged, and deliberately so.** The peek is reached exactly as it
is today (a row click on `/items` · `/ready`, a board card, a `motir:` chip, the
canvas View button); panel 1 still draws it. This amendment changes what the peek
can DO once open, not how it is reached.

**Panel 7 is drawn UNROLLED.** The real modal is `680px` / max `82vh` with the rail
scrolling independently — panel 2 shows that truthfully and clips at Due date. Panel
7 lets the dialog grow so every row of the editable rail is reviewable in one look;
the composition is otherwise identical.

## Comments + @mentions — the Activity section (Story 5.1 · 5.1.3 → 5.1.4 / 5.1.5)

`comments.mock.html` is the design for the issue detail page's **comments
surface** — the thread, the composer, the mention popup, and every comment
state. `detail.pen` draws ONLY the Activity placeholder ("Activity" /
"Comments coming in Epic 5"); everything inside it is a whole element no
design specified, so the design gate (`notes.html` mistake #31) requires this
asset before code Subtasks **5.1.4** (mention capability in `MarkdownEditor` /
`MarkdownView`) and **5.1.5** (the comments section UI). Mirror: the Jira
Cloud issue-view Activity section (threaded comments GA ~2025) — the
Jira-verified decisions (single-level threading, oldest-first default +
per-user toggle, "Edited" tag, hard delete, "Show more" collapse) are recorded
in the 5.1 story module and drawn here. A `comments.png` export accompanies
the HTML for the board view; the HTML is the source of truth.

### Placement

The comments stream replaces the placeholder INSIDE the existing Activity
`ContentSectionCard` — detail left column, after Relationships and Children,
exactly where `detail.pen` puts the placeholder card (panel 0). The section
header keeps the `ContentSectionCard` grammar (16px sans semibold title +
`--el-text-secondary` gloss) and carries:

- the **total count** in the gloss (`— 12 comments`);
- the **Comments / History filter seam** — a two-button segmented control;
  Comments active, **History drawn disabled** (`opacity: 0.6`,
  `cursor: not-allowed`, title "History — field-change activity lands with
  Story 5.5") — the 2.5.3 view-switcher seam treatment. Story 5.5's slot.
- the **sort toggle** — a small bordered control (`--height-control`,
  `--radius-btn`, `--spacing-control-x`) with `arrow-down-narrow-wide` /
  `arrow-up-narrow-wide` (14px, `--el-text-muted`) + the label
  **Oldest first / Newest first**. Per-user, oldest-first default (Jira's
  `asc` + "Reverse sort direction").

### Comment row anatomy (panel 1)

Row = 22px initial-letter **Avatar** (the shipped `issueCellPrimitives`
treatment, verbatim) · **author** (13px semibold `--el-text`) · **relative
time** (12px `--el-text-muted`; absolute timestamp on hover via `title`) ·
the **"· Edited" tag** (12px muted; only when `editedAt` is set — latest
version only, no history; its `title` carries the edit timestamp). The body
renders through **`MarkdownView`** prose (14px / 1.6) with inline mention
chips. Below, the **quiet action row**: 12px text buttons
(`--el-text-secondary` — MOTIR-4255; it was `--el-text-muted`, which the row's
own hover tint takes to 4.17:1, and the hover state is the only one these
buttons are ever read in), hover `--el-text` on `--el-surface`; Delete hovers `--el-danger` on
`--el-tint-rose` — the `RemoveLinkButton` trigger grammar), separated by faint
`·` dots.

- **Reply** appears on ROOT comments only (single-level threading). On a
  reply, Reply re-targets the same thread and pre-mentions that reply's
  author (the Jira auto-tag — panel 4).
- **Replies** indent once behind a soft thread rail (2px
  `--el-border-soft` left border, 14px padding). Long threads collapse their
  middle behind **"Show N more replies"** (quiet 12px text button).
- **Role-dependent actions** (panel 2) are drawn present/absent — never
  disabled-but-visible: author → Reply · Edit · Delete; another member →
  Reply only; project admin / workspace admin/owner → Reply · Edit · Delete
  on anyone's.

### Composer (panels 3–4)

The shipped **`MarkdownEditor`** (2.3.5) in a **compact comment mode**, led
by the viewer's own 22px avatar:

- **Rest** — a collapsed one-line "Add a comment…" invitation
  (`--height-control`, `--radius-input`, `--el-surface` bg, muted text);
  focusing expands it. Keeps long threads from being dominated by an empty
  editor (the Jira shape).
- **Expanded** — the editor chrome verbatim: `--radius-input` container on
  `--el-surface`, `--el-highlight` focus border, the icon toolbar (16px lucide
  glyphs in `--spacing-icon-btn` buttons), ~72px min-height area; a
  right-aligned primary **Comment** `Button` (size sm) below, disabled while
  empty. <kbd>Esc</kbd> with an empty body collapses back to rest.
- **Submitting** — editor dimmed + disabled, the Comment button busy with the
  `loader-circle` spinner.
- **Edit-in-place** — Edit swaps the row's rendered body for the editor
  pre-loaded with the Markdown source (mentions round-trip intact — 5.1.4),
  with ghost **Cancel** + primary **Save**.
- **Reply composer** — opens indented inside the thread rail with the
  replied-to author pre-mentioned as a chip; ghost **Cancel** + primary
  **Reply**. Both restore focus to the action that opened them.

### Mention popup + chip (panel 5)

Typing `@` anchors a member listbox **at the caret** — the shipped
**`Combobox`** menu + option-row vocabulary verbatim: `--radius-card`
container, `--el-border`, `--shadow-elevated`, 4px inner padding; rows =
22px Avatar · name (13px) · secondary email (11px muted, right-aligned),
`--radius-control` / `--spacing-control-x/y`, active row `--el-surface`;
filter-as-you-type, ↑/↓/Enter/Esc, `aria-activedescendant`. Candidates = the
members who can VIEW the issue (the 6.4 `assignableMembersService` scoping),
supplied via 5.1.4's `mentionCandidates` prop.

**The mention chip** (the one new treatment this design introduces — for
5.1.4 to build): inline in the rendered body, `--el-tint-lavender` background

- `--el-text-strong` text (hue in the tint bg, AA-safe — finding #35),
  `--radius-badge` shape with the small-chip `--spacing-kbd-x/y` padding (an
  existing swap-layer pair — **no new `--el-*` or shape token is needed**),
  0.92em / 500 weight. Serializes as `[@Display Name](mention:<userId>)`; a
  stale/unknown id degrades to plain text, never a broken link.

### Pagination + sort (panel 6)

The read is cursor-paged from the most recent (20/page — finding #57, never
load-all) with a total count. **"Show more comments (N older)"** — a
full-width quiet control (`--height-control`, dashed `--el-border-strong`
border, `--radius-control`, `--el-surface-soft`) — always sits at the OLDER
edge, so it flips top/bottom with the sort direction (top in oldest-first,
bottom in newest-first). Clicking extends the page backward and keeps scroll
position. Replies load whole with their thread (bounded by single-level
threading).

### States (panels 7–9)

- **Loading** — comment-row-shaped pulse skeletons (`--el-muted` bars +
  avatar circle, `aria-busy`) — the `BacklogSkeleton` grammar — so the
  section doesn't jump when data lands.
- **Empty** — centered `message-square` (22px muted) + **"No comments yet —
  start the conversation"**; the composer stays live below. Mirrors the
  placeholder's grammar but inviting, never blank.
- **Error** — the `ErrorState` grammar inside the card: danger
  `triangle-alert`, serif title **"Couldn't load comments"**, muted line,
  secondary **Retry**.
- **Delete confirm** — the `RemoveLinkButton` confirm-**Popover** pattern
  verbatim (300px, `--radius-card` + `--shadow-elevated`, ghost Cancel +
  danger **Delete**), anchored to the row's Delete action. A root with
  replies names its cascade: **"Delete this comment? Also deletes N replies —
  comments can't be restored."**; a single comment/reply: **"Delete this
  comment? Comments can't be restored."** (hard delete — the deliberate
  decision recorded in 5.1.2; the revision trail records that a comment was
  deleted and by whom, rendered by Story 5.5).
- **Viewer (read-only)** — thread visible, NO composer and no
  Reply/Edit/Delete; a quiet line where the composer would sit (`eye` 14px +
  **"Read-only access — you can view comments but can't add them."** on
  `--el-surface-soft`, `--radius-control`) — the 6.4 read-only grammar,
  phrasing mirroring the shipped `readOnlyBoardBanner`.

### Copy strings

"Add a comment…" · "Comment" · "Save" · "Cancel" · "Reply" · "Edit" ·
"Delete" · "· Edited" · "Show more comments (N older)" · "Show N more
replies" · "Oldest first" / "Newest first" · "No comments yet — start the
conversation" · "Couldn't load comments" / "Something went wrong fetching the
conversation." / "Retry" · "Delete this comment? Also deletes N replies —
comments can't be restored." / "Delete this comment? Comments can't be
restored." · "Read-only access — you can view comments but can't add them." ·
History seam title: "History — field-change activity lands with Story 5.5".

### Tokens / a11y

Colour only through `--el-*` (chips put hue in the tint background with
`--el-text-strong` text — finding #35; the danger affordances use
`--el-danger` / `--el-tint-rose`); shape through the element-semantic tokens
(`--radius-card/input/control/btn/badge`, `--spacing-card-padding`,
`--spacing-control-x/y`, `--spacing-icon-btn`, `--spacing-kbd-x/y`,
`--height-control`, `--height-btn-sm`, `--shadow-card/elevated`) — no Tier-0
utilities, no raw `rounded-*`. The composer is labelled; the toolbar is
`role="toolbar"`; the mention popup is a `role="listbox"` with
`aria-activedescendant` (the Combobox a11y bar); timestamps and the Edited
tag are conveyed as text (`title` for absolute time); the skeleton sets
`aria-busy`; the confirm is a dialog with an explicit accessible name; focus
returns to the opening action after post/edit/delete. Light + dark parity via
the same tokens.

### Out of scope (documented extension slots)

**Per-comment visibility restriction** (Jira's padlock) is a deliberate
non-feature: it needs the company-managed role/group substrate, and Jira's
team-managed projects — the small-team shape Motir mirrors — do not support
it; documented as an Epic-6 admin extension slot. **Realtime** live-updating
comments: no realtime substrate exists in the codebase; comments refresh on
navigation/action — a product-wide decision, not story-local. The **History
filter** is Story 5.5's slot (the disabled seam). **In-app notifications**
are Story 5.7; **watchers** are Story 5.4. Comment **reactions/emoji** and
edit **history** are not planned features of 5.1.

## Attachments panel + preview lightbox (Story 5.2 · 5.2.4 → 5.2.5 / 5.2.6)

`attachments.mock.html` is the design for the issue detail page's
**attachments surface** — the panel (strip + list views, upload, download,
permission-gated delete) and the preview lightbox. `detail.pen` draws NO
attachments section (the detail page reserves the Epic-5 slot in a code
comment only), so every element here is a whole element no design specified —
the design gate (`notes.html` mistake #31) requires this asset before code
Subtasks **5.2.5** (the panel) and **5.2.6** (the lightbox). Mirror: the Jira
Cloud issue-view attachments panel — the Jira-verified decisions (strip + list
views with a count, embeds-are-attachments with the editor-sourced delete
block, the three permissions, image/PDF-only preview, hard delete) are
recorded in the 5.2 story module and drawn here. Deviation, recorded with its
justification: the read is **cursor-paged (50/page) + "Show more (N)"** —
never Jira's load-all-then-degrade (finding #57). An `attachments.png` export
accompanies the HTML for the board view; the HTML is the source of truth.

### Placement

A left-column **`ContentSectionCard`** — content-width and multi-row, so the
rail is wrong for it (the rail is for scalars; the same argument that placed
Relationships, 2.4.5). It mounts in the detail page's reserved Epic-5 slot:
after Children, before Activity (5.1). The section header keeps the
`ContentSectionCard` grammar (16px sans semibold + `--el-text-secondary`
gloss) and carries:

- the **total count** in the gloss (`— 44`);
- the **strip/list view toggle** — the shipped `Segmented` vocabulary (the
  2.5.3 view-switcher grammar): icon + label `Strip` / `List`; the chosen
  view persists per user (the 5.1.5 sort-preference pattern);
- the **Attach button** — secondary `Button` (size sm) with the `paperclip`
  glyph; opens a multi-select file picker. Always present for creating roles;
  OMITTED for the viewer.

### Strip view (panels 0–1)

Tiles on a `repeat(auto-fill, minmax(148px, 1fr))` grid: an 88px thumbnail
(the image itself, cover-fit, or the MIME-family glyph on
`--el-surface-soft`) over filename (truncating, full on `title`) + relative
date (absolute on `title`; size joins it on the anatomy panels). **The card's
open target is its own button; the per-card actions are sibling icon
buttons — never nested interactives.** Download + delete reveal on
hover/focus-within. Activating a previewable card (image / PDF) opens the
lightbox; any other type downloads (the DTO `isImage`/`isPdf` split).

**File-type glyph map (5.2.5 builds this from `lib/blob/allowlist.ts`):**
glyph on an `--el-surface-soft` tile, stroke taking the conventional family
hue through EXISTING semantic tokens — no new token:

| MIME family                                               | lucide glyph       | stroke                |
| --------------------------------------------------------- | ------------------ | --------------------- |
| `application/pdf`                                         | `file-text`        | `--el-danger`         |
| docs/text (`msword`, docx, `text/plain`, `text/markdown`) | `file-text`        | `--el-info`           |
| spreadsheets (`text/csv`, `ms-excel`, xlsx)               | `file-spreadsheet` | `--el-success`        |
| `application/zip`                                         | `file-archive`     | `--el-warning`        |
| image without a thumbnail                                 | `image`            | `--el-text-secondary` |

**Editor-sourced cards** (the embeds-ARE-attachments rule) carry the lavender
**source chip** (`--el-tint-lavender` bg + `--el-text-strong` text — the 5.1
mention-chip treatment, AA-safe per finding #35; `--radius-badge`,
`--spacing-kbd-x/y`) naming the source (`Description` / `Comment`), and their
delete control is **disabled with the points-at-source tooltip** ("Added in
the description — remove it there to delete it"). This is the Jira block that
prevents the broken-embed hole. By contrast, a card whose delete the caller
simply lacks (not the uploader, not an admin) **omits** the control entirely —
absent, never disabled (the role grammar 5.1 set).

### List view (panel 2)

The toggle flips the same data into rows: family glyph · name (the row's own
open button) · source chip when editor-sourced · size (right-aligned tabular)
· date · uploader · the hover actions. Row activation previews or downloads —
the same split as the cards.

### Upload (panel 3)

- The **Attach button** is the always-present, labelled affordance; the
  **whole-panel dropzone** is the drag enhancement over it (drag-only upload
  would be a keyboard hole).
- **Drag-over** draws an inset overlay: 2px dashed `--el-accent` border +
  `--el-tint-lavender` wash, `upload` glyph, "Drop files to attach" / "Up to
  10 MB each".
- **Uploading** queues per file: an `--el-surface-soft` row with the family
  glyph, name, percent (or "Uploading…" + an indeterminate bar when the
  request doesn't report progress), the `--el-accent` progress bar, and a
  cancel ×.
- **Errors isolate per file** as rose-tint AA banners (`--el-tint-rose` bg +
  `--el-text-strong` text + `--el-danger` glyph — the 2.4.9 error grammar),
  with the EXACT localized copy `lib/blob/uploadClient.ts` already maps
  (`errors.upload.FILE_TOO_LARGE` / `UNSUPPORTED_FILE_TYPE` / `RATE_LIMITED`)
  — reuse, don't fork. Dismiss ×. Successes become cards in place.

### Pagination + states (panel 4)

The read is cursor-paged (take 50, newest first) with a `totalCount`
(finding #57 — no unbounded read). **"Show more (N)"** — the full-width quiet
control (dashed `--el-border-strong`, `--radius-control`,
`--el-surface-soft`, `--height-control`; the comments pager grammar) — sits
at the strip/list end, extends in place keeping scroll position, and
disappears when everything is loaded. **Loading** = tile-shaped pulse
skeletons (`--el-muted`, `aria-busy`) so the card doesn't jump. **Empty** =
centered `paperclip` + "No attachments yet — attach a file or drop one here";
the Attach affordance stays live (never blank). **Error** = the `ErrorState`
grammar: danger `triangle-alert`, serif "Couldn't load attachments", muted
"Something went wrong fetching the files.", secondary **Retry**.

### Delete confirm (panel 5)

The `RemoveLinkButton` confirm-**Popover** pattern verbatim (300px,
`--radius-card` + `--shadow-elevated`, ghost Cancel + danger **Delete**),
anchored to the delete control: **"Delete &lt;filename&gt;? Attachments can't
be restored."** — the hard-delete truth (row + blob + a History
attachment-removed entry; no trash). Focus returns to the panel after.

### Preview lightbox (panel 6 — for 5.2.6)

A **full-screen `Modal`** over ONE focused attachment. Growth notes for
5.2.6 (the 2.5.19 size-token precedent): add the `full` size variant, and
deepen the overlay to `bg-black/80` for the lightbox (the default
`Dialog.Overlay` is `bg-black/40`). Header bar (white-on-scrim): filename +
size · a **Download** button · the close ×. **Images** render contain-fit,
centered on the scrim. **PDFs** render in an embedded `<object>`/`<iframe>`
frame over the blob URL, with the can't-inline fallback ("Preview isn't
available here — download the file instead." + Download). Non-previewable
types NEVER open it — the card downloads instead. **NO prev/next
navigation** — unverified in the mirror itself, documented out ("no
complexity for nothing"). Full Modal a11y contract: focus trap, Esc closes,
focus returns to the opening card, dialog labelled by the filename, the
image carries the filename as alt.

**⚠️ The chrome's ink is literal WHITE, deliberately.** The scrim is
`bg-black/80` in the LIGHT theme and in the DARK one — it is theme-INVARIANT —
so an `--el-*` ink token would wrongly flip with the theme and turn the header
near-black on a black scrim in dark. `AttachmentPreview.tsx` states the same
decision for the shipped component, and this asset is where it was decided; the
white is not an un-swept raw hue. The scrim ITSELF is a BACKDROP that carries no
meaning, which is the one grant `CLAUDE.md`'s never-invent-a-colour rule makes
for a raw value. **Both of those paragraphs are unchanged and are still the
spec.**

**⚠️ AMENDED 2026-09-04 (MOTIR-4400) — the mock declares the scrim as
`rgba(0, 0, 0, 0.8)` again, and the sentence that justified pre-compositing it
is retired.** MOTIR-4277 had the mock declare the OPAQUE colour `bg-black/80`
composites to over this board's own page (`0.8 × #000` over `--el-surface`
`#f6f5f4` = `#313131`), because `tests/theme/mockStateInkScan.ts` grounded an
element on its nearest OPAQUE painted ancestor: a translucent scrim was skipped
and the header's white was measured against the near-white page BEHIND the
lightbox — **1.07:1**, counted as failing ink, where it actually sits at
**6.90:1** under the `.lb-btn:hover` tint.

**That is no longer true.** [MOTIR-4317] (merged `37b791035`, 2026-09-03) fixed
exactly that limitation — `restingBackground` folds every translucent layer
between an element and the first opaque ground back over it with `composite`
instead of walking past it — and neither this paragraph nor the mock's own
comment was swept. Measured with the shipped scanner under all three spellings
of the same scrim (`#313131`, `rgba(0, 0, 0, 0.8)`, `#000000cc`), the verdict is
IDENTICAL: **9 state background rules, 0 findings, 0 abstentions.** The
pre-composite bought nothing the scanner can see.

Two things were wrong with it, and only the second is cosmetic. **The mock no
longer drew the scrim it SPECIFIES** — `#313131` equals `bg-black/80` over the
page only while `--el-surface` is `#f6f5f4`, and the page is a TOKEN
(`body { background: var(--el-surface) }`), so a palette swap or any re-pointing
of this area's Tier-0 values moves the page and leaves the scrim behind, showing
a grey slab where the spec says 80% black over the page. And **the stated reason
would have been followed again**: a reader meeting that comment learns that the
state-ink scanner cannot see through a translucent ancestor, and pre-composites
the next scrim, the next frosted panel and the next glass `data-surface` the same
way — spreading a workaround for a fixed defect into the material axis
`CLAUDE.md` documents as translucent by design. The `.png` is re-exported and the
pixels are unchanged while `--el-surface` is `#f6f5f4`, which is the point: what
moved is the DECLARATION, not the render.

### Viewer / read-only (panel 7)

A project `viewer` sees the panel and can preview + download; every mutating
affordance is **omitted** — no Attach, no dropzone reaction, no delete
(absent, never disabled — the 5.1 viewer grammar). Count + view toggle
remain.

### Copy strings

"Attachments" · "Attach" · "Strip" / "List" · "Show more (N)" · "Drop files
to attach" / "Up to 10 MB each" · "Uploading…" · "Cancel" ·
upload errors (from `errors.upload.*`): "File is too large — please choose a
smaller file." / "That file type isn't supported." / "Too many uploads —
please wait a moment and try again." · source chip "Description" / "Comment"

- tooltip "Added in the description — remove it there to delete it" (/ "Added
  in a comment — remove it there to delete it") · "Delete &lt;filename&gt;?
  Attachments can't be restored." / "Delete" / "Cancel" · "No attachments yet —
  attach a file or drop one here" · "Couldn't load attachments" / "Something
  went wrong fetching the files." / "Retry" · lightbox "Download" / "Preview
  isn't available here — download the file instead."

### Tokens / a11y

Colour only through `--el-*` (chips put hue in the tint background with
`--el-text-strong` text — finding #35; the glyph map adds palette colour per
finding #54 via the existing `--el-danger/info/success/warning` — **no new
`--el-*` token**); shape through the element-semantic tokens
(`--radius-card/control/btn/badge`, `--spacing-card-padding`,
`--spacing-control-x/y`, `--spacing-icon-btn`, `--spacing-kbd-x/y`,
`--spacing-chip-x/y`, `--height-control`, `--height-btn-sm`,
`--shadow-card/elevated`) — no Tier-0 utilities, no raw `rounded-*`. The
open/preview target of every card/row is its own `<button>`; action icon
buttons are siblings (no nested interactives) and are individually labelled
("Download &lt;name&gt;" / "Delete &lt;name&gt;"); the disabled editor-sourced
delete uses `aria-disabled` + the tooltip; progress bars are
`role="progressbar"` (valuenow, or `aria-busy` when indeterminate); the error
group is `role="alert"`; the skeleton sets `aria-busy`; source and permission
state are conveyed as text (chip label, tooltip), not colour alone. Light +
dark parity via the same tokens.

### Out of scope (documented extension slots)

**Authed/private attachment serving** — the shipped storage layer is Vercel
Blob `access: 'public'` + `addRandomSuffix` (public-but-unguessable, the JSM
"unguessable links" shape); the authed download proxy / private storage is
the named Epic-8 hardening extension. **In-preview prev/next** — unverified
in the mirror, not planned. **"Download all" (ZIP)** — needs a server zipper;
no use case at team scale yet. **Jira's grid view** — strip + list is the
documented primary pair. **A dedicated attach field in the create modal** —
files already attach at create via the editor path + link-on-write (5.2.3).
**Per-project storage quotas / admin-configurable size limits** — Epic 6/8
admin. **Jump-to-exact-comment** from a comment-sourced card — additive;
the block only needs `source`. Custom-field file types are Story 5.3.
**Row-less blob sweep** — the 5.2.7 orphan-GC reaches only blobs that still
have an `attachment` row (it sweeps unlinked rows past the 7-day window,
blob-then-row); a blob whose row is gone entirely (e.g. a workspace-cascade
delete) is invisible to it. A prefix-listing sweep against the blob store
itself is the named Epic-8 hardening extension (also recorded in the
`attachmentGc` job header).

## Custom fields on the detail rail (Story 5.3 · 5.3.5 → 5.3.7)

`custom-fields.mock.html` is the design for **custom-field values on the
issue detail rail** — the per-type cards, the per-type inline editors, and
the "Show more fields" disclosure. `detail.pen` predates custom fields
entirely, so all three were whole undesigned elements (the design-gate
NONE-exists case, `notes.html` mistake #31); this asset gates code Subtask
**5.3.7**, which carries 5.3.5 in `dependsOn`. Mirror: the Jira issue-view
**Details** panel — fields with values show; empty ones hide behind **"Show
more fields"** (the verified hide-when-empty rule), without the work-type
layout-config admin (the documented 6.5 extension). A `custom-fields.png`
export accompanies the HTML for the board view; the HTML is the source of
truth.

### Placement (panel 0)

Custom-field cards are a contiguous block in definition `position` order,
immediately **after the Estimate card** (the last built-in `FieldCard`) and
**before the created/updated audit list**. The **"Show more fields (N)"**
disclosure sits after the valued custom cards, immediately before
created/updated. Built-ins never reorder. With **no definitions, nothing
renders** — no disclosure, no section gap; the rail is byte-identical to
today (5.3.7's null-case guarantee).

### Card + per-type rendering (panel 1)

Every custom card is **`CoreFieldsPanel`'s `FieldCard` verbatim** — Card
chrome (`--radius-card`, `--shadow-card`, `--el-border`) with px-3.5/py-2.5,
uppercase 11px `--el-text-secondary` field label, corner chevron `<button>`
(`aria-label="Edit/Close <label>"`, rotates 180° in edit mode), value line
mt-1.5 / 14px. **No new card chrome.** Value lines per type:

- **text** — plain, truncating (full value via `title`);
- **number** — the formatted decimal, plain;
- **date** — the Due-date card grammar verbatim: 16px muted `calendar`
  glyph + `formatDate` ("Jun 12, 2026");
- **select** — the option label, plain; an **archived** option keeps
  rendering as `label (archived)` — muted italic mark, never colour alone;
- **user** — the assignee grammar verbatim: 24px initial Avatar + name;
- **empty** — the rail's muted-italic **None** (the Parent card's exact
  convention).

The per-type TILE glyphs + tints (the 5.3.4-shared map: `type`/sky ·
`hash`/peach · `calendar`/mint · `square-chevron-down`/lavender ·
`circle-user`/rose, glyph in `--el-text-strong` on the tint — findings
#54/#35) belong to the **Fields ADMIN page**; the rail keeps value lines
clean — Jira renders custom values plain, and the rail's built-ins reserve
glyphs for values that benefit (calendar, Avatar).

### Per-type editors (panel 2)

The chevron toggles the value line into the editor — the FieldCard pattern;
each editor is a **shipped picker**, nothing hand-rolled:

- **text / number** — `Input` chrome (`--height-input`,
  `--radius-input`, `--el-border-strong`), autofocus; commit on blur or
  chevron collapse (the Estimate card's exact grammar). Clearing = emptying
  the input.
- **date** — the shipped `DatePicker` (`autoOpen`), trailing × Clear; the
  calendar popover's authority stays `datepicker.mock.html`.
- **select** — the shipped `Combobox` (`autoOpen`); first row **None**
  (muted italic — the clear path, the AssigneePicker NONE grammar); option
  rows with `Check` on the selected one; **archived options are excluded
  from the menu**, but a current archived value stays selected in the
  trigger with the `(archived)` mark. `searchable` switches on at **≥8
  options** (a 3-option set opens straight to the list; long sets get the
  filter — the ParentPicker precedent).
- **user** — the AssigneePicker-shaped member `Combobox`: searchable
  ("Search members…"), **None** first row (Unset), member rows = name +
  right-aligned email secondary (12px muted).
- **Inline 422** — the editor STAYS OPEN: error border (`--el-danger`) on
  the control + a rose-tint message box below (`--el-tint-rose` bg,
  `--el-text-strong` text, 12px, `--radius-control`,
  `--spacing-tooltip-x/y`, `role="alert"`) — the 2.4.9 inline-confirm
  family; hue in the background with strong text (finding #35). Drawn:
  number parse error, archived-option re-save, non-viewable user.
- **Pending** — the in-flight write disables the open editor (opacity 50% —
  the rail's `isPending` convention).

### "Show more fields" disclosure (panel 3)

A quiet full-width text `<button>` (13px `--el-text-secondary`,
`--spacing-control-x/y` padding, `--radius-control`, hover `--el-surface`):
**"Show more fields (N)"** with a leading chevron that rotates 180° when
open, label flipping to **"Show fewer fields"**, `aria-expanded`. Expanding
reveals the empty cards (muted-italic _None_, editable in place); a field
that gains a value moves **above** the line on refresh, a cleared one moves
back below. The row exists for **every role** — it is how all fields are
viewed; only the editors are role-gated.

### Viewer read-only + loading (panel 4)

A read-only actor sees values with **no chevron** (`FieldCard
editable={false}` — the rail's existing read-only grammar); the disclosure
row stays. The loading skeleton extends naturally: ghost label + ghost value
bars inside card chrome, one per custom field, same as the built-ins.

### Copy strings

"Show more fields (N)" / "Show fewer fields" · "None" (empty placeholder +
the select/user clear row) · "(archived)" · "Search members…" · "Select a
member…" · "Enter a number — e.g. 12.5." · "That option is archived — pick a
current one. Saving again with "<option>" is rejected (422)." · "That person
can't view this project, so they can't hold this field." · chevron
`aria-label`: "Edit <label>" / "Close <label>".

### Tokens / a11y

Colour only through `--el-*` (the 422 box puts hue in the tint background
with `--el-text-strong` text — finding #35; the archived mark is text, never
colour alone); shape through the element-semantic tokens
(`--radius-card/input/control/badge`, `--spacing-control-x/y`,
`--spacing-input-x`, `--spacing-tooltip-x/y`, `--height-input`,
`--height-control`, `--shadow-card/elevated`) — no Tier-0 utilities, no raw
`rounded-*`. **No new `--el-*` or shape token is needed.** The disclosure is
a real `aria-expanded` button; every editor is labelled by its field label;
errors are `role="alert"`; the DatePicker trigger is a CONTAINER with the
Clear × as a sibling button (never a button inside a button — the
datepicker.mock rule); Combobox menus keep the `role="listbox"` /
`aria-activedescendant` bar. Light + dark parity via the same tokens.

### Out of scope (documented extension slots)

Custom fields on the **create/edit forms** (work-type layouts, required
flags, form placement — the 6.5 layout-config extension; values are
editable the moment an issue exists, via this rail); custom-field columns
on **board/list/tree** (Epic-6 saved-views territory); the **filter UI**
over values (Story 6.1, consuming 5.3.1's predicate contract); the
remaining mirror types (paragraph / checkbox-multi / labels / multi-person
/ formula — additive on the same EAV substrate). Value-change **History**
rendering is Story 5.5 (the `customFields.<key>` revision diffs land with
5.3.3).

## Labels · Components · Watchers — the issue-view additions (Story 5.4 · 5.4.6 → 5.4.8 / 5.4.9)

`labels-components-watch.mock.html` is the design for every issue-view surface
Story 5.4 adds: the **Labels** and **Components** rail field cards (and the
generic multi-select chip picker they embed), and the **watch control + watchers
popover** in the detail header. `detail.pen` predates all three features (its
source contains no label / component / watcher element — verified), and the
codebase has no multi-select input primitive (`Combobox` is single-select; the
only multi-select vocabulary is the filter bar's `OptionRow` rows), so the
design gate (`notes.html` mistake #31) requires this asset before code Subtasks
**5.4.8** (MultiSelectPicker + rail cards) and **5.4.9** (watch control +
popover). Mirrors (verified in the 5.4 story module): the Jira issue-view
Labels / Components fields and the eye-icon watch control. A
`labels-components-watch.png` export accompanies the HTML for the board view;
the HTML is the source of truth.

### Placement (panel 0)

- **Watch control** — the detail header's `ml-auto` cluster
  (`issues/[key]/page.tsx`), placed BEFORE the Edit button (beside the roll-up
  badge). The eye + count is a peer of Edit, not a field: watching is
  social/header state, the Jira placement.
- **Labels and Components field cards** — the metadata rail, **between Parent
  and Due date**: they group with the relational fields ahead of the
  date/estimate block (the Jira details-panel grouping). Labels first, then
  Components (the 5.4 story's consistent ordering). Both reuse the
  `CoreFieldsPanel` **FieldCard grammar verbatim** — 11px uppercase
  `--el-text-secondary` label, corner chevron (`aria-expanded`, rotates open)
  toggling display ↔ edit, 14px value block at 6px top margin. Display mode
  renders chips only; empty shows the muted-italic placeholder (`No labels` /
  `No components`) per the FieldCard `muted()` convention.

### MultiSelectPicker — the ONE new primitive (panel 1; built by 5.4.8 as `components/ui/MultiSelectPicker`)

Designed ONCE, generically — labels, components, and future Epic-6 facet
editors all compose it. **Generic API surface:** options in, selection out —
NO fetching inside; `onCreate?` (adds the create-row, the folksonomy
affordance); `cap?` (per-value limit, disables input at the cap); `tint?`
per value (a chip + option-swatch colour — Labels passes the name-hash tint
below, Components passes none); pure + typed-generic, component-tested
standalone.

- **The box** — input-shaped: `--radius-input`, min-height `--height-input`,
  `--spacing-control-y/x` padding, `--el-border` on `--el-page-bg`,
  focus-WITHIN ring (`--focus-ring-color`, 2px, offset 1). Disabled (cap):
  `--el-surface-soft` fill, `not-allowed` cursor; chips stay removable.
- **Chips** — `--radius-badge`, `--spacing-chip-y/x` padding, 12px medium.
  Two treatments via the `tint?` prop: **neutral** (the default —
  `--el-surface` bg · `--el-border` border · `--el-text-secondary` text, the
  `Pill` neutral tone; what Components uses) and **tinted** (what Labels
  passes — the value's `--el-tint-*` background + `--el-text-strong` text,
  transparent border; hue-in-background AA per finding #35). Trailing
  **remove ×** (12px lucide `x`; neutral: `--el-text-muted` → `--el-text` +
  `--el-muted` bg on hover; tinted: `--el-text-strong` at 65% → 100% + a
  subtle ink overlay; accessible name `Remove <value>`).
- **The listbox** — the `Combobox` menu panel grammar: `--radius-card`,
  `--shadow-elevated`, `--el-border`, 4px padding, max-width 288px;
  `role="listbox"` + **`aria-multiselectable="true"`**; rows are the
  **`OptionRow` vocabulary reused 1:1** (`IssueFilterBar`): `role="option"` +
  `aria-selected`, `--radius-control` / `--spacing-control-y/x`, 22px glyph
  slot (14px icon, `--el-text-muted`), truncating label, **trailing 16px
  `Check` in `--el-accent`** (opacity 0 ↔ 1). Active row = `--el-surface`.
  Toggling does NOT close the menu (multi-select); Esc / outside click closes.
- **Keyboard (complete):** type filters · ↑↓ moves the active row · Enter
  toggles it · **Backspace on an empty input removes the last chip** · Esc
  closes and returns focus. `aria-activedescendant` tracking per the shipped
  `Combobox` a11y bar.

### Labels rail card (panel 2; 5.4.8)

The picker with `onCreate` wired to the 5.4.2 folksonomy:

- **Label colours — the recorded justified deviation (product owner,
  2026-06-10).** Unlike Jira's colourless labels, Motir label chips are
  COLOURED — deliberately less enterprise, more personality. The colour is
  **auto-assigned deterministically from the label name**: FNV-1a over
  `nameLower`, mod 6, into the existing pastel family
  `--el-tint-{peach,rose,mint,lavender,sky,yellow}` with `--el-text-strong`
  text (finding #35: hue in the tint background, AA-strong text on top —
  both themes hold via the dark tint variants). NO schema column, NO colour
  picker, NO admin surface — the folksonomy stays type-to-create, and the
  same label renders the same colour everywhere it appears (rail card,
  picker chips, option-row swatches, future board/filter chips). The mock's
  assignments (api=sky, perf-q3=peach, design-debt=lavender, infra=mint,
  flaky=yellow, onboarding=rose) are illustrative; the hash is the contract.
  **User-PICKED colours are the documented extension** (would add a `color`
  column + picker affordance later without breaking the auto default).
- **Create-row** — when the typed text matches no existing label the listbox
  shows `Create 'perf-q3'` with a plus glyph in `--el-accent`; the new label
  takes its hash tint immediately. Options otherwise come from the bounded
  `searchLabels` autocomplete (debounced, take 20) — each row's glyph slot
  carries the label's 10px tint **swatch dot** (the filter-bar swatch
  vocabulary) instead of an icon. Case-insensitive match surfaces
  the EXISTING label's original casing (no create-row offered).
- **No-spaces error** — the typed 422 renders the inline error grammar
  (12px `--el-danger` + 14px `triangle-alert`, `role="alert"`):
  `Labels can't contain spaces — use a hyphen: perf-q3`. The rejected text
  stays in the input for correction.
- **Cap (20)** — input disabled + the quiet hint
  `Label limit reached (20) — remove one to add another.`
- **Read-only (viewer)** — chips only, NO chevron: affordances absent, not
  disabled (the 6.4 grammar).

### Components rail card (panel 3; 5.4.8)

The SAME picker, `onCreate` absent — an admin-managed taxonomy never grows
from the issue field (mirror: company-managed Jira). Options =
`listComponents(projectId)`, name-ordered; rows and chips carry the lucide
`component` glyph (`--el-text-muted`; 22px row slot / 12px in-chip). Empty
project: `No components defined` in the listbox + the quiet `--el-link` line
`Manage components in Project settings →` — **project admins only** (members
see just the empty text). Read-only matches Labels.

### Watch control (panel 4; 5.4.9)

The small-header-control grammar (`--height-control` · `--radius-btn` ·
`--spacing-control-x` — the comments-mock sort-btn vocabulary):

- **Not watching** — outline lucide `eye` (16px, `--el-text-muted`) + count
  (`--el-text-secondary`, tabular-nums), `--el-border`, `aria-pressed="false"`,
  accessible name `Watch — N watching`.
- **Watching** — the eye **fills with `--el-accent`** (pupil knocked out in
  `--el-page-bg`), accent border, semibold accent count,
  `aria-pressed="true"`, name `Stop watching — N watching`. State is carried
  by the accessible name + fill, never colour alone.
- Hover `--el-surface`; focus-visible ring. Click or **`W`** toggles
  self-watch (ignored while typing in inputs/editors — the standard guard);
  the tooltip (ink surface, `--spacing-tooltip-y/x`) names the action + the
  `W` kbd chip. A `viewer` gets the control too — watching is not editing
  (the verified permission split).

### Watchers popover (panel 5; 5.4.9)

Anchored to the watch control; the menu panel container (`--radius-card` ·
`--shadow-elevated` · 4px padding · 288px), a labelled dialog (`Watchers`);
Esc closes, focus returns to the eye.

- **Header** — `Watchers · N` in the mono 11px uppercase faint label.
- **Rows** — 22px initial-letter avatar · truncating 14px name · your own row
  marked with the neutral `You` pill. Hover `--el-surface`.
- **Admin-only manage** (project admin + workspace admin/owner): the
  `Add a watcher…` search row on top (the member-picker vocabulary — typing
  filters workspace members into option rows) and a per-row **remove ×**
  (`--spacing-icon-btn`, name `Remove <name> from watchers`). Non-admins and
  viewers get the list only.
- **No-view-access error** — adding a user who can't view the issue surfaces
  the typed 422 INLINE under the candidate row (`role="alert"`,
  `--el-danger`): `<Name> can't view this issue, so they can't watch it.` —
  never a silent drop (the Jira trap, fixed).
- **Paging** — the quiet `Show more (N more)` row (13px
  `--el-text-secondary`).

### States (panel 6)

Skeleton chips ride the pulse grammar at chip size (`--radius-badge`,
`--el-muted`); the card chrome renders immediately. The watch toggle is
optimistic — state + count flip on click, reconciled on `router.refresh()`,
rolled back with the toast grammar on failure; tabular-nums keep the header
cluster from shifting.

### Tokens / a11y

- Colour only via Tier-3 `--el-*`; shape via the element-semantic tokens
  (`--radius-input/card/control/btn/badge/kbd`, `--spacing-control/chip/kbd/
tooltip/icon-btn-*`, `--height-input/control`, `--shadow-elevated/card`).
  **No new token needed** — the design composes existing roles only.
- **No new primitive beyond MultiSelectPicker** (the gate's ONE earn);
  everything else reuses FieldCard, OptionRow, the Combobox menu panel, the
  22px avatar, Pill neutral, the kbd chip, the inline-error grammar, the
  pulse skeleton.
- Label chips are **coloured** — the recorded justified deviation from Jira's
  colourless labels (less enterprise, more personality; product owner,
  2026-06-10). Tints auto-assigned by name hash from the EXISTING
  `--el-tint-*` family — still no new token; components chips stay neutral
  so the two facets read differently.
- AA holds in both themes: neutral chip text `--el-text-secondary` on
  `--el-surface`; tinted chip text `--el-text-strong` on the pastel tints
  (the finding-#35 grammar, dark tint variants included); `--el-danger`
  error text at 12px on `--el-page-bg`; accent count/border on page bg.
  Dark parity via the token flip (toggle in the mock).

### Out of scope (documented extension slots)

- User-PICKED label colours (the auto name-hash tint ships now; a `color`
  column + picker is the additive extension); label rename/merge admin
  (Jira's own gap — Epic-6 admin territory).
- The Components ADMIN page (Project settings → Components) — its own design
  subtask **5.4.7** (`design/projects/components.mock.html`).
- Per-user autowatch preference + the in-app bell — Story 5.7's seam.
- Voting (Jira's sibling feature — no use case for a small-team tool).

## Activity History + the All stream (Story 5.5 · 5.5.3 → 5.5.4)

`activity-history.mock.html` is the design for the issue detail page's
**History feed** and the **All merged stream** — the completion of the
Activity section. `comments.mock.html` (5.1.3) designs the SECTION — the
`ContentSectionCard`, the segmented filter (History drawn as a disabled
seam), the comment grammar, the sort toggle; every history ROW form and the
All interleave are whole elements that asset does not depict, so the design
gate (`notes.html` mistake #31) requires this asset before code Subtask
**5.5.4** (History + All tabs UI). Mirror: the Jira Cloud issue-view
changelog, verified at plan time in the 5.5 story module — entry anatomy =
actor + "changed the <Field>" + old → new + timestamp, empty sides "None"
(the changelog null); comment DELETIONS in History (who/when, never the
content), comment ADDS under Comments/All only; ONE per-user sort toggle
spanning every tab (JRACLOUD-73076); append-only — read-only for every role,
no mutation affordance exists. An `activity-history.png` export accompanies
the HTML for the board view; the HTML is the source of truth.

### Placement + the tab row

Same card, same slot as 5.1.3 (detail left column). The 5.1.3 segmented
filter goes LIVE with three tabs — **All / Comments / History** (Jira's set
minus Work log: no worklog feature), **default Comments** (the Jira
default). Tab choice is URL-driven (`?activity=all|comments|history` — the
2.5.8 `?view=` house pattern). The header gloss counts the ACTIVE tab's
entries: "— 12 comments" / "— 34 changes" / "— 12 comments · 34 changes" on
All. The sort control is the 5.1.3 `sort-btn` unchanged, but it now governs
ALL tabs together (the verified cross-tab rule), persisted per user exactly
as 5.1.5 stores it.

### History row grammar (the new element)

Comment-row-aligned but visually QUIETER — the feed-vs-conversation
distinction:

- Same grid (22px first column — the two row kinds stay left-aligned in
  All) but an **18px** initial-letter `Avatar` (vs the comment row's 22px).
- The **sentence line**: 13px `--el-text-secondary` prose with the actor
  (13px semibold `--el-text`) and the field name (medium `--el-text`)
  lifted out; relative time 12px `--el-text-muted`, absolute on hover via
  `title` (the comment-row convention).
- The **value line** below: old value struck-through `--el-text-muted`
  (strike colour `--el-border-strong`), arrow `→` in `--el-text-faint`, new
  value medium-weight `--el-text`. An empty side renders italic faint
  **"None"** (the changelog null). State is carried by strike + weight, not
  colour alone (WCAG 1.4.1).
- **No action affordance on any row, for any role** — History is
  append-only (the verified rule); there is no read-only variant because
  the whole surface is read-only.

Per-change-type value forms (all drawn in panels 1–2):

- **Scalar** (title, kind, priority, estimate, story points, …): plain
  old → new.
- **Status**: the two workflow LABELS as `Pill`s (tint bg +
  `--el-text-strong`, finding #35 — todo lavender / in-progress sky / done
  mint / blocked peach) with the arrow between.
- **User fields** (assignee, reporter): 18px avatar + name pairs.
- **Dates**: the rail's `formatDate` form ("12 Jun 2026").
- **Description / Explanation**: the verb sentence ONLY ("updated the
  Description") — the body is never inlined.
- **Sprint**: "moved this issue to Sprint 4 / the Backlog" — names
  resolved, never ids; rendered with the old → new value line.
- **Links**: identifier mono in `--el-link` + the link kind italic
  ("linked `PROD-12` as _blocks_" / "removed the _relates to_ link to
  `PROD-48`") — the links.mock vocabulary.
- **Labels / components**: the 5.4 chip forms verbatim under an
  added/removed sentence (labels keep their name-hash tint; components
  neutral + glyph).
- **Attachments**: filename mono ("attached `drag-repro.mp4`" / "removed
  the attachment `old-screenshot.png`").
- **Custom fields**: the DEFINITION's label as field name, option LABELS as
  values; deleted options fall back to the stored label.
- **Comment deleted**: "deleted a comment" + the reply-count gloss ("and
  its 2 replies — content not retained") — NEVER the content (what 5.1.2
  records).
- **created**: the feed's oldest anchor ("created the issue");
  **archived**: its own quiet row (both muted-ink sentences, no value
  line).
- **The generic fallback** — a DESIGNED state, not an accident (mistake
  #29): an unregistered diff key renders mono on the `--el-muted` fill
  ("changed `riskScore`") with safely-stringified values.
- **Deleted referent**: the "Former member" form — muted "?" avatar
  (`--el-muted` bg, `--el-text-muted` glyph), italic muted name; deleted
  options/sprints/issues render their stored label fallback. Never a
  broken entry.

### The noise-suppression policy (what never renders)

Pure `position` / `backlogRank` reorders and the denormalised `key` /
`identifier` writes have **NO row form by design** — Jira shows no
board-reorder noise in History. The 5.5.1 registry marks them `suppressed`
(explicit disposition, not accidental omission); a diff mixing suppressed +
renderable keys renders only the renderable parts. The trail still holds
the rows — suppression is a render decision.

### The All stream

Comments (the full 5.1.3 grammar — 22px avatar, 14px body, quiet action
row; Reply etc. still live here) interleave with history rows (this
grammar) in true timestamp order — the bounded two-source composite-cursor
merge (5.5.2, finding #57). The shared 22px grid column + the size/ink
step-down (18px vs 22px avatar, 13px secondary vs 14px primary ink) is the
visual rhythm that keeps the two scannable: conversation loud, telemetry
quiet. A deleted comment appears ONCE, as history; live comments never
duplicate into history.

### Pagination + states

Each tab pages its own read (History: the 1.4.6 revisions cursor, 20/page;
All: the composite cursor) behind the 5.1.3 pager grammar at the OLDER edge
— "Show more changes (N older)" / "Show more activity (N older)" — flipping
top/bottom with the sort direction; clicking extends backward and keeps
scroll position. **Loading**: the `BacklogSkeleton` pulse grammar shaped
like history rows (18px circle + sentence/value bars, `aria-busy`).
**Empty History**: the 5.1.3 empty grammar with the `history` glyph — "No
history yet — changes to this issue will show up here" (practically
unreachable; designed anyway). **Error**: the `ErrorState` grammar —
"Couldn't load history" / "Something went wrong fetching the activity." +
secondary Retry ("Couldn't load activity" on All).

### Copy strings

"All" / "Comments" / "History" · "— N changes" / "— N comments · N changes"
· "changed the <Field>" · "updated the Description" · "None" · "moved this
issue to Sprint N" / "moved this issue to the Backlog" · "linked <KEY> as
<kind>" / "removed the <kind> link to <KEY>" · "added/removed the Label" ·
"added/removed the Component" · "attached <file>" / "removed the attachment
<file>" · "deleted a comment" + "and its N replies — content not retained"
/ "content not retained" · "created the issue" · "archived the issue" ·
"changed <key>" (fallback) · "Former member" · "Show more changes (N
older)" / "Show more activity (N older)" · "Oldest first" / "Newest first"
· "No history yet — changes to this issue will show up here" · "Couldn't
load history" / "Couldn't load activity" / "Something went wrong fetching
the activity." / "Retry".

### Tokens / a11y

NO new primitive and NO new token: everything composes the 5.1.3 section
vocabulary (seg / sort-btn / show-more / skeleton / empty / ErrorState),
the shipped `Pill` recipe, the 5.4 chip vocabulary, and the mono
identifier + `--el-link` treatment. Colour only through `--el-*`; shape
through the element-semantic tokens (`--radius-card/control/btn/badge`,
`--spacing-card-padding`, `--spacing-control-x/y`, `--spacing-chip-x/y`,
`--height-control`, `--height-btn-sm`, `--shadow-card`). The tab row is the
5.1.3 `role="tablist"` grammar with all three tabs enabled; each feed is a
labelled list (`role="list"` / `aria-label`) whose entries read as full
sentences (the values are inline text, so a screen reader hears "Bo Philips
changed the Status, To do → In progress, yesterday"); timestamps absolute
via `title`; the skeleton sets `aria-busy`; AA holds in both themes (muted
ink ≥4.5:1 on page bg, tinted Pills/chips use `--el-text-strong` — finding
#35). Light + dark parity via the token flip (toggle in the mock).

### Out of scope (documented extension slots)

- A **Work log** tab — follows a time-tracking feature if one ever lands
  (no such feature is planned).
- History for comment EDITS beyond the "· Edited" tag (Jira keeps no
  comment version history either).
- Cross-issue / project-level activity streams — Epic-6 reporting
  territory.
- Retention / purge admin — the mirror has none; append-only is the
  contract.
- Rendering rank/position noise — suppressed by the explicit policy above.
- Realtime updates — the section refreshes like every other surface (the
  5.1 product-wide decision).

---

## Filter builder — the Advanced surface (Story 6.1 · 6.1.3 → 6.1.4 / 6.1.5)

`filter-builder.mock.html` is the design for the **advanced filter builder** —
the structured field / operator / value rows under a flat **Match all / Match
any** combinator that Story 6.1 ships as the no-parser advanced mode.
`filter.mock.html` (2.5.9) designs ONLY the basic facet popover, so the builder
was the design-gate NONE-exists case; this asset closes it for code Subtasks
**6.1.4** (built-in rows) and **6.1.5** (Epic-5 rows). Mirrors: Jira basic's
field/value vocabulary for the editors; the flat-rows structured builder shape
(Linear's filter editor) for exactly the operator set Jira's own docs say basic
cannot express (OR across fields, NOT, EMPTY, comparisons) — the recorded
richer-than-basic justification in the Story 6.1 module. A `filter-builder.png`
export accompanies the HTML for the board view; the HTML is the source of
truth.

### The UI contract is the SHIPPED 6.1.1 registry

The builder **renders `lib/filters/registry.ts`** — it never hard-codes a field
list. Field menu = `FILTER_FIELDS` in registry order, then the project's
dynamic entries (6.1.2/6.1.5). Choosing a field populates its operator menu
from `def.operators`; the operator resolves the value editor via
`filterValueEditorKind`. The editor-kind ↔ component mapping (the 6.1.1 UI
contract, pinned):

| `FilterValueEditorKind`            | Component (shipped)                                                    | Drawn in panel |
| ---------------------------------- | ---------------------------------------------------------------------- | -------------- |
| `kind-select`                      | `MultiSelectPicker` — kind options w/ `IssueTypeIcon` hue              | 1              |
| `status-select`                    | `MultiSelectPicker` — workflow statuses w/ the StatusPicker dot        | 1, 2           |
| `priority-select`                  | `MultiSelectPicker` — priorities w/ the `PRIORITY_META` direction icon | 1              |
| `member-select`                    | `MultiSelectPicker` — members w/ Avatar; **Unassigned sentinel first** | 1 (Reporter)   |
| `sprint-select`                    | `MultiSelectPicker` — sprints; **Backlog sentinel first**              | 1              |
| `text`                             | `Input`                                                                | 1              |
| `number`                           | `Input` (`inputmode="numeric"`, tabular-nums)                          | 1              |
| `date`                             | `DatePicker` trigger (2.4.11 calendar)                                 | 1              |
| `date-range`                       | two `DatePicker` triggers joined by "and"                              | 1              |
| `days`                             | `Input` numeric + the "days" unit suffix                               | 1              |
| `none` (`is empty / is not empty`) | the value slot COLLAPSES (field + operator only)                       | 1 (Assignee)   |

Operator menu labels (the registry ids, humanized — pinned copy):
`is any of` · `is none of` · `is empty` · `is not empty` · `contains` ·
`does not contain` · `=` `≠` `<` `≤` `>` `≥` · `on or before` · `on or after` ·
`is between` · `in the last … days` · `in the next … days`. The windowed
operators render the trigger label without the count ("in the next") and put
the count in the `days` editor. The single registry `text` field covers
title + description — its menu row carries the "title + description" secondary.

### Entry + coexistence (panel 0)

- **[Advanced]** is a `ToolbarButton` (the `.tb-btn` grammar) with the lucide
  `funnel-plus` glyph, placed **immediately after the shipped [Filter]** facet
  button in the `/items` toolbar. Active state = the 2.5.4 grammar extended:
  accent ring + lavender fill + a count badge of **applied (complete) rows**.
- **Upgrade (one-way, lossless)** — the facet popover gains a footer row,
  `Edit in Advanced` (link-styled, `funnel-plus`), which opens the builder with
  every facet selection carried in as rows (the 6.1.1 facet→AST map). The 2.5.4
  facet bar REMAINS the quick path.
- **Superseded facet state** — when the AST exceeds facet expressiveness
  (OR / negation / empty / comparisons / non-facet fields), the [Filter] button
  mutes its label and gains a small lavender `funnel-plus` badge
  (`aria-label="Managed in Advanced"`) + tooltip: _"Managed in Advanced — this
  filter uses conditions the quick filter can't show. Open Advanced to edit
  it."_ Opening it shows the popover read-only with the same hand-off. **Never
  a silent down-conversion** (the verified mirror rule).

### The builder surface (panels 1–4)

- **Container** — a `Popover` (`role="dialog"`, labelled "Advanced filter")
  anchored under [Advanced]: 680px, `--radius-card`, `--el-border` hairline,
  `--shadow-elevated`. Header = mono 11px uppercase title + **Clear all**
  (the `fp-clear` link grammar). Footer = **+ Add condition** (link + plus) ·
  the live hint `N of 20 conditions · applied live`.
- **Combinator** — the `Segmented` control (3.3.5) read as a sentence:
  "Match **[all | any]** of the following conditions:". One level only — no
  nested groups (the documented builder→parser extension slot).
- **Condition row** — a labelled `role="group"`: field `Combobox` trigger
  (158px) · operator `Combobox` trigger (168px) · the operator's value editor
  (flex) · the remove × (`--spacing-icon-btn` square). Triggers are
  `--height-control`, editors `--height-input` — **the primitives' own heights,
  centre-aligned; no new size variants and no new primitive**. CF rows carry
  their 5.3.4 type glyph in the field trigger; Label/Component rows the
  `tag`/`component` glyph.
- **Live-apply + pending rows** — there is NO Apply button (the 2.5.4
  precedent): complete rows write `?filter=v1:…` (composing with
  `?view/?sort/?page`, Suspense-keyed) as they land. A row missing its value is
  **pending**: dashed boxes + the italic line _"Not applied yet — pick a value
  to activate this condition."_ — excluded from the badge count, the URL, and
  the result set; emptying an applied row returns it to pending without
  dropping it.
- **Row cap** — at `FILTER_ROW_CAP` (20) Add condition disables with
  _"Condition limit reached (20) — remove one to add another."_
- **Epic-5 rows (6.1.5)** — the field menu grows the project's dynamic entries
  under **Custom fields** (5.3.4 type glyphs) and **Other** (Label, Component).
  Select-CF chips include archived options with the 5.3.5 italic "(archived)"
  mark (historical matching); label chips take the 5.4 name-hash tint with
  `--el-text-strong` text; component chips stay neutral with the glyph; CF
  user/number/date/text reuse the built-in editors. Member/sprint/label/
  component listboxes are their owners' bounded reads + sub-search (the 5.4.6
  vocabulary).

### Applied state (panel 5)

The toolbar summary (active [Advanced] + row-count badge) plus a read-only
**condition-chip readout** under the toolbar — a `Match any` lavender chip
(only on OR) followed by one neutral chip per condition (`**Field** operator
values`); clicking any chip or the trigger opens the builder. The result
**count line** (`N issues match`, `role="status"`) tracks edits live.
Zero results = the EmptyState grammar: _"No issues match this filter"_ /
_"Try removing a condition, or clear the filter to see everything."_ +
**Clear all**.

### Durable-URL states (panel 6)

- **Stale referent** — a condition whose field/option/label/component/member
  id no longer resolves (a shared or saved URL outliving the data) renders the
  **Unknown value** chip (triangle-alert in `--el-warning` on the peach tint,
  `--el-text-strong` text) + the per-row `role="status"` notice _"This value no
  longer exists in the project — this condition matches nothing."_ The row
  stays visible and editable; the query matches nothing for it (the 6.2
  saved-filter durability rule). A field deleted under an open builder degrades
  its row to the same state.
- **Invalid `?filter=` param** — the typed recoverable decode failure renders a
  callout card (_"This filter link couldn't be read"_ + **Clear filter**) above
  the UNFILTERED list — never a crash, never a silent drop.

### Both views (panel 7)

One compiled predicate feeds both reads: the List (the navigator-faithful
result — sortable headers, 50/page + count, 2.5.8/2.5.12) and the Tree
(ancestor-retaining, muted non-matching ancestors — the shipped 2.5.1
behaviour, referenced not redrawn). Identical match sets.

### Copy strings

`Advanced` · `Edit in Advanced` · `Advanced filter` · `Match all/any of the
following conditions:` · `Add condition` · `Clear all` · `N of 20 conditions ·
applied live` · `Condition limit reached (20) — remove one to add another.` ·
`Not applied yet — pick a value to activate this condition.` · `Unknown value`
· `This value no longer exists in the project — this condition matches
nothing.` · `This filter link couldn't be read` · `The filter in this URL is
invalid or from a newer version of Motir, so no filter was applied. Clear it
to dismiss this message.` · `Clear filter` · `N issues match` · `No issues
match this filter` · `Try removing a condition, or clear the filter to see
everything.` · the superseded tooltip (above). All via next-intl in 6.1.4/6.1.5.

### Tokens / a11y

- Colour only via Tier-3 `--el-*`: count badge / selected rows / Check / the
  active ring = `--el-accent`; the stale grammar = `--el-warning` glyph +
  `--el-tint-peach` + `--el-text-strong` (AA, finding #35 — and never colour
  alone: the glyph + notice text carry the state); label chips the name-hash
  `--el-tint-*`; **no new token needed**.
- Shape via element-semantic tokens only (`--radius-card/input/control/btn/
badge`, `--spacing-control/input/chip/icon-btn/tooltip-*`,
  `--height-control/input`, `--shadow-elevated/subtle`) — the builder reshapes
  under `data-display-style`.
- **No new primitive**: Popover + Combobox + MultiSelectPicker + Input +
  DatePicker + Segmented + Pill + the toolbar/empty/callout grammars cover
  every element.
- A11y: the builder is a labelled dialog; rows are labelled groups; every
  picker keyboard-complete per its own primitive's bar; the combinator is a
  labelled `role="group"` of `aria-pressed` buttons reading as a sentence; the
  count line `role="status"`; the stale notice `role="status"`, the invalid
  callout `role="alert"`; remove buttons carry value-specific names. Light +
  dark parity via the token flip (toggle in the mock).

### Out of scope (documented extension slots)

- **Nested condition groups** — the builder→parser line (the Story 6.1
  recorded extension).
- **Saving / naming filters** — Story 6.2 persists the `?filter=v1:`
  serialization this surface writes.
- A JQL-style text query language (the stub's hard NO); cross-project search
  (the substrate is active-project-scoped — rung 2); stemmed full-text search
  (ILIKE + trgm ships).
- Filter chips editable in place (the readout is read-only; editing happens in
  the builder — one editing surface).

---

## Saved filters — save · apply · manage · subscribe (Story 6.2 · 6.2.2 → 6.2.3 / 6.2.4 / 6.2.5)

`saved-filters.mock.html` designs every Story 6.2 surface:
`filter-builder.mock.html` (6.1.3) designs ONLY the builder, so saving,
applying, managing, sharing, and subscribing were the design-gate NONE-exists
case. This asset closes it for code Subtasks **6.2.3** (save + apply UI on
/items), **6.2.4** (the filters directory), and **6.2.5** (subscriptions) —
and pins the "Filter missing" widget state Story 6.3 inherits. Mirrors
(verified in the Story 6.2 seed module, 2026-06-10): Jira's Save / Save-as
ownership split, its Filters-directory columns (name / owner / visibility /
popularity / actions), its starred-first filter menu, its delete-in-use
warning, its preset-tier subscriptions, and its read-only system filters.
A `saved-filters.png` light render accompanies the HTML for the board view;
the HTML is the source of truth (toggle dark in it for token parity).

### The seven panels

| Panel | Surface                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | The /items toolbar: the **[Saved]** ToolbarButton (bookmark glyph, right of [Advanced]) + the applied-filter **name chip**; clean vs dirty-owner vs dirty-non-owner |
| 1     | The **save dialog** (Modal `size="md"`): name / description / visibility; the duplicate-name error; the viewer private-only state                                   |
| 2     | The **[Saved] dropdown**: Starred → My filters → Project filters → Defaults, server search, per-row star, View-all footer; the empty-group states                   |
| 3     | The **filters directory** at `/filters`: searchable paginated table, role-gated row actions, built-ins read-only, empty + no-access states                          |
| 4     | The **visibility control** (Edit details) + the **delete-with-dependents** confirm                                                                                  |
| 5     | The **subscription editor** (preset schedule) + the subscribed state + its mounts                                                                                   |
| 6     | The **“Filter missing”** widget state (the 6.3 degraded card)                                                                                                       |

### Entry + the applied state (panel 0 → 6.2.3)

- **[Saved]** is a `ToolbarButton` (the `.tb-btn` grammar) with the lucide
  `bookmark` glyph + caret, placed **immediately right of [Advanced]**
  (6.1.3's builder trigger). Active state = the 2.5.4 grammar (accent ring +
  lavender fill) while a saved filter is applied.
- **The name chip** prepends the 6.1.3 summary-chip row: bookmark glyph
  (`--el-accent`) + the filter name on the lavender tint with
  `--el-text-strong` text (AA, finding #35), plus a visibility hint glyph
  (`users` = project-shared, `lock` = private). Clicking it opens the [Saved]
  dropdown. The 6.1.3 condition chips and count line stay unchanged.
- **Dirty state** — the chip's URL-AST is compared to the saved envelope
  (6.1.1 equality). When they diverge: the amber dot + the italic word
  **"Edited"** (`role="status"`, never colour-only), and the action set by
  ownership — **owner: [Save] [Save as] [Discard changes]** · **non-owner:
  [Save as] only**, with the ink tooltip explaining why ("Only the owner can
  overwrite this filter — Save as creates your own copy."). "Discard changes"
  reloads the saved envelope into builder + URL. Save (owner overwrite) shows
  NO dialog — it writes the current AST into the row in place.

### The save dialog (panel 1 → 6.2.3)

- `Modal` (`--radius-modal` / `--shadow-modal`), `FormField` grammar: **Name**
  (required), **Description (optional)** `Textarea`, and **"Who can see this
  filter?"** — two stacked radio cards in the 6.4.1 access-card grammar:
  **Private** (lock on `--el-tint-lavender`: "Only you and project admins can
  see it.") and **Project** (users on `--el-tint-sky`: "Everyone who can
  browse this project can see and apply it."). Selected card = `--el-accent`
  border + filled radio. **Default visibility: Private** (the Jira default
  share; the safe choice).
- **Duplicate name** — per-project case-insensitive (the 6.2.1 constraint):
  inline `role="alert"` error under the field ("A filter named “…” already
  exists in this project."), primary disabled until it clears.
- **Viewer** — the Project card renders **visible-but-disabled** (the 6.4.6
  affordance rule) under an `--el-tint-sky` info line: "Sharing needs the
  **Member** role — as a viewer, your filters stay private to you."
- "Save as" always opens this dialog (prefilled with the source filter's name
  when forking an applied filter).

### The dropdown (panel 2 → 6.2.3)

- The Combobox menu vocabulary (320px, `--radius-card`, `--shadow-elevated`):
  search field ("Find filters…", server-backed + debounced + bounded —
  finding #57), then the fixed group order **Starred → My filters → Project
  filters → Defaults**. A starred entry appears ONLY under Starred (no
  duplicates).
- Rows: a **star toggle** (a sibling focusable button inside the option row —
  never nested in another control; starred = filled `--el-warning` amber star
  - `aria-pressed`), the name, and the secondary hint — visibility glyph +
    owner name for others' shared filters, "Private" + lock for mine,
    "Built-in" for defaults. The APPLIED entry carries the `--el-accent` check
    (`aria-selected`).
- Footer: **"View all filters"** → the `/filters` directory. Per-group empty
  lines: "No starred filters yet — star a filter to pin it here." / "You
  haven't saved any filters yet." / "No filters shared with this project
  yet."
- Applying an entry resolves the stored envelope through the 6.2.1 read and
  writes `?filter=v1:` — the URL stays the single state channel
  (reload/share keep working; no new state surface).

### The directory (panel 3 → 6.2.4)

- **Route: `/filters`** — project-scoped, a sibling of `/items` in the
  authed shell. Entries: the dropdown's "View all filters" footer + the
  command palette. **Deliberately NOT a primary sidebar item** — Jira's
  "Filters" nav entry belongs to its site-global model; in Motir's
  project-contained model the /items toolbar is the home of filtering, and
  the sidebar stays lean (recorded deviation).
- The table (the list-table grammar): **Name** (bookmark/lock glyph + linked
  name — clicking applies the filter on /items — + truncated description) ·
  **Owner** (Avatar + name; built-ins "—") · **Visibility** (`Pill`:
  Project = users glyph on `--el-tint-sky`; Private = lock, neutral tone;
  Built-in = neutral) · **Stars** (my-star toggle + the SQL-aggregated
  count) · **Actions** (the … menu). Server-searched + paginated (50/page,
  the 2.5.12 footer) — never an unbounded fetch.
- **Row actions by the 6.2.1 matrix**: owner → Edit details / Subscribe… /
  Delete; project admin (and workspace owner/admin) additionally → Change
  owner — on ANY project-shared filter (the mock shows an admin's menu on
  another member's filter); non-owners on shared rows → Subscribe… only.
  "Edit details" opens the panel-1 dialog prefilled; **"Change owner" reuses
  the 6.4.1 add-member Combobox grammar** (referenced, not redrawn).
- **Built-ins** (the eight expressible system filters: My open issues ·
  Reported by me · All / Open / Done issues · Created / Updated / Resolved
  recently) are listed read-only: no owner, no stars, no actions.
  **Decision (recorded): built-ins are NOT starrable and NOT subscribable** —
  they are non-persisted AST constants (6.2.1); there is no row to star or to
  FK a subscription to, and they are already always present in the dropdown's
  Defaults group. ("Viewed recently" omitted — no view-history substrate;
  extension.)
- States: the EmptyState ("No saved filters yet" + "Go to Issues" — creation
  lives in the /items builder, the directory manages) and the 6.4.6
  ErrorState verbatim for a no-access deep link. Loading = the standard
  table skeleton (the 2.5.8 grammar, not redrawn).

### Visibility + deletion (panel 4 → 6.2.3 / 6.2.4)

- **Edit details** carries the same visibility radio cards; flipping
  Project → Private surfaces the info note naming the consequences ("hides it
  from everyone else — their subscriptions stop delivering, and dashboard
  widgets using it show “Filter missing”") — the quiet symmetric twin of the
  delete warning.
- **Delete** is a `role="alertdialog"` confirm that **names the dependents**
  (the 6.2.1 enumeration read): "**1 subscription** will be removed (…)" and
  the RESERVED 6.3 line "**N dashboard widgets** use this filter — they'll
  show a “Filter missing” state." `Button` danger; consequences in text,
  never colour-only. Deletion cascades subscriptions in one transaction;
  widgets degrade to panel 6.

### Subscriptions (panel 5 → 6.2.5)

- The dialog: **Frequency** as the `Segmented` control (Daily / Weekdays /
  Weekly), **Day** (Combobox, rendered only for Weekly) + **Time** (Combobox,
  clock glyph, hour presets), and the explainer copy: "Emails you the first
  50 results and the total count, on the workspace timezone. A report, not an
  alert — it sends even when nothing matches."
- The **subscribed state**: mint-tile bell card "Subscribed — daily at 09:00"
  - the delivery line + **Unsubscribe** (ghost). In the row menus the
    Subscribe item flips to "Subscribed…" with the schedule as its secondary.
- **Mounts**: the directory row's … menu + the dropdown row's context action
  — both open this dialog. Unsubscribe also lives in the email
  (token-authenticated link, the shipped unsubscribe pattern).

### The "Filter missing" widget state (panel 6 → 6.3)

The degraded BODY a dashboard widget renders when its filter FK dangles (the
verified Jira-gadget behaviour, designed here so 6.3 inherits it): the
`triangle-alert` glyph in `--el-warning`, the serif headline "Filter
missing", the one-line cause, and a single recovery action ("Choose a
filter"). The widget chrome itself is 6.3's to design; never a crash, never
a silent blank.

### Copy strings

`Saved` · `Find filters…` · `Starred` · `My filters` · `Project filters` ·
`Defaults` · `Built-in` · `View all filters` · the three group-empty lines
(above) · `Edited` · `Save` · `Save as` · `Discard changes` · `Save filter` ·
`Name` · `Description (optional)` · `What is this filter for?` · `Who can see
this filter?` · `Private` / `Only you and project admins can see it.` ·
`Project` / `Everyone who can browse this project can see and apply it.` ·
`A filter named “…” already exists in this project.` · `Sharing needs the
Member role — as a viewer, your filters stay private to you.` · `Only the
owner (…) can overwrite this filter — Save as creates your own copy.` ·
`Filters` · `Saved filters for … Save new ones from Issues.` · `Search
filters…` · `Name / Owner / Visibility / Stars` · `Edit details` · `Change
owner` · `Subscribe…` · `Delete` · `No saved filters yet` / `Build a filter
on Issues and save it to reuse and share it here.` / `Go to Issues` · `Edit
filter details` · `Save changes` · the go-private note (above) · `Delete
filter?` · `This permanently deletes “…” for everyone in this project.` ·
`N subscription(s) will be removed (…)` · `N dashboard widgets use this
filter — they'll show a “Filter missing” state.` · `Delete filter` ·
`Subscribe to “…”` · `Frequency` · `Daily` / `Weekdays` / `Weekly` · `Day` ·
`Time` · the subscription explainer (above) · `Subscribe` · `Subscribed —
daily at 09:00` · `Unsubscribe` · `Filter missing` · `The saved filter this
widget used was deleted, so it can't load results.` · `Choose a filter` ·
`12 filters · page N of M`. All via next-intl in 6.2.3/6.2.4/6.2.5.

### Tokens / a11y

- Colour only via Tier-3 `--el-*`: the name chip + active triggers ride
  `--el-tint-lavender` + `--el-accent`; visibility tiles/pills the lavender /
  sky tints with `--el-text-strong` (AA, finding #35); the starred star is
  filled `--el-warning` amber (+ `aria-pressed` — state never colour-only);
  the dirty marker is the amber dot + the word "Edited"; the danger path
  `--el-danger` / `--el-danger-text`; **no new token needed**.
- Shape via element-semantic tokens only (`--radius-btn/card/input/modal/
control/badge`, `--spacing-control/input/chip/icon-btn/tooltip/btn-*`,
  `--height-control/input/btn-*`, `--shadow-subtle/elevated/modal`) — every
  surface reshapes under `data-display-style`.
- **No new primitive**: ToolbarButton + Modal + FormField + Input/Textarea +
  Combobox (menus, day/time selects) + Segmented + Pill + the 6.4.1
  access-card radio grammar + the list-table/pagination grammars +
  EmptyState/ErrorState + Avatar + Tooltip cover every element.
- A11y: the dropdown is a labelled `listbox` (options `aria-selected`; the
  star a sibling focusable button with `aria-pressed`, value-specific
  names); dialogs are focus-trapped `role="dialog"` / the delete confirm
  `role="alertdialog"`; the dirty marker and result counts `role="status"`;
  visibility radios a labelled `radiogroup` with full keyboard support; row
  menus `role="menu"` keyboard-complete; the disabled Project card
  `aria-disabled` with the reason visible in text. Light + dark parity via
  the token flip (toggle in the mock).

### Out of scope (documented extension slots)

- Per-filter Viewers/Editors grant lists + group share scopes (no groups in
  Motir; the 6.4 roles draw the boundary — the Story 6.2 recorded
  deviation).
- Cross-project / workspace-global filters (follows the 6.1 scope deviation).
- Filter-sourced boards (the company-managed shape; Motir boards stay
  status-mapped — 3.1/3.6).
- Advanced cron subscriptions (the preset tier ships; cron is the power-user
  extension).
- "Viewed recently" (no view-history substrate).
- A "Filters" primary sidebar item (the site-global Jira shape; revisit if a
  use case lands).

---

## Work-item type + executor picker (Story 2.7 · 2.7.1 → 2.7.4)

Asset: `design/work-items/type-executor-picker.mock.html` (four panels; toggle
dark for token parity). The design for two NEW structural fields promoted from
plan PROSE to UI — `type` (a fixed ten-member `WorkItemType` enum, leaf-only)
and `executor` (`coding_agent | human`, seeded from a type→executor default
map). The picker is a NEW element on TWO existing surfaces — the issue **create
modal** (2.3.3) and the issue **detail rail** (2.4). The code subtask is 2.7.4
(blocked on this design gate + on the 2.7.3 schema).

### The mirror, and why this is a sibling control (not a replacement)

Verified in 2.7.2 (Atlassian): Jira's "issue type" IS the kind hierarchy
(epic/story/task/sub-task/bug) and routing-WHO is the **assignee** field (a
Rovo agent "shows up as an assignee"). Motir splits the axes — `type` (what
NATURE of work) + `executor` (who) — for the Epic-7 dispatch use case. So the
control is drawn as a **sibling of the kind/assignee affordances**, never a
replacement for kind: in the create modal it is its own `Type` field row
(after Kind/Title), and on the detail rail its own `Type` + `Executor` rows
alongside Status/Assignee.

### Placement

- **Create modal (panel 1).** A new `Type` field row, then an `Executor` row,
  inserted after the existing Kind + Title rows (before the rest of the
  optional fields). Both rows render **only when the chosen kind is a leaf**
  (task / subtask / bug) — absent for epic / story (panel 2d). The `Type`
  field is the shipped `Combobox`; because the modal is a `role="dialog"`, its
  menu renders **inline** (the Combobox in-dialog branch), not portaled.
- **Detail rail (panel 3).** Two new rail rows — `Type` (the hued chip) and
  `Executor` (the agent/person indicator) — in the metadata column beside
  Status / Assignee, each **inline-editable** (the 2.5.5 pattern: the static
  chip/indicator IS the click target, opening the same picker in place).

### The type picker — Combobox (panel 1; 2.7.4)

- The shipped `Combobox` (`components/ui/Combobox.tsx`), `searchable={false}`
  (a fixed, closed set of ten — no type-ahead), exactly like the existing
  kind `TypePicker`. Each option row = the type's **saturated `--el-type-*`
  glyph** (mirroring `IssueTypeIcon`) + its label; the selected row carries the
  trailing `Check`. The trigger shows the chosen glyph + label + the
  `ChevronsUpDown` affordance, or the `Set a type` placeholder when null.
- **The ten members, in menu order:** Code · Design · Test · Content ·
  Research · Review · Decision · Deploy · Manual · Chore (the 2.7.2 enum order;
  the "doing" types first, the meta/admin types last).

### The executor control — Segmented (panels 1–2; 2.7.4)

- The shipped `Segmented` (`components/ui/Segmented.tsx`), a two-option group:
  `Coding agent` (bot glyph) | `Human` (person glyph). The pressed option gets
  the raised `--el-page-bg` fill + `--shadow-subtle`; its leading glyph takes
  `--el-accent` (the Segmented contract).
- **Default-seeding (panel 2a/2b).** Choosing a type SEEDS the executor from
  the 2.7.3 `defaultExecutorForType` helper (the single source — the UI never
  re-states the map): `code` → `coding_agent`, `manual` → `human`, etc. The
  seed is **not a lock** — the user can flip it and the override sticks
  (panel 2b shows Manual seeding Human, then overridden to Coding agent).
- **Unset (panel 2c).** `type` is nullable; the trigger shows `Set a type` and
  the executor control is dormant until a type seeds it.

### The type chip + executor indicator — detail rail (panel 3; 2.7.4)

- **Type chip** — the `Pill` recipe: the type's hue in a **`color-mix` tint
  BACKGROUND** + `--el-text-strong` label (AA, finding #35 — never a
  page-level tint) + the saturated `--el-type-*` glyph. A single saturated
  `--el-type-*` token therefore yields BOTH the glyph hue and the chip tint
  (`color-mix(in srgb, var(--el-type-X) 14%, var(--el-page-bg))`; the two grey
  meta-types use 18% so the near-neutral tint still reads) — so no ten separate
  `--el-tint-*` pairs are needed.
- **Executor indicator** — a compact bot/person glyph (`--el-text-secondary`)
  - label, read-only until clicked.
- **Null leaf (panel 3c).** A quiet dashed `Set a type` affordance; no executor
  row appears until a type is set.

### The ten-type hue map (panel 4 — decided once here)

Proposed as ten new Tier-3 `--el-type-{code…chore}` tokens (2.7.4 adds them to
`globals.css`, the per-component token-growth pattern — the per-TYPE palette
parallel to the existing per-KIND `--el-type-{epic…subtask}`). **No new Tier-0
colour is needed:** the seven "produces an artifact" types take the seven
saturated hues; the three "meta / admin" types (decision, manual, chore) take
the three greys — desaturation is semantically apt.

| Type       | `--el-type-*` → Tier-0      | Glyph (lucide)  | Executor default       |
| ---------- | --------------------------- | --------------- | ---------------------- |
| `code`     | `--color-info` (blue)       | code            | coding_agent           |
| `design`   | `--color-accent` (pink)     | pencil          | either (default agent) |
| `test`     | `--color-success` (green)   | flask-conical   | coding_agent           |
| `content`  | `--color-accent-teal`       | file-text       | either (default agent) |
| `research` | `--color-primary` (purple)  | lightbulb       | either (default agent) |
| `review`   | `--color-accent-orange`     | clipboard-check | human                  |
| `deploy`   | `--color-destructive` (red) | rocket          | coding_agent           |
| `decision` | `--color-charcoal` (ink)    | scale           | human                  |
| `manual`   | `--color-stone` (grey)      | hand            | human                  |
| `chore`    | `--color-slate` (grey)      | wrench          | either (default agent) |

`deploy` → red is the one semantic stretch (production/ship = high-stakes); the
glyph (rocket) disambiguates it from the `bug` KIND, which also uses red but
appears in a different control. The default-executor column is the single map
2.7.2 fixes and 2.7.3's `defaultExecutorForType` encodes.

### Copy strings

- **Type labels (10):** `Code` · `Design` · `Test` · `Content` · `Research` ·
  `Review` · `Decision` · `Deploy` · `Manual` · `Chore`.
- **Executor labels (2):** `Coding agent` · `Human`.
- **Empty / field:** field labels `Type`, `Executor`; the unset placeholder +
  the dashed detail affordance both read `Set a type`.
- All copy goes in the issues i18n namespace (the same locale set the app
  ships — 2.7.4 AC); labels match the enum gloss in
  `docs/decisions/work-item-type-taxonomy.md` (2.7.2).

### Tokens / a11y

- Colour only via Tier-3 `--el-*`: the ten per-type hues = the new
  `--el-type-{code…chore}` (glyph) + a `color-mix` tint of the same token (chip
  background) with `--el-text-strong` (AA, finding #35, and never colour alone
  — the glyph SHAPE + the label carry the type); the executor glyph =
  `--el-text-secondary`, the active segment glyph = `--el-accent`. No
  page-level tint.
- Shape via element-semantic tokens only (`--radius-input/card/control/btn/
badge`, `--spacing-control/chip-*`, `--height-control`,
  `--shadow-elevated/subtle/modal`) — every surface reshapes under
  `data-display-style`.
- **No new primitive** — Combobox + Segmented + Pill (chip) + the
  `IssueTypeIcon`-adjacent glyph + the modal/rail grammars cover every element.
- A11y: the type picker is the Combobox's labelled `role="combobox"` →
  `role="listbox"` of `role="option"` rows (keyboard-complete per its own bar);
  the executor control is Segmented's labelled `role="group"` of `aria-pressed`
  buttons; the inline-edit chips are keyboard-activatable triggers that open
  the same pickers; type/executor controls carry aria-labels. Light + dark
  parity via the token flip (toggle in the mock).

### Out of scope (documented extension slots)

- **Per-type PROMPT generation** that keys off `type` — Story 7.6 (the
  total-function generator the fixed enum exists to support).
- **The AI dispatch surface** that routes by `executor` (agent-dispatch vs
  human-assign) — Story 7.6 / 7.7.
- **Adding an eleventh type** — an explicit enum addition + migration (+ a new
  `--el-type-*` token), never an ad-hoc free-text string (the closed set is the
  whole point).
- **Bulk type/executor edit** from the list/board (the single-item picker
  ships; multi-select bulk edit is a later list-surface extension).
- Any change to the **kind-parent grammar** — `type` is orthogonal to `kind`
  and never affects parenting.

### Primitives composed (no hand-rolling)

- **Type picker** → `Combobox` (`components/ui/Combobox.tsx`, in-dialog inline
  menu).
- **Executor control** → `Segmented` (`components/ui/Segmented.tsx`).
- **Type chip** → the `Pill` tint-background recipe + the `IssueTypeIcon`
  saturated glyph.
- **Type glyphs** → the `IssueTypeIcon` hue pattern extended to the ten
  `--el-type-*` TYPE tokens.
- **Modal / rail chrome** → the shipped `Modal` + the detail-rail metadata-row
  grammar.
- If a genuinely new primitive is ever needed, that is a NEW `design/` subtask
  — not a 2.7.4 code workaround.

---

## Delete a work item — confirm UX (Story 2.8 · 2.8.1 → 2.8.4)

Asset: `delete-confirm.mock.html` designs the **permanent delete** flow for
Story 2.8 (Jira-parity hard delete with a **subtree cascade**), shown next to
the already-shipped soft **archive** (`workItemsService.archiveWorkItem` —
`archivedAt`, single-node, reversible). 2.8.1 is the design gate; the UI code
(delete action + confirm dialog on detail / list / board, permission-gated) is
2.8.4, blocked on this.

**The two destructive actions are kept deliberately distinct** — this is the
whole point of the surface:

| Action      | Reversible       | Scope                      | Confirm                         | Gate        |
| ----------- | ---------------- | -------------------------- | ------------------------------- | ----------- |
| **Archive** | Yes (restorable) | Single node (kids stay)    | inline / lightweight            | `canEdit`   |
| **Delete**  | No (permanent)   | The whole subtree, cascade | `alertdialog` — count + warning | `canDelete` |

**Mirror check (rung 1 — Atlassian + Linear):** Jira's delete confirm warns the
action is permanent, **names the cascade** ("This issue has N sub-tasks that
will also be deleted"), and offers no type-to-confirm for a normal issue — a
single Cancel / Delete pair. We match that exactly and reuse the **5.3.6
delete-with-count** dialog grammar (`saved-filters.mock.html` panel 4): a real
`role="alertdialog"`, consequences **named in text** (never colour-only), a
dependents list, and a destructive button labelled with the action + magnitude.

### The six panels

| Panel | Surface                                                                      |
| ----- | ---------------------------------------------------------------------------- |
| 0     | Entry point — the **work-item detail** ⋯ actions menu, open (permitted)      |
| 1     | Entry points — **list row** + **board card** ⋯ menus, and the **gated** menu |
| 2     | Confirm dialog — **parent with descendants** (the cascade)                   |
| 3     | Confirm dialog — **leaf** item (no descendants)                              |
| 4     | States — **in-flight** (deleting) · **error** (failed, retryable)            |
| 5     | Legend — the archive-vs-delete table + copy index                            |

### Entry points (panels 0–1)

- The ⋯ menu is the shipped `Popover` actions menu (RowActionsMenu vocabulary),
  identical on detail / list / board. Order: `Edit details` · `Copy link` · _—
  separator —_ · `Archive` · `Delete…`. **Delete is the only danger-coloured
  row**; its trailing `…` signals a confirm step follows (it never deletes on
  click), and the separator + colour make Archive and Delete impossible to
  confuse.
- **Permission-gated, Jira-faithfully.** `Delete` needs the project
  `canDelete` permission (Jira's "Delete Issues" project permission,
  project-admin by default); `Archive` needs `canEdit`. A user without a
  permission **doesn't see that row at all** — the action is _hidden, never
  shown-disabled_ (the mirror's behaviour) — so the gated viewer's menu in
  panel 1 collapses to just `Copy link`.

### The confirm dialog (panels 2–3)

- A real `role="alertdialog"` (the shipped `Modal` chrome — `--radius-modal` /
  `--shadow-modal`) with `aria-labelledby`/`aria-describedby`. **Cancel takes
  default focus**, and `Esc` / the ✕ both cancel — the safe default for a
  destructive dialog.
- **Cascade case (panel 2):** the body warns it permanently deletes the named
  item "and everything beneath it. **This can't be undone.**" A `dep-list`
  (the 5.3.6 grammar) names the consequences: the **descendant count with a
  per-kind breakdown** ("7 descendants will also be deleted — 5 subtasks, 1
  task, 1 bug"), that comments/attachments/history on all N items go too, and
  that inbound links are removed. The destructive button states the
  magnitude — **"Delete 8 items"** = `1 + descendants` — so the count is on the
  button you press, not just in the prose.
- **Leaf case (panel 3):** the cascade row drops out, the copy reads "It has no
  child items.", and the button reads **"Delete work item"** (no magnitude). The
  irreversibility warning, the comments/history note, and the Archive
  alternative stay.
- **Archive as the reversible alternative** lives _inside_ the same dialog: a
  mint callout ("Just want it out of the way? **Archive** hides this item but
  keeps it and its history…") with an `Archive instead` link — the one-click
  safe exit, so a user who opened Delete by reflex can still down-shift to the
  recoverable action without dismissing and re-finding the menu.

### States (panel 4)

- **In-flight:** the dialog is `aria-busy`, both buttons disabled, the danger
  button shows a spinner + `Deleting…` — so a slow cascade can't be
  double-fired.
- **Error:** a `role="alert"` rose callout states the delete is **atomic** — it
  either fully cascades or changes nothing — so a failed attempt leaves the
  subtree intact ("Nothing was changed — the item and its descendants are
  intact."); the danger button becomes `Try again`.

### Copy strings

Menu: `Edit details` · `Copy link` · `Archive` · `Delete…` · |
Dialog title: `Delete this work item?` · |
Cascade body: `This permanently deletes [KEY] “[title]” and everything beneath it. This can't be undone.` · |
Leaf body: `This permanently deletes [KEY] “[title]”. It has no child items. This can't be undone.` · |
Cascade rows: `N descendants will also be deleted — [kind breakdown].` · `All comments, attachments, and activity history on these N items go with them.` · `Links from other items (blocks, relates to, duplicates) are removed.` · |
Leaf row: `Its comments, attachments, and activity history are deleted too.` · |
Archive callout: `Just want it out of the way? Archive hides this item but keeps it and its history — and leaves its descendants live. You can restore it later.` · `Archive instead` · |
Buttons: `Cancel` · `Delete N items` / `Delete work item` · `Deleting…` · `Try again` · |
Error: `Couldn't delete this item. Nothing was changed — the item and its descendants are intact. Check your connection and try again.`

All copy goes in the issues i18n namespace (the locale set the app ships).

### Tokens / a11y

- Colour only via Tier-3 `--el-*`: the danger menu row + the destructive button
  use `--el-danger` (`--el-danger-text` on the fill); the cascade `dep-list`
  glyphs use `--el-warning`; the **archive callout** uses `--el-tint-mint` +
  `--el-success` (the safe/recoverable cue, a deliberate green contrast to the
  red delete). **Tier 0 has no red tint**, so the error callout uses
  `--el-tint-rose` background + a `--el-danger` border/icon with
  `--el-text-strong` body — the design system's honest danger surface, **no new
  Tier-0 colour**. No page-level tint.
- Shape via element-semantic tokens only (`--radius-modal/card/control/badge`,
  `--spacing-card-padding`/`-control-*`/`-chip-*`, `--height-btn-md`,
  `--shadow-modal/elevated/subtle`) — every surface reshapes under
  `data-display-style`.
- **No new primitive** — the menu is `Popover`, the dialog is `Modal`, the
  buttons are `Button` (`danger` / `secondary` variants), the dep-list + callout
  reuse the 5.3.6 grammars.
- A11y: `role="alertdialog"` + labelled/described; **every consequence is in
  words, never colour alone** (the count, the irreversibility, the atomicity);
  Cancel is default focus, `Esc`/✕ cancel; in-flight is `aria-busy` + disabled;
  the error is `role="alert"`. Light + dark parity via the token flip (toggle in
  the mock).

### Out of scope (documented extension slots)

- **The cascade COUNT backend** — the subtree count + per-kind breakdown the
  dialog reads before opening (2.8.x service), and the **atomic cascade
  delete** transaction itself (2.8.x); this asset only specifies the UX they
  feed.
- **Bulk delete** from a list/board multi-select — the single-item flow ships;
  multi-select bulk delete (with an aggregated count) is a later list-surface
  extension.
- **Restore / trash bin** — delete is permanent by design; an undo window or a
  recycle bin is NOT in 2.8 (archive is the recoverable path). If ever wanted,
  it is its own story.
- **Type-to-confirm** for very large cascades — deliberately omitted to match
  the mirror (Jira asks no typed confirmation for a normal issue); revisit only
  with a concrete use case (the justified-deviation rule).
- **Audit/event emission** on delete (who deleted what) — an activity/audit
  concern owned by the revisions/activity surface, not this dialog.

### Primitives composed (no hand-rolling)

- **Entry menus** → `Popover` actions menu (RowActionsMenu vocabulary).
- **Confirm dialog** → the shipped `Modal` (`role="alertdialog"`).
- **Buttons** → `Button` (`danger` for delete, `secondary` for cancel, the
  `loading` spinner state for in-flight).
- **Cascade dep-list + archive/error callouts** → the 5.3.6
  delete-with-count + note-line grammars (`saved-filters.mock.html`).
- If a genuinely new primitive is ever needed, that is a NEW `design/` subtask
  — not a 2.8.4 code workaround.

## Archived work items view + Restore UX (Story 2.9 · 2.9.1 → 2.9.3)

`archived.mock.html` is the design asset for the **archived work items view** —
the durable surface that replaces the transient **Undo** toast in
`WorkItemActionsMenu.tsx` (commented there as "the only restore path until an
archived-items view ships"). It is the design gate for the code subtask
**2.9.3**. Built from the live `--el-*` tokens + the shipped primitives the
active list already uses (`list.mock.html`), so 2.9.3 composes the same
vocabulary with no Pencil→code gap and **no new primitive**. Mirror product:
Jira's dedicated **Archived issues** view with per-item Restore.

### Placement — a dedicated `/items/archived` route (rung-1 decision)

**Decision: a dedicated route `/items/archived`, reachable from the work-items
navigator toolbar via a low-prominence `[Archived]` ghost link** (panel 5). The
three options the card named were a dedicated route, a navigator filter/segment,
or a project-settings page.

- **Rung 1 (Jira) says "dedicated view," and we keep that** — Jira surfaces
  archived work in its own view, not as a navigator sort/segment.
- **Justified deviation on _location_:** Jira's archived view is admin-gated
  under settings because Jira's archive is an **admin bulk operation**. Motir's
  archive is the opposite — an **editor-level, reversible, per-item action**
  surfaced right in the work-item `⋯` menu (`assertCanEdit`,
  `workItemsService.archiveWorkItem`, the single-node "Linear shape"). So the
  restore surface belongs **next to the work** (under the work navigator), not
  behind project admin. One concrete reason earns the deviation: the user who
  archived an item from its `⋯` menu is the one who restores it, and they live in
  the navigator, not in settings.
- **A navigator SEGMENT was rejected** ("no complexity for nothing"): every
  navigator read filters `archivedAt IS NULL` (`workItemRepository` forest CTE +
  every flat/count arm), and the navigator's sort, Tree view, inline-edit,
  advanced + saved filters are all built around **live** items. Bolting an
  "archived" mode onto `/items` would fork all of those paths for a rarely-used
  read. A dedicated **flat** route keeps the archived surface simple and leaves
  the live navigator untouched.

**Entry point (panel 5):** a quiet `[Archived]` ghost link (lucide `archive`)
is added to the `/items` toolbar **before** `[Filter]`, with a small count
badge so a user knows there's something there without opening it. It links to
`/items/archived`; the archived page carries a `← Work items` back link
(`--el-link`) home. This is the one change 2.9.3 makes to the live navigator
toolbar (`IssueListToolbar`).

### Anatomy — a flat, paginated list (NOT a tree)

Motir's archive is single-node (children stay live — the deliberate Linear
shape, `workItemsService.ts:1469`), so archived items do **not** form a tree.
The view is therefore a **flat, server-paged list**, reusing the active List's
container chrome (`rounded-(--radius-card)` bordered box, `--el-surface-soft`
header) and `IssueListPager` footer verbatim. The columns are a focused subset
of the active list plus the two archive-specific facts:

| Column      | Width (px) | Cell                                                 | Source                                    |
| ----------- | ---------- | ---------------------------------------------------- | ----------------------------------------- |
| Title       | `1fr`      | `IssueTypeIcon` (type hue) · mono identifier · title | the item (reused row vocabulary)          |
| Status      | 130        | `Pill` by lifecycle category (`STATUS_TONE`)         | the item's last status (kept on archive)  |
| Archived by | 175        | initial-letter `Avatar` · name                       | the **`archived` revision** `changedById` |
| Archived    | 140        | formatted date                                       | the **`archived` revision** `createdAt`   |
| _(actions)_ | 120 (end)  | per-row `[Restore]` button — **canEdit only**        | —                                         |

Grid template: `minmax(0,1fr) 130px 175px 140px 120px`. **No** Priority /
Assignee / Reporter / Due / Est. columns — the archived view answers "what did
we archive, by whom, when, and can I get it back," so it keeps the row identity

- archive provenance and drops the planning columns ("no complexity for
  nothing"). The whole row (minus the action cell) links to `/items/[key]`
  so the item is still reachable; the `[Restore]` button is a sibling control
  outside the link (it doesn't navigate).

**Default order = most-recently-archived first** (`archived.createdAt` desc) —
the freshest mistake to undo sits on top. (Headers are static here, not
sortable; sortable columns are an Epic-6 saved-views concern, like the active
list.)

**Reading "Archived by / at" — the data note for 2.9.3.** `archiveWorkItem`
records an `'archived'` revision (`workItemRevisionsService.recordRevision`,
diff `{ archivedAt: { from: null, to } }`) with `changedById`. The view reads
**that revision** for the actor + timestamp (the `workItem.archivedAt` column
gives the timestamp but not the actor). A re-archived item may have several
`'archived'` revisions — use the **latest** one.

### Restore — an inline action with a success toast

Restore is **reversible** (re-archive the item from its `⋯` menu), so it is an
**inline per-row action with a success toast** — NOT a confirm dialog, and
**without an Undo button** (unlike the archive toast, whose Undo IS the restore;
restoring needs no undo because re-archiving is the inverse).

- **Affordance:** a small **secondary `Button`** (`size="sm"`, lucide
  `rotate-ccw` + "Restore"), right-aligned in the actions cell. `aria-label`
  "Restore {key}".
- **In flight (panel 1):** clicking it POSTs `unarchiveWorkItem`; the row fades
  - locks optimistically (`opacity` + `pointer-events:none`, `aria-busy`), the
    button reads "Restoring…" disabled. The list is a **client island**, so on the
    200 the row is **removed locally** (the page-state-after-mutation contract —
    not a `router.refresh()`); the pager count decrements. The E2E waits on the
    unarchive **200** before asserting the row is gone (the authoritative-signal
    rule).
- **Confirmation:** the shipped success **`Toast`** — `{key} restored` (the
  existing `workItemActions.restoredToast` string, reused verbatim) with a
  `--el-success` `CircleCheck`. No action button on this toast.
- **Error:** reuse `workItemActions.archiveErrorTitle` / `archiveErrorBody`
  ("Couldn't archive" → here a generic restore failure) as an error `Toast`; the
  row un-fades and stays (nothing changed server-side).

### Access — view vs. restore

Two distinct gates, matching the shipped service:

- **View the page = `canBrowse`.** Anyone who can browse the project may open
  `/items/archived` and audit what was archived (mirrors the `/items`
  navigator's `canBrowse` gate, `projectAccessService.getSavedFilterCapabilities`).
  A non-browsable project renders the `NoAccessState` (same as `/items`).
- **Restore = `canEdit`.** `unarchiveWorkItem` is `assertCanEdit`-gated (same as
  archive). A viewer who can browse but **not** edit sees the list with the
  **Restore column dropped entirely** (panel 4) — hidden, never shown-disabled,
  mirroring `WorkItemActionsMenu`'s hidden-not-disabled capability pattern. The
  grid drops to `minmax(0,1fr) 130px 175px 140px` (the `.view-only` modifier).

### Empty + loading

- **Empty (panel 2)** — the shipped `EmptyState` Card with an `Archive` glyph:
  **"Nothing archived"** / "Archived work items show up here. Archive one from
  its ⋯ menu to hide it from boards and lists while keeping its history." +
  a secondary **"Back to work items"** button (there is nothing to restore here,
  so the action routes home, not to "New").
- **Loading (panel 3)** — the flat shimmer skeleton (same columns), including a
  Restore-button placeholder in the actions cell. No layout shift on settle.

### Pagination — reuses IssueListPager (finding #57)

The archived list **must not load every row** (a long-lived project accretes
archived items): it is **server-paged** like the active List, **page size 50**,
reusing `IssueListPager` verbatim — `Showing 1–50 of N` (N = total archived
count) + Prev/numbered/Next with ellipsis truncation, the current page the accent
chip + `aria-current="page"`, URL-driven `?page=`. The repository read is a NEW
arm filtering **`archivedAt IS NOT NULL`** (every existing arm filters
`IS NULL`) — flagged for 2.9.3 as the one new data path.

### Tokens / a11y

- Colour only via `--el-*`: status via `Pill` tones, type icons via `--el-type-*`,
  the success toast via `--el-success`, the restore button + back link via
  `--el-link` / `--el-border`. No Tier-0 `--color-*`.
- Shape via element-semantic tokens (`--radius-card` / `--radius-control` /
  `--radius-btn` / `--radius-badge`, `--spacing-control-*`, `--height-control`,
  `--shadow-elevated` / `--shadow-card`) so the surface re-shapes under
  `data-display-style`.
- The list is `role="table"` with `columnheader`s; the Restore button is a real
  `<button>` with a per-item `aria-label`; the in-flight row carries `aria-busy`;
  the toast is `role="status"`. The page is in scope for the strict shell-a11y
  sweep. Toggle dark in the mock to confirm token parity.

### States in the mockup

Panels: **(0)** the archived view in the `/items/archived` shell (back link +
header + flat table + pager) · **(1)** Restore in flight (the row faded/locked +
the "{key} restored" success toast) · **(2)** empty state · **(3)** flat loading
skeleton · **(4)** the view-only state (canBrowse, not canEdit — Restore column
dropped) · **(5)** the navigator entry point (the `[Archived]` toolbar link on
`/items`).

### Out of scope (documented extension slots)

**Bulk Restore** (multi-select + a bulk action bar) — Jira has it, but Motir's
archive is per-item from the `⋯` menu today, so single-row Restore matches the
current archive shape; bulk select is an Epic-6 list-actions concern, noted not
built. **Sortable / configurable columns** and a **search/filter within
archived** are also out of scope for 2.9.3. **Permanent delete from the archived
view** was out of scope for 2.9.3 — it is now designed in **2.9.7** (the next
section) and built by **2.9.5**.

## Delete affordance in the archived view + archived-item delete-confirm (Story 2.9 · 2.9.7)

2.9.7 is the design gate for **2.9.5** (MOTIR-994 — deleting an archived work
item). It EXTENDS two existing assets rather than adding a new surface:
`archived.mock.html` gains the **Delete affordance** (panels 6–8), and
`delete-confirm.mock.html` gains the **archived-item confirm variant** with the
live-descendant warning (panels 6–7). **No new primitive, no new modal** — the
confirm is the shipped `DeleteWorkItemDialog` (2.8.4) with one added warning row.

### Where Delete sits — Restore inline, Delete in the row `⋯` (the decision)

The archived list row already has a primary inline **`[Restore]`** button
(canEdit, 2.9.3). 2.9.7 adds **permanent Delete** beside it as a single danger
**`Delete…`** row inside a per-row **`⋯` overflow menu** (the shipped Popover
`RowActionsMenu` vocabulary — the same menu the live list/board rows and the 2.8
delete mock use; there `Archive→Restore` is the only swap).

- **Why Restore stays the inline button and Delete goes in the `⋯`** (not both in
  one menu, not a bare trash icon): the archived view's whole job is _getting
  things back_, so Restore is the common, safe, reversible primary action and
  must stay one click away — demoting it behind a menu to make room for Delete
  would slow the dominant path. Delete is the opposite — rare, irreversible,
  higher-privilege — so it belongs one level deep, danger-toned, with a trailing
  `…` that signals a confirm follows. A bare red trash icon-button was rejected
  (misclick risk + breaks the established `⋯ → Delete…` vocabulary). This refines
  the card's "⋯ carrying Restore + Delete…" example: Restore is prominent inline,
  the `⋯` is purely the canManage/Delete affordance, so the menu maps 1:1 to a
  capability. (Mirror, rung 1: Jira's archived view keeps Restore prominent and
  puts destructive/admin actions in an overflow; Linear's archived view is the
  same shape.)

### The gate split (independent capabilities) — panel 7

Restore = **`canEdit`**, Delete = **`canManage`** — the SHIPPED capability
(`projectAccessService.getCapabilities → { canBrowse, canEdit, canManage }`;
`workItemsService.deleteWorkItem`/`getDeletePreview` both call `assertCanManage`,
`workItemsService.ts:1569`/`:1619`). The 2.8 delete mock's `canDelete` label is
this same gate. The two are **independent**, so the actions cell is total over
all four combinations (each affordance HIDDEN — never shown-disabled — when its
gate is unmet, mirroring `WorkItemActionsMenu`):

| `canEdit` | `canManage` | Actions cell                                          |
| --------- | ----------- | ----------------------------------------------------- |
| ✓         | ✓           | `[Restore]` + `⋯`(`Delete…`)                          |
| ✓         | ✗           | `[Restore]` only (no `⋯` — no Delete to host)         |
| ✗         | ✓           | `⋯`(`Delete…`) only (no inline Restore)               |
| ✗         | ✗           | column dropped entirely (the panel-4 view-only state) |

So "a row can show Restore but not Delete" (the editor case) and its inverse both
fall out cleanly. The grid column widened **120→150px** to seat `[Restore]` + `⋯`.

### On the DETAIL page — panel 8

Delete **does** appear on an archived item's detail page, in the standard detail
`⋯` actions menu (the same `RowActionsMenu` as the live detail page, with
`Archive→Restore` swapped): **`Restore`** (canEdit) + a danger **`Delete…`**
(canManage) below the separator. **The detail BANNER and its prominent Restore
button are a SEPARATE design — 2.9.8 (→ code 2.9.6) — and are NOT specified
here**; 2.9.7 only places the Delete affordance the card asks about. 2.9.8 should
keep the banner as the prominent Restore and leave Delete in the `⋯`.

### The archived-item confirm modal — the live-descendant warning (the one new thing)

The confirm is the **shipped `DeleteWorkItemDialog`** (2.8.4) reused verbatim —
same `role="alertdialog"` Modal, same 5.3.6 count grammar (`totalCount` /
descendant count / per-kind breakdown), same atomic-failure error state, same
`deletedToast` (`{key} deleted`). There is **no Archive escape hatch** in this
variant (the item is already archived), so that mint callout is omitted.

The ONE new element is the **live-descendant warning**. Motir's archive is
**single-node** (`workItemsService.ts:1469` — archiving a parent never archives
its children), so an archived parent can still own **non-archived, LIVE**
descendants on the active boards/lists. `deleteWorkItem` cascades the **whole
subtree** (`:1560`, `findSubtree`), so deleting the archived parent permanently
destroys those live items too — surprising, because the parent was "tucked away."

- **Panel 6 — archived parent WITH live descendants.** A distinct **peach/amber
  caution callout** (`--el-tint-peach` bg + `--el-warning` border/icon +
  `--el-text-strong`, lucide `triangle-alert`) sits directly under the body,
  ABOVE the normal cascade `dep-list`. Headline **"Some of what's beneath this
  isn't archived."** + body **"Deleting also permanently removes N active work
  items that aren't archived — [kind breakdown]. They're still live on your
  boards and lists. (Archiving an item never archives its children.)"** The peach
  tone is deliberately a THIRD callout colour, distinct from the mint
  archive/safe callout and the rose/danger error callout and the amber dep-list
  _rows_ — so the surprise is unmistakable and never colour-only (the count is in
  words). The `dep-list` then drops its redundant "N descendants" row (the warning
  already named them) and keeps the history + links rows; the button is unchanged
  (`Delete N items`, `1 + descendants`).
- **Panel 7 — archived parent, ALL descendants archived (the contrast).** When the
  **live count is 0**, the peach warning is **suppressed** — nothing active is at
  risk — and the dialog is the ordinary cascade confirm, with a calm
  archive-glyph row: **"N descendants will also be deleted — [breakdown]. All of
  them are already archived — nothing here is live on your boards."** This boundary
  is what makes panel 6's warning meaningful.
- An archived **leaf** (no descendants) reuses the leaf dialog (2.8 panel 3)
  unchanged — no warning, "It has no child items."

**Data note for 2.9.5 (the one new data path).** `getDeletePreview`
(`workItemsService.ts:1614`) returns `{ totalCount, descendantCount, byKind }`
today but does **not** split archived vs live descendants. 2.9.5 must extend the
preview with a **live-(non-archived)-descendant count + per-kind breakdown**
(count the subtree rows where `archivedAt IS NULL`, excluding the root) to drive
the panel-6 copy; the warning shows iff that count > 0. This is the analogue of
2.8.1's "cascade-count backend" extension slot — the design specifies the UX, the
code subtask adds the count.

### Copy strings (added by 2.9.7)

Live-descendant warning headline: `Some of what's beneath this isn't archived.` ·
body: `Deleting also permanently removes N active work items that aren't archived — [kind breakdown]. They're still live on your boards and lists. (Archiving an item never archives its children.)` · |
All-archived row: `N descendants will also be deleted — [kind breakdown]. All of them are already archived — nothing here is live on your boards.` · |
Archived-row `⋯` menu: `Delete…` (danger) · |
Detail `⋯` menu (archived): `Restore` · `Delete…` · |
(Restore button / `{key} restored` / `{key} deleted` toasts are existing 2.9.3 /
2.8.4 strings, reused.) All copy in the issues / `workItemActions` i18n namespace.

### Tokens / a11y

- Colour only via Tier-3 `--el-*`: the `⋯` overflow + its `Delete…` row use the
  `RowActionsMenu` vocab (`--el-danger` on the danger row, `--el-tint-rose` hover);
  the new live-descendant warning uses `--el-tint-peach` + `--el-warning` (the
  warning tint, a third distinct callout tone). The gate-matrix capability chips
  put the state in the tint background with `--el-text-strong` (on) / a
  strikethrough `--el-text-faint` (off) — the state is in text + line-through,
  never colour alone. No Tier-0 `--color-*`.
- Shape via element-semantic tokens (`--radius-card`/`-control`/`-badge`,
  `--spacing-control-*`, `--height-control`, `--shadow-elevated`/`-modal`) so the
  surfaces reshape under `data-display-style`.
- A11y: the `⋯` is a real `<button>` with a per-row `aria-label` +
  `aria-haspopup="menu"`; the menu is `role="menu"` with `role="menuitem"` rows;
  the confirm stays `role="alertdialog"` (Cancel default focus, `Esc`/✕ cancel);
  the live-descendant warning is a `role="note"` whose consequence is stated in
  words. Light + dark parity via the token flip (toggle in both mocks).

### Out of scope (documented extension slots)

- **Bulk delete** from the archived view (multi-select + an aggregated count) —
  same Epic-6 list-actions concern as bulk Restore; single-row Delete ships now.
- **A per-descendant archived/live breakdown table** in the confirm — the warning
  names the live COUNT + kind breakdown, not a row-by-row list (matches the 2.8
  cascade grammar, which never itemised descendants either).

## Archived banner on the detail page (Story 2.9 · 2.9.8 → 2.9.6)

`detail-archived.mock.html` is the design asset for the **archived banner on the
work-item detail page** — the design gate for the code subtask **2.9.6
(MOTIR-995)**. The 2.9 list view (above) answers "what did we archive, by whom,
when, and can I get it back" from the dedicated `/items/archived` route; this
banner answers the complementary question on the **item's own detail page**: a
viewer who opens an archived item directly (a bookmarked link, a link from
activity / a comment, a board peek) must immediately see that it is archived and
be able to restore it.

### Reachability — the precondition that makes this banner real (verified)

An archived item's detail page **renders** — it is NOT a 404. The detail read
`workItemsService.getIssueDetail` → `workItemRepository.findByIdentifier` is a
plain `findUnique` on `(projectId, identifier)` and does **NOT** filter
`archivedAt` (unlike the navigator forest CTE / list / children / sprint reads,
which all filter `archivedAt IS NULL`). So the item is fully reachable and
readable on its detail route; the banner is the page's archived-state signal, not
dead UI. (Verified against shipped code at plan/design time — rung 2.)

### Placement — top of the main column, above Description (a NEW slot)

The banner is the **FIRST element of the detail page's main column, directly
above the Description card** (`<main>` in `app/(authed)/items/[key]/page.tsx`).
A whole-item state announcement belongs at the top of the page body, before the
content, where it's the first thing a reader sees — matching how Jira / Linear
surface an archived/closed banner.

> **⚠️ Placement reconciliation — flagged for 2.9.6 (rung 2 over the card's
> prose).** The subtask card asked to "reuse the SHIPPED readiness-banner
> PLACEMENT (`page.tsx` ~L317, full-width, top of main column)". Shipped reality
> differs: on the **detail page** the `ReadinessBadge` renders **inside
> `RelationshipsPanel`** (the 2.4.5 relationships section at ~L317, AFTER
> Description + Explanation), **not** as a standalone top-of-column banner.
> "Top of main column" is true of the **peek modal** (`quick-view`, 2.5.20),
> where the readiness banner IS panel-2's first main-column element — the card
> conflated the two surfaces. So this design **reuses the readiness banner's
> VISUAL MOLD** (`ReadinessBadge`: full-width, lead glyph + bold title +
> secondary line) but introduces a **new slot** at the very top of `<main>`. The
> code subtask (2.9.6) **adds a new top-of-`<main>` element**; it does NOT modify
> the in-panel `ReadinessBadge`. (The readiness badge and the archived banner can
> coexist — an archived item can still be blocked — but in practice the readiness
> badge is suppressed once an item isn't todo-category, so they rarely stack.)

A secondary, always-visible **"Archived" chip** also sits in the header eyebrow,
**following the breadcrumb**, so the archived state is legible even when the page
is scrolled past the banner — the same role the `(archived)` mark plays in the
field pickers.

> **⚠️ Eyebrow has NO status Pill — reconciled with 2.4.13 (MOTIR-996).** The
> shipped eyebrow used to render a `<Pill tone="neutral">{item.status}</Pill>`
> beside the breadcrumb, but **subtask 2.4.13 removes it** (it was a redundant,
> untinted duplicate of the rail's `StatusPicker` status —
> `app/(authed)/items/[key]/page.tsx:246`). So the "Archived" chip is **NOT**
> placed beside a status Pill (there is none); it follows the breadcrumb directly
> and is the **only** eyebrow tag. This is deliberately consistent with 2.4.13's
> intent — the chip carries a **real, non-duplicated** state (archived is shown
> nowhere else in the eyebrow), unlike the redundant status tag 2.4.13 deletes,
> so it does not reintroduce the clutter that subtask removes. Canonical status
> stays rail-only (`CoreFieldsPanel`).

### Tone — neutral / muted, NOT a colored alert and NOT danger

Archived is a **calm, factual, reversible** state — not an error, not a warning,
not danger. So the banner does **NOT** reuse the readiness tints (mint
`--el-tint-mint` ready / peach `--el-tint-peach` blocked, which carry semantic
urgency) and **NEVER** `--el-danger`. Instead:

| Element        | Token                                                                       | Role                                              |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| Banner fill    | `--el-surface-soft`                                                         | a quiet, recessive callout — distinct from a tint |
| Banner border  | `--el-border` (1px hairline)                                                | defines the box on the page surface               |
| Banner radius  | `--radius-card`                                                             | same family as the readiness banner               |
| Lead glyph     | lucide **`archive`** in `--el-text-muted`                                   | the same glyph the `⋯` menu + 2.9 list view use   |
| Headline       | `--el-text-strong`                                                          | AA-safe emphasis                                  |
| Meta line      | `--el-text-secondary`; actor in `--el-text-strong`                          | archived-by / at + the explanatory tail           |
| Eyebrow chip   | `Pill` mold, `--el-surface` + `--el-border`, glyph `--el-text-muted`        | neutral, not a colored `Pill` tone                |
| Restore button | secondary `Button`, `--el-border` + `--radius-btn`; glyph `--el-text-muted` | the lightweight reversible action                 |

State is conveyed by **text + glyph, never colour alone** (the banner reads as
archived from its copy + the archive glyph, so it's AA-safe and colour-blind-safe
even though it carries no hue). Colour flows only through `--el-*`; shape only
through the element-semantic shape tokens — so the banner re-skins under
`data-palette` and re-shapes under `data-display-style`. The chip reuses the
**`BuildingInPublicBadge` mold** (a `Pill` with a lead glyph) but in the neutral
register rather than a build-tinted one.

### Copy

- **Headline:** **"This work item is archived"**.
- **Meta line (canEdit):** **"Archived by {name} · {date} · It's hidden from
  boards and lists but kept with its history. Restore it to bring it back."** The
  "Restore it to bring it back" tail is dropped in the view-only variant (that
  viewer can't restore).
- **Eyebrow chip:** **"Archived"** (with the `archive` glyph).
- **Restore button:** **"Restore"** (lucide `rotate-ccw`), `aria-label`
  **"Restore {key}"** — the same affordance + verb as the 2.9 list view's per-row
  Restore, so the two surfaces share one vocabulary.

### Archived-by / archived-at — the data note for 2.9.6

Same source as the 2.9.3 list view: the **latest `'archived'` revision**
(`workItemRevisionsService.recordRevision`, diff `{ archivedAt: { from: null, to } }`)
gives the **actor** (`changedById`) and the **timestamp** (`createdAt`). The
`workItem.archivedAt` column gives the timestamp but not the actor, so the actor
must come from the revision. A re-archived item has several `'archived'`
revisions — use the **most recent**. The current detail DTO (`getIssueDetail`)
returns `item.archivedAt` but **not** the archived-by actor; surfacing the actor

- formatted timestamp on the detail page is the one new data path 2.9.6 adds (read
  the latest `'archived'` revision for this item) — flagged here so the code subtask
  plans it, exactly as 2.9.3 flagged the `archivedAt IS NOT NULL` list arm.

### Restore — the action, and its gating

- **Affordance:** a secondary `Button` (`size="sm"`, lucide `rotate-ccw` +
  "Restore"), right-aligned in the banner. It POSTs `unarchiveWorkItem`
  (`DELETE /api/work-items/[id]/archive`), the same call the 2.9 list view's
  Restore uses.
- **Page-state after restore (the page-state-after-mutation contract):** the
  detail page is **server-rendered**, so on the unarchive 200 the page does a
  **`router.refresh()`** — the server re-reads the item (now `archivedAt: null`),
  the banner + eyebrow chip disappear, and the page returns to its active form. A
  success **`Toast`** confirms — reuse the existing `workItemActions.restoredToast`
  **"{key} restored"** string (verbatim, the same toast the list view shows), no
  action button. On error reuse the existing archive-error toast strings; the
  banner stays. (E2E: arm `waitForResponse` on the unarchive DELETE → 200 BEFORE
  asserting the banner is gone — the authoritative-signal rule.)
- **Gating — `canEdit`.** `unarchiveWorkItem` is `assertCanEdit`-gated (same as
  archive). A viewer who can browse but **not** edit sees the banner **without the
  Restore button** — hidden, never shown-disabled (the `WorkItemActionsMenu`
  hidden-not-disabled capability pattern, mirroring the 2.9 list view's dropped
  Restore column). The same `canEdit` the detail page already computes for inline
  edit / the `⋯` menu gates the button.
- **Restore is the banner's ONLY action — Delete lives in the detail `⋯` menu
  (per 2.9.7).** The sibling design **2.9.7** (the section above) places permanent
  **`Delete…`** (canManage) on an archived item's detail page in the standard
  `⋯` actions menu (`Restore` + `Delete…` below the separator), and explicitly
  scopes the banner to "the prominent Restore" only. This design honours that
  split: the banner carries the common, safe, reversible Restore one click away;
  the rare, irreversible, higher-privilege Delete stays one level deep in the
  `⋯`, danger-toned. The banner does **not** add a Delete affordance.

### Read-only posture — DECISION: stays fully editable, banner is the only signal

**Decision:** an archived item's detail page stays **fully functional and
editable** — inline field controls are **NOT** dimmed or disabled; the banner
(plus the eyebrow chip) is the **only** signal. There is no global read-lock.

**Rationale:**

- Motir's archive is a **reversible, single-node, editor-level** action (the
  deliberate "Linear shape" — `workItemsService.archiveWorkItem`,
  `workItemsService.ts:1469`), undoable in one click. A whole-page read-lock is a
  heavy lifecycle gesture that doesn't match a soft, restorable hide.
- A global disable would force **every inline editor on the page** (status,
  assignee, priority, due, estimate, title, description, relationships, custom
  fields, labels, comments…) to grow and maintain an "archived-disabled" state —
  real, spreading complexity for a state the user reverses instantly. "No
  complexity for nothing."
- Editing an archived item before restoring it is occasionally legitimate (fix a
  title or re-point a link, then restore).
- **Justified deviation from the mirror (Jira):** Jira makes archived issues
  read-until-restored — but Jira's archive is a **heavier admin bulk lifecycle**,
  whereas Motir's is the lightweight reversible per-item editor action, so the
  read-lock rationale doesn't transfer. The deviation is recorded with its reason
  (the rung-1 justified-deviation rule).
- **Documented future option:** if a real need emerges (e.g. archived items must
  freeze for audit/compliance, or to prevent edit-then-forget-to-restore churn), a
  read-until-restored posture can be added later — dim the inline controls + route
  edits through "Restore to edit". Not built now; noted so the decision is
  revisitable, not silently foreclosed.

### Active contrast

An **active** (non-archived) item shows **no banner and no "Archived" chip** —
the eyebrow is just type · key · breadcrumb · actions (no status Pill either,
post-2.4.13), and the main column opens with the Description card as it does
today. The banner + chip render **iff** `item.archivedAt != null`. (Mock panel 2
draws the active state for the side-by-side contrast.)

### a11y

- The banner is a `role="status"` region (a state announcement, not an alert —
  archived is not urgent), so a screen reader surfaces it without interrupting.
  The archive glyph is `aria-hidden` (the headline carries the meaning); the
  Restore button is a real `<button>` with `aria-label="Restore {key}"`.
- AA contrast holds: `--el-text-strong` headline + `--el-text-secondary` meta on
  the `--el-surface-soft` fill; no hue carries meaning, so it's colour-blind-safe.
  The page is in scope for the strict shell-a11y axe sweep; toggle dark in the
  mock to confirm token parity.

### States in the mockup

Panels: **(0)** PLACEMENT — the archived detail page (header + the banner atop the
main column, above Description + the 2-col body) · **(1)** the banner isolated +
annotated (tone, glyph, copy, archived-by/at, Restore) · **(2)** ACTIVE contrast —
the same detail header with no chip and no banner (Description is first) · **(3)**
VIEW-ONLY (`canBrowse`, not `canEdit`) — the banner WITHOUT the Restore button.

### Out of scope (documented extension slots)

The **read-until-restored** posture (above — deferred with its trigger). **Bulk**
archive/restore from the detail page (archive is per-item). A **re-archive** action
in the banner (re-archiving lives in the `⋯` menu, unchanged — the banner only
restores). These are noted, not built.

## Sprint on the work-item detail — rail field + "Add to active sprint" (Story 2.4 · 2.4.15 → 2.4.14)

`sprint-field.mock.html` (→ `sprint-field.png`) is the design for **sprint
membership on the work-item detail**: a **Sprint** inline-edit FieldCard on the
core-fields rail, and an **"Add to active sprint"** quick action in the shared
`⋯` actions menu. It gates code subtask **2.4.14 (MOTIR-1003)**, which carries
2.4.15 in `dependsOn` (`is_blocked_by`).

**Why this is a design subtask (the design gate, mistake #31).** Both additions
land on ALREADY-designed surfaces that do not include them, so each is an
undesigned element — not mere grammar reuse:

- `detail.pen`'s core-fields rail draws Status · Type · Work type · Executor ·
  Priority · Assignee · Reporter · Parent · (Labels · Components) · Due · Story
  points · Estimate — there is **no Sprint field**. This is exactly the case
  **custom fields** hit (5.3.5 → 5.3.7): they reused `FieldCard` + `Combobox`
  verbatim and STILL needed a design asset because placement / value rendering /
  the picker sentinel were unspecified. Sprint is the same shape.
- `delete-confirm.mock.html` fixes the `⋯` `WorkItemActionsMenu` item set
  (Edit details · Copy link · — · Archive · Delete…) with no sprint action, and
  pins a hard law: permission-gated rows are **hidden, "never shown-disabled."**
  The card asks for a row "greyed out + tooltip when there is no active sprint"
  — which contradicts that law and must be resolved by design.

**Mirror (rung 1) = Jira.** Jira's Details panel carries Sprint directly above
the Story-point estimate; Jira/Linear **disable-and-explain** context actions
that are not currently applicable and reserve **removal** for permission — the
basis for the state-gate decision below.

### The Sprint FieldCard (panels 0–1)

- **Placement** — inserts **between Due date and Story points** (cluster: Due ·
  **Sprint** · Story points · Estimate), pairing Sprint with the agile estimate
  (Jira's ordering). It is `CoreFieldsPanel.tsx`'s `FieldCard` verbatim — Card
  (`--radius-card`, `--shadow-card`, `--el-border`, px-3.5/py-2.5) · uppercase
  11px `--el-text-secondary` label · corner chevron `<button>` (rotates 180° in
  edit mode) · value line mt-1.5/14px. **No new chrome.** Built-ins never
  reorder; Sprint is new, so existing relative order is preserved.
- **Visibility** — shown for sprintable kinds. For **epics** (which span sprints
  in Jira and are never assigned to one) the recommendation is to **hide** the
  card; 2.4.14 confirms against the data model (whether `epic.sprintId` is
  permitted). Drawn here for a story.
- **Value line** — in a sprint: 16px `--el-text-secondary` **Goal** glyph (lucide
  `goal`, the Due/Estimate glyph grammar) + the sprint **name** plain
  ("Sprint 7"). No sprint (`sprintId` null) is **status-dependent** (the backlog
  excludes `category === 'done'` items — `backlogService.backlogExcludedStatusKeys`):
  an **active** item (category `todo`/`in_progress`) shows muted-italic
  **"Backlog"** in `--el-text-secondary` (backlog is its real home — NOT the
  generic "None"); a **done/cancelled** item shows muted-italic **"None"** (the
  Parent card's empty convention) — it is excluded from the backlog, so calling it
  "Backlog" would contradict where it actually sits. A current value whose
  sprint is **completed** stays shown with a muted `(completed)` mark in
  `--el-text-muted` (the archived-option precedent) — never colour alone.
- **Editor** — the AssigneePicker-shaped **`Combobox`** (`components/ui/Combobox`,
  `autoOpen`): trigger (`--height-control`, `--radius-input`, up/down glyph),
  menu (`--shadow-elevated`, `--radius-card`). Rows:
  - **First row = the null sentinel** (muted italic) — the clear / move-home
    path, matching the filter's `sprint-select` **Backlog-first** precedent (a
    meaningful sentinel). Its label is **status-aware and mirrors the read-mode
    value**: "Backlog" for an ACTIVE item, "None" for a DONE/cancelled one (which
    is excluded from the backlog) — the picker value never disagrees with the
    displayed value.
  - the **Active** sprint (secondary "Active"), then **Planned**/future sprints
    (secondary "Planned"); the selected row carries the `Check` in `--el-accent`.
  - **Completed** sprints are **excluded** from the menu (you do not schedule into
    a closed sprint); a current completed value still renders in the trigger with
    the `(completed)` mark.
  - **Searchable at ≥8 sprints** (the Combobox `searchable` rule) — the search row
    (`--el-border`, `--radius-input`, `search` glyph) appears; smaller sets open
    straight to the list.
- **Page-state (for 2.4.14)** — changing the sprint is an inline edit: keep the
  optimistic value, **no `router.refresh()`** of the cell (the
  inline-edit-no-tree-refresh rule). The assign goes through
  `backlogService.assignToSprint` (the 4.2 / `move_to_sprint` path), which also
  ranks the item at the sprint tail; the field waits on that response.

### "Add to active sprint" in the `⋯` menu (panels 2–3)

- **Access path** — the shared `⋯` `WorkItemActionsMenu` on the detail header
  (drawn open over a header slice: type glyph · `PROD-N` mono · serif title ·
  the active `icon-btn`). The new row (Goal glyph) joins the **top
  non-destructive group, after "Edit details"**: **Edit details · Add to active
  sprint · Copy link** · — · Archive · Delete…. `canEdit` gates it. One click
  assigns to the project's **currently-active** sprint and confirms with the
  shipped success **Toast** ("Added PROD-N to <sprint>").
- **Disabled-vs-hidden (the conflict resolution)** — the menu's "hidden, never
  shown-disabled" law governs **capability**: `!canEdit` still **removes** the
  row entirely (panel 3, viewer). But **"no active sprint"** and **"already in
  the active sprint"** are transient **state** gates — the user HAS the
  capability, the precondition just is not met now. Hiding would flicker the row
  in/out as sprints start/complete and hide that the feature exists. So in those
  states the row is **shown disabled (opacity-50) + a `Tooltip`** naming the
  reason ("No active sprint" / "Already in the active sprint"). This is a
  **justified deviation** from the hide-law, scoped to state gates only; the
  Tooltip-on-a-disabled-row is the one new menu sub-pattern (the menu's other
  rows carry none). Tooltip = the ink bubble (`--el-text` bg, `--el-text-inverted`
  text, `--radius-control`, `--spacing-tooltip-*`).
- **Shared reach** — the row lives in the shared menu, so it appears wherever the
  menu mounts (detail header, **list rows, board cards**), like Archive/Delete —
  a surface-agnostic per-item action; quick triage into the running sprint from a
  row/card is the use case.

### Tokens + primitives

Colour via `--el-*` only (no Tier-0): `--el-text` / `--el-text-secondary` /
`--el-text-muted` ink, `--el-accent` for the selected `Check`, `--el-success` on
the confirmation Toast, `--el-danger` on the unchanged Delete row,
`--el-border`/`--el-border-soft` hairlines. Shape via element-semantic tokens
(`--radius-card`/`-input`/`-control`, `--shadow-card`/`-elevated`/`-subtle`,
`--height-control`, `--spacing-control-*`/`-tooltip-*`). Primitives reused
verbatim: `FieldCard`, `Combobox`, `WorkItemActionsMenu` (Popover), `Tooltip`,
`Toast`. No new chrome beyond the disabled-row Tooltip treatment.

### States in the mockup

Panels: **(0)** PLACEMENT + value — the Due · Sprint · Story-points cluster with
Sprint populated, the Backlog state, and the completed-current mark · **(1)** EDIT
— the Combobox open (Backlog sentinel · Active+Check · Planned) and the ≥8
searchable variant · **(2)** `⋯` MENU enabled — the detail header with the menu
open, the new row live, + the success Toast · **(3)** `⋯` MENU disabled — "No
active sprint" and "Already in the active sprint" (each disabled + Tooltip), and
the viewer case (row absent).

### Out of scope (documented extension slots)

**Removing** an item from a sprint other than via the Backlog sentinel (there is
no separate "remove from sprint" affordance — picking Backlog IS the remove).
**Multi-select / bulk** "add to active sprint" from the list/board (this design
is the per-item menu row; bulk lives with the backlog/board bulk tools, 4.2).
A sprint-state **badge** on the value line beyond the `(completed)` mark (kept
clean — Jira renders the sprint name plain). These are noted, not built.

---

## Work-type indicator — the `Type` column (8.8.5, gating 8.8.9)

Asset: **`work-type-indicator.mock.html`** / **`.png`**. Surfaces each leaf's work
**`type`** (the NATURE of the work — `code` / `design` / `test` / `content` /
`research` / `review` / `decision` / `deploy` / `manual` / `chore`) in the LIST
and TREE rows, via the shipped **`WorkItemTypeChip`**
(`components/issues/WorkItemTypeChip.tsx`). This is **distinct from the _kind_
icon** (`epic`/`story`/`task`/`bug`/`subtask`) already shown as the Title-cell
lead glyph — kind = WHAT the item is in the hierarchy; type = WHAT KIND OF WORK
the leaf is.

### Placement — a dedicated `Type` column (NOT inline)

Both views render from the **shared `buildIssueColumns` set**
(`app/(authed)/items/_components/issueColumns.tsx`), so the indicator is added
**ONCE** as a new `IssueColumn` and flows to both `IssueListTable` and
`IssueTreeTable` (8.8.9). It is a column, not an inline element in the Title cell,
because:

- a fixed grid track keeps the chip **aligned vertically across the tree's
  per-depth indent** (the indent eats only the Title `1fr` cell; the Type column
  stays put) — an inline chip would drift right with each indent level;
- it matches the **mirror product** (Jira's issue navigator renders Type / Labels
  as their own sortable columns), and leaves the Title cell's `[kind icon · key ·
title]` group clean;
- "add it once in `issueColumns.tsx`" (8.8.9's own framing) is most naturally a
  new column entry.

**Position:** immediately **after Title** (Title · **Type** · Priority · Assignee
· … · Status) — type qualifies the item, so it sits next to its name. Column
width ~**116px** (the longest labels, "Research" / "Decision", are 8 chars; the
chip fits without truncation).

### Null type — epics & stories

`type` is **`null` on containers** (epic / story); only leaves carry a work type.
A null-type cell renders the **muted em-dash `—`** (`text-(--el-text-muted)`) —
the shipped empty-cell convention used by the Due / Estimate cells in `list.mock.html`.
No chip, no icon: the kind icon in the Title cell already says "this is a
container," so a type chip there would be redundant. (8.8.9 must handle `null`
in the column's `cell` and ensure `IssueRowData` / the issue DTO carries `type`.)

### The chip recipe (unchanged — reused verbatim)

`WorkItemTypeChip` = the type's `--el-type-*` hue in a `color-mix()` **tint
BACKGROUND** (14%, or **18% for the near-neutral `manual` / `chore` / `decision`**
— `workItemTypeChipBackground()`), an **`--el-text-strong`** label, and the hued
**`WorkItemTypeIcon`** glyph (14px). AA holds via charcoal-on-tint (finding #35);
meaning never rides hue alone (every chip pairs icon + text label).

| Element               | token / source                                            |
| --------------------- | --------------------------------------------------------- |
| chip background       | `color-mix(var(--el-type-*) 14% \| 18%, --el-page-bg)`    |
| chip label            | `--el-text-strong`, `text-xs font-medium`                 |
| chip icon             | `WorkItemTypeIcon` — lucide glyph in `--el-type-*` (14px) |
| chip radius / padding | `--radius-badge` · `--spacing-chip-x/y`                   |
| null-type cell        | `—` in `--el-text-muted` (the empty-cell convention)      |

### Primitives composed (no hand-rolling)

| Element         | Shipped primitive                                                                             |
| --------------- | --------------------------------------------------------------------------------------------- |
| type chip       | `components/issues/WorkItemTypeChip.tsx` (+ `WorkItemTypeIcon`, `workItemTypeChipBackground`) |
| list / tree row | the shared `buildIssueColumns` set (`issueColumns.tsx`) → `IssueListTable` / `IssueTreeTable` |

No new design-system entry is invented — the chip, the icon, and the hue tokens
(`--el-type-*`, globals.css 794-803) all already ship from Story 2.7.

---

## Draft explanation with AI (Story 8.8 · 8.8.6 → 8.8.12)

The _Draft with AI_ affordance generates the optional work-item **Explanation**
(`explanationMd`, the plain-language "why this matters") instead of writing it by
hand. `draft-with-ai.mock.html` is the design asset; `draft-with-ai.png` the
export. **It is drawn against the SHIPPED components, not the legacy
`create.pen` / `detail.pen`** (the planning-time mistake this asset corrects — see
the violation note below).

### Shipped reality this design extends (verified, rung 2)

- **`app/(authed)/_components/CreateIssueModal.tsx`** — the Explanation is a
  **collapsible disclosure**: a chevron + `createIssue.explanation` ("Explanation")
  - `createIssue.explanationHint` ("— why this matters (optional)"); collapsed by
    default with `createIssue.explanationSkip` text. When open it renders
    `MarkdownEditor size="min"` **and** a secondary **"Draft with AI"** `Button`
    (`Sparkles` left-icon, `className="ml-auto"`) that **already exists** — today it
    is `disabled` with `createIssue.draftWithAiTooltip`. 8.8.6 designs the states
    that button drives once AI is connected; it does **not** invent the entry.
- **`app/(authed)/items/[key]/_components/IssueExplanation.tsx`** — the detail
  page's Explanation is a **read-only** `ContentSectionCard`: title +
  "— why this matters" gloss + (when `explanationSource === 'ai_draft'`) a
  `Pill tone="neutral"` "AI-drafted" badge + `MarkdownView` / `noExplanation`
  empty state + an **"Edit"** link. **Drafting is NOT inline here** — the comment
  is explicit: "Authoring/regenerating the prose is the create/edit forms' job;
  editing here routes to the edit form via the card's 'Edit' link."
- **`app/(authed)/items/[key]/edit/_components/EditIssueForm.tsx`** — an
  always-visible `MarkdownEditor size="full"` for the explanation, label gloss +
  (when `ai_draft`) a `Pill severity="info"`. This is the **detail-page-side
  surface** where "Draft with AI" attaches in 8.8.12.
- **Source enum** (`lib/dto/workItems.ts` + `prisma/schema.prisma`
  `WorkItemExplanationSource`): **`user_authored | ai_draft | user_edited`** —
  already three values. There is **no `ai_drafted`**; editing an AI draft becomes
  `user_edited`. (⚠️ 8.8.12's card says "add `ai_drafted` via migration" — that is
  **stale**; the value exists as `ai_draft` and `user_edited` already covers the
  post-edit case. Flagged to the planner; no enum migration is needed.)

### Workflow grounding (the design-content dependency rule)

The streamed interaction is grounded in, and the card now `relates_to`,
**8.8.11 / MOTIR-1095** — the `generate_explanation` job over `POST /v1/jobs` +
`GET /v1/jobs/:id/stream` (why the draft **streams** token-by-token; the
`MotirAiUnavailableError` / `MOTIR_AI_JOB_FAILED` taxonomy in `lib/ai/errors.ts`
behind the error state). **8.8.12 / MOTIR-1096** (code, `blocked_by` this design)
wires it through `lib/ai/motirAiClient.ts`, streams into the editor, and persists
`explanationMd` + the source on the normal save.

### States (panel by panel)

**Surface 1 — create-issue modal** (the disclosure):

1. **1A · Collapsed** — the shipped disclosure (chevron + "Explanation" + hint +
   `explanationSkip`). Context, unchanged.
2. **1B · Expanded — entry** — the disclosure header carries the existing
   secondary **Draft with AI** button (`Sparkles`, `ml-auto`) over the
   `size="min"` `MarkdownEditor` (toolbar + placeholder). Enabled when AI is
   connected.
3. **1C · Streaming** — the button becomes **Drafting… · Stop**; the editor fills
   token-by-token (SSE, 8.8.11) with a caret. Editor border goes to `--el-highlight`.
4. **1D · Drafted** — the text just stays in the editor, editable. The button is
   now **Regenerate**; an **AI-drafted** `Pill severity="info"` marks the source.
   **No confirmation gate** — it saves as `ai_draft` with **Create issue**; editing
   flips the source to `user_edited`.

**Surface 2 — detail page** (read-only card → edit form):

5. **2A · Read-only card, empty** (`IssueExplanation`) — `ContentSectionCard` +
   `noExplanation`. The **Edit** link is the access path to drafting (the card
   never drafts inline).
6. **2B · Read-only card, `ai_draft`** — the neutral **AI-drafted** `Pill` in the
   header signals the source (shipped); `MarkdownView` body; Edit → the form.
7. **2C · Edit form, entry** (`EditIssueForm`) — the `size="full"` MarkdownEditor;
   the **Draft with AI** button rides the label row (8.8.12 adds it here too).
8. **2D · Edit form, drafted** — streamed text in the editor, **Regenerate** + the
   **AI-drafted** pill; saved with the form's normal **Save changes**.

**Cross-cutting states:**

9. **3A · Cloud-gated** — self-host with no Motir AI connection (`MOTIR_AI_*`
   unset → `MotirAiConfigError`). The button is the shipped `disabled` state; the
   tooltip becomes **"Connect Motir AI to draft with AI"**. An inline `.notice`
   (`plug` glyph, `--el-tint-yellow` / `--el-warning`) offers **Connect Motir AI**
   (mirrors onboarding screen K). The MarkdownEditor stays usable — drafting is
   always optional, never a wall.
10. **3B · Stream failed** — `.notice.is-error` (`alert`, `--el-tint-rose` /
    `--el-danger-text`): "Couldn't finish the draft" + **Try again** / **Dismiss**
    (`MOTIR_AI_UNAVAILABLE` / `MOTIR_AI_JOB_FAILED`); generated text is kept.
11. **3C · Source signalling** — only `ai_draft` carries a badge (the shipped
    behaviour); editing an AI draft → `user_edited` (badge drops); hand-written →
    `user_authored` (no badge).

### Primitives composed (no hand-rolling)

| Element                   | Built from                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| create-modal disclosure   | the shipped chevron-toggle + hint + `explanationSkip` markup (`CreateIssueModal`)                                |
| "Draft with AI" action    | `Button variant="secondary" size="sm"` + `Sparkles` (the shipped button) — Regenerate swaps the icon to `rotate` |
| explanation editor        | `MarkdownEditor` (`size="min"` create / `size="full"` edit form) — toolbar + body + caret                        |
| detail section            | `ContentSectionCard` (title + gloss + `headerExtra` Pill + Edit link) + `MarkdownView`                           |
| source pill               | `Pill` — `tone="neutral"` on the read-only card · `severity="info"` in the editor                                |
| cloud-gate / error notice | `Card` tint callout (`plug` / `alert`) + `Button` — mirrors onboarding screen K                                  |
| icons                     | lucide-react (`Sparkles`, `rotate`, `stop`, `pencil`, `plug`, `alert`, `link`, `list`, `code`, `x`)              |

### Token / a11y discipline

- **Colour** via `--el-*` only: the AI button is the standard secondary variant
  (no special hue); the source pill carries its hue in the **tint background** with
  `--el-text-strong` text (AA, finding #35) — `--el-tint-sky` (info) /
  `--el-muted` (neutral); gate `--el-tint-yellow`/`--el-warning`; error
  `--el-tint-rose`/`--el-danger-text`.
- **Shape** via element-semantic tokens (`--radius-input` editor, `--radius-btn`
  buttons, `--radius-badge` pills, `--radius-card` notices/section).
- **Not colour-alone** — the AI source pairs `Sparkles` + label + tint; streaming
  pairs a spinner + "Drafting…"; gate/error pair an icon + heading.
- **A11y** — the disabled gate uses `disabled` + a tooltip (the shipped state, with
  a reason); stop / regenerate are sibling buttons, never nested interactives;
  decorative icons are `aria-hidden`. Drafting is **optional everywhere** — the
  MarkdownEditor and the create/save flow work with no AI connection.
- **Page-state (for 8.8.12)** — saving from the create modal writes
  `explanationMd` + source on create; saving from the edit form re-renders the
  read-only detail card (server-rendered) with its new source badge.

### ⚠️ Planning-violation note (why this asset was rebuilt — 2026-06-19)

The first cut of this asset was drawn against `create.pen` / `detail.pen` (and a
flat invented field with an accept/discard gate), **without checking the shipped
`CreateIssueModal` / `IssueExplanation` / `EditIssueForm`**. That violated the
design-reference rule ("design against SHIPPED REALITY"). The shipped UI already
has the disclosure, the `MarkdownEditor`, the **"Draft with AI" button** (disabled),
and the `ai_draft` / `user_edited` enum — so the real job is the states the
existing button drives, on the real surfaces. The lesson: a UI design subtask must
inventory the implemented components first, not just the area's `.pen`.

### Deliverable

The three-file set under `design/work-items/`: this `design-notes.md` section ·
`draft-with-ai.mock.html` (source of truth) · `draft-with-ai.png` (full-page
export). Rendered with Playwright chromium (full-page, light, `deviceScaleFactor:
2`, ~1500px wide); `prettier --check` clean.

## Work-item mentions & internal links (Story 5.8 · 5.8.1 → 5.8.5 / 5.8.6)

The asset for **`internal-links.mock.html`** — design Subtask **5.8.1**
(MOTIR-1401), the gate that blocks the UI code subtasks **5.8.5** (MOTIR-1405,
the unified `@` editor picker) and **5.8.6** (MOTIR-1404, the chip render + title
linkify). It draws how a reference to ANOTHER work item — in a description,
explanation, comment, or title — becomes a **live internal link** that always
shows the target's current key · title · status, and is auto-added to **Relates
to**. The pain it kills: today a reference is plain text ("see 7.4"), so it goes
**stale** when the target is renamed and the relationship is invisible to the
board / ready-set / relationships panel.

### Shipped reality this design extends (verified, rung 2)

This is the `@user` mention pattern (Story 5.1) one notch over — it COMPOSES the
shipped machinery, it does not reinvent it:

- **The `@` picker** EXTENDS the shipped member popup — `comments.mock.html`
  panel 5 (`.pop` / `.pop-row`, the `Combobox` option-row vocabulary; the editor
  side is `components/ui/markdownEditorMentions.tsx`, `MentionList`). This asset
  adds a **"Work items" SECTION** to that same `@` popup; it does NOT redesign
  the people popup (the reuse-axis / design-compose rule, notes #82).
- **The chip row grammar** (type icon · mono identifier · title · status `Pill`)
  is the shipped `relationships.mock.html` / `links.mock.html` link-row
  vocabulary, reused 1:1 (`components/ui/Pill.tsx`, `IssueTypeIcon`).
- **The inline `.mention` user chip** (the one new 5.1.4 treatment) is shown
  beside the work-item chip for contrast — the work-item chip is the **richer
  sibling**: it carries a type hue + a live status, because it points at a
  navigable RECORD, not a person.
- **The peek** the chip opens is the shipped `quick-view.mock.html` /
  `/api/work-items/peek` (`RelationshipPeekLink`, 2.4 / MOTIR-1305).

### Workflow grounding (the design-content dependency rule)

The interaction is grounded in — not invented for — the `relates_to` subtasks
that SPECIFY it (read at design time; cite in any build):

- **5.8.3** (MOTIR-1403, service) — a reference auto-creates a `relates_to` link
  **unless the pair is already linked in another relationship**; provenance
  `source: mention`. → panel 0's auto-added rows, tagged `from mention`.
- **5.8.5** (MOTIR-1405, editor) — `@` opens the unified people+work-item picker;
  a work-item pick serializes to `[MOTIR-N](motir:<workItemId>)` (the parallel of
  the user token `[@Name](mention:<userId>)`, 5.8.2). → panel 3.
- **5.8.6** (MOTIR-1404, render) — the live chip shows the target's CURRENT
  key/title/status; archived = muted, deleted = strikethrough, no-access = bare
  key; a bare `MOTIR-N` in the plain-text title linkifies. → panels 1, 2, 4.

### Access path (the entry affordance, drawn — not just named)

- **Rich-text fields** (description / explanation / comment composer): the `@`
  trigger INSIDE the `MarkdownEditor` — panel 3 (caret-anchored popup).
- **Title** (a plain-text input, no editor): a bare `MOTIR-N` key, linkified on
  the detail header + the quick-view peek header — panel 4.
- **The chip's door to the target**: click → the quick-view PEEK (panel 5), a
  glance, not a navigation; "Open full page →" navigates.

### States (panel by panel)

- **0 · Placement** — the chip in a real Description body (beside an `@Zhu Yue`
  user chip for contrast) + the three auto-added "Relates to" rows in the
  Relationships panel, each tagged `from mention`. Shows the chip in reading
  context and the relationship it records.
- **1 · Chip anatomy** — at rest (type icon · key · title · status dot) and
  hovered (title underlined, `cursor: pointer`, opens the peek).
- **2 · Target states** — **live**; **archived** → muted, dashed border + archive
  glyph, still navigable; **deleted** → strikethrough, bare key kept, NOT
  clickable; **no view access** → bare key only, no title/status leak.
- **3 · The unified `@` picker** — People + Work items sections; the work-item
  row (type icon · mono key · title · status Pill); short-query ("type to
  search"), loading ("Searching…"), and no-results states; the inserted token.
- **4 · Title link** — a bare `MOTIR-N` linkified on the detail header and the
  peek header.
- **5 · Peek on click** — the shipped quick-view peek frame on the referenced
  item.

### The status DOT vs the Pill (a deliberate density decision)

In running prose the chip uses a 6px status **dot** (`s-todo` stone ·
`s-inprogress` info-blue · `s-done` success-green · `s-blocked` warning-orange),
not the full `Pill` — a Pill is too tall inline. The **Pill** appears only where
rows have width: the picker (panel 3) and the relationships panel (panel 0). The
dot reads the same `--el-type`/status hues as the Pill so the language is
consistent.

### Primitives composed (no hand-rolling)

| Element                    | Primitive / source                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@` picker popup + rows    | the shipped `MentionList` / `.pop` / `.pop-row` (comments 5.1.3) + a Work-items section                                |
| chip type icon             | `IssueTypeIcon` (the `--el-type-*` hue by kind)                                                                        |
| chip / picker / row status | `Pill` tones (`planned`/`inprogress`/`done`/`warning`) — dot mirrors the hue inline                                    |
| relationship rows          | the `relationships.mock.html` / `links.mock.html` link-row                                                             |
| peek on click              | `RelationshipPeekLink` + `/api/work-items/peek` (quick-view)                                                           |
| user chip (contrast)       | the shipped `.mention` chip (5.1.4)                                                                                    |
| icons                      | lucide (`book`/story, `square-check`/subtask, `list-checks`/task, `bug`, `eye`, `archive`, `loader`, `arrow-up-right`) |

### Token / a11y discipline

- **Colour** via `--el-*` only. The chip introduces **no new token** — it reuses
  `--el-surface-soft` (rest fill), `--el-border` / `--el-border-strong` (rest /
  hover), `--el-link` (the mono key), the `--el-type-*` hue, and the status hues.
  Archived/deleted/no-access use `--el-text-faint` / `--el-text-muted` + a dashed (faint is correct here: archived / deleted / no-access are inactive states, which WCAG 1.4.3 exempts)
  `--el-border`. AA holds: link-blue key + strong/standard text on light fills,
  the strikethrough/muted states stay ≥ AA on the page surface.
- **Shape** via element-semantic tokens — `--radius-control` (the chip + picker
  rows), `--radius-badge` (Pills), `--radius-card` (the popup), `--radius-input`
  (the editor surface). No raw `rounded-*` / `p-*` / `h-*`.
- **Not colour-alone** — every state pairs a shape/icon cue with the hue:
  archived = dashed border + archive glyph; deleted = strikethrough; no-access =
  dashed border; live = solid fill + status dot.
- **A11y** — the picker is `role="listbox"` with `aria-activedescendant` +
  ↑/↓/Enter/Esc (the member-popup bar); each chip is a SINGLE interactive `<a>`
  (no nested buttons / nested interactives); the deleted/no-access chips are
  non-interactive spans (`cursor: default` / `not-allowed`); decorative icons are
  `aria-hidden`. New picker / chip copy lands in en + zh (the i18n convention).

### Out of scope (documented for the code subtasks)

- The motir-ai planner EMITTING the token in generated text is **7.4 / 7.11**
  (captured via the story's `relates_to`), not this design — motir-core parses
  whatever lands on write, so the planner adopts the token format when those
  engines ship.
- An in-app "you were referenced" notification (bell) can fan in off the existing
  mention event later, like 5.7 did for user mentions — the relationship edge is
  this story's deliverable.

### Deliverable

The three-file set under `design/work-items/`: this `design-notes.md` section ·
`internal-links.mock.html` (source of truth) · `internal-links.png` (full-page
export). Rendered with Playwright chromium (full-page, light, `deviceScaleFactor:
2`, ~1240px wide); `prettier --check` clean.

---

## Story-acceptance surfaces — panel (3 states) + org toggle card + board badge (MOTIR-1633)

The design that blocks MOTIR-1634 (panel UI), MOTIR-1635 (org settings toggle
card) and MOTIR-1636 (board badge) for the story-acceptance gate (Story
MOTIR-1627). Source: `acceptance-panel.mock.html` → `acceptance-panel.png`. The
item-detail page reserves **no** acceptance section, so the panel + its three
eligibility states + the org card + the board pill are whole elements no design
specifies — the design gate (mistake #31) requires this asset first, as
`attachments.mock.html` did for the Epic-5 slot.

**Grounded in** (read at design time, cited — not invented): the MOTIR-1628 ADR
(`docs/decisions/acceptance-video.md`) for the three states + the
`applicable:false` (self-host / meta) **ungated** case; the MOTIR-1630
eligibility DTO (`{ applicable, eligible, reason, toggleEnabled,
canManageBilling, canManageToggle }`) which the panel branches on; and the
MOTIR-1629 evidence DTO (`{ status, videoUrl, chapters[{label,tSeconds}],
commitSha, ciRunUrl, producedByKey }`).

### Access paths (drawn, not just named)

- **Panel** — the item-detail **main column, AFTER the Development section**
  (`page.tsx:436`), on a `story` once it is `in_review`. Panel 0 draws the column
  order (Description → Development → **Acceptance** → Activity); the right rail is
  untouched.
- **Org card** — **Settings → Organization** (breadcrumb drawn), an
  `OrgGeneralCard` sibling.
- **Board badge** — any **board**; the pill sits in the `BoardCard` foot, the
  same slot as the readiness "Blocked" pill (`BoardCard.tsx:81`).

### The panel — a `ContentSectionCard` that branches on eligibility

Header: a `video` lucide glyph + **"Acceptance"** title + a right-aligned status
`Pill`. Five renders, keyed on the MOTIR-1630 `reason` + the MOTIR-1629 evidence:

1. **State A · eligible, evidence present** (`eligible:true`, evidence
   `pending`) — the **chaptered player**: a native `<video>` frame + a scrubber
   whose ticks mark `chapters[].tSeconds` + a chapter list (index dot · label ·
   mono timestamp, from `chapters[]`). Below: a **test summary** ("N assertions
   passed · M failed", `--el-success` check) and a **provenance** row of mono
   chips (`commitSha` with a commit glyph · `ciRunUrl` as an `--el-link` external
   chip · `producedByKey`). Footer: **Approve** (`btn-primary` — the
   `in_review → done` gate) + **Request changes** (`btn-secondary` —
   `in_review → in_progress`). Status pill "Awaiting review" (info/sky).
2. **State A · pending** (`in_review`, no evidence yet) — an EmptyState:
   `--el-tint-sky` clock disc, **"Waiting for the acceptance video"**, "The
   story's E2E publishes its recording here on the next green run."
3. **State A · approved** (evidence `approved`) — read-only: the collapsed
   player + a `--el-tint-mint` **"Approved"** pill + "Approved by {name} · {date}".
4. **State B · toggle_off, ORG-ADMIN** (`reason:'toggle_off'` +
   `canManageToggle`) — an infobox (muted `video-off` glyph): **"Acceptance video
   is off"** + an inline **Turn on** `Switch` + a **"Go to settings →"**
   `btn-link`.
5. **State B · toggle_off, NON-ADMIN** — the same infobox, read-only: "Ask an org
   admin to turn on acceptance video…" + a **"View settings"** `btn-link` (no
   switch).
6. **State C · no_plan** (`reason:'no_plan'`) — the **upsell** infobox
   (`--el-tint-lavender`, an accent `sparkles` glyph on an `--el-page-bg` tile):
   **"Get a video receipt for every story"** + **Upgrade** (`btn-primary` →
   billing) + **Learn more** (`btn-link`). Mirrors the `useAiAccess` paywall tone;
   owner vs member picks Upgrade vs "ask your owner" via `canManageBilling`.
   **`applicable:false` (self-host / meta org) is UNGATED** — State A renders
   directly, this upsell never shows.

   **Reuse the SHIPPED upgrade workflow (verified — Epic 8.1, no new story).** The
   Upgrade CTA routes to the existing billing surface — **do NOT build a new
   checkout.** The shipped path (verified against `origin/main`): the
   `components/ai/AiPaywall.tsx` component exports
   `BILLING_PLANS_PATH = '/settings/organization/billing'` (the plan-selection
   page, `BillingClient`) → `POST /api/organizations/[orgId]/billing/checkout`
   (Stripe checkout) → the webhook flips `hasPaidAiPlan`, which this feature's
   eligibility (MOTIR-1630) already reads. MOTIR-1634 SHOULD compose the shipped
   `AiPaywall` (or reuse `BILLING_PLANS_PATH`) rather than a bespoke upsell, so the
   acceptance upsell is consistent with every other AI paywall in the app.

### Org settings card (MOTIR-1635)

A `Card` beside `OrgGeneralCard`: title **"Acceptance video"** + a one-line
description + a right-aligned `Switch`. Two variants (both drawn):

- **With a paid plan** — the `Switch` (`is-on` by default) PATCHes
  `/api/organizations/[orgId]` (`acceptanceVideoEnabled`); a `--el-success`
  "Saved" foot on write. Org owner/admin only — a non-admin sees it disabled.
- **No paid plan — the switch is moot** (the entitlement blocks generation
  regardless): the `Switch` is **disabled** and the card foot carries a
  "Requires a paid Motir AI plan" note (sparkles glyph) **+ an Upgrade
  `btn-primary`** (→ billing). This is the same plan gate the panel's State C
  shows, surfaced where an admin manages the org — so the admin isn't left
  flipping a switch that does nothing. (Owner vs member gates the Upgrade button
  on `canManageBilling`, like the panel.) The Upgrade CTA routes to the SHIPPED
  `BILLING_PLANS_PATH` (`/settings/organization/billing`) — the same reuse as
  State C; MOTIR-1635 builds no new checkout.

### Board badge (MOTIR-1636)

An **"Awaiting acceptance"** `Pill` — **info tone** (`--el-tint-sky` bg +
`--el-text-strong` + a clock glyph) — in the `BoardCard` foot, the exact slot +
grammar as the readiness **"Blocked"** pill (warning/peach). Info vs warning
keeps the two visually distinct; state is carried by **text + icon**, never
colour alone (finding #35). Shown for an `in_review` story awaiting its
video/approval.

### Colour + shape (tokens only)

- **Colour** via `--el-*` only — **no new token**. Player chapter dot
  `--el-tint-lavender`; status pills reuse Pill tones (info `--el-tint-sky`,
  success `--el-tint-mint`, warning `--el-tint-peach`); upsell surface
  `--el-tint-lavender` with `--el-accent-on-surface`; provenance chips
  `--el-surface` + `--el-link`; summary check `--el-success`; buttons
  `--el-accent`/`--el-accent-text` (primary) + `--el-border-strong` (secondary).
  AA holds — tint backgrounds carry `--el-text-strong` (finding #35).
- **The video player frame** is a dark gradient MEDIA stand-in for real video
  pixels (the same sanctioned pattern `attachments.mock.html` uses for thumbnail
  stand-ins) — non-semantic media decoration, never a card/pill/state fill.
- **Shape** via element-semantic tokens — `--radius-card` (the section card),
  `--radius-input` (the player + infoboxes + empty state), `--radius-badge`
  (pills), `--radius-btn` (buttons), `--radius-control` (chapter rows, chips).
  `--spacing-card-padding`, `--spacing-chip-*`, `--height-btn-sm`; `--shadow-card`
  / `--shadow-subtle`. No raw `rounded-*` / `p-*` / `h-*`.

### A11y + i18n

The Switch is `role="switch"` + `aria-checked`; Approve/Request-changes are
buttons with text; the player uses a native `<video>` (built-in controls +
keyboard); chapter rows are buttons that seek. Decorative glyphs `aria-hidden`.
All new copy (the state strings, the org card, the pill) lands in **en + zh**
(the i18n-catalog parity gate).

### Out of scope (for the code subtasks)

- The **gate transition** wiring (Approve → `in_review → done`) is MOTIR-1634's
  code (the button calls setStatus(approved) + the work-item transition); this
  design fixes only its affordance.
- The **hosted** video-delivery variant is Epic 9; this is the **BYOK** surface.

### Deliverable

The three-file set under `design/work-items/`: this `design-notes.md` section ·
`acceptance-panel.mock.html` (source of truth) · `acceptance-panel.png`
(full-page export). Rendered with Playwright chromium (full-page, light,
`deviceScaleFactor: 2`, ~1200px wide); `prettier --check` clean.

---

## Work-item provenance on the detail rail (Story MOTIR-1685 · MOTIR-1688)

`detail.pen` / `CoreFieldsPanel.tsx` draw the core-fields rail — Status · Type ·
Work type · Executor · Priority · Assignee · Reporter · Parent · Sprint · Due ·
Story points · Estimate · (session branch) — but there is **no provenance
surface**. This HTML mockup (`provenance.mock.html`, built from the live
`--el-*` + shape tokens and the shipped `FieldCard` grammar) is the design asset
for it. The display code subtask (**MOTIR-1693**) composes the same primitives.
Draws the field set decided in the provenance ADR
(`docs/decisions/work-item-provenance.md`): the two `source` enums + the
`harness`/`model` free-text.

### Placement + access path — COLLAPSED by default, at the BOTTOM

Provenance is **secondary metadata**, so it is **collapsed by default** behind a
single **"Provenance" disclosure** placed at the **very bottom of the rail —
after every other field** (Reporter · Created · Updated are the last built-in
fields; the disclosure follows them). The disclosure reuses the **shipped
"Show all custom fields" toggle grammar** (`CustomFieldsSection.tsx`): a
full-width `button` (`aria-expanded`), a leading chevron (`ChevronDown` that
**rotates 180° when open**), `text-[13px] text-(--el-text-secondary)`, padding
`--spacing-control-*`, radius `--radius-control`, hover `bg-(--el-surface)`.
Defaults **closed** — the common case is the `—`/unknown state anyway, so
collapsing keeps the rail uncluttered. The user **expands to see** the two
read-only triple `FieldCard`s (**Planning** then **Implementation**).

Provenance is **read-only**: it is set by the create seams (manual / MCP /
native) and the session tools (`mark_integrated` / `complete_session`), never
edited by hand — the inner cards carry no chevron and there is no separate entry
affordance. The disclosure's placement in the rail **IS** the access path. The
display code subtask (**MOTIR-1693**) implements the disclosure defaulting closed.

### Anatomy (per card)

- **Label** (`FieldCard` `.flabel`): `PLANNING` / `IMPLEMENTATION`, uppercase —
  `text-[11px] font-semibold tracking-wide uppercase`, colour `--el-text-secondary`.
- **Source chip** (a `Pill`-grammar chip): the `source` value as a tinted chip —
  the hue in the **tint background** with `--el-text-strong` text (the colour
  rule / finding #35), radius `--radius-badge`, padding `--spacing-chip-*`, a
  13px leading glyph. Six values, each a distinct slot:

  | source (planning) | tint                                          | glyph    |     | source (impl) | tint                     | glyph  |
  | ----------------- | --------------------------------------------- | -------- | --- | ------------- | ------------------------ | ------ |
  | Native            | `--el-tint-lavender`                          | Bot      |     | Hosted        | `--el-tint-peach`        | Server |
  | MCP               | `--el-tint-sky`                               | Terminal |     | BYOK          | `--el-tint-mint`         | Key    |
  | Manual            | `--el-surface` (neutral + `--el-border-soft`) | User     |     | Manual        | `--el-surface` (neutral) | User   |

  **Manual is a NEUTRAL surface chip, not a tint** — a human is not a model, so
  it reads as the absence of a machine source (deliberate colour story, distinct
  from the AI/agent tints).

- **Harness** (`.harness`): 14px `--el-text` — the tool name (`Motir`,
  `Claude Code`, `opencode`, `Codex`).
- **Model** (`.model`): 12px **`--font-mono`** `--el-text-muted` — the LLM id
  (`claude-opus-4-8`, `deepseek`); mono because it is an identifier. **NATIVE
  shows NO model** — a natively-planned card renders only the chip + harness
  (`Native · Motir`), no model line. Motir abstracts its own planning LLM: the
  model is recorded server-side for analysis but stripped from the read DTO
  (ADR Decision 6), so it is never displayed. MCP / BYOK DO show their model
  (the user reported their own).
- **Unknown / "—"** (`.prov-unknown`, `--el-text-muted`): a plain em-dash. The
  **common case** — an item never executed (no implementation) and pre-feature
  items with no recorded planning provenance. A null triple renders `—`, never an
  empty card. On the Manual-implementation case the harness/model line is `—`
  (a human, no agent → no harness/model).

### Shape / colour tokens (no raw values)

Radius `--radius-card` (the card) + `--radius-badge` (the chip); padding via the
`FieldCard` box (`10px 14px` verbatim) + `--spacing-chip-*` (chip); elevation
`--shadow-card`. Colour is **only** `--el-*` (text) + `--el-tint-*` / `--el-surface`
(chips) — no raw hex, no `rounded-*`/`p-*`. The design-asset dashed outline
(`.is-new`, `--el-accent`) marks the NEW cards for review and is not part of the
shipped component.

### Panels in the asset

1. **Collapsed (the default)** — in rail context: the closed `Provenance`
   disclosure sits at the **bottom**, after Reporter · Created · Updated (ghosted).
2. **Expanded, both triples populated** — MCP-planned
   (`Claude Code · claude-opus-4-8`) + BYOK-implemented (`opencode · deepseek`),
   revealed under the open disclosure.
3. **Expanded, native + unknown** — `Native · Motir` (**no model line**) +
   the `—` unknown implementation (an item not yet executed).
4. **Source legend** — all six `source` values with glyph, tint, and gloss.

### THE THIRD GROUP — `Subject` (Story MOTIR-5062 · MOTIR-5073)

The disclosure now holds **three** groups, in this order: **Planning ·
Implementation · Subject**. `subject` is the fourth coordinate of the planner's
rule-pack selector — it records WHICH SUBJECT MATTER an authoring pass composed
this card's rules from — so it is the same KIND of fact as the two triples above
it: a record of how the card came to be planned, not a property of the work.

**Why it is here and not beside `type`.** Every earlier placement failed the same
test, and the reason is worth keeping because it will be re-proposed: a control a
person can SEE is one they reasonably expect to EDIT, and editing a subject
re-points the rule corpus rather than describing the work. Worse, its value set is
_which rule packs exist_, so a blank means **the corpus has no pack for this
subject** — not that the work has none. Put that next to `type` in the editable
cluster and a reader learns something false and then tries to correct it. This
disclosure is the one place on the card where none of that applies: everything in
it is read-only by construction, set by seams rather than by people, and collapsed
because it is secondary.

**The SHAPE, which is the real design question.** Two of the three groups are
TRIPLES that open with a tinted source chip; Subject is a **single value**. A lone
value in the same box can read as a triple whose other two rows failed to load, so
the treatment keeps them apart on the axis a reader notices first:

- **No chip, at all.** Both triples open with one, so a card with none is visibly
  a different KIND of field rather than a shorter instance of the same one.
- **Mono** (`--font-mono`, 13px, `--el-text`). A subject is an IDENTIFIER — it
  names the rule pack the planner read (`subject-<name>.md`) — and this asset
  already uses mono for an identifier, at `.model`. `--el-text` rather than
  `--el-text-muted` because it is the card's PRIMARY content, not a secondary
  annotation beneath one.
- **No per-member tint, deliberately.** The two existing groups tint their source
  chip from a CLOSED enum. Subject members are corpus-owned and open-ended — a
  member exists iff a pack file exists — so a colour per member would be a
  vocabulary this repository cannot enumerate, and a lookup with a runtime
  fallback would reintroduce the blank-chip failure the component's own header
  memorialises. Plain text is the honest treatment.

**The EMPTY state is the common case, and stays common.** The corpus ships four
members and most cards will carry no subject for a long time, so `—`
(`.prov-unknown`, `--el-text-muted`) renders exactly as the other two groups'
unknown state. Panel 3 draws a card with NO subject beside a `—` implementation
precisely so a subject-less card reads as **ordinary rather than incomplete**.

**Read-only, like the rest of the disclosure** — no chevron on the card, no input,
no entry affordance, and no filter, board column or bulk edit anywhere.

### Panels the third group adds

5. **Expanded, all three groups populated** — panel 2, extended: MCP planning,
   BYOK implementation, and `jobs` as the subject.
6. **Expanded, native + unknown + NO subject** — panel 3, extended: the common
   case for both trailing groups.
7. **The shape question** — a triple, a populated Subject and an empty Subject set
   side by side, with the rationale above stated on the panel.

### ADR amendment

`docs/decisions/work-item-provenance.md` **Decision 7 needed one, and it lands
with this card**: its text read _"The user expands to see the two triples"_, which
a third group makes false. The amendment records the third group and states what is
UNCHANGED — the placement (bottom of the rail), the collapsed default, and the
read-only contract. Nothing else in the ADR moves.

### Deliverable

The FOUR-file set under `design/work-items/`: this `design-notes.md` section ·
`provenance.mock.html` (source of truth) · `provenance.png` (full-page export) ·
`provenance.dark.png` (the dark board, added by MOTIR-5073 — same dimensions, which
`tests/design-dark-board-parity.test.ts` asserts, because a theme flip changes ink
and never layout). Rendered with Playwright chromium (full-page, `deviceScaleFactor: 2`,
~1200px wide) via `scripts/render-design-mock.mjs`; `prettier --check` clean.

---

## Plan / Re-plan entrance on detail page + quick-view (Story 7.12 · MOTIR-1489)

`detail.pen` / `detail.png` and `quick-view.mock.html` draw no contextual
Plan / Re-plan entrance on the work-item surface. This HTML mockup
(`plan-replan-entrance.mock.html`, built from the live `--el-*` tokens + the
shipped primitives) is the design asset for **the entrance only** — where the
button sits and what happens on click. The universal `PlanningWorkspace`
(MOTIR-1193 / 7.20.1) + `WorkItemCanvas` (MOTIR-1194) are already shipped and
composed 1:1; this design does NOT redraw them. The code subtask (MOTIR-910)
composes the same primitives.

### Context

The **global hero launcher** (`PlanWithAILauncher`, MOTIR-1299) is already
shipped in `TopNav` — the hero gradient pill labelled "Plan with AI", summonable
from every screen. **This card designs the PER-ITEM contextual entrance** — the
"Plan" / "Re-plan" button that sits ON the work-item detail page AND in the
quick-view modal, opening the workspace scoped to THIS item's neighborhood.

### Placement

**Detail page:** the button sits in the header's right cluster (the `ml-auto
flex items-center gap-3` div in `page.tsx`), BEFORE `WatchControl` and
`WorkItemDetailActions`. An accent-toned pill with Sparkles icon, scaled to
header row height (32px).

**Quick-view modal:** the button sits in the modal header bar, between the
`StatusValue` pill and "Open full page". Scaled to header bar height (28px).
Clicking it closes the modal — a handoff to the planning workspace.

### Modes

**Plan** (item has NO children):

- Accent-toned "Plan" pill. Opens the workspace — the AI starts from the
  item description. No opening reason needed.

**Re-plan** (item HAS children):

- Subdued "Re-plan" pill (neutral border, secondary text). Opens the
  workspace — the chat composer is pre-focused with
  _"What's wrong? What should change?"_. The user types the reason as the
  **first chat turn** (consumed by MOTIR-908). No pre-workspace form.

**Both are conversations, not single messages.** The button opens the
workspace; the user and AI converse through the shipped chat rail.

### States in the mockup

1. **Detail page — Plan button** (item not yet planned; accent pill)
2. **Detail page — Re-plan button** (item has children; subdued pill)
3. **Quick-view — Plan button** (accent pill in modal header)
4. **Quick-view — Re-plan button** (subdued pill in modal header)
5. **What happens on click** — Plan flow (open workspace → AI plans →
   conversation → confirm) vs Re-plan flow (open workspace → type reason as
   first chat turn → AI responds → conversation → confirm). The shipped
   workspace is composed, not redrawn.
6. **Access-path table** — every kind on both surfaces

### Tokens / primitives

- Colour via `--el-*` only; Plan button: `--el-accent` on transparent fill.
  Re-plan button: `--el-text-secondary` + `--el-border-strong`.
- Shape via element-semantic tokens: `--radius-badge` for the pill,
  `--height-control` / `--spacing-control-x/y`.
- AA: accent text on page bg ≥ 14px/12px bold; secondary text on page bg also AA.

### Deliverable

The three-file set under `design/work-items/`: this `design-notes.md` section ·
`plan-replan-entrance.mock.html` (source of truth) · `plan-replan-entrance.png`
(full-page export). Rendered with Playwright chromium (full-page, light,
`deviceScaleFactor: 2`, ~960px wide); `prettier --check` clean.

---

## ⭐ Child panel — List ↔ Graph (Story MOTIR-2284 · MOTIR-2285 — `child-panel-graph.mock.html`)

`child-panel-graph.mock.html` adds a **view switcher** to the Children section on
the work-item detail page — `List` (today's rows, unchanged, still the default)
and `Graph`, the SAME roadmap canvas `/roadmap` uses, **rooted at THIS item** so it
draws that item's children and the `blocked_by` edges between them.

`detail.pen` / `detail.png` draw the detail page with a Children list and no view
affordance; `design/roadmap/` draws the canvas at full-page scale. Neither answers
the question this story asks: **what does that canvas look like sitting inside a
content-column section card, bounded, showing one item's children?** That is this
asset, and nothing else.

### COMPOSES `design/roadmap/`, does not redraw it (`notes.html` #82 / #95)

The canvas's visual language is **already designed and shipped**, and this asset
re-specifies none of it. It cites, by path:

| Already designed there                                                | Sheet                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| node cards, the drill affordance, the canvas frame                    | `design/roadmap/roadmap.mock.html` (MOTIR-1009 / 1194)  |
| arrowed `blocked_by` edges, the legend, the off-level blocker anchor  | `design/roadmap/edges.mock.html` (MOTIR-1331)           |
| the ready-to-start highlight (mint pill + success accent bar)         | `design/roadmap/ready-highlight.mock.html` (MOTIR-1416) |
| the selected card's **Open** / **View** buttons + the quick-view peek | `design/roadmap/detail-surfaces.mock.html` (MOTIR-1351) |
| the breadcrumb + Back on an arrived-drilled level                     | `design/roadmap/auto-drill.mock.html` (MOTIR-1805)      |
| the `Segmented` view-toggle precedent in a header                     | `design/roadmap/scope-toggle.mock.html` (MOTIR-1380)    |
| the container progress meter + "you are here"                         | `design/roadmap/roadmap.mock.html` §7.20.6 (MOTIR-1013) |

### Composed components + their contracts (`notes.html` #95)

| Composed thing         | Source                                                        | Contract this design honours                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectRoadmapCanvas` | `components/planning/ProjectRoadmapCanvas.tsx` (MOTIR-1194)   | PRESENTATIONAL + level-driven: it FILLS its container and pulls each level through the consumer's `loadLevel(parentId)`. The panel therefore owns the BOX, never the canvas. Its opt-ins are given a verdict below — the code card must not choose them. **Unchanged by this story**, and so are its four other consumers. |
| `WorkItemRoadmap`      | `components/planning/WorkItemRoadmap.tsx`                     | the adapter the panel MOUNTS; it maps a level to `WorkItemNode` cards and already owns the quick-view peek (MOTIR-1352). The item-rooting is an **adapter** opt-in (MOTIR-2287), not a canvas change.                                                                                                                      |
| `ContentSectionCard`   | `app/(authed)/items/[key]/_components/ContentSectionCard.tsx` | the section-card header grammar. The count `Pill` already occupies `headerExtra`; the switcher goes in **`headerRight`** (`ml-auto flex items-center`), which is free on this card. `editHref` is NOT used here, so there is no contention for the header's far end.                                                       |
| `Segmented`            | `components/ui/Segmented.tsx` → `@motir/design-system`        | reused unchanged: an `--el-tabnav-track` track at `--radius-btn` with a 2px inset, the pressed option raised on `--el-page-bg` + `--shadow-subtle`, `role="group"` + per-option `aria-pressed`. **No new toggle primitive.**                                                                                               |
| `ChildList`            | `app/(authed)/items/[key]/_components/ChildList.tsx`          | the List mode IS this component, byte for byte. Its `items.length === 0 → return null` is preserved: the switcher lives inside the section, so a leaf grows no new chrome.                                                                                                                                                 |

### ⭐ DRAWN AGAINST SHIPPED REALITY — rendered before drawn (`notes.html` #73)

Every product fragment on the board is the **real emitted markup** of the shipped
components, captured from a headless render through the repo's own
`tests/helpers/renderWithIntl` harness, with Tailwind's real output over
`app/globals.css`'s token layers inlined. The canvas panels use MOTIR-2284's **own
five children and their real `blocked_by` edges**, positioned by the shipped
`deterministicLayout` and transformed by the shipped `fitView`. Two things the
render established that reading the `.tsx` could not:

- **The panel is WIDTH-bound, and a dependency chain does not fit.** This level
  lays out as four dependency layers — world bounds 1360 × 320 px (`NODE_W` 280,
  `GAP_X` 80). `fitView` in the panel's real 758 × 448 box (padding 48) resolves to
  **0.487×**, which puts the 14px node title at ~6.8px. Height buys nothing: the
  vertical fit is 0.9× and slack. **So the panel's honest promise is a MAP, not a
  read** — shape, colour, the ready highlight, which column comes first — and the
  reader zooms/pans or goes **Full screen** (where the same level fits at ~1:1) to
  read it. This is a stated design position, NOT a defect for the code card to
  "fix" by special-casing the shared canvas.
- **The breadcrumb only exists once drilled.** At the panel's first level there is
  no crumb at all, so nothing inside the canvas says what it is rooted at — the
  section header (`Child work items` + the count `Pill`) is what says it. That is
  why the switcher must sit in that header and not float inside the canvas.

### The five panels (`child-panel-graph.mock.html`) — each in light AND dark

| Panel     | State                    | What it draws                                                                                                                                                                      |
| --------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A**     | **The door** — List mode | the switcher in the Children `ContentSectionCard` header, in its real place after the title + count `Pill`, at the page's real content width; the shipped rows below, unchanged    |
| **B**     | Graph mode               | the same card with `Graph` selected and `WorkItemRoadmap` in the fixed 28rem box — five real children, real edges, the legend, the "you are here" marker, the Full-screen control  |
| **C**     | Drilled one level        | the breadcrumb + **Back** inside the panel; the root crumb is the ITEM's identifier; a ready child carries the shipped mint `Ready` treatment                                      |
| **D1–D3** | The three states         | loading (the canvas's own centred `Spinner`) · a drilled level that comes back empty (the canvas's own copy) · the graph read that did not come back (the panel's own `emptyRoot`) |
| **E**     | Leaf                     | an item with no children renders **nothing at all** — no section, no switcher, no empty scaffold                                                                                   |

### Decisions this asset RESOLVES (the code card is not allowed to choose them)

**(a) The panel's canvas height — a fixed `h-[28rem]` block, not a viewport fill.**
The canvas fills its container, so the panel owns the box:

```
h-[28rem] overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-canvas)
```

28rem is the **shipped roadmap view's own `min-h-[28rem]` floor**
(`components/planning/RoadmapView.tsx`), reused rather than invented. The roadmap
page's own viewport-relative height (`h-[calc(100dvh - 11.5rem -
var(--shell-bottom-clearance, 1.5rem))]` since MOTIR-2763) is deliberately NOT reused: a section card in a
scrolling content column must not be measured against the viewport. Why not
shorter: at 24rem the fitted level and the canvas's bottom-left legend + zoom
cluster collide (measured); at 28rem the fitted content clears them. Why not
taller: the fit is width-bound, so every extra pixel of height is empty canvas.
**Rejected alternative** — letting Graph mode break out of the content column and
span the rail's width to buy ~290px. It would give the panel a layout the page does
not have, for a scale gain that still does not make the chain readable; Full screen
already answers it properly.

**(b) The canvas opt-ins — a verdict for each.**

| Prop                                               | Verdict             | Why                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fullScreenable`                                   | **ON**              | the answer to (a). The panel is a map; full screen is where the same level fits at ~1:1 and becomes readable. Without it the bounded canvas has no escape.                                                                   |
| `searchable`                                       | **OFF**             | the `/` overlay is a page-level key grab from inside an embedded panel, and one item's children is a set you scan, not search. The page's own find stays unshadowed.                                                         |
| `locatable`                                        | **OFF**             | "locate the actionable node" earns its place on a whole-project canvas. This canvas is already rooted at the one item the reader is on, and its level auto-fits on arrival — there is nothing off-screen to locate.          |
| `autoDescendSingleParent`                          | **OFF**             | a panel that says "this item's children" must never silently show something else's. An only child is still this item's only child.                                                                                           |
| the planning-origin cluster (`showPlanningOrigin`) | **OFF**             | the project's onboarding journey is not this subtree's story, and pinning it would put a node in the panel that is not a child of the item at all.                                                                           |
| `loadingFallback`                                  | **default**         | the shipped centred `Spinner`. A level-shaped skeleton is for a surface the user is waiting ON; here the panel is one section of a page that has already painted.                                                            |
| `emptyRoot`                                        | **the panel's own** | see (e).                                                                                                                                                                                                                     |
| `initialTrail`                                     | **NOT used**        | seeding a trail would leave **Back** pointing at the project root — wrong inside a panel. The rooting belongs in the adapter (MOTIR-2287), which is what makes the first level the item's own children _and_ the crumb root. |

**(c) The breadcrumb root label — the ITEM's identifier** (e.g. `MOTIR-2284`),
passed as `rootLabel`. Not "Roadmap" (the canvas default — false here: this is not
the project roadmap) and not "Children" (says what, never which). The identifier is
the same vocabulary the crumbs themselves use (`workItemCrumbLabel` →
`IDENT · title`), it is already on the page's own eyebrow, and it makes **Back**
self-describing: _back to MOTIR-2284_. It is data, not copy — no new i18n key.

**(d) No preference is persisted beyond the URL.** `?children=graph` is the single
source of truth (the story's baked-in decision). **No `localStorage`, no cookie, no
user setting** — an item you open from a shared link shows what the link says, and
the browser's Back button undoes the switch like it undoes everything else. `List`
renders on a clean URL, so first paint and every existing link are unchanged.

**(e) The empty canvas — the panel says its own thing at the FIRST level, and the
canvas's at a drilled one.** `fetchRoadmapLevel` is best-effort: it **never throws**,
it resolves to an EMPTY level on any failure. And the section renders at all only
when the server read already returned children. So an empty FIRST level can only
mean the graph read did not come back — while the count `Pill` two lines above still
says `5`. The canvas default ("Nothing on the roadmap yet · Work items will appear
here as the plan takes shape") would be a flat contradiction, so the panel passes its
own `emptyRoot`. A **drilled** empty level keeps the canvas's shipped copy ("No items
at this level") — that one is true as written and is not the panel's to reword.

### Exact copy (the strings MOTIR-2288 ships — `messages/en.json` + `zh.json`)

| Key                                                      | en                                                 | zh                                   |
| -------------------------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| `issueViews.viewList` _(shipped, reused)_                | `List`                                             | `列表`                               |
| `issueViews.viewGraph` _(new)_                           | `Graph`                                            | `关系图`                             |
| `issueViews.childrenViewLabel` _(new)_                   | `Children view`                                    | `子工作项视图`                       |
| `issueViews.childrenGraphAria` _(new)_                   | `Child work items as a dependency graph`           | `子工作项依赖关系图`                 |
| `issueViews.childrenGraphUnavailableTitle` _(new)_       | `The graph couldn’t be drawn`                      | `无法绘制关系图`                     |
| `issueViews.childrenGraphUnavailableDescription` _(new)_ | `Switch back to List to see this item’s children.` | `切换回列表即可查看该工作项的子项。` |

`viewList` is **reused, not duplicated** — the `/items` view switcher already ships
it, and one product should have one word for a list. `childrenViewLabel` is the
`Segmented` group's accessible name (not rendered visually). Every new key lands in
`en.json` **and** its `zh.json` twin in the same PR (the catalog-parity gate). The
canvas's own strings (`roadmap.canvas.*` — the legend, Back, the drilled-empty copy,
the zoom labels) are reused untouched; this panel adds none of them.

### Access path (DRAW THE DOOR — the `run.md` design gate)

Panel **A** is the door, drawn as real UI: the `Segmented` control in the Children
section header of the shipped work-item detail page, reached the way that page is
already reached (any work item's `/items/<key>`). There is **no new route and no new
nav affordance** — `?children=graph` is view state on the same route, exactly as
`/roadmap?scope=sprint` is (MOTIR-1541). A control inside a section is scoped to that
section; nothing about it is a top-level view (`notes.html` #99).

### Token / a11y discipline

- **Colour** via `--el-*` only. The switcher is the `Segmented` primitive's own token
  set (`--el-tabnav-track` track, `--el-border` edge, `--el-page-bg` +
  `--el-text-strong` + `--shadow-subtle` on the pressed option, `--el-text-secondary`
  on the unpressed one); the canvas box is `--el-canvas` inside `--el-border`; the
  `emptyRoot` copy is `--el-text` over `--el-text-muted`. **No Tier-0 `--color-*`, no
  invented hue** — the board's only raw values are the sheet chrome, which is not
  product UI.
- **Shape** via element-semantic tokens: the canvas box is `--radius-card`, the
  switcher's track `--radius-btn` with its options at `calc(--radius-btn - 2px)`,
  option height `--height-control` and padding `--spacing-control-x`. The single
  fixed dimension is the panel's `h-[28rem]` box, which is a LAYOUT height, not a
  control's shape.
- **A11y** — the switcher is the shipped `role="group"` + `aria-pressed` pair with an
  accessible group name; the canvas keeps its `role="application"` + `aria-label`, its
  `Breadcrumb` nav, the `aria-busy` loading box and the `progressbar` meters. Switching
  mode is a shallow `router.replace` (URL state), never a `router.refresh()` — the
  page-state contract: the graph is a client island that seeds itself from the URL, and
  the server-rendered rows are what the other mode shows.
- **Observed drift, NOT fixed here:** `ChildList`'s row uses a raw `rounded-md`
  instead of `--radius-control`, which the shape-swap rule forbids. It is pre-existing
  and outside this story — logged as its own card rather than absorbed
  (`notes.html` #27 / the drive-by rule).

### Deliverable

The three-file set under `design/work-items/`: this `design-notes.md` section ·
`child-panel-graph.mock.html` (the source of truth) · `child-panel-graph.png`
(full-page export, Playwright chromium, `deviceScaleFactor: 2`, 1720px wide — the
board pairs each panel light/dark side by side). Gates MOTIR-2287 and MOTIR-2288.

---

## ⭐ The work-item TYPE vocabulary at FOURTEEN (Story MOTIR-2622 · MOTIR-2631)

The set the type picker, chip, icon and filter facet render grew from ten members
to fourteen. **ADR `docs/decisions/work-item-type-taxonomy.md` Amendment 1
(MOTIR-2629) is the authority for WHICH members and in WHAT order** — this section
is the authority for how they LOOK and how the surfaces absorb four more.

The admitted four are `copy` · `translate` · `legal` · `verification`. The story
was authored expecting six and sixteen; the amendment collapsed `doc` into
`content` and `spike` into `research` (neither has an authoring bar of its own in
`plan-rules.md` — each shares one with the member it names), so this asset is
drawn for **fourteen**. The canonical order, verbatim from Amendment 1 §1b:

```
code · design · test · content · copy · translate · research · review ·
verification · decision · deploy · manual · legal · chore
```

### Q1 — does the picker still fit? MEASURED, and the answer reframes the question

`scripts/render-work-item-types.mjs` reads these off the rendered DOM and prints
them beside the PNG it exports, so the table and the asset cannot drift apart:

| quantity               | at ten  | at fourteen |
| ---------------------- | ------- | ----------- |
| option row             | 28 px   | 28 px       |
| group headers          | none    | 4 × 25 px   |
| list content           | 288 px  | **502 px**  |
| menu ceiling (shipped) | 256 px  | 256 px      |
| rows visible           | 8 of 10 | **8 of 14** |
| hidden below the fold  | 14%     | **51%**     |

**The picker did not stop fitting at fourteen — it stopped fitting at ten.**
`components/ui/Combobox.tsx` renders its listbox `max-h-64 overflow-y-auto`
(256 px), and its in-dialog branch clamps to
`Math.max(80, Math.min(256, avail - 12))`. That `min` makes 256 px a **cap** the
list length cannot raise, in _both_ hosts. Ten rows already overflowed it by
32 px.

So the two hosts the card asked to measure separately turn out to differ only in
**how** the ceiling is computed, not in **what** it is:

| host                           | Combobox branch                                                        | ceiling          |
| ------------------------------ | ---------------------------------------------------------------------- | ---------------- |
| create modal (`role="dialog"`) | inline, clamped to the modal's `overflow-hidden max-h-[90vh]` clip box | `min(256, …)`    |
| detail rail / filter bar       | body-portaled, clamped to the viewport                                 | `max-h-64` = 256 |

That is why this asset draws one menu box and not two (panels 1 and 5a).

### Q1 answer — grouping YES, a scroll container NO

- **No scroll container is added.** There already is one; it is the shipped
  Combobox's, and a second would be a bug. AC 4's "only if the count demonstrably
  does not fit" is satisfied in the _other_ direction: it demonstrably did not fit
  before this story either.
- **Grouping IS added**, and the row count is the justification. The visible
  window stays at 8 rows while the hidden fraction goes 14% → 51%; scanning an
  8-of-14 window with no landmarks is what actually got worse. The four groups are
  **contiguous runs of Amendment 1's single ordered list**, not a second ordering:
  Build (`code`–`test`) · Author (`content`–`translate`) · Investigate
  (`research`–`verification`) · Govern & operate (`decision`–`chore`). A picker
  that ignored the headers entirely would still show the same sequence.
- **The affordance is already shipped.** `ComboboxOption.group` renders a
  non-interactive `role="presentation"` header at each group transition
  (`px-(--spacing-control-x) pt-2 pb-1 font-mono text-[11px] font-semibold
tracking-wider text-(--el-text-eyebrow) uppercase`), and keyboard nav is
  unaffected because the header is not an option row. `WorkItemTypePicker` simply
  never set the field. **MOTIR-2633's change is one property per option, not a new
  component.**

### Q2 — hues: fourteen distinct is IMPOSSIBLE, so hue names the FAMILY

The palette holds exactly **seven** mutually distinct saturated hues and three
greys, and 2.7.4 spent all ten (its own token-block comment says so). There is no
eighth, and inventing one is forbidden by the colour rule. Reshuffling the ten
would be churn that regresses nothing into nothing.

So each newcomer takes the Tier-0 hue of the member **Amendment 1 named as its
nearest neighbour**, and the glyph carries the difference:

| member         | `--el-type-*` → Tier-0                             | shares with | glyph (lucide) |
| -------------- | -------------------------------------------------- | ----------- | -------------- |
| `copy`         | `--el-type-copy` → `--color-accent-teal`           | `content`   | `Type`         |
| `translate`    | `--el-type-translate` → `--color-accent-teal`      | `content`   | `Languages`    |
| `verification` | `--el-type-verification` → `--color-accent-orange` | `review`    | `BadgeCheck`   |
| `legal`        | `--el-type-legal` → `--color-charcoal`             | `decision`  | `Gavel`        |

Each gets its **own** `--el-type-*` token pointing at the shared Tier-0 var — so a
future palette can split them without touching a component, and
`WORK_ITEM_TYPE_META`'s per-member `hueVar` shape is preserved. The tokens land in
**`packages/design-system/theme.css`** (Tier 3), _not_ `app/globals.css`: the
design system was extracted after 2.7.4 wrote the original block.

**Why a shared hue costs nothing here:** colour was never the sole carrier. Every
chip renders its label and its glyph (finding #35), the filter chip summarises the
selection as text, and the picker row is label-first. A shared hue removes a
redundancy, not a signal.

### Q3 — the fourteen glyphs

The ten existing glyphs are unchanged. The four new ones are lucide 1.16.0 node
data copied verbatim into the mocks' `<defs>`, so the asset and
`WORK_ITEM_TYPE_META` cannot drift: `Type` (copy — a text cursor over a baseline),
`Languages` (translate), `BadgeCheck` (verification — "certified", distinct from
`review`'s `ClipboardCheck` at chip size), `Gavel` (legal). All four are verified
present in the installed `lucide-react`.

### Q4 — the chip at density: DRAWN, not asserted

`Verification` is the longest label in the set at 12 characters (previous longest:
`Research`, 8). `work-type-indicator.mock.html` panel 1 draws it in a real list
row (**PROD-51**) alongside `Translate` (**PROD-35**); the chip sizes to its
content with `white-space: nowrap` and the grid's chip column is content-width, so
neither wraps nor displaces the priority column.

The same panel re-types **PROD-34** ("Password-reset email — copy + template")
from `content` to `copy`, so Amendment 1's **specific-beats-general** precedence
rule is visible in a row rather than only described in a note. (That is a mock
row; no real work item is re-typed — MOTIR-2622's boundary excludes backfill.)

### The access path — three entrances, all drawn

1. **Create modal** — the Type field below Title (panel 1). Reached from the `+`
   in the top bar, or `c`.
2. **Work-item detail, core-fields rail** — the Type row, inline-edit on click
   (panel 5a). Reached by opening any work item.
3. **The work-item list filter bar** — **+ Add filter → Type** (panel 5d), the same
   facet `backlog-filter` and `board-filter` draw.

All three mount the same `WorkItemTypePicker`, so the grouping decision lands in
one component and reaches every entrance. **This design adds no route, page or nav
affordance** — the control already exists in all three places; what changes is
what is inside it.

### AC 7 — the measurement over `design/`, and every hit file's disposition

**The command in the card was wrong, and wrong in the direction that hides the
scope behind noise.** `grep -rc -- '--el-type-' design/` returns **119** files,
because `--el-type-{epic,story,task,bug,subtask}` are the **KIND** hues — a
different token family this story does not touch. The work-TYPE tokens are the ten
named after the enum members:

```bash
grep -rlE -- '--el-type-(code|design|test|content|research|review|decision|deploy|manual|chore)\b' design/
# → 22 files
```

22 is close to the 21 the card estimated, so the estimate was right and only the
command was wrong. Splitting those 22 by whether they **render** the set or merely
**declare** the tokens is what makes the disposition decidable:

```bash
# renders it:  var(--el-type-<member>)      declares it:  --el-type-<member>:
```

| #     | file                                                                                                                                                                                                                                                                                                                              | renders       | disposition                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `work-items/type-executor-picker.mock.html`                                                                                                                                                                                                                                                                                       | all 10        | **REDRAWN HERE** — the picker; now 14, grouped, both hosts, + panel 5                                                                                               |
| 2     | `work-items/work-type-indicator.mock.html`                                                                                                                                                                                                                                                                                        | all 10        | **REDRAWN HERE** — the chip/icon/legend; now 14 + two density rows                                                                                                  |
| 3     | `backlog/backlog-filter.mock.html`                                                                                                                                                                                                                                                                                                | all 10        | **REDRAWN HERE** — its Work-type facet enumerates the set and would have gone stale                                                                                 |
| 4     | `boards/board-filter.mock.html`                                                                                                                                                                                                                                                                                                   | all 10        | **REDRAWN HERE** — same facet, same reason                                                                                                                          |
| 5     | `ai-chat/onboarding.mock.html`                                                                                                                                                                                                                                                                                                    | 6 of 10       | **no change** — renders a SAMPLE of types in a generated tree, not the set; a sample stays true at 14                                                               |
| 6     | `ready/work-type-manual.mock.html`                                                                                                                                                                                                                                                                                                | 5 of 10       | **no change** — same; a sample of cards on the ready queue                                                                                                          |
| 7     | `roadmap/node-worktype.mock.html`                                                                                                                                                                                                                                                                                                 | 1 of 10       | **no change** — one `manual` node, a sample                                                                                                                         |
| 8     | `roadmap/design-notes.md`                                                                                                                                                                                                                                                                                                         | 1 (prose)     | **no change** — names `--el-type-manual` as an example token in prose                                                                                               |
| 9     | `shell/context-row.mock.html`                                                                                                                                                                                                                                                                                                     | 10 (CSS shim) | **no change** — a `.text-\(--el-type-*\)` Tailwind-utility shim block, no markup enumerates the set                                                                 |
| 10–22 | `ai-chat/ai-callout-menu` · `ai-chat/plan-change-planner-speaks` · `brand/brand-mark` · `cli-connect/cli-connect` · `cli-guide/cli-guide` · `github/github` · `repository-set/{repository-set,takeover,team-access}` · `roadmap/planning-origin-drill` · `settings/appearance` · `shell/top-bar` · `work-items/child-panel-graph` | **0**         | **no change** — each copies the Tier-3 token block into its own `:root` for self-containment but renders no work-type chip. Nothing in them goes stale at fourteen. |

Nothing is left unaccounted for: 4 redrawn, 18 explicitly unchanged with a reason
each. **The four that render the set are exactly the four the render script
exports**, so the next person to change this vocabulary has one script to run and
one table to check.

### Deliverable

Four assets under `design/`, each a complete three-file set — this
`design-notes.md` section · the `*.mock.html` source · the `*.png` full-page export
(Playwright chromium, light theme, `deviceScaleFactor: 2`, 1200 px wide) — plus
`scripts/render-work-item-types.mjs`, which renders all four and prints the Q1
measurement. Gates MOTIR-2633.

---

## ⭐ Design result panel (Story MOTIR-2664 · MOTIR-2669 — `design-result.mock.html`; the NOTE's bound added by MOTIR-3510)

`detail.pen` and the shipped item-detail page reserve NO design-result surface,
so the panel, its frame and its states are whole elements no design specifies —
the NONE-exists case. This asset closes that gate for MOTIR-2670.

**What it is for.** A `type: design` subtask's deliverable is three files in
`design/<area>/`. Until now the product showed none of them: to judge a design a
reviewer left Motir, found the pull request and opened raw files on GitHub. This
panel is where the design comes home.

### Placement + the access path

A `ContentSectionCard` in the item-detail **left column**, between
**Development** and **Children** — the same slot family as the acceptance panel,
and detail-page only for the same reason (the quick view is unchanged).

It renders on any LEAF with a current design result. On a `type: design` subtask
with none it renders the EMPTY state rather than disappearing: "no design
published" is worth stating on the card whose job was to produce one.

The panel is not a view, so it has no nav entry. A reviewer reaches a design
subtask two ways, both already shipped: the parent story's **Children** list, and
the **Relationships** panel of any card that is `blocked_by` the design — which
is how a UI code card's implementer arrives.

### Anatomy

| Element                                                | Primitive composed                                                                                       | Colour token                                           | Shape token                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| Section                                                | `ContentSectionCard` (`Card` + header grammar)                                                           | `--el-page-bg` on `--el-border`                        | `--radius-card`, `--spacing-card-padding` |
| Title / gloss                                          | header grammar                                                                                           | `--el-text` / `--el-text-secondary`                    | —                                         |
| `Current` chip                                         | `Pill`                                                                                                   | `--el-tint-mint` bg + `--el-text-strong` (finding #35) | `--radius-badge`, `--spacing-chip-*`      |
| Note strip                                             | —                                                                                                        | `--el-surface-soft` on `--el-border`                   | `--radius-input` (top corners)            |
| Rendered note _(earlier format — MOTIR-5494)_          | `MarkdownView` — `wmde-markdown motir-prose` over `lib/markdown/render.tsx`, the SINGLE shipped renderer | `--el-text` / `--el-text-secondary`                    | `--radius-input` (bottom corners)         |
| Wide table in the note _(earlier format — MOTIR-5494)_ | scroll container                                                                                         | `--el-border-soft`                                     | `--radius-input`                          |
| Frame strip                                            | —                                                                                                        | `--el-surface-soft` on `--el-border`                   | `--radius-input` (top corners)            |
| Mock frame                                             | `<iframe sandbox>`                                                                                       | `--el-border`                                          | `--radius-input`                          |
| Open in new tab                                        | `Button` secondary                                                                                       | `--el-page-bg` / `--el-border`                         | `--radius-btn`, `--height-btn-sm`         |
| Screenshot thumb _(earlier format — MOTIR-5494)_       | `AttachmentPreview` (lightbox reused as-is)                                                              | `--el-border` / `--el-surface-soft`                    | `--radius-input`                          |
| Provenance chips                                       | `provenance.mock.html` chip grammar                                                                      | `--el-muted` + `--el-text-secondary`                   | `--radius-badge`                          |
| Empty state                                            | —                                                                                                        | `--el-surface-soft` on `--el-border-soft`              | `--radius-input`                          |
| Failed-to-load state                                   | —                                                                                                        | `--el-tint-peach` + `--el-text-strong`                 | `--radius-input`                          |

### ⚠️ The mock frame — the measurement this asset exists to pin

**32rem (512px) tall, scrolling inside itself in BOTH axes.** A published mock is
a tall multi-panel document — `acceptance-panel.mock.html` is 48 KB of stacked
panels — so an unbounded frame would swallow a page that already has eight
sections. Panel 2 of the mock measures it against a 900px viewport.

- **Horizontal.** A mock wider than the content column scrolls INSIDE the frame.
  The page body never gains a horizontal scrollbar.
- **The escape.** _Open in new tab_ is the full-width read, and it is the only
  affordance the frame carries.
- **The sandbox.** `sandbox` with NEITHER `allow-scripts` NOR
  `allow-same-origin`. Nothing drawn here needs script inside the iframe.
  **Consequence, stated rather than discovered:** a mock that requires
  JavaScript to render appears inert. That is the intended trade — a design
  mockup is a static artifact, and the `.png` and the new tab remain.
- Reads go through `/api/attachments/<id>/content`, which 302s to a presigned URL
  on the OBJECT-STORE host, so the document is cross-origin to the app before the
  sandbox is applied at all (the design-result decision record (MOTIR-2665) §5).

### ⚠️ AMENDMENT (MOTIR-3510) — the NOTE carries the same bound, and it is INHERITED

**The note is 32rem too, in a container of its own — the same measurement, the
same grammar, nothing re-derived.** The paragraph above measured the frame and
this asset said nothing about the note's height; the mock drew the note as the
words _"Rendered note (first paragraphs) …"_ in every panel, so the note shipped
with no `max-h`, no `overflow-y`, no border and no surface, and a real
`design-notes.md` section rendered on the order of **3,000–8,000px** — six to
sixteen times what the frame beside it is allowed. Everything below the note was
pushed that far down: the frame, the screenshot thumbs, the provenance chips, and
then Children, Attachments and Activity below the panel.

**Why the bound is inherited rather than decided.** The frame's own argument — _a
published artifact is a tall document, and an unbounded one swallows a page that
already has eight sections_ — is a statement about published artifacts, not about
iframes. The note is the taller of the two in practice: the publisher ships ONE
`##` section (MOTIR-3145) capped for rendering at 64 KiB
(`lib/services/designEvidenceService.ts`, `NOTE_MD_CAP_BYTES`), and this file's
own sections run 200–350 lines. So the note takes the frame's number, not a new
one. **A DIFFERENT number — a taller note than the frame, a strip carrying
controls — is a design decision this amendment does not make; it would be its own
card.**

**What that changes, exactly:**

|                                    |                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the bound**                      | `FRAME_HEIGHT` — ONE constant in `DesignResultPanel.tsx`, referenced by both artifacts rather than typed twice, so they cannot drift apart. `overflow-y` is added; the existing horizontal scroll stays for wide tables                                                                                                                                          |
| **the container**                  | the frame strip's grammar, token for token — an `--el-surface-soft` strip (`--radius-input` top corners, no bottom border) over a body carrying `--radius-input` bottom corners and an `--el-border`                                                                                                                                                             |
| **the strip's content**            | the note's SOURCE, mirroring the frame strip's source-path treatment. Nothing else — the note's only affordance stays the truncation notice and its `note_file` download link, which sit BELOW the container, where they already were                                                                                                                            |
| **the note's typography**          | the SHIPPED prose styles. The panel applied a `markdown-body` class that **no stylesheet in the repo or in any dependency defines**, so the note rendered under Tailwind preflight: no heading scale, no list markers, no table rules. It now renders through `MarkdownView` (`wmde-markdown motir-prose`), the same wrapper the description and explanation use |
| **what panel 2 now measures**      | BOTH artifacts, drawn at TRUE scale in the 900px ruler                                                                                                                                                                                                                                                                                                           |
| **the drawing of everything else** | UNCHANGED — placement, the access path, the three states, the sandbox, the truncation notice, the provenance chips                                                                                                                                                                                                                                               |

**The measurement panel 2 now reports, and it is a finding rather than a miss.**
Two 32rem artifacts do not both fit above a 900px fold: the note fills the fold
and the frame begins just under it, one ordinary scroll away. That is the correct
trade against the alternative it replaces, where the frame began three to eight
THOUSAND pixels down — and it is what "the three artifacts read as one result
rather than a queue" costs at this measurement. The reader who wants all three at
once scrolls the artifacts, not the page.

**Why neither half was visible to review, which is the reusable part.** The mock
drew the note as a placeholder one-liner and the guard asserted a class NAME
rather than an effect. **A placeholder cannot be measured, and a class assertion
cannot notice that the class is inert.** So panel 1 now draws the note at real
length — one `##` section of this very file, overflowing its bound on purpose —
and `tests/components/design-result-panel.test.tsx` asserts the rendered bound
and the prose class that actually styles it.

### States — THREE, not five

the design-result decision record (MOTIR-2665) §2 decided the feature has **no entitlement
axis**: no plan gate, no org toggle. So unlike the acceptance panel there is **no
upsell state and no toggle state to draw**.

1. **Published** — note, frame, screenshot, provenance.
2. **Nothing published yet** — the empty state. This is the MOST-SEEN state for a
   long while (every design subtask that shipped before the feature has none), so
   it reads as "this design predates the feature", never as an error, and it says
   where a result comes from so nobody hunts for an upload button.
3. **Failed to load** — the frame only. The note and screenshot still render; the
   frame offers a Retry and the new-tab escape. Never a blank rectangle, and it
   never takes the rest of the panel down with it.

Loading applies to the FRAME alone: the note and screenshot render server-side,
and only the signed content URL resolves on the client.

### Superseded, and the truncation notice

Every push to a design PR republishes, so a card accumulates history. The panel
shows the CURRENT result and says when it landed.

**Prior results are NOT reachable from this panel in this iteration** — stated
here so the next reader does not take the absence for a bug. The rows are
retained (superseded, not deleted), so a history affordance is a later addition
needing no migration.

The note carries a truncation notice when the ADR's 64 KiB inline cap bites
("Shown to 64 KB · N of M sections omitted"), linking the `note_file` asset that
always carries the complete text. That notice is the visible half of the cap: the
panel never renders a 300 KB per-area document, and nothing is lost.

### Tokens / a11y

- Colour ONLY via Tier-3 `--el-*`; shape via the element-semantic radius /
  spacing / height tokens. No Tier-0 `--color-*`, no raw `rounded-*` / `p-*` /
  `h-*`, no invented hue.
- Muted copy sits on the white card, never on `--el-surface` / `--el-muted` /
  `--el-surface-soft` (the AA table in `CLAUDE.md` — `--el-text-muted` clears AA
  only against the page/card).
- The iframe carries a `title` naming the mock's source path, so it is
  announced rather than read as an unlabelled frame.
- The screenshot thumb is a button into the shipped lightbox; the frame's
  new-tab affordance is a real link.

### Out of scope (documented extension slots)

- **The runtime approval gate.** Approve / request-changes, the "for review"
  state, holding dependents and the revise-chat are Story MOTIR-693's (9.2). This
  panel is READ-ONLY and exposes no control that writes. 9.2's approval surface
  COMPOSES this panel rather than deploying the mock to a preview host.
- **History.** See above — deliberate, and named.
- **The quick view.** Unchanged, matching the acceptance panel's precedent.

---

## ⭐ Design result panel — WHAT TO REVIEW (Story MOTIR-5488 · MOTIR-5494 — `design-result--what-to-review.mock.html`)

**A delta, and the first asset drawn under the two-file set.** This section AMENDS
§ _⭐ Design result panel_ above and draws its change in
`design/work-items/design-result--what-to-review.mock.html`, beside the
unchanged `design/work-items/design-result.mock.html`. Neither the earlier mock
nor the earlier section is edited — they record the panel as first drawn. No
image export ships with this asset (`docs/decisions/design-result.md`
AMENDMENT 4).

**The rule it draws.** A result is the changed mock(s) with the note ONE LINK
away: no inline note, no screenshot strip (AMENDMENT 4 Q1, Q5, Q6). The earlier
anatomy rows _Rendered note_, _Wide table in the note_ and _Screenshot thumb_ are
marked _earlier format_ above.

**Rendered first.** The shipped `DesignResultPanel` was bundled from its own
source (the real component, `packages/design-system/theme.css`, `app/globals.css`,
headless chromium) with three DTOs — an older result, a new-format result
(`mock` + `note_file`, no `noteMd`) and none. **Fed a new-format result, the
shipped panel draws the mock frame and NO note at all**: its only note is the
inline `noteMd`, so the `note_file` asset a new publish carries is invisible.
That is the gap panel 1 closes. The frame strip, the frame, the provenance chips
and the empty state are composed from that render, unchanged except where named.

### The panels

| #   | State                                                  | What changes                                                                                                                                                                                                      |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A current result, one mock                             | The mock frame leads; the **note link row** sits at the BOTTOM, under the frame and above the provenance chips. Nothing inline.                                                                                   |
| 2   | Several delta mocks                                    | One shipped frame per `mock`, in publish (`position`) order, 20px apart; a **count line** above the first frame; still ONE note row, under the last frame.                                                        |
| 3   | The note file reclaimed (`url` null)                   | The row stays and names the note; its link is replaced by _No longer stored_ — never a link that 404s.                                                                                                            |
| 4   | An older stored result (inline `noteMd`, `image` rows) | An **Earlier format** pill + a one-line reason, then the mock frame, then a **Files** list under it: the note row and one row per screenshot, each a file link. No rendered Markdown, no thumbnails, no lightbox. |
| 5   | Empty, on a design work item                           | Shape unchanged; the body copy says a result exists only when other work waits on the design.                                                                                                                     |
| 6   | Inside the approval overlay — NO open linked PR        | The frame is not redesigned: band 2 holds panel 1 (or 2, 3, 4) — the frame(s), then the note row under them. Verbs stay below the port. A card WITH an open linked PR is state 8, not this.                       |
| 7a  | One open linked PR, at rest                            | No standalone Design result section. The Development block reads, top to bottom: the **design-result slot** (heading, provenance, frame(s), note row), How to test, then the PR row and its link caption.         |
| 7b  | Two open linked PRs in two repositories                | Every row is listed, in any repository, with no cap. The slot renders ONCE, above How to test and above every row — the result belongs to the card, not to a pull request.                                        |
| 7c  | 7b while the approve-to-merge gate is awaiting         | `DevelopmentGateFrame` wraps the whole block — slot, How to test and rows — as ONE port. Bands 1 and 2 only: no verbs are drawn, because they are MOTIR-4909's (`design/github/github.mock.html` Panel 12c).      |
| 8   | The approval overlay for that card                     | Band 2 is state 7's block, unchanged. Band 3 is Panel 12c's _Request changes_ · _Approve and merge_ with its consequence line — cited, not designed here. No design band and no design verbs.                     |

A result with BOTH an inline `noteMd` and no `note_file` cannot come from a
publish (§1 always shipped the companion); if one exists it renders panel 4 with
the note row in its panel-3 state.

### Anatomy — the new elements

| Element             | Primitive composed                                                 | Colour token                                                                                                     | Shape token                                                     |
| ------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Note link row       | a bordered row (the frame strip's grammar), `FileText`             | `--el-page-bg` on `--el-border`; label `--el-text`; path `--el-text-secondary`                                   | `--radius-input`, `--spacing-control-x` / `--spacing-control-y` |
| Open note link      | anchor, `ExternalLink` 12px, `target="_blank"`                     | `--el-link` — on `--el-page-bg`, which is why the row is NOT `--el-surface-soft`                                 | —                                                               |
| No longer stored    | text                                                               | `--el-text-secondary`                                                                                            | —                                                               |
| Count line          | text, 12px                                                         | `--el-text-secondary`                                                                                            | —                                                               |
| Earlier format pill | `Pill`                                                             | `--el-tint-yellow` + `--el-text-strong`                                                                          | `--radius-badge`, `--spacing-chip-x` / `--spacing-chip-y`       |
| Files caption       | section label (uppercase 12px, the old _Screenshot_ label's style) | `--el-text-secondary`                                                                                            | —                                                               |
| Screenshot file row | the note link row, `FileImage`                                     | as the note link row                                                                                             | as the note link row                                            |
| Frame strip link    | the shipped anchor                                                 | **`--el-text`**, not the shipped `--el-link`: `--el-link` on `--el-surface-soft` is 4.37:1, under AA (MOTIR-453) | unchanged                                                       |

**Order, and why (revised on review, 2026-09-14):** mock(s) → note link row →
provenance. The note is NOT the first thing a reviewer meets. The mock is what the
approval is about; the note is written for the agents that build to the design, and
a reviewer may never open it — so it sits at the bottom, one link away, and nothing
is drawn above the first frame except the count line when there are several.

The note link's `href` is the `note_file` asset's own `url` — the authenticated
`/api/attachments/<id>/content` route — opened in a new tab (AMENDMENT 4 Q5). A
screenshot row does the same with its `image` asset's `url`.

### Copy

| Key (`designResult.*`) | `en`                                                                                                                                                                                             | `zh`                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `note`                 | Design note                                                                                                                                                                                      | 设计说明                                                                                                          |
| `openNote`             | Open note                                                                                                                                                                                        | 打开说明                                                                                                          |
| `noteGone`             | No longer stored                                                                                                                                                                                 | 已不再保存                                                                                                        |
| `mockCount`            | {count, plural, other {# mocks — the panels that changed}}                                                                                                                                       | {count} 个稿件 — 发生变更的面板                                                                                   |
| `earlierFormat`        | Earlier format                                                                                                                                                                                   | 旧格式                                                                                                            |
| `earlierFormatBody`    | Published before results became what to review — its note and screenshot are kept as files.                                                                                                      | 发布于结果改为只展示待审内容之前 — 其说明和截图以文件形式保留。                                                   |
| `files`                | Files                                                                                                                                                                                            | 文件                                                                                                              |
| `screenshot`           | Screenshot                                                                                                                                                                                       | 截图                                                                                                              |
| `openFile`             | Open file                                                                                                                                                                                        | 打开文件                                                                                                          |
| `empty.bodyDesign`     | A design result is published only when other work waits on this design — its agent then publishes the mock and the note. With nothing waiting, the pull request is where the design is reviewed. | 只有当其他工作等待此设计时才会发布设计结果 — 届时由其代理发布稿件和说明。若没有等待的工作，设计在拉取请求中评审。 |

The count line renders only when there are two or more mocks. `noteTruncated` and
`downloadNote` are no longer drawn for a new result (a new row has no inline
note); `screenshots` is replaced by `files` + `screenshot`.

### GIVES / TAKES

- **GIVES [MOTIR-5498](motir:cmu1hrmyh0020hutxio6hqh30)** (the panel) exactly
  panels 1–6, the copy table above in both locales, and ONE change to a shipped
  element — the frame strip link's ink. It TAKES nothing that card names; its
  title already scopes states 1–6, so its size stands (the copy is nine keys, the
  ink is one class).
- **GIVES [MOTIR-5500](motir:cmu1hrn2z0024hutxrpnl8kns)** (the E2E) the accessible
  names to assert: the link _Open note_, and no `img` in the port.
- **TAKES nothing** from the publish contract, the dispatch prompt or the approval
  frame: none of them draws the port.

### States 7–8 — a design card with open linked pull requests (Q8)

**The rule.** `docs/decisions/design-result.md` AMENDMENT 4 Q8: a design card with
at least one OPEN linked pull request is decided by the approve-to-merge gate, one
gate over its whole delivery set, and raises no `design_result` gate. Its result
therefore renders INSIDE the Development block, and the card has no standalone
Design result section. Approving merges every pull request in the block.

**Rendered first.** The block is composed from the design of record, not redrawn:
`design/github/design-notes.md` §20 and `design/github/github.mock.html` Panel 12c,
rendered headless and checked against the shipped `DevelopmentSectionBody` in
`components/github/DevelopmentSection.tsx` — rows, then the link caption, then
`HowToTestBlock`, wrapped in `DevelopmentGateFrame` when the merge gate is
`awaiting`. The mock copies that asset's row, pill, How to test and frame rules
verbatim, scoped under `.devblk` so they cannot collide with this mock's own
`.card` / `.frame` / `.note-row`.

**Where the slot sits (revised on review, 2026-09-14: "design result and how to
test should be before the PRs").** Inside `DevelopmentSectionBody`, when the block
holds a design result, in this order:

1. **the design-result slot** — the mock frame(s), then the note link;
2. `HowToTestBlock` (unchanged);
3. every PR row, in the block's existing order, any number, any repository;
4. the link caption, still directly under the rows.

So the design slot and `HowToTestBlock` render ABOVE the rows. What to review and
how to test it lead; the pull requests the approval merges follow. The rows and
caption sit behind a `--el-border-soft` rule (`.dvb-prs` in the mock), the
separator How to test used to carry.

**A block with NO design result is unchanged.** It keeps today's order: rows,
caption, then `HowToTestBlock`, as §20 draws it. The reorder is conditional on the
slot rendering, never a change to every Development block.

**In the clamped port** (7c, before _Expand_), the rows now sit below the fold on
a design card. That is the intended reading order, and every row is one _Expand_
away. Band 1's "N pull requests" line still counts them.

The slot's body is panels 1–4's body, unchanged: the count line when there are
several mocks, the frame(s), then the note row at the bottom. The provenance chips
collapse to one line under the slot heading.

**One component, three hosts.** Because the slot lives in `DevelopmentSectionBody`,
it appears identically on the item page, in the quick-view peek (both mount
`DevelopmentSection`) and in the approval overlay's port (MOTIR-5438 / MOTIR-5439).
No host draws its own copy, and no host renders the standalone Design result
section for such a card.

**No verbs in the frame yet.** Until MOTIR-4909 ships, `DevelopmentGateFrame`
passes `verbs={[]}`, so 7c draws bands 1–2 only. Panel 8 shows Panel 12c's band 3
for orientation; it is 4909's design.

#### Anatomy — the new elements

| Element              | Primitive composed                                           | Colour token                                                                   | Shape token |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------- |
| Design-result slot   | a `role="group"` region, `aria-label` = `designResult.title` | none — it is first                                                             | —           |
| Rows group           | the shipped rows + caption, wrapped when the slot renders    | top rule `--el-border-soft`                                                    | —           |
| Slot heading         | text, 13px semibold                                          | `--el-text`                                                                    | —           |
| Slot provenance      | text, 12px; key and short sha (sha monospace)                | `--el-text-secondary`; sha `--el-text-identifier`                              | —           |
| Frame / note in port | panels 1–4's frame and note row                              | background `--el-card`, so `--el-link` keeps AA inside the port's soft surface | unchanged   |

Everything else — rows, pills, the caption, How to test, the frame bands — is
§20's and keeps its tokens.

#### Copy

| Key                                  | `en`                                                                   | `zh`                                            |
| ------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------- |
| `github.development.glossWithDesign` | Pull requests, the design and how to test them · live PR and CI status | 拉取请求、设计及其测试方法 · 实时 PR 与 CI 状态 |
| `designResult.title` (reused)        | Design result                                                          | 设计结果                                        |
| `designResult.slotProvenance`        | Published by {key}                                                     | 由 {key} 发布                                   |

`glossWithDesign` replaces `gloss` only when the slot renders. Every other string
in states 7–8 is an existing key.

#### GIVES / TAKES — states 7–8

- **GIVES [MOTIR-5498](motir:cmu1hrmyh0020hutxio6hqh30)** (the panel) panels 7a–7c:
  - the slot inside `DevelopmentSectionBody` in the order above: slot, then
    `HowToTestBlock`, then the rows and caption, only when a design result
    renders (a block without one keeps rows, then How to test);
  - the standalone section suppressed while an open linked PR exists;
  - the two copy keys and the slot tokens.
- **GIVES [MOTIR-5534](motir:cmu1mcnrr000ai0txplyb9iqz)** (no `design_result` gate)
  the visible consequence of its rule: on such a card, no design verbs and no design
  band are drawn anywhere. It TAKES nothing from this asset.
- **GIVES [MOTIR-5438](motir:cmu118c4s0009hytxgtmyfeg8)** (the overlay design)
  state 7 to compose as band 2 on a design card. It draws nothing new for the design.
- **GIVES [MOTIR-5439](motir:cmu118c7e000bhytxn9l5u1v0)** (the overlay read) the
  field the port reads: the current `DesignEvidenceDTO` beside the pull requests and
  `HowToTestDto`, or `null`.
- **TAKES from [MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2)** band 3, its verbs,
  its consequence line and its states. None is designed here; 7c draws none.

## ⭐ The repository SET on the work-item DETAIL page (Story MOTIR-2725 · MOTIR-2413 — `repository-set.mock.html`)

**Asset:** `repository-set.mock.html` + `repository-set.png` (10 panels: 0 the door · 1 held ·
2 delivered · 2b unknown branch · **2c the five delivery states** · **2d the destination** ·
3 one repo · 4 none · **5 a `proposed` row** · 6 editing).
**Gates:** MOTIR-2415 (implement, detail) → **MOTIR-3042** (the reference redraw).
**Inherited by** MOTIR-2414 (quick view), which COMPRESSES this treatment and may not re-decide
any of it.

### ⭐ REDRAWN against the REFERENCE model (Story MOTIR-2732 · MOTIR-3038, 2026-08-19)

A card used to name its repository as a WORD. It now points at a `project_repository` ROW — an
object with an id, a role, a label, an establish state and a page of its own (MOTIR-3037's
amendment to `docs/decisions/work-item-repository-set.md`). Three things follow, and each is drawn:

**1. The repository is a LINK.**

| element                | token / role                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| repository name (link) | `text-(--el-link)` + `underline underline-offset-2` — the shipped link idiom                                                |
| link destination       | `/settings/project/repositories#<name>` — the project's OWN settings row                                                    |
| delivery glyph         | unchanged: `--el-success` · `--el-icon-muted` · `--el-warning`, each with its own SHAPE so the row never rides colour alone |
| `primary` chip         | unchanged `dsPillNeutral` (`--radius-badge`, `--spacing-chip-x/y`)                                                          |
| ROLE chip              | `dsPillNeutral`, after the name — a category, not an identity                                                               |
| establish STATE chip   | `dsPillWarning` (`--el-tint-peach` fill, `--el-text-strong` ink) — shown ONLY when the row is not established               |
| count caption          | unchanged `text-(--el-text-muted)` on the card surface (AA: 4.54:1 on white)                                                |

**Where the link GOES, and why it is not GitHub** (the DRAW-THE-ENTRANCE rule, panel 2d). It goes
to that repository's row on `/settings/project/repositories`, anchored and highlighted. Two
reasons, the second decisive: the card points at a ROW, so the row is what "the repository" now
names; and **a `proposed` row has no host repository at all**, so a link to GitHub would be dead
for exactly the state this redraw exists to express. The host is one further click, from the
link-out already on that row — panel 2d draws the whole path rather than the affordance alone.

**2. The FIVE delivery states, each with its own copy** (panel 2c; MOTIR-3037 §A5 decides what
each MEANS, this asset decides what each row SAYS). Only four hold the card:

| state               | row copy                                  | pill            | holds? | the reader's next action           |
| ------------------- | ----------------------------------------- | --------------- | ------ | ---------------------------------- |
| `delivered`         | the pull request's own title              | `dsPillDone`    | no     | nothing                            |
| `awaiting`          | "No pull request yet"                     | `dsPillNeutral` | yes    | open / merge the PR                |
| `unknown`           | "Merged, but the branch was not recorded" | `dsPillWarning` | yes    | say which branch it landed on      |
| **`unestablished`** | **"Repository not created yet"**          | `dsPillWarning` | yes    | **the establish step, NOT GitHub** |
| **`excluded`**      | **"Skipped for this project"**            | `dsPillNeutral` | **no** | nothing — deliberately code-less   |

`unestablished` is deliberately NOT "Awaiting": awaiting promises a pull request someone could
open, and a `proposed` / `creating` row has no default branch to open one against. `excluded` is
the one state that does not hold the card (ADR `project-repository-set.md` §4.3 — a skipped row
leaves the project explicitly code-less), and it is drawn quiet for exactly that reason.

**3. `--el-text-muted` on `--el-surface-soft` is GONE, and it was MOTIR-3014 that removed it.**
That card landed first (motir-core#2126, merged 2026-08-19T00:12:38Z) and replaced the failing
4.34:1 pair with `--el-text-secondary` (6.51:1) across these files. **This redraw KEEPS what it
did** — the card's own instruction for that branch — rather than re-deriving the fix. No new
ink/surface pair is introduced by the reference treatment: the link uses `--el-link`, and the two
new chips reuse the shipped `dsPillNeutral` / `dsPillWarning` recipes unchanged.

### Why the asset exists

The surface table above had no repository row. `work_item.targetRepo` has been readable only from
the dispatch payload or the database since MOTIR-1804, and MOTIR-2725 turns it into an ordered SET
whose elements each carry a **delivery state the completion gate reads** — so the surface has a
second job the single pin never had, and neither `detail.pen` nor `CoreFieldsPanel.tsx` draws
either half.

### What this COMPOSES, and what is new

Every element below is the shipped one, reused markup-for-markup. **It was RENDERED before it was
drawn**: the real `FieldCard` and the real `DevelopmentSectionBody` were bundled and screenshotted
against the real `app/globals.css`, and the mock reuses the class strings that render produced. The
mock's tokens are EXTRACTED from `packages/design-system/theme.css` by script and its icons from the
installed `lucide-react`, so no hex and no path is hand-typed and the asset cannot drift.

| Element                                                                    | Source                                                                         | Redrawn?                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| The rail card chrome                                                       | `app/(authed)/items/[key]/_components/FieldCard.tsx`                           | No — verbatim                 |
| The pull-request rows, their state + CI pills, the meta line, the link-out | `components/github/DevelopmentSection.tsx` (`PR_STATE_META` / `CI_STATE_META`) | No — verbatim                 |
| The empty state                                                            | the same file's `EmptyState` branch                                            | No — verbatim                 |
| The `primary` / `role` chips                                               | `components/ui/Pill.tsx` `tone="neutral"`                                      | No                            |
| The rail's own grammar + order                                             | `CoreFieldsPanel.tsx`, `provenance.mock.html`                                  | No                            |
| **A Development row for a repository with NO pull request yet**            | —                                                                              | **YES — the one new element** |

### The five questions, answered

#### Q1 — the SET, drawn, and how the PRIMARY is distinguished

One row per repository **in the stored order**, top to bottom, inside a single rail `FieldCard`
labelled **Repositories**. Order is shown by position and nothing else — no ordinals, no drag
handles.

**The primary is element 0, and it wears a neutral `Pill` reading `primary`.** Two equal chips would
throw away the only asymmetry the data has: element 0 is the repository a dispatch actually runs in
(`resolveDispatchRepo`, ADR §2). The chip is drawn **only when the card carries more than one
repository** — on a one-element set there is nothing to distinguish it from, and the chip would be
noise (panel 3).

⚠️ **The asymmetry is real but the guarantee is weak, and the design has to carry that.** An author
who never thought about order still produces a first element (ADR §1.2). That is precisely why the
primary is labelled rather than merely first: a reader must be able to SEE which repository a
dispatch would use, and correct it.

#### Q2 — per-repository DELIVERY state, and the division of labour

**The rail says WHERE and WHETHER. The Development section says WHICH pull request.** Both, with one
vocabulary and no overlap:

- **The rail** carries a leading state glyph per row — the one bit the completion gate reads:

  | State     | Glyph                  | Colour            | Means                                                        |
  | --------- | ---------------------- | ----------------- | ------------------------------------------------------------ |
  | Delivered | `circle-check`         | `--el-success`    | a linked PR merged onto THIS repository's own default branch |
  | Awaiting  | `circle-dashed`        | `--el-icon-muted` | no such merge — usually no pull request yet                  |
  | Unknown   | `circle-question-mark` | `--el-warning`    | a merged PR whose base branch Motir never recorded           |

  Under the rows, one muted count line: _"1 of 2 delivered. `motir-ai` is outstanding."_ It collapses
  to _"Both delivered."_ when the set is satisfied and **disappears entirely on a one-element set**.

- **The Development section GROWS A ROW** for every repository the card carries that has no linked
  pull request — same row grammar, dashed border, `--el-surface-soft` fill, the title slot reading
  **"No pull request yet"**, the meta line carrying the repository, and one `Awaiting` pill. **This is
  the answer to the card's harder question, and it is the only new element in the asset**: "no pull
  request yet" is exactly the state the completion gate holds an item for, and the shipped section has
  nothing to render for it today (verified in the render — see `repository-set.png` panel 1 against
  the shipped section's own output).

  A merged PR whose base was never recorded gets the same dashed row with **"Merged — branch not
  recorded"** and an `Unknown` pill (panel 2b), because a null base reads as UNKNOWN in both
  directions (MOTIR-2729) and the surface must not assert a branch Motir does not know.

- **The big `EmptyState` still shows**, unchanged, only when the item has no linked pull request AND
  carries no repositories (panel 4). A card that carries repositories always has rows.

**Why both surfaces and not one.** A reader asking _"is this finished?"_ reads the rail — a list of
three glyphs answers it in one glance. A reader asking _"what's the PR?"_ reads Development. Putting
the delivery state only in Development would mean scrolling the left column to learn where a card
ships; putting the pull requests in the rail would rebuild a section that already exists, in 288px.

#### Q3 — the states that survive from the pin

- **A NAME** (`motir-core`) — `--el-text`, `font-mono` (it is a directory name the CLI keys on).
- **A ROLE whose repository does not exist yet** — panel 5. ⚠️ **Corrected against the ADR:** the
  card assumed a role could be an ELEMENT of the set. `docs/decisions/work-item-repository-set.md`
  §1.3 keeps `targetRepoRole` **singular** and complementary to the primary, because two parallel
  scalar lists cannot represent an element whose name is known and whose role is not. So the role is
  not a list row: it is what the card shows when the NAME set is empty and a role was recorded. Drawn
  muted, with a `role` chip and the caption _"No repository recorded yet — this card was planned for
  the `api` role, whose repository has not been created."_ **It takes NO delivery glyph** — `Awaiting`
  would promise a pull request that cannot exist, because a role has no repository, therefore no
  default branch.
- **The EMPTY set** — Q4 below.

#### Q4 — the EMPTY set, and editing

**Empty (panel 4).** The value reads **`None`** — the shipped word every unset rail field already
uses (`issueViews.none`, the Sprint field's own sentinel), so the product does not learn a second
word for nothing. Under it, one muted line: **"Optional — not every card ships in a repository."**
That line is what makes the state read as deliberate rather than as a hole, and it is the whole
treatment: **no warning tint, no `+ Add repository` call to action, no required marker, no
asterisk.** The chevron is the identical affordance every editable rail field carries, so the field
is not singled out.

**Editable — YES, on the detail page (panel 6).** The rail is already a WRITE surface (MOTIR-2561),
so "read-only because it is a rail" is not available; and the write layer validates every element
against a bounded project domain, so this is a picker and never free text. The editor opens under the
same chevron, in place, and is a **two-column list: a checkbox for membership, a radio for the
primary.**

⚠️ **The only ORDER decision a person makes is which repository is primary.** That is the only
position the data acts on — element 0 is what dispatch resolves and nothing reads position 1 or 2 —
so a drag handle in a 288px rail would be interaction cost for a distinction with no consequence. The
stored order is primary-first, then the project's own repository-set order. This constrains the UI
only; the API accepts any order (ADR §3).

Per `CLAUDE.md`'s inline-edit rule, the success response IS the confirmation: the cell keeps its
optimistic value and **no `router.refresh()` fires against it**.

#### Q5 — the `decision` card: a PLANNING CONVENTION, not a display or validation rule

**The field renders identically for every `type`, including `decision`** (panel 5, right).

Rung 2 decided this, not taste. **MOTIR-2400 is a `type: decision` card pinned to `motir-core` that
shipped an ADR there**, and MOTIR-2726 — this story's own decision card — does the same: its
deliverable is a file, in a repository, and that repository is a true fact about the card. A DISPLAY
rule would hide something true. A VALIDATION rule would reject a correct write and strand existing
rows.

So the rule lives one level up, in the planner: a decision that is not repo-scoped simply carries no
repository, and the empty state above is how it says so. **Nothing happens to already-pinned decision
cards** — they render their repository, exactly as MOTIR-2400 does today.

### The access path — the field's POSITION is its door (panel 0)

The field has no button, no menu item and no tab, so its access path is where it sits, and panel 0
draws it in place with its neighbours dimmed: **after Estimate, before the collapsed Provenance
disclosure** — last of the always-visible rail fields.

Two reasons, both about when it is read: it is consulted at DISPATCH and REVIEW time rather than at
triage time, so it must not push Status, Assignee or Priority down the rail; and it is more actionable
than provenance — it gates completion — so it stays expanded rather than joining that disclosure.

Shipped rail order it lands in (`CoreFieldsPanel.tsx` on `origin/main`): Status · (session branch) ·
Type · Work type · Executor · Priority · Assignee · Reporter · Parent · Labels · Components · Due date
· Sprint · Story points · Estimate · **Repositories** · Provenance (collapsed).

### Copy — the exact strings

| Slot                     | String                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Field label              | `Repositories`                                                                                                   |
| Empty value              | `None`                                                                                                           |
| Empty caption            | `Optional — not every card ships in a repository.`                                                               |
| Primary chip             | `primary`                                                                                                        |
| Role chip                | `role`                                                                                                           |
| Role caption             | `No repository recorded yet — this card was planned for the {role} role, whose repository has not been created.` |
| Count caption (partial)  | `{n} of {total} delivered. {repo} is outstanding.`                                                               |
| Count caption (complete) | `Both delivered.` / `All delivered.`                                                                             |
| Count caption (unknown)  | `{repo} merged, but Motir has no record of which branch.`                                                        |
| Awaiting row title       | `No pull request yet`                                                                                            |
| Awaiting row pill        | `Awaiting`                                                                                                       |
| Unknown row title        | `Merged — branch not recorded`                                                                                   |
| Unknown row pill         | `Unknown`                                                                                                        |
| Editor column heads      | `On` · `Primary`                                                                                                 |
| Editor caption           | `The primary is the repository a dispatch runs in.`                                                              |
| Delivery glyph tooltips  | `Delivered` · `Awaiting` · `Unknown`                                                                             |

Every string needs its `messages/en.json` key AND its `zh` counterpart in the same PR (the parity
gate). A string not in this table is a finding against this card, not a decision for MOTIR-2415.

### Tokens / a11y

- Colour is `--el-*` only: `--el-success` · `--el-warning` · `--el-icon-muted` · `--el-text` ·
  `--el-text-muted` · `--el-text-secondary` · `--el-text-identifier` · `--el-border` ·
  `--el-border-strong` · `--el-surface` · `--el-surface-soft` · `--el-chip-bg` · `--el-chip-border` ·
  `--el-tint-mint` / `--el-tint-sky` / `--el-tint-peach` / `--el-tint-rose` · `--el-accent` ·
  `--el-accent-text`. **No Tier-0 `--color-*`, no invented hue.**
- Shape is element-semantic only: `--radius-card` · `--radius-control` · `--radius-badge` ·
  `--spacing-control-x/y` · `--spacing-chip-x/y` · `--shadow-card`. No raw `rounded-*` / `p-*` / `h-*`
  except the arbitrary sizes the shipped components already emit (`h-[17px]`, `text-[13.5px]`).
- **State never rides colour alone.** Each of the three delivery states has its own GLYPH SHAPE
  (solid check · dashed circle · question mark) as well as its own hue, and each carries a `title`.
  The dashed BORDER on an awaiting row is a redundant second cue beside the muted title text and the
  pill — not the only carrier of the state.
- The delivery glyph is decorative to a screen reader; the row's accessible content is the repository
  name plus its state word, so the list reads as _"motir-core, delivered, primary"_ rather than as a
  bare name with a coloured dot.
- **⚠️ THE INK IS SCOPED BY THE SURFACE UNDER IT, and the awaiting row is the case that gets this
  wrong (MOTIR-3014).** The awaiting / not-recorded rows are the only elements in this asset that
  paint on a TINT (`bg-(--el-surface-soft)`, the dashed placeholder box); everything else sits on the
  white card. `--el-text-muted` is **4.34:1 on `--el-surface-soft`** — it fails AA — and clears only
  on the white page/card, at 4.54:1 (`CLAUDE.md`'s measured table, MOTIR-2455). So on those rows the
  repository name is **`--el-text-secondary` (6.51:1)**, not muted, and the same holds for any element
  this asset later moves onto `--el-surface` / `--el-surface-soft` / `--el-muted`. Muted copy in this
  asset belongs on the white card only. The first revision of this asset shipped the failing pair, the
  implementing component copied it from here, and the code-side `inkContrastLint` caught the component
  while the asset stayed on `main` — which is why `tests/design-ink-contrast.test.ts` now measures the
  design tree too.

### Out of scope

- The quick-view compression — **MOTIR-2414**, which inherits every decision above and may not
  re-open one; a disagreement is a finding against this card.
- The Development section's other content, the explicit-link affordance, and the rail's other fields —
  untouched.
- Storage, dispatch and the completion rule — `docs/decisions/work-item-repository-set.md`
  (MOTIR-2726). This design READS them.

---

## ⭐ The DELIVERY SET on the work-item DETAIL page (Story MOTIR-3655 · MOTIR-3691 — `delivery-set.mock.html`)

**Asset:** `delivery-set.mock.html` + `delivery-set.png` (4 panels: 1 the case today's vocabulary
gets wrong · 2 both merged · 3 merged but not onto trunk · 4 one delivery, unchanged).
**Gates:** MOTIR-3660 (the read surface), which may not start before this is approved.
**EXTENDS** `repository-set.mock.html` above — same rail, same Development grammar, same three
glyphs. It re-decides nothing that asset settled.

### Why it exists — a case the shipped vocabulary answers WRONGLY

MOTIR-3655 gives a card a DELIVERY SET: the pull requests that deliver it, many-to-many, and
`deferred_incomplete_delivery_set` holds the card until every one has merged onto its own
repository's default branch. The shipped vocabulary is **repository-keyed** throughout — one rail
row per repository, a caption counting repositories that _"disappears entirely on a one-element
set"_, a dashed Development row per repository with no pull request.

**A card with TWO pull requests in ONE repository, one merged and one open**, therefore reads:
glyph `Delivered` (truthfully — a linked pull request did merge onto that repository's trunk) and
**no caption at all** (the repository set has one element). The gate is holding the card.

**The surface would assert delivered on a card that is not.** That is the failure MOTIR-3655 was
filed about, one layer up, and it is why MOTIR-3660 stopped rather than drawing it.

### The answer — TWO changes, and nothing else moves

**CHANGE 1 — the glyph's PREDICATE, not the glyph.** A repository row is `Delivered` when **every
pull request delivering this card in that repository** has merged onto that repository's default
branch. Today it is `Delivered` when _any_ linked pull request has. Same rows, same three glyphs,
same colours, one truer question — so nothing a reader has learned is invalidated.

| State     | Glyph                  | Colour            | Means (AMENDED)                                                               |
| --------- | ---------------------- | ----------------- | ----------------------------------------------------------------------------- |
| Delivered | `circle-check`         | `--el-success`    | EVERY delivery of this card in this repository merged onto its default branch |
| Awaiting  | `circle-dashed`        | `--el-icon-muted` | at least one has not — including "no pull request at all", as before          |
| Unknown   | `circle-question-mark` | `--el-warning`    | a merged delivery whose base branch Motir never recorded                      |

**CHANGE 2 — the caption's SUBJECT.** ONE line, never two, and its subject is whatever is
outstanding. This is the answer to _"do two `N of M delivered` captions coexist?"_ — **they do
not**, because two counts answering different questions on one surface is what a reader misreads.

| What is outstanding                             | The caption                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| nothing                                         | absent (unchanged — today's rule, now over deliveries as well)                  |
| a REPOSITORY with no delivery at all            | `1 of 2 delivered. {repo} is outstanding.` (unchanged — today's line)           |
| a DELIVERY that has not merged                  | `1 of 2 deliveries merged. {owner/name}#{n} is still open.`                     |
| a DELIVERY merged onto a base that is not trunk | `1 of 2 deliveries merged onto their trunk. {owner/name}#{n} landed on {base}.` |

**The words are the gate's own** (`incompleteDeliverySetCommentBody`). A card whose comment says
_"Still open: `moooon/motir-ai#2`"_ and whose rail says something else in different words is two
vocabularies for one fact.

### The ONE new element — a `Not on trunk` pill

A delivery that MERGED but onto a side branch has no pill today, so it renders exactly like one
that delivered. Panel 3 gives it `dsPillWarning` + `circle-question-mark` + **"Not on trunk"**,
beside the existing `Merged` pill rather than replacing it — both facts are true and the reader
needs both. The row's meta line carries `· into {base}` so the branch that swallowed it is named
without opening the pull request.

### What does NOT change, and is drawn so the claim is checkable

**Panel 4 is the single-delivery card**, which is the overwhelming majority of cards in the tree.
The new predicate gives the same answer over a set of one, and the caption is absent because
nothing is outstanding. An asset that improves the two-delivery card and perturbs the other ten
thousand has made the product worse, so the unchanged case is DRAWN rather than asserted.

Also unchanged: the dashed _"No pull request yet"_ row (a repository the card carries with no
delivery — still repository-keyed, still correct, because a repository with nothing has no delivery
row to name); the `EmptyState`; the role and `primary` pills; the destination panel; the editing
panel.

### The surface split is PRESERVED

The rail says WHERE and WHETHER; the Development section says WHICH pull request. The delivery set
is the first thing that is **both**, and the split still holds: the rail's glyph and caption answer
_is this finished, and if not what is missing_ in one glance, and the Development section enumerates
the pull requests with their own state. Putting the delivery set only in Development would mean
scrolling the main column to learn whether a card is done; putting the enumeration in the rail would
rebuild a section that already exists, in 288px.

### Tokens

| Element                      | Token                                                                       |
| ---------------------------- | --------------------------------------------------------------------------- |
| Delivered glyph              | `--el-success`                                                              |
| Awaiting glyph               | `--el-icon-muted`                                                           |
| Unknown glyph                | `--el-warning`                                                              |
| Rail caption                 | `--el-text-muted` on the card surface (unchanged from the sibling)          |
| Development explanatory line | `--el-text-secondary` — it sits under rows on `--el-surface`                |
| `Not on trunk` pill          | `dsPillWarning`                                                             |
| Row border / fill            | `--el-border` / `--el-surface`, `--radius-control`, `--spacing-control-x/y` |

---

## ⭐ The repository SET, compressed into the QUICK VIEW (Story MOTIR-2725 · MOTIR-2414 — `repository-set-quick-view.mock.html`)

**Asset:** `repository-set-quick-view.mock.html` + `repository-set-quick-view.png` (5 panels: two
repositories at the measured fold · four — the overflow rule · one · none · the editor).
**Gates:** MOTIR-2416 → **MOTIR-3042** (the reference redraw). **Inherits from** MOTIR-2413
(`repository-set.mock.html`) and re-opens nothing it settled.

### ⭐ REDRAWN against the REFERENCE model (Story MOTIR-2732 · MOTIR-3038, 2026-08-19)

**The repository is a LINK here too**, same token (`text-(--el-link)`), same destination
(`/settings/project/repositories#<name>`). Compression governs the READ, and a link is not a
compression — a repository the reader can follow on the detail page and cannot follow in the peek
would be two different facts about one object.

**The ROLE is DETAIL-ONLY. The compact row DROPS it — MEASURED, not asserted.**

Measured in the real modal (`h-[680px] max-h-[82vh] w-[90vw]`, the 300px rail, 267px usable inside
the row, chromium at 1280×900):

| row                                          | space for the name | name needs | result        |
| -------------------------------------------- | ------------------ | ---------- | ------------- |
| `acme-booking-service` + ROLE + `primary`    | **129px**          | **151px**  | **TRUNCATED** |
| `acme-booking-service` + ROLE (no `primary`) | 197px              | 197px      | fits          |
| `motir-core` + ROLE + `primary`              | 129px              | 129px      | fits, exactly |

So the role costs roughly six characters of repository NAME, and on the primary row — the one that
says where dispatch goes — a twenty-character name loses its tail. **The name is the identity and
the role is a category**, so the category is what gives way. `motir-core` fitting _exactly_ is the
tell that this is a knife-edge rather than a margin: any longer name with both chips truncates.

This is the same KIND of change compact already makes — it caps rows at three and drops the
explanatory line — and it does not change a WORD of what is shown, only how many elements are.
A reader who needs the role is one click from the detail page, where panel 2c names it.

### What is INHERITED, and is not re-decided here

The label (`Repositories`), the `primary` chip and the rule that it appears only above one repository,
the three delivery states and their glyphs and words (delivered · awaiting · unknown), the empty-set
word (`None`), and the `decision`-card rule (a planning convention — the field renders identically for
every type). **A disagreement with any of those is a finding against MOTIR-2413, not a local
override.**

What this card owns is the SPACE BUDGET, and it is a different problem from compressing a value: a
list has a size, and a compression that hides the size is not a compression, it is wrong.

### The surface it compresses INTO

Read off the shipped code, not guessed: the peek modal is `h-[680px] max-h-[82vh] w-[90vw]`
(`IssueQuickView.tsx`) with a `minmax(0,1fr) 300px` body grid (`IssueQuickViewPanel.tsx`), and its rail
rows are a `<dl>` of `RailField` / `EditableRailField` `dt`/`dd` pairs — **denser than the detail
page's `FieldCard`**, with no Card chrome and no per-row border. The rail is 300px, twelve pixels
WIDER than the detail rail's 18rem; the constraint here is vertical, not horizontal, which is the
whole reason this card exists.

### Q1 — what survives at one, two and four repositories

| Set size | Rows drawn  | Overflow line | Count caption               | `primary` chip |
| -------- | ----------- | ------------- | --------------------------- | -------------- |
| 0        | — (`None`)  | —             | —                           | —              |
| 1        | 1           | —             | —                           | no             |
| 2–3      | all         | —             | `{n} of {total} delivered.` | yes            |
| 4+       | **first 3** | `+{N} more`   | `{n} of {total} delivered.` | yes            |

**A ROW CAP, not a truncation of the fact.** The cap is three rows; beyond it the reader loses the
NAMES of repositories 4..N and keeps everything that decides anything: how many there are, how many
have landed, and which one is primary. The count caption is what makes that true — it names the
TOTAL, so a four-repository card can never render as if it carried three. The `+N more` line is the
second, redundant carrier of the same fact.

**Why three and not two or all.** Measured (below): at three rows the field ends at y 246 with 434px
of fold to spare, so the cap is not buying vertical space it needs — it is buying a bound, so that a
card carrying nine repositories cannot push Type, Priority and Assignee off the visible rail. Two
would drop a name from the common two-repo card for no gain; unbounded would let one field own the
rail.

### Q2 — the delivery state, compressed — and what is DROPPED

**The three glyphs and their words survive intact**, per row, at the same sizes relative to the
denser row (`h-[14px]` here against the detail page's `h-[15px]`). The delivery state is the reason
the card is not Done; compressing it away would leave the peek showing a list of names and no answer
to the question the peek is opened to ask.

Two things are dropped, and both are dropped deliberately:

1. **The outstanding repository's NAME leaves the caption.** The detail page reads _"1 of 2
   delivered. `motir-ai` is outstanding."_; the peek reads _"1 of 2 delivered."_ The name is already
   on the row two lines above it, next to its own `awaiting` glyph — on the detail page the caption
   earns the repetition because the rail is scanned separately from the Development section, and in a
   300px rail it is a second line saying what the first line said.
2. **The empty state's explanatory caption** (_"Optional — not every card ships in a repository."_)
   is dropped entirely. ⚠️ **It does not move anywhere else**, and that is the decision: in the peek,
   `Due date`, `Labels`, `Components` and `Sprint` all already read `None` with no explanation, so a
   lone caption under this one field would make it look MORE required than its neighbours, not less —
   the opposite of what the sentence is for. The teaching belongs on the detail page, where the field
   is authored at length; here, consistency with every other optional field carries it.

**What is NOT dropped: the Development section.** It is already mounted in the peek
(`IssueQuickViewPanel.tsx:504`) and MOTIR-2413's `awaiting` row travels with it as a prop
(MOTIR-2415 adds the prop; MOTIR-2416 turns it on here). The peek composes it; it does not render a
second, reduced version of it.

### Q3 — where it sits, MEASURED — and the placement that FAILED

**Decision: SECOND in the rail, immediately after Status.** This DIVERGES from MOTIR-2413, which put
the field last, after Estimate — and the divergence is a measurement, not a preference.

Measured at **1280×900**, where the modal's fixed `h-[680px]` wins (`max-h-[82vh]` would be 738px)
and the rail's visible height is **621px**:

| Placement                                            | Repositories row (y, within the modal) | Above the fold?   |
| ---------------------------------------------------- | -------------------------------------- | ----------------- |
| **Last, after Estimate** (mirroring the detail page) | **642 – 751**                          | ❌ needs a scroll |
| **Second, after Status** (chosen)                    | **137 – 246**                          | ✅ 434px to spare |

The rail's content is 827px against a 621px viewport, so **the peek rail scrolls** — which the detail
page's rail does not do in the same bounded way, and which is the entire reason the two orders differ.
The AC _"visible without scrolling at the viewport the design named"_ is unsatisfiable at the bottom
of a scrolling rail, however the field is drawn.

**Why Status and not merely "higher".** The repository set is a COMPLETION fact — it is the reason a
card sits at In Review rather than Done. In the peek, which is opened from a list to answer _what
state is this in?_, that reading happens at the top of the rail beside Status. On the detail page
there is no bounded scroller and the field can sit with the other planning metadata, where
MOTIR-2413's reasoning (read at dispatch and review time, must not push Status / Assignee / Priority
down) holds. **Both orders are right for their surface, and the notes say so on the record rather
than letting a reader discover the difference and assume one is a bug.**

Every state was measured, not just the common one — the tallest (the open editor) ends at y 320:

| Panel | State                                  | Repositories row | Above the fold? |
| ----- | -------------------------------------- | ---------------- | --------------- |
| 1     | two repositories                       | 137 – 246        | ✅              |
| 2     | four repositories (3 rows + `+1 more`) | 137 – 294        | ✅              |
| 3     | one repository                         | 137 – 186        | ✅              |
| 4     | none                                   | 137 – 180        | ✅              |
| 5     | the editor, open                       | 137 – 320        | ✅              |

### Q4 — editable here, through the SAME control — and the compression stops at the read

The peek rail became a WRITE surface in MOTIR-2561, so _"read-only because it is a modal"_ is not an
available argument, and MOTIR-2413 made the field editable. It is editable here too, through **the
same control**, expressed as a prop rather than a fork (MOTIR-2416's own rule).

⚠️ **The editor is NOT compressed** (panel 5). It lists the project's whole repository domain — four
rows in the mock, no `+N more`, no cap — because **a picker that hides options is a picker you cannot
pick from.** The row cap is a READ-mode rule and stops at the chevron.

**The rule this states, which MOTIR-2416 must not soften:** _compression governs the READ, never the
WRITE._ An editor is bounded by the domain, and the domain is the user's, not the surface's.

### Q5 — the `decision` card

Identical to the detail page: the field renders for every type, including `decision`. A field hidden
in one place and shown in the other is exactly the inconsistency this card exists to prevent, and the
underlying rule is a planning convention rather than a display rule (MOTIR-2413 Q5, on the evidence of
MOTIR-2400 and MOTIR-2726 — both `decision` cards that shipped an ADR to a repository).

### Copy — only what DIFFERS from the detail page

| Slot                    | Detail page                                        | Quick view                  |
| ----------------------- | -------------------------------------------------- | --------------------------- |
| Count caption (partial) | `{n} of {total} delivered. {repo} is outstanding.` | `{n} of {total} delivered.` |
| Overflow line           | — (no cap)                                         | `+{N} more`                 |
| Empty caption           | `Optional — not every card ships in a repository.` | — (dropped)                 |

Everything else — `Repositories`, `None`, `primary`, `Awaiting`, `Unknown`, `Delivered`, the editor's
`On` / `Primary` heads and its caption — is the SAME STRING, and MOTIR-2417's surface-agreement test
asserts that against a shared source rather than two copies of the literal.

### Tokens / a11y

Identical to MOTIR-2413's set — `--el-*` only, element-semantic shape tokens only, each delivery
state carrying its own glyph SHAPE as well as its hue plus a `title`. The one addition is the
overflow line, which is `--el-text-muted` on the peek's rail surface — the raised panel, i.e. the
white card, which is the one surface that ink clears AA on.

**⚠️ AND THAT PARENTHETICAL IS THE WHOLE CONSTRAINT, so state it as one (MOTIR-3014).** It read
_"AA-safe: the rail renders on the raised panel, not on `--el-surface`"_ — a correct claim about ONE
element, written as an aside, while five rows in the same asset put `--el-text-muted` on
`bg-(--el-surface-soft)`. `--el-text-muted` measures **4.12–4.34:1 on `--el-surface` /
`--el-surface-soft` / `--el-muted`** and **4.54:1 on the white page/card** (`CLAUDE.md`'s table,
MOTIR-2455): it is legible on white and on nothing else. So in this asset, as in MOTIR-2413's:

- muted copy sits on the **white card** only;
- anything on a **tint** — the awaiting row, the placeholder box, a tinted strip — takes
  **`--el-text-secondary`** (6.18–6.80:1, every surface, both themes);
- `--el-text-faint` carries no text WCAG measures at all — decorative glyphs (`aria-hidden`, or a
  labelled `role="img"`) and disabled text only.

The pair is now measured rather than asserted: `tests/design-ink-contrast.test.ts` reads every
`design/**/*.mock.html` and fails on `--el-text-muted` over a tinted surface, the same rule
`tests/theme/inkContrastLint.test.ts` enforces over the component tree.

### Out of scope

- The detail page — MOTIR-2413. This asset changes nothing there.
- The modal's other content, the Development section's internals, and the rail's other fields.
- Storage, dispatch and the completion rule — `docs/decisions/work-item-repository-set.md`.

---

## ⭐ The item page at ARRIVAL, and while it STREAMS (Story MOTIR-3430 · MOTIR-3432 — `detail-arrival.mock.html`; the frame's MOUNT POINT corrected by MOTIR-3492)

**What a reader sees between typing an `/items/<KEY>` URL and reading the item.** This folder already
draws a loading state for many of the page's PARTS — comment rows, attachment tiles, custom-field
rows, the quick-view's field skeleton, the tree and list tables — but nothing for the **page as a
whole on arrival**, because until now the page did not exist until every read had settled. There was
nothing to draw.

**Asset ·** `detail-arrival.mock.html` / `detail-arrival.png`. **Cards ·** MOTIR-3432 draws it;
MOTIR-3435 built the boundary and made the blocking reads concurrent; MOTIR-3436 moved the late
regions behind their `<Suspense>`. **MOTIR-3436 SHIPPED. MOTIR-3435's boundary was REVERTED and its
concurrency kept** — see the amendment directly below.

### ⚠️ AMENDMENT (MOTIR-3492) — the frame is UNCHANGED; where it MOUNTS is not

**`app/(authed)/items/[key]/loading.tsx` cannot exist.** A `loading.tsx` fallback renders as soon as
its ancestor layouts resolve — before the page function runs — which flushes the response head and
fixes the HTTP status at 200. This page's `notFound()` is a documented _no existence leak_ contract,
and the cross-workspace assertion in `tests/e2e/issue-detail-flow.spec.ts` received a **200** with the
boundary in place and a **404** with it removed and nothing else changed. Hoisting the gate into a
`layout.tsx` does not recover the status and was built and measured. The prose home is
`motir-core/CLAUDE.md` § _A `loading.tsx` may NOT sit above a route that decides existence_; the guard
is `tests/navigation/loading-boundary-guard.test.ts`.

**What that changes here, exactly:**

|                                   |                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the frame's drawing**           | UNCHANGED. The eyebrow geometry, the wide title, the `1fr / 18rem` split, the rail's card, the whole no-shift correspondence below — all of it stands                            |
| **the frame's mount point**       | an in-page `<Suspense>` wrapping the page's **tier-2 body**, placed AFTER the gate, so it is released once the status is committed. It is no longer a route file                 |
| **the three-tier allocation**     | UNCHANGED, and tier 3 has SHIPPED exactly as allocated — two boundaries sharing one promise, `issue-detail-flow.spec.ts` 16/16                                                   |
| **what the page does TODAY**      | the gate plus one concurrent tier-2 group, and then the whole page at once. **There is no frame at all**: MOTIR-3435's boundary went with the revert and nothing has replaced it |
| **the shell grammar it composes** | `design/shell/design-notes.md` § _The navigation-pending grammar_, second revision — the three windows, and the rule that every page's frame is its own                          |

**The one thing a reader must not conclude from the drawing:** that the frame covers the wait from
the click. It covers **window 2** — the page's own non-gate reads. The wait for the gate is window 1,
and on a typed `/items/<KEY>` URL nothing can cover it, which is why MOTIR-3435's surviving half (the
twenty-nine serial awaits cut to a gate plus one concurrent group) is the part of that card that
mattered.

### It COMPOSES the shell grammar; it does not redraw it

The pulse vocabulary (`--el-muted` fills, element-semantic radii, `animate-pulse`, `aria-busy`) and
the **120 ms reveal** are `design/shell/design-notes.md` § _The navigation-pending grammar_
(MOTIR-3431). This asset references them and restates neither. Per that section's **nearer-boundary
rule**, a route-shaped frame inherits the WRAPPER, the HEADER BLOCK and the REVEAL from the shared
primitive and supplies only its BODY — so `/items/[key]`'s frame is `PageSkeleton` with the item
page's own body passed in, never a second composition that can drift from it.

What makes this frame route-shaped rather than generic is geometry the group frame cannot assume: the
**eyebrow row** (type glyph · identifier · breadcrumb · right cluster), the **wide title**, the
**`1fr / 18rem` split**, and the **rail's card**.

### THE ALLOCATION — three tiers, and every region is in exactly one

| region                                                                                      | tier                       | what it shows meanwhile                                           | already drawn?                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| the eyebrow row's geometry · the title box · the two-column split · the rail card's outline | **with the FRAME**         | the frame's own pulse blocks                                      | the grammar is `design/shell/design-notes.md` § _The navigation-pending grammar_                                                                  |
| type glyph · identifier · breadcrumb · title                                                | **with the FIRST CONTENT** | —                                                                 | —                                                                                                                                                 |
| Description · Explanation                                                                   | **with the FIRST CONTENT** | —                                                                 | —                                                                                                                                                 |
| Relationships + the ready / blocked badge                                                   | **with the FIRST CONTENT** | —                                                                 | —                                                                                                                                                 |
| Children (list mode)                                                                        | **with the FIRST CONTENT** | —                                                                 | the switcher is `child-panel-graph.mock.html`; graph mode fetches its own level client-side                                                       |
| the core-fields rail                                                                        | **with the FIRST CONTENT** | —                                                                 | custom-field rows: § _Custom fields on the detail rail_                                                                                           |
| the roll-up points badge                                                                    | **late, IN PLACE**         | a chip-sized `--el-muted` slot at the settled width               | `ParentRollupBadge` already ships the lazy path — `initialTotal: undefined` means _not yet known_                                                 |
| Development (linked PRs + CI)                                                               | **AFTER the page**         | card chrome + row-shaped pulse bars                               | the section is `design/github/` Panel 5a                                                                                                          |
| Acceptance                                                                                  | **AFTER the page**         | card chrome + a two-line body pulse                               | § _Story-acceptance surfaces_                                                                                                                     |
| Design result                                                                               | **AFTER the page**         | card chrome + a thumbnail-shaped pulse                            | `design-result.mock.html`                                                                                                                         |
| Attachments                                                                                 | **AFTER the page**         | **tile-shaped pulse skeletons, `aria-busy`** — CITED, not redrawn | § _Attachments panel_: _"tile-shaped pulse skeletons (`--el-muted`, `aria-busy`) so the card doesn't jump"_                                       |
| Activity (comments · history · all)                                                         | **AFTER the page**         | **comment-row-shaped pulse skeletons** — CITED, not redrawn       | § _Comments + @mentions_: _"comment-row-shaped pulse skeletons (`--el-muted` bars + avatar circle, `aria-busy`) — the `BacklogSkeleton` grammar"_ |

Acceptance and Design result are **conditional** sections (a story in review; a design card), so a
given item renders three of the five late regions or all five. The table is the complete set; the
mock's settled frame is one item's instance of it.

### THE PAGE SETTLES TWICE — and that number is the decision

Once when the first content replaces the frame, and once when the late stack fills. **It is not six.**
A page that streams six regions independently ARRIVES six times, in whatever order the reads happen
to finish, and a reader watching blocks pop in at random reads instability, not speed — the eye is
pulled back to a region it had already left.

**So the five late sections are ONE `<Suspense>`, not five.** The alternative — a boundary each — would
let Attachments arrive without waiting for Activity, which is the slowest of them. It loses because
every one of the five sits **below the fold** at arrival, so the wait it saves is a wait nobody is
watching, while the cost it pays is visible: a reader who scrolls down mid-arrival meets a mixture of
real sections and pending ones and cannot tell which is which. One boundary means the stack is either
all pending or all there.

**If Activity later proves slow enough to hold the other four past the fold, the split to make is
TWO — Activity alone, and the rest — never five.** That is the amendment this section authorises in
advance, so the next author does not have to re-derive it.

**ONE SETTLE MAY BE DELIVERED BY MORE THAN ONE `<Suspense>`, and on this page it must be
(MOTIR-3465).** _"Twice"_ is a claim about TIME, not about JSX elements. The five late regions are
**not contiguous** in the page's main column: **Children is tier 2 and renders BETWEEN Design result
and Attachments**, so a single element cannot span them without either making tier-2 content late or
reordering a page nothing here argues for. The mechanism is instead **two boundaries awaiting the
SAME promise** — they resolve in one tick and flush together, which is one settle by the only
definition a reader can perceive. MOTIR-3436 implements exactly that, and its test asserts each late
read runs ONCE, which is what breaks if either half builds its own promise. **Read a boundary count
as an implementation of this decision, never as the decision.**

**Why the roll-up badge is not a third settle.** It sits in the eyebrow, at the TOP, where a late
arrival is maximally visible — so it gets no boundary at all. Its slot is reserved at the settled
width and filled in place, which is the shape `ParentRollupBadge` already ships. **An in-place swap
inside a reserved box is not an arrival.** That is the general rule: a region that cannot make the
first-content deadline either joins the late stack or reserves its own box — it never resizes one.

### The no-shift correspondence

| frame block                       | becomes                                | why the pair cannot shift                                                                                                                                            |
| --------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `h-5 w-5` glyph + `h-4 w-24`      | the type glyph and `MOTIR-3430`        | the glyph ships at `h-5 w-5`; the identifier is `font-mono text-sm`, a 20px line box, so the row's height is the glyph's either way                                  |
| the `min-w-0 flex-1` cell         | the breadcrumb                         | it truncates inside a bounded track (the shipped fix for the eyebrow overflowing the viewport), so its content never changes the row's height                        |
| `h-(--height-control)` × 3, right | Re-plan · watch · ⋯                    | all three are real controls at `--height-control`; the frame inherits the token rather than restating a number                                                       |
| `h-8 w-[34rem]`                   | the `<h1 class="font-serif text-2xl">` | **32px** — the same box the group frame's title block uses                                                                                                           |
| the `1fr / 18rem` grid, `gap-6`   | the same grid                          | not a copy: the frame declares `grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]`, which is the page's own declaration                                                     |
| each card's chrome                | the arrived `ContentSectionCard`       | same `--radius-card`, `--spacing-card-padding`, `--shadow-card` and `mb-(--spacing-md)` header gap; only the BODY height differs, and a body is below its own header |

**At the narrow breakpoint** the grid collapses to one column and the rail moves under the main
column — **in the frame exactly as on the page**, because the frame carries the page's own
`grid-cols-1 … md:grid-cols-[1fr_18rem]` rather than a fixed two-column drawing. The narrow width
therefore needs no second frame: it is the same declaration resolving differently, and a drawing of
it would be a second thing to keep in sync.

**The one honest exception: a long title.** The frame reserves ONE line (32px). A title that wraps to
two settles 32px taller, pushing the body down once. Reserving two lines instead would settle every
SHORT title 32px up, which is the more common case and the more annoying direction. So the frame
reserves one line, and the shift is downward-and-rare rather than upward-and-usual.

### The design-allocation sweep — what this asset GIVES and TAKES

| card                                                           | GIVES / TAKES | what                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-3435** — `/items/[key]`'s frame + the concurrent reads | **GIVES**     | the frame's body block by block, and the rule that it composes `PageSkeleton` rather than redrawing the wrapper, header and reveal. **Its `loading.tsx` half was reverted (MOTIR-3492); the frame is an in-page `<Suspense>` after the gate, and nothing owns building it yet** |
| **MOTIR-3436** — the streaming sections                        | **GIVES**     | the allocation table, the settles-twice decision, the ONE-boundary-not-five argument with its stated future amendment, and the pending state for each late region — with a citation for every skeleton this folder already specifies                                            |
| **MOTIR-3431** — the shell grammar                             | **TAKES**     | the pulse vocabulary, the 120 ms reveal and the nearer-boundary rule. Nothing is given back: the shell asset does not draw this page                                                                                                                                            |
| **MOTIR-3437** — the story's vitest gate                       | **GIVES**     | the checkable claim that the late stack is one boundary rather than five                                                                                                                                                                                                        |

### What this design overrides

Nothing. It is the first drawing of this state. Two adjacent facts it does **not** change, named so a
reader does not infer them: the ARRIVED page's layout, copy and controls are exactly as
`detail.png` and the sections below already specify — this asset adds a state and changes none — and
every section skeleton this folder already draws stays as drawn, cited above rather than superseded.

### How the render was produced

Generated, not hand-drawn. Every settled card is the real `ContentSectionCard` over the real `Card`
primitive; the switcher is the real `Segmented`; the type glyph is the real `IssueTypeIcon`; the chip
is the real `Pill` — all rendered through the repo's own vitest + RTL setup with the real
`messages/en.json`, then laid out against Tailwind's own compiled output of `app/globals.css`. The
frame's geometry is the page's own declarations (`grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]`,
`font-serif text-2xl`, `--height-control`), not numbers copied out of it. The reveal declaration in
the mock's stylesheet is quoted verbatim from the shell asset so the two cannot drift.

**THE SECTION ORDER IS READ, NOT COMPOSED (MOTIR-3465).** Rendering the real components is
necessary and it is not sufficient: it makes every _element_ the app's and says nothing about their
_arrangement_. The first cut of this asset drew Children second where the page renders it eighth and
omitted Explanation and Relationships entirely, while every class string traced to real markup — which
is what made it read as trustworthy. The order in both content frames now comes from the page's own
`<main>`, in the same pass that draws them:

```sh
awk '/<main className="flex min-w-0 flex-col gap-6">/,/<\/main>/' \
  'app/(authed)/items/[key]/page.tsx' \
  | grep -oE '<(ArchivedBanner|ContentSectionCard|IssueExplanation|RelationshipsPanel|ChildPanel|AttachmentsPanel|ActivitySection)'
```

**Reproducing the stylesheet.** The mock's `<style>` is Tailwind's own compiled output, scanned over
the mock's BODY MARKUP ONLY — not the whole file, which already contains that output and feeds
candidates back into the next compile. With `@tailwindcss/cli` at the version in `package.json`:

```sh
printf "@import 'tailwindcss' source(none);\n@import '@motir/design-system/theme.css';\n@source \"<the body markup>\";\n" > /tmp/in.css
npx @tailwindcss/cli -i /tmp/in.css -o /tmp/out.css   # then drop the banner line
```

Verified byte-identical against the committed stylesheet before it was regenerated, which is the
check that makes the recipe worth writing down rather than re-derived.

One board artefact, named so nobody reads it as design: the frames that show the frame REVEALED force
the animation's end state, because a board is a still and a time-based state has to be frozen at the
moment it is being drawn.

---

## The streaming allocation at ARRIVAL — `/items/archived` and `/items/[key]/edit` (MOTIR-3442)

Part of [MOTIR-3440](motir:cmt8s085i003li1ph06u469kx)'s sweep of the 24 heavy authed surfaces. The
rule this applies is `design/shell/design-notes.md` § _The navigation-pending grammar_ →
_WHICH SURFACES EARN A FRAME_, and the three-tier method is
`design/work-items/design-notes.md` § _The item page at ARRIVAL_'s. **Neither is restated here.**
Measured against `origin/main` `9455fc3c`.

### `/items/archived` — the list

|                            |                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **the gate**               | `getSession` → `getTranslations('issueViews')` → `getActiveProject` → `getCapabilities` (`canBrowse`)                                                                                                                                                                                |
| **with the frame**         | the back-link to `/items` and the `<h1>`                                                                                                                                                                                                                                             |
| **with the first content** | `searchParams` → `getLocale` → `Promise.all([getWorkflow, listArchivedWorkItems])` — already one wave — then `toArchivedRows`                                                                                                                                                        |
| **after the page**         | — nothing                                                                                                                                                                                                                                                                            |
| **settles**                | **once**                                                                                                                                                                                                                                                                             |
| **verdict**                | **NONE — reuse.** The late region is a table of work-item rows, and `app/(authed)/items/_components/IssueTreeSkeleton.tsx` is the drawn pending state for exactly that, already composed by `/items` behind its own `<Suspense>`. `/items/archived` is the same table one route over |

**This is the one route in the ten where the reader arrives with the shape already in their head** —
they came from `/items`, whose table they were just looking at. Standing in for it with the same
skeleton the sibling route uses is what makes the two read as one surface.

> ## ⚠️ AMENDMENT — 2026-08-26, MOTIR-3444. THE CITED SKELETON DOES NOT FIT THIS TABLE.
>
> **The verdict above is right and its stand-in is wrong.** The entry asserts that `/items/archived`
> is _"the same table one route over"_ as `/items`. It is not, and the build card that went to reuse
> `IssueTreeSkeleton` measured the difference:
>
> |               | `IssueTreeSkeleton`                                                                  | `ArchivedWorkItemsList`                                                                 |
> | ------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
> | tracks        | **9**, derived from `buildIssueColumns`                                              | **4 or 5** — `minmax(0,1fr) 130px 175px 140px [150px]`, the fifth only when `canDelete` |
> | columns       | Title · Type · Priority · Assignee · Reporter · Estimate · Points · Status · Actions | Title · Status · Archived by · Archived (· actions)                                     |
> | row height    | **40**                                                                               | **48**                                                                                  |
> | right padding | `pr-7`                                                                               | `pr-5`                                                                                  |
>
> Composing it as the fallback would lay out four fewer tracks and 8 px less per row across eight
> rows, and settle with a visible jump — **exactly the defect `IssueTreeSkeleton`'s own header
> comment documents** (MOTIR-3452: the fallback laid out 272 px less fixed track than its table for
> eighty days, under a comment promising the two were in sync). An asset that cites a stand-in which
> does not fit is worse than one that cites none: it sends the next agent to a component that
> compiles, renders, and shifts.
>
> **So the archived boundary is NOT this sweep's to add, and MOTIR-3444 ships without it.** Two
> things must be decided before it can be, and neither is a build detail:
>
> 1. **Which variant the frame draws.** `gridTemplate` is chosen from `showActions`, which is
>    `canDelete` — a capability the frame cannot know before the read it is standing in for. Four
>    tracks or five is a drawing decision, and guessing it wrong is the shift.
> 2. **Whether it is drawn at all.** Under _WHICH SURFACES EARN A FRAME_ rule 3 the shape ladder is
>    the page's own, then its family's, then the generic one. This table has no family, and the
>    generic frame is `PageSkeleton`, which does not exist on `main` — the same unowned prerequisite
>    that blocked MOTIR-3443 (planning bug MOTIR-3520).
>
> **What still stands, unchanged:** the gate, the tiers, the settle count, and the finding that this
> page's two reads were already one wave. The falsified clause is the stand-in, not the allocation.

### `/items/[key]/edit` — the form

|                            |                                                                                                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the gate**               | `getSession` → `getTranslations` → `getActiveProject` → `params` → `getIssueDetail` (**`notFound()`**, and the `permanentRedirect` onto the canonical key when the alias resolves) → `getCapabilities` (**`redirect`** to the read view when `canEdit` is false) |
| **with the frame**         | — nothing worth naming. The `<h1>` is `t('editIssue')` and could paint, but see the verdict                                                                                                                                                                      |
| **with the first content** | — **nothing**                                                                                                                                                                                                                                                    |
| **after the page**         | — nothing                                                                                                                                                                                                                                                        |
| **settles**                | **once**                                                                                                                                                                                                                                                         |
| **verdict**                | **NONE.** Both `notFound()` and the two redirects are decided by gate reads, and the same `detail` that decides them carries every value the form renders — `issue`, `workflow`, and every relationship `RelationshipsPanel` draws                               |

**THE FORM DECISION, stated as the card required it: the FORM WAITS.** It is not a preference and it
is not a compromise — it falls out of the reads. `EditIssueForm` takes `issue` and `workflow`, both
from `getIssueDetail`, which is a **gate** read because it decides the 404. So by the time anything
can be flushed at all, every field's value is already in hand. There is no version of this page
where a field renders empty and fills in later, and therefore nothing to protect against.

**The one read that is genuinely behind the others is `members`** — the assignee picker's option
list, currently issued serially after `getCapabilities`. It is **not a field the reader types into**;
it is a picker's options. The decision is to make it **concurrent with the capabilities read** rather
than to stream it: one round trip instead of two, and the form still arrives complete. A discarded
`members` read on the rare `canEdit === false` redirect is cheaper than a second settle on every
successful edit.

**A route boundary is PROHIBITED here, not declined** — this route calls `notFound()`
(`motir-core/CLAUDE.md` § _A `loading.tsx` may NOT sit above a route that decides existence_).

---

## The to-do list on a work item (Story MOTIR-3808 · MOTIR-3812)

`design/work-items/` had **no** checklist surface and this file's table had no
checklist row — verified at `origin/main` with
`git grep -ril -E 'to-?do list|checklist' -- design/**`, which returns ten files
and none of them under `design/work-items/`. So this is the NONE-exists case:
the code siblings (MOTIR-3815 · MOTIR-3816 · MOTIR-3817) are `blocked_by` this
design, and `todo-list.mock.html` (built from the live `--el-*` tokens + the
shipped primitives) is the asset they build to.

The behaviour this asset draws is not invented here either: the decision record
`docs/decisions/work-item-todo-list.md` (MOTIR-3811) is the workflow spec, and
every §-reference below points into it.

### Placement — MEASURED, not asserted

A **left-column section card** (`Card` + `ContentSectionCard` header grammar),
placed **after Explanation and before Relationships**, and arriving **with the
FIRST CONTENT** rather than in the late `<Suspense>` stack.

Measured at **1280×900** (panel 0). The viewport gives 900px of height; the app
shell's header takes 56px and the page's own eyebrow + title block takes 132px,
so **712px of the left column is above the fold**. Description (≈180px) and
Explanation (≈210px) consume 390px of that, leaving **322px** — the section's
header plus five rows at 44px. Below Relationships the section starts at ≈760px
and is below the fold at every laptop height this folder has measured.

Two consequences, and the second is why the tier matters as much as the order:

- On a card whose work IS the list, the list is what the reader came for; a
  region that is the point of the page does not go under the fold.
- In the late stack it would also be the **last** region to arrive, so the most
  actionable region of the page would be the slowest. `detail-arrival.mock.html`
  now carries the To-do list in its three-tier table, at **with the FIRST
  CONTENT** — the read is one small ordered query on the same card and joins the
  page's existing parallel read group.

### Anatomy

- **Header** — `ContentSectionCard` title `To-do list` + muted gloss
  `— the steps of this work`, with **`N of M done`** in mono at the header's far
  end. The count renders even at `0 of 0`, so the number does not appear from
  nowhere when a first step is added.
- **Row** — a three-track grid (`auto 1fr auto`): the checkbox, the body, the
  row actions. The body track carries `min-w-0`, which is load-bearing (see
  _Overflow_ below).
  - the **checkbox** is the shipped `Checkbox` box — 16px, `--radius-control`,
    `--el-accent` fill with `--el-accent-text` ink when on;
  - the **text** is `13.5px`, `--el-text`, and it is **plain text, never
    Markdown** (§1) — rendered as a text node, not through `MarkdownView`;
  - the **instructions disclosure** — a chevron + `Instructions`, rendered
    **only on a row that has them** and **collapsed by default**;
  - the **executor mark** is a small pill: `You` (a `user` glyph, `--el-border`,
    `--el-text-secondary`) or `Agent` (a `bot` glyph on `--el-tint-lavender`
    with `--el-text-strong`);
  - the **row actions** — reorder handle, edit, delete — are icon `Button`s in
    the third track, revealed on row hover and **always present for a keyboard
    user**.
- **Notes body** (expanded) — a `--el-border-strong` left rule and 12.5px
  `--el-text-secondary` prose, rendered through the shipped `MarkdownView`.
- **Command row** — under the text, a `--font-mono` 12px value in its own
  bordered box on `--el-code-bg`, with the copy `Button` beside it.
- **Add row** — a `plus` glyph + `Add a step…`, under a hairline, at the end of
  the list. It is the composer; there is no modal.

### The row's three faces (panels 1–3)

| face        | tell                              | notes                                                                                                                                                   |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **plain**   | checkbox · text · executor mark   | the common row                                                                                                                                          |
| **command** | plus the mono value + copy button | `commandText` is non-null (§5) — the row is copyable because the FIELD is set, never because the text looks command-shaped                              |
| **agent**   | the `Agent` mark                  | `executor: coding_agent`. It **authorizes nothing and disables nothing** (§2): the checkbox is live, because a person may have done the step themselves |

### Instructions — the row carries the HOW (panel 1b)

A to-do is one operation, and **performing one operation still takes
instructions**: _go to the dashboard, find the setting, create the token_. Those
live in an optional `notesMd` (Markdown) beside the one-line `text`.

**They are not more to-dos, because NAVIGATION IS NOT AN OPERATION.** Given

```
1. go to the dashboard   2. find the setting   3. …
4. create a token        5. add the token to …
```

nobody ticks _"found the setting"_ — steps 1–3 are the _how_ of step 4. That is
**two to-dos each carrying instructions**, not five rows. The tickable unit is
the one where _done_ is unambiguous; getting there is instructions. So `text`
keeps its one-line 200-character bar and still answers _"is this one
operation?"_.

**Collapsed by default, and the chevron is the whole tell.** It renders ONLY on
a row that has notes, so a list of ten rows reads as ten lines and the reader
expands the one they are on. That is the answer to _"a body makes the list
un-scannable"_ — a **rendering** question, not a schema one.

**Instructions and a command are INDEPENDENT.** A step may have either, both or
neither; panel 1b draws all three in one card. The notes say where the button
is; the command is the thing you run.

**It is a FIELD and not a second work item**, and the line is what it does not
carry: no status, no assignee, no dependencies, no sprint, no estimate, no
executor of its own, and nothing dispatches it. Prose is not what makes
something a work item — a `Comment` has a Markdown body and is not one. The ADR
(§1, _Instructions_) carries the full reasoning, including why the earlier
_"if a step needs a body, it needs a card"_ was wrong.

#### Editing it — the control matches the KIND, and there are three

**A field the product STORES as Markdown and EDITS as plain text is a field
whose numbered list and link a user can only produce by typing the syntax
blind.** So the edit row carries three different controls, one per kind:

| field         | kind                  | control                                            |
| ------------- | --------------------- | -------------------------------------------------- |
| `text`        | plain, one line       | `Input`                                            |
| `notesMd`     | **Markdown**          | the shipped **`MarkdownEditor`, `size="compact"`** |
| `commandText` | plain, one line, mono | `Input` (mono) — **never** a rich-text surface     |

`compact` is not a new variant: it is the mode the **comment composer on this
same page** already uses (`CommentComposer.tsx`), and its button set —
**bold · italic · strike · inline code · link · bulleted list · numbered list**
(`components/ui/MarkdownEditor.tsx`) — is exactly an instruction's vocabulary. A
dashboard flow is a numbered list with a link and a `code` span in it, and all
three are one click.

**Read and edit are the shipped PAIR**: `MarkdownView` renders the notes,
`MarkdownEditor` edits them — the same pairing `descriptionMd` and
`explanationMd` already use on this page. Nothing here is a new primitive.

**The other two stay plain, deliberately.** Making `text` rich would break the
one-line, one-operation bar it exists to hold, and a formatted command is a
command that will not paste. The asymmetry is the design, not an oversight —
panel 9 draws all three together so the next reader cannot collapse them.

**Markdown, not plain text**, deliberately: a dashboard flow wants a numbered
list and a link, and plain text strips exactly the part that makes _"go to the
dashboard"_ actionable. Capped at **2000** characters — which is not a
granularity bar but a _has the how become a document?_ bar, so its error asks
for a **card**, not a split.

**MOTIR-1344 writes this field.** _Help with a task_ is specified to rewrite the
list mid-session, and an assistant walking somebody through a dashboard flow
produces instructions rather than more one-line titles.

**An agent row shows no run control at all** while nothing can run one — not a
disabled button, which reads as a malfunction, and not a "coming soon", which is
a promise the product cannot keep. Panel 3 marks where MOTIR-3809 will place one
(the row-actions track, left of Edit) with a dashed annotation that is **part of
the board and not of the product**.

### The copy grammar — the BUTTON'S OWN STATE, not a toast

Both are shipped and **exactly one belongs here**: `CodeBlock` confirms in the
button (`Copy` → `Copied`, cleared after 2s), and `CopyCommandAction` confirms
with a toast. This surface takes **the button's own state**. The reader is
looking at the control they just clicked — a toast would announce a success
already visible — and a list where several rows are copied in sequence would
stack toasts for a confirmation the row already gives. `CopyCommandAction`'s
toast is right where it ships, on the Ready LIST, because there the row scrolls
under the cursor and the eye is elsewhere.

**The two must not both appear.** A row that flashes a button state AND raises a
toast reads as two events for one click.

### Every state (panels 4–12)

| state              | what it draws                                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **empty**          | `No steps yet.` + `Break this card's work into steps you can tick off, one operation each.` + a primary `Add the first step`. The header still reads `0 of 0 done`                                                                                                                                                    |
| **partly done**    | a done row is **struck and moved to `--el-text-secondary`, and it stays where it is** — reordering completed rows to the bottom would destroy the sequence, which is the one thing this list is for. Under it, `Done by <name> · <date>` — the record a tick leaves, since a tick writes no history entry (§4)        |
| **all done**       | the header's `3 of 3 done` and one quiet line, `Every step is done.` **No banner and no control offering to close the card** — §3 refuses any status change, and a tinted "Done" banner would read as exactly the status claim this surface may not make                                                              |
| **read-only**      | an actor without `work_item:edit` keeps the rows, the marks and the count, and loses every control: no add row, no handle, no edit, no delete. The checkbox is **genuinely inert** — `role="checkbox"` + `aria-disabled="true"`, announced and not actionable — rather than a live control that silently does nothing |
| **adding**         | the composer is the last row, not a modal. Enter commits and keeps focus in the field for the next step; Escape abandons. The command and the executor are set from the row afterwards, so the common case (a plain step) stays the fastest                                                                           |
| **editing**        | the row becomes its own editor — **three controls for three KINDS of text** (below), executor as a two-value control, `Cancel` / `Save`. The patch is SPARSE: clearing the command field sets it to `null` and the row stops being copyable; leaving it alone leaves it alone                                         |
| **dragging**       | the row lifts as a dashed ghost; a 2px `--el-accent` rule marks the drop slot. One row is written                                                                                                                                                                                                                     |
| **delete confirm** | an inline swap on the row (`Cancel` / a danger `Delete`), not a `Modal` — one step is cheap to lose and cheap to retype, and the modal primitive is reserved for the irreversible                                                                                                                                     |
| **at scale**       | twenty rows. The section **grows**; it does not cap and it does not scroll                                                                                                                                                                                                                                            |

**On "at scale", the decision and its reason.** No `+N more`, no inner scroll.
The list is bounded in the other direction by the granularity bar — a card
needing forty steps is a card that should have been two cards, and the place to
say so is the plan, not a control that hides the work. The **header's count** is
what makes a long list legible without scrolling it. This is the one region on
the page where an inner scroll would be actively wrong: the reader is working
_through_ the list, and a scroll container inside a scrolling page is where a
step gets missed.

### Overflow — the containment rule, stated so the code card inherits it

A command is routinely wider than the column. Panels 13 and 14 draw the same row
at **1280** and at **390**. The rule, in three parts, all three load-bearing:

1. **The mono value is its own `overflow-x-auto` container** — and a `<pre>`,
   not a `<code>`, because `white-space: pre` only helps if the markup preserves
   the line (a formatter will reflow the contents of an inline element). This is
   also what the shipped `CodeBlock` renders (`ScrollableRegion as="pre"`).
2. **The row's body cell carries `min-w-0`.** Without it a grid/flex child's
   minimum size is its CONTENT, so the ROW widens and the **page** scrolls
   sideways instead of the command.
3. **The copy button carries `shrink-0`.** A `Button` in a flex row defeats
   `min-w-0` on its own account unless it is explicitly told not to shrink.

The box is `tabindex="0"`: a box that scrolls its own content is a box a
keyboard user must be able to focus, or the content past its right edge is
mouse-only.

**This section SPECIFIES the rule; it does not implement it.** Applying it to
the React surface, and asserting that the page does not scroll sideways, are
MOTIR-3815's criteria.

### Semantics — a LIST of rows, and deliberately not a listbox

The section is a `<ul>` of `<li>` rows. **It is not a listbox and a row is not
an `option`**: a row carries a checkbox, a copy button, a drag handle and two
more buttons, and an `option` may not contain interactive descendants — drawing
it that way produces a surface a screen reader can announce and cannot operate.

| element                     | role / element                                             | accessible name                                           |
| --------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| the section                 | `ContentSectionCard` → `<section>` with the `<h2>` title   | `To-do list`                                              |
| the list                    | `<ul>`                                                     | — (the heading names it)                                  |
| a row                       | `<li>`                                                     | —                                                         |
| the tick                    | the shipped `Checkbox` (`role="checkbox"`, `aria-checked`) | the step's own text                                       |
| the instructions disclosure | `<button aria-expanded>` controlling the notes region      | `Instructions`                                            |
| the copy button             | `<button>`                                                 | **`Copy command`** — the glyph carries no name of its own |
| the reorder handle          | `<button>`, **not** a `div` with a drag listener           | `Reorder step`                                            |
| the edit / delete buttons   | `<button>`                                                 | `Edit step` / `Delete step`                               |
| the progress                | text in the header                                         | read as `N of M done`                                     |

- **The drag handle has a keyboard equivalent, and it is the reason the handle is
  a button**: Space picks the row up, ↑/↓ move it one slot with the new position
  announced through a live region, Space drops it, Escape restores it. A
  drag-only reorder would make the one editable thing on this surface
  mouse-only.
- **After a delete, focus moves to the NEXT row's checkbox** — or to the
  add-step field when the deleted row was the last one. It never falls to the
  document body, which is how a keyboard user loses their place in a list.
- An **inert** checkbox (read-only actor) keeps `role="checkbox"` and
  `aria-checked` and adds `aria-disabled="true"`, so the state is still
  announced.

### Out of scope

- **The hosted-run control for an agent step** — MOTIR-3809 (Epic 9). This asset
  draws where it goes and does not draw it.
- **Any status change when the last box is ticked** — refused outright by
  `docs/decisions/work-item-todo-list.md` §3, on the two-status-authorities
  reason. Panel 6 is what all-done looks like when it changes nothing.
- **Teaching the PLANNER to author to-do lists** — MOTIR-3810. A person writes
  them in this UI.
- **Any surface other than the item page** (the board, the ready list, the API).
  No card in MOTIR-3808 ships one and this asset takes no position on a later
  one.

### ⚠️ Amendment 2026-09-05 (MOTIR-4633) — a CSS escape belongs in the SELECTOR, never in the `class` attribute

**THE RULE, in one sentence: write an arbitrary-value utility in a mock's
`class` attribute exactly as the browser will read the class NAME —
`class="text-[13.5px] text-(--el-text)"` — and put the backslashes only in the
`<style>` block's SELECTOR, where CSS syntax requires them
(`.text-\[13\.5px\]`, `.text-\(--el-text\)`).** The selector
`.text-\(--el-text\)` matches the class named `text-(--el-text)`; an attribute
written `text-\(--el-text\)` declares a class named `text-\(--el-text\)`, and
the two never meet. This asset shipped with the escapes in the attribute:
**138 class attributes, 252 utility tokens, every one of them inert.**

**Why it survived review, and why the dark column is where it surfaced.** In the
light scope the inherited `body { color: var(--el-text) }` _is_ `--el-text`, so
every inert `text-(--el-text)` rendered the right colour by accident. Panel
"dark" inherits that same light-computed ink, so the steps, the section heading
and the count all rendered **`#1a1a1a` on `#0f0f0f` — 1.10:1**, measured in
Chromium over the committed file. After the fix the same three read **17.42:1**
(`--el-text`) and **7.35:1** (`--el-text-secondary`), both clear of AA. The
sizes were wrong too and in the same silent way: the `<h3>` fell back to the
UA's `1.17em` (**18.72px** against the 15px the class asked for) and each step
row to the inherited **16px** against 13.5px.

**A SECOND, independent way the same utility goes inert — the shim block has to
DECLARE it.** These mocks are static HTML with a hand-written "utility shims"
block, not Tailwind output, so a utility only exists if this file spells it out.
`text-[15px]` (16 uses) and `text-[14px]` (1 use) were never declared, so
un-escaping them alone would have left them just as dead; both rules are now in
the shim block beside `.text-\[13\.5px\]`. **So a mock author owes two checks,
not one: the attribute carries no backslash, AND every arbitrary-value utility
it names has a rule in this file.**

**The check, which needs no test to run:**

```
# 1 — no escape may appear inside a class attribute, tree-wide
git grep -c 'class="[^"]*\\[^"]*"' $(git ls-files 'design/**/*.mock.html')
# 2 — every arbitrary-value utility a mock USES is DECLARED in that same mock
#     (compare the class attributes' tokens against the file's own selectors)
```

Neither `tests/design-ink-contrast.test.ts` nor
`tests/design-state-ink-contrast.test.ts` can see this class: both read the
SOURCE and rule on the ink a rule _names_, and the defect is that the rule never
applies. The nearest asset that has neither problem is
`design/ai-planning/peek-proposed-todos.mock.html`; §15.5 of
`design/ai-planning/design-notes.md` is the companion write-up, and it carries
the other half of the dark-panel problem — a Tier-3 token declared on `:root`
computes there, so a nested dark panel must re-declare the `--el-*: var(--color-*)`
mapping inside its own scope. **This asset already does that**, via
`data-appearance-scope` on the dark stage, which is why removing the escapes was
sufficient here.

### ⚠️ Amendment 2026-09-07 (MOTIR-4687) — the correspondence is now GUARDED, in both directions

The amendment above ends with _"a mock author owes two checks, not one"_ and a
code block that says to run the second one by hand. **It is a spec now:**
`tests/design-mock-utility-correspondence.test.ts`, in the
`vitest.design.config.ts` lane, so an asset-only pull request runs it.

**It rules on the correspondence in BOTH directions, because the two are one
defect seen from two ends:**

- **(A) INERT** — an element carries an arbitrary-value class that no rule in
  that file declares, so it renders at whatever it inherits. The population
  MOTIR-4687 fixed was 115 occurrences of 12 un-prefixed utilities across 8
  assets, and every one of them was a wanted style rather than a vestigial
  class, so all 11 remaining groups were DECLARED: `text-[11.5px]` ×26 and
  `text-[19px]` ×4 in `../ai-planning/peek-proposed-todos.mock.html`,
  `text-(--el-link)` ×24 across `delivery-set` / `repository-set` /
  `repository-set-quick-view`, `bg-(--el-surface-soft)` /
  `transition-[transform,background-color,border-color,color]` /
  `duration-(--transition-duration)` ×16 each in
  `../ai-chat/plan-change-run-live.mock.html`, `bg-(--el-muted)` ×5 in
  `../ai-planning/peek-proposal-mode.mock.html`, `shadow-(--shadow-modal)` /
  `p-(--spacing-icon-btn)` / `text-(--el-text-muted)` ×2 each in
  `../shell/rail-bottom-section.mock.html`, and
  `px-(--spacing-card-padding)` ×1 in `repository-set`. That arm is at ZERO.
- **(B) DEAD** — a rule is declared that no element in ANY mock carries. This is
  MOTIR-4150: three assets ship `.max-w-md { max-width: 28rem; }`, nothing
  references it, and a card read the measure off it and called it _"the value
  the asset draws"_. 1493 declarations across 89 assets, held as a counted debt
  table that can only shrink (MOTIR-4811 · MOTIR-4814).

**⚠️ AND THE RATCHET EARNED ITS KEEP BEFORE IT MERGED.** MOTIR-4779 renamed the
`home` area to `design/workbench/` while MOTIR-4687 was in the merge queue, and
the new asset carried **two undeclared `bg-(--el-tint-mint)`** — status chips
drawn with no tint fill, the same defect, hours old. The guard caught it
in the queue's merged tree; the rule is DECLARED here. That is the whole
argument for a spec rather than a rule somebody remembers.

**Its second cost is the one to plan around:** both tables pin FILE PATHS with
EXACT counts, so a concurrent pull request that renames or edits a design asset
turns this lane red on a tree where nothing is actually wrong. The remedy is to
re-derive the tables after merging `main` — never to loosen the assertion, which
is the only thing making the population shrink.

**The costs are opposite and that is why the pair is one guard:** (A) silently
un-styles the ASSET, (B) misleads a READER. And note the direction of the risk
in (A) — an un-styled element usually inherits `--el-text`, which PASSES
contrast, so the defect makes every ink guard in the tree GREENER rather than
redder.

### ⚠️ AND A VARIANT PREFIX IS NOT AN EXCUSE — the decision, in writing

The obvious reading of a `hover:` or `[&_svg]:` utility that no rule declares is
that a STATIC mock never enters that state, so the class is a harmless no-op.
**Measured, that reading is wrong for the large majority of the population** —
636 occurrences of 14 utilities across 11 assets — and it is stated here rather
than assumed, because assuming it is how these went unmeasured:

- **`[&_…]:` is STRUCTURAL, not stateful (532 of the 636).** It compiles to a
  descendant rule (`& svg { height: 18px }`) and applies unconditionally. The
  `<svg>` inside each of those spans carries `width="24" height="24"`, so
  **every navigation icon in seven shell / home / landing assets renders at 24px
  against the 18px its own markup asks for** — in the browser and in the
  exported `.png`. `../shell/rail-bottom-section.mock.html` DECLARES the rule
  and is the control that rules out "the mocks intend 24px". → **MOTIR-4810.**
- **The state variants (104) mostly are not conditional either.**
  `placeholder:` paints on an empty input with no interaction at all;
  `data-[state=open]:` is set in the MARKUP of a menu asset drawn open; and
  `hover:` / `focus-visible:` / `active:` fire in the browser these assets are
  actually reviewed in. → **MOTIR-4813.**

**So: a variant utility a mock names is DECLARED or DELETED, never left
standing.** "It is a variant, so it never applies" is a claim about a specific
element in a specific document, and it is a REMOVE with its reason written down
— not a third disposition.

**A fourth trap, one level in: a rule may lie about its own name.**
`.text-\(--el-text-faint\)` is declared as `color: var(--el-text-secondary)` in
five assets and as `var(--el-text-faint)` in eleven, and since every ink guard
classifies ink by reading the token name off the DECLARATION, the re-pointed
form hands the guard its answer. If an ink is wrong, change the CLASS on the
element — never what the class means. → **MOTIR-4812.**

### Amendment 2026-09-28 (MOTIR-6857) — the reserved Run slot is no longer the hosted agent's

`docs/decisions/work-item-todo-list.md` AMENDMENT 1 (MOTIR-6856) decided that an
agent to-do is never run by the hosted agent. The hosted agent runs cards, not
single to-do steps. MOTIR-3809, _Dispatch ONE to-do to a hosted agent_, is
cancelled. An agent to-do's later runner is **Motir AI**, once Motir has a
secret store.

Two lines above still name MOTIR-3809 as the owner of the row's run control.
They are left as written, and this amendment is how to read them:

- **_An agent row shows no run control at all_** (§ _Instructions — the row
  carries the HOW_): _"Panel 3 marks where MOTIR-3809 will place one"_. The slot
  stays where it is drawn, in the row-actions track left of Edit, and it stays
  **empty** until Motir AI can run a step. When that runner exists, its control
  is the one that goes there. The hosted agent never places one.
- **_Out of scope_**: _"The hosted-run control for an agent step — MOTIR-3809
  (Epic 9)"_. There will be no hosted-run control. The control this asset
  reserves room for is Motir AI's, and no card plans it yet.

`todo-list.mock.html` is **not edited**. Its reserved-slot annotation (lines 30,
1493, 1952 and 2051 name MOTIR-3809) is a record of the board as it was
approved. Read that annotation as marking **Motir AI's** future slot, not the
hosted agent's. Nothing about the row's current rendering changes: an agent row
still shows no run control.

---

## ⭐ The PENDING-PLAN indicator on the item page (MOTIR-4256 — `pending-plan-indicator.mock.html`)

**What a work item's page says about the plan that is about to change it.** Today: nothing.
`app/(authed)/items/[key]/page.tsx` composes `ArchivedBanner`, `ContentSectionCard`,
`IssueExplanation`, `TodoListSection`, `RelationshipsPanel`, `LateUpperSections`, `ChildPanel`,
`LateLowerSections` and `CoreFieldsPanel`, and not one of them reads a plan — so a card a `planned`
plan proposes to rename, re-prioritise, re-parent or ARCHIVE renders exactly like a card nobody has
proposed anything about.

**Asset ·** `pending-plan-indicator.mock.html` / `pending-plan-indicator.png`. **Cards ·** MOTIR-4256
draws it; **MOTIR-4197** builds it and is `blocked_by` this card. Drawn against `origin/main` @
`802f1edfc`.

**Why it is a design card at all.** `design/work-items/` holds 30 assets and none depicts a
pending-plan element; `design/ai-planning/` Part XIV mentions one exactly once, in a
**rejected-candidate cell** (_"Keep it and put a pending-plan banner on the item page — Right, and OUT
of this story"_). A one-word verdict inside another surface's asset is a disposition, not a design.
That is the NONE-exists case: an ELEMENT no mockup depicts, not an unspecified detail inside a
depicted surface.

### 0. Drawn against SHIPPED reality — what was RENDERED first, and what the render settled

Every shipped element in the asset is the **literal markup of the real component**, dumped through the
repo's own vitest + RTL setup with the real `messages/en.json` and then laid out against Tailwind's
own compiled output of `@motir/design-system/theme.css` — `ArchivedNotice`, `ContentSectionCard`,
`WorkItemPlanEntrance` (both faces), the `Card` in `ExpansionNudgeBanner`'s own classes, `Pill`,
`Button`, `IssueTypeIcon`. Icon paths come from `lucide-react`'s `__iconNode`; none is drawn by hand.
The harness is reproduced in §10 rather than cited, because it is deleted before this asset lands.

| what was rendered                                    | what it settled                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ArchivedNotice` beside the new element at one width | **both are 67.5 px tall at 918 px wide** — the geometry is not _similar_, it is identical, which is what lets the two stack (panel 9) without reading as two designs                                                                                                                                                                                                                                                  |
| the `Card` in `ExpansionNudgeBanner`'s classes       | the AI-proposal mold is `bg-(--el-tint-lavender) border-(--el-border-soft)` **with `bg-(--el-card)` and `border-(--el-border)` DROPPED by `cn()`** — a mock that keeps the base card classes is not this component                                                                                                                                                                                                    |
| the two molds' inks on the lavender fill, measured   | `--el-text-strong` **9.54 : 1** light / **11.71 : 1** dark · `--el-text-secondary` **5.29 / 5.66** · `--el-accent-on-surface` **5.11** light. And the one that decides something: **`--el-text-muted` is 3.53 : 1 on lavender** — above the 3 : 1 non-text bar and visibly weaker than the glyph token, on a glyph that carries the state. **You cannot recolour the archived banner's fill and keep its glyph ink.** |
| the page at 1280, with the element in place          | main column **918 px**, element **918 × 68**, no horizontal overflow — the element inherits the page's own `grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]` rather than a drawn two-column                                                                                                                                                                                                                                |

### 1. §1 · The SLOT — first in `<main>`, above Description

**The element is the FIRST child of `<main>`, above the Description card** — the slot
`ArchivedBanner` already occupies, and for the same reason: a **whole-item state announcement**
belongs at the top of the page body, before the content (§ _Archived banner on the detail page_,
which introduced that slot and argued it against Jira / Linear).

The two alternatives, rejected on the record:

| candidate                                                               | verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the **eyebrow**, beside the breadcrumb (where the `Archived` chip sits) | **Rejected.** The eyebrow's right cluster already carries four things — `ParentRollupBadge` · `WorkItemPlanEntrance` · `WatchControl` · `WorkItemDetailActions` — and the left is breadcrumb + chip in a `min-w-0 flex-1` truncating track. A chip cannot carry a sentence, an op distinction and a link; and a second plan-adjacent affordance one gap away from the Plan / Re-plan pill is the specific confusion § _Plan / Re-plan entrance_ warns about |
| the **core-fields rail**                                                | **Rejected.** The rail holds single scalar VALUES of the card. A pending plan is not a field of this card — it is a claim by something else about this card's future — and the rail's own §§ (_repository SET_, _provenance_) are all card-owned facts                                                                                                                                                                                                      |

**What it must not read as.** `WorkItemPlanEntrance` is already on this page, in lavender, with a
`Sparkles` glyph. That control is a **door the reader may walk through**; this element is a **state
the reader is being told about**. They are kept apart by position (header vs. `<main>`), by shape
(a `--radius-badge` pill vs. a `--radius-card` box) and by voice (an imperative verb vs. a sentence
about the card). Panel 0 draws them on one page so the pair can be checked rather than asserted.

### 2. §2 · The STREAMING TIER — **tier 2, inside the page's existing concurrent group**

`detail-arrival.mock.html` allocates every region of this page into three tiers — _with the frame_ ·
_with the first content_ · _after the page_ — and had never been asked about this one. It is
**tier 2**, and that is a decision with a cost attached rather than a default.

- **Not tier 3 (the late stack).** The late stack is ONE `<Suspense>` and every one of its five
  regions sits **below the fold**; this element sits at the very TOP of `<main>`, so arriving late
  would push Description down. `detail-arrival`'s own rule is that a region which cannot make the
  first-content deadline either joins the late stack or **reserves its own box — never resizes one**.
- **And it cannot reserve a box.** The roll-up badge's precedent (a chip-sized slot filled in place)
  works because the badge renders on every parent. This element renders on well under 1 % of item
  pages, so a reserved banner-sized slot would be a permanent gap on every other card.
- **What makes tier 2 affordable, and it is measured rather than assumed.** MOTIR-3435's surviving
  half — the part that was NOT reverted with the `loading.tsx` — turned the page's twenty-nine serial
  awaits into a gate plus ONE concurrent group. A read added to that group costs `max()`, not
  `sum()`. **So the read joins the group; it is never appended after it.** A serial `await` here
  re-introduces exactly the shape MOTIR-3435 removed, on the page it removed it from.

### 3. §3 · The READ — named here, with its index, so the code card MEASURES rather than discovers

MOTIR-4197's AC 2 asks whether the page reuses MOTIR-4106's path or takes its own, and makes the cost
on a card with no pending plan a shipping condition. **It takes its own, and the shape already
exists.**

| candidate                                                      | verdict                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aiBoundaryService.readPendingPlans` (MOTIR-4106)              | **Cannot serve it.** It is PROJECT-scoped (_does this project have pending plans_), returns `itemCount` and never the proposals, caps at `AI_PENDING_PLANS_LIMIT = 10`, and lives behind the service-to-service `/api/internal/ai/*` boundary for a PROMPT. It cannot answer _which plans name THIS card_ |
| `planItemRepository.findByWorkItemId(workItemId, workspaceId)` | **This one.** Its predicate is already `{ workItemId, workspaceId, op: { in: ['modify','remove'] } }` — the drift listener's own first question — so the item page and `planDriftService` ask the same question of the same rows                                                                          |

**The index exists and is the right one. No migration is owed.** `PlanItem` carries
`@@index([workItemId, workspaceId])` — "THE REVERSE INDEX" (MOTIR-3579), whose own schema comment
records that `@@unique([planId, workItemId])` cannot serve a lookup by work item and that the
alternative is a sequential scan of every proposal in the workspace. Its leftmost column is this
element's predicate.

**What the code card still owes**, and it is one repository method rather than a discovery: the plan's
`id`, `title` and `status` come back **in the same query** (a `plan` include, or a dedicated method
that filters `plan.status` server-side), never a read per row. The honest figure for the PR body is
then _one indexed lookup, inside a group that already awaits several_ — which is a number to report,
not a cost to argue about.

### 4. §4 · The TONE — the AI-proposal mold, with the archived mold rejected on the record

Two molds ship, both are AA-safe, and **they mean opposite things**.

| candidate                                                                                                                   | verdict                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the **ARCHIVED** mold — `--el-surface-soft` fill · `--el-border` hairline · `archive` glyph in `--el-text-muted`            | **REJECTED.** It says _this is a settled, factual, reversible state of this card_. A pending plan is none of those: nothing has happened, and what is missing is a person's decision. Its glyph ink also measures **3.53 : 1** on a lavender fill (above the 3 : 1 non-text bar, and the weakest of the four inks measured) on a glyph that carries the state |
| the **AI-PROPOSAL** mold — `--el-tint-lavender` fill · `--el-border-soft` hairline · `Sparkles` in `--el-accent-on-surface` | **CHOSEN.** It says _an agent has proposed something and there is a decision to make_ — the sentence `ExpansionNudgeBanner`, `Pill status="planned"` and the Plan entrance's hover already say in lavender. A pending plan is precisely an undecided proposal                                                                                                 |

**The element takes its GEOMETRY from one and its PALETTE from the other, and that is not a third
mold.** Every class in it is one of the two shipped ones. The geometry is the archived notice's
because **two announcements sharing one slot must not have two shapes** — panel 9 stacks them, and
the pair has to read as one voice. The palette is the proposal grammar's because the MEANING is a
proposal. Picking by resemblance instead of by meaning is how a surface ends up asserting the wrong
one quietly.

| element                    | token                                                   | role                                                                                   |
| -------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| fill                       | `--el-tint-lavender`                                    | the AI-proposal ground, shared with `ExpansionNudgeBanner` and `Pill status="planned"` |
| hairline                   | `--el-border-soft`                                      | the proposal mold's own border (the `Card` base `--el-border` is dropped by `cn()`)    |
| radius                     | `--radius-card`                                         | the same family as the archived banner and every `ContentSectionCard`                  |
| lead glyph                 | lucide **`sparkles`** in `--el-accent-on-surface`       | the proposal glyph, at **5.11 : 1** — never `--el-text-muted` (3.53 : 1, above)        |
| headline                   | `--el-text-strong`                                      | **9.54 : 1** light, **11.71 : 1** dark                                                 |
| meta line                  | `--el-text-secondary`                                   | **5.29 : 1** light, **5.66 : 1** dark                                                  |
| plan-name link (many face) | `--el-text-strong`, underlined `--el-border-strong`     | the name is the link; the hue is not what makes it one                                 |
| action                     | the shipped secondary `Button` class string on an `<a>` | the same right-hand affordance geometry the archived banner puts in that slot          |

**State is carried by text + glyph, never colour alone** — the element reads as a pending proposal
from its sentence and its `Sparkles` even in greyscale, and the `modify` / `remove` distinction is
carried entirely in words.

### 5. §5 · Per `PlanStatus` — all FIVE, and `stale` is the one nobody had dispositioned

`PlanStatus` has five members. MOTIR-4197's boundary rules out three and is silent on the fourth.

| value        | indicator   | why                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generating` | **nothing** | The generation frontier is still being appended, so a `modify` naming this card may not survive to `planned`. Announcing it announces a claim nobody has finished making                                                                                                                                                                                 |
| `planned`    | **renders** | Closed for review, awaiting a decision. The case the element exists for                                                                                                                                                                                                                                                                                  |
| **`stale`**  | **renders** | The schema says it outright — _"NOT terminal and NOT decided: the plan is live and awaiting action"_ — and it is reachable ONLY from `planned`, so a plan wearing it has **by construction already reached a reviewer**. MOTIR-4129 (merged 2026-09-03, `802f1edfc`) widened `planRepository.findUndecidedByProject` to admit it for exactly this reason |
| `approved`   | **nothing** | Terminal. The proposals ARE the card now; there is no future to announce                                                                                                                                                                                                                                                                                 |
| `declined`   | **nothing** | Terminal. History, and the tree was never touched                                                                                                                                                                                                                                                                                                        |

**`stale` shows the SAME copy and the same link.** Whether a plan has drifted is a property of the
PLAN, not of this card's relationship to it, and `/plans` already carries a `Stale` pill. The
alternative — a drift qualifier on the item page — was rejected because it re-opens the boundary
MOTIR-4197 draws: this element POINTS at the plan, and a third surface describing the plan's own
state is the shape the card exists to avoid.

> **⚠️ DO NOT REUSE `AI_PENDING_PLAN_STATUSES`.** That shipped constant is
> `['generating','planned','stale']` and it is correct for its own question — _is a planning run in
> flight for this PROJECT?_ (saturation, for a prompt). This element asks _is a decision pending about
> THIS card?_, and the two come apart on exactly one member. **Declare the element's own set, beside a
> decided pair, with the same totality assertion `AI_DECIDED_PLAN_STATUSES` carries**, so a sixth
> `PlanStatus` member turns a test red instead of quietly falling out of a predicate. That is
> MOTIR-4129's own lesson applied forward rather than re-learned: _a predicate is classified by the
> QUESTION it asks_, and its ADR addendum says a file table is the wrong instrument for the sweep.

### 6. §6 · COPY — every string, per op and per plurality

Namespace **`issueViews`**, beside the archived banner's own strings: these are the ITEM PAGE's
announcements about itself. `planReview.*` is the review surface's namespace, and this is not the
review surface.

| case                | key                                    | English                                                                               | note                                                                                                                                                                                    |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| one plan, `modify`  | `issueViews.pendingPlanModifyHeadline` | **A plan proposes changes to this item**                                              | MOTIR-4197 AC 3's first sentence                                                                                                                                                        |
| one plan, `remove`  | `issueViews.pendingPlanRemoveHeadline` | **A plan proposes to archive this item**                                              | AC 3's second — a DIFFERENT sentence, not a tone                                                                                                                                        |
| both, second line   | `issueViews.pendingPlanMeta`           | **Nothing here has changed yet — the proposal applies only if the plan is approved.** | the whole reason the element is not alarming: the page the reader is looking at is still true                                                                                           |
| the control         | `issueViews.pendingPlanReview`         | **Review plan**                                                                       |                                                                                                                                                                                         |
| its accessible name | `issueViews.pendingPlanReviewAria`     | **Review the plan that names {key}**                                                  | op-neutral, and it CONTAINS the visible label (WCAG 2.5.3)                                                                                                                              |
| several plans       | `issueViews.pendingPlanCountHeadline`  | **{count, plural, other {# pending plans name this item}}**                           | ICU plural; deliberately op-NEUTRAL                                                                                                                                                     |
| a row, `modify`     | `issueViews.pendingPlanRowModify`      | **— proposes changes**                                                                |                                                                                                                                                                                         |
| a row, `remove`     | `issueViews.pendingPlanRowRemove`      | **— proposes to archive it**                                                          |                                                                                                                                                                                         |
| an unnamed plan     | `planReview.untitledPlan`              | **Untitled plan**                                                                     | **REUSED, not added.** `Plan.title` is `String?`; the shipped string already exists (`未命名计划`), and the item page and the review surface should say one thing about an unnamed plan |

**Eight new keys, and each owes its `zh` twin in `messages/zh.json` in the same pull request** — a key
added to one catalogue and not the other is a parity failure as well as a gap.

**Several plans, and BOTH OPS: the element becomes a LIST, and the mixed case dissolves.** One
right-hand control cannot name three plans, so above one plan the body becomes **one row per plan**
— each row its own op sentence, the plan's NAME as the link — and the control goes away. Every plan
stays named and linked, which is what MOTIR-4197's AC 1 actually asks for, and there is no copy
string that has to say _changes and also an archive_.

### 7. §7 · The ABSENCES, drawn

- **(a) No pending proposal ⇒ NOTHING renders.** No element, no reserved box, no empty state:
  `<main>` opens with Description exactly as it does today. This is nearly every item page, and
  panel 7 draws it because _what the common case looks like_ is part of the specification.
- **(b) No `ai:view_plan` ⇒ SUPPRESSED, and the READ is skipped too.** An indicator naming a plan the
  viewer cannot open is worse than none (AC 4). The capability is real and it is the same key the
  shell uses to decide whether to offer `/plans` at all (`lib/settings/projectNavAccess.ts`), so the
  element can never point at a destination the navigation does not offer. **The honest half, recorded
  because a code card will meet it:** that row's own evidence says _the plan READ itself is
  `canBrowse`_ — `ai:view_plan` is the OFFER key rather than the read gate, and matching the shell's
  offer is exactly what this element is doing. Skipping the read for such an actor also keeps §2's
  cost off the actor least able to benefit from it.
- **(c) THE STACK — an archived item carrying a `remove` proposal.** Both render, and the ORDER is
  decided: **the archived banner FIRST** (what this card IS), then the pending plan (what a plan
  proposes it BECOME). Present before future. The eyebrow `Archived` chip is unaffected.
  **Reachable, verified:** `planDriftService.markStaleForTerminalTarget` fires on a TERMINAL STATUS
  transition, not on archiving, so an archived target leaves its plan `planned`; `PlanItem.workItem`
  is `SetNull` and the schema's own note says archiving _"leaves the PlanItem as history"_; and the
  detail read `getIssueDetail → findByIdentifier` does not filter `archivedAt`, so the page renders
  (the same precondition § _Archived banner on the detail page_ verified for the banner).

### 8. §8 · ACCESS PATH, in both directions

- **IN** — the plan-review peek in proposal mode, whose `Open the work item as it stands →` control
  (Part XIV §7, `target="_blank"`) is what puts the reader here. Panel 13 draws that door in its own
  surface rather than naming the route.
- **OUT** — `/plans/<id>`, through the element's own control. The round trip closes: Part XIV
  re-labelled the peek's control so its tense is honest, and this element is what makes the
  destination agree. **It POINTS; it does not re-render the proposed values** — that is MOTIR-4197's
  own OUT, and a third surface rendering them is the defect rather than the fix.

### 9. §9 · a11y

- `role="status"` — a state announcement, not an alert (a pending plan is not urgent), so a screen
  reader surfaces it without interrupting. Same posture as `ArchivedNotice`, whose markup this is.
- The `Sparkles` glyph is `aria-hidden`; the headline carries the meaning. The control is a real link
  with `aria-label` **Review the plan that names {key}**, which CONTAINS its visible text.
- AA holds in both themes on every ink used, measured above; no hue carries meaning, so the element
  is colour-blind-safe. The `modify` / `remove` distinction is entirely lexical.
- In the several-plans face each row's link is the plan's own NAME, so a link list read out of
  context still says which plan each one opens.

### 10. §10 · How this asset was produced (reproduced here, because the harness is deleted)

1. **Dump the shipped markup.** A throwaway component test in the `tests/components/` directory renders the real
   components with the repo's `renderWithIntl` helper and writes `container.innerHTML` per state.
   **Run it under its OWN vitest config with `globalSetup` omitted** — the root config provisions the
   shared per-worker databases, and on this box a second provisioning corrupts a sibling session's
   run. The dump needs no database at all.
2. **Compile the stylesheet from the mock's BODY MARKUP ONLY** — never the whole file, which already
   contains that output and would feed candidates back into the next compile:
   `@import 'tailwindcss' source(none); @import '@motir/design-system/theme.css'; @source "./body.html";`
   through `@tailwindcss/postcss` (`@tailwindcss/cli` is not installed in this repo; `postcss` is not
   hoisted, so import it by its `.pnpm` path).
3. **Icons from `lucide-react`'s own `__iconNode`**, following the alias re-exports; no path is
   retyped or drawn.
4. **`prettier --write` the mock, THEN** `node scripts/render-design-mock.mjs --width 1400`. Prettier
   reformats the source, so a PNG rendered before it is not an export of what landed.

### 11. §11 · GIVES / TAKES — swept over the subtree

`grep -o 'MOTIR-[0-9]*'` over the finished asset returns **MOTIR-4197 · MOTIR-4256 · MOTIR-4106 ·
MOTIR-4129 · MOTIR-3435 · MOTIR-3436 · MOTIR-3579 · MOTIR-4181 · MOTIR-4182 · MOTIR-3432**. Of those,
one is not `done` and it is the only card this asset can move.

| card                               | GIVES / TAKES | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-4197** — the indicator     | **GIVES**     | the slot and its tier · the tone with the loser rejected and every token named · the copy table with its keys and `zh` obligation · the three absences · the access path · **and the READ, with the repository method, the status set and the index it is served by** — AC 2's first question is answered here rather than left to the build                                                                                                                                                           |
| **MOTIR-4197**                     | **TAKES**     | its boundary's silence on **`stale`**. The card lists `generating` / `approved` / `declined` as OUT and never names the fifth member; this asset rules `stale` IN, on the schema's own words and on MOTIR-4129's widening. **Amended on the record in the same pass** (AC 1's status set, and AC 5's vitest arms)                                                                                                                                                                                      |
| **MOTIR-4197**                     | **SIZE**      | re-run against the asset: 5 points / 65 minutes still fits. The element is one presentational component plus one repository read plus eight i18n keys × two catalogues; **no migration** (the reverse index exists), no new route, no background job, no new design surface. The list face is the one thing the card's criteria did not contain, and it is markup rather than a second read. **No re-estimate is owed** — recorded because a silent "no change" and an unasked question look identical |
| **MOTIR-3432** — the arrival asset | **TAKES**     | the three-tier allocation and the _reserve a box, never resize one_ rule. Nothing is given back: that asset's table gains a row only when this element ships, and the row is stated in §2 rather than written into a merged asset                                                                                                                                                                                                                                                                      |
| Part XIV (MOTIR-4182)              | **TAKES**     | the `Open the work item as it stands →` door and the seam it names. It also gets one **correction** — below                                                                                                                                                                                                                                                                                                                                                                                            |

### 12. §12 · A correction to `design/ai-planning/design-notes.md` Part XIV §8

Part XIV §8 says a `remove` _"whose target is already archived or hard-deleted (the DTO's own flag)
shows the peek's shipped NOT-FOUND panel"_. **The archived half is wrong**, and it matters here
because panel 9's stack depends on it: `planReviewService` computes `targetMissing = item.op !==
'add' && !target`, and its batched target read is `workItemRepository.findByIdsInWorkspace`, a plain
`findMany({ where: { id: { in: ids }, workspaceId } })` that does **not** filter `archivedAt`. So an
archived target IS resolved and `targetMissing` is `false`; only a hard-DELETED one is missing. The
sentence is corrected in place, in the notes, with no asset re-exported.

### 13. §13 · What this asset does NOT draw

The peek, the plan list row, the plan canvas and `/plans/<id>` — all Part XIII / Part XIV's, all
already drawn. The proposed VALUES on the item page (MOTIR-4197's own OUT). Any change to the
arrived page's layout, copy or controls: this asset adds ONE element to ONE slot and changes nothing
else.

### AMENDMENT A (2026-09-03, MOTIR-4364) — the THIRD case: a plan that proposes CHILDREN under this card

**Card ·** MOTIR-4364. **Gates ·** MOTIR-4365, which is `blocked_by` it. **Amended against**
`origin/main` @ `050416d01`. **Panels 15–18** of `pending-plan-indicator.mock.html`; panels 0–14 and
everything §§1–13 settle are unchanged.

**What forced it.** The copy table above is complete for the ops the reverse lookup could return when
it was written, and §6 says so: `findPendingByWorkItemId` filters `op: { in: ['modify','remove'] }`,
and the deeper reason is that **an `add` has no `workItemId` at all** — it carries a `parentRef`, and
the row it would name does not exist until the plan is approved. MOTIR-4365 widens the lookup to a
second arm keyed on `parentRef`, and the element then receives a proposal shape no string in §6
covers. **The commonest plan in this project is an expansion** — `motir plan <story>` produces N
`add`s under one card — so the element is silent in the situation it would be most useful in.

#### A0 · What was RENDERED, and what the render settled

The amendment's panels are the same dumped `PendingPlanNotice` markup as panels 3–6 — the same frame,
glyph, ink and control class strings, with only the sentence changed. Nothing is redrawn and no token
is added. What was measured is the thing the new strings could break:

| what was rendered                                              | what it settled                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all FIVE claims at **918 px** (the main column §0 measured)    | every one is **67.5 px with a single-line headline** — including the longest, _A plan proposes changes to this item, and 8 work items under it_. That is §0's `ArchivedNotice` parity exactly, so panel 9's stack survives the amendment and **the children clause does not have to buy a third line**                                         |
| the same five at **366 px** (the mock's phone frame, panel 18) | **126.5 px over two lines** for the two SHIPPED strings and the three simpler new ones; **146.5 px over three** for the two MIXED headlines. The extra line is the amendment's whole cost at the narrow breakpoint — one box, no overflow, no horizontal scroll — and it is spent where the column is 366 px rather than where the stack lives |
| the nested dark scope, resolved                                | `--el-tint-lavender` → `#2a253a` on a `#0f0f0f` page with `#e5e5e5` ink — the scope flips its own Tier-0, which is the check a `data-theme` without `data-appearance-scope` fails silently                                                                                                                                                     |

#### A1 · §6 EXTENDED — the copy, per claim

**A plan makes ONE claim about this card, and there are five.** `@@unique([planId, workItemId])`
allows one `modify` OR one `remove` per plan per card, and Postgres treats NULLs as distinct, so N
`add` rows with a null target coexist with it. The reachable set is therefore
`modify` · `remove` · `add` · `modify`+`add` · `remove`+`add`; `modify`+`remove` is excluded by the
constraint rather than by choice, and a component total over five cases is total over what the query
can hand it.

| case                                                                                               | key                                       | English                                                                                                                                                           | note                                                                               |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| one plan, `add`                                                                                    | `issueViews.pendingPlanAddHeadline`       | **{count, plural, one {A plan proposes to add # work item under this item} other {A plan proposes to add # work items under this item}}**                         | ICU plural on the CHILD count                                                      |
| one plan, `modify`+`add`                                                                           | `issueViews.pendingPlanModifyAddHeadline` | **{count, plural, one {A plan proposes changes to this item, and # work item under it} other {A plan proposes changes to this item, and # work items under it}}** | the shipped `modify` sentence with a second clause — not a new voice               |
| one plan, `remove`+`add`                                                                           | `issueViews.pendingPlanRemoveAddHeadline` | **{count, plural, one {A plan proposes to archive this item, and # work item under it} other {A plan proposes to archive this item, and # work items under it}}** | expressible and incoherent; drawn anyway, for the totality this section opens with |
| a row, `add`                                                                                       | `issueViews.pendingPlanRowAdd`            | **{count, plural, one {— proposes # work item under it} other {— proposes # work items under it}}**                                                               |                                                                                    |
| a row, `modify`+`add`                                                                              | `issueViews.pendingPlanRowModifyAdd`      | **{count, plural, one {— proposes changes, and # work item under it} other {— proposes changes, and # work items under it}}**                                     |                                                                                    |
| a row, `remove`+`add`                                                                              | `issueViews.pendingPlanRowRemoveAdd`      | **{count, plural, one {— proposes to archive it, and # work item under it} other {— proposes to archive it, and # work items under it}}**                         |                                                                                    |
| the count headline                                                                                 | `issueViews.pendingPlanCountHeadline`     | **UNCHANGED** — {count, plural, other {# pending plans name this item}}                                                                                           | it counts PLANS and always did; see A3                                             |
| the meta line, the control, its aria name, the two shipped op sentences, `planReview.untitledPlan` | —                                         | **UNCHANGED**                                                                                                                                                     | op-neutral or already correct; nothing above re-words a shipped string             |

**Six new keys, and each owes its `zh` twin in `messages/zh.json` in the same pull request** — the
same obligation §6 states for the original eight. Suggested `zh`, in the register the shipped twins
already use (Chinese has one plural arm, so each is `other` only, exactly as
`pendingPlanCountHeadline`'s twin is):

| key                            | `zh`                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `pendingPlanAddHeadline`       | `{count, plural, other {有一个计划提议在此工作项下新增 # 个工作项}}`           |
| `pendingPlanModifyAddHeadline` | `{count, plural, other {有一个计划提议修改此工作项，并在其下新增 # 个工作项}}` |
| `pendingPlanRemoveAddHeadline` | `{count, plural, other {有一个计划提议归档此工作项，并在其下新增 # 个工作项}}` |
| `pendingPlanRowAdd`            | `{count, plural, other {——提议在其下新增 # 个工作项}}`                         |
| `pendingPlanRowModifyAdd`      | `{count, plural, other {——提议修改，并在其下新增 # 个工作项}}`                 |
| `pendingPlanRowRemoveAdd`      | `{count, plural, other {——提议将其归档，并在其下新增 # 个工作项}}`             |

**Why the COUNT is in the headline when `modify`'s magnitude is not.** A `modify`'s size is not
knowable from the row — `patch` is a sparse JSON blob, and one field and nine fields read
identically — so the shipped headline correctly says only that changes are proposed. An `add`
count IS its magnitude, it arrives on the same query, and it is the entire difference between _a
tweak_ and _a story about to gain a subtree_. The asymmetry is earned.

**Two candidates rejected, on the record:**

| candidate                                                                                        | verdict                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A THIRD LINE** — the children clause under the headline, as its own row                        | **Rejected, and MEASURED.** §0's whole geometry argument is that the element is 67.5 px, identical to `ArchivedNotice`, which is what lets panel 9 stack them as one voice. A third line breaks that parity for the case that most often stacks. A0 shows the clause fits on one line at 918 px, so the line buys nothing |
| **COMPOSING the sentence from clause fragments** (a shared frame + an appended "and N under it") | **Rejected.** Conjunction, word order and agreement are per-language; a fragment-composed sentence is an i18n defect that only shows up in the `zh` catalogue. Six whole strings is what totality costs, and it is the same trade §6 already made when it paid a string per op rather than templating one                 |

#### A2 · §4 RE-OPENED and KEPT — the tone does not change

MOTIR-4364 asks whether _work is being planned under you_ argues for a different mold from _a change
is proposed to you_. **It does not, and the answer is KEPT: the AI-proposal mold is unchanged** —
`--el-tint-lavender` fill, `--el-border-soft` hairline, `Sparkles` in `--el-accent-on-surface`, every
ink as §4 measured it.

The distinction is real, and it is a distinction in WHAT is proposed rather than in WHETHER a
decision is pending. §4 chose the mold for the second: _an agent has proposed something and there is
a decision to make_. That sentence is exactly as true of eight children as of a renamed title.

**And changing it would break a property §9 asserts.** §4's closing rule is that state is carried by
text and glyph, **never by hue** — the `modify` / `remove` distinction is entirely lexical, which is
what makes the element colour-blind-safe and legible in greyscale. A third case that took a different
tint would make hue carry meaning for the first time on this element, and it would do so on the axis
a reader is least able to name. **The rejected alternative, so it is on the record:** a `--el-tint-sky`
"structural" mold for `add`-bearing plans. Rejected because (a) it makes hue meaningful, (b) it owes a
second measured ink table against a different fill, and (c) it breaks panel 9's stack, where two
announcements sharing one slot must read as one voice.

#### A3 · The COUNT, and the DTO collapse it requires — the answer to _what does it count when the kinds are mixed_

**`pendingPlanCountHeadline` counts PLANS. It always did, and it needs no change.** What it does need
is for the array the component counts to go back to meaning what the string says.

Today `PendingPlanNotice` renders `t('pendingPlanCountHeadline', { count: proposals.length })`, and
that is correct only by accident: `@@unique([planId, workItemId])` capped a plan at one `modify` /
`remove` per card, so **one row was one plan**. The `parentRef` arm breaks the accident — a plan
holding eight `add`s under this card produces eight rows — and a component that keeps counting rows
announces **"11 pending plans name this item"** about three plans. Nothing errors; the string is
still grammatical; it is simply false.

**So the DTO collapses to ONE ROW PER PLAN**, carrying that plan's whole claim:

```ts
export interface WorkItemPendingProposalDto {
  planId: string;
  planTitle: string | null;
  planStatus: WorkItemPendingPlanStatusDto;
  /** What this plan proposes about THIS card. `null` when it only adds children. */
  op: Exclude<PlanItemOpDto, 'add'> | null;
  /** How many `add`s in this plan name this card as their parent. `0` when none. */
  childCount: number;
}
```

with the invariant **`op !== null || childCount > 0`** — a row that claims nothing is not a row. The
five claims of A1 are exactly the five inhabited combinations, so a `switch` over them is total and a
sixth `PlanItemOp` turns it red rather than falling through to a wrong sentence.

**The collapse is free.** The rows already come back ordered by `plan.createdAt`, and grouping them
by `planId` in `plansService.listPendingProposalsForWorkItem` is an in-memory fold over a set bounded
by the proposals naming one card. **It is not a second query**, so §3's _one indexed lookup inside a
group that already awaits several_ survives — which is the figure MOTIR-4197 made a shipping
condition.

#### A4 · GIVES / TAKES — swept against MOTIR-4365

| card                        | GIVES / TAKES | what                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4365**              | **GIVES**     | the six strings with their keys, their ICU plural forms and their `zh` twins · the five-claim discriminant its AC 5 asks for a total form over · the tone answer (nothing to change) · the DTO shape and the per-plan collapse · and the measurement that the new sentences fit the shipped box                                                                                                                        |
| **MOTIR-4365**              | **TAKES**     | its **AC 2**, which asserts the existing integration test passes _"without amendment to its existing cases"_. `tests/integration/plans/pendingPlanIndicator.test.ts` asserts whole objects with `toEqual` (`{ planId, planTitle, planStatus, op }` ×4 occurrences), so a required `childCount` amends every one of them. The BEHAVIOUR is unchanged; the assertion literals are not                                    |
| **MOTIR-4365**              | **TAKES**     | the silence in its scope boundary about a **migration**. Its AC 3 requires the new arm to be index-backed, and `PlanItem` has `@@index([planId])`, `@@index([workspaceId])` and `@@index([workItemId, workspaceId])` — **nothing on `parentRef`**. The arm needs `@@index([parentRef, workspaceId])` and its generated migration, which is one more deliverable than the card's text implies                           |
| **MOTIR-4365**              | **SIZE**      | **re-estimated on the record: 3 → 5 points, 45 → 65 minutes.** Anchored on MOTIR-4197, which built the whole element — component, read, page wiring, 8 keys × 2 catalogues, tests — at 5 / 65. This is strictly smaller in kind (no new component, no page wiring, no design) and larger than its own 3 / 45 (a migration, a DTO change, a service fold, 6 keys × 2, six integration cases)                            |
| **MOTIR-4365**              | **NOTE**      | `validate_work_item` on the amended card returns a `likely-in-flight` subsumption advisory: `messages/zh.json` is touched by OPEN pull request moooon-B-V/motir-core#2581 (MOTIR-3943). Not a blocker and not an edge to wire — a catalogue-conflict heads-up for whoever runs MOTIR-4365, since this amendment sends it back to the same file for six `zh` twins. Read that pull request before editing the catalogue |
| **MOTIR-4256 / MOTIR-4197** | **neither**   | both `done`; nothing here re-opens them. §§1–13 stand and this section only extends §4 and §6                                                                                                                                                                                                                                                                                                                          |

#### A5 · What this amendment does NOT touch

The slot, the streaming tier, the token table, the per-`PlanStatus` rows, the three absences, the
access path and the `stale` disposition — all §§1–13's, all unchanged. The status set stays
`planned` + `stale`. The peek, the plan list, the canvas and `/plans/<id>` remain out. This
amendment adds one CASE to a drawn element; it draws no new element and no new surface.

---

## ⭐ The UNIVERSAL APPROVAL FRAME (Story MOTIR-4778 · MOTIR-4789 — `approval-control.mock.html`)

**The asset:** `approval-control.mock.html` + `approval-control.png` (1200 CSS px viewport, `deviceScaleFactor: 2` → 2400×8602).

> **⚠️ SECOND CUT.** The first drew the BUTTON as the shared element and left the subject as a stub. Rejected on review: _"Approve button without review doesn't stand — the user needs to see what he is approving. That's why it's called universal: a universal frame/port the user can see what to approve, then approve, decline buttons."_ (Yue, 2026-09-08, on motir-core#2715.)

### The correction, stated once

**The universal element is the FRAME, not the verb pair.** What a person learns once is not where the button is — it is **what reviewing looks like**. An Approve control beside a stub, or above a section the reader must scroll to, asks for a signature rather than a decision.

**Also withdrawn from the first cut:** its rule that _"the control sits at the HEAD of the section, never below the artefact."_ That was the right observation — a reader should not scroll to discover a decision is owed — answered the wrong way, by moving the button FURTHER from the thing it decides. The frame removes the problem instead of relocating it.

### The frame — three bands

| band              | holds                                                                                         | varies by kind?               |
| ----------------- | --------------------------------------------------------------------------------------------- | ----------------------------- |
| **1 · header**    | what you are looking at, which version, when it arrived, the state pill                       | shape no, words yes           |
| **2 · THE PORT**  | **the subject, RENDERED**                                                                     | **contents yes, the band no** |
| **3 · the verbs** | Approve · Request changes, **below the port**, with what approving will DO stated beside them | no                            |

**The port's mechanics are the design, not a detail:**

- a **floor height**, so the subject is never a sliver;
- a **ceiling with its own scroll**, so a tall subject never pushes the verbs off screen;
- an **Expand** affordance, for a subject that deserves the whole viewport.

**The verbs sit BELOW the port** because you decide after you look. That ordering is the whole correction.

### The states

`A` awaiting-yours (drawn as the anatomy panel) · `B` awaiting-not-yours · `C` confirming · `D` in flight · `E` approved · `F` changes requested · `G` superseded · `H` refused · **`X` the port FAILED**.

> **⚠️ THESE ARE WORKFLOW A's STATES, and that is the whole of this story.** `approval-gates.md` §8
> (added by [MOTIR-4911](motir:cmtt4oguv000ihutxbryd9iz2), merged `61e3e5e79`) splits the model on one
> question — _does the work item have a linked OPEN pull request?_ Story MOTIR-4778 is the NO arm:
> **approval is TERMINAL and writes `done`**, which is what `E` draws. The YES arm lands the card in
> the new `approved` status and lets the MERGE write `done`, and its states are drawn by the stories
> that own them — [MOTIR-4905](motir:cmtt4ogf0000chutxzw8ssnq2) (the status itself),
> [MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2) (approve-and-merge in one press) and
> [MOTIR-4910](motir:cmtt4ogrf000hhutxyjqeaxeq) (a GitHub approval, whose actor may be an identity
> Motir cannot map to a member). **`E` is not under-drawn; it is drawn for the arm this story ships**,
> and panel `U` is where the other arm's frame is shown to be the same frame.

**Four are load-bearing:**

1. **`B` keeps the port.** A reader who may not decide can still SEE what is being decided; only the verbs are absent. Under the button-first cut this state was a sentence.
2. **`E` keeps showing the approved version** even after a newer design is published — which is what ADR §6c's pin is FOR. Without the port, `E` is a row of metadata about something nobody can look at any more, and the pin's purpose is invisible. **§6c's pin is keyed on the SUBJECT, not on the gate kind** (re-keyed by MOTIR-4911, because a design with a pull request is approved through `pull_request_approval` and a kind-keyed pin would simply stop firing for it, silently) — so `E` draws the pinned version for BOTH arms of §8.
3. **`G` (`superseded`) is colourless and verb-less.** Written by the PRODUCT, not a person (ADR §6b); the audit must never read it as a decision somebody made.

   > **⚠️ AMENDED AGAIN 2026-09-17 (Bug [MOTIR-5652](motir:cmu5dutva002dhwtxwxlbty76) · Subtask MOTIR-5667) — `G`'s dead port NAMES ITS REAL CAUSE, one true sentence per value.**
   >
   > ~~_"This question was withdrawn." / "Nobody decided it."_~~ → the sentence for the row's own `superseded_cause` (`approvalGate.withdrawn.cause.*`, `en` + `zh`): _"A newer design was published…"_ · _"The design result was withdrawn…"_ · _"A push moved the commits…"_ · _"A pull request closed…"_ · _"The pull requests changed…"_ · _"The work was pulled back out of review…"_.
   >
   > **The amendment below could only make the sentence VAGUER, and said so.** Its reasoning was right about the row, not about the copy: `superseded` recorded `state` and nothing else, so the frame could not tell the writers apart and any named cause was false most of the time. MOTIR-5659 gave the row a CAUSE, from a closed vocabulary with one value per writing path — so the frame can say what happened instead of only that something did.
   >
   > **`unknown` says _the reason was not recorded_ and NEVER a real cause.** It is the backfill's value for rows that predate the column, and a null cause reads the same way. Inferring one from a row's shape would manufacture evidence, and this sentence is shown to a person as fact.
   >
   > The same sentence is now the `APPROVAL_GATE_SUPERSEDED` refusal's headline, because a reader who presses a withdrawn question and then looks at the frame is being told about ONE event.
   >
   > **⚠️ AMENDED 2026-09-17 (Bug [MOTIR-5586](motir:cmu30qjra00g6hvoiiu6ljuhv)) — SUPERSEDED BY THE AMENDMENT ABOVE; kept as the record of why the copy went vague first. `G`'s dead port NAMES NO CAUSE AND POINTS NOWHERE. The mocks quote the superseded wording and are records of their moment; this line is the copy of record.**
   >
   > ~~_"A newer design was published, so this question was withdrawn." / "Nobody decided it. The current version is above."_~~ → **_"This question was withdrawn." / "Nobody decided it."_** (`approvalGate.withdrawn.port` / `.portCite`, `en` + `zh`.)
   >
   > **Why the fact and not the cause: FOUR product writes mark a gate `superseded`, and only ONE of them publishes anything.** A republish ([MOTIR-4913](motir:cmtt4ogzm000khutx4qaba3bp)) does; a WITHDRAWAL ([MOTIR-5574](motir:cmu2gjksk01gshztxqstqfq6i)), a hand pull-back out of review or to Cancelled ([MOTIR-5527](motir:cmu1lj5ur003thvoi12tgo8fv)) and linking an OPEN pull request ([MOTIR-5534](motir:cmu1mcnrr000ai0txplyb9iqz)) do not. On three of the four the old first sentence was simply false, and _"the current version is above"_ pointed at a port this very state draws DEAD — so it was false there even for a republish, read on the item page. **The row cannot tell the causes apart**: ADR §6b makes a supersede write `state` and nothing else, so a cause-aware sentence would first need data the gate does not store. The honest sentence is the one that holds for every writer, and dropping a claim needs no new column.
   >
   > **A CALLER MAY STILL SUPPLY A CAUSE, and that is the extension point rather than an exception.** `ApprovalGateControl`'s optional `withdrawnPort` prop lets a kind whose own surface KNOWS the cause pass its own two sentences — the approve-to-merge gate does ([MOTIR-5604](motir:cmu39zcqv0076hwtxfs5r2b5u): _"A push moved the head of {pr} …"_, `approvalGate.pullRequestApproval.withdrawn.*`, drawn in `design/github/design-notes.md`). **The keys amended here are the FRAME's default**, drawn whenever no caller can name the cause — which is every `design_result` gate.
   >
   > Nothing else about `G` moves: colourless, verb-less, dead port, and a record strip that names no actor and no decision time.

4. **`X` — the port failed, so there are NO verbs.** _You cannot approve what cannot be shown._ This is the frame's premise made mechanical rather than advisory, and **it did not exist in the first cut** — a design that draws only a button has nowhere to put the failure, so the button stays live over a subject nobody can see.

**The confirm (`C`) is an inline band OVER the verbs, never a modal** — a modal would take the port off screen at exactly the moment the reader wants one last look.

### Universality — how it is PROVEN in the asset

**The rule the asset draws, in the ADR's own words:** _"The kind decides the VERBS and the EFFECT; the
PORT decides what you LOOK at, and the port is chosen by what the card PRODUCED, not by the kind"_
(§1, amended by MOTIR-4911).

Panel `U` therefore draws **two frames carrying the SAME gate kind — `pull_request_approval` — with
different ports**: one over a code card, whose port is _what changed and how to test it_
([MOTIR-4906](motir:cmtt4ogi0000dhutx1ekfm43s)'s contents, ADR §9, the diff a link out rather than the
lead), and one over a DESIGN card that opened a pull request, whose port is **the same design port as
state `A`**. That pairing is the sharpest available form of the claim, and it is the form the earlier
cut got wrong: it drew the second frame as a MERGE port and captioned it _"the merge port's contents
are MOTIR-4882's"_, which reads the port off the KIND — exactly what §1's amendment denies.

**What is still not specified here:** the merge port's own contents and the six merge refusals remain
[MOTIR-4882](motir:cmtrwx3580055hxph0vfamj1l)'s, and the how-to-test body is
[MOTIR-4906](motir:cmtt4ogi0000dhutx1ekfm43s)'s. This asset specifies **the frame those ports drop
into**. This is what MOTIR-4796's one-language test asserts: the same component in every context, not
a family of look-alikes.

### Placement — the frame has TWO homes, and the asset draws the door to each

**This was missing from the first two cuts, and it is what made the asset unreadable to its reviewer** ("which page is this? the Workbench? I don't see how it's related"). The design-reference rule requires an asset to DRAW its access path — the entry affordance in the parent surface, so the reader SEES the door, not just the room. Naming the route in prose is not enough, and panels 0a / 0b now draw it.

| route                          | where the frame sits                                                                                                                                                         | door                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`/items/[key]`**             | it **IS** the `Design result` section — it REPLACES today's read-only `DesignResultPanel` in the late stack (`LateSections.tsx`), same slot, same position after Development | you are already on the card                                                                                                                          |
| **`/workbench?tab=approvals`** | inside an Approvals **row**                                                                                                                                                  | the _Workbench_ rail entry — the first primary entry, and where signing in lands (`AUTHED_LANDING_PATH = '/workbench'`) — then the **Approvals** tab |

**The Approvals tab slot ALREADY SHIPS.** `WorkbenchTab` is `todo | in-progress | finished | watching | approvals` (MOTIR-4777), so this asset adds no navigation and invents no route.

**Ownership across the two panels, so the boundary is legible:** the rail and the tab STRIP are `design/workbench/`'s, shipped by MOTIR-4777 and **composed** here rather than redrawn. The Approvals **rows**, their ordering and the nothing-awaits-you state are **[MOTIR-4879](motir:cmtrwx30n0052hxphd0yqbnwb)**'s. **This asset specifies the FRAME** — the thing inside both, identical in each.

### Scope

**Drawn:** the frame, the design port, all nine states, and the DOOR to both homes. **Not drawn:** the Approvals tab ([MOTIR-4879](motir:cmtrwx30n0052hxphd0yqbnwb)); the merge port's contents and the six merge refusals ([MOTIR-4882](motir:cmtrwx3580055hxph0vfamj1l)).

### What it COMPOSES rather than redraws

- **`design-result.mock.html`** — the note, the sandboxed mock at its 32rem height, the screenshot. These are the design PORT's contents; the asset cites that file and draws the frame around them.
- **`acceptance-panel.mock.html`** — the shipped approval gesture. **Carried:** the verb pair, the decided read-only variant, the `pending | approved | changes_requested` vocabulary, the provenance strip. **Deliberately different:** acceptance FREEZES on approval and refuses supersede; a design gate PINS, because a design legitimately evolves and the revise loop depends on republishing (ADR §6c). **And acceptance has no port** — its subject is a video, which is its own viewport; that is why the frame is new work rather than a rename of that panel.

### Primitives and tokens

`ContentSectionCard`, `Button` variants, `Pill` (tint + `--el-text-strong`, finding #35), the avatar/meta grammar. No new visual primitive. Colour only Tier-3 `--el-*`; radius / padding / height / elevation only element-semantic shape tokens. Captions on tinted surfaces take `--el-text-secondary`; `--el-text-muted` and `--el-text-faint` are never painted; the two alerts take `--el-danger-on-surface`, never `--el-danger-text`.

### Planning flags

- **`X` (port failed) is a NEW state** that neither the card nor the ADR names. It follows from the frame, and [MOTIR-4792](motir:cmtqhxivs001fhvphj7chww7a) must build it: **the verbs are gated on the port having rendered.** That is a real behavioural requirement, not a visual one.
- **`E`'s "Files kept" implies a DTO field** — whether this version's assets are pinned — which comes from [MOTIR-4788](motir:cmtqhxirq001bhvph62zql96j)'s audit columns.
- **The port needs a rendering contract per kind.** The design port sandboxes HTML (`design-result.md` §5's three-layer serving posture already decides this); the merge port renders a diff. MOTIR-4792 builds the frame and the design port only.
- **The ADR says `changes_requested`; Yue said "decline".** The asset draws `Request changes`, because for a design that verb feeds the revise loop. **A terminal DECLINE as a distinct third verb would be an ADR change and its own card** — not something this asset invents.
- **⚠️ THIRD CUT — the RECORD moved under the asset, and the asset had to move with it.** `approval-gates.md` was AMENDED by [MOTIR-4911](motir:cmtt4oguv000ihutxbryd9iz2) and merged at `61e3e5e79`, **after** the second cut was drawn and after motir-core#2715 was closed. Two of this asset's claims were falsified by it and are corrected in this cut: panel `U`'s kind-decides-the-port premise (§1's amendment says the port follows what the card PRODUCED), and `E`'s citation of a §6c pin that has since been re-keyed onto the SUBJECT. **Nothing else in the asset was re-opened**, because the six surfaces the amendment adds all have owners already — MOTIR-4905, -4906, -4907, -4909, -4910 and -4914 were created in the same pass that amended the record. The frame is unchanged; only what it CLAIMS about other kinds was wrong.
- **The verbs band is a SLOT the kind fills, not a fixed pair.** ADR §1's amendment registers `decision_choice`, whose verb set is N options rather than two verbs, and asserts that the frame already accommodates it. [MOTIR-4792](motir:cmtqhxivs001fhvphj7chww7a) should build band 3 so that the verb SET is supplied by the kind — a pair is then one case, not the shape. Drawing the N-option band itself is [MOTIR-4914](motir:cmtt4oh1t000lhutxmpv3jkzv)'s.

### GIVES / TAKES

| work item                                   | GIVES / TAKES                                                                                                                                                                                                                                                                                 | what |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **MOTIR-4792** (the control)                | **GIVES** the frame, its three bands, the port mechanics, all nine states, the token/primitive map. **TAKES** — its criteria say "the control"; they now owe **the FRAME and its port**, plus the `X` state's verb gating. Amended on that card in this pass.                                 |
| **MOTIR-4882** (the merge gate)             | **GIVES** the frame it drops its port into, the confirm grammar, the refusal placement. **TAKES nothing** — its port contents and its six refusals are explicitly left to it.                                                                                                                 |
| **MOTIR-4906** (how to test)                | **GIVES** the port its three paths render inside, and the rule that an unavailable path is SAID to be unavailable rather than omitted. **TAKES nothing** — the body's content and its click-paths are its own.                                                                                |
| **MOTIR-4905 / -4909 / -4910** (Workflow B) | **GIVES** the frame, unchanged, for the arm where a pull request exists — panel `U` shows it is the same frame. **TAKES nothing**: the `approved` status, the one-press approve-and-merge and the GitHub-sourced decision are theirs, and `E` here draws only Workflow A's terminal approval. |
| **MOTIR-4914** (the choice gate)            | **GIVES** band 3 as a verb SLOT the kind fills, so N options need no second control. **TAKES nothing** — the option rows, their named axes and the stamp are its own.                                                                                                                         |
| **MOTIR-4879** (the Approvals tab)          | **GIVES** the frame a row composes or links to. **TAKES nothing.**                                                                                                                                                                                                                            |
| **MOTIR-693** (9.2 hosted review)           | **GIVES** the frame its review UI composes rather than drawing its own, per ADR §5.                                                                                                                                                                                                           |
| **MOTIR-2664** (`design-result.mock.html`)  | **neither** — `done`; composed and cited as the port's contents, not redrawn.                                                                                                                                                                                                                 |

---

### AMENDED 2026-09-13 — the SETTINGS DOOR (MOTIR-5176, story MOTIR-4880; panel `S`)

**A KIND-SUPPLIED affordance, not a fourth band and not a verb.** ADR §7
(`approval-gates.md`) asks for a deep link from the approval surface to the
setting that stops asking. Someone who defaulted to _Ask before merging_ and
cannot read a diff must be able to find it while they are stuck. A kind supplies
an optional `settingsHref` and a label. Band 3 renders it in its **left column,
under the consequence line**. A kind that supplies none renders nothing, and band
3 is byte-identical to state `A`.

- **Copy (pull-request-merge kind):** _Change how this project merges pull
  requests →_. It names the PROJECT and the SETTING, never the pull request in
  front of the reader, so it reads as _change how this project is merged_ and not
  as _skip this decision_. It is a link (`--el-link`), not a `Button`: pressing it
  decides nothing, and the gate stays `awaiting`.
- **Placement, and the two rejected spots.** Not in the header, where it would
  read as part of WHAT is being decided. Not beside the verbs, where it would read
  as a third verb.
- **Rendered only for a viewer who holds `workflow:manage`**, the key the
  Approvals room and its route are guarded by. A viewer without it cannot land on
  the page, so a door for them would lead to a refusal, and their frame has none.
  There is no read-only room (Yue, 2026-09-13). The door lands at
  `/settings/project/approvals#merge-mode` (`design/projects/approvals.mock.html`
  panel 8), in the same tab.
- **The merge PORT is still MOTIR-4882's** and is drawn only as a labelled
  placeholder. This amendment draws no merge, no merge refusal and no
  `pull_request_merge` gate.

**Planning flags.** **MOTIR-4882 builds the door** in `ApprovalGateControl.tsx`
as an optional kind-supplied `settingsHref` + label when it registers the merge
kind. **MOTIR-5181 owns the landing** (the anchor).
**MOTIR-4792's shipped frame needs no change** until then.

## ⭐ The ACCEPTANCE gate, in the ONE approve language (MOTIR-4942 — `acceptance-panel.mock.html`, panels G1–G5)

**Amendment to _Acceptance video (Story MOTIR-1627)_, and a consumer of _THE
UNIVERSAL APPROVAL FRAME_ above.** Once MOTIR-4950 registers
`acceptance_result` as a gate KIND, the acceptance panel stops being a bespoke
surface with two buttons on the end and becomes the same frame every other gate
kind renders in. Panels **G1–G5** of `acceptance-panel.mock.html` draw that.

Card: **MOTIR-4942**, under epic **MOTIR-4878**. The frame itself is
**MOTIR-4778 / MOTIR-4789**'s and is not redrawn — this section says what the
ACCEPTANCE kind supplies to it.

### What the kind supplies to the frame

The frame is presentational plus one action; a kind supplies the PORT's contents
and a few labels. For `acceptance_result`:

| frame prop             | acceptance's answer                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kindLabel` (band 1)   | **Acceptance video**                                                                                                                                                                                      |
| `subjectMeta` (band 1) | _Published 6 minutes ago · run `4821`_ — the CI run, which is this subject's version identifier                                                                                                           |
| **`port`** (band 2)    | the receipt, **unchanged**: the player, the scrubber with chapter ticks, the chapter list from `chapters[]`, the assertion summary, and the provenance chips (`commitSha` · `ciRunUrl` · `producedByKey`) |
| `verbs` (band 3)       | **Request changes** (secondary, no confirm) · **Approve** (primary, confirms)                                                                                                                             |
| `consequence`          | _"Approving finishes `MOTIR-4949`. Nothing else does."_                                                                                                                                                   |
| `confirmConsequences`  | records the decision with the time and this run · keeps this run's video so the decision stays watchable · moves the story to Done, starting the items waiting on it                                      |
| `filesKept`            | the receipt's video — drawn as **"run 4821 kept"** in state `E`                                                                                                                                           |
| `routedToLabel`        | the story's assignee, for state `B`                                                                                                                                                                       |

### What actually changes on screen, and what does not

- **The verbs were ALREADY below the subject** in the shipped panel. That
  ordering is right and survives; the frame does not move it.
- **Approve moves to the RIGHT** of the pair. The frame's primary verb is its
  rightmost; the shipped panel puts Approve first.
- **Band 1 is new** — which version is being decided, and its state.
- **The consequence sentence is new**, and it is the one the acceptance idiom
  never said: _Approve is what finishes the story._ A reviewer pressing it should
  be told so before they press, not after.
- **The confirm band is new** (G2), inline **over the verbs**, never a modal — a
  modal would take the receipt off screen at the moment the reader wants one last
  look. Approve confirms because it is terminal for this kind; Request changes
  does not, because a reversible act asked twice is friction rather than care.
- **The decided RECORD is new** (G3). The panel has `approvedById` and
  `approvedAt` today and renders neither. The frame draws ADR
  `approval-gates.md` §6a's audit set: who, when, under which authority, through
  which surface, and whether the bytes were kept.
  **`filesKept` is nullable and null renders NOTHING** — _not asked_ and _not
  kept_ must not collapse onto the one surface built to be checkable.

### The PORT's mechanics — and why the acceptance receipt is the case that proves them

`design-notes.md` § _THE UNIVERSAL APPROVAL FRAME_ insists the port's mechanics
are the design and not a detail. **An acceptance receipt is the subject that
demonstrates all three at once**, because a 16:9 player plus its chapter list is
taller than any ceiling that still leaves the verbs on screen:

- a **FLOOR** (196px), so a subject is never a sliver;
- a **CEILING** (420px) with its own scroll, so a tall subject never pushes the
  verbs off screen — **G1–G4 draw the receipt genuinely CLIPPED at it**, which is
  the truth;
- **Expand** (G5), for a subject that deserves the whole viewport.

> **⚠️ The ceiling SCROLLS; it must never SQUASH, and this is an implementation
> note because the mock hit it first.** The port is a flex column, so its
> children shrink to fit by default: without `flex: none` on them the receipt is
> silently compressed to 420px and the verbs sit under a squashed sliver — which
> is the button-first cut the frame was built to reject, arrived at by accident
> rather than by decision. `.port > * { flex: none }` in the mock; the component
> owes the same.

### State OFF — the absence that is not the same absence

Panel **G4** draws two absences side by side, because they are different:

- **`B` · awaiting, not yours to decide** — the gate is up, someone else owes the
  decision. **The port stays live**; only the verbs go. A reader who may not
  decide can still watch what is being decided.
- **OFF · this project raises no acceptance gate** — no decision, no receipt, no
  panel. What remains is the way BACK to the switch, and **it points at the
  project room**: `/settings/project/approvals`, drawn as the turn-on row with
  its switch and its link.

> **⚠️ The turn-on action and its link follow the switch** (MOTIR-4949 criterion
> 5). Today `settingsHref` plus the `#acceptance-video` anchor point at
> `/settings/organization`, which after MOTIR-4925 no longer holds the control. A
> link to a page the setting has left is worse than no link, because it looks
> like it worked.

### Primitives and token roles

The frame's own vocabulary, copied **by name** from `approval-control.mock.html`
so the two assets cannot drift — `.frame` / `.frameHead` / `.port` / `.frameFoot`
/ `.confirm` / `.record`, with `.pill-await` on `--el-tint-yellow` and `.pill-ok`
on `--el-tint-mint`, both inked `--el-text-strong`. The receipt inside the port
is the shipped panel's own markup, unchanged. Ink throughout is `--el-text` /
`--el-text-strong` / `--el-text-secondary`; `--el-text-identifier` for the
monospace run and item keys. Radius `--radius-card` / `--radius-input` /
`--radius-control` / `--radius-badge`; elevation `--shadow-card`.

### Out of scope here

The gate MECHANISM, the routing model, the authority model and the state set are
MOTIR-4778's and are not reopened. The Approvals tab (MOTIR-4879), the `approved`
status (MOTIR-4905), the manual-flip refusal (MOTIR-4887) and the waiting
indicator (MOTIR-4908) are each their own story — this gate inherits them as they
land, which is the whole point of joining the contract.

---

## Folders — rows in the tree, the folder menu, Move to…, delete, and the quick-view Folder field (Story MOTIR-5308 · MOTIR-5311 — `folders.mock.html`)

A project's tree can be tidied into nestable folders that hold any work item and carry no workflow
of their own. This asset draws the two places a person does that: **the `/items` tree** (folder rows
and every folder action) and **the quick view's rail** (filing a work item). It COMPOSES both
shipped surfaces and redraws neither: the tree is `IssueTreeTable.tsx` over the `TreeTable`
primitive, and the rail is `QuickViewRailEdit.tsx` as drawn in `quick-view.mock.html` panels 7–10.

**The behaviour is not this asset's.** Every rule below comes from a workflow-spec card, cited per
element:

| card                                | what it settles for the design                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5313** — the folder service | the name rule (trimmed, 1–120 chars, unique among siblings ignoring case), the cycle rule, delete moves child folders + filed work items to the deleted folder's parent in one transaction, filing clears the work-item parent, a new folder is appended after the last sibling |
| **MOTIR-5314** — the tree read      | a level is its folders THEN its work items; folders keep their own order under any column sort; a folder's level pages with the tree's existing `take` / `offset`; the List view never shows folders                                                                            |
| **MOTIR-5315** — folder rows        | a folder row expands (never a quick view), its menu, the refusals render inline, the picker is built once for two modes, read-only members see no actions                                                                                                                       |
| **MOTIR-5316** — the Folder field   | the rail row, the path value, No folder, the "removes it from" note before the save, same-folder is a no-op, the refusal reverts                                                                                                                                                |

### ⚠️ The column set is the SHIPPED one, not `tree-scale.mock.html`'s

`tree-scale.mock.html` still draws Title · Priority · Assignee · Reporter · **Due** · Est. · Status.
`issueColumns.tsx` on `origin/main` ships **Title · Type · Priority · Assignee · Reporter · Est. ·
Points · Status** (widths 116 · 120 · 150 · 150 · 72 · 80 · 108 beside a flexible Title). A folder row
joins the grid that actually renders, so this asset follows the code.

### Panels

| #   | panel                              | what it settles                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The access path**                | `New folder` is a secondary toolbar button between the view switcher and the primary `New work item`, Tree view only, `work_item:edit` only. It creates at the ROOT; a nested folder is created from its parent's menu.                                                                           |
| 2   | **Folder rows at rest + the menu** | The same 40px treegrid row, 22px indent and chevron. A folder glyph and a semibold name; the seven work-item cells EMPTY (no dashes). A trailing actions button, always rendered. The menu: New folder inside · Rename · Move to… · separator · Move up · Move down · separator · Delete….        |
| 3   | **Create and rename**              | Inline on the row, not a dialog. The new-folder input row sits after the level's LAST folder and before its work items. A collision keeps the input open, `aria-invalid`, with the reason under it.                                                                                               |
| 4   | **Move to…**                       | A popover picker: search + listbox, Project root, the current parent tagged "Current location", the folder and every folder under it DISABLED with the reason in words. Picking commits. A race refusal renders at the top of the open picker.                                                    |
| 5   | **Delete confirmation**            | The shipped `alertdialog` chrome. A mint safe-outcome line naming DIRECT counts and the destination; "No work items are deleted." The empty folder gets the lighter copy and no line.                                                                                                             |
| 6   | **Filing from the quick view**     | A Folder rail row below Parent: at rest (No folder) · open (the same picker in flow, the parent note) · set (path, confirmed check, Parent reads None) · pending · refused (value reverted, reason on the row). Beside it, the tree with the epic landed under its folder, stories still beneath. |
| 7   | **States**                         | Empty folder expanded (one quiet row) · paging (the shipped Load more children row) · a member without `work_item:edit` (affordances absent, folders still shown) · dark parity.                                                                                                                  |

### Elements — primitive and tokens

| element              | composes                                                                                    | colour                                                                                                                                                                                    | shape                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| folder row           | `TreeTable` row (`role="row"`, `aria-level` / `aria-expanded`), stretched `<button>` target | hover / active `--el-surface`; border `--el-border`                                                                                                                                       | row height 40px as shipped                                                                                  |
| folder glyph         | lucide `folder`, `aria-hidden`                                                              | `--el-text-secondary` (a folder is not a work-item kind, so it takes no `--el-type-*` hue)                                                                                                | 16px                                                                                                        |
| folder name          | —                                                                                           | `--el-text`, weight 600                                                                                                                                                                   | truncates                                                                                                   |
| chevron              | the shipped chevron button                                                                  | `--el-text-secondary`                                                                                                                                                                     | `--radius-control`                                                                                          |
| actions button       | icon button, lucide `ellipsis`                                                              | `--el-text-secondary`; open `--el-border-soft` fill + `--el-text`                                                                                                                         | `--radius-control`, `--spacing-icon-btn`                                                                    |
| toolbar `New folder` | `Button` variant secondary, lucide `folder-plus`                                            | `--el-page-bg` / `--el-border` / `--el-text`                                                                                                                                              | `--radius-btn`, `--height-control`, `--spacing-btn-x-sm`                                                    |
| folder menu          | `Popover` menu, `role="menu"`                                                               | `--el-page-bg`, `--el-border`; item `--el-text`, active `--el-surface`; disabled `--el-text-faint` (disabled text only); Delete… `--el-danger-on-surface` with an `--el-danger` glyph     | `--radius-card`, `--shadow-elevated`, items `--height-control` / `--spacing-control-x` / `--radius-control` |
| name input           | `Input`                                                                                     | border `--el-accent`, focus ring `--focus-ring-color`; invalid border + ring `--el-danger`                                                                                                | `--radius-input`                                                                                            |
| inline refusal       | the rail's refusal grammar                                                                  | words `--el-text`, glyph `--el-danger` (never `--el-danger-text`)                                                                                                                         | —                                                                                                           |
| folder picker        | `Combobox` listbox + search `Input`                                                         | options as the menu; reason `--el-text-secondary`; current tag `--el-text-secondary`; check `--el-accent`; race refusal `--el-tint-rose` + `--el-danger` border, words `--el-text-strong` | `--radius-card`, `--shadow-elevated`, `--radius-input`, `--radius-control`                                  |
| delete dialog        | `Modal` (`role="alertdialog"`), `Button` secondary + danger                                 | move line `--el-tint-mint` + `--el-success` glyph, words `--el-text-strong`; danger button `--el-danger` fill + `--el-danger-text` ink (its one legal pairing)                            | `--radius-modal`, `--shadow-modal`, `--spacing-card-padding`, `--height-btn-sm`                             |
| Folder rail row      | `EditableRailField`                                                                         | caption `--el-text-secondary`, chevron `--el-text-faint` (glyph), value `--el-text-secondary`, confirmed `--el-success`, pending bar `--el-accent` on `--el-border-soft`                  | as `quick-view.mock.html`                                                                                   |
| empty-folder row     | —                                                                                           | `--el-text-secondary`                                                                                                                                                                     | row height 40px                                                                                             |

### Decisions this asset makes

- **A folder row's click expands; it never opens anything.** The stretched target is a `<button>`
  labelled "Expand folder {name}" / "Collapse folder {name}". Nothing is nested inside it; the
  chevron and the actions button raise themselves above it, as the shipped row link does.
- **The actions button is always visible**, not revealed on hover — the same touch and keyboard
  reason the rail's chevron gives. It is the one deliberate difference from a work-item row
  (MOTIR-4258 removed theirs because the quick view carries every door; a folder has none).
- **Reorder is Move up / Move down in the menu.** There is no drag affordance in the tree today and
  this adds none. Move up is disabled on the level's first folder, Move down on its last.
- **The picker commits on pick.** No confirm button, as on every rail picker; choosing the current
  location writes nothing.
- **Disabled options say why in words** ("Can't move a folder into itself.", "It's inside
  "{name}"."), so the disabled ink is never the only signal.
- **The delete line counts DIRECT contents.** A filed epic counts once; its stories travel with it
  because only the top item's placement changes.
- **The Folder field sits directly below Parent** in the rail, because the two are one fact about
  placement and the note between them is about both.

### Copy — English and Chinese

Every string the panels render. Keys are suggestions for MOTIR-5315 / MOTIR-5316; each owes its
`messages/zh.json` twin in the same pull request.

| key (suggested)               | en                                                                                                                                                                     | zh                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `folders.newFolder`           | New folder                                                                                                                                                             | 新建文件夹                                                                       |
| `folders.newFolderInside`     | New folder inside                                                                                                                                                      | 在其中新建文件夹                                                                 |
| `folders.rename`              | Rename                                                                                                                                                                 | 重命名                                                                           |
| `folders.moveTo`              | Move to…                                                                                                                                                               | 移动到…                                                                          |
| `folders.moveUp`              | Move up                                                                                                                                                                | 上移                                                                             |
| `folders.moveDown`            | Move down                                                                                                                                                              | 下移                                                                             |
| `folders.delete`              | Delete…                                                                                                                                                                | 删除…                                                                            |
| `folders.actionsAria`         | Folder actions for {name}                                                                                                                                              | “{name}”的文件夹操作                                                             |
| `folders.expandAria`          | Expand folder {name}                                                                                                                                                   | 展开文件夹“{name}”                                                               |
| `folders.collapseAria`        | Collapse folder {name}                                                                                                                                                 | 收起文件夹“{name}”                                                               |
| `folders.nameLabel`           | Folder name                                                                                                                                                            | 文件夹名称                                                                       |
| `folders.nameHint`            | Press Enter to save, Esc to cancel.                                                                                                                                    | 按 Enter 保存，按 Esc 取消。                                                     |
| `folders.nameRequired`        | Enter a name.                                                                                                                                                          | 请输入名称。                                                                     |
| `folders.nameTaken`           | A folder named “{name}” is already here.                                                                                                                               | 此处已有名为“{name}”的文件夹。                                                   |
| `folders.pickerTitle`         | Move “{name}” to…                                                                                                                                                      | 将“{name}”移动到…                                                                |
| `folders.pickerSearch`        | Find a folder                                                                                                                                                          | 查找文件夹                                                                       |
| `folders.projectRoot`         | Project root                                                                                                                                                           | 项目根目录                                                                       |
| `folders.currentLocation`     | Current location                                                                                                                                                       | 当前位置                                                                         |
| `folders.cannotMoveIntoSelf`  | Can’t move a folder into itself.                                                                                                                                       | 文件夹不能移动到其自身中。                                                       |
| `folders.insideFolder`        | It’s inside “{name}”.                                                                                                                                                  | 它位于“{name}”之内。                                                             |
| `folders.cycleRefused`        | A folder can’t move into one of its own folders.                                                                                                                       | 文件夹不能移动到其自身的子文件夹中。                                             |
| `folders.crossProjectRefused` | That folder belongs to another project.                                                                                                                                | 该文件夹属于另一个项目。                                                         |
| `folders.deleteTitle`         | Delete folder “{name}”?                                                                                                                                                | 删除文件夹“{name}”？                                                             |
| `folders.deleteLead`          | Only the folder is removed. Everything filed in it stays in the project.                                                                                               | 只会移除文件夹。其中归档的所有内容仍保留在项目中。                               |
| `folders.deleteMoves`         | {folders, plural, one {# folder} other {# folders}} and {items, plural, one {# work item} other {# work items}} will move to {destination}. No work items are deleted. | {folders} 个文件夹和 {items} 个工作项将移动到{destination}。不会删除任何工作项。 |
| `folders.deleteEmpty`         | “{name}” is empty. Deleting it removes only the folder.                                                                                                                | “{name}”是空的。删除它只会移除该文件夹。                                         |
| `folders.deleteConfirm`       | Delete folder                                                                                                                                                          | 删除文件夹                                                                       |
| `common.cancel` (shipped)     | Cancel                                                                                                                                                                 | 取消                                                                             |
| `folders.emptyFolder`         | Nothing is filed here yet.                                                                                                                                             | 这里还没有归档任何内容。                                                         |
| `folders.fieldLabel`          | Folder                                                                                                                                                                 | 文件夹                                                                           |
| `folders.noFolder`            | No folder                                                                                                                                                              | 无文件夹                                                                         |
| `folders.removesFromParent`   | Filing it removes it from {key} {title}.                                                                                                                               | 归档后，它将不再属于 {key} {title}。                                             |
| `folders.fileRefused`         | That folder belongs to another project, so this work item stayed where it was.                                                                                         | 该文件夹属于另一个项目，因此此工作项保持原位。                                   |

When a moved-contents count has only one kind (`0 folders`), the sentence names only the kind that is
present — the ICU message carries a `select` on each count being zero; the drawn case has both.

The paging row reuses the shipped strings in `IssueTreeTable.tsx` ("Load more children" · "Showing
{loaded} of {total}"), and the rail's pending / confirmed / refused chrome reuses
`issueViews.quickViewFieldSaved` / `quickViewFieldSaving` / `quickViewEditField`.

### Out of scope here

The work item's FULL page parent field, its breadcrumb, the roadmap, the public project and the
Folder filter are the other-surfaces story's (MOTIR-5309), which reuses this picker. `/api/v1`, the
MCP tools and plan proposals are MOTIR-5310's. Drag-and-drop is planned nowhere.

### GIVES / TAKES

| work item                         | GIVES / TAKES     | what                                                                                                                                                                                                          |
| --------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5315** — folder rows      | **GIVES**         | the row, the actions button, the menu and its order, the inline name row and its refusal, the picker in move mode, the delete dialog and its counts, the empty and paging rows, the read-only state, the copy |
| **MOTIR-5316** — the Folder field | **GIVES**         | the rail row and its place below Parent, the path value, the picker in file mode, the parent note, the pending / confirmed / refused states, the tree's landed row                                            |
| **MOTIR-5313** / **MOTIR-5314**   | **TAKES nothing** | the asset is drawn to their rules and adds none                                                                                                                                                               |
| **MOTIR-5309** — other surfaces   | **GIVES**         | the picker component to reuse on the full page                                                                                                                                                                |

## ⭐ AMENDED 2026-09-13 — the pull-request frame's PORT is the Development block (MOTIR-5327)

Card [MOTIR-5327](motir:cmtzoqqmt00bzhvtxgxduxev2) · Story [MOTIR-4906](motir:cmtt4ogi0000dhutx1ekfm43s).
The full spec is `design/github/design-notes.md` **§20**; the board is `design/github/github.mock.html`
Panels 12a–12o. This section records what changes in **this** area.

### What this supersedes

The per-run draft of this card (motir-core #2847, evidence `cmtzuqv0j00pzhvtxvj1axmwf`) drew How to
test as a **separate `How to test` section card after Development**, with its own mock in this area,
mounted a second time as the port of **each** pull request's frame. That is **superseded** (Yue,
2026-09-13: _"in the work item page the PRs and how to test should be one block … like the design
result"_, and _"'approve to merge the PRs' is the gate … they are the same gate, not 2 separated
things"_):

- How to test joins the pull-request rows **in the Development card**; there is no section of its own.
- There is **one** gate, _approve to merge the pull requests_, over **all** the run target's pull
  requests — never a frame per pull request.
- The block becomes the frame exactly as Design result does.

**The separate `how-to-test` mock is NOT added to this area.** Against the spec it no longer serves as
a surface: the spec draws no How to test section, and the combined block is owned by the Development
section's asset in `design/github/` (the spec's _"amends … the Development section's asset in
`design/github/`"_). A second mock of the same block here would be a copy to keep in step with no
surface of its own, which is the drift §19 exists to stop. Because this card's branch was rebuilt on
`origin/main`, the draft's files never landed, so nothing is deleted from `main`.

### The placement table gains a row

The frame's homes (§ _The UNIVERSAL APPROVAL FRAME_ → _Placement_) now include a second item-page
home. Recorded here rather than edited into that table, so the table stays as MOTIR-4789 drew it:

| route              | where the frame sits                                                                                                                                                                           | door                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **`/items/[key]`** | for an awaiting `pull_request_approval`, inside the **Development** `ContentSectionCard`: band 2 is the rows plus the run's How to test, unchanged from the no-gate card (`design/github` 12c) | you are already on the card |

**No gate ⇒ no frame**, as for Design result: until [MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2)
registers the kind, the card renders the same block without bands 1 and 3.

### `approval-control.mock.html` — Panel `U`, port band only

Panel `U`'s _Pull request · code_ frame no longer carries the placeholder
(a hatched box reading _WHAT CHANGED, and HOW TO TEST IT_ and citing MOTIR-4906 as the owner). **Its port now holds the
Development block**, composed from `design/github/github.mock.html` Panel 12b: the two derived
pull-request rows, the caption, and the run's How to test (the rich-text body with a copyable command,
and a sub-block per repository). The block's CSS is scoped to the port (`.dvb-scope`), its pills are
`.dvb-pill*` so they cannot collide with this board's gate `.pill`, and its nine sprites are extracted
from `lucide-react@1.16.0` (`node scripts/audit-mock-sprites.mjs design/work-items/approval-control.mock.html --strict`: 0 drifted).

**The edit stops at the port band.** Band 1 (_Pull request · code_ with one pull request's branch) and
band 3 (_Approve_) are unchanged here. Their words for the one approve-and-merge gate — a kind label
over all the run's pull requests, and _Approve and merge_ — are MOTIR-4909's, drawn in
`design/github` 12c; re-wording them in this board is left to that story so this asset is not edited
in two places at once.

### No overlay

No overlay and no full-screen view is drawn in either asset. The port's _Expand_ control is the frame's
own and is drawn at rest; what it opens is [MOTIR-5214](motir:cmtxm4v3600edhztx2s78ff0u) /
[MOTIR-5215](motir:cmtxm4v6g00efhztx79g9zyar)'s, for every gate.

### GIVES / TAKES

| key                                                                                           | GIVES / TAKES                                                                                      |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2)                                                 | **GIVES** the port (this block) for the ONE gate. **TAKES** band 1's words and _Approve and merge_ |
| [MOTIR-5214](motir:cmtxm4v3600edhztx2s78ff0u) / [MOTIR-5215](motir:cmtxm4v6g00efhztx79g9zyar) | **nothing either way**                                                                             |
| [MOTIR-4881](motir:cmtrwx33s0054hxphinsoyt0f)                                                 | **nothing either way** — the port draws no review link                                             |
| [MOTIR-5351](motir:cmtzsio9b01cjhvoirkfuxmxl)                                                 | **GIVES** the narrow row (`design/github` 12n); nothing in this area                               |
| [MOTIR-5336](motir:cmtzoqrc900cmhvtxgr8ueqjw)                                                 | **GIVES** the block in both homes; the spec is `design/github` §20                                 |

> **Amended 2026-09-14 (review of MOTIR-5540):** at the **project root**, folders show **after all the
> epics** — epics, then folders, then the root's other work items. Inside a folder the order above
> is unchanged. See § `/items` first run › _Root order_.

## `/items` first run — a root that holds only folders (Story MOTIR-4927 · MOTIR-5540 — `items-first-run.mock.html`)

Every project is now born with a root folder named **Bugs**, where Motir files the bugs it creates on
its own (MOTIR-4935). The tree counts a level as its folders **and** its work items
(`workItemsService.readFolderLevel`: `total = folderTotal + itemTotal`), and `IssueTreeTable` shows
its `emptyState` only when `rows.length === 0`. Left alone, a brand-new project would open `/items`
on a lone folder row instead of the drawn _No work items yet_ state. The Folders section above drew
folder rows, an empty FOLDER and a read-only member, and never a project whose root holds only
folders. This section decides it. Layout source of truth for **MOTIR-5541**.

### The rule

**The unfiltered Tree shows its empty state when its root holds ZERO WORK ITEMS.** Folder rows do not
count toward emptiness, and they are still drawn, pinned above the empty state in their own order,
exactly as a folder row is drawn today.

- It is keyed on **work items**, never on a folder name, so a team that made folders before planning
  meets the same message, and renaming the Bugs folder changes nothing.
- The count comes from the server (the level read's work-item total, or a sibling field), not from
  inspecting rows in the browser.
- **Unchanged:** the List view (it never shows folders, MOTIR-5314); a FILTERED view that matches
  nothing keeps its own _no matching_ state; a root with at least one work item renders the tree as
  today, with no empty state.

### Root order — epics first, then folders (review of MOTIR-5540, 2026-09-14)

**At the PROJECT ROOT, folders show after all the epics.** A root level reads in three bands, in this
order:

1. **every epic** at the root, in the tree's active sort;
2. **the folders** at the root, in their own order (their position), under any column sort;
3. **the root's other work items** (stories, tasks, bugs, subtasks), in the active sort.

- **This amends the Folders read at the root only** (MOTIR-5314's _a level is its folders THEN its
  work items_). Inside a FOLDER the level is unchanged: its child folders first, then its work items.
- **The epics stay the project's first-order structure**: a person opening `/items` still meets the
  plan's epics at the top, and the folders — places work is tidied away into — follow them.
- **One `take` / `offset` still runs across the whole level**, now across three bands: offset `o` is
  epic `o` while `o < E`, folder `o − E` while `o < E + F`, and work item `o − E − F` after; `total` is
  `E + F + I`, so walking the level page by page still visits every row exactly once.
- **A column sort reorders inside the epic band and inside the work-item band**, never across them,
  and never reorders the folders.
- **Nothing drawn in this asset changes**: its panels show projects with no work items, so no epics.
  The List view (no folders) and a filtered view are unchanged.
- **Not built by MOTIR-5541**, which owns the empty-state rule only; the root order has its own code
  card under MOTIR-4927.

### The panels

| Panel | State                                | What it draws                                                                                                             |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **1** | a brand-new project                  | The shipped toolbar; the **Bugs** folder row (collapsed, actions button); the EmptyState below it with **New work item**. |
| **2** | several folders, still no work items | Bugs, Later, Research as rows; the same EmptyState.                                                                       |
| **3** | a member without `work_item:edit`    | No New folder, no New work item, no folder actions; the EmptyState without its action; folders still shown.               |
| **4** | the List view                        | Unchanged: the switcher reads List, no New folder, the same EmptyState, no folder rows.                                   |

### What it composes

| Composed                                                         | Owned there, not here                                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folders.mock.html` — the tree, its toolbar, its folder rows     | Row anatomy, the actions button, the 22px indent, the empty-folder row; its token, tree and toolbar CSS and its icon sheet are spliced in verbatim. |
| `packages/design-system` `EmptyState` (`list.mock.html` panel 3) | Card + the default lucide `Inbox` + title + description + action.                                                                                   |

### Copy

**No new strings.** The empty state is `issueViews.noIssuesTitle` / `issueViews.noIssuesDescription`
and the shipped **New work item** action; the folder rows use the shipped `folders.*` strings.

### Tokens & a11y

Colour is `--el-*` only and shape is the element-semantic tokens. The empty state's icon and
description use `--el-text-secondary`, which clears AA on every surface. The folder rows keep their
shipped roles (`row`, `aria-level`, `aria-expanded`), and the empty state follows them in reading
order, so a screen reader hears the folders and then that there are no work items yet.

## Placement — a filed work item's Folder field on its page, its breadcrumb, and the Folder filter row (Story MOTIR-5309 · MOTIR-5374 — `placement.mock.html`)

Once work can be filed (§ Folders), every other place that shows where a work item sits has to say
so. This asset draws the three surfaces the folders story left to MOTIR-5309 — **the work item
page's rail**, **its breadcrumb**, and **the advanced filter builder** — and COMPOSES each as it
ships: the rail is `CoreFieldsPanel.tsx`'s `FieldCard` (as `provenance.mock.html` mirrors it), the
eyebrow is `app/(authed)/items/[key]/page.tsx` + `ParentBreadcrumb.tsx`, and the builder is
`FilterConditionBuilder.tsx` (as `filter-builder.mock.html` draws it). The Folder control and its
picker are the quick view's, reused unforked: `QuickViewFolderControl` over `FolderPickerPanel` in
`file` mode (`folders.mock.html` panel 6).

**The behaviour is not this asset's.** Every rule below comes from a workflow-spec card:

| card                                   | what it settles for the design                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5313** — the folder service    | an item sits under a work item OR in a folder, never both; filing clears the parent; setting a parent clears the folder                                                 |
| **MOTIR-5375** — the placement read    | the EFFECTIVE folder is the item's own, else its root ancestor's (only a root can be filed); `placementFolder.path` root first, and `via` the ancestor it comes through |
| **MOTIR-5381** — the breadcrumb        | the page's placement channel; the breadcrumb repaints after a move on the page, without a reload                                                                        |
| **MOTIR-5377** — the page Folder field | the card below Parent, the shipped control, the optimistic write, the refusal reverting both cards, read-only without `work_item:edit`                                  |
| **MOTIR-5376** — the Folder filter     | `folder` is `folder-select`, nullable; list operators match the effective folder and every folder inside the chosen ones; a deleted or foreign folder is a stale value  |
| **MOTIR-5378** — the builder row       | the row on both mounts (`/items`, automation rules), the value editor, the stale chip, the summary chip                                                                 |

### Panels

| #   | panel                                   | what it settles                                                                                                                                                                                                                              |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The access paths**                    | Nothing new to reach. The page opens from a `/items` row's quick view; the builder from the `/items` toolbar's [Advanced] and from Settings → Project → Automation → a rule → Conditions.                                                    |
| 2   | **The Folder field at rest**            | A `FieldCard` directly below Parent. Filed directly: the path, Parent _None_. Through its root: the path plus _Through {key} {title}_. Not filed: _No folder_.                                                                               |
| 3   | **Open · saving · refused · read-only** | Open: the note, then the picker in flow, the item's OWN folder checked. Saving: both values change at once, every rail control disabled. Refused: both cards revert, the reason in the page's error `Toast`. Read-only: values, no chevrons. |
| 4   | **The breadcrumb**                      | Filed directly (a filed root now has a breadcrumb) · through its root (the path, then the ancestor chain) · unfiled (unchanged) · a long path wrapping and truncating inside the shipped bounded cell.                                       |
| 5   | **The builder's Folder row**            | Folder last in the menu's _Other_ group; values and chips by path; the included-folders hint; _is empty_; a deleted folder; no folders; a truncated list; the applied chip; the automation rule's copy of the row.                           |
| 6   | **Dark parity**                         | Panels 2–5 on `data-theme="dark"`.                                                                                                                                                                                                           |

### Elements — primitive and tokens

| element                      | composes                                                                               | colour                                                                                                                    | shape                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Folder card                  | `FieldCard` (label + corner chevron + value), below Parent                             | label `--el-text-secondary`; value `--el-text`; _No folder_ / _None_ `--el-text-secondary` italic (the shipped `muted()`) | `Card`: `--radius-card`, `--shadow-card`                                  |
| folder value                 | lucide `folder` glyph + the path joined with `▸`                                       | glyph `--el-text-secondary`; `▸` `--el-text-secondary`                                                                    | 16px glyph                                                                |
| _Through {key} {title}_      | a second value line                                                                    | `--el-text-secondary`; the key in the mono identifier grammar                                                             | 12px                                                                      |
| open control                 | `QuickViewFolderControl` → `FolderPickerPanel` (`file`), in flow                       | as `folders.mock.html` § Folders (note `--el-text-secondary`; check `--el-accent`)                                        | `--radius-card` well, `--radius-input` search, `--radius-control` options |
| saving                       | the rail's `disabled={isPending \|\| readOnly}`                                        | chevrons `--el-text-faint` (disabled glyph only)                                                                          | —                                                                         |
| refusal                      | `Toast` variant `error`, the rail's `toast({ variant: 'error' })`                      | glyph `--el-danger`; words `--el-text-strong` on `--el-page-bg`                                                           | `--radius-card`, `--shadow-elevated`                                      |
| breadcrumb folder segment    | a `<span>` in `ParentBreadcrumb`'s `<nav>`, lucide `folder`, visually-hidden _Folder:_ | words + glyph `--el-text-secondary`; no hover                                                                             | truncates inside the bounded `min-w-0 flex-1` cell                        |
| breadcrumb work-item segment | unchanged `next/link` + `IssueTypeIcon`                                                | unchanged (`--el-text-muted`, hover `--el-text`)                                                                          | unchanged                                                                 |
| Folder menu entry            | `Combobox` option, lucide `folder`                                                     | as every field option                                                                                                     | `--radius-control`, `--height-control`                                    |
| Folder value editor          | `MultiSelectPicker` over `FolderPickerNodeDto.path`                                    | chips neutral `--el-surface` / `--el-border`, words `--el-text-secondary`, glyph `--el-text-secondary`                    | `--radius-badge`, `--spacing-chip-x/y`                                    |
| included-folders hint        | a row line under a list-operator row                                                   | `--el-text-secondary`, lucide `info` glyph                                                                                | 12px                                                                      |
| truncated / empty lines      | lines in the listbox                                                                   | `--el-text-secondary`; the truncated line takes a `--el-border-soft` rule above it                                        | —                                                                         |
| stale value                  | the shipped _Unknown value_ chip + notice                                              | `--el-tint-peach`, `--el-warning` glyph, `--el-text-strong`                                                               | `--radius-badge`                                                          |
| applied chip                 | the shipped `sum-chip` readout                                                         | `--el-surface` / `--el-border`; field name `--el-text-strong`                                                             | `--radius-badge`                                                          |

No new primitive, no new token, no Tier-0 `--color-*`.

### Decisions this asset makes

- **An item placed through its root shows the path, marked as inherited.** A story under a filed
  epic IS in that folder — the tree draws it there and the Folder filter matches it there
  (MOTIR-5376) — so the card reads `Parked ▸ 2025` with a second line, _Through PROD-12 Old
  import_, from `placementFolder.via`. _No folder_ would contradict the tree. The card stays
  editable: filing the story is legal, and the open field says what it costs.
- **In the open picker, the checked option is the item's OWN folder.** For an item placed through
  its root that is _No folder_, so picking it writes nothing, and picking the inherited folder files
  the item directly (out of its parent, into the same folder) — the picker's shipped
  `currentFolderId` contract, unchanged.
- **A refusal on the PAGE is the page's error `Toast`, not a reason on the row.** Both cards revert.
  `CoreFieldsPanel.tsx` raises `toast({ variant: 'error', title })` for every failed rail save; the
  on-row reason in `folders.mock.html` panel 6 is the quick view dialog's grammar. MOTIR-5374's
  body asked for "reason on the row"; the shipped page grammar outranks it, and MOTIR-5377 already
  specifies the toast.
- **No confirmed check on the page.** The page rail draws none for any field; after a success the
  card closes on its new value.
- **A breadcrumb folder segment is text, not a link.** Nothing in the product takes a reader to a
  folder: `git grep -n -i "searchParams.*folder\|get('folder')" origin/main -- 'app/(authed)/items/'
'lib/issues/'` returns nothing (2026-09-13), so a link would need a destination this story does
  not build. No sibling is handed one.
- **The folder path is ONE segment, and it leads.** It follows the identifier with the shipped `·`,
  before the ancestor chain; inside it the folders join with `▸`, the separator the field and the
  picker already use.
- **A filed root renders a breadcrumb for the first time**, holding only its folder segment.
- **The breadcrumb landmark is named by its content.** _Folder and parent work items_ when a folder
  segment is present; the shipped _Parent work items_ otherwise.
- **Folder is the last entry of the field menu's _Other_ group**, after Component — its position in
  `FILTER_FIELDS`, where MOTIR-5376 registered it (registry order is menu order).
- **Options and chips are labelled by PATH**, because two teams can both keep a _2025_.
- **The included-folders hint shows under a list-operator row only**; the empty pair collapses the
  value slot as every nullable field's does.

### Copy — English and Chinese

| key                                                    | en                                                                             | zh                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `issueViews.parent` (shipped)                          | Parent                                                                         | 父级                                             |
| `issueViews.none` (shipped)                            | None                                                                           | 无                                               |
| `folders.fieldLabel` (shipped)                         | Folder                                                                         | 文件夹                                           |
| `folders.noFolder` (shipped)                           | No folder                                                                      | 无文件夹                                         |
| `folders.removesFromParent` (shipped)                  | Filing it removes it from {key} {title}.                                       | 归档后，它将不再属于 {key} {title}。             |
| `folders.fileRefused` (shipped)                        | That folder belongs to another project, so this work item stayed where it was. | 该文件夹属于另一个项目，因此此工作项保持原位。   |
| `folders.pickerSearch` (shipped)                       | Find a folder                                                                  | 查找文件夹                                       |
| `folders.pickerListLabel` (shipped)                    | Folders                                                                        | 文件夹                                           |
| `folders.pickerTruncated` (shipped)                    | Showing the first {count} folders.                                             | 仅显示前 {count} 个文件夹。                      |
| `folders.placedThrough` (new)                          | Through {key} {title}                                                          | 经由 {key} {title}                               |
| `folders.breadcrumbFolderLabel` (new, visually hidden) | Folder:                                                                        | 文件夹：                                         |
| `issueViews.placementBreadcrumbAria` (new)             | Folder and parent work items                                                   | 文件夹和父级工作项                               |
| `issueViews.parentIssuesAria` (shipped)                | Parent work items                                                              | 父级工作项                                       |
| `issueViews.advancedFieldFolder` (new)                 | Folder                                                                         | 文件夹                                           |
| `issueViews.advancedFolderIncludesInside` (new)        | Folders inside a chosen folder are included.                                   | 所选文件夹内的文件夹也包含在内。                 |
| `issueViews.advancedFolderNone` (new)                  | This project has no folders yet.                                               | 此项目还没有文件夹。                             |
| `issueViews.advancedStaleValue` (shipped)              | Unknown value                                                                  | 未知值                                           |
| `issueViews.advancedStaleNote` (shipped)               | This value no longer exists in the project — this condition matches nothing.   | 该值在此项目中已不存在——此条件不会匹配任何内容。 |

The operator labels, _Add…_, _Remove {value}_ and the count line reuse the shipped
`issueViews.advanced*` keys; the applied chip composes the field label, the operator and the paths.

### Out of scope here

The roadmap, the public project, boards, the backlog and reports gain no folder display (the story
decided those). `/api/v1`, the MCP tools and `skeleton` are MOTIR-5310's. A folder destination page
is planned nowhere.

### GIVES / TAKES

| work item                                | GIVES / TAKES       | what                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5381** — the breadcrumb          | **GIVES**           | the folder segment (text, glyph, visually-hidden _Folder:_), its place ahead of the chain, the `·` / `▸` separators, the content-named landmark, a filed root's breadcrumb, wrapping and truncation      |
| **MOTIR-5377** — the page Folder field   | **GIVES**           | the card below Parent, the three at-rest readings including _Through {key} {title}_, the open control with the item's own folder checked, saving, the refusal toast with both cards reverting, read-only |
| **MOTIR-5378** — the builder row         | **GIVES**           | the menu position, the row, values and chips by path, the included-folders hint, the empty pair, the stale chip, the truncated and empty listbox lines, the applied chip, the automation mount           |
| **MOTIR-5375** — the placement read      | **TAKES a premise** | the inherited line reads `placementFolder.via`                                                                                                                                                           |
| **MOTIR-5376** — the Folder filter field | **TAKES a premise** | the menu position IS the registry position it registered (last, after `cmp`)                                                                                                                             |
| **MOTIR-5316** / **MOTIR-5311**          | **lose nothing**    | the quick view's Folder field, its control and the picker are reused unchanged                                                                                                                           |

## ⭐ The status control says so — a move held by a pending approval or a merge (Story MOTIR-4887 · MOTIR-5523 — `status-held-by-decision.mock.html`)

**Yue's direction, 2026-09-14, which governs this asset:** _"the design should be like
near or on the status control/change, there should be access directly to open the
approval gate/port — the full screen overlay, give the user a message saying status
can't be changed directly and give the user the access to the approval gate."_

> **REVISED 2026-09-14, the same day, on Yue's direction — the first revision held only
> Done, and that was wrong.** _"when the design work item has a linked PR, approve the
> design should change the status to approved, and merge should be auto triggered or auto
> enqueued, webhook changes approved to done after PR merge. if no PR, the work item status
> will be changed to done after approving. so it's about if there's a PR. if there's a PR,
> the design gate is actually gone, approval gate is the trigger merge gate like any other
> regular PR"_ … _"not only done is blocked, approved manual set should be blocked too."_
> **What is held depends on whether the card has an open pull request.**

The behaviour drawn here is `docs/decisions/approval-gates.md` §6d AMENDMENT (MOTIR-5522),
rules 1–5 and **2b**: every door refuses a held move with `APPROVAL_GATE_PENDING` and the
payload `{ itemKey, kind, waitingOn: 'decision' | 'merge', canDecide, routedToLabel }`.
Every move that is not held stays offered. This asset decides no guard rule.

### Grounded in a render of the shipped control

Before drawing, the shipped `StatusPill` and `StatusPicker` were bundled and rendered
headlessly with the real design-system theme, in the default restricted workflow from
In Review. The option set (Blocked · In Progress · In Review · Approved · Done ·
Cancelled), the dot hues, the Pill's classes and the Combobox trigger / menu / option
classes in the mock are copied from that render's emitted markup. Two facts from it
shape the design: on the item page the CLOSED control is a `FieldCard` showing a
`StatusPill`, and the picker only mounts on toggle — so a message "visible without
opening" has to live in the card, not in the picker; and the shipped `ComboboxOption`
has no per-option `disabled`, so the held option is a primitive growth (below).

### The states — the pull request is the discriminator

| the card has…                                                         | gate                                            | held status  | `waitingOn` | door                                           |
| --------------------------------------------------------------------- | ----------------------------------------------- | ------------ | ----------- | ---------------------------------------------- |
| **no pull request**                                                   | `design_result` `awaiting`                      | **Done**     | `decision`  | Review & approve if `canDecide`; else the name |
| **an open pull request, checks green**                                | `pull_request_approval` `awaiting`              | **Approved** | `decision`  | Review & approve if `canDecide`; else the name |
|                                                                       |                                                 | **Done**     | `merge`     | **never a button** — merging moves it          |
| **an open pull request, not green**                                   | none raised yet                                 | **Approved** | `decision`  | no button (`canDecide` false)                  |
|                                                                       |                                                 | **Done**     | `merge`     | never a button                                 |
| **an open pull request, approved**                                    | `pull_request_approval` `approved`              | **Done**     | `merge`     | never a button — the card sits at Approved     |
| no pull request, gate decided / withdrawn; or the pull request merged | `approved` · `changes_requested` · `superseded` | nothing      | —           | the control exactly as today                   |

One held LINE per held status, stacked in ONE message box under the value. The item page,
quick view and edit page read the item's state and show every line that holds. **The list
reads no state per row**: it shows only the ONE refusal a commit returned.

### Panels

1. **No pull request** — closed control (may decide), dropdown with Done locked, look-only reader.
2. **Open pull request, gate awaiting** — two lines (Approved with the door; Done with the merge
   line), dropdown with BOTH locked, look-only reader.
3. **Open pull request, no gate yet** (Approved held with no door, Done held) · **after approving**
   (card at Approved, only Done held) and its dropdown.
4. **Quick view and edit page** — the same lines (also the REVISED dated panel 13 of
   `quick-view.mock.html`, re-exported).
5. **`/items` row after a refused commit** — `waitingOn: decision` with the door, and
   `waitingOn: merge` without.
6. **Nothing held** — decided or withdrawn with no pull request, and a merged pull request.
7. **`zh`**, every line and the dropdown tags.

Light and dark boards: `status-held-by-decision.png` and `status-held-by-decision.dark.png`
(this area still follows `CLAUDE.md`'s three-file set on `origin/main`, so the exports are kept).

### Elements — primitives and tokens

| element                        | composes                                                          | colour                                                                                                                                    | shape                                                         |
| ------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| the Status card                | `CoreFieldsPanel`'s `FieldCard` (unchanged)                       | `--el-page-bg` · `--el-border` · label `--el-text-secondary`                                                                              | `--radius-card` · `--shadow-card`                             |
| the value                      | `StatusPill` → `Pill` (unchanged)                                 | the status's tint background · `--el-text-strong`                                                                                         | `--radius-badge` · `--spacing-chip-x/y`                       |
| **the held message box** (NEW) | a status region under the value, one line per held status         | background `--el-tint-yellow` (the approval frame's _awaiting_ hue) · border `--el-border-soft` · a `--el-border-soft` rule between lines | `--radius-control` · `--spacing-control-x/y`                  |
| a `decision` line              | lucide `lock` 14px + text                                         | text + glyph `--el-text-strong`                                                                                                           | —                                                             |
| a `merge` line                 | lucide `git-merge` 14px + text, **no button ever**                | text + glyph `--el-text-strong`                                                                                                           | —                                                             |
| **Review & approve**           | `Button` `variant="primary"` `size="sm"`, rendered as a link      | `--el-accent` · `--el-accent-text`                                                                                                        | `--radius-btn` · `--height-btn-sm`                            |
| the picker                     | `StatusPicker` → `Combobox` (unchanged trigger + menu)            | trigger `--el-border` · active row `--el-option-active-bg` · check `--el-accent-on-surface`                                               | `--radius-input` · `--radius-card` menu · `--shadow-elevated` |
| **a held option** (NEW)        | `ComboboxOption` + `disabled` + its existing `trailing` slot      | label and tag `--el-text-secondary` — no opacity dim; tag glyph `lock` (decision) or `git-merge` (merge)                                  | `--radius-control` · `--spacing-control-x/y`                  |
| the list-row anchored message  | the held message box with the ONE refused line                    | as the box · `--shadow-elevated`                                                                                                          | `--radius-control`                                            |
| the overlay                    | `ApprovalOverlay` via `withApprovalOverlay` — composed, not drawn | —                                                                                                                                         | `design/workbench/design-notes.md` § 22                       |

**A held option is focusable and announced**, not skipped: `aria-disabled="true"`, read as
_"Done, moves on merge, unavailable"_ or _"Approved, needs approval, unavailable"_.
**`ComboboxOption` gains `disabled?: boolean`** in `@motir/design-system` for this — built by
MOTIR-5528.

**The button is a LINK to the current page with the overlay address added**
(`withApprovalOverlay(href, { itemKey, kind })`, `kind` = the refusal's kind —
`design_result` with no pull request, `pull_request_approval` with one), written with
`shallowPush`, so the overlay opens over whatever page holds the control and Close returns
there. **It renders only on a `decision` line with `canDecide: true`.**

**The label is `Review & approve`**, the same words as MOTIR-5215's item-page control.
MOTIR-5228 has not yet settled a different string in this file; if it does, this asset
follows it.

### Copy — English and Chinese

`{status}` is the held target's own label. `{decision}` is a per-kind NOUN PHRASE that
already says _approval_ — the catalog's kind LABELS (`workbench.approvals.kind.*`) cannot
be used, because _"a Pull-request approval approval"_ doubles the word.

| key (proposed)                                               | en                                                                                                          | zh                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `approvalGate.statusHeld.decision`                           | Status can't be moved to {status} directly — a {decision} is waiting.                                       | 无法直接将状态改为{status}——{decision}正在等待。                     |
| `approvalGate.statusHeld.decisionSeeOnly`                    | Status can't be moved to {status} directly — a {decision} is waiting on {name}.                             | 无法直接将状态改为{status}——{decision}正在等待 {name} 处理。         |
| `approvalGate.statusHeld.decisionNotRaised`                  | Status can't be moved to {status} directly — a {decision} is asked for once the pull request's checks pass. | 无法直接将状态改为{status}——合并请求的检查通过后才会发起{decision}。 |
| `approvalGate.statusHeld.merge`                              | Status can't be moved to {status} directly — merging the pull request moves it.                             | 无法直接将状态改为{status}——合并该合并请求后会自动变更。             |
| `approvalGate.statusHeld.decisionNoun.design_result`         | design approval                                                                                             | 设计审批                                                             |
| `approvalGate.statusHeld.decisionNoun.pull_request_approval` | pull-request approval                                                                                       | 合并请求审批                                                         |
| `approvalGate.statusHeld.decisionNoun.decision_approval`     | decision approval                                                                                           | 决策审批                                                             |
| `approvalGate.statusHeld.reviewAndApprove`                   | Review & approve                                                                                            | 审阅并批准                                                           |
| `approvalGate.statusHeld.needsApproval`                      | needs approval                                                                                              | 需要审批                                                             |
| `approvalGate.statusHeld.movesOnMerge`                       | moves on merge                                                                                              | 合并后变更                                                           |

### Allocation — read by the code cards as their SCOPE and their EDGES

| element                                                                                                             | built by                                                          |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| the held message box (both line kinds) + button; the held options; item page, quick view and edit page              | MOTIR-5528                                                        |
| the list row's ONE refused line after a commit — `waitingOn: decision` (door when `canDecide`) or `merge` (no door) | MOTIR-5529                                                        |
| the board card's refusal                                                                                            | the board design MOTIR-5525, composing THESE lines and the button |

### Out of scope here

The overlay itself (§ 22 of the workbench notes); the item page's gate section and its
_Review & approve_ band (MOTIR-5228); the waiting indicator (MOTIR-4908); the
approve-to-merge gate, the `approved` write and the merge or enqueue (MOTIR-4909 /
MOTIR-4882); every guard rule (the ADR amendment).

### GIVES / TAKES

- **GIVES** MOTIR-5528 the box, both line kinds, the button rule, the held options, the
  `disabled` growth on `ComboboxOption` and the strings; MOTIR-5529 the anchored single-line
  refusal; MOTIR-5525 the lines and button it composes on the board card.
- **TAKES** the refusal payload (`waitingOn` included) from MOTIR-5526, the overlay address
  from `lib/approvals/overlayAddress.ts`, and rule 2b's pull-request discriminator.

## ⭐ The item page HANDS THE DECISION OVER — the call-to-action band (Story MOTIR-5215 · MOTIR-5228 — `approval-cta.mock.html`)

**The asset:** `approval-cta.mock.html`, a two-file set (`docs/decisions/design-result.md` AMENDMENT 4,
no `.png` export). It gates **MOTIR-5229** (the band and its one door), which carries it in `blocked_by`;
**MOTIR-5230** and **MOTIR-5231** assert against it.

**What it draws:** the Design result section once deciding has moved off the item page. While the
section's gate is waiting on a reader who may decide it, the section becomes a **call-to-action band**:
which version, how long it has waited, the state, and ONE control, **Review & approve**. The control
opens the approval overlay ([MOTIR-5214](motir:cmtxm4v3600edhztx2s78ff0u),
`design/workbench/design-notes.md` § 22) over the page.

> **⚠️ REVISED 2026-09-15 ON REVIEW — ONE CONTAINER, ONE LABEL.** The first cut composed the approval
> frame whole, with its own bordered box and its own band-1 heading _Design result_, inside
> `ContentSectionCard`, which already carries the border and the title _Design result_. It was rejected:
> _"doubled 'design result', a container inside a container, that's not right."_ **The section card is
> the ONLY container on the item page, and its title is the ONLY label.** Nothing inside it has a border
> of its own or repeats the title. That rule covers the band, and it covers the states the page keeps
> (`B`, `E`, `F`, `G`), which today ship the same nesting: they now render the frame's bands flush in
> the section body. The frame keeps its chrome and its heading only where it IS the container, which
> is the overlay (§ 22) and the To-approve row. Panel 0 draws what was rejected.

**Panels:** 0 the revision · 1 the band in place on `/items/[key]` at 1280, after Development, measured ·
2 anatomy, for the reader the gate is routed to and for an admin it is not routed to · 3 the states the page
KEEPS, flush in the section — `B` see but not decide, `E` approved, `F` changes requested, `G` withdrawn ·
4 no gate at all, the shipped `DesignResultPanel`, unchanged · 5 narrow (`< md`), in `zh`.

### Rendered first

The shipped `DesignResultSection` inside the shipped `ContentSectionCard` was rendered on `origin/main`
after MOTIR-5488 merged (`3e1cf0e30`), which reshaped the port. The render used the repo's vitest + RTL
setup (`renderWithIntl`, the real `messages/en.json` and `messages/zh.json`) in every state: awaiting
with and without `canDecide`, awaiting with an unresolved routing, approved, changes requested,
superseded, no gate with a result, and no gate on an empty design card. The section card, band 1's meta
and pill, band 3's row, the port's frame strip and note row, the record strip, the dead port and the
empty state are all copied from that render's emitted markup. Three facts from it shape the design:

- **The render shows the nesting this revision removes.** Every gated state emits
  `ContentSectionCard` (a bordered card with the title _Design result_). Inside it sits
  `ApprovalGateControl`'s own `overflow-hidden rounded-(--radius-card) border` box, whose band 1 opens
  with the kind label _Design result_ again. § 22 recorded that double label as outside its surface and
  left it. This asset removes it.
- **Band 1 already carries what the band needs** — the subject version and the state pill. The band
  keeps both, drops the kind label (the section title says it), and adds one thing: how long ago the
  question was asked.
- **State `B` NAMES the approver on `origin/main`.** MOTIR-5191 (`9421599ae`, 2026-09-12) resolves
  `routedToLabel` in `approvalGatesService.getForWorkItem`, and both the item page and the overlay pass
  it, so the frame renders _Waiting on Ada Lovelace._ The generic _this work item's assignee_ fallback
  appears only when routing resolves to nobody. The card was written 12 minutes before that merge, and
  its premise that the line is generic is out of date. The finding is recorded on the card.

### ⚠️ The rule, in two sentences — the code card is closed against them

**The band replaces the frame's content ONLY when the gate is `awaiting` AND the reader `canDecide`;
every other state keeps its content, and a card with no gate renders exactly as it does today.** **On
the item page the frame is never its own container: no inner border, and no kind label under a section
title that already names it.**

### The state checklist — `ApprovalGateState`, total

`prisma/schema.prisma`'s enum is the checklist, so the band's handling is total rather than a
judgement. `canDecide` is the section's existing prop, unchanged. Every row renders inside the ONE
section card, whose title is the only _Design result_.

| gate on the card                            | `canDecide` | the section body renders                                                                        | panel |
| ------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------- | ----- |
| **`awaiting`**                              | **true**    | **the call-to-action band** — meta + pill, then the sentence and one control; no port, no verbs | 1 · 2 |
| `awaiting`                                  | false       | state `B` — meta + pill, the port, _Waiting on {name}._; no verbs                               | 3     |
| `approved`                                  | either      | state `E` — meta + pill, the pinned version's port, the record with _Files kept_ / _not kept_   | 3     |
| `changes_requested`                         | either      | state `F` — meta + pill, the port, the record with _the agent will publish…_                    | 3     |
| `superseded`                                | either      | state `G` — meta + pill, the dead port, colourless, no verb                                     | 3     |
| no gate (a result, or an empty design card) | —           | the shipped `DesignResultPanel`, unchanged                                                      | 4     |

**`C` confirming, `D` in flight and `H` refused no longer occur on the item page.** Each exists only
between a press and its answer, and the only press left is in the overlay, which renders them there.
**`X` (the port failed)** cannot occur in the band, because the band mounts no port.

**`F` is drawn as the TARGET, not as it renders today.** A version that was sent back is not pinned, so once
its bytes are reclaimed the port shows the panel's own empty state. On `origin/main` the shipped frame then
also draws state `X`'s alert, _You cannot approve what cannot be shown._, under the decided record:
`DesignResultPanel` reports `failed` whenever it has no mock, and `ApprovalGateControl` shows
`PortFailedAlert` on `portFailed && !withdrawn`, which does not exclude a decided gate. Filed as
**MOTIR-5551**. The asset draws `F` without the alert.

### Anatomy — the band, flush in the section

Nothing new is invented: the container is the section card, band 1's meta and pill are `FrameHeader`'s
spans without the kind label, and the row is band 3's recipe with a hairline instead of a box.

| #   | element                         | composes (as shipped)                                                                                  | colour                                                                               | shape                                                   |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 1   | **the container and its label** | `ContentSectionCard` — _Design result — what this work item produced_ (unchanged, the ONLY one)        | `--el-card` on `--el-border`, `--shadow-card`; title `--el-text`                     | `--radius-card`, `--spacing-card-padding`               |
| 2   | subject version                 | `FrameHeader`'s meta span — `approvalGate.designResult.meta.withVersion`, `subjectVersion` sliced to 8 | `--el-text-secondary`                                                                | —                                                       |
| 3   | waited for (**NEW**)            | the same span, `·` then `approvalGate.cta.asked` over `relativeTime(gate.createdAt)`                   | `--el-text-secondary`                                                                | —                                                       |
| 4   | state                           | `Pill tone="awaiting"` — _Awaiting you_ (unchanged), right-aligned on the meta line                    | `--el-tint-yellow` + `--el-text-strong`                                              | `--radius-badge`, `--spacing-chip-x` / `-y`             |
| 5   | the sentence (**NEW**)          | band 3's left-hand line — `text-[13px]` — under a hairline divider                                     | `--el-text-secondary`; a named person in `--el-text`; the divider `--el-border-soft` | —                                                       |
| 6   | **Review & approve** (**NEW**)  | `Button variant="primary" size="sm"` rendered as a `Link`, lucide `ScanEye` 14px leading               | `--el-accent` · `--el-accent-text`                                                   | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x-sm` |

**The layout:** first the meta line (`flex flex-wrap items-center gap-2`, version · asked, then the pill
`ml-auto`). Then the row (`mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t
border-(--el-border-soft) pt-3`), with the sentence left and the control `ml-auto`. **No element between
the section card and its contents has a border or a radius.** The hairline divides, and never encloses.

**The meta line reads three fields, all on `ApprovalGateDTO` (`lib/dto/approvalGate.ts`), and no
others:** `kind` (through the section's title, which already names it), `subjectVersion`, and
`createdAt` as _asked {when}_. It promises no dependent count, no file list and no author, because no read
on the page produces them. `createdAt` is when the gate was raised, which is when the question was first
asked. A republish supersedes the old gate and raises a new one, so the clock restarts with the version,
which is correct.

**The sentence has two forms, keyed on routing, never on authority.** `routedToId` is on the DTO and the
page knows the viewer:

- **routed to the viewer** — _Review the design full screen, then approve or request changes._
- **routed to someone else, and the viewer may still decide it** (the reporter when there is an assignee,
  or any admin: `docs/decisions/approval-gates.md` §2 as amended by MOTIR-4911) — _Waiting on **{name}** —
  you can decide it too. Review it full screen first._ `{name}` is `routedToLabel`. When it is null, the
  first form renders instead, because a sentence naming nobody says nothing.

**The pill stays _Awaiting you_ in both**, as the frame already renders for any reader who may decide.
The band and the door are the same either way, which is the story's criterion that the door serves
AUTHORITY and not routing.

### The kept states, flush in the section

**Content and order are unchanged: band 1 (without the kind), the port, band 3.** Only the chrome
changes:

- the frame's `overflow-hidden rounded-(--radius-card) border` box is **not drawn**;
- band 1's kind label _Design result_ is **not drawn** (the section title is);
- band 1's `border-b` and band 3's `border-t` become **hairline dividers in the section body** (the port
  sits between them with `mt-3`, the record strip with `mt-3 border-t pt-3`), and the horizontal padding
  the frame gave its bands (`px-4`) is dropped, because the card's `--spacing-card-padding` already
  supplies it.

### The control, and its string — SETTLED

**`Review & approve` · `审阅并批准`.** The register is recorded so it is not re-opened by accident. _To
approve_ is the To-approve tab's name, a noun phrase for a QUEUE, and that is right for a tab. A button is
a verb a person presses, and a label that reads like a category leaves the reader unsure whether pressing
it approves something straight away. _Review & approve_ says what happens next: you look first. That is
the ordering the frame's own design was corrected into (§ _The UNIVERSAL APPROVAL FRAME_, second cut).

**It is ONE string and ONE catalogue entry**, shared with the status control's door
(§ _The status control says so_, MOTIR-5523). That asset already draws these exact words and committed
to following this one. Its code card (MOTIR-5528, PR #2897) adds the entry as
`approvalGate.statusHeld.reviewAndApprove`, and the band reads that same key. If MOTIR-5229 lands first,
it adds the entry under that name with these two strings, and never a second key for the same words.

**What it does:** it is a `Link` to the current page with the overlay's address added —
`withApprovalOverlay(pathname + search, { itemKey, kind: 'design_result' })` from
`lib/approvals/overlayAddress.ts`, written with `shallowPush`. The overlay opens over the item page,
Close strips the two parameters, and the reader is back on the card at the same scroll. Nothing is
unmounted. **The glyph is `ScanEye`**, the status control's own, so the two doors into one decision look
like one door.

### The ACCESS PATH — where a reader meets it

On `/items/[key]`, in the late stack (`LateSections.tsx`), **the Design result section's own slot, after
Development**, where the frame sits today. Panel 1 draws it in place at 1280 with the page's real
`grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]`. **The band does not move and adds no navigation.** Two other
doors lead to the same overlay, and neither is drawn here: the To-approve row (§ 22 Panel 9) and the
status control's held line (§ _The status control says so_).

### Measured (Chromium, the mock, 1× scale)

The section is the page column's full width, and the band is its body, so no width is set here. Nothing
overflows: the document is exactly the board width.

| viewport            | main column | section (w × h) | meta line | the row                         | control (w × h)              |
| ------------------- | ----------- | --------------- | --------- | ------------------------------- | ---------------------------- |
| 1280 (panel 1)      | **918**     | **918 × 171**   | 868 × 24  | 868 × 45                        | 166 × 32 (`--height-btn-sm`) |
| 390 (panel 5, `zh`) | 358         | 356 × 183       | wraps     | stacked: sentence, then control | 117 × 32, left-aligned       |

### Narrow (`< md`)

Panel 5, in `zh`. The meta line wraps with its pill. **The row stacks:** the sentence takes the full width
and the control drops to its own line, left-aligned (`md:ml-auto` instead of `ml-auto`), at its intrinsic
width. It is not stretched, because a full-width primary button on a phone reads as the page's main
action, and this is one section of many.

### Copy — `en` and `zh`

| key                                        | en                                                                      | zh                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `approvalGate.cta.asked`                   | asked {when}                                                            | {when}发起                                         |
| `approvalGate.cta.body`                    | Review the design full screen, then approve or request changes.         | 全屏审阅设计后，再批准或要求修改。                 |
| `approvalGate.cta.bodyRoutedElsewhere`     | Waiting on {name} — you can decide it too. Review it full screen first. | 等待 {name} 处理——你也可以做出决定。请先全屏审阅。 |
| `approvalGate.statusHeld.reviewAndApprove` | Review & approve                                                        | 审阅并批准                                         |

`{when}` is `useFormatter().relativeTime(gate.createdAt)` — _2 days ago_ / _2天前_. Every other string in
the band is already in the catalogue: `approvalGate.designResult.meta.withVersion`,
`approvalGate.state.awaitingYou`, and `designResult.title` / `.gloss` for the section card.

### What the band is NOT

- **Not a second frame, and not a second container.** It mounts no port and no verbs, and it draws no
  border inside the section.
- **Not the pending indicator** ([MOTIR-4908](motir:cmtt4ogn7000fhutx7zrhizuo)) on the page header, the
  board card or the list row.
- **Not a redraw of the frame** (`approval-control.mock.html` still owns its nine states and its
  chrome where it is the container), of the port's contents (`design-result--what-to-review.mock.html`),
  or of the overlay (§ 22).

### ⚠️ AMENDMENT — 2026-09-15 (MOTIR-5228), to the frame's placement on the item page

**Superseded.** § _The UNIVERSAL APPROVAL FRAME_ → _Placement_ records, for `/items/[key]`: _"it **IS**
the `Design result` section — it REPLACES today's read-only `DesignResultPanel` in the late stack
(`LateSections.tsx`), same slot, same position after Development"_. `approval-control.mock.html` panel 0a
draws the same thing (_"the frame IS this section"_), and `DesignResultSection.tsx`'s header quotes it
back. What shipped is the frame's own card placed INSIDE the section's card.

**What replaces it, in two parts:**

1. **When the section's gate is `awaiting` and the reader `canDecide`**, the section holds the
   **call-to-action band** from this section, not the frame's port and verbs. The decision itself happens
   in the approval overlay (§ 22 of the workbench notes), which the band's one control opens.
2. **In every other gated state**, the frame's content still renders here (`B`, `E`, `F`, `G`), but
   **flush in the section**: no border of its own, no kind label.

**What it does NOT replace:** the slot, its position after Development, the section card, and the no-gate
`DesignResultPanel` are unchanged. **`approval-control.mock.html` still owns the frame**, all nine of its
states, and its chrome in the places where the frame IS the container (the overlay, the To-approve row).
Neither that asset nor its section is edited, and they remain the record of the frame as first placed.

**Why:** the item page is the only door to a decision for everyone the To-approve tab does not route it to:
a reporter with an assignee present, and every admin (routing vs authority,
`docs/decisions/approval-gates.md` §2 as amended by MOTIR-4911). A decision that has a full-screen surface
cannot offer those people the smaller one, and leaving the verbs beside a door would teach two ways to
approve. The flattening is the review's own rule: one container, one label.

### GIVES / TAKES

Swept over MOTIR-5215's whole subtree (MOTIR-5228 · 5229 · 5230 · 5231) and every key this section and
the mock name, on the ELEMENT, STRUCTURE and PREMISE axes. `git grep` over `design/` for the subtree's keys
finds two referrers besides this section: § _The status control says so_ (names MOTIR-5228 for the string,
settled above to the same words) and the workbench notes' § 22 (names MOTIR-5215 as the item page's door,
and records the item page's double label as outside its surface — resolved here).

| work item                                                        | GIVES                                                                                                                                                                                                                            | TAKES                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5215** (the story)                                       | The design half of its criteria: the band and its meta line, the one control and its string in both locales, the kept states, the no-gate case, the dated amendment.                                                             | **PREMISE:** _"routedToLabel={null} … waiting on the assignee"_ is out of date (MOTIR-5191). **PREMISE:** _"does not modify `ApprovalGateControl`"_ must read _no new state, verb, band or decide path_ — planning flag 4. |
| **MOTIR-5229** (the band and its one door)                       | **ELEMENT:** the band (panels 1–2, 5), the sentence's two forms, the control and its address, the copy table. **STRUCTURE:** the two-sentence rule, the state checklist, and the flush kept states.                              | **ELEMENT:** the verbs, the confirm band and the port on the awaiting-and-decidable path; the frame's inner border and kind label on every gated state. **PREMISE:** planning flags 1 and 4.                               |
| **MOTIR-5230** (the vitest gate)                                 | The seams to assert: band iff `awaiting ∧ canDecide`; no approve control in the section's tree while awaiting; each kept state still renders; ONE _Design result_ and no nested card in the section; the no-gate path untouched. | Nothing.                                                                                                                                                                                                                   |
| **MOTIR-5231** (the acceptance E2E)                              | The walk and its accessible names: the link _Review & approve_ / _审阅并批准_, the band's meta, and the decided record in place after close.                                                                                     | Nothing.                                                                                                                                                                                                                   |
| **MOTIR-4789** (the frame's design) · `done`                     | Nothing.                                                                                                                                                                                                                         | **PREMISE:** _"the frame IS this section"_ on `/items/[key]`, amended above: the band for `awaiting ∧ canDecide`, the frame's content flush in the section otherwise. Its asset and nine states are unchanged.             |
| **MOTIR-4792** (the frame, and the section becoming it) · `done` | Nothing.                                                                                                                                                                                                                         | **STRUCTURE:** the frame's own card inside the section card. Superseded going forward by the amendment above, not amended: a `done` card is history, and it shipped correct against the design current at the time.        |
| **MOTIR-5222 / MOTIR-5224** (the overlay's design, its host)     | Nothing — the frame keeps its chrome and band-1 label there, where it is the container.                                                                                                                                          | **ELEMENT:** the destination — the overlay, its address (`lib/approvals/overlayAddress.ts`) and its one close — composed, never drawn.                                                                                     |
| **MOTIR-5523 / MOTIR-5528** (the status control's door)          | The settled string, which that asset already follows, and the rule that it is one catalogue entry.                                                                                                                               | **ELEMENT:** the entry `approvalGate.statusHeld.reviewAndApprove` and the `ScanEye` glyph.                                                                                                                                 |
| **MOTIR-5191** · `done`                                          | Nothing.                                                                                                                                                                                                                         | **PREMISE:** state `B`'s named line, and `routedToLabel` for the sentence's second form.                                                                                                                                   |
| **MOTIR-5551** (bug)                                             | The drawn target for `F`.                                                                                                                                                                                                        | Nothing.                                                                                                                                                                                                                   |
| **MOTIR-5118 / 5160 / 5212**                                     | Nothing — cited for the page-state contract a decision made elsewhere must meet.                                                                                                                                                 | Nothing.                                                                                                                                                                                                                   |
| **MOTIR-4778 / 4786 / 4911**                                     | Nothing.                                                                                                                                                                                                                         | Nothing — the gate, the decide door, routing and authority are read, not touched.                                                                                                                                          |
| **MOTIR-4908 / 4949 / 4887**                                     | Nothing — boundaries this asset does not cross.                                                                                                                                                                                  | Nothing.                                                                                                                                                                                                                   |
| **MOTIR-5488** (merged, PR #2894 `3e1cf0e30`)                    | Nothing.                                                                                                                                                                                                                         | **PREMISE:** a `design_result` gate exists only on a design card with NO open linked pull request (AMENDMENT 4 Q8). **ELEMENT:** panel 4 and the kept ports draw its shipped panel.                                        |

### ⚠️ Planning flags — surfaced by this pass

1. **A decision made in the overlay has to reach two surfaces on the item page that `router.refresh()`
   alone does not reliably reach. MOTIR-5229's repaint criterion owns both, and neither mechanism exists
   yet.**
   - **The section.** `DesignResultSection` seeds `const [current, setCurrent] = useState(gate)`, so a
     server render carrying the decided gate does not reset it. The band must key on the SERVER `gate`
     prop, or watch `useDecidedGateState(gate.id)` (`lib/approvals/decidedGates.ts`, which the overlay
     already announces to). Otherwise it keeps offering _Review & approve_ over a decided question.
   - **The status rail.** Its in-browser path (MOTIR-5212) is `useOptimisticStatusWriter`, applied from
     the decide response's `outcomeRef`. The overlay is mounted in the authed shell, outside
     `OptimisticStatusProvider`, and `announceGateDecided` carries the state and not the `outcomeRef`. So
     from the overlay only the refresh reaches the rail, and MOTIR-5212 measured that apply being
     intermittently lost. **Carry `outcomeRef` on the announcement and apply it from the provider**, or an
     equivalent signal. Record the choice in MOTIR-5229, not in this asset.
2. **The Development section's merge frame is a second place the item page could submit a decision, and
   no card in this story owns it.** `DevelopmentSectionBody` wraps its rows in `DevelopmentGateFrame` while
   a `pull_request_merge` gate awaits (design § 20, MOTIR-5336), and
   [MOTIR-5484](motir:cmu1aj1bj00gkhyoi0iuds6xy) (`blocked`) plans to give that frame its verbs, _Approve
   and merge · Request changes_, on this page. That contradicts this story's rule that no `GateDecision` is
   submitted from the item page. **Re-scope MOTIR-5484** so the Development section takes this same band
   (flush, one label), with `kind: 'pull_request_merge'` and the overlay MOTIR-5437 builds for it, and puts
   the verbs in the overlay only.
3. **PR #2894 (MOTIR-5488), which merged during this pass as `3e1cf0e30`, narrows where the band can
   occur, and leaves the band itself unchanged.** A design card with an open linked pull request no longer
   has a standalone Design result section. Its result renders inside the Development block, and the merge
   gate decides it (`docs/decisions/design-result.md` AMENDMENT 4 Q8). So a `design_result` gate, and this
   band, occur only on a design card with NO pull request. Flag 2 is the Development block's half of the
   same split.
4. **Flattening the kept states needs ONE presentational input on `ApprovalGateControl`, and the story
   says it does not modify that component.** The frame has two box forms today, `inline` (its own
   bordered card, band 1 with the kind label) and `fill` (the overlay, which is chromeless but lifts the
   port's floor and ceiling). The item page needs a third: **`layout: 'section'`**. That form has no
   border or radius, no kind label in band 1, and no horizontal band padding, and keeps the port's floor,
   ceiling and Expand as `inline` has them. It adds no state, verb, band or decide path, which is exactly
   the reading § 22's planning flag 1 gave _"composed unmodified"_ for `fill`, and
   `tests/approval-gate-one-language.test.ts` is unaffected. **MOTIR-5229** names the input in its
   criteria, and **MOTIR-5215**'s _"does not modify `ApprovalGateControl`"_ reads as _no new state, verb,
   band or decide path_. The Workbench row and the overlay keep `inline` and `fill`.

---

## ⭐ Plan history — every plan that shaped this item, oldest first (Story MOTIR-5542 · MOTIR-5545 — `plan-history.mock.html`)

**The asset:** `plan-history.mock.html`, a two-file set (`docs/decisions/design-result.md` AMENDMENT 4 —
no `.png`; the card's original three-file criterion was amended on the record, 2026-09-15). **Cards:**
MOTIR-5545 draws it. **MOTIR-5547** builds the section and is `blocked_by` this card. **MOTIR-5546**
builds the read it renders. **MOTIR-5549** walks it end to end. Drawn against `origin/main` @ `34c8aa442`.

**What it draws.** A new section on `/items/<key>` that lists every plan related to THIS item: the plans
that created it, changed it, archived it, or added work items under it. Every `PlanStatus` is listed,
one row per plan, oldest first. Each row says what that plan did to the item and opens `/plans/<id>`.
Until now the page showed a plan only while it was undecided (the pending-plan notice above). Once a plan
was decided, the page kept no trace of it.

**Why it is a design card.** No asset in `design/work-items/` draws a decided plan on the item page. The
pending-plan indicator (§ _The PENDING-PLAN indicator_, above) rules `approved` and `declined` OUT of its
element by design. This is the NONE-exists case: an element no mock depicts.

**Panels:** 0 the item page at 1280, the section in its slot with the pending notice above ·
1 anatomy of one row · 2 one row per `PlanStatus` · 3 every reachable relation, by tense ·
4 the bound and **Show more plans**: at rest, loading, the last page landed, a failed load ·
5 the absences: no plan, no `ai:view_plan`, the first read failed · 6 dark (panel 2's rows) ·
7 narrow (`< md`), in `zh`.

### 0. Rendered first — what the render settled

These shipped components were rendered through the repo's vitest + RTL setup (`renderWithIntl`, the real
`messages/en.json` and `messages/zh.json`), under a throwaway config with no `globalSetup`, so no database
was touched: `PlanRow` in all five statuses in both locales, `PendingPlanNotice` (one plan),
`ContentSectionCard`, `ErrorState` and `ActivitySkeleton`. The row's status square, status pill, meta
line, glyphs and class strings are transcribed from that emitted markup. Icon paths come from the render's
own SVGs, and none is drawn by hand. The harness was deleted before this asset landed. Three facts from the
render shape the design:

- **`PlanRow` is a bordered card of its own** (`rounded-(--radius-card) border bg-(--el-surface)
shadow-(--shadow-subtle)`). It is the right row for `/plans`, where the page is the container. Inside
  `ContentSectionCard` it would be a container inside a container, which the call-to-action band's
  review rejected on 2026-09-15 (§ _The item page HANDS THE DECISION OVER_). **The history row therefore
  keeps `PlanRow`'s ANATOMY (square · title · meta · pill) and drops its BOX.** Rows are divided by a
  hairline, and none has a border, radius or shadow of its own.
- **`PlanRow` gives a `planned` plan an accent border**, meaning _awaiting your approval_. The history row
  does NOT inherit it: on this page the pending notice is the one call to action (§5).
- **The pill tones and the square tints ship already**: generating `--el-tint-sky`, planned
  `--el-tint-lavender`, stale `--el-tint-rose`, approved `--el-tint-mint`, declined `--el-muted` square
  with the `archived` pill. The history row reuses them unchanged and adds no tone.

### 1. The SLOT and the TIER — after Children, in tier 2

**The slot:** in the content column, **directly after `ChildPanel` and before the late stack's lower
half** (Attachments · Activity). Two neighbours decide it:

- **Children, above:** the commonest plan in this project adds work items under a card. A row reading
  _Added 5 work items under this item_ sits right under the list of those work items.
- **Activity, below:** the page's change history. Plans are the planned half of how a card came to look
  like this, and Activity is the edited half. The two sit next to each other without being merged.

**Rejected on the record:**

| candidate                                      | verdict                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| first in the column, beside the pending notice | **Rejected.** That slot is for whole-item state announcements (archived, pending). A history list is not an announcement, and putting a list above Description would push the item's own content below the fold on every card that has one                    |
| the core-fields rail, beside Provenance        | **Rejected.** The rail holds scalar facts about the card. Provenance already names the planning HARNESS, which is a scalar. A list of plans with sentences and a pager is content, and the rail is 18rem wide                                                 |
| a tab inside Activity                          | **Rejected.** The Activity section is one `<Suspense>` keyed on `?activity=`, so every tab switch re-suspends it. A Plans tab would re-fetch plans on each switch. It would also hide the history behind a control, while this story asks the page to show it |

**The tier: 2, inside the page's existing concurrent group** (`page.tsx`'s `Promise.all`). The read
joins it the same way `listPendingProposalsForWorkItem` does, conditional on `canViewPlans`. It is never a
serial `await`, which would re-introduce the shape MOTIR-3435 removed (§ _The item page at ARRIVAL_).

- **Why not tier 3.** The late stack's two halves share one promise, and the lower half's boundary is
  keyed on the activity tab. A plans read in `lateReads` would either re-run on every tab switch (lower
  half) or have to render above Children (upper half), which is the wrong slot.
- **What tier 2 costs.** One page of at most 5 plans (§6), served by the two existing `plan_item`
  indexes (`[workItemId, workspaceId]`, `[parentRef, workspaceId]`). A card with no related plan pays the
  index probes only. That is `max()` inside a group that already awaits nine reads. MOTIR-5546 states
  the exact query count.
- **It never resizes a box above the fold on arrival.** A tier-2 region renders WITH the first content,
  so nothing moves when it arrives. Like `ChildPanel` today, it sits below the upper late-stack boundary,
  and that boundary's fallback reserves its own box (§ _The item page at ARRIVAL_). **So the section has
  no loading state of its own.** The only loading state is Show more's (§6).

### 2. The ROW — anatomy (panel 1)

The whole row is ONE link to `/plans/<id>`, as `PlanRow` is. It uses `PlanRow`'s grammar without the box.

| #   | element                         | composes (as shipped)                                                                                                                | colour                                                               | shape                                        |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------- |
| 1   | the container and its label     | `ContentSectionCard` — title **Plans**, gloss **— how this item came to be** (the ONLY container)                                    | `--el-card` · `--el-border` · `--shadow-card`; title `--el-text`     | `--radius-card` · `--spacing-card-padding`   |
| 2   | the list                        | `<ul aria-label>`; rows divided by `border-t border-(--el-border-soft)` (the first row has none)                                     | divider `--el-border-soft`                                           | —                                            |
| 3   | status square                   | `PlanRow`'s `h-8 w-8` square + `STATUS_ICON` glyph, `aria-hidden`                                                                    | `STATUS_TINT[status]` fill · glyph `--el-text-strong`                | `--radius-control`                           |
| 4   | plan title                      | `PlanRow`'s title line, `truncate`; `planReview.untitledPlan` when `Plan.title` is null                                              | `--el-text`                                                          | —                                            |
| 5   | **the relation sentence** (NEW) | one line under the title, `text-[13px]`, keyed by status × relation (§3)                                                             | `--el-text-secondary`                                                | —                                            |
| 6   | meta line                       | `PlanRow`'s meta grammar (`text-xs`, `gap-x-3`): **created {when}** · **approved/declined {when} by {name}** (decided only) · author | `--el-text-secondary`; author glyph `--el-text-faint`, `aria-hidden` | —                                            |
| 7   | status pill                     | `PlanRow`'s `StatusPill`, label `aiPlanning.status.*`                                                                                | the shipped tone per status                                          | `--radius-badge` · `--spacing-chip-x/y`      |
| —   | row hit area                    | the `<a>`; hover and focus fill the row                                                                                              | hover `--el-surface`; focus ring `--focus-ring-color`                | `--radius-control` · `--spacing-control-x/y` |

**The author** reads `authorSource` the way `PlanAttribution` does. `mcp` + a harness gives **via {harness} ·
{model}** (NEW key; without a model it falls back to the shipped `aiPlanning.viaHarness`). `native` gives
the shipped **via Motir AI**. `null` renders nothing, because an unattributed plan is an absence, not a
placeholder (Part III §3 of `design/ai-planning/design-notes.md`). **The requester is not drawn.** The
history asks what a plan DID, and who asked for it is one click away on `/plans/<id>`. Leaving it out also
keeps the meta line to one line at 918px.

**The decider** rides the WHEN entry exactly as `PlanRow`'s `WhenEntry` does, reusing `aiPlanning.approvedByName`
/ `declinedByName`. When the plan was abandoned (`decidedById` null) it falls back to `approvedAt` /
`declinedAt`. **This needs `decidedByName` on the DTO**, which MOTIR-5546's card did not list. It was
requested on that card's in-flight run (§10).

### 3. The RELATION COPY — total over status × relation

**What a plan can hold for one item.** `@@unique([planId, workItemId])` lets a plan hold at most ONE of
_created_ (an `add` whose materialized id is this item), _changed_ (`modify`) and _archived_ (`remove`).
Any of those can combine with _added N under it_ (`add`s whose `parentRef` is this item's id). The DTO
carries that as `relation: { op: 'add' | 'modify' | 'remove' | null, childCount }`, with the invariant
`op !== null || childCount > 0`.

**The tense is set by status, and a sentence must never claim a change that did not happen**
(MOTIR-4472's defect on the peek):

- `generating` · `planned` · `stale` → **proposes** (present). The plan is live.
- `approved` → **did** (past). The proposals are the card now.
- `declined` → **proposed … — not applied**. The chip already says _Declined_. The sentence also says it,
  in words, so the row reads correctly without colour.

**`op: 'add'` (created this item) occurs only on an `approved` plan.** The id is written back to the
proposal only at approve (`plansService.materialize`), so no undecided or declined plan can hold it.
`created + added N` is unreachable too: children laid under a card added in the SAME plan carry a
`planItem:` temp-ref, not the card's id (MOTIR-5546's stated limitation). **Both are still given a key,
so the component's `switch` stays total**, the same argument `PendingPlanNotice` makes for
`remove + add`. The component renders the _approved_ sentence for `op: 'add'` whatever the status, and a
code comment says why.

Namespace **`issueViews`**, beside the pending notice's strings: these are the item page's sentences about
itself. `zh` has one plural arm, so every `zh` twin is `other` only, as the shipped `pendingPlan*` twins are.

| key                            | status    | English                                                                                                                                                                     | 中文                                                                         |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `planHistoryTitle`             | —         | Plans                                                                                                                                                                       | 计划                                                                         |
| `planHistoryGloss`             | —         | how this item came to be                                                                                                                                                    | 此工作项的由来                                                               |
| `planHistoryListAria`          | —         | Plans that shaped {key}                                                                                                                                                     | 塑造 {key} 的计划                                                            |
| `planHistoryProposesModify`    | proposing | Proposes changes to this item                                                                                                                                               | 提议修改此工作项                                                             |
| `planHistoryProposesRemove`    | proposing | Proposes to archive this item                                                                                                                                               | 提议归档此工作项                                                             |
| `planHistoryProposesAdd`       | proposing | {count, plural, one {Proposes # work item under this item} other {Proposes # work items under this item}}                                                                   | {count, plural, other {提议在此工作项下新增 # 个工作项}}                     |
| `planHistoryProposesModifyAdd` | proposing | {count, plural, one {Proposes changes to this item, and # work item under it} other {Proposes changes to this item, and # work items under it}}                             | {count, plural, other {提议修改此工作项，并在其下新增 # 个工作项}}           |
| `planHistoryProposesRemoveAdd` | proposing | {count, plural, one {Proposes to archive this item, and # work item under it} other {Proposes to archive this item, and # work items under it}}                             | {count, plural, other {提议归档此工作项，并在其下新增 # 个工作项}}           |
| `planHistoryCreated`           | approved  | Created this item                                                                                                                                                           | 创建了此工作项                                                               |
| `planHistoryCreatedAdded`      | approved  | {count, plural, one {Created this item, and # work item under it} other {Created this item, and # work items under it}} — _unreachable, for totality_                       | {count, plural, other {创建了此工作项，并在其下新增了 # 个工作项}}           |
| `planHistoryChanged`           | approved  | Changed this item                                                                                                                                                           | 修改了此工作项                                                               |
| `planHistoryArchived`          | approved  | Archived this item                                                                                                                                                          | 归档了此工作项                                                               |
| `planHistoryAdded`             | approved  | {count, plural, one {Added # work item under this item} other {Added # work items under this item}}                                                                         | {count, plural, other {在此工作项下新增了 # 个工作项}}                       |
| `planHistoryChangedAdded`      | approved  | {count, plural, one {Changed this item, and added # work item under it} other {Changed this item, and added # work items under it}}                                         | {count, plural, other {修改了此工作项，并在其下新增了 # 个工作项}}           |
| `planHistoryArchivedAdded`     | approved  | {count, plural, one {Archived this item, and added # work item under it} other {Archived this item, and added # work items under it}}                                       | {count, plural, other {归档了此工作项，并在其下新增了 # 个工作项}}           |
| `planHistoryDeclinedModify`    | declined  | Proposed changes to this item — not applied                                                                                                                                 | 曾提议修改此工作项——未应用                                                   |
| `planHistoryDeclinedRemove`    | declined  | Proposed to archive this item — not applied                                                                                                                                 | 曾提议归档此工作项——未应用                                                   |
| `planHistoryDeclinedAdd`       | declined  | {count, plural, one {Proposed # work item under this item — not added} other {Proposed # work items under this item — not added}}                                           | {count, plural, other {曾提议在此工作项下新增 # 个工作项——未新增}}           |
| `planHistoryDeclinedModifyAdd` | declined  | {count, plural, one {Proposed changes to this item, and # work item under it — not applied} other {Proposed changes to this item, and # work items under it — not applied}} | {count, plural, other {曾提议修改此工作项，并在其下新增 # 个工作项——未应用}} |
| `planHistoryDeclinedRemoveAdd` | declined  | {count, plural, one {Proposed to archive this item, and # work item under it — not applied} other {Proposed to archive this item, and # work items under it — not applied}} | {count, plural, other {曾提议归档此工作项，并在其下新增 # 个工作项——未应用}} |
| `planHistoryViaHarnessModel`   | —         | via {harness} · {model}                                                                                                                                                     | 由 {harness} · {model} 撰写                                                  |
| `planHistoryShowMore`          | —         | Show more plans                                                                                                                                                             | 显示更多计划                                                                 |
| `planHistoryError`             | —         | Couldn't load plans.                                                                                                                                                        | 无法加载计划。                                                               |
| `planHistoryLoadMoreError`     | —         | Couldn't load more plans.                                                                                                                                                   | 无法加载更多计划。                                                           |

**24 new keys, each with its `zh` twin in `messages/zh.json` in the same pull request.** **Reused, not
added:** `planReview.untitledPlan`, `aiPlanning.status.*`, `aiPlanning.createdAt`,
`aiPlanning.approvedAt` / `approvedByName`, `aiPlanning.declinedAt` / `declinedByName`,
`aiPlanning.viaHarness`, `aiPlanning.viaMotir`, `common.retry` (_Try again_).

### 4. PER `PlanStatus` — all five, and the enum is the checklist (panel 2)

| value        | listed? | sentence tense         | pill / square                     | note                                                                                                                                                                             |
| ------------ | ------- | ---------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generating` | **yes** | proposes               | sky · `LoaderCircle`              | Unlike the pending notice, which skips it: history lists what exists. The square's spin is drawn frozen, because a board is a still. The meta line shows **created {when}** only |
| `planned`    | **yes** | proposes               | lavender · `Clock`                | **No accent border and no second call to action** (§5)                                                                                                                           |
| `stale`      | **yes** | proposes               | rose · `OctagonAlert`             | Live and awaiting action, per the schema. The same row as `planned`                                                                                                              |
| `approved`   | **yes** | did                    | mint · `CircleCheck`              | The meta line adds **approved {when} by {name}**                                                                                                                                 |
| `declined`   | **yes** | proposed … not applied | muted · `CircleX` · archived pill | The meta line adds **declined {when} by {name}**, or **declined {when}** for a sweep-abandoned plan with no decider                                                              |

**Declare no status set for this element.** The pending notice needed its own set (`planned` + `stale`)
beside a totality assertion. History has no filter, so the component's `switch` over `PlanStatusDto` is
the totality check, and a sixth member turns its `never` arm red. MOTIR-5546's card already says not to
reuse `WORK_ITEM_PENDING_PLAN_STATUSES`.

### 5. COEXISTENCE with `PendingPlanNotice` (panel 0)

**An undecided plan appears in BOTH places, and the notice keeps the only call to action.**

- The notice stays exactly as shipped: first in the column, lavender, **Review plan**. Nothing about it
  changes.
- The history row for a `planned` / `stale` plan is an ordinary row: the whole row is a link, with no button,
  no accent border and no lavender fill. It says what the plan proposes, in the proposal tense.
- **Why both, rather than hiding undecided plans from the history:** the history's promise is _every plan,
  oldest first_. Hiding the newest ones would make the list look complete while missing the plans most
  likely to change the card, and it would reorder the list when a plan is decided. **Why no second
  call to action:** two differently styled doors to the same plan, one screen apart, raise the question of
  whether they do different things. They do not.
- Order does not change on decision: a row keeps its place (creation order), and only its pill, square,
  tense and meta line change.

### 6. SCALE — the bound and Show more (panel 4)

**The first page shows the OLDEST 5 plans. Show more plans appends the next 20, oldest first, until the
read's `nextCursor` is null.** The route clamps the page size (MOTIR-5546).

**Why oldest-first with the pager at the NEWER edge, set against Activity.** Activity lists newest first by
default and pages at the OLDER edge (_Show more changes (N older)_): its reader wants what just happened.
This list answers _how did this card come to look like this?_, so it reads in chronological order, and the
pager sits where that order leads, at the bottom. The newest plan a person most needs is an undecided one,
and the pending notice at the top of the page already names it, so hiding it behind the pager hides no
open decision.

**Why 5.** A card collects one plan that created it and usually one that expanded it. Five covers nearly
every card with no pager, keeps the tier-2 read to a very small page, and fits the section above
Attachments without a scroll's worth of rows.

**The control** reuses the Activity pager's shipped class string (`HistorySection`'s show-more: dashed
`--el-border-strong`, `--el-surface-soft`, `--height-control`, full width, `text-xs`
`--el-text-secondary`). **It carries no count**, because the read returns `{ items, nextCursor }` and no
total. Adding a count query to show _(N more)_ is not worth a second query on every card with more than
five plans.

**States:**

- **At rest:** 5 rows, then the control.
- **Loading:** the control is disabled (`disabled:opacity-60`, as shipped) and two row-shaped skeleton rows
  pulse at the newer edge (`--el-muted` fills, `animate-pulse`, `aria-busy`, which is the shipped pulse
  vocabulary, shaped like this row: a `h-8 w-8` square and two bars).
- **The last page landed:** the new rows are appended in place, the control is gone, and the scroll
  position is kept.
- **A failed load:** the rows already shown stay. Where the control was, a flush line reads **Couldn't
  load more plans.** in `--el-text-secondary`, with a secondary `sm` **Try again** button. The line has no
  box.

**Page state:** this is a client island that owns its appended rows. It reads nothing another mutation on
this page changes, and it keeps no optimistic state, so no tick is owed (CLAUDE.md § _Page state after a
mutation_).

### 7. The ABSENCES (panel 5)

- **(a) No related plan ⇒ NOTHING renders**, with no section and no reserved box. Children is followed by
  Attachments exactly as today. This is most cards.
- **(b) No `ai:view_plan` ⇒ NOTHING renders, and the read is skipped** (the `canViewPlans` conditional the
  pending notice already uses). A row that links to a plan the viewer cannot open would be worse than no row.
- **(c) The first read failed ⇒ the section renders, and its body is one flush line**: **Couldn't load
  plans.** plus a secondary `sm` **Try again** button that re-reads through the route. It is NOT the
  `ErrorState` card: `ErrorState` is itself a `Card`, so placing it inside `ContentSectionCard` would put a
  container inside a container (§0). The section still renders on a failed read because an absent section
  would claim _no plan ever touched this card_, which the page does not know. The read's arm catches its
  own error inside the group, as the page's other arms already do (the `page.tsx` comment above the group).
- **(d) Loading:** none for the section (§1). Show more has its own (§6).

### 8. BOTH THEMES — inks on their grounds (panels 2 and 6)

| ink                                     | ground                             | light                     | dark       |
| --------------------------------------- | ---------------------------------- | ------------------------- | ---------- |
| title `--el-text`                       | `--el-card` / hover `--el-surface` | ≥ 15 : 1                  | AA ✓       |
| sentence + meta `--el-text-secondary`   | `--el-card`                        | **6.80**                  | AA ✓       |
| sentence + meta `--el-text-secondary`   | hover `--el-surface`               | **6.24**                  | AA ✓       |
| pill label `--el-text-strong`           | its tint                           | ≥ 9 : 1                   | AA ✓       |
| declined pill `--el-archived-pill-text` | `--el-archived-pill-bg`            | as shipped                | as shipped |
| author glyph `--el-text-faint`          | —                                  | decorative, `aria-hidden` | —          |

**`--el-text-muted` is used nowhere.** It fails on `--el-surface` (4.17), which is the hover ground
(CLAUDE.md's pair table). The pending notice's notes record the same trap on lavender. The dark numbers
follow CLAUDE.md's measurement that every ink clears AA on every dark surface. Panel 6 draws the dark
board by re-emitting the Tier-3 block under `[data-theme='dark']`, so the nested element actually
recomputes (`tests/design-dark-parity.test.ts`).

### 9. a11y

- The list is a `<ul>` labelled **Plans that shaped {key}**. Each row is one `<a>`, whose accessible name
  reads title → sentence → meta → status. The status is also in words, so neither the tint nor the glyph
  carries it alone.
- Glyphs are `aria-hidden`. The frozen spinner on a `generating` square is decorative.
- Show more is a real `<button>`. While loading it is `disabled` and the skeleton is `aria-busy`. A failed
  load's line is `role="status"`, not an alert, because nothing is lost.
- Focus: rows take the shipped `focus-visible:ring-2 ring-(--focus-ring-color)`. After a page lands, focus
  stays on the control's position, which moves to the first new row.

### 10. The READ this renders — MOTIR-5546, and one field added to it

The row reads `planId`, `planTitle`, `planStatus`, `createdAt`, `decidedAt`, `author { source, harness,
model }` and `relation { op, childCount }`, all of which the card already lists. **One field is added:
`decidedByName`**, resolved on the same query through `Plan.decidedBy`. The row names the decider the way
`/plans` does, and the component stays presentational. It was requested on MOTIR-5546's in-flight run and
belongs to that card's deliverable. **Deliberately NOT requested:** a total count (§6) and the requester's
name (§2).

### 11. GIVES / TAKES

| card                                 | GIVES / TAKES | what                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5547** — the section         | **GIVES**     | the slot (after `ChildPanel`), the tier (2, the existing group), the flush row with every token, the 24 keys with `zh`, the bound (5, then pages of 20), the pager's states, the three absences, and the no-second-CTA rule                                                                                                                                                                       |
| **MOTIR-5547**                       | **SIZE**      | re-run against the asset: one presentational section plus one small client island (Show more: fetch, append, skeleton, error line) plus 24 keys × 2 catalogues plus the page wiring. **5 points / 65 minutes still fits**, because the 17 relation keys are mechanical and the switch mirrors `PendingPlanNotice`'s. Recorded because a silent "no change" and an unasked question look identical |
| **MOTIR-5546** — the read            | **GIVES**     | `decidedByName` on the DTO (§10), requested on its run; no count; page sizes 5 and 20 against a clamped limit                                                                                                                                                                                                                                                                                     |
| **MOTIR-5549** — the E2E             | **GIVES**     | what to walk: rows oldest first, each row opens its plan, Show more reaches the sixth plan, an untouched card renders no section                                                                                                                                                                                                                                                                  |
| **MOTIR-5548** — the vitest gate     | **GIVES**     | the no-plan (no section) and no-capability (read skipped) guards, and that the first-read failure renders the flush line rather than throwing the page                                                                                                                                                                                                                                            |
| MOTIR-4256 / MOTIR-4364 — the notice | **TAKES**     | the notice's slot, tone and copy, unchanged, and its rule that `ai:view_plan` suppresses the read                                                                                                                                                                                                                                                                                                 |
| MOTIR-5228 — the call-to-action band | **TAKES**     | one container, one label: why the row drops `PlanRow`'s box and why the error is not the `ErrorState` card                                                                                                                                                                                                                                                                                        |

### 12. What this asset does NOT draw

The pending notice (unchanged), `/plans/<id>`, the plan canvas, the peek, and Provenance. It renders no
proposed VALUES, since a row names the relation and never the diff (MOTIR-4197's boundary). It draws no
plan that touched only a descendant, because the relations are direct only. It changes nothing else about
the arrived page.

---

## The CI badge (MOTIR-5471)

**Asset: `list--ci-badge.mock.html`** (panels 6–9). It amends § _Columns_ and § _Filter builder_.
Story MOTIR-5469; built by MOTIR-5473 (the filter field) and MOTIR-5474 (the badge).

### It goes in the TITLE CELL, and it is a GLYPH — both forced by the width budget

The row is a CSS grid: `minmax(10rem, 1fr) 116px 120px 150px 150px 72px 80px 108px 76px`, `gap-x-4`
(16px × 8), `pl-4 pr-7` (44px).

```
872 fixed + 128 gaps + 44 padding + a 160px title floor = the 1204px minimum
```

**A new column is not affordable.** A ~120px _Checks_ track plus one more 16px gap takes the minimum
to **1340px**, which clips at 1280 AND at 1200 — on a surface whose column set already clips
(MOTIR-1307). The title cell is the row's **only flexible track**, so a badge there adds no fixed
width and **leaves the minimum at 1204px**.

**⚠️ And at that minimum the title track is only its 160px floor, which will not hold the key, a title
AND a labelled pill.** Drawn that way the pill OVERLAPPED the item key — the cell is `min-w-0` with no
`overflow-hidden`. **Rendering at exactly 1204px is what found it; the same sheet read fine at 1280 and
hid the problem.**

**So a ROW carries the glyph alone and a BOARD CARD carries the label.** The glyph is `CircleX` /
`CircleEllipsis` — the same two `CI_STATE_META` uses — as a `role="img"` with the shipped
`github.development.ciState.*` string as its accessible name and its `title`. Ink is
`--el-danger-on-surface` for `failing` (never `--el-danger-text`, which is the ink for a danger FILL)
and `--el-text-secondary` for `running`; both clear AA on every surface the row paints in. It carries
`shrink-0`, so the TITLE truncates and the badge stays whole.

State is still never colour alone: the two glyphs differ in SHAPE, and each has an accessible name —
the same bargain every other icon-only affordance in this row already makes.

**Measured:** at **1200** the row is 4px under its own minimum and scrolls, exactly as it does today —
the badge neither causes that nor worsens it. At **1280** there is 76px of slack, all of which the title
track absorbs, so more title shows and the glyph still sits at its end. **The row never grows and the
minimum never moves.** Both views share one column builder (`issueColumns.tsx`), so this holds for List
and Tree alike.

### The _Checks_ filter field

- **Group: `fields`.** `advancedFieldGroup` (`lib/issues/advancedFilterFields.ts`) returns `other` only
  for `lbl` / `cmp` / `folder`, and `customFields` for a custom field — so `ciState` lands in `fields`.
  It sits **after _Status_**, the field a reader pairs it with.
- **Label:** _Checks_ (en) · _检查_ (zh).
- **Values, worst-first** — the order `CI_STATES` declares and `foldCardCiState` applies, each carrying
  the same glyph the badge does:

  | value     | en             | zh         |
  | --------- | -------------- | ---------- |
  | `failing` | Checks failing | 检查失败   |
  | `running` | Checks running | 检查运行中 |
  | `passing` | Checks passing | 检查通过   |

- **The empty pair reads _has no checks_ / _has checks_** (zh: _无检查_ / _有检查_) — not “is empty”,
  because the column's `null` means something a reader can name: no pull request has reported and none
  is expected to.
- **The filter is RAW**, per the story: _Checks is any of Failing_ returns every card whose column reads
  `failing` in ANY status, done included, and a person combines it with Status. That is deliberate — the
  badge's done-category rule is a DRAWING rule, and making the filter share it would make a saved view
  silently lossy.

## ⭐ The STALE refusal — what you were looking at changed while you read it (Story MOTIR-5232 · MOTIR-5233 — `approval-control--stale-refusal.mock.html`, DATED 2026-09-18)

**A DELTA, and what it amends:** `approval-control.mock.html` § _The UNIVERSAL APPROVAL FRAME_ above —
its state **`H`**, the refusal drawn IN PLACE between the port and the verbs. That mock is unchanged;
this section adds ONE member to the frame's drawn refusal set. The container it is drawn in at full
bleed is `design/workbench/approval-overlay.mock.html` (§ 22 of `design/workbench/design-notes.md`),
whose Panel 6 this delta composes class for class.

### Why it is its own refusal

A reader meets THREE refusals on a gate that is still `awaiting` when they open it, and they mean
opposite things:

| refusal                           | what happened                                       | what the reader should do                  | control                        |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------ | ------------------------------ |
| `APPROVAL_GATE_ALREADY_DECIDED`   | somebody else answered it                           | nothing — read their answer                | none                           |
| `APPROVAL_GATE_SUPERSEDED`        | the question was WITHDRAWN                          | leave                                      | none                           |
| **`APPROVAL_GATE_STALE_SUBJECT`** | **still yours, and what you were looking at MOVED** | **take the current version, decide again** | **_Show the current version_** |

**Only the third has a next action the reader wants**, so it is the only refusal that carries a
control. Panel 1 draws the three side by side: the same band (`role="alert"`, between port and verbs,
`--el-tint-peach`), told apart by the words, the glyph and the control — never by colour alone.

### What it SAYS — settled copy

The server names what moved (MOTIR-5234's stamp): any of `subject` · `pull_requests` · `criteria`.

| moved                   | en                                                                              | zh                                               |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| `[subject]`             | A newer version was published while you were reading.                           | 你阅读期间，发布了更新的版本。                   |
| `[pull_requests]`       | New commits reached the pull requests while you were reading.                   | 你阅读期间，Pull Request 有了新的提交。          |
| `[criteria]`            | The acceptance criteria were edited while you were reading.                     | 你阅读期间，验收标准被修改了。                   |
| two or three            | Several things changed while you were reading: {things}.                        | 你阅读期间有多处变化：{things}。                 |
| next action (every one) | Your decision was not recorded. Look at the current version, then decide again. | 你的决定未被记录。请查看当前版本，然后重新决定。 |
| the control             | Show the current version                                                        | 查看当前版本                                     |

- **`{things}`** is the moved components' NOUNS in this fixed order — _the published version_ · _the
  pull requests_ · _the acceptance criteria_ (zh _已发布的版本_ · _Pull Request_ · _验收标准_) — joined by
  the locale's own list format (`Intl.ListFormat`, `type: 'conjunction'`), so en reads _a, b, and c_
  and zh _a、b和c_.
- **_version_, not _design_**, on purpose: the frame is universal and the pressed gate's subject is not
  always a design. **When the PRESSED gate is the merge gate, its subject IS the pull requests** — the
  server reports `pull_requests` there, never `subject` (planning flag below).
- The sentences keep the frame's refusal voice: the headline says what happened, the next action begins
  _Your decision was not recorded._ exactly as `ALREADY_DECIDED`'s does, because in both cases nothing
  was written.

### The control — ONE, and it RE-READS IN PLACE (decided)

**_Show the current version_ re-runs the frame's own read for the same (work item, kind)** — the address
the overlay is already on — and nothing else. The port swaps to the current version, band 1 names it,
a fresh stamp arrives with it, the refusal is removed, the verbs return live (state `A`), and focus moves
to the port region so the reader starts again from the top of what changed. **It never re-opens the
surface and never navigates**: the reader keeps the overlay, the page behind it, and their place. If the
re-read finds the question since ANSWERED or WITHDRAWN, the frame shows that state (`E`, `F`, `G`) — the
control promised the current version, and that is the current version.

**The verbs are DISABLED while any refusal is shown**, this one included: a second press would post the
same stale stamp and be refused again, so the refusal's own next action is the only live one.

### Where it can appear — TWO pressing hosts

- **The approval overlay** (Panels 2, 4, 6) — full bleed, the port at its expanded height.
- **The item page's Development block** (Panel 5) — the frame `DevelopmentGateFrame` renders for a design
  with pull requests, where ONE press decides the design gate and the merge gate (MOTIR-5652). This is
  the case the `pull_requests` component exists for: without it the press would merge commits the reader
  never saw.
- **NOT the item page's call-to-action band** (`approval-cta.mock.html`). The card said _"the item page's
  band"_; since MOTIR-5215 that band carries no verbs, so it can never meet a refusal. Corrected here
  rather than drawn.

### Token map — what the delta adds

- **The band** — the shipped `RefusalAlert`, unchanged, plus `flex-wrap items-start gap-x-3 gap-y-2` so
  the control sits at the trailing edge; the sentence is `flex-1 min-w-0`, and `basis-full` below `sm`
  so the control drops under it (Panel 6).
- **The glyph** — lucide `refresh-cw`, `h-4 w-4`, ink `--el-text-secondary`. Not
  `--el-danger-on-surface`: nothing failed, and the triangle is what the two leave-refusals keep.
- **The control** — the shipped `Button`, `variant="secondary"`, `size="sm"`, leading `refresh-cw` at
  `h-3.5 w-3.5`. Secondary, because the frame's primary action stays _Approve_.
- **Ink** — headline `--el-text-strong`, next action `--el-text-secondary`; no `--el-text-muted` or
  `--el-text-faint` is painted.

### GIVES / TAKES

| work item                          | GIVES / TAKES                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5235** (the surfaces)      | **GIVES** every sentence in both locales, the list rule, the control's label and its re-read-in-place behaviour, the disabled verbs, the glyph and the two hosts. **TAKES** — ELEMENT: a control inside a refusal band, which no refusal had; PREMISE: the item page's CTA band is not a host (its card says it is). |
| **MOTIR-5234** (the stamp)         | **GIVES** nothing drawn. **TAKES** — STRUCTURE: `moved` is a SET over `subject` · `pull_requests` · `criteria`, and a pressed MERGE gate reports `pull_requests`, not `subject`.                                                                                                                                     |
| **MOTIR-5237** (the E2E)           | **GIVES** the exact strings its en + zh assertions read, and the control's accessible name.                                                                                                                                                                                                                          |
| **MOTIR-5236** (the vitest gate)   | **neither** — no drawn element; its seams are the stamp's.                                                                                                                                                                                                                                                           |
| **MOTIR-4789** (the frame)         | **neither** — `done`; composed. State `H`'s band is reused unchanged and gains one sibling member.                                                                                                                                                                                                                   |
| **MOTIR-5222** (the overlay asset) | **neither** — `done`; Panel 6's container composed class for class.                                                                                                                                                                                                                                                  |
| **MOTIR-5667** (withdrawn causes)  | **neither** — `done`; the SUPERSEDED refusal's headline in Panel 1 is its shipped `withdrawn.cause.republished` sentence, unchanged.                                                                                                                                                                                 |

Grep over the story's SUBTREE (MOTIR-5233…5237) and the two hosts' files: no other card draws a refusal
control, and MOTIR-5243 (the open overlay learning its subject moved, Story MOTIR-5238) draws a
_non-refusing_ notice — a different element, and the stamp this refusal checks is what it reads.

### ⚠️ Planning flags

- **The server reports `pull_requests`, not `subject`, when the PRESSED gate is the merge gate** — its
  own subject IS the pull requests. MOTIR-5234 owns the mapping.
- **The disabled verbs are a BEHAVIOUR** — MOTIR-5235 keeps them disabled until the control has re-read,
  or a second press posts the same stale stamp.
- **MOTIR-5237's verification recipe names "the item page's band"** as a place to be refused; since
  MOTIR-5215 the item-page press happens in the overlay or the Development block. Its E2E should drive
  the overlay (and may drive the Development block for the pull-requests case).

## ⭐ The ACCEPTANCE gate as the PRIMARY — the receipt leads, the story's code is what the one press merges (Story MOTIR-4949 · MOTIR-5788 — `acceptance-panel--approve-and-merge.mock.html`, DATED 2026-09-19)

**Asset:** `design/work-items/acceptance-panel--approve-and-merge.mock.html` — a NEW delta mock. It
amends **§ The ACCEPTANCE gate, in the ONE approve language** above and its
`design/work-items/acceptance-panel.mock.html` (panels G1–G5), and is not an edit of either.
**G1–G5 remain the single-gate base**: Panel D(ii) below IS that shape, with one sentence changed.

**Drawn to:** `docs/decisions/approval-gates.md` §1's **MOTIR-5787 amendment**, which decides every
behaviour below (points 1–8). This section decides only what it looks like.

### What changes, in one sentence

When a STORY is run as a whole, its run's pull requests belong to the story, so the story holds two
questions — _is this what I wanted?_ (**PRIMARY**, `acceptance_result`) and _do these commits land?_
(`pull_request_approval`) — and **ONE press answers both**. It is the design card's (§ 20 of
`design/github/design-notes.md`, MOTIR-5667) and the decision card's (§ 27 there, MOTIR-5673)
arrangement with the **receipt** where the mock or the document goes. **The video is never committed
and is never what is merged.**

### Composed, never redrawn

| card       | asset it composes (published `sourcePath`)            | what it contributes here                                               |
| ---------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| MOTIR-4942 | `design/work-items/acceptance-panel.mock.html`        | the RECEIPT — player, scrubber, chapters, provenance chips (G1)        |
| MOTIR-5673 | `design/github/approve-and-merge--decision.mock.html` | the token block, the sprites, the frame + the primary-slot arrangement |
| MOTIR-5327 | `design/github/github.mock.html`                      | the Development block as the ONE gate frame                            |
| MOTIR-5480 | `design/github/approve-and-merge.mock.html`           | band 3's _Approve and merge_, the How-to-test part, the record band    |

The stylesheet and sprites are spliced 1:1 from the decision delta; the receipt's rules (`.player`,
`.scrub`, `.chapters`, `.chap`, `.prov .chip`) and five sprites (`play`, `commit`, `check-circle`,
`video`, `revise`) are spliced 1:1 from the base acceptance mock. **The only new rules are
`.ac-slot` (the receipt's slot) and `.ac-refusal` (Panel E's tool-output block).**

### Panels — which gate leads, which verbs render, what the band says

| panel             | the card and its state                                        | PRIMARY (band 1 kind)                     | verbs                                   | consequence (band 3)                                                                              |
| ----------------- | ------------------------------------------------------------- | ----------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A (+dark, ~400px) | story run · both gates awaiting                               | `acceptance_result` — _Acceptance video_  | Request changes · **Approve and merge** | `acceptanceResult.consequenceMerges` — accepts the story AND merges; **the video is not merged**  |
| B                 | story run · acceptance approved before the set is green       | — (decided)                               | **none**                                | the record band + `acceptanceResult.mergeHeld`                                                    |
| C                 | story run · merge ejected, then a push · merge re-asked ALONE | `pull_request_approval` — _Pull requests_ | Request changes · Approve and merge     | `acceptanceResult.consequenceMergeOnly`; the slot carries `acceptanceResult.stands`               |
| D(i)              | single-card run · the E2E subtask's OWN page                  | `pull_request_approval` — _Pull requests_ | Request changes · Approve and merge     | the shipped approve-and-merge sentence for ITS pull request — **no acceptance element at all**    |
| D(ii)             | single-card run · the STORY's page                            | `acceptance_result` — _Acceptance video_  | Request changes · **Approve**           | `acceptanceResult.consequence` (point 7: Done once nothing under it is open)                      |
| E                 | a republish AFTER approval                                    | — (decided; the page is Panel B)          | none                                    | nothing on the page changes; the PUBLISHER meets `ACCEPTANCE_EVIDENCE_ALREADY_APPROVED` (shipped) |

**Order inside band 2, every panel that has a receipt:** the receipt FIRST (the shipped order for a
primary), then How to test, then the pull requests behind the block's soft rule (`.ds-prs`). Unlike a
decision card, a story run HAS something to run, so **How to test stays**.

### AMENDMENT (MOTIR-5792, 2026-09-19) — the state this table did not name

**The panels above are all drawn with the set GREEN, and a story run is not green for most of
its life.** Between the pull requests opening and their checks passing the story holds an
awaiting acceptance question and NO merge question — so there is no frame in the Development
block, because the frame is the merge gate's. The table has no row for that state, and the
implementation read the missing row as _the receipt is in the block whenever a pull request is
open_: the receipt rendered as a subject with no verbs, and the only door left to an awaiting
question was the To-approve row.

**It is not a new surface and it needs no new panel.** That state is G1–G5 of MOTIR-4942 — the
standalone **Acceptance** section with the call-to-action band — drawn exactly as it is on a
story with no pull request at all. The rule, stated positively so the next reader does not
re-derive it:

| the story's acceptance gate | a merge gate exists | where the receipt is drawn                                           |
| --------------------------- | ------------------- | -------------------------------------------------------------------- |
| awaiting                    | yes                 | the Development block, LEADING the frame — Panel A                   |
| awaiting                    | no                  | the standalone **Acceptance** section, with its band — G1–G5         |
| decided                     | either              | the Development block, as a line beside its commits — Panels B and C |

**A DECIDED receipt stays in the block whatever the checks are doing**, because a line about a
decision already made strands no question — which is what Panel B already draws. The walk that
shows this is `tests/e2e/regression-gate.spec.ts`; the guard is
`tests/components/late-stack-development-block.test.tsx`.

### AMENDMENT (MOTIR-5792, 2026-09-19) — the standalone section's DECIDED state is the shared frame

**G4's own _Approved_ pill is RETIRED, and nothing new is drawn.** While the panel owned the
verbs, a pill of its own was the decided state; MOTIR-5790 handed the decision to the overlay
and left the pill behind, which made the panel a second place the product says _approved_ — and
it says it with less: no decider, no moment, no version. The surface for a decided question
already exists and is specified elsewhere: **`design/work-items/approval-control.mock.html`'s
record band**, the frame every other kind uses.

So the standalone **Acceptance** section now renders `ApprovalGateControl` for every state the
call-to-action band does not — the record, state `B`'s _waiting on_, a withdrawal — with **the
recording as its port** and an EMPTY verb set. That is `DesignResultSection`'s arrangement
since MOTIR-5229, one kind over, and it needs no mock of its own because both halves are drawn:
the frame in the approval-control asset, the receipt in G1.

**The pill survives in exactly one case and it is not a gate:** a receipt with NO gate row at
all — one published before the kind existed, or before its question was raised. There is no
decision to speak about there, so the receipt's own status is all there is to say.

Enforced by `tests/approval-gate-one-language.test.ts`, which DERIVES its population (any
module handling an `ApprovalGateDTO`) rather than listing it — which is also why
`AcceptanceDevelopmentSlot` stopped taking a gate: it is what the frame puts in band 2, so it
takes the two facts it draws and its caller reads the gate.

**Panel D(i) is drawn so the absence is unambiguous.** The E2E subtask recorded the video and is not
where it is decided (point 1). Its page shows its own Development gate only — no receipt port, no
acceptance copy, no acceptance verb. An implementation that puts the port here has built the wrong
card.

**Panel E is a refusal a PUBLISHER meets, not a reader.** The freeze is the shipped
`AcceptanceEvidenceAlreadyApprovedError` (MOTIR-2764), keyed on the approval whatever the pull
requests are doing (point 6). No new refusal, and no new surface: the story page is Panel B.

### Copy — every string, `en` and `zh`

Existing keys are cited, not repeated: `approvalGate.acceptanceResult.kindLabel` / `.meta.*` /
`.confirm.*` / `.consequence` (MOTIR-4950), the `Approve and merge` / `Request changes` / `Approve`
verbs, `approvalGate.waitingOn`, and the status-held notice's `decisionNoun.acceptance_result`.
New keys, under `approvalGate.acceptanceResult.*`, for MOTIR-5790:

| key                    | en                                                                                                                                       | zh                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `headMeta.run`         | recorded by {producer} · {count, plural, =1 {# pull request} other {# pull requests}} · delivered by {run}                               | 由 {producer} 录制 · {count} 个拉取请求 · 由 {run} 交付                                        |
| `headMeta.alone`       | recorded by {producer}                                                                                                                   | 由 {producer} 录制                                                                             |
| `consequenceMerges`    | Approving accepts {key} and merges {prs}, then moves {key} to Approved. The video is not merged — it is evidence and is never committed. | 批准即验收 {key} 并合并 {prs}，随后将 {key} 移至“已批准”。视频不会被合并——它是证据，从不提交。 |
| `consequenceMergeOnly` | Approving merges {prs} at its new head, then moves {key} to Approved. The acceptance is not asked again.                                 | 批准即以新提交合并 {prs}，随后将 {key} 移至“已批准”。验收不会再次询问。                        |
| `confirm.merges`       | merge {prs} — the video is not part of it.                                                                                               | 合并 {prs} — 视频不在其中。                                                                    |
| `accepted`             | Acceptance approved by {name} · {when}                                                                                                   | {name} 于 {when} 批准了验收                                                                    |
| `stands`               | Acceptance approved by {name} · {when} — the video stands                                                                                | {name} 于 {when} 批准了验收 — 视频保持不变                                                     |
| `mergeHeld`            | The pull request merges when its checks pass — no second press.                                                                          | 拉取请求在检查通过后自动合并，无需再次点击。                                                   |

The **story-run** confirm band lists `confirm.records`, `confirm.freezes`, then `confirm.merges`; the
**single-card** band keeps `confirm.records`, `confirm.freezes`, `confirm.movesToDone`.
**G1's _"Approving finishes {key}. Nothing else does."_ is RETIRED** by `consequence` (point 7): it is
false while a child's code is still open.

### Decisions this asset made, with their reason

- **The receipt LEADS, the pull requests follow.** The shipped order for a primary; a second order
  would be a second visual language for one act.
- **The consequence says the video is not merged, in words.** The press merges code to the default
  branch, which is irreversible and outside Motir; a reviewer who thinks they are approving a video
  must be told what else the press does (the story's own explanation).
- **D(ii)'s verb is plain _Approve_.** Nothing is merged on that press, so _and merge_ would be false.
- **C hands the lead to the merge question.** With the acceptance answered, the only open question is
  the commits, so band 1 is the plain _Pull requests_ kind and the acceptance is a line, not a band —
  § 27's Panel 5b decision, one kind over.
- **E draws no surface.** A refused publish changes nothing a reader sees; inventing a callout would
  need a record of the refusal that no decision asks for.

### Allocation

**MOTIR-5790 builds Panels A, B, C, D(i), D(ii) and E's (absent) surface**, and the keys above.
MOTIR-5789 supplies the behaviour they render (the predicate, the one press, the Q4 carry);
MOTIR-4950 shipped the kind, the port's receipt and the single-card copy. **G1–G5 of MOTIR-4942
remain the single-gate base** — this asset amends them only in D(ii)'s consequence sentence.

Fixture items use `ACME-n` keys, as the rest of this area does, so they link to nothing.

## ⭐ The DECISION-WAITING MARKER — yours vs someone else's, on the board card, the List/Tree row and the item header (Story MOTIR-4908 · MOTIR-5875 — `decision-waiting.mock.html`, DATED 2026-09-21)

**The asset:** `decision-waiting.mock.html`, a two-file set with this section (no `.png`). It gates
**MOTIR-5877** (the board card), **MOTIR-5878** (the item header) and **MOTIR-5881** (List and Tree),
each of which carries it in `blocked_by`. **MOTIR-5876** (the read) supplies the state and does not wait
on it.

**What it draws:** ONE marker, in the three places a member meets a work item before opening it, that
answers two questions — _is a decision waiting here?_ and _is it waiting on me?_ Every earlier design in
this epic names this story as the owner of "the pending indicator" and draws none of it: § _The item page
HANDS THE DECISION OVER_ (_What the band is NOT_), § _The status control says so_ (_Out of scope here_),
`design/boards/design-notes.md` § the held refusal, `design/workbench/design-notes.md` § 20 and § 22.

**Panels:** 1 the three states on a board card · 2 the exclusive slot's precedence, with `Blocked` and the
CI badge · 3 several gates, the carried merge gate, and the retired _Awaiting acceptance_ pill · 4 the List
row at its new minimum, measured · 5 the Tree, a lazily-expanded level · 6 the item header at 1280 and at
390 · 7 the header marker beside the status control's held notice · 8 press → destination per kind, and
before the late tier has streamed · 9 dark and 中文.

### Rendered first

Every board card, list row, status pill, the held notice and the buttons in the asset are the markup the
REAL components emit — `BoardCardView`, `IssueListTable` (inline-edit off), `StatusHeldNotice`,
`IssueTypeIcon` and `buttonVariants` — rendered with the repo's vitest + RTL setup and the real `en` /
`zh` catalogues on `origin/main` `de31060f1`. The asset's stylesheet is the project's own Tailwind build
(`@import 'tailwindcss'` + `@motir/design-system/theme.css`, the entry `app/globals.css` compiles), run
over exactly the classes the markup carries. The item header is lifted class-for-class from
`app/(authed)/items/[key]/page.tsx`. Four facts from that reading shape the design:

- **A board card is ONE `<button>`** (`BoardCard.tsx`, the whole card is the drag handle), so the marker
  there cannot be a control, and the card's `aria-label` (`openIssueAria`) would hide its text from a
  screen reader. It is static and is referenced by `aria-describedby`.
- **The CI glyph lives in the TITLE cell, not the status cell** (`issueColumns.tsx`, MOTIR-5474). The card
  asks for the marker "beside the status pill in the glyph form the CI badge already uses there"; the FORM
  is taken from the CI badge, the PLACE is the status cell as the card asks — a decision holds the STATUS,
  and the title cell already carries one glyph a reader must decode.
- **Where a gate is drawn on the item page is not fixed by its kind.** `LateSections.tsx` moves a
  `design_result` gate into the Development block when the card has an open linked pull request
  (AMENDMENT 6), moves an `acceptance_result` gate there on a story run (MOTIR-5790), and always draws
  `decision_approval` and `pull_request_approval` there. The card's per-kind destination list is therefore
  refined below into a rule that follows the frame.
- **The status control's held notice is already yellow** (`StatusHeldNotice`: `--el-tint-yellow`), and so
  is the band's _Awaiting you_ pill (`tone="awaiting"`). The loud marker takes the SAME tint, so the page has
  one colour for _a decision is waiting on you_.

### The three states — the rule is the To-approve tab's, read not restated

| state              | when                                                                                                                                                                                                                                                      | treatment                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Yours**          | an `awaiting` gate this reader would see in THEIR To-approve tab: routed to them (`assigneeId ?? reporterId`, `routingTargetId`), not a merge gate carried by a primary (`CARRIED_MERGE_GATE_EXCLUDED`), and the reader holds the kind's permission floor | LOUD — `Pill tone="awaiting"`, glyph `Stamp`, _Awaiting you_          |
| **Someone else's** | any other `awaiting` gate — an admin holding `approval:decide_any` on a gate routed elsewhere, a gate routed to this reader when they are below the floor (the frame's own see-only case)                                                                 | QUIET — `Pill tone="neutral"`, glyph `Hourglass`, _Waiting on {name}_ |
| **None**           | no gate, or every gate is `approved` / `changes_requested` / `superseded`                                                                                                                                                                                 | nothing is rendered — the surface is unchanged                        |

**There is no unrouted state, and none is drawn** (Yue, 2026-09-21). §2 routes a gate to `assigneeId ?? reporterId`, and `work_item.reporter_id` is `NOT NULL` with `onDelete: Restrict` (`prisma/schema.prisma`), so `routingTargetId` always names a person and the quiet form always reads _Waiting on {name}_. The first revision of this section drew a _routed to nobody_ fallback (_Awaiting a decision_, keys `approvalGate.waiting.unrouted` / `glyphUnrouted`); that case cannot occur, so the panel and both keys are withdrawn. A consumer does not branch on a null routee.

**Loud and quiet differ in three ways and never in text alone:** the fill (`--el-tint-yellow` vs
`--el-chip-bg` + `--el-chip-border`), the ink (`--el-text-strong` vs `--el-text-secondary`) and the glyph's
SHAPE (`Stamp` vs `Hourglass`). Both glyphs are `aria-hidden`; the words or the accessible name carry the
meaning.

**Several gates on one card:** any gate that is yours makes the card yours. The entry the surfaces show is
the FIRST yours gate by `createdAt`, else the OLDEST someone-else's gate — its `kind` is what the header
anchors on and what the glyph's accessible name names (MOTIR-5876's contract). **A merge gate carried by a
primary is excluded** exactly as the To-approve tab excludes it, so a design card with an open pull request
(design gate + merge gate) shows ONE marker. The marker carries no count and never rolls up: a parent row
shows one only for a gate on itself.

### The three forms

| surface              | form                                                                         | where                                                                                                                | interaction                                                                                   |
| -------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **board card**       | LABEL — the pill with its glyph and words                                    | the card's EXCLUSIVE slot, first in the pill row; the CI badge stays immediately after it                            | none — static inside the card `<button>`; the card sets `aria-describedby` to the marker's id |
| **List / Tree row**  | GLYPH — 18px, `shrink-0`, `role="img"` with the sentence as name and `title` | the STATUS cell, after the status pill (`gap-1.5`), OUTSIDE the inline-edit trigger so it is not part of that button | none — the row link still owns the click                                                      |
| **item page header** | LABEL, as a `<button>`, with a trailing `ArrowDown`                          | the EYEBROW, after the breadcrumb (the slot the _Archived_ chip uses); the breadcrumb cell gains `flex-wrap gap-y-2` | press → scroll to the gate's section (below). Early tier — on screen before the late stack    |

### The board card's exclusive slot — the precedence

The slot holds ONE of: **Yours › `Blocked` › Someone else's › the priority chip.**

- **Yours beats `Blocked`**: it is the only one of the four that asks the reader to act, and a decision can
  be made on a card whose blockers are open.
- **`Blocked` beats Someone else's**: the quiet marker is context the reader cannot act on; the card's own
  readiness is the more useful fact on a board.
- **The CI badge is not in the slot** and does not move (`board-card--ci-badge.mock.html` panel 1). The
  row already wraps, so marker + CI badge take a second line only when they must (panel 2).
- **A long name** in the quiet form truncates inside the pill (`min-w-0 max-w-full`, the words in a
  `truncate` span) and the row wraps the avatar to its own line — the wrap the CI badge introduced.

### The List / Tree status cell — measured, and the track widens 108 → 144px

The row grid is `minmax(10rem,1fr) 116px 120px 150px 150px 72px 80px 108px` (+ `gap-x-4`,
`pl-4 pr-7`), per § _The CI badge (MOTIR-5471)_. Rendered at the row's minimum, measured with
`getBoundingClientRect` in Chromium on the asset's own rows (panel 4):

| status pill (shipped `StatusPill`) | pill    | + 6px gap + 18px marker  | fits 108? | fits 144?      |
| ---------------------------------- | ------- | ------------------------ | --------- | -------------- |
| _Implemented_ (carries a glyph)    | 113.6px | **138px**                | **no**    | yes, 6px spare |
| _Approved_ (carries a glyph)       | 93.8px  | 118px                    | **no**    | yes            |
| _In Review_                        | 76.8px  | 101px                    | yes       | yes            |
| _In Progress_                      | 85px    | (no gate in the fixture) | —         | —              |

**At 108px the marker does not fit beside the two per-status pills that carry a glyph**, and the column's
own comment is out of date: it sizes the track on _In Progress_ ≈ 88px, but _Implemented_ (MOTIR-3103)
is **113.6px on its own — already 5.6px wider than its track today**, spilling into the row's 28px right
padding where nothing shows it. **So the Status track widens to 144px:** the widest pairing fits with 6px
to spare, and the row minimum moves **1204 → 1240px**. At 1280 the slack falls from 76 to 40px and
nothing clips; at 1200 the row already scrolls today (4px under its minimum) and now scrolls 40px under.
The title track absorbs the rest, exactly as before. List, lazy Tree and static Tree share
`buildIssueColumns`, so all three take the same width.

**Placing it in the TITLE cell instead was weighed and declined.** It costs no width (the CI badge's
argument), but that cell already carries the CI glyph, two glyphs there are two shapes to decode at the
end of a truncating title, and the story's own card puts the marker in the status column — a decision is
what holds the status.

### The item header — where pressing it takes you

**The rule:** every section that draws a gate's frame carries `data-decision-anchor="<kind>"` (and
`tabindex="-1"`) on its section card, so the marker's destination is WHEREVER that kind is drawn. What
that rule yields on `origin/main` today:

| gate kind               | the section it scrolls to                     | when                                                                |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `design_result`         | **Design result** — the call-to-action band   | the card has no open linked pull request                            |
| `design_result`         | **Development** — the design leads the block  | an open linked pull request (AMENDMENT 6)                           |
| `acceptance_result`     | **Acceptance**                                | the story has no open pull request of its own, or no merge gate yet |
| `acceptance_result`     | **Development** — the receipt leads the block | the story run: an open pull request and a merge gate (MOTIR-5790)   |
| `pull_request_approval` | **Development** — the pull-request frame      | always (uncarried only — a carried one draws no marker)             |
| `decision_approval`     | **Development** — the decision port (§ 27)    | always                                                              |

**Press, when the anchor is in the DOM:** `scrollIntoView({ block: 'start' })` — smooth unless
`prefers-reduced-motion` — and move focus to the anchored card (panel 8A draws the ring).

**Press, before the late stack has streamed (panel 8B):** those sections render in the page's LATE tier.
If the anchor is not there yet, scroll to the late stack's fallback, swap the trailing `ArrowDown` for a
spinning `LoaderCircle`, set `aria-busy="true"` and announce _Opening the {decision}…_ in a polite status
region. When the anchor mounts, scroll and focus ONCE and restore the glyph. If the stack settles with no
anchor (the reader cannot see that section), stop waiting and stay put.

**It is a pointer, never a verb.** Beside the held notice (panel 7) the page already has its ONE _Review &
approve_ door above the fold, and the band carries it again where the gate lives. The header marker adds no
third: its words are the state, its glyph is `ArrowDown`, it never carries `ScanEye`, never says _Review &
approve_, and never writes the overlay address.

### Tokens and primitives

| element                | primitive                                             | colour                                                           | shape                                   |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| loud marker (label)    | `Pill tone="awaiting"` + lucide `Stamp` 12px          | `--el-tint-yellow` · `--el-text-strong`                          | `--radius-badge` · `--spacing-chip-x/y` |
| quiet marker (label)   | `Pill tone="neutral"` + lucide `Hourglass` 12px       | `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary`      | `--radius-badge` · `--spacing-chip-x/y` |
| loud marker (glyph)    | an 18px disc + `Stamp` 12px                           | `--el-tint-yellow` · `--el-text-strong`                          | `rounded-full` (a disc)                 |
| quiet marker (glyph)   | bare `Hourglass` 14px in an 18px box                  | `--el-text-secondary`                                            | —                                       |
| header marker          | the label pill as a `<button>` + trailing `ArrowDown` | as its state · hover `--el-border-strong` · `--focus-ring-color` | `--radius-badge`                        |
| header marker, waiting | trailing `LoaderCircle` `animate-spin`                | as its state                                                     | —                                       |
| the landed section     | the section card, focused                             | `--focus-ring-color` ring                                        | `--radius-card`                         |

Both inks clear AA on every surface the marker paints on: `--el-text-strong` on the yellow tint (the band's
and the held notice's pairing), and `--el-text-secondary` on the chip fill, which is 6.18–6.80:1 on every
surface in both themes.

### Copy — en + zh

The loud words REUSE `approvalGate.state.awaitingYou`; `{decision}` is the shipped
`approvalGate.statusHeld.decisionNoun.<kind>`. Every new key is under `approvalGate.waiting.*`.

| key                                       | en                             | zh                           | used by                                  |
| ----------------------------------------- | ------------------------------ | ---------------------------- | ---------------------------------------- |
| `approvalGate.state.awaitingYou` (reused) | Awaiting you                   | 等待你处理                   | loud label, board + header               |
| `approvalGate.waiting.on`                 | Waiting on {name}              | 等待 {name} 处理             | quiet label, board + header              |
| `approvalGate.waiting.glyphYours`         | Awaiting you — {decision}      | 等待你处理——{decision}       | row glyph name + `title`; header name    |
| `approvalGate.waiting.glyphOn`            | Waiting on {name} — {decision} | 等待 {name} 处理——{decision} | row glyph name + `title`; header name    |
| `approvalGate.waiting.jump`               | Go to the {decision}           | 前往{decision}               | header marker `title` + end of its name  |
| `approvalGate.waiting.opening`            | Opening the {decision}…        | 正在打开{decision}…          | header marker, pressed before the stream |
| `boards.awaitingAcceptance`               | **REMOVED**                    | **REMOVED**                  | — retired with the pill                  |

The header marker's accessible name is `glyph*` + `. ` + `jump` — _Awaiting you — design approval. Go to
the design approval_ — so a screen-reader user hears both the state and where the button goes.

### The _Awaiting acceptance_ pill is RETIRED

The board's `Awaiting acceptance` pill ([MOTIR-1636](motir:cmr8bo6xq000v04l717ruve6v), drawn by
[MOTIR-1633](motir:cmr8bmqxy000004l7uvl0wddz), § _Story-acceptance surfaces_) and the marker state ONE fact
twice: every pending acceptance receipt raises an awaiting `acceptance_result` gate
(`acceptanceEvidenceService.persistEvidence` → `reconcileGatesFor`). **The marker takes the pill's slot**
(panel 3), and **`boards.awaitingAcceptance` is removed** from `en.json` and `zh.json` together with the
`BoardCardDto.awaitingAcceptance` field and its batch — MOTIR-5877's retirement, which also leaves the
board's query count where it was.

### Out of scope, each with its reason

- **The quick view** — its status control already carries the held notice and its door (MOTIR-5528).
- **Workbench rows** — the To-approve tab IS that list.
- **The backlog** — it lists planned `todo` work, and gates are raised in review.
- **The roadmap canvas node** — not a surface the story names.
- **The band, the overlay, the held notice and the CI badge** — composed as they ship, never redrawn.

### Allocation

| work item      | builds                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5876** | the state rule itself — `pendingDecisionsFor`, which answers yours / others / none, the entry's `kind` and `routedToId` for a set of work items. Draws nothing                               |
| **MOTIR-5877** | the SHARED marker component in both its forms (label and glyph); the board card's slot and its precedence; `aria-describedby`; retiring the pill, its field and its string                   |
| **MOTIR-5881** | the List and Tree status cell: the glyph after the pill, outside the edit trigger, and the Status track 108 → 144px in `buildIssueColumns`                                                   |
| **MOTIR-5878** | the header marker as a button in the eyebrow (and the cell's `flex-wrap gap-y-2`); `data-decision-anchor` on every section card that draws a gate's frame; the press, the wait and the focus |

Panel 9 is shared: every form above in dark and in `zh`.

## ⭐ THE CHOICE PORT — a person PICKS one of N options, each with its why, and what they chose is stamped (Story MOTIR-4914 · MOTIR-5888 — `approval-control--choice.mock.html`, DATED 2026-09-21)

**Assets.** Three DELTA mocks, one per base they amend; no base file is edited:

- **`design/work-items/approval-control--choice.mock.html`** — the port, band 3, the defect state, the read-only state, the record and the access path (Panels 1–7). Amends `approval-control.mock.html` (§ the universal approval frame, MOTIR-4789), whose GIVES/TAKES row for MOTIR-4914 reads _"the option rows, their named axes and the stamp"_ — which is this section (the "axes" there are what this section now calls, in the person's words, what each option is **best for**).
- **`design/workbench/approvals-row--choice.mock.html`** — the To-approve row and the Approvals-room rows (Panels 7a–7c). Amends `design/workbench/approvals-row.mock.html` as `approvals-row--decision.mock.html` did for the decision kind.
- **`design/work-items/type-executor-picker--choice.mock.html`** — the `choice` type chip and its place in the picker (Panels 1–2). Amends `type-executor-picker.mock.html`.

**The behaviour is the ADRs', not this section's.** `docs/decisions/approval-gates.md` §1's MOTIR-5887 amendment fixes the subject (the parsed `## Options` section), the four defect reasons, raise and supersede, the verb set (the options plus _None of these_), Workflow A and the `chosenOption` record. `docs/decisions/work-item-type-taxonomy.md` Amendment 3 (MOTIR-5886) admits the type. Where either disagrees with this section, the ADR wins.

**Rendered from shipped reality.** Before anything was drawn, the real `ApprovalGateControl` was rendered to static HTML (react-dom/server, the real `en` catalogue, `layout="section"`) in states A, B, E and F, and the real `WorkItemTypeChip` for the five Govern members. Every frame in the mocks is that emitted markup; only the port's contents and the kind-supplied strings are new. The stylesheets are the bases' own, carried byte for byte.

**For whom, and the access path.** A signed-in project member facing a decision the planner declined to make. They meet it in three places, all shipped, none new:

1. **`/items/[key]`** — a **Choice** section in the item page's late stack, in the slot a design result takes (`LateSections.tsx`). It shows the options read-only and ONE door, the shipped `GateCallToActionBand`, whose button reads **Review & choose** (Panel 6a). Per MOTIR-5215 the page keeps the record and none of the verbs.
2. **The full-screen overlay** (`?approval=<key>`, MOTIR-5214) — the frame with its verbs (Panel 6b).
3. **The To-approve tab and the Approvals room** — a row that opens the same overlay (`approvals-row--choice.mock.html`).

### ⭐ WHY THIS IS A CHOICE — added on review (2026-09-21, Panel 1d)

**Reviewed and sent back with one change: the body must say why the planner brought a choice back at all.** `kind-container.md`'s choice rule (MOTIR-4915) names exactly three situations that produce one, and a person facing the options needs to know which they are in before reading them. Overruling what they said, improving on what they said, and resolving a fork in their own requirement are three different questions.

- **The section sits directly under the question, ABOVE the options**, in every state that shows the port (A, B, C, E, F, the defect state, the overlay, the item page).
- **The situation is a chip** in `--el-tint-lavender` + `--el-text-strong`: _Research contradicts your decision_ · _A better option than your decision_ · _Your requirement allows two workflows_. It is deliberately NOT the best-for chips' sky, so the situation and the options' best-for values never read as one vocabulary.
- **Situations 1 and 2 quote the person's decision** on a _You said_ line (a `border-l-2` `--el-border-strong` quote, the label in `--el-text-secondary`). Situation 3 quotes nothing and says where the requirement forks.
- **The record stamps it** — _Asked because {situation}_ in the decided record strip (Panel 5a), from `chosenOption.situation`.
- **The ADR makes it checkable**, not decorative: three more defect reasons (`no_why_section`, `unknown_situation`, `no_quoted_decision`), and `subjectVersion` now hashes the section (`approval-gates.md` §1's MOTIR-5887 amendment, point 1).

**And the board's own example changed with it.** The first cut asked _where exported reports live_ with no reason given — a technical HOW, which the choice rule says the planner decides unless the person volunteered one. It is now situation 2: the person said _"Store the exports in our own Postgres"_, and research found a better option that does not make theirs wrong.

### The port (Panel 1)

| element                  | treatment                                                                                                        | tokens                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the question             | an eyebrow _Question_ and the `## Question` text, `text-sm font-medium`                                          | `--el-text`; eyebrow `--el-text-secondary`                                                                                                                               |
| why this is a choice     | a bordered box: eyebrow + situation chip, the _You said_ quote (situations 1–2), the evidence prose              | `--el-border-soft`; chip `--el-tint-lavender` + `--el-text-strong`; quote rule `--el-border-strong`; prose `--el-text-secondary`                                         |
| the option list          | an eyebrow _Options · {n}_, then one row per `### <label>`, a **radio group**; the whole row is the hit target   | —                                                                                                                                                                        |
| an option row            | a card-radius box: radio dot, the LABEL, then **best if you want** + what it is best for as a chip, then the WHY | box `--el-border` on `--el-page-bg`; selected `--el-accent` border on `--el-surface-soft`; radio `--el-border-strong`, selected `--el-accent`; WHY `--el-text-secondary` |
| the best-for chip        | the shipped `Pill` shape, ONE tint for every value (they are not categories, so colour would invent a meaning)   | `--el-tint-sky` + `--el-text-strong`                                                                                                                                     |
| _What this choice gates_ | a soft box below the options, eyebrow + the section's text                                                       | `--el-surface-soft`, `--el-border-soft`, `--el-text`                                                                                                                     |

**What an option is best for is RENDERED, not implied.** The story's point is that a reader choosing between two names is guessing, so every row carries what it is best for as a visible chip beside the label, after the words _best if you want_ — never a technical word such as "axis", because the person picking may not be technical (second review, 2026-09-21). The port keeps the frame's shipped floor (12.25rem), ceiling (34rem, scrolling itself) and **Expand** (MOTIR-5032), so 6+ options scroll inside the port and never push band 3 off screen (Panel 1c).

### Band 3 — SELECT, then COMMIT (Panel 2)

**The decision:** a person selects an option ROW in the port, and band 3 carries ONE commit verb, **Choose {label}**, plus the one refusal, **None of these — revise the options**. Committing opens the frame's shipped inline confirm band.

**Why this satisfies "the verbs are the options themselves".** Each option IS a verb: `choose(optionId)`. A row of N buttons would put the options in TWO places — once in the port with what they are best for and their WHY, once in band 3 as bare names — and a person would press a NAME, which is exactly the guess the best-for line exists to prevent. Selecting presses the option where its reason is written; band 3 then names what will be recorded. The shape is the same at 2 options and at 6, which is what the story's _"a 2-option and a 4-option work item through the same component"_ criterion needs.

- **Before a pick, Choose is drawn DISABLED with its reason as the consequence line** (_"Pick an option above to choose it."_, Panel 1a). That is the frame's shipped honest-disabled rule (`GateVerb.disabled`, MOTIR-5678), not a new one.
- **A long label truncates inside the button** (`max-w-[16rem] truncate`); the row it names is always visible above it. At ~400px the verbs wrap below the consequence line, as every kind's do (Panel 2b).
- **None of these does not confirm**, like the shipped _Request changes_: it is reversible — the reporter revises the options and the question is asked again.

### States

| state                                           | panel   | what renders                                                                                                                                            |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** awaiting, yours, nothing picked           | 1a      | port live; _Choose_ disabled with its reason                                                                                                            |
| **A** awaiting, yours, picked                   | 1b · 1c | the picked row accent-bordered; _Choose {label}_ live                                                                                                   |
| **C** confirming                                | 2a      | the shipped inline band: _Choosing this will:_ — record {label} (best if you want {bestFor}), move to Done, leave the follow-up owed                    |
| **D** recording                                 | —       | the shipped frame, unchanged                                                                                                                            |
| **B** read-only                                 | 4       | port live, rows WITHOUT radios (not disabled ones), band 3 is _Waiting on {name}._                                                                      |
| **E** chosen                                    | 5a      | the pill **Chosen** (mint); the chosen row carries the accent `circle-check` glyph and a **Chosen** pill; other rows NOT dimmed; the record strip below |
| **F** None of these                             | 5b      | the shipped **Changes requested** pill; the record's last line is the kind's _the options will be revised_                                              |
| **G** withdrawn                                 | —       | the shipped frame words; the cause is `republished` (the ADR's point 3)                                                                                 |
| **H** stale                                     | 5c      | the shipped `approval-control--stale-refusal.mock.html` treatment, reused: _The options changed while you were reading._                                |
| **Why this is a choice** — the three situations | 1d      | the section alone, once per situation                                                                                                                   |
| **defect** — no gate                            | 3       | NOT a frame: the **Choice** section with a _Can't be decided yet_ pill, the reason callout, and the options as parsed, read-only; no band 1, no band 3  |

**The record (Panel 5a) is read from `chosenOption`, never from the body.** The frame's `recordLead` is _Chosen by {name} · {when}_; its `recordDetail` is _Chose_ + the label pill + its best-for chip, and **Follow-up planning owed — {what this choice gates}**. The version is the shipped `subjectVersion` line. Every word survives a later edit to the body, which is the story's _"readable months later without re-reading the body"_.

**The defect state (Panel 3), one per reason — seven since the review.** No gate is raised, so there are no verbs anywhere. `option_without_best_for` NAMES the option and flags its row with a `circle-alert` line; `unknown_situation` QUOTES the value it could not read; the others state the reason in the callout. Every reason ends with the same sentence: nobody can choose until the description is fixed, and the question is asked as soon as it reads complete.

### Copy — every new string, en and zh

| key                                                       | en                                                                                                                        | zh                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `approvalGate.choice.kindLabel`                           | Choice                                                                                                                    | 选择                                                                                                        |
| `approvalGate.choice.meta`                                | {count, plural, =1 {# option} other {# options}}                                                                          | {count} 个选项                                                                                              |
| `approvalGate.choice.question`                            | Question                                                                                                                  | 问题                                                                                                        |
| `approvalGate.choice.options`                             | Options · {count}                                                                                                         | 选项 · {count}                                                                                              |
| `approvalGate.choice.bestIfYouWant`                       | best if you want                                                                                                          | 如果你更看重                                                                                                |
| `approvalGate.choice.gates`                               | What this choice gates                                                                                                    | 此选择决定的后续工作                                                                                        |
| `approvalGate.choice.verb.choose`                         | Choose {label}                                                                                                            | 选择「{label}」                                                                                             |
| `approvalGate.choice.verb.chooseEmpty`                    | Choose                                                                                                                    | 选择                                                                                                        |
| `approvalGate.choice.verb.noneOfThese`                    | None of these — revise the options                                                                                        | 都不合适 — 修改选项                                                                                         |
| `approvalGate.choice.consequence.pick`                    | Pick an option above to choose it. Choosing moves {key} to Done.                                                          | 请先在上方选中一个选项。选择后，{key} 将移至“已完成”。                                                      |
| `approvalGate.choice.consequence.picked`                  | Choosing moves {key} to Done and leaves a follow-up planning pass owed.                                                   | 选择后，{key} 将移至“已完成”，并留下一轮待进行的后续规划。                                                  |
| `approvalGate.choice.confirm.title`                       | Choosing this will:                                                                                                       | 选择此项将会：                                                                                              |
| `approvalGate.choice.confirm.record`                      | Record {label} (best if you want {bestFor}) as the answer.                                                                | 将「{label}」（如果你更看重：{bestFor}）记录为答案。                                                        |
| `approvalGate.choice.confirm.done`                        | Move {key} to Done.                                                                                                       | 将 {key} 移至“已完成”。                                                                                     |
| `approvalGate.choice.confirm.followUp`                    | Leave a follow-up planning pass owed: {gates}.                                                                            | 留下一轮待进行的后续规划：{gates}。                                                                         |
| `approvalGate.choice.confirm.proceed`                     | Yes, choose {label}                                                                                                       | 是，选择「{label}」                                                                                         |
| `approvalGate.choice.state.chosen`                        | Chosen                                                                                                                    | 已选择                                                                                                      |
| `approvalGate.choice.record.lead`                         | Chosen by {name} · {when}                                                                                                 | 由 {name} 选择 · {when}                                                                                     |
| `approvalGate.choice.record.chose`                        | Chose                                                                                                                     | 选择了                                                                                                      |
| `approvalGate.choice.record.followUp`                     | Follow-up planning owed — {gates}                                                                                         | 待进行后续规划 — {gates}                                                                                    |
| `approvalGate.choice.record.willRevise`                   | the options will be revised                                                                                               | 选项将被修改                                                                                                |
| `approvalGate.choice.cta.body`                            | Review the options full screen, then choose one.                                                                          | 全屏查看选项，然后选择一个。                                                                                |
| `approvalGate.choice.cta.button`                          | Review & choose                                                                                                           | 查看并选择                                                                                                  |
| `approvalGate.choice.defect.title`                        | Can't be decided yet                                                                                                      | 暂时无法决定                                                                                                |
| `approvalGate.choice.defect.fewer_than_two_options`       | This choice lists only one option. A choice needs at least two.                                                           | 此选择只列出了一个选项。一个选择至少需要两个选项。                                                          |
| `approvalGate.choice.defect.option_without_best_for`      | “{label}” says what it is, not when it is the best pick. Every option needs a Best if you want: line.                     | 「{label}」只说明了它是什么，没有说明什么情况下最该选它。每个选项都需要一行 Best if you want:。             |
| `approvalGate.choice.defect.duplicate_option`             | Two options are both called “{label}”. Give each a distinct name.                                                         | 有两个选项都叫「{label}」。请为每个选项取不同的名字。                                                       |
| `approvalGate.choice.defect.no_follow_up_section`         | This choice doesn't say what it gates. Add a “What this choice gates” section naming the work that follows.               | 此选择没有说明它决定哪些后续工作。请添加 “What this choice gates” 一节，写明接下来的工作。                  |
| `approvalGate.choice.why`                                 | Why this is a choice                                                                                                      | 为什么这是一个选择                                                                                          |
| `approvalGate.choice.situation.contradicts_your_decision` | Research contradicts your decision                                                                                        | 调研结果与你的决定相矛盾                                                                                    |
| `approvalGate.choice.situation.better_than_your_decision` | A better option than your decision                                                                                        | 有比你的决定更好的选项                                                                                      |
| `approvalGate.choice.situation.two_workflows`             | Your requirement allows two workflows                                                                                     | 你的需求允许两种工作流                                                                                      |
| `approvalGate.choice.youSaid`                             | You said                                                                                                                  | 你说过                                                                                                      |
| `approvalGate.choice.record.askedBecause`                 | Asked because                                                                                                             | 提问原因                                                                                                    |
| `approvalGate.choice.defect.no_why_section`               | This choice doesn't say why it is a choice. Add a “Why this is a choice” section with a Situation: line.                  | 此选择没有说明为什么需要选择。请添加 “Why this is a choice” 一节，并写一行 Situation:。                     |
| `approvalGate.choice.defect.unknown_situation`            | “{value}” is not one of the three situations. Use contradicts your decision, better than your decision, or two workflows. | 「{value}」不是三种情形之一。请使用 contradicts your decision、better than your decision 或 two workflows。 |
| `approvalGate.choice.defect.no_quoted_decision`           | This choice debates a decision you made but doesn't quote it. Add a You said: line.                                       | 此选择在讨论你做过的决定，但没有引用它。请添加一行 You said:。                                              |
| `approvalGate.choice.defect.fix`                          | No one can choose until the description is fixed; the question is asked as soon as it reads complete.                     | 在描述修正之前，任何人都无法选择；描述完整后会立即发起提问。                                                |
| `approvalGate.choice.defect.flag`                         | Missing — add a Best if you want: line                                                                                    | 缺少 — 请添加一行 Best if you want:                                                                         |
| `approvalGate.choice.stale`                               | The options changed while you were reading.                                                                               | 你阅读期间选项已更改。                                                                                      |
| `workbench.approvals.choiceMeta`                          | {count} options · {question}                                                                                              | {count} 个选项 · {question}                                                                                 |
| `workbench.approvals.choiceDecided`                       | Chose {label} · {bestFor}                                                                                                 | 选择了「{label}」· {bestFor}                                                                                |
| `workbench.approvals.choiceNoneChosen`                    | {count} options · none chosen                                                                                             | {count} 个选项 · 未选择                                                                                     |
| the type label (`workItemType` catalogue)                 | Choice                                                                                                                    | 选择                                                                                                        |

The Markdown headings and keys the parser reads (`## Question`, `## Why this is a choice`, `**Situation:**` and its three values, `**You said:**`, `## Options`, `**Best if you want:**`, `## What this choice gates`) are STRUCTURE, not copy, and are not translated — which is why the zh defect strings name them in English. An option's label, what it is best for and its WHY are authored text and render as written.

### Tokens

- **`--el-type-choice: var(--color-charcoal)`** — added to `packages/design-system/theme.css`'s `[data-appearance-scope]` block beside `--el-type-decision` (declared there, not on `:root` alone, so it re-resolves in a dark scope; the rows mock's first draft declared it on `:root` and its dark glyph went invisible). It shares charcoal with `decision` and `legal` — the Govern precedent, _hue names the family; the glyph names the member_ — and gets its OWN token.
- **Glyph:** lucide `signpost`, EXTRACTED from the installed `lucide-react` (the sprite audit checks it).
- Everything else composes shipped tokens: `--el-tint-lavender` (the situation chip), `--el-tint-sky` (the best-for chip), `--el-tint-mint` (Chosen), `--el-tint-peach` (the defect callout and pill, the stale alert), `--el-accent` (the selected row and radio), `--el-accent-on-surface` (the chosen glyph — a graphic, 3:1), `--el-danger-on-surface` (the defect flag line). No `--el-text-muted` on a tinted surface and no `--el-text-faint` on text.

### TAKES — three things this kind needs from the shipped frame

1. **The confirm band's title is approve-specific** (`approvalGate.confirm.title`, _"Approving this will:"_). A choice needs _Choosing this will:_. → The title becomes kind-supplied (a `confirmTitle` beside `confirmConsequences`).
2. **The changes-requested record line is agent-specific** (`record.willRepublish`, _"the agent will publish a new version"_), rendered unconditionally on `changes_requested`. False for a choice, whose reporter revises the options. → Kind-supplied, with the shipped words as the default.
3. **Band 3 keys its verbs by `verb.decision`.** With select-then-commit there is ONE `choose` verb, so no collision arises. A future kind that renders several verbs sharing one `decision` must key by the verb's identity.

### GIVES / TAKES — who builds what

| element                                                                                                                                                                                                                                           | built by       | note                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the port (question, option rows, best-for chip, gates box), band 3 (select-then-commit, the disabled-with-reason verb, the confirm), states A–H, the defect state, the record strip, the item page's **Choice** section and its band, the overlay | **MOTIR-5896** | plus the three TAKES above, and the en + zh strings under `approvalGate.choice.*`                                                                                        |
| the decision-waiting marker's destination for `decision_choice` — the **Choice** section                                                                                                                                                          | **MOTIR-5896** | MOTIR-4908's marker maps each gate kind to the section it scrolls to (`decision-waiting.mock.html`); the fifth kind's row is the Choice section, which only 5896 renders |
| the To-approve row and the Approvals-room rows                                                                                                                                                                                                    | **MOTIR-5897** | renders inside the overlay's door; the strings under `workbench.approvals.choice*`                                                                                       |
| the `choice` type chip, its glyph, `--el-type-choice`, its place in the picker, and the type label                                                                                                                                                | **MOTIR-5890** | the chip renders inside the rows' and the item header's type slot                                                                                                        |
| the parser's defect reasons — seven, including the three for the Why section (the words the defect state renders)                                                                                                                                 | **MOTIR-5891** | the reason codes are the ADR's; the words are this section's                                                                                                             |
| the `choose` verb on the decide door                                                                                                                                                                                                              | **MOTIR-5893** | the port's select-then-commit sends `{ decision: 'choose', optionId }`                                                                                                   |

### Checked against the siblings

`git grep -c -e decision_choice -e choice origin/main -- design/work-items/ design/workbench/` returns 12 files. Every hit but three is the English word in prose (_"a style choice"_, _"View choice is URL-driven"_). The three that are about this kind:

- `design/work-items/approval-control.mock.html:2260` — the frame's sentence that a choice gate's N options reach the same band. Honoured: band 3 is the frame's.
- `design/work-items/design-notes.md:6647` and `:6657` — the frame's GIVES/TAKES rows allocating the option rows, their named axes (here: what each option is best for) and the stamp to MOTIR-4914. This section is that allocation.

No sibling asset draws a choice row, so nothing here is redrawn and nothing elsewhere needs a pointer.

## ⭐ The DIFFICULTY field — how hard a leaf is to reason about, on the item page, the quick view and the filter builder (Story MOTIR-6016 · MOTIR-6097 — `core-fields--difficulty.mock.html` + `filter-builder--difficulty.mock.html`, DATED 2026-09-23)

**What it is.** A leaf (task · subtask · bug) carries a difficulty of `low` · `medium` · `high`, or none (`WorkItemDifficulty`, `lib/issues/difficulty.ts`, MOTIR-6096). Epics and stories never carry one — the service refuses it with `DIFFICULTY_NOT_ALLOWED_ON_KIND`. Every leaf that existed before this story is unset, and nothing guesses a value.

**Two delta mocks; the bases are records and are not edited.**

- `design/work-items/core-fields--difficulty.mock.html` amends `design/work-items/type-executor-picker.mock.html` (the core-fields rail, its panel 3) and `design/work-items/quick-view.mock.html` (the quick-view rail).
- `design/work-items/filter-builder--difficulty.mock.html` amends the builder's condition rows drawn in `design/work-items/placement.mock.html` (panel 5, the Folder row, MOTIR-5374).

### The treatment — a label, never a colour

The value is a plain label with a **quiet signal glyph** (lucide `signal-low` / `signal-medium` / `signal-high`) in `--el-text-faint`, `aria-hidden`. There is **no pill and no hue**, on purpose: Priority shares the words _Medium_ and _High_ and owns a coloured pill, so a coloured difficulty would read as a second priority. The glyph's bar count carries the scale for a reader who scans.

| state                         | item page (`FieldCard`)                                                                       | quick view (`EditableRailField`)                                |
| ----------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| unset                         | the dashed **Set difficulty** affordance — the same one an untyped leaf's **Set a type** uses | **None** in `--el-text-secondary`, as Type and Executor show it |
| trivial · low · medium · high | glyph + label in `--el-text`                                                                  | glyph + label in the rail's `--el-text-secondary`               |
| editing                       | the card's chevron turns; a three-option **`Segmented`** plus a **Clear** text button         | the same `Segmented` + **Clear**, inline in the rail            |
| cleared                       | back to **Set difficulty**                                                                    | back to **None**, with the rail's shipped _Saved_ tick          |
| read-only viewer              | `FieldCard editable={false}` — the value, no chevron                                          | the value, no chevron, no picker                                |
| container (epic / story)      | **absent** — no card, no empty slot, no disabled control                                      | **absent**, by the same `isTypeableKind` guard Work type uses   |

**Why a `Segmented` and not a `Combobox`.** Three ordered values fit one row, and `Segmented` is already how the Executor control is edited (`components/issues/ExecutorPicker.tsx`), so the two neighbouring fields edit the same way. The `Segmented` has no empty member, so **Clear** sits beside it rather than inside it — a person clears on purpose, and there is no fourth "None" segment to press by accident.

**Placement.** Directly below **Executor** on both surfaces, inside the same `isTypeableKind(kind)` branch that renders Work type and Executor — so the leaf-only rule is the rendering rule, not a second check. Unlike Executor it does **not** wait for a type: a leaf with no type can still have a difficulty.

**The activity entry** is the shipped `ActivityEntryRow` unchanged: _Mo changed the **Difficulty**_ with the struck old value → new value. The field NAME is localised (`activity.fields.difficulty`, MOTIR-6096); the VALUES are the stored keys (`medium → high`), exactly as Executor's are today (`coding_agent → human`). Localising activity values is a feed-wide question, not this field's, and is not drawn here.

### The filter row

Difficulty is a **nullable closed enum**, so it takes the registry's nullable-enum operator set — the four Work type offers (`lib/filters/registry.ts`): **is any of** · **is none of** · **is empty** · **is not empty**, labelled by the shipped `issueViews.advancedOpIs*` strings. It joins the field menu's **Fields** group directly after **Work type**. The value listbox lists the three values easiest first, multi-select, each with the same faint signal glyph. The applied summary chip reads _**Difficulty** is any of Medium, High_. The board's filter control mounts the same builder, so one row serves the list and the board.

### Composed primitives

`Card` (via the item page's `FieldCard`), `Segmented` (`packages/design-system/src/components/ui/Segmented.tsx`), the quick view's `QuickViewRailField` / `EditableRailField`, the builder's `Combobox` rows and multi-select value box (`FilterConditionBuilder.tsx`), and lucide icons. Colour only through `--el-*` (`--el-text`, `--el-text-secondary`, `--el-text-muted` on white only, `--el-text-faint` on glyphs only, `--el-tabnav-track` / `--el-tabnav-active` for the `Segmented`, `--el-border` / `--el-border-strong`, `--el-success` for the saved tick); shape through the radius / spacing / height tokens. `grep -- '--color-'` over both mocks returns nothing.

### Access paths

- **Item page** — any row in the List, the Tree or the Board opens `/items/<KEY>`; the field sits in the right-hand core-fields rail.
- **Quick view** — a row click in the List, or a card click on the Board, opens the quick view; the field sits in its rail.
- **Filter builder** — the List's **Advanced** filter button, or the Board's filter control, opens the builder; **Add condition** → **Difficulty**.

### Strings (en · zh)

Already in both catalogues (MOTIR-6096): `activity.fields.difficulty` _Difficulty · 难度_, `labels.difficulty.{low,medium,high}` _Low · 低, Medium · 中, High · 高_. **New, owed by the builders:** the field label on the item page and the quick view (_Difficulty · 难度_), **Set difficulty · 设置难度**, the `Segmented`'s aria-label, and the builder's field label `issueViews.advancedFieldDifficulty` (_Difficulty · 难度_). **Clear · 清除** reuses the shipped word.

### GIVES / TAKES — who builds what

| element                                                                                                                                                                                          | built by       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| the item page's Difficulty `FieldCard` (every state above), the quick view's rail field (every state), the `Segmented` + Clear editor, the absence on an epic / story, and their en + zh strings | **MOTIR-6101** |
| the builder's Difficulty field-menu entry, its four operators, the value listbox, the applied summary chip on the List and the Board, and `issueViews.advancedFieldDifficulty` in en + zh        | **MOTIR-6100** |
| the activity entry — nothing to build; MOTIR-6096 already registered the field and its label                                                                                                     | —              |

**Not drawn, and owed by nobody:** a List column or a Board-card badge (the story asks for a filter), the plan review's rendering of a proposed difficulty (the sibling planner story, MOTIR-6095), and any model-choice UI.

## ⭐ The RE-PLAN WITH AI door on the three decided record bands (Story MOTIR-6068 · MOTIR-6206 — `approval-control--replan-door.mock.html`, DATED 2026-09-25)

**Asset:** `design/work-items/approval-control--replan-door.mock.html`, a **DELTA** in six panels, 0 to 5 (en and
zh, light and dark). It amends MOTIR-6073's published
`work-items/approval-control--refusal-reason.mock.html`, which quotes the reason on a decided record.
It also amends the decision-confirm record, `OverturnedBand` in
`components/approvals/DecisionConfirmGate.tsx:351-400`. **Neither is edited.** Only the decided band
changes. The planner the door opens is drawn in `design/ai-chat/planning-workspace--refusal-seed.mock.html`,
whose notes hold the first-turn contract.

**The contract.** `docs/decisions/approval-gates.md` §10f: _"a decided record keeps a door to it: the
record band of a refused gate that offers the planner shows **Re-plan with AI**, which opens the same
seeded turn."_ The door appears on the three §10h rows that open the planner always:

- `decision_approval` · `changes_requested`
- `decision_choice` · `changes_requested` (None of these)
- `decision_confirmation` · `overturned`

MOTIR-6211 builds it.

Paths to published results that are not in this checkout are given relative to `design/` (for example `ai-chat/planning-workspace--resume.mock.html`). They are the results' `sourcePath`s and have not landed here.

**Composed from.** The stylesheet is lifted verbatim from MOTIR-6073's published
`approval-control--refusal-reason.mock.html`. The frame head, the port note, the record strip and the
quoted reason are that asset's panel 4 markup. The overturned record mirrors `OverturnedBand` class for
class: the note, the **Re-plan owed** chip and its detail, and the `SupersededChip`s. The door is
`WorkItemPlanEntrance`'s re-plan face (`components/planning/WorkItemPlanEntrance.tsx`). The overlay
band is the same `RecordStrip`, un-sectioned, following MOTIR-6073's
`workbench/approval-overlay--refusal-reason.mock.html`. The styles use `--el-*` tokens only, plus
`--spacing-btn-x-sm` as `packages/design-system/theme.css` defines it, because the lifted sheet scopes it
to a style preset.

### The panels

0. **Just decided: the band ASKS (amended 2026-09-25).** This panel is the one source for this state.
   It shows the ask in the decided band on the item page and in the approval overlay, for all three
   kinds, in en and zh and in dark. It also shows the state after **Not now**: the record with its
   door, and focus on the door.
1. **The item page.** Each of the three kinds shows its decided band with the reason quoted as before
   and **Re-plan with AI** at the foot. For the overturn, the band as it ships today is drawn beside
   it, with the plain epic `WorkItemPlanEntrance` line struck through. That line is what this card
   removes.
2. **Inside the approval overlay.** The same three bands, un-sectioned, with the same door.
3. **Where the door is not drawn:** a `pull_request_approval` Request changes, a viewer who may not
   plan, and an approved decision.
4. **One label with two outcomes.** The door writes the address, and the seed read decides between a
   new conversation and a resumed one.
5. **zh, and dark.**

### The decisions

- **ONE label, _Re-plan with AI_, in every case. The planner decided this, and this section records
  it.** The band never reads whether a seeded session exists. The overlay the door opens resumes the
  viewer's recent seeded session by itself, through the seed read's `seededSessionId` (MOTIR-6208). If
  there is none, it seeds a new conversation. This keeps any per-render session read out of the band,
  leaves one label to test, and means the band cannot say _Continue_ for a session that expired after
  the page rendered.
- **The door is the Re-plan entrance's own face.** It has the badge radius, `--el-border-strong`,
  `--el-text-secondary` ink, the `Sparkles` glyph, `h-(--height-btn-sm)` and `px-(--spacing-btn-x-sm)`,
  as `WorkItemPlanEntrance` draws `data-mode="replan"`. It does not use the accent outline of **Plan**,
  because it edits work that already exists. It sits on its own line, `basis-full`, after the quote, in
  the band's `recordDetail` slot. On the overturn it goes after the supersedes chips.
- **Overturned: the plain epic entrance is REMOVED, and nothing else changes.** The
  `WorkItemPlanEntrance itemKey={epic.key}` line and its `{epic.title} ({epic.key})` caption
  (`DecisionConfirmGate.tsx:382-396`) are replaced by the door. The **Re-plan owed** chip, its
  _"for the work this decision superseded — nothing has changed yet"_ line and every supersedes chip
  stay exactly as they are. The door opens the planner on the **decision work item, seeded**, with the
  supersedes keys already in the turn. The old entrance opened it on the epic, blank.
- **The same door on the item page and in the approval overlay.** The overlay renders the same
  `ApprovalGateControl` in its fill layout, so nothing overlay-specific is drawn. **The door is itself
  a yes.** Pressing it opens the planner directly, with no second ask: it strips the approval address
  and opens the planner in one replace (the `refusal-seed` delta, sheet 1). The approval overlay does
  not stay underneath.
- **Right after a refusal, the band ASKS before anything opens (amended 2026-09-25).** The design gate
  came back CHANGES REQUESTED. The reviewer's note, verbatim, is: _"Let the user confirm he wants to
  go to motir AI to replan the work item."_ So the planner no longer opens when the decision is
  recorded. The just-decided band shows, in the door's place, _"Re-plan {key} with Motir AI?"_, two
  consequence lines, **Not now** (ghost) and **Re-plan with AI** (primary, the door's own label).
  - **The form.** It is the shipped confirm band's grammar: `ApprovalGateControl`'s `confirming`
    phase, _"an inline band over the verbs, never a modal"_, with `--el-surface-soft`, the 13px title
    and the list. `components/ui` has no confirm-dialog primitive, and in the approval overlay a
    dialog would stack a modal on a full-screen modal.
  - **Keyboard and focus.** Focus goes to **Re-plan with AI**, so Enter means yes. Esc means Not now.
    In the overlay it declines only, and the overlay stays open.
  - **Not now.** The ask becomes the door, and focus moves to the door.
  - **Transient.** The ask is shown once, to the person who pressed. A reload, another viewer or a
    later visit sees only the door.
  - **Copy.** The copy table is in `design/ai-chat/design-notes.md` §"The amendment of 2026-09-25".
    en: _Re-plan {key} with Motir AI?_ · _Not now_ · _Re-plan with AI_. zh: _用 Motir AI 重新规划
    {key}？_ · _暂时不用_ · _用 AI 重新规划_.
- **Absent means absent.** The door does not render on `approved`, `awaiting` or `superseded`, or for
  `pull_request_approval`, `design_result` or `acceptance_result`. The last two get their own verdicts
  in MOTIR-6070 and MOTIR-6071. It also does not render where `WorkItemPlanEntrance` would not
  (`canPlan`, archived). There is no disabled door and no explanation.

### Copy

| key (suggested; MOTIR-6211 owns the namespace) | en                                         | zh                                  |
| ---------------------------------------------- | ------------------------------------------ | ----------------------------------- |
| `approvalGate.replanDoor.label`                | `Re-plan with AI`                          | `用 AI 重新规划`                    |
| `approvalGate.replanDoor.aria`                 | `Re-plan {item} with AI from this refusal` | `根据这次拒绝用 AI 重新规划 {item}` |

The zh label joins `planWithAI`'s _用 AI_ with the entrance's _重新规划_, so it reads as the Re-plan entrance
it replaces. The accessible name names the work item and contains the visible text (WCAG 2.5.3), as the
entrance's `replanAria` does.

### GIVES / TAKES

- **MOTIR-6211** — **TAKES _"open it the moment the decision commits"_**, and GIVES the ask
  (panel 0) in its place. The exact amended wording for MOTIR-6211, MOTIR-6068 criterion 1 and the
  MOTIR-6213 E2E step is in `design/ai-chat/design-notes.md` §"The amendment of 2026-09-25".
- **MOTIR-6211** also gets the door's face, label, placement and absence rules on all three bands, on both
  hosts, and the overturned band's entrance swap. Its criteria match this delta, and nothing is taken
  away from them.
- **MOTIR-6210** is not affected by the band. The one-label rule relies on its seed read resolving
  `seededSessionId`, which its criteria already cover.
- **MOTIR-6208** gets nothing and loses nothing. It supplies `seededSessionId`, which the one-label
  rule depends on.
- **MOTIR-6209** is not affected.

Referenced for provenance only: MOTIR-5956 (Overturn and the owed re-plan), MOTIR-6067, MOTIR-6069,
MOTIR-6070, MOTIR-6071, MOTIR-6072, MOTIR-6073. `ACME-30`, `ACME-38`, `ACME-39`, `ACME-41`, `ACME-42`,
`ACME-44`, `ACME-47` and `ACME-51` are sample keys.

---

## ⭐ The status control says a PLAN holds it — every move locked while an undecided plan rewrites the card (Story MOTIR-6017 · MOTIR-6263 — `status-held-by-decision--plan-hold.mock.html`, DATED 2026-09-25)

**A DELTA of § _The status control says so_** (MOTIR-5523,
`status-held-by-decision.mock.html`). That asset is a RECORD and is not edited: it still draws
exactly what it drew, for a move held by an APPROVAL GATE. This section adds the case where the
card is held by an **undecided PLAN**, and the delta mock holds only the panels that change.

**The rule it depicts** is `docs/decisions/agent-authored-plans.md` **AMENDMENT 21**: a work item is
HELD when its status is `planning`, a `plan_target_lock` row names it with a non-null `planId`, and
that plan is `generating`, `planned` or `stale`. Every non-system move out is refused with
`PLAN_TARGET_HELD`.

### What DIFFERS from the gate-held state — the three things a builder cannot infer

1. **A gate holds ONE status; a plan holds EVERY move.** So the dropdown shows **every** option
   disabled and tagged, not one. This is the largest visible difference and it is what panel 1b is
   for: there is no move left to offer, because the plan owns all of them.
2. **The door is _Review plan_, never _Review & approve_**, and it goes where
   `planRowDestination` (`lib/planning/planDestination.ts`, MOTIR-6043) sends the plan — the
   **planning surface** for a plan with a session, **`/plans/<id>`** for one without. It **never**
   opens the approval overlay (`docs/decisions/approval-gates.md` §11.5b). The glyph is `Sparkles`,
   the icon the product already uses for Motir AI (`components/planning/PlanWithAILauncher.tsx`),
   rather than the gate's `ScanEye` — the two doors go to different places and should not look
   identical.
3. **The box carries TWO lines, not one.** The refusal is constant; the second line says what the
   plan is DOING, because that is what tells a reader how long this lasts and whether it is waiting
   on them.

### The panels

| #      | state                                          | what it settles                                                                                  |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1 · 1b | plan `generating`                              | the closed control, then the dropdown with **every** option locked                               |
| 2      | plan `planned`                                 | waiting for approval; same door, second line changes                                             |
| 3      | plan `stale`                                   | `stale` is UNDECIDED so it still holds (AMENDMENT 21 §1) and its lock no longer expires (§4)     |
| 4      | plan with **no session**                       | `planRowDestination`'s `no-conversation`: the door opens `/plans/<id>`. The COPY does not change |
| 5      | **not held** — a planning SESSION with no plan | the ordinary control, no box. Drawn so the builder adds no line where none belongs               |
| 6      | plan **and** an `awaiting` gate                | both lines render, plan FIRST, gate line with no button                                          |
| 7      | a reader who cannot edit                       | the line **and** the door still show                                                             |
| 8      | the `/items` row                               | the anchored refusal, in place of the snap-back toast — the ACCESS PATH from the list            |
| 9      | the quick view at its narrowest                | the box wraps and the door drops to its own line; no separate rule needed                        |

Every panel is drawn in **en and zh**.

### The two things nobody had drawn, decided here with their reasons

**(a) A plan AND a gate both holding — BOTH lines render, the plan FIRST, and only the plan line
carries a button.** The two genuinely coexist, though not by a gate surviving the park: parking a
card from In Review CLOSES its `awaiting` gate (AMENDMENT 16 D3, as corrected by MOTIR-6339). A gate
can be raised on a held card afterwards, by any reconcile that re-derives it, and AMENDMENT 21 §6
names the pull-request reconcile as one. The panel's own label, _"AMENDMENT 16 D3 keeps the gate"_,
is the mock's record of the premise it was drawn on and is left as drawn. They are two different
refusals with two different destinations, so saying only one would leave a reader who resolves it still stuck. The plan goes first because it is the wider
hold — it owns every move, the gate owns one — and because **deciding the gate is itself refused
while the plan holds** (AMENDMENT 21 §6). That is why the gate line here has **no** _Review &
approve_ button: it would be a door onto a refusal. Its sentence says instead that it can be decided
once the plan is. The two lines use the shipped component's own `<hr>`-separated multi-line form
(`StatusHeldNotice`), so this needs no new container.

**(b) A reader who cannot edit sees the line AND the door.** The base asset withholds the button
from a see-only reader, correctly — that button DECIDES. **This one does not decide anything: it
goes and looks.** The planning surface is a READ surface as much as a decide one (§11.5b hosts the
conversation beside the plan), and a reader who cannot edit still has the question the line answers:
_why is this card stuck?_ Withholding the door would leave them told a plan exists with no way to
see it. The control itself is already read-only for them; nothing about the hold changes that.

### The copy, and the string keys the code card writes

Written by **MOTIR-6267**, under `approvalGate.statusHeld` beside the gate's existing keys:

| key                    | en                                                                                              | zh                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `planHeld`             | Status can't be changed while a plan is open.                                                   | 计划未决定前无法更改状态。                                            |
| `planState.generating` | Motir AI is still writing this plan.                                                            | Motir AI 正在撰写该计划。                                             |
| `planState.planned`    | This plan is waiting for approval.                                                              | 该计划正在等待审批。                                                  |
| `planState.stale`      | This plan needs attention before it can be approved.                                            | 该计划需要先处理，然后才能批准。                                      |
| `reviewPlan`           | Review plan                                                                                     | 审阅计划                                                              |
| `planHeldOption`       | held by plan                                                                                    | 计划占用中                                                            |
| `planAndGate`          | A <strong>{decision}</strong> is waiting on this card too — it can be decided once the plan is. | 该卡片还有一项<strong>{decision}</strong>在等待——计划决定后才能处理。 |

`reviewPlan` deliberately reuses the wording already shipped in
`approvalGate.planApproval.row.reviewRow` (_"Review plan — {sentence}"_ / _"审阅计划 — {sentence}"_),
so the To-approve row and this door name the same act with the same words. `planAndGate` takes
`{decision}` from the existing `decisionNoun` map rather than introducing a second vocabulary for
gate kinds.

### What the code composes — reuse, do not redraw

- **`components/issues/StatusHeldNotice.tsx`** — the box, verbatim: `rounded-(--radius-control)`,
  `border-(--el-border-soft)`, `bg-(--el-tint-yellow)`, `px-(--spacing-control-x)`
  `py-(--spacing-control-y)`, a `Lock` glyph at `h-3.5 w-3.5`, one 13px `leading-snug` line per
  entry and an `<hr>` between entries. A plan line is a new line SHAPE in this component, not a new
  component.
- **`components/issues/useStatusHeld.ts`** — the hook the item page, quick view and edit page share.
  A plan hold is seeded from the same server read and folded forward by the same refusal path.
- **`components/issues/heldRefusal.ts`** — the anchored form panel 8 draws, and `readHeldRefusal`'s
  `code` branch, which gains `PLAN_TARGET_HELD` beside `APPROVAL_GATE_PENDING`.
- **`--el-status-planning`** (`packages/design-system/theme.css`, `var(--color-accent-teal)`) is the
  Planning dot and pill hue. The base mock predates the Planning status and does not define it; the
  delta adds the token from the shipped theme rather than picking a colour.

### Grounding, and one honest limit

The delta's stylesheet and icon sprite are the base mock's, carried over **verbatim**, so the two
assets cannot drift; the shipped component markup above was read at `origin/main` `7f74fba8e` rather
than reconstructed. The asset was rendered headlessly in both themes and every panel inspected.

**The limit:** the render used DejaVu / Noto substitutes, because `--font-sans`'s
`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto` are not installed on the box that drew it.
That stack is copied unchanged from `app/globals.css` and from the base mock, and is not this card's
to change. The substitute is WIDER than the real face, so every box that fits in the render fits in
the product — the check is conservative, not optimistic.

### Not drawn here, and owed by whom

| surface                                                                         | owner                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------- |
| the item page, quick view and edit page status control, and its en + zh strings | **MOTIR-6267**                                    |
| the board card's refusal and the `/items` inline-edit refusal in place          | **MOTIR-6268** (composing this section's panel 8) |
| the board card's own anchored refusal drawing                                   | **MOTIR-6264**, the board-design delta            |
| the planning surface and the plan page the door LANDS on                        | already shipped — MOTIR-6012, MOTIR-6043          |

## ⭐ The picked option planned — the ASK after a Choose and the PLAN WITH AI door on the chosen record (Story MOTIR-6069 · MOTIR-6432 — `approval-control--pick-plan.mock.html`, DATED 2026-09-26)

**Asset:** `design/work-items/approval-control--pick-plan.mock.html`, a **DELTA** in five panels, 0 to 4
(en and zh, light and dark). It amends two published bases, and **edits neither**:

- MOTIR-6206's `design/work-items/approval-control--replan-door.mock.html` — panel 0 (the ask) and
  panels 1–5 (the door);
- MOTIR-4914's `design/work-items/approval-control--choice.mock.html` — panel 5a (the chosen record),
  panel 2a (the confirm band) and panel 6 (the access path).

The planning surface the ask starts, and the Plans row of the session it starts, are
`design/ai-chat/planning-workspace--pick-seed.mock.html` (§ _The picked option planned_ in
`design/ai-chat/design-notes.md`).

**The contract.** `docs/decisions/picked-option-planning.md` (MOTIR-6431), which amends
`docs/decisions/approval-gates.md` §10h's `decision_choice · an option chosen` row, and
`docs/decisions/picked-option-planning-starts.md` (MOTIR-6455), which makes the yes START the planning
with the first turn sent (superseding MOTIR-6431's unsent turn). The behaviour each
panel draws is specified by these sibling cards, and this design does not invent it:

- **MOTIR-6431** (the decision record) — the ask after a Choose; the anchor rule: the choice's parent,
  else the nearest not-`done` ancestor, else the project;
- **MOTIR-6433** (the seed read) — the first turn's parts, built from the stamped `chosenOption`;
- **MOTIR-6434** (the session) — the session stamp and the Plans row;
- **MOTIR-6455** (the decision record) — yes starts the planning; the turn is sent once; the yes is
  the consent to spend;
- **MOTIR-6435** (the overlay) — starts the planning on the anchor, or the project, and sends the turn
  once;
- **MOTIR-6436** (the band) — builds this asset: the ask, the door, the confirm and consequence copy.

**Composed from.** The stylesheet is lifted verbatim from `approval-control--choice.mock.html`, and a
second block verbatim from `approval-control--replan-door.mock.html` (the ask's and the door's
utilities). The chosen record is choice panel 5a class for class; the ask is `RefusalReplanAsk`
(`components/approvals/RefusalReplan.tsx`) as replan-door panel 0 draws it; the door is
`WorkItemPlanEntrance`'s **PLAN** face (`components/planning/WorkItemPlanEntrance.tsx`:
`border-(--el-accent) text-(--el-accent-on-surface) hover:bg-(--el-tint-lavender)`), never the subdued
Re-plan face; the overlay head and the item page's **Choice** section are choice panel 6's. Two
additions, both declared in the asset: `.note-inline` (lifted from the seed board) and the PLAN face's
hover, written as the declaration Tailwind v4 produces because no donor sheet carries it. Lines that
change from the base are underlined on the board — a board annotation, not a UI state.

### The panels

0. **Just chosen: the band ASKS.** Right after **Yes, choose**, the chosen record's band asks. 0a is the
   full-screen overlay (`?approval=ACME-42`), anchored on the choice's parent ACME-40, so the line names
   it. 0b is the item page's **Choice** section with a ROOT choice — no open container — so the line
   says _your project_. Both lines say the planner **starts right away**, and the second says there is
   nothing to write or send.
1. **The chosen record on any later visit.** _What this choice gates_ stays as information; the owed
   line becomes the door. 1a: a reader who may plan. 1b: a reader who may not — no door and no ask,
   with no explanation.
2. **After Not now (or Esc).** The ask is replaced by the door, and focus moves to it. Nothing opened,
   and the overlay stays open.
3. **Before the press.** 3a: the consequence line once an option is selected. 3b: the frame's own
   confirm band — only its third line changes.
4. **zh, and dark.**

### The decisions

- **A pick PLANS; it never re-plans.** Every string on a pick is a plan word: the ask's title, its yes,
  the door, the confirm and consequence lines, the composer turn and the Plans row. The Re-plan ask and
  door stay the three refusals', and _None of these_ keeps them unchanged — it is a refusal.
- **Same shapes as the refusal, different words.** The ask is the shipped ask (title, two consequence
  lines, **Not now** ghost, the primary yes focused); the door is the planning entrance. No new
  component is drawn.
- **The yes STARTS the planning, and the ask says so** (MOTIR-6455). The person has already made the
  decision the first turn is built from, so the ask's second line tells them there is nothing to write
  or send, and the yes is their consent to the spend. The refusal ask keeps its _Nothing is sent until
  you send it_ line, because a refusal's turn carries their own reason.
- **The ask names WHERE the planner opens**: the parent's key, or _your project_ when the choice has no
  open container. The anchor itself is resolved on the server (MOTIR-6433), so the ask renders what the
  seed read returns rather than guessing it from the tree.
- **The door has ONE label in every case.** Whether it opens a fresh seeded turn or returns to the
  session the pick already started is the overlay's decision (MOTIR-6435), exactly as on the refusal
  door.
- **The door is the PLAN face, accent-outlined.** A pick opens new work, and the entrance's Plan face
  is the one that says so; the subdued Re-plan face would read as correcting something.
- **_What this choice gates_ stays on the record, as information.** Only the word _owed_ goes: the
  record says what is next, and the door is how to start it.
- **No door without permission.** The door and the ask show only where the reader may plan
  (`canReplan`, `WorkItemPlanEntrance`'s own condition), and their absence carries no explanation —
  as on the refusal door.
- **A GitHub-decided gate asks nothing.** The ask follows a press in Motir only (MOTIR-6436's
  `decisionSource !== 'github'`), as for the refusals.

### The copy (en first, then zh)

| where                                                   | key (suggested)                                                 | en                                                                                             | zh                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ask title                                               | `approvalGate.planAsk.title`                                    | Plan the follow-up with Motir AI?                                                              | 用 Motir AI 规划后续工作？                                                    |
| ask line 1, parent anchor                               | `approvalGate.planAsk.opens`                                    | Motir AI opens on {key} and starts planning the follow-up right away, from your choice.        | Motir AI 会在 {key} 上打开，并立即根据你的选择开始规划后续工作。              |
| ask line 1, project anchor                              | `approvalGate.planAsk.opensProject`                             | Motir AI opens on your project and starts planning the follow-up right away, from your choice. | Motir AI 会在你的项目上打开，并立即根据你的选择开始规划后续工作。             |
| ask line 2                                              | `approvalGate.planAsk.nothingToSend`                            | There is nothing to write or send — your choice is the first message.                          | 无需填写或发送任何内容——你的选择就是第一条消息。                              |
| ask, dismiss                                            | `planningWorkspace.handoff.notNow` (reused, as the shipped ask) | Not now                                                                                        | 暂时不用                                                                      |
| ask, yes                                                | `approvalGate.planAsk.yes`                                      | Plan with AI                                                                                   | 用 AI 规划                                                                    |
| door label                                              | `approvalGate.planDoor.label`                                   | Plan with AI                                                                                   | 用 AI 规划                                                                    |
| door accessible name                                    | `approvalGate.planDoor.aria`                                    | Plan the follow-up to {item} with AI                                                           | 用 AI 规划 {item} 的后续工作                                                  |
| record line (was `record.followUp`)                     | `approvalGate.choice.record.gates`                              | **What this choice gates** — {gates}                                                           | **这个选择决定的工作** — {gates}                                              |
| confirm, third line (was `confirm.followUp`)            | `approvalGate.choice.confirm.askPlan`                           | Ask whether to start planning the follow-up with Motir AI: {gates}.                            | 询问是否用 Motir AI 开始规划后续工作：{gates}。                               |
| consequence, option selected (was `consequence.picked`) | `approvalGate.choice.consequence.picked`                        | Choosing moves {key} to Done, then asks whether Motir AI should start planning what it gates.  | 选择后会把 {key} 移至“已完成”，然后询问是否让 Motir AI 开始规划它决定的工作。 |

The keys are suggestions; MOTIR-6436 owns the catalogue. `record.followUp`, `confirm.followUp` and the
old `consequence.picked` wording are retired by that card.

### Revision — 2026-09-26, after changes requested

The design gate came back **changes requested** (Yue, 2026-09-26): _"The picked option planned UI is not
good, the planner should know the choice has just been made and it's a follow-up planning."_ The first
version opened the planner as an ordinary work-item launch — the generic _in context_ chip and the
generic _What should change — or what would you like to know?_ — and its first turn never said a
choice had just been made. The revision makes the follow-up explicit on the planning surface
(`design/ai-chat/planning-workspace--pick-seed.mock.html`, § _The picked option planned_ in
`design/ai-chat/design-notes.md` → _Revision_), and here only the ask's first line changes: it now says
the planner opens **to plan the follow-up** (the copy table above).

### Revision 3 — 2026-09-26, after changes requested again

The gate came back a second time: _"The planner doesn't need more input from the user, the planning can
start. The user should not need to send an extra message."_ That reversed MOTIR-6431's unsent turn, so it
was re-planned and recorded first (`docs/decisions/picked-option-planning-starts.md`, MOTIR-6455). On
this asset only words change: the ask's two lines say the planner **starts right away** and that there
is **nothing to write or send** (ask line 2 is now its own key, no longer the refusal's reused
_unsent_ line), and the confirm and consequence lines say Motir AI is **asked to start**, not offered.
The planning surface the yes starts is redrawn in `design/ai-chat/planning-workspace--pick-seed.mock.html`
(§ _Revision 3_).

### What this design does NOT draw

- _None of these_ — MOTIR-6206's panels, unchanged.
- The planning surface the yes opens — `design/ai-chat/planning-workspace--pick-seed.mock.html`.
- The options port itself — choice panels 1 and 2, unchanged.

## ⭐ The TO FIX tag and banner: RUN DIED — the fifth reason on the tag, the banner and the filter (MOTIR-6878 — `to-fix--tag-and-banner--run-died.mock.html`, DATED 2026-09-28)

**The asset:** `design/work-items/to-fix--tag-and-banner--run-died.mock.html`, a new delta mock. It
edits no existing mock.

**It AMENDS § _The TO FIX tag and banner — a stuck work item looks stuck wherever it is listed_**
(MOTIR-6608), whose mock is `to-fix--tag-and-banner.mock.html` in this area (`design/work-items/`). **That base section and
that mock live in MOTIR-6608's PUBLISHED design result; neither is committed in this file or in this
repository.** The published result is the design of record (`docs/decisions/design-result.md`
AMENDMENT 5), and this delta's stylesheet is that published mock's style blocks, verbatim, plus a small
delta block (a three-up grid, the story-kind hue, and the Tree row's focus offset and chevron). Every row, card, header and
banner frame is a fragment of that mock's rendered markup, re-keyed.

**It POINTS AT, and redraws neither:** the run-died marker in the Development block (MOTIR-6529,
`design/runs/run-section--run-died.mock.html`, `design/runs/design-notes.md` § _Run died_) and the
Continue hosted control (MOTIR-6789, `design/runs/development--continue-hosted.mock.html`, § _Continue
hosted_). The Workbench row for the same reason is `design/workbench/design-notes.md` **§ 31** (the same
card), which carries the strings table for every key named below.

**Panels:** 1 the List row · 2 the Tree row · 3 the board card · 4 the quick-view header · 5 the item-page
banner, pushed / nothing pushed / parent run · 6 the _To fix_ filter · 7 中文.

### The tag — unchanged in form, a fifth accessible name

`ToFixTag` draws `run_died` exactly as it draws the other four: the solid `--el-danger` disc (List and
Tree, the Status cell) or the `Pill` label (board card, quick-view header), lucide `Wrench`, the words
_To fix_. The reason is only in the accessible name and `title`: **_To fix · run died_**
(`toFix.tagName.run_died`; zh _待修复 · 运行已中断_). The label form's `sr-only` tail is _· run died_. None
of the six `RunDiedReason` endings is named on the tag — they share one repair, and the ending is the
marker's reason line.

**Beside the CI badge, never confused with it (panels 1–3).** A dead run's pull request may well be
green, and on these surfaces a green CI state draws NOTHING (`ciBadgeState`: passing and done draw
nothing, the shipped rule). So each surface is drawn twice:

- **CI green** — no CI glyph at all; the tag is the only signal that the card is stuck. This is the case
  the tag exists for.
- **CI red** — the CI badge (`CircleX` in the rose tint; in the TITLE cell on a row, after the tag in the
  card's pill row) and the tag (the solid fill, in the STATUS cell on a row) both draw, as two different
  kinds of mark in two different places.

The quick-view header shows no CI state, so there is nothing to sit beside; the tag follows the status
pill as for every reason. The card's status is **In Progress** throughout: a dead run never moves it.

**The Tree (panel 2)** is `TreeTable`'s row over the same `buildIssueColumns`, so the leg wears the same
glyph under its expanded parent. The parent carries its own stored reason, never a roll-up of its legs.

### The banner — one sentence, pointing at `#development`, no command

`ToFixBanner` keeps its frame (`--el-danger-surface`, `--el-border-soft`, `--radius-card`), its danger
disc and its `#development` link, and for `run_died` **drops its lead line and its `CopyableCodeBlock`**.
The run-died marker in the Development block already carries `motir continue` and Continue hosted, and
one page must not hold two copies of one control (the rule § _Run died_ applies to the run section).

| variant                                       | sentence (en)                                                                                     | link                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| pushed (`refusal === null`)                   | This needs a fix: its run died, last heard from _12 min ago_, and its work is kept on its branch. | See how to continue it ↓ |
| nothing pushed (`no_branch`)                  | This needs a fix: its run died, last heard from _12 min ago_, before it pushed anything.          | See how to start over ↓  |
| a leg of a parent run (`continue_the_parent`) | This needs a fix: the run of **ACME-12** it was part of died, last heard from _2 hr ago_.         | See how to continue it ↓ |

- **One sentence, naming when the run was last heard from** — `deadRun.lastHeardAt`, relative
  (`relativeLabel`), on a `<time>` whose `title` is the instant. It is `text-sm font-semibold` in
  `--el-danger-surface-text`, as for the four reasons.
- **It points, it does not act.** The link is a real `href="#development"`, with the shipped
  scroll-and-focus that waits for the late stack; only its words change. With nothing pushed it says
  _See how to start over_, because what is below is the marker's start-over line, not a command.
- No meta line: the `affected` clause and _Sent back from the acceptance video_ are pull-request facts.

### The filter — _Run died_ first

The _To fix_ value editor maps over `FIX_REASON_PRIORITY`, and `run_died` is first in it (§ 31 says why),
so **_Run died_ is the first value**. Its label is the Workbench row's bare word through
`FIX_REASON_VALUE_KEYS` (`run_died: 'runDiedBare'` → _Run died_ / _运行已中断_): no new filter string.
Picking it alone, the shipped `AdvancedFilterSummary` chip reads **To fix** _is any of Run died_ — the
card's _To fix is run died_, in the chip's shipped operator words (`advancedOpIsAnyOf`); no operator is
added. _To fix is any_ now includes dead-run cards.

### Strings

Every new key, `en` and `zh`, is in `design/workbench/design-notes.md` § 31's strings table: this section
uses `toFix.tagName.run_died`, `toFix.banner.runDied`, `toFix.banner.runDiedNothingPushed`,
`toFix.banner.runDiedParent`, `toFix.banner.toContinue`, `toFix.banner.toStartOver`,
`toFix.banner.openingDevelopment` (the link's `sr-only` pending line), and reuses
`workbench.toFix.reason.runDiedBare` for the filter.

### Tokens

Unchanged from the base section: the tag's `--el-danger` fill with `--el-danger-text` ink (the one legal
use of that ink, on its own fill); the banner's `--el-danger-surface` with `--el-danger-surface-text`; the
link in `--el-text-strong` with an `--el-border-strong` underline; the CI badge's rose tint and
`--el-text-strong`. The Tree parent's glyph takes `--el-type-story`. No raw hue, no raw shape utility.

### GIVES / TAKES

| card                                        | GIVES                                                                                                                                                                                                                 | TAKES                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **MOTIR-6880** (the stored reason)          | ELEMENT: the words — `toFix.tagName.run_died`, the three banner sentences and two link labels, the filter's reuse of `runDiedBare`. PREMISE: `run_died` first in `FIX_REASON_PRIORITY`, so the filter lists it first. | Nothing.                                                                               |
| **MOTIR-6882** (the Workbench row)          | Nothing here — its row is § 31's.                                                                                                                                                                                     | Nothing.                                                                               |
| **MOTIR-6879** (Continue hosted, placeable) | Nothing — the banner places no control.                                                                                                                                                                               | Nothing.                                                                               |
| **the four shipped reasons** (MOTIR-6608)   | Nothing.                                                                                                                                                                                                              | Nothing — their tag names, banner sentences, commands and filter values are unchanged. |

### What this does NOT decide

- **The review-agent variant** of a dead run (MOTIR-6817).
- **The run-died marker and Continue hosted** — pointed at, not redrawn.
- **The tag's form or placement, the Status track's width, the banner's slot** — MOTIR-6608's, unchanged.

## ⭐ Design review without a babysitter — the SYSTEM-APPROVED record, the AUTOMATIC RE-RUN line, and the design-approval switch (Story MOTIR-693 · MOTIR-694 — `design-result--system-approved.mock.html` + `design-result--auto-rerun.mock.html`, and `design/projects/approvals--design-gate.mock.html`, DATED 2026-09-29)

**The decision these draw is `docs/decisions/hosted-design-rerun-and-design-approval-switch.md`** (MOTIR-695). Three deltas, in two areas:

| delta mock                                                   | amends                                                                                     | area         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------ |
| `design/projects/approvals--design-gate.mock.html`           | `design/projects/approvals.mock.html` — the Approvals room (see that area's notes section) | `projects`   |
| `design/work-items/design-result--system-approved.mock.html` | `design-result.mock.html` — the DECIDED state of its approval frame                        | `work-items` |
| `design/work-items/design-result--auto-rerun.mock.html`      | `design-result.mock.html` — the REFUSED state of its approval frame                        | `work-items` |

Each was drawn against what ships, read from source: the room's `page.tsx` and `AcceptanceVideoGateCard`, and the
approval frame's record band (`ApprovalGateControl`'s `RecordStrip`). None of the older mocks is edited.

### 1 · The design-approval switch — `approvals--design-gate.mock.html`

- **Reached from:** Project settings → **Approvals** (`/settings/project/approvals`), the room guarded by
  `workflow:manage`. The card's anchor is `#design-approval`, which the system-approved record links to.
- **Composes:** `Card` (the `header` slot: an `h2` title + a description), then the state row: the state NAME and a
  one-line CONSEQUENCE beside a `Switch`. The same grammar as `AcceptanceVideoGateCard`, minus its entitlement footer
  (this switch needs no plan).
- **Placement:** between _Acceptance video approval_ and _Merging pull requests_ — the two approval switches together,
  then the merge setting that follows every approval.
- **No read-only state.** The card asked for one, and the room has none: it is manage-only (`design/projects/design-notes.md`
  § ⭐ Approvals §6, 2026-09-13; `lib/approvalGates/settingsDoor.ts`; the sibling card's own header). An actor without
  `workflow:manage` never renders this card, so a read-only variant would draw a surface nobody can reach.

| element           | copy (`en`)                                                                                                          | token                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| title             | **Design approval**                                                                                                  | `--el-text`, 16px semibold  |
| description       | A published design result waits for a person to approve it. The work built on the design cannot start until they do. | `--el-text-secondary`       |
| state name — on   | **On**                                                                                                               | `--el-text`, 14px medium    |
| consequence — on  | Every published design waits for a person to approve it.                                                             | `--el-text-secondary`, 12px |
| state name — off  | **Off**                                                                                                              | `--el-text`                 |
| consequence — off | Published designs are approved automatically, and each approval says this setting made it.                           | `--el-text-secondary`       |
| switch            | `aria-label` = the title                                                                                             | the shipped `Switch` tokens |
| toasts            | `Saved` · `Couldn't save — try again.` (the sibling's keys, reused)                                                  | the shipped `Toast`         |

Suggested keys: `approvals.designApproval.{title,desc,on,off,onWhat,offWhat,saved,saveError}` with `zh` twins.
The write is `PATCH /api/projects/[key]/approval-gates` with `{ designApprovalGate }` (MOTIR-697), optimistic and
reconciled from the response exactly as the sibling does.

### 2 · A design result approved by the SYSTEM — `design-result--system-approved.mock.html`

- **Where:** the decided state of the design result's approval frame — on the item page, in the approval overlay, and
  in the Development block when the card has pull requests (every place the record band renders).
- **When:** a `design_result` gate with `decisionSource = system` (and `decidedUnderAuthority = project_setting`). No
  other kind is decided by the system.
- **Why it must be drawn:** the shipped band prints its null-label fallback, **"No longer attributable"**, for such a
  row — which says somebody decided and the name was lost. The opposite is true (ADR §6a), so this line REPLACES the
  fallback for a system row.

| element                       | copy (`en`)                                                                                       | token                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| lead (the WHO slot)           | **Approved automatically**                                                                        | `--el-text`, medium — the slot a person's name takes |
| why — holds `workflow:manage` | Design approval is off for this project (a link to `/settings/project/approvals#design-approval`) | `--el-link`, underlined                              |
| why — everyone else           | Design approval is off for this project (plain text)                                              | `--el-text-secondary`                                |
| time                          | the decision time (= the publish time)                                                            | `--el-text-secondary`                                |
| version                       | `version <8 chars>` (unchanged)                                                                   | `--el-text-identifier`, mono                         |
| Approvals-room record row     | Approved automatically · design approval off                                                      | `--el-text-secondary`                                |

Suggested keys: `approvalGate.record.systemApproved`, `approvalGate.record.systemApprovedWhy`, and the room's
`approvals.records.systemApproved`. **The band never shows an empty actor** for a system row, and never "No longer
attributable": a `system` source is the discriminator, read before the label fallback.

### 3 · The automatic re-run line — `design-result--auto-rerun.mock.html`

- **Where:** the LAST line of a refused design gate's record band — after the verdict chip and the reason quote, on
  its own full-width row. One line per Revise, read from that refusal's `design_auto_rerun` row (MOTIR-700).
- **When there is NO row, there is NO line** — a card last run BYOK or by hand, every Re-plan, and every GitHub-synced
  refusal. Nothing was attempted, so nothing is said (panel 3).
- **Composes:** an inline glyph (`RefreshCw` started, `CirclePause` skipped; `lucide-react`, `aria-hidden`), a lead in
  `--el-text` medium, the detail in `--el-text-secondary`, and at most ONE link in `--el-link`.

| stored outcome · reason               | detail (`en`)                                                       | next step (link)                                    |
| ------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| `started`                             | lead **Re-running on the hosted agent** · automatic re-run {n} of 3 | **View run** → `/runs?run={dispatchRunId}`          |
| `skipped` · `cap_reached`             | this design has been sent back 3 times.                             | **Run on the hosted agent** (the card's Run hosted) |
| `skipped` · `dispatcher_gone`         | the person who last ran it is no longer here.                       | **Run on the hosted agent**                         |
| `skipped` · `no_project_access`       | {name}, who last ran it, can no longer edit this project.           | **Run on the hosted agent**                         |
| `skipped` · `ci_credits_exhausted`    | the organisation’s CI credits are used up.                          | **Billing** → `/settings/organization/billing`      |
| `skipped` · `model_not_offered`       | {model}, the model it last ran on, is no longer offered.            | **Choose a model and run** (Run hosted's picker)    |
| `skipped` · `models_unavailable`      | the list of models could not be read.                               | **Run on the hosted agent**                         |
| `skipped` · `out_of_credits`          | the organisation is out of credits.                                 | **Buy credits** → `/settings/organization/billing`  |
| `skipped` · `credits_unavailable`     | the credit balance could not be read.                               | **Run on the hosted agent**                         |
| `skipped` · `repository_not_writable` | Motir cannot write to {repository}.                                 | **Repositories** → `/settings/project/repositories` |
| `skipped` · `card_not_ready`          | someone picked the card up first.                                   | none — nobody can act on it                         |

Every skipped line leads **Automatic re-run skipped**. Suggested keys: `approvalGate.autoRerun.{started,
startedCount, viewRun, skipped}` and `approvalGate.autoRerun.reason.<reason>` / `.next.<reason>`, total over
`DesignAutoRerunSkipReason`, with `zh` twins.

### Tokens and a11y

Colour only through `--el-*` and shape through the element-semantic tokens (`--radius-card`, `--radius-badge`,
`--spacing-card-padding`, `--spacing-chip-*`, `--spacing-control-y`). All text on the page / card surfaces is
`--el-text` or `--el-text-secondary`; no `--el-text-muted` or `--el-text-faint` carries text. The glyphs are
`aria-hidden`; the lead carries the meaning. The dashed outline on the approvals board marks what is new and is not
part of the design.

### GIVES / TAKES

| card                                           | GIVES                                                                                                                                                    | TAKES   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **MOTIR-702** (the build)                      | ELEMENT: the switch card, the system-approved record line (both link states), the re-run line and its eleven variants, every copy string above.          | Nothing |
| **MOTIR-6417** (the E2E)                       | The words it asserts: _Approved automatically_, _Design approval is off for this project_, _Re-running on the hosted agent_, _Automatic re-run skipped_. | Nothing |
| **MOTIR-6420 / MOTIR-6427** (the refused band) | Nothing — the chip, the quote and the band are pointed at, not redrawn.                                                                                  | Nothing |

### What this does NOT decide

- **The approval frame, the verdict pair and the reason field** — MOTIR-4789 / MOTIR-6073's, unchanged.
- **Whether the cap is ever per-project** — the record keeps it a constant.
- **The Run hosted control itself** — the skipped lines link to it; it is 9.1's.

## ⭐ The TO FIX tag and banner: ONE ENTRY PER RUN — a carried card names its head, and only the head offers the repair (MOTIR-7590 — `to-fix--tag-and-banner--per-run.mock.html`, DATED 2026-10-05)

**The asset:** [`to-fix--tag-and-banner--per-run.mock.html`](./to-fix--tag-and-banner--per-run.mock.html), a
new delta mock, Panels **1–2** and zh. **It edits no existing mock.** It amends § _The TO FIX tag and banner: RUN
DIED_ (`to-fix--tag-and-banner--run-died.mock.html`, MOTIR-6878) and the published MOTIR-6608 tag and banner. The
Workbench half, and the grouping rule this section relies on, is `design/workbench/design-notes.md` **§ 34**:
cards stuck for one reason that one repair clears form ONE entry, keyed by `fixDetail.groupKey`, whose HEAD is the
card the repair runs on. Card **MOTIR-7590**; the build is **MOTIR-7589**.

### What stays per card

Every card in an entry is still stuck, so **the tag, the List / Tree / Board / quick-view placements and the
`/items` To fix filter stay per card, unchanged**. An entry is a Workbench idea; a card page is about one card.

### The tag (Panel 1)

Nothing visible changes. On a card that is NOT its entry's head, the accessible name and `title` gain a tail
naming the head: _To fix · run died · with ACME-12_, _To fix · CI failed · with ACME-31_. The label form's
`sr-only` tail grows the same way. A head, and a card stuck alone, keep today's name.

### The banner (Panel 2)

| card                              | sentence                | under it                                                                                                                          | link                                              |
| --------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| head of a dead run                | today's `runDied`       | meta line `toFix.banner.carries`: _5 more work items are stuck with it: ACME-13, …_                                               | today's _See how to continue it_ (`#development`) |
| a work item of that run           | today's `runDiedParent` | nothing                                                                                                                           | _Open ACME-12_ → `/items/ACME-12#development`     |
| head of a pull-request group      | today's reason sentence | the meta line, then today's lead and `CopyableCodeBlock` (`motir fix ACME-31`)                                                    | today's _See its pull requests_                   |
| another card on that pull request | today's reason sentence | `toFix.banner.repairedWithHead` in place of the lead and the command: _Repair it with **ACME-31** — they share one pull request._ | _Open ACME-31_ → `/items/ACME-31#development`     |
| a card stuck alone                | today's                 | today's                                                                                                                           | today's                                           |

- **A carried card points at the HEAD's page, not at a Workbench row.** The Workbench lists only the reader's own
  work and is paged, so a row link misses for anyone reading a card someone else holds; the head's Development
  block is where both repairs live.
- **Only the head shows a command.** Two copies of one repair is what the entry removes. The meta line lists the
  carried keys (bold, `--el-danger-surface-text`, regular weight, the lead's recipe), at most five, then _and N
  more_.
- The banner's frame, disc, sentence weight and link recipe are ToFixBanner's own; the new element is the meta line.

### Copy

| key (proposed)                  | en                                                                                                           | zh                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `toFix.tagName.withHead`        | {name} · with {head}                                                                                         | {name} · 随 {head}                                  |
| `toFix.banner.carries`          | {count, plural, one {# more work item is stuck with it} other {# more work items are stuck with it}}: {keys} | 另有 {count} 个工作项随它受阻：{keys}               |
| `toFix.banner.carriesMore`      | and {count} more                                                                                             | 等另外 {count} 个                                   |
| `toFix.banner.repairedWithHead` | Repair it with <b>{head}</b> — they share one pull request.                                                  | 随 <b>{head}</b> 一起修复——它们共用同一个拉取请求。 |
| `toFix.banner.toHead`           | Open {head}                                                                                                  | 打开 {head}                                         |

Colour only through `--el-*`: the meta line and the lead are `--el-danger-surface-text` on `--el-danger-surface`,
the link `--el-text-strong`, and `--el-danger-text` appears only on the disc's `--el-danger` fill. The delta
block's `rv-` rules are carried verbatim from `design/workbench/workbench--to-fix--review-agent.mock.html`.

### GIVES / TAKES

| card                       | GIVES                                                                                            | TAKES                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **MOTIR-7589** (the build) | ELEMENT: the tag's `withHead` name, the four banner variants, the meta line, every string above. | Nothing                                                                                          |
| **MOTIR-6878**             | Nothing                                                                                          | A leg's banner link now opens the head's page instead of scrolling to its own Development block. |

## Tag a page in Description and Explanation (MOTIR-7695)

**The asset:** [`internal-links--page-tag.mock.html`](./internal-links--page-tag.mock.html)
(`design/work-items/internal-links--page-tag.mock.html`), a new delta mock, panels **1–9**. **It edits no
existing mock.** It amends:

- **panel 3 of `design/work-items/internal-links.mock.html`**, the unified `@` picker (People + Work items),
  § _Work-item mentions & internal links_ above. The picker gains a third section, **Pages**.
- **the page editor's work-item chip and its unavailable state (MOTIR-7568)**,
  the mock `page--work-item-mention.mock.html` in the pages area, which `markdownEditorMentions.tsx` and the
  `@motir/pages` mention chip cite. The page chip's unavailable state is that chip's rule carried across: one
  state, no title anywhere. That mock is a published design result (card MOTIR-7568) and is not committed to
  this tree, so it is named here by file name rather than by repository path.
- **the work item's Pages section with its source labels (MOTIR-7569)**,
  the mock `item--pages-section.mock.html` in this area, which `PagesSection.tsx` cites. Its row gains two
  source labels. Also a published design result (card MOTIR-7569), not committed here.

The picker belongs to the shared `MarkdownEditor`, but the Pages section is offered only where the host wires
a page search: a work item's **Description** and **Explanation** editors. Comments, and every other
`MarkdownEditor`, keep the People + Work items picker unchanged.

### Panels

| panel | what it draws                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Picker idle at `@r` (under 2 characters): People lists members; Work items and Pages each show their "Keep typing" hint                         |
| 2     | Picker results at `@ro`: People, then Work items, then Pages; the first Pages row active                                                        |
| 3     | The Pages section alone in three states: searching, no match, failed (with Try again)                                                           |
| 4     | A reader without `page:view`: People + Work items only, no Pages header, no empty state                                                         |
| 5     | The inserted page chip in the editor, beside the person chip and the work-item chip; and the chip selected                                      |
| 6     | The chip in read view: rest, hover (title underlines), keyboard focus (focus ring)                                                              |
| 7     | **Page unavailable**: one chip for three causes                                                                                                 |
| 8     | The work item's Pages section: a row "Mentioned · Tagged in description" (drawn hovered) and a row whose only source is "Tagged in explanation" |
| 9     | Dark theme for panels 2, 5, 6 and 7, on a nested `data-theme="dark"` board                                                                      |

### The picker (panels 1–4)

- **Section order is fixed: People, Work items, Pages.** ↑/↓ wraps across all three; Enter inserts the active
  row. The option list is the three sections concatenated in that order, so the `mention-option-<n>` index
  space just grows by the page rows.
- **Pages waits for 2 characters** (`QUICK_SEARCH_MIN_QUERY_LENGTH`), like Work items. Under it, both sections
  show their hint line. People filters from the first character, unchanged.
- **The Pages search is its own debounced request** (250 ms, the work-item debounce), beside the work-item one.
  Each section loads, empties and fails on its own.
- **Failed is never "no match".** A rejected page search shows the alert line and one **Try again** option,
  which re-runs the same query for Pages only. That option takes its place in the option list after the
  page-section position, as the work-item retry does.
- **Without `page:view`** the host passes no page search, so the section is absent: no header, no hint, no
  request. The listbox keeps today's name, "Mention a person or work item". With a page search wired the name
  becomes "Mention a person, work item or page".

### The page row (panel 2)

The row is `WorkItemMentionRow`'s layout: leading glyph, truncating title, trailing meta.

| element        | primitive / markup                         | colour (`--el-*`)                  | shape                                       |
| -------------- | ------------------------------------------ | ---------------------------------- | ------------------------------------------- |
| row            | `div role="option"` in the `MentionList`   | `--el-text`; active `--el-surface` | `--radius-control`, `--spacing-control-x/y` |
| glyph          | lucide `FileText`, 14 px, `aria-hidden`    | `--el-text-secondary`              | —                                           |
| title          | `span`, one line, ellipsis                 | `--el-text`                        | —                                           |
| place          | `span`, right-aligned, 12 px, max 9rem     | `--el-text-secondary`              | —                                           |
| section header | the mono uppercase `p` (People/Work items) | `--el-text-secondary`              | `--spacing-control-x` inline                |

- **The place** is the page's folder path joined with `›` (`Product › Roadmaps`), or, for a child page, its
  parent page's title (`Q4 roadmap`). A page at the top level shows no place. An untitled page reads
  "Untitled" (`pages.untitled`).
- **The place is `--el-text-secondary`, not `--el-text-muted`**: the active row's fill is `--el-surface`, where
  muted is 4.17:1 and fails AA. Secondary clears AA on both the popup's `--el-page-bg` and the active tint.

### Section states (panels 1, 3)

| state          | markup                                                              | colour                                                          |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| under 2 chars  | the hint `p`, centred, 12 px                                        | `--el-text-secondary`                                           |
| searching      | lucide `Loader2` (spinning, `aria-hidden`) + "Searching…"           | line and glyph `--el-text-secondary`                            |
| no match       | the hint `p`: No pages match “zzqq”.                                | `--el-text-secondary`                                           |
| failed         | `p role="alert"`: lucide `TriangleAlert` + "Couldn’t search pages." | line `--el-text`; the glyph alone `--el-danger-on-surface`      |
| failed — retry | one `div role="option"`: lucide `RotateCw` + "Try again"            | `--el-text`, glyph `--el-text-secondary`; active `--el-surface` |

The Pages hint lines are drawn in `--el-text-secondary`. The shipped Work items lines paint `--el-text-muted`
on the popup's white `--el-page-bg`, which passes (4.54:1); the mock draws both sections in secondary so they
read the same, and the build may move the work-item lines to secondary in the same change.

### The page chip (panels 5–6)

| element | primitive / markup                                        | colour                                       | shape                                  |
| ------- | --------------------------------------------------------- | -------------------------------------------- | -------------------------------------- |
| chip    | editor: an atomic inline node; read view: `a` to the page | fill `--el-tint-sky`, ink `--el-text-strong` | `--radius-badge`, `--spacing-chip-x/y` |
| glyph   | lucide `FileText`, 13 px, `aria-hidden`                   | inherits `--el-text-strong`                  | —                                      |
| title   | `span`, ellipsis when long                                | inherits `--el-text-strong`                  | —                                      |

- **Tint slot.** The work-item chip (`.wi-chip`) is a bordered `--el-surface-soft` box with `--radius-control`,
  and the person chip (`.mention-chip`) is `--el-tint-lavender` with `--radius-badge`. The page chip takes
  `--el-tint-sky`, which neither uses, so the three references read apart in one paragraph (panel 5).
- **The title is the page's CURRENT title**, read when the body renders; a rename shows the new name.
- **In the editor** a click selects the chip (the focus-ring outline, as the work-item atom) and never opens
  the page.
- **In the read view** the chip is a link to the page in the same tab. Hover underlines the title and changes
  no colour. Keyboard focus draws `ring-(--focus-ring-color)` at `--focus-ring-width`, offset 1 px.

### Page unavailable (panel 7)

- **One state for three causes**: the reader has no `page:view`, the page is archived, or it is deleted. The
  chip never says which.
- **The title appears nowhere**: not in the text, not in a `title` attribute, not in screen-reader-only text,
  not in a `data-*` attribute. The stored token keeps the page id; the render reads no title for it.
- **It is a `span`, not a link**: no hover state, no focus stop, default cursor.

| element | markup                              | colour                                       | shape                                  |
| ------- | ----------------------------------- | -------------------------------------------- | -------------------------------------- |
| chip    | `span`                              | fill `--el-muted`, ink `--el-text-secondary` | `--radius-badge`, `--spacing-chip-x/y` |
| glyph   | lucide `Lock`, 13 px, `aria-hidden` | inherits `--el-text-secondary`               | —                                      |
| label   | "Page unavailable"                  | inherits                                     | —                                      |

### The Pages section rows (panel 8)

The row is `PagesSection.tsx`'s `PageRow`, unchanged: `NotebookText` glyph (`--el-icon-muted`), title
(`--el-text`, underlined on row hover), the place breadcrumb (`--el-text-secondary`, `ChevronRight` separators
and `Folder` glyphs in `--el-icon-muted`), the source Pills, and the relative time (`--el-text-secondary`). The
row hover is `--el-surface` at `--radius-control` with `--spacing-control-x/y`; rows are divided by
`--el-border-soft`.

- **Two new sources** join the fixed order after Mentioned, Embedded and Linked: **Tagged in description**
  (`issueViews.pagesSourceDescription`) and **Tagged in explanation** (`issueViews.pagesSourceExplanation`).
- Each is a `Pill tone="neutral"` (`--el-chip-bg` fill, `--el-chip-border` edge, `--el-text-secondary` ink,
  `--radius-badge`, `--spacing-chip-x/y`) with a lucide `Tag` glyph. A page tagged in both fields shows both.
- The section card is `ContentSectionCard`: "Pages — where this item is written about", `--radius-card`,
  `--spacing-card-padding`, `--shadow-card`.

### Primitives used

`MentionList` and its option row (`components/ui/markdownEditorMentions.tsx`), `WorkItemMentionRow`'s row
layout, `Pill` (status tones in the work-item rows; `tone="neutral"` for sources), `IssueTypeIcon` (work-item
rows), the `MarkdownEditor` wrapper, `.mention-chip` and `.wi-chip` (contrast only), `PagesSection` /
`ContentSectionCard` / `PageBreadcrumb`'s place vocabulary. Lucide glyphs: `FileText`, `Lock`, `Tag`,
`AtSign`, `NotebookText`, `Folder`, `ChevronRight`, `Loader2`, `TriangleAlert`, `RotateCw`.

### Copy

| key (proposed unless noted)                     | en                                  |
| ----------------------------------------------- | ----------------------------------- |
| `markdownEditor.mentionPages`                   | Pages                               |
| `markdownEditor.mentionTypeToSearchPages`       | Keep typing to search pages…        |
| `markdownEditor.mentionSearching` (existing)    | Searching…                          |
| `markdownEditor.mentionNoPages`                 | No pages match “{query}”.           |
| `markdownEditor.mentionPagesSearchFailed`       | Couldn’t search pages.              |
| `markdownEditor.mentionRetry` (existing)        | Try again                           |
| `markdownEditor.mentionTypeToSearch` (existing) | Keep typing to search work items…   |
| `markdownEditor.pageUnavailable`                | Page unavailable                    |
| `issueViews.pagesSourceDescription` (existing)  | Tagged in description               |
| `issueViews.pagesSourceExplanation` (existing)  | Tagged in explanation               |
| listbox name, with a page search                | Mention a person, work item or page |

The "Keep typing" hint is one sentence shape across both sections: the work-item line keeps its existing
string, and the Pages line is its parallel with "pages". `pages.untitled` ("Untitled") names an untitled page
in a row or chip.

### Dark (panel 9)

Panels 2, 5, 6 and 7 redrawn on a nested `data-theme="dark"` board. The mock re-emits its Tier-3 block on
`[data-theme]`, so the board recomputes against the dark Tier-0 values. Every ink above clears AA on every dark
surface; the sky chip reads `--el-text-strong` on the dimmed sky tint.

## Work content editors name their original language (Story MOTIR-7738 · MOTIR-8837 — `editors-original-language.mock.html`, DATED 2026-10-17)

**Design system, first.** Read `package.json` (root): it depends on `@motir/design-system` (`workspace:*`, version 0.15.1), and `app/globals.css` imports `@motir/design-system/theme.css` (line 13). Both checks hold, so this is **branch (a), on Motir Design**. The project's own axes are the package defaults, `warm-editorial` / `motir` / `motir` (`app/layout.tsx` writes `data-style` / `data-palette` / `data-type` from the applied appearance; the default ids are `DEFAULT_STYLE_ID` / `DEFAULT_PALETTE_ID` in the package's theme registries). 0.15.1 exports `@motir/design-system/mock`, so the mock is built with `renderMock` from the package's parts at those axes.

**It amends** § "Translate a work item on demand" in this file and its `translation.mock.html` (MOTIR-8112, published in Motir's design store, read with `get_design MOTIR-8112`; it is not a file in this repository). That asset drew the reading side: the machine-translation mark, the translation bar, Show original. **This asset draws the writing side**, which it never reached: the editors. It edits no existing mock and redraws nothing the predecessor drew.

### What this decides, and what it only composes

| Decided here                                                            | Composed, never redrawn (cited by path)                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Where the original-language note sits in each of the five editor fields | `app/(authed)/items/[key]/edit/_components/EditIssueForm.tsx` — the edit form, unchanged around the new line   |
| Its English copy in four cases                                          | `app/(authed)/items/[key]/_components/TodoListSection.tsx` — the to-do row editor                              |
| What a title error does to the note                                     | `packages/design-system/src/components/ui/Input.tsx` and `FormField.tsx` — `helperText` and its error override |
| The one class the shared label row needs at narrow width                | `components/ui/MarkdownEditor.tsx` — `labelAccessory`, and the label row that carries it                       |

**Out of scope, owned elsewhere.** The reading marks, the translation bar, the machine-translation mark and Show original (MOTIR-8823's reading design and the build it blocks); which language a field records and what a field with none means (the content-language story); whether a translation shows at all (the reading work). No behaviour is decided here.

### Substrate check (the advisory on MOTIR-8832)

This card's acceptance criteria name MOTIR-8832 (the item page and quick view build), and no `blocked_by` edge says so. **This asset consumes nothing from it.** What it needs is already on `origin/main`: `item.languages.{title,description,explanation}` and a to-do's `textLanguage` / `notesLanguage` on the DTOs (read in `lib/translation/itemFields.ts`, `assembleFields`), and the platform's display-name lookup `languageDisplayName(code, uiLocale)` — `new Intl.DisplayNames([uiLocale], { type: 'language' }).of(code) ?? code`, exported from `app/(authed)/items/[key]/_components/translation/TranslationProvider.tsx`. MOTIR-8832 is the card this asset _blocks_, not one it waits on.

### The note, per editor

One line, **"Original in {language}"**, in the existing affordance of each field. No new primitive.

| Element                                     | Affordance                          | Placement                                                                                                                                                                                         | Ink                                                                                          |
| ------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Edit form · **Title**                       | `Input`'s `helperText`              | the helper line under the field                                                                                                                                                                   | the helper's own `--el-text-helper`                                                          |
| Edit form · **Description**                 | `MarkdownEditor`'s `labelAccessory` | after the "Description" label, introduced by an em dash exactly as the Explanation's gloss is                                                                                                     | `--el-text-secondary`, `font-normal` (the gloss's ink — AA on the surface the label sits on) |
| Edit form · **Explanation**                 | `labelAccessory`                    | after the existing gloss ("— why it matters") and before the AI-drafted pill and the Draft with AI button, so the two statements about the text stay together and the two actions stay at the end | `--el-text-secondary`, `font-normal`                                                         |
| To-do row editor · **Step** (text)          | `Input`'s `helperText`              | the helper line under the step field (this input carries only an `aria-label` today; `helperText` needs no visible label)                                                                         | `--el-text-helper`                                                                           |
| To-do row editor · **Instructions** (notes) | `labelAccessory`                    | after the "Instructions" label                                                                                                                                                                    | `--el-text-secondary`, `font-normal`                                                         |

The to-do **Command** field is not in scope: `assembleFields` translates a to-do's `text` and `notesMd` only, a command is not prose in a language, and the DTO records no language for it.

### The four cases, and their copy

`{language}` is the language's name in the **reader's interface language**, from `languageDisplayName(code, uiLocale)` — the platform's lookup, the one the predecessor already uses for "Translated from {language}". No hand-written list of names exists anywhere in this design. When the lookup cannot name a code it returns the code itself, as the predecessor's does; the note then reads "Original in xx" and that is accepted.

| Case                                               | Stored value                                       | Copy                                              | Drawn in            |
| -------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- | ------------------- |
| **Recorded in a language**                         | a code, e.g. `ko`                                  | `Original in Korean`                              | P1, P5, P6, P7, P8  |
| **Recorded in the reader's own language**          | a code equal to the reader's                       | `Original in English` — the same copy             | P2                  |
| **No language recorded** (older and imported text) | `NULL`                                             | `Original language not recorded`                  | P3, P6, P7          |
| **No text at all**                                 | an empty field, whatever its language column holds | **no note** — nothing to edit, so nothing to name | P4, P6 (second row) |

Decisions behind that table:

- **The reader's-own case does not change the copy.** The note states a fact about the stored text, and it is true whoever reads it. What differs between a Korean-original and an English-original field for an English reader is on the reading side (a translation exists or does not), and that is the reading design's. Suppressing the note when it matches would also make a field that records English look identical to one that records nothing, which is the confusion this note exists to remove.
- **`NULL` is never shown as English or as the organisation's language.** It says what is true: the language was not recorded. The note names no guess and offers no control to set one — recording a language is the content-language story's.
- **An empty field shows no note.** A note with nothing under it names the language of nothing.
- **A title error replaces the note** (P5). `FormField` shows the error in the helper line and the helper otherwise, never both (`FormField.tsx`: `error ? … : helperText ? …`). The note returns the moment the error clears. This is the shipped behaviour of the primitive, kept rather than worked around: the note is informational, the error blocks the save.
- **Copy follows the reader's locale like every other interface string.** It is an interface string in the catalogues, never sent through the translation lane and never billed.

### Copy catalogue (English)

Proposed keys under the existing `itemTranslation` namespace in `messages/en.json`; the build card carries the other ten catalogues through the `pnpm i18n:extract` / `pnpm i18n:merge` loop.

| Key                                   | English                          |
| ------------------------------------- | -------------------------------- |
| `itemTranslation.originalIn`          | `Original in {language}`         |
| `itemTranslation.originalNotRecorded` | `Original language not recorded` |

"Original" is the predecessor's own word (`hintShowingOriginal`: "Showing the original", `showOriginal`: "Show original"); "language" is the product's word in `markTranslatedFrom`. The work item is called a **work item** throughout; the fixture's field names are the shipped labels (Title, Description, Explanation, Step, Instructions).

### Narrow width

At ~400px the label row (`flex items-center gap-2`, no wrap, in `MarkdownEditor`) cannot hold label + gloss + note + pill + button on one line. The mock draws the row **wrapping**, which needs **one class on the shared label row: `flex-wrap`** (with `gap-x-2 gap-y-1`). That is the only change to a shipped component this design asks for, and it lands in the build card (MOTIR-8832's editor work), not here. Without it the row squeezes the note into a vertical sliver; the existing Explanation row already comes close with the gloss, the pill and the button alone. Single-line fields need nothing: the helper line wraps like any paragraph.

### Panels

`P0` access path — the item page's **Edit** button into the edit form, and a to-do row's **Edit step** into the row editor · `P1` recorded in another language · `P2` recorded in the reader's own language (with the AI-drafted pill beside the note) · `P3` no language recorded · `P4` mixed: a recorded title with empty description and explanation · `P5` title in error · `P6` the to-do row editor, step recorded and instructions unrecorded, then a row with empty instructions · `P7` dark · `P8` ~400px.

### Parts inventory

From the package: `Input`, `Pill`, `Button`. **Product-local:** the `MarkdownEditor` shell (label row, toolbar, surface), drawn as markup copied class for class from `components/ui/MarkdownEditor.tsx` because the editor is a product component, not a package part, with an abbreviated toolbar; and the note itself, a plain `<span>`. **Proposed additions to `@motir/design-system`: none.**

### Colour, shape and ink

Every product element carries `--el-*` and the element-semantic shape tokens (`--radius-input`, `--radius-card`, `--radius-control`, `--spacing-card-padding`); no Tier-0 colour, no raw hue. The note's inks are the two the shipped neighbours already use (`--el-text-helper` on the helper line, `--el-text-secondary` on the label row), neither of which is `--el-text-muted` or `--el-text-faint`. The dark panel's `[data-dark-panel]` block copies token values resolved from a `renderMock({ theme: 'dark' })` render at the same axes, because the package's dark tokens resolve at `:root` and do not re-resolve under a nested wrapper.

### Reference check

No external reference was reached: the placement follows the shipped patterns in this repository — `FormField`'s helper line for single-line fields, and the Explanation label's gloss (`EditIssueForm.tsx`, the `labelAccessory` block) for bodies — and the vocabulary follows `itemTranslation` in `messages/en.json`.

## ⭐ Auto-translate — the work item page and quick view read in the reader's language unpressed, with the machine-translation mark and Show original (Story MOTIR-7738 · MOTIR-8823 — `translation--auto.mock.html`, DATED 2026-10-17)

**Design-system verdict (read first).** Files read: `package.json` (depends on `@motir/design-system` as `workspace:*`, installed `0.15.1` per `node_modules/@motir/design-system/package.json`) and `app/globals.css` (`@import '@motir/design-system/theme.css'`). **Both checks hold → ON MOTIR DESIGN, branch (a).** The project's own axes are applied per reader in `app/layout.tsx` (`data-style` / `data-palette` / `data-type` from `applied.styleId` / `paletteId` / `typeId`); the mock draws at `warm-editorial` / `motir` / `motir`, the axes the base was drawn at. The package exports `@motir/design-system/mock`. **How this mock was built:** it is a DELTA over the base, so it copies the base's compiled stylesheet and the base's own markup class for class (the base was rendered with `renderMock` from `0.13.0`), rather than re-rendering with `0.15.1`; every class it uses appears in the base's output and no class was added. Parts used: the package's own `Button`, `Pill` and `Spinner` (as rendered in the base) and the item page's own markup. **Parts the package lacks: none; proposed additions to `@motir/design-system`: none.** Nothing is migrated.

**What this asset DECIDES.** What a reader sees from the _first paint_ of an opened work item when the project's auto-translate switch is on, in fifteen states, under decisions A1–A6; and that the base's decision **D2 is superseded, only while the switch is on**.

**What it only COMPOSES, by path.** The base design **[MOTIR-8112](motir:cmv2c8zb9002lhwshknnp6j3z)** (source path `translation.mock.html (the design store, get_design MOTIR-8112)`, with its `## ⭐ Translate a work item on demand …` section of this file's published copy) — **neither is in the repository tree at `origin/main`**; both are fetched with `get_design MOTIR-8112`, and this section cites them by that card. Also composed, none redrawn: `design/work-items/detail-arrival.mock.html` (the page header the bar sits in) · `design/work-items/quick-view.mock.html` (the overlay frame) · `design/work-items/todo-list.mock.html` (the to-do rows whose marks sit beside the executor mark and the instructions disclosure) · the shipped `components/ui` `Button`, `Pill`, `Spinner`. **It edits no existing mock**, and the base mock is a record.

**Shipped reality it was drawn against** (`app/(authed)/items/[key]/_components/translation/`): `TranslationProvider.tsx` (the offer, the reducer, the view mode; the only caller of `POST /api/work-items/[id]/translate`; its header and `translationReducer.ts`'s say _"a reload opens on the original (D2)"_), `TranslateControl.tsx` (the bar's faces), `FieldTranslationMark.tsx` (the marks), `lib/dto/workItemTranslation.ts`, `app/(authed)/items/[key]/_view.tsx`, `IssueQuickViewPanel.tsx` (`QUICK_VIEW_FIELDS = [title, description]`), and the `itemTranslation.*` family in `messages/en.json`.

### The fixture

Same as the base's shape: a reader with a **Korean** interface; a work item whose title, description and first to-do (text and instructions) record `en`; an explanation already Korean; a second to-do that records **no language**. The chrome is drawn with the shipped English `itemTranslation.*` values, because the Korean catalogue twin belongs to the locale lane; the work content is drawn in the languages the fixture names.

### States

`P<n>` is this asset's panel; "Base n" is MOTIR-8112's, composed and not redrawn.

| #   | state                                                                                                        | the bar                                                                                                                                                          | each differing field                                                                                                              | request                              |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| P1  | **first paint, page host** (also draws the door: a list row opens the page, or the quick view from `?peek=`) | busy: **Translating…** + spinner, `aria-busy`, `aria-disabled`, hint **into Korean**. **Translate is never drawn**                                               | stored text in its own box, mark **Translating…**                                                                                 | one, the item's, started by the host |
| P2  | **landed**                                                                                                   | **Show original** (`aria-pressed="true"`), hint **Translated into Korean**                                                                                       | translated text + **Translated from English**; the Korean explanation unmarked; markdown, link, code and work item chip as Base 5 | none further                         |
| P3  | **showing original**                                                                                         | **Show translation** (`aria-pressed="false"`), hint **Showing the original**                                                                                     | stored text, no mark                                                                                                              | none, either direction               |
| P4  | **already in your language**                                                                                 | **nothing**: no bar, no disabled control                                                                                                                         | stored, no mark                                                                                                                   | none (Base 3)                        |
| P5  | **no recorded language**                                                                                     | as P2                                                                                                                                                            | detected source: **Translated from English**; undecidable: **Translated**                                                         | as P1                                |
| P6  | **failed, whole item**                                                                                       | **Retry** in the control's slot + **Couldn’t translate this work item. Nothing was charged.**                                                                    | stored, no mark                                                                                                                   | Retry re-sends the item's request    |
| P7  | **failed, one field**                                                                                        | **Show original**, hint with _1 field couldn’t be translated_                                                                                                    | the failed field: stored + its own **Retry** (Base 8)                                                                             | that field's Retry                   |
| P8  | **no credit, known before any request** — owner/admin and member                                             | no button; the shipped message, **Add credits →** for `canAddCredits`, the member's line otherwise; present from the first paint, never after a Translating face | stored, no mark                                                                                                                   | **none**                             |
| P9  | **stale (a)**, page host only                                                                                | unchanged                                                                                                                                                        | the edited field: new stored text + **Edited · translating…**, then its new translation (Base 10); untouched fields do not change | one quiet re-request for that field  |
| P10 | **stale (b), a later reader**                                                                                | as P1, then P2                                                                                                                                                   | unchanged fields pending, then land from kept copies; the edited field is the only one billed                                     | one, the item's                      |
| P11 | **the quick view**: first paint, landed, showing original, failed, no credit; and the plan proposal peek     | as P1–P8 in the overlay's narrower column                                                                                                                        | the title and the description only                                                                                                | the item's (D3)                      |
| P12 | **the quick view where only an undrawn field differs**                                                       | **nothing**                                                                                                                                                      | nothing marked                                                                                                                    | **none**                             |
| P13 | **switch off**: the base's offered face returns                                                              | **Translate**, hint **into Korean** (Base 1, 2)                                                                                                                  | stored, no mark                                                                                                                   | none until pressed                   |
| P14 | **keyboard and assistive technology**                                                                        | focus ring on the control; the live-region lines; the no-credit message on load drawn **without** focus                                                          | —                                                                                                                                 | —                                    |
| P15 | **dark theme and ~390px**                                                                                    | token parity; the hint wraps under the control (base D1)                                                                                                         | marks wrap in their slots                                                                                                         | —                                    |

**Not states of this surface:** a plan proposal in the quick view, the public project page and a Visitor get **no provider, no bar, no mark** (as shipped; `proposal ? null`). P11 draws the proposal peek once to show it is the stored text with nothing added.

### The wrong first frames, named (and why each panel is drawn as a first frame)

1. **A Translate button for one frame before the busy face** — the host mounted offering, then started. Under auto the host mounts busy (A1). P1 is the right frame.
2. **A no-credit message that takes focus on load** — see A5. P8 and P14 are the right frames.
3. **An announcement over the page's arrival** — "Translating into Korean…" read at load. See A5. P14 lists what is and is not announced.
4. **A kept copy flashed as already translated before the answer** — rejected in A3.

### Decisions

- **A1 — The auto path is the press, entered at mount.** Every face, mark and message is the base's. Auto adds **no new element and no new string**; the off state is the base unchanged. The one visual difference is the face that can no longer appear: the **Translate** face is unreachable under auto because the host opens busy. It is drawn only in P13.
- **A2 — D2 is reversed for an auto-translating project only.** Base D2: _"the view always opens on the original … nothing is shown translated without a press."_ **That sentence is superseded by this section from 2026-10-17, only while the project's switch is on.** Show original is still a choice for **this host view**; nothing is written, so a reload and every new open return to the reader's language. The page and the quick view hold **separate** view modes: _Open full page_ from a peek that shows the original opens the page translated. With the switch **off**, D2 holds exactly as the base wrote it (P13). **Show original writes nothing and does not carry between the page and the quick view.**
- **A3 — A kept copy gets no special face.** The offer carries a `kept` flag, but drawing kept fields as already translated before the answer arrives would need a second rendering path for one frame of difference. A kept field goes through the same brief **Translating…** as one that is not. A later reader's frame of pending is the honest cost of one state machine. P10 draws it.
- **A4 — No credit is a first-paint state, not an outcome.** When the reader's context says the organisation cannot pay, **the host makes no request**. The shipped message and its `canAddCredits` split render from the first paint; its copy _"Nothing was charged."_ stays true; nothing on the item is marked.
- **A5 — A state reached on load takes no focus and makes no start announcement.** Two shipped behaviours are constrained:
  - `TranslateControl.tsx`'s `NoCreditMessage` runs an effect that, when `document.activeElement` is `document.body` or `null`, calls `ref.current?.focus()`. That hand-off exists because the pressed button has just disappeared (control file header: _"Only no-credit removes it (D6), and then focus moves to the message"_). On a page load focus is also on the `body`, so the same effect would pull focus into the header before the reader has done anything. **Under auto the message is drawn and never focused** (it keeps `tabIndex={-1}` so a later press, or the off-state path, can still hand focus to it). The build must tell the two entries apart by how the face was reached, not by where focus is.
  - `TranslationProvider.tsx`'s `useTranslationActions` calls `announce(lines.translating)` at the start of every non-`quiet` `run`. **Under auto the host's start must not announce** — and it must NOT be the reducer's `quiet` flag, which also skips `busy` / `pressed` (`translationReducer.ts` `start`) and would draw no busy face; the build needs the press-equivalent start (busy, pressed) with only the announcement suppressed. Nothing is said when the request starts (the page's own arrival is what the reader hears), and the settled line is announced **once** through `useSettledAnnouncement`, using the shipped lines (_Translated into Korean._, _1 field couldn’t be translated._, _Couldn’t translate this work item. Nothing was charged._). **No credit on load announces nothing**, because nothing changed. The stale line (_Description was edited and translated again._, D5) is unchanged. A pressed Show original / Show translation still announces its line.
- **A6 — The quick view keeps D3 under auto.** It starts only when the title or the description differs, and then asks for the whole item, because that is the door's unit. It marks only what it draws. It has no live refresh (only the page passes `liveRefresh`), so **stale (a) does not occur in the quick view**: nothing updates an open overlay's fields, and a reader who edits elsewhere reopens it, which is a fresh first paint. When only the explanation or a to-do differs, the overlay draws nothing that needs it (P12).

**Base decisions that still hold under auto:** D1 (one control for the item, under the title, the hint wraps under it on a narrow column), D3 (the quick view's unit and scope), D4–D7 as the base wrote them — D5 (the stale announcement) and D6 (no-credit removes the control) read exactly as before, A5 only constrains _when_ D6's focus hand-off runs.

### The string map (no new keys)

| what the reader sees        | shipped key (`itemTranslation.*`)                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the bar's group name        | `groupLabel`                                                                                                                                                                                     |
| busy face, first paint      | `translating`, `hintInto`                                                                                                                                                                        |
| landed / showing original   | `showOriginal`, `showTranslation`, `hintTranslated`, `hintShowingOriginal`, `hintPartial`                                                                                                        |
| the offered face (P13 only) | `translate`, `hintInto`                                                                                                                                                                          |
| marks                       | `markTranslating`, `markEdited`, `markTranslatedFrom`, `markTranslated`, `markFailed`, `markPrefix` + `fieldTitle` · `fieldDescription` · `fieldExplanation` · `fieldTodo` · `fieldInstructions` |
| failed                      | `retry`, `failedItem`, `retryTitle` … `retryInstructions`                                                                                                                                        |
| no credit                   | `noCredits`, `noCreditsMember`, `addCredits`                                                                                                                                                     |
| live region                 | `liveTranslated`, `liveFailedCount`, `liveShowingOriginal`, `liveEdited` (and **not** `liveTranslating` on load)                                                                                 |

Every visible string of the chrome in the mock is one of these values from `messages/en.json`, with `{language}` filled as _Korean_ (hint) or _English_ (mark). **The mock introduces no new key.** The strings that are not chrome are the fixture's work content and the panels' captions (which are annotations, not product copy). The ten non-English catalogues owe nothing: no string is new.

### Parts inventory

From the package: `Button`, `Pill`, `Spinner` (as the base composes them). **Product-local:** the item page's own markup (header, `Card`-styled sections, the to-do row), the overlay frame, the work item chip, copied class for class from the base. **Proposed additions to `@motir/design-system`: none.**

### Colour, shape and ink

Every product element carries `--el-*` and the element-semantic shape tokens only; no Tier-0 colour, no raw hue, no raw `rounded-*`. Marks and hints use `--el-text-secondary`, never `--el-text-muted`; the danger hue is on the failed mark's glyph alone (`--el-danger-on-surface`), its label on `--el-text`. The dark panels are a wrapper carrying `data-appearance-scope data-theme="dark" data-palette="motir"`, which re-resolves the `--el-*` layer inside the page without a second render. The only literal layout value is the 390px width on P15's narrow wrappers.

### Reference check

No external reference was reached: this surface adds no element and no string to the base, so the behaviour follows the story's own _With auto-translate ON_ and _states besides success_ and the shipped host (`TranslationProvider.tsx`, `TranslateControl.tsx`, `FieldTranslationMark.tsx`), and the base design MOTIR-8112.

### GIVES / TAKES

|                                                                                                                                                                                                                             |                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GIVES** to [Work item page and quick view — every field arrives in the reader's language on load](motir:cmvbkboyd001shqop781p415j) (MOTIR-8832) and to the coverage sweep ([MOTIR-8834](motir:cmvbkbp0j001whqopbmqpr47v)) | the fifteen states, A1–A6, the string map; A5 constrains the no-credit message's focus hand-off and the start announcement                                                       |
| **TAKES** from the base (MOTIR-8112)                                                                                                                                                                                        | every face, mark, message and live line, composed unchanged                                                                                                                      |
| **TAKES** from [the reader's translation context](motir:cmvbkbon6001khqop6yb6ad83)                                                                                                                                          | whether the switch is on, the reader's language, whether the organisation can pay (`canAddCredits`), each field's recorded language — as facts; none of their mechanics is drawn |

### What this does NOT decide

- **The editors' original-language note** (edit form's title, description and explanation, the to-do row editor): [the editors' design](motir:cmvbkbpaw0022hqopxorabzzp).
- **The title surfaces** (list, tree, board, backlog, sprint, roadmap, ready, triage): their per-surface switch, per-title glyph and the one notice per surface belong to [the list and board design](motir:cmvbkbode0010hqopplj8p1be) and [their build](motir:cmvbkbozd001uhqopgfhggdrt). The peek's view mode is independent of a surface's switch, and this asset agrees.
- **The setting and who may flip it**: [its design](motir:cmvbkbnwv000whqopmgfngvoj) and [its control](motir:cmvbkbovp001ohqop8zx43qox).
- **Every other render site**: the coverage sweep.
- **The story's proof**: integration and E2E with the acceptance video.
- **The Korean twins of the strings**: the locale lane; nothing new is owed.

## ⭐ The title surfaces under auto-translate — one Show original switch per surface, one no-credit notice, a mark on each differing title (Story MOTIR-7738 · MOTIR-8824 — `translation--titles.mock.html`, DATED 2026-10-17)

**Design-system verdict (read first).** Files read: `package.json` (depends on `@motir/design-system` as `workspace:*`, installed `0.15.1`) and `app/globals.css` (`@import '@motir/design-system/theme.css'`). **Both checks hold → ON MOTIR DESIGN.** Axes used for the mock: style `warm-editorial`, palette `motir`, type `motir`; the dark panel is a nested wrapper carrying `data-appearance-scope data-theme="dark"`. The mock is produced with `renderMock` from `@motir/design-system/mock`, so its markup is the package's and the product's own classes.

**What this asset DECIDES.** What a reader sees on the **title surfaces** when the project's auto-translate switch is on: the per-surface switch, the per-title mark, the one notice when no credit is available, the live region, and how a title that differs keeps its row or card from moving. Eight surfaces, nine surface-level states, six per-title values.

**What it only COMPOSES.** The item-scope switch shipped in `app/(authed)/items/[key]/_components/translation/` (a secondary small `Button` with the lucide `Languages` icon, `aria-pressed`) and the mark vocabulary of the work item page design ([MOTIR-8823](motir:cmvbkboyd001shqop781p415j)'s sibling design, `translation--auto.mock.html`). A list switch means the same thing as the item's: pressed shows the text as written.

### The surfaces and their measurements (read from the shipped code)

| surface            | where the switch lives                                            | the title's box today                                                                                                        | what the swap can change                       |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `/items` list      | the toolbar's right end, beside the view controls                 | single line, truncate; row `height: 44`, title track `minmax(10rem,1fr)` (`IssueListTable.tsx:188`, `ISSUE_TITLE_MIN_TRACK`) | nothing: the row stays 44                      |
| `/items` tree      | the same toolbar                                                  | single line; `ROW_PX=40`, `INDENT_PX=22` (`TreeTable.tsx`)                                                                   | nothing: the row stays 40                      |
| Board              | the board header's controls slot, beside the group-by `Segmented` | card title `line-clamp-2 text-[13.5px] leading-snug` (`BoardCard.tsx:131`)                                                   | **yes** → the reserved two-line region (below) |
| Backlog and sprint | the planning header                                               | single line, truncate in the shared `BacklogRow` (`BacklogRow.tsx:182`)                                                      | nothing                                        |
| Ready              | the page header                                                   | single line, truncate; `ROW_ESTIMATE_PX=44`, `ROW_GAP_PX=8`, accessible name `${key} ${title}`                               | nothing                                        |
| Triage             | the inbox header                                                  | `line-clamp-2` over a `line-clamp-1` snippet (`TriageRow.tsx`)                                                               | no: the clamp is the box                       |
| Roadmap canvas     | the canvas toolbar                                                | node `NODE_W=280` × `NODE_H=124`, title `line-clamp-2` (`lib/planning/projectCanvasModel.ts:174-175`)                        | no: the node is fixed                          |

**Deviation from the card's table.** The card says backlog, sprint and Ready follow "the same two-line region rule". The measured rows are single-line truncated, so a longer or shorter translated title cannot change their height; the rule is **vacuous there** and nothing is reserved. Only the board card, whose title is a clamp that can occupy one or two lines, owes a reservation.

### The rule: a differing title takes the two-line region from the first frame

On the board, a card whose title differs from the reader's language takes `line-clamp-2 min-h-[2lh]` **from the first frame** (mid-translation included), so the answer landing never moves the card below it. A card whose title does not differ keeps its ordinary box. P5 draws one card three times (reserved, landed, and the "not this" cases: a card that grows on arrival; a reservation on a card that does not differ).

### Surface-level states (the switch and the notice)

| #   | state                                                                     | switch                                       | notice                                                       | requests                                                   |
| --- | ------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| S1  | **setting off**                                                           | absent                                       | absent                                                       | none                                                       |
| S2  | **on, nothing differs** (every visible title is in the reader's language) | absent (not disabled)                        | absent                                                       | none                                                       |
| S3  | **on, translating**                                                       | **Show original**, `aria-pressed="true"`     | absent                                                       | one per page of titles                                     |
| S4  | **on, landed**                                                            | **Show original**, pressed                   | absent                                                       | none further                                               |
| S5  | **showing original**                                                      | **Show translation**, `aria-pressed="false"` | absent                                                       | **none**, either direction; never persisted, bills nothing |
| S6  | **partly failed**                                                         | as S4                                        | absent                                                       | the next load retries                                      |
| S7  | **no credit, owner or admin**                                             | absent                                       | the notice + **Add credit** link (only when `canAddCredits`) | **none**                                                   |
| S8  | **no credit, member**                                                     | absent                                       | the notice, no link                                          | none                                                       |
| S9  | **stale after an edit**                                                   | unchanged                                    | unchanged                                                    | the edited title is re-requested quietly                   |

The switch is **absent, not disabled** in S1, S2, S7 and S8: a disabled control would promise something the surface cannot do.

### Per-title values

| value         | what is drawn                                                | accessible name              |
| ------------- | ------------------------------------------------------------ | ---------------------------- |
| not differing | the stored title, no mark                                    | the title                    |
| pending       | the stored title + a small spinner glyph (`aria-hidden`)     | title + "translating"        |
| translated    | the translated title + the translation glyph (`aria-hidden`) | title + "machine-translated" |
| original      | the stored title, no mark (the switch is the cue)            | the title                    |
| failed        | the stored title only: **no mark, no Retry**                 | the title                    |
| no credit     | the stored title only                                        | the title                    |

The marks are **decorative glyphs (`aria-hidden`)**; the meaning travels in the title's accessible name, never in the glyph alone. A failed title is silent on purpose: the next load retries, and a per-row Retry on a list of hundreds is noise. State is **keyed by work item, not by row index** (P8): a virtualized list recycling a row cannot show one item's translation on another.

### The notice and the live region

- **One notice per surface**, not dismissible. It names the situation in the shipped no-credit words, carries **Add credit** only when `canAddCredits`, and is drawn where the switch would have been, so the header does not shift.
- **One live region per surface**, polite. It says when the titles are being translated, when they landed, how many could not be, and when credit is missing. It does not announce per row.

### The copy (11 new keys under `translation.titles.*`, English values)

| key               | value                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| `switchName`      | Translated titles                                                                    |
| `showOriginal`    | Show original                                                                        |
| `showTranslation` | Show translation                                                                     |
| `pendingMark`     | Translating                                                                          |
| `marked`          | Translated                                                                           |
| `noCredit`        | Titles stay in their original language because your organization has no credit left. |
| `addCredit`       | Add credit                                                                           |
| `livePending`     | Translating titles…                                                                  |
| `liveDone`        | Titles translated                                                                    |
| `liveFailed`      | Some titles could not be translated                                                  |
| `liveNoCredit`    | Titles are shown in their original language: no credit left                          |

The ten non-English catalogues owe these keys in the locale lane.

### Colour, shape and ink

`--el-*` and the element-semantic shape tokens only. Marks, captions and the notice body use `--el-text-secondary`, never `--el-text-muted` or `--el-text-faint` (the faint ink is on `aria-hidden` glyphs only). Dashed outlines in the mock mark the reserved regions and are annotation, not product. **Proposed additions to `@motir/design-system`: none.**

### Render sites judged

Judged and drawn: list, tree, board (+ the independent peek, whose view mode is not this switch), backlog, sprint, Ready, triage, roadmap. Judged and **not** a title surface: a card title inside the work item page (MOTIR-8823), a breadcrumb, a notification row, and search results (the coverage sweep owns them).

### GIVES / TAKES

|                                                                                                 |                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **GIVES** to [the surfaces' build](motir:cmvbkbozd001uhqopgfhggdrt) (MOTIR-8833)                | the eight surfaces, the nine states, the six values, the two-line rule, the copy                 |
| **GIVES** to the coverage sweep ([MOTIR-8834](motir:cmvbkbp0j001whqopbmqpr47v))                 | the list of judged render sites                                                                  |
| **TAKES** from [the reader's translation context](motir:cmvbkbon6001khqop6yb6ad83) (MOTIR-8828) | whether the switch is on, the reader's language, `canAddCredits`, each title's recorded language |
| **TAKES** from the translation door and route (MOTIR-8829, MOTIR-8831)                          | the titles' batch translation and its answer                                                     |

### What this does NOT decide

- **The item page and quick view**: [MOTIR-8823](motir:cmvbkboyd001shqop781p415j)'s design.
- **The setting and who may flip it**: [its design](motir:cmvbkbnwv000whqopmgfngvoj).
- **The editors' original-language note**: [the editors' design](motir:cmvbkbpaw0022hqopxorabzzp).
- **The batch request, its limits and its billing**: the door and route builds.
- **Other render sites**: the coverage sweep (MOTIR-8834).

## ⭐ The Pages section — linking a page by hand (Story MOTIR-7567 · MOTIR-9195 — `item--pages-section--link.mock.html`, DATED 2026-10-21)

A DELTA mock over the shipped work-item **Pages** section. **The base of record is the component**,
`app/(authed)/items/[key]/_components/PagesSection.tsx`: the design mock its header cites
(`item--pages-section.mock.html`) is not present in this area on the default branch, so a later reader
should read the component rather than go looking. Every frame the asset does not change is composed
class-for-class from it and captioned _COMPOSED_; every frame it does change is captioned _CHANGED_.

**What it adds:** the **Link page** door in the header slot `headerAction` already reserves; the inline
page picker it opens; **Unlink** on a hand link only; the one quiet line that explains why every other kind
of link offers none; the **unavailable row**; and the frames for empty, loading, error, refused,
already-linked, in-flight, past-the-cap and unavailable.

**What it consumes and implements nowhere:** the work item's Pages read that serves an unavailable row
(MOTIR-9203), which returns a linked page that is archived or no longer readable with a field separating
live from not-live. This asset names no member of that contract; it draws "live" versus "not live".

### Supersession (recorded, not edited)

The parent story's _"hidden until restored"_ clause for an archived page is **superseded on the work-item
side** by the run's unavailable clause and by the read (MOTIR-9203). The page side is unaffected: an
archived page mounts no strip at all (the strip design, MOTIR-9196). This asset edits neither the story nor
the read. **A finding it cannot place:** the story integration gate (MOTIR-9201) and the MOTIR-7565
acceptance spec `acceptance-page-work-item-mention.spec.ts` assert that an archived page _leaves_ the work
item's section; on the work-item half those cases are stale against the read and go red until the build
card draws this row. That gate does not wait on this asset, so the correction is named here for the
reviewer rather than handed to a card that would never see it.

### Panel table

| Panel | Frame                                    | Composed or changed           |
| ----- | ---------------------------------------- | ----------------------------- |
| P1    | First read, a reader who may link        | the door only                 |
| P2    | First read failed, the door stays        | the door only                 |
| P3    | Empty, a reader who may link             | the door only                 |
| P4    | Empty and populated, a Viewer            | composed (no door, no Unlink) |
| P5    | Door open, no query                      | changed                       |
| P6    | Searching                                | changed                       |
| P7    | Results, each with its place             | changed                       |
| P8    | More results: Show more, pending, failed | changed                       |
| P9    | No results                               | changed                       |
| P10   | Search failed                            | changed                       |
| P11   | Picked, the write in flight              | changed                       |
| P12   | Linked, the new row pinned               | changed                       |
| P13   | Already hand-linked                      | changed                       |
| P14   | Refused, two sentences                   | changed                       |
| P15   | Link failed                              | changed                       |
| P16   | The source matrix                        | Unlink only on `manual`       |
| P17   | A mixed row and its unlink outcome       | changed                       |
| P18   | The derived-link explanation             | changed                       |
| P19   | Unlinking                                | changed                       |
| P20   | Unlink failed                            | changed                       |
| P21   | Paged, with hand links                   | composed + Unlink             |
| P22   | Keyboard and assistive technology        | notes                         |
| P23   | Dark and ~390px                          | changed                       |
| P24   | The unavailable row                      | changed                       |
| P25   | Unlinking an unavailable row             | changed                       |
| P26   | An unavailable row in place              | changed                       |

### Decisions

- **D1 — one door, in the header slot.** The door follows `AddLinkControl`'s grammar: a quiet `--el-link`
  label with a `Plus`, and it becomes **Cancel** while the form is open rather than gaining a second control.
  No second call to action in the empty body.
- **D2 — an inline form, not a modal.** A popup inside a client island that already streams is where
  focus-trap and pointer-events problems live, and the rows stay visible as the thing being changed.
- **D3 — the picker is the `@` popup's page search plus a pager.** `searchPagesForMention`, newest edit
  first, `[]` under `QUICK_SEARCH_MIN_QUERY_LENGTH`, ten per page (`PAGE_MENTION_SEARCH_LIMIT`, named, never
  typed into a sentence), **Show more pages** (`issueViews.pagesShowMore`) once the paged search card serves
  a cursor.
- **D4 — no already-linked mark on a candidate.** `PageMentionCandidateDto` is `{ id, title, place }`;
  marking or excluding would need a second read this story does not buy. The write's refusal answers
  (P13).
- **D5 — the just-linked row is pinned.** The list is ordered by the page's own `updatedAt` and
  keyset-paged, so a hand link to an older page would land on a later page and read as a failure. The
  pinned row carries **Just linked**, the same page's paged row is suppressed (the shipped `loadMore`
  dedupes by `pageId`), and the pin clears on the next full read.
- **D6 — Unlink has no confirm.** Removing a hand link changes nothing but this list and is one click to
  remake; a relationship removal changes readiness, which is why that panel confirms and this one does not.
- **D7 — already-linked is informational.** `--el-tint-sky` with `--el-text-strong`, not the danger tint:
  nothing failed and no row was duplicated.
- **D8 — one explanation line, not a hint per row.** Most rows are derived-only; a per-row hint would
  dominate the list. The line is drawn whenever at least one row has no `manual` source.
- **D9 — unlinking never removes a derived source.** A mixed row stays after the hand link goes, with its
  mention chip, its place and its timestamp.
- **D10 — the door follows `canEdit`.** `LateProps` carries the item's `canEdit` and `LateLowerSections`
  does not forward it today; the wiring is the build card's. A Viewer sees no door and no Unlink — never
  disabled, never behind a tooltip.
- **D11 — the unavailable row is ONE treatment over two causes.** The read separates live from unavailable,
  not cause from cause, and the reader's next action is identical either way (clear the link, or go and
  restore the page). The row keeps its source chips (`sources` describes the link, which still exists),
  draws the page's last known title and place where the read still carries them, draws one muted
  **Unavailable page** label in the timestamp's slot with no relative time beside it, has a title that is
  **not an anchor** (so the row contributes exactly one tab stop, its Unlink), and never names a cause.
- **D12 — Unlink survives on the unavailable row, and a not-found settles as removed.** A hand link to a
  page nobody can open is the one a reader most needs to clear. An unlink answered `PAGE_LINK_NOT_FOUND`
  (another writer's removal — the build card's existing rule) or `PAGE_NOT_FOUND` settles as removed with
  the same announcement, using the unavailable label where there is no title; any other refusal restores
  the row exactly and shows P20's line. The unavailable row keeps the list's own `updatedAt` order: never
  pinned, sorted to the end, or marked new.

**The empty line changes meaning, not words.** Today `rows.length === 0` means "no _live_ page links
here"; after MOTIR-9203 it means "nothing links here". The string (`issueViews.pagesEmpty`) was already
worded for the second meaning, so it does not move (P26 decides it).

### String map

New copy, `en`; the key names are indicative — the build card (MOTIR-9199) owns the catalogue and ships the
`zh` twin of every row.

| What the reader sees                                                                                                          | Indicative key                          |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Link page                                                                                                                     | `issueViews.pagesLinkDoor`              |
| Cancel (the door while open)                                                                                                  | `issueViews.pagesLinkCancel`            |
| Search pages by title                                                                                                         | `issueViews.pagesLinkSearchLabel`       |
| “{title}” is already linked to this work item.                                                                                | `issueViews.pagesLinkAlreadyLinked`     |
| You don’t have permission to link pages to this work item.                                                                    | `issueViews.pagesLinkRefusedPermission` |
| That page is no longer available to link.                                                                                     | `issueViews.pagesLinkRefusedGone`       |
| Couldn’t link that page.                                                                                                      | `issueViews.pagesLinkFailed`            |
| Just linked                                                                                                                   | `issueViews.pagesJustLinked`            |
| Unlink                                                                                                                        | `issueViews.pagesUnlink`                |
| Unlink page {title} (accessible name)                                                                                         | `issueViews.pagesUnlinkAria`            |
| Unlink unavailable page (accessible name, no title)                                                                           | `issueViews.pagesUnlinkUnavailableAria` |
| Couldn’t unlink that page.                                                                                                    | `issueViews.pagesUnlinkFailed`          |
| Unlinked “{title}”. (live region)                                                                                             | `issueViews.pagesUnlinkLive`            |
| Only hand links can be unlinked here. Mentioned, embedded and tagged links are removed by editing the page or this work item. | `issueViews.pagesDerivedOnlyGloss`      |
| Unavailable page                                                                                                              | `issueViews.pagesUnavailable`           |

**Reused, by key only (values read from the catalogue, never retyped):** `issueViews.pagesSourceManual`,
`issueViews.pagesEmpty`, `issueViews.pagesGloss`, `issueViews.pagesError`, `issueViews.pagesLoadMoreError`,
`issueViews.pagesShowMore`, `issueViews.pagesListAria`, `common.retry`, and the `@` popup's page lines
(keep typing, searching, no matches, couldn’t search). **No per-cause string exists:** adding one would need
a field the read does not promise and a sentence a reader cannot act on.

### Parts inventory

`ContentSectionCard` (chrome, the `headerRight` slot), the row and its `NotebookText` glyph and place
`<ol>` (`PageBreadcrumb`'s vocabulary as a label), the source `Pill` (neutral tone) per `PageLinkSourceDto`,
`Button` (secondary, sm) for Try again, the first-read skeleton, the more-rows skeleton, the Show more
button, and the load-more failure line. **New:** the door, the inline form with its field, the candidate
row, the chosen chip, the outcome lines, the Unlink control, the pinned block and the unavailable label.

### Colour and ink

`--el-*` only, copied 1:1 from `packages/design-system/theme.css` (the layer `app/globals.css` imports);
shape is the element shape tokens. Every secondary line is `--el-text-secondary`; `--el-text-faint` is not
used; `--el-text-muted` appears only as the search field's placeholder ink on the white card. The danger
glyph is `--el-danger-on-surface`, never `--el-danger-text`. The Unavailable label is
`--el-text-secondary`, so it clears AA on every surface the row lands on.

### Reference check

No reference product was recorded for this project, so one was found from the feature: Notion's
bidirectional linking, checked at
[distribb](https://distribb.io/blog/harnessing-notion-backlinks-build-connections-that-boost-productivity)
and [Guiding Tech](https://www.guidingtech.com/how-to-create-and-remove-backlinks-in-notion/). Linking from
one page writes the relationship both ways and removing it disconnects both sides — the one-row,
two-sides model this story has — while mention-derived backlinks are a separate list the reader does not
delete. That second half is adopted: a derived link shows its source and carries no removal control
(P16–P18), and only the hand-made relationship is removable. A backlink whose target has gone is shown as a
dead title with no navigation rather than dropped, which is P24's choice.

### GIVES / TAKES

- **GIVES the build card (MOTIR-9199):** panels P1–P26 and the string map above, including the one extra
  key beyond the first cut's map (`pagesUnlinkUnavailableAria`), the door's capability wiring
  (`LateProps.canEdit` into the section), the pinned **Just linked** row, and the rule that an unlink
  answered `PAGE_LINK_NOT_FOUND` or `PAGE_NOT_FOUND` from an unavailable row settles as removed.
- **GIVES E2E + the clip (MOTIR-9202):** the Viewer frame (no door, no Unlink) and the mixed row whose
  unlink leaves the mention standing, with their accessible names.
- **TAKES from the read (MOTIR-9203):** the unavailable row's rendering, as data only.
- **TAKES nothing** from the strip design, the write path or the page-side read, and **hands them
  nothing**: the page's Linked work items strip, the two write routes, the page-side read and the work-item
  read's separating field appear in no panel, and every reference to them here is a citation by key.

### Not decided here

The strip on the page (MOTIR-9196), the write path's errors and semantics (MOTIR-9197 — this asset words
only the sentences they put on screen), the page-side read (MOTIR-9198), the separating field and the
live-page join (MOTIR-9203), and embedded cards (the embed story).
